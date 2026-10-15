#!/usr/bin/env python3
"""
asr_error_analysis.py —— 把"错了多少"变成"错在什么上"，并且**分别按两套口径算分**
========================================================================================

这个脚本回答两个**不同**的问题，而且刻意不把它们混成一个数：

  ①「同一批识别输出，按严格口径与规范化口径各是多少？」（**分数**）
     严格口径 = `asr-score-v1`：与历史结果可比（标点/大小写/空白归一，其余都算错）。
     规范化口径 = `asr-norm-v1`：把"同一个东西的不同写法"统一后**重新对齐重算** ——
       只统一三类东西（标点、成对繁简、数值+单位等价的数字写法），
       不删内容、不改数值、不动极性（规则见 asr_score.py 里 NORMALIZED_RULES_VERSION 那段）。

  ②「这些错落在什么上？」（**归因，启发式**）
     删除/替换逐项分类，用来**找线索**：是口吃、是语气词、是写法，还是内容。

⚠️⚠️ 两件事必须分开，这是评审明确指出的：
    **规范化分数是"换文本重新对齐算出来的"，不是"从严格分里扣掉几个分类桶"。**
    分类桶是启发式归因（可能归错），扣桶得到的那个数既不是严格分、也不是规范分，
    却看起来像个分数 —— 那比没有这个数更糟。所以本脚本**不再输出**
    "真正要追的声学错误 ≈ 整体错误率 − 写法差异"这种结论（曾经输出过，已撤）。

⚠️ 另外三条"不许当成事实"的东西（评审逐条点到，这里写成注释钉住）：
    · 数字写法差异**必须验证数值相等**（`一 → 1` 算写法，`一 → 9` 是听错）；
    · 繁简差异**必须验证两字成对**（`后 → 後` 算字形，`我 → 國` 是听错）；
    · 删除片段里出现拉丁字母/数字**不能**默认"本来就没念" ——
      产品型号、金额完全可能是真的漏了，**要听音频**。所以那一格叫"需人工确认"。

用法
    python asr-eval/asr_error_analysis.py var/asr-eval/results/zh-speech-dev__large-v3_cuda_float16.json
    python asr-eval/asr_error_analysis.py <结果.json> --top 20
    python asr-eval/asr_error_analysis.py <结果.json> --samples 12     # 列出差异原文/识别/音频，供人耳抽查
    python asr-eval/asr_error_analysis.py <结果.json> --samples 12 --bucket 拉丁
"""

import argparse
import json
import sys
import unicodedata
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent          # 本文件在 asr-eval/ 下
ROOT = HERE.parent                              # 仓库根
sys.path.insert(0, str(HERE))                   # 同层的兄弟模块（asr_score …）
# ⚠️ 依赖方向是**单向**的：评测层可以用 bridge/，但 bridge/ 永远不许 import asr-eval/。
sys.path.insert(0, str(ROOT / "bridge"))

from asr_score import (                                          # noqa: E402
    INTERJECTIONS_ZH, NORMALIZED_RULES_VERSION, SCORING_RULES_VERSION, TRADITIONAL_ONLY,
    align_ops, canonicalize_numbers, error_rate, has_cjk, is_variant_pair, negation_flags,
    normalize, normalize_for_scoring, normalized_error_rate, numeric_report, overall_rate,
)
from whisper_stream import force_utf8_stdio                      # noqa: E402

force_utf8_stdio()

# ── 中文（按字）──────────────────────────────────────────────────────────────

# 纯感叹词（**保守**清单）。评审的意见：`吧呢嘛` 带语气与疑问、`啊呀` 常是句末语气词，
# 都不能算"无信息"，所以**不放**进来。
ZH_INTERJECTIONS = set("嗯呃哦唉哈欸")

# 可能实义、但也可能是口语填充的词：**单列一格**，不并进语气词 ——
# 并进去等于替模型开脱，而这份报告是用来判断"能不能用"的。
ZH_AMBIGUOUS = ("那个", "这个", "就是", "然后", "所以说", "对吧")

# 同音异形：普通话里**同音**，音频本身分不出该写哪个（`她/他/它` 都是 tā）。
# ⚠️ 这是"分类"不是"开脱"：它只说明"这个错不可能从声音里判出来"。
#    清单故意保守：「是/事」「象/像」「以/已」虽然也同音，但替换后语义差别大，
#    放进这里会让"真错"凭空变小。
ZH_HOMOPHONE_GROUPS = (
    set("他她它祂"), set("的得地"), set("哪那"), set("嘛吗"), set("在再"), set("做作"),
)

