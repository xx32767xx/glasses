#!/usr/bin/env python3
"""
pt_nurc_spans.py —— 从 CORAA **NURC-SP Minimal Corpus** 重建葡语**连续发言**，并挑出实验段
============================================================================================

为什么要有这个脚本（它解决的是 docs/13 §5 第 1 项那个"卡了很久"的问题）
    中文那三套实验（切句代价 / 上下文 / 两旋钮）能做，是因为 MagicData 留了**原始连续录音
    + 官方逐句时间戳**。葡语之前**没有**这个东西：CORAA 只有一句一条的片段、没有时间戳、
    没有场次归属，所以只能做"代理实验"（`pt_context_proxy.py`），并在报告里反复标注
    "这不是等价实验、不能和中文那张表并排"。

    NURC-SP（Projeto NURC/SP，1972 年圣保罗的口语调查）给了缺的那两样：
    每一段都有**原始录音时间轴上的 start/end**，而且同一场录音里有几百段。
    于是可以把"逐句片段"按时间轴**拼回连续音频**（空档补静音），再按中文那套办法挑连续段。

⚠️ 重建的诚实边界（这三条必须和数字一起读）
  1. **音频是被拼出来的**：段与段之间的空档（原本是真实的环境声/呼吸）被补成了数字静音。
     影响：自适应门槛的"噪声底"会比真实录音低得多。所以**切句行为**可能与真实现场不同 ——
     `--silence-ms` 这一轴的结果要按"干净录音"理解，不能当成会议现场。
  2. **覆盖率不是 100%**：整场 74.6% 的时长被段覆盖（逐场 41%~92%）。所以只能挑
     "连续、干净、参考文本完整"的段落来当段（与中文完全同一套规矩），不能当整场连续录音用。
  3. **1972 年的录音**：带宽/噪声/口音都与今天的巴葡会议不同。它比"代理实验"真实得多，
     但仍然不等于"本项目真实会议录音"。

用法
    # 先看这 21 场录音各自什么情况，不写盘
    python asr-eval/pt_nurc_spans.py --list

    # 重建 20 个连续段（每段约 25 秒），音频写到 var/asr-eval/audio/nurc-pt/
    python asr-eval/pt_nurc_spans.py --count 20 --target-seconds 25 `
        --out-spans var/asr-eval/spans/nurc-pt-20.json `
        --out-audio var/asr-eval/audio/nurc-pt
"""

import argparse
import csv
import json
import sys
import wave
from collections import defaultdict
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "bridge"))

from context_eval import save_spans, spans_digest                          # noqa: E402
from whisper_stream import force_utf8_stdio                               # noqa: E402

force_utf8_stdio()

CORPUS = Path(r"E:\CORAA NURC-SP Minimal Corpus")
TARGET_RATE = 16000
# 这些是脚本转写里的韵律/重叠标记：带它们的段**不能当参考文本**（会把标记当成要识别的字）。
DIRTY_MARKS = ("((", "))", "::", "[", "]", "#")


def is_clean(text):
    """这一段能不能当参考文本？（与中文实验同一条规矩：不能有标记、不能是空的）"""
    if not text or not text.strip():
        return False
    return not any(mark in text for mark in DIRTY_MARKS)


def read_clip(path):
    """读一条片段 → 16 kHz 单声道 float32。

    ⚠️ NURC 的片段是 **48 kHz 双声道**，而产线/评测全链路是 16 kHz 单声道。
       重采样用线性插值（与 `bridge/whisper_stream.py` 的 `_resample` 同一个算法：
       前者在长录音上已经用过并验证过重采样这条路）。
    """
    with wave.open(str(path), "rb") as handle:
        rate = handle.getframerate()
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        if width != 2:
            sys.exit(f"{path.name} 不是 16 位 wav（位深 {width * 8}）")
        frames = handle.readframes(handle.getnframes())
    audio = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    if rate != TARGET_RATE:
        positions = np.arange(int(round(audio.size * TARGET_RATE / rate)), dtype=np.float64)
        audio = np.interp(positions * (rate / TARGET_RATE),
                          np.arange(audio.size, dtype=np.float64), audio).astype(np.float32)
    return audio


