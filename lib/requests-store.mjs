/** requests-store.mjs —— 申请的 SQLite 读写（事件式：create 一条 + decision 一次更新）。 */
import { openDb, dbPath } from './db.mjs'

const ms = (text) => { const t = Date.parse(String(text)); return Number.isFinite(t) ? t : Date.now() }
const iso = (n) => new Date(Number(n)).toISOString()

/** 把库里的行还原成"事件流"（与旧 requests.jsonl 的形状一致，loadRequests 无需改动）。 */
export function readRequestEvents(dataDir) {
  const db = openDb(dbPath(dataDir))
  try {
    const rows = db.prepare('SELECT * FROM requests ORDER BY created_at, rowid').all()
    const records = []
    for (const row of rows) {
      let payload = null
      if (row.payload) { try { payload = JSON.parse(String(row.payload)) } catch { payload = null } }
      records.push(payload ?? {
        event: 'create', id: String(row.id), type: String(row.type), libraryId: String(row.library_id),
        entry: { zh: String(row.zh ?? ''), pt: String(row.pt ?? '') }, targetKey: String(row.zh ?? ''),
        reason: String(row.reason ?? ''), applicant: String(row.by ?? ''), at: iso(row.created_at),
      })
      if (row.state && row.state !== 'pending' && row.decided_at) {
        records.push({ event: 'decision', id: String(row.id), decision: String(row.state),
          by: row.decided_by ?? '', at: iso(row.decided_at), note: row.decision_note ?? '' })
      }
      if (row.hidden_at) {
        records.push({ event: 'hide', id: String(row.id), at: iso(row.hidden_at) })
      }
    }
    return { records, badLines: 0, empty: rows.length === 0 }
  } finally { db.close() }
}

/** 追加一个事件：create → 插入行；decision → 更新状态。 */
export function appendRequestEvent(dataDir, record) {
  const db = openDb(dbPath(dataDir))
  try {
    if (record.event === 'create') {
      db.prepare(`INSERT OR REPLACE INTO requests
        (id, type, library_id, zh, pt, reason, by, created_at, state, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
        .run(String(record.id), String(record.type ?? 'add'), String(record.libraryId ?? ''),
          String(record.entry?.zh ?? record.targetKey ?? ''), record.entry?.pt ?? null,
          String(record.reason ?? ''), String(record.applicant ?? ''), ms(record.at),
          JSON.stringify(record))
      return { ok: true }
    }
    if (record.event === 'hide') {
      // 只打标记、不删行：审批记录是审计材料，删掉就说不清当时为什么这么批
      db.prepare('UPDATE requests SET hidden_at = ? WHERE id = ?').run(ms(record.at), String(record.id))
      return { ok: true }
    }
    if (record.event === 'decision') {
      db.prepare('UPDATE requests SET state = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?')
        .run(String(record.decision ?? 'approved'), record.by ?? null, ms(record.at), record.note ?? '', String(record.id))
      return { ok: true }
    }
    return { ok: false, error: `未知事件：${record.event}` }
  } finally { db.close() }
}