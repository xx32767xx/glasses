/**
 * terms-matcher.mjs —— 热词对照表的**匹配器**（纯函数：不调模型、不读写文件、无状态）
 * ============================================================================
 *
 * 它只做一件事（docs/15 §7.1）：
 *
 *     译文里出现某个**已知变体** → 换成用户指定的规范写法
 *
 * ⚠️ **没有出现就什么都不做**。本期不做"缺失重译"（那是后续独立实验）——
 * 这一点决定了本文件的复杂度上限：它永远不会调用模型，也永远不会新增/删除整句内容。
 *
 * 为什么单独一个文件、而且坚持纯函数：
 *   · 这是全功能里唯一"能改字幕文字"的地方，必须能被**穷举测试**；
 *   · 纯函数意味着同样的输入永远同样输出 —— 才谈得上"可复现"（老师的要求）。
 *
 * 规则来源：docs/15 §5（匹配规则）。四件事都不能省：
 *   ① **实体重叠**：被更长匹配完全覆盖的短匹配一律丢弃（`Leion` 在 `Leion Pro` 里
 *      有空格边界，普通整词规则会命中它 —— "最长优先"只在同一位置生效，盖不住这个）；
 *   ② **中文边界 R1/R2**：中文没有词边界，`高通` 会命中 `高通量`。2 字条目强制走
 *      保守的上下文抑制（封闭虚词集合），跳过的记 `boundary_skip`；
 *   ③ **折叠**：大小写/重音/空格折叠，条目可单独关掉（`fold: false`）；
 *   ④ **幂等**：一次扫描内完成替换，结果再喂一遍不会再变。
 */

/**
 * 中文边界的"危险邻居"：**和常见的两字名字拼起来会变成另一个词**的字。
 *
 * ⚠️ 这一条改过一次，原因值得记下来。初版是"只允许白名单里的虚词做邻居"
 * （`的 了 是 在 …`），第一次跑就发现 `高通发布了新的芯片` 被判成 `boundary_skip` ——
 * 因为 `发` 不在白名单里。那样等于**所有 2 字中文名都失效**，功能直接等于没有。
 *
 * 现在的做法反过来：**默认替换**，只在邻居属于下面这张"已知会拼成长词"的表时跳过。
 * 这张表是从真实碰撞里来的（`高通量`/`高通路`/`高速`/`高频`…），
 * 必然**不完整** —— 所以跳过的每一次都记 `boundary_skip` + 上下文，
 * 事后按日志扩充这张表，而不是靠猜。
 */
const ZH_COMPOUND_NEIGHBORS = new Set('量路速频压温值铁率程通倍分条段'.split(''))

/**
 * 折叠串：**保证长度不变**（这点很关键 —— 变长会让所有偏移量错位）。
 *
 * 做法：逐字符取 NFD 分解的第一个字符（`é` → `e`），小写化；
 * 若某个字符分解后不是"1 个基字符"（如 `ß` → `ss`），**保留原字符**，
 * 宁可让它不参与折叠，也不能让下标错位。
 */
export function foldForMatch(text) {
  let out = ''
  for (const char of String(text)) {
    const base = char.normalize('NFD')[0]
    const lowered = base.toLowerCase()
    // 只接受"1 个码元换 1 个码元"的情况，否则原样保留
    out += lowered.length === 1 ? lowered : char
  }
  return out
}

/** 葡语词的边界：非字母、非数字都算边界（含空格与标点）。 */
function isWordChar(char) {
  if (char === undefined) return false
  return /[\p{L}\p{N}]/u.test(char)
}

/**
 * 把一串拉丁文本"去掉空格后折叠"，并给出**紧凑下标 → 原下标**的映射。
 *
 * 为什么需要它：§5.3 规定 `LeionPro` 与 `Leion Pro` 是同一个名字（模型确实会连写）。
 * 但直接删空格会让所有偏移量错位 —— 那就没法回到原文本上替换了。
 * 所以建一张映射：`compact[i]` 对应原文本的 `map[i]`，命中后按下标还原成区间。
 */
