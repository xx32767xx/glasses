---
name: leion-interpreter
description: 中↔巴西葡萄牙语（巴葡）双向同声传译的操作规范。当用户要求在亮亮视野眼镜上做同传、要求做中巴翻译、要求把字幕推到 AR 眼镜、或提供了一段需要现场口译的中文/葡语文本时使用。内含巴葡与欧洲葡语的用词差异表、字幕长度纪律、以及 leion_* 工具的正确调用顺序。
---

# 中↔巴葡双向同传

目标：把听到的话**当场**译成对方能懂的语言，并在亮亮视野（LLVision）眼镜上显示佩戴者需要读的那一帧。

## 硬约束：**巴葡 ≠ 葡葡**

用户要的是 **巴西葡萄牙语（pt-BR）**，不是葡萄牙本土葡语。这是评分点，不是风格偏好。以下是必须遵守的差异：

| 中文 | 巴葡 ✅ | 葡葡 ❌ |
|---|---|---|
| 公交车 | ônibus | autocarro |
| 手机 | celular | telemóvel |
| 冰箱 | geladeira | frigorífico |
| 计划（动词） | planejar | planear |
| 团队 | time | equipa |
| 火车 | trem | comboio |
| 冰淇淋 | sorvete | gelado |
| 收银台 | caixa | caixa（同）/ 但 "caixa" 前缀用 "caixa rápido" |
| 你 | você（默认） | tu（巴葡口语也用 você） |

巴葡口语特征：
- 日常会话用 **você**，不用 tu（除非南部/特定地区）。
- 复数第三人称常用 **a gente** 代替 nós：「我们去」→ *a gente vai*。
- 进行时用 **estar + gerúndio**：「正在开会」→ *está tendo reunião*（葡葡用 a + infinitivo：*está a ter*）。
- 属格用 **de**：「你的书」→ *o seu livro*，不用 *o livro de ti*。
- 语序偏 SVO，口语常省略主语代词。

## 字幕长度纪律（AR 显示区只有 40 列 × 3 行）

- **一条话一帧**：不要把一个长句拆成多次推送，也不要合并两句话。
- **宁可简洁**：译文超过约 90 个字符时，优先保留核心信息 + 数字，删掉客套话。
- **数字必须原样保留**：时间、金额、房间号、电话号码。译错数字比译错语法严重得多。
- **专有名词不翻译**：人名、公司名、产品名、地址路名保持原文（可加注音）。
- 不要为了塞进 3 行而做二次摘要——**摘要会丢数字**，这是同传事故。

## 佩戴者视角（决定字幕归属）

Leion Pro / GLXSS ME 是戴在**自己脸上**的眼镜，屏幕只给佩戴者看。所以：

- **对方说巴葡 → 译成中文 → 给佩戴者读**（主线，`displaySpeaker: 'them'`）
- **佩戴者说中文 → 译成巴葡 → 是给对方的**，眼镜上只做一行回显确认（`displaySpeaker: 'me'`，同时返回 `outbound`，需要 TTS 或第二块屏才能真正送到对方）

不要把「佩戴者读的字幕」和「给对方的译文」混为一条通道。

## 标准调用顺序

1. **开场先自检**
   ```
   leion_status      → 看通道、显示预算、有没有累积错误
   leion_selftest    → 一次确认排版/显示/语种判定/翻译路由/收件箱五条链路
   ```
   自检有红灯就先报告，不要硬着头皮翻译——否则你会在演示中途才发现链路断了。

2. **确认自动同传是否在跑**
   ```
   leion_inbox({ action: 'status' })   → configured / running / 路径 / 已处理与错误计数
   ```
   如果 `configured: false`，说明这台部署还没接 ASR 桥，此时只能逐句 `leion_translate`。
   如果 `running: true` 但 `errors` 在涨，先看 `lastError` 再继续。

