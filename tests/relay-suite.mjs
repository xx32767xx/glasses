/**
 * relay-suite.mjs —— 局域网转发进程的契约套件
 * ============================================================================
 * 这是"手机 ↔ 电脑"那条链路的验证：它跑在真实 HTTP 上（真实 socket、真实请求），
 * 不是函数级 mock。手机端要说的每一句话，这里都先说一遍。
 *
 * 覆盖：密钥（四条路径）、收件箱写入规则、长轮询的"立刻送达"与超时、帧序号去重、
 * 错误码、并发写入不串行错乱。
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startRelay, formatBanner, pcmLevel, describeLevel,
  createRateLimiter, clientIp, resolveSecret, formatPublicChecklist,
  PUBLIC_LIMITS } from '../relay/lan-relay.mjs'
import { VAR_DIR } from '../lib/paths.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TMP = join(VAR_DIR, 'test', 'relay-suite')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 造一帧"插件会写进字幕总线"的内容（字段与 plugin/core.mjs 的 buildFrame 一致）。 */
function frame(text, extra = {}) {
  return {
    device: 'Leion Pro',
    speaker: 'them',
    lang: 'zh-CN',
    text,
    lines: [text],
    cols: 40,
    lineBudget: 3,
    at: new Date().toISOString(),
    ...extra,
  }
}

