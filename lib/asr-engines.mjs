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
 * 字段 —— 而且真正的选择是手机把它**显式写进房间侧车**（`asr-profiles/<room>.json`），
 * Python 那边"房间覆盖"这一层优先级最高，所以手机选的引擎/模型不会被这里算错而影响识别。
 *
 * 可用性（`available`）的三种取值，都**如实**报，不猜：
 *   · `present`    本地已有（路径存在，或 HF 缓存里有同名目录）
 *   · `missing`    写了具体路径但那个路径不存在 —— 选了必然加载失败
 *   · `unverified` 只是个尺寸名，本机缓存里没找到 —— 首次用会去下载（可能要几分钟）
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 引擎名：小写字母/数字/下划线/连字符（会出现在侧车与日志里）。 */
export const ENGINE_NAME = /^[a-z0-9_-]{1,32}$/

/** 手机可以按语言选模型的语种（与 relay 侧车、Python 侧车一致）。 */
export const ENGINE_LANGUAGES = ['zh-CN', 'pt-BR', 'en-US']

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

/**
 * 猜不出"本机有没有这个模型"时**如实说猜不出**。
 *
 * 判据只有两条能确定的：写了路径就看路径在不在；写了尺寸名就看 HF 缓存里
 * 有没有名字里带它的 `models--*` 目录。两者都不成立就是 `unverified`（首次用会下载）。
 */
export function probeModel(model, options = {}) {
  const name = String(model ?? '').trim()
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
  for (const [name, layer] of candidates) {
    const profile = mergeLayer(mergeLayer({ engine: DEFAULT_ENGINE, model: '' }, inTable.default), layer)
    const key = keyOf(profile.engine, profile.model)
    const existing = byKey.get(key)
    if (existing) {
      existing.strategies.push(name)
      continue
    }
    const probed = probe(profile.model)
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
    note: '', available: probe(currentProfile.model).state, hint: '', strategies: [currentName],
    current: true,
  }
  if (!options.some((option) => option.current)) options.unshift(current)
  return { lang, tableFound: true, current, options }
}

function keyOf(engine, model) {
  return `${String(engine ?? DEFAULT_ENGINE).trim().toLowerCase()}|${String(model ?? '').trim()}`
}

/**
 * 把一份"候选策略"合进现有表：**只加不覆盖**。
 *
 * <p>为什么要工具而不是让人手抄：表是运维在服务器上手改过的东西（他们可能调过切句、
 * 也可能加了本地模型），用示例表整体覆盖会把那些调整抹掉。所以这里只补**表里还没有的
 * 策略名**，并把"同名但内容不同"的情况**列出来让人自己决定**，不静默改。
 *
 * @returns {{table: object, added: string[], conflict: string[], unchanged: string[]}}
 */
export function mergeStrategies(existing, additions) {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {}
  const table = JSON.parse(JSON.stringify(base))
  table.strategies = table.strategies && typeof table.strategies === 'object' ? table.strategies : {}
  const incoming = additions?.strategies && typeof additions.strategies === 'object'
    ? additions.strategies
    : {}
  const added = []
  const conflict = []
  const unchanged = []
  for (const [name, layer] of Object.entries(incoming)) {
    const current = table.strategies[name]
    if (current === undefined) {
      table.strategies[name] = JSON.parse(JSON.stringify(layer))
      added.push(name)
    } else if (JSON.stringify(current) === JSON.stringify(layer)) {
      unchanged.push(name)
    } else {
      // 同名不同内容：**不动**，只报告 —— 静默覆盖会毁掉别人测过的配置
      conflict.push(name)
    }
  }
  return { table, added, conflict, unchanged }
}

function labelOf(engine, model) {
  if (!model) return `${engine} / 服务器默认`
  return engine === DEFAULT_ENGINE ? String(model) : `${engine} / ${model}`
}
