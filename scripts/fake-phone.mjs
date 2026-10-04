/**
 * fake-phone.mjs —— 假装自己是手机，把一段音频按块 POST 给继电器
 * ============================================================================
 *   node scripts/fake-phone.mjs --wav <16k 单声道 wav> --url http://127.0.0.1:8788 --secret <密钥>
 *
 * 为什么需要它：
 *   手机端「录音上传」这条路，在没有手机的时候也必须能验证 —— 否则就只能等真机，
 *   而那正是最容易出问题的一环（安卓的录音参数、采样率降级、分块边界）。
 *   这个脚本用和安卓 App **完全相同**的协议发数据：裸 PCM S16LE、每块一秒、
 *   第一块带 ?fresh=1、带 X-Leion-Secret 头。所以它验过的协议，手机端照着实现就行。
 *
 * 常用参数
 *   --chunk-ms <n>   每块多少毫秒（缺省 1000）。安卓端也是这个量级
 *   --realtime       按真实时间发（1 秒音频花 1 秒），用来测真实延迟；不加则尽快发完
 *   --rate <n>       声明采样率（缺省 16000）。用来验证降级到 44100 那条路
 *   --limit <n>      只发前 n 块（调试用）
 *
 * 输入必须是 **16000 Hz 单声道 16-bit** 的 wav —— 这是 Whisper 要的格式。
 * 用 bridge/make_long_wav.py 可以从任意音频生成：
 *   python bridge/make_long_wav.py 录音.m4a var/audio/zh/short-16k.wav --times 1 --gap 0
 */

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { request } from 'node:http'

function parseArgs(argv) {
  const options = { chunkMs: 1000, rate: 16000, realtime: false, timeoutMs: 10000 }
  const takesValue = new Set(['wav', 'url', 'secret', 'chunk-ms', 'rate', 'limit', 'timeout-ms'])
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new Error(`看不懂的参数：${token}`)
    const key = token.slice(2)
    if (key === 'realtime') { options.realtime = true; continue }
    if (key === 'help') { options.help = true; continue }
    if (!takesValue.has(key)) throw new Error(`未知选项 --${key}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} 需要一个值`)
    index += 1
    if (key === 'chunk-ms') options.chunkMs = Number(value)
    else if (key === 'rate') options.rate = Number(value)
    else if (key === 'limit') options.limit = Number(value)
    else if (key === 'timeout-ms') options.timeoutMs = Number(value)
    else options[key] = value
  }
  return options
}

const HELP = `fake-phone —— 假装自己是手机，按块上传音频

  node scripts/fake-phone.mjs --wav <16k 单声道 wav> --url <http://ip:port> --secret <密钥> [选项]

  --wav <path>      要发的音频（必须 16000 Hz 单声道 16-bit）
  --url <url>       继电器地址，例如 http://127.0.0.1:8788
  --secret <value>  共享密钥（继电器启动时会打印）
  --chunk-ms <n>    每块毫秒数，缺省 1000
  --rate <n>        声明采样率，缺省 16000（改成 44100 可验证重采样那条路）
  --realtime        按真实时间发（测真实延迟）
  --limit <n>       只发前 n 块
  --timeout-ms <n>  单次请求超时，缺省 10000
`

/** 读 16-bit PCM wav，只取 data 段。 */
function readWav(path) {
  const buffer = readFileSync(path)
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error(`${path} 不是 RIFF/wav`)
  }
  let offset = 12
  let format = null
  let data = null
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const start = offset + 8
    if (id === 'fmt ') {
      format = {
        channels: buffer.readUInt16LE(start + 2),
        rate: buffer.readUInt32LE(start + 4),
        bits: buffer.readUInt16LE(start + 14),
      }
    } else if (id === 'data') {
      data = buffer.subarray(start, Math.min(start + size, buffer.length))
    }
    offset = start + size + (size % 2)      // chunk 按偶数字节对齐
  }
  if (format === null || data === null) throw new Error('wav 里找不到 fmt 或 data 段')
  return { format, data }
}

