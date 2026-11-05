#!/usr/bin/env node
/**
 * asr-model-switch.mjs —— 服务器端一条命令换识别模型（5.68）
 * ============================================================================
 *
 * 为什么要有它：手机端那条链路（配置页选 → 房间侧车 → 识别）已经能跑通，但每验一次都要
 * "改配置 → 开始 → 说话"，来回几轮太慢；而做模型对比本质上只关心**现在用哪个模型**。
 * 那就让服务器说了算 —— 用户 2026-11 原话：「如果还是有问题，可以放弃手机端控制」。
 *
 * 改的是 `<数据目录>/asr-models.json` 的 `languages[语种]`：
 *   ① 立刻影响之后的所有段（识别侧按 mtime 热读，**不用重启**）；
 *   ② 这是**唯一**的决定点 —— 5.108 起"房间侧车"那一层已整层删除（`--room` 也随之取消）。
 *
 * 用法
 *   node scripts/asr-model-switch.mjs --data-dir /var/lib/leion/test --model tiny
 *   node scripts/asr-model-switch.mjs --data-dir /var/lib/leion/test --lang pt-BR --model small
 *   node scripts/asr-model-switch.mjs --data-dir /var/lib/leion/test --model ""     # 还原成表里的默认
 *   node scripts/asr-model-switch.mjs --data-dir /var/lib/leion/test --strategy en-parakeet
 *       ↑ 换**引擎/整套策略**（parakeet、tencent 这些只能这样切；--model 只换模型名）
 *   node scripts/asr-model-switch.mjs --data-dir /var/lib/leion/test              # 只看现在是什么
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ENGINE_LANGUAGES, loadStrategyTable, parseJsonLoose, resolveProfile, setLanguageModel,
} from '../lib/asr-engines.mjs'

const MODEL_NAME = /^[A-Za-z0-9._/:-]{1,160}$/
const STRATEGY_NAME = /^[a-z0-9_-]{1,32}$/

function parseArgs(argv) {
  const args = { dataDir: '', lang: 'en-US', model: null, strategy: null }
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item === '--data-dir') args.dataDir = argv[index += 1] ?? ''
    else if (item === '--lang') args.lang = argv[index += 1] ?? ''
    else if (item === '--model') args.model = argv[index += 1] ?? ''
    else if (item === '--strategy') args.strategy = argv[index += 1] ?? ''
    else if (item === '--room') {
      // ⚠️ 5.108：房间侧车整层删除，`--room` 随之取消。**必须明确说清**，
      //    否则老脚本/老笔记里的人会以为它只是"暂时不好用"，继续试。
      console.error('--room 已在 5.108 删除：手机端的模型控制早就删了，房间侧车那一层也一起删掉了。\n'
        + '  现在"用哪个模型"只由服务器那张表决定（表是唯一的决定点）。\n'
        + '  换某一门语言的模型：--lang pt-BR --strategy pt-funasr（或 --model <名字>）')
      process.exit(2)
    } else if (item === '--help' || item === '-h') {
      console.log('用法：node scripts/asr-model-switch.mjs --data-dir <目录> '
        + '[--lang en-US|zh-CN|pt-BR] [--model 名字] [--strategy 策略名]')
      process.exit(0)
    } else {
      console.error(`不认识的参数：${item}`)
      process.exit(2)
    }
  }
  if (!args.dataDir) {
    console.error('缺 --data-dir（服务器上通常是 /var/lib/leion/live 或 /var/lib/leion/test）')
    process.exit(2)
  }
  if (!ENGINE_LANGUAGES.includes(args.lang)) {
    console.error(`--lang 只能是 ${ENGINE_LANGUAGES.join(' / ')}`)
    process.exit(2)
  }
  if (args.strategy !== null && !STRATEGY_NAME.test(args.strategy)) {
    console.error('--strategy 只能是 [a-z0-9_-]（表里 strategies 的名字）')
    process.exit(2)
  }
  if (args.model !== null && args.model !== '' && !MODEL_NAME.test(args.model)) {
    console.error('--model 名字不合法（只允许字母数字 . _ / : -）')
    process.exit(2)
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const root = args.dataDir
  const tablePath = join(root, 'asr-models.json')

  const loaded = loadStrategyTable(root)
  if (loaded.problem) {
    console.error(`策略表现在是坏的：${loaded.problem}\n先修好再来切 —— 别在坏表上再写一次。`)
    return 2
  }
  const table = loaded.table ?? {}

  // 没给 --model 也没给 --strategy：只报告现状
  if (args.model === null && args.strategy === null) {
    console.log(`数据目录 ${root}`)
    for (const lang of ENGINE_LANGUAGES) {
      const entry = table.languages?.[lang]
      const named = typeof entry === 'object' && entry !== null ? entry.strategy : ''
      const model = typeof entry === 'object' && entry !== null ? entry.model : entry
      const profile = resolveProfile(table, lang, named || 'default')
      const parts = [
        named ? `策略 ${named}` : '策略 default',
        `引擎 ${profile.engine}/${profile.model || '默认'}`,
        model ? `（直接钉了模型 ${model}）` : '',
      ].filter(Boolean)
      console.log(`  · ${lang}：${parts.join('，')}`)
    }
    const strategies = Object.keys(table.strategies ?? {})
    if (strategies.length > 0) console.log(`\n可选策略：${strategies.join(' / ')}`)
    console.log('\n换模型：--model tiny（还原：--model ""）'
      + '\n换引擎：--strategy en-parakeet（parakeet / tencent 这类只能这样切）')
    return 0
  }

  let next = table
  const reports = []

  // ① 换策略（引擎 + 模型 + 切句整套）
  if (args.strategy !== null) {
    const strategies = table.strategies ?? {}
    if (strategies[args.strategy] === undefined) {
      // ⚠️ 写一个不存在的策略名不会报错，识别侧会悄悄按 default 跑 —— 所以这里必须拦住。
      // 5.80：并且要说清"缺的那些怎么补" —— 示例表和服务器上的表是**两份**，
      // 新增的策略（en-parakeet / en-tencent…）得先 merge 进来，否则这里永远找不到。
      console.error(`表里没有策略 ${args.strategy}。可选：${Object.keys(strategies).join(' / ') || '（一个都没有）'}`)
      console.error('缺的策略可以从仓库的示例表合并进来（只加不覆盖、会先备份）：'
        + `\n  node scripts/asr-models-merge.mjs --data-dir ${root} --only ${args.strategy} --write`
        + '\n  先看会加什么就去掉 --write（dry-run）。')
      return 2
    }
    const languages = { ...(next.languages ?? {}) }
    const entry = languages[args.lang]
    const asObject = entry && typeof entry === 'object' && !Array.isArray(entry)
      ? { ...entry }
      : (typeof entry === 'string' ? { model: entry } : {})
    asObject.strategy = args.strategy
    // ⚠️ 策略已经决定引擎与模型，所以把"直接钉的模型"删掉 —— 否则它仍会压过策略，
    //    用户以为换成了 parakeet，实际还在跑那个钉住的 whisper 模型。
    delete asObject.model
    languages[args.lang] = asObject
    next = { ...next, languages }
    reports.push(`${args.lang} 的策略 → ${args.strategy}（该策略里的引擎/模型生效，原先直接钉的模型已清除）`)
  }

  // ② 换模型（只改模型名，不动策略与引擎）
  if (args.model !== null) {
    const pinned = setLanguageModel(next, args.lang, args.model)
    next = pinned.table
    reports.push(`${args.lang} 的模型：${pinned.before || '（按策略表/default）'} → `
      + `${pinned.after || '（还原成策略表/default）'}`)
  }

  if (existsSync(tablePath)) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    copyFileSync(tablePath, `${tablePath}.bak-${stamp}`)
  } else {
    console.log(`（${tablePath} 原来不存在，会新建一份）`)
  }
  writeFileSync(tablePath, JSON.stringify(next, null, 2), 'utf-8')
  for (const line of reports) console.log(line)
  const after = resolveProfile(next, args.lang, next.languages?.[args.lang]?.strategy || 'default')
  console.log(`现在这一路会跑：引擎 ${after.engine} / 模型 ${after.model || '默认'}`)
  console.log(`已写 ${tablePath}（识别侧按 mtime 热读，**不用重启**）`)
  console.log('验证：日志里出现 `[识别] 加载 <引擎>:<模型>` 与 `（引擎 <引擎>）`')
  // ⚠️ 5.108：这一行以前写的是"只在 App 里没给这场选过模型时才生效（房间侧车优先级更高）"。
  //    侧车整层删除之后，表就是**唯一**的决定点 —— 再留着那句会让人以为还有别的东西压着它。
  console.log('提示：表是唯一的决定点（房间侧车那一层已在 5.108 删除）。')
  return 0
}

process.exit(main())
