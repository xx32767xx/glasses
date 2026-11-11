/**
 * audio-usage.mjs —— 「录音占了多少磁盘、按房间列出来、能删」（5.171）
 * ============================================================================
 *
 * 为什么要有这一层：一场会 + 一段翻译官会话就能攒下几百 MB（16 kHz / 16-bit / 单声道
 * ≈ 115 MB/小时/路），而**用户看不见它们**。于是磁盘满时只能看到一句"音频文件已达上限"，
 * 却不知道是谁占的、该删哪一场。
 *
 * 布局（见 relay/lan-relay.mjs 的 roomTrackDir，两处规则必须一致 —— 有测试对账）：
 *
 *   <data-dir>/audio/<房间>/<说话人>.pcm    ← 5.08 起的分轨，一场会一个目录
 *   <data-dir>/audio/<房间>.pcm            ← 老的单文件（历史数据）
 *   <data-dir>/audio-in.pcm  (+ .1)        ← 单房间/旧模式的总线文件，不按房间分
 *
 * ⚠️ 这里只**读和删**，不写：写入路径只有 relay 一处，别让两处都能建文件。
 */

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 与 relay 的 roomTrackDir / roomAudioPath 同一套清洗规则（有测试对账）。 */
export function safeRoomId(raw) {
  const value = String(raw ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
  return value === '' ? 'unknown' : value
}

export function audioRoot(root) {
  return join(String(root ?? ''), 'audio')
}

/**
 * 当前占用。
 *
 * <p>⚠️ **一场会只有一行**（5.173）。relay 写同一路音频时其实落了两份：
 * `audio/<房间>/<说话人>.pcm`（分轨，识别真正跟的）和 `audio/<房间>.pcm`（混流副本，
 * 老的单文件尾随模式用）。早先这里把两者当成两场会列，于是管理台上同一个邀请码出现两行、
 * 大小还一模一样 —— 看着像"两场会"或"我删错了"，其实是同一场的两份。
 * 现在混流副本作为那场会的一条音轨（`(混流副本)`）挂在同一行里，删一次两份一起没。
 *
 * @returns {{
 *   totalBytes: number,
 *   legacyBytes: number,
 *   rooms: Array<{roomId: string, bytes: number, tracks: Array<{speaker: string, bytes: number}>}>,
 * }}
 */
export function audioUsage(root, options = {}) {
  const exists = options.exists ?? existsSync
  const readdir = options.readdir ?? ((target) => readdirSync(target, { withFileTypes: true }))
  const stat = options.stat ?? ((target) => statSync(target))
  const dir = audioRoot(root)
  let legacyBytes = 0
  const rooms = []
  // 旧模式的单文件不算进任何房间（它不按房间分），单列一项，免得"总数对不上"
  for (const name of ['audio-in.pcm', 'audio-in.pcm.1']) {
    try { legacyBytes += stat(join(String(root ?? ''), name)).size } catch { /* 没有就没有 */ }
  }
  if (!exists(dir)) return { totalBytes: legacyBytes, legacyBytes, rooms }
  let entries = []
  try {
    entries = readdir(dir)
  } catch {
    return { totalBytes: legacyBytes, legacyBytes, rooms }
  }
  let total = legacyBytes
  const findByRoom = (roomId) => rooms.find((one) => one.roomId === roomId)
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const tracks = []
      let bytes = 0
      try {
        for (const file of readdir(full)) {
          if (file.isDirectory()) continue
          let size = 0
          try { size = stat(join(full, file.name)).size } catch { /* 正在写 */ }
          if (size <= 0) continue
          bytes += size
          // 说话人 = 文件名里 `.pcm` 之前的部分（`ana.pcm` / `ana.pcm.lang` / `ana.pcm.rate`
          // 都算 ana 这一路 —— 旁文件不单列，否则列表里会冒出一个叫 "ana.pcm.lang" 的"说话人"）
          const cut = file.name.indexOf('.pcm')
          const speaker = cut >= 0 ? file.name.slice(0, cut)
            : (file.name.includes('.') ? file.name.slice(0, file.name.lastIndexOf('.')) : file.name)
          const hit = tracks.find((one) => one.speaker === speaker)
          if (hit === undefined) tracks.push({ speaker, bytes: size })
          else hit.bytes += size
        }
      } catch { /* 目录刚被删 */ }
      if (bytes > 0) {
        const existed = findByRoom(entry.name)
        if (existed === undefined) rooms.push({ roomId: entry.name, bytes, tracks: sortTracks(tracks) })
        else {
          // 目录与它的混流副本都在：并成一行（同一场会，不该出现两行）
          existed.bytes += bytes
          for (const one of tracks) {
            const hit = existed.tracks.find((trackOne) => trackOne.speaker === one.speaker)
            if (hit === undefined) existed.tracks.push(one)
            else hit.bytes += one.bytes
          }
        }
        total += bytes
      }
      continue
    }
    // 老的单文件（`<房间>.pcm`）：同一场会已有分轨目录时并进去，否则单独成一行（老数据）
    if (!entry.name.endsWith('.pcm')) continue
    let size = 0
    try { size = stat(full).size } catch { /* 正在写 */ }
    if (size <= 0) continue
    const roomId = entry.name.slice(0, -4)
    const hit = findByRoom(roomId)
    if (hit === undefined) {
      rooms.push({ roomId, bytes: size, tracks: [{ speaker: MIXED_LABEL, bytes: size }] })
    } else {
      hit.bytes += size
      hit.tracks.push({ speaker: MIXED_LABEL, bytes: size })
    }
    total += size
  }
  for (const one of rooms) one.tracks = sortTracks(one.tracks)
  rooms.sort((a, b) => b.bytes - a.bytes)
  return { totalBytes: total, legacyBytes, rooms }
}

