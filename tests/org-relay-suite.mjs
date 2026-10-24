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
import { createAccount, loadAccounts, saveAccounts } from '../lib/accounts.mjs'
import { startRelay } from '../relay/lan-relay.mjs'

const BASE = join(VAR_DIR, 'test', 'org-relay-suite')

export async function runOrgRelaySuite({ it, check, assert }) {
  await rm(BASE, { recursive: true, force: true })
  await mkdir(BASE, { recursive: true })

  // 预置一个管理员（管理员账号由"人"创建，不走验证码注册）
  const doc = await loadAccounts(BASE)
  const admin = createAccount(doc, 'boss@example.com', { role: 'admin' })
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
    await it('邮箱验证码：取码 → 登录 → 拿到 token 与角色', async () => {
      const issued = await (await post('/auth/code', { email: 'boss@example.com' })).json()
      check('取码成功', issued.ok === true, JSON.stringify(issued))
      check('局域网模式会把码回给调用方（没有邮件通道时的唯一办法）',
        typeof issued.code === 'string' && /^\d{6}$/.test(issued.code), String(issued.code))
      const logged = await (await post('/auth/login-email', { email: 'boss@example.com', code: issued.code })).json()
      check('登录成功并返回 token', logged.ok === true && typeof logged.token === 'string', JSON.stringify(logged))
      check('管理员拿到的是 admin 角色', logged.role === 'admin', String(logged.role))
      const whoami = await (await get('/auth/whoami', logged.token)).json()
      check('whoami 也带角色（界面据此显示管理端）', whoami.ok === true && whoami.role === 'admin', JSON.stringify(whoami))
      globalThis.__adminToken = logged.token
    })

    await it('同一个验证码不能登录两次', async () => {
      const issued = await (await post('/auth/code', { email: 'boss@example.com' })).json()
      await post('/auth/login-email', { email: 'boss@example.com', code: issued.code })
      const again = await (await post('/auth/login-email', { email: 'boss@example.com', code: issued.code })).json()
      check('第二次用同一个码 → 401', again.ok !== true, JSON.stringify(again))
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

      // 造一个普通用户：新邮箱首次登录即注册
      const userCode = await (await post('/auth/code', { email: 'alice@example.com' })).json()
      const userLogin = await (await post('/auth/login-email', { email: 'alice@example.com', code: userCode.code })).json()
      check('普通用户登录成功且角色是 user', userLogin.ok === true && userLogin.role === 'user', String(userLogin.role))
      const userImport = await post('/org/libraries/import', {
        items: [{ name: '用户不该能建', priority: 1, entries: [{ zh: 'x', pt: 'y' }] }],
      }, userLogin.token)
      check('普通用户导入 → 403', userImport.status === 403, String(userImport.status))
      const userRead = await get('/org/libraries', userLogin.token)
      check('普通用户能读库列表', userRead.status === 200, String(userRead.status))

      const adminPage = await get('/admin')
      const html = await adminPage.text()
      check('/admin 返回 HTML（不是 JSON 404）', adminPage.status === 200 && html.includes('术语库管理台'),
        String(adminPage.status))
    })

    await it('用户提申请 → 管理员审批 → 库里真的有这条', async () => {
      const adminToken = globalThis.__adminToken
      const userCode = await (await post('/auth/code', { email: 'alice@example.com' })).json()
      const userLogin = await (await post('/auth/login-email', { email: 'alice@example.com', code: userCode.code })).json()
      const created = await (await post('/org/requests', {
        type: 'add', libraryId: 'lib-relay', zh: '高通', pt: 'Qualcomm', reason: '客户要求',
        applicant: 'boss@example.com', // 冒充管理员：必须被忽略
      }, userLogin.token)).json()
      check('申请提交成功', created.ok === true, JSON.stringify(created))

      const pending = await (await get('/org/requests/pending', adminToken)).json()
      check('管理员看到 1 条待审', pending.ok === true && pending.requests.length === 1, String(pending.requests?.length))
      check('申请人记的是 token 用户（不是请求体里冒充的那个）',
        pending.requests[0].applicant === 'alice@example.com', pending.requests[0].applicant)

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
