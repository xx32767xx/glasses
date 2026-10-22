/**
 * rescue-suite.mjs —— 热词临时修正（方向一实验，**激进版**）的纯函数闸门
 * ============================================================================
 *
 * 激进版（用户定）：不再要求"与规范写法形状相似" —— 译名/缩写类（`Liangliang Ótica`
 * vs `Leion`）也允许改；靠下面这组"最小可信闸门"兜底：
 *
 *   ① 范围闸：只换那一小段（其余文字逐字不动）；
 *   ② 原样闸：片段必须**原样出现在译文里**（防模型编造）；
 *   ③ 串台闸：片段里夹带别的表内名字 → 拒；
 *   ④ 长度闸：≤6 词 / ≤40 字符（防整句）；
 *   ⑤ 已规范闸：折叠后与规范写法相同 → 拒（无事可做）；
 *   ⑥ 格式闸：改完行数/列数放不下 → 拒。
 *
 * 只靠这四条"不猜语义"的前提，所以它不能在标注集上"证明安全"——
 * 安全靠的是"只改最后一句 + 过期丢弃 + 写表前人工/合闸"（docs/15 §18）。
 */
import { locateTermSpan, planRescue } from '../plugin/core.mjs'

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

  await it('闸门：不像规范写法的译名/缩写也允许（激进版，实测反馈）', () => {
    // 实测：表里 亮亮眼镜 → Leion，模型写 "Liangliang Ótica"。
    // 保守版会被"形状相似"拒绝；激进版**允许**（由模型判断它写成了什么），
    // 靠"原样出现 + 不串台 + 长度 + 格式"兜底。
    const draft = 'O time de São Paulo fez essa apresentação junto com a Liangliang Ótica.'
    const plan = planRescue({
      draft, answer: 'Liangliang Ótica', canonical: 'Leion', entries: ENTRIES, targetZh: false, cols: 40, lines: 3,
    })
    check('译名类允许通过', plan.ok === true, JSON.stringify(plan))
    check('只换那一小段（句首冠词不被动）', plan.text === 'O time de São Paulo fez essa apresentação junto com a Leion.', plan.text)
    const pinyin = planRescue({
      draft: 'A Liangliang colabora.', answer: 'Liangliang', canonical: 'LLVision', entries: ENTRIES, targetZh: false, cols: 40, lines: 3,
    })
    check('音译名也允许通过', pinyin.ok === true, JSON.stringify(pinyin))
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
}
