/**
 * test-asr.mjs —— 指定模型跑 ASR 测试（你要的那个"可以直接调用的脚本"）
 * ============================================================================
 *
 *   node scripts/test-asr.mjs --list                          # 看有哪些测试集、哪些模型
 *   node scripts/test-asr.mjs --set pt-coraa                  # 用缺省模型（large-v3/GPU）跑
 *   node scripts/test-asr.mjs --set pt-coraa --model medium   # 指定模型
 *   node scripts/test-asr.mjs --set pt-coraa --compare        # 跑多个模型并排序
 *   node scripts/test-asr.mjs --set pt-eval --device cpu --compute-type int8
 *   node scripts/test-asr.mjs --set pt-coraa --by-accent      # 按口音分组出分
 *   node scripts/test-asr.mjs --set zh-eval --count 10        # 先跑一小批看趋势
 *
 * ── 设计上的三个决定，都是为了别把事情搞砸 ─────────────────────────────────
 *
 * ① **指标计算不重写，调 bridge/asr_eval.py。**
 *    那个脚本已经把难的地方做对了：中文按**字**算 CER（按词算的话整句是一个 token，
 *    错一个字和整句全错得到同一个数字）、葡语按词算 WER、去标点但保留葡语重音、
 *    单独统计"输出成繁体"这个 Whisper 已知毛病、CUDA 预热（第一次推理十几秒，
 *    不预热会污染第一个样本）。重写一份 = 两个地方的口径迟早漂移。
 *    这个脚本只做**编排 + 汇总 + 结果留存**。
 *
 * ② **测试集自动发现，不用记路径。**
 *    凡是有 manifest.jsonl 的目录就是一个测试集（现在有 zh-eval / pt-eval / pt-coraa）。
 *    加新语料不用改这个脚本。
 *
 * ③ **结果写到 var/logs/asr-eval/，跨次留存。**
 *    这样 --compare 能拿历史结果拼一张对照表，而不是每次都要把模型全跑一遍
 *    （large-v3 在 CPU 上很慢，跑一轮是好几分钟）。
 *
 * ⚠️ 一条会让整个测试**静默作废**的坑，脚本会主动检查：
 *    **采样率**。wav 头写错采样率时，模型听到的是被拉伸的音频 —— 字错率会难看，
 *    但你看不出原因（音频文件本身"没问题"，能播放）。这里对每条音频的实际头做校对，
 *    不是 16 kHz 就明确报警。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

import { WHISPER_CACHE_DIR } from '../lib/paths.mjs'

const ROOT = process.cwd()
const AUDIO_DIR = join(ROOT, 'var', 'audio')
const RESULT_DIR = join(ROOT, 'var', 'logs', 'asr-eval')

/**
 * 给 Python 子进程准备环境变量。
 *
 * ⚠️ 两条都是**照抄 scripts/start-all.mjs 的既有做法**，不是自创：
 *
 *  1. **`HF_HOME` 必须指向仓库里的 `var/cache/hf`**。不设的话 faster-whisper 认的是
 *     默认缓存（`~/.cache/huggingface`），而模型全在仓库缓存里 ——
 *     表现是"明明下过模型，却卡在下载"，然后撞上网络问题报一个**和真实原因无关的错**。
 *     我第一次跑这个脚本就是这样：缓存里 5 个模型都在（连 tiny 都有 77 MB），
 *     却报 `CERTIFICATE_VERIFY_FAILED`。真实原因是缓存目录没告诉它。
 *     （这条在 start-all 里也被一次真实事故逼出来过，见那边的注释。）
 *
 *  2. **`HF_ENDPOINT` 用镜像**。直连 huggingface.co 在本机不通。
 *     用户自己设了就听用户的（和 start-all 的行为一致）。
 *
 *  另外 `PYTHONUTF8` / `PYTHONIOENCODING` 也要设：中文语料的参考文本走 stdout，
 *  Windows 默认 GBK 会直接把打印炸掉（我这次就撞到过 `UnicodeEncodeError: 'gbk'`）。
 */
function childEnv() {
  const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
  if (!env.HF_HOME) env.HF_HOME = WHISPER_CACHE_DIR
  if (!env.HF_ENDPOINT) env.HF_ENDPOINT = 'https://hf-mirror.com'
  return env
}