def load_rows(csv_path):
    """读 CSV，按录音分组、按原始时间轴排序。"""
    grouped = defaultdict(list)
    with open(csv_path, encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            try:
                start = float(row["start_time"])
                end = float(row["end_time"])
            except (TypeError, ValueError):
                continue
            if end <= start:
                continue
            grouped[row["name"]].append({
                "start": start, "end": end, "path": row["path"],
                "speaker": row.get("speaker") or "",
                "text": (row.get("normalized_text") or "").strip(),
                "raw_text": row.get("text") or "",
                "duration": end - start,
            })
    for items in grouped.values():
        items.sort(key=lambda item: item["start"])
    return grouped


def pick_spans(items, count, target_seconds, min_seconds, min_utterances, max_gap):
    """挑"连续、干净、参考完整"的段 —— 与中文那边**同一套规矩**：

    · 段内每一句的参考文本都必须是干净的（无韵律标记/重叠标记）；
    · 相邻两句的间隔 ≤ `max_gap`（否则中间那段没被参考覆盖的话会混进"整段"那一路）；
    · 每段时长在 `[min_seconds, target_seconds]`，且至少 `min_utterances` 句。
    """
    spans, index = [], 0
    while index < len(items) and len(spans) < count:
        head = items[index]
        if not is_clean(head["text"]):
            index += 1
            continue
        chosen, cursor = [head], index + 1
        while cursor < len(items):
            current = items[cursor]
            if not is_clean(current["text"]):
                break
            if current["start"] - chosen[-1]["end"] > max_gap:
                break
            if current["end"] - head["start"] > target_seconds:
                break
            chosen.append(current)
            cursor += 1
        duration = chosen[-1]["end"] - chosen[0]["start"]
        if duration >= min_seconds and len(chosen) >= min_utterances:
            spans.append({"start": chosen[0]["start"], "end": chosen[-1]["end"],
                          "duration": duration, "utterances": chosen})
            index = cursor
        else:
            index += 1
    return spans


def build_span_audio(span, corpus_dir, out_dir, name):
    """把这一段的逐句音频按时间轴拼成一条 wav（空档补静音）。

    产物是 **16 kHz 单声道 16 位**，与评测链路一致；`utterances` 的时间轴同时平移到
    "以本段开头为 0"，这样下游看到的和 MagicData 的段清单完全同形。
    """
    total = int(round(span["duration"] * TARGET_RATE))
    buffer = np.zeros(total, dtype=np.float32)
    shifted = []
    for item in span["utterances"]:
        clip = read_clip(corpus_dir / item["path"])
        start = int(round((item["start"] - span["start"]) * TARGET_RATE))
        end = min(start + clip.size, total)
        if end <= start:
            continue
        buffer[start:end] += clip[:end - start]
        shifted.append({"start": item["start"] - span["start"],
                        "end": min(item["end"] - span["start"], span["duration"]),
                        "speaker": item["speaker"], "text": item["text"]})
    # 拼接后电平可能超过 1（相邻段在边界上叠加），压一下防止削波
    peak = float(np.max(np.abs(buffer))) if buffer.size else 0.0
    if peak > 1.0:
        buffer = buffer / peak
    target = out_dir / f"{name}.wav"
    with wave.open(str(target), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(TARGET_RATE)
        handle.writeframes((buffer * 32767.0).astype("<i2").tobytes())
    return target, shifted


def describe(grouped):
    """--list：每场录音什么情况（不写盘）。"""
    print(f"{'录音':<14}{'段数':>6}{'语音秒':>9}{'跨度秒':>9}{'覆盖':>7}"
          f"{'空档p95':>9}{'干净段':>8}{'说话人':>7}")
    for name in sorted(grouped):
        items = grouped[name]
        speech = sum(item["duration"] for item in items)
        span = items[-1]["end"] - items[0]["start"]
        gaps = [items[i + 1]["start"] - items[i]["end"] for i in range(len(items) - 1)]
        clean = sum(1 for item in items if is_clean(item["text"]))
        speakers = len({item["speaker"] for item in items if item["speaker"]})
        print(f"{name:<14}{len(items):>6}{speech:>9.0f}{span:>9.0f}"
              f"{speech / span * 100:>6.1f}%"
              f"{(sorted(gaps)[int(len(gaps) * 0.95)] if gaps else 0):>9.2f}"
              f"{clean:>8}{speakers:>7}")


def main():
    parser = argparse.ArgumentParser(description="从 NURC-SP 重建葡语连续发言并挑实验段")
    parser.add_argument("--corpus", default=str(CORPUS), help="语料根目录")
    parser.add_argument("--csv", default="segmented_audios_time_no_intersection.csv",
                        help="用哪份清单（无重叠版是缺省：重叠段的音频会重复算进参考）")
    parser.add_argument("--recordings", default=None,
                        help="只从这几场录音里挑（逗号分隔，缺省按覆盖率从高到低挑）")
    parser.add_argument("--count", type=int, default=20, help="挑几段（缺省 20）")
    parser.add_argument("--target-seconds", type=float, default=25.0, help="每段目标时长")
    parser.add_argument("--min-seconds", type=float, default=12.0, help="段最短时长")
    parser.add_argument("--min-utterances", type=int, default=3, help="段内至少几句")
    parser.add_argument("--max-gap", type=float, default=2.0,
                        help="句间间隔超过它就不算连续（缺省 2 秒，与中文实验一致）")
    parser.add_argument("--out-spans", default=None,
                        help="段清单写到哪（缺省 var/asr-eval/spans/nurc-pt-<count>.json）")
    parser.add_argument("--out-audio", default=None,
                        help="重建的 wav 写到哪个目录（缺省 var/asr-eval/audio/nurc-pt）")
    parser.add_argument("--list", action="store_true", help="只体检，不写盘")
    parser.add_argument("--min-coverage", type=float, default=0.75,
                        help="只用覆盖率不低于它的场次（缺省 0.75，避免满是空档的场）")
    args = parser.parse_args()

    corpus = Path(args.corpus)
    csv_path = corpus / args.csv
    if csv_path.is_file() is False:
        sys.exit(f"找不到清单：{csv_path}")
    grouped = load_rows(csv_path)
    if not grouped:
        sys.exit(f"{csv_path} 里一条可用记录都没有")

    if args.list:
        describe(grouped)
        return 0

    # 挑场次：显式给了就听；否则按覆盖率从高到低，挑够用为止
    if args.recordings:
        names = [name.strip() for name in args.recordings.split(",") if name.strip()]
    else:
        ranked = []
        for name, items in grouped.items():
            speech = sum(item["duration"] for item in items)
            span = items[-1]["end"] - items[0]["start"]
            coverage = speech / span if span > 0 else 0.0
            clean = sum(1 for item in items if is_clean(item["text"]))
            if coverage >= args.min_coverage and clean >= args.count * args.min_utterances:
                ranked.append((coverage, name))
        names = [name for _coverage, name in sorted(ranked, reverse=True)]
    if not names:
        sys.exit("没有一场录音的覆盖率/干净段数达到要求；用 --min-coverage 放低门槛或 --recordings 指定")

    out_spans = Path(args.out_spans
                     or ROOT / "var" / "asr-eval" / "spans" / f"nurc-pt-{args.count}.json")
    out_audio = Path(args.out_audio or ROOT / "var" / "asr-eval" / "audio" / "nurc-pt")
    out_audio.mkdir(parents=True, exist_ok=True)

    spans, used = [], []
    for name in names:
        need = args.count - len(spans)
        if need <= 0:
            break
        picked = pick_spans(grouped[name], need, args.target_seconds, args.min_seconds,
                            args.min_utterances, args.max_gap)
        for index, span in enumerate(picked):
            label = f"{name}-{len(spans) + 1:02d}"
            # ⚠️ CSV 里的 `path` 已经带了 `segmented_audios/` 前缀（相对语料根），
            #    所以这里拼的是**根目录**，不要再补一层 segmented_audios。
            path, utterances = build_span_audio(span, corpus, out_audio, label)
            spans.append({"recording": path.name,
                          "start": 0.0, "end": span["duration"],
                          "duration": span["duration"],
                          "source": {"recording": name, "start": span["start"], "end": span["end"]},
                          "utterances": utterances})
            used.append(name)
    if not spans:
        sys.exit("一句都没挑出来：放宽 --max-gap / --min-seconds，或换一场录音")

    target = save_spans(out_spans, spans)
    total = sum(span["duration"] for span in spans)
    print(f"重建 {len(spans)} 段 / {total:.1f} 秒（来自 {len(set(used))} 场录音："
          f"{'、'.join(sorted(set(used)))}）")
    print(f"  段清单 {target}　指纹 {spans_digest(spans)}")
    print(f"  音频   {out_audio}\\<段名>.wav（16 kHz 单声道）")
    print(f"  句/段  {min(len(s['utterances']) for s in spans)}~"
          f"{max(len(s['utterances']) for s in spans)} 句，"
          f"段均 {total / len(spans):.1f} 秒")
    speakers = {u["speaker"] for span in spans for u in span["utterances"] if u["speaker"]}
    print(f"  说话人 {len(speakers)} 个（多人对话，与中文那批单人独白不同）")
    # 每段的源位置也打出来 —— 报告里要能追回到语料的哪一场哪一秒
    for span in spans[:3]:
        source = span["source"]
        print(f"    {span['recording']}  ← {source['recording']} "
              f"{source['start']:.1f}–{source['end']:.1f}s")
    if len(spans) > 3:
        print(f"    …（其余 {len(spans) - 3} 段同样记在段清单的 source 字段里）")
    print("\n⚠️ 这批音频是**拼接重建**的：段间空档补了数字静音，噪声底低于真实录音；")
    print("   所以它适合量「切句代价 / 上下文收益」，不适合拿 `--silence-ms` 的绝对值去代表现场。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
