r"""
asr_score.py —— 识别评分的**判据本身**（冻结、版本化、纯函数、可逐条测试）
================================================================================

为什么把评分从 asr_eval.py 里拆出来单独一个模块：

  1. **评分规则必须冻结并带版本号。** 老师的要求："每次运行绑定 … 评分规则版本"。
     规则一变，历史数字就不可比 —— 所以规则要能被打成指纹、写进报告。
  2. **规则要能被逐条测试。** 归一化、替换/删除/插入的算法、数字等价 ——
     这些一旦算错，**所有报告都是错的，而且不会报错**。埋在评测脚本里只能靠人读，
     抽成纯函数才能钉住（这和把语种挑选抽成 pick_language 是同一个理由）。

⚠️ 这里**不做**语义判断。它只回答"识别出来的字/词与参考差在哪"。

评分规则（v1，改动必须升版本号）
--------------------------------------------------------------------------------
单位：中文按**字**（CER），巴葡按**词**（WER）。两者的"词"定义不同，不混用。
归一化（比较前）—— **v1 刻意与既有 asr_eval.py 的实现逐字一致**：
  · 统一小写；弯引号 `’` 折成 `'`
  · 中文按字：`re.sub(r"[^\w]", "", text)` —— 标点**与空白**一起去掉
    （中文里空白不是语义；FLEURS 的逐字转写字段是空格分隔的，不去会算错字数）
  · 葡语按词：`re.sub(r"[^\w\s']", " ", text)` 再合并空白（标点换成空格，不删，
    否则 `hello,world` 会被粘成一个词）
  · **重音符号保留**（`é` ≠ `e`，那是有意义的）
  · 繁简：**不转换**。繁体输出按错字计入（实测 base/tiny 会把简体输出成繁体，
    那是真实缺陷，不该被"转换后不算错"洗掉）。同时单独报"疑似繁体字数"。
  · 数字：**不做等价归一**
  · 语气词/重复/改口：**计入**（按原始转写算）—— 即主指标是**严格转写**口径。
整体错误率 = 全部编辑错误数 ÷ 全部参考单位数（**不是**每句百分比的平均）。

> ⚠️ **为什么 v1 要"照抄旧实现"而不是顺手改好**：旧实现产出的那批数字
> （FLEURS 3.9%、CORAA 12.2% / 13.3%）是现在所有结论的基线。
> 一开始我写了 NFKC 归一 + 保留空白，那会**悄悄改掉历史数字**，
> 于是"改进了没有"就再也说不清。想改归一化就开 v2、并把所有历史集重跑一遍 ——
> 这也是老师"评分规则冻结 + 绑定版本号"那一条的实际含义。
"""

import re
from pathlib import Path

# ⚠️ 两个模式必须分开，别像我第一版那样合成一个带 `\s` 的类 ——
#    那样空白会被保留，中文按字时每个空格都算一个字符，CER 直接失真。
SCORING_RULES_VERSION = "asr-score-v1"

_PUNCT_DROP = re.compile(r"[^\w]", re.UNICODE)          # char 模式：标点与空白都去掉
_PUNCT_SPACE = re.compile(r"[^\w\s']", re.UNICODE)      # word 模式：标点换成空格
_CJK = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]")

# 只统计"简体句里不该出现的繁体专用字"。
#
# ⚠️ 这张表**照抄旧实现**（asr_eval.py 里原来那一份），不是我自己另拟的 ——
#    "疑似繁体字数"是历史报告里的一个数，换表就等于换口径，历史数字立刻不可比。
#    表本身不算完备（旧注释原话："不是完备的繁简对照表，只覆盖口语里最常出现的一批"），
#    所以指标名一直叫"**疑似**繁体字数"。要改进它是 v2 的事，届时所有历史集重跑一遍。
TRADITIONAL_ONLY = set(
    "這說麼為個們來時會對開過實現學國產與東車門見長問間題讓從應該裡樣還進發經頭幾語聽讀寫"
    "電話點認識覺辦體條壓點無萬業員這樣實際應該處理總機關於當來後東車馬鳥魚龍風飛隻億據"
    "處臟選擇觀觀點運動員圖書館總結經驗營運營養")
# 这些字在简体里也这么写，去掉以免误报（上面列表里混进来的）。
TRADITIONAL_ONLY -= set("由只几只")


def normalize(text, unit="word"):
    """比较前归一。见模块头部的规则表（v1，与既有实现逐字一致）。"""
    value = str(text).lower().replace("’", "'")
    if unit == "char":
        return _PUNCT_DROP.sub("", value)
    return " ".join(_PUNCT_SPACE.sub(" ", value).split())


def has_cjk(text):
    return _CJK.search(str(text)) is not None


def count_traditional(text):
    return sum(1 for char in str(text) if char in TRADITIONAL_ONLY)


def _better(a, b):
    """按 (总错误, 替换, 删除, 插入) 取更优，并用固定优先级打破并列。

    并列时优先**替换** > 删除 > 插入。这个选择会影响 S/D/I 的分配，
    但不影响总错误数；固定下来是为了让报告可复现（换个人跑结果一样）。
    """
    if b is None:
        return a
    if a is None:
        return b
    return a if (a[0], a[1], a[2], a[3]) <= (b[0], b[1], b[2], b[3]) else b


