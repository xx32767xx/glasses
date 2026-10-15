#!/usr/bin/env python3
"""
context_overlap.py —— 上下文能不能"白拿"？文本续传 vs 声学重叠，同一批段上配对比较
========================================================================================

背景：`context_eval.py`（docs/14 §6.7）已经量出**切碎本身要吃掉 4~5 个百分点**，
而且坏法是"替换"（S 151 → 101 那种）：字没丢，但**听成了别的字** —— 语境不够。
于是自然的问题是：**能不能在不增加等待的前提下，把语境补回来？**

这个脚本比较五种"补语境"的办法，**跑在同一批段、同一个参考、同一套解码参数上**：

    C1  逐段独立解码（**产线现状**：silence 500ms）
    T1  逐段独立解码 + `initial_prompt=上一段的文本`（**文本续传**）
    T2  同上，但提示词带**前两段**的文本（文本多一些会不会更好）
    L   窗口 = **上一段 + 本段**，只取本段的输出（**左邻声学重叠**，按词时间戳切）
    R   窗口 = **本段 + 下一段**，只取本段的输出（**右邻声学重叠**，代价是多等一段）

⚠️ 为什么没有 `condition_on_previous_text=True` 这一档：那是"**同一次 transcribe 调用内**、
   用上一个窗口的文本当提示"，而我们的每段音频只有 3 秒、只产出一句话 ——
   **设了也不会有任何变化**。跨段的文本续传要靠 `initial_prompt`（就是 T1/T2）。
   这一条是先想清楚再跑，不是漏掉了。

⚠️ 要同时盯住**代价**，否则"更准"很容易是假象：
    · **拼接分歧**：重叠窗口的输出与逐段输出在**同一段**上不一致的次数 ——
      不一致就要选一个，选错就是**新增**错误（现在系统里没有这类错）；
    · **分歧时谁对**：不一致的那些段，用参考文本判一下窗口版和逐段版谁更接近 ——
      这直接回答"重叠到底值不值"；
    · **提示词回显**：T1/T2 有"模型把提示词吐出来"的风险（产线里已有闸门），这里数一数；
    · **等待**：L 的窗口更长（略贵一点），R **必须等下一段说完**（+1 段）。

用法
    # 先小跑验证（4 段、small 模型）
    python asr-eval/context_overlap.py --spans-file var/asr-eval/spans/context-dev-20.json `
        --limit 4 --model small --device cuda

    # 正式（与 §6.7 同一批 20 段，large-v3，约 15 分钟）
    python asr-eval/context_overlap.py --spans-file var/asr-eval/spans/context-dev-20.json `
        --model large-v3 --device cuda `
        --out-json var/asr-eval/results/context_overlap__dev__large-v3.json `
        --out-md   var/asr-eval/reports/context-overlap-dev.md
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))                   # 同层兄弟模块（context_eval / asr_score）
# ⚠️ 依赖方向单向：评测层可以用 bridge/，bridge/ 永远不导入评测层。
sys.path.insert(0, str(ROOT / "bridge"))
os.environ.setdefault("HF_HOME", str(ROOT / "var" / "cache" / "hf"))

from asr_score import (                                                       # noqa: E402
    NORMALIZED_RULES_VERSION, SCORING_RULES_VERSION, error_rate, normalized_error_rate,
    overall_rate,
)
from context_eval import (                                                    # noqa: E402
    PRODUCTION_SEGMENTER, join_texts, load_spans, production_segments, read_slice,
    spans_digest,
)
from whisper_stream import force_utf8_stdio, looks_like_prompt_echo            # noqa: E402

force_utf8_stdio()

MODES = ("C1", "T1", "T2", "L", "R")
MODE_LABELS = {
    "C1": "C1 逐段独立解码（产线现状）",
    "T1": "T1 逐段 + 提示词（上一段文本）",
    "T2": "T2 逐段 + 提示词（前两段文本）",
    "L": "L 左邻重叠（窗口=上段+本段，取本段）",
    "R": "R 右邻重叠（窗口=本段+下段，取本段）",
}


def decode(model, audio, args, prompt=None, words=False):
    """识别一段音频；返回 (文本, 耗时, 词表)。

    ⚠️ 五种喂法**只允许**在 prompt / 音频窗口上不同 —— 其余解码参数完全一致，
       否则量到的是参数差异，不是"补语境"的效果。
    """
    kwargs = {
        "language": args.language,
        "beam_size": args.beam_size,
        "vad_filter": args.vad_filter,
        "condition_on_previous_text": False,
        "initial_prompt": prompt,
    }
    if words:
        kwargs["word_timestamps"] = True
    start = time.perf_counter()
    segments, _info = model.transcribe(audio, **kwargs)
    segments = list(segments)                       # 生成器：取一次就没了
    used = time.perf_counter() - start
    text = " ".join(segment.text.strip() for segment in segments).strip()
    word_list = []
    if words:
        for segment in segments:
            for word in getattr(segment, "words", None) or []:
                word_list.append({"start": word.start, "end": word.end,
                                  "text": (word.word or "").strip()})
    return text, used, word_list


def join_words(words):
    return "".join(word["text"].replace(" ", "") for word in words)


def slice_by_boundary(words, boundary, keep):
    """按时间戳把窗口输出切成两半。

    `keep="after"` → 取中点 ≥ boundary 的词（＝本段，用于左邻窗口）
    `keep="before"` → 取中点 < boundary 的词（＝本段，用于右邻窗口）

    ⚠️ 用**词的中点**而不是起点/终点：边界上那个词往往被两块共享，
       按中点归属是这类拼接里最稳的默认做法。
    ⚠️ 中点**正好落在边界**时归「本段」（`after` 用 `>=`，`before` 用 `<`）：
       规则必须确定 —— 两边都拿会让同一个词出现两次（字幕重复），两边都不拿会漏字。
    返回 `(保留的词, 丢掉的词, 是否有可用时间戳)`。
    """
    kept, dropped = [], []
    for word in words:
        middle = (word["start"] + word["end"]) / 2 if word["end"] is not None else word["start"]
        if (keep == "after" and middle >= boundary) or (keep == "before" and middle < boundary):
            kept.append(word)
        else:
            dropped.append(word)
    return kept, dropped, len(words) > 0


def run_span(model, args, span, audio, rate, segments):
    """在这一段上跑五种喂法。

    `segments` 是产线切句切出来的那些片子（**五种喂法共用同一批段**），
    每段带它在整段音频里的起止时间 —— 重叠窗口要靠它拼出来。
    """
    # 先把每段的起止时间算出来（产线分段器只给音频，不给时间；按累计长度推）
    marks = []
    cursor = 0.0
    for piece in segments:
        seconds = len(piece) / rate
        marks.append({"start": cursor, "end": cursor + seconds, "seconds": seconds})
        cursor += seconds

    result = {mode: {"pieces": [], "used": 0.0, "promptEcho": 0, "fallbacks": 0,
                     "disagreements": 0, "words": 0} for mode in MODES}

    def note(mode, text, used):
        result[mode]["pieces"].append(text)
        result[mode]["used"] += used

    # ── C1：逐段独立 ────────────────────────────────────────────────────────
    for index, piece in enumerate(segments):
        text, used, _ = decode(model, piece, args)
        note("C1", text, used)

    # ── T1 / T2：逐段 + 文本续传（提示词是**本模式内**上一段的输出）───────────
    for mode, depth in (("T1", 1), ("T2", 2)):
        history = []
        for piece in segments:
            prompt = "".join(history[-depth:]) if history else None
            text, used, _ = decode(model, piece, args, prompt=prompt)
            if prompt and looks_like_prompt_echo(text, prompt):
                result[mode]["promptEcho"] += 1
            history.append(text)
            note(mode, text, used)

    # ── L：左邻重叠（窗口 = 上段 + 本段，取本段）────────────────────────────
    for index, piece in enumerate(segments):
        if index == 0:
            text, used, _ = decode(model, piece, args)      # 第一段没有左邻
            result["L"]["fallbacks"] += 1
            note("L", text, used)
            continue
        window = np.concatenate([segments[index - 1], piece])
        boundary = marks[index]["start"] - marks[index - 1]["start"]
        text, used, words = decode(model, window, args, words=True)
        result["L"]["words"] += len(words)
        kept, _dropped, ok = slice_by_boundary(words, boundary, "after")
        if ok is False:
            result["L"]["fallbacks"] += 1
            note("L", text, used)                           # 拿不到时间戳就用整窗（如实计数）
        else:
            note("L", join_words(kept), used)

    # ── R：右邻重叠（窗口 = 本段 + 下段，取本段）────────────────────────────
    for index, piece in enumerate(segments):
        if index == len(segments) - 1:
            text, used, _ = decode(model, piece, args)      # 最后一段没有右邻
            result["R"]["fallbacks"] += 1
            note("R", text, used)
            continue
        window = np.concatenate([piece, segments[index + 1]])
        boundary = marks[index]["end"] - marks[index]["start"]
        text, used, words = decode(model, window, args, words=True)
        result["R"]["words"] += len(words)
        kept, _dropped, ok = slice_by_boundary(words, boundary, "before")
        if ok is False:
            result["R"]["fallbacks"] += 1
            note("R", text, used)
        else:
            note("R", join_words(kept), used)

    # 拼成整段的文本（与参考比）
    for mode in MODES:
        result[mode]["text"] = join_texts(result[mode]["pieces"], "char")
    # 拼接分歧：本段文本与 C1 逐段文本是否不一致（L/R 才有意义）
    for mode in ("L", "R"):
        for index, piece in enumerate(result[mode]["pieces"]):
            if piece.replace(" ", "") != result["C1"]["pieces"][index].replace(" ", ""):
                result[mode]["disagreements"] += 1
    return result, marks


def segment_error(reference_pieces, pieces, unit="char"):
    """逐段错误率（配对比较要用**逐段**的数，不能用整段平均）。"""
    rates = []
    for reference, hypothesis in zip(reference_pieces, pieces):
        score = error_rate(reference, hypothesis, unit)
        rates.append(score["rate"] if score["units"] else 0.0)
    return rates


def main():
    parser = argparse.ArgumentParser(
        description="文本续传 vs 声学重叠：能不能在不增加等待的前提下补回上下文")
    parser.add_argument("--spans-file", required=True, help="固化的段清单（见 context_eval.py）")
    parser.add_argument("--limit", type=int, default=0, help="只跑前 N 段（冒烟测试用）")
    parser.add_argument("--model", default="large-v3")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--compute-type", default="float16")
    parser.add_argument("--beam-size", type=int, default=5)
    parser.add_argument("--language", default="zh")
    parser.add_argument("--vad-filter", dest="vad_filter", action="store_true", default=True)
    parser.add_argument("--no-vad-filter", dest="vad_filter", action="store_false")
    parser.add_argument("--magicdata-dir", default=r"E:\MagicData")
    parser.add_argument("--show", type=int, default=2, help="打印几段的详细对照")
    parser.add_argument("--out-json", default=None)
    parser.add_argument("--out-md", default=None)
    parser.add_argument("--allow-download", action="store_true")
    args = parser.parse_args()

    spans = load_spans(args.spans_file)
    if args.limit:
        spans = spans[:args.limit]
    wav_dir = Path(args.magicdata_dir) / "MDT2021S003" / "WAV"
    total_seconds = sum(span["duration"] for span in spans)

    print("=" * 96)
    print("上下文能不能白拿：文本续传（提示词）vs 声学重叠（前后邻窗口）")
    print(f"  段清单 {args.spans_file} 指纹 {spans_digest(spans)} · {len(spans)} 段 / "
          f"{total_seconds:.1f} 秒")
    print(f"  模型 {args.model} / {args.device} / {args.compute_type} / beam {args.beam_size}"
          f" / vad_filter={args.vad_filter} / 语种 {args.language}")
    print(f"  切句：产线分段器 silence {PRODUCTION_SEGMENTER['silence_ms']}ms"
          f"（五种喂法**共用同一批段**，只有解码时的上下文不同）")
    for mode in MODES:
        print(f"    {MODE_LABELS[mode]}")
    print("=" * 96)

    from faster_whisper import WhisperModel
    print(f"\n载入模型 {args.model} …")
    try:
        model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type,
                             local_files_only=not args.allow_download)
    except Exception as error:
        sys.exit(f"模型载不进来：{type(error).__name__}: {error}\n"
                 f"  · 缺省只用本地缓存 {os.environ['HF_HOME']}；要联网加 --allow-download")
    decode(model, np.zeros(int(16000 * 1.0), dtype=np.float32), args)     # 预热
    print("预热完成\n")

    records = []
    for index, span in enumerate(spans, 1):
        audio, rate = read_slice(wav_dir / span["recording"], span["start"], span["end"])
        reference = join_texts([row["text"] for row in span["utterances"]], "char")
        segments = production_segments(audio, rate)
        result, marks = run_span(model, args, span, audio, rate, segments)

        # 逐段参考：按"每句落在哪个产线片段里"归属（用官方句的起止时间）
        reference_pieces = []
        for mark in marks:
            piece_ref = []
            for row in span["utterances"]:
                start = row["start"] - span["start"]
                end = row["end"] - span["start"]
                if end > mark["start"] + 0.05 and start < mark["end"] - 0.05:
                    piece_ref.append(row["text"])
            reference_pieces.append("".join(piece_ref))

        entry = {"recording": span["recording"], "start": span["start"], "end": span["end"],
                 "duration": span["duration"], "reference": reference,
                 "segments": len(segments),
                 "meanSegmentSeconds": sum(m["seconds"] for m in marks) / len(marks) if marks else 0,
                 "referencePieces": reference_pieces,
                 "modes": {}}
        for mode in MODES:
            strict = error_rate(reference, result[mode]["text"], "char")
            norm = normalized_error_rate(reference, result[mode]["text"], "char")
            rates = segment_error(reference_pieces, result[mode]["pieces"], "char")
            entry["modes"][mode] = {
                **strict, "normalized": norm,
                "used": result[mode]["used"],
                "text": result[mode]["text"],
                "pieces": result[mode]["pieces"],
                "segmentRates": rates,
                "promptEcho": result[mode]["promptEcho"],
                "fallbacks": result[mode]["fallbacks"],
                "disagreements": result[mode]["disagreements"],
            }
        records.append(entry)
        preview = "  ".join(f"{mode} {entry['modes'][mode]['rate'] * 100:5.1f}%" for mode in MODES)
        print(f"  #{index:<3} {span['recording'][:26]:<26} {preview}")

    # ── 汇总 ────────────────────────────────────────────────────────────────
    print("\n" + "=" * 96)
    print("汇总（同一批段、同一个参考、同一套解码参数；C1 就是产线现状）")
    print("=" * 96)
    header = (f"{'喂法':<34}{'严格':>8}{'规范化':>8}{'S':>6}{'D':>6}{'I':>6}"
              f"{'vs C1':>8}{'等一段?':>9}{'拼接分歧':>9}{'回显':>6}{'兜底':>6}")
    print(header)
    print("-" * len(header))
    summary = {}
    for mode in MODES:
        rows = [{"units": r["modes"][mode]["units"], "distance": r["modes"][mode]["distance"],
                 "substitutions": r["modes"][mode]["substitutions"],
                 "deletions": r["modes"][mode]["deletions"],
                 "insertions": r["modes"][mode]["insertions"]} for r in records]
        rate, units, distance, sdi = overall_rate(rows)
        norm_rate, _nu, _nd, _nsdi = overall_rate([r["modes"][mode]["normalized"] for r in records])
        used = sum(r["modes"][mode]["used"] for r in records)
        echo = sum(r["modes"][mode]["promptEcho"] for r in records)
        fallback = sum(r["modes"][mode]["fallbacks"] for r in records)
        disagree = sum(r["modes"][mode]["disagreements"] for r in records)
        summary[mode] = {"rate": rate, "normalized": norm_rate, "units": units, "sdi": sdi,
                         "used": used, "echo": echo, "fallbacks": fallback,
                         "disagreements": disagree}
    base = summary["C1"]["rate"]
    for mode in MODES:
        item = summary[mode]
        needs_next = "是" if mode == "R" else "否"
        print(f"{MODE_LABELS[mode]:<34}{item['rate'] * 100:>7.1f}%{item['normalized'] * 100:>7.1f}%"
              f"{item['sdi'][0]:>6}{item['sdi'][1]:>6}{item['sdi'][2]:>6}"
              f"{(item['rate'] - base) * 100:>+7.1f}p{needs_next:>9}"
              f"{item['disagreements']:>9}{item['echo']:>6}{item['fallbacks']:>6}")
    print("-" * len(header))
    print("  ⚠️ 「等一段?」= 这一档要不要等下一段说完才能定稿；R 是唯一要等的。")
    print("  ⚠️ 「拼接分歧」= 重叠窗口的输出与逐段输出对**同一段**不一致的次数 —— "
          "不一致就要选一个，选错就是新增错误。")

    # 配对比较：逐段谁更好（配对才看得清 1~2 个百分点的差别）
    print("\n逐段配对比较（以 C1 为基准，段级错误率）：")
    print(f"  {'喂法':<34}{'更好':>7}{'更差':>7}{'持平':>7}{'平均变化':>10}")
    paired = {}
    for mode in MODES[1:]:
        better = worse = same = 0
        deltas = []
        for record in records:
            for index in range(len(record["referencePieces"])):
                a = record["modes"]["C1"]["segmentRates"][index]
                b = record["modes"][mode]["segmentRates"][index]
                deltas.append(b - a)
                if b < a - 1e-9:
                    better += 1
                elif b > a + 1e-9:
                    worse += 1
                else:
                    same += 1
        mean = sum(deltas) / len(deltas) if deltas else 0.0
        paired[mode] = {"better": better, "worse": worse, "same": same, "meanDelta": mean}
        print(f"  {MODE_LABELS[mode]:<34}{better:>7}{worse:>7}{same:>7}{mean * 100:>+9.1f}p")

    # 分歧时谁对：这是"重叠值不值"的直接证据
    print("\n拼接分歧时谁对（逐段比 C1：谁的错误率更低就是谁对）：")
    verdict = {}
    for mode in ("L", "R"):
        win = lose = tie = 0
        for record in records:
            pieces_c1 = record["modes"]["C1"]["pieces"]
            pieces_x = record["modes"][mode]["pieces"]
            rates_c1 = record["modes"]["C1"]["segmentRates"]
            rates_x = record["modes"][mode]["segmentRates"]
            for index in range(len(pieces_c1)):
                if pieces_x[index].replace(" ", "") == pieces_c1[index].replace(" ", ""):
                    continue                        # 只有分歧的段才算
                if rates_x[index] < rates_c1[index] - 1e-9:
                    win += 1
                elif rates_x[index] > rates_c1[index] + 1e-9:
                    lose += 1
                else:
                    tie += 1
        verdict[mode] = {"win": win, "lose": lose, "tie": tie}
        print(f"  {mode}: 重叠版更对 {win} 段 / 逐段版更对 {lose} 段 / 打平 {tie} 段")

    if args.show:
        for record in records[:args.show]:
            print("\n" + "-" * 96)
            print(f"{record['recording']}  {record['start']:.1f}–{record['end']:.1f}s")
            print(f"  参考 {record['reference']}")
            for mode in MODES:
                print(f"  {mode:<4} {record['modes'][mode]['text']}")

    payload = {
        "config": {"spansFile": args.spans_file, "spansDigest": spans_digest(spans),
                   "spans": len(spans), "totalSeconds": total_seconds, "model": args.model,
                   "device": args.device, "computeType": args.compute_type,
                   "beamSize": args.beam_size, "language": args.language,
                   "vadFilter": args.vad_filter, "segmenter": PRODUCTION_SEGMENTER,
                   "scoringRules": SCORING_RULES_VERSION,
                   "normalizedRules": NORMALIZED_RULES_VERSION,
                   "modeLabels": MODE_LABELS,
                   "rerun": (f"python asr-eval/context_overlap.py --spans-file {args.spans_file}"
                             f" --model {args.model} --device {args.device}"
                             f" --compute-type {args.compute_type}")},
        "summary": summary, "paired": paired, "verdict": verdict, "records": records,
    }
    if args.out_json:
        target = Path(args.out_json)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n结构化结果已写到 {target}")
    if args.out_md:
        target = Path(args.out_md)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(render_report(payload), encoding="utf-8")
        print(f"人读报告已写到   {target}")
    return 0


def render_report(payload):
    config, summary, records = payload["config"], payload["summary"], payload["records"]
    base = summary["C1"]["rate"]
    lines = ["# 上下文能不能白拿：文本续传 vs 声学重叠\n"]
    lines.append(f"- 段清单：`{config['spansFile']}`（指纹 `{config['spansDigest']}`）"
                 f"· {config['spans']} 段 / {config['totalSeconds']:.0f} 秒")
    lines.append(f"- 模型：{config['model']} / {config['device']} / {config['computeType']}"
                 f" / beam {config['beamSize']} / vad_filter={config['vadFilter']}")
    lines.append(f"- 评分：严格 `{config['scoringRules']}` + 规范化 `{config['normalizedRules']}`")
    lines.append(f"- 重跑命令：`{config['rerun']}`\n")
    lines.append("## 汇总\n")
    lines.append("| 喂法 | 严格 | 规范化 | S | D | I | vs C1 | 要等下一段? | 拼接分歧 | 提示词回显 | 兜底 |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|---|")
    for mode in ("C1", "T1", "T2", "L", "R"):
        item = summary[mode]
        lines.append(f"| {config['modeLabels'][mode]} | **{item['rate'] * 100:.1f}%** | "
                     f"{item['normalized'] * 100:.1f}% | {item['sdi'][0]} | {item['sdi'][1]} | "
                     f"{item['sdi'][2]} | {(item['rate'] - base) * 100:+.1f}p | "
                     f"{'是' if mode == 'R' else '否'} | {item['disagreements']} | "
                     f"{item['echo']} | {item['fallbacks']} |")
    lines.append("")
    lines.append("## 逐段配对比较（段级错误率，以 C1 为基准）\n")
    lines.append("| 喂法 | 更好 | 更差 | 持平 | 平均变化 |")
    lines.append("|---|---|---|---|---|")
    for mode, item in payload["paired"].items():
        lines.append(f"| {config['modeLabels'][mode]} | {item['better']} | {item['worse']} | "
                     f"{item['same']} | {item['meanDelta'] * 100:+.1f}p |")
    lines.append("")
    lines.append("## 拼接分歧时谁对（只有 L/R 有分歧）\n")
    for mode, item in payload["verdict"].items():
        lines.append(f"- **{mode}**：重叠版更对 **{item['win']}** 段 / 逐段版更对 "
                     f"**{item['lose']}** 段 / 打平 {item['tie']} 段")
    lines.append("")
    lines.append("## 逐段明细\n")
    lines.append("| 录音 | 时间 | 秒 | " + " | ".join(("C1", "T1", "T2", "L", "R")) + " |")
    lines.append("|---|---|---|" + "---|" * 5)
    for record in records:
        cells = " | ".join(f"{record['modes'][mode]['rate'] * 100:.0f}%"
                           for mode in ("C1", "T1", "T2", "L", "R"))
        lines.append(f"| {record['recording']} | {record['start']:.0f}–{record['end']:.0f}s | "
                     f"{record['duration']:.0f} | {cells} |")
    lines.append("\n## 样本（每段原文与各喂法输出）\n")
    for index, record in enumerate(records, 1):
        lines.append(f"### {index}. {record['recording']} {record['start']:.0f}–"
                     f"{record['end']:.0f}s（{record['duration']:.1f}s / "
                     f"{record['segments']} 片）\n")
        lines.append(f"- 参考　{record['reference']}")
        for mode in ("C1", "T1", "T2", "L", "R"):
            lines.append(f"- {mode}　{record['modes'][mode]['text']}")
        lines.append("")
    lines.append("## 边界\n")
    lines.append("1. 五种喂法**共用同一批产线切句片段**，只改解码时的上下文 —— "
                 "量的是「补语境」的效果，不是切句策略。")
    lines.append("2. `condition_on_previous_text=True` **没有作为一档**：它只在"
                 "同一次 transcribe 调用内、跨 30 秒窗口生效，而我们的片段只有 3 秒，设了不会有变化。")
    lines.append("3. L/R 的拼接按**词时间戳的中点**归属；拿不到时间戳时用整窗输出并记为「兜底」。")
    lines.append("4. R 必须**等下一段说完**才能定稿（+1 段等待），这个代价没有折算进错误率。")
    lines.append("5. 同一配置两次跑能差约 0.7 个百分点，所以 1 个百分点以内的差异不当真。")
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    sys.exit(main())
