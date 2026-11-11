/**
 * segmentation.mjs —— 切句（分段）参数的全局运维旋钮（5.167）
 * ============================================================================
 *
 * 为什么要有这一层：同传的延迟 ≈ **一句话攒多久** + 静音判定 + 识别 + 翻译。
 * 而"一句话攒多久"完全由切句参数决定（`max_speech_ms` 缺省 30 秒 —— 连续说话时
 * 一句能长到二十几秒，字幕就只能等它结束）。现场调这个值要改命令行、重启整条管线，
 * 代价太大 —— 所以给管理员一个**不用重启**的旋钮。
 *
 * 文件：`<data-dir>/segmentation.json`（与 `asr-models.json` 同一层，跟着数据走）。
 *
 * 优先级（由弱到强）：**内置缺省 < 这份全局文件 < 识别策略表里的 segmentation < 命令行**。
 * 等等 —— 表在**下面**更强？不是。这里的规则是：**全局文件压过策略表**，
 * 因为它是"现场应急"的旋钮，管理员按下就该生效；而策略表是"按语种长期调"的设定。
 * 命令行仍然最强（那是"我就是要用这个值启动"，排障时用）。
 *
 * ⚠️ 生效时机：切句器是**按音频流**创建的（一路音频一个，各自的能量统计必须独立），
 * 所以改完在**下一段录音 / 下一场会**生效 —— 我们不在句子中间重建它（那会把正在说的
 * 半句话切断）。界面把这句话写出来，不假装"点一下立刻变"。
 */

import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 立即可调的字段（与 whisper_stream.py 的 SEGMENTATION_FIELDS 同名）。 */
export const SEGMENTATION_FIELDS = Object.freeze([
  'silence_ms',
  'min_speech_ms',
  'max_speech_ms',
  'short_utterance_ms',
  'short_silence_ms',
  'cut_pause_ms',
])

/** 内置缺省（与 python 侧的 SEGMENTATION_DEFAULTS 逐字一致，有测试钉着）。 */
export const SEGMENTATION_DEFAULTS = Object.freeze({
  silence_ms: 800,
  min_speech_ms: 500,
  max_speech_ms: 30000,
  short_utterance_ms: 800,
  short_silence_ms: 1100,
  cut_pause_ms: 200,
})

/**
 * 每个字段的合法区间与"它在干什么"。
 *
 * <p>要不要给它建议值？要 —— 管理台最常问的就是"该填多少"。但建议值必须写明是**为谁**设的：
 * 同传（要快）与转写（要整）的最优值相反，写一个"通用推荐"等于骗人。
 */
export const SEGMENTATION_RULES = Object.freeze({
  silence_ms: { min: 200, max: 3000, step: 50, label: '尾部静音多久算说完', note: '越小越早出字幕，但容易在一句话中间切开' },
  min_speech_ms: { min: 100, max: 2000, step: 50, label: '短于这个的当噪声', note: '太小会把咳嗽/椅子声当句子' },
  max_speech_ms: { min: 2000, max: 60000, step: 500, label: '一句话最长多少', note: '**延迟的主因**：30 秒缺省意味着连续说话时一句能攒半分钟；同传建议 8000' },
  short_utterance_ms: { min: 200, max: 3000, step: 50, label: '短句的判定长度', note: '短句用下面那个更长的静音判定，避免把词切成段' },
  short_silence_ms: { min: 300, max: 4000, step: 50, label: '短句要等多久静音', note: '短句往往后面还有话，等久一点更稳' },
  cut_pause_ms: { min: 0, max: 2000, step: 50, label: '切点时额外留的气口', note: '留一点气口能保住最后一个音节' },
})

export function segmentationPath(root) {
  return join(String(root ?? ''), 'segmentation.json')
}

/** 读全局设置；文件不存在 / 读坏了 → 返回内置缺省（并在 `source` 里说清）。 */
export function loadSegmentation(root, options = {}) {
  const path = segmentationPath(root)
  const exists = options.exists ?? existsSync
  const read = options.read ?? ((target) => readFileSync(target, 'utf-8'))
  if (!exists(path)) return { values: { ...SEGMENTATION_DEFAULTS }, source: 'defaults', path }
  let parsed
  try {
    parsed = JSON.parse(read(path))
  } catch {
    return { values: { ...SEGMENTATION_DEFAULTS }, source: 'broken', path }
  }
  const picked = {}
  for (const field of SEGMENTATION_FIELDS) {
    const value = parsed?.[field]
    if (Number.isFinite(Number(value)) && value !== null && value !== '') picked[field] = Number(value)
  }
  return { values: { ...SEGMENTATION_DEFAULTS, ...picked }, source: 'file', path }
}

