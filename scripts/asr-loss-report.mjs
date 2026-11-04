#!/usr/bin/env node
/**
 * asr-loss-report.mjs —— 认「丢掉的话」有多少（5.71 / 待办 ①）
 * ============================================================================
 *
 * 为什么要有这个工具：`docs/21` 5.52 就把"丢掉音节"的埋点做完了，但那些数字只散在日志里 ——
 * 于是实机排查时反复出现同一种误判：
 *
 *   · 一段话没出字幕 → 先怀疑模型不行（其实是被「电平偏低 → 按静音丢弃」丢掉了）；
 *   · 电压门槛调到 0.008 之后"看起来好了" → 但没人知道**还剩多少段被丢**、丢的是不是说话；
 *   · 切句层「语音只有 300ms < min-speech 500ms」这种碎片，和识别层的电平丢弃是**两个不同的洞**，
 *     日志里长得差不多，混着看就分不清该调哪个参数。
 *
 * 所以这里把三类事件分开统计，并给出**该调到的门槛**（当日志里已经算出来的那个值取中位）：
 *
 *   ① 切句层丢碎片：`[切句] ⚠️ 丢掉一段碎片：1.1s–1.4s（语音只有 300ms < min-speech 500ms）`
 *   ② 识别层低电平丢弃：`[识别] [丢弃 3.7s，房间 …：电平偏低（原始 0.0131，门槛 0.02）… 调到 0.0105]`
 *   ③ 识别层近乎静音丢弃：`[识别] [丢弃 2.5s，房间 …：近乎静音（原始电平 0.0072 < 0.02）…]`
 *
 * 用法
 *   node scripts/asr-loss-report.mjs /tmp/leion.log
 *   node scripts/asr-loss-report.mjs /tmp/leion.log --json var/asr-loss.json
 *   cat /tmp/leion.log | node scripts/asr-loss-report.mjs -
 *
 * ⚠️ 它**只读日志**，不碰音频、不重跑模型。判读纪律：
 *    「丢的段里电平接近门槛」→ 是门槛问题（调 --silence-skip-level）；
 *    「丢的段电平远低于门槛」→ 多半真的是静音（不用管）；
 *    「切句碎片占比高」→ 是 min-speech 或 silence 的问题，跟模型无关。
 */

import { readFileSync, writeFileSync } from 'node:fs'

/** 日志里三种丢弃事件 + 两类过程事实。正则都写成"容忍不同措辞"的样子。 */
const PATTERNS = {
  // [切句] ⚠️ 丢掉一段碎片：1.1s–1.4s （语音只有 300ms < min-speech 500ms）
  fragment: /丢掉一段碎片[：:]\s*([\d.]+)s\s*[–\-~]\s*([\d.]+)s\s*（\s*语音只有\s*(\d+)\s*ms\s*<\s*min-speech\s*(\d+)\s*ms/,
  // [识别]   [丢弃 3.7s，房间 room-x：电平偏低（原始 0.0131，门槛 0.02）→ 按静音丢弃。⚠️ … 调到 0.0105 左右…]
  // [识别]   [丢弃 2.5s，房间 room-x：近乎静音（原始电平 0.0072 < 0.02) → 解码前丢弃…]
  //
  // ⚠️ 这两句的括号里**两种写法都有**（实测同一份日志里同时出现）：
  //    「电平偏低（原始 0.0131，门槛 0.02）」   ← 逗号
  //    「近乎静音（原始电平 0.0072 < 0.02）」   ← 小于号
  // 第一版只按"小于号"写，于是 **3 条丢弃只认出 1 条** —— 那种"看起来对、其实漏一半"的
  // 数比没有更糟，所以这里两种都收，并且**认不出时宁愿报 0 而不是猜**。
  levelDrop: /\[丢弃\s*([\d.]+)s，房间\s*([^：\]]+)：(电平偏低|近乎静音)（\s*原始?(?:电平)?\s*([\d.]+)\s*(?:，门槛\s*([\d.]+)|<\s*([\d.]+))）/,
  suggested: /--silence-skip-level\s*调到\s*([\d.]+)/,
  // [切句] room-x test3 → 1793…-000（0.6s，策略 default，尾部静音裁掉 1100ms，累计 1 段）
  segment: /→\s*\S+-\d+（([\d.]+)s，策略\s*(\S+?)，尾部静音裁掉\s*(\d+)ms，累计\s*(\d+)\s*段/,
  // [识别] [asr-worker] [识别] 房间 room-x 策略 default（模型 tiny，切句由 default） → 0.6s 出字
  transcript: /房间\s*(\S+)\s*策略\s*(\S+?)\s*（模型\s*([^，）]+)[^）]*）\s*→\s*([\d.]+)s\s*出字/,
  // [转发] [15:50:07]    音平 █········· 峰值 0.039 RMS 0.0083
  level: /音平.*峰值\s*([\d.]+)\s*RMS\s*([\d.]+)/,
}

