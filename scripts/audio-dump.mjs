/**
 * audio-dump.mjs —— 把手机传上来的原始音频导出成**能播的 WAV**，用来听"到底发生了什么"
 * ============================================================================
 *
 *   node scripts/audio-dump.mjs                    # 默认导出最后 30 秒
 *   node scripts/audio-dump.mjs --seconds 120      # 最后 120 秒
 *   node scripts/audio-dump.mjs --all              # 全部（文件可能上百 MB）
 *   node scripts/audio-dump.mjs --data-dir var/live
 *
 * 为什么需要它：转发进程落盘的是**裸 PCM**（`audio-in.pcm`，没有文件头），
 * 播放器不认。而"字幕出不来"这类问题，光看日志是分不清的 ——
 * 电平正常、字节数正常、采样率正常，但音频本身可能：
 *   · 采样率标错了（听上去变快/变慢，像花栗鼠或慢放）
 *   · 通道数错了（比如实际是双声道，按单声道解 → 音高翻倍、左右交错成噪声）
 *   · 位深错了（16bit 当成 8bit → 全是刺啦声）
 *   · 或者干脆就是噪声/静音
 * 这些**只有真的听一遍**才能立刻分辨。所以这个脚本做三件事：
 *
 *   ① 按旁文件里记的采样率导出 → 正常听
 *   ② 按几个候选采样率各导一份 → 哪一份"听起来正常"就是真实采样率
 *      （这是判断采样率最可靠的办法：人耳对变调极其敏感，比看数字准）
 *   ③ 额外导出**重采样到 16 kHz 的那一份** → 就是识别器真正拿到的东西
 *      如果①听着正常而③是坏的，问题在重采样器，不在采集或传输
 *
 * 等价于 ③ 的那段重采样逻辑与 `bridge/whisper_stream.py` 的 `_resample` 一致
 * （线性插值、跨块保持相位连续），这样"听到的"就是"识别器拿到的"。
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { AUDIO_DIR, LIVE_DIR, defaultAudioIn, defaultAudioRate } from '../lib/paths.mjs'

const HELP = `audio-dump —— 把手机传上来的原始 PCM 导成能播放的 WAV

  node scripts/audio-dump.mjs [选项]

选项
  --seconds <n>     只导最后 n 秒（缺省 30；最后几秒通常就够听出问题）
  --all             导出全部（会很大）
  --data-dir <path> 数据目录（缺省 var/live）
  --out <dir>       输出目录（缺省 var/audio）
  --help

输出
  <名称>-raw-<采样率>.wav   按旁文件记的采样率导出（正常应该听着正常）
  <名称>-try-<采样率>.wav   按候选采样率导出（哪份听着正常，真实采样率就是哪个）
  <名称>-as16k.wav          重采样到 16 kHz —— 识别器真正拿到的那一份
`

/** 候选采样率：旁文件里那个之外的常见值也各导一份，靠耳朵定真身。 */
const CANDIDATE_RATES = [16000, 44100, 48000]

