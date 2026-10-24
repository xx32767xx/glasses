/**
 * meeting-terms.mjs —— "这一场用哪些库" → 一份可直接被插件读的会议术语
 * ============================================================================
 *
 * 用户在 2026-10-24 提的设计（本文就按它实现）：
 *
 *   「手机端开始同传 → 服务端立刻把选中的热词表复制到该会议专属空间（分配一个 id）
 *     → 插件直接查这个路径里的词表；复制流程里顺便合并、并把不同库之间的冲突修掉」
 *
 * 为什么这个设计比"启动参数 + 快照"更对：
 *   · **会议边界由"开始说话"决定**，不由"电脑什么时候启动 start-all"决定 ——
 *     后者会让"取消勾选后重启还留着旧词表"这类怪事发生（我们真踩了）；
 *   · 插件只认**一个固定路径**，不需要任何命令行参数；
 *   · 一展开就是"会议 id + 归档"，以后做历史/回放不用重做。
 *
 * 两个路径（都在 <data-dir> 下）：
 *   · `meeting-terms/terms.json` + `terms-active.json`：**当前这一场**，插件每句都读它；
 *   · `meetings/<会议id>/`：同样两份内容 + `meta.json`，用于归档/回看（只写不读）。
 *
 * 合并与冲突（沿用 docs/19 的 R3+R4）：
 *   · 同一个中文名在多个库里给了**不同**目标写法 → 取 priority 最高的库；
 *   · priority 相同 → **这条不进入本场术语**，并记在 meta.conflicts 里（界面上要能提示）。
 *     宁可少一条，也不要输出一个"看起来像样"的错译名。
 */

import { join } from 'node:path'
import { foldKey, putTable, saveActiveUser, saveTerms, emptyDoc } from './terms.mjs'
import { aggregateLibraries, meetingDir, snapshotUserKey } from './snapshot.mjs'
import { listLibraries } from './libraries.mjs'
import { writeJsonAtomic } from './store.mjs'

/** 当前这一场的固定路径 —— 插件只认它，不需要任何参数。 */
export function currentTermsDir(root) {
  return join(root, 'meeting-terms')
}

export function currentTermsPaths(root) {
  const dir = currentTermsDir(root)
  return { dir, termsPath: join(dir, 'terms.json'), activePath: join(dir, 'terms-active.json'), metaPath: join(dir, 'meta.json') }
}

/** 会议 id：人眼可读（时间 + 4 位随机），也便于在 meetings/ 下排序。 */
function newMeetingId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14)
  return `m-${stamp}-${Math.random().toString(36).slice(2, 6)}`
}

/**
 * 发布"这一场"的会议术语。**幂等可重入**：同一秒内重复调用会得到同一个会议 id。
 *
 * @param {string} root 数据目录（例如 var/live）
 * @param {{ libraryIds?: string[], owner?: string|null, meetingId?: string, now?: string }} options
 */
export async function publishMeetingTerms(root, options = {}) {
  const nowIso = options.now ?? new Date().toISOString()
  const meetingId = typeof options.meetingId === 'string' && options.meetingId !== ''
    ? options.meetingId
    : newMeetingId(new Date(nowIso))
  const libraries = Array.isArray(options.libraries) ? options.libraries : await listLibraries(root)
  const wanted = Array.isArray(options.libraryIds) ? options.libraryIds : []
  const chosen = libraries.filter((library) => wanted.includes(library.id))
  const { entries, conflicts } = aggregateLibraries(chosen)

  const user = snapshotUserKey(meetingId)
  const built = putTable(emptyDoc(), user, entries, nowIso)
  const paths = currentTermsPaths(root)
  await saveTerms(paths.dir, built.doc)      // 写 meeting-terms/terms.json
  await saveActiveUser(paths.dir, user, nowIso)

  const meta = {
    meetingId, createdAt: nowIso, owner: options.owner ?? null,
    libraryIds: chosen.map((library) => library.id),
    libraries: chosen.map((library) => ({ id: library.id, name: library.name, priority: library.priority ?? 0, entries: (library.entries ?? []).length })),
    entries: entries.length,
    conflicts,
  }
  await writeJsonAtomic(paths.metaPath, meta)

  // 归档一份到 meetings/<会议id>/（只写不读：供以后看"那一场到底用了哪份表"）
  const archiveDir = meetingDir(root, meetingId)
  await saveTerms(archiveDir, built.doc)
  await saveActiveUser(archiveDir, user, nowIso)
  await writeJsonAtomic(join(archiveDir, 'meta.json'), meta)

  return { meetingId, user, entries: entries.length, conflicts, meta, termsPath: paths.termsPath, activePath: paths.activePath }
}

/** 读"当前这一场"的描述（界面/诊断用；没有就返回 null）。 */
export async function readCurrentMeeting(root) {
  const paths = currentTermsPaths(root)
  try {
    const { readFile } = await import('node:fs/promises')
    return JSON.parse(await readFile(paths.metaPath, 'utf-8'))
  } catch {
    return null
  }
}

export { foldKey }
