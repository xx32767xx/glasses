#!/usr/bin/env node
/**
 * doctor-db.mjs —— 数据目录体检与抢救（搬迁服务器之后必跑一次）
 * ============================================================================
 *   node scripts/doctor-db.mjs                          # 体检默认的两个数据目录
 *   node scripts/doctor-db.mjs --data-dir /var/lib/leion/live
 *   node scripts/doctor-db.mjs --fix                    # 能修的自己修（先备份）
 *   node scripts/doctor-db.mjs --fix --data-dir /var/lib/leion/test
 *
 * 为什么需要它：**把整个镜像搬到新服务器**这件事上，SQLite 是最容易坏的东西。
 *   · 拷的时候 relay 还在写 → 拷到半页数据（`database disk image is malformed`）；
 *   · 只拷了 `leion.db`、没拷 `leion.db-wal` → 最近的提交丢了（不报错，只是"记录少了"）；
 *   · 拷了 `-wal` 却没拷 `-shm`（或反过来） → SQLite 认为两半对不上，直接判损坏。
 *
 * 它只做四件事：
 *   ① 逐个库报告 `leion.db` / `-wal` / `-shm` 的大小与时间（谁比谁新，一眼看出来）；
 *   ② `PRAGMA quick_check` + `integrity_check`；
 *   ③ 「把 -wal 挪开再查一次」——用来区分"真坏了"和"只是带了份过期的 WAL"；
 *   ④ `--fix`：先备份，再 `VACUUM INTO` 重建一份干净的库并替换。
 *
 * ⚠️ 跑之前**先停 relay**。带着活的 writer 修库，会把"坏"变成"更坏"。
 */

import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { COLUMN_PATCHES, openDb } from '../lib/db.mjs'

const DEFAULT_DATA_DIRS = ['/var/lib/leion/live', '/var/lib/leion/test']

/** 解析参数：只要两个开关 + 一个值，手写比引依赖清楚。 */
export function parseArgs(argv) {
  const out = { fix: false, dataDirs: [], scan: null, scanAll: false, reset: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--fix') out.fix = true
    else if (arg === '--data-dir') {
      const value = argv[i + 1]
      if (value === undefined) throw new Error('--data-dir 需要一个路径')
      out.dataDirs.push(value)
      i += 1
    } else if (arg === '--scan') {
      const value = argv[i + 1]
      if (value === undefined) throw new Error('--scan 需要一个根目录')
      out.scan = value
      i += 1
    } else if (arg === '--scan-all') {
      out.scanAll = true
    } else if (arg === '--reset') {
      out.reset = true
    } else if (arg === '--help' || arg === '-h') out.help = true
    else throw new Error(`看不懂的参数：${arg}`)
  }
  if (out.dataDirs.length === 0) out.dataDirs = DEFAULT_DATA_DIRS
  return out
}

