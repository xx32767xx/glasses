/**
 * org-api.mjs —— 术语库 / 会议选库 / 申请审批的 HTTP 接口层（纯函数）
 * ============================================================================
 *
 * 为什么写成纯函数而不直接塞进 relay：
 *   ① 权限判断必须能被**逐条测**（用户调管理员接口要 403），而塞进 relay 就只能在
 *      "起一个服务器再发请求"里测，慢且容易漏；
 *   ② 以后房间服务要复用同一批接口（同一套语义），不该被 relay 的启动方式绑死；
 *   ③ relay 只负责"把 token 解成 user + role，然后调这里"，职责边界清楚。
 *
 * 权限一律查 `ROLE_PERMISSIONS`（lib/accounts.mjs），**不在各处写 if (role === 'admin')**：
 * 界面隐藏按钮只是体验，真正的门在这里。
 *
 * 路径（都由 relay 转进来，relay 负责鉴权前解析 token）：
 *   GET  /org/libraries                     列出可见库
 *   GET  /org/libraries/<id>                单个库详情
 *   GET  /org/meeting/<id>/libraries        这一场选了哪些库
 *   PUT  /org/meeting/<id>/libraries        设置这一场选哪些库
 *   POST /org/meeting/<id>/snapshot         冻结快照（返回条目数与冲突）
 *   POST /org/requests                      提交申请
 *   GET  /org/requests/mine                 我的申请
 *   GET  /org/requests/pending              待审列表（管理员）
 *   POST /org/requests/<id>/decide          审批（管理员）
 */

import { join } from 'node:path'
import { DEV_TTL_DAYS, allowed, createAccountWithPassword, listAccounts, loadAccounts, renewAccount, saveAccounts, setStatusByUsername } from '../lib/accounts.mjs'
import { readJson, writeJsonAtomic } from '../lib/store.mjs'
import { listLibraries, loadLibrary, loadCategories, saveLibrary, importLibraries } from '../lib/libraries.mjs'
import { createRequest, decideRequest, hideRequest, loadRequests, pendingOf, visibleOfMine, withdrawRequest } from '../lib/requests.mjs'
import { writeMeetingSnapshot } from '../lib/snapshot.mjs'
import { createRoom, hideHistoryForUser, isRoomClosed, joinRoom, leaveRoom, listHistory, listMembers, listRooms, removeMember, roomByCode, roomById, roomLibraries, setRoomLibraries } from '../lib/rooms.mjs'
import { FLOOR_LOCKED_LEASE_MS, FLOOR_LEASE_MS, floorState, forceReleaseFloor, heartbeatFloor, releaseFloor, setFloorLock, sweepExpiredFloor, takeFloor } from '../lib/floor.mjs'
import { publishMeetingTerms } from '../lib/meeting-terms.mjs'

export function selectionPath(root, meetingId) {
  // 会议 id 会被拼进路径，所以只允许安全字符（防目录穿越）
  const safe = String(meetingId).replace(/[^A-Za-z0-9_-]/g, '')
  if (safe === '' || safe !== String(meetingId)) {
    throw new Error('会议 id 只能包含字母、数字、下划线、连字符')
  }
  return join(root, 'meetings', safe, 'selection.json')
}

export async function loadSelection(root, meetingId) {
  const doc = await readJson(selectionPath(root, meetingId), null)
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { meetingId, libraryIds: [], selectedBy: null, updatedAt: null }
  }
  return {
    meetingId,
    libraryIds: Array.isArray(doc.libraryIds) ? doc.libraryIds : [],
    selectedBy: doc.selectedBy ?? null,
    updatedAt: doc.updatedAt ?? null,
  }
}

function bad(status, error) {
  if (error === undefined || error === null || error === '') error = `HTTP ${status}（服务端没有给出原因，看 relay 日志）`
  return { status, json: { ok: false, error } }
}