LATIN = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")
DIGITS = set("0123456789０１２３４５６７８９")
CHINESE_NUMERALS = set("零〇一壹二两贰三叁四肆五伍六陆七柒八捌九玖十百千万亿廿")

# ── 葡语（按词）──────────────────────────────────────────────────────────────

# ⚠️ **没有**"葡语语气词清单"这种东西了。原来那张表（é / eh / sei / cê …）把一个词
#    普遍当成"无信息"，评审指出它们在具体句子里就是"是 / 知道 / 你"。
#    现在改成：这些高频虚词**只作为线索单列出来**，明确标注
#    "**可能**是口语赘余，也可能有实义 —— 需看上下文"，不计入任何扣减。
PT_FUNCTION_WORDS = {"é", "eh", "ah", "aham", "hum", "hã", "né", "cê", "tipo", "sei",
                     "aí", "então", "assim", "bom", "olha", "pra", "pro"}

# 口语缩写 ↔ 标准写法：**念出来是同一个词**，只是参考写了口语形式、模型写了标准形式。
# 这是实测排在最前面的一类替换（`pra → para` 在 dev/holdout 里各 14 / 25 次）。
PT_EQUIVALENTS = (
    {"pra", "para"}, {"pro", "para"}, {"pa", "para"},
    {"tá", "está"}, {"ta", "está"}, {"tava", "estava"},
    {"cê", "você"}, {"ce", "você"}, {"vc", "você"},
    {"eh", "é"}, {"ne", "né"},
    {"tô", "estou"}, {"to", "estou"},
)


def strip_accents(text):
    return "".join(char for char in unicodedata.normalize("NFD", text)
                   if unicodedata.category(char) != "Mn")


def same_equivalent_group(left, right):
    return any(left in group and right in group for group in PT_EQUIVALENTS)


def _is_numeric_token(text):
    return any(char in DIGITS or char in CHINESE_NUMERALS for char in str(text))


def numeric_equivalent(left, right, unit):
    """两个写法是不是**数值+单位等价**（`一`↔`1`、`一百元`↔`100元`）。

    ⚠️ 评审点出的第一个 bug 就在这里：原来的规则是"两边都是数字就算写法差异"，
    于是 `一 → 9`（值不同！）被洗成了"写法差异"。现在必须规范化后**逐字相等**。
    """
    if _is_numeric_token(left) is False or _is_numeric_token(right) is False:
        return False
    return canonicalize_numbers(str(left), unit) == canonicalize_numbers(str(right), unit)


def classify_deletion(items, unit, repetition):
    """给一个删除片段归一类（启发式）。`items` 是 list（按字或按词）。

    ⚠️ `repetition` 由调用方用**位置**判断（见 looks_like_repetition），而且位置必须
       取自**与对齐同一份**的归一化列表 —— 评审指出：对齐用的是去标点后的文本，
       拿原始文本的位置来找"附近有没有重复"，位置会错位、分类跟着错。
    """
    text = "".join(items) if unit == "char" else " ".join(items)
    if unit == "char":
        if all(char in ZH_INTERJECTIONS for char in items):
            # ⚠️ 这一格**不代表"可以不计"**：漏掉语气词用户是听得出来的（字幕会变硬）。
            #    它只是"错在什么上"的一个来源标签。
            return "感叹词（嗯/呃/哦…；不是「可以不计」）"
        if any(char in LATIN for char in items) or any(char in DIGITS for char in items):
            # ⚠️ 评审点出的第三个问题：不能默认"拉丁字母/数字本来就不念"。
            #    产品型号、金额完全可能真的漏了 —— 这一格**必须人耳确认**。
            return "拉丁字母/数字（**需听音频**：书面标注还是真漏词）"
        if repetition:
            return "自我重复（口吃：紧邻处又说过一遍）"
        if any(word in text for word in ZH_AMBIGUOUS):
            return "可能实义的虚词（那个/就是/然后…，需看上下文）"
        if not has_cjk(text):
            return "非中文字符（标点/符号等）"
        return "内容字"
    # 葡语：按词
    if repetition:
        return "自我重复（口吃：紧邻处又说过一遍）"
    if items and all(word in PT_FUNCTION_WORDS for word in items):
        return "高频虚词（**可能**是口语赘余，也可能有实义：é=是 / sei=知道 / cê=你）"
    return "内容词"


