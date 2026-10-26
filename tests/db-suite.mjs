/**
 * db-suite.mjs —— SQLite 访问层与 JSON 迁移（P1）
 * ============================================================================
 * 这一层要守的只有三件事：
 *   ① 表结构与版本能幂等建起来（重复 open 不出错、不多建）；
 *   ② **旧 JSON 迁过来的条数逐项对得上**（账号/库/条目/申请）——迁移错了，
 *      用户登录不上、术语丢失，而且很难一眼看出来；
 *   ③ 发言权的互斥在**数据库层**成立：`floor_state` 一房一行，谁写谁生效，不会出现两行。
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importFromDataDir, openDb, purgeOldUtterances, SCHEMA_VERSION } from '../lib/db.mjs'
import { readAccountsDoc, writeAccountsDoc } from '../lib/accounts-store.mjs'

export async function runDbSuite({ it, check }) {
  const dir = mkdtempSync(join(tmpdir(), 'leion-db-'))

  await it('建表幂等、版本可查、WAL 已开', () => {
    const file = join(dir, 'a.db')
    const db = openDb(file)
    check('user_version = SCHEMA_VERSION',
      Number(db.prepare('PRAGMA user_version').get().user_version) === SCHEMA_VERSION)
    check('journal_mode 是 wal',
      String(db.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase() === 'wal')
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name)
    for (const expected of ['accounts', 'libraries', 'library_entries', 'requests', 'rooms',
      'room_members', 'floor_state', 'utterances', 'settings']) {
      check(`有表 ${expected}`, tables.includes(expected), tables.join(','))
    }
    db.close()
    const again = openDb(file)          // 第二次打开不该报错
    check('重复打开没问题', Number(again.prepare('PRAGMA user_version').get().user_version) === SCHEMA_VERSION)
    again.close()
  })

  await it('旧 JSON 的条数逐项迁过来，且重复导入不翻倍', () => {
    const dataDir = join(dir, 'data')
    mkdirSync(join(dataDir, 'libraries'), { recursive: true })
    writeFileSync(join(dataDir, 'accounts.json'), JSON.stringify({
      version: 1,
      users: {
        boss: { salt: 'aa', hash: 'bb', role: 'admin', status: 'active', createdAt: '2026-10-01T00:00:00Z' },
        dev1: { salt: 'cc', hash: 'dd', role: 'dev', status: 'active', createdAt: '2026-10-02T00:00:00Z',
          expiresAt: '2026-11-01T00:00:00Z', email: 'dev1@example.com' },
        broken: { role: 'user' },
      },
      tokens: { hash1: { user: 'boss', label: 'cli', createdAt: '2026-10-03T00:00:00Z' } },
    }))
    writeFileSync(join(dataDir, 'libraries', 'lib-a.json'), JSON.stringify({
      id: 'lib-a', name: '出口贸易', category: '贸易', owner: 'boss',
      createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z',
      entries: [
        { zh: '亮亮眼镜', pt: 'Óculos Leion', variants: ['亮亮'], approved: ['Leion'], priority: 1 },
        { zh: '圣保罗', pt: 'São Paulo' },
      ],
    }))
    writeFileSync(join(dataDir, 'requests.jsonl'), [
      JSON.stringify({ id: 'req-1', type: 'add', libraryId: 'lib-a', zh: '编号', pt: 'código',
        reason: '常用', by: 'dev1', at: '2026-10-05T00:00:00Z', state: 'pending' }),
      'not-json',
    ].join('\n'))

    const db = openDb(join(dir, 'b.db'))
    const first = importFromDataDir(db, dataDir)
    check('账号 2 个（缺 hash/salt 的 broken 被跳过）', first.accounts === 2, JSON.stringify(first))
    check('库 1 个', first.libraries === 1, JSON.stringify(first))
    check('条目 2 条', first.entries === 2, JSON.stringify(first))
    check('申请 1 条（坏行跳过）', first.requests === 1, JSON.stringify(first))
    check('坏行有记录，不静默丢', first.skipped.length === 2, JSON.stringify(first.skipped))

    const second = importFromDataDir(db, dataDir)
    const count = (table) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n)
    check('重复导入后账号还是 2', count('accounts') === second.accounts, String(count('accounts')))
    check('重复导入后条目还是 2', count('library_entries') === 2, String(count('library_entries')))
    check('重复导入后申请还是 1', count('requests') === 1, String(count('requests')))

    const row = db.prepare('SELECT * FROM accounts WHERE username = ?').get('dev1')
    check('到期时间迁成了毫秒时间戳', row.expires_at === Date.parse('2026-11-01T00:00:00Z'), String(row.expires_at))
    check('邮箱与角色都在', row.email === 'dev1@example.com' && row.role === 'dev', JSON.stringify(row))

    const entry = db.prepare('SELECT * FROM library_entries WHERE zh = ?').get('亮亮眼镜')
    check('变体与可接受写法存成 JSON 文本',
      JSON.parse(entry.variants).includes('亮亮') && JSON.parse(entry.approved).includes('Leion'),
      `${entry.variants} / ${entry.approved}`)
    db.close()
  })

  await it('账号 doc ↔ SQLite 往返等值（含 tokens 与 codes 的 key 字段）', () => {
    const dataDir = join(dir, 'acc')
    mkdirSync(dataDir, { recursive: true })
    const doc = {
      version: 1,
      users: {
        boss: { salt: 'aa', hash: 'bb', role: 'admin', status: 'active', createdAt: '2026-10-01T00:00:00.000Z', via: 'admin', email: 'boss@example.com' },
        dev1: { salt: 'cc', hash: 'dd', role: 'dev', status: 'active', createdAt: '2026-10-02T00:00:00.000Z', expiresAt: '2026-11-01T00:00:00.000Z', via: 'admin' },
      },
      tokens: { abc123: { user: 'boss', label: 'cli', createdAt: '2026-10-03T00:00:00.000Z' },
        orphan: { user: 'nobody', label: '', createdAt: '2026-10-03T00:00:00.000Z' } },
      codes: { 'dev1@example.com': { key: 'deadbeef', issuedAt: '2026-10-04T00:00:00.000Z', expiresAt: '2026-10-04T00:10:00.000Z' } },
    }
    check('写入成功', writeAccountsDoc(dataDir, doc).ok === true)
    const back = readAccountsDoc(dataDir)
    check('账号数一致', Object.keys(back.users).length === 2, JSON.stringify(Object.keys(back.users)))
    check('hash/salt/role/status 原样', back.users.boss.hash === 'bb' && back.users.boss.salt === 'aa'
      && back.users.boss.role === 'admin' && back.users.boss.status === 'active', JSON.stringify(back.users.boss))
    check('到期时间原样', back.users.dev1.expiresAt === '2026-11-01T00:00:00.000Z', String(back.users.dev1.expiresAt))
    check('邮箱保留', back.users.boss.email === 'boss@example.com')
    check('token 保留、孤儿 token 被丢弃', back.tokens.abc123?.user === 'boss' && back.tokens.orphan === undefined,
      JSON.stringify(Object.keys(back.tokens)))
    check('验证码用 key 字段（不是 hash）', back.codes['dev1@example.com']?.key === 'deadbeef',
      JSON.stringify(back.codes))
    check('验证码到期时间原样', back.codes['dev1@example.com'].expiresAt === '2026-10-04T00:10:00.000Z')
    check('二次写入不翻倍（整表替换）', (() => {
      writeAccountsDoc(dataDir, back)
      const again = readAccountsDoc(dataDir)
      return Object.keys(again.users).length === 2 && Object.keys(again.tokens).length === 1
    })())
  })
  await it('发言权互斥在库层成立：一房只有一行 floor_state', () => {
    const db = openDb(join(dir, 'c.db'))
    db.prepare('INSERT INTO rooms (id, code, name, host, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('room-1', '123456', '圣保罗洽谈', 'boss', 1)
    const setFloor = db.prepare(`
      INSERT INTO floor_state (room_id, holder, locked, since) VALUES (?, ?, ?, ?)
      ON CONFLICT(room_id) DO UPDATE SET holder = excluded.holder, locked = excluded.locked, since = excluded.since`)
    setFloor.run('room-1', 'boss', 0, 100)
    setFloor.run('room-1', 'dev1', 0, 200)          // 抢麦：顶替
    const rows = db.prepare('SELECT * FROM floor_state WHERE room_id = ?').all('room-1')
    check('只有一行', rows.length === 1, JSON.stringify(rows))
    check('持有者被顶替成 dev1', rows[0].holder === 'dev1', JSON.stringify(rows[0]))
    setFloor.run('room-1', 'dev1', 1, 300)
    check('锁定标记能写进去', Number(db.prepare('SELECT locked FROM floor_state WHERE room_id = ?')
      .get('room-1').locked) === 1)
    db.close()
  })

  await it('7 天清理只删老字幕', () => {
    const db = openDb(join(dir, 'd.db'))
    const insert = db.prepare(`INSERT INTO utterances (room_id, username, src_lang, src_text, dst_text, start_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
    const now = Date.parse('2026-10-25T12:00:00Z')
    insert.run('r', 'boss', 'zh-CN', '旧', 'velho', now - 8 * 86400000)
    insert.run('r', 'boss', 'zh-CN', '新', 'novo', now - 1 * 86400000)
    const removed = purgeOldUtterances(db, now)
    check('删了 1 条', removed === 1, String(removed))
    const left = db.prepare('SELECT src_text FROM utterances').all().map(row => row.src_text)
    check('只留下新的那条', left.length === 1 && left[0] === '新', left.join(','))
    db.close()
  })

  rmSync(dir, { recursive: true, force: true })
}
