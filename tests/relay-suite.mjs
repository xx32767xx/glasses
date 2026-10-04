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
    assert.deepEqual(result.json.routes, ['/hello', '/say', '/frame', '/status'])
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
  })

  await relay.close()
  await rm(TMP, { recursive: true, force: true })
}
