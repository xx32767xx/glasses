#!/usr/bin/env python3
"""
pt_context_proxy.py —— 葡语**代理**实验：同领域上文（提示词续传）对短片段有没有用
========================================================================================

⚠️⚠️ 这是**代理**，不是等价实验。读数字前先读这三条：

  1. 中文那三套实验能做，是因为 MagicData 留下了**原始 31 分钟录音 + 官方逐句时间戳**。
     葡语这边**没有**：CORAA 只有已经切成一句一句的片段（pt-speech-dev 300 条 = 300 个编号，
     中位 3.04 秒、最长 9.05 秒），元数据里**没有时间戳、没有场次编号**，编号也不连续 ——
     **连哪几句属于同一场对话都确定不了**。
  2. 所以本实验把测试包里**相邻的若干条**（按 manifest 顺序，也就是**不同人**的话）当成一段上文，
     只比较一件事：**提示词续传这个机制在葡语短片段上有没有用**。它给的是**下界**。
  3. **不能**用它说葡语的切句代价或声学重叠值多少 —— 那需要一段真实葡语连续录音（哪怕 10 句），
     见 docs/13 第 1 项。**这些数字不要和中文那张表并排放。**

用法
    python asr-eval/pt_context_proxy.py --groups 10 --model large-v3 --device cuda `
        --out-json var/asr-eval/results/pt_context_proxy__dev__large-v3.json
"""

import argparse
import difflib
import hashlib
import json
import os
import re
import sys
import time
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "bridge"))
os.environ.setdefault("HF_HOME", str(ROOT / "var" / "cache" / "hf"))

from asr_score import (                                                       # noqa: E402
    NORMALIZED_RULES_VERSION, SCORING_RULES_VERSION, error_rate, normalized_error_rate,
    overall_rate,
)
from whisper_stream import force_utf8_stdio, looks_like_prompt_echo            # noqa: E402

force_utf8_stdio()

MODES = ("C1", "T1", "T2")
LABELS = {
    "C1": "C1 每句独立（＝产线现状）",
    "T1": "T1 每句 + 提示词（上一句文本）",
    "T2": "T2 每句 + 提示词（前两句文本）",
}


def read_wav(path):
    """读 16k 单声道 PCM。

    ⚠️ 峰值归一化必须和 asr_eval.py 一样（0.9/peak）—— 这是**公平性前提**：
       不同喂法之间共用同一段音频，所以归一化本身不影响三种喂法的比较，
       但少了它，C1 这一列就和已经发布的包基线**不是同一个口径**，不能并排看。
    """
    with wave.open(str(path), "rb") as handle:
        frames = handle.readframes(handle.getnframes())
    audio = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    if peak > 1e-6:
        audio = audio * (0.9 / peak)
    return audio


def decode(model, audio, args, prompt=None):
    start = time.perf_counter()
    segments, _info = model.transcribe(
        audio, language=args.language, beam_size=args.beam_size,
        vad_filter=args.vad_filter, condition_on_previous_text=False,
        initial_prompt=prompt)
    text = " ".join(segment.text.strip() for segment in segments).strip()
    return text, time.perf_counter() - start


def join_words(texts):
    return " ".join(text.strip() for text in texts if text.strip())


def _plain(text):
    return re.sub(r"[^\w\u00c0-\u024f]+", "", str(text).lower())


def echo_detail(text, prompt, reference):
    """回显计数器的**人工可核版**：把"和提示词撞上的那一段"打印出来，并说明它有没有参考支持。

    为什么需要这一步：本题里 `Uhum.`（语气词）正好在前后两句都出现了 ——
    `looks_like_prompt_echo` 会判成回显，但**本句参考本来就是 `aham`**，
    于是这是**巧合，不是抄袭提示词**。计数器本身不改（它是产线那道闸），
    这里只多做一次核对，报告里把两者分开写，避免把巧合算成回显。
    """
    haystack, needle = _plain(text), _plain(prompt)
    if not haystack or not needle:
        return None
    match = difflib.SequenceMatcher(None, haystack, needle).find_longest_match(
        0, len(haystack), 0, len(needle))
    if match.size == 0:
        return None
    span = haystack[match.a:match.a + match.size]
    return {"overlap": span, "chars": match.size,
            "backedByReference": span in _plain(reference)}


