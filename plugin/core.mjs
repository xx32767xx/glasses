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
import {
  charCols, wrapText, translationSystem, proofreadSystem, proofreadRegression,
  revisionProblem, proofreadRequest, normalizeTerms, langLane, mentionedEntries,
  detectTermsMiss, proofreadKeptNames, planRescue,
} from '../lib/translate.mjs'
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
   * 翻译后端 —— 这一步是接缝，不是硬编码。
   *
   *   'harness-llm'  用 harness 的模型服务（ctx.llm）。现状，也是本项目的默认。
   *   'http'         POST 到任意翻译端点。**把模型搬到端侧（手机/眼镜）时用这一条**：
   *                  端侧只要暴露一个 HTTP 服务，插件配置一行就能接上，不用改代码。
   *   'none'         插件不做翻译：收件箱里的文字**就是最终字幕**，只做排版与推送。
   *                  翻译在别处完成后推进来，插件退化成纯显示通道。
   *
   * 有了这个开关，"翻译放在哪一层"变成配置，而不是重写。
   */
  translator: 'harness-llm',
  /** translator: 'http' 时的端点 URL（POST，收 {text,from,to}，回 {text} 或 {translation}）。 */
  translatorUrl: '',
  /** translator: 'http' 的超时（毫秒）。 */
  translatorTimeoutMs: 15000,

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
  /**
   * 手机侧运行时设置的落点（`{ "proofread": true/false }`），由 relay 的 `PUT /settings` 写。
   * 留空 = 不读（完全按 config 走）。读不到就忽略 —— 一个坏文件不该影响出字幕。
   */
  settingsPath: '',
  /**
   * 热词归一（docs/15 §7.1）的总开关。
   *
   * <p>`'on'`：译文里出现**已知变体**时换成规范写法；`'off'`：完全不动，
   * 行为与加这个功能之前**逐字一致**（docs/15 §11 要求的"可回滚闸"）。
   * 默认开：没有表时它什么也不做，所以"开着"与"没有这个功能"等价。
   */
  terms: 'on',
  /** 热词表文件（`{ tables: { user: { entries } } }`），由 relay 写入。留空 = 不读。 */
  termsPath: '',
  /** "当前会话用哪个用户"的文件（`{ user: 'wu' }`），由 relay 写入。 */
  termsActivePath: '',
  /** 替换事件的落盘位置（一行一条 JSON）。留空 = 只打控制台。 */
  termsLogPath: '',
  /**
   * "待入表"队列（B 方案，docs/15 §18）：临时修正成功时追一条记录到这里，
   * 由 relay 在**启动 / 每场开始时**合并进 `terms.json`（插件仍然**只读**正式表）。
   * 留空 = 不写队列（实验可关）。
   */
  termsPendingPath: '',
  /**
   * 热词观测（A 方案）：一句话里**提到了**表内名字、但译文里**没写出规范写法**时，
   * 自动记一笔（`watch` 事件 + 手机端小提示），**本场不改字幕**。
   *
   * <p>为什么要它：热词表只能"把已知变体改对"；如果模型写了一个**没登记过**的新变体，
   * 本场救不了（也不知道它写成了什么）。但我们可以**知道"这句话出问题了"**，
   * 而且记下来的原文+译文正好是离线候选发现的输入 —— 下一场表就补上了。
   *
   * <p>`'off'` 时行为与加这个功能之前逐字一致（可回滚）。
   */
  termsWatch: 'on',
  /**
   * 本句专名提示（docs/15 §18.9）：翻译时把"这句原文里出现的表内名字 + 规范写法"
   * 追加进系统提示词，让模型**初译就写对**，而不是等事后修正。
   *
   * <p>实测（44 句 A/B 对照，见 §18.9）：规范写法出现率 53/56 → **56/56**，
   * prompt 只多约 27 token，没有一句被写坏、没有数字丢失。
   * 对空表 / 原文没提名字的句子**不追加任何东西**（行为与以前逐字一致）。
   */
  termsHint: 'on',
  /**
   * 热词临时修正（方向一实验，**默认关**）：观测到"提到了名字、译文没写出规范写法"时，
   * 空闲时问一次模型"这个名字在这句里写成了什么"，只在**片段可验证**时把那一小段换成规范写法。
   *
   * <p>三条硬约束（用户定的，写在配置旁边免得以后忘了）：
   *   · **不把"校对/下一帧把它改回来"当撤销依据** —— 两个机制不一致只能说明冲突，
   *     不能证明谁正确；所以本功能不监听、不撤销，先落地的那个生效，后到的按"过期"丢弃；
   *   · **绑定字幕帧与版本号**：结果回来时必须还是**同一帧**（displaySeq 未变 + 帧对象未换），
   *     否则丢弃 —— 避免修错对象（"最后一句"本身一直在变）；
   *   · 用户已经读到的错误不可能被"修对"完全消除影响，只能少一条。
   *
   * <p>只替换**可验证的片段**：答案必须原样出现在译文里、长度/字数有上限、
   * 与规范写法共享足够多字符（看起来是同一个名字被写错，而不是被泛化成"这家公司"），
   * 且不夹带别的表内名字。任何一关不过 → 拒绝（宁可不改，也不改坏）。
   */
  termsRescue: 'off',
  /** 每场最多问几次（防"表配错 → 每句都问"）。 */
  termsRescueLimit: 20,
  /** 结果超过这个年龄就丢：屏幕早换页了。 */
  termsRescueMaxAgeMs: 8000,

  /**
   * 大模型校对（讯飞那种"两遍"）：第一遍**快速出译文并立刻上屏**，
   * 第二遍让模型回头检查这一句（听错 / 译错 / 巴葡口径），改了就**覆盖同一帧**。
   *
   *   'off'   关闭（缺省）。行为与加这个功能之前完全一样。
   *   'idle'  只在**没有别的事可做时**做校对（收件箱队列空了、没有翻译在跑）。
   *          选 'idle' 而不是"翻译完立刻校对"是刻意的：
   *          收件箱是**串行**处理的，如果校对占着这一句不放，下一句的初译就要等它，
   *          等于给每一句都额外加一次模型往返（实测初译 0.44~0.96 秒，再加一次就是翻倍）。
   *          放到空闲时做，观众看到初译的时间**一点不变**。
   *
   * 代价与代价的边界（都是刻意的）：
   *   · 校对结果**只在"屏幕上还是这一句"时才覆盖**。如果这期间已经出了下一句
   *     （哪怕是下一句的流式增量），校对结果直接丢弃 —— 否则屏幕会**倒退**回上一句。
   *   · 超过 proofreadMaxAgeMs 还没轮到的，也不再改了：观众早就读过、翻页了。
   *   · 一次只跑一个校对（proofreading 标志），不和翻译抢模型。
   *
   * ⚠️ **缺省值从 'off' 改成了 'idle'（默认开启）**，按用户要求：
   *   同传里最常见的硬错不是"译得不好"而是"听错了"，而校对是唯一能救回来的手段
   *   （docs/07 §5.3 有实测：初译把 Qualcomm 泛化成 "alta capacidade"，校对补回来）。
   *   代价要说清：**每句可能多一次模型调用**。所以：
   *     · 它是"空闲才跑"，不占关键路径；
   *     · 手机上有一个开关（设置 → 校对），关掉后这台设备就不再排校对；
   *     · 手机开关通过 `var/live/settings.json` 生效（见 refreshRuntimeSettings）——
   *       一份数据两处可改时，**以手机为准**（用户当场能摸到的那个更可信）。
   */
  proofread: 'idle',
  /** 校对结果超过这个年龄（毫秒）就丢弃 —— 屏幕早换页了，改了也没人看。 */
  proofreadMaxAgeMs: 8000,
  /** 待校对队列的上限。积压说明机器跟不上，多排也只会更晚、更没意义。 */
  proofreadMaxQueue: 2,
  /**
   * 这场会的**目标语言**（5.00）。
   *
   * <p>只有中/葡两种时"译成另一种"是唯一的，所以以前不需要这个配置。
   * 加了英语之后三种语言并存，"对面"不唯一 —— 目标必须由会议决定：
   *   房间（`rooms.target_lang`）→ 每场会的大脑 `--to <lang>` → 这里。
   * 空串 = 老行为（`opposite(源语言)`：中↔葡互译，英语兜底译成中文）。
   */
  targetLang: '',
  /**
   * 这场会的**听众语言侧车**（5.00）：relay 写的 `room-langs/<房间>.json`。
   *
   * <p>为什么用文件而不是配置：成员进出、改语言都可能发生在两句之间，而配置是启动时固定的
   * （改配置要重启大脑，就赶不上"有人刚进来"这件事）。同一套做法见 `audio/<房间>.lang`（4.37）
   * 与 `settings.json`（手机侧的校对开关）。
   *
   * <p>空串 = 不读文件，按老行为（`opposite(源语言)`）—— 老部署不受影响。
   */
  hearLangsPath: '',
}

export const DEVICE = {
  vendor: 'LLVision 亮亮视野',
  model: 'Leion Pro',
  aliases: ['GLXSS ME'],
  panel: '单目 AR 显示，供佩戴者阅读',
}

/**
 * 这一句要译成哪几种语言（5.00）。
 *
 * <p><b>为什么是"几种"</b>：三语会议里同一句要给不同语言的人看 —— 但只译**实际有人在读**的
 * 语言（`listenerLangs` 来自 relay 写的侧车，等于 `room_members.lang` 去重）。所以：
 * 两个听众同语言 → 只译一份；不同语言 → 译两份（最多两份，因为只有三种语言、源语言占一种）。
 *
 * <p><b>排除源语言</b>：不排除就会"译成同语言"，产出一份看着正常、其实毫无意义的假字幕。
 *
 * <p><b>优先级（5.120 改过，注意方向）</b>：
 * <ol>
 *   <li>听众登记的语言（`hearLangs` 侧车里的并集）—— **这才是"我要看哪几种译文"**；</li>
 *   <li>会议显式指定的目标语言（`rooms.target_lang`）—— **并进去**，不是覆盖；</li>
 *   <li>两者都没有 → 兜底 `opposite(源)`。</li>
 * </ol>
 * 5.120 之前显式值**覆盖**听众集合，于是"手机里勾了三种我想看，屏幕上只有一种" ——
 * 用户报的就是这个：勾选是真的、下发也是真的，但大脑把并集丢掉了。
 * 显式值仍然有用：它解决"三种语言时方向不唯一"（这也是它当初被加进来的原因），
 * 只是不该反过来**减少**别人能看到的语种。
 *
 * @param {string} from 源语言
 * @param {string} override 显式目标（空串 = 不覆盖）
 * @param {string[]} listenerLangs 听众登记的语言（可能为空）
 * @returns {{targets: string[], source: 'override'|'override+listeners'|'listeners'|'paired'|'none'}}
 */
