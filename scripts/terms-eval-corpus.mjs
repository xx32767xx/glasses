/**
 * terms-eval-corpus.mjs —— 热词替换的**验收集**（docs/15 §10.4）
 * ============================================================================
 *
 * 为什么单独一套、而不是直接用 `test-phrases.mjs` 那 18 句：
 * 那 18 句里**只有 1 句**点了表内的名字（实测），拿它算"实体缺失率"分母只有个位数。
 * 这个指标的精度完全由分母决定，所以必须专门造句子。
 *
 * 三类必须同时存在（缺一类，结论就会失真）：
 *
 *   dense    专名密集句：每句 1~3 个真名，含"同名出现两次""名字在句首/句中/句尾"
 *   trap     陷阱普通句：含 `高通量`/`equipamentos`/`secretaria`/`São`/`Sao` 这类**容易误命中**的词
 *            —— 它们不点名任何表内实体，所以**正确行为是"一个字都不改"**
 *   holdout  留出集：标了 `holdout: true`，**不参与规则调整**，只在最后跑一次
 *
 * 每条都标注了"该出现什么"，因为 docs/15 §10.1 的主指标是
 * **实体缺失率 = 缺失的实体提及次数 / 应保留的实体提及次数** —— 没有标注就算不出来。
 *
 * ⚠️ 标注里的 `allowMissing` 是"合法缺席"：中文「我跟王工说了」译成
 * `Falei com ele` 是**正确译法**，不该被算成缺失（docs/15 §12.3 第 3 条）。
 * 这类样本必须在标注里显式写明，否则指标会系统性偏高。
 */

/**
 * 本验收集使用的热词表。**故意包含**：
 *   · 一个"两侧同名、原样保留"的条目（Leion Pro）
 *   · 一个 2 字中文名（高通）—— 它是 `高通量` 陷阱的来源
 *   · 一个带空格的拉丁名（Snapdragon 8 Gen 3）—— 考"空格折叠"
 *   · 一个地名（圣保罗）—— 考"重音折叠"（São Paulo / Sao Paulo）
 */
export const EVAL_TABLE = [
  { zh: '亮亮视野', pt: 'LLVision' },
  { zh: '亮亮眼镜', pt: 'Leion' },
  { zh: 'Leion Pro', pt: 'Leion Pro' },              // 两侧同名：只该记 hit
  { zh: '高通', pt: 'Qualcomm' },                     // 2 字：boundary_skip 的来源
  { zh: '骁龙 8 Gen 3', pt: 'Snapdragon 8 Gen 3' },
  { zh: '安卓', pt: 'Android' },
  { zh: '圣保罗', pt: 'São Paulo' },
  { zh: '清华大学', pt: 'Universidade Tsinghua' },
  { zh: '王工', pt: 'o engenheiro Wang' },
]

/** 一句话里出现的实体提及（标注的最小单位：**一次提及**，不是一句）。 */
const m = (zh, pt, kind = 'company') => ({ zh, pt, kind })

/**
 * 专名密集句。`mentions` 里每一项都是一次"应当保留"的实体提及。
 * `allowMissing` 列出"这次提及允许不出现"的下标（0 起），并有 why 说明为什么合法。
 */
