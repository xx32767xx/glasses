/**
 * show-prompt.mjs —— 打印**真实生成**的提示词
 * ============================================================================
 *   node scripts/show-prompt.mjs
 *
 * 调翻译质量时先看这个，而不是猜"提示词里到底写了什么"。
 * 它调的是插件自己用的那个函数（translationSystem），所以看到的就是每次翻译
 * 真正发给模型的那段 system 提示词。
 *
 * 我加这个工具的直接原因：第一次把它打出来，就发现"译成中文"那一版里还留着
 * "使用巴西葡语的自然口语表达"这条规则 —— 目标是中文，这条毫无意义。
 * 光看代码看不出来，打出来一眼就看到了。
 */

import { translationSystem } from '../plugin/core.mjs'
import { POLICY } from '../plugin/policy.generated.mjs'

const SEPARATOR = '='.repeat(70)

const directions = [
  { from: 'zh-CN', to: 'pt-BR', label: '译成巴葡（对方说中文 / 佩戴者说中文时用）' },
  { from: 'pt-BR', to: 'zh-CN', label: '译成中文（对方说葡语时用）' },
]

for (const { from, to, label } of directions) {
  const prompt = translationSystem(POLICY, from, to)
  console.log('\n' + SEPARATOR)
  console.log(`${label}    ${from} → ${to}`)
  console.log(SEPARATOR)
  console.log(prompt)
  console.log(SEPARATOR)
  console.log(`字符数 ${prompt.length}`)
}

const toPt = translationSystem(POLICY, 'zh-CN', 'pt-BR').length
const toZh = translationSystem(POLICY, 'pt-BR', 'zh-CN').length
console.log('')
console.log(`术语表只在译成巴葡时附加，多占 ${toPt - toZh} 个字符（每次调用都要付这份 token）`)
console.log('改口径请改 policy/br-pt.json，然后 node scripts/generate.mjs')
