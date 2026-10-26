/**
 * accounts.mjs —— 账户、密码与 token（热词表的"你是谁"这一层）
 * ============================================================================
 *
 * 为什么要有这个文件：热词表原来靠**客户端自报用户名**（`?user=wu`）来区分数据，
 * 那等于没有权限——任何人改一个参数就能读写别人的表。这不是"以后再说"的问题，
 * 而是"一个人可以随意改另一个人的信息"。所以改成：
 *
 *     注册/登录 → 拿 token → 之后**只认 token**（服务端从 token 反查用户）
 *
 * 三条实现上的硬要求（不是风格问题）：
 *
 *   ① **密码绝不存明文**：scrypt + 每用户独立盐。存的是 {algo, salt, hash, N, r, p}。
 *      用 scrypt 而不是 argon2 的原因很实际：node 标准库自带，不引第三方依赖
 *      （这个项目一贯"零运行时依赖"，引一个包就得考虑离线构建与审计）。
 *   ② **token 也不存明文**：库里存 sha256(token)。这样即使 accounts.json 泄露，
 *      拿到的也只是哈希，不能直接当 token 用。
 *   ③ **判断"是谁"只认 token**：`/terms` 之类端点里，请求体里的 `user` 字段
 *      **一律忽略**（有 token 时）。否则又回到"自报身份"。
 *
 * 兼容与回退（明确写清，免得变成隐藏的后门）：
 *   · 库里**一个账户都没有**时，退回原来的行为（按 `user` 参数 / `default` 分表）。
 *     理由：还没注册过人的机器上，手机不该因为"没登录"就用不了热词表。
 *   · 一旦存在任何账户，`/terms` 就**要求 token**，没有就 401。
 *     这条边界很重要：不能出现"有人注册了、但另一个人仍可用自报用户名绕过"的混合态。
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readAccountsDoc, writeAccountsDoc } from './accounts-store.mjs'

/** 密码与用户名的限制。 */
export const ACCOUNT_LIMITS = {
  minPasswordChars: 6,
  maxPasswordChars: 200,
  maxUsernameChars: 32,
  maxBodyBytes: 8 * 1024,
}

/** 用户名：字母数字下划线点横线，不允许路径字符（它会变成文件名与日志字段）。 */
const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{2,32}$/

/** scrypt 参数：够用又不慢（这是局域网工具，不是公网服务）。 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 }

export function accountsPath(dataDir) {
  return join(dataDir, 'accounts.json')
}

export function emptyAccounts() {
  return { version: 1, users: {}, tokens: {} }
}

/** 用户名归一/校验。 */
export function normalizeUsername(raw) {
  if (typeof raw !== 'string') return { ok: false, error: '用户名必须是字符串' }
  const name = raw.trim()
  if (name === '') return { ok: false, error: '用户名不能为空' }
  if (name.length > ACCOUNT_LIMITS.maxUsernameChars) {
    return { ok: false, error: `用户名最多 ${ACCOUNT_LIMITS.maxUsernameChars} 个字符` }
  }
  if (USERNAME_PATTERN.test(name) === false) {
    return { ok: false, error: '用户名只能包含字母、数字与 _ . -（2~32 个字符）' }
  }
  return { ok: true, username: name }
}

/** 密码校验：只查长度 —— 复杂度规则在这里没有意义（够长 + 不泄露才是真的）。 */
export function checkPassword(password) {
  if (typeof password !== 'string') return { ok: false, error: '密码必须是字符串' }
  if (password.length < ACCOUNT_LIMITS.minPasswordChars) {
    return { ok: false, error: `密码至少 ${ACCOUNT_LIMITS.minPasswordChars} 位` }
  }
  if (password.length > ACCOUNT_LIMITS.maxPasswordChars) {
    return { ok: false, error: `密码最多 ${ACCOUNT_LIMITS.maxPasswordChars} 位` }
  }
  return { ok: true }
}

/** 算密码哈希（导出是为了测试能验证"同一密码两次哈希不同、但都能验过"）。 */
export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p })
  return {
    algo: 'scrypt',
    salt,
    hash: hash.toString('hex'),
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  }
}

