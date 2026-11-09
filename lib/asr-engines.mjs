/**
 * asr-engines.mjs —— 把「识别策略表」摊成手机能选的一份清单（5.58）
 * ============================================================================
 *
 * 为什么要有这一层：用户要「在 App 上换识别模型测」。要做到这一点，必须先能让手机
 * **知道有哪些可选**，而不是让它猜一个模型名报上来。猜的代价不是报错，是**静默下载**：
 * 一个不存在的尺寸名会让 faster-whisper 现场去下几 GB，界面上只是"半天没字幕"。
 *
 * 权威仍在 Python 侧（`bridge/whisper_stream.py` 的 `resolve_strategy` 才是真正决定
 * 用哪个引擎/模型的那份逻辑）。这里**只做展示用**的合并，故意只覆盖 engine/model 两个
 * 字段（这一层只用于**展示**）。⚠️ 5.108 起「手机把选择写进房间侧车」那条路已整体删除：
 * 用哪个模型只由服务器上的 sr-models.json 决定（见 docs/26）。
 *
 * 可用性（`available`）的三种取值，都**如实**报，不猜：
 *   · `present`    本地已有（路径存在，或 HF 缓存里有同名目录）
 *   · `missing`    写了具体路径但那个路径不存在 —— 选了必然加载失败
 *   · `unverified` 只是个尺寸名，本机缓存里没找到 —— 首次用会去下载（可能要几分钟）
 */

import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 引擎名：小写字母/数字/下划线/连字符（会出现在日志与配置里）。 */
export const ENGINE_NAME = /^[a-z0-9_-]{1,32}$/

/** 手机可以按语言选模型的语种（与 relay / Python 侧一致）。 */
export const ENGINE_LANGUAGES = ['zh-CN', 'pt-BR', 'en-US']

/**
 * 允许写进表里的 `compute_type`（5.148）。
 *
 * <p>为什么要白名单：写错一个（例如 `fp16` 给了 whisper / `float16` 给了 parakeet）
 * 不会在写表时报错，而是**每一段识别都失败** —— 现场表现是"字幕全空"，最难查。
 * 这张表与 `check-asr-env.py` / `whisper_stream.resolve_compute_type` 的取值一致。
 */
export const COMPUTE_TYPES = ['float16', 'int8_float16', 'int8_float32', 'int8', 'float32', 'fp16', 'fp32']

const DEFAULT_ENGINE = 'whisper'
const MODEL_FIELDS = ['engine', 'model', 'compute_type', 'beam_size']

/**
 * 读 JSON，**容忍 BOM**。
 *
 * <p>为什么单独写：Windows 上的编辑器（记事本、PowerShell 的 `Out-File -Encoding UTF8`）
 * 会在文件头写一个 BOM，而 `JSON.parse` 和 Python 的 `json.load(utf-8)` 都会因此**整份失败**。
 * 表读不了时识别侧的表现是"退回命令行那套"—— 不报错、只是模型换了，最难查。
 * 这里容错读，并由调用方（`scripts/asr-models-merge.mjs`）把 BOM 这件事说出来。
 */
export function parseJsonLoose(text) {
  const body = String(text ?? '').replace(/^\uFEFF/, '')
  return { value: JSON.parse(body), hadBom: body.length !== String(text ?? '').length }
}

/** 读策略表：`<数据目录>/asr-models.json`。读不到是**正常情况**（没配表就用内置缺省）。 */
export function loadStrategyTable(root, readFile = readFileSync) {
  const path = join(String(root ?? ''), 'asr-models.json')
  let text = null
  try {
    text = readFile(path)
  } catch {
    return { table: null, path, problem: '', found: false }
  }
  try {
    const { value } = parseJsonLoose(text)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { table: null, path, problem: '策略表顶层必须是一个对象', found: true }
    }
    return { table: value, path, problem: '', found: true }
  } catch (error) {
    // 表写坏了要说出来（热改表写错一个逗号是最常见的手误），但**不抛**：
    // 列清单失败不该让开会话失败。
    return { table: null, path, problem: `策略表读不了：${String(error?.message ?? error)}`, found: true }
  }
}

/** 叠一层：与 Python 的 `merge_strategy` 同规则（空值不覆盖）。 */
export function mergeLayer(base, layer) {
  const merged = { ...base }
  if (layer === null || typeof layer !== 'object' || Array.isArray(layer)) return merged
  for (const key of MODEL_FIELDS) {
    const value = layer[key]
    if (value === undefined || value === null || value === '') continue
    merged[key] = value
  }
  return merged
}

/** 语言行里写的策略名（与 Python 同优先级：languages[lang].strategy → default.strategy → "default"）。 */
export function strategyNameOf(table, lang) {
  const languages = table?.languages && typeof table.languages === 'object' ? table.languages : {}
  const entry = languages[lang]
  const named = entry && typeof entry === 'object' && typeof entry.strategy === 'string'
    ? entry.strategy.trim()
    : ''
  if (named) return named
  const fallback = typeof table?.default?.strategy === 'string' ? table.default.strategy.trim() : ''
  return fallback || 'default'
}

