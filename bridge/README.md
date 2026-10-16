# asr-bridge —— harness 之外的那一半

`leion-pro` 插件负责「读收件箱 → 判语向 → 翻译 → 排版 → 上屏」；
**本桥负责「把语音识别结果按行追加到收件箱」**。

两边只共享一个约定：**一行一句话**。所以换 ASR 不用动插件，换眼镜不用动桥。

```
麦克风 ──► ASR（本桥的四种引擎之一）──► 收件箱文件（一行一句话）──► leion-pro ──► 眼镜
                                          ↑
                            插件用真实 timer 服务轮询这个文件
```

## 为什么需要「行装配器」而不是简单转发

ASR 的输出来得很碎：有的逐词打、有的用 `\r` 就地刷新同一行、有的只在句末换行。
如果直接转发，插件会收到半句话并把它翻出去——字幕就废了。

所以桥里有一个**行装配器**，它做三件事：

| 行为 | 为什么 |
|---|---|
| `\n` 和 `\r` 都当行结束 | 很多 ASR CLI 用 `\r` 在原地刷新同一行 |
| 空行、纯空白行丢掉 | 不往收件箱里塞空句 |
| **停顿即断句**（`--flush-on-pause-ms`） | ASR 不换行时，这是字幕唯一能出来的方式；这个值就是字幕的延迟上限 |

## 快速上手

```powershell
# 1) 演示：不需要麦克风、不需要 ASR —— 重放一段中葡对照的转写
node bridge/asr-bridge.mjs --inbox E:/GlassesHarness/var/demo/asr-inbox.jsonl `
  --engine replay --replay bridge/sample-transcript.txt --truncate

# 2) 任何会往 stdout 打字的 ASR（whisper.cpp / 云 SDK 的 CLI / 自写脚本）
whisper-cli -m ggml-small.bin -f audio.wav | node bridge/asr-bridge.mjs --inbox /tmp/asr-inbox.jsonl

# 3) ASR 不按句换行时，靠停顿断句（800ms 是口语里比较舒服的值）
node bridge/asr-bridge.mjs --inbox /tmp/asr-inbox.jsonl --engine command --command "python asr.py" --flush-on-pause-ms 800