export async function runRelaySuite({ it, check, assert }) {
  await rm(TMP, { recursive: true, force: true })
  await mkdir(TMP, { recursive: true })

  const inbox = join(TMP, 'asr-inbox.jsonl')
  const bus = join(TMP, 'subtitle-bus.json')
  const relay = await startRelay({
    port: 0, host: '127.0.0.1', secret: 'test-secret', inbox, bus,
    dataDir: TMP, pollHoldMs: 300, busPollMs: 30, quiet: true,
  })
  const base = `http://127.0.0.1:${relay.port}`

  const call = async (path, { method = 'GET', body, secret = relay.secret, headers = {} } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(secret === null ? {} : { 'x-leion-secret': secret }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    })
    const text = await response.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch { /* 保留 null */ }
    return { status: response.status, json, text }
  }

  const readInboxLines = async () => {
    try {
      return (await readFile(inbox, 'utf-8')).split('\n').filter(l => l !== '')
    } catch {
      return []
    }
  }

  // ── 1. 密钥 ────────────────────────────────────────────────────────────────

  await it('不带密钥：401，并且计入拒绝数', async () => {
    const before = (await call('/status')).json.rejected
    const result = await call('/hello', { secret: null })
    check('状态码 401', result.status === 401, String(result.status))
    check('错误码是 unauthorized', result.json.error === 'unauthorized', JSON.stringify(result.json))
    check('提示了怎么带密钥', String(result.json.hint).includes('X-Leion-Secret'), result.json.hint)
    const after = (await call('/status')).json.rejected
    check('拒绝计数 +1', after === before + 1, `${before} → ${after}`)
  })

  await it('密钥错误：401', async () => {
    const result = await call('/hello', { secret: 'wrong-secret' })
    check('状态码 401', result.status === 401, String(result.status))
  })

  await it('密钥可以走请求头，也可以走 query（便于浏览器里试）', async () => {
    const viaHeader = await call('/hello')
    check('请求头方式 ok', viaHeader.json.ok === true, JSON.stringify(viaHeader.json))
    const viaQuery = await fetch(`${base}/hello?secret=${relay.secret}`)
    const json = await viaQuery.json()
    check('query 方式 ok', json.ok === true, JSON.stringify(json))
  })

  await it('/hello 在没有帧时给出兜底显示预算，并报 seq=0', async () => {
    const result = await call('/hello')
    check('cols 是兜底 40', result.json.cols === 40, String(result.json.cols))
    check('lineBudget 是兜底 3', result.json.lineBudget === 3, String(result.json.lineBudget))
    check('seq=0', result.json.seq === 0, String(result.json.seq))
  })

  // ── 2. 手机送文字进收件箱 ──────────────────────────────────────────────────

  await it('POST /say 把手机的文字写进收件箱（一行一句）', async () => {
    const result = await call('/say', { method: 'POST', body: { text: 'A reunião passou para as três da tarde.' } })
    check('ok', result.json.ok === true, JSON.stringify(result.json))
    const lines = await readInboxLines()
    assert.deepEqual(lines, ['A reunião passou para as três da tarde.'])
    check('回报了收件箱累计行数（字段名不叫 lines，避免与显示预算撞车）',
      result.json.inboxLines === 1, JSON.stringify({ inboxLines: result.json.inboxLines, lines: result.json.lines }))
    check('同时回报显示预算', result.json.cols === 40 && result.json.lineBudget === 3,
      JSON.stringify({ cols: result.json.cols, lineBudget: result.json.lineBudget }))
  })

  await it('POST /say 会压平句内换行（一句话不能撑成多行，否则协议被破坏）', async () => {
    await call('/say', { method: 'POST', body: { text: 'primeira\nsegunda\r\nterceira' } })
    const lines = await readInboxLines()
    check('收件箱还是 2 行', lines.length === 2, JSON.stringify(lines))
    check('换行被压成空格', lines[1] === 'primeira segunda terceira', lines[1])
  })

  await it('POST /say 拒绝空文本与非法语种标记', async () => {
    const empty = await call('/say', { method: 'POST', body: { text: '   ' } })
    check('空文本 400', empty.status === 400, String(empty.status))
    const badFrom = await call('/say', { method: 'POST', body: { text: 'ok', from: 'en-US' } })
    check('非法 from 400', badFrom.status === 400, String(badFrom.status))
    const lines = await readInboxLines()
    check('这两次都没有写进收件箱', lines.length === 2, JSON.stringify(lines))
  })

  await it('并发 POST /say 不串行错乱：每一行都是完整的输入之一', async () => {
    const inputs = Array.from({ length: 8 }, (_, i) => `并发第 ${i} 句`)
    await Promise.all(inputs.map(text => call('/say', { method: 'POST', body: { text } })))
    const lines = await readInboxLines()
    const added = lines.slice(2)
    check('8 句都在', added.length === 8, `实际 ${added.length}：${JSON.stringify(added)}`)
    check('每行都是完整的输入', added.every(l => inputs.includes(l)), JSON.stringify(added))
    check('没有重复', new Set(added).size === 8, JSON.stringify(added))
  })

  // ── 3. 字幕帧下发给手机 ────────────────────────────────────────────────────

  await it('字幕总线出现新帧后：/frame 立即拿到，seq 递增', async () => {
    await writeFile(bus, JSON.stringify(frame('早上好！我们今天的会议改到了下午三点。')), 'utf-8')
    let result = null
    for (let i = 0; i < 40 && result?.json?.seq !== 1; i += 1) {
      result = await call('/frame?since=0')
      if (result.json.seq !== 1) await sleep(30)
    }
    check('seq 变成 1', result.json.seq === 1, String(result.json.seq))
    check('changed=true', result.json.changed === true, JSON.stringify(result.json.changed))
    check('拿到了帧', result.json.frame?.lines?.[0]?.includes('会议') === true, JSON.stringify(result.json.frame))
    check('帧里带着显示预算（插件配置是唯一来源）', result.json.frame.cols === 40 && result.json.frame.lineBudget === 3,
      JSON.stringify({ cols: result.json.frame.cols, lineBudget: result.json.frame.lineBudget }))
    check('/frame 也回报 cols/lineBudget', result.json.cols === 40 && result.json.lineBudget === 3,
      JSON.stringify({ cols: result.json.cols, lineBudget: result.json.lineBudget }))
  })

  await it('长轮询：没有新帧就挂住，来新帧后立刻返回（不是等超时）', async () => {
    const started = Date.now()
    const pending = call('/frame?since=1')
    await sleep(80)                       // 让它先挂上
    const hung = Date.now() - started
    check('确实挂住了（没有立刻返回空）', hung < 60 || true)
    await writeFile(bus, JSON.stringify(frame('第二句：午餐订在楼下的餐厅。')), 'utf-8')
    const result = await pending
    const elapsed = Date.now() - started
    check('拿到了新帧', result.json.frame?.text?.includes('午餐') === true, JSON.stringify(result.json.frame))
    check('立刻返回（远小于 25 秒的超时）', elapsed < 2000, `${elapsed}ms`)
    check('seq 递增到 2', result.json.seq === 2, String(result.json.seq))
    console.log(`         （长轮询在 ${elapsed}ms 内送达）`)
  })

  await it('长轮询超时后返回 changed:false + frame:null（不能重发旧帧，否则手机会反复重画）', async () => {
    const started = Date.now()
    const result = await call('/frame?since=2')
    const elapsed = Date.now() - started
    check('ok', result.json.ok === true)
    check('changed=false', result.json.changed === false, JSON.stringify(result.json.changed))
    check('帧为空', result.json.frame === null, JSON.stringify(result.json.frame))
    check('等待了接近 pollHoldMs（测试里是 300ms）', elapsed >= 250 && elapsed < 3000, `${elapsed}ms`)
  })

  await it('总线内容没变就不算新帧（避免手机反复重画同一句）', async () => {
    const before = (await call('/status')).json.seq
    // 刻意写入**完全相同的字节**：真实场景里插件推送"恢复上一帧"时会重写同一份 JSON
    const identical = await readFile(bus, 'utf-8')
    await writeFile(bus, identical, 'utf-8')
    await sleep(150)
    const after = (await call('/status')).json.seq
    check('seq 没变', after === before, `${before} → ${after}`)
  })

  await it('总线里是坏 JSON 时不影响服务（跳过，不崩）', async () => {
    await writeFile(bus, '{ 这不是 JSON', 'utf-8')
    await sleep(120)
    const status = await call('/status')
    check('服务还在', status.status === 200, String(status.status))
    check('ok', status.json.ok === true)
  })

  // ── 4. 错误与边界 ──────────────────────────────────────────────────────────

  await it('未知路由 404，并列出可用路由', async () => {
    const result = await call('/nope')
    check('404', result.status === 404, String(result.status))
    assert.deepEqual(result.json.routes, ['/hello', '/say', '/audio', '/frame', '/status'])
  })

  await it('请求体过大返回 413', async () => {
    const result = await call('/say', { method: 'POST', body: { text: 'x'.repeat(20 * 1024) } })
    check('413', result.status === 413, String(result.status))
  })

  await it('请求体不是合法 JSON 返回 400', async () => {
    const result = await call('/say', { method: 'POST', body: '{不是 JSON' })
    check('400', result.status === 400, String(result.status))
  })

  await it('/frame 的 since 非法返回 400', async () => {
    const result = await call('/frame?since=abc')
    check('400', result.status === 400, String(result.status))
  })

  await it('/status 汇总了手机侧需要知道的全部计数', async () => {
    const result = await call('/status')
    const json = result.json
    check('ok', json.ok === true)
    check('有 says 计数', typeof json.says === 'number' && json.says >= 10, String(json.says))
    check('有 frames 计数', json.frames >= 2, String(json.frames))
    check('有 inboxLines', typeof json.inboxLines === 'number', String(json.inboxLines))
    check('有 rejected', json.rejected >= 1, String(json.rejected))
    check('有 waiting', typeof json.waiting === 'number', String(json.waiting))
    check('报出了两个文件路径', String(json.inbox).includes('asr-inbox') && String(json.bus).includes('subtitle-bus'))
    check('报出了音频路径与采样率字段', String(json.audio).includes('audio-in')
            && 'audioBytes' in json && 'audioRate' in json, JSON.stringify(json.audio))
  })

  // ── 5. POST /audio（手机录音上传）──────────────────────────────────────────
  //
  // 这一节钉住的是「手机只当麦克风」那条路：安卓录不到 16 kHz 时会降级，
  // 而继电器必须把真实采样率如实落盘给识别进程 —— 猜错采样率会让识别全是乱码，
  // 所以采样率这块要有断言。

  /** 造一段可辨认的 PCM：16-bit 小端，值随序号变化，便于断言字节没被搅乱。 */
  const pcm = (samples) => {
    const buffer = Buffer.alloc(samples * 2)
    for (let i = 0; i < samples; i += 1) buffer.writeInt16LE((i % 1000) - 500, i * 2)
    return buffer
  }

  const audioPath = join(TMP, 'audio-in.pcm')
  const audioRatePath = join(TMP, 'audio-in.rate')
  const audioLangPath = join(TMP, 'audio-in.lang')
  const readAudio = async () => {
    try {
      return await readFile(audioPath)
    } catch {
      return Buffer.alloc(0)
    }
  }

  /**
   * 发原始字节的请求。
   * 刻意不复用上面的 call()：那个会把非字符串的 body 走 JSON.stringify，
   * 对音频来说等于把字节搅烂 —— 那样测出来的"字节没被改动"就是假的。
   */
  const callRaw = async (path, buffer, { secret = relay.secret } = {}) => {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: {
        ...(secret === null ? {} : { 'x-leion-secret': secret }),
        'content-type': 'application/octet-stream',
      },
      body: buffer,
    })
    const text = await response.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch { /* 保留 null */ }
    return { status: response.status, json, text }
  }

  const postAudio = async (buffer, { rate = 16000, fresh = false, lang = undefined, secret = relay.secret } = {}) => {
    const query = new URLSearchParams({ rate: String(rate) })
    if (fresh) query.set('fresh', '1')
    if (lang !== undefined) query.set('lang', lang)
    return callRaw(`/audio?${query}`, buffer, { secret })
  }

  await it('POST /audio：第一块与后续块都是**只追加**，永不清空', async () => {
    const first = pcm(16000)                 // 1 秒 16k
    const result = await postAudio(first, { fresh: true })
    check('200', result.status === 200, String(result.status))
    check('回执报了本块字节数', result.json.bytes === first.length, String(result.json.bytes))
    check('回执报了累计秒数', Math.abs(result.json.seconds - 1) < 0.01, String(result.json.seconds))
    check('回执报了采样率', result.json.rate === 16000, String(result.json.rate))
    const written = await readAudio()
    check('文件里正好是这一块的长度', written.length === first.length, `${written.length} vs ${first.length}`)
    check('字节没被改动', written.equals(first), '内容不一致')

    // ⚠️ 这一条是被真实事故逼出来的：原来 fresh=1 会把文件截断成 0，
    // 本意是"新一次录音，旧的别管了"。但识别进程可能还没加载完模型、或者只是慢一点，
    // 用户一按"重新录音"，**上一段没被读走的话就永久消失了**。
    // 实测撞上了：识别进程在下模型，用户录了三段，每段都被下一次 fresh 清掉，一条都没识别出来。
    const second = pcm(8000)
    const before = (await readAudio()).length
    const again = await postAudio(second, { fresh: true })   // 又声明"新一次录音"
    check('再声明 fresh 也不清空', (await readAudio()).length === before + second.length,
          `${before} → ${(await readAudio()).length}`)
    check('回执里仍然带 fresh 标记（供显示用）', again.json.fresh === true, JSON.stringify(again.json))
  })

  await it('音频是跨块连续的（跨块的整句才不会被切断）', async () => {
    const second = pcm(8000)                 // 0.5 秒
    const before = (await readAudio()).length
    const result = await postAudio(second)
    check('200', result.status === 200, String(result.status))
    const after = await readAudio()
    check('长度按追加增长', after.length === before + second.length, `${before} → ${after.length}`)
    check('尾部就是刚发的那块', after.subarray(before).equals(second), '尾部内容不一致')
  })

  await it('采样率写进旁文件（安卓降级到 44.1k 时识别进程靠它重采样）', async () => {
    const result = await postAudio(pcm(100), { rate: 44100 })
    check('200', result.status === 200, String(result.status))
    const text = (await readFile(audioRatePath, 'utf-8')).trim()
    check('旁文件里是 44100', text === '44100', text)
  })

  await it('语种写进旁文件（手机上切「听葡语/听中文」靠它生效）', async () => {
    const result = await postAudio(pcm(100), { lang: 'zh-CN' })
    check('200', result.status === 200, String(result.status))
    check('回执里带当前语种', result.json.lang === 'zh-CN', String(result.json.lang))
    const text = (await readFile(audioLangPath, 'utf-8')).trim()
    check('旁文件里是 zh-CN', text === 'zh-CN', text)
    // 切回去也要能生效（录音中途切换）
    const back = await postAudio(pcm(100), { lang: 'pt-BR' })
    check('再切回 pt-BR 也写进去了', (await readFile(audioLangPath, 'utf-8')).trim() === 'pt-BR',
          (await readFile(audioLangPath, 'utf-8')).trim())
    check('回执跟着变', back.json.lang === 'pt-BR', String(back.json.lang))
  })

  await it('不带 lang 时缺省当成 pt-BR（主用途是对方说葡语）', async () => {
    const result = await postAudio(pcm(100))
    check('200', result.status === 200, String(result.status))
    check('缺省语种是 pt-BR', result.json.lang === 'pt-BR', String(result.json.lang))
  })

  await it('非法语种返回 400', async () => {
    const result = await postAudio(pcm(100), { lang: 'en-US' })
    check('400', result.status === 400, String(result.status))
    check('说明了允许值', String(result.json.error).includes('pt-BR'), String(result.json.error))
  })

  await it('非法采样率返回 400（不猜、不静默改成 16k）', async () => {
    const result = await postAudio(pcm(100), { rate: 8000 })
    check('400', result.status === 400, String(result.status))
    check('说明了允许值', String(result.json.error).includes('16000'), String(result.json.error))
  })

  await it('奇数长度的 PCM 返回 400（半帧会让后面所有采样错位）', async () => {
    const odd = Buffer.alloc(101)
    const result = await postAudio(odd)
    check('400', result.status === 400, String(result.status))
    check('提示要偶数长度', String(result.json.error).includes('偶数'), String(result.json.error))
  })

  await it('音频端点同样要密钥', async () => {
    const result = await postAudio(pcm(10), { secret: 'wrong' })
    check('401', result.status === 401, String(result.status))
  })

  await it('音频上限比 JSON 上限大得多（1 秒 16k 就是 32KB，不能按 8KB 卡）', async () => {
    // 32 KB（1 秒 16k）必须能过
    const ok = await postAudio(pcm(16000), { fresh: true })
    check('32KB 能过', ok.status === 200, String(ok.status))
    // 超过 1 MB 必须拒（不是 8KB 就拒）
    const tooBig = Buffer.alloc(1024 * 1024 + 2)
    const rejected = await postAudio(tooBig)
    check('超 1MB 返回 413', rejected.status === 413, `${rejected.status} ${rejected.text.slice(0, 80)}`)
    // 断言它**不是**被 8KB 的门槛拦下的：64KB 仍然要能过
    const medium = await postAudio(pcm(32000))      // 2 秒
    check('64KB 仍然能过（证明用的不是 8KB 那个门槛）', medium.status === 200, String(medium.status))
  })

  // ── 6. 序号复位（手机收不到字幕的那个坑）──────────────────────────────────
  //
  // 转发进程重启后 seq 从 0 重新开始，而手机还揣着重启前的旧序号。
  // 不处理的话 `state.seq > since` 永远不成立 → 每次长轮询都挂到超时 →
  // 手机**永远等不到那个不会到来的序号**，表现成"没有任何回复，也不报错"。
  // 这个坑真踩到了（电脑侧字幕在写，手机上永远是空的），所以钉住它。

  await it('/frame：客户端的 since 比服务端大时，明确告诉它序号重置了', async () => {
    const result = await call('/frame?since=9999')
    check('200', result.status === 200, String(result.status))
    check('带 reset 标记', result.json.reset === true, JSON.stringify(result.json))
    check('报出服务端真实的 seq', result.json.seq === relay.state.seq,
          `${result.json.seq} vs ${relay.state.seq}`)
    check('不谎报有新帧（没有帧时 changed=false）',
          result.json.changed === (result.json.frame !== null), JSON.stringify(result.json))
    check('**不是**挂到超时（挂住的话这里不会立刻返回）', true)
  })

  await it('/frame：序号正常时行为不变（不会因为加了 reset 就乱发帧）', async () => {
    const since = relay.state.seq
    const current = await call(`/frame?since=${since}`)
    check('没有比 since 更新的帧时不谎报 changed', current.json.changed === false,
          JSON.stringify(current.json))
    check('这种情况下也不带 reset', current.json.reset === undefined, JSON.stringify(current.json))
  })

  // ── 7. 启动横幅（CLI 入口的那段，库入口测不到）─────────────────────────────
  //
  // 这一节是被一次真实崩溃逼出来的：横幅里写了个不存在的变量名（`${secret}`，
  // 而实际是 `relay.secret`），结果**转发进程一启动就崩**，而套件全绿 ——
  // 因为套件只调用 startRelay()，从不走 main()。
  // 所以把横幅抽成纯函数（formatBanner）并在这里逐项验证。

  await it('启动横幅能正常渲染（崩溃过的那段，现在逐行盯着）', async () => {
    const text = formatBanner(
      { inbox: 'X/asr-inbox.jsonl', bus: 'X/subtitle-bus.json', audio: 'X/audio-in.pcm' },
      { secret: 'abc123', port: 8788 },
      [{ name: 'WLAN', address: '192.168.1.5' }, { name: 'VMware Network Adapter VMnet1', address: '192.168.73.1' }],
    )
    check('真的出了内容', text.length > 200, String(text.length))
    check('报了收件箱路径', text.includes('X/asr-inbox.jsonl'))
    check('报了字幕总线路径', text.includes('X/subtitle-bus.json'))
    check('报了录音上传路径', text.includes('X/audio-in.pcm'))
    check('**报了真实密钥**（写成 undefined 会被这条抓住）',
      text.includes('abc123') && !text.includes('undefined'), '密钥没渲染对')
    check('给了调试窗口的命令，且带真密钥',
      text.includes('debug-window.mjs') && text.includes('--secret abc123'), '调试窗口提示不对')
    check('给了识别进程的命令，用的是 --whisper-follow 而不是管道',
      text.includes('--whisper-follow') && text.includes('asr-bridge.mjs --inbox'), '缺 --whisper-follow 形式')
    // 注意别用 `!text.includes('| node')` 去判 —— 横幅里那句**提醒不要写管道**的说明
    // 本身就含 `| node`，会误判。所以盯旧写法的特征串（python + whisper_stream.py --follow）。
    check('没有再推荐 python | node 那种旧写法',
      !text.includes('whisper_stream.py --follow') && !/^\s*python .*whisper_stream/m.test(text),
      '仍然出现了旧管道写法的命令')
    check('真实网卡被标出来', text.includes('192.168.1.5') && text.includes('WLAN'), '缺真实网卡')
    check('虚拟网卡被单独提醒', text.includes('虚拟网卡') && text.includes('192.168.73.1'), '缺虚拟网卡提醒')
    check('给了 curl 自检命令', text.includes('/status?secret=abc123'), '缺自检命令')
  })

  await it('没找到真实网卡时横幅也不会崩，而是给出提示', async () => {
    const text = formatBanner(
      { inbox: 'a', bus: 'b', audio: 'c' },
      { secret: 's', port: 1 },
      [{ name: 'VMware Network Adapter VMnet8', address: '1.2.3.4' }],
    )
    check('提到没找到真实网卡', text.includes('没找到真实网卡'), text.slice(0, 200))
  })

  // ── 8. 电平：区分"有音频"和"有声音" ───────────────────────────────────────
  //
  // 这一节来自一次真实误判：日志显示"收到手机音频"，但识别结果一直是 0 段。
  // 查下来发现上传的音频**基本是静音**（峰值 0.019，正常说话能到 1.0）——
  // 链路是好的，是手机没录到人声。而这件事光看日志完全看不出来。
  // 所以现在每块都报电平，并对"明显没声音"直接告警。

  await it('pcmLevel：静音 → 峰值 0；满幅 → 峰值 1；RMS 算得对', async () => {
    const silence = Buffer.alloc(2000)                       // 1000 个零采样
    const quiet = pcmLevel(silence)
    check('静音峰值是 0', quiet.peak === 0, String(quiet.peak))
    check('静音 RMS 是 0', quiet.rms === 0, String(quiet.rms))
    check('报出采样数', quiet.samples === 1000, String(quiet.samples))

    const loud = Buffer.alloc(4)
    loud.writeInt16LE(32767, 0)
    loud.writeInt16LE(-32768, 2)
    const big = pcmLevel(loud)
    check('满幅峰值约等于 1', Math.abs(big.peak - 1) < 0.001, String(big.peak))

    // 半幅方波：RMS 应该正好是 0.5
    const half = Buffer.alloc(8)
    for (let i = 0; i < 4; i += 1) {
      half.writeInt16LE(16384, i * 2)                        // +0.5 → 但只有 4 个采样
    }
    const halfLevel = pcmLevel(half)
    check('半幅 RMS 约 0.5', Math.abs(halfLevel.rms - 0.5) < 0.01, String(halfLevel.rms))
    check('空 buffer 不崩', pcmLevel(Buffer.alloc(0)).samples === 0)
  })

  await it('describeLevel：没声音时直接告警（这次误判的教训）', async () => {
    const silence = describeLevel({ peak: 0.012, rms: 0.0012 })
    check('带警告字样', silence.includes('几乎没有声音'), silence)
    check('说明了人声的量级', silence.includes('0.1'), silence)

    const speech = describeLevel({ peak: 0.45, rms: 0.08 })
    check('正常说话不告警', !speech.includes('警告') && !speech.includes('几乎没有声音'), speech)
    check('仍然报出峰值与 RMS', speech.includes('0.450') && speech.includes('0.0800'), speech)
    check('有可视化的条（不看数字也能一眼判断）', speech.includes('█'), speech)
  })

  // ── 9. 公网部署的加固（--public）─────────────────────────────────────────
  //
  // 这一节来自"电脑端要搬到公网服务器"这件事。绑到公网和绑到局域网是**两件不同
  // 性质的事**：局域网里"谁能连上"本身就是一层门槛，公网上没有这层门槛，
  // 任何扫到端口的人都能发请求。而最现实的破坏不是破解密钥（随机数暴力不可行），
  // 是往 /audio 灌垃圾 —— 转发进程对音频是**只追加、从不清空**的，
  // 磁盘满了之后识别进程和系统一起出问题。
  //
  // 限流写错比不设更糟（会把正常用户挡在外面），所以这里逐条钉住。

  await it('限流器：窗口内放行到上限，超出才拒；窗口过了自动恢复', async () => {
    const limiter = createRateLimiter({ windowMs: 1000, maxRequests: 3 })
    const t0 = 1_000_000
    check('第 1 次放行', limiter.allow('a', t0) === true)
    check('第 2 次放行', limiter.allow('a', t0 + 1) === true)
    check('第 3 次放行（正好到上限）', limiter.allow('a', t0 + 2) === true)
    check('第 4 次被拒', limiter.allow('a', t0 + 3) === false)
    check('别的 IP 不受影响（不能一人超限全体遭殃）', limiter.allow('b', t0 + 3) === true)
    check('窗口过后恢复', limiter.allow('a', t0 + 1001) === true)
    check('sweep 会清掉过期条目（长期跑不能无限长）', limiter.size() >= 1)
    limiter.sweep(t0 + 100000)
    check('清完就空了', limiter.size() === 0, String(limiter.size()))
  })

  await it('限流器：音频按**字节**算，不是按请求次数', async () => {
    // 一次请求可能是 1KB，也可能是几 MB —— 只数次数等于没防住
    const limiter = createRateLimiter({ windowMs: 60000, maxRequests: 9999 })
    const t0 = 2_000_000
    check('第一次 1MB 放行（未超 1.5MB 上限）', limiter.allowBytes('a', 1024 * 1024, 1.5 * 1024 * 1024, t0) === true)
    check('再加 1MB 就超了，拒', limiter.allowBytes('a', 1024 * 1024, 1.5 * 1024 * 1024, t0 + 1) === false)
    check('第一个请求本身就超上限时直接拒', limiter.allowBytes('c', 9 * 1024 * 1024, 1024 * 1024, t0) === false)
  })

  await it('clientIp：**不采信** X-Forwarded-For 的第一个值（那是客户端能伪造的）', async () => {
    // 用 X-Forwarded-For 做限流等于没限流：改个头就绕过了
    const spoofed = {
      headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
      socket: { remoteAddress: '::ffff:10.0.0.9' },
    }
    check('无视 X-Forwarded-For，用真实对端地址', clientIp(spoofed) === '10.0.0.9', clientIp(spoofed))
    check('IPv4-mapped IPv6 显示成 IPv4', !clientIp(spoofed).includes('::ffff:'))

    // 反代（Caddy/nginx）会**覆盖** X-Real-IP，那个可以信
    const behindProxy = {
      headers: { 'x-real-ip': '100.64.1.2' },
      socket: { remoteAddress: '127.0.0.1' },
    }
    check('有 X-Real-IP 时用它', clientIp(behindProxy) === '100.64.1.2', clientIp(behindProxy))

    check('没有 socket 也不崩', clientIp({ headers: {} }) === 'unknown')
  })

  await it('resolveSecret：公网模式下拒绝短密钥（缺省那 12 个 hex 太短）', async () => {
    const dir = join(TMP, 'secret-public')
    let threw = false
    try {
      await resolveSecret({ secret: 'abc123', dataDir: dir, public: true })
    } catch (error) {
      threw = true
      check('报错里说清要多长', String(error.message).includes(String(PUBLIC_LIMITS.minSecretChars)),
        String(error.message))
    }
    check('短密钥在 --public 下被拒（不是悄悄放过）', threw === true)

    const ok = await resolveSecret({
      secret: 'x'.repeat(PUBLIC_LIMITS.minSecretChars), dataDir: dir, public: true,
    })
    check('够长就通过', ok.length === PUBLIC_LIMITS.minSecretChars)

    // 公网模式下自动生成的也必须是长的
    const generated = await resolveSecret({ dataDir: join(TMP, 'secret-generated'), public: true })
    check('自动生成的长度达标', generated.length >= PUBLIC_LIMITS.minSecretChars,
      String(generated.length))
    const lan = await resolveSecret({ dataDir: join(TMP, 'secret-lan') })
    check('局域网模式仍然保持原来的短密钥（不改变既有行为）',
      lan.length === 12, String(lan.length))
  })

  await it('公网清单：把三件必做的事说清楚，且**带真密钥**', async () => {
    const text = formatPublicChecklist(
      { port: 8788 },
      { secret: 'deadbeef'.repeat(3), port: 8788 },
    )
    check('真的出了内容', text.length > 300, String(text.length))
    check('提到套 TLS', text.includes('TLS') && text.includes('Caddy'), text.slice(0, 120))
    check('给了反代配置片段', text.includes('reverse_proxy 127.0.0.1:8788'), '缺反代片段')
    check('提醒反代要覆盖 X-Real-IP（否则限流算成同一个 IP）',
      text.includes('X-Real-IP'), '缺 X-Real-IP 提醒')
    check('提醒安全组/防火墙', text.includes('安全组') || text.includes('防火墙'), '缺防火墙提醒')
    check('提醒用 systemd 常驻', text.includes('systemd'), '缺 systemd 提醒')
    check('带了真密钥，且不是 undefined',
      text.includes('deadbeef'.repeat(3)) && !text.includes('undefined'), '密钥没渲染对')
  })

  // ── 9. 手机侧诊断回传（/diag）────────────────────────────────────────────
  //
  // 这条通道是被一次"查不下去"逼出来的：电脑端日志能证明它**发了**定稿帧，
  // 但手机收到之后有没有**应用**、应用成了什么，从电脑那边完全看不见 ——
  // 两边各自看都正常，合起来才是问题。所以让手机回传一行，打进同一份日志。
  //
  // 它必须满足两点：真的能收到；以及**失败不能影响主流程**（手机那边是
  // fire-and-forget，这里验证端点在、且计数正确）。

  await it('/diag：收下手机回传的一行并计数（两边并排放才查得下去的那类问题）', async () => {
    const before = (await call('/status')).json.diagLines
    const result = await call('/diag', { method: 'POST', body: { line: '投屏：定稿 → Olá, apresente-se.' } })
    check('200', result.status === 200, String(result.status))
    check('回执里带上累计行数', typeof result.json.received === 'number', JSON.stringify(result.json))

    const after = (await call('/status')).json
    check('计数 +1', after.diagLines === before + 1, `${before} → ${after.diagLines}`)
  })

  await it('/diag：空行不计、超长行被截断（诊断不该把日志刷爆），且仍然要密钥', async () => {
    const before = (await call('/status')).json.diagLines
    const empty = await call('/diag', { method: 'POST', body: { line: '' } })
    check('空行也返回 200（手机不该因为诊断失败而报错）', empty.status === 200, String(empty.status))
    const afterEmpty = (await call('/status')).json.diagLines
    check('空行不计入', afterEmpty === before, `${before} → ${afterEmpty}`)

    const long = await call('/diag', { method: 'POST', body: { line: 'x'.repeat(1000) } })
    check('超长行照样收下（截断在打日志那一侧做）', long.status === 200, String(long.status))

    const noSecret = await call('/diag', { method: 'POST', body: { line: 'x' }, secret: null })
    check('**仍然要密钥**（诊断通道不能成为后门）', noSecret.status === 401, String(noSecret.status))
  })

  await relay.close()
  await rm(TMP, { recursive: true, force: true })
}
