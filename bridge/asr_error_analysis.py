#!/usr/bin/env python3
"""
asr_error_analysis.py —— 把"错了多少"变成"错在什么上"
========================================================================================

整体错误率只能说明错得多不多，**说不出错在什么上**。而这个项目里几次真正的结论
都是从逐项看出来的，不是从总数字看出来的：

  · 中文朗读那 12.3%：把删除项打出来才发现，参考里的**拉丁字母括注**
    （`（Maciej Krezel ）`、`(NHK)`）从来没被念出来 —— 100 条里 24 条的 321 次删除
    全集中在这类片段上，剥掉之后中文朗读只剩 2.8~3.7%。
  · 中文口语那 15.6%：删除里 71% 是**自我重复**（口语里"就就就这样"这类），
    只有 7.7% 落在内容字上；而替换里 `她→他`、`后→後`、`一→1` 这些**根本不是听错**。
  · 葡语口语那 16.8%：删除里落在语气词上的只有一部分，所以那个高错误率**基本是真的**。

三条结论方向各不相同，靠的是同一个动作：**把 S/D/I 逐项打出来分类**。
所以这个脚本存在的意义不是"再算一遍错误率"（那是 asr_eval 的事），
而是让"错在什么上"这个判断**可以反复跑出来**，而不是某次手工看出来的印象。

用法
    python bridge/asr_error_analysis.py var/logs/asr-eval/zh-speech-dev__large-v3_cuda_float16.json
    python bridge/asr_error_analysis.py <结果.json> --top 20

⚠️ 分类是**启发式**，而且**分语种**（中文按字与拉丁标注，葡语按词与口语缩写）。
   它回答的是"某个来源占多大比例"，不是给单条句子下判决。脚本里把这些桶叫什么、
   为什么这么分，都写在注释里 —— 因为**怎么分类本身就会影响结论**。
"""

import argparse
import json
import sys
import unicodedata
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))

from asr_score import TRADITIONAL_ONLY, align_ops, has_cjk, normalize    # noqa: E402
from whisper_stream import force_utf8_stdio                           # noqa: E402

force_utf8_stdio()

# ── 中文（按字）──────────────────────────────────────────────────────────────

# 填充词/语气词（**保守**清单：宁可少算也不多算）。
# 只放"几乎不含信息量"的：嗯啊呃哦唉呀哈欸（+ 句末语气 吧呢嘛）。
# **故意不放**「那个 / 就是 / 然后 / 这个」：它们在口语里既可能是填充、也可能是实义
# （"然后"表顺序、"就是"表强调）。放进来等于替模型开脱 —— 而这个数字是用来判断
# "能不能用"的。所以那一类单列一格，不计入"语气词"。
ZH_FILLERS = set("嗯啊呃哦唉呀哈欸吧呢嘛")
ZH_AMBIGUOUS = ("那个", "这个", "就是", "然后", "所以说", "对吧")

# 拉丁字母 / 阿拉伯数字：**在中文语料里**这两类常常是"没被念出来的书面标注"或写法差异。
# ⚠️ 它们只在中文语料里成立：葡语语料的参考文本本来就是拉丁字母，拿这个桶去套
#    会把"葡语的每一个删除"都算成"书面标注"（第一版就这么错过，数字荒唐到 97%）。
LATIN = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")
DIGITS = set("0123456789０１２３４５６７８９")
CHINESE_NUMERALS = set("零一二三四五六七八九十百千万亿两廿")

# 同音异形：普通话里**同音**，音频本身分不出该写哪个（`她/他/它` 都是 tā）。
# ⚠️ 这是"分类"不是"开脱"：它只说明"这个错不可能从声音里判出来"；
#    算不算错是**评分口径**问题（见 docs/14 §6.6）。
#    清单故意保守：「是/事」「象/像」「以/已」虽然也同音，但替换后语义差别大，
#    放进这里会让"真错"凭空变小。
ZH_HOMOPHONE_GROUPS = (
    set("他她它祂"), set("的得地"), set("哪那"), set("嘛吗"), set("在再"), set("做作"),
)

# ── 葡语（按词）──────────────────────────────────────────────────────────────

# 语气词/填充词（保守）：只放基本不含信息量的。
# 实测排在最前面的删除并不是这一类，所以这个桶**注定很小** —— 这正是结论的依据：
# 葡语口语的高错误率不是靠"语气词没算"撑起来的。
PT_FILLERS = {"é", "eh", "ah", "aham", "hum", "hã", "né", "cê", "tipo", "sei"}

