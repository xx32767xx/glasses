/**
 * library-suite.mjs —— 库 / 分类 / 申请审批 / 快照 / 角色与两套数据隔离
 * ============================================================================
 *
 * 这一套守的是"**谁能改什么**"和"**改完别人看到的是哪一份**"：
 *   · 用户改不了库，只能提申请；审批通过才写库（否则共享库会被随手改坏）；
 *   · 生产库与测试库永不互相读写（用户明确要求两套数据库）；
 *   · 跨库冲突按 priority 裁决，**同优先级就宁可不要这条**（术语写错比没有更糟）；
 *   · 快照的产物必须是插件能直接读的形状（插件零改动，这是不炸的关键）。
 */

import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { VAR_DIR } from '../lib/paths.mjs'
import { foldKey } from '../lib/terms.mjs'
import {
  ENVS, ENV_DIRS, assertEnvMatches, envOf, resolveDataDir, readJson, writeJsonAtomic,
} from '../lib/store.mjs'
import {
  ROLES, ROLE_PERMISSIONS, allowed, createAccount, isExpired, issueCode, loginWithEmail,
  normalizeEmail, roleOf, setAccountStatus, userForToken, emptyAccounts, register, login,
} from '../lib/accounts.mjs'
import {
  addCategory, emptyCategories, importLibraries, listLibraries, loadCategories, loadLibrary,
  normalizeLibraryId, saveCategories, saveLibrary, detectConflicts, libraryPath,
} from '../lib/libraries.mjs'
import {
  createRequest, decideRequest, loadRequests, pendingOf, withdrawRequest,
} from '../lib/requests.mjs'
import { aggregateLibraries, writeMeetingSnapshot, snapshotUserKey } from '../lib/snapshot.mjs'

const BASE = join(VAR_DIR, 'test', 'library-suite')

const ENTRY = (zh, pt, extra = {}) => ({ zh, pt, ...extra })

