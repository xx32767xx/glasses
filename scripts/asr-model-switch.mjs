#!/usr/bin/env node
/**
 * asr-model-switch.mjs —— 服务器端一条命令换识别模型（5.68）
 * ============================================================================
 *
 * 为什么要有它：手机端那条链路（配置页选 → 房间侧车 → 识别）已经能跑通，但每验一次都要
 * "改配置 → 开始 → 说话"，来回几轮太慢；而做模型对比本质上只关心**现在用哪个模型**。
 * 那就让服务器说了算 —— 用户 2026-11 原话：「如果还是有问题，可以放弃手机端控制」。
 *
 * 改的是 `<数据目录>/asr-models.json` 的 `languages[语种].model`：这一层
 * **高于**策略表/default、**低于**房间侧车。所以
 *   ① 立刻影响之后的所有段（识别侧按 mtime 热读，**不用重启**）；
 *   ② 如果某个房间真的在 App 里选过模型，那个房间仍按它自己的选择走。
 *
 * 用法
 *   node scripts/asr-model-switch.mjs --data-dir /var/lib/leion/test --model tiny
 *   node scripts/asr-model-switch.mjs --data-dir /var/lib/leion/test --lang pt-BR --model small
 *   node scripts/asr-model-switch.mjs --data-dir /var/lib/leion/test --model ""     # 还原成表里的默认
 *   node scripts/asr-model-switch.mjs --data-dir /var/lib/leion/test --room room-xxx --model tiny
 *       ↑ 只影响这一场（写房间侧车，不改表）
 *   node scripts/asr-model-switch.mjs --data-dir /var/lib/leion/test              # 只看现在是什么
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ENGINE_LANGUAGES, loadStrategyTable, parseJsonLoose, setLanguageModel } from '../lib/asr-engines.mjs'

const MODEL_NAME = /^[A-Za-z0-9._/-]{1,120}$/

function parseArgs(argv) {
  const args = { dataDir: '', lang: 'en-US', model: null, room: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item === '--data-dir') args.dataDir = argv[index += 1] ?? ''
    else if (item === '--lang') args.lang = argv[index += 1] ?? ''
    else if (item === '--model') args.model = argv[index += 1] ?? ''
    else if (item === '--room') args.room = argv[index += 1] ?? ''
    else if (item === '--help' || item === '-h') {
      console.log('用法：node scripts/asr-model-switch.mjs --data-dir <目录> '
        + '[--lang en-US|zh-CN|pt-BR] [--model <名字>|""] [--room <房间id>]')
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
  if (args.model !== null && args.model !== '' && !MODEL_NAME.test(args.model)) {
    console.error('--model 名字不合法（只允许字母数字 . _ / -）')
    process.exit(2)
  }
  return args
}

/** 只给房间用时：写侧车（比改表更"局部"，适合一场一测）。 */
function switchRoom(root, room, lang, model) {
  const dir = join(root, 'asr-profiles')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${room}.json`)
  const payload = { roomId: room, byLang: { [lang]: { model } }, at: Date.now(), by: 'asr-model-switch' }
  writeFileSync(path, JSON.stringify(payload, null, 2), 'utf-8')
  console.log(`已写房间侧车 ${path}`)
  console.log(`  ${lang} → ${model}（只影响这一场；识别侧按 mtime 热读，下一个段就生效）`)
  console.log('  ⚠️ 提醒：App 里重新开始这一场会覆盖它（手机上报的优先级更高）。')
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const root = args.dataDir
  const tablePath = join(root, 'asr-models.json')

  if (args.room !== '') {
    if (args.model === null || args.model === '') {
      console.error('--room 必须配一个具体的 --model（房间侧车没有"还原"这种语义，删文件即可）')
      return 2
    }
    switchRoom(root, args.room, args.lang, args.model)
    return 0
  }

  const loaded = loadStrategyTable(root)
  if (loaded.problem) {
    console.error(`策略表现在是坏的：${loaded.problem}\n先修好再来切 —— 别在坏表上再写一次。`)
    return 2
  }
  const table = loaded.table ?? {}

  // 没给 --model：只报告现状
  if (args.model === null) {
    const entry = table.languages?.[args.lang]
    const pinned = typeof entry === 'object' && entry !== null ? entry.model : entry
    console.log(`数据目录 ${root}`)
    console.log(`表里 ${args.lang} 现在：${pinned ? `模型 ${pinned}` : '（没有单独钉模型，按策略表/default）'}`)
    for (const lang of ENGINE_LANGUAGES) {
      const one = table.languages?.[lang]
      const model = typeof one === 'object' && one !== null ? one.model : one
      console.log(`  · ${lang}：${model ? `${model}` : '（按策略表/default）'}`)
    }
    console.log('\n切换：加 --model tiny（要还原就 --model ""）')
    return 0
  }

  const result = setLanguageModel(table, args.lang, args.model)
  if (existsSync(tablePath)) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    copyFileSync(tablePath, `${tablePath}.bak-${stamp}`)
  } else {
    console.log(`（${tablePath} 原来不存在，会新建一份）`)
  }
  writeFileSync(tablePath, JSON.stringify(result.table, null, 2), 'utf-8')
  console.log(`${args.lang}：${result.before || '（按策略表/default）'} → `
    + `${result.after || '（还原成策略表/default）'}`)
  console.log(`已写 ${tablePath}（识别侧按 mtime 热读，**不用重启**）`)
  console.log('验证：日志里出现 `[识别] 房间 … 策略 …（模型 ' + (result.after || 'default') + '…）`')
  console.log('⚠️ 只在 App 里没给这场选过模型时才生效（房间侧车优先级更高）。')
  return 0
}

process.exit(main())
