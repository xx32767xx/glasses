# GlassesHarness

在 DeepSeek Harness（DSH）里自定义一个**亮亮视野（LLVision）眼镜插件**，并在它之上搭一个**中文↔巴西葡语双向同传 app**。

目标型号：**Leion Pro**（并列 **GLXSS ME**）。
当前条件：**没有真机、没有厂商 SDK** → 先用 `mock` transport 把完整链路跑通。

---

## 现在就能做的事

```powershell
node scripts/generate.mjs        # 从核心逻辑生成两个产物
node tests/run-all.mjs           # 83 项断言：新鲜度门禁 + 两个包装版本各跑一遍 + 一致性对比
                                 # + ASR 桥契约 + 真实 Cordis 组合（真实 ToolRuntime + 真实 timer）

# 不需要麦克风、不需要 ASR：重放一段中葡对照的转写，看整条同传链路
node bridge/asr-bridge.mjs --inbox E:/GlassesHarness/.tmp/asr-inbox.jsonl `
  --engine replay --replay bridge/sample-transcript.txt --truncate
```

想立刻在 harness 里看到 7 个眼镜工具 → 看 [`docs/02-创造模式加载指南.md`](docs/02-创造模式加载指南.md)。
**要点：必须新建一个「创造模式」会话**（已产出内容的会话不能切 preset）。

只想跑真实组合那一层：

```powershell
node tests/live/run.mjs          # 用检出里真实的 dsh-tools 组成真实 Cordis 应用，
                                 # 含「桥写行 → 真实 timer → 真实流水线 → 字幕」端到端
```

---

## 目录

| 路径 | 是什么 |
|---|---|
| `plugin/core.mjs` | **业务逻辑唯一来源**：排版、语种判定、翻译管线、ASR 收件箱、transport seam、7 个工具规格 |
| `plugin/index.mjs` | **正式插件**入口：`export name / inject / apply(ctx, config)`，零第三方依赖 |
| `plugin/schemas.generated.mjs` | 生成：由 core 的 DSL 经真实 `defineTool` 编译出的原始 schema |
| `plugin/cordis.patch.yml` · `cordis.local.patch.yml` | 装进 profile 用 / 开发 `--patch` 用 |
| `dynamic/leion-pro.host.js` | 生成：**动态插件**，可直接粘贴给创造模式的 `cordis_define` |
| `bridge/asr-bridge.mjs` | **ASR 桥**（harness 之外）：把语音识别结果变成收件箱里的一行一句话 |
| `bridge/whisper_stream.py` | 可选的本地 Whisper 引擎（faster-whisper + 麦克风）⚠️ 未在本机验证 |
| `bridge/sample-transcript.txt` | 中葡对照的样例转写，用于无麦克风演示 |
| `lib/artifacts.mjs` · `scripts/generate.mjs` | 产物生成（测试与 CLI 共用同一份实现） |
| `lib/real-tools.mjs` | 加载检出里**真实的** `@deepseek-ai/dsh-tools`；拿不到就报错，**拒绝降级** |
| `tests/` | 沙箱复刻 + 两个适配器 + 20 项契约套件 + 19 项桥契约 + 83 项总验证 |
| `tests/live/` | **真实 Cordis 组合**：真实 `ToolRuntime` + 真实执行流水线 + 真实 `timer` + 真实 `output.schema` 校验 |
| `skills/leion-interpreter/SKILL.md` | **同传操作规范**：巴葡 vs 葡葡用词差异表、字幕长度纪律、调用顺序 |
| `docs/01-架构与方案.md` | **给老师的方案**：分层、接缝论证、验证状态、真机/ASR 接入路径、路线图 |
| `docs/02-创造模式加载指南.md` | 怎么把它挂起来（含可直接粘贴的提示词、真实报错对照表） |

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
| 7 个工具契约、排版、双向语向、节流、异常 | ✅ 83 项断言，两个版本各跑一遍，全绿 |
| ASR 收件箱（半行/坏行/强制语种/stop-drain-reset） | ✅ 离线契约 + **真实 timer 端到端** |
| **ASR 桥**（断句 / 停顿断句 / UTF-8 重音 / 协议不被破坏 / replay 端到端） | ✅ 19 项契约 + 实测 CLI |
| 两个版本一致性（含 schema 与 render） | ✅ 逐字段对比 |
| **正式包装进真实 Cordis 组合** | ✅ 真实 `ToolRuntime` 注册 + 真实执行流水线 + 真实 `output.schema` 校验（`tests/live/`） |
| **桥 → 收件箱 → 真实 timer → 真实流水线** 端到端 | ✅ `tests/live/` 里跑通（已处理 2 条、错误 0 条） |
| 在创造模式会话里真实挂载 | ⬜ 需要你新建会话 |
| 在**你自己的 `dsh web` profile** 里加载 | ⬜ 需要重启，或授权我写 profile 的 `cordis.patch.yml`（HMR 热挂载，不用重启） |
| `ctx.llm` / `ctx.fs` 真实运行时行为 | ⬜ 真实组合里用的是假 llm / 假 fs（timer 是真的） |
| 真实麦克风 + Whisper 转写 | ⬜ `whisper_stream.py` 未在本机验证（需要 pip 装依赖） |
| 真机协议（Leion Pro / GLXSS ME） | ⬜ **最大的未知项** |

---

## 下一步（选一个我就动手）

1. **M2** — 在创造模式会话里真实挂载跑通（你新建会话，提示词在 `docs/02`）
2. **M3** — 加 Client 半：会话内的「字幕预览屏」UI
3. **M4.5** — 正式包装进你的 `dsh web`（走 profile 的 `cordis.patch.yml` 可 HMR 热挂载、不用重启，但要授权我写 `%DSH_HOME%`）
4. **M5c** — 真正接上麦克风：装 faster-whisper 跑通 `whisper_stream.py`（需要你本机 pip 安装）
5. **M6** — 接真机：先做 `adb` 侧路（GLXSS 系列是 Android 设备）
