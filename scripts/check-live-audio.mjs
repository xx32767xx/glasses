/**
 * check-live-audio.mjs —— 「会议里听不到别人说话」到底断在哪一环
 * ============================================================================
 *
 *   # ① 本机自测（不需要手机、不需要模型）：自己起转发进程，造两个账号一个房间，
 *   #    模拟"甲说话 → 乙听到"，把整条路走一遍
 *   node scripts/check-live-audio.mjs --self-test
 *
 *   # ② 查真实服务器（手机连的那个）：只做"听"这一半
 *   node scripts/check-live-audio.mjs --host http://117.50.180.93:8789 \
 *        --secret <relay-secret.txt 里的密钥> --user <你的用户名> --token <你的 token> \
 *        --room <房间id或邀请码> --watch 30
 *
 * 为什么要有它：实时传声这条链有四段，**每一段坏了的表现都一模一样**（对方什么都听不到）：
 *
 *   ① 手机有没有**发**（`/audio?room=…` 是否带着房间号）
 *   ② 听的一方有没有**订阅**（WS 上 `{"type":"listen","on":true}`）
 *   ③ 服务端有没有**扇出**（`broadcastRoomAudio` 找到人、发出二进制帧）
 *   ④ 手机有没有**播**（AudioTrack 起没起来 —— 这一段只能在手机上查，见 --watch 之后的提示）
 *
 * 这个脚本把 ①②③ 变成可观测的：它会打印每一步的结果与字节数，
 * 所以"哪一段没动"是结论，而不是猜。
 *
 * 判定规则（`--self-test` 里都写成了断言）：
 *   · 甲说话、乙订阅了  → 乙必须收到**同样的字节**；
 *   · 甲说话、乙没订阅  → 乙一块都收不到（音频是流量与电量，不能白灌）；
 *   · 乙说话、甲在持麦  → 持麦的人**收不到自己的声音**（回声的根，服务端兜底）。
 */

import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { startRelay } from '../relay/lan-relay.mjs'
import { createRoom, joinRoom } from '../lib/rooms.mjs'
import { loadAccounts, login, saveAccounts, register } from '../lib/accounts.mjs'

const HELP = `check-live-audio —— 会议里听不到别人说话时，判断断在哪一环

  node scripts/check-live-audio.mjs --self-test
      本机端到端自测：起一个临时转发进程、造两个账号和一个房间，
      模拟「甲上传音频 → 乙听到」，三条规则全验。不需要手机、不需要模型。

  node scripts/check-live-audio.mjs --host <地址> --secret <密钥> --user <用户名> --token <token> --room <房间> [--watch 30]
      只做"听"这一半：连上你手机连的那台转发进程，订阅那个房间的声音，
      把你收到的块数与字节数打出来。--watch N 表示连续听 N 秒。
      用法举例（在手机所在的同一场会里，让另一个人说话）：
        node scripts/check-live-audio.mjs --host http://117.50.180.93:8789 \\
             --secret $(cat /var/lib/leion/test/relay-secret.txt) \\
             --user anqi --token <app-debug 里的 token> --room room-xxxx --watch 30

  参数
  --self-test        本机自测（缺省什么都不做，只打印帮助）
  --host <url>       真服务器地址（例如 http://117.50.180.93:8789）
  --secret <密钥>    共享密钥（relay-secret.txt）
  --user <用户名>    "听"的那个人（要真的在这场会里）
  --token <token>    这个人的登录 token（服务端靠它认人）
  --room <id或邀请码>
  --watch <秒>       连续听这么久，最后报"收到多少块 / 多少字节"
  --quiet            少说话（只打结论）
  --help
`

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 连一条房间 WS，返回 {socket, events, waitFor, close}。 */
function openRoomSocket(url) {
  const socket = new WebSocket(url)
  const events = []
  const waiters = []
  socket.addEventListener('message', (event) => {
    if (typeof event.data === 'string') {
      let parsed = null
      try { parsed = JSON.parse(event.data) } catch { parsed = { raw: event.data } }
      events.push({ kind: 'json', data: parsed })
      for (const waiter of [...waiters]) {
        if (waiter.match(parsed) === true) {
          waiters.splice(waiters.indexOf(waiter), 1)
          waiter.resolve(parsed)
        }
      }
      return
    }
    // 二进制帧 = 实时音频
    const size = event.data instanceof ArrayBuffer
      ? event.data.byteLength
      : (typeof event.data?.size === 'number' ? event.data.size : 0)
    events.push({ kind: 'audio', bytes: size })
  })
  return {
    socket,
    events,
    ready: new Promise((resolve, reject) => {
      socket.addEventListener('open', () => resolve(true))
      socket.addEventListener('error', () => reject(new Error('WS 连不上')))
    }),
    audioBytes: () => events.filter(item => item.kind === 'audio').reduce((sum, item) => sum + item.bytes, 0),
    audioChunks: () => events.filter(item => item.kind === 'audio').length,
    waitFor(match, timeoutMs = 4000) {
      return new Promise((resolve) => {
        const found = events.find(item => item.kind === 'json' && match(item.data))
        if (found !== undefined) { resolve(found.data); return }
        const waiter = { match, resolve }
        waiters.push(waiter)
        setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) { waiters.splice(index, 1); resolve(null) }
        }, timeoutMs)
      })
    },
    close() { try { socket.close() } catch { /* 已经关了 */ } },
  }
}

