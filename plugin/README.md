# dsh-plugin-leion-pro

亮亮视野 (LLVision) **Leion Pro / GLXSS ME** AR 眼镜设备插件 + 中文↔巴西葡语双向同传。

在 DSH harness 里注册 7 个模型工具，把「一台亮亮眼镜」做成 agent 能驱动的设备；内置的
翻译管线走 harness 已配好的模型路由，不需要另外的 API key。

**两种用法**：agent 主动调 `leion_translate` 逐句翻；或者打开 **ASR 收件箱**，让外部语音识别
程序往一个文件里按行写文本，插件自动翻译并上屏 —— 后者才是真正的「同传」，不需要 agent 介入。

## 这个包的形状

```
plugin/
├── package.json              包清单（dsh.bundle.patch 指向 cordis.patch.yml）
├── cordis.patch.yml          bundle 层：按包名插入插件行（装进 profile 时用）
├── cordis.local.patch.yml    开发 overlay：按绝对路径插入（--patch 用）
├── index.mjs                 插件入口：导出 name / inject / apply(ctx, config)
├── core.mjs                  业务逻辑唯一来源（零 import）
└── schemas.generated.mjs     生成：由 core.mjs 的 DSL 编译出的原始 JSON Schema
```

**零第三方依赖**：不 import 任何 node_modules，所以不受 profile 模块解析约束。
`ctx.tools.register()` 接受原始 `ToolDefinition`，schema 由生成文件提供。

## 配置（cordis.yml 里插件行的 config 字段，全部可选）

| 字段 | 缺省 | 说明 |
|---|---|---|
| `transport` | `'mock'` | `'mock'` 只打日志/留内存；`'file'` 把当前字幕帧写成 JSON 给外部桥 |
| `sinkPath` | `''` | `transport: 'file'` 时必填，字幕总线文件的绝对路径 |
| `cols` / `lines` | `40` / `3` | AR 显示预算（半角列数 × 可见行数，汉字算 2 列） |
| `partialThrottleMs` | `400` | 流式字幕最短刷新间隔，防止逐字刷屏 |
| `providerId` / `modelId` | `''` | 翻译用的模型路由；留空则选第一个 provider 并尝试自动发现模型 |
| `maxTokens` / `temperature` | `400` / `0.2` | 翻译调用参数 |
| `inboxPath` | `''` | **ASR 收件箱**：非空则开启自动同传（轮询该文件） |
| `inboxPollMs` | `700` | 收件箱轮询间隔；配了 `inboxPath` 时必须 ≥ 100 |
| `inboxFrom` | `''` | 强制收件行的源语种（`'zh-CN'` / `'pt-BR'`）；留空逐行自动判定 |

### ASR 收件箱的协议（外部桥只要做一件事：追加一行）

```text
A reunião de hoje passou para as três da tarde.          ← 纯文本行：逐行自动判语向
{"text":"我们今天的会议改到下午三点。","speaker":"me"}      ← 或 JSON 行，可显式指定 from / to
```

- **只有以换行结束的完整行才会被处理**：写了一半的行不算，所以外部程序可以随时 flush。
- 坏行只计数、不中断：一条写坏的 JSON 不会让整条同传停摆。
- 文件被截断或轮转时自动从头重读，不会永远卡在旧偏移上。
- 翻译**串行**执行：并发会让字幕互相穿插，同传不能那样。

配置不合法会在**加载时**抛错（harness 约定：配置错误要响亮），不会留到运行期。

## 三种装载方式

```powershell
# A. 开发 overlay（需重启 dsh web；在检出根目录跑）
pnpm dsh web --patch E:\GlassesHarness\plugin\cordis.local.patch.yml

# B. 装进 profile（交付形态）
dsh plugin --profile web add E:\GlassesHarness\plugin
dsh --profile web
```

C. 往 `%DSH_HOME%\profiles\web\cordis.patch.yml` 加一个 `insert` 行（**不用重启**，该文件被 HMR 监视）。
详见 `../docs/02-创造模式加载指南.md`。

## 工具

`leion_status` · `leion_display` · `leion_translate` · `leion_history` · `leion_inbox` · `leion_clear` · `leion_selftest`

`leion_inbox` 的 `action`：`status` 查看 / `start` 启动轮询 / `stop` 停止 / `drain` 立刻处理一次 / `reset` 消费位置归零重放。

## 改这个包

```powershell
# 改 plugin/core.mjs，然后重新生成 schemas.generated.mjs 与 ../dynamic/leion-pro.host.js
node scripts/generate.mjs
node tests/run-all.mjs      # 64 项断言；两个包装版本必须逐字段一致
```

`schemas.generated.mjs` 是产物，**不要手改** —— 它由 `plugin/core.mjs` 的同一份 schema DSL
经检出里真实的 `defineTool` 编译得到，这样正式版与动态版不可能出现 schema 漂移。

## 验证状态

`tests/run-all.mjs` 对正式版复刻了 `ToolRuntime.register()` 的检查；`tests/live/run.mjs` 更进一步，
把本包装进**真实的 Cordis 组合**（检出里真实的 `dsh-tools` / `dsh-system-prompt`），于是：

- ✅ 7 个工具注册进**真实的 `ToolRuntime`**，出现在模型可见的 schema 里；
- ✅ 通过**真实执行流水线**调用 `leion_selftest` / `leion_display` / 双向 `leion_translate` 成功；
- ✅ 返回值过**真实的 `output.schema` 校验器**（含可空 `oneOf` 字段）；
- ✅ 缺必填参数的调用被真实流水线拒绝；
- ✅ **ASR 收件箱端到端**：外部往文件写一行 → **真实 `timer` 服务**轮询 → 真实流水线翻译 → 中文字幕。

**但还没有在用户自己的 `dsh web` 进程里加载过** —— 那需要重启，或往 profile 的
`cordis.patch.yml` 写一行（该文件被 HMR 监视，不用重启）。真实 `ctx.llm` / `ctx.fs`
的行为也待确认（组合验证里用的是假服务）。
