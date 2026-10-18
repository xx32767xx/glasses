# asr-eval/ —— 识别评测这一层

> 这里回答的唯一问题是：**识别得准不准，准到什么程度。**
> 与"跑起来能不能用"（`bridge/` 产线、`scripts/start-all.mjs`）是两件不同的事，
> 所以代码与数据都单独放，不和产线混在一起。

## 一个入口，三种用法

```powershell
node asr-eval/test-asr.mjs --list                    # 看有哪些包、哪些模型、哪些段清单
node asr-eval/test-asr.mjs --set zh-speech-dev --model large-v3 --language zh --count 0
node asr-eval/test-asr.mjs --cut --count 20 --sweep 500/15000,800/30000,1200/30000
node asr-eval/test-asr.mjs --context                 # 缺省只跑 C1,T2
node asr-eval/test-asr.mjs --context --modes all     # 全部五种喂法
```

| 用法 | 回答什么问题 | 样本来源 |
|---|---|---|
| `--set <包>` | **这个模型在这个包上多准**（模型横评、`--compare`、`--by-accent`） | 冻结的测试包（一条条独立片段） |
| `--cut` | **切句本身吃掉多少准确率**；`--sweep` 扫 `silence_ms` 看"少切一点"值不值 | 原始录音里的**连续段**（固化的段清单） |
| `--context` | **上下文能不能白拿**：提示词续传 vs 左邻/右邻声学重叠；`--modes` 决定跑哪几种 | 同上 |

⚠️ **为什么入口统一、引擎分开**（不是把三个逻辑塞进一个脚本）：
`--set` 那个包**不能**给两个实验用 —— 包里是一条条互不相邻的片段（每场录音只抽十几条），
把它们当"整段"喂进去时，音频里会混进参考文本**没覆盖**的别人的话，
§6.7 那个对照的公平性前提就破了。所以两边**样本来源不同**、**比较基准也不同**
（包比的是不同模型；实验比的是同一段音频的不同切法/喂法）。
入口只做三件事：**拼命令、统一产物路径、把产物指给你**；判据与参数说明在各引擎的 `--help` 里。

**两个实验的产物（都可反复使用）：**

| 产物 | 位置 |
|---|---|
| 固化的段清单 | `var/asr-eval/spans/context-<split>-<N>.json`（含逐句时间戳与文本 + 指纹） |
| 结构化结果 | `var/asr-eval/results/<实验>__<段清单名>__<模型>.json` |
| 人读报告 | `var/asr-eval/reports/<实验>__<段清单名>__<模型>.md`（含**完整重跑命令**） |

`--cut` 会给 `--out-json` / `--out-md` 填默认路径，也可以自己指定。
`--context` 若不给 `--spans-file`，会自动用 `var/asr-eval/spans/` 里**最新**的那一份
（报告里记指纹，所以"用了哪一批段"永远不含糊）。

### `--context` 不是"一种上下文方式"，是**五种喂法挑着跑做对照**

```powershell
node asr-eval/test-asr.mjs --context                  # 缺省只跑 C1,T2（现状 vs 已选定方案）
node asr-eval/test-asr.mjs --context --modes T1,T2    # 想换对照组就直接写代号
node asr-eval/test-asr.mjs --context --modes all      # 全部五种
```

一次运行在**同一批段、同一个参考、其余解码参数完全一致**的前提下比较这五种喂法：

| 代号 | 喂法 | 上下文是怎么给的 | 要多等吗 |
|---|---|---|---|
| `C1` | 逐段独立解码 | **不给**（＝产线现状） | 否 |
| `T1` | 逐段 + 提示词（上一段文本） | **文本续传**（`initial_prompt`） | 否 |
| `T2` | 逐段 + 提示词（前两段文本） | 文本续传，喂得更多 | 否 |
| `L` | 左邻重叠（窗口 = 上段 + 本段，只取本段） | **声学重叠**（多喂一段音频） | 否 |
| `R` | 右邻重叠（窗口 = 本段 + 下段，只取本段） | 声学重叠（提前拿下一段） | **是**（多等一段） |

**为什么缺省只有 `C1,T2`**：每一种喂法都要把整批段识别一遍，而 `T1`/`L`/`R` 在
docs/14 §6.7.2 里已经被否掉了（文本续传赢过重叠，右邻还要多等）——
**复核一个已经定下来的结论，不该每次付五遍算力**。要完整对照就显式 `--modes all`。

**三条不会让你误读的保证：**

| 保证 | 落在哪 |
|---|---|
| 只跑了一部分就**不许叫完整对照的名字** | 只跑一部分 → `context_overlap-C1T2__…json`；五种全跑 → `context_overlap__…json`（老名字） |
| 报告与 JSON 里都写明跑了哪几种、**没跑哪几种**、怎么跑全部 | 报告开头三行 + `config.modesRun` / `modesSkipped` |
| 代号写错**当场报错**，不许悄悄跑成缺省那两种 | `--modes T9` → 直接退出并列出可选代号 |