/** 某个策略在某个语言下最终落到哪个引擎/模型（只算 engine/model，切句不看）。 */
export function resolveProfile(table, lang, strategy) {
  const base = { engine: DEFAULT_ENGINE, model: '' }
  const withDefault = mergeLayer(base, table?.default)
  const withStrategy = mergeLayer(withDefault, table?.strategies?.[strategy])
  // 语言行里的**非策略字段**（例如直接写 model）也要生效 —— 与 Python 的叠加顺序一致
  return mergeLayer(withStrategy, table?.languages?.[lang])
}

/** 5.109：切句那六个字段的缺省值（与 Python 的 `SEGMENTATION_DEFAULTS` 逐字一致）。 */
export const SEGMENTATION_DEFAULTS = {
  silence_ms: 800,
  min_speech_ms: 500,
  max_speech_ms: 30000,
  short_utterance_ms: 800,
  short_silence_ms: 1100,
  cut_pause_ms: 200,
}

/**
 * 算出一门语言**最终生效**的整份配置（5.109）：引擎/模型 + 切句六项 + 两个电平门槛。
 *
 * <p>为什么要它：`asr-model-switch` 的"只看现在是什么"以前只报引擎/模型 ——
 * 而现场问得最多的是"现在切句多少毫秒、门槛多少"。缺省的六个切句值原来在 Python 里，
 * 这里再写一份就必须**逐字一致**（有断言盯着 `SEGMENTATION_DEFAULTS` 与 Python 同值）。
 */
export function resolveEffective(table, lang, strategy) {
  const profile = resolveProfile(table, lang, strategy)
  const segmentation = { ...SEGMENTATION_DEFAULTS }
  const levels = {}
  const layers = [table?.default, table?.strategies?.[strategy], table?.languages?.[lang]]
  for (const layer of layers) {
    if (layer === null || typeof layer !== 'object' || Array.isArray(layer)) continue
    if (layer.segmentation && typeof layer.segmentation === 'object') {
      for (const [key, value] of Object.entries(layer.segmentation)) {
        const number = Number(value)
        if (Number.isFinite(number) && number > 0) segmentation[key] = number
      }
    }
    // 5.109：电平门槛不在 MODEL_FIELDS 里（mergeLayer 只搬运那四个），所以这里自己叠
    for (const key of Object.keys(LEVEL_LIMITS)) {
      const value = layer[key]
      if (value === undefined || value === null || value === '') continue
      const number = Number(value)
      if (Number.isFinite(number) && number > 0) levels[key] = number
    }
  }
  return { ...profile, segmentation, levels }
}

/**
 * 猜不出"本机有没有这个模型"时**如实说猜不出**。
 *
 * 判据只有两条能确定的：写了路径就看路径在不在；写了尺寸名就看 HF 缓存里
 * 有没有名字里带它的 `models--*` 目录。两者都不成立就是 `unverified`（首次用会下载）。
 * 云端引擎（`tencent` / `funasr`）另算 `cloud`：它没有"本地在不在"这回事，
 * 可用与否取决于密钥 —— 显示成"首次会下载"会让人以为在等下载。
 */
export function probeModel(model, options = {}, engine = 'whisper') {
  const name = String(model ?? '').trim()
  if (engine === 'tencent' || engine === 'funasr') {
    return { state: 'cloud', hint: `云端接口（编码 ${name || '?'}，需要密钥）` }
  }
  if (name === '') return { state: 'missing', hint: '策略表里没写模型名' }
  const exists = options.exists ?? existsSync
  if (/[\\/]/.test(name) || name.startsWith('.')) {
    return exists(name)
      ? { state: 'present', hint: '本地目录' }
      : { state: 'missing', hint: '这个路径不存在' }
  }
  const cacheDir = options.hubCache
    ?? process.env.HUGGINGFACE_HUB_CACHE
    ?? join(process.env.HF_HOME ?? join(homedir(), '.cache', 'huggingface'), 'hub')
  try {
    const list = (options.listDir ?? readdirSync)(cacheDir)
    const hit = list.find((entry) => entry.startsWith('models--') && entry.includes(name))
    if (hit) return { state: 'present', hint: `HF 缓存 ${hit}` }
    return { state: 'unverified', hint: '本机缓存里没找到，首次使用会去下载' }
  } catch {
    return { state: 'unverified', hint: '没有 HF 缓存目录，首次使用会去下载' }
  }
}

