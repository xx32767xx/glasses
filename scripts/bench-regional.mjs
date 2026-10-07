/**
 * bench-regional.mjs —— 巴葡区域变体：同一件事的四种说法，看模型认不认
 * ============================================================================
 *
 *   node scripts/bench-regional.mjs --list
 *   node scripts/bench-regional.mjs --dry-run
 *   node scripts/bench-regional.mjs --model deepseek
 *
 * 为什么要有它：方案把"巴葡口音适配（圣保罗、里约、南部、东北部）"列为**核心指标**，
 * 而现有的句集（test-phrases.mjs）**一条都没覆盖** —— 那 18 句都是标准书面中文，
 * 测的是"从句会不会翻丢""数字保不保留"，跟区域变体无关。
 *
 * ⚠️ 这里测的是**文本**层面的区域变体，不是口音。真正的口音要靠真实录音，
 *    那是下一步（把同一位说话人的录音换成不同口音）。但文本这一层现在就能测，
 *    而且能先回答一个更基础的问题：**模型认不认得这些区域说法。**
 *
 * 诚实的边界：下面这些句子是我按"各区域口语习惯"造的，**不是从真实语料里取的**。
 * 所以它们能测出"模型完全不认识某个区域说法"这类硬伤，但不能代替真实录音评测。
 * 造得对不对，最好请一位巴葡母语者过一遍 —— 这一条我做不到，只能标出来。
 *
 * 每组的判据分两层：
 *   · **必须听懂**（hard）：听不懂就说明这个区域说法模型是盲的
 *   · **不必须**（soft）：用了别的区域的同义词也算对 —— 巴葡内部有变体是正常的，
 *     我们要的是"巴葡"，不是"某一个州的巴葡"
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { translationSystem } from '../plugin/core.mjs'
import { verdictOf, findKey, callModel, CANDIDATES } from './bench-models.mjs'

const policy = JSON.parse(readFileSync(join(process.cwd(), 'policy', 'br-pt.json'), 'utf8'))

/**
 * 区域变体组。每组是"同一件事"的多种说法。
 *
 * `expectAny` 里任一词出现即算听懂 —— 故意放宽，因为区域变体本来就不唯一。
 * `why` 写清"这里到底在测什么"，不然跑完看不懂结果。
 */
export const REGIONAL = [
  {
    region: '圣保罗 / 通用东南部',
    why: '最主流的口语。混用 você / a gente / 缩略语，看译文是不是也自然地用巴葡口语，而不是书面直译',
    items: [
      { text: '咱们这事儿啊，明天上午碰个头聊一下呗。', expectAny: ['a gente', 'amanhã', 'conversar', 'falar'] },
      { text: '这玩意儿挺贵的，咱还是别买了。', expectAny: ['caro', 'não', 'comprar'] },
    ],
  },
  {
    region: '里约',
    why: '里约口语缩略多、语气词多（né、cara、pra）。看模型会不会被这些词绊住、或者把语气词当实词翻出来',
    items: [
      { text: '这事儿说白了就是这样，你懂我意思吧？', expectAny: ['entende', 'quer dizer', 'é isso'] },
      { text: '他那人就那样，你别往心里去。', expectAny: ['não', 'ligar', 'jeito'] },
    ],
  },
  {
    region: '南部（南里奥格兰德 / 圣卡塔琳娜）',
    why: '南部受意德移民影响，且**部分地区用 tu**（这是术语表里"用 você 不用 tu"的唯一合理例外）。看模型知不知道这个例外，还是一刀切',
    items: [
      { text: '你干啥呢？过来帮个忙。', expectAny: ['ajudar', 'fazer', 'vem'] },
      { text: '咱家的老房子在乡下，周末回去一趟。', expectAny: ['casa', 'interior', 'fim de semana', 'voltar'] },
    ],
  },
  {
    region: '东北部',
    why: '东北部口语有一套自己的说法（如 oxe / vixe 这类感叹），且语序更松散。看模型遇到纯区域感叹词会不会硬翻成人话',
    items: [
      { text: '哎哟，这事儿可真是不好办啊。', expectAny: ['difícil', 'complicado', 'resolver'] },
      { text: '走，咱们去赶集。', expectAny: ['feira', 'vamos', 'ir'] },
    ],
  },
  {
    region: '口语缩略与连读（跨区域）',
    why: '这是真实语音识别最容易漏掉的一类：口语缩略在**文本**里就不完整，模型得能补回来。同时也测"识别出来的残缺文本"会不会被硬翻',
    items: [
      { text: '咱下午开会，三点，别忘了。', expectAny: ['reunião', 'três', 'esquecer'] },
      { text: '这价格，能不能再压一压？', expectAny: ['preço', 'baixar', 'desconto', 'menos'] },
    ],
  },
]

// ── 判定 ────────────────────────────────────────────────────────────────────

