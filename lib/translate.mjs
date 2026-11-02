/**
 * translate.mjs —— **翻译模块**（5.33 从 plugin/core.mjs 搬出）
 * ============================================================================
 * 这一层只做翻译这件事，而且把它前面（识别）和后面（显示/播放）都隔开：
 *
 * 输入：源文本 + 源语言 + 目标语言 + **这一场的术语表** + 可选的上下文
 * 输出：译文（以及"用了哪条术语、漏写了哪条"这类观测）
 *
 * 它负责的三件事（也**只有**这三件事）：
 *   ① **提示词**：translationSystem / proofreadSystem —— 由 policy 数据生成，不手写；
 *   ② **热词表**：`mentionedEntries`/`normalizeTerms`/`detectTermsMiss`/`planRescue`
 *      —— 注入提示、归一译文、观测漏写、必要时小段修正，**全在这一层内部**，
 *      调用方不需要也不允许自己拿表去 replace；
 *   ③ **校对（第二遍）**：proofreadRequest / proofreadRegression / revisionProblem
 *      —— 它属于翻译模块，因为它要重新过一遍热词归一（否则会把归一结果改回去），
 *      而且"这条修正值不值得上屏"是翻译质量的判断，不是界面的事。
 *
 * 它**不**做：网络调用、线程、重试/超时、字幕排版、历史落库、计费统计。
 * 所以它不 import 任何东西（连 node:fs 都没有）—— 这样同一份代码既能被 Node 直接
 * import，也能被 lib/artifacts.mjs 内联进动态插件沙箱（沙箱里没有 import）。
 */

/**
 * 三种语言的码。**在 core.mjs 里也各有一份**（两边都不能 import 对方：
 * 这边要能独立被内联，那边要能独立跑）。取值必须一致 —— 有测试钉着。
 */
export const ZH = 'zh-CN'
export const PT = 'pt-BR'
export const EN = 'en-US'

/** 单字符占几列：CJK 全角算 2，其余算 1。 */
export function charCols(ch) {
  const code = ch.codePointAt(0)
  const wide
    = (code >= 0x1100 && code <= 0x115f)
    || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
  return wide ? 2 : 1
}

/** 按显示宽度折行。 */
export function wrapText(text, cols) {
  const out = []
  let line = ''
  let width = 0
  for (const ch of String(text)) {
    if (ch === '\n') {
      out.push(line)
      line = ''
      width = 0
      continue
    }
    const w = charCols(ch)
    if (width + w > cols) {
      out.push(line)
      line = ''
      width = 0
    }
    line += ch
    width += w
  }
  out.push(line)
  return out
}

/**
 * 翻译用的 system 提示词 —— **由 policy 数据生成**，不在这里手写。
 *
 * 为什么数据化：巴葡口径（"不是葡葡"）是本项目最大的质量资产，而它以前散在两个地方 ——
 * 插件这里是 5 句原则、skills/leion-interpreter/SKILL.md 里是一张术语表，两者会漂移。
 * 现在唯一来源是 policy/br-pt.json；提示词与技能文档都从它生成。
 * 附带好处：将来翻译搬到端侧时，同一份数据能拿去做"禁用词约束"或"后处理替换表"，
 * 而不是靠一段小模型根本执行不了的提示词。
 *
 * @param policy 由 plugin/policy.generated.mjs（生成物）提供
 */
export function translationSystem(policy, from, to, termsHint) {
  if (policy === undefined || policy === null) {
    throw new Error('translationSystem 需要 policy（见 policy/br-pt.json 与 plugin/policy.generated.mjs）')
  }
  const target = targetName(policy, to)
  const lines = [
    '你是资深的中巴同声传译译员，服务于现场口译场景。',
    '把用户给你的话翻译成' + target + '。',
    '硬性要求：',
  ]
  // 「用巴葡表达」这类规则只在**产出巴葡**时才成立：译成中文/英语时它毫无意义，
  // 甚至可能把模型往错的方向推。所以策略数据把它们分成通用的与巴葡专用的两组。
  const rules = to === PT
    ? policy.translationRules.concat(policy.ptBrRules)
    : (to === EN ? policy.translationRules.concat(EN_OUTPUT_RULES) : policy.translationRules)
  rules.forEach((rule, index) => {
    lines.push((index + 1) + '. ' + rule)
  })
  // 术语表只有"译成中文/巴葡"时用得上（表里就是这两侧）；译成英语时这些词用不上。
  if ((to === PT || to === ZH) && policy.terminology.length > 0) {
    if (to === PT) {
      lines.push('用词必须按巴葡（括号里是葡葡，不要用）：' + policy.terminology
        .map(entry => entry.br + '（不用 ' + entry.ptpt + '）')
        .join('、'))
    } else {
      lines.push('专名用中文规范写法：' + policy.terminology
        .map(entry => entry.zh)
        .join('、'))
    }
  }
  // 本句专名提示（docs/15 §18.9）：只列**这句原文里真的出现了**的表内名字。
  // 实测（44 句 A/B）：规范写法出现率 53/56 → 56/56，prompt 只多约 27 token，
  // 没有一句被写坏、没有数字丢失。它把"模型写泛称/音译变体"这一类直接压掉，
  // 比事后修正省一次模型调用。
  // ⚠️ 5.00：译成英语时没有"英语规范写法"这一侧（术语表只有中文/巴葡两栏），
  //    所以不注入 —— 硬塞中文名会让模型在英语译文里留下中文。
  if (Array.isArray(termsHint) && termsHint.length > 0) {
    // 5.02：按**源→目标**两条车道取对应写法（中/英/葡等价）。
    // 目标语言那一栏没登记的条目**跳过** —— 没有等价关系就不该给模型一个"必须保留"的写法。
    const srcLane = langLane(from)
    const tgtLane = langLane(to)
    const pairs = []
    for (const entry of termsHint) {
      const left = termCanonical(entry, srcLane)
      const right = termCanonical(entry, tgtLane)
      if (left === '' || right === '' || left === right) continue
      pairs.push(left + ' → ' + right)
    }
    if (pairs.length > 0) {
      lines.push('本句原文出现了这些名字，译文必须保留下列写法（原文没出现的名字不要添加）：' + pairs.join('；'))
    }
  }
  return lines.join('\n')
}

/**
 * 产出英语时的补充规则（5.00）。
 *
 * <p>为什么单独一组：`policy.translationRules` 是**通用**的（保真、数字、节奏），
 * 巴葡的"不要用葡葡词"那类规则对英语毫无意义；而英语有它自己的坑 ——
 * 最典型的是"中式英语"（逐字直译语序）和"翻译腔"（`I think that it is...` 层层套）。
 * 这三条只约束**形式**，不改忠实度标准。
 */
