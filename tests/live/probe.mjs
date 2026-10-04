/**
 * probe.mjs —— 真实组合里的观察者
 * ============================================================================
 * 它用**真实运行时**做四件事：
 *   1. 从真实 ToolRuntime 里读出注册了什么工具（验证 plugin/index.mjs 的注册路径通了）；
 *   2. 通过真实执行流水线调 leion_selftest / 双向 leion_translate / leion_display
 *      （验证 execute / output.schema / render 在真实流水线里都成立）；
 *   3. 反向验证：缺必填参数的调用必须被真实流水线拒绝；
 *   4. ASR 收件箱端到端：往收件箱文件写一行 → **真实 timer** 轮询 → 真实流水线翻译 →
 *      中文字幕自动上屏。这条路径不需要 agent 介入，是「同传」而不是「翻译工具」的分界。
 *
 * ⚠️ 竞态：本探针和 leion-pro 插件都只 inject ['tools']，谁先 apply 没有保证。
 *    所以不能一上来就断言，而要监听 tools/change 事件等工具出现。
 *
 * 退出码：0 = 全部通过，1 = 有检查失败。
 */

import { mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createInboxWriter, createLineAssembler } from '../../bridge/asr-bridge.mjs'

export const name = 'leion-live-probe'
export const inject = ['tools']