def align(reference, hypothesis, unit="word", normalizer=None):
    """返回 (替换, 删除, 插入)。

    约定（相对参考）：
      · 替换：参考里有一个、识别里换成了别的
      · 删除：参考里有、识别里**没有**（漏字/漏词）
      · 插入：识别里多出来的（多字/多词、重复）
    老师要的"含替换／删除／插入"就是这三项。

    ⚠️ 这里**只是把 align_ops 的结果数出来** —— 两套实现各算一遍是危险的：
       "总数对得上、S/D/I 分配不一样"会让报告里的三项悄悄漂移。
    """
    ops = align_ops(reference, hypothesis, unit, normalizer=normalizer)
    subs = sum(1 for op in ops if op[0] == "S")
    dels = sum(1 for op in ops if op[0] == "D")
    inss = sum(1 for op in ops if op[0] == "I")
    return subs, dels, inss


def align_ops(reference, hypothesis, unit="word", normalizer=None):
    """返回**逐项**对齐结果：`[("S"|"D"|"I", 参考项 或 None, 识别项 或 None), …]`

    为什么要它（不是为了好看）：整体错误率只能说明"错了多少"，
    **说不出错在什么上**。真正查出问题靠的是逐项：
      · 中文朗读那 12.3% 是怎么来的？—— 把删除项打出来才看到，
        参考里的拉丁字母括注（`（Maciej Krezel ）`、`(NHK)`）从来没被念出来，
        325 次删除里有 321 次集中在这类片段上（见 docs/14 §6.3）；
      · 葡语/中文口语里的删除到底是不是"语气词与自我重复"？——
        同样只能靠逐项统计回答。
    所以"错在哪些字上"必须是**能反复跑出来**的东西，而不是我某次手工看的结论。

    并列时的取舍与 `_better` 完全一致（优先替换 > 删除 > 插入），
    所以 `align()` 数出来的 S/D/I 与历史报告逐字一致（有测试钉住）。
    """
    if unit == "char":
        ref = list((normalizer or normalize)(reference, "char"))
        hyp = list((normalizer or normalize)(hypothesis, "char"))
    else:
        ref = (normalizer or normalize)(reference, "word").split()
        hyp = (normalizer or normalize)(hypothesis, "word").split()

    # 存整张表再回溯（而不是每个格子存一份操作列表）：句子只有几百个单位，
    # 表本身很小，但每格存列表会平白多出一个数量级的开销。
    table = [[None] * (len(hyp) + 1) for _ in range(len(ref) + 1)]
    table[0][0] = (0, 0, 0, 0)
    for j in range(1, len(hyp) + 1):
        table[0][j] = (j, 0, 0, j)                      # 前面全是插入
    for i in range(1, len(ref) + 1):
        table[i][0] = (i, 0, i, 0)                      # 前面全是删除
    for i in range(1, len(ref) + 1):
        for j in range(1, len(hyp) + 1):
            if ref[i - 1] == hyp[j - 1]:
                table[i][j] = table[i - 1][j - 1]       # 命中，不花代价
                continue
            # ⚠️ 来源格子别写反了（我第一版就写反过）：
            #    删除 ref[i-1] 是从 **[i-1][j]** 过来的（参考前进、识别不动），
            #    插入 hyp[j-1] 是从 **[i][j-1]** 过来的。
            sub = table[i - 1][j - 1]
            dele = table[i - 1][j]
            ins = table[i][j - 1]
            candidates = [(sub[0] + 1, sub[1] + 1, sub[2], sub[3]),
                          (dele[0] + 1, dele[1], dele[2] + 1, dele[3]),
                          (ins[0] + 1, ins[1], ins[2], ins[3] + 1)]
            # ⚠️ 顺序即优先级：替换 > 删除 > 插入（与 _better 的并列取舍一致）。
            #    `min` 在并列时取**第一个**，所以这里的顺序就是"怎么分 S/D/I"的规则。
            table[i][j] = min(candidates)

    ops = []
    i, j = len(ref), len(hyp)
    while i > 0 or j > 0:
        if i > 0 and j > 0 and ref[i - 1] == hyp[j - 1] and table[i][j] == table[i - 1][j - 1]:
            ops.append(("=", ref[i - 1], hyp[j - 1]))
            i, j = i - 1, j - 1
            continue
        if i > 0 and j > 0 and table[i][j] == (table[i - 1][j - 1][0] + 1, table[i - 1][j - 1][1] + 1,
                                               table[i - 1][j - 1][2], table[i - 1][j - 1][3]):
            ops.append(("S", ref[i - 1], hyp[j - 1]))
            i, j = i - 1, j - 1
            continue
        if i > 0 and table[i][j] == (table[i - 1][j][0] + 1, table[i - 1][j][1],
                                     table[i - 1][j][2] + 1, table[i - 1][j][3]):
            ops.append(("D", ref[i - 1], None))
            i -= 1
            continue
        # 只剩插入（表的第一行/第一列保证这里一定有得走）
        ops.append(("I", None, hyp[j - 1]))
        j -= 1
    ops.reverse()
    return ops


def error_rate(reference, hypothesis, unit="word", normalizer=None):
    """返回一条样本的评分。

    字段名与 asr_eval 原来的输出保持兼容（rate / units / distance），
    并补上 s / d / i 三项。

    `normalizer`：比较前用哪套归一化。缺省是 v1 严格口径（标点/大小写/空白）。
    传 `normalize_for_scoring` 就是 v2 规范化口径 —— **两套口径都在这一个函数里算**，
    因为它们唯一的区别就是"拿什么文本去对齐"，其余（对齐算法、单位计数）必须完全一样：
    两套各写一份实现，迟早会漂成"两套算法"，而它们的差值本来是要拿来对比的。
    """
    normalizer = normalizer or normalize
    subs, dels, inss = align(reference, hypothesis, unit, normalizer=normalizer)
    if unit == "char":
        units = len(list(normalizer(reference, "char")))
    else:
        units = len(normalizer(reference, "word").split())
    distance = subs + dels + inss
    return {
        "rate": (distance / units) if units else float("nan"),
        "units": units,
        "distance": distance,
        "substitutions": subs,
        "deletions": dels,
        "insertions": inss,
    }


