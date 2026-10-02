/**
 * demo-phrasebook.mjs —— 离线演示用的假 llm 适配器（例句表驱动）
 * ============================================================================
 * 为什么需要它：演示当天最怕的事是网络不可用或额度用尽。这个适配器把
 * bridge/sample-transcript.txt 那 14 句的中葡对照硬编码成表，于是演示
 * 完全离线、完全可复现、零成本。
 *
 * 它诚实地只处理这 14 句：查不到就明确返回一句「例句表里没有这句」，
 * 而不是编一个像样的译文糊过去。
 *
 * 想要真翻译就用 --live：那条路会挂上真实的 dsh-llm + dsh-llm-deepseek，
 * 走你已配置的凭据。
 */

export const name = 'leion-demo-phrasebook'

/** 巴葡 → 中文（对方说，译给佩戴者读）。 */
const PT_TO_ZH = {
  'Bom dia! Que bom ver vocês de novo por aqui.': '早上好！很高兴你们又来了。',
  'A nossa reunião de hoje passou para as três da tarde.': '我们今天的会议改到了下午三点。',
  'A sala é no décimo segundo andar, perto do elevador.': '会议室在十二楼，电梯旁边。',
  'Precisamos confirmar o número de participantes para o almoço.': '我们需要确认一下午餐的人数。',
  'Perfeito. Vou mandar a confirmação por e-mail hoje ainda.': '太好了，我今天就把确认发邮件给你。',
  'Uma última coisa: o contrato já foi assinado pela diretoria.': '还有一件事：合同董事会已经签好了。',
  'Ótimo, então podemos começar o projeto na segunda-feira.': '好，那我们周一开始项目。',
}

/** 中文 → 巴葡（佩戴者说，译给对方听；眼镜上只做回显）。 */
const ZH_TO_PT = {
  '早上好！很高兴再次见到你们。': 'Bom dia! Que bom ver vocês de novo.',
  '好的，那我们把材料提前发给你。': 'Certo, então vamos mandar o material para você com antecedência.',
  '我们这边一共三个人参加，另外还有一位同事线上接入。': 'Do nosso lado somos três pessoas, e mais um colega entra online.',
  '午餐订在楼下的餐厅，人均一百二十雷亚尔。': 'O almoço está reservado no restaurante aqui embaixo, cento e vinte reais por pessoa.',
  '好的，请在明天下午三点前回复，我们好跟餐厅确认。': 'Certo, por favor responda até amanhã às três da tarde, para confirmarmos com o restaurante.',
  '合同上周五就签好了，扫描件在共享文件夹里。': 'O contrato foi assinado na sexta passada, o escaneado está na pasta compartilhada.',
  '好，那我们下周一正式开始，谢谢大家。': 'Ótimo, então começamos oficialmente na segunda que vem. Obrigado a todos.',
}

/** 供测试与文档读取。 */
export const PHRASEBOOK = { 'pt-BR': PT_TO_ZH, 'zh-CN': ZH_TO_PT }

const normalize = text => String(text).replace(/\s+/g, ' ').trim()

/** 按目标语言查表；查不到返回 null。 */
export function lookup(sourceText, targetLang) {
  const key = normalize(sourceText)
  if (targetLang === 'zh-CN') return PT_TO_ZH[key] ?? null
  if (targetLang === 'pt-BR') return ZH_TO_PT[key] ?? null
  return null
}

export function apply(ctx) {
  ctx.provide('llm', {
    listProviders: () => [{ id: 'deepseek-official', name: '离线例句表（演示用）' }],
    listModels: async () => [{ id: 'demo-phrasebook' }],
    stream(options) {
      const system = String(options.system ?? '')
      const targetLang = system.includes('巴西葡萄牙语') ? 'pt-BR' : 'zh-CN'
      const source = options.messages?.[0]?.content?.[0]?.text ?? ''
      const hit = lookup(source, targetLang)
      const text = hit ?? `（离线演示：例句表里没有这一句，原文为「${normalize(source)}」）`
      const pieces = text.match(/.{1,8}/gu) ?? []
      return (async function* generate() {
        for (const piece of pieces) yield { type: 'text-delta', index: 0, text: piece }
        yield { type: 'finish', reason: 'stop' }
      })()
    },
  })
}