/** 本机自测：真起转发进程，真连 WS，真 POST 音频。 */
export async function selfTest({ quiet = false } = {}) {
  const say = (text) => { if (quiet !== true) console.log(text) }
  const dataDir = mkdtempSync(join(tmpdir(), 'leion-live-audio-'))
  const secret = 'self-test-secret-0123456789abcdef'
  const results = []

  const accounts = await loadAccounts(dataDir)
  // ⚠️ `register()` / `login()` 都是**不可变**的：它们返回 { ok, doc, token }，
  //    不会改传进去的那个 doc。第一版我按"就地修改"写，于是账号根本没建上，
  //    拿到的 token 是 undefined —— 表现成"WS 连不上"，看着像网络问题。
  const registered = register(register(accounts, 'alice', 'pw-alice-1234').doc ?? accounts,
    'bob', 'pw-bob-1234')
  if (registered.ok !== true) throw new Error(`造账号失败：${registered.error}`)
  await saveAccounts(dataDir, registered.doc)
  const signed = login(registered.doc, 'alice', 'pw-alice-1234')
  if (signed.ok !== true) throw new Error(`登录失败：${signed.error}`)
  await saveAccounts(dataDir, signed.doc)
  const aliceToken = signed.token
  const bobSigned = login(signed.doc, 'bob', 'pw-bob-1234')
  if (bobSigned.ok !== true) throw new Error(`登录失败：${bobSigned.error}`)
  await saveAccounts(dataDir, bobSigned.doc)
  const bobToken = bobSigned.token

  const room = createRoom(dataDir, { name: '自检房间', host: 'alice' })
  joinRoom(dataDir, { roomId: room.room.id, username: 'bob' })
  say(`  房间 ${room.room.id}（邀请码 ${room.room.code}），成员 alice / bob`)

  const relay = await startRelay({
    dataDir, port: 0, host: '127.0.0.1', secret, quiet: true, pollHoldMs: 300,
  })
  const base = `http://127.0.0.1:${relay.port}`
  const wsBase = `ws://127.0.0.1:${relay.port}`
  say(`  转发进程 ${base}`)

  const wsUrl = (token) => `${wsBase}/ws?room=${encodeURIComponent(room.room.id)}`
    + `&secret=${encodeURIComponent(secret)}&token=${encodeURIComponent(token)}`
  const headers = { 'x-leion-secret': secret }

  const audio = Buffer.alloc(1600)          // 0.1 秒 16k 单声道
  for (let index = 0; index < audio.length; index += 2) {
    audio.writeInt16LE(Math.round(8000 * Math.sin(index / 8)), index)
  }
  const postAudio = async (token) => {
    const response = await fetch(`${base}/audio?rate=16000&lang=zh-CN&room=${encodeURIComponent(room.room.id)}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/octet-stream', 'x-leion-token': token },
      body: audio,
    })
    return response.status
  }

  try {
    // ① 乙订阅 → 甲说话 → 乙必须收到同样的字节
    const bob = openRoomSocket(wsUrl(bobToken))
    await bob.ready
    await bob.waitFor(data => data.type === 'floor', 3000)
    bob.socket.send(JSON.stringify({ type: 'listen', on: true }))
    const ack = await bob.waitFor(data => data.type === 'listening', 3000)
    say(`  ① 订阅回执 listening.on=${ack === null ? '(没收到)' : ack.on}`)
    results.push({ name: '订阅有回执', ok: ack !== null && ack.on === true, detail: String(ack?.on) })

    const statusRoom = await postAudio(aliceToken)
    await sleep(600)
    const bobChunks = bob.audioChunks()
    const bobBytes = bob.audioBytes()
    const meta = bob.events.find(item => item.kind === 'json' && item.data.type === 'audio-meta')
    say(`  ② 甲上传音频（HTTP ${statusRoom}）→ 乙收到 ${bobChunks} 块 / ${bobBytes} 字节（发出 ${audio.length} 字节）`)
    say(`     采样率通知 audio-meta：${meta === undefined ? '(没收到)' : meta.data.rate + ' Hz'}`)
    results.push({ name: '订阅者收到音频', ok: bobBytes >= audio.length, detail: `${bobBytes}/${audio.length}` })
    results.push({
      name: '服务端告知采样率（audio-meta）',
      ok: meta !== undefined && Number(meta.data.rate) === 16000,
      detail: meta === undefined ? '没收到' : String(meta.data.rate),
    })
    bob.close()

    // ② 没人订阅时，一块都不该发（省流量省电）
    const silence = openRoomSocket(wsUrl(bobToken))
    await silence.ready
    await silence.waitFor(data => data.type === 'floor', 3000)
    await postAudio(aliceToken)
    await sleep(400)
    say(`  ③ 没有订阅时 → 收到 ${silence.audioChunks()} 块（应为 0）`)
    results.push({ name: '未订阅不发音频', ok: silence.audioChunks() === 0, detail: String(silence.audioChunks()) })
    silence.close()

    // ③ 说话的人自己不收回声（服务端兜底：持麦者被排除）
    const alice = openRoomSocket(wsUrl(aliceToken))
    await alice.ready
    await alice.waitFor(data => data.type === 'floor', 3000)
    alice.socket.send(JSON.stringify({ type: 'listen', on: true }))
    await alice.waitFor(data => data.type === 'listening', 3000)
    // 让 alice 拿到发言权（服务端据此把她的连接排除在收自己的声音之外）
    //
    // ⚠️ 端点是 `POST /org/rooms/<房间>/floor` + body `{action:'take'}`，
    //    **不是** `/floor?action=take`。第一版我写错端点，于是 alice 从没拿到麦，
    //    "持麦者不收回声"这条假红了一次（看起来像服务端有 bug）。
    const takeResponse = await fetch(
      `${base}/org/rooms/${encodeURIComponent(room.room.id)}/floor`, {
        method: 'POST',
        headers: { ...headers, 'x-leion-token': aliceToken, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'take' }),
      })
    const taken = await takeResponse.json().catch(() => ({}))
    await alice.waitFor(data => data.type === 'floor' && data.holder === 'alice', 4000)
    say(`     让 alice 拿麦：HTTP ${takeResponse.status}，服务端记为持麦者 ${taken.holder ?? '(空)'}`)
    await postAudio(aliceToken)
    await sleep(500)
    say(`  ④ 持麦者自己 → 收到 ${alice.audioChunks()} 块（应为 0，否则会听到自己的回声）`)
    results.push({ name: '说话的人不收回声', ok: alice.audioChunks() === 0, detail: String(alice.audioChunks()) })
    alice.close()
  } finally {
    relay.close?.()
    rmSync(dataDir, { recursive: true, force: true })
  }

  return results
}

/** 真服务器：只做"听"这一半（订阅 → 数收到的字节）。 */
export async function watchLive({ host, secret, token, room, seconds = 15, quiet = false } = {}) {
  const say = (text) => { if (quiet !== true) console.log(text) }
  const url = `${String(host).replace(/\/$/, '').replace(/^http/, 'ws')}/ws`
    + `?room=${encodeURIComponent(room)}&secret=${encodeURIComponent(secret)}`
    + `&token=${encodeURIComponent(token)}`
  const socket = openRoomSocket(url)
  try {
    await socket.ready
  } catch (error) {
    console.log(`  ❌ WS 连不上：${String(error?.message ?? error)}`)
    console.log('     常见原因：地址/端口不对、密钥错、token 过期、房间 id 写错（这三样错起来表现都一样）')
    return [{ name: '连上转发进程', ok: false, detail: String(error?.message ?? error) }]
  }
  const floor = await socket.waitFor(data => data.type === 'floor', 4000)
  say(`  已连上。房间快照：持麦者 ${floor === null ? '(没收到 floor 帧)' : (floor.holder ?? '没人')}`
    + `${floor?.locked ? '（已锁定）' : ''}`)
  socket.socket.send(JSON.stringify({ type: 'listen', on: true }))
  const ack = await socket.waitFor(data => data.type === 'listening', 4000)
  say(`  订阅回执：${ack === null ? '❌ 没收到 —— 服务端可能是旧版（< 4.76），或者连接类型不对' : `on=${ack.on}`}`)
  say(`  开始听 ${seconds} 秒 —— 现在让另一个人对着手机说话…`)
  const startedAt = Date.now()
  while (Date.now() - startedAt < seconds * 1000) {
    await sleep(1000)
    say(`    ${Math.round((Date.now() - startedAt) / 1000)}s：${socket.audioChunks()} 块 / ${socket.audioBytes()} 字节`)
  }
  socket.close()
  const results = [
    { name: '收到订阅回执', ok: ack !== null && ack.on === true, detail: String(ack?.on) },
    { name: '收到实时音频', ok: socket.audioBytes() > 0, detail: `${socket.audioChunks()} 块 / ${socket.audioBytes()} 字节` },
  ]
  return results
}

export async function main(argv = process.argv.slice(2)) {
  const options = { seconds: 15, quiet: false, selfTest: false }
  const takesValue = new Set(['host', 'secret', 'user', 'token', 'room', 'watch'])
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--self-test') { options.selfTest = true; continue }
    if (token === '--quiet') { options.quiet = true; continue }
    if (token === '--help') { process.stdout.write(HELP); return 0 }
    if (!token.startsWith('--')) throw new Error(`看不懂的参数：${token}（用 --help 看用法）`)
    const key = token.slice(2)
    if (!takesValue.has(key)) throw new Error(`未知选项 --${key}（用 --help 看用法）`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} 需要一个值`)
    index += 1
    if (key === 'host') options.host = value
    else if (key === 'secret') options.secret = value
    else if (key === 'user') options.user = value
    else if (key === 'token') options.token = value
    else if (key === 'room') options.room = value
    else if (key === 'watch') options.seconds = Number(value)
  }

  if (options.selfTest !== true && options.host === undefined) {
    process.stdout.write(HELP)
    return 0
  }

  console.log('')
  console.log('─'.repeat(70))
  console.log('  实时传声（会议里听不听得到别人说话）')
  console.log('─'.repeat(70))
  let results = []
  if (options.selfTest === true) {
    console.log('  模式：本机自测（临时转发进程 + 两个账号 + 一个房间）')
    console.log('')
    results = await selfTest({ quiet: options.quiet })
  } else {
    for (const key of ['secret', 'token', 'room']) {
      if (options[key] === undefined) {
        console.error(`❌ 查真服务器需要 --${key}（用 --help 看用法）`)
        return 2
      }
    }
    console.log(`  模式：查真服务器 ${options.host}，房间 ${options.room}，以 ${options.user ?? '?'} 的身份听`)
    console.log('')
    results = await watchLive({
      host: options.host, secret: options.secret, token: options.token,
      room: options.room, seconds: options.seconds, quiet: options.quiet,
    })
  }

  console.log('')
  console.log('─'.repeat(70))
  const failed = results.filter(item => item.ok !== true)
  for (const item of results) {
    console.log(`  ${item.ok === true ? '✅' : '❌'} ${item.name}${item.detail ? `（${item.detail}）` : ''}`)
  }
  console.log('─'.repeat(70))
  if (failed.length === 0) {
    console.log('  服务端这一段是通的。')
    console.log('  如果手机上还是听不到，问题就在**手机这一侧**，按顺序查：')
    console.log('   1. 房间页的「听别人说话」开关有没有开（没开服务端一块都不会发）')
    console.log('   2. 开麦的人是不是**你自己**（自己说话时服务端不会把声音发回给你，这是防回声）')
    console.log('   3. 手机版本够不够新（实时传声是 4.76 的功能；旧 APK 没有这个开关）')
    console.log('   4. adb logcat -s RoomAudio Room 看播放器起没起来（AudioTrack 建失败会被吞掉）')
  } else {
    console.log(`  有 ${failed.length} 项没过 —— 断在服务端这一段，先修这里。`)
    console.log('  对照「①发 ②订阅 ③扇出 ④播」四段：上面哪一项先红，就从那里往下查。')
  }
  console.log('')
  return failed.length === 0 ? 0 : 1
}

const isCli = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isCli) {
  main().then(code => process.exit(code)).catch((error) => {
    console.error('❌ ' + String(error?.message ?? error))
    process.exit(1)
  })
}

void writeFileSync
void createHash
