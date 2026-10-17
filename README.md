# GlassesHarness

在 DeepSeek Harness（DSH）里自定义一个**亮亮视野（LLVision）眼镜插件**，并在它之上搭一个**中文↔巴西葡语双向同传 app**。

目标型号：**Leion Pro**（并列 **GLXSS ME**）。
当前条件：**没有真机、没有厂商 SDK** → 先用 `mock` transport 把完整链路跑通。

> 📚 **文档在这里**：**[`docs/`](docs/README.md)** —— 按"我要找什么"跳。
> 项目架构看 [`docs/01-架构与方案.md`](docs/01-架构与方案.md)，
> 数据通路与目录布局看 [`docs/05-数据通路.md`](docs/05-数据通路.md)，
> **收音与切句策略（含当前所有缺省值及其实测依据）看 [`docs/06-收音策略.md`](docs/06-收音策略.md)**，
> 每个文件是干什么的看本文件下面的「目录」一节。

---

## 现在就能做的事

```powershell
node scripts/generate.mjs        # 从核心逻辑生成 6 个产物（插件 3 个 + 技能文档 + 2 份文档/资源）
node tests/run-all.mjs           # 307 个用例：新鲜度门禁 + 两个包装版本各跑一遍 + 一致性对比
                                 #（JS 计入的是**用例数**：一个用例里可以有多条断言，失败即整条红）
python tests/python-suite.py     # 另 319 条断言：分段器 + 音频尾随 + 语种 + 评分规则 + 测试包切分 + 错因分类
                                 #（Python 计入的是**断言条数**，一节里的断言失败不会挡住后面的）

# A) 不需要麦克风、不需要手机：重放一段中葡对照的剧本，看整条同传链路
node bridge/asr-bridge.mjs --inbox var/demo/asr-inbox.jsonl `
  --engine replay --replay bridge/sample-transcript.txt --truncate

# B) 老师演示：真实 harness 组合跑完整链路，把"眼镜屏幕"逐帧画出来
node scripts/demo.mjs                  # 离线例句表：不联网、零成本、可复现
node scripts/demo.mjs --live           # 真实模型翻译（走已配置的 DeepSeek 凭据）

# C) 手机端真跑：**一条命令起齐三个进程**
node scripts/start-all.mjs             # 转发 + 识别 + 大脑，日志带前缀汇总在一个终端
                                       # Ctrl-C 一次停掉全部；起之前会检查端口有没有被旧进程占着
                                       # --cpu 用 CPU 识别 / --offline 不联网 / --open-window 另开调试窗口
node scripts/build-apk.mjs             # 构建安卓 App → android/README.md 有完整步骤
node scripts/debug-window.mjs          # 另开一个终端：实时显示断在哪一环（只读，不影响链路）

