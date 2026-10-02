/**
 * artifacts.mjs —— 产物生成（纯函数形式，供 CLI 与测试共用）
 * ============================================================================
 * 从唯一逻辑源 plugin/core.mjs 派生两个产物：
 *
 *   1. plugin/schemas.generated.mjs
 *      core.mjs 里的 author-facing value schema DSL，经**真实** defineTool 编译成原始
 *      JSON Schema，供正式插件走 ctx.tools.register()。派生而不是手抄，所以两个包装
 *      目标不可能出现 schema 漂移。
 *
 *   2. dynamic/leion-pro.host.js
 *      把 core.mjs 的源码内联（去掉 export 前缀——沙箱里没有模块系统），接上动态插件
 *      沙箱适配器。于是「动态插件」是一个可直接粘贴给 cordis_define 的独立文件，
 *      而业务逻辑仍然只有一份。
 *
 * CLI 包装见 scripts/generate.mjs；新鲜度门禁由 tests/run-all.mjs 调用本模块完成
 * （刻意不 spawn 子进程：受限沙箱下捕获子进程管道输出会 EPERM）。
 */

import { readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { defineTool } from './real-tools.mjs'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CORE = join(ROOT, 'plugin', 'core.mjs')

/** 去掉顶层 `export ` 前缀，让模块源码能作为一段函数体存在。 */
function inlineModule(source, file) {
  const lines = source.split('\n')
  const unsupported = lines.filter(l => /^export\s+(default|\{|function\s*\*|class)/.test(l))
  if (unsupported.length > 0) {
    throw new Error(
      `${file} 里出现了生成器不支持的导出形式，无法内联到动态插件：\n  ${unsupported.join('\n  ')}\n`
      + '请只使用 `export const` / `export function` 两种形式。',
    )
  }
  return lines.map(l => l.replace(/^export /, '')).join('\n')
}

/**
 * 构建两个产物的内容。
 * @returns [{ path, label, content }]
 */
export async function buildArtifacts() {
  const core = await import(pathToFileURL(CORE).href)

  // 用一个没有服务的假 ctx 建解释器：构建工具规格不碰 ctx，只有 execute 才会。
  const rt = core.createInterpreter({ get: () => undefined }, core.CONFIG_DEFAULTS)
  const specs = core.buildToolSpecs(rt)

  const compiled = {}
  for (const spec of specs) {
    // 走真实 defineTool：schema 不合法就在这里炸，而不是等到创造模式会话里才炸。
    const tool = defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: { schema: spec.outputSchemaDsl, render: spec.render },
      async execute() { return {} },
    })
    compiled[spec.name] = {
      description: tool.description,
      parameters: tool.parameters,
      outputSchema: tool.output.schema,
    }
  }

  const schemasSource = `/**
 * 自动生成 —— 请勿手改。
 * ============================================================================
 * 来源：plugin/core.mjs 里的 author-facing value schema DSL，
 *       经检出里真实的 @deepseek-ai/dsh-tools defineTool 编译后的原始形式。
 * 用途：正式插件（plugin/index.mjs）走 ctx.tools.register() 时需要的原始 JSON Schema。
 * 重新生成：node scripts/generate.mjs
 * 新鲜度门禁：tests/run-all.mjs
 */

export const TOOL_SCHEMAS = ${JSON.stringify(compiled, null, 2)}
`

  const coreInlined = inlineModule(readFileSync(CORE, 'utf-8'), relative(ROOT, CORE))

  const dynamicSource = `/**
 * leion-pro —— 亮亮视野 (LLVision) Leion Pro / GLXSS ME AR 眼镜 · Cordis 动态插件 Host 半
 * ⚠️ 本文件由 scripts/generate.mjs 从 plugin/core.mjs 生成，**请勿手改**。
 *    改逻辑 → 改 plugin/core.mjs → node scripts/generate.mjs
 * ============================================================================
 *
 * 这是什么
 *   把「一台亮亮眼镜」做成 harness 认识的一个设备：注册一组模型工具，让 agent 可以把
 *   字幕推到眼镜上；并内置中↔巴西葡语双向翻译管线，让这套东西成为一个同传 app。
 *
 * 怎么用
 *   在 Web GUI 新建一个「创造模式」会话，把本文件的全部内容作为 \`code.host\` 传给
 *   cordis_define，再 cordis_run。详见 docs/02-创造模式加载指南.md。
 *
 * 沙箱约束（动态插件，不是普通源码插件）
 *   - 代码是 async 函数体，必须 \`return\` 一个插件对象；
 *   - 纯 JavaScript，不能写 TypeScript 类型标注；
 *   - 没有 require / fetch / setTimeout / process / Buffer；
 *   - 可用全局只有：ctx（受限）、harness、console、btoa/atob/TextEncoder/TextDecoder；
 *   - 外部能力一律走 Cordis 服务：ctx.get('llm') / ctx.get('fs') ...
 *
 * 下面是 plugin/core.mjs 的内联内容（业务逻辑唯一来源）
 * ============================================================================
 */

${coreInlined}

// ─────────────────────────────────────────────────────────────────────────────
// 动态插件沙箱适配器（由 scripts/generate.mjs 生成）
// ─────────────────────────────────────────────────────────────────────────────

// 动态包没有 config 通道：要改配置就改上面的 CONFIG_DEFAULTS，或改这里的覆盖对象，
// 然后重新 cordis_define。正式插件版本则通过 cordis.yml 的 config 传同样的字段。
const CONFIG_OVERRIDE = {}

return {
  name: 'leion-pro',
  inject: ['tools', 'timer'],

  apply(ctx) {
    const rt = createInterpreter(ctx, Object.assign({}, CONFIG_DEFAULTS, CONFIG_OVERRIDE))
    for (const spec of buildToolSpecs(rt)) {
      harness.registerTool(ctx, harness.defineTool({
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        output: { schema: spec.outputSchemaDsl, render: spec.render },
        execute: spec.execute,
      }))
    }
    console.log(loadedMessage(rt))
  },
}
`

  return [
    { path: join(ROOT, 'plugin', 'schemas.generated.mjs'), label: 'plugin/schemas.generated.mjs', content: schemasSource },
    { path: join(ROOT, 'dynamic', 'leion-pro.host.js'), label: 'dynamic/leion-pro.host.js', content: dynamicSource },
  ]
}
