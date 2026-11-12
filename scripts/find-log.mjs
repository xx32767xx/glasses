#!/usr/bin/env node
/**
 * find-log.mjs —— 翻日志：给一个"会"或"一句话"，把它的来龙去脉捞出来（5.180）
 * ============================================================================
 *
 * 为什么要有它：日志有三份（systemd 的 /var/log/glasses.log、每进程一份的
 * var/logs/*.log 及其 archive/、外加会议数据 asr-inbox-*.jsonl 与帧文件），而
 * **同一场会在日志里有三个名字**：
 *
 *     邀请码   229415                                    ← 手机上看到的
 *     房间 id  room-mwd9acyp-0u2x                          ← 数据库/磁盘目录名
 *     短 id    wd9acyp-0u2x                                ← 进程标签 [大脑·…] 里那个
 *
 * 还有第四种键：句子编号 `229415#33`（5.177 起每句都有，原文行/摘要行/收件箱/帧里都带）。
 * 人记不住这些，但脚本可以先扫一遍日志把它们**绑起来**，于是下面四种写法都认：
 *
 *     node scripts/find-log.mjs --trace 229415
 *     node scripts/find-log.mjs --trace room-mwd9acyp-0u2x
 *     node scripts/find-log.mjs --trace wd9acyp-0u2x
 *     node scripts/find-log.mjs --trace 229415#33
 *
 * 用法
 *   列日志源：   --list-files
 *   搜关键词：   --grep 幻听 [--room 229415] [--since 16:00] [--until 16:30] [--limit 200]
 *   追一句话：   --trace 229415#33 [--json]
 *   追一场会：   --trace 229415
 *   统计延迟：   --stats [--room 229415]
 *
 * 选项
 *   --log <path>        主日志（缺省：/var/log/glasses.log 存在就用它，否则跳过）
 *   --logs-dir <path>   每进程日志目录（缺省 var/logs，含 archive/）
 *   --data-dir <path>   数据目录（缺省 var/live）：读 asr-inbox-*.jsonl / buses/ / leion.db
 *   --no-data           只看日志，不碰数据目录
 *   --journal <unit>    额外/替代地从 journald 读（systemctl 机器上才有；读不到会说明原因）
 *   --date <YYYY-MM-DD> 日志行只有 HH:MM:SS 时用哪一天（缺省今天）
 *   --json              机器可读输出
 *
 * ⚠️ 只读：这个脚本不写、不删、不改任何东西。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT, VAR_DIR } from '../lib/paths.mjs'

const SCRIPT_PATH = fileURLToPath(import.meta.url)

// ── 参数 ────────────────────────────────────────────────────────────────────

export function parseArgs(argv = []) {
  const options = {
    mode: '',
    key: '',
    pattern: '',
    room: '',
    since: '',
    until: '',
    limit: 200,
    logPath: '',
    logsDir: join(VAR_DIR, 'logs'),
    // 5.181b：认 LEION_DATA_DIR（服务器上生产数据常在 /var/lib/leion/test）
    dataDir: process.env.LEION_DATA_DIR && String(process.env.LEION_DATA_DIR).trim() !== ''
      ? String(process.env.LEION_DATA_DIR).trim()
      : join(VAR_DIR, 'live'),
    journal: '',
    date: '',
    useData: true,
    json: false,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--help' || token === '-h') { options.help = true; continue }
    if (token === '--json') { options.json = true; continue }
    if (token === '--no-data') { options.useData = false; continue }
    if (token === '--list-files') { options.mode = 'files'; continue }
    if (token === '--stats') { options.mode = 'stats'; continue }
    if (token === '--trace') { options.mode = 'trace'; options.key = String(argv[index += 1] ?? ''); continue }
    if (token === '--grep') { options.mode = 'grep'; options.pattern = String(argv[index += 1] ?? ''); continue }
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) throw new Error(`${token} 需要一个值`)
      index += 1
      return next
    }
    if (token === '--room') options.room = value()
    else if (token === '--since') options.since = value()
    else if (token === '--until') options.until = value()
    else if (token === '--limit') options.limit = Number(value())
    else if (token === '--log') options.logPath = value()
    else if (token === '--logs-dir') options.logsDir = value()
    else if (token === '--data-dir') options.dataDir = value()
    else if (token === '--journal') options.journal = value()
    else if (token === '--date') options.date = value()
    else throw new Error(`不认识的参数：${token}（用 --help 看用法）`)
  }
  if (options.mode === '' && options.help !== true) throw new Error('要做什么？给一个：--list-files / --grep <词> / --trace <id> / --stats')
  if (options.mode === 'trace' && options.key === '') throw new Error('--trace 需要一个 id（邀请码 / 房间 id / 短 id / 句号）')
  if (options.mode === 'grep' && options.pattern === '') throw new Error('--grep 需要一个关键词或正则')
  if (!Number.isFinite(options.limit) || options.limit <= 0) throw new Error('--limit 必须是正整数')
  return options
}

export function helpText() {
  return [
    'find-log —— 翻日志：给一个"会"或"一句话"，把它的来龙去脉捞出来',
    '',
    '用法',
    '  node scripts/find-log.mjs --list-files',
    '  node scripts/find-log.mjs --grep 幻听 [--room 229415] [--since 16:00] [--until 16:30]',
    '  node scripts/find-log.mjs --trace 229415#33        # 追一句话',
    '  node scripts/find-log.mjs --trace 229415           # 追一场会',
    '  node scripts/find-log.mjs --stats [--room 229415]  # 延迟分布',
    '',
    '四种键都认：邀请码 229415 / 房间 id room-mwd9acyp-0u2x / 短 id wd9acyp-0u2x / 句号 229415#33',
    '',
    '选项',
    '  --log <path>       主日志（缺省 /var/log/glasses.log）',
    '  --logs-dir <path>  每进程日志目录（缺省 var/logs，含 archive/）',
    '  --data-dir <path>  数据目录（读 asr-inbox-*.jsonl / 帧 / leion.db），--no-data 关掉',
    '  --journal <unit>   从 journald 读（如 glasses）',
    '  --date <YYYY-MM-DD> 日志行只有 HH:MM:SS 时按哪一天算（缺省今天）',
    '  --json             机器可读',
  ].join('\n')
}

// ── 一行的解析：认两种前缀 ────────────────────────────────────────────────────
//
// ① systemd append（/var/log/glasses.log）：`Nov 12 16:12:46 host leion[197]: [转发] [16:12:46] …`
// ② 每进程文件（var/logs/*.log，可能带 start-multi 写的 `# <ISO> …` 头）：
//    `[16:12:46] …`（relay）或 `[原文] …` / `[切句] …`（python，无时间）

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 }

/** 从行里抠出时间（毫秒）；抠不到返回 null。baseDate 用来补"没有年份"的那种。 */
export function lineTime(raw, baseDate = new Date()) {
  const syslog = /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})/.exec(raw)
  if (syslog !== null && MONTHS[syslog[1]] !== undefined) {
    const stamp = new Date(baseDate.getFullYear(), MONTHS[syslog[1]], Number(syslog[2]),
      Number(syslog[3]), Number(syslog[4]), Number(syslog[5]))
    // 跨年：日志里 12 月、而 baseDate 在 1 月 → 那其实是去年
    if (stamp.getTime() - baseDate.getTime() > 30 * 24 * 3600 * 1000) {
      stamp.setFullYear(stamp.getFullYear() - 1)
    }
    return stamp.getTime()
  }
  const bracket = /\[(\d{2}):(\d{2}):(\d{2})\]/.exec(raw)
  if (bracket !== null) {
    const stamp = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(),
      Number(bracket[1]), Number(bracket[2]), Number(bracket[3]))
    return stamp.getTime()
  }
  return null
}