function deny(role, action) {
  // 除了给人看的中文原话，再给一组机器读的字段：客户端要能说清"哪个角色不能做什么"。
  // 只丢一句"没有权限"的话，用户和我们都没法判断是账号问题还是代码问题（4.63 踩过）。
  return {
    status: 403,
    json: {
      ok: false,
      error: `当前角色（${role ?? '未登录'}）不能做 ${action}`,
      code: 'forbidden',
      role: role ?? '',
      action,
    },
  }
}

/**
 * 处理一次请求。
 * @param {{ method: string, path: string, body?: object, user: string|null, role: string|null,
 *           root: string, now?: string }} input
 * @returns {Promise<{ status: number, json: object }>}
 */
export async function handleOrg(input) {
  const { method, root, user, role } = input
  const now = input.now ?? new Date().toISOString()
  const body = input.body ?? {}
  const path = String(input.path ?? '')
  // 路径上可能带 query（如 /org/history?limit=20）：切段之前先剔掉，否则它会变成一个路径段
  const segments = path.split('?')[0].split('/').filter(Boolean).map((item) => decodeURIComponent(item))

  if (user === null || user === undefined) return bad(401, '需要登录（缺少有效 token）')

  // ── 库列表 / 详情 ────────────────────────────────────────────────────────
  if (method === 'GET' && segments[0] === 'org' && segments[1] === 'libraries' && segments.length === 2) {
    if (allowed(role, 'library.read') !== true) return deny(role, 'library.read')
    const [libraries, categories] = await Promise.all([listLibraries(root), loadCategories(root)])
    const categoryName = new Map(categories.categories.map((item) => [item.id, item.name]))
    return {
      status: 200,
      json: {
        ok: true,
        libraries: libraries.map((library) => ({
          id: library.id, name: library.name, categoryId: library.categoryId ?? '',
          // 分类可能没有：这里统一给**空串**而不是 null。
          // 客户端（Android 的 optString）遇到 JSON null 会返回字符串 "null"，
          // 于是界面上出现"null · 8 条"——与其每个客户端各修一次，不如服务端不给 null。
          categoryName: categoryName.get(library.categoryId) ?? '',
          priority: library.priority, visibility: library.visibility,
          entries: (library.entries ?? []).length, updatedAt: library.updatedAt,
        })),
      },
    }
  }

  if (method === 'GET' && segments[1] === 'libraries' && segments.length === 3) {
    if (allowed(role, 'library.read') !== true) return deny(role, 'library.read')
    const library = await loadLibrary(root, segments[2])
    if (library === null) return bad(404, '没有这个库')
    return { status: 200, json: { ok: true, library } }
  }

  // ── 会议选库 ─────────────────────────────────────────────────────────────
  if (segments[1] === 'meeting' && segments[3] === 'libraries' && segments.length === 4) {
    const meetingId = segments[2]
    if (method === 'GET') {
      if (allowed(role, 'meeting.configure') !== true) return deny(role, 'meeting.configure')
      const selection = await loadSelection(root, meetingId)
      const libraries = await listLibraries(root)
      const picked = libraries.filter((library) => selection.libraryIds.includes(library.id))
      return {
        status: 200,
        json: {
          ok: true, ...selection,
          entries: picked.reduce((sum, library) => sum + (library.entries ?? []).length, 0),
        },
      }
    }
    if (method === 'PUT') {
      if (allowed(role, 'meeting.configure') !== true) return deny(role, 'meeting.configure')
      const wanted = Array.isArray(body.libraryIds) ? body.libraryIds.map((item) => String(item)) : null
      if (wanted === null) return bad(400, 'libraryIds 必须是数组（可以为空数组）')
      const libraries = await listLibraries(root)
      const unknown = wanted.filter((id) => libraries.every((library) => library.id !== id))
      if (unknown.length > 0) return bad(400, `有库不存在：${unknown.join(', ')}`)
      const doc = { meetingId, libraryIds: wanted, selectedBy: user, updatedAt: now }
      await writeJsonAtomic(selectionPath(root, meetingId), doc)
      return { status: 200, json: { ok: true, ...doc } }
    }
  }

  // ── 冻结快照 ─────────────────────────────────────────────────────────────
  if (method === 'POST' && segments[1] === 'meeting' && segments[3] === 'snapshot' && segments.length === 4) {
    if (allowed(role, 'meeting.configure') !== true) return deny(role, 'meeting.configure')
    const meetingId = segments[2]
    const selection = await loadSelection(root, meetingId)
    const libraryIds = Array.isArray(body.libraryIds) ? body.libraryIds.map(String) : selection.libraryIds
    const libraries = await listLibraries(root)
    const snapshot = await writeMeetingSnapshot(root, meetingId, { libraryIds, libraries, now })
    return {
      status: 200,
      json: {
        ok: true, meetingId, user: snapshot.user, entries: snapshot.entries,
        conflicts: snapshot.conflicts, termsPath: snapshot.termsPath, activePath: snapshot.activePath,
      },
    }
  }

  // ── 申请 ─────────────────────────────────────────────────────────────────
  // 按账号删除一条历史（4.71）：只影响自己的列表，会议与字幕不动
  if (method === 'POST' && segments[1] === 'history' && segments[3] === 'delete' && segments.length === 4) {
    if (allowed(role, 'meeting.configure') !== true) return deny(role, 'meeting.configure')
    const hidden = hideHistoryForUser(root, { user, roomId: segments[2], now })
    if (hidden.ok !== true) return bad(400, hidden.error)
    return { status: 200, json: { ok: true, roomId: hidden.roomId } }
  }

  // 历史记录（4.69）：我参加过的会议 + 字幕保存期（客户端顶部要写“记录保存 N 天”）。
  if (method === 'GET' && segments[0] === 'org' && segments[1] === 'history') {
    if (allowed(role, 'meeting.configure') !== true) return deny(role, 'meeting.configure')
    // handleOrg 拿到的是**路径串**（不是 URL 对象）：query 自己切，不能写 url.searchParams
    const queryAt = path.indexOf('?')
    const query = queryAt >= 0 ? new URLSearchParams(path.slice(queryAt + 1)) : new URLSearchParams()
    const limit = Number(query.get('limit') ?? 0) || 50
    const history = listHistory(root, { user, limit, now })
    return {
      status: 200,
      json: {
        ok: true,
        items: history.items,
        total: history.total,
        // 保留期由服务端定（start-all / relay 的 --utterance-retention-days），客户端不自己编一个
        // 保留期由服务端定（relay 的 --utterance-retention-days）；客户端不自己编一个
        retentionDays: Number(input.utteranceRetentionDays ?? 7),
      },
    }
  }

  if (method === 'POST' && segments[1] === 'requests' && segments.length === 2) {
    if (allowed(role, 'request.create') !== true) return deny(role, 'request.create')
    const created = await createRequest(root, {
      type: body.type,
      libraryId: body.libraryId,
      entry: body.type === 'delete' ? null : { zh: body.zh, pt: body.pt },
      targetKey: body.type === 'delete' ? body.zh : null,
      reason: body.reason,
      applicant: user, // ⚠️ 申请人是**服务端从 token 解出来的**，不信请求体里的 applicant
    }, { now })
    if (created.ok !== true) return bad(400, created.error)
    return { status: 200, json: { ok: true, id: created.id, status: created.status } }
  }

  if (method === 'GET' && segments[1] === 'requests' && segments[2] === 'mine') {
    const { items } = await loadRequests(root)
    // 4.64：自己删掉（hidden）的不再回到列表里
    const mine = visibleOfMine(items, user)
    return { status: 200, json: { ok: true, requests: mine } }
  }

  if (method === 'GET' && segments[1] === 'requests' && segments[2] === 'pending') {
    if (allowed(role, 'request.decide') !== true) return deny(role, 'request.decide')
    const { items, badLines } = await loadRequests(root)
    return { status: 200, json: { ok: true, requests: pendingOf(items), badLines } }
  }

  if (method === 'POST' && segments[1] === 'requests' && segments[3] === 'decide' && segments.length === 4) {
    if (allowed(role, 'request.decide') !== true) return deny(role, 'request.decide')
    const decided = await decideRequest(root, segments[2], {
      decision: body.decision === 'approve' ? 'approve' : 'reject',
      by: user, // 审批人同样来自 token
      note: typeof body.note === 'string' ? body.note : '',
      now,
    })
    if (decided.ok !== true) return bad(400, decided.error)
    return {
      status: 200,
      json: { ok: true, id: decided.id, status: decided.status,
        entries: decided.library ? decided.library.entries.length : null },
    }
  }

  // 4.64：把自己**已经有结论**的申请从列表里删掉（待审批的必须先撤回）
  if (method === 'POST' && segments[1] === 'requests' && segments[3] === 'delete' && segments.length === 4) {
    if (allowed(role, 'request.create') !== true) return deny(role, 'request.create')
    const hidden = await hideRequest(root, segments[2], { applicant: user, now })
    if (hidden.ok !== true) return bad(400, hidden.error)
    return { status: 200, json: { ok: true, id: hidden.id, status: hidden.status } }
  }

  if (method === 'POST' && segments[1] === 'requests' && segments[3] === 'withdraw' && segments.length === 4) {
    const withdrawn = await withdrawRequest(root, segments[2], { applicant: user, now })
    if (withdrawn.ok !== true) return bad(400, withdrawn.error)
    return { status: 200, json: { ok: true, id: withdrawn.id, status: withdrawn.status } }
  }

  // ── 管理员：直接改库 / 批量导入（界面上只在管理端出现，但门在服务端）────────
  if (method === 'PUT' && segments[1] === 'libraries' && segments.length === 3) {
    if (allowed(role, 'library.write') !== true) return deny(role, 'library.write')
    const saved = await saveLibrary(root, { ...body.library, id: segments[2] }, { by: user, now, source: 'api' })
    if (saved.ok !== true) return bad(400, saved.error)
    return { status: 200, json: { ok: true, id: saved.library.id, created: saved.created, entries: saved.library.entries.length } }
  }

  if (method === 'POST' && segments[1] === 'libraries' && segments[2] === 'import' && segments.length === 3) {
    if (allowed(role, 'library.write') !== true) return deny(role, 'library.write')
    const report = await importLibraries(root, body.items, { by: user, now })
    return {
      status: 200,
      json: {
        ok: true,
        created: report.report.created.length, updated: report.report.updated.length,
        rejected: report.report.rejected,
      },
    }
  }

  // ── 管理员：账号管理（docs/19：管理员可手动添加测试账号）───────────────────
  if (segments[1] === 'accounts' && segments.length === 2) {
    if (allowed(role, 'account.manage') !== true) return deny(role, 'account.manage')
    if (method === 'GET') {
      const doc = await loadAccounts(root)
      return { status: 200, json: { ok: true, accounts: listAccounts(doc) } }
    }
    if (method === 'POST') {
      const doc = await loadAccounts(root)
      const created = createAccountWithPassword(doc, {
        username: body.username, password: body.password,
        email: body.email, role: body.role === undefined ? 'dev' : body.role,
        note: body.note, expiresInDays: body.expiresInDays,
      })
      if (created.ok !== true) return bad(400, created.error)
      await saveAccounts(root, created.doc)
      return {
        status: 200,
        json: { ok: true, username: String(body.username), role: created.role },
      }
    }
  }

  // ── 管理员：账号的停用 / 恢复 / 续期（docs/19：测试账号默认 7 天过期）─────────
  // 路径形如 POST /org/accounts/<用户名>/status  {status}
  //          POST /org/accounts/<用户名>/renew   {days}
  // 按**用户名**而不是邮箱：管理员手动建的测试账号只有用户名+密码。
  if (segments[1] === 'accounts' && segments.length === 4 && method === 'POST') {
    if (allowed(role, 'account.manage') !== true) return deny(role, 'account.manage')
    const username = decodeURIComponent(segments[2])
    const doc = await loadAccounts(root)

    if (segments[3] === 'status') {
      const status = String(body.status ?? '')
      const result = setStatusByUsername(doc, username, status)
      if (result.ok !== true) return bad(400, result.error)
      await saveAccounts(root, result.doc)
      return { status: 200, json: { ok: true, username: result.username, status: result.status } }
    }

    if (segments[3] === 'renew') {
      const days = body.days === undefined ? DEV_TTL_DAYS : Number(body.days)
      const result = renewAccount(doc, username, days)
      if (result.ok !== true) return bad(400, result.error)
      await saveAccounts(root, result.doc)
      return { status: 200, json: { ok: true, username, expiresAt: result.expiresAt } }
    }

    return bad(404, `没有这个接口：${method} ${path}`)
  }

  // ── 房间（P2a）：建房 / 6 位邀请码加入 / 房间术语库（冻结快照）─────────────
  if (segments[1] === 'rooms' && segments.length === 2) {
    if (method === 'GET') return { status: 200, json: { ok: true, rooms: listRooms(root) } }
    if (method === 'POST') {
      const name = String(body.name ?? '').trim()
      if (name === '') return bad(400, '房间名不能为空')
      const created = createRoom(root, { name, host: user, now })
      if (created.ok !== true) return bad(400, created.error)
      joinRoom(root, { room: created.room, username: user, lang: body.lang, now })
      return { status: 200, json: { ok: true, room: created.room } }
    }
    return bad(405, '只支持 POST')
  }

  if (method === 'POST' && segments[1] === 'rooms' && segments[2] === 'join' && segments.length === 3) {
    const joined = joinRoom(root, { code: body.code, username: user, lang: body.lang, now })
    if (joined.ok !== true) return bad(400, joined.error)
    return { status: 200, json: { ok: true, room: joined.room, members: joined.members } }
  }

  if (method === 'POST' && segments[1] === 'rooms' && segments[2] === 'leave' && segments.length === 3) {
    const left = leaveRoom(root, { code: body.code ?? null, roomId: body.roomId ?? null, username: user, now })
    if (left.ok !== true) return bad(400, left.error)
    // 发起者退出 = 整场结束（原型规则）；其他人退出只是离开
    return { status: 200, json: { ok: true, closed: left.closed, roomId: left.roomId, members: left.members } }
  }


  // ── 成员管理：移出成员（仅发起者，docs/21 §4.54）──────────────────────
  if (method === 'POST' && segments[1] === 'rooms' && segments[3] === 'members'
      && segments[4] === 'remove' && segments.length === 5) {
    const rawMember = decodeURIComponent(segments[2])
    const roomMember = roomById(root, rawMember) ?? roomByCode(root, rawMember)
    if (roomMember === null) return bad(404, `room not found: ${rawMember}`)
    const removed = removeMember(root, { roomId: roomMember.id, username: String(body.user ?? ''), by: user, now })
    if (removed.ok !== true) return bad(409, removed.error)
    return {
      status: 200,
      json: { ok: true, members: removed.members, releasedFloor: removed.releasedFloor === true, removed: removed.username },
    }
  }

  // ── 发言权互斥（P2b）────────────────────────────────────────────────
  if (segments[1] === 'rooms' && segments[3] === 'floor' && segments.length === 4) {
    const rawF = decodeURIComponent(segments[2])
    const roomF = roomById(root, rawF) ?? roomByCode(root, rawF)
    if (roomF === null) return bad(404, `room not found: ${rawF}`)
    // 已结束的会议：不再给状态、也不再接受开麦/锁定（4.44）。
    // 客户端拿到 closed:true 就该退出房间 —— 让它继续待在屋里是最糟的选择。
    if (isRoomClosed(root, roomF.id)) {
      return { status: 410, json: { ok: false, closed: true, roomId: roomF.id, error: '这个会议已经结束' } }
    }
    if (method === 'GET') {
      // 先清掉"锁着麦但人已经不在"的状态（4.42）：没人来抢时，这里就是唯一的清理点。
      // 清掉了就把原因带回给客户端，让界面能说一句"XX 掉线，麦克风已释放"。
      const swept = sweepExpiredFloor(root, roomF.id, Date.parse(now) || Date.now())
      // 清掉了就广播一次：让**所有人**都看到"麦克风已释放"，而不是只有正在轮询的这台
      if (swept.released !== null && typeof input.onFloorSwept === 'function') {
        input.onFloorSwept(roomF.id, swept)
      }
      return {
        status: 200,
        json: {
          ok: true,
          ...floorState(root, roomF.id),
          leaseMs: FLOOR_LEASE_MS,
          lockedLeaseMs: FLOOR_LOCKED_LEASE_MS,
          released: swept.released,
          releasedLocked: swept.locked,
        },
      }
    }
    if (method === 'POST') {
      const action = String(body.action ?? '')
      if (action === 'take') {
        const result = takeFloor(root, { roomId: roomF.id, username: user, now })
        if (result.ok !== true) return bad(409, result.error)
        return { status: 200, json: { ok: true, ...result.state, tookOver: result.tookOver ?? null, reason: result.reason ?? null, releasedLocked: result.releasedLocked === true } }
      }
      if (action === 'release') {
        const result = releaseFloor(root, { roomId: roomF.id, username: user, now })
        if (result.ok !== true) return bad(409, result.error)
        return { status: 200, json: { ok: true, ...result.state, released: result.released } }
      }
      if (action === 'lock' || action === 'unlock') {
        const result = setFloorLock(root, { roomId: roomF.id, username: user, host: roomF.host, locked: action === 'lock', now })
        if (result.ok !== true) return bad(409, result.error)
        return { status: 200, json: { ok: true, ...result.state } }
      }
      if (action === 'heartbeat') {
        const result = heartbeatFloor(root, { roomId: roomF.id, username: user, now })
        if (result.ok !== true) return bad(409, result.error)
        return { status: 200, json: { ok: true } }
      }
      if (action === 'force-release') {
        const result = forceReleaseFloor(root, { roomId: roomF.id, by: user, host: roomF.host, now })
        if (result.ok !== true) return bad(409, result.error)
        return { status: 200, json: { ok: true, ...result.state, released: result.released } }
      }
      return bad(400, `unknown action: ${action}`)
    }
  }
  if (segments[1] === 'rooms' && segments.length === 3) {
    const raw = decodeURIComponent(segments[2])
    const room = roomById(root, raw) ?? roomByCode(root, raw)
    if (room === null) return bad(404, `room not found: ${raw} (use room.id or 6-digit code)`)
    if (method === 'GET') return { status: 200, json: { ok: true, room, members: listMembers(root, room.id), libraryIds: roomLibraries(root, room.id) } }
  }
  if (method === 'POST' && segments[1] === 'rooms' && segments[3] === 'libraries' && segments.length === 4) {
    const rawId = decodeURIComponent(segments[2])
    const room = roomById(root, rawId) ?? roomByCode(root, rawId)
    if (room === null) return bad(404, `room not found: ${rawId} (use room.id or 6-digit code)`)
    const roomId = room.id
    const libraryIds = Array.isArray(body.libraryIds) ? body.libraryIds.map(String) : []
    const saved = setRoomLibraries(root, roomId, libraryIds)
    if (saved.ok !== true) return bad(400, saved.error)
    const published = await publishMeetingTerms(root, { libraryIds, owner: user, meetingId: roomId, now })
    // publishMeetingTerms 不返回 ok 字段（返回 meetingId/entries/conflicts）——不要再按 ok 判断
    return { status: 200, json: { ok: true, roomId, libraryIds, entries: published.entries, meetingId: published.meetingId, conflicts: published.conflicts ?? [] } }
  }

  return bad(404, `没有这个接口：${method} ${path}`)
}
