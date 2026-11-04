#!/usr/bin/env node
/**
 * asr-doctor.mjs —— 这台机器上「英文识别到底能用哪些模型」的只读体检（5.58）
 * ============================================================================
 *
 * 为什么要有它：用户要"把可选的模型都写好，然后在 App 里试"。可选项取决于**这台机器上
 * 真有什么** —— whisper 权重搬过来没有、venv 里装了什么、显存够不够同时装两个模型。
 * 这些都不该靠猜，也不该靠"装了再说"：
 *
 *   · 猜模型名 → faster-whisper 现场去下几 GB，界面上只表现成"半天没字幕"；
 *   · 猜显存 → `--max-models 2` 在 8G 卡上直接 OOM，看起来像模型坏了。
 *
 * 所以先量，再决定点亮哪些。**只读**：不下载、不安装、不改任何文件。
 *
 * 用法
 *   node scripts/asr-doctor.mjs                          # 用 var/live
 *   node scripts/asr-doctor.mjs --data-dir /var/lib/leion/test
 *   node scripts/asr-doctor.mjs --json var/asr-doctor.json   # 顺手存一份，方便贴回来
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { ENGINE_LANGUAGES, listEngineOptions, loadStrategyTable } from '../lib/asr-engines.mjs'

function parseArgs(argv) {
  const args = { dataDir: '', json: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item === '--data-dir') args.dataDir = argv[index += 1] ?? ''
    else if (item === '--json') args.json = argv[index += 1] ?? ''
    else if (item === '--help' || item === '-h') {
      console.log('用法：node scripts/asr-doctor.mjs [--data-dir <目录>] [--json <输出文件>]')
      process.exit(0)
    } else {
      console.error(`不认识的参数：${item}`)
      process.exit(2)
    }
  }
  return args
}

/** 跑一条命令并把输出拿回来。拉不起来时**如实说拉不起来**（不是"没问题"）。 */
function run(command, argv, timeout = 20000) {
  const result = spawnSync(command, argv, { encoding: 'utf8', timeout })
  if (result.error) return { ok: false, text: '', error: String(result.error.message ?? result.error) }
  if (result.status !== 0) {
    return { ok: false, text: String(result.stdout ?? '').trim(),
      error: String(result.stderr ?? '').trim().split('\n').slice(-1)[0] || `退出码 ${result.status}` }
  }
  return { ok: true, text: String(result.stdout ?? '').trim(), error: '' }
}

const PY_PROBE = [
  'import json, sys',
  'out = {"python": sys.version.split()[0], "packages": {}}',
  'for name in ("faster_whisper", "ctranslate2", "sherpa_onnx", "numpy", "torch", "onnxruntime"):',
  '    try:',
  '        module = __import__(name)',
  '        out["packages"][name] = getattr(module, "__version__", "?")',
  '    except Exception as error:',
  '        out["packages"][name] = "缺失（%s）" % type(error).__name__',
  'print(json.dumps(out, ensure_ascii=False))',
].join('\n')

/** whisper 权重在 HF 缓存里的目录名（只有名字，不猜内容）。 */
function cachedModels() {
  const cacheDir = process.env.HUGGINGFACE_HUB_CACHE
    ?? join(process.env.HF_HOME ?? join(homedir(), '.cache', 'huggingface'), 'hub')
  try {
    return {
      cacheDir,
      models: readdirSync(cacheDir).filter((entry) => entry.startsWith('models--')).sort(),
    }
  } catch (error) {
    return { cacheDir, models: [], problem: String(error?.message ?? error) }
  }
}

function localModelDirs(models) {
  const out = []
  for (const model of models) {
    if (!/[\\/]/.test(model)) continue
    out.push({ path: model, exists: existsSync(model),
      sizeMb: existsSync(model) ? Math.round(dirSizeMb(model)) : 0 })
  }
  return out
}

