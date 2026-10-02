/**
 * links.mjs —— 为 tests/live 这个组合目录准备模块解析
 * ============================================================================
 * 真正的实现搬到了 lib/loader-links.mjs（演示组合也要用同一套），这里只固定目录。
 */

import { fileURLToPath } from 'node:url'
import { ensureLoaderLinks } from '../../lib/loader-links.mjs'

export const LIVE_DIR = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]$/, '')

/** @returns { created: number, skipped: string[] } */
export function ensureLinks() {
  return ensureLoaderLinks(LIVE_DIR)
}
