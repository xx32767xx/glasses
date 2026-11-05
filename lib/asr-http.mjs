/**
 * asr-http.mjs —— 「一次请求、一段音频、一句文字」的 HTTP 接口用到的逻辑（5.117）
 * ============================================================================
 *
 * 背景：有人要**通过 HTTP 调用我们的葡语/英语模型**。我们没有现成的这种接口 ——
 * 现有的链路是"手机持续推流 → 切句 → 队列 → 识别 → 收件箱 → 大脑"，
 * 面向的是**连续会议**，不是"给一段音频、要一句文字"。
 *
 * 所以这里做一个小接口，但**复用同一条识别通路**：把这段音频当成"一段已经切好的话"
 * 写进**同一个队列**，让**同一个识别进程**（模型已经热着的那个）去认。
 * 好处是：返回的文字与会议里会出现的文字**出自同一套策略解析**，
 * 不会出现"接口说用的是 A、会议里跑的是 B"这种两套真相。
 *
 * ⚠️ **这里的面向用户文案一律用英文**：
 * 这个接口的调用方是**外部系统/同事的脚本**，不是装了中文 App 的手机；
 * 而手机那条路的中文错误串有"必须能在 App 里翻译成三语"的硬约束（`tests/android-order-suite` 在查）。
 * 两边混着写的结果是：要么 API 调用方收到看不懂的中文，要么手机端被迫维护一堆它永远收不到的文案。
 * 机器可读的部分放在 `error` 代码里（`recognizer-not-running` 之类），人话放在英文 `error`/`hint` 里。
 *
 * 本文件里既有纯函数（好测、不碰网络）也有一个碰磁盘的编排函数：
 *   · {@link parseWavHeader}   —— 认 WAV 容器（采样率/声道/位深），认不出就说清哪一条不符
 *   · {@link normalizeRequest} —— 校验请求体，算出一段可写进队列的 PCM
 *   · {@link parseInboxLine}   —— 收件箱那一行 → 接口响应用的形状
 *   · {@link transcribeOnce}   —— 真跑一次（入队 → 等收件箱行 → 三分支结局）
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 接口的硬限制。数值都是**故意小的**：这是给"一句话"用的，不是批量转写服务。 */
export const ASR_HTTP_LIMITS = {
  /** 单次音频上限（字节）。16k 单声道 16bit ≈ 32 kB/秒 ⇒ 8 MB ≈ 4 分钟。 */
  maxAudioBytes: 8 * 1024 * 1024,
  /** 单次音频上限（秒）。超过就不是"一句话"了，应该切成多段再调。 */
  maxSeconds: 120,
  /** 缺省等待上限（毫秒）。排队 + 识别都在这里面。 */
  defaultTimeoutMs: 30000,
  /** 允许的最大等待（毫秒）。 */
  maxTimeoutMs: 120000,
  /** 同时最多几个请求在飞（识别进程是**串行**的，压太多只会一起慢）。 */
  maxInFlight: 4,
  /** 支持的音频格式。采样率必须 16000 —— 不替调用方重采样（那会把"听不懂"和"格式不对"混起来）。 */
  formats: ['pcm16', 'wav'],
  /** 支持的语种（与 relay 的 LANGS 一致；真要加语种，先确认策略表里有对应策略）。 */
  languages: ['zh-CN', 'pt-BR', 'en-US'],
}

const WAV_HINT = 'convert with: ffmpeg -i in.wav -ar 16000 -ac 1 -sample_fmt s16 out.wav'

/**
 * 解析 WAV 头。**只认** 16 kHz / 单声道 / 16 bit PCM。
 *
 * <p>为什么不做"帮你重采样"：重采样要引入依赖、要吃 CPU，而且一旦重采样写错，
 * 表现是"识别结果乱"——那会被当成模型问题。所以宁可**明确拒绝**并告诉调用方该转成什么格式，
 * 一句话命令就能解决（ffmpeg -ar 16000 -ac 1 -sample_fmt s16）。
 *
 * @returns {{ok: boolean, rate?: number, channels?: number, bits?: number, dataOffset?: number,
 *            error?: string}}
 */
export function parseWavHeader(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? [])
  if (buf.length < 44) return { ok: false, error: 'WAV is shorter than 44 bytes (header incomplete)' }
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return { ok: false, error: 'not a WAV (missing RIFF/WAVE header); use audioFormat "pcm16" for raw PCM' }
  }
  let offset = 12
  let rate = 0
  let channels = 0
  let bits = 0
  let format = 0
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ' && body + 16 <= buf.length) {
      format = buf.readUInt16LE(body)
      channels = buf.readUInt16LE(body + 2)
      rate = buf.readUInt32LE(body + 4)
      bits = buf.readUInt16LE(body + 14)
    } else if (id === 'data') {
      if (rate === 0) return { ok: false, error: 'WAV has data before fmt (malformed)' }
      const dataOffset = body
      if (format !== 1) {
        return { ok: false, error: `WAV encoding is ${format} (1 = PCM); need 16-bit PCM` }
      }
      if (rate !== 16000) {
        return { ok: false, error: `sample rate is ${rate}, only 16000 is accepted; ${WAV_HINT}` }
      }
      if (channels !== 1) {
        return { ok: false, error: `channels is ${channels}, only 1 (mono) is accepted; ${WAV_HINT}` }
      }
      if (bits !== 16) {
        return { ok: false, error: `bit depth is ${bits}, only 16 is accepted; ${WAV_HINT}` }
      }
      return { ok: true, rate, channels, bits, dataOffset }
    }
    offset = body + size + (size % 2)          // RIFF 块按偶数字节对齐
  }
  return { ok: false, error: 'WAV has no data chunk (truncated file?)' }
}

