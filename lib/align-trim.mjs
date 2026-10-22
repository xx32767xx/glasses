/**
 * align-trim.mjs —— 把词对齐给出的"片段"裁成**能直接用于替换**的那一段
 * ============================================================================
 *
 * 为什么需要它（这是实测逼出来的，不是预先设计的）：
 * 词对齐器（awesome-align / mBERT）给出的片段**边界不准**。在 18 句串台测试里，
 * 46 次给了片段的情况下有 41% 边界不对，两类最危险：
 *
 *   · **吞掉整句**：`小米 ↔ Xiaomi e a Lenovo têm centros de pesquisa e …`（长了 17 倍）
 *     —— 直接拿去替换会把整句毁掉；
 *   · **只取第一个词**：`Mate 60 Pro ↔ Mate`、`麒麟 9000s ↔ Kirin`、`骁龙 8 Gen 3 ↔ Snapdragon`
 *     —— 换掉之后只剩半个型号名。
 *
 * 所以这里做四件事，顺序不能乱：
 *   ① **剥掉两端的虚词**（冠词/前置词/连词）—— 片段只能从实词开始、到实词结束；
 *   ② **向后/向前补齐**多词规范写法（`Kirin` → `Kirin 9000s`）—— 只补"与规范写法
 *      下一个词相同"的 token，**不补相邻的别的名字**（这是防串台的关键）；
 *   ③ **过宽就按相似度裁窗口**（长度上限 = max(规范写法词数×2, 4)）；
 *   ④ **裁完仍然不像就拒答**（返回 null）—— 宁可说"我不知道"，也不给一个会毁句子的片段。
 *
 * ⚠️ 一条重要边界：**它不判断语义**。它只保证"这一段是连续的实词、长度合理、
 * 与规范写法形状相似"。是不是真的对应，仍然靠对齐器的分数和（最终）人工抽检。
 */

/** 葡语虚词：片段不该以它们开头或结尾。 */
const FUNCTION_WORDS = new Set([
  'o', 'a', 'os', 'as', 'um', 'uma', 'uns', 'umas',
  'de', 'da', 'do', 'das', 'dos', 'em', 'no', 'na', 'nos', 'nas',
  'ao', 'aos', 'à', 'às', 'pelo', 'pela', 'pelos', 'pelas',
  'e', 'ou', 'que', 'com', 'para', 'por', 'se', 'como', 'mas', 'não',
])

/** 把 token 归一：小写、去掉首尾标点。 */
export function normalizeToken(token) {
  return String(token).toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
}

/** 规范写法 → 词序列（同样归一）。 */
export function canonicalWords(canonical) {
  return String(canonical)
    .split(/\s+/)
    .map(normalizeToken)
    .filter(word => word !== '')
}

const isFunctionWord = token => FUNCTION_WORDS.has(normalizeToken(token))
const isPunct = token => /^[^\p{L}\p{N}]+$/u.test(token)

/** 字符级相似度（Dice 系数）：只看形状，不判语义。 */
export function shapeSimilarity(spanTokens, canonical) {
  const left = normalizeToken(spanTokens.join('')).replace(/\s+/g, '')
  const right = canonicalWords(canonical).join('')
  if (left === '' || right === '') return 0
  const leftBigrams = new Map()
  for (let index = 0; index < left.length - 1; index += 1) {
    const gram = left.slice(index, index + 2)
    leftBigrams.set(gram, (leftBigrams.get(gram) ?? 0) + 1)
  }
  let shared = 0
  let rightCount = 0
  for (let index = 0; index < right.length - 1; index += 1) {
    const gram = right.slice(index, index + 2)
    rightCount += 1
    const available = leftBigrams.get(gram) ?? 0
    if (available > 0) {
      shared += 1
      leftBigrams.set(gram, available - 1)
    }
  }
  if (rightCount === 0) return 0
  const total = (left.length - 1) + rightCount
  return total === 0 ? 0 : (2 * shared) / total
}

/**
 * 把对齐器给的区间裁成可用片段。
 *
 * @param {object} input
 * @param {string[]} input.tokens 译文的 token 序列
 * @param {number} input.start 对齐器给出的起始 token 下标
 * @param {number} input.end 结束下标（含）
 * @param {string} input.canonical 规范写法
 * @returns {{ start: number, end: number, text: string, verdict: string } | null}
 *   `null` = 拒答（裁不出像样的片段，宁可不替换）
 */
