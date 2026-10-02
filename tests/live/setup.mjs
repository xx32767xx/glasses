/**
 * setup.mjs —— 只建立 junction，不跑验证
 * ============================================================================
 *   node tests/live/setup.mjs
 *
 * 一般不需要单独跑：tests/live/run.mjs 会在开跑前自动确保 junction 存在。
 */

import { ensureLinks, LIVE_DIR } from './links.mjs'

const { created, skipped } = ensureLinks()
console.log(`已建立 ${created} 个 junction（目录：${LIVE_DIR}\\node_modules\\@deepseek-ai）`)
if (skipped.length > 0) {
  console.error('检出里缺少这些 vendor 包：' + skipped.join(', '))
  process.exitCode = 1
}
