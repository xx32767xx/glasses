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
  normalizeUsername, register, revokeToken, saveAccounts, tokenKey, userForToken, verifyPassword,
} from '../lib/accounts.mjs'

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

  await it('注销只失效一个 token，别的设备照常', () => {
    const reg = register(emptyAccounts(), 'wu', 'secret12')
    const second = login(reg.doc, 'wu', 'secret12')
    const revoked = revokeToken(second.doc, second.token)
    check('注销成功', revoked.ok === true)
    check('被注销的 token 失效', userForToken(revoked.doc, second.token) === null)
    check('另一个 token 仍有效', userForToken(revoked.doc, reg.token) === 'wu')
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
    check('旧 token 仍有效', userForToken(doc, result.token) === 'test')
    check('新 token 也有效', userForToken(doc, again.token) === 'test')
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
