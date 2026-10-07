/**
 * bench-models.mjs —— 翻译模型横评：同一批中文句子，喂给多个模型，出对比表
 * ============================================================================
 *
 *   node scripts/bench-models.mjs --list                # 看有哪些候选与句子
 *   node scripts/bench-models.mjs --dry-run             # 只打印将要发出去的请求（不花钱）
 *   node scripts/bench-models.mjs                       # 全部候选 × 全部句子
 *   node scripts/bench-models.mjs --model deepseek      # 只测一个
 *   node scripts/bench-models.mjs --markdown out.md     # 同时写一份能贴进汇报的表
 *
 * 为什么要有它：调研表已经把"有哪些模型"列全了，现在唯一的未知数是
 * **哪个模型真的能把中文说成人话巴葡**。这个只能测，查不出来。
 *
 * 三条设计原则（都是踩过坑才有的）：
 *
 *  ① **提示词必须与产线一致**：system 提示词来自 `plugin/core.mjs` 的
 *     `translationSystem()`（唯一来源是 `policy/br-pt.json`）。手抄一份到测试脚本里
 *     一定会漂移，量出来的就不是产线效果。要测"光模型行不行"用 `--no-system`。
 *
 *  ② **判据必须自动**：数字、葡葡说法、超显示预算、回显原文 —— 这些用代码判，
 *     不靠人看。尤其"出现欧葡词"是方案里点名的版本纯净度硬要求，一票否决。
 *
 *  ③ **必须能重复跑**：模型有随机性（实测同一批跑两遍会有 10/18 条文本不同），
 *     所以支持 `--repeat N` 看**稳定性**，而不是拿单次结果下结论。
 *
 * 注意：这里的"延迟"是**纯翻译延迟**（一句话文本进、译文出），
 * 不含收音、识别、显示。端到端延迟是另一件事，见 docs/06。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { PHRASES, inspect } from './test-phrases.mjs'
import { translationSystem } from '../plugin/core.mjs'

const policy = JSON.parse(readFileSync(join(process.cwd(), 'policy', 'br-pt.json'), 'utf8'))

/**
 * 找 API key：先环境变量，再 DSH 的凭证文件，最后仓库根目录的 `.env`。
 *
 * 为什么要这一层：DSH 把 DeepSeek 的 key 放在 `~/.dsh/.credentials.yaml` 里，
 * **不在环境变量里** —— 不兼容它的话，连"产线在用"的那个基线都测不了，
 * 而那恰恰是最该先测的一个。
 *
 * 只读不写，也**不打印 key 本身**（只打印"有没有"）。
 */
export function findKey(name) {
  const fromEnv = process.env[name]
  if (fromEnv !== undefined && fromEnv !== '') return { value: fromEnv, from: '环境变量' }

  const credentials = join(homedir(), '.dsh', '.credentials.yaml')
  if (existsSync(credentials)) {
    const found = readYamlFlat(credentials)[name]
    if (found !== undefined && found !== '') return { value: found, from: credentials }
  }

  const dotenv = join(process.cwd(), '.env')
  if (existsSync(dotenv)) {
    const found = readYamlFlat(dotenv)[name]
    if (found !== undefined && found !== '') return { value: found, from: dotenv }
  }
  return { value: '', from: null }
}

/** 只认 `KEY: value` / `KEY=value` 这种平铺写法 —— 够用，而且不引 YAML 依赖。 */
function readYamlFlat(path) {
  const out = {}
  let raw = ''
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return out
  }
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_]+)\s*[:=]\s*(.+?)\s*$/.exec(line)
    if (match === null) continue
    out[match[1]] = match[2].replace(/^["']|["']$/g, '')
  }
  return out
}

// ── 候选模型 ────────────────────────────────────────────────────────────────
//
// baseUrl 一律是 **OpenAI 兼容**的 /chat/completions。
// model 字段是**要核对**的东西：平台上的模型 ID 可能与厂商发布的仓库名不同，
// 发错了会得到 404 —— 所以 `--list` 会把它们打出来，先用 `--dry-run` 看一眼再跑。

