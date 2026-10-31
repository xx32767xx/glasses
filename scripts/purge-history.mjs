/**
 * purge-history.mjs —— 清理会议历史与它留下的文件（一条命令，给测试环境 / cron 用）
 * ============================================================================
 *
 *   # 先看会删什么（不删任何东西）
 *   node scripts/purge-history.mjs --dry-run
 *
 *   # 删 7 天前已结束的会议
 *   node scripts/purge-history.mjs --older-than 7
 *
 *   # 清空全部已结束的会议（进行中的不动）
 *   node scripts/purge-history.mjs --all
 *
 *   # 只删点名的几场
 *   node scripts/purge-history.mjs --rooms room-mvxxx-aaaa,room-mvyyy-bbbb
 *
 * 为什么要有这个脚本（而不只是管理台）：测试环境的数据清理最好**定时**做
 * （cron / systemd timer），而管理台是给"临时想清一下"用的。两边共用
 * `lib/rooms.mjs` 的 `purgeHistory()` 与 relay 的 `removeRoomDataFiles()`，
 * 规则只有一份 —— 否则"管理台删得干净、脚本删一半"这种分裂迟早出现。
 *
 * 安全边界：
 *   · **进行中的会议永远不删**（删了正在开的会就是事故）；
 *   · 默认 --dry-run 的相反：真删要显式给出范围；不给范围就只打印帮助；
 *   · `--older-than 0` 会把所有已结束的会议都算进去 —— 脚本会要求 --yes 确认。
 */

import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEFAULT_DATA_DIR, removeRoomDataFiles } from '../relay/lan-relay.mjs'
import { listHistoryForAdmin, purgeHistory } from '../lib/rooms.mjs'

const HELP = `purge-history —— 清理会议历史（数据库里的是转写与会议行，磁盘上是音频/总线/收件箱）

  node scripts/purge-history.mjs [选项]

  --older-than <天>   删这么多天以前**已结束**的会议（缺省 7；配 --dry-run 先看）
  --all               删全部**已结束**的会议（进行中的不动）
  --rooms <id,id>     只删点名的会议（进行中的会被跳过并说明）
  --data-dir <path>   数据目录（缺省 var/live；测试环境用 /var/lib/leion/test）
  --buses <dir>       字幕总线目录（缺省 <data-dir>/buses；目录模式才删每场那份 json）
  --dry-run           只列出会删什么，不真删
  --yes               跳过"删很多"的二次确认（--older-than 0 / --all 需要）
  --help

它删什么：
  · 数据库：会议行（成员/术语快照/发言权一起走）+ 该会议的全部转写行；
  · 磁盘：audio/<房间>.pcm（+.rate/.lang）、buses/<房间>.json、asr-inbox-<房间>.jsonl。
不删：进行中的会议、术语库、账号、日志文件（var/logs）。
`

