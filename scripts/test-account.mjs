/**
 * test-account.mjs —— 建一个**测试账户**并把热词表预置好（只写磁盘，不碰网络）
 * ============================================================================
 *
 *   node scripts/test-account.mjs                 # 建/刷新测试账户 + 写入默认热词表
 *   node scripts/test-account.mjs --terms my.json # 用自己准备的表（[{zh,pt,wrong?}]）
 *   node scripts/test-account.mjs --show          # 只看当前状态（不给密码）
 *   node scripts/test-account.mjs --reset         # 删掉这个账户与它的表
 *
 * 为什么要这个脚本：验证"热词表 / 账户 / 替换"这条线，如果每次都靠人在手机上注册、
 * 一条条敲名字，既慢又容易敲错，而且**不可复现**（换个机器就重来一遍）。
 * 这里是直接把数据写进 `var/live/`（relay 每次请求都读文件，所以立刻生效）。
 *
 * 写出来的东西：
 *   var/live/accounts.json        账户（密码 scrypt 加盐哈希，token 只存 sha256）
 *   var/live/terms.json           这个账户的热词表
 *   var/live/terms-active.json    "当前会话用哪个用户"，插件下一场就按它取表
 *   var/test/test-account.json    测试凭据（**明文**，只给本地测试用，var/ 不进版本控制）
 *
 * ⚠️ 这是**测试账户**：密码固定、凭据明文落盘，只应该出现在本机开发目录里。
 *    任何时候觉得它碍事，`--reset` 就能清干净。
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { LIVE_DIR, TEST_DIR } from '../lib/paths.mjs'
import {
  emptyAccounts, hasAccounts, issueToken, loadAccounts, login, register, saveAccounts, tokenEntry, tokenKey,
} from '../lib/accounts.mjs'
import { getTable, loadTerms, putTable, saveActiveUser, saveTerms, validateTerms } from '../lib/terms.mjs'

/** 测试账户的固定身份（改这里就等于换账号）。 */
export const TEST_ACCOUNT = {
  username: 'test',
  password: 'test123456',
  label: 'test-account',
}

/**
 * 凭据文件位置（明文；`var/` 被 gitignore，不会进版本控制）。
 *
 * <p>⚠️ 它是**按数据目录算出来的**，不是全局常量 —— 早先写成常量时踩过坑：
 * 测试套件拿临时目录跑 `resetTestAccount()`，结果把真实的那份凭据删掉了
 * （常量跟 dataDir 无关，rm 的就是 var/live 旁边那份）。
 */
export function credentialsPathFor(dataDir = LIVE_DIR) {
  return join(dataDir, 'test-account.json')
}

/** 缺省数据目录下的凭据路径（命令行提示里用）。 */
export const CREDENTIALS_PATH = credentialsPathFor(LIVE_DIR)

/**
 * 默认热词表：**项目里真实在用的名字** + 几个"已知错误写法"。
 *
 * <p>为什么带 `wrong`：阶段 3 的归一化靠它才能咬住东西 ——
 * 光有"正确写法"时，匹配器只能做"把已正确的再写一遍"（等于空转）。
 * 这几个 wrong 值是 docs/08 与 docs/13 里实测出现过的（Hunyuan / Qwen 的音译）。
 */
export const DEFAULT_TERMS = [
  { zh: '亮亮视野', pt: 'LLVision', wrong: ['Liangliang Vision', 'Liang Liang Vision'] },
  { zh: '亮亮眼镜', pt: 'Leion', wrong: ['Liangliang Glasses'] },
  { zh: 'Leion Pro', pt: 'Leion Pro' },
  { zh: '高通', pt: 'Qualcomm' },
  { zh: '骁龙 8 Gen 3', pt: 'Snapdragon 8 Gen 3' },
  { zh: '安卓', pt: 'Android' },
  { zh: '圣保罗', pt: 'São Paulo', approved: ['Sao Paulo'] },
]

/** 表内容从哪来：`--terms <file>` 优先，否则用内置默认。 */
async function loadTableFrom(options) {
  if (options.terms === null) return DEFAULT_TERMS
  const text = await readFile(options.terms, 'utf-8')
  const parsed = JSON.parse(text)
  if (Array.isArray(parsed) === false) throw new Error('--terms 指定的文件必须是条目数组')
  return parsed
}

/**
 * 保证测试账户存在并拿到一个**有效 token**（存在就复用，不存在就新建）。
 *
 * @returns {Promise<{ username: string, password: string, token: string, createdAccount: boolean, entries: number }>}
 */
