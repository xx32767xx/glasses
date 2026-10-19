/**
 * terms.mjs —— 用户热词对照表的**数据层**（只有校验与存取，不做任何替换）
 * ============================================================================
 *
 * 为什么单独一个文件、而且只放"校验 + 存取"：
 *   替换逻辑（匹配、归一、缺失判断）要接进翻译出口，那是**产线**；而这一层
 *   只跟一个 JSON 文件打交道，可以被完整地单元测试、且不需要模型、不需要网络。
 *   分层清楚的好处很具体：表写坏了只会"上传失败"，绝不会影响正在跑的字幕。
 *
 * 设计规程见 docs/15-热词对照表.md。这里只实现其中 §4（数据结构）与 §6（校验）：
 *
 *   · 校验是**纯函数**：同样的输入永远给同样的结果，便于"坏表必须被拒"的测试。
 *   · 落盘是**原子写**（临时文件 + rename）：手机可能在上传的同一刻被读，
 *     半截 JSON 会让读者拿到一个语法正确的空表 —— 那比读失败更难查。
 *   · 条目 id 由内容算出（`t_` + 短哈希）：重复上传同一张表，id 不变，
 *     日志里不会出现"同一个词两个 id"的假象。
 *
 * ⚠️ 本文件**不做**任何匹配/替换。阶段 2 的匹配器是另一个文件，且必须幂等。
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 上限（防滥用）。数值与 docs/15 §6.1 一致，改这里就要改文档。 */
export const TERMS_LIMITS = {
  maxEntries: 500,
  maxTextChars: 200,
  maxBodyBytes: 64 * 1024,
  maxUserChars: 64,
}

/** 用户名允许的字符。刻意窄：它既是文件名的一部分，也会进日志。 */
const USER_PATTERN = /^[A-Za-z0-9_.@-]+$/

/** 没指定用户名时的归属，与 docs/15 §8.3 一致。 */
export const DEFAULT_USER = 'default'

/** `direction` 与 `enforce` 的可选值。`hint` 目前只是**存下来**，行为尚未定义。 */
export const DIRECTIONS = ['auto', 'zh-to-pt', 'pt-to-zh']
export const ENFORCE_LEVELS = ['must', 'normalize', 'off', 'hint']

const HAN = /\p{Script=Han}/u
const HAN_GLOBAL = /\p{Script=Han}/gu
/** 不可见字符：零宽、方向控制、行内分隔符。它们是最难查的误伤源，一律拒收。 */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/

const reject = (index, code, reason) => ({ index, code, reason })

/**
 * 用户名归一：去空白 → 校验 → 空则回落 `default`。
 * @returns {{ ok: true, user: string } | { ok: false, error: string }}
 */
export function normalizeUser(raw) {
  if (raw === undefined || raw === null) return { ok: true, user: DEFAULT_USER }
  if (typeof raw !== 'string') return { ok: false, error: 'user 必须是字符串' }
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: true, user: DEFAULT_USER }
  if (trimmed.length > TERMS_LIMITS.maxUserChars) {
    return { ok: false, error: `user 太长（≤ ${TERMS_LIMITS.maxUserChars} 字符）` }
  }
  if (USER_PATTERN.test(trimmed) === false) {
    return { ok: false, error: 'user 只能包含字母、数字与 _ . @ -' }
  }
  return { ok: true, user: trimmed }
}