const EXPECTED = [
  'leion_status', 'leion_display', 'leion_translate',
  'leion_history', 'leion_inbox', 'leion_clear', 'leion_selftest',
]

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export function apply(ctx, config) {
  // 收件箱路径从组合的 config 里拿（由 tests/live/composition.mjs 注入，值来自 lib/paths.mjs）。
  // 以前这里写死了 'E:/GlassesHarness/.tmp/live-inbox.jsonl'，还得靠注释提醒"要和 cordis.yml
  // 保持一致" —— 两处各存一份、靠人记着同步，迟早漂移。现在只有一处。
  const inboxPath = config?.inboxPath
  if (typeof inboxPath !== 'string' || inboxPath === '') {
    console.error('[probe] ❌ 组合的 config 里没有 inboxPath（见 tests/live/composition.mjs）')
    process.exit(1)
  }
  let finished = false

  const fail = message => {
    if (finished) return
    finished = true
    console.error('[probe] ❌ ' + message)
    process.exit(1)
  }

  const guard = setTimeout(() => {
    fail('超时：30 秒内没等到 leion_* 工具出现（大概率是插件 import 失败或停在 PENDING）')
  }, 30_000)

  const leionNames = () => ctx.tools.schemas()
    .map(s => s.name)
    .filter(n => n.startsWith('leion_'))
    .sort()

  const textOf = result => result.content.map(b => (b.type === 'text' ? b.text : '')).join('')

  async function call(name, args, callId, signal) {
    return textOf(await ctx.tools.execute({ callId, name, arguments: args, signal }))
  }

  async function runWhenReady() {
    if (finished) return
    const names = leionNames()
    if (names.length < EXPECTED.length) return
    finished = true

    try {
      console.log('[probe] ✅ 真实 ToolRuntime 里出现了 ' + names.length + ' 个 leion 工具：' + names.join(', '))
      const missing = EXPECTED.filter(n => !names.includes(n))
      if (missing.length > 0) fail('缺少工具：' + missing.join(', '))

      // 模型看到的就是这份 schema —— 确认 parameters 是从真实注册表读出来的
      const selftest = ctx.tools.schemas().find(s => s.name === 'leion_selftest')
      console.log('[probe] leion_selftest 的模型可见 schema = '
        + JSON.stringify({ name: selftest.name, parameters: selftest.parameters }))

      const signal = new AbortController().signal

      // 1) 自检：真实流水线 + 真实 timer + 真实收件箱配置下应当四条全绿
      const selfText = await call('leion_selftest', {}, 'live-probe-self', signal)
      console.log('[probe] 真实流水线渲染内容：\n' + selfText)
      if (!selfText.includes('自检')) fail('渲染内容里没有「自检」，render 可能没生效')
      if (!selfText.includes('显示通道：OK')) fail('自检的显示通道没通过')
      if (!selfText.includes('翻译路由：OK')) fail('自检的翻译路由没通过（假 llm 服务没生效？）')
      if (!selfText.includes('收件箱：OK')) fail('自检的收件箱没通过（timer / fs 服务没生效？）')

      // 2) 双向翻译：schema 最复杂的工具，让真实的 output.schema 校验器去审它
      const ptText = await call('leion_translate', { text: 'A reunião de hoje passou para as três da tarde.' }, 'live-probe-zh', signal)
      if (!ptText.includes('zh-CN')) fail('巴葡→中文的渲染里没有目标语种 zh-CN')
      console.log('[probe] leion_translate 巴葡→中文通过真实流水线（含 output.schema 校验）')

      const zhText = await call('leion_translate', { text: '我们今天的会议改到下午三点了。' }, 'live-probe-pt', signal)
      if (!zhText.includes('pt-BR')) fail('中文→巴葡的渲染里没有目标语种 pt-BR')
      if (!zhText.includes('me')) fail('中文→巴葡这一帧应当记在佩戴者名下（me）')
      console.log('[probe] leion_translate 中文→巴葡通过真实流水线（含出站通道）')

      // 3) 带参工具走真实流水线
      const rendered = await call('leion_display', { text: '真实流水线 · pipeline real', speaker: 'them', lang: 'pt-BR' }, 'live-probe-display', signal)
      if (!rendered.includes('Leion Pro')) fail('leion_display 的渲染里没有设备名')
      console.log('[probe] leion_display 通过真实流水线成功')

      // 4) 反向验证：缺必填参数必须被拒绝
      let rejected = false
      try {
        await ctx.tools.execute({ callId: 'live-probe-bad', name: 'leion_translate', arguments: {}, signal })
      } catch (error) {
        rejected = true
        console.log('[probe] 空的 leion_translate 调用被拒绝（符合预期）：' + String(error.message).slice(0, 90))
      }
      if (!rejected) fail('缺必填参数的调用居然通过了，参数校验没生效')

      // 5) ASR 桥 → 收件箱 → 真实 timer → 真实流水线 → 字幕
      //    这是「同传」的完整外部链路：桥把碎片化的 ASR 输出变成收件箱里的一行一句话，
      //    插件用真实 timer 轮询、用真实流水线翻译。
      const inboxStatus = await call('leion_inbox', { action: 'status' }, 'live-probe-inbox', signal)
      if (!inboxStatus.includes('运行中：是')) fail('收件箱没有自动启动，status 报：' + inboxStatus)
      await rm(inboxPath, { force: true })
      await mkdir(dirname(inboxPath), { recursive: true })

      // 5a) 桥的直接写入路径（json 格式，带语种与说话人标记）
      const writer = await createInboxWriter({
        inboxPath, format: 'json', tags: { from: 'pt-BR', speaker: 'them' }, truncate: true,
      })
      await writer.write('A reunião de hoje passou para as três da tarde.')
      await writer.close()
      if (writer.stats.lines !== 1) fail('桥应该写入 1 行，实际 ' + writer.stats.lines)

      // 5b) 桥的停顿断句路径：模拟 ASR 逐词到达且不换行
      const assembled = []
      const assembler = createLineAssembler({ flushOnPauseMs: 250, onLine: t => assembled.push(t) })
      for (const chunk of ['我们', '今天的', '会议', '改到', '下午', '三点了。']) {
        assembler.push(chunk)
        await sleep(40)          // 40ms < 250ms，所以不该提前断句
      }
      if (assembled.length !== 0) fail('停顿断句提前触发了：' + JSON.stringify(assembled))
      await sleep(400)           // 超过 250ms 的停顿 → 断句
      assembler.flush()
      if (assembled.length !== 1) fail('停顿断句没有交出整句：' + JSON.stringify(assembled))
      console.log('[probe] 桥把逐词到达、不换行的 ASR 输出合成一句：' + assembled[0])

      const writer2 = await createInboxWriter({ inboxPath, format: 'text' })
      for (const line of assembled) await writer2.write(line)
      await writer2.close()

      // 等真实 timer 把两行都取走并翻译完
      const deadline = Date.now() + 10_000
      let status = ''
      while (Date.now() < deadline) {
        status = await call('leion_inbox', { action: 'status' }, 'live-probe-inbox-status', signal)
        if (status.includes('已处理 2 条')) break
        await sleep(120)
      }
      if (!status.includes('已处理 2 条')) fail('桥写入的两行没有被全部处理。status：\n' + status)
      if (!status.includes('错误 0 条')) fail('收件箱出现了错误：\n' + status)
      console.log('[probe] ✅ ASR 桥端到端通过：桥写行 → 真实 timer 轮询 → 真实流水线翻译 → 已处理 2 条、错误 0 条')

      // 收尾：停掉轮询，别让子进程挂着
      await call('leion_inbox', { action: 'stop' }, 'live-probe-stop', signal)
      await rm(inboxPath, { force: true })

      clearTimeout(guard)
      console.log('[probe] ✅ 真实 Cordis 组合里全部检查通过')
      process.exit(0)
    } catch (error) {
      clearTimeout(guard)
      fail('抛异常：' + (error && error.stack ? error.stack : String(error)))
    }
  }

  // 工具注册表变化时重试；也立刻试一次，万一插件已经先 apply 完了。
  ctx.on('tools/change', () => { void runWhenReady() })
  void runWhenReady()
}
