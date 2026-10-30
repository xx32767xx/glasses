/**
 * start-all.mjs —— 一条命令起齐整条链路
 * ============================================================================
 *   node scripts/start-all.mjs
 *
 * 它起三个进程（外加一个可选）：
 *
 *   [转发]    relay/lan-relay.mjs                              收发室：手机 ↔ 电脑
 *   [识别]    bridge/asr-bridge.mjs --whisper-follow …          耳朵：音频 → 文字
 *   [大脑]    scripts/harness-side.mjs                          大脑：文字 → 翻译 → 字幕
 *   [窗口]    scripts/debug-window.mjs（--open-window 另开一个窗口）  仪表盘：只看
 *
 * 为什么要有它：
 *   四个终端各自记一条又长又容易记错的命令，本身就是出错来源 ——
 *   尤其"以为重启了其实还是旧进程"这种坑（踩过两次，症状还都完全不像"代码没生效"）。
 *   所以这里顺手做了三件事：
 *     1. **启动前先查 8788 有没有被占** —— 占着就说明有旧的转发进程没关，直接指出来并退出；
 *     2. 每个进程的输出带前缀汇总到一个终端（也能在 var/logs/ 里翻回去看）；
 *     3. Ctrl-C 一次停掉全部（含孙进程 —— 桥会再起一个 python，得连它一起收）。
 *
 * 常用参数
 *   --cpu                 识别用 CPU（缺省 cuda/float16；没有 N 卡时用这个）
 * --offline             大脑用离线例句表（不联网、零成本，只认得剧本那 14 句）
 *   --no-transcriber      只起转发 + 大脑（用手输文字那条路时够用）
 *   --data-dir <path>     数据目录（缺省 var/live）
 *   --port <n>            转发端口（缺省 8788）
 *   --open-window         另外弹一个窗口跑调试窗口（Windows）
 *   --quiet-logs          不把日志写进 var/logs/
 */

import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, copyFileSync, unlinkSync, statSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, LOGS_DIR, WHISPER_CACHE_DIR, defaultAudioIn, defaultBus, defaultInbox, defaultSecret } from '../lib/paths.mjs'
import { DEFAULT_DATA_DIR } from '../relay/lan-relay.mjs'
import { currentTermsPaths, readCurrentMeeting } from '../lib/meeting-terms.mjs'

/**
 * 用旧全局表时，把"到底有多少条"说清楚（并在他明明有库、却读到 0 条时报警）。
 *
 * 为什么值得单独一段：实测踩过 —— 库里有 8 条，但手机登录的是 `anqi`，
 * 而 8 条记在 `test` 名下，于是插件读到「热词表：0 条（user=anqi）」，
 * 热词归一与专名提示全部静默失效，字幕里就出现 `Liangliang` 这种错译。
 * 日志虽然打了，但那一行太平常，很难联想到"换了个用户"。
 * 所以在**启动横幅**上直接点出来，并给出可以照抄的修法。
 */
/**
 * 数据目录属于哪个"环境"——**纯标签，不改变任何行为**。
 *
 * 为什么值得打出来：服务器用 /opt/glasses-data、本地用 var/live 或 var/live-test，
 * 三个目录各自独立；混了就会以为"改了没生效"（其实改的是另一套数据）。
 */
function describeDataDirEnv(dataDir) {
  const text = String(dataDir).replace(/\\/g, '/')
  if (/glasses-data$/.test(text)) return text + '（生产：服务器上的正式数据）'
  if (/\/live-test$/.test(text)) return text + '（测试：本地实验数据）'
  if (/\/live$/.test(text)) return text + '（本地默认：var/live）'
  return text + '（自定义目录；环境标签只影响 CLI 的 --env 约定，不影响服务行为）'
}

function describeLegacyTerms(dataDir) {
  try {
    const activeRaw = readFileSync(join(dataDir, 'terms-active.json'), 'utf-8')
    const activeUser = JSON.parse(activeRaw).user ?? null
    const doc = JSON.parse(readFileSync(join(dataDir, 'terms.json'), 'utf-8'))
    const tables = doc && typeof doc.tables === 'object' && doc.tables !== null ? doc.tables : {}
    const chosen = activeUser !== null && tables[activeUser] !== undefined ? activeUser : 'default'
    const entries = Array.isArray(tables[chosen]?.entries) ? tables[chosen].entries.length : 0
    let libraryCount = 0
    try {
      libraryCount = readdirSync(join(dataDir, 'libraries')).filter(name => name.endsWith('.json')).length
    } catch { /* 没有 libraries 目录 = 0 个库 */ }
    const text = `旧的全局表：user=${chosen}，${entries} 条`
      + `（手机开始同传时会自动发布会议术语，届时以那份为准）`
    if (entries === 0 && libraryCount > 0) {
      return {
        text,
        warning: `旧表里当前用户（${chosen}）名下 0 条，但库里有 ${libraryCount} 个库 —— `
          + `这一场的术语/专名提示会全部失效。在手机上勾选库并点一次"开始同传"，服务端就会发布会议术语。`,
      }
    }
    return { text, warning: null }
  } catch {
    return {
      text: '旧的全局表（<data-dir>/terms.json；加 --libraries all 改用会议快照）',
      warning: null,
    }
  }
}

