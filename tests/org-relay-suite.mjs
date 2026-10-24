/**
 * org-relay-suite.mjs —— relay 上的 /org 与 /auth（邮箱验证码）端到端
 * ============================================================================
 *
 * 与 org-api-suite（纯函数）互补：这一套验的是"**真的走 HTTP 时**"那几件事：
 *   · token 从请求头解出身份，角色决定能不能调管理员接口；
 *   · /auth/code 与 /auth/login-email 能让管理员真的拿到 token；
 *   · /admin 页面能被取到（它就是真实接口的客户端，不是另一个假后端）。
 */

import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { VAR_DIR } from '../lib/paths.mjs'
import { createAccountWithPassword, loadAccounts, saveAccounts } from '../lib/accounts.mjs'
import { startRelay } from '../relay/lan-relay.mjs'

const BASE = join(VAR_DIR, 'test', 'org-relay-suite')

export async function runOrgRelaySuite({ it, check, assert }) {
  await rm(BASE, { recursive: true, force: true })
  await mkdir(BASE, { recursive: true })

  // 预置一个管理员（管理员账号由"人"创建，不走验证码注册）
  const doc = await loadAccounts(BASE)
  // 管理员也是"人建的"，但登录要用户名+密码，所以这里用带密码的建号接口
  const admin = createAccountWithPassword(doc, { username: 'boss', password: 'secret12', role: 'admin' })
  await saveAccounts(BASE, admin.doc)

  const relay = await startRelay({ dataDir: BASE, port: 0, secret: 'test-secret', quiet: true })
  const base = `http://127.0.0.1:${relay.port}`
  // relay 的老规矩：除少数端点外都要带共享密钥（X-Leion-Secret）。token 是在它之上的一层身份。
  const secretHeader = { 'x-leion-secret': 'test-secret' }
  const post = (path, body, token) => fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...secretHeader, ...(token ? { 'x-leion-token': token } : {}) },
    body: JSON.stringify(body ?? {}),
  })
  const get = (path, token) => fetch(base + path, {
    headers: { ...secretHeader, ...(token ? { 'x-leion-token': token } : {}) },
  })

  try {
    await it('管理员登录：用户名 + 密码（不发验证码）', async () => {
      // 管理员是"人"建的（CLI/管理端），不是自己注册的；登录只要用户名+密码。
      const logged = await (await post('/auth/login', { username: 'boss', password: 'secret12' })).json()
      check('登录成功并返回 token', logged.ok === true && typeof logged.token === 'string', JSON.stringify(logged))
      check('管理员拿到的是 admin 角色', logged.role === 'admin', String(logged.role))
      const whoami = await (await get('/auth/whoami', logged.token)).json()
      check('whoami 也带角色（界面据此显示管理端）', whoami.ok === true && whoami.role === 'admin', JSON.stringify(whoami))
      globalThis.__adminToken = logged.token
    })

    await it('注册：邮箱 + 用户名 + 密码 + 验证码（四样都要）', async () => {
      const issued = await (await post('/auth/code', { email: 'alice@example.com' })).json()
      check('取码成功', issued.ok === true, JSON.stringify(issued))
      check('局域网模式会把码回给调用方（没有邮件通道时的唯一办法）',
        typeof issued.code === 'string' && /^\d{6}$/.test(issued.code), String(issued.code))

      const noCode = await (await post('/auth/register-email', {
        email: 'alice@example.com', username: 'alice', password: 'secret12', code: '000000',
      })).json()
      check('验证码不对 → 注册失败', noCode.ok !== true, JSON.stringify(noCode))

      const registered = await (await post('/auth/register-email', {
        email: 'alice@example.com', username: 'alice', password: 'secret12', code: issued.code,
      })).json()
      check('四样齐全 → 注册成功并直接给 token',
        registered.ok === true && typeof registered.token === 'string', JSON.stringify(registered))
      check('新用户角色是 user', registered.role === 'user', String(registered.role))

      const again = await (await post('/auth/register-email', {
        email: 'bob@example.com', username: 'alice', password: 'secret12', code: '123456',
      })).json()
      check('用户名重复 → 拒绝（换邮箱也不行）', again.ok !== true, JSON.stringify(again))

      const loginAgain = await (await post('/auth/login', { username: 'alice', password: 'secret12' })).json()
      check('注册之后可以用用户名+密码登录（不要求邮箱）', loginAgain.ok === true, JSON.stringify(loginAgain))
    })

    await it('管理员手动加测试账号（dev，只读、默认 7 天过期）', async () => {
      const adminToken = globalThis.__adminToken
      const created = await (await post('/org/accounts', {
        username: 'dev1', password: 'secret12',
      }, adminToken)).json()
      check('建号成功', created.ok === true && created.role === 'dev', JSON.stringify(created))
      const listed = await (await get('/org/accounts', adminToken)).json()
      check('列表里能看到它', (listed.accounts ?? []).some((item) => item.username === 'dev1'))
      check('列表不含密码哈希（只给能看的字段）',
        !JSON.stringify(listed.accounts).includes('"hash"'), JSON.stringify(listed.accounts?.[0] ?? {}))
      const devLogin = await (await post('/auth/login', { username: 'dev1', password: 'secret12' })).json()
      check('测试账号能用用户名+密码登录', devLogin.ok === true && devLogin.role === 'dev', JSON.stringify(devLogin))
    })

    await it('同一个验证码不能用两次', async () => {
      const issued = await (await post('/auth/code', { email: 'carol@example.com' })).json()
      const first = await (await post('/auth/register-email', {
        email: 'carol@example.com', username: 'carol', password: 'secret12', code: issued.code,
      })).json()
      check('第一次注册成功', first.ok === true, JSON.stringify(first))
      const again = await (await post('/auth/register-email', {
        email: 'carol2@example.com', username: 'carol2', password: 'secret12', code: issued.code,
      })).json()
      check('同一个码第二次用 → 拒绝', again.ok !== true, JSON.stringify(again))
    })

    await it('无 token 调 /org 接口 → 401', async () => {
      const response = await get('/org/libraries')
      check('401', response.status === 401, String(response.status))
    })

    await it('管理员能导入库、用户不能；页面 /admin 可取', async () => {
      const adminToken = globalThis.__adminToken
      const imported = await (await post('/org/libraries/import', {
        items: [{ id: 'lib-relay', name: '中继库', priority: 5, entries: [{ zh: '亮亮眼镜', pt: 'Leion' }] }],
      }, adminToken)).json()
      check('管理员导入成功', imported.ok === true && imported.created === 1, JSON.stringify(imported))

      // 普通用户：用上一步注册好的 alice 登录（用户名+密码）
      const userLogin = await (await post('/auth/login', { username: 'alice', password: 'secret12' })).json()
      check('普通用户登录成功且角色是 user', userLogin.ok === true && userLogin.role === 'user', String(userLogin.role))
      const userImport = await post('/org/libraries/import', {
        items: [{ name: '用户不该能建', priority: 1, entries: [{ zh: 'x', pt: 'y' }] }],
      }, userLogin.token)
      check('普通用户导入 → 403', userImport.status === 403, String(userImport.status))
      const userRead = await get('/org/libraries', userLogin.token)
      check('普通用户能读库列表', userRead.status === 200, String(userRead.status))

      const adminPage = await get('/admin')
      const html = await adminPage.text()
      check('/admin 返回 HTML（不是 JSON 404）', adminPage.status === 200 && html.includes('术语库管理控制台'),
        String(adminPage.status))
    })

    await it('用户提申请 → 管理员审批 → 库里真的有这条', async () => {
      const adminToken = globalThis.__adminToken
      const userLogin = await (await post('/auth/login', { username: 'alice', password: 'secret12' })).json()
      const created = await (await post('/org/requests', {
        type: 'add', libraryId: 'lib-relay', zh: '高通', pt: 'Qualcomm', reason: '客户要求',
        applicant: 'boss', // 冒充管理员：必须被忽略
      }, userLogin.token)).json()
      check('申请提交成功', created.ok === true, JSON.stringify(created))

      const pending = await (await get('/org/requests/pending', adminToken)).json()
      check('管理员看到 1 条待审', pending.ok === true && pending.requests.length === 1, String(pending.requests?.length))
      check('申请人记的是 token 用户（不是请求体里冒充的那个）',
        pending.requests[0].applicant === 'alice', pending.requests[0].applicant)

      const decided = await (await post(`/org/requests/${pending.requests[0].id}/decide`,
        { decision: 'approve' }, adminToken)).json()
      check('审批通过', decided.ok === true && decided.entries === 2, JSON.stringify(decided))

      const libraries = await (await get('/org/libraries/lib-relay', adminToken)).json()
      check('库里出现了新条目', libraries.library.entries.some((entry) => entry.zh === '高通'))
    })
  } finally {
    await relay.close()
    await rm(BASE, { recursive: true, force: true })
  }
}