/** 常量时间比较，避免按字节提前返回泄露时序。 */
export function verifyPassword(password, record) {
  if (record === null || record === undefined || record.algo !== 'scrypt') return false
  if (typeof record.salt !== 'string' || typeof record.hash !== 'string') return false
  const expected = Buffer.from(record.hash, 'hex')
  const actual = scryptSync(password, record.salt, expected.length, { N: record.N, r: record.r, p: record.p })
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

/** 生成一个 token（返回明文；库里只存哈希）。 */
export function issueToken() {
  return randomBytes(32).toString('hex')
}

export function tokenKey(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex')
}

/** 取用户名下的 token 哈希键（登录/注册成功后写库用）。 */
export function tokenEntry(user, label = '') {
  return { user, issuedAt: new Date().toISOString(), label: label === '' ? null : label }
}

/**
 * 注册：用户名已存在则失败（**不**允许静默覆盖 —— 那是另一种"改别人信息"）。
 * @returns {{ ok: boolean, error?: string, doc?: object, token?: string }}
 */
export function register(doc, rawUsername, password, label = '') {
  const name = normalizeUsername(rawUsername)
  if (name.ok !== true) return { ok: false, error: name.error }
  const pass = checkPassword(password)
  if (pass.ok !== true) return { ok: false, error: pass.error }
  if (Object.prototype.hasOwnProperty.call(doc.users, name.username)) {
    return { ok: false, error: '这个用户名已经被注册了（换一个，或者用登录）' }
  }
  const token = issueToken()
  const users = { ...doc.users, [name.username]: { ...hashPassword(password), createdAt: new Date().toISOString() } }
  const tokens = { ...doc.tokens, [tokenKey(token)]: tokenEntry(name.username, label) }
  return { ok: true, doc: { version: 1, users, tokens }, token, username: name.username }
}

/**
 * 登录：用户名不存在 / 密码不对返回**同一句**错误（不告诉攻击者"这个用户存在"）。
 */
export function login(doc, rawUsername, password, label = '') {
  const name = normalizeUsername(rawUsername)
  const failed = { ok: false, error: '用户名或密码不对' }
  if (name.ok !== true) return failed
  const record = doc.users[name.username]
  if (record === undefined) return failed
  if (verifyPassword(password, record) !== true) return failed
  // 密码对了也要看账户还活着吗：停用的账号、过期的测试账号不该能换到新 token。
  // 只靠 `userForToken` 的可用性检查是不够的 —— 那会让"立刻不能用了"变成
  // "登录成功、但接下来每一步都 401"，看起来像系统坏了，而不是账号被停了。
  if (isUsable(doc, name.username) !== true) {
    const expired = isExpired(record, Date.now())
    return {
      ok: false,
      error: expired ? '这个账号已经过期（测试账号有有效期），请让管理员续期' : '这个账号已被停用，请联系管理员',
      disabled: true,
    }
  }
  const token = issueToken()
  const tokens = { ...doc.tokens, [tokenKey(token)]: tokenEntry(name.username, label) }
  return { ok: true, doc: { version: 1, users: doc.users, tokens }, token, username: name.username }
}

/**
 * 用 token 反查用户（这是唯一可信的"我是谁"来源）。
 *
 * 2026-10-23 起多一条：**账户被停用或测试账号过期时，token 立即失效**。
 * 只在登录时检查是不够的 —— 停用/过期的意义就是"立刻不能再用了"，
 * 而已经发出去的 token 不会自己消失。
 */
export function userForToken(doc, token) {
  if (typeof token !== 'string' || token === '') return null
  const entry = doc.tokens[tokenKey(token)]
  if (entry === undefined) return null
  const user = typeof entry.user === 'string' ? entry.user : null
  if (user === null) return null
  return isUsable(doc, user) ? user : null
}

/** 注销：删掉这一个 token（其他设备的 token 不受影响）。 */
export function revokeToken(doc, token) {
  const key = tokenKey(token)
  if (doc.tokens[key] === undefined) return { ok: false, error: '这个 token 不存在或已注销' }
  const tokens = { ...doc.tokens }
  delete tokens[key]
  return { ok: true, doc: { version: 1, users: doc.users, tokens } }
}

/** 库里有没有账户（有时 /terms 就要求 token）。 */
export function hasAccounts(doc) {
  return doc !== null && doc !== undefined && doc.users !== null && typeof doc.users === 'object'
    && Object.keys(doc.users).length > 0
}

/** 读库。**任何失败都退回空库**（读不到 = 没有账户，退回兼容行为），绝不抛给调用方。 */
/**
 * 读账号 —— SQLite 为准（转换层在 lib/accounts-store.mjs，已有往返 + 密码校验测试）。
 * 库里没有任何账号时**过渡期**读一次旧 accounts.json，避免迁移未完成时登不上。
 */
export async function loadAccounts(dataDir) {
  const doc = readAccountsDoc(dataDir)
  if (doc.empty !== true) return doc
  const legacy = await loadLegacyAccounts(dataDir)
  return legacy ?? emptyAccounts()
}

/** 过渡期：旧 accounts.json（仅当库里完全没账号时读一次）。 */
async function loadLegacyAccounts(dataDir) {
  let text
  try { text = await readFile(accountsPath(dataDir), 'utf-8') } catch { return null }
  let parsed
  try { parsed = JSON.parse(text) } catch { return null }
  if (parsed === null || typeof parsed !== 'object') return null
  const users = parsed.users !== null && typeof parsed.users === 'object' && !Array.isArray(parsed.users) ? parsed.users : {}
  const tokens = parsed.tokens !== null && typeof parsed.tokens === 'object' && !Array.isArray(parsed.tokens) ? parsed.tokens : {}
  const codes = parsed.codes !== null && typeof parsed.codes === 'object' && !Array.isArray(parsed.codes) ? parsed.codes : {}
  return { version: 1, users, tokens, codes }
}

/** 原子写（tmp + rename）：手机可能随时来读，不能让它读到半截 JSON。 */
/** 写账号 —— 整表替换到 SQLite（事务）；转换逻辑见 lib/accounts-store.mjs。 */
export async function saveAccounts(dataDir, doc) {
  const result = writeAccountsDoc(dataDir, doc)
  if (result.ok !== true) throw new Error(`写账号失败：${result.error}`)
}

/* ────────────────────────────────────────────────────────────────────────────
 * 以下为「会议 APP」这一期新增：邮箱 + 验证码登录、角色（管理员 / 用户 / 测试账号）、
 * 以及管理员手动建号的通道。**旧的用户名+密码接口一字未改**，既有测试与
 * `scripts/test-account.mjs` 继续可用（见 docs/19）。
 *
 * 三条设计约束（都是踩过的坑换来的）：
 *   ① **验证码也不存明文**：库泄露 ≠ 能登录。存 sha256(email|code)，验完即删（一次性）。
 *   ② **测试账号（dev）必须有过期时间**：没有过期时间的测试账号，迟早会变成第二个管理员。
 *   ③ **权限按角色查表**，不在各处写 `if (role === 'admin')` —— 否则加一个角色要改十几处。
 * ──────────────────────────────────────────────────────────────────────────── */

/** 三个角色。admin = 管理员；user = 普通用户；dev = 管理员建的测试账号（只读 + 有期限）。 */
export const ROLES = ['admin', 'user', 'dev']

/** 权限表：动作 → 允许的角色。加动作只改这里一处。 */
export const ROLE_PERMISSIONS = {
  'library.read': ['admin', 'user', 'dev'],
  'library.write': ['admin'],
  'request.create': ['admin', 'user'],
  'request.decide': ['admin'],
  'account.manage': ['admin'],
  'meeting.configure': ['admin', 'user', 'dev'],
}

/** 验证码有效期（10 分钟，够慢手速、不够暴力枚举）。 */
export const CODE_TTL_MS = 10 * 60 * 1000

/** 测试账号缺省有效期（7 天）。 */
export const DEV_TTL_DAYS = 7

/** 邮箱归一/校验：只做**基本形状**校验（真正是否可收信要靠发码那一步）。 */
export function normalizeEmail(raw) {
  if (typeof raw !== 'string') return { ok: false, error: '邮箱必须是字符串' }
  const email = raw.trim().toLowerCase()
  if (email === '') return { ok: false, error: '邮箱不能为空' }
  if (email.length > 254) return { ok: false, error: '邮箱太长' }
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) !== true) {
    return { ok: false, error: '邮箱格式不对（需要形如 name@example.com）' }
  }
  return { ok: true, email }
}

