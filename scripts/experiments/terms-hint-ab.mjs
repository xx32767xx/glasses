/**
 * terms-hint-ab.mjs —— "本句相关专名提示" A/B 实验（不改产线）
 * ============================================================================
 *
 * 问题：翻译模型把"亮亮眼镜"写成"这些眼镜"（泛称）时，能不能靠**提示词**避免？
 *
 *   A 基线：现在产线的 translationSystem（不点名）
 *   B 提示：同一套规则 + 末尾追加"本句原文出现了这些名字，译文必须保留下列写法
 *            （原文没出现的名字不要添加）：亮亮眼镜 → Leion；……"
 *
 * 测什么（全部用现成工具，不新增机制）：
 *   · 规范写法出现率（按"实体提及"计，合法缺席不计）
 *   · 句子有没有被写坏（数字丢没丢 / 是否被截断 / 是否空返回）
 *   · 提示词成本（prompt token 增量）
 *
 * 输出：var/terms-eval/hint-ab-report.md + .json（带缓存，重跑不重复花钱）。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const { ALL_ITEMS, EVAL_TABLE, checkCorpus } = await import(pathToFileURL(join(ROOT, 'scripts', 'terms-eval-corpus.mjs')).href)
const { validateTerms } = await import(pathToFileURL(join(ROOT, 'lib', 'terms.mjs')).href)
const { translationSystem } = await import(pathToFileURL(join(ROOT, 'plugin', 'core.mjs')).href)
const { CANDIDATES, callModel, findKey } = await import(pathToFileURL(join(ROOT, 'scripts', 'bench-models.mjs')).href)

const CACHE = join(ROOT, 'var', 'terms-eval', 'hint-ab-cache.json')
const OUT_MD = join(ROOT, 'var', 'terms-eval', 'hint-ab-report.md')
const OUT_JSON = join(ROOT, 'var', 'terms-eval', 'hint-ab-report.json')

const problems = checkCorpus(ALL_ITEMS)
if (problems.length > 0) {
  console.error('验收集本身有问题，先修它：')
  for (const problem of problems) console.error('  ' + problem)
  process.exit(1)
}

const policy = JSON.parse(await readFile(join(ROOT, 'policy', 'br-pt.json'), 'utf8'))
const baseSystem = translationSystem(policy, 'zh-CN', 'pt-BR')
const entries = validateTerms(EVAL_TABLE).entries

const candidate = CANDIDATES.find(item => item.key === 'deepseek')
const key = findKey(candidate.apiKeyEnv)
if (!key.value) {
  console.error('拿不到 ' + candidate.apiKeyEnv + '，跑不了这个实验')
  process.exit(1)
}

/** 折叠 + 去空格：判"规范写法在不在译文里"。 */
const fold = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^\p{L}\p{N}]/gu, ' ').trim().split(/\s+/).join('')

const digitsOf = text => (String(text).match(/\d+(?:[.,]\d+)*/g) ?? []).map(v => v.replace(/[.,]/g, ''))

function hintFor(item) {
  const wanted = (item.mentions ?? [])
    .filter((mention, index) => (item.allowMissing ?? []).includes(index) === false)
    // 5.02：三语条目 —— 目标写法取**填了的那一栏**（葡语优先，没有就用英语）
    .map(mention => mention.zh + ' → ' + (mention.pt || mention.en || ''))
    .filter(line => line.endsWith('→ ') === false)
  if (wanted.length === 0) return '本句原文没有需要保持写法的专名。'
  return '本句原文出现了这些名字，译文必须保留下列写法（原文没出现的名字不要添加）：' + wanted.join('；')
}

function metrics(item, translation, finish) {
  const expected = (item.mentions ?? []).filter((mention, index) => (item.allowMissing ?? []).includes(index) === false)
  const present = expected.filter(mention => fold(translation).includes(fold(mention.pt)))
  const digits = digitsOf(item.source)
  const translationDigits = digitsOf(translation)
  const digitsOk = digits.every(d => translationDigits.includes(d))
  return {
    expected: expected.length,
    present: present.length,
    missing: expected.length - present.length,
    missingZh: expected.filter(mention => present.includes(mention) === false).map(mention => mention.zh),
    digitsOk,
    finish,
    ok: finish === 'stop',
  }
}

let cache = {}
try {
  cache = JSON.parse(await readFile(CACHE, 'utf8'))
} catch { /* 第一次跑 */ }

