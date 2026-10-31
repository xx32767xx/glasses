/**
 * lan-relay.mjs —— 手机 ↔ 电脑 的局域网转发进程
 * ============================================================================
 *
 * 为什么需要它，而不是让插件自己开端口：
 *   DSH 的 web server 确实支持插件挂路由（ctx.webServer.register / registerUpgrade），
 *   但它的监听地址默认是 127.0.0.1，手机连不上；要改 0.0.0.0 才能让局域网访问。
 *   而那份文档自己写着：「there is no TLS, auth, or origin policy, so a non-loopback
 *   bind exposes the server to that network」—— 也就是说，为了让手机连上，得把
 *   **整个 harness 的 API（背后是能执行任意命令的工具）无认证地暴露给局域网**。
 *   那在校园网/宿舍/公司 WiFi 上不可接受。
 *
 *   所以改成这个独立小进程：只暴露 4 个端点，全部要求共享密钥，而且**不依赖插件是否
 *   已装载**（它只跟收件箱/字幕总线两个文件打交道）。
 *
 * 数据流（两侧都只是文件，所以这个进程不认识 harness，harness 也不认识它）：
 *
 *     手机 ──POST /say──► 收件箱文件 ──► leion-pro 插件（harness）
 *     手机 ◄─GET /frame── 字幕总线文件 ◄── leion-pro 插件
 *
 * 4 个端点（全部 JSON，全部要密钥）
 *   GET  /hello              握手：验证密钥 + 取回显示预算（cols/lines）与当前帧序号
 *   POST /say                手机把识别出的文字交给电脑
 *   GET  /frame?since=<seq>  取字幕帧；没有新帧就挂住最多 pollHoldMs（长轮询）
 *   GET  /status             诊断计数
 *
 * 用法
 *   node relay/lan-relay.mjs                    # 默认 0.0.0.0:8788
 *   node relay/lan-relay.mjs --port 9000 --secret mykey
 *   node relay/lan-relay.mjs --help
 */

import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, appendFile, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createInboxWriter } from '../bridge/asr-bridge.mjs'
import { appendUtterance, purgeUtterancesIn } from '../lib/db.mjs'
import {
  LIVE_DIR, defaultAudioIn, defaultAudioLang, defaultAudioRate, defaultBus, defaultInbox, defaultSecret,
  defaultSettings,
} from '../lib/paths.mjs'
import { lintTranslation } from '../lib/translation-lint.mjs'
import { handleOrg } from './org-api.mjs'
import { createWsHub } from '../lib/ws-hub.mjs'
import { publishMeetingTerms, readCurrentMeeting } from '../lib/meeting-terms.mjs'
import { loadSelection } from './org-api.mjs'
import { listMembers, resolveFrameRoom, setMemberLang } from '../lib/rooms.mjs'
import { floorState } from '../lib/floor.mjs'
import {
  TERMS_LIMITS, getTable, loadTerms, mergePending, normalizeUser, putTable, saveActiveUser, saveTerms, validateTerms,
} from '../lib/terms.mjs'
import {
  ACCOUNT_LIMITS, hasAccounts, issueCode, loadAccounts, login, recordOf, registerWithEmail, revokeToken,
  roleOf, saveAccounts, userForToken, verifyCode,
} from '../lib/accounts.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '')

/** 字幕清理的扫描间隔（小时级足够：早删一小时晚删一小时都无所谓）。 */
const UTTERANCE_SWEEP_MS = 60 * 60 * 1000

/**
 * 转发进程的**能力清单**（写进 /hello 与 /status）。
 *
 * <p>为什么需要它：手机上"注册失败：not-found"这种提示，用户根本猜不到是因为
 * **电脑上跑的还是旧版进程**（没有 `/auth/*` 端点）。与其让人对着 404 猜，
 * 不如让这一端把自己的能力报出来，手机据此说人话。
 */
export const RELAY_FEATURES = ['hello', 'say', 'audio', 'frame', 'status', 'diag', 'lint', 'terms', 'settings', 'auth', 'org', 'floor-ws', 'frame-ws', 'room-closed-push', 'session-push']

/**
 * 默认数据目录：和 scripts/harness-side.mjs 指向同一对文件，两边靠它对接。
 * 具体路径来自 lib/paths.mjs —— 那是唯一的来源，别在这里再写字面量。
 */
export const DEFAULT_DATA_DIR = LIVE_DIR

/** 每次请求体上限。字幕/一句话都很短，超过这个大小基本不是正常客户端。 */
const MAX_BODY_BYTES = 8 * 1024

/**
 * 音频心跳的聚合间隔（毫秒）。见 `logAudioChunk` 的注释：
 * 一秒钟一块 = 一秒钟两行，会把日志淹掉；聚合到 5 秒一行，
 * 同时用"块 12–17（6 块）"的写法保证块号可核，不会造成"像丢了数据"的假象。
 */
const AUDIO_LOG_MS = 5000
/**
 * "这个房间最近的说话人"多久算过期（4.96）。
 *
 * <p>字幕在**说完之后**几秒才产生（切句要等静音 + 识别 + 翻译），所以不能用
 * "此刻谁持麦"，而要用"刚才谁上传了音频"。但也不能太久 —— 一个人说完、另一个人才开口，
 * 中间隔几十秒很正常；超时后就不能把新的一句记到旧的人名下（宁可显示「无」）。
 * 90 秒的时间窗覆盖"说完这句 → 字幕出来"的整段链路（实测通常 3~10 秒）。
 */
const SPEAKER_TTL_MS = 90 * 1000
/**
 * 音频请求体的上限，单独一档。
 * 1 秒 16 kHz 单声道 PCM 就是 32000 字节，用上面那个 8 KB 的限额会把正常录音直接拒掉。
 * 1 MB 够手机一次传 32 秒；平时手机每秒传一块，远低于这个数。
 */
const MAX_AUDIO_BYTES = 1024 * 1024

/** 允许的录音采样率：16 kHz 是 Whisper 要的，44.1/48 kHz 是安卓降级时的常见值。 */
const ALLOWED_RATES = [16000, 44100, 48000]

/** 允许的语种标记（与收件箱行的 from 字段同一套取值）。 */
// 5.00：中 / 英 / 葡三种。**译成哪种由会议的目标语言决定**（rooms.target_lang），
// 不再靠 opposite(源语言) 猜 —— 三种语言时"对面"不唯一。
const LANGS = ['zh-CN', 'pt-BR', 'en-US']

/**
 * 显示预算的兜底值：只有在还没收到任何字幕帧时才用得上。
 * 收到帧之后一律用帧里的 cols / lineBudget —— 那是插件配置的唯一来源，
 * 避免"眼镜多大"这件事在插件和继电器各存一份、然后漂移。
 */
const FALLBACK_COLS = 40
const FALLBACK_LINES = 3

const HELP = `lan-relay —— 手机 ↔ 电脑 的局域网转发进程

  node relay/lan-relay.mjs [选项]

选项
  --port <n>            监听端口（缺省 8788）
  --host <addr>         监听地址（缺省 0.0.0.0，即允许局域网访问）
  --secret <value>      共享密钥；缺省自动生成并保存到 --data-dir/relay-secret.txt
  --data-dir <path>     收件箱与字幕总线所在目录（缺省 var/live）
  --inbox <path>        收件箱文件（缺省 <data-dir>/asr-inbox.jsonl）
  --bus <path>          字幕总线文件（缺省 <data-dir>/subtitle-bus.json）
  --audio <path>        手机上传的原始音频落盘位置（缺省 <data-dir>/audio-in.pcm）
  --audio-rate <path>   采样率旁文件（缺省 <data-dir>/audio-in.rate）
  --audio-lang <path>   语种旁文件（缺省 <data-dir>/audio-in.lang）
  --poll-hold-ms <n>    长轮询最长挂起时间（缺省 25000）
  --bus-poll-ms <n>     字幕总线轮询间隔（缺省 60）
  --audio-max-bytes <n> 音频文件上限（缺省 1 GB，0 = 不轮转）。**只增不减的文件**：
                        超过就把旧的改名成 <audio>.1 再开一个新的，磁盘占用约 2×上限。
                        为什么是"轮转"而不是原地清空：原地清空会把**还没被识别读走的**
                        音频永久删掉（那样一段话就没了），轮转至少留着上一份可供排查。
  --utterance-retention-days <n>
                        字幕保留天数（缺省 7）：超过的按天自动删除（隐私要求，
                        见 docs/21 §10 的 P4）。启动时先清一次，之后每小时清一次。
  --public              公网部署模式：强制强密钥 + 每 IP 限流 + 音频总量上限
                        **绑到公网地址时必须加这个**（见 docs/10）
  --lint                译文质检：每个定稿帧拿原文对一遍，报"确定错/警告"（**缺省就开**）
                        判据见 lib/translation-lint.mjs（专名新造、数字/房间号丢失、
                        性数不一致、量级错）。**只报不改**，不改字幕、不影响延迟。
  --no-lint             关掉译文质检
  --quiet               关掉调试输出（收到的音频/文字/字幕都不打印）
  --verbose             每一块音频都打印（缺省是每秒汇总一行）
  --help

端点（手机侧要用）
  GET  /hello              带密钥 → { device, cols, lineBudget, seq }
  POST /say                {"text":"...","from":"pt-BR"} → 追加进收件箱
  POST /audio              原始音频（PCM S16LE 单声道）→ 追加到 --audio 文件
                             ?rate=16000 采样率；?lang=pt-BR 语种；?fresh=1 表示新录音开头（先清空）
  GET  /frame?since=<seq>  长轮询取字幕帧
  GET  /status             诊断

所有请求都要带密钥：请求头 X-Leion-Secret: <密钥>（或 ?secret=<密钥>，便于浏览器里试）
`

/**
 * 公网部署的硬限制。
 *
 * <p>为什么需要单独一组：局域网里"谁能连上"本身就已经是一层门槛，
 * 公网上没有这层门槛 —— **任何扫到端口的人都能发请求**。
 * 没有这些限制时，最现实的破坏不是"破解密钥"（48 位随机数暴力不可行），
 * 而是**往 /audio 灌垃圾**：转发进程会一直 append 到磁盘，
 * 把服务器磁盘写满，然后整个服务（包括正在跑的识别）一起挂掉。
 */
export const PUBLIC_LIMITS = {
  /** 公网模式下密钥至少这么长（缺省随机生成的是 12 个 hex = 太短）。 */
  minSecretChars: 24,
  /** 每个 IP 每分钟最多多少请求（正常手机侧：音频约每秒 1 次 + 字幕长轮询）。 */
  maxRequestsPerMinutePerIp: 600,
  /** 每个 IP 每分钟最多能灌多少音频字节。16k 单声道 = 32KB/s，给 4 倍余量。 */
  maxAudioBytesPerMinutePerIp: 8 * 1024 * 1024,
  /** 音频文件总量上限；到顶就拒收，避免把服务器磁盘写满。 */
  maxAudioBytesTotal: 1024 * 1024 * 1024,
  /** 限流窗口。 */
  windowMs: 60 * 1000,
}

/**
 * 每 IP 的滑动窗口计数。抽成独立函数是为了能直接测 —— 限流写错
 * 会把**正常用户**挡在外面，比不设限流更糟。
 */
export function createRateLimiter({ windowMs, maxRequests }) {
  const hits = new Map()
  return {
    /** @returns {boolean} true = 放行，false = 超限 */
    allow(key, now = Date.now()) {
      const entry = hits.get(key)
      if (entry === undefined || now - entry.start >= windowMs) {
        hits.set(key, { start: now, count: 1, bytes: 0 })
        return true
      }
      entry.count += 1
      return entry.count <= maxRequests
    },
    /** 音频字节数单独计，因为"一次请求"可能是 1KB 也可能是几 MB。 */
    allowBytes(key, bytes, maxBytes, now = Date.now()) {
      const entry = hits.get(key)
      if (entry === undefined || now - entry.start >= windowMs) {
        hits.set(key, { start: now, count: 1, bytes })
        return bytes <= maxBytes
      }
      entry.bytes += bytes
      return entry.bytes <= maxBytes
    },
    /** 清掉过期窗口，避免 Map 无限增长（长期运行的服务必须做）。 */
    sweep(now = Date.now()) {
      for (const [key, entry] of hits) {
        if (now - entry.start >= windowMs) hits.delete(key)
      }
    },
    size() {
      return hits.size
    },
  }
}

