/**
 * debug-window.mjs —— 电脑端的「调试窗口」：实时显示手机上传的东西走到哪一步了
 * ============================================================================
 *   node scripts/debug-window.mjs
 *
 * 为什么需要它：
 *   这条链路有四个环节（手机 → 转发 → 识别 → 插件），任何一环不动，手机上都只是
 *   "什么都没发生"。而"什么都没发生"是最难查的形态 —— 没有报错、没有日志。
 *   这个窗口把四个环节的关键证据**并排**显示出来，一眼就能看出断在哪：
 *
 *     音频在涨、收件箱不动   → 识别进程没跑（或跑的不是这个文件）
 *     收件箱在涨、总线不动   → 插件没在消费（harness-side 没跑？或跑的是旧进程）
 *     总线在写、手机不显示   → 转发进程或手机的取字幕那一环有问题
 *     音频不涨               → 手机的音频没上来（看转发进程的日志）
 *
 * 它只**读**文件，不写任何东西，所以可以随时开着、随时 Ctrl-C，不影响链路。
 *
 * 用法
 *   node scripts/debug-window.mjs                    # 缺省盯 var/live
 *   node scripts/debug-window.mjs --data-dir var/demo
 *   node scripts/debug-window.mjs --url http://127.0.0.1:8788 --secret <密钥>   # 顺便问转发进程
 *   node scripts/debug-window.mjs --once             # 只打一次快照，不循环（给脚本用）
 */

import { readFile, stat, open } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { DEFAULT_DATA_DIR } from '../relay/lan-relay.mjs'
import { AUDIO_IN_NAME, AUDIO_LANG_NAME, AUDIO_RATE_NAME, BUS_NAME, INBOX_NAME } from '../lib/paths.mjs'

const HELP = `debug-window —— 电脑端的调试窗口（实时显示链路走到哪一步）

  node scripts/debug-window.mjs [选项]

  --data-dir <path>   盯哪个数据目录（缺省 var/live，与转发进程一致）
  --interval-ms <n>   刷新间隔（缺省 1000）
  --url <url>         顺便轮询转发进程的 /status（例如 http://127.0.0.1:8788）
  --secret <value>    /status 需要的共享密钥（转发进程启动时会打印）
  --once              只打一次快照就退出
  --help
`

function parseArgs(argv) {
  const options = { dataDir: DEFAULT_DATA_DIR, intervalMs: 1000, once: false }
  const takesValue = new Set(['data-dir', 'interval-ms', 'url', 'secret'])
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new Error(`看不懂的参数：${token}（用 --help 看用法）`)
    const key = token.slice(2)
    if (key === 'once') { options.once = true; continue }
    if (key === 'help') { options.help = true; continue }
    if (!takesValue.has(key)) throw new Error(`未知选项 --${key}（用 --help 看用法）`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} 需要一个值`)
    index += 1
    if (key === 'interval-ms') options.intervalMs = Number(value)
    else if (key === 'data-dir') options.dataDir = value
    else options[key] = value
  }
  return options
}

/** 读一个文件的文本与大小；不存在返回 null。 */
async function readText(path) {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return null
  }
}

/**
 * 读文件**末尾**若干个采样，算出电平。
 *
 * 为什么只看末尾：问的是"现在手机录到的声音有多大"。
 * 这也是判断"手机麦克风到底有没有在工作"的唯一直接办法 ——
 * 只看到"音频在涨"是不够的：字节在涨、里面全是静音，照样啥也识别不出来（真发生过）。
 */
async function tailLevel(path, seconds = 1.5) {
  try {
    const info = await stat(path)
    const want = Math.min(info.size, Math.round(seconds * 16000) * 2)
    if (want < 2) return null
    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(want - (want % 2))
      await handle.read(buffer, 0, buffer.length, info.size - buffer.length)
      const samples = buffer.length >> 1
      if (samples === 0) return null
      let peak = 0
      let sum = 0
      for (let i = 0; i < samples; i += 1) {
        const value = buffer.readInt16LE(i * 2) / 32768
        const magnitude = value < 0 ? -value : value
        if (magnitude > peak) peak = magnitude
        sum += value * value
      }
      return { peak, rms: Math.sqrt(sum / samples) }
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

async function sizeOf(path) {
  try {
    return (await stat(path)).size
  } catch {
    return null
  }
}

function ago(ms) {
  if (ms === null) return '—'
  const seconds = Math.round(ms / 1000)
  if (seconds < 1) return '刚刚'
  if (seconds < 60) return `${seconds}s 前`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${seconds % 60}s 前`
  return `${Math.floor(minutes / 60)}h${minutes % 60}m 前`
}

