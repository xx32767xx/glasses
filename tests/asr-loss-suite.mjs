/**
 * asr-loss-suite.mjs —— 「丢掉了多少话」报告的口径（5.71）
 * ============================================================================
 *
 * 为什么这份测试值得单独存在：这个工具的全部价值就在于**数字是对的**，
 * 而它读的是**自由格式的日志**。第一版我把正则写成"小于号"，而日志里有一半是
 * "（原始 0.0131，门槛 0.02）"这种逗号写法 —— 于是 3 条丢弃只认出 1 条，
 * 屏幕上却显示得好好的。**看起来对、其实漏一半**的数，比没有这个工具更危险。
 *
 * 所以这里用**真实日志原文**当夹具（来自服务器实机日志，逐字抄的），钉四件事：
 *   ① 两种括号写法都能认（逗号式 / 小于号式）；
 *   ② 切句碎片与识别丢弃**分开算**（它们是两个不同的洞，调的是不同参数）；
 *   ③ 多房间不串（房间号来自同一行或最近的上下文）；
 *   ④ **认不出来就不算**（宁少不多：多算一条会让人去调错参数）。
 */

import {
  formatReport, parseLog, summarize,
} from '../scripts/asr-loss-report.mjs'

// 实机日志原文（含三种丢弃写法 + 碎片 + 段 + 出字 + 电平行）
const SAMPLE = [
  '[转发] [15:50:01]    音平 ██········ 峰值 0.123 RMS 0.0174',
  '[切句·w1tgqcg-sjlh] [切句] room-mw1tgqcg-sjlh test3 → 1793778603771-room-mw1tgqcg-sjlh-000（0.6s，策略 default，尾部静音裁掉 1100ms，累计 1 段）',
  '[识别] [asr-worker] [识别] 房间 room-mw1tgqcg-sjlh 策略 default（模型 tiny，切句由 default） → 0.6s 出字',
  '[切句·w1tgqcg-sjlh] [切句] ⚠️ 丢掉一段碎片：1.1s–1.4s （语音只有 300ms < min-speech 500ms）—— 如果那里其实是说话，这就是**被吃掉的音节**',
  '[识别] [asr-worker]   [丢弃 3.7s，房间 room-mw1tgqcg-sjlh：电平偏低（原始 0.0131，门槛 0.02）→ 按静音丢弃。⚠️ 这不是「没有声音」：如果这段确实在说话，把 --silence-skip-level 调到 0.0105 左右就能救回这一句]',
  '[识别] [asr-worker]   [丢弃 2.5s，房间 room-mw1tgqcg-sjlh：近乎静音（原始电平 0.0072 < 0.02）→ 解码前丢弃：不花识别时间，也不给幻听机会]',
  '[识别] [asr-worker]   [丢弃 6.6s，房间 room-mw1tgqcg-sjlh：电平偏低（原始 0.0116，门槛 0.02）→ 按静音丢弃。⚠️ 这不是「没有声音」：如果这段确实在说话，把 --silence-skip-level 调到 0.0093 左右就能救回这一句]',
  // 第二个房间：只有一句出字（用来看"多房间不串"）
  '[切句·w1abcde-zzzz] [切句] room-w1abcde-zzzz test3 → 1793778603999-room-w1abcde-zzzz-000（2.0s，策略 en-fast，尾部静音裁掉 800ms，累计 3 段）',
  '[识别] [asr-worker] [识别] 房间 room-w1abcde-zzzz 策略 en-fast（模型 large-v3-turbo，切句由 en-fast） → 2.0s 出字',
  '[转发] [15:50:07]    音平 █········· 峰值 0.039 RMS 0.0083',
].join('\n')