# 口语缩写 ↔ 标准写法：**念出来是同一个词**，只是参考写了口语形式、模型写了标准形式。
# 这是实测排在最前面的一类替换（`pra → para` 在 dev/holdout 里各 14 / 25 次）。
# ⚠️ 归成"写法差异"而不是"听错"，是因为声音层面它们没有区别；
#    但对**字幕**来说，写成 `para` 甚至更好（正式、无歧义）—— 用户不会觉得是错。
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


def classify_deletion(span, unit, repetition):
    """给一个删除片段归一类（启发式）。`span` 是 list（按字或按词）。

    ⚠️ `repetition` 由调用方用**位置**判断（见 looks_like_repetition），
       不能图省事写成"这段文字在整句里还出现过" —— 我第一版就是那么写的，
       结果葡语里删掉一个 `a`、中文里删掉一个「的」，
       几乎必然能在同句别处找到同样的字，于是 71~83% 的删除都被算成"自我重复"，
       把真实的漏词掩盖掉了。**分类规则松一点，结论就会整个反过来。**
    """
    text = ("".join(span) if unit == "char" else " ".join(span))
    if unit == "char":
        if all(char in ZH_FILLERS for char in span):
            return "语气词/填充词"
        if any(char in LATIN for char in span):
            return "拉丁字母（书面标注，往往本来就不念）"
        if any(char in DIGITS for char in span):
            return "数字（往往本来就不念，如书面编号）"
        if repetition:
            return "自我重复（口语口吃，紧邻处又说过一遍）"
        if any(word in text for word in ZH_AMBIGUOUS):
            return "含糊词（可能实义，单独看）"
        if not has_cjk(text):
            return "非中文字符（标点/符号等）"
        return "内容字"
    # 葡语：按词
    if all(word in PT_FILLERS for word in span):
        return "语气词/填充词"
    if repetition:
        return "自我重复（口语口吃，紧邻处又说过一遍）"
    return "内容词"