export const EN_OUTPUT_RULES = [
  'Use natural spoken English (US). Do not translate word-by-word from the source word order.',
  'Keep names, products and numbers exactly as they are; do not localize or translate proper nouns that are given in Latin script.',
  'Output English only — never leave Chinese characters or Portuguese words in the translation.',
]

/** 目标语言的显示名（提示词里用）。三种语言的唯一来源，避免两处各写一份。 */
export function targetName(policy, to) {
  if (to === EN) return '英语（English, US）'
  if (to === PT) return policy.variety.fullName
  if (to === ZH) return policy.variety.counterpart.name
  return String(to)
}

/**
 * 校对那一道的系统提示词。
 *
 * 和 translationSystem 分开写，是因为**两件事的目标不一样**：
 *   翻译：把这段话说成巴葡（可能出错）；
 *   校对：只找出**错**，别的地方一个字都别动。
 * 混在一个提示词里会让模型忍不住去"润色"—— 那会把已经正确的译文改坏，
 * 而同传里"改错"比"不改"严重得多（观众已经把上一版读进去了）。
 *
 * 规则本身也放在 policy/br-pt.json 里（口径是数据，不是代码）——
 * 老师要调口气、加术语，改那个文件就行。
 *
 * @param policy 由 plugin/policy.generated.mjs（生成物）提供
 */
export function proofreadSystem(policy, from, to, entries) {
  if (policy === undefined || policy === null) {
    throw new Error('proofreadSystem 需要 policy（见 policy/br-pt.json 与 plugin/policy.generated.mjs）')
  }
  const target = targetName(policy, to)
  const lines = [
    '你在做**译文校对**：译文的目标语言是' + target + '。',
    '硬性要求：',
  ]
  const rules = policy.proofreadRules === undefined ? [] : policy.proofreadRules
  rules.forEach((rule, index) => lines.push((index + 1) + '. ' + rule))
  // 术语表也必须给校对看：否则它会把初译里正确的专名改成"直译"。
  // 实测反例：初译 Liangliang Vision → 校对改成 Brilha a visão，原文里的公司名整段丢失。
  const termList = Array.isArray(entries) ? entries : []
  if (termList.length > 0) {
    lines.push("术语表（以下写法是已确认的规范译名，必须原样保留：不改写、不直译、不省略）：")
    for (const entry of termList) {
      const zh = entry && entry.zh ? String(entry.zh) : ""
      const pt = entry && entry.pt ? String(entry.pt) : ""
      if (zh === "" || pt === "") continue
      // 5.00：目标语言不同，"该保留哪一侧"也不同（译成英语时没有英语那一栏，见下）
      lines.push("- " + zh + " → " + pt)
    }
    lines.push("初译里若出现表外的专名，按初译保留，不要自行发明新写法。")
  }
  if (to === PT && Array.isArray(policy.terminology) && policy.terminology.length > 0) {
    lines.push('用词必须按巴葡（括号里是葡葡，不要用）：' + policy.terminology
      .map(entry => entry.br + '（不用 ' + entry.ptpt + '）')
      .join('、'))
  }
  return lines.join('\n')
}

const CN_DIGITS = { '〇': 0, '零': 0, 一: 1, 壹: 1, 二: 2, 两: 2, 贰: 2, 三: 3, 叁: 3, 四: 4, 肆: 4, 五: 5, 伍: 5, 六: 6, 陆: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9 }
const CN_UNITS = { 十: 10, 百: 100, 千: 1000 }
const CN_DIGIT_CLASS = '〇零一壹二两贰三叁四肆五伍六陆七柒八捌九玖十百千'
const LARGE_UNIT = { 亿: 1e8, 万: 1e4, 千: 1e3, 百万: 1e6 }

/** 葡语大单位词；出现它们说明这一版在用**词形**写数字（见 proofreadRegression）。 */
const PT_LARGE = { mil: 1000, milhão: 1e6, milhao: 1e6, milhões: 1e6, milhoes: 1e6, bilhão: 1e9, bilhao: 1e9, bilhões: 1e9, bilhoes: 1e9 }
/**
 * 葡语基数词（百位以内）。只用于 `largeWordFormNumbers` 把 `trezentos e noventa e oito mil`
 * 这类表达式里的数值算出来 —— **不用于报错**，所以表不全只会让判据更严格（漏报），不会误报。
 */
const PT_SMALL = {
  um: 1, uma: 1, dois: 2, duas: 2, tres: 3, 'três': 3, quatro: 4, cinco: 5,
  seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12, treze: 13,
  quatorze: 14, catorze: 14, quinze: 15, dezesseis: 16, dezessete: 17, dezoito: 18,
  dezenove: 19, vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50, sessenta: 60,
  setenta: 70, oitenta: 80, noventa: 90, cem: 100, cento: 100, duzentos: 200,
  trezentos: 300, quatrocentos: 400, quinhentos: 500, seiscentos: 600,
  setecentos: 700, oitocentos: 800, novecentos: 900,
}
/**
 * 序数词 → 数值。**显式表，别用下标算**（第一版用 `index % 11 + 1` 从数组下标推数值，
 * 下标 0..11 对应的是 1..10，`décimo`（第 10）被算成了 11）。
 */
const PT_ORDINAL_VALUES = {
  primeiro: 1, segundo: 2, terceiro: 3, quarto: 4, quinto: 5, sexto: 6,
  'sétimo': 7, setimo: 7, oitavo: 8, nono: 9, 'décimo': 10, decimo: 10,
}

/** 中文数字 → 数值（「十二」=12；单独一个「十」也是 10）。 */
function chineseNumber(text) {
  let total = 0
  let current = 0
  let seen = false
  for (const ch of String(text)) {
    if (CN_DIGITS[ch] !== undefined) {
      current = current * 10 + CN_DIGITS[ch]
      seen = true
    } else if (CN_UNITS[ch] !== undefined) {
      total += (current === 0 ? 1 : current) * CN_UNITS[ch]
      current = 0
      seen = true
    } else {
      return null
    }
  }
  return seen ? total + current : null
}

/**
 * 取出文本里的数字（数值集合）。**只做可靠的两种来源**：阿拉伯数字、中文数字。
 *
 * ⚠️ 刻意**不解析葡语的词形数字** —— 那不是"懒得做"，是试过之后发现不划算：
 *    作同一个数有无数种词形写法（`12º` / `décimo segundo` / `andar doze` /
 *    `três mil novecentos e oitenta`），解析器漏一种写法就会把它误判成"数字丢了"，
 *    而每次误判的代价是**一次已经花钱跑完的校对白费**。
 *    改用"看到词形迹象就放过"（见 proofreadRegression），简单且不会误报。
 */