⚠️ 没选 `C1` 时会**自动补上**：它是所有比较的基线（`vs C1` 那一列与逐段配对都靠它），
报告里会写明"已自动加入"。真正**上产线**的开关不在这个实验里，而是 `--cut --prompt-depth N`。

## 参数速查（哪些写进文档、哪些只在自己 `--help` 里）

### `--count` 一个名字、三种含义（**最容易误读的一个参数**）

| 什么时候 | `--count N` 是什么意思 | 缺省 | 注意 |
|---|---|---|---|
| `--set <包>` | 只测**前 N 条**样本；`0` = 全量 | 30 | `--count 2` 的结果文件名会带 `-nN` 后缀，**不会覆盖**全量基线 |
| `--cut` | 从原始录音里**挑 N 段连续发言**并固化段清单 | 12 | 与 `--spans-file` 的优先级：显式给了段清单就用它、否则才按 `--count` 挑新的。**不能反过来**，否则 `--cut --count 30` 会悄悄只跑已有的 20 段 |
| `--context` | **不接受**这个参数（它必须在已有段清单上跑） | — | 段数由段清单决定；只想试几段用 `--limit N` |

### `--modes`：上下文实验跑哪几种喂法（`--context` 专用）

| 写法 | 跑哪几种 | 产物名 |
|---|---|---|
| 不写 | `C1,T2`（**缺省，不是全部五种**） | `context_overlap-C1T2__…` |
| `--modes C1,T2` | 现状 + 前两段文本续传 | `context_overlap-C1T2__…` |
| `--modes T1,T2,L` | 任意组合（顺序随便写，代号固定） | `context_overlap-C1T1T2L__…` |
| `--modes all` | 全部五种 | `context_overlap__…`（与历史完整结果同名） |
| `--context C1,T2` | 与 `--modes` 等价（省得写两遍），只认**整个**参数长得像代号列表时 | 同上 |

- 代号写错（`T9`）**当场报错**；`--modes` 配 `--cut` 也报错（那个引擎没有这个参数）。
- 没选 `C1` 时自动补上（它是基线），产物名按**实际会跑的**那几种写。

### `--sweep`：`静音时长/句子上限`，逗号分隔多档

```powershell
--sweep 500/15000,800/30000,1200/30000     # 三档：静音 500ms、800ms、1200ms
```

- 一个点就是**一档产线切句参数**：斜杠**前**是 `silence_ms`（停顿超过这个毫秒数就断句），
  斜杠**后**是 `max_speech_ms`（一句话最多多长，超了强制断）。
- 不写斜杠（`--sweep 500,1200`）→ 上限用产线缺省的 **15000ms**。
- 为什么有的档写成 `/30000`：`silence 500` 那档段数多、段内句子少，上限用不到；
  把静音调大以后一段里会装进更多话，**必须同时抬高上限**，否则会被 15 秒硬切断 ——
  那就不是在比"少切一点"，而是在比"被强制截断"。所以 800/1200/2000 三档都写了 `/30000`。
- 每一档都会跑 A（整段）与 C（产线切句）两组对照，所以扫描**越宽越慢**；
  只想复核某一档就写成 `--sweep 1200/30000` 单档。

### 其余参数

| 参数 | 缺省 | 管什么 |
|---|---|---|
| `--list` | — | 只列有什么（包、模型、段清单），不跑模型、不写盘 |
| `--set <包>` / `--set-path <目录>` | — | 用哪个冻结测试包（目录里要有 `manifest.jsonl`） |
| `--model` / `--device` / `--compute-type` | `large-v3` / `cuda` / `float16` | 跑哪个模型、在哪跑、什么精度 |
| `--language` | `zh`（实验）/ 自动限定候选（`--set`） | 固定语种。实验里**必须**固定，否则量的不是切句效果 |
| `--compare` | 关 | 拿 `var/asr-eval/results/` 里**已存结果**拼模型横评表（**不重跑模型**） |
| `--by-accent` | 关 | 按口音分组（CORAA 独有：SP2010 / NURC-Recife…） |
| `--errors-above <值>` | `0.10` | 错误率高于它的样本全部列出（首行以 `ERROR` 开头，好筛）；`1.1` = 关 |
| `--hotwords "<词 词>"` | 关 | 热词（空格分隔）。⚠️ **实测在本项目场景里无效且有副作用**（专名命中只 +2/60、口语包删除 +38），所以**没接产线**；产物名自动带 `-hw`，不会覆盖基线 |
| `--prompt-depth N` | `0` | **产线已采用的旋钮**：把前 N 段的最终文本当提示词喂回去（`2` = 前两段） |
| `--prod-hint` | 关 | 每种喂法都先缀上**产线那句语种提示词**（配合 `--no-vad-filter` 就等于产线的解码条件）—— 上产线前的复核实验用它 |
| `--modes <代号\|all>` | `C1,T2` | `--context` 跑哪几种喂法（见上一节）；`all` = 五种全跑 |
| `--skip-b` | 关 | `--cut` 里跳过 B（官方句边界）那一路，扫第二轮时省时间 |
| `--spans-file <路径>` | — | 指定用哪份段清单；给了它 `--count` 就不再挑新段 |
| `--refresh-spans` | 关 | 忽略已有段清单重新挑（会覆盖同名文件） |
| `--limit N` | `0`（全跑） | 只跑前 N 段做冒烟测试；**段清单本身不动**，产物名会带 `-nN`（不许冒充完整结果） |
| `--show N` | `2` | 打印几段的详细对照（每段的原文与各喂法输出） |
| `--out-json` / `--out-md` | 自动 | 结构化结果 / 人读报告写到哪（不给就按 `<实验>[后缀]__<段清单>__<模型>` 自动命名） |

