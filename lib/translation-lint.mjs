/**
 * translation-lint.mjs —— 译文质检判据
 * ============================================================================
 *
 * 现在**接进产线了**：转发进程（`relay/lan-relay.mjs`）每收到一个**定稿帧**，
 * 就拿它的原文与译文跑一遍下面这些判据，把结果打进日志与 `/status`。
 *
 * ⚠️ 但它是**只报不改**的旁路：
 *   · 它**不进翻译管线**（判在转发进程里，翻译在插件里），所以不可能拖慢字幕，
 *     也不可能因为自己出错而让字幕出不来（`lintFrame` 里 catch 住了一切异常）。
 *   · 它**不修改**任何译文。要"报完顺手修"（重译/替换）得另做设计 ——
 *     那时才需要进管线，而进管线要过 `plugin/core.mjs` 被内联进沙箱那道坎
 *     （沙箱里没有 import，见 `dynamic/leion-pro.host.js`）。
 *   · 最早它是纯离线评测用的（`scripts/bench-models.mjs` 拿它给模型排名）。
 *     那层用途没变，现在多了一个线上用途。
 *
 * 这里放的是**"能零误报地自动判断"**的那几类错。设计总原则只有一条：
 *
 *   > **宁可不报，不可误报。**
 *
 * 为什么这条是铁律：判据误报的代价不是"多看一眼"，而是**让译文质量好的模型排名垫底**
 * —— 那是结论级错误。真踩过：Hunyuan-MT 把「…采集到**字幕**显示…」译成
 * `…a exibição dos **legendas**…`（正确翻译），却被幻听词表误判成事故。
 *
 * 所以下面每一层都按"**没有确凿依据就不报**"来写，并且每层都配了负对照测试：
 * 既要验"该报的报"，也要验"**不该报的不报**"。
 *
 * 分三层（对应 docs/08 第 4 节讨论的方案）：
 *   ① 专名：不该改的被改了（音译、臆译）—— 有唯一正确答案，能零误报
 *   ② 实体槽：该有的没了（楼层 / 房间号 / 金额）—— 数字是确定的，能零误报
 *   ③ 性数一致：葡语硬语法错（`do segundo sala`）—— 规则清晰，能零误报
 *
 * **明确不做的**：判断"意思说错了"（如 `legendário` 应为 `legendas`）。
 * 那一类千变万化，规则写不完，只能靠"回译 + 人工待审"，**绝不自动判事故**。
 *
 * ⚠️ 两条**已知的盲区**，接进产线后仍然存在，别指望它兜住：
 *   · **专名被整段丢掉不报** —— 它只查"写错了"，不查"写没了"。
 *     实测：`Leion Pro` 在真实译文里整个消失（变成 `Esses óculos`），一条都不报，
 *     因为那条 entry 的 `zh` 是「亮亮眼镜」，原文里没这四个字，压根没进入检查。
 *   · **只查"性"，没查"数"** —— 名字叫「性数一致」，但 `ARTICLE_GENDER` 的值只有
 *     m/f，所以 `as sala`（应 `as salas`）不报。
 */

// ═══════════════════════════════════════════════════════════════════════════
// 数字归一化：中葡两种写法都要能算成同一个数
// ═══════════════════════════════════════════════════════════════════════════

const CN_DIGIT = { 〇: 0, 零: 0, 一: 1, 壹: 1, 二: 2, 两: 2, 贰: 2, 三: 3, 叁: 3, 四: 4, 肆: 4, 五: 5, 伍: 5, 六: 6, 陆: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9 }
const CN_UNIT = { 十: 10, 百: 100, 千: 1000 }

/**
 * 中文数字 → 数值。支持「十二」「三点二十」这类，也支持「十」单独一段（=10）。
 *
 * ⚠️ 单独一个「十」在中文里就是 10（`十二楼` = 12 楼），不能当成"1×10 缺少个位"。
 * 这里用 `current === 0 ? 1 : current` 处理 —— 漏掉它会把「十二楼」算成 2 楼。
 */
