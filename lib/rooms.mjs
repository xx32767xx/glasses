/**
 * rooms.mjs —— 房间与成员（P2a）
 *
 * 规则来自原型（docs/21）：
 *   ① 入会唯一凭证是 **6 位邀请码**（没有密码）；
 *   ② 房间有自己的术语库选择：进房时冻结一份快照，会后改库不影响这一场；
 *   ③ 成员以用户名记录（同一用户重复加入幂等）。
 *
 * 互斥（发言权）不在这里 —— 那是 P2b 的 floor_state。
 */
import { openDb, dbPath } from './db.mjs'

const nowMs = (text) => { const t = Date.parse(String(text ?? '')); return Number.isFinite(t) ? Number(t) : Date.now() }

/** 生成 6 位数字邀请码（避开前导 0 看起来像少一位的情况；冲突由 UNIQUE 兜底重试）。 */
export function newRoomCode(random = Math.random) {
  return String(100000 + Math.floor(random() * 900000))
}

export function createRoom(dataDir, options = {}) {
  const db = openDb(dbPath(dataDir))
  try {
    const id = options.id ?? `room-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const name = String(options.name ?? '').trim() || '未命名会议'
    const host = String(options.host ?? '')
    const createdAt = nowMs(options.now)
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = options.code ?? newRoomCode()
      try {
        db.prepare('INSERT INTO rooms (id, code, name, host, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(id, code, name, host, createdAt)
        // 建房者自动成为成员（否则「房间 1 人却没有成员」这种状态会到处漏）
        if (host !== '') {
          db.prepare('INSERT OR IGNORE INTO room_members (room_id, username, joined_at) VALUES (?, ?, ?)')
            .run(id, host, createdAt)
        }
        return { ok: true, room: { id, code, name, host, createdAt: new Date(createdAt).toISOString() } }
      } catch (error) {
        if (!String(error?.message ?? '').includes('UNIQUE') || options.code) {
          return { ok: false, error: String(error?.message ?? error) }
        }
        // 邀请码撞了（极其偶然）→ 换一个再试
      }
    }
    return { ok: false, error: '邀请码分配失败（连续冲突）' }
  } finally { db.close() }
}

export function roomById(dataDir, id) {
  const db = openDb(dbPath(dataDir))
  try {
    const row = db.prepare('SELECT * FROM rooms WHERE id = ?').get(String(id ?? ''))
    if (row === undefined || row === null) return null
    return {
      id: String(row.id),
      code: String(row.code),
      name: String(row.name),
      host: String(row.host),
      // 4.46：把"这场还在不在"一并带出来。客户端拿房间详情时就能判断
      // "发起者已经散会了"，不必等轮询某个专门的状态端点。
      closed: row.closed_at !== null && row.closed_at !== undefined,
    }
  } finally { db.close() }
}

export function roomByCode(dataDir, code) {
  const db = openDb(dbPath(dataDir))
  try {
    const row = db.prepare('SELECT * FROM rooms WHERE code = ? AND closed_at IS NULL').get(String(code ?? '').trim())
    return row ? { id: String(row.id), code: String(row.code), name: String(row.name), host: String(row.host) } : null
  } finally { db.close() }
}

export function joinRoom(dataDir, options = {}) {
  const room = options.room ?? roomByCode(dataDir, options.code)
  if (room === null) return { ok: false, error: '邀请码无效，或这场会已经结束' }
  const username = String(options.username ?? '')
  if (username === '') return { ok: false, error: '缺少用户名' }
  const db = openDb(dbPath(dataDir))
  try {
    db.prepare(`INSERT INTO room_members (room_id, username, lang, joined_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(room_id, username) DO UPDATE SET left_at = NULL, lang = COALESCE(excluded.lang, lang)`)
      .run(room.id, username, options.lang ?? null, nowMs(options.now))
    return { ok: true, room, members: listMembers(dataDir, room.id) }
  } finally { db.close() }
}

export function listMembers(dataDir, roomId) {
  const db = openDb(dbPath(dataDir))
  try {
    return db.prepare('SELECT username, lang, joined_at FROM room_members WHERE room_id = ? AND left_at IS NULL ORDER BY joined_at')
      .all(String(roomId))
      .map((row) => ({ username: String(row.username), lang: row.lang ?? null,
        joinedAt: new Date(Number(row.joined_at)).toISOString() }))
  } finally { db.close() }
}

/**
 * 把某个成员移出房间（**只有发起者**能这么做）。
 *
 * <p>为什么需要：原型的管理者在「人员与设备」抽屉里可以移出成员。
 * 没有这个能力时，一个误入的人只能靠"自己退"——对方不退，发起人毫无办法。
 *
 * <p>语义选择：这里做的是**软移除**（把 `left_at` 置上），不是删行 ——
 * 这样对方重新凭码进来还能正常加入（`joinRoom` 里是 `ON CONFLICT ... left_at = NULL`）。
 * 硬删会让"被踢的人再也进不来"，而那需要另一套黑名单，我们没有。
 *
 * <p>同时会释放他占着的麦：人被移出后仍持麦，会让整屋人开不了口（floor 租约 15 秒才兜底）。
 *
 * @returns {{ok: boolean, error?: string, members?: object[], releasedFloor?: boolean}}
 */
export function removeMember(dataDir, options = {}) {
  const roomId = String(options.roomId ?? '')
  const username = String(options.username ?? '')
  const by = String(options.by ?? '')
  if (roomId === '' || username === '') return { ok: false, error: '缺少 roomId 或 username' }
  const db = openDb(dbPath(dataDir))
  try {
    const room = db.prepare('SELECT id, host FROM rooms WHERE id = ?').get(roomId)
    if (room === undefined || room === null) return { ok: false, error: '房间不存在' }
    if (String(room.host) !== by) return { ok: false, error: '只有发起者可以移出成员' }
    if (username === by) return { ok: false, error: '发起者不能移出自己（要结束会议请用退出）' }
    const row = db.prepare('SELECT username FROM room_members WHERE room_id = ? AND username = ? AND left_at IS NULL')
      .get(roomId, username)
    if (row === undefined || row === null) return { ok: false, error: `${username} 不在这个房间里` }

    const at = nowMs(options.now)
    db.exec('BEGIN IMMEDIATE')
    db.prepare('UPDATE room_members SET left_at = ? WHERE room_id = ? AND username = ?').run(at, roomId, username)
    const floor = db.prepare('SELECT holder FROM floor_state WHERE room_id = ?').get(roomId)
    let releasedFloor = false
    if (floor !== undefined && floor !== null && (floor.holder ?? null) === username) {
      db.prepare('UPDATE floor_state SET holder = NULL, locked = 0, since = ? WHERE room_id = ?').run(at, roomId)
      releasedFloor = true
    }
    db.exec('COMMIT')
    return { ok: true, members: listMembers(dataDir, roomId), releasedFloor, username }
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* 已滚 */ }
    return { ok: false, error: String(error?.message ?? error) }
  } finally { db.close() }
}

export function setRoomLibraries(dataDir, roomId, libraryIds) {
  const db = openDb(dbPath(dataDir))
  try {
    db.exec('BEGIN IMMEDIATE')
    db.prepare('DELETE FROM room_libraries WHERE room_id = ?').run(String(roomId))
    const insert = db.prepare('INSERT OR IGNORE INTO room_libraries (room_id, library_id) VALUES (?, ?)')
    for (const id of libraryIds ?? []) insert.run(String(roomId), String(id))
    db.exec('COMMIT')
    return { ok: true, libraryIds: (libraryIds ?? []).map(String) }
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* 已滚 */ }
    return { ok: false, error: String(error?.message ?? error) }
  } finally { db.close() }
}

export function roomLibraries(dataDir, roomId) {
  const db = openDb(dbPath(dataDir))
  try {
    return db.prepare('SELECT library_id FROM room_libraries WHERE room_id = ? ORDER BY library_id')
      .all(String(roomId)).map((row) => String(row.library_id))
  } finally { db.close() }
}

/** 退出房间。**发起者（host）退出 = 整场结束**（closed_at 置位，之后凭码进不来）。 */
export function leaveRoom(dataDir, options = {}) {
  const room = options.room ?? roomById(dataDir, options.roomId) ?? roomByCode(dataDir, options.code)
  if (room === null) return { ok: false, error: 'room not found' }
  const username = String(options.username ?? '')
  if (username === '') return { ok: false, error: 'missing username' }
  const db = openDb(dbPath(dataDir))
  try {
    const at = nowMs(options.now)
    const closed = username === room.host
    db.prepare('UPDATE room_members SET left_at = ? WHERE room_id = ? AND username = ? AND left_at IS NULL')
      .run(at, room.id, username)
    // 走的人如果正持麦，必须顺手把麦放开 —— 否则对面侧边栏会一直显示"XX 正在发言"
    const floor = db.prepare('SELECT holder FROM floor_state WHERE room_id = ?').get(room.id)
    if (floor && floor.holder === username) {
      db.prepare('UPDATE floor_state SET holder = NULL, locked = 0, since = ? WHERE room_id = ?').run(at, room.id)
    }
    if (closed) db.prepare('UPDATE rooms SET closed_at = ? WHERE id = ? AND closed_at IS NULL').run(at, room.id)
    return { ok: true, closed, roomId: room.id, members: listMembers(dataDir, room.id) }
  } finally { db.close() }
}

/** 房间是否已结束（host 退出后为 true）。 */
export function isRoomClosed(dataDir, roomId) {
  const db = openDb(dbPath(dataDir))
  try {
    const row = db.prepare('SELECT closed_at FROM rooms WHERE id = ?').get(String(roomId))
    return row !== undefined && row.closed_at !== null && row.closed_at !== undefined
  } finally { db.close() }
}
/** 列出未结束的房间（管理员界面「会议列表」用）。 */
export function listRooms(dataDir) {
  const db = openDb(dbPath(dataDir))
  try {
    return db.prepare(`
      SELECT r.id, r.code, r.name, r.host, r.created_at,
             (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id AND m.left_at IS NULL) AS members,
             (SELECT holder FROM floor_state f WHERE f.room_id = r.id) AS holder
      FROM rooms r WHERE r.closed_at IS NULL ORDER BY r.created_at DESC`).all().map((row) => ({
      id: String(row.id), code: String(row.code), name: String(row.name), host: String(row.host),
      members: Number(row.members ?? 0), holder: row.holder ?? null,
      createdAt: new Date(Number(row.created_at)).toISOString(),
    }))
  } finally { db.close() }
}