/**
 * 候选模型。**顺序就是推荐顺序**，不是字母序。
 *
 * 为什么这几个：docs/04 实测过 6 种配置，其中
 *   · large-v3 / CUDA / float16 —— 产线在用的，字错率 3.9%，基准
 *   · medium     / CUDA / float16 —— 98.9% 相对基准，显存更省
 *   · small      / CPU  / int8   —— 纯 CPU 方案，字错率 18.9%（质量分界线）
 *   · base / tiny —— 留在这里是为了**证明它们不能用**（实测输出繁体 + 错字），
 *                   而不是为了推荐。跑它们的价值是给汇报一个"我们试过"的证据。
 */
const MODELS = [
  { name: 'large-v3', device: 'cuda', compute: 'float16', note: '产线在用 · 基准（实测字错率 3.9%）' },
  { name: 'medium', device: 'cuda', compute: 'float16', note: '省显存的次选（实测 CER 7.4%）' },
  { name: 'small', device: 'cuda', compute: 'float16', note: 'GPU 上的小模型' },
  { name: 'small', device: 'cpu', compute: 'int8', note: '纯 CPU 方案（实测 CER 18.9%）' },
  { name: 'base', device: 'cpu', compute: 'int8', note: '⚠️ 已知会把简体输出成繁体' },
  { name: 'tiny', device: 'cpu', compute: 'int8', note: '⚠️ 已知错误多，只作反面对照' },
]

const keyOf = (model, device, compute) => `${model}@${device}/${compute}`

/**
 * 把 `--model <名字>` 解析成一个**被验证过**的配置。
 *
 * ⚠️ 为什么是"查表"而不是"猜"：
 *    第一版按模型名猜设备（只有 large-v3/medium 猜 cuda，其余猜 cpu），
 *    于是 `--model large-v3 --device cpu` 会去跑一个**从没测过的组合** ——
 *    在 CPU 上跑 large-v3 要几分钟/句，而且没人知道那个数字意味着什么。
 *    改成一查表：每个模型对应一条已经量过的配置，
 *    `--device` 只用来**在同一个模型有多条配置时选一条**（现在只有 small 有两条：
 *    CPU/int8 与 GPU/float16，两者实测结果几乎一样）。
 */
function resolveModel(options) {
  const candidates = MODELS.filter(model => model.name === options.model)
  if (candidates.length === 0) {
    console.log(`不认识的模型：${options.model}`)
    console.log('可选的：' + [...new Set(MODELS.map(m => m.name))].join('、'))
    return null
  }
  const chosen = options.device === null
    ? candidates[0]
    : (candidates.find(model => model.device === options.device) ?? candidates[0])
  return {
    ...chosen,
    compute: options.compute ?? chosen.compute,
    note: options.device !== null && chosen.device !== options.device
      ? `（这个模型没有 ${options.device} 的配置，改用 ${chosen.device}）`
      : chosen.note,
  }
}

function parseArgs(argv) {
  const options = {
    set: null, model: null, device: null, compute: null, language: null,
    count: null, compare: false, list: false, byAccent: false, show: 3, keep: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--list') { options.list = true; continue }
    if (token === '--compare') { options.compare = true; continue }
    if (token === '--by-accent') { options.byAccent = true; continue }
    if (token === '--set') { options.set = argv[++index]; continue }
    if (token === '--model') { options.model = argv[++index]; continue }
    if (token === '--device') { options.device = argv[++index]; continue }
    if (token === '--compute-type') { options.compute = argv[++index]; continue }
    if (token === '--language') { options.language = argv[++index]; continue }
    if (token === '--count') { options.count = Number(argv[++index]); continue }
    if (token === '--show') { options.show = Number(argv[++index]); continue }
    throw new Error('看不懂的参数：' + token)
  }
  return options
}

