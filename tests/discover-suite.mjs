/**
 * discover-suite.mjs —— 离线候选发现工具（scripts/discover-variants.mjs）
 * ============================================================================
 *
 * 这个工具**不调模型**也能测的部分：清单生成/解析、候选合并、以及"入表后表仍合法"。
 * 模型那一半（定位质量）在 docs/15 §15.5 的对照实验里测过，不在这里重复跑网络。
 *
 * 测的重点是**人在回路里的那两个动作**：
 *   ① 生成的清单必须能被自己的 `--apply` 解析回去（格式漂移会静默丢候选）；
 *   ② 合并后必须仍然通过 `validateTerms`（否则写进表就是一张坏表）。
 */
import { mergeCandidates, parseReviewSheet, renderSheet, foldCompact, detectLangLite, parseAnswer, isVerbatim, pairsFromWatch } from '../scripts/discover-variants.mjs'
import { validateTerms } from '../lib/terms.mjs'

/** 造一张合法的表（走真实校验，避免"测试用的表根本不合法"）。 */
function table(entries) {
  const checked = validateTerms(entries)
  if (checked.ok !== true) throw new Error('测试表本身不合法：' + JSON.stringify(checked.rejected))
  return checked.entries
}

const SAMPLE = [
  {
    zh: '亮亮视野', canonical: 'LLVision', candidate: 'Liangliang Vision',
    field: 'wrong', suspect: false, count: 2,
    sample: { source: '我们和亮亮视野合作。', translation: 'Colaboramos com a Liangliang Vision.' },
  },
  {
    zh: '亮亮视野', canonical: 'LLVision', candidate: 'Óculos Brilhantes',
    field: 'wrong', suspect: true, count: 1,
    sample: null,
  },
]

