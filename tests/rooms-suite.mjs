/** rooms-suite.mjs —— 房间与邀请码（P2a） */
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRoom, isRoomClosed, joinRoom, leaveRoom, listMembers, roomByCode, roomLibraries, setRoomLibraries } from '../lib/rooms.mjs'

export async function runRoomsSuite({ it, check }) {
  const dir = mkdtempSync(join(tmpdir(), 'leion-rooms-'))

  await it('建房给 6 位邀请码；别人凭码加入；错码进不来', () => {
    const created = createRoom(dir, { name: '圣保罗洽谈', host: 'boss', code: '123456' })
    check('建房成功', created.ok === true, JSON.stringify(created))
    check('邀请码是 6 位', /^\d{6}$/.test(created.room.code), created.room.code)
    const joined = joinRoom(dir, { code: '123456', username: 'dev1' })
    check('凭码加入成功', joined.ok === true, JSON.stringify(joined))
    check('成员两人', joined.members.length === 2, JSON.stringify(joined.members))
    const bad = joinRoom(dir, { code: '000000', username: 'dev1' })
    check('错码被拒', bad.ok === false && /邀请码无效/.test(bad.error), JSON.stringify(bad))
    const again = joinRoom(dir, { code: '123456', username: 'dev1' })
    check('重复加入幂等（成员数不变）', again.ok === true && again.members.length === 2, JSON.stringify(again.members))
  })

  await it('默认码是 6 位数字且不重复', () => {
    const a = createRoom(dir, { name: 'A', host: 'boss' })
    const b = createRoom(dir, { name: 'B', host: 'boss' })
    check('A 码 6 位', /^\d{6}$/.test(a.room.code), a.room.code)
    check('B 码 6 位', /^\d{6}$/.test(b.room.code), b.room.code)
    check('两房码不同', a.room.code !== b.room.code, `${a.room.code} vs ${b.room.code}`)
    check('roomByCode 能反查', roomByCode(dir, b.room.code)?.id === b.room.id)
  })

  await it('房间术语库选择可保存可读回', () => {
    const room = createRoom(dir, { name: '术语房间', host: 'boss', code: '654321' }).room
    check('先为空', roomLibraries(dir, room.id).length === 0)
    const saved = setRoomLibraries(dir, room.id, ['lib-a', 'lib-b'])
    check('保存成功', saved.ok === true, JSON.stringify(saved))
    check('读回两条且有序', JSON.stringify(roomLibraries(dir, room.id)) === JSON.stringify(['lib-a', 'lib-b']),
      JSON.stringify(roomLibraries(dir, room.id)))
    setRoomLibraries(dir, room.id, ['lib-b'])
    check('整表替换（旧的被清掉）', JSON.stringify(roomLibraries(dir, room.id)) === JSON.stringify(['lib-b']))
  })

  await it('成员列表按加入时间排序', () => {
    const room = createRoom(dir, { name: '排序房间', host: 'boss', code: '111111' }).room
    joinRoom(dir, { room, username: 'first', now: '2026-10-26T00:00:00.000Z' })
    joinRoom(dir, { room, username: 'second', now: '2026-10-26T00:01:00.000Z' })
    const members = listMembers(dir, room.id).map((m) => m.username).filter((n) => n !== 'boss')
    check('顺序正确（建房者 boss 也在成员里，按时间排在最后）', members.join(',') === 'first,second', members.join(','))
  })

  await it('普通成员退出不影响房间；发起者退出 = 整场结束', () => {
    const room = createRoom(dir, { name: '退出测试', host: 'boss', code: '777777' }).room
    joinRoom(dir, { room, username: 'dev1' })
    const memberLeft = leaveRoom(dir, { room, username: 'dev1' })
    check('成员退出后房间仍开着', memberLeft.ok === true && memberLeft.closed === false, JSON.stringify(memberLeft))
    check('成员不再在列表里', listMembers(dir, room.id).every((m) => m.username !== 'dev1'))
    check('房间未关闭', isRoomClosed(dir, room.id) === false)

    const hostLeft = leaveRoom(dir, { room, username: 'boss' })
    check('发起者退出 → closed:true', hostLeft.ok === true && hostLeft.closed === true, JSON.stringify(hostLeft))
    check('房间标记为结束', isRoomClosed(dir, room.id) === true)
    const rejoin = joinRoom(dir, { code: '777777', username: 'dev1' })
    check('结束后凭码进不来', rejoin.ok === false, JSON.stringify(rejoin))
  })
  rmSync(dir, { recursive: true, force: true })
}