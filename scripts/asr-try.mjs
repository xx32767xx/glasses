#!/usr/bin/env node
/**
 * asr-try.mjs —— 单独试识别：一段音频（或队列里现有的几段）直接进引擎（5.99）
 * ============================================================================
 *
 * 为什么要有它（用户原话：「还是没有输出 我建议单独测试识别功能」）：
 * 手机上说完话到眼镜上出字幕之间有四层 —— 转发 → 切句 → 识别 → 大脑。
 * 四层里任何一层坏了，表现都是**一模一样**的"没字幕"，而日志又都是异步交错的，
 * 很难一眼看出是哪一层。这个脚本把中间几层全部拆掉，只回答一个问题：
 *
 *   「这份引擎 + 这个模型 + 这段音频，到底出不出字？多久出？报什么错？」
 *
 * 三种用法（都**只读**，不改任何配置、不删队列里的段）：
 *
 *   node scripts/asr-try.mjs --data-dir /var/lib/leion/test                    # 试队列里现有的段
 *   node scripts/asr-try.mjs --wav /tmp/fala.wav --lang pt-BR                  # 试一个 wav
 *   node scripts/asr-try.mjs --pcm /tmp/fala.pcm --rate 16000 --lang pt-BR     # 试裸 PCM
 *
 * 退出码（**必须能区分**，混成一个"失败"就等于让人回去猜）：
 *   0 = 至少有一段出字
 *   3 = 引擎正常但没出字（"这段音频本身听不出东西"）
 *   2 = 配置/依赖/加载就没过（"根本没跑到识别"）
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

function parseArgs(argv) {
  const args = {
    dataDir: '',
    dataDirExplicit: false,
    modelMap: '',
    lang: '',
    queue: '',
    wav: '',
    pcm: '',
    rate: 0,
    offset: 0,
    seconds: 0,
    python: process.env.LEION_PYTHON || '',
    device: '',
    engine: '',
    model: '',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item === '--data-dir') {
      args.dataDir = argv[index += 1] ?? ''
      args.dataDirExplicit = args.dataDir !== ''
    }
    else if (item === '--model-map') args.modelMap = argv[index += 1] ?? ''
    else if (item === '--lang') args.lang = argv[index += 1] ?? ''
    else if (item === '--queue') args.queue = argv[index += 1] ?? ''
    else if (item === '--wav') args.wav = argv[index += 1] ?? ''
    else if (item === '--pcm') args.pcm = argv[index += 1] ?? ''
    else if (item === '--rate') args.rate = Number(argv[index += 1] ?? 0)
    else if (item === '--offset') args.offset = Number(argv[index += 1] ?? 0)
    else if (item === '--seconds') args.seconds = Number(argv[index += 1] ?? 0)
    else if (item === '--python') args.python = argv[index += 1] ?? ''
    else if (item === '--device') args.device = argv[index += 1] ?? ''
    else if (item === '--engine') args.engine = argv[index += 1] ?? ''
    else if (item === '--model') args.model = argv[index += 1] ?? ''
    else if (item === '--help' || item === '-h') {
      console.log('用法：node scripts/asr-try.mjs [--data-dir 目录] [--queue 队列目录] '
        + '[--wav 文件 | --pcm 文件 --rate 16000] [--offset 秒] [--seconds 秒] '
        + '[--lang pt-BR] [--engine 引擎] [--model 模型]')
      console.log('  不给 --queue/--wav/--pcm 时，默认试 <data-dir>/queue/asr 里现有的段')
      console.log('  队列空了也没关系：它会列出 <data-dir>/audio/<房间>/<说话人>.pcm，'
        + '切一段来试即可（--pcm … --rate 16000 --offset 0 --seconds 8）')
      process.exit(0)
    } else {
      console.error(`不认识的参数：${item}`)
      process.exit(2)
    }
  }
  return args
}

/** 找能用的 python：`--python` → `$LEION_PYTHON` → `$VIRTUAL_ENV/bin/python` → python。 */
function pickPython(explicit) {
  if (explicit) return explicit
  const venv = (process.env.VIRTUAL_ENV ?? '').trim()
  if (venv) {
    const candidate = join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    if (existsSync(candidate)) return candidate
  }
  return process.platform === 'win32' ? 'python' : 'python3'
}

/**
 * 定数据目录：`--data-dir` 最优先；其次是**从音频路径反推**（`<data>/audio/<房间>/x.pcm`）；
 * 再其次 `$LEION_DATA_DIR`；最后才是默认值。
 *
 * <p>为什么要反推：实测第一次跑就踩了 —— 用户只给了 `--pcm /var/lib/leion/test/audio/...`，
 * 而环境里 `LEION_DATA_DIR` 指向 **live**，于是模型表被去 `/var/lib/leion/live` 找，
 * 找不到就按命令行默认（whisper/small），最后测的**根本不是要测的那个引擎**。
 * 音频路径本身已经说明了它属于哪个数据目录，这个信号比环境变量可靠。
 *
 * @returns {{dataDir: string, from: string}}
 */
