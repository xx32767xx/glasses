/**
 * snapshot.mjs —— 把"这场会议选中的几个库"冻结成插件能直接读的一份表
 * ============================================================================
 *
 * 为什么要有"快照"：
 *   ① 插件（`plugin/core.mjs`）只认一份文件 + 一个 user 键（见它的 `refreshTerms`），
 *      它不该知道"库/分类/申请"这些概念 —— 把复杂度挡在服务端，插件零改动；
 *   ② 会议进行中管理员改了库，**不应影响已经开始的会议**（沿用 docs/15 §8.1 的语义）。
 *
 * 跨库冲突的裁决（用户 2026-10-23 认可 R3 + R4）：
 *   · 同一个中文名（折叠后）在不同库里给了**不同**目标写法时：`priority` 大的库赢；
 *   · `priority` 相同 → 视为冲突，**该条目不参与归一**，并记进 conflicts 交给界面提示。
 *   为什么宁可少一条也不猜：术语写错的代价远高于没有术语 ——
 *   写错时用户看不出来（输出的是"一个像样的葡语专名"），而没有术语至少不会误导。
 */

import { join } from 'node:path'
import { foldKey, putTable, saveActiveUser, saveTerms, emptyDoc } from './terms.mjs'
import { writeJsonAtomic } from './store.mjs'

/** 会议快照的 user 键：插件按它取表（`tables[user].entries`）。 */
export function snapshotUserKey(meetingId) {
  return `meeting:${meetingId}`
}

export function meetingDir(root, meetingId) {
  return join(root, 'meetings', String(meetingId))
}

/**
 * 聚合多个库 → 一份条目数组。
 * @returns {{ entries: object[], conflicts: object[], dropped: object[] }}
 */
export function aggregateLibraries(libraries) {
  const groups = new Map()
  for (const library of libraries) {
    for (const entry of library.entries ?? []) {
      const key = foldKey(entry.zh)
      if (key === '') continue
      if (groups.has(key) === false) groups.set(key, [])
      groups.get(key).push({ library, entry })
    }
  }

  const entries = []
  const conflicts = []
  const dropped = []
  for (const [key, list] of groups) {
    const winners = list.reduce((best, item) => {
      const priority = item.library.priority ?? 0
      return priority > best.priority ? { priority, item } : best
    }, { priority: -Infinity, item: null })
    const top = list.filter((item) => (item.library.priority ?? 0) === winners.priority)
    const targets = new Set(list.map((item) => foldKey(item.entry.pt)))
    if (targets.size > 1) {
      // 有歧义：看最高优先级里是否已经统一
      const topTargets = new Set(top.map((item) => foldKey(item.entry.pt)))
      if (topTargets.size > 1) {
        conflicts.push({
          zh: top[0].entry.zh,
          reason: 'priority 相同但目标写法不同',
          variants: list.map((item) => ({
            libraryId: item.library.id, libraryName: item.library.name,
            priority: item.library.priority ?? 0, pt: item.entry.pt,
          })),
        })
        dropped.push({ zh: top[0].entry.zh, key })
        continue
      }
    }
    // 合成一条：取最高优先级的条目为底，把各库的 variants 并起来（去重、保持折叠一致）
    const base = top[0].entry
    const variants = []
    for (const item of list) {
      for (const variant of [item.entry.pt, ...(item.entry.variants ?? [])]) {
        if (typeof variant !== 'string' || variant === '') continue
        const folded = foldKey(variant)
        if (variants.some((existing) => foldKey(existing) === folded)) continue
        variants.push(variant)
      }
    }
    entries.push({ ...base, variants: variants.filter((variant) => foldKey(variant) !== foldKey(base.pt)) })
  }
  entries.sort((left, right) => (left.zh < right.zh ? -1 : left.zh > right.zh ? 1 : 0))
  return { entries, conflicts, dropped }
}

/**
 * 写一场会议的术语快照。
 *
 * 产物两份，都在 `meetings/<id>/` 下：
 *   · `terms.json`        —— 插件形状：`{ version, updatedAt, tables: { 'meeting:<id>': { entries } } }`
 *   · `terms-active.json` —— 插件形状：`{ user: 'meeting:<id>' }`
 * 调用方（start-all / 房间服务）把这两条的路径塞进插件配置即可，**插件侧不用改**。
 */
export async function writeMeetingSnapshot(root, meetingId, options = {}) {
  const selectedIds = Array.isArray(options.libraryIds) ? options.libraryIds : []
  const libraries = Array.isArray(options.libraries) ? options.libraries : []
  const chosen = libraries.filter((library) => selectedIds.includes(library.id))
  const { entries, conflicts, dropped } = aggregateLibraries(chosen)
  const now = options.now ?? new Date().toISOString()
  const dir = meetingDir(root, meetingId)
  const user = snapshotUserKey(meetingId)
  // ⚠️ putTable 返回的是 `{ doc, previousEntries, overwritten }` 包装对象，
  // 不是 doc 本身 —— 直接把它写进文件会得到 `{ doc: {...} }` 这种插件读不懂的形状。
  const built = putTable(emptyDoc(), user, entries, now)
  const termsPath = join(dir, 'terms.json')
  await saveTerms(dir, built.doc)
  const activePath = join(dir, 'terms-active.json')
  await saveActiveUser(dir, user, now)
  await writeJsonAtomic(join(dir, 'snapshot-meta.json'), {
    meetingId, createdAt: now, libraryIds: selectedIds,
    libraries: chosen.map((library) => ({ id: library.id, name: library.name, priority: library.priority ?? 0, entries: (library.entries ?? []).length })),
    entries: entries.length, conflicts, dropped,
  })
  return { user, entries: entries.length, conflicts, dropped, termsPath, activePath, dir }
}
