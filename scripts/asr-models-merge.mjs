#!/usr/bin/env node
/**
 * asr-models-merge.mjs —— 把候选策略合进服务器的策略表（**只加不覆盖**，5.61）
 * ============================================================================
 *
 * 为什么要这个脚本，而不是让人复制粘贴 JSON：
 *   · 服务器上那张 `<数据目录>/asr-models.json` 是**手改过**的（切句参数、本地模型路径），
 *     用示例表整体覆盖会把这些调整悄悄抹掉；
 *   · 而"手工把三条策略抄进去"这件事，抄错一个逗号的表现是**整张表读不了**
 *     （识别侧会退回命令行那套），偏偏还不报错 —— 正是最该交给脚本的一类操作。
 *
 * 行为：
 *   · 默认**只打印会发生什么**（dry-run），加 `--write` 才落盘；
 *   · 落盘前把原文件备份成 `asr-models.json.bak-<时间戳>`；
 *   · 同名但内容不同 → **不动**，只列出来（那可能是别人测过的配置）；
 *   · 表写坏/不存在时的处理：不存在就整份创建；坏掉就**拒绝动它**（先让人修）。
 *
 * 用法
 *   node scripts/asr-models-merge.mjs --data-dir /var/lib/leion/test
 *   node scripts/asr-models-merge.mjs --data-dir /var/lib/leion/test --write
 *   node scripts/asr-models-merge.mjs --data-dir ... --only en-turbo,en-distil --write
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mergeStrategies, parseJsonLoose } from '../lib/asr-engines.mjs'

function parseArgs(argv) {
  const args = { dataDir: '', write: false, source: 'config/asr-models.json', only: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item === '--data-dir') args.dataDir = argv[index += 1] ?? ''
    else if (item === '--source') args.source = argv[index += 1] ?? args.source
    else if (item === '--only') args.only = String(argv[index += 1] ?? '').split(',').map((one) => one.trim()).filter(Boolean)
    else if (item === '--write') args.write = true
    else if (item === '--help' || item === '-h') {
      console.log('用法：node scripts/asr-models-merge.mjs --data-dir <目录> [--source <示例表>] [--only a,b] [--write]')
      process.exit(0)
    } else {
      console.error(`不认识的参数：${item}`)
      process.exit(2)
    }
  }
  if (!args.dataDir) {
    console.error('缺 --data-dir（服务器上通常是 /var/lib/leion/live 或 /var/lib/leion/test）')
    process.exit(2)
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const target = join(args.dataDir, 'asr-models.json')

  let incoming
  try {
    incoming = parseJsonLoose(readFileSync(args.source, 'utf-8')).value
  } catch (error) {
    console.error(`读不到示例表 ${args.source}：${String(error?.message ?? error)}`)
    return 2
  }
  if (args.only.length > 0) {
    const kept = {}
    for (const name of args.only) {
      if (incoming?.strategies?.[name] === undefined) {
        console.error(`示例表里没有策略 ${name}（可选：${Object.keys(incoming?.strategies ?? {}).join(', ')}）`)
        return 2
      }
      kept[name] = incoming.strategies[name]
    }
    incoming = { ...incoming, strategies: kept }
  }

  let current = {}
  if (existsSync(target)) {
    try {
      const parsed = parseJsonLoose(readFileSync(target, 'utf-8'))
      current = parsed.value
      if (parsed.hadBom) {
        // ⚠️ BOM 要说出来：Python 侧读 utf-8 会因为 BOM **整表失败**（表现是"模型没换"）
        console.log(`⚠️ ${target} 带 UTF-8 BOM：这次写入会去掉它（Python 侧读 utf-8 时 BOM 会让整表失败）`)
      }
    } catch (error) {
      // ⚠️ 表坏了就**别动**：那说明有人在热改，先让人修好再合
      console.error(`${target} 现在是坏的（${String(error?.message ?? error)}）—— 不动它，先修好再来`)
      return 2
    }
  } else {
    console.log(`${target} 不存在，会按示例表整份创建`)
  }

  const merged = mergeStrategies(current, incoming)
  console.log(`目标：${target}`)
  if (merged.added.length > 0) {
    for (const name of merged.added) {
      const layer = merged.table.strategies[name]
      console.log(`  + ${name}：${layer.model ?? '（继承默认模型）'}${layer.note ? `  — ${layer.note}` : ''}`)
    }
  } else {
    console.log('  （没有需要新增的策略）')
  }
  for (const name of merged.unchanged) console.log(`  = ${name}：已存在且内容相同`)
  for (const name of merged.conflict) {
    console.log(`  ! ${name}：表里已有**不同内容**的同名策略，没有覆盖 —— 要替换请手工改`)
  }

  if (!args.write) {
    console.log('\n这是预览（dry-run）。确认无误后加 --write 落盘（会先备份原文件）。')
    return 0
  }
  if (merged.added.length === 0) {
    console.log('\n没有新增项，不写文件。')
    return 0
  }
  if (existsSync(target)) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const backup = `${target}.bak-${stamp}`
    copyFileSync(target, backup)
    console.log(`已备份 ${backup}`)
  }
  writeFileSync(target, JSON.stringify(merged.table, null, 2), 'utf-8')
  console.log(`已写入 ${target}（识别侧与切句侧都按 mtime 热读，不用重启）`)
  console.log('⚠️ 新策略只是"可选"：在 App 里选它才会生效，不选仍按 languages 那层走。')
  return 0
}

process.exit(main())
