/**
 * db.mjs —— 单文件 SQLite 访问层（Node 22+ 内置 `node:sqlite`，零外部依赖）
 * ============================================================================
 * 为什么换掉 JSON：
 *   ① 房间与发言权需要**原子互斥**（同一时刻只有一人持麦）——JSON 文件没有事务，
 *      两个人同时开麦时"读-改-写"会互相覆盖；
 *   ② 字幕是持续增长的时间序列，JSON 只能整文件重写；
 *   ③ 迁移/备份/清理（7 天）用 SQL 一句话，不用自己写遍历。
 *
 * 设计约定：
 *   - **一个库文件**（默认 `<data-dir>/leion.db`），WAL 模式、外键打开、忙等 3 秒；
 *   - 表结构由 `migrate()` 幂等创建，`PRAGMA user_version` 记版本；
 *   - 所有时间戳用 **epoch 毫秒整数**（跨语言比较不会踩时区）；
 *   - 账号密码哈希/盐沿用 lib/accounts.mjs 的既有格式，不在这里重算。
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const SCHEMA_VERSION = 1

/** 打开（或创建）库，并保证 pragma 与表结构就绪。 */
export function openDb(file) {
  if (file !== ':memory:') {
    const parent = dirname(file)
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
  }
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 3000')
  migrate(db)
  return db
}

