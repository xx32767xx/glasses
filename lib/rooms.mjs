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
    // 5.00：目标语言（中/英/葡任意两种互译时必须显式给；空串 = 老行为按 opposite 推导）
    const targetLang = String(options.targetLang ?? '').trim()
    const createdAt = nowMs(options.now)
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = options.code ?? newRoomCode()
      try {
        db.prepare('INSERT INTO rooms (id, code, name, host, created_at, target_lang) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, code, name, host, createdAt, targetLang)
        // 建房者自动成为成员（否则「房间 1 人却没有成员」这种状态会到处漏）
        if (host !== '') {
          db.prepare('INSERT OR IGNORE INTO room_members (room_id, username, joined_at) VALUES (?, ?, ?)')
            .run(id, host, createdAt)
        }
        return { ok: true, room: { id, code, name, host, targetLang, createdAt: new Date(createdAt).toISOString() } }
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
      // 5.00：会议的目标语言（空串 = 按 opposite(源语言) 推导的老行为）
      targetLang: String(row.target_lang ?? ''),
    }
  } finally { db.close() }
}

export function roomByCode(dataDir, code) {
  const db = openDb(dbPath(dataDir))
  try {
    const row = db.prepare('SELECT * FROM rooms WHERE code = ? AND closed_at IS NULL').get(String(code ?? '').trim())
    return row ? { id: String(row.id), code: String(row.code), name: String(row.name), host: String(row.host),
      targetLang: String(row.target_lang ?? '') } : null
  } finally { db.close() }
}

export const MEMBER_MODES = ['onsite', 'remote']

export function joinRoom(dataDir, options = {}) {
  const room = options.room ?? roomByCode(dataDir, options.code)
  if (room === null) return { ok: false, error: '邀请码无效，或这场会已经结束' }
  const username = String(options.username ?? '')
  if (username === '') return { ok: false, error: '缺少用户名' }
  // 5.04：参会方式（面对面 / 远程）。**只接受这两种取值**，其它一律当作"没说"（NULL），
  // 不做默认猜测 —— 默认猜错会让"面对面不许外放"这类规则以后落到错误的人身上。
  const mode = MEMBER_MODES.includes(options.mode) ? options.mode : null
  const db = openDb(dbPath(dataDir))
  try {
    db.prepare(`INSERT INTO room_members (room_id, username, lang, mode, joined_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(room_id, username) DO UPDATE SET left_at = NULL,
        lang = COALESCE(excluded.lang, lang), mode = COALESCE(excluded.mode, mode)`)
      .run(room.id, username, options.lang ?? null, mode, nowMs(options.now))
    return { ok: true, room, members: listMembers(dataDir, room.id) }
  } finally { db.close() }
}

