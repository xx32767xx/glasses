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

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isSafeRoomId, memoryHint, parseArgs, pickRooms, pipelineSteps, planStop, prepareRoomFiles,
  readOpenRooms, relayStep, roomColor, roomFiles, shortRoomId, main, workerStep, describeMode, clearStaleRunState,
  chooseActiveRoom, describeSwitchReason, readRoomActivity,
  ttsStep,
  pickRoomsWithDenied, pipelineStatePath, writePipelineState, clearPipelineState,
} from '../scripts/start-multi.mjs'
import { createInterpreterSession, createRoom, joinRoom } from '../lib/rooms.mjs'
import { roomAudioPath, roomTrackDir } from '../relay/lan-relay.mjs'
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

  await it('一场会一套管线：切句跟自己的**分轨目录**、大脑写自己的总线', async () => {
    const options = parseArgs(['--data-dir', 'var/x'])
    const steps = pipelineSteps(options, { id: ROOM_A })
    assert.deepEqual(steps.map(step => step.role), ['cut', 'brain'])
    const cut = steps.find(step => step.role === 'cut')
    const brain = steps.find(step => step.role === 'brain')
    // 5.08：切句端尾随的是**这个房间的分轨目录**（每个说话人一个 pcm，各带自己的语种）
    check('切句尾随这一场自己的分轨目录',
      cut.args[cut.args.indexOf('--follow-dir') + 1] === roomFiles(options, ROOM_A).audioDir,
      cut.args.join(' '))
    check('不再尾随单个 pcm（那会让两个说话人共用一份语种）',
      cut.args.includes('--follow') === false, cut.args.join(' '))
    check('大脑的 --bus 是**这一场**的 json 文件', argsOf(brain).includes(`${ROOM_A}.json`), argsOf(brain))
    check('大脑用 --keep-inbox（清空由本脚本统一做，见 prepareRoomFiles）',
      argsOf(brain).includes('--keep-inbox'), argsOf(brain))
  })

  // 5.175：serial/parallel 已删除 —— 它们靠"每场一个 asr-bridge 尾随 audio/<房间>.pcm"，
  // 而那份混流副本不再写入（同一路音频落三份、1 GB 上限被它顶满）。
  // 现在给的是明确报错，而不是"启动成功但没有字幕"。
  await it('5.175：serial / parallel 已删除，只留队列模式（命令要明确报错）', async () => {
    assert.throws(() => parseArgs(['--data-dir', 'var/x', '--translate-mode', 'parallel']), /5\.175|queue/)
    assert.throws(() => parseArgs(['--data-dir', 'var/x', '--translate-mode', 'serial']), /5\.175|queue/)
    assert.throws(() => parseArgs(['--data-dir', 'var/x', '--parallel-translate']), /5\.175|queue/)
    assert.throws(() => parseArgs(['--data-dir', 'var/x', '--serial-translate']), /5\.175|queue/)
    check('--translate-mode queue 仍然可用',
      parseArgs(['--data-dir', 'var/x', '--translate-mode', 'queue']).translateMode === 'queue')
    const steps = pipelineSteps(parseArgs(['--data-dir', 'var/x']), { id: ROOM_A })
    check('缺省就是"切句 + 大脑"（识别是全局唯一的消费者）',
      steps.map(step => step.role).join(',') === 'cut,brain', steps.map(step => step.role).join(','))
  })

  await it('两场会的三个文件互不相同（并行的全部依据）', async () => {
    const options = parseArgs(['--data-dir', 'var/x'])
    const a = roomFiles(options, ROOM_A)
    const b = roomFiles(options, ROOM_B)
    const pairs = [['inbox', a.inbox, b.inbox], ['bus', a.busFile, b.busFile],
      ['audioDir', a.audioDir, b.audioDir]]
    for (const [what, left, right] of pairs) {
      check(`${what} 不是同一个`, left !== right, `${left} vs ${right}`)
    }
    check('收件箱在数据目录下、按房间名分文件',
      a.inbox.replace(/\\/g, '/').endsWith(`/asr-inbox-${ROOM_A}.jsonl`), a.inbox)
    check('总线在 buses 目录下、文件名就是房间 id（relay 靠它认房间）',
      a.busFile.replace(/\\/g, '/').endsWith(`/buses/${ROOM_A}.json`), a.busFile)
  })

  await it('分流音频路径与 relay 的 roomTrackDir() 完全一致（唯一来源）', async () => {
    const options = parseArgs(['--data-dir', 'var/x'])
    // 5.175：旧单文件路径（roomAudioPath）已不再写入，roomFiles 也不再带它
    check('roomFiles 不再给"旧单文件"路径', roomFiles(options, ROOM_A).audio === undefined)
    // 5.08：切句端用的是分轨目录，同样只能从 relay 那边的函数取，不许自己拼
    check('分轨目录是同一个函数算出来的',
      roomFiles(options, ROOM_A).audioDir === roomTrackDir(options.dataDir, ROOM_A),
      roomFiles(options, ROOM_A).audioDir)
    check('分轨目录是 <data-dir>/audio/<房间>',
      roomFiles(options, ROOM_A).audioDir.replace(/\\/g, '/').endsWith(`/audio/${ROOM_A}`),
      roomFiles(options, ROOM_A).audioDir)
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

  // 5.160：**用户实测踩到过这一条** —— 他把 --tts 加到自己真正在用的启动命令上，
  // 得到的是「未知选项 --tts」：5.157 只把 --tts 加进了 start-all，而生产上跑的是 start-multi。
  // 这一节把它钉住：两个脚本都必须认这个参数，而且真的把地址传给转发。
  await it('5.160：start-multi 也认 --tts，并把 --tts-url 传给转发', async () => {
    const options = parseArgs(['--tts', '--tts-voice-dir', '/opt/leion/models/piper'])
    check('--tts 被接受（不再是未知选项）', options.tts === true)
    check('默认端口 8790', options.ttsPort === 8790, String(options.ttsPort))
    check('音色目录透传', options.ttsVoiceDir === '/opt/leion/models/piper', options.ttsVoiceDir)

    const step = ttsStep(options)
    check('合成那一步是 python 脚本', step.python === true && /tts-server\.py$/.test(step.script), step.script)
    check('端口与音色目录都在参数里',
      step.args.includes('--port') && step.args.includes('8790')
      && step.args.includes('--voice-dir'))

    const relayArgs = relayStep(options).args
    check('转发拿到 --tts-url（否则它不知道合成服务在哪）',
      relayArgs.includes('--tts-url') && relayArgs.includes('http://127.0.0.1:8790'),
      relayArgs.join(' '))
    // 拼出来的参数要能被 relay 自己的 parseArgs 收下（同本套件的其它几条）
    const { parseArgs: relayParse } = await import('../relay/lan-relay.mjs')
    const parsed = relayParse(relayArgs)
    check('relay 认得 --tts-url', parsed.ttsUrl === 'http://127.0.0.1:8790', String(parsed.ttsUrl))

    // 不给 --tts 时不能凭空带上（否则没装 piper 的机器一启动就报错）
    const off = parseArgs([])
    check('没加 --tts 就不传 --tts-url',
      !relayStep(off).args.includes('--tts-url'), relayStep(off).args.join(' '))
    check('--tts-port 可改',
      parseArgs(['--tts', '--tts-port', '9911']).ttsPort === 9911)
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

  // 5.175：老的单文件尾随（--whisper-follow）已删除。切句端现在跟**分轨目录**，
  // 识别由全局唯一的 asr-worker 从队列里取段 —— 这条钉住"桥不再提供尾随文件"这件事。
  await it('5.175：asr-bridge 不再有 --whisper-follow（要用它必须报错说清楚）', async () => {
    const { parseArgs: bridgeParse } = await import('../bridge/asr-bridge.mjs')
    assert.throws(() => bridgeParse(['--inbox', 'x.jsonl', '--whisper-follow', 'audio-in.pcm']),
      /whisper-follow/)
    const options = parseArgs(['--data-dir', 'var/x'])
    const cut = pipelineSteps(options, { id: ROOM_A }).find(step => step.role === 'cut')
    check('切句跟的是分轨目录', argsOf(cut).includes('--follow-dir'), argsOf(cut))
    check('切句把段写进队列', argsOf(cut).includes('--segment-dir'), argsOf(cut))
    check('切句命令里没有任何单文件尾随', argsOf(cut).includes('--whisper-follow') === false, argsOf(cut))
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

  await it('5.175：活跃度看**分轨目录**（旧混流文件已不再写入）', async () => {
    const options = parseArgs(['--data-dir', 'var/x'])
    const activity = readRoomActivity(options, [S1, S2],
      (file) => {
        if (String(file).includes(S1)) return { size: 2048, mtimeMs: 1234 }
        throw new Error('还没有这个房间的 pcm')
      },
      (dir) => {
        if (String(dir).includes(S2)) return []
        return [
          { name: 'ana.pcm', isDirectory: () => false },
          { name: 'ana.pcm.lang', isDirectory: () => false },
          { name: 'sub', isDirectory: () => true },
        ]
      })
    check('分轨目录里的 pcm 记下大小与时间',
      activity.get(S1).bytes === 2048 && activity.get(S1).at === 1234, JSON.stringify(activity.get(S1)))
    check('空目录当成没声（at = -Infinity，比较时永远最旧）',
      activity.get(S2).at === -Infinity && activity.get(S2).bytes === 0, JSON.stringify(activity.get(S2)))
  })

  await it('只有一个模式（队列）；serial/parallel 已删除且会明确报错', async () => {
    check('缺省是队列（生产者-消费者）', parseArgs([]).translateMode === 'queue', parseArgs([]).translateMode)
    check('队列目录缺省在数据目录下',
      parseArgs([]).queueDir.endsWith(join('queue', 'asr')), parseArgs([]).queueDir)
    assert.throws(() => parseArgs(['--translate-mode', 'serial']), /5\.175|queue/)
    assert.throws(() => parseArgs(['--translate-mode', 'parallel']), /5\.175|queue/)
    assert.throws(() => parseArgs(['--serial-translate']), /5\.175|queue/)
    assert.throws(() => parseArgs(['--parallel-translate']), /5\.175|queue/)
    check('队列模式下 --max-rooms 2 允许（两场都跑，只是共用一份模型）',
      parseArgs(['--max-rooms', '2']).maxRooms === 2)
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
    check('尾随这一场自己的分轨目录（每个说话人一路）',
      cut.args[cut.args.indexOf('--follow-dir') + 1] === roomFiles(options, ROOM_A).audioDir,
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

  await it('事故回归：start-multi 传的**每一个**选项，识别进程都必须认得', async () => {
    // 真实事故（2026-11）：5.40 让 start-multi 给识别进程传 `--model-map`，但这个脚本
    // 自己的 parseArgs 不认识它 —— 于是**识别进程启动即退出**，整条链被拖停：
    //   [识别] [asr-worker] ❌ 未知选项 --model-map（用 --help 看用法）
    //   [识别] ⚠️ 识别进程退出了（code=1）… 正在停止全部进程…
    // 为什么当时的测试没抓到：那条契约测试用的是"没有策略表的目录"，于是 start-multi
    // 根本没生成 `--model-map` —— 测的是**老的 happy path**。
    // 现在改成：把各种组合都过一遍，任何"start-multi 会传、识别进程不认"的选项立刻红。
    const { parseArgs: workerParse, consumerCommand } = await import('../bridge/asr-worker.mjs')
    const combos = [
      ['--data-dir', 'var/x'],
      ['--data-dir', 'var/x', '--cpu'],
      ['--data-dir', 'var/x', '--model-map', 'config/asr-models.json'],
      ['--data-dir', 'var/x', '--model-map', 'config/asr-models.json', '--max-models', '3', '--cpu'],
      ['--data-dir', 'var/x', '--translate-mode', 'queue', '--whisper-model', 'medium'],
    // 5.70：实机按日志建议加 --silence-skip-level 时，这个脚本原来直接报「未知选项」
    ['--data-dir', 'var/x', '--model-map', 'config/asr-models.json', '--silence-skip-level', '0.008'],
    ]
    const failures = []
    for (const argv of combos) {
      const options = parseArgs(argv)
      const workerArgs = workerStep(options).args
      try {
        const parsed = workerParse(workerArgs)
        // 还要真的**透传给 python**：不认只是第一步，忘了往下传同样是"参数白给"（4.86 的教训）
        const { args: pyArgs } = consumerCommand(parsed)
        if (options.modelMap) {
          if (!pyArgs.includes('--model-map')) failures.push(`python 没收到 --model-map（${argv.join(' ')}）`)
          if (!pyArgs.includes('--max-models')) failures.push(`python 没收到 --max-models（${argv.join(' ')}）`)
        }
        if (!pyArgs.includes('--data-dir')) failures.push(`python 没收到 --data-dir（${argv.join(' ')}）`)
      } catch (error) {
        failures.push(`${argv.join(' ')} → ${error.message}`)
      }
    }
    check('所有组合都能被识别进程接受，并透传给 python', failures.length === 0, failures.join(' | '))
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
      source.indexOf('return run_queue_consumer(args, np, pool)') > source.indexOf('startup_engine.load('),
      '顺序不对')
    // 5.40：启动时加载的那份模型要**先问模型表**（表说 default 是 medium 就先加载 medium），
    // 否则会白加载一份用不上的大模型、白占几个 GB 显存。
    check('启动加载哪份模型由模型表决定（不是先按命令行加载再说）',
      source.indexOf('startup = resolve_strategy(') < source.indexOf('startup_engine.load('),
      '顺序不对：先加载后查表会白占一份显存')
  })

  await it('启动时清掉上次留下的总线/队列（否则 relay 把旧字幕当新帧重播）', async () => {
    // 真实事故（2026-10-31 用户第一份输出）：relay 目录模式下会把 buses/ 里**每个** json
    // 当成"这一场刚出的字幕"，于是上次调试留下的三份旧总线被重播成三帧定稿，
    // 还落进了 utterances（历史记录凭空多三条）。
    const base = join(VAR_DIR, 'test', 'multi-suite-stale')
    rmSync(base, { recursive: true, force: true })
    mkdirSync(join(base, 'buses'), { recursive: true })
    mkdirSync(join(base, 'queue', 'asr'), { recursive: true })
    const options = parseArgs(['--data-dir', base])
    writeFileSync(join(options.busesDir, 'room-old-1.json'), '{"lines":["旧字幕"]}', 'utf-8')
    writeFileSync(join(options.busesDir, 'room-old-2.json'), '{"lines":["更旧的字幕"]}', 'utf-8')
    writeFileSync(join(options.busesDir, 'keep-me.txt'), 'x', 'utf-8')     // 非 json 不碰
    writeFileSync(join(options.queueDir, '1700000000000-room-old-1-000.pcm'), 'x', 'utf-8')
    writeFileSync(join(options.queueDir, '1700000000000-room-old-1-000.json'), '{}', 'utf-8')

    const cleared = clearStaleRunState(options)
    check('清掉 2 份旧总线', cleared.buses === 2, String(cleared.buses))
    check('清掉 2 个队列文件（pcm + meta）', cleared.segments === 2, String(cleared.segments))
    check('目录里的 json 都没了',
      readdirSync(options.busesDir).filter(name => name.endsWith('.json')).length === 0,
      readdirSync(options.busesDir).join(','))
    check('非 json 的东西不碰（别误删别人的文件）',
      existsSync(join(options.busesDir, 'keep-me.txt')) === true)
    check('队列目录空了',
      readdirSync(options.queueDir).length === 0, readdirSync(options.queueDir).join(','))
    check('目录不存在时不报错（第一次跑）',
      clearStaleRunState(parseArgs(['--data-dir', join(base, '__nope__')])).buses === 0)
    rmSync(base, { recursive: true, force: true })
  })

  await it('收件箱里的 from 必须是语种标签（4.94：写了 zh 就翻译全废）', async () => {
    // 真实事故：队列消费者把 Whisper 码 `zh` 写成 from，插件报
    // 「目标语种无法推导，请显式传 to」——识别是好的，翻译一条都出不来。
    const { normalizeLangTag, appendInboxLine } = await import('../bridge/asr-worker.mjs')
    check('zh → zh-CN', normalizeLangTag('zh') === 'zh-CN', String(normalizeLangTag('zh')))
    check('pt → pt-BR', normalizeLangTag('pt') === 'pt-BR', String(normalizeLangTag('pt')))
    check('已经是标签就原样保留', normalizeLangTag('zh-CN') === 'zh-CN', String(normalizeLangTag('zh-CN')))
    check('认不出的不猜', normalizeLangTag('xx') === null, String(normalizeLangTag('xx')))
    check('空/非字符串不猜', normalizeLangTag('') === null && normalizeLangTag(null) === null)

    const base = join(VAR_DIR, 'test', 'multi-suite-inbox-tag')
    rmSync(base, { recursive: true, force: true })
    mkdirSync(base, { recursive: true })
    appendInboxLine(base, ROOM_A, '这句话', 'zh')
    appendInboxLine(base, ROOM_A, 'outra frase', 'pt-BR')
    // 5.08：说话人跟着这一行走（来自分轨文件名），下游据此落名字
    appendInboxLine(base, ROOM_A, 'who said it', 'en', { speaker: 'bob' })
    const lines = readFileSync(join(base, `asr-inbox-${ROOM_A}.jsonl`), 'utf-8').trim().split('\n')
    check('落盘时已经把 zh 换成 zh-CN', JSON.parse(lines[0]).from === 'zh-CN', lines[0])
    check('葡语保持不变', JSON.parse(lines[1]).from === 'pt-BR', lines[1])
    check('带 speaker 的行把它写进去（字段名叫 speakerName，不叫 speaker）',
      JSON.parse(lines[2]).speakerName === 'bob', lines[2])
    check('绝不写成 speaker（那个名字在插件里是 me/them，写了会让整行被判坏）',
      JSON.parse(lines[2]).speaker === undefined, lines[2])
    check('不说话人时不写这个字段（老链路格式不变）',
      JSON.parse(lines[0]).speaker === undefined, lines[0])
    rmSync(base, { recursive: true, force: true })
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

  await it('5.15：启动时也要清掉上一轮的"管线状态"（否则手机上挂着过期状态）', async () => {
    const base = join(VAR_DIR, 'test', 'multi-suite-stale-pipeline')
    rmSync(base, { recursive: true, force: true })
    mkdirSync(join(base, 'buses'), { recursive: true })
    mkdirSync(join(base, 'room-pipeline'), { recursive: true })
    const options = parseArgs(['--data-dir', base])
    writeFileSync(join(base, 'room-pipeline', 'room-old.json'),
      JSON.stringify({ roomId: 'room-old', state: 'denied', maxRooms: 1 }), 'utf-8')
    const cleared = clearStaleRunState(options)
    check('上一轮的状态文件被清掉', cleared.pipeline === 1 && existsSync(
      join(base, 'room-pipeline', 'room-old.json')) === false, JSON.stringify(cleared))
    rmSync(base, { recursive: true, force: true })
  })

  // ── 6. 读房间表：读不到就当"还没房间"，不能让看门人整个退出 ─────────────────

  await it('5.40：按语言选模型 —— 数据目录里有 asr-models.json 就自动传给识别进程', async () => {
    // 为什么要这条：这张表是"改一个 JSON 就能 A/B 模型"的插拔接口。
    // 如果启动脚本忘了往下传，用户改了表、盯着字幕，却永远看不出有没有生效 ——
    // 这类"参数解析了但没传下去"的 bug，这个仓库里已经有过一次（4.86 的 --bus）。
    const base = join(VAR_DIR, 'test', 'multi-suite-modelmap')
    rmSync(base, { recursive: true, force: true })
    mkdirSync(base, { recursive: true })
    writeFileSync(join(base, 'asr-models.json'), JSON.stringify({ version: 1 }), 'utf-8')

    const auto = parseArgs(['--data-dir', base])
    check('数据目录里有表 → 自动启用', auto.modelMap === join(base, 'asr-models.json'), String(auto.modelMap))
    const worker = workerStep(auto)
    check('识别进程收到 --model-map', worker.args.includes('--model-map')
      && worker.args[worker.args.indexOf('--model-map') + 1] === auto.modelMap, worker.args.join(' '))
    check('同时带上模型池上限（缺省 2）',
      worker.args.includes('--max-models') && worker.args[worker.args.indexOf('--max-models') + 1] === '2',
      worker.args.join(' '))
    // 5.41：切句进程也要拿同一张表（它只用 segmentation 那半）——只给识别不给切句，
    // 会出现"改表只影响识别、切句照旧"的半生效状态，比完全不生效更难察觉。
    const cut = pipelineSteps(auto, { id: 'room-A' }).find((step) => step.role === 'cut')
    check('切句进程也收到 --model-map（策略表两半都要生效）',
      cut.args.includes('--model-map')
      && cut.args[cut.args.indexOf('--model-map') + 1] === auto.modelMap, cut.args.join(' '))
    check('切句进程收到 --data-dir（试测/体检用；5.108 起不再用于读房间侧车）',
      cut.args.includes('--data-dir')
      && cut.args[cut.args.indexOf('--data-dir') + 1] === auto.dataDir, cut.args.join(' '))

    // ── 5.115：切句侧两个"只在电脑上调"的旋钮，必须真的传到切句进程 ────────────
    // ① idle-flush：手机上传是**断续的**（实测一批 5-6 秒、间隔到 9 秒），
    //    这个值小于上传间隔就会**在说话中间**截断句子 —— 表现是"句子很碎"。
    check('切句进程收到 --idle-flush-ms（缺省 3000，不是 2000）',
      cut.args.includes('--idle-flush-ms')
      && cut.args[cut.args.indexOf('--idle-flush-ms') + 1] === '3000', cut.args.join(' '))
    const slowerIdle = parseArgs(['--data-dir', base, '--idle-flush-ms', '5000'])
    check('--idle-flush-ms 能改，并且传下去',
      pipelineSteps(slowerIdle, { id: 'room-A' }).find((step) => step.role === 'cut')
        .args.includes('5000'), '')
    check('--idle-flush-ms 越界要报错（200~60000）', (() => {
      try {
        parseArgs(['--data-dir', base, '--idle-flush-ms', '5'])
        return false
      } catch {
        return true
      }
    })())
    // ② 固定门槛：连续说话的房间里自适应会把"人声"当噪声底，门槛顶到安全阀 →
    //    说话被当静音。那种房间要用固定门槛，所以这两项也必须能传。
    const fixedGate = parseArgs(['--data-dir', base, '--no-adaptive', '--rms-threshold', '0.03'])
    const fixedCut = pipelineSteps(fixedGate, { id: 'room-A' }).find((step) => step.role === 'cut')
    check('--no-adaptive 传给切句进程', fixedCut.args.includes('--no-adaptive'), fixedCut.args.join(' '))
    check('--rms-threshold 传给切句进程',
      fixedCut.args[fixedCut.args.indexOf('--rms-threshold') + 1] === '0.03', fixedCut.args.join(' '))
    check('不给 --no-adaptive 时不传它（保持自适应，缺省行为不变）',
      cut.args.includes('--no-adaptive') === false, cut.args.join(' '))

    const explicit = parseArgs(['--data-dir', base, '--model-map', 'config/asr-models.json', '--max-models', '3'])
    check('显式 --model-map 优先于自动发现', explicit.modelMap.endsWith(join('config', 'asr-models.json')),
      String(explicit.modelMap))
    check('--max-models 生效', workerStep(explicit).args.includes('3'), workerStep(explicit).args.join(' '))
    rmSync(join(base, 'asr-models.json'), { force: true })
    check('没有表就不传（老行为不变：一个模型服务所有语种）',
      parseArgs(['--data-dir', base]).modelMap === null)
    let rejected = ''
    try { parseArgs(['--data-dir', base, '--max-models', '0']) } catch (error) { rejected = String(error.message) }
    check('--max-models 必须是正整数', rejected.includes('正整数'), rejected)
    rmSync(base, { recursive: true, force: true })
  })

  await it('5.45：翻译官会话没人管了要自己结束（否则历史里永远"进行中"）', async () => {
    // 翻译官会话就是一条 rooms 行，只会在"手机点停止"或"管理员结束"时关。
    // App 崩了 / 被系统杀掉 / 挂着不管时：行永远是 closed_at=NULL，而它的单成员
    // 永远不离开 → 看门狗也不会收它的管线。这一档用**音频活动**当心跳兜底。
    const { idleInterpreterSessions, parseArgs: parseOwn } = await import('../scripts/start-multi.mjs')
    const now = 1_700_000_000_000
    const rooms = [
      { id: 'room-idle', kind: 'interpreter', name: '空闲的', createdAt: new Date(now - 60 * 60000).toISOString() },
      { id: 'room-busy', kind: 'interpreter', name: '在说的', createdAt: new Date(now - 60 * 60000).toISOString() },
      { id: 'room-meet', kind: 'meeting', name: '会议', createdAt: new Date(now - 600 * 60000).toISOString() },
      { id: 'room-new', kind: 'interpreter', name: '刚开的', createdAt: new Date(now - 60000).toISOString() },
    ]
    const activity = new Map([
      ['room-idle', now - 12 * 60000],   // 12 分钟没说话
      ['room-busy', now - 30 * 1000],    // 30 秒前刚说过
      ['room-meet', now - 600 * 60000],  // 会议再闲也不归这里管
    ])
    const idle = idleInterpreterSessions(rooms, (id) => activity.get(id) ?? -Infinity, now, 10 * 60000)
    check('只挑出"空闲超过阈值"的翻译官会话',
      idle.length === 1 && idle[0].id === 'room-idle', JSON.stringify(idle))
    check('刚说过话的不动（30 秒前说过）', !idle.some((one) => one.id === 'room-busy'))
    check('普通会议不归它管（有自己的"发起者退出即结束"）', !idle.some((one) => one.id === 'room-meet'))
    check('刚开还没说过话的会话不误杀（用创建时间当基线）', !idle.some((one) => one.id === 'room-new'))
    check('空闲时长写进日志给人看', idle[0].idleMinutes >= 10, String(idle[0] && idle[0].idleMinutes))

    const noActivity = idleInterpreterSessions(
      [{ id: 'room-x', kind: 'interpreter', createdAt: new Date(now - 3 * 60000).toISOString() }],
      () => -Infinity, now, 10 * 60000)
    check('完全没有音频活动时按创建时间算（3 分钟前建的不会被判空闲）', noActivity.length === 0,
      JSON.stringify(noActivity))
    check('阈值设 0 = 关闭这个兜底', idleInterpreterSessions(rooms, (id) => activity.get(id) ?? -Infinity,
      now, 0).length === 0)
    check('缺省 10 分钟 / 可配 / 0 允许', parseOwn(['--data-dir', 'var/x']).interpreterIdleMin === 10
      && parseOwn(['--data-dir', 'var/x', '--interpreter-idle-min', '3']).interpreterIdleMin === 3
      && parseOwn(['--data-dir', 'var/x', '--interpreter-idle-min', '0']).interpreterIdleMin === 0)
    let rejectedIdle = ''
    try { parseOwn(['--data-dir', 'var/x', '--interpreter-idle-min', '-1']) } catch (error) {
      rejectedIdle = String(error.message)
    }
    check('负数要被拒（不是悄悄当成 0）', rejectedIdle.includes('非负'), rejectedIdle)

    // 收尾动作必须是**真的关会话**（写 closed_at），不是只收进程
    const source = readFileSync(new URL('../scripts/start-multi.mjs', import.meta.url), 'utf-8')
    check('空闲扫描后真的调用 closeRoomByAdmin（写 closed_at）',
      /idleInterpreterSessions\(/.test(source) && /closeRoomByAdmin\(options\.dataDir/.test(source))
  })

  await it('5.46：「开着的房间 0 个 / 在翻译 1 场」不是矛盾，是宽限期', async () => {
    // 用户实测问过这句：两个数字口径不同 —— 房间数看数据库（closed_at IS NULL），
    // 在翻译看我们占着的管线（**含宽限期内还没收掉的**）。会话一关行就不在列表里了，
    // 但管线要等 --grace-ms 才收，于是出现"0 个房间 / 1 场在翻译"。
    const source = readFileSync(new URL('../scripts/start-multi.mjs', import.meta.url), 'utf-8')
    check('心跳行把"正在收尾"的场数写出来（不再让人以为看错了）',
      /宽限期后收尾/.test(source) && /已关闭/.test(source))
    check('口径来自数据库列表 vs 我们自己的 running', /const openIds = new Set\(snapshot\.rooms/.test(source))
    // 宽限期本身还是原来那条逻辑（不在本节的范围内改动）
    const { planStop } = await import('../scripts/start-multi.mjs')
    const now = 1_700_000_000_000
    const plan = planStop({ running: ['room-x'], desired: [], absentSince: new Map(), now, graceMs: 60000 })
    check('房间从列表消失后并不立刻停（先记时间，等宽限期）',
      plan.stops.length === 0 && plan.absentSince.has('room-x'), JSON.stringify(plan.stops))
    const later = planStop({ running: ['room-x'], desired: [], absentSince: plan.absentSince,
      now: now + 60001, graceMs: 60000 })
    check('过了宽限期才真收', later.stops.includes('room-x'), JSON.stringify(later.stops))
  })

  await it('库还不存在 → 当"没有房间"，不抛异常', async () => {
    const base = join(VAR_DIR, 'test', 'multi-suite-nodb')
    rmSync(base, { recursive: true, force: true })
    mkdirSync(base, { recursive: true })
    const snapshot = readOpenRooms(base)
    check('ok 且空', snapshot.ok === true && snapshot.rooms.length === 0, JSON.stringify(snapshot))
    rmSync(base, { recursive: true, force: true })
  })

  await it('5.36：翻译官会话也要被看门狗接管（路线 B 靠它起切句/识别/大脑）', async () => {
    // 翻译官会话与会议**同表**，但 `listRooms` 默认把它排除（大厅不该显示它）。
    // 路线 B 恰恰要它也有管线 —— 手机上传的音频要靠切句 → whisper → 大脑变成字幕帧。
    // 所以 `readOpenRooms` 显式传 includeInterpreter。这条钉住"别哪天又把它过滤掉"：
    // 一旦漏掉，翻译官会**安静地**只剩全局文件，手机一个字幕都收不到。
    const base = join(VAR_DIR, 'test', 'multi-suite-interp')
    rmSync(base, { recursive: true, force: true })
    mkdirSync(base, { recursive: true })
    const meeting = createRoom(base, { name: '周会', host: 'alice' })
    check('会议建成', meeting.ok === true, JSON.stringify(meeting))
    const session = createInterpreterSession(base, {
      host: 'alice', name: '和巴西同事', lang: 'zh-CN', targetLang: 'zh-CN',
    })
    check('翻译官会话建成', session.ok === true, JSON.stringify(session))
    const snapshot = readOpenRooms(base)
    check('读到了房间', snapshot.ok === true, JSON.stringify(snapshot).slice(0, 200))
    const ids = snapshot.rooms.map((room) => room.id)
    check('会议在名单里', ids.includes(meeting.room.id), JSON.stringify(ids))
    check('翻译官会话**也在**名单里', ids.includes(session.session.id), JSON.stringify(ids))
    // 起出来的那一套必须**按这一场**排：大脑的目标语言 = 我读的语言（`target_lang`），
    // 收件箱/总线/分轨目录都是这一场自己的。任一环串到别处，手机上就会看到别人的字幕。
    const steps = pipelineSteps(parseArgs(['--data-dir', 'var/x']), session.session)
    const brain = steps.find((step) => step.role === 'brain')
    check('大脑的 --to 是会话登记的目标语言', argsOf(brain).includes('--to zh-CN'), argsOf(brain))
    check('大脑的总线是这一场的文件', argsOf(brain).includes(`buses/${session.session.id}.json`)
      || argsOf(brain).includes(`buses\\${session.session.id}.json`), argsOf(brain))
    check('大脑的听众侧车路径是这一场的', argsOf(brain).includes(`${session.session.id}.json`)
      && argsOf(brain).includes('room-langs'), argsOf(brain))
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

  await it('5.15：并发上限要"拒绝得看得见"（不只是这台电脑不跑）', async () => {
    // 以前 `--max-rooms` 只是不跑超出的那几场 —— 手机上毫无提示，用户只觉得"坏了"。
    // 现在把被挡住的也返回出来，由调用方写进状态侧车，relay 再放进房间详情。
    const roomsAt = [
      { id: 'room-c1', code: '111111', name: '先来的', members: 2, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'room-c2', code: '222222', name: '第二场', members: 2, createdAt: '2026-01-02T00:00:00.000Z' },
      { id: 'room-c3', code: '333333', name: '第三场', members: 2, createdAt: '2026-01-03T00:00:00.000Z' },
    ]
    const noLimit = pickRoomsWithDenied(roomsAt, { maxRooms: 0 })
    check('不限时全都跑、没有拒绝', noLimit.run.length === 3 && noLimit.denied.length === 0,
      JSON.stringify({ run: noLimit.run.length, denied: noLimit.denied.length }))
    const limited = pickRoomsWithDenied(roomsAt, { maxRooms: 2 })
    check('上限 2 → 跑 2 场', limited.run.length === 2, String(limited.run.length))
    check('被挡住的是**最后开的那一场**（先来后到）',
      limited.denied.length === 1 && limited.denied[0].id === 'room-c3',
      JSON.stringify(limited.denied.map(room => room.id)))
    check('跑的名单与 pickRooms 完全一致（同一套排序规则）',
      JSON.stringify(limited.run.map(room => room.id))
      === JSON.stringify(pickRooms(roomsAt, { maxRooms: 2 }).map(room => room.id)))

    // 状态侧车：写 → 读 → 删
    const options = parseArgs(['--data-dir', join(VAR_DIR, 'test', 'pipeline-state')])
    check('状态文件落在 <data-dir>/room-pipeline/<房间>.json',
      pipelineStatePath(options, 'room-c3').replace(/\\/g, '/').endsWith('room-pipeline/room-c3.json'),
      pipelineStatePath(options, 'room-c3'))
    check('房间 id 会消毒（防目录穿越）',
      pipelineStatePath(options, '../../etc/passwd').replace(/\\/g, '/').includes('room-pipeline/'))
    check('写成功', writePipelineState(options, 'room-c3',
      { state: 'denied', reason: 'max-rooms', maxRooms: 2 }) === true)
    const readBack = JSON.parse(readFileSync(pipelineStatePath(options, 'room-c3'), 'utf-8'))
    check('写进去的内容是手机要看的那几项',
      readBack.state === 'denied' && readBack.reason === 'max-rooms' && readBack.maxRooms === 2,
      JSON.stringify(readBack))
    check('清掉之后文件不在了', clearPipelineState(options, 'room-c3') === true
      && existsSync(pipelineStatePath(options, 'room-c3')) === false)
    rmSync(join(VAR_DIR, 'test', 'pipeline-state'), { recursive: true, force: true })
  })

  await it('显存提醒必须看**模式**：缺省队列模式只有一份模型，不许吓唬人', async () => {
    // 现场：用户开了两场会，横幅写着「2 场会并行 = 2 份 large-v3（合计约 10.0GB）」，
    // 而队列模式（缺省）里识别只有**一个**进程，其余进程是纯 CPU 的切句。
    // 他当场反问"我看你依然起了两个模型去识别？"—— 那句话是两语/并行时代留下的，早就错了。
    const gpu = parseArgs([])                                  // cuda + large-v3，缺省 queue
    check('缺省模式就是队列', parseArgs([]).translateMode === 'queue', String(parseArgs([]).translateMode))
    check('一场会不啰嗦', memoryHint(gpu, 1) === null)
    const queueTwo = memoryHint(gpu, 2)
    check('队列模式：说清"一份模型服务多场"',
      String(queueTwo).includes('一份') && String(queueTwo).includes('切句'), String(queueTwo))
    check('队列模式：不再报"N 份 large-v3 / 合计 X GB"',
      /份 large-v3|合计约/.test(String(queueTwo)) === false, String(queueTwo))
    // 5.175：serial/parallel 已删除，所以只有队列模式这一种说法了
    check('CPU 上也一样是"一份模型"（队列模式与设备无关）',
      String(memoryHint(parseArgs(['--cpu']), 2)).includes('一份'),
      memoryHint(parseArgs(['--cpu']), 2))
    assert.throws(() => parseArgs(['--parallel-translate']), /5\.175|queue/)
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

  // 5.175：serial/parallel 模式的 dry-run 用例已随模式一起删除；
  // 这里改成钉住"旧命令会被明确拒绝"，而不是静默起一套没有字幕的管线。
  await it('5.175：旧模式命令直接报错（不会静默起一条没有字幕的管线）', async () => {
    const base = join(VAR_DIR, 'test', 'multi-suite-legacy-mode')
    rmSync(base, { recursive: true, force: true })
    mkdirSync(base, { recursive: true })
    createRoom(base, { name: '甲会议', host: 'anqi' })
    for (const flag of [['--translate-mode', 'serial'], ['--translate-mode', 'parallel'],
      ['--serial-translate'], ['--parallel-translate']]) {
      let failed = null
      try {
        await captureStdout(() => main(['--dry-run', '--quiet-logs', '--port', '18795', '--data-dir', base, ...flag]))
      } catch (error) {
        failed = error
      }
      check(`${flag.join(' ')} 被拒绝且说清原因`,
        failed !== null && /5\.175|queue/.test(String(failed.message ?? failed)), String(failed && failed.message))
    }
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

  await it('5.175：端口探测等共用动作抽到 start-helpers（不再有两份实现）', async () => {
    const source = readFileSync(new URL('../scripts/start-multi.mjs', import.meta.url), 'utf-8')
    check('从 start-helpers.mjs 借 portInUse', /from '\.\/start-helpers\.mjs'/.test(source), '没复用')
    check('没有自己再造一个探测', source.includes('SO_REUSEADDR') === false || source.includes('portInUse'), '重复实现')
    check('start-all.mjs 已删除（单管线老模式的入口不该还在）',
      existsSync(new URL('../scripts/start-all.mjs', import.meta.url)) === false)
    check('start-helpers 里也没有 start-all 的启动逻辑（只有可复用的几个动作）',
      readFileSync(new URL('../scripts/start-helpers.mjs', import.meta.url), 'utf-8').includes('async function main') === false)
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
    check('日志名带上房间 id（切句 + 大脑各一份；识别是全局唯一的那个）',
      source.includes('${roomId}-cut') && source.includes('${roomId}-brain'), '缺按房间分日志')
    check('退出时归档', source.includes('archiveSessionLogs'), '缺归档')
  })

  // 空目录兜底：测试结束把门关好（不然 var/test 里会攒一堆小目录）
  for (const name of ['multi-suite-prepare', 'multi-suite-nodb', 'multi-suite-baddb',
    'multi-suite-dryrun', 'multi-suite-dryrun-empty']) {
    rmSync(join(VAR_DIR, 'test', name), { recursive: true, force: true })
  }
}
