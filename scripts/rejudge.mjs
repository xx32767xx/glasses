/**
 * rejudge.mjs —— 用**当前判据**重评一批已记录的译文
 * ============================================================================
 *
 *   node scripts/rejudge.mjs --input var/logs/bench-models-v2.json
 *   node scripts/rejudge.mjs --input ... --markdown var/logs/rejudged.md
 *
 * 为什么要有它：判据会进化（新增专名/实体槽/性数三层、修掉误报漏报）。
 * 判据一变，**旧结论就该跟着变** —— 但**不能重跑模型**：
 * 重跑会换一批新的样本（模型有随机性，实测同一批跑两遍有 10/18 条文本不同），
 * 那样"新旧对比"里混进了"样本差异"，结论就不干净了。
 *
 * 正确做法是拿**同一批已记录的译文**换判据重评 —— 变量只有一个：判据。
 * 这一步也是"判据误报/漏报"最容易暴露的地方：收紧之后拿真实译文跑一遍，
 * 误报会立刻冒出来。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { lintTranslation } from '../lib/translation-lint.mjs'
import { verdictOf } from './bench-models.mjs'
import { toMarkdown } from './bench-models.mjs'

const policy = JSON.parse(readFileSync(join(process.cwd(), 'policy', 'br-pt.json'), 'utf8'))

export function parseArgs(argv) {
  const options = { input: null, markdown: null, compare: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--input') { options.input = argv[++index]; continue }
    if (token === '--markdown') { options.markdown = argv[++index]; continue }
    if (token === '--compare') { options.compare = true; continue }
    throw new Error('看不懂的参数：' + token)
  }
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.input === null) {
    console.log('用法：node scripts/rejudge.mjs --input var/logs/bench-models.json [--markdown 输出.md]')
    return
  }
  const record = JSON.parse(readFileSync(options.input, 'utf8'))
  const rows = []
  let changed = 0
  for (const row of record.rows) {
    if (row.ok !== true || row.truncated === true) {
      rows.push({ ...row, fatal: row.fatal ?? [], notes: row.notes ?? [], lint: { fatal: [], warn: [], notes: [] } })
      continue
    }
    const judged = verdictOf(row.source, row.text, policy.terminology)
    const before = (row.fatal ?? []).join('、')
    const after = judged.fatal.join('、')
    if (before !== after) {
      changed += 1
      if (options.compare) {
        console.log(`${row.model} [${row.index}] ${before || '（无）'} → ${after || '（无）'}`)
      }
    }
    rows.push({ ...row, fatal: judged.fatal, notes: judged.notes, lint: judged.lint,
      wrapped: judged.wrapped, shown: judged.shown })
  }

  console.log(`用当前判据重评了 ${rows.length} 行（来源 ${options.input}）`)
  console.log(changed === 0 ? '与记录里的结论完全一致' : `其中 ${changed} 行的结论变了（上面已列出）`)
  console.log('')
  const table = toMarkdown(rows, { system: true })
  console.log(table)
  if (options.markdown !== null) {
    writeFileSync(options.markdown, table + '\n', 'utf8')
    console.log(`\n已写出：${options.markdown}`)
  }
}

const invoked = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))
if (invoked) {
  main().catch(error => {
    console.error('重评失败：' + String(error && error.stack ? error.stack : error))
    process.exitCode = 1
  })
}