const HELP = `start-all —— 一条命令起齐整条链路

  node scripts/start-all.mjs [选项]

  --cpu                 识别用 CPU（缺省 cuda + float16；没有 N 卡时用这个）
  --compute <类型>      GPU 计算精度：float16（缺省）/ int8_float16 / int8_float32 / int8 / float32。
                        显存紧的卡（例如 4GB）用 int8_float16：large-v3 从 ~5GB 降到 ~3GB，
                        代价是解码略慢（实测同类设置约 1.3~1.8 倍），准确率基本不变。
                        **Pascal 架构（Tesla P40/P100）没有 FP16 加速，用 int8_float32。**
                        遇到不支持的精度会自动换成能跑的档位，并在日志里明说（见 resolve_compute_type）。
                        ⚠️ 显存放不下时 ctranslate2 会直接抛错，不会"自动降级" —— 先用小模型试。
  --whisper-model <尺寸> tiny/base/small/medium/large-v3
                        缺省按设备自动选：**GPU 用 large-v3，CPU 用 small**。
                        依据（中文基准 30 条，见 docs/04 §11）：
                          small 18.9% / medium 7.4% / large-v3 3.9% 的字错率
                        —— 模型大小是影响准确率**最大**的那个变量，比调切句/beam/提示词加起来都大。
                        large-v3 在 GPU 上每段约 0.6 秒（延迟仍在 1.3 秒量级），所以 GPU 上直接用大的。
  --offline             大脑用离线例句表（不联网、零成本，只认得剧本那 14 句）
  --proofread           打开大模型校对（第二遍）：初译先上屏，空闲时回头改这一句。
                        代价是每句多一次模型调用，但**不占**下一句的初译时间（见 docs/07）
  --terms-rescue        打开热词临时修正（**实验**，缺省关）：热词观测到"提到了名字、
                        但译文没写出规范写法"时，空闲时问一次模型"它写成了什么"；
                        只有片段能验证（原样出现、与规范写法形似、不夹带别的名字）才换那一小段。
                        见 docs/15 §18（实验分支 exp/rescue-quarantine）
  --public              公网部署（服务器上）：转发进程开强密钥 + 限流 + 音频上限，
                        并绑到 0.0.0.0。**绑公网地址时必须加**，见 docs/10
  --no-transcriber      只起转发 + 大脑（手输文字那条路不需要识别）
  --data-dir <path>     数据目录（缺省 var/live）
  --inbox <path>        收件箱（缺省 <data-dir>/asr-inbox.jsonl）
  --bus <path>          字幕总线（缺省 <data-dir>/subtitle-bus.json）
  --audio <path>        手机音频落盘位置（缺省 <data-dir>/audio-in.pcm）
  --port <n>            转发端口（缺省 8788）
  --cols <n>            显示宽度（缺省 40）
  --lines <n>           显示行数（缺省 3）
  （没有 --from / --to 了）
                        语种跟着**每一句话**走：手机每次开始/切换录音都会把"说哪种语言"
                        随音频上报（URL 参数 lang），识别进程按它解码，并把语种写进
                        收件箱的每一行 → 插件据此定翻译方向、目标语种自动取另一种语言。
                        所以双向同传不需要任何命令行参数。
  --open-window         另外弹一个窗口跑调试窗口（Windows；那个窗口是全屏重画的，混在一起会打架）
  --dry-run             只检查并显示将要做什么，不真的启动进程（用来排查"起不来"）
  --quiet-logs          不写 var/logs/
  --help
`

/** 每个进程一个短标签，用来给日志加前缀。 */
const STEPS = {
  relay: { tag: '转发', color: '\x1b[36m' },      // 青
  asr: { tag: '识别', color: '\x1b[35m' },        // 紫
  brain: { tag: '大脑', color: '\x1b[33m' },      // 黄
}
const RESET = '\x1b[0m'
const DIM = '\x1b[2m'

