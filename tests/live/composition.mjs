/**
 * composition.mjs —— 生成「真实 Cordis 组合」的 cordis.yml（tests/live 专用）
 * ============================================================================
 * 为什么是生成，而不是仓库里放一个写死的 cordis.yml：
 *   原来那个文件里写着 `file:///E:/GlassesHarness/...` 和
 *   `file:///D:/DeepSeekHarness/deepseek-harness/...`。也就是说它假设了
 *   ① 本仓库在 E 盘、叫 GlassesHarness；② DSH 检出在 D 盘那个固定位置。
 *   而这两件事在别处都是**动态探出来**的（lib/paths.mjs 的 ROOT、
 *   lib/real-tools.mjs 的 CHECKOUT）。把仓库换个目录、或者 DSH 检出挪个位置，
 *   这个验证就会以"模块解析失败"的样子挂掉，而且报错完全指不到真正的原因。
 *   所以改成运行时生成：路径一律从 lib/paths.mjs 与检出探测结果来。
 *
 *   想手动跑（不经过 run.mjs）也可以：run.mjs 会把生成的组合目录路径打出来，
 *   cd 进去执行 <检出>/vendor/cordis/bin.js 即可（loader 从 cwd 读 cordis.yml）。
 *
 * 组合里为什么要这几行：
 *   · 第一行必须是 console logger —— 否则"模块解析失败"这类错误只进 logger 服务，
 *     在 console 导出器开始观察之前就丢了，表现成"插件似乎没生效但没有任何错误"。
 *   · 必须挂真实 timer —— 插件的 inject 里有 'timer'（ASR 收件箱轮询用它）。
 *     真实部署里它由 @deepseek-ai/dsh-base 挂着；这里不补，插件会停在 PENDING。
 *   · system-prompt / tools 用**编译产物的 file:// 绝对路径**，而不是包名：
 *     本项目零依赖（没有 node_modules），包名只能在检出树内部解析。
 *   · @deepseek-ai/cordis-plugin-* 走包名 —— 它们由 lib/loader-links.mjs 建的
 *     junction 提供。
 *
 * Windows 坑：loader 走 ESM 动态 import，绝对路径**必须**写成 file:// URL，
 * 写成 D:/... 会得到 ERR_UNSUPPORTED_ESM_URL_SCHEME。
 */

import { checkoutPackage, repoFile } from '../../lib/composition.mjs'
import { TEST_INBOX } from '../../lib/paths.mjs'

export const buildLiveComposition = () => `# 真实 Cordis 组合（由 tests/live/composition.mjs 生成，请勿手改）
# 目的：让 plugin/index.mjs 注册进**真实的 ToolRuntime**，而不是测试台复刻的检查器，
#       并通过**真实的工具执行流水线**跑几次调用；再用**真实的 timer 服务**验证 ASR 收件箱
#       （外部写一行 → 自动翻译 → 字幕上屏）这条不需要 agent 介入的同传路径。
- name: '@deepseek-ai/cordis-plugin-logger-console'

- name: '@deepseek-ai/cordis-plugin-timer'

- name: '${checkoutPackage('packages/core/system-prompt/lib/index.js')}'

- name: '${checkoutPackage('packages/core/tools/lib/index.js')}'

# 被验证的对象：正式插件包（按绝对路径加载源码）
- name: '${repoFile('plugin', 'index.mjs')}'
  config:
    transport: 'mock'
    # 打开 ASR 收件箱：这就是"不需要 agent 介入"的自动同传路径
    inboxPath: '${TEST_INBOX.replace(/\\/g, '/')}'
    inboxPollMs: 150

# 假 llm 与真实 node:fs 的 fs 服务：让 leion_translate 与收件箱都能在真实流水线里跑成功
# （假 llm 让验证不联网、不需要 key；fs 服务是共用的 lib/fs-node.mjs）
- name: '${repoFile('tests', 'live', 'fake-llm.mjs')}'
- name: '${repoFile('lib', 'fs-node.mjs')}'

# 观察者：检查注册结果并驱动真实调用。收件箱路径从 config 传进去，
# 免得"探针里写一个、组合里写一个"两处各存一份、然后漂移。
- name: '${repoFile('tests', 'live', 'probe.mjs')}'
  config:
    inboxPath: '${TEST_INBOX.replace(/\\/g, '/')}'
`
