/**
 * run-all.mjs —— 全量验证入口
 * ============================================================================
 *   node tests/run-all.mjs
 *
 * 它做四件事：
 *   1. 新鲜度门禁：两个生成产物必须与 lib/artifacts.mjs 的输出逐字节一致；
 *   2. 对**动态插件**跑一遍契约套件（node:vm 沙箱 + 真实 defineTool 校验）；
 *   3. 对**正式插件**跑同一套契约（复刻 ToolRuntime.register 的检查 + 真实 schema 校验）；
 *   4. 逐字段对比两个版本的 fingerprint、schema、render 输出 —— "两份包装行为一致"
 *      因此是被持续验证的事实，而不是靠人记得同步代码。
 *
 * 全部断言都建立在检出里**真实的** @deepseek-ai/dsh-tools 构建产物之上（见 lib/real-tools.mjs）。
 */

import { readFileSync, existsSync } from 'node:fs'
import assert from 'node:assert/strict'
import { buildArtifacts } from '../lib/artifacts.mjs'
import { check, loadHostHalf } from './fake-sandbox.mjs'
import { dynamicAdapter, formalAdapter, FORMAL_PATH } from './host-adapters.mjs'
import { runContractSuite, makeFakeLlm, makeFakeFs, SAMPLE_ARGS } from './contract-suite.mjs'
import { runBridgeSuite } from './bridge-suite.mjs'
import { runRelaySuite } from './relay-suite.mjs'
import { runLive } from './live/run.mjs'

let passed = 0
const failures = []
let section = ''