const stamp = (file) => {
  if (!existsSync(file)) return null
  const info = statSync(file)
  return { size: info.size, at: info.mtime }
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`

/** 只读打开并跑检查；打开本身失败也要给结论，不要抛。 */
export function inspectFile(file, { ignoreWal = false } = {}) {
  let target = file
  const tempDir = ignoreWal ? `${file}.nowal-${Date.now()}` : null
  if (ignoreWal) {
    // 复制成一个"没有 -wal/-shm 的副本"，用来验证"只是 WAL 过期"这种情况
    copyFileSync(file, tempDir)
    target = tempDir
  }
  let db = null
  try {
    db = new DatabaseSync(target)
    const quick = db.prepare('PRAGMA quick_check').all().map((row) => Object.values(row)[0])
    const full = db.prepare('PRAGMA integrity_check').all().map((row) => Object.values(row)[0])
    const tables = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get()
    return {
      ok: quick.every((v) => v === 'ok') && full.every((v) => v === 'ok'),
      quick, full, tables: Number(tables?.n ?? 0), error: '',
    }
  } catch (error) {
    return { ok: false, quick: [], full: [], tables: 0, error: String(error?.message ?? error) }
  } finally {
    if (db !== null) {
      try { db.close() } catch { /* 已经坏了，关不掉就算了 */ }
    }
    if (tempDir !== null && existsSync(tempDir)) rmSync(tempDir, { force: true })
  }
}

/** VACUUM INTO 重建：能读出页面就能重写出一份干净的库（比 .recover 温和）。 */
function rebuild(file) {
  const built = `${file}.rebuilt-${Date.now()}`
  let db = null
  try {
    db = new DatabaseSync(file)
    db.exec(`VACUUM INTO '${built.replace(/'/g, "''")}'`)
  } catch (error) {
    rmSync(built, { force: true })
    return { ok: false, error: String(error?.message ?? error), strategy: 'vacuum' }
  } finally {
    if (db !== null) {
      try { db.close() } catch { /* ignore */ }
    }
  }
  if (!existsSync(built)) return { ok: false, error: 'VACUUM INTO 没有产出文件', strategy: 'vacuum' }
  const verify = inspectFile(built)
  if (!verify.ok) {
    rmSync(built, { force: true })
    return { ok: false, error: '重建出来的库自检也没过（页面里已经是坏数据）', strategy: 'vacuum' }
  }
  return { ok: true, built, strategy: 'vacuum' }
}

/**
 * 看文件本身长什么样：SQLite 头、页尺寸、页数。
 *
 * <p>为什么要看：`database disk image is malformed` 有两种完全不同的病——
 * <ul>
 *   <li><b>头都不对</b>（前 16 字节不是 `SQLite format 3`）→ 这不是库，是别的东西，
 *       或者搬迁时被改写过（tar 文本模式、某些同步盘）。</li>
 *   <li><b>头对、页坏了</b> → 数据大部分还在，逐表抢救通常能捞回来七七八八。</li>
 * </ul>
 */
export function diagnoseFile(file) {
  if (!existsSync(file)) return { ok: false, reason: '文件不存在' }
  const size = statSync(file).size
  const head = readFileSync(file).subarray(0, 32)
  const header = head.subarray(0, 16).toString('latin1')
  const magic = header.startsWith('SQLite format 3')
  // 第 16~17 字节是页尺寸（大端）；值 1 表示 65536
  let pageSize = head.length >= 18 ? (head[16] << 8) | head[17] : 0
  if (pageSize === 1) pageSize = 65536
  return {
    ok: magic,
    magic,
    size,
    pageSize,
    pages: magic && pageSize > 0 ? Math.round(size / pageSize) : 0,
    reason: magic ? '' : `前 16 字节不是 SQLite 头（实际是 ${JSON.stringify(header)}）`,
  }
}

/**
 * 逐表抢救：`VACUUM INTO` 走不通时的最后一招。
 *
 * <p>为什么能救：`integrity_check` 失败往往只是某几页坏了，而其它页的行照样读得出来。
 * 这里按表 `SELECT *`，读得出一条算一条，写进一个**结构全新**的库里；
 * 哪张表读不动就跳过并报出来 —— 至少能知道"丢了哪张表"。
 *
 * <p>等价于 sqlite3 的 `.recover`，但不需要 CLI（服务器上不一定装了 sqlite3）。
 */
export function salvageToNewDb(file, target) {
  const created = openFresh(target)
  if (created.ok !== true) return { ok: false, error: created.error }
  const rebuilt = target
  let source = null
  const report = { tables: [], failed: [], rows: 0 }
  try {
    source = new DatabaseSync(file)
    const tables = source.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
    for (const row of tables) {
      const name = String(row.name)
      let rows = []
      try {
        rows = source.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).all()
      } catch (error) {
        report.failed.push({ table: name, error: String(error?.message ?? error) })
        continue
      }
      const inserted = insertRows(target, name, rows)
      report.tables.push({ table: name, rows: inserted.ok ? rows.length : 0, error: inserted.error })
      report.rows += inserted.ok ? rows.length : 0
    }
  } catch (error) {
    // 连 sqlite_master 都读不动：头对但第一页就烂了
    return { ok: false, error: String(error?.message ?? error), built: rebuilt, report }
  } finally {
    if (source !== null) {
      try { source.close() } catch { /* ignore */ }
    }
  }
  // 哪怕有表读不动，只要救回了行就算可用（人至少知道丢了哪张表）
  return { ok: report.failed.length === 0, built: rebuilt, report }
}

