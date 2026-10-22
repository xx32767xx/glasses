/**
 * discover-variants.mjs —— 离线候选变体发现（把"模型把名字写成了什么"挖出来）
 * ============================================================================
 *
 * 背景（docs/15 §15.5 的对照实验）：在 24 条人工标注上，LLM 端到端定位比
 * 词对齐器更好（20/22 vs 18/22），而且 Qwen 本来就在链路里 —— 所以"发现候选
 * 变体"这件事交给它，对齐器只留在实验记录里。
 *
 * 它做什么、不做什么：
 *   · 只读历史译文（{source, translation} 的 JSONL）和当前热词表；
 *   · 对"原文提到了表内名字、但译文里没出现规范写法"的每一对，问一次模型
 *     "这个名字在译文里实际写成了什么"；
 *   · 产出**候选清单**（JSON + 可勾选的 Markdown），**不自动入表** ——
 *     必须由人勾选"采用"后才写进表（`--apply`）。
 *
 * 它**不进产线**：不参与字幕链路、不调模型替换、不新增接口；唯一的作用是
 * "把填表的变体从猜变成挖"，失败最多是少一条建议。（docs/15 §15.7）
 *
 * 用法：
 *   node scripts/discover-variants.mjs --input history.jsonl [--user test] [--limit 100]
 *   node scripts/discover-variants.mjs --apply var/discover/candidates-*.md [--user test]
 *
 * 输入 JSONL：每行至少 `{ "source": "中文原句", "translation": "葡语译文" }`
 * （多余字段忽略；`id` 可选，只用来在清单里标出处）。
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

import { LIVE_DIR, DISCOVER_DIR } from '../lib/paths.mjs'
import {
  loadTerms, saveTerms, putTable, getTable, validateTerms, normalizeUser, loadActiveUser,
} from '../lib/terms.mjs'
import { foldForMatch } from '../lib/terms-matcher.mjs'
import { CANDIDATES, callModel, findKey } from './bench-models.mjs'

// ── 基础工具 ────────────────────────────────────────────────────────────────

/** 折叠 + 去空格：`Leion Pro` 与 `LeionPro` 视为同一个串（只用于"找得到"的判断）。 */
export function foldCompact(text) {
  return foldForMatch(String(text)).replace(/\s+/g, '')
}

/** 句子像是中文还是葡语（粗判：有汉字就是中文）。只用于选提示词方向。 */
export function detectLangLite(text) {
  return /[\u4e00-\u9fff]/.test(String(text)) ? 'zh' : 'pt'
}

const NOTHING = /^NONE$/i
const CJK = /[\u4e00-\u9fff]/