const humanBytes = (bytes) => {
  const n = Number(bytes || 0)
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 目录里所有音频文件加起来多大（含已不在会议表里的残片）。 */
export function audioDirBytes(dataDir, readDir = readdirSync, statFile = statSync) {
  const dir = join(String(dataDir), 'audio')
  try {
    let total = 0
    for (const name of readDir(dir)) {
      try { total += Number(statFile(join(dir, name)).size ?? 0) } catch { /* 正在写 */ }
    }
    return total
  } catch { return 0 }
}

/** 某场会议在磁盘上占多少（用 relay 的路径规则，不另算一份）。 */
export function roomBytesOnDisk(dataDir, roomId) {
  const probe = join(String(dataDir), '__purge_probe__')
  // 用"删一个不存在的文件"来问大小是不行的 —— 直接算：
  let total = 0
  const audioBase = join(String(dataDir), 'audio')
  const safe = String(roomId ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
  for (const suffix of ['.pcm', '.pcm.rate', '.pcm.lang']) {
    try { total += Number(statSync(join(audioBase, safe + suffix)).size ?? 0) } catch { /* 没有 */ }
  }
  try { total += Number(statSync(join(String(dataDir), `asr-inbox-${roomId}.jsonl`)).size ?? 0) } catch { /* 没有 */ }
  void probe
  return total
}

export function parseArgs(argv = []) {
  const options = {
    dataDir: DEFAULT_DATA_DIR,
    buses: null,
    mode: null,
    days: 7,
    rooms: [],
    dryRun: false,
    yes: false,
  }
  const takesValue = new Set(['data-dir', 'buses', 'older-than', 'rooms'])
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--help') { options.help = true; continue }
    if (token === '--all') { options.mode = 'all'; continue }
    if (token === '--dry-run') { options.dryRun = true; continue }
    if (token === '--yes') { options.yes = true; continue }
    if (!token.startsWith('--')) throw new Error(`看不懂的参数：${token}（用 --help 看用法）`)
    const key = token.slice(2)
    if (!takesValue.has(key)) throw new Error(`未知选项 --${key}（用 --help 看用法）`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} 需要一个值`)
    index += 1
    if (key === 'data-dir') options.dataDir = value
    else if (key === 'buses') options.buses = value
    else if (key === 'older-than') { options.mode = 'older-than'; options.days = Number(value) }
    else if (key === 'rooms') {
      options.mode = 'rooms'
      options.rooms = value.split(',').map(item => item.trim()).filter(item => item !== '')
    }
  }
  if (options.help === true) return options
  if (!Number.isFinite(options.days) || options.days < 0) {
    throw new Error(`--older-than 必须是非负数，收到 ${JSON.stringify(options.days)}`)
  }
  return options
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help === true || options.mode === null) {
    process.stdout.write(HELP)
    return 0
  }
  const dataDir = String(options.dataDir)
  const buses = options.buses === null ? join(dataDir, 'buses') : String(options.buses)

  const inventory = listHistoryForAdmin(dataDir, { limit: 2000 })
  console.log('')
  console.log('─'.repeat(70))
  console.log(`  数据目录   ${dataDir}`)
  console.log(`  现有       ${inventory.totals.rooms} 场会议（进行中 ${inventory.totals.activeRooms} 场）`
    + ` · ${inventory.totals.utterances} 条转写`)
  console.log(`  磁盘音频   ${humanBytes(audioDirBytes(dataDir))}（audio/ 整个目录）`)
  console.log('─'.repeat(70))
  console.log('')

  // 先算一遍"会删哪些"，把不可逆的事说清楚 —— dry-run 与真删共用这一段
  // ⚠️ 预览必须走 dryRun：第一版这里直接调了 purgeHistory，于是**预览就把数据删了**。
  const preview = purgeHistory(dataDir, {
    mode: options.mode, days: options.days, roomIds: options.rooms, now: Date.now(), dryRun: true,
  })
  if (preview.ok !== true) {
    console.error(`❌ ${preview.error}`)
    return 2
  }
  const byId = new Map(inventory.items.map(item => [item.id, item]))
  if (preview.roomIds.length === 0) {
    console.log('没有符合条件的会议（进行中的、或者比这个时间更近的都不会被删）。')
    console.log('')
    return 0
  }
  let plannedBytes = 0
  console.log(`将要删除 ${preview.roomIds.length} 场会议：`)
  for (const roomId of preview.roomIds) {
    const one = byId.get(roomId)
    const bytes = roomBytesOnDisk(dataDir, roomId)
    plannedBytes += bytes
    console.log(`  · ${roomId}  「${one?.name ?? '?'}」  ${one?.utterances ?? 0} 条转写  `
      + `${humanBytes(bytes)}  ${one?.lastAt ? String(one.lastAt).slice(0, 16).replace('T', ' ') : '无转写'}`)
  }
  for (const skip of preview.skipped ?? []) {
    console.log(`  ⏭ 跳过 ${skip.id}：${skip.why}`)
  }
  console.log(`合计将删除 ${preview.deletedUtterances} 条转写、释放约 ${humanBytes(plannedBytes)} 音频。`)
  console.log('')

  if (options.dryRun === true) {
    console.log('（--dry-run：什么都没删。去掉它才真的删）')
    console.log('')
    return 0
  }
  // `--older-than 0` 或 `--all` 等于"全清"，要求二次确认 —— 这类动作不该只靠一个参数就执行
  const sweeping = options.mode === 'all' || (options.mode === 'older-than' && options.days === 0)
  if (sweeping && options.yes !== true) {
    console.error('❌ 这等于清空全部已结束的会议。确认要这么做就加 --yes。')
    return 2
  }

  const result = purgeHistory(dataDir, {
    mode: options.mode, days: options.days, roomIds: options.rooms, now: Date.now(),
  })
  if (result.ok !== true) {
    console.error(`❌ ${result.error}`)
    return 2
  }
  // 文件用 relay 的同一条规则删（唯一真相，不在这里另拼路径）
  let removedFiles = 0
  for (const roomId of result.roomIds) {
    const before = roomBytesOnDisk(dataDir, roomId)
    removeRoomDataFiles(dataDir, [roomId], buses)
    const after = roomBytesOnDisk(dataDir, roomId)
    removedFiles += Math.max(0, before - after)
  }
  void existsSync
  console.log(`✅ 删了 ${result.deletedRooms} 场会议、${result.deletedUtterances} 条转写，`
    + `释放约 ${humanBytes(removedFiles)} 音频（数据库已清空这些会议）`)
  console.log('')
  return 0
}

const isCli = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isCli) {
  main().then(code => process.exit(code)).catch((error) => {
    console.error(`❌ ${String(error?.message ?? error)}`)
    process.exit(1)
  })
}

void unlinkSync