function resolveDataDir(args) {
  if (args.dataDirExplicit) return { dataDir: args.dataDir, from: '--data-dir' }
  const path = args.pcm || args.wav
  if (path) {
    const parts = String(path).replace(/\\/g, '/').split('/')
    const index = parts.lastIndexOf('audio')
    if (index > 0) {
      return { dataDir: parts.slice(0, index).join('/') || '/', from: `音频路径反推（…/audio/… 的上两级）` }
    }
  }
  const envDir = (process.env.LEION_DATA_DIR ?? '').trim()
  if (envDir) return { dataDir: envDir, from: '$LEION_DATA_DIR' }
  if (existsSync('/var/lib/leion/test')) return { dataDir: '/var/lib/leion/test', from: '默认（这台机器上有它）' }
  return { dataDir: 'var/test', from: '默认' }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const resolved = resolveDataDir(args)
  args.dataDir = resolved.dataDir
  const queueDir = args.queue || join(args.dataDir, 'queue', 'asr')
  const modelMap = args.modelMap || join(args.dataDir, 'asr-models.json')
  console.log(`[try] 数据目录 ${args.dataDir}（来自 ${resolved.from}）`)
  if (!existsSync(modelMap)) {
    console.log(`[try] ⚠️ 这个数据目录里没有模型表 ${modelMap} —— 语种/引擎会退回命令行默认，`
      + '测的可能不是你以为的那个引擎。用 --data-dir 指对，或 --model-map 直接给表')
  }

  const command = [join('bridge', 'whisper_stream.py')]
  if (args.pcm) {
    if (!existsSync(args.pcm)) {
      console.error(`找不到 ${args.pcm}`)
      return 2
    }
    if (!(args.rate > 0)) {
      console.error('裸 PCM 必须给 --rate（队列里的段是 16000）')
      return 2
    }
    command.push('--try-audio', args.pcm, '--try-rate', String(args.rate))
    if (args.offset > 0) command.push('--try-offset', String(args.offset))
    if (args.seconds > 0) command.push('--try-seconds', String(args.seconds))
  } else if (args.wav) {
    if (!existsSync(args.wav)) {
      console.error(`找不到 ${args.wav}`)
      return 2
    }
    command.push('--try-audio', args.wav)
    if (args.offset > 0) command.push('--try-offset', String(args.offset))
    if (args.seconds > 0) command.push('--try-seconds', String(args.seconds))
  } else {
    if (!existsSync(queueDir)) {
      console.error(`找不到队列目录 ${queueDir}\n`
        + '  要试单个文件请用 --wav / --pcm；要试队列，先用 start-multi 让流水线跑出一段')
      return 2
    }
    const pending = readdirSync(queueDir).filter((name) => name.endsWith('.json')).length
    console.log(`[try] 队列 ${queueDir} 里有 ${pending} 段待处理（试测**不会**删除它们）`)
    command.push('--try-queue', queueDir)
  }
  if (args.lang) command.push('--language', args.lang)
  if (args.device) command.push('--device', args.device)
  if (args.engine) command.push('--engine', args.engine)
  if (args.model) command.push('--model', args.model)
  if (existsSync(modelMap)) {
    console.log(`[try] 模型表 ${modelMap}`)
    command.push('--model-map', modelMap)
  } else {
    console.log(`[try] 没有模型表 ${modelMap}（就按命令行那套跑）`)
  }
  if (args.pcm && !args.lang) {
    // 分轨文件旁边有 `.lang` 旁文件（relay 写的），读它比自己猜语种可靠得多
    const langSidecar = `${args.pcm}.lang`
    if (existsSync(langSidecar)) {
      try {
        const tag = readFileSync(langSidecar, 'utf-8').trim()
        if (tag) {
          console.log(`[try] 语种取自旁文件 ${langSidecar}：${tag}`)
          command.push('--language', tag)
        }
      } catch { /* 读不到就按自动判定 */ }
    }
  }
  command.push('--data-dir', args.dataDir)
  command.push('--no-warmup')

  const python = pickPython(args.python)
  console.log(`[try] ${python} ${command.join(' ')}`)
  // stdio: 'inherit' —— 让引擎的日志原样打到终端（不要吞进缓冲区，见 whisper_stream 头部说明）
  const result = spawnSync(python, command, {
    stdio: 'inherit',
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  })
  if (result.error) {
    console.error(`[try] ✗ 起不了 python：${result.error.message}`)
    return 2
  }
  const code = result.status ?? 1
  const meaning = {
    0: '至少有一段出字 —— 识别这一层是好的，问题在它上面（转发/切句/大脑）',
    3: '引擎正常但没出字 —— 这段音频本身没东西，或者模型/语言没配好',
    2: '配置/依赖/加载就没过 —— 根本没跑到识别',
  }[code] ?? `退出码 ${code}（看上面的输出）`
  console.log(`\n[try] 退出码 ${code}：${meaning}`)
  return code
}

process.exit(main())
