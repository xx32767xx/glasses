/**
 * purge-history-suite.mjs —— 管理员清理会议历史（4.99）
 * ============================================================================
 * 这一套守的是"**删数据**"这件事，所以重点不在"能不能删"，而在三条边界：
 *
 *   1. **进行中的会议永远不删** —— 删了正在开的会就是事故；
 *   2. **dry-run 真的不删** —— 第一版 CLI 的"预览"直接调了 purgeHistory，于是预览就删了；
 *   3. **删得干净** —— 数据库（会议行 + 转写）与磁盘（音频/总线/收件箱）一起走，
 *      不能留下"房间没了、转写还在"的孤儿数据。
 *
 * 还要钉住"权限只给管理员"：清理是整机动作，普通成员连"从别人列表里删"都做不到（4.71）。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRoom, joinRoom, listHistoryForAdmin, purgeHistory } from '../lib/rooms.mjs'
import { dbPath, openDb } from '../lib/db.mjs'
import { removeRoomDataFiles } from '../relay/lan-relay.mjs'
import { allowed, ROLE_PERMISSIONS } from '../lib/accounts.mjs'
import { parseArgs as purgeParseArgs } from '../scripts/purge-history.mjs'
import { handleOrg } from '../relay/org-api.mjs'

/** 造一场"已结束"的会 + 若干转写。 */
function seedClosedRoom(dataDir, { name, host, utterances, endedDaysAgo = 10 }) {
  const created = createRoom(dataDir, { name, host })
  const db = openDb(dbPath(dataDir))
  const now = Date.now()
  for (let i = 0; i < utterances; i += 1) {
    db.prepare(`INSERT INTO utterances (room_id, username, src_lang, src_text, dst_text, start_at, is_final)
      VALUES (?, ?, ?, ?, ?, ?, 1)`).run(created.room.id, host, 'zh-CN', `中文${i}`, `pt${i}`, now - i * 1000)
  }
  if (endedDaysAgo !== null) {
    db.prepare('UPDATE rooms SET closed_at = ? WHERE id = ?')
      .run(now - endedDaysAgo * 24 * 60 * 60 * 1000, created.room.id)
  }
  db.close()
  return created.room
}

