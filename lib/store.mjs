/**
 * store.mjs —— 生产库 / 测试库两套数据的隔离与通用存储原语
 * ============================================================================
 *
 * 规矩来自用户（2026-10-23）：**生产与测试要两套数据库，不能混**。
 * 混的后果很具体：联调时用 dev 账号往生产库里写几条试验条目，
 * 那几条会进真实会议的术语快照 —— 而且**从界面上看不出来**（都是合法的表项）。
 *
 * 隔离怎么保证（三层，缺一层都不算做到）：
 *   ① 目录不同：生产 `<base>/live`、测试 `<base>/live-test`，永不重叠；
 *   ② 入口唯一：所有读写都先过 `resolveDataDir(base, env)`，不允许调用方自己拼路径；
 *   ③ 断言兜底：`assertEnvMatches(dir, env)` —— 拿测试目录干生产的活（或反过来）直接抛，
 *      而不是"悄悄地测了一遍生产数据"。
 *
 * 为什么断言要双向查（而不是只查一边）：
 *   · 只在"生产不许用 test 目录"这一条上查，会漏掉"测试用了生产目录"这种更危险的方向；
 *   · 反过来只查测试侧，则会漏掉把 dev 数据当生产跑。
 */

import { mkdir, readFile, rename, writeFile, appendFile } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'

/** 两个环境。**没有第三个** —— 出现第三个就说明有人想给"灰度"开后门，先谈清楚再说。 */
export const ENVS = ['prod', 'test']

/** 环境 → 目录名。生产沿用 `live`（与现有 `var/live` 一致，不打断既有约定）。 */
export const ENV_DIRS = { prod: 'live', test: 'live-test' }

/**
 * 把 (基准目录, 环境) 解析成数据目录。
 * @param {string} base 例如 `var`
 * @param {'prod'|'test'} env
 */
export function resolveDataDir(base, env = 'prod') {
  if (ENVS.includes(env) !== true) {
    throw new Error(`环境只能是 ${ENVS.join(' / ')}，收到 ${JSON.stringify(env)}`)
  }
  return join(base, ENV_DIRS[env])
}

/** 从目录名反推环境（没有匹配就返回 null，交给调用方明确报错）。 */
export function envOf(dir) {
  const tail = String(dir).split(sep).filter(Boolean).pop() ?? ''
  const found = ENVS.find((name) => ENV_DIRS[name] === tail)
  return found ?? null
}

/**
 * 断言目录与环境相符。
 *
 * 为什么值得单独一个函数：`resolveDataDir` 只能保证"我们生成的路径是对的"，
 * 挡不住"调用方自己传了个别的目录进来"。这一步是最后一道闸。
 */
export function assertEnvMatches(dir, env) {
  const actual = envOf(dir)
  if (actual === null) {
    throw new Error(`目录 ${dir} 不像 ${ENVS.join(' / ')} 里的任何一个，拒绝按「${env}」使用`)
  }
  if (actual !== env) {
    throw new Error(`环境不匹配：拿到 ${actual} 的目录（${dir}），却要按 ${env} 用`)
  }
  return true
}

/** 读 JSON；不存在或坏掉都返回 fallback（**不抛**：坏文件不该让服务起不来）。 */
export async function readJson(path, fallback) {
  let text
  try {
    text = await readFile(path, 'utf-8')
  } catch {
    return fallback
  }
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/** 原子写（tmp + rename）：读方要么看到旧文件、要么看到新文件，不会读到半截。 */
export async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', 'utf-8')
  await rename(temp, path)
  return path
}

/** 追加一行 JSON（审计日志用：只追加不改写，断电最多丢最后一行）。 */
export async function appendJsonl(path, record) {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, JSON.stringify(record) + '\n', 'utf-8')
  return path
}

/** 读整份 JSONL。坏行**跳过并计数**，而不是整份丢弃 —— 审计日志宁可少一行也不能全没了。 */
export async function readJsonl(path) {
  let text
  try {
    text = await readFile(path, 'utf-8')
  } catch {
    return { records: [], badLines: 0 }
  }
  const records = []
  let badLines = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      records.push(JSON.parse(trimmed))
    } catch {
      badLines += 1
    }
  }
  return { records, badLines }
}

/** 生成一个可读 id（`lib-20261023-a1b2c3`）：人眼能看出类型与日期，也便于排序。 */
export function newId(prefix, now = new Date()) {
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, '')
  const random = Math.random().toString(36).slice(2, 8)
  return `${prefix}-${stamp}-${random}`
}