export const CANDIDATES = [
  {
    key: 'deepseek',
    label: 'DeepSeek（现状基线）',
    tier: 'close',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    note: '产线在用的。必须先测它 —— 如果基线够好，整件事就不用换模型了',
  },
  {
    key: 'hunyuan-mt',
    label: 'Hunyuan-MT-7B（腾讯 · 翻译专用）',
    tier: 'open',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'tencent/Hunyuan-MT-7B',
    apiKeyEnv: 'SILICONFLOW_API_KEY',
    note: '调研表里没有的：翻译专用模型、33 语种、官方称 WMT25 拿 30 个语种第一。7B → 将来可本地部署、数据不出域',
  },
  {
    key: 'hy-mt-1.5-7b',
    label: 'HY-MT1.5-7B（腾讯 · 翻译专用 · 新版）',
    tier: 'open',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'tencent/HY-MT1.5-7B',
    apiKeyEnv: 'SILICONFLOW_API_KEY',
    note: '混元 1.5 代：官方称"效果超越商用 API"，仍是 33 语种。与上一代正面比 —— 同门两代谁更适合巴葡',
  },
  {
    key: 'hy-mt-1.5-1.8b',
    label: 'HY-MT1.5-1.8B（腾讯 · 端侧可部署）',
    tier: 'open',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'tencent/HY-MT1.5-1.8B',
    apiKeyEnv: 'SILICONFLOW_API_KEY',
    note: '只有 1.8B，官方称"手机 1GB 内存就能跑、效果超商用 API"。如果它够用，整条链路可以搬到端侧 —— 零云端成本、数据不出域，这是最有战略价值的一条',
  },
  {
    key: 'qwen',
    label: 'Qwen 通用大模型（开源对照）',
    tier: 'open',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-72B-Instruct',
    apiKeyEnv: 'SILICONFLOW_API_KEY',
    note: '中文母语团队做的通用 LLM。用来回答"专用翻译模型比通用模型强多少"',
  },
]

// ── 打分 ────────────────────────────────────────────────────────────────────

/**
 * 把 inspect 的 notes 折成一条结论。
 *
 * ❌ 的判据刻意收得很紧 —— 同传里这几类错是**事故级**的：
 *    不回译（用户完全看不懂）、出现葡葡词（方案点名的硬约束）、
 *    回显原文 / 假字幕（等于没翻）、加解释（屏幕上多出一段话）。
 */
export function verdictOf(source, translation, terminology) {
  const result = inspect(source, translation, { cols: 40, lineBudget: 3, terminology, sourceIsChinese: true })
  const bad = result.notes.filter(note => note.level === 'bad')
  const warn = result.notes.filter(note => note.level === 'warn')
  const fatal = []

  const trimmed = String(translation).trim()
  if (trimmed === '') fatal.push('空译文')
  else if (trimmed === String(source).trim()) fatal.push('没翻译（原样回显了中文）')
  else if (/\p{Script=Han}/u.test(trimmed)) fatal.push('译文里还有汉字（没译完或回显原文）')
  else if (/^(以下是|下面是|翻译|译文)[:：]/.test(trimmed)) fatal.push('加了前言（同传里这是多余的）')

  for (const note of bad) {
    if (note.text.startsWith('出现葡葡说法')) fatal.push('欧葡词')
    if (note.text.startsWith('命中幻听惯用语')) fatal.push('幻听')
    if (note.text.startsWith('提示词被回显')) fatal.push('提示词回显')
  }

  return { fatal, bad, warn, wrapped: result.wrapped, shown: result.shown, notes: result.notes }
}

// ── 自检：判据本身对不对 ────────────────────────────────────────────────────
//
// ⚠️ 这一节是**负对照**，别删。
// 判据写错的话，横评表会很好看但全是假的 —— 比如把 `tu` 当子串匹配，
// 就会把「faturamento」「tudo」判成欧葡词（真踩过，见 test-phrases.mjs 的注释）。
// 所以每次开跑前先用一批**答案已知**的输入验一遍判据。

