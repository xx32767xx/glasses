/**
 * org-api-suite.mjs —— 术语库/选库/申请审批的接口契约（权限是重点）
 * ============================================================================
 *
 * 这一套守的是"**谁能调什么**"，而不是"功能能不能跑"：
 *   · 用户不能调管理员接口（拿 403，而不是"界面没显示按钮"）；
 *   · 申请人 / 审批人一律由**服务端从 token 解出**，请求体里自报的名字必须被忽略；
 *   · 会议 id 会被拼进路径，必须挡目录穿越；
 *   · 选库是"会议级"的，空数组表示"什么都不启用"，不能被当成"默认全部"。
 */

import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { VAR_DIR } from '../lib/paths.mjs'
import { resolveDataDir } from '../lib/store.mjs'
import { addCategory, emptyCategories, loadLibrary, listLibraries, loadCategories, saveCategories } from '../lib/libraries.mjs'
import { loadRequests } from '../lib/requests.mjs'
import { handleOrg, loadSelection, selectionPath } from '../relay/org-api.mjs'

const BASE = join(VAR_DIR, 'test', 'org-api-suite')
const ENTRY = (zh, pt) => ({ zh, pt })

export async function runOrgApiSuite({ it, check, assert }) {
  await rm(BASE, { recursive: true, force: true })
  const root = resolveDataDir(BASE, 'test')
  await mkdir(root, { recursive: true })

  // 准备：一个分类 + 两个库（不同优先级）
  let categories = emptyCategories()
  const category = addCategory(categories, '出口贸易')
  categories = category.doc
  await saveCategories(root, categories)
  const seed = async () => {
    const { saveLibrary } = await import('../lib/libraries.mjs')
    await saveLibrary(root, { id: 'lib-a', name: '拉美专名', categoryId: category.category.id, priority: 10,
      entries: [ENTRY('亮亮眼镜', 'Leion'), ENTRY('高通', 'Qualcomm')] }, { by: 'boss@example.com' })
    await saveLibrary(root, { id: 'lib-b', name: '法务术语', categoryId: category.category.id, priority: 20,
      entries: [ENTRY('安卓', 'Android')] }, { by: 'boss@example.com' })
  }
  await seed()

  const call = (options) => handleOrg({ root, ...options })

  await it('未登录一律 401（没有 token 就没有 user）', async () => {
    const anonymous = await call({ method: 'GET', path: '/org/libraries', user: null, role: null })
    check('没登录 → 401', anonymous.status === 401, String(anonymous.status))
  })

  await it('库列表：三种角色都能读，但只有管理员能改', async () => {
    for (const role of ['admin', 'user', 'dev']) {
      const listed = await call({ method: 'GET', path: '/org/libraries', user: `${role}@example.com`, role })
      check(`${role} 能读库列表`, listed.status === 200 && listed.json.libraries.length === 2,
        `${listed.status} ${listed.json.libraries?.length}`)
      check(`${role} 看到的库不包含条目正文（列表只给摘要）`,
        listed.json.libraries.every((library) => library.entries === undefined || typeof library.entries === 'number'))
    }
    const userWrite = await call({
      method: 'PUT', path: '/org/libraries/lib-a', user: 'alice@example.com', role: 'user',
      body: { library: { name: '拉美专名', priority: 10, entries: [ENTRY('亮亮眼镜', 'Leion')] } },
    })
    check('用户改库 → 403（不是"界面没按钮"就算安全）', userWrite.status === 403, String(userWrite.status))
    const devWrite = await call({
      method: 'PUT', path: '/org/libraries/lib-a', user: 'dev@example.com', role: 'dev',
      body: { library: { name: '拉美专名', priority: 10, entries: [ENTRY('亮亮眼镜', 'Leion')] } },
    })
    check('测试账号改库 → 403（只读）', devWrite.status === 403, String(devWrite.status))
  })

  await it('会议 id 会被拼进路径：必须挡目录穿越', () => {
    let raised = ''
    try {
      selectionPath(root, '../../etc')
    } catch (error) {
      raised = String(error.message)
    }
    check('带斜杠/点点的会议 id 直接拒绝', raised.includes('只能包含'), raised)
    check('正常 id 能生成路径', selectionPath(root, 'room-001').includes('room-001'))
  })

  await it('选库是会议级的：空数组 = 什么都不启用（不是"默认全部"）', async () => {
    const saved = await call({
      method: 'PUT', path: '/org/meeting/room-001/libraries', user: 'boss@example.com', role: 'admin',
      body: { libraryIds: [] },
    })
    check('保存空选择成功', saved.status === 200, saved.json.error)
    const read = await call({ method: 'GET', path: '/org/meeting/room-001/libraries', user: 'boss@example.com', role: 'admin' })
    check('读回来就是空', read.status === 200 && read.json.libraryIds.length === 0, JSON.stringify(read.json.libraryIds))
    const snapshot = await call({
      method: 'POST', path: '/org/meeting/room-001/snapshot', user: 'boss@example.com', role: 'admin', body: {},
    })
    check('空选择生成的快照是 0 条', snapshot.status === 200 && snapshot.json.entries === 0,
      String(snapshot.json.entries))

    const picked = await call({
      method: 'PUT', path: '/org/meeting/room-001/libraries', user: 'boss@example.com', role: 'admin',
      body: { libraryIds: ['lib-a', 'lib-b'] },
    })
    check('选两个库成功', picked.status === 200, picked.json.error)
    const withEntries = await call({
      method: 'POST', path: '/org/meeting/room-001/snapshot', user: 'boss@example.com', role: 'admin', body: {},
    })
    check('快照按 selection 出条目（3 条）', withEntries.json.entries === 3, String(withEntries.json.entries))
    check('快照路径在 meetings/<id>/ 下', String(withEntries.json.termsPath).includes('meetings'), withEntries.json.termsPath)
    const stored = await loadSelection(root, 'room-001')
    check('选择被落盘并记下是谁选的', stored.libraryIds.length === 2 && stored.selectedBy === 'boss@example.com')
  })

  await it('选不存在的库要报错（不能静默忽略）', async () => {
    const bad = await call({
      method: 'PUT', path: '/org/meeting/room-002/libraries', user: 'boss@example.com', role: 'admin',
      body: { libraryIds: ['lib-a', 'lib-nope'] },
    })
    check('400 且指出哪个库不存在', bad.status === 400 && bad.json.error.includes('lib-nope'), bad.json.error)
  })

  await it('申请：申请人来自 token，请求体里自报的名字被忽略', async () => {
    const created = await call({
      method: 'POST', path: '/org/requests', user: 'alice@example.com', role: 'user',
      body: { type: 'add', libraryId: 'lib-a', zh: '骁龙 8 Gen 3', pt: 'Snapdragon 8 Gen 3',
        reason: '客户指定', applicant: 'boss@example.com' },
    })
    check('提交成功', created.status === 200, created.json.error)
    const { items } = await loadRequests(root)
    const item = [...items.values()].find((entry) => entry.id === created.json.id)
    check('申请人被记为 token 对应的用户（不是请求体里的）',
      item.applicant === 'alice@example.com', item.applicant)
  })

  await it('审批列表与审批动作只对管理员开放', async () => {
    const userPending = await call({ method: 'GET', path: '/org/requests/pending', user: 'alice@example.com', role: 'user' })
    check('用户看不了待审列表 → 403', userPending.status === 403, String(userPending.status))
    const adminPending = await call({ method: 'GET', path: '/org/requests/pending', user: 'boss@example.com', role: 'admin' })
    check('管理员能看，且看到 1 条', adminPending.status === 200 && adminPending.json.requests.length === 1,
      String(adminPending.json.requests?.length))

    const id = adminPending.json.requests[0].id
    const userDecide = await call({
      method: 'POST', path: `/org/requests/${id}/decide`, user: 'alice@example.com', role: 'user',
      body: { decision: 'approve' },
    })
    check('用户自己批自己的申请 → 403', userDecide.status === 403, String(userDecide.status))

    const approved = await call({
      method: 'POST', path: `/org/requests/${id}/decide`, user: 'boss@example.com', role: 'admin',
      body: { decision: 'approve', note: '同意' },
    })
    check('管理员通过成功', approved.status === 200, approved.json.error)
    const library = await loadLibrary(root, 'lib-a')
    check('通过后条目的确写进了库', (library.entries ?? []).some((entry) => entry.zh === '骁龙 8 Gen 3'),
      library.entries.map((entry) => entry.zh).join(','))
    check('返回里带上了库的新条目数', approved.json.entries === 3, String(approved.json.entries))

    const again = await call({
      method: 'POST', path: `/org/requests/${id}/decide`, user: 'boss@example.com', role: 'admin',
      body: { decision: 'approve' },
    })
    check('重复审批 → 400', again.status === 400, String(again.status))
  })

  await it('我的申请：只看得到自己的，且状态可读', async () => {
    const mine = await call({ method: 'GET', path: '/org/requests/mine', user: 'alice@example.com', role: 'user' })
    check('我的申请 1 条且已通过', mine.status === 200 && mine.json.requests.length === 1
      && mine.json.requests[0].status === 'approved', JSON.stringify(mine.json.requests?.[0]?.status))
    const other = await call({ method: 'GET', path: '/org/requests/mine', user: 'bob@example.com', role: 'user' })
    check('别人看不到我的申请', other.status === 200 && other.json.requests.length === 0)
  })

  await it('测试账号（dev）：能读、不能提申请', async () => {
    const read = await call({ method: 'GET', path: '/org/libraries/lib-a', user: 'dev@example.com', role: 'dev' })
    check('dev 能读单个库', read.status === 200)
    const write = await call({
      method: 'POST', path: '/org/requests', user: 'dev@example.com', role: 'dev',
      body: { type: 'add', libraryId: 'lib-a', zh: '测试项', pt: 'Test', reason: '看看' },
    })
    // 4.63：dev 也能提申请了（见 library-suite 里那条权限断言）。仍然是"提申请"，
  // 写库还是要 admin 审批。
  check('dev 提申请 → 200（待管理员审批）', write.status === 200, String(write.status))
  })

  await it('4.64：已有结论的申请可以自己删掉（待审批的不行）', async () => {
    // alice 那条已经 approved，可以删；先试“拿别人的去删”
    const mine = await call({ method: 'GET', path: '/org/requests/mine', user: 'alice@example.com', role: 'user' })
    const id = mine.json.requests[0].id
    const otherTry = await call({
      method: 'POST', path: `/org/requests/${id}/delete`, user: 'bob@example.com', role: 'user' })
    check('删不了别人的申请', otherTry.status === 400, String(otherTry.status))

    const hidden = await call({
      method: 'POST', path: `/org/requests/${id}/delete`, user: 'alice@example.com', role: 'user' })
    check('自己已审批的能删', hidden.status === 200, hidden.json.error)
    const after = await call({ method: 'GET', path: '/org/requests/mine', user: 'alice@example.com', role: 'user' })
    check('删后列表里不再出现', after.json.requests.length === 0,
      JSON.stringify(after.json.requests))

    // 待审批的必须先撤回，不能直接删（否则管理员那边会凭空少一条）
    const created = await call({
      method: 'POST', path: '/org/requests', user: 'bob@example.com', role: 'user',
      body: { type: 'add', libraryId: 'lib-a', zh: '蓝牙配对', pt: 'Pareamento Bluetooth', reason: '补一条' },
    })
    const pendingId = created.json.id
    const pendingDelete = await call({
      method: 'POST', path: `/org/requests/${pendingId}/delete`, user: 'bob@example.com', role: 'user' })
    check('待审批的不能直接删', pendingDelete.status === 400, String(pendingDelete.status))
    const withdrew = await call({
      method: 'POST', path: `/org/requests/${pendingId}/withdraw`, user: 'bob@example.com', role: 'user' })
    check('先撤回成功', withdrew.status === 200, withdrew.json.error)
    const deleteAfterWithdraw = await call({
      method: 'POST', path: `/org/requests/${pendingId}/delete`, user: 'bob@example.com', role: 'user' })
    check('撤回后可以删', deleteAfterWithdraw.status === 200, deleteAfterWithdraw.json.error)
  })

  await it('4.69：历史记录只给自己参加过的，并带齐卡片要的六样', async () => {
    const created = await call({
      method: 'POST', path: '/org/rooms', user: 'alice@example.com', role: 'user',
      body: { name: '圣保罗洽谈', lang: 'zh-CN' },
    })
    check('建房成功', created.status === 200, created.json.error)
    const code = created.json.room.code
    await call({ method: 'POST', path: '/org/rooms/join', user: 'bob@example.com', role: 'user',
      body: { code, lang: 'pt-BR' } })

    // 发起者退出 = 散会（closed_at 有值），这才是历史里要看的"已结束"会议
    const left = await call({ method: 'POST', path: '/org/rooms/leave',
      user: 'alice@example.com', role: 'user', body: { roomId: created.json.room.id } })
    check('散会成功', left.status === 200, left.json.error)

    const mine = await call({ method: 'GET', path: '/org/history', user: 'alice@example.com', role: 'user' })
    check('自己看得到', mine.status === 200 && mine.json.items.length === 1,
      JSON.stringify(mine.json.items?.length))
    const item = mine.json.items[0]
    check('名字对', item.name === '圣保罗洽谈', item.name)
    check('类型只有 meeting', item.kind === 'meeting', item.kind)
    check('人数是过去进过的人（2）', item.members === 2, String(item.members))
    check('语言去重且排好序', JSON.stringify(item.langs) === JSON.stringify(['pt-BR', 'zh-CN']),
      JSON.stringify(item.langs))
    check('已结束（不是 active）', item.active === false)
    check('时长是个数且≥ 0', typeof item.durationSeconds === 'number' && item.durationSeconds >= 0)
    check('字幕保存期由服务端给', mine.json.retentionDays === 7, String(mine.json.retentionDays))

    // ⑤ 4.71：按账号删除 —— alice 删了自己的，旁人的历史不受影响
    const deleted = await call({ method: 'POST', path: `/org/history/${item.id}/delete`,
      user: 'alice@example.com', role: 'user' })
    check('自己能删', deleted.status === 200, deleted.json.error)
    const afterDelete = await call({ method: 'GET', path: '/org/history', user: 'alice@example.com', role: 'user' })
    check('删后自己的列表空了', afterDelete.json.items.length === 0,
      JSON.stringify(afterDelete.json.items?.length))
    const bobAfter = await call({ method: 'GET', path: '/org/history', user: 'bob@example.com', role: 'user' })
    check('别人的历史不受影响', bobAfter.json.items.length === 1,
      JSON.stringify(bobAfter.json.items?.length))
    const strangerDelete = await call({ method: 'POST', path: `/org/history/${item.id}/delete`,
      user: 'boss@example.com', role: 'admin' })
    check('没参加过的人不能往自己列表里去掉它',
      strangerDelete.status === 400, String(strangerDelete.status))

    const bob = await call({ method: 'GET', path: '/org/history', user: 'bob@example.com', role: 'user' })
    check('参会者也看得到', bob.json.items.length === 1, JSON.stringify(bob.json.items?.length))
    const stranger = await call({ method: 'GET', path: '/org/history', user: 'boss@example.com', role: 'admin' })
    check('没参加过的人看不到', stranger.json.items.length === 0,
      JSON.stringify(stranger.json.items?.length))
  })

  await it('管理员批量导入走同一套校验（一条坏数据不拖垮整批）', async () => {
    const imported = await call({
      method: 'POST', path: '/org/libraries/import', user: 'boss@example.com', role: 'admin',
      body: { items: [
        { id: 'lib-c', name: '国际物流', priority: 5, entries: [ENTRY('圣保罗', 'São Paulo')] },
        { id: 'lib-d', name: '坏条目', priority: 5, entries: [{ zh: '', pt: '' }] },
      ] },
    })
    check('导入返回 1 成 1 败', imported.status === 200 && imported.json.created === 1
      && imported.json.rejected.length === 1, JSON.stringify(imported.json.rejected))
    const libraries = await listLibraries(root)
    check('库里现在 3 个（新加 lib-c）', libraries.length === 3, libraries.map((library) => library.id).join(','))
  })

  await it('未知接口返回 404（不静默成功）', async () => {
    const nope = await call({ method: 'GET', path: '/org/nope', user: 'boss@example.com', role: 'admin' })
    check('404', nope.status === 404, String(nope.status))
  })

  await rm(BASE, { recursive: true, force: true })
}

export { loadCategories }