/** 从日志文本里抽出所有事件（纯函数，测试直接喂字符串）。 */
export function parseLog(text) {
  const fragments = []
  const drops = []
  const segments = []
  const transcripts = []
  let levelPeaks = []
  let levelRms = []
  let lastRoom = ''
  let thresholdSeen = []

  for (const line of String(text ?? '').split(/\r?\n/)) {
    // 房间 id 出现在很多行里，先记下来给后面"没有房间号的事件"用
    const roomHit = /房间\s*(room-[A-Za-z0-9-]+)|\b(room-[A-Za-z0-9-]+)\b/.exec(line)
    if (roomHit) lastRoom = roomHit[1] ?? roomHit[2]

    const fragment = PATTERNS.fragment.exec(line)
    if (fragment) {
      fragments.push({
        room: lastRoom,
        startS: Number(fragment[1]),
        endS: Number(fragment[2]),
        voicedMs: Number(fragment[3]),
        minSpeechMs: Number(fragment[4]),
      })
      continue
    }
    const drop = PATTERNS.levelDrop.exec(line)
    if (drop) {
      const suggested = PATTERNS.suggested.exec(line)
      // 两种写法各占一个捕获组：门槛 = 「，门槛 X」或「< X」里那个
      const threshold = Number(drop[5] ?? drop[6])
      thresholdSeen.push(threshold)
      drops.push({
        room: String(drop[2]).trim(),
        seconds: Number(drop[1]),
        kind: drop[3] === '近乎静音' ? 'near-silence' : 'low-level',
        level: Number(drop[4]),
        threshold,
        // 日志自己算好的"调到多少就能救回" —— 有就用，没有就按 0.8 倍估
        suggested: suggested ? Number(suggested[1]) : Number((Number(drop[4]) * 0.8).toFixed(4)),
      })
      continue
    }
    const transcript = PATTERNS.transcript.exec(line)
    if (transcript) {
      transcripts.push({
        room: transcript[1], strategy: transcript[2], model: transcript[3].trim(),
        seconds: Number(transcript[4]),
      })
      continue
    }
    const segment = PATTERNS.segment.exec(line)
    if (segment) {
      segments.push({
        room: lastRoom, seconds: Number(segment[1]), strategy: segment[2],
        tailTrimMs: Number(segment[3]), cumulative: Number(segment[4]),
      })
      continue
    }
    const level = PATTERNS.level.exec(line)
    if (level) {
      levelPeaks.push(Number(level[1]))
      levelRms.push(Number(level[2]))
    }
  }
  return { fragments, drops, segments, transcripts, levelPeaks, levelRms, thresholds: thresholdSeen }
}

const median = (values) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

const round = (value, digits = 3) => (value === null ? null : Number(value.toFixed(digits)))

/** 汇总成"人要看的那几个数"（纯函数）。 */
export function summarize(parsed) {
  const rooms = new Map()
  const touch = (room) => {
    const key = room || '(未知房间)'
    if (!rooms.has(key)) {
      rooms.set(key, { room: key, segments: 0, transcribed: 0, dropped: 0, droppedSec: 0,
        fragments: 0, fragmentSec: 0, tailTrimMs: [], models: new Set() })
    }
    return rooms.get(key)
  }

  for (const segment of parsed.segments) touch(segment.room).segments += 1
  for (const item of parsed.transcripts) {
    const room = touch(item.room)
    room.transcribed += 1
    room.models.add(item.model)
  }
  for (const drop of parsed.drops) {
    const room = touch(drop.room)
    room.dropped += 1
    room.droppedSec += drop.seconds
  }
  for (const fragment of parsed.fragments) {
    const room = touch(fragment.room)
    room.fragments += 1
    room.fragmentSec += (fragment.endS - fragment.startS)
  }
  for (const segment of parsed.segments) touch(segment.room).tailTrimMs.push(segment.tailTrimMs)

  const list = [...rooms.values()].map((room) => ({
    room: room.room,
    segments: room.segments,
    transcribed: room.transcribed,
    dropped: room.dropped,
    droppedSec: round(room.droppedSec, 2),
    fragments: room.fragments,
    fragmentSec: round(room.fragmentSec, 2),
    tailTrimMsMedian: room.tailTrimMs.length === 0 ? null : Math.round(median(room.tailTrimMs)),
    models: [...room.models],
    // ⚠️ 刻意**不算**"丢了百分之几"：分母（这一场到底说了多久）日志里没有，
    //    用"段+丢弃"当分母会得出一个看似精确、其实没意义的百分比。只报绝对秒数。
    lostSec: round(room.droppedSec + room.fragmentSec, 2),
  })).sort((left, right) => right.lostSec - left.lostSec)

  const byKind = { 'low-level': 0, 'near-silence': 0 }
  for (const drop of parsed.drops) byKind[drop.kind] += 1
  const rescued = parsed.drops.filter((drop) => drop.kind === 'low-level')
  const suggested = rescued.map((drop) => drop.suggested).filter((value) => Number.isFinite(value))

  return {
    rooms: list,
    totals: {
      segments: parsed.segments.length,
      transcribed: parsed.transcripts.length,
      droppedCount: parsed.drops.length,
      droppedSec: round(parsed.drops.reduce((sum, drop) => sum + drop.seconds, 0), 2),
      fragments: parsed.fragments.length,
      fragmentSec: round(parsed.fragments.reduce((sum, fragment) => sum + (fragment.endS - fragment.startS), 0), 2),
      byKind,
      models: [...new Set(parsed.transcripts.map((item) => item.model))],
    },
    levels: {
      peakMedian: round(median(parsed.levelPeaks), 4),
      rmsMedian: round(median(parsed.levelRms), 4),
      samples: parsed.levelRms.length,
    },
    threshold: {
      used: [...new Set(parsed.thresholds)].sort((a, b) => a - b),
      // 建议值取"日志自己算出的救回门槛"的中位；没有就 null（不猜）
      suggest: suggested.length === 0 ? null : round(median(suggested), 4),
    },
  }
}