const clock = () => new Date().toTimeString().slice(0, 8)

/** 把一行日志压到固定宽度，终端里对齐好看。 */
function pad(text, width) {
  const value = String(text ?? '')
  // 中文按两格算，否则对齐会歪
  let shown = 0
  for (const char of value) shown += char.charCodeAt(0) > 0x2e80 ? 2 : 1
  if (shown > width) {
    let cut = ''
    let used = 0
    for (const char of value) {
      const cost = char.charCodeAt(0) > 0x2e80 ? 2 : 1
      if (used + cost > width - 1) break
      cut += char
      used += cost
    }
    return cut + '…'
  }
  return value + ' '.repeat(width - shown)
}

/** 取 /status；拿不到就返回 null（转发进程没起或密钥不对）。 */
async function fetchStatus(options) {
  if (!options.url) return null
  const url = new URL('/status', options.url)
  if (options.secret) url.searchParams.set('secret', options.secret)
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2500) })
    if (!response.ok) return { error: `HTTP ${response.status}` }
    return await response.json()
  } catch (error) {
    return { error: String(error && error.message ? error.message : error) }
  }
}

/**
 * 采一次快照：把四个环节的证据都读出来。
 * 单独抽成函数是为了 --once 和循环用同一份逻辑（不会出现"快照和实时显示不一样"）。
 */
export async function snapshot(options) {
  const { dataDir } = options
  const inboxPath = `${dataDir}/${INBOX_NAME}`
  const busPath = `${dataDir}/${BUS_NAME}`
  const audioPath = `${dataDir}/${AUDIO_IN_NAME}`
  const ratePath = `${dataDir}/${AUDIO_RATE_NAME}`
  const langPath = `${dataDir}/${AUDIO_LANG_NAME}`

  const now = Date.now()
  const [inboxText, busText, audioSize, rateText, langText, level, status] = await Promise.all([
    readText(inboxPath), readText(busPath), sizeOf(audioPath),
    readText(ratePath), readText(langPath), tailLevel(audioPath), fetchStatus(options),
  ])

  let audioAgo = null
  let busAgo = null
  let inboxAgo = null
  try { audioAgo = now - (await stat(audioPath)).mtimeMs } catch { /* 没有就算了 */ }
  try { busAgo = now - (await stat(busPath)).mtimeMs } catch { /* 同上 */ }
  try { inboxAgo = now - (await stat(inboxPath)).mtimeMs } catch { /* 同上 */ }

  const inboxLines = inboxText === null
    ? []
    : inboxText.split('\n').filter(line => line.trim() !== '')

  let bus = null
  if (busText !== null) {
    try { bus = JSON.parse(busText) } catch { bus = null }
  }

  const rate = rateText === null ? null : Number(rateText.trim())
  const seconds = (audioSize !== null && Number.isFinite(rate) && rate > 0)
    ? audioSize / 2 / rate
    : null

  return {
    dataDir, inboxPath, busPath, audioPath, status,
    audioBytes: audioSize, audioSeconds: seconds, audioAgo,
    rate: Number.isFinite(rate) ? rate : null,
    lang: langText === null ? null : langText.trim(),
    level,
    inboxLines, inboxCount: inboxLines.length, inboxAgo,
    bus, busAgo,
  }
}

