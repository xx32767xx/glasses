/**
 * libraries.mjs —— 术语库、分类与批量导入（管理员建库，用户选择）
 * ============================================================================
 *
 * 与旧模型的区别（见 docs/19）：
 *   旧：`terms.json` 里 `tables.<用户>` = 一张表，**用户自己改自己的表**。
 *   新：**管理员建库并分类**，用户只能"选库"和"提申请"；库是共享资源。
 *
 * 三条实现要点：
 *   ① **条目主键用 foldKey(zh)**（不是数组下标）：下标会因为一次增删而全体错位，
 *      而 update/delete 申请必须指向"同一个条目"。折叠后比较也符合现有匹配口径。
 *   ② **写库一律过 validateTerms**：库是共享的，一条脏数据会污染所有选了这个库的会议。
 *   ③ **每次写库都记审计**（`library-audit.jsonl`）：谁改的、改了什么、来自哪条申请。
 *      审计只追加不改写 —— 出事时唯一能还原真相的东西。
 */

import { join } from 'node:path'
import { foldKey, validateTerms } from './terms.mjs'
import { appendJsonl, newId, readJson, writeJsonAtomic } from './store.mjs'

export const LIBRARY_LIMITS = {
  maxNameChars: 40,
  maxLibraries: 200,
  maxCategories: 50,
  maxVisibilityUsers: 50,
}

export const VISIBILITIES = ['public', 'restricted']

export function categoriesPath(root) {
  return join(root, 'categories.json')
}

export function librariesDir(root) {
  return join(root, 'libraries')
}

export function libraryPath(root, id) {
  return join(librariesDir(root), `${id}.json`)
}

export function libraryAuditPath(root) {
  return join(root, 'library-audit.jsonl')
}

export function emptyCategories() {
  return { version: 1, updatedAt: null, categories: [] }
}

export async function loadCategories(root) {
  const doc = await readJson(categoriesPath(root), emptyCategories())
  const list = Array.isArray(doc.categories) ? doc.categories : []
  return { version: 1, updatedAt: doc.updatedAt ?? null, categories: list }
}

export async function saveCategories(root, doc) {
  return writeJsonAtomic(categoriesPath(root), doc)
}

/** 分类名归一：去空白、限长。分类**只做一层**（先用起来，别急着上二级）。 */
export function normalizeCategoryName(raw) {
  if (typeof raw !== 'string') return { ok: false, error: '分类名必须是字符串' }
  const name = raw.trim().replace(/\s+/g, ' ')
  if (name === '') return { ok: false, error: '分类名不能为空' }
  if (name.length > LIBRARY_LIMITS.maxNameChars) {
    return { ok: false, error: `分类名最多 ${LIBRARY_LIMITS.maxNameChars} 个字符` }
  }
  return { ok: true, name }
}

/** 新建分类（同名去重：同名不同 id 会让"按分类筛选"变得不可预测）。 */
export function addCategory(doc, rawName, now = new Date().toISOString()) {
  const name = normalizeCategoryName(rawName)
  if (name.ok !== true) return { ok: false, error: name.error }
  const found = doc.categories.find((item) => item.name === name.name)
  if (found !== undefined) return { ok: true, doc, category: found, created: false }
  if (doc.categories.length >= LIBRARY_LIMITS.maxCategories) {
    return { ok: false, error: `分类最多 ${LIBRARY_LIMITS.maxCategories} 个` }
  }
  const category = { id: newId('cat'), name: name.name, createdAt: now }
  return {
    ok: true,
    created: true,
    category,
    doc: { version: 1, updatedAt: now, categories: [...doc.categories, category] },
  }
}

/** 库 id 校验：它会被拼进文件名，所以**禁止路径字符**（防目录穿越）。 */
export function normalizeLibraryId(raw) {
  if (typeof raw !== 'string') return { ok: false, error: '库 id 必须是字符串' }
  const id = raw.trim()
  if (id === '') return { ok: false, error: '库 id 不能为空' }
  if (/^[A-Za-z0-9_-]{1,64}$/.test(id) !== true) {
    return { ok: false, error: '库 id 只能包含字母、数字、下划线与连字符' }
  }
  return { ok: true, id }
}

export function emptyLibrary() {
  return {
    version: 1, id: null, name: '', categoryId: null, priority: 0,
    visibility: 'public', users: [], entries: [], createdAt: null, updatedAt: null, updatedBy: null,
  }
}

/**
 * 校验一个库（可以带 id，也可以不带 —— 不带表示新建）。
 * `entries` 逐条过 `validateTerms`：**一条不合法就整库拒绝**（半份库比没有库更危险）。
 */
