/**
 * start-multi.mjs —— 一条命令起「多场会并行」
 * ============================================================================
 *   node scripts/start-multi.mjs
 *
 * 它和 start-all 的分工（这是**唯一**需要记住的一点）：
 *
 *   start-all  = 单套管线：转发 + 识别 + 大脑，收件箱/字幕总线都是**一个文件**。
 *   start-multi= 多场会并行：转发**一个**（读目录）+ 每场会**各一套**识别/大脑。
 *
 * 原因是并发下"谁说的话"必须能分开：
 *   · 手机上传音频时带 `room=<房间id>`，relay 把声音**分流**到 `audio/<房间id>.pcm`；
 *   · 每场会一套识别进程各跟自己的 pcm，各写自己的收件箱；
 *   · 每场会一套大脑，各写自己的字幕总线文件 `buses/<房间id>.json`；
 *   · relay 用 `--bus <目录>` 读这个目录 —— 一个文件一场会，互不覆盖。
 *
 * 为什么要有它：那份手写四终端说明（docs/24 §6.5.3）只是**示例**，
 * 而真实用起来房间是动态的 —— 谁来开会是手机决定的，不像电台那样能提前写死。
 * 所以这个脚本做的是「**看门人**」：每 3 秒看一眼有哪些开着且有人的房间，
 * 缺管线就补一套、房间散了就把那套收掉，并且只起一个转发进程。
 *
 * 它不会做的事（刻意不做）：
 *   · 不会自动改模型档位 —— 显存不够会**直说**（见启动横幅的提示），但要你自己决定；
 *   · 不会把一场会的术语快照隔离出去 —— `meeting-terms/` 目前是**全局一份**，
 *     两场会都点"开始同传"时后者覆盖前者（docs/21 §4.86 写了这件事和代价）；
 *   · 不会假装老同传 App 也走这条路 —— 它上传音频不带 `room=`，走的是单房间 start-all。
 *
 * 常用参数
 *   --cpu                 识别用 CPU（缺省 cuda/float16；没有 N 卡时用这个）
 *   --whisper-model <尺寸> tiny/base/small/medium/large-v3（缺省按设备：GPU large-v3、CPU small）
 *   --max-rooms <n>       最多同时几场（缺省 0 = 不限；显存吃紧时用它兜底）
 *   --only <id,id>        只跑这几场（调试时用，避免把无关房间也翻译一遍）
 *   --poll-ms <n>         房间轮询间隔（缺省 3000）
 *   --grace-ms <n>        房间没人了之后等多久才收管线（缺省 60000，免得有人退出去看一眼就被杀）
 *   --offline             大脑用离线例句表（不联网、零成本，只认得剧本那 14 句）
 *   --terms-rescue        打开热词临时修正（实验，缺省关）
 *   --no-transcriber      只起转发 + 每场的大脑（用手输文字那条路时够用）
 *   --data-dir <path>     数据目录（缺省 var/live）
 *   --buses <dir>         字幕总线目录（缺省 <data-dir>/buses）
 *   --port <n>            转发端口（缺省 8788）
 *   --public              公网部署（服务器上）：转发进程开强密钥 + 限流 + 音频上限
 *   --dry-run             只打印"会起什么"，不真的起进程
 *   --quiet-logs          不写 var/logs/
 */

import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LOGS_DIR, ROOT } from '../lib/paths.mjs'
import { DEFAULT_DATA_DIR, roomAudioPath } from '../relay/lan-relay.mjs'
import { listRooms } from '../lib/rooms.mjs'
import { dbPath } from '../lib/db.mjs'
import { currentTermsPaths, readCurrentMeeting } from '../lib/meeting-terms.mjs'
// 这五个都从 start-all 借：两份脚本各写一遍就会各错一遍（端口探测那个 SO_REUSEADDR 的坑尤其）。
import {
  archiveSessionLogs, assertDataDirWritable, childEnv, flushLogStreams, portInUse, sessionStamp,
} from './start-all.mjs'

const HELP = `start-multi —— 一条命令起「多场会并行」

  node scripts/start-multi.mjs [选项]

  --cpu                  识别用 CPU（缺省 cuda + float16）
  --compute <类型>       GPU 精度：float16（缺省）/ int8_float16 / int8_float32 / int8 / float32
  --whisper-model <尺寸> tiny/base/small/medium/large-v3（缺省：GPU large-v3、CPU small）

  --parallel-translate   翻译管线**并行**（缺省是串行，见下）。每场会各占一份模型，
                         显存够才开；配 --max-rooms 限流
  --serial-translate     显式声明串行（缺省行为，写出来是为了让命令自解释）
  --switch-idle-ms <n>   串行模式下，正在翻的那场安静多久才让位（缺省 15000）
  --min-hold-ms <n>      至少待多久才允许切走（缺省 8000，防止两场来回抢、一直重载模型）
  --max-rooms <n>        并行模式下最多几场（缺省 0 = 不限）；串行模式下只能 1

  串行 vs 并行（缺省串行，2026-10-30 定）：每场会一套识别 = 一份 whisper 模型
  （large-v3 float16 约 5GB）。显存不够会 OOM，而现象是"识别挂了"，比报"显存不足"难查。
  所以缺省**同一刻只翻一场**：谁在说话就翻谁，另一场排队（它的音频照常按房间落盘，
  轮到它时从"现在"往后翻）。**其他并行一件没少**：音频按房间分流、每场一个字幕总线、
  房间级 WS 帧、历史与转写全文。显存够了加 --parallel-translate 就恢复并行。
  --only <id,id>         只跑这几场（调试用）
  --poll-ms <n>          房间轮询间隔（缺省 3000）
  --grace-ms <n>         房间没人了之后等多久才收管线（缺省 60000）
  --offline              大脑用离线例句表（不联网，只认得剧本那 14 句）
  --proofread            打开大模型校对（缺省关；多场并行时每句多一次模型调用，自己权衡）
  --terms-rescue         打开热词临时修正（实验，缺省关，见 docs/15 §18）
  --no-transcriber       只起转发 + 每场的大脑（手输文字那条路不需要识别）
  --include-empty        连"一个人都没在"的房间也起管线（缺省只跑有人的房间）
  --data-dir <path>      数据目录（缺省 var/live）
  --buses <dir>          字幕总线目录（缺省 <data-dir>/buses）
  --port <n>             转发端口（缺省 8788）
  --public               公网部署（服务器上）：开强密钥 + 限流 + 音频上限，并绑 0.0.0.0
  --dry-run              只打印将要做什么，不起进程（含"现在有哪些房间会起管线"）
  --quiet-logs           不写 var/logs/
  --help

它起的进程
  [转发]    relay/lan-relay.mjs --bus <buses 目录>            一个，读目录，把每场字幕分开
  [识别·房间X] bridge/asr-bridge.mjs --whisper-follow audio/X.pcm --inbox asr-inbox-X.jsonl
  [大脑·房间X] scripts/harness-side.mjs --inbox asr-inbox-X.jsonl --bus buses/X.json

房间从哪来：手机建会/入会即有一个房间（邀请码 6 位）。脚本每 --poll-ms 看一眼
「开着的、且有人在里面」的房间，缺管线就补、散了就收（收之前等 --grace-ms）。

Ctrl-C 一次停掉全部（含识别进程起的 python 孙进程）。退出时日志归档到
var/logs/archive/<会话时间戳>/。
`