def overall_rate(rows):
    """整体错误率 = 全部编辑错误数 ÷ 全部参考单位数。

    老师明确要求**不要**用"每句百分比的平均"：那个指标会让短句权重过大，
    而短句的错误率天然更抖（一个字错就是 100%）。
    返回 (整体错误率, 总参考单位, 总错误数, S/D/I 合计)。
    """
    units = sum(row["units"] for row in rows)
    distance = sum(row["distance"] for row in rows)
    subs = sum(row["substitutions"] for row in rows)
    dels = sum(row["deletions"] for row in rows)
    inss = sum(row["insertions"] for row in rows)
    return ((distance / units) if units else float("nan"), units, distance, (subs, dels, inss))


def key_term_hits(reference, hypothesis, key_terms, unit="word"):
    """关键内容（人工确认过的专名/数字/否定）在识别输出里还在不在。

    ⚠️ 老师的要求是"专名、数字另做专项评分，不能只依赖整体 CER/WER"，
    而 key_terms 必须是**人工确认过**的 —— 所以这个函数只按给出的清单判，
    自己**不猜**哪些是专名。清单为空就返回空，报告里如实写"本批不可用"。

    判据：key_term 归一化后在**归一化后的识别文本**里出现即算命中。
    为什么不用"数值相等"那套：那需要在中葡两种数字写法之间做算术，
    而这里是**同一种语言**的识别，写成什么样就是什么样；
    用字符串包含即可，且不会把听错的数字洗成正确。
    """
    hits = []
    for term in key_terms or []:
        wanted = normalize(term, "char" if has_cjk(term) else "word").replace(" ", "")
        got = normalize(hypothesis, "char" if has_cjk(term) else "word").replace(" ", "")
        hits.append({"term": term, "hit": wanted != "" and wanted in got})
    return hits


def problem_samples(rows, threshold=0.10, unit="char", limit=None):
    """挑出**有问题的样本**：错误率高于阈值的，按高到低排（最差的排最前）。

    为什么要这个：原来报告里只有"随机看 3 条对照"—— 随机看对排查**没有用**，
    要查"哪几条坏了"就得自己翻 JSON。这里给出的是可以直接照着听的清单：
    每条带**音频文件名、时长、错误率、S/D/I、具体差异**（漏了哪些字、听成什么）。

    ⚠️ 阈值缺省 0.10 与"好的句子 ≤10%"用的是同一个判据，所以"排在上面的"
       正好就是那些**被算作不好**的样本 —— 两个口径下的同一个定义，不会打架。
    """
    picked = []
    for row in rows:
        rate = row.get("rate")
        if rate is None or rate != rate:            # NaN
            continue
        if rate <= threshold:
            continue
        ops = align_ops(row["reference"], row["hypothesis"], unit)
        diffs = []
        for kind, ref, hyp in ops:
            if kind == "S":
                diffs.append(f"{ref}→{hyp}")
            elif kind == "D":
                diffs.append(f"漏{ref}")
            elif kind == "I":
                diffs.append(f"多{hyp}")
        picked.append({
            "file": row["file"],
            "seconds": row.get("seconds"),
            "rate": rate,
            "units": row.get("units"),
            "deletions": row.get("deletions"),
            "substitutions": row.get("substitutions"),
            "insertions": row.get("insertions"),
            "reference": row["reference"],
            "hypothesis": row["hypothesis"],
            "diffs": diffs,
            # 规范化口径那一套也带上：一眼能看出"这个错是不是写法差异造成的"
            "normalized_rate": row.get("normalized_rate"),
        })
    picked.sort(key=lambda item: -item["rate"])
    return picked[:limit] if limit else picked


def format_problem_samples(samples, pack_dir=None, line_prefix="ERROR"):
    """把问题样本排成人能看、也能 grep 的文本（每条的**首行以 ERROR 开头**）。

    为什么要固定的行首前缀：用户要的正是"日志里能一眼筛出来"。
    所以每条的第一行一定是 `ERROR <文件名> …` —— `Select-String ERROR` 就能全捞出来，
    而参考/识别那几行保持原样（它们的内容里本来就可能含任何字，不适合加前缀）。
    """
    lines = []
    for index, item in enumerate(samples, 1):
        # 路径要用系统分隔符拼（拼成 `packs\zh-speech-dev/zh-….wav` 那种混的没法直接点开）
        where = str(Path(pack_dir) / item["file"]) if pack_dir else item["file"]
        normalized = item.get("normalized_rate")
        extra = ""
        if normalized is not None and normalized != item["rate"]:
            extra = f"（规范化口径 {normalized * 100:.0f}%）"
        lines.append(f"{line_prefix} #{index:<3} {item['file']}  "
                     f"错误率 {item['rate'] * 100:.1f}%{extra}  "
                     f"S{item['substitutions']} D{item['deletions']} I{item['insertions']}  "
                     f"[{item['seconds']}s]")
        lines.append(f"      音频  {where}")
        lines.append(f"      参考  {item['reference']}")
        lines.append(f"      识别  {item['hypothesis']}")
        if item["diffs"]:
            shown = "、".join(item["diffs"][:20])
            more = "" if len(item["diffs"]) <= 20 else f" …共 {len(item['diffs'])} 处"
            lines.append(f"      差异  {shown}{more}")
        lines.append("")
    return "\n".join(lines)