⚠️ 参数写错**必须报错**，不许静默忽略 —— 这是本仓库的老规矩：
`--decode-json` 里写错参数名会明确报错，因为"我调了那个参数"变成空话的后果，
是整批结论建立在没生效的配置上。

### 葡语那一侧：**先重建连续音频，再走同样的两个引擎**（代理已作废）

`--cut` / `--context` 都要求**一段连续录音 + 官方逐句时间戳**（否则参考文本盖不住音频，
公平性前提就破了）。中文有（MagicData 留了原始 31 分钟录音）；葡语一开始**没有** ——
CORAA 只有一句一条的片段、没有时间戳、没有场次编号，所以早期只能做代理实验。

**2025 找到了缺的那两样**：`E:\CORAA NURC-SP Minimal Corpus`（Projeto NURC/SP，1972 年
圣保罗的 21 场真实对话，13 小时语音）每一段都带**原始录音时间轴上的 start/end**。
于是 `pt_nurc_spans.py` 把这些片段按时间轴拼回连续音频（空档补静音），产出与中文
**完全同格式**的段清单，然后直接喂给同一个 `context_eval.py` / `context_overlap.py`
（`--wav-dir` 指定重建音频、`--unit word` 按词算 WER）。

```
python asr-eval/pt_nurc_spans.py --count 20 --target-seconds 25 --recordings SP_D2_255
python asr-eval/context_eval.py --spans-file var/asr-eval/spans/nurc-pt-20.json `
  --wav-dir var/asr-eval/audio/nurc-pt --unit word --language pt `
  --sweep 500/15000,800/30000,1200/30000 --prompt-depth 2
```

⚠️ 重建的三条边界（写进脚本头部，也必须和数字一起读）：段间空档补的是**数字静音**
（噪声底低于真实录音）；整场覆盖率 74.6%（逐场 41%~92%）；**1972 年的录音**。
所以它适合量「切句代价 / 上下文收益」，不适合拿 `--silence-ms` 的绝对值代表现场。

🔴 **`pt_context_proxy.py` 因此作废**（留作反面教材）：它在葡语上给出过
"续传 −2.2 个百分点"的收益，而真实连续对话上是 **+0.1~+1.0（噪声到略负）**。
原因很实在：代理里"相邻"的是**不同人**的话，不会把模型带偏；真实对话里上文是
**同一个人刚说过的话**，续传反而把模型带向重复（替换 55 → 71）。
**这就是"代理只能当方向性检查"的代价。**

## 这一层里有什么

