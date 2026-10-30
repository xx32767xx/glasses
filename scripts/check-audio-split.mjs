#!/usr/bin/env node
/**
 * check-audio-split.mjs —— 验证"音频按房间分流"是不是真的分开了（4.85）
 * ============================================================================
 *
 *   # ① 看一眼现在有哪些房间在说话、各收了多少
 *   node scripts/check-audio-split.mjs --host http://127.0.0.1:8789 --secret <密钥>
 *
 *   # ② 盯着看（每 2 秒刷新一次，显示每个房间**这 2 秒涨了多少字节**）
 *   node scripts/check-audio-split.mjs --host http://127.0.0.1:8789 --secret <密钥> --watch
 *
 *   # ③ 不用手机也能造出"两个房间同时在说话"，直接验证不串
 *   node scripts/check-audio-split.mjs --host http://127.0.0.1:8789 --secret <密钥> \
 *        --self-test --rooms room-A,room-B --seconds 4
 *
 * ⚠️ 它验的是**音频层**：两个房间的音频块各进各的文件、互不混合。
 *    "两路识别同时跑"是另一件事（每路要一份算力），见 docs/21 §4.84。
 */

import { setTimeout as sleep } from 'node:timers/promises'

function parseArgs(argv) {
  const out = { host: 'http://127.0.0.1:8789', secret: '', watch: false, selfTest: false,
    rooms: ['room-A', 'room-B'], seconds: 3, intervalMs: 2000 }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--host') out.host = argv[++i]
    else if (arg === '--secret') out.secret = argv[++i]
    else if (arg === '--rooms') out.rooms = String(argv[++i] ?? '').split(',').filter(Boolean)
    else if (arg === '--seconds') out.seconds = Number(argv[++i])
    else if (arg === '--watch') out.watch = true
    else if (arg === '--self-test') out.selfTest = true
    else if (arg === '--interval') out.intervalMs = Number(argv[++i])
    else if (arg === '--help' || arg === '-h') out.help = true
    else throw new Error(`看不懂的参数：${arg}`)
  }
  if (out.rooms.length < 2) out.rooms = ['room-A', 'room-B']
  return out
}

const kb = (n) => `${(Number(n) / 1024).toFixed(1)} KB`

async function fetchRooms(options) {
  const response = await fetch(`${options.host}/audio/rooms`, {
    headers: { 'X-Leion-Secret': options.secret },
  })
  const body = await response.json()
  if (body.ok !== true) throw new Error(`/audio/rooms 失败：${JSON.stringify(body)}`)
  return body
}

/** 造一块"像音频"的字节：静音是合法的 PCM，识别侧不会因此崩。 */
function silentChunk(sampleRate = 16000, ms = 200) {
  const bytes = Math.round(sampleRate * 2 * (ms / 1000))
  return Buffer.alloc(bytes, 0)
}

async function postAudio(options, room, bytes) {
  const response = await fetch(`${options.host}/audio?rate=16000&lang=zh-CN&room=${encodeURIComponent(room)}`, {
    method: 'POST',
    headers: { 'X-Leion-Secret': options.secret, 'Content-Type': 'application/octet-stream' },
    body: bytes,
  })
  return response.status
}

function printTable(snapshot, previous, title) {
  const rows = snapshot.rooms
    .slice()
    .sort((a, b) => String(a.room).localeCompare(String(b.room)))
  console.log(`\n${title}（${new Date().toLocaleTimeString()}）`)
  if (rows.length === 0) {
    console.log('  （没有任何房间上传过音频）')
    return
  }
  console.log('  房间                        文件大小      本周期增长')
  for (const row of rows) {
    const before = previous?.get(row.room)?.size ?? row.size
    const delta = row.size - before
    console.log(`  ${String(row.room).padEnd(24)}  ${kb(row.size).padStart(10)}  ${delta === 0 ? '—' : `+${kb(delta)}`}`)
  }
  console.log(`  目录：${snapshot.audioDir}`)
}

async function selfTest(options) {
  console.log(`自检：往 ${options.host} 的 ${options.rooms.join(' / ')} 各灌 ${options.seconds} 秒静音音频`)
  const before = await fetchRooms(options)
  const baseline = new Map(before.rooms.map((one) => [one.room, one.size]))

  const chunk = silentChunk()
  const rounds = Math.max(1, Math.round((options.seconds * 1000) / 200))
  for (let i = 0; i < rounds; i += 1) {
    await Promise.all(options.rooms.map((room) => postAudio(options, room, chunk)))
    await sleep(200)
  }
  await sleep(400)

  const after = await fetchRooms(options)
  const grown = new Map()
  for (const row of after.rooms) {
    grown.set(row.room, row.size - (baseline.get(row.room) ?? 0))
  }
  printTable(after, new Map(after.rooms.map((one) => [one.room, { size: one.size - (grown.get(one.room) ?? 0) }])),
    '各房间收到的字节数')

  let ok = true
  for (const room of options.rooms) {
    const delta = grown.get(room) ?? 0
    const expected = rounds * chunk.length
    const good = delta === expected
    if (!good) ok = false
    console.log(`  ${good ? '✓' : '✗'} ${room}：本周期收到 ${kb(delta)}（期望 ${kb(expected)}）`)
  }
  // 每个房间收到的量彼此独立 —— 如果混流，某个房间会多收别人的字节
  const sizes = [...grown.values()].filter((value) => value > 0)
  const independent = sizes.every((value) => value === sizes[0])
  if (!independent) ok = false
  console.log(`  ${independent ? '✓' : '✗'} 各房间字节数彼此独立（没有交叉混入）`)
  console.log(ok ? '\n✅ 音频分流正常' : '\n❌ 分流有问题：检查 relay 是否已升级到 4.84+')
  return ok
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log('node scripts/check-audio-split.mjs --host <url> --secret <密钥> [--watch] [--self-test]')
    return 0
  }
  if (options.secret === '') throw new Error('缺少 --secret（请求头 X-Leion-Secret）')

  if (options.selfTest) return (await selfTest(options)) ? 0 : 1

  let previous = null
  do {
    const snapshot = await fetchRooms(options)
    printTable(snapshot, previous, '各房间音频')
    previous = new Map(snapshot.rooms.map((one) => [one.room, { size: one.size }]))
    if (!options.watch) break
    await sleep(options.intervalMs)
  } while (true)
  return 0
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(`✗ ${String(error && error.message ? error.message : error)}`)
  process.exit(1)
})
