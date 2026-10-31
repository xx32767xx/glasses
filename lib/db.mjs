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

/** 一个数据目录一个库文件：`<data-dir>/leion.db`。 */
export const dbPath = (dataDir) => join(String(dataDir), 'leion.db')

/** 打开（或创建）库，并保证 pragma 与表结构就绪。 */
export function openDb(file) {
  if (file !== ':memory:') {
    const parent = dirname(file)
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
  }
  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA busy_timeout = 3000')
    migrate(db)
    // 4.68：加列不受版本号控制（见 COLUMN_PATCHES 的注释）
    reconcileColumns(db)
    reconcileTables(db)
  } catch (error) {
    try { db.close() } catch { /* 已经坏了，关不掉就算了 */ }
    throw explainDbError(file, error)
  }
  return db
}

/**
 * 把 SQLite 的原始错误翻成“下一步该做什么”。
 *
 * <p>实际撞过的情形：整个镜像搬到新服务器后，管理员登录只报一句
 * {@code database disk image is malformed} —— 看不出是哪个库、为什么坏、
 * 也不知道有没有救。这里把库路径与处置方法一并写进异常消息。
 */
function explainDbError(file, error) {
  const raw = String(error?.message ?? error)
  if (/malformed|not a database|corrupt|disk image/i.test(raw) !== true) return error
  const hint = [
    `数据库损坏：${file}`,
    `原始错误：${raw}`,
    '',
    '常见原因（参看 docs/20 §13）：',
    '  · 搬迁时 relay 还在写，拷到了半页数据；',
    '  · 只拷了 leion.db、没拷 leion.db-wal（最近的提交丢了）；',
    '  · -wal / -shm 与主库不是同一次拷的（两半对不上）。',
    '',
    '处置：先停 relay，再跑',
    '  node scripts/doctor-db.mjs            # 体检：区分“真坏”与“只是 WAL 过期”',
    '  node scripts/doctor-db.mjs --fix      # 修（先备份，再 VACUUM INTO 重建）',
  ].join('\n')
  const wrapped = new Error(hint)
  wrapped.cause = error
  return wrapped
}

/** 幂等建表。改表结构时把新版本写进 `migrations`，别改已发布的那段。 */
/**
 * 旧库需要补上的列。
 *
 * <p>⚠️ 这一张表是为了回应一个真实 bug（4.68）：`ALTER TABLE requests ADD COLUMN hidden_at`
 * 被写在了 `migrate()` 的**版本门禁之后** —— 已经是最新版本的库
 * （`user_version == SCHEMA_VERSION`）直接 return，那句 ALTER 永远不会执行，
 * 运行时报 `no such column: hidden_at`。
 *
 * <p>教训：**加列不能受版本号控制**。以后新增列往这里加一条。
 */
/**
 * 新增的**表**。和 COLUMN_PATCHES 一样，每次 openDb 都要跑一遍——
 * `CREATE TABLE IF NOT EXISTS` 对已存在的库不生效，而旧库的 `user_version`
 * 早就是最新值，`migrate()` 会直接 return。
 */
export const TABLE_PATCHES = [
  // 4.71：历史记录的"按账号删除"——只影响自己的列表，别人的历史照旧。
  `CREATE TABLE IF NOT EXISTS history_hidden (
     room_id   TEXT NOT NULL,
     username  TEXT NOT NULL,
     hidden_at INTEGER NOT NULL,
     PRIMARY KEY (room_id, username)
   )`,
]