export async function ensureTestAccount(options = {}) {
  const dataDir = options.dataDir ?? LIVE_DIR
  const username = options.username ?? TEST_ACCOUNT.username
  const password = options.password ?? TEST_ACCOUNT.password
  const terms = options.terms === undefined ? DEFAULT_TERMS : options.terms

  await mkdir(dataDir, { recursive: true })

  // ── 1. 账户：没有就注册，有就登录（登录会**新发一个 token**，旧的不动）──
  let doc = await loadAccounts(dataDir)
  let token = null
  let createdAccount = false
  if (Object.prototype.hasOwnProperty.call(doc.users, username) === false) {
    const created = register(doc, username, password, TEST_ACCOUNT.label)
    if (created.ok !== true) throw new Error('建账户失败：' + created.error)
    doc = created.doc
    token = created.token
    createdAccount = true
  } else {
    const signed = login(doc, username, password, TEST_ACCOUNT.label)
    if (signed.ok !== true) throw new Error('登录测试账户失败：' + signed.error)
    doc = signed.doc
    token = signed.token
  }
  // 顺手记下 token（注册/登录已经写了，这里只兜底）
  if (doc.tokens[tokenKey(token)] === undefined) {
    doc = { ...doc, tokens: { ...doc.tokens, [tokenKey(token)]: tokenEntry(username, TEST_ACCOUNT.label) } }
  }
  await saveAccounts(dataDir, doc)

  // ── 2. 热词表：走真实校验再落盘（不能因为"是测试"就绕过校验）──
  const checked = validateTerms(terms)
  if (checked.ok !== true) {
    const detail = checked.rejected.map(item => `第 ${item.index + 1} 条 ${item.code}：${item.reason}`).join('；')
    throw new Error('测试热词表本身不合法：' + detail)
  }
  const termsDoc = await loadTerms(dataDir)
  const put = putTable(termsDoc, username, checked.entries)
  await saveTerms(dataDir, put.doc)

  // ── 3. 让插件下一场就用这个账户的表 ──────────────────────────────
  await saveActiveUser(dataDir, username)

  // ── 4. 凭据落盘（明文，仅本地测试）────────────────────────────────
  const credentialsPath = credentialsPathFor(dataDir)
  await mkdir(dirname(credentialsPath), { recursive: true })
  await writeFile(credentialsPath, JSON.stringify({
    note: '测试账户凭据（明文，仅本机测试用；var/ 不进版本控制）',
    createdAt: new Date().toISOString(),
    dataDir,
    username,
    password,
    token,
    entries: checked.entries.length,
  }, null, 2) + '\n', 'utf-8')

  return { username, password, token, createdAccount, entries: checked.entries.length, dataDir, credentialsPath }
}

/** 读回已保存的凭据（没有就返回 null）。 */
export async function readCredentials(dataDir = LIVE_DIR) {
  try {
    return JSON.parse(await readFile(credentialsPathFor(dataDir), 'utf-8'))
  } catch {
    return null
  }
}

/** 删掉测试账户、它的 token、它的热词表与凭据文件。 */
export async function resetTestAccount(options = {}) {
  const dataDir = options.dataDir ?? LIVE_DIR
  const username = options.username ?? TEST_ACCOUNT.username

  const accounts = await loadAccounts(dataDir)
  if (Object.prototype.hasOwnProperty.call(accounts.users, username)) {
    const users = { ...accounts.users }
    delete users[username]
    const tokens = { ...accounts.tokens }
    for (const [key, entry] of Object.entries(tokens)) {
      if (entry.user === username) delete tokens[key]
    }
    await saveAccounts(dataDir, { version: 1, users, tokens })
  }

  const termsDoc = await loadTerms(dataDir)
  if (termsDoc.tables[username] !== undefined) {
    const tables = { ...termsDoc.tables }
    delete tables[username]
    await saveTerms(dataDir, { version: 1, updatedAt: new Date().toISOString(), tables })
  }

  await rm(credentialsPathFor(dataDir), { force: true })
  return { removed: true, dataDir }
}

/** 打印当前状态（**不打印密码**，除非是新建凭据文件的提示那一段）。 */
export async function describe(dataDir = LIVE_DIR) {
  const accounts = await loadAccounts(dataDir)
  const termsDoc = await loadTerms(dataDir)
  const credentials = await readCredentials(dataDir)
  return {
    accounts: hasAccounts(accounts),
    users: Object.keys(accounts.users),
    tokens: Object.keys(accounts.tokens).length,
    tables: Object.keys(termsDoc.tables).map(user => ({ user, entries: getTable(termsDoc, user).entries.length })),
    credentialsPath: credentialsPathFor(dataDir),
    credentialsPresent: credentials !== null,
    currentUser: credentials === null ? null : credentials.username,
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const options = { terms: null, show: false, reset: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--show') { options.show = true; continue }
    if (token === '--reset') { options.reset = true; continue }
    if (token === '--terms') { options.terms = argv[++index]; continue }
    if (token === '--help' || token === '-h') { options.help = true; continue }
    throw new Error('看不懂的参数：' + token)
  }
  return options
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('test-account.mjs')) {
  const options = parseArgs(process.argv.slice(2))
  if (options.help === true) {
    console.log('用法：node scripts/test-account.mjs [--terms <file.json>] [--show] [--reset]')
    process.exit(0)
  }
  try {
    if (options.reset === true) {
      await resetTestAccount()
      console.log('已删除测试账户、它的 token、它的热词表与凭据文件。')
    } else if (options.show === true) {
      const state = await describe()
      console.log(JSON.stringify(state, null, 2))
    } else {
      const result = await ensureTestAccount({ terms: await loadTableFrom(options) })
      console.log('')
      console.log('─'.repeat(68))
      console.log('  测试账户已就绪')
      console.log('─'.repeat(68))
      console.log(`  用户名      ${result.username}`)
      console.log(`  密码        ${result.password}`)
      console.log(`  热词表      ${result.entries} 条（${result.dataDir}）`)
      console.log(`  账户        ${result.createdAccount ? '新建' : '已存在，已重新签发 token'}`)
      console.log('')
      console.log('  在手机上用这一对登录：设置 → 账户')
      console.log('  凭据（含 token）存在：' + result.credentialsPath)
      console.log('')
      console.log('  命令行验证（电脑上，relay 起着时）：')
      console.log('    curl -s -H "X-Leion-Secret: <配对码>" -H "X-Leion-Token: ' + result.token + '" \\')
      console.log('         http://127.0.0.1:8788/terms')
      console.log('─'.repeat(68))
      console.log('')
    }
  } catch (error) {
    console.error('出错了：' + (error && error.message ? error.message : error))
    process.exit(1)
  }
}
