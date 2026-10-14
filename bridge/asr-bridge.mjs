/**
 * asr-bridge.mjs —— 把语音识别结果送进 leion-pro 的 ASR 收件箱
 * ============================================================================
 *
 * 这是 harness 之外的另一半：
 *   · leion-pro 插件负责「读收件箱 → 判语向 → 翻译 → 排版 → 上屏」；
 *   · 本桥负责「把 ASR 的文字按行追加到收件箱」。
 * 两边只共享一个约定：**一行一句话**。所以换 ASR 不用动插件，换眼镜不用动桥。
 *
 * 引擎（--engine）
 *   stdin    从标准输入读。配合任何会往 stdout 打字的 ASR：
 *              `whisper-cli -m model.bin -f audio.wav | node bridge/asr-bridge.mjs --inbox ...`
 *   command  起一个子进程并转发它的 stdout（ASR 云 SDK 的 CLI、自写脚本都走这条）
 *   replay   从一份录制好的转写文本按节奏重放 —— 演示与回归测试用，不需要麦克风
 *   whisper  用 Python 侧 faster-whisper 实时转写麦克风（需要 pip 安装，见 whisper_stream.py）
 *
 * 为什么需要一个「行装配器」
 *   ASR 的输出来得很碎：有的逐词打、有的用 \r 就地刷新同一行、有的只在句末换行。
 *   装配器同时处理 \n 和 \r，并支持**停顿即断句**（--flush-on-pause-ms）：一段时间没有
 *   新数据就把缓冲区当成一句完整的话送出去。
 *   这条参数直接决定字幕什么时候上屏：太早会把半句翻出去，太晚就失去同传的意义。
 *
 * 用法
 *   node bridge/asr-bridge.mjs --inbox <path> [选项]
 *   node bridge/asr-bridge.mjs --help
 */

import { open, mkdir, readFile, truncate } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 合法的语种与说话人标记，和插件侧保持一致。 */
export const LANGS = ['zh-CN', 'pt-BR']
export const SPEAKERS = ['them', 'me']

// ─────────────────────────────────────────────────────────────────────────────
// 行装配器：把碎片化的 ASR 输出切成「一句一行」
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param opts.flushOnPauseMs 停顿超过这么久就把缓冲区当成一句（0 = 只用 \n / \r 断句）
 * @param opts.onLine 每得到一句完整的话就回调（空白行会被丢掉）
 * @param opts.setTimer/clearTimer 可注入，便于测试（默认用真实定时器）
 */
