#!/usr/bin/env python3
"""
context_eval.py —— 切短、边界、丢上下文到底让口语识别多损失了多少？
========================================================================================

问题（用户提的）：口语那 15~17% 里，有多少是"**切句本身**造成的"？
    同一段话，整段喂进去 vs 切成一句一句喂进去 vs 按**产线切句**喂进去，
    差别有多大？如果差别很大，那优化方向就不是换模型，而是改切句。

做法：**同一段音频、同一个参考、只改"怎么切"**（受控对照，一次只变一个因素）。

    从原始录音（MagicData 31 分钟整场）里取一段**连续**发言，三种喂法：

      A 整段        整段一次识别（保留全部上下文，边界由录音本身给）
      B 官方句边界  按官方逐句时间戳切成一句一句，各自识别后**拼接**
      C 产线切句    用产线上那个 UtteranceSegmenter（静音判定 500ms）切，各自识别后拼接

    A−B = 「切短 + 边界 + 丢上下文」的代价
    A−C = 上面这些 + 「产线切句自己的毛病（丢碎片、合并、切错位置）」的代价

⚠️ 三个必须说清楚的公平性前提（不满足的话这个对照就不成立）：

  1. **参考文本必须覆盖整段音频**。所以选段时要求段内**每一条转写都是"干净"的**
     —— 没有重叠语音 `[+]`、没有"听不清" `[*]`、没有笑声/咳嗽/音乐。
     否则参考里没有的内容，模型从音频里听出来了会被算成插入，A 组白吃亏。
  2. **三种喂法用同一批解码参数**（同一个模型、语种、beam、VAD 设置），
     只改"音频怎么切"。否则量到的是参数差异，不是切句差异。
  3. **拼接不能加分隔符**：中文按字算，拼的时候直接接起来 ——
     加空格会让 B/C 凭空多出"单位"，反而显得更准。

用法
    # 先小跑验证（2 段、small 模型）
    python asr-eval/context_eval.py --count 2 --model small --device cuda

    # 正式：24 段、large-v3（约 10 分钟 GPU）
    python asr-eval/context_eval.py --count 24 --model large-v3 --device cuda \
        --out-json var/asr-eval/results/context_eval__large-v3.json
"""

import argparse
import json
import os
import re
import sys
import time
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent          # 本文件在 asr-eval/ 下
ROOT = HERE.parent                              # 仓库根
sys.path.insert(0, str(HERE))                   # 同层的兄弟模块（asr_score / asr_pack …）
# ⚠️ 依赖方向是**单向**的：评测层可以用 bridge/（产线引擎、共享工具），
#    但 bridge/ 永远不许 import asr-eval/。
sys.path.insert(0, str(ROOT / "bridge"))

# ⚠️ 模型缓存必须指向**仓库里那份**（与 lib/paths.mjs 的 WHISPER_CACHE_DIR 同一个目录）。
#    不指的话 faster-whisper 会去 huggingface 现下：本机直连不通，而且那个过期 token
#    会报一个 401「Repository Not Found」—— 看起来像"模型不存在"，
#    真实原因只是缓存目录没告诉它（这个坑在 scripts/test-asr.mjs 里也踩过、也写了注释）。
#    手动跑这个脚本时没人帮着设环境变量，所以脚本自己设。
os.environ.setdefault("HF_HOME", str(ROOT / "var" / "cache" / "hf"))

from asr_pack import MAGICDATA_DEFAULT, MAGICDATA_EVENTS                      # noqa: E402
from asr_score import (                                                       # noqa: E402
    NORMALIZED_RULES_VERSION, SCORING_RULES_VERSION, error_rate, normalize,
    normalized_error_rate, overall_rate,
)
from whisper_stream import UtteranceSegmenter, force_utf8_stdio               # noqa: E402
from whisper_transcribe import TARGET_RATE                                    # noqa: E402

force_utf8_stdio()

# 产线切句的缺省参数（与 whisper_stream.py 的 argparse 缺省一致；改这里等于改实验条件）
PRODUCTION_SEGMENTER = {
    "block_ms": 100,
    "silence_ms": 500,
    "min_speech_ms": 500,        # 短于这个的碎片会被**丢掉**（这正是要量的损失之一）
    "max_speech_ms": 15000,
    "rms_threshold": 0.01,
    "preroll_ms": 250,
    "adaptive": True,
    "short_utterance_ms": 800,
    "short_silence_ms": 1100,
    "cut_pause_ms": 200,
}