export function judgeRegional(translation, item) {
  const found = item.expectAny.filter(word => new RegExp(escapeRegExp(word), 'iu').test(translation))
  return { found, ok: found.length > 0 }
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── 参数 ────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const options = {
    models: null, region: null, temperature: 0.2, maxTokens: 512,
    timeoutMs: 60000, system: true, list: false, dryRun: false, json: null,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--list') { options.list = true; continue }
    if (token === '--dry-run') { options.dryRun = true; continue }
    if (token === '--no-system') { options.system = false; continue }
    if (token === '--model') { options.models = String(argv[++index]).split(','); continue }
    if (token === '--region') { options.region = Number(argv[++index]); continue }
    if (token === '--temperature') { options.temperature = Number(argv[++index]); continue }
    if (token === '--max-tokens') { options.maxTokens = Number(argv[++index]); continue }
    if (token === '--timeout') { options.timeoutMs = Number(argv[++index]); continue }
    if (token === '--json') { options.json = argv[++index]; continue }
    throw new Error('看不懂的参数：' + token)
  }
  return options
}

function flatItems(options) {
  const groups = options.region === null ? REGIONAL : [REGIONAL[options.region - 1]]
  return groups.flatMap(group => group.items.map(item => ({ ...item, region: group.region, why: group.why })))
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const items = flatItems(options)

  if (options.list) {
    for (const group of REGIONAL) {
      console.log(`── ${group.region} ──`)
      console.log(`   为什么测：${group.why}`)
      group.items.forEach(item => console.log(`   · ${item.text}`))
      console.log('')
    }
    console.log(`共 ${items.length} 句，${REGIONAL.length} 个区域组`)
    return
  }

  const candidates = CANDIDATES.filter(candidate =>
    options.models === null || options.models.includes(candidate.key))
  const systemPrompt = options.system ? translationSystem(policy, 'zh-CN', 'pt-BR') : null

  if (options.dryRun) {
    console.log('将要发出的请求（不花钱）：')
    for (const candidate of candidates) {
      const key = findKey(candidate.apiKeyEnv)
      console.log(`  ${candidate.key}: POST ${candidate.baseUrl}/chat/completions  model=${candidate.model}`
        + `  key=${candidate.apiKeyEnv} ${key.value === '' ? '❌ 没找到' : '✅'}`)
    }
    console.log(`  ${candidates.length} 个模型 × ${items.length} 句 = ${candidates.length * items.length} 次请求`)
    return
  }

  const rows = []
  for (const candidate of candidates) {
    const key = findKey(candidate.apiKeyEnv)
    if (key.value === '') {
      console.log(`⏭  ${candidate.key}：拿不到 ${candidate.apiKeyEnv}，跳过`)
      continue
    }
    console.log('')
    console.log('═'.repeat(72))
    console.log(`${candidate.label}   model=${candidate.model}`)
    console.log('═'.repeat(72))
    let group = ''
    for (const item of items) {
      if (item.region !== group) {
        group = item.region
        console.log(`── ${group} ──`)
      }
      const response = await callModel(candidate, systemPrompt, item.text, options, key.value)
      if (response.ok !== true) {
        console.log(`  ✗ ${item.text}\n     ${response.failure}`)
        rows.push({ model: candidate.key, region: item.region, source: item.text, ok: false,
          failure: response.failure, found: [] })
        continue
      }
      const regional = judgeRegional(response.text, item)
      // 区域懂不懂是一层；口径对不对（有没有冒出葡葡词）是另一层，两层分开报。
      const judged = verdictOf(item.text, response.text, policy.terminology)
      const mark = regional.ok ? (judged.fatal.length > 0 ? '⚠️' : '✅') : '❌'
      console.log(`  ${mark} ${response.elapsed}ms  ${item.text}`)
      console.log(`       → ${response.text}`)
      if (regional.ok === false) {
        console.log(`       ❌ 没听懂这一地区的说法（期待出现以下任一：${item.expectAny.join(' / ')}）`)
      } else {
        console.log(`       ✅ 认出来了：${regional.found.join('、')}`)
      }
      if (judged.fatal.length > 0) console.log(`       ❌ 口径问题：${judged.fatal.join('、')}`)
      rows.push({ model: candidate.key, region: item.region, source: item.text, ok: true,
        elapsed: response.elapsed, text: response.text, found: regional.found,
        regionalOk: regional.ok, fatal: judged.fatal })
    }
  }

  if (rows.length === 0) {
    console.log('')
    console.log('一句都没跑成 —— 一个能用的 key 都没有。用 --dry-run 看缺哪个。')
    return
  }

  console.log('')
  console.log('═'.repeat(72))
  console.log('汇总（区域说法听懂率）')
  console.log('═'.repeat(72))
  console.log('| 模型 | 区域 | 听懂 | 句数 | 口径事故 |')
  console.log('|---|---|---|---|---|')
  const seen = new Set()
  for (const row of rows) {
    const id = row.model + '|' + row.region
    if (seen.has(id)) continue
    seen.add(id)
    const group = rows.filter(other => other.model === row.model && other.region === row.region)
    const understood = group.filter(other => other.ok && other.regionalOk).length
    const fatal = group.reduce((sum, other) => sum + (other.fatal ?? []).length, 0)
    console.log(`| ${row.model} | ${row.region} | ${understood} | ${group.length} | ${fatal} |`)
  }

  if (options.json !== null) {
    writeFileSync(options.json, JSON.stringify({ generatedAt: new Date().toISOString(), options, rows }, null, 2), 'utf8')
    console.log(`\n原始结果已写出：${options.json}`)
  }
}

const invoked = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))
if (invoked) {
  main().catch(error => {
    console.error('跑批失败：' + String(error && error.stack ? error.stack : error))
    process.exitCode = 1
  })
}