/**
 * 摊成手机要的清单：`{lang, current, options[]}`。
 *
 * **一条可选 = 一个「引擎 + 模型」组合**，不是策略名。为什么这样切：
 * 用户要测的是"换模型识别得准不准"，而策略里还混着切句参数 —— 把两件事塞进一个下拉框，
 * 测出来的差异就说不清是模型还是切句造成的。所以清单按 (engine, model) 去重，
 * 策略名只用来**说明这个组合是怎么配出来的**（`strategies` 字段），切句仍按服务器那套走。
 *
 * 候选来源：`default` + 表里每个具名策略。语言行不参与（它只决定"当前是谁"），
 * 否则给 en-US 加一个 model 就会把别的语种的候选也带歪。
 *
 * **`langs`（可选）**：策略里写了 `"langs": ["en-US"]` 就只在该语种的清单里出现。
 * 为什么需要：纯英文模型（distil-large-v3 / 英文微调）出现在中文那一栏，用户一选就是
 * 满屏乱码 —— 比"选项少"糟得多。没写 `langs` = 所有语种可用（多语模型就该这样）。
 * ⚠️ 但**当前正在用的那一条永远保留**：把"在用的东西"从清单里藏掉，
 * 用户会以为"服务器没配"，而其实正在跑。
 *
 * 不去枚举 faster-whisper 的所有尺寸：表就是白名单 —— 手机只能选**运维真的配过**的东西。
 */
export function listEngineOptions(table, lang, probe = probeModel) {
  const inTable = table && typeof table === 'object' ? table : {}
  const strategies = inTable.strategies && typeof inTable.strategies === 'object' ? inTable.strategies : {}
  const hasTable = Object.keys(inTable).length > 0
  if (!hasTable) {
    // 表都没有：只报"服务器默认"一条。⚠️ 不编造模型名 —— 编一个出来，
    // 手机就会把它当成"服务器收到了这个模型"显示，那是假信息。
    const fallback = {
      strategy: 'default', engine: DEFAULT_ENGINE, model: '',
      label: '服务器默认', note: '服务器上没有策略表：按启动参数那套模型', available: 'unverified',
      hint: '按启动参数', strategies: [], current: true,
    }
    return { lang, tableFound: false, current: fallback, options: [fallback] }
  }

  const currentName = strategyNameOf(inTable, lang)
  const currentProfile = resolveProfile(inTable, lang, currentName)
  const currentKey = keyOf(currentProfile.engine, currentProfile.model)

  const byKey = new Map()
  const candidates = [['default', {}], ...Object.entries(strategies)]
  const skippedByLang = []
  for (const [name, layer] of candidates) {
    const profile = mergeLayer(mergeLayer({ engine: DEFAULT_ENGINE, model: '' }, inTable.default), layer)
    const key = keyOf(profile.engine, profile.model)
    const existing = byKey.get(key)
    const allowed = typeof layer?.langs === 'undefined' ? true : langAllowed(layer.langs, lang)
    if (existing) {
      // 同一个模型被多个策略引用：只要有一条允许当前语种，它对当前语种就算允许
      if (allowed) existing.strategies.push(name)
      continue
    }
    if (!allowed && key !== currentKey) {
      skippedByLang.push(name)
      continue
    }
    const probed = probe(profile.model, {}, String(profile.engine ?? DEFAULT_ENGINE))
    byKey.set(key, {
      strategy: name,
      engine: String(profile.engine ?? DEFAULT_ENGINE),
      model: String(profile.model ?? ''),
      label: labelOf(profile.engine, profile.model),
      note: typeof layer?.note === 'string' ? layer.note : '',
      available: probed.state,
      hint: probed.hint,
      strategies: [name],
      current: key === currentKey,
    })
  }
  const options = [...byKey.values()]
  // 当前这一条排最前（用户先看到"现在用的是哪个"），其余按名字排。
  options.sort((left, right) => (Number(right.current) - Number(left.current))
    || left.label.localeCompare(right.label))
  const current = options.find((option) => option.current) ?? {
    strategy: currentName, engine: String(currentProfile.engine ?? DEFAULT_ENGINE),
    model: String(currentProfile.model ?? ''), label: labelOf(currentProfile.engine, currentProfile.model),
    note: '', available: probe(currentProfile.model, {}, String(currentProfile.engine ?? DEFAULT_ENGINE)).state,
    hint: '', strategies: [currentName],
    current: true,
  }
  if (!options.some((option) => option.current)) options.unshift(current)
  return { lang, tableFound: true, current, options, skippedByLang }
}

/** 策略里的 `langs` 是否允许这个语种（缺省/写坏了都按"允许"处理，宁多勿少）。 */
function langAllowed(langs, lang) {
  if (!Array.isArray(langs) || langs.length === 0) return true
  return langs.some((one) => String(one).trim() === lang)
}