export function parseArgs(argv) {
  const options = {
    dataDir: DEFAULT_DATA_DIR,
    port: 8788,
    cols: 40,
    lines: 3,
    offline: false,
    proofread: false,
    termsRescue: false,
    transcriber: true,
    whisperModel: null,          // null = 按设备自动选（见下）
    device: 'cuda',
    computeType: 'float16',
    openWindow: false,
    writeLogs: true,
    public: false,
  }
  const takesValue = new Set(['data-dir', 'inbox', 'bus', 'audio', 'port', 'cols', 'lines', 'whisper-model', 'compute'])
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
    if (key === 'public') { options.public = true; continue }
    if (key === 'open-window') { options.openWindow = true; continue }
    if (key === 'quiet-logs') { options.writeLogs = false; continue }
    if (key === 'dry-run') { options.dryRun = true; continue }
    if (!takesValue.has(key)) throw new Error(`未知选项 --${key}（用 --help 看用法）`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} 需要一个值`)
    index += 1
    if (key === 'port' || key === 'cols' || key === 'lines') options[key] = Number(value)
    else if (key === 'data-dir') options.dataDir = value      // 注意：命令行是 data-dir，属性是 dataDir
    else if (key === 'compute') {
      const allowed = ['float16', 'int8_float16', 'int8_float32', 'int8', 'float32']
      if (!allowed.includes(value)) throw new Error(`--compute 只能是 ${allowed.join(' / ')}`)
      options.computeType = value
    }
    else if (key === 'whisper-model') options.whisperModel = value
    else options[key] = value
  }
  for (const key of ['port', 'cols', 'lines']) {
    if (!Number.isInteger(options[key]) || options[key] <= 0) {
      throw new Error(`--${key} 必须是正整数，收到 ${JSON.stringify(options[key])}`)
    }
  }
  // ⚠️ 数据目录必须解析成**绝对路径**。
  //    踩过的坑：`--data-dir var/test/x` 这样的相对路径会被原样写进插件配置，
  //    接着收件箱路径也是相对的，插件那边**静默读不到**：继电器照写、屏幕上永远没字幕、
  //    一个错都不报 —— 表现和"翻译坏了"一模一样，害我查了半天。
  //    在入口处解析成绝对路径，往外传的就永远是绝对的。
  options.dataDir = resolve(options.dataDir)
  for (const key of ['inbox', 'bus', 'audio']) {
    if (options[key] !== undefined) options[key] = resolve(options[key])
  }
  options.inbox = options.inbox ?? defaultInbox(options.dataDir)
  options.bus = options.bus ?? defaultBus(options.dataDir)
  options.audio = options.audio ?? defaultAudioIn(options.dataDir)
  // 模型没指定就按设备选。依据是中文基准（30 条带参考文本，见 docs/04 §11）：
  //   small 18.9% CER / medium 7.4% / large-v3 3.9% —— 模型大小是**最大**的那个变量，
  //   比调切句、调 beam、加提示词加起来都重要得多。
  //   而 large-v3 每段约 0.6 秒（GPU，float16），延迟仍然在 1.3 秒量级，所以 GPU 上直接用大的。
  //   CPU 上 large-v3 会慢到没法用，所以退回 small（质量有限，文档里写明）。
  options.whisperModel = options.whisperModel
    ?? (options.device === 'cuda' ? 'large-v3' : 'small')
  return options
}

/**
 * 算出要起哪些进程、各自的命令行。
 * 单独抽成纯函数是为了能被测试 —— 命令行拼错是这类脚本最常见的错。
 */
export function buildSteps(options) {
  const steps = []

  const relayArgs = ['--data-dir', options.dataDir, '--port', String(options.port)]
  // 公网部署（服务器上）必须把加固一起带上 —— 否则文档说"服务器上跑 start-all"，
  // 而真正生效的强密钥/限流/音频上限**一个都没开**，是最坏的一种"以为配好了"。
  if (options.public === true) {
    relayArgs.push('--public')
    relayArgs.push('--host', options.host ?? '0.0.0.0')
  }
  // 4.86：`--bus` 一定要真的传下去（以前只解析不传，参数白给）。
  // 注意：start-all 是"单套管线"，它的 --bus 应当是**文件**；
  // 多房间并行要按 docs/21 §4.85 分开起。
  relayArgs.push('--bus', options.bus)
  steps.push({
    key: 'relay',
    ...STEPS.relay,
    script: join(ROOT, 'relay', 'lan-relay.mjs'),
    args: relayArgs,
  })

  if (options.transcriber) {
    const asrArgs = [
      '--inbox', options.inbox,
      '--whisper-follow', options.audio,
      '--whisper-model', options.whisperModel,
      '--whisper-device', options.device,
      '--whisper-compute', options.computeType,
    ]
    // ── 语种跟着每一句话走（4.37 起不再有 --from/--to）──────────────────
    //
    // 链路：手机每次开始/切换录音都会随音频上报 lang（`/audio?lang=`）→ relay 写进
    // `audio-in.lang` 旁文件 → 识别进程按它解码，并把**实际用到的语种**写进收件箱的
    // **每一行**（`{"text":…,"from":"zh-CN"}`）→ 插件按行取 from、目标语种取另一种。
    //
    // 为什么这样比"命令行固定语种"好：固定语种只有在"这一路音频只会有一种语言"时才安全。
    // 实测把葡语音频硬当中文识别：词错率 **100%**，而且输出不是乱码 —— 是**中文译文**
    // （`sequer olhavam pra você` → `甚至看不見你`）。也就是说固定错语种会**安静地产出
    // 看着合理的东西**，比报错危险得多。现在一句话一种语种，就不会有"整路被定错"这种事。
    asrArgs.push('--format', 'json')
    steps.push({
      key: 'asr',
      ...STEPS.asr,
      script: join(ROOT, 'bridge', 'asr-bridge.mjs'),
      args: asrArgs,
    })
  }
  const brainArgs = ['--data-dir', options.dataDir, '--cols', String(options.cols), '--lines', String(options.lines),
    '--inbox', options.inbox, '--bus', options.bus]
  if (options.offline) brainArgs.push('--offline')
  if (options.proofread) brainArgs.push('--proofread')
  // 热词临时修正（实验）：必须真的传到大脑，否则"以为开了"而实际没开
  if (options.termsRescue) brainArgs.push('--terms-rescue')
  // 会议级术语快照（docs/19）：给了 --libraries 才传；不给则大脑沿用旧的全局表
  if (options.termsPath && options.termsActivePath) {
    brainArgs.push('--terms-path', options.termsPath, '--terms-active-path', options.termsActivePath)
  }
  steps.push({
    key: 'brain',
    ...STEPS.brain,
    script: join(ROOT, 'scripts', 'harness-side.mjs'),
    args: brainArgs,
  })

  return steps
}

/**
 * 端口是否已被占用（用来提前发现"旧的转发进程还活着"）。
 *
 * ⚠️ 这里**不能**用"试着 listen 一下，看会不会 EADDRINUSE"那种写法：
 * Windows 上 libuv 默认开了 SO_REUSEADDR，于是 bind 到一个别人正在监听的端口**也会成功** ——
 * 探测永远返回"空闲"，这个守卫就形同虚设（实测就是这样漏过去的）。
 * 所以改成**连接探测**：能连上就说明有人在听。
 */
export function portInUse(port, timeoutMs = 800) {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port })
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))       // 有人监听
    socket.once('timeout', () => finish(false))      // 没人应答（防火墙丢包等）
    socket.once('error', () => finish(false))        // ECONNREFUSED 等 = 没人在听
  })
}

/**
 * 给子进程准备环境变量。
 *
 * 这一条是被一次真实事故逼出来的：用户自己跑脚本时**没有 HF_HOME**，于是识别进程
 * 从零开始把模型下到默认缓存（`~/.cache/huggingface`）—— 直连 HuggingFace 三分钟
 * 只下了 2.5MB，识别进程四分钟都没开始听，而终端上只有一句"加载模型…"。
 * 仓库里明明已经缓存好了 466MB 的 small，却完全没用上。
 *
 * 所以这里缺省就把缓存指到 var/cache/hf、下载源指到镜像；
 * **用户自己的环境变量优先**（已经设了就不覆盖）。
 */
export function childEnv(base = process.env) {
  const env = { ...base }
  const notes = []
  if (!env.HF_HOME) {
    env.HF_HOME = WHISPER_CACHE_DIR
    notes.push(`模型缓存 → ${WHISPER_CACHE_DIR.replace(ROOT, '.').replace(/\\/g, '/')}`)
  }
  if (!env.HF_ENDPOINT) {
    // 直连 huggingface.co 在国内基本下不动（实测 3 分钟 2.5MB）；镜像可覆盖。
    // 想直连就自己设 HF_ENDPOINT=https://huggingface.co
    env.HF_ENDPOINT = 'https://hf-mirror.com'
    notes.push(`下载源 → ${env.HF_ENDPOINT}（想直连就自己设 HF_ENDPOINT）`)
  }
  // Python 的 stdio 编码：不强制的话，Windows 中文环境下它用 GBK 写管道，
  // 而桥按 UTF-8 读 —— 识别结果会变成乱码，插件判不出语种，一句字幕都出不来。
  // （脚本自己也做了 sys.stdout.reconfigure，这里是第二道；手动起 python 时靠脚本那道。）
  let pythonEncoding = false
  if (!env.PYTHONUTF8) { env.PYTHONUTF8 = '1'; pythonEncoding = true }
  if (!env.PYTHONIOENCODING) { env.PYTHONIOENCODING = 'utf-8'; pythonEncoding = true }
  if (pythonEncoding) notes.push('Python 输出编码 → UTF-8（不设的话识别结果会变乱码，见 README）')
  return { env, notes }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 把所有日志流**写完**（等到 'finish'），然后才允许动这些文件。
 *
 * <p>⚠️ 为什么必须单独抽出来、而不是在 `shutdown()` 里就地 `stream.end()`：
 * `end()` 只是"不再写了"，缓冲里的数据是**异步**落盘的（`createWriteStream` 的
 * highWaterMark 是 16KB，日志很容易超过）。不等 'finish' 就去改名/复制，
 * 会读到**被截断的文件** —— 而丢掉的正好是最后几行，
 * 也就是这次运行最该看的东西（最后一句字幕、最后的报错）。
 *
 * <p>抽成导出函数还有一个好处：它能被单元测试**直接**验（喂真实 WriteStream 进去），
 * 不必真的去 spawn 三个子进程 —— 而 spawn 在受限环境里是跑不起来的
 * （管道 stdio 会被拒），那样这段逻辑就只能靠"我看着对"来保证。
 */
export async function flushLogStreams(logs) {
  const streams = Object.values(logs ?? {})
  await Promise.all(streams.map(stream => new Promise(resolve => { stream.end(resolve) })))
}

/** 会话时间戳，用作归档目录名（本地时间，人能读）。 */
export function sessionStamp(date = new Date()) {
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/**
 * 日志里的"有内容的行"数 —— 也就是**除掉了启动头**的行数。
 *
 * 每份日志开头都有一行 `# <ISO> node <script> <args>`（见下面写日志的地方）。
 * 数它没有意义：只要进程起过就有。所以判断"这份日志值不值得归档"时要把它排除掉 ——
 * 否则每次启动失败的尝试都会在归档目录里留下一个只有一个头的空壳。
 */
export function meaningfulLineCount(text) {
  let count = 0
  for (const line of String(text).split('\n')) {
    if (line.trim() === '') continue
    if (line.startsWith('#')) continue
    count += 1
  }
  return count
}

/**
 * 把这一次运行的日志归档到 `var/logs/archive/<会话时间戳>/`。
 *
 * <p><b>为什么归档的时机是"进程结束"，而不是"一次对话结束"</b>：
 * 系统里**没有一个可靠的"对话结束"信号** —— 用户可能暂停又继续、可能一直开着，
 * 也可能手机断一下又连回来。按"静音超过 N 秒"或"手机断开"去切，
 * 切出来的边界是**猜的**，而猜错的边界会让"这一场到底错了多少"这个数字直接失真。
 * 而"进程结束"是**唯一明确、可观测、零成本**的边界。
 * 代价是：一次运行里可能有 0 段或好几段对话。但这不影响归档的目的 ——
 * 归档是为了**让日志读得下去**（不然永远只有一份越滚越大的 relay.log），
 * 不是为了产出"每场对话的统计"。真要做后者，得**记录**边界而不是猜
 * （在"开始同传/停止同传"处打一行标记），那是另一件事。
 *
 * <p><b>为什么按目录分组、而不是几个平行的 .log</b>：一次运行会产生 relay/asr/brain
 * 三份日志，它们**说的是同一场对话的三个侧面**。归档成
 * `archive/20261013-223523/{relay,asr,brain}.log` 之后，
 * "这一场"就是一个目录 —— 翻日志时不会把两场的 asr 和 relay 配错。
 *
 * @returns {{archived: boolean, dir: string|null, keys: string[]}}
 */
export function archiveSessionLogs({ logsDir, keys, stamp = sessionStamp() }) {
  // ⚠️ 目录名要**先找一个没被占用的**，而不是直接用时间戳。
  //    同一秒内启动两次（或者上一次的归档还在，例如两个终端各跑一个 start-all）
  //    会让两次的日志落进同一个目录，后一次把前一次**盖掉** ——
  //    而那正是"想翻日志时发现日志没了"的那类损失，且无声无息。
  //    所以撞名就加 -2 / -3。目录**惰性创建**：确认真要有东西归档才建，
  //    免得每次启动失败的尝试都留下一个空目录。
  let dir = null
  const freeDir = () => {
    const base = join(logsDir, 'archive', stamp)
    if (existsSync(base) === false) return base
    for (let n = 2; n < 100; n += 1) {
      const candidate = `${base}-${n}`
      if (existsSync(candidate) === false) return candidate
    }
    return `${base}-${Date.now()}`
  }

  const moved = []
  for (const key of keys) {
    const from = join(logsDir, `${key}.log`)
    if (existsSync(from) === false) continue
    let text = ''
    try {
      text = readFileSync(from, 'utf-8')
    } catch { continue }
    // 只有启动头 → 这次运行没留下任何东西，不留空壳
    if (meaningfulLineCount(text) === 0) continue
    if (dir === null) dir = freeDir()
    try {
      mkdirSync(dir, { recursive: true })
      try {
        // 首选改名（原子、不占双份空间）。
        renameSync(from, join(dir, `${key}.log`))
      } catch {
        // ⚠️ Windows 上**另一个终端正用 `Get-Content -Wait` 盯着这个文件时改名会失败**
        //    （文件被占用）。这是很可能发生的用法，所以退回复制 + 删除；
        //    再不行就放弃这一份 —— **归档是收尾的杂活，绝不能因为它让退出卡住或报错**。
        copyFileSync(from, join(dir, `${key}.log`))
        unlinkSync(from)
      }
      moved.push(key)
    } catch { /* 单份失败不影响其他份 */ }
  }
  if (moved.length === 0) return { archived: false, dir: null, keys: [] }
  return { archived: true, dir, keys: moved }
}

/**
 * 主流程。
 *
 * ⚠️ argv 作为参数传进来（而不是直接读 process.argv），是为了让测试能在**同一个进程里**
 * 调用它 —— 这个脚本崩过一次"横幅里用了还没初始化的变量"（Cannot access 'envNotes'
 * before initialization），而所有单测都在测纯函数、没走这条路径，于是全绿却起不来。
 * 现在 `--dry-run` 会走完整条启动前逻辑（解析参数 → 探端口 → 拼命令 → 打印横幅）后返回，
 * 测试直接 `await main(['--dry-run'])` 就能把这类崩掉的问题挡住。
 */
/**
 * 数据目录写不进去时给用户看的那段话（纯函数，专门为了能被测试钉住）。
 *
 * 真实事故：服务器上用 `--data-dir /var/lib/leion/live` 起，识别进程
 * `EACCES: permission denied, mkdir '/var/lib/leion'` 退出 → 整条链跟着全停，
 * 而屏幕上只有一段 Node 堆栈，看不出"该 sudo 建目录"。
 */
export function describeDataDirProblem(dataDir, error) {
  const parent = dirname(dataDir)
  const reason = error && (error.code || error.message) ? (error.code ?? error.message) : '未知错误'
  return [
    `数据目录写不进去：${dataDir}（${reason}）`,
    '  识别与转发进程一启动就要在这里建文件，写不进去会直接退出、整条链跟着停。',
    '',
    '  修法（二选一）：',
    `    sudo mkdir -p ${parent} && sudo chown "$USER": ${parent}`,
    '    或换一个你有权限的目录：--data-dir ~/leion-data',
  ].join('\n')
}

/** 真正去试一下能否创建/写入；能写返回 null，不能写返回说明文字。 */
export function assertDataDirWritable(dataDir) {
  try {
    mkdirSync(dataDir, { recursive: true })
    const probe = join(dataDir, '.start-all-probe')
    writeFileSync(probe, 'ok')
    unlinkSync(probe)
    return null
  } catch (error) {
    return describeDataDirProblem(dataDir, error)
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) { process.stdout.write(HELP); return 0 }

  // ── 数据目录先确认能写：否则是"三个进程起两个、第三个退出、然后全停" ────────
  if (!options.dryRun) {
    const problem = assertDataDirWritable(options.dataDir)
    if (problem !== null) {
      console.error('')
      console.error(`❌ ${problem}`)
      console.error('')
      return 1
    }
  }

  // ── 会议级术语库：给了 --libraries 就先冻结一份快照，再让大脑读它 ────────────
  //
  // 为什么冻结成"快照"而不是让插件直接读库：插件只认两个文件 + 一个 user 键（docs/19）。
  // 快照的好处是"这一场开始后改库不影响正在进行的会议"，而且插件侧零改动。
  // 不给 --libraries 就什么都不做，沿用旧的全局表（向后兼容）。
  // ── 术语来源只有一条路：relay 在"手机开始同传"时发布的**当前会议术语** ─────────
  //
  // 为什么不留 --libraries / --meeting：那两个参数会和"界面上的勾选"打架 ——
  // 实测就出过"取消勾选、重启之后旧词表还生效"（其实是 --libraries all 又启用了全部库）。
  // 现在只有一份真相：发布在 <data-dir>/meeting-terms/ 的那份，插件每句都读它。
  // 没有发布过（还没开始过同传）就退回旧的全局表，并在横幅上明确警告。
  {
    const published = await readCurrentMeeting(options.dataDir)
    if (published !== null) {
      const paths = currentTermsPaths(options.dataDir)
      options.termsPath = paths.termsPath
      options.termsActivePath = paths.activePath
      options.termSummary = `会议术语 ${published.entries} 条（会议 ${published.meetingId}，`
        + `库 ${(published.libraryIds ?? []).length} 个；手机开始同传时自动发布）`
    }
  }

  // ── 起之前先查端口：这是"以为重启了其实还是旧进程"的头号来源 ──────────────
  if (await portInUse(options.port)) {
    console.error('')
    console.error(`❌ 端口 ${options.port} 已经被占用 —— 很可能有一个**旧的转发进程**还在跑。`)
    console.error('   不先处理掉的话，手机连的是那个旧进程，你会以为新代码没生效。')
    console.error('')
    console.error('   在 Windows 上这样找出来并杀掉：')
    console.error(`       netstat -ano | findstr :${options.port}      # 最后一列是 PID`)
    console.error('       taskkill /PID <那个PID> /T /F')
    console.error('')
    console.error('   然后重新跑本脚本。')
    return 1
  }

  const steps = buildSteps(options)

  // ⚠️ 这几个必须在**打印横幅之前**算好 —— 横幅要用 envNotes。
  // （原来 childEnv() 写在下面的 spawn 段里，于是"用了还没初始化的变量"直接崩。）
  const { env: spawnEnv, notes: envNotes } = childEnv()

  // ── 开一次新会话：把上一次留下的手机音频清掉 ──────────────────────────────
  // 不清的话，识别进程一启动就会把**上次录的音频**从头转一遍，于是先冒出一句旧字幕 ——
  // 和"收件箱里旧内容被重放"是同一类困扰（那个由 harness-side 负责清）。
  // 实测就是这样：启动后立刻出现一句上次录音的译文，看着像"刚收到手机的话"。
  let staleAudioSeconds = 0
  if (!options.dryRun && options.transcriber && existsSync(options.audio)) {
    try {
      const size = statSync(options.audio).size
      staleAudioSeconds = size / 2 / 16000          // 只用于提示，按 16k 估算即可
      if (size > 0) writeFileSync(options.audio, Buffer.alloc(0))
    } catch { /* 清不掉就算了，不该因为清理失败而起不来 */ }
  } else if (options.dryRun && existsSync(options.audio)) {
    try { staleAudioSeconds = statSync(options.audio).size / 2 / 16000 } catch { /* 忽略 */ }
  }

  // 会话时间戳**在启动时**就定下来，用来当归档目录名。
  // 为什么不等到退出时再取：那样目录名会是"结束时刻"，
  // 而翻归档时想知道的是"这是**哪一次**运行"—— 用开始时刻才对得上
  // 日志头那行 `# <ISO>`，也对得上手机上"我什么时候连的"。
  const sessionStartedAt = sessionStamp()

  let logs = null
  if (options.writeLogs && !options.dryRun) {
    mkdirSync(LOGS_DIR, { recursive: true })
    logs = {}
    for (const step of steps) {
      const stream = createWriteStream(join(LOGS_DIR, `${step.key}.log`), { flags: 'w' })
      stream.write(`# ${new Date().toISOString()}  node ${step.script} ${step.args.join(' ')}\n`)
      logs[step.key] = stream
    }
  }

  console.log('')
  console.log('─'.repeat(72))
  console.log('  亮亮眼镜 · 一键启动')
  console.log('─'.repeat(72))
  for (const step of steps) {
    console.log(`  ${step.color}${step.tag}${RESET}  ${(step.script.replace(ROOT, '.')).replace(/\\/g, '/')} ${step.args.join(' ')}`)
  }
  console.log('')
  console.log(`  翻译后端    ${options.offline ? '离线例句表（只认得剧本 14 句）' : '真实模型（deepseek-official）'}`)
  console.log(`  大模型校对  ${options.proofread
    ? (options.offline
      ? '想开，但离线例句表不认识校对请求 → 实际不会生效（去掉 --offline 才有意义）'
      : '已开启（初译先上屏，空闲时回头改）')
    : '关闭（加 --proofread 打开）'}`)
  console.log(`  临时修正    ${options.termsRescue
    ? (options.offline
      ? '想开，但离线例句表答不出"写成了什么" → 实际不会生效（去掉 --offline 才有意义）'
      : '已开启（实验：观测到漏写时问一次模型，可验证才换那一小段）')
    : '关闭（缺省；加 --terms-rescue 打开，见 docs/15 §18）'}`)
  // 术语来源：说清楚这一场用的是"会议快照"还是"旧的全局表" —— 两者效果完全不同，
  // 而界面上看不出区别（都是"字幕里出现了规范写法"）。
  if (options.termSummary) {
    console.log(`  术语来源    ${options.termSummary}`)
  } else {
    const legacy = describeLegacyTerms(options.dataDir)
    console.log(`  术语来源    ${legacy.text}`)
    if (legacy.warning) console.log(`  ⚠️ ${legacy.warning}`)
  }
  console.log(`  识别模型    ${options.transcriber ? `${options.whisperModel} / ${options.device} / ${options.computeType}` : '未启动（--no-transcriber）'}`)
  // 环境标签：**它只是人们怎么叫这套数据，不是任何开关**（见 docs/10 §7）。
  // 之所以打出来：服务器与本地各有一套数据目录，混了会以为"改了没生效"。
  console.log(`  数据目录环境 ${describeDataDirEnv(options.dataDir)}`)
  console.log(`  数据目录    ${options.dataDir}`)
  for (const note of envNotes) console.log(`  ${note}`)
  if (staleAudioSeconds > 0) {
    console.log(`  已清旧音频  ${staleAudioSeconds.toFixed(1)}s（上次录音留下的；不清的话启动会先冒一句旧字幕）`)
  }
  if (logs) console.log(`  日志文件    ${LOGS_DIR.replace(ROOT, '.').replace(/\\/g, '/')}\\{relay,asr,brain}.log`)
  console.log('')
  console.log(`  ${DIM}Ctrl-C 一次停掉全部（含识别进程起的 python 子进程）${RESET}`)
  console.log(`  ${DIM}退出时这三份日志会自动归档到 var/logs/archive/${sessionStartedAt}/${RESET}`)
  console.log('─'.repeat(72))
  console.log('')

  // --dry-run：走完上面所有启动前逻辑（探端口、拼命令、算环境变量、打印横幅）就返回。
  // 它同时也是这条路径的**回归测试入口** —— 见 tests/start-all-suite.mjs。
  if (options.dryRun) {
    console.log('（--dry-run：只检查并显示将要做什么，没有真的启动任何进程）')
    console.log('')
    return 0
  }

  const children = []
  let shuttingDown = false

  for (const step of steps) {
    const child = spawn(process.execPath, [step.script, ...step.args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      // 让子进程的 stdout 不被父进程的缓冲拖住（低延迟链条上这点很重要）
      env: spawnEnv,
    })
    child.step = step
    children.push(child)

    const prefix = `${step.color}[${step.tag}]${RESET} `
    const relay = (stream, line) => {
      // 空行不打前缀，免得刷出一堆只有前缀的行
      if (line.trim() === '') { stream.write('\n'); return }
      stream.write(prefix + line + '\n')
      if (logs && logs[step.key]) logs[step.key].write(line + '\n')
    }
    // 按行拆：子进程可能一次吐多行，也可能一行分几次到
    let carry = ''
    for (const [stream, sink] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      stream.setEncoding('utf-8')
      stream.on('data', chunk => {
        carry += chunk
        const lines = carry.split('\n')
        carry = lines.pop() ?? ''
        for (const line of lines) relay(sink, line)
      })
    }

    child.on('exit', (code, signal) => {
      if (shuttingDown) return
      // 任何一个环节挂掉，整条链路就废了 —— 直接说清楚是哪一个，然后收摊
      console.error('')
      console.error(`${prefix}⚠️ 这个环节退出了（code=${code ?? '-'} signal=${signal ?? '-'}）。`)
      console.error(`${prefix}   整条链路少一环就没法同传，所以现在把其他进程也停掉。`)
      void shutdown(1)
    })
    child.on('error', error => {
      console.error(`${prefix}无法启动：${String(error && error.message ? error.message : error)}`)
    })
  }

  /** 停掉全部。Windows 上必须用 taskkill /T，否则孙进程（识别起的 python）会留下来占着文件。 */
  function killTree(child) {
    if (child.exitCode !== null || child.signalCode !== null) return
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        return
      } catch { /* 落到下面用 kill */ }
    }
    try { child.kill('SIGTERM') } catch { /* 已经死了 */ }
  }

  async function shutdown(code) {
    if (shuttingDown) return
    shuttingDown = true
    console.log('')
    console.log('  正在停止全部进程…')
    for (const child of children) killTree(child)
    await sleep(600)
    if (logs) {
      await flushLogStreams(logs)
      try {
        const result = archiveSessionLogs({ logsDir: LOGS_DIR, keys: steps.map(step => step.key), stamp: sessionStartedAt })
        if (result.archived) {
          console.log(`  日志已归档  ${result.dir.replace(ROOT, '.').replace(/\\/g, '/')}`
            + `（${result.keys.join(' / ')}）`)
        }
      } catch (error) {
        // 归档失败**不能**影响退出，也不能让人以为日志没了 —— 它还在原地。
        console.log(`  ⚠️ 日志归档失败（日志仍在 var/logs/ 里）：${String(error?.message ?? error)}`)
      }
    }
    console.log('  已全部停止。')
    process.exit(code)
  }

  process.on('SIGINT', () => { void shutdown(0) })
  process.on('SIGTERM', () => { void shutdown(0) })

  // 等一小会儿，把转发进程打印的地址与密钥抓出来汇总一下（它写在 var/live/relay-secret.txt）
  await sleep(1500)
  const secretPath = defaultSecret(options.dataDir)
  if (existsSync(secretPath)) {
    const secret = readFileSync(secretPath, 'utf-8').trim()
    console.log('')
    console.log('─'.repeat(72))
    console.log(`  手机上填：地址 http://<电脑IP>:${options.port}  密钥 ${secret}`)
    console.log(`  地址看上面 [转发] 那几行（选标着 WLAN/以太网的那个，别选 VMware 虚拟网卡）`)
    console.log('')
    console.log(`  想看链路走到哪一步（另开一个终端）：`)
    console.log(`      node scripts/debug-window.mjs --url http://127.0.0.1:${options.port} --secret ${secret}`)
    console.log('─'.repeat(72))
    console.log('')
  }

  if (options.openWindow && process.platform === 'win32') {
    const debugArgs = ['scripts', 'debug-window.mjs', '--url', `http://127.0.0.1:${options.port}`]
    const secret = existsSync(secretPath) ? readFileSync(secretPath, 'utf-8').trim() : ''
    if (secret) debugArgs.push('--secret', secret)
    spawn('cmd', ['/c', 'start', '调试窗口', process.execPath, ...debugArgs],
      { cwd: ROOT, detached: true, stdio: 'ignore' }).unref()
    console.log('  已另开一个「调试窗口」。')
    console.log('')
  }

  // 保持前台：子进程的输出靠上面的管道持续打出来
  await new Promise(() => {})
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => process.exit(code)).catch(error => {
    console.error('[start-all] ❌ ' + String(error && error.message ? error.message : error))
    process.exit(1)
  })
}
