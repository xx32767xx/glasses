/**
 * terms-eval-suite.mjs —— 验收集与评分器的自测（阶段 2.5）
 * ============================================================================
 *
 * 这一套测的不是"翻译好不好"（那要模型，也不该进单元测试），而是**尺子本身**：
 *
 *   ① 验收集的卫生检查真的会报错（否则它等于没有）
 *   ② 评分器把"缺失 / 写法错 / 保留中文 / 合法省略 / 可疑改动"分得开
 *
 * 第 ② 条尤其重要：这五个数一旦混在一起，"该修哪里"就再也看不出来了。
 * 所以每一类都造一个**只触发它**的假译文，断言其它计数不受影响。
 */

import { ALL_ITEMS, DENSE, EVAL_TABLE, HOLDOUT, TRAP, checkCorpus } from '../scripts/terms-eval-corpus.mjs'
import { scoreStage } from '../scripts/terms-eval.mjs'
import { validateTerms } from '../lib/terms.mjs'
import { applyTerms } from '../lib/terms-matcher.mjs'

export async function runTermsEvalSuite({ it, check, assert }) {
  const entries = (() => {
    const checked = validateTerms(EVAL_TABLE)
    if (checked.ok !== true) throw new Error('验收集的表不合法：' + JSON.stringify(checked.rejected))
    return checked.entries
  })()

  // ── 1. 验收集卫生检查 ──────────────────────────────────────────────────
  await it('验收集本身通过卫生检查（三类都齐、分母够大、标注与原文对得上）', () => {
    const problems = checkCorpus()
    check('没有问题', problems.length === 0, problems.join('；'))
    check('密集句 ≥15', DENSE.length >= 15, String(DENSE.length))
    check('陷阱句 ≥5', TRAP.length >= 5, String(TRAP.length))
    check('留出集 ≥5', HOLDOUT.length >= 5, String(HOLDOUT.length))
    // 留出集必须真的标着 holdout —— 否则"没参与规则调整"这句话就是假的
    check('留出集都带 holdout 标记', HOLDOUT.every(item => item.holdout === true))
    check('id 唯一', new Set(ALL_ITEMS.map(i => i.id)).size === ALL_ITEMS.length)
  })

  await it('卫生检查真的会报错（否则等于没有）', () => {
    const bad = [{ id: 'x1', cls: 'dense', source: '这句话里没有那个名字。', why: '故意写错', mentions: [{ zh: '亮亮视野', pt: 'LLVision' }] }]
    const problems = checkCorpus(bad)
    check('标注的词不在原文里要报出来',
      problems.some(p => p.includes('原文里没有这个词')), problems.join('；'))

    const dup = [
      { id: 'a', cls: 'dense', source: '亮亮视野很好', why: 'x', mentions: [] },
      { id: 'a', cls: 'dense', source: '亮亮视野很好', why: 'x', mentions: [] },
    ]
    check('重复 id 要报出来', checkCorpus(dup).some(p => p.includes('id 重复')), checkCorpus(dup).join('；'))
    check('条目太少要报出来', checkCorpus([{ id: 'b', cls: 'dense', source: '亮亮视野', why: 'x', mentions: [] }])
      .some(p => p.includes('至少')), '')
  })

  // ── 2. 评分器：五类分得开 ──────────────────────────────────────────────
  const only = item => ALL_ITEMS.filter(candidate => candidate.id === item)

  await it('评分器：名字写对了 → 缺失 0、替换 0（已经在规范形态就不该改）', () => {
    const result = scoreStage(only('d01'), new Map([['d01', 'LLVision investiu na linha de interpretação.']]), entries)
    check('提及计 1 次', result.mentions === 1, String(result.mentions))
    check('出现 1 次', result.present === 1, JSON.stringify(result))
    check('缺失 0', result.missing === 0)
    check('替换 0（不该动已经规范的写法）', result.replace === 0, JSON.stringify(result))
    check('缺失率 0', result.missRate === 0, String(result.missRate))
  })

  await it('评分器：名字整个没了 → 记缺失（不算写法错）', () => {
    const result = scoreStage(only('d01'), new Map([['d01', 'A empresa investiu nessa linha.']]), entries)
    check('缺失 1', result.missing === 1, JSON.stringify(result))
    check('写法错 0（没写错，是压根没写）', result.wrongForm === 0)
    check('缺失率 100%', result.missRate === 1, String(result.missRate))
    check('明细里带期望写法', result.missingDetail[0].expect === 'LLVision', JSON.stringify(result.missingDetail))
  })

  await it('评分器：保留了中文名 → 单独计"保留中文"，不算缺失', () => {
    const result = scoreStage(only('d01'), new Map([['d01', '亮亮视野 investiu nessa linha.']]), entries)
    check('保留中文 1', result.keptChinese === 1, JSON.stringify(result))
    check('缺失 0', result.missing === 0)
    // 保留中文虽然不算缺失，但也不该算"对" —— 它有自己的计数
    check('出现 0', result.present === 0)
  })

  await it('评分器：已知错误写法 → 记"写法错"，与缺失分开', () => {
    // 这一条需要表里有 wrong：临时造一个
    const withWrong = validateTerms([{ zh: '亮亮视野', pt: 'LLVision', wrong: ['Liangliang Vision'] }]).entries
    const result = scoreStage(only('d01'), new Map([['d01', 'A Liangliang Vision cresceu.']]), withWrong)
    check('写法错 1', result.wrongForm === 1, JSON.stringify(result))
    check('缺失 0（写了，只是写法不对）', result.missing === 0)
    check('写法错误率 100%', result.wrongRate === 1, String(result.wrongRate))
  })

  await it('评分器：合法省略不进分母（allowMissing）', () => {
    // d09 有两次"王工"，第二次标了 allowMissing
    const withoutName = 'O engenheiro Wang cuida do hardware. Pode perguntar a ele.'
    const result = scoreStage(only('d09'), new Map([['d09', withoutName]]), entries)
    check('分母只算 1 次（第二次是合法省略）', result.mentions === 1, String(result.mentions))
    check('出现 1 次', result.present === 1, JSON.stringify(result))
    check('缺失 0', result.missing === 0)
  })

  await it('评分器：陷阱句被改动 → 记"可疑改动"（这是误替换的分母）', () => {
    const clean = scoreStage(only('t04'), new Map([['t04', 'O preço subiu bastante este ano.']]), entries)
    check('没动 → 可疑 0', clean.suspiciousChanges === 0, JSON.stringify(clean))
    // 造一个"本该不动却被动了"的例子：变体出现在一句没标注任何实体的句子里。
    // 注意要用**葡语侧**的变体才动得了 —— 陷阱句的译文本来就是葡语。
    const withVariant = validateTerms([{ zh: '亮亮视野', pt: 'LLVision', approved: ['LL Vision'] }]).entries
    const trapItem = [{ id: 'z1', cls: 'trap', source: '（陷阱句）', why: 'x', mentions: [] }]
    const dirty = scoreStage(trapItem, new Map([['z1', 'A LL Vision cresceu.']]), withVariant)
    check('动了 → 可疑 1', dirty.suspiciousChanges === 1, JSON.stringify(dirty))
    check('明细里有说明', dirty.suspiciousDetail.length === 1, JSON.stringify(dirty.suspiciousDetail))
  })

  await it('评分器：B 档真的会把变体收敛（这是"替换"唯一该做的事）', () => {
    // 表里给 LLVision 加一个认可变体，翻译写成变体形态 → B 档应变成规范写法
    const withVariant = validateTerms([
      { zh: '亮亮视野', pt: 'LLVision', approved: ['LL Vision'] },
    ]).entries
    const stageA = new Map([['d01', 'A LL Vision cresceu.']])
    const stageB = new Map([['d01', applyTerms(stageA.get('d01'), { entries: withVariant, lang: 'pt-BR' }).text]])
    check('B 档收敛成规范写法', stageB.get('d01') === 'A LLVision cresceu.', stageB.get('d01'))
    const a = scoreStage(only('d01'), stageA, withVariant)
    const b = scoreStage(only('d01'), stageB, withVariant)
    check('A 档：变体也算"出现"（approved 是可接受写法）', a.present === 1, JSON.stringify(a))
    check('B 档：仍然算出现，但文本已是规范形态', b.present === 1, JSON.stringify(b))
  })

  await it('评分器：没给译文的条目算"跳过"，不混进分母', () => {
    const result = scoreStage(only('d01').concat(only('d02')), new Map([['d01', 'LLVision cresceu.']]), entries)
    check('条目 2 条', result.items === 2, String(result.items))
    check('评分 1 条、跳过 1 条', result.scored === 1 && result.skipped === 1, JSON.stringify(result))
    check('分母只算有译文那条的提及', result.mentions === 1, String(result.mentions))
  })
}