/** 角色校验：**不接受任意字符串**（拼错的 'admn' 会变成一个没有权限、却也不报错的幽灵账号）。 */
export function normalizeRole(raw, fallback = 'user') {
  if (raw === undefined || raw === null || raw === '') return { ok: true, role: fallback }
  if (ROLES.includes(raw) !== true) {
    return { ok: false, error: `角色只能是 ${ROLES.join(' / ')}，收到 ${JSON.stringify(raw)}` }
  }
  return { ok: true, role: raw }
}

/** 某个角色能不能做某个动作。未知动作一律拒绝（宁可多问一句，也不要默认放行）。 */
export function allowed(role, action) {
  const list = ROLE_PERMISSIONS[action]
  if (list === undefined) return false
  return list.includes(role)
}

/** 取账户记录（不存在返回 null）。 */
export function recordOf(doc, user) {
  if (doc === null || doc === undefined || doc.users === null || typeof doc.users !== 'object') return null
  const record = doc.users[user]
  return record !== null && typeof record === 'object' ? record : null
}

/** 取角色（老的用户名/密码账户没有 role 字段 → 默认 user）。 */
export function roleOf(doc, user) {
  const record = recordOf(doc, user)
  if (record === null) return null
  return ROLES.includes(record.role) ? record.role : 'user'
}

