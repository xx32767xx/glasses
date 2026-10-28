/**
 * requests.mjs —— 用户只能"提申请"，管理员审批后才改库
 * ============================================================================
 *
 * 为什么这么设计（用户 2026-10-23 的要求）：**用户改不了库**。
 * 这一条同时解决两个真实问题：
 *   ① 共享库被随手改坏 —— 一个人改错，所有选了该库的会议都跟着错；
 *   ② 改错之后无从追查 —— 没有审批记录，就不知道"这条是加进来的还是本来就是错的"。
 *
 * 状态机（只向前，不回头）：
 *     pending ──approve──▶ approved（写入库，库 version+1）
 *        │
 *        ├──reject──▶ rejected
 *        └──withdraw──▶ withdrawn（申请人自己撤回）
 *
 * 存储：`requests.jsonl` **只追加**。每条申请先写一条 `create`，决定时再写一条 `decision`，
 * 两者靠 `id` 关联、回放成当前状态。为什么不直接改对象：
 *   · 只追加的文件断电最多丢最后一行，不会变成"半份状态"；
 *   · 审批记录本身就是审计材料，写丢了就说不清当时为什么这么批。
 */

import { join } from 'node:path'
import { foldKey, validateTerms } from './terms.mjs'
import { loadLibrary, libraryPath, saveLibrary } from './libraries.mjs'
import { newId, readJsonl } from './store.mjs'
import { appendRequestEvent, readRequestEvents } from './requests-store.mjs'

export const REQUEST_TYPES = ['add', 'update', 'delete']
export const REQUEST_STATUS = ['pending', 'approved', 'rejected', 'withdrawn']

export const REQUEST_LIMITS = {
  maxReasonChars: 300,
  maxPendingPerApplicant: 50,
}

export function requestsPath(root) {
  return join(root, 'requests.jsonl')
}

/** 把追加的文件回放成"当前状态"（每个 id 一条）。 */
export function replayRequests(records) {
  const items = new Map()
  for (const record of records) {
    if (record === null || typeof record !== 'object' || typeof record.id !== 'string') continue
    if (record.event === 'create') {
      items.set(record.id, {
        id: record.id,
        type: record.type,
        libraryId: record.libraryId,
        entry: record.entry ?? null,
        targetKey: record.targetKey ?? null,
        reason: record.reason ?? '',
        applicant: record.applicant ?? null,
        createdAt: record.at ?? null,
        status: 'pending',
        hidden: false,
        decidedBy: null,
        decidedAt: null,
        note: '',
      })
      continue
    }
    if (record.event === 'hide') {
      const item = items.get(record.id)
      if (item === undefined) continue
      // 只打"从我的列表里删掉"的标记，status 保持原样（审批结论不能被删改）
      item.hidden = true
      continue
    }
    if (record.event === 'decision') {
      const item = items.get(record.id)
      if (item === undefined) continue // 没有 create 的 decision 是坏数据，跳过（readJsonl 已计数）
      if (REQUEST_STATUS.includes(record.decision) !== true) continue
      if (item.status !== 'pending') continue // 已决定的不能再改（状态机只向前）
      item.status = record.decision
      item.decidedBy = record.by ?? null
      item.decidedAt = record.at ?? null
      item.note = record.note ?? ''
    }
  }
  return items
}

export async function loadRequests(root) {
  let { records, badLines } = readRequestEvents(root)
  if (records.length === 0) {
    // 过渡期：库里没有申请时读一次旧的 requests.jsonl（迁移未完成时行为不变）
    const legacy = await readJsonl(requestsPath(root))
    records = legacy.records; badLines = legacy.badLines
  }
  return { items: replayRequests(records), badLines, records }
}

export function pendingOf(items) {
  return [...items.values()].filter((item) => item.status === 'pending' && item.hidden !== true)
}

/** 我的申请里要看到的那些（自己删掉的不算）。 */
export function visibleOfMine(items, applicant) {
  return [...items.values()].filter((item) => item.applicant === applicant && item.hidden !== true)
}