export function listMembers(dataDir, roomId) {
  const db = openDb(dbPath(dataDir))
  try {
    return db.prepare('SELECT username, lang, mode, joined_at FROM room_members WHERE room_id = ? AND left_at IS NULL ORDER BY joined_at')
      .all(String(roomId))
      .map((row) => ({ username: String(row.username), lang: row.lang ?? null,
        // null = 这个成员没说过自己是面对面还是远程（老客户端）
        mode: MEMBER_MODES.includes(row.mode) ? row.mode : null,
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
/**
 * 历史记录（4.69）：我参加过的会议，按时间倒序。
 *
 * <p>为什么是“我参加过的”而不是“所有会议”：历史是个人的东西，把别人的会议
 * 列进来既没用也泄露信息。
 *
 * <p>每条要回答卡片上的六任：名称 / 类型 / 时间 / 时长 / 人数 / 语言。
 *
 * <ul>
 *   <li>时长 = closed_at - created_at；还没结束的用 now - created_at（卡片上标“进行中”）；</li>
 *   <li>人数 = 过去进过这场会议的**不同人数**（不只算还在里面的）——
 *       会议结束后没人在里面，用"left_at IS NULL"会永远得 0；</li>
 *   <li>语言 = 成员们报过的参会语言去重（客户端拿它组成“中文 ↔ 巴西葡语”）。</li>
 * </ul>
 *
 * @returns {{items: object[], total: number}}
 */
/**
 * 管理员视角的"历史数据清单"（4.99）。
 *
 * <p>为什么要给管理员看这些：会议一多、转写一多，`utterances` 与 `audio/` 会一直长
 * （测试环境尤其明显，那些数据本来也没有保留价值）。但"该删哪些"必须**看得见**才能决定 ——
 * 所以这里把每场会的数据量、时间跨度都列出来，而不是让管理员盲删。
 *
 * <p>与 `listHistory` 的区别：那个是**某个用户**的列表（还会过滤掉他自己删掉的），
 * 这个是**整台机器**的清单，包含已结束的会议。
 *
 * @returns {{items: Array, totals: {rooms: number, utterances: number}, activeRooms: number}}
 */
export function listHistoryForAdmin(dataDir, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(2000, Number(options.limit))) : 500
  const db = openDb(dbPath(dataDir))
  try {
    const rows = db.prepare(`
      SELECT r.id, r.code, r.name, r.host, r.created_at, r.closed_at,
             (SELECT COUNT(DISTINCT m.username) FROM room_members m WHERE m.room_id = r.id) AS members,
             (SELECT COUNT(*) FROM utterances u WHERE u.room_id = r.id) AS utterances,
             (SELECT MIN(u.start_at) FROM utterances u WHERE u.room_id = r.id) AS first_at,
             (SELECT MAX(u.start_at) FROM utterances u WHERE u.room_id = r.id) AS last_at
      FROM rooms r
      ORDER BY r.created_at DESC
      LIMIT ?`).all(limit)
    const items = rows.map((row) => {
      const createdAt = Number(row.created_at)
      const closedAt = row.closed_at === null || row.closed_at === undefined ? null : Number(row.closed_at)
      return {
        id: String(row.id),
        code: String(row.code),
        name: String(row.name),
        host: String(row.host),
        active: closedAt === null,
        createdAt: new Date(createdAt).toISOString(),
        closedAt: closedAt === null ? null : new Date(closedAt).toISOString(),
        members: Number(row.members ?? 0),
        utterances: Number(row.utterances ?? 0),
        firstAt: row.first_at === null || row.first_at === undefined ? null : new Date(Number(row.first_at)).toISOString(),
        lastAt: row.last_at === null || row.last_at === undefined ? null : new Date(Number(row.last_at)).toISOString(),
      }
    })
    const totals = {
      rooms: Number(db.prepare('SELECT COUNT(*) AS n FROM rooms').get()?.n ?? 0),
      utterances: Number(db.prepare('SELECT COUNT(*) AS n FROM utterances').get()?.n ?? 0),
      activeRooms: Number(db.prepare('SELECT COUNT(*) AS n FROM rooms WHERE closed_at IS NULL').get()?.n ?? 0),
    }
    return { items, totals }
  } finally { db.close() }
}

/**
 * 管理员清理历史数据（4.99）。
 *
 * <p><b>这是管理员动作，会真的删数据</b>（不是"从我的列表里藏起来"——那是 4.71 的
 * `hideHistoryForUser`）。三种范围：
 *
 * <ul>
 *   <li>{@code mode:'rooms'}：只删点名的房间（`roomIds`）；</li>
 *   <li>{@code mode:'older-than'}：删 `days` 天以前**已结束**的会议（默认 7 天）；</li>
 *   <li>{@code mode:'all'}：删全部**已结束**的会议（进行中的永远不删 —— 删了正在开的会就是事故）。</li>
 * </ul>
 *
 * <p>删的是：会议行（外键级联带走成员/术语快照/发言权/待办）+ 该会议的全部字幕行；
 * **文件不由这一层管**（音频、总线、收件箱在 relay 手里，见它的 `purgeHistoryFiles`）。
 *
 * @returns {{ok: boolean, roomIds: string[], deletedRooms: number, deletedUtterances: number, skipped: Array<{id: string, why: string}>}}
 */
export function purgeHistory(dataDir, options = {}) {
  const mode = String(options.mode ?? 'older-than')
  const days = Number.isFinite(options.days) ? Math.max(0, Number(options.days)) : 7
  // ⚠️ dryRun 必须在这里实现（不能只在 CLI 里"不调用"）：
  //    第一版 CLI 为了"先算会删什么"调了一次 purgeHistory —— 于是**预览就删了**。
  //    凡是"会删数据"的函数，都该自己带一个 dry-run，调用方不该靠"不调用它"来预览。
  const dryRun = options.dryRun === true
  const now = nowMs(options.now)
  const cutoff = now - days * 24 * 60 * 60 * 1000
  const db = openDb(dbPath(dataDir))
  try {
    let targets = []
    const skipped = []
    if (mode === 'rooms') {
      const wanted = Array.isArray(options.roomIds) ? options.roomIds.map(id => String(id ?? '').trim()) : []
      for (const id of wanted) {
        if (id === '') continue
        const row = db.prepare('SELECT id, closed_at FROM rooms WHERE id = ?').get(id)
        if (row === undefined) { skipped.push({ id, why: '没有这场会议' }); continue }
        if (row.closed_at === null || row.closed_at === undefined) {
          skipped.push({ id, why: '这场会还在进行，不删' })
          continue
        }
        targets.push(id)
      }
    } else if (mode === 'all') {
      targets = db.prepare('SELECT id FROM rooms WHERE closed_at IS NOT NULL').all().map(row => String(row.id))
    } else if (mode === 'older-than') {
      targets = db.prepare('SELECT id FROM rooms WHERE closed_at IS NOT NULL AND closed_at < ?')
        .all(cutoff).map(row => String(row.id))
    } else {
      return { ok: false, error: `不认识的模式 ${JSON.stringify(mode)}（rooms / older-than / all）`, roomIds: [], deletedRooms: 0, deletedUtterances: 0, skipped: [] }
    }

    if (targets.length === 0) {
      return { ok: true, roomIds: [], deletedRooms: 0, deletedUtterances: 0, skipped }
    }
    if (dryRun === true) {
      // 只数、不删：CLI 的 --dry-run 与"先看会删什么"都走这里
      let plannedUtterances = 0
      for (const roomId of targets) {
        plannedUtterances += Number(db.prepare('SELECT COUNT(*) AS n FROM utterances WHERE room_id = ?')
          .get(roomId)?.n ?? 0)
      }
      return { ok: true, roomIds: targets, deletedRooms: 0, deletedUtterances: plannedUtterances, skipped, dryRun: true }
    }
    let deletedUtterances = 0
    let deletedRooms = 0
    // 一条事务里做完：删一半会留下"房间没了、字幕还在"的孤儿数据。
    // ⚠️ `node:sqlite` 没有 better-sqlite3 那种 `db.transaction()`，所以自己 BEGIN/COMMIT，
    // 出错 ROLLBACK（事务里删到一半比"什么都没删"更糟：管理员看到部分成功会以为删完了）。
    db.exec('BEGIN')
    try {
      for (const roomId of targets) {
        deletedUtterances += Number(db.prepare('DELETE FROM utterances WHERE room_id = ?').run(roomId).changes ?? 0)
        deletedRooms += Number(db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId).changes ?? 0)
      }
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* 已经回滚了 */ }
      return { ok: false, error: String(error?.message ?? error), roomIds: [], deletedRooms: 0, deletedUtterances: 0, skipped }
    }
    return { ok: true, roomIds: targets, deletedRooms, deletedUtterances, skipped }
  } finally { db.close() }
}

/**
 * **某个用户**的历史列表（4.69）：只返回他参加过的，且过滤掉他自己删掉的。
 * 管理员的"整机清单"是 {@link listHistoryForAdmin}，别混用（那个包含已结束的会议）。
 */
export function listHistory(dataDir, options = {}) {
  const user = String(options.user ?? '')
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(200, Number(options.limit))) : 50
  const now = nowMs(options.now)
  const db = openDb(dbPath(dataDir))
  try {
    const rows = db.prepare(`
      SELECT r.id, r.code, r.name, r.host, r.created_at, r.closed_at,
             (SELECT COUNT(DISTINCT m.username) FROM room_members m WHERE m.room_id = r.id) AS members,
             (SELECT COUNT(*) FROM utterances u WHERE u.room_id = r.id) AS utterances
      FROM rooms r
      JOIN room_members me ON me.room_id = r.id AND me.username = ?
      -- 4.71：我自己删掉的不再出现；删的是「我的列表」，不是会议本身
      LEFT JOIN history_hidden h ON h.room_id = r.id AND h.username = ?
      WHERE h.room_id IS NULL
      ORDER BY r.created_at DESC
      LIMIT ?`).all(user, user, limit)
    const items = rows.map((row) => {
      const createdAt = Number(row.created_at)
      const closedAt = row.closed_at === null || row.closed_at === undefined ? null : Number(row.closed_at)
      const endedAt = closedAt === null ? now : closedAt
      const langs = db.prepare(`SELECT DISTINCT lang FROM room_members
        WHERE room_id = ? AND lang IS NOT NULL AND lang <> '' ORDER BY lang`).all(String(row.id))
        .map((one) => String(one.lang))
      return {
        id: String(row.id),
        code: String(row.code),
        name: String(row.name),
        host: String(row.host),
        // 类型只有两种：会议 / 同传翻译官。以后同传翻译官也写进这张表时才会出现第二种。
        kind: 'meeting',
        createdAt: new Date(createdAt).toISOString(),
        closedAt: closedAt === null ? null : new Date(closedAt).toISOString(),
        durationSeconds: Math.max(0, Math.round((endedAt - createdAt) / 1000)),
        active: closedAt === null,
        members: Number(row.members ?? 0),
        utterances: Number(row.utterances ?? 0),
        langs,
      }
    })
    const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM rooms r
      JOIN room_members me ON me.room_id = r.id AND me.username = ?
      LEFT JOIN history_hidden h ON h.room_id = r.id AND h.username = ?
      WHERE h.room_id IS NULL`).get(user, user)?.n ?? 0)
    return { items, total }
  } finally {
    db.close()
  }
}

/**
 * 按**账号**删除一条历史记录（4.71）。
 *
 * <p>语义（用户明确）：只从**这个账号的历史列表**里去掉。
 * 会议、字幕、其它参伎者的历史一律不动 —— 不是删会议，也不是删字幕。
 *
 * <p>为什么边界要这么定：会议是**共享事实**（别人也在里面开过会），
 * 一个人删了会议本身或字幕，对别人就是数据损坏。
 *
 * @returns {{ok: boolean, error?: string, roomId?: string}}
 */
export function hideHistoryForUser(dataDir, options = {}) {
  const user = String(options.user ?? '').trim()
  const roomId = String(options.roomId ?? '').trim()
  if (user === '') return { ok: false, error: '缺少用户名' }
  if (roomId === '') return { ok: false, error: '缺少要删的记录（roomId）' }
  const db = openDb(dbPath(dataDir))
  try {
    // 只能删自己参加过的：否则任意人都能往别人的历史里塞过滤条目
    const member = db.prepare('SELECT 1 AS yes FROM room_members WHERE room_id = ? AND username = ?')
      .get(roomId, user)
    if (member === undefined) return { ok: false, error: '你没有参加过这场会议' }
    const at = nowMs(options.now)
    db.prepare(`INSERT INTO history_hidden (room_id, username, hidden_at) VALUES (?, ?, ?)
      ON CONFLICT(room_id, username) DO UPDATE SET hidden_at = excluded.hidden_at`).run(roomId, user, at)
    return { ok: true, roomId }
  } finally { db.close() }
}

/**
 * 读一场会议的转写全文（4.72）。
 *
 * <p>数据源是 `utterances` 表（`is_final = 1` 的那些），按时间正序。
 * ⚠️ 目前**没有任何代码往表里写**（只有保留期清理在读它），
 * 所以这个接口现在返回的是空数组 —— 界面上就应该如实显示"还没有转写内容"。
 *
 * <p>只给**参伎者**看：字幕是会议内容，没参加过的人不该读得到。
 */
/**
 * 一帧字幕应归属哪场会议（4.73）。
 *
 * <p>字幕总线（`subtitle-bus.json`）是**全局**的：谁在推就谁看，不带房间。
 * 而 `utterances.room_id` 要知道归属，所以这里做一个**可解释的推断**：
 *
 * <ol>
 *   <li>帧里带的 speaker 正好是某场会议的持麦者 → 就是那场会（最准）；</li>
 *   <li>speaker 对不上（识别侧的人名可能跟账号不一样）但全局**只有一场**
 *       未结束的会议有人持麦 → 归它；</li>
 *   <li>不能确定（多场都有人在说）→ 放弃并告诉调用方为什么。</li>
 * </ol>
 *
 * <p>宁可不记，也不猜：把字幕写到错的会议里，比少一条难查得多。
 *
 * @returns {{roomId: string|null, reason: string}}
 */
/** 音频上传与帧到达的时差容忍：超过就不能拿"刚刚上传音频的房间"当依据。 */
export const AUDIO_ROOM_TTL_MS = 30000

/**
 * 一帧字幕应归属哪场会（多房间并发的第一步，4.74）。
 *
 * <p>优先级（从硬到软）：
 * <ol>
 *   <li><b>帧里带的 roomId</b> —— 最硬，不需要任何推断；</li>
 *   <li><b>刚刚往哪个房间上传过音频</b>（{@link #AUDIO_ROOM_TTL_MS} 内）——
 *       很强的信号：字幕就是那段音频转出来的；</li>
 *   <li>旧的持麦者推断（{@link roomForFrame}）—— 老客户端没带 room 参数时的兜底。</li>
 * </ol>
 *
 * @returns {{roomId: string|null, reason: string}}
 */
export function resolveFrameRoom(dataDir, options = {}) {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now()
  const audioRoomId = String(options.audioRoomId ?? '').trim()
  const audioAt = Number(options.audioAt ?? 0)
  // ① 帧里带了 roomId：roomForFrame 的第一档会直接命中
  if (String(options.frameRoomId ?? '').trim() !== '') {
    return roomForFrame(dataDir, options.speaker ?? '', options.frameRoomId)
  }
  // ② 刚上传过音频的房间（且那场会还没结束）
  if (audioRoomId !== '' && now - audioAt <= AUDIO_ROOM_TTL_MS) {
    const open = roomIsOpen(dataDir, audioRoomId)
    if (open === true) return { roomId: audioRoomId, reason: 'recent-audio-room' }
  }
  // ③ 兜底：持麦者推断
  return roomForFrame(dataDir, options.speaker ?? '')
}

/** 会议还在不在（给"刚上传音频的房间"做校验用）。 */
export function roomIsOpen(dataDir, roomId) {
  const id = String(roomId ?? '').trim()
  if (id === '') return false
  const db = openDb(dbPath(dataDir))
  try {
    const row = db.prepare('SELECT 1 AS yes FROM rooms WHERE id = ? AND closed_at IS NULL').get(id)
    return row !== undefined
  } finally { db.close() }
}

export function roomForFrame(dataDir, speaker, frameRoomId = '') {
  const name = String(speaker ?? '').trim()
  const hint = String(frameRoomId ?? '').trim()
  const db = openDb(dbPath(dataDir))
  try {
    // ① 帧里直接带了 roomId（将来的协议）→ 完全不需要猜。
    //    只要那场会确实存在且没结束，就直接归它；带的是个假 id 就当没带。
    if (hint !== '') {
      const open = db.prepare('SELECT 1 AS yes FROM rooms WHERE id = ? AND closed_at IS NULL').get(hint)
      if (open !== undefined) return { roomId: hint, reason: 'frame-room-id' }
    }
    const holders = db.prepare(`
      SELECT f.room_id AS roomId, f.holder AS holder
      FROM floor_state f JOIN rooms r ON r.id = f.room_id
      WHERE f.holder IS NOT NULL AND r.closed_at IS NULL`).all()
    if (name !== '') {
      const matched = holders.filter((row) => String(row.holder) === name)
      if (matched.length === 1) return { roomId: String(matched[0].roomId), reason: 'speaker-is-holder' }
      if (matched.length > 1) return { roomId: null, reason: 'speaker-holder-ambiguous' }
    }
    if (holders.length === 1) return { roomId: String(holders[0].roomId), reason: 'only-one-floor' }
    if (holders.length === 0) return { roomId: null, reason: 'no-active-floor' }
    return { roomId: null, reason: 'multiple-floors' }
  } finally { db.close() }
}

export function listRoomTranscript(dataDir, options = {}) {
  const roomId = String(options.roomId ?? '').trim()
  const user = String(options.user ?? '').trim()
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(2000, Number(options.limit))) : 500
  if (roomId === '' || user === '') return { ok: false, error: '缺少 roomId 或 username' }
  const db = openDb(dbPath(dataDir))
  try {
    const member = db.prepare('SELECT 1 AS yes FROM room_members WHERE room_id = ? AND username = ?')
      .get(roomId, user)
    if (member === undefined) return { ok: false, error: '你没有参加过这场会议' }
    const rows = db.prepare(`SELECT id, username, src_lang, src_text, dst_text, start_at, is_final
      FROM utterances WHERE room_id = ? AND is_final = 1 ORDER BY start_at LIMIT ?`).all(roomId, limit)
    return {
      ok: true,
      roomId,
      lines: rows.map((row) => ({
        id: Number(row.id),
        username: String(row.username ?? ''),
        srcLang: String(row.src_lang ?? ''),
        srcText: String(row.src_text ?? ''),
        dstText: String(row.dst_text ?? ''),
        at: new Date(Number(row.start_at)).toISOString(),
        final: Number(row.is_final ?? 1) === 1,
      })),
    }
  } finally { db.close() }
}

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
      targetLang: String(row.target_lang ?? ''),
      createdAt: new Date(Number(row.created_at)).toISOString(),
    }))
  } finally { db.close() }
}