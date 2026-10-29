#!/usr/bin/env node
/**
 * create-account.mjs —— 直接在数据目录里建一个账号（不联网、不敲手机）
 * ============================================================================
 *
 *   node scripts/create-account.mjs --user boss --password 'Str0ng!' --role admin
 *   node scripts/create-account.mjs --user test1 --role dev --days 7 --data-dir /var/lib/leion/test
 *   node scripts/create-account.mjs --list
 *
 * 用途：**库被重建之后**要有一个能登录的账号。手机注册也行，但那样得先有人能进管理端；
 * 在"刚重建完空库"这种场景里，一条命令更快、也可复现（搬迁/演练都会用到）。
 *
 * ⚠️ 密码只从命令行或 `--password-stdin` 读，**不回显、不落盘**（脚本不打印它）。
 * ⚠️ 角色：admin / user / dev（dev 是测试账号，默认 7 天有效期，与手机注册一致）。
 */

import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { createAccountWithPassword, hasAccounts, listAccounts, loadAccounts, saveAccounts } from '../lib/accounts.mjs'

export function parseArgs(argv = []) {
  const options = { dataDir: process.env.LEION_DATA_DIR || 'var/live', list: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--user') options.user = argv[++i]
    else if (token === '--password') options.password = argv[++i]
    else if (token === '--password-stdin') options.passwordStdin = true
    else if (token === '--role') options.role = argv[++i]
    else if (token === '--email') options.email = argv[++i]
    else if (token === '--note') options.note = argv[++i]
    else if (token === '--days') options.days = Number(argv[++i])
    else if (token === '--data-dir') options.dataDir = argv[++i]
    else if (token === '--list') options.list = true
    else if (token === '--help' || token === '-h') options.help = true
    else throw new Error(`看不懂的参数：${token}`)
  }
  return options
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8').trim()
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log('node scripts/create-account.mjs --user <名字> --password <密码> [--role admin|user|dev]'
      + ' [--email x@y.z] [--days 7] [--data-dir dir]')
    console.log('node scripts/create-account.mjs --list [--data-dir dir]')
    return 0
  }
  const dataDir = resolve(options.dataDir)
  const doc = await loadAccounts(dataDir)

  if (options.list) {
    const rows = listAccounts(doc)
    if (rows.length === 0) {
      console.log(`（${dataDir} 里还没有账号）`)
      return 0
    }
    for (const row of rows) {
      console.log(`  ${row.username}\t${row.role}\t${row.status}\t${row.email || '-'}`
        + `${row.expiresAt ? `\t到 ${row.expiresAt.slice(0, 10)}` : ''}`)
    }
    return 0
  }

  if (options.user === undefined || options.user === '') throw new Error('缺少 --user')
  const password = options.passwordStdin === true ? await readStdin() : options.password
  if (password === undefined || password === '') throw new Error('缺少 --password（或用 --password-stdin 从管道读）')

  const created = createAccountWithPassword(doc, {
    username: options.user,
    password,
    role: options.role ?? 'admin',
    email: options.email,
    note: options.note,
    expiresInDays: Number.isFinite(options.days) ? options.days : undefined,
  })
  if (created.ok !== true) {
    console.error(`✗ 建账号失败：${created.error}`)
    return 1
  }
  await saveAccounts(dataDir, created.doc)
  console.log(`✓ 已建账号：${options.user}（角色 ${created.role}）`)
  console.log(`  数据目录：${dataDir}`)
  if (hasAccounts(created.doc) !== true) console.log('  ⚠️ 写完之后仍然读不到账号，检查数据目录权限')
  console.log('  现在可以用手机 App 用这个用户名 + 密码登录（登录页切到「用密码登录」）')
  const record = created.doc.users[options.user]
  if (typeof record?.expiresAt === 'string') {
    console.log(`  注意：这是测试账号，有效期到 ${record.expiresAt.slice(0, 10)}`)
  }
  return 0
}

if (process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(String(error?.message ?? error))
    process.exit(1)
  })
}
