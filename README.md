# GlassesHarness

在 DeepSeek Harness（DSH）里自定义一个**亮亮视野（LLVision）眼镜插件**，并在它之上搭一个**中文↔巴西葡语双向同传 app**。

目标型号：**Leion Pro**（并列 **GLXSS ME**）。
当前条件：**没有真机、没有厂商 SDK** → 先用 `mock` transport 把完整链路跑通。

> 📚 **文档在这里**：**[`docs/`](docs/README.md)** —— 按"我要找什么"跳。
> 项目架构看 [`docs/01-架构与方案.md`](docs/01-架构与方案.md)，
> 数据通路与目录布局看 [`docs/05-数据通路.md`](docs/05-数据通路.md)，
> 每个文件是干什么的看本文件下面的「目录」一节。

---

## 现在就能做的事

```powershell
node scripts/generate.mjs        # 从核心逻辑生成两个产物
node tests/run-all.mjs           # 136 项断言：新鲜度门禁 + 两个包装版本各跑一遍 + 一致性对比
python tests/python-suite.py     # 另 30 项：语音分段器 + 音频尾随（不加载模型，很快）
                                 # + ASR 桥契约 + 局域网契约 + 真实 Cordis 组合

# A) 不需要麦克风、不需要手机：重放一段中葡对照的剧本，看整条同传链路
node bridge/asr-bridge.mjs --inbox var/demo/asr-inbox.jsonl `
  --engine replay --replay bridge/sample-transcript.txt --truncate

# B) 老师演示：真实 harness 组合跑完整链路，把"眼镜屏幕"逐帧画出来
node scripts/demo.mjs                  # 离线例句表：不联网、零成本、可复现
node scripts/demo.mjs --live           # 真实模型翻译（走已配置的 DeepSeek 凭据）

# C) 手机端真跑（三个终端 + 手机装 App）
node scripts/harness-side.mjs          # 终端 1：harness 侧（加 --offline 则不联网）
node relay/lan-relay.mjs               # 终端 2：局域网转发（会打印地址与密钥）
node scripts/build-apk.mjs             # 构建安卓 App → android/README.md 有完整步骤