function numbersIn(text) {
  const raw = String(text)
  const out = new Set()
  const read = value => {
    if (value >= 10 && value < 1e15) out.add(Math.round(value))
  }
  for (const match of raw.matchAll(/(\d+)(?:[.,](\d+))?\s*(亿|万|千|百万)?/g)) {
    const after = raw.slice(match.index + match[0].length)
    // ⚠️ `15h20` / `7:30` 是"几时几分"：**两个数都要收**（15 和 20）。
    //    曾经这里只收小时、把分钟丢掉，于是「`15h20` → `três e vinte da tarde`」
    //    被判成"修订把 20 弄丢了" —— 而那是**完全正常的换写法**（实测在真实数据的
    //    互配对照里抓到的假阳性）。同传里时间几乎总会被换一种写法，所以这条必须对。
    if (/^[hH:]/.test(after) === true) {
      read(Number(match[1]))
      const minutes = (/^[hH:](\d{1,2})/.exec(after) ?? [])[1]
      if (minutes !== undefined) read(Number(minutes))
      continue
    }
    const decimals = match[2] === undefined ? '' : '.' + match[2]
    let value = Number(match[1] + decimals) * (LARGE_UNIT[match[3]] ?? 1)
    // 阿拉伯数字后面跟词形单位也要乘：`270 milhões` = 270×10⁶
    const nextWord = (after.toLowerCase().match(/^\s*([a-zà-ÿ]+)/) ?? [])[1]
    if (nextWord !== undefined && PT_LARGE[nextWord] !== undefined) value *= PT_LARGE[nextWord]
    read(value)
  }
  const chinese = new RegExp('([' + CN_DIGIT_CLASS + ']{1,6})', 'g')
  for (const match of raw.matchAll(chinese)) {
    const value = chineseNumber(match[1])
    if (value !== null) read(value)
  }
  return out
}

/** 词边界匹配：`tu` 不能命中 faturamento/tudo，`metro` 不能命中 parâmetros（真踩过）。 */
function hasWord(haystack, needle) {
  const text = String(haystack).toLowerCase()
  const word = String(needle).toLowerCase()
  if (word === '') return false
  const isLetter = ch => ch !== undefined && /\p{L}/u.test(ch)
  let from = 0
  for (;;) {
    const at = text.indexOf(word, from)
    if (at < 0) return false
    if (isLetter(text[at - 1]) === false && isLetter(text[at + word.length]) === false) return true
    from = at + 1
  }
}

/**
 * 校对回归闸：这条"修正"有没有**把初译里本来对的东西弄坏**。
 *
 * 为什么需要它 —— 现有那道验收闸（`revisionProblem`）只量两件事（变长太多、折行超预算），
 * 都是**格式**，不看内容。于是"修订把 `12º andar` 删了"或"把 `ônibus` 换成 `autocarro`"
 * 这类**内容回归**会被放行，屏幕上原地改坏。
 *
 * ⚠️ **只在「中文 → 巴葡」方向上跑**。这不是优化，是正确性：
 *    判据比的是「原文的数 ↔ 译文的数」，只有**译成葡语**时两边才可比。
 *    反方向（葡语 → 中文）时译文本身就是中文，里面的汉字数字会被当成"数字"，
 *    于是初译里的「十二楼」被判成"修订把 12 弄丢了" —— **假阳性**。
 *    这个坑是真踩出来的：合同套件里"屏幕换页时丢弃过期校对"那条测试因此变红，
 *    诊断信息正是 `修订把初译里的数字弄丢了（12）`，而那句的语向是 pt-BR→zh-CN。
 *
 * ⚠️ **不增加任何延迟**：纯本地字符串计算，不调模型、不联网。
 *    一句译文的量级，微秒级 —— 相对"一次模型调用几百毫秒到几秒"可以忽略。
 *
 * ⚠️ 取舍一律偏向"宁可不报"：漏判只是少拦一次，
 *    而误拦会让一次已经花钱跑完的校对白费、用户看到的还是旧译文。
 *
 * @return 有问题返回原因字符串；没问题（含"方向不对，不适用"）返回 null。
 */
