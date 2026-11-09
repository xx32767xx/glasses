#!/usr/bin/env node
/**
 * make-test-accounts.mjs —— 批量生成测试账号（压测 / 演示用）
 * ============================================================================
 *
 *   node scripts/make-test-accounts.mjs                       # 45 个：test1..test45，密码 123456
 *   node scripts/make-test-accounts.mjs --count 20 --prefix stress
 *   node scripts/make-test-accounts.mjs --env prod --root /var/lib/leion/live
 *   node scripts/make-test-accounts.mjs --dry-run              # 只打印将要建哪些名字
 *
 * 默认值（用户 2026-11-09 定的压测口径）：
 *   --env test --count 45 --prefix test --password 123456
 *
 * 为什么不直接写 `for i in $(seq 1 45); do terms-admin dev ...; done`：
 *   ① 每次调用都会**整表读改写**一次账号文档，45 次 = 45 轮全库重写，
 *      并发场景下这正是 5.21 那个"后写覆盖先写"的老坑；
 *   ② 它会为每个账号重算一遍密码哈希 —— 这里同样是逐个建（哈希必须逐个算），
 *      但**账号是否存在先查一次**，重跑时不会报一堆 username-taken；
 *   ③ 压测要的是"同一批账号、可重复、结果可数"，所以要有汇总与退出码。
 *
 * 安全约束：
 *   · 角色固定为 `dev`（测试账号），**不是** admin —— 压测账号不该有审批/改库权限；
 *   · 密码只经 scrypt 哈希入表，脚本自己的回显里不再打印它；
 *   · `--env test` 是默认值；打到 `prod` 必须**显式**给 `--env prod` 或 `--root`，
 *     免得在正式库里凭空造出 45 个能登录的号。
 */

import { resolve } from 'node:path'
import { VAR_DIR } from '../lib/paths.mjs'
import { ENVS, resolveDataDir } from '../lib/store.mjs'
import {
  ACCOUNT_LIMITS, createAccountWithPassword, listAccounts, loadAccounts, updateAccounts,
} from '../lib/accounts.mjs'

/** 压测默认口径（和用户说定的那组一致）。 */
export const DEFAULTS = Object.freeze({
  env: 'test',
  count: 45,
  prefix: 'test',
  password: '123456',
  role: 'dev',
})

const USAGE = `用法：node scripts/make-test-accounts.mjs [选项]

  --env prod|test      目标环境（缺省 test；目录名见 lib/store.mjs）
  --root <目录>        直接指定数据目录（服务器上常用 /var/lib/leion/live 或 /var/lib/leion/test）
  --base <目录>        配合 --env 拼目录（缺省仓库的 var/）
  --count <n>          建多少个（缺省 45）
  --prefix <名字>      用户名前缀（缺省 test → test1..test45）
  --start <n>          编号从几开始（缺省 1）
  --pad <n>            编号补零到几位（缺省 0 = 不补；--pad 2 → test01）
  --password <密码>    统一密码（缺省 123456；至少 ${ACCOUNT_LIMITS.minPasswordChars} 位）
  --days <n>           有效期 n 天（缺省不设 = 长期有效）
  --password-file <p>  从文件读密码（不想让密码进 shell 历史时用）
  --dry-run            只打印将要建的名字，不写库
  --help               看这份说明

示例（服务器上给测试环境灌 45 个压测号）：
  node scripts/make-test-accounts.mjs --env test --count 45
  node scripts/make-test-accounts.mjs --root /var/lib/leion/test --count 45
`

/** 解析命令行（与 terms-admin 同一套写法：`--k v` / `--k=v` / 布尔开关）。 */
export function parseArgs(argv = []) {
  const options = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token.startsWith('--') !== true) {
      options._.push(token)
      continue
    }
    const body = token.slice(2)
    const eq = body.indexOf('=')
    if (eq > 0) {
      options[body.slice(0, eq)] = body.slice(eq + 1)
      continue
    }
    const next = argv[index + 1]
    if (next === undefined || (next.startsWith('--') && next.length > 2)) {
      options[body] = true
      continue
    }
    options[body] = next
    index += 1
  }
  return options
}

/**
 * 选项 → 一份"要做什么"的纯描述（不碰磁盘，便于测试）。
 * @returns {{ root: string|null, env: string, count: number, names: string[],
 *   password: string, role: string, days: number|null, dryRun: boolean }}
 */
export function planFromOptions(options, defaults = DEFAULTS) {
  const env = typeof options.env === 'string' ? options.env : defaults.env
  if (ENVS.includes(env) !== true) {
    throw new Error(`--env 只能是 ${ENVS.join(' / ')}，收到 ${JSON.stringify(options.env)}`)
  }
  const root = typeof options.root === 'string' && options.root !== ''
    ? resolve(options.root)
    : resolveDataDir(typeof options.base === 'string' && options.base !== '' ? options.base : VAR_DIR, env)

  const count = numberOption(options, 'count', defaults.count)
  if (!Number.isInteger(count) || count <= 0 || count > 1000) {
    throw new Error(`--count 必须是 1..1000 的整数，收到 ${JSON.stringify(options.count)}`)
  }
  const start = numberOption(options, 'start', 1)
  if (!Number.isInteger(start) || start < 0) throw new Error('--start 必须是非负整数')
  const pad = numberOption(options, 'pad', 0)
  if (!Number.isInteger(pad) || pad < 0 || pad > 6) throw new Error('--pad 必须是 0..6 的整数')

  const prefix = typeof options.prefix === 'string' && options.prefix !== '' ? options.prefix : defaults.prefix
  const password = typeof options.password === 'string' ? options.password : defaults.password
  // 只校验"能不能建"，真正的拒绝理由由 lib 统一给（一处规则，不抄两遍）
  const days = options.days === undefined || options.days === true ? null : numberOption(options, 'days', 0)
  if (days !== null && (!Number.isInteger(days) || days <= 0)) throw new Error('--days 必须是正整数')

  const names = []
  for (let i = 0; i < count; i += 1) {
    const serial = String(start + i).padStart(pad, '0')
    names.push(`${prefix}${serial}`)
  }
  return {
    root, env, count, names, password, role: defaults.role, days,
    dryRun: options['dry-run'] === true,
  }
}