| 文件 | 干什么 | 怎么跑 |
|---|---|---|
| `test-asr.mjs` | **入口**：模型横评 / 切句实验 / 上下文实验（见上表） | `node asr-eval/test-asr.mjs --list` |
| `asr_pack.py` | **切测试包**：从公开语料切出固定、可复现、可审计的测试包；查切分卫生 | `python asr-eval/asr_pack.py --list` |
| `asr_eval.py` | **跑一次评测**：加载模型、逐条识别、算错误率与延迟 | 由 `test-asr.mjs --set` 调；也可直接跑（参数更多） |
| `asr_score.py` | **评分规则本身**：严格口径 `asr-score-v1` + 规范化口径 `asr-norm-v1` | 被 import，不单独跑 |
| `asr_error_analysis.py` | **两套口径对照 + 错因归因 + 关键内容检查 + 抽查** | `python asr-eval/asr_error_analysis.py <结果.json>` / `--table` |
| `segment_eval.py` | **切句基准**：量"停顿多久算说完一句"（用的是产线那个分段器） | `python asr-eval/segment_eval.py --set var/asr-eval/packs/zh-eval --pauses` |
| `context_eval.py` | **切句代价引擎**：整段 / 逐句切 / 产线切句参数扫描 | 由 `test-asr.mjs --cut` 调 |
| `context_overlap.py` | **上下文引擎**：提示词续传 vs 左邻/右邻重叠，逐段配对 + 拼接分歧 | 由 `test-asr.mjs --context` 调 |
| `pt_context_proxy.py` | 🔴 **葡语代理实验（结论已被真数据推翻，留作反面教材）**：只测"提示词续传在葡语短片段上有没有用" | `python asr-eval/pt_context_proxy.py --groups 10` |
| `pt_nurc_spans.py` | **葡语真数据**：从 CORAA **NURC-SP** 把逐句片段按原始时间轴拼回**连续发言**，挑出与中文实验同格式的段清单（`--list` 先体检） | `python asr-eval/pt_nurc_spans.py --count 20 --target-seconds 25` |
| `carry_attribution.py` | **归因**：上下文续传为什么帮忙/帮倒忙 —— 按「句内位置 × 误差方向(S/D/I)」拆，并统计"抄上文"比例（只读已存结果，不重跑模型） | `python asr-eval/carry_attribution.py --kinds` |

数据不在这个目录里（`var/` 整个不进版本库），对应关系是一一对应的：

```
asr-eval/                      ← 代码
var/asr-eval/packs/<包名>/      ← 切出来的测试包（manifest.jsonl + pack.json + key-candidates.jsonl + wav）
var/asr-eval/results/<包名>__<模型>_<设备>_<精度>.json   ← 每一轮的评测结果
```

### 三个实验脚本各自回答什么问题（**这是最容易混的一节**）

这三个是这一轮新加的，它们**不是**"同一件事的三种写法"，问的问题完全不同：

| 脚本 | 一句话：它回答什么 | 输入从哪来 | 产物 | 怎么跑 |
|---|---|---|---|---|
| `context_eval.py` | **切句本身吃掉多少准确率**：同一段录音，整段识别（11.7%）vs 按官方句边界切（15.6%）vs 按产线参数切（16.8%）—— 差的那几个点就是"切碎"的代价；`--sweep` 再多问一句"少切一点值不值" | MagicData **原始 31 分钟录音** + 官方逐句时间戳；**连续段**是它自己按 `--count / --target-seconds / --min-gap` 挑的 | 段清单（`spans/context-dev-N.json`）+ 结果 json + 人读 md | `node asr-eval/test-asr.mjs --cut [--sweep …]` |
| `context_overlap.py` | **上下文该用哪种方式补**：文本续传（`T1/T2`）vs 声学重叠（`L/R`），并回答"重叠窗口拼接时两次输出不一致该怎么办"（逐段配对 + 拼接分歧 + 分歧时谁对） | **同一批段清单**（`--spans-file`，与 `context_eval.py` 共用同一批，否则两组数字不可比） | 结果 json + 人读 md（含逐段明细与重跑命令） | `node asr-eval/test-asr.mjs --context` |
| `pt_nurc_spans.py` | **葡语从哪拿到"连续录音"**：把 NURC-SP 的逐句片段按原始时间轴拼回连续段（空档补静音），产出与中文实验同格式的段清单 | CORAA **NURC-SP Minimal Corpus**（21 场 1972 年圣保罗对话，13 小时语音，有原始时间轴） | 段清单 `spans/nurc-pt-N.json` + 重建的 wav（16 kHz 单声道） | `python asr-eval/pt_nurc_spans.py --count 20` |
| `pt_context_proxy.py` | **葡语上"提示词续传"有没有用** —— 🔴 **代理，而且结论已经被上面的真数据推翻**。它把编号相邻的 8 条当成一段上文（其实是不同人的话），算出过 −2.2 个百分点的"收益"；真实连续对话上是 **+0.1~+1.0（噪声到略负）** | 冻结的葡语口语包 `pt-speech-dev`（一条条独立片段） | 结果 json（带 `proxy: true`） | `python asr-eval/pt_context_proxy.py --groups 10` |

**为什么它们不能合成一个脚本**（也不是把 `--set` 那个包塞进去就行）：

- **样本来源不同**：前两个要的是"**原始录音里的连续段**"（音频必须被参考文本完整覆盖，
  否则"整段"那一路会混进参考没覆盖的话，对照就不公平了）；而 `--set` 的包里是**互不相邻的独立片段**。
- **比较基准不同**：`--set` 比的是"不同模型"；两个实验比的是"同一段音频的不同切法 / 不同喂法"。
- 所以入口只做三件事：**拼命令、统一产物路径、把产物指给你**；判据与参数留在各引擎自己的 `--help` 里。
- 葡语那批是**先重建音频、再走同样的两个引擎**（`--wav-dir` + `--unit word`），所以引擎不复制第二份。

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