def looks_like_repetition(items, start, ref_items):
    """被删的这段，是否在**紧挨着**的地方又完整出现过（口语口吃："就就就"）。

    窗口取 `max(1, len(items))`，也就是"只认相邻/重叠的那一次重复"。
    为什么窗口不能放大：
      · 放大到 ±8 时，删掉一个「的」几乎必然能在同句 8 个字内再找到一个「的」，
        于是 71~83% 的删除都被算成"自我重复"，真实漏词被掩盖 —— 我第一版就这样，
        结论差点整个反过来；
      · 而口语口吃的特征恰恰是**相邻重复**（"就就就"、"那个那个"），相邻就够用。
    宁可比真实值小一点：这一格是"可以不算进声学错误"的桶，宁可小，不可虚大。
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


def classify_substitution(reference, hypothesis, unit):
    """给一次替换归类（启发式）。

    为什么替换也要分类：中文口语那 15.6% 里**替换占 8.1 个百分点**（删除只占 6.5），
    而排在前面的替换是 `她 → 他`、`后 → 後`、`一 → 1` —— 这些**都不是听错**。
    不分类的话，"写法/字形差异"会和"真听错"混成一个数字，
    而这个数字是要拿去决定"要不要换模型、要不要上热词"的。
    """
    if unit == "char":
        if reference in CHINESE_NUMERALS and hypothesis in DIGITS:
            return "数字写法（汉字↔阿拉伯，念出来一样）"
        if hypothesis in CHINESE_NUMERALS and reference in DIGITS:
            return "数字写法（汉字↔阿拉伯，念出来一样）"
        if hypothesis in TRADITIONAL_ONLY and reference not in TRADITIONAL_ONLY:
            # ⚠️ 这不是"听错"，但对**产品**是真缺陷：字幕里冒出繁体字，用户看着别扭。
            #    两件事要分开报：评测口径（分数）与用户体验（看到的字）。
            return "繁体字形（不是听错，但用户看得到）"
        if any(reference in group and hypothesis in group for group in ZH_HOMOPHONE_GROUPS):
            return "同音异形（音频分不出来）"
        return "真错"
    # 葡语：按词
    if reference == hypothesis:
        return "真错"
    if same_equivalent_group(reference, hypothesis):
        return "口语缩写↔标准写法（念出来一样）"
    if strip_accents(reference) == strip_accents(hypothesis):
        return "只差变音符号（重音/鼻化）"
    return "真错"


def load_rows(path):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return data, data.get("rows", [])


def deleted_runs(ops):
    """把连续的删除合成"片段"，并记住它在**参考**里的起始位置。

    逐字看没意义，看的是"漏掉了哪几个字/词"；而"是不是口语口吃"要靠位置判断，
    所以位置必须一起带出来。
    """
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


def analyse(path, top=25):
    data, rows = load_rows(path)
    unit = data.get("unit", "word")
    unit_name = "字" if unit == "char" else "词"
    print("=" * 84)
    print(f"{Path(path).name}")
    print(f"  语料 {data.get('set')}   语种 {data.get('language') or '自动'}   单位 {unit_name}")
    print(f"  整体错误率 {data['weightedRate'] * 100:.1f}%  "
          f"（S{data['substitutions']} D{data['deletions']} I{data['insertions']} / {data['totalUnits']}）"
          f"  良好 {data['goodCount']}/{data['scoredCount']}")
    if data.get("traditionalTotal"):
        print(f"  疑似繁体 {data['traditionalTotal']} 字 / {data['traditionalSentences']} 句")
    print("=" * 84)

    deleted = Counter()
    deletion_categories = Counter()
    substitution_pairs = Counter()
    substitution_categories = Counter()
    substitution_examples = {}
    traditional_heavy = []

    for row in rows:
        ops = align_ops(row["reference"], row["hypothesis"], unit)
        reference = row["reference"]
        ref_items = list(reference) if unit == "char" else normalize(reference, "word").split()
        for span, start in deleted_runs(ops):
            text = "".join(span) if unit == "char" else " ".join(span)
            deleted[text] += 1
            repeated = looks_like_repetition(span, start, ref_items)
            deletion_categories[classify_deletion(span, unit, repeated)] += len(span)
        for kind, ref, hyp in ops:
            if kind != "S":
                continue
            substitution_pairs[(ref, hyp)] += 1
            bucket = classify_substitution(ref, hyp, unit)
            substitution_categories[bucket] += 1
            substitution_examples.setdefault(bucket, Counter())[(ref, hyp)] += 1
        if row.get("traditional", 0) >= 3:
            traditional_heavy.append((row["file"], row["traditional"], row["rate"]))

    total_deleted = sum(deletion_categories.values())
    print(f"\n删除的 {total_deleted} 个{unit_name}按来源分（启发式）：")
    for name, count in deletion_categories.most_common():
        share = (count / total_deleted * 100) if total_deleted else 0.0
        print(f"  {share:5.1f}%  {count:>5} {unit_name}   {name}")

    total_subs = sum(substitution_categories.values())
    print(f"\n替换的 {total_subs} 次按来源分（启发式）：")
    for name, count in substitution_categories.most_common():
        share = (count / total_subs * 100) if total_subs else 0.0
        examples = "、".join(f"{ref}→{hyp}({n})"
                             for (ref, hyp), n in substitution_examples[name].most_common(4))
        print(f"  {share:5.1f}%  {count:>5} 次   {name}" + (f"    例：{examples}" if examples else ""))

    # 这一行是这个脚本最有用的一行：**"写法差异"占整体错误率多少**。
    # ⚠️ 它**不是**"可以抹掉的错误"：繁体字形用户看得见，漏掉语气词句子会变硬。
    #    它回答的是"这些错有多少来自口径"，好让调参时不去追一个不存在的声学问题。
    units = data.get("totalUnits") or 1
    convention = sum(count for name, count in substitution_categories.items()
                     if not name.startswith("真错"))
    convention += sum(count for name, count in deletion_categories.items()
                      if name.startswith(("语气词", "拉丁字母", "数字（往往")))
    print(f"\n  ⚠️ 其中「写法/口径差异」共 {convention} 次 = "
          f"{convention / units * 100:.1f} 个百分点"
          f"（整体 {data['weightedRate'] * 100:.1f}%）。")
    print("     这一部分**不是听错**，但也不是「可以抹掉的错」：繁体字形与漏掉的语气词")
    print("     用户都看得见/感觉得到。要不要算进错误率是**评分口径**问题（docs/14 §6.6）。")
    print(f"     真正要追的声学错误 ≈ {data['weightedRate'] * 100 - convention / units * 100:.1f}%。")

    print(f"\n最常见的删除片段（前 {top}）：")
    for span, count in deleted.most_common(top):
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
    print("")
    return 0


def main():
    parser = argparse.ArgumentParser(description="把识别错误按来源分类（删除/替换逐项看）")
    parser.add_argument("result", help="asr_eval 写出的结果 json")
    parser.add_argument("--top", type=int, default=25, help="每类最多列几条（缺省 25）")
    args = parser.parse_args()
    path = Path(args.result)
    if path.is_file() is False:
        sys.exit(f"找不到结果文件：{path}")
    return analyse(path, args.top)


if __name__ == "__main__":
    sys.exit(main())