function post(url, secret, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const req = request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: 'POST',
      headers: {
        'X-Leion-Secret': secret,
        'content-type': 'application/octet-stream',
        'content-length': body.length,
        'cache-control': 'no-store',
      },
      timeout: timeoutMs,
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8')
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode} ${text}`))
          return
        }
        try {
          resolve(JSON.parse(text))
        } catch (error) {
          reject(new Error(`响应不是 JSON：${text}`))
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error('请求超时')))
    req.on('error', reject)
    req.end(body)
  })
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) { process.stdout.write(HELP); return 0 }
  for (const required of ['wav', 'url']) {
    if (options[required] === undefined) throw new Error(`必须给 --${required}（--help 看用法）`)
  }
  if (options.secret === undefined) throw new Error('必须给 --secret（继电器启动时会打印）')

  const { format, data } = readWav(options.wav)
  if (format.bits !== 16) throw new Error(`只支持 16-bit PCM，收到 ${format.bits} bit`)
  if (format.channels !== 1) throw new Error(`只支持单声道，收到 ${format.channels} 声道`)
  if (format.rate !== options.rate) {
    console.log(`⚠️ 文件采样率 ${format.rate} 与声明的 --rate ${options.rate} 不一致，`
      + `按声明的发（这正是要验证的场景之一）`)
  }

  const bytesPerChunk = Math.max(2, Math.round(options.rate * 2 * options.chunkMs / 1000))
  const totalChunks = Math.ceil(data.length / bytesPerChunk)
  const chunks = options.limit === undefined ? totalChunks : Math.min(options.limit, totalChunks)
  const seconds = data.length / 2 / format.rate

  console.log(`[fake-phone] ${basename(options.wav)}：${seconds.toFixed(1)}s，`
    + `${format.rate} Hz，每块 ${options.chunkMs}ms（${bytesPerChunk} 字节）`
    + `${options.realtime ? '，按真实时间发' : '，尽快发'}`)
  console.log(`[fake-phone] 目标 ${options.url}，共 ${chunks} 块`)

  const started = Date.now()
  let sent = 0
  for (let index = 0; index < chunks; index += 1) {
    const slice = data.subarray(index * bytesPerChunk, (index + 1) * bytesPerChunk)
    const search = new URLSearchParams({ rate: String(options.rate) })
    if (index === 0) search.set('fresh', '1')      // 第一块：告诉继电器"这是新一次录音"
    const result = await post(`${options.url}/audio?${search}`, options.secret, slice, options.timeoutMs)
    sent += slice.length
    const flag = index === 0 ? '（已清空，开始新录音）' : ''
    console.log(`  块 ${index + 1}/${chunks}  ${slice.length} 字节 → `
      + `累计 ${(result.seconds ?? 0).toFixed(1)}s @ ${result.rate}Hz ${flag}`)
    if (options.realtime) {
      const target = started + (index + 1) * options.chunkMs
      const delay = target - Date.now()
      if (delay > 0) await sleep(delay)
    }
  }

  const status = await new Promise((resolve, reject) => {
    const target = new URL(`${options.url}/status?secret=${encodeURIComponent(options.secret)}`)
    const req = request({
      hostname: target.hostname, port: target.port,
      path: target.pathname + target.search, method: 'GET', timeout: 8000,
    }, response => {
      const parts = []
      response.on('data', chunk => parts.push(chunk))
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(parts).toString('utf-8'))) } catch (error) { reject(error) }
      })
    })
    req.on('error', reject)
    req.end()
  })

  console.log(`[fake-phone] 发完：${sent} 字节，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`)
  console.log(`[fake-phone] 继电器侧：音频 ${status.audioBytes} 字节 / ${status.audioChunks} 块`
    + ` @ ${status.audioRate}Hz，收件箱 ${status.inboxLines} 行`)
  console.log('[fake-phone] 下一步：看收件箱有没有变成文字（识别进程要单独跑）')
  return 0
}

try {
  process.exit(await main())
} catch (error) {
  console.error('[fake-phone] ❌ ' + String(error && error.message ? error.message : error))
  process.exit(1)
}