export const DENSE = [
  {
    id: 'd01',
    source: '亮亮视野今年把重点放在了中葡同传这条产品线上。',
    mentions: [m('亮亮视野', 'LLVision')],
    why: '最基础的一句：原文点名，译文里应当出现 LLVision',
  },
  {
    id: 'd02',
    source: '这款眼镜叫 Leion Pro，是我们和亮亮视野一起做的。',
    mentions: [m('Leion Pro', 'Leion Pro', 'product'), m('亮亮视野', 'LLVision')],
    why: '一句两个实体；而且 Leion Pro 是"两侧同名"的条目，只该记 hit 不改字',
  },
  {
    id: 'd03',
    source: '亮亮视野的人说，Leion Pro 会在下个季度更新固件。',
    mentions: [m('亮亮视野', 'LLVision'), m('Leion Pro', 'Leion Pro', 'product')],
    why: '名字在句首 + 句中，考"每处都替换而不是只换第一处"',
  },
  {
    id: 'd04',
    source: '我们用的是高通的芯片，不是自己做的。',
    mentions: [m('高通', 'Qualcomm')],
    why: '2 字中文名，后面跟动词（发布/用）—— 这是 boundary_skip 不该触发的情形',
  },
  {
    id: 'd05',
    source: '这颗芯片是高通去年发布的骁龙 8 Gen 3。',
    mentions: [m('高通', 'Qualcomm'), m('骁龙 8 Gen 3', 'Snapdragon 8 Gen 3', 'product')],
    why: '一句里一个 2 字名 + 一个带空格的型号名（考空格折叠）',
  },
  {
    id: 'd06',
    source: '我们的 App 同时支持安卓和 iOS，安卓端做了一些适配。',
    mentions: [m('安卓', 'Android', 'platform'), m('安卓', 'Android', 'platform')],
    why: '同一次提及出现两次 → 按**次数**统计才看得出漏了几个',
  },
  {
    id: 'd07',
    source: '团队下周去圣保罗参加一个行业展会。',
    mentions: [m('圣保罗', 'São Paulo', 'place')],
    why: '地名，考重音折叠（模型常写 Sao Paulo 或 São Paulo 两种）',
  },
  {
    id: 'd08',
    source: '这个项目是清华大学和我们联合申报的。',
    mentions: [m('清华大学', 'Universidade Tsinghua', 'org')],
    why: '机构名，模型容易只写 Tsinghua 或干脆译成"一所大学"',
  },
  {
    id: 'd09',
    source: '王工负责这一块的硬件选型，具体问题可以问他。',
    mentions: [m('王工', 'o engenheiro Wang', 'person'), m('王工', 'o engenheiro Wang', 'person')],
    allowMissing: [1],
    why: '第二次只是"问他"，译成代词完全正确 —— 这条用来防止指标把合法省略算成缺失',
  },
  {
    id: 'd10',
    source: '亮亮视野的 Leion Pro 和亮亮眼镜都用同一套显示方案。',
    mentions: [m('亮亮视野', 'LLVision'), m('Leion Pro', 'Leion Pro', 'product'), m('亮亮眼镜', 'Leion', 'product')],
    why: '三个实体挤一句（§12.2 的"术语密集"情形），看会不会顾此失彼',
  },
  {
    id: 'd11',
    source: '我们在安卓上做过一版原型，跑在骁龙 8 Gen 3 上很流畅。',
    mentions: [m('安卓', 'Android', 'platform'), m('骁龙 8 Gen 3', 'Snapdragon 8 Gen 3', 'product')],
    why: '平台名 + 型号名；型号里有空格和数字，最容易在折叠时出问题',
  },
  {
    id: 'd12',
    source: '上周高通的人来我们这边做了一次技术交流。',
    mentions: [m('高通', 'Qualcomm')],
    why: '2 字名 + "的人"—— 邻居是"的"，属于允许的情形',
  },
  {
    id: 'd13',
    source: '这次合作是亮亮视野牵头的，圣保罗那边也有同事参与。',
    mentions: [m('亮亮视野', 'LLVision'), m('圣保罗', 'São Paulo', 'place')],
    why: '两个实体分处前后半句，中间有标点',
  },
  {
    id: 'd14',
    source: 'Leion Pro 的固件更新会先推给安卓用户，再推给 iOS。',
    mentions: [m('Leion Pro', 'Leion Pro', 'product'), m('安卓', 'Android', 'platform')],
    why: '名字在句首（行首边界）+ 句中',
  },
  {
    id: 'd15',
    source: '王工以前在清华大学做过三年研究，后来去了高通。',
    mentions: [m('王工', 'o engenheiro Wang', 'person'), m('清华大学', 'Universidade Tsinghua', 'org'), m('高通', 'Qualcomm')],
    why: '一句三个人名/机构名，考"最多要求几个"的实际分布',
  },
  {
    id: 'd16',
    source: '亮亮眼镜这个产品线是亮亮视野最老的一条线了。',
    mentions: [m('亮亮眼镜', 'Leion', 'product'), m('亮亮视野', 'LLVision')],
    why: '两个名字互为前缀关系（亮亮眼镜 / 亮亮视野）—— 考"最长匹配会不会串"',
  },
  {
    id: 'd17',
    source: '我们在圣保罗和北京的团队都要参加这次评审。',
    mentions: [m('圣保罗', 'São Paulo', 'place')],
    why: '地名 + 另一个没进表的地名（北京）—— 不该因为"表里没有"就动它',
  },
  {
    id: 'd18',
    source: '骁龙 8 Gen 3 的算力对我们这个模型来说已经够用了。',
    mentions: [m('骁龙 8 Gen 3', 'Snapdragon 8 Gen 3', 'product')],
    why: '名字在句首，且中间有空格 → 考"行首 + 空格"两个边界同时成立',
  },
  {
    id: 'd19',
    source: '安卓端的适配是王工做的，iOS 那边还在排期。',
    mentions: [m('安卓', 'Android', 'platform'), m('王工', 'o engenheiro Wang', 'person')],
    why: '两个不同类别的实体（平台 vs 人）',
  },
  {
    id: 'd20',
    source: '亮亮视野和清华大学有一个联合实验室，就在圣保罗。',
    mentions: [m('亮亮视野', 'LLVision'), m('清华大学', 'Universidade Tsinghua', 'org'), m('圣保罗', 'São Paulo', 'place')],
    why: '三个实体的长句（§10.4 里"专名密集"的最坏情形）',
  },
  {
    id: 'd21',
    source: '这版固件只支持 Leion Pro，亮亮眼镜那台暂时不升级。',
    mentions: [m('Leion Pro', 'Leion Pro', 'product'), m('亮亮眼镜', 'Leion', 'product')],
    why: '两个产品名，且 Leion Pro 与 Leion 是"包含关系"（考实体重叠规则）',
  },
  {
    id: 'd22',
    source: '高通和我们是长期合作，骁龙 8 Gen 3 就是一起调通的。',
    mentions: [m('高通', 'Qualcomm'), m('骁龙 8 Gen 3', 'Snapdragon 8 Gen 3', 'product')],
    why: '2 字名 + 型号名同句，且 2 字名后面跟"和"',
  },
  {
    id: 'd23',
    source: '我在亮亮视野工作了四年，一直在做眼镜这一块。',
    mentions: [m('亮亮视野', 'LLVision')],
    why: '名字在句中，前后都是虚词（在…工作）',
  },
  {
    id: 'd25',
    source: '安卓系统这两年更新很快，但碎片化还是问题。',
    mentions: [m('安卓', 'Android', 'platform')],
    why: '平台名在句首；这一条与陷阱句方向相反 —— 它**该**被替换，用来对照',
  },
  {
    id: 'd24',
    source: '这次展会在圣保罗办，清华大学也会派人过去。',
    mentions: [m('圣保罗', 'São Paulo', 'place'), m('清华大学', 'Universidade Tsinghua', 'org')],
    why: '地名 + 机构名，且都在后半句',
  },
]

