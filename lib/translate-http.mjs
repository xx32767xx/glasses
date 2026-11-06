/**
 * translate-http.mjs —— 「一句文字 → 一种/两种译文」的 HTTP 接口用到的逻辑（5.125）
 * ============================================================================
 *
 * 背景：另一组人要**通过 HTTP 调用我们 App 的翻译链路**。我们现有的翻译只发生在
 * 「手机持续推流 →（识别）→ 收件箱 → 大脑（插件）→ 字幕总线 → 转发 → 手机」
 * 这条链路的中间，没有一个"给一段文字、要一份译文"的入口。
 *
 * 所以这里做一个小接口，但**复用同一条翻译通路**：把这段文字当成"收件箱里的一行"
 * 写进一个**常驻 API 大脑**（scripts/start-multi.mjs 起的 `大脑·API` 进程）的收件箱，
 * 再用**同一个大脑**（同一套术语表、同一套切行/校对规则、同一个翻译后端）译出来，
 * 从它写的总线文件里读回结果。
 *
 * 好处：译文与会议里的字幕**出自同一套逻辑**，不会出现"接口说用的是 A、会议里跑的是 B"。
 * 代价也必须说清：
 *   · 大脑是**串行**的（同传不能并发，否则字幕会互相穿插）——接口请求会被排队，
 *     所以这里自己再串一道（`translateOnce` 内部排队），免得两个请求的帧互相认错；
 *   · 需要那个常驻进程在跑。没跑就回 503 并指出去哪起（不是"超时"这种没法查的说法）。
 *
 * ⚠️ **面向用户文案一律英文**（与 `/asr/*` 一致）：这个接口的调用方是外部系统/同事的脚本，
 * 不是装中文 App 的手机。机器可读的放 `error` 代码（`translator-not-running` 之类），
 * 人话放英文 `error`/`hint`。
 *
 * 本文件里既有纯函数（好测、不碰网络）也有一个碰磁盘的编排函数：
 *   · {@link normalizeTranslateRequest} —— 校验请求体（文字/方向/超时）
 *   · {@link parseBusFrame}            —— 总线那一段 JSON → 帧（坏内容返回 null）
 *   · {@link translateOnce}            —— 真跑一次（入收件箱 → 等总线帧 → 三分支结局）
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { apiTranslateBus, apiTranslateInbox } from './paths.mjs'

/** 接口的硬限制。数值都是**故意小的**：这是「一句话」用的，不是批量翻译服务。 */
export const TRANSLATE_HTTP_LIMITS = {
  /** 单次文字上限（字符）。超过就不是"一句话"了，应该自己切句再调。 */
  maxTextChars: 4000,
  /** 缺省等待上限（毫秒）。排队 + 一次模型往返都在这里面。 */
  defaultTimeoutMs: 30000,
  /** 允许的最大等待（毫秒）。 */
  maxTimeoutMs: 120000,
  /** 同时最多几个请求在飞（超出就排队；大脑本身是串行的，压多了只会一起慢）。 */
  maxInFlight: 4,
  /** 一次最多要几种译文（三种语言里源语言占一种，所以最多两种）。 */
  maxTargets: 2,
  /** 支持的语种（与 relay 的 LANGS 一致）。 */
  langs: ['zh-CN', 'pt-BR', 'en-US'],
}

/**
 * 校验请求体 → 一次可以写进收件箱的翻译任务。
 *
 * @param {object} body 请求体（JSON）
 * @param {{maxTextChars?: number, defaultTimeoutMs?: number, maxTimeoutMs?: number,
 *          maxTargets?: number, langs?: string[]}} [limits]
 * @returns {{ok: boolean, error?: string, text?: string, from?: string, to?: string[],
 *            targets?: string[], timeoutMs?: number}}
 *   `to` 是调用方**要的**语言（原样），`targets` 是**真的需要翻**的语言
 *   （把与 `from` 相同的那些滤掉 —— 源=目标不需要翻，也不该假装"译"出一份同语言字幕）。
 */
