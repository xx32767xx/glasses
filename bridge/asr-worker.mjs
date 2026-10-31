/**
 * asr-worker.mjs —— 唯一的识别消费者：一份模型，服务所有房间
 * ============================================================================
 *   node bridge/asr-worker.mjs --queue-dir var/live/queue/asr
 *
 * 它解决的问题（2026-10-30，按显存现状定的架构）：
 *
 *   一场会一套「切句 + 识别」= 一份 whisper 模型（large-v3 float16 约 5GB）。
 *   两场会同时开就要两份 —— 显存不够，而现象是"识别挂了"，比报"显存不足"难查得多。
 *
 *   所以把链路拆成两段：
 *
 *     [切句·房间A] ─┐                      ← 每场一个，纯 CPU，**不加载模型**
 *     [切句·房间B] ─┴─▶ queue/asr/*.pcm    ← 队列：一段话一个文件，按到达顺序
 *                              │
 *                              ▼
 *                       [识别·唯一]         ← 本脚本：模型只加载一次
 *                              │ 每行带 room
 *                              ▼
 *              asr-inbox-<房间>.jsonl       ← 每场自己的收件箱（格式与以前完全一样）
 *                              │
 *                    [大脑·房间A] [大脑·房间B]  ← 不占显存，恢复并行
 *
 * 为什么是队列、不是"切到那一场去跟"：切场要重载模型（几秒），而队列只是换一段音频喂给
 * 同一个模型，代价接近 0。而且两场会都能持续出字幕（各自慢一点），不会一场彻底饿着。
 *
 * <p><b>不丢数据</b>（用户 2026-10-30 拍板）：积压时只报「队列深度 / 最长已等」，
 * 让人看到落后多少再决定要不要引入丢弃策略。代价是两场会长时间同时说话时字幕会滞后，
 * 那是"一份模型的服务能力"本身，不是 bug。
 *
 * 与 asr-bridge 的分工：桥负责「一种识别来源 → 收件箱」，本脚本负责「队列 → 每场收件箱」。
 * 两者都不翻译；翻译在 scripts/harness-side.mjs（每场一个，不占显存）。
 */

import { spawn } from 'node:child_process'
import { closeSync, openSync, readdirSync, readFileSync, statSync, writeSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT } from '../lib/paths.mjs'

const HELP = `asr-worker —— 唯一的识别消费者（一份模型服务所有房间）

  node bridge/asr-worker.mjs --queue-dir <目录> [选项]

  --queue-dir <dir>      队列目录（切句进程往这里写 <时间>-<房间>.pcm/.json）
  --data-dir <path>      收件箱所在目录（缺省 var/live）；写到 <data-dir>/asr-inbox-<房间>.jsonl
  --inbox-dir <path>     收件箱目录（缺省同 --data-dir；多房间时两者同一个目录即可）
  --model <尺寸>         tiny/base/small/medium/large-v3（缺省 GPU large-v3、CPU small）
  --device <cpu|cuda>    缺省 cuda
  --compute-type <类型>  float16 / int8_float16 / int8_float32 / int8 / float32
  --queue-poll-ms <n>    多久看一次队列（缺省 60）
  --depth-report-s <n>   每隔多少秒报一次队列深度（缺省 30；0 = 不报）
  --keep-inbox           启动时**不清空**收件箱（缺省清空，理由见下）
  --dry-run              只检查参数与目录，不起 python
  --help

关于收件箱：缺省**先清空**。上一次运行留下的行会被大脑重新翻译一遍，于是启动就冒出几句
旧字幕 —— 看起来像"刚收到的话"。要保旧内容加 --keep-inbox。

为什么用 --keep-inbox 反而更常见：多房间时收件箱是**每场一个**文件，而每场的大脑由
start-multi 在轮到它时才起；如果这里不清、那边清，两次清空之间隔着模型加载，
可能把已经写进去的第一句清掉。所以 start-multi 会显式传 --keep-inbox，由它统一清。
`

const TAG = '[asr-worker]'

