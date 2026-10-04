/**
 * debug-suite.mjs —— 「调试窗口」的验证
 * ============================================================================
 * 调试窗口的价值全在**判断**上：它要说清"断在哪一环"。
 * 判断错了比没有更糟 —— 你会照着错的方向查半天。
 * 所以这里把 snapshot() 与 diagnose() 都当成被测对象：
 *
 *   · snapshot() 读四个环节的证据（音频文件、收件箱、字幕总线、转发进程）
 *   · diagnose() 根据这些证据给出结论
 *
 * diagnose 是纯函数（给两份快照，出结论），所以可以构造出各种"卡住"的形态来测 ——
 * 不用真的把链路弄坏。
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { diagnose, snapshot } from '../scripts/debug-window.mjs'
import { AUDIO_IN_NAME, AUDIO_LANG_NAME, AUDIO_RATE_NAME, BUS_NAME, INBOX_NAME, VAR_DIR } from '../lib/paths.mjs'

/**
 * 用仓库里的 var/test/ 而不是系统临时区：受限沙箱下系统临时区可能不允许写/删
 * （本机就是），而 var/test/ 确定可写，也和别的套件保持一致。
 */
function scratch(name) {
  const dir = join(VAR_DIR, 'test', 'debug-suite', name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 造一份"看起来正常"的快照，再按需改坏某一部分。 */
function snap(extra = {}) {
  return {
    dataDir: 'x',
    inboxPath: 'x', busPath: 'x', audioPath: 'x',
    status: null,
    audioBytes: 32000, audioSeconds: 1, audioAgo: 1000,
    rate: 16000, lang: 'pt-BR',
    inboxLines: ['你好'], inboxCount: 1, inboxAgo: 1000,
    bus: { speaker: 'me', lang: 'pt-BR', text: 'Olá', lines: ['Olá'], at: 'T1' },
    busAgo: 1000,
    ...extra,
  }
}

/** 下一份快照：在上一份基础上改。 */
function next(previous, extra) {
  return { ...previous, ...extra }
}

export async function runDebugSuite({ it, check, assert }) {
  // ── 1. 判断逻辑：各种"卡住"的形态各自指向哪一环 ────────────────────────────

  await it('音频在涨、收件箱不动 → 指向识别进程', async () => {
    const before = snap({ audioBytes: 32000, inboxCount: 1 })
    const after = next(before, { audioBytes: 64000 })
    const verdict = diagnose(after, before)
    check('结论提到识别进程', verdict.includes('识别进程'), verdict)
  })

  await it('收件箱在涨、字幕不动 → 指向插件没在消费', async () => {
    const before = snap({ audioBytes: 96000, inboxCount: 1 })
    const after = next(before, { inboxCount: 2, inboxLines: ['你好', '这是一条测试信息'] })
    const verdict = diagnose(after, before)
    check('结论提到插件/消费', verdict.includes('插件') || verdict.includes('消费'), verdict)
  })

  await it('字幕刚更新过 → 明确说"这一句走完了"，并提示问题可能在手机侧', async () => {
    const before = snap()
    const after = next(before, { bus: { ...before.bus, at: 'T2' }, busAgo: 200 })
    const verdict = diagnose(after, before)
    check('说链路是通的', verdict.includes('走完') || verdict.includes('通'), verdict)
    check('提示看手机取字幕那一环', verdict.includes('手机'), verdict)
  })

  await it('全都没动 → 说"安静期"，并提醒要停顿', async () => {
    const before = snap()
    const verdict = diagnose(next(before, {}), before)
    check('提到安静期', verdict.includes('安静'), verdict)
    check('提醒停顿（识别是按停顿切句的）', verdict.includes('停顿'), verdict)
  })

  await it('没有音频文件 → 指向"手机没上传 / 转发进程是旧代码"', async () => {
    const verdict = diagnose(snap({ audioBytes: null, audioSeconds: null }), null)
    check('提到音频文件不存在', verdict.includes('音频'), verdict)
    check('提醒确认转发进程是不是新代码', verdict.includes('新代码') || verdict.includes('重启'), verdict)
  })

  // 第一份快照（没有可比对象）也要给结论，不能只说"观察中"
  await it('首份快照：音频到了但收件箱是空的 → 直接说识别进程没跑', async () => {
    const verdict = diagnose(snap({ inboxCount: 0, inboxLines: [] }), null)
    check('指向识别进程', verdict.includes('识别进程'), verdict)
  })

  await it('首份快照：有音频有文字但没字幕总线 → 指向插件没跑', async () => {
    const verdict = diagnose(snap({ bus: null, busAgo: null }), null)
    check('指向插件', verdict.includes('插件'), verdict)
  })

  await it('首份快照且三项都有、字幕还新鲜 → 说链路是通的', async () => {
    const verdict = diagnose(snap({ busAgo: 3000 }), null)
    check('说链路通', verdict.includes('通'), verdict)
  })

  // ── 2. snapshot()：真的去读文件，四个环节都要读对 ──────────────────────────

  await it('snapshot 能读出音频秒数、采样率、语种、收件箱行数与字幕内容', async () => {
    const dir = scratch('full')
    // 2 秒 16k 单声道 = 64000 字节
    writeFileSync(join(dir, AUDIO_IN_NAME), Buffer.alloc(64000))
    writeFileSync(join(dir, AUDIO_RATE_NAME), '16000\n', 'utf-8')
    writeFileSync(join(dir, AUDIO_LANG_NAME), 'zh-CN\n', 'utf-8')
    writeFileSync(join(dir, INBOX_NAME), '第一行\n第二行\n\n', 'utf-8')
    writeFileSync(join(dir, BUS_NAME), JSON.stringify({
      speaker: 'them', lang: 'zh-CN', text: '早上好', lines: ['早上好'], at: 'T',
    }), 'utf-8')

    const result = await snapshot({ dataDir: dir, url: null })

    check('音频字节数', result.audioBytes === 64000, String(result.audioBytes))
    check('音频秒数（按采样率算）', Math.abs(result.audioSeconds - 2) < 1e-9, String(result.audioSeconds))
    check('采样率', result.rate === 16000, String(result.rate))
    check('语种', result.lang === 'zh-CN', String(result.lang))
    check('收件箱行数（空行不算）', result.inboxCount === 2, String(result.inboxCount))
    check('字幕内容', result.bus?.text === '早上好', JSON.stringify(result.bus))
    check('没有 --url 时不查转发进程', result.status === null, String(result.status))
    check('mtime 是数字（用来说"多久没动了"）', typeof result.audioAgo === 'number', String(result.audioAgo))
  })

  await it('snapshot 对空目录不炸（什么都还没有时也要能显示）', async () => {
    const dir = scratch('empty')
    const result = await snapshot({ dataDir: dir, url: null })
    check('音频为 null 而不是抛异常', result.audioBytes === null, String(result.audioBytes))
    check('收件箱 0 行', result.inboxCount === 0, String(result.inboxCount))
    check('字幕为 null', result.bus === null, String(result.bus))
    check('这种情况下给的结论仍然可读', diagnose(result, null).length > 10)
  })

  await it('snapshot 遇到坏 JSON 的字幕总线时不崩（当作没有）', async () => {
    const dir = scratch('bad')
    writeFileSync(join(dir, BUS_NAME), '{ 这不是 JSON', 'utf-8')
    const result = await snapshot({ dataDir: dir, url: null })
    check('bus 是 null', result.bus === null, JSON.stringify(result.bus))
  })
}
