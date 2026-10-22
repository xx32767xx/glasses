/**
 * rescue-suite.mjs —— 热词临时修正（方向一实验）的纯函数闸门
 * ============================================================================
 *
 * 方向一的风险只有一个：**改错**。所以这里全部是"该改就改、不该改一定拒"的成对测试，
 * 覆盖 planRescue 的每一道闸：
 *
 *   ① 范围闸：只换那一小段（其余文字逐字不动）；
 *   ② 相似闸：片段与规范写法要"像同一个名字"（`Liangliang` vs `LLVision` 这类
 *      译名/缩写差异会被拒 —— 那是别名表的活，不是自动修正的活）；
 *   ③ 串台闸：片段里夹带别的表内名字 → 拒；
 *   ④ 长度闸：像整句的回答 → 拒；
 *   ⑤ 原样闸：片段没有原样出现在译文里 → 拒；
 *   ⑥ 格式闸：改完行数/列数放不下 → 拒。
 *
 * 这组测试同时在 `eval-rescue.mjs`（人工标注集）上被验证过：8 改对 / 0 改错。
 */
import { locateTermSpan, planRescue, sharedBigram } from '../plugin/core.mjs'

const ENTRIES = [
  { id: 'e1', zh: '亮亮视野', pt: 'LLVision', approved: ['LLVision'] },
  { id: 'e2', zh: '清华大学', pt: 'Universidade Tsinghua' },
  { id: 'e3', zh: '亮亮眼镜', pt: 'Leion Pro' },
]

/** 标准草案：模型把 亮亮视野 写成了 Liangliang Visão。 */
const DRAFT = 'A Liangliang Visão colabora com a nossa equipe.'

export async function runRescueSuite({ it, check }) {
  await it('定位片段：精确/大小写/重音/空格 都能定位到原始下标', () => {
    const span = locateTermSpan(DRAFT, 'Liangliang Visão')
    check('精确命中', span !== null && DRAFT.slice(span.start, span.end) === 'Liangliang Visão', JSON.stringify(span))
    const loose = locateTermSpan('Comprei o LeionPro ontem.', 'leion pro')
    check('连写/大小写都能定位', loose !== null && 'Comprei o LeionPro ontem.'.slice(loose.start, loose.end) === 'LeionPro', JSON.stringify(loose))
    check('找不到就返回 null', locateTermSpan(DRAFT, '不存在的东西') === null)
    check('空片段返回 null', locateTermSpan(DRAFT, '   ') === null)
  })

  await it('闸门：片段像同一个名字（写错一两个字母）→ 改；只换那一小段', () => {
    const draft = 'A LLVsion colabora com a nossa equipe.'
    const plan = planRescue({
      draft, answer: 'LLVsion', canonical: 'LLVision', entries: ENTRIES, targetZh: false, cols: 40, lines: 3,
    })
    check('通过', plan.ok === true, JSON.stringify(plan))
    check('from 是原片段、to 是规范写法', plan.from === 'LLVsion' && plan.to === 'LLVision', JSON.stringify(plan))
    check('只换了那一小段', plan.text === 'A LLVision colabora com a nossa equipe.', plan.text)
  })

  await it('闸门：像"整句/半句"的回答 → 拒', () => {
    const plan = planRescue({
      draft: DRAFT, answer: 'A Liangliang Visão colabora com a nossa equipe', canonical: 'LLVision', entries: ENTRIES, targetZh: false, cols: 40, lines: 3,
    })
    check('拒掉整句', plan.ok === false, JSON.stringify(plan))
  })

  await it('闸门：与规范写法不像（译名/缩写/泛化）→ 拒', () => {
    for (const answer of ['Liangliang', '这家公司', 'Beijing']) {
      const canonical = answer === 'Beijing' ? 'Pequim' : 'LLVision'
      const plan = planRescue({
        draft: 'A ' + answer + ' colabora.', answer, canonical, entries: ENTRIES, targetZh: false, cols: 40, lines: 3,
      })
      check(`「${answer}」被拒（交给别名表）`, plan.ok === false, JSON.stringify(plan))
    }
    // 反例：真的像（拼写只差一点）
    const ok = planRescue({
      draft: 'A LLVsion cresceu.', answer: 'LLVsion', canonical: 'LLVision', entries: ENTRIES, targetZh: false, cols: 40, lines: 3,
    })
    check('「LLVsion」通过（拼写差一点）', ok.ok === true, JSON.stringify(ok))
  })

  await it('闸门：片段里夹带别的表内名字 → 拒（串台）', () => {
    const draft = 'A Universidade Tsinghua e o LLVision colaboram.'
    const plan = planRescue({
      draft, answer: 'Universidade Tsinghua e o LLVision', canonical: 'Leion Pro', entries: ENTRIES, targetZh: false, cols: 40, lines: 3,
    })
    check('拒（夹带）', plan.ok === false, JSON.stringify(plan))
  })

  await it('闸门：片段没原样出现在译文里 → 拒', () => {
    const plan = planRescue({
      draft: DRAFT, answer: 'Liangliang Vision', canonical: 'LLVision', entries: ENTRIES, targetZh: false, cols: 40, lines: 3,
    })
    check('拒（原样闸）', plan.ok === false, JSON.stringify(plan))
  })

  await it('闸门：已经是规范写法 → 拒（无事可做）', () => {
    const plan = planRescue({
      draft: 'A LLVision cresceu.', answer: 'LLVision', canonical: 'LLVision', entries: ENTRIES, targetZh: false, cols: 40, lines: 3,
    })
    check('拒（相同）', plan.ok === false, JSON.stringify(plan))
  })

  await it('共享二元组：同名字高、泛化/译名低（阈值 0.25 的依据）', () => {
    check('llvision vs LLVision 很高', sharedBigram('llvision', 'LLVision') > 0.9)
    check('Liangliang Visão vs LLVision 低', sharedBigram('Liangliang Visão', 'LLVision') < 0.25)
    check('这家公司 vs LLVision 为 0', sharedBigram('这家公司', 'LLVision') === 0)
  })
}
