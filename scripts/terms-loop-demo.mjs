#!/usr/bin/env node
/**
 * terms-loop-demo.mjs —— 验证「库 → 快照 → 插件 → 字幕」这条闭环真的通了
 * ============================================================================
 *
 * 为什么需要这个脚本：
 *   建库、审批、出快照都能各自跑通，**但"库里批的那条术语会不会真的影响字幕"
 *   只有把中间两段接起来才看得出来**。而这一步最容易出现"看起来都对、其实没接上"
 *   （典型症状：表读成了空表，字幕照常出、一个错都不报）。
 *
 * 这个脚本不做仿真推理，只做三件可以核对的事：
 *   ① 从库生成会议快照（真实文件，落在 deliveries 指定的目录）
 *   ② 用**插件自己的纯函数**去消费这份快照：
 *        · normalizeTerms —— 译文里的变体是否被改成规范写法
 *        · translationSystem —— 追加的"本句专名提示"里是否出现了这条术语
 *   ③ 打印真实链路该用的命令（harness-side 的两个路径参数），可以照着跑一场真会话
 *
 * 用法：
 *   node scripts/terms-loop-demo.mjs --env test --libraries lib-a,lib-b
 *   node scripts/terms-loop-demo.mjs --env test --meeting room-001 --libraries <全部>
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ROOT } from '../lib/paths.mjs'
import { resolveDataDir, ENVS } from '../lib/store.mjs'
import { listLibraries, loadLibrary, saveLibrary } from '../lib/libraries.mjs'
import { writeMeetingSnapshot, snapshotUserKey } from '../lib/snapshot.mjs'
import { normalizeTerms, translationSystem, ZH, PT } from '../plugin/core.mjs'

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token.startsWith('--') !== true) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      options[key] = true
      continue
    }
    options[key] = next
    index += 1
  }
  return options
}

const VAR_BASE = join(ROOT, 'var')

/** 演示专用库的固定 id：重复运行不会造出第二个。 */
const DEMO_LIB_ID = 'lib-demo-loop'

/**
 * 确保"演示库"存在。
 *
 * 为什么要造一个库：闭环要能看见**变体被改成规范写法**（`Liangliang Ótica → Leion`），
 * 而现成的库里未必有带 variants 的条目。凭空造一条只存在于内存里的"假条目"会削弱结论，
 * 所以这里走真实的建库路径（`saveLibrary`），并且**明确打印**"我造了这个库"。
 * 生产环境默认不造（加 --allow-prod-seed 才造），避免往生产库里塞演示数据。
 */
