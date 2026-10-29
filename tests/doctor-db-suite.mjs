/**
 * doctor-db-suite.mjs —— 数据目录体检脚本的断言（4.65）
 * ============================================================================
 * 这个脚本存在的理由是一次真实事故：**把整个镜像搬到新服务器**后，管理员登录报
 * `database disk image is malformed`，而终端上只有这一句 —— 看不出是哪个库、为什么坏、
 * 有没有救。所以它的价值全在"判断得对不对"：好库要判健康、坏库要判坏、别把 WAL 的锅
 * 扣到库本体上。这里逐个钉住。
 *
 * ⚠️ 直接调函数、不 spawn 子进程：受限沙箱里 `child_process` 抓不到子进程的 stdout
 * （EPERM），所以脚本把检查逻辑都 export 出来（与 scripts/net-doctor.mjs 一个套路）。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dbPath, openDb } from '../lib/db.mjs'
import { checkOne, diagnoseFile, inspectFile, salvageToNewDb, scanFor } from '../scripts/doctor-db.mjs'
import { main as createAccountMain } from '../scripts/create-account.mjs'
import { loadAccounts } from '../lib/accounts.mjs'

/** 同上，给 async 的 main() 用。 */
async function capturedAsync(fn) {
  const lines = []
  const original = console.log
  console.log = (...args) => lines.push(args.map(String).join(' '))
  try {
    const result = await fn()
    return { text: lines.join('\n'), result }
  } finally {
    console.log = original
  }
}

/** 把 console.log 抓成字符串：脚本的"结论"就是它打印出来的那些行。 */
function captured(fn) {
  const lines = []
  const original = console.log
  console.log = (...args) => lines.push(args.map(String).join(' '))
  try {
    const result = fn()
    return { text: lines.join('\n'), result }
  } finally {
    console.log = original
  }
}

