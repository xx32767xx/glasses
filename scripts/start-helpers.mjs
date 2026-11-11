/**
 * start-helpers.mjs —— 启动脚本共用的几件小事（5.175 从 start-all.mjs 抽出来）
 * ============================================================================
 *
 * 为什么单独一个文件：这些函数原本住在 scripts/start-all.mjs 里，而 start-all
 * （单管线、尾随全局 audio-in.pcm 的老模式）已在 5.175 删除。但 start-multi 一直在借用
 * 其中几个（端口探测、子进程环境、日志收尾与归档、数据目录可写检查）—— 删脚本不能把
 * 这些一起删掉，所以原样搬到这里，一份实现、两处不再各抄一遍。
 *
 * 里面没有任何"老模式"语义：都是与"怎么起进程 / 怎么收尾"有关的通用动作。
 */

import { connect } from 'node:net'
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, WHISPER_CACHE_DIR } from '../lib/paths.mjs'

export function portInUse(port, timeoutMs = 800) {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port })
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))       // 有人监听
    socket.once('timeout', () => finish(false))      // 没人应答（防火墙丢包等）
    socket.once('error', () => finish(false))        // ECONNREFUSED 等 = 没人在听
  })
}

export function childEnv(base = process.env) {
  const env = { ...base }
  const notes = []
  if (!env.HF_HOME) {
    env.HF_HOME = WHISPER_CACHE_DIR
    notes.push(`模型缓存 → ${WHISPER_CACHE_DIR.replace(ROOT, '.').replace(/\\/g, '/')}`)
  }
  if (!env.HF_ENDPOINT) {
    // 直连 huggingface.co 在国内基本下不动（实测 3 分钟 2.5MB）；镜像可覆盖。
    // 想直连就自己设 HF_ENDPOINT=https://huggingface.co
    env.HF_ENDPOINT = 'https://hf-mirror.com'
    notes.push(`下载源 → ${env.HF_ENDPOINT}（想直连就自己设 HF_ENDPOINT）`)
  }
  // Python 的 stdio 编码：不强制的话，Windows 中文环境下它用 GBK 写管道，
  // 而桥按 UTF-8 读 —— 识别结果会变成乱码，插件判不出语种，一句字幕都出不来。
  // （脚本自己也做了 sys.stdout.reconfigure，这里是第二道；手动起 python 时靠脚本那道。）
  let pythonEncoding = false
  if (!env.PYTHONUTF8) { env.PYTHONUTF8 = '1'; pythonEncoding = true }
  if (!env.PYTHONIOENCODING) { env.PYTHONIOENCODING = 'utf-8'; pythonEncoding = true }
  if (pythonEncoding) notes.push('Python 输出编码 → UTF-8（不设的话识别结果会变乱码，见 README）')
  return { env, notes }
}

export async function flushLogStreams(logs) {
  const streams = Object.values(logs ?? {})
  await Promise.all(streams.map(stream => new Promise(resolve => { stream.end(resolve) })))
}

export function sessionStamp(date = new Date()) {
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

export function archiveSessionLogs({ logsDir, keys, stamp = sessionStamp() }) {
  // ⚠️ 目录名要**先找一个没被占用的**，而不是直接用时间戳。
  //    同一秒内启动两次（或者上一次的归档还在，例如两个终端各跑一个 start-all）
  //    会让两次的日志落进同一个目录，后一次把前一次**盖掉** ——
  //    而那正是"想翻日志时发现日志没了"的那类损失，且无声无息。
  //    所以撞名就加 -2 / -3。目录**惰性创建**：确认真要有东西归档才建，
  //    免得每次启动失败的尝试都留下一个空目录。
  let dir = null
  const freeDir = () => {
    const base = join(logsDir, 'archive', stamp)
    if (existsSync(base) === false) return base
    for (let n = 2; n < 100; n += 1) {
      const candidate = `${base}-${n}`
      if (existsSync(candidate) === false) return candidate
    }
    return `${base}-${Date.now()}`
  }

  const moved = []
  for (const key of keys) {
    const from = join(logsDir, `${key}.log`)
    if (existsSync(from) === false) continue
    let text = ''
    try {
      text = readFileSync(from, 'utf-8')
    } catch { continue }
    // 只有启动头 → 这次运行没留下任何东西，不留空壳
    if (meaningfulLineCount(text) === 0) continue
    if (dir === null) dir = freeDir()
    try {
      mkdirSync(dir, { recursive: true })
      try {
        // 首选改名（原子、不占双份空间）。
        renameSync(from, join(dir, `${key}.log`))
      } catch {
        // ⚠️ Windows 上**另一个终端正用 `Get-Content -Wait` 盯着这个文件时改名会失败**
        //    （文件被占用）。这是很可能发生的用法，所以退回复制 + 删除；
        //    再不行就放弃这一份 —— **归档是收尾的杂活，绝不能因为它让退出卡住或报错**。
        copyFileSync(from, join(dir, `${key}.log`))
        unlinkSync(from)
      }
      moved.push(key)
    } catch { /* 单份失败不影响其他份 */ }
  }
  if (moved.length === 0) return { archived: false, dir: null, keys: [] }
  return { archived: true, dir, keys: moved }
}

export function assertDataDirWritable(dataDir) {
  try {
    mkdirSync(dataDir, { recursive: true })
    const probe = join(dataDir, '.start-all-probe')
    writeFileSync(probe, 'ok')
    unlinkSync(probe)
    return null
  } catch (error) {
    return describeDataDirProblem(dataDir, error)
  }
}
