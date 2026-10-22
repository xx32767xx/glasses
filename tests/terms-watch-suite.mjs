/**
 * terms-watch-suite.mjs —— 热词观测（"提到了、但没写出规范写法"时记一笔，不改字幕）
 * ============================================================================
 *
 * 这个功能只回答一个问题：**这句话有没有问题？** 它不回答"写成了什么"（那是离线
 * 候选发现的事），也不改字幕。所以测的重点是"该记的一定记、不该记的一定不记"：
 *
 *   · 记：原文提到表内名字、译文里没有规范写法；
 *   · 不记：译文里已经有规范写法（哪怕写法折叠后相同）；
 *   · 不记：原文根本没提这个名字；
 *   · 不记：`高通` 在 `高通量` 这种中文边界里（与匹配器同一套规则）；
 *   · 不记：方向不符（条目只做 zh→pt，却在 pt→zh 的句子上出现）。
 */
import { detectTermsMiss } from '../plugin/core.mjs'
import { validateTerms } from '../lib/terms.mjs'

const ENTRIES = validateTerms([
  { zh: '亮亮视野', pt: 'LLVision', approved: ['LLVision'], wrong: ['Liangliang Vision'] },
  { zh: '高通', pt: 'Qualcomm' },
  { zh: '亮亮眼镜', pt: 'Leion Pro', direction: 'zh-to-pt' },
]).entries

const miss = (source, text, from = 'zh-CN', to = 'pt-BR') =>
  detectTermsMiss(source, text, ENTRIES, from, to)

export async function runTermsWatchSuite({ it, check }) {
  await it('观测：提到了名字、译文写成变体 → 记一笔（完整原文+译文）', () => {
    const events = miss('我们和亮亮视野合作。', 'Colaboramos com a Liangliang Vision.')
    check('记了一条 watch', events.length === 1, JSON.stringify(events))
    check('事件带 id / zh', events[0].id === ENTRIES[0].id && events[0].zh === '亮亮视野', JSON.stringify(events[0]))
    check('事件带完整原文与译文（离线发现的输入）',
      events[0].source === '我们和亮亮视野合作。' && events[0].translation === 'Colaboramos com a Liangliang Vision.',
      JSON.stringify(events[0]))
    check('事件类型是 watch', events[0].event === 'watch', events[0].event)
  })

  await it('观测：译文里已有规范写法 → 不记（大小写/空格不同也算有）', () => {
    check('规范写法出现 → 不记', miss('我们和亮亮视野合作。', 'Colaboramos com a LLVision.').length === 0)
    check('小写规范写法也算出现 → 不记', miss('我们和亮亮视野合作。', 'Colaboramos com a llvision.').length === 0)
  })

  await it('观测：原文没提这个名字 → 不记', () => {
    check('完全没提', miss('今天天气不错。', 'O tempo está bom hoje.').length === 0)
  })

  await it('观测：中文边界（`高通` 在 `高通量` 里）→ 不记', () => {
    const events = miss('这是高通量的实验。', 'É um experimento de alto rendimento.')
    check('边界内不算提到', events.length === 0, JSON.stringify(events))
    const good = miss('高通发布了新芯片。', 'A Qualcomm lançou um novo chip.')
    check('正常用法照常记录（此处规范写法出现了，所以不记）', good.length === 0, JSON.stringify(good))
  })

  await it('观测：方向不符的条目 → 不记', () => {
    // `亮亮眼镜 → Leion Pro` 只做 zh→pt；这句是 pt→zh，不该拿它去观测
    const events = miss('The Leion Pro is here.', '这款眼镜到了。', 'pt-BR', 'zh-CN')
    check('zh-to-pt 条目在 pt→zh 句子上不记', events.every(event => event.id !== ENTRIES[2].id), JSON.stringify(events))
  })

  await it('观测：pt→zh 方向同样工作', () => {
    const events = miss('A LLVision cresceu.', '这家公司壮大了。', 'pt-BR', 'zh-CN')
    check('记了一条', events.length === 1 && events[0].zh === '亮亮视野', JSON.stringify(events))
    const ok = miss('A LLVision cresceu.', '亮亮视野壮大了。', 'pt-BR', 'zh-CN')
    check('译文里已有中文规范写法 → 不记', ok.length === 0, JSON.stringify(ok))
  })

  await it('观测：空输入 / 空表 → 空结果（不报错）', () => {
    check('空原文', detectTermsMiss('', 'X', ENTRIES, 'zh-CN', 'pt-BR').length === 0)
    check('空译文', detectTermsMiss('我们和亮亮视野合作。', '', ENTRIES, 'zh-CN', 'pt-BR').length === 0)
    check('空表', detectTermsMiss('我们和亮亮视野合作。', 'X', [], 'zh-CN', 'pt-BR').length === 0)
  })
}