/** 把模型的一句回答洗成"片段或 null"。 */
export function parseAnswer(raw) {
  if (typeof raw !== 'string') return null
  let text = raw.trim()
  // 反复剥引号与句末标点（模型常写「“LLVision”。」这类混合形态）
  for (let pass = 0; pass < 4; pass += 1) {
    const before = text
    text = text
      .replace(/^['"“”`「『（(]+/, '')
      .replace(/[。.；;，,、!?！？]+$/, '')
      .replace(/['"“”`」』）)]+$/, '')
      .trim()
    if (text === before) break
  }
  if (text === '' || NOTHING.test(text)) return null
  return text
}

/** 模型回答与译文是否"对得上"：在折叠+去空格的译文里能原样找到（防模型编造）。 */
export function isVerbatim(candidate, translation) {
  const hay = foldCompact(translation)
  const needle = foldCompact(candidate)
  return needle !== '' && hay.includes(needle)
}

/** 候选是否"像句子"（模型没按要求只给片段）—— 标记出来供人判断，不直接丢。 */
export function looksLikeSentence(candidate) {
  return String(candidate).trim().split(/\s+/).filter(Boolean).length > 8
}

const SYSTEM = '你是严谨的葡语-中文对照审校员。'

/** 构造"定位候选"提示词（翻译方向决定问法）。 */
export function buildPrompt({ zh, canonical, source, translation, translationLang }) {
  if (translationLang === 'pt') {
    return [
      '下面是一句中文和它的葡语译文。请找出中文里的名称「' + zh + '」在葡语译文里实际写成了什么。',
      '',
      '中文原文：' + source,
      '葡语译文：' + translation,
      '该名称在表里规定的写法（参考）：' + canonical,
      '',
      '要求：',
      '1. 原样抄写译文里实际出现的那段文字（不要改写成规范写法，不要加引号）；',
      '2. 如果译文里没有出现这个名称，或写成了"这家公司/这些眼镜"这类泛称，只回答 NONE；',
      '3. 只输出那段文字或 NONE，不要解释。',
    ].join('\n')
  }
  return [
    '下面是一句葡语和它的中文译文。请找出葡语里的名称「' + zh + '」在中文译文里实际写成了什么。',
    '',
    '葡语原文：' + source,
    '中文译文：' + translation,
    '该名称在表里规定的写法（参考）：' + canonical,
    '',
    '要求：',
    '1. 原样抄写译文里实际出现的那段文字（不要改写成规范写法，不要加引号）；',
    '2. 如果译文里没有出现这个名称，或写成了"这家公司/这些副眼镜"这类泛称，只回答 NONE；',
    '3. 只输出那段文字或 NONE，不要解释。',
  ].join('\n')
}

// ── 读输入 / 表 ─────────────────────────────────────────────────────────────

/**
 * 从产线日志（`var/live/terms.jsonl`）里抽"热词观测"记录当作发现输入。
 *
 * <p>这是 A 方案（产线自动记录）与离线发现的接缝：同传时电脑侧发现"提到了名字、
 * 但译文没写出规范写法"就记一条 `watch` 事件（带完整原文+译文）；之后跑这个工具
 * 时把这份日志喂进来，就能问模型"它到底写成了什么"。
 *
 * @returns {{ id, source, translation, translationLang }[]} 按 (原文, 译文) 去重
 */
export function pairsFromWatch(text) {
  const pairs = new Map()
  for (const line of String(text).split(/\r?\n/)) {
    if (line.trim() === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event === null || typeof event !== 'object' || event.event !== 'watch') continue
    const source = typeof event.source === 'string' ? event.source.trim() : ''
    const translation = typeof event.translation === 'string' ? event.translation.trim() : ''
    if (source === '' || translation === '') continue
    const key = source + '\u0000' + translation
    if (pairs.has(key)) continue
    pairs.set(key, { id: 'watch', source, translation, translationLang: detectLangLite(translation) })
  }
  return [...pairs.values()]
}

/** 读 JSONL 历史译文；容忍空行与坏行（坏行计入 skipped，不中断）。 */
export async function readHistory(file) {
  const text = await readFile(file, 'utf-8')
  const pairs = []
  let bad = 0
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      bad += 1
      continue
    }
    const source = typeof parsed?.source === 'string' ? parsed.source.trim() : ''
    const translation = typeof parsed?.translation === 'string' ? parsed.translation.trim() : ''
    if (source === '' || translation === '') {
      bad += 1
      continue
    }
    pairs.push({
      id: typeof parsed?.id === 'string' ? parsed.id : '',
      source,
      translation,
      translationLang: detectLangLite(translation),
    })
  }
  return { pairs, bad }
}

/** 原子写一个**指定的**表文件（`--table` 给了自定义路径时用，避免误写 var/live）。 */
async function writeDocFile(file, doc) {
  await mkdir(dirname(file), { recursive: true })
  const temp = file + '.tmp'
  await writeFile(temp, JSON.stringify(doc, null, 2) + '\n', 'utf-8')
  await rename(temp, file)
}

/** 读表文件（不存在 → 空文档，与产线"没表=功能关闭"一致）。 */
export async function readDoc(file) {
  let text
  try {
    text = await readFile(file, 'utf-8')
  } catch {
    return { version: 1, updatedAt: null, tables: {} }
  }
  try {
    const parsed = JSON.parse(text)
    const tables = parsed?.tables
    if (tables !== null && typeof tables === 'object' && Array.isArray(tables) === false) {
      return { version: 1, updatedAt: parsed.updatedAt ?? null, tables }
    }
  } catch { /* 坏文件按空表处理 */ }
  return { version: 1, updatedAt: null, tables: {} }
}

// ── 候选清单（Markdown）的生成与解析 ────────────────────────────────────────

/**
 * 生成可勾选的候选清单。格式刻意和"标注清单"一致：
 * 一题一段、勾选 + 来源句子，方便人快速过一遍。
 */
export function renderSheet(candidates, { user, model, input, at }) {
  const lines = []
  lines.push('# 热词候选清单（离线发现）')
  lines.push('')
  lines.push('> 输入：`' + input + '` · 表：用户 `' + user + '` · 模型：`' + model + '` · 生成时间：' + at)
  lines.push('> 共 ' + candidates.length + ' 个候选。**不会自动入表** —— 把要收的勾成 `[x] 采用`，')
  lines.push('> 然后运行下面这条命令（同一份文件）：')
  lines.push('>')
  lines.push('> ```bash')
  lines.push('> node scripts/discover-variants.mjs --apply <本文件> --user ' + user)
  lines.push('> ```')
  lines.push('')
  lines.push('| 字段 | 意思 |')
  lines.push('|---|---|')
  lines.push('| `wrong` | 已知的错误写法（默认）—— 命中后替换成规范写法 |')
  lines.push('| `approved` | 认可的替代写法（写法本身没问题，只是统一成规范写法） |')
  lines.push('')
  lines.push('---')
  lines.push('')
  candidates.forEach((item, index) => {
    const n = String(index + 1).padStart(2, '0')
    lines.push('## c' + n)
    lines.push('')
    lines.push('**中文**：' + item.zh + ' 　→　**规范**：' + item.canonical)
    lines.push('')
    lines.push('**译文片段**：' + item.candidate)
    lines.push('')
    lines.push('**建议字段**：' + item.field + '　' + (item.suspect ? '（⚠️ 片段在译文里找不到原样，或像整句，请特别核对）' : ''))
    lines.push('')
    if (item.sample !== null && item.sample !== undefined) {
      lines.push('**样例**：' + item.sample.source + ' → ' + item.sample.translation)
      lines.push('')
    }
    if (item.count > 1) {
      lines.push('（这个写法一共出现 ' + item.count + ' 次）')
      lines.push('')
    }
    lines.push('采用：[ ] 是   [ ] 否')
    lines.push('')
    lines.push('---')
    lines.push('')
  })
  return lines.join('\n')
}

/**
 * 解析人工勾选后的清单。返回 `{ accepted, skipped }`：
 * 只收"采用"被勾上的；没勾或勾"否"的进 skipped（用于汇报）。
 */
export function parseReviewSheet(md) {
  const accepted = []
  const skipped = []
  const blocks = md.split(/\n---\n/)
  for (const block of blocks) {
    const head = block.match(/^## (c\d+)/m)
    if (!head) continue
    const id = head[1]
    const grab = re => (block.match(re) ?? [, ''])[1].trim()
    const zh = grab(/\*\*中文\*\*：(.+?)\s*→\s*\*\*规范\*\*：/)
    const canonical = grab(/\*\*中文\*\*：.+?→\s*\*\*规范\*\*：(.*)$/m)
    const candidate = grab(/\*\*译文片段\*\*：(.*)$/m)
    const fieldLine = grab(/\*\*建议字段\*\*：(wrong|approved|variants)/)
    const tickLine = grab(/^采用：(.*)$/m)
    const ticked = /\[\s*x\s*\]/i.test(tickLine)
    if (zh === '' || candidate === '') continue
    if (ticked) {
      accepted.push({ id, zh, canonical, candidate, field: fieldLine === '' ? 'wrong' : fieldLine })
    } else {
      skipped.push({ id, zh, candidate })
    }
  }
  return { accepted, skipped }
}

// ── 合并候选（纯函数；不动原数组，返回新表）────────────────────────────────

export const MERGE_FIELDS = ['wrong', 'approved', 'variants']

/**
 * 把"采用的候选"并进表。**纯函数**：返回新的 entries 数组与逐条说明。
 *
 * 规则（与产线一致）：
 *   · 未在表中找到的中文名 → 跳过（用户可能删了那条）；
 *   · 与规范写法折叠后相同 → 跳过（折叠已经能处理，不用登记）；
 *   · 已经在任一列表里 → 跳过（去重）；
 *   · 其余追加到指定字段（默认 `wrong`）。
 *
 * @returns {{ entries: object[], added: object[], skipped: object[] }}
 */
export function mergeCandidates(entries, accepted) {
  const next = entries.map(entry => ({ ...entry, wrong: [...(entry.wrong ?? [])], approved: [...(entry.approved ?? [])], variants: [...(entry.variants ?? [])] }))
  const added = []
  const skipped = []
  for (const item of accepted) {
    const entry = next.find(candidate => candidate.zh === item.zh)
    const field = MERGE_FIELDS.includes(item.field) ? item.field : 'wrong'
    if (entry === undefined) {
      skipped.push({ ...item, reason: '表里没有「' + item.zh + '」这个中文名（可能已删除或改名）' })
      continue
    }
    const canonical = item.field === 'variants' ? entry.zh : entry.pt
    if (foldCompact(item.candidate) === foldCompact(canonical)) {
      skipped.push({ ...item, reason: '与规范写法折叠后相同（折叠已经覆盖，不需要登记）' })
      continue
    }
    const exists = ['wrong', 'approved', 'variants'].some(key =>
      (entry[key] ?? []).some(form => foldCompact(form) === foldCompact(item.candidate)))
    if (exists) {
      skipped.push({ ...item, reason: '这个写法已经登记过' })
      continue
    }
    entry[field].push(item.candidate)
    added.push({ id: item.id, zh: item.zh, candidate: item.candidate, field })
  }
  return { entries: next, added, skipped }
}

// ── 发现流程 ────────────────────────────────────────────────────────────────

const CACHE_PATH = join(DISCOVER_DIR, 'llm-cache.json')
const cacheKey = (model, pair, zh) => [model, pair.source, pair.translation, zh].join('\u0000')

async function loadCache() {
  try {
    return JSON.parse(await readFile(CACHE_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

async function saveCache(cache) {
  await mkdir(DISCOVER_DIR, { recursive: true })
  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2) + '\n', 'utf-8')
}

/** 解析 `--user`：缺省取"当前会话用户"，都取不到就 `default`。 */
async function resolveUser(args) {
  if (args.user !== undefined && args.user !== '' && args.user !== true) {
    const checked = normalizeUser(String(args.user))
    if (checked.ok !== true) throw new Error(checked.error)
    return checked.user
  }
  return (await loadActiveUser(LIVE_DIR)) ?? 'default'
}
/** 表里那条条目在"译文是哪种语言"时该看哪些写法（方向不符就跳过）。 */
function candidatesFor(entry, translationLang) {
  if (entry.direction === 'zh-to-pt' && translationLang !== 'pt') return null
  if (entry.direction === 'pt-to-zh' && translationLang !== 'zh') return null
  const canonical = translationLang === 'pt' ? entry.pt : entry.zh
  return { canonical }
}

/** 原文里是否提到了这个条目（同侧写法；只用来预筛，不负责边界）。 */
function mentionedInSource(entry, pair) {
  const sourceLang = detectLangLite(pair.source)
  const forms = sourceLang === 'zh' ? [entry.zh, ...(entry.variants ?? [])] : [entry.pt, ...(entry.approved ?? [])]
  const hay = foldCompact(pair.source)
  return forms.some(form => {
    const needle = foldCompact(form)
    return needle !== '' && hay.includes(needle)
  })
}

async function discover(args) {
  const inputPath = args.input
  // 输入有两种：历史译文 JSONL（--input），或产线「热词观测」日志（--from-watch）。
  // 后者是 A 方案的接缝：同传里自动记下的"提到了但没写对"的句子直接拿来问模型。
  const { pairs, bad } = args['from-watch'] !== undefined
    ? { pairs: pairsFromWatch(await readFile(String(args['from-watch']), 'utf-8')), bad: 0 }
    : await readHistory(inputPath)
  const limit = args.limit === undefined ? pairs.length : Math.max(1, Number(args.limit))
  const used = pairs.slice(0, limit)
  const inputLabel = args['from-watch'] !== undefined ? String(args['from-watch']) : String(inputPath)

  const liveDoc = await loadTerms(LIVE_DIR)
  const doc = args.table === undefined ? liveDoc : await readDoc(args.table)
  const user = await resolveUser(args)
  const entries = getTable(doc, user).entries
  if (entries.length === 0) {
    console.log('热词表是空的（用户 ' + user + '）：没有可用来对照的名字。先填表再跑，或指定 --table/--user。')
    process.exitCode = 1
    return
  }

  const modelKey = args.model === undefined ? 'qwen2.5-72b' : args.model
  const candidate = CANDIDATES.find(item => item.key === modelKey)
  if (candidate === undefined) {
    console.error('不认识模型：' + modelKey + '（可选：' + CANDIDATES.map(item => item.key).join(' / ') + '）')
    process.exitCode = 1
    return
  }
  const key = findKey(candidate.apiKeyEnv)
  if (key.value === '') {
    console.error('拿不到 API key：' + candidate.apiKeyEnv + '（环境变量 / ~/.dsh/.credentials.yaml / .env）')
    process.exitCode = 1
    return
  }

  const cache = await loadCache()
  const found = new Map()   // `${zh}\u0000${foldCompact(candidate)}` → item
  const stats = { pairs: used.length, asked: 0, skippedCanonical: 0, empty: 0, bad }
  let index = 0
  for (const pair of used) {
    index += 1
    for (const entry of entries) {
      const view = candidatesFor(entry, pair.translationLang)
      if (view === null) continue
      if (mentionedInSource(entry, pair) === false) continue
      // 译文里已经有规范写法 → 没有候选可发现
      if (foldCompact(pair.translation).includes(foldCompact(view.canonical))) {
        stats.skippedCanonical += 1
        continue
      }
      stats.asked += 1
      const ck = cacheKey(candidate.key, pair, entry.zh)
      let answer
      if (Object.hasOwn(cache, ck)) {
        answer = cache[ck]
        console.log('[' + index + '/' + used.length + '] ' + entry.zh + '（缓存）→ ' + (answer === null ? 'NONE' : answer))
      } else {
        const prompt = buildPrompt({
          zh: entry.zh, canonical: view.canonical, source: pair.source,
          translation: pair.translation, translationLang: pair.translationLang,
        })
        const result = await callModel(candidate, SYSTEM, prompt, { temperature: 0, maxTokens: 60, timeoutMs: 60000 })
        if (result.ok !== true) {
          stats.bad += 1
          console.log('[' + index + '/' + used.length + '] ' + entry.zh + '（请求失败，跳过）：' + result.failure)
          continue
        }
        answer = parseAnswer(result.text)
        cache[ck] = answer
        await saveCache(cache)
        console.log('[' + index + '/' + used.length + '] ' + entry.zh + ' → ' + (answer === null ? 'NONE' : answer))
        await new Promise(resolve => setTimeout(resolve, 120))
      }
      if (answer === null) {
        stats.empty += 1
        continue
      }
      // 片段与规范写法折叠后相同 → 不用登记
      if (foldCompact(answer) === foldCompact(view.canonical)) continue
      const mapKey = entry.zh + '\u0000' + foldCompact(answer)
      if (found.has(mapKey)) {
        const item = found.get(mapKey)
        item.count += 1
        if (item.sample === null) item.sample = { source: pair.source, translation: pair.translation }
        continue
      }
      found.set(mapKey, {
        zh: entry.zh,
        canonical: view.canonical,
        candidate: answer,
        field: 'wrong',
        suspect: isVerbatim(answer, pair.translation) === false || looksLikeSentence(answer) || CJK.test(answer) || answer.length > 60,
        count: 1,
        sample: { source: pair.source, translation: pair.translation },
      })
    }
  }

  const candidates = [...found.values()]
  await mkdir(DISCOVER_DIR, { recursive: true })
  const at = new Date().toISOString()
  const stamp = at.replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
  const mdPath = join(DISCOVER_DIR, 'candidates-' + stamp + '.md')
  const jsonPath = join(DISCOVER_DIR, 'candidates-' + stamp + '.json')
  await writeFile(mdPath, renderSheet(candidates, { user, model: candidate.key, input: inputLabel, at }) + '\n', 'utf-8')
  await writeFile(jsonPath, JSON.stringify({
    at, user, model: candidate.key, input: inputLabel, stats,
    candidates,
  }, null, 2) + '\n', 'utf-8')

  console.log('')
  console.log('扫描 ' + stats.pairs + ' 句（坏行 ' + stats.bad + '），问模型 ' + stats.asked + ' 次，'
    + '其中译文已含规范写法跳过 ' + stats.skippedCanonical + ' 次，答 NONE ' + stats.empty + ' 次。')
  console.log('发现 ' + candidates.length + ' 个候选：')
  for (const item of candidates) {
    console.log('  ' + item.zh + ' → ' + item.candidate + (item.suspect ? '（⚠️ 可疑，请核对）' : '') + (item.count > 1 ? ' ×' + item.count : ''))
  }
  if (candidates.length > 0) {
    console.log('')
    console.log('勾选用：' + mdPath)
    console.log('入表用：node scripts/discover-variants.mjs --apply "' + mdPath + '" --user ' + user)
  }
}

async function apply(args) {
  const source = args.apply
  const md = await readFile(source, 'utf-8')
  const { accepted, skipped } = parseReviewSheet(md)
  if (accepted.length === 0) {
    console.log('清单里没有被勾成 [x] 采用 的候选，什么都没写。')
    return
  }
  const doc = args.table === undefined ? await loadTerms(LIVE_DIR) : await readDoc(args.table)
  const user = await resolveUser(args)
  const original = getTable(doc, user).entries

  // 逐个候选"加进去再校验"：一个候选把表弄脏（别名冲突等）就退回它，其余照常。
  const commit = []
  const rejected = []
  let current = original
  for (const item of accepted) {
    const attempt = mergeCandidates(current, [item])
    if (attempt.skipped.length > 0) {
      rejected.push({ ...item, reason: attempt.skipped[0].reason })
      continue
    }
    const checked = validateTerms(attempt.entries)
    if (checked.ok === true) {
      current = attempt.entries
      commit.push(attempt.added[0])
    } else {
      rejected.push({ ...item, reason: checked.rejected.map(r => r.code + '：' + r.reason).join('；') })
    }
  }

  if (commit.length === 0) {
    // 全部候选都"不该写"（已登记/已删/与规范写法相同）不是错误，是正常结果
    console.log('没有新增候选入表。')
    for (const item of rejected) console.log('  ✗ ' + item.zh + ' → ' + item.candidate + '：' + item.reason)
    return
  }
  const checked = validateTerms(current)
  if (checked.ok !== true) {
    console.error('合并后表不合法，拒绝写入：')
    for (const item of checked.rejected) console.error('  第 ' + (item.index + 1) + ' 条 ' + item.code + '：' + item.reason)
    process.exitCode = 1
    return
  }
  const put = putTable(doc, user, checked.entries)
  if (args.table === undefined) {
    await saveTerms(LIVE_DIR, put.doc)
  } else {
    await writeDocFile(String(args.table), put.doc)
  }
  const where = args.table === undefined ? 'var/live/terms.json' : String(args.table)
  console.log('已写入 ' + where + '（用户 ' + user + '）：')
  for (const item of commit) console.log('  ✓ ' + item.zh + ' → ' + item.candidate + '（' + item.field + '）')
  if (skipped.length > 0) {
    console.log('清单里 ' + skipped.length + ' 条没勾"采用"，未写入。')
  }
  if (rejected.length > 0) {
    console.log('未写入：')
    for (const item of rejected) console.log('  ✗ ' + item.zh + ' → ' + item.candidate + '：' + item.reason)
  }
  const active = await loadActiveUser(LIVE_DIR)
  if (active !== null && active !== user) {
    console.log('注意：当前会话用的是「' + active + '」，本次写的是「' + user + '」。')
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') { out.help = true; continue }
    if (arg.startsWith('--') === false) continue
    const name = arg.slice(2)
    const value = argv[index + 1] !== undefined && argv[index + 1].startsWith('--') === false
      ? argv[index + 1] : undefined
    if (value === undefined) {
      out[name] = true
    } else {
      out[name] = value
      index += 1
    }
  }
  return out
}

const USAGE = [
  '用法：',
  '  node scripts/discover-variants.mjs --input <history.jsonl> [--user <名字>] [--limit N] [--model key] [--table <terms.json>]',
  '  node scripts/discover-variants.mjs --from-watch var/live/terms.jsonl [--user <名字>] [--limit N]',
  '  node scripts/discover-variants.mjs --apply <candidates-*.md> [--user <名字>] [--table <terms.json>]',
  '',
  '输入 JSONL 每行至少包含 source（原文）与 translation（译文）。',
  '--from-watch 直接吃同传时产线自动记下的「热词观测」日志（terms.jsonl 里的 watch 事件）。',
  '发现模式只产出候选清单（var/discover/candidates-*.md），不改表；',
  'apply 模式只把清单里勾成 [x] 采用 的候选写进表。',
].join('\n')

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help === true) {
    console.log(USAGE)
    return
  }
  if (args.input !== undefined || args['from-watch'] !== undefined) {
    await discover({ ...args, input: args.input === undefined ? undefined : String(args.input) })
    return
  }
  if (args.apply !== undefined) {
    await apply({ ...args, apply: String(args.apply) })
    return
  }
  console.log(USAGE)
  process.exitCode = 1
}

// 只有"直接被 node 执行"时才跑 CLI —— 否则被测试 import 时会误执行 main、
// 把用法打出来并污染退出码（这个坑是我在接套件时踩到的）。
const executedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href
if (executedDirectly) await main()