const SEG_ID = /\b(\d{6})#(\d+)\b/g
const ROOM_ID = /\b(room-[a-z0-9]{4,12}-[a-z0-9]{3,6})\b/g
const SHORT_ID = /\[(?:切句|大脑)·([a-z0-9]{4,12}-[a-z0-9]{3,6})\]/g
const CODE_LINE = /房间\s+(room-[a-z0-9-]+)\s*「([^」]*)」[^\n]*?邀请码\s+(\d{6})/

/** 这一行里出现了哪些键（句号 / 邀请码 / 房间 id / 短 id）。 */
export function lineKeys(raw) {
  const segIds = []
  const codes = []
  const roomIds = []
  const shortIds = []
  for (const hit of raw.matchAll(SEG_ID)) {
    segIds.push(`${hit[1]}#${hit[2]}`)
    codes.push(hit[1])
  }
  for (const hit of raw.matchAll(ROOM_ID)) roomIds.push(hit[1])
  for (const hit of raw.matchAll(SHORT_ID)) shortIds.push(hit[1])
  return { segIds, codes: [...new Set(codes)], roomIds: [...new Set(roomIds)], shortIds: [...new Set(shortIds)] }
}

/** 这行是不是"开会"那一行（把它里面的 邀请码 ↔ 房间 id ↔ 会议名 绑起来）。 */
export function mappingOf(raw) {
  const hit = CODE_LINE.exec(raw)
  if (hit === null) return null
  return { roomId: hit[1], name: hit[2], code: hit[3] }
}