function compactFold(text) {
  let compact = ''
  const map = []
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (/\s/.test(char)) continue          // 只去空白，不动标点
    compact += foldForMatch(char)
    map.push(index)
  }
  return { compact, map }
}

/**
 * 中文邻居是否"看起来会拼成更长的词"。
 *
 * 只有**汉字**才可能拼词；标点、数字、拉丁字母、空白都是天然边界。
 * 汉字里只有命中危险表的那几个才拦 —— 其余一律放行（默认替换）。
 */
function dangerousZhNeighbor(char) {
  if (char === undefined || char === '') return false
  if (/[\p{Script=Han}]/u.test(char) === false) return false
  return ZH_COMPOUND_NEIGHBORS.has(char)
}

/** 数一数有几个汉字。 */
function hanCount(text) {
  const found = String(text).match(/\p{Script=Han}/gu)
  return found === null ? 0 : found.length
}

/**
 * 把一张表编译成"按方向可查"的索引。
 *
 * @param {object[]} entries 已经过 validateTerms 的条目
 * @returns {{ zhToPt: object[], ptToZh: object[] }}
 *   每一项是 `{ entry, form, replacement, kind }`：`form` 用来找，`replacement` 用来换。
 */
export function buildIndex(entries) {
  const zhToPt = []
  const ptToZh = []
  for (const entry of entries ?? []) {
    const direction = entry.direction ?? 'auto'
    // 中文侧：zh + variants（都是"源侧写法"）
    if (direction === 'auto' || direction === 'zh-to-pt') {
      for (const form of [entry.zh, ...(entry.variants ?? [])]) {
        if (typeof form === 'string' && form !== '') {
          zhToPt.push({ entry, form, replacement: entry.pt, kind: 'zh' })
        }
      }
    }
    // 葡语侧：pt + approved（译文里可能出现的各种写法）
    if (direction === 'auto' || direction === 'pt-to-zh') {
      for (const form of [entry.pt, ...(entry.approved ?? [])]) {
        if (typeof form === 'string' && form !== '') {
          ptToZh.push({ entry, form, replacement: entry.zh, kind: 'pt' })
        }
      }
    }
  }
  return { zhToPt, ptToZh }
}

/** 取上下文字符串（前后各 n 个字）—— 写进日志供审计，不参与判断。 */
function contextAround(text, start, end, n = 6) {
  const before = text.slice(Math.max(0, start - n), start)
  const after = text.slice(end, end + n)
  return (before ? '…' + before : '') + text.slice(start, end) + (after ? after + '…' : '')
}

/**
 * 在一段文本里按索引找出所有候选匹配。
 *
 * 返回的每一项：`{ start, end, item, folded }`。
 * 不做取舍 —— 取舍留给 `pickNonOverlapping`，这样"为什么这个没换"可以被单独测试。
 */