export function resolveTargets(from, override, listenerLangs) {
  const clean = (list) => {
    const seen = new Set()
    for (const item of Array.isArray(list) ? list : []) {
      const lang = String(item === undefined || item === null ? '' : item).trim()
      if (lang === '' || lang === from) continue        // 源语言永远不作为目标
      if (seen.has(lang)) continue                      // 去重：同语言只译一份
      seen.add(lang)
    }
    return [...seen]
  }
  const explicit = typeof override === 'string' ? override.trim() : ''
  const heard = clean(listenerLangs)
  // 显式值排在前面：它仍然决定"哪一份是主目标"（校对只对第一份做）。
  const merged = clean(explicit === '' ? heard : [explicit, ...(Array.isArray(listenerLangs) ? listenerLangs : [])])
  if (merged.length > 0) {
    const source = heard.length === 0
      ? 'override'
      : (explicit === '' ? 'listeners' : 'override+listeners')
    return { targets: merged, source }
  }
  // ⚠️ 关键：**登记了语言、但清完是空**（所有人读的都是源语言）→ 这一句不需要任何译文。
  //    如果这时回落到 opposite，就会给"没人需要的语言"白译一份 —— 既费钱又可能把
  //    一份多余的字幕推给不该看到它的人。
  const anyRegistered = (Array.isArray(listenerLangs) ? listenerLangs : [])
    .some(item => String(item === undefined || item === null ? '' : item).trim() !== '')
  if (anyRegistered || explicit !== '') return { targets: [], source: 'listeners' }
  const guess = opposite(from)
  return { targets: guess === 'unknown' ? [] : [guess], source: guess === 'unknown' ? 'none' : 'paired' }
}

export const ZH = 'zh-CN'
export const PT = 'pt-BR'
/**
 * 5.00：英语（美式）。
 *
 * <p>中 / 英 / 葡三种里它是"第三种"：**既可以是源、也可以是目标**。
 * 加它之后"哪两种互译"不再唯一 —— 所以目标语言必须由**会议**给定
 * （`rooms.target_lang` → 大脑 `--to` → `config.targetLang`），见 {@link resolveTarget}。
 *
 * <p>5.33：这三个常量在 `lib/translate.mjs` 里也各有一份（那边是零 import 的纯模块，
 * 不能从这里拿）。两边必须一致 —— `tests/tts-suite.mjs` 钉着这一点。
 */
export const EN = 'en-US'

/**
 * 这个路径看起来是不是绝对路径？
 *
 * 刻意不引 `node:path` —— core.mjs 是**零 import** 的（动态插件在沙箱里跑，
 * 拿不到 node 内置模块）。所以这里用最朴素的判断，覆盖三种真实写法：
 *   C:\... / C:/... / \\server\share\... / /usr/...
 */
export function looksAbsolutePath(value) {
  const text = String(value)
  return /^[A-Za-z]:[\\/]/.test(text) || text.startsWith('\\\\') || text.startsWith('/')
}

/** 一个片段一句话（同传里一条字幕就是一句话）。 */
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
  if (!['harness-llm', 'http', 'none'].includes(config.translator)) {
    throw new Error(`leion-pro: translator 只能是 'harness-llm' / 'http' / 'none'，收到 ${JSON.stringify(config.translator)}`)
  }
  if (config.translator === 'http' && (typeof config.translatorUrl !== 'string' || config.translatorUrl === '')) {
    throw new Error("leion-pro: translator 'http' 需要 translatorUrl 指向翻译端点")
  }
  if (!Number.isInteger(config.translatorTimeoutMs) || config.translatorTimeoutMs <= 0) {
    throw new Error(`leion-pro: translatorTimeoutMs 必须是正整数，收到 ${JSON.stringify(config.translatorTimeoutMs)}`)
  }
  if (typeof config.inboxPath !== 'string') {
    throw new Error(`leion-pro: inboxPath 必须是字符串，收到 ${JSON.stringify(config.inboxPath)}`)
  }
  if (typeof config.settingsPath !== 'string') {
    throw new Error(`leion-pro: settingsPath 必须是字符串，收到 ${JSON.stringify(config.settingsPath)}`)
  }
  if (!['on', 'off'].includes(config.terms)) {
    throw new Error(`leion-pro: terms 只能是 'on' / 'off'，收到 ${JSON.stringify(config.terms)}`)
  }
  for (const key of ['termsPath', 'termsActivePath', 'termsLogPath', 'termsPendingPath']) {
    if (typeof config[key] !== 'string') {
      throw new Error(`leion-pro: ${key} 必须是字符串，收到 ${JSON.stringify(config[key])}`)
    }
  }
  if (!['on', 'off'].includes(config.termsWatch)) {
    throw new Error(`leion-pro: termsWatch 只能是 'on' / 'off'，收到 ${JSON.stringify(config.termsWatch)}`)
  }
  if (!['on', 'off'].includes(config.termsHint)) {
    throw new Error(`leion-pro: termsHint 只能是 'on' / 'off'，收到 ${JSON.stringify(config.termsHint)}`)
  }
  if (!['on', 'off'].includes(config.termsRescue)) {
    throw new Error(`leion-pro: termsRescue 只能是 'on' / 'off'，收到 ${JSON.stringify(config.termsRescue)}`)
  }
  if (!Number.isInteger(config.termsRescueLimit) || config.termsRescueLimit <= 0) {
    throw new Error(`leion-pro: termsRescueLimit 必须是正整数，收到 ${JSON.stringify(config.termsRescueLimit)}`)
  }
  if (!Number.isInteger(config.termsRescueMaxAgeMs) || config.termsRescueMaxAgeMs <= 0) {
    throw new Error(`leion-pro: termsRescueMaxAgeMs 必须是正整数，收到 ${JSON.stringify(config.termsRescueMaxAgeMs)}`)
  }
  if (config.inboxPath !== '') {
    if (!Number.isInteger(config.inboxPollMs) || config.inboxPollMs < 100) {
      throw new Error(`leion-pro: 配置了 inboxPath 时 inboxPollMs 必须是不小于 100 的整数，收到 ${JSON.stringify(config.inboxPollMs)}`)
    }
  }
  if (!['off', 'idle'].includes(config.proofread)) {
    throw new Error(`leion-pro: proofread 只能是 'off' / 'idle'，收到 ${JSON.stringify(config.proofread)}`)
  }
  if (!Number.isInteger(config.proofreadMaxAgeMs) || config.proofreadMaxAgeMs <= 0) {
    throw new Error(`leion-pro: proofreadMaxAgeMs 必须是正整数，收到 ${JSON.stringify(config.proofreadMaxAgeMs)}`)
  }
  if (!Number.isInteger(config.proofreadMaxQueue) || config.proofreadMaxQueue <= 0) {
    throw new Error(`leion-pro: proofreadMaxQueue 必须是正整数，收到 ${JSON.stringify(config.proofreadMaxQueue)}`)
  }
  if (config.inboxFrom !== '' && config.inboxFrom !== ZH && config.inboxFrom !== PT) {
    throw new Error(`leion-pro: inboxFrom 只能是 '' / '${ZH}' / '${PT}'，收到 ${JSON.stringify(config.inboxFrom)}`)
  }
  return config
}

// ─────────────────────────────────────────────────────────────────────────────
// 字幕排版
// ─────────────────────────────────────────────────────────────────────────────

// （5.33：这一段搬去了 lib/translate.mjs —— 翻译/热词/校对的纯函数）

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

/**
 * 英语的"形状"标记（5.00）。
 *
 * <p>为什么要它：中/英/葡三种里，**英文与巴葡共用拉丁字母**，光看字符集分不开。
 * 所以用"高频功能词"当证据，并且要求 **≥2 个**才算 —— 一个词（比如 `no`、`a`）
 * 在葡语和英语里都可能出现，拿单个词判语种是"猜"，而猜错语种会让整句译错方向。
 *
 * <p>真正的语种来源仍是**每句话自带**（识别进程会给 `from`、手机上报 `lang`）；
 * 这里只是"没给 from 时"的兜底，所以宁可判 `${unknown}` 也不硬凑。
 */
export const EN_MARKERS = [
  'the', 'and', 'you', 'your', 'we', 'are', 'is', 'was', 'were', 'this', 'that', 'these',
  'those', 'with', 'for', 'from', 'have', 'has', 'will', 'would', 'can', 'could', 'should',
  'not', 'but', 'there', 'what', 'when', 'where', 'because', 'about', 'meeting', 'today',
  'tomorrow', 'thanks', 'thank', 'hello', 'sorry', 'please', 'okay', 'yes', 'know', 'think',
]

/** 判定一段文本是中文 / 巴葡 / 英语；判不出来返回 'unknown'，让调用方决定，绝不猜。 */
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
  // 5.00：巴葡证据一条都没有，才轮到英语 —— 且要**两个**以上功能词才算数。
  let englishHits = 0
  for (const marker of EN_MARKERS) {
    if (padded.includes(' ' + marker + ' ')) englishHits += 1
  }
  if (englishHits >= 2) return EN
  return 'unknown'
}

/**
 * 「另一种语言」的**兜底**推导（5.00 起它只是兜底）。
 *
 * <p>⚠️ 三种语言并存时，"对面"不唯一 —— 所以真正的目标语言应当由**会议**给定
 * （`rooms.target_lang` → 每场会的大脑 `--to` → `config.targetLang`）。
 * 这个函数只在"没给目标"的老链路上起作用：中↔葡互译，英语默认译成中文。
 */
export function opposite(lang) {
  if (lang === ZH) return PT
  if (lang === PT) return ZH
  if (lang === EN) return ZH
  return 'unknown'
}

/**
 * 这一句该译成哪种语言（5.00）。
 *
 * <p>优先级：**这一句显式给了 to** → **会议配置的目标语言** → 兜底 opposite(源语言)。
 * 三个来源都拿不到才报错（宁可不译，也不要猜错方向 —— 译错方向时译文看起来完全正常）。
 *
 * @returns {{target: string, source: 'explicit'|'meeting'|'paired'|'none'}}
 */
export function resolveTarget(from, argsTo, configTarget) {
  if (typeof argsTo === 'string' && argsTo !== '') return { target: argsTo, source: 'explicit' }
  if (typeof configTarget === 'string' && configTarget !== '') return { target: configTarget, source: 'meeting' }
  const guess = opposite(from)
  return { target: guess === 'unknown' ? '' : guess, source: guess === 'unknown' ? 'none' : 'paired' }
}

// （5.33：这一段搬去了 lib/translate.mjs —— 翻译/热词/校对的纯函数）
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
 * 建一个解释器实例：持有 transport、翻译后端、字幕历史、计数，并暴露业务操作。
 * @param ctx 受限 ctx（只需要 get）
 * @param rawConfig 用户配置（会被 validateConfig 校验并填默认值）
 * @param deps 必须提供 { policy } —— 巴葡策略数据，见 policy/br-pt.json 与
 *             plugin/policy.generated.mjs（生成物）。两个包装目标各自把 policy 传进来：
 *             正式包 import 生成模块，动态包由生成器内联成常量。
 */
/** 折叠用的串，**长度必须不变**（否则所有偏移量都会错位）。 */
// （5.33：这一段搬去了 lib/translate.mjs —— 翻译/热词/校对的纯函数）