async function ensureDemoLibrary(root, allowSeed) {
  const desired = {
    id: DEMO_LIB_ID,
    name: '闭环演示库',
    categoryId: null,
    priority: 100, // 最高优先级：保证它在冲突里胜出，演示结果不受别的库影响
    entries: [
      // 字段语义（docs/15 §4.2 + lib/terms-matcher.mjs 的索引构造）：
      //   variants = **中文侧**的变体（中文文本里会把它们改成规范中文）
      //   approved = **葡语侧**的可接受写法（葡语文本里会把它们收敛成规范葡语）
      // 把葡语变体写进 variants 是不会生效的 —— 这里踩过一次，注释留下防复发。
      {
        zh: '亮亮眼镜', pt: 'Leion',
        variants: ['亮亮眼睛'],
        approved: ['Liangliang Ótica', 'Liangliang Glasses'],
      },
      { zh: '高通', pt: 'Qualcomm', approved: ['Qualcomm Inc'] },
    ],
  }
  const existing = await loadLibrary(root, DEMO_LIB_ID)
  if (allowSeed !== true) return { library: existing, created: false }
  const same = existing !== null
    && JSON.stringify(existing.entries.map((entry) => [entry.zh, entry.pt, entry.approved, entry.variants]))
      === JSON.stringify(desired.entries.map((entry) => [entry.zh, entry.pt, entry.approved, entry.variants]))
  if (same) return { library: existing, created: false }
  // 内容不一致就覆盖（演示库自愈：避免"以前用旧字段建的库"让演示静默失效）
  const saved = await saveLibrary(root, desired, { by: 'terms-loop-demo', source: 'demo' })
  if (saved.ok !== true) throw new Error(`建演示库失败：${saved.error}`)
  return { library: saved.library, created: existing === null }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const env = typeof options.env === 'string' ? options.env : ''
  if (ENVS.includes(env) !== true) {
    console.error('必须指定 --env prod 或 --env test')
    return 2
  }
  const base = typeof options.base === 'string' ? options.base : VAR_BASE
  const root = resolveDataDir(base, env)
  const meetingId = typeof options.meeting === 'string' ? options.meeting : `demo-${Date.now()}`

  const seed = await ensureDemoLibrary(root, env === 'test' || options['allow-prod-seed'] === true)
  if (seed.created === true) {
    console.log(`（已建演示库 ${seed.library.id}「${seed.library.name}」：含 2 条带变体的术语，用于演示替换）`)
  } else if (seed.library === null) {
    console.log('（生产环境默认不造演示库；如需演示请加 --allow-prod-seed）')
  }

  const libraries = await listLibraries(root)
  if (libraries.length === 0) {
    console.error(`（${env} 环境里还没有库：先跑 node scripts/terms-admin.mjs import --env ${env} --file <json>）`)
    return 1
  }
  const wanted = typeof options.libraries === 'string'
    ? options.libraries.split(',').map((item) => item.trim()).filter(Boolean)
    : libraries.map((library) => library.id)
  const missing = wanted.filter((id) => libraries.every((library) => library.id !== id))
  if (missing.length > 0) {
    console.error(`有库不存在：${missing.join(', ')}`)
    return 1
  }

  const snapshot = await writeMeetingSnapshot(root, meetingId, { libraryIds: wanted, libraries })
  console.log(`① 快照：${snapshot.entries} 条 → ${snapshot.termsPath}`)
  console.log(`   （冻结在 ${meetingId}；之后再改库不影响这份）`)

  // 读回来的必须是**磁盘上的那份**，而不是内存里的对象 —— 否则等于没验证落盘格式
  const doc = JSON.parse(await readFile(snapshot.termsPath, 'utf-8'))
  const active = JSON.parse(await readFile(snapshot.activePath, 'utf-8'))
  const user = snapshotUserKey(meetingId)
  const entries = doc?.tables?.[user]?.entries ?? []
  console.log(`② 插件视角：user=${active.user}（应与 ${user} 一致），读到 ${entries.length} 条`)
  if (active.user !== user || entries.length === 0) {
    console.error('✗ 快照格式与插件读取口径不一致 —— 这一步不能通过')
    return 1
  }

  const policy = JSON.parse(await readFile(join(ROOT, 'policy', 'br-pt.json'), 'utf-8'))
  const samples = [
    // 故意用库里的**变体/可接受写法**而不是规范写法，才能看出归一是否生效
    { zh: '亮亮眼镜这条产品线在圣保罗的团队也在用骁龙 8 Gen 3 的方案。', pt: 'A linha de óculos Liangliang Ótica em São Paulo também usa o 骁龙8-3.' },
    { zh: '我们和高通合作。', pt: 'Trabalhamos com a Qualcomm Inc.' },
    { zh: '亮亮眼睛这条产品线在圣保罗的团队。', pt: 'A linha de óculos Leion em São Paulo.' },
  ]
  const normEntries = entries
  console.log(`③ 归一（normalizeTerms）与专名提示（translationSystem）：`)
  let touched = 0
  for (const sample of samples) {
    // 葡语侧：可接受写法 → 规范葡语
    const ptNormalized = normalizeTerms(sample.pt, PT, normEntries)
    if (ptNormalized.text !== sample.pt) touched += 1
    console.log(`   · 葡语译文：「${sample.pt}」`)
    console.log(`     → 归一后：「${ptNormalized.text}」${ptNormalized.text === sample.pt ? '（没有变化）' : '  ← 已按库里的规范写法替换'}`)
    // 中文侧：变体 → 规范中文（只在中文文本上生效）
    const zhNormalized = normalizeTerms(sample.zh, ZH, normEntries)
    if (zhNormalized.text !== sample.zh) touched += 1
    console.log(`   · 中文原文：「${sample.zh}」`)
    console.log(`     → 归一后：「${zhNormalized.text}」${zhNormalized.text === sample.zh ? '（没有变化）' : '  ← 已按库里的规范写法替换'}`)
    const hint = entries.filter((entry) => typeof entry.zh === 'string' && sample.zh.includes(entry.zh))
    const system = translationSystem(policy, ZH, PT, hint.length > 0 ? hint : null)
    const tail = system.split('\n').filter((line) => line.includes('本句原文')).join(' ')
    console.log(`     → 提示行：${tail === '' ? '（本句没有表内名字，不加提示）' : tail.slice(0, 120)}`)
  }

  console.log('')
  console.log('④ 真实链路怎么用这份快照（跑一场真会话时）：')
  console.log(`   node scripts/harness-side.mjs --live \\`)
  console.log(`     --terms-path "${snapshot.termsPath}" \\`)
  console.log(`     --terms-active-path "${snapshot.activePath}"`)
  console.log('')
  console.log(touched > 0
    ? '✅ 闭环成立：库里的规范写法已经能作用到译文（归一确实改了文本）。'
    : '⚠️ 归一没有改动任何文本 —— 可能是这几个库里的条目与本示例无关；换一个库或加一条包含变体的条目再试。')
  return 0
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(`✗ ${error.message}`)
  process.exit(1)
})
