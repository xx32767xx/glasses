/**
 * dsh-plugin-leion-pro —— 正式（持久）插件版入口
 * ============================================================================
 *
 * 亮亮视野 (LLVision) Leion Pro / GLXSS ME AR 眼镜设备插件 + 中↔巴西葡语双向同传。
 *
 * 与动态插件版的区别只在于「怎么把工具注册进 harness」，业务逻辑完全共用 plugin/core.mjs：
 *   · 动态版（../dynamic/leion-pro.host.js）：沙箱里没有 import，用 harness.defineTool 就地编译 schema；
 *   · 正式版（本文件）：走 ctx.tools.register()，schema 用 schemas.generated.mjs 里
 *     由同一份 DSL 预编译出的原始形式。
 *
 * 零第三方依赖：本包不 import 任何 node_modules，因此不受 profile 模块解析约束。
 * 唯一的相对 import 是同目录的 core.mjs 与生成文件 schemas.generated.mjs。
 *
 * 配置（cordis.yml 里这一行的 config 字段，全部可选，缺省见 core.mjs 的 CONFIG_DEFAULTS）：
 *   transport: 'mock' | 'file'   —— 眼镜怎么收字幕
 *   sinkPath: '<绝对路径>'        —— transport: 'file' 时的字幕总线文件
 *   cols / lines                 —— AR 显示预算
 *   partialThrottleMs            —— 流式字幕节流
 *   providerId / modelId         —— 翻译用的模型路由（留空则自动选第一个并发现模型）
 *   maxTokens / temperature
 */

import { TOOL_SCHEMAS } from './schemas.generated.mjs'
import { POLICY } from './policy.generated.mjs'
import {
  CONFIG_DEFAULTS,
  buildToolSpecs,
  createInterpreter,
  loadedMessage,
  validateConfig,
} from './core.mjs'

export const name = 'leion-pro'
// timer 是必需的：ASR 收件箱用 ctx.interval 轮询。它由 @deepseek-ai/dsh-base 挂着，
// 所以每个部署都有（dsh web 的 patch 层 HMR 也依赖它）。
export const inject = ['tools', 'timer']

/**
 * @param ctx Cordis 上下文（已注入 tools）
 * @param config 见文件头注释；缺省取 CONFIG_DEFAULTS
 */
export function apply(ctx, config) {
  // 配置错误要响亮：不合法就在加载时抛，不要留到运行期。validateConfig 同时填默认值。
  const resolved = validateConfig(config === undefined || config === null ? {} : config)
  // policy 由生成物提供（唯一来源是 policy/br-pt.json）：巴葡口径只在那一处维护。
  const rt = createInterpreter(ctx, resolved, { policy: POLICY })

  for (const spec of buildToolSpecs(rt)) {
    const compiled = TOOL_SCHEMAS[spec.name]
    if (compiled === undefined) {
      throw new Error(
        `leion-pro: schemas.generated.mjs 里没有 ${spec.name} 的编译结果。`
        + '请运行 node scripts/generate.mjs 重新生成。',
      )
    }
    ctx.tools.register({
      name: spec.name,
      description: spec.description,
      parameters: compiled.parameters,
      output: { schema: compiled.outputSchema, render: spec.render },
      execute: spec.execute,
    })
  }

  console.log(loadedMessage(rt))
}

// 供诊断/测试读取，让"这个包默认是什么配置"可被程序化检查，而不是只能读注释。
export { CONFIG_DEFAULTS }