export function createLineAssembler({ flushOnPauseMs = 0, onLine, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof onLine !== 'function') throw new Error('createLineAssembler 需要 onLine 回调')
  let buffer = ''
  let timer = null

  const cancel = () => {
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
  }

  const emit = raw => {
    // ASR 常见地会带一堆空白；顺手把内部换行压成空格，避免一句话在收件箱里占多行。
    const text = String(raw).replace(/\s+/g, ' ').trim()
    if (text !== '') onLine(text)
  }

  const arm = () => {
    if (flushOnPauseMs <= 0) return
    // 缓冲区已经空了（刚被换行清掉）就不该再挂一个只会在未来空转的定时器。
    if (buffer === '') {
      cancel()
      return
    }
    cancel()
    timer = setTimer(() => {
      timer = null
      const pending = buffer
      buffer = ''
      emit(pending)
    }, flushOnPauseMs)
  }

  return {
    /** 送入一段 ASR 增量。 */
    push(chunk) {
      buffer += String(chunk)
      // \r 与 \n 都算行结束：很多 ASR CLI 用 \r 就地刷新同一行。
      let index = buffer.search(/[\r\n]/)
      while (index >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        emit(line)
        index = buffer.search(/[\r\n]/)
      }
      arm()
    },
    /** 流结束时把剩余内容作为最后一句送出去。 */
    flush() {
      cancel()
      const pending = buffer
      buffer = ''
      emit(pending)
    },
    /** 当前还没成句的缓冲内容（诊断用）。 */
    pending() {
      return buffer
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 收件箱写入器
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 打开收件箱并按行追加。
 *
 * 两种格式，插件都认：
 *   text —— 一行就是原文，语向由插件逐行自动判定（--from 可以不做标记）
 *   json —— {"text":"…","from":"pt-BR","speaker":"them"}，ASR 已知语种时更稳
 *
 * @param opts.inboxPath 收件箱文件绝对路径
 * @param opts.format 'text' | 'json'
 * @param opts.tags 写进 json 行的附加标记（from / to / speaker）
 * @param opts.truncate 先清空收件箱（演示时从干净的屏开始）
 * @param opts.dryRun 只打印不写盘
 */
export async function createInboxWriter({ inboxPath, format = 'text', tags = {}, truncate: doTruncate = false, dryRun = false, log = console } = {}) {
  if (typeof inboxPath !== 'string' || inboxPath === '') throw new Error('createInboxWriter 需要 inboxPath')
  if (format !== 'text' && format !== 'json') throw new Error(`format 只能是 'text' 或 'json'，收到 ${JSON.stringify(format)}`)
  if (tags.from !== undefined && !LANGS.includes(tags.from)) {
    throw new Error(`from 只能是 ${LANGS.join(' / ')}，收到 ${JSON.stringify(tags.from)}`)
  }
  if (tags.to !== undefined && !LANGS.includes(tags.to)) {
    throw new Error(`to 只能是 ${LANGS.join(' / ')}，收到 ${JSON.stringify(tags.to)}`)
  }
  if (tags.speaker !== undefined && !SPEAKERS.includes(tags.speaker)) {
    throw new Error(`speaker 只能是 ${SPEAKERS.join(' / ')}，收到 ${JSON.stringify(tags.speaker)}`)
  }

  const stats = { lines: 0, bytes: 0, skipped: 0 }
  let handle = null

  // ── 清空收件箱：**在这里立刻做，不能等到写第一行时才做** ──────────────────
  // 早先的实现把 truncate 放在"第一次写"的分支里（`if (handle === null)`），于是：
  //   · 一行都没写（比如识别进程刚起来就报错退出）时，truncate 根本不会发生 ——
  //     `--truncate` 静默失效，上一次的旧内容原样留着，看起来像是"新识别没生效"；
  //   · 而且它是"写第一行"的时刻才删，会删掉那个时刻别人（比如 relay）刚写进去的行。
  // 这两个都是很难查的，所以改成创建时就清空。
  if (doTruncate && !dryRun) {
    try {
      await truncate(inboxPath, 0)
    } catch (error) {
      // 文件还不存在是正常的：下面 open('a') 会创建它。
      if (error && error.code !== 'ENOENT') throw error
    }
  }

  /** 一句话 → 收件箱里的一行。JSON 行不能含裸换行，否则插件会把它当成两句。 */
  function formatLine(text) {
    const clean = String(text).replace(/\s+/g, ' ').trim()
    if (clean === '') return null
    if (format === 'text') return clean
    const payload = { text: clean }
    for (const key of ['from', 'to', 'speaker']) {
      if (tags[key] !== undefined) payload[key] = tags[key]
    }
    return JSON.stringify(payload)
  }

  return {
    stats,
    /** 追加一行（空白内容会被跳过）。 */
    async write(text) {
      const line = formatLine(text)
      if (line === null) {
        stats.skipped += 1
        return false
      }
      const bytes = Buffer.byteLength(line + '\n', 'utf-8')
      if (dryRun) {
        log.log('[dry-run] ' + line)
      } else {
        if (handle === null) {
          handle = await open(inboxPath, 'a')
        }
        await handle.appendFile(line + '\n', 'utf-8')
      }
      stats.lines += 1
      stats.bytes += bytes
      return true
    },
    async close() {
      if (handle !== null) {
        await handle.close()
        handle = null
      }
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 命令行
// ─────────────────────────────────────────────────────────────────────────────

const HELP = `asr-bridge —— 把语音识别结果送进 leion-pro 的 ASR 收件箱

用法
  node bridge/asr-bridge.mjs --inbox <收件箱路径> [选项]

必填
  --inbox <path>              收件箱文件（要和插件 config 里的 inboxPath 一致）

引擎
  --engine stdin|command|replay|whisper     缺省 stdin
  --command <cmd>             engine=command/whisper 时执行的命令（其 stdout 被转发）
  --replay <file>             engine=replay 时读的转写文本（一行一句）
  --replay-delay-ms <n>       replay 每行之间的间隔，缺省 1200（模拟真人说话节奏）
  --whisper-model <尺寸>      engine=whisper 时的模型：tiny/base/small/medium/large-v3，缺省 small
  --whisper-device <设备>     cpu 或 cuda，缺省 cpu
  --whisper-compute <类型>    int8（CPU）/ float16（GPU），缺省 int8
                              ⚠️ 缺省组合在本机实测是最慢的一档（小句 RTF 1.4，延迟约 2.6 秒）。
                                 有 NVIDIA 显卡时建议 --whisper-device cuda --whisper-compute float16，
                                 实测同样的句子只要 0.1~0.25 秒（延迟约 0.8~1.0 秒）。
                                 数字与测法见 docs/04-语音识别验证.md。
  --whisper-follow <path>     手机端「录音上传」：尾随 relay 追加写的裸 PCM 文件。
                                 给了这个就等于 --engine whisper 且让识别进程跟着文件跑。
                                 **强烈建议用这个，而不是自己在终端里写 python | node 管道**：
                                 Windows PowerShell 的原生命令管道会缓冲 stdout，而尾随模式的
                                 识别进程永不退出 → 缓冲永不刷新 → 桥一行都收不到（踩过）。
                                 走这条路由桥自己 spawn 子进程并流式读 stdout，没有这个问题。

格式
  --format text|json          text=一行原文（插件自动判语向）；json=带标记，缺省 text
  --from <zh-CN|pt-BR>        标记源语种（json 格式时写进行里，等价于插件的 inboxFrom）
  --to <zh-CN|pt-BR>          标记目标语种
  --speaker <them|me>         标记说话人

行为
  --flush-on-pause-ms <n>     停顿超过 n 毫秒就把缓冲区当成一句（0 = 只在换行/回车断句）
                              ASR 若不按句换行，这个值就是字幕的延迟上限
  --truncate                  开始时清空收件箱（演示时从干净的屏开始）
  --dry-run                   只打印将要写入的行，不写盘
  --quiet                     不打印统计
  --help                      显示本帮助

例子
  # 演示（不需要麦克风、不需要 ASR）：重放一段中葡对照的转写
  node bridge/asr-bridge.mjs --inbox /tmp/asr-inbox.jsonl --engine replay --replay bridge/sample-transcript.txt --truncate

  # 任何会往 stdout 打字的 ASR
  whisper-cli -m ggml-small.bin -f audio.wav | node bridge/asr-bridge.mjs --inbox /tmp/asr-inbox.jsonl

  # ASR 不按句换行时，靠停顿断句
  node bridge/asr-bridge.mjs --inbox /tmp/asr-inbox.jsonl --engine command --command "python asr.py" --flush-on-pause-ms 800
`

export function parseArgs(argv) {
  const options = { engine: 'stdin', format: 'text', replayDelayMs: 1200, flushOnPauseMs: 0, quiet: false }
  const takesValue = new Set([
    'inbox', 'engine', 'command', 'replay', 'replay-delay-ms', 'format',
    'from', 'to', 'speaker', 'flush-on-pause-ms',
    'whisper-model', 'whisper-device', 'whisper-compute', 'whisper-follow',
  ])
  const flags = new Set(['truncate', 'dry-run', 'quiet', 'help'])

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new Error(`看不懂的参数：${token}（用 --help 看用法）`)
    const key = token.slice(2)
    if (flags.has(key)) {
      options[key === 'dry-run' ? 'dryRun' : key] = true
      continue
    }
    if (!takesValue.has(key)) throw new Error(`未知选项 --${key}（用 --help 看用法）`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} 需要一个值`)
    index += 1
    if (key === 'replay-delay-ms') options.replayDelayMs = Number(value)
    else if (key === 'flush-on-pause-ms') options.flushOnPauseMs = Number(value)
    else options[key] = value
  }

  if (options.help === true) return options
  if (options.inbox === undefined) throw new Error('必须给 --inbox <收件箱路径>（用 --help 看用法）')
  // --whisper-follow 是"engine=whisper + 尾随文件"的简写：手机录音上传那条路走它最省事
  if (options['whisper-follow'] !== undefined) {
    if (options.engine === 'stdin') options.engine = 'whisper'
    if (options.engine !== 'whisper') {
      throw new Error(`--whisper-follow 只能配 --engine whisper，收到 ${JSON.stringify(options.engine)}`)
    }
  }
  if (!['stdin', 'command', 'replay', 'whisper'].includes(options.engine)) {
    throw new Error(`--engine 只能是 stdin / command / replay / whisper，收到 ${JSON.stringify(options.engine)}`)
  }
  if ((options.engine === 'command' || options.engine === 'whisper') && options.command === undefined) {
    if (options.engine === 'whisper') {
      // whisper 的三个调参选项接到脚本的对应参数上。为什么值得单独开这几个口子：
      // 缺省（small/CPU/int8）在开发机上实测是**最慢**的一档，而它恰好是最容易被
      // 当成"Whisper 就是这么慢"而放弃的组合 —— 换成 GPU 后同样的小句快了一个数量级。
      // 注意：只有自动拼出来的命令才追加这些参数；用户自己写了 --command 就原样执行，
      // 免得"你以为跑的是你的命令，其实被塞了两个参数"。
      let command = `python "${join(HERE, 'whisper_stream.py')}"`
      if (options.from !== undefined) {
        command += ` --language ${options.from === 'zh-CN' ? 'zh' : 'pt'}`
        // ⚠️ **必须同时关掉侧车语种**，否则 `--from` 是**假的**：
        //    whisper_stream 默认听手机发来的 `audio-in.lang`，而且**优先于命令行**；
        //    而安卓那边 `sourceLang` 的缺省值就是 `pt-BR`。
        //    于是 `--from zh-CN` 会被手机的声明覆盖成 pt —— 正好是反的，
        //    而且**安静地**反：识别会把中文"翻"成葡语，日志上看不出异常。
        //    （真实踩到：这是我上一版接线时漏掉的，`--from` 看着生效其实没生效。）
        command += ' --no-sidecar-lang'
      }
      if (options['whisper-follow'] !== undefined) command += ` --follow "${options['whisper-follow']}"`
      if (options['whisper-model'] !== undefined) command += ` --model ${options['whisper-model']}`
      if (options['whisper-device'] !== undefined) command += ` --device ${options['whisper-device']}`
      if (options['whisper-compute'] !== undefined) command += ` --compute-type ${options['whisper-compute']}`
      options.command = command
    } else {
      throw new Error('--engine command 需要 --command <cmd>')
    }
  }
  if (options.engine === 'replay' && options.replay === undefined) {
    throw new Error('--engine replay 需要 --replay <file>')
  }
  for (const key of ['replayDelayMs', 'flushOnPauseMs']) {
    if (!Number.isFinite(options[key]) || options[key] < 0) {
      throw new Error(`${key} 必须是非负数，收到 ${JSON.stringify(options[key])}`)
    }
  }
  return options
}

/** 把装配好的每一句写进收件箱；返回一个 { assembler, writer, finish } 组合。 */
export async function createBridgeSink(options) {
  const writer = await createInboxWriter({
    inboxPath: options.inbox,
    format: options.format,
    tags: { from: options.from, to: options.to, speaker: options.speaker },
    truncate: options.truncate === true,
    dryRun: options.dryRun === true,
  })
  // 串行写入：极快的输入下也不打乱顺序（收件箱的顺序就是字幕的顺序）。
  let pending = Promise.resolve()
  const assembler = createLineAssembler({
    flushOnPauseMs: options.flushOnPauseMs,
    onLine: text => {
      if (options.quiet !== true) {
        process.stdout.write('→ ' + text + '\n')
      }
      pending = pending.then(() => writer.write(text))
    },
  })
  return {
    writer,
    assembler,
    async finish() {
      assembler.flush()
      await pending
      await writer.close()
    },
  }
}

/**
 * 跑桥（CLI 与测试共用）。
 * @returns 处理过的行数
 */
export async function runBridge(options) {
  const sink = await createBridgeSink(options)

  if (options.engine === 'replay') {
    const text = await readFile(options.replay, 'utf-8')
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l !== '')
    for (const line of lines) {
      sink.assembler.push(line + '\n')
      if (options.replayDelayMs > 0) await new Promise(resolve => setTimeout(resolve, options.replayDelayMs))
    }
    sink.assembler.flush()
    await sink.finish()
    return sink.writer.stats.lines
  }

  if (options.engine === 'stdin') {
    process.stdin.setEncoding('utf-8')
    for await (const chunk of process.stdin) sink.assembler.push(chunk)
    await sink.finish()
    return sink.writer.stats.lines
  }

  // command / whisper：起子进程，转发 stdout。
  // 注意：捕获子进程 stdout 需要管道；受限沙箱下这种 spawn 会 EPERM，
  // 所以本桥要在普通终端里跑（那是它的正常使用场景）。
  const child = spawn(options.command, { shell: true, stdio: ['ignore', 'pipe', 'inherit'] })
  const closed = new Promise(resolve => {
    child.on('close', code => resolve(code === null ? 0 : code))
    child.on('error', error => {
      process.stderr.write('[asr-bridge] 无法启动命令：' + String(error && error.message ? error.message : error) + '\n')
      resolve(1)
    })
  })
  child.stdout.setEncoding('utf-8')
  child.stdout.on('data', chunk => sink.assembler.push(chunk))
  const code = await closed
  await sink.finish()
  return code === 0 ? sink.writer.stats.lines : -1
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI 入口
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write('[asr-bridge] ' + String(error && error.message ? error.message : error) + '\n')
    process.exitCode = 2
    return
  }
  if (options.help === true) {
    process.stdout.write(HELP)
    return
  }

  // 收件箱所在目录可能还不存在：插件会等文件出现，但桥得能创建它。
  await mkdir(dirname(options.inbox), { recursive: true })

  if (options.quiet !== true) {
    process.stdout.write(`[asr-bridge] engine=${options.engine} format=${options.format} inbox=${options.inbox}\n`)
    if (options.flushOnPauseMs > 0) {
      process.stdout.write(`[asr-bridge] 停顿 ${options.flushOnPauseMs}ms 即断句（不依赖 ASR 换行）\n`)
    }
  }

  const lines = await runBridge(options)
  if (lines < 0) {
    process.stderr.write('[asr-bridge] 子进程非正常退出，收件箱可能不完整\n')
    process.exitCode = 1
    return
  }
  if (options.quiet !== true) {
    process.stdout.write(`[asr-bridge] 完成：写入 ${lines} 行\n`)
  }
}

const isCli = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isCli) {
  await main()
}
