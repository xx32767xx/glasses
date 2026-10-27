/** proofread-terms-suite.mjs —— 校对必须遵守术语表（钉住 2026-10-27 那个真错） */
import { proofreadSystem } from '../plugin/core.mjs'

const POLICY = {
  variety: { fullName: 'Português brasileiro', counterpart: { name: '中文（简体）' } },
  proofreadRules: ['只改明显的错，不要重新意译。'],
}

export async function runProofreadTermsSuite({ it, check }) {
  const entries = [
    { zh: '亮亮视野', pt: 'LLVision' },
    { zh: '亮亮眼镜', pt: 'Leion' },
  ]

  await it('校对提示词里带术语表（否则会把专名改成直译）', () => {
    const text = proofreadSystem(POLICY, 'zh-CN', 'pt-BR', entries)
    check('出现术语表标题', text.includes('术语表'), text.slice(0, 80))
    check('包含 LLVision', text.includes('LLVision'), text.slice(0, 200))
    check('包含 Leion', text.includes('Leion'))
    check('明确要求原样保留', text.includes('原样保留'))
    check('明确禁止自造新写法', text.includes('不要自行发明') || text.includes('禁止'))
  })

  await it('没有术语表时不注入空块（避免误导模型）', () => {
    const text = proofreadSystem(POLICY, 'zh-CN', 'pt-BR', [])
    check('没有术语表标题', !text.includes('术语表'), text.slice(0, 120))
    const alsoEmpty = proofreadSystem(POLICY, 'zh-CN', 'pt-BR')
    check('参数省略也安全', !alsoEmpty.includes('术语表'))
  })

  await it('坏条目被跳过，不影响其余条目', () => {
    const text = proofreadSystem(POLICY, 'zh-CN', 'pt-BR', [null, { zh: '空' }, entries[0]])
    check('仍包含有效条目', text.includes('LLVision'))
    check('不包含空条目行', !text.includes('- 空 →'), text.slice(0, 200))
  })
}