/**
 * leion-pro · 核心逻辑 —— 全项目唯一来源
 * ============================================================================
 *
 * 亮亮视野 (LLVision) Leion Pro / GLXSS ME AR 眼镜设备插件 + 中↔巴西葡语双向同传。
 *
 * 这个文件被两个包装目标共用，二者都不含业务逻辑：
 *   · ../plugin/index.mjs      正式插件（持久）：走 ctx.tools.register()，schema 用
 *                              schemas.generated.mjs 里由本文件 DSL 编译出的原始形式；
 *   · ../dynamic/leion-pro.host.js   动态插件（创造模式）：由 scripts/gen-dynamic.mjs
 *                              把本文件内联进去再包一层沙箱适配器生成。
 * 所以：**改逻辑只改这里**，然后 `node scripts/gen-dynamic.mjs`。
 *
 * 本文件必须保持零 import —— 动态插件沙箱里没有 require/import。
 *
 * 设计要点（改之前先读）
 *   1) transport seam：眼镜怎么收字幕是唯一会随真机变化的东西，被隔离成 createTransport()。
 *      真机接入时只换这一处，其余全部不动。
 *   2) 佩戴者视角：Leion Pro / GLXSS ME 戴在自己脸上，屏幕只给佩戴者看。所以同传主通道是
 *      「对方的语言 → 佩戴者的中文」；佩戴者自己说的话译成巴葡后属于「出站通道」
 *      （给对方的扬声器/第二块屏），眼镜上只做一行回显确认。
 *   3) AR 显示预算：显示区很小，必须先按显示宽度折行、再截到 N 行，否则长译文就是溢出。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 可调参数（正式插件经 cordis.yml 的 config 覆盖；动态插件改这里的字面量后重新 define）
// ─────────────────────────────────────────────────────────────────────────────
export const CONFIG_DEFAULTS = {
  /** 'mock' = 只打日志/内存（无真机时用）；'file' = 把当前字幕帧写成 JSON 给外部桥读 */
  transport: 'mock',
  /** transport === 'file' 时，字幕总线的绝对路径 */
  sinkPath: '',
  /** AR 显示预算：每行显示宽度（半角字符数，汉字算 2）与可见行数 */
  cols: 40,
  lines: 3,
  /** 流式翻译时部分字幕的最短刷新间隔（毫秒），防止逐字刷屏 */
  partialThrottleMs: 400,
  /** 翻译用的模型路由。留空 = 用第一个已注册 provider，并尝试自动发现模型 */
  providerId: '',
  modelId: '',
  maxTokens: 400,
  temperature: 0.2,
  /**
   * 翻译调用的推理强度。
   *
   * 缺省 'off' 是刻意的：翻译是「输入一句、输出一句」的确定性任务，不需要思考。
   * 而 DeepSeek 适配器缺省的推理强度是 high —— 实测下来思考 token 会把 maxTokens
   * 吃光，流以非 stop 结束，译文被丢弃（眼镜上什么都不剩，或者只剩碎片）。
   * 'off' 同时省延迟和费用。留空字符串表示完全不传这个字段（给不接受它的路由用；
   * 若路由拒绝该字段，插件会自动去掉它重试一次）。
   */
  reasoningEffort: 'off',

  /**
   * ASR 收件箱：外部语音识别程序把文本按行追加到这个文件，插件轮询它并自动出字幕。
   * 留空 = 关闭自动同传（此时仍可手动调 leion_translate，或用 leion_inbox 的 drain）。
   * 打开这一项，中↔巴葡同传就从「agent 调工具」变成「外部 ASR 一写就上屏」。
   */
  inboxPath: '',
  /** 轮询间隔（毫秒）。太小会空转，太大会加延迟；150–800 是合理区间。 */
  inboxPollMs: 700,
  /** 强制指定收件行的源语种（ASR 已知语种时有用）；留空 = 逐行自动判定。 */
  inboxFrom: '',
}

export const DEVICE = {
  vendor: 'LLVision 亮亮视野',
  model: 'Leion Pro',
  aliases: ['GLXSS ME'],
  panel: '单目 AR 显示，供佩戴者阅读',
}

export const ZH = 'zh-CN'
export const PT = 'pt-BR'

const HISTORY_CAP = 200

/**
 * 校验配置。harness 的约定是「配置错误要响亮」：不合法的值在加载时就抛，不要留到运行期。
 */
export function validateConfig(raw) {
  const config = Object.assign({}, CONFIG_DEFAULTS, raw === undefined || raw === null ? {} : raw)
  if (config.transport !== 'mock' && config.transport !== 'file') {
    throw new Error(`leion-pro: transport 只能是 'mock' 或 'file'，收到 ${JSON.stringify(config.transport)}`)
  }
  if (config.transport === 'file' && (typeof config.sinkPath !== 'string' || config.sinkPath === '')) {
    throw new Error("leion-pro: transport 'file' 需要 sinkPath 指向一个字幕总线文件的绝对路径")
  }
  for (const key of ['cols', 'lines']) {
    const value = config[key]
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`leion-pro: ${key} 必须是正整数，收到 ${JSON.stringify(value)}`)
    }
  }
  if (!Number.isFinite(config.partialThrottleMs) || config.partialThrottleMs < 0) {
    throw new Error(`leion-pro: partialThrottleMs 必须是非负数，收到 ${JSON.stringify(config.partialThrottleMs)}`)
  }
  if (!Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2) {
    throw new Error(`leion-pro: temperature 必须在 0..2，收到 ${JSON.stringify(config.temperature)}`)
  }
  if (!Number.isInteger(config.maxTokens) || config.maxTokens <= 0) {
    throw new Error(`leion-pro: maxTokens 必须是正整数，收到 ${JSON.stringify(config.maxTokens)}`)
  }
  if (!['', 'off', 'low', 'high', 'max'].includes(config.reasoningEffort)) {
    throw new Error(`leion-pro: reasoningEffort 只能是 '' / 'off' / 'low' / 'high' / 'max'，收到 ${JSON.stringify(config.reasoningEffort)}`)
  }
  if (typeof config.inboxPath !== 'string') {
    throw new Error(`leion-pro: inboxPath 必须是字符串，收到 ${JSON.stringify(config.inboxPath)}`)
  }
  if (config.inboxPath !== '') {
    if (!Number.isInteger(config.inboxPollMs) || config.inboxPollMs < 100) {
      throw new Error(`leion-pro: 配置了 inboxPath 时 inboxPollMs 必须是不小于 100 的整数，收到 ${JSON.stringify(config.inboxPollMs)}`)
    }
  }
  if (config.inboxFrom !== '' && config.inboxFrom !== ZH && config.inboxFrom !== PT) {
    throw new Error(`leion-pro: inboxFrom 只能是 '' / '${ZH}' / '${PT}'，收到 ${JSON.stringify(config.inboxFrom)}`)
  }
  return config
}

