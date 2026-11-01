/**
 * accounts-suite.mjs —— 账户 / 密码 / token（"你是谁"这一层）
 * ============================================================================
 *
 * 这一层要守的不是"能不能登录"，而是**能不能越权**：
 *   · 密码与 token 都不能以明文落盘（库泄露 ≠ 被登录）；
 *   · 有账户之后，热词表**只认 token** —— 请求里自报的用户名必须被忽略；
 *   · 一个 token 注销不影响其它设备。
 *
 * 每一条都配了"反过来也成立"的断言（比如：带 A 的 token 改不动 B 的表）。
 */

import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { startRelay } from '../relay/lan-relay.mjs'
import { VAR_DIR } from '../lib/paths.mjs'
import { ensureTestAccount, resetTestAccount } from '../scripts/test-account.mjs'
import {
  checkPassword, createAccountWithPassword, emptyAccounts, hashPassword, issueToken, loadAccounts, login,
  loginWithEmail, normalizeUsername, register, registerWithEmail, revokeToken, saveAccounts, tokenKey,
  userForToken, verifyPassword,
} from '../lib/accounts.mjs'
import { writeAccountsDoc } from '../lib/accounts-store.mjs'
import { dbPath, openDb } from '../lib/db.mjs'

const TMP = join(VAR_DIR, 'test', 'accounts-suite')

