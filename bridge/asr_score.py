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


def align(reference, hypothesis, unit="word"):
    """返回 (替换, 删除, 插入)。

    约定（相对参考）：
      · 替换：参考里有一个、识别里换成了别的
      · 删除：参考里有、识别里**没有**（漏字/漏词）
      · 插入：识别里多出来的（多字/多词、重复）
    老师要的"含替换／删除／插入"就是这三项。

    ⚠️ 这里**只是把 align_ops 的结果数出来** —— 两套实现各算一遍是危险的：
       "总数对得上、S/D/I 分配不一样"会让报告里的三项悄悄漂移。
    """
    ops = align_ops(reference, hypothesis, unit)
    subs = sum(1 for op in ops if op[0] == "S")
    dels = sum(1 for op in ops if op[0] == "D")
    inss = sum(1 for op in ops if op[0] == "I")
    return subs, dels, inss


def align_ops(reference, hypothesis, unit="word"):
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
        ref = list(normalize(reference, "char"))
        hyp = list(normalize(hypothesis, "char"))
    else:
        ref = normalize(reference, "word").split()
        hyp = normalize(hypothesis, "word").split()

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


def error_rate(reference, hypothesis, unit="word"):
    """返回一条样本的评分。

    字段名与 asr_eval 原来的输出保持兼容（rate / units / distance），
    并补上 s / d / i 三项。
    """
    subs, dels, inss = align(reference, hypothesis, unit)
    if unit == "char":
        units = len(list(normalize(reference, "char")))
    else:
        units = len(normalize(reference, "word").split())
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