export function parseArgs(argv) {  const options = { port: 8788, host: '0.0.0.0', pollHoldMs: 25000, busPollMs: 60, quiet: false, lint: true, utteranceRetentionDays: 7, audioMaxBytes: 1024 * 1024 * 1024 }
  const takesValue = new Set(['port', 'host', 'secret', 'data-dir', 'inbox', 'bus', 'audio', 'audio-rate', 'audio-lang', 'poll-hold-ms', 'bus-poll-ms', 'utterance-retention-days', 'audio-max-bytes'])
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new Error(`看不懂的参数：${token}（用 --help 看用法）`)
    const key = token.slice(2)
    if (key === 'quiet') { options.quiet = true; continue }
    if (key === 'verbose') { options.verbose = true; continue }
    if (key === 'public') { options.public = true; continue }
    if (key === 'help') { options.help = true; continue }
    // 译文质检**缺省开**：它只读不改、不拖慢字幕，而"现在到底错多少"还没有基线。
    // 不想看就 --no-lint。
    if (key === 'lint') { options.lint = true; continue }
    if (key === 'no-lint') { options.lint = false; continue }
    if (!takesValue.has(key)) throw new Error(`未知选项 --${key}（用 --help 看用法）`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} 需要一个值`)
    index += 1
    if (key === 'port') options.port = Number(value)
    else if (key === 'poll-hold-ms') options.pollHoldMs = Number(value)
    else if (key === 'bus-poll-ms') options.busPollMs = Number(value)
      else if (key === 'utterance-retention-days') options.utteranceRetentionDays = Number(value)
      else if (key === 'audio-max-bytes') options.audioMaxBytes = Number(value)
    else if (key === 'data-dir') options.dataDir = value
    else if (key === 'inbox') options.inbox = value
    else if (key === 'bus') options.bus = value
    else if (key === 'audio') options.audio = value
    else if (key === 'audio-rate') options.audioRate = value
    else if (key === 'audio-lang') options.audioLang = value
    else options[key] = value
  }
  if (options.help === true) return options
  if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) {
    throw new Error(`--port 必须是 1..65535 的整数，收到 ${JSON.stringify(options.port)}`)
  }
  for (const key of ['pollHoldMs', 'busPollMs', 'utteranceRetentionDays']) {
    if (!Number.isFinite(options[key]) || options[key] <= 0) {
      throw new Error(`${key} 必须是正数，收到 ${JSON.stringify(options[key])}`)
    }
  }
  options.dataDir = options.dataDir ?? DEFAULT_DATA_DIR
  options.inbox = options.inbox ?? defaultInbox(options.dataDir)
  options.bus = options.bus ?? defaultBus(options.dataDir)
  // 4.86：`--bus` 传目录 = 每个房间一份总线（并发用）；传文件 = 老用法
  const busIsDir = String(options.bus).endsWith('/') || String(options.bus).endsWith('\\')
    || existsSync(options.bus) && statSync(options.bus).isDirectory()
  if (busIsDir === true) {
    try { mkdirSync(options.bus, { recursive: true }) } catch { /* 建不出来就等下轮 */ }
  }
  options.audio = options.audio ?? defaultAudioIn(options.dataDir)
  options.audioRate = options.audioRate ?? defaultAudioRate(options.dataDir)
  options.audioLang = options.audioLang ?? defaultAudioLang(options.dataDir)
  return options
}

/**
 * 本机的局域网地址（带网卡名），用来告诉用户手机上该填什么。
 * 一定要带网卡名：这台机器上就有 VMware 虚拟网卡，只看 IP 会让人填错。
 */
export function lanAddresses() {
  const out = []
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === 'IPv4' && entry.internal === false) out.push({ name, address: entry.address })
    }
  }
  return out
}

/**
 * 算一块 PCM 的电平（峰值 / RMS）。
 *
 * 为什么要算：用户遇到的是"手机发录音了，但什么都没发生"。查下来发现
 * **上传的音频基本是静音**（峰值 0.019、RMS 0.0012，而正常说话的峰值能到 1.0）。
 * 也就是说链路是好的，问题在"手机根本没录到人声"。
 * 而这是从日志里完全看不出来的 —— 只看到"收到音频"，看不出里面有没有声音。
 * 所以每块都报一次电平，并对"明显没声音"的情况直接给出警告。
 *
 * 阈值取 0.02：正常对着手机说话的峰值一般 > 0.1；安静说话也有 0.02~0.05；
 * 低于 0.02 说明要么没说话、要么麦克风被挡住/被别的应用占着。
 */
export function pcmLevel(buffer) {
  const samples = buffer.length >> 1
  if (samples === 0) return { peak: 0, rms: 0, samples: 0 }
  let peak = 0
  let sum = 0
  for (let i = 0; i < samples; i += 1) {
    const value = buffer.readInt16LE(i * 2) / 32768
    const magnitude = value < 0 ? -value : value
    if (magnitude > peak) peak = magnitude
    sum += value * value
  }
  return { peak, rms: Math.sqrt(sum / samples), samples }
}

/** 把电平转成一句人话 + 一个直观的条形。 */
export function describeLevel(level) {
  const bars = Math.min(10, Math.round(level.peak * 20))       // 峰值 0.5 → 满格
  const bar = '█'.repeat(bars) + '·'.repeat(10 - bars)
  const text = `音平 ${bar} 峰值 ${level.peak.toFixed(3)} RMS ${level.rms.toFixed(4)}`
  if (level.peak < 0.02) return `${text}  ⚠️ 这一块几乎没有声音（人声一般峰值 > 0.1）`
  return text
}

/** 看起来像虚拟网卡的（VMware / VirtualBox / Hyper-V / WSL），提示用户别填这些。 */
function looksVirtual(name) {
  return /vmware|virtualbox|hyper-v|vethernet|wsl|loopback|tap|tun|docker|zerotier|tailscale/i.test(name)
}

/**
 * 启动横幅。
 *
 * **单独抽成纯函数**，不是为了好看，是为了能被测试：这段横幅原来直接写在 main() 里，
 * 而测试套件只调用 startRelay()（库入口），从不走 main() —— 于是横幅里一个写错的变量名
 * （`${secret}` 而实际叫 `relay.secret`）能在测试全绿的情况下**让转发进程一启动就崩**。
 * 真的发生了，是靠手动跑一次才发现。现在它被测试逐行盯着。
 */
/**
 * 公网模式的启动清单。
 *
 * <p>为什么要把这些打出来：绑到公网和绑到局域网是**两件不同性质的事**。
 * 局域网里"能不能连上"本身就是一层门槛；公网上没有这层门槛，
 * 任何扫到端口的人都能发请求。这些提醒如果只写在文档里，部署的人不会看到。
 */
export function formatPublicChecklist(options, relay) {
  const lines = []
  lines.push('')
  lines.push('─'.repeat(68))
  lines.push('  ⚠️ 公网部署模式已开启（--public）')
  lines.push('─'.repeat(68))
  lines.push(`  已启用：密钥至少 ${PUBLIC_LIMITS.minSecretChars} 字符 · 每 IP 限流 `
    + `${PUBLIC_LIMITS.maxRequestsPerMinutePerIp} 次/分 · 音频总量上限 `
    + `${(PUBLIC_LIMITS.maxAudioBytesTotal / 1024 / 1024).toFixed(0)} MB`)
  lines.push('')
  lines.push('  还需要你自己确认的三件事：')
  lines.push('')
  lines.push('  ① 外面套一层 TLS —— 现在这个是**明文 HTTP**，')
  lines.push('     密钥和音频在公网上是裸奔的。推荐 Caddy（自动证书）：')
  lines.push('       your.domain.com {')
  lines.push(`         reverse_proxy 127.0.0.1:${relay.port}`)
  lines.push('       }')
  lines.push(`     然后手机填 https://your.domain.com（让反代把 :443 转到这里）`)
  lines.push('     · 在反向代理后面时，务必让反代**覆盖** X-Real-IP，')
  lines.push('       否则限流会把所有请求算成同一个 IP。')
  lines.push('')
  lines.push('  ② 安全组 / 防火墙只放开你真正要用的端口')
  lines.push(`     （绑到 0.0.0.0:${relay.port} 时，端口一旦放开就是全网可见）`)
  lines.push('')
  lines.push('  ③ 进程要常驻（systemd），别用 nohup 挂着 —— 服务器重启后要能自己起来')
  lines.push('     见 docs/10-服务器部署.md')
  lines.push('')
  lines.push(`  密钥（手机上要填这个，**不要贴到任何公开的地方**）：`)
  lines.push(`      ${relay.secret}`)
  lines.push('─'.repeat(68))
  return lines.join('\n')
}

export function formatBanner(options, relay, addresses = []) {
  const lines = []
  const real = addresses.filter(a => !looksVirtual(a.name))
  const virtual = addresses.filter(a => looksVirtual(a.name))
  lines.push('')
  lines.push('─'.repeat(68))
  lines.push('  亮亮眼镜 · 局域网转发已启动')
  lines.push('─'.repeat(68))
  lines.push(`  收件箱（手机的文字进这里）  ${options.inbox}`)
  lines.push(`  字幕总线（字幕从这里出去）  ${options.bus}`)
  lines.push(`  录音上传（手机音频落这里）  ${options.audio}`)
  lines.push(`  共享密钥（手机上要填这个）  ${relay.secret}`)
  lines.push('')
  lines.push('  手机端「录音上传」还需要另一个进程把音频变成文字（识别在电脑上跑）：')
  lines.push(`      node bridge/asr-bridge.mjs --inbox "${options.inbox}" --whisper-follow "${options.audio}" \\`)
  lines.push('        --whisper-device cuda --whisper-compute float16')
  lines.push('  （Pascal 卡如 Tesla P40 没有 FP16 加速，把 float16 换成 int8_float32；')
  lines.push('    不确定就跑 python scripts/check-asr-env.py，它会直接告诉你该用哪档）')
  lines.push('  （不要写成 python … | node … 管道：PowerShell 会缓冲 stdout，而识别进程一直不退出，')
  lines.push('    于是桥一行都收不到。见 bridge/whisper_stream.py 头部说明。）')
  lines.push('')
  lines.push('  想看链路走到哪一步（另开一个终端，只读不改）：')
  lines.push(`      node scripts/debug-window.mjs --url http://127.0.0.1:${relay.port} --secret ${relay.secret}`)
  lines.push('')
  lines.push('  手机上的地址填（要和电脑在同一个 WiFi）：')
  if (real.length > 0) {
    for (const a of real) lines.push(`      http://${a.address}:${relay.port}      ← ${a.name}`)
  } else {
    lines.push('      （没找到真实网卡地址，检查 WiFi 是否连着）')
  }
  if (virtual.length > 0) {
    lines.push('  这些是虚拟网卡，手机连不上，别填：')
    for (const a of virtual) lines.push(`      ${a.address}  (${a.name})`)
  }
  lines.push('')
  lines.push('  自检（在电脑浏览器或 curl 里试）：')
  lines.push(`      curl "http://127.0.0.1:${relay.port}/status?secret=${relay.secret}"`)
  lines.push('─'.repeat(68))
  lines.push('')
  return lines.join('\n')
}

/** 读出（或生成并保存）共享密钥。 */
export async function resolveSecret(options) {
  const minChars = options.public === true ? PUBLIC_LIMITS.minSecretChars : 0
  if (typeof options.secret === 'string' && options.secret !== '') {
    if (options.secret.length < minChars) {
      throw new Error(`--public 模式下密钥至少 ${minChars} 个字符，`
        + `当前只有 ${options.secret.length} 个。换一个长一点的。`)
    }
    return options.secret
  }
  const path = defaultSecret(options.dataDir)
  try {
    const existing = (await readFile(path, 'utf-8')).trim()
    // 公网模式下，磁盘上那个短的旧密钥不能直接用：它当初是按局域网生成的
    // （12 个 hex = 48 位），放在公网上太短。这里重新生成一个长的并覆盖。
    if (existing !== '' && existing.length >= minChars) return existing
  } catch { /* 还没有，下面生成 */ }
  const bytes = options.public === true ? 24 : 6
  const generated = randomBytes(bytes).toString('hex')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, generated + '\n', 'utf-8')
  return generated
}

/** 定长比较，避免用 === 比较密钥时的时序差异。 */
function secretMatches(expected, given) {
  if (typeof given !== 'string' || given === '') return false
  const a = createHash('sha256').update(expected).digest()
  const b = createHash('sha256').update(given).digest()
  return a.equals(b)
}

/**
 * 请求的来源 IP。
 *
 * <p>⚠️ 只看 `X-Forwarded-For` 的**最后一跳**是不对的，但整条链都不可信 ——
 * 那是客户端可以随便伪造的头。放在反代（Caddy/nginx）后面时，
 * 应当让反代**覆盖**这个头，并且只信任反代自己加的那一段。
 * 这里取最常见也最安全的做法：有 `X-Real-IP` 就用它（Caddy/nginx 默认会设），
 * 否则用 socket 的对端地址 —— **永远不用 X-Forwarded-For 的第一个值**，
 * 因为那个值完全由客户端决定，用它做限流等于没限流（改个头就绕过）。
 */
export function clientIp(request) {
  const real = request.headers['x-real-ip']
  if (typeof real === 'string' && real.trim() !== '') return real.trim()
  const socket = request.socket
  if (socket === undefined || socket === null) return 'unknown'
  // IPv4-mapped IPv6（::ffff:10.0.0.1）在双栈监听时很常见，显示成 IPv4 更易读
  const address = socket.remoteAddress ?? 'unknown'
  return address.startsWith('::ffff:') ? address.slice(7) : address
}

/**
 * 房间音频文件路径（4.84）。
 *
 * <p>文件名用房间 id **消毒后**的形式：`room-mvt9t5q9-vdkk` → `room-mvt9t5q9-vdkk.pcm`。
 * 为什么要消毒：房间 id 来自请求参数，直接拼路径就是目录穿越（`../`）。
 * 只允许字母数字下划线与连字符，其余一律换成 `_`。
 *
 * <p>放在 `<data-dir>/audio/` 下，与全局的 `audio-in.pcm` 相邻：
 * 单房间场景照旧读全局文件，多房间场景各读各的。
 */