export function selfCheck(terminology) {
  const cases = [
    { name: '正常巴葡 → 不该报错',
      text: 'Você pode pegar ônibus ou metrô, e comprar a passagem pelo celular.', expect: 'ok' },
    { name: '句尾小词不误报 → 不该报错',
      text: 'O faturamento foi de 270 milhões e tudo deu certo.', expect: 'ok' },
    { name: 'parâmetro 里的 metro 不误报 → 不该报错',
      text: 'Precisa passar dois parâmetros para a função.', expect: 'ok' },
    { name: 'equipamentos 里的 equipa 不误报 → 不该报错',
      text: 'Os equipamentos chegaram ontem.', expect: 'ok' },
    { name: '欧葡词 telemóvel → 必须报错',
      text: 'Comprei um telemóvel novo.', expect: 'fatal' },
    { name: '欧葡词 autocarro → 必须报错',
      text: 'Vou de autocarro para o centro.', expect: 'fatal' },
    { name: '没翻译（回显中文）→ 必须报错',
      text: '我们今天的会议改到了下午三点。', expect: 'fatal' },
    { name: '加了前言 → 必须报错',
      text: '译文：A reunião de hoje mudou para as três da tarde.', expect: 'fatal' },
    { name: '空译文 → 必须报错',
      text: '   ', expect: 'fatal' },
  ]
  const problems = []
  for (const item of cases) {
    const judged = verdictOf('我们今天的会议改到了下午三点。', item.text, terminology)
    const actual = judged.fatal.length > 0 ? 'fatal' : 'ok'
    if (actual !== item.expect) {
      problems.push(`${item.name}：期望 ${item.expect}，实际 ${actual}`
        + (judged.fatal.length > 0 ? `（${judged.fatal.join('、')}）` : ''))
    }
  }
  return problems
}

// ── 核对模型 ID ─────────────────────────────────────────────────────────────
//
// ⚠️ 这一步不是可有可无的洁癖。平台上的模型 ID 与厂商发布的仓库名**经常不一样**，
// 写错了只会得到一个 404，很容易被误读成"这个模型不能用/平台没有"。
// 所以先问平台"你到底有哪些"，再决定发什么。
//
// ⚠️ 但 /models 这个列表**不能当判据**：实测 DeepSeek 的 /models 只回 2 个名字
//    （deepseek-flash / deepseek-v4-pro），而产线一直在用的 deepseek-chat 并不在其中
//    —— 它照样能调通（HTTP 200）。所以这里只做**提示**（"列表里没有，相近的是…"），
//    绝不因为"列表里没有"就拦下候选。真正说话算数的是那次实际请求。 

async function listPlatformModels(baseUrl, apiKeyEnv) {
  const key = findKey(apiKeyEnv)
  if (key.value === '') return { ok: false, failure: `拿不到 ${apiKeyEnv}` }
  try {
    const response = await fetch(baseUrl + '/models', {
      headers: { authorization: 'Bearer ' + key.value },
      signal: AbortSignal.timeout(20000),
    })
    if (response.ok !== true) return { ok: false, failure: `HTTP ${response.status}：${(await response.text()).slice(0, 200)}` }
    const parsed = JSON.parse(await response.text())
    return { ok: true, ids: (parsed.data ?? []).map(item => item.id) }
  } catch (error) {
    return { ok: false, failure: String(error && error.message ? error.message : error) }
  }
}

export async function verifyModels(candidates) {
  const byBase = new Map()
  for (const candidate of candidates) {
    if (byBase.has(candidate.baseUrl) === false) byBase.set(candidate.baseUrl, [])
    byBase.get(candidate.baseUrl).push(candidate)
  }
  const report = []
  for (const [baseUrl, group] of byBase) {
    const listed = await listPlatformModels(baseUrl, group[0].apiKeyEnv)
    if (listed.ok !== true) {
      for (const candidate of group) {
        report.push({ key: candidate.key, model: candidate.model, status: 'unlisted',
          detail: listed.failure, suggestions: [] })
      }
      continue
    }
    for (const candidate of group) {
      report.push({
        key: candidate.key, model: candidate.model,
        // 'exact' = 平台列表里有；'unlisted' = 列表里没有（只提示，不拦）
        status: listed.ids.includes(candidate.model) ? 'exact' : 'unlisted',
        suggestions: listed.ids.filter(id => roughlyMatches(id, candidate.model)).slice(0, 5),
        total: listed.ids.length,
      })
    }
  }
  return report
}