def classify_substitution(reference, hypothesis, unit):
    """给一次替换归类（启发式）。

    为什么替换也要分类：中文口语那 15.6% 里**替换占 8.1 个百分点**（删除只占 6.5），
    而排在前面的替换里有一部分**不是听错**。但"不是听错"必须**逐条验证**（见下），
    不能靠"看着像"。
    """
    if unit == "char":
        if numeric_equivalent(reference, hypothesis, unit):
            return "数字写法（**已验证数值+单位相等**）"
        if _is_numeric_token(reference) != _is_numeric_token(hypothesis):
            return "真错（数字与非数字之间）"
        if is_variant_pair(reference, hypothesis):
            # 评审的第二个 bug：原来"识别是繁体、参考不是"就算字形差异，
            # 于是 `我 → 國` 也被洗掉。现在要求**两字成对**（查表）。
            # ⚠️ 这不是"听错"，但对**产品**是真缺陷：字幕里冒出繁体字，用户看着别扭。
            return "繁简对应字（已验成对；非听错，但用户看得到）"
        if hypothesis in TRADITIONAL_ONLY:
            return "繁体字但**不成对**（＝听错用错了字）"
        if any(reference in group and hypothesis in group for group in ZH_HOMOPHONE_GROUPS):
            return "同音异形（音频分不出来该写哪个）"
        return "真错"
    # 葡语：按词
    if reference == hypothesis:
        return "真错"
    if same_equivalent_group(reference, hypothesis):
        return "口语缩写↔标准写法（念出来一样）"
    if strip_accents(reference) == strip_accents(hypothesis):
        return "只差变音符号（重音/鼻化）"
    return "真错"


def looks_like_repetition(items, start, ref_items):
    """被删的这段，是否在**紧挨着**的地方又完整出现过（口语口吃："就就就"）。

    窗口取 `max(1, len(items))` —— 只认相邻/重叠的那一次重复。
    放大窗口会把同句里任何一个相同的字都算成"口吃"，把真实漏词掩盖掉。
    """
    length = len(items)
    window = max(1, length)
    low = max(0, start - window)
    high = min(len(ref_items), start + length + window)
    for offset in range(low, high - length + 1):
        if offset == start:                       # 被删的那一处本身，不算
            continue
        if ref_items[offset:offset + length] == items:
            return True
    return False


def load_rows(path):
    text = Path(path).read_text(encoding="utf-8")
    if text.strip() == "":
        sys.exit(f"结果文件是空的：{path}（可能是某次失败运行留下的）")
    data = json.loads(text)
    return data, data.get("rows", [])


def reference_items(reference, unit):
    """参考文本按**与对齐同一套**归一化后的单位列表。

    ⚠️ 评审点出的第五个问题：对齐用的是去标点后的文本，而这里原本拿的是**原始文本**，
    位置于是错位，`looks_like_repetition` 的"附近"实际上找的不是附近。
    现在两边共用同一个归一化函数。
    """
    if unit == "char":
        return list(normalize(reference, "char"))
    return normalize(reference, "word").split()


def deleted_runs(ops):
    """把连续的删除合成"片段"，并记住它在**参考**里的起始位置（下标基于归一化后的单位）。"""
    runs = []
    current = []
    start = None
    index = 0
    for kind, ref, _hyp in ops:
        if kind == "D":
            if not current:
                start = index
            current.append(ref)
            index += 1
            continue
        if current:
            runs.append((current, start))
            current = []
        if kind in ("=", "S"):
            index += 1
    if current:
        runs.append((current, start))
    return runs