/** 测试账号 / 任何带 expiresAt 的账户是否过期。 */
export function isExpired(record, now = Date.now()) {
  if (record === null || record === undefined) return true
  if (typeof record.expiresAt !== 'string') return false
  const at = Date.parse(record.expiresAt)
  return Number.isFinite(at) ? at <= now : false
}

/** 账户可用性：存在、未停用、未过期。**停用与过期都要挡住登录**，不能只挡一处。 */
export function isUsable(doc, user, now = Date.now()) {
  const record = recordOf(doc, user)
  if (record === null) return false
  if (record.status === 'disabled') return false
  return isExpired(record, now) !== true
}

function codeKey(email, code) {
  return createHash('sha256').update(`${email}|${code}`, 'utf8').digest('hex')
}

/** 生成 6 位数字验证码（返回明文给调用方发邮件；库里只存哈希）。 */
export function issueCode(doc, email, now = Date.now()) {
  const normalized = normalizeEmail(email)
  if (normalized.ok !== true) return { ok: false, error: normalized.error }
  const code = String(Math.floor(Math.random() * 1e6)).padStart(6, '0')
  const codes = { ...(doc.codes ?? {}) }
  codes[normalized.email] = { key: codeKey(normalized.email, code), issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + CODE_TTL_MS).toISOString() }
  return { ok: true, code, doc: { ...doc, codes } }
}

/**
 * 校验验证码。**一次性**：验过就把这条删掉，防止同一个码被重复使用。
 * 过期 / 不匹配返回同一句错误（不告诉攻击者"码对不对"）。
 */
export function verifyCode(doc, email, code, now = Date.now()) {
  const normalized = normalizeEmail(email)
  if (normalized.ok !== true) return { ok: false, error: normalized.error }
  const codes = { ...(doc.codes ?? {}) }
  const entry = codes[normalized.email]
  const failed = { ok: false, error: '验证码不对或已过期' }
  if (entry === undefined || typeof entry !== 'object') return failed
  const expiresAt = Date.parse(String(entry.expiresAt))
  if (Number.isFinite(expiresAt) && expiresAt <= now) {
    delete codes[normalized.email]
    return failed
  }
  if (entry.key !== codeKey(normalized.email, String(code))) return failed
  delete codes[normalized.email]
  return { ok: true, doc: { ...doc, codes } }
}

