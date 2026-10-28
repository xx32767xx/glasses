#!/usr/bin/env node
/**
 * fake-frames.mjs —— 往字幕总线写"假字幕"，让客户端在没有识别、没有大脑时也能联调。
 * ============================================================================
 *
 * <p><b>为什么要有它</b>：翻译官 App 那边（以及我们自己的界面）要联调"字幕怎么显示"，
 * 但真链路要求 GPU + faster-whisper + DSH 检出 + 翻译凭据 —— 四样缺一样就没有字幕。
 * 而 relay 的字幕来源只有一个：**字幕总线文件**（`--bus`，缺省 `<data-dir>/subtitle-bus.json`）。
 * 于是最省的假服务器就是"往那个文件里写一帧"。
 *
 * <p>它写的是**真实形状**的帧（`speaker/lang/lines/text/source/sourceLang/partial`），
 * 不是随手编的 JSON —— 客户端如果能把这份跑通，换成真链路只差数据来源。
 *
 * 用法
 *   node scripts/fake-frames.mjs --bus var/dev/subtitle-bus.json            # 一直循环（Ctrl-C 停）
 *   node scripts/fake-frames.mjs --bus <path> --once                        # 只写一帧
 *   node scripts/fake-frames.mjs --bus <path> --interval 3000 --partial     # 3 秒一帧，带增量帧
 *   node scripts/fake-frames.mjs --list                                     # 看内置脚本
 */

import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const HELP = `fake-frames —— 往字幕总线写假字幕（联调用，不需要识别/大脑/凭据）

用法
  node scripts/fake-frames.mjs --bus <字幕总线路径> [选项]

选项
  --bus <path>        字幕总线文件（要和 relay 的 --bus 指向同一个）
  --once              只写一帧就退出
  --interval <ms>     循环写时的间隔，缺省 2500
  --partial           先写一帧 partial（"生成中"），再写定稿 —— 用来验客户端的原位更新
  --file <path>       用自己的脚本文件：一行一句，格式 \`说话人|语种|原文|译文\`
  --list              打印内置脚本并退出
  --help

内置脚本覆盖了三种最容易出问题的情形：
  · 中文→葡语（对方说葡语，我听到的是葡语译文）
  · 葡语→中文
  · 长句（用来验折行 / 翻页 / auto-size）
`

/** 内置脚本：[speaker, lang, 原文, 译文] */
const SCRIPT = [
  ['them', 'pt-BR', 'Bom dia! Podemos começar a reunião agora?', '早上好！我们现在可以开始会议了吗？'],
  ['me', 'zh-CN', '可以，我先说一下今天的议程。', 'Sim, vou falar primeiro sobre a pauta de hoje.'],
  ['them', 'pt-BR', 'Sobre o pedido de cinquenta mil peças, precisamos revisar o prazo de entrega.',
    '关于五万件的订单，我们需要重新确认交货期。'],
  ['me', 'zh-CN', '交货期我们可以在本周五之前给出答复。', 'Podemos responder sobre o prazo até esta sexta-feira.'],
  ['them', 'pt-BR', 'E o pagamento? Vocês aceitam trinta por cento de antecedência?',
    '付款方式呢？你们接受百分之三十预付吗？'],
  ['me', 'zh-CN', '接受。定金到账后我们安排生产，剩下的在发货前付清。',
    'Aceitamos. Após o depósito organizamos a produção e o restante é pago antes do embarque.'],
  ['them', 'pt-BR', 'Perfeito. Também gostaríamos de incluir o treinamento da equipe no contrato.',
    '很好。我们还希望把团队培训写进合同里。'],
  ['me', 'zh-CN', '培训可以安排在下个月中旬，地点在圣保罗或者线上都可以。',
    'O treinamento pode ser no meio do mês que vem, em São Paulo ou online.'],
  // 长句：故意超过一屏，用来验折行与"显示不下时怎么办"
  ['them', 'pt-BR',
    'Antes de encerrar, queria confirmar que os equipamentos chegam ao porto de Santos até o dia quinze, '
    + 'porque a nossa equipe de instalação já está agendada para a semana seguinte e não podemos atrasar.',
    '结束之前我想确认一下：设备能否在十五号之前到达桑托斯港？因为我们的安装团队已经预约了下周，不能再拖了。'],
]

