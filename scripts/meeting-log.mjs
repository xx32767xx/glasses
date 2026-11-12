#!/usr/bin/env node
/**
 * meeting-log.mjs —— 把会议记录（一行一条 JSON）翻成人能读的样子（5.181）
 * ============================================================================
 *
 * 为什么要有它：会议记录落成 JSONL 是给机器查的（grep / jq / 以后的分析脚本），
 * 但现场校准的时候人是想**一眼读句子**的。所以这里只做一件事：把 JSON 排成人话。
 *
 *   一场会一个文件：<data-dir>/logs/rooms/<邀请码>-<房间id>.jsonl
 *   服务级事件：    <data-dir>/logs/service-<日期>.jsonl
 *
 * 用法
 *   node scripts/meeting-log.mjs                          # 列出所有会议记录（文件名/大小/句数）
 *   node scripts/meeting-log.mjs --code 229415             # 看这一场（默认只打印句子）
 *   node scripts/meeting-log.mjs --code 229415 --tail 20   # 只看最后 20 句
 *   node scripts/meeting-log.mjs --code 229415 --all       # 连会议开始/结束/异常一起打印
 *   node scripts/meeting-log.mjs --code 229415 --json      # 原样输出 JSON 行（给别的脚本用）
 *   node scripts/meeting-log.mjs --service                 # 看服务级事件
 *
 * 输出长这样（一句一块，译文按语言缩进）：
 *
 *   16:12:48  #33  段1.5s 识0.33s 译1.06s ⇒2.2s  说：test25
 *              原文 对 然后呢 吃不完的
 *              en  Right, and then, what can't be finished.
 *
 * ⚠️ 只读：不写、不删、不改。
 */
import { existsSync } from 'node:fs'
import {
  lastEventAt, listMeetingLogs, logsDirOf, readMeetingEvents,
} from '../lib/meeting-log.mjs'
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VAR_DIR } from '../lib/paths.mjs'

const SCRIPT_PATH = fileURLToPath(import.meta.url)

export function parseArgs(argv = []) {
  const options = {
    // 5.181b：缺省先看 LEION_DATA_DIR（服务器上通常是 /var/lib/leion/test），
    // 再退到仓库里的 var/live。**之前只认 var/live**，于是生产上明明有记录，
    // 脚本却去 var/live/logs/rooms 找一个不存在的目录，报"没有会议记录"。
    dataDir: process.env.LEION_DATA_DIR && String(process.env.LEION_DATA_DIR).trim() !== ''
      ? String(process.env.LEION_DATA_DIR).trim()
      : join(VAR_DIR, 'live'),
    code: '',
    tail: 0,
    all: false,
    json: false,
    service: false,
    list: false,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--help' || token === '-h') { options.help = true; continue }
    if (token === '--all') { options.all = true; continue }
    if (token === '--json') { options.json = true; continue }
    if (token === '--service') { options.service = true; continue }
    if (token === '--list') { options.list = true; continue }
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) throw new Error(`${token} 需要一个值`)
      index += 1
      return next
    }
    if (token === '--data-dir') { options.dataDir = value(); options.dataDirExplicit = true }
    else if (token === '--code') options.code = value()
    else if (token === '--tail') options.tail = Number(value())
    else throw new Error(`不认识的参数：${token}（用 --help 看用法）`)
  }
  if (options.tail !== 0 && (!Number.isFinite(options.tail) || options.tail <= 0)) {
    throw new Error('--tail 必须是正整数')
  }
  return options
}

export function helpText() {
  return [
    'meeting-log —— 把会议记录（JSONL）翻成能读的句子',
    '',
    '用法',
    '  node scripts/meeting-log.mjs                       # 列出所有会议记录',
    '  node scripts/meeting-log.mjs --code 229415         # 看这一场（句子）',
    '  node scripts/meeting-log.mjs --code 229415 --all   # 连开始/结束/异常一起看',
    '  node scripts/meeting-log.mjs --code 229415 --tail 20',
    '  node scripts/meeting-log.mjs --service             # 服务级事件',
    '  node scripts/meeting-log.mjs --code 229415 --json  # 原样 JSON',
    '',
    '数据在哪：<data-dir>/logs/rooms/<邀请码>-<房间id>.jsonl（--data-dir 缺省 var/live）',
  ].join('\n')
}