/** 打印成一张表（给人看的）。 */
export function formatReport(report, options = {}) {
  const lines = []
  const { totals, levels, threshold } = report
  lines.push('识别丢话体检（只读日志：不碰音频、不重跑模型）')
  lines.push('')
  lines.push(`段数 ${totals.segments} · 出字 ${totals.transcribed} · 丢弃 ${totals.droppedCount} 段`
    + `（${totals.droppedSec}s）· 切句碎片 ${totals.fragments} 段（${totals.fragmentSec}s）`)
  lines.push(`丢弃构成：电平偏低 ${totals.byKind['low-level']} 段、近乎静音 ${totals.byKind['near-silence']} 段`)
  if (totals.models.length > 0) lines.push(`实际用过的模型：${totals.models.join(' / ')}`)
  if (levels.samples > 0) {
    lines.push(`relay 侧电平（${levels.samples} 块）：RMS 中位 ${levels.rmsMedian}、峰值中位 ${levels.peakMedian}`)
  }
  if (threshold.used.length > 0) {
    lines.push(`日志里的判定门槛：${threshold.used.join(' / ')}`
      + `${threshold.suggest === null ? '' : `　→ 想让这些段不被丢，建议 --silence-skip-level ${threshold.suggest}`}`)
  }
  if (report.rooms.length > 0) {
    lines.push('')
    lines.push(`${'房间'.padEnd(26)} ${'段'.padStart(4)} ${'出字'.padStart(5)} ${'丢段'.padStart(5)} `
      + `${'丢秒'.padStart(7)} ${'碎片'.padStart(5)} ${'尾裁中位'.padStart(9)}  模型`)
    for (const room of report.rooms) {
      lines.push(`${room.room.slice(0, 26).padEnd(26)} ${String(room.segments).padStart(4)} `
        + `${String(room.transcribed).padStart(5)} ${String(room.dropped).padStart(5)} `
        + `${String(room.droppedSec).padStart(7)} ${String(room.fragments).padStart(5)} `
        + `${String(room.tailTrimMsMedian ?? '-').padStart(9)}  ${room.models.join(',') || '-'}`)
    }
  }
  lines.push('')
  lines.push('判读：丢的段电平**接近**门槛 → 是门槛问题（调 --silence-skip-level）；')
  lines.push('      电平远低于门槛 → 多半真是静音（不用管）；')
  lines.push('      切句碎片占比高 → 是 min-speech/silence 的问题，跟模型无关。')
  if (options.note) lines.push(`\n${options.note}`)
  return lines.join('\n')
}

function main(argv) {
  const args = { input: '', json: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item === '--json') args.json = argv[index += 1] ?? ''
    else if (item === '--help' || item === '-h') {
      console.log('用法：node scripts/asr-loss-report.mjs <日志文件|-> [--json <输出>]')
      return 0
    } else if (args.input === '') args.input = item
    else {
      console.error(`多出来的参数：${item}`)
      return 2
    }
  }
  if (args.input === '') {
    console.error('用法：node scripts/asr-loss-report.mjs <日志文件|-> [--json <输出>]')
    console.error('  （日志来自：node scripts/start-multi.mjs … 2>&1 | tee /tmp/leion.log）')
    return 2
  }
  let text = ''
  try {
    text = args.input === '-' ? readFileSync(0, 'utf-8') : readFileSync(args.input, 'utf-8')
  } catch (error) {
    console.error(`读不到 ${args.input}：${String(error?.message ?? error)}`)
    return 2
  }
  const report = summarize(parseLog(text))
  console.log(formatReport(report))
  if (args.json) {
    writeFileSync(args.json, JSON.stringify(report, null, 2), 'utf-8')
    console.log(`\n已写 ${args.json}`)
  }
  return 0
}

// 被 import 时不执行 main（测试要拿纯函数，不要副作用）
if (process.argv[1] && process.argv[1].endsWith('asr-loss-report.mjs')) {
  process.exit(main(process.argv.slice(2)))
}