export function proofreadRegression(source, draft, corrected, policy) {
  const text = String(source)
  const before = String(draft)
  const after = String(corrected)

  const hasHan = value => /\p{Script=Han}/u.test(String(value))
  if (hasHan(text) === false || hasHan(before) === true) return null

  // 数字回归：原文数字当**核对清单**，要求"初译里有、修订里没有"才算回归。
  //
  // ⚠️ 这一处我改了六版才对，把结论与理由留在这儿，别再走回头路。
  //
  // 最直觉的做法是"把修订里的词形数字**精确解析**出来，再跟清单做差集"。它要求解析器
  // 覆盖 `12º andar` / `décimo segundo andar` / `três mil novecentos e oitenta` /
  // `cada um três mil...` 全部写法，**漏一种写法就把它误判成"数字丢了"**，
  // 而每次误判的代价都是**一次已经花钱跑完的校对白费**。我确实把那台解析器写出来了，
  // 结果是每修一个假阳性就冒出下一个（`e` 被当边界、`mil` 的乘法结合、
  // 量词 `um` 被并进数字、序数词两词写法……）。
  //
  // ⚠️ 走到这一步的经验：**判据里凡是"解析自然语言"的部分都会持续出错。**
  //    所以现在**不做精确解析，只比大小**（见下面的 biggestSeen），
  //    并保留一个只认大单位的粗解析器用于"证明大数还在"。
  //
  // 结果是三件事的组合，缺一不可：
  //   ① 初译里没有的数不算清单（那是初译的错，不是"改坏"）；
  //   ② 修订里逐字还在的数 → 没问题；
  //   ③ **修订里还有一个 ≥ 这个数** 的值 → 认为它在用另一套写法（词形/单位换算），放过。
  //      "≥"而不是"整个放过"，是为了让**降级**拦得住：`Do 12º andar para o 6º andar`
  //      → `Do 6º andar` 里，修订只剩 6，没有 ≥12 的值，所以 12 的丢失照样报出来。
  //      （这里曾经写成 biggestSeen ≥ value 但取的是全句最大数，
  //        于是同句里另一个更大的数 802 会把 12 的丢失掩盖掉 —— 必须比同名量级才对。）
  const draftNumbers = numbersIn(before)
  const afterNumbers = numbersIn(after)
  // 修订里可能把数写成了词形（`3980` → `três mil novecentos e oitenta`、
  // `12` → `décimo segundo andar`）—— 单独解析一遍，用来"证明这个数还在"。
  const recoveredLarge = largeWordFormNumbers(after)
  // 修订里出现过的**最大数值**：只要它 ≥ 某个丢失的数，就说明修订在用另一套写法
  // 描述同一个量级（词形、单位换算），不能因为"字面数字对不上"就判丢失。
  //
  // ⚠️ 这一条是**"别误拦"的总保险**，替掉了前面好几版零散的护栏（小数值放过、
  //    大单位迹象放过……）。那些散判据每加一条就发现新的漏网情况，而这条只是比大小，
  //    **没有解析、也就没有解析 bug**。
  // ⚠️ 但它必须"按值比"而不是"整个放过"：第四版是"修订里有词形数字就整个跳过检查"，
  //    于是 `…sala 802 no 8º andar` → `…o oitavo andar` 里那个 802 丢了也没发现。
  // ⚠️ **楼层语境的序数词**也算"在用词形写数"（`décimo segundo andar` = 12 楼）。
  //    这里必须限定"后面紧挨着 andar / piso"，**不能把序数词无条件当数字迹象** ——
  //    葡语里 `segundo`（根据）、`primeiro`（首先）是极常见的普通词，
  //    无条件接受会让召回崩掉（实测 `Do 12º andar para o 6º andar` → `Do 6º andar`
  //    里"12 楼丢了"被放过，就是因为句中的普通词命中了序数词表）。
  const words = after.toLowerCase().split(/[^a-zà-ÿ]+/).filter(item => item !== '')
  const usesFloorOrdinal = words.some((word, index) => {
    if (PT_ORDINAL_VALUES[word] === undefined) return false
    const next = words[index + 1] ?? ''
    return next === 'andar' || next === 'piso'
  })
  const hasNumberWord = usesFloorOrdinal === true
    || words.some(word => PT_LARGE[word] !== undefined)
  // ⚠️ 时间要单独看：`下午三点二十` → `15h20` → `três e vinte da tarde` 是最常见的正常换写法，
  //    而 `15h20` 拆出来是 {15, 20}、`três e vinte` 只取得到 3 —— 分钟部分会被误判成"丢了 20"。
  //    （这是实测抓到的假阳性，而且会**成片触发**：同传里时间几乎总会被换一种写法。）
  //    判法：原文与修订**都**能被认出是"时间"时，就不因分钟数变化而判丢失。
  //    中文侧也要认（`下午三点二十`），否则 zh→pt 的原文这一半会漏掉。
  const clockLike = value => /(\d{1,2})\s*[h:]\s*\d{2}/.test(String(value)) === true
  const spelledTime = value => /\b(uma|duas|três|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|treze|quatorze|catorze|quinze|dezesseis|dezessete|dezoito|dezenove|vinte|trinta)\s+e\s+(dez|vinte|trinta|quarenta|cinquenta)\b/i.test(String(value)) === true
    || /(horas?|tarde|manhã|manha|noite|meio-dia)/i.test(String(value)) === true
  const chineseTime = value => /(上午|下午|晚上|中午|凌晨|早上|点钟|点半|点整)/.test(String(value)) === true
    || /[〇零一二两三四五六七八九十]{1,3}\s*点\s*[〇零一二两三四五六七八九十]{0,3}/.test(String(value)) === true
  const looksLikeTime = value => clockLike(value) || spelledTime(value) || chineseTime(value)
  const bothTimes = looksLikeTime(text) && looksLikeTime(after)
  const lost = [...numbersIn(text)].filter(value => {
    if (draftNumbers.has(value) === false) return false     // 初译本来就没译出来 → 不是"改坏"
    if (afterNumbers.has(value) === true) return false      // 修订里还在
    if (recoveredLarge.has(value) === true) return false    // 粗解析对上了（含大单位写法），还在
    if (bothTimes === true && value <= 60) return false     // 两边都是时间写法 → 分钟数变化不算丢失
    // ⚠️ **小数值（< 1000）遇上"在用词形写数"的迹象就放过。**
    //    理由：这个量级的词形写法会让上面那个粗解析**算出偏小的值**
    //    （`três mil novecentos e oitenta` 只能算到 3000、`décimo segundo` 只有单独处理才对上），
    //    所以"解析不出来"不能当"丢了"的证据。它覆盖楼层（`12` ↔ `décimo segundo`）、
    //    数量（`120` ↔ `cento e vinte`）、百分数这些真实场景。
    //    而 ≥100 的数（房间号 `802`、金额 `3980`、`398000`）**模型永远用阿拉伯数字写**，
    //    必须拿出精确证据（真出现那个数）才放行 —— 否则就是真丢了。
    //    阈值取 100 而不是 1000：**房间号是三位数**（802），
    //    取 1000 会把"802 丢了"也放过（实测踩到过）。
    if (hasNumberWord === true && value < 100) return false
    // ⚠️ 这里曾经还有一条"修订里存在 ≥ 它的值就放过"（比大小）。**删掉了**，因为它会掩盖真丢失：
    //    `…no 12º andar para a sala 802 no 8º andar` → `…para o quarto 802 no oitavo andar`
    //    里 12 楼真的丢了，但修订里有更大的 802，且 802 在初译里也存在 ——
    //    于是"比大小"那条直接放行，**真回归被掩盖**（实测抓到的）。
    //    现在的判据全部基于**证据**（那个值真的出现了 / 词形能对上 / 小数值+词形迹象），
    //    不做任何"看起来像"的推断。
    return true
  })
  if (lost.length > 0) {
    return '修订把初译里的数字弄丢了（' + lost.join('、') + '）—— 同传里丢数字比语法错严重得多'
  }

  // 口径回归：修订里冒出了欧洲葡语说法（提示词里明令禁止）。
  // 初译本来就有则不算回归 —— 这道闸管的是"别改坏"，不是"改好"。
  const terminology = policy === undefined || policy === null || Array.isArray(policy.terminology) === false
    ? []
    : policy.terminology
  for (const entry of terminology) {
    if (entry.ptpt === undefined || entry.ptpt === '') continue
    if (hasWord(before, entry.ptpt) === true) continue
    if (hasWord(after, entry.ptpt) === true) {
      return '修订里出现了欧洲葡语说法 ' + entry.ptpt + '（巴葡应为 ' + entry.br + '）'
    }
  }
  return null
}

/**
 * 葡语**大单位表达式**里的数值（`trezentos e noventa e oito mil` → 398000）。
 *
 * 只认"大单位词"，因为只有这一档需要它：
 *   · `mil / milhão / bilhão` 后面跟着的数值一定是大数，而大数**不会被写成词**的假设
 *     正是第四版误判 398000 的原因 —— 模型确实会写 `trezentos e noventa e oito mil`。
 *   · 小数字（< 100）由"词形迹象 + 小数值"那条护栏覆盖，不需要在这里解析。
 *
 * ⚠️ 只在"证明某个大数还在"时用（往集合里加），不报错 —— 所以宁可多算几个也不漏算。
 * ⚠️ 数值算错也无妨：真正要证明的那个数（398000）一定会以某个中间形态出现
 *    （`mil` 处会算出 398000；即使累加次序不完美，目标值通常仍在集合里）。
 *    而**算不出来只会让判据更严格** —— 那是漏报，不是误报，可以接受。
 */
