/**
 * mail.mjs —— 发一封邮件（**零依赖**，只用 node 自带的 net / tls）
 * ============================================================================
 *
 * 为什么自己写 SMTP 而不装 nodemailer：
 *   · 这个仓库的规矩是**零第三方依赖**（插件要能被粘进动态沙箱，多一个依赖就多一处
 *     加载失败的可能）；而我们只需要"发一封纯文本邮件"这一件事；
 *   · 真正需要防的坑就那么几个，全在下面写清楚了，比藏在依赖里更难踩。
 *
 * 支持的连接方式（按环境变量决定，见 {@link smtpConfigFromEnv}）：
 *   · **隐式 TLS**（465）：连上就是 TLS；
 *   · **STARTTLS**（587）：先明文 EHLO，再升级；
 *   · **明文**（25 / 本地中继）：只在显式关掉 TLS 时才用（公网上极不推荐）。
 *
 * 认证：优先 `AUTH PLAIN`，服务器不认再退 `AUTH LOGIN`。
 *
 * ⚠️ 三个必须处理的现实问题（不处理就会"发不出去"而看不出原因）：
 *   1. **多行响应**：`250-XXX` 是续行、`250 XXX` 才是最后一行 —— 只读一行会把 EHLO 截断；
 *   2. **中文标题/正文**：标题用 RFC 2047 编码词，正文 base64（否则被中间环节改成乱码）；
 *   3. **超时**：没有超时的 SMTP 会永远挂着，而上层是"用户点了获取验证码在等"。
 */

import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { hostname } from 'node:os'

export const MAIL_DEFAULTS = {
  port: 587,
  timeoutMs: 15000,
  /** 连接后多久没动静算超时（一轮 SMTP 对话是"命令 → 响应"，不该有长间隙） */
  idleMs: 15000,
}

/**
 * 从环境变量读 SMTP 配置。
 *
 * <pre>
 *   LEION_SMTP_HOST      smtp.example.com        （缺省：不启用邮件）
 *   LEION_SMTP_PORT      587 / 465 / 25          （缺省 587）
 *   LEION_SMTP_SECURE    1 = 隐式 TLS（465 用）  （缺省按端口猜：465 → 1）
 *   LEION_SMTP_STARTTLS  1 = 升级 TLS（587 用）  （缺省：非 secure 且未显式关就试 STARTTLS）
 *   LEION_SMTP_USER      登录用户名
 *   LEION_SMTP_PASS      登录密码 / 授权码
 *   LEION_SMTP_FROM      发件人（缺省 = 用户名）
 *   LEION_SMTP_FROM_NAME 发件人显示名（缺省 "译连 TransLink"）
 * </pre>
 *
 * @returns {null | {host: string, port: number, secure: boolean, starttls: boolean,
 *   user: string, pass: string, from: string, fromName: string, timeoutMs: number}}
 */
export function smtpConfigFromEnv(env = process.env) {
  const host = String(env.LEION_SMTP_HOST ?? '').trim()
  if (host === '') return null
  const portRaw = String(env.LEION_SMTP_PORT ?? '').trim()
  const port = portRaw === '' ? MAIL_DEFAULTS.port : Number(portRaw)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  const secureRaw = String(env.LEION_SMTP_SECURE ?? '').trim()
  // 没显式说就用端口猜：465 是隐式 TLS 的约定端口
  const secure = secureRaw === '' ? port === 465 : /^(1|true|yes|on)$/i.test(secureRaw)
  const starttlsRaw = String(env.LEION_SMTP_STARTTLS ?? '').trim()
  const starttls = starttlsRaw === ''
    ? (secure !== true && port !== 25)
    : /^(1|true|yes|on)$/i.test(starttlsRaw)
  const user = String(env.LEION_SMTP_USER ?? '').trim()
  const pass = String(env.LEION_SMTP_PASS ?? '')
  const from = String(env.LEION_SMTP_FROM ?? '').trim() || user
  if (from === '') return null
  const timeoutRaw = String(env.LEION_SMTP_TIMEOUT_MS ?? '').trim()
  const timeoutMs = timeoutRaw === '' ? MAIL_DEFAULTS.timeoutMs : Number(timeoutRaw)
  return {
    host, port, secure, starttls, user, pass, from,
    fromName: String(env.LEION_SMTP_FROM_NAME ?? '').trim() || '译连 TransLink',
    timeoutMs: Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : MAIL_DEFAULTS.timeoutMs,
  }
}