/** 折叠用的小写键：大小写/重音不参与"是不是同一个词"的判断（docs/15 §5.3）。 */
export function foldKey(text) {
  if (typeof text !== 'string') return ''
  return text
    .normalize('NFC')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** 条目 id 由内容决定：同样内容重复上传 → 同样 id（日志里不会一物两号）。 */
function entryId(zh, pt) {
  const digest = createHash('sha256').update(zh + '\u0000' + pt, 'utf8').digest('hex')
  return 't_' + digest.slice(0, 8)
}

/** 这一串里有多少个汉字（用来判断"中文侧写没写中文"）。 */
function hanCount(text) {
  const found = String(text).match(HAN_GLOBAL)
  return found === null ? 0 : found.length
}

/**
 * 校验一张表。**纯函数**：不读文件、不写文件、不看时间。
 *
 * 规则与 docs/15 §6.2 一一对应。全部通过才 `ok: true`；任何一条不过，
 * `ok: false` 且 `entries` 为空 —— 调用方据此决定"整表不落盘"（方案 C：
 * 两阶段校验，`PUT` 只接受全合法的表）。这样不会出现"用户以为存了、其实半张表"。
 *
 * @param {unknown} entries 请求里的 entries
 * @returns {{ ok: boolean, accepted: number, rejected: object[], warnings: object[], entries: object[] }}
 */
export function validateTerms(entries) {
  if (Array.isArray(entries) === false) {
    return { ok: false, accepted: 0, entries: [], warnings: [], rejected: [reject(-1, 'TABLE_MALFORMED', 'entries 必须是数组')] }
  }
  if (entries.length > TERMS_LIMITS.maxEntries) {
    return {
      ok: false, accepted: 0, entries: [], warnings: [],
      rejected: [reject(-1, 'TABLE_TOO_LARGE', `条目数 ${entries.length} 超过上限 ${TERMS_LIMITS.maxEntries}`)],
    }
  }

  const rejected = []
  /** 不拦上传，但要在报告里说出来（例如"2 个字的中文名容易被更长的词命中"）。 */
  const warnings = []
  const accepted = []
  /** 已经出现过的"源写法 → 目标写法"，用来判重复与来回替换。 */
  const seenZh = new Map()   // fold(zh) → pt
  const seenPt = new Map()   // fold(pt) → zh
  const pairs = new Set()    // fold(zh)|fold(pt)

  entries.forEach((raw, index) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      rejected.push(reject(index, 'ENTRY_MALFORMED', '条目必须是对象'))
      return
    }
    const zh = typeof raw.zh === 'string' ? raw.zh.trim() : ''
    const pt = typeof raw.pt === 'string' ? raw.pt.trim() : ''

    if (zh === '' || pt === '') {
      rejected.push(reject(index, 'MISSING_SIDE', 'zh 与 pt 都必须填（双向要用两侧）'))
      return
    }
    if (zh.length > TERMS_LIMITS.maxTextChars || pt.length > TERMS_LIMITS.maxTextChars) {
      rejected.push(reject(index, 'TOO_LONG', `单侧超过 ${TERMS_LIMITS.maxTextChars} 字符`))
      return
    }
    if (CONTROL.test(zh) || CONTROL.test(pt)) {
      rejected.push(reject(index, 'CONTROL_CHARS', '含不可见字符（零宽/制表/换行等）'))
      return
    }
    // 方向装反：中文侧一个汉字都没有，或者葡语侧居然有汉字。
    if (hanCount(zh) === 0) {
      rejected.push(reject(index, 'LATIN_IN_ZH', '中文侧没有汉字 —— 两侧可能写反了'))
      return
    }
    if (HAN.test(pt)) {
      rejected.push(reject(index, 'HAN_IN_PT', '葡语侧含汉字 —— 两侧可能写反了'))
      return
    }
    // 太短：只拒绝"几乎必然误伤"的那一档（中文 1 个汉字、拉丁 ≤2 字符）。
    //
    // ⚠️ 这条阈值改过一次，原因写在这里免得以后又改回去：规程初稿写的是
    //    "中文 ≤2 字 / 拉丁 ≤3 字符一律拒绝"，拿真实专名一验就发现它把
    //    「高通」「安卓」「IBM」「BYD」全拒了 —— 而那些正是最常需要钉住的名字。
    //    所以现在分成两档：
    //      硬拒：中文 1 个汉字（「中」「大」这种，命中「中国」「大量」是灾难）、
    //            拉丁 ≤2 字符（「Me」「AI」在任何句子里的短串命中都不可控）
    //      警告：中文 2 个汉字、拉丁 3 字符 —— 放行，但在上传报告里列出来提醒
    //            （真正的防线在匹配层：整词匹配 + 最长优先，见 docs/15 §5.1）
    const han = hanCount(zh)
    const latinLength = pt.length
    if (han <= 1) {
      rejected.push(reject(index, 'TOO_SHORT', `中文侧只有 ${han} 个汉字，会命中别的词（如「中」→「中国」）`))
      return
    }
    if (latinLength <= 2) {
      rejected.push(reject(index, 'TOO_SHORT', `葡语侧只有 ${latinLength} 个字符，短串命中不可控`))
      return
    }
    if (han === 2) warnings.push(reject(index, 'WARN_SHORT_ZH', '中文侧只有 2 个字，注意别让它命中更长的词（如「高通」→「高通量」）'))
    if (latinLength === 3) warnings.push(reject(index, 'WARN_SHORT_LATIN', '葡语侧只有 3 个字符，注意别命中更长的词'))
    const direction = raw.direction === undefined ? 'auto' : raw.direction
    if (DIRECTIONS.includes(direction) === false) {
      rejected.push(reject(index, 'BAD_ENUM', `direction 只能是 ${DIRECTIONS.join(' / ')}`))
      return
    }
    const enforce = raw.enforce === undefined ? 'must' : raw.enforce
    if (ENFORCE_LEVELS.includes(enforce) === false) {
      rejected.push(reject(index, 'BAD_ENUM', `enforce 只能是 ${ENFORCE_LEVELS.join(' / ')}`))
      return
    }
    const variants = normalizeList(raw.variants)
    if (variants === null) {
      rejected.push(reject(index, 'ENTRY_MALFORMED', 'variants 必须是字符串数组'))
      return
    }
    const approved = normalizeList(raw.approved)
    if (approved === null) {
      rejected.push(reject(index, 'ENTRY_MALFORMED', 'approved 必须是字符串数组'))
      return
    }
    const gender = raw.gender === undefined || raw.gender === null ? undefined : String(raw.gender)
    if (gender !== undefined && ['m', 'f'].includes(gender) === false) {
      rejected.push(reject(index, 'BAD_ENUM', 'gender 只能是 m / f'))
      return
    }

    const keyZh = foldKey(zh)
    const keyPt = foldKey(pt)
    if (pairs.has(keyZh + '\u0000' + keyPt)) {
      rejected.push(reject(index, 'DUPLICATE_SOURCE', `与前面的条目完全重复（${zh} = ${pt}）`))
      return
    }
    if (seenZh.has(keyZh) && seenZh.get(keyZh) !== keyPt) {
      rejected.push(reject(index, 'DUPLICATE_SOURCE', `「${zh}」已经对应过别的写法，同一源写法不能有两个目标`))
      return
    }
    if (seenPt.has(keyPt) && seenPt.get(keyPt) !== keyZh) {
      rejected.push(reject(index, 'DUPLICATE_SOURCE', `「${pt}」已经对应过别的中文写法，同一目标不能指两个源`))
      return
    }
    // 来回替换：A→B 同时 B→A，会互相改回去。
    if (pairs.has(keyPt + '\u0000' + keyZh)) {
      rejected.push(reject(index, 'CYCLE', `与前面的条目构成 A→B / B→A，会来回替换`))
      return
    }

    pairs.add(keyZh + '\u0000' + keyPt)
    seenZh.set(keyZh, keyPt)
    seenPt.set(keyPt, keyZh)
    accepted.push({
      id: entryId(zh, pt),
      zh,
      pt,
      variants,
      approved: approved.length > 0 ? approved : [pt],
      direction,
      enforce,
      ...(gender === undefined ? {} : { gender }),
    })
  })

  return { ok: rejected.length === 0, accepted: accepted.length, rejected, warnings, entries: accepted }
}

