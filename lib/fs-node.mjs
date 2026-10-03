/**
 * fs-node.mjs —— 基于真实 node:fs 的 fs 服务
 * ============================================================================
 * 最小 Cordis 组合里没有文件系统服务，而 ASR 收件箱与字幕总线要真的读写文件。
 * 本文件运行在真实 Cordis 进程里（不是沙箱），所以直接用 node API 是合适的。
 *
 * 它只需要实现收件箱/字幕总线用到的四个方法：resolve / stat / readText / writeText。
 * 注意：按绝对路径原样使用传入的 path，不做路径收敛 —— 这是验证用的最小实现，
 * 不是通用文件系统；真要用在生产里应当换成 dsh-fs-sandbox。
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const name = 'leion-node-fs'

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
