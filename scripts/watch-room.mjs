#!/usr/bin/env node
/**
 * watch-room.mjs —— 「接入一个会议，把推送来的字幕原样打出来」的参考客户端（5.153）
 * ============================================================================
 *
 * 这是给**桌面端/第三方客户端**看的可运行样例，也是我们自己的排障工具：
 * 只用 Node 自带能力（`fetch` + 全局 `WebSocket`），零依赖、Windows 上直接跑。
 *
 * 典型用法：
 *   # ① 用测试账号进一个已有会议（邀请码 6 位）
 *   node scripts/watch-room.mjs --host http://127.0.0.1:8789 --secret <RELAY_SECRET> \
 *        --user test7 --password 123456 --code 654321 --lang zh-CN --hear zh-CN,en-US
 *
 *   # ② 自己建一个会议，把拿到的邀请码发出去
 *   node scripts/watch-room.mjs --host ... --secret ... --user test7 --password 123456 \
 *        --create "桌面端联调" --lang zh-CN --hear zh-CN,en-US
 *
 *   # ③ 不用真的说话也能来一句字幕（喂给引擎，走完整翻译链路）
 *   ... --say "Bom dia a todos, a reunião começa às três." --from pt-BR
 *
 *   # ④ 没有 WS 的客户端怎么活：长轮询
 *   ... --code 654321 --poll
 *
 * 协议细节见 `docs/34-会议接入与字幕推送（桌面端对接）.md`。
 */

import { parseArgs } from 'node:util'

const USAGE = `用法：
  node scripts/watch-room.mjs --host <baseUrl> --secret <relaySecret> --user <账号> --password <密码> \\
       (--code <6位邀请码> | --create "<会议名>") [--lang zh-CN] [--hear zh-CN,en-US] \\
       [--poll] [--json] [--say <文字>] [--from pt-BR] [--timeout 60]

  必填：--host（如 http://127.0.0.1:8789）、--secret、--user、--password
  会议：--code 进已有会议；或用 --create 新建（会用登录账号当发起者）
  订阅：默认走 WebSocket（/ws）；加 --poll 改用长轮询（/frame）
  其它：--lang 我说的语言；--hear 我想看的译文语言（逗号分隔）；
        --json 打印原始 JSON；--say 让引擎说一句话；--timeout 秒数（0=一直跑）`

const LANGS = ['zh-CN', 'pt-BR', 'en-US']

function fail(message) {
  console.error(`\n✗ ${message}`)
  process.exit(1)
}

function parse(argv) {
  let values
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        host: { type: 'string' },
        secret: { type: 'string' },
        user: { type: 'string' },
        password: { type: 'string' },
        code: { type: 'string' },
        create: { type: 'string' },
        lang: { type: 'string', default: 'zh-CN' },
        hear: { type: 'string', default: '' },
        poll: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        say: { type: 'string', default: '' },
        from: { type: 'string', default: '' },
        timeout: { type: 'string', default: '0' },
        help: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    }))
  } catch (error) {
    fail(`${error.message}\n\n${USAGE}`)
  }
  return values
}

/**
 * 一个最小的 relay 客户端：所有请求都要带 `X-Leion-Secret`，登录之后的接口再带 `X-Leion-Token`。
 *
 * <p>这两个头是**协议的一部分**，不是可选优化：少了 secret 一律 401（`unauthorized`）。
 */