// ─────────────────────────────────────────────────────────────────────────────
// 字幕排版
// ─────────────────────────────────────────────────────────────────────────────

/** 单字符占几列：CJK 全角算 2，其余算 1。 */
export function charCols(ch) {
  const code = ch.codePointAt(0)
  const wide
    = (code >= 0x1100 && code <= 0x115f)
    || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
  return wide ? 2 : 1
}

/** 按显示宽度折行。 */
export function wrapText(text, cols) {
  const out = []
  let line = ''
  let width = 0
  for (const ch of String(text)) {
    if (ch === '\n') {
      out.push(line)
      line = ''
      width = 0
      continue
    }
    const w = charCols(ch)
    if (width + w > cols) {
      out.push(line)
      line = ''
      width = 0
    }
    line += ch
    width += w
  }
  out.push(line)
  return out
}

/**
 * 折行后截取「最后 N 行」。
 * 同传是边说边读，读者永远在追最新那句话，所以留尾部而不是头部。
 */
export function fitSubtitle(text, cols, lines) {
  const wrapped = wrapText(String(text === undefined ? '' : text).trim(), cols)
  return wrapped.length <= lines ? wrapped : wrapped.slice(wrapped.length - lines)
}

/** 把一帧字幕画成等宽框，便于在终端/工具卡片里肉眼核对排版。 */
export function drawFrame(frame, cols) {
  const top = '┌' + '─'.repeat(cols) + '┐'
  const body = frame.lines.map(l => {
    const pad = cols - [...l].reduce((n, ch) => n + charCols(ch), 0)
    return '│' + l + ' '.repeat(pad > 0 ? pad : 0) + '│'
  })
  const bottom = '└' + '─'.repeat(cols) + '┘'
  return [top, ...body, bottom].join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// 语种判定（双向同传的语向自动路由）
// ─────────────────────────────────────────────────────────────────────────────

export const PT_MARKERS = [
  'não', 'nao', 'você', 'voce', 'obrigado', 'obrigada', 'está', 'esta', 'estão', 'estao',
  'com', 'para', 'isso', 'muito', 'bom', 'dia', 'olá', 'ola', 'tudo', 'bem', 'aqui',
  'sim', 'desculpe', 'falar', 'pode', 'vamos', 'estou', 'também', 'tambem', 'depois',
  'reunião', 'reuniao', 'quando', 'onde', 'porque', 'então', 'entao', 'como', 'café', 'cafe',
]
const PT_DIACRITICS = 'ãõçáéêíóúâàü'

/** 判定一段文本是中文还是巴葡；判不出来返回 'unknown'，让调用方决定，绝不猜。 */
export function detectLang(text) {
  const s = String(text === undefined ? '' : text)
  if (/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(s)) return ZH
  const lower = s.toLowerCase()
  const padded = ' ' + lower.replace(/[.,!?;:()"']/g, ' ').replace(/\s+/g, ' ') + ' '
  let hits = 0
  for (const marker of PT_MARKERS) {
    if (padded.includes(' ' + marker + ' ')) hits += 1
  }
  const diacritic = [...lower].some(ch => PT_DIACRITICS.includes(ch))
  if (hits >= 1 || diacritic) return PT
  return 'unknown'
}

/** 反向：同传永远是「译成听得懂的那边」。 */
export function opposite(lang) {
  if (lang === ZH) return PT
  if (lang === PT) return ZH
  return 'unknown'
}

/** 翻译用的 system 提示词。巴葡口径是硬约束，不是风格偏好。 */
export function translationSystem(from, to) {
  const target = to === PT ? '巴西葡萄牙语（português do Brasil）' : '简体中文'
  return [
    '你是资深的中巴同声传译译员，服务于现场口译场景。',
    '把用户给你的话翻译成' + target + '。',
    '硬性要求：',
    '1. 只输出译文本身。不要解释、不要加引号、不要标注语种、不要重复原文。',
    '2. 使用巴西葡语的自然口语表达；不要使用葡萄牙本土（欧洲葡语）的用词和语序。',
    '3. 数字、人名、公司名、产品名等专有名词原样保留。',
    '4. 这是同传，保持与原文相同的语序节奏，不要合并、不要扩写、不要总结。',
    '5. 原文若有口误或语气词，按最合理的意图翻译。',
  ].join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// 一次挂载 = 一个解释器实例
//
// 状态刻意放在实例里而不是模块级：正式插件可能被多个 agent preset 同时挂载
// （harness 里这是常态），模块级状态会让两条会话的字幕互相串。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * transport seam —— 唯一会随真机变化的一层。
 *
 *   mock —— 打到 host 日志 + 留在内存，无真机也能把整条链路跑通；
 *   file —— 把「当前字幕帧」原子写成一份 JSON，外部桥（Python/ADB/BLE 程序）轮询它
 *           再推给真机。这是接入真机最短的路：眼镜协议怎么变都不动插件。
 *
 * 接真机时在这里加一支：'adb'（走 ctx.get('shell')）、'ble'（走外部守护进程）……
 * 注意 ctx.web.fetch 只支持 GET（WebFetchRequest 只有 url 字段），不能当 POST 桥用。
 */
export function createTransport(ctx, config) {
  if (config.transport === 'file') {
    return {
      kind: 'file',
      detail: config.sinkPath,
      async send(frame) {
        const fs = ctx.get('fs')
        if (fs === undefined) throw new Error('transport "file" 需要 fs 服务，但当前 ctx 里没有')
        const target = await fs.resolve(config.sinkPath)
        await fs.writeText(target, JSON.stringify(frame, null, 2) + '\n')
      },
    }
  }
  return {
    kind: 'mock',
    detail: '进程内 console + 内存（无真机模式）',
    async send(frame) {
      console.log('[leion-pro] ' + frame.speaker + '/' + frame.lang + ' → ' + frame.lines.join(' ⏎ '))
    },
  }
}

/**
 * 建一个解释器实例：持有 transport、字幕历史、计数，并暴露 6 个业务操作。
 * @param ctx 受限 ctx（只需要 get）
 * @param rawConfig 用户配置（会被 validateConfig 校验并填默认值）
 */
export function createInterpreter(ctx, rawConfig) {
  const config = validateConfig(rawConfig)
  const transport = createTransport(ctx, config)
  const state = {
    frames: [],
    pushes: 0,
    partials: 0,
    errors: 0,
    restored: 0,
    lastError: null,
    lastFrame: null,
    /** 最近一帧「定稿」字幕：翻译失败时用它把眼睛上的碎片换掉。 */
    lastGoodFrame: null,
    translating: false,
    callSeq: 0,
  }

  function buildFrame(input) {
    const text = String(input.text === undefined ? '' : input.text)
    return {
      device: DEVICE.model,
      speaker: input.speaker === undefined ? 'them' : input.speaker,
      lang: input.lang === undefined ? 'unknown' : input.lang,
      text,
      lines: fitSubtitle(text, config.cols, config.lines),
      // 把显示预算也放进帧里：这样任何下游（真机桥、局域网转发、手机 App）
      // 都能从数据本身知道"眼镜有多大"，不必各自硬编码或各自配一份。
      cols: config.cols,
      lineBudget: config.lines,
      at: new Date().toISOString(),
    }
  }

  /** 只发送、不写入历史。清屏、自检探针这类「内部帧」不该污染佩戴者的双语记录。 */
  async function sendRaw(frame) {
    try {
      await transport.send(frame)
    } catch (error) {
      state.errors += 1
      state.lastError = String(error && error.message ? error.message : error)
      throw error
    }
    state.pushes += 1
    state.lastFrame = frame
    return frame
  }

  /** 发送并记入历史：真正给佩戴者看的**定稿**字幕走这条。 */
  async function pushFrame(frame) {
    await sendRaw(frame)
    state.lastGoodFrame = frame
    state.frames.push(frame)
    if (state.frames.length > HISTORY_CAP) state.frames.shift()
    return frame
  }

  /** 解析要用的 provider / model 路由，解析不出来时给出能照着做的报错。 */
  async function resolveRoute(llm) {
    const providers = llm.listProviders()
    if (!providers || providers.length === 0) {
      return { ok: false, failure: '当前没有任何已注册的 LLM provider，翻译无法进行' }
    }
    const providerId = config.providerId !== '' ? config.providerId : providers[0].id
    if (!providers.some(p => p.id === providerId)) {
      return {
        ok: false,
        failure: 'providerId="' + providerId + '" 不在已注册路由里：' + providers.map(p => p.id).join(', '),
      }
    }
    let modelId = config.modelId
    if (modelId === '') {
      try {
        const models = await llm.listModels(providerId)
        const first = models && models.length > 0 ? models[0] : undefined
        if (first !== undefined) modelId = first.id !== undefined ? first.id : first.model
      } catch (error) {
        return { ok: false, failure: '自动发现模型失败：' + String(error && error.message ? error.message : error) }
      }
    }
    if (modelId === undefined || modelId === '') {
      return { ok: false, failure: '拿不到模型 id。请把 config.modelId 显式写成你要用的模型名。' }
    }
    return { ok: true, providerId, modelId }
  }

  /**
   * 把 finish 分片的"原因"归一化成 { kind, failure }。
   *
   * ⚠️ 真实形状是**对象**，不是字符串（packages/llm/llm/src/types.ts 的 FinishReasonMap）：
   *     { kind: 'stop' } / { kind: 'tool-calls' } / { kind: 'max-tokens' }
   *     { kind: 'aborted' | 'error', failure: LlmFailure }
   * 而 failure 挂在 **reason 上**，不在 chunk 上。
   * 早期版本把它当字符串比对，于是每一句正确译文都被当成"流没正常结束"丢掉了。
   */
  function readFinish(reason, chunk) {
    if (reason === null || reason === undefined) return { kind: null, failure: null }
    // 宽容：万一某个适配器直接给字符串
    if (typeof reason === 'string') return { kind: reason, failure: chunk.failure ?? null }
    const failure = reason.failure ?? chunk.failure ?? null
    return { kind: typeof reason.kind === 'string' ? reason.kind : null, failure }
  }

  /** 把 LlmFailure 渲染成一行可读文本。 */
  function describeFailure(failure) {
    if (failure === null || failure === undefined) return ''
    if (typeof failure === 'string') return failure
    const code = failure.code === undefined || failure.code === null ? '' : String(failure.code)
    const message = failure.message === undefined || failure.message === null ? '' : String(failure.message)
    if (code !== '' && message !== '') return code + '：' + message
    return code !== '' ? code : message
  }

  /** 跑一次模型流（不含重试策略），把碎片拼成一句译文。 */
  async function runStream(llm, options, onDelta) {
    let assembled = ''
    let finishKind = null
    let finishFailure = null
    let lastEmit = 0

    for await (const chunk of llm.stream(options)) {
      if (chunk.type === 'text-delta') {
        assembled += chunk.text
        if (onDelta !== undefined) {
          const now = Date.now()
          if (now - lastEmit >= config.partialThrottleMs) {
            lastEmit = now
            await onDelta(assembled.replace(/\s+$/, ''))
          }
        }
      } else if (chunk.type === 'finish') {
        const parsed = readFinish(chunk.reason, chunk)
        finishKind = parsed.kind
        finishFailure = parsed.failure
      }
    }

    const finalText = assembled.trim()
    // 没有 finish 分片时按 'stop' 处理 —— 与 harness 自己的 BlockAssembler 一致
    // （assembler.ts：`return this._finish ?? { kind: 'stop' }`）。
    if (finishKind === null) finishKind = 'stop'

    if (finishKind !== 'stop') {
      const detail = describeFailure(finishFailure)
      return {
        ok: false,
        failure: '模型流没有正常结束（finish=' + finishKind + (detail === '' ? '' : '，' + detail) + '），已丢弃可能不完整的译文',
        partial: finalText,
      }
    }
    if (finalText === '') return { ok: false, failure: '模型返回了空译文' }
    return { ok: true, text: finalText }
  }

  /**
   * 流式翻译一段话。
   * @param onDelta 每收到一段增量就回调（已按 partialThrottleMs 节流），用于「边说边显」。
   */
  async function streamTranslation(llm, text, from, to, onDelta) {
    const route = await resolveRoute(llm)
    if (route.ok !== true) return { ok: false, failure: route.failure }

    state.callSeq += 1
    // 手搓 Message：沙箱里拿不到 @deepseek-ai/dsh-llm 的构造函数。
    // Message 是纯数据接口 { id, role, content, source }，MessageId 运行期就是字符串。
    const messages = [{
      id: 'leion-t' + state.callSeq,
      role: 'user',
      content: [{ type: 'text', text: String(text) }],
      source: { kind: 'user' },
    }]

    const base = {
      provider: route.providerId,
      model: route.modelId,
      system: translationSystem(from, to),
      messages,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
    }

    const first = await runStream(llm, config.reasoningEffort === ''
      ? base
      : Object.assign({ reasoningEffort: config.reasoningEffort }, base), onDelta)

    // 有的路由不接受显式推理强度（会以 UNSUPPORTED_REASONING_EFFORT 失败）。
    // 那就去掉它重试一次 —— 重试不再逐段上屏，免得把增量推两遍。
    if (first.ok !== true && config.reasoningEffort !== '' && /REASONING/i.test(String(first.failure))) {
      const retry = await runStream(llm, base, undefined)
      if (retry.ok === true) return Object.assign({ retriedWithoutEffort: true }, retry)
      return retry
    }

    return first.ok === true
      ? Object.assign({ provider: route.providerId, model: route.modelId }, first)
      : first
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ASR 收件箱：让同传在没有 agent 介入的情况下自动跑
  //
  // 外部语音识别程序（厂商 App / 本地 Whisper / ASR 云）把文本按行追加到 inboxPath，
  // 插件用真实 timer 服务轮询它：每读到「以换行结束」的完整行就翻译并推字幕。
  // 只处理到最后一个换行为止 —— 半行不算，避免把写了一半的 JSON 当成一句话。
  // ───────────────────────────────────────────────────────────────────────────
  const inbox = {
    running: false,
    stopWatcher: null,
    consumed: 0,
    processed: 0,
    errors: 0,
    startedAt: null,
    lastLine: null,
    lastError: null,
  }
  const queue = []
  let pumping = false
  /** 由 api.translate 填充：收件箱要复用的就是那条翻译管线。 */
  let runTranslate = null

  /** 一行可以是纯文本，也可以是 {"text":...,"from":...,"to":...}。 */
  function parseInboxLine(raw) {
    const line = raw.trim()
    if (line === '') return null
    if (!line.startsWith('{')) return { text: line }
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      throw new Error('不是合法 JSON：' + String(error && error.message ? error.message : error))
    }
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.text !== 'string') {
      throw new Error('JSON 行必须包含字符串字段 text')
    }
    return {
      text: parsed.text,
      from: typeof parsed.from === 'string' ? parsed.from : undefined,
      to: typeof parsed.to === 'string' ? parsed.to : undefined,
    }
  }

  /** 读一次收件箱，把已完整的行排进队列。 */
  async function readInbox() {
    const fs = ctx.get('fs')
    if (fs === undefined) throw new Error('收件箱需要 fs 服务，但当前 ctx 里没有')
    const target = await fs.resolve(config.inboxPath)
    const info = await fs.stat(target)
    if (info === undefined) return { added: 0, note: '收件箱文件还不存在（等外部 ASR 创建）' }
    const text = await fs.readText(target)
    // 文件被截断或轮转过：从头重新读，而不是永远卡在旧偏移上。
    if (text.length < inbox.consumed) inbox.consumed = 0
    const pending = text.slice(inbox.consumed)
    const lastBreak = pending.lastIndexOf('\n')
    if (lastBreak < 0) return { added: 0, note: '还没有以换行结束的完整行' }
    const complete = pending.slice(0, lastBreak + 1)
    inbox.consumed += complete.length

    let added = 0
    for (const raw of complete.split('\n')) {
      if (raw.trim() === '') continue
      try {
        const item = parseInboxLine(raw)
        if (item === null) continue
        // 配置里强制了源语种就补上（ASR 已知语种时能避免自动判定出错）。
        if (item.from === undefined && config.inboxFrom !== '') item.from = config.inboxFrom
        queue.push(item)
        added += 1
      } catch (error) {
        // 坏行只计数、不中断：一条写坏的 JSON 不该让整条同传停摆。
        inbox.errors += 1
        inbox.lastError = '解析失败：' + String(error && error.message ? error.message : error)
      }
    }
    return { added }
  }

  /** 串行处理队列：同传不能并发，否则字幕会互相穿插。 */
  async function pump() {
    if (pumping) return
    pumping = true
    try {
      while (queue.length > 0) {
        const item = queue.shift()
        inbox.lastLine = item.text
        const args = { text: item.text }
        if (item.from !== undefined) args.from = item.from
        if (item.to !== undefined) args.to = item.to
        const result = await runTranslate(args)
        if (result.ok === true) {
          inbox.processed += 1
          // 自动同传这条路上没有人在看工具的返回值，所以把每一句打进日志 ——
          // 否则 transport 配成 'file' 时，整个 daemon 是完全静默的，出问题只能靠猜。
          console.log('[leion-pro] ' + result.from + '→' + result.to + '  ' + result.translation)
        } else {
          inbox.errors += 1
          inbox.lastError = result.failure
          // 失败必须说出来：静默的 daemon 是最难排查的东西。
          console.log('[leion-pro] ✗ 翻译失败：' + result.failure)
          if (result.partial !== null && result.partial !== undefined && result.partial !== '') {
            console.log('[leion-pro]   半截译文（已丢弃）：' + result.partial)
          }
        }
      }
    } catch (error) {
      inbox.errors += 1
      inbox.lastError = String(error && error.message ? error.message : error)
      console.log('[leion-pro] ✗ 处理收件箱时抛异常：' + inbox.lastError)
    } finally {
      pumping = false
    }
  }

  function startWatcher() {
    if (inbox.running) return
    if (config.inboxPath === '') {
      throw new Error("未配置 inboxPath，收件箱无法启动（在 cordis.yml 的 config 里设置，或改 CONFIG_OVERRIDE）")
    }
    inbox.stopWatcher = ctx.interval(() => {
      void (async () => {
        try {
          await readInbox()
        } catch (error) {
          inbox.errors += 1
          inbox.lastError = String(error && error.message ? error.message : error)
        }
        await pump()
      })()
    }, config.inboxPollMs)
    inbox.running = true
    inbox.startedAt = new Date().toISOString()
  }

  function stopWatcher() {
    if (inbox.stopWatcher !== null) {
      inbox.stopWatcher()
      inbox.stopWatcher = null
    }
    inbox.running = false
  }

  const inboxApi = {
    status() {
      return {
        configured: config.inboxPath !== '',
        running: inbox.running,
        path: config.inboxPath,
        pollMs: config.inboxPollMs,
        forcedFrom: config.inboxFrom === '' ? null : config.inboxFrom,
        consumedChars: inbox.consumed,
        processed: inbox.processed,
        errors: inbox.errors,
        queued: queue.length,
        startedAt: inbox.startedAt,
        lastLine: inbox.lastLine,
        lastError: inbox.lastError,
      }
    },
    start() {
      startWatcher()
      return this.status()
    },
    stop() {
      stopWatcher()
      return this.status()
    },
    /** 立刻读一次并把可用行处理完，不依赖轮询。 */
    async drain() {
      const read = await readInbox()
      await pump()
      return Object.assign(
        { read: read.added, note: read.note === undefined ? null : read.note },
        this.status(),
      )
    },
    /** 消费位置归零：下次从文件开头重读（演示时重放同一段很有用）。 */
    reset() {
      inbox.consumed = 0
      return this.status()
    },
  }

  const api = {
    config,
    device: DEVICE,
    transport,
    state,

    status() {
      return {
        device: DEVICE.model,
        vendor: DEVICE.vendor,
        aliases: DEVICE.aliases,
        panel: DEVICE.panel,
        transport: transport.kind,
        transportDetail: transport.detail,
        cols: config.cols,
        lines: config.lines,
        pushes: state.pushes,
        historyCount: state.frames.length,
        partials: state.partials,
        errors: state.errors,
        restored: state.restored,
        lastError: state.lastError,
        lastFrame: state.lastFrame,
      }
    },

    /** 直接推送一段已定稿文本（不翻译）。 */
    async display(args) {
      const frame = buildFrame(args)
      await pushFrame(frame)
      return {
        speaker: frame.speaker,
        lang: frame.lang,
        lines: frame.lines,
        pushedAt: frame.at,
        preview: drawFrame(frame, config.cols),
      }
    },

    /** 双向同传主操作：判语向 → 流式翻译 → 排版 → 推送。 */
    async translate(args) {
      const llm = ctx.get('llm')
      if (llm === undefined) {
        return { ok: false, failure: 'ctx 里没有 llm 服务，翻译无法进行；请改用 leion_display 自己翻译后推送' }
      }
      const source = String(args.text)
      const from = args.from !== undefined && args.from !== '' ? args.from : detectLang(source)
      if (from === 'unknown') {
        return { ok: false, failure: "判不出源语种。请显式传 from='zh-CN' 或 from='pt-BR'" }
      }
      const to = args.to !== undefined && args.to !== '' ? args.to : opposite(from)
      if (to === 'unknown') return { ok: false, failure: '目标语种无法推导，请显式传 to' }

      // 佩戴者读的那一帧：永远是译成佩戴者母语（中文）的那一侧。
      const wearerReadsTranslation = to === ZH
      const displaySpeaker = wearerReadsTranslation ? 'them' : 'me'

      state.translating = true
      let partialsPushed = 0
      const result = await streamTranslation(llm, source, from, to, async partial => {
        if (partial === '') return
        state.partials += 1
        partialsPushed += 1
        const frame = buildFrame({ text: partial, speaker: displaySpeaker, lang: to })
        try {
          // 增量只上屏、不进双语历史：历史是「现场说过什么」的记录，
          // 把「正在成形」的碎片写进去会污染它。
          await sendRaw(frame)
        } catch (error) {
          state.lastError = String(error && error.message ? error.message : error)
        }
      })
      state.translating = false

      if (result.ok !== true) {
        // 半截译文不能留在眼镜上。翻译失败时，把屏幕恢复成上一帧可用的字幕
        // （没有就清屏）—— 让佩戴者继续看到上一句，而不是一个碎片。
        if (partialsPushed > 0) {
          const fallback = state.lastGoodFrame !== null
            ? state.lastGoodFrame
            : buildFrame({ text: '', speaker: displaySpeaker, lang: to })
          try {
            await sendRaw(fallback)
            state.restored += 1
          } catch (error) {
            state.lastError = String(error && error.message ? error.message : error)
          }
        }
        return {
          ok: false,
          failure: result.failure,
          partial: result.partial === undefined ? null : result.partial,
          restoredDisplay: partialsPushed > 0,
        }
      }

      const finalFrame = buildFrame({ text: result.text, speaker: displaySpeaker, lang: to })
      await pushFrame(finalFrame)

      return {
        ok: true,
        from,
        to,
        source,
        translation: result.text,
        displaySpeaker,
        model: result.provider + '/' + result.model,
        forced: args.from !== undefined || args.to !== undefined,
        preview: drawFrame(finalFrame, config.cols),
        outbound: to === PT
          ? {
            channel: 'counterpart',
            lang: PT,
            text: result.text,
            note: '这段是给对方听的，需要 TTS 或第二块屏；眼镜上只做了回显确认',
          }
          : null,
      }
    },

    history(args) {
      const limit = args.limit === undefined ? 10 : Math.max(1, Math.min(HISTORY_CAP, Number(args.limit)))
      return state.frames.slice(Math.max(0, state.frames.length - limit))
    },

    async clear() {
      const cleared = state.frames.length
      state.frames.length = 0
      // 清屏之后就没有「上一帧可用字幕」了，否则失败的翻译会把清屏前的旧句子还原回来。
      state.lastGoodFrame = null
      const blank = buildFrame({ text: '', speaker: 'them', lang: 'none' })
      await sendRaw(blank)
      return { clearedHistory: cleared }
    },

    /** 自检：四条链路各自的真实状态，一次说清「哪一段断了」。 */
    async selftest() {
      const notes = []
      const sample = 'Bom dia! 我们今天的会议改到下午三点，会议室在十二楼。'
      const lines = fitSubtitle(sample, config.cols, config.lines)
      const layout = lines.length <= config.lines
        && lines.every(l => [...l].reduce((n, ch) => n + charCols(ch), 0) <= config.cols)

      let transportOk = false
      const probe = buildFrame({ text: '自检 · autoteste', speaker: 'them', lang: PT })
      try {
        await sendRaw(probe)
        transportOk = true
      } catch (error) {
        notes.push('显示通道失败：' + String(error && error.message ? error.message : error))
      }

      const detect = detectLang('会议在下午三点') === ZH
        && detectLang('A reunião é às três da tarde') === PT

      let translateOk = false
      const llm = ctx.get('llm')
      if (llm === undefined) {
        notes.push('ctx 里没有 llm 服务：leion_translate 不可用，只能自己翻译后走 leion_display')
      } else {
        const route = await resolveRoute(llm)
        translateOk = route.ok === true
        if (route.ok === true) notes.push('翻译路由：' + route.providerId + '/' + route.modelId)
        else notes.push(route.failure)
      }

      // 收件箱：未配置不算失败（报 null），配置了就真的去探一次。
      let inboxOk = null
      if (config.inboxPath !== '') {
        inboxOk = false
        const fs = ctx.get('fs')
        if (fs === undefined) {
          notes.push('收件箱需要 fs 服务，但当前 ctx 里没有')
        } else {
          try {
            const target = await fs.resolve(config.inboxPath)
            const info = await fs.stat(target)
            inboxOk = true
            notes.push('收件箱：' + config.inboxPath + '（'
              + (info === undefined ? '文件还不存在，等外部 ASR 创建' : '已就绪')
              + '），运行中 ' + (inbox.running ? '是' : '否')
              + '，已处理 ' + inbox.processed + ' 条，错误 ' + inbox.errors + ' 条')
          } catch (error) {
            notes.push('收件箱不可用：' + String(error && error.message ? error.message : error))
          }
        }
      }

      return {
        ok: layout && transportOk && detect && translateOk && inboxOk !== false,
        layout,
        transportOk,
        detect,
        translate: translateOk,
        inbox: inboxOk,
        notes,
        preview: drawFrame(probe, config.cols),
      }
    },
  }

  // 收件箱复用同一条翻译管线；自动启动只在配置了 inboxPath 时发生。
  runTranslate = api.translate
  api.inbox = inboxApi
  if (config.inboxPath !== '') {
    try {
      startWatcher()
    } catch (error) {
      inbox.errors += 1
      inbox.lastError = String(error && error.message ? error.message : error)
    }
  }
  return api
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具规格（author-facing value schema DSL，与 harness 的 defineTool 一致）
//
// ⚠️ 这是 harness 的 **value schema DSL**，不是原始 JSON Schema。实测真实 defineTool：
//   - `required` 只能是每个属性上的 `required: true`，**写成数组会被拒**；
//     也不能写 `required: false`（要么 true，要么整个省略）；
//   - `object` 必须**显式**声明 `additionalProperties: true|false`；
//   - 可空字段（string|null、object|null）用 `oneOf` 表达；
//   - `array` 用 `items`，且 `items` 上不能写 `required`；
//   - 允许的 type：string / number / integer / boolean / null / array / object / json。
//
// 统一外壳：所有工具都至少返回 ok + transport，`additionalProperties: true` 让各工具自由
// 附加字段而不会被过紧的 schema 卡住（失败路径只返回 ok/transport/failure，因此除这两个
// 以外的字段一律不加 required）。
// ─────────────────────────────────────────────────────────────────────────────

/** 统一输出 shell：ok / transport 必填，其余字段自由。 */
export function outputSchema(properties) {
  return {
    type: 'object',
    additionalProperties: true,
    properties: Object.assign({
      ok: { type: 'boolean', required: true },
      transport: { type: 'string', required: true },
      failure: { type: 'string' },
    }, properties),
  }
}

/** 可空字段的 schema 速写。 */
export function nullable(inner) {
  return { oneOf: [inner, { type: 'null' }] }
}

/**
 * 构建 6 个工具规格。
 * 每个规格形如 { name, description, parameters, outputSchemaDsl, execute, render }：
 *   · 动态适配器把 outputSchemaDsl 交给 harness.defineTool 就地编译；
 *   · 正式适配器用 schemas.generated.mjs 里预编译好的等价原始 schema；
 *   · render 两边共用同一个函数，所以展示层不可能漂移。
 */
export function buildToolSpecs(rt) {
  const shell = transport => ({ ok: true, transport })

  return [
    {
      name: 'leion_status',
      description: '查看亮亮眼镜插件当前状态：设备型号、传输通道、显示预算、已推送帧数、最近一次错误。'
        + '链路不通时先调这个。',
      parameters: {},
      outputSchemaDsl: outputSchema({
        device: { type: 'string' },
        vendor: { type: 'string' },
        aliases: { type: 'array', items: { type: 'string' } },
        panel: { type: 'string' },
        transportDetail: { type: 'string' },
        cols: { type: 'number' },
        lines: { type: 'number' },
        pushes: { type: 'number' },
        historyCount: { type: 'number' },
        partials: { type: 'number' },
        errors: { type: 'number' },
        restored: { type: 'number' },
        lastError: nullable({ type: 'string' }),
        lastFrame: nullable({ type: 'object', additionalProperties: true }),
      }),
      async execute() {
        return Object.assign(shell(rt.transport.kind), rt.status())
      },
      render: (args, value) => [{
        type: 'text',
        text: [
          '设备：' + value.device + '（' + value.vendor + '）',
          '通道：' + value.transport + ' — ' + value.transportDetail,
          '显示预算：' + value.cols + ' 列 × ' + value.lines + ' 行',
          '已推送 ' + value.pushes + ' 帧，历史 ' + value.historyCount + ' 条，节流丢弃 ' + value.partials + ' 次增量',
          '错误 ' + value.errors + (value.lastError === null ? '' : '，最近：' + value.lastError)
            + (value.restored > 0 ? '（有 ' + value.restored + ' 次把碎片恢复成了上一帧）' : ''),
        ].join('\n'),
      }],
    },

    {
      name: 'leion_display',
      description: '把一段已经定稿的文本排版后直接推到亮亮眼镜上显示（不翻译）。'
        + '适合：测试链路、显示提醒/关键词、或由你自己完成翻译后只借用显示通道。',
      parameters: {
        text: { type: 'string', required: true, description: '要显示的文本；插件会按显示宽度折行并保留最后几行' },
        speaker: { type: 'string', description: "这帧属于谁：'them' 对方说的（佩戴者要读的）| 'me' 佩戴者自己说的（回显）", enum: ['them', 'me'] },
        lang: { type: 'string', description: '文本语种，如 zh-CN / pt-BR' },
      },
      outputSchemaDsl: outputSchema({
        speaker: { type: 'string' },
        lang: { type: 'string' },
        lines: { type: 'array', items: { type: 'string' } },
        pushedAt: { type: 'string' },
        preview: { type: 'string' },
      }),
      async execute(args) {
        try {
          return Object.assign(shell(rt.transport.kind), await rt.display(args))
        } catch (error) {
          return { ok: false, transport: rt.transport.kind, failure: String(error && error.message ? error.message : error) }
        }
      },
      render: (args, value) => value.ok === true
        ? [{ type: 'text', text: '已推到 ' + rt.device.model + '（' + value.speaker + ' / ' + value.lang + '）\n' + value.preview }]
        : [{ type: 'text', text: '推送失败：' + value.failure }],
    },

    {
      name: 'leion_translate',
      description: '中↔巴西葡语双向翻译，并把结果推到亮亮眼镜上。缺省自动判语向：'
        + '中文→巴葡，巴葡→中文。佩戴者读的那一帧永远是「对方语言的译本」，'
        + '佩戴者自己的话译成巴葡后作为出站内容返回（给对方的扬声器/第二块屏）。',
      parameters: {
        text: { type: 'string', required: true, description: '原文。通常来自 ASR，也可以是直接键入的一句话' },
        from: { type: 'string', description: "源语种；缺省自动判定。'zh-CN' | 'pt-BR'" },
        to: { type: 'string', description: '目标语种；缺省取 from 的反向' },
      },
      outputSchemaDsl: outputSchema({
        from: { type: 'string' },
        to: { type: 'string' },
        source: { type: 'string' },
        translation: { type: 'string' },
        displaySpeaker: { type: 'string' },
        model: { type: 'string' },
        forced: { type: 'boolean' },
        preview: { type: 'string' },
        partial: nullable({ type: 'string' }),
        restoredDisplay: { type: 'boolean' },
        outbound: nullable({ type: 'object', additionalProperties: true }),
      }),
      async execute(args) {
        const result = await rt.translate(args)
        return Object.assign({ transport: rt.transport.kind }, result)
      },
      render: (args, value) => value.ok !== true
        ? [{ type: 'text', text: '翻译未完成：' + value.failure }]
        : [{
          type: 'text',
          text: [
            value.from + ' → ' + value.to + '（' + value.model + '）',
            '原文：' + value.source,
            '译文：' + value.translation,
            '眼镜上（' + value.displaySpeaker + '）：',
            value.preview,
          ].join('\n'),
        }],
    },

    {
      name: 'leion_history',
      description: '回看最近推送到亮亮眼镜的字幕帧（双语对照的现场记录）。',
      parameters: {
        limit: { type: 'number', description: '返回最近多少帧，缺省 10' },
      },
      outputSchemaDsl: outputSchema({
        count: { type: 'number' },
        entries: { type: 'array', items: { type: 'object', additionalProperties: true } },
      }),
      async execute(args) {
        const entries = rt.history(args)
        return Object.assign(shell(rt.transport.kind), { count: entries.length, entries })
      },
      render: (args, value) => [{
        type: 'text',
        text: value.count === 0
          ? '还没有任何字幕记录。'
          : value.entries.map(e => e.at + '  [' + e.speaker + '/' + e.lang + ']  ' + e.text).join('\n'),
      }],
    },

    {
      name: 'leion_clear',
      description: '清空眼镜上的字幕，并清空本次会话的字幕历史。',
      parameters: {},
      outputSchemaDsl: outputSchema({ clearedHistory: { type: 'number' } }),
      async execute() {
        try {
          return Object.assign(shell(rt.transport.kind), await rt.clear())
        } catch (error) {
          return { ok: false, transport: rt.transport.kind, failure: String(error && error.message ? error.message : error) }
        }
      },
      render: (args, value) => value.ok === true
        ? [{ type: 'text', text: '已清屏，同时清掉了 ' + value.clearedHistory + ' 条历史。' }]
        : [{ type: 'text', text: '清屏失败：' + value.failure }],
    },

    {
      name: 'leion_inbox',
      description: '控制 ASR 收件箱（自动同传的入口）：查看状态、启动/停止、立刻排空一次、'
        + '或把消费位置归零重放。收件箱是一个按行追加的文本文件，外部语音识别程序往里写一行，'
        + '插件就自动翻译并把字幕推到眼镜上——这是「不需要 agent 介入」的同传模式。',
      parameters: {
        action: {
          type: 'string',
          required: true,
          description: "status 查看 | start 启动轮询 | stop 停止 | drain 立刻处理一次 | reset 消费位置归零重放",
          enum: ['status', 'start', 'stop', 'drain', 'reset'],
        },
      },
      outputSchemaDsl: outputSchema({
        configured: { type: 'boolean' },
        running: { type: 'boolean' },
        path: { type: 'string' },
        pollMs: { type: 'number' },
        forcedFrom: nullable({ type: 'string' }),
        consumedChars: { type: 'number' },
        processed: { type: 'number' },
        errors: { type: 'number' },
        queued: { type: 'number' },
        startedAt: nullable({ type: 'string' }),
        lastLine: nullable({ type: 'string' }),
        lastError: nullable({ type: 'string' }),
        read: { type: 'number' },
        note: nullable({ type: 'string' }),
      }),
      async execute(args) {
        try {
          const run = args.action === 'start' ? () => rt.inbox.start()
            : args.action === 'stop' ? () => rt.inbox.stop()
              : args.action === 'drain' ? () => rt.inbox.drain()
                : args.action === 'reset' ? () => rt.inbox.reset()
                  : () => rt.inbox.status()
          return Object.assign(shell(rt.transport.kind), await run())
        } catch (error) {
          return { ok: false, transport: rt.transport.kind, failure: String(error && error.message ? error.message : error) }
        }
      },
      render: (args, value) => value.ok !== true
        ? [{ type: 'text', text: '收件箱操作失败：' + value.failure }]
        : [{
          type: 'text',
          text: [
            '收件箱：' + (value.configured ? value.path : '（未配置 inboxPath，自动同传关闭）'),
            '运行中：' + (value.running ? '是' : '否') + '，轮询间隔 ' + value.pollMs + 'ms',
            '已处理 ' + value.processed + ' 条，解析/翻译错误 ' + value.errors + ' 条，队列中 ' + value.queued + ' 条',
            value.read === undefined ? '' : '本次读到 ' + value.read + ' 条新行',
            value.note === null || value.note === undefined ? '' : '说明：' + value.note,
            value.lastLine === null ? '' : '最近一条：' + value.lastLine,
            value.lastError === null ? '' : '最近错误：' + value.lastError,
          ].filter(l => l !== '').join('\n'),
        }],
    },

    {
      name: 'leion_selftest',
      description: '自检：确认排版、显示通道、语种判定、翻译路由四条链路各自的真实状态。'
        + '演示或联调前先跑一次，能一次说清「哪一段断了」。',
      parameters: {},
      outputSchemaDsl: outputSchema({
        layout: { type: 'boolean' },
        transportOk: { type: 'boolean' },
        detect: { type: 'boolean' },
        translate: { type: 'boolean' },
        inbox: nullable({ type: 'boolean' }),
        notes: { type: 'array', items: { type: 'string' } },
        preview: { type: 'string' },
      }),
      async execute() {
        // 注意 Object.assign 的顺序：selftest() 自己的 ok（四条链路的与）覆盖 shell 的 true，
        // 所以自检有红灯时工具会如实返回 ok:false。
        return Object.assign(shell(rt.transport.kind), await rt.selftest())
      },
      render: (args, value) => [{
        type: 'text',
        text: [
          value.ok ? '✅ 自检通过' : '⚠️ 自检有问题',
          '排版：' + (value.layout ? 'OK' : 'FAIL'),
          '显示通道：' + (value.transportOk ? 'OK' : 'FAIL'),
          '语种判定：' + (value.detect ? 'OK' : 'FAIL'),
          '翻译路由：' + (value.translate ? 'OK' : 'FAIL'),
          value.inbox === null ? '' : '收件箱：' + (value.inbox ? 'OK' : 'FAIL'),
          value.notes.length === 0 ? '' : '说明：' + value.notes.join(' / '),
          value.preview,
        ].filter(l => l !== '').join('\n'),
      }],
    },
  ]
}

/** 加载日志行，两个包装共用。 */
export function loadedMessage(rt) {
  return '[leion-pro] 插件已加载 · ' + rt.device.model
    + ' · transport=' + rt.transport.kind
    + ' · 显示预算 ' + rt.config.cols + '×' + rt.config.lines
}
