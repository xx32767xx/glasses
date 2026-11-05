/**
 * disk-clean.mjs —— 「数据目录里哪些东西只增不减、能安全清哪些」（5.118）
 * ============================================================================
 *
 * 拆成 lib 是为了**能被测试直接调用**：这个工具的失败模式是"删多了"
 * （`audio/`、`var/logs/`、`var/cache/`（模型 6.7G）、`var/asr-eval/`（评测数据）
 * 在同一个数据目录的兄弟位置），而"删多了"没法靠人眼 review 守住 —— 得有断言。
 * 另外测试里**不能起子进程**（沙箱下 pipe 会 EPERM），所以逻辑必须在进程内可调。
 *
 * 三条纪律（写死在这里，不是文档里的提醒）：
 *   ① `cleanable: false` 的两类（模型、评测数据）**不参与任何删除**；
 *   ② 只处理 `SECTIONS` 里列出的路径，不做"递归删数据目录下所有旧文件"这种聪明事；
 *   ③ 时间阈值按**文件 mtime**，不是目录 mtime（目录 mtime 会随新文件变化）。
 */

import { existsSync, readdirSync, statfsSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, VAR_DIR } from './paths.mjs'

export const MB = 1024 * 1024
export const humanMb = (bytes) => `${(bytes / MB).toFixed(1)} MB`

/**
 * 数据目录里会长的东西，以及**能不能清**。
 *
 * <p>`name` 后面带 `!` 的是"绝不能删"的：删了要重下几 GB 模型、或重跑评测才有那些数字。
 */
export function sectionsFor(dataDir, { keepLogs = true } = {}) {
  return [
    { name: '分轨音频', path: join(dataDir, 'audio'), cleanable: true },
    {
      name: '识别收件箱',
      path: dataDir,
      match: /^asr-inbox-.*\.jsonl$/,
      cleanable: true,
    },
    { name: '识别队列（没被取走的段）', path: join(dataDir, 'queue', 'asr'), cleanable: true },
    { name: '字幕总线（散会后留着）', path: join(dataDir, 'buses'), cleanable: true },
    { name: '运行日志 var/logs', path: join(VAR_DIR, 'logs'), cleanable: !keepLogs },
    { name: '临时 var/tmp', path: join(VAR_DIR, 'tmp'), cleanable: true },
    { name: '模型缓存 !', path: join(VAR_DIR, 'cache'), cleanable: false },
    { name: '评测数据 !', path: join(VAR_DIR, 'asr-eval'), cleanable: false },
  ]
}

/** 一个目录（或文件）的总字节数与文件数；不存在就 0。 */
export function sizeOf(path) {
  let bytes = 0
  let files = 0
  const walk = (target) => {
    let info
    try {
      info = statSync(target)
    } catch {
      return
    }
    if (info.isDirectory()) {
      let names = []
      try {
        names = readdirSync(target)
      } catch {
        return
      }
      for (const name of names) walk(join(target, name))
      return
    }
    bytes += info.size
    files += 1
  }
  walk(path)
  return { bytes, files }
}

/** 列出目录下的文件（两层就够：音频是"房间目录/文件"，其它都是平铺）。 */
export function listFiles(path, depth = 0) {
  const out = []
  let names = []
  try {
    names = readdirSync(path)
  } catch {
    return out
  }
  for (const name of names) {
    const full = join(path, name)
    let info
    try {
      info = statSync(full)
    } catch {
      continue
    }
    if (info.isDirectory()) {
      if (depth < 2) out.push(...listFiles(full, depth + 1))
      continue
    }
    out.push({ path: full, bytes: info.size, mtimeMs: info.mtimeMs })
  }
  return out
}

/**
 * 算出"要清什么"。**不删任何东西**，纯读。
 *
 * @param {{dataDir: string, olderThanDays?: number, keepLogs?: boolean, now?: number}} options
 * @returns {{cutoff: number, rows: Array<{name: string, bytes: number, files: number,
 *            cleanable: boolean}>, plan: Array<{name: string, files: string[], bytes: number}>,
 *            totalBytes: number}}
 */