/** 幂等建表。改表结构时把新版本写进 `migrations`，别改已发布的那段。 */
export function migrate(db) {
  const current = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0)
  if (current >= SCHEMA_VERSION) return current

  db.exec(`
    -- ── 账号 ────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS accounts (
      username     TEXT PRIMARY KEY,
      email        TEXT UNIQUE,
      password_hash TEXT NOT NULL,       -- scrypt 十六进制
      salt         TEXT NOT NULL,
      role         TEXT NOT NULL,        -- admin / user / dev
      status       TEXT NOT NULL,        -- active / disabled
      created_at   INTEGER NOT NULL,
      expires_at   INTEGER,              -- NULL = 永久
      note         TEXT,
      via          TEXT
    );
    CREATE TABLE IF NOT EXISTS tokens (
      token_hash TEXT PRIMARY KEY,
      username   TEXT NOT NULL REFERENCES accounts(username) ON DELETE CASCADE,
      label      TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_codes (
      email      TEXT PRIMARY KEY,
      code_hash  TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );

    -- ── 术语库 ──────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS categories (
      id   TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS libraries (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      category   TEXT,
      owner      TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS library_entries (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
      zh         TEXT NOT NULL,
      pt         TEXT NOT NULL,
      variants   TEXT NOT NULL DEFAULT '[]',   -- JSON 数组：中文侧变体
      approved   TEXT NOT NULL DEFAULT '[]',   -- JSON 数组：葡语侧可接受写法
      priority   INTEGER NOT NULL DEFAULT 0,
      note       TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_entries_library ON library_entries(library_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_uniq ON library_entries(library_id, zh);

    -- ── 用户申请（原 requests.jsonl）────────────────────────────────────
    CREATE TABLE IF NOT EXISTS requests (
      id         TEXT PRIMARY KEY,
      type       TEXT NOT NULL,          -- add / update / delete
      library_id TEXT NOT NULL,
      zh         TEXT NOT NULL,
      pt         TEXT,
      reason     TEXT NOT NULL,
      by         TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      state      TEXT NOT NULL,          -- pending / approved / rejected / withdrawn
      decided_by TEXT,
      decided_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_requests_state ON requests(state, created_at);

    -- ── 房间与成员（P2a）────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS rooms (
      id         TEXT PRIMARY KEY,
      code       TEXT NOT NULL UNIQUE,   -- 6 位邀请码，唯一凭证
      name       TEXT NOT NULL,
      host       TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      closed_at  INTEGER
    );
    CREATE TABLE IF NOT EXISTS room_members (
      room_id   TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      username  TEXT NOT NULL,
      lang      TEXT,                    -- 我的参会语言
      joined_at INTEGER NOT NULL,
      left_at   INTEGER,
      PRIMARY KEY (room_id, username)
    );
    -- 房间级术语库快照（进房时冻结，改动不影响本场）
    CREATE TABLE IF NOT EXISTS room_libraries (
      room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      library_id TEXT NOT NULL,
      PRIMARY KEY (room_id, library_id)
    );

    -- ── 发言权互斥（P2b）：单行主键就是那把锁 ───────────────────────────
    CREATE TABLE IF NOT EXISTS floor_state (
      room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
      holder  TEXT,                      -- NULL = 麦克风空闲
      locked  INTEGER NOT NULL DEFAULT 0,-- 1 = 锁定发言
      since   INTEGER NOT NULL
    );

    -- ── 字幕（7 天清理）─────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS utterances (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id   TEXT NOT NULL,
      username  TEXT NOT NULL,
      src_lang  TEXT,
      src_text  TEXT,
      dst_text  TEXT,
      start_at  INTEGER NOT NULL,
      is_final  INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_utterances_room ON utterances(room_id, start_at);
    CREATE INDEX IF NOT EXISTS idx_utterances_time ON utterances(start_at);

    -- ── 设置（服务器地址/密钥/语种等，键值）─────────────────────────────
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  return SCHEMA_VERSION
}

/* ──────────────────────────────────────────────────────────────────────────
 * 旧 JSON → SQLite 一次性导入
 *
 * 为什么放在库里而不是只写在脚本里：**迁移的一致性要用测试钉住**
 * （账号/库/申请条数必须逐项对上），测试直接调这个函数比调 CLI 稳。
 * 幂等：已存在的行用 INSERT OR REPLACE / 先删后插，重复跑不会翻倍。
 * ────────────────────────────────────────────────────────────────────────── */

const num = (value, fallback = 0) => {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function importFromDataDir(db, dataDir) {
  const report = { accounts: 0, libraries: 0, entries: 0, requests: 0, skipped: [] }

  // ① 账号
  const accountsFile = join(dataDir, 'accounts.json')
  if (existsSync(accountsFile)) {
    let doc
    try { doc = JSON.parse(readFileSync(accountsFile, 'utf-8')) } catch (error) {
      report.skipped.push(`accounts.json 解析失败：${error.message}`)
      doc = null
    }
    if (doc) {
      const insert = db.prepare(`
        INSERT OR REPLACE INTO accounts
          (username, email, password_hash, salt, role, status, created_at, expires_at, note, via)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      for (const [username, record] of Object.entries(doc.users ?? {})) {
        if (!record || typeof record !== 'object') continue
        if (typeof record.hash !== 'string' || typeof record.salt !== 'string') {
          report.skipped.push(`账号 ${username}：缺 hash/salt，跳过`)
          continue
        }
        insert.run(
          username,
          typeof record.email === 'string' && record.email !== '' ? record.email : null,
          record.hash, record.salt,
          typeof record.role === 'string' ? record.role : 'user',
          typeof record.status === 'string' ? record.status : 'active',
          num(record.createdAt, Date.now()),
          record.expiresAt ? num(record.expiresAt) : null,
          typeof record.note === 'string' ? record.note : null,
          typeof record.via === 'string' ? record.via : null,
        )
        report.accounts += 1
      }
      const insertToken = db.prepare(
        'INSERT OR REPLACE INTO tokens (token_hash, username, label, created_at) VALUES (?, ?, ?, ?)')
      const hasAccount = db.prepare('SELECT 1 AS ok FROM accounts WHERE username = ?')
      for (const [hash, entry] of Object.entries(doc.tokens ?? {})) {
        const user = typeof entry?.user === 'string' ? entry.user : null
        if (user === null) continue
        // 孤儿 token（指向已删除/改名的账号）：外键会拒绝，这里**跳过并报告**，
        // 不让整个迁移失败 —— JSON 没有外键，这类垃圾平时根本看不出来。
        if (!hasAccount.get(user)) {
          report.skipped.push(`token 指向不存在的账号：${user}`)
          continue
        }
        insertToken.run(hash, user, typeof entry.label === 'string' ? entry.label : null,
          num(entry.createdAt, Date.now()))
      }
    }
  }

  // ② 术语库
  const libDir = join(dataDir, 'libraries')
  if (existsSync(libDir)) {
    const insertLib = db.prepare(`
      INSERT OR REPLACE INTO libraries (id, name, category, owner, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
    const clearEntries = db.prepare('DELETE FROM library_entries WHERE library_id = ?')
    const insertEntry = db.prepare(`
      INSERT INTO library_entries (library_id, zh, pt, variants, approved, priority, note, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const name of readdirSync(libDir).filter(item => item.endsWith('.json'))) {
      let library
      try { library = JSON.parse(readFileSync(join(libDir, name), 'utf-8')) } catch (error) {
        report.skipped.push(`${name} 解析失败：${error.message}`)
        continue
      }
      const id = typeof library.id === 'string' ? library.id : name.replace(/\.json$/, '')
      const createdAt = num(library.createdAt, Date.now())
      const updatedAt = num(library.updatedAt, createdAt)
      insertLib.run(id, String(library.name ?? id), library.category ?? null,
        library.owner ?? null, createdAt, updatedAt)
      if (library.category) {
        db.prepare('INSERT OR IGNORE INTO categories (id, name) VALUES (?, ?)')
          .run(String(library.category), String(library.category))
      }
      clearEntries.run(id)
      for (const entry of library.entries ?? []) {
        if (typeof entry?.zh !== 'string' || typeof entry?.pt !== 'string') {
          report.skipped.push(`${id}：有条目缺 zh/pt，跳过`)
          continue
        }
        insertEntry.run(id, entry.zh, entry.pt,
          JSON.stringify(Array.isArray(entry.variants) ? entry.variants : []),
          JSON.stringify(Array.isArray(entry.approved) ? entry.approved : []),
          Number.isInteger(entry.priority) ? entry.priority : 0,
          typeof entry.note === 'string' ? entry.note : null,
          num(entry.updatedAt, updatedAt))
        report.entries += 1
      }
      report.libraries += 1
    }
  }

  // ③ 申请（jsonl，一行一条）
  const requestsFile = join(dataDir, 'requests.jsonl')
  if (existsSync(requestsFile)) {
    const insert = db.prepare(`
      INSERT OR REPLACE INTO requests
        (id, type, library_id, zh, pt, reason, by, created_at, state, decided_by, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const line of readFileSync(requestsFile, 'utf-8').split('\n')) {
      const text = line.trim()
      if (text === '') continue
      let item
      try { item = JSON.parse(text) } catch { report.skipped.push('requests.jsonl 有坏行，跳过'); continue }
      if (typeof item.id !== 'string') continue
      // 孤儿申请（库已不存在）：同上，报告而不整体失败
      const libraryId = String(item.libraryId ?? '')
      if (!db.prepare('SELECT 1 AS ok FROM libraries WHERE id = ?').get(libraryId)) {
        report.skipped.push(`申请 ${item.id} 指向不存在的库：${libraryId}`)
        continue
      }
      insert.run(item.id, String(item.type ?? 'add'), libraryId,
        String(item.zh ?? ''), item.pt ?? null, String(item.reason ?? ''),
        String(item.by ?? ''), num(item.at, Date.now()), String(item.state ?? 'pending'),
        item.decidedBy ?? null, item.decidedAt ? num(item.decidedAt) : null)
      report.requests += 1
    }
  }

  return report
}

/** 清理 7 天前的字幕（P4 用它；这里先给出可测的实现）。 */
export function purgeOldUtterances(db, now = Date.now(), days = 7) {
  const cutoff = now - days * 86400000
  const result = db.prepare('DELETE FROM utterances WHERE start_at < ?').run(cutoff)
  return Number(result.changes ?? 0)
}
