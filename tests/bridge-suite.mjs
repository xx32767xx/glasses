/**
 * bridge-suite.mjs —— ASR 桥的契约套件
 * ============================================================================
 * 桥的作用是把碎片化的 ASR 输出变成「收件箱里的一行一句话」。这里断言的就是那件事：
 * 断句规则、UTF-8（葡语重音）、协议不会被破坏、参数校验、以及 replay 端到端。
 *
 * 为什么单独一套：桥是 harness 之外的独立进程，它的正确性不等于插件的正确性；
 * 两者只共享「一行一句话」这个约定，所以约定本身必须被单独钉死。
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createInboxWriter,
  createLineAssembler,
  parseArgs,
  runBridge,
} from '../bridge/asr-bridge.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TMP = join(ROOT, '.tmp', 'bridge')
const inboxIn = name => join(TMP, name)

/** 可控时钟：让「停顿即断句」可以被确定性地测试，而不是靠 sleep 赌时间。 */
function makeFakeClock() {
  let next = 1
  const timers = new Map()
  return {
    setTimer(fn, ms) { const id = next; next += 1; timers.set(id, { fn, ms }); return id },
    clearTimer(id) { timers.delete(id) },
    pending() { return timers.size },
    /** 触发并清空所有挂起的定时器。 */
    fire() { const all = [...timers.values()]; timers.clear(); for (const t of all) t.fn() },
  }
}

