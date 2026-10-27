/**
 * floor.mjs —— 发言权互斥（P2b）
 *
 * 规则来自原型（docs/21 §3）：
 *   ① 同一房间**同一时刻最多一人持麦**（floor_state 一房一行，事务内切换）；
 *   ② 点开麦即持麦、再点关麦；**他人持麦且未锁定时，后开麦者顶替**（抢麦），被顶替方收到通知；
 *   ③ 他人持麦且**已锁定**时，开麦被拒，提示「XX 正在发言（发言已锁定）」；
 *   ④ 锁定/解锁共用一个动作；**仅管理者（host）可解除他人锁定**；
 *   ⑤ 同时到达按**服务端到达顺序**裁决（单写者 + 事务串行化，不做队列）；
 *   ⑥ 断线超过 15 秒视为释放。
 */
import { openDb, dbPath } from './db.mjs'

/** 断线宽限（毫秒）：超过这个时间没心跳就认为人走了，麦自动释放。 */
export const FLOOR_LEASE_MS = 15000

const nowMs = (text) => { const t = Date.parse(String(text ?? '')); return Number.isFinite(t) ? Number(t) : Date.now() }

/** 读当前发言权状态（没有记录 = 空麦）。 */
export function floorState(dataDir, roomId) {
  const db = openDb(dbPath(dataDir))
  try {
    const row = db.prepare('SELECT * FROM floor_state WHERE room_id = ?').get(String(roomId))
    if (row === undefined) return { roomId: String(roomId), holder: null, locked: false, since: null }
    return {
      roomId: String(row.room_id),
      holder: row.holder ?? null,
      locked: Number(row.locked) === 1,
      since: row.since ? new Date(Number(row.since)).toISOString() : null,
    }
  } finally { db.close() }
}

function writeState(db, roomId, holder, locked, at) {
  db.prepare(`INSERT INTO floor_state (room_id, holder, locked, since) VALUES (?, ?, ?, ?)
    ON CONFLICT(room_id) DO UPDATE SET holder = excluded.holder, locked = excluded.locked, since = excluded.since`)
    .run(String(roomId), holder, locked ? 1 : 0, at)
}

/**
 * 开麦。
 * @returns {{ok:boolean, error?:string, state?:object, tookOver?:string|null, reason?:string}}
 *   tookOver 非空 = 顶替了谁（调用方据此广播「XX 接管了麦克风」）
 */
export function takeFloor(dataDir, options = {}) {
  const roomId = String(options.roomId ?? '')
  const username = String(options.username ?? '')
  if (roomId === '' || username === '') return { ok: false, error: '缺少 roomId 或 username' }
  const at = nowMs(options.now)
  const db = openDb(dbPath(dataDir))
  try {
    // BEGIN IMMEDIATE：抢麦必须串行化，否则两个人同时开麦会出现"都以为自己拿到"
    db.exec('BEGIN IMMEDIATE')
    const row = db.prepare('SELECT * FROM floor_state WHERE room_id = ?').get(roomId)
    const holder = row?.holder ?? null
    const locked = Number(row?.locked ?? 0) === 1
    const since = row?.since ? Number(row.since) : 0

    // ⑥ 断线释放：持有者太久没心跳 → 视为空麦
    if (holder !== null && !locked && since !== 0 && at - since > FLOOR_LEASE_MS) {
      writeState(db, roomId, username, false, at)
      db.exec('COMMIT')
      return { ok: true, tookOver: null, reason: 'previous-lease-expired', state: floorState(dataDir, roomId) }
    }

    if (holder === null || holder === username) {
      writeState(db, roomId, username, holder === username ? locked : false, at)
      db.exec('COMMIT')
      return { ok: true, tookOver: null, state: floorState(dataDir, roomId) }
    }

    // ② 抢麦：未锁定 → 顶替
    if (!locked) {
      writeState(db, roomId, username, false, at)
      db.exec('COMMIT')
      return { ok: true, tookOver: holder, state: floorState(dataDir, roomId) }
    }

    // ③ 已锁定 → 拒绝
    db.exec('COMMIT')
    return { ok: false, error: `${holder} 正在发言（发言已锁定）`, holder, locked: true }
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* 已滚 */ }
    return { ok: false, error: String(error?.message ?? error) }
  } finally { db.close() }
}

/** 关麦（只有持麦者能关；管理员关别人的走 releaseFloorByAdmin）。 */
export function releaseFloor(dataDir, options = {}) {
  const roomId = String(options.roomId ?? '')
  const username = String(options.username ?? '')
  const db = openDb(dbPath(dataDir))
  try {
    const row = db.prepare('SELECT * FROM floor_state WHERE room_id = ?').get(roomId)
    if (!row || (row.holder ?? null) === null) return { ok: true, released: false, state: floorState(dataDir, roomId) }
    if (row.holder !== username) return { ok: false, error: '不是你在发言' }
    writeState(db, roomId, null, false, nowMs(options.now))
    return { ok: true, released: true, state: floorState(dataDir, roomId) }
  } finally { db.close() }
}

/** 锁定 / 解锁发言。**解除他人锁定只有 host 可以**。 */
export function setFloorLock(dataDir, options = {}) {
  const roomId = String(options.roomId ?? '')
  const username = String(options.username ?? '')
  const locked = options.locked === true
  const host = String(options.host ?? '')
  const db = openDb(dbPath(dataDir))
  try {
    const row = db.prepare('SELECT * FROM floor_state WHERE room_id = ?').get(roomId)
    const holder = row?.holder ?? null
    if (holder === null) return { ok: false, error: '当前没人发言，无法锁定' }
    if (holder !== username && host !== username) {
      return { ok: false, error: `${holder} 正在发言，只有发起者可以解除他人的锁定` }
    }
    writeState(db, roomId, holder, locked, row?.since ? Number(row.since) : nowMs(options.now))
    return { ok: true, state: floorState(dataDir, roomId) }
  } finally { db.close() }
}

/** 心跳：更新 since，防止被"断线释放"误伤（客户端每 5 秒调一次）。 */
export function heartbeatFloor(dataDir, options = {}) {
  const roomId = String(options.roomId ?? '')
  const username = String(options.username ?? '')
  const db = openDb(dbPath(dataDir))
  try {
    const row = db.prepare('SELECT * FROM floor_state WHERE room_id = ?').get(roomId)
    if (!row || row.holder !== username) return { ok: false, error: '不是持麦者' }
    db.prepare('UPDATE floor_state SET since = ? WHERE room_id = ?').run(nowMs(options.now), roomId)
    return { ok: true }
  } finally { db.close() }
}

/** 管理员强制收回（主要用于主持场景）；返回被收回的人。 */
export function forceReleaseFloor(dataDir, options = {}) {
  const roomId = String(options.roomId ?? '')
  const by = String(options.by ?? '')
  const host = String(options.host ?? '')
  if (by !== host) return { ok: false, error: '只有发起者可以强制收回发言权' }
  const db = openDb(dbPath(dataDir))
  try {
    const row = db.prepare('SELECT * FROM floor_state WHERE room_id = ?').get(roomId)
    const holder = row?.holder ?? null
    writeState(db, roomId, null, false, nowMs(options.now))
    return { ok: true, released: holder, state: floorState(dataDir, roomId) }
  } finally { db.close() }
}