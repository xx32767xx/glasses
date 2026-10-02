/**
 * fake-sandbox.mjs —— 动态插件 Host 半的本地复刻测试台
 * ============================================================================
 *
 * 它复刻什么
 *   动态插件（cordis_define/cordis_run）真实跑在 @deepseek-ai/dsh-cordis-host-runner 的
 *   node:vm 沙箱里，只有创造模式会话能触发。这个文件让普通会话也能验证同一份代码：
 *
 *   1. 用同一个函数体包装求值：`(async () => { <code> })()`（与 precheckCode /
 *      evaluateHostCode 完全一致），所以语法错误、忘记 return、括号不配照原样报出来；
 *   2. 只注入真实沙箱允许的全局：ctx / harness / console / btoa / atob /
 *      TextEncoder / TextDecoder，并把 require / fetch / setTimeout / setInterval /
 *      setImmediate 做成"调用即抛"的陷阱；
 *   3. harness.defineTool 用的是**检出里真实的 defineTool 构建产物**，不是仿造的校验器。
 *      因此 parameters / output.schema 必须满足真实的 value schema DSL，否则这里就红；
 *   4. execute 的返回值额外过一遍真实 validateJsonSchemaValue（模拟流水线对 canonical
 *      value 的校验）+ 无损 JSON 检查；render 的返回值按 guard 的 assertRenderedContent
 *      检查「必须是内容块数组」。
 *
 * 为什么必须用真实 DSL 校验
 *   曾经的仿造校验器放过了「output.schema 写成原始 JSON Schema」这种写法，而真实 DSL
 *   会拒绝 required 数组、要求 object 显式声明 additionalProperties。仿造校验器会给出
 *   虚假的安全感，所以这里不接受降级。
 *
 * 它不能替代什么
 *   它不是安全边界，也不覆盖 runtime 服务（llm / fs）在沙箱里的真实行为。
 *   拿到创造模式会话后，仍应让 agent 用 cordis_inspect_query 核对服务签名。
 */

import { createContext, runInContext } from 'node:vm'
import { defineTool as realDefineTool, validateJsonSchemaValue } from '../lib/real-tools.mjs'

const DYNAMIC_TOOL = Symbol.for('dsh.fake.dynamicTool')

/** 真实沙箱里被禁用、调用即抛的 Node API（含它给出的替代指引）。 */
const NODE_API_REDIRECTS = {
  require: 'Node modules are unavailable — use the cordis services on ctx instead.',
  setTimeout: 'Node timers are unavailable — use the cordis timer service.',
  setInterval: 'Node timers are unavailable — use the cordis timer service.',
  setImmediate: 'Node timers are unavailable — use the cordis timer service.',
  clearTimeout: 'Node timers are unavailable — use the cordis timer service.',
  clearInterval: 'Node timers are unavailable — use the cordis timer service.',
  fetch: 'Network access goes through the cordis web service — inject "web" and call ctx.web.',
}

function isPlainRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isContentBlockShape(value) {
  return isPlainRecord(value) && typeof value.type === 'string'
}

/** 重新导出，便于报告里写清楚"验证的是真实构建产物还是仿造校验器"。 */
export { TOOLS_BUILD as REAL_TOOLS_BUILD } from '../lib/real-tools.mjs'

/**
 * 加载一个动态插件 Host 半。
 * @param code 插件源码（一个 async 函数体，必须 return 插件对象）
 * @param services 该插件通过 ctx.get() 能拿到的服务表
 * @param opts.toolsRegistry 可选的已存在工具表（用于检测重名）
 */