function largeWordFormNumbers(text) {
  const out = new Set()
  const words = String(text).toLowerCase().split(/[^a-zà-ÿ]+/).filter(item => item !== '')
  let run = 0
  let hasRun = false
  const read = () => {
    if (hasRun === true && run >= 10 && run < 1e15) out.add(Math.round(run))
    run = 0
    hasRun = false
  }
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    const large = PT_LARGE[word]
    if (large !== undefined) {
      run = (run === 0 ? 1 : run) * large
      hasRun = true
      continue
    }
    const small = PT_SMALL[word]
    if (small !== undefined) {
      // ⚠️ 这里**绝不能 read()** —— 这是踩过的坑：
      //    `três mil trezentos e oitenta` 里，`trezentos` 若触发收尾，
      //    就把中间的 3000 当成结果吐出去（而真值是 3380），**真值反而不在集合里**。
      //    数词与大单位都只累积，收尾只发生在真边界（非数字词）与结尾。
      // 数字之间没有 `e` 连接就是两个数（`cada um três mil` = 各 1 + 三千），有 `e` 才是相加
      if (hasRun === true && words[index - 1] !== 'e') run = 0
      run += small
      hasRun = true
      continue
    }
    // `e` 是数字内部的连接词（`trezentos e noventa e oito mil`），不是边界
    if (word === 'e') continue
    read()
  }
  read()
  // ⚠️ 把收尾时手里的累积值也收进来。它是"改写成了词形"的证据，哪怕值不完全精确：
  //    `décimo segundo andar` → 累积到 12（真值就是 12）；
  //    `três mil novecentos e oitenta` → 只能算到 3000（真值 3980）——
  //    所以调用方那边还要配一条"< 1000 时只要有大单位迹象就放过"（见 proofreadRegression）。
  if (run > 0 && run < 1e15) out.add(Math.round(run))
  return out
}

/**
 * 校对结果的验收闸：这条"修正"到底能不能上屏？
 *
 * 为什么必须有：提示词里写了"不许比原译文更长"，但**模型不保证守规矩**。 而且这里还有一个更阴的失败方式 —— 读代码时发现的：
 * 离线演示用的例句表适配器（scripts/demo-phrasebook.mjs）对查不到的输入会回一句
 * 「（离线演示：例句表里没有这一句，原文为「…」）」。校对请求当然查不到，
 * 于是它会**被当成校对结果**，把一句本来正确的字幕覆盖成这句演示提示。
 * 这类"校对把对的改错"的代价比"不校对"高得多 —— 观众已经把上一版读进去了。
 *
 * 两条判据（都必要）：
 *   ① 变长太多 → 这不是校对，是别的东西（校对只该修错，不该扩写）；
 *   ② 折行后超出显示预算 → 会把开头挤掉（AR 只有 3 行，超出的部分是从**开头**被丢的）。
 *
 * @return 不可用时返回原因字符串；可用返回 null。
 */
export function revisionProblem(draft, corrected, cols, lines) {
  const before = String(draft)
  const after = String(corrected)
  if (after.trim() === '') return '校对结果为空'
  const grew = after.length - before.length
  if (grew >= 12 && after.length > before.length * 1.5) {
    return '比原译文长太多（' + before.length + ' → ' + after.length + ' 字符），不像是在校对'
  }
  if (wrapText(after, cols).length > lines) {
    return '折行后有 ' + wrapText(after, cols).length + ' 行，超出 ' + lines + ' 行的显示预算'
  }
  return null
}

/**
 * 拼校对那一次的输入：这一句的原文 + 已上屏的译文 + 上一句的上下文。
 *
 * 为什么一定要把**原文**给它：同传里最常见的错误不是"译得不好"，而是
 * **听错了**（Whisper 在短片段上尤其容易错，例如把「这是一条测试语音」听成
 * 「这是一条」+「测试语音」两句）。只看译文是发现不了这类错的，
 * 必须拿原文对照，甚至要往前看一句才能推断说话人到底想说什么。
 */
export function proofreadRequest(input) {
  const lines = []
  if (input.context !== undefined && input.context !== null) {
    lines.push('上一句原文：' + input.context.source)
    lines.push('上一句译文：' + input.context.translation)
  }
  lines.push('这一句原文：' + input.source)
  lines.push('已经上屏的译文：' + input.draft)
  lines.push('请输出校对后的译文（没有要改的就原样输出）：')
  return lines.join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// 一次挂载 = 一个解释器实例
//
// 状态刻意放在实例里而不是模块级：正式插件可能被多个 agent preset 同时挂载
// （harness 里这是常态），模块级状态会让两条会话的字幕互相串。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * transport seam —— 唯一会随真机变化的一层。
 *
 *   mock —— 打到 host 日志 + 留在内存，无真机也能把整条链路跑通；
 *   file —— 把「当前字幕帧」原子写成一份 JSON，外部桥（Python/ADB/BLE 程序）轮询它
 *           再推给真机。这是接入真机最短的路：眼镜协议怎么变都不动插件。
 *
 * 接真机时在这里加一支：'adb'（走 ctx.get('shell')）、'ble'（走外部守护进程）……
 * 注意 ctx.web.fetch 只支持 GET（WebFetchRequest 只有 url 字段），不能当 POST 桥用。
 */

function foldForTerms(text) {
  let out = ''
  for (const char of String(text)) {
    const base = char.normalize('NFD')[0]
    const lowered = base.toLowerCase()
    out += lowered.length === 1 ? lowered : char
  }
  return out
}

/** 中文"危险邻居"：和两字名字拼起来会变成另一个词的字（从真实碰撞里来，必然不完整）。 */
const ZH_COMPOUND_NEIGHBORS = new Set('量路速频压温值铁率程通倍分条段'.split(''))

/** 只认汉字：标点/数字/拉丁字母都算天然边界。 */
function dangerousZhNeighbor(char) {
  if (char === undefined || char === '') return false
  if (/[\p{Script=Han}]/u.test(char) === false) return false
  return ZH_COMPOUND_NEIGHBORS.has(char)
}

function isWordChar(char) {
  if (char === undefined) return false
  return /[\p{L}\p{N}]/u.test(char)
}

function hanCountOf(text) {
  const found = String(text).match(/\p{Script=Han}/gu)
  return found === null ? 0 : found.length
}

/** 去空白后折叠 + 紧凑下标映射（让 `LeionPro` 与 `Leion Pro` 等价，同时能回到原文）。 */
function compactFold(text) {
  let compact = ''
  const map = []
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (/\s/.test(char)) continue
    compact += foldForTerms(char)
    map.push(index)
  }
  return { compact, map }
}