/** 凡是有 manifest.jsonl 的目录就是一个测试集 —— 加语料不用改这个脚本。 */
function listSets() {
  if (existsSync(AUDIO_DIR) === false) return []
  return readdirSync(AUDIO_DIR)
    .filter(name => existsSync(join(AUDIO_DIR, name, 'manifest.jsonl')))
    .map(name => {
      const dir = join(AUDIO_DIR, name)
      const items = readManifest(dir)
      const wavs = readdirSync(dir).filter(file => file.endsWith('.wav'))
      return {
        name, dir, items, wavCount: wavs.length,
        accents: [...new Set(items.map(item => item.accent).filter(Boolean))],
        corpus: items.some(item => item.source) ? 'CORAA（真实口语）' : 'FLEURS（朗读）',
      }
    })
}

function readManifest(dir) {
  const text = readFileSync(join(dir, 'manifest.jsonl'), 'utf8')
  return text.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line))
}

/**
 * 校对音频头 —— 这是唯一会让整个测试**静默作废**的地方。
 *
 * 为什么值得单独查：如果 wav 头写着 16000 但实际是 48000（采样率标错），
 * 模型听到的是**放慢三倍的音频**，识别结果会一塌糊涂，而音频文件本身能正常播放、
 * 看不出任何问题。我生成 CORAA 样本时就**是靠假设**写死的 16000（后来才验证对），
 * 这种事只会在结论做出来之后才被发现。
 */
function checkAudio(dir, limit = 5) {
  const wavs = readdirSync(dir).filter(file => file.endsWith('.wav')).slice(0, limit)
  const bad = []
  for (const name of wavs) {
    const buffer = readFileSync(join(dir, name))
    if (buffer.subarray(0, 4).toString() !== 'RIFF') { bad.push(`${name} 不是 RIFF/wav`); continue }
    const rate = buffer.readUInt32LE(24)
    const bits = buffer.readUInt16LE(34)
    const channels = buffer.readUInt16LE(22)
    if (rate !== 16000) bad.push(`${name} 采样率 ${rate} Hz（期望 16000）`)
    if (bits !== 16) bad.push(`${name} 位深 ${bits}（asr_eval.py 只读 16 位 PCM）`)
    if (channels !== 1) bad.push(`${name} 声道 ${channels}（期望单声道）`)
  }
  return bad
}

function resultPath(setName, modelKey) {
  return join(RESULT_DIR, `${setName}__${modelKey.replace(/[/@]/g, '_')}.json`)
}

/** 调 bridge/asr_eval.py 跑一轮，把它的 JSON 结果读回来。 */
function runOne(set, model, options) {
  mkdirSync(RESULT_DIR, { recursive: true })
  const outJson = resultPath(set.name, keyOf(model.name, model.device, model.compute))
  const args = [
    join(ROOT, 'bridge', 'asr_eval.py'),
    '--set', set.dir,
    '--model', model.name,
    '--device', model.device,
    '--compute-type', model.compute,
    '--out-json', outJson,
    // Python 侧也按 --show 打对照：不然它的总结里会留一句"随机看 0 条对照"，
    // 看起来像功能坏了，其实是没要求它打。
    '--show', String(options.show),
  ]
  if (options.language !== null) args.push('--language', options.language)
  if (options.count !== null) args.push('--count', String(options.count))
  console.log(`\n▶ ${set.name} × ${model.name} / ${model.device} / ${model.compute} …`)
  try {
    // 直接把子进程输出透传（进度点、预热耗时、逐条对照都在里面，别藏起来）
    execFileSync('python', args, { stdio: 'inherit', cwd: ROOT, env: childEnv() })
  } catch (error) {
    return { ok: false, failure: String(error && error.message ? error.message : error) }
  }
  if (existsSync(outJson) === false) return { ok: false, failure: '评测没有写出结果 JSON' }
  return { ok: true, result: JSON.parse(readFileSync(outJson, 'utf8')) }
}

const percent = value => (value === null || value === undefined) ? '—' : (value * 100).toFixed(1) + '%'