/**
 * 把某个语种直接钉到某个模型（5.68：**服务器端**切换，不依赖手机）。
 *
 * <p>为什么要有这条路：手机端那条链路（选择 → 侧车 → 识别）已经能跑通，但每验一次
 * 都要"改配置 → 开始 → 说话"，来回几轮很慢；而模型对比本质上只需要"现在用哪个模型"。
 * 那就让服务器一条命令说了算。
 *
 * <p>改的是 `languages[语种].model` 这一层 —— 它在优先级里**高于**策略表和 default，
 * 就是唯一决定点，所以改完立刻影响所有新段（⚠️ 5.108 起房间侧车那一层已删除）。
 *
 * @returns {{table: object, before: string, after: string}}
 */
export function setLanguageModel(table, lang, model) {
  const next = JSON.parse(JSON.stringify(table && typeof table === 'object' ? table : {}))
  next.languages = next.languages && typeof next.languages === 'object' ? next.languages : {}
  const current = next.languages[lang]
  const asObject = current && typeof current === 'object' && !Array.isArray(current)
    ? { ...current }
    : (typeof current === 'string' ? { model: current } : {})
  const before = typeof asObject.model === 'string' ? asObject.model : ''
  if (model === '' || model === null || model === undefined) delete asObject.model
  else asObject.model = String(model)
  next.languages[lang] = asObject
  return { table: next, before, after: asObject.model ?? '' }
}

function keyOf(engine, model) {
  return `${String(engine ?? DEFAULT_ENGINE).trim().toLowerCase()}|${String(model ?? '').trim()}`
}

/** 5.109：两个"电平"旋钮的合法范围（超出就报错，不悄悄夹到边界）。 */
export const LEVEL_LIMITS = {
  // ⚠️ 上限刻意压到 0.1：0.2 这种值会把**正常说话**整段丢掉（表现是"一句字幕都没有"），
  //    而写的人多半是想写 0.02 却多打了一个 0。宁可当场报错。
  silence_skip_level: {
    min: 0.001, max: 0.1,
    hint: '识别侧：整段解码前按电平丢弃（缺省 0.02；说话轻调到 0.006~0.010）。只对 whisper 有效',
  },
  rms_threshold: {
    min: 0.001, max: 0.1,
    hint: '切句侧固定门槛（缺省 0.01）。⚠️ 自适应模式（缺省开）下只在开头 2 秒起作用，之后由 rms_floor 决定',
  },
  rms_floor: {
    min: 0.001, max: 0.1,
    hint: '切句侧自适应下限（缺省 0.004）：实际门槛 = max(它, 噪声底×4)。想更灵敏就调小',
  },
}

/**
 * 把若干"调参"字段写进 `languages[语种]`（5.109）。
 *
 * <p>为什么写在这一层：语种那一行**优先级最高**（高于 strategies / default），
 * 所以"我只调葡语、别动中文"用一条命令就够；同时也天然满足"改完下一段生效"。
 *
 * <p>为什么要校验范围：这些值**错一个数量级**的后果完全看不见 ——
 * `silence_skip_level: 0.2` 会把正常说话全丢掉（表现是"一句字幕都没有"），
 * `rms_threshold: 0.5` 会让切句永远判"没人说话"（表现是"录音是空的"）。
 * 所以越界**直接报错**，不夹到边界、也不静默忽略。
 *
 * @param {object} table 现有表
 * @param {string} lang  语种标签
 * @param {Object<string, number|null>} values 要写的字段（null = 删掉这一项）
 * @returns {{table: object, written: string[], removed: string[], problems: string[]}}
 */
export function setLanguageTuning(table, lang, values) {
  const next = JSON.parse(JSON.stringify(table && typeof table === 'object' ? table : {}))
  next.languages = next.languages && typeof next.languages === 'object' ? next.languages : {}
  const current = next.languages[lang]
  const asObject = current && typeof current === 'object' && !Array.isArray(current)
    ? { ...current }
    : (typeof current === 'string' ? { model: current } : {})
  const written = []
  const removed = []
  const problems = []
  for (const [key, raw] of Object.entries(values ?? {})) {
    const limit = LEVEL_LIMITS[key]
    if (limit === undefined) {
      problems.push(`${key} 不是可调的字段（只有 ${Object.keys(LEVEL_LIMITS).join(' / ')}）`)
      continue
    }
    if (raw === null || raw === undefined || raw === '') {
      if (key in asObject) {
        delete asObject[key]
        removed.push(key)
      }
      continue
    }
    const number = Number(raw)
    if (!Number.isFinite(number)) {
      problems.push(`${key} 要是数字（收到 ${JSON.stringify(raw)}）`)
      continue
    }
    if (number < limit.min || number > limit.max) {
      problems.push(`${key}=${number} 超出合理范围 ${limit.min}~${limit.max} —— ${limit.hint}`)
      continue
    }
    asObject[key] = number
    written.push(key)
  }
  next.languages[lang] = asObject
  return { table: next, written, removed, problems }
}

/** 把某一门语言的调参覆盖整个撤掉（`--clear-tuning`）。 */
export function clearLanguageTuning(table, lang) {
  return setLanguageTuning(table, lang, {
    silence_skip_level: null,
    rms_threshold: null,
    rms_floor: null,
  })
}

