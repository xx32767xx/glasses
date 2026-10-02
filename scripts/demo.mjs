/**
 * demo.mjs —— 一键演示 CLI：把老师需要看到的东西跑起来
 * ============================================================================
 *
 *   node scripts/demo.mjs                # 离线例句表（不联网、零成本、可复现）
 *   node scripts/demo.mjs --live         # 真实模型翻译（走你已配置的 DeepSeek 凭据）
 *   node scripts/demo.mjs --delay 800    # 加快节奏
 *
 * 它做的事：
 *   1. 在工作区内的 .tmp/demo/ 生成一个真实的 Cordis 组合（cordis.yml）；
 *   2. 组合里挂的是**真的** dsh-tools / dsh-system-prompt / cordis-plugin-timer，
 *      以及本项目交付的 plugin/index.mjs；--live 时再挂真的 dsh-llm + deepseek 适配器；
 *   3. 用 vendor/cordis 的 loader 起进程，由 scripts/demo-driver.mjs 驱动整场演示。
 *
 * 结果是：**没有真机、没有麦克风**，也能把「ASR → 收件箱 → 翻译 → 排版 → 眼镜」这条
 * 双向同传链路完整跑一遍，并且把眼镜屏幕上显示的内容画出来。
 *
 * 组合文件是生成的（含绝对路径），所以不进版本库：它落在 .tmp/ 里。
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHECKOUT } from '../lib/real-tools.mjs'
import { ensureLoaderLinks, fileUrl } from '../lib/loader-links.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '')

/**
 * 数据目录（收件箱与字幕总线）留在工作区里，方便你事后翻看；
 * 组合目录必须建在系统临时区 —— 见下面 main() 里的说明。
 */
const DATA_DIR = join(ROOT, '.tmp', 'demo')

/** 检出里那些包用 file:// 绝对 URL 引用（本项目零依赖，包名解析不到它们）。 */
const pkg = relative => fileUrl(join(CHECKOUT, ...relative.split('/')))

function parseArgs(argv) {
  const options = { live: false, delay: 1500, pauseMs: 700 }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--live') options.live = true
    else if (token === '--delay') options.delay = Number(argv[++index])
    else if (token === '--pause-ms') options.pauseMs = Number(argv[++index])
    else if (token === '--help') options.help = true
    else throw new Error(`看不懂的参数：${token}（--live / --delay <ms> / --pause-ms <ms>）`)
  }
  if (!Number.isFinite(options.delay) || options.delay < 0) throw new Error('--delay 必须是非负数')
  if (!Number.isFinite(options.pauseMs) || options.pauseMs <= 0) throw new Error('--pause-ms 必须是正数')
  if (options.pauseMs >= options.delay) {
    throw new Error(`--pause-ms (${options.pauseMs}) 必须小于 --delay (${options.delay})，`
      + '否则桥的停顿断句还没触发下一句就来了，演示会变成一长句')
  }
  return options
}

const HELP = `一键演示：亮亮视野 Leion Pro · 中↔巴葡双向同传（不需要真机、不需要麦克风）

  node scripts/demo.mjs                 离线例句表：不联网、零成本、可复现
  node scripts/demo.mjs --live          真实模型翻译（走已配置的 DeepSeek 凭据）
  node scripts/demo.mjs --delay 800     每句之间的间隔（缺省 1500ms）
  node scripts/demo.mjs --pause-ms 500  桥的停顿断句阈值（缺省 700ms，必须小于 --delay）

演示流程：自检 → 用真实的 ASR 桥重放 14 句中葡剧本 → 逐帧画出眼镜屏幕 → 汇总统计
`