def percentile(values, fraction):
    """线性插值分位数（P50/P95 用）。空列表返回 None，不假装是 0。"""
    data = sorted(value for value in values if value is not None)
    if not data:
        return None
    if len(data) == 1:
        return data[0]
    position = (len(data) - 1) * fraction
    low = int(position)
    high = min(low + 1, len(data) - 1)
    weight = position - low
    return data[low] * (1 - weight) + data[high] * weight


def key_term_candidates(reference):
    """从参考转写里**自动提候选**关键内容，供人工确认。

    老师要求 key_terms 是"人工确认过的"，所以这里**只提候选、不下结论**：
    提出来的是两类**客观可判**的东西 —— 数字（含中文数字）与拉丁字母词
    （产品名、型号、缩写通常在这类里）。
    ⚠️ 中文人名/机构名**故意不提**：没有可靠的中文专名启发式，
    硬提会淹掉候选清单，不如留给人工或后续的模型提候选环节。
    """
    text = str(reference)
    out = []
    out.extend(re.findall(r"\d+(?:[.,]\d+)?", text))
    out.extend(re.findall(r"[〇零一壹二两贰三叁四肆五伍六陆七柒八捌九玖十百千万亿]+", text))
    out.extend(re.findall(r"[A-Za-z][A-Za-z0-9.\-]{1,}", text))
    seen = []
    for item in out:
        if item not in seen:
            seen.append(item)
    return seen


# ════════════════════════════════════════════════════════════════════════════════
# v2：**规范化口径**（`asr-norm-v1`）—— 与严格口径并列，不是替换它
# ════════════════════════════════════════════════════════════════════════════════
#
# 为什么要有第二套口径：严格口径里有一部分"错"**不是听错**（同一个值写成阿拉伯
# 数字、同一个字写成繁体、同一个词写成口语缩写），把它们和真听错混在一个数字里，
# 既说不清"模型到底多准"，也说不清"要不要换模型"。
#
# ⚠️⚠️ 但规范化**必须重新对齐算**，不能从严格错误数里"减掉几个分类桶"：
#    分类桶是**逐项归因**（启发式，可能归错），而规范化是**换一套比较文本后重算**。
#    两者混用会得到一个既不是严格分、也不是规范分的第三个数 —— 而它还看起来像个分数。
#    这条是评审明确指出的，也钉了测试（`tests/python-suite.py`）。
#
# 规范化里**允许**做的事（每一条都要能说清"为什么它不是听错"）：
#   1. 标点、大小写、空白        —— 明确规则，v1 已做
#   2. 繁简对应字                —— **只按下面那张按实测字写成的表**转换，表外的繁体字
#                                  一律当错字（评审指出：`我 → 國` 曾被错误地当字形差异）
#   3. 数值+单位等价             —— 必须**数值相等且单位相同**才统一
#                                  （`一 → 9` 不是等价，是听错）
#   4. 紧邻的重复（口吃）        —— 只折叠**紧挨着**的重复，不做全局去重
#   5. 纯感叹词（可选，默认**关**）—— `嗯/呃/哦/唉/哈/欸`；`吧呢嘛啊呀` **不算**，
#                                  它们带语气与疑问，评审明确要求保留
#
# 规范化里**不做**的事（评审逐条点到的）：
#   · 不删「那个/就是/然后」这类可能实义的词
#   · 不把葡语的 `é / sei / cê` 当成无信息（它们在句子里可能是"是/知道/你"）
#   · 不因为删除片段"含拉丁字母或数字"就当成没念（产品型号、金额可能真的被漏掉）
#   · 不动人名、型号、金额、否定词
#   —— 也就是说：**规范化只改"同一个东西的写法"，不删内容、不改数值、不动极性**。
NORMALIZED_RULES_VERSION = "asr-norm-v1"

# 繁 → 简。**按实测出现过的字一条条写的**，不是从别处抄的大表：
#   抄来的表错了没人能发现；这张表每一项都能对着数据复核
#   （`var/tmp` 里那个一次性脚本会把实测出现的字对打出来）。
#
# ⚠️ 这张表**故意不包含**那些"看着像繁简、其实是听错"的字对。实测出现的 80 对里，
#    真正是繁简对应的只有下面这些；其余（`咯→個`、`了→覺`、`些→點`、`五→無`、
#    `那→這`、`是→當`、`人→個` …）全是**真实的听错**，编辑器分不开，必须算错。
VARIANT_TO_SIMPLIFIED = {
    "這": "这", "說": "说", "麼": "么", "為": "为", "個": "个", "們": "们",
    "來": "来", "時": "时", "會": "会", "對": "对", "開": "开", "過": "过",
    "實": "实", "現": "现", "學": "学", "國": "国", "產": "产", "與": "与",
    "東": "东", "車": "车", "門": "门", "見": "见", "長": "长", "問": "问",
    "間": "间", "題": "题", "讓": "让", "從": "从", "應": "应", "該": "该",
    "裡": "里", "樣": "样", "還": "还", "進": "进", "發": "发", "經": "经",
    "頭": "头", "幾": "几", "語": "语", "聽": "听", "讀": "读", "寫": "写",
    "電": "电", "話": "话", "點": "点", "認": "认", "識": "识", "覺": "觉",
    "辦": "办", "體": "体", "條": "条", "壓": "压", "無": "无", "萬": "万",
    "業": "业", "員": "员", "際": "际", "處": "处", "總": "总",
    "機": "机", "關": "关", "於": "于", "當": "当", "後": "后", "馬": "马",
    "鳥": "鸟", "魚": "鱼", "龍": "龙", "風": "风", "飛": "飞", "隻": "只",
    "億": "亿", "據": "据", "臟": "脏", "選": "选", "擇": "择", "觀": "观",
    "運": "运", "動": "动", "圖": "图", "書": "书", "館": "馆", "結": "结",
    "驗": "验", "營": "营", "養": "养", "嗎": "吗",
    # 数量词/单位里会用到的那些（数字检查要靠它们把单位对上，
    # 缺一个就会出现"规范化说等价、关键内容检查说单位丢了"的自相矛盾 —— 实测踩到过）
    "兩": "两", "樓": "楼", "層": "层", "號": "号", "歲": "岁", "噸": "吨",
    "鐘": "钟", "週": "周", "臺": "台", "塊": "块", "顆": "颗", "隻": "只",
}