def analyse(path, top=25, samples=0, bucket=None,
            drop_interjections=False, collapse_repeats=False):
    data, rows = load_rows(path)
    unit = data.get("unit", "word")
    unit_name = "字" if unit == "char" else "词"

    print("=" * 88)
    print(f"{Path(path).name}")
    print(f"  语料 {data.get('set')}   语种 {data.get('language') or '自动'}   单位 {unit_name}")
    print("=" * 88)

    # ── ① 两套口径，各算一遍（**都在同一批识别输出上重新对齐**）───────────────
    strict_rows, norm_rows = [], []
    for row in rows:
        strict_rows.append(error_rate(row["reference"], row["hypothesis"], unit))
        norm_rows.append(normalized_error_rate(
            row["reference"], row["hypothesis"], unit,
            drop_interjections=drop_interjections, collapse_repeats=collapse_repeats))

    strict_rate, strict_units, _strict_distance, strict_sdi = overall_rate(strict_rows)
    norm_rate, norm_units, _norm_distance, norm_sdi = overall_rate(norm_rows)
    good = sum(1 for row in strict_rows if row["rate"] <= 0.1)

    print(f"\n【严格口径 {SCORING_RULES_VERSION}】与历史结果可比")
    print(f"  整体错误率 {strict_rate * 100:.1f}%  "
          f"(S{strict_sdi[0]} D{strict_sdi[1]} I{strict_sdi[2]} / {strict_units})   "
          f"良好 {good}/{len(strict_rows)}")
    print(f"\n【规范化口径 {NORMALIZED_RULES_VERSION}】只统一「同一个东西的写法」")
    print(f"  整体错误率 {norm_rate * 100:.1f}%  "
          f"(S{norm_sdi[0]} D{norm_sdi[1]} I{norm_sdi[2]} / {norm_units})")
    flags = []
    if drop_interjections:
        flags.append("已开：删感叹词")
    if collapse_repeats:
        flags.append("已开：折叠相邻重复")
    print("  规则：标点/大小写/空白 + 成对繁简 + 数值与单位等价的数字写法"
          + ("；" + "；".join(flags) if flags else "（感叹词与口吃**都保留**）"))
    print(f"  两口径相差 {(strict_rate - norm_rate) * 100:.1f} 个百分点"
          f"（分母：严格 {strict_units} / 规范化 {norm_units} 个{unit_name}）")
    print("  ⚠️ 这个差是**换文本重新对齐算出来的**，不是从严格分里扣掉几个分类桶。")
    print("  ⚠️ 两条口径的分母可能不同，所以差为负不等于「规范化更糟」。")
    print("  ⚠️ 它**不等于**「声学错误率」：剩下的错里仍可能含写法差异，")
    print("     被统一掉的差异也可能是用户看得见的问题（繁体字、漏语气词）。")

    # ── ② 归因（启发式，**只用来找线索，不用来扣分**）────────────────────────
    deletion_of = Counter()
    deletion_categories = Counter()
    substitution_pairs = Counter()
    substitution_categories = Counter()
    substitution_examples = {}
    flagged = []                                      # 供 --samples 抽查
    traditional_heavy = []

    for row in rows:
        ops = align_ops(row["reference"], row["hypothesis"], unit)
        ref_items = reference_items(row["reference"], unit)
        for span, start in deleted_runs(ops):
            text = "".join(span) if unit == "char" else " ".join(span)
            category = classify_deletion(span, unit,
                                         looks_like_repetition(span, start, ref_items))
            deletion_of[text] += 1
            deletion_categories[category] += len(span)
            if "需听音频" in category:
                flagged.append({"file": row["file"], "seconds": row["seconds"], "kind": "删除",
                                "category": category, "reference": row["reference"],
                                "hypothesis": row["hypothesis"], "span": text})
        for kind, ref, hyp in ops:
            if kind != "S":
                continue
            substitution_pairs[(ref, hyp)] += 1
            category = classify_substitution(ref, hyp, unit)
            substitution_categories[category] += 1
            substitution_examples.setdefault(category, Counter())[(ref, hyp)] += 1
        if row.get("traditional", 0) >= 3:
            traditional_heavy.append((row["file"], row["traditional"], row["rate"]))

    total_deleted = sum(deletion_categories.values())
    print(f"\n【归因】删除的 {total_deleted} 个{unit_name}按来源分（启发式）：")
    for name, count in deletion_categories.most_common():
        share = (count / total_deleted * 100) if total_deleted else 0.0
        print(f"  {share:5.1f}%  {count:>5} {unit_name}   {name}")

    total_subs = sum(substitution_categories.values())
    print(f"\n【归因】替换的 {total_subs} 次按来源分（启发式）：")
    for name, count in substitution_categories.most_common():
        share = (count / total_subs * 100) if total_subs else 0.0
        examples = "、".join(f"{ref}→{hyp}({n})"
                             for (ref, hyp), n in substitution_examples[name].most_common(4))
        print(f"  {share:5.1f}%  {count:>5} 次   {name}" + (f"    例：{examples}" if examples else ""))

    print("\n  ⚠️ 以上是**归因**，不是分数，也不许拿来「扣」：")
    print("     · 归因是启发式，可能归错（尤其「需听音频」那一格）；")
    print("     · 被归进「写法差异」的仍然可能是用户看得见的问题；")
    print("     · 剩下的也不全是声学错误。")
    print("     所以本脚本**不再输出**「真正要追的声学错误 ≈ …」。要看分数用上面那两套口径。")

    # ── ③ 关键内容检查（数字核对值与单位 / 否定出现性 / 专名待人工）────────────
    print("\n【关键内容检查】")
    wanted_numbers, hit_numbers, missed = 0, 0, []
    negation_missing = []
    key_term_rows = 0
    for row in rows:
        for item in numeric_report(row["reference"], row["hypothesis"], unit):
            wanted_numbers += item["count"]
            hit_numbers += item["hit"]
            if item["ok"] is False:
                missed.append({"file": row["file"], "value": item["value"], "unit": item["unit"],
                               "reference": row["reference"], "hypothesis": row["hypothesis"]})
        ref_neg = negation_flags(row["reference"], unit)
        hyp_neg = negation_flags(row["hypothesis"], unit)
        if ref_neg and not (ref_neg & hyp_neg):
            negation_missing.append({"file": row["file"], "reference": row["reference"],
                                     "hypothesis": row["hypothesis"],
                                     "negations": sorted(ref_neg)})
        if row.get("key_terms"):
            key_term_rows += 1
    number_share = (hit_numbers / wanted_numbers * 100) if wanted_numbers else None
    print(f"  数字（核对**值+单位**）：命中 {hit_numbers}/{wanted_numbers}"
          + (f"（{number_share:.1f}%）" if number_share is not None else "（本批没有数字）"))
    if missed:
        print(f"    未命中的 {len(missed)} 处（前 5）：")
        for item in missed[:5]:
            print(f"      {item['file']}  {item['value']}{item['unit']}  ← 参考「{item['reference']}」"
                  f" / 识别「{item['hypothesis']}」")
    print(f"  否定词：参考里有否定而识别里一个都没有的样本 {len(negation_missing)} 条"
          + ("（**要人看一眼**：只报出现性差异，不判极性）" if negation_missing else ""))
    for item in negation_missing[:5]:
        print(f"      {item['file']}  {item['negations']}  ← 参考「{item['reference']}」"
              f" / 识别「{item['hypothesis']}」")
    if key_term_rows:
        print(f"  专名：{key_term_rows}/{len(rows)} 条有**人工确认过**的 key_terms"
              f"（逐条命中判定用 asr_score.key_term_hits，本报告不替人判对错）")
    else:
        print("  专名：本批没有人工确认过的 key_terms → **这一项不可用**"
              "（生成候选：python asr-eval/asr_pack.py --keys）")

    print(f"\n最常见的删除片段（前 {top}）：")
    for span, count in deletion_of.most_common(top):
        print(f"  {count:>4} 次  「{span}」")

    print(f"\n最常见的替换（参考 → 识别，前 {top}）：")
    for (ref, hyp), count in substitution_pairs.most_common(top):
        print(f"  {count:>4} 次  {ref} → {hyp}")

    if traditional_heavy:
        traditional_heavy.sort(key=lambda item: -item[1])
        print(f"\n繁体字 ≥3 个的样本（共 {len(traditional_heavy)} 条，"
              f"Whisper 在中文上的已知毛病）：")
        for name, count, rate in traditional_heavy[:10]:
            print(f"  {name}  繁体 {count} 字  该条错误率 {rate * 100:.0f}%")

    # ── ④ 抽查：把需要人耳/人眼确认的差异列出来 ──────────────────────────────
    if samples:
        pool = flagged if bucket is None else [item for item in flagged if bucket in item["category"]]
        print(f"\n【抽查】需要确认的差异 {len(pool)} 条"
              + (f"（按 `{bucket}` 过滤）" if bucket else "（默认列「需听音频」那一格）")
              + f"，下面列出前 {min(samples, len(pool))} 条：")
        print("  ⚠️ 这些是**假设**不是结论：请对着音频听一下到底是书面标注没念，还是真的漏了词。")
        for item in pool[:samples]:
            print(f"\n  {item['file']}（{item['seconds']}s）  [{item['kind']}·{item['category']}]")
            print(f"    参考  {item['reference']}")
            print(f"    识别  {item['hypothesis']}")
            print(f"    涉及  「{item['span']}」")
        if not pool:
            print("  （没有需要确认的）")
    print("")
    return 0


