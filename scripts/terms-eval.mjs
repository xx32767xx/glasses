/**
 * terms-eval.mjs —— 热词替换的**评分器**（docs/15 §10.1 / §12.3）
 * ============================================================================
 *
 *   node scripts/terms-eval.mjs --check
 *       只做验收集的卫生检查（不出数）。验收集坏了的结论一文不值，所以先跑这个。
 *
 *   node scripts/terms-eval.mjs --records var/terms-eval/a.jsonl
 *       给一批**已记录的初译译文**（A 档），算 A / B 两档指标。
 *       B 档是拿 A 档的译文过一遍匹配器得到的 —— **不需要再调模型**，
 *       所以这个数完全可复现（这正是"形式化替换单独可测"的意思）。
 *
 *   node scripts/terms-eval.mjs --records a.jsonl --corrected c.jsonl
 *       再给一批"校对后"的译文（C 档），三档并排。
 *
 * 指标口径（与 docs/15 §10.1 一致，改这里就要改文档）：
 *
 *   实体缺失率 = 缺失的实体提及次数 / 应保留的实体提及次数
 *     一次提及 = 原文里出现表内某个名字的一处（同一名字出现两次算两次）
 *     应保留   = 该提及没被标成 allowMissing（"我跟王工说了 → falei com ele" 那种合法省略）
 *     缺失     = 译文里既没有规范写法、也没保留原中文、也不是已知的错误写法
 *
 *   ⚠️ 注意 `wrongForm`（写法错）与 `missing`（完全没有）是**两件事**：
 *      前者说明"归一还没覆盖到"，后者说明"模型根本没说这个名字"。混在一起就分不清该修哪里。
 *
 * 输出：终端一张表 + `var/terms-eval/results/<时间戳>.json`（便于以后对比）。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { ALL_ITEMS, EVAL_TABLE, checkCorpus } from './terms-eval-corpus.mjs'
import { applyTerms, foldForMatch } from '../lib/terms-matcher.mjs'
import { validateTerms } from '../lib/terms.mjs'
import { ASR_DIR } from '../lib/paths.mjs'

const RESULTS_DIR = join(ASR_DIR, '..', 'terms-eval', 'results')

const argv = process.argv.slice(2)
const options = { check: false, records: null, corrected: null, json: false, limit: null }
for (let index = 0; index < argv.length; index += 1) {
  const token = argv[index]
  if (token === '--check') { options.check = true; continue }
  if (token === '--json') { options.json = true; continue }
  if (token === '--records') { options.records = argv[++index]; continue }
  if (token === '--corrected') { options.corrected = argv[++index]; continue }
  if (token === '--limit') { options.limit = Number(argv[++index]); continue }
  if (token === '--help' || token === '-h') {
    console.log('用法：node scripts/terms-eval.mjs [--check] [--records a.jsonl] [--corrected c.jsonl] [--json]')
    process.exit(0)
  }
  throw new Error('看不懂的参数：' + token)
}

/** 表必须能通过真实校验 —— 否则后面所有数都是拿一张非法表算出来的。 */
function buildEntries() {
  const checked = validateTerms(EVAL_TABLE)
  if (checked.ok !== true) {
    console.error('验收集的热词表本身不合法：')
    for (const item of checked.rejected) console.error(`  第 ${item.index + 1} 条：${item.code} —— ${item.reason}`)
    process.exit(1)
  }
  return checked.entries
}

const byZh = entries => new Map(entries.map(entry => [entry.zh, entry]))

/**
 * 给一批译文打分（A/B/C 任一档）。
 *
 * @param {object[]} items 验收集条目（含 mentions / allowMissing）
 * @param {Map<string,string>} translations id → 译文
 * @param {object[]} entries 热词表
 */