function findMatches(text, index, kindFilter) {
  const folded = foldForMatch(text)
  const compact = compactFold(text)
  const found = []
  for (const item of index) {
    if (kindFilter !== undefined && item.kind !== kindFilter) continue
    const foldEnabled = item.entry.fold !== false
    const isZh = item.kind === 'zh'

    // 中文不折叠空格（中文名字里不会有空格），拉丁则连写也算同一个名字
    const needle = foldEnabled
      ? (isZh ? foldForMatch(item.form) : foldForMatch(item.form).replace(/\s+/g, ''))
      : item.form
    const haystack = foldEnabled ? (isZh ? folded : compact.compact) : text
    if (needle.length === 0) continue

    let from = 0
    for (;;) {
      const at = haystack.indexOf(needle, from)
      if (at < 0) break
      from = at + 1
      // 紧凑串里命中的区间要还原成原文本的区间
      const start = foldEnabled && isZh === false ? compact.map[at] : at
      const end = foldEnabled && isZh === false
        ? compact.map[at + needle.length - 1] + 1
        : at + needle.length
      if (start === undefined || end === undefined) continue

      if (isZh) {
        // 中文：靠"危险邻居"判边界。2 字条目强制；更长的条目只在显式要求时（strictBoundary）执行。
        const mustCheck = hanCount(item.form) === 2 || item.entry.strictBoundary === true
        if (mustCheck) {
          const before = text.charAt(start - 1)
          const after = text.charAt(end)
          if (dangerousZhNeighbor(before) || dangerousZhNeighbor(after)) {
            found.push({ start, end, item, skipped: true })
            continue
          }
        }
      } else {
        // 葡语：两侧必须是词边界（空格/标点/行首行尾）。
        // 注意这里必须用**原文本**判边界 —— 紧凑串去掉了空格，拿它判会永远"没有边界"。
        const before = text.charAt(start - 1)
        const after = text.charAt(end)
        if (start > 0 && isWordChar(before)) continue
        if (end < text.length && isWordChar(after)) continue
      }
      found.push({ start, end, item, skipped: false })
    }
  }
  return found
}

/**
 * 取舍：按"起点靠前、长度从长到短"扫一遍，凡是与已选匹配**重叠**的一律丢弃。
 *
 * 这一条就是 docs/15 §5.1 的实体重叠规则：
 * 表里同时有 `Leion Pro` 与 `Leion` 时，`Leion Pro` 里那段 `Leion` 必须被丢掉。
 */
function pickNonOverlapping(matches) {
  const sorted = [...matches].sort((a, b) => (a.start - b.start) || ((b.end - b.start) - (a.end - a.start)))
  const picked = []
  let cursor = 0
  for (const match of sorted) {
    if (match.start < cursor) continue      // 与已选的匹配重叠 → 丢弃
    picked.push(match)
    cursor = match.end
  }
  return picked
}

/**
 * 对一段译文应用热词表。
 *
 * @param {string} text 译文
 * @param {{ entries: object[], from: string }} options
 *   `from` 是**译文原本的语种**吗？不是 —— 这里的语义是"这段文本当前是什么语种"，
 *   也就是说我们按它选方向：文本是中文就用 zh→pt 那套写法去找。
 * @returns {{ text: string, events: object[] }} events 里不含模型调用（本期没有）
 */
export function applyTerms(text, options = {}) {
  const source = typeof text === 'string' ? text : ''
  const entries = options.entries ?? []
  if (source === '' || entries.length === 0) {
    return { text: source, events: [], changed: false }
  }
  const from = options.from ?? ''
  const targetIsPt = String(from).toLowerCase().startsWith('zh')
  const index = buildIndex(entries)
  const candidates = targetIsPt ? index.zhToPt : index.ptToZh

  const all = findMatches(source, candidates, targetIsPt ? 'zh' : 'pt')
  const skipped = all.filter(match => match.skipped === true)
  const usable = all.filter(match => match.skipped !== true)
  const picked = pickNonOverlapping(usable)

  const events = []
  let out = ''
  let cursor = 0
  for (const match of picked) {
    const original = source.slice(match.start, match.end)
    const replacement = match.item.replacement
    out += source.slice(cursor, match.start)
    // 折叠后相同 → 已经是规范写法，不写文本，只记一条 hit
    if (foldForMatch(original) === foldForMatch(replacement)) {
      out += original
      events.push({
        event: 'hit', id: match.item.entry.id, where: 'final',
        context: contextAround(source, match.start, match.end),
      })
    } else {
      out += replacement
      events.push({
        event: 'replace', id: match.item.entry.id, where: 'final',
        from: original, to: replacement,
        context: contextAround(source, match.start, match.end),
      })
    }
    cursor = match.end
  }
  out += source.slice(cursor)

  for (const match of skipped) {
    events.push({
      event: 'boundary_skip', id: match.item.entry.id,
      context: contextAround(source, match.start, match.end),
    })
  }

  return { text: out, events, changed: out !== source }
}