# 有歧义的繁简对：**只报不改**（评审要求"涉及歧义时复核"）。
# `里/裡`：`里` 也可以是"里程"（里），不是繁体；`干/乾`、`发/髮發` 同理。
AMBIGUOUS_VARIANTS = {"裡", "乾", "髮", "乾"}

# 纯感叹词（默认**不删**）。评审的意见很具体：`吧呢嘛` 带语气与疑问，
# `啊呀` 也常是句末语气词 —— 所以这里只留"几乎不承载语义"的几个。
INTERJECTIONS_ZH = set("嗯呃哦唉哈欸")

# 量词/单位：数字后面紧跟这些字时**连在一起比**（否则 `8` 与 `8楼` 会被当成同一个数）。
# ⚠️ `万/亿/千` **不在**这里 —— 它们是**乘数**（作用在数值上），不是单位。
UNITS_ZH = ("元", "块", "角", "分", "楼", "层", "号", "米", "公里", "公斤", "克", "吨",
            "岁", "点", "秒", "小时", "分钟", "天", "周", "月", "年", "人", "个",
            "台", "套", "件", "倍", "度", "%", "％")
UNITS_PT = ("reais", "real", "milhão", "milhões", "bilhão", "bilhões", "porcento",
            "%", "metros", "metro", "quilos", "quilo", "horas", "hora", "minutos",
            "minuto", "segundos", "segundo", "dias", "dia", "meses", "mês",
            "anos", "ano", "pessoas", "pessoa")

_CN_DIGITS = {"零": 0, "〇": 0, "一": 1, "壹": 1, "二": 2, "两": 2, "贰": 2, "三": 3, "叁": 3,
              "四": 4, "肆": 4, "五": 5, "伍": 5, "六": 6, "陆": 6, "七": 7, "柒": 7,
              "八": 8, "捌": 8, "九": 9, "玖": 9}
_CN_UNITS = {"十": 10, "百": 100, "千": 1000}
_CN_SECTIONS = {"万": 10 ** 4, "亿": 10 ** 8}
_CN_NUMERAL_CHARS = set(_CN_DIGITS) | set(_CN_UNITS) | set(_CN_SECTIONS) | {"廿"}
_MULTIPLIERS = {"万": 10 ** 4, "萬": 10 ** 4, "亿": 10 ** 8, "億": 10 ** 8, "千": 1000}


def chinese_numeral_value(text):
    """中文数字 → int；**认不出来返回 None**（不猜）。

    支持 `十五` / `一百二十三` / `两千` / `廿`。
    返回 None 的场合：空串、含不认识的字符、结构不合法。

    ⚠️ `十十` **返回 None**，不能算成 20：结构化不合法时"算出一个数"比"不算"危险 ——
    它会让乱码输出恰好等于参考里的另一个数（`十十` 撞上 `二十`），
    把一次真听错洗成"等价写法"。**宁可不算，也不猜。**
    """
    if not text:
        return None
    if text == "廿":
        return 20
    # ⚠️ **纯数字字串按"逐位念"解释**：`一四二四` = 1424（房间号/年份就是这么念的）。
    #    这不只是猜：`一四二四` 与 `1424` **念出来完全一样**，所以它们本来就该等价 ——
    #    实测就有一条「编号为一四二四」对「编号为1424」，旧实现把 `一四二四` 算成 4，
    #    于是**把一次正确的识别报成了数字错**。
    if all(char in _CN_DIGITS for char in text):
        digits = "".join(str(_CN_DIGITS[char]) for char in text)
        return int(digits)
    total, section, number, seen = 0, 0, 0, False
    previous_was_unit = False
    for char in text:
        if char in _CN_DIGITS:
            number = _CN_DIGITS[char]
            seen = True
            previous_was_unit = False
            continue
        if char in _CN_UNITS:
            if previous_was_unit:
                return None                                 # 十十 / 百十 这类结构不合法
            number = (number or 1) * _CN_UNITS[char]        # 「十五」的十 = 1×10
            section += number
            number = 0
            seen = True
            previous_was_unit = True
            continue
        if char in _CN_SECTIONS:
            if previous_was_unit:
                return None
            section = (section + number) or 1
            total += section * _CN_SECTIONS[char]
            section, number = 0, 0
            seen = True
            previous_was_unit = True
            continue
        return None                                        # 有不认识的字符 → 不猜
    return (total + section + number) if seen else None


