/**
 * compare-arms.mjs —— 三种"变体定位"方法的对照实验（同一批人工标注）
 *
 * 三个臂：
 *   A 对齐器（awesome-align + align-trim，已有结果，直接读）
 *   B LLM 端到端（Qwen2.5-72b：问"中文名在译文里对应哪段"）
 *   C 纯字面相似度（基线：滑窗 + Dice，最便宜的对照组）
 *
 * 数据：两批人工标注（第一批 10 次提及：8 span + 2 generic；第二批 14 次：全 span）
 * 评分：返回片段与人工片段逐词重叠/包含 → 命中；返回了但不相干 → 错位；拒答 → 未命中。
 * 对 gold=generic：拒答才对，返回片段=错。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const DIR = join(ROOT, 'var', 'terms-eval')
const mdA = (await readFile(join(DIR, '标注清单-20.md'), 'utf-8')).replace(/\r\n/g, '\n')
const mdB = (await readFile(join(DIR, '标注清单-第二批.md'), 'utf-8')).replace(/\r\n/g, '\n')
const annotateA = JSON.parse(await readFile(join(DIR, 'annotate-20.json'), 'utf-8'))
const metaB = JSON.parse(await readFile(join(DIR, 'crosstalk-align-meta.json'), 'utf-8'))
const alignA = JSON.parse(await readFile(join(DIR, 'align-eval-report.json'), 'utf-8'))
const alignB = JSON.parse(await readFile(join(DIR, '标注评估-第二批.json'), 'utf-8'))

// ── 折叠/边界工具（与生产同一口径） ────────────────────────────────────────
const ARTICLES = new Set(['a', 'o', 'as', 'os', 'um', 'uma', 'de', 'da', 'do', 'das', 'dos', 'e', 'na', 'no', 'nas', 'nos', 'em'])
const fold = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean)
function words(text, stripLeading = true) {
  const out = fold(text)
  if (stripLeading) while (out.length && ARTICLES.has(out[0])) out.shift()
  return out
}
const dice = (a, b) => {
  const bigrams = xs => { const m = new Map(); for (let i = 0; i < xs.length - 1; i += 1) { const g = xs.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1) } return m }
  const A = bigrams(a), B = bigrams(b)
  let shared = 0, total = 0
  for (const [g, n] of B) { total += n; shared += Math.min(n, A.get(g) ?? 0) }
  return total === 0 ? 0 : (2 * shared) / ((a.length - 1) + (b.length - 1))
}
const SYNONYMS = [['beijing', 'pequim']]
function lev(a, b) {
  const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j += 1) m[0][j] = j
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
  }
  return m[a.length][b.length]
}
const tokenEq = (a, b) => a === b
  || SYNONYMS.some(([x, y]) => (a === x && b === y) || (a === y && b === x))
  || (a.length >= 3 && b.length >= 3 && 1 - lev(a, b) / Math.max(a.length, b.length) >= 0.75)
const containsSeq = (outer, inner) => {
  for (let s = 0; s + inner.length <= outer.length; s += 1) {
    if (inner.every((w, k) => tokenEq(w, outer[s + k]))) return true
  }
  return false
}
/** 返回片段 S 与人工片段 G 的关系：hit / wrong / miss */
function judge(S, G) {
  if (S === null) return 'miss'
  const s = words(S), g = words(G)
  if (s.length === 0) return 'miss'
  if (containsSeq(s, g) || containsSeq(g, s)) return 'hit'
  return 'wrong'
}