export async function runDiscoverSuite({ it, check }) {
  await it('候选清单：生成的清单能被自己的 apply 解析回去（勾选 → 采用）', () => {
    const md = renderSheet(SAMPLE, { user: 'test', model: 'qwen2.5-72b', input: 'x.jsonl', at: '2026-10-21T00:00:00.000Z' })
    check('两张候选都落在清单里', (md.match(/^## c\d+$/gm) ?? []).length === 2, md)
    // 把第一条勾成"采用"，第二条保持"否"
    const marked = md.replace(/采用：\[ \] 是 {3}\[ \] 否/, '采用：[x] 是   [ ] 否')
    const { accepted, skipped } = parseReviewSheet(marked)
    check('勾上的那条被收下', accepted.length === 1, JSON.stringify(accepted))
    check('候选项解析正确（中文/规范/片段/字段）',
      accepted[0].zh === '亮亮视野' && accepted[0].canonical === 'LLVision'
      && accepted[0].candidate === 'Liangliang Vision' && accepted[0].field === 'wrong',
      JSON.stringify(accepted[0]))
    check('没勾的那条进 skipped（不会被误写）', skipped.length === 1, JSON.stringify(skipped))
  })

  await it('候选清单：没勾任何一条 → accepted 为空（apply 什么都不做）', () => {
    const md = renderSheet([SAMPLE[0]], { user: 'test', model: 'm', input: 'x.jsonl', at: 'now' })
    const { accepted } = parseReviewSheet(md)
    check('空勾选 → 空 accepted', accepted.length === 0, JSON.stringify(accepted))
  })

  await it('合并：新候选进 wrong，表仍然合法', () => {
    const entries = table([{ zh: '亮亮视野', pt: 'LLVision', wrong: ['Liangliang Vision'] }])
    const { entries: merged, added, skipped } = mergeCandidates(entries, [
      // 与 "Liangliang Vision" 折叠后不同（去空格后不同）→ 值得单独登记
      { id: 'c01', zh: '亮亮视野', candidate: 'LiangLiang Tecnologia', field: 'wrong' },
    ])
    check('收下了', added.length === 1 && skipped.length === 0, JSON.stringify({ added, skipped }))
    check('追加到 wrong 且保序',
      JSON.stringify(merged[0].wrong) === JSON.stringify(['Liangliang Vision', 'LiangLiang Tecnologia']),
      JSON.stringify(merged[0].wrong))
    const checked = validateTerms(merged)
    check('合并后的表通过校验', checked.ok === true, JSON.stringify(checked.rejected))
  })

  await it('合并：三种"不该写"的情况都会跳过，并且不动原表', () => {
    const entries = table([{ zh: '亮亮视野', pt: 'LLVision', wrong: ['Liangliang Vision'] }])
    const before = JSON.stringify(entries)
    const { entries: merged, added, skipped } = mergeCandidates(entries, [
      { id: 'a', zh: '不存在的名字', candidate: 'Xxx', field: 'wrong' },
      { id: 'b', zh: '亮亮视野', candidate: 'llvision', field: 'wrong' },       // 与规范写法折叠后相同
      { id: 'c', zh: '亮亮视野', candidate: 'Liangliang  Vision', field: 'wrong' }, // 已登记（折叠后相同）
    ])
    check('一条都没收', added.length === 0 && skipped.length === 3, JSON.stringify({ added, skipped }))
    check('原表没有被改动', JSON.stringify(merged) === before, 'mergeCandidates 改了原数组')
    check('跳过原因说清了', skipped.every(item => typeof item.reason === 'string' && item.reason !== ''),
      JSON.stringify(skipped.map(item => item.reason)))
  })

  await it('合并：`variants` 字段按中文侧规范写法判重', () => {
    const entries = table([{ zh: '亮亮视野', pt: 'LLVision' }])
    const { added, entries: merged } = mergeCandidates(entries, [
      { id: 'a', zh: '亮亮视野', candidate: '亮亮视野科技', field: 'variants' },
    ])
    check('进 variants', added.length === 1 && added[0].field === 'variants', JSON.stringify(added))
    check('variants 里是中文变体', JSON.stringify(merged[0].variants) === JSON.stringify(['亮亮视野科技']),
      JSON.stringify(merged[0].variants))
    check('表仍合法', validateTerms(merged).ok === true)
  })

  await it('热词观测 → 离线发现：watch 事件能直接变成本工具的输入（按句去重）', () => {
    const log = [
      JSON.stringify({ event: 'watch', id: 't1', zh: '亮亮视野', source: '我们和亮亮视野合作。', translation: 'Colaboramos com a Liangliang Vision.' }),
      JSON.stringify({ event: 'watch', id: 't2', zh: '亮亮眼镜', source: '我们和亮亮视野合作。', translation: 'Colaboramos com a Liangliang Vision.' }),
      JSON.stringify({ event: 'replace', id: 't1', from: 'Liangliang Vision', to: 'LLVision' }),
      JSON.stringify({ event: 'watch', id: 't1', zh: '亮亮视野', source: '别的句子。', translation: 'Outra frase.' }),
      '坏行不是 JSON',
    ].join('\n')
    const pairs = pairsFromWatch(log)
    check('只收 watch 事件，重复句子合并', pairs.length === 2, JSON.stringify(pairs))
    check('带出原文与译文', pairs[0].source === '我们和亮亮视野合作。' && pairs[0].translation === 'Colaboramos com a Liangliang Vision.',
      JSON.stringify(pairs[0]))
    check('语种粗判可用', pairs[0].translationLang === 'pt', pairs[0].translationLang)
  })

  await it('工具件：折叠/语种粗判/回答清洗/原样校验', () => {
    check('折叠去空格：Leion Pro ≡ LeionPro', foldCompact('Leion Pro') === foldCompact('LeionPro'))
    check('语种粗判：有汉字是中文', detectLangLite('我们和亮亮视野合作') === 'zh')
    check('语种粗判：没有汉字是葡语', detectLangLite('Colaboramos com a LLVision') === 'pt')
    check('回答清洗：去掉引号与句号', parseAnswer('“LLVision”。') === 'LLVision')
    check('回答清洗：NONE 视为空', parseAnswer('NONE') === null)
    check('原样校验：真片段通过', isVerbatim('Liangliang Vision', 'Colaboramos com a Liangliang Vision.') === true)
    check('原样校验：编造的片段不通过', isVerbatim('Foo Bar', 'Colaboramos com a Liangliang Vision.') === false)
  })
}
