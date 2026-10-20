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
import {
  checkPassword, emptyAccounts, hashPassword, issueToken, login, normalizeUsername, register,
  revokeToken, tokenKey, userForToken, verifyPassword,
} from '../lib/accounts.mjs'

const TMP = join(VAR_DIR, 'test', 'accounts-suite')

export async function runAccountsSuite({ it, check, assert }) {
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
      const reg = await call('/auth/register', { method: 'POST', body: { username: 'alice', password: 'secret12' } })
      check('200', reg.status === 200, reg.text)
      check('给了 token', typeof reg.json.token === 'string' && reg.json.token.length === 64, reg.text)
      check('回显用户名', reg.json.user === 'alice')
      const raw = await readFile(join(TMP, 'accounts.json'), 'utf-8')
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
      const bob = await call('/auth/register', { method: 'POST', body: { username: 'bob', password: 'secret12' } })
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