/** 把结果按口音分组 —— CORAA 独有（带 accent 标注）。 */
function byAccent(set, result) {
  const groups = new Map()
  const accentOf = new Map(set.items.map(item => [item.file, item.accent ?? '（无标注）']))
  for (const row of result.rows) {
    const accent = accentOf.get(row.file) ?? '（无标注）'
    if (groups.has(accent) === false) groups.set(accent, [])
    groups.get(accent).push(row)
  }
  return [...groups.entries()].map(([accent, rows]) => {
    const units = rows.reduce((sum, row) => sum + row.units, 0)
    const distance = rows.reduce((sum, row) => sum + row.distance, 0)
    return {
      accent, count: rows.length, units,
      rate: units === 0 ? null : distance / units,
      seconds: rows.reduce((sum, row) => sum + row.seconds, 0),
      used: rows.reduce((sum, row) => sum + row.seconds_used, 0),
    }
  }).sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0))
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const sets = listSets()

  if (options.list || sets.length === 0) {
    console.log('测试集（凡是有 manifest.jsonl 的目录）：')
    for (const set of sets) {
      const seconds = set.items.reduce((sum, item) => sum + (item.seconds ?? 0), 0)
      console.log(`  ${set.name.padEnd(12)} ${String(set.items.length).padStart(3)} 条 / ${seconds.toFixed(0)} 秒   ${set.corpus}`
        + (set.accents.length > 0 ? '   口音：' + set.accents.join('、') : ''))
    }
    if (sets.length === 0) console.log('  （一个都没有 —— 先准备语料，见 var/logs/fetch-coraa.mjs）')
    console.log('')
    console.log('候选模型（顺序即推荐顺序）：')
    for (const model of MODELS) {
      console.log(`  ${keyOf(model.name, model.device, model.compute).padEnd(22)} ${model.note}`)
    }
    console.log('')
    console.log('用法：node scripts/test-asr.mjs --set ' + (sets[0]?.name ?? 'zh-eval') + ' [--model large-v3] [--compare]')
    return
  }

  if (options.set === null) {
    console.log('缺 --set。可选的测试集：' + sets.map(set => set.name).join('、'))
    return
  }
  const set = sets.find(item => item.name === options.set)
  if (set === undefined) {
    console.log('没有这个测试集：' + options.set + '（可选：' + sets.map(item => item.name).join('、') + '）')
    return
  }

  console.log('='.repeat(76))
  console.log(`测试集 ${set.name}   ${set.items.length} 条 / ${set.items.reduce((s, i) => s + (i.seconds ?? 0), 0).toFixed(0)} 秒   ${set.corpus}`)
  if (set.accents.length > 0) console.log(`口音标注 ${set.accents.join('、')}`)
  console.log('='.repeat(76))

  const problems = checkAudio(set.dir)
  if (problems.length > 0) {
    console.log('')
    console.log('⚠️ 音频格式有问题 —— 这会让整个测试**静默作废**，先修它：')
    for (const problem of problems) console.log('   · ' + problem)
    console.log('   （采样率标错时，模型听到的是被拉伸的音频，字错率难看但你看不出原因）')
    return
  }
  console.log('音频格式校对通过（16000 Hz / 16 位 / 单声道）')

  if (set.wavCount !== set.items.length) {
    console.log(`⚠️ 目录里有 ${set.wavCount} 个 wav，清单只有 ${set.items.length} 条 —— 多出来的不会被测到`)
  }

  // 决定这次跑哪些组合
  let plan
  if (options.compare) {
    plan = MODELS.filter(model => options.device === null || model.device === options.device)
    if (plan.length === 0) {
      console.log(`没有 device=${options.device} 的候选组合（可选：${[...new Set(MODELS.map(m => m.device))].join('、')}）`)
      return
    }
    if (options.device === null && plan.length < MODELS.length) {
      // 说清为什么不跑全部：CPU 上跑 large-v3 要几分钟，默认不拖这么久
      const skipped = MODELS.filter(m => plan.includes(m) === false).length
      console.log(`（--compare 缺省只跑 GPU 组合；想跑 CPU 那 ${skipped} 个加 --device cpu）`)
    }
  } else if (options.model === null) {
    plan = [MODELS[0]]
    console.log('（没指定 --model，用缺省：' + keyOf(MODELS[0].name, MODELS[0].device, MODELS[0].compute) + '）')
  } else {
    const resolved = resolveModel(options)
    if (resolved === null) return
    console.log(`（--model ${options.model} → ${keyOf(resolved.name, resolved.device, resolved.compute)}；${resolved.note}）`)
    plan = [resolved]
  }

  for (const model of plan) {
    const outcome = runOne(set, model, options)
    if (outcome.ok !== true) {
      console.log(`\n✗ ${model.name} 失败：${outcome.failure}`)
      continue
    }
    const result = outcome.result
    console.log('')
    console.log('─'.repeat(76))
    console.log(`结果 · ${set.name} × ${keyOf(model.name, model.device, model.compute)}`)
    console.log('─'.repeat(76))
    console.log(`  加权错误率    ${percent(result.weightedRate)}   ← 按句长加权，反映整体`)
    console.log(`  按句平均      ${percent(result.meanRate)}`)
    console.log(`  高准确句      ${result.goodCount}/${result.scoredCount} 句 ≤ 10%`)
    if (result.traditionalTotal !== undefined && result.traditionalTotal > 0) {
      console.log(`  ⚠️ 疑似繁体    ${result.traditionalTotal} 字，涉及 ${result.traditionalSentences} 句`
        + '（Whisper 中文的已知毛病，这一项要单独看）')
    }
    console.log(`  语种判定      ${JSON.stringify(result.detections)}`)
    console.log(`  音频/耗时     ${result.audioSeconds.toFixed(1)}s / ${result.usedSeconds.toFixed(1)}s`
      + `（RTF ${(result.usedSeconds / result.audioSeconds).toFixed(3)}，每句 ${(result.usedSeconds / result.rows.length).toFixed(2)}s）`)
    console.log(`  结果已存      ${resultPath(set.name, keyOf(model.name, model.device, model.compute))}`)

    if (options.byAccent && set.accents.length > 0) {
      console.log('')
      console.log('  按口音分组（错误率高的排前面 —— 这就是"口音适配"的答案）：')
      for (const group of byAccent(set, result)) {
        console.log(`    ${group.accent.padEnd(22)} ${String(group.count).padStart(3)} 条  `
          + `错误率 ${percent(group.rate)}  每句 ${(group.used / group.count).toFixed(2)}s`)
      }
    }

    if (options.show > 0) {
      console.log('')
      console.log(`  对照 ${Math.min(options.show, result.rows.length)} 条：`)
      for (const row of result.rows.slice(0, options.show)) {
        console.log(`    参考  ${row.reference}`)
        console.log(`    识别  ${row.hypothesis}`)
        console.log(`    错误率 ${percent(row.rate)}  [${row.seconds.toFixed(2)}s 音频 / ${row.seconds_used.toFixed(2)}s]`)
        console.log('')
      }
    }
  }

  // 汇总：把所有留存的结果按错误率排序 —— 这才是"该选哪个模型"的答案
  if (options.compare) {
    const rows = []
    for (const model of plan) {
      const path = resultPath(set.name, keyOf(model.name, model.device, model.compute))
      if (existsSync(path) === false) continue
      const result = JSON.parse(readFileSync(path, 'utf8'))
      rows.push({ key: keyOf(model.name, model.device, model.compute), ...result })
    }
    if (rows.length > 1) {
      console.log('')
      console.log('='.repeat(76))
      console.log(`对照汇总 · ${set.name}（按错误率升序，**越靠前越好**）`)
      console.log('='.repeat(76))
      console.log('  模型                    错误率    每句耗时   RTF     疑似繁体')
      for (const row of rows.sort((a, b) => a.weightedRate - b.weightedRate)) {
        console.log(`  ${row.key.padEnd(22)} ${percent(row.weightedRate).padStart(6)}   `
          + `${(row.usedSeconds / row.rows.length).toFixed(2)}s`.padStart(7) + '   '
          + (row.usedSeconds / row.audioSeconds).toFixed(3).padStart(6) + '   '
          + String(row.traditionalTotal ?? 0).padStart(6))
      }
      const best = rows[0]
      const worst = rows[rows.length - 1]
      console.log('')
      console.log(`  最好 ${best.key}：${percent(best.weightedRate)}`)
      console.log(`  对照 ${worst.key}：${percent(worst.weightedRate)}`)
      console.log('  提示：错误率差几倍时结论可靠；只差一两个百分点时样本太小，别当结论用。')
    }
  }
}

try {
  main()
} catch (error) {
  console.error('失败：' + String(error && error.message ? error.message : error))
  process.exitCode = 1
}
