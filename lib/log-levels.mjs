/**
 * log-levels.mjs —— 日志档位的**唯一名单**（5.182b）
 * ============================================================================
 *
 * 为什么单独一个文件：档位是**四个进程**共用的概念（start-multi / relay / 切句 / 大脑），
 * 而每个进程各写一份 `['summary','detail','trace']` 就会漂 —— 5.181 给下游加了 `quiet`，
 * 却漏了 `start-multi` 自己那份校验，于是生产上 `--log-level quiet` 直接抛错、
 * systemd 反复重启（restart counter 一路涨到 7）。
 *
 * 现在：名单只在这里写一次，进程间用 import 共享；python 那侧（`whisper_stream.py`）
 * 没法 import JS，所以由测试 `tests/log-level-suite.mjs` 交叉核对两边一致。
 */

/** 从最安静到最吵。 */
export const LOG_LEVELS = Object.freeze(['quiet', 'summary', 'detail', 'trace'])

/** 缺省档位（现场盯场用；生产应当显式传 quiet）。 */
export const DEFAULT_LOG_LEVEL = 'summary'

/** 数字档位（越大越吵），用来做 `>=` 比较。 */
// `warn` 不是命令行档位，而是**某一行的级别**：quiet 档只放行这一级（报警）。
export const LOG_RANK = Object.freeze({ quiet: 0, warn: 0, summary: 1, detail: 2, trace: 3 })

/** 这个档位合不合法。 */
export function isLogLevel(value) {
  return LOG_LEVELS.includes(String(value ?? '').trim())
}

/**
 * 校验并归一化。不认识就抛错（**不静默退回缺省** —— 那会让人以为参数生效了）。
 * @returns {string} 合法档位
 */
export function assertLogLevel(value) {
  const level = String(value ?? '').trim()
  if (isLogLevel(level) !== true) {
    throw new Error(`--log-level 只能是 ${LOG_LEVELS.join(' / ')}，收到 ${JSON.stringify(value)}`)
  }
  return level
}

/** 当前档位够不够打这一级（`level` 是某一行的级别）。 */
export function levelAtLeast(current, level) {
  const now = LOG_RANK[String(current ?? DEFAULT_LOG_LEVEL)]
  const want = LOG_RANK[String(level ?? 'detail')]
  return (now === undefined ? LOG_RANK[DEFAULT_LOG_LEVEL] : now) >= (want === undefined ? LOG_RANK.detail : want)
}