/**
 * 陷阱普通句：**不该有任何替换**。
 *
 * 它们存在的意义是给"误替换"这一个数当分母 —— 没有这一类，
 * "误替换 = 0"就永远成立，因为没人试过能让它出错的东西。
 */
export const TRAP = [
  { id: 't01', source: '这是一个高通量的实验，一天要跑几千个样本。', why: '`高通量` 里含 `高通`（boundary_skip 应当拦住）' },
  { id: 't02', source: '数据走高通路传回服务器，延迟很低。', why: '`高通路` 里含 `高通`' },
  { id: 't03', source: '我们要采购一批新的 equipamentos 给工厂。', why: '`equipa` 是 `equipamentos` 的子串（葡语侧词边界）' },
  { id: 't04', source: '这批设备的价格比去年高了不少。', why: '句中无任何表内实体' },
  { id: 't05', source: '秘书处的那份材料请在明天之前发给我。', why: '`秘书处` 与 `secretaria` 的折叠歧义（表里没有这一条，不该动）' },
  { id: 't06', source: '他昨天在圣保罗州立大学做了一场讲座。', why: '`圣保罗` 出现在更长的机构名里 —— 是否替换属于边界判断，必须记录而不是静默' },
  { id: 't07', source: '这个季度的收入比预期高了百分之十二。', why: '纯数字句，不该被任何术语规则碰到' },
  { id: 't08', source: '我们下周开始用新的会议室，在八楼 802。', why: '数字 + 地点，但没有表内实体' },
  { id: 't10', source: 'LeionX 是我们内部的一个代号，还没对外公布。', why: '`LeionX` 里含 `Leion`（词边界：不该命中）' },
]

