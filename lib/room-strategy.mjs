/**
 * room-strategy.mjs —— 会议创建时**冻结**的识别策略（5.148）
 * ============================================================================
 *
 * 为什么要有它：策略表 `<数据目录>/asr-models.json` 是**热读**的（切句与识别两侧都按 mtime 重读），
 * 所以管理员一改表，**正在开的会当场换模型** —— 前半段一个模型、后半段另一个，
 * 字幕风格与错率都变了，事后还没法归因。
 *
 * 本模块只干三件事：
 *   ① 建房那一刻，把"当前有效策略"逐语言抄一份到 `room-strategy/<房间>.json`；
 *   ② 读这份快照（读不到就是"没有快照"，交给调用方回落全局表）；
 *   ③ 追加审计（`asr-audit.jsonl`）—— 谁、何时、把哪场会锁成了什么。
 *
 * 三条刻意约束：
 *   · **只冻结"用哪个模型"**（engine / runtime / model / compute_type）；
 *     切句参数（停顿时长、上限）**不冻结** —— 它属于"怎么收音"，管理员调它通常是要立刻生效。
 *   · **写一次、不覆盖**（幂等）：两个请求同时建房时，"文件已存在"就是成功，
 *     绝不出现"A 的快照被 B 覆盖"。
 *   · **快照来自服务器自己的表**，不接受手机上报 —— 与 5.108 删掉"手机自带模型覆盖层"的结论一致。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadStrategyTable, resolveProfile, strategyNameOf } from './asr-engines.mjs'

/**
 * 取某一层里某个字段（**只用于 mergeLayer 不搬运的那些**，例如 parakeet 的 `runtime`）。
 *
 * <p>为什么要它：`lib/asr-engines.mjs` 的 `mergeLayer` 只搬 `engine/model/compute_type/beam_size`
 * 四个字段（与 Python 的 MODEL_FIELDS 对齐）。而 `runtime`（onnx / nemo）不在其中 ——
 * 少了它，"这场会到底走 GPU 还是 CPU"这件事就从快照里丢了，界面上只能看到引擎名。
 */
export function layerValue(table, lang, strategy, key) {
  const layers = [table?.default, table?.strategies?.[strategy], table?.languages?.[lang]]
  let found
  for (const layer of layers) {
    if (layer === null || typeof layer !== 'object' || Array.isArray(layer)) continue
    const value = layer[key]
    if (value === undefined || value === null || value === '') continue
    found = value
  }
  return found
}

/** 快照里要保留的识别字段（切句不在其中 —— 见文件头）。 */
export const STRATEGY_FIELDS = ['strategy', 'engine', 'runtime', 'model', 'compute_type', 'beam_size']

/** 快照目录与审计文件名（与 `room-langs/`、`room-pipeline/` 同一族，都在数据目录下）。 */
export const ROOM_STRATEGY_DIR = 'room-strategy'
export const AUDIT_FILE = 'asr-audit.jsonl'

export function roomStrategyDir(dataDir) {
  return join(String(dataDir ?? ''), ROOM_STRATEGY_DIR)
}

