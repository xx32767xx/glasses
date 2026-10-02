/**
 * loader-links.mjs —— 为 vendor/cordis 这个 loader 准备模块解析（幂等）
 * ============================================================================
 * `vendor/cordis/bin.js` 把 `baseUrl` 设成**当前工作目录**，并固定 include `./cordis.yml`。
 * 于是每一个「组合目录」（测试组合、演示组合）都要能从自己这里解析
 * `@deepseek-ai/cordis-plugin-*`。本项目是零依赖的（没有 node_modules），所以在这里
 * 用 junction 把检出的 vendor 包挂进目标目录。
 *
 * junction 只建在工作区内的 node_modules/ 下，而它已在 .gitignore 里。
 * 检出里那些 packages/** 的 dsh 包不走这里：它们在 cordis.yml 里用 file:// 绝对 URL 引用。
 */

import { mkdirSync, symlinkSync, existsSync, rmSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { CHECKOUT } from './real-tools.mjs'

/** vendor 目录名 → 包名（两者并不总是一致，比如 hmr / include）。 */
export const LINKS = {
  'cordis': 'cordis',
  'cosmokit': 'cosmokit',
  'group': 'cordis-plugin-group',
  'hmr': 'cordis-plugin-hmr',
  'include': 'cordis-plugin-include',
  'loader': 'cordis-plugin-loader',
  'logger-console': 'cordis-plugin-logger-console',
  'schemastery': 'schemastery',
  'timer': 'cordis-plugin-timer',
}

/**
 * 在 `dir/node_modules/@deepseek-ai/` 下建立（或修复）junction。
 * @returns { created: number, skipped: string[] }
 */
export function ensureLoaderLinks(dir) {
  const scope = join(dir, 'node_modules', '@deepseek-ai')
  mkdirSync(scope, { recursive: true })

  let created = 0
  const skipped = []
  for (const [vendorDir, pkg] of Object.entries(LINKS)) {
    const target = join(CHECKOUT, 'vendor', vendorDir)
    if (!existsSync(target)) {
      skipped.push(pkg)
      continue
    }
    const link = join(scope, pkg)
    if (lstatSync(link, { throwIfNoEntry: false }) !== undefined) {
      rmSync(link, { recursive: true, force: true })
    }
    symlinkSync(target, link, 'junction')
    created += 1
  }
  return { created, skipped }
}

/** 把绝对 Windows 路径变成 file:// URL —— loader 走 ESM 动态 import，绝对路径必须是 URL。 */
export function fileUrl(absolutePath) {
  return 'file:///' + absolutePath.replace(/\\/g, '/')
}
