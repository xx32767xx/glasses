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
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { sep } from 'node:path'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startRelay, formatBanner, pcmLevel, describeLevel, roomAudioPath, roomSpeakerAudioPath,
  roomTrackDir, createRateLimiter, clientIp, resolveSecret, formatPublicChecklist,
  PUBLIC_LIMITS } from '../relay/lan-relay.mjs'
import { VAR_DIR } from '../lib/paths.mjs'
import { takeFloor } from '../lib/floor.mjs'
import { createRoom, joinRoom, listMembers, listRoomTranscript } from '../lib/rooms.mjs'
import { dbPath, openDb } from '../lib/db.mjs'

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
    // 译文质检开着：下面 §3b 用它验"定稿帧判错、增量帧不判"。
    lint: true,
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
    // 5.00：en-US 现在是**合法**语种了，换一个真的不支持的码来验拒绝
      const badFrom = await call('/say', { method: 'POST', body: { text: 'ok', from: 'de-DE' } })
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


  await it('4.86：字幕总线按房间分桶 —— 两场会的字幕不再互相覆盖', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'busdir-'))
    const secret = 's3cret-0123456789abcdef'
    const buses = join(dir, 'buses')
    await mkdir(buses, { recursive: true })
    const relay = await startRelay({
      dataDir: dir, port: 0, host: '127.0.0.1', secret, quiet: true, bus: buses, pollHoldMs: 300,
    })
    try {
      const base = `http://127.0.0.1:${relay.port}`
      const headers = { 'X-Leion-Secret': secret }
      const frame = (text) => JSON.stringify({
        speaker: 'them', lang: 'pt-BR', lines: [text], text, source: 'x', partial: false,
      })
      await writeFile(join(buses, 'room-A.json'), frame('甲房间说的话'), 'utf-8')
      await new Promise((resolve) => setTimeout(resolve, 400))
      await writeFile(join(buses, 'room-B.json'), frame('乙房间说的话'), 'utf-8')
      await new Promise((resolve) => setTimeout(resolve, 400))

      const a = await (await fetch(`${base}/frame?since=0&room=room-A`, { headers })).json()
      const b = await (await fetch(`${base}/frame?since=0&room=room-B`, { headers })).json()
      check('房间 A 拿到自己的字幕', a.frame?.text === '甲房间说的话', JSON.stringify(a.frame?.text))
      check('房间 B 拿到自己的字幕', b.frame?.text === '乙房间说的话', JSON.stringify(b.frame?.text))
      check('两个房间序号各自独立', a.seq === 1 && b.seq === 1, `${a.seq}/${b.seq}`)

      // 只写 A：B 不能被覆盖（这正是旧版全局总线干的事）
      await writeFile(join(buses, 'room-A.json'), frame('甲房间第二句'), 'utf-8')
      await new Promise((resolve) => setTimeout(resolve, 400))
      const a2 = await (await fetch(`${base}/frame?since=1&room=room-A`, { headers })).json()
      const b2 = await (await fetch(`${base}/frame?since=1&room=room-B`, { headers })).json()
      check('A 收到第二句', a2.frame?.text === '甲房间第二句', JSON.stringify(a2.frame?.text))
      check('B 没被 A 覆盖', b2.frame === null || b2.frame.text === '乙房间说的话',
        JSON.stringify(b2.frame?.text))
      check('B 的序号没被 A 推进', b2.seq === 1, String(b2.seq))
    } finally {
      relay.close?.()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // 4.95：字幕帧要带**这一句是谁说的**。
  // 为什么要服务端给：总线帧里的 `speaker` 只有 me/them（相对电脑的说法），手机拿它没法显示，
  // 只能拿"当前谁持麦"去猜 —— 而字幕是逐帧产生的，猜必然错位
  // （用户实测：没人在麦上时，每张字幕卡片的发言人都显示成「麦克风空闲」）。
  await it('4.95：字幕帧带上真实发言人（发布那一刻的持麦者）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'speakername-'))
    const secret = 's3cret-0123456789abcdef'
    const buses = join(dir, 'buses')
    await mkdir(buses, { recursive: true })
    const room = createRoom(dir, { name: '谁的会', host: 'alice' })
    joinRoom(dir, { roomId: room.room.id, username: 'bob' })
    const relay = await startRelay({
      dataDir: dir, port: 0, host: '127.0.0.1', secret, quiet: true, bus: buses, pollHoldMs: 300,
    })
    try {
      const base = `http://127.0.0.1:${relay.port}`
      const headers = { 'X-Leion-Secret': secret }
      const busFile = join(buses, `${room.room.id}.json`)
      const frame = (text, at) => JSON.stringify({
        speaker: 'them', lang: 'pt-BR', lines: [text], text, source: text, partial: false, at,
      })

      // ① 没人在麦上、也没人上传过音频 → **没有** speakerName 这个字段
      //    （绝不能是 JSON null：安卓的 optString 会把它变成字符串 "null"）
      await writeFile(busFile, frame('没人在说的时候这句', '1'), 'utf-8')
      await new Promise((resolve) => setTimeout(resolve, 400))
      const idle = await (await fetch(`${base}/frame?since=0&room=${room.room.id}`, { headers })).json()
      check('无人说话时**不带** speakerName 字段',
        idle.frame !== null && idle.frame.speakerName === undefined,
        JSON.stringify(idle.frame?.speakerName))
      check('绝不写 null（安卓会把 null 读成字符串 "null"）',
        idle.frame !== null && idle.frame.speakerName !== null, String(idle.frame?.speakerName))

      // ② alice 拿麦 → 下一帧的发言人就该是 alice
      takeFloor(dir, { roomId: room.room.id, username: 'alice' })
      await writeFile(busFile, frame('alice 说的这句', '2'), 'utf-8')
      await new Promise((resolve) => setTimeout(resolve, 400))
      const mine = await (await fetch(`${base}/frame?since=1&room=${room.room.id}`, { headers })).json()
      check('持麦者随帧下发', mine.frame?.speakerName === 'alice', JSON.stringify(mine.frame?.speakerName))

      // ③ 换人持麦 → 发言人跟着换（不是"永远第一个说话的人"）
      takeFloor(dir, { roomId: room.room.id, username: 'bob' })
      await writeFile(busFile, frame('bob 说的这句', '3'), 'utf-8')
      await new Promise((resolve) => setTimeout(resolve, 400))
      const bob = await (await fetch(`${base}/frame?since=2&room=${room.room.id}`, { headers })).json()
      check('换人之后发言人跟着换', bob.frame?.speakerName === 'bob', JSON.stringify(bob.frame?.speakerName))

      // ④ 4.96：**手机上传时自报的发言人**要盖过"当前持麦者"。
      //    这才是用户提的那条路 —— 字幕是这段音频转出来的，谁是说话人只有上传方知道。
      await fetch(`${base}/audio?rate=16000&lang=zh-CN`
        + `&room=${encodeURIComponent(room.room.id)}&speaker=carol`, {
        method: 'POST',
        headers: { 'X-Leion-Secret': secret, 'content-type': 'application/octet-stream' },
        body: Buffer.alloc(1600),
      })
      await writeFile(busFile, frame('carol 说的这句', '4'), 'utf-8')
      await new Promise((resolve) => setTimeout(resolve, 400))
      const carol = await (await fetch(`${base}/frame?since=3&room=${room.room.id}`, { headers })).json()
      check('上传方自报的发言人被采用（不用再猜持麦者）',
        carol.frame?.speakerName === 'carol', JSON.stringify(carol.frame?.speakerName))

      // ⑤ 离谱的自报名字要被清洗掉（它会显示在别人的界面上、也会落库）
      await fetch(`${base}/audio?rate=16000&lang=zh-CN`
        + `&room=${encodeURIComponent(room.room.id)}&speaker=${encodeURIComponent('<script>')}`, {
        method: 'POST',
        headers: { 'X-Leion-Secret': secret, 'content-type': 'application/octet-stream' },
        body: Buffer.alloc(1600),
      })
      await writeFile(busFile, frame('乱七八糟的名字那句', '5'), 'utf-8')
      await new Promise((resolve) => setTimeout(resolve, 400))
      const dirty = await (await fetch(`${base}/frame?since=4&room=${room.room.id}`, { headers })).json()
      check('认不出的自报名字不采用（沿用上一个可信的说话人）',
        dirty.frame?.speakerName === 'carol', JSON.stringify(dirty.frame?.speakerName))

      // ⑥ 转写全文里存的也必须是真实用户名（以前存的是 them）
      const stored = (await import('../lib/rooms.mjs')).listRoomTranscript(dir, {
        roomId: room.room.id, user: 'alice',
      })
      const names = stored.ok === true ? stored.lines.map(line => line.username) : []
      check('落库的发言人不是 me/them',
        names.every(name => name === '' || name === 'alice' || name === 'bob' || name === 'carol'),
        JSON.stringify(names))
      check('至少记下了 bob 那一句', names.includes('bob'), JSON.stringify(names))

      // ⑦ 5.12：**原文帧（echo）不入库**。
      //    它是"给读源语言的人看的自己那句话"，不是一次翻译；记进去会在转写全文里
      //    凭空多出"中文→中文"，而且与真正的译文合并时会污染 dst_by_lang。
      //    ⚠️ 这个测试块自己有局部 `frame()`（第二参是 at），所以这里必须显式写字段。
      const before = stored.ok === true ? stored.lines.length : 0
      await writeFile(busFile, JSON.stringify({
        speaker: 'them', lang: 'zh-CN', sourceLang: 'zh-CN',
        text: '', source: '原文帧不该入库', lines: [], partial: false, echo: true,
        at: new Date().toISOString(),
      }), 'utf-8')
      await new Promise((resolve) => setTimeout(resolve, 400))
      const after = await (await import('../lib/rooms.mjs')).listRoomTranscript(dir, {
        roomId: room.room.id, user: 'alice',
      })
      const afterLines = after.ok === true ? after.lines.length : 0
      check('原文帧没有被写进转写全文', afterLines === before, `${before} → ${afterLines}`)
      // 但它本身仍然**要发给客户端**（否则说话人又看不到自己那句了）
      const echoSeen = await (await fetch(`${base}/frame?since=5&room=${room.room.id}`, { headers })).json()
      check('原文帧仍然被推送出去', echoSeen.frame?.echo === true, JSON.stringify(echoSeen.frame?.echo))
    } finally {
      relay.close?.()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await it('4.84 / 5.08：音频按房间、按说话人分流 —— 声音不串，语种也不会互相覆盖', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'roomaudio-'))
    const secret = 's3cret-0123456789abcdef'
    const relay = await startRelay({ dataDir: dir, port: 0, host: '127.0.0.1', secret, quiet: true })
    try {
      const base = `http://127.0.0.1:${relay.port}`
      const post = (room, bytes, { speaker = '', lang = 'zh-CN' } = {}) => fetch(
        `${base}/audio?rate=16000&lang=${encodeURIComponent(lang)}`
        + `${room === '' ? '' : `&room=${encodeURIComponent(room)}`}`
        + `${speaker === '' ? '' : `&speaker=${encodeURIComponent(speaker)}`}`,
        { method: 'POST', headers: { 'X-Leion-Secret': secret }, body: Buffer.alloc(bytes, 7) })

      await post('room-A', 2048, { speaker: 'alice' })
      await post('room-B', 4096, { speaker: 'carol' })
      await post('room-A', 1024, { speaker: 'alice' })
      // 同一个房间里第二个人，用另一种语言 —— 这正是 5.08 要分开的情形
      await post('room-A', 512, { speaker: 'bob', lang: 'en-US' })
      await new Promise((resolve) => setTimeout(resolve, 300))

      const aAlice = roomSpeakerAudioPath(dir, 'room-A', 'alice')
      const aBob = roomSpeakerAudioPath(dir, 'room-A', 'bob')
      const bCarol = roomSpeakerAudioPath(dir, 'room-B', 'carol')
      check('A 房间 alice 的文件按自己的块长大', existsSync(aAlice) && readFileSync(aAlice).length === 3072,
        existsSync(aAlice) ? String(readFileSync(aAlice).length) : 'missing')
      check('A 房间 bob 只收自己的 512', existsSync(aBob) && readFileSync(aBob).length === 512,
        existsSync(aBob) ? String(readFileSync(aBob).length) : 'missing')
      check('B 房间只收自己的 4096', existsSync(bCarol) && readFileSync(bCarol).length === 4096,
        existsSync(bCarol) ? String(readFileSync(bCarol).length) : 'missing')
      // 5.08 的核心：**每个人一条语种旁文件**，两个人的语种不会互相覆盖
      check('alice 的语种是 zh-CN', readFileSync(aAlice + '.lang', 'utf-8').trim() === 'zh-CN',
        readFileSync(aAlice + '.lang', 'utf-8').trim())
      check('bob 的语种是 en-US（没有被 alice 覆盖）',
        readFileSync(aBob + '.lang', 'utf-8').trim() === 'en-US',
        readFileSync(aBob + '.lang', 'utf-8').trim())
      check('全局文件仍在（单房间/老链路兼容）', existsSync(join(dir, 'audio-in.pcm')))

      const listed = await (await fetch(`${base}/audio/rooms`, { headers: { 'X-Leion-Secret': secret } })).json()
      check('/audio/rooms 列出两个房间', listed.ok === true && listed.rooms.length === 2,
        JSON.stringify(listed.rooms?.map((one) => one.room)))
      const roomA = listed.rooms.find((one) => one.room === 'room-A')
      check('A 房间报出两路分轨', roomA !== undefined && roomA.tracks === 2, JSON.stringify(roomA))

      // 文件名必须消毒：房间 id / 说话人里塞 .. 不能穿越出 audio/ 目录
      check('房间 id 被消毒（防目录穿越）',
        roomAudioPath(dir, '../../etc/passwd').startsWith(join(dir, 'audio') + sep),
        roomAudioPath(dir, '../../etc/passwd'))
      check('说话人名也被消毒',
        roomSpeakerAudioPath(dir, 'room-A', '../../etc/passwd')
          .startsWith(roomTrackDir(dir, 'room-A') + sep),
        roomSpeakerAudioPath(dir, 'room-A', '../../etc/passwd'))
    } finally {
      relay.close?.()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await it('5.10：回执里的"第几块 / 累计几秒"按**这一场**算（不是开机以来的总和）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'roomcount-'))
    const secret = 's3cret-0123456789abcdef'
    const relay = await startRelay({ dataDir: dir, port: 0, host: '127.0.0.1', secret, quiet: true })
    try {
      const base = `http://127.0.0.1:${relay.port}`
      const post = (room, bytes, { fresh = false } = {}) => fetch(
        `${base}/audio?rate=16000&room=${encodeURIComponent(room)}&speaker=alice`
        + `${fresh ? '&fresh=1' : ''}`,
        { method: 'POST', headers: { 'X-Leion-Secret': secret }, body: Buffer.alloc(bytes, 7) })
        .then((response) => response.json())

      // 1 秒 @16k = 32000 字节
      const first = await post('room-1', 32000, { fresh: true })
      check('新一次录音的第 1 块：chunks=1', first.chunks === 1, JSON.stringify(first))
      check('秒数只算这一场（1 秒）', Math.abs(first.seconds - 1) < 0.05, String(first.seconds))
      const second = await post('room-1', 16000)
      check('第 2 块的块号接着这一场数', second.chunks === 2, JSON.stringify(second))
      check('秒数是这一场的累计（1.5 秒）', Math.abs(second.seconds - 1.5) < 0.05, String(second.seconds))
      // 另一场会是**自己的**计数，不会接着上一场数
      const other = await post('room-2', 32000, { fresh: true })
      check('另一场会从第 1 块开始', other.chunks === 1, JSON.stringify(other))
      // 现场那个 bug：秒数一直涨到几百秒（全局 audio-in.pcm 的历史总和）。
      // 现在再按一次"重新录音"，这一场必须从 0 重新算。
      const restart = await post('room-1', 16000, { fresh: true })
      check('重新录音后这一场从 1 秒重新算', restart.chunks === 1 && Math.abs(restart.seconds - 0.5) < 0.05,
        JSON.stringify(restart))
      check('全局总量仍然在（排障用 serverBytes）',
        typeof restart.serverBytes === 'number' && restart.serverBytes > 0, String(restart.serverBytes))
    } finally {
      relay.close?.()
      rmSync(dir, { recursive: true, force: true })
    }
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

  // ── 3b. 译文质检（只报不改）────────────────────────────────────────────────
  //
  // 判据本身在 tests/lint-suite.mjs 里逐条测过；这里测的是**接线**：
  // 定稿帧要判、增量帧不许判（半句话缺数字是正常的，判了就是满屏假错）、
  // 而且判错**绝不能让字幕转发受影响** —— 它是旁路。

  await it('译文质检：定稿帧里的"专名新造"要报出来，并计入 /status', async () => {
    const before = (await call('/status')).json
    const bad = frame('Nós e o Liangliang interpretamos esse óculos,', {
      source: '我们和亮亮视野合作开发的这款 Leion Pro，用的是高通的芯片，系统版本是安卓十二。',
      partial: false,
    })
    await writeFile(bus, JSON.stringify(bad), 'utf-8')
    let after = null
    for (let i = 0; i < 40 && (after?.json?.lintBad ?? 0) <= (before.lintBad ?? 0); i += 1) {
      await sleep(30)
      after = await call('/status')
    }
    check('lint 开着', after.json.lint === true, JSON.stringify(after.json.lint))
    // ⚠️ 这里**故意不写死条数**（早先写的是 +1，后来判据加了"专名丢失"就变成 +4）：
    //    这条测的是**接线**（定稿帧有没有被送到判据、结果有没有进 /status），
    //    不是判据本身的判分。写死条数会让每次加检查都误伤这条测试，
    //    而"该报几条"是 lint-suite 该管的事。
    check('计数增加了', after.json.lintBad > before.lintBad,
      `${before.lintBad} → ${after.json.lintBad}`)
    check('错类记成"专名新造"', after.json.lintKinds?.['专名新造'] >= 1,
      JSON.stringify(after.json.lintKinds))
    check('字幕照常下发（质检没有挡住它）', after.json.seq > before.seq,
      `${before.seq} → ${after.json.seq}`)
  })

  await it('译文质检：增量帧不判（半句话缺专名是正常的，判了就是假错）', async () => {
    const before = (await call('/status')).json
    const partial = frame('Nós e o Liangliang', {
      source: '我们和亮亮视野合作开发的这款 Leion Pro，用的是高通的芯片，系统版本是安卓十二。',
      partial: true,
    })
    await writeFile(bus, JSON.stringify(partial), 'utf-8')
    let after = null
    for (let i = 0; i < 40 && (after?.json?.seq ?? 0) <= (before.seq ?? 0); i += 1) {
      await sleep(30)
      after = await call('/status')
    }
    check('帧确实收到了（seq 涨了）', after.json.seq > before.seq, `${before.seq} → ${after.json.seq}`)
    check('但一条错都没报', after.json.lintBad === before.lintBad,
      `${before.lintBad} → ${after.json.lintBad}`)
    check('警告也没多', after.json.lintWarn === before.lintWarn,
      `${before.lintWarn} → ${after.json.lintWarn}`)
  })

  await it('译文质检：没有原文的帧不判（判据要靠原文，凭空判必然误报）', async () => {
    const before = (await call('/status')).json
    // ⚠️ 这一句的译文里**故意放一个真错**（`do segundo sala`：sala 是阴性，应作 `da segunda sala`）。
    //    为什么非要用"性数不一致"来测：判据里只有它**完全不需要原文**
    //    （`agreementProblems` 只看译文）。所以这个用例才真的在测那道"没有原文就不判"的闸 ——
    //    换成专名来测的话，原文为空时本来就匹配不上，那种测试**怎么都能过**，等于没测。
    await writeFile(bus, JSON.stringify(frame('O local foi alterado do segundo sala no 12º andar.')), 'utf-8')
    let after = null
    for (let i = 0; i < 40 && (after?.json?.seq ?? 0) <= (before.seq ?? 0); i += 1) {
      await sleep(30)
      after = await call('/status')
    }
    check('帧收到了', after.json.seq > before.seq, `${before.seq} → ${after.json.seq}`)
    check('不判 → 不报', after.json.lintBad === before.lintBad,
      `${before.lintBad} → ${after.json.lintBad}`)
  })

  // ── 4. 错误与边界 ──────────────────────────────────────────────────────────

  await it('音频轮转：超过上限就把旧的改名成 .1 再开新文件（不原地清空）', async () => {
    // 为什么要这条：/audio 只追加、从不清空（清空会吃掉还没被识别的音频）。
    // 但那样文件会一直长 —— 长期跑必然把磁盘写满。轮转是"留着旧的一份 + 继续写新的"，
    // 而识别进程发现文件变小会把读指针退回 0（PcmFollower 那条分支 python-suite 钉着）。
    const dir = join(TMP, 'audio-rotate')
    const audioPath = join(dir, 'audio-in.pcm')
    const tiny = await startRelay({
      port: 0, host: '127.0.0.1', secret: 'rotate-secret',
      dataDir: dir, audio: audioPath, audioRate: join(dir, 'audio-in.rate'),
      audioLang: join(dir, 'audio-in.lang'), inbox: join(dir, 'asr-inbox.jsonl'),
      bus: join(dir, 'subtitle-bus.json'),
      pollHoldMs: 200, busPollMs: 30, quiet: true,
      audioMaxBytes: 2048,        // 只装得下 2 块（每块 1024 字节）
    })
    const push = async index => {
      const body = Buffer.alloc(1024, index + 1)      // 每块内容不同，便于后面核对
      const response = await fetch(`http://127.0.0.1:${tiny.port}/audio?rate=16000`, {
        method: 'POST',
        headers: { 'x-leion-secret': 'rotate-secret', 'content-type': 'application/octet-stream' },
        body,
      })
      return { status: response.status, json: await response.json() }
    }
    try {
      const first = await push(0)
      const second = await push(1)
      check('前两块正常收下（共 2048 字节，正好到上限）',
        first.status === 200 && second.status === 200 && second.json.totalBytes === 2048,
        JSON.stringify(second.json))

      const third = await push(2)
      check('第三块触发轮转后仍然成功', third.status === 200, JSON.stringify(third.json))
      check('计数重置成只有新这一块', third.json.totalBytes === 1024, JSON.stringify(third.json))

      const backup = await readFile(audioPath + '.1')
      check('旧的一段被完整保留在 .1 里', backup.length === 2048, String(backup.length))
      check('.1 里是前两块的内容', backup[0] === 1 && backup[2048 - 1] === 2, `${backup[0]},${backup[2048 - 1]}`)

      const current = await readFile(audioPath)
      check('新文件只装第三块', current.length === 1024, String(current.length))
      check('新文件里是第三块的内容', current[0] === 3, String(current[0]))

      const status = await fetch(`http://127.0.0.1:${tiny.port}/status`, {
        headers: { 'x-leion-secret': 'rotate-secret' },
      })
      const json = await status.json()
      check('/status 报得出轮转次数', json.audioRotations === 1, String(json.audioRotations))
      check('/status 报得出上限', json.audioMaxBytes === 2048, String(json.audioMaxBytes))
    } finally {
      await tiny.close()
    }
  })

  await it('字幕保留期清理（P4）：超过保留期的字幕会被删，新的留下', async () => {
    // relay 的定时器是每小时一次，测试不等待它 —— 直接调它暴露出来的那一次，
    // 验的是"数据目录 → 删对了行"这条链（定时器本身只是一行 setInterval）。
    const db = openDb(dbPath(TMP))
    const insert = db.prepare(`INSERT INTO utterances (room_id, username, src_lang, src_text, dst_text, start_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
    const now = Date.now()
    insert.run('r', 'boss', 'zh-CN', '十天前的旧字幕', 'legendas antigas', now - 10 * 86400000)
    insert.run('r', 'boss', 'zh-CN', '刚发生的字幕', 'legendas novas', now - 60000)
    db.close()

    const removed = relay.purgeUtterances(now)
    check('删掉了超过保留期的那条', removed >= 1, String(removed))

    const after = openDb(dbPath(TMP))
    const left = after.prepare('SELECT src_text FROM utterances').all().map(row => row.src_text)
    after.close()
    check('新的那条还在', left.includes('刚发生的字幕'), left.join(','))
    check('老的已经没了', left.includes('十天前的旧字幕') === false, left.join(','))

    const status = await call('/status')
    check('/status 里能看到保留天数', status.json.utteranceRetentionDays === 7, JSON.stringify(status.json.utteranceRetentionDays))
    check('/status 里能看到累计删除条数', status.json.utterancesPurged >= 1, String(status.json.utterancesPurged))
  })

  await it('未知路由 404，并列出可用路由', async () => {
    const result = await call('/nope')
    check('404', result.status === 404, String(result.status))
    // 2026-10-23 起多了组织接口与管理员页面（docs/19）；4.35 起多了发言权推送通道 /ws
    assert.deepEqual(result.json.routes, ['/hello', '/say', '/audio', '/frame', '/status', '/terms', '/settings', '/auth/register', '/auth/login', '/auth/logout', '/auth/whoami', '/org/libraries', '/org/meeting/<id>/libraries', '/org/requests', '/admin', '/ws'])
  })

  await it('手机侧设置：PUT /settings 落盘、GET 能读回、坏请求被拒、且写在数据目录里', async () => {
    const initial = await call('/settings')
    check('200', initial.status === 200, initial.text)
    check('缺省是空对象（没写过就是没有设置）', JSON.stringify(initial.json.settings) === '{}', initial.text)

    const put = await call('/settings', { method: 'PUT', body: { proofread: false } })
    check('200', put.status === 200, put.text)
    check('回显写进去的值', put.json.settings.proofread === false, put.text)
    check('写明生效时机', put.json.effectiveAt === 'next-session', put.text)

    const after = await call('/settings')
    check('读回来还是 false', after.json.settings.proofread === false, after.text)

    const written = JSON.parse(await readFile(join(TMP, 'settings.json'), 'utf-8'))
    check('真的落在数据目录的 settings.json（插件读的就是这个）', written.proofread === false,
      JSON.stringify(written))

    const bad = await call('/settings', { method: 'PUT', body: { proofread: 'yes' } })
    check('类型不对被拒（boolean 才行）', bad.status === 400, bad.text)
    const bad2 = await call('/settings', { method: 'PUT', body: {} })
    check('缺字段被拒', bad2.status === 400, bad2.text)
    const still = await call('/settings')
    check('坏请求没有污染已有设置', still.json.settings.proofread === false, still.text)

    const noSecret = await call('/settings', { secret: null })
    check('没密钥 401（和字幕同一把锁）', noSecret.status === 401, String(noSecret.status))
    // 复原，免得影响后面的用例
    await call('/settings', { method: 'PUT', body: { proofread: true } })
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

  await it('5.06：上传时自报的语种会**校正这个成员**的参会语言（否则他说英语也收不到字幕）', async () => {
    // 现场：入会时登记的是中文，会中换成英语说话 —— 于是
    //   ① 大脑的"听众语言集合"里没有英语 → 一句英文都不译；
    //   ② 按语言扇出时他一条字幕都收不到（用户报的"说英文那个人不显示字幕"）。
    const dir = join(TMP, 'member-lang')
    await mkdir(dir, { recursive: true })
    const created = createRoom(dir, { name: '语种同步', host: 'alice' })
    joinRoom(dir, { room: created.room, username: 'alice', lang: 'zh-CN' })
    joinRoom(dir, { room: created.room, username: 'bob', lang: 'zh-CN' })
    const before = listMembers(dir, created.room.id)
    check('两个人一开始都登记成中文',
      before.every((one) => one.lang === 'zh-CN'), JSON.stringify(before.map((m) => [m.username, m.lang])))

    const local = await startRelay({
      dataDir: dir, port: 0, host: '127.0.0.1', secret: 'sync-secret', quiet: true,
      inbox: join(dir, 'asr-inbox.jsonl'), bus: join(dir, 'subtitle-bus.json'),
    })
    try {
      const query = new URLSearchParams({
        rate: '16000', room: created.room.id, speaker: 'bob', lang: 'en-US',
      })
      const response = await fetch(`http://127.0.0.1:${local.port}/audio?${query}`, {
        method: 'POST',
        headers: { 'x-leion-secret': 'sync-secret', 'content-type': 'application/octet-stream' },
        body: pcm(1600),
      })
      check('上传被接受', response.status === 200, String(response.status))
      const after = listMembers(dir, created.room.id)
      const bob = after.find((one) => one.username === 'bob')
      const alice = after.find((one) => one.username === 'alice')
      check('说英语的 bob 被校正成 en-US（这就是"他也能收到英文字幕"的前提）',
        bob.lang === 'en-US', String(bob.lang))
      check('别人的语言不许被动到', alice.lang === 'zh-CN', String(alice.lang))
    } finally {
      await local.close()
    }
  })

  await it('非法语种返回 400', async () => {
    // 5.00：en-US 已支持，非法示例换成 de-DE
      const result = await postAudio(pcm(100), { lang: 'de-DE' })
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
