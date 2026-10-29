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

import { copyFileSync, existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const DEFAULT_DATA_DIRS = ['/var/lib/leion/live', '/var/lib/leion/test']

/** 解析参数：只要两个开关 + 一个值，手写比引依赖清楚。 */
export function parseArgs(argv) {
  const out = { fix: false, dataDirs: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--fix') out.fix = true
    else if (arg === '--data-dir') {
      const value = argv[i + 1]
      if (value === undefined) throw new Error('--data-dir 需要一个路径')
      out.dataDirs.push(value)
      i += 1
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
    return { ok: false, error: String(error?.message ?? error) }
  } finally {
    if (db !== null) {
      try { db.close() } catch { /* ignore */ }
    }
  }
  if (!existsSync(built)) return { ok: false, error: 'VACUUM INTO 没有产出文件' }
  const verify = inspectFile(built)
  if (!verify.ok) {
    rmSync(built, { force: true })
    return { ok: false, error: '重建出来的库自检也没过（页面里已经是坏数据）' }
  }
  return { ok: true, built }
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

export function checkOne(dataDir, options) {
  const dir = resolve(dataDir)
  const file = join(dir, 'leion.db')
  console.log('')
  console.log(`━━ ${dir}`)
  if (!existsSync(dir)) {
    console.log('  · 目录不存在（这台机器上没有这个数据目录）')
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
    console.log('  → 结论：没有主库文件。要么还没跑过 relay，要么路径不对')
    return { dir, verdict: 'NO_DB' }
  }

  const result = inspectFile(file)
  if (result.ok) {
    console.log(`  → 结论：健康（${result.tables} 张表，quick_check 与 integrity_check 都过）`)
    const wal = stamp(`${file}-wal`)
    if (wal !== null && wal.size > 0) {
      console.log('  ⚠️ -wal 非空：说明最后一次是"没干净关闭"（进程被杀或还在跑）。')
      console.log('     正常关闭时会在退出前 checkpoint 掉；此刻别直接拷这个库，先停 relay。')
    }
    return { dir, verdict: 'OK' }
  }

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
  if (!rebuilt.ok) {
    console.log(`     VACUUM INTO 失败：${rebuilt.error}`)
    console.log('     最后手段（sqlite3 CLI 的 .recover，能捞出坏页里的行）：')
    console.log(`       sqlite3 ${file} ".recover" | sqlite3 ${file}.recovered`)
    console.log(`       mv ${file}.recovered ${file}`)
    return { dir, verdict: 'UNRECOVERABLE' }
  }
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${file}${suffix}`
    if (existsSync(source)) renameSync(source, `${source}.broken-${Date.now()}`)
  }
  renameSync(rebuilt.built, file)
  console.log('     ✓ 已用 VACUUM INTO 重建并替换（坏文件留在 *.broken-* 里，别急着删）')
  return { dir, verdict: 'FIXED_REBUILT' }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help === true) {
    console.log('node scripts/doctor-db.mjs [--fix] [--data-dir <dir>]...')
    return 0
  }
  console.log('SQLite 体检 /var/lib/leion 下的数据目录（先停 relay 再跑，尤其带 --fix）')
  const results = options.dataDirs.map((dir) => checkOne(dir, options))
  console.log('')
  console.log('━━ 汇总')
  for (const one of results) console.log(`  ${one.verdict.padEnd(18)} ${one.dir}`)
  const bad = results.filter((one) => ['CORRUPT', 'UNRECOVERABLE', 'STALE_WAL'].includes(one.verdict))
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
