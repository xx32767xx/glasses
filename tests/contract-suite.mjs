/**
 * contract-suite.mjs —— 两个包装目标共用的行为契约套件
 * ============================================================================
 * 同一套断言跑在「动态插件」和「正式插件」上，并顺手收集一份 fingerprint（可比较的
 * 场景结果），由 run-all.mjs 做逐字段一致性对比。这样"两份包装行为一致"是被验证的事实，
 * 而不是靠人记得同步。
 *
 * 断言尽量针对**可观察行为**，而不是实现细节。
 */

// ── 假服务 ───────────────────────────────────────────────────────────────────

import { createServer } from 'node:http'
import { TEST_DIR } from '../lib/paths.mjs'
// 纯函数直接从源文件拿（core.mjs 零 import，在 node 里能直接加载）——
// 这样判据可以**绕过链路直接单测**：链路里的假 LLM 输出是固定句型，造不出某些场景。
import { proofreadRegression } from '../plugin/core.mjs'

/** 按 system 提示词判断要产出哪种语言的译文，让语向断言是确定的。 */
function cannedTranslation(options) {
  const system = String(options.system ?? '')
  return system.includes('巴西葡萄牙语')
    ? 'Bom dia! A nossa reunião de hoje passou para as três da tarde, na sala do décimo segundo andar.'
    : '早上好！我们今天的会议改到了下午三点，在十二楼的会议室。'
}

export function makeFakeLlm({ finish = 'stop' } = {}) {
  const calls = []
  const state = { lastFinishReason: null }
  return {
    calls,
    state,
    listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
    listModels: async () => [{ id: 'deepseek-chat' }],
    stream(options) {
      calls.push(options)
      const pieces = cannedTranslation(options).match(/.{1,12}/gu) ?? []
      // ⚠️ finish 的原因是**对象**（FinishReasonMap），不是字符串：
      //    { kind: 'stop' } / { kind: 'max-tokens' } / { kind: 'error', failure }
      // 早期这个假适配器发的是字符串 'stop'，于是真实世界里"把对象当字符串比对"的
      // bug 被测试台放过了 —— 每一句正确译文都被误判成"流没正常结束"丢掉了。
      const reason = finish === 'error' || finish === 'aborted'
        ? { kind: finish, failure: { code: 'TEST_FAILURE', message: '假适配器制造的故障' } }
        : { kind: finish }
      state.lastFinishReason = reason
      return (async function* generate() {
        for (const piece of pieces) yield { type: 'text-delta', index: 0, text: piece }
        yield { type: 'finish', reason }
      })()
    },
  }
}

/**
 * 一个会"改译文"的假适配器：用来测**校对这第二遍**。
 *
 * 怎么区分两次调用：校对那一次的 system 提示词里带「校对」两个字
 * （见 core.mjs 的 proofreadSystem —— 它开头就是"你在做**译文校对**"）。
 * 靠提示词内容分流，比靠"第几次调用"分流更结实：调用顺序以后可能变，
 * 而"哪一次是校对"是由提示词定义的。
 */