/**
 * 建申请。**只有 pending 这一种初始态**，且同目标去重 ——
 * 同一个库、同一个中文名、同一类型的待审申请只留一条，否则管理员会被同一件事刷屏。
 */
export async function createRequest(root, input, options = {}) {
  const now = options.now ?? new Date().toISOString()
  const type = input?.type
  if (REQUEST_TYPES.includes(type) !== true) {
    return { ok: false, error: `申请类型只能是 ${REQUEST_TYPES.join(' / ')}` }
  }
  const applicant = typeof input?.applicant === 'string' && input.applicant !== '' ? input.applicant : null
  if (applicant === null) return { ok: false, error: '缺少申请人' }
  const reason = typeof input?.reason === 'string' ? input.reason.trim() : ''
  if (reason === '') return { ok: false, error: '必须写申请理由（审批要看得懂为什么改）' }
  if (reason.length > REQUEST_LIMITS.maxReasonChars) {
    return { ok: false, error: `理由最多 ${REQUEST_LIMITS.maxReasonChars} 字` }
  }

  const library = await loadLibrary(root, input?.libraryId)
  if (library === null) return { ok: false, error: `库不存在：${input?.libraryId ?? '(空)'}` }

  let entry = null
  let targetKey = null
  if (type === 'add' || type === 'update') {
    const checked = validateTerms([input?.entry])
    if (checked.ok !== true || checked.entries.length !== 1) {
      const first = checked.rejected?.[0] ?? {}
      return { ok: false, error: `条目不合法：${first.reason ?? first.code ?? '未知'}` }
    }
    entry = checked.entries[0]
    targetKey = foldKey(entry.zh)
    const exists = (library.entries ?? []).some((item) => foldKey(item.zh) === targetKey)
    if (type === 'add' && exists) {
      return { ok: false, error: '这个中文名在库里已经有了（应走「修改」申请）' }
    }
    if (type === 'update' && exists !== true) {
      return { ok: false, error: '要修改的条目在库里不存在（应走「新增」申请）' }
    }
  } else {
    const key = typeof input?.targetKey === 'string' ? input.targetKey.trim() : ''
    if (key === '') return { ok: false, error: '删除申请必须给出要删的条目（中文名）' }
    targetKey = foldKey(key)
    const exists = (library.entries ?? []).some((item) => foldKey(item.zh) === targetKey)
    if (exists !== true) return { ok: false, error: '要删除的条目在库里不存在' }
  }

  const { items } = await loadRequests(root)
  const mine = pendingOf(items).filter((item) => item.applicant === applicant)
  if (mine.length >= REQUEST_LIMITS.maxPendingPerApplicant) {
    return { ok: false, error: `待审申请太多（上限 ${REQUEST_LIMITS.maxPendingPerApplicant} 条），请等管理员处理` }
  }
  const duplicate = mine.find((item) => item.libraryId === library.id
    && item.targetKey === targetKey && item.type === type)
  if (duplicate !== undefined) {
    return { ok: false, error: `已经有一条同样的待审申请（${duplicate.id}），不重复提交`, duplicate: duplicate.id }
  }

  const id = newId('req')
  appendRequestEvent(root, {
    event: 'create', id, type, libraryId: library.id, entry, targetKey, reason, applicant, at: now })
  return { ok: true, id, status: 'pending', libraryId: library.id, type, targetKey }
}

/**
 * 审批。approve 会**真的改库**（这一点是"只追加"原则的唯一例外，改库后立刻记审计）。
 * @param {{ decision: 'approve'|'reject', by: string, note?: string, now?: string }} options
 */