export function parseChineseNumber(text) {
  const chars = [...String(text)]
  if (chars.length === 0) return null
  let total = 0
  let current = 0
  let seen = false
  for (const ch of chars) {
    if (CN_DIGIT[ch] !== undefined) {
      current = current * 10 + CN_DIGIT[ch]
      seen = true
    } else if (CN_UNIT[ch] !== undefined) {
      total += (current === 0 ? 1 : current) * CN_UNIT[ch]
      current = 0
      seen = true
    } else {
      return null
    }
  }
  return seen ? total + current : null
}

const PT_NUMBER_WORDS = {
  um: 1, uma: 1, dois: 2, duas: 2, tres: 3, três: 3, quatro: 4, cinco: 5, seis: 6,
  sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12, treze: 13, quatorze: 14,
  catorze: 14, quinze: 15, dezesseis: 16, dezessete: 17, dezoito: 18, dezenove: 19,
  vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50, sessenta: 60, setenta: 70,
  oitenta: 80, noventa: 90, cem: 100, cento: 100, duzentos: 200, duzentas: 200,
  trezentos: 300, trezentas: 300, quatrocentos: 400, quatrocentas: 400,
  quinhentos: 500, quinhentas: 500, seiscentos: 600, seiscentas: 600,
  setecentos: 700, setecentas: 700, oitocentos: 800, oitocentas: 800,
  novecentos: 900, novecentas: 900,
}

/** 序数词 → 基数（「第十二楼」↔ `décimo segundo andar` 要对得上）。 */
const PT_ORDINALS = {
  primeiro: 1, primeira: 1, segundo: 2, segunda: 2, terceiro: 3, terceira: 3,
  quarto: 4, quarta: 4, quinto: 5, quinta: 5, sexto: 6, sexta: 6, setimo: 7, sétimo: 7,
  oitavo: 8, oitava: 8, nono: 9, nona: 9, decimo: 10, décimo: 10,
  'decimo primeiro': 11, 'décimo primeiro': 11, 'decimo segundo': 12, 'décimo segundo': 12,
  'decimo terceiro': 13, 'décimo terceiro': 13, 'decimo quarto': 14, 'décimo quarto': 14,
  'decimo quinto': 15, 'décimo quinto': 15, 'decimo sexto': 16, 'décimo sexto': 16,
  'decimo setimo': 17, 'décimo sétimo': 17, 'decimo oitavo': 18, 'décimo oitavo': 18,
  'decimo nono': 19, 'décimo nono': 19, vigesimo: 20, vigésimo: 20,
}

const PT_MULTIPLIER = { mil: 1000, milhao: 1000000, 'milhão': 1000000, milhoes: 1000000, 'milhões': 1000000, bilhao: 1000000000, 'bilhão': 1000000000, bilhoes: 1000000000, 'bilhões': 1000000000 }

