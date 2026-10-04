/**
 * harness-side.mjs —— 常驻的「harness 侧」进程
 * ============================================================================
 *
 *   node scripts/harness-side.mjs              # 真实模型翻译（走已配置的 DeepSeek 凭据）
 *   node scripts/harness-side.mjs --offline    # 离线例句表（不联网、零成本）
 *
 * 它起一个**真实的 Cordis 组合**（真的 dsh-tools / dsh-system-prompt / timer，
 * 以及本项目交付的 plugin/index.mjs），配置成文件模式：
 *
 *     收件箱  var/live/asr-inbox.jsonl    ← 手机的文字从这里进来
 *     字幕总线 var/live/subtitle-bus.json  → 字幕从这里出去
 *
 * 配合 relay/lan-relay.mjs 就构成完整的手机 ↔ 电脑链路：
 *
 *     手机 ──► 转发进程 ──► 收件箱 ──► 本进程（翻译）──► 字幕总线 ──► 转发进程 ──► 手机
 *
 * 为什么用独立进程而不是装进你的 dsh web：
 *   · 不用改你的 profile 配置，也不用重启 GUI（装进 dsh web 需要授权，见 docs/02）；
 *   · 可以随时独立重启、独立看日志；
 *   · 转发进程只跟这两个文件打交道，所以将来你把插件装进 dsh web，删掉本进程即可，
 *     转发进程与手机端一行都不用改。
 *
 * 注意：组合目录建在系统临时区。里面会有指回检出 vendor 的 junction，而那些包彼此
 * 也互相链接 —— 放进仓库会形成符号链接环（git 递归撞"路径过长"，`git clean -xdf`
 * 有顺着链接删到检出文件的风险）。
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHECKOUT } from '../lib/real-tools.mjs'
import { ensureLoaderLinks } from '../lib/loader-links.mjs'
import { buildComposition, LIVE_DATA_DIR, repoFile } from '../lib/composition.mjs'
import { defaultBus, defaultInbox } from '../lib/paths.mjs'

const HELP = `harness-side —— 常驻的 harness 侧进程（给手机 + 局域网转发用）

  node scripts/harness-side.mjs [选项]

选项
  --offline             用离线例句表翻译，不联网、零成本（只认得剧本里那 14 句）
  --data-dir <path>     收件箱与字幕总线所在目录（缺省 var/live）
  --inbox <path>        收件箱文件（缺省 <data-dir>/asr-inbox.jsonl）
  --bus <path>          字幕总线文件（缺省 <data-dir>/subtitle-bus.json）
  --cols <n>            AR 显示宽度（缺省 40；眼镜到手后按实测改）
  --lines <n>           AR 可见行数（缺省 3；眼镜到手后按实测改）
  --poll-ms <n>         收件箱轮询间隔（缺省 150）
  --keep-inbox          保留收件箱里的旧内容（缺省会先清空，见下）
  --help

关于收件箱：**默认先清空**。
  上一次运行留下的行会被插件重新翻译一遍，于是每次启动都先冒出几句旧字幕，
  看起来像"刚收到了东西"。对常驻同传来说收件箱的语义应该是"这次运行收到了什么"。
  想看旧内容被重放就加 --keep-inbox。

配套启动（三个终端）：
  1) node scripts/harness-side.mjs
  2) node relay/lan-relay.mjs
  3) node bridge/asr-bridge.mjs --inbox var/live/asr-inbox.jsonl \`
       --whisper-follow var/live/audio-in.pcm --whisper-device cuda --whisper-compute float16
  想随时看链路状态：node scripts/debug-window.mjs
`

export function parseArgs(argv) {
  const options = { mode: 'live', dataDir: LIVE_DATA_DIR, cols: 40, lines: 3, pollMs: 150, keepInbox: false }
  const takesValue = new Set(['data-dir', 'inbox', 'bus', 'cols', 'lines', 'poll-ms'])
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--offline') { options.mode = 'offline'; continue }
    if (token === '--keep-inbox') { options.keepInbox = true; continue }
    if (token === '--help') { options.help = true; continue }
    if (!token.startsWith('--')) throw new Error(`看不懂的参数：${token}（用 --help 看用法）`)
    const key = token.slice(2)
    if (!takesValue.has(key)) throw new Error(`未知选项 --${key}（用 --help 看用法）`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} 需要一个值`)
    index += 1
    if (key === 'data-dir') options.dataDir = value
    else if (key === 'inbox') options.inbox = value
    else if (key === 'bus') options.bus = value
    else if (key === 'cols') options.cols = Number(value)
    else if (key === 'lines') options.lines = Number(value)
    else options.pollMs = Number(value)
  }
  if (options.help === true) return options
  for (const key of ['cols', 'lines', 'pollMs']) {
    if (!Number.isInteger(options[key]) || options[key] <= 0) {
      throw new Error(`${key} 必须是正整数，收到 ${JSON.stringify(options[key])}`)
    }
  }
  options.inbox = options.inbox ?? defaultInbox(options.dataDir)
  options.bus = options.bus ?? defaultBus(options.dataDir)
  return options
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error('[harness-side] ' + String(error && error.message ? error.message : error))
    process.exitCode = 2
    return
  }
  if (options.help === true) {
    process.stdout.write(HELP)
    return
  }

  mkdirSync(options.dataDir, { recursive: true })

  // ── 收件箱：默认从干净的开始 ────────────────────────────────────────────
  // 为什么默认清空：上一次运行留下的行会被插件**重新翻译一遍**，于是每次启动都先
  // 冒出几句莫名其妙的旧字幕（"今天的会议改到下午三点"之类），看起来像是刚收到了东西。
  // 对"常驻同传"来说，收件箱的语义应该是"这次运行收到了什么"，所以默认从空开始。
  // 想保留旧内容（比如想手动重放一遍）就加 --keep-inbox。
  let droppedLines = 0
  if (!options.keepInbox) {
    try {
      const old = readFileSync(options.inbox, 'utf-8')
      droppedLines = old.split('\n').filter(line => line.trim() !== '').length
      writeFileSync(options.inbox, '', 'utf-8')
    } catch {
      // 文件还不存在是正常的（第一次跑）
    }
  }

  const composition = buildComposition({
    mode: options.mode,
    header: '# harness 侧常驻组合（由 scripts/harness-side.mjs 生成）',
    pluginConfig: {
      transport: 'file',
      sinkPath: options.bus,
      inboxPath: options.inbox,
      inboxPollMs: options.pollMs,
      cols: options.cols,
      lines: options.lines,
    },
    extraRows: [`- name: '${repoFile('lib', 'keepalive.mjs')}'`],
  })

  const composeDir = mkdtempSync(join(tmpdir(), 'leion-side-'))
  const { created, skipped } = ensureLoaderLinks(composeDir)
  if (skipped.length > 0) {
    console.error(`[harness-side] 检出里缺少这些 vendor 包：${skipped.join(', ')}`)
    process.exitCode = 1
    return
  }
  writeFileSync(join(composeDir, 'cordis.yml'), composition)

  console.log('')
  console.log('─'.repeat(68))
  console.log('  harness 侧已启动（亮亮眼镜插件 · 文件模式）')
  console.log('─'.repeat(68))
  console.log(`  翻译后端    ${options.mode === 'live' ? '真实模型（deepseek-official）' : '离线例句表（只认得剧本 14 句）'}`)
  console.log(`  收件箱      ${options.inbox}`)
  if (options.keepInbox) {
    console.log('              （保留了旧内容：--keep-inbox，旧行会被重新翻译一遍）')
  } else if (droppedLines > 0) {
    console.log(`              （启动时清掉了上次留下的 ${droppedLines} 行旧内容；想保留加 --keep-inbox）`)
  }
  console.log(`  字幕总线    ${options.bus}`)
  console.log(`  显示预算    ${options.cols} 列 × ${options.lines} 行`)
  if (created > 0) console.log(`  组合目录    ${composeDir}`)
  console.log('')
  console.log('  下一步：另一个终端跑  node relay/lan-relay.mjs')
  console.log('─'.repeat(68))
  console.log('')

  const bin = join(CHECKOUT, 'vendor', 'cordis', 'bin.js')
  const code = await new Promise(resolve => {
    const child = spawn(process.execPath, [bin], { cwd: composeDir, stdio: 'inherit' })
    child.on('exit', value => resolve(value === null ? 1 : value))
    child.on('error', error => {
      console.error('[harness-side] 无法启动 loader：' + String(error && error.message ? error.message : error))
      resolve(1)
    })
  })
  process.exit(code)
}

await main()
