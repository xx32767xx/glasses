/**
 * ws-hub.mjs —— 一个**手写的** WebSocket 服务端（RFC 6455），只用来推"发言权"状态
 * ============================================================================
 *
 * <p><b>为什么手写而不是装 `ws` 包</b>：整个仓库是零第三方依赖（`package.json` 的
 * dependencies 是空的，`tests/run-all.mjs` 有一条断言钉着"没有裸包名 import"）。
 * 而 Node 只自带 WebSocket **客户端**，没有服务端。要服务端就得自己实现握手与帧。
 * 代价是这 200 行；收益是部署机上不用 `npm install`（那台机器出网并不稳，见 docs/20）。
 *
 * <p><b>为什么需要它</b>：发言权原来靠"每 2 秒 GET 一次 /floor"，于是"XX 接管了麦克风"
 * 最慢要 2 秒才被对方看到。改成 WS 之后是**一推即到**（实测同一台机器上 1~3 ms）。
 * 这条通道只推**低频状态**（谁在说话、锁没锁），不推音频，也不推字幕（字幕仍走 /frame）。
 *
 * <p><b>刻意只实现到"够用且安全"为止</b>：
 *   · 支持 text 帧、分片（continuation）、ping/pong、close；
 *   · 客户端帧**必须**带掩码（RFC 要求），不带就按协议错误断开；
 *   · 不做扩展（permessage-deflate 等），不发二进制帧（S1 不需要）；
 *   · 单条消息上限 64 KB —— 这条通道只发状态，超过它就是出错了。
 *
 * <p>两种连接（4.45）：
 *   · `/ws?room=<id或邀请码>` —— 房间通道：推发言权与字幕（原来就有）；
 *   · `/ws?session=1`        —— **会话通道**：只推"你被别处登录挤下线了"。
 * 为什么后者需要单独的连接：首页与房间大厅**根本不是房间里的成员**，它们没有房间可挂，
 * 而"被挤下线"恰恰是在这两个页面最容易发生（另一台手机正在登录）。靠轮询要等 10 秒，
 * 靠推送是一秒之内。
 *
 * 协议（应用层，都是 JSON 文本帧）：
 *   服务端 → 客户端（房间）：`{ type:'floor', roomId, holder, locked, since, leaseMs, at, released, releasedLocked }`
 *                  `{ type:'frame', seq, frame }`（新字幕，4.43 起也走这条通道）
 *                  `{ type:'closed', roomId, reason }`（会议结束，4.44；随后连接被关闭）
 *                  `{ type:'removed', roomId, reason }`（被发起者移出，4.55；随后连接被关闭）
 *                  （会话）`{ type:'session', user }` / `{ type:'kicked', reason }`（随后连接被关闭）
 *   客户端 → 服务端：`{ type:'ping' }`（回 `{type:'pong'}`）、`{ type:'snapshot' }`（重发一次当前状态）
 *   连上就立刻收到一条 `floor`，不需要客户端再问一次。
 */

import { createHash, randomBytes } from 'node:crypto'

import { FLOOR_LEASE_MS, floorState } from './floor.mjs'
import { roomByCode, roomById } from './rooms.mjs'

/** RFC 6455 §1.3 规定的握手魔数。 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

const OP_CONTINUATION = 0x0
const OP_TEXT = 0x1
const OP_BINARY = 0x2
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

const MAX_MESSAGE_BYTES = 64 * 1024
const MAX_CONNECTIONS_PER_ROOM = 8
const MAX_CONNECTIONS_TOTAL = 64
const PING_INTERVAL_MS = 20000
/** 连续两个 ping 周期没有任何回音就当连接已死。 */
const IDLE_TIMEOUT_MS = PING_INTERVAL_MS * 2.5

/** 握手应答：base64(sha1(key + GUID))。 */
export function wsAcceptKey(key) {
  return createHash('sha1').update(String(key) + WS_GUID, 'utf8').digest('base64')
}

/**
 * 编一帧（服务端发出的帧**不加**掩码；只有客户端发出的才加）。
 * @param {number} opcode
 * @param {string|Buffer} payload
 * @param {{fin?: boolean}} [options]
 */
