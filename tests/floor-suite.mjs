/** floor-suite.mjs —— 发言权互斥（P2b）：抢麦 / 锁定 / 到达顺序 / 断线释放 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRoom } from '../lib/rooms.mjs'
import { FLOOR_LEASE_MS, FLOOR_LOCKED_LEASE_MS, floorLeaseOf, floorState, forceReleaseFloor, heartbeatFloor, releaseFloor, setFloorLock, sweepExpiredFloor, takeFloor } from '../lib/floor.mjs'

export async function runFloorSuite({ it, check }) {
  const dir = mkdtempSync(join(tmpdir(), 'leion-floor-'))
  const room = createRoom(dir, { name: '发言权测试', host: 'boss', code: '555555' }).room

  await it('空麦可直接开麦；自己重复开麦是幂等的', () => {
    const first = takeFloor(dir, { roomId: room.id, username: 'boss' })
    check('首次开麦成功', first.ok === true && first.state.holder === 'boss', JSON.stringify(first))
    const again = takeFloor(dir, { roomId: room.id, username: 'boss' })
    check('重复开麦仍是自己（不报错）', again.ok === true && again.state.holder === 'boss', JSON.stringify(again))
    releaseFloor(dir, { roomId: room.id, username: 'boss' })
  })

  await it('他人未锁定时抢麦成功，并报告顶替了谁', () => {
    takeFloor(dir, { roomId: room.id, username: 'boss' })
    const grabbed = takeFloor(dir, { roomId: room.id, username: 'dev1' })
    check('抢麦成功', grabbed.ok === true && grabbed.state.holder === 'dev1', JSON.stringify(grabbed))
    check('tookOver 指出被顶替者', grabbed.tookOver === 'boss', JSON.stringify(grabbed.tookOver))
    check('全场仍只有一个持麦者', floorState(dir, room.id).holder === 'dev1')
  })

  await it('锁定后他人开麦被拒；仅发起者可解除他人锁定', () => {
    setFloorLock(dir, { roomId: room.id, username: 'dev1', host: room.host, locked: true })
    const blocked = takeFloor(dir, { roomId: room.id, username: 'boss' })
    check('锁定时开麦被拒', blocked.ok === false && /发言已锁定/.test(blocked.error), JSON.stringify(blocked))

    // 第三个成员（既不是持麦者也不是发起者）尝试解锁 → 应被拒
    const otherUnlock = setFloorLock(dir, { roomId: room.id, username: 'dev2', host: room.host, locked: false })
    check('非持麦者且非发起者不能解锁', otherUnlock.ok === false, JSON.stringify(otherUnlock))

    const hostUnlock = setFloorLock(dir, { roomId: room.id, username: 'boss', host: 'boss', locked: false })
    check('发起者可以解除他人锁定', hostUnlock.ok === true && hostUnlock.state.locked === false, JSON.stringify(hostUnlock))
  })

  await it('心跳刷新可续期；超过宽限期视为断线释放', () => {
    const t0 = '2026-10-27T00:00:00.000Z'
    takeFloor(dir, { roomId: room.id, username: 'dev1', now: t0 })
    const t1 = new Date(Date.parse(t0) + FLOOR_LEASE_MS - 1000).toISOString()
    check('心跳成功', heartbeatFloor(dir, { roomId: room.id, username: 'dev1', now: t1 }).ok === true)
    const t2 = new Date(Date.parse(t0) + FLOOR_LEASE_MS + 5000).toISOString()
    const expired = takeFloor(dir, { roomId: room.id, username: 'boss', now: t2 })
    check('超过宽限期后他人可直接开麦', expired.ok === true && expired.state.holder === 'boss', JSON.stringify(expired))
  })

  await it('只有发起者能强制收回；关麦只能关自己的', () => {
    takeFloor(dir, { roomId: room.id, username: 'boss' })
    const wrongPerson = releaseFloor(dir, { roomId: room.id, username: 'dev1' })
    check('不是自己不能关麦', wrongPerson.ok === false, JSON.stringify(wrongPerson))
    const notHost = forceReleaseFloor(dir, { roomId: room.id, by: 'dev1', host: room.host })
    check('非发起者不能强制收回', notHost.ok === false, JSON.stringify(notHost))
    const byHost = forceReleaseFloor(dir, { roomId: room.id, by: 'boss', host: room.host })
    check('发起者强制收回成功', byHost.ok === true && byHost.released === 'boss', JSON.stringify(byHost))
    check('收回后麦克风空闲', floorState(dir, room.id).holder === null)
  })

  await it('锁定态的掉线也会释放（4.42）：宽限更长，但**不是永久**', () => {
    // 以前租约判断带 `!locked`，于是"锁了麦又掉线"永久占麦，只能等发起人手点强制收回。
    const t0 = '2026-10-27T00:00:00.000Z'
    takeFloor(dir, { roomId: room.id, username: 'dev1', now: t0 })
    setFloorLock(dir, { roomId: room.id, username: 'dev1', host: room.host, locked: true })

    check('锁定态租约比普通态长', FLOOR_LOCKED_LEASE_MS > FLOOR_LEASE_MS,
      `${FLOOR_LOCKED_LEASE_MS} vs ${FLOOR_LEASE_MS}`)
    check('floorLeaseOf 按锁定与否取租约',
      floorLeaseOf(true) === FLOOR_LOCKED_LEASE_MS && floorLeaseOf(false) === FLOOR_LEASE_MS)

    // 普通租约（15 秒）早就过了，但锁定态的宽限（60 秒）还没到 → 仍然抢不走
    const stillLocked = new Date(Date.parse(t0) + FLOOR_LEASE_MS + 5000).toISOString()
    const blocked = takeFloor(dir, { roomId: room.id, username: 'boss', now: stillLocked })
    check('锁定宽限内他人仍被拒', blocked.ok === false, JSON.stringify(blocked))

    // 超过锁定宽限 → 视为掉线，麦可以直接拿走
    const expired = new Date(Date.parse(t0) + FLOOR_LOCKED_LEASE_MS + 5000).toISOString()
    const taken = takeFloor(dir, { roomId: room.id, username: 'boss', now: expired })
    check('超过锁定宽限后可以顶替', taken.ok === true && taken.state.holder === 'boss', JSON.stringify(taken))
    check('回执说清是"上一个租约过期"且当时是锁定的',
      taken.reason === 'previous-lease-expired' && taken.releasedLocked === true, JSON.stringify(taken))
    releaseFloor(dir, { roomId: room.id, username: 'boss', now: expired })
  })

  await it('没人来抢时也要清扫过期持麦（GET /floor 那个入口用它）', () => {
    const t0 = '2026-10-28T00:00:00.000Z'
    takeFloor(dir, { roomId: room.id, username: 'dev1', now: t0 })
    setFloorLock(dir, { roomId: room.id, username: 'dev1', host: room.host, locked: true })

    const early = new Date(Date.parse(t0) + 10000).toISOString()
    check('没超期时不清', sweepExpiredFloor(dir, room.id, Date.parse(early)).released === null)

    const late = new Date(Date.parse(t0) + FLOOR_LOCKED_LEASE_MS + 1000).toISOString()
    const swept = sweepExpiredFloor(dir, room.id, Date.parse(late))
    check('超期后清掉了', swept.released === 'dev1', JSON.stringify(swept))
    check('连锁定一起清掉', swept.locked === true, JSON.stringify(swept))
    check('清完是空麦', floorState(dir, room.id).holder === null)
    check('再扫一次就没事可做', sweepExpiredFloor(dir, room.id, Date.parse(late)).released === null)
  })

  rmSync(dir, { recursive: true, force: true })
}