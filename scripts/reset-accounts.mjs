#!/usr/bin/env node
// reset-accounts.mjs —— 只保留一个管理员，其余账号清掉（2026-10-25 用户要求：账号只留一个最基本的管理员）
//
// 先说清楚它**不碰**什么：术语库、申请、会议、字幕全都不动。只动 accounts / tokens / auth_codes。
// 默认演练：把你将删掉的账号列出来；--apply 才真删。
import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { loadAccounts, saveAccounts } from '../lib/accounts.mjs'

export function planReset(doc, keep) {
  const keepName = String(keep || 'boss')
  const toRemove = Object.keys(doc.users ?? {}).filter((name) => name !== keepName)
  return { keep: keepName, keepExists: doc.users?.[keepName] !== undefined, toRemove }
}

export async function main(argv = process.argv.slice(2)) {
  const options = { dataDir: process.env.LEION_DATA_DIR || 'var/live', keep: 'boss', apply: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--apply') { options.apply = true; continue }
    if (token === '--keep') { options.keep = argv[++i]; continue }
    if (token === '--data-dir') { options.dataDir = argv[++i]; continue }
    if (token === '--help' || token === '-h') { options.help = true; continue }
    throw new Error('unknown arg: ' + token)
  }
  if (options.help) { console.log('usage: node scripts/reset-accounts.mjs [--keep boss] [--data-dir dir] [--apply]'); return 0 }
  const dataDir = resolve(options.dataDir)
  const doc = await loadAccounts(dataDir)   // 与线上同一套读取（库优先，过渡期读旧 JSON）
  const plan = planReset(doc, options.keep)
  if (!plan.keepExists) {
    console.error('保留的账号不存在：' + plan.keep + '（先用 terms-admin 建它，别把所有人都删了）')
    return 1
  }
  console.log('保留 ' + plan.keep + '；将删除 ' + plan.toRemove.length + ' 个账号' + (plan.toRemove.length ? '：' + plan.toRemove.join('、') : ''))
  if (options.apply !== true) { console.log('[dry-run] 加 --apply 才真删'); return 0 }
  const users = { [plan.keep]: doc.users[plan.keep] }
  const tokens = {}
  for (const [hash, entry] of Object.entries(doc.tokens ?? {})) if (entry?.user === plan.keep) tokens[hash] = entry
  await saveAccounts(dataDir, { version: 1, users, tokens, codes: {} })
  console.log('[applied] 现在只剩 ' + plan.keep + '（token 也只剩它的；验证码已清空）')
  return 0
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().then((code) => process.exit(code)).catch((error) => { console.error('ERROR ' + error.message); process.exit(1) })
}