export async function runBridgeSuite({ it, check, assert }) {
  await mkdir(TMP, { recursive: true })

  // ── 1. 断句规则 ────────────────────────────────────────────────────────────

  await it('装配器：换行断句，一句一行', async () => {
    const lines = []
    const asm = createLineAssembler({ onLine: t => lines.push(t) })
    asm.push('Bom dia!\n')
    asm.push('早上好！\n')
    assert.deepEqual(lines, ['Bom dia!', '早上好！'])
  })

  await it('装配器：\\r 也断句（很多 ASR CLI 用 \\r 就地刷新同一行）', async () => {
    const lines = []
    const asm = createLineAssembler({ onLine: t => lines.push(t) })
    asm.push('A reunião é às três\ro que eu ia dizer\rok\n')
    assert.deepEqual(lines, ['A reunião é às três', 'o que eu ia dizer', 'ok'])
  })

  await it('装配器：\\r\\n 不会产生一个空句', async () => {
    const lines = []
    const asm = createLineAssembler({ onLine: t => lines.push(t) })
    asm.push('primeira\r\nsegunda\r\n')
    assert.deepEqual(lines, ['primeira', 'segunda'])
  })

  await it('装配器：空白行被丢弃；一行内的多余空白被压平', async () => {
    const lines = []
    const asm = createLineAssembler({ onLine: t => lines.push(t) })
    asm.push('   \n\n')
    check('全空白的输入不产生任何句子', lines.length === 0, JSON.stringify(lines))
    asm.push('A reunião   de hoje\nsegue  confirmada\n')
    // 装配器按行切分：换行就是句子边界（这正是 ASR 给我们的信号）
    assert.deepEqual(lines, ['A reunião de hoje', 'segue confirmada'])
  })

  await it('装配器：停顿即断句（ASR 不按句换行时的唯一出路）', async () => {
    const clock = makeFakeClock()
    const lines = []
    const asm = createLineAssembler({
      flushOnPauseMs: 800, onLine: t => lines.push(t),
      setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    })
    asm.push('A reunião')
    check('还没成句', lines.length === 0, JSON.stringify(lines))
    check('挂了一个停顿定时器', clock.pending() === 1, String(clock.pending()))
    asm.push(' de hoje')
    check('继续推进入，仍然没成句', lines.length === 0)
    check('定时器被重新挂（不是堆了好几个）', clock.pending() === 1, String(clock.pending()))
    clock.fire()
    assert.deepEqual(lines, ['A reunião de hoje'])
    check('触发后定时器被清掉', clock.pending() === 0)
  })

  await it('装配器：换行会取消停顿定时器（不会重复出句）', async () => {
    const clock = makeFakeClock()
    const lines = []
    const asm = createLineAssembler({
      flushOnPauseMs: 800, onLine: t => lines.push(t),
      setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    })
    asm.push('Bom dia!\n')
    assert.deepEqual(lines, ['Bom dia!'])
    check('定时器已取消', clock.pending() === 0, String(clock.pending()))
    clock.fire()
    assert.deepEqual(lines, ['Bom dia!'], '重复出句了')
  })

  await it('装配器：flush() 把没成句的尾部作为最后一句送出', async () => {
    const lines = []
    const asm = createLineAssembler({ onLine: t => lines.push(t) })
    asm.push('sem quebra de linha')
    check('还没出句', lines.length === 0, JSON.stringify(lines))
    check('pending 能看到缓冲内容', asm.pending() === 'sem quebra de linha')
    asm.flush()
    assert.deepEqual(lines, ['sem quebra de linha'])
    check('flush 后缓冲清空', asm.pending() === '')
  })

  // ── 2. 收件箱写入器 ────────────────────────────────────────────────────────

  await it('写入器 text 格式：一行一句，葡语重音是合法 UTF-8', async () => {
    const path = inboxIn('text.jsonl')
    const writer = await createInboxWriter({ inboxPath: path, format: 'text', truncate: true })
    await writer.write('A reunião de hoje passou para as três da tarde.')
    await writer.write('我们今天的会议改到下午三点了。')
    await writer.close()

    const raw = await readFile(path, 'utf-8')
    const lines = raw.split('\n').filter(l => l !== '')
    assert.deepEqual(lines, [
      'A reunião de hoje passou para as três da tarde.',
      '我们今天的会议改到下午三点了。',
    ])
    check('重音字符没有坏掉', raw.includes('reunião') && raw.includes('três'), raw)
    check('统计对得上', writer.stats.lines === 2, JSON.stringify(writer.stats))
  })

  await it('写入器 json 格式：每行都是合法 JSON，且带上标记', async () => {
    const path = inboxIn('json.jsonl')
    const writer = await createInboxWriter({
      inboxPath: path, format: 'json', truncate: true,
      tags: { from: 'pt-BR', speaker: 'them' },
    })
    await writer.write('A reunião é às três.')
    await writer.write('Bom dia!')
    await writer.close()

    const lines = (await readFile(path, 'utf-8')).split('\n').filter(l => l !== '')
    check('写了两行', lines.length === 2, JSON.stringify(lines))
    for (const line of lines) {
      const parsed = JSON.parse(line)     // 不合法就在这里抛
      check('有 text 字段', typeof parsed.text === 'string' && parsed.text.length > 0, line)
      check('带上了 from', parsed.from === 'pt-BR', line)
      check('带上了 speaker', parsed.speaker === 'them', line)
      check('行内没有裸换行', !line.includes('\n'))
    }
  })

  await it('写入器：句内换行被压平，协议不会被一句话撑成多行', async () => {
    const path = inboxIn('sanitize.jsonl')
    const writer = await createInboxWriter({ inboxPath: path, format: 'json', truncate: true })
    await writer.write('primeira linha\nsegunda linha\r\nterceira')
    await writer.close()

    const lines = (await readFile(path, 'utf-8')).split('\n').filter(l => l !== '')
    check('还是一行', lines.length === 1, JSON.stringify(lines))
    const parsed = JSON.parse(lines[0])
    check('换行被压成空格', parsed.text === 'primeira linha segunda linha terceira', parsed.text)
  })

  await it('写入器：空白内容被跳过并计数，不写出空行', async () => {
    const path = inboxIn('blank.jsonl')
    const writer = await createInboxWriter({ inboxPath: path, format: 'text', truncate: true })
    await writer.write('   ')
    await writer.write('')
    await writer.write('válido')
    await writer.close()
    const lines = (await readFile(path, 'utf-8')).split('\n').filter(l => l !== '')
    assert.deepEqual(lines, ['válido'])
    check('跳过数记对了', writer.stats.skipped === 2, JSON.stringify(writer.stats))
  })

  await it('写入器：truncate 从空文件开始（演示时从干净的屏开始）', async () => {
    const path = inboxIn('truncate.jsonl')
    await writeFile(path, '旧内容\n应该被清掉\n', 'utf-8')
    const writer = await createInboxWriter({ inboxPath: path, format: 'text', truncate: true })
    await writer.write('nova linha')
    await writer.close()
    const raw = await readFile(path, 'utf-8')
    check('旧内容没了', !raw.includes('旧内容'), raw)
    assert.deepEqual(raw.split('\n').filter(l => l !== ''), ['nova linha'])
  })

  await it('写入器：dry-run 只打印不写盘', async () => {
    const path = inboxIn('dry.jsonl')
    await rm(path, { force: true })
    const printed = []
    const writer = await createInboxWriter({
      inboxPath: path, format: 'text', dryRun: true,
      log: { log: line => printed.push(line) },
    })
    await writer.write('não deve aparecer no arquivo')
    await writer.close()
    check('打印了一行', printed.length === 1, JSON.stringify(printed))
    check('文件没有被创建', await readFile(path, 'utf-8').then(() => false, () => true))
  })

  await it('写入器：非法标记被响亮拒绝（配置错误要响亮）', async () => {
    await assert.rejects(
      () => createInboxWriter({ inboxPath: inboxIn('x.jsonl'), tags: { from: 'en-US' } }),
      /from 只能是/,
    )
    await assert.rejects(
      () => createInboxWriter({ inboxPath: inboxIn('x.jsonl'), tags: { speaker: 'nobody' } }),
      /speaker 只能是/,
    )
    await assert.rejects(
      () => createInboxWriter({ inboxPath: inboxIn('x.jsonl'), format: 'yaml' }),
      /format 只能是/,
    )
  })

  // ── 3. 命令行参数 ──────────────────────────────────────────────────────────

  await it('parseArgs：缺 --inbox / 未知引擎 / 未知选项都给出可照做的报错', async () => {
    assert.throws(() => parseArgs([]), /必须给 --inbox/)
    assert.throws(() => parseArgs(['--inbox', 'a.jsonl', '--engine', 'magic']), /--engine 只能是/)
    assert.throws(() => parseArgs(['--inbox', 'a.jsonl', '--nope']), /未知选项/)
    assert.throws(() => parseArgs(['--inbox', 'a.jsonl', '--engine', 'command']), /需要 --command/)
    assert.throws(() => parseArgs(['--inbox', 'a.jsonl', '--engine', 'replay']), /需要 --replay/)
    assert.throws(() => parseArgs(['--inbox', 'a.jsonl', '--flush-on-pause-ms', '-1']), /非负数/)
    assert.throws(() => parseArgs(['--inbox', 'a.jsonl', '--engine']), /需要一个值/)
  })

  await it('parseArgs：whisper 引擎自带默认命令，指向随包的 Python 脚本', async () => {
    const options = parseArgs(['--inbox', 'a.jsonl', '--engine', 'whisper', '--from', 'pt-BR'])
    check('生成了默认命令', typeof options.command === 'string', String(options.command))
    check('指向 whisper_stream.py', options.command.includes('whisper_stream.py'), options.command)
    check('把语种转成了 --language pt', options.command.includes('--language pt'), options.command)
  })

  await it('parseArgs：whisper 的模型/设备/精度能透传到 Python 脚本', async () => {
    const options = parseArgs([
      '--inbox', 'a.jsonl', '--engine', 'whisper', '--from', 'pt-BR',
      '--whisper-model', 'medium', '--whisper-device', 'cuda', '--whisper-compute', 'float16',
    ])
    check('模型透传', options.command.includes('--model medium'), options.command)
    check('设备透传', options.command.includes('--device cuda'), options.command)
    check('精度透传', options.command.includes('--compute-type float16'), options.command)
  })

  await it('parseArgs：用户自己写了 --command 时不被塞进 whisper 参数', async () => {
    const options = parseArgs([
      '--inbox', 'a.jsonl', '--engine', 'whisper', '--command', 'my-asr --flag',
      '--whisper-device', 'cuda',
    ])
    check('原样执行用户的命令', options.command === 'my-asr --flag', options.command)
  })

  await it('parseArgs：--help 不需要 --inbox', async () => {
    const options = parseArgs(['--help'])
    check('help 被置位', options.help === true)
  })

  // ── 4. replay 端到端：桥真的把整段转写按行送进收件箱 ───────────────────────

  await it('replay 引擎：把样例转写按行写进收件箱，行数与原句数一致', async () => {
    const source = join(ROOT, 'bridge', 'sample-transcript.txt')
    const expected = (await readFile(source, 'utf-8'))
      .split(/\r?\n/).map(l => l.trim()).filter(l => l !== '')
    check('样例转写不是空的', expected.length >= 10, `只有 ${expected.length} 行`)

    const path = inboxIn('replay.jsonl')
    const lines = await runBridge({
      inbox: path, engine: 'replay', format: 'text', replay: source,
      replayDelayMs: 0, flushOnPauseMs: 0, truncate: true, quiet: true,
    })
    check('返回的行数对得上', lines === expected.length, `${lines} vs ${expected.length}`)

    const written = (await readFile(path, 'utf-8')).split('\n').filter(l => l !== '')
    assert.deepEqual(written, expected)
    check('中葡混排都在', written.some(l => /[\u4e00-\u9fff]/.test(l)) && written.some(l => /reuni/i.test(l)))
  })

  await it('replay + json 格式：产出的每一行插件都能直接解析', async () => {
    const source = join(ROOT, 'bridge', 'sample-transcript.txt')
    const path = inboxIn('replay-json.jsonl')
    await runBridge({
      inbox: path, engine: 'replay', format: 'json', replay: source,
      from: 'pt-BR', speaker: 'them',
      replayDelayMs: 0, flushOnPauseMs: 0, truncate: true, quiet: true,
    })
    const lines = (await readFile(path, 'utf-8')).split('\n').filter(l => l !== '')
    check('写出了多行', lines.length >= 10, String(lines.length))
    for (const line of lines) {
      const parsed = JSON.parse(line)
      check('每行都有非空 text', typeof parsed.text === 'string' && parsed.text.trim() !== '', line)
    }
    check('没有空行', lines.every(l => l.trim() !== ''))
  })

  // 收尾：清掉测试产生的收件箱
  await rm(TMP, { recursive: true, force: true })
}