def main():
    parser = argparse.ArgumentParser(description="葡语代理实验：同领域上文（提示词续传）有没有用")
    parser.add_argument("--pack", default="pt-speech-dev")
    parser.add_argument("--group-size", type=int, default=8)
    parser.add_argument("--groups", type=int, default=10)
    parser.add_argument("--model", default="large-v3")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--compute-type", default="float16")
    parser.add_argument("--beam-size", type=int, default=5)
    parser.add_argument("--language", default="pt")
    parser.add_argument("--vad-filter", dest="vad_filter", action="store_true", default=True)
    parser.add_argument("--no-vad-filter", dest="vad_filter", action="store_false")
    parser.add_argument("--out-json", default=None)
    parser.add_argument("--allow-download", action="store_true")
    args = parser.parse_args()

    pack_dir = ROOT / "var" / "asr-eval" / "packs" / args.pack
    if pack_dir.is_dir() is False:
        sys.exit(f"找不到包：{pack_dir}")
    rows = [json.loads(line) for line in
            (pack_dir / "manifest.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    need = args.group_size * args.groups
    if len(rows) < need:
        sys.exit(f"包里只有 {len(rows)} 条，凑不出 {args.groups} 组 × {args.group_size} 句")
    groups = [rows[i:i + args.group_size] for i in range(0, need, args.group_size)]
    digest = hashlib.sha256("|".join(row["file"] for row in rows[:need]).encode()).hexdigest()[:16]
    total = sum(row["seconds"] for row in rows[:need])

    print("=" * 92)
    print("葡语**代理**实验：同领域上文（提示词续传）对短片段有没有用")
    print(f"  包 {args.pack} · {len(groups)} 组 × {args.group_size} 句 = {need} 条 / {total:.0f} 秒"
          f" · 指纹 {digest}")
    print(f"  模型 {args.model} / {args.device} / {args.compute_type} / 语种 {args.language}")
    print("  ⚠️⚠️ 这是代理：CORAA 里没有场次信息，拼出的相邻句是**不同人**的话。")
    print("     能测：提示词续传这个机制有没有用（下界）；不能测：切句代价 / 声学重叠。")
    print("     数字只作方向性检查，不要和中文那张表并排放。")
    print("=" * 92)

    from faster_whisper import WhisperModel
    print(f"\n载入模型 {args.model} …")
    try:
        model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type,
                             local_files_only=not args.allow_download)
    except Exception as error:
        sys.exit(f"模型载不进来：{type(error).__name__}: {error}（要联网加 --allow-download）")
    decode(model, np.zeros(16000, dtype=np.float32), args)
    print("预热完成\n")

    records = []
    for index, group in enumerate(groups, 1):
        audios = [read_wav(pack_dir / row["file"]) for row in group]
        reference = join_words([row["reference"] for row in group])
        entry = {"files": [row["file"] for row in group], "reference": reference, "modes": {}}
        for mode, depth in (("C1", 0), ("T1", 1), ("T2", 2)):
            pieces, used, flagged, flags = [], 0.0, 0, []
            for position, audio in enumerate(audios):
                prompt = join_words([piece["text"] for piece in pieces[-depth:]]) if depth else ""
                text, elapsed = decode(model, audio, args, prompt=prompt or None)
                if prompt and looks_like_prompt_echo(text, prompt):
                    flagged += 1
                    detail = echo_detail(text, prompt, group[position]["reference"])
                    flags.append({"file": group[position]["file"], "prompt": prompt,
                                  "text": text, "reference": group[position]["reference"],
                                  **(detail or {})})
                pieces.append({"text": text})
                used += elapsed
            hypothesis = join_words([piece["text"] for piece in pieces])
            strict = error_rate(reference, hypothesis, "word")
            entry["modes"][mode] = {**strict, "used": used,
                                    "echoFlagged": flagged,
                                    "echoReal": sum(1 for f in flags if not f.get("backedByReference")),
                                    "echoFlags": flags,
                                    "pieces": [piece["text"] for piece in pieces],
                                    "normalized": normalized_error_rate(reference, hypothesis, "word")}
        records.append(entry)
        # 回显闸报的那几句，逐条和**同一句在 C1 下的输出**比一次：
        # 若 C1 也这么写，那这句话就跟提示词没关系 —— 这是比"参考里有没有"更硬的判据。
        c1_pieces = entry["modes"]["C1"]["pieces"]
        for mode in ("T1", "T2"):
            for flag in entry["modes"][mode]["echoFlags"]:
                flag["c1Text"] = c1_pieces[entry["files"].index(flag["file"])]
                flag["sameAsC1"] = _plain(flag["c1Text"]) == _plain(flag["text"])
            entry["modes"][mode]["echoReal"] = sum(
                1 for f in entry["modes"][mode]["echoFlags"]
                if not f.get("backedByReference") and not f.get("sameAsC1"))
        preview = "  ".join(f"{mode} {entry['modes'][mode]['rate'] * 100:5.1f}%" for mode in MODES)
        print(f"  #{index:<3} {entry['files'][0][:20]:<20} {preview}")

    print("\n" + "=" * 92)
    print("汇总（同一批片段、同一个参考；C1 ＝产线现状）")
    print("=" * 92)
    header = f"{'喂法':<34}{'WER':>8}{'规范化':>8}{'S':>6}{'D':>6}{'I':>6}{'vs C1':>8}{'真回显':>7}"
    print(header)
    print("-" * len(header))
    summary = {}
    for mode in MODES:
        pooled = [{"units": r["modes"][mode]["units"], "distance": r["modes"][mode]["distance"],
                   "substitutions": r["modes"][mode]["substitutions"],
                   "deletions": r["modes"][mode]["deletions"],
                   "insertions": r["modes"][mode]["insertions"]} for r in records]
        rate, units, distance, sdi = overall_rate(pooled)
        norm_rate, _nu, _nd, _nsdi = overall_rate([r["modes"][mode]["normalized"] for r in records])
        summary[mode] = {"rate": rate, "normalized": norm_rate, "units": units, "sdi": sdi,
                         "echoFlagged": sum(r["modes"][mode]["echoFlagged"] for r in records),
                         "echoReal": sum(r["modes"][mode]["echoReal"] for r in records)}
    base = summary["C1"]["rate"]
    for mode in MODES:
        item = summary[mode]
        print(f"{LABELS[mode]:<34}{item['rate'] * 100:>7.1f}%{item['normalized'] * 100:>7.1f}%"
              f"{item['sdi'][0]:>6}{item['sdi'][1]:>6}{item['sdi'][2]:>6}"
              f"{(item['rate'] - base) * 100:>+7.1f}p{item['echoReal']:>6}")

    flagged = [(r["files"][0], mode, flag) for r in records for mode in MODES
               for flag in r["modes"][mode]["echoFlags"]]
    print(f"\n回显闸判定的次数：{len(flagged)} —— 逐条列出，请按参考文本核（不核就不知道是真抄还是巧合）：")
    if not flagged:
        print("  （一次都没有）")
    for group_name, mode, flag in flagged:
        if flag.get("backedByReference"):
            verdict = "**不是回显**：撞上的片段本句参考里就有"
        elif flag.get("sameAsC1"):
            verdict = "**不是回显**：本句在 C1（无提示词）下写出来一模一样 → 巧合"
        else:
            verdict = "**真回显**：C1 下写法不同，且提示词内容不在本句参考里"
        print(f"  {group_name} {mode} {flag['file']}")
        print(f"    提示词 {flag['prompt'][:120]!r}")
        print(f"    输出   {flag['text'][:120]!r}")
        print(f"    C1同句 {flag.get('c1Text', '')[:120]!r}")
        print(f"    参考   {flag['reference'][:120]!r}")
        print(f"    撞上的片段 {flag.get('overlap')!r}（{flag.get('chars')} 字符）→ {verdict}")

    print("\n逐条配对（以 C1 为基准，按每条自己的参考文本算）：")
    print(f"  {'喂法':<34}{'更好':>7}{'更差':>7}{'持平':>7}")
    paired = {}
    for mode in MODES[1:]:
        better = worse = same = skipped = 0
        for record, group in zip(records, groups):
            for position, row in enumerate(group):
                a = error_rate(row["reference"], record["modes"]["C1"]["pieces"][position], "word")
                b = error_rate(row["reference"], record["modes"][mode]["pieces"][position], "word")
                # 参考文本为空 → 错误率是 nan，比大小恒为假，会被错记成"持平"。跳过并报数。
                if not a["units"]:
                    skipped += 1
                    continue
                if b["rate"] < a["rate"] - 1e-9:
                    better += 1
                elif b["rate"] > a["rate"] + 1e-9:
                    worse += 1
                else:
                    same += 1
        paired[mode] = {"better": better, "worse": worse, "same": same, "skipped": skipped}
        print(f"  {LABELS[mode]:<34}{better:>7}{worse:>7}{same:>7}"
              + (f"   （参考为空跳过 {skipped} 条）" if skipped else ""))
    print("\n  ⚠️ 只说明提示词续传在葡语短片段上有没有用；葡语的真实切句/上下文收益要")
    print("     一段真实葡语连续录音（docs/13 第 1 项）才能测。")

    payload = {
        "proxy": True,
        "proxyCaveat": ("CORAA 无场次/时间戳，相邻句是不同人的话；只测同领域上文有没有用，"
                        "不能测切句代价与声学重叠；不与中文那张表并列。"),
        "config": {"pack": args.pack, "groupSize": args.group_size, "groups": len(groups),
                   "files": need, "groupDigest": digest, "totalSeconds": total,
                   "model": args.model, "device": args.device,
                   "computeType": args.compute_type, "beamSize": args.beam_size,
                   "language": args.language, "vadFilter": args.vad_filter,
                   "normalizePeak": True,
                   "scoringRules": SCORING_RULES_VERSION,
                   "normalizedRules": NORMALIZED_RULES_VERSION, "modeLabels": LABELS,
                   "rerun": (f"python asr-eval/pt_context_proxy.py --pack {args.pack}"
                             f" --groups {len(groups)} --group-size {args.group_size}"
                             f" --model {args.model} --device {args.device}")},
        "summary": summary, "paired": paired, "records": records,
    }
    if args.out_json:
        target = Path(args.out_json)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n结构化结果已写到 {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