/** 建一个空的新库（用项目自己的 openDb，顺带把表结构建全）。 */
function openFresh(target) {
  try {
    openDb(target).close()
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/** 把一批行塞进新库；列名以目标表为准（源行多了/少了都不至于整表失败）。 */
function insertRows(target, table, rows) {
  if (rows.length === 0) return { ok: true }
  const db = new DatabaseSync(target)
  try {
    const cols = db.prepare(`PRAGMA table_info("${table.replace(/"/g, '""')}")`).all().map((c) => c.name)
    if (cols.length === 0) return { ok: false, error: `目标库里没有表 ${table}` }
    const usable = cols.filter((name) => Object.prototype.hasOwnProperty.call(rows[0], name))
    if (usable.length === 0) return { ok: false, error: `${table} 没有可对应的列` }
    const sql = `INSERT OR REPLACE INTO "${table.replace(/"/g, '""')}" (${usable.map((n) => `"${n}"`).join(',')})`
      + ` VALUES (${usable.map(() => '?').join(',')})`
    const statement = db.prepare(sql)
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of rows) statement.run(...usable.map((name) => row[name] ?? null))
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* ignore */ }
      return { ok: false, error: String(error?.message ?? error) }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  } finally {
    db.close()
  }
}

function backup(file) {
  const tag = new Date().toISOString().replace(/[:.]/g, '-')
  const moved = []
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${file}${suffix}`
    if (!existsSync(source)) continue
    const target = `${source}.bak-${tag}`
    copyFileSync(source, target)
    moved.push(target)
  }
  return moved
}

export /**
 * 告诉用户“本机其实有哪些 leion 库”。
 *
 * <p>真实情形：live 目录是空的、test 目录有库 —— 这时候最常见的原因不是“坏了”，
 * 而是 relay 带的 `--data-dir` 跟以为的不一样。把它找出来，比叫人去猜强。
 */
function hintOtherDataDirs() {
  const found = []
  const walk = (dir, depth) => {
    if (depth > 3) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.name === 'leion.db') found.push(full)
    }
  }
  walk('/var/lib/leion', 0)
  if (found.length === 0) return
  console.log(`  · 本机其实有这些 leion 库：${found.join('、')}`)
  console.log('    （如果 relay 带的 --data-dir 跟上面不一样，那就是路径问题，不是库坏了）')
}

export /**
 * 把旧库挪成 `leion.db.old-时间戳`（**不删**，万一还想捞数据），然后建一个全新的空库。
 *
 * <p>⚠️ 只适合**测试环境**：新库是空的 —— 账号、术语库、申请、会议记录全都从零开始。
 * 这也是为什么它必须显式 `--reset`，而不是混在 `--fix` 里。
 */
function resetFresh(dir, file, why) {
  if (existsSync(file)) {
    const tag = new Date().toISOString().replace(/[:.]/g, '-')
    for (const suffix of ['', '-wal', '-shm']) {
      const source = `${file}${suffix}`
      if (!existsSync(source)) continue
      renameSync(source, `${source}.old-${tag}`)
    }
    console.log(`  · 旧库已括到：${file}.old-${tag}`)
  }
  const created = openFresh(file)
  if (created.ok !== true) {
    console.log(`  ✗ 新库建不出来：${created.error}`)
    return { dir, verdict: 'RESET_FAILED' }
  }
  const after = inspectFile(file)
  console.log(`  ✓ 已重建空库（${why}）：表结构 ${after.ok ? '就绪' : '建了但自检没过'}`)
  console.log('    下一步：')
  console.log(`      node scripts/create-account.mjs --data-dir ${dir} --user boss --password '你的密码' --role admin`)
  console.log('      术语库重新导入：node scripts/terms-migrate.mjs（或 terms-admin.mjs 的 import）')
  return { dir, verdict: after.ok ? 'RESET' : 'RESET_FAILED' }
}

/** 对比库里的列与代码期望的列（用的就是 lib/db.mjs 里那张表，不会两处漂）。 */
export function missingColumnsOf(file) {
  const missing = []
  let db = null
  try {
    db = new DatabaseSync(file)
    for (const patch of COLUMN_PATCHES) {
      const table = db.prepare("SELECT 1 AS yes FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(patch.table)
      if (table === undefined) {
        missing.push(`${patch.table}（表都没有）`)
        continue
      }
      const columns = db.prepare(`PRAGMA table_info(${patch.table})`).all().map((column) => column.name)
      if (columns.includes(patch.column) !== true) missing.push(`${patch.table}.${patch.column}`)
    }
  } catch {
    return []
  } finally {
    if (db !== null) {
      try { db.close() } catch { /* ignore */ }
    }
  }
  return missing
}

export function checkOne(dataDir, options) {
  const dir = resolve(dataDir)
  const file = join(dir, 'leion.db')
  console.log('')
  console.log(`━━ ${dir}`)
  if (!existsSync(dir)) {
    console.log('  · 目录不存在（这台机器上没有这个数据目录）')
    hintOtherDataDirs()
    return { dir, verdict: 'MISSING' }
  }
  // 顺手把目录里其它 sqlite 文件也列出来，免得漏看
  const others = readdirSync(dir).filter((name) => name.endsWith('.db') && name !== 'leion.db')
  const parts = ['', '-wal', '-shm'].map((suffix) => {
    const info = stamp(`${file}${suffix}`)
    return { suffix, info }
  })
  for (const { suffix, info } of parts) {
    console.log(info === null
      ? `  · leion.db${suffix}：不存在`
      : `  · leion.db${suffix}：${kb(info.size)}  修改于 ${info.at.toISOString()}`)
  }
  for (const name of others) console.log(`  · 另外还有 ${name}（不归本脚本管）`)

  if (!existsSync(file)) {
    if (options.reset === true) return resetFresh(dir, file, '本来就没有库')
    console.log('  → 结论：没有主库文件。要么还没跑过 relay，要么路径不对')
    hintOtherDataDirs()
    return { dir, verdict: 'NO_DB' }
  }

  const result = inspectFile(file)
  const missingColumns = missingColumnsOf(file)
  if (result.ok) {
    console.log(`  → 结论：健康（${result.tables} 张表，quick_check 与 integrity_check 都过）`)
    if (missingColumns.length > 0) {
      console.log(`  ⚠️ 结构过旧：缺少 ${missingColumns.join('、')} —— 重启一次 relay 就会自动补上`)
      console.log('     （不补的话，用到那个列的功能会报 no such column）')
      return { dir, verdict: 'SCHEMA_STALE' }
    }
    const wal = stamp(`${file}-wal`)
    if (wal !== null && wal.size > 0) {
      console.log('  ⚠️ -wal 非空：说明最后一次是"没干净关闭"（进程被杀或还在跑）。')
      console.log('     正常关闭时会在退出前 checkpoint 掉；此刻别直接拷这个库，先停 relay。')
    }
    return { dir, verdict: 'OK' }
  }

  // --reset：不试图挽救，直接把旧库改名留档、建一个新的空库。
  // 适用场景：**测试环境**里数据本来就可重建（账号重注册、术语库重新导入）。
  if (options.reset === true) return resetFresh(dir, file, '按要求重建')

  const diag = diagnoseFile(file)
  console.log(`  · 文件：${kb(diag.size)}${diag.magic
    ? `，SQLite 头正常，页尺寸 ${diag.pageSize}×${diag.pages} 页`
    : `，**不是 SQLite 文件**${diag.reason ? `：${diag.reason}` : ''}`}`)
  console.log(`  ✗ 自检没过：${result.error || result.quick.join('; ') || result.full.join('; ')}`)
  const withoutWal = stamp(`${file}-wal`) === null ? null : inspectFile(file, { ignoreWal: true })
  if (withoutWal !== null && withoutWal.ok) {
    console.log('  → 结论：**只是带了过期的 -wal**（把 WAL 挪开就正常，数据本体没坏）')
    if (options.fix !== true) {
      console.log('     修法：node scripts/doctor-db.mjs --fix（会先备份 -wal 再挪开）')
      return { dir, verdict: 'STALE_WAL' }
    }
    const backups = backup(file)
    for (const suffix of ['-wal', '-shm']) {
      const source = `${file}${suffix}`
      if (existsSync(source)) renameSync(source, `${source}.stale-${Date.now()}`)
    }
    const after = inspectFile(file)
    console.log(`     已备份 ${backups.length} 个文件，挪开 WAL 后再查：${after.ok ? '健康 ✓' : '仍不健康 ✗'}`)
    console.log('     注意：挪开 WAL 会丢掉"还没来得及 checkpoint 的最后几条提交"。')
    return { dir, verdict: after.ok ? 'FIXED_STALE_WAL' : 'CORRUPT' }
  }

  console.log('  → 结论：**库本体已经坏了**（不是 WAL 的锅）')
  if (options.fix !== true) {
    console.log('     修法一：node scripts/doctor-db.mjs --fix（VACUUM INTO 重建，能救多少救多少）')
    console.log('     修法二：从旧机器重拷（**先停 relay**）：')
    console.log(`       ssh 旧机器 'systemctl stop leion || pm2 stop all'`)
    console.log(`       ssh 旧机器 'sqlite3 ${file} ".backup /tmp/leion.db"'`)
    console.log('       scp 旧机器:/tmp/leion.db 这台机器:' + file)
    return { dir, verdict: 'CORRUPT' }
  }
  const backups = backup(file)
  console.log(`     已备份 ${backups.length} 个文件`)
  const rebuilt = rebuild(file)
  let built = rebuilt.ok ? rebuilt.built : null
  if (built === null) {
    console.log(`     VACUUM INTO 失败（${rebuilt.error}），改逐表抢救…`)
    const salvaged = salvageToNewDb(file, `${file}.salvaged-${Date.now()}`)
    if (salvaged.ok === true || (salvaged.report !== undefined && salvaged.report.rows > 0)) {
      const report = salvaged.report ?? { tables: [], failed: [], rows: 0 }
      console.log(`     抢救到 ${report.rows} 行：${report.tables.map((one) =>
        `${one.table}=${one.rows}`).join(' ') || '(没有表)'}`)
      if (report.failed.length > 0) {
        console.log(`     读不动的表：${report.failed.map((one) => one.table).join(', ')}`)
      }
      built = salvaged.built ?? null
    } else {
      const failed = salvaged.report?.failed ?? []
      console.log(`     逐表抢救也不行：${salvaged.error ?? '数据已不可读'}`)
      if (failed.length > 0) {
        console.log(`     读不动的表：${failed.map((one) => `${one.table}（${one.error}）`).join('；')}`)
      }
    }
  }
  if (built === null) {
    console.log('     最后手段（sqlite3 CLI 的 .recover，能捞出坏页里的行）：')
    console.log(`       sqlite3 ${file} ".recover" | sqlite3 ${file}.recovered`)
    console.log(`       mv ${file}.recovered ${file}`)
    return { dir, verdict: 'UNRECOVERABLE' }
  }
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${file}${suffix}`
    if (existsSync(source)) renameSync(source, `${source}.broken-${Date.now()}`)
  }
  renameSync(built, file)
  console.log('     ✓ 已用 VACUUM INTO 重建并替换（坏文件留在 *.broken-* 里，别急着删）')
  return { dir, verdict: 'FIXED_REBUILT' }
}

