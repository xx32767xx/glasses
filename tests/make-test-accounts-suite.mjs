/**
 * make-test-accounts-suite.mjs —— 压测账号批量生成（5.147）
 * ============================================================================
 *
 * 这个脚本的价值是"能重复地、可数地"造一批能登录的号，所以它必须守住三件事：
 *   ① 默认值就是用户定的那组（test 环境、45 个、test1..test45、密码 123456）；
 *   ② 重跑不能报一堆错、也不能重复建（幂等）；
 *   ③ 建出来的号**真能登录**（哈希写对了、角色是 dev 不是 admin）。
 *
 * ②③ 都是"看起来对、其实坏了"的高发地：密码哈希写错时建号照样返回成功，
 * 只有真去验一次密码才发现。
 */

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { VAR_DIR } from '../lib/paths.mjs'
import { listAccounts, loadAccounts, login } from '../lib/accounts.mjs'
import { DEFAULTS, createTestAccounts, parseArgs, planFromOptions } from '../scripts/make-test-accounts.mjs'

const BASE = join(VAR_DIR, 'test', 'make-test-accounts')

export async function runMakeTestAccountsSuite({ it, check }) {
  console.log('\n压测账号批量生成（5.147）：默认口径 / 幂等 / 真能登录')

  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(BASE, { recursive: true })

  await it('默认口径就是用户定的那组：test 环境 / 45 个 / test1..test45 / 密码 123456', () => {
    const plan = planFromOptions(parseArgs([]), DEFAULTS)
    check('默认 45 个', plan.names.length === 45, String(plan.names.length))
    check('名字是 test1..test45（不带前导零）',
      plan.names[0] === 'test1' && plan.names[44] === 'test45', plan.names.slice(0, 2).join(','))
    check('默认密码 123456', plan.password === '123456', plan.password)
    check('默认角色是 dev（压测号不该有管理员权限）', plan.role === 'dev', plan.role)
    check('默认不设有效期（长期）', plan.days === null, String(plan.days))
  })

  await it('--prefix / --start / --pad / --count 都能改名字', () => {
    const plan = planFromOptions(parseArgs([
      '--prefix', 'stress', '--start', '7', '--pad', '3', '--count', '3', '--root', BASE,
    ]))
    check('前缀 + 起始号 + 补零', plan.names.join(',') === 'stress007,stress008,stress009', plan.names.join(','))
    check('--root 会解析成绝对路径', plan.root === BASE, plan.root)
  })

  await it('坏参数当场拒绝（不静默变成默认值）', () => {
    let envFailed = false
    try { planFromOptions(parseArgs(['--env', 'prod2'])) } catch { envFailed = true }
    check('--env 只认 prod / test', envFailed)

    let countFailed = false
    try { planFromOptions(parseArgs(['--count', '0'])) } catch { countFailed = true }
    check('--count 必须 ≥ 1', countFailed)

    let daysFailed = false
    try { planFromOptions(parseArgs(['--days', '-1'])) } catch { daysFailed = true }
    check('--days 必须是正数', daysFailed)
  })

  await it('真的落库，而且建出来的号**能用 123456 登录**', async () => {
    const plan = planFromOptions(parseArgs([
      '--count', '3', '--root', BASE, '--password', '123456',
    ]))
    const outcome = await createTestAccounts(plan, { quiet: true })
    check('建了 3 个', outcome.created.length === 3, JSON.stringify(outcome.created))
    check('没有失败', outcome.failed.length === 0, JSON.stringify(outcome.failed))

    const doc = await loadAccounts(BASE)
    check('库里真有这 3 个，角色都写的是 dev',
      listAccounts(doc).filter((one) => one.username.startsWith('test')).length === 3
      && listAccounts(doc).every((one) => one.role === 'dev'),
      JSON.stringify(listAccounts(doc).map((one) => `${one.username}:${one.role}`)))

    const ok = login(doc, 'test1', '123456')
    check('密码哈希写对了（test1 / 123456 能验过）', ok.ok === true, JSON.stringify(ok).slice(0, 120))
    const bad = login(doc, 'test1', '123457')
    check('错密码进不去（不是"谁的密码都能过"）', bad.ok === false)
  })

  await it('重跑幂等：已存在的不再建，也不报错', async () => {
    const plan = planFromOptions(parseArgs(['--count', '5', '--root', BASE, '--password', '123456']))
    const outcome = await createTestAccounts(plan, { quiet: true })
    check('跳过的正好是已存在的 3 个', outcome.skipped.length === 3, JSON.stringify(outcome.skipped))
    check('新建的只有缺的 2 个', outcome.created.join(',') === 'test4,test5', JSON.stringify(outcome.created))
    check('没有失败', outcome.failed.length === 0, JSON.stringify(outcome.failed))

    const doc = await loadAccounts(BASE)
    check('总数还是 5（没有重复建）',
      listAccounts(doc).filter((one) => one.username.startsWith('test')).length === 5)
  })

  await it('密码太短时不写库，如实报失败（不静默建一个登不上的号）', async () => {
    const plan = planFromOptions(parseArgs(['--count', '1', '--root', BASE, '--password', '123']))
    // 单开一个临时目录，避免影响上面那批断言
    const dir = join(BASE, 'short-pass')
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const outcome = await createTestAccounts({ ...plan, root: dir }, { quiet: true })
    check('建 0 个', outcome.created.length === 0, JSON.stringify(outcome.created))
    check('失败理由说清"密码至少 6 位"',
      outcome.failed.length === 1 && /至少/.test(outcome.failed[0].error), JSON.stringify(outcome.failed))
  })
}