/**
 * 校验请求体 → 一段可以写进识别队列的 PCM。
 *
 * @param {object} body 请求体（JSON）
 * @param {{maxAudioBytes?: number, maxSeconds?: number, defaultTimeoutMs?: number,
 *          maxTimeoutMs?: number, languages?: string[], formats?: string[]}} [limits]
 * @returns {{ok: boolean, error?: string, lang?: string, pcm?: Buffer, bytes?: number,
 *            audioSeconds?: number, timeoutMs?: number}}
 */
export function normalizeRequest(body, limits = {}) {
  const max = { ...ASR_HTTP_LIMITS, ...limits }
  const source = body !== null && typeof body === 'object' && !Array.isArray(body) ? body : null
  if (source === null) return { ok: false, error: 'request body must be a JSON object' }

  const lang = String(source.lang ?? '').trim()
  if (lang === '') {
    return { ok: false, error: `missing "lang" (one of: ${max.languages.join(' / ')})` }
  }
  if (!max.languages.includes(lang)) {
    return { ok: false, error: `"lang" must be one of ${max.languages.join(' / ')}, got ${JSON.stringify(lang)}` }
  }

  const format = String(source.audioFormat ?? 'pcm16').trim().toLowerCase()
  if (!max.formats.includes(format)) {
    return { ok: false, error: `"audioFormat" must be one of ${max.formats.join(' / ')}, got ${JSON.stringify(format)}` }
  }

  const raw = source.audioBase64 ?? source.audio ?? null
  if (typeof raw !== 'string' || raw.trim() === '') {
    return {
      ok: false,
      error: 'missing "audioBase64": base64 of the audio bytes '
        + '(16 kHz mono 16-bit raw PCM, or a WAV container with audioFormat "wav")',
    }
  }
  let bytes
  try {
    bytes = Buffer.from(raw.replace(/\s+/g, ''), 'base64')
  } catch {
    return { ok: false, error: '"audioBase64" is not valid base64' }
  }
  if (bytes.length === 0) return { ok: false, error: '"audioBase64" decoded to zero bytes' }
  if (bytes.length > max.maxAudioBytes) {
    return {
      ok: false,
      error: `audio too large (${bytes.length} bytes, limit ${max.maxAudioBytes}). `
        + 'This endpoint takes ONE utterance: split longer audio into sentences',
    }
  }

  let pcm = bytes
  if (format === 'wav') {
    const header = parseWavHeader(bytes)
    if (!header.ok) return { ok: false, error: header.error }
    pcm = bytes.subarray(header.dataOffset)
  }
  if (pcm.length % 2 !== 0) {
    return { ok: false, error: `PCM byte count is odd (${pcm.length}); 16-bit samples need an even count` }
  }
  const audioSeconds = pcm.length / 2 / 16000
  if (audioSeconds > max.maxSeconds) {
    return {
      ok: false,
      error: `audio is ${audioSeconds.toFixed(1)}s, above the ${max.maxSeconds}s per-request limit`,
    }
  }
  if (audioSeconds < 0.2) {
    return { ok: false, error: `audio is only ${audioSeconds.toFixed(2)}s; shorter than 0.2s is not a sentence` }
  }

  const timeoutRaw = source.timeoutMs
  let timeoutMs = max.defaultTimeoutMs
  if (timeoutRaw !== undefined && timeoutRaw !== null && timeoutRaw !== '') {
    const value = Number(timeoutRaw)
    if (!Number.isFinite(value) || value <= 0) {
      return { ok: false, error: `"timeoutMs" must be a positive number, got ${JSON.stringify(timeoutRaw)}` }
    }
    timeoutMs = Math.min(Math.round(value), max.maxTimeoutMs)
  }
  return { ok: true, lang, pcm, bytes: pcm.length, audioSeconds, timeoutMs }
}

/**
 * 收件箱那一行 → 接口响应用的形状。
 *
 * <p>为什么从收件箱读、而不是直接读 python 的 stdout：识别进程写这一行的时候**已经**
 * 决定好了"这句走的是哪个策略/模型"，接口只要照搬，就不可能与会议里的行为不一致。
 */
export function parseInboxLine(line) {
  const text = String(line ?? '').trim()
  if (text === '') return null
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return null
  }
  if (payload === null || typeof payload !== 'object') return null
  const spoken = typeof payload.text === 'string' ? payload.text : ''
  return {
    text: spoken,
    lang: typeof payload.from === 'string' ? payload.from : null,
    strategy: typeof payload.strategy === 'string' ? payload.strategy : null,
    model: typeof payload.model === 'string' ? payload.model : null,
  }
}

