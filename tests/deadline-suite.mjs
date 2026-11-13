/**
 * deadline-suite.mjs —— 「一句翻译卡住不许拖住整场」（5.189）
 * ============================================================================
 *
 * 现场事实（2026-11-13，一堂 71 分钟的课）：
 *   · 字幕整段停摆 **2 次**，分别是 73 秒与 130 秒；
 *   · 会议记录能对上：那两句的译文耗时 **59.2 秒 / 121.0 秒**，其余 740 次调用都在 2 秒内；
 *   · 用户看到的是"字幕卡住两三分钟，然后积压的话一股脑全出来"。
 *
 * 机制：收件箱是**串行**处理的（`pump()` 里 `await Promise.all(...)`），
 * 一句挂在等译文上，后面所有句子就全排着。所以这里钉的不是"能不能超时"，
 * 而是**超时之后有没有真的放手** —— 最容易写错的正是这一处：
 * 加了个 `Promise.race` 却 `await` 原来那个（看起来有超时，还是卡两分钟）。
 *
 * ⚠️ 不 spawn 子进程、不联网：`raceWithDeadline` 的定时器由测试自己注入，
 * 所以断言是确定的（不靠 sleep 多久刚好够）。
 */

import { backlogSnapshot, raceWithDeadline, validateConfig } from '../plugin/core.mjs'

/** 一个可控的"手动定时器"：测试自己决定什么时候到点。 */
function manualTimer() {
  const pending = []
  return {
    schedule(callback) {
      const entry = { callback, cancelled: false }
      pending.push(entry)
      return () => { entry.cancelled = true }
    },
    fireAll() {
      for (const entry of pending) {
        if (entry.cancelled !== true) entry.callback()
      }
      pending.length = 0
    },
    get count() { return pending.filter((entry) => entry.cancelled !== true).length },
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

export async function runDeadlineSuite({ it, check }) {
  console.log('\n翻译硬截止 + 积压日志（5.189）：一句卡住不许拖住整场')

  await it('按时完成：原值照常返回，定时器被取消（不留悬着的回调）', async () => {
    const timer = manualTimer()
    const value = await raceWithDeadline(Promise.resolve({ ok: true, text: '你好' }), 20000, {
      schedule: (fn, ms) => timer.schedule(fn, ms),
    })
    check('返回的是原来那个值', value.ok === true && value.text === '你好', JSON.stringify(value))
    check('完成之后定时器被取消（否则每句都留一个悬着的回调）', timer.count === 0, String(timer.count))
  })

  await it('卡住不放：到点就交还给调用方，而不是继续等', async () => {
    const timer = manualTimer()
    let settled = false
    const hanging = new Promise(() => {})          // 永不 resolve，模拟上游挂死
    const raced = raceWithDeadline(hanging, 20000, {
      schedule: (fn, ms) => timer.schedule(fn, ms),
      onTimeout: () => ({ ok: false, failure: '翻译超时' }),
    }).then((value) => { settled = true; return value })
    await tick()
    check('还没到点时不返回（不能抢跑）', settled === false)
    timer.fireAll()
    const value = await raced
    check('到点后立刻返回，并且是"超时"那条结果', value.ok === false && settled === true,
      JSON.stringify(value))
  })

  await it('迟到的译文会被丢弃，并说出晚了多久（能区分"慢"与"挂死"）', async () => {
    const timer = manualTimer()
    const late = []
    let release = null
    const slow = new Promise((resolve) => { release = resolve })
    const raced = raceWithDeadline(slow, 20000, {
      schedule: (fn, ms) => timer.schedule(fn, ms),
      onTimeout: () => ({ ok: false, failure: '翻译超时' }),
      onLate: (elapsedMs) => late.push(elapsedMs),
    })
    timer.fireAll()
    const value = await raced
    check('超时值先给出去', value.ok === false)
    release({ ok: true, translation: '迟到的译文' })  // 两分钟之后它才回来
    await tick()
    check('迟到的结果不会覆盖已经交出去的超时结果', value.ok === false && value.translation === undefined,
      JSON.stringify(value))
    check('并且会记一条"晚了多久"（onLate 只调一次）', late.length === 1 && late[0] >= 0,
      JSON.stringify(late))
  })

  await it('关掉截止（0 / 负数 / 非数字）：行为退回加这个功能之前', async () => {
    for (const ms of [0, -1, null, undefined, 'abc']) {
      const timer = manualTimer()
      const value = await raceWithDeadline(Promise.resolve({ ok: true }), ms, {
        schedule: (fn) => timer.schedule(fn),
        onTimeout: () => ({ ok: false }),
      })
      check(`${JSON.stringify(ms)} → 不设截止，等原 promise`, value.ok === true, JSON.stringify(value))
      check(`${JSON.stringify(ms)} → 不排定时器`, timer.count === 0, String(timer.count))
    }
  })

  await it('真失败照旧抛出去（超时不该把"上游报错"改成"超时"）', async () => {
    const timer = manualTimer()
    let message = ''
    try {
      await raceWithDeadline(Promise.reject(new Error('boom')), 20000, {
        schedule: (fn) => timer.schedule(fn),
      })
    } catch (error) {
      message = String(error.message)
    }
    check('原异常原样抛给调用方', message === 'boom', message)
  })

  await it('环境没有定时器时：不假装有截止（返回值仍是原 promise 的结果）', async () => {
    // 动态插件沙箱就是这种情况：`schedule` 永远返回 null。
    const value = await raceWithDeadline(Promise.resolve({ ok: true }), 20000, {
      schedule: () => null,
    })
    check('没有定时器就等同于不设截止，结果照常返回', value.ok === true, JSON.stringify(value))
  })

  await it('积压快照：排了几句、最早一句等了多久', async () => {
    const now = 1_700_000_000_000
    check('队列空 → 0 / 0', JSON.stringify(backlogSnapshot([], now)) === '{"depth":0,"waitedMs":0}',
      JSON.stringify(backlogSnapshot([], now)))
    const queue = [{ receivedAt: now - 4200 }, { receivedAt: now - 1000 }]
    const snapshot = backlogSnapshot(queue, now)
    check('两句在排，最早等 4.2 秒',
      snapshot.depth === 2 && Math.round(snapshot.waitedMs) === 4200, JSON.stringify(snapshot))
    check('没有 receivedAt 的老项不会算出 NaN',
      backlogSnapshot([{ text: 'x' }], now).waitedMs === 0,
      JSON.stringify(backlogSnapshot([{ text: 'x' }], now)))
    check('不是数组也不炸（防御性）', backlogSnapshot(null, now).depth === 0)
  })

  await it('配置校验：translateDeadlineMs 只接受不小于 0 的整数', async () => {
    const base = { inboxPath: 'C:/tmp/x.jsonl' }
    check('缺省值 20000 能过', (() => {
      try { validateConfig({ ...base, translateDeadlineMs: 20000 }); return true } catch { return false }
    })())
    check('0（关掉）也能过', (() => {
      try { validateConfig({ ...base, translateDeadlineMs: 0 }); return true } catch { return false }
    })())
    for (const bad of [-1, 1.5, 'abc', null]) {
      let message = ''
      try { validateConfig({ ...base, translateDeadlineMs: bad }) } catch (error) { message = String(error.message) }
      check(`${JSON.stringify(bad)} 被拒（否则会让人以为护栏在，其实没设上）`,
        message.includes('translateDeadlineMs'), message)
    }
  })
}