export async function loadHostHalf(code, services = {}, opts = {}) {
  const log = []
  const registered = opts.toolsRegistry ?? new Map()
  const handles = new Map()
  const effects = []

  const ctx = {
    get(name) {
      return services[name]
    },
    provide(name, value) {
      services[name] = value
      return () => { delete services[name] }
    },
    on() { return () => {} },
    once() { return () => {} },
    effect(callback) {
      const disposer = callback()
      effects.push(disposer)
      return () => {}
    },
    // unref：测试里这些 interval 不该让 Node 进程一直活着（真实 Cordis 会随 fiber 释放）。
    interval(fn, ms) { const id = setInterval(fn, ms); id.unref?.(); return () => clearInterval(id) },
    timeout(fn, ms) { const id = setTimeout(fn, ms); return () => clearTimeout(id) },
    throttle(fn, ms) { let last = 0; return (...a) => { const n = Date.now(); if (n - last >= ms) { last = n; return fn(...a) } } },
    debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) } },
  }

  /**
   * 动态沙箱里的 harness.defineTool：
   * 真实 DSL 校验交给真实 defineTool，这里只补 guard 在它外面做的那两件事
   * （render 必须是内容块数组；execute 返回值必须无损 JSON 且符合 output.schema）。
   */
  function defineTool(options) {
    if (typeof options.output?.render !== 'function') {
      throw new Error('harness.defineTool output must declare { schema, render, presentationMeta? }')
    }
    if (typeof options.execute !== 'function') {
      throw new Error('harness.defineTool execute must be a function')
    }
    const tool = realDefineTool(options)
    const wrapped = {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      outputSchema: tool.output.schema,
      async execute(args, exec) {
        const value = await tool.execute(args ?? {}, exec)
        const violations = validateJsonSchemaValue(tool.output.schema, value, '')
        if (violations.length > 0) {
          throw new Error(`harness.defineTool ${tool.name}.execute 的返回值不符合 output.schema：${violations.join('; ')}`)
        }
        const round = JSON.parse(JSON.stringify(value === undefined ? null : value))
        if (JSON.stringify(round) !== JSON.stringify(value === undefined ? null : value)) {
          throw new Error(`harness.defineTool ${tool.name}.execute returned a value that is not lossless JSON`)
        }
        return round
      },
      render(args, value) {
        const blocks = tool.output.render(args, value)
        if (!Array.isArray(blocks) || !blocks.every(isContentBlockShape)) {
          throw new Error(
            `harness.defineTool ${tool.name}.output.render must return an ARRAY of content blocks`
            + "\n  ✓ return [{ type: 'text', text: String(value) }]",
          )
        }
        return JSON.parse(JSON.stringify(blocks))
      },
    }
    Object.defineProperty(wrapped, DYNAMIC_TOOL, { value: true })
    return wrapped
  }

  function registerTool(target, tool) {
    if (!isPlainRecord(tool) || tool[DYNAMIC_TOOL] !== true) {
      throw new Error('dynamic tool registration must use a tool returned by harness.defineTool(...)')
    }
    if (registered.has(tool.name)) throw new Error(`duplicate tool name ${tool.name}`)
    registered.set(tool.name, tool)
    return () => registered.delete(tool.name)
  }

  const traps = {}
  for (const [name, message] of Object.entries(NODE_API_REDIRECTS)) {
    traps[name] = () => { throw new Error(`${name} is not available in the dynamic package sandbox — ${message}`) }
  }

  const sandbox = {
    ...traps,
    console: {
      log: (...a) => log.push(['log', a.map(String).join(' ')]),
      info: (...a) => log.push(['log', a.map(String).join(' ')]),
      warn: (...a) => log.push(['warn', a.map(String).join(' ')]),
      error: (...a) => log.push(['error', a.map(String).join(' ')]),
      debug: (...a) => log.push(['log', a.map(String).join(' ')]),
    },
    harness: { defineTool, registerTool, handle: (m, fn) => { handles.set(m, fn); return () => handles.delete(m) } },
    btoa: s => Buffer.from(s, 'utf-8').toString('base64'),
    atob: s => Buffer.from(s, 'base64').toString('utf-8'),
    TextEncoder,
    TextDecoder,
  }
  createContext(sandbox)

  const returned = await runInContext(`(async () => {\n${code}\n})()`, sandbox, { filename: 'fake-dyn-host.js' })

  if (!isPlainRecord(returned)) throw new Error(`插件必须 return 一个插件对象，实际拿到 ${typeof returned}`)
  if (typeof returned.apply !== 'function') throw new Error('插件对象必须提供 apply(ctx) 方法')

  let started = false
  return {
    plugin: returned,
    ctx,
    tools: registered,
    handles,
    effects,
    log,
    /** 跑一遍 apply，返回注册到的工具名列表。幂等：重复调用不会再 apply 一次。 */
    async start() {
      if (!started) {
        await returned.apply(ctx)
        started = true
      }
      return [...registered.keys()]
    },
  }
}

/** 断言辅助：失败时带上足够上下文，不吞异常。 */
export function check(label, condition, detail = '') {
  if (!condition) throw new Error(`断言失败：${label}${detail === '' ? '' : ' — ' + detail}`)
  return true
}
