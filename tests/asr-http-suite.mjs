/**
 * asr-http-suite.mjs —— `/asr/transcribe`（给外部调用方的 HTTP 识别接口，5.117）
 * ============================================================================
 *
 * 这个接口的**风险点**不是"能不能出字"，而是三件容易做错的事：
 *   ① 校验没做严 → 别人传 20 分钟的音频、44.1k 的 mp3、或者别的语种，我们都照收，
 *      表现是"识别结果很烂"而不是"参数不对"；
 *   ② 三种结局混在一起 → "没人声""识别进程没跑""真的出错"都变成同一个 500/超时，
 *      调用方只能瞎猜（这个项目反复踩过的坑）；
 *   ③ 请求结束不清理 → api-xxxx 的队列文件与收件箱越积越多。
 *
 * 所以这里用一个**假识别进程**（读队列 → 删段 → 写收件箱行）把真实往返跑一遍。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { VAR_DIR } from '../lib/paths.mjs'
import {
  ASR_HTTP_LIMITS, apiRoomId, normalizeRequest, parseInboxLine, parseWavHeader, transcribeOnce,
} from '../lib/asr-http.mjs'

const BASE = join(VAR_DIR, 'test', 'asr-http-suite')

/** 造一段 16k 单声道 16bit 的音频（正弦波，够长就会被"识别"出东西）。 */
function makePcm(seconds = 1.0, { silence = false } = {}) {
  const samples = Math.round(16000 * seconds)
  const buffer = Buffer.alloc(samples * 2)
  for (let index = 0; index < samples; index += 1) {
    const value = silence ? 0 : Math.round(Math.sin(index / 8) * 8000)
    buffer.writeInt16LE(value, index * 2)
  }
  return buffer
}