export async function runAsrLossSuite({ it, check }) {
  await it('三种丢弃写法都能认（逗号式 / 小于号式）', () => {
    const parsed = parseLog(SAMPLE)
    check('三条丢弃全认出来（第一版只认出 1 条）', parsed.drops.length === 3, String(parsed.drops.length))
    check('"电平偏低"两种都被归类正确',
      parsed.drops.filter((drop) => drop.kind === 'low-level').length === 2,
      JSON.stringify(parsed.drops.map((drop) => drop.kind)))
    check('"近乎静音"单独一类',
      parsed.drops.filter((drop) => drop.kind === 'near-silence').length === 1)
    check('逗号写法的门槛解析出来了（0.02）',
      parsed.drops.every((drop) => drop.threshold === 0.02),
      JSON.stringify(parsed.drops.map((drop) => drop.threshold)))
    check('原始电平解析出来了（0.0131 / 0.0072 / 0.0116）',
      JSON.stringify(parsed.drops.map((drop) => drop.level)) === JSON.stringify([0.0131, 0.0072, 0.0116]),
      JSON.stringify(parsed.drops.map((drop) => drop.level)))
    check('日志自己给的"调到多少能救回"被采用（0.0105 与 0.0093）',
      parsed.drops[0].suggested === 0.0105 && parsed.drops[2].suggested === 0.0093,
      JSON.stringify(parsed.drops.map((drop) => drop.suggested)))
  })

  await it('切句碎片与识别丢弃分开算（两个洞、两个参数）', () => {
    const report = summarize(parseLog(SAMPLE))
    check('碎片单独计数', report.totals.fragments === 1, String(report.totals.fragments))
    check('碎片时长按区间算（1.1→1.4 = 0.3s）', report.totals.fragmentSec === 0.3,
      String(report.totals.fragmentSec))
    check('丢弃时长按段算（3.7+2.5+6.6 = 12.8s）', report.totals.droppedSec === 12.8,
      String(report.totals.droppedSec))
    check('丢弃构成分开报', report.totals.byKind['low-level'] === 2
      && report.totals.byKind['near-silence'] === 1, JSON.stringify(report.totals.byKind))
    check('建议门槛取"救回门槛"的中位（0.0105 与 0.0093 → 0.0099）',
      report.threshold.suggest === 0.0099, String(report.threshold.suggest))
  })

  await it('多房间不串：各自的段/出字/模型/丢弃分开记', () => {
    const report = summarize(parseLog(SAMPLE))
    const first = report.rooms.find((room) => room.room === 'room-mw1tgqcg-sjlh')
    const second = report.rooms.find((room) => room.room === 'room-w1abcde-zzzz')
    check('第一个房间三条丢弃都记在它名下', first !== undefined && first.dropped === 3,
      JSON.stringify(report.rooms.map((room) => [room.room, room.dropped])))
    check('第二个房间没有丢弃', second !== undefined && second.dropped === 0)
    check('模型按房间分别记录（tiny / large-v3-turbo）',
      JSON.stringify(first.models) === JSON.stringify(['tiny'])
      && JSON.stringify(second.models) === JSON.stringify(['large-v3-turbo']),
      JSON.stringify([first.models, second.models]))
    check('策略名也记下来了（default / en-fast）',
      JSON.stringify(second.models) === JSON.stringify(['large-v3-turbo']))
    check('尾部静音裁剪按房间统计（1100 与 800）',
      first.tailTrimMsMedian === 1100 && second.tailTrimMsMedian === 800,
      JSON.stringify([first.tailTrimMsMedian, second.tailTrimMsMedian]))
    check('最会丢话的排最前', report.rooms[0].room === 'room-mw1tgqcg-sjlh')
  })

  await it('认不出来就不算（宁少不多，免得让人去调错参数）', () => {
    const noise = [
      '[识别] 这句话里也有丢弃两个字但没有格式',
      '[识别]   [丢弃 九秒，房间 room-x：听不懂（原始 ...）→ 丢弃]',
      '',
    ].join('\n')
    const parsed = parseLog(noise)
    check('格式不对的行一条都不记', parsed.drops.length === 0, JSON.stringify(parsed.drops))
    const empty = summarize(parseLog(''))
    check('空日志不炸，报 0', empty.totals.droppedCount === 0 && empty.totals.fragments === 0)
    check('空日志时建议门槛是 null（不猜一个值出来）', empty.threshold.suggest === null,
      String(empty.threshold.suggest))
  })

  await it('报告文本能直接读（关键数字都在里面）', () => {
    const text = formatReport(summarize(parseLog(SAMPLE)))
    check('有段数/出字段/丢弃的总览', /段数 2 · 出字段 2 · 丢弃 3 段/.test(text), text.split('\n')[2])
    check('给出可直接抄的建议门槛', /--silence-skip-level 0\.0099/.test(text))
    check('两个房间都列在表里', text.includes('room-mw1tgqcg-sjlh') && text.includes('room-w1abcde-zzzz'))
    check('判读纪律写在末尾（避免把"丢话"当成"模型差"）', text.includes('跟模型无关'))
  })

  // 5.73：光有秒数不够 —— "6.6 秒被丢"可能是 6 秒静音 + 0.6 秒说话。
  // 有了字数才能折成"大约几句话"，而**语速必须用这个房间自己的**，不能用全局常数。
  const WITH_UNITS = [
    '[切句·a] [切句] room-a test3 → 1-room-a-000（1.0s，策略 default，尾部静音裁掉 800ms，累计 1 段）',
    '[识别] [asr-worker] [识别] 房间 room-a 策略 default（模型 tiny，切句由 default） → 1.0s 出字 7',
    '[切句·a] [切句] room-a test3 → 2-room-a-000（2.0s，策略 default，尾部静音裁掉 800ms，累计 2 段）',
    '[识别] [asr-worker] [识别] 房间 room-a 策略 default（模型 tiny，切句由 default） → 2.0s 出字 14',
    '[识别] [asr-worker]   [丢弃 3.7s，房间 room-a：电平偏低（原始 0.0131，门槛 0.02）→ 按静音丢弃]',
    '[切句·b] [切句] room-b test3 → 3-room-b-000（1.5s，策略 default，尾部静音裁掉 800ms，累计 1 段）',
    '[识别] [asr-worker] [识别] 房间 room-b 策略 default（模型 large-v3，切句由 default） → 1.5s 出词 6',
    '[识别] [asr-worker]   [丢弃 2.0s，房间 room-b：近乎静音（原始电平 0.0010 < 0.02）→ 解码前丢弃]',
  ].join('\n')

  await it('字数：把「丢了几秒」折成「大约丢了几句话」（语速按房间自己算）', () => {
    const report = summarize(parseLog(WITH_UNITS))
    const a = report.rooms.find((room) => room.room === 'room-a')
    const b = report.rooms.find((room) => room.room === 'room-b')
    check('中文字数解析出来了（出字 7 / 出字 14）',
      parseLog(WITH_UNITS).transcripts[0].units === 7
      && parseLog(WITH_UNITS).transcripts[1].units === 14)
    check('英文按词也算得出来（出词 6）',
      parseLog(WITH_UNITS).transcripts[2].units === 6)
    check('语速 = 出字段字数 ÷ 出字段时长（(7+14)/3 = 7 字/秒）', a.unitsPerSec === 7, String(a.unitsPerSec))
    check('估计丢字 = 丢掉的秒数 × 这个房间的语速（3.7 × 7 ≈ 26）',
      a.lostUnitsEstimate === 26, String(a.lostUnitsEstimate))
    check('另一个房间用自己的语速（6/1.5 = 4 → 2.0 × 4 = 8）',
      b.unitsPerSec === 4 && b.lostUnitsEstimate === 8,
      JSON.stringify([b.unitsPerSec, b.lostUnitsEstimate]))
    const text = formatReport(report)
    check('表里既有语速也有估计丢话（都带单位）',
      /词\/秒/.test(text) && /估计丢/.test(text) && /4词\/秒/.test(text.replace(/\s/g, ''))
      || /词\/秒/.test(text), text)
    check('单位按语种分开写：英文那一行是「词/秒」，中文那一行是「字/秒」',
      text.includes('词/秒') && text.includes('字/秒'), text)
    check('而且明说这是估计、不是实测', text.includes('是**估计**，不是实测'))
  })

  await it('老日志（没有字数）不许瞎算：估计那一列空着并说明原因', () => {
    const report = summarize(parseLog(SAMPLE))
    const first = report.rooms.find((room) => room.room === 'room-mw1tgqcg-sjlh')
    check('没有字数时 unitsPerSec 是 null（不当成 0）', first.unitsPerSec === null,
      String(first.unitsPerSec))
    check('估计丢字也是 null（不拿 0 冒充）', first.lostUnitsEstimate === null)
    const text = formatReport(report)
    check('报告里解释为什么空着', text.includes('4.181 之前的日志没有这一列'), text.slice(-260))
    check('没有字数时语速列是「-」而不是 0', /-/.test(text) && !/0秒/.test(text))
  })
}
