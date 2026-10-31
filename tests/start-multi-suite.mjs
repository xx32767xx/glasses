/**
 * start-multi-suite.mjs —— 「多场会并行一条命令」的验证
 * ============================================================================
 * 这个脚本自己不翻译任何东西，所以可测的是三件事：
 *
 *   1. **拼出来的命令对不对** —— 尤其"转发读目录、大脑写文件"这一对反向语义
 *      （搞混了不会报错，只会让两场会互相覆盖字幕 —— 静默失败里最难查的一种）；
 *   2. **调度逻辑对不对** —— 哪些房间该起管线、宽限期到没到、重试次数用没用完；
 *   3. **它没有偷偷共享可写状态** —— 这是"并行"这个承诺的全部依据：
 *      两场会的收件箱、总线、分流音频必须是三个不同的文件。
 *
 * 不 spawn 任何子进程：受限环境里管道 stdio 会被拒（EPERM），
 * 而这里的价值本来就在"拼命令 + 调度决策"，不在"真跑起来"。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isSafeRoomId, memoryHint, parseArgs, pickRooms, pipelineSteps, planStop, prepareRoomFiles,
  readOpenRooms, relayStep, roomColor, roomFiles, shortRoomId, main, workerStep, describeMode,
  chooseActiveRoom, describeSwitchReason, readRoomActivity,
} from '../scripts/start-multi.mjs'
import { createRoom, joinRoom } from '../lib/rooms.mjs'
import { roomAudioPath } from '../relay/lan-relay.mjs'
import { VAR_DIR } from '../lib/paths.mjs'

const argsOf = step => step.args.join(' ')

/** 跑一遍 main()，把 stdout 收起来（dry-run 才有意义：真跑会挂住不返回）。 */
async function captureStdout(run) {
  const chunks = []
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = chunk => { chunks.push(String(chunk)); return true }
  try {
    const code = await run()
    return { code, output: chunks.join('') }
  } finally {
    process.stdout.write = original
  }
}