export function scoreStage(items, translations, entries) {
  const table = byZh(entries)
  const result = {
    items: 0, scored: 0, skipped: 0,
    mentions: 0, present: 0, missing: 0, wrongForm: 0, keptChinese: 0,
    replace: 0, boundarySkip: 0, suspiciousChanges: 0,
    missingDetail: [], wrongDetail: [], suspiciousDetail: [],
  }

  for (const item of items) {
    result.items += 1
    const text = translations.get(item.id)
    if (typeof text !== 'string' || text === '') { result.skipped += 1; continue }
    result.scored += 1
    const foldedText = foldForMatch(text)

    // ── 实体提及层面的统计 ───────────────────────────────────────────────
    const allowMissing = new Set(item.allowMissing ?? [])
    for (const [index, mention] of (item.mentions ?? []).entries()) {
      if (allowMissing.has(index)) continue          // 合法省略：不进分母
      result.mentions += 1
      const entry = table.get(mention.zh)
      const canonical = mention.pt
      const accepted = [canonical, ...((entry?.approved ?? []))]
      const wrongForms = entry?.wrong ?? []

      if (accepted.some(form => foldedText.includes(foldForMatch(form)))) {
        result.present += 1
        continue
      }
      if (foldedText.includes(foldForMatch(mention.zh))) {
        result.keptChinese += 1                  // 保留了中文名：不算缺失，也不算对
        continue
      }
      if (wrongForms.some(form => foldedText.includes(foldForMatch(form)))) {
        result.wrongForm += 1
        result.wrongDetail.push({ id: item.id, mention: mention.zh, text })
        continue
      }
      result.missing += 1
      result.missingDetail.push({ id: item.id, mention: mention.zh, expect: canonical, text })
    }

    // ── 替换事件层面的统计 ───────────────────────────────────────────────
    const applied = applyTerms(text, { entries, lang: 'pt-BR' })
    /** 这一句的可疑理由（**每句只算一次**：一句话被改坏算 1 条，不按改动次数累加）。 */
    const suspicions = []
    const allowed = new Set((item.mentions ?? []).map(mention => mention.zh))
    for (const event of applied.events) {
      if (event.event === 'replace') {
        result.replace += 1
        // 换了不属于本句标注的实体 → 可疑（可能是误替换，也可能标注不全，都值得人看一眼）
        const entry = entries.find(candidate => candidate.id === event.id)
        if (entry !== undefined && allowed.has(entry.zh) === false) {
          suspicions.push(`${event.from} → ${event.to}（${event.context ?? ''}）`)
        }
      } else if (event.event === 'boundary_skip') {
        result.boundarySkip += 1
      }
    }
    // 陷阱句（标注为空）：改了就一定可疑
    if (allowed.size === 0 && applied.text !== text) {
      suspicions.push('整句被改：' + applied.text.slice(0, 60))
    }
    if (suspicions.length > 0) {
      result.suspiciousChanges += 1
      result.suspiciousDetail.push({ id: item.id, reasons: suspicions })
    }
  }

  result.missRate = result.mentions === 0 ? null : result.missing / result.mentions
  result.wrongRate = result.mentions === 0 ? null : result.wrongForm / result.mentions
  result.keptRate = result.mentions === 0 ? null : result.keptChinese / result.mentions
  return result
}

/** 把记录文件读成 id → 译文。支持 JSONL 与 JSON 数组两种。 */
async function readRecords(path) {
  const text = await readFile(path, 'utf-8')
  const out = new Map()
  const trimmed = text.trim()
  if (trimmed.startsWith('[')) {
    for (const row of JSON.parse(trimmed)) {
      if (row && typeof row.id === 'string' && typeof row.translation === 'string') out.set(row.id, row.translation)
    }
    return out
  }
  for (const line of trimmed.split('\n')) {
    if (line.trim() === '') continue
    const row = JSON.parse(line)
    if (row && typeof row.id === 'string' && typeof row.translation === 'string') out.set(row.id, row.translation)
  }
  return out
}

const percent = value => (value === null ? '—' : (value * 100).toFixed(1) + '%')