/** 混流副本那条音轨的名字（与"说话人"区分开：它不是某个人，是同一路音频的第二份拷贝）。 */
export const MIXED_LABEL = '(混流副本)'

/** 音轨按大小从大到小；混流副本永远排最后（它是重复的那一份，不该抢在最前面）。 */
function sortTracks(tracks) {
  return tracks.sort((a, b) => {
    if (a.speaker === MIXED_LABEL) return 1
    if (b.speaker === MIXED_LABEL) return -1
    return b.bytes - a.bytes
  })
}

/**
 * 删掉**一场会**的录音（分轨目录 + 老的单文件）。
 *
 * <p>只删音频，不碰字幕/历史/数据库 —— 那些有各自的入口（管理台的「会议历史」）。
 * 这么分是因为"腾磁盘空间"和"删会议记录"是两件事，混在一起会让人不敢按。
 */
export function purgeRoomAudio(root, roomId, options = {}) {
  const exists = options.exists ?? existsSync
  const stat = options.stat ?? ((target) => statSync(target))
  const remove = options.remove ?? ((target) => rmSync(target, { recursive: true, force: true }))
  const safe = safeRoomId(roomId)
  const dir = join(audioRoot(root), safe)
  const single = join(audioRoot(root), `${safe}.pcm`)
  let freed = 0
  const removed = []
  for (const target of [dir, single]) {
    if (!exists(target)) continue
    try {
      freed += target === dir ? sumOf(target, options) : stat(target).size
      remove(target)
      removed.push(target)
    } catch (error) {
      return { ok: false, error: `删不掉 ${target}：${error?.message ?? error}`, freedBytes: freed, removed }
    }
  }
  if (removed.length === 0) return { ok: false, error: `没有这场会的录音：${safe}`, freedBytes: 0, removed }
  return { ok: true, roomId: safe, freedBytes: freed, removed }
}

/** 删掉 `audio/` 下**所有**房间的录音（只删目录内的音频，不动别的数据）。 */
export function purgeAllAudio(root, options = {}) {
  const exists = options.exists ?? existsSync
  const usage = audioUsage(root, options)
  let freed = 0
  const failed = []
  for (const room of usage.rooms) {
    const result = purgeRoomAudio(root, room.roomId, options)
    if (result.ok === true) freed += result.freedBytes
    else failed.push(room.roomId)
  }
  // 旧模式的单文件也一并清（否则"清光了"还占着几百 MB）
  const remove = options.remove ?? ((target) => rmSync(target, { recursive: true, force: true }))
  for (const name of ['audio-in.pcm', 'audio-in.pcm.1']) {
    const target = join(String(root ?? ''), name)
    if (!exists(target)) continue
    try {
      freed += (options.stat ?? ((one) => statSync(one)))(target).size
      remove(target)
    } catch { /* 有人正写着：下一次再删 */ }
  }
  return { ok: failed.length === 0, freedBytes: freed, failed }
}

function sumOf(dir, options = {}) {
  const readdir = options.readdir ?? ((target) => readdirSync(target, { withFileTypes: true }))
  const stat = options.stat ?? ((target) => statSync(target))
  let total = 0
  let entries = []
  try { entries = readdir(dir) } catch { return 0 }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) { total += sumOf(full, options); continue }
    try { total += stat(full).size } catch { /* 正在写 */ }
  }
  return total
}