export function makeProofreadLlm({ corrected = 'CORRECTED', delayMs = 0, respond = null } = {}) {
  const calls = []
  return {
    calls,
    listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
    listModels: async () => [{ id: 'deepseek-chat' }],
    stream(options) {
      calls.push(options)
      const isProofread = String(options.system ?? '').includes('校对')
      const userText = String(options.messages?.[0]?.content?.[0]?.text ?? '')
      // respond 让"校对结果"随输入变化 —— 测"过期结果不许覆盖屏幕"时必须要这个：
      // 一个固定返回值没法区分"第一句的过期结果"和"第二句的正常结果"。
      const text = !isProofread
        ? cannedTranslation(options)
        : (respond === null ? corrected : respond(userText))
      return (async function* generate() {
        if (isProofread && delayMs > 0) await new Promise(r => setTimeout(r, delayMs))
        for (const piece of text.match(/.{1,12}/gu) ?? []) {
          yield { type: 'text-delta', index: 0, text: piece }
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

export function makeFakeFs(store) {
  return {
    async resolve(path) { return { path } },
    async stat(target) { return store.has(target.path) ? { kind: 'file' } : undefined },
    async readText(target) { return store.get(target.path) ?? '' },
    async writeText(target, content) { store.set(target.path, content); return { version: 'v1' } },
  }
}

/**
 * 一个会拒绝显式推理强度的假适配器：第一次调用以 UNSUPPORTED_REASONING_EFFORT 失败，
 * 去掉该字段后成功。用来验证插件的「去掉它重试一次」这条兜底路径。
 */
export function makeEffortRejectingLlm() {
  const calls = []
  return {
    calls,
    listProviders: () => [{ id: 'strict-route', name: 'Strict' }],
    listModels: async () => [{ id: 'strict-model' }],
    stream(options) {
      calls.push(options)
      const rejects = options.reasoningEffort !== undefined
      const text = cannedTranslation(options)
      return (async function* generate() {
        if (rejects) {
          // 真实形状：failure 挂在 reason 上，不在 chunk 上
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: '该路由不接受显式推理强度' },
            },
          }
          return
        }
        for (const piece of text.match(/.{1,12}/gu) ?? []) yield { type: 'text-delta', index: 0, text: piece }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

// ── 常量与测试工具 ───────────────────────────────────────────────────────────

const EXPECTED_TOOLS = [
  'leion_status', 'leion_display', 'leion_translate',
  'leion_history', 'leion_inbox', 'leion_clear', 'leion_selftest',
]

/**
 * 每个工具的最小合法参数。
 * 真实 defineTool / 参数校验会拒绝缺必填的调用，所以这里必须给合法值——
 * 这也正是"参数校验在工作"的证据。新增工具却忘了在这里加样例，断言会直接把测试打红。
 */
const SAMPLE_ARGS = {
  leion_status: {},
  leion_clear: {},
  leion_selftest: {},
  leion_inbox: { action: 'status' },
  leion_history: { limit: 3 },
  leion_display: { text: '链路测试', speaker: 'them', lang: 'zh-CN' },
  leion_translate: { text: 'A reunião de hoje é às três.' },
}

/**
 * 收件箱测试用的假路径：只是 Map 里的键，不会真的落盘。
 * 以前这里写死了 'E:/GlassesHarness/.tmp/' —— 不落盘所以不会崩，但换个机器看就很别扭，
 * 而且会让人以为仓库必须放在 E 盘。现在从 lib/paths.mjs 推导。
 */
const INBOX_SANDBOX = TEST_DIR.replace(/\\/g, '/') + '/'
const inboxPathOf = name => INBOX_SANDBOX + name

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 轮询等待某个条件成立（跑在测试进程里，用真实定时器）。 */
async function waitFor(probe, { timeout = 5000, step = 25 } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    if (await probe()) return true
    if (Date.now() > deadline) return false
    await sleep(step)
  }
}

/** 去掉时间戳，让两个版本的结果可以逐字段比较。 */
function stripTimes(value) {
  if (Array.isArray(value)) return value.map(stripTimes)
  if (value === null || typeof value !== 'object') return value
  const out = {}
  for (const [key, inner] of Object.entries(value)) {
    if (key === 'at' || key === 'pushedAt') continue
    out[key] = stripTimes(inner)
  }
  return out
}

// ── 套件本体 ─────────────────────────────────────────────────────────────────

/**
 * @param adapter host-adapters.mjs 里的适配器
 * @param helpers { it, check, assert }
 * @returns fingerprint 供两个版本做一致性对比
 */
export async function runContractSuite(adapter, { it, check, assert }) {
  const fingerprint = {}

  const llm = makeFakeLlm()
  const fsStore = new Map()
  const box = await adapter.create({ llm, fs: makeFakeFs(fsStore) })

  // ── 1. 加载与形状 ──────────────────────────────────────────────────────────

  await it('插件暴露了 name 与 apply()', async () => {
    check('apply 是函数', typeof box.plugin.apply === 'function')
    check('name 是 leion-pro', box.plugin.name === 'leion-pro', `实际 ${box.plugin.name}`)
  })

  await it(`apply() 注册齐了 ${EXPECTED_TOOLS.length} 个工具`, async () => {
    const names = await box.start()
    assert.deepEqual([...names].sort(), [...EXPECTED_TOOLS].sort())
  })

  await it('加载时打出了可读的启动日志', async () => {
    const line = box.log.map(([, text]) => text).find(t => t.includes('[leion-pro] 插件已加载'))
    check('有启动日志', line !== undefined, `实际日志：${JSON.stringify(box.log)}`)
    check('日志里有型号', line.includes('Leion Pro'), line)
    check('日志里有传输通道', line.includes('transport=mock'), line)
  })

  // ── 2. 工具契约 ────────────────────────────────────────────────────────────

  await it('每个工具都有非空 description 与合法 parameters', async () => {
    assert.deepEqual([...Object.keys(SAMPLE_ARGS)].sort(), [...EXPECTED_TOOLS].sort(), '样例参数表必须覆盖所有工具')
    for (const tool of box.tools.values()) {
      check(`${tool.name} 有描述`, typeof tool.description === 'string' && tool.description.length > 20)
      check(`${tool.name} parameters 是对象`, typeof tool.parameters === 'object' && tool.parameters !== null)
    }
  })

  await it('参数校验生效：缺必填参数会被拒绝', async () => {
    await assert.rejects(
      () => box.tools.get('leion_translate').execute({}),
      /missing required property "text"/,
    )
  })

  await it('every output.render 返回内容块数组，且 execute 返回值符合 output.schema', async () => {
    for (const tool of box.tools.values()) {
      const args = SAMPLE_ARGS[tool.name]
      const value = await tool.execute(args)
      const blocks = tool.render(args, value)
      check(`${tool.name}.render 返回数组`, Array.isArray(blocks))
      check(`${tool.name}.render 元素带 type`, blocks.every(b => typeof b.type === 'string'))
      check(`${tool.name}.render 有文本`, blocks.some(b => typeof b.text === 'string' && b.text.length > 0))
    }
  })

  // ── 3. 设备状态与排版 ──────────────────────────────────────────────────────

  await it('leion_status 报出 Leion Pro 与显示预算', async () => {
    const status = await box.tools.get('leion_status').execute({})
    check('ok', status.ok === true)
    check('型号', status.device === 'Leion Pro', status.device)
    check('厂商', status.vendor.includes('LLVision'), status.vendor)
    check('显示预算 40×3', status.cols === 40 && status.lines === 3, JSON.stringify([status.cols, status.lines]))
    fingerprint.status = stripTimes(status)
  })

  await it('leion_display 守住 cols × lines 排版预算（含超长中葡混排）', async () => {
    const long = 'Bom dia! 我们今天的会议改到下午三点，会议室在十二楼，请带上你的笔记本电脑和充电器，'
      + '另外财务部需要你确认一下上个月的报销单据，谢谢你的配合。'
    const result = await box.tools.get('leion_display').execute({ text: long, speaker: 'them', lang: 'pt-BR' })
    check('ok', result.ok === true)
    check('行数不超预算', result.lines.length <= 3, `实际 ${result.lines.length} 行`)
    for (const line of result.lines) {
      check('每行不超宽', [...line].length <= 40, `实际 ${[...line].length} 列：${line}`)
    }
    check('保留的是尾部（最近说的话）', result.lines.join('').includes('谢谢'), result.lines.join(' / '))
    check('drawFrame 画出了框', result.preview.includes('┌') && result.preview.includes('└'))
    fingerprint.display = stripTimes(result)
  })

  // ── 4. 双向翻译路由 ────────────────────────────────────────────────────────

  await it('巴葡 → 中文：佩戴者读中文译本，且没有出站内容', async () => {
    const result = await box.tools.get('leion_translate').execute({
      text: 'A reunião de hoje passou para as três da tarde.',
    })
    check('ok', result.ok === true, JSON.stringify(result))
    check('判出巴葡', result.from === 'pt-BR', result.from)
    check('译成中文', result.to === 'zh-CN', result.to)
    check('佩戴者读的是对方的话', result.displaySpeaker === 'them', result.displaySpeaker)
    check('出站为空', result.outbound === null, JSON.stringify(result.outbound))
    check('译文是中文', result.translation.includes('会议'), result.translation)
    check('报告了模型路由', typeof result.model === 'string' && result.model.includes('/'), result.model)
    fingerprint.translatePtToZh = stripTimes(result)
  })

  await it('中文 → 巴葡：佩戴者侧只回显，同时给出站通道内容', async () => {
    const result = await box.tools.get('leion_translate').execute({ text: '我们今天的会议改到下午三点了。' })
    check('ok', result.ok === true, JSON.stringify(result))
    check('判出中文', result.from === 'zh-CN', result.from)
    check('译成巴葡', result.to === 'pt-BR', result.to)
    check('这帧记在佩戴者名下', result.displaySpeaker === 'me', result.displaySpeaker)
    check('有出站内容', result.outbound !== null)
    check('出站语种是巴葡', result.outbound.lang === 'pt-BR', result.outbound.lang)
    check('出站指向对方通道', result.outbound.channel === 'counterpart', result.outbound.channel)
    check('译文是巴葡', /reuni/i.test(result.translation), result.translation)
    fingerprint.translateZhToPt = stripTimes(result)
  })

  await it('翻译请求带上了巴葡口径的 system 提示词与规范 Message 形状', async () => {
    const call = llm.calls.at(-1)
    check('走了 llm.stream', call !== undefined)
    check('provider 正确', call.provider === 'deepseek', call.provider)
    check('model 正确', call.model === 'deepseek-chat', call.model)
    check('system 要求巴葡', call.system.includes('巴西葡萄牙语'), call.system.slice(0, 40))
    check('system 禁止欧洲葡语', call.system.includes('欧洲葡语'))
    check('messages 是数组且有 1 条', Array.isArray(call.messages) && call.messages.length === 1)
    const m = call.messages[0]
    check('role=user', m.role === 'user', m.role)
    check('有稳定 id', typeof m.id === 'string' && m.id.length > 0, m.id)
    check('content 是 text 块', m.content[0].type === 'text' && typeof m.content[0].text === 'string')
    check('source 是 user', m.source.kind === 'user', JSON.stringify(m.source))
  })

  await it('语种判不出来时明确失败，而不是猜一个方向', async () => {
    const result = await box.tools.get('leion_translate').execute({ text: 'ok' })
    check('未成功', result.ok === false, JSON.stringify(result))
    check('给出了可照做的提示', result.failure.includes('from='), result.failure)
  })

  await it('显式指定语向时覆盖自动判定', async () => {
    const result = await box.tools.get('leion_translate').execute({ text: 'Hello', from: 'zh-CN', to: 'pt-BR' })
    check('ok', result.ok === true, JSON.stringify(result))
    check('from 被采纳', result.from === 'zh-CN', result.from)
    check('to 被采纳', result.to === 'pt-BR', result.to)
  })

  // ── 5. 流式与失败处理 ──────────────────────────────────────────────────────

  await it('流式增量被节流后推送（边说边显），且最终帧也推了', async () => {
    const before = (await box.tools.get('leion_status').execute({})).pushes
    const result = await box.tools.get('leion_translate').execute({ text: '我们今天的会议改到下午三点了。' })
    const after = await box.tools.get('leion_status').execute({})
    check('ok', result.ok === true, JSON.stringify(result))
    check('产生了增量推送', after.partials > 0, `partials=${after.partials}`)
    check('推送数增长 >= 2（增量 + 定稿）', after.pushes - before >= 2, `before=${before} after=${after.pushes}`)
  })

  await it('模型流没有正常结束（finish=error）时丢弃译文，不显示半截', async () => {
    const broken = await adapter.create({ llm: makeFakeLlm({ finish: 'error' }), fs: makeFakeFs(new Map()) })
    const result = await broken.tools.get('leion_translate').execute({ text: '我们今天的会议改到下午三点了。' })
    check('未成功', result.ok === false, JSON.stringify(result).slice(0, 200))
    check('说明了原因', String(result.failure).includes('finish'), result.failure)
    check('把半截译文交出来供排查', typeof result.partial === 'string' && result.partial.length > 0)
  })

  await it('流式增量只上屏、不进双语历史（历史是「现场说过什么」的记录）', async () => {
    const before = await box.tools.get('leion_status').execute({})
    const result = await box.tools.get('leion_translate').execute({ text: 'A reunião é às três da tarde.' })
    check('ok', result.ok === true, JSON.stringify(result).slice(0, 200))
    const after = await box.tools.get('leion_status').execute({})
    check('确实产生了流式增量', after.partials > before.partials, `${before.partials} → ${after.partials}`)
    check('历史只增加 1 条（定稿帧）', after.historyCount - before.historyCount === 1,
      `${before.historyCount} → ${after.historyCount}（碎片被写进历史了？）`)
  })

  await it('翻译失败时：碎片不进历史，屏幕恢复成上一帧可用字幕', async () => {
    const broken = await adapter.create({
      llm: makeFakeLlm({ finish: 'max-tokens' }), fs: makeFakeFs(new Map()),
    })
    // 先推一帧成功的，当「上一帧可用字幕」
    const good = await broken.tools.get('leion_display').execute({
      text: '上一句：会议改到下午三点了。', speaker: 'them', lang: 'zh-CN',
    })
    check('ok', good.ok === true, JSON.stringify(good))
    const beforeCount = (await broken.tools.get('leion_status').execute({})).historyCount

    const failed = await broken.tools.get('leion_translate').execute({ text: 'A reunião é às três.' })
    check('未成功', failed.ok === false, JSON.stringify(failed).slice(0, 200))
    check('报告了已恢复屏幕', failed.restoredDisplay === true, JSON.stringify(failed))

    const status = await broken.tools.get('leion_status').execute({})
    check('碎片没进历史', status.historyCount === beforeCount, `${beforeCount} → ${status.historyCount}`)
    check('屏幕恢复成上一帧', status.lastFrame.text === '上一句：会议改到下午三点了。',
      JSON.stringify(status.lastFrame))
    check('恢复了 1 次', status.restored === 1, String(status.restored))
  })

  await it('finish 的原因是对象 {kind:"stop"} —— 不能被当成"流没正常结束"丢掉', async () => {
    // 回归测试：早期版本把 reason 当字符串比对（reason !== 'stop'），
    // 于是真实环境里每一句完全正确的译文都被丢弃、眼镜上什么都不显示。
    const shaped = makeFakeLlm()
    const shapedBox = await adapter.create({ llm: shaped, fs: makeFakeFs(new Map()) })
    const result = await shapedBox.tools.get('leion_translate').execute({ text: 'A reunião é às três da tarde.' })
    check('译文被接受', result.ok === true, JSON.stringify(result).slice(0, 240))
    check('译文内容有长度', typeof result.translation === 'string' && result.translation.length > 5, result.translation)
    check('假适配器发的确实是真实的对象形状', typeof shaped.state.lastFinishReason === 'object',
      JSON.stringify(shaped.state.lastFinishReason))
    check('kind 是 stop', shaped.state.lastFinishReason.kind === 'stop', JSON.stringify(shaped.state.lastFinishReason))
  })

  await it('finish 原因非 stop（{kind:"max-tokens"}）时仍然丢弃译文', async () => {
    const truncated = await adapter.create({ llm: makeFakeLlm({ finish: 'max-tokens' }), fs: makeFakeFs(new Map()) })
    const result = await truncated.tools.get('leion_translate').execute({ text: 'A reunião é às três.' })
    check('未成功', result.ok === false, JSON.stringify(result).slice(0, 200))
    check('原因写清了是 max-tokens', String(result.failure).includes('max-tokens'), result.failure)
    check('没有编造失败码', !String(result.failure).includes('undefined'), result.failure)
  })

  await it('finish 原因是 error 时把 failure 的 code 与 message 带出来', async () => {
    const failed = await adapter.create({ llm: makeFakeLlm({ finish: 'error' }), fs: makeFakeFs(new Map()) })
    const result = await failed.tools.get('leion_translate').execute({ text: 'A reunião é às três.' })
    check('未成功', result.ok === false)
    check('带出了 code', String(result.failure).includes('TEST_FAILURE'), result.failure)
    check('带出了 message', String(result.failure).includes('假适配器制造的故障'), result.failure)
  })

  await it('翻译调用显式关闭推理强度（思考 token 会吃掉译文预算）', async () => {
    const probeLlm = makeFakeLlm()
    const probeBox = await adapter.create({ llm: probeLlm, fs: makeFakeFs(new Map()) })
    await probeBox.tools.get('leion_translate').execute({ text: 'A reunião é às três.' })
    const call = probeLlm.calls.at(-1)
    check('传了 reasoningEffort=off', call.reasoningEffort === 'off', JSON.stringify(call.reasoningEffort))
  })

  await it('路由不接受推理强度时：自动去掉它重试一次', async () => {
    const effortLlm = makeEffortRejectingLlm()
    const effortBox = await adapter.create({ llm: effortLlm, fs: makeFakeFs(new Map()) })
    const result = await effortBox.tools.get('leion_translate').execute({ text: 'A reunião é às três.' })
    check('最终成功', result.ok === true, JSON.stringify(result).slice(0, 200))
    check('调用了两次', effortLlm.calls.length === 2, String(effortLlm.calls.length))
    check('第一次带了 reasoningEffort', effortLlm.calls[0].reasoningEffort === 'off')
    check('第二次没带', effortLlm.calls[1].reasoningEffort === undefined, JSON.stringify(effortLlm.calls[1].reasoningEffort))
  })

  await it('没有 llm 服务时给出可照做的降级提示，而不是崩掉', async () => {
    const noLlm = await adapter.create({ fs: makeFakeFs(new Map()) })
    const result = await noLlm.tools.get('leion_translate').execute({ text: '你好' })
    check('未成功', result.ok === false)
    check('提示用 leion_display 兜底', result.failure.includes('leion_display'), result.failure)
  })

  // ── 5b. 翻译后端接缝（'harness-llm' / 'http' / 'none'） ────────────────────

  await it('巴葡策略是数据驱动的：术语表只在意译成巴葡时进提示词', async () => {
    const toPt = []
    const toZh = []
    const probe = {
      listProviders: () => [{ id: 'p', name: 'P' }],
      listModels: async () => [{ id: 'm' }],
      stream(options) {
        (String(options.system).includes('巴西葡萄牙语') ? toPt : toZh).push(String(options.system))
        return (async function* () { yield { type: 'text-delta', index: 0, text: 'x' }; yield { type: 'finish', reason: { kind: 'stop' } } })()
      },
    }
    const probeBox = await adapter.create({ llm: probe, fs: makeFakeFs(new Map()) })
    await probeBox.tools.get('leion_translate').execute({ text: '我们下周一正式开始。' })   // → 巴葡
    await probeBox.tools.get('leion_translate').execute({ text: 'A reunião é às três.' })  // → 中文

    check('译成巴葡的提示词进了 toPt 桶', toPt.length === 1, String(toPt.length))
    check('译成中文的提示词进了 toZh 桶', toZh.length === 1, String(toZh.length))
    const ptPrompt = toPt[0]
    check('译成巴葡时带上了第一对术语', ptPrompt.includes('ônibus') && ptPrompt.includes('autocarro'),
      ptPrompt.slice(-260))
    check('译成巴葡时带上了"不用葡葡"的对照格式', ptPrompt.includes('不用'), ptPrompt.slice(-160))
    check('译成中文时不带葡语术语表（省上下文）', !toZh[0].includes('ônibus'), toZh[0].slice(-160))
    check('译成中文时不带"用巴葡表达"那条规则（在反方向上毫无意义）',
      !toZh[0].includes('欧洲葡语'), toZh[0].slice(0, 400))
    check('译成巴葡时才有那条规则', ptPrompt.includes('欧洲葡语'), ptPrompt.slice(0, 400))
    check('策略里的规则条数进了提示词', ptPrompt.includes('AR 屏幕只有 3 行'), ptPrompt.slice(0, 400))
  })

  await it("translator='none' 走纯显示分支：不判语向、不调模型、原文即字幕", async () => {
    const noTranslator = makeFakeLlm()
    const displayOnly = await adapter.create({
      llm: noTranslator, fs: makeFakeFs(new Map()), config: { translator: 'none' },
    })
    const result = await displayOnly.tools.get('leion_translate').execute({
      text: '麻烦把合同扫描件发到我的邮箱里。', speaker: 'me',
    })
    check('ok', result.ok === true, JSON.stringify(result).slice(0, 200))
    check('标记为未翻译', result.translated === false, JSON.stringify(result.translated))
    check('译文即原文', result.translation === '麻烦把合同扫描件发到我的邮箱里。', result.translation)
    check('说话了在哪一侧…不适用，帧归属取自入参', result.displaySpeaker === 'me', result.displaySpeaker)
    check('没有出站内容', result.outbound === null, JSON.stringify(result.outbound))
    check('压根没调模型', noTranslator.calls.length === 0, String(noTranslator.calls.length))
    const status = await displayOnly.tools.get('leion_status').execute({})
    check('字幕照常进了历史', status.historyCount === 1, String(status.historyCount))
    check('lang 按文字自动判定为中文', status.lastFrame.lang === 'zh-CN', String(status.lastFrame.lang))
  })

  await it("translator='none' 时自检的翻译环节如实报 OK 并说明不做翻译", async () => {
    const noneBox = await adapter.create({ fs: makeFakeFs(new Map()), config: { translator: 'none' } })
    const result = await noneBox.tools.get('leion_selftest').execute({})
    check('翻译环节报 OK', result.translate === true, JSON.stringify(result.notes))
    check('说明里写清了不翻译', JSON.stringify(result.notes).includes('不翻译'), JSON.stringify(result.notes))
    check('总判定通过（没有 llm 也不该报红）', result.ok === true, JSON.stringify(result.notes))
  })

  if (adapter.capabilities.fetch) {
    await it("translator='http' 真的把文字 POST 给了外部端点，并用它返回的译文", async () => {
      const captured = []
      const endpoint = createServer((request, response) => {
        let body = ''
        request.on('data', chunk => { body += chunk })
        request.on('end', () => {
          captured.push(JSON.parse(body))
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ text: '（来自测试端点的译文）' }))
        })
      })
      await new Promise(resolve => endpoint.listen(0, '127.0.0.1', resolve))
      const url = `http://127.0.0.1:${endpoint.address().port}/translate`
      try {
        const httpBox = await adapter.create({
          fs: makeFakeFs(new Map()), config: { translator: 'http', translatorUrl: url },
        })
        const result = await httpBox.tools.get('leion_translate').execute({ text: 'A reunião é às três.' })
        check('ok', result.ok === true, JSON.stringify(result).slice(0, 240))
        check('用了端点返回的译文', result.translation === '（来自测试端点的译文）', result.translation)
        check('报告了后端是 http', String(result.model).startsWith('http'), result.model)
        check('端点确实收到了请求', captured.length === 1, JSON.stringify(captured))
        check('请求带上了原文', captured[0].text === 'A reunião é às três.', JSON.stringify(captured[0]))
        check('请求带上了语向', captured[0].from === 'pt-BR' && captured[0].to === 'zh-CN', JSON.stringify(captured[0]))
        check('没碰 harness 的模型服务', true)
      } finally {
        await new Promise(resolve => endpoint.close(resolve))
      }
    })

    await it("translator='http' 端点返回非 2xx 时如实失败", async () => {
      const bad = createServer((request, response) => {
        response.writeHead(500, { 'content-type': 'text/plain' })
        response.end('boom')
      })
      await new Promise(resolve => bad.listen(0, '127.0.0.1', resolve))
      try {
        const badBox = await adapter.create({
          fs: makeFakeFs(new Map()),
          config: { translator: 'http', translatorUrl: `http://127.0.0.1:${bad.address().port}/x` },
        })
        const result = await badBox.tools.get('leion_translate').execute({ text: 'A reunião é às três.' })
        check('未成功', result.ok === false, JSON.stringify(result).slice(0, 200))
        check('带上了状态码', String(result.failure).includes('500'), result.failure)
      } finally {
        await new Promise(resolve => bad.close(resolve))
      }
    })
  } else {
    await it("动态沙箱里 translator='http' 明确失败（fetch 是被拦的陷阱，不能假装能用）", async () => {
      const sandboxBox = await adapter.create({
        fs: makeFakeFs(new Map()),
        config: { translator: 'http', translatorUrl: 'http://127.0.0.1:1/translate' },
      })
      const result = await sandboxBox.tools.get('leion_translate').execute({ text: 'A reunião é às três.' })
      check('未成功', result.ok === false, JSON.stringify(result).slice(0, 240))
      check('失败原因可读且指向环境限制', String(result.failure).length > 10, result.failure)
      console.log(`         （沙箱里的失败信息：${String(result.failure).slice(0, 70)}…）`)
    })
  }

  await it('非法配置：translator 取值与非空 translatorUrl 会被拒绝', async () => {
    await assert.rejects(
      () => adapter.create({ fs: makeFakeFs(new Map()), config: { translator: 'bogus' } }),
      /translator 只能是/,
    )
    await assert.rejects(
      () => adapter.create({ fs: makeFakeFs(new Map()), config: { translator: 'http' } }),
      /translatorUrl/,
    )
    await assert.rejects(
      () => adapter.create({ fs: makeFakeFs(new Map()), config: { translatorTimeoutMs: 0 } }),
      /translatorTimeoutMs/,
    )
  })

  // ── 6. 历史与清屏 ──────────────────────────────────────────────────────────

  await it('leion_history 按 limit 返回最近帧，leion_clear 清空历史', async () => {
    const history = await box.tools.get('leion_history').execute({ limit: 3 })
    check('ok', history.ok === true)
    check('最多 3 条', history.count <= 3, `实际 ${history.count}`)
    check('每条都有时间/说话人/文本', history.entries.every(e => e.at && e.speaker && typeof e.text === 'string'))

    const before = (await box.tools.get('leion_status').execute({})).historyCount
    const cleared = await box.tools.get('leion_clear').execute({})
    check('清屏成功', cleared.ok === true, JSON.stringify(cleared))
    check('清掉的数量对得上', cleared.clearedHistory === before, `${cleared.clearedHistory} vs ${before}`)
    const after = await box.tools.get('leion_history').execute({})
    check('历史已空', after.count === 0, `实际 ${after.count}`)
  })

  // ── 7. 自检 ────────────────────────────────────────────────────────────────

  await it('leion_selftest 四条链路全绿，且自检探针不污染字幕历史', async () => {
    const before = (await box.tools.get('leion_status').execute({})).historyCount
    const result = await box.tools.get('leion_selftest').execute({})
    check('排版 OK', result.layout === true)
    check('显示通道 OK', result.transportOk === true)
    check('语种判定 OK', result.detect === true)
    check('翻译路由 OK', result.translate === true)
    check('未配收件箱时报 null（不算失败）', result.inbox === null, String(result.inbox))
    check('总判定通过', result.ok === true, JSON.stringify(result.notes))
    const after = (await box.tools.get('leion_status').execute({})).historyCount
    check('探针帧没进历史', after === before, `${before} → ${after}`)
    fingerprint.selftest = stripTimes(result)
  })

  // ── 8. ASR 收件箱：不需要 agent 介入的自动同传 ─────────────────────────────

  await it('未配置 inboxPath 时自动同传关闭，且 start 会被明确拒绝', async () => {
    const status = await box.tools.get('leion_inbox').execute({ action: 'status' })
    check('ok', status.ok === true)
    check('configured=false', status.configured === false)
    check('running=false', status.running === false)
    const started = await box.tools.get('leion_inbox').execute({ action: 'start' })
    check('启动被拒绝', started.ok === false, JSON.stringify(started))
    check('提示里点了 inboxPath', String(started.failure).includes('inboxPath'), started.failure)
  })

  await it('配置 inboxPath 后自动轮询：外部写一行就自动翻译并出字幕', async () => {
    const store = new Map()
    const path = inboxPathOf('inbox-auto.jsonl')
    const auto = await adapter.create({
      llm: makeFakeLlm(), fs: makeFakeFs(store), config: { inboxPath: path, inboxPollMs: 120 },
    })
    const status0 = await auto.tools.get('leion_inbox').execute({ action: 'status' })
    check('已配置', status0.configured === true)
    check('加载即自动启动', status0.running === true, JSON.stringify(status0))

    // 模拟外部 ASR：往收件箱追加一行（对方说巴葡）
    store.set(path, 'A reunião de hoje passou para as três da tarde.\n')
    const processed = await waitFor(async () =>
      (await auto.tools.get('leion_inbox').execute({ action: 'status' })).processed >= 1)
    check('这一行被自动处理了', processed)

    const history = await auto.tools.get('leion_history').execute({ limit: 10 })
    check('字幕进了历史', history.entries.length >= 1, JSON.stringify(history.entries.map(e => e.text)))
    const wearerFrame = history.entries.find(e => e.lang === 'zh-CN')
    check('译成了中文给佩戴者读', wearerFrame !== undefined, JSON.stringify(history.entries))
    check('内容是中文译本', wearerFrame.text.includes('会议'), wearerFrame.text)

    const status1 = await auto.tools.get('leion_inbox').execute({ action: 'status' })
    check('消费位置前进了', status1.consumedChars > 0, String(status1.consumedChars))
    check('没有错误', status1.errors === 0, String(status1.lastError))

    // 帧里必须同时有**原文和译文**：手机端要按"原文在上、译文在下"成对显示，
    // 而只有插件这一层同时知道这两样（原文是它的输入，译文是它的产出）。
    // 少了 source，手机就只能显示一段文字，原文译文分不出来。
    const finalFrame = history.entries[history.entries.length - 1]
    check('帧里有原文（source）', typeof finalFrame.source === 'string' && finalFrame.source !== '',
      JSON.stringify(finalFrame))
    check('帧里标了原文语种（sourceLang）', finalFrame.sourceLang === 'pt-BR',
      String(finalFrame.sourceLang))
    check('原文是葡语、译文是中文（确实是两段不同的文字）',
      finalFrame.source !== finalFrame.text
      && finalFrame.source.includes('reunião') && finalFrame.text.includes('会议'),
      JSON.stringify({ source: finalFrame.source, text: finalFrame.text }))
    // 定稿帧必须明确标出"这不是流式增量" —— 手机端靠它决定要不要打「生成中」、
    // 以及要不要把这一帧**原位**写进同一条字幕（而不是新增一条）。
    check('定稿帧带 partial=false（手机靠它区分"还在生成"）',
      finalFrame.partial === false, String(finalFrame.partial))

    fingerprint.inboxAuto = { configured: status1.configured, processed: status1.processed, errors: status1.errors }
    await auto.tools.get('leion_inbox').execute({ action: 'stop' })
  })

  // ── 5c. 大模型校对（第二遍，讯飞那种"先出译文、再回头改"）──────────────────
  //
  // 这一组断言的顺序是有讲究的：先证明"缺省完全不变"（否则前面所有用例都可能被它影响），
  // 再证明"开了之后真的会改"，最后证明**它绝不会改错屏幕**（这一条最重要）。

  await it('校对缺省关闭：一句只调一次模型，行为与加这个功能之前完全一样', async () => {
    const store = new Map()
    const path = inboxPathOf('proofread-off.jsonl')
    const llm = makeProofreadLlm({ corrected: '不该出现' })
    const box = await adapter.create({
      llm, fs: makeFakeFs(store), config: { inboxPath: path, inboxPollMs: 100 },
    })
    store.set(path, 'A reunião de hoje passou para as três da tarde.\n')
    const processed = await waitFor(async () =>
      (await box.tools.get('leion_inbox').execute({ action: 'status' })).processed >= 1)
    check('这句被处理了', processed)
    await sleep(400)          // 给"如果校对真的会跑"留出足够时间
    check('一次都没有多做模型调用（缺省 = 不做第二遍）', llm.calls.length === 1,
      '实际调用 ' + llm.calls.length + ' 次：' + JSON.stringify(llm.calls.map(c => String(c.system).slice(0, 12))))
    const status = await box.tools.get('leion_inbox').execute({ action: 'status' })
    check('状态里校对是 null（关闭时不虚报）', status.proofread === null, JSON.stringify(status.proofread))
    const history = await box.tools.get('leion_history').execute({ limit: 10 })
    check('没有出现校对产物', !history.entries.some(e => e.text.includes('不该出现')))
    await box.tools.get('leion_inbox').execute({ action: 'stop' })
  })

  await it('校对开启：初译先上屏，空闲时回头改，改的是**同一帧**而不是追加一条', async () => {
    const store = new Map()
    const path = inboxPathOf('proofread-fix.jsonl')
    // 用**中文进、巴葡出**（真实主用途：佩戴者说中文）。而且"修正版"比初译短 ——
    // 校对规则要求"不许比原译文更长"（屏幕只有 3 行），这条数据符合真实形态。
    const SOURCE = '这是一条测试语音。'
    const FIXED = 'Esta é uma mensagem de teste.'
    const llm = makeProofreadLlm({ corrected: FIXED })
    const box = await adapter.create({
      llm, fs: makeFakeFs(store),
      config: { inboxPath: path, inboxPollMs: 100, proofread: 'idle' },
    })
    const tools = box.tools

    // 初译必须**先**上屏 —— 这是这个功能的全部意义：不能让观众等第二遍。
    store.set(path, SOURCE + '\n')
    const drafted = await waitFor(async () => {
      const h = await tools.get('leion_history').execute({ limit: 5 })
      return h.entries.length >= 1
    })
    check('初译已经上屏（没有等第二遍）', drafted)

    // 然后校对把这一句换掉
    const fixed = await waitFor(async () => {
      const h = await tools.get('leion_history').execute({ limit: 5 })
      return h.entries.some(e => e.text === FIXED)
    })
    check('校对结果替换到了屏幕上', fixed)

    const history = await tools.get('leion_history').execute({ limit: 10 })
    check('历史里还是**一条**（替换而不是追加，否则双语记录会重复）',
      history.entries.length === 1, JSON.stringify(history.entries.map(e => e.text)))

    const status = await tools.get('leion_inbox').execute({ action: 'status' })
    check('状态里能看到"改了 1 句"', status.proofread !== null && status.proofread.fixed === 1,
      JSON.stringify(status.proofread))
    check('校对那一调用的提示词里带着**原文**（不然发现不了听错）',
      llm.calls.some(c => String(c.system).includes('校对')
        && JSON.stringify(c.messages).includes(SOURCE)),
      '校对请求里没看到原文')
    check('一句只调两次模型（初译 + 校对）', llm.calls.length === 2, String(llm.calls.length))
    await tools.get('leion_inbox').execute({ action: 'stop' })
  })

  await it('校对判定无需改动：屏幕不动、历史也不多一条', async () => {
    const store = new Map()
    const path = inboxPathOf('proofread-same.jsonl')
    // 这一句是葡语 → 初译是中文。所以"无需改动"的那次校对必须返回**中文**那版，
    // 否则它就不叫"无需改动"了（第一版这里传错了，测试因此假失败）。
    const llm = makeProofreadLlm({ corrected: cannedTranslation({ system: '简体中文' }) })
    const box = await adapter.create({
      llm, fs: makeFakeFs(store),
      config: { inboxPath: path, inboxPollMs: 100, proofread: 'idle' },
    })
    store.set(path, 'A reunião de hoje passou para as três da tarde.\n')
    const settled = await waitFor(async () => {
      const s = await box.tools.get('leion_inbox').execute({ action: 'status' })
      return s.proofread !== null && s.proofread.settled >= 1
    })
    check('校对跑完并判定"无需改"', settled)
    const status = await box.tools.get('leion_inbox').execute({ action: 'status' })
    check('记为 same，而不是 fixed', status.proofread.same === 1 && status.proofread.fixed === 0,
      JSON.stringify(status.proofread))
    const history = await box.tools.get('leion_history').execute({ limit: 10 })
    check('历史仍然只有一条（没改就不该多写一条）', history.entries.length === 1,
      JSON.stringify(history.entries.map(e => e.text)))
    await box.tools.get('leion_inbox').execute({ action: 'stop' })
  })

  await it('校对**绝不覆盖更新的字幕**：改到一半屏幕已经换页，结果就丢弃', async () => {
    // 这条是这个功能最重要的安全属性。收录理由：改错屏幕比不校对严重得多 ——
    // 观众读着第二句，屏幕突然跳回第一句的"修正版"，那是事故。
    const store = new Map()
    const path = inboxPathOf('proofread-stale.jsonl')
    // 校对慢 600ms，留出足够时间让第二句插进来。
    // respond 让每句的校对结果**各不相同** —— 否则分不清"第一句的过期结果"和"第二句的正常结果"。
    const llm = makeProofreadLlm({
      delayMs: 600,
      respond: userText => {
        const line = userText.split('\n').find(l => l.startsWith('这一句原文：')) ?? ''
        return 'FIX(' + line.replace('这一句原文：', '') + ')'
      },
    })
    const box = await adapter.create({
      llm, fs: makeFakeFs(store),
      config: { inboxPath: path, inboxPollMs: 100, proofread: 'idle' },
    })
    const tools = box.tools

    // 句子必须带**葡语特征词**（reunião / também 这类），否则语种判定失败、
    // 这一句根本不会上屏，测试就会以为是功能坏了（第一版正是栽在这上面）。
    const FIRST = 'A reunião de hoje é às três.'
    const SECOND = 'A reunião de amanhã também é às três.'
    store.set(path, FIRST + '\n')
    const firstShown = await waitFor(async () =>
      (await tools.get('leion_history').execute({ limit: 5 })).entries.length >= 1)
    check('第一句已上屏', firstShown)

    // 校对还在跑的时候，第二句到了 —— 屏幕换页
    store.set(path, FIRST + '\n' + SECOND + '\n')
    const secondShown = await waitFor(async () => {
      const h = await tools.get('leion_history').execute({ limit: 5 })
      return h.entries.length >= 2
    })
    check('第二句也上屏了（屏幕确实换页了）', secondShown)

    // 等第二句**自己**的校对也做完 —— 它应该被正常应用
    const secondFixed = await waitFor(async () => {
      const h = await tools.get('leion_history').execute({ limit: 5 })
      return h.entries.some(e => e.text === 'FIX(' + SECOND + ')')
    }, { timeout: 5000 })
    check('第二句的校对正常生效（证明"丢弃"不是"校对整体坏了"）', secondFixed,
      '校对统计：' + JSON.stringify((await tools.get('leion_inbox').execute({ action: 'status' })).proofread))

    const history = await tools.get('leion_history').execute({ limit: 10 })
    check('第一句那份**过期**的校对结果没有覆盖屏幕',
      !history.entries.some(e => e.text === 'FIX(' + FIRST + ')'),
      '屏幕上出现了过期的校对结果：' + JSON.stringify(history.entries.map(e => e.text)))
    check('最后一条是第二句的译文（没有被改回上一句）',
      history.entries[history.entries.length - 1].text === 'FIX(' + SECOND + ')',
      JSON.stringify(history.entries.map(e => e.text)))
    const status = await tools.get('leion_inbox').execute({ action: 'status' })
    check('过期丢弃被记了账（丢弃 = 主动放弃覆盖，不是静默丢掉）',
      status.proofread.dropped >= 1, JSON.stringify(status.proofread))
    await tools.get('leion_inbox').execute({ action: 'stop' })
  })

  await it('校对结果没通过验收就不上屏：把对的改错比不校对更糟', async () => {
    // 这条来自读代码时发现的一个真实陷阱：离线演示的例句表适配器对查不到的问句
    // 会回一句「（离线演示：例句表里没有这一句…）」。校对请求当然查不到 ——
    // 如果不拦，它会**被当成校对结果**，把一句本来正确的字幕覆盖成这句演示提示。
    // 所以校对结果要过两道验收：变长太多（不像校对）、折行超出 3 行（会把开头挤掉）。
    const store = new Map()
    const path = inboxPathOf('proofread-reject.jsonl')
    const junk = '（离线演示：例句表里没有这一句，原文为「' + 'x'.repeat(30) + '」）'
    const llm = makeProofreadLlm({ corrected: junk })
    const box = await adapter.create({
      llm, fs: makeFakeFs(store),
      config: { inboxPath: path, inboxPollMs: 100, proofread: 'idle' },
    })
    const tools = box.tools
    store.set(path, 'A reunião de hoje passou para as três da tarde.\n')
    const settled = await waitFor(async () => {
      const s = await tools.get('leion_inbox').execute({ action: 'status' })
      return s.proofread !== null && (s.proofread.rejected >= 1 || s.proofread.fixed >= 1)
    })
    check('校对跑完并做了裁决', settled)
    const status = await tools.get('leion_inbox').execute({ action: 'status' })
    check('这种垃圾输出被拒（记为 rejected，不是 fixed）',
      status.proofread.rejected === 1 && status.proofread.fixed === 0, JSON.stringify(status.proofread))
    const history = await tools.get('leion_history').execute({ limit: 10 })
    check('屏幕上仍是初译，没被那句演示提示覆盖',
      history.entries.length === 1 && !history.entries[0].text.includes('离线演示'),
      JSON.stringify(history.entries.map(e => e.text)))
    await tools.get('leion_inbox').execute({ action: 'stop' })
  })

  await it('校对回归闸：丢数字 / 冒出葡葡说法 / 正常修订，判定三分', async () => {
    // ⚠️ 为什么这一条直接调函数而不是走链路：链路上那个假 LLM 的"初译"是**固定句型**
    //    （葡语那句里用的是 `décimo segundo` 词形，没有阿拉伯数字），
    //    所以"初译里有数字、修订里丢了"这个场景在假链路里**造不出来** ——
    //    第一版测试就是因此假失败（我以为是闸坏了，其实是测试选错了输入）。
    //    判定的正确性用直接单测验；链路只验"计数器与日志一致"（见下一条）。
    const policy = { terminology: [
      { zh: '公交车', br: 'ônibus', ptpt: 'autocarro' },
      { zh: '手机', br: 'celular', ptpt: 'telemóvel' },
    ] }
    const SOURCE = '地点从十二楼的第二会议室换到了八楼的 802 房间。'
    const DRAFT = 'O local mudou da segunda sala no 12º andar para a sala 802 no 8º andar.'

    // ① 丢数字 → 必须拦
    const lost = proofreadRegression(SOURCE, DRAFT, 'O local da reunião foi alterado ontem à tarde.', policy)
    check('丢了 12 与 802 → 拦住', lost !== null && lost.includes('12') && lost.includes('802'), String(lost))

    // ② 只丢一个数字 → 也要拦（这是实测抓到的真错：只丢了原来的地点）
    //    ⚠️ 修订里**必须留着别的数字**才测得准：如果修订里一个数字都没有，
    //    那连"简单判据"都能拦下来，测不出"清单逐项核对"这条路径。
    const halfLost = proofreadRegression(SOURCE, DRAFT,
      'O local mudou para a sala 802 no 8º andar.', policy)
    check('只丢了 12 楼（802 还在）→ 拦住', halfLost !== null && halfLost.includes('12'), String(halfLost))

    // ③ 冒出欧洲葡语说法 → 必须拦（提示词里明令禁止）
    const european = proofreadRegression('可以坐公交车或者手机买票。',
      'pode pegar o ônibus e comprar pelo celular', 'pode pegar o autocarro e comprar pelo telemóvel', policy)
    check('冒出 autocarro / telemóvel → 拦住', european !== null && european.includes('autocarro'), String(european))

    // ④ 正常修订（数字都在、口径是巴葡）→ 一条都不许拦
    const fine = proofreadRegression(SOURCE, DRAFT,
      'O local mudou da segunda sala de reuniões no 12º andar para a sala 802 no 8º andar.', policy)
    check('数字与口径都没问题 → 放行', fine === null, String(fine))

    // ⑤ 把葡葡改成巴葡是**好事**，不许拦
    const improved = proofreadRegression('坐公交车去。', 'vai de autocarro', 'vai de ônibus', policy)
    check('把 autocarro 改成 ônibus → 放行', improved === null, String(improved))

    // ⑥ 修订把数字写成葡语整词 → 必须能"把数找回来"，因此放行
    //    ⚠️ 这条钉的是本文件里坑最多的那个解析器（wordFormNumbers）。它踩过三次：
    //      · `e` 被当成数字从句的边界 → `trezentos e noventa` 被切成两段
    //      · `mil` 的乘法结合错 → `três mil novecentos e oitenta` 算成 1980
    //      · **基数词表漏了 `três`** → 上面那个数里 `três` 落到边界、`mil` 单独成 1000
    //    所以这里把几种词形都验一遍，而不是只验一个 —— 表漏一项很难从输出上看出来。
    // ⚠️ 一次只验一个数改成词形。**用例要贴近真实**：模型把数字写成词形时，
    //    写的是百位以内的数（`cento e vinte`）或带大单位的（`dois mil`），
    //    而房间号/金额那种 ≥1000 的值它**永远用阿拉伯数字**（那正是判据敢拦的依据）。
    //    （第一版这里用了「3980 → três mil novecentos e oitenta」，那是四位数，
    //      既不在"小数值"护栏里、`mil` 那档又算不出精确值 —— 是我用例选得不对，
    //      不是判据不成立。判据的取舍已在 core.mjs 注释里写清。）
    const wordFormCases = [
      { source: '一共 398 台。', draft: '398 unidades', after: 'trezentos e noventa e oito unidades', note: '398 的整词写法' },
      { source: '一共 120 台。', draft: '120 unidades', after: 'cento e vinte unidades', note: '120 的整词写法' },
      { source: '下午三点二十开会。', draft: 'às 3h20', after: 'às três e vinte da tarde', note: '时间改成词形' },
      { source: '在十二楼的会议室。', draft: 'na sala do 12º andar', after: 'na sala do décimo segundo andar', note: '12 楼的两词序数词写法' },
      { source: '这批是 398000 元。', draft: '398000 reais', after: 'trezentos e noventa e oito mil reais', note: '398000 的写法（mil 那档）' },
      { source: '2020 年的计划。', draft: 'o plano de 2020', after: 'o plano de dois mil e vinte', note: '2020 的写法（mil + e + 小数）' },
    ]
    for (const item of wordFormCases) {
      const judged = proofreadRegression(item.source, item.draft, item.after, policy)
      check(`数字改成词形也认得出来（${item.note}）→ 放行`, judged === null, String(judged))
    }
  })

  await it('校对回归闸：装配正确（正常修订照常上屏、计数器与日志一致）', async () => {
    // 这一段验的是"闸有没有被正确接进校对流程"，以及**它不会误拦正常修订**。
    // 数字丢失那条判定由上一个测试直接验（链路里造不出那个场景）。
    const store = new Map()
    const path = inboxPathOf('proofread-regression.jsonl')
    const FIXED = 'Bom dia! A nossa reunião de hoje passou para as três da tarde, na sala de reuniões do décimo segundo andar.'
    const llm = makeProofreadLlm({ corrected: FIXED })
    const box = await adapter.create({
      llm, fs: makeFakeFs(store),
      config: { inboxPath: path, inboxPollMs: 100, proofread: 'idle' },
    })
    const tools = box.tools
    store.set(path, '早上好！我们今天的会议改到了下午三点，在十二楼的会议室。\n')
    const shown = await waitFor(async () =>
      (await tools.get('leion_history').execute({ limit: 3 })).entries.length >= 1)
    check('初译已上屏', shown)
    const settled = await waitFor(async () => {
      const s = await tools.get('leion_inbox').execute({ action: 'status' })
      return s.proofread !== null && s.proofread.settled >= 1
    })
    check('校对跑完了', settled)
    const status = await tools.get('leion_inbox').execute({ action: 'status' })
    check('正常修订被接受（fixed=1、rejected=0）',
      status.proofread.fixed === 1 && status.proofread.rejected === 0, JSON.stringify(status.proofread))
    const history = await tools.get('leion_history').execute({ limit: 5 })
    check('屏幕上换成了修订版（而且只有一条，不是新增一行）',
      history.entries.length === 1 && history.entries[0].text === FIXED,
      JSON.stringify(history.entries.map(e => e.text)))
    await tools.get('leion_inbox').execute({ action: 'stop' })
  })

  await it('校对回归闸：只在「中文→巴葡」方向跑（反方向不许误拦）', async () => {
    // ⚠️ 这条是**假阳性护栏**，来自一个真踩到的 bug：
    //    闸比的是「原文的数 ↔ 译文的数」，只有译成葡语时两边才可比。
    //    反方向（葡语→中文）时译文本身就是中文，里面的汉字数字会被当成"数字"，
    //    于是初译里的「十二楼」被判成"修订把 12 弄丢了"。
    //    合同套件里"屏幕换页时丢弃过期校对"那条测试正是因此变红，诊断信息是
    //    `修订把初译里的数字弄丢了（12）`，而那句的语向是 pt-BR→zh-CN。
    const reverse = proofreadRegression(
      'A reunião mudou para as três da tarde.',
      '早上好！我们今天的会议改到了下午三点，在十二楼的会议室。',
      '早上好！会议改到下午三点，在十二楼的会议室。',
      { terminology: [] })
    check('葡语原文 → 中文字幕：方向不适用，直接放过', reverse === null, String(reverse))

    // 中文原文但译文里还夹着汉字（模型没译干净）→ 同样不适用，不该由这道闸来报
    const messy = proofreadRegression('地点从十二楼换到了八楼。', '十二楼的会议室 sala de reuniões',
      'sala de reuniões no 12º andar', { terminology: [] })
    check('译文里还有汉字时也不适用（交给别的判据）', messy === null, String(messy))
  })

  await it('校对改的那一帧也带着**原文**（否则手机上会多出一行而不是原地改正）', async () => {
    // 这条钉的是一个只在"校对 + 新界面"合起来时才暴露的 bug：
    //   修订帧原先没传 source，于是它的 source 退化成译文本身；
    //   而手机端是**按原文认"这是同一条字幕"**的 —— 认不出来就当成新句子，
    //   屏幕上于是多出一行，那一行的"原文"位置还显示成译文。
    // 所以这里直接看**总线上的帧**（用 file 传输 + 假 fs 截下来），不看内部状态。
    const store = new Map()
    const path = inboxPathOf('proofread-source.jsonl')
    const busPath = 'E:/GlassesHarness/var/test/proofread-bus.json'
    const SOURCE = '这是一条测试语音。'
    const FIXED = 'Esta é uma mensagem de teste.'
    const llm = makeProofreadLlm({ corrected: FIXED })
    const box = await adapter.create({
      llm, fs: makeFakeFs(store),
      config: { inboxPath: path, inboxPollMs: 100, proofread: 'idle',
        transport: 'file', sinkPath: busPath },
    })
    const tools = box.tools
    store.set(path, SOURCE + '\n')

    const revised = await waitFor(() => String(store.get(busPath) ?? '').includes(FIXED),
      { timeout: 6000 })
    check('校对结果落到了总线文件上', revised, String(store.get(busPath) ?? '').slice(0, 120))

    const frame = JSON.parse(String(store.get(busPath)))
    check('修订帧的译文是校对后的那版', frame.text === FIXED, frame.text)
    check('修订帧的**原文仍然是原文**（手机靠它认同一条字幕）', frame.source === SOURCE,
      `source=${JSON.stringify(frame.source)}（应该是 ${JSON.stringify(SOURCE)}）`)
    check('修订帧标了原文语种', frame.sourceLang === 'zh-CN', String(frame.sourceLang))
    check('修订帧不是"生成中"', frame.partial === false, String(frame.partial))
    await tools.get('leion_inbox').execute({ action: 'stop' })
  })

  await it('收件箱配了相对路径时**响亮报错**，不再静默失效', async () => {
    // 真实踩过：`--data-dir var/test/x` 让收件箱路径变成相对的，
    // 继电器照写、插件读不到、一个错都不报 —— 表现和"翻译坏了"一样。
    // 现在直接拒绝启动并把原因说清楚（正常的用法由 start-all / harness-side 解析绝对路径兜住）。
    const store = new Map()
    const box = await adapter.create({
      llm: makeFakeLlm(), fs: makeFakeFs(store),
      config: { inboxPath: 'var/test/relative-inbox.jsonl', inboxPollMs: 100 },
    })
    const status = await box.tools.get('leion_inbox').execute({ action: 'status' })
    check('收件箱没有跑起来', status.running === false, String(status.running))
    check('错误里明确说是相对路径的问题',
      String(status.lastError).includes('绝对路径'), String(status.lastError))
    check('错误里给了怎么改（提到 data-dir）',
      String(status.lastError).includes('data-dir'), String(status.lastError))
  })

  await it('只处理以换行结束的完整行：半行不算，补齐后才算一条', async () => {
    const store = new Map()
    const path = inboxPathOf('inbox-partial.jsonl')
    const partial = await adapter.create({
      llm: makeFakeLlm(), fs: makeFakeFs(store), config: { inboxPath: path, inboxPollMs: 120 },
    })
    // 写了一半（没有换行）
    store.set(path, 'A reunião é às três')
    await sleep(400)
    const midway = await partial.tools.get('leion_inbox').execute({ action: 'status' })
    check('半行没被处理', midway.processed === 0, JSON.stringify(midway))
    check('半行也没算成错误', midway.errors === 0, String(midway.lastError))

    // 补上换行，它才成为一条完整的话
    store.set(path, store.get(path) + ' da tarde.\n')
    const done = await waitFor(async () =>
      (await partial.tools.get('leion_inbox').execute({ action: 'status' })).processed >= 1)
    check('补齐换行后被处理', done)
    const after = await partial.tools.get('leion_inbox').execute({ action: 'status' })
    check('只处理了 1 条而不是 2 条', after.processed === 1, JSON.stringify(after))
    await partial.tools.get('leion_inbox').execute({ action: 'stop' })
  })

  await it('坏行只计数不中断：两条坏行之后好行照常处理', async () => {
    const store = new Map()
    const path = inboxPathOf('inbox-bad.jsonl')
    const mixed = await adapter.create({
      llm: makeFakeLlm(), fs: makeFakeFs(store), config: { inboxPath: path, inboxPollMs: 120 },
    })
    // 1) 不是合法 JSON；2) 合法 JSON 但 text 不是字符串；3) 好的
    store.set(path, '{这不是合法 JSON\n{"text":9}\n{"text":"A reunião é às três."}\n')
    const ok = await waitFor(async () =>
      (await mixed.tools.get('leion_inbox').execute({ action: 'status' })).processed >= 1)
    check('好行被处理了', ok)
    const status = await mixed.tools.get('leion_inbox').execute({ action: 'status' })
    check('两条坏行计成错误', status.errors === 2, `errors=${status.errors} lastError=${status.lastError}`)
    check('处理数正好 1', status.processed === 1, `processed=${status.processed}`)
    await mixed.tools.get('leion_inbox').execute({ action: 'stop' })
  })

  await it('inboxFrom 能强制源语种（ASR 已知语种时避免自动判定失败）', async () => {
    const store = new Map()
    const path = inboxPathOf('inbox-forced.jsonl')
    const forced = await adapter.create({
      llm: makeFakeLlm(),
      fs: makeFakeFs(store),
      config: { inboxPath: path, inboxPollMs: 120, inboxFrom: 'pt-BR' },
    })
    // 'Hello' 让自动判定必然失败（unknown），强制 pt-BR 后应当译成中文
    store.set(path, 'Hello\n')
    const ok = await waitFor(async () =>
      (await forced.tools.get('leion_inbox').execute({ action: 'status' })).processed >= 1)
    const state = await forced.tools.get('leion_inbox').execute({ action: 'status' })
    check('被处理（没有因判不出语种而失败）', ok, JSON.stringify(state))
    const history = await forced.tools.get('leion_history').execute({ limit: 5 })
    check('译成了中文', history.entries.some(e => e.lang === 'zh-CN'), JSON.stringify(history.entries))
    await forced.tools.get('leion_inbox').execute({ action: 'stop' })
  })

  await it('stop 后不再处理，drain 可手动排空，reset 可重放，start 可恢复', async () => {
    const store = new Map()
    const path = inboxPathOf('inbox-ctl.jsonl')
    const ctl = await adapter.create({
      llm: makeFakeLlm(), fs: makeFakeFs(store), config: { inboxPath: path, inboxPollMs: 120 },
    })
    check('已停止', (await ctl.tools.get('leion_inbox').execute({ action: 'stop' })).running === false)

    store.set(path, 'A reunião é às três da tarde.\n')
    await sleep(400)
    check('停止期间不处理', (await ctl.tools.get('leion_inbox').execute({ action: 'status' })).processed === 0)

    const drained = await ctl.tools.get('leion_inbox').execute({ action: 'drain' })
    check('drain 处理了 1 条', drained.processed === 1, JSON.stringify(drained))
    check('drain 报告读到的行数', drained.read === 1, String(drained.read))

    check('消费位置归零', (await ctl.tools.get('leion_inbox').execute({ action: 'reset' })).consumedChars === 0)
    const redrained = await ctl.tools.get('leion_inbox').execute({ action: 'drain' })
    check('重放后又处理了一条', redrained.processed === 2, JSON.stringify(redrained))

    check('可以重新启动', (await ctl.tools.get('leion_inbox').execute({ action: 'start' })).running === true)
    await ctl.tools.get('leion_inbox').execute({ action: 'stop' })
  })

  // ── 9. 配置校验与 file transport（真机接入的那条路） ───────────────────────

  await it('非法配置在加载时就响亮报错（transport=file 却没给 sinkPath）', async () => {
    await assert.rejects(
      () => adapter.create({ llm: makeFakeLlm(), fs: makeFakeFs(new Map()), config: { transport: 'file' } }),
      /sinkPath/,
    )
  })

  await it('非法配置：配了 inboxPath 却给了过小的 inboxPollMs', async () => {
    await assert.rejects(
      () => adapter.create({
        llm: makeFakeLlm(), fs: makeFakeFs(new Map()),
        config: { inboxPath: inboxPathOf('x.jsonl'), inboxPollMs: 10 },
      }),
      /inboxPollMs/,
    )
  })

  await it('非法配置：inboxFrom 只接受两个合法语种', async () => {
    await assert.rejects(
      () => adapter.create({
        llm: makeFakeLlm(), fs: makeFakeFs(new Map()),
        config: { inboxPath: inboxPathOf('x.jsonl'), inboxPollMs: 200, inboxFrom: 'en-US' },
      }),
      /inboxFrom/,
    )
  })

  await it("把 transport 配成 'file' 后，字幕真的被写进字幕总线文件", async () => {
    const sink = inboxPathOf('subtitle-bus.json')
    const store = new Map()
    const fileBox = await adapter.create({
      llm: makeFakeLlm(),
      fs: makeFakeFs(store),
      config: { transport: 'file', sinkPath: sink },
    })
    const status = await fileBox.tools.get('leion_status').execute({})
    check('通道报成 file', status.transport === 'file', status.transport)
    check('通道细节是那个路径', status.transportDetail === sink, status.transportDetail)

    const result = await fileBox.tools.get('leion_translate').execute({ text: 'A reunião é às três.' })
    check('翻译成功', result.ok === true, JSON.stringify(result).slice(0, 200))
    const raw = store.get(sink)
    check('字幕总线文件被写了', typeof raw === 'string' && raw.length > 0, String(raw).slice(0, 120))
    const frame = JSON.parse(raw)
    check('是合法 JSON 帧', frame.lines !== undefined && frame.lang === 'zh-CN', JSON.stringify(frame))
    check('带设备标识', frame.device === 'Leion Pro', frame.device)
  })

  return fingerprint
}

export { EXPECTED_TOOLS, SAMPLE_ARGS }