export function roomAudioPath(dataDir, roomId) {
  const safe = String(roomId ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
  return join(String(dataDir), 'audio', (safe === '' ? 'unknown' : safe) + '.pcm')
}

/**
 * 一场会的**分轨目录**（5.08）：`audio/<房间>/`，里面每个说话人一个 `<说话人>.pcm`。
 *
 * <p>为什么必须按人分：一个房间一条音频流时，语种旁文件 `<pcm>.lang` 是**最后写入者获胜**。
 * 两个人交替用不同语言说话（这个产品的常态），切出来的段就会带着**上一个人**的语种 ——
 * 于是"英语被当成中文识别""中文被当成英语识别"，而语言这件事下游怎么修都是补丁。
 * 分轨之后，每一路都有自己的 `.rate` / `.lang` 与自己的切句器。
 */
export function roomTrackDir(dataDir, roomId) {
  const safe = String(roomId ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
  return join(String(dataDir), 'audio', safe === '' ? 'unknown' : safe)
}

/** 某个人在这场会里的音频文件（`audio/<房间>/<说话人>.pcm`）。 */
export function roomSpeakerAudioPath(dataDir, roomId, speaker) {
  const safe = String(speaker ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
  return join(roomTrackDir(dataDir, roomId), (safe === '' ? 'unknown' : safe) + '.pcm')
}

/**
 * 删掉一场会议**留在磁盘上的东西**（4.99，管理员清理历史时用）。
 *
 * <p>这些文件的路径规则只有这个进程知道，所以清理也放在这里 —— 让 org-api 那边
 * 重新拼一遍路径，迟早会拼错（拼错就是删掉别人的文件）。
 *
 * <p>逐类处理，**任何一类失败都不影响其它类**（清理是一次性动作，不该因为一个被占住的
 * 文件就整批失败）：
 * <ul>
 *   <li>`audio/<房间>.pcm` 与它的 `.rate` / `.lang` 旁文件（原始录音，最占地方）；</li>
 *   <li>`buses/<房间>.json`（目录模式每场一份；**单文件模式绝不动** —— 那是所有房间共用的）；</li>
 *   <li>`asr-inbox-<房间>.jsonl`（收件箱按房间分文件）。</li>
 * </ul>
 *
 * @returns {number} 实际释放的字节数（删不掉的按 0 算）
 */
export function removeRoomDataFiles(dataDir, roomIds, busPath = '') {
  let freed = 0
  const kill = (file) => {
    try {
      const size = statSync(file).size
      unlinkSync(file)
      freed += Number(size ?? 0)
    } catch { /* 不存在 / 被占着：跳过 */ }
  }
  const bus = String(busPath ?? '')
  let busIsDir = false
  try {
    busIsDir = bus !== '' && (bus.endsWith('/') || bus.endsWith('\\')
      || (existsSync(bus) === true && statSync(bus).isDirectory()))
  } catch { busIsDir = false }
  for (const roomId of Array.isArray(roomIds) ? roomIds : []) {
    const id = String(roomId ?? '').trim()
    if (id === '') continue
    // 5.08：分轨目录 `audio/<房间>/`（每人一个文件 + 旁文件）整棵删
    try {
      const dir = roomTrackDir(dataDir, id)
      for (const entry of readdirSync(dir)) {
        try { freed += Number(statSync(join(dir, entry)).size ?? 0) } catch { /* 已在别处删掉 */ }
      }
      rmSync(dir, { recursive: true, force: true })
    } catch { /* 没有这个目录 */ }
    // 旧数据（4.84 时代）是单文件 + 旁文件，仍然要删，否则升级前的库永远清不干净
    const audio = roomAudioPath(dataDir, id)
    kill(audio)
    kill(audio + '.rate')
    kill(audio + '.lang')
    kill(join(dataDir, `asr-inbox-${id}.jsonl`))
    if (busIsDir === true) kill(join(bus, `${id}.json`))
  }
  return freed
}

/**
 * 启动转发进程。
 * @returns { server, close, state, secret, port } —— 测试直接用这个，不必起 CLI
 */
export async function startRelay(rawOptions = {}) {
  const options = Object.assign({
    port: 0, host: '127.0.0.1', pollHoldMs: 25000, busPollMs: 60,
    dataDir: DEFAULT_DATA_DIR, quiet: true, utteranceRetentionDays: 7,
    audioMaxBytes: 1024 * 1024 * 1024,
  }, rawOptions)
  options.inbox = options.inbox ?? defaultInbox(options.dataDir)
  options.bus = options.bus ?? defaultBus(options.dataDir)
  options.audio = options.audio ?? defaultAudioIn(options.dataDir)
  options.audioRate = options.audioRate ?? defaultAudioRate(options.dataDir)
  options.audioLang = options.audioLang ?? defaultAudioLang(options.dataDir)
  const secret = await resolveSecret(options)
  await mkdir(options.dataDir, { recursive: true })

  // 公网模式才启用限流；局域网模式下它只会带来误伤的风险
  const limiter = createRateLimiter({
    windowMs: PUBLIC_LIMITS.windowMs,
    maxRequests: PUBLIC_LIMITS.maxRequestsPerMinutePerIp,
  })
  /**
   * 登录/注册专用的额度桶：**10 次 / 10 分钟**。
   *
   * <p>它和公网限流分开，而且更严 —— 目的是防"把密码试出来"，
   * 而不是防刷屏。局域网模式下公网限流是关的，但这一条**始终生效**
   * （密码被暴力猜中的后果，与在不在公网无关）。
   */
  const authLimiter = createRateLimiter({ windowMs: 10 * 60_000, maxRequests: 10 })
  /** 定期清过期窗口 —— 长期运行的服务不能让 Map 无限长。 */
  const sweepTimer = options.public === true
    ? setInterval(() => limiter.sweep(), PUBLIC_LIMITS.windowMs).unref()
    : null

  /**
   * 调试输出：默认**开着**（除了 --quiet）。
   *
   * 为什么默认开：手机上传音频之后如果电脑端一声不响，用户完全无法判断
   * "音频到底有没有上来" —— 这正是最难查的形态（不报错、也没反应）。
   * 所以收到东西就在这个终端里打一行。怕刷屏的话用 --quiet 关掉，
   * 或者用 --verbose 看每一块（缺省是每秒汇总一次）。
   */
  const debug = options.quiet
    ? () => {}
    : (...args) => console.log(`[${new Date().toTimeString().slice(0, 8)}]`, ...args)
  /** 音频按秒汇总，避免每秒好几行把终端刷爆 */
  let audioLogAt = 0

  /**
   * 合并"待入表"队列（B 方案，docs/15 §18.2）。
   *
   * <p>只在两个时点做：relay **启动时**、手机请求 `/hello`（= 一场的开始）时。
   * 这样"表更新"永远发生在**场与场之间**，不会打断正在跑的会话（插件每场读一次快照）；
   * 而 relay 是正式表唯一的写者，插件只追加队列 —— 没有并发写者。
   * 失败绝不影响转发：它是旁路学习，不是字幕的必要条件。
   */
  async function mergePendingTerms(where) {
    try {
      const result = await mergePending(options.dataDir)
      if (result.merged > 0 || result.rejected.length > 0 || result.skipped > 0) {
        const extra = result.rejected.length === 0 ? '' : `，拒绝 ${result.rejected.length}`
        const detail = result.rejectedFile === null ? '' : `（明细见 ${result.rejectedFile}）`
        debug(`🗂 待入表合并（${where}）：合入 ${result.merged} 条，跳过 ${result.skipped}${extra}${detail}`)
      }
      return result
    } catch (error) {
      debug(`⚠️ 待入表合并失败（已忽略）：${error?.message ?? error}`)
      return null
    }
  }
  await mergePendingTerms('启动')

  const state = {
    /** 已读到的字幕总线原始内容（内容变了才算新帧） */
    busRaw: '',
    /** 总线是目录（每房间一份）还是单文件（4.86） */
    busIsDir: String(options.bus).endsWith('/') || String(options.bus).endsWith('\\')
      || (existsSync(options.bus) && statSync(options.bus).isDirectory()),
    /** 目录模式下每个文件的上次内容 */
    busRawByFile: new Map(),
    /** 单调递增的帧序号：手机用它做 since，避免重复渲染 */
    seq: 0,
    /** 最近一帧 */
    lastFrame: null,
    /** 按房间存的帧（4.74）：多场会并发时互不覆盖。roomId -> {seq, frame} */
    framesByRoom: new Map(),
    /** 每个房间自己的序号（手机只关心自己那条流）。 */
    seqByRoom: new Map(),
    /** 最近一次往哪个房间上传了音频（归属的重要线索）。 */
    audioRoomId: '',
    /** 已经为哪些房间建过分流文件（用来"每个房间只打一行日志"） */
    audioRoomFiles: new Set(),
    audioRoomAt: 0,
    /** how many chunks were actually fanned out (debug) */
    audioFanoutChunks: 0,
    /**
     * 每个房间**已经告诉过**听的人的采样率（4.91）。
     *
     * <p>只在变化时发一帧 `audio-meta`：每块都发会把 WS 消息量翻倍，
     * 而采样率在一次录音里几乎不变（最多开始时协商一次）。
     */
    roomRateAnswered: new Map(),
    /**
     * 每个房间**最近的说话人**（4.96）：`roomId → { name, at }`。
     *
     * <p>由 `/audio?speaker=`（或 token）写入，发布字幕时读出来当这一帧的发言人。
     * 为什么要 TTL：一个人说完、另一个人开口之间可能隔很久；超时之后就不能把新的一句
     * 记到旧的人名下 —— 宁可显示「无」，也不要张冠李戴。
     */
    roomSpeaker: new Map(),
    /** 每个房间**上一次**告诉过大脑的听者语言集合（5.00：只在变化时写盘） */
    roomLangsSent: new Map(),
    /** 每个房间收了多少字节音频（4.84 分流用；也给 /audio/rooms 报） */
    roomAudioBytes: new Map(),
    /**
     * 每个房间**已经写进 `<pcm>.lang` 的那个语种**（5.05）。
     *
     * <p>为什么要记：识别端读的就是那个旁文件。如果手机从来没上报过语种（或者上报的
     * 是别的房间），旁文件就没有/是旧的，识别端于是"不知道这段是什么语言" ——
     * 而日志上只看得到"识别端语种限定生效"这种下游现象，看不出根因在**上游没写**。
     * 所以这里在**值变化时**打一行，把"这一场的语种到底是什么"钉在转发日志里。
     */
    roomLangWritten: new Map(),
    /** 复位日志限流用（4.81） */
    resetLogAt: 0,
    resetBurst: 0,
    resetBurstAt: 0,
    /** 最近的帧 JSON（供 /hello、/status 用） */
    hello: null,
    /** 长轮询里挂着的等待者 */
    waiters: new Set(),
    /** 计数 */
    sayCount: 0,
    frameCount: 0,
    rejected: 0,
    /** 被限流拒掉的请求数（公网模式下才有意义）。 */
    rateLimited: 0,
    /** 手机回传的诊断行数（见 /diag）。用来确认那条通道是活的。 */
    diagLines: 0,
    /** 密钥不对的来源 IP（只记一份，免得扫端口的把日志刷爆）。 */
    rejectedIps: new Set(),
    sockets: 0,
    /** 累计接受过多少个 TCP 连接（诊断"手机到底有没有连过来"，见 /status）。 */
    connections: 0,
    lastConnectionAt: null,
    inboxLines: 0,
    /** 字幕清理（P4）：累计删掉多少条超过保留期的字幕。 */
    utterancesPurged: 0,
    /** 译文质检（见 lib/translation-lint.mjs）：报了多少条确定错 / 警告。 */
    lintBad: 0,
    lintWarn: 0,
    /** 每种错各出现几次（kind → 次数），用来一眼看出"最常犯的是哪一类"。 */
    lintKinds: new Map(),
    /** 热词对照表（docs/15）：成功上传过几次、最近一次是谁、几条。 */
    termsSaves: 0,
    termsUser: null,
    termsEntries: 0,
    /** 手机侧运行时设置被改过几次（校对开关）。 */
    settingsWrites: 0,
    /** 账户：成功次数 / 被拒次数（登录失败、token 无效都算）。 */
    authOk: 0,
    authRejected: 0,
    /** 迁移期那句"还没有账户"只提示一次，别刷屏。 */
    legacyIdentityNoted: false,
    writer: null,
    /** 写入串行化：收件箱的顺序就是字幕的顺序，不能乱 */
    writeChain: Promise.resolve(),
    /** 音频：已落盘字节数 / 已收块数 / 当前采样率（null = 还没收到过） */
    audioBytes: 0,
    audioChunks: 0,
    /** 音频轮转次数（超过 --audio-max-bytes 就把旧文件改名成 .1 再来一个）。 */
    audioRotations: 0,
    /** 音频日志聚合用：**按房间**记上次打印到第几块、什么时候（5.10：全局键是 `(全局)`）。 */
    audioLoggedChunk: new Map(),
    audioLoggedAt: new Map(),
    /** 每个房间已经收了多少块（5.10：手机上的"第 N 块"应该按这一场算）。 */
    roomChunks: new Map(),
    audioLoggedRate: null,
    audioLoggedLang: null,
    audioRateValue: null,
    audioLangValue: null,
    /** 音频写入也要串行化：追加写交错会把 PCM 数据搅碎，识别必然出错 */
    audioChain: Promise.resolve(),
    closed: false,
  }

  state.writer = await createInboxWriter({ inboxPath: options.inbox, format: 'text' })

  // 译文质检要用的策略数据（专名表 / 名词性别表）。
  //
  // 直接读 policy/br-pt.json，**不走 lib/artifacts.mjs**：那个模块为了生成产物
  // 会拖进 real-tools / test-phrases 一堆东西，而这里只要一份 JSON。
  // 读不到就把质检关掉并说明 —— 质检是旁路，**绝不能因为它连不上而让转发起不来**。
  state.lintPolicy = { properNouns: [], nounGenders: {} }
  if (options.lint === true) {
    try {
      state.lintPolicy = JSON.parse(await readFile(join(ROOT, 'policy', 'br-pt.json'), 'utf-8'))
    } catch (error) {
      options.lint = false
      debug(`⚠️ 译文质检关掉了：读不到 policy/br-pt.json（${error?.message ?? error}）`)
    }
  }

  function notifyWaiters() {
    for (const resolve of state.waiters) resolve()
    state.waiters.clear()
  }

  /**
   * 收到一帧：分配序号、归属、落库、通知、推送（4.86 抽出，单总线与分房间总线共用）。
   *
   * @param {object} frame     字幕帧
   * @param {string} roomHint  来源房间（来自 `buses/<roomId>.json` 的文件名）；空 = 需要推断
   */
  /**
   * 上传音频的是谁（4.96）。
   *
   * <p>优先 **token**（认证过的身份，改不了），其次 `?speaker=`（老客户端/无账号时的兜底）。
   * 认不出来返回 `null` —— 调用方据此决定退回到持麦者，或者干脆不带发言人。
   */
  async function resolveUploadUser(request, url) {
    const token = request.headers['x-leion-token'] ?? url.searchParams.get('token')
    if (typeof token !== 'string' || token === '') return null
    try {
      const doc = await loadAccounts(options.dataDir)
      const user = userForToken(doc, token)
      return typeof user === 'string' && user !== '' ? user : null
    } catch {
      return null
    }
  }

  /**
   * 清洗客户端自报的发言人名字（只用 `?speaker=` 那条兜底路径）。
   *
   * <p>为什么要清洗：这个名字会**显示在别人的界面上**、也会落进转写全文。
   * 所以只留"像个用户名"的字符，长度封顶；认不出就返回空串（宁可不显示）。
   */
  function sanitizeSpeaker(raw) {
    const text = String(raw ?? '').trim()
    if (text === '') return ''
    const cleaned = text.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 40).trim()
    return /^[\w\u4e00-\u9fa5.@-]{1,40}$/.test(cleaned) ? cleaned : ''
  }

  /**
   * 这一帧的发言人：**最近上传这段音频的人** → 当前持麦者 → 无（4.96）。
   *
   * <p>为什么要 TTL：字幕在"说完之后"才产生（切句 + 识别 + 翻译要几秒），
   * 所以不能用"此刻谁持麦"（他可能已经松开麦了），而要用"刚才谁在说"。
   */
  function speakerForRoom(roomId, now = Date.now()) {
    if (roomId === null || roomId === undefined || roomId === '') return ''
    const recent = state.roomSpeaker.get(roomId)
    if (recent !== undefined && now - Number(recent.at ?? 0) <= SPEAKER_TTL_MS) {
      return String(recent.name ?? '')
    }
    const holder = floorState(options.dataDir, roomId).holder ?? ''
    return String(holder)
  }

  /**
   * 这个房间里"每个人读哪种语言"（5.00）。
   *
   * <p>三语会议里同一句要译成几种，取决于**听的人**分别是哪些语言 —— 这正是用户提的
   * "BC 同语言就只译一份、不同语言就译两份"。数据源是 `room_members.lang`（入会时登记，
   * 认证过的身份），不是客户端现报的。
   *
   * @returns {Map<string, string>} 用户名 → 语言
   */
  function roomLangsByUser(roomId) {
    const map = new Map()
    try {
      for (const member of listMembers(options.dataDir, roomId)) {
        const lang = String(member.lang ?? '').trim()
        if (lang !== '') map.set(String(member.username), lang)
      }
    } catch (error) {
      debug(`[语言] 读成员语言失败（不影响字幕）：${error?.message ?? error}`)
    }
    return map
  }

  /**
   * 把"这个房间的语言集合"写给这场会的大脑 + 同步给 WS 连接（5.00）。
   *
   * <p>为什么要落文件：大脑是**另一个进程**（harness-side），只能靠文件/侧车知道会议状态
   * （同一套做法见 `audio/<房间>.lang` 与 `settings.json`）。写的时候**只在变化时写**，
   * 避免每秒一次无谓的写盘。
   */
  function publishRoomLangs(roomId) {
    const byUser = roomLangsByUser(roomId)
    const langs = [...new Set([...byUser.values()])].sort()
    const key = langs.join('|')
    if (state.roomLangsSent.get(roomId) !== key) {
      state.roomLangsSent.set(roomId, key)
      const file = join(options.dataDir, 'room-langs', `${String(roomId).replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
      void mkdir(dirname(file), { recursive: true })
        .then(() => writeFile(file, JSON.stringify({
          roomId, langs, byUser: Object.fromEntries(byUser), at: Date.now(),
        }), 'utf-8'))
        .catch((error) => debug(`[语言] 写侧车失败（不影响字幕）：${error?.message ?? error}`))
      debug(`[语言] ${roomId} 的听者语言：${langs.length === 0 ? '（还没登记）' : langs.join(' / ')}`)
    }
    if (wsHub !== null) {
      try { wsHub.applyRoomLangs(roomId, byUser) } catch { /* 没有连接就算了 */ }
    }
    return langs
  }

  function publishFrame(frame, roomHint = '') {
    state.seq += 1
    state.frameCount += 1
    // 归属：文件来源（最准）→ 帧里的 roomId → 刚上传音频的房间 → 持麦者推断
    const attribution = roomHint !== ''
      ? { roomId: roomHint, reason: 'bus-file' }
      : resolveFrameRoom(options.dataDir, {
        frameRoomId: frame.roomId ?? '',
        audioRoomId: state.audioRoomId,
        audioAt: state.audioRoomAt,
        speaker: frame.speaker ?? '',
      })
    if (attribution.roomId !== null) frame.roomId = attribution.roomId
    // 4.95/4.96：把**这句话到底是谁说的**一并带给手机。
    //
    // 为什么要服务端加：总线帧里的 `speaker` 只有 `me`/`them` 两种值（那是"相对于电脑"的说法，
    // 对手机毫无意义）。身份优先级：**最近上传这段音频的人**（4.96，手机自报/token）
    // → 当前持麦者 → 不带。认不出来就**不带这个字段**，绝不写 null ——
    // 安卓 `JSONObject.optString("k","")` 遇到 JSON null 会返回字符串 "null"，
    // 界面上就出现一个叫 null 的发言人（4.95 就这么翻车过一次）。
    if (attribution.roomId !== null) {
      const speakerNow = speakerForRoom(attribution.roomId)
      if (speakerNow !== '') {
        frame.speakerName = speakerNow
      } else {
        delete frame.speakerName
      }
    } else {
      delete frame.speakerName
    }
    state.lastFrame = frame
    // 5.00：把"这个房间里每个人读哪种语言"同步给两条下游：
    //   ① 写一份侧车给这场会的大脑（它据此决定这一句要译成哪几种）；
    //   ② 同步给 WS 连接（按语言扇出要用）。
    if (attribution.roomId !== null) publishRoomLangs(attribution.roomId)
    if (attribution.roomId !== null) {
      const roomSeq = (state.seqByRoom.get(attribution.roomId) ?? 0) + 1
      state.seqByRoom.set(attribution.roomId, roomSeq)
      state.framesByRoom.set(attribution.roomId, { seq: roomSeq, frame })
    }
    // 调试：字幕总线一变就报一行 —— 手机应该马上能看到这一帧。
    // **一定要标出"增量还是定稿"**，否则"眼镜上显示 Ol…"这类问题无从追查。
    debug(`📺 字幕已更新（第 ${state.seq} 帧·${frame.partial === true ? '增量' : '定稿'}`
      + `${attribution.roomId === null ? '' : `·${attribution.roomId}`}）`
      + `[${frame.speaker ?? '?'} / ${frame.lang ?? '?'}] ${frame.text ?? ''}`)
    lintFrame(frame)
    recordUtteranceIfFinal(frame, attribution)
    notifyWaiters()
    // 4.43：字幕也走 WS（长轮询留着兜底）。4.86 起：有归属就**只发给这个房间**，
    // 不再广播给所有房间（那正是"两场会字幕互相污染"的来源）。
    if (wsHub !== null) {
      wsHub.broadcastFrame({
        type: 'frame',
        seq: state.seq,
        changed: true,
        frame,
        roomId: attribution.roomId ?? null,
        roomSeq: attribution.roomId === null ? null : (state.seqByRoom.get(attribution.roomId) ?? null),
        // 5.00：这一帧是**译成哪种语言**的那一份。三语会议里同一句会有两份帧
        // （如葡语一份、英语一份），只该发给读那种语言的人。
        lang: String(frame.lang ?? ''),
      }, attribution.roomId ?? null, String(frame.lang ?? ''))
    }
  }

  /**
   * 轮询字幕总线（4.86）。
   *
   * <p>两种来源：
   * <ol>
   *   <li><b>单文件</b>（`--bus <file>`，默认）：老用法，一次只有一场会被翻译；</li>
   *   <li><b>目录</b>（`--bus <dir>` 或目录路径）：每个房间一个 `&lt;roomId&gt;.json`，
   *       两场会可以各写各的，**互不覆盖** —— 这才是"并发"真正需要的那半。</li>
   * </ol>
   */
  async function pollBus() {
    if (state.closed) return
    if (state.busIsDir === true) {
      await pollBusDir()
      return
    }
    let raw
    try {
      raw = await readFile(options.bus, 'utf-8')
    } catch {
      return                       // 总线还没出现
    }
    if (raw === state.busRaw) return
    state.busRaw = raw
    let frame
    try {
      frame = JSON.parse(raw)
    } catch {
      return                       // 正好读到写了一半的，下一轮再来
    }
    if (frame === null || typeof frame !== 'object' || !Array.isArray(frame.lines)) return
    publishFrame(frame)
  }

  /** 目录模式：每个 `<roomId>.json` 各算一路，按文件记录"上次读到哪"。 */
  async function pollBusDir() {
    let names = []
    try {
      names = (await readdir(options.bus)).filter((name) => name.endsWith('.json'))
    } catch {
      return                       // 目录还没建
    }
    for (const name of names) {
      const file = join(options.bus, name)
      let raw
      try {
        raw = await readFile(file, 'utf-8')
      } catch {
        continue
      }
      if (state.busRawByFile.get(file) === raw) continue
      state.busRawByFile.set(file, raw)
      let frame
      try {
        frame = JSON.parse(raw)
      } catch {
        continue                   // 写了一半
      }
      if (frame === null || typeof frame !== 'object' || !Array.isArray(frame.lines)) continue
      // 房间从文件名来（`room-A.json` → `room-A`），帧里若显式带了 roomId 以帧为准
      const roomId = String(frame.roomId ?? name.replace(/\.json$/, ''))
      publishFrame(frame, roomId)
    }
  }

  /**
   * 定稿帧落库（4.73）：会议结束后的「转写全文」靠它。
   *
   * <p>为什么在这里做：字幕总线本来就要经过这个进程，**不用改任何接口**，也不用让
   * 翻译组件知道"房间"这回事（它只负责把话说对）。定稿帧 = 这一句已经确定了，
   * 正是该落库的时刻；增量帧落了只会把转写弄成一堆碎片。
   *
   * <p>归属靠 {@link roomForFrame} 的推断，推不出来就**不记**并打一行 debug ——
   * 把字幕写进错的会议，比少一条难查得多。
   */
  function recordUtteranceIfFinal(frame, attribution) {
    if (frame.partial === true) return
    const text = String(frame.text ?? '').trim()
    const source = String(frame.source ?? '').trim()
    if (text === '' && source === '') return
    // 帧里若带 roomId（未来协议）就不用推断；不带才走持麦者推断
    // 归属由 pollBus 统一解析（帧 roomId → 刚上传音频的房间 → 持麦者推断），这里直接用
    if (attribution.roomId === null) {
      debug(`🗂 定稿帧没记：无法确定属于哪场会议（${attribution.reason}）`)
      return
    }
    const saved = appendUtterance(options.dataDir, {
      roomId: attribution.roomId,
      // 4.95：存**真实用户名**（`speakerName`），不再存 `me`/`them`。
      // 那两个字是"相对于电脑"的说法，落进 utterances 之后，转写全文里就会出现
      // 一堆叫 `them` 的发言人（用户看到的就是"全是对方"）。
      username: String(frame.speakerName ?? ''),
      // 5.00：`frame.lang` 是**译文**语言（帧里的 text/lines 是译文），源语言在 `sourceLang`。
      // 之前这里把 frame.lang 当源语言存，是"翻译方向"那类错误的同一个来源 ——
      // 单语言时两者恰好总是相反，所以一直没暴露；变成三种语言后必须分清。
      srcLang: String(frame.sourceLang ?? ''),
      dstLang: String(frame.lang ?? ''),
      srcText: source,
      dstText: text,
      startAt: Date.now(),
      isFinal: true,
    })
    if (saved.ok !== true) {
      debug(`🗂 定稿帧没记：${saved.error}`)
      return
    }
    debug(`🗂 定稿帧已记录（${attribution.reason} → ${attribution.roomId}，#${saved.id}）`)
  }

  /**
   * 译文质检：把这一帧的原文与译文交给 `lib/translation-lint.mjs` 判一遍，**只报不改**。
   *
   * <p><b>为什么放在转发进程、而不是插件里</b>：插件（`plugin/core.mjs`）要被**内联**进
   * 动态插件的沙箱，而那个沙箱**没有 import** —— 生成器只会剥掉 `export ` 前缀，
   * 一个字面 `import` 会原样落进 `dynamic/leion-pro.host.js` 然后在沙箱里炸。
   * 而字幕总线里本来就**同时带着 `source`（原文）和 `text`（译文）**，
   * 这个进程又是唯一读它的地方 —— 所以在这里判，一行都不用动产线代码。
   *
   * <p>这也正是"只报"最该待的位置：它**不进入翻译管线**，
   * 所以不可能拖慢字幕、也不可能因为自己出错而让字幕出不来。
   * 以后要"报完顺手修"（重译或替换），那才需要进管线，届时再单独设计。
   *
   * <p>⚠️ **只判定稿帧**。增量帧是半句话，缺数字、缺专名都是**正常现象**
   * （说到一半而已），拿它去判会满屏假错 —— 而假错的代价是让人开始忽略警告。
   */
  function lintFrame(frame) {
    if (options.lint !== true) return
    if (frame.partial === true) return
    const source = typeof frame.source === 'string' ? frame.source : ''
    const text = typeof frame.text === 'string' ? frame.text : ''
    if (source === '' || text === '') return
    let result
    try {
      result = lintTranslation(source, text, state.lintPolicy)
    } catch (error) {
      // 质检自己出错**绝不能影响字幕转发** —— 它只是个旁路观察者。
      debug(`⚠️ 译文质检本身出错（已忽略）：${error?.message ?? error}`)
      return
    }
    for (const note of result.notes) {
      state.lintKinds.set(note.kind, (state.lintKinds.get(note.kind) ?? 0) + 1)
    }
    state.lintBad += result.fatal.length
    state.lintWarn += result.warn.length
    if (result.notes.length === 0) return
    // 报的时候必须**把原文和译文一起打出来**：只说"专名新造"没法判断，
    // 得看到"原文是亮亮视野、译文写成了 Liangliang"才能一眼确认。
    for (const note of result.notes) {
      const mark = note.level === 'bad' ? '❌ 确定错' : '⚠️ 警告'
      debug(`🔍 ${mark}（${note.kind}）：${note.text}`)
    }
    debug(`   原文 ${source}`)
    debug(`   译文 ${text}`)
  }

  /**
   * 打印一块收到的音频（+ 电平），**默认按 5 秒聚合**。
   *
   * <p><b>为什么不是每块都打</b>：一秒钟一块，也就是一秒钟两行（一块一行 + 电平一行）。
   * 实测一场 2 分半的会话：350 行日志里 **280 行是这两行心跳**，
   * 而真正要看的东西（19 条字幕、25 条手机诊断、质检报告）被淹在中间 ——
   * "看日志判断准确率"这件事就做不成了。
   *
   * <p>⚠️ <b>但这里踩过一个坑，改之前必须先看懂</b>：早先按秒节流（阈值 900ms），
   * 因为**把块号一起吞掉了**，手机上看到的块号像 1,2,3,5 —— 看起来像丢了数据，
   * 其实只是被节流没打印。**这种"看起来像故障"的日志比不打印更糟。**
   *
   * <p>所以这里的做法是：**聚合但绝不隐藏块号** —— 一行的开头就写明
   * `块 12–17（6 块）`，范围和块数都在。想核"有没有丢块"，
   * 相邻两行的范围首尾相接就证完了，不需要逐块打印。
   *
   * <p>要回到逐块打印用 `--verbose`（排查音频本身的问题时才需要）。
   *
   * <p>⚠️ 已知的一个小缺口：**音频停止之后，最后一小段窗口不会补打**
   * （聚合是"下一块到了才知道上一段该收尾了"，而这里没有"录音结束"事件）。
   * 所以"一共收了多少"要看 `/status` 的 `audioBytes` / `audioChunks` ——
   * 那两个数永远是准的，日志只是心跳。
   */
  function logAudioChunk(body, info) {
    // 5.10：块号与秒数都**按房间**（有房间时），否则"第 1 块"会接着上一场继续数、
    // "累计 N 秒"会带上前几次测试的音频 —— 两个数字都会让人以为系统坏了。
    const room = typeof info.room === 'string' ? info.room : ''
    const key = room === '' ? '(全局)' : room
    const chunk = room === '' ? state.audioChunks : (state.roomChunks.get(room) ?? 0)
    const previous = state.audioLoggedChunk.get(key) ?? 0
    const elapsed = Date.now() - (state.audioLoggedAt.get(key) ?? 0)
    const first = previous === 0
    // 新一次录音 / 采样率或语种变了 → 立刻打，这些是"状态变了"，不能等
    const important = first || info.fresh === true
      || info.rate !== state.audioLoggedRate || info.lang !== state.audioLoggedLang
    if (options.verbose !== true && important === false && elapsed < AUDIO_LOG_MS) return

    const from = previous + 1
    const count = chunk - previous
    const range = count <= 1 ? `第 ${chunk} 块` : `块 ${from}–${chunk}（${count} 块）`
    // 措辞说明白：音源现在可能是眼镜的麦克风（见 docs/09 §12），不再是"手机音频"。
    // 转发进程本身看不到音源（链路上没有这个字段），所以这里只说"音频"，
    // 不替调用方声称它来自哪个设备。
    debug(`📥 收到音频：${room === '' ? '' : `房间 ${room} `}${range}`
      + ` → 这一场累计 ${info.totalSeconds.toFixed(1)}s`
      + ` @ ${info.rate}Hz，语种 ${info.lang}${info.fresh === true ? '（开始了新一次录音）' : ''}`)
    // 电平单独一行：这是"到底有没有录到人声"的唯一直接证据（见 pcmLevel 的注释）
    debug(`   ${describeLevel(pcmLevel(body))}`)
    state.audioLoggedChunk.set(key, chunk)
    state.audioLoggedAt.set(key, Date.now())
    state.audioLoggedRate = info.rate
    state.audioLoggedLang = info.lang
  }

  // 音频文件在重启后**不会**被清（以前清，会把还没识别完的音频吃掉；见 /audio 的注释）。
  // 所以计数要从文件真实大小起步，否则"上限"每次重启都从头算，等于没设。
  try {
    const existing = await stat(options.audio)
    state.audioBytes = existing.size
  } catch {
    state.audioBytes = 0
  }

  const busTimer = setInterval(() => { void pollBus() }, options.busPollMs)
  busTimer.unref?.()

  /**
   * 音频文件超限就轮转：`audio-in.pcm` → `audio-in.pcm.1`（覆盖上一份），再开一个新的空文件。
   *
   * 为什么不是"原地清空"：那会把**还没被识别进程读走的**音频永久删掉 —— 曾经在 fresh=1
   * 上这么干过，用户录了三段、每段都被下一次清掉，一条都没识别出来（见 /audio 的注释）。
   * 轮转只是换了个文件继续写，旧的一份留着排查；识别进程发现路径上的文件变小了，
   * 会按既有逻辑把读指针退回 0（PcmFollower.read 里那条分支，python-suite 钉着）。
   *
   * 代价：磁盘占用约 2× 上限（`.1` 只留一份）。这在"写满磁盘"面前是划算的。
   */
  async function rotateAudio() {
    const backup = options.audio + '.1'
    try {
      await rename(options.audio, backup)
    } catch (error) {
      if (error && error.code !== 'ENOENT') throw error
    }
    await writeFile(options.audio, Buffer.alloc(0))
    state.audioBytes = 0
    state.audioRotations += 1
    debug(`🔁 音频已轮转（上限 ${(options.audioMaxBytes / 1024 / 1024).toFixed(0)} MB）：`
      + `旧的一段存为 ${backup}，接下来写新文件`)
  }

  // ── 字幕保留期清理（P4，docs/21 §10）─────────────────────────────────────
  //
  // 为什么要有：字幕里是**真实会议内容**。库存在服务器上、还能被管理员看到，
  // "永久保留"既不是我们需要的能力，也不是用户同意过的事。所以超过保留期就删。
  //
  // 为什么是"启动先跑一次 + 每小时一次"：启动时补上"停机期间该删的"；
  // 之后按小时扫，不追求准点 —— 早删一小时晚删一小时都无所谓，一天一次又太粗。
  const purgeUtterances = (now = Date.now()) => {
    try {
      const removed = purgeUtterancesIn(options.dataDir, now, options.utteranceRetentionDays)
      if (removed > 0) {
        state.utterancesPurged += removed
        debug(`🧹 字幕清理：删掉 ${removed} 条超过 ${options.utteranceRetentionDays} 天的字幕`)
      }
      return removed
    } catch (error) {
      // 清理失败绝不能影响同传：它是维护动作，不是主链路
      debug(`⚠️ 字幕清理失败（不影响同传）：${error?.message ?? error}`)
      return 0
    }
  }

  void purgeUtterances()
  const purgeTimer = setInterval(() => { void purgeUtterances() }, UTTERANCE_SWEEP_MS)
  purgeTimer.unref?.()

  // ── HTTP ──────────────────────────────────────────────────────────────────

  function send(response, status, payload) {
    const body = JSON.stringify(payload)
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
    response.end(body)
  }

  /**
   * 拒收一个**我们没读完**的请求体，然后把这个连接关掉。
   *
   * <p>为什么不能只 send() 了事：客户端还在往外发，而我们已经不再读了 ——
   * 那段没被读走的数据留在 socket 里，Node 只能把连接重置（RST）。
   * 后果是**下一个请求莫名其妙地 ECONNRESET**（keep-alive 复用了这条脏连接），
   * 排查时会以为"服务挂了"，其实只是上一个请求没被读完。
   * 这个坑是公网限流那次冒烟测试里撞出来的。
   *
   * <p>加 `Connection: close` 是让客户端**明确知道**这条连接不再复用，
   * 而不是靠它去猜；然后在响应写完之后再销毁 socket。
   */
  function sendAndClose(request, response, status, payload) {
    response.setHeader('Connection', 'close')
    response.once('finish', () => request.socket?.destroy())
    send(response, status, payload)
  }

  /**
   * 判断"这次请求是谁"。**唯一可信来源是 token**。
   *
   * <p>三条规则，把兼容与安全都写清楚（不留隐藏后门）：
   *  ① 带了有效 token → 就是那个用户；
   *  ② 库里**一个账户都没有** → 退回旧行为（按 `user` 参数 / `default` 分表）。
   *     这是为了"还没注册过的机器上手机能直接用"；一旦有人注册，这条路就关掉；
   *  ③ 库里有账户但没带 token / token 无效 → **401**，不再接受自报用户名。
   */
  async function resolveIdentity(request, url, bodyUser = null) {
    const token = request.headers['x-leion-token'] ?? url.searchParams.get('token')
    const accounts = await loadAccounts(options.dataDir)
    if (hasAccounts(accounts)) {
      const user = userForToken(accounts, typeof token === 'string' ? token : '')
      if (user === null) {
        state.authRejected += 1
        return {
          ok: false, status: 401, error: 'auth-required',
          hint: '这台电脑上已经有账户了，先登录拿 token（请求头 X-Leion-Token）',
        }
      }
      return { ok: true, user }
    }
    // 还没人注册：按旧规矩来，并**在日志里说一次**，免得以后忘了这条路还开着
    if (state.legacyIdentityNoted !== true) {
      state.legacyIdentityNoted = true
      debug('[账户] 还没有任何账户 → 热词表暂时按自报用户名区分（迁移期行为）。'
        + '在手机「设置 → 账户」注册一个之后，就必须登录才能读写热词表了。')
    }
    // 迁移期：旧客户端把 user 放在**请求体**里（PUT /terms），新客户端放在 query 里。
    // 两条都接受 —— 但只在"这台机器还没有任何账户"时才走到这里。
    const rawUser = url.searchParams.get('user') ?? bodyUser
    const fallback = normalizeUser(rawUser)
    if (fallback.ok !== true) {
      return { ok: false, status: 400, error: 'bad-user', hint: fallback.error }
    }
    return { ok: true, user: fallback.user }
  }

  /**
   * 热词对照表的"校验 / 落盘"共用实现（`POST /terms/validate` 与 `PUT /terms`）。
   *
   * 两件事刻意分开，但**校验用同一个函数**：界面上的"预校验"和真正落盘时的校验
   * 不能说两套话 —— 否则会出现"界面上说没问题、真上传却被拒"这种最难解释的情况。
   *
   * @param {{ write: boolean }} mode write=true 才落盘
   */
  async function handleTermsWrite(response, request, url, mode) {
    let body
    try {
      body = await readBody(request, TERMS_LIMITS.maxBodyBytes)
    } catch (error) {
      // 和 /say 一样：拒收一个没读完的请求体后必须关连接，否则留下脏 keep-alive
      sendAndClose(request, response, error.statusCode ?? 400, { ok: false, error: String(error.message) })
      return
    }
    // ⚠️ **身份只认 token**：请求体里的 `user` 一律不看。
    //    原来按 `user` 分表等于没有权限 —— 改一个参数就能读写别人的表。
    const identity = await resolveIdentity(request, url, body.user ?? null)
    if (identity.ok !== true) {
      send(response, identity.status, { ok: false, error: identity.error, hint: identity.hint })
      return
    }
    const who = { ok: true, user: identity.user }
    const checked = validateTerms(body.entries)
    if (checked.ok !== true) {
      // 方案 C：一条不合法 → 整张表不落盘，并把**每一处**问题都指出来（带下标）
      send(response, 400, {
        ok: false,
        user: who.user,
        accepted: checked.accepted,
        rejected: checked.rejected,
        warnings: checked.warnings,
        error: 'invalid-entries',
        hint: '整张表没有保存（一条不合法就整表不落盘），按 rejected 里的 index 改完再传',
      })
      return
    }

    if (mode.write === false) {
      send(response, 200, {
        ok: true, user: who.user, accepted: checked.accepted, rejected: [], warnings: checked.warnings, saved: false,
      })
      return
    }

    const doc = await loadTerms(options.dataDir)
    const put = putTable(doc, who.user, checked.entries)
    await saveTerms(options.dataDir, put.doc)
    // 记下"当前会话用哪个用户"：插件下一场开始时会读它取表
    try {
      await saveActiveUser(options.dataDir, who.user)
    } catch (error) {
      debug(`⚠️ 写 terms-active.json 失败（不影响表已保存）：${error?.message ?? error}`)
    }
    state.termsSaves += 1
    state.termsUser = who.user
    state.termsEntries = checked.entries.length
    debug(`[热词表] 用户 ${who.user} 上传 ${checked.entries.length} 条`
      + (put.overwritten ? `（覆盖了原来的 ${put.previousEntries} 条）` : '（首次）')
      + ' —— 下一次开始同传时生效')
    send(response, 200, {
      ok: true,
      user: who.user,
      accepted: checked.accepted,
      rejected: [],
      warnings: checked.warnings,
      saved: true,
      overwritten: put.overwritten,
      previousEntries: put.previousEntries,
      effectiveAt: 'next-session',
    })
  }

  /**
   * 读手机侧运行时设置。**任何失败都返回空对象** —— 设置坏了绝不能影响开端口、转字幕。
   */
  async function readSettings(dataDir) {
    try {
      const text = await readFile(defaultSettings(dataDir), 'utf-8')
      const parsed = JSON.parse(text)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      const out = {}
      if (typeof parsed.proofread === 'boolean') out.proofread = parsed.proofread
      return out
    } catch {
      return {}
    }
  }

  /** 原子写设置（tmp + rename）：插件可能在任意时刻读它，不能让它读到半截 JSON。 */
  async function writeSettings(dataDir, settings) {
    const target = defaultSettings(dataDir)
    await mkdir(dirname(target), { recursive: true })
    const temp = target + '.tmp'
    await writeFile(temp, JSON.stringify(settings, null, 2) + '\n', 'utf-8')
    await rename(temp, target)
  }

  async function readBody(request, limit = MAX_BODY_BYTES) {
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > limit) {
        const error = new Error('请求体过大')
        error.statusCode = 413
        throw error
      }
      chunks.push(chunk)
    }
    const text = Buffer.concat(chunks).toString('utf-8')
    if (text.trim() === '') return {}
    try {
      return JSON.parse(text)
    } catch {
      const error = new Error('请求体不是合法 JSON')
      error.statusCode = 400
      throw error
    }
  }

  /**
   * 设备信息 + 显示预算。
   * 预算字段刻意叫 cols / lineBudget（与字幕帧里的字段同名），**不叫 lines** ——
   * lines 在别处表示"收件箱已写入的行数"，两个含义撞在一起会互相覆盖。
   * 预算优先取自字幕帧：插件的配置是唯一来源。
   */
  /**
   * 这次登录/注册发了新 token（单会话会吊销旧的）→ **立刻**通知被顶掉的旧会话（4.45）。
   *
   * <p>为什么要有：吊销是服务端一瞬间的事，但被顶掉的那台手机以前只能靠 10 秒一次的
   * 轮询才知道 —— 用户体感就是"被踢了却不吭声"。现在它只要连着会话通道，
   * 一秒之内就会收到 `{type:'kicked'}` 并被断开。
   */
  function notifyKickedIfReplaced(username, newToken) {
    if (wsHub === null || typeof username !== 'string' || username === '') return
    try {
      // 把"刚发的 token"传下去：连着的若是它自己（同一台设备重新登录），不踢。
      if (wsHub.notifyKicked(username, 'elsewhere-login', newToken ?? null)) {
        debug(`[账户] ${username} 在别处登录，已通知旧会话下线`)
      }
    } catch (error) {
      debug(`[ws] 通知旧会话失败（不影响登录）：${error?.message ?? error}`)
    }
  }

  /**
   * 组装 /frame 的响应体（4.81 修）。
   *
   * <p><b>为什么单独抽出来</b>：以前是 `send(response, 200, { seq: curSeq, ..., ...info() })`，
   * 而 `info()` 里也带 `seq`（**全局**序号）—— 对象展开是从左到右覆盖，
   * 于是房间维度的 `seq` 刚设好就被全局值盖掉。
   *
   * <p>后果极难查：某房间自己还没出过帧（roomSeq=0），但别的房间已经出到第 5 帧，
   * 手机拿到"你是 5"→ 下次带 since=5 来 → 服务端又判定"序号比房间的大"→ 立刻返回 →
   * **手机与服务端互相顶着死循环**，日志一秒刷几十行"已让它复位"。
   *
   * <p>所以这里把 `info()` 放**前面**，让我们算出来的字段覆盖它。
   */
  function framePayload(base, fields) {
    return { ...base, ...fields }
  }

  function info() {
    return {
      device: state.lastFrame?.device ?? 'Leion Pro',
      cols: state.lastFrame?.cols ?? FALLBACK_COLS,
      lineBudget: state.lastFrame?.lineBudget ?? FALLBACK_LINES,
      seq: state.seq,
      bridge: 'lan-relay',
      features: RELAY_FEATURES,
    }
  }

  const server = createServer((request, response) => {
    void (async () => {
      let url
      try {
        url = new URL(request.url, 'http://localhost')
      } catch {
        send(response, 400, { ok: false, error: 'bad-url' })
        return
      }

      const given = request.headers['x-leion-secret'] ?? url.searchParams.get('secret')
      if (!secretMatches(secret, given)) {
        state.rejected += 1
        // 记下**是谁**被拒了。公网上被扫端口是常事，日志里没有来源 IP 时
        // 完全分不清"是手机密钥填错了"还是"有人在扫"。
        const who = clientIp(request)
        if (!state.rejectedIps.has(who)) {
          state.rejectedIps.add(who)
          // 用 startRelay 内部的 debug（main 里的 log 在这一层拿不到）
          debug(`  ✗ 密钥不对，来自 ${who}（累计被拒 ${state.rejected} 次）`)
        }
        send(response, 401, { ok: false, error: 'unauthorized', hint: '请求头要带 X-Leion-Secret' })
        return
      }

      // ── 公网模式：每 IP 限流 ─────────────────────────────────────────────
      // 放在密钥校验**之后**：没密钥的请求连桶都不用占，免得别人用一个错的密钥
      // 就能把某个 IP 的额度耗掉（那是我们自己人）。
      if (options.public === true) {
        const who = clientIp(request)
        if (!limiter.allow(who)) {
          state.rateLimited += 1
          send(response, 429, {
            ok: false,
            error: 'too-many-requests',
            hint: `每个 IP 每分钟最多 ${PUBLIC_LIMITS.maxRequestsPerMinutePerIp} 次`,
          })
          return
        }
      }

      // ── GET /hello ────────────────────────────────────────────────────────
      if (request.method === 'GET' && url.pathname === '/hello') {
        // 手机可以顺带报上"我是谁"：热词表按用户名区分（docs/15 §8.3）。
        // 报错了不拦握手 —— 连接是第一位的，用户名只影响"读哪张表"。
        // 手机可以带上 token 说明"我是谁"：优先用 token，解析不出来再看旧的 user 参数
        const helloIdentity = await resolveIdentity(request, url)
        if (helloIdentity.ok === true) {
          state.termsUser = helloIdentity.user
          void saveActiveUser(options.dataDir, helloIdentity.user).catch(error => {
            debug(`⚠️ 写 terms-active.json 失败：${error?.message ?? error}`)
          })
        }
        // 一场开始：先把上一场攒下的"待入表"合并进正式表（插件在**下一场**读快照时才生效）
        await mergePendingTerms('hello')
        send(response, 200, { ok: true, ...info() })
        return
      }

      // ── POST /say ─────────────────────────────────────────────────────────
      if (request.method === 'POST' && url.pathname === '/say') {
        let body
        try {
          body = await readBody(request)
        } catch (error) {
          // readBody 只在"读到一半就发现太大/解析失败"时抛 —— 剩下的数据还在路上，
          // 不关连接就会留下一条脏 keep-alive 连接（见 sendAndClose 的说明）
          sendAndClose(request, response, error.statusCode ?? 400,
            { ok: false, error: String(error.message) })
          return
        }
        const text = body.text
        if (typeof text !== 'string' || text.trim() === '') {
          send(response, 400, { ok: false, error: 'text 必须是非空字符串' })
          return
        }
        if (body.from !== undefined && body.from !== null && body.from !== '' && !LANGS.includes(body.from)) {
          send(response, 400, { ok: false, error: `from 只能是 ${LANGS.join(' / ')} 或省略` })
          return
        }
        // 复用桥的写入器：收件箱的「一行一句话」规则只有一处实现
        state.writeChain = state.writeChain.then(() => state.writer.write(text))
        try {
          await state.writeChain
        } catch (error) {
          state.writeChain = Promise.resolve()
          send(response, 500, { ok: false, error: '写收件箱失败：' + String(error && error.message ? error.message : error) })
          return
        }
        state.sayCount += 1
        state.inboxLines = state.writer.stats.lines
        debug(`📥 收到手机文字：${text}（收件箱第 ${state.inboxLines} 行）`)
        send(response, 200, { ok: true, inboxLines: state.inboxLines, ...info() })
        return
      }

      // ── POST /audio ───────────────────────────────────────────────────────
      //
      // 手机录音上传：把原始 PCM 追加到一个文件里，转写进程尾随这个文件做识别。
      //
      // 为什么用「追加到一个文件」而不是每次上传都单独存一份：
      //   按音量切句需要**跨块**的连续性 —— 一句话可能横跨两次上传。如果每块单独存，
      //   句首句尾就会被切断，识别结果会莫名其妙地缺字。追加写让下游看到的是
      //   一条连续的音频流，和"直接用麦克风录"在形态上完全一致。
      if (request.method === 'POST' && url.pathname === '/audio') {
        const rateText = url.searchParams.get('rate') ?? request.headers['x-sample-rate'] ?? '16000'
        const rate = Number(rateText)
        if (!ALLOWED_RATES.includes(rate)) {
          send(response, 400, {
            ok: false,
            error: `rate 只能是 ${ALLOWED_RATES.join(' / ')}，收到 ${JSON.stringify(rateText)}`,
          })
          return
        }
        // 手机当前在听哪种语言。缺省沿用 pt-BR（主用途：对方说葡语）。
        const lang = url.searchParams.get('lang') ?? request.headers['x-leion-lang'] ?? 'pt-BR'
        if (!LANGS.includes(lang)) {
          send(response, 400, {
            ok: false,
            error: `lang 只能是 ${LANGS.join(' / ')}，收到 ${JSON.stringify(lang)}`,
          })
          return
        }
        const fresh = ['1', 'true', 'yes'].includes(String(url.searchParams.get('fresh') ?? '').toLowerCase())

        const chunks = []
        let size = 0
        try {
          for await (const chunk of request) {
            size += chunk.length
            if (size > MAX_AUDIO_BYTES) {
              const error = new Error(`音频块过大（上限 ${MAX_AUDIO_BYTES} 字节）`)
              error.statusCode = 413
              throw error
            }
            chunks.push(chunk)
          }
        } catch (error) {
          // 这里是**读到一半**就拒的：剩下的数据还在路上，必须关连接
          sendAndClose(request, response, error.statusCode ?? 400,
            { ok: false, error: String(error.message) })
          return
        }

        // ── 公网模式：音频字节限流 + 总量上限 ───────────────────────────────
        //
        // 这两条防的不是"破解密钥"，而是**把磁盘写满**：
        // 转发进程对 /audio 是**只追加、从不清空**的（见下面那段注释，
        // 那是为了不丢音频而刻意做的）。所以公网上只要有人不停灌，
        // 服务器磁盘就会满，然后识别进程、Node、甚至系统一起出问题。
        if (options.public === true) {
          const who = clientIp(request)
          if (!limiter.allowBytes(who, size,
            PUBLIC_LIMITS.maxAudioBytesPerMinutePerIp)) {
            state.rateLimited += 1
            send(response, 429, {
              ok: false,
              error: 'too-much-audio',
              hint: `每个 IP 每分钟最多 ${PUBLIC_LIMITS.maxAudioBytesPerMinutePerIp} 字节音频`,
            })
            return
          }
          if (state.audioBytes + size > PUBLIC_LIMITS.maxAudioBytesTotal) {
            send(response, 507, {
              ok: false,
              error: 'audio-storage-full',
              hint: `音频文件已达上限 ${PUBLIC_LIMITS.maxAudioBytesTotal} 字节，`
                + '重启转发进程会清空（见 start-all）',
            })
            return
          }
        }
        const body = Buffer.concat(chunks)
        // 采样率是 2 字节一帧，奇数长度说明发端截断在半帧上 —— 收下会污染后面所有数据
        if (body.length % 2 !== 0) {
          send(response, 400, { ok: false, error: 'PCM 数据长度必须是偶数（16-bit 一帧 2 字节）' })
          return
        }

        // 4.74/4.76：手机上传时告诉我们"我在哪个房间"。
        // 它同时是字幕归属的线索，也是实时传声的收件人范围。
        const audioRoom = String(url.searchParams.get('room') ?? '').trim()
        if (audioRoom !== '') {
          state.audioRoomId = audioRoom
          state.audioRoomAt = Date.now()
        }
        // 4.96：**上传者就是这句话的发言人**（用户提的办法，比"猜当前谁持麦"准得多）。
        //
        // 为什么这条路更对：字幕是"这段音频"转出来的，而这段音频是谁传的、只有他知道。
        // 手机在 `/audio?speaker=<我的用户名>` 里带上自己；有 token 时**以 token 为准**
        // （token 是认证过的身份，query 参数只是老客户端的兜底）。
        // 记成"这个房间最近的说话人"，发布字幕时按它落名字 —— 中间要经过
        // 切句 → 队列 → 识别 → 大脑 四个进程，身份只能靠**边车信息**传下去。
        let audioSpeaker = ''
        if (audioRoom !== '') {
          const asUser = await resolveUploadUser(request, url)
          const claimed = String(url.searchParams.get('speaker') ?? '').trim()
          const speaker = asUser !== null && asUser !== '' ? asUser : sanitizeSpeaker(claimed)
          if (speaker !== '') {
            audioSpeaker = speaker
            state.roomSpeaker.set(audioRoom, { name: speaker, at: Date.now() })
            // 5.06：**"这个人读哪种语言"以他实际上报的为准**。
            //
            // 原来 `room_members.lang` 只在入会那一刻写一次。用户在会中换成英语说话之后，
            // 库里还是"中文"，于是连着错两件事：大脑的听众语言集合里没有英语（一句英文都不译）、
            // 按语言扇出时他一条字幕都收不到。两条合起来正是用户报的
            // 「我说英文，但对方那边（以及我自己）不显示字幕」。
            // 现在每次上传都用**本人自报的语种**校正自己那一行（身份仍来自 token/speaker）。
            try {
              const synced = setMemberLang(options.dataDir, { roomId: audioRoom, username: speaker, lang })
              if (synced.ok === true && synced.changed === true) {
                debug(`[语言] ${speaker} 的参会语言更新为 ${lang}（按他上传时上报的语种）`)
              }
            } catch (error) {
              debug(`[语言] 同步成员语言失败（不影响字幕）：${error?.message ?? error}`)
            }
          }
        }
        // 5.00：**先**把听者语言同步给这场会的大脑 —— 它要在第一句就译成正确的几种语言；
        // 等到"第一帧出来"才写就晚了（那已经是在译完之后）。
        // 5.06：放在"校正成员语种"**之后**，否则这里写的还是上一句的旧集合。
        if (audioRoom !== '') {
          publishRoomLangs(audioRoom)
        }

        state.audioChain = state.audioChain.then(async () => {
          await mkdir(dirname(options.audio), { recursive: true })
          // ── 新一次录音 = 新一场同传：把"这一场用哪些库"发布成会议术语（docs/19）────
          //
          // 时机选在这里而不是"手机点了保存选择"：保存选择只是**改了意愿**，
          // 真正开始说话才算"这一场开始"。而且这样**不需要手机端配合**（旧 APK 也能用）。
          // 发布会：按 selection.json 里的勾选 → 合并各库 → 处理跨库冲突 →
          //   写一份"当前会议术语"到固定路径（插件每句都读它），并归档到 meetings/<会议id>/。
          // 失败一律不影响音频落盘（拿不到术语最多是"这一场没有术语"）。
          if (fresh === true && typeof publishMeetingTerms === 'function') {
            try {
              const selection = await loadSelection(options.dataDir, options.meetingId ?? 'current')
              const published = await publishMeetingTerms(options.dataDir, {
                libraryIds: selection.libraryIds, owner: selection.selectedBy ?? null,
              })
              debug(`[术语] 新一场与会：会议 ${published.meetingId}，${published.entries} 条`
                + (published.conflicts.length > 0
                  ? `，${published.conflicts.length} 条跨库冲突已排除（${published.conflicts.map((item) => item.zh).join('、')}）`
                  : ''))
            } catch (termError) {
              debug(`[术语] 发布会话术语失败（不影响字幕）：${termError && termError.message ? termError.message : termError}`)
            }
          }
          // ⚠️ 这里**刻意不再清空文件**，即使 fresh=1。
          //
          // 原来 fresh=1 会把 audio-in.pcm 截断成 0，本意是"新一次录音，旧音频别管了"。
          // 但那会让**没被读走的音频永久消失**：识别进程可能还没加载完模型、或者只是慢了一点，
          // 用户一按"重新录音"，上一段话就没了。实测就撞上了 —— 识别进程在下载模型，
          // 用户录了三段，每段都被下一次 fresh 清掉，于是一条都没识别出来。
          //
          // 现在改成"只追加、永不清空"：
          //   · 识别进程按自己的节奏读，不会漏；
          //   · 一段话与下一段之间的静音会让它自然断句（切句器有静音判定）；
          //   · 文件会一直长（16k 单声道 = 32KB/秒，一小时约 115MB），可在重启时清掉 ——
          //     start-all 每次启动都会清，识别进程自己也会从文件末尾开始跟（不重放旧的）。
          if (body.length > 0) {
            // 5.10：**新一次录音**（fresh=1）时把这个房间的计数器归零 ——
            // 手机界面上的"已上传 N 秒 / 第 N 块"应该是**这一场**的数字。
            // 全局文件不截断（上面那段说了为什么），但计数可以归零，那是纯展示数据。
            if (fresh === true && audioRoom !== '') {
              state.roomAudioBytes.set(audioRoom, 0)
              state.roomChunks.set(audioRoom, 0)
              state.audioLoggedChunk.set(audioRoom, 0)
              state.audioLoggedAt.delete(audioRoom)
            }
            // 先判上限再写：这样一块音频要么整块进老文件、要么整块进新文件，不会被劈成两半
            if (options.audioMaxBytes > 0
                && state.audioBytes + body.length > options.audioMaxBytes) {
              await rotateAudio()
            }
            await appendFile(options.audio, body)
            state.audioBytes += body.length
            // 4.84 → 5.08：音频**按房间 + 按说话人**分流。
            // 全局文件仍然写（老链路/单房间场景照旧能用）；分轨文件是识别端真正跟的那一份。
            //
            // 为什么必须按人分（不是按房间）：语种旁文件 `.lang` 是"最后写入者获胜"，
            // 两个人交替用不同语言说话时，切出来的段会带着上一个人的语种 ——
            // 于是"英语被当成中文识别"。这是**语言正确性**问题，不是整洁度问题。
            if (audioRoom !== '') {
              // 5.08：房间级的"混流"仍然写一份 —— 老模式（`--translate-mode serial|parallel`
              // 里 asr-bridge 的 `--whisper-follow`）跟的就是它，停写会让那两种模式**静默失效**。
              // 代价是每个房间多一份磁盘（32KB/s），换来的是"老模式还能用"。
              const mixed = roomAudioPath(options.dataDir, audioRoom)
              await mkdir(dirname(mixed), { recursive: true })
              await appendFile(mixed, body)
              const target = roomSpeakerAudioPath(options.dataDir, audioRoom,
                audioSpeaker === '' ? 'unknown' : audioSpeaker)
              await mkdir(dirname(target), { recursive: true })
              await appendFile(target, body)
              state.roomAudioBytes.set(audioRoom, (state.roomAudioBytes.get(audioRoom) ?? 0) + body.length)
              if (state.audioRoomFiles.has(audioRoom) !== true) {
                state.audioRoomFiles.add(audioRoom)
                debug(`🎙 音频分流：房间 ${audioRoom} → ${roomTrackDir(options.dataDir, audioRoom)}/（每个说话人一个文件）`)
              }
              // 采样率/语种也**按人**各写一份（识别端每路跟读时要看自己那份）。
              // ⚠️ 混流那一份的 `.lang` **不写**：它没有唯一的语种，写了就是"最后写入者获胜"
              //    那个坑（老模式确实有这个限制，但不再扩大它）。
              try {
                await writeFile(`${mixed}.rate`, String(rate) + '\n', 'utf-8')
                await writeFile(`${target}.rate`, String(rate) + '\n', 'utf-8')
                await writeFile(`${target}.lang`, String(lang) + '\n', 'utf-8')
                // 5.05：语种只在**变化时**报一行 —— 旁文件写的是识别端唯一看得到的东西，
                // "手机到底有没有上报语种"必须能在转发日志里查到（否则只能猜）。
                // 5.08：按 (房间, 人) 记 —— 两个说话人各有一条旁文件，混在一起记会互相掩盖。
                const track = `${audioRoom}/${audioSpeaker === '' ? 'unknown' : audioSpeaker}`
                if (state.roomLangWritten.get(track) !== lang) {
                  state.roomLangWritten.set(track, lang)
                  debug(`🗣 分轨语种：${track} → ${lang}（已写 ${target}.lang，识别端按它解码）`)
                }
              } catch (error) {
                debug(`🎙 写分轨旁文件失败（不影响音频）：${error && error.message ? error.message : error}`)
              }
            }
          }
          state.audioChunks += 1
          // 5.10：按房间也数一份（日志里的"第 N 块"与回执里的 chunks 都用它）
          if (audioRoom !== '') {
            state.roomChunks.set(audioRoom, (state.roomChunks.get(audioRoom) ?? 0) + 1)
          }
          // 4.76：同一块音频也推给本房间愿意听的人（实时传声）
          // 4.91：**先**把采样率告诉听的人（只在变化时发一帧）——
          //       手机录音可能降级到 44.1 kHz，播放端固定按 16 kHz 放会快放/慢放，
          //       听起来像"卡"或"叽叽声"，很容易被误判成网络问题。
          if (audioRoom !== '' && wsHub !== null) {
            if (state.roomRateAnswered.get(audioRoom) !== rate) {
              state.roomRateAnswered.set(audioRoom, rate)
              try {
                wsHub.broadcastFrame({ type: 'audio-meta', roomId: audioRoom, rate }, audioRoom)
              } catch (error) {
                debug('[audio] meta 发送失败：' + String(error && error.message ? error.message : error))
              }
            }
          }
          if (audioRoom !== '' && wsHub !== null && body.length > 0) {
            try {
              // 正在持麦的人不收自己的声音（回声根源，服务端兜底）
              const holderNow = floorState(options.dataDir, audioRoom).holder ?? ''
              const listeners = wsHub.broadcastRoomAudio(audioRoom, body, holderNow)
              if (listeners > 0) state.audioFanoutChunks += 1
            } catch (error) {
              debug('[audio] fanout failed: ' + String(error && error.message ? error.message : error))
            }
          }
          // 采样率变了才写旁文件（不是每块都写）
          if (state.audioRateValue !== rate) {
            await writeFile(options.audioRate, String(rate) + '\n', 'utf-8')
            state.audioRateValue = rate
          }
          // 语种同理：只有变了才写，避免每秒一次无谓的写盘
          if (state.audioLangValue !== lang) {
            await writeFile(options.audioLang, lang + '\n', 'utf-8')
            state.audioLangValue = lang
          }
        })
        try {
          await state.audioChain
        } catch (error) {
          state.audioChain = Promise.resolve()
          send(response, 500, { ok: false, error: '写音频失败：' + String(error && error.message ? error.message : error) })
          return
        }

        // ⚠️ 5.10：这里的秒数**必须按房间算**，不能报全局累计。
        //
        // 现场日志：「📥 收到音频：第 1 块 → 累计 334.5s」，而这场会才刚开口 ——
        // 因为 `state.audioBytes` 是从**全局** `audio-in.pcm` 的现有大小起步的，
        // 而那个文件**永远不清**（见下面"只追加"那段）。于是"累计"其实是
        // "这台机器上所有历史测试的总时长"，一眼看过去只觉得数字荒谬。
        // 现在：有房间就报**这一场**（`fresh=1` 时从 0 重新算），没房间才退回全局。
        const roomSeconds = audioRoom !== ''
          ? (state.roomAudioBytes.get(audioRoom) ?? 0) / 2 / (state.audioRateValue ?? rate)
          : 0
        const totalSeconds = audioRoom !== ''
          ? roomSeconds
          : (state.audioRateValue ? state.audioBytes / 2 / state.audioRateValue : 0)
        logAudioChunk(body, {
          fresh,
          room: audioRoom,
          rate: state.audioRateValue ?? rate,
          lang: state.audioLangValue ?? lang,
          totalSeconds,
        })
        send(response, 200, {
          ok: true,
          bytes: body.length,
          totalBytes: state.audioBytes,
          // 5.10：`seconds` = **这一场**已经上传的时长（`fresh=1` 起算）；
          // 需要"这台机器一共收了多少"的排障场景看 `serverBytes`。
          seconds: totalSeconds,
          serverBytes: state.audioBytes,
          chunks: audioRoom === '' ? state.audioChunks : (state.roomChunks.get(audioRoom) ?? 0),
          rate: state.audioRateValue ?? rate,
          lang: state.audioLangValue ?? lang,
          fresh,
        })
        return
      }

      // ── GET /frame（长轮询）───────────────────────────────────────────────
      // 4.84：各房间的音频分流情况（给识别/排障用：哪几场在说话、各收了多少）
      // 5.08：一场会现在是**一个目录、每个说话人一个文件**，所以这里报目录与总大小
      if (request.method === 'GET' && url.pathname === '/audio/rooms') {
        const rooms = []
        for (const [roomId, bytes] of state.roomAudioBytes.entries()) {
          const dir = roomTrackDir(options.dataDir, roomId)
          let size = 0
          let updatedAt = null
          let tracks = 0
          try {
            for (const name of readdirSync(dir)) {
              const info2 = await stat(join(dir, name))
              if (info2.isFile() === false) continue
              size += Number(info2.size)
              if (name.endsWith('.pcm')) tracks += 1
              if (updatedAt === null || info2.mtime > new Date(updatedAt)) {
                updatedAt = info2.mtime.toISOString()
              }
            }
          } catch { /* 还没落盘（或刚被清掉） */ }
          rooms.push({ room: roomId, dir, tracks, bytes, size, updatedAt })
        }
        send(response, 200, { ok: true, rooms, audioDir: join(String(options.dataDir), 'audio') })
        return
      }

      if (request.method === 'GET' && url.pathname === '/frame') {
        // 4.74：?room=<id> 只取那个房间的帧（多场会并发时互不覆盖）。
        // 不带 room 参数时行为不变（旧 APK 照样能用）。
        const roomParam = String(url.searchParams.get('room') ?? '').trim()
        const roomFrame = roomParam === '' ? null : state.framesByRoom.get(roomParam)
        const roomSeq = roomParam === '' ? 0 : (state.seqByRoom.get(roomParam) ?? 0)
        const since = Number(url.searchParams.get('since') ?? '0')
        if (!Number.isFinite(since) || since < 0) {
          send(response, 400, { ok: false, error: 'since 必须是非负数字' })
          return
        }
        // 客户端记的序号比服务端**大** —— 这只可能是转发进程重启过（seq 从 0 重新开始），
        // 而手机还揣着重启前的旧序号。
        //
        // 不处理的话会非常难查：`state.seq > since` 永远不成立，于是每一次长轮询都挂到超时，
        // 客户端只会周期性收到 changed:false，**永远等不到那个不会到来的序号**。
        // 表现就是用户说的"手机收不到任何回复，但也不报错" —— 因为从协议角度看一切正常。
        // （这个坑真踩到了：电脑侧字幕明明在写，手机上却永远是空的。）
        //
        // 所以这里主动告诉它"序号重置了"，并把当前帧一并给它，让它立刻恢复。
        // 分房间时用该房间自己的序号与帧；没带 room 参数就还是全局那一套
        const curSeq = roomParam === '' ? state.seq : roomSeq
        const curFrame = roomParam === '' ? state.lastFrame : (roomFrame === undefined ? null : roomFrame.frame)
        if (since > curSeq) {
          // 4.81：这条日志以前会一秒刷几十行。限流到 3 秒一条，并顺手做自保 ——
          // 如果同一个 since 在一秒内被问了几十次，说明客户端在死循环（旧版客户端就是），
          // 这时**主动慢一点回**，避免把 relay 与日志一起打满。
          const now = Date.now()
          state.resetBurst = (now - state.resetBurstAt <= 1000) ? state.resetBurst + 1 : 1
          state.resetBurstAt = now
          if (now - (state.resetLogAt ?? 0) > 3000) {
            state.resetLogAt = now
            debug(`↩ 手机的序号(${since}) 比服务端(${curSeq}) 大 —— 转发进程重启过，已让它复位`
              + (state.resetBurst > 1 ? `（1 秒内第 ${state.resetBurst} 次）` : ''))
          }
          if (state.resetBurst > 20) {
            // 断路器：客户端在空转，回得慢一点就不至于把服务端拖垮
            await new Promise((resolve) => setTimeout(resolve, 500))
          }
          send(response, 200, framePayload(info(), {
            ok: true,
            reset: true,
            changed: curFrame !== null,
            seq: curSeq,
            frame: curFrame,
          }))
          return
        }
        if (curSeq > since) {
          debug(`➡ 手机取字幕（since=${since}），立即给第 ${curSeq} 帧`)
          send(response, 200, framePayload(info(), {
            ok: true, changed: true, seq: curSeq, frame: curFrame,
          }))
          return
        }
        // 挂住，等新帧或超时。
        // 关键：**超时一定要回 changed:false + frame:null** —— 不能把上一帧再发一遍，
        // 否则手机会每隔一个 pollHold 就把同一句字幕重画一次。
        let done = false
        const onNotify = () => { settle(true) }
        const settle = changed => {
          if (done) return
          done = true
          clearTimeout(timer)
          state.waiters.delete(onNotify)
          if (response.writableEnded || state.closed) return
          // 4.81：这里不能用请求开始时捕获的 curSeq/curFrame ——
          // 那是**挂住之前**的快照，被唤醒时新帧已经到了，用快照会把旧帧发回去。
          // 同样也不能让 info() 的全局 seq 覆盖房间维度的 seq。
          const liveRoom = roomParam === '' ? null : state.framesByRoom.get(roomParam)
          const liveSeq = roomParam === '' ? state.seq : (state.seqByRoom.get(roomParam) ?? 0)
          const liveFrame = roomParam === '' ? state.lastFrame : (liveRoom === undefined ? null : liveRoom.frame)
          send(response, 200, framePayload(info(), {
            ok: true,
            changed: changed && liveFrame !== null,
            seq: liveSeq,
            frame: changed ? liveFrame : null,
          }))
        }
        const timer = setTimeout(() => { settle(false) }, options.pollHoldMs)
        timer.unref?.()
        state.waiters.add(onNotify)
        request.on('close', () => {
          done = true
          clearTimeout(timer)
          state.waiters.delete(onNotify)
        })
        return
      }

      // ── POST /diag ────────────────────────────────────────────────────────
      //
      // 手机把"我这边实际做了什么"回传一行，转发进程原样打进日志（前缀 [手机]）。
      //
      // 为什么需要这条通道：有些问题**只有把两边并排放才能定位**。
      // 例如"眼镜上显示 Ol…"这件事：
      //   · 电脑端的日志能证明它发了定稿帧；
      //   · 但手机收到之后有没有**应用**、应用成了什么，从电脑这边完全看不见。
      // 两边各自看都"正常"，合起来才是问题 —— 那就需要一条回传通道把它们放进同一份日志。
      //
      // 刻意做成**只读、无状态、可失败**：手机发这个请求是 fire-and-forget，
      // 失败也不影响同传（诊断通道坏掉不该把主功能拖下水）。
      if (request.method === 'POST' && url.pathname === '/diag') {
        let body
        try {
          body = await readBody(request)
        } catch (error) {
          send(response, error.statusCode ?? 400, { ok: false, error: String(error.message) })
          return
        }
        const line = typeof body.line === 'string' ? body.line : ''
        if (line !== '') {
          // 截断：诊断行不该把日志刷爆。
          // 计数放在这个分支里 —— "收到了几条诊断"应该是**有效行数**，
          // 把空请求也算上会让这个数失去意义（看它来确认通道是活的，得是有效行）。
          debug(`[手机] ${line.length > 200 ? line.slice(0, 200) + '…' : line}`)
          state.diagLines += 1
        }
        send(response, 200, { ok: true, received: state.diagLines })
        return
      }

      // ── GET /status ───────────────────────────────────────────────────────
      if (request.method === 'GET' && url.pathname === '/status') {
        send(response, 200, {
          ok: true,
          seq: state.seq,
          frames: state.frameCount,
          says: state.sayCount,
          inboxLines: state.writer.stats.lines,
          // 字幕保留期清理（P4）：累计删了多少条、保留几天
          utterancesPurged: state.utterancesPurged,
          utteranceRetentionDays: options.utteranceRetentionDays,
          rejected: state.rejected,
          rateLimited: state.rateLimited,
          diagLines: state.diagLines,
          // 译文质检：定稿帧里判出多少条确定错 / 警告，以及**每类各几条**。
          // 放上来是为了不用 grep 日志就能看到"这一场到底错了多少、错在哪一类"。
          lint: options.lint === true,
          lintBad: state.lintBad,
          lintWarn: state.lintWarn,
          lintKinds: Object.fromEntries([...state.lintKinds].sort((a, b) => b[1] - a[1])),
          waiting: state.waiters.size,
          busSeen: state.lastFrame !== null,
          // 「手机有没有连到这里」的证据。手机连不上时它自己没法说话，
          // 所以这两个数只能从电脑本地看：动 = 网络路径通了，不动 = 包被挡在外面。
          sockets: state.sockets,
          connections: state.connections,
          lastConnectionAt: state.lastConnectionAt,
          // 发言权推送（WS）的在线连接：房间级的实时通道，推的是"谁在说话"，不推音频。
          ws: wsHub.stats(),
          publicMode: options.public === true,
          inbox: options.inbox,
          bus: options.bus,
          audio: options.audio,
          audioBytes: state.audioBytes,
          // 音频文件上限与已轮转次数（长期跑时"磁盘会不会被写满"的两个答案）
          audioMaxBytes: options.audioMaxBytes,
          audioRotations: state.audioRotations,
          audioChunks: state.audioChunks,
          audioRate: state.audioRateValue,
          audioLang: state.audioLangValue,
          // 能力清单：手机据此判断"对面是不是旧版进程"（例如没有 auth 就提示重启）
          features: RELAY_FEATURES,
          // 账户：这台电脑上有没有人注册过（手机据此决定显示"登录"还是"注册"）
          accounts: hasAccounts(await loadAccounts(options.dataDir)),
          authOk: state.authOk,
          authRejected: state.authRejected,
          // 手机侧设置：校对现在是开还是关（手机端据此显示开关状态，而不是自以为）。
          settings: await readSettings(options.dataDir),
          settingsWrites: state.settingsWrites,
          // 热词对照表：上传过几次、最近一次是谁、几条。手机端拿它显示"本次生效 N 条"。
          termsSaves: state.termsSaves,
          termsUser: state.termsUser,
          termsEntries: state.termsEntries,
          ...info(),
        })
        return
      }

      // ── 账户：注册 / 登录 / 注销 / 我是谁 ───────────────────────────────────
      //
      // 为什么需要它：热词表原来靠客户端自报用户名（`?user=wu`），等于没有权限 ——
      // 任何人改一个参数就能读写别人的表。现在：
      //   注册/登录 → 拿 token → 之后**只认 token**，服务端从 token 反查用户。
      // 密码用 scrypt + 每用户独立盐存哈希；token 也只存 sha256（库泄露不等于被登录）。
      if (request.method === 'POST' && url.pathname === '/auth/logout') {
        const token = request.headers['x-leion-token'] ?? url.searchParams.get('token')
        const doc = await loadAccounts(options.dataDir)
        const result = revokeToken(doc, typeof token === 'string' ? token : '')
        if (result.ok !== true) {
          send(response, 401, { ok: false, error: 'auth-required', hint: result.error })
          return
        }
        await saveAccounts(options.dataDir, result.doc)
        debug('[账户] 已注销一个 token')
        send(response, 200, { ok: true })
        return
      }
      if (request.method === 'GET' && url.pathname === '/auth/whoami') {
        const token = request.headers['x-leion-token'] ?? url.searchParams.get('token')
        const doc = await loadAccounts(options.dataDir)
        const user = userForToken(doc, typeof token === 'string' ? token : '')
        if (user === null) {
          send(response, 401, { ok: false, error: 'auth-required', hint: 'token 无效或已注销' })
          return
        }
        // 4.62："我的"页面要显示「翻译服务及有效状态」，所以 whoami 顺带把账号的
        // 状态与到期时间给出来（永久账号没有 expiresAt，字段就省略，不是 null）。
        const record = recordOf(doc, user) ?? {}
        send(response, 200, {
          ok: true, user, role: roleOf(doc, user), accounts: hasAccounts(doc),
          status: typeof record.status === 'string' ? record.status : 'active',
          expiresAt: typeof record.expiresAt === 'string' ? record.expiresAt : '',
        })
        return
      }

      // ── 邮箱 + 验证码（docs/19）：管理员/用户都用这一条路 ─────────────────────
      //
      // 本地工具，不接邮件服务：验证码**打印在 relay 的控制台**上。
      // 局域网模式下也把码回给调用方（否则没有邮件通道就没法登录），
      // 但 --public 模式**不回**（公网绝不能在响应里带码）。
      if (request.method === 'POST' && url.pathname === '/auth/code') {
        const body = await readBody(request)
        const doc = await loadAccounts(options.dataDir)
        const issued = issueCode(doc, String(body.email ?? ''))
        if (issued.ok !== true) {
          send(response, 400, { ok: false, error: 'bad-email', hint: issued.error })
          return
        }
        await saveAccounts(options.dataDir, issued.doc)
        console.log(`[账户] 给 ${body.email} 的验证码：${issued.code}（10 分钟有效）`)
        send(response, 200, {
          ok: true,
          hint: '验证码已打印在电脑端的 relay 控制台',
          ...(options.public === true ? {} : { code: issued.code }),
        })
        return
      }
      if (request.method === 'POST' && url.pathname === '/auth/register-email') {
        // 注册：邮箱 + 用户名 + 密码 + 验证码（docs/19）。登录仍走 /auth/login（用户名+密码）。
        const body = await readBody(request)
        const doc = await loadAccounts(options.dataDir)
        const result = registerWithEmail(doc, {
          email: String(body.email ?? ''), username: String(body.username ?? ''),
          password: String(body.password ?? ''), code: String(body.code ?? ''),
          label: typeof body.label === 'string' ? body.label : '',
        })
        if (result.ok !== true) {
          send(response, 400, { ok: false, error: 'register-failed', hint: result.error })
          return
        }
        await saveAccounts(options.dataDir, result.doc)
        debug(`[账户] 邮箱注册成功：${result.username}（${result.email}）`)
        send(response, 200, { ok: true, user: result.username, role: result.role, token: result.token })
        notifyKickedIfReplaced(result.username, result.token)
        return
      }
      if (request.method === 'POST' && url.pathname === '/auth/login') {
        // 登录：用户名 + 密码（不要求邮箱）。与 /auth/register-email 配套。
        const body = await readBody(request)
        const doc = await loadAccounts(options.dataDir)
        const result = login(doc, String(body.username ?? ''), String(body.password ?? ''),
          typeof body.label === 'string' ? body.label : '')
        if (result.ok !== true) {
          send(response, 401, { ok: false, error: 'auth-failed', hint: result.error })
          return
        }
        await saveAccounts(options.dataDir, result.doc)
        send(response, 200, { ok: true, user: result.username, role: roleOf(result.doc, result.username), token: result.token })
        notifyKickedIfReplaced(result.username, result.token)
        return
      }

      // ── 手机侧运行时设置（docs/15 §14 与 plugin/core.mjs 的 refreshRuntimeSettings）──
      //
      // 现在只有一项：`proofread`（大模型校对开关）。放在这里的理由很实际：
      // 部署时的 config 改一次要重启 harness，而"这一场要不要校对"是用户当场想改的事。
      // 插件在**排进第一条校对之前**读一次这个文件；读不到就按 config 走。
      if (request.method === 'GET' && url.pathname === '/settings') {
        const current = await readSettings(options.dataDir)
        send(response, 200, { ok: true, settings: current, path: defaultSettings(options.dataDir) })
        return
      }
      if (request.method === 'PUT' && url.pathname === '/settings') {
        let body
        try {
          body = await readBody(request)
        } catch (error) {
          sendAndClose(request, response, error.statusCode ?? 400, { ok: false, error: String(error.message) })
          return
        }
        if (body === null || typeof body !== 'object' || typeof body.proofread !== 'boolean') {
          send(response, 400, { ok: false, error: 'bad-settings', hint: '需要 { "proofread": true/false }' })
          return
        }
        const next = { proofread: body.proofread }
        await writeSettings(options.dataDir, next)
        state.settingsWrites += 1
        debug(`[设置] 手机把校对 ${next.proofread ? '打开' : '关掉'}了 —— 下一场同传生效`)
        send(response, 200, { ok: true, settings: next, effectiveAt: 'next-session' })
        return
      }

      // ── 热词对照表（docs/15：阶段 1 只有"校验 + 存取"，不做替换）────────────
      //
      // 三个端点刻意分开：
      //   POST /terms/validate  只校验、不落盘 ——  手机界面可以边填边验，反复点
      //   PUT  /terms           全合法才整体替换某个用户的表（方案 C：全有或全无）
      //   GET  /terms?user=     取当前生效的表，手机端回显
      //
      // 为什么"全有或全无"：部分落盘会造出"用户看到 ok:true、其实半张表没存上"
      // 的静默状态 —— 而我们的验收门槛是"误替换 = 0"，静默半生效正好能绕过所有判据。
      if (request.method === 'POST' && url.pathname === '/terms/validate') {
        await handleTermsWrite(response, request, url, { write: false })
        return
      }
      if (request.method === 'PUT' && url.pathname === '/terms') {
        await handleTermsWrite(response, request, url, { write: true })
        return
      }
      if (request.method === 'GET' && url.pathname === '/terms') {
        const identity = await resolveIdentity(request, url)
        if (identity.ok !== true) {
          send(response, identity.status, { ok: false, error: identity.error, hint: identity.hint })
          return
        }
        const who = { ok: true, user: identity.user }
        const doc = await loadTerms(options.dataDir)
        const table = getTable(doc, who.user)
        send(response, 200, {
          ok: true, user: who.user, entries: table.entries, updatedAt: table.updatedAt,
          effectiveAt: 'next-session',
        })
        return
      }

      // ── 当前会议术语（docs/19）：插件读的那份，可查也可手动重新发布 ──────────
      if (request.method === 'GET' && url.pathname === '/org/meeting/current') {
        const current = await readCurrentMeeting(options.dataDir)
        if (current === null) { send(response, 404, { ok: false, error: '还没有任何一场会议术语（手机开始同传后会自动生成）' }); return }
        send(response, 200, { ok: true, ...current })
        return
      }
      if (request.method === 'POST' && url.pathname === '/org/meeting/publish') {
        const body = await readBody(request)
        const selection = await loadSelection(options.dataDir, options.meetingId ?? 'current')
        const published = await publishMeetingTerms(options.dataDir, {
          libraryIds: Array.isArray(body.libraryIds) ? body.libraryIds : selection.libraryIds,
          owner: selection.selectedBy ?? null,
        })
        debug(`[术语] 手动发布：会议 ${published.meetingId}，${published.entries} 条`)
        send(response, 200, { ok: true, meetingId: published.meetingId, entries: published.entries, conflicts: published.conflicts })
        return
      }
      // ── 组织接口：库 / 会议选库 / 申请审批（docs/19）──────────────────────────
      //
      // 这一层的特点：**权限在服务端**（用户调管理员接口拿 403），
      // 身份只认 token 解出来的 user（请求体里自报的 applicant 不采信）。
      // 具体语义都在 relay/org-api.mjs（纯函数，能被逐条测），这里只做三件事：
      // 解 token → 取角色 → 转交。
      if (url.pathname.startsWith('/org/')) {
        const doc = await loadAccounts(options.dataDir)
        const token = request.headers['x-leion-token'] ?? url.searchParams.get('token')
        const user = userForToken(doc, typeof token === 'string' ? token : '')
        const role = user === null ? null : roleOf(doc, user)
        let body = {}
        if (request.method === 'POST' || request.method === 'PUT') {
          // readBody 已经解析好 JSON 并返回对象（解析失败会抛 400），别再 JSON.parse 一次
          body = await readBody(request)
        }
        const result = await handleOrg({
          // path 要**带 query**：/org/history?limit=20 的 limit 就在这后面
          method: request.method, path: url.pathname + (url.search ?? ''), body, user, role,
          root: options.dataDir,
          // 历史页顶部要写"记录保存 N 天"：这个值只能是服务端说，客户端不编
          utteranceRetentionDays: options.utteranceRetentionDays,
          // ── 4.99 管理员清理历史：清单要"每个房间占多少音频"，清理要"把文件也删掉" ──
          // 路径规则只有这个文件知道（roomAudioPath / 总线目录 / 收件箱按房间分文件），
          // 所以由这里交给 org-api 回调，而不是让那边重新拼一遍路径（拼错就是删错文件）。
          audioBytesOf: (roomId) => {
            // 5.08：一场会的音频是**一个目录、每人一个文件**（另兼容旧的单文件）
            let total = 0
            try {
              const dir = roomTrackDir(options.dataDir, roomId)
              for (const name of readdirSync(dir)) {
                try { total += statSync(join(dir, name)).size } catch { /* 正在写 */ }
              }
            } catch { /* 没有分轨目录 */ }
            try { total += statSync(roomAudioPath(options.dataDir, roomId)).size } catch { /* 旧数据没有就没有 */ }
            return total
          },
          audioDirBytes: () => {
            // 目录里现在有子目录（一场会一个），所以必须递归：原来只 stat 顶层文件，
            // 分轨之后会算成 0 —— 而"清了多少空间"报 0 是最容易让人误判的那种错。
            const dir = join(options.dataDir, 'audio')
            const sum = (target) => {
              let total = 0
              for (const entry of readdirSync(target, { withFileTypes: true })) {
                const full = join(target, entry.name)
                try {
                  total += entry.isDirectory() ? sum(full) : statSync(full).size
                } catch { /* 正在写 / 刚被删 */ }
              }
              return total
            }
            try {
              return sum(dir)
            } catch { return 0 }
          },
          purgeHistoryFiles: (roomIds) => removeRoomDataFiles(options.dataDir, roomIds, options.busesDir ?? options.bus),
          debug,
          // 断线清扫（4.42）：GET /floor 发现"锁着麦但人不在"时，顺手推给全房间
          onFloorSwept: (roomId, swept) => {
            try {
              wsHub.broadcastFloor(roomId, {
                released: swept.released,
                releasedLocked: swept.locked === true,
              })
            } catch (error) {
              debug(`[ws] 广播断线释放失败（不影响主流程）：${error?.message ?? error}`)
            }
          },
        })
        send(response, result.status, result.json)
        // 发言权变了 → 立刻推给这个房间里的所有人（`/ws` 通道）。
        // 轮询仍然是兜底：WS 只负责"快点知道"，不替代 GET /floor。
        // heartbeat 不推：它只刷新租约，可见状态没变，推了只是白费流量。
        if (result.status < 400 && request.method === 'POST') {
          const floorMatch = /^\/org\/rooms\/([^/]+)\/floor$/.exec(url.pathname)
          if (floorMatch !== null) {
            if (body.action !== 'heartbeat') {
              wsHub.broadcastFloor(decodeURIComponent(floorMatch[1]))
            }
          } else if (/^\/org\/rooms\/[^/]+\/members\/remove$/.test(url.pathname)) {
            // 被移出的人可能正持麦：服务端已经清空了，这里推一次让全屋立刻看到
            const removedMatch = /^\/org\/rooms\/([^/]+)\/members\/remove$/.exec(url.pathname)
            if (removedMatch !== null) {
              const removedRoom = decodeURIComponent(removedMatch[1])
              wsHub.broadcastFloor(removedRoom)
              // 被移出的人**立刻**离开：推一条 removed 再断连接，别让他自己在屋里再待十几秒
              if (result.json !== null && typeof result.json.removed === 'string') {
                wsHub.removeUserFromRoom(removedRoom, result.json.removed, 'removed-by-host')
              }
            }
          } else if (url.pathname === '/org/rooms/leave') {
            const leftRoomId = decodeURIComponent(String(body.roomId ?? body.code ?? ''))
            // 持麦者退出时服务端会把麦清空（lib/rooms.mjs）→ 留下的人也要立刻看到
            wsHub.broadcastFloor(leftRoomId)
            // 发起者退出 = 整场结束：立刻把还连着的人赶出去（4.44）。
            // 只广播状态不够 —— 他们会留在"已结束的会议"里继续点按钮。
            if (result.json !== null && result.json.closed === true) {
              const kicked = wsHub.closeRoom(leftRoomId, 'host-left')
              if (kicked > 0) debug(`🚪 会议已结束（发起者退出），已断开 ${kicked} 个在线连接`)
            }
          }
        }
        return
      }

      // 管理员网页：**直接由 relay 提供**（不另起一个服务器），这样它访问的就是真实接口。
      if (request.method === 'GET' && (url.pathname === '/admin' || url.pathname === '/admin/')) {
        const html = await readFile(join(ROOT, 'scripts', 'admin-ui.html'))
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        response.end(html)
        return
      }

      send(response, 404, { ok: false, error: 'not-found', routes: ['/hello', '/say', '/audio', '/frame', '/status', '/terms', '/settings', '/auth/register', '/auth/login', '/auth/logout', '/auth/whoami', '/org/libraries', '/org/meeting/<id>/libraries', '/org/requests', '/admin', '/ws'] })
    })().catch(error => {
      if (!response.writableEnded) {
        send(response, 500, { ok: false, error: String(error && error.message ? error.message : error) })
      }
    })
  })

  server.on('connection', socket => {
    state.sockets += 1
    // 累计计数 + 最后一次连进来的时刻。这两个数是"手机到底有没有连到这里"的**唯一**证据：
    // 手机点连接时 SYN 先到防火墙，被丢掉的话进程根本不会触发这个事件 ——
    // 于是"计数不动"就明确指向防火墙或网络隔离，而不是应用层的问题。
    // （手机连不上时也没法去问它，所以这个数要从电脑本地看，见 scripts/net-doctor.mjs --watch）
    state.connections += 1
    state.lastConnectionAt = new Date().toISOString()
    socket.on('close', () => { state.sockets -= 1 })
  })

  // ── 发言权推送通道（手写 WebSocket，见 lib/ws-hub.mjs）─────────────────
  // 只推"谁在说话/锁没锁"这类低频状态；音频与字幕不走这里。
  // 认证与普通请求同一套：共享密钥 + token（token 决定"我是房间里的谁"）。
  let wsHub = null
  wsHub = createWsHub({
    dataDir: options.dataDir,
    checkSecret: given => secretMatches(secret, given),
    resolveUser: async token => {
      if (typeof token !== 'string' || token === '') return null
      const doc = await loadAccounts(options.dataDir)
      return userForToken(doc, token)
    },
    debug,
  })
  wsHub.attach(server)

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, resolve)
  })

  return {
    server,
    state,
    secret,
    options,
    port: server.address().port,
    /** 主动结束一次长轮询（测试里用它避免等待超时）。 */
    notify: notifyWaiters,
    /** 立刻跑一次字幕清理（测试与运维手搓时用）。返回删掉的条数。 */
    purgeUtterances,
    async close() {
      state.closed = true
      state.waiters.clear()
      clearInterval(busTimer)
      clearInterval(purgeTimer)
      if (sweepTimer !== null) clearInterval(sweepTimer)
      wsHub.close()
      await state.writeChain.catch(() => {})
      await state.writer.close().catch(() => {})
      await new Promise(resolve => server.close(resolve))
      server.closeAllConnections?.()
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error('[relay] ' + String(error && error.message ? error.message : error))
    process.exitCode = 2
    return
  }
  if (options.help === true) {
    process.stdout.write(HELP)
    return
  }
  if (options.dataDir === DEFAULT_DATA_DIR) await mkdir(DEFAULT_DATA_DIR, { recursive: true })

  const relay = await startRelay(options)
  const log = options.quiet ? () => {} : (...args) => console.log(...args)

  process.stdout.write(formatBanner(options, relay, lanAddresses()) + '\n')
  if (options.public === true) process.stdout.write(formatPublicChecklist(options, relay) + '\n')
  log('[relay] 等待手机连接…（Ctrl-C 结束）')

  const shutdown = async () => {
    console.log('\n[relay] 正在关闭…')
    await relay.close()
    process.exit(0)
  }
  process.on('SIGINT', () => { void shutdown() })
  process.on('SIGTERM', () => { void shutdown() })
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