function render(snap, previous) {
  const out = []
  out.push('')
  out.push('─'.repeat(74))
  out.push(`  调试窗口 · ${clock()} · 数据目录 ${snap.dataDir}`)
  out.push('─'.repeat(74))

  // ① 手机音频
  if (snap.audioBytes === null) {
    out.push(`  ① 手机音频   ✗ 还没有 audio-in.pcm（手机没上传过，或转发进程不在写）`)
  } else {
    const delta = previous && previous.audioBytes !== null ? snap.audioBytes - previous.audioBytes : null
    const growth = delta === null ? '' : (delta > 0 ? `  ↑ 本次 +${delta} 字节` : '  （没有增长）')
    out.push(`  ① 手机音频   ${pad(snap.audioSeconds === null ? '?' : snap.audioSeconds.toFixed(1) + 's', 8)}`
      + `${pad(snap.audioBytes + ' 字节', 16)}${pad(snap.rate === null ? '采样率?' : snap.rate + 'Hz', 12)}`
      + `${pad('语种 ' + (snap.lang ?? '?'), 14)}最后写入 ${ago(snap.audioAgo)}${growth}`)
    // 电平：区分"有音频"和"有声音"。字节在涨但全是静音，照样什么都识别不出来（真发生过）。
    if (snap.level) {
      const bars = Math.min(10, Math.round(snap.level.peak * 20))
      const bar = '█'.repeat(bars) + '·'.repeat(10 - bars)
      const warn = snap.level.peak < 0.02
        ? '   ⚠️ 最近这段几乎没有声音 —— 检查手机麦克风有没有被挡住/被别的应用占着'
        : ''
      out.push(`               ${pad('最近电平 ' + bar, 26)}峰值 ${snap.level.peak.toFixed(3)}`
        + `  RMS ${snap.level.rms.toFixed(4)}${warn}`)
    }
  }

  // ② 收件箱（识别结果）
  if (snap.inboxCount === 0) {
    out.push(`  ② 收件箱     ✗ 空的或不存在 —— 识别进程可能没跑（终端 3），或写到了别的文件`)
  } else {
    const last = snap.inboxLines[snap.inboxLines.length - 1]
    out.push(`  ② 收件箱     ${pad(snap.inboxCount + ' 行', 8)}最后写入 ${pad(ago(snap.inboxAgo), 10)}最新：${last}`)
  }

  // ③ 字幕总线（插件产出）
  if (snap.bus === null) {
    out.push(`  ③ 字幕总线   ✗ 不存在或不是合法 JSON —— 插件可能没在跑（harness-side）`)
  } else {
    const text = snap.bus.text ?? '(空)'
    out.push(`  ③ 字幕总线   ${pad('[' + (snap.bus.speaker ?? '?') + ' / ' + (snap.bus.lang ?? '?') + ']', 14)}`
      + `最后写入 ${pad(ago(snap.busAgo), 10)}${text}`)
    if (Array.isArray(snap.bus.lines)) {
      snap.bus.lines.forEach((line, index) => {
        out.push(`               ${index === 0 ? '│' : '│'} ${line}`)
      })
    }
  }

  // ④ 转发进程
  if (snap.status === null) {
    out.push('  ④ 转发进程   （没查：加 --url http://127.0.0.1:8788 --secret <密钥> 可以顺便查它）')
  } else if (snap.status.error) {
    out.push(`  ④ 转发进程   ✗ 查不到：${snap.status.error}`)
  } else {
    const s = snap.status
    out.push(`  ④ 转发进程   收音频 ${pad(s.audioBytes + ' 字节/' + s.audioChunks + ' 块', 22)}`
      + `收文字 ${pad(s.says + ' 句', 10)}字幕 ${pad(s.frames + ' 帧', 10)}拒绝 ${s.rejected}`)
  }

  // 判断断在哪一环
  out.push('')
  out.push('  ' + diagnose(snap, previous))
  out.push('─'.repeat(74))
  return out.join('\n')
}

/**
 * 根据四个环节的变化，直接给出"断在哪"的判断。
 * 这是这个窗口存在的意义：让"什么都没发生"变成一个具体的结论。
 */