/** 生成组合文件。--live 时挂真实 llm 链路，否则挂离线例句表。 */
function buildComposition(options) {
  const busPath = join(DATA_DIR, 'subtitle-bus.json').replace(/\\/g, '/')
  const inboxPath = join(DATA_DIR, 'asr-inbox.jsonl').replace(/\\/g, '/')

  const llmRows = options.live
    ? `
# ── 真实翻译链路：与你 dsh web 里跑的是同一套适配器 ──────────────────────────
# provider 路由名是 deepseek-official；apiKey 逐请求从凭据存储解析
# （$DSH_HOME/.credentials.yaml 或环境里的 DEEPSEEK_API_KEY）。
- name: '${pkg('packages/llm/llm/lib/index.js')}'
- name: '${pkg('packages/credentials/credentials-local/lib/index.js')}'
- name: '${pkg('packages/settings/settings-file/lib/index.js')}'
- name: '${pkg('packages/llm/llm-deepseek/lib/index.js')}'
`
    : `
# ── 离线翻译链路：例句表驱动的假适配器（不联网、零成本、可复现） ─────────────
- name: '${fileUrl(join(ROOT, 'scripts', 'demo-phrasebook.mjs'))}'
`

  return `# 由 scripts/demo.mjs 生成 —— 请勿手改（改 scripts/demo.mjs）
#
# 这是一个**真实的 Cordis 组合**：下面每一行 dsh 包都是检出里的真实实现，
# 不是测试替身。唯一的替身是 ${options.live ? '（无，--live 用的是真适配器）' : '离线例句表适配器'}。
#
# Windows 提示：loader 走 ESM 动态 import，绝对路径必须是 file:// URL。

# 先挂 console logger：否则"模块解析失败/依赖没就绪"这类错误只进 logger 服务就丢了
- name: '@deepseek-ai/cordis-plugin-logger-console'

# 真实 timer 服务：插件的 inject 里有 'timer'（ASR 收件箱轮询用它）。
# 真实部署里它由 @deepseek-ai/dsh-base 挂着，所以这里必须补上，否则插件会停在 PENDING。
- name: '@deepseek-ai/cordis-plugin-timer'

- name: '${pkg('packages/core/system-prompt/lib/index.js')}'
- name: '${pkg('packages/core/tools/lib/index.js')}'
${llmRows}
# ── 本项目交付的插件（正式包，走绝对路径加载源码） ──────────────────────────
- name: '${fileUrl(join(ROOT, 'plugin', 'index.mjs'))}'
  config:
    # 进：ASR 收件箱。这就是"同传"而不是"翻译工具"的开关。
    inboxPath: '${inboxPath}'
    inboxPollMs: 150
    # 出：字幕总线。演示用它把"眼镜屏幕"画出来（mock 通道只打一行日志）。
    transport: 'file'
    sinkPath: '${busPath}'

# 收件箱要真的读写文件：最小组合里没有 fs 服务，用 node:fs 补一个
- name: '${fileUrl(join(ROOT, 'tests', 'live', 'fake-fs.mjs'))}'

# 演示驱动
- name: '${fileUrl(join(ROOT, 'scripts', 'demo-driver.mjs'))}'
  config:
    busPath: '${busPath}'
    inboxPath: '${inboxPath}'
    transcript: '${join(ROOT, 'bridge', 'sample-transcript.txt').replace(/\\/g, '/')}'
    replayDelayMs: ${options.delay}
    pauseMs: ${options.pauseMs}
    mode: '${options.live ? 'live' : 'offline'}'
`
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error('[demo] ' + String(error && error.message ? error.message : error))
    process.exitCode = 2
    return
  }
  if (options.help === true) {
    process.stdout.write(HELP)
    return
  }

  // 数据目录每次从干净状态开始（收件箱、字幕总线）
  await rm(DATA_DIR, { recursive: true, force: true })
  await mkdir(DATA_DIR, { recursive: true })

  // 组合目录建在**系统临时区**：它要装若干指回检出 vendor 的 junction，
  // 而那些 vendor 包互相链接 —— 放进仓库会形成符号链接环，git 递归撞"路径过长"，
  // 且 `git clean -xdf` 有顺着链接删到检出文件的风险。
  const composeDir = mkdtempSync(join(tmpdir(), 'leion-demo-'))
  const { created, skipped } = ensureLoaderLinks(composeDir)
  if (skipped.length > 0) {
    console.error(`[demo] 检出里缺少这些 vendor 包：${skipped.join(', ')}`)
    process.exitCode = 1
    return
  }
  if (created > 0) console.log(`[demo] 已建立 ${created} 个 vendor junction（${composeDir}）`)

  await writeFile(join(composeDir, 'cordis.yml'), buildComposition(options))
  console.log(`[demo] 组合已生成（系统临时区）：${composeDir}\\cordis.yml`)
  console.log(`[demo] 数据目录（收件箱 / 字幕总线）：.tmp/demo/`)
  console.log(`[demo] 翻译后端：${options.live ? '真实模型' : '离线例句表'}`)
  if (options.live) {
    console.log('[demo] ⚠️  --live 会调用真实模型接口（约 14 次短请求），会产生少量费用')
  }

  const bin = join(CHECKOUT, 'vendor', 'cordis', 'bin.js')
  const code = await new Promise(resolve => {
    // stdio: 'inherit' —— 受限沙箱下捕获子进程管道会 EPERM，inherit 不受影响，
    // 而且演示的输出本来就该直接进终端。
    const child = spawn(process.execPath, [bin], { cwd: composeDir, stdio: 'inherit' })
    child.on('exit', value => resolve(value === null ? 1 : value))
    child.on('error', error => {
      console.error('[demo] 无法启动 loader：' + String(error && error.message ? error.message : error))
      resolve(1)
    })
  })
  process.exit(code)
}

await main()