export function encodeFrame(opcode, payload = Buffer.alloc(0), options = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
  const fin = options.fin === false ? 0 : 0x80
  const length = data.length
  let header
  if (length < 126) {
    header = Buffer.from([fin | (opcode & 0x0f), length])
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[0] = fin | (opcode & 0x0f)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = fin | (opcode & 0x0f)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([header, data])
}

/** 把一段载荷加/去掩码（异或是对称的，一个函数两用）。 */
export function applyMask(payload, maskKey) {
  const out = Buffer.allocUnsafe(payload.length)
  for (let i = 0; i < payload.length; i += 1) out[i] = payload[i] ^ maskKey[i % 4]
  return out
}

/**
 * 从缓冲区里取出**一帧**。数据不够时返回 `null`（调用方继续等 data 事件）。
 * @returns {{frame: {fin:boolean, opcode:number, payload:Buffer, masked:boolean}, rest: Buffer} | null}
 */
export function decodeFrame(buffer) {
  if (buffer.length < 2) return null
  const fin = (buffer[0] & 0x80) !== 0
  const opcode = buffer[0] & 0x0f
  const masked = (buffer[1] & 0x80) !== 0
  let length = buffer[1] & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return null
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return null
    const big = buffer.readBigUInt64BE(2)
    if (big > BigInt(MAX_MESSAGE_BYTES)) {
      // 超过上限：交给调用方按协议错误处理，别真的等这么多字节
      return { frame: { fin, opcode, payload: Buffer.alloc(0), masked, oversize: Number(big) }, rest: buffer }
    }
    length = Number(big)
    offset = 10
  }
  let maskKey = null
  if (masked) {
    if (buffer.length < offset + 4) return null
    maskKey = buffer.subarray(offset, offset + 4)
    offset += 4
  }
  if (buffer.length < offset + length) return null
  let payload = buffer.subarray(offset, offset + length)
  if (masked) payload = applyMask(payload, maskKey)
  return { frame: { fin, opcode, payload, masked }, rest: buffer.subarray(offset + length) }
}

function closePayload(code, reason) {
  const text = Buffer.from(String(reason ?? ''), 'utf8')
  const body = Buffer.allocUnsafe(2 + text.length)
  body.writeUInt16BE(code & 0xffff, 0)
  text.copy(body, 2)
  return body
}

/**
 * 建一个"发言权推送"中枢。
 *
 * @param {object} options
 * @param {string} options.dataDir 数据目录（读 floor_state 用）
 * @param {(given: string) => boolean} options.checkSecret 共享密钥校验（与 relay 同一套）
 * @param {(token: string) => (string|null)} options.resolveUser token → 用户名（null = 无效）
 * @param {(line: string) => void} [options.debug]
 */
