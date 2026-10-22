/**
 * eval-rescue.mjs —— 方向一"临时修正"的离线评估（不联网，复用对照实验缓存）
 *
 * 数据：两批人工标注（22 个 span 提及 + 2 个 generic 提及），
 * 回答来自 var/terms-eval/arm-llm-cache.json（对照实验里已经问过"写成了什么"）。
 *
 * 对每个提及：
 *   1) 用 planRescue 的全部闸门判断"会不会改"；
 *   2) 若会改，检查 from 片段是否等于人工标注的片段（改对了吗）；
 *   3) 检查改完的句子是否仍然含规范写法、且其余部分逐字未动（只换了那一小段）。
 *
 * 输出：会不会改、改得对不对、改坏了吗。这一步决定 §18 的结论是"可开"还是"不可开"。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const DIR = join(ROOT, 'var', 'terms-eval')
const { planRescue } = await import(pathToFileURL(join(ROOT, 'plugin', 'core.mjs')).href)
const foldForTerms = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, '')

const cache = JSON.parse(await readFile(join(DIR, 'arm-llm-cache.json'), 'utf-8'))

// 从第二批标注清单解析（复用之前的格式）+ 第一批 annotate-20.json
const mdB = (await readFile(join(DIR, '标注清单-第二批.md'), 'utf-8')).replace(/\r\n/g, '\n')
const annotateA = JSON.parse(await readFile(join(DIR, 'annotate-20.json'), 'utf-8'))
const mdA = (await readFile(join(DIR, '标注清单-20.md'), 'utf-8')).replace(/\r\n/g, '\n')

const items = []
// 第一批：只取人工标过的 10 条
for (const info of annotateA.items) {
  const label = info.label // annotate-20.json 里没有人工标签，从 md 里取
  void label
}
{
  const blocks = mdA.split(/^## /m).slice(1)
  for (const block of blocks) {
    const head = block.split('\n')[0].trim()
    const secs = block.split(/^### /m).slice(1)
    for (const s of secs) {
      const m = s.match(/^标注 (\d+)：(.+?) → (.+)/)
      if (!m) continue
      const tickLine = (s.match(/^标注：(.*)$/m) ?? [, ''])[1]
      const ticks = (tickLine.match(/\[([^\]]*)\]/g) ?? []).map(t => t.replace(/[\[\]\s]/g, '') === 'x')
      const label = ['span', 'generic', 'missing', 'unsure'][ticks.indexOf(true)] ?? 'none'
      if (label !== 'span' && label !== 'generic') continue
      const span = (s.match(/^片段＝(.*)$/m) ?? [, ''])[1].trim()
      const info = annotateA.items.find(x => x.mentionIndex === Number(m[1]))
      if (!info) continue
      items.push({
        batch: 'A', id: info.id, n: Number(m[1]), zh: info.zh, canonical: info.canonical,
        source: info.source, translation: info.translation, label, goldSpan: span,
        answer: cache[`A:${info.id}:${info.mentionIndex}:${info.zh}`] ?? null,
      })
    }
  }
}
{
  for (const block of mdB.split(/\n---\n/)) {
    const m = block.match(/^## (\d+)（(x\d+)）$/m)
    if (!m) continue
    const grab = re => (block.match(re) || [, ''])[1].trim()
    const translation = block.split(/\n\n/).find(p => p.startsWith('**译文**'))
    const original = translation.replace(/^【?译文】?[:：]\s*/, '').split('（修正后）')[0].trim()
    const tickLine = grab(/^标注：(.*)$/m)
    const ticks = (tickLine.match(/\[([^\]]*)\]/g) ?? []).map(t => t.replace(/[\[\]\s]/g, '') === 'x')
    const label = ['span', 'generic', 'missing', 'unsure'][ticks.indexOf(true)] ?? 'none'
    items.push({
      batch: 'B', id: m[2], n: Number(m[1]),
      zh: grab(/\*\*实体\*\*：(.+?)　→/),
      canonical: grab(/表里规定的语写法：`(.*?)`/),
      source: grab(/\*\*原文\*\*：(.*)$/m),
      translation: original,
      label,
      goldSpan: grab(/^片段＝(.*)$/m),
      answer: cache[`B:${m[2]}:${Number(m[1])}:${grab(/\*\*实体\*\*：(.+?)　→/)}`] ?? null,
    })
  }
}

// 表：每个条目一条（方向按句子的译文语种判断）
const entries = []
const seen = new Set()
for (const item of items) {
  if (seen.has(item.zh)) continue
  seen.add(item.zh)
  entries.push({ id: 'e' + seen.size, zh: item.zh, pt: item.canonical })
}

const rows = []
for (const item of items) {
  if (item.label !== 'span' && item.label !== 'generic') continue
  const targetZh = !/[\u4e00-\u9fff]/.test(item.translation) ? false : true
  const canonical = item.canonical
  let verdict
  let detail = ''
  if (item.answer === null || item.answer === undefined) {
    verdict = '无回答'
  } else {
    const plan = planRescue({
      draft: item.translation, answer: item.answer, canonical,
      entries, targetZh, cols: 40, lines: 3,
    })
    if (plan.ok !== true) {
      verdict = '拒绝：' + plan.reason
    } else {
      // 改对了吗：from 与人工片段折叠后一致（或人工片段是它的连续子串）
      const from = foldForTerms(plan.from).replace(/\s+/g, '')
      const gold = foldForTerms(item.goldSpan).replace(/\s+/g, '')
      const correct = gold !== '' && (from === gold || from.includes(gold) || gold.includes(from))
      const unchangedElsewhere = plan.text.length === item.translation.length - plan.from.length + canonical.length
      verdict = correct && unchangedElsewhere ? '改对' : (correct ? '改对但长度异常' : '改错')
      detail = 'from=' + plan.from + ' gold=' + (item.goldSpan || '(泛称)')
      // 兜底断言：改完必须真的含规范写法
      if (!foldForTerms(plan.text).includes(foldForTerms(canonical))) detail += ' | 结果不含规范写法!'
    }
  }
  rows.push({ id: item.id, zh: item.zh, label: item.label, answer: item.answer, verdict, detail })
}

const tally = {}
for (const row of rows) tally[row.verdict] = (tally[row.verdict] ?? 0) + 1
console.log('共 ' + rows.length + ' 条（span + generic），闸门结果：')
for (const [key, value] of Object.entries(tally)) console.log('  ' + key + '：' + value)
console.log('')
for (const row of rows) {
  console.log(`${row.id} ${row.zh} [${row.label}] answer=${row.answer === null ? '(无)' : row.answer} → ${row.verdict} ${row.detail}`)
}
await writeFile(join(DIR, 'rescue-eval.json'), JSON.stringify({ rows, tally }, null, 2) + '\n', 'utf-8')