/** 这些目录里全是系统自带的 .db（man 缓存、包管理、avahi…），扫了只会刷屏。 */
const SYSTEM_DIRS = new Set(['proc', 'sys', 'dev', 'run', 'boot', 'snap', 'tmp', 'usr',
  'lib', 'lib32', 'lib64', 'bin', 'sbin', 'var/cache', 'cache', 'node_modules'])

/**
 * 在一个根目录下找 `leion.db`。
 *
 * <p>用途：新机器上 `/var/lib/leion/live` 是空的时候，十有八九是 relay 带的
 * `--data-dir` 跟你想的不一样（或根本没起过）。先把它找出来再说。
 *
 * <p>默认**只报 leion 的库**并跳过系统目录 —— 全盘扫出来的 man/包管理缓存会把真正
 * 要看的那一行淹掉。想看全部加 `--scan-all`。
 */
export function scanFor(root, options = {}) {
  const all = options.scanAll === true
  const hits = []
  let ignored = 0
  const walk = (dir, depth) => {
    if (depth > 6) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SYSTEM_DIRS.has(entry.name)) continue
        walk(full, depth + 1)
      } else if (entry.name.endsWith('.db')) {
        const relevant = /leion/i.test(entry.name) || full.includes('/leion/')
        if (!relevant && !all) {
          ignored += 1
          continue
        }
        const diag = diagnoseFile(full)
        hits.push({ file: full, size: diag.size, magic: diag.magic })
      }
    }
  }
  walk(resolve(root), 0)
  const leion = hits.filter((hit) => /leion/i.test(hit.file))
  console.log(`\n在 ${resolve(root)} 下找到 ${leion.length} 个 leion 库`
    + (ignored > 0 ? `（另有 ${ignored} 个系统自带 .db 已忽略，想看加 --scan-all）` : '') + '：')
  for (const hit of leion) {
    console.log(`  ${hit.magic ? '✓' : '✗'} ${hit.file}  ${kb(hit.size)}${hit.magic ? '' : '（不是 SQLite）'}`)
  }
  if (leion.length === 0) {
    console.log('  （一个都没有：说明这台机器上还没跑过 relay，或数据目录在别的盘/别的名字）')
  }
  if (all) {
    for (const hit of hits.filter((one) => /leion/i.test(one.file) === false)) {
      console.log(`     (其它) ${hit.file}  ${kb(hit.size)}`)
    }
  }
  return 0
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help === true) {
    console.log('node scripts/doctor-db.mjs [--fix] [--data-dir <dir>]...')
    console.log('node scripts/doctor-db.mjs --scan /var/lib/leion [--scan-all]')
    console.log('node scripts/doctor-db.mjs --reset [--data-dir <dir>]   # 测试环境：直接重建空库（旧库留档）')
    return 0
  }
  if (options.scan !== null) return scanFor(options.scan, options)
  console.log('SQLite 体检 /var/lib/leion 下的数据目录（先停 relay 再跑，尤其带 --fix / --reset）')
  const results = options.dataDirs.map((dir) => checkOne(dir, options))
  console.log('')
  console.log('━━ 汇总')
  for (const one of results) console.log(`  ${one.verdict.padEnd(18)} ${one.dir}`)
  const bad = results.filter((one) => ['CORRUPT', 'UNRECOVERABLE', 'STALE_WAL', 'RESET_FAILED', 'NO_DB', 'SCHEMA_STALE'].includes(one.verdict))
  if (bad.length > 0) {
    console.log('')
    console.log('有库需要处理。按上面每一条给出的修法做；**修之前先备份**（脚本自己也会备份）。')
    return 1
  }
  return 0
}

/** 直接运行时才跑；被测试 import 时不执行（否则一 import 就体检本机）。 */
if (process.argv[1] !== undefined && process.argv[1].endsWith('doctor-db.mjs')) {
  process.exit(main())
}
