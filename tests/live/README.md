# 真实 Cordis 组合验证

`tests/run-all.mjs` 里的绝大多数断言跑在**复刻的**测试台上（复刻 `node:vm` 沙箱、
复刻 `ToolRuntime.register()` 的检查）。这个目录补上最后一环：把 `plugin/index.mjs`
装进一个**真实的 Cordis 应用**，用检出里真实的 `dsh-tools` / `dsh-system-prompt`，
于是

- `ctx.tools.register()` 是**真实实现**（不是复刻）；
- 模型可见的 schema 从**真实注册表**读出；
- 调用走**真实执行流水线**（identity 保护、策略、分发、结果归一化）；
- 返回值过**真实的 `output.schema` 校验器**；
- 定时用的是**真实的 `@deepseek-ai/cordis-plugin-timer`**（真实部署里由 base bundle 挂载的那个）。

```powershell
node tests/live/run.mjs        # 或 npm run verify:live
```

## 组成

| 文件 | 作用 |
|---|---|
| `composition.mjs` | **现场生成**组合的 cordis.yml：console logger + timer + system-prompt + tools + 被验证的插件（带收件箱配置）+ 假 llm + 假 fs + 探针 |
| `probe.mjs` | 观察者：断言 7 个工具已注册，驱动 selftest / 双向翻译 / display / 非法参数 / **桥端到端** |
| `fake-llm.mjs` | 假 `llm` 服务，让 `leion_translate` 能在真实流水线里跑成功（不联网、不需要 key） |
| `../../lib/fs-node.mjs` | 基于真实 node:fs 的 `fs` 服务，让收件箱真的读写文件（与演示/常驻进程共用同一个实现） |
| `run.mjs` | 一键跑：建临时组合目录 → 生成 cordis.yml → 支起 junction → spawn loader → 传播退出码 |

> **为什么组合是生成的，而不是仓库里放一个写死的 `cordis.yml`：**
> 那个文件得写死本仓库的绝对路径（`file:///E:/GlassesHarness/...`）**和 DSH 检出的绝对路径**
> （`file:///D:/DeepSeekHarness/...`）。而这两件事在别处都是动态探出来的（`lib/paths.mjs` 的
> `ROOT`、`lib/real-tools.mjs` 的 `CHECKOUT`）。仓库换个目录、或者检出挪个位置，这个验证就会以
> "模块解析失败"的样子挂掉，而报错完全指不到真正的原因。现在路径一律从代码里取。
> 想手动跑：`run.mjs` 会把生成的组合目录路径打出来，cd 进去执行 `<检出>/vendor/cordis/bin.js` 即可。

## 三个会让人卡半天的坑

1. **组合目录必须建在仓库之外（系统临时区）。**
   loader 要在 cwd 的 `node_modules/@deepseek-ai/` 下解析 `cordis-plugin-*`，所以组合目录
   必须有那些 junction；而那些 vendor 包**彼此也互相链接** —— 放进仓库就形成**符号链接环**：
   `git status --ignored` 会刷几百行"路径过长"警告，而 `git clean -xdf` 有顺着链接删到
   检出文件的风险。所以 `run.mjs` 用 `mkdtempSync` 在系统临时区建组合目录，只把
   **现场生成的** `cordis.yml` 写进去；验证代码仍留在仓库里。

2. **Windows 上绝对路径必须是 `file://` URL。**
   写 `D:/...` 会得到 `ERR_UNSUPPORTED_ESM_URL_SCHEME`；要写 `file:///D:/...`。相对路径
   （`./probe.mjs`）解析也不确定，所以统一用 `file://` 绝对 URL。

3. **加载失败默认是看不见的。**
   模块解析失败时 loader 只把它报给 logger 服务；组合里没有 console logger 的话，这条报告会在
   导出器开始观察之前丢失，表现成「插件好像没生效但没有任何错误」。所以第一行就是 logger-console。

4. **插件 `inject` 里写了什么服务，组合里就必须有，否则它会停在 PENDING。**
   这个坑真的踩到了：给插件加上 `inject: ['timer']`（收件箱轮询要用）之后，没挂 timer 的组合里
   插件直接 PENDING，探针 30 秒超时。所以生成的组合里有 `@deepseek-ai/cordis-plugin-timer`
   —— 真实部署里它由 `@deepseek-ai/dsh-base` 挂着，所以这个依赖是安全的。

5. **探针不能假设自己的 `apply` 晚于插件。**
   探针和插件都只 `inject: ['tools']`，谁先 apply 没有保证。所以探针监听 `tools/change` 等工具
   出现，而不是一上来就断言（早先的版本就在这里误报过「工具没注册」——其实是探针跑太快然后
   `process.exit` 了）。

## 这一层覆盖到的关键路径

| 检查 | 说明 |
|---|---|
| 工具注册 | 7 个工具出现在真实 `ToolRuntime` 的模型可见 schema 里 |
| 双向翻译 | 巴葡→中文（`displaySpeaker: them`）、中文→巴葡（`me` + 出站通道），返回值过真实校验器 |
| 参数校验 | 缺必填参数的调用被真实流水线拒绝 |
| 自检诊断 | 缺 llm / fs 时 `leion_selftest` 如实报红，补齐后五条全绿 |
| **桥 → 收件箱 → 真实 timer → 真实流水线** | 用真实的 `bridge/asr-bridge.mjs` 写入：json 行直接写；以及逐词到达、不换行时靠**停顿断句**合成整句。两条都被真实 timer 取走并翻译（已处理 2 条、错误 0 条） |

## 为什么这个组合里没有真的 LLM / fs

真实 `llm` 需要适配器与凭据，还会联网；真实 `fs` 会把验证耦合到路径收敛策略上。这里用假服务，
是为了让**插件契约**而不是外部依赖成为被测对象。`timer` 是真的，因为收件箱的正确性就依赖它。

## 这个验证没有覆盖什么

- **用户自己的 `dsh web` 进程**：那里加载需要重启或往 profile 的 `cordis.patch.yml` 写行。
  本目录的组合是独立的一次性进程，不影响正在跑的 GUI。
- **动态插件路线**：本目录只验证正式插件包；动态包走创造模式会话。
- **真实麦克风与真机**：桥与收件箱协议这一侧已验证（含真实 CLI），缺的是麦克风输入与眼镜协议。
