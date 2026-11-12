/**
 * meeting-log.mjs —— 会议记录（5.181）
 * ============================================================================
 *
 * 为什么要把"日志"和"会议记录"分开：
 *   原来所有输出都在 **控制台**（生产就进 journald），一条流里混着几十次启动、几十场会，
 *   而且每次启动 `var/logs/*.log` 还会被截断 —— 于是"事后想查某一场会"基本做不到。
 *   用户要的东西其实很具体：**一场会一个文件，实时写，能人工读**。
 *
 * 于是定下这一份**业务记录**（不是运维流水）：
 *
 *   <data-dir>/logs/rooms/<邀请码>-<房间id>.jsonl   ← 一场会一个文件，**每句一行，实时追加**
 *   <data-dir>/logs/service-YYYYMMDD.jsonl          ← 不知道该算哪场会的事（TTS 起不来、库坏了…）
 *
 * 几个刻意的决定：
 *   ① **一行一条 JSON**：`grep` 能用、`jq` 能用、Excel 能读、人也能读；
 *   ② **实时追加**（appendFileSync）：不是会议结束才落盘 —— 用户要拿它现场校准；
 *   ③ 跟着 `--data-dir` 走：live / test 各自一份，互不污染（旧 `var/logs` 在代码目录里，是两套账）；
 *   ④ 写失败**绝不拖停业务**：记录是旁路，抛异常只报一次，然后闭嘴。
 *
 * 记什么：会议开始/结束、每句话（原文 + 各语言译文 + 四段耗时）、与这场会相关的异常。
 * 不记：音频字节、密钥、提示词、每块音频的流水。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 会议记录目录（跟着数据目录走）。 */
export function logsDirOf(dataDir) {
  return join(String(dataDir ?? ''), 'logs')
}

/** 房间文件名里能用的邀请码（没有就用 `noroom` 占位）。 */
export function safeCode(code) {
  const text = String(code ?? '').replace(/[^0-9A-Za-z#_-]/g, '').trim()
  return text === '' ? 'noroom' : text.slice(0, 24)
}

/** 房间目录名里能用的 id（与 relay 的清洗规则一致：只留字母数字下划线连字符）。 */
export function safeRoom(roomId) {
  const text = String(roomId ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
  return text === '' ? 'unknown' : text
}

/** 一场会的记录文件路径：`logs/rooms/229415-room-mwd9acyp-0u2x.jsonl`。 */
export function meetingLogPath(dataDir, { code = '', roomId = '' } = {}) {
  return join(logsDirOf(dataDir), 'rooms', `${safeCode(code)}-${safeRoom(roomId)}.jsonl`)
}

/** 服务级记录文件（按天）：`logs/service-20261112.jsonl`。 */
export function serviceLogPath(dataDir, now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  return join(logsDirOf(dataDir), `service-${stamp}.jsonl`)
}

/** 写一行（尽量小、尽量稳：写不进去只报一次，绝不抛给业务）。 */
const warned = new Set()
function appendLine(path, record) {
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    appendFileSync(path, JSON.stringify(record) + '\n', 'utf-8')
    return true
  } catch (error) {
    if (warned.has(path) !== true) {
      warned.add(path)
      // 记录是旁路：失败要说一次，然后闭嘴（否则每分钟几百行反而成灾）
      console.error(`[记录] ⚠️ 写不进会议记录（${path}）：${error && error.message ? error.message : error}`)
    }
    return false
  }
}

/**
 * 追加一条会议事件。
 *
 * @param {string} dataDir 数据目录（与 `--data-dir` 一致）
 * @param {{code?: string, roomId?: string}} where 这场会的身份
 * @param {object} record 事件本身（`kind` 必填：meeting / sentence / warn / error）
 */
export function appendMeetingEvent(dataDir, where, record) {
  if (String(dataDir ?? '') === '') return false
  const body = { t: new Date().toISOString(), ...record }
  return appendLine(meetingLogPath(dataDir, where ?? {}), body)
}

/** 追加一条服务级事件（不属于任何一场会的那种）。 */
export function appendServiceEvent(dataDir, record) {
  if (String(dataDir ?? '') === '') return false
  return appendLine(serviceLogPath(dataDir), { t: new Date().toISOString(), kind: 'service', ...record })
}

/** 列出所有会议记录文件（新的在前）。 */
export function listMeetingLogs(dataDir) {
  const dir = join(logsDirOf(dataDir), 'rooms')
  let names = []
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
  } catch {
    return []
  }
  return names.map((name) => {
    const path = join(dir, name)
    let bytes = 0
    let mtimeMs = 0
    try {
      const info = statSync(path)
      bytes = Number(info.size ?? 0)
      mtimeMs = Number(info.mtimeMs ?? 0)
    } catch { /* 刚被删 */ }
    const stem = name.replace(/\.jsonl$/, '')
    const cut = stem.indexOf('-room-')
    return {
      path,
      name,
      code: cut > 0 ? stem.slice(0, cut) : '',
      roomId: cut > 0 ? stem.slice(cut + 1) : stem,
      bytes,
      mtimeMs,
    }
  }).sort((left, right) => right.mtimeMs - left.mtimeMs)
}

/** 读一个记录文件的全部事件（坏行跳过，不抛）。 */
export function readMeetingEvents(path) {
  let text = ''
  try {
    text = readFileSync(path, 'utf-8')
  } catch {
    return []
  }
  const out = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    try {
      const one = JSON.parse(line)
      if (one !== null && typeof one === 'object') out.push(one)
    } catch { /* 正在写/写坏了：跳过这一行 */ }
  }
  return out
}

/** 这个数据目录里有没有任何会议记录。 */
export function hasMeetingLogs(dataDir) {
  return existsSync(join(logsDirOf(dataDir), 'rooms'))
}
