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
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createInboxWriter } from '../bridge/asr-bridge.mjs'
import { LIVE_DIR, defaultBus, defaultInbox, defaultSecret } from '../lib/paths.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '')

/**
 * 默认数据目录：和 scripts/harness-side.mjs 指向同一对文件，两边靠它对接。
 * 具体路径来自 lib/paths.mjs —— 那是唯一的来源，别在这里再写字面量。
 */
export const DEFAULT_DATA_DIR = LIVE_DIR

/** 每次请求体上限。字幕/一句话都很短，超过这个大小基本不是正常客户端。 */
const MAX_BODY_BYTES = 8 * 1024

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
  --poll-hold-ms <n>    长轮询最长挂起时间（缺省 25000）
  --bus-poll-ms <n>     字幕总线轮询间隔（缺省 60）
  --quiet               少打印
  --help

端点（手机侧要用）
  GET  /hello              带密钥 → { device, cols, lines, seq }
  POST /say                {"text":"...","from":"pt-BR"} → 追加进收件箱
  GET  /frame?since=<seq>  长轮询取字幕帧
  GET  /status             诊断

所有请求都要带密钥：请求头 X-Leion-Secret: <密钥>（或 ?secret=<密钥>，便于浏览器里试）
`

export function parseArgs(argv) {
  const options = { port: 8788, host: '0.0.0.0', pollHoldMs: 25000, busPollMs: 60, quiet: false }
  const takesValue = new Set(['port', 'host', 'secret', 'data-dir', 'inbox', 'bus', 'poll-hold-ms', 'bus-poll-ms'])
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new Error(`看不懂的参数：${token}（用 --help 看用法）`)
    const key = token.slice(2)
    if (key === 'quiet') { options.quiet = true; continue }
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
  const secret = await resolveSecret(options)
  await mkdir(options.dataDir, { recursive: true })

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
        send(response, 200, { ok: true, inboxLines: state.inboxLines, ...info() })
        return
      }

      // ── GET /frame（长轮询）───────────────────────────────────────────────
      if (request.method === 'GET' && url.pathname === '/frame') {
        const since = Number(url.searchParams.get('since') ?? '0')
        if (!Number.isFinite(since) || since < 0) {
          send(response, 400, { ok: false, error: 'since 必须是非负数字' })
          return
        }
        if (state.seq > since) {
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
          ...info(),
        })
        return
      }

      send(response, 404, { ok: false, error: 'not-found', routes: ['/hello', '/say', '/frame', '/status'] })
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

  console.log('')
  console.log('─'.repeat(68))
  console.log('  亮亮眼镜 · 局域网转发已启动')
  console.log('─'.repeat(68))
  console.log(`  收件箱（手机的文字进这里）  ${options.inbox}`)
  console.log(`  字幕总线（字幕从这里出去）  ${options.bus}`)
  console.log(`  共享密钥（手机上要填这个）  ${relay.secret}`)
  console.log('')
  const addresses = lanAddresses()
  const real = addresses.filter(a => !looksVirtual(a.name))
  const virtual = addresses.filter(a => looksVirtual(a.name))
  console.log('  手机上的地址填（要和电脑在同一个 WiFi）：')
  if (real.length > 0) {
    for (const a of real) console.log(`      http://${a.address}:${relay.port}      ← ${a.name}`)
  } else {
    console.log('      （没找到真实网卡地址，检查 WiFi 是否连着）')
  }
  if (virtual.length > 0) {
    console.log('  这些是虚拟网卡，手机连不上，别填：')
    for (const a of virtual) console.log(`      ${a.address}  (${a.name})`)
  }
  console.log('')
  console.log('  自检（在电脑浏览器或 curl 里试）：')
  console.log(`      curl "http://127.0.0.1:${relay.port}/status?secret=${relay.secret}"`)
  console.log('─'.repeat(68))
  console.log('')
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
