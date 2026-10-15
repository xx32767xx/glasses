# asr-eval/ —— 识别评测这一层

> 这里回答的唯一问题是：**识别得准不准，准到什么程度。**
> 与"跑起来能不能用"（`bridge/` 产线、`scripts/start-all.mjs`）是两件不同的事，
> 所以代码与数据都单独放，不和产线混在一起。

## 这一层里有什么

| 文件 | 干什么 | 怎么跑 |
|---|---|---|
| `test-asr.mjs` | **入口**：选模型跑一轮、多模型对照、按口音分组、结果留存 | `node asr-eval/test-asr.mjs --list` |
| `asr_pack.py` | **切测试包**：从公开语料切出固定、可复现、可审计的测试包；查切分卫生 | `python asr-eval/asr_pack.py --list` |
| `asr_eval.py` | **跑一次评测**：加载模型、逐条识别、算错误率与延迟 | 一般由 `test-asr.mjs` 调；也可直接跑（参数更多） |
| `asr_score.py` | **评分规则本身**：严格口径 `asr-score-v1` + 规范化口径 `asr-norm-v1` | 被 import，不单独跑 |
| `asr_error_analysis.py` | **两套口径对照 + 错因归因 + 关键内容检查 + 抽查** | `python asr-eval/asr_error_analysis.py <结果.json>` / `--table` |
| `segment_eval.py` | **切句基准**：量"停顿多久算说完一句"（用的是产线那个分段器） | `python asr-eval/segment_eval.py --set var/asr-eval/packs/zh-eval --pauses` |
| `context_eval.py` | **切句代价**：同一段音频「整段 / 逐句切 / 产线切句」三种喂法对照；带 **`--sweep` 参数扫描** | `python asr-eval/context_eval.py --count 20 --model large-v3 --sweep 500/15000,800/30000,1200/30000,2000/30000 --out-md var/asr-eval/reports/context-eval-sweep-dev.md` |
| `context_overlap.py` | **上下文能不能白拿**：文本续传（提示词）vs 声学重叠（前后邻窗口），逐段配对比较 + 拼接分歧 + 提示词借用量 | `python asr-eval/context_overlap.py --spans-file var/asr-eval/spans/context-dev-20.json --model large-v3 --out-md var/asr-eval/reports/context-overlap-dev.md` |

数据不在这个目录里（`var/` 整个不进版本库），对应关系是一一对应的：

```
asr-eval/                      ← 代码
var/asr-eval/packs/<包名>/      ← 切出来的测试包（manifest.jsonl + pack.json + key-candidates.jsonl + wav）
var/asr-eval/results/<包名>__<模型>_<设备>_<精度>.json   ← 每一轮的评测结果
```

## 三件必须知道的事

### 1. 依赖方向是**单向**的：评测 → 产线，反过来不行

评测层会 import `bridge/` 里的东西，而且是**有意**的：

- `from whisper_stream import UtteranceSegmenter` —— 量的必须是**产线那个分段器本身**，
  复制一份就等于"测的是另一个东西"；
- `from whisper_transcribe import TARGET_RATE, decode_with_av` —— 采样率与解码器要和产线同源。

但 `bridge/` **永远不许** import 这一层。反了就意味着产线跑起来要带着测量工具，
改测试代码会影响产线行为 —— 这类问题人不会每次都去读 5 个文件的 import，
所以有断言在查：`tests/asr-pack-suite.mjs` 的「依赖方向」那一节。

### 2. 数据为什么单独一层（不在 `var/audio`，也不在 `var/logs`）

`lib/paths.mjs` 的分层原则是"按**能不能随便删**分"。识别评测的数据两条都不符合：

| 数据 | 性质 | 原来放哪 | 问题 |
|---|---|---|---|
| 测试包 | 能一键重建，但要几十分钟机器时间 | `var/audio/` | 和"手机上传的原始音频"混在一起，分不清哪个能删 |
| 结果 json | **能复用的测量结果**（`--compare` 拿历史结果拼表） | `var/logs/` | 和"随便删"的日志混在一起 —— 想清日志时不敢删 |