export function parseArgs(argv) {
  const options = { seconds: 30, all: false, dataDir: LIVE_DIR, out: AUDIO_DIR }
  const takesValue = new Set(['seconds', 'data-dir', 'out'])
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new Error(`看不懂的参数：${token}（用 --help 看用法）`)
    const key = token.slice(2)
    if (key === 'help') { options.help = true; continue }
    if (key === 'all') { options.all = true; continue }
    if (!takesValue.has(key)) throw new Error(`未知选项 --${key}（用 --help 看用法）`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} 需要一个值`)
    index += 1
    if (key === 'seconds') options.seconds = Number(value)
    else options[key === 'data-dir' ? 'dataDir' : 'out'] = value
  }
  return options
}

/** 16-bit 单声道 PCM 的 WAV 头（44 字节）。 */
export function wavHeader(dataBytes, sampleRate, channels = 1, bitsPerSample = 16) {
  const header = Buffer.alloc(44)
  const byteRate = sampleRate * channels * bitsPerSample / 8
  const blockAlign = channels * bitsPerSample / 8
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)               // fmt 块长度
  header.writeUInt16LE(1, 20)                // 1 = PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataBytes, 40)
  return header
}

/**
 * 线性插值重采样到 16 kHz —— 与 `bridge/whisper_stream.py` 的 `_resample` 同一套插值算法。
 *
 * <p>差别只在分块：Python 那边是**逐块**处理（所以要维护跨块相位），
 * 这里一次性处理整段、不涉及跨块。修好跨块那个 bug 之后，两者结果一致 ——
 * 所以这份导出**能代表识别器真正拿到的东西**。
 */
export function resampleTo16k(samples, fromRate) {
  if (fromRate === 16000 || samples.length === 0) return samples
  const step = fromRate / 16000
  const count = Math.floor(samples.length / step)
  const out = new Float32Array(Math.max(0, count))
  for (let index = 0; index < count; index += 1) {
    const position = index * step
    const low = Math.floor(position)
    const high = Math.min(low + 1, samples.length - 1)
    const fraction = position - low
    out[index] = samples[low] * (1 - fraction) + samples[high] * fraction
  }
  return out
}

/** 统计峰值与 RMS（0~1），用来一眼看出"有没有声音"。 */
export function levels(buffer) {
  let peak = 0
  let sum = 0
  const count = buffer.length >> 1
  for (let index = 0; index < count; index += 1) {
    const sample = buffer.readInt16LE(index * 2) / 32768
    const abs = Math.abs(sample)
    if (abs > peak) peak = abs
    sum += sample * sample
  }
  return { peak, rms: count === 0 ? 0 : Math.sqrt(sum / count), samples: count }
}

function formatSeconds(value) {
  return `${value.toFixed(1)} 秒`
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(HELP)
    return
  }

  const pcmPath = defaultAudioIn(options.dataDir)
  const ratePath = defaultAudioRate(options.dataDir)
  if (!existsSync(pcmPath)) {
    console.log(`没有音频文件：${pcmPath}`)
    console.log('（先跑一次同传，手机上上传过音频之后才会有）')
    return
  }

  let rate = 0
  try {
    rate = Number((await readFile(ratePath, 'utf-8')).trim())
  } catch {
    // 旁文件还没有：说明还没写过（第一块之前）。用疑似值继续，靠候选对比来定。
  }
  if (!Number.isFinite(rate) || rate <= 0) rate = 16000

  const totalBytes = statSync(pcmPath).size
  let bytesToRead = totalBytes
  if (!options.all) {
    bytesToRead = Math.min(totalBytes, Math.round(options.seconds * rate * 2))
  }
  // 只读**尾部**：最后几十秒通常就够听出问题，而且文件可能上百 MB
  const handle = await readFile(pcmPath)
  const slice = handle.subarray(Math.max(0, totalBytes - bytesToRead))

  await mkdir(options.out, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const written = []

  console.log('')
  console.log('─'.repeat(70))
  console.log('  音频导出：' + pcmPath)
  console.log('─'.repeat(70))
  console.log(`  文件总长      ${(totalBytes / 1024 / 1024).toFixed(1)} MB`)
  console.log(`  旁文件采样率  ${rate} Hz`)
  console.log(`  本次导出      ${(slice.length / 1024 / 1024).toFixed(1)} MB`
    + `（${options.all ? '全部' : '最后 ' + options.seconds + ' 秒'}）`)

  // ── 按记录里的采样率导出 ────────────────────────────────────────────────
  const rawLevels = levels(slice)
  console.log('')
  console.log('① 按旁文件记的采样率导出（应该听着正常；变快/变慢说明采样率记错了）')
  for (const candidate of new Set([rate, ...CANDIDATE_RATES])) {
    const duration = slice.length / 2 / candidate
    const name = candidate === rate
      ? `${stamp}-raw-${candidate}.wav`
      : `${stamp}-try-${candidate}.wav`
    const target = join(options.out, name)
    await writeFile(target, Buffer.concat([wavHeader(slice.length, candidate), slice]))
    written.push({ name, rate: candidate, duration })
    console.log(`   ${candidate === rate ? '★' : ' '} ${name}`)
    console.log(`       按 ${candidate} Hz 播放 = ${formatSeconds(duration)}` +
      `   峰值 ${rawLevels.peak.toFixed(3)}  RMS ${rawLevels.rms.toFixed(4)}`)
  }

  // ── 识别器真正拿到的那一份 ──────────────────────────────────────────────
  //
  // 为什么这一份最关键：如果①听着正常、而这一份是坏的（变速、断续、只剩开头），
  // 那问题就在**重采样**，不在采集或传输 —— 这两种原因的修法完全不同。
  const floats = new Float32Array(slice.length >> 1)
  for (let index = 0; index < floats.length; index += 1) {
    floats[index] = slice.readInt16LE(index * 2) / 32768
  }
  const resampled = resampleTo16k(floats, rate)
  const resampledPcm = Buffer.alloc(resampled.length * 2)
  for (let index = 0; index < resampled.length; index += 1) {
    const value = Math.max(-1, Math.min(1, resampled[index]))
    resampledPcm.writeInt16LE(Math.round(value * 32767), index * 2)
  }
  const as16kName = `${stamp}-as16k.wav`
  await writeFile(join(options.out, as16kName),
    Buffer.concat([wavHeader(resampledPcm.length, 16000), resampledPcm]))
  const as16kLevels = levels(resampledPcm)
  const as16kDuration = resampledPcm.length / 2 / 16000
  written.push({ name: as16kName, rate: 16000, duration: as16kDuration })

  console.log('')
  console.log('② 重采样到 16 kHz —— **识别器真正拿到的那一份**')
  console.log(`   ★ ${as16kName}`)
  console.log(`       时长 ${formatSeconds(as16kDuration)}`
    + `（应与①的时长接近，差太多说明重采样器有问题）`)
  console.log(`       峰值 ${as16kLevels.peak.toFixed(3)}  RMS ${as16kLevels.rms.toFixed(4)}`)

  console.log('')
  console.log('─'.repeat(70))
  console.log('  怎么读这个结果')
  console.log('─'.repeat(70))
  const rawDuration = slice.length / 2 / rate
  console.log(`  · ①里哪一份"听着最自然（不变调、不卡顿）"，真实采样率就是哪个`)
  console.log(`  · 拿实际说了多久对一下：按 ${rate} Hz 是 ${formatSeconds(rawDuration)}；`)
  console.log(`    如果你其实只说了大约一半/一倍的时间，说明采样率标错了`)
  console.log('  · ②和①时长接近、也没有断续 → 重采样没问题，问题在别处（切句/模型）')
  console.log('  · ②明显变快/变慢/只剩开头 → 重采样器有问题（看 whisper_stream.py 的 _resample）')
  console.log('  · ①就全是噪声/静音 → 采集或传输的问题，不是识别')
  console.log('')
  console.log(`  导出目录：${options.out}`)
  console.log('')
}

if (process.argv[1] !== undefined
    && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('audio-dump 出错：' + String(error && error.message ? error.message : error))
    process.exitCode = 1
  })
}