export function shortOf(roomId) {
  return String(roomId ?? '').replace(/^room-/, '').slice(-12)
}

// ── 日志源 ──────────────────────────────────────────────────────────────────

/**
 * 找出所有能读的日志文本文件。
 *
 * 为什么要把 archive 也列进来：`start-multi` 每次启动都会把 `var/logs/<key>.log`
 * **截断重写**，退出时把那一份搬进 `var/logs/archive/<时间戳>/`。所以"上一次运行"
 * 只活在 archive 里 —— 不扫它，用户会觉得"日志没了"。
 */
export function collectSources(options) {
  const sources = []
  const add = (path, kind) => {
    try {
      const info = statSync(path)
      if (info.isFile() && info.size > 0) sources.push({ path, kind, bytes: info.size, mtimeMs: info.mtimeMs })
    } catch { /* 不存在就算了 */ }
  }
  const wantedLog = options.logPath !== '' ? options.logPath : '/var/log/glasses.log'
  add(wantedLog, 'systemd')
  const logsDir = options.logsDir
  try {
    for (const name of readdirSync(logsDir)) {
      if (name.endsWith('.log')) add(join(logsDir, name), 'process')
    }
  } catch { /* 目录不存在 */ }
  const archive = join(logsDir, 'archive')
  try {
    for (const stamp of readdirSync(archive).sort()) {
      const dir = join(archive, stamp)
      try {
        if (statSync(dir).isDirectory() !== true) continue
      } catch { continue }
      for (const name of readdirSync(dir)) {
        if (name.endsWith('.log')) add(join(dir, name), 'archive')
      }
    }
  } catch { /* 没有归档 */ }
  return sources
}

/** 逐行读一个文件（流式；坏字节用替换符，不炸）。 */
export function* readLines(path) {
  let text = ''
  try {
    text = readFileSync(path, 'latin1')          // 先按字节安全读，再手工解码
  } catch {
    return
  }
  let decoded = ''
  try {
    decoded = Buffer.from(text, 'latin1').toString('utf8')
  } catch {
    decoded = text
  }
  for (const raw of decoded.split(/\r?\n/)) {
    if (raw !== '') yield raw
  }
}

// ── id 映射（脚本的核心）──────────────────────────────────────────────────────

/**
 * 扫一遍日志，把 `<邀请码> ↔ <房间 id> ↔ <短 id> ↔ <会议名>` 绑起来。
 *
 * 数据来源：
 *   · `▶ 房间 room-xxx「名字」邀请码 123456`（start-multi 开会时打的那行）→ 三者齐；
 *   · `[切句·短id]` / `[大脑·短id]` → 短 id（再由短 id 反推注册过的房间 id）；
 *   · `123456#33` → 邀请码（句号里带）；
 *   · 房间 id 本身。
 *
 * 有了它，用户给任何一个键都能定位到同一场会（人记不住三个 id）。
 */
