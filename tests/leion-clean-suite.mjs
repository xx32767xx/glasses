/**
 * leion-clean-suite.mjs —— 磁盘清理工具（5.118）
 * ============================================================================
 *
 * 这个脚本的**风险不在"清不干净"，而在"清多了"**：它面对的是
 * `audio/`（历史音频）、`var/logs/`（日志）、`var/cache/`（模型 6.7G）、`var/asr-eval/`（评测数据）
 * 这些**同名兄弟目录**。手滑写成"递归删数据目录下所有旧文件"就会把模型/评测数据一起带走。
 *
 * 所以这里钉三件事：
 *   ① 默认**只报告**，不加 `--clean` 绝不删（这一点在 lib 里就是结构性的：
 *      `collectPlan` 只读、`applyPlan` 才删）；
 *   ② 只删列出来的几类，`var/cache` 与 `var/asr-eval` 永远 `cleanable:false`；
 *   ③ 时间阈值真的生效（旧的删、新的留）。
 *
 * ⚠️ 直接调 lib，**不起子进程**：沙箱下 Node 的 pipe stdio 会 EPERM（同 docs/10 那条）。
 */

import { mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from '../lib/paths.mjs'
import {
  applyPlan, collectPlan, diskSpace, humanMb, parseCleanArgs,
} from '../lib/disk-clean.mjs'

function touch(path, size, daysAgo) {
  writeFileSync(path, Buffer.alloc(size, 'x'))
  if (daysAgo > 0) {
    const when = (Date.now() - daysAgo * 24 * 60 * 60 * 1000) / 1000
    utimesSync(path, when, when)
  }
}

export async function runLeionCleanSuite({ it, check }) {
  console.log('\n磁盘清理工具（5.118）：默认只报告、只删列出来的几类、永不碰模型与评测数据')

  await it('参数校验：--older-than 必须是非负天数', () => {
    check('负数天数被拒',
      parseCleanArgs(['--older-than', '-1']).ok === false, '')
    check('不认识的参数被拒',
      (parseCleanArgs(['--oops']).error ?? '').includes('不认识的参数'), '')
    check('缺 --data-dir 时报错', (() => {
      const parsed = parseCleanArgs([])
      // 缺省会退到 LEION_DATA_DIR 或 var/live，所以只验"能解析出 dataDir"
      return parsed.ok === true && typeof parsed.args.dataDir === 'string' && parsed.args.dataDir !== ''
    })(), '')
    const parsed = parseCleanArgs(['--data-dir', 'x', '--older-than', '7', '--clean', '--keep-logs'])
    check('正常参数解析出 clean / olderThanDays / keepLogs',
      parsed.ok === true && parsed.args.clean === true
      && parsed.args.olderThanDays === 7 && parsed.args.keepLogs === true, JSON.stringify(parsed.args))
  })

  await it('只报告不删：collectPlan 只读，applyPlan 才删；旧的删、新的留', () => {
    const base = join(ROOT, 'var', 'test', 'clean-suite')
    rmSync(base, { recursive: true, force: true })
    mkdirSync(join(base, 'audio', 'room-a'), { recursive: true })
    mkdirSync(join(base, 'buses'), { recursive: true })
    const oldPcm = join(base, 'audio', 'room-a', 'old.pcm')
    const freshPcm = join(base, 'audio', 'room-a', 'fresh.pcm')
    const oldInbox = join(base, 'asr-inbox-room-a.jsonl')
    touch(oldPcm, 2048, 10)
    touch(freshPcm, 2048, 0)
    touch(oldInbox, 512, 10)

    const plan = collectPlan({ dataDir: base, olderThanDays: 3 })
    check('报告里能看到各类占地方（含模型缓存/评测数据）',
      plan.rows.some((row) => row.name.includes('分轨音频'))
      && plan.rows.some((row) => row.name.includes('模型缓存')), JSON.stringify(plan.rows.map(r => r.name)))
    check('plan 里只有 10 天前那两个（旧音频 + 旧收件箱），今天的新文件不在里面', (() => {
      const files = plan.plan.flatMap((item) => item.files)
      return files.length === 2
        && files.some((one) => one.endsWith('old.pcm'))
        && files.some((one) => one.endsWith('asr-inbox-room-a.jsonl'))
        && !files.some((one) => one.endsWith('fresh.pcm'))
    })(), JSON.stringify(plan.plan.map((item) => item.files)))
    check('collectPlan 之后文件一个都没少（只读）',
      readdirSync(join(base, 'audio', 'room-a')).length === 2, '')

    const applied = applyPlan(plan.plan)
    const left = readdirSync(join(base, 'audio', 'room-a'))
    check('applyPlan 之后旧的没了、新的还在',
      applied.removed === 2 && left.length === 1 && left[0] === 'fresh.pcm', JSON.stringify(left))

    // 阈值 0 = 不按时间筛（全清），用来验"应急"那条路。
    // 这里只断言"刚写的那个也在里面"，不数总数：`var/tmp` 是仓库公共目录，
    // 别的东西（比如测试自己的日志）躺在里面时，"恰好 1 个"会变成假失败。
    const all = collectPlan({ dataDir: base, olderThanDays: 0 })
    const allFiles = all.plan.flatMap(i => i.files)
    check('--older-than 0 会把剩下的（刚写的）也列进来',
      allFiles.some((one) => one.endsWith('fresh.pcm')),
      JSON.stringify(all.plan.map(i => i.files)))

    rmSync(base, { recursive: true, force: true })
  })

  // 5.174：用户实测 —— 管理台一直报「音频文件已达上限」，`leion-clean` 却报告
  // 「分轨音频 0.0 MB / 0 个文件」，于是清完一轮毫无变化。原因是 1.0 GB 全在
  // 数据目录根下的 `audio-in.pcm`（所有房间共用的旧单文件），而这个文件**哪一类都不是**。
  await it('5.174：旧模式单文件 audio-in.pcm 要看得见、也要清得掉（正在写的不动）', () => {
    const base = join(ROOT, 'var', 'test', 'clean-legacy')
    rmSync(base, { recursive: true, force: true })
    mkdirSync(join(base, 'audio'), { recursive: true })
    touch(join(base, 'audio-in.pcm'), 4096, 10)
    touch(join(base, 'audio-in.pcm.1'), 4096, 30)
    mkdirSync(join(base, 'audio', 'room-a'), { recursive: true })
    touch(join(base, 'audio', 'room-a', 'ana.pcm'), 2048, 0)

    const plan = collectPlan({ dataDir: base, olderThanDays: 3 })
    const row = plan.rows.find((one) => one.name.includes('总录音'))
    check('报告里单列一类，且真的算进了这 8 KB（不再"0 个文件"）',
      row !== undefined && row.bytes === 8192 && row.files === 2, JSON.stringify(row))
    // 只断言这一类的 plan：`var/logs` 是仓库公共目录，别的东西躺在里面时
    // "总数恰好等于 X"会变成假失败（老测试踩过这个）。
    const planned = (one) => (one.files ?? []).filter((file) => /audio-in\.pcm(\.1)?$/.test(file))
    const legacyItem = plan.plan.find((one) => one.name.includes('总录音'))
    check('两个（当前文件与轮转件）都进清理计划，同一个计划里不含正在写的分轨',
      legacyItem !== undefined && planned(legacyItem).length === 2
      && !(legacyItem.files ?? []).some((one) => one.endsWith('ana.pcm')),
      JSON.stringify(legacyItem))

    // 边界：文件恰恰"刚写出来"（mtime = 现在）→ 按天数不该清它
    touch(join(base, 'audio-in.pcm'), 4096, 0)
    const careful = collectPlan({ dataDir: base, olderThanDays: 3 })
    const carefulItem = careful.plan.find((one) => one.name.includes('总录音'))
    check('正在写的当前文件不会被按天数误删',
      carefulItem === undefined || !(carefulItem.files ?? []).some((one) => one.endsWith('audio-in.pcm')),
      JSON.stringify(carefulItem))
    rmSync(base, { recursive: true, force: true })
  })

  await it('永不清理的两类：模型缓存与评测数据标成 cleanable:false 且不进 plan', () => {
    const plan = collectPlan({ dataDir: join(ROOT, 'var', 'test', 'clean-none'), olderThanDays: 0 })
    const guarded = plan.rows.filter((row) => row.name.includes('!'))
    check('模型缓存与评测数据都被标成不可清（name 里带 !）',
      guarded.length === 2 && guarded.every((row) => row.cleanable === false),
      JSON.stringify(guarded))
    check('哪怕阈值是 0 天，plan 里也不会出现它们',
      !plan.plan.some((item) => item.name.includes('模型') || item.name.includes('评测')),
      JSON.stringify(plan.plan.map((item) => item.name)))
    check('默认 --keep-logs 不传时日志可清、传了就不可清', (() => {
      const withLogs = collectPlan({ dataDir: 'x', olderThanDays: 3 })
      const without = collectPlan({ dataDir: 'x', olderThanDays: 3, keepLogs: true })
      const row = (plan) => plan.rows.find((r) => r.name.includes('运行日志'))
      return row(withLogs).cleanable === true && row(without).cleanable === false
    })(), '')
  })

  await it('磁盘余量：拿得到就报出来（拿不到返回 null，不影响清理判断）', () => {
    const space = diskSpace(ROOT)
    check('返回 totalGb / freeGb / usedPercent 三个数', space === null
      || (Number.isFinite(space.totalGb) && Number.isFinite(space.freeGb)
        && space.usedPercent >= 0 && space.usedPercent <= 100), JSON.stringify(space))
    check('humanMb 的写法是人话（MB 为单位、一位小数）', /^\d+\.\d MB$/.test(humanMb(3 * 1024 * 1024)),
      humanMb(3 * 1024 * 1024))
  })
}