3. **逐句同传（手动模式）**
   ```
   leion_translate({ text: "<听到的原话>" })
   ```
   - 缺省自动判语向。判不出来会明确失败，**这时问用户，不要猜方向**。
   - 确定语向时显式传 `from` / `to`，更快更稳。
   - 返回值里 `preview` 是眼镜上实际的排版效果，向用户复述时用这个，不要用你自己想象的排版。

3. **只需显示、不需翻译时**
   ```
   leion_display({ text: "关键词或提醒", speaker: 'them' })
   ```

4. **收尾**
   ```
   leion_history({ limit: 20 })   → 给出双语对照的现场记录
   leion_clear()                  → 清屏
   ```

## 输入从哪来（ASR 不在 harness 里）

DSH 没有任何音频/麦克风能力。**音频→文字这一段必须来自 harness 外部**：厂商 App、本地 Whisper 进程、或第三方 ASR 云。

插件已经实现好了对接的口子——**ASR 收件箱**：外部程序往 `inboxPath` 按行追加文本（纯文本行，或 `{"text":"...","from":"pt-BR"}` 这种 JSON 行），插件用真实 timer 轮询并自动出字幕。**这是「同传」模式；不打开收件箱时插件只是「被你调用的翻译工具」。**

那个「外部程序」本项目也写好了：`bridge/asr-bridge.mjs`（支持 stdin 管道、ASR CLI、重放样例、本地 Whisper 四种引擎，内建断句与停顿断句）。它和插件只共享「一行一句话」这个约定。

- **生产/联调态（推荐）**：先 `leion_inbox({action:'status'})` 看是否在跑、路径对不对；然后让 ASR 桥往那个文件写行。需要时用 `start` / `stop` / `drain`（立刻处理一次）/ `reset`（消费位置归零重放）。
- **演示态（不需要麦克风）**：`node bridge/asr-bridge.mjs --inbox <收件箱> --engine replay --replay bridge/sample-transcript.txt --truncate` 重放一段中葡对照的转写。
- **临时验证态**：用户口述或粘贴一段话，直接调 `leion_translate`。

**不要假装你能听见**。如果用户让你"实时听"却没给文本来源，就说明收件箱协议与那个桥，请他接上 ASR；同时用 `leion_translate` 或重放样例先把链路演示出来。

## 无真机时怎么演示

`transport: 'mock'` 时字幕打到 host 日志 + 留在内存，链路完整可跑。演示时：
- 用 `leion_selftest` 证明链路通；
- 用一葡一中两句对照，展示 `leion_translate` 的双向自动判向；
- 用 `leion_history` 展示双语对照记录；
- 说明换真机只需改 `CONFIG.transport` 一个字段（`mock` → `file`/`adb`）。

## 常见失败

| 现象 | 原因 | 处理 |
|---|---|---|
| `判不出源语种` | 输入太短（如 "ok"）或有大量英文 | 显式传 `from`，或问用户 |
| `ctx 里没有 llm 服务` | 该会话的插件 scope 里没有 llm | 让用户在你的会话里跑 `cordis_inspect_query { service: 'llm' }` 核实，或改用 `leion_display` 自己翻译后推送 |
| `拿不到模型 id` | 自动发现失败 | 把 `CONFIG.modelId` 写成具体模型名后重新 define |
| `模型流没有正常结束` | 上游报错/被截断 | 报告 `partial` 内容让用户判断，不要把它当成品显示 |
| `收件箱操作失败：未配置 inboxPath` | 这台部署还没接 ASR 桥 | 用 `leion_translate` 手动逐句；要自动同传就在 config 里配 `inboxPath` |
| 收件箱 `errors` 在涨 | 外部桥写的行格式不对（写了一半，或 JSON 缺 `text`） | 看 `lastError`；协议是**一行一句话**，且必须以换行结束 |
| 收件箱 `processed` 不涨 | `running: false`，或外部程序只写了半行 | `leion_inbox({action:'start'})`；或先 `drain` 排空一次 |
| 工具不存在 | 动态包在 DSH 重启后消失了 | 这是设计如此：让用户在新会话重新 define，或走正式插件包固化 |