# 没有手机也能验整条路：
python bridge/make_long_wav.py var/audio/zh/20261004_002001.m4a var/audio/zh/short-16k.wav --times 3 --gap 1
node scripts/fake-phone.mjs --wav var/audio/zh/short-16k.wav --url http://127.0.0.1:8788 --secret <密钥>
```

三个进程分别是什么（`start-all` 会用这三种前缀给日志标色）：

| 前缀 | 进程 | 干什么 |
|---|---|---|
| `[转发]` | `relay/lan-relay.mjs` | 收发室：手机 ↔ 电脑，落盘音频、递回字幕 |
| `[识别]` | `bridge/asr-bridge.mjs --whisper-follow` | 耳朵：音频 → 文字（Whisper，用 GPU） |
| `[大脑]` | `scripts/harness-side.mjs` | 大脑：文字 → 判语向 → 调模型翻译 → 排版成 40×3 |

缺任何一个，手机上都是"什么都没发生" —— 所以配套给了**调试窗口**，
它把四个环节的证据并排显示并直接给出结论。见 `docs/05-数据通路.md`。

想立刻在 harness 里看到 7 个眼镜工具 → 看 [`docs/02-创造模式加载指南.md`](docs/02-创造模式加载指南.md)。
**要点：必须新建一个「创造模式」会话**（已产出内容的会话不能切 preset）。

---

## 目录

| 路径 | 是什么 |
|---|---|
| `plugin/core.mjs` | **业务逻辑唯一来源**：排版、语种判定、翻译管线、ASR 收件箱、两个接缝、7 个工具规格 |
| `plugin/index.mjs` | **正式插件**入口：`export name / inject / apply(ctx, config)`，零第三方依赖 |
| `policy/br-pt.json` | **巴葡口径唯一来源**：术语表、口语特征、字幕纪律（提示词与技能文档都从它生成） |
| `plugin/schemas.generated.mjs` | 生成：由 core 的 DSL 经真实 `defineTool` 编译出的原始 schema |
| `plugin/cordis.patch.yml` · `cordis.local.patch.yml` | 装进 profile 用 / 开发 `--patch` 用 |
| `dynamic/leion-pro.host.js` | 生成：**动态插件**，可直接粘贴给创造模式的 `cordis_define` |
| `lib/display-samples.mjs` | **眼镜校准句的唯一来源**（中文取自测试句集、葡语取自真实定稿帧，逐条记出处）→ 生成 `android/.../res/values/display_samples.xml` |
| `bridge/asr-bridge.mjs` | **ASR 桥**（harness 之外）：把语音识别结果变成收件箱里的一行一句话；`--whisper-follow` 直接尾随手机上传的音频 |
| `bridge/whisper_stream.py` | 本地 Whisper 引擎（faster-whisper）：按音量切句 + 自适应门槛 + 防幻听 + 预热；`--follow` 尾随手机上传的裸 PCM ✅ 已实测，见 `docs/04` |
| `bridge/whisper_transcribe.py` | 转写单个音频文件并测耗时/RTF（自带解码器，绕开 PyAV 版本坑） |
| `bridge/make_long_wav.py` | 把短录音拼成长的测试音频（可加底噪），用来测真实延迟 |
| `bridge/sample-transcript.txt` | 中葡对照的样例转写，用于无麦克风演示 |
| `asr-eval/` | **识别评测这一层**（代码）：切测试包 / 跑评测 / 评分规则 / 错因分类 / 切句基准。数据在 `var/asr-eval/`，见 `asr-eval/README.md` |
| `asr-eval/test-asr.mjs` | **跑 ASR 测试**：`--set zh-speech-dev --model large-v3`。测试集自动发现（有 `manifest.jsonl` 的目录，也可 `--set-path <任意目录>`）、`--compare` 多模型排序、`--by-accent` 按口音分组、结果留存可复用。**只做编排，指标计算调 `asr-eval/asr_eval.py`**（避免两套口径漂移） |
| `asr-eval/asr_pack.py` | **切识别测试包 + 查切分卫生**：`--build` / `--verify` / `--keys`。确定性抽样、按录音整组、与历史回归集不相交、每场给名额（否则 300 条只覆盖 2 个说话人 —— 实测踩过）。规程见 `docs/14` |
| `asr-eval/asr_eval.py` | **准确率基准**：用带参考文本的语料算错误率（中文按**字** CER、葡语按**词** WER），不靠肉眼。`--out-json` 另写结构化结果供汇总用 |
| `asr-eval/asr_score.py` | **评分规则唯一来源**（`asr-score-v1`）：归一化、整体错误率、S/D/I、关键内容命中、**逐项对齐 `align_ops`**（"错在哪些字上"靠它） |
| `asr-eval/asr_error_analysis.py` | **把"错在什么上"分类**：删除/替换逐项归到"写法差异 / 语气词 / 口吃 / 真错"。中文朗读那 12.3% 里 77% 是计分假象、口语那 12.7~15.3% 是真的 —— 两次结论都是它给的（`docs/14` §6.3/§6.6） |
| `asr-eval/segment_eval.py` | **切句基准**：直接 import 生产那个分段器，量"静音判定该设多久"——切碎/合并各多少次、最长合并多久、错误率变好还是变坏。缺省 500ms 就是它量出来的，见 `docs/04` §13 |
| `relay/lan-relay.mjs` | **局域网转发**：手机 ↔ 电脑，5 个端点 + 共享密钥（含 `POST /audio` 录音上传，见下） |
| `scripts/harness-side.mjs` | 常驻的 harness 侧进程（真实组合 + 插件，文件模式） |
| `scripts/start-all.mjs` | **一键启动**：一次起齐"转发 + 识别 + 大脑"，日志带前缀汇总、Ctrl-C 全停、先查端口有没有被旧进程占着 |
| `scripts/fake-phone.mjs` | **假手机**：没有手机时按同样的协议逐块上传音频，用来验证「录音上传」那条路 |
| `scripts/net-doctor.mjs` | **网络体检**：手机连不上时把"地址变了 / 不在同一网段 / 进程没在听 / 防火墙拦了"分开报；`--watch` 还能判断包到底有没有到电脑（用来区分防火墙与校园网隔离） |
| `scripts/test-phrases.mjs` | **同传效果测试句集**（18 条中文长难句）+ 一键跑批：自动判"数字有没有丢、有没有用葡葡词、译文在 40×3 上会不会被截掉开头、有没有假字幕"。`--list` 只打印句子，`--read-aloud` 连"这条测什么"一起打印 |
| `scripts/bench-regional.mjs` | **巴葡区域变体句集**（圣保罗/里约/南部/东北部/口语缩略，5 组 10 句）：方案把"巴葡口音适配"列为核心指标，这一套测的是**文本**层的区域说法认不认得（口音要真实录音，是下一步）。判据偏松，两个已知漏洞在 `tests/bench-suite.mjs` 里写成断言钉着 |
| `scripts/bench-models.mjs` | **翻译模型横评**：同一批句子喂多个模型，出对比表（事故数 / P50 / P95 / 欧葡词 / 数字丢失 / 超行）。提示词**直接取自 policy**（不手抄），开跑前先跑 9 项**判据自检**，自检不过就不调模型。`--verify-models` 先问平台"你到底有哪些模型"（平台上的 ID 与厂商仓库名经常不一样，写错只会得到 404，容易被误读成"平台没有"） |
| `scripts/rejudge.mjs` | **换判据重评**：判据进化后用**同一批已记录的译文**重跑判定。**不重跑模型** —— 否则"新旧对比"里会混进样本差异（模型有随机性，同一批跑两遍实测有 10/18 条文本不同） |
| `lib/translation-lint.mjs` | **译文质检判据**：专名音译 / 实体槽丢失 / 葡语性数不一致三层。按"宁可不报，不可误报"写，每层配成对负对照（见 `tests/lint-suite.mjs`）。**已接进产线**（转发进程对每个定稿帧跑，只报不改，见 `--lint`） |
| `scripts/debug-window.mjs` | **调试窗口**：实时显示"音频/收件箱/字幕总线/转发进程"四个环节，并直接判断**断在哪一环** |
| `android/` | **安卓 App「虚拟眼镜」**：录音上传（识别在电脑上做）+ 40×3 字幕面板（零第三方依赖） |
| `lib/artifacts.mjs` · `scripts/generate.mjs` | 产物生成（测试与 CLI 共用同一份实现） |
| `lib/paths.mjs` | **运行时路径与文件名的唯一来源**（数据不能乱删的分层就是它定的，见 `docs/05`） |
| `lib/composition.mjs` · `lib/fs-node.mjs` · `lib/keepalive.mjs` | 组合生成与两个共用的小插件 |
| `lib/real-tools.mjs` · `lib/loader-links.mjs` | 加载检出里真实的构建产物 / 建 loader junction |
| `tests/` | 沙箱复刻 + 两个适配器 + 契约套件 + 桥套件 + 局域网套件 + 识别评测结构检查（用例数见下） |
| `tests/python-suite.py` | **产线分段器 + 评测判据**验证（319 条断言，不加载模型；含静默失败的回归、不变量、负对照） |
| `tests/live/` | **真实 Cordis 组合**：真实 `ToolRuntime` + 真实执行流水线 + 真实 `timer` + 真实 `output.schema` 校验（组合现场生成，见该目录 README） |
| `skills/leion-interpreter/SKILL.md` | **同传操作规范**：巴葡 vs 葡葡用词差异表、字幕长度纪律、调用顺序 |
| `var/` | **运行时数据**（不进版本库）：`live/` 收件箱与字幕总线、`cache/` 模型缓存、`audio/` 测试音频、`asr-eval/` **识别评测的测试包与结果**、`logs/`。分层原则见 `lib/paths.mjs` |
| `docs/README.md` | **文档索引**：按"我要找什么"跳（架构 / 加载 / 进度 / 实测 / 数据通路） |
| `docs/01-架构与方案.md` | **给老师的方案**：分层、接缝论证、验证状态、真机/ASR 接入路径、路线图 |
| `docs/02-创造模式加载指南.md` | 怎么把它挂起来（含可直接粘贴的提示词、真实报错对照表） |
| `docs/03-进度汇报.md` | **给老师的进度报告**：做到哪一步、验证到什么程度、修掉了哪些问题、下一步与需确认的事 |
| `docs/04-语音识别验证.md` | **ASR 实测报告**：模型选型、每句延迟、三个测试方法的坑、修掉的三个 bug |
| `docs/05-数据通路.md` | **数据通路与目录布局**：哪份数据能删、收件箱行格式、字幕帧字段、路径怎么取 |
| `docs/06-收音策略.md` | **收音与切句策略（含当前状态快照）**：分了几层、每个缺省值及其实测依据、八条原则、换场景怎么调、收音问题怎么诊断 |
| `docs/07-大模型校对.md` | **大模型校对（第二遍）**：先出译文再回头改怎么做的、为什么只在空闲时做、三条安全保证、怎么开 |
| `docs/08-翻译模型横评.md` | **开源 vs 闭源模型横评**：5 个模型同一批句子的实测、各家具体的错在哪、判据自己出过的两个错、选型建议 |

---

## 一句话架构

```
麦克风 → ASR 桥 → 收件箱（一行一句话）→ 语向判定 → 流式翻译 → 字幕排版 → transport → 眼镜
         ↑ harness 之外              ↑ 插件用真实 timer 轮询