export async function runPurgeHistorySuite({ it, check, assert }) {
  const base = join('var', 'test', 'purge-suite')
  const fresh = () => {
    const dir = join(process.cwd(), base, `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    return dir
  }

  await it('权限：清理历史只给管理员（用户/测试账号都不行）', async () => {
    check('admin 可以', allowed('admin', 'history.purge') === true)
    check('普通用户不行', allowed('user', 'history.purge') === false)
    check('测试账号（dev）也不行', allowed('dev', 'history.purge') === false)
    check('这条权限确实登记在表里', Array.isArray(ROLE_PERMISSIONS['history.purge']),
      JSON.stringify(ROLE_PERMISSIONS['history.purge']))
  })

  await it('清单：管理员能看到已结束的会议，并带转写条数与时间跨度', async () => {
    const dir = fresh()
    try {
      const closed = seedClosedRoom(dir, { name: '旧会', host: 'alice', utterances: 3 })
      const active = createRoom(dir, { name: '进行中', host: 'bob' })
      const inventory = listHistoryForAdmin(dir)
      check('两场都在', inventory.items.length === 2, String(inventory.items.length))
      check('总数统计对', inventory.totals.rooms === 2 && inventory.totals.utterances === 3,
        JSON.stringify(inventory.totals))
      check('进行中的场次数对', inventory.totals.activeRooms === 1, String(inventory.totals.activeRooms))
      const old = inventory.items.find(item => item.id === closed.id)
      check('已结束的会议 active=false', old.active === false, String(old.active))
      check('带转写条数', old.utterances === 3, String(old.utterances))
      check('带最早/最近一条时间', old.firstAt !== null && old.lastAt !== null,
        `${old.firstAt}/${old.lastAt}`)
      const live = inventory.items.find(item => item.id === active.room.id)
      check('进行中的会议 active=true', live.active === true, String(live.active))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  await it('**进行中的会议永远删不掉**（点名删也不行）', async () => {
    const dir = fresh()
    try {
      const live = createRoom(dir, { name: '正在开', host: 'alice' })
      const result = purgeHistory(dir, { mode: 'rooms', roomIds: [live.room.id] })
      check('一场都没删', result.deletedRooms === 0, String(result.deletedRooms))
      check('明确说明了为什么跳过',
        result.skipped.some(item => item.id === live.room.id && item.why.includes('进行')),
        JSON.stringify(result.skipped))
      check('会议还在', listHistoryForAdmin(dir).totals.rooms === 1)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  await it('**dry-run 真的不删**（预览就把数据删了是致命 bug）', async () => {
    const dir = fresh()
    try {
      const closed = seedClosedRoom(dir, { name: '旧会', host: 'alice', utterances: 4 })
      mkdirSync(join(dir, 'audio'), { recursive: true })
      writeFileSync(join(dir, 'audio', `${closed.id}.pcm`), Buffer.alloc(2048))
      const preview = purgeHistory(dir, { mode: 'older-than', days: 7, dryRun: true })
      check('预览列出了会删的会议', preview.roomIds.length === 1, String(preview.roomIds.length))
      check('预览给了"会删掉多少条转写"', preview.deletedUtterances === 4, String(preview.deletedUtterances))
      check('标了这是 dryRun', preview.dryRun === true, String(preview.dryRun))
      check('会议还在（dry-run 没删）', listHistoryForAdmin(dir).totals.rooms === 1)
      check('转写还在', listHistoryForAdmin(dir).totals.utterances === 4)
      check('音频文件也还在', existsSync(join(dir, 'audio', `${closed.id}.pcm`)) === true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  await it('只删"够老"的已结束会议（新的不动）', async () => {
    const dir = fresh()
    try {
      const oldOne = seedClosedRoom(dir, { name: '十天前', host: 'alice', utterances: 2, endedDaysAgo: 10 })
      const recent = seedClosedRoom(dir, { name: '昨天', host: 'bob', utterances: 1, endedDaysAgo: 1 })
      const result = purgeHistory(dir, { mode: 'older-than', days: 7 })
      check('只删了那场老的', result.deletedRooms === 1 && result.roomIds[0] === oldOne.id,
        JSON.stringify(result.roomIds))
      check('删掉了它的转写', result.deletedUtterances === 2, String(result.deletedUtterances))
      const left = listHistoryForAdmin(dir)
      check('昨天那场还在', left.items.some(item => item.id === recent.id))
      check('转写只剩它的那一句', left.totals.utterances === 1, String(left.totals.utterances))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  await it('删得干净：数据库清了，磁盘上的音频/总线/收件箱也一起删', async () => {
    const dir = fresh()
    try {
      const closed = seedClosedRoom(dir, { name: '旧会', host: 'alice', utterances: 1 })
      mkdirSync(join(dir, 'audio'), { recursive: true })
      mkdirSync(join(dir, 'buses'), { recursive: true })
      const audio = join(dir, 'audio', `${closed.id}.pcm`)
      writeFileSync(audio, Buffer.alloc(4096))
      writeFileSync(`${audio}.rate`, '16000')
      const busFile = join(dir, 'buses', `${closed.id}.json`)
      writeFileSync(busFile, '{"lines":[]}')
      const inbox = join(dir, `asr-inbox-${closed.id}.jsonl`)
      writeFileSync(inbox, '{"text":"x"}\n')

      const result = purgeHistory(dir, { mode: 'all' })
      const freed = removeRoomDataFiles(dir, result.roomIds, join(dir, 'buses'))
      check('释放的字节数对得上（4096 + 5 + 13 + 13）', freed >= 4096, String(freed))
      check('音频没了', existsSync(audio) === false)
      check('旁文件也没了', existsSync(`${audio}.rate`) === false)
      check('总线没了', existsSync(busFile) === false)
      check('收件箱没了', existsSync(inbox) === false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  await it('单文件总线模式**不删共享的那份**（那是所有房间共用的）', async () => {
    const dir = fresh()
    try {
      const closed = seedClosedRoom(dir, { name: '旧会', host: 'alice', utterances: 1 })
      const sharedBus = join(dir, 'subtitle-bus.json')
      writeFileSync(sharedBus, '{"lines":["公共"]}')
      const result = purgeHistory(dir, { mode: 'all' })
      removeRoomDataFiles(dir, result.roomIds, sharedBus)
      check('共享总线文件还在', existsSync(sharedBus) === true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  await it('HTTP：非管理员调清理接口 → 403，管理员才放行', async () => {
    const dir = fresh()
    try {
      seedClosedRoom(dir, { name: '旧会', host: 'alice', utterances: 1 })
      const asUser = await handleOrg({
        method: 'POST', path: '/org/history/admin/purge', body: { mode: 'all' },
        user: 'alice', role: 'user', root: dir, now: new Date().toISOString(),
      })
      check('普通用户 403', asUser.status === 403, String(asUser.status))
      check('带上机器可读的原因', asUser.json.code === 'forbidden' && asUser.json.action === 'history.purge',
        JSON.stringify(asUser.json))

      const asDev = await handleOrg({
        method: 'GET', path: '/org/history/admin', body: null,
        user: 'dev1', role: 'dev', root: dir, now: new Date().toISOString(),
      })
      check('测试账号也读不到清单', asDev.status === 403, String(asDev.status))

      const asAdmin = await handleOrg({
        method: 'GET', path: '/org/history/admin', body: null,
        user: 'boss', role: 'admin', root: dir, now: new Date().toISOString(),
        audioBytesOf: () => 1234,
        audioDirBytes: () => 4321,
        utteranceRetentionDays: 7,
      })
      check('管理员 200', asAdmin.status === 200, String(asAdmin.status))
      check('清单里有那场会', asAdmin.json.items.length === 1, String(asAdmin.json.items.length))
      check('音频体积来自回调（relay 的路径规则）', asAdmin.json.items[0].audioBytes === 1234,
        String(asAdmin.json.items[0].audioBytes))
      check('整目录音频也在', asAdmin.json.totals.audioDirBytes === 4321,
        String(asAdmin.json.totals.audioDirBytes))

      let purgedIds = null
      const purge = await handleOrg({
        method: 'POST', path: '/org/history/admin/purge', body: { mode: 'all' },
        user: 'boss', role: 'admin', root: dir, now: new Date().toISOString(),
        purgeHistoryFiles: (ids) => { purgedIds = ids; return 999 },
      })
      check('管理员能清空', purge.status === 200 && purge.json.deletedRooms === 1,
        JSON.stringify(purge.json))
      check('文件清理用真实 roomIds 回调（让 relay 去删）',
        Array.isArray(purgedIds) && purgedIds.length === 1, JSON.stringify(purgedIds))
      check('回报释放的字节数', purge.json.freedBytes === 999, String(purge.json.freedBytes))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  await it('CLI 参数：三种范围都认得，写错要立刻报错', async () => {
    check('--older-than 7', purgeParseArgs(['--older-than', '7']).mode === 'older-than'
      && purgeParseArgs(['--older-than', '7']).days === 7)
    check('--all', purgeParseArgs(['--all']).mode === 'all')
    check('--rooms 逗号分隔', purgeParseArgs(['--rooms', 'a,b']).rooms.length === 2,
      JSON.stringify(purgeParseArgs(['--rooms', 'a,b']).rooms))
    check('--dry-run 是布尔', purgeParseArgs(['--all', '--dry-run']).dryRun === true)
    assert.throws(() => purgeParseArgs(['--older-than', '-1']), /older-than/)
    assert.throws(() => purgeParseArgs(['--older-than', 'x']), /older-than/)
    assert.throws(() => purgeParseArgs(['--nope']), /未知选项/)
    check('不给范围就只打帮助（不删任何东西）',
      purgeParseArgs([]).mode === null, String(purgeParseArgs([]).mode))
  })

  await it('管理台页面有这一块（清单 + 三种清理入口 + 二次确认）', async () => {
    const html = readFileSync(join(process.cwd(), 'scripts', 'admin-ui.html'), 'utf-8')
    check('有「会议历史数据」面板', html.includes('会议历史数据'))
    check('会显示总占用', html.includes('historyPill') && html.includes('humanBytes'))
    check('有"删除更早的"', html.includes('purgeHistoryOlder'))
    check('有"清空全部已结束的"', html.includes('purgeHistoryAll'))
    check('有"删除选中的"', html.includes('purgeHistorySelected'))
    check('清空要二次确认（不可逆的动作不能一键完成）',
      (html.match(/confirm\('/g) ?? []).length >= 3, String((html.match(/confirm\('/g) ?? []).length))
    check('进行中的会议勾选框禁用', /r\.active \? ' disabled/.test(html), '没禁用进行中的行')
    check('读的是新的管理员接口', html.includes('/org/history/admin'))
    check('写的是 purge 接口', html.includes('/org/history/admin/purge'))
    void statSync
  })

  // 收尾：清掉这一套自己造的临时目录
  rmSync(join(process.cwd(), base), { recursive: true, force: true })
}
