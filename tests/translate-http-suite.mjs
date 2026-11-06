/**
 * translate-http-suite.mjs —— `/translate`（给外部调用方的 HTTP 翻译接口，5.125）
 * ============================================================================
 *
 * 这个接口和 `/asr/transcribe`（5.117）是**同一个形状**，风险点也几乎一样：
 *   ① 校验不严 → 别人拿它当批量翻译用（几千字的段落）、传不支持的语种，
 *      表现是"翻得很怪"而不是"参数不对"；
 *   ② 三种结局混在一起 → "源=目标不用翻"、"大脑没跑"、"模型没给译文"都变成同一个超时，
 *      调用方只能瞎猜；
 *   ③ 认错帧 → 总线是**整文件覆盖**的，上一句的译文还躺在里面，
 *      一不留神就把上一次的结果当成本次结果交出去（"看着像对了"的那类 bug）。
 *
 * 所以这里用一个**假大脑**（读收件箱 → 按真实顺序先写 echo 原文帧、再写译文帧）把往返跑一遍，
 * 再用**真 relay** 验一遍路由与鉴权。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { VAR_DIR, apiTranslateBus, apiTranslateInbox } from '../lib/paths.mjs'
import {
  TRANSLATE_HTTP_LIMITS, frameTranslations, normalizeTranslateRequest, parseBusFrame, translateOnce,
} from '../lib/translate-http.mjs'
import { apiStep, apiTranslateFiles, parseArgs as parseStartMulti, prepareApiTranslateFiles } from '../scripts/start-multi.mjs'
import { startRelay } from '../relay/lan-relay.mjs'

const BASE = join(VAR_DIR, 'test', 'translate-http-suite')

/**
 * 假大脑：每 `delayMs` 看一次收件箱，把**新行**按真实大脑的顺序处理一遍。
 *
 * <p>真实大脑（`plugin/core.mjs` 的 `pump()`）对一个收件箱项做两件事：
 * 先写一帧 **echo 原文帧**（`source` = 原文、`text` 为空），再写译文帧
 * （带 `texts` / `lang` / `text`，`at` 是新的时间戳）。这里照着做，
 * 因为"接口会不会把 echo 帧当成译文"正是要钉住的东西。
 *
 * @param {string} dataDir
 * @param {{mode?: 'ok'|'echo-only'|'silent'|'partial'|'stale', text?: string}} [opts]
 */
function startFakeBrain(dataDir, opts = {}) {
  const files = apiTranslateFiles(dataDir)
  const mode = opts.mode ?? 'ok'
  const state = { consumed: 0, timer: null, seen: [], stopped: false }

  const writeFrame = (frame) => {
    writeFileSync(files.bus, JSON.stringify({
      device: 'Leion Pro', speaker: 'them', lines: [frame.text ?? ''],
      cols: 40, lineBudget: 3, ...frame,
    }), 'utf-8')
  }

  const tick = () => {
    if (state.stopped) return
    state.timer = setTimeout(tick, opts.delayMs ?? 20)
    let raw = ''
    try {
      raw = readFileSync(files.inbox, 'utf-8')
    } catch {
      return
    }
    const fresh = raw.slice(state.consumed)
    if (fresh === '') return
    // 真实大脑一次只处理**一句**（串行），这里也一次只吃一行：剩下的留到下一轮。
    const firstBreak = fresh.indexOf('\n')
    if (firstBreak < 0) return               // 这一行还没写完
    const line = fresh.slice(0, firstBreak)
    state.consumed += firstBreak + 1
    if (line.trim() === '') return
    let item
    try {
      item = JSON.parse(line)
    } catch {
      return
    }
    state.seen.push(item)
    if (mode === 'silent') return
    writeFrame({ source: item.text, echo: true, lang: item.from, text: '', at: new Date().toISOString() })
    if (mode === 'echo-only') return
    if (mode === 'partial') {
      writeFrame({
        source: item.text, lang: item.to, text: `半截`, sourceLang: item.from,
        partial: true, at: new Date().toISOString(),
      })
    }
    const translated = `[${item.to}] ${item.text}`
    writeFrame({
      source: item.text, lang: item.to, text: translated, sourceLang: item.from,
      texts: { [item.to]: translated }, at: new Date().toISOString(),
    })
  }
  state.timer = setTimeout(tick, opts.delayMs ?? 20)
  state.stop = () => {
    state.stopped = true
    if (state.timer !== null) clearTimeout(state.timer)
  }
  return state
}