export function buildMapping(sources, options = {}) {
  const byCode = new Map()
  const byRoom = new Map()
  const baseDate = options.baseDate ?? new Date()
  const link = (entry) => {
    if (entry.code !== '') {
      byCode.set(entry.code, { ...(byCode.get(entry.code) ?? {}), ...entry })
    }
    if (entry.roomId !== '') {
      byRoom.set(entry.roomId, { ...(byRoom.get(entry.roomId) ?? {}), ...entry })
    }
  }
  for (const source of sources) {
    for (const raw of readLines(source.path)) {
      const mapped = mappingOf(raw)
      if (mapped !== null) {
        link({
          code: mapped.code,
          roomId: mapped.roomId,
          shortId: shortOf(mapped.roomId),
          name: mapped.name,
          at: lineTime(raw, baseDate),
        })
        continue
      }
      // 句号里的邀请码（散在摘要行/原文行里）—— 补 code，但不编房间 id
      const keys = lineKeys(raw)
      for (const code of keys.codes) {
        if (byCode.has(code) !== true) link({ code, roomId: '', shortId: '', name: '', at: lineTime(raw, baseDate) })
      }
      // `[切句·短id]` / `[大脑·短id]`：按"短 id 是房间 id 去掉 room- 后的尾巴"反查
      for (const shortId of keys.shortIds) {
        let found = null
        for (const [roomId, entry] of byRoom) {
          if (shortOf(roomId) === shortId) { found = entry; break }
        }
        if (found === null) {
          // 还没见过开会那行：先按 "room-" + 短 id 记一个候选（启动顺序可能颠倒）
          link({ code: '', roomId: '', shortId, name: '', at: lineTime(raw, baseDate) })
        }
      }
    }
  }
  return { byCode, byRoom }
}

/** 把用户给的任意键解析成一场会（能解析出几个就填几个）。 */
export function resolveKey(key, mapping) {
  const text = String(key ?? '').trim()
  if (text === '') return null
  const seg = /^(\d{6})#(\d+)$/.exec(text)
  if (seg !== null) {
    const hit = mapping.byCode.get(seg[1]) ?? {}
    return { code: seg[1], segNo: Number(seg[2]), segId: text, roomId: hit.roomId ?? '', name: hit.name ?? '', shortId: hit.shortId ?? '' }
  }
  if (mapping.byRoom.has(text)) {
    const hit = mapping.byRoom.get(text)
    return { code: hit.code ?? '', segNo: 0, segId: '', roomId: text, name: hit.name ?? '', shortId: shortOf(text) }
  }
  if (mapping.byCode.has(text)) {
    const hit = mapping.byCode.get(text)
    return { code: text, segNo: 0, segId: '', roomId: hit.roomId ?? '', name: hit.name ?? '', shortId: hit.shortId ?? '' }
  }
  // 短 id / 房间 id 的其他写法
  for (const [roomId, hit] of mapping.byRoom) {
    if (shortOf(roomId) === text) {
      return { code: hit.code ?? '', segNo: 0, segId: '', roomId, name: hit.name ?? '', shortId: shortOf(roomId) }
    }
  }
  if (/^room-[a-z0-9-]+$/.test(text)) {
    return { code: '', segNo: 0, segId: '', roomId: text, name: '', shortId: shortOf(text) }
  }
  return null
}

/** 这一行是不是属于解析出来的那场会/那句话。 */
export function lineMatches(line, target, options = {}) {
  const raw = line.text
  if (target === null) return false
  if (target.segId !== '') {
    if (raw.includes(target.segId)) return true
    // 句子行之外的"同一场会"行不参与单句追踪（否则会把整场都捞出来）
    return false
  }
  if (target.roomId !== '' && raw.includes(target.roomId)) return true
  if (target.shortId !== '' && raw.includes(target.shortId)) return true
  if (target.code !== '') {
    // 邀请码出现在句号里（`229415#33`）或开会那行
    if (raw.includes(`${target.code}#`)) return true
    if (raw.includes(`邀请码 ${target.code}`)) return true
  }
  void options
  return false
}

// ── 时间窗 ──────────────────────────────────────────────────────────────────

