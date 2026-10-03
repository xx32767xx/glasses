/**
 * fake-llm.mjs —— 给真实组合提供一个假的 llm 服务
 * ============================================================================
 * 目的：让 leion_translate（6 个工具里 output schema 最复杂的一个，含可空 oneOf 字段）
 * 也能在**真实执行流水线**里跑成功，从而让真实的 output.schema 校验器去审它。
 * 假服务只产出固定译文，不联网、不需要 API key。
 */

export const name = 'leion-live-fake-llm'

const ZH_TEXT = '早上好！我们今天的会议改到了下午三点，在十二楼的会议室。'
const PT_TEXT = 'Bom dia! A nossa reunião de hoje passou para as três da tarde, na sala do décimo segundo andar.'

export function apply(ctx) {
  ctx.provide('llm', {
    listProviders: () => [{ id: 'deepseek', name: 'DeepSeek（真实组合验证用的假适配器）' }],
    listModels: async () => [{ id: 'deepseek-chat' }],
    stream(options) {
      // 按 system 提示词判断该产出哪种语言，让语向断言是确定的。
      const wantsPt = String(options.system ?? '').includes('巴西葡萄牙语')
      const text = wantsPt ? PT_TEXT : ZH_TEXT
      const pieces = text.match(/.{1,12}/gu) ?? []
      return (async function* generate() {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        for (const piece of pieces) yield { type: 'text-delta', index: 0, text: piece }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        // 真实形状：finish 的原因是对象（FinishReasonMap），不是字符串
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  })
}