export function normalizeTranslateRequest(body, limits = {}) {
  const max = { ...TRANSLATE_HTTP_LIMITS, ...limits }
  const source = body !== null && typeof body === 'object' && !Array.isArray(body) ? body : null
  if (source === null) return { ok: false, error: 'request body must be a JSON object' }

  const text = typeof source.text === 'string' ? source.text.trim() : ''
  if (text === '') {
    return { ok: false, error: 'missing "text": the sentence to translate (a JSON string)' }
  }
  if (text.length > max.maxTextChars) {
    return {
      ok: false,
      error: `"text" is ${text.length} characters, above the ${max.maxTextChars}-character limit. `
        + 'This endpoint takes ONE sentence: split longer text and call it per sentence',
    }
  }

  const from = String(source.from ?? '').trim()
  if (from === '') {
    return { ok: false, error: `missing "from": the source language (one of: ${max.langs.join(' / ')})` }
  }
  if (!max.langs.includes(from)) {
    return { ok: false, error: `"from" must be one of ${max.langs.join(' / ')}, got ${JSON.stringify(from)}` }
  }

  const rawTo = Array.isArray(source.to)
    ? source.to
    : (source.to === undefined || source.to === null || source.to === '' ? [] : [source.to])
  if (rawTo.length === 0) {
    return {
      ok: false,
      error: `missing "to": the target language(s) (a string or an array, each one of: ${max.langs.join(' / ')})`,
    }
  }
  const to = []
  for (const item of rawTo) {
    const one = String(item ?? '').trim()
    if (!max.langs.includes(one)) {
      return { ok: false, error: `"to" must be one of ${max.langs.join(' / ')}, got ${JSON.stringify(one)}` }
    }
    if (!to.includes(one)) to.push(one)
  }
  if (to.length > max.maxTargets) {
    return {
      ok: false,
      error: `"to" has ${to.length} languages, at most ${max.maxTargets} per request `
        + '(three languages total: the source one never needs a translation)',
    }
  }

  // 与源语言相同的那几个**不是错**：调用方可能图省事把三种语言全传进来。
  // 但它们也确实不需要翻译 —— 所以从 targets 里滤掉，并如实告诉调用方"这条没翻"。
  const targets = to.filter((one) => one !== from)

  let timeoutMs = max.defaultTimeoutMs
  const rawTimeout = source.timeoutMs
  if (rawTimeout !== undefined && rawTimeout !== null && rawTimeout !== '') {
    const value = Number(rawTimeout)
    if (!Number.isFinite(value) || value <= 0) {
      return { ok: false, error: `"timeoutMs" must be a positive number, got ${JSON.stringify(rawTimeout)}` }
    }
    timeoutMs = Math.min(Math.round(value), max.maxTimeoutMs)
  }

  return { ok: true, text, from, to, targets, timeoutMs }
}

/**
 * 总线那一段 JSON → 帧。坏内容（写了一半 / 不是 JSON / 不是对象）返回 null，
 * 让调用方"下一轮再来"，而不是抛异常把整次请求弄崩。
 */
export function parseBusFrame(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return null
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return null
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
  return payload
}

/** 一帧里的译文：优先 `texts`（5.121 起一帧带多种译文），否则退回 `lang`+`text`。 */
export function frameTranslations(frame) {
  const out = {}
  if (frame === null || typeof frame !== 'object') return out
  const texts = frame.texts
  if (texts !== null && typeof texts === 'object' && !Array.isArray(texts)) {
    for (const [lang, value] of Object.entries(texts)) {
      if (typeof value === 'string') out[lang] = value
    }
  }
  if (Object.keys(out).length === 0 && typeof frame.lang === 'string' && typeof frame.text === 'string') {
    out[frame.lang] = frame.text
  }
  return out
}

/**
 * 串行闸门：**同一时刻只放一个请求进收件箱**。
 *
 * <p>为什么必须有：接口靠"总线上出现 `source === 我的文字` 的帧"来认领结果。
 * 两个请求同时飞的时候，帧和请求就分不清谁是谁了（尤其两句原文相同时）。
 * 而大脑本来就是串行的（同一刻只译一句），所以排队不会让吞吐变差 ——
 * 它只是把"本来就串行"这件事**明写在接口这一层**。
 */
let chain = Promise.resolve()

/**
 * 把一句话送进翻译管线，等译文回来（5.125）。
 *
 * <p>三种结局必须分开（否则调用方只能瞎猜）：
 *   · 译出来了 → 200 + `translations`；
 *   · 源=目标（不需要翻）→ 200 + `translated:false`，原样回文字；
 *   · 等不到译文 → 504，并区分"大脑收到了但没给译文"（看了 `echo` 帧）与"根本没人消费"。
 *
 * @param {{dataDir: string, inbox?: string, bus?: string}} options
 * @param {object} parsed {@link normalizeTranslateRequest} 的成功结果
 * @returns {Promise<{status: number, json: object}>}
 */
export function translateOnce(options, parsed) {
  const run = chain.then(() => translateOnceUnlocked(options, parsed))
  // 失败不能把闸门卡死：下一个请求照样能进（`chain` 只用来保证"一个接一个"）。
  chain = run.then(() => {}, () => {})
  return run
}