export function diagnose(snap, previous) {
  const audioGrowing = previous && snap.audioBytes !== null && previous.audioBytes !== null
    ? snap.audioBytes > previous.audioBytes
    : null
  const inboxGrowing = previous ? snap.inboxCount > previous.inboxCount : null
  const busChanged = previous && snap.bus && previous.bus
    ? snap.bus.at !== previous.bus.at
    : null

  // 第一次采样（没有上一份可比）：只能看"现状像不像通的"
  if (previous === null) {
    if (snap.audioBytes === null) {
      // 一点音频都没有，最常见的原因就是"手机在跟一个旧代码的转发进程说话"（它没有 /audio 端点，
      // 手机会直接报 404）或者根本没点按钮。所以这里要把这两条都点出来。
      return '→ 还没有任何音频：先确认①手机点了「开始录音上传」；'
        + '②转发进程是**新代码**（改过代码后必须重启，Node 不会热加载）。'
    }
    // 音频到了但里面没声音 —— 此时"识别进程没跑"和"麦克风没录到"表现完全一样，
    // 必须靠电平区分，否则会朝着错的方向查。
    if (snap.level && snap.level.peak < 0.02) {
      return '→ 音频到了，但**里面几乎没有声音**（峰值 ' + snap.level.peak.toFixed(3) + '）：'
        + '手机没录到人声。对着手机说一句，看这里的电平会不会上去。'
    }
    if (snap.inboxCount === 0) {
      return '→ 音频到了，但收件箱是空的：**识别进程没跑**（终端 3）。'
        + '音频已经躺在电脑上了，把它转成文字就能继续。'
    }
    const fresh = snap.busAgo !== null && snap.busAgo < 120000
    if (snap.bus === null) {
      return '→ 音频和文字都到了，但没有字幕总线：**插件没在跑**（harness-side 没起，或起来就退了）。'
    }
    return fresh
      ? `→ 三个环节都有数据，字幕 ${ago(snap.busAgo)}还更新过 —— 链路是通的。`
        + '手机上没显示的话，问题在手机取字幕那一环（试试断开重连）。'
      : `→ 三个环节都有数据，但字幕已经 ${ago(snap.busAgo)}没动过 —— 说明最近这句话没走完，`
        + '看着下面几行的变化判断断在哪。'
  }

  if (snap.audioBytes === null) {
    return '→ 音频文件还不存在（刚被清掉？）：确认手机还在录音上传，且转发进程没重启过。'
  }
  // 音频在涨但里面没有声音 —— 这时"识别进程没跑"和"麦克风没录到"长得一模一样，
  // 必须靠电平区分，否则会让人朝着错的方向查一整天。
  if (snap.level && snap.level.peak < 0.02 && audioGrowing !== false) {
    return '→ 音频在涨，但**里面几乎没有声音**（峰值 ' + snap.level.peak.toFixed(3) + '）。'
      + '这不是链路问题，是手机没录到人声：对着手机说句话看看电平会不会上去；'
      + '不上去就检查麦克风被挡住、或被别的应用占着。'
  }
  if (audioGrowing === true && inboxGrowing === false) {
    return '→ 音频在涨、收件箱不动：**识别进程那头的问题**（终端 3 起了吗？是不是盯的同一个文件？）'
  }
  if (inboxGrowing === true && busChanged === false && snap.bus) {
    return '→ 收件箱在涨、字幕不动：**插件没在消费**（harness-side 在跑吗？是不是旧进程？）'
  }
  if (busChanged === true) {
    return '→ 字幕刚更新过：这一句走完了。手机上看不到就是手机取字幕那一环（试试断开重连）。'
  }
  if (audioGrowing === false && inboxGrowing === false) {
    return '→ 都没有新数据：安静期。说一句话看看（记得说完停顿约 0.7 秒）。'
  }
  return '→ 观察中…'
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) { process.stdout.write(HELP); return 0 }
  if (!Number.isFinite(options.intervalMs) || options.intervalMs < 100) {
    throw new Error(`--interval-ms 至少 100，收到 ${options.intervalMs}`)
  }

  let previous = null
  if (options.once) {
    const snap = await snapshot(options)
    process.stdout.write(render(snap, null) + '\n')
    return 0
  }

  process.stdout.write(`[debug-window] 开始监视 ${options.dataDir}，每 ${options.intervalMs}ms 刷新一次。`
    + `Ctrl-C 结束。\n`)
  if (!options.url) {
    process.stdout.write('[debug-window] 提示：加上 --url http://127.0.0.1:8788 --secret <密钥>'
      + ' 可以顺便显示转发进程收到的字节数。\n')
  }

  let stopping = false
  const stop = () => { stopping = true }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  while (!stopping) {
    const snap = await snapshot(options)
    // 用 \x1b[2J\x1b[H 清屏重画：多次刷新不会把终端刷满
    process.stdout.write('\x1b[2J\x1b[H')
    process.stdout.write(render(snap, previous) + '\n')
    previous = snap
    if (stopping) break
    await new Promise(resolve => setTimeout(resolve, options.intervalMs))
  }
  process.stdout.write('\n[debug-window] 已停止（没有对链路做任何修改）。\n')
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => process.exit(code)).catch(error => {
    console.error('[debug-window] ❌ ' + String(error && error.message ? error.message : error))
    process.exit(1)
  })
}