function createApi({ host, secret }) {
  const base = String(host).replace(/\/+$/, '')
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const headers = { 'X-Leion-Secret': secret }
    if (token !== undefined && token !== '') headers['X-Leion-Token'] = token
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const response = await fetch(`${base}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    let json = null
    try { json = text === '' ? null : JSON.parse(text) } catch { json = { raw: text } }
    if (!response.ok) {
      const detail = json && (json.error ?? json.hint) ? `${json.error ?? ''} ${json.hint ?? ''}`.trim() : text.slice(0, 200)
      throw new Error(`${method} ${path} → HTTP ${response.status}：${detail}`)
    }
    return json
  }
  return { base, call }
}

const stamp = () => new Date().toISOString().slice(11, 23)

function printFrame(frame, { json }) {
  if (json) {
    console.log(`\n${stamp()} FRAME ${JSON.stringify(frame)}`)
    return
  }
  const partial = frame.partial === true ? '（增量，原地替换）' : ''
  const echo = frame.echo === true ? '（原文帧）' : ''
  const notice = typeof frame.notice === 'string' && frame.notice !== '' ? `［${frame.notice}］` : ''
  // `speaker` 是**角色**（them/me），`speakerName` 才是真名 —— 两者别混（见文档 §4.2）
  const who = typeof frame.speakerName === 'string' && frame.speakerName.trim() !== ''
    ? `${frame.speakerName}（${frame.speaker ?? '?'}）`
    : String(frame.speaker ?? '?')
  console.log(`\n${stamp()} ${frame.lang ?? '?'} ← ${who} ${partial}${echo}${notice}`)
  if (typeof frame.source === 'string' && frame.source !== '') console.log(`   原文：${frame.source}`)
  if (typeof frame.text === 'string' && frame.text !== '') console.log(`   译文：${frame.text}`)
  // 5.121：一帧可能带多种译文（三语会议里同一句会有好几份）；与 text 相同的那门不再重复打
  if (frame.translations && typeof frame.translations === 'object') {
    for (const [lang, text] of Object.entries(frame.translations)) {
      if (lang === frame.lang && text === frame.text) continue
      console.log(`   [${lang}] ${text}`)
    }
  }
  if (Array.isArray(frame.lines) && frame.lines.length > 0 && frame.text !== frame.lines.join('\n')) {
    console.log(`   按屏宽折行：${JSON.stringify(frame.lines)}`)
  }
}

function printOther(message, { json }) {
  if (json) {
    console.log(`\n${stamp()} ${JSON.stringify(message)}`)
    return
  }
  switch (message.type) {
    case 'floor':
      console.log(`\n${stamp()} 〔发言权〕持麦：${message.holder ?? '（空）'}` +
        `${message.locked === true ? ' · 已锁定' : ''}${message.released ? ` · 刚释放：${message.released}` : ''}`)
      break
    case 'closed':
      console.log(`\n${stamp()} 〔会议结束〕${message.reason ?? ''}`)
      break
    case 'removed':
      console.log(`\n${stamp()} 〔被移出〕${message.reason ?? ''}`)
      break
    case 'kicked':
      console.log(`\n${stamp()} 〔连接被顶掉〕${message.reason ?? ''}`)
      break
    case 'listening':
      console.log(`\n${stamp()} 〔声音订阅〕${message.on === true ? '开' : '关'}`)
      break
    case 'pong':
      break
    case 'frame':
      // 有 frame 字段的已经在上面拆开了；走到这里说明服务端发了个空的 frame
      console.log(`\n${stamp()} 〔字幕帧但 frame 为空〕${JSON.stringify(message)}`)
      break
    default:
      console.log(`\n${stamp()} 〔${message.type ?? '未知消息'}〕${JSON.stringify(message)}`)
  }
}

async function main(argv) {
  const args = parse(argv)
  if (args.help) {
    console.log(USAGE)
    return 0
  }
  for (const key of ['host', 'secret', 'user', 'password']) {
    if (typeof args[key] !== 'string' || args[key].trim() === '') fail(`缺 --${key}\n\n${USAGE}`)
  }
  if (args.code === undefined && args.create === undefined) fail(`要么 --code 进已有会议，要么 --create 新建\n\n${USAGE}`)
  const lang = String(args.lang ?? '').trim()
  if (lang !== '' && !LANGS.includes(lang)) fail(`--lang 只能是 ${LANGS.join(' / ')}，收到 ${JSON.stringify(lang)}`)
  const hear = String(args.hear ?? '').split(/[,;\s]+/).map((one) => one.trim()).filter((one) => one !== '')
  const bad = hear.filter((one) => !LANGS.includes(one))
  if (bad.length > 0) fail(`--hear 里有不认识的语言：${bad.join(',')}（只支持 ${LANGS.join(' / ')}）`)

  const api = createApi({ host: args.host, secret: args.secret })
  const version = await api.call('/version')
  console.log(`relay        ${api.base}（应用版本 ${version.appVersion?.name ?? '?'}）`)
  console.log(`能力         ${(version.serverFeatures ?? []).join(', ')}`)

  // ① 登录：拿 token。之后所有 /org 接口都用它，服务端据此知道"我是谁"。
  const login = await api.call('/auth/login', {
    method: 'POST', body: { username: args.user, password: args.password, label: 'watch-room' },
  })
  const token = login.token
  console.log(`登录         ${login.user}（角色 ${login.role}）`)

  // ② 开会 / 进会。两种都返回同一个 room 结构；建房多拿到一个 6 位邀请码。
  let room
  if (args.create !== undefined) {
    const created = await api.call('/org/rooms', {
      method: 'POST', token,
      body: { name: args.create, lang: lang === '' ? undefined : lang, hearLangs: hear },
    })
    room = created.room
    console.log(`建会         ${room.name}`)
    console.log(`邀请码       ${room.code}   ← 把这个发给要进来的客户端`)
    console.log(`房间 id      ${room.id}（订阅推送时用 id 或邀请码都行）`)
  } else {
    const joined = await api.call('/org/rooms/join', {
      method: 'POST', token,
      body: { code: String(args.code), lang: lang === '' ? undefined : lang, hearLangs: hear },
    })
    room = joined.room
    console.log(`进会         ${room.name}（邀请码 ${room.code}）`)
    console.log(`房间 id      ${room.id}`)
    console.log(`成员         ${(joined.members ?? []).map((one) => `${one.username}(${one.lang ?? '?'})`).join('、') || '（空）'}`)
  }

  // ③ 想听引擎说一句：POST /say 是把文字喂给识别/翻译链路（等于"假装有人说了这句"）。
  if (args.say !== '') {
    await api.call('/say', {
      method: 'POST', token,
      body: { text: args.say, from: args.from === '' ? undefined : args.from },
    })
    console.log(`已喂一句     ${args.say}（等它翻译完就会有字幕推过来）`)
  }

  const timeoutMs = Math.max(0, Number(args.timeout) || 0) * 1000
  const startedAt = Date.now()
  const stats = { frames: 0, partials: 0, others: 0 }

  // ④ 订阅字幕。两条路：WS（首选，毫秒级）与长轮询（兜底）。
  if (args.poll) {
    console.log('\n订阅         长轮询 GET /frame（每轮最多挂 30 秒，超时回 changed:false）')
    let since = 0
    const langs = hear.length > 0 ? hear.join(',') : lang
    while (timeoutMs === 0 || Date.now() - startedAt < timeoutMs) {
      const query = new URLSearchParams({ room: room.id, since: String(since) })
      if (langs !== '') query.set('langs', langs)
      const reply = await api.call(`/frame?${query.toString()}`)
      // 4.81：客户端记的序号比服务端大 = 转发进程重启过，跟着它复位，否则永远等不到新帧
      if (reply.reset === true) {
        console.log(`\n${stamp()} 〔序号重置〕服务端刚重启，序号回到 ${reply.seq}`)
        since = 0
        continue
      }
      if (typeof reply.seq === 'number') since = reply.seq
      for (const one of reply.frames ?? []) {
        stats.frames += 1
        printFrame(one.frame, args)
      }
      if (reply.changed === true && reply.frame && (reply.frames ?? []).length === 0) {
        stats.frames += 1
        printFrame(reply.frame, args)
      }
    }
  } else {
    const wsBase = api.base.replace(/^http/, 'ws')
    // ⚠️ Node 自带 WebSocket 不能加自定义头，所以 secret/token 走查询参数 ——
    //    hub 两种都收（header 优先，其次查询参数），见 lib/ws-hub.mjs。
    const query = new URLSearchParams({ room: room.id, secret: args.secret, token })
    const url = `${wsBase}/ws?${query.toString()}`
    console.log(`\n订阅         WebSocket ${wsBase}/ws?room=${room.id}&secret=***&token=***`)
    const socket = new WebSocket(url)
    const done = new Promise((resolve) => {
      socket.addEventListener('message', (event) => {
        let message
        try { message = JSON.parse(String(event.data)) } catch { return }
        // 5.153：WS 上的字幕是**包了一层的**：
        //   { type:'frame', seq, changed:true, frame:{…}, roomId, roomSeq, lang }
        // `frame` 里面才是真正的字幕帧（字段见文档 §4）。其余 type 是状态推送。
        // 老服务端/别的推送源可能直接发裸帧（没有 type）—— 那种也当字幕处理。
        if (message.type === 'frame' && message.frame !== null && typeof message.frame === 'object') {
          if (message.frame.partial === true) stats.partials += 1
          stats.frames += 1
          printFrame(message.frame, args)
          return
        }
        if (typeof message.type === 'string' && message.type !== '') {
          printOther(message, args)
          return
        }
        if (message.partial === true) stats.partials += 1
        stats.frames += 1
        printFrame(message, args)
      })
      socket.addEventListener('close', (event) => {
        console.log(`\n${stamp()} 〔连接关闭〕code=${event.code} reason=${event.reason || '（空）'}`)
        resolve()
      })
      socket.addEventListener('error', () => {
        console.error(`\n${stamp()} 〔连接出错〕（看上面的握手错误码：401 密钥/token 不对，404 房间不存在，503 连接数满）`)
      })
    })
    // 心跳：既保活也顺带验证"服务端还活着"（回一条 pong）
    const heartbeat = setInterval(() => {
      if (socket.readyState !== 1) return
      try { socket.send(JSON.stringify({ type: 'ping' })) } catch { /* 正在关 */ }
    }, 25_000)
    if (timeoutMs > 0) {
      setTimeout(() => { try { socket.close() } catch { /* 已关 */ } }, timeoutMs)
    }
    await done
    clearInterval(heartbeat)
  }

  // ⑤ 收尾：退会（发起者退会 = 整场结束，其他人退会只是离开）
  try {
    const left = await api.call('/org/rooms/leave', {
      method: 'POST', token, body: { roomId: room.id },
    })
    console.log(`\n退会         ${left.closed === true ? '这一场已结束（发起者离开）' : '已离开'}`)
  } catch (error) {
    console.log(`\n退会失败（不影响已经收到的字幕）：${error.message}`)
  }
  console.log(`统计         字幕帧 ${stats.frames}（其中增量 ${stats.partials}）`)
  return 0
}

main(process.argv.slice(2)).then((code) => process.exit(code)).catch((error) => {
  console.error(`\n✗ ${error.message}`)
  process.exit(1)
})
