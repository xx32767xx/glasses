/**
 * tts-http.mjs —— 「POST /tts：一句话 → 一段音频」的请求规整与上游调用（5.157）
 * ============================================================================
 *
 * 手机端要念的是**译文/原文**，而它自己可能根本没有这门语言的语音包（巴葡在国内
 * 机型基本不带）。所以由服务器合成、音频回给手机播。
 *
 * 这一层只管三件事，都做成纯函数（能被测试直接喂，不必起服务）：
 *
 *   ① **请求规整**：`{text, lang}` 两个字段，语言只认三门，文本长度有上限；
 *   ② **上游调用**：POST 到内网的 `bridge/tts-server.py`，把 wav 字节原样带回来；
 *   ③ **错误翻译**：上游的 400/500/连不上 → 手机能理解的机器码
 *      （`tts-unavailable` / `tts-failed`），别把 Node 的异常原文糊到界面上。
 *
 * ⚠️ 鉴权与限流**不在这里**：那一层在 relay（`X-Leion-Secret` + token + 版本门禁）。
 *   这里的函数只假设"调用方已经过闸"。
 */

export const TTS_HTTP_LIMITS = Object.freeze({
  langs: ['zh-CN', 'pt-BR', 'en-US'],
  /** 一句译文的长度上限。超了不是"长句"，是调用方把整段文章塞进来了。 */
  maxChars: 600,
  /** 请求体上限：600 字的中文 JSON 也就几 KB，给 64 KB 已经很宽松。 */
  maxBodyBytes: 64 * 1024,
  /** 同时合成几条。合成在服务器上是**串行**的（piper 模型不线程安全），排多了只会一起变慢。 */
  maxInFlight: 2,
})

/** 语言归一：`pt_br` / `PT-BR` / `pt` 都收成 `pt-BR`；认不出来返回空串（**不猜**）。 */
export function normalizeTtsLang(raw) {
  const text = String(raw ?? '').trim().toLowerCase().replace(/_/g, '-')
  if (text === '') return ''
  if (text.startsWith('zh')) return 'zh-CN'
  if (text.startsWith('pt')) return 'pt-BR'
  if (text.startsWith('en')) return 'en-US'
  return ''
}

/**
 * 规整 `POST /tts` 的请求体。
 *
 * @returns {{ok: true, text: string, lang: string} | {ok: false, error: string}}
 */
export function normalizeTtsRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: '请求体必须是 JSON 对象：{"text": "…", "lang": "pt-BR"}' }
  }
  const text = String(body.text ?? '').trim()
  if (text === '') return { ok: false, error: 'text 不能为空' }
  if (text.length > TTS_HTTP_LIMITS.maxChars) {
    return {
      ok: false,
      error: `text 太长（${text.length} 字，上限 ${TTS_HTTP_LIMITS.maxChars}）——`
        + '这个接口是"一句话一段音频"用的',
    }
  }
  const lang = normalizeTtsLang(body.lang)
  if (lang === '') {
    return {
      ok: false,
      error: `lang 只能是 ${TTS_HTTP_LIMITS.langs.join(' / ')}，收到 ${JSON.stringify(body.lang ?? '')}`,
    }
  }
  return { ok: true, text, lang }
}

/**
 * 调上游合成服务。
 *
 * @param {string} baseUrl 如 `http://127.0.0.1:8790`
 * @param {{text: string, lang: string}} request 已规整的请求
 * @returns {Promise<{ok: true, audio: Buffer, synthMs: number, voice: string}
 *   | {ok: false, status: number, error: string, hint: string}>}
 */
export async function requestTts(baseUrl, request, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const timeoutMs = Number(options.timeoutMs ?? 15000)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  let response
  try {
    response = await fetchImpl(String(baseUrl).replace(/\/+$/, '') + '/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: request.text, lang: request.lang }),
      signal: controller.signal,
    })
  } catch (error) {
    clearTimeout(timer)
    // 连不上 / 超时：对手机而言就是"这次没念成"，而且是**服务端**的问题
    return {
      ok: false, status: 503, error: 'tts-unavailable',
      hint: `连不上合成服务：${String(error?.message ?? error).slice(0, 120)}`,
    }
  }
  clearTimeout(timer)
  if (response.ok !== true) {
    // 上游回的是 JSON（我们的 tts-server.py 就是这么写的）；读不出来也不能崩
    let detail = `HTTP ${response.status}`
    try {
      const parsed = await response.json()
      detail = String(parsed?.error ?? detail)
    } catch { /* 不是 JSON 就用状态码 */ }
    const unavailable = response.status >= 500
    return {
      ok: false,
      status: unavailable ? 503 : 400,
      error: unavailable ? 'tts-unavailable' : 'tts-failed',
      hint: detail,
    }
  }
  const audio = Buffer.from(await response.arrayBuffer())
  if (audio.length === 0) {
    return { ok: false, status: 503, error: 'tts-unavailable', hint: '合成服务返回了空音频' }
  }
  return {
    ok: true,
    audio,
    synthMs: Number(response.headers.get('x-leion-tts-synth-ms') ?? 0) || 0,
    voice: String(response.headers.get('x-leion-tts-voice') ?? ''),
  }
}