export function createWsHub(options) {
  const { dataDir, checkSecret, resolveUser } = options
  const debug = options.debug ?? (() => {})

  /** roomId → Map<user, conn>：同一用户重复连进来时，旧的会被顶掉（手机切网常见）。 */
  const rooms = new Map()

  /** user → conn：**会话通道**（4.45）。一个用户只留一条，重复连进来顶掉旧的。 */
  const sessions = new Map()
  let pingTimer = null
  let closed = false

  function totalConnections() {
    let total = sessions.size
    for (const conns of rooms.values()) total += conns.size
    return total
  }

  function resolveRoom(raw) {
    const text = String(raw ?? '')
    if (text === '') return null
    return roomById(dataDir, text) ?? roomByCode(dataDir, text) ?? null
  }

  /** 当前这一场该推给谁：完整的 floor 快照（客户端整条替换，不做增量）。 */
  function floorPayload(roomId, extra = null) {
    const state = floorState(dataDir, roomId)
    return {
      type: 'floor',
      roomId,
      holder: state.holder ?? null,
      locked: state.locked === true,
      since: state.since ?? null,
      leaseMs: FLOOR_LEASE_MS,
      at: new Date().toISOString(),
      // 断线清扫（4.42）：被清掉的持麦者是谁、当时是否锁定。平时是 null。
      released: extra?.released ?? null,
      releasedLocked: extra?.releasedLocked === true,
    }
  }

  function sendJson(conn, obj) {
    if (conn.socket.destroyed === true) return
    try {
      conn.socket.write(encodeFrame(OP_TEXT, JSON.stringify(obj)))
    } catch (error) {
      debug(`[ws] 写入失败（${conn.user}）：${error?.message ?? error}`)
    }
  }

  function drop(conn, code, reason) {
    if (conn.kind === 'session') {
      if (sessions.get(conn.user) === conn) sessions.delete(conn.user)
    } else {
      const conns = rooms.get(conn.roomId)
      if (conns !== undefined && conns.get(conn.user) === conn) conns.delete(conn.user)
      if (conns !== undefined && conns.size === 0) rooms.delete(conn.roomId)
    }
    if (conn.socket.destroyed === false) {
      try {
        conn.socket.write(encodeFrame(OP_CLOSE, closePayload(code, reason)))
      } catch { /* 已经断了 */ }
      conn.socket.destroy()
    }
  }

  function attach(server) {
    server.on('upgrade', (request, socket, head) => {
      void (async () => {
        socket.on('error', () => { /* 对端硬断，交给 close 处理 */ })
        let url
        try {
          url = new URL(request.url, 'http://localhost')
        } catch {
          socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
          socket.destroy()
          return
        }
        if (url.pathname !== '/ws') {
          socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
          socket.destroy()
          return
        }

        // ── 认证：与普通请求同一套（密钥 + token），缺一不可 ─────────────────
        const givenSecret = request.headers['x-leion-secret'] ?? url.searchParams.get('secret')
        if (checkSecret(givenSecret) !== true) {
          socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
          socket.destroy()
          return
        }
        const token = request.headers['x-leion-token'] ?? url.searchParams.get('token')
        const user = await resolveUser(typeof token === 'string' ? token : '')
        if (user === null || user === undefined) {
          socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
          socket.destroy()
          return
        }

        // 会话通道（4.45）：不要求房间，只要求"你是某个账号"。
        const wantsSession = ['1', 'true', 'yes'].includes(String(url.searchParams.get('session') ?? '').toLowerCase())
        const room = wantsSession ? null : resolveRoom(url.searchParams.get('room'))
        if (!wantsSession && room === null) {
          socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
          socket.destroy()
          return
        }

        const key = request.headers['sec-websocket-key']
        if (typeof key !== 'string' || key === '') {
          socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
          socket.destroy()
          return
        }

        if (totalConnections() >= MAX_CONNECTIONS_TOTAL) {
          socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n')
          socket.destroy()
          return
        }

        socket.setNoDelay(true)
        socket.setTimeout(0)
        socket.write([
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${wsAcceptKey(key)}`,
          '', '',
        ].join('\r\n'))

        const conn = {
          user,
          // 这条连接是用哪个 token 登录的（哈希）。"被别处登录挤下线"时要用它判断：
          // **不许踢刚拿到新 token 的那条**，否则同一台设备会把自己踢掉（4.50 修）。
          tokenHash: typeof token === 'string' && token !== ''
            ? createHash('sha256').update(token, 'utf8').digest('hex')
            : '',
          kind: wantsSession ? 'session' : 'room',
          roomId: wantsSession ? '' : room.id,
          socket,
          alive: true,
          lastSeen: Date.now(),
          fragments: null,
        }

        if (wantsSession) {
          const previous = sessions.get(user)
          if (previous !== undefined) drop(previous, 1000, 'replaced')
          sessions.set(user, conn)
          debug(`[ws] ${user} 连上会话通道（总计 ${totalConnections()}）`)
          // 连上先握个手，客户端据此知道"推送已就绪，可以放慢轮询"
          sendJson(conn, { type: 'session', user, at: new Date().toISOString() })
        } else {
          let conns = rooms.get(room.id)
          if (conns === undefined) {
            conns = new Map()
            rooms.set(room.id, conns)
          }
          // 同一用户已在别的连接上（手机重新连、或切网）→ 顶掉旧的，避免"两个我"各自收状态
          const previous = conns.get(user)
          if (previous !== undefined) drop(previous, 1000, 'replaced')
          if (conns.size >= MAX_CONNECTIONS_PER_ROOM) {
            drop(conn, 1013, 'room-full')
            return
          }
          conns.set(user, conn)
          debug(`[ws] ${user} 连上房间 ${room.id}（房内 ${conns.size} 人，总计 ${totalConnections()}）`)

          // 连上立刻给一份快照：客户端不需要再问一次
          sendJson(conn, floorPayload(room.id))
        }

        let pending = head !== undefined && head.length > 0 ? Buffer.from(head) : Buffer.alloc(0)

        const handleFrame = (frame) => {
          if (frame.oversize !== undefined) {
            drop(conn, 1009, 'message-too-big')
            return false
          }
          if (frame.masked !== true) {
            // RFC 6455 §5.1：客户端 → 服务端的帧必须加掩码
            drop(conn, 1002, 'client frames must be masked')
            return false
          }
          conn.lastSeen = Date.now()
          conn.alive = true

          switch (frame.opcode) {
            case OP_PING:
              socket.write(encodeFrame(OP_PONG, frame.payload))
              return true
            case OP_PONG:
              return true
            case OP_CLOSE:
              drop(conn, 1000, 'bye')
              return false
            case OP_TEXT:
            case OP_BINARY: {
              if (frame.fin) {
                if (conn.fragments !== null) conn.fragments = null   // 前一段没走完又来新消息，丢弃
                if (frame.opcode === OP_TEXT) handleMessage(frame.payload.toString('utf8'))
                return true
              }
              conn.fragments = { opcode: frame.opcode, chunks: [frame.payload], size: frame.payload.length }
              return true
            }
            case OP_CONTINUATION: {
              if (conn.fragments === null) return true
              conn.fragments.chunks.push(frame.payload)
              conn.fragments.size += frame.payload.length
              if (conn.fragments.size > MAX_MESSAGE_BYTES) {
                drop(conn, 1009, 'message-too-big')
                return false
              }
              if (frame.fin) {
                const merged = Buffer.concat(conn.fragments.chunks)
                const opcode = conn.fragments.opcode
                conn.fragments = null
                if (opcode === OP_TEXT) handleMessage(merged.toString('utf8'))
              }
              return true
            }
            default:
              drop(conn, 1002, 'unknown opcode')
              return false
          }
        }

        const handleMessage = (text) => {
          let message
          try {
            message = JSON.parse(text)
          } catch {
            return   // 客户端发来的不是 JSON：静默忽略，别因为一句话断掉推送
          }
          if (message?.type === 'ping') {
            sendJson(conn, { type: 'pong', at: new Date().toISOString() })
          } else if (message?.type === 'snapshot' && conn.kind === 'room') {
            sendJson(conn, floorPayload(conn.roomId))
          } else if (message?.type === 'listen' && conn.kind === 'room') {
            // 4.76：开关"我要听本房间的声音"（音频只发给开了开关的人）
            const on = setListen(conn, message.on === true)
            sendJson(conn, { type: 'listening', roomId: conn.roomId, on })
          }
        }

        socket.on('data', chunk => {
          pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
          let decoded = decodeFrame(pending)
          while (decoded !== null) {
            pending = decoded.rest
            if (handleFrame(decoded.frame) !== true) return
            decoded = pending.length >= 2 ? decodeFrame(pending) : null
          }
        })
        socket.on('close', () => {
          if (conn.kind === 'session') {
            if (sessions.get(user) === conn) sessions.delete(user)
            debug(`[ws] ${user} 离开会话通道（总计 ${totalConnections()}）`)
            return
          }
          const list = rooms.get(conn.roomId)
          if (list !== undefined && list.get(user) === conn) {
            list.delete(user)
            if (list.size === 0) rooms.delete(conn.roomId)
          }
          debug(`[ws] ${user} 离开房间 ${conn.roomId}（总计 ${totalConnections()}）`)
        })
        socket.on('error', () => { /* 由 close 收尾 */ })
      })()
    })

    // 保活：服务端主动 ping；两个周期没回音就当断了（手机进电梯、切网很常见）
    pingTimer = setInterval(() => {
      const now = Date.now()
      for (const conns of rooms.values()) {
        for (const conn of [...conns.values()]) {
          if (now - conn.lastSeen > IDLE_TIMEOUT_MS) {
            debug(`[ws] ${conn.user} 超时未回音，断开`)
            drop(conn, 1001, 'idle')
            continue
          }
          try {
            conn.socket.write(encodeFrame(OP_PING, Buffer.from('hb')))
          } catch { /* 写不进去就等超时 */ }
        }
      }
    }, PING_INTERVAL_MS)
    pingTimer.unref?.()
  }

  /** 发言权变了：把新状态推给这个房间里的所有人（`raw` 可以是 id 或 6 位邀请码）。 */
  /** 往一个连接写一帧二进制（音频用，4.76）。 */
  function sendBinary(conn, payload) {
    if (conn.socket.destroyed === true) return
    try {
      conn.socket.write(encodeFrame(OP_BINARY, payload))
    } catch (error) {
      debug('[ws] audio write failed (' + conn.user + '): ' + String(error && error.message ? error.message : error))
    }
  }

  /** 这条连接要不要听本房间的声音（4.76）：音频是流量与电量，不能不问就灌。 */
  function setListen(conn, on) {
    conn.listen = on === true
    return conn.listen
  }

  /**
   * 把一块实时音频推给本房间愿意听的人（4.76）。
   * 不发回说话者自己，否则他会听到自己的回声。
   * @returns {number} 实际发给了几个人
   */
  function broadcastRoomAudio(raw, chunk, exceptUser = '') {
    if (closed) return 0
    if (!Buffer.isBuffer(chunk) || chunk.length === 0) return 0
    const room = resolveRoom(raw)
    if (room === null) return 0
    const conns = rooms.get(room.id)
    if (conns === undefined) return 0
    let sent = 0
    for (const conn of conns.values()) {
      if (conn.listen !== true) continue
      // 4.77：正在说话的人**永远**不收回自己的声音（回声的根）。
      // 这是服务端的兜底 —— 客户端也会在自己开麦时关掉倾听，但别指望它一定做对。
      if (exceptUser !== '' && String(conn.user) === String(exceptUser)) continue
      sendBinary(conn, chunk)
      sent += 1
    }
    return sent
  }

  function broadcastFloor(raw, extra = null) {
    if (closed) return 0
    const room = resolveRoom(raw)
    if (room === null) return 0
    const conns = rooms.get(room.id)
    if (conns === undefined) return 0
    const payload = floorPayload(room.id, extra)
    for (const conn of conns.values()) sendJson(conn, payload)
    return conns.size
  }

  /**
   * 新字幕帧 → 推给**所有**连接（4.43）。
   *
   * <p>为什么不分房间：字幕总线本来就是一场会议一条（relay 只有一个 `subtitle-bus.json`），
   * 房间维度目前只有"谁在说话"那一层。等真要做多会议并发，这里再加 room 过滤。
   *
   * <p>与 `/frame` 长轮询的关系：**两条腿走路**。长轮询是兜底（WS 断了好歹还能收到），
   * WS 是主通道（省掉一次 HTTP 往返、也省掉那条 25 秒挂起的连接）。
   */
  /**
   * 推一帧字幕。
   *
   * <p>4.86：给了 `roomId` 就**只发给这个房间**。之前是广播给所有房间 ——
   * 那正是"两场会的字幕互相污染"的一半（另一半是单一总线文件）。
   * 不给（或归属不出来）时保持广播，兼顾老客户端与无房间的设备。
   */
  function broadcastFrame(payload, roomId = null) {
    if (closed) return 0
    let sent = 0
    if (roomId !== null && roomId !== undefined && roomId !== '') {
      const conns = rooms.get(String(roomId))
      if (conns === undefined) return 0
      for (const conn of conns.values()) {
        sendJson(conn, payload)
        sent += 1
      }
      return sent
    }
    for (const conns of rooms.values()) {
      for (const conn of conns.values()) {
        sendJson(conn, payload)
        sent += 1
      }
    }
    return sent
  }

  /**
   * 会议结束了（发起者退出 → 服务端把房间标成 closed）：**立刻**通知并断开这个房间的连接（4.44）。
   *
   * <p>为什么不能等客户端自己发现：轮询/推送的频率是秒级，而"会议结束"意味着屋里的身份
   * 全部作废。让人在已结束的会议里继续说话、点锁定，是比"卡一下"更糟的体验。
   * 先推一条 `{type:'closed'}` 让界面能说清原因，再发关闭帧。
   */
  function closeRoom(raw, reason = 'closed') {
    const room = resolveRoom(raw)
    if (room === null) return 0
    const conns = rooms.get(room.id)
    if (conns === undefined) return 0
    let sent = 0
    for (const conn of [...conns.values()]) {
      sendJson(conn, { type: 'closed', roomId: room.id, reason })
      drop(conn, 4001, reason === 'host-left' ? '会议已结束（发起者已退出）' : '会议已结束')
      sent += 1
    }
    return sent
  }

  /**
   * 「你被别处登录挤下线了」（4.45）。
   *
   * <p>由 relay 在登录成功、且这次登录吊销了该账号的旧 token 时调用 ——
   * 也就是说"另一个设备刚登录"的那一刻，被顶掉的那台**立刻**知道，
   * 不用等它 10 秒一次的轮询。
   *
   * <p>先推 `{type:'kicked'}`（让界面能说清原因），再关闭连接（身份已经作废，
   * 留着这条连接只会让它继续以为自己在线）。
   */
  function notifyKicked(user, reason = 'elsewhere-login', keepToken = null) {
    if (closed) return false
    const conn = sessions.get(String(user))
    if (conn === undefined) return false
    // ⚠️ 4.50 修：如果连着的这条会话用的**就是这次刚发的 token**，它不是"别处"，
    //    踢它等于让刚登录成功的这台设备自己弹"账号已在别处登录"。
    if (keepToken !== null && keepToken !== undefined && keepToken !== '') {
      const keepHash = createHash('sha256').update(String(keepToken), 'utf8').digest('hex')
      if (conn.tokenHash === keepHash) return false
    }
    sendJson(conn, { type: 'kicked', reason, at: new Date().toISOString() })
    drop(conn, 4002, '账号已在别处登录')
    debug(`[ws] ${user} 的旧会话被挤下线（会话通道已关闭）`)
    return true
  }

  /**
   * 把某个用户从房间里请出去（4.55：被发起者移出）。
   *
   * <p>为什么不做成"让对方自己发现"：房间成员变化没有任何推送通道，
   * 只靠客户端轮询的话，被移出的人会在屋里再待十几秒、还以为一切正常。
   * 这里先推 `{type:'removed'}` 说明原因，再断连接。
   */
  function removeUserFromRoom(raw, user, reason = 'removed-by-host') {
    const room = resolveRoom(raw)
    if (room === null) return false
    const conns = rooms.get(room.id)
    if (conns === undefined) return false
    const conn = conns.get(String(user))
    if (conn === undefined) return false
    sendJson(conn, { type: 'removed', roomId: room.id, reason, at: new Date().toISOString() })
    drop(conn, 4003, '已被移出会议')
    debug(`[ws] ${user} 被移出房间 ${room.id}（连接已关闭）`)
    return true
  }

  function stats() {
    const perRoom = {}
    for (const [roomId, conns] of rooms.entries()) perRoom[roomId] = conns.size
    return { total: totalConnections(), rooms: perRoom, sessions: sessions.size }
  }

  function close() {
    closed = true
    if (pingTimer !== null) clearInterval(pingTimer)
    pingTimer = null
    for (const conns of rooms.values()) {
      for (const conn of [...conns.values()]) drop(conn, 1001, 'server-shutdown')
    }
    for (const conn of [...sessions.values()]) drop(conn, 1001, 'server-shutdown')
    rooms.clear()
    sessions.clear()
  }

  return { attach, broadcastFloor, broadcastFrame, broadcastRoomAudio, closeRoom, notifyKicked,
    removeUserFromRoom, setListen, stats, close }
}

/** 给客户端生成一个随机的 Sec-WebSocket-Key（测试与调试用）。 */
export function randomWsKey() {
  return randomBytes(16).toString('base64')
}