/** `2026-11-12T16:12:48.123Z` → 本地 `16:12:48`（带日期时补上日期）。 */
export function clockOf(iso, withDate = false) {
  const stamp = Date.parse(String(iso ?? ''))
  if (!Number.isFinite(stamp)) return '--:--:--'
  const date = new Date(stamp)
  const pad = (value) => String(value).padStart(2, '0')
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  return withDate ? `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}` : clock
}

/** 毫秒数 → `1.5s` / `330ms`（小于 1 秒用毫秒，读起来更准）。 */
export function humanMs(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value < 0) return '?'
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`
  return `${Math.round(value)}ms`
}

/** 语言标签的短写法：`zh-CN` → `zh`。 */
function shortLang(tag) {
  const text = String(tag ?? '').trim()
  return text === '' ? '?' : text.split(/[-_]/)[0]
}

/**
 * 把一条记录排成"人读的行"（句子会返回多行）。
 * 不在这里做筛选，纯排版 —— 筛选交给调用方，逻辑更好测。
 */
export function formatRecord(record, options = {}) {
  const withDate = options.withDate === true
  const at = clockOf(record.t, withDate)
  const kind = String(record.kind ?? '')
  if (kind === 'sentence') {
    const segNo = Number(record.seg ?? 0)
    const parts = []
    if (Number(record.segMs ?? 0) > 0) parts.push(`段${humanMs(record.segMs)}`)
    if (Number(record.queueMs ?? 0) >= 500) parts.push(`排队${humanMs(record.queueMs)}`)
    if (Number(record.asrMs ?? 0) > 0) parts.push(`识${humanMs(record.asrMs)}`)
    const tr = record.trMs !== null && typeof record.trMs === 'object' ? record.trMs : {}
    const trList = Object.values(tr).map(Number).filter((one) => Number.isFinite(one) && one > 0)
    if (trList.length > 0) parts.push(`译${trList.map((one) => (one / 1000).toFixed(2)).join('|')}s`)
    if (Number(record.e2eMs ?? 0) > 0) parts.push(`⇒${humanMs(record.e2eMs)}`)
    const head = `${at}  ${segNo > 0 ? `#${segNo}` : '#?'}  ${parts.join(' ')}`
    const who = String(record.speaker ?? '').trim()
    const lines = [`${head}${who === '' ? '' : `  说：${who}`}`]
    const src = String(record.src ?? '')
    if (src !== '') lines.push(`            原文 ${src}`)
    const dst = record.dst !== null && typeof record.dst === 'object' ? record.dst : {}
    for (const [lang, text] of Object.entries(dst)) {
      lines.push(`            ${shortLang(lang).padEnd(2)}  ${text}`)
    }
    if (src === '' && Object.keys(dst).length === 0) lines.push('            （这句没有内容）')
    const notes = []
    if (Number(record.e2eMs ?? 0) >= 4000) notes.push('⚠️慢')
    if (parts.length === 0) notes.push('（没有耗时信息）')
    if (notes.length > 0) lines[0] += '  ' + notes.join(' ')
    return lines
  }
  if (kind === 'meeting') {
    const what = record.event === 'start' ? '开会' : (record.event === 'end' ? '散会' : `会议/${record.event ?? '?'}`)
    if (record.event === 'start') {
      return [`${at}  ${what}「${record.name ?? '未命名'}」邀请码 ${record.code ?? '?'}`
        + `${record.members === undefined ? '' : `，${record.members} 人`}`
        + `${record.targetLang === '' || record.targetLang === undefined ? '' : `，译 ${shortLang(record.targetLang)}`}`
        + `${record.model === '' || record.model === undefined ? '' : `，模型 ${record.model}`}`]
    }
    return [`${at}  ${what} 邀请码 ${record.code ?? '?'}`
      + `${record.minutes === undefined ? '' : `（${record.minutes} 分钟）`}`
      + `${record.reason === undefined || record.reason === '' ? '' : `，原因 ${record.reason}`}`]
  }
  // warn / error / 其他：一行说完
  const label = kind === 'error' ? '⚠️ 错误' : (kind === 'warn' ? '⚠️ 注意' : kind)
  const bits = []
  for (const key of ['what', 'detail', 'note', 'count', 'ms', 'seg']) {
    if (record[key] === undefined || record[key] === null || record[key] === '') continue
    bits.push(key === 'seg' ? `#${record[key]}` : `${key}=${record[key]}`)
  }
  return [`${at}  ${label}${bits.length === 0 ? '' : '  ' + bits.join('  ')}`]
}