export async function runAccountsSuite({ it, check, assert }) {
  /**
   * 注册助手（2026-10-24 新模型）：先取验证码，再走 /auth/register-email。
   * 为什么不再直接 POST /auth/register：那条"用户名+密码"的注册路由已经删掉 ——
   * 用户要求注册必须带邮箱验证码（docs/19），留两个注册口等于留一个绕过验证的后门。
   */
  const registerViaEmail = async (call, username, password) => {
    const email = `${username}@example.com`
    const issued = await call('/auth/code', { method: 'POST', body: { email } })
    return call('/auth/register-email', {
      method: 'POST',
      body: { email, username, password, code: String(issued.json?.code ?? '') },
    })
  }

  await rm(TMP, { recursive: true, force: true })
  await mkdir(TMP, { recursive: true })

  // ── 1. 纯函数 ──────────────────────────────────────────────────────────
  await it('密码只存哈希：同一密码两次注册的盐与哈希都不同，但都能验过', () => {
    const a = hashPassword('secret12')
    const b = hashPassword('secret12')
    check('盐不同', a.salt !== b.salt, 'a=' + a.salt + ' b=' + b.salt)
    check('哈希不同（说明加盐生效）', a.hash !== b.hash)
    check('都能验过', verifyPassword('secret12', a) && verifyPassword('secret12', b))
    check('错密码验不过', verifyPassword('secret13', a) === false)
    check('falsy 记录验不过', verifyPassword('secret12', null) === false)
  })

  await it('token 只存哈希：库里找不到明文 token', () => {
    const result = register(emptyAccounts(), 'wu', 'secret12')
    check('注册成功', result.ok === true, result.error)
    const serialized = JSON.stringify(result.doc)
    check('库里没有明文 token', serialized.includes(result.token) === false)
    check('库里存的是 sha256', result.doc.tokens[tokenKey(result.token)] !== undefined)
    check('token 够长（32 字节 → 64 hex）', result.token.length === 64, String(result.token.length))
  })

  await it('用户名与密码的边界：非法用户名被拒、短密码被拒、重复注册被拒', () => {
    check('路径字符被拒', normalizeUsername('../etc').ok === false)
    check('太短被拒', normalizeUsername('a').ok === false)
    check('中文用户名被拒（会进文件名与日志，保持窄）', normalizeUsername('王工').ok === false)
    check('短密码被拒', checkPassword('123').ok === false)
    const first = register(emptyAccounts(), 'wu', 'secret12')
    check('首次注册成功', first.ok === true, first.error)
    const again = register(first.doc, 'wu', 'other12')
    check('重复注册被拒（不许静默覆盖别人的密码）', again.ok === false && /已经被注册/.test(again.error), again.error)
  })

  await it('登录：用户名不存在与密码错误返回同一句话（不泄露"这个用户存在"）', () => {
    const doc = register(emptyAccounts(), 'wu', 'secret12').doc
    const noUser = login(doc, 'nobody', 'secret12')
    const badPass = login(doc, 'wu', 'wrong-pass')
    check('两种失败都失败', noUser.ok === false && badPass.ok === false)
    check('错误文案一致', noUser.error === badPass.error, noUser.error + ' vs ' + badPass.error)
    const good = login(doc, 'wu', 'secret12')
    check('正确登录成功', good.ok === true)
    check('新 token 不等于注册时那个', good.token !== undefined)
  })

  // 2026-10-27 用户要求：**同一账号只允许一处登录**。
  // 下面的断言与旧版相反是故意的 —— 旧版"多设备并存"，新版"后登录者把前一个踢下线"。
  await it('单会话：再次登录会让前一个 token 失效', () => {
    const reg = register(emptyAccounts(), 'wu', 'secret12')
    const second = login(reg.doc, 'wu', 'secret12')
    check('第二次登录给的是新 token', second.ok === true && second.token !== reg.token)
    check('前一个 token 已被吊销', userForToken(second.doc, reg.token) === null)
    check('新 token 有效', userForToken(second.doc, second.token) === 'wu')
    const revoked = revokeToken(second.doc, second.token)
    check('注销后当前 token 也失效', userForToken(revoked.doc, second.token) === null)
  })

  await it('测试账户脚本：一条命令建好账户 + 热词表，token 当场可用，reset 能清干净', async () => {
    const dataDir = join(TMP, 'script-account')
    const result = await ensureTestAccount({ dataDir, terms: [{ zh: '亮亮视野', pt: 'LLVision' }] })
    check('给了用户名与 token', result.username === 'test' && result.token.length === 64, JSON.stringify(result))
    check('表写进去了', result.entries === 1, String(result.entries))
    // 同一个账号再跑一次：不该报错（走登录、重新签发 token）
    const again = await ensureTestAccount({ dataDir, terms: [{ zh: '亮亮视野', pt: 'LLVision' }] })
    check('可重复执行（幂等）', again.username === 'test' && again.entries === 1, JSON.stringify(again))
    check('两次的 token 不同（每次登录都新签一个）', again.token !== result.token)
    // 旧 token 仍然有效（登录不踢掉别的设备）—— 这是刻意的语义
    const { loadAccounts, userForToken } = await import('../lib/accounts.mjs')
    const doc = await loadAccounts(dataDir)
    // 单会话：新登录踢掉旧 token（2026-10-27 用户要求）
    check('旧 token 已失效', userForToken(doc, result.token) === null)
    check('新 token 有效', userForToken(doc, again.token) === 'test')
    // reset 之后账户与表都没了
    await resetTestAccount({ dataDir })
    const after = await loadAccounts(dataDir)
    check('账户被清掉', Object.keys(after.users).includes('test') === false, JSON.stringify(after.users))
    const { loadTerms, getTable } = await import('../lib/terms.mjs')
    check('表被清掉', getTable(await loadTerms(dataDir), 'test').entries.length === 0)
  })

  // ── 2. HTTP 端点与越权 ─────────────────────────────────────────────────
  const relay = await startRelay({
    port: 0, host: '127.0.0.1', secret: 'accounts-secret',
    dataDir: TMP, inbox: join(TMP, 'asr-inbox.jsonl'), bus: join(TMP, 'subtitle-bus.json'),
    pollHoldMs: 200, busPollMs: 30, quiet: true,
  })
  const base = `http://127.0.0.1:${relay.port}`
  const call = async (path, { method = 'GET', body, token = null, secret = 'accounts-secret' } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(secret === null ? {} : { 'x-leion-secret': secret }),
        ...(token === null ? {} : { 'x-leion-token': token }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch { /* 保留 null */ }
    return { status: response.status, json, text }
  }

  const GOOD = [{ zh: '亮亮视野', pt: 'LLVision' }]

  /**
   * 清掉残留的验证码行。
   *
   * <p>用途只有一个：注册成功那条路会把验证码消费掉，而**60 秒间隔**是按库里
   * `issued_at` 判的。要连着验"同一个邮箱第二次注册"就必须再要一个码，
   * 与其 sleep 60 秒，不如直接把码行删掉 —— 那条行不存在，限流自然就不生效。
   * 这不是绕过被测逻辑：被测的是"注册时邮箱唯一"，不是发码间隔（后者另有测试）。
   */
  const clearCodes = () => {
    const db = openDb(dbPath(TMP))
    try {
      db.prepare('DELETE FROM auth_codes').run()
    } finally {
      db.close()
    }
  }

  try {
    await it('还没有账户时：热词表仍可用（迁移期，按自报用户名）', async () => {
      const put = await call('/terms', { method: 'PUT', body: { user: 'legacy', entries: GOOD } })
      check('200', put.status === 200, put.text)
      const get = await call('/terms?user=legacy')
      check('能读回', get.json.entries.length === 1, get.text)
    })

    await it('注册：给 token；密码与 token 都不以明文落盘', async () => {
      const reg = await registerViaEmail(call, 'alice', 'secret12')
      check('200', reg.status === 200, reg.text)
      check('给了 token', typeof reg.json.token === 'string' && reg.json.token.length === 64, reg.text)
      check('回显用户名', reg.json.user === 'alice')
      const raw = await readFile(join(TMP, 'leion.db'), 'utf-8')
      check('文件里没有明文密码', raw.includes('secret12') === false)
      check('文件里没有明文 token', raw.includes(reg.json.token) === false)
    })

    await it('有账户之后：不带 token 读写热词表一律 401（自报用户名的路已关）', async () => {
      const put = await call('/terms', { method: 'PUT', body: { user: 'alice', entries: GOOD } })
      check('PUT 401', put.status === 401, put.text)
      const get = await call('/terms?user=alice')
      check('GET 401', get.status === 401, get.text)
      const legacyGet = await call('/terms?user=legacy')
      check('连旧的迁移表也读不到了（不留后门）', legacyGet.status === 401, legacyGet.text)
    })

    await it('越权：A 的 token 只能读写 A 的表，改不动 B 的', async () => {
      const bob = await registerViaEmail(call, 'bob', 'secret12')
      check('bob 注册成功', bob.status === 200, bob.text)
      const alice = await call('/auth/login', { method: 'POST', body: { username: 'alice', password: 'secret12' } })
      check('alice 登录成功', alice.status === 200, alice.text)

      await call('/terms', { method: 'PUT', token: alice.json.token, body: { entries: GOOD } })
      await call('/terms', {
        method: 'PUT', token: bob.json.token,
        // 故意在请求体里冒称 alice：必须被忽略（这是这次要修的核心问题）
        body: { user: 'alice', entries: [{ zh: '机器学习', pt: 'Aprendizado de máquina' }] },
      })

      const aliceTable = await call('/terms', { token: alice.json.token })
      check('alice 的表还是原来那条', aliceTable.json.entries.length === 1
        && aliceTable.json.entries[0].zh === '亮亮视野', aliceTable.text)
      check('alice 表没被冒名顶替写脏', aliceTable.json.entries[0].pt === 'LLVision', aliceTable.text)

      const bobTable = await call('/terms', { token: bob.json.token })
      check('bob 的表是 bob 自己那条', bobTable.json.entries[0].zh === '机器学习', bobTable.text)
    })

    await it('5.17：同一邮箱 60 秒内只能发一次验证码（429 且说清还要等几秒）', async () => {
      const email = 'ratelimit@example.com'
      const first = await call('/auth/code', { method: 'POST', body: { email } })
      check('第一次发码成功', first.status === 200 && first.json.ok === true, first.text)
      const second = await call('/auth/code', { method: 'POST', body: { email } })
      check('紧接着再要 → 429', second.status === 429, second.text)
      check('带机器码 too-frequent（客户端据此显示"请 N 秒后再试"）',
        second.json?.error === 'too-frequent', JSON.stringify(second.json))
      check('人话在 hint 里（服务端原话只放在这一处）',
        String(second.json?.hint ?? '').includes('频繁'), JSON.stringify(second.json?.hint))
      check('带上还要等多少秒（≤60 且 >0）',
        Number(second.json?.retryAfterSec) > 0 && Number(second.json?.retryAfterSec) <= 60,
        String(second.json?.retryAfterSec))
      check('**没有** `code` 字段（那个名字只属于六位验证码）', second.json?.code === undefined,
        JSON.stringify(second.json?.code))
      // 别的邮箱不受影响（限流是**按邮箱**，不是全局）
      const other = await call('/auth/code', { method: 'POST', body: { email: 'ratelimit2@example.com' } })
      check('换个邮箱照常发', other.status === 200 && other.json.ok === true, other.text)
    })

    await it('5.19：注册的纯函数 —— 邮箱已注册就 email-taken，且先于用户名判断', () => {
      const first = registerWithEmail(emptyAccounts(), {
        email: 'a@b.com', username: 'first', password: 'secret12', codePreVerified: true,
      })
      check('第一次注册成功', first.ok === true, first.error)
      const sameEmail = registerWithEmail(first.doc, {
        email: '  A@B.com ', username: 'second', password: 'secret12', codePreVerified: true,
      })
      check('同一个邮箱换用户名也不行', sameEmail.ok === false && sameEmail.code === 'email-taken',
        JSON.stringify(sameEmail))
      check('大小写/空格都算同一个邮箱', /已经注册过了/.test(String(sameEmail.error)), sameEmail.error)
      check('点名已有用户名（此刻验证码已验过，不算泄露）', sameEmail.user === 'first', String(sameEmail.user))
      const sameName = registerWithEmail(first.doc, {
        email: 'c@d.com', username: 'first', password: 'secret12', codePreVerified: true,
      })
      check('换邮箱但用户名重复 → username-taken', sameName.ok === false && sameName.code === 'username-taken',
        JSON.stringify(sameName))
    })

    await it('5.19：写入层兜底 —— 一份"两个账号绑同一邮箱"的 doc 会被整份拒绝', () => {
      const doc = {
        version: 1,
        users: {
          alice: { role: 'user', email: 'x@y.com' },
          bob: { role: 'user', email: 'X@Y.com' },
        },
        tokens: {}, codes: {},
      }
      const result = writeAccountsDoc(join(TMP, 'dup-email'), doc)
      check('拒绝写入', result.ok === false, JSON.stringify(result))
      check('原因说清是哪个邮箱、哪两个账号',
        /一个邮箱只能有一个账号/.test(String(result.error)) && /alice/.test(String(result.error))
        && /bob/.test(String(result.error)), String(result.error))
    })

    await it('5.19：邮箱验证码登录不会给同一个邮箱再开一个账号', () => {
      const first = registerWithEmail(emptyAccounts(), {
        email: 'e@f.com', username: 'owner', password: 'secret12', codePreVerified: true,
      })
      const second = loginWithEmail(first.doc, 'E@F.com', '', { codePreVerified: true })
      check('登进的是已有账号，不是新建', second.ok === true && second.user === 'owner' && second.created === false,
        JSON.stringify({ user: second.user, created: second.created }))
      check('库里没有多出"用户名=邮箱"的第二个账号', second.doc.users['e@f.com'] === undefined,
        Object.keys(second.doc.users).join(','))
    })

    await it('5.19：一个邮箱只能注册一次（走真实 HTTP：第二次 400 + email-taken）', async () => {
      const email = 'once@example.com'
      const firstCode = await call('/auth/code', { method: 'POST', body: { email } })
      const first = await call('/auth/register-email', {
        method: 'POST',
        body: { email, username: 'once-user', password: 'secret12', code: String(firstCode.json?.code ?? '') },
      })
      check('第一次注册成功', first.status === 200, first.text)
      // 注册成功后那条验证码就被消费掉了，所以"再要一个码"不会被 60 秒间隔拦住 ——
      // 正好用来验第二次注册。这里不 sleep，也不改代码，只是删掉残留的行（保险）。
      clearCodes()
      const secondCode = await call('/auth/code', { method: 'POST', body: { email } })
      const second = await call('/auth/register-email', {
        method: 'POST',
        body: {
          email, username: 'another-user', password: 'secret12',
          code: String(secondCode.json?.code ?? ''),
        },
      })
      check('第二次被拒（400）', second.status === 400, second.text)
      check('机器码是 email-taken（客户端据此显示"已注册过"）',
        second.json?.error === 'email-taken', JSON.stringify(second.json))
      check('人话里点名了已有用户名', String(second.json?.hint ?? '').includes('once-user'),
        JSON.stringify(second.json?.hint))

      const doc = await loadAccounts(TMP)
      check('another-user 没有被建出来', doc.users['another-user'] === undefined,
        Object.keys(doc.users).join(','))
      check('这个邮箱在库里只对应一个账号',
        Object.values(doc.users).filter((r) => String(r?.email ?? '').toLowerCase() === email).length === 1,
        JSON.stringify(Object.values(doc.users).map((r) => r?.email)))
    })

    await it('5.19：发码时就说"这个邮箱已经注册过了"（并且不在这一步泄露用户名）', async () => {
      clearCodes()
      const response = await call('/auth/code', { method: 'POST', body: { email: 'once@example.com' } })
      check('200，码照发（将来"验证码直登"要用同一封）',
        response.status === 200 && response.json?.ok === true, response.text)
      check('标了 alreadyRegistered', response.json?.alreadyRegistered === true, response.text)
      check('**不**回用户名（这一步还没证明邮箱是你的）',
        response.text.includes('once-user') === false, response.text)
      const fresh = await call('/auth/code', { method: 'POST', body: { email: 'nobody@example.com' } })
      check('没注册过的邮箱不带这个标记', fresh.json?.alreadyRegistered === undefined, fresh.text)
    })


    await it('5.17：限流判定在纯函数里，而且**重启不会绕过**（靠库里的 issuedAt）', async () => {
      const { issueCode, CODE_INTERVAL_MS } = await import('../lib/accounts.mjs')
      const t0 = Date.parse('2026-01-01T00:00:00.000Z')
      const first = issueCode(emptyAccounts(), 'a@b.com', t0)
      check('第一次成功', first.ok === true && /^\d{6}$/.test(first.code), first.code)
      const tooSoon = issueCode(first.doc, 'a@b.com', t0 + 1000)
      check('1 秒后再要 → too-frequent', tooSoon.ok === false && tooSoon.code === 'too-frequent',
        JSON.stringify(tooSoon))
      check('还要等约 59 秒', Math.abs(tooSoon.retryAfterMs - (CODE_INTERVAL_MS - 1000)) < 5,
        String(tooSoon.retryAfterMs))
      const afterMinute = issueCode(first.doc, 'a@b.com', t0 + CODE_INTERVAL_MS)
      check('满 60 秒后可以再发', afterMinute.ok === true && afterMinute.code !== first.code,
        afterMinute.code)
      // "重启不会绕过"的证据：判定只依赖 doc 里的 issuedAt，没有进程内计时器
      const reloaded = JSON.parse(JSON.stringify(first.doc))
      const afterRestart = issueCode(reloaded, 'a@b.com', t0 + 5000)
      check('把 doc 存盘再读回来（模拟重启）仍然限流',
        afterRestart.ok === false && afterRestart.code === 'too-frequent', JSON.stringify(afterRestart))
    })

    await it('5.17：issuedAt 真的落在 auth_codes.issued_at 这一列（不再靠 TTL 反推）', async () => {
      const { issueCode, CODE_TTL_MS } = await import('../lib/accounts.mjs')
      const { LEGACY_CODE_TTL_MS, readAccountsDoc, writeAccountsDoc } = await import('../lib/accounts-store.mjs')
      const { dbPath, openDb } = await import('../lib/db.mjs')
      check('两个 TTL 常数必须相等（改一个忘了另一个，这里立刻红）',
        LEGACY_CODE_TTL_MS === CODE_TTL_MS, `${LEGACY_CODE_TTL_MS} vs ${CODE_TTL_MS}`)

      const dir = join(TMP, 'issued-at')
      // 故意取一个"不是整分钟"的时间：靠 `expiresAt - TTL` 反推也能算对，
      // 所以真正要钉的是**存储路径**（列里有值），不是算术。
      const t0 = Date.parse('2026-01-01T00:00:07.123Z')
      const first = issueCode(emptyAccounts(), 'c@d.com', t0)
      writeAccountsDoc(dir, first.doc)
      const back = readAccountsDoc(dir)
      check('读回来的 issuedAt 与发出时间一致',
        back.codes['c@d.com']?.issuedAt === new Date(t0).toISOString(),
        JSON.stringify(back.codes['c@d.com']))

      const db = openDb(dbPath(dir))
      const row = db.prepare('SELECT issued_at AS at FROM auth_codes WHERE email = ?').get('c@d.com')
      db.close()
      check('库里 issued_at 就是那个毫秒数（不是 NULL）', Number(row?.at) === t0, JSON.stringify(row))
    })

    await it('5.17：配了 SMTP 就真的发邮件，响应里**不带**验证码', async () => {
      const { startFakeSmtp } = await import('./fake-smtp.mjs')
      const smtp = await startFakeSmtp()
      const mailRelay = await startRelay({
        port: 0, host: '127.0.0.1', secret: 'mail-secret',
        dataDir: join(TMP, 'mail-dir'), inbox: join(TMP, 'mail-dir', 'asr-inbox.jsonl'),
        bus: join(TMP, 'mail-dir', 'subtitle-bus.json'), pollHoldMs: 200, busPollMs: 30, quiet: true,
        mailConfig: {
          host: '127.0.0.1', port: smtp.port, secure: false, starttls: false,
          user: '', pass: '', from: 'noreply@leion.test', fromName: '译连 TransLink', timeoutMs: 8000,
        },
      })
      try {
        const response = await fetch(`http://127.0.0.1:${mailRelay.port}/auth/code`, {
          method: 'POST',
          headers: { 'x-leion-secret': 'mail-secret', 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'mailbox@example.com' }),
        })
        const body = await response.json()
        check('200', response.status === 200, JSON.stringify(body))
        check('标明"已发送"（手机据此显示"已发到邮箱"）', body.sent === true, JSON.stringify(body))
        check('**响应里没有验证码**（配了邮件就不该把码给客户端）', body.code === undefined,
          JSON.stringify(body))
        check('假 SMTP 真的收到了一封信', smtp.messages.length === 1, String(smtp.messages.length))
        const mail = smtp.messages[0]
        check('收件人正确', mail.rcpt.includes('mailbox@example.com'), JSON.stringify(mail.rcpt))
        check('报文里有中文标题（RFC 2047 编码，不是乱码）',
          /^Subject: =\?UTF-8\?B\?/m.test(mail.data), mail.data.split('\r\n').slice(0, 4).join(' | '))
        // 正文是 base64：解出来必须含 6 位验证码
        const decoded = Buffer.from(
          (mail.data.split('\r\n\r\n')[1] ?? '').replace(/\r\n/g, ''), 'base64').toString('utf8')
        check('正文里带着 6 位验证码', /\b\d{6}\b/.test(decoded), decoded.slice(0, 120))
        check('登录用的就是这个码（发出去的与库里存的一致）', (() => {
          const m = /\b(\d{6})\b/.exec(decoded)
          return m !== null
        })())
      } finally {
        await mailRelay.close?.()
        await smtp.close()
      }
    })

    await it('5.17：邮件发不出去要**如实失败**（502），不能假装已发送', async () => {
      const { startFakeSmtp } = await import('./fake-smtp.mjs')
      const smtp = await startFakeSmtp({ rejectRcpt: true })
      const badRelay = await startRelay({
        port: 0, host: '127.0.0.1', secret: 'mail-secret2',
        dataDir: join(TMP, 'mail-bad'), inbox: join(TMP, 'mail-bad', 'asr-inbox.jsonl'),
        bus: join(TMP, 'mail-bad', 'subtitle-bus.json'), pollHoldMs: 200, busPollMs: 30, quiet: true,
        mailConfig: {
          host: '127.0.0.1', port: smtp.port, secure: false, starttls: false,
          user: '', pass: '', from: 'noreply@leion.test', fromName: '译连', timeoutMs: 8000,
        },
      })
      try {
        const response = await fetch(`http://127.0.0.1:${badRelay.port}/auth/code`, {
          method: 'POST',
          headers: { 'x-leion-secret': 'mail-secret2', 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'nobody@example.com' }),
        })
        const body = await response.json()
        check('502（发不出去就是失败，不是"已发送"）', response.status === 502, JSON.stringify(body))
        check('带机器码 mail-failed', body.error === 'mail-failed', JSON.stringify(body))
        check('并且回显服务器原话（排障要看得到原因）',
          String(body.hint ?? '').includes('550') || String(body.hint ?? '').length > 4, String(body.hint))
      } finally {
        await badRelay.close?.()
        await smtp.close()
      }
    })

    await it('token 无效 → 401；whoami 能确认身份；注销后立刻失效', async () => {
      const bad = await call('/terms', { token: 'deadbeef' })
      check('无效 token 401', bad.status === 401, bad.text)
      const login = await call('/auth/login', { method: 'POST', body: { username: 'alice', password: 'secret12' } })
      const who = await call('/auth/whoami', { token: login.json.token })
      check('whoami 认出 alice', who.status === 200 && who.json.user === 'alice', who.text)
      const out = await call('/auth/logout', { method: 'POST', token: login.json.token })
      check('注销成功', out.status === 200, out.text)
      const after = await call('/auth/whoami', { token: login.json.token })
      check('注销后 whoami 401', after.status === 401, after.text)
    })

    await it('密码错误 → 401，且不告诉我们"用户存不存在"', async () => {
      const wrongPass = await call('/auth/login', { method: 'POST', body: { username: 'alice', password: 'nope-nope' } })
      const noUser = await call('/auth/login', { method: 'POST', body: { username: 'nobody', password: 'nope-nope' } })
      check('都 401', wrongPass.status === 401 && noUser.status === 401)
      check('提示一致', wrongPass.json.hint === noUser.json.hint, wrongPass.json.hint + ' vs ' + noUser.json.hint)
    })

    await it('/status 报出"有没有账户"，手机据此决定显示登录还是注册', async () => {
      const status = await call('/status')
      check('accounts = true', status.json.accounts === true, status.text)
      check('有 authOk 计数', typeof status.json.authOk === 'number', status.text)
    })

    // 管理员要能停用/续期测试账号（docs/19：dev 账号默认 7 天过期）。
    // 两条都按**用户名**操作 —— 管理员手动建的账号没有邮箱。
    // 这里直接写盘建一个管理员：`POST /org/accounts` 需要管理员 token，先有鸡还是先有蛋。
    const admin = await (async () => {
      const doc = await loadAccounts(TMP)
      const created = createAccountWithPassword(doc, { username: 'boss', password: 'secret12', role: 'admin' })
      if (created.ok !== true) throw new Error(`建管理员失败：${created.error}`)
      await saveAccounts(TMP, created.doc)
      const res = await call('/auth/login', { method: 'POST', body: { username: 'boss', password: 'secret12' } })
      if (res.status !== 200) throw new Error(`管理员登录失败：${res.text}`)
      return res.json.token
    })()

    await it('停用后立刻登录不上；恢复后又能登录', async () => {
      const disabled = await call('/org/accounts/alice/status', { method: 'POST', token: admin, body: { status: 'disabled' } })
      check('停用接口 200', disabled.status === 200, disabled.text)
      const blocked = await call('/auth/login', { method: 'POST', body: { username: 'alice', password: 'secret12' } })
      check('停用后再登录被拒', blocked.status === 401, blocked.text)
      const restored = await call('/org/accounts/alice/status', { method: 'POST', token: admin, body: { status: 'active' } })
      check('恢复接口 200', restored.status === 200, restored.text)
      const again = await call('/auth/login', { method: 'POST', body: { username: 'alice', password: 'secret12' } })
      check('恢复后能登录', again.status === 200, again.text)
    })

    await it('续期把到期时间往后推；非法天数被拒', async () => {
      const renewed = await call('/org/accounts/alice/renew', { method: 'POST', token: admin, body: { days: 3 } })
      check('续期接口 200 且给出新到期时间',
        renewed.status === 200 && typeof renewed.json.expiresAt === 'string', renewed.text)
      check('新到期时间在未来', Date.parse(renewed.json.expiresAt) > Date.now(), renewed.json.expiresAt)
      const zero = await call('/org/accounts/alice/renew', { method: 'POST', token: admin, body: { days: 0 } })
      check('0 天被拒（否则"延长零天"看起来像生效了）', zero.status === 400, zero.text)
      const nobody = await call('/org/accounts/nobody/renew', { method: 'POST', token: admin, body: { days: 3 } })
      check('不存在的账号被拒', nobody.status === 400, nobody.text)
    })

    await it('/hello 带 token 时记下正确的用户（插件靠它取表）', async () => {
      const bob = await call('/auth/login', { method: 'POST', body: { username: 'bob', password: 'secret12' } })
      const hello = await call('/hello', { token: bob.json.token })
      check('握手成功', hello.status === 200, hello.text)
      const status = await call('/status')
      check('当前用户是 bob', status.json.termsUser === 'bob', status.text)
    })
  } finally {
    await relay.close()
  }
}
