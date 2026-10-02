/**
 * host-adapters.mjs —— 把两个包装目标统一成同一个 `create({ llm, fs, config })` 接口
 * ============================================================================
 * 契约套件（contract-suite.mjs）对两者跑完全相同的断言，这样"两个版本行为一致"
 * 是被持续验证的事实，而不是靠人记得同步两份代码。
 *
 *   dynamicAdapter —— 创造模式动态插件：源码是 async 函数体，在 node:vm 沙箱里求值。
 *   formalAdapter  —— 正式插件：ESM 模块，走 ctx.tools.register()。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadHostHalf } from './fake-sandbox.mjs'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '../lib/real-tools.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const DYNAMIC_PATH = join(ROOT, 'dynamic', 'leion-pro.host.js')
export const FORMAL_PATH = join(ROOT, 'plugin', 'index.mjs')

/** 组装 ctx.get() 能拿到的服务表。 */
function services({ llm, fs }) {
  const table = {}
  if (llm !== undefined) table.llm = llm
  if (fs !== undefined) table.fs = fs
  return table
}

// ─────────────────────────────────────────────────────────────────────────────
// 动态插件
// ─────────────────────────────────────────────────────────────────────────────

export function dynamicAdapter() {
  const code = readFileSync(DYNAMIC_PATH, 'utf-8')
  return {
    label: '动态插件（创造模式沙箱）',
    file: 'dynamic/leion-pro.host.js',
    /** 动态包没有 config 通道，配置只能通过产物里的 CONFIG_OVERRIDE 注入点进去。 */
    configChannel: 'source',
    async create({ llm, fs, config }) {
      let source = code
      if (config !== undefined) {
        const before = source
        source = source.replace(
          'const CONFIG_OVERRIDE = {}',
          `const CONFIG_OVERRIDE = ${JSON.stringify(config)}`,
        )
        if (source === before) {
          throw new Error('动态产物里找不到 CONFIG_OVERRIDE 注入点，scripts/generate.mjs 的结构可能变了')
        }
      }
      const box = await loadHostHalf(source, services({ llm, fs }))
      await box.start()
      return box
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 正式插件
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 复刻真实 ToolRuntime.register() 接受的检查，外加 parameters 的 schema 检查
 * （真实 register 只查 output.schema，但 parameters 会流向系统提示词，所以也应当合法）。
 * 参考 packages/core/tools/src/index.ts 的 register()。
 */
function makeToolsService({ registered, log }) {
  return {
    register(definition) {
      const name = definition.name
      if (typeof name !== 'string' || name === '') throw new TypeError('tool must declare a name')
      if (typeof definition.description !== 'string' || definition.description === '') {
        throw new TypeError(`tool "${name}" must declare a description`)
      }
      const output = definition.output
      if (output === undefined || typeof output !== 'object' || typeof output.render !== 'function') {
        throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`)
      }
      assertSupportedJsonSchema(output.schema)
      assertSupportedJsonSchema(definition.parameters)
      if (name === 'run_code') throw new Error('tool name "run_code" is reserved')
      if (registered.has(name)) throw new Error(`duplicate tool name ${name}`)
      if (typeof definition.execute !== 'function') throw new TypeError(`tool "${name}" must declare execute`)

      registered.set(name, {
        name,
        description: definition.description,
        parameters: definition.parameters,
        outputSchema: output.schema,
        // 复刻真实执行路径：先按 parameters 校验参数，再按 output.schema 校验返回值。
        async execute(args, exec) {
          const argViolations = validateJsonSchemaValue(definition.parameters, args ?? {}, '')
          if (argViolations.length > 0) {
            const error = new Error(`invalid arguments: ${argViolations.join('; ')}`)
            error.name = 'ToolArgsError'
            throw error
          }
          const value = await definition.execute(args ?? {}, exec)
          const outViolations = validateJsonSchemaValue(output.schema, value, '')
          if (outViolations.length > 0) {
            const error = new Error(`invalid result: ${outViolations.join('; ')}`)
            error.name = 'ToolOutputError'
            throw error
          }
          return JSON.parse(JSON.stringify(value === undefined ? null : value))
        },
        render(args, value) {
          const blocks = output.render(args, value)
          if (!Array.isArray(blocks) || !blocks.every(b => typeof b === 'object' && b !== null && typeof b.type === 'string')) {
            throw new Error(`tool "${name}" output.render must return an ARRAY of content blocks`)
          }
          return JSON.parse(JSON.stringify(blocks))
        },
      })
      return () => registered.delete(name)
    },
  }
}

export function formalAdapter() {
  let instance = 0
  return {
    label: '正式插件（ctx.tools.register 路径）',
    file: 'plugin/index.mjs',
    /** 正式插件有 config 通道：cordis.yml 里那一行的 config 直接作为 apply 的第二个参数。 */
    configChannel: 'apply',
    async create({ llm, fs, config }) {
      instance += 1
      // 带查询串 import 以获得新实例：同一个模块 URL 会被缓存，而每个测试场景需要独立状态。
      const moduleUrl = pathToFileURL(FORMAL_PATH).href + `?instance=${instance}`
      const mod = await import(moduleUrl)

      const log = []
      const registered = new Map()
      const table = services({ llm, fs })
      const ctx = {
        get: name => table[name],
        tools: makeToolsService({ registered, log }),
        // 复刻真实 Cordis 的 timer 混入（vendor/timer 的 ctx.interval/ctx.timeout 都返回 disposer）
        on: () => () => {},
        once: () => () => {},
        effect: (callback) => { callback(); return () => {} },
        // unref：测试里这些 interval 不该让 Node 进程一直活着（真实 Cordis 会随 fiber 释放）。
        interval: (fn, ms) => { const id = setInterval(fn, ms); id.unref?.(); return () => clearInterval(id) },
        timeout: (fn, ms) => { const id = setTimeout(fn, ms); return () => clearTimeout(id) },
      }

      const originalLog = console.log
      console.log = (...args) => log.push(['log', args.map(String).join(' ')])
      try {
        await mod.apply(ctx, config)
      } finally {
        console.log = originalLog
      }

      return {
        plugin: mod,
        ctx,
        tools: registered,
        log,
        effects: [],
        handles: new Map(),
        async start() {
          return [...registered.keys()]
        },
      }
    },
  }
}
