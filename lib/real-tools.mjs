/**
 * real-tools.mjs —— 解析并加载检出里**真实的** @deepseek-ai/dsh-tools 构建产物
 * ============================================================================
 * 测试台与生成器都靠它拿到真实的 defineTool / schema 校验器。
 * 拒绝降级：拿不到真实产物就直接抛，因为仿造校验器会给出虚假的安全感
 * （历史上就放过了「output.schema 写成原始 JSON Schema」这种真实环境必然失败的写法）。
 */

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const CHECKOUT = process.env.DSH_CHECKOUT ?? 'D:\\DeepSeekHarness\\deepseek-harness'
export const TOOLS_BUILD = join(CHECKOUT, 'packages', 'core', 'tools', 'lib', 'index.js')

let mod
try {
  mod = await import(pathToFileURL(TOOLS_BUILD).href)
} catch (cause) {
  throw new Error(
    '无法加载真实的 @deepseek-ai/dsh-tools 构建产物，契约保真度无法保证，拒绝降级运行。\n'
    + `尝试的路径：${TOOLS_BUILD}\n`
    + '请先在该检出里完成构建，或设置环境变量 DSH_CHECKOUT 指向 deepseek-harness 检出根目录。\n'
    + `底层错误：${String(cause && cause.message ? cause.message : cause)}`,
  )
}

for (const required of ['defineTool', 'validateJsonSchemaValue', 'assertSupportedJsonSchema']) {
  if (typeof mod[required] !== 'function') {
    throw new Error(`真实 dsh-tools 构建产物里没有导出 ${required}，无法保证契约保真度。`)
  }
}

/** 真实的 author-facing DSL 编译器。 */
export const defineTool = mod.defineTool
/** 真实的 canonical value 校验器（返回违规列表，空数组表示合法）。 */
export const validateJsonSchemaValue = mod.validateJsonSchemaValue
/** 真实的「这是 harness 支持的 JSON Schema 子集吗」断言，失败即抛。 */
export const assertSupportedJsonSchema = mod.assertSupportedJsonSchema