/** 把表编译成"同语种归一"用的两个索引。 */
/**
 * 一条术语在某一种语言下的**全部写法**（5.02，三语）。
 *
 * - 规范写法：`zh` / `pt` / `en`
 * - 该语言的变体：中文 = `variants`，葡语 = `approved`，英语 = `enVariants`
 * - `wrong`（已知错写）三种语言共享 —— 它是"要纠正的写法"，不分语言
 *
 * 为什么抽出来：地图（index）、归一、观测、提示词四处都要"按语言取写法"，
 * 各写一份必然漂 —— 而漂了的表现是"某个方向悄悄不生效"，最难发现。
 */
export function termSideForms(entry, lang) {
  const base = String(lang === undefined || lang === null ? '' : lang).toLowerCase()
  if (entry === null || entry === undefined) return []
  // ⚠️ 这一栏没登记规范写法（两栏条目的空栏）→ 这一栏**没有任何写法**可找。
  //    必须在这里就返回空数组：否则 `wrong` 会被当成这一栏的写法带出去，
  //    而它的替换目标是空串 —— 那会**把句子里的词删掉**（5.02 实测踩过）。
  if (termCanonical(entry, base) === '') return []
  const out = []
  const push = (value) => {
    const text = typeof value === 'string' ? value.trim() : ''
    if (text !== '' && out.includes(text) === false) out.push(text)
  }
  if (base.startsWith('zh')) {
    push(entry.zh)
    for (const form of entry.variants ?? []) push(form)
  } else if (base.startsWith('en')) {
    push(entry.en)
    for (const form of entry.enVariants ?? entry.approved ?? []) {
      // ⚠️ 兼容：老条目没有 enVariants（只有 approved = 葡语写法）。
      //    这时候**不能**把葡语写法当成英语变体 —— 那会让英语句子里的葡语词被替换成英语词。
      //    所以只有 enVariants 明确存在时才用它。
      if (Array.isArray(entry.enVariants)) push(form)
    }
  } else {
    push(entry.pt)
    for (const form of entry.approved ?? []) push(form)
  }
  for (const form of entry.wrong ?? []) push(form)
  return out
}

/** 这条术语在某种语言下的**规范写法**（没登记返回空串 = 该方向没有等价关系）。 */
export function termCanonical(entry, lang) {
  const base = String(lang === undefined || lang === null ? '' : lang).toLowerCase()
  if (entry === null || entry === undefined) return ''
  const value = base.startsWith('zh') ? entry.zh : (base.startsWith('en') ? entry.en : entry.pt)
  return typeof value === 'string' ? value.trim() : ''
}

function buildTermsIndex(entries) {
  const zh = []
  const pt = []
  const en = []
  for (const entry of entries || []) {
    for (const form of [entry.zh, ...(entry.variants || []), ...(entry.wrong || [])]) {
      if (typeof form === 'string' && form !== '') {
        zh.push({ entry, form, replacement: entry.zh, kind: 'zh' })
      }
    }
    // ⚠️ 两栏条目可能缺葡语侧（只有中/英）：`pt` 空串时整栏跳过，
    //    否则 `wrong` 的替换目标是空串 → 把词删掉。
    if (typeof entry.pt === 'string' && entry.pt !== '') {
      for (const form of [entry.pt, ...(entry.approved || []), ...(entry.wrong || [])]) {
        if (typeof form === 'string' && form !== '') {
          pt.push({ entry, form, replacement: entry.pt, kind: 'pt' })
        }
      }
    }
    // 5.02：英语那一栏（老条目没有 en → 不往这一栏放任何东西）
    //
    // ⚠️ 必须整栏跳过：`replacement` 是 `entry.en`，两栏条目（只有中/葡）的 en 是空串，
    //    要是把 `wrong` 塞进这一栏，替换结果就是**把词删掉** ——
    //    这类 bug 表现成"英语字幕里少了几个词"，比乱换更难发现。
    if (typeof entry.en === 'string' && entry.en !== '') {
      for (const form of [entry.en, ...(entry.enVariants || []), ...(entry.wrong || [])]) {
        if (typeof form === 'string' && form !== '') {
          en.push({ entry, form, replacement: entry.en, kind: 'en' })
        }
      }
    }
  }
  return { zh, pt, en }
}

/**
 * 对一段译文做归一（**纯函数**：给它文本、语种、表，它就返回结果）。
 *
 * <p>为什么单独抽出来并导出：契约测试要能直接断言"变体→规范写法"、
 * "幂等"、"空表不动"。走整条链路测不干净 —— 假 LLM 的译文是固定句型，
 * 里面根本没有变体可换（这一点我在写测试时踩到了）。
 *
 * @param {string} text
 * @param {string} lang
 * @param {object[]} entries
 * @returns {{ text: string, events: object[], changed: boolean }}
 */
export function normalizeTerms(text, lang, entries) {
  const source = typeof text === 'string' ? text : ''
  if (source === '' || Array.isArray(entries) === false || entries.length === 0) {
    return { text: source, events: [], changed: false }
  }
  const isZh = String(lang).toLowerCase().startsWith('zh')
  const isEn = String(lang).toLowerCase().startsWith('en')
  const index = buildTermsIndex(entries)
  // 5.02：三条"语言车道"。中文用汉字边界判据，拉丁语系（葡/英）用紧凑串 + 词边界 ——
  // 两者不能混（混了的表现是"某个方向突然乱替换"，见 docs/15 §5.1）。
  const candidates = isZh ? index.zh : (isEn ? index.en : index.pt)
  const folded = foldForTerms(source)
  const compact = compactFold(source)

  const found = []
  for (const item of candidates) {
    const foldEnabled = item.entry.fold !== false
    const needle = foldEnabled
      ? (isZh ? foldForTerms(item.form) : foldForTerms(item.form).replace(/\s+/g, ''))
      : item.form
    const haystack = foldEnabled ? (isZh ? folded : compact.compact) : source
    if (needle.length === 0) continue
    let from = 0
    for (;;) {
      const at = haystack.indexOf(needle, from)
      if (at < 0) break
      from = at + 1
      const start = foldEnabled && isZh === false ? compact.map[at] : at
      const end = foldEnabled && isZh === false
        ? compact.map[at + needle.length - 1] + 1
        : at + needle.length
      if (start === undefined || end === undefined) continue
      if (isZh) {
        const mustCheck = hanCountOf(item.form) === 2 || item.entry.strictBoundary === true
        if (mustCheck) {
          const before = source.charAt(start - 1)
          const after = source.charAt(end)
          if (dangerousZhNeighbor(before) || dangerousZhNeighbor(after)) {
            found.push({ start, end, item, skipped: true })
            continue
          }
        }
      } else {
        if (start > 0 && isWordChar(source.charAt(start - 1))) continue
        if (end < source.length && isWordChar(source.charAt(end))) continue
      }
      found.push({ start, end, item, skipped: false })
    }
  }

  // 实体重叠：被更长匹配覆盖的短匹配一律丢弃（`Leion` 在 `Leion Pro` 里必须让位）
  const usable = found.filter(match => match.skipped !== true)
    .sort((a, b) => (a.start - b.start) || ((b.end - b.start) - (a.end - a.start)))
  const picked = []
  let cursor = 0
  for (const match of usable) {
    if (match.start < cursor) continue
    picked.push(match)
    cursor = match.end
  }

  const events = []
  let out = ''
  let position = 0
  for (const match of picked) {
    const original = source.slice(match.start, match.end)
    const replacement = match.item.replacement
    out += source.slice(position, match.start)
    // 只有**逐字相同**才算"已经是规范写法"。仅大小写/重音/空格不同也属于变体 ——
    // must 的口径是"命中变体就必须输出规范写法"：`llvision` 必须变成 `LLVision`。
    // 折叠只负责"找得到"，不负责"不用改"。
    if (original === replacement) {
      out += original
      events.push({ event: 'hit', id: match.item.entry.id })
    } else {
      out += replacement
      events.push({ event: 'replace', id: match.item.entry.id, from: original, to: replacement })
    }
    position = match.end
  }
  out += source.slice(position)
  for (const match of found) {
    if (match.skipped === true) events.push({ event: 'boundary_skip', id: match.item.entry.id })
  }
  return { text: out, events, changed: out !== source }
}