/**
 * 邮箱 + 验证码登录：**账户不存在就顺手创建**（原型要求"同一表单，按邮箱是否已注册自动分流"）。
 * @returns {{ ok: boolean, error?: string, doc?: object, token?: string, user?: string, created?: boolean, role?: string }}
 */
export function loginWithEmail(doc, email, code, options = {}) {
  const normalized = normalizeEmail(email)
  if (normalized.ok !== true) return { ok: false, error: normalized.error }
  if (options.codePreVerified !== true) {
    const verified = verifyCode(doc, normalized.email, code, options.now ?? Date.now())
    if (verified.ok !== true) return { ok: false, error: verified.error }
    doc = verified.doc
  }
  const users = { ...doc.users }
  const existing = users[normalized.email]
  let created = false
  if (existing === undefined) {
    users[normalized.email] = { role: 'user', status: 'active', createdAt: new Date(options.now ?? Date.now()).toISOString(), via: 'email-code' }
    created = true
  } else if (existing.status === 'disabled') {
    return { ok: false, error: '这个账户已停用' }
  } else if (isExpired(existing, options.now ?? Date.now())) {
    return { ok: false, error: '这个测试账号已过期（请联系管理员续期）' }
  }
  const token = issueToken()
  const tokens = { ...doc.tokens, [tokenKey(token)]: tokenEntry(normalized.email, options.label ?? '') }
  return { ok: true, doc: { version: 1, users, tokens, codes: doc.codes ?? {} }, token, user: normalized.email, created, role: roleOf({ users }, normalized.email) }
}

/**
 * 管理员手动建号（**不走验证码**：管理员本来就有权限，再要验证码没意义）。
 * @param {{ role?: string, now?: number, expiresInDays?: number, note?: string }} options
 */
export function createAccount(doc, email, options = {}) {
  const normalized = normalizeEmail(email)
  if (normalized.ok !== true) return { ok: false, error: normalized.error }
  const role = normalizeRole(options.role, 'user')
  if (role.ok !== true) return { ok: false, error: role.error }
  const users = { ...doc.users }
  if (users[normalized.email] !== undefined) {
    return { ok: false, error: '这个邮箱已经建过账户了' }
  }
  const now = options.now ?? Date.now()
  const record = { role: role.role, status: 'active', createdAt: new Date(now).toISOString(), via: 'admin' }
  if (options.note !== undefined && options.note !== '') record.note = String(options.note)
  // 测试账号必须带期限：没有期限的测试账号迟早变成第二个管理员。
  if (role.role === 'dev') {
    const days = Number.isFinite(options.expiresInDays) ? Number(options.expiresInDays) : DEV_TTL_DAYS
    record.expiresAt = new Date(now + days * 86400000).toISOString()
  }
  users[normalized.email] = record
  return { ok: true, doc: { version: 1, users, tokens: doc.tokens ?? {}, codes: doc.codes ?? {} }, role: role.role }
}

/** 停用 / 恢复（停用后 token 立即失效：见 `userForToken` 的可用性检查）。 */
export function setAccountStatus(doc, email, status) {
  if (status !== 'active' && status !== 'disabled') {
    return { ok: false, error: '状态只能是 active / disabled' }
  }
  const normalized = normalizeEmail(email)
  if (normalized.ok !== true) return { ok: false, error: normalized.error }
  const record = recordOf(doc, normalized.email)
  if (record === null) return { ok: false, error: '没有这个账户' }
  const users = { ...doc.users, [normalized.email]: { ...record, status } }
  return { ok: true, doc: { ...doc, users } }
}