def _match_unit(raw, index, unit_mode):
    """从 index 处匹配一个量词/单位；返回 `(单位, 消费到的下标)`，没匹配到返回 `("", index)`。

    ⚠️ 返回**结束下标**而不是"长度"：word 模式下数字与单位之间可能有空格
    （`3 milhões`），只按长度推进会把单位尾巴留成多出来的字 ——
    实测就是 `3 milhões` 被规范化成 `3milhõess`（多一个 s）。
    """
    probe = index
    if unit_mode == "word":
        while probe < len(raw) and raw[probe] == " ":
            probe += 1
    for unit in sorted(set(UNITS_ZH) | set(UNITS_PT), key=len, reverse=True):
        if raw.startswith(unit, probe):
            return unit, probe + len(unit)
    return "", index


def _arabic_value(token, unit_mode):
    """阿拉伯数字串 → 数值；看不清千分位/小数点时按该语言的书写习惯判断。"""
    if token == "":
        return None
    if unit_mode == "word":
        if "," in token and "." in token:                   # 葡语 1.234,56
            token = token.replace(".", "").replace(",", ".")
        elif "," in token:
            head, _, tail = token.rpartition(",")
            token = f"{head}.{tail}" if len(tail) in (1, 2) else token.replace(",", "")
        elif token.count(".") > 1:                          # 1.234.567
            token = token.replace(".", "")
    elif "," in token:
        token = token.replace(",", "")                      # 中文里逗号一般是千分位
    try:
        value = float(token)
    except ValueError:
        return None
    return value


def _render(value, unit_mode):
    """数值 → 字符串。小数在中文（按字）模式下写成 `3_5`。

    ⚠️ 为什么不用 `.`：char 模式最后那道标点规则会把 `.` 去掉，
    `3.5` 与 `35` 于是变成同一个串 —— 那是**两个不同的数**，不该等价。
    用 `_`（属于 `\\w`，能活过标点规则）保住这个区别。
    """
    if float(value).is_integer():
        return str(int(value))
    return f"{value:g}".replace(".", "_") if unit_mode == "char" else f"{value:g}"


# ── 葡语的"数字词"（vinte / quatorze / trinta e cinco）────────────────────────
#
# 为什么需要：参考转写常常把数字写成词（`vinte anos`），而模型输出写成阿拉伯数字
# （`20 anos`）—— **念出来完全一样**。没有这一步，规范化会把它们判成"替换 + 删除"，
# 于是规范化分数反而**比严格分数更差**（实测：pt-speech-dev 300 条里有 4 条就是这样，
# 差值 -0.2 个百分点）。那是规则的缺陷，不是数据的性质。
PT_NUMBER_WORDS = {
    "zero": 0, "um": 1, "uma": 1, "dois": 2, "duas": 2, "três": 3, "tres": 3,
    "quatro": 4, "cinco": 5, "seis": 6, "sete": 7, "oito": 8, "nove": 9,
    "dez": 10, "onze": 11, "doze": 12, "treze": 13, "catorze": 14, "quatorze": 14,
    "quinze": 15, "dezesseis": 16, "dezassete": 17, "dezessete": 17, "dezoito": 18,
    "dezenove": 19, "vinte": 20, "trinta": 30, "quarenta": 40, "cinquenta": 50,
    "sessenta": 60, "setenta": 70, "oitenta": 80, "noventa": 90,
    "cem": 100, "cento": 100, "duzentos": 200, "duzentas": 200, "trezentos": 300,
    "trezentas": 300, "quatrocentos": 400, "quatrocentas": 400, "quinhentos": 500,
    "quinhentas": 500, "seiscentos": 600, "seiscentas": 600, "setecentos": 700,
    "setecentas": 700, "oitocentos": 800, "oitocentas": 800, "novecentos": 900,
    "novecentas": 900, "mil": 1000, "milhão": 10 ** 6, "milhões": 10 ** 6,
    "bilhão": 10 ** 9, "bilhões": 10 ** 9,
}


def portuguese_number_value(words):
    """一串葡语数字词 → 数值；**结构不合法就返回 None**（不猜）。

    ⚠️ `e` 只在**合法的合成数结构**里才允许连接：`trinta e cinco`(35)、`cento e vinte`(120)、
    `mil e quinhentos`(1500) 都合法；而 `cinco e seis`（五和六）**不合法** ——
    把它算成 11 会让"cinco e seis"与"onze"被判成等价，那是**把真错洗掉**。
    判据：已累加的部分是 10 的整数倍时才允许 `e` 继续（`trinta`=30 ✓、`cinco`=5 ✗）。
    """
    total, current = 0, 0
    last_multiplier = 0
    previous_was_connector = False
    seen = False
    for word in words:
        if word == "e":
            # 允许 `e` 的条件：前面累加出来的数"整十整百"（trinta / cento / mil 都满足）
            if (total + current) == 0 or (total + current) % 10 != 0:
                return None                            # 不合法：`cinco e seis`
            previous_was_connector = True
            continue
        value = PT_NUMBER_WORDS.get(word)
        if value is None:
            return None                                # 有不认识的词 → 整串不猜
        seen = True
        if value >= 1000:
            if value > last_multiplier and (total + current) > 0:
                # 升档：`mil milhões` = 1000 × 10^6（不是 1000 + 10^6）
                total = (total + current) * value
            else:
                total += (current or 1) * value
            current = 0
            last_multiplier = value
        elif value >= 100:
            current += value
        else:
            if current == 0:
                current = value
            elif current % 100 == 0:
                current += value                       # `cento e vinte` → 120
            elif current % 100 >= 10 and value < 10:
                current += value                       # `vinte três` → 23
            else:
                return None                            # 结构不合法（如 `três vinte`）
        previous_was_connector = False
    if seen is False:
        return None
    return total + current