export function validateLibrary(input, knownCategories = []) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: '库必须是对象' }
  }
  const name = normalizeCategoryName(input.name)
  if (name.ok !== true) return { ok: false, error: `库名不对：${name.error}` }
  const categoryId = input.categoryId ?? null
  if (categoryId !== null && knownCategories.length > 0 && knownCategories.includes(categoryId) !== true) {
    return { ok: false, error: `分类不存在：${categoryId}` }
  }
  const visibility = input.visibility ?? 'public'
  if (VISIBILITIES.includes(visibility) !== true) {
    return { ok: false, error: `可见性只能是 ${VISIBILITIES.join(' / ')}` }
  }
  const priority = input.priority ?? 0
  if (Number.isFinite(priority) !== true) return { ok: false, error: 'priority 必须是数字' }
  const entries = Array.isArray(input.entries) ? input.entries : []
  if (entries.length > LIBRARY_LIMITS.maxNameChars * 10 + 500) {
    return { ok: false, error: '条目过多' }
  }
  const checked = validateTerms(entries)
  if (checked.ok !== true) {
    const first = checked.rejected[0] ?? {}
    return { ok: false, error: `条目不合法（第 ${first.index ?? '?'} 条：${first.reason ?? first.code ?? '未知'}）`, rejected: checked.rejected }
  }
  if (checked.entries.length === 0) return { ok: false, error: '库至少要有一条条目' }
  return {
    ok: true,
    entries: checked.entries,
    warnings: checked.warnings,
    library: {
      ...emptyLibrary(),
      name: name.name, categoryId, priority, visibility, entries: checked.entries,
    },
  }
}

export async function loadLibrary(root, rawId) {
  const id = normalizeLibraryId(rawId)
  if (id.ok !== true) return null
  const data = await readJson(libraryPath(root, id.id), null)
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  return { ...emptyLibrary(), ...data, id: id.id }
}

export async function listLibraries(root) {
  const { readdir } = await import('node:fs/promises')
  let names = []
  try {
    names = await readdir(librariesDir(root))
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    if (name.endsWith('.json') !== true) continue
    const library = await loadLibrary(root, name.slice(0, -5))
    if (library !== null) out.push(library)
  }
  out.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  return out
}

async function audit(root, record) {
  return appendJsonl(libraryAuditPath(root), record)
}

/**
 * 建库或改库（管理员动作，调用方负责鉴权）。
 * @returns {{ ok: boolean, error?: string, library?: object, created?: boolean }}
 */
export async function saveLibrary(root, input, options = {}) {
  const now = options.now ?? new Date().toISOString()
  const by = options.by ?? null
  const categories = await loadCategories(root)
  const knownIds = categories.categories.map((item) => item.id)
  const checked = validateLibrary(input, knownIds)
  if (checked.ok !== true) return { ok: false, error: checked.error, rejected: checked.rejected }

  const wanted = input.id === undefined || input.id === null ? null : normalizeLibraryId(input.id)
  if (wanted !== null && wanted.ok !== true) return { ok: false, error: wanted.error }
  const existing = wanted === null ? null : await loadLibrary(root, wanted.id)
  if (wanted !== null && existing === null) return { ok: false, error: `库不存在：${wanted.id}` }

  const library = {
    ...emptyLibrary(),
    ...(existing ?? {}),
    ...checked.library,
    id: existing?.id ?? wanted?.id ?? newId('lib'),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    updatedBy: by,
    version: (existing?.version ?? 1) + (existing === null ? 0 : 1),
  }
  await writeJsonAtomic(libraryPath(root, library.id), library)
  await audit(root, { at: now, by, event: existing === null ? 'library.create' : 'library.update', libraryId: library.id, entries: library.entries.length, source: options.source ?? 'cli' })
  return { ok: true, library, created: existing === null, warnings: checked.warnings }
}

/**
 * 批量导入（管理员首次建库的主要方式，用户明确要求）。
 *
 * 语义：逐个条目独立成败 —— **一条坏数据不能拖垮整批**（否则 200 条的库要手工拆）。
 * 但每个库自身是原子的：要么整库写入成功，要么这个库一条都不写。
 */
export async function importLibraries(root, items, options = {}) {
  const now = options.now ?? new Date().toISOString()
  const by = options.by ?? null
  const report = { created: [], updated: [], rejected: [] }
  if (Array.isArray(items) !== true) return { ok: false, error: '导入内容必须是数组', report }
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    const saved = await saveLibrary(root, item, { now, by, source: 'import' })
    if (saved.ok !== true) {
      report.rejected.push({ index, name: item?.name ?? null, error: saved.error })
      continue
    }
    if (saved.created === true) report.created.push(saved.library.id)
    else report.updated.push(saved.library.id)
  }
  return { ok: report.rejected.length === 0, report }
}

/**
 * 跨库冲突：同一个中文名（折叠后）在不同库里给了不同的目标写法。
 * **只报告，不裁决** —— 裁决在聚合快照时按 priority 做（见 snapshot.mjs）。
 */
export function detectConflicts(libraries) {
  const groups = new Map()
  for (const library of libraries) {
    for (const entry of library.entries ?? []) {
      const key = foldKey(entry.zh)
      if (key === '') continue
      if (groups.has(key) === false) groups.set(key, [])
      groups.get(key).push({
        libraryId: library.id, libraryName: library.name, priority: library.priority ?? 0,
        zh: entry.zh, pt: entry.pt, variants: entry.variants ?? [],
      })
    }
  }
  const conflicts = []
  for (const [, list] of groups) {
    if (list.length < 2) continue
    const targets = new Set(list.map((item) => foldKey(item.pt)))
    if (targets.size < 2) continue
    conflicts.push({ zh: list[0].zh, variants: list })
  }
  conflicts.sort((left, right) => (left.zh < right.zh ? -1 : left.zh > right.zh ? 1 : 0))
  return conflicts
}
