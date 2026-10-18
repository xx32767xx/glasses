#!/usr/bin/env python3
"""
carry_attribution.py —— 归因：**上下文续传为什么会帮忙 / 会帮倒忙**
============================================================================================

只读**已经存下来的结果**（不重跑模型），回答四个问题：

  ① 伤害/收益落在哪？—— 按"句内位置"拆：每段第 1 句没有上文可用（天然对照组），
     后续句才有。所以"有没有效果"和"效果正负"是两件分开的事，必须分开看。
  ② 两个语种为什么可能相反？—— 按误差方向拆（替换 S / 删除 D / 插入 I）。
     若 S 降、D 降 → 上下文补的是"听成别的字"；
     若 D 降但 S 大涨 → 上下文补的是"被丢掉的音频"，而它猜错了。
  ③ 是不是"解码器抄上文"？—— 替换/插入出来的词里，有多少**在同一段更早的位置出现过**。
     这个比例翻倍，就是"被上文带偏"的直接证据。
  ④ 新出现的替换是什么性质？—— 抄上文 / 口语→书面 / 同词根 / 其他（多半真听错）。

用法
    # 默认跑中文那批（500ms，20 段），需要段清单 + 结果文件都在 var/asr-eval/ 下
    python asr-eval/carry_attribution.py

    # 换别的语料/配置就指定（葡语目前**没有**连续录音，所以没有默认项）
    python asr-eval/carry_attribution.py --spans <段清单> --result <结果.json> \
        --pairs C1:C1P,C2:C2P --unit word
"""

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "bridge"))

from asr_score import align_ops, normalize                            # noqa: E402
from whisper_stream import force_utf8_stdio                           # noqa: E402

force_utf8_stdio()

# 「口语形式 → 标准书面形式」：这类替换在 WER 上算错，但对"给人读的字幕"未必是错，
# 所以单独算一档，不要把"被规范成书面语"混进"真听错"里。
SPOKEN_TO_WRITTEN = {
    "eh": {"e", "é"}, "e": {"eh"}, "ta": {"esta", "está"}, "tá": {"esta", "está"},
    "to": {"estou"}, "tô": {"estou"}, "pra": {"para"}, "pro": {"para"},
    "ne": {"é", "nao"}, "né": {"é"}, "ce": {"voce", "você"}, "cê": {"você", "voce"},
    "num": {"nao", "não"}, "numa": {"uma"},
}
PUNCT = ".,;:!?\"'()[]—–-…"

DEFAULTS = [
    {"label": "中文 · 500ms（silence 500，20 段）", "unit": "char",
     "spans": ROOT / "var" / "asr-eval" / "spans" / "context-dev-20.json",
     "result": ROOT / "var" / "asr-eval" / "results" / "context_eval_two_knobs__dev__large-v3.json",
     "pairs": [("C1", "C1P")]},
]


def units(text, unit):
    """按单位切：中文按字、葡语按词（与评分口径同一个 normalize）。"""
    return normalize(text, unit).split() if unit == "word" else list(normalize(text, unit))


def utterance_bounds(span, unit):
    """每句在"参考单位序列"里的区间。参考就是逐句文本拼起来的，所以按句长累加即可。"""
    bounds, cursor = [], 0
    for utterance in span["utterances"]:
        size = len(units(utterance["text"], unit))
        bounds.append((cursor, cursor + size))
        cursor += size
    return bounds