export async function runStartMultiSuite({ it, check, assert }) {
  const ROOM_A = 'room-multiAAA-aaaa'
  const ROOM_B = 'room-multiBBB-bbbb'

  // ── 1. 转发进程：**一个**，且 --bus 是目录 ──────────────────────────────────

  await it('只有一个转发进程，--bus 指向<buses 目录>（多场会各一个文件，不覆盖）', async () => {
    const options = parseArgs(['--data-dir', 'var/x'])
    const relay = relayStep(options)
    check('脚本是 relay/lan-relay.mjs', relay.script.endsWith('lan-relay.mjs'), relay.script)
    const busIndex = relay.args.indexOf('--bus')
    check('带了 --bus', busIndex >= 0, argsOf(relay))
    const busValue = relay.args[busIndex + 1]
    check('--bus 是目录而不是 .json 文件（传文件 = 退回单场会模式）',
      busValue.endsWith('buses') && !busValue.endsWith('.json'), busValue)
    check('目录就在数据目录下（缺省值，不另写字面量）',
      busValue.replace(/\\/g, '/').endsWith('var/x/buses'), busValue)
    check('--buses 可以单独指定', (() => {
      const custom = parseArgs(['--buses', '/tmp/b'])
      // 路径会被 resolve 成绝对路径（相对路径一路传下去会让 relay 认错模式），所以比的是解析后的值
      return relayStep(custom).args.includes(custom.busesDir)
    })(), argsOf(relay))
  })

  await it('--public 时把加固参数一起传给转发进程（少了就是"以为配好了"）', async () => {
    const pub = relayStep(parseArgs(['--public']))
    check('带了 --public', argsOf(pub).includes('--public'), argsOf(pub))
    check('显式绑 0.0.0.0', argsOf(pub).includes('--host 0.0.0.0'), argsOf(pub))
    check('原来的参数没被挤掉',
      argsOf(pub).includes('--data-dir') && argsOf(pub).includes('--port'), argsOf(pub))
  })

  // ── 2. 每场会一套管线，而且**不共享任何可写文件** ───────────────────────────

  await it('一场会一套管线：切句跟自己的 pcm、大脑写自己的总线', async () => {
    const options = parseArgs(['--data-dir', 'var/x'])
    const steps = pipelineSteps(options, { id: ROOM_A })
    assert.deepEqual(steps.map(step => step.role), ['cut', 'brain'])
    const cut = steps.find(step => step.role === 'cut')
    const brain = steps.find(step => step.role === 'brain')
    check('切句尾随这一场自己的 pcm',
      cut.args[cut.args.indexOf('--follow') + 1] === roomFiles(options, ROOM_A).audio, cut.args.join(' '))
    check('大脑的 --bus 是**这一场**的 json 文件', argsOf(brain).includes(`${ROOM_A}.json`), argsOf(brain))
    check('大脑用 --keep-inbox（清空由本脚本统一做，见 prepareRoomFiles）',
      argsOf(brain).includes('--keep-inbox'), argsOf(brain))
  })

  await it('--translate-mode parallel：回到"每场一对识别+大脑"（显存够时才用）', async () => {
    const options = parseArgs(['--data-dir', 'var/x', '--translate-mode', 'parallel'])
    const steps = pipelineSteps(options, { id: ROOM_A })
    assert.deepEqual(steps.map(step => step.role), ['asr', 'brain'])
    const asr = steps.find(step => step.role === 'asr')
    check('识别用 --whisper-follow 跟分流音频', argsOf(asr).includes('--whisper-follow'), argsOf(asr))
    check('并且是**按房间命名**的 pcm',
      argsOf(asr).includes(`audio\\${ROOM_A}.pcm`) || argsOf(asr).includes(`audio/${ROOM_A}.pcm`), argsOf(asr))
    check('识别一律 --format json（语种跟着每句话走）', argsOf(asr).includes('--format json'), argsOf(asr))
  })

  await it('两场会的三个文件互不相同（并行的全部依据）', async () => {
    const options = parseArgs(['--data-dir', 'var/x'])
    const a = roomFiles(options, ROOM_A)
    const b = roomFiles(options, ROOM_B)
    const pairs = [['inbox', a.inbox, b.inbox], ['bus', a.busFile, b.busFile], ['audio', a.audio, b.audio]]
    for (const [what, left, right] of pairs) {
      check(`${what} 不是同一个文件`, left !== right, `${left} vs ${right}`)
    }
    check('收件箱在数据目录下、按房间名分文件',
      a.inbox.replace(/\\/g, '/').endsWith(`/asr-inbox-${ROOM_A}.jsonl`), a.inbox)
    check('总线在 buses 目录下、文件名就是房间 id（relay 靠它认房间）',
      a.busFile.replace(/\\/g, '/').endsWith(`/buses/${ROOM_A}.json`), a.busFile)
  })

  await it('分流音频路径与 relay 的 roomAudioPath() 完全一致（唯一来源，不另写一份规则）', async () => {
    const options = parseArgs(['--data-dir', 'var/x'])
    check('同一个函数算出来的',
      roomFiles(options, ROOM_A).audio === roomAudioPath(options.dataDir, ROOM_A),
      roomFiles(options, ROOM_A).audio)
  })

  // 这一条是被 harness-side 的缺省值坑过的：它的 proofread 缺省是**开**的，
  // 而 start-all 的 --proofread 缺省是关。如果这里不显式传，就会变成
  // "我明明没开校对，它却在每句之后多调一次模型"（多场并行时是成倍的浪费）。
  await it('校对开关**显式**传给大脑（harness-side 自己是缺省开着的）', async () => {
    const off = pipelineSteps(parseArgs([]), { id: ROOM_A }).find(step => step.role === 'brain')
    check('缺省带 --no-proofread', argsOf(off).includes('--no-proofread'), argsOf(off))
    check('缺省不带 --proofread', argsOf(off).includes('--proofread') === false, argsOf(off))
    const on = pipelineSteps(parseArgs(['--proofread']), { id: ROOM_A }).find(step => step.role === 'brain')
    check('开了才带 --proofread', argsOf(on).includes('--proofread'), argsOf(on))
    const offline = pipelineSteps(parseArgs(['--offline', '--terms-rescue']), { id: ROOM_A })
      .find(step => step.role === 'brain')
    check('--offline / --terms-rescue 也真的传下去',
      argsOf(offline).includes('--offline') && argsOf(offline).includes('--terms-rescue'), argsOf(offline))
  })

  await it('--no-transcriber：只起大脑（手输文字那条路不需要假起一个识别进程）', async () => {
    const steps = pipelineSteps(parseArgs(['--no-transcriber']), { id: ROOM_A })
    assert.deepEqual(steps.map(step => step.role), ['brain'])
  })

  // ── 2b. 拼出来的命令**子进程真的收得下**（否则一启动就"未知选项"退出）───────
  //
  // 这一条比"字符串里有没有 --keep-inbox"强得多：它把拼好的 args 直接喂给
  // 子进程自己的 parseArgs()。历史上这类错误出现过好几次（参数名改了、少个值、
  // 传了已经删掉的 --from/--to），现象都是"进程起来就退"，而看脚本很难发现。

  await it('转发命令能被 relay 自己的 parseArgs() 接受，且 --bus 确实是目录', async () => {
    const { parseArgs: relayParse } = await import('../relay/lan-relay.mjs')
    const options = parseArgs(['--data-dir', 'var/x', '--public'])
    const args = relayStep(options).args
    const parsed = relayParse(args)
    check('接受这些参数', parsed !== null && typeof parsed === 'object', JSON.stringify(args))
    check('数据目录对得上', parsed.dataDir === options.dataDir, `${parsed.dataDir} vs ${options.dataDir}`)
    check('--bus 就是总线目录', parsed.bus === options.busesDir, `${parsed.bus} vs ${options.busesDir}`)
    check('--public 生效', parsed.public === true, String(parsed.public))
  })

  await it('大脑命令能被 harness-side 自己的 parseArgs() 接受（--keep-inbox / --bus 都认得）', async () => {
    const { parseArgs: sideParse } = await import('../scripts/harness-side.mjs')
    const options = parseArgs(['--data-dir', 'var/x', '--proofread'])
    const brain = pipelineSteps(options, { id: ROOM_A }).find(step => step.role === 'brain')
    const parsed = sideParse(brain.args)
    check('接受这些参数', parsed !== null && typeof parsed === 'object', JSON.stringify(brain.args))
    check('--keep-inbox 生效（清空由本脚本统一做）', parsed.keepInbox === true, String(parsed.keepInbox))
    check('--bus 指向这一场的总线文件',
      parsed.bus === roomFiles(options, ROOM_A).busFile, `${parsed.bus}`)
    check('--inbox 指向这一场的收件箱',
      parsed.inbox === roomFiles(options, ROOM_A).inbox, `${parsed.inbox}`)
    check('--proofread 传到了', parsed.proofread === true, String(parsed.proofread))
  })

  await it('识别命令能被 asr-bridge 自己的 parseArgs() 接受（--whisper-follow 真的展开成尾随）', async () => {
    const { parseArgs: bridgeParse } = await import('../bridge/asr-bridge.mjs')
    const options = parseArgs(['--data-dir', 'var/x', '--translate-mode', 'parallel'])
    const asr = pipelineSteps(options, { id: ROOM_A }).find(step => step.role === 'asr')
    const parsed = bridgeParse(asr.args)
    check('接受这些参数', parsed !== null && typeof parsed === 'object', JSON.stringify(asr.args))
    check('收件箱对得上', parsed.inbox === roomFiles(options, ROOM_A).inbox, `${parsed.inbox}`)
    check('whisper-follow 变成了 whisper 引擎的命令', parsed.engine === 'whisper', String(parsed.engine))
    check('命令里尾随的是这一场的 pcm',
      String(parsed.command).includes(roomFiles(options, ROOM_A).audio), String(parsed.command))
    check('语种不写死（跟着每句话走）', parsed.command.includes('--language') === false, String(parsed.command))
  })

  // ── 3b. 串行模式：同一刻只翻一场，谁在说话就翻谁（缺省行为）──────────────────

  const S1 = 'room-serif11-aaaa'
  const S2 = 'room-serif22-bbbb'
  const serRooms = [
    { id: S1, code: '111111', name: '甲', members: 2, createdAt: '2026-01-01T00:00:00.000Z', holder: null },
    { id: S2, code: '222222', name: '乙', members: 1, createdAt: '2026-01-02T00:00:00.000Z', holder: null },
  ]

  await it('串行：一个房间都没有 → 什么都不跑', async () => {
    const choice = chooseActiveRoom({ rooms: [], running: null, activity: new Map(), now: 1000 })
    check('没有可跑的房间', choice.roomId === null, JSON.stringify(choice))
  })

  await it('串行：正在翻的那场还在说话 → 不切换（切换要重载模型，很贵）', async () => {
    const choice = chooseActiveRoom({
      rooms: serRooms,
      running: S1,
      activity: new Map([[S1, { bytes: 100, at: 5000 }], [S2, { bytes: 0, at: -Infinity }]]),
      now: 6000, idleMs: 15000, minHoldMs: 8000, runningSince: 1000,
    })
    check('保持 S1', choice.roomId === S1, JSON.stringify(choice))
    check('不切', choice.switch === false, String(choice.switch))
  })

  await it('串行：另一场说话了、这一场安静了 → 换过去', async () => {
    const choice = chooseActiveRoom({
      rooms: serRooms,
      running: S1,
      // S1 最后一声是很久以前，S2 刚刚有声音
      activity: new Map([[S1, { bytes: 100, at: 1000 }], [S2, { bytes: 50, at: 59000 }]]),
      now: 60000, idleMs: 15000, minHoldMs: 8000, runningSince: 1000,
    })
    check('换成 S2', choice.roomId === S2, JSON.stringify(choice))
    check('标了"要切"', choice.switch === true)
    check('理由说得出来', describeSwitchReason(choice.reason).includes('声音'), describeSwitchReason(choice.reason))
  })

  await it('串行：刚切过去还没待够 → 忍着不切（否则两场来回抢，一直重载模型）', async () => {
    const choice = chooseActiveRoom({
      rooms: serRooms,
      running: S1,
      activity: new Map([[S1, { bytes: 100, at: 1000 }], [S2, { bytes: 50, at: 59000 }]]),
      now: 60000, idleMs: 15000, minHoldMs: 8000, runningSince: 55000,   // 才 5 秒
    })
    check('先忍着', choice.roomId === S1, JSON.stringify(choice))
    check('不切', choice.switch === false)
  })

  await it('串行：持麦的房间优先（有人正在说话就是当下在产生内容的那一场）', async () => {
    const rooms = serRooms.map(room => ({ ...room, holder: room.id === S2 ? 'bruno' : null }))
    const choice = chooseActiveRoom({
      rooms, running: null,
      // S1 更"近"有声音，但 S2 有人拿着麦克风
      activity: new Map([[S1, { bytes: 9, at: 59000 }], [S2, { bytes: 5, at: 1000 }]]),
      now: 60000, idleMs: 15000,
    })
    check('选持麦的 S2', choice.roomId === S2, JSON.stringify(choice))
    check('理由写明是持麦', choice.reason === 'floor-holder', choice.reason)
  })

  await it('串行：两场都有人说话 → 挑声音更新的那场（必然只能服务一场，就服务更像真相的）', async () => {
    const rooms = serRooms.map(room => ({ ...room, holder: room.id === S1 ? 'anqi' : 'bruno' }))
    const choice = chooseActiveRoom({
      rooms, running: null,
      activity: new Map([[S1, { bytes: 9, at: 30000 }], [S2, { bytes: 5, at: 59000 }]]),
      now: 60000, idleMs: 15000,
    })
    check('选更近的 S2', choice.roomId === S2, JSON.stringify(choice))
    check('理由区分得开', choice.reason === 'floor-holder-busiest', choice.reason)
  })

  await it('串行：都没在说话 → 轮流（最久没被服务的先上，防止某场永远排不到）', async () => {
    const choice = chooseActiveRoom({
      rooms: serRooms, running: null, activity: new Map(), now: 60000,
      lastServedAt: new Map([[S1, 50000]]),      // S2 从来没轮到过
    })
    check('从没服务过的 S2 优先', choice.roomId === S2, JSON.stringify(choice))
    check('理由写明是轮换', choice.reason === 'round-robin', choice.reason)
    const again = chooseActiveRoom({
      rooms: serRooms, running: null, activity: new Map(), now: 70000,
      lastServedAt: new Map([[S1, 50000], [S2, 65000]]),
    })
    check('下一次轮到 S1', again.roomId === S1, JSON.stringify(again))
  })

  await it('串行：正在翻的那场散会了 → 立刻换（这条不受最小停留时间限制）', async () => {
    const choice = chooseActiveRoom({
      rooms: [serRooms[1]],                     // S1 已经不在了
      running: S1, activity: new Map(),
      now: 60000, minHoldMs: 8000, runningSince: 59000,
    })
    check('换成 S2', choice.roomId === S2, JSON.stringify(choice))
    check('标了"要切"', choice.switch === true)
  })

  await it('串行：活跃度只看文件大小（不读音频内容），拿不到就当没声', async () => {
    const options = parseArgs(['--data-dir', 'var/x'])
    const activity = readRoomActivity(options, [S1, S2], (file) => {
      if (String(file).includes(S1)) return { size: 2048, mtimeMs: 1234 }
      throw new Error('还没有这个房间的 pcm')
    })
    check('有文件的记下大小与时间',
      activity.get(S1).bytes === 2048 && activity.get(S1).at === 1234, JSON.stringify(activity.get(S1)))
    check('没文件的当成没声（at = -Infinity，比较时永远最旧）',
      activity.get(S2).at === -Infinity, String(activity.get(S2).at))
  })

  await it('串行是可选模式；缺省是队列；--max-rooms > 1 只在 serial 下报错', async () => {
    check('缺省是队列（生产者-消费者）', parseArgs([]).translateMode === 'queue', parseArgs([]).translateMode)
    check('队列目录缺省在数据目录下',
      parseArgs([]).queueDir.endsWith(join('queue', 'asr')), parseArgs([]).queueDir)
    check('--translate-mode serial 生效', parseArgs(['--translate-mode', 'serial']).translateMode === 'serial')
    check('--translate-mode parallel 生效', parseArgs(['--translate-mode', 'parallel']).translateMode === 'parallel')
    check('--serial-translate / --parallel-translate 是别名',
      parseArgs(['--serial-translate']).translateMode === 'serial'
        && parseArgs(['--parallel-translate']).translateMode === 'parallel')
    check('队列模式下 --max-rooms 2 允许（两场都跑，只是共用一份模型）',
      parseArgs(['--max-rooms', '2']).maxRooms === 2)
    assert.throws(() => parseArgs(['--translate-mode', 'serial', '--max-rooms', '2']), /serial/)
    assert.throws(() => parseArgs(['--translate-mode', 'nope']), /translate-mode/)
    assert.throws(() => parseArgs(['--switch-idle-ms', '-1']), /switch-idle-ms/)
    assert.throws(() => parseArgs(['--min-hold-ms', 'x']), /min-hold-ms/)
    assert.throws(() => parseArgs(['--depth-report-s', '-3']), /depth-report-s/)
    check('--queue-dir 会解析成绝对路径',
      /^[A-Za-z]:[\\/]|^\//.test(parseArgs(['--queue-dir', 'var/q']).queueDir),
      parseArgs(['--queue-dir', 'var/q']).queueDir)
  })

  // ── 2c. 队列模式（生产者-消费者）：切句不加载模型，识别只有一个 ─────────────

  await it('队列模式：每场一个**切句**进程，且它不加载模型', async () => {
    const options = parseArgs([])
    check('缺省就是队列模式', options.translateMode === 'queue', options.translateMode)
    const steps = pipelineSteps(options, { id: ROOM_A })
    const cut = steps.find(step => step.role === 'cut')
    check('有切句这一步', cut !== undefined, JSON.stringify(steps.map(s => s.role)))
    check('跑的是 whisper_stream.py（与识别同一份切句实现）',
      cut.script.endsWith('whisper_stream.py'), cut.script)
    check('标了 python（本脚本要用 python 起它）', cut.python === true, String(cut.python))
    check('带 --segment-dir 指向队列', cut.args.includes('--segment-dir'), cut.args.join(' '))
    check('带 --tag 房间号（消费者靠它送回正确的房间）',
      cut.args[cut.args.indexOf('--tag') + 1] === ROOM_A, cut.args.join(' '))
    check('尾随这一场自己的 pcm',
      cut.args[cut.args.indexOf('--follow') + 1] === roomFiles(options, ROOM_A).audio,
      cut.args.join(' '))
    check('命令行里**没有 --model**（切句不加载模型 = 不占显存）',
      cut.args.includes('--model') === false, cut.args.join(' '))
    check('仍然有大脑（翻译每场一个，不占显存）',
      steps.some(step => step.role === 'brain'), JSON.stringify(steps.map(s => s.role)))
  })

  await it('队列模式：识别消费者是**全局一个**，模型参数在这里', async () => {
    const options = parseArgs(['--data-dir', 'var/x'])
    const worker = workerStep(options)
    check('脚本是 bridge/asr-worker.mjs', worker.script.endsWith('asr-worker.mjs'), worker.script)
    check('--queue-dir 指向队列', worker.args[worker.args.indexOf('--queue-dir') + 1] === options.queueDir,
      worker.args.join(' '))
    check('--inbox-dir 指向数据目录（收件箱按房间分文件放在这里）',
      worker.args[worker.args.indexOf('--inbox-dir') + 1] === options.dataDir, worker.args.join(' '))
    check('模型/设备/精度在这里（只有这一个进程加载模型）',
      worker.args.includes('--model') && worker.args.includes('--device')
        && worker.args.includes('--compute-type'), worker.args.join(' '))
    check('--keep-inbox：清空由 start-multi 按房间做',
      worker.args.includes('--keep-inbox'), worker.args.join(' '))
  })

  await it('队列模式的参数能被 asr-worker 自己的 parseArgs() 接受', async () => {
    const { parseArgs: workerParse } = await import('../bridge/asr-worker.mjs')
    const options = parseArgs(['--data-dir', 'var/x', '--cpu'])      // start-multi 用 --cpu 表示 CPU
    const parsed = workerParse(workerStep(options).args)
    check('接受这些参数', parsed !== null && typeof parsed === 'object')
    check('队列目录对得上', parsed.queueDir === options.queueDir, String(parsed.queueDir))
    check('收件箱目录对得上', parsed.inboxDir === options.dataDir, String(parsed.inboxDir))
    check('CPU 时精度自动变 int8（不是照抄 float16）', parsed.computeType === 'int8', parsed.computeType)
    check('keep-inbox 生效', parsed.keepInbox === true, String(parsed.keepInbox))
  })

  await it('python 切句端真的认这些参数（源码里三个都要在）', async () => {
    const source = readFileSync(new URL('../bridge/whisper_stream.py', import.meta.url), 'utf-8')
    for (const flag of ['--segment-dir', '--queue-dir', '--tag']) {
      check(`whisper_stream.py 定义了 ${flag}`, source.includes(`"${flag}"`), flag)
    }
    check('生产者不构造 WhisperModel（在 run_segment_producer 里）',
      /def run_segment_producer/.test(source)
        && /return run_segment_producer\(args, np\)/.test(source), '缺生产者分支')
    check('消费者在模型加载**之后**才进入（首段不再付预热的十几秒）',
      source.indexOf('return run_queue_consumer(args, np, model)') > source.indexOf('WhisperModel(args.model'),
      '顺序不对')
  })

  // ── 3. 房间调度：哪些该跑、哪些该收 ────────────────────────────────────────

  const rooms = [
    { id: ROOM_A, code: '111111', name: '甲', members: 2, createdAt: '2026-01-01T00:00:00.000Z' },
    { id: ROOM_B, code: '222222', name: '乙', members: 1, createdAt: '2026-01-02T00:00:00.000Z' },
    { id: 'room-empty-cccc', code: '333333', name: '空的', members: 0, createdAt: '2026-01-03T00:00:00.000Z' },
  ]

  await it('缺省只跑"有人在"的房间（空房间白占一份模型）', async () => {
    const picked = pickRooms(rooms, {})
    assert.deepEqual(picked.map(room => room.id), [ROOM_A, ROOM_B])
    const withEmpty = pickRooms(rooms, { includeEmpty: true })
    check('--include-empty 才带上空房间', withEmpty.length === 3, String(withEmpty.length))
  })

  await it('按建房时间从早到晚排（--max-rooms 切掉的应是最后开的那场）', async () => {
    const picked = pickRooms(rooms, { maxRooms: 1 })
    check('留下的是最早那场', picked.length === 1 && picked[0].id === ROOM_A, JSON.stringify(picked))
    const unsorted = [{ id: 'room-z-zzzz' + 'z', members: 1, createdAt: '2026-02-01T00:00:00.000Z' },
      { id: 'room-a-aaaa', members: 1, createdAt: '2026-01-01T00:00:00.000Z' }]
    check('输入顺序不影响结果',
      pickRooms(unsorted, {}).map(room => room.id)[0] === 'room-a-aaaa',
      JSON.stringify(pickRooms(unsorted, {})))
  })

  await it('--only 只跑点名的房间', async () => {
    const picked = pickRooms(rooms, { only: [ROOM_B] })
    check('只剩一个', picked.length === 1 && picked[0].id === ROOM_B, JSON.stringify(picked))
    check('点名一个不存在的 → 空（不报错，等它出现就行）', pickRooms(rooms, { only: ['room-nope-xxxx'] }).length === 0)
  })

  // 房间 id 会直接当**文件名**用（relay 靠文件名认房间）。消毒后硬起会让字幕
  // 被归到一个不存在的房间 —— 有翻译、但一条都不落到这场会里，比不起更糟。
  await it('名字不能原样当文件名的房间**不硬起**（消毒会归错房间）', async () => {
    const weird = [{ id: '../etc/passwd', members: 1, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'has space', members: 1, createdAt: '2026-01-02T00:00:00.000Z' },
      { id: ROOM_A, members: 1, createdAt: '2026-01-03T00:00:00.000Z' }]
    const picked = pickRooms(weird, {})
    check('只留下合规的那个', picked.length === 1 && picked[0].id === ROOM_A, JSON.stringify(picked.map(r => r.id)))
    check('isSafeRoomId 认得出目录穿越', isSafeRoomId('../etc/passwd') === false)
    check('正常 id 通过', isSafeRoomId(ROOM_A) === true)
  })

  // ── 4. 宽限期：退出去看一眼消息不该把管线杀掉 ──────────────────────────────

  await it('房间从名单里消失 → 先记时间，宽限期内**不收**', async () => {
    const first = planStop({ running: [ROOM_A], desired: [], absentSince: new Map(), now: 1000, graceMs: 60000 })
    check('这一轮不收', first.stops.length === 0, JSON.stringify(first.stops))
    check('记下了"什么时候开始不在"', first.absentSince.get(ROOM_A) === 1000, String(first.absentSince.get(ROOM_A)))
    const later = planStop({ running: [ROOM_A], desired: [], absentSince: first.absentSince, now: 30000, graceMs: 60000 })
    check('30 秒时还不收', later.stops.length === 0, JSON.stringify(later.stops))
    const timeout = planStop({ running: [ROOM_A], desired: [], absentSince: later.absentSince, now: 61000, graceMs: 60000 })
    check('过了宽限期才收', timeout.stops.length === 1 && timeout.stops[0] === ROOM_A, JSON.stringify(timeout.stops))
  })

  await it('中途又出现了 → 计时清掉（他就回来了，不该被收）', async () => {
    const first = planStop({ running: [ROOM_A], desired: [], absentSince: new Map(), now: 1000, graceMs: 60000 })
    const back = planStop({ running: [ROOM_A], desired: [ROOM_A], absentSince: first.absentSince, now: 2000, graceMs: 60000 })
    check('不收', back.stops.length === 0)
    check('不再记着"它不在"', back.absentSince.has(ROOM_A) === false, JSON.stringify([...back.absentSince.keys()]))
  })

  await it('已经收掉的房间不留在记账本里（否则内存一直长）', async () => {
    const plan = planStop({
      running: [], desired: [], absentSince: new Map([[ROOM_A, 1]]), now: 999999, graceMs: 0,
    })
    check('清掉了', plan.absentSince.size === 0, JSON.stringify([...plan.absentSince.keys()]))
  })

  // ── 5. 起管线前把文件清干净（同名房间的旧内容会变成"莫名其妙的旧字幕"）──────

  await it('起之前清空收件箱、删掉旧总线文件', async () => {
    const base = join(VAR_DIR, 'test', 'multi-suite-prepare')
    rmSync(base, { recursive: true, force: true })
    mkdirSync(join(base, 'buses'), { recursive: true })
    const options = parseArgs(['--data-dir', base])
    const files = roomFiles(options, ROOM_A)
    writeFileSync(files.inbox, '{"text":"上次留下的旧句子"}\n', 'utf-8')
    writeFileSync(files.busFile, '{"lines":["旧字幕"]}', 'utf-8')
    prepareRoomFiles(files)
    check('收件箱空了', readFileSync(files.inbox, 'utf-8') === '', readFileSync(files.inbox, 'utf-8'))
    check('旧总线文件被删了（否则 relay 一启动就把它推给这场会）', existsSync(files.busFile) === false)
    prepareRoomFiles(files)          // 幂等：不存在的文件不该报错
    check('再清一次也不炸', existsSync(files.busFile) === false)
    rmSync(base, { recursive: true, force: true })
  })

  // ── 6. 读房间表：读不到就当"还没房间"，不能让看门人整个退出 ─────────────────

  await it('库还不存在 → 当"没有房间"，不抛异常', async () => {
    const base = join(VAR_DIR, 'test', 'multi-suite-nodb')
    rmSync(base, { recursive: true, force: true })
    mkdirSync(base, { recursive: true })
    const snapshot = readOpenRooms(base)
    check('ok 且空', snapshot.ok === true && snapshot.rooms.length === 0, JSON.stringify(snapshot))
    rmSync(base, { recursive: true, force: true })
  })

  await it('库是坏的 → 返回 ok:false 与原因（而不是把栈抛给调用方）', async () => {
    const base = join(VAR_DIR, 'test', 'multi-suite-baddb')
    rmSync(base, { recursive: true, force: true })
    mkdirSync(base, { recursive: true })
    writeFileSync(join(base, 'leion.db'), '这不是一个 sqlite 库'.repeat(50), 'utf-8')
    const snapshot = readOpenRooms(base)
    check('ok:false', snapshot.ok === false, JSON.stringify(snapshot).slice(0, 200))
    check('带上了原因', typeof snapshot.error === 'string' && snapshot.error !== '', String(snapshot.error))
    rmSync(base, { recursive: true, force: true })
  })

  // ── 7. 显存提醒与参数校验 ──────────────────────────────────────────────────

  await it('显存提醒只在真会出问题时出现，而且说得具体', async () => {
    const gpu = parseArgs([])                                  // cuda + large-v3
    check('一场会不啰嗦', memoryHint(gpu, 1) === null)
    const two = memoryHint(gpu, 2)
    check('两场会就提醒', typeof two === 'string' && two.includes('large-v3'), String(two))
    check('给出可操作的三个办法',
      /--whisper-model|--compute|--max-rooms/.test(String(two)), String(two))
    check('CPU 上是另一种说法（没有显存这回事）',
      memoryHint(parseArgs(['--cpu']), 2).includes('CPU'), memoryHint(parseArgs(['--cpu']), 2))
  })

  await it('参数校验：拼错了立刻报错，而不是起一半', async () => {
    assert.throws(() => parseArgs(['--poll-ms', 'abc']), /poll-ms/)
    assert.throws(() => parseArgs(['--poll-ms', '0']), /poll-ms/)
    assert.throws(() => parseArgs(['--grace-ms', '-1']), /grace-ms/)
    assert.throws(() => parseArgs(['--max-rooms', '-2']), /max-rooms/)
    assert.throws(() => parseArgs(['--compute', 'float64']), /compute/)
    assert.throws(() => parseArgs(['--only', '../x']), /房间 id/)
    assert.throws(() => parseArgs(['--nope']), /未知选项/)
    assert.throws(() => parseArgs(['--port']), /需要一个值/)
    check('--cpu 会同时把精度换成 int8', parseArgs(['--cpu']).computeType === 'int8', parseArgs(['--cpu']).computeType)
    check('缺省端口 8788（和手机/文档一致）', parseArgs([]).port === 8788, String(parseArgs([]).port))
    check('缺省总线目录在数据目录下', parseArgs([]).busesDir.endsWith('buses'), parseArgs([]).busesDir)
  })

  await it('房间 id 的短名字与颜色：同一场会永远同一个颜色', async () => {
    const shortA = shortRoomId(ROOM_A)
    check('短名字比完整 id 短，且是它的尾巴（还能对得上）',
      shortA.length < ROOM_A.length && ROOM_A.endsWith(shortA), shortA)
    const colors = new Set([ROOM_A, ROOM_B].map(roomColor))
    check('颜色是 ANSI 转义', [...colors].every(color => color.startsWith('\x1b[')), [...colors].join(','))
    check('两次调用同一场会颜色不变', roomColor(ROOM_A) === roomColor(ROOM_A))
  })

  // ── 8. 真跑一遍 --dry-run（走完整个启动前逻辑）──────────────────────────────

  await it('--dry-run（缺省队列）：每场一套「切句+大脑」，识别只有一个', async () => {
    const base = join(VAR_DIR, 'test', 'multi-suite-dryrun')
    rmSync(base, { recursive: true, force: true })
    mkdirSync(base, { recursive: true })
    const first = createRoom(base, { name: '甲会议', host: 'anqi' })
    const second = createRoom(base, { name: '乙会议', host: 'bruno' })
    joinRoom(base, { roomId: second.room.id, username: 'carla' })

    const { code, output } = await captureStdout(() => main(['--dry-run', '--quiet-logs',
      '--port', '18797', '--data-dir', base]))
    check('退出码 0', code === 0, String(code))
    check('印了转发进程', output.includes('lan-relay.mjs'), output.slice(0, 400))
    check('印了唯一的识别消费者（队列模式）', output.includes('asr-worker.mjs'), output.slice(0, 900))
    check('横幅说清是队列模式', output.includes('队列'), output.slice(0, 900))
    check('**两场**各起一套（队列模式不需要牺牲一场）', output.includes('现在会起 2 套管线'), output.slice(-1400))
    check('两场会都在里面',
      output.includes(first.room.id) && output.includes(second.room.id), output.slice(-1400))
    check('每场都有切句（--segment-dir / --tag）',
      (output.match(/--segment-dir/g) ?? []).length >= 2 && (output.match(/--tag room-/g) ?? []).length >= 2,
      output.slice(-1500))
    check('切句**不加载模型**（命令行里没有 --model）',
      /切句·\S+\s+\S+whisper_stream\.py[^\n]*--model/.test(output) === false, output.slice(-1500))
    check('每场都有大脑（--bus 各一份）', (output.match(/--bus /g) ?? []).length >= 2, output.slice(-1500))
    check('说明了积压只报不丢', output.includes('不丢数据') || output.includes('不丢'), output.slice(0, 1200))
    check('没有建 buses/queue 目录（dry-run 不留副作用）',
      existsSync(join(base, 'buses')) === false && existsSync(join(base, 'queue')) === false)
    rmSync(base, { recursive: true, force: true })
  })

  await it('--dry-run --translate-mode serial：只起 1 套，另一场标"排队中"', async () => {
    const base = join(VAR_DIR, 'test', 'multi-suite-dryrun-serial')
    rmSync(base, { recursive: true, force: true })
    mkdirSync(base, { recursive: true })
    const first = createRoom(base, { name: '甲会议', host: 'anqi' })
    const second = createRoom(base, { name: '乙会议', host: 'bruno' })
    joinRoom(base, { roomId: second.room.id, username: 'carla' })

    const { code, output } = await captureStdout(() => main(['--dry-run', '--quiet-logs',
      '--translate-mode', 'serial', '--port', '18795', '--data-dir', base]))
    check('退出码 0', code === 0, String(code))
    check('只起 1 套管线', output.includes('现在会起 1 套管线'), output.slice(-1200))
    check('另一场标了排队中', output.includes('排队中') && output.includes(second.room.id), output.slice(-1200))
    check('真起的那一套是最早建的那场', output.includes(first.room.id), output.slice(-1200))
    check('串行模式不出"几份模型"的账', output.includes('2 场会并行') === false, output.slice(-600))
    rmSync(base, { recursive: true, force: true })
  })

  await it('--dry-run --translate-mode parallel：两套都起，并给出显存账', async () => {
    const base = join(VAR_DIR, 'test', 'multi-suite-dryrun-par')
    rmSync(base, { recursive: true, force: true })
    mkdirSync(base, { recursive: true })
    const first = createRoom(base, { name: '甲会议', host: 'anqi' })
    const second = createRoom(base, { name: '乙会议', host: 'bruno' })
    joinRoom(base, { roomId: second.room.id, username: 'carla' })

    const { code, output } = await captureStdout(() => main(['--dry-run', '--quiet-logs',
      '--translate-mode', 'parallel', '--port', '18796', '--data-dir', base]))
    check('退出码 0', code === 0, String(code))
    check('两套管线都起', output.includes('现在会起 2 套管线'), output.slice(-1200))
    check('每场会都用识别桥（--whisper-follow）',
      (output.match(/--whisper-follow/g) ?? []).length >= 2, output.slice(-1500))
    check('提醒了显存怎么算', output.includes('显存'), output.slice(-800))
    rmSync(base, { recursive: true, force: true })
  })

  await it('--dry-run：一个房间都没有时说得清楚（不是静默什么都不做）', async () => {
    const base = join(VAR_DIR, 'test', 'multi-suite-dryrun-empty')
    rmSync(base, { recursive: true, force: true })
    mkdirSync(base, { recursive: true })
    const { code, output } = await captureStdout(() => main(['--dry-run', '--quiet-logs',
      '--port', '18798', '--data-dir', base]))
    check('退出码 0', code === 0, String(code))
    check('说"没有开着且有人"的房间', output.includes('没有'), output.slice(-600))
    rmSync(base, { recursive: true, force: true })
  })

  await it('子进程脚本必须"被 import 时不启动"（裸 await main() 会让测试永远挂住）', async () => {
    // 真实事故（2026-10-30）：harness-side.mjs 末尾是裸的 `await main()`，
    // 于是上面那条"把参数喂给它的 parseArgs()"的测试一 import 就**起了个常驻大脑**，
    // 全量验证卡死十几分钟、一个字都不输出（进程一直活着，报告没机会打印）。
    // 这条门禁钉的是"能 import"这件事本身 —— 它对测试、对别的脚本复用都必需。
    for (const [label, file] of [
      ['harness-side.mjs', '../scripts/harness-side.mjs'],
      ['start-all.mjs', '../scripts/start-all.mjs'],
      ['start-multi.mjs', '../scripts/start-multi.mjs'],
      ['asr-bridge.mjs', '../bridge/asr-bridge.mjs'],
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf-8')
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
        .filter(line => line.trim().startsWith('//') === false).join('\n')
      // 两种写法都算合格：`const isCli = …` + `if (isCli)`，或把条件直接写在 if 里。
      // 只认"有没有这个条件"，不规定必须抽变量 —— 规定写法的门禁只会让人为了过闸去改代码。
      const guarded = /import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/.test(code)
        && /(const isCli = |if \(process\.argv\[1\] !== undefined && import\.meta\.url)/.test(code)
      check(`${label} 有 CLI 守卫（import 时不启动）`, guarded,
        '缺 import.meta.url === pathToFileURL(process.argv[1]).href 这个条件')
      check(`${label} 没有裸的顶层 await main()`,
        /^\s*await main\(\)\s*$/m.test(code.split('pathToFileURL(process.argv[1])')[0]) === false,
        '文件主体里有裸 await main()')
    }
  })

  // ── 9. 源码层面的两件事实 ──────────────────────────────────────────────────

  await it('复用 start-all 的端口探测（那个 SO_REUSEADDR 的坑不能再踩一遍）', async () => {
    const source = readFileSync(new URL('../scripts/start-multi.mjs', import.meta.url), 'utf-8')
    check('从 start-all.mjs 借 portInUse', /from '\.\/start-all\.mjs'/.test(source), '没复用')
    check('没有自己再造一个探测', source.includes('SO_REUSEADDR') === false || source.includes('portInUse'), '重复实现')
    check('说明了它不是 start-all 的替代', source.includes('start-all'), '缺与 start-all 的分工说明')
  })

  await it('帮助文本交代了边界（老同传 App 不走这条路 / 术语快照是全局一份）', async () => {
    const source = readFileSync(new URL('../scripts/start-multi.mjs', import.meta.url), 'utf-8')
    check('提到老同传 App 不带 room=', /不带 room=/.test(source), '缺这条边界')
    check('提到术语快照是全局一份', /全局一份/.test(source), '缺术语快照的边界')
    check('说明 Ctrl-C 会连孙进程一起收', source.includes('孙进程'), '缺孙进程说明')
    check('说明房间是手机决定的（所以要看门人而不是写死）', source.includes('房间是手机决定的'), '缺这条')
  })

  await it('日志按"转发 + 每场会两条"分文件（一场会出问题时不会淹掉别的）', async () => {
    const source = readFileSync(new URL('../scripts/start-multi.mjs', import.meta.url), 'utf-8')
    check('日志名带上房间 id', source.includes('${roomId}-asr') && source.includes('${roomId}-brain'), '缺按房间分日志')
    check('退出时归档', source.includes('archiveSessionLogs'), '缺归档')
  })

  // 空目录兜底：测试结束把门关好（不然 var/test 里会攒一堆小目录）
  for (const name of ['multi-suite-prepare', 'multi-suite-nodb', 'multi-suite-baddb',
    'multi-suite-dryrun', 'multi-suite-dryrun-empty']) {
    rmSync(join(VAR_DIR, 'test', name), { recursive: true, force: true })
  }
}