/** 造一个最小合法 WAV 头 + 数据。 */
function makeWav(pcm, { rate = 16000, channels = 1, bits = 16, format = 1 } = {}) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(format, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * channels * bits / 8, 28)
  header.writeUInt16LE(channels * bits / 8, 32)
  header.writeUInt16LE(bits, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

export async function runAsrHttpSuite({ it, check }) {
  // 这一节自带标题（run-all 的 helpers 里没有 heading）：直接打一行，保持报告结构一致
  console.log('\nHTTP 识别接口（5.117）：一段音频 → 一句文字，参数要严、三种结局要分开')

  await it('请求校验：语种 / 格式 / 大小 / 时长都要能挡住，而且说清哪里不对', () => {
    const pcm = makePcm(1.0)

    const missingLang = normalizeRequest({ audioBase64: pcm.toString('base64') })
    check('缺 lang → 明确报错并列出可选值', missingLang.ok === false
      && missingLang.error.includes('lang') && missingLang.error.includes('pt-BR'), missingLang.error)

    const badLang = normalizeRequest({ lang: 'ja-JP', audioBase64: pcm.toString('base64') })
    check('语种不在支持列表 → 报错（不是悄悄按别的语种认）',
      badLang.ok === false && badLang.error.includes('ja-JP'), badLang.error)

    const good = normalizeRequest({ lang: 'pt-BR', audioBase64: pcm.toString('base64') })
    check('正常请求通过，并算出音频时长（1.0 秒）',
      good.ok === true && Math.abs(good.audioSeconds - 1.0) < 0.01, JSON.stringify(good.audioSeconds))

    const tooLong = normalizeRequest({
      lang: 'pt-BR', audioBase64: makePcm(ASR_HTTP_LIMITS.maxSeconds + 1).toString('base64'),
    })
    check('超过单次时长上限 → 报错并说明"这是给一句话用的"',
      tooLong.ok === false && tooLong.error.includes(String(ASR_HTTP_LIMITS.maxSeconds)),
      tooLong.error)

    const tooShort = normalizeRequest({ lang: 'pt-BR', audioBase64: makePcm(0.05).toString('base64') })
    check('太短的音频（50ms）→ 报错（那是噪声，不是一句话）',
      tooShort.ok === false && tooShort.error.includes('0.2'), tooShort.error)

    const odd = normalizeRequest({ lang: 'pt-BR', audioBase64: Buffer.alloc(101).toString('base64') })
    check('奇数字节 → 报错（16bit 采样必须是偶数）',
      odd.ok === false && /odd/i.test(odd.error), odd.error)

    const notBase64 = normalizeRequest({ lang: 'pt-BR', audioBase64: '' })
    check('缺 audioBase64 → 报错并说清该放什么', notBase64.ok === false
      && notBase64.error.includes('audioBase64'), notBase64.error)
  })

  await it('WAV 容器：只认 16k / 单声道 / 16bit PCM，其它照实说该转成什么', () => {
    const pcm = makePcm(0.5)
    const ok = parseWavHeader(makeWav(pcm))
    check('合法 WAV 能读到采样率与数据偏移',
      ok.ok === true && ok.rate === 16000 && ok.dataOffset === 44, JSON.stringify(ok))

    const wrongRate = parseWavHeader(makeWav(pcm, { rate: 44100 }))
    check('44.1k → 明确拒绝，并给出 ffmpeg 转法',
      wrongRate.ok === false && wrongRate.error.includes('44100')
      && wrongRate.error.includes('ffmpeg'), wrongRate.error)

    const stereo = parseWavHeader(makeWav(pcm, { channels: 2 }))
    check('双声道 → 拒绝并说明要单声道', stereo.ok === false
      && /channels/i.test(stereo.error) && /mono/i.test(stereo.error), stereo.error)

    const float = parseWavHeader(makeWav(pcm, { format: 3 }))
    check('浮点 WAV（format=3）→ 拒绝（要 16bit PCM）', float.ok === false, float.error)

    const notWav = parseWavHeader(Buffer.alloc(64, 'x'))
    check('不是 WAV → 提示可以改用 audioFormat:"pcm16"', notWav.ok === false
      && notWav.error.includes('pcm16'), notWav.error)

    const throughRequest = normalizeRequest({
      lang: 'en-US', audioFormat: 'wav', audioBase64: makeWav(makePcm(0.5)).toString('base64'),
    })
    check('走请求体时 WAV 会自动剥掉头（只把 PCM 送去识别）',
      throughRequest.ok === true && throughRequest.bytes === 16000, JSON.stringify(throughRequest.bytes))
  })

  await it('收件箱那一行 → 接口响应：文字与"这句走了哪个策略/模型"都要带上', () => {
    const line = JSON.stringify({
      text: 'bom dia', from: 'pt-BR', strategy: 'pt-funasr',
      model: 'fun-asr-realtime', speakerName: 'api',
    })
    const parsed = parseInboxLine(line)
    check('能读出文字 / 语种 / 策略 / 模型',
      parsed.text === 'bom dia' && parsed.lang === 'pt-BR'
      && parsed.strategy === 'pt-funasr' && parsed.model === 'fun-asr-realtime', JSON.stringify(parsed))
    check('坏行返回 null（不让一个坏段把接口拖崩）', parseInboxLine('{ 不是 JSON') === null)
    check('空行返回 null', parseInboxLine('   ') === null)
  })

  await it('合成房间号：带 api- 前缀、每次不同（不会撞上真房间）', () => {
    const first = apiRoomId()
    const second = apiRoomId()
    check('形如 api-xxxxxxxx', /^api-[a-z0-9]{8}$/.test(first), first)
    check('两次不同', first !== second, `${first} / ${second}`)
  })

  await it('真实往返：假识别进程取队列 → 写收件箱 → 接口返回文字，并且不留垃圾', async () => {
    rmSync(BASE, { recursive: true, force: true })
    const queueDir = join(BASE, 'queue')
    mkdirSync(queueDir, { recursive: true })
    // 这个假"识别进程"每 20ms 看一次队列：删段 + 写一行收件箱（真实进程也是这个顺序）
    const stop = { done: false, timer: null }
    const tick = () => {
      if (stop.done) return
      for (const name of readdirSync(queueDir)) {
        if (!name.endsWith('.json')) continue
        const base = name.slice(0, -'.json'.length)
        const meta = JSON.parse(readFileSync(join(queueDir, name), 'utf-8'))
        unlinkSync(join(queueDir, name))
        try {
          unlinkSync(join(queueDir, `${base}.pcm`))
        } catch { /* 已经没了 */ }
        if (meta.lang === 'pt-BR') {
          writeFileSync(join(BASE, `asr-inbox-${meta.room}.jsonl`),
            JSON.stringify({ text: 'olá, tudo bem', from: 'pt-BR', strategy: 'pt-funasr' }) + '\n',
            'utf-8')
        }
        // 其它语种故意不写：用来验"认了但没字"
      }
      stop.timer = setTimeout(tick, 20)
    }
    tick()

    try {
      const hit = await transcribeOnce(
        { dataDir: BASE, queueDir }, normalizeRequest({
          lang: 'pt-BR', audioBase64: makePcm(1.0).toString('base64'),
        }))
      check('出字 → 200 且带策略名（和会议里一个口径）',
        hit.status === 200 && hit.json.text === 'olá, tudo bem'
        && hit.json.strategy === 'pt-funasr', JSON.stringify(hit.json))
      check('响应里带 audioSeconds 与 elapsedMs（调用方能算延迟）',
        typeof hit.json.audioSeconds === 'number' && typeof hit.json.elapsedMs === 'number',
        JSON.stringify(hit.json))
      check('请求结束后不留垃圾（队列与收件箱都清干净）',
        readdirSync(queueDir).length === 0
        && !existsSync(join(BASE, 'asr-inbox-api-nonexistent.jsonl')),
        JSON.stringify(readdirSync(BASE)))

      const silent = await transcribeOnce(
        { dataDir: BASE, queueDir }, normalizeRequest({
          lang: 'en-US', audioBase64: makePcm(1.0).toString('base64'), timeoutMs: 800,
        }))
      check('认了但没字 → 200 + empty:true（这不叫失败）',
        silent.status === 200 && silent.json.empty === true, JSON.stringify(silent.json))

      const nobody = await transcribeOnce(
        { dataDir: BASE, queueDir: join(BASE, 'nope') }, normalizeRequest({
          lang: 'pt-BR', audioBase64: makePcm(1.0).toString('base64'),
        }))
      check('识别进程没在跑（队列目录不存在）→ 503 + 告诉你去起管线',
        nobody.status === 503 && nobody.json.error === 'recognizer-not-running',
        JSON.stringify(nobody.json))
    } finally {
      stop.done = true
      if (stop.timer !== null) clearTimeout(stop.timer)
      rmSync(BASE, { recursive: true, force: true })
    }
  })
}