const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const CYAN = '\x1b[36m'
// 房间用颜色区分：同一场会的"识别"和"大脑"是同一个颜色，一眼能看出它们是一伙的。
const ROOM_COLORS = ['\x1b[35m', '\x1b[32m', '\x1b[34m', '\x1b[96m', '\x1b[33m', '\x1b[95m']

/** 一场会的管线连挂几次就放弃（每 60 秒重试一次，三次还不行要人来看）。 */
const MAX_RETRIES = 3
const RETRY_COOLDOWN_MS = 60000

/**
 * 房间 id 必须**原样**能当文件名用。
 *
 * <p>为什么这条要单独写个函数并在没人满足时**拒绝起管线**，而不是像 relay 那样消毒：
 * relay 的 `roomAudioPath()` 会把非法字符换成 `_`，那是为了挡目录穿越；
 * 而总线文件名就是 relay 认房间的依据（`buses/<roomId>.json` → 房间 roomId）。
 * 消毒过的名字 `room_a.json` 会让字幕被归到一个**不存在的房间**，
 * 表现是"有翻译、但没有一条落到这场会里"—— 比直接不起更糟、更难查。
 * 现在的房间 id 由 createRoom 生成（`room-<base36>-<4位随机>`），本来就合规，
 * 所以这条只会拦住"有人手工造了个怪 id"的情况，并明确说清楚。
 */
export function isSafeRoomId(roomId) {
  const text = String(roomId ?? '')
  return /^[A-Za-z0-9_-]{1,64}$/.test(text)
}

/** 房间 id 的短名字（打日志用；完整 id 太长，三四个房间就挤满一行）。 */
export function shortRoomId(roomId) {
  const text = String(roomId ?? '')
  // `room-mvt9t5q9-vdkk` → `mvt9t5q9-vdkk`：去掉前缀，保留能区分的那段
  return text.replace(/^room-/, '').slice(-12) || text
}

/** 同一场会的识别/大脑用同一个颜色（按 id 哈希，稳定 —— 不随启动顺序跳变）。 */
export function roomColor(roomId) {
  const text = String(roomId ?? '')
  let hash = 0
  for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) % 100003
  return ROOM_COLORS[hash % ROOM_COLORS.length]
}

