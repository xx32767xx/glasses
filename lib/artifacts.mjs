/**
 * artifacts.mjs —— 产物生成（纯函数形式，供 CLI 与测试共用）
 * ============================================================================
 * 从两个"唯一来源"派生全部生成物：
 *
 *   plugin/core.mjs        业务逻辑  →  plugin/schemas.generated.mjs（预编译 schema）
 *                                   →  dynamic/leion-pro.host.js（内联 core + 沙箱适配器）
 *   policy/br-pt.json      巴葡策略  →  plugin/policy.generated.mjs（正式包 import 它）
 *                                   →  dynamic/…（内联成常量）
 *                                   →  skills/leion-interpreter/SKILL.md（生成术语表那一节）
 *
 * 为什么编译 schema：正式插件走 ctx.tools.register() 需要**原始** JSON Schema，而
 * author-facing 的 DSL 不给它；派生而不是手抄，所以两个包装目标不可能漂移。
 *
 * 为什么策略也要派生：巴葡口径（"不是葡葡"）是本项目最大的质量资产。以前它在插件里是
 * 5 句原则、在技能文档里是一张术语表 —— 两处会漂移，而且技能文档那张表还写坏过两行。
 * 现在术语表、口语特征、字幕纪律全部从 policy/br-pt.json 生成。
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
const POLICY_JSON = join(ROOT, 'policy', 'br-pt.json')
const SKILL = join(ROOT, 'skills', 'leion-interpreter', 'SKILL.md')

/** SKILL.md 里那段由策略数据生成的内容，用成对标记 delimiting。 */
export const POLICY_MARKER_BEGIN = '<!-- BEGIN GENERATED br-pt-policy'
export const POLICY_MARKER_END = '<!-- END GENERATED br-pt-policy -->'

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

/** 读出巴葡策略（唯一来源）。 */
export function readPolicy() {
  return JSON.parse(readFileSync(POLICY_JSON, 'utf-8'))
}

/** 把策略渲染成 SKILL.md 里那一节 Markdown。 */
function renderPolicySection(policy) {
  return [
    `用户要的是 **${policy.variety.name}（${policy.variety.code}）**，不是葡萄牙本土葡语。`
    + `这是评分点，不是风格偏好。以下是必须遵守的差异：`,
    '',
    '| 中文 | 巴葡 ✅ | 葡葡 ❌ |',
    '|---|---|---|',
    ...policy.terminology.map(entry => `| ${entry.zh} | ${entry.br} | ${entry.ptpt} |`),
    '',
    '巴葡口语特征：',
    ...policy.speakingFeatures.map(feature => '- ' + feature),
    '',
    '## 字幕长度纪律（AR 显示区只有 40 列 × 3 行）',
    '',
    ...policy.subtitleDiscipline.map(item => '- ' + item),
  ].join('\n')
}

/** 只替换标记之间的内容，两侧的手写散文原样保留。 */
export function applyPolicySection(existing, policy) {
  const begin = existing.indexOf(POLICY_MARKER_BEGIN)
  const end = existing.indexOf(POLICY_MARKER_END)
  if (begin < 0 || end < 0 || end < begin) {
    throw new Error(`在 SKILL.md 里找不到策略生成区标记：\n  ${POLICY_MARKER_BEGIN} …\n  ${POLICY_MARKER_END}\n`
      + '这两个标记必须成对出现，否则生成器拒绝改写（宁可报错也不猜）。')
  }
  // 保留 BEGIN **整行**（含结尾的 ` -->`）—— 只保留标记前缀会把 HTML 注释尾巴切掉，
  // 于是整节在 Markdown 里变成一段没闭合的注释。
  const beginLineEnd = existing.indexOf('\n', begin)
  if (beginLineEnd < 0) throw new Error('BEGIN 标记那一行没有换行，文件可能被破坏')
  const head = existing.slice(0, beginLineEnd)
  const tail = existing.slice(end)
  return head + '\n' + renderPolicySection(policy) + '\n' + tail
}

/**
 * 构建全部产物的内容。
 * @returns [{ path, label, content }]
 */
export async function buildArtifacts() {
  const core = await import(pathToFileURL(CORE).href)
  const policy = readPolicy()

  // 用一个没有服务的假 ctx 建解释器：构建工具规格不碰 ctx，只有 execute 才会。
  const rt = core.createInterpreter({ get: () => undefined }, core.CONFIG_DEFAULTS, { policy })
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

  const policyLiteral = JSON.stringify(policy, null, 2)

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

  const policySource = `/**
 * 自动生成 —— 请勿手改。
 * ============================================================================
 * 来源：policy/br-pt.json（巴葡策略的唯一来源）。
 * 用途：正式插件（plugin/index.mjs）把它作为 deps.policy 传给 createInterpreter，
 *       由 translationSystem() 生成提示词。
 * 重新生成：node scripts/generate.mjs
 * 新鲜度门禁：tests/run-all.mjs
 */

export const POLICY = ${policyLiteral}
`

  const coreInlined = inlineModule(readFileSync(CORE, 'utf-8'), relative(ROOT, CORE))

  const dynamicSource = `/**
 * leion-pro —— 亮亮视野 (LLVision) Leion Pro / GLXSS ME AR 眼镜 · Cordis 动态插件 Host 半
 * ⚠️ 本文件由 scripts/generate.mjs 从 plugin/core.mjs 与 policy/br-pt.json 生成，
 *    **请勿手改**。改逻辑 → plugin/core.mjs；改巴葡口径 → policy/br-pt.json；
 *    然后 node scripts/generate.mjs
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
 * 下面是 policy/br-pt.json 的内联内容（巴葡策略唯一来源）
 * ============================================================================
 */

const POLICY = ${policyLiteral}

// ============================================================================
// 下面是 plugin/core.mjs 的内联内容（业务逻辑唯一来源）
// ============================================================================

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
    const rt = createInterpreter(
      ctx,
      Object.assign({}, CONFIG_DEFAULTS, CONFIG_OVERRIDE),
      { policy: POLICY },
    )
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

  const skillSource = applyPolicySection(readFileSync(SKILL, 'utf-8'), policy)

  return [
    { path: join(ROOT, 'plugin', 'schemas.generated.mjs'), label: 'plugin/schemas.generated.mjs', content: schemasSource },
    { path: join(ROOT, 'plugin', 'policy.generated.mjs'), label: 'plugin/policy.generated.mjs', content: policySource },
    { path: join(ROOT, 'dynamic', 'leion-pro.host.js'), label: 'dynamic/leion-pro.host.js', content: dynamicSource },
    { path: join(ROOT, 'skills', 'leion-interpreter', 'SKILL.md'), label: 'skills/leion-interpreter/SKILL.md', content: skillSource },
  ]
}