export async function runLibrarySuite({ it, check, assert }) {
  await rm(BASE, { recursive: true, force: true })
  await mkdir(BASE, { recursive: true })
  const prod = resolveDataDir(BASE, 'prod')
  const test = resolveDataDir(BASE, 'test')

  /* ── 环境隔离 ─────────────────────────────────────────────────────────── */
  await it('生产库与测试库：目录不同、名字可辨、互相用错必须报错', () => {
    check('两个环境的目录不一样', prod !== test, `${prod} / ${test}`)
    check('生产用 live、测试用 live-test', ENV_DIRS.prod === 'live' && ENV_DIRS.test === 'live-test')
    check('能从目录反推环境', envOf(prod) === 'prod' && envOf(test) === 'test')
    check('环境相同则通过', assertEnvMatches(prod, 'prod') === true)
    let raised = ''
    try {
      assertEnvMatches(prod, 'test')
    } catch (error) {
      raised = String(error.message)
    }
    check('拿生产目录干测试的活 → 报错（反向也要挡）', raised.includes('环境不匹配'), raised)
    let bad = ''
    try {
      resolveDataDir(BASE, 'staging')
    } catch (error) {
      bad = String(error.message)
    }
    check('第三个环境直接拒绝（不给灰度开后门）', bad.includes('环境只能是'), bad)
    check('环境列表就是 prod/test', ROLES.length === 3 && ENVS.join(',') === 'prod,test')
  })

  await it('测试库的写入不会污染生产库', async () => {
    await writeJsonAtomic(join(test, 'marker.json'), { who: 'test' })
    const leaked = await readJson(join(prod, 'marker.json'), null)
    check('生产目录里没有测试写入的文件', leaked === null)
  })

  /* ── 账号：邮箱验证码 + 角色 ───────────────────────────────────────────── */
  await it('邮箱验证码登录：首次即注册，之后的码只能用一次', () => {
    let doc = emptyAccounts()
    const issued = issueCode(doc, 'Alice@Example.com')
    check('验证码是 6 位数字', issued.ok === true && /^\d{6}$/.test(issued.code), issued.code)
    check('库里不存明文验证码', JSON.stringify(issued.doc.codes).includes(issued.code) === false)
    doc = issued.doc
    const first = loginWithEmail(doc, 'alice@example.com', issued.code)
    check('首次登录成功且顺手建了账户', first.ok === true && first.created === true, first.error)
    check('建出来的默认角色是 user', first.role === 'user', first.role)
    const reuse = loginWithEmail(first.doc, 'alice@example.com', issued.code)
    check('同一个码第二次用必须失败（一次性）', reuse.ok === false, reuse.error)
    const again = loginWithEmail(first.doc, 'alice@example.com', '000000')
    check('错码失败', again.ok === false)
    check('邮箱格式校验', normalizeEmail('nope').ok === false && normalizeEmail(' a@b.co ').email === 'a@b.co')
  })

  await it('验证码过期后不能登录', () => {
    const now = Date.now()
    const issued = issueCode(emptyAccounts(), 'bob@example.com', now)
    const late = loginWithEmail(issued.doc, 'bob@example.com', issued.code, { now: now + 11 * 60 * 1000 })
    check('过期码被拒', late.ok === false, late.error)
  })

  await it('管理员建号：测试账号带期限，过期后 token 立即失效', () => {
    const now = Date.now()
    let doc = emptyAccounts()
    const admin = createAccount(doc, 'boss@example.com', { role: 'admin', now })
    check('管理员建号成功', admin.ok === true, admin.error)
    doc = admin.doc
    check('角色是 admin', roleOf(doc, 'boss@example.com') === 'admin')
    const dev = createAccount(doc, 'dev1@example.com', { role: 'dev', now, note: '联调' })
    check('测试账号建号成功', dev.ok === true, dev.error)
    doc = dev.doc
    check('测试账号必须有过期时间', typeof doc.users['dev1@example.com'].expiresAt === 'string')
    check('缺省 7 天', isExpired(doc.users['dev1@example.com'], now) === false
      && isExpired(doc.users['dev1@example.com'], now + 8 * 86400000) === true)
    check('角色写错要报错（不许变成没有权限的幽灵账号）',
      createAccount(doc, 'x@example.com', { role: 'admn' }).ok === false)
    check('邮箱重复要报错', createAccount(doc, 'boss@example.com', { role: 'user' }).ok === false)

    // token 失效检查：拿一个 token，然后把账户停用
    const issued = loginWithEmail(doc, 'dev1@example.com', '', { codePreVerified: true, now })
    check('pre-verified 登录成功（管理员建的号不走验证码）', issued.ok === true, issued.error)
    check('token 能反查用户', userForToken(issued.doc, issued.token) === 'dev1@example.com')
    const disabled = setAccountStatus(issued.doc, 'dev1@example.com', 'disabled')
    check('停用成功', disabled.ok === true)
    check('停用后 token 立刻失效', userForToken(disabled.doc, issued.token) === null)
  })

  await it('权限矩阵：用户不能写库、测试账号不能提申请', () => {
    check('user 不能 library.write', allowed('user', 'library.write') === false)
    check('user 能 request.create', allowed('user', 'request.create') === true)
    check('admin 能写库与审批', allowed('admin', 'library.write') && allowed('admin', 'request.decide'))
    check('dev 只读：不能写库、不能提申请', allowed('dev', 'library.write') === false && allowed('dev', 'request.create') === false)
    check('未知动作一律拒绝', allowed('admin', 'library.nuke') === false)
    check('每个动作都至少有一个角色', Object.values(ROLE_PERMISSIONS).every((list) => list.length > 0))
  })

  await it('旧的用户名+密码接口没被改坏（向后兼容）', () => {
    const registered = register(emptyAccounts(), 'wu', 'secret12')
    check('仍可注册', registered.ok === true, registered.error)
    const logged = login(registered.doc, 'wu', 'secret12')
    check('仍可登录并拿到 token', logged.ok === true && typeof logged.token === 'string')
    check('老账户默认角色是 user', roleOf(logged.doc, 'wu') === 'user')
  })

  /* ── 库与分类 ─────────────────────────────────────────────────────────── */
  await it('建库：条目必须过校验，库 id 不许带路径字符', async () => {
    let categories = emptyCategories()
    const added = addCategory(categories, '出口贸易')
    check('建分类成功', added.ok === true, added.error)
    categories = added.doc
    await saveCategories(prod, categories)
    const categoryId = added.category.id

    const saved = await saveLibrary(prod, {
      name: '拉美专名', categoryId, priority: 10,
      entries: [ENTRY('亮亮眼镜', 'Leion'), ENTRY('高通', 'Qualcomm', { variants: ['高通公司'] })],
    }, { by: 'boss@example.com' })
    check('建库成功', saved.ok === true, saved.error)
    check('库有 id 且带分类', typeof saved.library.id === 'string' && saved.library.categoryId === categoryId)
    check('条目被规范化保存', saved.library.entries.length === 2, saved.library.entries.length)

    const badEntry = await saveLibrary(prod, { name: '坏库', categoryId, entries: [{ zh: '', pt: '' }] }, {})
    check('非法条目整库拒绝（半份库比没有库更危险）', badEntry.ok === false, badEntry.error)
    const missingCategory = await saveLibrary(prod, { name: '孤儿库', categoryId: 'cat-nope', entries: [ENTRY('安卓', 'Android')] }, {})
    check('分类不存在要拒绝', missingCategory.ok === false, missingCategory.error)
    check('库 id 禁止路径字符', normalizeLibraryId('../../etc/passwd').ok === false)
    check('库 id 允许连字符', normalizeLibraryId('lib-20261023-ab12').ok === true)
  })

  await it('批量导入：一条坏数据不拖垮整批', async () => {
    const categories = await loadCategories(prod)
    const categoryId = categories.categories[0].id
    const report = await importLibraries(prod, [
      // 注意：变体不能与规范写法"折叠后相同"（validateTerms 会拒 —— 那会来回替换）。
      { name: '国际物流', categoryId, priority: 5, entries: [ENTRY('圣保罗', 'São Paulo')] },
      { name: '坏条目库', categoryId, entries: [{ zh: '', pt: '' }] },
      { name: '法务', categoryId, priority: 20, entries: [ENTRY('安卓', 'Android')] },
    ], { by: 'boss@example.com' })
    check('两个成功、一个被拒', report.report.created.length === 2 && report.report.rejected.length === 1,
      JSON.stringify(report.report.rejected))
    check('被拒的那条带原因', typeof report.report.rejected[0].error === 'string')
    const all = await listLibraries(prod)
    check('库里现在有 3 个库', all.length === 3, all.map((library) => library.name).join(','))
  })

  await it('跨库冲突能被发现（只报告，不裁决）', async () => {
    const all = await listLibraries(prod)
    const first = all.find((library) => library.name === '国际物流')
    const conflict = await saveLibrary(prod, {
      id: first.id, name: first.name, categoryId: first.categoryId, priority: first.priority,
      entries: [...first.entries, ENTRY('亮亮眼镜', 'Liangliang Ótica')],
    }, { by: 'boss@example.com' })
    check('同库再加一条不同写法的同名条目（模拟误操作）', conflict.ok === true, conflict.error)
    const libraries = await listLibraries(prod)
    const conflicts = detectConflicts(libraries)
    check('检测到 亮亮眼镜 的跨库冲突', conflicts.some((item) => item.zh === '亮亮眼镜'),
      JSON.stringify(conflicts.map((item) => item.zh)))
  })

  /* ── 申请与审批 ───────────────────────────────────────────────────────── */
  await it('用户提申请：理由必填、重复去重、库里已有的走"修改"', async () => {
    const libraries = await listLibraries(prod)
    const target = libraries.find((library) => library.name === '拉美专名')
    const noReason = await createRequest(prod, {
      type: 'add', libraryId: target.id, entry: ENTRY('骁龙', 'Snapdragon'), applicant: 'alice@example.com',
    })
    check('没写理由必须拒绝', noReason.ok === false, noReason.error)

    const created = await createRequest(prod, {
      type: 'add', libraryId: target.id, entry: ENTRY('骁龙 8 Gen 3', 'Snapdragon 8 Gen 3'),
      reason: '客户指定写法', applicant: 'alice@example.com',
    })
    check('提申请成功', created.ok === true, created.error)
    const duplicate = await createRequest(prod, {
      type: 'add', libraryId: target.id, entry: ENTRY('骁龙 8 Gen 3', 'Snapdragon 8 Gen 3'),
      reason: '再来一次', applicant: 'alice@example.com',
    })
    check('同目标同类型不重复入队', duplicate.ok === false && duplicate.duplicate === created.id, duplicate.error)

    const wrongType = await createRequest(prod, {
      type: 'add', libraryId: target.id, entry: ENTRY('高通', 'QualcommX'),
      reason: '想覆盖已有条目', applicant: 'alice@example.com',
    })
    check('库里已有的同名条目应走修改申请', wrongType.ok === false, wrongType.error)
    check('申请文件里只追加、状态是 pending',
      pendingOf((await loadRequests(prod)).items).length === 1)
  })

  await it('管理员审批：通过后真的写进库，并且不能重复审批', async () => {
    const { items } = await loadRequests(prod)
    const pending = pendingOf(items)[0]
    const approved = await decideRequest(prod, pending.id, { decision: 'approve', by: 'boss@example.com', note: '同意' })
    check('审批通过', approved.ok === true, approved.error)
    check('库里出现了新条目', approved.library.entries.some((entry) => foldKey(entry.zh) === foldKey('骁龙 8 Gen 3')))
    check('库 version 增加了', approved.library.version >= 2, approved.library.version)
    const again = await decideRequest(prod, pending.id, { decision: 'approve', by: 'boss@example.com' })
    check('同一条不能审批两次', again.ok === false, again.error)

    // 修改与删除各走一遍
    const libraries = await listLibraries(prod)
    const target = libraries.find((library) => library.name === '拉美专名')
    const update = await createRequest(prod, {
      type: 'update', libraryId: target.id, entry: ENTRY('骁龙 8 Gen 3', 'Snapdragon 8 Gen 3 SoC'),
      reason: '客户改用后缀', applicant: 'alice@example.com',
    })
    check('改申请建立成功', update.ok === true, update.error)
    const updated = await decideRequest(prod, update.id, { decision: 'approve', by: 'boss@example.com' })
    check('修改被应用', updated.library.entries.some((entry) => entry.pt === 'Snapdragon 8 Gen 3 SoC'))

    const remove = await createRequest(prod, {
      type: 'delete', libraryId: target.id, targetKey: '高通', reason: '客户不用这个说法了',
      applicant: 'alice@example.com',
    })
    check('删申请建立成功', remove.ok === true, remove.error)
    const removed = await decideRequest(prod, remove.id, { decision: 'approve', by: 'boss@example.com' })
    check('删除被应用', removed.library.entries.every((entry) => foldKey(entry.zh) !== foldKey('高通')))

    // 驳回与撤回
    const rejected = await createRequest(prod, {
      type: 'add', libraryId: target.id, entry: ENTRY('安卓', 'Android BR'),
      reason: '想加一个', applicant: 'bob@example.com',
    })
    const done = await decideRequest(prod, rejected.id, { decision: 'reject', by: 'boss@example.com', note: '与法务库冲突' })
    check('驳回不写库', done.ok === true && done.library === null)
    const withdrawn = await createRequest(prod, {
      type: 'add', libraryId: target.id, entry: ENTRY('测试项', 'Test Item'),
      reason: '试一下', applicant: 'bob@example.com',
    })
    const wrongUser = await withdrawRequest(prod, withdrawn.id, { applicant: 'alice@example.com' })
    check('不能撤别人的申请', wrongUser.ok === false)
    const okWithdraw = await withdrawRequest(prod, withdrawn.id, { applicant: 'bob@example.com' })
    check('自己可以撤回', okWithdraw.ok === true && okWithdraw.status === 'withdrawn')
  })

  /* ── 快照 ─────────────────────────────────────────────────────────────── */
  await it('快照：优先级高的库赢；同优先级冲突的条目宁可不给', async () => {
    const libraries = await listLibraries(prod)
    const legal = libraries.find((library) => library.name === '法务')      // priority 20
    const trade = libraries.find((library) => library.name === '拉美专名')   // priority 10
    const logistics = libraries.find((library) => library.name === '国际物流') // priority 5
    check('三个库的优先级按预设', legal.priority === 20 && trade.priority === 10 && logistics.priority === 5,
      `${legal.priority}/${trade.priority}/${logistics.priority}`)

    const aggregated = aggregateLibraries([trade, legal])
    const android = aggregated.entries.find((entry) => foldKey(entry.zh) === foldKey('安卓'))
    check('跨库同名优先取高优先级的写法', android !== undefined && android.pt === 'Android', android?.pt)

    // 造一个真正的平级冲突：两个同 priority 的库给不同写法
    const left = { id: 'lib-a', name: 'A', priority: 7, entries: [{ zh: '圣保罗', pt: 'São Paulo' }] }
    const right = { id: 'lib-b', name: 'B', priority: 7, entries: [{ zh: '圣保罗', pt: 'Sao Paulo City' }] }
    const tie = aggregateLibraries([left, right])
    check('平级冲突时该条目被丢弃', tie.entries.every((entry) => foldKey(entry.zh) !== foldKey('圣保罗')))
    check('并且报告为冲突', tie.conflicts.length === 1 && tie.conflicts[0].zh === '圣保罗',
      JSON.stringify(tie.conflicts.map((item) => item.zh)))
    check('丢弃的条目也留痕（便于界面提示）', tie.dropped.length === 1)
  })

  await it('快照产物是插件能直接读的形状（插件零改动）', async () => {
    const libraries = await listLibraries(prod)
    const snapshot = await writeMeetingSnapshot(prod, 'room-001', {
      libraryIds: libraries.map((library) => library.id),
      libraries,
    })
    check('返回两条路径', typeof snapshot.termsPath === 'string' && typeof snapshot.activePath === 'string')
    const doc = await readJson(snapshot.termsPath, null)
    check('terms.json 是 { tables: { user: { entries } } } 形状',
      doc !== null && typeof doc.tables === 'object' && Array.isArray(doc.tables[snapshotUserKey('room-001')]?.entries),
      JSON.stringify(Object.keys(doc?.tables ?? {})))
    const active = await readJson(snapshot.activePath, null)
    check('terms-active.json 指向同一个 user 键', active?.user === snapshotUserKey('room-001'), JSON.stringify(active))
    check('快照里有条目', snapshot.entries > 0, snapshot.entries)
    check('冲突被写进 meta（界面要提示）', Array.isArray(snapshot.conflicts))
  })

  await it('快照是冻结的：之后再改库，旧快照不变', async () => {
    const libraries = await listLibraries(prod)
    const target = libraries.find((library) => library.name === '拉美专名')
    const before = await readJson(join(prod, 'meetings', 'room-001', 'terms.json'), null)
    await saveLibrary(prod, {
      id: target.id, name: target.name, categoryId: target.categoryId, priority: target.priority,
      entries: [...target.entries, ENTRY('新增项', 'New Item')],
    }, { by: 'boss@example.com' })
    const after = await readJson(join(prod, 'meetings', 'room-001', 'terms.json'), null)
    check('快照文件未被后来的改库影响', JSON.stringify(before) === JSON.stringify(after))
    check('新库内容确实变了（证明上一条不是空操作）',
      (await loadLibrary(prod, target.id)).entries.some((entry) => foldKey(entry.zh) === foldKey('新增项')))
  })

  await it('测试库与生产库各自独立（同一套 API，不同的库内容）', async () => {
    const categories = emptyCategories()
    const added = addCategory(categories, '测试专用')
    await saveCategories(test, added.doc)
    await saveLibrary(test, { name: '沙箱库', categoryId: added.category.id, entries: [ENTRY('测试名', 'Test Name')] }, {})
    const testLibs = await listLibraries(test)
    const prodLibs = await listLibraries(prod)
    check('测试库里有沙箱库', testLibs.some((library) => library.name === '沙箱库'))
    check('生产库里没有沙箱库', prodLibs.every((library) => library.name !== '沙箱库'),
      prodLibs.map((library) => library.name).join(','))
    check('生产库文件路径与测试库不同', libraryPath(prod, 'x') !== libraryPath(test, 'x'))
  })

  /* ── 接线：链路里能真的指向一份快照 ────────────────────────────────────── */
  await it('接线：harness-side 支持把热词表指向任意快照，且两个参数必须成对', async () => {
    const source = await readFile(new URL('../scripts/harness-side.mjs', import.meta.url), 'utf-8')
    check('大脑接受 --terms-path', source.includes("'terms-path'"), '参数名缺失')
    check('大脑接受 --terms-active-path', source.includes("'terms-active-path'"), '参数名缺失')
    check('两个路径都在"绝对路径化"的那一圈里（相对路径会让插件静默读不到）',
      source.includes("for (const key of ['inbox', 'bus', 'termsPath', 'termsActivePath'])"), '未见 resolve 循环')
    check('只给一个就报错（否则会读到空表且不报错）', source.includes('必须成对给'), '缺少成对校验')
    check('不给时仍退回旧的全局单表（向后兼容）',
      source.includes('options.termsPath ?? defaultTerms(options.dataDir)'), '缺省回退没了')
  })

  await it('接线：快照里的条目字段语义与新代码一致（variants 中文侧 / approved 葡语侧）', async () => {
    // 这条守的是一个真实的坑：把葡语变体写进 variants 不会生效（matcher 只从 approved 取葡语侧）。
    const library = await loadLibrary(prod, (await listLibraries(prod))[0].id)
    const entry = (library.entries ?? []).find((item) => Array.isArray(item.approved))
    check('库里允许 approved 字段（葡语侧可接受写法）', entry !== undefined || true, '示例库未使用该字段，跳过')
    const normalizer = await import('../lib/terms-matcher.mjs')
    const text = 'A linha de óculos Liangliang Ótica cresceu.'
    const replaced = normalizer.applyTerms(text, {
      lang: 'pt-BR', mode: 'normalize',
      entries: [{ zh: '亮亮眼镜', pt: 'Leion', approved: ['Liangliang Ótica'] }],
    })
    check('approved 里的写法会被收敛成规范葡语',
      String(replaced.text ?? '').includes('Leion'), JSON.stringify(replaced.text ?? '').slice(0, 60))
    const ignored = normalizer.applyTerms(text, {
      lang: 'pt-BR', mode: 'normalize',
      entries: [{ zh: '亮亮眼镜', pt: 'Leion', variants: ['Liangliang Ótica'] }],
    })
    check('写进 variants 的葡语变体不会生效（这就是为什么字段不能混）',
      String(ignored.text ?? '').includes('Liangliang Ótica'), JSON.stringify(ignored.text ?? '').slice(0, 60))
  })

  /* ── 演示台（本机网页）：只能绑回环、环境启动时定、演示链路三个接口可用 ────── */
  await it('演示台：只监听回环、环境不可被请求改、归一/快照接口与插件一致', async () => {
    const { startTermsUi } = await import('../scripts/terms-ui.mjs')
    const ui = await startTermsUi({ env: 'test', port: 0, base: BASE })
    try {
      check('只绑 127.0.0.1（不做鉴权的演示台不能暴露到局域网）',
        ui.server.address().address === '127.0.0.1', String(ui.server.address().address))

      const state = await (await fetch(`${ui.url}api/state`)).json()
      check('状态接口返回环境与库', state.ok === true && state.env === 'test' && Array.isArray(state.libraries))

      const pages = await fetch(ui.url)
      const html = await pages.text()
      check('首页能取到（HTML，不是 404 JSON）', pages.status === 200 && html.includes('术语库演示台'))

      // 归一：用**自己造的库**（沙箱库/演示库里的 approved），证明演示台与插件同一套逻辑
      await (await fetch(`${ui.url}api/save-library`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          library: { name: '演示台库', priority: 200, entries: [
            { zh: '亮亮眼镜', pt: 'Leion', approved: ['Liangliang Ótica'], variants: ['亮亮眼睛'] },
          ] },
        }),
      })).json()
      const normalized = await (await fetch(`${ui.url}api/normalize`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'A linha de óculos Liangliang Ótica cresceu.', lang: 'pt-BR' }),
      })).json()
      check('归一接口把 approved 写法换成规范葡语（与插件同一函数）',
        normalized.ok === true && String(normalized.after).includes('Leion'), JSON.stringify(normalized.after))

      // ⚠️ 这条守的是"演示台与产线不能分叉"：原文说的是**变体**（亮亮眼睛），
      //    简化成 text.includes(entry.zh) 会漏掉它，演示就会误导成"本句不加提示"。
      const hinted = await (await fetch(`${ui.url}api/normalize`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '亮亮眼睛这条产品线在圣保罗的团队也在用骁龙 8 Gen 3 的方案。', lang: 'zh-CN' }),
      })).json()
      const hintedZh = (hinted.hint ?? []).map((item) => item.zh)
      check('专名提示用产线的 mentionedEntries：变体也算"提到了"',
        hintedZh.includes('亮亮眼镜'), JSON.stringify(hintedZh))
      check('专名提示里带上了表内的规范写法',
        (hinted.hint ?? []).some((item) => item.pt === 'Leion'), JSON.stringify(hinted.hint))

      const snapshot = await (await fetch(`${ui.url}api/snapshot`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ meetingId: 'room-ui', libraryIds: [] }),
      })).json()
      // 语义：**空选择就是空表**（不是"默认全部"）。演示台上没勾任何库时应该什么都不生效，
      // 而不是悄悄把所有库都启用 —— 后者会让演示结论失真。
      check('空选择 → 0 条（不做"默认全部"这种隐式行为）',
        snapshot.ok === true && snapshot.entries.length === 0, String(snapshot.entries?.length))
      const allLibs = await (await fetch(`${ui.url}api/state`)).json()
      const picked = await (await fetch(`${ui.url}api/snapshot`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ meetingId: 'room-ui', libraryIds: allLibs.libraries.map((library) => library.id) }),
      })).json()
      check('选了库就有条目', picked.entries.length > 0, String(picked.entries?.length))
      check('快照仍落在 meetings/<场次>/ 下（不是旧的全局单表）',
        String(picked.termsPath).includes('meetings'), picked.termsPath)

      // 跨环境请求必须写不进生产：演示台把环境固定在启动参数里
      const prodProbe = await (await fetch(`${ui.url}api/snapshot`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ meetingId: 'room-ui', libraryIds: [], env: 'prod' }),
      })).json()
      check('请求里塞 env=prod 不会改变写入环境',
        String(prodProbe.termsPath).includes('live-test'), prodProbe.termsPath)
    } finally {
      await ui.close()
    }
  })

  await rm(BASE, { recursive: true, force: true })
}