export async function runTranslateHttpSuite({ it, check }) {
  console.log('\nHTTP 翻译接口（5.125）：一句文字 → 译文，参数要严、三种结局要分开、不能认错帧')

  await it('请求校验：文字 / 源语种 / 目标语种 / 超时都要能挡住，而且说清哪里不对', () => {
    const missingText = normalizeTranslateRequest({ from: 'zh-CN', to: 'pt-BR' })
    check('缺 text → 明确报错', missingText.ok === false && missingText.error.includes('text'), missingText.error)

    const tooLong = normalizeTranslateRequest({
      text: '长'.repeat(TRANSLATE_HTTP_LIMITS.maxTextChars + 1), from: 'zh-CN', to: 'pt-BR',
    })
    check('超过字数上限 → 报错并说明"这是给一句话用的"',
      tooLong.ok === false && tooLong.error.includes(String(TRANSLATE_HTTP_LIMITS.maxTextChars)),
      tooLong.error)

    const missingFrom = normalizeTranslateRequest({ text: '你好', to: 'pt-BR' })
    check('缺 from → 报错并列出可选语种',
      missingFrom.ok === false && missingFrom.error.includes('from')
      && missingFrom.error.includes('pt-BR'), missingFrom.error)

    const badFrom = normalizeTranslateRequest({ text: '你好', from: 'ja-JP', to: 'pt-BR' })
    check('不支持的源语种 → 报错（不是悄悄按别的语种翻）',
      badFrom.ok === false && badFrom.error.includes('ja-JP'), badFrom.error)

    const missingTo = normalizeTranslateRequest({ text: '你好', from: 'zh-CN' })
    check('缺 to → 报错', missingTo.ok === false && missingTo.error.includes('to'), missingTo.error)

    const badTo = normalizeTranslateRequest({ text: '你好', from: 'zh-CN', to: ['pt-BR', 'xx-YY'] })
    check('目标语种里有一个不认识的 → 报错且点名是哪个',
      badTo.ok === false && badTo.error.includes('xx-YY'), badTo.error)

    const ok = normalizeTranslateRequest({ text: '你好', from: 'zh-CN', to: 'pt-BR' })
    check('正常请求通过：targets 就是 to（源≠目标）',
      ok.ok === true && ok.text === '你好' && ok.from === 'zh-CN'
      && ok.targets.length === 1 && ok.targets[0] === 'pt-BR', JSON.stringify(ok))

    const same = normalizeTranslateRequest({ text: '你好', from: 'zh-CN', to: ['zh-CN'] })
    check('to 与 from 相同 → 通过但 targets 为空（这条不需要翻，不是错）',
      same.ok === true && same.to[0] === 'zh-CN' && same.targets.length === 0, JSON.stringify(same))

    const mixed = normalizeTranslateRequest({ text: '你好', from: 'zh-CN', to: ['zh-CN', 'en-US'] })
    check('to 里混着源语言 → 只翻真正需要的那门（不把源语言也"翻"一遍）',
      mixed.ok === true && mixed.to.length === 2
      && mixed.targets.length === 1 && mixed.targets[0] === 'en-US', JSON.stringify(mixed))

    const three = normalizeTranslateRequest({ text: '你好', from: 'zh-CN', to: ['pt-BR', 'en-US', 'zh-CN'] })
    check('三种语言全传进来 → 拒绝（三种语言下源语言占一种，最多两种目标）',
      three.ok === false && three.error.includes(String(TRANSLATE_HTTP_LIMITS.maxTargets)), three.error)

    const timeout = normalizeTranslateRequest({
      text: '你好', from: 'zh-CN', to: 'pt-BR', timeoutMs: TRANSLATE_HTTP_LIMITS.maxTimeoutMs + 999999,
    })
    check('超时被夹到上限（不让一个请求挂着不放）',
      timeout.ok === true && timeout.timeoutMs === TRANSLATE_HTTP_LIMITS.maxTimeoutMs,
      String(timeout.timeoutMs))

    const badTimeout = normalizeTranslateRequest({ text: '你好', from: 'zh-CN', to: 'pt-BR', timeoutMs: -1 })
    check('非法超时 → 报错', badTimeout.ok === false && badTimeout.error.includes('timeoutMs'), badTimeout.error)

    const arrayBody = normalizeTranslateRequest(['你好'])
    check('请求体不是对象 → 报错', arrayBody.ok === false && arrayBody.error.includes('JSON object'),
      arrayBody.error)
  })

  await it('总线帧：坏内容不抛异常；译文优先取 texts，一帧多种语言也认', () => {
    check('坏 JSON → null（下一轮再来）', parseBusFrame('{ 不是 JSON') === null)
    check('空内容 → null', parseBusFrame('   ') === null)
    check('数组不是帧 → null', parseBusFrame('[1,2,3]') === null)

    const multi = parseBusFrame(JSON.stringify({
      source: 'olá', lang: 'zh-CN', text: '你好', texts: { 'zh-CN': '你好', 'en-US': 'Hello' },
    }))
    check('帧能解析出来', multi !== null && multi.source === 'olá')
    const got = frameTranslations(multi)
    check('一帧两种译文都能取到', got['zh-CN'] === '你好' && got['en-US'] === 'Hello', JSON.stringify(got))

    const single = frameTranslations({ lang: 'pt-BR', text: 'Olá' })
    check('只有 lang+text 的帧也能取到一份', single['pt-BR'] === 'Olá', JSON.stringify(single))
  })

  await it('真实往返：假大脑（先 echo 再译文）→ 接口返回译文，并且不留下垃圾', async () => {
    rmSync(BASE, { recursive: true, force: true })
    prepareApiTranslateFiles(apiTranslateFiles(BASE))
    const brain = startFakeBrain(BASE, { mode: 'ok' })
    try {
      const hit = await translateOnce({ dataDir: BASE }, normalizeTranslateRequest({
        text: 'olá, tudo bem', from: 'pt-BR', to: 'zh-CN',
      }))
      check('译出来了 → 200 且带 translations',
        hit.status === 200 && hit.json.ok === true && hit.json.translated === true
        && hit.json.translations['zh-CN'] === '[zh-CN] olá, tudo bem', JSON.stringify(hit.json))
      check('响应里的 text 是主译文（调用方最常用的那一个字段）',
        hit.json.text === '[zh-CN] olá, tudo bem', hit.json.text)
      check('elapsedMs 是数字（调用方能算延迟）', typeof hit.json.elapsedMs === 'number', String(hit.json.elapsedMs))
      check('假大脑收到的就是那句原文 + 方向',
        brain.seen.length === 1 && brain.seen[0].text === 'olá, tudo bem'
        && brain.seen[0].from === 'pt-BR' && brain.seen[0].to === 'zh-CN', JSON.stringify(brain.seen))

      // 一帧两种语言：一次请求两个目标
      const twice = await translateOnce({ dataDir: BASE }, normalizeTranslateRequest({
        text: 'bom dia', from: 'pt-BR', to: ['zh-CN', 'en-US'],
      }))
      check('两个目标都要：两帧分别回来，translations 里两份都在',
        twice.status === 200 && twice.json.translations['zh-CN'] === '[zh-CN] bom dia'
        && twice.json.translations['en-US'] === '[en-US] bom dia', JSON.stringify(twice.json))
    } finally {
      brain.stop()
    }
  })

  await it('源=目标：如实说"不需要翻译"，而且**不往收件箱写东西**', async () => {
    rmSync(BASE, { recursive: true, force: true })
    prepareApiTranslateFiles(apiTranslateFiles(BASE))
    const inboxBefore = readFileSync(apiTranslateInbox(BASE), 'utf-8')
    const hit = await translateOnce({ dataDir: BASE }, normalizeTranslateRequest({
      text: '你好', from: 'zh-CN', to: 'zh-CN',
    }))
    check('200 + translated:false + 原样回文字',
      hit.status === 200 && hit.json.translated === false && hit.json.text === '你好'
      && hit.json.translations['zh-CN'] === '你好', JSON.stringify(hit.json))
    check('没有往收件箱写任何东西（不调模型、不占大脑）',
      readFileSync(apiTranslateInbox(BASE), 'utf-8') === inboxBefore)
  })

  await it('认错帧的两个来源都要挡住：陈旧帧、echo 原文帧、流式增量帧', async () => {
    rmSync(BASE, { recursive: true, force: true })
    prepareApiTranslateFiles(apiTranslateFiles(BASE))
    const files = apiTranslateFiles(BASE)
    // ① 上一次请求留下的同一句旧译文（总线是整文件覆盖，它会一直在那里）
    writeFileSync(files.bus, JSON.stringify({
      source: 'olá', lang: 'zh-CN', text: '旧译文', sourceLang: 'pt-BR',
      lines: ['旧译文'], at: '2020-01-01T00:00:00.000Z',
    }), 'utf-8')
    const silent = startFakeBrain(BASE, { mode: 'silent' })
    try {
      const stale = await translateOnce({ dataDir: BASE }, normalizeTranslateRequest({
        text: 'olá', from: 'pt-BR', to: 'zh-CN', timeoutMs: 400,
      }))
      check('总线上的旧帧不会被当成本次结果（504，translations 是空的）',
        stale.status === 504 && Object.keys(stale.json.translations ?? {}).length === 0,
        JSON.stringify(stale.json))
      check('而且超时原因说清了"大脑没在消费收件箱"',
        stale.json.error === 'translation-timeout' && String(stale.json.hint).includes('inbox'),
        JSON.stringify(stale.json))
    } finally {
      silent.stop()
    }

    const echoOnly = startFakeBrain(BASE, { mode: 'echo-only' })
    try {
      const echoed = await translateOnce({ dataDir: BASE }, normalizeTranslateRequest({
        text: 'bom dia', from: 'pt-BR', to: 'zh-CN', timeoutMs: 400,
      }))
      check('只收到 echo 原文帧 → 仍然 504（不能把原文当译文交出去）',
        echoed.status === 504 && Object.keys(echoed.json.translations ?? {}).length === 0,
        JSON.stringify(echoed.json))
      check('但提示要说清"大脑收到了、只是没给译文"（两种情况不能混）',
        String(echoed.json.hint).includes('✗ 翻译失败'), JSON.stringify(echoed.json.hint))
    } finally {
      echoOnly.stop()
    }

    const partial = startFakeBrain(BASE, { mode: 'partial' })
    try {
      const streamed = await translateOnce({ dataDir: BASE }, normalizeTranslateRequest({
        text: 'tudo bem', from: 'pt-BR', to: 'zh-CN', timeoutMs: 3000,
      }))
      check('流式增量帧（partial）跳过，等到定稿才收',
        streamed.status === 200 && streamed.json.text === '[zh-CN] tudo bem', JSON.stringify(streamed.json))
    } finally {
      partial.stop()
    }
  })

  await it('大脑没在跑：503 并说清去哪起（不是"超时"这种没法查的说法）', async () => {
    const empty = join(BASE, 'nobody')
    rmSync(empty, { recursive: true, force: true })
    const hit = await translateOnce({ dataDir: empty }, normalizeTranslateRequest({
      text: '你好', from: 'zh-CN', to: 'pt-BR', timeoutMs: 500,
    }))
    check('没有收件箱（大脑没起）→ 503 translator-not-running',
      hit.status === 503 && hit.json.error === 'translator-not-running', JSON.stringify(hit.json))
    check('并且指出去起管线（start-multi 会带起「大脑·API」）',
      String(hit.json.hint).includes('start-multi'), hit.json.hint)
  })

  await it('真 relay 的路由：鉴权 / info / 400 / 503 / 200 走一遍', async () => {
    rmSync(BASE, { recursive: true, force: true })
    mkdirSync(BASE, { recursive: true })
    const relay = await startRelay({
      port: 0, host: '127.0.0.1', secret: 'test-secret', dataDir: BASE, quiet: true, busPollMs: 30,
    })
    const base = `http://127.0.0.1:${relay.port}`
    const call = async (path, { method = 'GET', body, secret = relay.secret } = {}) => {
      const response = await fetch(base + path, {
        method,
        headers: {
          ...(secret === null ? {} : { 'x-leion-secret': secret }),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      })
      const text = await response.text()
      let json = null
      try { json = JSON.parse(text) } catch { /* 保留 null */ }
      return { status: response.status, json, text }
    }
    try {
      const info = await call('/translate/info')
      check('GET /translate/info：语种/限制/端点都在',
        info.status === 200 && info.json.ok === true && info.json.endpoint === 'POST /translate'
        && info.json.from.includes('pt-BR') && info.json.limits.maxTextChars === TRANSLATE_HTTP_LIMITS.maxTextChars,
        JSON.stringify(info.json))
      check('info 里带「大脑·API 起来没有」（running 字段）',
        info.json.pipeline !== undefined && info.json.pipeline.running === false, JSON.stringify(info.json.pipeline))

      const noSecret = await call('/translate', { method: 'POST', body: { text: '你好' }, secret: null })
      check('不带密钥 → 401（与其它端点同一把密钥）', noSecret.status === 401, String(noSecret.status))

      const noBrain = await call('/translate', {
        method: 'POST', body: { text: '你好', from: 'zh-CN', to: 'pt-BR', timeoutMs: 400 },
      })
      check('大脑没起 → 503 translator-not-running',
        noBrain.status === 503 && noBrain.json.error === 'translator-not-running', JSON.stringify(noBrain.json))

      prepareApiTranslateFiles(apiTranslateFiles(BASE))
      const brain = startFakeBrain(BASE, { mode: 'ok' })
      try {
        const bad = await call('/translate', { method: 'POST', body: { from: 'zh-CN', to: 'pt-BR' } })
        check('缺 text → 400（英文、说清缺哪个字段）',
          bad.status === 400 && String(bad.json.error).includes('text'), JSON.stringify(bad.json))

        const hit = await call('/translate', {
          method: 'POST', body: { text: 'hello', from: 'en-US', to: 'zh-CN' },
        })
        check('POST /translate 端到端出译文',
          hit.status === 200 && hit.json.translations['zh-CN'] === '[zh-CN] hello', JSON.stringify(hit.json))
        check('真 relay 也不再报"大脑没起"（info.running 变成 true）',
          (await call('/translate/info')).json.pipeline.running === true)
      } finally {
        brain.stop()
      }
    } finally {
      await relay.close()
    }
  })

  await it('start-multi 起的那个进程：参数指向 api-translate 那对文件，且可以关掉', () => {
    const options = parseStartMulti(['--data-dir', BASE])
    const step = apiStep(options)
    const files = apiTranslateFiles(BASE)
    check('key/role 一眼能认出来（大脑·API）',
      step.key === 'api-brain' && step.role === 'api-brain', `${step.key}/${step.role}`)
    check('收件箱与总线都指向 api-translate/（不是任何一场会的文件）',
      step.args.includes(files.inbox) && step.args.includes(files.bus)
      && files.inbox.includes('api-translate') && files.bus.includes('api-translate'),
      `${files.inbox} / ${files.bus}`)
    check('带 --keep-inbox（收件箱由 start-multi 统一清，免得两次清空之间吞掉第一句）',
      step.args.includes('--keep-inbox'))
    check('不给 --to（方向由外部请求给，不能被"这一场的目标语言"改写）',
      step.args.includes('--to') === false)
    check('缺省是**起**的；--no-api-translate 能关掉',
      parseStartMulti(['--data-dir', BASE]).apiTranslate === true
      && parseStartMulti(['--data-dir', BASE, '--no-api-translate']).apiTranslate === false)

    const prepared = apiTranslateFiles(join(BASE, 'fresh'))
    prepareApiTranslateFiles(prepared)
    check('prepare 会把收件箱建成空文件（否则上一次的行会被重翻一遍）',
      existsSync(prepared.inbox) && readFileSync(prepared.inbox, 'utf-8') === '')
  })

  rmSync(BASE, { recursive: true, force: true })
  check('收尾：不在 var/test 里留下这套的垃圾', existsSync(BASE) === false)
}
