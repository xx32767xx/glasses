/**
 * real-tools.mjs —— 解析并加载检出里**真实的** @deepseek-ai/dsh-tools 构建产物
 * ============================================================================
 * 测试台与生成器都靠它拿到真实的 defineTool / schema 校验器。
 * 拒绝降级：拿不到真实产物就直接抛，因为仿造校验器会给出虚假的安全感
 * （历史上就放过了「output.schema 写成原始 JSON Schema」这种真实环境必然失败的写法）。
 *
 * ⚠️ 服务器部署相关：**别把检出路径写死**。
 * 这里原来是 `process.env.DSH_CHECKOUT ?? 'D:\\DeepSeekHarness\\deepseek-harness'`，
 * 一个写死的 Windows 路径 —— 于是"电脑端搬到 Linux 服务器"这件事在**第一步**就断了
 * （服务器上没有 D 盘，而报错是 ENOENT，看不出是路径写死导致的）。
 * 现在按候选顺序找，并把"找过哪些"写进错误信息。
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 检出里必须有这个文件，才算一个可用的检出。 */
const TOOLS_RELATIVE = join('packages', 'core', 'tools', 'lib', 'index.js')

/** 候选检出路径（按可能性排序）。DSH_CHECKOUT 由调用方显式指定时优先。 */
export function checkoutCandidates(env = process.env, cwd = process.cwd()) {
  return [
    env.DSH_CHECKOUT,
    env.DSH_HOME ? join(env.DSH_HOME, 'deepseek-harness') : null,
    join(homedir(), 'deepseek-harness'),          // ~/deepseek-harness
    '/opt/deepseek-harness',                      // 服务器上常见位置
    join(cwd, '..', 'deepseek-harness'),          // 与仓库并排
    'D:\\DeepSeekHarness\\deepseek-harness',      // 开发机（Windows）
  ].filter(value => typeof value === 'string' && value !== '')
}

/** 找出第一个真的含有构建产物的候选。 */
export function resolveCheckout(env = process.env, cwd = process.cwd()) {
  for (const candidate of checkoutCandidates(env, cwd)) {
    if (existsSync(join(candidate, TOOLS_RELATIVE))) return candidate
  }
  return null
}

const resolved = resolveCheckout()
export const CHECKOUT = resolved ?? (process.env.DSH_CHECKOUT
  ?? 'D:\\DeepSeekHarness\\deepseek-harness')
export const TOOLS_BUILD = join(CHECKOUT, TOOLS_RELATIVE)

let mod
try {
  mod = await import(pathToFileURL(TOOLS_BUILD).href)
} catch (cause) {
  throw new Error(
    '无法加载真实的 @deepseek-ai/dsh-tools 构建产物，契约保真度无法保证，拒绝降级运行。\n'
    + `尝试的路径：${TOOLS_BUILD}\n`
    + '找过的候选（都没有构建产物，或都没有这个目录）：\n'
    + checkoutCandidates().map(item => `  · ${item}`).join('\n') + '\n'
    + '请先在该检出里完成构建（pnpm install && pnpm build），'
    + '或设置环境变量 DSH_CHECKOUT 指向 deepseek-harness 检出根目录。\n'
    + (resolved === null
      ? '注意：一个候选都没命中，说明这台机器上还没放检出。\n'
      : '')
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