/**
 * 把**切句**参数写进 `languages[语种].segmentation`（5.109）。
 *
 * <p>与 {@link setLanguageTuning} 分开，是因为两者的合法范围完全不同（毫秒 vs 电平），
 * 而且写的位置不同（一个在 `segmentation` 对象里，一个在行内）。
 * 越界一律**报错**：`silence_ms=5` 会把每一块音频都切成一句，表现是"字幕刷刷地出、全是碎片"。
 *
 * @param {Object<string, number|null>} values null = 删掉这一项（回到策略/default 的值）
 */
export function setLanguageSegmentation(table, lang, values) {
  const next = JSON.parse(JSON.stringify(table && typeof table === 'object' ? table : {}))
  next.languages = next.languages && typeof next.languages === 'object' ? next.languages : {}
  const current = next.languages[lang]
  const asObject = current && typeof current === 'object' && !Array.isArray(current)
    ? { ...current }
    : (typeof current === 'string' ? { model: current } : {})
  const segmentation = { ...(asObject.segmentation ?? {}) }
  const written = []
  const removed = []
  const problems = []
  for (const [key, raw] of Object.entries(values ?? {})) {
    const limit = SEGMENTATION_LIMITS[key]
    if (limit === undefined) {
      problems.push(`${key} 不是可调的切句字段（只有 ${Object.keys(SEGMENTATION_LIMITS).join(' / ')}）`)
      continue
    }
    if (raw === null || raw === undefined || raw === '') {
      if (key in segmentation) {
        delete segmentation[key]
        removed.push(key)
      }
      continue
    }
    const number = Number(raw)
    if (!Number.isFinite(number) || number <= 0) {
      problems.push(`${key} 要是正数（收到 ${JSON.stringify(raw)}）`)
      continue
    }
    if (number < limit.min || number > limit.max) {
      problems.push(`${key}=${number} 超出合理范围 ${limit.min}~${limit.max} —— ${limit.hint}`)
      continue
    }
    segmentation[key] = Math.round(number)
    written.push(key)
  }
  if (Object.keys(segmentation).length > 0) asObject.segmentation = segmentation
  else delete asObject.segmentation
  next.languages[lang] = asObject
  return { table: next, written, removed, problems }
}

/**
 * 把切句参数写进**共享的 `default` 层**（5.114）。
 *
 * <p>为什么要它：切句是三种语言**同一段 CPU 代码**，碎句/不切句这类问题通常三语一起犯。
 * 只改一门语言就要敲三条命令，而且新加的语言不会被覆盖 —— 所以给一个"改所有人的默认"的入口。
 *
 * <p>与 `--lang` 的关系：`languages[语种]` 仍然优先。也就是说先用 `--default` 定好基线，
 * 哪个语种要特殊对待再单独 `--lang` 覆盖，两者不冲突。
 */
export function setDefaultSegmentation(table, values) {
  const next = JSON.parse(JSON.stringify(table && typeof table === 'object' ? table : {}))
  const base = next.default && typeof next.default === 'object' && !Array.isArray(next.default)
    ? { ...next.default }
    : {}
  const segmentation = { ...(base.segmentation ?? {}) }
  const written = []
  const removed = []
  const problems = []
  for (const [key, raw] of Object.entries(values ?? {})) {
    const limit = SEGMENTATION_LIMITS[key]
    if (limit === undefined) {
      problems.push(`${key} 不是可调的切句字段（只有 ${Object.keys(SEGMENTATION_LIMITS).join(' / ')}）`)
      continue
    }
    if (raw === null || raw === undefined || raw === '') {
      if (key in segmentation) {
        delete segmentation[key]
        removed.push(key)
      }
      continue
    }
    const number = Number(raw)
    if (!Number.isFinite(number) || number <= 0) {
      problems.push(`${key} 要是正数（收到 ${JSON.stringify(raw)}）`)
      continue
    }
    if (number < limit.min || number > limit.max) {
      problems.push(`${key}=${number} 超出合理范围 ${limit.min}~${limit.max} —— ${limit.hint}`)
      continue
    }
    segmentation[key] = Math.round(number)
    written.push(key)
  }
  if (Object.keys(segmentation).length > 0) base.segmentation = segmentation
  else delete base.segmentation
  next.default = base
  return { table: next, written, removed, problems }
}

