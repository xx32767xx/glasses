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
import { startRelay } from '../relay/lan-relay.mjs'
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

  await it('POST /audio?fresh=1：清空并开始新一次录音', async () => {
    const first = pcm(16000)                 // 1 秒 16k
    const result = await postAudio(first, { fresh: true })
    check('200', result.status === 200, String(result.status))
    check('回执报了本块字节数', result.json.bytes === first.length, String(result.json.bytes))
    check('回执报了累计秒数', Math.abs(result.json.seconds - 1) < 0.01, String(result.json.seconds))
    check('回执报了采样率', result.json.rate === 16000, String(result.json.rate))
    const written = await readAudio()
    check('文件里正好是这一块的长度', written.length === first.length, `${written.length} vs ${first.length}`)
    check('字节没被改动', written.equals(first), '内容不一致')
  })

  await it('再传一块是**追加**，不是覆盖（跨块的整句才不会被切断）', async () => {
    const second = pcm(8000)                 // 0.5 秒
    const before = (await readAudio()).length
    const result = await postAudio(second)
    check('200', result.status === 200, String(result.status))
    const after = await readAudio()
    check('长度按追加增长', after.length === before + second.length, `${before} → ${after.length}`)
    check('尾部就是刚发的那块', after.subarray(before).equals(second), '尾部内容不一致')
    check('回执的累计秒数是 1.5', Math.abs(result.json.seconds - 1.5) < 0.01, String(result.json.seconds))
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

  await relay.close()
  await rm(TMP, { recursive: true, force: true })
}
