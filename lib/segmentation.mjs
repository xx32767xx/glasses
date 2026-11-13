/**
 * segmentation.mjs —— 切句（分段）参数的**校验规则**与内置缺省（5.167 / 5.192）
 * ============================================================================
 *
 * ⚠️ 5.192：这里原来还有一对 `loadSegmentation` / `saveSegmentation`，服务于
 * `<data-dir>/segmentation.json` 那份**全局旋钮**。它已经删除，原因写清楚：
 *
 *   · 同一组参数有了**两个来源**（全局文件 + 识别策略表里按语种的设定），而它们
 *     优先级相反 —— 全局文件压过策略表。管理台上于是永远挂着一行
 *     「⚠️ 全局旋钮正压着：silence_ms、min_speech_ms…」，意思等于
 *     **"你按语种调的那些值其实没生效"**。用户看到的第一个反应就是"那我调它干什么"。
 *   · 而且策略表本来就**热读**（改完下一段生效），"现场应急调一下"这件事
 *     在策略表里同样做得到，不需要第二个文件。
 *
 * 所以现在**只有一条链**：内置缺省 → `default` → `strategies[名字]` → `languages[语种]`，
 * 命令行仍然最强（排障用）。管理台显示的就是这条链算出来的**生效值**。
 *
 * 本文件留下的是"什么值合法"和"缺省是多少"——校验规则与内置缺省仍然只有一份，
 * 服务端写表时用它把关。
 */

import { existsSync } from 'node:fs'
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

/** 那个**已废弃**的全局旋钮文件路径（只用来提示"它还在，但不再生效"）。 */
export function legacySegmentationPath(root) {
  return join(String(root ?? ''), 'segmentation.json')
}

/**
 * 数据目录里是否还躺着一份废弃的 `segmentation.json`（有就提示管理员可以删）。
 *
 * <p>为什么只是一句提示、不去自动删：那份文件里可能有管理员手调过的值
 * （比如现场应急时改的 silence_ms），**悄悄删掉等于悄悄丢配置**。
 * 提示里直接说"要保留就写进识别策略表"，把人指到对的地方。
 */
export function legacySegmentationFile(root, options = {}) {
  const path = legacySegmentationPath(root)
  const exists = options.exists ?? existsSync
  return exists(path) ? path : ''
}

/**
 * 校验一份设置：范围 + 交叉约束。
 *
 * <p>服务端写 `asr-models.json` 里按语种的 `segmentation` 时用它把关 ——
 * 越界的值写进去只会让切句侧每段都报错或静默失效。
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