/** 把"电平门槛"写进共享的 `default` 层（见 {@link setDefaultSegmentation}）。 */
export function setDefaultTuning(table, values) {
  const next = JSON.parse(JSON.stringify(table && typeof table === 'object' ? table : {}))
  const base = next.default && typeof next.default === 'object' && !Array.isArray(next.default)
    ? { ...next.default }
    : {}
  const written = []
  const removed = []
  const problems = []
  for (const [key, raw] of Object.entries(values ?? {})) {
    const limit = LEVEL_LIMITS[key]
    if (limit === undefined) {
      problems.push(`${key} 不是可调的字段（只有 ${Object.keys(LEVEL_LIMITS).join(' / ')}）`)
      continue
    }
    if (raw === null || raw === undefined || raw === '') {
      if (key in base) {
        delete base[key]
        removed.push(key)
      }
      continue
    }
    const number = Number(raw)
    if (!Number.isFinite(number)) {
      problems.push(`${key} 要是数字（收到 ${JSON.stringify(raw)}）`)
      continue
    }
    if (number < limit.min || number > limit.max) {
      problems.push(`${key}=${number} 超出合理范围 ${limit.min}~${limit.max} —— ${limit.hint}`)
      continue
    }
    base[key] = number
    written.push(key)
  }
  next.default = base
  return { table: next, written, removed, problems }
}

/** 切句字段的合法范围（毫秒）。越界通常意味着单位写错（秒 vs 毫秒）。 */
export const SEGMENTATION_LIMITS = {
  silence_ms: { min: 100, max: 5000, hint: '说完多久算一句结束（缺省 800；越小越快、越容易切碎）' },
  min_speech_ms: { min: 50, max: 3000, hint: '至少多少语音才交出去（缺省 500）' },
  max_speech_ms: { min: 1000, max: 120000, hint: '一段最长多少（缺省 30000）' },
  short_utterance_ms: { min: 100, max: 5000, hint: '攒到多久算"够长"（缺省 800）' },
  short_silence_ms: { min: 100, max: 8000, hint: '还没攒够时要等多久静音（缺省 1100）' },
  cut_pause_ms: { min: 50, max: 3000, hint: '强制断句时至少要找到多长的停顿（缺省 200）' },
}

/**
 * 把一份"候选策略"合进现有表：**只加不覆盖**。
 *
 * <p>为什么要工具而不是让人手抄：表是运维在服务器上手改过的东西（他们可能调过切句、
 * 也可能加了本地模型），用示例表整体覆盖会把那些调整抹掉。所以这里只补**表里还没有的
 * 策略名**，并把"同名但内容不同"的情况**列出来让人自己决定**，不静默改。
 *
 * <p>5.96 起可以传 `{replace: true}`：把"同名但内容不同"的条目**按新表覆盖**。
 * 为什么需要这个开关：我们自己改过示例表里的模型名（`fun-asr-flash-*` → `fun-asr-realtime`），
 * 而服务器上的表是只加不覆盖 —— 于是它一直跑着**旧模型名**，报上来的错却像"参数不对"。
 * 但默认仍是只加不覆盖：那可能是别人测过的配置，覆盖得由人明说。
 *
 * @param {{replace?: boolean}} [options]
 * @returns {{table: object, added: string[], replaced: string[], conflict: string[], unchanged: string[]}}
 */
export function mergeStrategies(existing, additions, options = {}) {
  const replace = options?.replace === true
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {}
  const table = JSON.parse(JSON.stringify(base))
  table.strategies = table.strategies && typeof table.strategies === 'object' ? table.strategies : {}
  const incoming = additions?.strategies && typeof additions.strategies === 'object'
    ? additions.strategies
    : {}
  const added = []
  const replaced = []
  const conflict = []
  const unchanged = []
  for (const [name, layer] of Object.entries(incoming)) {
    const current = table.strategies[name]
    if (current === undefined) {
      table.strategies[name] = JSON.parse(JSON.stringify(layer))
      added.push(name)
    } else if (JSON.stringify(current) === JSON.stringify(layer)) {
      unchanged.push(name)
    } else if (replace) {
      // 明确要求替换：整条按示例表换掉，并**记下来**（覆盖别人的配置必须留痕）
      table.strategies[name] = JSON.parse(JSON.stringify(layer))
      replaced.push(name)
    } else {
      // 同名不同内容：**不动**，只报告 —— 静默覆盖会毁掉别人测过的配置
      conflict.push(name)
    }
  }
  return { table, added, replaced, conflict, unchanged }
}

/**
 * 体检一个云端密钥的**形状**（5.98）：能看出"这个值注定会被 HTTP 头拒掉"。
 *
 * <p>为什么要有它：实机上出现过
 * `websockets.exceptions.InvalidHeaderValue: invalid Authorization header`
 * —— 一条第三方 traceback，不说是什么错了。真因是长密钥复制时被折成两行，
 * 中间的换行一路送到 `Authorization` 头上。这种事**在启动前就能看出来**，
 * 却让人对着一个"看起来完全正确"的字符串查了半天。
 *
 * <p>纪律：**绝不打印密钥本身**。只说长度、有没有以 `sk-` 开头、以及哪一类字符有问题。
 *
 * @param {{expectPrefix?: string}} [options]
 *   `expectPrefix` 给了才检查开头（DashScope 是 `sk-`，腾讯云 SecretId 是 `AKID`）；
 *   不给就不瞎猜 —— 代理网关的密钥前缀五花八门，多嘴一次就会把人引偏。
 * @returns {{present: boolean, ok: boolean, shape: string, problems: string[], notes: string[]}}
 *   `problems` 是**会让请求必然失败**的（控制字符/非 ASCII/端点地址），
 *   `notes` 是提醒（首尾空白、开头不像密钥）——提醒不拦人。
 */