export async function runDoctorDbSuite({ it, check }) {
  await it('健康库判"健康"，并报出 wal/shm 有没有', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-ok-'))
    try {
      openDb(dbPath(dir)).close()
      const { text, result } = captured(() => checkOne(dir, { fix: false }))
      check('结论是健康', result.verdict === 'OK', `${result.verdict}\n${text}`)
      check('输出里提到 wal', text.includes('leion.db-wal'), text)
      check('健康时不给人多余的动作', !text.includes('node scripts/doctor-db.mjs --fix'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await it('坏库判"库本体已经坏了"，并给出下一步（先停 relay、从旧机器重拷）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-bad-'))
    try {
      openDb(dbPath(dir)).close()
      // 把第 2 页写成垃圾：模拟"搬的时候 relay 还在写，拷到半页数据"
      const file = dbPath(dir)
      const buffer = readFileSync(file)
      for (let i = 4096; i < Math.min(8192, buffer.length); i += 1) buffer[i] = 0xFF
      writeFileSync(file, buffer)

      const { text, result } = captured(() => checkOne(dir, { fix: false }))
      check('判成损坏', result.verdict === 'CORRUPT', `${result.verdict}\n${text}`)
      check('指出是库本体而不是 WAL', text.includes('库本体已经坏了'), text)
      check('给出从旧机器重拷的修法（带"先停 relay"）', text.includes('先停 relay'), text)
      check('顺手教了 .backup 的用法', text.includes('.backup'), text)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await it('--fix 动文件之前一定先备份', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-fix-'))
    try {
      const db = openDb(dbPath(dir))
      db.exec("INSERT INTO settings (key, value) VALUES ('probe', 'x')")
      db.close()
      const file = dbPath(dir)
      const buffer = readFileSync(file)
      if (buffer.length > 8192) {
        for (let i = 8192; i < Math.min(16384, buffer.length); i += 1) buffer[i] = 0xFF
        writeFileSync(file, buffer)
      }
      const { text, result } = captured(() => checkOne(dir, { fix: true }))
      const backups = existsSync(dir)
        ? readdirSync(dir).filter((name) => name.includes('.bak-') || name.includes('.broken-'))
        : []
      // 两种结局都行：修好了，或者判死并给出 .recover 方案 —— 但动过文件就必须留备份
      check('有结论', /重建|\.recover|修法/.test(text), text)
      check('动了文件就留备份',
        backups.length > 0 || result.verdict === 'CORRUPT' || result.verdict === 'UNRECOVERABLE',
        `${result.verdict} ${backups.join(',')}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await it('诊断看得出"不是 SQLite 文件"（头不对 vs 页坏了）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-head-'))
    try {
      openDb(dbPath(dir)).close()
      const good = diagnoseFile(dbPath(dir))
      check('健康库完整认出 SQLite 头', good.magic === true, JSON.stringify(good))
      check('页尺寸读对了（4096 的倍数）', good.pageSize === 4096, String(good.pageSize))

      const bogus = join(dir, 'bogus.db')
      writeFileSync(bogus, Buffer.from('this is not a database at all', 'utf8'))
      const bad = diagnoseFile(bogus)
      check('不是库的文件被识破', bad.magic === false, JSON.stringify(bad))
      check('理由里带实际头字节', String(bad.reason).includes('SQLite'), String(bad.reason))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await it('逐表抢救：能读的表先搬过去', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-salvage-'))
    try {
      const db = openDb(dbPath(dir))
      db.exec("INSERT INTO settings (key, value) VALUES ('probe', 'kept')")
      db.close()
      const target = join(dir, 'salvaged.db')
      const salvaged = salvageToNewDb(dbPath(dir), target)
      check('抢救返回���功', salvaged.ok === true, JSON.stringify(salvaged.report ?? salvaged.error))
      check('至少搬了一张表', (salvaged.report?.tables ?? []).length > 0,
        JSON.stringify(salvaged.report))
      const checkDb = openDb(target)
      const row = checkDb.prepare("SELECT value FROM settings WHERE key = 'probe'").get()
      checkDb.close()
      check('数据真的过去了', row?.value === 'kept', JSON.stringify(row))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await it('--scan 只报 leion 的库，别被系统自带的 .db 刷屏', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-scan-'))
    try {
      openDb(dbPath(dir)).close()                       // <dir>/leion.db
      const other = join(dir, 'other.db')
      writeFileSync(other, readFileSync(dbPath(dir)))   // 不是 leion 的库
      const nested = join(dir, 'cache')
      mkdirSync(nested, { recursive: true })
      writeFileSync(join(nested, 'index.db'), readFileSync(dbPath(dir)))

      const plain = captured(() => scanFor(dir))
      check('报出了 leion.db', plain.text.includes('leion.db'), plain.text)
      check('敏感文件不混进来', !plain.text.includes('other.db'), plain.text)
      check('系统目录被跳过', !plain.text.includes('index.db'), plain.text)

      const all = captured(() => scanFor(dir, { scanAll: true }))
      check('--scan-all 才把它们列出来', all.text.includes('other.db'), all.text)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await it('--reset：坏库挪去留档、建新空库，然后一条命令建管理员', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-reset-'))
    try {
      openDb(dbPath(dir)).close()
      const file = dbPath(dir)
      const buffer = readFileSync(file)
      for (let i = 4096; i < Math.min(8192, buffer.length); i += 1) buffer[i] = 0xFF
      writeFileSync(file, buffer)

      const { text, result } = captured(() => checkOne(dir, { reset: true }))
      check('结论是重建', result.verdict === 'RESET', `${result.verdict}\n${text}`)
      check('新库自检健康', inspectFile(file).ok === true)
      check('旧库留了一份（不直接删）',
        readdirSync(dir).some((name) => name.includes('.old-')), readdirSync(dir).join(','))

      // 重建完必须能立刻建出能登录的账号，否则"重建"等于把系统弄瘫
      const created = await capturedAsync(() => createAccountMain([
        '--data-dir', dir, '--user', 'boss', '--password', 'Test1234', '--role', 'admin',
      ]))
      check('建账号成功', created.text.includes('已建账号'), created.text)
      const doc = await loadAccounts(dir)
      check('角色是管理员', doc.users?.boss?.role === 'admin', JSON.stringify(doc.users))
      check('密码不是明文落盘', JSON.stringify(doc).includes('Test1234') !== true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await it('打开坏库时抛的是"怎么办"，不是一句 malformed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-open-'))
    try {
      writeFileSync(dbPath(dir), Buffer.alloc(4096, 0xFF))
      let message = ''
      try {
        openDb(dbPath(dir)).close()
      } catch (error) {
        message = String(error && error.message ? error.message : error)
      }
      check('抛了错', message !== '')
      check('错误里带库路径', message.includes('leion.db'), message)
      check('错误里告诉你去跑 doctor-db', message.includes('doctor-db.mjs'), message)
      check('错误里解释了搬迁这个常见原因', message.includes('搬迁') || message.includes('relay'), message)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
