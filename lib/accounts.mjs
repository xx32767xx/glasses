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
  const token = issueToken()
  const tokens = { ...doc.tokens, [tokenKey(token)]: tokenEntry(name.username, label) }
  return { ok: true, doc: { version: 1, users: doc.users, tokens }, token, username: name.username }
}

/** 用 token 反查用户（这是唯一可信的"我是谁"来源）。 */
export function userForToken(doc, token) {
  if (typeof token !== 'string' || token === '') return null
  const entry = doc.tokens[tokenKey(token)]
  if (entry === undefined) return null
  return typeof entry.user === 'string' ? entry.user : null
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
export async function loadAccounts(dataDir) {
  let text
  try {
    text = await readFile(accountsPath(dataDir), 'utf-8')
  } catch {
    return emptyAccounts()
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return emptyAccounts()
  }
  if (parsed === null || typeof parsed !== 'object') return emptyAccounts()
  const users = parsed.users !== null && typeof parsed.users === 'object' && !Array.isArray(parsed.users)
    ? parsed.users : {}
  const tokens = parsed.tokens !== null && typeof parsed.tokens === 'object' && !Array.isArray(parsed.tokens)
    ? parsed.tokens : {}
  return { version: 1, users, tokens }
}

/** 原子写（tmp + rename）：手机可能随时来读，不能让它读到半截 JSON。 */
export async function saveAccounts(dataDir, doc) {
  const target = accountsPath(dataDir)
  await mkdir(dirname(target), { recursive: true })
  const temp = target + '.tmp'
  await writeFile(temp, JSON.stringify(doc, null, 2) + '\n', 'utf-8')
  await rename(temp, target)
}