// ── 造记录 ─────────────────────────────────────────────────────────────────
/** 解析第一批 md 的标注（### 标注 N：zh → pt） */
const recordsA = []
for (const line of mdA.split('\n')) {
  const m = line.match(/^### 标注 (\d+)：(.+?) → (.+)/)
  if (!m) continue
  recordsA.push({ n: Number(m[1]), zh: m[2].trim(), canonical: m[3].trim() })
}
// 补上人工标签：从 md 的「标注：」与「片段＝」
{
  const blocks = mdA.split(/^## /m).slice(1)
  for (const block of blocks) {
    const head = block.split('\n')[0].trim()           // "d01"
    const sec = block.split(/^### /m)
    for (const s of sec.slice(1)) {
      const m = s.match(/^标注 (\d+)：(.+?) → (.+)/)
      if (!m) continue
      const labelLine = (s.match(/^标注：(.*)$/m) ?? [, ''])[1]
      const ticks = (labelLine.match(/\[([^\]]*)\]/g) ?? []).map(t => t.replace(/[\[\]]/g, '').trim() === 'x')
      const label = ['span', 'generic', 'missing', 'unsure'][ticks.findIndex(Boolean)] ?? 'none'
      const span = (s.match(/^片段＝(.*)$/m) ?? [, ''])[1].trim()
      const rec = recordsA.find(r => r.n === Number(m[1]))
      if (rec) Object.assign(rec, { label, goldSpan: span, id: head })
    }
  }
}
const labelledA = recordsA.filter(r => r.label !== 'none')
// 补全文本：从 annotate-20.json 按 mentionIndex 找 source/translation
for (const r of labelledA) {
  const info = annotateA.items.find(x => x.mentionIndex === r.n)
  if (!info) throw new Error('annotate-20.json 缺 mentionIndex ' + r.n)
  Object.assign(r, { batch: 'A', source: info.source, translation: info.translation, id: info.id })
}

// 第二批：直接按块解析
const recordsB = []
for (const block of mdB.split(/\n---\n/)) {
  const id = block.match(/^## (\d+)（(x\d+)）$/m)
  if (!id) continue
  const grab = re => (block.match(re) || [, ''])[1].trim()
  const translation = block.split(/\n\n/).find(p => p.startsWith('**译文**'))
  const original = translation.replace(/^【?译文】?[:：]\s*/, '').split('（修正后）')[0].trim()
  const ticks = (grab(/^标注：(.*)$/m).match(/\[([^\]]*)\]/g) ?? []).map(t => t.replace(/[\[\]\s]/g, '').toLowerCase() === 'x')
  recordsB.push({
    batch: 'B', n: Number(id[1]), id: id[2],
    zh: grab(/\*\*实体\*\*：(.+?)　→/),
    canonical: grab(/表里规定的语写法：`(.*?)`/),
    source: grab(/\*\*原文\*\*：(.+)/),
    translation: original,
    label: ['span', 'generic', 'missing', 'unsure'][ticks.findIndex(Boolean)] ?? 'none',
    goldSpan: grab(/^片段＝(.*)$/m),
  })
}

const all = [...labelledA, ...recordsB]
console.log(`人工标注：${all.length} 条（span=${all.filter(r => r.label === 'span').length}, generic=${all.filter(r => r.label === 'generic').length}）`)

// ── 臂 A：对齐器（读已有结果） ──────────────────────────────────────────────
const armA = new Map()
for (const row of alignA.rows) {
  const key = row.n + ':' + row.zh
  armA.set(key, row.align)
}
for (const item of alignB.items) {
  // 生产管线 = 对齐器 + trim：有裁切结果就用裁切后的，裁不出来（拒答）才退回原始片段
  armA.set('B' + item.n + ':' + item.zh, item.trimmedText !== '' ? item.trimmedText : item.alignerSpan)
}
function resultArmA(rec) {
  const key = rec.batch === 'A' ? rec.n + ':' + rec.zh : 'B' + rec.n + ':' + rec.zh
  return armA.get(key) ?? null
}

// ── 臂 C：纯字面相似度（基线） ──────────────────────────────────────────────
function resultArmC(rec) {
  const hay = words(rec.translation, false)
  const want = words(rec.canonical, true)
  if (want.length === 0) return null
  let best = { score: 0, text: null }
  for (let start = 0; start < hay.length; start += 1) {
    for (let len = Math.max(1, want.length - 2); len <= want.length + 3; len += 1) {
      if (start + len > hay.length) break
      const cand = hay.slice(start, start + len)
      const score = dice(cand.join(''), want.join(''))
      if (score > best.score + 1e-9) best = { score, text: cand.join(' ') }
    }
  }
  return best.score >= 0.5 ? best.text : null
}

// ── 臂 B：LLM 端到端 ───────────────────────────────────────────────────────
const { CANDIDATES, callModel, findKey } = await import(pathToFileURL(join(ROOT, 'scripts', 'bench-models.mjs')).href)
const candidate = CANDIDATES.find(item => item.key === 'qwen2.5-72b')
const key = findKey(candidate.apiKeyEnv)
if (key.value === '') { console.error('拿不到 API key：' + candidate.apiKeyEnv); process.exit(1) }

const PROMPT = (rec) => [
  '下面是一句中文，和它对应的葡语译文。请找出中文里的这个名称在葡语译文里对应的是哪一段文字。',
  '',
  '中文原文：' + rec.source,
  '葡语译文：' + rec.translation,
  '要找的中文名称：' + rec.zh,
  '该名称在表里规定的写法（参考）：' + rec.canonical,
  '',
  '要求：',
  '1. 原样抄写译文里实际出现的那段文字（不要改写成其他写法，不要加引号）；',
  '2. 如果译文里根本没有出现这个名称，或者被写成了"这家公司/这些眼镜"这类泛称，就只回答 NONE；',
  '3. 只输出那段文字或 NONE，不要解释。',
].join('\n')

const armB = new Map()
const CACHE_FILE = join(DIR, 'arm-llm-cache.json')
let cache = {}
try { cache = JSON.parse(await readFile(CACHE_FILE, 'utf-8')) } catch { /* 无缓存 */ }
for (let i = 0; i < all.length; i += 1) {
  const rec = all[i]
  const ck = `${rec.batch}:${rec.id}:${rec.n}:${rec.zh}`
  let text
  if (Object.hasOwn(cache, ck)) {
    text = cache[ck]
    console.log(`[${i + 1}/${all.length}] ${rec.id} ${rec.zh} -> ${text === null ? '(无)' : text}  (缓存)`)
  } else {
    const r = await callModel(candidate, '你是严谨的葡语-中文对照审校员。', PROMPT(rec), { temperature: 0, maxTokens: 60, timeoutMs: 60000 })
    text = r.ok === true ? String(r.text).trim() : null
    if (text !== null) {
      text = text.replace(/^['"“”`]+|['"“”`]+$/g, '').replace(/[。.；;，,]+$/g, '').trim()
      if (/^NONE\b/i.test(text)) text = null
      if (text !== null && words(text).length > 12) text = null   // 明显在写句子 → 当拒答
    }
    cache[ck] = text
    console.log(`[${i + 1}/${all.length}] ${rec.id} ${rec.zh} -> ${text === null ? '(无)' : text}`)
    await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2) + '\n', 'utf-8')
    await new Promise(resolve => setTimeout(resolve, 120))
  }
  armB.set(i, text)
}

// ── 汇总 ───────────────────────────────────────────────────────────────────
function summarize(name, judgeFn) {
  const spans = all.filter(r => r.label === 'span')
  const generic = all.filter(r => r.label === 'generic')
  let hit = 0, wrong = 0, miss = 0, full = 0
  const rows = []
  for (const rec of spans) {
    const S = judgeFn(rec)
    const v = judge(S, rec.goldSpan)
    if (v === 'hit') {
      hit += 1
      // 片段是否"完整可直接用"：words 序列完全一致（容错打字/同义）
      const s = words(S), g = words(rec.goldSpan)
      if (s.length === g.length && s.every((w, k) => tokenEq(w, g[k]))) full += 1
    } else if (v === 'wrong') wrong += 1
    else miss += 1
    rows.push({ id: rec.id, zh: rec.zh, gold: rec.goldSpan, ret: S, verdict: v })
  }
  let genCorrect = 0
  for (const rec of generic) {
    const S = judgeFn(rec)
    if (S === null) genCorrect += 1
    rows.push({ id: rec.id, zh: rec.zh, gold: '(泛称)', ret: S, verdict: S === null ? 'correct-refuse' : 'wrong-span' })
  }
  const total = spans.length + generic.length
  const usable = hit + genCorrect
  return {
    name, rows,
    spanHit: hit, spanWrong: wrong, spanMiss: miss, spanFull: full, spanTotal: spans.length,
    genCorrect, genTotal: generic.length,
    usable, total,
    line: `${name}：定位 ${hit}/${spans.length}（其中片段完整可用 ${full}），错位 ${wrong}，未命中 ${miss}；泛称正确拒答 ${genCorrect}/${generic.length}；可判定正确 ${usable}/${total} = ${((usable / total) * 100).toFixed(1)}%`,
  }
}
const arms = [
  summarize('对齐器(awesome-align+trim)', resultArmA),
  summarize('LLM(Qwen2.5-72b 端到端)', rec => armB.get(all.indexOf(rec))),
  summarize('字面相似度(基线)', resultArmC),
]
for (const arm of arms) console.log('\n' + arm.line)
for (const arm of arms) {
  for (const r of arm.rows) {
    console.log(`  ${arm.name.slice(0, 6)} ${r.id} ${r.zh} | 人工=${r.gold} | 返回=${r.ret ?? '(无)'} | ${r.verdict}`)
  }
}
const out = {
  generatedAt: new Date().toISOString(),
  arms: arms.map(a => ({ name: a.name, spanHit: a.spanHit, spanWrong: a.spanWrong, spanMiss: a.spanMiss, spanTotal: a.spanTotal, genCorrect: a.genCorrect, genTotal: a.genTotal, usable: a.usable, total: a.total })),
  items: arms.map(a => ({ name: a.name, rows: a.rows })),
}
await mkdir(join(DIR, 'results'), { recursive: true })
await writeFile(join(DIR, 'arm-comparison.json'), JSON.stringify(out, null, 2) + '\n', 'utf-8')
console.log('\n已写出：' + join(DIR, 'arm-comparison.json'))