/** `16:00` / `16:00:30` / `2026-11-12 16:00` 都认；解析不出返回 null。 */
export function parseClock(text, baseDate = new Date()) {
  const value = String(text ?? '').trim()
  if (value === '') return null
  const full = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value)
  if (full !== null) {
    return new Date(Number(full[1]), Number(full[2]) - 1, Number(full[3]),
      Number(full[4]), Number(full[5]), Number(full[6] ?? 0)).getTime()
  }
  const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value)
  if (clock !== null) {
    return new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(),
      Number(clock[1]), Number(clock[2]), Number(clock[3] ?? 0)).getTime()
  }
  return null
}

// ── 结构化数据（会议数据，不是日志）───────────────────────────────────────────

/** 收件箱里这道句子的那一行（含段长/排队/识别/等静音/策略/模型）。 */
export function inboxRecord(dataDir, roomId, segId) {
  if (roomId === '') return null
  const file = join(dataDir, `asr-inbox-${roomId}.jsonl`)
  if (existsSync(file) !== true) return null
  try {
    for (const raw of readLines(file)) {
      let row = null
      try { row = JSON.parse(raw) } catch { continue }
      if (row === null || typeof row !== 'object') continue
      if (String(row.segId ?? '') !== segId) continue
      return row
    }
  } catch { /* 读不到就算了 */ }
  return null
}

/** 帧日志里那句话的帧（relay 读走就删，所以经常没有；有就带上 cost）。 */
export function frameRecords(dataDir, roomId, segId) {
  if (roomId === '') return []
  const dir = join(dataDir, 'buses', `${roomId}.json.frames`)
  if (existsSync(dir) !== true) return []
  const out = []
  try {
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.json') !== true) continue
      try {
        const frame = JSON.parse(readFileSync(join(dir, name), 'utf-8'))
        if (frame !== null && typeof frame === 'object'
          && String(frame.cost?.segId ?? '') === segId) out.push({ name, frame })
      } catch { /* 正在写/写坏了 */ }
    }
  } catch { /* 没有目录 */ }
  return out
}

/** 数据库里那句话（定稿落库的那行；没有 node:sqlite 或库不在就返回 null）。 */
export async function dbRecord(dataDir, roomId, segNo) {
  if (roomId === '' || segNo <= 0) return null
  let DatabaseSync = null
  try {
    ({ DatabaseSync } = await import('node:sqlite'))
  } catch {
    return null
  }
  const file = join(dataDir, 'leion.db')
  if (existsSync(file) !== true) return null
  let db = null
  try {
    db = new DatabaseSync(file, { readOnly: true })
    // 没有 seg 列（5.177 之前的库）：退回"按房间 + 时间"没法精确对，宁可不猜
    const columns = db.prepare('PRAGMA table_info(utterances)').all().map((one) => one.name)
    if (columns.includes('seg') !== true) return null
    return db.prepare('SELECT room_id, username, src_lang, src_text, dst_text, start_at, seg, is_final FROM utterances WHERE room_id = ? AND seg = ?')
      .get(roomId, segNo) ?? null
  } catch {
    return null
  } finally {
    try { db?.close() } catch { /* 关不掉就算了 */ }
  }
}

// ── 三种输出模式 ─────────────────────────────────────────────────────────────

function sourceLabel(source) {
  return source.path.replace(ROOT + '\\', '').replace(ROOT + '/', '')
}