/** 宽松匹配：只看模型名里最后一段，忽略大小写与连字符。 */
function roughlyMatches(id, model) {
  const tail = value => String(value).split('/').pop().toLowerCase().replace(/[-_.]/g, '')
  const wanted = tail(model)
  return tail(id).includes(wanted.slice(0, 6)) || wanted.includes(tail(id).slice(0, 6))
}

// ── 调模型 ──────────────────────────────────────────────────────────────────

export async function callModel(candidate, systemPrompt, text, options, presetKey) {
  const key = presetKey === undefined ? findKey(candidate.apiKeyEnv) : { value: presetKey, from: '调用方传入' }
  if (key.value === '') {
    return { ok: false, failure: `拿不到 ${candidate.apiKeyEnv}`
      + `（环境变量、~/.dsh/.credentials.yaml、仓库根的 .env 里都没有）`, skipped: true }
  }
  const body = {
    model: candidate.model,
    messages: (systemPrompt === null ? [] : [{ role: 'system', content: systemPrompt }])
      .concat([{ role: 'user', content: text }]),
    temperature: options.temperature,
    max_tokens: options.maxTokens,
    stream: false,
  }
  const started = Date.now()
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs)
    let response
    try {
      response = await fetch(candidate.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key.value },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    const elapsed = Date.now() - started
    const raw = await response.text()
    if (response.ok !== true) {
      return { ok: false, elapsed, failure: `HTTP ${response.status}：${raw.slice(0, 300)}` }
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { ok: false, elapsed, failure: '返回的不是 JSON：' + raw.slice(0, 200) }
    }
    const choice = (parsed.choices ?? [])[0]
    const content = choice === undefined ? undefined : choice.message?.content
    if (typeof content !== 'string') {
      return { ok: false, elapsed, failure: '返回里没有 choices[0].message.content：' + raw.slice(0, 200) }
    }
    return { ok: true, elapsed, text: content.trim(), usage: parsed.usage ?? null, model: parsed.model ?? candidate.model }
  } catch (error) {
    const aborted = error !== null && typeof error === 'object' && error.name === 'AbortError'
    return {
      ok: false,
      elapsed: Date.now() - started,
      failure: aborted ? `超时（${options.timeoutMs}ms）` : String(error && error.message ? error.message : error),
    }
  }
}

// ── 参数 ────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const options = {
    models: null, only: null, repeat: 1, temperature: 0.2, maxTokens: 512,
    timeoutMs: 60000, system: true, list: false, dryRun: false, verify: false,
    markdown: null, json: null,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--list') { options.list = true; continue }
    if (token === '--dry-run') { options.dryRun = true; continue }
    if (token === '--verify-models') { options.verify = true; continue }
    if (token === '--no-system') { options.system = false; continue }
    if (token === '--model') { options.models = String(argv[++index]).split(','); continue }
    if (token === '--only') { options.only = Number(argv[++index]); continue }
    if (token === '--repeat') { options.repeat = Number(argv[++index]); continue }
    if (token === '--temperature') { options.temperature = Number(argv[++index]); continue }
    if (token === '--max-tokens') { options.maxTokens = Number(argv[++index]); continue }
    if (token === '--timeout') { options.timeoutMs = Number(argv[++index]); continue }
    if (token === '--markdown') { options.markdown = argv[++index]; continue }
    if (token === '--json') { options.json = argv[++index]; continue }
    throw new Error('看不懂的参数：' + token)
  }
  return options
}

// ── 输出 ────────────────────────────────────────────────────────────────────

