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
import { mkdir, appendFile, readFile, stat, writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createInboxWriter } from '../bridge/asr-bridge.mjs'
import {
  LIVE_DIR, defaultAudioIn, defaultAudioLang, defaultAudioRate, defaultBus, defaultInbox, defaultSecret,
} from '../lib/paths.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '')

/**
 * 默认数据目录：和 scripts/harness-side.mjs 指向同一对文件，两边靠它对接。
 * 具体路径来自 lib/paths.mjs —— 那是唯一的来源，别在这里再写字面量。
 */
export const DEFAULT_DATA_DIR = LIVE_DIR

/** 每次请求体上限。字幕/一句话都很短，超过这个大小基本不是正常客户端。 */
const MAX_BODY_BYTES = 8 * 1024

/**
 * 音频请求体的上限，单独一档。
 * 1 秒 16 kHz 单声道 PCM 就是 32000 字节，用上面那个 8 KB 的限额会把正常录音直接拒掉。
 * 1 MB 够手机一次传 32 秒；平时手机每秒传一块，远低于这个数。
 */
const MAX_AUDIO_BYTES = 1024 * 1024

/** 允许的录音采样率：16 kHz 是 Whisper 要的，44.1/48 kHz 是安卓降级时的常见值。 */
const ALLOWED_RATES = [16000, 44100, 48000]

/** 允许的语种标记（与收件箱行的 from 字段同一套取值）。 */
const LANGS = ['zh-CN', 'pt-BR']

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

