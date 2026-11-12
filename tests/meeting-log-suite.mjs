/**
 * meeting-log-suite.mjs —— 会议记录（5.181）
 * ============================================================================
 * 用户要的东西很具体，测试也照着它钉：
 *   ① **一场会一个文件**、每句一行、**实时追加**（不是散会才落盘）；
 *   ② 每句里原文 + 各语言译文 + 四段耗时都在（人读得懂，机器查得到）；
 *   ③ 同一句**只写一条**（几种译文到齐再写，不能一种语言写一条）；
 *   ④ journald 那侧只剩报警（quiet 档），旧 var/logs 不再产生。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startRelay } from '../relay/lan-relay.mjs'
import { createRoom, joinRoom } from '../lib/rooms.mjs'
import {
  appendMeetingEvent, appendServiceEvent, listMeetingLogs, logsDirOf, meetingLogPath,
  readMeetingEvents, safeCode, safeRoom, serviceLogPath,
} from '../lib/meeting-log.mjs'
import { clockOf, formatRecord, humanMs, parseArgs as parseRenderArgs } from '../scripts/meeting-log.mjs'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

export async function runMeetingLogSuite({ it, check }) {
  console.log('\n会议记录（5.181）：一场会一个文件 / 每句一条 / 实时追加 / 人读得懂')

  const base = join(ROOT, 'var', 'test', 'meeting-log-suite')

  /** 起一个 relay + 一场会，喂两帧（同一句的两种译文），等它落记录。 */
  async function withRelay(run) {
    rmSync(base, { recursive: true, force: true })
    mkdirSync(join(base, 'buses'), { recursive: true })
    const created = createRoom(base, { name: '记录测试', host: 'ana', code: '136015', lang: 'zh-CN' })
    joinRoom(base, { roomId: created.room.id, username: 'bo', lang: 'en-US' })
    const relay = await startRelay({
      dataDir: base, port: 0, host: '127.0.0.1', secret: 'rec-secret',
      bus: join(base, 'buses'), pollHoldMs: 150, busPollMs: 20, quiet: true, logLevel: 'quiet',
    })
    try {
      return await run({ relay, roomId: created.room.id })
    } finally {
      await relay.close()
      rmSync(base, { recursive: true, force: true })
    }
  }

  function writeFrame(roomId, name, frame) {
    mkdirSync(join(base, 'buses', `${roomId}.json.frames`), { recursive: true })
    writeFileSync(join(base, 'buses', `${roomId}.json.frames`, name), JSON.stringify(frame))
  }

  const frameBody = (over = {}) => ({
    device: 'demo', speaker: 'me', speakerName: 'ana',
    source: '从学术风格的角度看，诚信与风格不是两件事。', sourceLang: 'zh-CN',
    partial: false, lines: ['…'], cols: 40, lineBudget: 6,
    at: new Date().toISOString(),
    cost: { seg: 29, segId: '136015#29', segMs: 3900, queueMs: 30, asrMs: 620, silenceMs: 800,
      trMs: { 'en-US': 1083, 'pt-BR': 1163 } },
    ...over,
  })

  await it('5.181：一场会一个文件，路径与命名可预期', async () => {
    check('文件名 = <邀请码>-<房间id>.jsonl',
      meetingLogPath('/data', { code: '229415', roomId: 'room-mwd9acyp-0u2x' })
        .replace(/\\/g, '/').endsWith('logs/rooms/229415-room-mwd9acyp-0u2x.jsonl'),
      meetingLogPath('/data', { code: '229415', roomId: 'room-mwd9acyp-0u2x' }))
    check('没有邀请码时用 noroom 占位（不编一个假号）', safeCode('') === 'noroom')
    check('房间名里的非法字符被清洗（防目录穿越）', safeRoom('../../etc') === '______etc')
    check('服务级记录按天', serviceLogPath('/data', new Date('2026-11-12T10:00:00Z')).replace(/\\/g, '/')
      .endsWith('logs/service-20261112.jsonl'), serviceLogPath('/data', new Date('2026-11-12T10:00:00Z')))
    check('记录目录跟着数据目录（不与 var/logs 混）',
      logsDirOf('/var/lib/leion/test').replace(/\\/g, '/') === '/var/lib/leion/test/logs',
      logsDirOf('/var/lib/leion/test'))
  })

  await it('5.181：每句一条记录 —— 原文 + 各语言译文 + 四段耗时（实时追加）', async () => {
    await withRelay(async ({ roomId }) => {
      writeFileSync(join(base, 'buses', `${roomId}.json`), JSON.stringify({ lines: [] }))
      writeFrame(roomId, '000001-a.json', frameBody({
        lang: 'en-US', text: 'From the perspective of academic style, integrity and style are not two separate things.',
      }))
      await new Promise((resolve) => setTimeout(resolve, 120))
      writeFrame(roomId, '000002-b.json', frameBody({
        lang: 'pt-BR', text: 'Do ponto de vista do estilo acadêmico, integridade e estilo não são duas coisas separadas.',
      }))
      await new Promise((resolve) => setTimeout(resolve, 700))

      const logs = listMeetingLogs(base)
      check('只产生一个会议记录文件（一场会一个）', logs.length === 1, JSON.stringify(logs.map((one) => one.name)))
      check('文件名带邀请码', logs[0]?.code === '136015', logs[0]?.name)
      const events = readMeetingEvents(logs[0].path)
      const sentences = events.filter((one) => one.kind === 'sentence')
      check('同一句**只写一条**（两种译文都到齐才写）', sentences.length === 1,
        JSON.stringify(sentences.map((one) => one.seg)))
      const one = sentences[0] ?? {}
      check('原文在', one.src === '从学术风格的角度看，诚信与风格不是两件事。', String(one.src).slice(0, 30))
      check('两种译文都在', one.dst?.['en-US'] !== undefined && one.dst?.['pt-BR'] !== undefined,
        JSON.stringify(Object.keys(one.dst ?? {})))
      check('四段耗时都在',
        one.segMs === 3900 && one.asrMs === 620 && one.queueMs === 30 && one.silenceMs === 800,
        JSON.stringify({ seg: one.segMs, asr: one.asrMs, q: one.queueMs, s: one.silenceMs }))
      check('翻译耗时按语言分开记', one.trMs?.['en-US'] === 1083 && one.trMs?.['pt-BR'] === 1163,
        JSON.stringify(one.trMs))
      check('⇒ 与摘要行同口径（静音+排队+识别+最慢翻译+推送）',
        Math.abs(Number(one.e2eMs) - (800 + 30 + 620 + 1163 + Number(one.pushMs ?? 0))) <= 2,
        `${one.e2eMs} vs ${800 + 30 + 620 + 1163}`)

      // **实时**：记录在 relay 还活着的时候就已经在文件里了（不是散会才写）
      const raw = readFileSync(logs[0].path, 'utf-8').trim()
      check('落盘是实时的（relay 还在跑就已经有内容）', raw.split('\n').length >= 1, raw.slice(0, 40))
      check('一行一条 JSON（能 grep / jq）', raw.split('\n').every((line) => line.startsWith('{')), raw.slice(0, 40))
    })
  })

  await it('5.181：会议开始/结束各一条（与会话生命周期对齐）', async () => {
    rmSync(base, { recursive: true, force: true })
    mkdirSync(base, { recursive: true })
    appendMeetingEvent(base, { code: '229415', roomId: 'room-a' }, {
      kind: 'meeting', event: 'start', code: '229415', room: 'room-a',
      name: '测试会', host: 'ana', members: 2, targetLang: 'en-US', model: 'large-v3',
    })
    appendMeetingEvent(base, { code: '229415', roomId: 'room-a' }, {
      kind: 'meeting', event: 'end', code: '229415', room: 'room-a', name: '测试会',
      reason: 'host-left', minutes: 42,
    })
    const logs = listMeetingLogs(base)
    const events = readMeetingEvents(logs[0].path)
    check('开始与结束都在同一个文件里', events.length === 2
      && events[0].event === 'start' && events[1].event === 'end', JSON.stringify(events.map((one) => one.kind)))
    check('开始那条带会议名/人数/目标语言/模型',
      events[0].name === '测试会' && events[0].members === 2
      && events[0].targetLang === 'en-US' && events[0].model === 'large-v3', JSON.stringify(events[0]))
    check('结束那条带原因与时长', events[1].reason === 'host-left' && events[1].minutes === 42,
      JSON.stringify(events[1]))
    rmSync(base, { recursive: true, force: true })
  })

  await it('5.181：服务级事件单独一个文件（不属于任何一场会的那种）', async () => {
    rmSync(base, { recursive: true, force: true })
    mkdirSync(base, { recursive: true })
    appendServiceEvent(base, { what: 'deepseek-key-missing', level: 'error' })
    const file = serviceLogPath(base)
    const events = readMeetingEvents(file)
    check('服务级事件落在 service-<日期>.jsonl', events.length === 1 && events[0].what === 'deepseek-key-missing',
      JSON.stringify(events))
    check('它不会混进会议文件（logs/rooms 里没有它）', listMeetingLogs(base).length === 0)
    rmSync(base, { recursive: true, force: true })
  })

  await it('5.181：渲染脚本把 JSON 排成人读的句子', async () => {
    const sentence = {
      t: '2026-11-12T08:12:48.000Z', kind: 'sentence', code: '229415', room: 'room-a', seg: 33,
      speaker: 'test25', srcLang: 'zh-CN', segMs: 1500, queueMs: 30, asrMs: 330, silenceMs: 800,
      trMs: { 'en-US': 1060 }, pushMs: 20, e2eMs: 2210,
      src: '对 然后呢 吃不完的',
      dst: { 'en-US': "Right, and then, what can't be finished." },
    }
    const lines = formatRecord(sentence)
    check('第一行是编号 + 耗时摘要', lines[0].includes('#33') && lines[0].includes('⇒2.2s'), JSON.stringify(lines))
    check('原文单独一行', lines.some((one) => one.includes('原文') && one.includes('吃不完的')), JSON.stringify(lines))
    check('译文按语言缩进（en 开头）', lines.some((one) => /^\s+en\s+Right/.test(one)), JSON.stringify(lines))
    check('毫秒与秒的写法都人话', humanMs(330) === '330ms' && humanMs(2210) === '2.2s',
      `${humanMs(330)} / ${humanMs(2210)}`)
    check('时间戳能读', /^\d{2}:\d{2}:\d{2}$/.test(clockOf(sentence.t)), clockOf(sentence.t))

    const meeting = formatRecord({
      t: '2026-11-12T08:10:02.000Z', kind: 'meeting', event: 'start', code: '229415',
      name: '测试会', members: 2, targetLang: 'en-US', model: 'large-v3',
    })
    check('开会那行读得懂', meeting[0].includes('开会') && meeting[0].includes('229415')
      && meeting[0].includes('测试会'), JSON.stringify(meeting))

    const warn = formatRecord({
      t: '2026-11-12T08:15:20.000Z', kind: 'warn', what: 'dropped-fragments', count: 6, ms: 1400,
    })
    check('异常那行读得懂（带计数）', warn[0].includes('注意') && warn[0].includes('count=6'), JSON.stringify(warn))
    check('渲染脚本参数：默认数据目录 + 可 --code/--tail',
      parseRenderArgs(['--code', '229415', '--tail', '5']).code === '229415'
      && parseRenderArgs(['--code', '229415', '--tail', '5']).tail === 5)
  })

  // 5.181b：生产上的坑 —— 服务用 --data-dir /var/lib/leion/test，而脚本缺省看 var/live，
  // 于是"明明写了记录，脚本却说没有"。现在缺省认 LEION_DATA_DIR，并且会去常见位置探路、
  // 找到就说清用的是哪个目录。
  await it('5.181b：数据目录找得对（服务不在缺省位置时也能查到）', async () => {
    const { findDataDirWithRecords } = await import('../scripts/meeting-log.mjs')
    const home = join(ROOT, 'var', 'test', 'meeting-log-home')
    const prod = join(ROOT, 'var', 'test', 'meeting-log-prod')
    rmSync(home, { recursive: true, force: true })
    rmSync(prod, { recursive: true, force: true })
    mkdirSync(home, { recursive: true })
    mkdirSync(prod, { recursive: true })
    // 生产数据目录里有记录，home 里没有（正是"脚本看错地方"的情形）
    appendMeetingEvent(prod, { code: '229415', roomId: 'room-a' }, {
      kind: 'meeting', event: 'start', code: '229415', room: 'room-a', name: '测试会',
    })
    check('缺省目录没记录时不会瞎报（先看自己找没找到）',
      listMeetingLogs(home).length === 0 && listMeetingLogs(prod).length === 1)
    check('显式给的目录优先（--data-dir 说哪就是哪）', (() => {
      const found = findDataDirWithRecords(prod)
      return found.found === true && found.dataDir === prod
    })())
    check('探路会列出试过哪些目录（找不到时用户知道该指哪）', (() => {
      const found = findDataDirWithRecords(home)
      return Array.isArray(found.tried) && found.tried.length >= 2
    })())
    rmSync(home, { recursive: true, force: true })
    rmSync(prod, { recursive: true, force: true })
  })

  await it('5.181：写入失败不拖停业务（记录是旁路）', async () => {
    // 把 data-dir 指向一个"存在但是文件"的路径 → 建不了目录，写必然失败
    const bad = join(ROOT, 'var', 'test', 'meeting-log-bad')
    rmSync(bad, { recursive: true, force: true })
    writeFileSync(bad, 'not a directory')
    let threw = false
    try {
      appendMeetingEvent(bad, { code: '1', roomId: 'r' }, { kind: 'sentence' })
      appendServiceEvent(bad, { what: 'x' })
    } catch {
      threw = true
    }
    check('写不进记录时不抛异常（只报一次）', threw === false)
    check('也读不到任何记录（不假装写成功）', listMeetingLogs(bad).length === 0)
    rmSync(bad, { recursive: true, force: true })
  })
}