/**
 * 常见邮箱服务商 → 该用哪个 SMTP 主机（5.162）。
 *
 * <p>为什么写这张表：**535 认证失败最常见的原因不是密码错，是主机用错了**。
 * 实测踩到的那次就是这样：账号是 `xxx@qq.com`（个人 QQ 邮箱），主机却写成
 * `smtp.exmail.qq.com`（腾讯**企业邮**）—— 那是两套互不相通的账号体系，
 * 服务器只会回一句 `535 Error: authentication failed, system busy`，
 * 让人以为是授权码过期。把"这个域名该用哪台"直接说出来，比让人对着 535 猜强。
 */
export const SMTP_HOST_HINTS = Object.freeze({
  'qq.com': 'smtp.qq.com',
  'foxmail.com': 'smtp.qq.com',
  'exmail.qq.com': 'smtp.exmail.qq.com',          // 企业邮自己的域名
  '163.com': 'smtp.163.com',
  '126.com': 'smtp.126.com',
  'yeah.net': 'smtp.yeah.net',
  'gmail.com': 'smtp.gmail.com',
  'outlook.com': 'smtp-mail.outlook.com',
  'hotmail.com': 'smtp-mail.outlook.com',
  'live.com': 'smtp-mail.outlook.com',
  'icloud.com': 'smtp.mail.me.com',
})

/** 从用户名（邮箱）推出"该用哪台 SMTP"；查不到返回空串（**不猜**）。 */
export function expectedSmtpHost(user) {
  const raw = String(user ?? '').trim().toLowerCase()
  const at = raw.lastIndexOf('@')
  if (at < 0) return ''
  const domain = raw.slice(at + 1)
  return SMTP_HOST_HINTS[domain] ?? ''
}

/**
 * 主机与账号域名对不上时返回一句人话（对得上返回空串）。
 *
 * <p>只提示、不阻止：企业邮用户可以把自己的域名指到 exmail，那种情况我们无从判断。
 */
export function smtpHostMismatch(config) {
  if (config === null || typeof config !== 'object') return ''
  const expected = expectedSmtpHost(config.user)
  if (expected === '') return ''
  const actual = String(config.host ?? '').trim().toLowerCase()
  if (actual === expected) return ''
  return `账号 ${config.user} 对应的 SMTP 主机应当是 ${expected}，而配置里是 ${config.host}`
}

/** 一句话说清"为什么没配邮件"（给管理台/日志用，别让人猜）。 */
export function describeMailConfig(config) {
  if (config === null || config === undefined) {
    return '没配邮件服务（需要 LEION_SMTP_HOST / LEION_SMTP_USER / LEION_SMTP_PASS）'
  }
  return `${config.host}:${config.port}（${config.secure ? '隐式 TLS' : (config.starttls ? 'STARTTLS' : '明文')}）`
}

/** RFC 2047 编码词：中文标题不加这个会被中间环节弄成乱码。 */
export function encodeHeaderWord(text) {
  const raw = String(text ?? '')
  // 纯 ASCII 直接放（能省掉一堆 base64，也让日志好读）
  if (/^[\x20-\x7e]*$/.test(raw)) return raw
  return `=?UTF-8?B?${Buffer.from(raw, 'utf8').toString('base64')}?=`
}

