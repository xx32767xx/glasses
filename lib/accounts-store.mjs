/**
 * accounts-store.mjs —— 账号的 SQLite 读写（doc 形状 ↔ 行）
 * ============================================================================
 * 为什么单独一个文件、而且先不接线：
 *   上层（relay / org-api / CLI）与全部纯函数都围着 `{users, tokens, codes}` 这个
 *   **doc 形状**写的。直接改 `loadAccounts/saveAccounts` 会把这些一次性拖下水，
 *   上次就是这样把 6 条用例改红的。
 *   所以先把"转换层"独立实现 + 单测钉住（doc → 库 → doc 必须完全等值），
 *   下一步只把 `loadAccounts/saveAccounts` 改成调它，风险收敛到两行。
 *
 * 字段映射（**逐个对过原实现，不猜**）：
 *   users  ：{salt, hash, role, status, createdAt, expiresAt?, email?, note?, via?}
 *   tokens ：{user, label, createdAt}
 *   codes  ：{key, issuedAt, expiresAt}     ← 注意是 `key`，不是 hash
 */

import { openDb, dbPath } from './db.mjs'

const iso = (ms) => new Date(Number(ms)).toISOString()
const ms = (text, fallback = Date.now()) => {
  const parsed = Date.parse(String(text))
  return Number.isFinite(parsed) ? parsed : fallback
}

/** 从库读出 doc 形状。 */
export function readAccountsDoc(dataDir) {
  const db = openDb(dbPath(dataDir))
  try {
    const users = {}
    for (const row of db.prepare('SELECT * FROM accounts').all()) {
      const record = {
        salt: String(row.salt), hash: String(row.password_hash),
        role: String(row.role), status: String(row.status),
        createdAt: iso(row.created_at), via: row.via ?? 'admin',
      }
      // scrypt 参数（algo/N/r/p）必须还原，否则 verifyPassword 一定失败 —— 这是踩过的坑
      if (row.kdf) { try { Object.assign(record, JSON.parse(String(row.kdf))) } catch { /* 老行没有参数 */ } }
      if (row.expires_at !== null && row.expires_at !== undefined) record.expiresAt = iso(row.expires_at)
      if (row.email) record.email = String(row.email)
      if (row.note) record.note = String(row.note)
      users[row.username] = record
    }
    const tokens = {}
    for (const row of db.prepare('SELECT * FROM tokens').all()) {
      tokens[row.token_hash] = { user: String(row.username), label: row.label ?? '', createdAt: iso(row.created_at) }
    }
    const codes = {}
    for (const row of db.prepare('SELECT * FROM auth_codes').all()) {
      // 表里只存了 expires_at；issuedAt 用同一个 TTL 反推（它只用于展示，不参与校验）
      codes[row.email] = {
        key: String(row.code_hash),
        issuedAt: iso(Number(row.expires_at) - 10 * 60 * 1000),
        expiresAt: iso(row.expires_at),
      }
    }
    const hasRows = Object.keys(users).length > 0
      || Object.keys(tokens).length > 0 || Object.keys(codes).length > 0
    return { version: 1, users, tokens, codes, empty: hasRows === false }
  } finally {
    db.close()
  }
}

/** 把 doc 整表写回库（一个事务；要么全成要么全滚）。 */
export function writeAccountsDoc(dataDir, doc) {
  const db = openDb(dbPath(dataDir))
  try {
    db.exec('BEGIN IMMEDIATE')
    db.exec('DELETE FROM tokens')
    db.exec('DELETE FROM auth_codes')
    db.exec('DELETE FROM accounts')
    const insertUser = db.prepare(`INSERT INTO accounts
      (username, email, password_hash, salt, role, status, created_at, expires_at, note, via, kdf)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const [username, record] of Object.entries(doc.users ?? {})) {
      if (!record || typeof record !== 'object') continue
      insertUser.run(String(username),
        typeof record.email === 'string' && record.email !== '' ? record.email : null,
        String(record.hash ?? ''), String(record.salt ?? ''),
        String(record.role ?? 'user'), String(record.status ?? 'active'),
        ms(record.createdAt), record.expiresAt ? ms(record.expiresAt) : null,
        typeof record.note === 'string' ? record.note : null,
        typeof record.via === 'string' ? record.via : null,
        JSON.stringify({ algo: record.algo ?? 'scrypt', N: record.N, r: record.r, p: record.p }))
    }
    const insertToken = db.prepare('INSERT INTO tokens (token_hash, username, label, created_at) VALUES (?, ?, ?, ?)')
    for (const [hash, entry] of Object.entries(doc.tokens ?? {})) {
      if (!entry || typeof entry.user !== 'string') continue
      if ((doc.users ?? {})[entry.user] === undefined) continue   // 孤儿 token 不写
      insertToken.run(String(hash), entry.user, typeof entry.label === 'string' ? entry.label : '',
        ms(entry.createdAt))
    }
    const insertCode = db.prepare('INSERT INTO auth_codes (email, code_hash, expires_at) VALUES (?, ?, ?)')
    for (const [email, entry] of Object.entries(doc.codes ?? {})) {
      if (!entry || typeof entry.key !== 'string') continue
      insertCode.run(String(email), entry.key, ms(entry.expiresAt))
    }
    db.exec('COMMIT')
    return { ok: true }
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* 已滚过 */ }
    return { ok: false, error: String(error?.message ?? error) }
  } finally {
    db.close()
  }
}