/** 把缺失的表建好（幂等，每次 openDb 都跑）。 */
export function reconcileTables(db) {
  const created = []
  for (const ddl of TABLE_PATCHES) {
    const name = (ddl.match(/CREATE TABLE IF NOT EXISTS (\w+)/) ?? [])[1]
    const exists = db.prepare("SELECT 1 AS yes FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
    db.exec(ddl)
    if (exists === undefined) created.push(name)
  }
  return created
}

export const COLUMN_PATCHES = [
  { table: 'requests', column: 'hidden_at', ddl: 'ALTER TABLE requests ADD COLUMN hidden_at INTEGER' },
  // 5.00：会议的目标语言。中/英/葡任意两种互译时，"译成哪种"必须由**会议**决定，
  // 不能靠"源语种的对面"去猜（三种语言时"对面"不唯一）。
  // 空串 = 老行为（按 opposite(源语言) 推导，即中↔葡互译），所以旧库升级后行为不变。
  { table: 'rooms', column: 'target_lang', ddl: "ALTER TABLE rooms ADD COLUMN target_lang TEXT NOT NULL DEFAULT ''" },
  // 5.00：一句话的**多语言译文**（`{"pt-BR":"...","en-US":"..."}`，最多两项）。
  // 三语会议里同一句会译成两份，但要作为**一行**转写存在（否则转写全文里每句都出现两遍）。
  { table: 'utterances', column: 'dst_by_lang', ddl: "ALTER TABLE utterances ADD COLUMN dst_by_lang TEXT NOT NULL DEFAULT '{}'" },
  // 5.02：**三语术语**。中/英/葡三种写法彼此等价（用户定的规则：一种语言按表里的等价关系
  // 译成另外两种）。允许"两栏"（真实表格常常缺一栏），空串 = 这一栏没登记 ——
  // 那时该目标语言就不注入术语提示（由模型自己译），**不假装有等价关系**。
  { table: 'library_entries', column: 'en', ddl: "ALTER TABLE library_entries ADD COLUMN en TEXT NOT NULL DEFAULT ''" },
  { table: 'library_entries', column: 'en_variants', ddl: "ALTER TABLE library_entries ADD COLUMN en_variants TEXT NOT NULL DEFAULT '[]'" },
  // 申请也允许带上英文栏（否则用户没法申请"只缺英文"的条目）
  { table: 'requests', column: 'en', ddl: 'ALTER TABLE requests ADD COLUMN en TEXT' },
]

/**
 * 把缺失的列补上（幂等，每次 openDb 都跑）。
 * @returns {string[]} 本次真正补上的 `表.列`
 */
export function reconcileColumns(db) {
  const applied = []
  for (const patch of COLUMN_PATCHES) {
    const table = db.prepare("SELECT 1 AS yes FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(patch.table)
    if (table === undefined) continue          // 表还没建（全新库），CREATE 里已带该列
    const columns = db.prepare(`PRAGMA table_info(${patch.table})`).all().map((column) => column.name)
    if (columns.includes(patch.column) !== true) {
      db.exec(patch.ddl)
      applied.push(`${patch.table}.${patch.column}`)
    }
  }
  return applied
}

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
      via          TEXT,
      kdf          TEXT                 -- JSON: {algo,N,r,p}（scrypt 参数，verifyPassword 要用）
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
      updated_at INTEGER NOT NULL,
      priority   INTEGER NOT NULL DEFAULT 0,
      extra      TEXT                   -- JSON：visibility/users/updatedBy/version 等库级可选字段
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
      decided_at INTEGER,
      decision_note TEXT,
      hidden_at  INTEGER,               -- 申请人把这条记录从自己列表里删掉的时间（4.64）
      payload    TEXT                   -- 原始 create 事件（保住 entry/targetKey 等字段）
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
  // 4.64：给 requests 补 hidden_at（申请人可以把自己已审批的记录从列表里删掉）。
  // CREATE TABLE IF NOT EXISTS 不会给**已经存在**的表加列，所以这里单独做一次幂等 ALTER。
  const requestColumns = db.prepare('PRAGMA table_info(requests)').all().map((column) => column.name)
  if (requestColumns.includes('hidden_at') !== true) {
    db.exec('ALTER TABLE requests ADD COLUMN hidden_at INTEGER')
  }

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
      INSERT INTO library_entries
        (library_id, zh, pt, en, variants, approved, en_variants, priority, note, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
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
        // 5.02：三语 —— 中文必有，葡语/英语至少一种（两栏条目里缺的那栏是空串）
        const zh = typeof entry?.zh === 'string' ? entry.zh : null
        const pt = typeof entry?.pt === 'string' ? entry.pt : ''
        const en = typeof entry?.en === 'string' ? entry.en : ''
        if (zh === null || (pt === '' && en === '')) {
          report.skipped.push(`${id}：有条目缺 zh 或中葡英三种语言都不足两种，跳过`)
          continue
        }
        insertEntry.run(id, zh, pt, en,
          JSON.stringify(Array.isArray(entry.variants) ? entry.variants : []),
          JSON.stringify(Array.isArray(entry.approved) ? entry.approved : []),
          JSON.stringify(Array.isArray(entry.enVariants) ? entry.enVariants : []),
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

/** 清理 N 天前的字幕（缺省 7 天）：隐私要求，见 docs/21 §10 的 P4。 */
/**
 * 写一条字幕（4.73）。
 *
 * <p>用途：会议中的**定稿帧**落库，历史详情的"转写全文"读它。
 * 只盘定稿（`is_final = 1`）：增量帧是半句话，落库只会把转写弄成一堆碎片。
 *
 * @returns {{ok: boolean, id?: number, error?: string}}
 */
export function appendUtterance(dataDir, input = {}) {
  const roomId = String(input.roomId ?? '').trim()
  if (roomId === '') return { ok: false, error: '缺少 roomId' }
  const db = openDb(dbPath(dataDir))
  try {
    const startAt = Number.isFinite(input.startAt) ? Number(input.startAt) : Date.now()
    const dstText = String(input.dstText ?? '')
    const dstLang = String(input.dstLang ?? '').trim()
    // 5.00：三语会议里同一句会来**两份**定稿帧（不同目标语言）。这里做一次合并：
    // 同一场会、同一说话人、同一原文、同一源语言，且 60 秒内的两条 → 合成一行，
    // 译文按语言存进 `dst_by_lang`。否则转写全文里每句话都会出现两遍。
    if (dstLang !== '' && dstText !== '') {
      const existing = db.prepare(`SELECT id, dst_by_lang FROM utterances
        WHERE room_id = ? AND username = ? AND src_lang = ? AND src_text = ? AND start_at >= ?
        ORDER BY start_at DESC LIMIT 1`).get(
        roomId, String(input.username ?? ''), String(input.srcLang ?? ''), String(input.srcText ?? ''),
        startAt - 60000)
      if (existing !== undefined && existing !== null) {
        let map = {}
        try { map = JSON.parse(String(existing.dst_by_lang ?? '{}')) ?? {} } catch { map = {} }
        map[dstLang] = dstText
        db.prepare('UPDATE utterances SET dst_by_lang = ? WHERE id = ?')
          .run(JSON.stringify(map), Number(existing.id))
        return { ok: true, id: Number(existing.id), merged: true }
      }
    }
    const byLang = dstLang === '' ? {} : { [dstLang]: dstText }
    const result = db.prepare(`INSERT INTO utterances
      (room_id, username, src_lang, src_text, dst_text, dst_by_lang, start_at, is_final)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      roomId, String(input.username ?? ''), String(input.srcLang ?? ''),
      String(input.srcText ?? ''), dstText, JSON.stringify(byLang), startAt,
      input.isFinal === false ? 0 : 1)
    return { ok: true, id: Number(result.lastInsertRowid ?? 0) }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  } finally { db.close() }
}

export function purgeOldUtterances(db, now = Date.now(), days = 7) {
  const cutoff = now - days * 86400000
  const result = db.prepare('DELETE FROM utterances WHERE start_at < ?').run(cutoff)
  return Number(result.changes ?? 0)
}

/**
 * 打开 → 删老的 → 关（relay 的定时清理用它）。返回删掉的条数。
 *
 * <p>为什么要这个薄封装：`openDb` / `close` 成对出现很容易漏。定时任务每小时跑一次，
 * 漏一个 `close` 一天就是 24 个没释放的 sqlite 句柄。这里只有一处能拿到 db，漏不掉。
 */
export function purgeUtterancesIn(dataDir, now = Date.now(), days = 7) {
  const db = openDb(dbPath(dataDir))
  try {
    return purgeOldUtterances(db, now, days)
  } finally {
    db.close()
  }
}
