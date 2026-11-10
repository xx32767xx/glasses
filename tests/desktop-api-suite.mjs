/**
 * desktop-api-suite.mjs —— 「第三方客户端接入」这份文档能不能照着做（5.153）
 * ============================================================================
 *
 * 风险不在"我们写得不够漂亮"，而在**文档与现实脱节**：
 *   · 写的接口其实不存在 / 改了名字；
 *   · 示例 JSON 少一个字段，对方照着解析就崩；
 *   · WS 上是裸帧还是包了一层（这一条最容易写错：实际是 `{type:'frame', frame:{…}}`）。
 *
 * 所以这一套不看文档像不像样，而是**把文档里的东西真跑一遍**：
 *   ① 文档里出现的每条路径都必须真的存在（对着代码里的路由表核）；
 *   ② 文档里所有 ```json 示例都必须能 JSON.parse；
 *   ③ 真起一个 relay：登录 → 建房 → 进会 → WS 订阅 → 收到字幕 → 长轮询补齐；
 *   ④ 帧上的字段与文档里的字段表逐一对照（漏一个就是文档的 bug）；
 *   ⑤ 参考客户端 scripts/watch-room.mjs 能不能被拉起来（--help）。
 */

import { readFileSync, mkdirSync, rmSync, writeFileSync, openSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { VAR_DIR } from '../lib/paths.mjs'
import { createAccountWithPassword, loadAccounts, saveAccounts } from '../lib/accounts.mjs'
import { startRelay } from '../relay/lan-relay.mjs'

const ROOT = join(import.meta.dirname, '..')
const DOC = join(ROOT, 'docs', '34-会议接入与字幕推送-桌面端对接.md')
const BASE = join(VAR_DIR, 'test', 'desktop-api')
const SECRET = 'desktop-suite-secret-0123456789'

/** 文档里提到的路径 → 在代码里该怎么找。只列出"确实由我们实现"的那些。 */
const DOC_PATHS = [
  ['/auth/login', 'POST'],
  ['/version', 'GET'],
  ['/org/rooms', 'POST'],
  ['/org/rooms/join', 'POST'],
  ['/org/rooms/leave', 'POST'],
  ['/org/rooms', 'GET'],
  ['/frame', 'GET'],
  ['/say', 'POST'],
  ['/audio', 'POST'],
]

function jsonBlocks(markdown) {
  const out = []
  for (const match of markdown.matchAll(/```json\n([\s\S]*?)```/g)) out.push(match[1])
  return out
}

/** 文档里出现的 `GET /xxx` / `POST /xxx` 形式的路由（去掉 <> 占位）。 */
function documentedRoutes(markdown) {
  const routes = new Set()
  for (const match of markdown.matchAll(/`(GET|POST|PUT|DELETE)\s+(\/[^\s`?]*)`/g)) {
    const path = match[2].replace(/<[^>]*>/g, ':id').replace(/\/+$/, '')
    routes.add(`${match[1]} ${path === '' ? '/' : path}`)
  }
  return [...routes]
}

function openSocket(url) {
  const socket = new WebSocket(url)
  const queue = []
  const waiters = []
  socket.addEventListener('message', (event) => {
    let data
    try { data = JSON.parse(String(event.data)) } catch { return }
    const waiter = waiters.shift()
    if (waiter !== undefined) waiter(data)
    else queue.push(data)
  })
  return {
    socket,
    ready: new Promise((resolve, reject) => {
      socket.addEventListener('open', () => resolve())
      socket.addEventListener('error', () => reject(new Error('ws 连接失败')))
    }),
    /** 取下一条**满足条件**的消息（其它消息丢弃，测试里够用）。 */
    async next(predicate, timeoutMs = 4000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const buffered = queue.shift()
        if (buffered !== undefined) {
          if (predicate(buffered)) return buffered
          continue
        }
        const got = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(null), Math.max(50, deadline - Date.now()))
          waiters.push((data) => { clearTimeout(timer); resolve(data) })
        })
        if (got === null) return null
        if (predicate(got)) return got
      }
      return null
    },
    close() {
      try { socket.close() } catch { /* 已关 */ }
    },
  }
}

export async function runDesktopApiSuite({ it, check }) {
  await it('5.153：文档里的每个接口都真的存在（不是写给人看的）', () => {
    const markdown = readFileSync(DOC, 'utf-8')
    const relay = readFileSync(join(ROOT, 'relay', 'lan-relay.mjs'), 'utf-8')
    const org = readFileSync(join(ROOT, 'relay', 'org-api.mjs'), 'utf-8')
    const code = `${relay}\n${org}`

    check('文档在', markdown.length > 8000, String(markdown.length))
    const routes = documentedRoutes(markdown)
    check('文档里写了不少于 8 条路由', routes.length >= 8, String(routes.length))

    const missing = routes.filter((route) => {
      const [method, path] = route.split(' ')
      // /org/* 由 org-api 按 segments 分派，没有字面量路径；其余在 relay 里是字面量
      if (path.startsWith('/org/')) {
        const tail = path.replace('/org/', '').split('/')[0]
        return !org.includes(`'${tail}'`) && !org.includes(`"${tail}"`)
      }
      if (path === '/floor') return !/segments\[3\] === 'floor'/.test(org)
      return !code.includes(`'${path}'`) && !code.includes(`"${path}"`)
    })
    check('文档里没有指向不存在的接口', missing.length === 0, missing.join(' / '))

    for (const [path, method] of DOC_PATHS) {
      const found = path.startsWith('/org/')
        ? (method === 'GET'
          ? new RegExp(`segments\\[1\\] === '${path.replace('/org/', '').split('/')[0]}'`).test(org)
          : org.includes(`'${path.split('/')[2]}'`))
        : code.includes(`'${path}'`)
      check(`文档示例用到的 ${method} ${path} 在代码里有`, found)
    }
  })

  await it('5.153：文档里的 JSON 示例都能解析，且字段表与真实帧对得上', () => {
    const markdown = readFileSync(DOC, 'utf-8')
    const blocks = jsonBlocks(markdown)
    check('文档里带了不少于 10 段 JSON 示例', blocks.length >= 10, String(blocks.length))
    const broken = []
    for (const [index, block] of blocks.entries()) {
      try {
        JSON.parse(block)
      } catch (error) {
        broken.push(`#${index + 1}: ${error.message}`)
      }
    }
    check('每段 JSON 都能解析（示例里别写注释/省略号）', broken.length === 0, broken.join('；'))

    // 字段表必须覆盖真实帧里的每一个字段 —— 漏一个，对方照着解析就会缺数据
    const documented = new Set([...markdown.matchAll(/^\| `([A-Za-z]+)` \|/gm)].map((m) => m[1]))
    for (const field of ['speaker', 'speakerName', 'lang', 'text', 'source', 'sourceLang',
      'partial', 'lines', 'cols', 'lineBudget', 'echo', 'notice', 'translations']) {
      check(`字段表里有 ${field}`, documented.has(field))
    }
  })

  await it('5.153：真跑一遍接入流程（登录 → 建房 → 进会 → WS 收字幕 → 长轮询）', async () => {
    rmSync(BASE, { recursive: true, force: true })
    mkdirSync(BASE, { recursive: true })

    // 三个账号：desk1 建房并持麦（读中英）、desk2 也读中英（用来收帧）、desk3 只读葡语
    let doc = await loadAccounts(BASE)
    for (const [username, password] of [['desk1', '123456'], ['desk2', '123456'], ['desk3', '123456']]) {
      const created = createAccountWithPassword(doc, { username, password, role: 'dev' })
      check(`建测试账号 ${username}`, created.ok === true, created.error ?? '')
      doc = created.doc
    }
    await saveAccounts(BASE, doc)

    const relay = await startRelay({
      dataDir: BASE, port: 0, host: '127.0.0.1', secret: SECRET, quiet: true, pollHoldMs: 300,
    })
    const base = `http://127.0.0.1:${relay.port}`
    const call = async (path, { method = 'GET', body, token } = {}) => {
      const headers = { 'X-Leion-Secret': SECRET }
      if (token !== undefined) headers['X-Leion-Token'] = token
      if (body !== undefined) headers['Content-Type'] = 'application/json'
      const response = await fetch(`${base}${path}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: response.status, json: await response.json().catch(() => null) }
    }

    // ① 版本与能力：客户端该按 serverFeatures 判能力，而不是猜版本号
    const version = await call('/version')
    check('/version 给 serverFeatures', Array.isArray(version.json?.serverFeatures)
      && version.json.serverFeatures.includes('frame-ws'), JSON.stringify(version.json?.serverFeatures))

    // ② 登录
    const login = await call('/auth/login', {
      method: 'POST', body: { username: 'desk1', password: '123456', label: 'suite' },
    })
    check('登录拿到 token', login.status === 200 && typeof login.json?.token === 'string',
      JSON.stringify(login.json))
    const token = login.json.token
    const login2 = await call('/auth/login', {
      method: 'POST', body: { username: 'desk2', password: '123456', label: 'suite' },
    })
    const token2 = login2.json?.token

    // ③ 建房：6 位邀请码
    const created = await call('/org/rooms', {
      method: 'POST', token, body: { name: '桌面端联调', lang: 'zh-CN', hearLangs: ['zh-CN', 'en-US'] },
    })
    check('建房返回 room.id 与 6 位 code',
      created.status === 200 && typeof created.json?.room?.id === 'string'
      && /^\d{6}$/.test(String(created.json?.room?.code)), JSON.stringify(created.json))
    const roomId = created.json.room.id
    const code = created.json.room.code

    // ④ 进会（第二个账号，读中英 —— 后面要用它收帧）
    const joined = await call('/org/rooms/join', {
      method: 'POST', token: token2, body: { code, lang: 'pt-BR', hearLangs: ['zh-CN', 'en-US'] },
    })
    check('进会返回 room 与成员列表', joined.status === 200
      && Array.isArray(joined.json?.members) && joined.json.members.length >= 2,
      JSON.stringify(joined.json?.members))
    check('成员带 hearLangs（推送扇出靠它）',
      Array.isArray(joined.json.members[0].hearLangs))

    // ⑤ 房间详情 / 发言权 / 错误码
    const detail = await call(`/org/rooms/${roomId}`, { token })
    check('房间详情有 room / members', detail.status === 200 && detail.json?.room?.id === roomId)
    const floor = await call(`/org/rooms/${roomId}/floor`, { token })
    check('发言权有 holder / leaseMs', floor.status === 200 && 'holder' in floor.json
      && typeof floor.json.leaseMs === 'number', JSON.stringify(floor.json))
    const noSecret = await fetch(`${base}/version`)
    check('没带密钥 → 401（文档 §9 写的那条）', noSecret.status === 401, String(noSecret.status))
    const noToken = await call('/org/rooms', { method: 'POST', body: { name: 'x' } })
    // ⚠️ 这里的文案是**实测**的：`/org/*` 走 org-api 的 bad(401, '需要登录（缺少有效 token）')，
    // 不是 /terms 那些老接口的 'auth-required'。文档 §9 写的就是这两句。
    check('没带 token → 401 且说清要登录',
      noToken.status === 401 && /需要登录/.test(String(noToken.json?.error)),
      JSON.stringify(noToken.json))
    const badJoin = await call('/org/rooms/join', { method: 'POST', token: token2, body: { code: '000000' } })
    check('邀请码不对 → 400 且说得清', badJoin.status === 400
      && /邀请码/.test(String(badJoin.json?.error)), JSON.stringify(badJoin.json))

    // ⑤' 第三个账号：只读葡语 —— 用来验"按语言扇出"（它不该收到中文译文）
    const login3 = await call('/auth/login', {
      method: 'POST', body: { username: 'desk3', password: '123456', label: 'suite' },
    })
    const token3 = login3.json?.token
    const joined3 = await call('/org/rooms/join', {
      method: 'POST', token: token3, body: { code, lang: 'pt-BR', hearLangs: ['pt-BR'] },
    })
    check('第三个账号进会（只读葡语）', joined3.status === 200, JSON.stringify(joined3.json))

    // ⑥ WS 订阅：连上先收 floor 快照
    const wsBase = base.replace(/^http/, 'ws')
    const client = openSocket(`${wsBase}/ws?room=${roomId}&secret=${SECRET}&token=${token}`)
    await client.ready
    const snapshot = await client.next((m) => m.type === 'floor')
    check('WS 连上先收到 floor 快照', snapshot !== null && snapshot.roomId === roomId,
      JSON.stringify(snapshot))

    // ⑦ 写一帧（等价于翻译管线写完总线）：WS 上必须是**包了一层**的 {type:'frame', frame:{…}}
    //
    // 两个要点都在这里：
    //   · `speakerName` **不是**总线里写的那个，而是服务端按"谁最近上传这段音频 / 当前持麦者"
    //     补上的（relay 的 speakerForRoom）；先抢麦才能验证它真的会出现。
    //   · 5.123：**说话人自己不看这句话的译文** —— 所以收帧的必须是**另一个**账号，
    //     否则这条用例会一直等一个永远不会来的帧（这正是文档 §6 第 2 条）。
    const took = await call(`/org/rooms/${roomId}/floor`, { method: 'POST', token, body: { action: 'take' } })
    check('抢麦成功（后面验 speakerName 要有持麦者）', took.status === 200, JSON.stringify(took.json))
    const watcher = openSocket(`${wsBase}/ws?room=${roomId}&secret=${SECRET}&token=${token2}`)
    await watcher.ready
    await watcher.next((m) => m.type === 'floor')
    const outsider = openSocket(`${wsBase}/ws?room=${roomId}&secret=${SECRET}&token=${token3}`)
    await outsider.ready
    await outsider.next((m) => m.type === 'floor')

    const bus = join(BASE, 'subtitle-bus.json')
    const FRAME = {
      device: 'Leion Pro', speaker: 'them', speakerName: '总线里写的名字（应被服务端覆盖）',
      lang: 'zh-CN',
      text: '早上好，会议改到下午三点。', source: 'Bom dia, a reunião mudou para as três da tarde.',
      sourceLang: 'pt-BR', partial: false, lines: ['早上好，会议改到下午三点。'],
      cols: 40, lineBudget: 3,
    }
    writeFileSync(bus, JSON.stringify(FRAME, null, 2))
    const pushed = await watcher.next((m) => m.type === 'frame')
    check('WS 上的字幕是「包了一层」的形状 {type:frame, frame:{…}}（文档 §3.3 写的）',
      pushed !== null && pushed.changed === true && typeof pushed.seq === 'number'
      && pushed.frame !== null && typeof pushed.frame === 'object', JSON.stringify(pushed))
    const frame = pushed === null ? {} : pushed.frame
    for (const field of ['speaker', 'lang', 'text', 'source', 'sourceLang',
      'partial', 'lines', 'cols', 'lineBudget']) {
      check(`真实帧带 ${field}（文档字段表与实现一致）`, field in frame, Object.keys(frame).join(','))
    }
    check('speakerName 由服务端补成"持麦的人"（不是总线里那个）',
      frame.speakerName === 'desk1', `${JSON.stringify(frame.speakerName)}`)

    // ⑧ 语言扇出：只读葡语的那个账号不该收到这帧 zh-CN 的中文译文
    writeFileSync(bus, JSON.stringify({ ...FRAME, text: '这一句又变了', partial: true }, null, 2))
    await new Promise((resolve) => setTimeout(resolve, 700))
    const leaked = await outsider.next((m) => m.type === 'frame' && m.lang === 'zh-CN', 500)
    check('读葡语的人收不到中文译文（按语言扇出）', leaked === null, JSON.stringify(leaked))
    client.close()
    watcher.close()
    outsider.close()

    // ⑨ 长轮询兜底：带 langs 时按语言各给一份
    const poll = await call(`/frame?room=${roomId}&since=0&langs=zh-CN,en-US`)
    check('长轮询返回 frames（每门语言一份）', poll.status === 200 && Array.isArray(poll.json?.frames),
      JSON.stringify(poll.json))
    check('长轮询的 frames 里带 lang 与 frame',
      (poll.json.frames ?? []).every((one) => typeof one.lang === 'string' && one.frame),
      JSON.stringify(poll.json.frames))
    const idle = await call(`/frame?room=${roomId}&since=9999`)
    check('序号比服务端大 → reset:true（否则客户端永远等不到新帧）',
      idle.json?.reset === true, JSON.stringify(idle.json))

    // ⑩ 退会：发起者退会 = 整场结束
    const left = await call('/org/rooms/leave', { method: 'POST', token, body: { roomId } })
    check('发起者退会返回 closed:true', left.status === 200 && left.json?.closed === true,
      JSON.stringify(left.json))
    await relay.close()
  })

  await it('5.153：参考客户端 scripts/watch-room.mjs 拉得起来', () => {
    const script = join(ROOT, 'scripts', 'watch-room.mjs')
    const source = readFileSync(script, 'utf-8')
    check('脚本在', source.length > 4000, String(source.length))
    check('零依赖（只用 Node 自带能力：fetch + 全局 WebSocket）',
      !/from '(?!node:)/.test(source) && !/require\(/.test(source))
    check('它自己就是 WS 的客户端', /new WebSocket\(/.test(source))
    check('它认得 {type:\'frame\'} 这一层包装（写错的客户端只会收到 0 帧）',
      /message\.type === 'frame' && message\.frame/.test(source))
    check('长轮询模式也实现了（--poll）', /args\.poll/.test(source) && /\/frame\?/.test(source))
    check('reset 处理写在这条路上', /reply\.reset === true/.test(source))

    const fd = openSync(join(BASE, 'watch-help.txt'), 'w')
    let failure = null
    try {
      execFileSync(process.execPath, [script, '--help'], { stdio: ['ignore', fd, fd] })
    } catch (error) {
      failure = error
    } finally {
      closeSync(fd)
    }
    if (failure !== null && failure.code === 'EPERM') {
      console.log('  ⏭ 这个沙箱不允许 Node 起子进程，跳过 --help 可执行用例。')
      return
    }
    check('--help 退出码为 0', failure === null, String(failure?.message ?? ''))
    const printed = readFileSync(join(BASE, 'watch-help.txt'), 'utf-8')
    check('--help 把用法与参数说清了', /--host/.test(printed) && /--secret/.test(printed)
      && /--code/.test(printed) && /--create/.test(printed), printed.slice(0, 120))
  })
}