现在它们是 `var/asr-eval/` 一层。⚠️ 这也意味着：**清 `var/logs/` 不会带走评测结果**，
但**删 `var/asr-eval/` 就是真的丢了测量凭据**（测试包可以用
`python asr-eval/asr_pack.py --build all` 重建，结果只能重跑）。

### 3. 一个样本量一个结果文件名（小批不许覆盖完整基线）

```
完整跑（--count 0）  zh-speech-dev__large-v3_cuda_float16.json      ← --compare 只读这种
小批跑（--count 2）  zh-speech-dev-n2__large-v3_cuda_float16.json
```

⚠️ 这条是**踩出来的**：`--count 2` 曾经写到与完整基线同一个文件名上，
238 KB 的 304 条基线被 2.8 KB 的 2 条结果覆盖，而文件名上没有任何区别。
`tests/asr-pack-suite.mjs` 里有断言钉住它。

## 典型流程

```powershell
# ① 看有哪些包、本地语料在哪（不写盘）
python asr-eval/asr_pack.py --list

# ② 切包（删了不心疼：种子固定，会切出同一份）
python asr-eval/asr_pack.py --build all
python asr-eval/asr_pack.py --verify        # 查切分卫生 + 覆盖率

# ③ 跑一轮基线（产品场景是"口语"，调参也应该在口语包上做）
#    这一跑会**同时**算出两套口径的分数：严格 asr-score-v1 与规范化 asr-norm-v1
node asr-eval/test-asr.mjs --set zh-speech-dev --model large-v3 --language zh --count 0

# ④ 看"错在什么上"（整体错误率只说错得多不多，说不出错在哪）
python asr-eval/asr_error_analysis.py var/asr-eval/results/zh-speech-dev__large-v3_cuda_float16.json

# ⑤ 把所有已存结果的两套口径排成一张表（不重跑模型，读结果文件重算）
python asr-eval/asr_error_analysis.py --table

# ⑥ 抽查"被归成写法差异"的差异，确认没有把关键错误掩盖掉
python asr-eval/asr_error_analysis.py var/asr-eval/results/zh-speech-dev__large-v3_cuda_float16.json `
  --samples 12 --bucket 拉丁

# ⑦ 只看有问题的那些（不重跑模型，从已存结果筛）：写成清单文件，照着音频听
python asr-eval/asr_error_analysis.py var/asr-eval/results/zh-speech-dev__large-v3_cuda_float16.json `
  --errors-above 0.10 --errors-file var/asr-eval/reports/zh-speech-dev-errors.txt

# ⑧ 切句代价 + 切句参数扫描（同一批段、同一个参考，只改「怎么切」）
#    段清单会固化到 var/asr-eval/spans/，下次跑**复用同一批**（否则两次数字不可比）
python asr-eval/context_eval.py --count 20 --model large-v3 --device cuda `
  --sweep 500/15000,800/30000,1200/30000,2000/30000 `
  --spans-file var/asr-eval/spans/context-dev-20.json `
  --out-json var/asr-eval/results/context_eval_sweep__dev__large-v3.json `
  --out-md   var/asr-eval/reports/context-eval-sweep-dev.md
```

### 切句代价实验：可重复 + 可读

`context_eval.py` 的产物都是**留着给人看的**，不是只打屏：

| 产物 | 是什么 |
|---|---|
| `var/asr-eval/spans/context-<split>-<count>.json` | **固化的段清单**（含每句时间戳与文本）。存在就复用，指纹会打进报告 —— 参数扫描必须同一批段，否则数字不可比 |
| `var/asr-eval/results/context_eval_sweep__*.json` | 结构化结果：每个喂法每段的文本、S/D/I、段数、覆盖、耗时 |
| `var/asr-eval/reports/context-eval-sweep-*.md` | **人读报告**：汇总表 + 取舍表 + 逐段明细 + 每段原文与各喂法输出 + **重跑命令**

### 问题样本清单（找"哪几条坏了"用这个，不要用"随机看"）

跑 `test-asr.mjs` 时**默认就会给**（阈值 0.10，与"好的句子 ≤10%"同一判据）：

