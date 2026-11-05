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
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { VAR_DIR } from '../lib/paths.mjs'
import { resolveDataDir } from '../lib/store.mjs'
import { addCategory, emptyCategories, loadLibrary, listLibraries, loadCategories, saveCategories } from '../lib/libraries.mjs'
import { loadRequests } from '../lib/requests.mjs'
import * as api from '../relay/org-api.mjs'
import { handleOrg, loadSelection, selectionPath } from '../relay/org-api.mjs'
import {
  mergeStrategies, parseJsonLoose, setLanguageModel, describeKeyShape,
  setLanguageTuning, setLanguageSegmentation, clearLanguageTuning, resolveEffective,
  setDefaultSegmentation, setDefaultTuning, SEGMENTATION_DEFAULTS,
} from '../lib/asr-engines.mjs'

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

  await it('5.16：管理台的房间级操作 —— 结束会议 / 移出成员（权限是关键）', async () => {
    const { createRoom, joinRoom, listMembers, isRoomClosed } = await import('../lib/rooms.mjs')
    const created = createRoom(root, { name: '管理台测试会', host: 'alice@example.com' })
    const roomId = created.room.id
    joinRoom(root, { roomId, username: 'alice@example.com', lang: 'zh-CN' })
    joinRoom(root, { roomId, username: 'bob@example.com', lang: 'pt-BR' })

    // ① 普通成员不能结束别人的会议（403，而不是"按钮没显示"）
    const userClose = await call({ method: 'POST', path: `/org/rooms/${roomId}/close`,
      user: 'bob@example.com', role: 'user' })
    check('普通成员结束会议 → 403', userClose.status === 403, String(userClose.status))
    check('而且会议没有被结束', isRoomClosed(root, roomId) === false)

    // ② 管理员可以：结束 + 成员全部离开 + 麦清空
    const adminClose = await call({ method: 'POST', path: `/org/rooms/${roomId}/close`,
      user: 'boss@example.com', role: 'admin' })
    check('管理员结束会议 → 200', adminClose.status === 200, JSON.stringify(adminClose.json))
    check('房间标记为已结束', isRoomClosed(root, roomId) === true)
    check('成员都被记为已离开（人数立刻变 0）', listMembers(root, roomId).length === 0,
      JSON.stringify(listMembers(root, roomId).map((m) => m.username)))
    const again = await call({ method: 'POST', path: `/org/rooms/${roomId}/close`,
      user: 'boss@example.com', role: 'admin' })
    check('重复结束是幂等的（不报错）', again.status === 200 && again.json.alreadyClosed === true,
      JSON.stringify(again.json))

    // ③ 管理员也能**移出成员**（提示语里的"仅发起者"不再对管理台成立）
    const second = createRoom(root, { name: '移人测试会', host: 'carol@example.com' })
    const room2 = second.room.id
    joinRoom(root, { roomId: room2, username: 'carol@example.com' })
    joinRoom(root, { roomId: room2, username: 'dave@example.com' })
    const userKick = await call({ method: 'POST', path: `/org/rooms/${room2}/members/remove`,
      user: 'dave@example.com', role: 'user', body: { user: 'carol@example.com' } })
    check('普通成员踢别人 → 403', userKick.status === 403, String(userKick.status))
    const adminKick = await call({ method: 'POST', path: `/org/rooms/${room2}/members/remove`,
      user: 'boss@example.com', role: 'admin', body: { user: 'dave@example.com' } })
    check('管理员踢人 → 200', adminKick.status === 200, JSON.stringify(adminKick.json))
    check('被踢的人不在成员表里了',
      listMembers(root, room2).every((m) => m.username !== 'dave@example.com'),
      JSON.stringify(listMembers(root, room2).map((m) => m.username)))
    // 发起者仍然可以踢（老规则不能因为管理员通道而丢掉）
    joinRoom(root, { roomId: room2, username: 'erin@example.com' })
    const hostKick = await call({ method: 'POST', path: `/org/rooms/${room2}/members/remove`,
      user: 'carol@example.com', role: 'user', body: { user: 'erin@example.com' } })
    check('发起者踢人仍然可以', hostKick.status === 200, JSON.stringify(hostKick.json))
  })

  await it('5.15：房间详情/列表带上"翻译管线"状态（服务器满了要让手机看见）', async () => {
    const { createRoom, joinRoom } = await import('../lib/rooms.mjs')
    const created = createRoom(root, { name: '排队会', host: 'alice@example.com' })
    joinRoom(root, { roomId: created.room.id, username: 'alice@example.com', lang: 'zh-CN' })
    const pipeline = { roomId: created.room.id, state: 'denied', reason: 'max-rooms', maxRooms: 1 }
    const withPipeline = (options) => handleOrg({
      root, ...options,
      pipelineOf: (roomId) => (roomId === created.room.id ? pipeline : null),
    })
    const detail = await withPipeline({ method: 'GET', path: `/org/rooms/${created.room.id}`,
      user: 'alice@example.com', role: 'user' })
    check('详情里带 pipeline', detail.json.pipeline?.state === 'denied', JSON.stringify(detail.json.pipeline))
    check('并且带着上限（手机要显示"N 场"）', detail.json.pipeline?.maxRooms === 1,
      JSON.stringify(detail.json.pipeline))
    const listed = await withPipeline({ method: 'GET', path: '/org/rooms', user: 'boss@example.com', role: 'admin' })
    const row = (listed.json.rooms ?? []).find((room) => room.id === created.room.id)
    check('列表里也带（管理台要看"运行中的会议"）', row?.pipeline?.state === 'denied',
      JSON.stringify(row?.pipeline))
    // 没有侧车时不能编一个状态出来
    const plain = await call({ method: 'GET', path: `/org/rooms/${created.room.id}`,
      user: 'alice@example.com', role: 'user' })
    check('没有侧车 → pipeline 为 null（不编状态）', plain.json.pipeline === null,
      JSON.stringify(plain.json.pipeline))
  })

  await it('未知接口返回 404（不静默成功）', async () => {
    const nope = await call({ method: 'GET', path: '/org/nope', user: 'boss@example.com', role: 'admin' })
    check('404', nope.status === 404, String(nope.status))
  })

  // ── 5.108：房间侧车整层删除（手机端的模型控制 5.69 就删了）──────────────────
  //
  // 为什么删：侧车拥有**最高**优先级，却只可能带着过期内容 —— 实测踩过"服务器表改对了、
  // 字幕还是按旧模型跑"，而日志上只能靠猜。现在"用哪个模型"只有一个来源：服务器上的表。
  await it('5.108：手机上报的模型请求被忽略，不再落成任何侧车文件', async () => {
    check('writeAsrProfileSidecar 已从 org-api 移除（不是改名）',
      typeof api.writeAsrProfileSidecar === 'undefined',
      String(typeof api.writeAsrProfileSidecar))
    const logs = []
    const result = await handleOrg({
      root, method: 'POST', path: '/org/interpreter/start',
      body: { name: '同传', lang: 'pt-BR', targetLang: 'zh-CN', asrModels: { 'pt-BR': 'tiny' } },
      user: 'alice', role: 'admin', log: (line) => logs.push(String(line)),
    })
    check('开会话照常成功（模型请求不影响开会话）', result.status === 200,
      `${result.status} ${JSON.stringify(result.json)}`)
    const dir = join(root, 'asr-profiles')
    check('没有写出任何侧车文件', !existsSync(dir), dir)
    check('日志里说明这是"忽略"（不然有人会以为生效了）',
      logs.some((line) => line.includes('忽略')), logs.join(' | '))
  })
  await it('策略表合并（只加不覆盖）：运维手改过的配置不能被工具抹掉', () => {
    const existing = {
      version: 2,
      default: { model: 'large-v3' },
      strategies: { 'zh-steady': { note: '本地调过的切句' } },
      languages: { 'en-US': { strategy: 'default' } },
    }
    const additions = {
      strategies: {
        'zh-steady': { note: '示例表里的另一份' },
        'en-turbo': { model: 'large-v3-turbo' },
      },
    }
    const merged = mergeStrategies(existing, additions)
    check('新策略会被加进去', merged.added.includes('en-turbo'), JSON.stringify(merged.added))
    check('同名但内容不同 → 不覆盖（只报告冲突）',
      merged.conflict.includes('zh-steady') && !merged.added.includes('zh-steady'),
      JSON.stringify(merged.conflict))
    check('原表里那条自定义内容原样保留',
      merged.table.strategies['zh-steady'].note === '本地调过的切句',
      JSON.stringify(merged.table.strategies['zh-steady']))
    check('languages 等其它字段一个不动',
      JSON.stringify(merged.table.default) === JSON.stringify(existing.default)
      && merged.table.languages['en-US'].strategy === 'default')
    check('不修改传入的现有表（纯函数）',
      Object.keys(existing.strategies).length === 1, JSON.stringify(Object.keys(existing.strategies)))
    const again = mergeStrategies(merged.table, additions)
    check('再跑一次是幂等的（没有新增，只报"已存在且相同"）',
      again.added.length === 0 && again.unchanged.includes('en-turbo'),
      JSON.stringify([again.added, again.unchanged]))
    check('没有策略表时也能合（整份创建）',
      mergeStrategies(null, additions).added.length === 2)
    // 5.96：我们自己改过示例表里的模型名（fun-asr-flash-* → fun-asr-realtime），
    // 而默认合并只加不覆盖 ⇒ 服务器上一直跑着**旧模型名**，报的错却像"参数不对"。
    check('不带 replace 时同名条目仍只报告、不覆盖（默认保守）',
      merged.table.strategies['zh-steady'].note === '本地调过的切句'
      && merged.replaced.length === 0, JSON.stringify(merged.replaced))
    const replaced = mergeStrategies(existing, additions, { replace: true })
    check('--replace：同名不同内容整条换成新表',
      JSON.stringify(replaced.table.strategies['zh-steady']) === JSON.stringify(additions.strategies['zh-steady']),
      JSON.stringify(replaced.table.strategies['zh-steady']))
    check('--replace 也要留痕（replaced 里点名，不是悄悄改）',
      replaced.replaced.includes('zh-steady') && replaced.conflict.length === 0,
      JSON.stringify([replaced.replaced, replaced.conflict]))
    check('--replace 时新策略仍然是新增（add 与 replace 分开报）',
      replaced.added.includes('en-turbo') && !replaced.replaced.includes('en-turbo'),
      JSON.stringify([replaced.added, replaced.replaced]))
    check('--replace 也只加不删：表里别的策略原样保留',
      replaced.table.languages['en-US'].strategy === 'default'
      && JSON.stringify(replaced.table.default) === JSON.stringify(existing.default))
    check('内容相同的条目不会被当成替换', mergeStrategies(
      { strategies: { 'en-turbo': { model: 'large-v3-turbo' } } },
      { strategies: { 'en-turbo': { model: 'large-v3-turbo' } } },
      { replace: true }).replaced.length === 0)
    // ⚠️ Windows 编辑器会写 BOM，JSON.parse 直接整份失败 —— 容错读并如实报告
    const parsed = parseJsonLoose('\uFEFF{"a": 1}')
    check('带 BOM 的 JSON 能读，而且会告诉你它带 BOM', parsed.value.a === 1 && parsed.hadBom === true)
    check('没有 BOM 时如实报没有', parseJsonLoose('{"a": 1}').hadBom === false)
  })

  await it('云端密钥的体检（5.98）：只看形状、绝不打印密钥 —— 换行会让请求头非法', () => {
    // 真实事故：长 key 复制时被折成两行 → 中间的换行送到 Authorization 头上 →
    // websockets 抛 InvalidHeaderValue（一句看不出线索的第三方 traceback）。
    const folded = describeKeyShape('sk-testkey00\n01abcdef', { expectPrefix: 'sk-' })
    check('中间带换行的密钥判为不可用（这就是 InvalidHeaderValue 的成因）',
      folded.ok === false && folded.problems.some((one) => one.includes('InvalidHeaderValue')),
      JSON.stringify(folded))
    check('点名说是第几个字符、哪一种（不让人对着一串看似正确的字发呆）',
      folded.problems[0].includes('第 13 个字符') && folded.problems[0].includes('U+000A'),
      folded.problems.join(' | '))
    check('只看长度与前缀，不泄露密钥本体',
      folded.shape === '21 字符，以 sk- 开头' && !JSON.stringify(folded).includes('abcdef'),
      JSON.stringify(folded))
    check('干净的密钥通过', describeKeyShape('sk-testkey0001', { expectPrefix: 'sk-' }).ok === true)
    check('首尾换行只算提醒（识别侧会 strip，不该拦人）', (() => {
      const one = describeKeyShape('sk-testkey0001\r\n', { expectPrefix: 'sk-' })
      return one.ok === true && one.notes.length === 1
    })())
    check('把端点地址填进密钥变量时直接说接反了',
      describeKeyShape('wss://ws-x.example.com/api-ws/v1/inference').problems
        .some((one) => one.includes('接反')), '')
    check('全角/省略号这类非 ASCII 字符也要点名（复制聊天窗口最常见的污染）',
      describeKeyShape('sk-testkey00\u202601').problems.some((one) => one.includes('U+2026')), '')
    check('只有空白 = 没设置那样报，而不是"已设置"', (() => {
      const one = describeKeyShape('   ')
      return one.ok === false && one.problems[0].includes('只有空白')
    })())
    check('没给前缀要求时不瞎猜开头（腾讯云 SecretId 是 AKID，不是 sk-）',
      describeKeyShape('AKIDtest0001', { expectPrefix: 'AKID' }).notes.length === 0
      && describeKeyShape('AKIDtest0001').notes.length === 0)
  })

  await it('5.109：电平门槛与切句参数也能在电脑上调（跟模型一样写进表）', () => {
    const table = {
      version: 2,
      default: { model: 'large-v3', segmentation: { silence_ms: 800 }, silence_skip_level: 0.02 },
      strategies: { 'en-fast': { segmentation: { silence_ms: 650 } } },
      languages: { 'en-US': { strategy: 'en-fast' } },
    }
    // ① 两个电平门槛写进 languages[语种]（优先级最高，只影响这一门）
    const tuned = setLanguageTuning(table, 'pt-BR', {
      silence_skip_level: 0.006, rms_threshold: 0.015,
    })
    check('两个门槛都写进去了', tuned.written.length === 2, JSON.stringify(tuned.written))
    check('原表没被改（纯函数）', table.languages['pt-BR'] === undefined)
    check('写的是 numbers 而不是字符串（Python 那边按 float 解析）',
      tuned.table.languages['pt-BR'].silence_skip_level === 0.006,
      JSON.stringify(tuned.table.languages['pt-BR']))

    // ② 越界必须报错，不能悄悄夹到边界 —— 错一个数量级的表现是"一句字幕都没有"
    const tooBig = setLanguageTuning(table, 'pt-BR', { silence_skip_level: 0.2 })
    check('0.2 这种"多打一个 0"的值直接报错', tooBig.problems.length === 1
      && tooBig.problems[0].includes('超出合理范围'), JSON.stringify(tooBig.problems))
    const notNumber = setLanguageTuning(table, 'pt-BR', { rms_threshold: 'abc' })
    check('不是数字也报错', notNumber.problems.length === 1, JSON.stringify(notNumber.problems))
    const unknown = setLanguageTuning(table, 'pt-BR', { beam_size: 5 })
    check('不是可调字段也报错（不乱写）', unknown.problems.length === 1, JSON.stringify(unknown.problems))

    // ③ 切句参数写进 segmentation（单位是毫秒）
    const seg = setLanguageSegmentation(table, 'pt-BR', { silence_ms: 650, min_speech_ms: 300 })
    check('切句参数写进 segmentation', seg.table.languages['pt-BR'].segmentation.silence_ms === 650
      && seg.table.languages['pt-BR'].segmentation.min_speech_ms === 300,
      JSON.stringify(seg.table.languages['pt-BR']))
    const badSeg = setLanguageSegmentation(table, 'pt-BR', { silence_ms: 5 })
    check('把毫秒写成秒（5）会报错，不是默默接受', badSeg.problems.length === 1,
      JSON.stringify(badSeg.problems))

    // ④ 实际生效值：引擎/模型 + 切句 + 门槛，一次算全（"现在到底是多少"要能一眼看到）
    const merged = setLanguageSegmentation(seg.table, 'pt-BR', { silence_ms: 650 })
    const withLevels = setLanguageTuning(merged.table, 'pt-BR', { silence_skip_level: 0.006 })
    const effective = resolveEffective(withLevels.table, 'pt-BR', 'en-fast')
    check('生效值里切句来自 languages 覆盖（650，而不是策略的缺省）',
      effective.segmentation.silence_ms === 650, JSON.stringify(effective.segmentation))
    check('生效值里两个门槛都在', effective.levels.silence_skip_level === 0.006,
      JSON.stringify(effective.levels))
    check('撤掉之后回到 default 层的值（clearLanguageTuning）',
      resolveEffective(clearLanguageTuning(withLevels.table, 'pt-BR').table, 'pt-BR', 'en-fast')
        .levels.silence_skip_level === 0.02)
    // ⑤ 缺省值必须与 Python 的 SEGMENTATION_DEFAULTS 逐字一致（两边各写一份就得对齐）
    check('切句缺省值与 Python 一致（800 / 500 / 30000 / 800 / 1100 / 200）',
      SEGMENTATION_DEFAULTS.silence_ms === 800 && SEGMENTATION_DEFAULTS.min_speech_ms === 500
      && SEGMENTATION_DEFAULTS.max_speech_ms === 30000
      && SEGMENTATION_DEFAULTS.short_utterance_ms === 800
      && SEGMENTATION_DEFAULTS.short_silence_ms === 1100
      && SEGMENTATION_DEFAULTS.cut_pause_ms === 200, JSON.stringify(SEGMENTATION_DEFAULTS))

    // ── 5.114：改"所有人的默认"（切句是同一段代码，碎句/不切句三语一起犯）──
    const globalSeg = setDefaultSegmentation(table, { silence_ms: 1100, short_utterance_ms: 1200 })
    check('默认层的切句被改（并保留 default 里原有的别的字段）',
      globalSeg.table.default.segmentation.silence_ms === 1100
      && globalSeg.table.default.segmentation.short_utterance_ms === 1200
      && globalSeg.table.default.model === 'large-v3', JSON.stringify(globalSeg.table.default))
    check('原表没被改（纯函数）', table.default.segmentation.silence_ms === 800)
    check('三门语言**都**生效（这就是它的意义）',
      ['zh-CN', 'pt-BR', 'en-US'].every((lang) =>
        resolveEffective(globalSeg.table, lang, 'default').segmentation.silence_ms === 1100),
      JSON.stringify(['zh-CN', 'pt-BR', 'en-US'].map(
        (lang) => resolveEffective(globalSeg.table, lang, 'default').segmentation.silence_ms)))
    check('语种级的覆盖仍然优先（--default 定的只是基线）', (() => {
      const withLang = setLanguageSegmentation(globalSeg.table, 'pt-BR', { silence_ms: 700 })
      return resolveEffective(withLang.table, 'pt-BR', 'default').segmentation.silence_ms === 700
        && resolveEffective(withLang.table, 'zh-CN', 'default').segmentation.silence_ms === 1100
    })())
    const globalLevels = setDefaultTuning(table, { rms_floor: 0.002 })
    check('默认层的电平门槛也能改', globalLevels.table.default.rms_floor === 0.002,
      JSON.stringify(globalLevels.table.default))
    check('默认层同样做范围校验（0.2 报错）',
      setDefaultTuning(table, { rms_floor: 0.2 }).problems.length === 1)
  })

  await it('服务器端换模型（setLanguageModel）：改表就生效，别动别的字段', () => {
    const table = {
      version: 2,
      default: { model: 'large-v3', compute_type: 'float16' },
      strategies: { 'en-fast': { segmentation: { silence_ms: 650 } } },
      languages: { 'en-US': { strategy: 'default' }, 'zh-CN': 'small' },
    }
    const pinned = setLanguageModel(table, 'en-US', 'tiny')
    check('钉上模型', pinned.table.languages['en-US'].model === 'tiny', JSON.stringify(pinned.table.languages))
    check('原来的 strategy 字段还在（只加一个 model，不整行替换）',
      pinned.table.languages['en-US'].strategy === 'default')
    check('别的语种、策略表、default 一个不动',
      pinned.table.languages['zh-CN'] === 'small'
      && JSON.stringify(pinned.table.strategies) === JSON.stringify(table.strategies)
      && JSON.stringify(pinned.table.default) === JSON.stringify(table.default))
    check('不修改传入的表（纯函数）', table.languages['en-US'].model === undefined)
    check('简写 `"zh-CN": "small"` 会被展开成对象再钉',
      setLanguageModel(table, 'zh-CN', 'tiny').table.languages['zh-CN'].model === 'tiny')
    const restored = setLanguageModel(pinned.table, 'en-US', '')
    check('--model "" 还原成"跟策略表走"（删掉 model 字段）',
      restored.table.languages['en-US'].model === undefined && restored.before === 'tiny',
      JSON.stringify(restored))
  })

  await rm(BASE, { recursive: true, force: true })
}

export { loadCategories }