def canonicalize_number_words(text):
    """把葡语的数字词换成阿拉伯数字（`vinte anos` → `20 anos`）。

    只替换**整段都是数字词**（中间最多夹一个合法的 `e`）的连续片段；
    任何一段解析不出来就**原样保留** —— 宁可不算，也不猜。

    ⚠️ 单个乘数词（`milhões`）**紧跟在一个数字后面时不转换**：那是 `3 milhões` 这种
    "数字 + 单位"写法，交给 `canonicalize_numbers` 一起处理成 `3milhões`。
    不这么做的话 `3 milhões` 会变成 `3 1000000`，反而和 `3milhões` 对不上（实测踩过）。
    """
    tokens = str(text).split()
    out = []
    index = 0
    while index < len(tokens):
        if tokens[index] in PT_NUMBER_WORDS:
            end = index
            candidate = []
            while end < len(tokens) and (tokens[end] in PT_NUMBER_WORDS or tokens[end] == "e"):
                candidate.append(tokens[end])
                end += 1
            while candidate and candidate[-1] == "e":
                candidate.pop()
                end -= 1
            single_multiplier = (len(candidate) == 1
                                 and PT_NUMBER_WORDS[candidate[0]] >= 1000
                                 and out and out[-1].isdigit())
            value = portuguese_number_value(candidate) if candidate else None
            if value is not None and candidate and single_multiplier is False:
                out.append(str(value))
                index = end
                continue
        out.append(tokens[index])
        index += 1
    return " ".join(out)


def _word_punctuation(text):
    """葡语（按词）的标点处理：标点换空格，**但数字之间的 `.` 与 `,` 要留住**。

    ⚠️ 原来直接用 `_PUNCT_SPACE` 一刀切，`1.234,56` 会先被切成 `1 234 56`，
    后面再想规范化数字就没救了（实测：`1.234,56 reais` 变成 `1 234 56reais`）。
    留住的判据是"两侧都是数字"，所以句末的句号照旧变成空格。
    """
    out = []
    for index, char in enumerate(text):
        if char.isalnum() or char.isspace() or char == "'":
            out.append(char)
            continue
        if (char in ".," and 0 < index < len(text) - 1
                and text[index - 1].isdigit() and text[index + 1].isdigit()):
            out.append(char)
            continue
        out.append(" ")
    return "".join(out)


def canonicalize_numbers(text, unit_mode):
    """把"数值+单位"规范化成 `<数值><单位>`；认不出的写法**原样保留**。

    ⚠️ 只有**数值相等**才算同一个东西：`一 → 1` 等价，`一 → 9` 不等价
    （评审明确点出的那一条）。这条规则只统一"同一个值的两种写法"，
    所以它**不可能**把听错的数字洗成正确 —— 值不同就是不同。
    """
    raw = str(text)
    out = []
    index = 0
    length = len(raw)
    while index < length:
        char = raw[index]
        if char.isdigit():
            start = index
            while index < length and (raw[index].isdigit() or raw[index] in ".,"):
                index += 1
            token = raw[start:index].strip(".,")
            value = _arabic_value(token, unit_mode)
            multiplier = 1                                  # 3万 → 30000
            while index < length and raw[index] in _MULTIPLIERS:
                multiplier *= _MULTIPLIERS[raw[index]]
                index += 1
            unit, index = _match_unit(raw, index, unit_mode)
            if value is None:
                out.append(token + unit)
            else:
                out.append(_render(value * multiplier, unit_mode) + unit)
            continue
        if char in _CN_NUMERAL_CHARS:
            start = index
            while index < length and raw[index] in _CN_NUMERAL_CHARS:
                index += 1
            token = raw[start:index]
            value = chinese_numeral_value(token)
            unit, index = _match_unit(raw, index, unit_mode)
            out.append((_render(value, unit_mode) if value is not None else token) + unit)
            continue
        out.append(char)
        index += 1
    joined = "".join(out)
    return joined if unit_mode == "char" else " ".join(joined.split())


def to_simplified(text):
    """按 `VARIANT_TO_SIMPLIFIED` 转繁为简；**表外的字原样保留**。

    ⚠️ 这一条是评审点出来的 bug 的修法：原来只要"识别是繁体、参考不是"就算字形差异，
    于是 `我 → 國`（`國` 是繁体，但 `我` 根本不是 `国` 的简体）被当成"写法不同"洗掉了。
    现在必须**在表里成对出现**才算字形差异 —— 而表是照实测数据一条条写的。
    """
    return "".join(VARIANT_TO_SIMPLIFIED.get(char, char) for char in str(text))


def is_variant_pair(reference, hypothesis):
    """这两个字是不是**成对的**繁简对应字（表里查得到的才算）。"""
    if reference == hypothesis:
        return False
    return (VARIANT_TO_SIMPLIFIED.get(hypothesis) == reference
            or VARIANT_TO_SIMPLIFIED.get(reference) == hypothesis)