export function parseArgs(argv = []) {
  const options = {
    queueDir: null,
    dataDir: join(ROOT, 'var', 'live'),
    inboxDir: null,
    model: null,
    device: 'cuda',
    computeType: null,          // null = 按设备定（GPU float16 / CPU int8）
    pollMs: 60,
    depthReportS: 30,
    keepInbox: false,
    dryRun: false,
  }
  const takesValue = new Set(['queue-dir', 'data-dir', 'inbox-dir', 'model', 'device',
    'compute-type', 'queue-poll-ms', 'depth-report-s'])
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new Error(`看不懂的参数：${token}（用 --help 看用法）`)
    const key = token.slice(2)
    if (key === 'help') { options.help = true; continue }
    if (key === 'keep-inbox') { options.keepInbox = true; continue }
    if (key === 'dry-run') { options.dryRun = true; continue }
    if (!takesValue.has(key)) throw new Error(`未知选项 --${key}（用 --help 看用法）`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} 需要一个值`)
    index += 1
    if (key === 'queue-dir') options.queueDir = value
    else if (key === 'data-dir') options.dataDir = value
    else if (key === 'inbox-dir') options.inboxDir = value
    else if (key === 'model') options.model = value
    else if (key === 'device') options.device = value
    else if (key === 'compute-type') options.computeType = value
    else if (key === 'queue-poll-ms') options.pollMs = Number(value)
    else if (key === 'depth-report-s') options.depthReportS = Number(value)
  }
  if (options.help === true) return options
  if (options.queueDir === null) throw new Error('必须给 --queue-dir <目录>（切句进程写队列的地方）')
  for (const key of ['pollMs']) {
    if (!Number.isInteger(options[key]) || options[key] <= 0) {
      throw new Error(`--queue-poll-ms 必须是正整数，收到 ${JSON.stringify(options[key])}`)
    }
  }
  if (!Number.isFinite(options.depthReportS) || options.depthReportS < 0) {
    throw new Error(`--depth-report-s 必须是非负数，收到 ${JSON.stringify(options.depthReportS)}`)
  }
  if (!['cpu', 'cuda'].includes(options.device)) {
    throw new Error(`--device 只能是 cpu 或 cuda，收到 ${JSON.stringify(options.device)}`)
  }
  const allowedCompute = ['float16', 'int8_float16', 'int8_float32', 'int8', 'float32']
  if (options.computeType !== null && allowedCompute.includes(options.computeType) === false) {
    throw new Error(`--compute-type 只能是 ${allowedCompute.join(' / ')}`)
  }
  // 精度缺省跟设备走：CPU 上 float16 更慢（与 start-all 的 --cpu 一致）
  options.computeType = options.computeType ?? (options.device === 'cuda' ? 'float16' : 'int8')
  // 路径必须绝对：相对路径一路传下去会让 python 在**另一个工作目录**里找队列，
  // 表现是"识别进程起来了但永远等不到东西"（踩过一次同类的坑，见 harness-side 的注释）。
  options.queueDir = resolve(options.queueDir)
  options.dataDir = resolve(options.dataDir)
  options.inboxDir = options.inboxDir === null ? options.dataDir : resolve(options.inboxDir)
  // 模型没指定就按设备选（依据见 docs/04 §11：GPU large-v3、CPU small）。
  options.model = options.model ?? (options.device === 'cuda' ? 'large-v3' : 'small')
  return options
}

/** 一场会的收件箱路径（**唯一**规则，start-multi 也用它，不许两处各写一份）。 */
export function inboxPathFor(inboxDir, roomId) {
  return join(inboxDir, `asr-inbox-${roomId}.jsonl`)
}

/**
 * 语种码 → 语种标签（`zh` → `zh-CN`）。
 *
 * <p><b>唯一真相在 python 那边</b>（`whisper_stream.language_tag` / `LANG_TAGS`），
 * 这里只是一道**保险**：4.94 出的那个 bug（队列消费者把 `zh` 原样当 `from` 写进收件箱）
 * 让插件报「目标语种无法推导，请显式传 to」——识别全对、翻译全废，而错误信息完全没提语种。
 * 这类错误在两侧任何一侧写错都会复现，所以两边都归一化；真的走到这里会打一行 stderr，
 * 提醒"上游又漂了"，而不是悄悄吃掉。
 */
export function normalizeLangTag(from) {
  if (typeof from !== 'string') return null
  const text = from.trim()
  if (text === '') return null
  if (text.includes('-')) return text            // 已经是 zh-CN / pt-BR
  const code = text.toLowerCase()
  if (code === 'zh') return 'zh-CN'
  if (code === 'pt') return 'pt-BR'
  if (code === 'en') return 'en-US'
  return null                                    // 认不出：交给插件自己判，**不猜**
}

/**
 * 把一行识别结果落进对应房间的收件箱。
 *
 * <p>格式与老链路**完全一致**（`{"text":…,"from":…}` 一行一句），所以大脑与插件零改动。
 * 用 `openSync(..., 'a')` + `writeSync` 而不是追一个常开的句柄：房间可能很多，
 * 常开句柄会让"某一场会关掉后文件还被占着"（Windows 上改不了名、删不掉）。
 */
export function appendInboxLine(inboxDir, roomId, text, from, { fs = null, speaker = '' } = {}) {
  const tag = normalizeLangTag(from)
  // 5.10：说话人跟着这一行走。**字段名必须是 `speakerName`，不能叫 `speaker`** ——
  // 插件那边的 `speaker` 是另一套语义（相对佩戴者的 `'me' / 'them'`），
  // 而且 `parseInboxLine` 会**校验**它：写个真名进去会让这一行直接被判成坏行，
  // 于是**一句字幕都出不来**。5.08 就是这么把整条链路搞哑的（现场："音频都识别不了了"）。
  // 同一个名字在两个模块里表示不同东西，是这次真正的坑。
  const who = typeof speaker === 'string' ? speaker.trim() : ''
  const body = { text }
  if (tag !== null) body.from = tag
  if (who !== '') body.speakerName = who
  const line = JSON.stringify(body)
  const file = inboxPathFor(inboxDir, roomId)
  if (fs !== null) {                     // 测试注入：不必真写盘
    fs.append(file, line + '\n')
    return file
  }
  mkdirSync(dirname(file), { recursive: true })
  const fd = openSync(file, 'a')
  try { writeSync(fd, line + '\n') } finally { closeSync(fd) }
  return file
}

/** 队列里"已经写完"的段（meta 存在即完整；切句进程先写 pcm、后写 meta）。 */
export function pendingSegments(queueDir, readDir = readdirSync) {
  let names = []
  try {
    names = readDir(queueDir)
  } catch {
    return []                            // 目录还没建：正常（切句进程还没写过）
  }
  return names
    .filter(name => name.endsWith('.json') && name.endsWith('.part') === false)
    .map(name => name.slice(0, -'.json'.length))
    .sort()                              // 文件名以时间戳开头 → 排序即到达顺序
}

/** 队列深度与最长等待（用来把"落后多少"变成看得见的数字）。 */
export function describeQueue(queueDir, now = Date.now(), statFile = statSync) {
  const bases = pendingSegments(queueDir)
  let oldestMs = 0
  for (const base of bases) {
    try {
      const meta = JSON.parse(readFileSync(join(queueDir, `${base}.json`), 'utf-8'))
      const queuedAt = Number(meta.queuedAt ?? 0)
      if (queuedAt > 0) oldestMs = Math.max(oldestMs, now - queuedAt)
    } catch { /* 正在写的段，跳过 */ }
  }
  void statFile
  return { pending: bases.length, oldestMs }
}

/**
 * 起 python 消费者（`whisper_stream.py --queue-dir`）。
 *
 * 单独抽成函数是为了能被测试检查命令拼得对不对 —— 参数名写错在这类脚本里
 * 表现是"进程起来就退"，看代码发现不了。
 */
export function consumerCommand(options) {
  const args = [
    '--queue-dir', options.queueDir,
    '--model', options.model,
    '--device', options.device,
    '--compute-type', options.computeType,
    '--queue-poll-ms', String(options.pollMs),
    '--queue-depth-report-s', String(options.depthReportS),
    // 队列模式下语种是**每段自带**的（切句时从手机的旁文件读），命令行不写死。
    '--format', 'json',
  ]
  return { script: join(ROOT, 'bridge', 'whisper_stream.py'), args }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) { process.stdout.write(HELP); return 0 }

  mkdirSync(options.queueDir, { recursive: true })
  if (options.dryRun) {
    const { script, args } = consumerCommand(options)
    console.log('')
    console.log(`  ${TAG} 队列      ${options.queueDir}`)
    console.log(`  ${TAG} 收件箱    ${options.inboxDir}/asr-inbox-<房间>.jsonl`)
    console.log(`  ${TAG} 模型      ${options.model} / ${options.device} / ${options.computeType}`)
    console.log(`  ${TAG} 会起      python ${script.replace(ROOT, '.').replace(/\\/g, '/')} ${args.join(' ')}`)
    const now = describeQueue(options.queueDir)
    console.log(`  ${TAG} 现在排队  ${now.pending} 段`)
    console.log('')
    console.log('（--dry-run：只检查参数与目录，没有起 python）')
    return 0
  }

  if (options.keepInbox !== true) {
    // 只清**将要被服务到的**那些房间的收件箱是做不到的（哪几场会先说话是未知的），
    // 所以缺省什么都不清、交给 start-multi 在起每一场大脑前清它自己那份。
    // 保留这个开关只为"单独手工跑这个脚本"时不至于没有清空的手段。
    console.log(`${TAG} --keep-inbox 未给：本脚本不主动清空任何收件箱`
      + '（多房间时由 start-multi 按房间清，见其 prepareRoomFiles）')
  }

  const { script, args } = consumerCommand(options)
  console.log('')
  console.log('─'.repeat(68))
  console.log('  识别消费者（唯一一份模型，服务所有房间）')
  console.log('─'.repeat(68))
  console.log(`  队列      ${options.queueDir}`)
  console.log(`  收件箱    ${options.inboxDir.replace(/\\/g, '/')}/asr-inbox-<房间>.jsonl`)
  console.log(`  模型      ${options.model} / ${options.device} / ${options.computeType}`)
  console.log(`  队列深度  每 ${options.depthReportS}s 报一次（**不丢数据**）`)
  console.log('─'.repeat(68))
  console.log('')

  const child = spawn('python', [script, ...args], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUTF8: process.env.PYTHONUTF8 ?? '1',
      PYTHONIOENCODING: process.env.PYTHONIOENCODING ?? 'utf-8' },
  })

  let carry = ''
  child.stdout.setEncoding('utf-8')
  child.stdout.on('data', (chunk) => {
    carry += chunk
    const lines = carry.split('\n')
    carry = lines.pop() ?? ''
    for (const line of lines) route(line)
  })
  let errCarry = ''
  child.stderr.setEncoding('utf-8')
  child.stderr.on('data', (chunk) => {
    errCarry += chunk
    const lines = errCarry.split('\n')
    errCarry = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim() !== '') process.stderr.write(`${TAG} ${line}\n`)
    }
  })

  /**
   * 一行识别结果 → 对应房间的收件箱。
   *
   * <p><b>归不到房间的行**绝不猜**</b>：宁可丢掉这一句（并说清楚），也不要写进
   * 某一场会的收件箱 —— 把 A 房间的话写进 B 房间，比少一句难查得多。
   */
  function route(line) {
    const text = line.trim()
    if (text === '') return
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      process.stderr.write(`${TAG} 认不出这一行（不是 JSON），已跳过：${text.slice(0, 80)}\n`)
      return
    }
    const room = typeof payload.room === 'string' ? payload.room.trim() : ''
    if (room === '') {
      process.stderr.write(`${TAG} 这一行没带房间号，已跳过（绝不猜房间）：${text.slice(0, 80)}\n`)
      return
    }
    const spoken = typeof payload.text === 'string' ? payload.text.trim() : ''
    if (spoken === '') return                 // 空句不写（与老链路一致）
    const raw = payload.from ?? null
    const tag = normalizeLangTag(raw)
    if (tag === null && raw !== null && raw !== undefined && String(raw).trim() !== '') {
      // 上游给了个认不出的语种码 → 明确说一句，而不是静默丢掉方向（4.94 的教训）
      process.stderr.write(`${TAG} 认不出的语种码 ${JSON.stringify(raw)}（房间 ${room}），`
        + '这一行不带 from，插件会自己判方向\n')
    } else if (tag !== raw && tag !== null) {
      process.stderr.write(`${TAG} 语种码归一化：${JSON.stringify(raw)} → ${tag}（房间 ${room}）\n`)
    }
    // 5.08：说话人跟着这一行走（来自分轨文件名）。下游能据此给字幕落名字，
    // 不必再用"这个房间最近一次上传的人"去猜 —— 那个在两人交替说话时会记错人。
    const who = typeof payload.speaker === 'string' ? payload.speaker.trim() : ''
    appendInboxLine(options.inboxDir, room, spoken, raw, { speaker: who })
    if (process.env.LEION_DEBUG === '1') {
      process.stdout.write(`${TAG} ${room} → ${spoken}\n`)
    }
  }

  const code = await new Promise((resolve) => {
    child.on('exit', value => resolve(value === null ? 1 : value))
    child.on('error', (error) => {
      process.stderr.write(`${TAG} 无法启动 python：${String(error?.message ?? error)}\n`)
      resolve(1)
    })
  })
  return code
}

const isCli = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isCli) {
  main().then(code => process.exit(code)).catch((error) => {
    console.error(`${TAG} ❌ ${String(error?.message ?? error)}`)
    process.exit(1)
  })
}