async function translateOnceUnlocked(options, parsed) {
  const dataDir = String(options?.dataDir ?? '')
  const inbox = options?.inbox ?? apiTranslateInbox(dataDir)
  const bus = options?.bus ?? apiTranslateBus(dataDir)
  const startedAt = Date.now()

  if (parsed.targets.length === 0) {
    // 源与目标相同：这一句**不需要翻译**。如实说，不调模型、不假装译出一份同语言字幕。
    return {
      status: 200,
      json: {
        ok: true,
        translated: false,
        from: parsed.from,
        to: parsed.to,
        text: parsed.text,
        translations: { [parsed.from]: parsed.text },
        elapsedMs: 0,
        note: 'source and target are the same language: nothing to translate',
      },
    }
  }

  if (!existsSync(inbox)) {
    return {
      status: 503,
      json: {
        ok: false,
        error: 'translator-not-running',
        hint: `API translator inbox not found (${inbox}) — the API brain is not running on this host. `
          + 'Start the pipeline with scripts/start-multi.mjs (it starts a "大脑·API" process), '
          + 'or run scripts/harness-side.mjs with --inbox/--bus pointing at those two files',
      },
    }
  }

  // 陈旧帧保护：总线上现在这一帧可能是**上一次请求**留下的（文字还可能一模一样）。
  // 记下它的 `at`，只认比它新的帧 —— 否则会把上一次的译文当成本次结果交出去。
  const baselineAt = readFrameAt(bus)

  const deadline = startedAt + parsed.timeoutMs
  const translations = {}
  const missing = []
  let sawEcho = false
  for (const target of parsed.targets) {
    if (Date.now() >= deadline) {
      missing.push(target)
      continue
    }
    // ⚠️ **一条目标送一次、等到它的帧再送下一条**。为什么不一次把两行都写进去：
    //    总线是"整文件覆盖 + 轮询"，而大脑是串行的 —— 两行被很快连着处理时，
    //    后一帧会在我们下一次读到之前把前一帧盖掉（实测：两个目标时其中一个总是丢）。
    //    串行发送让"总线上此刻那一帧"永远就是"我们刚等的那一句"。
    appendFileSync(inbox, JSON.stringify({ text: parsed.text, from: parsed.from, to: target }) + '\n', 'utf-8')
    const got = await waitForTranslation({ bus, text: parsed.text, target, deadline, baselineAt })
    if (got.text === undefined) {
      if (got.sawEcho) sawEcho = true
      missing.push(target)
      continue
    }
    translations[target] = got.text
  }

  const elapsedMs = Date.now() - startedAt
  if (missing.length === 0) {
    return {
      status: 200,
      json: {
        ok: true,
        translated: true,
        from: parsed.from,
        to: parsed.targets,
        text: translations[parsed.targets[0]],
        translations,
        elapsedMs,
      },
    }
  }
  const hint = sawEcho
    ? 'the translator received this sentence (it echoed the source) but produced no translation within '
      + `${parsed.timeoutMs}ms — look for the "✗ 翻译失败" line in the API brain log `
      + '(model error / missing API key / hot-word filter dropped it)'
    : `no frame appeared on ${bus} within ${parsed.timeoutMs}ms — the API brain is not consuming `
      + 'its inbox (crashed, or still loading). Check the "大脑·API" log'
  return {
    status: 504,
    json: {
      ok: false,
      error: missing.length === parsed.targets.length ? 'translation-timeout' : 'partial-translation',
      from: parsed.from,
      to: parsed.targets,
      translations,
      missing,
      elapsedMs,
      hint,
    },
  }
}

/**
 * 等"这一句 + 这一个目标语言"的定稿帧。
 *
 * <p>要跳过的三种帧，每一种都真的会出现在总线上：
 *   · `echo`（原文帧）：大脑对每一句都先写它，`source` 与我们的文字**一样**；
 *   · `partial`（流式增量）：文字是一半，收下就等于字幕倒退；
 *   · 比 baseline 更早的帧：上一句/上一次请求留下的（总线是整文件覆盖，它会一直在）。
 */
async function waitForTranslation({ bus, text, target, deadline, baselineAt }) {
  let lastRaw = ''
  let sawEcho = false
  while (Date.now() < deadline) {
    await sleep(50)
    let raw = ''
    try {
      raw = readFileSync(bus, 'utf-8')
    } catch {
      continue                                     // 总线还没出现（大脑刚起）
    }
    if (raw === lastRaw) continue
    lastRaw = raw
    const frame = parseBusFrame(raw)
    if (frame === null) continue
    if (frame.source !== text) continue
    if (baselineAt !== '' && String(frame.at ?? '') !== '' && String(frame.at) <= baselineAt) continue
    if (frame.echo === true) {
      sawEcho = true
      continue
    }
    if (frame.partial === true) continue           // 流式增量：等定稿
    const got = frameTranslations(frame)
    const value = got[target]
    if (typeof value === 'string' && value.trim() !== '') return { text: value, sawEcho }
  }
  return { text: undefined, sawEcho }
}

/** 总线当前这一帧的 `at`（用来挡住"上一次请求的旧帧"）。读不到就返回空串。 */
function readFrameAt(bus) {
  try {
    const frame = parseBusFrame(readFileSync(bus, 'utf-8'))
    if (frame === null) return ''
    return typeof frame.at === 'string' ? frame.at : ''
  } catch {
    return ''
  }
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}