- 日志里每条**首行以 `ERROR` 开头** → `Select-String ERROR` / `grep ^ERROR` 直接筛出来；
- 同时写到 `<结果>.errors.txt`（与结果 json 同名），不用重跑就能看；
- 每条带**音频完整路径**、时长、错误率、S/D/I、以及具体差异：
  `漏X` = 漏字、`多X` = 多字、`A→B` = 听成 B；
- **最差的排最前** —— 排查先看最坏的几条。

```powershell
# 只列错误率 > 20% 的；想全列就把它设成 0（默认 0.10）
node asr-eval/test-asr.mjs --set zh-speech-dev --errors-above 0.2
```

> 原来的报告只有"随机看 N 条对照"—— **随机看对排查没有用**（多半是好的）。
> 这个清单是用户提出来的，改法也按他要的来：日志里能一眼筛。

### 两套评分口径（**必须并列读，不许相减**）

| 口径 | 版本 | 规则 | 用途 |
|---|---|---|---|
| 严格 | `asr-score-v1` | 标点/大小写/空白归一，其余都算错 | **与历史结果可比** |
| 规范化 | `asr-norm-v1` | 只统一"同一个东西的写法"：标点 + **成对**繁简 + **数值与单位等价**的数字写法 | 减少确定的写法差异干扰 |

⚠️ **规范化分数是"换文本重新对齐算出来的"，不是"从严格分里扣掉几个分类桶"。**
这一条是评审明确要求的，也是这个仓库返工过的地方：曾经输出过
"真正要追的声学错误 ≈ 整体错误率 − 写法差异"，那个数**已撤**
（它既不是严格分也不是规范分，却看起来像个分数）。
`tests/python-suite.py` 里有断言钉住这个性质。

⚠️ 两条口径的**分母可能不同**（规范化会把 `3 milhões` 并成一个单位），
所以差值可能为负 —— 那不是"规范化更糟"，是单位数变了。`--table` 会把两边的单位数打出来。

⚠️ 规范化里**默认不做**的事：不删「那个/就是/然后」、不把葡语 `é/sei/cê` 当无信息、
不删感叹词（要开加 `--norm-interjections`）、不折叠重复（`看看/说说` 是正常词，
要开加 `--norm-collapse-repeats`）、不动人名/型号/金额/否定词。

### 归因是**线索**，不是分数

`asr_error_analysis.py` 的错因桶（数字写法 / 繁简对应字 / 高频虚词 / 拉丁字母…）
**只用来找线索**，脚本会把这句话打在每个报告末尾。每个桶都有**验证条件**：

- 数字写法：必须**规范化后逐字相等**（`一→1` ✓、`一→9` ✗）
- 繁简对应字：必须**两字在表里成对**（`后→後` ✓、`我→國` ✗）
- 拉丁字母/数字的删除：标着「**需听音频**」—— 产品型号、金额可能真的被漏掉，
  实测抽查就抓到 `S C P→SAC`、`四S店→4A` 这类真错

别处切好的包（另一台机器、另一块盘、临时实验）不必拷进来：
`node asr-eval/test-asr.mjs --set-path <目录>` 直接指定，结果文件名取目录名。

## 规矩写在哪些文档里

| 想要什么 | 看哪份 |
|---|---|
| 完整的评测规程（怎么切、怎么跑、评分标准、实测结果） | [`../docs/14-识别评测规程.md`](../docs/14-识别评测规程.md) |
| 识别模型选型、每句延迟、三个测速度的坑 | [`../docs/04-语音识别验证.md`](../docs/04-语音识别验证.md) |
| 准确性现状（写给老师的那份） | [`../docs/13-准确性现状与求助.md`](../docs/13-准确性现状与求助.md) |
| 数据目录规矩（哪些能删、什么放在哪） | [`../docs/05-数据通路.md`](../docs/05-数据通路.md)、[`../lib/paths.mjs`](../lib/paths.mjs) |

## 许可

测试包与语料都在 `var/` 里，**不进仓库、不再分发**：
MagicData-RAMC 与 CORAA 是 CC BY-NC-ND，本项目已确认**非商用**，按非商用研究评测使用。
仓库里只放生成脚本（`asr_pack.py`）与说明，不放音频。