# D) 手机上"对着说话出字幕"（录音上传；这台设备的系统识别服务不可用，只能走这条）
node bridge/asr-bridge.mjs --inbox var/live/asr-inbox.jsonl --from pt-BR `
  --whisper-follow var/live/audio-in.pcm --whisper-device cuda --whisper-compute float16
#   ↑ 终端 3：把手机传来的音频变成文字。手机 App 里点「开始录音上传」。
#     没有手机也能验：node scripts/fake-phone.mjs --wav <16k wav> --url http://127.0.0.1:8788 --secret <密钥>
```

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
| `bridge/asr-bridge.mjs` | **ASR 桥**（harness 之外）：把语音识别结果变成收件箱里的一行一句话；`--whisper-follow` 直接尾随手机上传的音频 |
| `bridge/whisper_stream.py` | 本地 Whisper 引擎（faster-whisper）：按音量切句 + 自适应门槛 + 防幻听 + 预热；`--follow` 尾随手机上传的裸 PCM ✅ 已实测，见 `docs/04` |
| `bridge/whisper_transcribe.py` | 转写单个音频文件并测耗时/RTF（自带解码器，绕开 PyAV 版本坑） |
| `bridge/make_long_wav.py` | 把短录音拼成长的测试音频（可加底噪），用来测真实延迟 |
| `bridge/asr_eval.py` | **葡语准确率评测**：用 FLEURS 巴葡语料算词错率 WER（带参考文本，不靠肉眼） |
| `bridge/sample-transcript.txt` | 中葡对照的样例转写，用于无麦克风演示 |
| `relay/lan-relay.mjs` | **局域网转发**：手机 ↔ 电脑，5 个端点 + 共享密钥（含 `POST /audio` 录音上传，见下） |
| `scripts/harness-side.mjs` | 常驻的 harness 侧进程（真实组合 + 插件，文件模式） |
| `scripts/fake-phone.mjs` | **假手机**：没有手机时按同样的协议逐块上传音频，用来验证「录音上传」那条路 |
| `android/` | **安卓 App「虚拟眼镜」**：录音上传 + 系统听写 + 40×3 字幕面板（零第三方依赖） |
| `lib/artifacts.mjs` · `scripts/generate.mjs` | 产物生成（测试与 CLI 共用同一份实现） |
| `lib/paths.mjs` | **运行时路径与文件名的唯一来源**（数据不能乱删的分层就是它定的，见 `docs/05`） |
| `lib/composition.mjs` · `lib/fs-node.mjs` · `lib/keepalive.mjs` | 组合生成与两个共用的小插件 |
| `lib/real-tools.mjs` · `lib/loader-links.mjs` | 加载检出里真实的构建产物 / 建 loader junction |
| `tests/` | 沙箱复刻 + 两个适配器 + 契约套件 + 桥套件 + 局域网套件 + 翻译后端接缝（136 项） |
| `tests/python-suite.py` | **语音分段器与音频尾随**验证（30 项，不加载模型，含一条静默失败的回归测试） |
| `tests/live/` | **真实 Cordis 组合**：真实 `ToolRuntime` + 真实执行流水线 + 真实 `timer` + 真实 `output.schema` 校验（组合现场生成，见该目录 README） |
| `skills/leion-interpreter/SKILL.md` | **同传操作规范**：巴葡 vs 葡葡用词差异表、字幕长度纪律、调用顺序 |
| `var/` | **运行时数据**（不进版本库）：`live/` 收件箱与字幕总线、`cache/` 模型缓存、`audio/` 测试音频、`logs/` |
| `docs/README.md` | **文档索引**：按"我要找什么"跳（架构 / 加载 / 进度 / 实测 / 数据通路） |
| `docs/01-架构与方案.md` | **给老师的方案**：分层、接缝论证、验证状态、真机/ASR 接入路径、路线图 |
| `docs/02-创造模式加载指南.md` | 怎么把它挂起来（含可直接粘贴的提示词、真实报错对照表） |
| `docs/03-进度汇报.md` | **给老师的进度报告**：做到哪一步、验证到什么程度、修掉了哪些问题、下一步与需确认的事 |
| `docs/04-语音识别验证.md` | **ASR 实测报告**：模型选型、每句延迟、三个测试方法的坑、修掉的三个 bug |
| `docs/05-数据通路.md` | **数据通路与目录布局**：哪份数据能删、收件箱行格式、字幕帧字段、路径怎么取 |

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
| 7 个工具契约、排版、双向语向、节流、异常 | ✅ 136 项断言，两个版本各跑一遍，全绿 |
| ASR 收件箱（半行/坏行/强制语种/stop-drain-reset） | ✅ 离线契约 + **真实 timer 端到端** |
| **ASR 桥**（断句 / 停顿断句 / UTF-8 重音 / 协议不被破坏 / replay 端到端） | ✅ 19 项契约 + 实测 CLI |
| **语音分段器**（切句 / 自适应门槛 / 防幻听 / 前导缓存 / 短响丢弃） | ✅ 30 项断言，`tests/python-suite.py`（含一条静默失败的回归测试） |
| **音频尾随**（追加增量 / 文件截断重来 / 半帧对齐 / 采样率降级重采样） | ✅ 10 项断言，同上 |
| **录音上传整条路**（手机音频 → 继电器落盘 → 识别 → 收件箱） | ✅ 用真实中文录音跑通：`fake-phone.mjs` 逐块上传 → 收件箱出现 6 句正确中文 |
| **安卓 App 的录音上传** | ✅ 真构建出 APK（41 KB），并核对 dex 里有 `MicUploader` / `/audio?rate=`、资源里有新按钮文案 |
| 两个版本一致性（含 schema 与 render） | ✅ 逐字段对比 |
| **正式包装进真实 Cordis 组合** | ✅ 真实 `ToolRuntime` 注册 + 真实执行流水线 + 真实 `output.schema` 校验（`tests/live/`） |
| **桥 → 收件箱 → 真实 timer → 真实流水线** 端到端 | ✅ `tests/live/` 里跑通（已处理 2 条、错误 0 条） |
| **真实录音 → Whisper → 桥 → 插件 → 字幕帧** 端到端 | ✅ 用真实中文录音跑通，输出 `speaker:"me"` / `pt-BR`，见 `docs/04` |
| **Whisper 每句延迟与模型选型** | ✅ 实测：small+GPU 每句 0.10s、延迟 0.80s；small+CPU 跟不上（RTF 1.148） |
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