FRAGMENT_DROPPED_MS = 500        # 产线会丢掉的碎片长度（用来统计"丢了多少语音"）


def parse_transcript(path):
    """读一场录音的官方逐句转写：`[start,end]\\tspeaker\\t性别,语言\\t文本`。"""
    rows = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.strip() == "":
            continue
        parts = line.split("\t")
        if len(parts) < 4:
            continue
        match = re.match(r"^\[([\d.]+),([\d.]+)\]$", parts[0].strip())
        if match is None:
            continue
        rows.append({
            "start": float(match.group(1)), "end": float(match.group(2)),
            "speaker": parts[1].strip(), "text": "\t".join(parts[3:]).strip(),
        })
    rows.sort(key=lambda row: row["start"])
    return rows


def is_clean(row):
    return not any(event in row["text"] for event in MAGICDATA_EVENTS)


def pick_spans(rows, *, target_seconds, min_seconds, min_utterances, max_gap,
               count, seed):
    """挑出**连续且干净**的段落（段内每条转写都没有事件标记）。

    为什么要"干净"：参考文本必须覆盖整段音频，否则模型从音频里听到而参考里没有的内容
    会被算成插入 —— 那样 A 组（整段）会白吃亏，对照就不公平了。
    """
    spans = []
    index = 0
    while index < len(rows) and len(spans) < count:
        start_row = rows[index]
        if not is_clean(start_row):
            index += 1
            continue
        chosen = [start_row]
        cursor = index + 1
        while cursor < len(rows):
            previous, current = rows[cursor - 1], rows[cursor]
            if not is_clean(current):
                break                                  # 干净段落到此为止
            if current["start"] - previous["end"] > max_gap:
                break                                  # 中间空了太久，不算连续
            if current["end"] - start_row["start"] > target_seconds:
                break
            chosen.append(current)
            cursor += 1
        duration = chosen[-1]["end"] - chosen[0]["start"]
        if duration >= min_seconds and len(chosen) >= min_utterances:
            spans.append({"start": chosen[0]["start"], "end": chosen[-1]["end"],
                          "utterances": chosen, "duration": duration})
            index = cursor
        else:
            index += 1
    return spans


def read_slice(path, start, end):
    """只读原始录音里 [start, end) 那一段（31 分钟的整场不读进内存）。"""
    with wave.open(str(path), "rb") as handle:
        rate, channels, width = handle.getframerate(), handle.getnchannels(), handle.getsampwidth()
        if width != 2:
            sys.exit(f"{path} 不是 16 位 wav（位深 {width * 8}）")
        handle.setpos(int(start * rate))
        frames = handle.readframes(int((end - start) * rate))
    audio = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    return audio, rate


def slice_audio(audio, rate, start, end):
    return audio[int(start * rate):int(end * rate)]


def production_segments(audio, rate):
    """用**产线那个分段器**切（直接 import 生产类，不复制一份逻辑）。"""
    segmenter = UtteranceSegmenter(
        rate, PRODUCTION_SEGMENTER["block_ms"], PRODUCTION_SEGMENTER["silence_ms"],
        PRODUCTION_SEGMENTER["min_speech_ms"], PRODUCTION_SEGMENTER["max_speech_ms"],
        PRODUCTION_SEGMENTER["rms_threshold"], PRODUCTION_SEGMENTER["preroll_ms"], np,
        adaptive=PRODUCTION_SEGMENTER["adaptive"],
        short_utterance_ms=PRODUCTION_SEGMENTER["short_utterance_ms"],
        short_silence_ms=PRODUCTION_SEGMENTER["short_silence_ms"],
        cut_pause_ms=PRODUCTION_SEGMENTER["cut_pause_ms"],
    )
    found = []
    for index in range(0, len(audio), segmenter.block):
        found.extend(segmenter.push(audio[index:index + segmenter.block]))
    last = segmenter.flush()
    if last is not None:
        found.append(last)
    return found


def transcribe_one(model, audio, args, language):
    """识别一段音频；返回 (文本, 耗时)。参数在三种喂法之间**完全一致**。"""
    decode = {
        "language": language,
        "beam_size": args.beam_size,
        "vad_filter": args.vad_filter,
        "condition_on_previous_text": False,
        "initial_prompt": None,
    }
    start = time.perf_counter()
    segments, _info = model.transcribe(audio, **decode)
    text = " ".join(segment.text.strip() for segment in segments).strip()
    return text, time.perf_counter() - start