async function ask(variant, item, system) {
  const cacheKey = item.id + '|' + variant
  if (Object.hasOwn(cache, cacheKey)) return cache[cacheKey]
  const result = await callModel(candidate, system, item.source, { temperature: 0, maxTokens: 400, timeoutMs: 60000 })
  const record = {
    ok: result.ok === true,
    text: result.ok === true ? result.text : null,
    finish: result.finish ?? null,
    promptTokens: result.usage?.prompt_tokens ?? null,
    completionTokens: result.usage?.completion_tokens ?? null,
    failure: result.ok === true ? null : result.failure,
  }
  cache[cacheKey] = record
  await writeFile(CACHE, JSON.stringify(cache, null, 2) + '\n', 'utf8')
  return record
}

const rows = []
for (const item of ALL_ITEMS) {
  const hintBlock = hintFor(item)
  const systemB = baseSystem + '\n\n' + hintBlock
  const a = await ask('A', item, baseSystem)
  const b = await ask('B', item, systemB)
  rows.push({
    id: item.id,
    cls: item.cls,
    holdout: item.holdout === true,
    source: item.source,
    hintBlock,
    A: { ...a, metrics: a.ok ? metrics(item, a.text, a.finish) : metrics(item, '', 'failed') },
    B: { ...b, metrics: b.ok ? metrics(item, b.text, b.finish) : metrics(item, '', 'failed') },
  })
  console.log(item.id + '  A=' + (a.ok ? a.text?.slice(0, 40) : '失败') + '  B=' + (b.ok ? b.text?.slice(0, 40) : '失败'))
}

const tally = variant => {
  const rowsOf = rows.filter(row => row[variant].metrics.ok)
  const expected = rowsOf.reduce((sum, row) => sum + row[variant].metrics.expected, 0)
  const present = rowsOf.reduce((sum, row) => sum + row[variant].metrics.present, 0)
  const broken = rows.filter(row => row[variant].metrics.ok === false).length
  const digitsBroken = rows.filter(row => row[variant].metrics.ok && row[variant].metrics.digitsOk === false).length
  const promptTokens = rows.map(row => row[variant].promptTokens).filter(value => typeof value === 'number')
  const avgPrompt = promptTokens.length === 0 ? 0 : Math.round(promptTokens.reduce((a, b) => a + b, 0) / promptTokens.length)
  return { expected, present, missing: expected - present, broken, digitsBroken, avgPrompt, rows: rowsOf.length }
}

const A = tally('A')
const B = tally('B')
const saved = rows.filter(row => row.A.metrics.missing > 0 && row.B.metrics.missing < row.A.metrics.missing)
const worsened = rows.filter(row => row.B.metrics.missing > row.A.metrics.missing)

const report = {
  generatedAt: new Date().toISOString(),
  model: candidate.model,
  items: rows.length,
  A, B,
  saved: saved.map(row => row.id),
  worsened: worsened.map(row => row.id),
  rows,
}
await writeFile(OUT_JSON, JSON.stringify(report, null, 2) + '\n', 'utf8')

const format = (label, data) => [
  '| ' + label + ' | ' + data.present + ' / ' + data.expected + ' | ' + (data.expected === 0 ? '—' : (100 * data.missing / data.expected).toFixed(1) + '%') + ' | ' + data.broken + ' | ' + data.digitsBroken + ' | ' + data.avgPrompt + ' |',
].join('')
const markdown = [
  '# 专名提示 A/B 实验（' + new Date().toISOString().slice(0, 10) + '）',
  '',
  '- 模型：`' + candidate.model + '`，温度 0，每题各一次调用',
  '- A = 产线现用提示词；B = 同一套规则 + 末尾追加"本句专名"提示',
  '- 分母只算**应保留**的实体提及（`allowMissing` 不计）',
  '',
  '| 组 | 规范写法出现 | 缺失率 | 句子失败 | 数字丢 | 平均 prompt token |',
  '|---|---|---|---|---|---|',
  format('A 基线', A),
  format('B 提示', B),
  '',
  '**提示救回的**（A 缺、B 出现）：' + (report.saved.length === 0 ? '无' : report.saved.join('、')),
  '',
  '**提示反而更差的**（B 缺得更多）：' + (report.worsened.length === 0 ? '无' : report.worsened.join('、')),
  '',
  '> 注意：这是单次采样、温度 0；结论只作方向性判断。',
].join('\n')
await writeFile(OUT_MD, markdown + '\n', 'utf8')
console.log('\n' + markdown)
console.log('\n已写出：' + OUT_MD)