export async function decideRequest(root, id, options = {}) {
  const decision = options.decision
  if (decision !== 'approve' && decision !== 'reject') {
    return { ok: false, error: '决定只能是 approve / reject（撤回由申请人自己走 withdraw）' }
  }
  const by = typeof options.by === 'string' && options.by !== '' ? options.by : null
  if (by === null) return { ok: false, error: '缺少审批人' }
  const now = options.now ?? new Date().toISOString()
  const note = typeof options.note === 'string' ? options.note.trim() : ''

  const { items } = await loadRequests(root)
  const item = items.get(id)
  if (item === undefined) return { ok: false, error: `没有这条申请：${id}` }
  if (item.status !== 'pending') return { ok: false, error: `这条申请已经是 ${item.status} 了（不能重复审批）` }

  let library = null
  if (decision === 'approve') {
    library = await loadLibrary(root, item.libraryId)
    if (library === null) return { ok: false, error: `库不存在：${item.libraryId}` }
    const entries = [...(library.entries ?? [])]
    const index = entries.findIndex((entry) => foldKey(entry.zh) === item.targetKey)
    if (item.type === 'add') {
      if (index >= 0) return { ok: false, error: '库里已经有这个中文名了（申请过期，请让用户重新提交）' }
      entries.push(item.entry)
    } else if (item.type === 'update') {
      if (index < 0) return { ok: false, error: '要修改的条目已不在库里（可能被别的申请删了）' }
      entries[index] = item.entry
    } else if (item.type === 'delete') {
      if (index < 0) return { ok: false, error: '要删除的条目已不在库里' }
      entries.splice(index, 1)
    }
    const saved = await saveLibrary(root, {
      ...library, entries, id: library.id, name: library.name,
      categoryId: library.categoryId, priority: library.priority, visibility: library.visibility,
    }, { now, by, source: `request:${id}` })
    if (saved.ok !== true) return { ok: false, error: `写库失败：${saved.error}` }
    library = saved.library
  }

  appendRequestEvent(root, {
    event: 'decision', id, decision: decision === 'approve' ? 'approved' : 'rejected', by, at: now, note,
  })
  return { ok: true, id, status: decision === 'approve' ? 'approved' : 'rejected', library }
}

/** 申请人撤回自己的待审申请（管理员不代办撤回，避免"审批人替申请人表态"）。 */
export async function withdrawRequest(root, id, options = {}) {
  const applicant = typeof options.applicant === 'string' ? options.applicant : ''
  const now = options.now ?? new Date().toISOString()
  const { items } = await loadRequests(root)
  const item = items.get(id)
  if (item === undefined) return { ok: false, error: `没有这条申请：${id}` }
  if (item.status !== 'pending') return { ok: false, error: `这条申请已经是 ${item.status} 了` }
  if (item.applicant !== applicant) return { ok: false, error: '只能撤回自己的申请' }
  appendRequestEvent(root, { event: 'decision', id, decision: 'withdrawn', by: applicant, at: now, note: '' })
  return { ok: true, id, status: 'withdrawn' }
}

/**
 * 申请人把自己**已经有结论**的申请从列表里删掉（4.64）。
 *
 * <p>为什么不能删 pending：pending 要覆盖成“撤回”，否则管理员那边的待审列表会凭空少一条、
 * 而申请人以为自己“没提过”。删除**只是从自己的列表里隐藏**：
 * 审批记录是审计材料，数据库里仍然在（只是 hidden_at 有了值）。
 */
export async function hideRequest(root, id, options = {}) {
  const applicant = typeof options.applicant === 'string' ? options.applicant : ''
  const now = options.now ?? new Date().toISOString()
  const { items } = await loadRequests(root)
  const item = items.get(id)
  if (item === undefined) return { ok: false, error: `没有这条申请：${id}` }
  if (item.applicant !== applicant) return { ok: false, error: '只能删除自己的申请' }
  if (item.status === 'pending') return { ok: false, error: '待审批的申请请先撤回（不能被删除）' }
  if (item.hidden === true) return { ok: true, id, status: item.status }
  appendRequestEvent(root, { event: 'hide', id, at: now })
  return { ok: true, id, status: item.status }
}

/** 供别处引用（避免重复拼路径）。 */
export { libraryPath }