/** 字符串数组归一：去空、去重、保序；非法类型返回 null（由调用方报错）。 */
function normalizeList(value) {
  if (value === undefined || value === null) return []
  if (Array.isArray(value) === false) return null
  const out = []
  const seen = new Set()
  for (const item of value) {
    if (typeof item !== 'string') return null
    const trimmed = item.trim()
    if (trimmed === '') continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

// ── 存取 ────────────────────────────────────────────────────────────────────

/** 表文件的路径（数据目录与收件箱/字幕总线同一个）。 */
export function termsPath(dataDir) {
  return join(dataDir, 'terms.json')
}

/** "当前会话用哪个用户"的小文件：插件读它取表，沿用现有"文件接缝"的做法。 */
export function termsActivePath(dataDir) {
  return join(dataDir, 'terms-active.json')
}

/** 空文档：**没有任何用户表**的状态。等价于"功能关闭"，见 docs/15 §10.2 第 6 条。 */
export function emptyDoc() {
  return { version: 1, updatedAt: null, tables: {} }
}

/**
 * 读文档。**任何读取失败都退回空文档**（文件不存在、JSON 坏了、结构不对）。
 *
 * 为什么不让它抛：这是"用户的便利功能"，不是字幕的必要条件。文件坏了的时候
 * 正确的行为是"当作没有热词表，字幕照常出"，而不是让转发进程报错。
 */
export async function loadTerms(dataDir) {
  let text
  try {
    text = await readFile(termsPath(dataDir), 'utf-8')
  } catch {
    return emptyDoc()
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return emptyDoc()
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyDoc()
  const tables = parsed.tables
  if (tables === null || typeof tables !== 'object' || Array.isArray(tables)) return emptyDoc()
  return { version: 1, updatedAt: parsed.updatedAt ?? null, tables }
}

/**
 * 原子写：先写 `*.tmp` 再 rename。
 *
 * rename 在同一分区上是原子的，所以读的一方要么看到旧文件、要么看到新文件，
 * 不会读到"写了一半的 JSON"。这一点很重要：半截 JSON 通常**语法合法**（少几个条目），
 * 于是读者拿到的是一张"看起来正常的空表"，比报错难查得多。
 */
export async function saveTerms(dataDir, doc) {
  await mkdir(dirname(termsPath(dataDir)), { recursive: true })
  const text = JSON.stringify(doc, null, 2) + '\n'
  const target = termsPath(dataDir)
  const temp = target + '.tmp'
  await writeFile(temp, text, 'utf-8')
  await rename(temp, target)
}

/** 取某个用户的表；没有就是空表（不是错误）。 */
export function getTable(doc, user) {
  const table = doc.tables?.[user]
  if (table === null || table === undefined || Array.isArray(table.entries) === false) {
    return { user, entries: [], updatedAt: null }
  }
  return { user, entries: table.entries, updatedAt: table.updatedAt ?? null }
}

/**
 * 把一张**已校验通过**的表放进文档（不改输入文档，返回新对象）。
 * @returns {{ doc: object, previousEntries: number, overwritten: boolean }}
 */
export function putTable(doc, user, entries, now = new Date().toISOString()) {
  const previous = getTable(doc, user)
  const tables = { ...doc.tables, [user]: { updatedAt: now, entries } }
  return {
    doc: { version: 1, updatedAt: now, tables },
    previousEntries: previous.entries.length,
    overwritten: previous.updatedAt !== null,
  }
}

/** 记下"当前会话用哪个用户"（`/hello?user=` 或成功上传时写）。 */
export async function saveActiveUser(dataDir, user, now = new Date().toISOString()) {
  const target = termsActivePath(dataDir)
  await mkdir(dirname(target), { recursive: true })
  const temp = target + '.tmp'
  await writeFile(temp, JSON.stringify({ user, at: now }, null, 2) + '\n', 'utf-8')
  await rename(temp, target)
}

/** 读"当前会话用哪个用户"；读不到就返回 null（不猜、不回落到 default）。 */
export async function loadActiveUser(dataDir) {
  try {
    const text = await readFile(termsActivePath(dataDir), 'utf-8')
    const parsed = JSON.parse(text)
    const user = parsed?.user
    return typeof user === 'string' && user !== '' ? user : null
  } catch {
    return null
  }
}