/**
 * 5.181b：这个数据目录里没有会议记录时，去常见位置探一探。
 *
 * <p>为什么需要：数据目录是**启动参数**决定的（生产常是 `/var/lib/leion/test`），
 * 而脚本缺省只会看一个地方。让用户每次都手填 `--data-dir` 不现实 ——
 * 那就自己找一下，并**明说"我看的是哪个目录、记录实际在哪个目录"**。
 */
export function findDataDirWithRecords(preferred) {
  const candidates = [
    preferred,
    process.env.LEION_DATA_DIR ?? '',
    join(VAR_DIR, 'live'),
    join(VAR_DIR, 'test'),
    '/var/lib/leion/test',
    '/var/lib/leion/live',
  ].filter((one) => String(one ?? '').trim() !== '')
  const tried = []
  for (const candidate of candidates) {
    const dir = String(candidate)
    if (tried.includes(dir)) continue
    tried.push(dir)
    if (listMeetingLogs(dir).length > 0) return { dataDir: dir, found: true, tried }
    // 数据目录里的 service-*.jsonl 也算"这台机器上有记录"
    try {
      const names = readdirSync(logsDirOf(dir))
      if (names.some((name) => name.startsWith('service-') && name.endsWith('.jsonl'))) {
        return { dataDir: dir, found: true, tried }
      }
    } catch { /* 目录不存在 */ }
  }
  return { dataDir: preferred, found: false, tried }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  // 没显式给 --data-dir 时自动探路（给了就尊重用户）
  if (options.dataDirExplicit !== true) {
    const found = findDataDirWithRecords(options.dataDir)
    if (found.found === true && found.dataDir !== options.dataDir) {
      process.stdout.write(`（自动选中的数据目录：${found.dataDir}；'
        + '要看别的加 --data-dir <目录>）\n`)
      options.dataDir = found.dataDir
    } else if (found.found === false) {
      process.stdout.write(`（找过这些数据目录，都没有记录：${found.tried.join(' / ')}）\n`)
    }
  }
  if (options.help === true) {
    process.stdout.write(helpText() + '\n')
    return 0
  }

  // ── 服务级事件 ─────────────────────────────────────────────────────────
  if (options.service === true) {
    const dir = logsDirOf(options.dataDir)
    let names = []
    try {
      names = readdirSync(dir).filter((name) => name.startsWith('service-') && name.endsWith('.jsonl')).sort()
    } catch {
      names = []
    }
    if (names.length === 0) {
      process.stdout.write(`没有服务级记录（${dir}/service-*.jsonl）。\n`)
      return 0
    }
    for (const name of names) {
      const events = readMeetingEvents(join(dir, name))
      process.stdout.write(`\n== ${name}（${events.length} 条）==\n`)
      const rows = options.tail > 0 ? events.slice(-options.tail) : events
      for (const one of rows) process.stdout.write(formatRecord(one, { withDate: true }).join('\n') + '\n')
    }
    return 0
  }

  const logs = listMeetingLogs(options.dataDir)

  // ── 没给 --code：列出有哪些会议记录 ──────────────────────────────────────
  if (options.code === '') {
    if (logs.length === 0) {
      process.stdout.write(`没有会议记录（我找的是 ${logsDirOf(options.dataDir)}/rooms/）。\n`
        + '  提示：\n'
        + '    · 数据目录是**启动参数**定的（生产常是 /var/lib/leion/test），用 --data-dir 指过去；\n'
        + '    · 记录是 5.181 之后才开始写的；更早的会只能去 journald 里翻；\n'
        + '    · 确认服务已经跑的是新代码：grep -c logs/rooms ~/glasses/relay/lan-relay.mjs\n')
      return 0
    }
    process.stdout.write(`会议记录（${logs.length} 场，新的在前）：\n`)
    for (const one of logs) {
      const events = readMeetingEvents(one.path)
      const sentences = events.filter((event) => event.kind === 'sentence').length
      const start = events.find((event) => event.kind === 'meeting' && event.event === 'start')
      const end = [...events].reverse().find((event) => event.kind === 'meeting' && event.event === 'end')
      const when = start?.t ?? (events[0]?.t ?? '')
      // 5.184：**别把"没记到结束"说成"还没结束"**。
      //   服务重启/崩溃会把散会那一刻带走，记录里就只剩 start；而管理台（数据库）那边
      //   早就显示结束了 —— 两边不一致的根源就在这句提示上。
      //   现在区分三种：已记结束 / 还在进行（最后一条记录是刚才）/ 未记录结束（很久没动静）。
      const lastAt = lastEventAt(events)
      const idleMs = lastAt > 0 ? Date.now() - lastAt : Number.POSITIVE_INFINITY
      const stillLive = idleMs < 3 * 60 * 1000
      const status = end !== undefined
        ? ''
        : (stillLive
          ? '  ⏳ 进行中（最后一条记录是刚刚）'
          : `  ⚠️ 未记录结束（最后一条记录 ${Math.round(idleMs / 60000)} 分钟前；服务重启或崩溃时没记上）`)
      process.stdout.write(`  ${clockOf(when, true).padEnd(14)}  邀请码 ${(one.code || '?').padEnd(7)}`
        + `  ${sentences} 句  ${(one.bytes / 1024).toFixed(0)} KB`
        + `${start?.name ? `  ${start.name}` : ''}${status}\n`)
    }
    return 0
  }

  // ── 看某一场 ───────────────────────────────────────────────────────────
  const wanted = String(options.code).trim()
  const hit = logs.find((one) => one.code === wanted)
    ?? logs.find((one) => one.name.includes(wanted))
  if (hit === undefined) {
    process.stdout.write(`没找到邀请码 ${wanted} 的记录。用 node scripts/meeting-log.mjs 看有哪些。\n`)
    return 2
  }
  const events = readMeetingEvents(hit.path)
  const selected = events.filter((one) => options.all === true ? true : one.kind === 'sentence')
  const rows = options.tail > 0 ? selected.slice(-options.tail) : selected
  if (options.json === true) {
    for (const one of rows) process.stdout.write(JSON.stringify(one) + '\n')
    return 0
  }
  const start = events.find((one) => one.kind === 'meeting' && one.event === 'start')
  process.stdout.write(`\n${start?.name ? `${start.name} ` : ''}邀请码 ${hit.code}  ${hit.roomId}`
    + `  （${selected.length} 句${options.tail > 0 ? `，显示最后 ${rows.length} 句` : ''}）\n`)
  process.stdout.write('─'.repeat(72) + '\n')
  for (const one of rows) process.stdout.write(formatRecord(one).join('\n') + '\n')
  if (existsSync(hit.path) !== true) process.stdout.write('（文件在读取过程中消失了）\n')
  return 0
}

if (process.argv[1] !== undefined && SCRIPT_PATH === resolve(process.argv[1])) {
  main().then((code) => { process.exitCode = code }).catch((error) => {
    process.stderr.write(`meeting-log：${error && error.message ? error.message : error}\n`)
    process.exitCode = 1
  })
}