export function trimSpan(input) {
  const tokens = input.tokens ?? []
  const canonical = input.canonical ?? ''
  const want = canonicalWords(canonical)
  if (tokens.length === 0 || want.length === 0) return null

  let start = Math.max(0, Math.min(input.start, tokens.length - 1))
  let end = Math.max(start, Math.min(input.end, tokens.length - 1))

  // ── ① 两端剥掉虚词与标点 ────────────────────────────────────────────────
  while (start < end && (isFunctionWord(tokens[start]) || isPunct(tokens[start]))) start += 1
  while (end > start && (isFunctionWord(tokens[end]) || isPunct(tokens[end]))) end -= 1
  if (isFunctionWord(tokens[start]) || isPunct(tokens[start])) return null
  if (isFunctionWord(tokens[end]) || isPunct(tokens[end])) return null

  // ── ② 补齐多词规范写法：只补"等于规范写法相邻词"的 token ─────────────────
  //    为什么"只补相邻词"：`Musk` 前面是 `Zhang Yiming`，那不是规范写法的一部分，
  //    补进来就等于把别人的名字吞进来（串台的另一种形态）。
  let guard = 0
  while (end - start + 1 < want.length && end + 1 < tokens.length && guard < 8) {
    guard += 1
    const nextExpected = want[end - start + 1]
    if (nextExpected !== undefined && normalizeToken(tokens[end + 1]) === nextExpected) {
      end += 1
      continue
    }
    // 规范写法里是数字/字母型号时，允许 token 是纯数字或字母数字组合（`9000s`、`8`、`60`）
    const token = normalizeToken(tokens[end + 1])
    if (nextExpected !== undefined && /^[0-9]/.test(nextExpected) && /^[0-9]/.test(token)) {
      end += 1
      continue
    }
    break
  }
  guard = 0
  while (end - start + 1 < want.length && start - 1 >= 0 && guard < 8) {
    guard += 1
    const prevExpected = want[want.length - 1 - (end - start)]
    if (prevExpected !== undefined && normalizeToken(tokens[start - 1]) === prevExpected) {
      start -= 1
      continue
    }
    break
  }

  // ── ③ 过宽就裁：在窗口里找"最长不超过上限、与规范写法最像"的连续段 ────────
  //    不只在"超过上限"时才裁 —— 因为 `CATL e a SMIC` 这种长度没超（4 个 token），
  //    但显然夹带了隔壁实体。所以**总是**算一遍最佳窗口，只有明显更像我采用它。
  const cap = Math.max(want.length * 2, 4)
  const full = { start, end, score: shapeSimilarity(tokens.slice(start, end + 1), canonical) }
  let best = full
  let candidate = null
  for (let from = start; from <= end; from += 1) {
    for (let to = from; to <= Math.min(end, from + cap - 1); to += 1) {
      // 片段不得以虚词或标点开头/结尾
      if (isFunctionWord(tokens[from]) || isPunct(tokens[from])) continue
      if (isFunctionWord(tokens[to]) || isPunct(tokens[to])) continue
      const score = shapeSimilarity(tokens.slice(from, to + 1), canonical)
      const shorter = candidate === null ? true : (to - from) < (candidate.end - candidate.start)
      if (candidate === null || score > candidate.score + 1e-9
        || (Math.abs(score - candidate.score) <= 1e-9 && shorter)) {
        candidate = { start: from, end: to, score }
      }
    }
  }
  // 窗口明显更像才换（0.02 的余量避免抖动）；否则保留完整片段
  if (candidate !== null && candidate.score > full.score + 0.02) best = candidate

  // ── ④ 裁完还不像 → 拒答 ────────────────────────────────────────────────
  //    阈值 0.34 是"至少要有三分之一的形状重合"：低于这个，说明模型写的可能是
  //    描述性短语（例如 `工信部 → Ministério da Indústria e Informação`），
  //    这种情况不该拿一个片段去替换，而该判成"泛化"。
  if (best.score < 0.34) return null

  return {
    start: best.start,
    end: best.end,
    text: tokens.slice(best.start, best.end + 1).join(' '),
    verdict: 'trimmed',
    score: Number(best.score.toFixed(3)),
  }
}