/** 把一封纯文本邮件渲染成 SMTP DATA 需要的报文（含头、含 MIME）。 */
export function buildMessage({ from, fromName, to, subject, text, messageId }) {
  const body = Buffer.from(String(text ?? ''), 'utf8').toString('base64')
  const lines = [
    `From: ${fromName ? `${encodeHeaderWord(fromName)} <${from}>` : from}`,
    `To: ${to}`,
    `Subject: ${encodeHeaderWord(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${messageId}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    // base64 每 76 字符换行（RFC 2045），否则长行会被某些服务器截断
    (body.match(/.{1,76}/g) ?? ['']).join('\r\n'),
    '',
  ]
  return lines.join('\r\n')
}

/**
 * 一个极小的 SMTP 会话封装：读一行响应（支持多行续行）、发一行命令。
 *
 * 单独抽出来是因为"读响应"是这类代码最容易写错的地方：SMTP 的响应是
 * `250-first\r\n250-second\r\n250 last\r\n`，只 read 一次会拿到半截。
 */
function createSession(socket, { timeoutMs }) {
  let buffer = ''
  let pending = null
  let failure = null

  const fail = (error) => {
    failure = error instanceof Error ? error : new Error(String(error))
    if (pending !== null) {
      const { reject } = pending
      pending = null
      reject(failure)
    }
    socket.destroy()
  }

  const tryResolve = () => {
    if (pending === null) return
    // 找到一段"以 `NNN `（数字+空格）结尾"的完整响应；续行是 `NNN-`
    const match = /(^|\r?\n)(\d{3}) ([^\r\n]*)(\r?\n|$)/.exec(buffer)
    if (match === null) return
    const end = match.index + match[0].length
    const raw = buffer.slice(0, end)
    buffer = buffer.slice(end)
    const code = Number(match[2])
    const text = raw
      .split(/\r?\n/)
      .map((line) => line.replace(/^\d{3}[- ]/, '').trim())
      .filter((line) => line !== '')
      .join(' | ')
    const { resolve } = pending
    pending = null
    resolve({ code, text, raw: raw.trim() })
  }

  socket.setEncoding('utf8')
  socket.setTimeout(timeoutMs, () => fail(new Error(`SMTP 超时（${timeoutMs}ms 没有响应）`)))
  socket.on('data', (chunk) => {
    buffer += chunk
    tryResolve()
  })
  socket.on('error', (error) => fail(error))
  socket.on('close', () => {
    if (pending !== null) fail(new Error('SMTP 连接被关闭（没等到响应）'))
  })

  return {
    /** 等下一行（完整的一个响应）。 */
    read() {
      if (failure !== null) return Promise.reject(failure)
      return new Promise((resolve, reject) => {
        pending = { resolve, reject }
        tryResolve()
      })
    },
    /** 发一行命令，避免注入换行（`\r\n` 在 SMTP 里是分隔符，绝不能出现在参数里）。 */
    write(line) {
      if (failure !== null) throw failure
      socket.write(String(line).replace(/[\r\n]/g, ' ') + '\r\n')
    },
    /** 换到 TLS（STARTTLS 之后所有流量都走加密通道）。 */
    upgrade(host) {
      return new Promise((resolve, reject) => {
        socket.removeAllListeners('data')
        socket.removeAllListeners('close')
        const secured = tlsConnect({ socket, servername: host }, () => {
          secured.removeListener('error', reject)
          resolve(secured)
        })
        secured.once('error', reject)
      })
    },
    raw() { return socket },
    close() { try { socket.end() } catch { /* 已断 */ } },
    get failed() { return failure },
  }
}

/** 期望某个响应码，否则抛错（错误里带服务器原话 —— 排障全靠它）。 */
function expect(reply, allowed, step) {
  const codes = Array.isArray(allowed) ? allowed : [allowed]
  if (codes.includes(reply.code) !== true) {
    throw new Error(`${step} 失败：服务器返回 ${reply.code}「${reply.text}」`)
  }
  return reply
}

/**
 * 发一封纯文本邮件。
 *
 * @param {{to: string, subject: string, text: string}} message
 * @param {{config: object, timeoutMs?: number, now?: number}} options
 * @returns {Promise<{ok: boolean, error?: string, transcript?: string[]}>}
 *   `transcript` 是脱敏后的对话记录（**不含**密码），失败时用来定位卡在哪一步。
 */
export async function sendMail(message, options = {}) {
  const config = options.config ?? smtpConfigFromEnv()
  if (config === null || config === undefined) {
    return { ok: false, error: '没有配置 SMTP（LEION_SMTP_HOST/USER/PASS）' }
  }
  const to = String(message?.to ?? '').trim()
  if (to === '') return { ok: false, error: '收件人为空' }
  const subject = String(message?.subject ?? '')
  const text = String(message?.text ?? '')
  const timeoutMs = options.timeoutMs ?? config.timeoutMs ?? MAIL_DEFAULTS.timeoutMs
  const transcript = []
  const note = (line) => { if (transcript.length < 40) transcript.push(line) }

  let socket = null
  try {
    socket = config.secure === true
      ? tlsConnect({ host: config.host, port: config.port, servername: config.host })
      : netConnect({ host: config.host, port: config.port })
    let session = createSession(socket, { timeoutMs })
    if (config.secure === true) {
      // 隐式 TLS：等握手完成（tlsConnect 的 'secureConnect' 之后才能读写业务数据）
      await new Promise((resolve, reject) => {
        const onReady = () => { socket.removeListener('error', reject); resolve() }
        socket.once('secureConnect', onReady)
        socket.once('error', reject)
      })
    }

    const greeting = await session.read()
    note(`S: ${greeting.code} ${greeting.text}`)
    expect(greeting, 220, '连上服务器（问候）')

    session.write(`EHLO ${hostname() || 'localhost'}`)
    let ehlo = await session.read()
    note(`S: ${ehlo.code} ${ehlo.text}`)
    // 有的老服务器只认 HELO
    if (ehlo.code !== 250) {
      session.write(`HELO ${hostname() || 'localhost'}`)
      ehlo = await session.read()
      note(`S: ${ehlo.code} ${ehlo.text}`)
      expect(ehlo, 250, 'EHLO/HELO')
    }

    if (config.starttls === true && config.secure !== true) {
      session.write('STARTTLS')
      const ready = await session.read()
      note(`S: ${ready.code} ${ready.text}`)
      expect(ready, 220, 'STARTTLS')
      const secured = await session.upgrade(config.host)
      session = createSession(secured, { timeoutMs })
      session.write(`EHLO ${hostname() || 'localhost'}`)
      const again = await session.read()
      note(`S: ${again.code} ${again.text}`)
      expect(again, 250, 'STARTTLS 之后重新 EHLO')
    }

    if (config.user !== '') {
      // 先试 AUTH PLAIN（一条命令），不行再退 LOGIN（两步）
      session.write(`AUTH PLAIN ${Buffer.from(`\u0000${config.user}\u0000${config.pass}`, 'utf8').toString('base64')}`)
      const plain = await session.read()
      note(`S: ${plain.code} ${plain.text}`)
      if (plain.code !== 235) {
        session.write('AUTH LOGIN')
        const login = await session.read()
        note(`S: ${login.code} ${login.text}`)
        expect(login, 334, 'AUTH LOGIN')
        session.write(Buffer.from(config.user, 'utf8').toString('base64'))
        const userReply = await session.read()
        note(`S: ${userReply.code} ${userReply.text}`)
        expect(userReply, 334, 'AUTH LOGIN（用户名）')
        session.write(Buffer.from(config.pass, 'utf8').toString('base64'))
        const passReply = await session.read()
        // ⚠️ 密码那一步失败也只记状态码，**绝不把密码写进日志**
        note(`S: ${passReply.code} ${passReply.text}`)
        // 5.162：认证失败时把最可能的原因直接说出来。535 最多的两种情况：
        //   ① 主机用错了（个人 QQ 邮箱配成企业邮 smtp.exmail.qq.com —— 两套账号体系）；
        //   ② 密码填的是登录密码，而不是服务商要求的**授权码**。
        if (passReply.code === 535) {
          const mismatch = smtpHostMismatch(config)
          const extra = mismatch === ''
            ? '密码多半不是服务商要求的授权码（QQ/163 都要单独生成，不是登录密码）'
            : `${mismatch}；535 多半就是这个原因`
          throw new Error(`AUTH LOGIN（密码）失败：服务器返回 535「${passReply.text}」—— ${extra}`)
        }
        expect(passReply, 235, 'AUTH LOGIN（密码）')
      }
    }

    session.write(`MAIL FROM:<${config.from}>`)
    const mailFrom = await session.read()
    note(`S: ${mailFrom.code} ${mailFrom.text}`)
    expect(mailFrom, 250, 'MAIL FROM')

    session.write(`RCPT TO:<${to}>`)
    const rcpt = await session.read()
    note(`S: ${rcpt.code} ${rcpt.text}`)
    expect(rcpt, [250, 251], 'RCPT TO')

    session.write('DATA')
    const data = await session.read()
    note(`S: ${data.code} ${data.text}`)
    expect(data, 354, 'DATA')

    const messageId = `${Date.now()}.${Math.random().toString(36).slice(2, 10)}@${config.host}`
    const payload = buildMessage({
      from: config.from, fromName: config.fromName, to, subject, text, messageId,
    })
    session.raw().write(payload + '.\r\n')
    const accepted = await session.read()
    note(`S: ${accepted.code} ${accepted.text}`)
    expect(accepted, 250, '投递')

    session.write('QUIT')
    try { await session.read() } catch { /* 服务器可能直接关，不算失败 */ }
    session.close()
    return { ok: true, transcript }
  } catch (error) {
    try { socket?.destroy() } catch { /* 已断 */ }
    const message_ = String(error?.message ?? error)
    note(`! ${message_}`)
    return { ok: false, error: message_, transcript }
  }
}