def split_errors(reference, hypothesis, bounds, unit):
    """把对齐结果按「句内位置 × 误差方向」汇总。

    ⚠️ 「=」也必须推进参考位置 —— 第一版只让 S/D 推进，于是所有"对上的单位"都停在
       位置 0，整段错误全被算进第 1 句（算出"第 1 句 83%"这种显然不可能的假数）。
    ⚠️ **按顺序配对 spans 与 records**，不能按录音名索引：中文那批 20 段全来自同一场录音。
    """
    error_first = {"S": 0, "D": 0, "I": 0}
    error_later = {"S": 0, "D": 0, "I": 0}
    units_first = units_later = 0
    for start, end in bounds:
        if start == 0:
            units_first += end - start
        else:
            units_later += end - start
    position = 0
    for kind, _ref_token, _hyp_token in align_ops(reference, hypothesis, unit):
        index = next((i for i, (start, end) in enumerate(bounds)
                      if start <= position < end), None)
        if kind in ("=", "S", "D"):
            position += 1
        if kind == "=" or index is None:
            continue
        bucket = error_first if index == 0 else error_later
        bucket[kind] += 1
    return error_first, error_later, units_first, units_later


def bleeding(reference, hypothesis, unit):
    """替换/插入出来的词里，有多少在本段**更早**的参考里出现过（＝像在抄上文）。"""
    reference_units = units(reference, unit)
    hits = total = 0
    position = 0
    for kind, _ref_token, hyp_token in align_ops(reference, hypothesis, unit):
        if kind == "=":
            position += 1
            continue
        if kind in ("S", "D"):
            position += 1
        if kind not in ("S", "I") or not hyp_token:
            continue
        total += 1
        if hyp_token in set(reference_units[:position]):
            hits += 1
    return hits, total


def classify_new_substitutions(reference, bare_text, prompt_text, unit):
    """把"带上文之后**新出现**的替换"分类，回答"它到底是抄上文还是被规范了"。"""
    reference_units = units(reference, unit)
    counts = {"bleed": 0, "spoken": 0, "same_stem": 0, "other": 0}
    examples = {"bleed": [], "spoken": [], "same_stem": [], "other": []}

    def substitutions(text):
        mapping, position = {}, 0
        for kind, _ref_token, hyp_token in align_ops(reference, text, unit):
            if kind in ("=", "D"):
                position += 1
            elif kind == "S":
                mapping[position] = hyp_token
                position += 1
        return mapping

    bare_map, prompt_map = substitutions(bare_text), substitutions(prompt_text)
    for position, hyp_token in prompt_map.items():
        if bare_map.get(position) == hyp_token:
            continue                                  # 两版都这么写，不是这次新出现的
        ref_token = reference_units[position] if position < len(reference_units) else ""
        hyp_clean = hyp_token.strip(PUNCT)
        ref_clean = ref_token.strip(PUNCT)
        if hyp_token in set(reference_units[:position]):
            key = "bleed"
        elif hyp_clean in SPOKEN_TO_WRITTEN.get(ref_clean, set()) or \
                ref_clean in SPOKEN_TO_WRITTEN.get(hyp_clean, set()):
            key = "spoken"
        elif len(hyp_clean) >= 4 and hyp_clean[:4] == ref_clean[:4]:
            key = "same_stem"
        else:
            key = "other"
        counts[key] += 1
        if len(examples[key]) < 4:
            examples[key].append(f"{ref_token}→{hyp_token}")
    return counts, examples