/** 表格里的单元格不能带竖线，不然表格会散架。 */
function cell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function pct(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const at = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[at]
}

export function toMarkdown(rows, options) {
  const byModel = new Map()
  for (const row of rows) {
    if (byModel.has(row.model) === false) byModel.set(row.model, [])
    byModel.get(row.model).push(row)
  }
  const lines = []
  lines.push('| 模型 | 句数 | ❌ 事故 | 平均 | P50 | P95 | 欧葡词 | 数字丢失 | 超 3 行 |')
  lines.push('|---|---|---|---|---|---|---|---|---|')
  for (const [model, list] of byModel) {
    const done = list.filter(row => row.ok)
    const latencies = done.map(row => row.elapsed)
    const fatal = list.reduce((sum, row) => sum + row.fatal.length, 0)
    const eu = list.reduce((sum, row) => sum + row.fatal.filter(f => f === '欧葡词').length, 0)
    const digits = list.reduce((sum, row) => sum +
      row.notes.filter(n => n.text.startsWith('数字可能丢了')).length, 0)
    const over = list.filter(row => row.wrapped.length > 3).length
    const average = latencies.length === 0 ? '—' : Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) + 'ms'
    lines.push('| ' + [
      cell(model), list.length, fatal,
      average,
      latencies.length === 0 ? '—' : pct(latencies, 50) + 'ms',
      latencies.length === 0 ? '—' : pct(latencies, 95) + 'ms',
      eu, digits, over,
    ].join(' | ') + ' |')
  }
  lines.push('')
  if (options.system === false) lines.push('> 注：这次是 **--no-system**，没给产线提示词，测的是"光模型自己行不行"。')
  return lines.join('\n')
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const phrases = options.only === null ? PHRASES : [PHRASES[options.only - 1]]

  // 先验判据，再花钱调模型 —— 判据坏了的话，表再好看也没意义。
  const problems = selfCheck(policy.terminology)
  if (problems.length > 0) {
    console.log('✗ 判据自检没过（先修判据，再测模型）：')
    problems.forEach(problem => console.log('  · ' + problem))
    process.exitCode = 1
    return
  }
  console.log(`判据自检：9 项通过（含"不该误报"的负对照）`)

  if (options.list) {
    console.log('候选模型：')
    for (const candidate of CANDIDATES) {
      const key = findKey(candidate.apiKeyEnv)
      console.log(`  ${candidate.key.padEnd(14)} ${candidate.label}`)
      console.log(`  ${''.padEnd(14)} ${candidate.baseUrl}  model=${candidate.model}`)
      console.log(`  ${''.padEnd(14)} key=${candidate.apiKeyEnv} ${key.value === '' ? '❌ 没找到' : '✅ 找到了（来自 ' + key.from + '）'}`)
      console.log(`  ${''.padEnd(14)} ${candidate.note}`)
    }
    console.log('')
    console.log(`句子：${phrases.length} 条（用 --only N 只跑一条）`)
    phrases.forEach((phrase, index) => console.log(`  [${index + 1}] ${phrase.group} —— ${phrase.why}`))
    return
  }

  const candidates = CANDIDATES.filter(candidate =>
    options.models === null || options.models.includes(candidate.key))
  if (candidates.length === 0) {
    console.log('没有匹配的候选模型。用 --list 看有哪些。')
    return
  }

  // 先核对模型 ID，再花钱 —— 404 很容易被误读成"这个模型平台没有"。
  // --dry-run 时跳过（干跑就该不联网）。
  if (options.dryRun === false) {
    console.log('核对模型 ID（只做提示：平台的 /models 列表不完整，能调通才算数）：')
    for (const row of await verifyModels(candidates)) {
      if (row.status === 'exact') {
        console.log(`  ✅ ${row.key}  ${row.model}`)
      } else {
        console.log(`  ⚠️  ${row.key}  ${row.model} —— 平台的模型列表里没有它（共 ${row.total ?? '?'} 个）`)
        if ((row.suggestions ?? []).length > 0) console.log(`     相近的：${row.suggestions.join('、')}`)
        if (row.detail !== undefined) console.log(`     列表没拿到：${row.detail}`)
      }
    }
    if (options.verify) return
  }

  const systemPrompt = options.system ? translationSystem(policy, 'zh-CN', 'pt-BR') : null

  if (options.dryRun) {
    console.log('将要发出的请求（不花钱）：')
    console.log('─'.repeat(72))
    console.log('system 提示词（' + (systemPrompt === null ? '未使用' : systemPrompt.length + ' 字符') + '）：')
    console.log(systemPrompt === null ? '  （--no-system）' : systemPrompt.split('\n').map(l => '  ' + l).join('\n'))
    console.log('─'.repeat(72))
    for (const candidate of candidates) {
      const key = findKey(candidate.apiKeyEnv)
      console.log(`${candidate.key}: POST ${candidate.baseUrl}/chat/completions  model=${candidate.model}  key=${candidate.apiKeyEnv} ${key.value === '' ? '❌ 没找到' : '✅'}`)
    }
    console.log('─'.repeat(72))
    console.log(`共 ${candidates.length} 个模型 × ${phrases.length} 句 × ${options.repeat} 遍 = ${candidates.length * phrases.length * options.repeat} 次请求`)
    return
  }

  const rows = []
  for (const candidate of candidates) {
    console.log('')
    console.log('═'.repeat(72))
    console.log(`${candidate.label}   model=${candidate.model}`)
    console.log('═'.repeat(72))
    for (let index = 0; index < phrases.length; index += 1) {
      const phrase = phrases[index]
      for (let round = 1; round <= options.repeat; round += 1) {
        const result = await callModel(candidate, systemPrompt, phrase.text, options)
        if (result.skipped === true) {
          console.log(`  ⏭  ${result.failure} —— 跳过 ${candidate.key}`)
          break
        }
        if (result.ok !== true) {
          console.log(`  [${index + 1}] ✗ ${result.failure}`)
          rows.push({ model: candidate.key, index: index + 1, round, ok: false, failure: result.failure,
            fatal: ['请求失败'], notes: [], wrapped: [], shown: [], source: phrase.text })
          continue
        }
        const judged = verdictOf(phrase.text, result.text, policy.terminology)
        const mark = judged.fatal.length > 0 ? '❌' : judged.warn.length > 0 ? '⚠️' : '✅'
        const tag = options.repeat > 1 ? ` (第 ${round} 遍)` : ''
        console.log(`  [${index + 1}] ${mark} ${result.elapsed}ms${tag}  ${result.text}`)
        if (judged.fatal.length > 0) console.log(`       ❌ ${judged.fatal.join('、')}`)
        if (judged.wrapped.length > 3) console.log(`       折行 ${judged.wrapped.length} 行 > 3（眼镜上会丢开头 ${judged.wrapped.length - 3} 行）`)
        rows.push({
          model: candidate.key, index: index + 1, round, ok: true, elapsed: result.elapsed,
          text: result.text, usage: result.usage, source: phrase.text,
          fatal: judged.fatal, notes: judged.notes, wrapped: judged.wrapped, shown: judged.shown,
        })
      }
    }
  }

  console.log('')
  console.log('═'.repeat(72))
  console.log('汇总')
  console.log('═'.repeat(72))
  console.log(toMarkdown(rows, options))

  if (options.json !== null) {
    writeFileSync(options.json, JSON.stringify({ generatedAt: new Date().toISOString(),
      options, candidates: candidates.map(c => c.key), rows }, null, 2), 'utf8')
    console.log(`原始结果已写出：${options.json}`)
  }
  if (options.markdown !== null) {
    writeFileSync(options.markdown, toMarkdown(rows, options) + '\n', 'utf8')
    console.log(`对比表已写出：${options.markdown}`)
  }
}

const invoked = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))
if (invoked) {
  main().catch(error => {
    console.error('跑批失败：' + String(error && error.stack ? error.stack : error))
    process.exitCode = 1
  })
}