def join_texts(texts, unit):
    """把多段识别结果拼成一段。**不加分隔符**（中文按字算，加空格会凭空多出单位）。"""
    if unit == "char":
        return "".join(text.replace(" ", "") for text in texts)
    return " ".join(text.strip() for text in texts if text.strip())


def score(reference, hypothesis, unit):
    strict = error_rate(reference, hypothesis, unit)
    norm = normalized_error_rate(reference, hypothesis, unit)
    return strict, norm


def main():
    parser = argparse.ArgumentParser(
        description="切短/边界/丢上下文造成的额外损失：整段 vs 官方句边界 vs 产线切句")
    parser.add_argument("--magicdata-dir", default=str(MAGICDATA_DEFAULT))
    parser.add_argument("--split", default="dev", choices=["dev", "test"],
                        help="用哪份原始录音（缺省 dev：调参只看 dev）")
    parser.add_argument("--count", type=int, default=12, help="取几段（缺省 12）")
    parser.add_argument("--target-seconds", type=float, default=30.0,
                        help="每段目标时长（缺省 30 秒）")
    parser.add_argument("--min-seconds", type=float, default=12.0, help="段最短时长")
    parser.add_argument("--min-utterances", type=int, default=4, help="段内至少几句")
    parser.add_argument("--max-gap", type=float, default=2.0,
                        help="句间停顿超过这个就不算「连续」（缺省 2 秒）")
    parser.add_argument("--model", default="large-v3")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--compute-type", default="float16")
    parser.add_argument("--beam-size", type=int, default=5)
    parser.add_argument("--language", default="zh")
    parser.add_argument("--vad-filter", dest="vad_filter", action="store_true", default=True,
                        help="三种喂法都用这个设置（缺省开，与评测口径一致）")
    parser.add_argument("--no-vad-filter", dest="vad_filter", action="store_false",
                        help="关掉内置 VAD（与产线一致）—— 三种喂法仍然一致")
    parser.add_argument("--show", type=int, default=3, help="打印几段的详细对照")
    parser.add_argument("--out-json", default=None, help="结构化结果写到这里")
    parser.add_argument("--allow-download", action="store_true",
                        help="允许联网下载模型（**默认不联网**，只用 var/cache/hf 里的）")
    args = parser.parse_args()

    root = Path(args.magicdata_dir)
    partition = root / "DataPartition" / f"{args.split}.tsv"
    if partition.is_file() is False:
        sys.exit(f"找不到官方划分 {partition}（用 --magicdata-dir 指定）")
    wav_dir = root / "MDT2021S003" / "WAV"
    txt_dir = root / "MDT2021S003" / "TXT"

    # ⚠️ 划分文件是「录音名 <TAB> 采样点数」两列 —— 不能按"整行以 .wav 结尾"筛，
    #    那样一行都筛不出来（实测踩到：打印出「0 场原始录音」）。
    recordings = sorted({Path(line.split("\t")[0].strip()).name
                         for line in partition.read_text(encoding="utf-8").splitlines()
                         if line.split("\t")[0].strip().endswith(".wav")})
    print("=" * 92)
    print(f"切短/边界/丢上下文的影响：整段(A) vs 官方句边界(B) vs 产线切句(C)")
    print(f"  语料 MagicData-RAMC {args.split} 划分 · {len(recordings)} 场原始录音")
    print(f"  取 {args.count} 段，每段目标 {args.target_seconds:.0f} 秒、至少 {args.min_utterances} 句，"
          f"段内转写必须**全部干净**（无重叠/听不清/笑声）")
    print(f"  模型 {args.model} / {args.device} / {args.compute_type} / beam {args.beam_size}"
          f" / vad_filter={args.vad_filter} / 语种 {args.language}")
    print(f"  产线切句参数：silence {PRODUCTION_SEGMENTER['silence_ms']}ms、"
          f"丢弃 <{PRODUCTION_SEGMENTER['min_speech_ms']}ms 的碎片、上限 "
          f"{PRODUCTION_SEGMENTER['max_speech_ms']}ms")
    print("=" * 92)

    # ── 挑段 ────────────────────────────────────────────────────────────────
    spans = []
    for recording in recordings:
        transcript = txt_dir / (Path(recording).stem + ".txt")
        audio_path = wav_dir / recording
        if transcript.is_file() is False or audio_path.is_file() is False:
            continue
        rows = parse_transcript(transcript)
        picked = pick_spans(rows, target_seconds=args.target_seconds,
                            min_seconds=args.min_seconds,
                            min_utterances=args.min_utterances, max_gap=args.max_gap,
                            count=args.count - len(spans), seed=0)
        for span in picked:
            span["recording"] = recording
            spans.append(span)
        if len(spans) >= args.count:
            break
    if not spans:
        sys.exit("一段都没挑出来（把 --min-seconds / --min-utterances 放宽试试）")
    print(f"\n挑出 {len(spans)} 段：")
    for index, span in enumerate(spans, 1):
        print(f"  #{index:<3} {span['recording']}  "
              f"{span['start']:.1f}–{span['end']:.1f}s（{span['duration']:.1f}s，"
              f"{len(span['utterances'])} 句）")

    # ── 载入模型 ────────────────────────────────────────────────────────────
    from faster_whisper import WhisperModel
    print(f"\n载入模型 {args.model}（device={args.device}, compute_type={args.compute_type}）…")
    try:
        model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type,
                             local_files_only=not args.allow_download)
    except Exception as error:
        sys.exit(f"模型载不进来：{type(error).__name__}: {error}\n"
                 f"  · 缺省只用本地缓存 {os.environ['HF_HOME']}；缓存里没有就加 --allow-download\n"
                 f"  · 想换模型先确认它在 var/cache/hf 里（仓库里现有的是产线在用的那几个）")
    warmup = np.zeros(int(TARGET_RATE * 1.0), dtype=np.float32)
    transcribe_one(model, warmup, args, args.language)      # 预热：第一次推理十几秒
    print("预热完成\n")

    # ── 三种喂法，逐段跑 ────────────────────────────────────────────────────
    records = []
    for index, span in enumerate(spans, 1):
        audio_path = wav_dir / span["recording"]
        audio, rate = read_slice(audio_path, span["start"], span["end"])
        reference = "".join(row["text"] for row in span["utterances"])
        unit = "char"

        # A 整段
        text_a, time_a = transcribe_one(model, audio, args, args.language)

        # B 官方句边界（逐句切）
        pieces_b, moves_b = [], []
        for row in span["utterances"]:
            piece = slice_audio(audio, rate, row["start"] - span["start"], row["end"] - span["start"])
            text, used = transcribe_one(model, piece, args, args.language)
            pieces_b.append(text)
            moves_b.append({"seconds": len(piece) / rate, "text": text, "used": used})
        text_b = join_texts(pieces_b, unit)

        # C 产线切句
        segments = production_segments(audio, rate)
        pieces_c = []
        covered = 0.0
        for piece in segments:
            text, used = transcribe_one(model, piece, args, args.language)
            pieces_c.append(text)
            covered += len(piece) / rate
        text_c = join_texts(pieces_c, unit)

        strict_a, norm_a = score(reference, text_a, unit)
        strict_b, norm_b = score(reference, text_b, unit)
        strict_c, norm_c = score(reference, text_c, unit)
        records.append({
            "recording": span["recording"], "start": span["start"], "end": span["end"],
            "duration": span["duration"], "utterances": len(span["utterances"]),
            "reference": reference,
            "A": {"text": text_a, "segments": 1, "used": time_a, **strict_a, "normalized": norm_a},
            "B": {"text": text_b, "segments": len(pieces_b),
                  "used": sum(p["used"] for p in moves_b), **strict_b, "normalized": norm_b,
                  "pieces": moves_b},
            "C": {"text": text_c, "segments": len(pieces_c), "used": None,
                  "covered": covered, **strict_c, "normalized": norm_c,
                  "pieces": [{"seconds": len(p) / rate, "text": t}
                             for p, t in zip(segments, pieces_c)]},
        })
        print(f"  #{index:<3} {span['recording'][:34]:<34} "
              f"A {strict_a['rate'] * 100:5.1f}%  B {strict_b['rate'] * 100:5.1f}%  "
              f"C {strict_c['rate'] * 100:5.1f}%   "
              f"（段数 B{len(pieces_b)} C{len(pieces_c)}，产线覆盖 {covered:.1f}s/{span['duration']:.1f}s）")

    # ── 汇总 ────────────────────────────────────────────────────────────────
    def overall(mode, key="rate"):
        rows = [{"units": r[mode]["units"], "distance": r[mode]["distance"],
                 "substitutions": r[mode]["substitutions"], "deletions": r[mode]["deletions"],
                 "insertions": r[mode]["insertions"]} for r in records]
        return overall_rate(rows)

    print("\n" + "=" * 92)
    print("汇总（同一批音频、同一个参考，只改「怎么切」）")
    print("=" * 92)
    print(f"{'喂法':<28}{'严格错误率':>10}{'规范化':>9}{'S':>6}{'D':>6}{'I':>6}{'总段数':>8}")
    summary = {}
    for mode, label in (("A", "A 整段（留全部上下文）"), ("B", "B 官方句边界（逐句切）"),
                        ("C", "C 产线切句（silence 500ms）")):
        rate, units, distance, sdi = overall(mode)
        norm_rows = [r[mode]["normalized"] for r in records]
        norm_rate, _nu, _nd, _nsdi = overall_rate(norm_rows)
        segments = sum(r[mode]["segments"] for r in records)
        summary[mode] = {"rate": rate, "normalized": norm_rate, "units": units,
                         "distance": distance, "sdi": sdi, "segments": segments}
        print(f"{label:<28}{rate * 100:>9.1f}%{norm_rate * 100:>8.1f}%"
              f"{sdi[0]:>6}{sdi[1]:>6}{sdi[2]:>6}{segments:>8}")
    print("")
    loss_b = (summary["B"]["rate"] - summary["A"]["rate"]) * 100
    loss_c = (summary["C"]["rate"] - summary["A"]["rate"]) * 100
    print(f"  A−B：**切短 + 边界 + 丢上下文**的代价 = {loss_b:+.1f} 个百分点"
          f"（{summary['A']['rate'] * 100:.1f}% → {summary['B']['rate'] * 100:.1f}%）")
    print(f"  A−C：上面这些 + **产线切句自己的毛病** = {loss_c:+.1f} 个百分点"
          f"（{summary['A']['rate'] * 100:.1f}% → {summary['C']['rate'] * 100:.1f}%）")
    print(f"  B−C：产线切句比「按句切」多损失的 = {loss_c - loss_b:+.1f} 个百分点")
    coverage = sum(r["C"]["covered"] for r in records) / sum(r["duration"] for r in records)
    print(f"  产线切句覆盖了 {coverage * 100:.1f}% 的音频"
          f"（丢掉的部分主要是 <{PRODUCTION_SEGMENTER['min_speech_ms']}ms 的碎片 —— 那是设计如此）")
    print("")
    print("  ⚠️ 这个对照量的是「切句造成的额外损失」，不是「哪个模型更好」：")
    print("     三种喂法用的是**同一个模型、同一套解码参数**，只有「音频怎么切」不同。")

    if args.show:
        print("\n" + "=" * 92)
        print(f"逐段对照（前 {min(args.show, len(records))} 段）")
        print("=" * 92)
        for record in records[:args.show]:
            print(f"\n{record['recording']}  {record['start']:.1f}–{record['end']:.1f}s"
                  f"（{record['duration']:.1f}s / {record['utterances']} 句）")
            print(f"  参考  {record['reference']}")
            print(f"  A 整段 {record['A']['text']}")
            print(f"  B 逐句 {record['B']['text']}")
            print(f"  C 产线 {record['C']['text']}")

    if args.out_json:
        payload = {
            "config": {
                "split": args.split, "count": len(records), "model": args.model,
                "device": args.device, "computeType": args.compute_type,
                "beamSize": args.beam_size, "language": args.language,
                "vadFilter": args.vad_filter, "scoringRules": SCORING_RULES_VERSION,
                "normalizedRules": NORMALIZED_RULES_VERSION,
                "segmenter": PRODUCTION_SEGMENTER,
            },
            "summary": summary,
            "delta": {"A_minus_B_pp": loss_b, "A_minus_C_pp": loss_c, "B_minus_C_pp": loss_c - loss_b},
            "coverage": coverage,
            "records": records,
        }
        target = Path(args.out_json)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n结构化结果已写到 {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
