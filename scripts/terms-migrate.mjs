#!/usr/bin/env node
/**
 * terms-migrate.mjs —— 把旧模型的热词表（`terms.json` 里按用户的单张表）迁移成"库"
 * ============================================================================
 *
 * 为什么要迁移而不是让用户重录：旧表里是**实测过的真实对照**（7 条带 `approved`），
 * 重录一遍必然出错；而且旧表就是"用户上传的热词表"那件事的产物，不该丢。
 *
 * 迁移规则（一条一条说清，避免"迁完不知道哪些没迁"）：
 *   · `terms.json` 里每个**有条目**的表 → 一个库，id = `lib-legacy-<用户>`，优先级 0；
 *   · 库名默认 `<用户> 的旧热词表`，可用 `--name-prefix` 改；
 *   · 条目原样搬（zh/pt/variants/approved/wrong/direction/enforce/fold），
 *     但会**清理两类必然被校验拒绝的冗余**：
 *       - `approved` 里与 `pt` 折叠后相同的项（等价于自己）；
 *       - `variants` 里与 `zh` 折叠后相同的项。
 *   · 空的表（0 条）跳过，并在报告里列出 —— 不然"我有 3 个表"和"迁了 2 个"对不上。
 *
 * 默认**只打印计划不写盘**；加 `--apply` 才写入。
 *
 * 用法：
 *   node scripts/terms-migrate.mjs --env prod                 # 看计划
 *   node scripts/terms-migrate.mjs --env prod --apply         # 真写
 *   node scripts/terms-migrate.mjs --env prod --apply --priority 5
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ROOT, VAR_DIR } from '../lib/paths.mjs'
import { ENVS, resolveDataDir } from '../lib/store.mjs'
import { foldKey } from '../lib/terms.mjs'
import { listLibraries, saveLibrary } from '../lib/libraries.mjs'

function parseArgs(argv) {
  const options = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token.startsWith('--') !== true) { options._.push(token); continue }
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) { options[key] = true; continue }
    options[key] = next
    index += 1
  }
  return options
}

/** 去掉与被替换目标等价的冗余写法（等于自己），以及空字符串。 */
function cleanEntry(entry) {
  const zhKey = foldKey(entry.zh)
  const ptKey = foldKey(entry.pt)
  const out = { ...entry }
  if (Array.isArray(entry.approved)) {
    const kept = entry.approved.filter((item) => typeof item === 'string' && item.trim() !== ''
      && foldKey(item) !== ptKey)
    out.approved = kept
  }
  if (Array.isArray(entry.variants)) {
    const kept = entry.variants.filter((item) => typeof item === 'string' && item.trim() !== ''
      && foldKey(item) !== zhKey)
    out.variants = kept
  }
  if (Array.isArray(entry.wrong)) {
    out.wrong = entry.wrong.filter((item) => typeof item === 'string' && item.trim() !== '')
  }
  return out
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const env = typeof options.env === 'string' ? options.env : ''
  if (ENVS.includes(env) !== true) {
    console.error('必须指定 --env prod 或 --env test')
    return 2
  }
  const base = typeof options.base === 'string' ? options.base : VAR_DIR
  const root = resolveDataDir(base, env)
  const apply = options.apply === true
  const priority = typeof options.priority === 'string' ? Number(options.priority) : 0
  const prefix = typeof options['name-prefix'] === 'string' ? options['name-prefix'] : ''

  const legacyPath = join(root, 'terms.json')
  let doc
  try {
    doc = JSON.parse(await readFile(legacyPath, 'utf-8'))
  } catch (error) {
    console.error(`读不到旧热词表：${legacyPath}（${error.message}）`)
    console.error('如果这台机器上还没上传过热词表，就不用迁移。')
    return 1
  }

  const activePath = join(root, 'terms-active.json')
  let activeUser = null
  try {
    activeUser = JSON.parse(await readFile(activePath, 'utf-8')).user ?? null
  } catch { /* 没有 active 文件就按 null 处理 */ }

  const existing = await listLibraries(root)
  const existingIds = new Set(existing.map((library) => library.id))
  const tables = doc.tables !== null && typeof doc.tables === 'object' ? doc.tables : {}
  const plan = []
  const skipped = []

  for (const [user, table] of Object.entries(tables)) {
    const entries = Array.isArray(table?.entries) ? table.entries : []
    if (entries.length === 0) {
      skipped.push({ user, reason: '0 条' })
      continue
    }
    const id = `lib-legacy-${String(user).replace(/[^A-Za-z0-9_-]/g, '_')}`
    plan.push({
      user, id, active: user === activeUser,
      name: `${prefix}${user} 的热词表`,
      entries: entries.map(cleanEntry),
    })
  }

  console.log(`旧表：${legacyPath}`)
  console.log(`生效用户（terms-active）：${activeUser ?? '（无）'}`)
  console.log(`环境：${env}（${root}）；已有库 ${existing.length} 个`)
  console.log('')
  if (plan.length === 0) {
    console.log('没有可迁移的非空表。')
    return 0
  }
  for (const item of plan) {
    console.log(`· ${item.user}${item.active ? '（当前生效）' : ''} → ${item.id}「${item.name}」`
      + `：${item.entries.length} 条${existingIds.has(item.id) ? '  ⚠ 该库已存在，将覆盖' : ''}`)
  }
  for (const item of skipped) {
    console.log(`· ${item.user}：跳过（${item.reason}）`)
  }

  if (apply !== true) {
    console.log('')
    console.log('（这是计划，没写入。加 --apply 才会真的建库）')
    return 0
  }

  console.log('')
  let created = 0
  let failed = 0
  for (const item of plan) {
    const saved = await saveLibrary(root, {
      id: item.id, name: item.name, categoryId: null, priority, entries: item.entries,
    }, { by: 'terms-migrate', source: 'migrate' })
    if (saved.ok !== true) {
      failed += 1
      console.log(`✗ ${item.id}：${saved.error}`)
      if (Array.isArray(saved.rejected) && saved.rejected.length > 0) {
        for (const reason of saved.rejected.slice(0, 3)) {
          console.log(`   第 ${reason.index} 条：${reason.reason ?? reason.code}`)
        }
      }
      continue
    }
    created += 1
    console.log(`✓ ${item.id}「${saved.library.name}」${saved.library.entries.length} 条`
      + `${saved.created ? '' : '（已存在，已覆盖）'}`)
  }
  console.log('')
  console.log(`迁移完成：成功 ${created} 个库，失败 ${failed} 个`)
  if (created > 0) {
    console.log('下一步：让插件用上它 —— 先建一份会议快照，再把 harness-side 指向它：')
    console.log(`  node scripts/terms-admin.mjs snapshot --env ${env} --meeting current --libraries ${plan.map((item) => item.id).join(',')}`)
  }
  return failed === 0 ? 0 : 1
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(`✗ ${error.message}`)
  process.exit(1)
})

export { ROOT }