export function parseArgs(argv) {
  const options = { port: 8788, host: '0.0.0.0', pollHoldMs: 25000, busPollMs: 60, quiet: false }
  const takesValue = new Set(['port', 'host', 'secret', 'data-dir', 'inbox', 'bus', 'audio', 'audio-rate', 'audio-lang', 'poll-hold-ms', 'bus-poll-ms'])
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new Error(`看不懂的参数：${token}（用 --help 看用法）`)
    const key = token.slice(2)
    if (key === 'quiet') { options.quiet = true; continue }
    if (key === 'verbose') { options.verbose = true; continue }
    if (key === 'help') { options.help = true; continue }
    if (!takesValue.has(key)) throw new Error(`未知选项 --${key}（用 --help 看用法）`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} 需要一个值`)
    index += 1
    if (key === 'port') options.port = Number(value)
    else if (key === 'poll-hold-ms') options.pollHoldMs = Number(value)
    else if (key === 'bus-poll-ms') options.busPollMs = Number(value)
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
  for (const key of ['pollHoldMs', 'busPollMs']) {
    if (!Number.isFinite(options[key]) || options[key] <= 0) {
      throw new Error(`${key} 必须是正数，收到 ${JSON.stringify(options[key])}`)
    }
  }
  options.dataDir = options.dataDir ?? DEFAULT_DATA_DIR
  options.inbox = options.inbox ?? defaultInbox(options.dataDir)
  options.bus = options.bus ?? defaultBus(options.dataDir)
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
  if (typeof options.secret === 'string' && options.secret !== '') return options.secret
  const path = defaultSecret(options.dataDir)
  try {
    const existing = (await readFile(path, 'utf-8')).trim()
    if (existing !== '') return existing
  } catch { /* 还没有，下面生成 */ }
  const generated = randomBytes(6).toString('hex')
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
 * 启动转发进程。
 * @returns { server, close, state, secret, port } —— 测试直接用这个，不必起 CLI
 */
export async function startRelay(rawOptions = {}) {
  const options = Object.assign({
    port: 0, host: '127.0.0.1', pollHoldMs: 25000, busPollMs: 60,
    dataDir: DEFAULT_DATA_DIR, quiet: true,
  }, rawOptions)
  options.inbox = options.inbox ?? defaultInbox(options.dataDir)
  options.bus = options.bus ?? defaultBus(options.dataDir)
  options.audio = options.audio ?? defaultAudioIn(options.dataDir)
  options.audioRate = options.audioRate ?? defaultAudioRate(options.dataDir)
  options.audioLang = options.audioLang ?? defaultAudioLang(options.dataDir)
  const secret = await resolveSecret(options)
  await mkdir(options.dataDir, { recursive: true })

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

  const state = {
    /** 已读到的字幕总线原始内容（内容变了才算新帧） */
    busRaw: '',
    /** 单调递增的帧序号：手机用它做 since，避免重复渲染 */
    seq: 0,
    /** 最近一帧 */
    lastFrame: null,
    /** 最近的帧 JSON（供 /hello、/status 用） */
    hello: null,
    /** 长轮询里挂着的等待者 */
    waiters: new Set(),
    /** 计数 */
    sayCount: 0,
    frameCount: 0,
    rejected: 0,
    sockets: 0,
    inboxLines: 0,
    writer: null,
    /** 写入串行化：收件箱的顺序就是字幕的顺序，不能乱 */
    writeChain: Promise.resolve(),
    /** 音频：已落盘字节数 / 已收块数 / 当前采样率（null = 还没收到过） */
    audioBytes: 0,
    audioChunks: 0,
    audioRateValue: null,
    audioLangValue: null,
    /** 音频写入也要串行化：追加写交错会把 PCM 数据搅碎，识别必然出错 */
    audioChain: Promise.resolve(),
    closed: false,
  }

  state.writer = await createInboxWriter({ inboxPath: options.inbox, format: 'text' })

  function notifyWaiters() {
    for (const resolve of state.waiters) resolve()
    state.waiters.clear()
  }

  /** 轮询字幕总线：内容变了就分配新序号并唤醒长轮询。 */
  async function pollBus() {
    if (state.closed) return
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
    state.seq += 1
    state.frameCount += 1
    state.lastFrame = frame
    // 调试：字幕总线一变就报一行 —— 手机应该马上能看到这一帧
    debug(`📺 字幕已更新（第 ${state.seq} 帧）[${frame.speaker ?? '?'} / ${frame.lang ?? '?'}] `
      + `${frame.text ?? ''}`)
    notifyWaiters()
  }

  const busTimer = setInterval(() => { void pollBus() }, options.busPollMs)
  busTimer.unref?.()

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

  async function readBody(request) {
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
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
  function info() {
    return {
      device: state.lastFrame?.device ?? 'Leion Pro',
      cols: state.lastFrame?.cols ?? FALLBACK_COLS,
      lineBudget: state.lastFrame?.lineBudget ?? FALLBACK_LINES,
      seq: state.seq,
      bridge: 'lan-relay',
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
        send(response, 401, { ok: false, error: 'unauthorized', hint: '请求头要带 X-Leion-Secret' })
        return
      }

      // ── GET /hello ────────────────────────────────────────────────────────
      if (request.method === 'GET' && url.pathname === '/hello') {
        send(response, 200, { ok: true, ...info() })
        return
      }

      // ── POST /say ─────────────────────────────────────────────────────────
      if (request.method === 'POST' && url.pathname === '/say') {
        let body
        try {
          body = await readBody(request)
        } catch (error) {
          send(response, error.statusCode ?? 400, { ok: false, error: String(error.message) })
          return
        }
        const text = body.text
        if (typeof text !== 'string' || text.trim() === '') {
          send(response, 400, { ok: false, error: 'text 必须是非空字符串' })
          return
        }
        if (body.from !== undefined && body.from !== null && body.from !== '' && !['zh-CN', 'pt-BR'].includes(body.from)) {
          send(response, 400, { ok: false, error: "from 只能是 'zh-CN' / 'pt-BR' 或省略" })
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
          send(response, error.statusCode ?? 400, { ok: false, error: String(error.message) })
          return
        }
        const body = Buffer.concat(chunks)
        // 采样率是 2 字节一帧，奇数长度说明发端截断在半帧上 —— 收下会污染后面所有数据
        if (body.length % 2 !== 0) {
          send(response, 400, { ok: false, error: 'PCM 数据长度必须是偶数（16-bit 一帧 2 字节）' })
          return
        }

        state.audioChain = state.audioChain.then(async () => {
          await mkdir(dirname(options.audio), { recursive: true })
          if (fresh) {
            await writeFile(options.audio, Buffer.alloc(0))
            state.audioBytes = 0
            state.audioChunks = 0
          }
          if (body.length > 0) {
            await appendFile(options.audio, body)
            state.audioBytes += body.length
          }
          state.audioChunks += 1
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

        // 顺便让 /status 的计数准一点：手机端靠它确认音频真的在往上走
        const totalSeconds = state.audioRateValue ? state.audioBytes / 2 / state.audioRateValue : 0
        // 调试：让这个终端能直接看出"音频上来了"。
        // 缺省每秒汇总一行（不是每块一行）——音频是每秒一块，逐块打会刷屏；
        // 而且"每秒都在涨"这个信息本身就够判断链路了。
        // 手机是每秒一块，所以阈值取 900ms 而不是 1000ms ——
        // 卡在 1000 的话，抖动会让大约一半的块被吞掉，看起来像"音频断断续续"。
        const nowMs = Date.now()
        if (options.verbose || fresh || nowMs - audioLogAt >= 900) {
          audioLogAt = nowMs
          debug(`📥 收到手机音频：+${body.length} 字节（第 ${state.audioChunks} 块）`
            + ` → 累计 ${totalSeconds.toFixed(1)}s @ ${state.audioRateValue ?? rate}Hz`
            + `，语种 ${state.audioLangValue ?? lang}${fresh ? '（新一次录音，已清空）' : ''}`)
        }
        send(response, 200, {
          ok: true,
          bytes: body.length,
          totalBytes: state.audioBytes,
          chunks: state.audioChunks,
          rate: state.audioRateValue ?? rate,
          lang: state.audioLangValue ?? lang,
          seconds: totalSeconds,
          fresh,
        })
        return
      }

      // ── GET /frame（长轮询）───────────────────────────────────────────────
      if (request.method === 'GET' && url.pathname === '/frame') {
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
        if (since > state.seq) {
          debug(`↩ 手机的序号(${since}) 比服务端(${state.seq}) 大 —— 转发进程重启过，已让它复位`)
          send(response, 200, {
            ok: true,
            reset: true,
            changed: state.lastFrame !== null,
            seq: state.seq,
            frame: state.lastFrame,
            ...info(),
          })
          return
        }
        if (state.seq > since) {
          debug(`➡ 手机取字幕（since=${since}），立即给第 ${state.seq} 帧`)
          send(response, 200, { ok: true, changed: true, seq: state.seq, frame: state.lastFrame, ...info() })
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
          send(response, 200, {
            ok: true,
            changed,
            seq: state.seq,
            frame: changed ? state.lastFrame : null,
            ...info(),
          })
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

      // ── GET /status ───────────────────────────────────────────────────────
      if (request.method === 'GET' && url.pathname === '/status') {
        send(response, 200, {
          ok: true,
          seq: state.seq,
          frames: state.frameCount,
          says: state.sayCount,
          inboxLines: state.writer.stats.lines,
          rejected: state.rejected,
          waiting: state.waiters.size,
          busSeen: state.lastFrame !== null,
          inbox: options.inbox,
          bus: options.bus,
          audio: options.audio,
          audioBytes: state.audioBytes,
          audioChunks: state.audioChunks,
          audioRate: state.audioRateValue,
          audioLang: state.audioLangValue,
          ...info(),
        })
        return
      }

      send(response, 404, { ok: false, error: 'not-found', routes: ['/hello', '/say', '/audio', '/frame', '/status'] })
    })().catch(error => {
      if (!response.writableEnded) {
        send(response, 500, { ok: false, error: String(error && error.message ? error.message : error) })
      }
    })
  })

  server.on('connection', socket => {
    state.sockets += 1
    socket.on('close', () => { state.sockets -= 1 })
  })

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
    async close() {
      state.closed = true
      state.waiters.clear()
      clearInterval(busTimer)
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
