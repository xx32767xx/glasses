/**
 * ws-suite.mjs —— 发言权推送通道（手写 WebSocket，`lib/ws-hub.mjs`）
 * ============================================================================
 *
 * 两段：① 帧编解码这类纯函数（跑得快、失败时一眼看出是哪一层的错）；
 * ② **真服务器 + 真客户端**：用 Node 自带的 `WebSocket` 客户端连 relay 的 `/ws`，
 *    验证"有人开麦 → 房间里所有人都立刻收到"，而不是等 2 秒轮询。
 *
 * ⚠️ 真连接那一段是有意的：手写 WS 最容易错的地方（掩码、长度字段、分片、握手应答）
 * 只有在真客户端面前才会暴露 —— Node 自带的客户端是**带掩码**的，正好替我们验这一条。
 */

import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { VAR_DIR } from '../lib/paths.mjs'
import { createAccountWithPassword, loadAccounts, saveAccounts } from '../lib/accounts.mjs'
import { decodeFrame, encodeFrame, wsAcceptKey } from '../lib/ws-hub.mjs'
import { startRelay } from '../relay/lan-relay.mjs'

const BASE = join(VAR_DIR, 'test', 'ws-suite')

/** 把一段字节按客户端规则加上掩码（模拟浏览器/手机发出来的帧）。 */
function maskFrame(opcode, payload, maskKey = Buffer.from([0x12, 0x34, 0x56, 0x78])) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8')
  const masked = Buffer.allocUnsafe(data.length)
  for (let i = 0; i < data.length; i += 1) masked[i] = data[i] ^ maskKey[i % 4]
  let header
  if (data.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | data.length])
  } else {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(data.length, 2)
  }
  return Buffer.concat([header, maskKey, masked])
}

/** 一个带"下一条消息"队列的客户端壳子。 */
function openSocket(url) {
  const socket = new WebSocket(url)
  const queue = []
  const waiters = []
  const closed = { done: false, code: 0, reason: '' }

  socket.addEventListener('message', event => {
    let data
    try {
      data = JSON.parse(String(event.data))
    } catch {
      return
    }
    const waiter = waiters.shift()
    if (waiter !== undefined) waiter(data)
    else queue.push(data)
  })
  socket.addEventListener('close', event => {
    closed.done = true
    closed.code = event.code
    closed.reason = event.reason
    while (waiters.length > 0) waiters.shift()(null)
  })

  return {
    socket,
    closed,
    ready: new Promise((resolve, reject) => {
      socket.addEventListener('open', () => resolve())
      socket.addEventListener('error', () => reject(new Error('ws 连接失败')))
    }),
    next(timeoutMs = 3000) {
      return new Promise(resolve => {
        if (queue.length > 0) {
          resolve(queue.shift())
          return
        }
        const timer = setTimeout(() => resolve(null), timeoutMs)
        waiters.push(data => { clearTimeout(timer); resolve(data) })
      })
    },
    close() {
      try { socket.close() } catch { /* 已关 */ }
    },
  }
}

