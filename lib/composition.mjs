/**
 * composition.mjs —— 生成「真实 Cordis 组合」的 cordis.yml
 * ============================================================================
 * scripts/demo.mjs（一次性演示）与 scripts/harness-side.mjs（常驻，配合局域网转发）
 * 用的是同一套真实组合，只差「翻译后端」和「有没有驱动插件」两处，所以生成逻辑放这里共用。
 *
 * 组合里每一行 dsh 包都是检出里的**真实实现**，不是测试替身（唯一的替身是离线例句表）。
 *
 * Windows 上有个坑：loader 走 ESM 动态 import，绝对路径**必须**是 file:// URL，
 * 写成 D:/… 会得到 ERR_UNSUPPORTED_ESM_URL_SCHEME。
 */

import { join } from 'node:path'
import { CHECKOUT } from './real-tools.mjs'
import { fileUrl } from './loader-links.mjs'
import { LIVE_DIR, ROOT as ROOT_DIR } from './paths.mjs'

export const ROOT = ROOT_DIR

/** 检出里某个包的构建产物，转成 file:// URL。 */
export const checkoutPackage = relative => fileUrl(join(CHECKOUT, ...relative.split('/')))

/** 本仓库里某个文件的 file:// URL。 */
export const repoFile = (...parts) => fileUrl(join(ROOT, ...parts))

/**
 * 默认数据目录：收件箱与字幕总线放这里，harness 侧与转发进程靠这对文件对接。
 * 定义在 lib/paths.mjs（唯一的路径来源），这里只是转发一下，方便调用方少 import 一个。
 */
export const LIVE_DATA_DIR = LIVE_DIR

/**
 * 拼出 translate 后端那几行。
 *   live    —— 与 dsh web 里跑的是同一套适配器：dsh-llm + 凭据 + 设置 + DeepSeek 适配器
 *              路由名是 deepseek-official，apiKey 逐请求从凭据存储解析
 *              （$DSH_HOME/.credentials.yaml 或环境里的 DEEPSEEK_API_KEY）
 *   offline —— 例句表驱动的假适配器：不联网、零成本、可复现，但只认得剧本里那 14 句
 */
function llmRows(mode) {
  if (mode === 'live') {
    return `
# ── 真实翻译链路：与你 dsh web 里跑的是同一套适配器 ──────────────────────────
- name: '${checkoutPackage('packages/llm/llm/lib/index.js')}'
- name: '${checkoutPackage('packages/credentials/credentials-local/lib/index.js')}'
- name: '${checkoutPackage('packages/settings/settings-file/lib/index.js')}'
- name: '${checkoutPackage('packages/llm/llm-deepseek/lib/index.js')}'
`
  }
  return `
# ── 离线翻译链路：例句表驱动的假适配器（不联网、零成本、可复现） ─────────────
- name: '${repoFile('scripts', 'demo-phrasebook.mjs')}'
`
}

/**
 * 生成一份完整的组合文件内容。
 * @param opts.mode 'live' | 'offline'
 * @param opts.pluginConfig 传给 plugin/index.mjs 的 config
 * @param opts.extraRows 额外的插件行（例如演示驱动），字符串数组
 * @param opts.header 顶部注释
 */
export function buildComposition({ mode, pluginConfig, extraRows = [], header = '' }) {
  const configLines = Object.entries(pluginConfig)
    .map(([key, value]) => `    ${key}: ${typeof value === 'string' ? `'${value}'` : value}`)
    .join('\n')

  return `${header}
# 由 lib/composition.mjs 生成 —— 请勿手改。
#
# 这是一个**真实的 Cordis 组合**：下面每一行 dsh 包都是检出里的真实实现，
# 不是测试替身${mode === 'live' ? '（--live 用的是真适配器）' : '（唯一的替身是离线例句表适配器）'}。
#
# 组合目录必须建在仓库之外：里面会有指回检出 vendor 的 junction，而那些包互相链接，
# 放进仓库会形成符号链接环（git 递归撞"路径过长"，git clean -xdf 有删到检出文件的风险）。

# 第一行就挂 console logger：否则"模块解析失败 / 依赖没就绪"这类错误只进 logger
# 服务，在 console 导出器开始观察之前就丢了，表现成"插件好像没生效但没有任何错误"。
- name: '@deepseek-ai/cordis-plugin-logger-console'

# 真实 timer 服务：插件的 inject 里有 'timer'（ASR 收件箱轮询用它）。真实部署里它由
# @deepseek-ai/dsh-base 挂着，所以这里必须补上，否则插件会停在 PENDING。
- name: '@deepseek-ai/cordis-plugin-timer'

- name: '${checkoutPackage('packages/core/system-prompt/lib/index.js')}'
- name: '${checkoutPackage('packages/core/tools/lib/index.js')}'
${llmRows(mode)}
# ── 本项目交付的插件（正式包，按绝对路径加载源码） ──────────────────────────
- name: '${repoFile('plugin', 'index.mjs')}'
  config:
${configLines}

# 收件箱与字幕总线要真的读写文件：最小组合里没有 fs 服务，用 node:fs 补一个
- name: '${repoFile('lib', 'fs-node.mjs')}'
${extraRows.length === 0 ? '' : '\n' + extraRows.join('\n') + '\n'}`
}