function stampOf(ms) {
  if (!Number.isFinite(ms)) return '--:--:--'
  const date = new Date(ms)
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 把原始行洗成"人看的正文"。
 *
 * <p>做两件事：① 剥掉 systemd 的头（`Nov 12 16:12:46 host leion[196085]: `）；
 * ② 剥掉正文自己带的 `[16:12:46]` —— 外面已经打了我们统一的时间，留着就是一行两个时间。
 */
export function cleanLine(raw) {
  let text = String(raw ?? '')
  // ⚠️ 进程那一段是 `leion[196085]:`，里面没有第二个冒号；用 [^:\s]+ 卡住，别把名字吃掉一半
  const syslog = /^[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\S+\s+[^:\s]+:\s*/.exec(text)
  if (syslog !== null) text = text.slice(syslog[0].length)
  // 正文里的时间戳统一剥掉（只剥**第一处**）：
  //   · 文件来源行长这样：`[16:12:47] 📥 音频 …`（这是唯一的时间）；
  //   · systemd 行剥完头之后长这样：`[转发] [16:12:48] 229415#33 …`（第二个才是时间）。
  // 我们输出时会统一在最前面打时间，留着就是一行两个时间。
  text = text.replace(/\[\d{2}:\d{2}:\d{2}\]\s*/, '')
  return text.trimEnd()
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help === true) {
    process.stdout.write(helpText() + '\n')
    return 0
  }
  const baseDate = options.date !== '' ? new Date(`${options.date}T00:00:00`) : new Date()
  if (Number.isNaN(baseDate.getTime())) throw new Error(`--date 认不出：${options.date}`)
  const sources = collectSources(options)

  if (options.mode === 'files') {
    if (options.json === true) {
      process.stdout.write(JSON.stringify(sources.map((one) => ({
        path: one.path, kind: one.kind, bytes: one.bytes, mtimeMs: one.mtimeMs,
      })), null, 2) + '\n')
      return 0
    }
    if (sources.length === 0) {
      process.stdout.write('没找到任何日志文件。\n'
        + `  试过：${options.logPath !== '' ? options.logPath : '/var/log/glasses.log'}\n`
        + `        ${options.logsDir}/*.log、${options.logsDir}/archive/*/*.log\n`
        + '  （服务器上的 systemd 单元可能把输出写到了别处，用 --log <path> 指定）\n')
      return 0
    }
    process.stdout.write(`日志源（${sources.length} 个）：\n`)
    for (const one of sources) {
      const header = (() => {
        try {
          for (const raw of readLines(one.path)) {
            if (raw.startsWith('#')) return raw.trim()
            break
          }
        } catch { /* 忽略 */ }
        return ''
      })()
      const size = one.bytes >= 1024
        ? `${(one.bytes / 1024).toFixed(0).padStart(6)} KB`
        : `${String(one.bytes).padStart(6)} B `
      process.stdout.write(`  ${size}  ${sourceLabel(one)}`
        + `  [${one.kind}]${header === '' ? '' : `  ${header}`}\n`)
    }
    return 0
  }

  const mapping = buildMapping(sources, { baseDate })
  const sinceMs = parseClock(options.since, baseDate)
  const untilMs = parseClock(options.until, baseDate)

  if (options.mode === 'trace') {
    const target = resolveKey(options.key, mapping)
    if (target === null) {
      process.stdout.write(`认不出这个 key：${options.key}\n`
        + '  四种写法都行：229415 / room-mwd9acyp-0u2x / wd9acyp-0u2x / 229415#33\n')
      return 2
    }
    const hits = []
    for (const source of sources) {
      for (const raw of readLines(source.path)) {
        const text = cleanLine(raw)
        if (lineMatches({ text }, target) !== true) continue
        const at = lineTime(raw, baseDate)
        if (sinceMs !== null && at !== null && at < sinceMs) continue
        if (untilMs !== null && at !== null && at > untilMs) continue
        hits.push({ at, text, source: sourceLabel(source) })
      }
    }
    hits.sort((left, right) => (left.at ?? 0) - (right.at ?? 0))
    const inbox = target.segId === '' ? null : inboxRecord(options.dataDir, target.roomId, target.segId)
    const frames = target.segId === '' ? [] : frameRecords(options.dataDir, target.roomId, target.segId)
    const dbRow = target.segId === '' ? null
      : await dbRecord(options.dataDir, target.roomId, target.segNo)

    if (options.json === true) {
      process.stdout.write(JSON.stringify({ target, mapping: {
        code: target.code, roomId: target.roomId, shortId: target.shortId, name: target.name,
      }, lines: hits, inbox, frames: frames.map((one) => one.frame), db: dbRow }, null, 2) + '\n')
      return 0
    }
    const who = target.code === '' ? '' : ` ${target.code}`
    process.stdout.write(`\n${target.name === '' ? '（没有会议名）' : target.name}${who}`
      + `${target.roomId === '' ? '' : `  ${target.roomId}`}`
      + `${target.segId === '' ? '' : `  ${target.segId}`}\n`)
    process.stdout.write(`${'─'.repeat(72)}\n`)
    if (hits.length === 0) {
      process.stdout.write('日志里没有匹配的行。（也许这次运行的日志已被清理或换机器了；'
        + '试 `--list-files` 看有哪些日志源）\n')
    }
    for (const one of hits.slice(0, options.limit)) {
      process.stdout.write(`${stampOf(one.at)} ${one.text}\n`)
    }
    if (hits.length > options.limit) {
      process.stdout.write(`…（还有 ${hits.length - options.limit} 行，加 --limit 看更多）\n`)
    }
    if (inbox !== null) {
      process.stdout.write(`\n会议数据（${`asr-inbox-${target.roomId}.jsonl`}）：\n`)
      process.stdout.write(`  段 ${Number(inbox.segMs ?? 0) / 1000} 秒，排队 ${inbox.queueMs ?? '?'} ms，`
        + `识别 ${inbox.asrMs ?? '?'} ms，等静音 ${inbox.silenceMs ?? '?'} ms\n`)
      process.stdout.write(`  语种 ${inbox.from ?? '?'}，说话人 ${inbox.speakerName ?? '?'}，`
        + `策略 ${inbox.strategy ?? '?'} / 模型 ${inbox.model ?? '?'}\n`)
      process.stdout.write(`  原文：${inbox.text ?? ''}\n`)
    }
    if (frames.length > 0) {
      process.stdout.write(`\n帧（${frames.length} 条，含翻译耗时）：\n`)
      for (const one of frames) {
        const cost = one.frame.cost ?? {}
        const tr = cost.trMs ?? {}
        process.stdout.write(`  ${one.name}  ${one.frame.lang ?? '?'}  `
          + `译 ${Object.entries(tr).map(([lang, ms]) => `${lang} ${ms}ms`).join(' / ')}\n`)
        process.stdout.write(`    ${String(one.frame.text ?? '').slice(0, 160)}\n`)
      }
    }
    if (dbRow !== null) {
      process.stdout.write(`\n数据库（utterances）：${new Date(Number(dbRow.start_at)).toISOString()} `
        + `${dbRow.username ?? ''} ${dbRow.src_lang ?? ''}\n  ${dbRow.src_text ?? ''}\n  ${dbRow.dst_text ?? ''}\n`)
    }
    return 0
  }

  // ── grep / stats 共用：把符合条件的事件流读一遍 ────────────────────────────
  let pattern = null
  if (options.mode === 'grep') {
    try {
      pattern = new RegExp(options.pattern, 'i')
    } catch {
      pattern = new RegExp(options.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    }
  }
  const target = options.room === '' ? null : resolveKey(options.room, mapping)
  const rows = []
  for (const source of sources) {
    for (const raw of readLines(source.path)) {
      const at = lineTime(raw, baseDate)
      if (sinceMs !== null && at !== null && at < sinceMs) continue
      if (untilMs !== null && at !== null && at > untilMs) continue
      const text = cleanLine(raw)
      if (target !== null && lineMatches({ text }, target) !== true) continue
      if (pattern !== null && pattern.test(text) !== true) continue
      rows.push({ at, text, source: sourceLabel(source) })
    }
  }
  rows.sort((left, right) => (left.at ?? 0) - (right.at ?? 0))

  if (options.mode === 'grep') {
    if (options.json === true) {
      process.stdout.write(JSON.stringify(rows.slice(0, options.limit), null, 2) + '\n')
      return 0
    }
    process.stdout.write(`匹配 ${rows.length} 行`
      + `${target === null ? '' : `（只看 ${options.room}）`}`
      + `${rows.length > options.limit ? `，显示前 ${options.limit} 行` : ''}\n`)
    for (const one of rows.slice(0, options.limit)) {
      process.stdout.write(`${stampOf(one.at)} ${one.text}\n`)
    }
    return 0
  }

  // stats：只用摘要行（`<句号> <人>/<方向> │ 段… │ ⇒N.Ns │ …`）
  const sentences = []
  for (const one of rows) {
    const hit = /(\d{6})#(\d+)\s+\S+ │ ([^│]*)│ ⇒([\d.]+)s │ (.*)$/.exec(one.text)
    if (hit === null) continue
    const parts = hit[3]
    const segMs = Number((/段([\d.]+)s/.exec(parts) ?? [])[1] ?? NaN)
    const asrMs = Number((/识([\d.]+)s/.exec(parts) ?? [])[1] ?? NaN)
    const trMs = (parts.match(/译([\d.|]+)s/) ?? [])[1] ?? ''
    const queueMs = Number((/排队([\d.]+)s/.exec(parts) ?? [])[1] ?? NaN)
    const trSlowest = trMs === '' ? NaN : Math.max(...trMs.split('|').map((v) => Number(v)))
    sentences.push({
      segId: `${hit[1]}#${hit[2]}`,
      code: hit[1],
      endToEnd: Number(hit[4]),
      segMs: segMs * 1000,
      asrMs: asrMs * 1000,
      queueMs: Number.isFinite(queueMs) ? queueMs * 1000 : 0,
      trMs: Number.isFinite(trSlowest) ? trSlowest * 1000 : 0,
      body: hit[5].trim(),
      at: one.at,
      text: one.text,
    })
  }
  const percentile = (values, ratio) => {
    if (values.length === 0) return 0
    const sorted = [...values].sort((left, right) => left - right)
    const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)))
    return sorted[index]
  }
  const drops = rows.filter((one) => /丢掉一段碎片|丢弃 \d+ 段/.test(one.text))
  const failures = rows.filter((one) => /翻译失败|✗|失败/.test(one.text))
  const emptySpeech = sentences.filter((one) => one.body.includes('无译文'))
  const result = {
    sentences: sentences.length,
    endToEndMs: {
      median: percentile(sentences.map((one) => one.endToEnd), 0.5) * 1000,
      p90: percentile(sentences.map((one) => one.endToEnd), 0.9) * 1000,
      max: Math.max(0, ...sentences.map((one) => one.endToEnd)) * 1000,
    },
    slowest: [...sentences].sort((left, right) => right.endToEnd - left.endToEnd).slice(0, 5),
    droppedFragments: drops.length,
    failures: failures.length,
    noTranslation: emptySpeech.length,
  }
  if (options.json === true) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    return 0
  }
  process.stdout.write(`\n统计${target === null ? '' : `（只看 ${options.room}）`}：\n`)
  process.stdout.write(`  句子 ${result.sentences} 句\n`)
  process.stdout.write(`  说完→手机：中位 ${(result.endToEndMs.median / 1000).toFixed(1)}s`
    + `，p90 ${(result.endToEndMs.p90 / 1000).toFixed(1)}s`
    + `，最慢 ${(result.endToEndMs.max / 1000).toFixed(1)}s\n`)
  if (result.slowest.length > 0) {
    process.stdout.write('  最慢的几句：\n')
    for (const one of result.slowest) {
      process.stdout.write(`    ${one.segId}  ⇒${one.endToEnd.toFixed(1)}s `
        + `(段 ${(one.segMs / 1000).toFixed(1)}s，识 ${(one.asrMs / 1000).toFixed(2)}s，`
        + `译 ${(one.trMs / 1000).toFixed(2)}s)  ${one.body}\n`)
    }
  }
  process.stdout.write(`  丢弃碎片 ${result.droppedFragments} 次；翻译失败 ${result.failures} 次；`
    + `无译文 ${result.noTranslation} 句\n`)
  return 0
}

if (process.argv[1] !== undefined && SCRIPT_PATH === resolve(process.argv[1])) {
  main().then((code) => { process.exitCode = code }).catch((error) => {
    process.stderr.write(`find-log：${error && error.message ? error.message : error}\n`)
    process.exitCode = 1
  })
}

void dirname
void isAbsolute
