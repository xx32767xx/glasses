/**
 * run.mjs —— 一键跑真实 Cordis 组合验证
 * ============================================================================
 *   node tests/live/run.mjs
 *
 * 会用检出里真实的 dsh-tools / dsh-system-prompt 组合一个真实 Cordis 应用，把
 * plugin/index.mjs 装进去，然后由 tests/live/probe.mjs 断言：
 *   · 6 个工具出现在真实 ToolRuntime 的模型可见 schema 里；
 *   · 通过真实执行流水线调用 leion_selftest / leion_display 成功，render 生效；
 *   · 缺必填参数的调用被真实流水线拒绝。
 *
 * 为什么用 spawn 且 stdio: 'inherit'：受限沙箱下捕获子进程管道输出会 EPERM，
 * 而 inherit 不受影响；子进程的输出直接进终端，退出码用来判定成败。
 */

import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CHECKOUT } from '../../lib/real-tools.mjs'
import { ensureLinks, LIVE_DIR } from './links.mjs'

/**
 * 跑一次真实组合验证。
 * @returns 子进程退出码（0 = 通过）
 */
export function runLive() {
  const { created, skipped } = ensureLinks()
  if (skipped.length > 0) {
    console.error(`[live] 检出里缺少这些 vendor 包，跳过：${skipped.join(', ')}`)
    return Promise.resolve(1)
  }
  if (created > 0) console.log(`[live] 已建立 ${created} 个 vendor junction`)

  const bin = join(CHECKOUT, 'vendor', 'cordis', 'bin.js')
  return new Promise(resolve => {
    const child = spawn(process.execPath, [bin], { cwd: LIVE_DIR, stdio: 'inherit' })
    child.on('exit', code => resolve(code === null ? 1 : code))
    child.on('error', error => {
      console.error('[live] 无法启动 loader：' + String(error && error.message ? error.message : error))
      resolve(1)
    })
  })
}

// 作为 CLI 直接运行
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await runLive())
}