def score_table(results_dir, top=0):
    """把所有已存结果的**两套口径**排成一张表（不重跑模型，读结果文件重算）。

    为什么要这个：评审要求"保留样本，分别算分"。识别输出已经存在结果文件里了，
    所以两套口径的对比**不需要再跑一遍 GPU** —— 直接在同一批识别输出上重算即可，
    而且这样对比最干净：两次运行之间模型有随机性，重跑会把规则差异和随机性混在一起。
    """
    def normalizer(text, mode):
        return normalize_for_scoring(text, mode)

    rows = []
    for path in sorted(Path(results_dir).glob("*.json")):
        text = path.read_text(encoding="utf-8")
        if text.strip() == "":
            continue
        data = json.loads(text)
        if data.get("unit") not in ("char", "word") or not data.get("rows"):
            continue
        unit = data["unit"]
        strict_rows, norm_rows = [], []
        for row in data["rows"]:
            strict_rows.append(error_rate(row["reference"], row["hypothesis"], unit))
            norm_rows.append(error_rate(row["reference"], row["hypothesis"], unit,
                                        normalizer=normalizer))
        strict_rate, strict_units, _d, sdi = overall_rate(strict_rows)
        norm_rate, norm_units, _nd, nsdi = overall_rate(norm_rows)
        rows.append({
            "pack": data.get("set", "?").replace("\\", "/").rstrip("/").split("/")[-1],
            "run": path.stem,
            "count": len(data["rows"]),
            "unit": "字" if unit == "char" else "词",
            "strict": strict_rate, "strict_units": strict_units, "strict_sdi": sdi,
            "normalized": norm_rate, "normalized_units": norm_units, "normalized_sdi": nsdi,
            "gap": strict_rate - norm_rate,
        })
    if not rows:
        print(f"（{results_dir} 里没有可用的结果文件）")
        return 0

    print(f"严格口径 {SCORING_RULES_VERSION}  ·  规范化口径 {NORMALIZED_RULES_VERSION}")
    print("（两套都在**同一批识别输出**上重算，所以差值只可能来自评分规则本身）\n")
    header = (f"{'结果':<44}{'条数':>6}{'单位':>5}{'严格':>9}{'规范化':>10}{'差(pp)':>9}"
              f"{'严格单位':>10}{'规范单位':>10}")
    print(header)
    print("-" * len(header))
    for row in sorted(rows, key=lambda item: item["run"]):
        print(f"{row['run']:<44}{row['count']:>6}{row['unit']:>5}"
              f"{row['strict'] * 100:>8.1f}%{row['normalized'] * 100:>9.1f}%"
              f"{row['gap'] * 100:>8.1f}"
              f"{row['strict_units']:>10}{row['normalized_units']:>10}")
    print("\n⚠️ 两条口径的**分母可能不同**（规范化会把 `3 milhões` 并成一个单位、"
          "也会把 `一百元` 变成一个单位），")
    print("   所以差值为负**不等于**「规范化更糟」—— 那是单位数变了，不是错误变多了。"
          "看最后一列。")
    print("⚠️ 差值也**不是**「声学错误率」：被统一的写法差异里，繁体字与漏语气词"
          "用户是看得见的；剩下的错里也可能仍有写法差异。")
    print("   它的作用是「同一批输出在两套规则下差多少」，而不是「错里有多少可以不算」。")
    return 0


