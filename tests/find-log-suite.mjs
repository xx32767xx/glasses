/**
 * find-log-suite.mjs —— 日志检索脚本（5.180）
 * ============================================================================
 * 这个脚本的价值不在 grep，而在两件事：
 *   ① **把三个 id 绑起来**（邀请码 / 房间 id / 短 id），人不用记；
 *   ② 给一个句号，把"日志行 + 收件箱那行 + 帧里的翻译耗时"拼成一句话的一生。
 * 所以测试重点也在这两处，而不是"字符串能不能搜到"。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildMapping, cleanLine, collectSources, frameRecords, inboxRecord, lineKeys, lineMatches,
  lineTime, mappingOf, parseArgs, parseClock, readLines, resolveKey, shortOf,
} from '../scripts/find-log.mjs'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const SAMPLE_ROOM = 'room-mwd9acyp-0u2x'
const SAMPLE_SHORT = 'wd9acyp-0u2x'
const SAMPLE_CODE = '229415'

export async function runFindLogSuite({ it, check }) {
  console.log('\n日志检索（5.180）：三个 id 绑起来 / 句号拼一生 / 时间窗 / 容错')

  const base = join(ROOT, 'var', 'test', 'findlog-suite')
  const build = (lines) => {
    rmSync(base, { recursive: true, force: true })
    mkdirSync(join(base, 'logs', 'archive', '20261112-161246'), { recursive: true })
    mkdirSync(join(base, 'data', 'buses'), { recursive: true })
    writeFileSync(join(base, 'glasses.log'), lines.join('\n') + '\n')
    return {
      log: join(base, 'glasses.log'),
      logsDir: join(base, 'logs'),
      dataDir: join(base, 'data'),
    }
  }

  // 这些行照抄现场日志的形状（systemd 头 + 进程前缀 + 三种 id 混用）
  const scene = [
    'Nov 12 16:10:02 host leion[196085]: ▶ 房间 room-mwd9acyp-0u2x「测试会」邀请码 229415，2 人在场',
    'Nov 12 16:12:46 host leion[196085]: [转发] [16:12:46] 229415#32 test25/zh→en │ 段6.5s 识0.72s 译1.01s 推0.03s │ ⇒2.6s │ en134',
    'Nov 12 16:12:46 host leion[196085]: [识别] [asr-worker] [原文] 229415#33 zh-CN 8字「对 然后呢 吃不完的」',
    'Nov 12 16:12:48 host leion[196085]: [转发] [16:12:48] 229415#33 test25/zh→en │ 段1.5s 识0.33s 译1.06s 推0.01s │ ⇒2.2s │ en40',
    'Nov 12 16:13:43 host leion[196085]: [切句·wd9acyp-0u2x] [切句] ⚠️ 丢掉一段碎片：677.2s–677.4s（语音只有 100ms）',
    'Nov 12 16:20:00 host leion[196085]: [转发] [16:20:00] 229415#40 test25/zh→en │ 段3.8s 识0.44s 译0.83s 推0.04s │ ⇒2.1s │ en88',
  ]

  await it('5.180：三个 id 能互相解析（邀请码 / 房间 id / 短 id）', async () => {
    const paths = build(scene)
    const sources = collectSources({ logPath: paths.log, logsDir: paths.logsDir })
    check('日志源被找到', sources.length === 1 && sources[0].kind === 'systemd',
      JSON.stringify(sources.map((one) => one.kind)))
    const mapping = buildMapping(sources)
    check('开会那行把三者绑起来',
      mapping.byCode.get(SAMPLE_CODE)?.roomId === SAMPLE_ROOM
      && mapping.byCode.get(SAMPLE_CODE)?.name === '测试会',
      JSON.stringify(mapping.byCode.get(SAMPLE_CODE)))

    const byCode = resolveKey(SAMPLE_CODE, mapping)
    check('给邀请码 → 能补出房间 id 与名字',
      byCode.roomId === SAMPLE_ROOM && byCode.name === '测试会', JSON.stringify(byCode))
    const byRoom = resolveKey(SAMPLE_ROOM, mapping)
    check('给房间 id → 能补出邀请码', byRoom.code === SAMPLE_CODE, JSON.stringify(byRoom))
    const byShort = resolveKey(SAMPLE_SHORT, mapping)
    check('给短 id（进程标签里那个）→ 也能定位',
      byShort.roomId === SAMPLE_ROOM && byShort.code === SAMPLE_CODE, JSON.stringify(byShort))
    const bySeg = resolveKey(`${SAMPLE_CODE}#33`, mapping)
    check('给句号 → 房间/邀请码/句号齐全',
      bySeg.segNo === 33 && bySeg.roomId === SAMPLE_ROOM && bySeg.code === SAMPLE_CODE,
      JSON.stringify(bySeg))
    check('认不出的 key 返回 null（不瞎猜）', resolveKey('abc', mapping) === null)
  })

  await it('5.180：句号能把"日志行 + 收件箱 + 帧"拼起来（一句话的一生）', async () => {
    const paths = build(scene)
    const segId = `${SAMPLE_CODE}#33`
    const mapping = buildMapping(collectSources({ logPath: paths.log, logsDir: paths.logsDir }))
    const target = resolveKey(segId, mapping)

    // 日志里那两句（原文行 + 摘要行）都要命中，别的句子不能命中
    const hits = []
    for (const raw of readLines(paths.log)) {
      const text = cleanLine(raw)
      if (lineMatches({ text }, target) === true) hits.push(text)
    }
    check('只捞到这一句（不把同场别的句子带出来）', hits.length === 2, JSON.stringify(hits))
    check('原文行与摘要行都在', hits.some((one) => one.includes('[原文]'))
      && hits.some((one) => one.includes('⇒2.2s')), JSON.stringify(hits))

    // 会议数据：收件箱那一行（含段长/排队/识别/等静音/策略）
    writeFileSync(join(paths.dataDir, `asr-inbox-${SAMPLE_ROOM}.jsonl`), JSON.stringify({
      text: '对 然后呢 吃不完的', from: 'zh-CN', speakerName: 'test25', strategy: 'zh-steady',
      model: 'large-v3', seg: 33, segId, segMs: 1500, queueMs: 30, asrMs: 330, silenceMs: 800,
    }) + '\n')
    const inbox = inboxRecord(paths.dataDir, SAMPLE_ROOM, segId)
    check('收件箱那行能按句号捞出来', inbox !== null && inbox.segMs === 1500, JSON.stringify(inbox))
    check('里面有等静音那一项（⇒ 的口径要用它）', inbox?.silenceMs === 800, String(inbox?.silenceMs))

    // 帧（含翻译耗时）——relay 读走就删，所以"有就带上"
    const framesDir = join(paths.dataDir, 'buses', `${SAMPLE_ROOM}.json.frames`)
    mkdirSync(framesDir, { recursive: true })
    writeFileSync(join(framesDir, '000001-a.json'), JSON.stringify({
      lang: 'en-US', text: 'Right, and then, what can not be finished.',
      cost: { segId, segMs: 1500, queueMs: 30, asrMs: 330, silenceMs: 800, trMs: { 'en-US': 1060 } },
    }))
    const frames = frameRecords(paths.dataDir, SAMPLE_ROOM, segId)
    check('帧能按句号捞出来，且带翻译耗时',
      frames.length === 1 && frames[0].frame.cost.trMs['en-US'] === 1060,
      JSON.stringify(frames.map((one) => one.frame.cost)))
    check('句号对不上就不返回（不串句）', frameRecords(paths.dataDir, SAMPLE_ROOM, '229415#99').length === 0)
  })

  await it('5.180：时间窗与"按会议过滤"（grep 的两把刀）', async () => {
    const paths = build(scene)
    const mapping = buildMapping(collectSources({ logPath: paths.log, logsDir: paths.logsDir }))
    const target = resolveKey(SAMPLE_CODE, mapping)
    const baseDate = new Date('2026-11-12T00:00:00')
    const since = parseClock('16:12', baseDate)
    const until = parseClock('16:13', baseDate)
    check('时钟两种写法都认', parseClock('16:12', baseDate) !== null
      && parseClock('2026-11-12 16:12:30', baseDate) !== null)
    const kept = []
    for (const raw of readLines(paths.log)) {
      const at = lineTime(raw, baseDate)
      if (at < since || at > until) continue
      const text = cleanLine(raw)
      if (lineMatches({ text }, target) !== true) continue
      kept.push(stampOf(at))
    }
    check('时间窗把 16:20 那句挡在外面', kept.length === 3, JSON.stringify(kept))
    check('越过时间窗的那句单独看得到（说明是窗挡的，不是过滤坏了）', (() => {
      const late = []
      for (const raw of readLines(paths.log)) {
        const at = lineTime(raw, baseDate)
        if (at < parseClock('16:19', baseDate)) continue
        const text = cleanLine(raw)
        if (lineMatches({ text }, target) === true) late.push(text)
      }
      return late.length === 1
    })())
  })

  await it('5.180：容错 —— 坏字节/空文件/没有日志时不炸', async () => {
    // 坏字节：GBK 的"你好"混进 UTF-8 文件（历史上就这样踩过）
    const dir = join(base, 'broken')
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'glasses.log')
    writeFileSync(file, Buffer.concat([
      Buffer.from('Nov 12 16:00:00 host leion[1]: [原文] 229415#1 zh-CN 2字「', 'utf8'),
      Buffer.from([0xc4, 0xe3, 0xba, 0xc3]),         // GBK 的"你好"
      Buffer.from('」\n', 'utf8'),
    ]))
    let lines = []
    try {
      lines = [...readLines(file)]
    } catch (error) {
      lines = []
    }
    check('坏字节不会抛异常（替换成占位符也行）', lines.length === 1, String(lines.length))

    const empty = join(dir, 'empty.log')
    writeFileSync(empty, '')
    check('空文件不产生行', [...readLines(empty)].length === 0)
    check('不存在的文件不产生行', [...readLines(join(dir, 'nope.log'))].length === 0)
    const sources = collectSources({ logPath: join(dir, 'nope.log'), logsDir: join(dir, 'nologs') })
    check('一个日志源都没有时是空数组（不是崩）', Array.isArray(sources) && sources.length === 0)
  })

  await it('5.180：解析器不把 id 认错（短 id / 房间 id 的边界）', async () => {
    const keys = lineKeys('Nov 12 [大脑·wd9acyp-0u2x] [转发] 229415#7 room-mwd9acyp-0u2x')
    check('句号被拆成 邀请码 + 序号', keys.segIds[0] === '229415#7' && keys.codes[0] === '229415',
      JSON.stringify(keys))
    check('房间 id 与短 id 分别抓到',
      keys.roomIds.includes('room-mwd9acyp-0u2x') && keys.shortIds.includes('wd9acyp-0u2x'),
      JSON.stringify(keys))
    // 规则就是 start-multi 里的 `replace(/^room-/, '').slice(-12)`：
    //   room-mwd9acyp-0u2x → mwd9acyp-0u2x(13) → 取后 12 → wd9acyp-0u2x
    //   room-mvt9t5q9-vdkk → mvt9t5q9-vdkk(13) → 取后 12 → vt9t5q9-vdkk（头一个字母被切掉）
    check('短 id 的规则与 start-multi 完全一致（去掉 room- 取后 12 位）',
      shortOf('room-mwd9acyp-0u2x') === 'wd9acyp-0u2x'
      && shortOf('room-mvt9t5q9-vdkk') === 'mvt9t5q9-vdkk'.slice(-12),
      shortOf('room-mvt9t5q9-vdkk'))
    const mapped = mappingOf('▶ 房间 room-mvt9t5q9-vdkk「甲乙丙」邀请码 654321，2 人在场')
    check('开会那行能抽出 房间 id / 名字 / 邀请码',
      mapped?.roomId === 'room-mvt9t5q9-vdkk' && mapped?.name === '甲乙丙' && mapped?.code === '654321',
      JSON.stringify(mapped))
    check('不是开会那行时返回 null', mappingOf('[转发] 229415#7 …') === null)
    check('cleanLine 去掉 systemd 头，也去掉正文里那个时间戳',
      cleanLine('Nov 12 16:12:46 host leion[196085]: [转发] [16:12:48] 229415#33 me/zh→en')
        === '[转发] 229415#33 me/zh→en',
      cleanLine('Nov 12 16:12:46 host leion[196085]: [转发] [16:12:48] 229415#33 me/zh→en'))
  })

  await it('5.180：参数校验与归档目录（上次运行的日志在 archive 里）', async () => {
    const paths = build(scene)
    // archive：上一次运行被搬走的那一份（start-multi 的归档规则）
    writeFileSync(join(paths.logsDir, 'archive', '20261112-161246', 'relay.log'),
      '# 2026-11-12T16:12:46.000Z  start-multi  node relay/lan-relay.mjs\n'
      + '[16:12:49] 229415#35 test25/zh→en │ 段2.0s 识0.40s 译0.60s 推0.02s │ ⇒1.9s │ en30\n')
    const sources = collectSources({ logPath: paths.log, logsDir: paths.logsDir })
    check('归档目录也被列进来（不然"上次的日志"就找不到了）',
      sources.some((one) => one.kind === 'archive'), JSON.stringify(sources.map((one) => one.kind)))

    check('不给模式要报错（别静默什么都不做）', (() => {
      try {
        parseArgs(['--log', paths.log])
        return false
      } catch (error) {
        return /要做什么/.test(String(error.message))
      }
    })())
    check('--trace 缺 key 要报错', (() => {
      try {
        parseArgs(['--trace'])
        return false
      } catch (error) {
        return /需要一个 id|需要一个值/.test(String(error.message))
      }
    })())
    check('--limit 必须是正整数', (() => {
      try {
        parseArgs(['--stats', '--limit', '0'])
        return false
      } catch (error) {
        return /limit/.test(String(error.message))
      }
    })())
    check('正常参数解析得出模式与路径', (() => {
      const options = parseArgs(['--trace', '229415#33', '--log', 'x.log', '--limit', '7'])
      return options.mode === 'trace' && options.key === '229415#33'
        && options.logPath === 'x.log' && options.limit === 7
    })())
  })

  function stampOf(ms) {
    const date = new Date(ms)
    const pad = (value) => String(value).padStart(2, '0')
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  rmSync(base, { recursive: true, force: true })
}
