/**
 * fake-fs.mjs —— 给真实组合提供一个基于真实文件系统的 fs 服务
 * ============================================================================
 * 收件箱要真的读写文件，而最小组合里没有 fs 服务。这里用 node:fs 提供它。
 * 本文件运行在真实 Cordis 进程里（不是沙箱），所以直接用 node API 是合适的。
 *
 * 注意：它按绝对路径原样使用传入的 path，不做路径收敛——这只是验证用的最小实现。
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const name = 'leion-live-fake-fs'

export function apply(ctx) {
  ctx.provide('fs', {
    async resolve(path) {
      return { path }
    },
    async stat(target) {
      try {
        const info = await stat(target.path)
        return { kind: info.isDirectory() ? 'directory' : 'file', size: info.size }
      } catch {
        return undefined
      }
    },
    async readText(target) {
      return await readFile(target.path, 'utf-8')
    },
    async writeText(target, content) {
      await mkdir(dirname(target.path), { recursive: true })
      await writeFile(target.path, content, 'utf-8')
      return { version: 'v1' }
    },
  })
}
