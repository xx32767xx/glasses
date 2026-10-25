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

/**
 * 候选检出路径（按可能性排序）。DSH_CHECKOUT 由调用方显式指定时优先。
 *
 * platform 参数只为让测试能把"Windows 候选"固定住；正常调用不用传。
 */
export function checkoutCandidates(env = process.env, cwd = process.cwd(), platform = process.platform) {
  const candidates = [
    env.DSH_CHECKOUT,
    env.DSH_HOME ? join(env.DSH_HOME, 'deepseek-harness') : null,
    join(homedir(), 'deepseek-harness'),          // ~/deepseek-harness
    '/opt/deepseek-harness',                      // 服务器上常见位置
    join(cwd, '..', 'deepseek-harness'),          // 与仓库并排
  ]
  // Windows 开发机的默认位置**只在 Windows 上**才有意义。
  // 早先它被无条件列进来，于是 Linux 上一个候选都没命中时会落到写死的 D:\ 路径，
  // 报错变成 `must not include encoded "/" or "\" characters` —— 完全看不出真因
  // 是"这台机器上根本没有检出"。见 docs/10 §2.0。
  if (platform === 'win32') candidates.push('D:\\DeepSeekHarness\\deepseek-harness')
  return candidates.filter(value => typeof value === 'string' && value !== '')
}

/** 找出第一个真的含有构建产物的候选。 */
export function resolveCheckout(env = process.env, cwd = process.cwd()) {
  for (const candidate of checkoutCandidates(env, cwd)) {
    if (existsSync(join(candidate, TOOLS_RELATIVE))) return candidate
  }
  return null
}

/** "这台机器上没有可用检出"时的说明。包含三条真正能照着做的路。 */
export function missingCheckoutMessage(env = process.env, cwd = process.cwd()) {
  return [
    '找不到可用的 deepseek-harness 检出（缺 packages/core/tools 的构建产物），拒绝降级运行。',
    '大脑（scripts/harness-side.mjs）必须跑在**真实的** DSH 工具运行时上，',
    '仿造一个会给出虚假的契约保真度 —— 那正是这套系统最不该省的地方。',
    '',
    '找过的候选：',
    ...checkoutCandidates(env, cwd).map(item => `  · ${item}`),
    '',
    '修法（三选一）：',
    '  ① 在服务器上放一份检出并构建：',
    '       git clone <deepseek-harness 仓库> ~/deepseek-harness',
    '       cd ~/deepseek-harness && pnpm install && pnpm build',
    '  ② 检出已经放在别处：export DSH_CHECKOUT=/path/to/deepseek-harness',
    '     交给 systemd 时写进单元：Environment=DSH_CHECKOUT=/path/to/deepseek-harness',
    '  ③ 只想先验证网络连通性：先不启动大脑（转发进程可以单独起）',
    '       node relay/lan-relay.mjs --data-dir <数据目录> --port 8788 --public',
    '',
    '检查这一步是否就绪：node scripts/preflight.cjs（第 ⑥ 项）',
  ].join('\n')
}

const resolved = resolveCheckout()
if (resolved === null) throw new Error(missingCheckoutMessage())

export const CHECKOUT = resolved
export const TOOLS_BUILD = join(CHECKOUT, TOOLS_RELATIVE)

let mod
try {
  mod = await import(pathToFileURL(TOOLS_BUILD).href)
} catch (cause) {
  throw new Error(
    '找到了 deepseek-harness 检出，但加载它的 @deepseek-ai/dsh-tools 构建产物失败，拒绝降级运行。\n'
    + `检出路经：${CHECKOUT}\n`
    + `加载的是：${TOOLS_BUILD}\n`
    + '请在该检出里重新构建（pnpm install && pnpm build），'
    + '并确认 Node 版本 ≥ 20。\n'
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