function printTable(stages) {
  console.log('')
  console.log('档位          条目  已评分  提及  规范出现  缺失   写法错  保留中文  替换  边界跳过  可疑改动')
  for (const [name, result] of stages) {
    console.log(
      name.padEnd(13) +
      String(result.items).padStart(5) + String(result.scored).padStart(7) +
      String(result.mentions).padStart(6) + String(result.present).padStart(9) +
      String(result.missing).padStart(6) + String(result.wrongForm).padStart(7) +
      String(result.keptChinese).padStart(9) + String(result.replace).padStart(6) +
      String(result.boundarySkip).padStart(9) + String(result.suspiciousChanges).padStart(10)
    )
  }
  console.log('')
  console.log('档位          实体缺失率   写法错误率   保留中文率')
  for (const [name, result] of stages) {
    console.log(name.padEnd(13) + percent(result.missRate).padStart(9) + percent(result.wrongRate).padStart(12)
      + percent(result.keptRate).padStart(12))
  }
}

async function main() {
  const problems = checkCorpus()
  if (problems.length > 0) {
    console.error('验收集卫生检查没过（先修它，再出数）：')
    for (const problem of problems) console.error('  · ' + problem)
    process.exit(1)
  }
  if (options.check === true && options.records === null) {
    console.log(`验收集检查通过：${ALL_ITEMS.length} 条`
      + `（密集 ${ALL_ITEMS.filter(i => i.cls === 'dense' && !i.holdout).length} / `
      + `陷阱 ${ALL_ITEMS.filter(i => i.cls === 'trap').length} / `
      + `留出 ${ALL_ITEMS.filter(i => i.holdout).length}），`
      + `实体提及 ${ALL_ITEMS.filter(i => !i.holdout).reduce((sum, i) => sum + (i.mentions?.length ?? 0) - (i.allowMissing?.length ?? 0), 0)} 次`)
    return
  }
  if (options.records === null) {
    console.error('需要 --records <a.jsonl>（已记录的初译译文）；只想检查验收集就加 --check')
    process.exit(1)
  }

  const entries = buildEntries()
  const items = options.limit === null ? ALL_ITEMS : ALL_ITEMS.slice(0, options.limit)
  const stageA = await readRecords(options.records)

  // B 档：把 A 档的译文过一遍匹配器（纯字符串，零模型调用）
  const stageB = new Map()
  for (const [id, text] of stageA) {
    stageB.set(id, applyTerms(text, { entries, lang: 'pt-BR' }).text)
  }

  const stages = []
  stages.push(['A 初译原始', scoreStage(items, stageA, entries)])
  stages.push(['B 替换后', scoreStage(items, stageB, entries)])
  if (options.corrected !== null) {
    const stageC0 = await readRecords(options.corrected)
    const stageC = new Map()
    for (const [id, text] of stageC0) stageC.set(id, applyTerms(text, { entries, lang: 'pt-BR' }).text)
    stages.push(['C 校对+替换', scoreStage(items, stageC, entries)])
  }

  if (options.json === true) {
    console.log(JSON.stringify(Object.fromEntries(stages), null, 2))
  } else {
    printTable(stages)
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    records: options.records,
    corrected: options.corrected,
    stages: Object.fromEntries(stages),
  }
  await mkdir(RESULTS_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = join(RESULTS_DIR, `terms-eval-${stamp}.json`)
  await writeFile(target, JSON.stringify(payload, null, 2) + '\n', 'utf-8')
  if (options.json !== true) console.log('\n结果已写出：' + target)

  // 明细里挑最该看的几条打出来（人写报告时要用）
  const b = stages.find(([name]) => name.startsWith('B'))[1]
  if (b.missingDetail.length > 0) {
    console.log('\nB 档缺失的例子（前 5 条）：')
    for (const row of b.missingDetail.slice(0, 5)) {
      console.log(`  [${row.id}] 应出现 ${row.mention} → ${row.expect}`)
      console.log('     译文 ' + row.text)
    }
  }
  if (b.suspiciousDetail.length > 0) {
    console.log('\nB 档可疑改动（前 5 条）：')
    for (const row of b.suspiciousDetail.slice(0, 5)) {
      console.log(`  [${row.id}] ${row.from ?? ''} → ${row.to ?? ''}  ${row.context ?? ''}`)
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('出错了：' + (error && error.message ? error.message : error))
    process.exit(1)
  })
}
