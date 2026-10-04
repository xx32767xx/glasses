/**
 * run.mjs —— 一键跑真实 Cordis 组合验证
 * ============================================================================
 *   node tests/live/run.mjs
 *
 * 会用检出里真实的 dsh-tools / dsh-system-prompt 组合一个真实 Cordis 应用，把
 * plugin/index.mjs 装进去，然后由 tests/live/probe.mjs 断言：
 *   · 7 个工具出现在真实 ToolRuntime 的模型可见 schema 里；
 *   · 通过真实执行流水线调用 leion_selftest / 双向 leion_translate / leion_display；
 *   · 缺必填参数的调用被真实流水线拒绝；
 *   · 桥写行 → 收件箱 → 真实 timer → 真实流水线 → 字幕，端到端。
 *
 * ⚠️ 组合目录建在**系统临时区，不在仓库里**。
 *    它需要在 node_modules 下建若干指回检出 vendor 的 junction，而那些 vendor 包之间
 *    又互相链接 —— 放进仓库就形成符号链接环：git 递归时撞"路径过长"（`git status
 *    --ignored` 会刷几百行警告），而 `git clean -xdf` 有顺着链接删到检出文件的风险。
 *    组合目录里只有 cordis.yml 和这些 junction；验证代码仍在本目录。
 *
 * 为什么用 spawn 且 stdio: 'inherit'：受限沙箱下捕获子进程管道输出会 EPERM，
 * 而 inherit 不受影响；子进程的输出直接进终端，退出码用来判定成败。
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CHECKOUT } from '../../lib/real-tools.mjs'
import { ensureLoaderLinks } from '../../lib/loader-links.mjs'
import { buildLiveComposition } from './composition.mjs'

/** 本目录（组合模板与探针所在处，留在仓库里）。 */
export const LIVE_DIR = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]$/, '')

/**
 * 建一个临时组合目录，并把 cordis.yml **现场生成**进去。
 * 为什么是生成而不是拷贝一个仓库里的文件：那个文件得写死本仓库与 DSH 检出的绝对路径，
 * 换个盘或挪一下检出就崩，而且报错指向不了真正的原因（见 composition.mjs 的说明）。
 * 组合里的路径都是绝对 file:// URL，所以放进临时目录也照样解析得对。
 */
export function makeComposeDir() {
  const dir = mkdtempSync(join(tmpdir(), 'leion-live-'))
  writeFileSync(join(dir, 'cordis.yml'), buildLiveComposition(), 'utf-8')
  return dir
}

/**
 * 跑一次真实组合验证。
 * @returns 子进程退出码（0 = 通过）
 */
export function runLive() {
  const composeDir = makeComposeDir()
  const { created, skipped } = ensureLoaderLinks(composeDir)
  if (skipped.length > 0) {
    console.error(`[live] 检出里缺少这些 vendor 包，跳过：${skipped.join(', ')}`)
    return Promise.resolve(1)
  }
  console.log(`[live] 组合目录建在系统临时区（不进仓库）：${composeDir}`)
  console.log(`[live] 组合文件：${join(composeDir, 'cordis.yml')}（想手动跑就 cd 进去执行 vendor/cordis/bin.js）`)
  if (created > 0) console.log(`[live] 已建立 ${created} 个 vendor junction`)

  const bin = join(CHECKOUT, 'vendor', 'cordis', 'bin.js')
  return new Promise(resolve => {
    const child = spawn(process.execPath, [bin], { cwd: composeDir, stdio: 'inherit' })
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
