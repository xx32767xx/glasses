/**
 * terms-matcher-suite.mjs —— 热词匹配器（阶段 2）
 * ============================================================================
 *
 * 这一层的唯一职责：**已知变体 → 规范写法**，纯字符串，零模型调用。
 * 所以这里的每一条都不需要网络、不需要模型，跑得飞快 —— 也正因为如此，
 * 它可以被穷举到"每个坑都钉死"的程度。
 *
 * 结构对着 docs/15 §10.2 的 8 条负对照，**成对**验证：
 *   左边："该换的换了没有"（否则功能等于没做）
 *   右边："不该换的一个都没换"（否则会把句子改坏，那比不做更糟）
 */

import { applyTerms, buildIndex, foldForMatch } from '../lib/terms-matcher.mjs'
import { validateTerms } from '../lib/terms.mjs'

/** 造一张合法的表（走真实校验，避免"测试用的表根本不合法"这种自欺）。 */
function table(entries) {
  const checked = validateTerms(entries)
  if (checked.ok !== true) throw new Error('测试表本身不合法：' + JSON.stringify(checked.rejected))
  return checked.entries
}

const run = (text, entries, from) => applyTerms(text, { entries, from })

export async function runTermsMatcherSuite({ it, check, assert }) {
  // ── 1. 葡语词边界 ──────────────────────────────────────────────────────
  await it('负对照①：`equipa` 不命中 `equipamentos`（词边界）', () => {
    const entries = table([{ zh: '团队', pt: 'equipa' }])
    const bad = run('Compramos equipamentos novos.', entries, 'pt-BR')
    check('长词里不许命中', bad.text === 'Compramos equipamentos novos.', bad.text)
    check('没有产生替换事件', bad.events.every(e => e.event !== 'replace'), JSON.stringify(bad.events))
    const good = run('A nossa equipa cresceu.', entries, 'pt-BR')
    check('整词命中并替换', good.events.some(e => e.event === 'replace'), JSON.stringify(good.events))
  })

  await it('葡语边界：标点/行首行尾算边界，连写的长词边界不算', () => {
    const entries = table([{ zh: '团队', pt: 'equipa' }])
    for (const text of ['equipa.', 'equipa!', 'a equipa', 'equipa']) {
      const result = run(text, entries, 'pt-BR')
      check(`「${text}」应当命中`, result.events.some(e => e.event === 'replace'), JSON.stringify(result.events))
    }
    const joined = run('equipas', entries, 'pt-BR')
    check('复数 `equipas` 不许被当成词边界外命中', joined.events.length === 0, JSON.stringify(joined.events))
  })

  // ── 2. 实体重叠（最长优先盖不住的那一类）───────────────────────────────
  await it('负对照②：`Leion` 在 `Leion Pro` 里不许单独命中（实体重叠）', () => {
    const entries = table([
      { zh: '亮亮眼镜', pt: 'Leion Pro' },
      { zh: '亮亮', pt: 'Leion' },
    ])
    const result = run('Comprei o Leion Pro ontem.', entries, 'pt-BR')
    check('只换长的那条', result.text === 'Comprei o 亮亮眼镜 ontem.', result.text)
    const replaced = result.events.filter(e => e.event === 'replace')
    check('只产生一次替换', replaced.length === 1, JSON.stringify(result.events))
    check('换的是长的那个条目', replaced[0].to === '亮亮眼镜', JSON.stringify(replaced[0]))
    // 反过来：只有 Leion 时它当然该命中
    const onlyShort = table([{ zh: '亮亮', pt: 'Leion' }])
    const short = run('Comprei o Leion ontem.', onlyShort, 'pt-BR')
    check('表里没有长条目时短条目正常命中', short.text === 'Comprei o 亮亮 ontem.', short.text)
  })

  await it('同一实体在一句里出现多次：每一处都换（不要只换第一处）', () => {
    const entries = table([{ zh: '亮亮视野', pt: 'LLVision' }])
    const result = run('LLVision cresceu, e a LLVision contratou mais gente.', entries, 'pt-BR')
    check('两处都换', result.text === '亮亮视野 cresceu, e a 亮亮视野 contratou mais gente.', result.text)
    check('产生两次替换', result.events.filter(e => e.event === 'replace').length === 2,
      JSON.stringify(result.events.map(e => e.event)))
    const index = buildIndex(entries)
    check('索引按方向分开', index.ptToZh.length > 0 && index.zhToPt.length > 0)
  })

  // ── 3. 中文边界 ────────────────────────────────────────────────────────
  await it('负对照③：`高通` 不命中 `高通量` / `高通路`（中文边界，2 字条目强制）', () => {
    const entries = table([{ zh: '高通', pt: 'Qualcomm' }])
    for (const text of ['这是一个高通量的实验。', '走了高通路。']) {
      const result = run(text, entries, 'zh-CN')
      check(`「${text}」不许替换`, result.text === text, result.text)
      check('记了 boundary_skip（可审计）', result.events.some(e => e.event === 'boundary_skip'), JSON.stringify(result.events))
    }
    // 同一个词在正常句子里必须换 —— 否则规则等于"全部跳过"
    const good = run('高通发布了新的芯片。', entries, 'zh-CN')
    check('正常用法照常替换', good.text === 'Qualcomm发布了新的芯片。', good.text)
  })

  await it('中文边界不误伤长名字：`北京亮亮视野科技有限公司` 里替换的是整串 4 字名', () => {
    const entries = table([{ zh: '亮亮视野', pt: 'LLVision' }])
    const result = run('北京亮亮视野科技有限公司', entries, 'zh-CN')
    check('替换了 4 字名', result.text === '北京LLVision科技有限公司', result.text)
  })

  // ── 4. 折叠与关闭折叠 ──────────────────────────────────────────────────
  await it('折叠：大小写/重音/空格都算同一个名字，且输出永远是用户写的规范形式', () => {
    const entries = table([{ zh: '亮亮视野', pt: 'LLVision' }])
    const entries2 = table([{ zh: '亮亮眼镜', pt: 'Leion Pro' }])
    const cases = [
      ['leion pro', '亮亮眼镜'],
      ['LEION PRO', '亮亮眼镜'],
      ['LeionPro', '亮亮眼镜'],
    ]
    for (const [variant, expected] of cases) {
      const result = run(variant, entries2, 'pt-BR')
      check(`「${variant}」应被收敛成「${expected}」`, result.text === expected, result.text)
    }

    // 同语种归一（生产路径）：折叠只负责"找得到"，must 要求"输出规范写法" ——
    // 只差大小写/重音/空格的变体也必须改掉（`llvision` → `LLVision`），不能只记 hit。
    const norm = (text, entries) => applyTerms(text, { entries, mode: 'normalize', lang: 'pt-BR' })
    for (const variant of ['llvision', 'LLVISION']) {
      const r = norm(variant, entries)
      check(`归一「${variant}」→「LLVision」`, r.text === 'LLVision' && r.changed === true, r.text)
    }
    const spaced = norm('leion pro', entries2)
    check('归一「leion pro」→「Leion Pro」', spaced.text === 'Leion Pro' && spaced.changed === true, spaced.text)
    const joined = norm('LeionPro', entries2)
    check('归一「LeionPro」→「Leion Pro」（连写也要补空格）', joined.text === 'Leion Pro' && joined.changed === true, joined.text)
    const idem = norm('Leion Pro', entries2)
    check('已经是规范写法 → 不改字（幂等）', idem.text === 'Leion Pro' && idem.changed === false, JSON.stringify(idem))
    const accentEntries = table([{ zh: '圣保罗', pt: 'São Paulo' }])
    const accent = norm('sao paulo', accentEntries)
    check('归一「sao paulo」→「São Paulo」（重音也要补）', accent.text === 'São Paulo' && accent.changed === true, accent.text)

    check('折叠后长度不变（否则下标会错位）', foldForMatch('ação') === 'acao')
    check('折叠保留长度：São Paulo', foldForMatch('São Paulo').length === 'São Paulo'.length)
  })

  await it('折叠可以按条目关掉（secretária / secretaria 是两个词）', () => {
    const entries = table([
      { zh: '秘书处', pt: 'secretaria', fold: false },
      { zh: '女秘书', pt: 'secretária', fold: false },
    ])
    const a = run('A secretária chegou.', entries, 'pt-BR')
    check('带重音的那条命中正确条目', a.text === 'A 女秘书 chegou.', a.text)
    const b = run('A secretaria fica no segundo andar.', entries, 'pt-BR')
    check('不带重音的那条命中另一个条目', b.text === 'A 秘书处 fica no segundo andar.', b.text)
  })

  // ── 5. 变体（variants / approved）─────────────────────────────────────
  await it('变体清单能让"模型写成别的样子"也收敛回来', () => {
    const entries = table([{
      zh: '亮亮视野', pt: 'LLVision',
      variants: ['亮亮视野科技'],
      approved: ['LL Vision'],
    }])
    // 中文方向：变体（亮亮视野科技）→ 规范葡语写法
    const zh = run('亮亮视野科技的同事来了。', entries, 'zh-CN')
    check('中文变体换成规范葡语写法', zh.text === 'LLVision的同事来了。', zh.text)
    // 葡语方向：认可变体（LL Vision，中间有空格）→ 规范中文写法
    const pt = run('A LL Vision cresceu.', entries, 'pt-BR')
    check('葡语变体（带空格）换成规范中文写法', pt.text === 'A 亮亮视野 cresceu.', pt.text)
  })

  await it('两侧同名的条目（原样保留）只记 hit，不改文本', () => {
    const entries = table([{ zh: 'Leion Pro', pt: 'Leion Pro' }])
    for (const from of ['zh-CN', 'pt-BR']) {
      const result = run('Comprei o Leion Pro.', entries, from)
      check(`from=${from} 文本不变`, result.text === 'Comprei o Leion Pro.', result.text)
      check(`from=${from} 记 hit`, result.events.some(e => e.event === 'hit'), JSON.stringify(result.events))
    }
  })

  // ── 6. 幂等 ────────────────────────────────────────────────────────────
  await it('负对照④：替换两次 = 替换一次（幂等，不会滚雪球）', () => {
    const entries = table([{ zh: '亮亮视野', pt: 'LLVision' }])
    const once = run('我们和亮亮视野合作。', entries, 'zh-CN')
    const twice = run(once.text, entries, 'zh-CN')
    check('第二次不再改动', twice.text === once.text, twice.text)
    check('第二次没有 replace 事件', twice.events.every(e => e.event !== 'replace'), JSON.stringify(twice.events))
  })

  // ── 7. 不该触发的情形 ──────────────────────────────────────────────────
  await it('负对照⑤⑥：句子不含源词 → 一个字都不动；空表 → 原样返回', () => {
    const entries = table([{ zh: '亮亮视野', pt: 'LLVision' }])
    const clean = run('Hoje a reunião é às três.', entries, 'pt-BR')
    check('不动的句子保持原样', clean.text === 'Hoje a reunião é às três.')
    check('没有事件', clean.events.length === 0, JSON.stringify(clean.events))
    const empty = run('我们和亮亮视野合作。', [], 'zh-CN')
    check('空表原样返回（等同功能关闭）', empty.text === '我们和亮亮视野合作。' && empty.events.length === 0)
    check('空字符串安全', run('', entries, 'zh-CN').text === '')
  })

  // ── 8. 方向 ────────────────────────────────────────────────────────────
  await it('方向：中文文本查中文侧写法、葡语文本查葡语侧写法，互不串台', () => {
    const entries = table([{ zh: '亮亮视野', pt: 'LLVision' }])
    const zhText = run('亮亮视野发布了新品。', entries, 'zh-CN')
    check('中→葡', zhText.text === 'LLVision发布了新品。', zhText.text)
    const ptText = run('A LLVision lançou um produto.', entries, 'pt-BR')
    check('葡→中', ptText.text === 'A 亮亮视野 lançou um produto.', ptText.text)
    const wrongWay = run('A LLVision lançou um produto.', entries, 'zh-CN')
    check('方向不对时不乱换（中文方向不会去查葡语写法）',
      wrongWay.text === 'A LLVision lançou um produto.', wrongWay.text)
  })

  await it('direction 字段能限制单方向生效（为"用户指明方向"留的扩展）', () => {
    const entries = table([{ zh: '亮亮视野', pt: 'LLVision', direction: 'zh-to-pt' }])
    const zh = run('亮亮视野发布了新品。', entries, 'zh-CN')
    check('中→葡方向生效', zh.text === 'LLVision发布了新品。', zh.text)
    const pt = run('A LLVision cresceu.', entries, 'pt-BR')
    check('葡→中方向不生效', pt.text === 'A LLVision cresceu.', pt.text)
  })

  // ── 9. 审计信息 ────────────────────────────────────────────────────────
  await it('每次替换都带上下文（供事后审计"这次改得对不对"）', () => {
    const entries = table([{ zh: '亮亮视野', pt: 'LLVision' }])
    const result = run('昨天我们和亮亮视野签了合同。', entries, 'zh-CN')
    const replace = result.events.find(e => e.event === 'replace')
    check('有 replace 事件', replace !== undefined)
    check('带 from/to', replace.from === '亮亮视野' && replace.to === 'LLVision', JSON.stringify(replace))
    check('带上下文', typeof replace.context === 'string' && replace.context.includes('亮亮视野'), replace.context)
  })

  // ── 11. normalize 模式：这才是生产路径 ────────────────────────────────
  // 上面那些用例走的是 translate（跨语种），生产里真正要用的是**同语种归一**：
  // 葡语译文里出现葡语变体 → 换葡语规范写法；中文同理。
  // （这里曾经搞反过：以为要"把中文名换成葡语"，结果把中文塞进了葡语译文。）
  const normalizePt = (text, entries) => applyTerms(text, { entries, mode: 'normalize', lang: 'pt-BR' })

  await it('normalize（葡语）：变体 → 规范葡语写法，**绝不插入中文**', () => {
    const entries = table([{ zh: '亮亮视野', pt: 'LLVision', wrong: ['Liangliang Vision'] }])
    const result = normalizePt('A Liangliang Vision cresceu em São Paulo.', entries)
    check('换成规范葡语写法', result.text === 'A LLVision cresceu em São Paulo.', result.text)
    check('没有中文残留（最重要的回归点）', /[\u4e00-\u9fa5]/.test(result.text) === false, result.text)
    check('记了 replace 事件', result.events.some(e => e.event === 'replace'), JSON.stringify(result.events))
  })

  await it('normalize（葡语）：approved 里的"可接受写法"也会被收敛成规范写法', () => {
    const entries = table([{ zh: '亮亮视野', pt: 'LLVision', approved: ['LL Vision'] }])
    const result = normalizePt('A LL Vision venceu.', entries)
    check('收敛成 LLVision', result.text === 'A LLVision venceu.', result.text)
  })

  await it('normalize（中文）：中文变体 → 规范中文写法', () => {
    const entries = table([{ zh: '亮亮视野', pt: 'LLVision', variants: ['亮亮视野科技'] }])
    const result = applyTerms('亮亮视野科技发布了新品。', { entries, mode: 'normalize', lang: 'zh-CN' })
    check('收敛成规范中文名', result.text === '亮亮视野发布了新品。', result.text)
  })

  await it('normalize 也幂等：已经规范时一个字都不动', () => {
    const entries = table([{ zh: '亮亮视野', pt: 'LLVision', wrong: ['Liangliang Vision'] }])
    const once = normalizePt('A LLVision cresceu.', entries)
    check('已经是规范写法 → 无改动', once.text === 'A LLVision cresceu.' && once.changed === false, JSON.stringify(once))
  })

  // ── 12. 三语（5.02）：英语是**独立一栏** ──────────────────────────────
  //
  // 三种语言彼此等价，所以英语必须有自己那一条车道。最容易出的两个错：
  //   ① 拿葡语那一栏去英语句子里找 → 永远"没出现"，英语方向**静默失效**；
  //   ② 两栏条目（缺葡语/缺英语）的 `wrong` 带着**空格**当替换目标 → 把词删掉。
  await it('normalize（英语）：英语变体 → 规范英语写法，绝不插入中文/葡语', () => {
    const entries = table([{
      zh: '亮亮眼镜', pt: 'Leion Pro', en: 'Leion Pro', enVariants: ['LeionPRO Eye'],
    }])
    const result = applyTerms('The LeionPRO Eye is new.', { entries, mode: 'normalize', lang: 'en-US' })
    check('收敛成规范英语写法', result.text === 'The Leion Pro is new.', result.text)
    check('没有汉字残留', /[\u4e00-\u9fa5]/.test(result.text) === false, result.text)
    const already = applyTerms('The Leion Pro is new.', { entries, mode: 'normalize', lang: 'en-US' })
    check('幂等', already.changed === false, JSON.stringify(already))
  })

  await it('normalize（英语）：老条目（只有中/葡）**不会**在英语里乱换', () => {
    // 老条目没有 en：英语车道上它一个写法都没有 —— 葡语写法绝不能被当成英语变体
    const entries = table([{ zh: '亮亮视野', pt: 'LLVision', wrong: ['Liangliang Vision'] }])
    const result = applyTerms('Liangliang Vision grew and LLVision too.', {
      entries, mode: 'normalize', lang: 'en-US',
    })
    check('一个字都不动', result.text === 'Liangliang Vision grew and LLVision too.', result.text)
    check('没有 replace 事件', result.events.every(e => e.event !== 'replace'), JSON.stringify(result.events))
  })

  await it('两栏条目缺哪一栏，那一栏就整栏不生效（不会把词删成空）', () => {
    // 只有中 + 英，缺葡语
    const entries = table([{ zh: '货代', en: 'freight forwarder', wrong: ['agente de carga'] }])
    const pt = applyTerms('O agente de carga chegou.', { entries, mode: 'normalize', lang: 'pt-BR' })
    check('葡语栏没登记 → 葡语文本一个字都不动（不是删成空串）',
      pt.text === 'O agente de carga chegou.', pt.text)
    const en = applyTerms('The freight forwarder arrived.', { entries, mode: 'normalize', lang: 'en-US' })
    check('英语栏登记了 → 英语方向照常工作（此句已是规范写法）',
      en.text === 'The freight forwarder arrived.' && en.changed === false, JSON.stringify(en))
    check('索引里葡语车道为空', buildIndex(entries).normalizePt.length === 0,
      String(buildIndex(entries).normalizePt.length))
    check('索引里英语车道非空', buildIndex(entries).normalizeEn.length > 0,
      String(buildIndex(entries).normalizeEn.length))
  })
}