```

「文本注入」是一个**具体协议**，不是抽象说法：外部程序往 `inboxPath` 按行追加文本，插件轮询它。
`bridge/asr-bridge.mjs` 就是实现这个协议的那一半——它内建行装配器，处理 ASR 输出的碎片化
（逐词打、`\r` 就地刷新、不换行），并支持**停顿即断句**。**打开收件箱是「同传」，不打开就只是「agent 调用的翻译工具」。**

四层里只有最底层的 `createTransport()` 会随真机变化——`mock`（无真机）↔ `file`（外部桥轮询字幕总线 JSON）↔ 待加的 `adb` / 厂商 SDK。
**接真机 = 改一个函数，其它三层不动。**

## 一套逻辑，两个交付形态

```
        plugin/core.mjs  ← 唯一逻辑来源
              ├── plugin/index.mjs            正式插件（持久，走 ctx.tools.register）
              └── dynamic/leion-pro.host.js   动态插件（创造模式粘贴用，由生成器内联 core 产出）
```

配套两道门禁：**产物新鲜度**（逐字节比对）+ **一致性对比**（同一套 20 项契约跑两遍，再逐字段比
`fingerprint`、描述、`parameters`、`output.schema`、`render` 输出）。两个版本行为一致因此是被验证的事实。

---

## 7 个模型工具

| 工具 | 作用 |
|---|---|
| `leion_status` | 设备 / 通道 / 显示预算 / 计数与最近错误 |
| `leion_display` | 排版后直接推送（不翻译） |
| `leion_translate` | **双向同传主入口**：自动判语向 → 流式翻译 → 排版 → 推送 |
| `leion_history` | 双语对照的现场记录 |
| `leion_inbox` | **ASR 收件箱控制**：status / start / stop / drain / reset |
| `leion_clear` | 清屏 + 清历史 |
| `leion_selftest` | 五条链路自检（排版 / 显示 / 语种判定 / 翻译路由 / 收件箱） |

## 关键设计决策

1. **佩戴者视角**：Leion Pro 是戴在自己脸上的眼镜。对方说巴葡 → 译成中文给佩戴者读（主线）；自己说中文 → 译成巴葡是**给对方的**，眼镜上只做回显。代码用 `displaySpeaker` + `outbound` 显式区分，避免把给对方的葡语字幕显示给听不懂的佩戴者。
2. **判不出语向就问，绝不猜。** 猜错方向比慢一拍严重得多。
3. **数字必须原样保留**，不许为了塞进 3 行做二次摘要——同传里丢数字是事故。
4. **`finish ≠ stop` 就丢弃译文**，宁可空屏也不显示半截。
5. **内部帧（清屏、自检探针）不进双语历史。**
6. **状态是实例级的，不是模块级的** —— 正式插件可能被多个 agent preset 同时挂载，模块级状态会让两条会话的字幕互相串。
7. **收件箱只吃「以换行结束」的完整行**，且翻译**串行**执行 —— 前者让外部程序可以随时 flush，后者避免字幕互相穿插。
8. **坏行只计数不中断** —— 一条写坏的 JSON 不该让整条同传停摆。
9. **两个接缝，不是一处** —— `transport`（字幕怎么出去）和 `translator`（译文从哪来）。前者让"换眼镜"只改一处，后者让"换翻译位置"只改一个配置：

   ```
   config.translator:
     'harness-llm'   电脑上的 harness + 云端模型（现状）
     'http'          POST 到外部端点 ← 把模型搬到手机/眼镜端时用这条，插件不改代码
     'none'          不做翻译，收件箱文字直接当字幕 ← 插件退化成纯显示通道
   ```
10. **巴葡口径是数据，不是代码** —— 术语表与规则在 `policy/br-pt.json`，提示词和技能文档都从它生成。这不只是去重：将来翻译搬到端侧小模型时，那份数据能改用作"禁用词约束"或"后处理替换表"，而提示词搬到小模型上根本执行不了。

---

## 这一轮抓到的真 bug（都不是靠肉眼）

1. `output.schema` 用了原始 JSON Schema → 6 个工具会在真实 harness **第一个就炸**（harness 的 value schema DSL 不接受 `required` 数组）；
2. `leion_clear` 清空历史后又被那帧「清屏」污染，历史变成 1 而不是 0；
3. 自检工具的布尔字段把 shell 里的 `transport` 字符串覆盖了；
4. 逻辑抽取时 `translate` 的成功路径漏了 `ok: true`；
5. 原版状态放在模块级 → 多个 preset 挂载时会互相串字幕；
6. 加 `inject: ['timer']` 后真实组合立刻**停在 PENDING**（组合里没挂 timer）——这正是「依赖没就绪」的真实表现，也验证了测试台能抓到它；
7. 契约套件里收件箱的 `setInterval` 没人停 → Node 进程不退出（真实 Cordis 会随 fiber 释放，我的假 ctx 不会）。

第 1 条是**把测试台从仿造校验器换成检出里真实的 `defineTool` 之后立刻暴露的**——原来的仿造校验器放过了它。

---

## 验证状态（别把它读成「硬件通了」）

| 事项 | 状态 |
|---|---|
| schema DSL / 参数校验 / 输出校验 | ✅ 用**真实** `defineTool` + `validateJsonSchemaValue` |
| 7 个工具契约、排版、双向语向、节流、异常 | ✅ 契约套件（`tests/contract-suite.mjs`），两个版本各跑一遍，全绿 |
| ASR 收件箱（半行/坏行/强制语种/stop-drain-reset） | ✅ 离线契约 + **真实 timer 端到端** |
| **ASR 桥**（断句 / 停顿断句 / UTF-8 重音 / 协议不被破坏 / replay 端到端） | ✅ 桥套件（`tests/bridge-suite.mjs`）+ 实测 CLI |
| **语音分段器**（切句 / 自适应门槛 / 防幻听 / 前导缓存 / 短响丢弃 / 到上限时按停顿断句 / **切句不随上传节奏变化**) | ✅ `tests/python-suite.py`（含一条静默失败的回归、一条"交出多少语音"的不变量、一条"上传间隔不算句子结束"的回归 + 负对照） |
| **音频尾随**（追加增量 / 文件截断重来 / 半帧对齐 / 采样率降级重采样） | ✅ 同一份套件（`PcmFollower` 那一节） |
| **录音上传整条路**（手机音频 → 继电器落盘 → 识别 → 收件箱） | ✅ 用真实中文录音跑通：`fake-phone.mjs` 逐块上传 → 收件箱出现 6 句正确中文 |
| **安卓 App 的录音上传** | ✅ 真构建出 APK（35 KB），并核对 dex 里有 `MicUploader` / `&lang=`，**没有**任何 `SpeechRecognizer` 残留 |
| **语种随音频下发**（切「听葡语/听中文」录音中即时生效） | ✅ 端到端验过：手机侧改语种 → `audio-in.lang` → 识别进程换语种，下一句生效 |
| **调试窗口**（把"断在哪一环"变成结论） | ✅ 调试窗口套件（`tests/debug-suite.mjs`）：六种卡住形态各指向正确环节 + 真读文件（空目录/坏 JSON 都不崩） |
| **帧序号复位**（转发进程重启后手机不再失聪） | ✅ relay 套件（帧复位那一节）：客户端序号超前时明确回 reset，正常时不乱发帧 |
| **识别评测这一层的结构**（语体标签 / 结果不覆盖 / 跨语言路径一致 / 分层方向） | ✅ `tests/asr-pack-suite.mjs`：四条都是"搬家或改一行就可能悄悄坏掉"的东西 |
| 两个版本一致性（含 schema 与 render） | ✅ 逐字段对比 |
| **正式包装进真实 Cordis 组合** | ✅ 真实 `ToolRuntime` 注册 + 真实执行流水线 + 真实 `output.schema` 校验（`tests/live/`） |
| **桥 → 收件箱 → 真实 timer → 真实流水线** 端到端 | ✅ `tests/live/` 里跑通（已处理 2 条、错误 0 条） |
| **真实录音 → Whisper → 桥 → 插件 → 字幕帧** 端到端 | ✅ 用真实中文录音跑通，输出 `speaker:"me"` / `pt-BR`，见 `docs/04` |
| **Whisper 每句延迟与模型选型** | ✅ 实测：small+GPU 每句 0.10s、延迟 0.80s；small+CPU 跟不上（RTF 1.148） |
| **中文识别准确率（CER 基准）** | ✅ 30 条带参考文本（FLEURS 中文）：**large-v3 3.9%** / medium 7.4% / **small 18.9%** 字错率 —— 见 `docs/04` §11 |
| **葡语识别准确率**（对方说葡语 → 中文字幕） | ✅ 用 FLEURS 巴葡朗读语料算词错率：medium **4.9%**、large-v3 4.7%、small 7.3%；语种判定 30/30 全对 |
| 在创造模式会话里真实挂载 | ⬜ 需要你新建会话 |
| 在**你自己的 `dsh web` profile** 里加载 | ⬜ 需要重启，或授权我写 profile 的 `cordis.patch.yml`（HMR 热挂载，不用重启） |
| `ctx.llm` / `ctx.fs` 真实运行时行为 | ⬜ 真实组合里用的是假 llm / 假 fs（timer 是真的） |
| **安卓 App 在真机上录音上传** | ⬜ APK 已构建并核对内容，但**没在手机上装过**；安卓录音参数与降级行为待真机验证 |
| **真实会议室里的葡语对话** | ⬜ 目前只有朗读语音（乐观下界）；口音/抢话/背景人声未测，缺真实会议录音 |
| 端到端延迟（识别+翻译连续测一次） | ⬜ 目前是分段推算 1.3~2.2s，插件里还没打时间戳 |
| 真机协议（Leion Pro / GLXSS ME） | ⬜ **最大的未知项** |

---

## 下一步（选一个我就动手）

1. **M2** — 在创造模式会话里真实挂载跑通（你新建会话，提示词在 `docs/02`）
2. **M3** — 加 Client 半：会话内的「字幕预览屏」UI
3. **M4.5** — 正式包装进你的 `dsh web`（走 profile 的 `cordis.patch.yml` 可 HMR 热挂载、不用重启，但要授权我写 `%DSH_HOME%`）
4. **M5c** — 真正接上麦克风：装 faster-whisper 跑通 `whisper_stream.py`（需要你本机 pip 安装）
5. **M6** — 接真机：先做 `adb` 侧路（GLXSS 系列是 Android 设备）
