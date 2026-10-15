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
| `asr_score.py` | **评分规则本身**（`asr-score-v1`）：归一化、S/D/I、整体错误率、逐项对齐 | 被 import，不单独跑 |
| `asr_error_analysis.py` | **错在什么上**：把每一处删除/替换按来源分类 | `python asr-eval/asr_error_analysis.py <结果.json>` |
| `segment_eval.py` | **切句基准**：量"停顿多久算说完一句"（用的是产线那个分段器） | `python asr-eval/segment_eval.py --set var/asr-eval/packs/zh-eval --pauses` |

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
node asr-eval/test-asr.mjs --set zh-speech-dev --model large-v3 --language zh --count 0

# ④ 看"错在什么上"（整体错误率只说错得多不多，说不出错在哪）
python asr-eval/asr_error_analysis.py var/asr-eval/results/zh-speech-dev__large-v3_cuda_float16.json
```

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