function dirSizeMb(path, depth = 0) {
  if (depth > 2) return 0
  let total = 0
  try {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name)
      if (entry.isDirectory()) total += dirSizeMb(full, depth + 1)
      else total += statSync(full).size
    }
  } catch {
    return 0
  }
  return total / (1024 * 1024)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const dataDir = args.dataDir || process.env.LEION_DATA_DIR || join(process.cwd(), 'var', 'live')
  const report = { at: new Date().toISOString(), dataDir, node: process.version, problems: [] }

  console.log(`识别环境体检（只读，不装不下载）\n数据目录：${dataDir}\n`)

  // ── 1. 策略表 ─────────────────────────────────────────────────────────────
  const loaded = loadStrategyTable(dataDir)
  console.log('【策略表】')
  if (!loaded.found) {
    console.log(`  ✗ ${loaded.path} 不存在 —— App 里只会有一条「服务器默认」`)
    report.problems.push(`策略表不存在：${loaded.path}`)
  } else if (loaded.problem) {
    console.log(`  ✗ ${loaded.path}：${loaded.problem}`)
    report.problems.push(`策略表读不了：${loaded.problem}`)
  } else {
    console.log(`  ✓ ${loaded.path}`)
  }
  const listing = {}
  for (const lang of ENGINE_LANGUAGES) {
    const listed = listEngineOptions(loaded.table, lang)
    listing[lang] = listed
    console.log(`  · ${lang}：当前 ${listed.current.label}`)
    for (const option of listed.options) {
      const mark = option.available === 'present' ? '✓' : option.available === 'missing' ? '✗' : '?'
      console.log(`      ${mark} ${option.label}  [${option.strategies.join(', ')}] ${option.hint}`)
    }
  }
  report.listing = listing

  // ── 2. Python 那边装了什么 ────────────────────────────────────────────────
  const python = process.env.LEION_PYTHON || 'python3'
  let pythonProbe = run(python, ['-c', PY_PROBE])
  if (!pythonProbe.ok && python === 'python3') pythonProbe = run('python', ['-c', PY_PROBE])
  console.log('\n【Python 依赖】')
  if (!pythonProbe.ok) {
    // 拉不起来要**说出来**：那意味着医生脚本自己看不到识别环境，不是"环境没问题"
    console.log(`  ? 探不到（${pythonProbe.error}）—— 用 --data-dir 之外，还要在装 faster-whisper 的那个 venv 里跑`)
    report.problems.push(`探不到 python：${pythonProbe.error}`)
    report.python = null
  } else {
    try {
      report.python = JSON.parse(pythonProbe.text)
      console.log(`  · python ${report.python.python}`)
      for (const [name, version] of Object.entries(report.python.packages)) {
        const bad = version.startsWith('缺失')
        console.log(`  ${bad ? '✗' : '✓'} ${name} ${version}`)
      }
    } catch (error) {
      console.log(`  ? 输出解析不了：${String(error.message)}`)
      report.problems.push('python 探测输出解析不了')
    }
  }

  // ── 3. 权重在不在（HF 缓存 / 本地目录）─────────────────────────────────────
  const cache = cachedModels()
  console.log('\n【whisper 权重】')
  console.log(`  缓存目录：${cache.cacheDir}`)
  if (cache.problem) {
    console.log(`  ? 读不到（${cache.problem}）—— 那 App 里的模型会显示「未确认」`)
  } else if (cache.models.length === 0) {
    console.log('  （缓存里没有任何模型：第一次用会去下载）')
  } else {
    for (const model of cache.models) console.log(`  · ${model}`)
  }
  report.cache = cache
  const locals = localModelDirs([...new Set((loaded.table?.strategies ? Object.values(loaded.table.strategies) : [])
    .map((entry) => entry?.model).filter(Boolean))])
  if (locals.length > 0) {
    console.log('\n【策略表里写的本地目录】')
    for (const item of locals) {
      console.log(`  ${item.exists ? '✓' : '✗'} ${item.path}${item.exists ? `（约 ${item.sizeMb} MB）` : ''}`)
    }
    report.localModels = locals
  }

  // ── 4. 显存：决定"能不能同时装两个模型" ──────────────────────────────────
  const gpu = run('nvidia-smi', ['--query-gpu=name,memory.total,memory.used', '--format=csv,noheader'])
  console.log('\n【GPU】')
  if (!gpu.ok) {
    console.log(`  ? 读不到（${gpu.error}）—— 没有 nvidia-smi 就只能按 CPU 估，别开 --max-models 2`)
  } else {
    for (const line of gpu.text.split('\n')) console.log(`  · ${line}`)
    report.gpu = gpu.text
    const first = Number((gpu.text.split('\n')[0] ?? '').split(',').map((part) => part.trim())[1]
      ?.replace(/[^\d.]/g, ''))
    if (Number.isFinite(first) && first > 0 && first < 12) {
      console.log(`  ⚠️ 显存 ${first} GB：A/B 换模型时建议 --max-models 1（同时装两个容易 OOM，`
        + '而 OOM 的表现只是"识别卡住"，很难查）')
      report.problems.push(`显存只有 ${first} GB，A/B 时建议 --max-models 1`)
    }
  }

  // ── 5. 结论 ───────────────────────────────────────────────────────────────
  console.log('\n【结论】')
  const present = Object.values(listing)
    .flatMap((listed) => listed.options)
    .filter((option) => option.available === 'present')
    .map((option) => option.label)
  console.log(present.length > 0
    ? `  本机已有：${[...new Set(present)].join('、')}`
    : '  本机缓存里一个都没确认到：第一次选哪个都会先下载（几分钟到十几分钟）')
  console.log('  体检只读：没有下载、没有安装、没有改文件。')
  if (report.problems.length > 0) {
    console.log('  需要注意：')
    for (const item of report.problems) console.log(`   · ${item}`)
  }

  if (args.json) {
    writeFileSync(args.json, JSON.stringify(report, null, 2), 'utf-8')
    console.log(`\n已写 ${args.json}（贴这个文件比贴屏幕更全）`)
  }
  return 0
}

process.exit(main())