export async function runWsSuite({ it, check }) {
  // ── ① 纯函数：帧编解码 ─────────────────────────────────────────────────

  await it('握手应答与 RFC 6455 的样例一致（算错这一位，浏览器会直接拒绝握手）', () => {
    // RFC 6455 §1.3 的官方例子
    check('样例 key → 样例应答',
      wsAcceptKey('dGhlIHNhbXBsZSBub25jZQ==') === 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
      wsAcceptKey('dGhlIHNhbXBsZSBub25jZQ=='))
  })

  await it('文本帧编解码：短 / 126 长度 / 就近上限 / 半包都正确；超限的直接判死', () => {
    for (const text of ['ok', 'x'.repeat(125), 'x'.repeat(126), 'y'.repeat(300), 'z'.repeat(60000)]) {
      const buffer = encodeFrame(0x1, text)
      const decoded = decodeFrame(buffer)
      check(`${text.length} 字节：一次就能解出来`, decoded !== null, '数据不够')
      check(`${text.length} 字节：内容对得上`, decoded.frame.payload.toString('utf8') === text)
      check(`${text.length} 字节：fin 置位`, decoded.frame.fin === true)
      check(`${text.length} 字节：服务端帧不带掩码`, decoded.frame.masked === false)

      // 半包：只给前一半，必须返回 null（而不是抛错或解出半截）
      const half = buffer.subarray(0, Math.max(1, Math.floor(buffer.length / 2)))
      check(`${text.length} 字节：半包返回 null`, decodeFrame(half) === null)
    }

    // 单条消息上限 64 KB：超过它就不是"一条状态"了，直接判超限（连接会被 1009 关掉）
    const huge = decodeFrame(encodeFrame(0x1, 'q'.repeat(70000)))
    check('70 KB 的帧被判超限', huge !== null && huge.frame.oversize === 70000, JSON.stringify(huge?.frame?.oversize))
  })

  await it('客户端的帧带掩码：能解回来；长度字段与掩码位都对', () => {
    const frame = maskFrame(0x1, '谁在说话')
    const decoded = decodeFrame(frame)
    check('解出原文', decoded.frame.payload.toString('utf8') === '谁在说话',
      decoded.frame.payload.toString('utf8'))
    check('认出这是带掩码的帧（服务端据此校验 RFC 要求）', decoded.frame.masked === true)
  })

  // ── ② 真服务器 + 真客户端 ───────────────────────────────────────────────

  await rm(BASE, { recursive: true, force: true })
  await mkdir(BASE, { recursive: true })

  const doc = await loadAccounts(BASE)
  let current = doc
  for (const name of ['alice', 'bob']) {
    current = createAccountWithPassword(current, { username: name, password: 'secret12' }).doc
  }
  await saveAccounts(BASE, current)

  const relay = await startRelay({ dataDir: BASE, port: 0, secret: 'ws-test-secret', quiet: true })
  const http = `http://127.0.0.1:${relay.port}`
  const wsBase = `ws://127.0.0.1:${relay.port}/ws`
  const wsUrl = (code, token, secret = 'ws-test-secret') =>
    `${wsBase}?room=${encodeURIComponent(code)}&token=${encodeURIComponent(token)}&secret=${encodeURIComponent(secret)}`
  const secretHeader = { 'x-leion-secret': 'ws-test-secret' }
  const post = (path, body, token) => fetch(http + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...secretHeader, ...(token ? { 'x-leion-token': token } : {}) },
    body: JSON.stringify(body ?? {}),
  })

  const opened = []
  try {
    const aliceToken = (await (await post('/auth/login', { username: 'alice', password: 'secret12' })).json()).token
    const bobToken = (await (await post('/auth/login', { username: 'bob', password: 'secret12' })).json()).token
    check('两个账号都拿到 token', Boolean(aliceToken) && Boolean(bobToken))

    const created = await (await post('/org/rooms', { name: 'WS 测试房' }, aliceToken)).json()
    const room = created.room
    check('建房成功（拿到 6 位邀请码）', created.ok === true && /^\d{6}$/.test(String(room.code)), JSON.stringify(created).slice(0, 120))
    const joined = await (await post('/org/rooms/join', { code: room.code }, bobToken)).json()
    check('bob 凭码加入', joined.ok === true, JSON.stringify(joined).slice(0, 120))

    await it('连上就收到一份 floor 快照（客户端不用再 GET 一次）', async () => {
      const alice = openSocket(wsUrl(room.code, aliceToken))
      opened.push(alice)
      await alice.ready
      const first = await alice.next()
      check('第一条就是 floor', first !== null && first.type === 'floor', JSON.stringify(first))
      check('此时麦克风空闲', first.holder === null && first.locked === false, JSON.stringify(first))
      check('带了租约时长（界面/客户端靠它判断多久算掉线）', first.leaseMs > 0, String(first.leaseMs))
    })

    await it('A 开麦 → 房间里的**每个人**都立刻收到（这是整件事的意义）', async () => {
      // 两个客户端同时在线：alice（持麦者）与 bob（旁观者）
      const bob = openSocket(wsUrl(room.code, bobToken))
      opened.push(bob)
      await bob.ready
      await bob.next()                        // 连上时的快照

      const taken = await (await post(`/org/rooms/${room.id}/floor`, { action: 'take' }, aliceToken)).json()
      check('HTTP 那边也拿到了麦', taken.ok === true && taken.holder === 'alice', JSON.stringify(taken))

      const alice = opened[0]
      const forAlice = await alice.next()
      const forBob = await bob.next()
      check('alice 收到 holder=alice', forAlice !== null && forAlice.holder === 'alice', JSON.stringify(forAlice))
      check('bob 也收到 holder=alice（不用等 2 秒轮询）', forBob !== null && forBob.holder === 'alice', JSON.stringify(forBob))
    })

    await it('B 抢麦 → 推送内容立即变成 holder=bob（"XX 接管了麦克风"就靠这条）', async () => {
      const grabbed = await (await post(`/org/rooms/${room.id}/floor`, { action: 'take' }, bobToken)).json()
      check('HTTP 回执里说明了顶替了谁', grabbed.tookOver === 'alice', JSON.stringify(grabbed))

      const alice = opened[0]
      const bob = opened[1]
      const forAlice = await alice.next()
      const forBob = await bob.next()
      check('alice 收到 holder=bob（被顶替的一方）', forAlice !== null && forAlice.holder === 'bob', JSON.stringify(forAlice))
      check('bob 收到 holder=bob', forBob !== null && forBob.holder === 'bob', JSON.stringify(forBob))
    })

    await it('锁定状态也会推下来（界面据此显示"（已锁定）"）', async () => {
      const locked = await (await post(`/org/rooms/${room.id}/floor`, { action: 'lock' }, bobToken)).json()
      check('HTTP 侧锁定成功', locked.ok === true && locked.locked === true, JSON.stringify(locked))
      const forAlice = await opened[0].next()
      check('推送里带 locked=true', forAlice !== null && forAlice.locked === true, JSON.stringify(forAlice))
      await post(`/org/rooms/${room.id}/floor`, { action: 'unlock' }, bobToken)
      await opened[0].next()
    })

    await it('持麦者退出房间 → 剩下的人立刻看到麦克风空闲', async () => {
      await post('/org/rooms/leave', { roomId: room.id }, bobToken)
      const forAlice = await opened[0].next()
      check('推送里 holder=null', forAlice !== null && forAlice.holder === null, JSON.stringify(forAlice))
    })

    await it('同一个人重复连进来时，旧连接被顶掉（避免"两个我"各自收状态）', async () => {
      const first = openSocket(wsUrl(room.code, aliceToken))
      opened.push(first)
      await first.ready
      await first.next()

      const second = openSocket(wsUrl(room.code, aliceToken))
      opened.push(second)
      await second.ready
      await second.next()

      // 等旧连接收到关闭帧
      const deadline = Date.now() + 2000
      while (first.closed.done !== true && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      check('旧连接被服务端关掉', first.closed.done === true, JSON.stringify(first.closed))
    })

    await it('认证不过的一律连不上（密钥错 / token 错 / 房间不存在）', async () => {
      const cases = [
        ['密钥错', wsUrl(room.code, aliceToken, 'nope')],
        ['token 错', wsUrl(room.code, 'garbage')],
        ['房间不存在', wsUrl('000000', aliceToken)],
      ]
      for (const [label, url] of cases) {
        const probe = openSocket(url)
        const outcome = await Promise.race([
          probe.ready.then(() => 'open'),
          new Promise(resolve => setTimeout(() => resolve('timeout'), 2000)),
        ]).catch(() => 'rejected')
        check(`${label} → 不建立连接`, outcome !== 'open', `实际 ${outcome}`)
        probe.close()
      }
    })
  } finally {
    for (const client of opened) client.close()
    await relay.close().catch(() => {})
    await rm(BASE, { recursive: true, force: true })
  }
}