export function describeKeyShape(value, options = {}) {
  const expectPrefix = typeof options?.expectPrefix === 'string' ? options.expectPrefix : ''
  if (typeof value !== 'string' || value === '') {
    return { present: false, ok: false, shape: '（没设置）', problems: ['没设置'], notes: [] }
  }
  const problems = []
  const notes = []
  const trimmed = value.trim()
  if (trimmed === '') {
    return { present: true, ok: false, shape: '（只有空白）', problems: ['值是空的（只有空白字符）'], notes: [] }
  }
  if (trimmed !== value) notes.push('首尾有空白或换行（识别侧会自动去掉，但建议重设一次）')
  // ⚠️ 中间的控制字符（换行最常见）是这一条事故的元凶：HTTP 头放不下 0x00-0x1F
  const control = [...trimmed].find((ch) => /\s/.test(ch) || ch.codePointAt(0) < 0x21 || ch.codePointAt(0) === 0x7f)
  if (control !== undefined) {
    const where = trimmed.indexOf(control) + 1
    problems.push(`第 ${where} 个字符是控制/空白字符（U+${control.codePointAt(0)
      .toString(16).toUpperCase().padStart(4, '0')}）—— HTTP 头放不下它，请求会报 InvalidHeaderValue`)
  }
  const nonAscii = [...trimmed].find((ch) => ch.codePointAt(0) > 0x7e)
  if (nonAscii !== undefined) {
    problems.push(`含非 ASCII 字符（U+${nonAscii.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}）`
      + '—— 多半是从聊天窗口/文档里复制时带上了全角字符或省略号')
  }
  if (/^(wss?|https?):\/\//i.test(trimmed)) {
    problems.push('这个值是**端点地址**，不是密钥 —— 多半把 KEY 和 WS_URL 两个变量接反了')
  }
  if (problems.length === 0 && expectPrefix !== '' && !trimmed.startsWith(expectPrefix)) {
    notes.push(`不是以 \`${expectPrefix}\` 开头（一般应该是），确认一下别拿错了变量`)
  }
  const shape = `${trimmed.length} 字符${expectPrefix !== '' && trimmed.startsWith(expectPrefix)
    ? `，以 ${expectPrefix} 开头` : ''}`
  return { present: true, ok: problems.length === 0, shape, problems, notes }
}

function labelOf(engine, model) {
  if (!model) return `${engine} / 服务器默认`
  return engine === DEFAULT_ENGINE ? String(model) : `${engine} / ${model}`
}

/**
 * 5.148��У��һ��**��ѡ���Ա�**������ҳ"��֤"��ť / д��ǰ���ã���
 *
 * <p>������Ҫ�ֿ�����Ϊ������ʽ��ͬ��
 * <ul>
 *   <li><b>problems</b>��д��ȥ�ͻỵ�����㲻�Ƕ��󡢾��Ȳ���ö��������˲����ڵĲ����������� **�ܾ�����**��</li>
 *   <li><b>warnings</b>���ܴ棬���������������ܲ�������ģ��û���ء��ƶ�ȱ��Կ���� **�������棬���������˿���**��</li>
 * </ul>
 *
 * @param {object} table ��ѡ��
 * @param {{ probe?: Function, langs?: string[] }} [options]
 * @returns {{ ok: boolean, problems: string[], warnings: string[], languages: Record<string, object> }}
 */
