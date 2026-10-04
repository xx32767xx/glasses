/**
 * demo-driver.mjs —— 一键演示的驱动（跑在真实 Cordis 组合里的插件）
 * ============================================================================
 * 它做的事，就是一场演示需要的事：
 *   1. 等 leion-pro 把 7 个工具注册好；
 *   2. 跑一次 leion_selftest，把五条链路的红绿状态摊开；
 *   3. 开始监视「字幕总线」文件 —— 那就是眼镜屏幕，每变一次就重画一次；
 *   4. 用**真实的 ASR 桥**把 bridge/sample-transcript.txt 重放进收件箱：
 *      故意不带换行地逐句送进去，让桥的「停顿即断句」去切句（这才是真实 ASR 的样子）；
 *   5. 等收件箱处理完，打印双语统计，退出。
 *
 * 为什么用文件总线来看屏幕：插件默认的 mock 通道只打一行日志，而演示需要看见
 * 「眼镜上到底显示成什么样」——包括折行后的排版。走 transport: 'file' 就同时把
 * 两个接缝都演示了：收件箱（进）与字幕总线（出）。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createBridgeSink } from '../bridge/asr-bridge.mjs'
import { drawFrame } from '../plugin/core.mjs'
import { DEMO_DIR, ROOT, defaultBus, defaultInbox } from '../lib/paths.mjs'

export const name = 'leion-demo-driver'
export const inject = ['tools']

const EXPECTED = [
  'leion_status', 'leion_display', 'leion_translate',
  'leion_history', 'leion_inbox', 'leion_clear', 'leion_selftest',
]

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const textOf = result => result.content.map(b => (b.type === 'text' ? b.text : '')).join('')

export function apply(ctx, config) {
  // 这三个缺省值以前写死了 'E:/GlassesHarness/...' —— 仓库换个盘、或者把项目交给别人，
  // 只要有一处漏了 config 就会静默指向一个不存在的绝对路径。现在一律从 lib/paths.mjs
  // 推导，在任何机器上、任何目录下都成立。
  const cfg = Object.assign({
    busPath: defaultBus(DEMO_DIR),
    inboxPath: defaultInbox(DEMO_DIR),
    transcript: join(ROOT, 'bridge', 'sample-transcript.txt'),
    replayDelayMs: 1500,
    pauseMs: 700,
    mode: 'offline',
  }, config ?? {})

  /**
   * 两个标志位刻意分开：
   *   started —— 防重入：tools/change 会多次触发，run() 只能进一次；
   *   aborted —— 防重复报错：fail() 只报第一次。
   * 合成一个的话，run() 一开始就把它置位，后面的失败检查会全部变成空操作，
   * 演示就会在"其实失败了"的情况下报成功。
   */
  let started = false
  let aborted = false
  const fail = message => {
    if (aborted) return
    aborted = true
    console.error('\n[demo] ❌ ' + message)
    process.exit(1)
  }

  const guard = setTimeout(() => {
    fail('超时：90 秒内没跑完（大概率是插件停在 PENDING，或者 llm 路由没就绪）')
  }, 90_000)

  const leionNames = () => ctx.tools.schemas()
    .map(s => s.name).filter(n => n.startsWith('leion_')).sort()

  const call = async (name, args, callId) => textOf(await ctx.tools.execute({
    callId, name, arguments: args, signal: new AbortController().signal,
  }))

  // ── 字幕总线的渲染器 ───────────────────────────────────────────────────────

  const stats = { frames: 0, partials: 0, them: 0, me: 0 }
  const pendingOriginals = []
  let lastRaw = ''
  let lastText = ''
  let settleTimer = null
  let pendingSettleFrame = null
  let lastSettled = ''

  function renderSettled(frame, original) {
    stats.frames += 1
    if (frame.speaker === 'me') stats.me += 1
    else stats.them += 1
    const channel = frame.speaker === 'me'
      ? '佩戴者说的 → 出站给对方（眼镜上只做回显）'
      : '对方说的 → 译给佩戴者读'
    console.log('')
    console.log(drawFrame(frame, 40))
    console.log(`   [${frame.speaker} / ${frame.lang}]  ${channel}`)
    if (original !== undefined && original !== frame.text) console.log(`   原文：${original}`)
  }

  /** 把"待定稿"的那一帧真的渲染出来（收尾时必须做，否则最后一句会丢）。 */
  function settlePending() {
    if (settleTimer !== null) {
      clearTimeout(settleTimer)
      settleTimer = null
    }
    const frame = pendingSettleFrame
    pendingSettleFrame = null
    if (frame === null || frame.text === lastSettled) return
    lastSettled = frame.text
    renderSettled(frame, pendingOriginals.shift())
  }

  async function tickBus() {
    let raw
    try {
      raw = await readFile(cfg.busPath, 'utf-8')
    } catch {
      return                       // 总线文件还没出现
    }
    if (raw === lastRaw) return
    lastRaw = raw

    let frame
    try {
      frame = JSON.parse(raw)
    } catch {
      return                       // 正好读到写了一半的文件，下一轮再来
    }
    if (!Array.isArray(frame.lines) || typeof frame.text !== 'string') return
    if (frame.text === lastText) return

    const previousText = lastText
    lastText = frame.text

    // 流式增量是"同一条译文在变长"，所以**前缀关系**说明这还是同一句：只更新待定稿内容。
    // 否则说明下一句已经来了 —— 必须先把上一句真正画出来，否则上一句会被顶掉（丢帧）。
    const sameUtterance = previousText !== ''
      && previousText !== lastSettled
      && (frame.text.startsWith(previousText) || previousText.startsWith(frame.text))

    if (pendingSettleFrame !== null) {
      if (sameUtterance) {
        stats.partials += 1
        process.stdout.write(`   ⋯ ${frame.text.replace(/\s+/g, ' ').slice(0, 60)}\n`)
      } else {
        settlePending()
      }
    }

    // 250ms 内没有新内容，就认为这一句定稿了（演示用启发式，不是插件的语义）
    pendingSettleFrame = frame
    if (settleTimer !== null) clearTimeout(settleTimer)
    settleTimer = setTimeout(settlePending, 250)
  }

  // ── 主流程 ─────────────────────────────────────────────────────────────────

  async function run() {
    if (leionNames().length < EXPECTED.length) return
    started = true

    try {
      console.log('')
      console.log('═'.repeat(72))
      console.log('  亮亮视野 Leion Pro · 中↔巴葡双向同传演示')
      console.log(`  翻译后端：${cfg.mode === 'live' ? '真实模型（dsh-llm + dsh-llm-deepseek）' : '离线例句表（不联网、零成本、可复现）'}`)
      console.log('  眼镜显示预算：40 列 × 3 行（这是真实的 AR 显示区，不是随便定的）')
      console.log('═'.repeat(72))

      const missing = EXPECTED.filter(n => !leionNames().includes(n))
      if (missing.length > 0) fail('缺少工具：' + missing.join(', '))
      console.log(`\n[1/4] 插件已就位：${leionNames().length} 个工具 → ${leionNames().join(', ')}`)

      // 先自检：这一步会往总线推一个探针帧，所以要放在开始渲染之前
      const selfText = await call('leion_selftest', {}, 'demo-selftest')
      console.log('\n[2/4] 自检\n' + selfText.split('\n').map(l => '      ' + l).join('\n'))
      if (!selfText.includes('✅ 自检通过')) fail('自检没通过，先解决上面报红的链路：\n' + selfText)

      const lines = (await readFile(cfg.transcript, 'utf-8'))
        .split(/\r?\n/).map(l => l.trim()).filter(l => l !== '')
      console.log(`\n[3/4] 开始同传：${lines.length} 句剧本，经 ASR 桥写入收件箱，插件自动翻译上屏`)
      console.log('      （刻意不带换行地逐句送入，让桥的「停顿即断句」去切句 —— 真实 ASR 就是这样）')

      const renderTimer = setInterval(() => { void tickBus() }, 80)
      // 把当前总线内容当作基线，免得把自检探针帧画成字幕
      try {
        lastRaw = await readFile(cfg.busPath, 'utf-8')
        const baseline = JSON.parse(lastRaw)
        lastText = typeof baseline.text === 'string' ? baseline.text : ''
        lastSettled = lastText
      } catch { /* 还没写过总线，忽略 */ }

      const sink = await createBridgeSink({
        inbox: cfg.inboxPath,
        format: 'text',
        truncate: true,
        flushOnPauseMs: cfg.pauseMs,
        quiet: true,
      })

      const startedAt = Date.now()
      for (const line of lines) {
        pendingOriginals.push(line)
        sink.assembler.push(line)          // 不带换行：交给停顿断句
        await sleep(cfg.replayDelayMs)
      }
      await sink.finish()

      // 等收件箱把最后几句处理完
      const deadline = Date.now() + 60_000
      let status = ''
      while (Date.now() < deadline) {
        status = await call('leion_inbox', { action: 'status' }, 'demo-inbox-status')
        if (status.includes(`已处理 ${lines.length} 条`)) break
        await sleep(150)
      }
      // 再等总线把最后一句画完
      await sleep(600)

      clearInterval(renderTimer)
      settlePending()      // 关键：把还没定稿渲的那一帧补上，不能直接取消它

      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
      console.log('\n[4/4] 演示结束')
      console.log('      ' + '-'.repeat(66))
      console.log(`      剧本 ${lines.length} 句 → 字幕已定稿 ${stats.frames} 帧（另有 ${stats.partials} 次流式增量）`)
      console.log(`      通道：对方说的 ${stats.them} 帧 / 佩戴者说的 ${stats.me} 帧`)
      console.log(`      收件箱：${status.split('\n').find(l => l.includes('已处理')) ?? '（状态未取到）'}`)
      console.log(`      耗时约 ${elapsed} 秒`)
      console.log('      ' + '-'.repeat(66))
      if (!status.includes(`已处理 ${lines.length} 条`)) {
        fail('收件箱没有把剧本全部处理完，最后状态：\n' + status)
      }
      // 这一条是被真实事故逼出来的：只检查帧数会在"全部翻译失败但碎片上了屏"时谎报成功。
      if (!status.includes('错误 0 条')) {
        fail('收件箱报了翻译/解析错误，字幕内容不可信：\n' + status)
      }
      if (stats.frames < lines.length) {
        fail(`字幕帧数（${stats.frames}）少于剧本句数（${lines.length}），有句子没上屏`)
      }

      // 收尾：停掉收件箱轮询，别让进程挂着
      await call('leion_inbox', { action: 'stop' }, 'demo-stop')
      clearTimeout(guard)
      console.log('\n✅ 双向同传链路完整跑通：ASR 桥 → 收件箱 → 翻译 → 排版 → 眼镜\n')
      process.exit(0)
    } catch (error) {
      clearTimeout(guard)
      fail('抛异常：' + (error && error.stack ? error.stack : String(error)))
    }
  }

  // 插件与驱动都只 inject tools，谁先 apply 没有保证，所以等注册表变化
  ctx.on('tools/change', () => { void run() })
  void run()
}