/**
 * 在一段文本里"找得到"某个写法（与匹配器同一套折叠与边界规则）。
 *
 * <p>为什么不复用 `normalizeTerms`：它按键值找"要替换的变体"，而这里要回答的是
 * "这段文本里**有没有出现**这个写法（任意已知写法）"—— 关心的是存在性，不是替换。
 * 规则必须一致，否则会出现"归一认为没出现、观测认为出现了"这种自相矛盾的日志。
 */
/**
 * 把"语言"归一成三条车道之一（5.02）。
 *
 * <p>历史上这里有布尔值（`sourceZh === true` 表示中文、`false` 表示葡语），
 * 演示台/评测脚本也按布尔调用。加英语之后布尔不够用了，所以这里**同时接受**
 * 布尔与语言码：`true` → zh、`false` → pt、`'en-US'` → en。老调用一个字都不用改。
 */
export function langLane(value) {
  if (value === true) return 'zh'
  if (value === false) return 'pt'
  const text = String(value === undefined || value === null ? '' : value).toLowerCase()
  if (text.startsWith('zh')) return 'zh'
  if (text.startsWith('en')) return 'en'
  return 'pt'
}

/**
 * "这句原文里出现了哪些表内条目" —— **唯一实现**。
 *
 * <p>产线（`termsHintFor`）与演示台/评测脚本都必须用它。为什么不允许各自实现：
 * 判断"是否提及"要同时考虑**变体**（原文说「亮亮眼睛」、条目写「亮亮眼镜」）、
 * **可接受写法**（葡语侧 `approved`、英语侧 `enVariants`）、折叠（大小写/重音/空格）
 * 与边界（中文危险邻接）。自己写个 `text.includes(entry.zh)` 会漏掉前两条 ——
 * 演示台给出"本句不会加提示"，而产线其实会加，这种分叉比直接报错更难发现。
 *
 * @param {string} text 原文
 * @param {object[]} entries 表内条目
 * @param {boolean|string} sourceZh true = 中文 / false = 葡语 / 语言码（5.02 起支持 en-US）
 * @returns {{zh: string, pt: string, en: string}[]} 命中的条目（顺序同入参）
 */
export function mentionedEntries(text, entries, sourceZh) {
  const source = String(text === undefined || text === null ? '' : text)
  if (source === '' || Array.isArray(entries) !== true) return []
  const lane = langLane(sourceZh)
  const hint = []
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    const forms = termSideForms(entry, lane)
    const mentioned = forms.some(form => typeof form === 'string' && form !== ''
      && mentionsForm(source, form, lane === 'zh', entry.fold !== false, entry.strictBoundary === true))
    if (mentioned) hint.push({ zh: entry.zh, pt: entry.pt, en: String(entry.en ?? '') })
  }
  return hint
}

function mentionsForm(text, form, isZh, foldEnabled, strictBoundary) {
  const folded = foldForTerms(text)
  const compact = compactFold(text)
  // 中文不折叠空格（中文名字里不会有空格），拉丁则连写也算同一个名字（与匹配器一致）
  const needle = foldEnabled
    ? (isZh ? foldForTerms(form) : foldForTerms(form).replace(/\s+/g, ''))
    : form
  const haystack = foldEnabled ? (isZh ? folded : compact.compact) : text
  if (needle === '') return false
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) return false
    from = at + 1
    const start = foldEnabled && isZh === false ? compact.map[at] : at
    const end = foldEnabled && isZh === false ? compact.map[at + needle.length - 1] + 1 : at + needle.length
    if (start === undefined || end === undefined) continue
    if (isZh) {
      const mustCheck = hanCountOf(form) === 2 || strictBoundary === true
      if (mustCheck) {
        if (dangerousZhNeighbor(text.charAt(start - 1)) || dangerousZhNeighbor(text.charAt(end))) continue
      }
    } else {
      if (start > 0 && isWordChar(text.charAt(start - 1))) continue
      if (end < text.length && isWordChar(text.charAt(end))) continue
    }
    return true
  }
}

/**
 * 热词观测（A 方案，docs/15 §17）：找出"源文提到了表内名字、译文里却没有规范写法"的条目。
 *
 * <p>纯字符串、零模型调用 —— 它**不判断**模型写得对不对，只判断"规范写法出现了没有"。
 * 所以它不知道模型写成了什么（那是离线候选发现干的事），但足够回答"这句话有没有问题"。
 *
 * @param {string} source 原文
 * @param {string} text 译文
 * @param {object[]} entries 已校验的条目
 * @param {string} from 源语种（zh-CN / pt-BR）
 * @param {string} to 目标语种
 * @returns {object[]} `[{ event: 'watch', id, zh, source, translation }]`
 */
export function detectTermsMiss(source, text, entries, from, to) {
  const src = String(source === undefined || source === null ? '' : source)
  const tgt = String(text === undefined || text === null ? '' : text)
  if (src === '' || tgt === '' || Array.isArray(entries) !== true || entries.length === 0) return []
  const srcLane = langLane(from)
  const tgtLane = langLane(to)
  // 同一语言（只会是异常配置）或方向不明 → 不做观测，宁缺勿错
  if (srcLane === tgtLane) return []
  const events = []
  for (const entry of entries) {
    const direction = entry.direction ?? 'auto'
    // 老条目的 direction 只有中/葡两种取值：英语方向上不做限向（按 auto 处理）
    if (direction === 'zh-to-pt' && (srcLane !== 'zh' || tgtLane === 'zh')) continue
    if (direction === 'pt-to-zh' && (srcLane === 'zh' || tgtLane !== 'zh')) continue
    const foldEnabled = entry.fold !== false
    const forms = termSideForms(entry, srcLane)
    // 5.02：目标语言那一栏没登记 → 没有等价关系可用，不观测（也不假装知道该写什么）
    const canonical = termCanonical(entry, tgtLane)
    if (canonical === '') continue
    const mentioned = forms.some(form => typeof form === 'string' && form !== ''
      && mentionsForm(src, form, srcLane === 'zh', foldEnabled, entry.strictBoundary === true))
    if (mentioned === false) continue
    const canonicalPresent = mentionsForm(tgt, canonical, tgtLane === 'zh', foldEnabled, entry.strictBoundary === true)
    if (canonicalPresent) continue
    events.push({
      event: 'watch', id: entry.id, zh: entry.zh,
      source: src, translation: tgt,
    })
  }
  return events
}

