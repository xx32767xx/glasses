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

/** 收件箱测试用的假路径：只是 Map 里的键，不会真的落盘。 */
const INBOX_SANDBOX = 'E:/GlassesHarness/.tmp/'
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
    fingerprint.inboxAuto = { configured: status1.configured, processed: status1.processed, errors: status1.errors }
    await auto.tools.get('leion_inbox').execute({ action: 'stop' })
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