/** 房间 id 会被直接当文件名：只留安全字符（与 `room-pipeline` 的清洗规则一致）。 */
export function safeRoomId(roomId) {
  return String(roomId ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'unknown'
}

export function roomStrategyPath(dataDir, roomId) {
  return join(roomStrategyDir(dataDir), `${safeRoomId(roomId)}.json`)
}

export function auditPath(dataDir) {
  return join(String(dataDir ?? ''), AUDIT_FILE)
}

/**
 * 从策略表算出一份**快照**：逐语言把"最终生效的识别字段"落成静态值。
 *
 * <p>为什么落成静态值而不是"记住策略名、运行时再查表"：记住名字的话，
 * 管理员把那条策略改了（或删了），在跑的会议就会跟着变 —— 那就等于没冻结。
 *
 * @param {object|null} table 当前策略表
 * @param {{ roomId: string, lockedBy?: string, at?: number, sourceHash?: string, languages?: string[] }} options
 */
export function snapshotForRoom(table, options = {}) {
  const langs = Array.isArray(options.languages) && options.languages.length > 0
    ? options.languages
    : ['zh-CN', 'pt-BR', 'en-US']
  const languages = {}
  for (const lang of langs) {
    const strategyName = strategyNameOf(table, lang)
    const profile = resolveProfile(table, lang, strategyName)
    const picked = { strategy: strategyName }
    for (const key of STRATEGY_FIELDS) {
      if (key === 'strategy') continue
      const value = profile?.[key] ?? (key === 'runtime' ? layerValue(table, lang, strategyName, key) : undefined)
      if (value === undefined || value === null || value === '') continue
      picked[key] = value
    }
    languages[lang] = picked
  }
  return {
    roomId: String(options.roomId ?? ''),
    lockedAt: new Date(Number(options.at ?? Date.now())).toISOString(),
    lockedBy: String(options.lockedBy ?? ''),
    source: 'asr-models.json',
    sourceHash: String(options.sourceHash ?? ''),
    tableVersion: Number(table?.version ?? 2),
    languages,
  }
}

/** 读快照：读不到/坏了都返回 null（**回落全局表**，不抛给调用方）。 */
export function readRoomStrategy(dataDir, roomId, readFile = readFileSync) {
  if (!dataDir || !roomId) return null
  let text
  try {
    text = readFile(roomStrategyPath(dataDir, roomId), 'utf-8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(String(text).replace(/^\uFEFF/, ''))
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.languages !== 'object') return null
    return parsed
  } catch {
    // 快照写坏了不能阻断会议：回落全局表，并让调用方在日志里说一句
    return null
  }
}

/**
 * 写快照（幂等、原子）：已存在就**直接返回 existed**，不覆盖。
 *
 * @returns {{ ok: boolean, existed: boolean, path: string, error?: string }}
 */
export function writeRoomStrategy(dataDir, roomId, snapshot, io = {}) {
  const path = roomStrategyPath(dataDir, roomId)
  const exists = io.exists ?? existsSync
  try {
    if (exists(path)) return { ok: true, existed: true, path }
    const mkdir = io.mkdir ?? mkdirSync
    const write = io.write ?? ((target, body) => writeFileSync(target, body, 'utf-8'))
    const rename = io.rename ?? renameSync
    mkdir(roomStrategyDir(dataDir), { recursive: true })
    // 先写 .part 再改名：消费者永远看不到"写了一半的快照"
    const tmp = `${path}.part`
    write(tmp, `${JSON.stringify(snapshot, null, 2)}\n`)
    rename(tmp, path)
    return { ok: true, existed: false, path }
  } catch (error) {
    return { ok: false, existed: false, path, error: String(error?.message ?? error) }
  }
}

/**
 * 一场会议、一门语言，最终用哪个识别配置（**给界面显示与排障用**）。
 *
 * <p>优先级与识别侧一致：**房间快照 > 全局表**（切句不在其中）。
 * 返回值里的 `source` / `lockedAt` 要让界面能说清"这是冻结的，还是当前表"。
 */
export function resolveForRoom(table, lang, snapshot) {
  const fromSnapshot = snapshot?.languages?.[lang]
  if (fromSnapshot && typeof fromSnapshot === 'object') {
    return {
      ...fromSnapshot,
      source: 'room-strategy',
      lockedAt: String(snapshot.lockedAt ?? ''),
      lockedBy: String(snapshot.lockedBy ?? ''),
    }
  }
  const strategyName = strategyNameOf(table, lang)
  const profile = resolveProfile(table, lang, strategyName)
  const out = { strategy: strategyName, source: 'asr-models.json', lockedAt: '', lockedBy: '' }
  for (const key of STRATEGY_FIELDS) {
    if (key === 'strategy') continue
    const value = profile?.[key] ?? (key === 'runtime' ? layerValue(table, lang, strategyName, key) : undefined)
    if (value === undefined || value === null || value === '') continue
    out[key] = value
  }
  return out
}

/** 一次算清三门语言（房间详情/开发模式面板要的就是这个形状）。 */
export function resolveAllLanguages(table, snapshot, languages = ['zh-CN', 'pt-BR', 'en-US']) {
  const out = {}
  for (const lang of languages) out[lang] = resolveForRoom(table, lang, snapshot)
  return out
}

/** 追加一行审计（单行写，不加锁；失败不影响主流程）。 */
export function appendAudit(dataDir, entry, io = {}) {
  try {
    const append = io.append ?? ((path, body) => appendFileSync(path, body, 'utf-8'))
    append(auditPath(dataDir), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/**
 * 建房那一刻的完整动作：读当前表 → 算快照 → 落盘（幂等）→ 记审计。
 *
 * <p>为什么抽成一个函数：relay 里那段 inline 逻辑要能被**单测**直接调；
 * 而且"冻结"这件事只有一条路径，就不会出现"某处少写了审计"。
 *
 * @param {string} dataDir 数据目录
 * @param {string} roomId 房间 id（房号/邀请码都不行，必须是 id）
 * @param {{ by?: string, at?: number, table?: object|null }} options
 *   `table` 给了就用它（测试注入），否则读 `<dataDir>/asr-models.json`
 * @returns {{ ok: boolean, existed?: boolean, snapshot?: object, path?: string, error?: string }}
 */
export function lockRoomStrategy(dataDir, roomId, options = {}) {
  const id = String(roomId ?? '').trim()
  if (id === '') return { ok: false, error: '缺少 roomId' }
  let table = options.table
  if (table === undefined) {
    // 读不到表是**正常情况**（没配表就用内置缺省）→ 仍写一份"全默认"的快照，
    // 这样"这场会用什么"永远有据可查，而不是靠"当时表大概是什么"。
    table = loadStrategyTable(dataDir).table
  }
  const snapshot = snapshotForRoom(table, {
    roomId: id, lockedBy: options.by ?? '', at: options.at ?? Date.now(),
  })
  const written = writeRoomStrategy(dataDir, id, snapshot)
  if (written.ok !== true) {
    appendAudit(dataDir, { by: options.by ?? '', action: 'strategy.lock', roomId: id, result: 'failed', note: written.error })
    return { ok: false, error: written.error, path: written.path }
  }
  appendAudit(dataDir, {
    by: options.by ?? '', action: 'strategy.lock', roomId: id,
    result: written.existed ? 'existed' : 'ok', after: snapshot.languages,
  })
  return { ok: true, existed: written.existed, snapshot, path: written.path }
}