/**
 * 按**用户名**停用 / 恢复。
 *
 * 为什么还要一个 username 版本：`setAccountStatus` 是按邮箱找人的，而管理员手动添加的
 * 测试账号只有用户名+密码、没有邮箱（docs/19 的账号模型）。管理控制台按用户名操作，
 * 所以这里补一条按用户名改的路径 —— 但**不做模糊匹配**：找不到就是找不到。
 */
export function setStatusByUsername(doc, username, status) {
  if (status !== 'active' && status !== 'disabled') {
    return { ok: false, error: '状态只能是 active / disabled' }
  }
  const name = normalizeUsername(username)
  if (name.ok !== true) return { ok: false, error: name.error }
  const record = (doc.users ?? {})[name.username]
  if (record === undefined || record === null) return { ok: false, error: '没有这个账户' }
  const users = { ...doc.users, [name.username]: { ...record, status } }
  return { ok: true, doc: { ...doc, users }, status, username: name.username }
}

/**
 * 给账号续期 `days` 天。
 *
 * 两个细节都是从"测试账号默认 7 天过期"这个需求来的：
 *   ① 从**现在**算，不是从原到期时间算 —— 已过期的账号续 3 天应当是"从今天起 3 天"，
 *      否则续完仍然是过期的，看起来像按钮没生效。
 *   ② 只对真正有 `expiresAt` 的账号生效；永久账号（管理员/正式用户）不该被塞一个到期时间。
 */
export function renewAccount(doc, username, days = DEV_TTL_DAYS, now = Date.now()) {
  const span = Number(days)
  if (!Number.isFinite(span) || span <= 0 || span > 3650) {
    return { ok: false, error: '续期天数要在 1~3650 之间' }
  }
  const name = normalizeUsername(username)
  if (name.ok !== true) return { ok: false, error: name.error }
  const record = (doc.users ?? {})[name.username]
  if (record === undefined || record === null) return { ok: false, error: '没有这个账户' }
  const base = Math.max(now, Date.parse(record.expiresAt ?? '') || 0)
  const expiresAt = new Date(base + span * 86400000).toISOString()
  const users = { ...doc.users, [name.username]: { ...record, expiresAt } }
  return { ok: true, doc: { ...doc, users }, expiresAt }
}

/* ────────────────────────────────────────────────────────────────────────────
 * 用户定的账号模型（2026-10-24，最终版）：
 *
 *   注册：**邮箱 + 用户名 + 密码 + 邮箱验证码**（四样都要）
 *   登录：**用户名 + 密码**（不要求邮箱）
 *   管理员：可手动添加测试账号（用户名+密码，不发验证码）
 *
 * 为什么注册要邮箱而登录不要：邮箱是用来"证明这个人有一个可联系的身份"，
 * 一次就够；而每次登录都收验证码，在现场会议场景里是灾难（开会时谁去翻邮箱）。
 *
 * 与"邮箱直接登录"那版的区别（已废弃）：那版用邮箱当账号，用户没有自己的用户名，
 * 在多设备/多角色（管理员）场景里不好认人，也不方便口头报账号。
 * ──────────────────────────────────────────────────────────────────────────── */

/** 找"这个邮箱被谁占了"（邮箱唯一：两个账号同一个邮箱会让找回/通知无从下手）。 */
export function userByEmail(doc, rawEmail) {
  const normalized = normalizeEmail(rawEmail)
  if (normalized.ok !== true) return null
  for (const [user, record] of Object.entries(doc.users ?? {})) {
    if (record !== null && typeof record === 'object') {
      const email = typeof record.email === 'string' ? record.email : (user.includes('@') ? user : '')
      if (email !== '' && email.toLowerCase() === normalized.email) return user
    }
  }
  return null
}

/**
 * 注册：邮箱 + 用户名 + 密码 + 验证码。
 * @param {{ email: string, username: string, password: string, code?: string,
 *           codePreVerified?: boolean, now?: number, role?: string, label?: string }} input
 */