/** 留出集：与上面同类，但**不参与规则调整**，只在最后跑一次。 */
export const HOLDOUT = [
  {
    id: 'h01',
    holdout: true,
    source: '亮亮视野在圣保罗的办公室明年会扩到三十人。',
    mentions: [m('亮亮视野', 'LLVision'), m('圣保罗', 'São Paulo', 'place')],
    why: '两个实体、一个在句首一个在中段',
  },
  {
    id: 'h02',
    holdout: true,
    source: '骁龙 8 Gen 3 相比上一代最大的提升在能效比。',
    mentions: [m('骁龙 8 Gen 3', 'Snapdragon 8 Gen 3', 'product')],
    why: '型号名在句首（行首边界）',
  },
  {
    id: 'h03',
    holdout: true,
    source: '王工觉得安卓端的适配比 iOS 好做，因为接口更开放。',
    mentions: [m('王工', 'o engenheiro Wang', 'person'), m('安卓', 'Android', 'platform')],
    why: '人 + 平台；且第二个实体在"比…好做"的结构里',
  },
  {
    id: 'h04',
    holdout: true,
    source: '这套方案先在亮亮眼镜上验证，再推到 Leion Pro。',
    mentions: [m('亮亮眼镜', 'Leion', 'product'), m('Leion Pro', 'Leion Pro', 'product')],
    why: '两个产品名（与 d21 同类但句式不同，用于检查是不是只对某一种句式有效）',
  },
  {
    id: 'h05',
    holdout: true,
    source: '清华大学那边希望我们下个月去一趟北京做汇报。',
    mentions: [m('清华大学', 'Universidade Tsinghua', 'org')],
    why: '机构名 + 一个没进表的地名（北京）',
  },
  {
    id: 'h06',
    holdout: true,
    source: '在圣保罗那场展会上，高通也展示了他们的新芯片。',
    mentions: [m('圣保罗', 'São Paulo', 'place'), m('高通', 'Qualcomm')],
    why: '地名 + 2 字名，且都在"在…上"结构里',
  },
  {
    id: 'h07',
    holdout: true,
    source: '我们要评估一下高通的方案和自研方案的差距有多大。',
    mentions: [m('高通', 'Qualcomm')],
    why: '2 字名在"一下…的"中间（邻居是"的"和"的"）',
  },
  {
    id: 'h08',
    holdout: true,
    source: '这条产品线原来是亮亮视野内部的实验项目，后来独立了。',
    mentions: [m('亮亮视野', 'LLVision')],
    why: '名字后面接"内部的"—— 邻居"内"',
  },
  {
    id: 'h09',
    holdout: true,
    source: '他提到 equipamento 这个词在巴葡里更常用。',
    mentions: [],
    why: '陷阱句：`equipamento` 含 `equipamentos` 的前缀，葡语侧不该命中',
  },
  {
    id: 'h10',
    holdout: true,
    source: '这次谈判在圣保罗进行，对方是当地的运营商。',
    mentions: [m('圣保罗', 'São Paulo', 'place')],
    why: '地名在句中，前后都是动词/虚词',
  },
]

/** 全部条目（含分类），供脚本与测试使用。 */
export const ALL_ITEMS = [
  ...DENSE.map(item => ({ ...item, cls: 'dense' })),
  ...TRAP.map(item => ({ ...item, cls: 'trap', mentions: item.mentions ?? [] })),
  ...HOLDOUT.map(item => ({ ...item, cls: 'dense', holdout: true })),
]

/**
 * 验收集的"卫生检查"（docs/14 的评测包纪律：宁可报错，也不要悄悄跑出一个假数）。
 *
 * @returns {string[]} 问题列表；空数组表示没问题
 */
export function checkCorpus(items = ALL_ITEMS) {
  const problems = []
  const ids = new Set()
  for (const item of items) {
    if (typeof item.id !== 'string' || item.id === '') problems.push('有条目缺 id')
    else if (ids.has(item.id)) problems.push(`id 重复：${item.id}`)
    else ids.add(item.id)
    if (typeof item.source !== 'string' || item.source.trim() === '') problems.push(`${item.id} 缺 source`)
    if (typeof item.why !== 'string' || item.why === '') problems.push(`${item.id} 缺 why（这条测的是什么）`)
    for (const [index, mention] of (item.mentions ?? []).entries()) {
      if (typeof mention.zh !== 'string' || mention.zh === '') problems.push(`${item.id} 第 ${index} 个标注缺 zh`)
      if (typeof mention.pt !== 'string' || mention.pt === '') problems.push(`${item.id} 第 ${index} 个标注缺 pt`)
      if (item.source.includes(mention.zh) === false) {
        problems.push(`${item.id} 标注了「${mention.zh}」，但原文里没有这个词`)
      }
    }
    for (const index of (item.allowMissing ?? [])) {
      if (index >= (item.mentions ?? []).length) problems.push(`${item.id} 的 allowMissing 下标越界：${index}`)
    }
  }

  // 三类都得有，否则结论会失真（这是这个文件存在的理由）
  const dense = items.filter(item => item.cls === 'dense' && item.holdout !== true)
  const trap = items.filter(item => item.cls === 'trap')
  const holdout = items.filter(item => item.holdout === true)
  if (dense.length < 15) problems.push(`专名密集句只有 ${dense.length} 条（至少 15）`)
  if (trap.length < 5) problems.push(`陷阱普通句只有 ${trap.length} 条（至少 5）`)
  if (holdout.length < 5) problems.push(`留出集只有 ${holdout.length} 条（至少 5）`)

  // 分母要够大：实体提及总数不够，缺失率就是个噪声
  const mentions = dense.reduce((sum, item) => sum + item.mentions.length, 0)
  if (mentions < 30) problems.push(`专名密集句里只有 ${mentions} 次实体提及（至少 30 次）`)

  return problems
}

/** 表里每条都要能通过真实校验（防止"测试用的表根本不合法"这种自欺）。 */
export const CORPUS_VERSION = 1