def report(case, bare_mode, prompt_mode):
    spans = json.loads(Path(case["spans"]).read_text(encoding="utf-8"))
    result = json.loads(Path(case["result"]).read_text(encoding="utf-8"))
    pairs = list(zip(spans, result["records"]))
    unit = case["unit"]
    print("=" * 92)
    print(f"{case['label']}　{bare_mode}（不带） vs {prompt_mode}（带前 2 段文本）　单位={unit}")
    print("=" * 92)
    totals = {}
    for mode in (bare_mode, prompt_mode):
        errors = {"first": {"S": 0, "D": 0, "I": 0}, "later": {"S": 0, "D": 0, "I": 0}}
        denom = {"first": 0, "later": 0}
        bleed = [0, 0]
        for span, record in pairs:
            bounds = utterance_bounds(span, unit)
            first, later, units_first, units_later = split_errors(
                record["reference"], record[mode]["text"], bounds, unit)
            for key in ("S", "D", "I"):
                errors["first"][key] += first[key]
                errors["later"][key] += later[key]
            denom["first"] += units_first
            denom["later"] += units_later
            hits, total = bleeding(record["reference"], record[mode]["text"], unit)
            bleed[0] += hits
            bleed[1] += total
        totals[mode] = {"errors": errors, "denom": denom, "bleed": bleed}

    print(f"{'位置':<8}{'喂法':<6}{'S':>6}{'D':>6}{'I':>6}{'错误':>7}{'单位':>7}{'错误率':>9}")
    for position, label in (("first", "第 1 句"), ("later", "后续句")):
        for mode in (bare_mode, prompt_mode):
            item = totals[mode]
            error, denom = item["errors"][position], item["denom"][position]
            count = sum(error.values())
            print(f"{label:<8}{'不带' if mode == bare_mode else '带':<6}"
                  f"{error['S']:>6}{error['D']:>6}{error['I']:>6}{count:>7}{denom:>7}"
                  f"{count / denom * 100 if denom else 0:>8.2f}%")
        bare_error = totals[bare_mode]["errors"][position]
        prompt_error = totals[prompt_mode]["errors"][position]
        bare_rate = sum(bare_error.values()) / totals[bare_mode]["denom"][position]
        prompt_rate = sum(prompt_error.values()) / totals[prompt_mode]["denom"][position]
        print(f"{'':<8}{'差':<6}{prompt_error['S'] - bare_error['S']:>+6}"
              f"{prompt_error['D'] - bare_error['D']:>+6}"
              f"{prompt_error['I'] - bare_error['I']:>+6}"
              f"{sum(prompt_error.values()) - sum(bare_error.values()):>+7}"
              f"{'':>7}{(prompt_rate - bare_rate) * 100:>+8.2f}p")
    for mode in (bare_mode, prompt_mode):
        hits, total = totals[mode]["bleed"]
        print(f"  「抄上文」比例（{'不带' if mode == bare_mode else '带  '}）："
              f"{hits}/{total} = {hits / total * 100 if total else 0:.1f}%")
    print()


def main():
    parser = argparse.ArgumentParser(description="归因：上下文续传为什么帮忙/帮倒忙（只读已存结果）")
    parser.add_argument("--spans", default=None, help="段清单 json（不给就跑内置的三档）")
    parser.add_argument("--result", default=None, help="结果 json")
    parser.add_argument("--pairs", default="C1:C1P", help="对照，例 C1:C1P,C2:C2P")
    parser.add_argument("--unit", default="char", choices=["char", "word"])
    parser.add_argument("--label", default="自定义", help="报告里显示的标题")
    parser.add_argument("--kinds", action="store_true",
                        help="额外输出「带上文之后新出现的替换」的分类")
    args = parser.parse_args()

    if args.spans and args.result:
        cases = [{"label": args.label, "unit": args.unit, "spans": args.spans,
                  "result": args.result,
                  "pairs": [tuple(pair.split(":")) for pair in args.pairs.split(",")]}]
    else:
        cases = DEFAULTS
    for case in cases:
        for bare_mode, prompt_mode in case["pairs"]:
            report(case, bare_mode, prompt_mode)
            if args.kinds:
                spans = json.loads(Path(case["spans"]).read_text(encoding="utf-8"))
                result = json.loads(Path(case["result"]).read_text(encoding="utf-8"))
                total = {"bleed": 0, "spoken": 0, "same_stem": 0, "other": 0}
                for span, record in zip(spans, result["records"]):
                    counts, _examples = classify_new_substitutions(
                        record["reference"], record[bare_mode]["text"],
                        record[prompt_mode]["text"], case["unit"])
                    for key, value in counts.items():
                        total[key] += value
                summary = sum(total.values())
                print(f"  新出现的替换 {summary} 个：抄上文 {total['bleed']}、"
                      f"口语→书面 {total['spoken']}、同词根 {total['same_stem']}、"
                      f"其他 {total['other']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