/**
 * 校验一份设置：范围 + 交叉约束。
 *
 * @returns {{ok: boolean, problems: string[], values: object, warnings: string[]}}
 */
export function validateSegmentation(input) {
  const problems = []
  const warnings = []
  const values = { ...SEGMENTATION_DEFAULTS }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, problems: ['设置必须是一个 JSON 对象'], values, warnings }
  }
  for (const field of SEGMENTATION_FIELDS) {
    const raw = input[field]
    if (raw === undefined || raw === null || raw === '') continue
    const number = Number(raw)
    const rule = SEGMENTATION_RULES[field]
    if (!Number.isFinite(number) || !Number.isInteger(number)) {
      problems.push(`${field} 必须是整数，收到 ${JSON.stringify(raw)}`)
      continue
    }
    if (number < rule.min || number > rule.max) {
      problems.push(`${field} 要在 ${rule.min}~${rule.max} 之间，收到 ${number}`)
      continue
    }
    values[field] = number
  }
  const unknown = Object.keys(input).filter((key) => !SEGMENTATION_FIELDS.includes(key))
  if (unknown.length > 0) warnings.push(`忽略了不认识的字段：${unknown.join('、')}`)

  if (values.min_speech_ms >= values.max_speech_ms) {
    problems.push(`min_speech_ms(${values.min_speech_ms}) 必须小于 max_speech_ms(${values.max_speech_ms})`)
  }
  if (values.short_silence_ms < values.silence_ms) {
    warnings.push(`short_silence_ms(${values.short_silence_ms}) 比 silence_ms(${values.silence_ms}) 还短 ——`
      + '短句会比长句更早被切断，通常写反了')
  }
  if (values.max_speech_ms > 15000) {
    warnings.push(`max_speech_ms=${values.max_speech_ms} 偏大：连续说话时一句能攒这么久，`
      + '同传里字幕会明显落后（实测 18 秒的段光识别就要 7.7 秒）')
  }
  if (values.silence_ms > 1200) {
    warnings.push(`silence_ms=${values.silence_ms} 偏大：每句话都要多等这么久才交出去`)
  }
  return { ok: problems.length === 0, problems, values, warnings }
}

/** 保存（先备份后写，tmp + rename：读端永远看不到半个文件）。 */
export function saveSegmentation(root, input, options = {}) {
  const dir = String(root ?? '')
  if (dir === '') return { ok: false, error: '缺少数据目录' }
  const checked = validateSegmentation(input)
  if (checked.ok !== true) return { ok: false, error: checked.problems.join('；'), problems: checked.problems }
  const path = segmentationPath(dir)
  const exists = options.exists ?? existsSync
  const write = options.write ?? ((target, body) => writeFileSync(target, body, 'utf-8'))
  const copy = options.copy ?? ((from, to) => copyFileSync(from, to))
  const move = options.move ?? ((from, to) => renameSync(from, to))
  // ⚠️ options.now 可能是 **ISO 字符串**（relay 里的 now 就是字符串）——
  // 直接 .toISOString() 会抛 "now.toISOString is not a function"，而那个错会让
  // "恢复缺省"这种救命操作变成 500。统一归一成 Date。
  const stampSource = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now())
  const now = Number.isNaN(stampSource.getTime()) ? new Date() : stampSource
  let backup = ''
  if (exists(path)) {
    const stamp = now.toISOString().replace(/[:.]/g, '-')
    backup = `${path}.bak-${stamp}`
    try {
      copy(path, backup)
    } catch (error) {
      return { ok: false, error: `备份失败：${error?.message ?? error}` }
    }
  }
  const body = JSON.stringify(checked.values, null, 2) + '\n'
  const tmp = `${path}.part`
  try {
    write(tmp, body)
    move(tmp, path)
  } catch (error) {
    return { ok: false, error: `写设置失败：${error?.message ?? error}` }
  }
  return { ok: true, values: checked.values, path, backup, warnings: checked.warnings }
}