def main():
    parser = argparse.ArgumentParser(
        description="把识别错误按来源分类，并分别按严格/规范化两套口径算分")
    parser.add_argument("result", nargs="?", help="asr_eval 写出的结果 json")
    parser.add_argument("--table", action="store_true",
                        help="不传结果文件时：把所有已存结果的两套口径排成一张表")
    parser.add_argument("--results-dir", default=str(ROOT / "var" / "asr-eval" / "results"),
                        help="--table 扫描哪个目录（缺省 var/asr-eval/results）")
    parser.add_argument("--top", type=int, default=25, help="每类最多列几条（缺省 25）")
    parser.add_argument("--samples", type=int, default=0,
                        help="列出 N 条需要人耳确认的差异（原文/识别/音频文件名）")
    parser.add_argument("--bucket", default=None, help="抽查时按类别关键字过滤（如 拉丁）")
    parser.add_argument("--interjections", action="store_true",
                        help="规范化口径里顺带删掉纯感叹词（**默认不删**）")
    parser.add_argument("--collapse-repeats", action="store_true",
                        help="规范化口径里折叠相邻重复（**默认不折叠**：「看看」「说说」是正常词）")
    args = parser.parse_args()
    if args.result is None or args.table:
        return score_table(args.results_dir)
    path = Path(args.result)
    if path.is_file() is False:
        sys.exit(f"找不到结果文件：{path}")
    return analyse(path, args.top, args.samples, args.bucket,
                   args.interjections, args.collapse_repeats)


if __name__ == "__main__":
    sys.exit(main())