export function createInterpreter(ctx, rawConfig, deps) {
  const config = validateConfig(rawConfig)
  if (deps === undefined || deps === null || deps.policy === undefined) {
    throw new Error('leion-pro: 缺少 policy。它由 plugin/policy.generated.mjs 提供；'
      + '如果你刚改过 policy/br-pt.json，先跑 node scripts/generate.mjs')
  }
  const policy = deps.policy
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
    /**
     * 屏幕上"换过几次"的计数。**每一次 sendRaw（含流式增量、清屏）都 +1**。
     * 校对结果靠它判断"我要改的那句还在屏幕上吗"：
     * 期间只要有任何东西上过屏（哪怕只是下一句的增量），这个数就变了，
     * 校对结果就必须**丢弃** —— 否则屏幕会倒退回去显示上一句。
     */
    displaySeq: 0,
    /** 校对统计。字段名直说结果，便于在自检和日志里一眼看出"校对到底有没有在干活"。 */
    proofread: { enqueued: 0, settled: 0, fixed: 0, same: 0, rejected: 0, dropped: 0, failed: 0, lastNote: null },
    /** 热词归一（docs/15 §7.1）：用了几条表、替换/命中/边界跳过各几次。 */
    terms: {
      enabled: false, user: null, entries: 0, replace: 0, hit: 0, boundarySkip: 0, watch: 0, lastNote: null,
      /** 热词临时修正（方向一实验）：问了几次、改了几次、拒了几次、丢了几次。 */
      rescue: { asked: 0, applied: 0, rejected: 0, dropped: 0, failed: 0, lastNote: null },
    },
    /** 最近几句（原文+译文），给校对当上下文用。只留很少几条，避免把提示词撑大。 */
    recent: [],
  }

  /**
   * 待校对队列 + 是否正在校对。
   *
   * 为什么要有队列而不是"翻译完立刻校对"：收件箱是串行处理的（同传不能并发，
   * 否则字幕会互相穿插）。如果校对占着当前这一句不放，下一句的初译就得排队等它，
   * 等于给每一句都加了一次模型往返 —— 而实测初译本身只要 0.44~0.96 秒，
   * 加一次就翻倍。所以校对只在**空闲**（队列空、没有翻译在跑）时才动，
   * 观众看到初译的时间一点不变。
   */
  const proofreadQueue = []
  let proofreading = false
  /** 第一次因为"没有 llm 服务"失败后就不再重试，免得每句都刷一遍同样的错。 */
  let proofreadUnavailable = false

  function buildFrame(input) {
    const text = String(input.text === undefined ? '' : input.text)
    // `source` 是**原文**（ASR 识别出来的那句、或手输的文字），`text` 是给佩戴者看的那一侧。
    // 为什么两个都要给出去：手机端要按"原文在上、译文在下"成对显示，
    // 而**只有插件这一层同时知道这两样**（原文是它的输入，译文是它的产出）。
    // 缺省等于 text —— 这样 translator='none' 与 leion_display 这类没有"原文"概念的
    // 路径不用改，帧的结构也始终一致（下游不必分情况处理）。
    const source = String(input.source === undefined ? text : input.source)
    return {
      device: DEVICE.model,
      speaker: input.speaker === undefined ? 'them' : input.speaker,
      lang: input.lang === undefined ? 'unknown' : input.lang,
      text,
      source,
      sourceLang: input.sourceLang === undefined ? 'unknown' : input.sourceLang,
      /**
       * 这一帧是不是"还在生成中"的流式增量。
       *
       * 为什么要给出去：手机端要在**原位更新**同一个片段，并且给未定稿的那条打
       * 「生成中」标签。少了这个字段，手机分不清"这条还没译完"和"这条已经定稿"，
       * 只能靠猜 —— 而猜错的表现是：字幕永远挂着"生成中"，或者半句被当成定稿。
       */
      partial: input.partial === true,
      lines: fitSubtitle(text, config.cols, config.lines),
      // 热词观测（docs/15 §17）：本句"提到了表内名字但译文没写出规范写法"的条目。
      // 手机端据此在字幕下打一行小字（本场不改字幕，只是告诉用户"已记录"）。
      // 没有就**不放这个字段** —— 帧结构和加这个功能之前逐字一致。
      ...(Array.isArray(input.termsMiss) && input.termsMiss.length > 0
        ? { termsMiss: input.termsMiss }
        : {}),
      // 把显示预算也放进帧里：这样任何下游（真机桥、局域网转发、手机 App）
      // 都能从数据本身知道"眼镜有多大"，不必各自硬编码或各自配一份。
      cols: config.cols,
      lineBudget: config.lines,
      // 5.12：**原文帧**（echo）与"这一句不需要翻译"的提示。
      //
      // 为什么需要它：译文帧是按语言分发出去的，所以"说中文、对方读葡语"的房间里，
      // 说中文的那个人**一帧都收不到** —— 他屏幕上除了自己说话没有任何东西，
      // 看起来像"我说话了但系统没反应"。所以每句都额外发一帧**源语言**的原文帧：
      // 按语言扇出之后，它天然只到"读源语言的人"手里（首先就是说话人自己）。
      ...(input.echo === true ? { echo: true } : {}),
      ...(typeof input.notice === 'string' && input.notice !== '' ? { notice: input.notice } : {}),
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
    state.displaySeq += 1        // 屏幕变了：在途的校对结果就此作废（见 state.displaySeq 的说明）
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

  // ───────────────────────────────────────────────────────────────────────────
  // 热词归一（docs/15 阶段 3）：把译文里的"已知变体"换成用户写的规范写法
  //
  // 为什么这套实现**写在 core.mjs 里、而不是从 lib/ 引过来**：
  // 插件要被内联进动态插件的沙箱，那个沙箱**没有 import**（生成器只剥 `export `，
  // 一个字面 import 会在沙箱里炸）。所以这一层必须自包含。
  // 对应的单测与评测脚本仍然用 lib/terms-matcher.mjs —— 那是同一套规则的
  // "可测副本"，两边由 tests/terms-matcher-suite.mjs 与 contract-suite 同时盯着。
  //
  // ⚠️ 三条边界写死在这里：
  //   ① **不调用模型**：纯字符串；② **幂等**：一次扫描内替换完，再喂一遍不变；
  //   ③ **只做归一**：不做"缺失重译"（那是后续独立实验）。
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * 对一段译文做归一（**实例内**的入口：带开关与已载入的表）。
   *
   * @param {string} text 译文
   * @param {string} lang 译文语种（`zh-CN` / `pt-BR`）：**在同一种语言内部**收敛写法
   */
  function applyTerms(text, lang) {
    if (config.terms !== 'on') {
      return { text: typeof text === 'string' ? text : '', events: [], changed: false }
    }
    return normalizeTerms(text, lang, termEntries)
  }

  /** 热词观测开关：归一总开关与观测开关**都为 on** 才做（docs/15 §17）。 */
  function watchEnabled() {
    return config.terms === 'on' && config.termsWatch === 'on'
  }

  /**
   * 本句专名提示（docs/15 §18.9）：找出"这句原文里真的出现了"的表内条目。
   *
   * <p>只列**本句出现**的名字 —— 不把整张表塞进提示词（那会稀释、浪费 token，
   * 还可能让模型乱补名字）。空表 / 本句没提名字时返回 null，提示词一个字都不加。
   *
   * <p>⚠️ 判断"提到"这件事只有这一份实现（下面 `mentionedEntries`）。演示台/评测脚本
   * 如果要展示"本句会不会加提示"，必须调它，不能自己写 `text.includes(entry.zh)` ——
   * 那样会漏掉**变体**（原文说「亮亮眼睛」、条目写「亮亮眼镜」，简化判断会漏），
   * 于是演示与产线给出不同结论，而这种分叉最难发现。
   */
  function termsHintFor(source, from) {
    if (config.terms !== 'on' || config.termsHint !== 'on') return null
    if (termEntries.length === 0) return null
    const text = String(source === undefined || source === null ? '' : source)
    if (text === '') return null
    // 5.02：按**源语言**取那一栏的写法（zh / pt / en 三条车道），不再只有"是中文/不是中文"
    const hint = mentionedEntries(text, termEntries, langLane(from))
    return hint.length === 0 ? null : hint
  }

  /**
   * 读热词表 / 会议术语。
   *
   * <p>**每句都会调用**（2026-10-24 改）。为什么不再"每场只读一次"：
   * "这一场用哪些库"现在是**手机开始同传时由 relay 发布**到固定路径的（docs/19），
   * 而大脑进程往往在"开始同传"之前就起来了 —— 只读一次的话，这一场永远用上一场的表，
   * 实测表现就是"取消勾选、重启之后旧词表还在生效"。
   *
   * <p>代价控制：读的是**一份冻结好的会议术语文件**（几 KB），每个句子读一次可忽略；
   * 而且用**内容指纹**比对，没变就不重新解析（避免每句都 JSON.parse）。
   * 这也保留了原来的好处：同一场里文件不变 → 行为稳定。
   */
  let termEntries = []
  let termsFingerprint = null

  async function refreshTerms() {
    if (config.terms !== 'on' || config.termsPath === '') return
    const fs = ctx.get('fs')
    if (fs === undefined) {
      state.terms.lastNote = '没有 fs 服务，热词表未加载'
      return
    }
    try {
      // 先看"当前会话用哪个用户"，再取那个用户的表
      let user = null
      if (config.termsActivePath !== '') {
        try {
          const activeTarget = await fs.resolve(config.termsActivePath)
          const activeInfo = await fs.stat(activeTarget)
          if (activeInfo !== undefined) {
            const parsed = JSON.parse(await fs.readText(activeTarget))
            if (parsed !== null && typeof parsed === 'object' && typeof parsed.user === 'string') {
              user = parsed.user
            }
          }
        } catch { /* 没有 active 文件就用 default */ }
      }
      const target = await fs.resolve(config.termsPath)
      const info = await fs.stat(target)
      if (info === undefined) {
        state.terms.lastNote = '没有热词表文件'
        return
      }
      const doc = JSON.parse(await fs.readText(target))
      const tables = doc !== null && typeof doc === 'object' && doc.tables !== null
        && typeof doc.tables === 'object' ? doc.tables : {}
      const chosen = user !== null && tables[user] !== undefined ? user : 'default'
      const table = tables[chosen]
      const entries = table !== null && table !== undefined && Array.isArray(table.entries) ? table.entries : []
      // 内容指纹：文件没变就不重复解析/刷日志（每句都会调这个函数）
      const fingerprint = chosen + '|' + entries.length + '|'
        + (table && typeof table.updatedAt === 'string' ? table.updatedAt : '')
      if (fingerprint === termsFingerprint) return
      termsFingerprint = fingerprint
      termEntries = entries
      state.terms.enabled = config.terms === 'on'
      state.terms.user = chosen
      state.terms.entries = entries.length
      console.log('[leion-pro] 热词表：' + entries.length + ' 条（user=' + chosen + '）')
    } catch (error) {
      // 读表失败**绝不能影响出字幕**：当作没有热词表
      state.terms.lastNote = '读热词表失败（已忽略）：'
        + String(error && error.message ? error.message : error)
      console.log('[leion-pro] 热词表：' + state.terms.lastNote)
    }
  }

  /** 把替换事件写一行日志（控制台 + 可选落盘）。失败一律忽略。 */
  const termsLogLines = []
  async function logTermsEvents(events, where) {
    if (!Array.isArray(events) || events.length === 0) return
    for (const event of events) {
      if (event.event === 'replace') {
        state.terms.replace += 1
        console.log('[leion-pro] ✎ 术语：' + event.from + ' → ' + event.to)
      } else if (event.event === 'hit') {
        state.terms.hit += 1
      } else if (event.event === 'boundary_skip') {
        state.terms.boundarySkip += 1
      } else if (event.event === 'watch') {
        // 热词观测：本句提到了名字、译文却没写出规范写法 → 记下来（不改字幕）。
        // 记的是**完整原文+译文**：离线候选发现要拿它们去问"写成了什么"。
        state.terms.watch += 1
        console.log('[leion-pro] ◌ 术语观测：' + event.zh + ' 未按对照写法出现（已记录）')
      }
      termsLogLines.push(JSON.stringify({
        t: new Date().toISOString(), where, ...event,
      }))
    }
    if (config.termsLogPath === '') return
    const fs = ctx.get('fs')
    if (fs === undefined) return
    try {
      // fs 服务只有 writeText（没有 append），所以整份重写；只保留最近 2000 行
      while (termsLogLines.length > 2000) termsLogLines.shift()
      const target = await fs.resolve(config.termsLogPath)
      await fs.writeText(target, termsLogLines.join('\n') + '\n')
    } catch {
      /* 日志写不进去就算了：它是可观测性，不是功能 */
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 大模型校对（第二遍）：把已经上屏的译文回头再检查一次
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * 手机侧的运行时开关（`var/live/settings.json`，由 relay 的 `PUT /settings` 写入）。
   *
   * 为什么需要它：`config.proofread` 是**部署时**的配置，改它要重启 harness；
   * 而"这一场要不要校对"是用户当场就想改的事（费不费钱、快不快）。
   * 所以留一个文件接缝 —— 与收件箱/字幕总线同一套做法。
   *
   * 约定：
   *   · 文件不存在 / 读不到 / 格式不对 → **完全忽略**，按 config 来（不能让一个坏文件影响出字幕）；
   *   · 文件里有 `proofread` → **以它为准**（用户当场能摸到的那份更可信）；
   *   · 每场同传只读一次（第一次要排校对时），所以"改了下次生效"是天然的。
   */
  let runtimeProofread = null       // null = 还没读过 / 读不到
  let runtimeSettingsRead = false

  async function refreshRuntimeSettings() {
    if (runtimeSettingsRead) return
    runtimeSettingsRead = true
    const fs = ctx.get('fs')
    if (fs === undefined) return
    try {
      const target = await fs.resolve(config.settingsPath)
      const info = await fs.stat(target)
      if (info === undefined) return
      const text = await fs.readText(target)
      const parsed = JSON.parse(text)
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.proofread === 'boolean') {
        runtimeProofread = parsed.proofread
        console.log('[leion-pro] 校对：按手机侧设置 ' + (runtimeProofread ? '开启' : '关闭'))
      }
    } catch (error) {
      // 读设置失败**绝不能影响出字幕**：忽略即可
      console.log('[leion-pro] 校对：读 settings.json 失败（已忽略，按配置走）：'
        + String(error && error.message ? error.message : error))
    }
  }

  /**
   * 校对到底开没开（配置与手机侧开关合并后的**唯一判定**）。
   *
   * 为什么要有这么一个小函数：状态输出、自检说明、以及真正的排队判断
   * 都必须用同一套口径，否则会出现"状态说开着、其实没排队"这种最容易误导人的情况。
   */
  function proofreadWanted() {
    return runtimeProofread === null ? config.proofread === 'idle' : runtimeProofread
  }

  /** 有没有可用的模型服务。没有就别排队了 —— 排了也是每次都失败。 */
  function proofreadEnabled() {
    if (proofreadWanted() !== true || proofreadUnavailable) return false
    if (translator.kind === 'none') return false     // 纯显示通道：插件不碰模型
    const llm = ctx.get('llm')
    if (llm === undefined) {
      proofreadUnavailable = true
      state.proofread.lastNote = '没有 llm 服务，校对已自动关闭'
      console.log('[leion-pro] 校对：当前 ctx 里没有 llm 服务，自动关闭（翻译本身不受影响）')
      return false
    }
    return true
  }

  /**
   * 把一句刚上屏的译文排进校对队列。
   *
   * 记下 seq（当时的 displaySeq）是关键：等真正轮到校对时，要用它确认
   * "屏幕上还是这一句"。这就是"校对绝不覆盖更新的字幕"这条保证的实现方式。
   */
  function enqueueProofread(item) {
    if (!proofreadEnabled()) return false
    if (proofreadQueue.length >= config.proofreadMaxQueue) {
      // 积压了：丢掉最老的一条（它最不可能还在屏幕上）
      proofreadQueue.shift()
      state.proofread.dropped += 1
    }
    proofreadQueue.push(item)
    state.proofread.enqueued += 1
    return true
  }

  /**
   * 做一次校对。返回是否真的做了（调用方据此决定要不要继续让出时间片）。
   *
   * 只在**空闲**时被调用：收件箱队列空、没有翻译在跑、没有别的校对在跑。
   */
  async function runOneProofread() {
    if (proofreading || !proofreadEnabled()) return false
    const item = proofreadQueue.shift()
    if (item === undefined) return false

    // 太老了就不改了：屏幕上早换页了，改它既没人看、还白花一次调用。
    const age = Date.now() - item.at
    if (age > config.proofreadMaxAgeMs) {
      state.proofread.dropped += 1
      state.proofread.lastNote = '有一句等太久（' + Math.round(age) + 'ms），已放弃校对'
      return true
    }
    // 还没轮到就已经换屏幕了：直接丢弃，连模型都不用调（省一次调用）。
    if (state.displaySeq !== item.seq) {
      state.proofread.dropped += 1
      state.proofread.lastNote = '屏幕上已经不是这一句了，校对结果丢弃'
      return true
    }

    proofreading = true
    try {
      const llm = ctx.get('llm')
      const route = await resolveRoute(llm)
      if (route.ok !== true) {
        state.proofread.failed += 1
        state.proofread.lastNote = route.failure
        return true
      }
      state.callSeq += 1
      const messages = [{
        id: 'leion-p' + state.callSeq,
        role: 'user',
        content: [{ type: 'text', text: proofreadRequest(item) }],
        source: { kind: 'user' },
      }]
      // 刻意**不流式上屏**：校对要么整句替换，要么不动。
      // 边校边显只会让屏幕来回跳，反而更难读。
      const proofreadOptions = {
        provider: route.providerId,
        model: route.modelId,
        system: proofreadSystem(policy, item.from, item.to, state.terms.entries),
        messages,
        maxTokens: config.maxTokens,
        // 温度比翻译再低一点：校对要的是"稳定地判对错"，不是发挥。
        temperature: Math.min(config.temperature, 0.2),
      }
      // 与翻译同一套推理强度配置：不显式传的话，适配器默认 high 会拿思考 token 吃预算
      if (config.reasoningEffort !== '') proofreadOptions.reasoningEffort = config.reasoningEffort
      let result = await runStream(llm, proofreadOptions, undefined)
      if (result.ok !== true && config.reasoningEffort !== ''
        && /REASONING/i.test(String(result.failure))) {
        const retryOptions = { ...proofreadOptions }
        delete retryOptions.reasoningEffort
        result = await runStream(llm, retryOptions, undefined)
      }

      if (result.ok !== true) {
        state.proofread.failed += 1
        state.proofread.lastNote = '校对失败（已忽略，屏幕保持初译）：' + result.failure
        return true
      }
      state.proofread.settled += 1

      const correctedRaw = String(result.text).trim()
      // §14.6 的"最终裁决"：校对可能把我们归一好的写法又改回去，所以这里再过一遍。
      // 这不是重复劳动 —— 校对是**在归一之后**跑的，只有它有能力破坏归一结果。
      const renormalized = applyTerms(correctedRaw, item.to)
      await logTermsEvents(renormalized.events, 'proofread')
      const corrected = renormalized.text
      if (corrected === '' || corrected === item.draft) {
        state.proofread.same += 1       // 模型认为不用改 —— 这是正常且期望的结果
        return true
      }
      // 验收闸：这条"修正"值不值得上屏（见 revisionProblem 的说明）
      const problem = revisionProblem(item.draft, corrected, config.cols, config.lines)
      if (problem !== null) {
        state.proofread.rejected += 1
        state.proofread.lastNote = '校对结果没通过验收（保持初译）：' + problem
        console.log('[leion-pro] ✗ 校对结果不可用，已丢弃：' + problem)
        return true
      }
      // 回归闸：格式过关了，但内容有没有被改坏（丢数字 / 冒出葡葡说法）。
      // 两道闸分开是为了让日志说清"是格式不对还是内容改坏了" ——
      // 前者说明模型没守格式约定，后者说明它真的引入了错误，排查方向完全不同。
      // 只用 item.source（原文）与两版译文做本地比对，**不增加任何模型调用**。
      const regression = proofreadRegression(item.source, item.draft, corrected, policy)
      if (regression !== null) {
        state.proofread.rejected += 1
        state.proofread.lastNote = '校对把初译改坏了（保持初译）：' + regression
        console.log('[leion-pro] ✗ 校对结果改坏了内容，已丢弃：' + regression)
        return true
      }
      // ── 4b 强制执行闸（docs/15 §14.3 / §18.8）──────────────────────────
      // 校对提示词已经写明"专有名词不由你负责"，但**实测模型并不完全遵守**
      // （它仍会把 "óculos LLVision" 改成 "óculos Leion" 之类）。
      // 所以再加一道本地检查兜底：初稿里已经正确的规范写法，校对结果里不许消失 ——
      // 消失了说明它把名字改掉/删掉/换成别的写法了，这次校对结果**整条丢弃**。
      const nameProblem = proofreadKeptNames(item.draft, corrected, termEntries, item.to)
      if (nameProblem !== null) {
        state.proofread.rejected += 1
        state.proofread.lastNote = '校对动了专名（保持初译）：' + nameProblem
        console.log('[leion-pro] ✗ 校对动了专名，已丢弃：' + nameProblem)
        return true
      }
      // 最后一道闸：重新确认屏幕没变过（模型调用期间可能已经出了下一句）。
      if (state.displaySeq !== item.seq) {
        state.proofread.dropped += 1
        state.proofread.lastNote = '校对期间屏幕已换页，结果丢弃（不覆盖更新的字幕）'
        return true
      }

      // 热词观测（校对后重算）：校对可能把名字补对（那就不该再有提示），
      // 也可能把名字写坏。放在所有闸之后：只有真要上屏的那一版才值得提示。
      const correctedWatch = watchEnabled()
        ? detectTermsMiss(item.source, corrected, termEntries, item.from, item.to)
        : []
      await logTermsEvents(correctedWatch, 'proofread')

      const frame = buildFrame({ text: corrected, speaker: item.displaySpeaker, lang: item.to,
        // ⚠️ 必须带上**原文**。这是个真踩过的坑：这一行原本没传 source，于是修订帧的
        //    source 退化成译文本身，而手机端是**按原文认"这是同一条字幕"**的 ——
        //    结果"校对改正"到了屏幕上不是原地替换，而是**多出一行**
        //    （那一行的"原文"位置还会显示成译文）。它是合并两个分支时才暴露的：
        //    写校对那会儿，帧里还没有 source 这个字段。
        source: item.source, sourceLang: item.from,
        termsMiss: correctedWatch.map(event => ({ id: event.id, zh: event.zh })) })
      await sendRaw(frame)
      state.lastGoodFrame = frame
      // 历史里那一条要**替换**，不能追加 —— 否则双语历史会多出一条重复的话，
      // 而且"改过的那版"会留在记录里，看起来像说了两遍。
      const last = state.frames.length - 1
      if (last >= 0 && state.frames[last] === item.draftFrame) {
        state.frames[last] = frame
      } else {
        state.frames.push(frame)
        if (state.frames.length > HISTORY_CAP) state.frames.shift()
      }
      state.proofread.fixed += 1
      state.proofread.lastNote = '改了：' + item.draft + ' → ' + corrected
      console.log('[leion-pro] ✎ 校对改了：' + item.draft)
      console.log('[leion-pro]            → ' + corrected)
      return true
    } catch (error) {
      state.proofread.failed += 1
      state.proofread.lastNote = '校对抛异常（已忽略）：' + String(error && error.message ? error.message : error)
      return true
    } finally {
      proofreading = false
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 热词临时修正（方向一实验，docs/15 §18）
  //
  // 只在**观测到**"提到了名字、译文却没写出规范写法"之后才问模型：
  // "这个名字在这句里写成了什么？" —— 拿到片段后走 planRescue 的全部闸门，
  // 通过才把**那一小段**换成规范写法（不是让模型重写整句）。
  //
  // 三条约束（用户定的）：
  //   ① 不把"校对/下一帧把它改回来"当撤销依据：不监听、不撤销，先落地者生效，
  //      后到者按"过期"丢弃（displaySeq 变化 = 屏幕已经不是那一帧了，与"谁对"无关）；
  //   ② 绑定字幕帧与版本：结果回来时必须 displaySeq 未变 **且** lastFrame 还是当初那一帧；
  //   ③ 用户已经读到的错误无法完全消除影响 —— 只能把后续同一句的显示改对。
  // ───────────────────────────────────────────────────────────────────────────

  /** 热词临时修正的待办队列（只留最新一条：屏幕上的"最后一句"只有一条）。 */
  const rescueQueue = []
  let rescuing = false

  function rescueEnabled() {
    if (config.terms !== 'on' || config.termsWatch !== 'on' || config.termsRescue !== 'on') return false
    return state.terms.rescue.asked < config.termsRescueLimit
  }

  /** 把一句刚上屏的译文排进临时修正队列（只有观测到漏写时才会被调用）。 */
  function enqueueRescue(item) {
    if (rescueEnabled() === false) return false
    rescueQueue.length = 0          // 只有"最后一句"有意义，新的顶掉旧的
    rescueQueue.push(item)
    return true
  }

  /** 从模型回答里抽出片段（容忍引号/句号；NONE → null）。 */
  function parseRescueAnswer(raw) {
    let text = String(raw === undefined || raw === null ? '' : raw).trim()
    for (let pass = 0; pass < 4; pass += 1) {
      const before = text
      text = text
        .replace(/^['"“”`「『（(]+/, '')
        .replace(/[。.；;，,、!?！？]+$/, '')
        .replace(/['"“”`」』）)]+$/, '')
        .trim()
      if (text === before) break
    }
    if (text === '' || /^NONE$/i.test(text)) return null
    return text
  }

  /**
   * 把"这次学到的变体"追加到**待入表队列**（B 方案，docs/15 §18.2）。
   *
   * <p>插件**不写正式表**（那是 relay 的职责，避免和手机上传抢同一个文件）：
   * 只追加一行记录；relay 在启动 / 每场开始时把队列合并进 `terms.json`。
   * 追加方式只能"读全文 + 整体重写"（fs 服务没有 append），
   * 而 relay 合并前会先把文件**原子挪走**，所以并发时最多丢一条新增，不会写坏队列。
   */
  async function queuePendingLearn(entry, from, to) {
    if (config.termsPendingPath === '') return false
    const fs = ctx.get('fs')
    if (fs === undefined) return false
    try {
      const target = await fs.resolve(config.termsPendingPath)
      let old = ''
      try {
        old = await fs.readText(target)
      } catch {
        /* 第一次写：队列还不存在 */
      }
      const user = state.terms.user === null ? 'default' : state.terms.user
      // 去重：同一个（用户 + 中文名 + 候选变体）已经在队列里就不重复写。
      // 实测：同一句话反复说、或同一变体反复出现时，队列会一条条膨胀；
      // 而且合并时它们本来也会按"已登记"跳过，写了没意义。
      const alreadyQueued = old.split(/\r?\n/).some(line => {
        try {
          const record = JSON.parse(line)
          return record !== null && record.event === 'pending' && record.user === user
            && record.zh === entry.zh && record.candidate === from
        } catch {
          return false
        }
      })
      if (alreadyQueued) return false
      const line = JSON.stringify({
        t: new Date().toISOString(),
        event: 'pending',
        user,
        zh: entry.zh,
        candidate: from,
        canonical: to,
      })
      await fs.writeText(target, (old === '' ? '' : old.replace(/\n*$/, '\n')) + line + '\n')
      console.log('[leion-pro] + 待入表：' + entry.zh + ' ← ' + from)
      return true
    } catch (error) {
      state.terms.lastNote = '待入表写入失败（已忽略）：' + String(error && error.message ? error.message : error)
      return false
    }
  }

  /**
   * 做一次临时修正。返回是否真的做了（调用方据此决定要不要继续。
   *
   * 与 `runOneProofread` 一样只在**空闲**时调用；一次只做一个。
   */
  async function runOneRescue() {
    if (rescuing || rescueEnabled() === false) return false
    const item = rescueQueue.shift()
    if (item === undefined) return false
    // 太老 / 已经不是那一帧：直接丢（与"谁对"无关，纯粹是过期）
    if (Date.now() - item.at > config.termsRescueMaxAgeMs
      || state.displaySeq !== item.seq || state.lastFrame !== item.draftFrame) {
      state.terms.rescue.dropped += 1
      state.terms.rescue.lastNote = '结果回来时屏幕已不是那一句，丢弃'
      console.log('[leion-pro] – 术语修正丢弃（' + item.entry.zh + '）：屏幕已不是那一句')
      return true
    }

    rescuing = true
    try {
      const llm = ctx.get('llm')
      const route = await resolveRoute(llm)
      if (route.ok !== true) {
        state.terms.rescue.failed += 1
        state.terms.rescue.lastNote = route.failure
        console.log('[leion-pro] – 术语修正失败：' + route.failure)
        return true
      }
      state.callSeq += 1
      const targetZh = String(item.to).toLowerCase().startsWith('zh')
      const canonical = targetZh ? item.entry.zh : item.entry.pt
      const system = '你在做术语片段核对。只输出片段本身或 NONE，不要解释。'
      const prompt = [
        item.to && targetZh ? '下面是一句葡语和它的中文译文。' : '下面是一句中文和它的葡语译文。',
        '',
        '原文：' + item.source,
        '译文：' + item.draft,
        '要核对的名字：' + item.entry.zh + '（规范写法：' + canonical + '）',
        '',
        '请找出译文里实际写这个名字的那一段文字（原样抄写，含冠词也可以）。',
        '注意：译文里可能用的是**音译、意译、缩写或全称**，和规范写法长得完全不一样 ——',
        '只要那段文字**指的就是这个名字**（例如「亮亮眼镜」被写成 "óculos Liangliang"，',
        '真正指代它的片段是 "Liangliang"），就交出那一段。',
        '只输出那段文字本身：不要解释、不要引号、不要加"译文里写的是"之类的前缀；',
        '只有译文里**完全没有任何词指代它**、或只剩"这家公司/这些眼镜"这类纯泛称时，才回答 NONE。',
      ].join('\n')
      const messages = [{
        id: 'leion-r' + state.callSeq,
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      }]
      const streamOptions = {
        provider: route.providerId,
        model: route.modelId,
        system,
        messages,
        // 实测两连击：① 40 个 token 太小 → 撞上限；② 更大也不够，因为**没传推理强度**，
        //    DeepSeek 适配器默认 high，思考 token 直接把预算吃光（finish=max-tokens）。
        //    所以这里：显式传 reasoningEffort（与翻译同一套配置；默认 'off'）+ 给到 600。
        maxTokens: 600,
        temperature: 0,
      }
      if (config.reasoningEffort !== '') streamOptions.reasoningEffort = config.reasoningEffort
      let result = await runStream(llm, streamOptions, undefined)
      // 有的路由不接受显式推理强度（UNSUPPORTED_REASONING_EFFORT）：去掉它重试一次
      if (result.ok !== true && config.reasoningEffort !== ''
        && /REASONING/i.test(String(result.failure))) {
        const retryOptions = { ...streamOptions }
        delete retryOptions.reasoningEffort
        result = await runStream(llm, retryOptions, undefined)
      }
      if (result.ok !== true) {
        state.terms.rescue.failed += 1
        state.terms.rescue.lastNote = '临时修正失败（已忽略）：' + result.failure
        const partial = typeof result.partial === 'string' && result.partial !== ''
          ? '（已收到的开头：' + result.partial.slice(0, 30) + '…）'
          : ''
        console.log('[leion-pro] – 术语修正失败：' + result.failure + partial)
        return true
      }
      state.terms.rescue.asked += 1
      const answer = parseRescueAnswer(result.text)
      if (answer === null) {
        state.terms.rescue.rejected += 1
        state.terms.rescue.lastNote = '回答 NONE（没有可替换的片段）'
        console.log('[leion-pro] – 术语修正未采纳：模型回答 NONE（没有可替换的片段）')
        return true
      }
      const plan = planRescue({
        draft: item.draft,
        answer,
        canonical,
        entries: termEntries,
        targetZh,
        cols: config.cols,
        lines: config.lines,
      })
      if (plan.ok !== true) {
        state.terms.rescue.rejected += 1
        state.terms.rescue.lastNote = '临时修正被闸门拒绝：' + plan.reason
        // ⚠️ 拒绝必须**说出来**（这是实测反馈：拒绝时什么都不打，用户只看到
        //    "开了开关却什么都没发生"，会以为是开关没生效或代码坏了）。
        console.log('[leion-pro] – 术语修正未采纳（' + item.entry.zh + '）：' + plan.reason)
        return true
      }
      // 关键：模型调用回来后**再**确认一次屏幕（调用期间可能已经出了下一句）。
      if (state.displaySeq !== item.seq || state.lastFrame !== item.draftFrame) {
        state.terms.rescue.dropped += 1
        state.terms.rescue.lastNote = '修正期间屏幕已换页，丢弃（避免修错对象）'
        console.log('[leion-pro] – 术语修正丢弃（' + item.entry.zh + '）：修正期间屏幕已换页')
        return true
      }
      await logTermsEvents([{ event: 'rescue', id: item.entry.id, from: plan.from, to: plan.to }], 'final')
      const frame = buildFrame({
        text: plan.text, speaker: item.speaker, lang: item.to,
        source: item.source, sourceLang: item.from,
      })
      await sendRaw(frame)
      state.lastGoodFrame = frame
      const last = state.frames.length - 1
      if (last >= 0 && state.frames[last] === item.draftFrame) {
        state.frames[last] = frame
      } else {
        state.frames.push(frame)
        if (state.frames.length > HISTORY_CAP) state.frames.shift()
      }
      state.terms.rescue.applied += 1
      state.terms.rescue.lastNote = '改了：' + plan.from + ' → ' + plan.to
      console.log('[leion-pro] ✎ 术语修正：' + plan.from + ' → ' + plan.to)
      // B 方案：本场已改对；同时把"这次学到的变体"追加到待入表队列，
      // relay 在下一场开始前合并进正式表 —— 这样下一场不靠模型也知道怎么写。
      await queuePendingLearn(item.entry, plan.from, plan.to)
      return true
    } catch (error) {
      state.terms.rescue.failed += 1
      state.terms.rescue.lastNote = '临时修正抛异常（已忽略）：' + String(error && error.message ? error.message : error)
      return true
    } finally {
      rescuing = false
    }
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
  async function streamTranslation(llm, text, from, to, onDelta, termsHint) {
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
      system: translationSystem(policy, from, to, termsHint),
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
    /**
     * 最近一句"为什么译成了这种语言"（5.11）。
     *
     * <p>为什么要放进状态里、而不是只打一行日志：这个功能**静默失效**过一次
     * （侧车读法写错 → 永远走 opposite 兜底 → 中文→英语根本出不来），
     * 而那种时候日志上看不出任何异常。放到 `leion_inbox status` 里，
     * 就能被测试断言、也能被人一眼查到"这句的目标语言依据是什么"。
     */
    hearLangs: { path: '', langs: [], readable: false },
    lastTargets: null,
  }
  const queue = []
  let pumping = false
  /** 由 api.translate 填充：收件箱要复用的就是那条翻译管线。 */
  let runTranslate = null

  /**
   * 一行可以是纯文本，也可以是 {"text":...,"from":...,"to":...}。
   *
   * <p>⚠️ 这条是**跨进程协议**（尤其 `speaker` 的 'me'/'them' 两值语义，
   * 与 `speakerName` 的真名是两回事）。写错了会让整条链路**静默哑掉** ——
   * 5.08 把真名写进 `speaker`，于是每一行都被判成坏行，字幕一句都不出（5.10 才修好）。
   * 它在实例闭包里，导出不了；所以由 `tests/contract-suite.mjs` 走**真实收件箱**
   * 端到端钉住（喂一行、看能不能出帧），而不是直接调这个函数。
   */
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
    if (parsed.speaker !== undefined && parsed.speaker !== 'them' && parsed.speaker !== 'me') {
      throw new Error("speaker 只能是 'them' / 'me' 或省略")
    }
    return {
      text: parsed.text,
      from: typeof parsed.from === 'string' ? parsed.from : undefined,
      to: typeof parsed.to === 'string' ? parsed.to : undefined,
      // speaker 只有 translator: 'none'（纯显示通道）时才用得上：那种模式下
      // 插件不做语向判定，帧归属于谁必须由写入方告知。
      speaker: typeof parsed.speaker === 'string' ? parsed.speaker : undefined,
      // ⚠️ 5.10：**真名要走 `speakerName`，绝不能塞进 `speaker`**。
      // `speaker` 在这条协议里是"相对佩戴者"的两值枚举（'me' / 'them'），所以这里会校验；
      // 队列链路（切句按说话人分轨）会把**真名**一起写进来，字段名必须与它区分开 ——
      // 5.08 就是把它写进了 `speaker`，结果每一行都被判成坏行，字幕一句都不出。
      speakerName: typeof parsed.speakerName === 'string' ? parsed.speakerName : undefined,
      // 5.41：这两项是**纯透传**的元信息（策略名 / 模型名），只为了日志与 A/B 分组。
      // 它们不参与语向判定，缺了也照样翻译 —— 所以不做校验，缺省 undefined。
      strategy: typeof parsed.strategy === 'string' ? parsed.strategy : undefined,
      model: typeof parsed.model === 'string' ? parsed.model : undefined,
    }
  }

  /** 「[策略 en-fast/model large-v3]」这种小尾巴（没有就不写）。 */
  function strategyTag(item) {
    if (item === null || item === undefined) return ''
    const name = typeof item.strategy === 'string' ? item.strategy.trim() : ''
    const model = typeof item.model === 'string' ? item.model.trim() : ''
    if (name === '' && model === '') return ''
    const parts = []
    if (name !== '') parts.push(name)
    if (model !== '') parts.push('模型 ' + model)
    return '[策略 ' + parts.join(' / ') + ']'
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

  /**
   * 读"这个房间的听众各自读哪种语言"（5.00）。
   *
   * <p>由 relay 写在 `<data-dir>/room-langs/<房间>.json`（`{ langs: [...], byUser: {...} }`），
   * 内容等于 `room_members.lang` 去重。读不到就返回空数组 —— 那时按 `opposite(源语言)` 兜底，
   * 也就是**老行为**（中↔葡互译），不会因为"读不到文件"而突然不译。
   *
   * <p>为什么每次都读：成员进出、改语言都可能在两句之间发生，而这份文件的写入是
   * relay 在"变化时"才做的，读取代价只有一次 stat + 小 JSON 解析。
   *
   * <p>⚠️ 5.11 修的大坑：这里原来直接 `fs.readText(config.hearLangsPath)` —— 传的是**字符串**，
   * 而 fs 服务的 `readText` 要的是 `resolve()` 返回的 `{ path }` 对象（收件箱那边一直那么用）。
   * 于是每次读都抛异常、被 `catch` 吞掉、返回空数组 → **永远走 opposite 兜底**：
   *   · 中文→英语永远出不来（目标被算成葡语）；
   *   · 葡语→英语也被算成中文。
   * 单测只验了 `resolveTargets`（纯函数）和 `--hear-langs` 有没有传，没人验"读得到吗"，
   * 所以多语言分发**一直没真正生效**，日志上只像"语言判断有点怪"。
   */
  /** 侧车文件"解析过一次的句柄"与"是否已经抱怨过读不到"（5.11：避免每句重复 resolve/重复刷日志）。 */
  let hearLangsTarget = null
  let hearLangsWarned = false
  /** 上一次用过的"目标集合 + 依据"，用来只在变化时打一行解释（5.11）。 */
  let lastTargetKey = ''
  /**
   * 侧车里"每个人自己登记的语言"（`byUser`）。
   *
   * <p>5.24 用它兜一件事：收件箱那一行偶尔**不带语种**（切句进程没读到分轨的 `.lang` 旁文件、
   * 或者走的是老混轨）。原来这种情况下只能拿 `detectLang(文本)` 去猜，
   * 猜不出来就整句不译、也不进转写。但这个房间里**每个人在入会时就登记过语言**，
   * 而说话人名字（`speakerName`）就在这一行上 —— 那才是应该优先用的依据。
   */
  let hearLangsByUser = {}

  async function readListenerLangs() {
    if (config.hearLangsPath === '') return []
    const fs = ctx.get('fs')
    if (fs === undefined) return []
    try {
      if (hearLangsTarget === null) hearLangsTarget = await fs.resolve(config.hearLangsPath)
      const text = await fs.readText(hearLangsTarget)
      const parsed = JSON.parse(text)
      const langs = Array.isArray(parsed?.langs) ? parsed.langs.map(item => String(item)) : []
      hearLangsByUser = parsed !== null && typeof parsed?.byUser === 'object' && parsed.byUser !== null
        ? parsed.byUser
        : {}
      if (langs.length > 0) hearLangsWarned = false
      inbox.hearLangs = { path: config.hearLangsPath, langs, readable: true, speakers: Object.keys(hearLangsByUser).length }
      return langs
    } catch (error) {
      // 文件还不存在（第一句）或写了一半：都当"没有登记"，走老行为。
      // 但**第一次**要把它说出来 —— 静默降级正是这个 bug 藏了这么久的原因。
      hearLangsByUser = {}
      inbox.hearLangs = { path: config.hearLangsPath, langs: [], readable: false }
      if (hearLangsWarned === false) {
        hearLangsWarned = true
        console.log('[leion-pro] 读不到听者语言侧车（' + config.hearLangsPath + '）：'
          + String(error && error.message ? error.message : error)
          + ' → 这一场按 opposite(源语言) 兜底（中↔葡）；多语言分发不生效')
      }
      return []
    }
  }

  /**
   * 这一行的**源语言**：首选行里带的（识别端声明/判定），其次"说话人自己登记的语言"，
   * 最后才是按文字猜（`detectLang`）。
   *
   * <p>5.24：第二档是关键。会议里每个人入会时都登记了语言，手机上传音频时也一直在报语种，
   * 所以"判不出语种"这件事本该有答案可查 —— 不该因为某一环的元数据丢了就整句不译。
   * @returns {string} 语种码；真的一点线索都没有时返回 `'unknown'`
   */
  function resolveSourceLang(item) {
    const declared = typeof item?.from === 'string' ? item.from.trim() : ''
    if (declared !== '') return declared
    const who = typeof item?.speakerName === 'string' ? item.speakerName.trim() : ''
    if (who !== '' && typeof hearLangsByUser === 'object' && hearLangsByUser !== null) {
      const registered = String(hearLangsByUser[who] ?? '').trim()
      if (registered !== '') {
        // 说出来：这是"某一环的语种元数据没传下来，用登记语种补上"，不是正常路径
        console.log('[leion-pro] 这一行没带语种，按说话人登记的语言补：'
          + who + ' → ' + registered)
        return registered
      }
    }
    return detectLang(item?.text)
  }

  /** 串行处理队列：同传不能并发，否则字幕会互相穿插。 */
  async function pump() {    if (pumping) return
    pumping = true
    try {
      while (queue.length > 0) {
        const item = queue.shift()
        inbox.lastLine = item.text
        const args = { text: item.text }
        if (item.from !== undefined) args.from = item.from
        if (item.to !== undefined) args.to = item.to
        // ── 5.00：一句话可能要译成**几种**语言 ──────────────────────────────
        // 依据是"这个房间的听众各自读哪种语言"（relay 写的侧车，等于成员 lang 去重）。
        // 两个听众同语言 → 只译一份；不同语言 → 译两份（最多两份：三种语言、源语言占一种）。
        // 显式给了 to（工具调用 / 会议覆盖值）就只译那一种，行为与 4.100 一致。
        const listeners = args.to !== undefined && args.to !== '' ? [] : await readListenerLangs()
        // 5.24：源语言按"行里带的 → 说话人登记的语言 → 按文字猜"三档取（见 resolveSourceLang）
        const resolvedSourceLang = resolveSourceLang(item)
        const resolvedTargets = args.to !== undefined && args.to !== ''
          ? { targets: [args.to], source: 'explicit' }
          : resolveTargets(resolvedSourceLang, config.targetLang, listeners)
        const targets = resolvedTargets.targets
        // 目标集合**变化时**说一行：这是"为什么这句话译成了这种语言"的唯一解释来源。
        // 少了它，只能从"译文语言不对"倒推，而那种推断经常指向错误的地方（5.11 花了很久）。
        const targetKey = targets.join('|') + '@' + resolvedTargets.source
        inbox.lastTargets = { targets: [...targets], source: resolvedTargets.source, listeners }
        if (targetKey !== lastTargetKey) {
          lastTargetKey = targetKey
          const why = resolvedTargets.source === 'explicit' ? '显式指定（工具调用）'
            : resolvedTargets.source === 'override' ? '这一场显式指定的目标语言（听众没登记语言）'
              : resolvedTargets.source === 'override+listeners'
                ? `听众登记 ${listeners.join('/')} + 这一场的 ${config.targetLang}`
                : resolvedTargets.source === 'listeners'
                  ? (targets.length === 0
                    ? `听众 ${listeners.join('/')} 全都读源语言（不需要译文）`
                    : `听众登记的语言 ${listeners.join('/')}`)
                  : resolvedTargets.source === 'paired'
                    ? `听众没登记，按 opposite(${resolvedSourceLang || '?'}) 兜底`
                    : '判不出方向'
          console.log('[leion-pro] 译文目标：' + (targets.length === 0 ? '（不需要译文）' : targets.join(' + '))
            + '（依据：' + why + '）')
        }
        // ── 5.12：先给"读源语言的人"发一帧**原文**（echo）─────────────────────
        //
        // 为什么：译文帧是按语言分发的，所以"说中文、对方读葡语"的房间里，
        // 说中文的那个人**一帧都收不到**（他读了也看不懂葡语那份），屏幕上除了自己
        // 说话什么都没有 —— 看起来像"我说了但系统没反应"，而这正是用户报过的现象。
        // 原文帧的 lang = 源语言，按语言扇出后天然只到"读源语言的人"手里：
        // 说话人自己，以及同样读这门语言的听众。
        //
        // 只在**房间管线**（配了收件箱）里发：单机/眼镜那条路（leion_translate）
        // 有自己的显示逻辑，凭空多一帧空译文会把它覆盖掉。
        const sourceLang = resolveSourceLang(item)
        if (config.inboxPath !== '' && config.translator !== 'none' && sourceLang !== 'unknown') {
          const echo = buildFrame({
            text: '', source: item.text, sourceLang,
            lang: sourceLang,
            echo: true,
            // 所有人读的都是源语言 → 再给一句"为什么没有译文"，别让人以为坏了
            ...(targets.length === 0 ? { notice: 'same-language' } : {}),
          })
          // sendRaw：**不进历史**。历史记的是"这句话的译文"，原文帧重复记一遍没有意义。
          await sendRaw(echo)
        }
        if (targets.length === 0) {
          // 所有人读的都是源语言（或判不出方向）：**不译**。不产出译文帧，
          // 也不计错误 —— 这不是失败，是"这句话不需要翻译"。
          // （5.12 起会有一帧原文 + 一句提示，见上面；用户选的正是"只提示、不产译文"。）
          inbox.processed += 1
          console.log('[leion-pro] 跳过翻译（不需要任何译文）：' + item.text)
          continue
        }
        // 多个目标**并行**翻译：串行会让第二份语言多等一整次调用（字幕慢一倍）。
        // 顺序性由"每个目标只有一次调用"保证，不需要额外串行。
        const results = await Promise.all(targets.map((target, index) => {
          const one = { text: item.text, to: target }
          if (item.from !== undefined) one.from = item.from
          // 校对只对**主目标**（第一份）做：翻倍花钱只改个别字，而第二份语言通常只有一个人在看。
          if (index > 0) one.noProofread = true
          return runTranslate(one)
        }))
        for (let index = 0; index < results.length; index += 1) {
          const result = results[index]
          if (result.ok === true) {
            inbox.processed += 1
            // 自动同传这条路上没有人在看工具的返回值，所以把每一句打进日志 ——
            // 否则 transport 配成 'file' 时，整个 daemon 是完全静默的，出问题只能靠猜。
            // 5.41：识别侧把「这句用的是哪份识别策略」带进来了，日志里一并写出 ——
            // 否则 A/B 时"这句字幕是哪个策略出来的"只能靠时间顺序猜。
            console.log('[leion-pro] ' + result.from + '→' + result.to
              + (strategyTag(item) === '' ? '' : ' ' + strategyTag(item))
              + '  ' + result.translation)
          } else {
            inbox.errors += 1
            inbox.lastError = result.failure
            // 失败必须说出来：静默的 daemon 是最难排查的东西。
            console.log('[leion-pro] ✗ 翻译失败（' + targets[index] + '）：' + result.failure)
            if (result.partial !== null && result.partial !== undefined && result.partial !== '') {
              console.log('[leion-pro]   半截译文（已丢弃）：' + result.partial)
            }
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
    // ⚠️ 相对路径**实测会静默失效**：继电器照样往文件里写，插件这边读不到，
    //    既不报错也不出字幕，看上去像"翻译坏了"。所以这里直接拒绝，
    //    并把话说到能照着改（由调用方 catch 后记进 lastError + 打日志）。
    if (!looksAbsolutePath(config.inboxPath)) {
      throw new Error('inboxPath 必须是**绝对路径**，收到 ' + JSON.stringify(config.inboxPath)
        + '。相对路径会让收件箱静默读不到（继电器在写、插件读不到、还不报错）—— '
        + '用绝对路径，或在启动脚本里把 --data-dir 解析成绝对路径（scripts/start-all.mjs 已经这么做了）')
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
        // ── 校对只在这里做（第二遍）──────────────────────────────────────────
        // 位置是刻意的：pump() 已经返回，说明队列空了、没有翻译在跑 ——
        // 也就是说**现在这段时间本来就是闲着等的**。
        // 放到这里，校对既不占"下一句的初译"，也不会和翻译抢模型。
        // 一次只做一个（proofreading 标志在 runOneProofread 里管）。
        if (queue.length === 0 && !state.translating) {
          await runOneProofread()
          // 临时修正与校对同一个空闲窗口：都不占"下一句的初译"。
          // 两者不会互相撤销 —— 先落地的那个生效，后到的按"过期"丢弃（docs/15 §18）。
          await runOneRescue()
        }
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
        // 5.11：最近一句的"译文目标 + 依据"，以及听众语言侧车的读取情况。
        // 这个功能静默失效过一次（永远走 opposite 兜底，中文→英语根本出不来），
        // 所以把它做成**可查的状态**，而不是只打一行日志。
        lastTargets: inbox.lastTargets,
        hearLangs: inbox.hearLangs,
        // 校对的运行状态（关着时是 null）：调用方一眼能看出"第二遍"有没有在跑、
        // 改了几次、丢了几次（丢 = 屏幕上已经换页，主动放弃覆盖）。
        proofread: proofreadWanted() === false
          ? null
          : Object.assign({ mode: config.proofread, runtime: runtimeProofread,
            pending: proofreadQueue.length, inFlight: proofreading }, state.proofread),
        terms: Object.assign({ mode: config.terms }, state.terms),
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

  // ───────────────────────────────────────────────────────────────────────────
  // 翻译后端接缝
  //
  // 这是"翻译放在哪一层"的开关。三种实现都只要满足同一个契约：
  //     translate({ text, from, to, onDelta }) → { ok, text, failure?, ... }
  // 上层（收件箱 / 工具）完全不知道译文是谁产出的。
  //
  // 之所以要这个接缝：现在译文来自电脑上的 harness + 云端模型；将来可能搬到手机端
  // 甚至眼镜端。搬的时候只换这一个后端，上面的语向判定、排版、字幕纪律一行不动。
  // ───────────────────────────────────────────────────────────────────────────

  /** POST 到外部翻译端点。端侧模型只要暴露这样一个 http 服务就能接进来。 */
  async function translateViaHttp(args) {
    let timer = null
    try {
      if (typeof fetch !== 'function') {
        return { ok: false, failure: 'translator "http" 需要 fetch，但这个运行环境里没有' }
      }
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      // 注意：动态插件沙箱里 setTimeout 是"调用即抛"的陷阱，所以整段都包在 try 里。
      if (controller !== null) {
        timer = setTimeout(() => controller.abort(), config.translatorTimeoutMs)
      }
      const response = await fetch(config.translatorUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: String(args.text), from: args.from, to: args.to }),
        ...(controller === null ? {} : { signal: controller.signal }),
      })
      const raw = await response.text()
      if (response.ok !== true) {
        return { ok: false, failure: 'HTTP 翻译端点返回 ' + response.status + '：' + raw.slice(0, 200) }
      }
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        return { ok: false, failure: 'HTTP 翻译端点没返回 JSON：' + raw.slice(0, 200) }
      }
      const text = typeof parsed.text === 'string' ? parsed.text
        : typeof parsed.translation === 'string' ? parsed.translation
          : null
      if (text === null) {
        return { ok: false, failure: 'HTTP 翻译端点返回的 JSON 里既没有 text 也没有 translation：' + raw.slice(0, 200) }
      }
      const trimmed = text.trim()
      if (trimmed === '') return { ok: false, failure: 'HTTP 翻译端点返回了空译文' }
      return { ok: true, text: trimmed, provider: 'http', model: config.translatorUrl }
    } catch (error) {
      const aborted = error !== null && typeof error === 'object' && error.name === 'AbortError'
      return {
        ok: false,
        failure: aborted
          ? 'HTTP 翻译端点超时（' + config.translatorTimeoutMs + 'ms）'
          : 'HTTP 翻译端点失败：' + String(error && error.message ? error.message : error),
      }
    } finally {
      if (timer !== null) {
        try {
          clearTimeout(timer)
        } catch {
          // 沙箱里 clearTimeout 也是陷阱；这里没有别的办法，忽略即可
        }
      }
    }
  }

  const translator = (() => {
    if (config.translator === 'none') {
      return {
        kind: 'none',
        describe: () => '不翻译（收件箱里的文字就是最终字幕）',
        async translate(args) {
          // 直通：原文即字幕。语向不参与，因为压根没有翻译这一步。
          return { ok: true, skipped: true, text: String(args.text).trim() }
        },
      }
    }
    if (config.translator === 'http') {
      return {
        kind: 'http',
        describe: () => 'HTTP 翻译端点 ' + config.translatorUrl,
        async translate(args) {
          return await translateViaHttp(args)
        },
      }
    }
    return {
      kind: 'harness-llm',
      describe: () => 'harness 的模型服务（ctx.llm）',
      async translate(args) {
        const llm = ctx.get('llm')
        if (llm === undefined) {
          return {
            ok: false,
            failure: 'ctx 里没有 llm 服务。三个办法：把 config.translator 设成 '
              + "'http'（用外部翻译端点）或 'none'（本部署不做翻译，收件箱文字直接当字幕）；"
              + '或者用 leion_display 自己翻译后推送',
          }
        }
        return await translateWithRetry(llm, args)
      },
    }
  })()

  /**
   * 翻译一次，**失败时按需重试**（5.49）。
   *
   * <p>为什么要有它：现场日志里出现过
   * `finish=error，TRANSPORT：DeepSeek API request to https://api.deepseek.com failed` ——
   * 这是**对外网络抖动**，一两秒后重发往往就成功了。而现在的行为是：这一句直接没有译文
   * （只有原文帧），用户看到的就是"这句没翻"。对同传来说，缺一句比慢一句糟得多。
   *
   * <p>三条克制：
   * <ol>
   *   <li>**只在没有任何增量发出去时重试**：已经吐了半截译文再重来，屏幕上会出现
   *       两遍不同版本的字幕（比缺一句更让人困惑）；</li>
   *   <li>**只重试"可能自己会好"的失败**（网络/限流）；参数错、没有 llm 服务这类重试也没用；</li>
   *   <li>次数固定为 2 次（间隔 600ms / 1500ms），并且每次都打日志 ——
   *       不允许"悄悄重试到成功"，那会让延迟超标也看不出原因。</li>
   * </ol>
   */
  async function translateWithRetry(llm, args) {
    const delays = [600, 1500]
    for (let attempt = 0; ; attempt += 1) {
      const result = await streamTranslation(llm, args.text, args.from, args.to, args.onDelta,
        termsHintFor(args.text, args.from))
      if (result.ok === true) return result
      const partial = typeof result.partial === 'string' ? result.partial.trim() : ''
      const retryable = partial === '' && isTransientFailure(result.failure) && attempt < delays.length
      if (!retryable) {
        if (partial !== '' && attempt > 0) {
          console.log('[leion-pro] ↻ 重试后仍然只拿到半截译文，已按失败处理（不再重试）')
        }
        return result
      }
      console.log('[leion-pro] ↻ 翻译这次失败（' + result.failure + '），'
        + `${delays[attempt]}ms 后重试（第 ${attempt + 1}/${delays.length} 次）`)
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]))
    }
  }

  /** 这个失败值不值得重试（网络/限流 → 值得；配置/参数错 → 不值得）。 */
  function isTransientFailure(failure) {
    const text = String(failure ?? '')
    if (text.includes('没有 llm 服务') || text.includes('ctx 里没有 llm')) return false
    if (text.includes('返回了空译文')) return false
    return /TRANSPORT|API request|finish=error|rate.?limit|429|timeout|timed out|ECONNRESET|ETIMEDOUT|socket hang up/i
      .test(text)
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

    /**
     * 双向同传主操作：判语向 → 翻译（走后端接缝）→ 排版 → 推送。
     *
     * translator 为 'none' 时走纯显示分支：不做语向判定、不调任何模型，
     * 收件箱里的文字就是最终字幕（翻译已在别处完成）。
     */
    async translate(args) {
      const source = String(args.text)

      if (translator.kind === 'none') {
        // 纯显示通道：谁说的话由调用方给出（缺省"对方"），语种按文字自动判定。
        const lang = args.from !== undefined && args.from !== '' ? args.from : detectLang(source)
        const frame = buildFrame({
          text: source,
          speaker: args.speaker === undefined || args.speaker === '' ? 'them' : args.speaker,
          lang: lang === 'unknown' ? 'unknown' : lang,
        })
        await pushFrame(frame)
        return {
          ok: true,
          translated: false,
          from: lang,
          to: lang,
          source,
          translation: source,
          displaySpeaker: frame.speaker,
          model: '(不翻译)',
          forced: false,
          preview: drawFrame(frame, config.cols),
          outbound: null,
        }
      }

      const from = args.from !== undefined && args.from !== '' ? args.from : detectLang(source)
      if (from === 'unknown') {
        return { ok: false, failure: '判不出源语种。请显式传 from（zh-CN / pt-BR / en-US）' }
      }
      // 5.00：三种语言并存时**不能靠"对面"猜目标**。优先级：
      //   这一句显式给的 to → 这场会配置的目标语言（config.targetLang，来自 rooms.target_lang）
      //   → 兜底 opposite(from)（老行为：中↔葡互译）
      const resolved = resolveTarget(from, args.to, config.targetLang)
      const to = resolved.target
      if (to === '') {
        return { ok: false, failure: '目标语种无法推导：请显式传 to，或给这场会配一个目标语言' }
      }
      if (to === from) {
        // 源和目标相同 = 这一句不需要翻译。如实拒绝，而不是"译"出一份同语言的假字幕。
        return { ok: false, failure: `源语种与目标语种相同（都是 ${from}），这一句不需要翻译` }
      }

      // 佩戴者读的那一帧：永远是译成佩戴者母语（中文）的那一侧。
      const wearerReadsTranslation = to === ZH
      const displaySpeaker = wearerReadsTranslation ? 'them' : 'me'

      // 先确保热词表已载入（每场只读一次）。放在这里而不是更早：
      // 它只依赖文件，读失败也只是"没有表"，不影响这次翻译。
      await refreshTerms()
      state.translating = true
      let partialsPushed = 0
      const result = await translator.translate({
        text: source,
        from,
        to,
        onDelta: async partial => {
          if (partial === '') return
          state.partials += 1
          partialsPushed += 1
        const frame = buildFrame({ text: partial, speaker: displaySpeaker, lang: to,
          source, sourceLang: from, partial: true })
        try {
          // 增量只上屏、不进双语历史：历史是「现场说过什么」的记录，
          // 把「正在成形」的碎片写进去会污染它。
          await sendRaw(frame)
        } catch (error) {
          state.lastError = String(error && error.message ? error.message : error)
        }
        },
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

      // ★ 热词归一：**译文出来后、上屏之前**做一次（docs/15 §7.1 / §14.6）
      //   零模型调用、纯字符串；没有表或开关关着时原样返回（行为逐字不变）。
      const normalized = applyTerms(result.text, to)
      await logTermsEvents(normalized.events, 'final')
      // ★ 热词观测（docs/15 §17）：提到了名字、译文却没写出规范写法 → 记一笔（不改字幕）。
      //   它回答的是"这句话有没有问题"，不回答"写成了什么"（那由离线候选发现去问模型）。
      const missed = watchEnabled()
        ? detectTermsMiss(source, normalized.text, termEntries, from, to)
        : []
      await logTermsEvents(missed, 'final')
      const finalFrame = buildFrame({ text: normalized.text, speaker: displaySpeaker, lang: to,
        source, sourceLang: from,
        termsMiss: missed.map(event => ({ id: event.id, zh: event.zh })) })
      await pushFrame(finalFrame)

      // ── 排进「校对」队列（第二遍）────────────────────────────────────────
      // 顺序有讲究：先取上一句当上下文，再把这一句记进 recent。
      // 上下文只在与本句**同向**时才给 —— 语向来回切时，上一句的译文是另一种语言，
      // 塞给模型只会把它带偏。
      const previous = state.recent.length > 0 ? state.recent[state.recent.length - 1] : null
      // 排进校对队列之前读一次手机侧开关与热词表（每场只读一次；读不到就按配置走）。
      // 放在这个位置而不是开头：翻译本身不该因为这个文件读失败而多等一拍。
      await refreshRuntimeSettings()
      await refreshTerms()
      // 5.00：第二份语言**不排校对** —— 校对会翻倍花钱而只改个别字，而第二份语言通常
      // 只有一个人在看；主目标那一份照旧校对（保留"回头改错"的能力）。
      if (args.noProofread !== true) enqueueProofread({
        source,
        from,
        to,
        draft: normalized.text,
        displaySpeaker,
        draftFrame: finalFrame,
        // 记下"此刻屏幕的版本号"：等真轮到时用它确认这一句还在屏幕上（见 state.displaySeq）
        seq: state.displaySeq,
        at: Date.now(),
        context: previous !== null && previous.to === to ? previous : null,
      })
      // ★ 热词临时修正（方向一实验，docs/15 §18）：只有**观测到漏写**时才排队；
      //   空闲时问一次"这个名字写成了什么"，通过闸门才把那一小段换成规范写法。
      if (missed.length > 0 && rescueEnabled()) {
        const entry = termEntries.find(candidate => candidate.id === missed[0].id)
        if (entry !== undefined) {
          enqueueRescue({
            source,
            from,
            to,
            draft: normalized.text,
            draftFrame: finalFrame,
            seq: state.displaySeq,
            at: Date.now(),
            speaker: displaySpeaker,
            entry,
          })
        }
      }
      state.recent.push({ source, translation: normalized.text, to })
      if (state.recent.length > 4) state.recent.shift()

      return {
        ok: true,
        from,
        to,
        source,
        translation: normalized.text,
        displaySpeaker,
        model: result.provider + '/' + result.model,
        forced: args.from !== undefined || args.to !== undefined,
        preview: drawFrame(finalFrame, config.cols),
        // 校对开着时把它的计数一并给出（拷贝一份：这是即时快照，不是活引用）。
        // 输出外壳是 additionalProperties: true，所以加字段不会破坏 schema 校验。
        proofread: proofreadWanted() === false ? null : Object.assign({}, state.proofread),
        // 热词归一：用了几条表、替换/命中/边界跳过各几次（手机端与日志都看它）
        terms: Object.assign({ mode: config.terms }, state.terms),
        terms: Object.assign({ mode: config.terms }, state.terms),
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

      // 翻译这一环按**后端接缝**分情况检查：三种后端各有各的"就绪"含义。
      let translateOk = false
      if (translator.kind === 'none') {
        // 纯显示通道：不需要任何模型，天然就绪 —— 如实报 OK 并说明本部署不做翻译。
        translateOk = true
        notes.push('本部署不翻译（translator=none）：收件箱里的文字直接当字幕显示')
      } else if (translator.kind === 'http') {
        if (typeof fetch !== 'function') {
          notes.push('translator=http 但当前环境没有 fetch')
        } else if (typeof config.translatorUrl !== 'string' || config.translatorUrl === '') {
          notes.push('translator=http 但没配 translatorUrl')
        } else {
          // 只报配置就绪，不做真实探测：多数端侧翻译端点只接受 POST，
          // 用 GET 去探反而会误报失败。真正的失败会在第一句话时暴露出来。
          translateOk = true
          notes.push('翻译后端：HTTP 端点 ' + config.translatorUrl + '（未探测，首句即验证）')
        }
      } else {
        const llm = ctx.get('llm')
        if (llm === undefined) {
          notes.push("ctx 里没有 llm 服务。如果翻译在别处做，把 config.translator 设成 'http' 或 'none'")
        } else {
          const route = await resolveRoute(llm)
          translateOk = route.ok === true
          if (route.ok === true) notes.push('翻译路由：' + route.providerId + '/' + route.modelId)
          else notes.push(route.failure)
        }
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

      // 校对（第二遍）：只报状态，不作为自检成败的判据 ——
      // 它是个"锦上添花"的环节，坏了不该让整条链路报 FAIL。
      if (proofreadWanted() === false) {
        notes.push(config.proofread === 'off'
          ? '校对：关闭（config.proofread = off）'
          : '校对：已被手机侧设置关闭（settings.json 的 proofread=false）')
      } else if (proofreadUnavailable) {
        notes.push('校对：已自动关闭 —— ' + (state.proofread.lastNote || '没有可用的 llm 服务'))
      } else {
        const stats = state.proofread
        notes.push('校对：' + config.proofread + '（空闲时做）· 排队 ' + proofreadQueue.length
          + ' 句 · 已改 ' + stats.fixed + ' 句 · 判定无需改 ' + stats.same
          + ' 句 · 丢弃 ' + stats.dropped + ' 句 · 没通过验收 ' + stats.rejected
          + ' 句 · 失败 ' + stats.failed + ' 次'
          + (stats.lastNote === null ? '' : ' · 最近：' + stats.lastNote))
      }

      return {
        ok: layout && transportOk && detect && translateOk && inboxOk !== false,
        layout,
        transportOk,
        detect,
        translate: translateOk,
        inbox: inboxOk,
        proofread: proofreadWanted() === false
          ? null
          : Object.assign({ mode: config.proofread, runtime: runtimeProofread,
            pending: proofreadQueue.length, inFlight: proofreading,
            unavailable: proofreadUnavailable }, state.proofread),
        terms: Object.assign({ mode: config.terms }, state.terms),
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
      // 必须说出来：收件箱起不来的话整个同传是"静默不动"的（外部照样在写，
      // 屏幕上永远没字幕），只记 lastError 的话得到有人想起来去查工具才知道。
      console.log('[leion-pro] ✗ 收件箱没能启动：' + inbox.lastError)
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
        from: { type: 'string', description: "源语种；缺省自动判定。'zh-CN' | 'pt-BR' | 'en-US'" },
        to: { type: 'string', description: "目标语种；缺省用这场会的目标语言（config.targetLang），再缺省取 from 的反向（中↔葡；英语兜底译成中文）" },
        speaker: { type: 'string', description: "这帧归属谁；只在 translator='none'（不翻译）时起作用", enum: ['them', 'me'] },
      },
      outputSchemaDsl: outputSchema({
        from: { type: 'string' },
        to: { type: 'string' },
        source: { type: 'string' },
        translation: { type: 'string' },
        displaySpeaker: { type: 'string' },
        model: { type: 'string' },
        forced: { type: 'boolean' },
        translated: { type: 'boolean' },
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