export function validateStrategyTable(table, options = {}) {
  const probe = options.probe ?? probeModel
  const langs = Array.isArray(options.langs) && options.langs.length > 0 ? options.langs : ENGINE_LANGUAGES
  const problems = []
  const warnings = []
  const languages = {}

  const isObject = (value) => value !== null && typeof value === 'object' && Array.isArray(value) !== true
  if (isObject(table) !== true) {
    return { ok: false, problems: ['���������һ������{ version, default, strategies, languages }��'], warnings, languages }
  }
  if (table.version !== undefined && Number.isFinite(Number(table.version)) !== true) {
    problems.push(`version ���������֣��յ� ${JSON.stringify(table.version)}`)
  }

  const checkLayer = (label, layer) => {
    if (layer === undefined) return
    if (isObject(layer) !== true) {
      problems.push(`${label} �����Ƕ���`)
      return
    }
    if (layer.engine !== undefined) {
      const engine = String(layer.engine).trim()
      if (ENGINE_NAME.test(engine) !== true) problems.push(`${label}.engine ��״���ԣ�${JSON.stringify(layer.engine)}`)
    }
    if (layer.compute_type !== undefined) {
      const compute = String(layer.compute_type).trim().toLowerCase()
      if (COMPUTE_TYPES.includes(compute) !== true) {
        problems.push(`${label}.compute_type ֻ���� ${COMPUTE_TYPES.join(' / ')}���յ� ${JSON.stringify(layer.compute_type)}`)
      }
    }
    if (layer.model !== undefined && String(layer.model).trim() === '') {
      problems.push(`${label}.model д�˿մ���Ҫôɾ������ֶΡ�Ҫôд��ģ������`)
    }
    if (layer.runtime !== undefined && ['onnx', 'nemo'].includes(String(layer.runtime).trim().toLowerCase()) !== true) {
      problems.push(`${label}.runtime ֻ���� onnx / nemo��parakeet ������·�����յ� ${JSON.stringify(layer.runtime)}`)
    }
    if (layer.segmentation !== undefined) {
      if (isObject(layer.segmentation) !== true) {
        problems.push(`${label}.segmentation �����Ƕ���`)
      } else {
        for (const [key, value] of Object.entries(layer.segmentation)) {
          const number = Number(value)
          if (Number.isFinite(number) !== true || number <= 0) {
            problems.push(`${label}.segmentation.${key} �������������յ� ${JSON.stringify(value)}`)
          }
        }
      }
    }
  }

  const strategies = isObject(table.strategies) ? table.strategies : {}
  checkLayer('default', table.default)
  for (const [name, layer] of Object.entries(strategies)) {
    if (ENGINE_NAME.test(String(name).trim()) !== true) {
      problems.push(`��������״���ԣ�${JSON.stringify(name)}��ֻ����Сд��ĸ/����/_/-��`)
    }
    checkLayer(`strategies.${name}`, layer)
  }

  const languageLayer = isObject(table.languages) ? table.languages : {}
  for (const [lang, layer] of Object.entries(languageLayer)) {
    if (langs.includes(lang) !== true) {
      warnings.push(`���� ${lang} ����ʶ����ϵ� ${langs.join(' / ')} ���һ�λ��� default��`)
    }
    checkLayer(`languages.${lang}`, layer)
    if (isObject(layer) && typeof layer.strategy === 'string' && layer.strategy.trim() !== '') {
      const name = layer.strategy.trim()
      if (name !== 'default' && isObject(strategies[name]) !== true) {
        problems.push(`languages.${lang}.strategy ָ�򲻴��ڵĲ��� "${name}"��strategies ��û������`)
      }
    }
  }

  for (const lang of langs) {
    const name = strategyNameOf(table, lang)
    const profile = resolveProfile(table, lang, name)
    const probed = probe(profile.model, {}, String(profile.engine ?? DEFAULT_ENGINE))
    const runtime = isObject(languageLayer[lang]) && languageLayer[lang].runtime !== undefined
      ? String(languageLayer[lang].runtime)
      : (isObject(strategies[name]) && strategies[name].runtime !== undefined
        ? String(strategies[name].runtime) : '')
    languages[lang] = {
      strategy: name,
      engine: String(profile.engine ?? DEFAULT_ENGINE),
      model: String(profile.model ?? ''),
      compute_type: String(profile.compute_type ?? ''),
      runtime,
      available: probed.state,
      hint: probed.hint,
    }
    if (probed.state === 'missing') {
      warnings.push(`${lang}��${probed.hint}���������������ܲ�������`)
    }
  }
  return { ok: problems.length === 0, problems, warnings, languages }
}

/**
 * 5.148���Ѳ��Ա�**ԭ�ӵ�**д������Ŀ¼��дǰ��һ�� `<name>.bak-<ʱ���>`����
 *
 * <p>Ϊʲô����"�ȱ��� + д tmp �� rename"��ʶ��ఴ mtime �ȶ����ű���
 * ֱ�Ӹ���д�д����ڻᱻ����**��� JSON** ���� ��һ�̵ı���Ϊ"�������ˡ�����Ĭ��ģ��"��
 * ����άֻ�ῴ��"����һ��ģ��ȫ��� large-v3"���������뵽д����ʽ��
 */
export function saveStrategyTable(root, table, options = {}) {
  const dir = String(root ?? '')
  if (dir === '') return { ok: false, error: 'û������Ŀ¼' }
  const path = join(dir, 'asr-models.json')
  const exists = options.exists ?? existsSync
  const read = options.read ?? ((target) => readFileSync(target, 'utf-8'))
  const write = options.write ?? ((target, body) => writeFileSync(target, body, 'utf-8'))
  const rename = options.rename ?? renameSync
  let backup = ''
  try {
    if (exists(path)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      backup = `${path}.bak-${stamp}`
      write(backup, read(path))
    }
    const tmp = `${path}.tmp`
    write(tmp, `${JSON.stringify(table, null, 2)}\n`)
    rename(tmp, path)
    return { ok: true, path, backup }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}