def collapse_consecutive_repeats(text, unit_mode):
    """折叠**紧挨着**的重复（口吃）：`就就就` → `就`。

    ⚠️ 这个规则**默认关闭**，因为它不安全，评审也说"仅对确认是口吃/填充的片段处理"：
      · 中文里 `看看` `说说` `试试` `慢慢` `好好` 都是**正常词**（动词重叠、程度叠用），
        折叠会把"漏了一个字"这种真错盖掉；
      · 葡语里 `muito muito` 也可能是真的强调。
    自动判不出"是口吃还是正常重叠"，所以它只能当**显式开关**用，
    并且在报告里说明"开了之后省掉多少"，而不是偷偷算进规范化分数。
    """
    if unit_mode == "char":
        out = []
        for char in text:
            if out and out[-1] == char:
                continue
            out.append(char)
        return "".join(out)
    words = text.split()
    return " ".join(word for index, word in enumerate(words)
                    if index == 0 or word != words[index - 1])


def normalize_for_scoring(text, unit="word", drop_interjections=False, collapse_repeats=False):
    """v2 规范化口径的归一化（`asr-norm-v1`）。规则见本段开头的清单。

    顺序很重要：**先把单位并到数字上、再规范化数字、最后才按单位做标点处理** ——
    反过来小数点和千分位逗号会先被标点规则吃掉（`3.5` 变成 `35`）。
    """
    value = str(text).lower().replace("’", "'")
    if unit == "char":
        value = canonicalize_numbers(value, "char")
        value = to_simplified(value)
        value = _PUNCT_DROP.sub("", value)
        if collapse_repeats:
            value = collapse_consecutive_repeats(value, "char")
        return value
    value = _word_punctuation(value)                    # 标点换空格（数字之间的 . 与 , 留住）
    value = " ".join(value.split())
    value = canonicalize_number_words(value)            # 葡语数字词 → 阿拉伯数字
    value = canonicalize_numbers(value, "word")
    value = to_simplified(value)
    if collapse_repeats:
        value = collapse_consecutive_repeats(value, "word")
    if drop_interjections:
        value = " ".join(word for word in value.split() if word not in INTERJECTIONS_ZH)
    return " ".join(value.split())


def normalized_error_rate(reference, hypothesis, unit="word", drop_interjections=False,
                          collapse_repeats=False):
    """按**规范化口径**给一条样本打分（与严格口径同一套对齐算法，只是比较文本不同）。"""
    def normalizer(text, mode):
        return normalize_for_scoring(text, mode,
                                     drop_interjections=drop_interjections,
                                     collapse_repeats=collapse_repeats)

    return error_rate(reference, hypothesis, unit, normalizer=normalizer)


# ── 关键内容检查（评审要求：专名单独查、数字核对值与单位、否定结合上下文）──────

NEGATIONS_ZH = ("不", "没", "未", "别", "无", "非", "莫", "勿", "甭")
NEGATIONS_PT = ("não", "nao", "nunca", "nenhum", "nenhuma", "nada", "ninguém",
                "ninguem", "sem", "jamais", "tampouco")


def numeric_items(text, unit="char"):
    """抽出文本里的"数值+单位"清单 —— 用来核对**值**与**单位**有没有变。

    ⚠️ 预处理必须与规范化口径**一模一样**（繁简转换 + 同一个数字规范化函数）：
       否则会出现自相矛盾的结果 —— 规范化说"这两句等价"，关键内容检查说"数字丢了"。
       实测就踩到过：参考「一点」对识别「一點」，繁简没转 → 单位匹配不上 → 误报数字丢失。
    """
    canonical = canonicalize_numbers(to_simplified(str(text)), unit)
    items = []
    pattern = r"\d+(?:\.\d+)?"
    units = set(UNITS_ZH) | set(UNITS_PT)
    for match in re.finditer(pattern, canonical):
        tail = canonical[match.end():]
        unit_text = ""
        for candidate in sorted(units, key=len, reverse=True):
            if tail.startswith(candidate):
                unit_text = candidate
                break
        # ⚠️ **光秃秃的一位数不算"关键数字"**：中文里 `一` 单独出现多半是"一些/一样/一死"
        #    这类用法，把它当成数字会让关键内容检查满屏误报（实测：中文口语 134 个数字里
        #    有一批是这种）。带单位（`1个`）或本身是多位数（`802`）才算。
        #    这是**关键内容检查**的提取规则，不是评分规则 —— 评分那边一个单位都不许少算。
        if unit_text == "" and len(match.group(0)) == 1:
            continue
        items.append((match.group(0), unit_text))
    return items


def numeric_report(reference, hypothesis, unit="char"):
    """参考里的数字（值+单位）在识别输出里还在不在。

    ⚠️ 这是**关键内容检查**，不是错误率：它回答"数字有没有丢/被改值"，
    与"整体错了几个字"是两件事。评审要求"数字要核对值与单位"。
    """
    from collections import Counter

    wanted = Counter(numeric_items(reference, unit))
    got = Counter(numeric_items(hypothesis, unit))
    rows = []
    for item, count in wanted.items():
        hit = min(count, got.get(item, 0))
        rows.append({"value": item[0], "unit": item[1], "count": count, "hit": hit,
                     "ok": hit >= count})
    return rows


def negation_flags(text, unit="char"):
    """文本里出现的否定词（供"否定被漏掉"这一类检查用）。

    ⚠️ 这里**只做出现性检查，不做极性推理** —— 评审说得对：极性要结合上下文，
    自动判"否定有没有被听懂"会误报（`不是不行`、`未必不`）。所以只报
    "参考里有否定、识别里没有"这种**需要人看一眼**的样本，不下结论。
    """
    if unit == "char":
        return {word for word in NEGATIONS_ZH if word in str(text)}
    lowered = f" {str(text).lower()} "
    return {word for word in NEGATIONS_PT if f" {word} " in lowered}