/** 生成一个"合成房间号"：让识别进程能把这句送回**这次请求**，且不会撞上真房间。 */
export function apiRoomId(random = Math.random) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let index = 0; index < 8; index += 1) {
    out += alphabet[Math.floor(random() * alphabet.length) % alphabet.length]
  }
  return `api-${out}`
}

/**
 * 把一段音频当成"一句已经切好的话"送进识别队列，等它出字（5.117）。
 *
 * <p><b>为什么复用队列而不是自己加载模型</b>：这条链路的模型是**热的**（会议里刚用过），
 * 而且"这段走哪个策略/引擎/模型"由 `resolve_strategy` 一处决定 ——
 * 接口与会议因此不可能出现两套真相。代价也必须说清：识别进程是**串行**的，
 * 请求会和正在进行的会议抢那一个消费者（所以接口层有 `maxInFlight` 与超时）。
 *
 * <p>三种结局必须分开（否则调用方只能瞎猜）：
 *   · 出字 → 200 + `text`；
 *   · 认了但没字（真没人声 / 太轻）→ 200 + `empty:true` —— **这不叫失败**；
 *   · 段一直没被取走（识别进程没跑 / 被长会议段占着）→ 504，并指出"队列里没人取"。
 *
 * @param {{dataDir: string, queueDir?: string}} options
 * @param {object} parsed {@link normalizeRequest} 的成功结果
 * @returns {Promise<{status: number, json: object}>}
 */
export async function transcribeOnce(options, parsed) {
  const dataDir = String(options?.dataDir ?? '')
  const queueDir = options?.queueDir ?? join(dataDir, 'queue', 'asr')
  const room = apiRoomId()
  const base = `${Date.now()}-${room}-000`
  const pcmPath = join(queueDir, `${base}.pcm`)
  const metaPath = join(queueDir, `${base}.json`)
  const inboxPath = join(dataDir, `asr-inbox-${room}.jsonl`)
  const startedAt = Date.now()
  try {
    if (!existsSync(queueDir)) {
      return {
        status: 503,
        json: {
          ok: false,
          error: 'recognizer-not-running',
          hint: `recognition queue not found (${queueDir}) — no recognizer process on this host. `
            + 'Start the pipeline first (scripts/start-multi.mjs or start-all.mjs)',
        },
      }
    }
    // 先写 pcm、最后写 meta：消费者只认 meta 存在的段（与切句进程同一约定）
    writeFileSync(`${pcmPath}.part`, parsed.pcm)
    renameSync(`${pcmPath}.part`, pcmPath)
    writeFileSync(metaPath, JSON.stringify({
      room,
      rate: 16000,
      ms: Math.round(parsed.audioSeconds * 1000),
      // 语种用**标签**（pt-BR）：识别侧两种写法都认，标签更不容易被误读成别的语种
      lang: parsed.lang,
      speaker: 'api',
      strategy: null,
      queuedAt: Date.now(),
    }), 'utf-8')

    const deadline = startedAt + parsed.timeoutMs
    while (Date.now() < deadline) {
      await sleep(50)
      let content = ''
      try {
        content = readFileSync(inboxPath, 'utf-8')
      } catch {
        continue
      }
      const lines = content.split('\n').filter(one => one.trim() !== '')
      if (lines.length > 0) {
        const hit = parseInboxLine(lines[lines.length - 1])
        if (hit !== null) {
          return {
            status: 200,
            json: {
              ok: true,
              text: hit.text,
              lang: hit.lang ?? parsed.lang,
              strategy: hit.strategy,
              model: hit.model,
              audioSeconds: Number(parsed.audioSeconds.toFixed(2)),
              elapsedMs: Date.now() - startedAt,
              empty: hit.text.trim() === '',
            },
          }
        }
      }
    }
    // 超时：分清"没人消费"和"消费了但没出字"
    if (!existsSync(metaPath)) {
      return {
        status: 200,
        json: {
          ok: true,
          text: '',
          lang: parsed.lang,
          strategy: null,
          model: null,
          audioSeconds: Number(parsed.audioSeconds.toFixed(2)),
          elapsedMs: Date.now() - startedAt,
          empty: true,
          reason: 'the recognizer processed this segment but produced no text (no speech? too quiet?)',
        },
      }
    }
    return {
      status: 504,
      json: {
        ok: false,
        error: 'recognizer-timeout',
        hint: `segment still queued after ${parsed.timeoutMs}ms — the recognizer is not picking it up `
          + '(not running, or busy with a long meeting segment). '
          + 'Check the "queue depth" / "by profile" lines in the relay log',
      },
    }
  } finally {
    // 清理：无论成败都不留垃圾（否则 api-xxxx 会在 queue/inbox 里越积越多）
    for (const path of [`${pcmPath}.part`, pcmPath, metaPath, inboxPath]) {
      try {
        unlinkSync(path)
      } catch { /* 不在了就算了 */ }
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}