async function it(label, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✅ ${label}`)
  } catch (error) {
    failures.push({ section, label, error })
    console.log(`  ❌ ${label}\n     ${String(error && error.message ? error.message : error).split('\n').join('\n     ')}`)
  }
}

function heading(text) {
  section = text
  console.log('\n' + text)
}

const helpers = { it, check, assert }

// mock 传输通道会把每一帧字幕打到 host 日志（正式路径用真 console.log）。
// 收起来统一汇报，别让 20 行设备日志淹掉测试报告。
const deviceLog = []
const realLog = console.log
console.log = (...args) => {
  const line = args.map(String).join(' ')
  if (line.startsWith('[leion-pro] ') && /⏎|→/.test(line)) deviceLog.push(line)
  else realLog(...args)
}

console.log('\n=== leion-pro 全量验证 ===')

// ── 0. 新鲜度门禁 ────────────────────────────────────────────────────────────

heading('产物新鲜度')
await it('两个生成产物与 lib/artifacts.mjs 的输出逐字节一致', async () => {
  const artifacts = await buildArtifacts()
  const stale = artifacts.filter(a => !existsSync(a.path) || readFileSync(a.path, 'utf-8') !== a.content)
  check(
    '产物不是最新的，跑 node scripts/generate.mjs',
    stale.length === 0,
    stale.map(a => a.label).join('、'),
  )
})

// ── 1. 动态插件契约套件 ──────────────────────────────────────────────────────

heading('契约套件 · 动态插件（创造模式沙箱）')
const dynamicFingerprint = await runContractSuite(dynamicAdapter(), helpers)

heading('动态插件专属')
await it('沙箱陷阱确实拦住了 setTimeout（说明测试台是仿真的）', async () => {
  await assert.rejects(
    () => loadHostHalf('setTimeout(() => {}, 1)\nreturn { apply() {} }', {}),
    /setTimeout is not available in the dynamic package sandbox/,
  )
})

// ── 2. 正式插件契约套件 ──────────────────────────────────────────────────────

heading('契约套件 · 正式插件（ctx.tools.register 路径）')
const formalFingerprint = await runContractSuite(formalAdapter(), helpers)

heading('正式插件专属')
await it('只提供命名导出 name / inject / apply，没有默认导出', async () => {
  const mod = await import(new URL('file:///' + FORMAL_PATH.replace(/\\/g, '/')).href + '?inspect=1')
  check('有 name', typeof mod.name === 'string' && mod.name === 'leion-pro', String(mod.name))
  check('declare 了 inject', Array.isArray(mod.inject) && mod.inject.includes('tools'), JSON.stringify(mod.inject))
  check('没有默认导出', mod.default === undefined, '导出了 default —— 会丢掉 inject（见 docs/postmortem/0001）')
})

await it('模块不需要任何 node_modules 依赖（零第三方 import）', async () => {
  const source = readFileSync(FORMAL_PATH, 'utf-8')
  const imports = [...source.matchAll(/^import\s.*?from\s+'([^']+)'/gm)].map(m => m[1])
  const external = imports.filter(spec => !spec.startsWith('./') && !spec.startsWith('../'))
  check('没有裸包名 import', external.length === 0, external.join(', '))
})

// ── 3. 两个版本的一致性 ──────────────────────────────────────────────────────

heading('两个版本的一致性')
await it('同一套场景的结果逐字段一致（fingerprint 对比）', async () => {
  assert.deepEqual(formalFingerprint, dynamicFingerprint)
})

const dynBox = await dynamicAdapter().create({ llm: makeFakeLlm(), fs: makeFakeFs(new Map()) })
const frmBox = await formalAdapter().create({ llm: makeFakeLlm(), fs: makeFakeFs(new Map()) })

await it('工具集合、描述、参数 schema、输出 schema 逐字节一致', async () => {
  assert.deepEqual([...frmBox.tools.keys()].sort(), [...dynBox.tools.keys()].sort())
  for (const [name, dynTool] of dynBox.tools) {
    const frmTool = frmBox.tools.get(name)
    check(`${name} 描述一致`, frmTool.description === dynTool.description)
    assert.deepEqual(frmTool.parameters, dynTool.parameters, `${name} 的 parameters 漂移了`)
    assert.deepEqual(frmTool.outputSchema, dynTool.outputSchema, `${name} 的 output.schema 漂移了`)
  }
})

await it('渲染结果一致（同 args/同 value 下 render 输出逐字段相同）', async () => {
  for (const [name, dynTool] of dynBox.tools) {
    const args = SAMPLE_ARGS[name]
    const value = await dynTool.execute(args)
    assert.deepEqual(frmBox.tools.get(name).render(args, value), dynTool.render(args, value), `${name} 的 render 漂移了`)
  }
})

// ── 4. ASR 桥（harness 之外的那一半） ───────────────────────────────────────

heading('ASR 桥（把语音识别结果变成收件箱里的一行一句话）')
await runBridgeSuite(helpers)

// ── 5. 局域网转发（手机 ↔ 电脑） ────────────────────────────────────────────

heading('局域网转发（手机 ↔ 电脑，跑在真实 HTTP 上）')
await runRelaySuite(helpers)

// ── 6. 真实 Cordis 组合（真实 ToolRuntime + 真实执行流水线） ─────────────────

heading('真实 Cordis 组合（真实 ToolRuntime，不是复刻的检查器）')
await it('plugin/index.mjs 装进真实组合后能被真实流水线注册与执行', async () => {
  const code = await runLive()
  check('真实组合验证的退出码为 0', code === 0, `退出码 ${code}（子进程输出见上）`)
})

// ── 结果 ─────────────────────────────────────────────────────────────────────

console.log = realLog
if (deviceLog.length > 0) {
  console.log(`\n（mock 传输通道另外输出了 ${deviceLog.length} 行字幕日志，已折叠。样例：）`)
  for (const line of deviceLog.slice(0, 3)) console.log('   ' + line)
}

console.log(`\n=== 结果：${passed} 通过 / ${failures.length} 失败 ===`)
if (failures.length > 0) {
  console.log('')
  for (const { section: where, label, error } of failures) {
    console.error(`失败 [${where}] ${label}\n${error && error.stack ? error.stack : error}\n`)
  }
}

// 确定性退出：真实组合验证会启动子进程与 timer，不能指望事件循环自然排空。
process.exit(failures.length > 0 ? 1 : 0)