function numberOption(options, key, fallback) {
  const raw = options[key]
  if (raw === undefined) return fallback
  if (typeof raw === 'boolean') return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? value : Number.NaN
}

/**
 * 真正落库：**先读一次**列出已存在的，只对缺的走 updateAccounts（串行 + 整表重写由 lib 保证）。
 *
 * @param {object} plan planFromOptions() 的结果
 * @param {{ quiet?: boolean }} [io]
 * @returns {Promise<{ created: string[], skipped: string[], failed: Array<{name: string, error: string}>, password: string }>}
 */
export async function createTestAccounts(plan, io = {}) {
  const say = io.quiet === true ? () => {} : (line) => console.log(line)
  const before = listAccounts(await loadAccounts(plan.root))
  const existing = new Set(before.map((one) => one.username))
  const created = []
  const skipped = []
  const failed = []

  say(`数据目录    ${plan.root}（环境 ${plan.env}）`)
  say(`要建        ${plan.names.length} 个：${plan.names[0]} … ${plan.names[plan.names.length - 1]}`
    + `（角色 ${plan.role}，${plan.days === null ? '长期有效' : `${plan.days} 天后过期`}）`)
  say('')

  for (const name of plan.names) {
    if (existing.has(name)) {
      skipped.push(name)
      continue
    }
    try {
      const result = await updateAccounts(plan.root, (doc) => createAccountWithPassword(doc, {
        username: name,
        password: plan.password,
        role: plan.role,
        note: '压测账号（make-test-accounts.mjs）',
        expiresInDays: plan.days === null ? undefined : plan.days,
        now: Date.now(),
      }))
      if (result.ok !== true) {
        failed.push({ name, error: String(result.error ?? '未知原因') })
        continue
      }
      created.push(name)
      if (created.length % 10 === 0) say(`  已建 ${created.length}/${plan.names.length}`)
    } catch (error) {
      failed.push({ name, error: String(error?.message ?? error) })
    }
  }
  return { created, skipped, failed, password: plan.password }
}

function printSummary(outcome, plan) {
  console.log('')
  console.log(`新建        ${outcome.created.length} 个`)
  console.log(`已存在跳过  ${outcome.skipped.length} 个`)
  console.log(`失败        ${outcome.failed.length} 个`)
  if (outcome.failed.length > 0) {
    for (const one of outcome.failed.slice(0, 10)) console.log(`  ✗ ${one.name}：${one.error}`)
    if (outcome.failed.length > 10) console.log(`  …还有 ${outcome.failed.length - 10} 个`)
  }
  if (outcome.created.length > 0) {
    console.log('')
    console.log(`登录方式    用户名 ${plan.names.find((n) => outcome.created.includes(n))} …`
      + ` + 密码（${outcome.password.length} 位；脚本不打印密码本身）`)
    console.log(`核对        node scripts/terms-admin.mjs accounts --env ${plan.env}`
      + (plan.root.includes('leion') ? ` --root ${plan.root}` : ''))
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help === true || options._[0] === 'help') {
    console.log(USAGE)
    return 0
  }
  // --password-file：密码不进 shell 历史/进程列表
  if (typeof options['password-file'] === 'string' && options['password-file'] !== '') {
    const { readFile } = await import('node:fs/promises')
    options.password = (await readFile(options['password-file'], 'utf-8')).trim()
  }

  const plan = planFromOptions(options)
  if (plan.password.length < ACCOUNT_LIMITS.minPasswordChars) {
    throw new Error(`密码至少 ${ACCOUNT_LIMITS.minPasswordChars} 位（当前 ${plan.password.length} 位）`)
  }

  if (plan.dryRun) {
    console.log(`[dry-run] 数据目录：${plan.root}（环境 ${plan.env}）`)
    console.log(`[dry-run] 将建 ${plan.names.length} 个：${plan.names.join(' ')}`)
    return 0
  }

  // 目录不存在就直接说清楚，别让 readAccountsDoc 静默建出一个空库的假象
  const { existsSync } = await import('node:fs')
  if (!existsSync(plan.root)) {
    throw new Error(`数据目录不存在：${plan.root}\n`
      + '    · 服务器上通常是 /var/lib/leion/test 或 /var/lib/leion/live\n'
      + '    · 或先用 `node scripts/terms-admin.mjs init --env test` 建目录\n'
      + '    · 注意：服务启动时会建库；空目录里直接建号也能用，但要确认服务也用同一个 --data-dir')
  }

  const outcome = await createTestAccounts(plan)
  printSummary(outcome, plan)
  return outcome.failed.length === 0 ? 0 : 1
}

const isCli = process.argv[1] !== undefined
  && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href
if (isCli) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error('✗ ' + String(error && error.message ? error.message : error))
    process.exit(1)
  })
}

export { main, printSummary }