function fold(text) {
  return String(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

/**
 * 把中葡两种写法的数字统一成**数值**，用来判"是不是同一个数"。
 *
 * 为什么需要它：光比字符串会误判。
 *   · `13,86` → `13.86`（小数点写法不同）
 *   · `2.7 亿` → `270 milhões`（**必须换算后相等**：2.7 × 10⁸ = 270 × 10⁶）
 *   · `下午三点二十` → `15h20`（时间写法完全不同）
 *   · `3980` → `trezentos e noventa e oito mil`（不过这个我**不要求**能对上：
 *     中文句里的阿拉伯数字，模型极少改成葡语单词，真出现了也只是漏报一次，不误报）
 *
 * 宁可漏、不可误：算不出确定数值就返回 null，由调用方决定"不判"。
 */
export function numberValues(text) {
  const values = new Set()
  const raw = String(text)
  const folded = fold(raw)

  // ① 阿拉伯数字 + 可选的中文/葡语量级单位
  const arabic = /(\d+(?:[.,]\d+)?)\s*(亿|万|千|百万|mil(?:hao|hão|hoes|hões)?|milh(?:ao|ão|oes|ões)|bilh(?:ao|ão|oes|ões)|mil|billion|million)?/gi
  let match
  while ((match = arabic.exec(raw)) !== null) {
    const base = Number(String(match[1]).replace(',', '.'))
    if (Number.isFinite(base) === false) continue
    values.add(base * unitOf(match[2]))
  }

  // ② 中文数字 + 量级单位（「十二楼」「2.7 亿」里的「亿」已在 ① 处理）
  const chinese = /([〇零一壹二两贰三叁四肆五伍六陆七柒八捌九玖十百千]+)\s*(亿|万|千)?/g
  while ((match = chinese.exec(raw)) !== null) {
    const base = parseChineseNumber(match[1])
    if (base === null) continue
    values.add(base * unitOf(match[2]))
  }

  // ③ 葡语数词：一台**流式累加**的小状态机（不能在中途吐中间值）
  //
  // ⚠️ 这是整份文件里踩坑最多的一处，改之前先看明白三件事：
  //
  //   1. **不能边扫边输出中间值**。`trezentos e noventa e oito mil` 里的 300、90
  //      都只是**零件** —— 在遇到 `mil` 之前谁也不知道最后是多少。
  //      所以攒在 `part` 里，只在边界上收尾。
  //
  //   2. **`e` 是数词内部的分隔符，不是从句边界**。
  //      这个坑最隐蔽：`trezentos e noventa e oito` 里的两个 `e` 如果把数词切断，
  //      就会算出 300 / 90 / 8000 三个数（而正确答案是 398000 一个）。
  //      所以"要不要收尾"看的不是"这个词认不认识"，而是
  //      **"当前是不是还在一个数词从句里"**（`inNumber`）。
  //
  //   3. **大单位要替换而不是并进 `part`**：
  //      `três mil novecentos e oitenta` = part=3 → ×1000 → part=3000 → +900 → +80 = 3980
  //      `dois mil e vinte`              = part=2 → ×1000 → 2000 → +20 = 2020
  const tokens = fold(raw).split(/[^a-z0-9.,]+/).filter(token => token !== '')
  const read = () => {
    if (part >= 1000) values.add(part)
    else pending += part
    part = 0
  }
  const flushPending = () => {
    read()
    if (pending > 0) values.add(pending)
    pending = 0
    inNumber = false
  }
  let part = 0
  let pending = 0
  let inNumber = false
  for (let index = 0; index < tokens.length; index += 1) {
    const pair = tokens[index] + ' ' + (tokens[index + 1] ?? '')
    if (PT_ORDINALS[pair] !== undefined) {
      flushPending()
      values.add(PT_ORDINALS[pair])
      index += 1
      continue
    }
    const token = tokens[index]
    const multiplier = PT_MULTIPLIER[token]
    if (multiplier !== undefined) {
      part = (part === 0 ? 1 : part) * multiplier
      inNumber = true
      continue
    }
    const word = PT_NUMBER_WORDS[token]
    if (word !== undefined) {
      part += word
      inNumber = true
      continue
    }
    const ordinal = PT_ORDINALS[token]
    if (ordinal !== undefined) {
      flushPending()
      values.add(ordinal)
      continue
    }
    // 非数词：只有**已经不在数词从句里**时才是真边界。
    // 还在从句里的话，这个词多半是 `e` 这类连接词 —— 继续累积。
    if (inNumber === false && (part > 0 || pending > 0)) flushPending()
  }
  flushPending()
  return values
}

function unitOf(unit) {
  if (unit === undefined || unit === null || unit === '') return 1
  const key = String(unit).toLowerCase()
  if (key === '亿') return 100000000
  if (key === '万') return 10000
  if (key === '千') return 1000
  if (key === '百万') return 1000000
  if (key === 'mil') return 1000
  if (/^milh/.test(key)) return 1000000
  if (/^bilh/.test(key)) return 1000000000
  if (key === 'million') return 1000000
  if (key === 'billion') return 1000000000
  return 1
}

/** 原文里的这个数，译文里有没有（数值相等就算有，写法随便）。 */
export function hasNumber(sourceText, translationText) {
  const wanted = numberValues(sourceText)
  const got = numberValues(translationText)
  for (const value of wanted) {
    for (const other of got) {
      if (value === other) return true
      // 容差：小数点四舍五入带来的极小差异不算错
      if (Math.abs(value - other) < 1e-6 * Math.max(1, Math.abs(value))) return true
    }
  }
  return false
}

// ═══════════════════════════════════════════════════════════════════════════
// ① 专名：不该改的被改了
// ═══════════════════════════════════════════════════════════════════════════

/** 去掉一切非字母，只留字母，用来比"是不是同一个拉丁写法"。 */
function latinKey(text) {
  return fold(text).replace(/[^a-z]/g, '')
}

/**
 * 专名检查：原文点名了某个专名，译文里**既不是认可写法、也没保留原文**时报警。
 *
 * 为什么这条能零误报：只允许两种正确情形 ——
 *   ① 用了认可写法之一（`LLVision`）；② 原样保留中文（`亮亮视野`）。
 * 出现**任何别的拉丁写法**（`Liangliang Vision`）就是新造译名 → 报。
 * 同传里新造译名是硬伤：对方看到 `Liangliang Vision` 根本不知道是哪家公司。
 *
 * ⚠️ 还有一个**警告级**的情形：译文用了认可写法，但那是模型的**先验知识**、
 * 不是从原文推出来的（DeepSeek 把「亮亮视野」写成 `LLVision` 就是蹭对的）。
 * 这不算事故（结果对），但要让人知道它不可控 —— 换个不有名的公司名它就会音译。
 */
export function properNounProblems(source, translation, nouns) {
  const notes = []
  const sourceText = String(source)
  const translationText = String(translation)
  const translationKey = latinKey(translationText)
  for (const entry of nouns ?? []) {
    if (sourceText.includes(entry.zh) === false) continue
    const approved = (entry.approved ?? []).map(item => latinKey(item))
    const hit = approved.filter(key => key !== '' && translationKey.includes(key))
    if (hit.length > 0) {
      // 「蹭对」这个警告只对**有名到模型能自己想起来**的专名才有意义
      // （`亮亮视野 → LLVision` 是模型先验知识，不是从原文推的）。
      // 而「高通 → Qualcomm」这种是**正常翻译**，每次都报就变成噪音了 ——
      // 噪音的代价是让人开始忽略警告，那比不报还糟。所以由数据决定报不报。
      if (entry.warnWhenApproved === true) {
        notes.push({ level: 'warn', kind: '专名蹭对',
          text: `专名「${entry.zh}」译成了认可写法（${entry.approved.join(' / ')}）—— 结果对，`
            + '但这是模型的先验知识，不是从原文推出来的；换个不有名的名字它就会音译' })
      }
      continue
    }
    // 原样保留了中文 → 不算错（译成中文方向、或刻意不译）
    if (translationText.includes(entry.zh)) continue
    // 译文里出现了"听着像这个名字"的拉丁写法 → 新造译名
    // ⚠️ 要求至少 4 个字母：太短的串会在无关单词里误命中（误报比漏报危险得多）。
    const foreign = (entry.soundsLike ?? []).filter(sound =>
      latinKey(sound).length >= 4 && translationKey.includes(latinKey(sound)))
    if (foreign.length > 0) {
      notes.push({ level: 'bad', kind: '专名新造',
        text: `专名「${entry.zh}」被译成了新造的拉丁写法（认可写法是 ${(entry.approved ?? []).join(' / ')}）`
          + ' —— 对方看到这个写法认不出是哪家公司' })
    }
  }
  return notes
}

// ═══════════════════════════════════════════════════════════════════════════
// ② 实体槽：该有的没了
// ═══════════════════════════════════════════════════════════════════════════

const CN_NUM = '〇零一壹二两贰三叁四肆五伍六陆七柒八捌九玖十百千'

/**
 * 抽"楼层槽"：`十二楼` / `12楼` / `八楼的 802 房间` 里的楼层数。
 *
 * 为什么楼层是最好的一类槽：**数字是确定的**，12 楼就是 12 楼，
 * 而且原文里楼层数与译文里楼层数必须一一对上 —— 不会误报。
 * 实测抓到的真错：Qwen2.5 把「从十二楼的第二会议室换到八楼 802」
 * 译成 `o local foi mudado para o quarto 802 no oitavo andar` ——
 * **整个原来的地点（12 楼）没了**。
 */
export function floorSlots(source) {
  const out = []
  const text = String(source)
  const re = new RegExp(`(\\d{1,3}|[${CN_NUM}]{1,6})\\s*(?:楼|層|层|樓)`, 'g')
  let match
  while ((match = re.exec(text)) !== null) {
    const value = /^\d+$/.test(match[1]) ? Number(match[1]) : parseChineseNumber(match[1])
    if (value !== null && value > 0 && value < 200) out.push(value)
  }
  return out
}

/**
 * 抽"房间号槽"：3~4 位数字（`802`、`1201`）。只认**独立出现**的数字，
 * 且必须有"房间/会议室/室/号"这类词跟着，免得把金额、电话、年份也当成房间号。
 */
export function roomSlots(source) {
  const out = []
  const text = String(source)
  const re = /(?:房间|会议室|室|房|号)\s*(\d{3,4})|(\d{3,4})\s*(?:房间|会议室|室|号)/g
  let match
  while ((match = re.exec(text)) !== null) {
    out.push(Number(match[1] ?? match[2]))
  }
  return out
}

/** 实体槽完整性：原文有的槽，译文里必须能对上（数值相等即可，写法随便）。 */
export function slotProblems(source, translation) {
  const notes = []
  const translationText = String(translation)

  const floors = floorSlots(source)
  if (floors.length > 0) {
    const missing = floors.filter(value => hasNumber(String(value), translationText) === false)
    if (missing.length > 0) {
      notes.push({ level: 'bad', kind: '楼层丢失',
        text: `楼层丢了：原文提到 ${missing.map(value => value + ' 楼').join('、')}，译文里找不到对应数字`
          + '（地点信息在同传里丢了比语法错严重）' })
    }
  }

  const rooms = roomSlots(source)
  if (rooms.length > 0) {
    const missing = rooms.filter(value => hasNumber(String(value), translationText) === false)
    if (missing.length > 0) {
      notes.push({ level: 'bad', kind: '房间号丢失',
        text: `房间号丢了：原文提到 ${missing.join('、')}，译文里找不到` })
    }
  }

  return notes
}

// ═══════════════════════════════════════════════════════════════════════════
// ③ 性数一致：葡语硬语法错
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 只覆盖**形态明确**的冠词与序数词 —— 这样才能从词形反推出名词的性。
 *
 * ⚠️ 刻意**不收 `a`**：它既是阴性冠词又是介词（「para a sala」里是冠词，
 *    但「a gente vai」「daqui a pouco」里不是），从词形分不出，硬判必然误报。
 *    `o` / `os` / `as` 与各类缩合冠词（`do/da/no/na/…`）形态明确，判了就准。
 *
 * ⚠️ 另一个实测教训：一开始连 `o` 都没收（怕它跟 `a` 一样歧义），
 *    结果漏报了 `para **o** sala 802`（sala 是阴性，应为 `para a sala`）——
 *    而 `o` 只可能是阳性冠词，没有歧义，不收纯粹是自己吓自己。
 */
const ARTICLE_GENDER = {
  o: 'm', os: 'm', as: 'f',
  do: 'm', da: 'f', dos: 'm', das: 'f',
  no: 'm', na: 'f', nos: 'm', nas: 'f',
  este: 'm', esta: 'f', estes: 'm', estas: 'f',
  esse: 'm', essa: 'f', esses: 'm', essas: 'f',
  aquele: 'm', aquela: 'f', aqueles: 'm', aquelas: 'f',
  um: 'm', uma: 'f', uns: 'm', umas: 'f',
}

const ORDINAL_FORM = {
  primeiro: 'm', primeira: 'f', segundo: 'm', segunda: 'f', terceiro: 'm', terceira: 'f',
  quarto: 'm', quarta: 'f', quinto: 'm', quinta: 'f', sexto: 'm', sexta: 'f',
  setimo: 'm', 'sétimo': 'm', setima: 'f', 'sétima': 'f', oitavo: 'm', oitava: 'f',
  nono: 'm', nona: 'f', decimo: 'm', 'décimo': 'm', decima: 'f', 'décima': 'f',
}

/**
 * 抽"名词的性"：从 policy 的词表里查。查不到就返回 null（**不判**）。
 *
 * ⚠️ 这张表必然不全，所以判据只在"查得到且对不上"时才报 —— 查不到一律放过。
 * 这就是"宁可不报，不可误报"在这层的落实。
 */
function genderOf(word, genders) {
  const key = fold(word).replace(/[^a-z]/g, '')
  if (key === '') return null
  const value = genders[key]
  return value === 'm' || value === 'f' ? value : null
}

/**
 * 性数一致：`do segundo sala` 这种错。`sala`（房间）是阴性，
 * 应该是 `da segunda sala` —— 实测 Hunyuan-MT 就这么译错了。
 *
 * 只扫两种高置信度模式：
 *   · 冠词/缩合冠词 + 名词          → 性必须一致
 *   · 冠词 + 序数词 + 名词          → 三者性都必须一致
 * 其余一律不碰。
 */
export function agreementProblems(translation, genders) {
  const notes = []
  const words = String(translation).split(/[^\p{L}]+/u).filter(word => word !== '')
  for (let index = 0; index < words.length; index += 1) {
    const article = ARTICLE_GENDER[fold(words[index])]
    if (article === undefined) continue

    let cursor = index + 1
    let ordinalGender = null
    const ordinalWord = words[cursor] === undefined ? '' : fold(words[cursor])
    if (ORDINAL_FORM[ordinalWord] !== undefined) {
      ordinalGender = ORDINAL_FORM[ordinalWord]
      cursor += 1
    }
    const noun = words[cursor]
    if (noun === undefined) continue
    const nounGender = genderOf(noun, genders)

    if (ordinalGender !== null && ordinalGender !== article) {
      notes.push({ level: 'bad', kind: '性数不一致',
        text: `性数不一致：「${words[index]} ${words[cursor - 1]}」里冠词是 ${article === 'm' ? '阳' : '阴'}性，`
          + `序数词却是 ${ordinalGender === 'm' ? '阳' : '阴'}性` })
      // ⚠️ 这里**不能 continue**：同一个冠词后面可能同时有"序数词错"和"名词错"
      //    （实测 `do segundo auditório ... para o sala 802` 就是两处都错，
      //     短路掉名词检查会漏报后面那处）。继续往下查。
    }
    if (nounGender !== null && nounGender !== article) {
      notes.push({ level: 'bad', kind: '性数不一致',
        text: `性数不一致：「${words[index]} ${noun}」—— ${noun} 是 ${nounGender === 'm' ? '阳' : '阴'}性，`
          + `却配了 ${article === 'm' ? '阳' : '阴'}性冠词` })
    }
  }
  return notes
}

// ═══════════════════════════════════════════════════════════════════════════
// 汇总
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 跑全部三层，返回 { fatal, warn, notes }。
 *
 * `fatal` 里的每一项都对应一个**词汇级的确定错**（不是"我觉得不好"）。
 * 判定标准写在这儿，是为了让"为什么这条算事故"永远可追溯 ——
 * 而不是散在代码各处的魔法字符串里。
 */
export function lintTranslation(source, translation, policy) {
  const notes = []
  notes.push(...properNounProblems(source, translation, policy.properNouns))
  notes.push(...slotProblems(source, translation))
  notes.push(...agreementProblems(translation, policy.nounGenders ?? {}))

  // 量级错（2.7 亿 → 2,7 bilhões，差 10 倍）也归到这里 ——
  // 它和楼层丢失是同一类：数字是确定的，错了就是错了。
  const magnitude = magnitudeProblem(source, translation)
  if (magnitude !== null) notes.push({ level: 'bad', kind: '量级错', text: magnitude })

  return {
    fatal: notes.filter(note => note.level === 'bad'),
    warn: notes.filter(note => note.level === 'warn'),
    notes,
  }
}

function magnitudeProblem(source, translation) {
  const src = String(source)
  const target = fold(translation)
  if (src.includes('十亿')) return null
  if (/(\d+(?:[.,]\d+)?|[〇零一壹二两贰三叁四肆五伍六陆七柒八捌九玖十百千]+)\s*亿/.test(src) === false) return null
  if (/bilh(ao|oes)/.test(target)) {
    return '量级可能译错：原文是「亿」（10⁸），却译成了 bilhão/bilhões（10⁹，即十亿）——'
      + '实测 Qwen2.5 把「2.7 亿」译成 `2,7 bilhões`，而它自己另一句译成了 270 milhões'
  }
  return null
}