# 4) 先看要写什么，不落盘
node bridge/asr-bridge.mjs --inbox /tmp/asr-inbox.jsonl --engine replay --replay bridge/sample-transcript.txt --dry-run
```

把 `--inbox` 的路径**填成插件 `config.inboxPath` 的同一个值**，同传就成立了。

## 引擎

| `--engine` | 从哪读 | 适合 |
|---|---|---|
| `stdin`（缺省） | 标准输入 | 管道：`<任意 ASR> \| node asr-bridge.mjs` |
| `command` | 子进程的 stdout | ASR 云 SDK 的 CLI、自写脚本 |
| `replay` | 一份录制好的转写文本，按节奏重放 | **演示与回归测试**（不需要麦克风） |
| `whisper` | `whisper_stream.py`（faster-whisper + 麦克风） | 纯本地、离线 |

`--engine whisper` 会自动拼出默认命令；`--from pt-BR` 会翻译成 `--language pt` 传给 Python 脚本。

## 收件箱的两种格式

```text
A reunião de hoje passou para as três da tarde.        ← text（缺省）：插件逐行自动判语向
{"text":"A reunião é às três.","from":"pt-BR","speaker":"them"}   ← json：带标记，更稳
```

`--format json` 配合 `--from` / `--to` / `--speaker` 使用；ASR 已经知道语种时用它，能避免插件自动判定出错。
（插件侧对应的配置项是 `inboxFrom`，效果一样。）

## 参数一览

| 参数 | 缺省 | 说明 |
|---|---|---|
| `--inbox <path>` | 必填 | 收件箱文件；要和插件 `config.inboxPath` 一致 |
| `--engine <name>` | `stdin` | 见上 |
| `--command <cmd>` | — | `command` 引擎要执行的命令 |
| `--replay <file>` | — | `replay` 引擎读的转写文本（一行一句） |
| `--replay-delay-ms <n>` | `1200` | replay 每行之间的间隔，模拟真人说话节奏 |
| `--format text\|json` | `text` | 收件箱行的格式 |
| `--from` / `--to` | — | 语种标记（`zh-CN` / `pt-BR`） |
| `--speaker` | — | `them`（对方）/ `me`（佩戴者） |
| `--flush-on-pause-ms <n>` | `0` | 停顿超过 n 毫秒就断句；`0` = 只在换行/回车断句 |
| `--truncate` | — | 开始时清空收件箱（演示时从干净的屏开始） |
| `--dry-run` | — | 只打印将要写入的行 |
| `--quiet` | — | 不打印统计 |

`node bridge/asr-bridge.mjs --help` 有同样的列表。

## 关于 `whisper_stream.py`

⚠️ **未在本机验证**：它需要 `pip install faster-whisper sounddevice numpy` 并下载模型，开发环境里没有装。
脚本本身很短、逻辑直白，但请把它当**起点**而不是已验证的实现。

```powershell
pip install faster-whisper sounddevice numpy
python bridge/whisper_stream.py --self-check          # 只检查依赖与模型能否加载
python bridge/whisper_stream.py --file audio.wav      # 转写文件（不需要麦克风）
python bridge/whisper_stream.py --language pt         # 固定巴西葡语：更准也更快
```

它的设计取舍：用**静音切分**（RMS + 静音时长）而不是流式解码——同传要的是整句，半句翻出去毫无意义，
而流式接口对短片段效果差。每识别出一句立刻 `print(..., flush=True)`，绝不缓冲多句。

**2025 年按口语实测改过三处**（依据与数字见 [`../docs/06`](../docs/06-收音策略.md)，那是产线侧的唯一权威表）：

| 参数 | 现值 | 一句话 |
|---|---|---|
| `--silence-ms` | **1200**（原 500） | 口语错误率 16.8% → 13.3%，代价是字幕平均晚 3.5 秒（可一键调回 800/500） |
| `--context-depth` | **2**（新增） | 把前两段**文字**喂回提示词当上下文：16.8% → 15.1%，**零额外延迟** |
| 语种提示词 | 中文**不发**（原缺省发） | 那句在真实口语上是负收益（304 条：多错 2.7~3.5 个点，只换 0.8 个点的繁体） |

⚠️ 这三项都是**用 `asr-eval/` 那套受控实验量出来的**，不是凭经验调的；
`--stats` 会把 `平均段长`、`字幕延迟（估算）`、`上下文续传：清空几次 / 复读拦了几段` 一起打出来。
⚠️ 但**都还没在真机上戴过**，其中"字幕晚 3.5 秒"这一条特别需要真机体验一次再定。

## 验证

桥有自己的契约套件（19 项），包含在总验证里：

```powershell
node tests/run-all.mjs        # 83 项，其中「ASR 桥」一节就是它
```

覆盖：`\n` / `\r` / `\r\n` 断句、空白与多余空白的处理、**停顿即断句**（用可控时钟测，不靠 sleep 赌时间）、
`flush()` 送出尾部、UTF-8 重音、JSON 格式合法性、句内换行被压平（防止一句话被撑成多行）、
`truncate` / `dry-run`、非法标记被响亮拒绝、参数解析报错、以及 replay 端到端。

另外 `tests/live/` 的真实 Cordis 组合里有一条**真端到端**：桥写行 → 收件箱 → 真实 timer 轮询 →
真实执行流水线翻译 → 已处理 2 条、错误 0 条。

## 一个环境注意事项

`--engine command` / `--engine whisper` 需要**捕获子进程的 stdout**，那要用管道。
在 DSH 的文件沙箱里这类 spawn 会被拦（EPERM）。所以桥要在**普通终端**里跑——那本来就是它的使用场景。
