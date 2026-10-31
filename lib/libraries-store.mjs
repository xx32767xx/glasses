/** libraries-store.mjs —— 术语库 / 分类的 SQLite 读写（字段与 emptyLibrary() 一比一对齐）。 */
import { openDb, dbPath } from './db.mjs'

const iso = (ms) => new Date(Number(ms)).toISOString()
const st = (text, fallback = Date.now()) => { const t = Date.parse(String(text)); return Number.isFinite(t) ? t : fallback }

/** 读一个库；不存在返回 null。字段与 emptyLibrary() 一致，缺的用默认值补齐。 */
export function readLibraryRow(dataDir, id) {
  const db = openDb(dbPath(dataDir))
  try {
    const row = db.prepare('SELECT * FROM libraries WHERE id = ?').get(String(id))
    if (!row) return null
    let extra = {}
    if (row.extra) { try { extra = JSON.parse(String(row.extra)) } catch { extra = {} } }
    const entries = db.prepare('SELECT * FROM library_entries WHERE library_id = ? ORDER BY id').all(String(id))
    return {
      version: Number(extra.version ?? 1),
      id: String(row.id),
      name: String(row.name),
      categoryId: row.category ?? null,
      priority: Number(row.priority ?? 0),
      visibility: extra.visibility ?? 'public',
      users: Array.isArray(extra.users) ? extra.users : [],
      entries: entries.map((e) => {
        // 5.02：三语 —— `en` 那一栏必须读写都带上，否则"存进去一个空、读出来还是空"，
        // 而界面上看不出是谁弄丢的（这一层原来是 zh/pt 硬编码的两栏）。
        const entry = { zh: String(e.zh), pt: String(e.pt ?? ''), en: String(e.en ?? '') }
        try { const v = JSON.parse(String(e.variants ?? '[]')); if (v.length) entry.variants = v } catch { /* 坏 JSON 忽略 */ }
        try { const a = JSON.parse(String(e.approved ?? '[]')); if (a.length) entry.approved = a } catch { /* 同上 */ }
        try {
          const en = JSON.parse(String(e.en_variants ?? '[]'))
          // 只保留"不等于规范写法"的那些，免得读回来变成一个自己指向自己的变体
          const extra = en.filter((form) => typeof form === 'string' && form !== '' && form !== entry.en)
          if (extra.length) entry.enVariants = extra
        } catch { /* 同上 */ }
        if (Number(e.priority) !== 0) entry.priority = Number(e.priority)
        if (e.note) entry.note = String(e.note)
        return entry
      }),
      createdAt: row.created_at ? iso(row.created_at) : null,
      updatedAt: row.updated_at ? iso(row.updated_at) : null,
      updatedBy: extra.updatedBy ?? null,
    }
  } finally { db.close() }
}

export function listLibraryRows(dataDir) {
  const db = openDb(dbPath(dataDir))
  try { return db.prepare('SELECT id FROM libraries ORDER BY name').all().map((r) => String(r.id)) } finally { db.close() }
}

export function writeLibraryRow(dataDir, library) {
  const db = openDb(dbPath(dataDir))
  try {
    db.exec('BEGIN IMMEDIATE')
    db.prepare(`INSERT INTO libraries (id, name, category, owner, created_at, updated_at, priority, extra)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, category=excluded.category, owner=excluded.owner,
        updated_at=excluded.updated_at, priority=excluded.priority, extra=excluded.extra`)
      .run(String(library.id), String(library.name ?? library.id), library.categoryId ?? null,
        library.updatedBy ?? null, st(library.createdAt), st(library.updatedAt),
        Number(library.priority ?? 0),
        JSON.stringify({ version: library.version ?? 1, visibility: library.visibility ?? 'public',
          users: library.users ?? [], updatedBy: library.updatedBy ?? null }))
    db.prepare('DELETE FROM library_entries WHERE library_id = ?').run(String(library.id))
    const insert = db.prepare(`INSERT INTO library_entries
      (library_id, zh, pt, en, variants, approved, en_variants, priority, note, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const entry of library.entries ?? []) {
      insert.run(String(library.id), String(entry.zh), String(entry.pt ?? ''), String(entry.en ?? ''),
        JSON.stringify(entry.variants ?? []), JSON.stringify(entry.approved ?? []),
        JSON.stringify(entry.enVariants ?? []),
        Number(entry.priority ?? 0), entry.note ?? null, st(library.updatedAt))
    }
    db.exec('COMMIT')
    return { ok: true }
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* 已滚 */ }
    return { ok: false, error: String(error?.message ?? error) }
  } finally { db.close() }
}

export function readCategoriesDoc(dataDir) {
  const db = openDb(dbPath(dataDir))
  try {
    const rows = db.prepare('SELECT * FROM categories ORDER BY name').all()
    return { version: 1, updatedAt: null, categories: rows.map((r) => ({ id: String(r.id), name: String(r.name) })) }
  } finally { db.close() }
}

export function writeCategoriesDoc(dataDir, doc) {
  const db = openDb(dbPath(dataDir))
  try {
    db.exec('BEGIN IMMEDIATE')
    db.exec('DELETE FROM categories')
    const insert = db.prepare('INSERT OR REPLACE INTO categories (id, name) VALUES (?, ?)')
    for (const item of doc.categories ?? []) insert.run(String(item.id), String(item.name))
    db.exec('COMMIT')
    return { ok: true }
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* 已滚 */ }
    return { ok: false, error: String(error?.message ?? error) }
  } finally { db.close() }
}