/**
 * 4b 强制执行闸（纯函数）：**初稿里已经正确的规范写法，校对结果里不许消失**。
 *
 * <p>为什么需要它：`proofreadRules` 已经写明"专有名词不由你负责"，但实测模型**并不完全遵守**
 * ——它仍会把 `óculos LLVision` 改成 `óculos Leion`、或把名字换成别的写法。
 * 校对是**在归一之后**跑的，只有它有能力破坏归一/归一后的结果；
 * 所以这里加一道本地检查：任何表内条目的规范写法，只要在初稿里出现过、
 * 校对结果里却没有了 → 这次校对整条丢弃（屏幕保持初稿）。
 *
 * <p>注意：如果校对只是把*未登记变体*换成规范写法（方向是对的），初稿里**没有**规范写法，
 * 这道闸不拦；如果校对把规范写法换成**已登记**的变体，前面的 `applyTerms` 会先换回来，也不拦。
 *
 * @param {boolean|string} targetLang 译文语种：`true`=中文 / `false`=葡语 / 语言码（5.02 起支持 `en-US`）
 * @returns {string | null} 有问题返回原因，没问题返回 null
 */
export function proofreadKeptNames(draft, corrected, entries, targetLang) {
  const before = String(draft === undefined || draft === null ? '' : draft)
  const after = String(corrected === undefined || corrected === null ? '' : corrected)
  if (before === '' || after === '') return null
  // 5.02：第四参从布尔（true=中文 / false=葡语）扩展成语言码。布尔仍然接受
  // （老测试与老调用点一个字都不用改），但英语译文必须走 en 车道 ——
  // 否则会拿葡语规范写法去英语句子里找，永远"没出现"，这道闸对英语等于失效。
  const lane = langLane(targetLang)
  const isZh = lane === 'zh'
  for (const entry of entries ?? []) {
    if (entry === null || typeof entry !== 'object') continue
    const canonical = termCanonical(entry, lane)
    if (typeof canonical !== 'string' || canonical === '') continue
    const foldEnabled = entry.fold !== false
    const strict = entry.strictBoundary === true
    if (mentionsForm(before, canonical, isZh, foldEnabled, strict) === false) continue
    if (mentionsForm(after, canonical, isZh, foldEnabled, strict) === true) continue
    return '「' + canonical + '」在初稿里是正确的，校对结果里没有了'
  }
  return null
}

/**
 * 在文本里定位一个"片段"的**原始下标区间**（折叠 + 去空格，与匹配器同一套口径）。
 *
 * <p>为什么需要它：临时修正必须**只换那一小段**，不能像校对那样让模型重写整句
 * （重写整句 = 把"可能改坏一句"的风险又请回来）。所以先定位、再手工拼回。
 *
 * @returns {{ start: number, end: number } | null} `null` = 原文里找不到这个片段
 */
export function locateTermSpan(text, needle) {
  const src = String(text)
  const foldedNeedle = foldForTerms(String(needle)).replace(/\s+/g, '')
  if (foldedNeedle === '') return null
  const compact = compactFold(src)
  const at = compact.compact.indexOf(foldedNeedle)
  if (at < 0) return null
  const start = compact.map[at]
  const end = compact.map[at + foldedNeedle.length - 1]
  if (start === undefined || end === undefined) return null
  return { start, end: end + 1 }
}

/**
 * 临时修正的**全部闸门**（纯函数）：给"草案、模型答案、规范写法、其它条目"，决定改不改。
 *
 * **激进版（实验分支，docs/15 §18）**：去掉了"与规范写法形状相似"这一道 ——
 * 译名/缩写类（`Liangliang Ótica` vs `Leion`）不再被拒，由模型判断"它写成了什么"。
 * 代价与护栏：片段必须**原样出现在译文里**、不夹带别的表名、长度受限、
 * 改完必须过格式验收；而且**只改最后一句**、过期丢弃 —— 不靠"形状像不像"兜底。
 *
 * @returns {{ ok: true, text: string, from: string, to: string } | { ok: false, reason: string }}
 */
export function planRescue({ draft, answer, canonical, entries, targetZh, cols, lines }) {
  const text = String(draft === undefined || draft === null ? '' : draft)
  const raw = String(answer === undefined || answer === null ? '' : answer).trim()
  const canon = String(canonical === undefined || canonical === null ? '' : canonical)
  if (text === '' || raw === '') return { ok: false, reason: '空输入' }
  if (foldForTerms(raw) === foldForTerms(canon)) return { ok: false, reason: '与规范写法相同' }
  const words = raw.split(/\s+/).filter(word => word !== '')
  if (words.length > 6 || raw.length > 40) return { ok: false, reason: '片段太长（可能是一整句）' }
  const span = locateTermSpan(text, raw)
  if (span === null) return { ok: false, reason: '片段没有原样出现在译文里' }
  // 激进版不再要求"与规范写法形状相似"——译名/缩写类也允许；靠下面两条兜底。
  // ② 不得夹带别的表内名字
  for (const other of entries) {
    if (other === null || typeof other !== 'object') continue
    if (other.pt === canon || other.zh === canon) continue
    const forms = targetZh
      ? [other.zh, ...(other.variants ?? [])]
      : [other.pt, ...(other.approved ?? [])]
    const hitOther = forms.some(form => typeof form === 'string' && form !== ''
      && mentionsForm(raw, form, targetZh, other.fold !== false, other.strictBoundary === true))
    if (hitOther) return { ok: false, reason: '片段里夹带了别的名字（串台）' }
  }
  const replaced = text.slice(0, span.start) + canon + text.slice(span.end)
  // ③ 格式验收：与校对共用同一道闸，避免"行数/列数放不下"的修正上屏
  if (typeof cols === 'number' && typeof lines === 'number') {
    const problem = revisionProblem(text, replaced, cols, lines)
    if (problem !== null) return { ok: false, reason: '格式验收不过：' + problem }
  }
  return {
    ok: true,
    text: replaced,
    from: text.slice(span.start, span.end),
    to: canon,
  }
}
