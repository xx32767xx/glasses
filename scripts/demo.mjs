/**
 * demo.mjs —— 一键演示 CLI：把老师需要看到的东西跑起来
 * ============================================================================
 *
 *   node scripts/demo.mjs                # 离线例句表（不联网、零成本、可复现）
 *   node scripts/demo.mjs --live         # 真实模型翻译（走你已配置的 DeepSeek 凭据）
 *   node scripts/demo.mjs --delay 800    # 加快节奏
 *
 * 它做的事：
 *   1. 在工作区内的 var/demo/ 写演示数据（收件箱与字幕总线）；
 *   2. 组合里挂的是**真的** dsh-tools / dsh-system-prompt / cordis-plugin-timer，
 *      以及本项目交付的 plugin/index.mjs；--live 时再挂真的 dsh-llm + deepseek 适配器；
 *   3. 用 vendor/cordis 的 loader 起进程，由 scripts/demo-driver.mjs 驱动整场演示。
 *
 * 结果是：**没有真机、没有麦克风**，也能把「ASR → 收件箱 → 翻译 → 排版 → 眼镜」这条
 * 双向同传链路完整跑一遍，并且把眼镜屏幕上显示的内容画出来。
 *
 * 组合文件（cordis.yml）是现场生成的，落在系统临时区（含绝对路径，所以不进版本库）；
 * 演示数据落在 var/demo/，方便事后翻看。
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHECKOUT } from '../lib/real-tools.mjs'
import { ensureLoaderLinks } from '../lib/loader-links.mjs'
import { buildComposition as buildCompositionYaml, repoFile } from '../lib/composition.mjs'
import { DEMO_DIR, defaultBus, defaultInbox } from '../lib/paths.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '')

/**
 * 数据目录（收件箱与字幕总线）留在工作区里，方便你事后翻看；
 * 组合目录必须建在系统临时区 —— 见下面 main() 里的说明。
 */
const DATA_DIR = DEMO_DIR

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

/**
 * 生成组合文件。
 * 组合本体（真实 dsh 包 + 交付的插件）与 scripts/harness-side.mjs 共用同一份生成逻辑
 * （lib/composition.mjs），这里只多挂一个演示驱动。
 */
function buildComposition(options) {
  const busPath = defaultBus(DATA_DIR).replace(/\\/g, '/')
  const inboxPath = defaultInbox(DATA_DIR).replace(/\\/g, '/')

  return buildCompositionYaml({
    mode: options.live ? 'live' : 'offline',
    header: '# 一键演示组合（由 scripts/demo.mjs 生成）',
    pluginConfig: {
      // 进：ASR 收件箱。这就是"同传"而不是"翻译工具"的开关。
      inboxPath,
      inboxPollMs: 150,
      // 出：字幕总线。演示用它把"眼镜屏幕"画出来（mock 通道只打一行日志）。
      transport: 'file',
      sinkPath: busPath,
    },
    extraRows: [
      `- name: '${repoFile('scripts', 'demo-driver.mjs')}'
  config:
    busPath: '${busPath}'
    inboxPath: '${inboxPath}'
    transcript: '${join(ROOT, 'bridge', 'sample-transcript.txt').replace(/\\/g, '/')}'
    replayDelayMs: ${options.delay}
    pauseMs: ${options.pauseMs}
    mode: '${options.live ? 'live' : 'offline'}'`,
    ],
  })
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
  console.log(`[demo] 数据目录（收件箱 / 字幕总线）：var/demo/`)
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