export function parseArgs(argv = []) {
  const options = {
    dataDir: DEFAULT_DATA_DIR,
    port: 8788,
    busesDir: null,              // null = <data-dir>/buses
    pollMs: 3000,
    graceMs: 60000,
    cols: 40,
    lines: 3,
    maxRooms: 0,                 // 0 = 不限（只在 --parallel-translate 下有意义）
    // ── 翻译管线怎么跑 ─────────────────────────────────────────────────────
    //
    // 三种模式，缺省 queue（2026-10-30 按显存现状定的）：
    //
    //   queue    （缺省）生产者-消费者：每场一个**切句**进程（纯 CPU、不加载模型）
    //            把话写进 queue/asr/；识别是**全局唯一**一个进程（模型只加载一次），
    //            按到达顺序取段，把文字送进那一场自己的收件箱；大脑每场一个（不占显存）。
    //            → 两场会都能持续出字幕；积压只报不丢。
    //   serial   每场一对「识别 + 大脑」，但同一刻只有一场在跑（谁说话翻谁）。
    //            代价：切换要重载模型（几秒），排队那场暂时没字幕。
    //   parallel 每场一对「识别 + 大脑」同时跑 —— 显存够两份模型才用。
    translateMode: 'queue',
    queueDir: null,              // null = <data-dir>/queue/asr
    depthReportSec: 30,          // 队列深度多久报一次（0 = 不报）
    switchIdleMs: 15000,         // 正在跑的那场安静这么久 → 让位给别的场
    minHoldMs: 8000,             // 至少待这么久才允许切走（防止两场会来回抢，一直重载模型）
    only: [],
    includeEmpty: false,
    offline: false,
    proofread: false,
    termsRescue: false,
    transcriber: true,
    whisperModel: null,          // null = 按设备自动选
    device: 'cuda',
    computeType: 'float16',
    public: false,
    host: null,
    writeLogs: true,
    dryRun: false,
  }
  const takesValue = new Set(['data-dir', 'buses', 'port', 'poll-ms', 'grace-ms', 'cols', 'lines',
    'max-rooms', 'only', 'whisper-model', 'compute', 'switch-idle-ms', 'min-hold-ms',
    'queue-dir', 'depth-report-s', 'translate-mode'])
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new Error(`看不懂的参数：${token}（用 --help 看用法）`)
    const key = token.slice(2)
    if (key === 'help') { options.help = true; continue }
    if (key === 'cpu') { options.device = 'cpu'; options.computeType = 'int8'; continue }
    if (key === 'offline') { options.offline = true; continue }
    if (key === 'proofread') { options.proofread = true; continue }
    if (key === 'terms-rescue') { options.termsRescue = true; continue }
    if (key === 'no-transcriber') { options.transcriber = false; continue }
    if (key === 'include-empty') { options.includeEmpty = true; continue }
    if (key === 'public') { options.public = true; continue }
    if (key === 'quiet-logs') { options.writeLogs = false; continue }
    if (key === 'dry-run') { options.dryRun = true; continue }
    if (key === 'parallel-translate') { options.translateMode = 'parallel'; continue }
    if (key === 'serial-translate') { options.translateMode = 'serial'; continue }
    if (key === 'queue-translate') { options.translateMode = 'queue'; continue }
    if (!takesValue.has(key)) throw new Error(`未知选项 --${key}（用 --help 看用法）`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} 需要一个值`)
    index += 1
    if (key === 'only') {
      options.only = value.split(',').map(item => item.trim()).filter(item => item !== '')
    } else if (key === 'compute') {
      const allowed = ['float16', 'int8_float16', 'int8_float32', 'int8', 'float32']
      if (!allowed.includes(value)) throw new Error(`--compute 只能是 ${allowed.join(' / ')}`)
      options.computeType = value
    } else if (key === 'whisper-model') options.whisperModel = value
    else if (key === 'max-rooms') options.maxRooms = Number(value)
    else if (key === 'poll-ms') options.pollMs = Number(value)
    else if (key === 'grace-ms') options.graceMs = Number(value)
    else if (key === 'switch-idle-ms') options.switchIdleMs = Number(value)
    else if (key === 'min-hold-ms') options.minHoldMs = Number(value)
    else if (key === 'queue-dir') options.queueDir = value
    else if (key === 'depth-report-s') options.depthReportSec = Number(value)
    else if (key === 'translate-mode') {
      const allowed = ['queue', 'serial', 'parallel']
      if (!allowed.includes(value)) throw new Error(`--translate-mode 只能是 ${allowed.join(' / ')}`)
      options.translateMode = value
    }
    else if (key === 'cols') options.cols = Number(value)
    else if (key === 'lines') options.lines = Number(value)
    else if (key === 'port') options.port = Number(value)
    else if (key === 'data-dir') options.dataDir = value
    else options.busesDir = value
  }
  if (options.help === true) return options
  for (const key of ['port', 'pollMs', 'cols', 'lines']) {
    if (!Number.isInteger(options[key]) || options[key] <= 0) {
      throw new Error(`--${key === 'pollMs' ? 'poll-ms' : key} 必须是正整数，收到 ${JSON.stringify(options[key])}`)
    }
  }
  if (!Number.isInteger(options.graceMs) || options.graceMs < 0) {
    throw new Error(`--grace-ms 必须是非负整数，收到 ${JSON.stringify(options.graceMs)}`)
  }
  if (!Number.isInteger(options.maxRooms) || options.maxRooms < 0) {
    throw new Error(`--max-rooms 必须是非负整数，收到 ${JSON.stringify(options.maxRooms)}`)
  }
  for (const key of ['switchIdleMs', 'minHoldMs']) {
    if (!Number.isInteger(options[key]) || options[key] < 0) {
      throw new Error(`--${key === 'switchIdleMs' ? 'switch-idle-ms' : 'min-hold-ms'} 必须是非负整数，收到 ${JSON.stringify(options[key])}`)
    }
  }
  if (!Number.isInteger(options.depthReportSec) || options.depthReportSec < 0) {
    throw new Error(`--depth-report-s 必须是非负整数，收到 ${JSON.stringify(options.depthReportSec)}`)
  }
  // 只有 serial 模式才是"同一刻只跑一场"；queue/parallel 都能多场同时跑。
  // 串行模式下"--max-rooms 大于 1"自相矛盾 —— 与其静默按 1 处理（人会以为开了并行），
  // 不如让他明确选一次。
  if (options.translateMode === 'serial' && options.maxRooms > 1) {
    throw new Error('serial 模式同一刻只跑一场，--max-rooms > 1 要换队列模式（缺省）或 --parallel-translate')
  }
  if (options.only.some(id => isSafeRoomId(id) === false)) {
    throw new Error(`--only 里的房间 id 只能是字母数字下划线连字符：${options.only.filter(id => !isSafeRoomId(id)).join(', ')}`)
  }
  // ⚠️ 数据目录必须解析成**绝对路径**（同 start-all：相对路径一路传下去会让插件静默读不到）。
  options.dataDir = resolve(options.dataDir)
  options.busesDir = options.busesDir === null ? join(options.dataDir, 'buses') : resolve(options.busesDir)
  options.queueDir = options.queueDir === null
    ? join(options.dataDir, 'queue', 'asr')
    : resolve(options.queueDir)
  // 模型没指定就按设备选：GPU large-v3 / CPU small（依据见 docs/04 §11）。
  options.whisperModel = options.whisperModel
    ?? (options.device === 'cuda' ? 'large-v3' : 'small')
  return options
}

/** 三种翻译模式的标题与人话说明（横幅、dry-run 共用，避免两处各写一份）。 */
const MODE_TITLES = { queue: '队列串行识别', serial: '整场串行', parallel: '各场并行' }

export function describeMode(options) {
  switch (options.translateMode) {
    case 'queue':
      return '队列（每场一个切句进程 + 唯一的识别消费者；两场都能出字幕，积压只报不丢）'
    case 'serial':
      return `整场串行（同一刻只翻一场，${options.switchIdleMs}ms 没声才换；切换要重载模型）`
    case 'parallel':
      return '各场并行（每场一份模型；显存要够）'
    default:
      return String(options.translateMode ?? '')
  }
}

/** 串行模式切换时给人的一句人话（`chooseActiveRoom` 的 reason → 中文）。 */
export function describeSwitchReason(reason) {
  switch (reason) {
    case 'floor-holder': return '另一场有人拿起麦克风'
    case 'floor-holder-busiest': return '两场都有人说话，先译声音更新的那场'
    case 'recent-audio': return '另一场刚有声音'
    case 'round-robin': return '都没在说话，轮换着译（避免某一场一直排不到）'
    case 'no-room': return '没有房间了'
    default: return String(reason ?? '')
  }
}

/** 一场会的三个文件：收件箱、字幕总线、分流音频。路径全部落在数据目录下。 */
export function roomFiles(options, roomId) {
  return {
    roomId,
    inbox: join(options.dataDir, `asr-inbox-${roomId}.jsonl`),
    busFile: join(options.busesDir, `${roomId}.json`),
    audio: roomAudioPath(options.dataDir, roomId),
  }
}

/** 转发进程的命令行：**一个**，`--bus` 指向目录（多场会各一个文件）。 */
export function relayStep(options) {
  const args = ['--data-dir', options.dataDir, '--port', String(options.port), '--bus', options.busesDir]
  if (options.public === true) {
    args.push('--public')
    args.push('--host', options.host ?? '0.0.0.0')
  }
  return { key: 'relay', role: 'relay', tag: '转发', label: '转发', color: CYAN,
    script: join(ROOT, 'relay', 'lan-relay.mjs'), args }
}

/**
 * 一场会的管线命令（切句 + 大脑；队列模式下切句不加载模型）。
 *
 * <p>三种模式（`options.translateMode`）在这一层分开：
 *
 * <ul>
 *   <li><b>queue</b>（缺省，生产者-消费者）：每场一个**切句**进程（纯 CPU，不加载模型）
 *       把话写进 `queue/asr/`；识别由**全局唯一**的 `asr-worker` 消费 —— 见 {@link workerStep}。
 *       大脑仍然每场一个（不占显存），所以翻译是并行的。</li>
 *   <li><b>serial</b>：每场一对「识别 + 大脑」，但同一刻只有一场在跑（谁说话翻谁）。</li>
 *   <li><b>parallel</b>：每场一对「识别 + 大脑」同时跑（显存要够两份模型）。</li>
 * </ul>
 *
 * <p>两个文件都**只属于这一场**：收件箱按房间名分文件、字幕总线按房间名分文件。
 * 这就是"归属不串"的全部依据 —— 没有共享的可写状态，就不存在互相覆盖。
 */
export function pipelineSteps(options, room) {
  const roomId = typeof room === 'string' ? room : room.id
  const files = roomFiles(options, roomId)
  const color = roomColor(roomId)
  const label = shortRoomId(roomId)
  const steps = []
  if (options.transcriber) {
    if (options.translateMode === 'queue') {
      // 切句：**不加载模型**，所以两场会各开一个也不占显存。
      steps.push({
        key: `${roomId}-cut`, role: 'cut', tag: '切句', label: `切句·${label}`, color,
        script: join(ROOT, 'bridge', 'whisper_stream.py'), python: true,
        args: [
          '--segment-dir', options.queueDir,
          '--tag', roomId,
          '--follow', files.audio,
          // 语种跟着手机走：旁文件 <pcm>.lang 由 relay 写（切出的段自带语种）
          '--follow-poll-ms', '80',
        ],
      })
    } else {
      steps.push({
        key: `${roomId}-asr`, role: 'asr', tag: '识别', label: `识别·${label}`, color,
        script: join(ROOT, 'bridge', 'asr-bridge.mjs'),
        args: [
          '--inbox', files.inbox,
          '--whisper-follow', files.audio,
          '--whisper-model', options.whisperModel,
          '--whisper-device', options.device,
          '--whisper-compute', options.computeType,
          // 语种跟着每句话走：手机随音频上报 lang，识别进程写进收件箱每一行（4.37 起）
          '--format', 'json',
        ],
      })
    }
  }
  const brainArgs = ['--data-dir', options.dataDir, '--cols', String(options.cols),
    '--lines', String(options.lines), '--inbox', files.inbox, '--bus', files.busFile,
    // 收件箱由本脚本清（见 prepareRoomFiles），所以让大脑别自己再清一遍 ——
    // 两次清空之间隔着模型加载，可能把已经写进去的第一句清掉。
    '--keep-inbox']
  brainArgs.push(options.proofread ? '--proofread' : '--no-proofread')
  if (options.offline) brainArgs.push('--offline')
  if (options.termsRescue) brainArgs.push('--terms-rescue')
  if (options.termsPath && options.termsActivePath) {
    brainArgs.push('--terms-path', options.termsPath, '--terms-active-path', options.termsActivePath)
  }
  steps.push({
    key: `${roomId}-brain`, role: 'brain', tag: '大脑', label: `大脑·${label}`, color,
    script: join(ROOT, 'scripts', 'harness-side.mjs'), args: brainArgs,
  })
  return steps
}

/**
 * 全局唯一的那一步：识别消费者（队列模式）或转发（永远都有）。
 *
 * <p>为什么 worker 是**全局**而不是每场一个：模型只加载一次 —— 这是整个拆分的目的。
 * 它挂了与转发挂了同等严重（所有房间都没字幕了），所以失败策略也相同：全体停。
 */
export function workerStep(options) {
  return {
    key: 'asr-worker', role: 'worker', tag: '识别', label: '识别', color: '\x1b[35m',
    script: join(ROOT, 'bridge', 'asr-worker.mjs'),
    args: [
      '--queue-dir', options.queueDir,
      '--inbox-dir', options.dataDir,
      '--model', options.whisperModel,
      '--device', options.device,
      '--compute-type', options.computeType,
      '--queue-poll-ms', '60',
      '--depth-report-s', String(options.depthReportSec),
      // 收件箱由本脚本按房间清，worker 只管追加（见 prepareRoomFiles）
      '--keep-inbox',
    ],
  }
}

/**
 * 串行模式：同一时刻**只跑一场会**的管线，决定"这一轮该翻译哪一场"。
 *
 * <p><b>为什么要这个函数</b>：显存只够一份模型时就只能串行，而"轮到谁"不能写死成
 * "最早开的那场"—— 那会让另一场会**永远排不到**。真实情况也不对称：
 * 两场会里通常只有一场在说话。所以规则是「**谁在说话就先翻译谁**」，
 * 而已经安静下来的那场让位。三条约束按此优先：
 *
 * <ol>
 *   <li><b>正在持麦的房间优先</b> —— 持麦 = 有人正在说，这就是当下在产生内容的那一场；</li>
 *   <li>其次是「最近有音频增长」的房间（`activity` 是 Web 端观察到的 pcm 增长时间）；</li>
 *   <li>都不活跃时**轮流**（`lastServedAt` 最小的先上）—— 防止某一场永远饿着。</li>
 * </ol>
 *
 * <p>两条防抖动约束（不然两场会会来回抢，每次切换都要**重载模型**）：
 * 正在跑的那场没安静够 `switchIdleMs` 就不切；刚切过去不满 `minHoldMs` 也不切
 * （除非它已经不在候选里了 —— 那说明它散会了，必须马上让位）。
 *
 * @returns {{roomId: string|null, reason: string, switch: boolean}}
 */
export function chooseActiveRoom({
  rooms = [], running = null, activity = new Map(), lastServedAt = new Map(),
  now = Date.now(), idleMs = 15000, minHoldMs = 8000, runningSince = 0,
} = {}) {
  const candidates = (Array.isArray(rooms) ? rooms : []).filter(room => room && typeof room.id === 'string')
  if (candidates.length === 0) return { roomId: null, reason: 'no-room', switch: running !== null && running !== undefined }
  const activeAt = roomId => {
    const entry = activity.get(roomId)
    return entry === undefined ? -Infinity : Number(entry.at ?? -Infinity)
  }
  const isBusy = room => room.holder !== null && room.holder !== undefined && String(room.holder) !== ''
  const fresh = roomId => now - activeAt(roomId) <= idleMs

  // ① 正在跑的那场还在、而且还在说话 → 不切换
  if (running !== null && running !== undefined) {
    const current = candidates.find(room => room.id === running)
    if (current !== undefined) {
      const heldLongEnough = now - runningSince >= minHoldMs
      const stillTalking = isBusy(current) || fresh(current.id)
      // 有人正在另一场说话、而这一场已经安静 → 让位（这才是串行该做的事）
      const someoneElseTalking = candidates.some(room => room.id !== running && (isBusy(room) || fresh(room.id)))
      if (!(heldLongEnough && someoneElseTalking && !stillTalking)) {
        return { roomId: running, reason: stillTalking ? 'still-talking' : 'holding', switch: false }
      }
    }
    // 正在跑的那场已经不在候选里（散会 / 没人了）→ 必须换
  }

  // ② 持麦的房间
  const busy = candidates.filter(isBusy)
  if (busy.length === 1) return { roomId: busy[0].id, reason: 'floor-holder', switch: true }
  if (busy.length > 1) {
    // 两场会同时有人说话 —— 串行必然只能服务一场。挑"最近有音频"的那一场更接近真相。
    const scored = [...busy].sort((left, right) => activeAt(right.id) - activeAt(left.id))
    return { roomId: scored[0].id, reason: 'floor-holder-busiest', switch: true }
  }

  // ③ 最近有音频增长的房间
  const talking = candidates.filter(room => fresh(room.id))
  if (talking.length > 0) {
    const scored = [...talking].sort((left, right) => activeAt(right.id) - activeAt(left.id))
    return { roomId: scored[0].id, reason: 'recent-audio', switch: true }
  }

  // ④ 都不活跃：轮流（最久没被服务过的先上，从没服务过的排最前）
  const ordered = [...candidates].sort((left, right) => {
    const leftAt = Number(lastServedAt.get(left.id) ?? 0)
    const rightAt = Number(lastServedAt.get(right.id) ?? 0)
    if (leftAt !== rightAt) return leftAt - rightAt
    return String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? ''))
  })
  return { roomId: ordered[0].id, reason: 'round-robin', switch: true }
}

/**
 * 读每场会的音频活跃度（只看大小与修改时间，不读内容）。
 *
 * <p>用文件大小判断"这一场是不是在说"，而不是读音频：读内容要占 IO 与 CPU，
 * 而这里只需要一个**粗粒度**的信号 —— 谁最近在长。拿不到（还没有这个房间的 pcm）就当没声。
 */
export function readRoomActivity(options, roomIds, statFile = (path) => statSync(path)) {
  const activity = new Map()
  for (const roomId of roomIds) {
    const file = roomAudioPath(options.dataDir, roomId)
    try {
      const info = statFile(file)
      activity.set(roomId, { bytes: Number(info.size ?? 0), at: Number(info.mtimeMs ?? 0) })
    } catch {
      activity.set(roomId, { bytes: 0, at: -Infinity })
    }
  }
  return activity
}

/**
 * 从"所有开着的房间"里挑出**该起管线**的那些。
 *
 * 缺省只挑"有人在里面"的房间（`members > 0`）：房间开着但一个人都不在，
 * 起一套识别只会白占一份显存和一份模型加载时间。
 */
export function pickRooms(rooms, options = {}) {
  const only = Array.isArray(options.only) ? options.only : []
  const maxRooms = Number.isInteger(options.maxRooms) ? options.maxRooms : 0
  let list = (Array.isArray(rooms) ? rooms : [])
    .filter(room => room && typeof room.id === 'string' && room.id !== '')
    // 见 isSafeRoomId 的注释：名字不能原样当文件名的房间**起不了**管线，
    // 而且不能消毒后硬起 —— 那样字幕会被归到一个不存在的房间。
    .filter(room => isSafeRoomId(room.id))
  if (options.includeEmpty !== true) {
    list = list.filter(room => Number(room.members ?? 0) > 0)
  }
  if (only.length > 0) list = list.filter(room => only.includes(room.id))
  // 按建房时间**从早到晚**排：`--max-rooms` 切掉的应该是"最后开的那几场"，
  // 而不是先来的 —— 而且顺序稳定，翻日志时同一天两次运行能对上。
  list = [...list].sort((left, right) => String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? '')))
  if (maxRooms > 0) list = list.slice(0, maxRooms)
  return list.map(room => ({
    id: room.id,
    code: String(room.code ?? ''),
    name: String(room.name ?? ''),
    members: Number(room.members ?? 0),
    holder: room.holder ?? null,
  }))
}

/**
 * 算出这一轮该收掉哪些房间的管线 —— **带宽限**。
 *
 * <p>为什么要宽限：手机上"退出房间"是一个很轻的动作（返回首页就算），
 * 立刻杀管线意味着有人退出去看一眼消息、再回来时要重新加载模型（几秒到几十秒），
 * 而那一场会正在开。所以房间从"该跑"的名单里消失后，先记下时间，
 * 过了 `--grace-ms` 才真的收；中途又出现（比如他就回来了）就把计时清掉。
 *
 * 纯函数：`running` / `desired` 都是房间 id 数组，`absentSince` 是"从什么时候开始不在"的 Map。
 * 抽出来是为了能直接测（"宽限期内不收""超时收""回来了就不收"三条）。
 */
export function planStop({ running = [], desired = [], absentSince = new Map(), now = Date.now(), graceMs = 0 } = {}) {
  const nextAbsent = new Map(absentSince)
  const desiredIds = new Set(desired)
  const runningIds = new Set(running)
  const stops = []
  for (const roomId of runningIds) {
    if (desiredIds.has(roomId)) { nextAbsent.delete(roomId); continue }
    const since = nextAbsent.get(roomId) ?? now
    nextAbsent.set(roomId, since)
    if (now - since >= graceMs) stops.push(roomId)
  }
  // 已经不跑的房间不必再记着"它什么时候不在了"
  for (const roomId of [...nextAbsent.keys()]) if (!runningIds.has(roomId)) nextAbsent.delete(roomId)
  return { stops, absentSince: nextAbsent }
}

/**
 * 显存提醒（只在真的可能出问题时出现）。
 *
 * <p>每场会一套识别进程 = 每场会一份模型。large-v3 float16 约 5GB，
 * 两张卡都没有的时候，第二个房间起来就会 OOM 而**看起来像"识别挂了"**。
 * 与其等它 OOM，不如在启动横幅上就把账算清楚。
 */
export function memoryHint(options, roomCount) {
  if (roomCount <= 1) return null
  if (options.device !== 'cuda') {
    return `⚠️ ${roomCount} 场会并行 = ${roomCount} 份识别进程（CPU）。机器扛得住就好，扛不住就用 --max-rooms 限流`
  }
  const perRoom = options.whisperModel === 'large-v3' ? 5 : options.whisperModel === 'medium' ? 2.5 : 1
  return `⚠️ ${roomCount} 场会并行 = ${roomCount} 份 ${options.whisperModel}（每份约 ${perRoom}GB 显存，合计约 ${(perRoom * roomCount).toFixed(1)}GB）。`
    + `显存不够会直接 OOM、表现像"识别挂了" —— 建议 --whisper-model medium 或 --compute int8_float16，或用 --max-rooms 限流`
}

/**
 * 起一场会之前把它的两个文件**清干净**。
 *
 * <p>收件箱要清，否则上次同名房间留下的行会被重新翻译一遍（这是 start-all 里也踩过的老坑）；
 * 字幕总线文件要删，否则 relay 一启动就把那份旧字幕推给这场会。
 * 由本脚本统一清、并让大脑带 `--keep-inbox`，是为了让"清"只发生一次 —— 见 pipelineSteps。
 */
export function prepareRoomFiles(files) {
  try { mkdirSync(dirname(files.inbox), { recursive: true }) } catch { /* 建不出来下一步会报 */ }
  try { writeFileSync(files.inbox, '', 'utf-8') } catch { /* 同上 */ }
  try { if (existsSync(files.busFile)) unlinkSync(files.busFile) } catch { /* 有人正读着就算了 */ }
}

/**
 * 启动时清掉**上一次运行**留下的中间文件（总线 / 队列）。
 *
 * <p>为什么必须做（真实踩过，2026-10-31 用户的第一份运行输出里就能看到）：
 * relay 在目录模式下会把 `buses/` 里**每一个** `<房间id>.json` 当成"这一场刚出的字幕"读进来。
 * 上次调试留下的三份总线文件于是被当成三帧真实字幕：终端里刷出
 * 「📺 字幕已更新（第 1/2/3 帧·定稿）」并且**落进了 utterances 表**（历史记录里凭空多三条）。
 * 房间 id 是随机的、那些会也早已结束，所以没造成串会；但"启动瞬间冒出旧字幕"这一点
 * 会让人以为系统坏了 —— 而且它污染的是**历史记录**这种以后很难清的东西。
 *
 * <p>队列同理：上次没消费掉的段会在这次被重新转写，然后写进那个（早已结束的）房间的收件箱。
 *
 * <p>只删"中间状态"，不碰 `audio/`（那是原始录音，可以事后重跑识别）与收件箱（按房间清）。
 * @returns {{buses: number, segments: number}}
 */
export function clearStaleRunState(options, readDir = readdirSync, remove = unlinkSync) {
  const cleared = { buses: 0, segments: 0 }
  try {
    for (const name of readDir(options.busesDir)) {
      if (name.endsWith('.json') !== true) continue
      try { remove(join(options.busesDir, name)); cleared.buses += 1 } catch { /* 被占着就算了 */ }
    }
  } catch { /* 目录还不存在：本来就没有旧文件 */ }
  try {
    for (const name of readDir(options.queueDir)) {
      if (name.endsWith('.pcm') !== true && name.endsWith('.json') !== true) continue
      try { remove(join(options.queueDir, name)); cleared.segments += 1 } catch { /* 同上 */ }
    }
  } catch { /* 同上 */ }
  return cleared
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 读房间表。**不抛异常**：库还没建好（relay 刚起、migrate 还没跑完）时
 * 这一轮就当"还没有房间"，下一轮再看 —— 让看门人因为读不到表就整个退出是最糟的选择。
 */
export function readOpenRooms(dataDir, fileExists = existsSync) {
  try {
    if (fileExists(dbPath(dataDir)) !== true) return { ok: true, rooms: [] }
    return { ok: true, rooms: listRooms(dataDir) }
  } catch (error) {
    return { ok: false, rooms: [], error: String(error && error.message ? error.message : error) }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) { process.stdout.write(HELP); return 0 }
  /** 启动时清掉的旧中间文件（供横幅说明，见 clearStaleRunState）。 */
  let staleState = { buses: 0, segments: 0 }

  // ── 启动前的三件检查（顺序照 start-all：先能不能写、再端口、最后拼命令）──────
  if (!options.dryRun) {
    const problem = assertDataDirWritable(options.dataDir)
    if (problem !== null) {
      console.error('')
      console.error(`❌ ${problem}`)
      console.error('')
      return 1
    }
    try { mkdirSync(options.busesDir, { recursive: true }) } catch (error) {
      console.error(`❌ 字幕总线目录建不出来：${options.busesDir}（${String(error?.code ?? error)}）`)
      return 1
    }
    // ⚠️ 目录必须**已经存在**再起 relay：relay 靠"这是不是一个目录"来判断目录模式，
    //    传一个不存在的路径会被当成单文件总线（于是多场会互相覆盖 —— 最坏的一种静默失败）。
    let isDir = false
    try { isDir = statSync(options.busesDir).isDirectory() } catch { isDir = false }
    if (isDir !== true) {
      console.error(`❌ 字幕总线目录查不到或不是目录：${options.busesDir}`)
      return 1
    }
    if (await portInUse(options.port)) {
      console.error('')
      console.error(`❌ 端口 ${options.port} 已经被占用 —— 很可能有一个**旧的转发进程**还在跑。`)
      console.error('   先停掉它（netstat -ano | findstr :' + options.port + ' → taskkill /PID <PID> /T /F），再重跑。')
      console.error('')
      return 1
    }
    // 端口空出来了才清中间状态：万一上面报"端口被占"，那是另一个实例还在跑，别去动它的文件。
    try { mkdirSync(options.queueDir, { recursive: true }) } catch { /* 起切句时还会再建 */ }
    staleState = clearStaleRunState(options)
  }

  // ── 会议级术语快照：有就传下去（每场会读的都是"当前这一份"）────────────────
  //
  // ⚠️ 这里要说实话：`meeting-terms/` 目前是**全局一份**（docs/21 §4.86）。
  //    两场会都点"开始同传"时，后发布的那份会覆盖前一份 —— 两场会共用最后一份术语表。
  //    这不是这条命令引入的问题，但多场会并行会让它更容易被撞上，所以横幅里要写明。
  let termSummary = null
  {
    const published = await readCurrentMeeting(options.dataDir)
    if (published !== null) {
      const paths = currentTermsPaths(options.dataDir)
      options.termsPath = paths.termsPath
      options.termsActivePath = paths.activePath
      termSummary = `会议术语 ${published.entries} 条（全局一份；两场会各自点"开始同传"时后发布的覆盖前者）`
    }
  }

  const { env: spawnEnv, notes: envNotes } = childEnv()
  const relay = relayStep(options)
  const roomList = options.dryRun ? readOpenRooms(options.dataDir) : { ok: true, rooms: [] }
  const plannedRooms = options.dryRun ? pickRooms(roomList.rooms, options) : []

  console.log('')
  console.log('─'.repeat(72))
  console.log(`  亮亮眼镜 · 多场会（一条命令，${MODE_TITLES[options.translateMode]}）`)
  console.log('─'.repeat(72))
  console.log(`  ${relay.color}${relay.label}${RESET}  ${relay.script.replace(ROOT, '.').replace(/\\/g, '/')} ${relay.args.join(' ')}`)
  if (options.transcriber && options.translateMode === 'queue') {
    const worker = workerStep(options)
    console.log(`  ${worker.color}${worker.label}${RESET}  ${worker.script.replace(ROOT, '.').replace(/\\/g, '/')} ${worker.args.join(' ')}`)
  }
  console.log('')
  if (options.translateMode === 'queue') {
    console.log(`  切句/识别  每场一个**切句**进程（纯 CPU，不加载模型）→ 队列 → **一个**识别进程（模型只加载一次）`)
    console.log(`  ${DIM}           房间是手机决定的：每 ${options.pollMs}ms 看一眼，有人进会就补一套、散了就收${RESET}`)
    console.log(`  ${DIM}           两场会都能持续出字幕（各自慢一点）；积压只报队列深度，**不丢数据**${RESET}`)
  } else if (options.translateMode === 'parallel') {
    console.log(`  识别/大脑  每场会各一套同时跑（每场一份模型；显存要够）`)
  } else {
    console.log(`  识别/大脑  同一刻**只跑一场**（谁在说话就翻译谁；其余排队，${options.switchIdleMs}ms 没声才换）`)
    console.log(`  ${DIM}           为什么串行：每场会一套识别 = 一份模型（large-v3 约 5GB）${RESET}`)
  }
  console.log(`  字幕总线   ${options.busesDir.replace(/\\/g, '/')}/  ← **目录**：每场会一个 <房间id>.json，互不覆盖`)
  console.log(`  收件箱     ${options.dataDir.replace(/\\/g, '/')}/asr-inbox-<房间id>.jsonl`)
  console.log(`  分流音频   ${options.dataDir.replace(/\\/g, '/')}/audio/<房间id>.pcm  ← 每场都分流，与串行无关`)
  console.log(`  翻译后端   ${options.offline ? '离线例句表（只认得剧本 14 句）' : '真实模型（deepseek-official）'}`)
  console.log(`  校对       ${options.proofread ? '开启（每句多一次模型调用）' : '关闭（加 --proofread 打开）'}`)
  if (options.transcriber) {
    if (options.translateMode === 'queue') {
      console.log(`  识别       一份模型（全局唯一）${options.whisperModel} / ${options.device} / ${options.computeType}`)
      console.log(`  队列       ${options.queueDir.replace(/\\/g, '/')}/  ← 每场一个切句进程写这里（切句不加载模型）`)
      console.log(`  队列深度   每 ${options.depthReportSec}s 报一次（**不丢数据**：积压只报不丢）`)
    } else {
      console.log(`  识别模型   ${options.whisperModel} / ${options.device} / ${options.computeType}`)
    }
  } else {
    console.log('  识别模型   未启动（--no-transcriber：只跑转发 + 大脑，手输文字那条路）')
  }
  console.log(`  翻译模式   ${describeMode(options)}`
    + `；房间没人后 ${options.graceMs}ms 才收管线`)
  console.log(`  术语来源   ${termSummary ?? '旧的全局表（<data-dir>/terms.json；手机上"开始同传"后会发布会议术语）'}`)
  console.log(`  数据目录   ${options.dataDir}`)
  if (staleState.buses > 0 || staleState.segments > 0) {
    console.log(`  已清旧状态 ${staleState.buses} 份旧总线 + ${staleState.segments} 段旧队列`
      + '（不清的话 relay 一启动就把上次的字幕当新帧重播，还会落进历史记录）')
  }
  for (const note of envNotes) console.log(`  ${note}`)
  console.log('')
  console.log(`  ${DIM}⚠️ 老同传 App 上传音频不带 room=，它的声音只会进全局 audio-in.pcm —— `
    + `那条路请用 node scripts/start-all.mjs（单场会）${RESET}`)
  console.log(`  ${DIM}Ctrl-C 一次停掉全部（含识别进程起的 python 孙进程）${RESET}`)
  console.log('─'.repeat(72))
  console.log('')

  if (options.dryRun) {
    if (roomList.ok !== true) {
      console.log(`  （读房间表失败：${roomList.error}）`)
    } else if (plannedRooms.length === 0) {
      console.log('  现在没有"开着且有人"的房间 —— 真的跑起来后会一直等，有人进会就补一套管线。')
    } else {
      // serial 模式只会有**一场**真的跑起来；queue/parallel 都是每场一套
      const planned = options.translateMode === 'serial' ? plannedRooms.slice(0, 1) : plannedRooms
      const queued = options.translateMode === 'serial' ? plannedRooms.slice(1) : []
      console.log(`  现在会起 ${planned.length} 套管线`
        + `${queued.length > 0 ? `（另有 ${queued.length} 场排队，谁说话就换谁）` : ''}：`)
      for (const room of planned) {
        const files = roomFiles(options, room.id)
        console.log(`    房间 ${room.id}「${room.name || '未命名'}」邀请码 ${room.code} 人 ${room.members}`)
        for (const step of pipelineSteps(options, room)) {
          console.log(`      ${step.color}${step.label}${RESET} ${step.script.replace(ROOT, '.').replace(/\\/g, '/')} ${step.args.join(' ')}`)
        }
        console.log(`      ${DIM}总线 ${files.busFile}${RESET}`)
      }
      for (const room of queued) {
        console.log(`    ${DIM}… 排队中：${room.id}「${room.name || '未命名'}」邀请码 ${room.code}，${room.members} 人${RESET}`)
      }
    }
    const hint = memoryHint(options, options.translateMode === 'parallel' ? Math.max(1, plannedRooms.length) : 1)
    if (hint) console.log(`\n  ${hint}`)
    console.log('')
    console.log('（--dry-run：只检查并显示将要做什么，没有真的启动任何进程）')
    console.log('')
    return 0
  }

  // ── 真跑 ───────────────────────────────────────────────────────────────────
  const sessionStartedAt = sessionStamp()
  const running = new Map()          // roomId → { room, steps: Map(key→child), startedAt }
  const children = new Set()         // 所有子进程（含转发），收尾时按树杀
  const failures = new Map()         // roomId → { count, at }
  const logStreams = new Map()       // key → WriteStream
  const lastServedAt = new Map()     // roomId → 上一次"轮到它翻译"的时间（串行模式防饿死）
  let absentSince = new Map()
  let stopping = false
  let timer = null
  let worker = null                  // 队列模式下全局唯一的识别消费者
  let tickCount = 0
  let maxRoomsWarned = false
  let readErrorWarned = false
  let ramWarned = false

  function ensureLog(key, headerNote) {
    if (!options.writeLogs) return null
    if (logStreams.has(key)) return logStreams.get(key)
    mkdirSync(LOGS_DIR, { recursive: true })
    const stream = createWriteStream(join(LOGS_DIR, `${key}.log`), { flags: 'w' })
    stream.write(`# ${new Date().toISOString()}  start-multi  ${headerNote}\n`)
    logStreams.set(key, stream)
    return stream
  }

  function spawnStep(step, roomId) {
    // 切句那一步是 **python**（whisper_stream.py --segment-dir），其余都是 node。
    // 为什么切句是 python：分层与能量判定的实现只有一份（UtteranceSegmenter），
    // 在 JS 里再写一份等于把"切句参数"变成两处真相。
    const command = step.python === true ? (process.env.PYTHON ?? 'python') : process.execPath
    const child = spawn(command, [step.script, ...step.args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: spawnEnv,
    })
    child.step = step
    children.add(child)
    const logStream = ensureLog(step.key, `${step.python === true ? 'python' : 'node'} ${step.script} ${step.args.join(' ')}`)
    const prefix = `${step.color}[${step.label}]${RESET} `
    // 每路流各自留半行：stdout 与 stderr 混用同一个缓冲会把两个流的一半拼在一起（乱码）。
    for (const [stream, sink] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      let carry = ''
      stream.setEncoding('utf-8')
      stream.on('data', chunk => {
        carry += chunk
        const lines = carry.split('\n')
        carry = lines.pop() ?? ''
        for (const line of lines) {
          if (line.trim() === '') { sink.write('\n'); continue }
          sink.write(prefix + line + '\n')
          if (logStream) logStream.write(line + '\n')
        }
      })
    }
    child.on('exit', (code, signal) => {
      children.delete(child)
      if (stopping) return
      onChildExit(step, roomId, code, signal)
    })
    child.on('error', error => {
      console.error(`${prefix}无法启动：${String(error && error.message ? error.message : error)}`)
    })
    return child
  }

  function killTree(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        return
      } catch { /* 落到下面用 kill */ }
    }
    try { child.kill('SIGTERM') } catch { /* 已经死了 */ }
  }

  function startRoom(room) {
    const files = roomFiles(options, room.id)
    prepareRoomFiles(files)
    const steps = pipelineSteps(options, room)
    const entry = { room, steps: new Map(), startedAt: Date.now() }
    running.set(room.id, entry)
    absentSince.delete(room.id)
    const color = roomColor(room.id)
    console.log(`  ${color}▶ 房间 ${room.id}「${room.name || '未命名'}」${RESET} 邀请码 ${room.code}，`
      + `${room.members} 人在场${room.holder ? `，现在 ${room.holder} 在说` : ''}`)
    console.log(`    ${DIM}总线 ${files.busFile.replace(/\\/g, '/')}${RESET}`)
    // 第二个房间起来的这一刻最容易把显存撑爆 —— 在这里就把账算给人看（只算一次）
    if (options.transcriber && running.size === 2 && ramWarned === false) {
      ramWarned = true
      const hint = memoryHint(options, running.size)
      if (hint !== null) console.log(`  ${hint}`)
    }
    for (const step of steps) entry.steps.set(step.key, spawnStep(step, room.id))
  }

  function stopRoom(roomId, reason) {
    const entry = running.get(roomId)
    if (entry === undefined) return
    running.delete(roomId)
    absentSince.delete(roomId)
    for (const child of entry.steps.values()) killTree(child)
    if (!stopping) {
      console.log(`  ${DIM}■ 房间 ${roomId} 的管线已收（${reason}）${RESET}`)
    }
  }

  function onChildExit(step, roomId, code, signal) {
    if (roomId === null) {
      // roomId === null = **全局**进程（转发、识别消费者）。它们没有"别的房间能顶上"：
      // 转发死了手机连不上；识别消费者死了所有房间都没字幕。所以一律全体停。
      console.error('')
      console.error(`[${step.label}] ⚠️ ${step.label}进程退出了（code=${code ?? '-'} signal=${signal ?? '-'}）。`)
      console.error(`  ${step.label} 是所有房间共用的一个进程，它没了整条链就废了 —— 现在把其他进程也停掉。`)
      void shutdown(1)
      return
    }
    // ⚠️ 关键顺序问题：一个进程挂了会顺手把同组的另一个杀掉，
    //    而被杀的也会触发 exit —— 如果不过滤，一次故障会**算两次失败**、打两遍错误，
    //    于是三次重试名额两下就用完了。已经不在 running 里的房间 = 已在收，不再记账。
    if (running.has(roomId) !== true) return
    const failure = failures.get(roomId) ?? { count: 0, at: 0 }
    failures.set(roomId, { count: failure.count + 1, at: Date.now() })
    console.error('')
    console.error(`  ⚠️ 房间 ${roomId} 的「${step.tag}」退出了（code=${code ?? '-'} signal=${signal ?? '-'}）。`)
    const entry = running.get(roomId)
    if (entry) {
      entry.steps.delete(step.key)
      for (const sibling of entry.steps.values()) killTree(sibling)
      running.delete(roomId)
    }
    const gathered = failures.get(roomId)
    if (gathered.count >= MAX_RETRIES) {
      console.error(`  这一场连挂 ${gathered.count} 次，**不再重试**（其他房间不受影响）。`)
      console.error('  修好原因后重跑本脚本；先看这台机器的日志：')
      console.error(`     ${join(LOGS_DIR, `${step.key}.log`).replace(ROOT, '.').replace(/\\/g, '/')}`)
    } else {
      console.error(`  ${Math.round(RETRY_COOLDOWN_MS / 1000)} 秒后重试（第 ${gathered.count + 1}/${MAX_RETRIES} 次）。`)
    }
  }

  async function shutdown(code) {
    if (stopping === true) return
    stopping = true
    if (timer !== null) clearTimeout(timer)
    console.log('')
    console.log('  正在停止全部进程…')
    for (const child of children) killTree(child)
    await sleep(600)
    if (logStreams.size > 0) {
      await flushLogStreams(Object.fromEntries(logStreams))
      try {
        const result = archiveSessionLogs({
          logsDir: LOGS_DIR, keys: [...logStreams.keys()], stamp: sessionStartedAt,
        })
        if (result.archived) {
          console.log(`  日志已归档  ${result.dir.replace(ROOT, '.').replace(/\\/g, '/')}`
            + `（${result.keys.length} 份）`)
        }
      } catch (error) {
        console.log(`  ⚠️ 日志归档失败（日志仍在 var/logs/ 里）：${String(error?.message ?? error)}`)
      }
    }
    console.log('  已全部停止。')
    process.exit(code)
  }

  process.on('SIGINT', () => { void shutdown(0) })
  process.on('SIGTERM', () => { void shutdown(0) })

  // 先起**全局**进程：转发（所有人的出口）+ 队列模式下的识别消费者（模型只加载一次）。
  // 再开始看房间表 —— 房间是手机建的，只能边看边补。
  spawnStep(relay, null)
  if (options.transcriber && options.translateMode === 'queue') {
    mkdirSync(options.queueDir, { recursive: true })
    worker = spawnStep(workerStep(options), null)
  }

  async function tick() {
    timer = null
    if (stopping) return
    tickCount += 1
    const snapshot = readOpenRooms(options.dataDir)
    if (snapshot.ok !== true) {
      if (!readErrorWarned) {
        readErrorWarned = true
        console.error(`  ⚠️ 读房间表失败（这条不影响已起的管线，会一直重试）：${snapshot.error}`)
      }
      schedule()
      return
    }
    if (readErrorWarned) { readErrorWarned = false }

    const desired = pickRooms(snapshot.rooms, options)
    // 上限被吃掉时**说一次**，别让人以为脚本漏了房间
    if (options.maxRooms > 0 && !maxRoomsWarned) {
      const uncapped = pickRooms(snapshot.rooms, { ...options, maxRooms: 0 })
      if (uncapped.length > desired.length) {
        maxRoomsWarned = true
        console.log(`  ${DIM}（有 ${uncapped.length} 场会开着，但 --max-rooms ${options.maxRooms} 只跑前 ${desired.length} 场）${RESET}`)
      }
    }

    const plan = planStop({
      running: [...running.keys()],
      desired: desired.map(room => room.id),
      absentSince,
      now: Date.now(),
      graceMs: options.graceMs,
    })
    absentSince = plan.absentSince
    for (const roomId of plan.stops) stopRoom(roomId, '房间已关闭或没人了')

    if (options.translateMode !== 'serial') {
      // queue / parallel：每场一套（queue 的"省显存"靠切句不加载模型 + 全局唯一识别，
      // 而不是靠"只跑一场"）。失败重试也按房间各自算。
      for (const room of desired) {
        if (running.has(room.id)) continue
        const failure = failures.get(room.id)
        if (failure !== undefined) {
          if (failure.count >= MAX_RETRIES) continue
          if (Date.now() - failure.at < RETRY_COOLDOWN_MS) continue
        }
        startRoom(room)
      }
    } else {
      // ── 串行模式：同一刻只跑一场，谁在说话就翻译谁 ────────────────────────
      //
      // 关键取舍：**另一场会排队时不是"没有字幕"，而是"还没有它的字幕"** ——
      // 它的音频照样按房间分流落盘，轮到它时从**当前位置**开始翻译（见 PcmFollower
      // 从文件末尾开始跟），所以不会把之前几分钟的录音重新识别一遍冒出旧句子。
      // 也就是说：显存不够时，牺牲的是"同时两场都有字幕"，不是"音频丢了"。
      const nowMs = Date.now()
      const runningIds = [...running.keys()]
      const activity = readRoomActivity(options, desired.map(room => room.id))
      const currentRunning = runningIds.length > 0 ? runningIds[0] : null
      const currentEntry = currentRunning === null ? null : running.get(currentRunning)
      const choice = chooseActiveRoom({
        rooms: desired,
        running: currentRunning,
        activity,
        lastServedAt,
        now: nowMs,
        idleMs: options.switchIdleMs,
        minHoldMs: options.minHoldMs,
        runningSince: currentEntry === undefined || currentEntry === null ? 0 : currentEntry.startedAt,
      })
      // 兜底：串行模式下不该同时存在两套管线（除了刚切换的那一瞬间）
      for (const roomId of runningIds) {
        if (roomId !== choice.roomId) stopRoom(roomId, '让位给正在说话的那一场')
      }
      if (choice.roomId !== null && running.has(choice.roomId) !== true) {
        const target = desired.find(room => room.id === choice.roomId)
        const failure = failures.get(choice.roomId)
        const cooling = failure !== undefined
          && (failure.count >= MAX_RETRIES || nowMs - failure.at < RETRY_COOLDOWN_MS)
        if (target !== undefined && !cooling) {
          if (choice.switch && currentRunning !== null) {
            console.log(`  ${DIM}⇄ 换到 ${shortRoomId(choice.roomId)}（${describeSwitchReason(choice.reason)}）`
              + ` —— 串行模式每次切换都要重新加载模型，几秒钟${RESET}`)
          }
          startRoom(target)
          lastServedAt.set(choice.roomId, nowMs)
        }
      }
      // 排队中的房间说清楚"为什么没有它的字幕"
      const waiting = desired.filter(room => room.id !== choice.roomId)
      if (waiting.length > 0 && tickCount % 10 === 0) {
        console.log(`  ${DIM}… 排队中（串行，显存只够一份模型）：${waiting.map(room => shortRoomId(room.id)).join(' / ')}`
          + `（它们的音频照常落盘，轮到时会从"现在"开始翻译）${RESET}`)
      }
    }

    // 跑满两分钟就**把失败计数清零**：故障额度是给"起不来"的，不是给"跑了一小时才挂一次"的
    const now = Date.now()
    for (const [roomId, entry] of running) {
      if (now - entry.startedAt > 120000 && failures.has(roomId)) failures.delete(roomId)
    }

    // 每 20 轮（缺省 1 分钟）打一行"还活着"，否则终端长时间没输出会让人怀疑它挂了
    if (tickCount % 20 === 0) {
      const names = [...running.keys()].map(shortRoomId)
      console.log(`  ${DIM}· 还在看（开着的房间 ${snapshot.rooms.length} 个，`
        + `在翻译 ${running.size} 场${names.length > 0 ? `：${names.join(' / ')}` : ''}）${RESET}`)
    }
    schedule()
  }

  function schedule() {
    if (stopping) return
    timer = setTimeout(() => { void tick() }, options.pollMs)
  }

  // 转发起来后把手机要填的地址/密钥汇总一下（和 start-all 一样，从 <data-dir>/relay-secret.txt 读）
  await sleep(1500)
  const secretPath = join(options.dataDir, 'relay-secret.txt')
  let secret = ''
  try { secret = readFileSync(secretPath, 'utf-8').trim() } catch { /* 还没写出来 */ }
  if (secret !== '') {
    console.log('')
    console.log('─'.repeat(72))
    console.log(`  手机上填：地址 http://<电脑IP>:${options.port}  密钥 ${secret}`)
    console.log('  地址看上面 [转发] 那几行（选标着 WLAN/以太网的那个，别选 VMware 虚拟网卡）')
    console.log(`  房间不用填：手机建会/入会即一个房间，这里每 ${options.pollMs}ms 自动补管线`)
    console.log('─'.repeat(72))
    console.log('')
  } else {
    console.log(`  ${DIM}（还没读到密钥文件 ${secretPath.replace(/\\/g, '/')}，看上面 [转发] 打印的密钥）${RESET}`)
    console.log('')
  }

  void tick()

  await new Promise(() => {})
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => process.exit(code)).catch(error => {
    console.error('[start-multi] ❌ ' + String(error && error.message ? error.message : error))
    process.exit(1)
  })
}