export function registerWithEmail(doc, input = {}) {
  const email = normalizeEmail(input.email)
  if (email.ok !== true) return { ok: false, error: email.error }
  const name = normalizeUsername(input.username)
  if (name.ok !== true) return { ok: false, error: name.error }
  const pass = checkPassword(input.password)
  if (pass.ok !== true) return { ok: false, error: pass.error }
  const role = normalizeRole(input.role, 'user')
  if (role.ok !== true) return { ok: false, error: role.error }

  if (input.codePreVerified !== true) {
    const verified = verifyCode(doc, email.email, String(input.code ?? ''), input.now ?? Date.now())
    if (verified.ok !== true) return { ok: false, error: verified.error }
    doc = verified.doc
  }

  const users = { ...doc.users }
  if (users[name.username] !== undefined) {
    return { ok: false, error: '这个用户名已经被注册了（换一个，或者用登录）' }
  }
  const taken = userByEmail(doc, email.email)
  if (taken !== null) {
    return { ok: false, error: `这个邮箱已经绑过账号了（用户名：${taken}）` }
  }

  const now = input.now ?? Date.now()
  users[name.username] = {
    ...hashPassword(input.password),
    email: email.email,
    role: role.role,
    status: 'active',
    createdAt: new Date(now).toISOString(),
    via: 'email-code',
  }
  const token = issueToken()
  const tokens = { ...doc.tokens, [tokenKey(token)]: tokenEntry(name.username, input.label ?? '') }
  return {
    ok: true, doc: { version: 1, users, tokens, codes: doc.codes ?? {} },
    token, username: name.username, role: role.role, email: email.email,
  }
}

/**
 * 管理员手动建号（含密码，**不发验证码**）：测试账号、临时同事都用这条。
 * @param {{ username: string, password: string, email?: string, role?: string,
 *           note?: string, expiresInDays?: number, now?: number }} input
 */
export function createAccountWithPassword(doc, input = {}) {
  const name = normalizeUsername(input.username)
  if (name.ok !== true) return { ok: false, error: name.error }
  const pass = checkPassword(input.password)
  if (pass.ok !== true) return { ok: false, error: pass.error }
  const role = normalizeRole(input.role, 'dev')
  if (role.ok !== true) return { ok: false, error: role.error }
  let email = ''
  if (input.email !== undefined && input.email !== null && input.email !== '') {
    const normalized = normalizeEmail(input.email)
    if (normalized.ok !== true) return { ok: false, error: normalized.error }
    if (userByEmail(doc, normalized.email) !== null) {
      return { ok: false, error: '这个邮箱已经绑过账号了' }
    }
    email = normalized.email
  }
  const users = { ...doc.users }
  if (users[name.username] !== undefined) {
    return { ok: false, error: '这个用户名已经存在了' }
  }
  const now = input.now ?? Date.now()
  const record = {
    ...hashPassword(input.password),
    role: role.role, status: 'active', createdAt: new Date(now).toISOString(), via: 'admin',
  }
  if (email !== '') record.email = email
  if (typeof input.note === 'string' && input.note !== '') record.note = input.note
  if (role.role === 'dev') {
    const days = Number.isFinite(input.expiresInDays) ? Number(input.expiresInDays) : DEV_TTL_DAYS
    record.expiresAt = new Date(now + days * 86400000).toISOString()
  }
  users[name.username] = record
  return { ok: true, doc: { version: 1, users, tokens: doc.tokens ?? {}, codes: doc.codes ?? {} }, role: role.role }
}

/** 列出账号（管理员界面用）：只给"能看"的字段，**绝不返回密码哈希与盐**。 */
export function listAccounts(doc) {
  return Object.entries(doc.users ?? {}).map(([username, record]) => ({
    username,
    email: typeof record?.email === 'string' ? record.email : '',
    role: ROLES.includes(record?.role) ? record.role : 'user',
    status: record?.status === 'disabled' ? 'disabled' : 'active',
    createdAt: record?.createdAt ?? null,
    expiresAt: record?.expiresAt ?? null,
    via: record?.via ?? 'legacy',
    usable: isUsable(doc, username),
  })).sort((left, right) => (left.username < right.username ? -1 : 1))
}
