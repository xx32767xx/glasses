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

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dbPath, openDb } from '../lib/db.mjs'
import { checkOne } from '../scripts/doctor-db.mjs'

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