function parseArgs(argv) {
  const options = { interval: 2500, once: false, partial: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new Error(`看不懂的参数：${token}（用 --help 看用法）`)
    const key = token.slice(2)
    if (key === 'help') { options.help = true; continue }
    if (key === 'list') { options.list = true; continue }
    if (key === 'once') { options.once = true; continue }
    if (key === 'partial') { options.partial = true; continue }
    if (key === 'bus') { options.bus = argv[index + 1]; index += 1; continue }
    if (key === 'interval') { options.interval = Number(argv[index + 1]); index += 1; continue }
    if (key === 'file') { options.file = argv[index + 1]; index += 1; continue }
    throw new Error(`未知选项 --${key}（用 --help 看用法）`)
  }
  if (!options.help && !options.list && (options.bus === undefined || options.bus === '')) {
    throw new Error('必须给 --bus <字幕总线路径>（要和 relay 的 --bus 指向同一个文件）')
  }
  if (options.interval !== undefined && (!Number.isFinite(options.interval) || options.interval < 100)) {
    throw new Error(`--interval 必须是不小于 100 的毫秒数，收到 ${JSON.stringify(options.interval)}`)
  }
  return options
}

/** 原子写：relay 每 60ms 读一次这个文件，不能让它读到半截 JSON。 */
async function writeBus(busPath, frame) {
  await mkdir(dirname(busPath), { recursive: true })
  const temp = join(dirname(busPath), `.fake-bus-${process.pid}.tmp`)
  await writeFile(temp, JSON.stringify(frame, null, 2) + '\n', 'utf-8')
  await rename(temp, busPath)
}

/** 一行一句：`说话人|语种|原文|译文`（分隔符用竖线，正文里带逗号也没事）。 */
async function loadScript(file) {
  const { readFile } = await import('node:fs/promises')
  const text = await readFile(file, 'utf-8')
  const rows = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const parts = trimmed.split('|')
    if (parts.length !== 4) throw new Error(`脚本行格式应为「说话人|语种|原文|译文」：${trimmed}`)
    rows.push([parts[0].trim(), parts[1].trim(), parts[2].trim(), parts[3].trim()])
  }
  return rows
}

function buildFrame(row, partial) {
  const [speaker, lang, source, target] = row
  const text = partial ? target.slice(0, Math.max(2, Math.floor(target.length * 0.6))) : target
  return {
    // 与 plugin/core.mjs 的 buildFrame 同形：客户端只要认这些字段，换真链路就不用改
    speaker,
    lang,
    lines: [text],
    text,
    source,
    sourceLang: lang,
    termsMissing: [],
    // 增量帧必须标 partial：客户端据此打「生成中」并**原位更新**同一条片段
    partial: partial === true,
    at: new Date().toISOString(),
  }
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error('[fake-frames] ' + String(error?.message ?? error))
    process.exitCode = 2
    return
  }
  if (options.help) { process.stdout.write(HELP); return }
  if (options.list) {
    SCRIPT.forEach((row, index) => {
      console.log(`${String(index + 1).padStart(2)}. ${row[0]} / ${row[1]}\n    ${row[2]}\n    → ${row[3]}`)
    })
    return
  }

  const rows = options.file === undefined ? SCRIPT : await loadScript(options.file)
  if (rows.length === 0) throw new Error('脚本是空的：至少要有一行')

  let index = 0
  const step = async () => {
    const row = rows[index % rows.length]
    index += 1
    if (options.partial) {
      await writeBus(options.bus, buildFrame(row, true))
      console.log(`[fake-frames] 增量：${row[3].slice(0, 20)}…`)
      await new Promise(resolve => setTimeout(resolve, Math.min(600, options.interval / 2)))
    }
    const frame = buildFrame(row, false)
    await writeBus(options.bus, frame)
    console.log(`[fake-frames] 定稿[${frame.speaker}/${frame.lang}] ${frame.text}`)
  }

  if (options.once) {
    await step()
    return
  }

  console.log(`[fake-frames] 写入 ${options.bus}，每 ${options.interval}ms 一帧（Ctrl-C 停）`)
  for (;;) {
    await step()
    await new Promise(resolve => setTimeout(resolve, options.interval))
  }
}

if (process.argv[1] !== undefined && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  await main()
}