export function collectPlan(options = {}) {
  const dataDir = String(options.dataDir ?? '')
  const days = Number(options.olderThanDays ?? 3)
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now()
  /**
   * `--older-than 0` 的语义是"**不按时间筛，全清**"（应急时用）。
   *
   * 不能用 `mtime < now` 来实现：刚写出来的文件 mtime 常常等于 now（同一毫秒），
   * 于是"全清"会漏掉最新的那几个 —— 测过就会偶发失败（报告里少了刚造的那个文件），
   * 用户看到的则是"说全清，却没清干净"。所以 0 天走的是**完全不筛**这条路。
   */
  const noAgeFilter = !(days > 0)
  const cutoff = now - Math.max(0, days) * 24 * 60 * 60 * 1000
  const rows = []
  const plan = []
  // `--keep-logs` 说的是"别动日志"；不传就是要清。这里只判一次，别在两边各取反一次。
  const keepLogs = options.keepLogs === true
  for (const section of sectionsFor(dataDir, { keepLogs })) {
    // 带 match 的段（收件箱）要**按名字筛**：它的 path 是数据目录本身，
    // 不筛的话会把整个数据目录的文件数算进来（报告里会显示"收件箱 N 个文件"）。
    const matched = section.match
      ? listFiles(section.path).filter((one) => section.match.test(one.path.split(/[\\/]/).pop() ?? ''))
      : null
    const totals = matched === null
      ? sizeOf(section.path)
      : { bytes: matched.reduce((sum, one) => sum + one.bytes, 0), files: matched.length }
    rows.push({ name: section.name, bytes: totals.bytes, files: totals.files, cleanable: section.cleanable })
    if (!section.cleanable) continue
    const candidates = matched ?? listFiles(section.path)
    const stale = noAgeFilter ? candidates : candidates.filter((one) => one.mtimeMs < cutoff)
    if (stale.length > 0) {
      plan.push({
        name: section.name,
        files: stale.map((one) => one.path),
        bytes: stale.reduce((sum, one) => sum + one.bytes, 0),
      })
    }
  }
  return { cutoff, rows, plan, totalBytes: plan.reduce((sum, one) => sum + one.bytes, 0) }
}

/** 真删（只删 plan 里列出的文件）。 */
export function applyPlan(plan) {
  let removed = 0
  let failed = 0
  for (const item of plan ?? []) {
    for (const path of item.files ?? []) {
      try {
        unlinkSync(path)
        removed += 1
      } catch {
        failed += 1
      }
    }
  }
  return { removed, failed }
}

/** 磁盘余量（Node 18.15+ 才有 statfs；拿不到就返回 null，不影响清理判断）。 */
export function diskSpace(path = ROOT) {
  try {
    const info = statfsSync(existsSync(path) ? path : ROOT)
    const totalGb = (info.blocks * info.bsize) / (1024 * MB)
    const freeGb = (info.bavail * info.bsize) / (1024 * MB)
    return {
      totalGb,
      freeGb,
      usedPercent: totalGb > 0 ? ((totalGb - freeGb) / totalGb) * 100 : 0,
    }
  } catch {
    return null
  }
}

/** 命令行解析（给脚本用；测试也直接调它）。 */
export function parseCleanArgs(argv) {
  const args = {
    dataDir: process.env.LEION_DATA_DIR || 'var/live',
    olderThanDays: 3,
    clean: false,
    keepLogs: false,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item === '--data-dir') args.dataDir = argv[index += 1] ?? args.dataDir
    else if (item === '--older-than') args.olderThanDays = Number(argv[index += 1] ?? 3)
    else if (item === '--clean') args.clean = true
    else if (item === '--keep-logs') args.keepLogs = true
    else if (item === '--help' || item === '-h') args.help = true
    else return { ok: false, error: `不认识的参数：${item}` }
  }
  if (!Number.isFinite(args.olderThanDays) || args.olderThanDays < 0) {
    return { ok: false, error: '--older-than 必须是非负天数（0 = 不按时间筛，全清）' }
  }
  if (!args.dataDir) return { ok: false, error: '缺 --data-dir' }
  return { ok: true, args }
}
