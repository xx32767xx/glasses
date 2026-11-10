/**
 * check-mail.mjs —— 邮件通道冒烟（服务器上"验证码发不出去"时先跑它）
 * ============================================================================
 *
 *   node scripts/check-mail.mjs --to you@example.com
 *   node scripts/check-mail.mjs --to you@example.com --dry     # 只看配置，不发
 *
 * 它会做三件事，**每一件都单独报**（这样一眼能看出卡在哪）：
 *   ① 读环境变量（`LEION_SMTP_*`）→ 打印将要连哪台服务器、用什么加密方式；
 *   ② 真连一次并跑完整个 SMTP 对话（含 AUTH）→ 失败时打印**脱敏后的对话记录**；
 *   ③ 把一封测试邮件发到 `--to`。
 *
 * 为什么要单独一个脚本：`/auth/code` 失败时只回一句"邮件没发出去"，
 * 而真正的原因（端口不通 / 认证失败 / 发件人被拒 / STARTTLS 没协商上）只有这里看得到。
 */

import { describeMailConfig, sendMail, smtpConfigFromEnv, smtpHostMismatch } from '../lib/mail.mjs'

const HELP = `check-mail —— 邮件通道冒烟

  node scripts/check-mail.mjs --to <邮箱> [--dry] [--timeout-ms <n>]

  --to <邮箱>        必须给：往这个地址发一封测试邮件
  --dry              只打印配置，不真连、不发
  --timeout-ms <n>   单次 SMTP 超时（缺省 15000）

需要的环境变量：
  LEION_SMTP_HOST      SMTP 服务器（例：smtp.qq.com / smtp-mail.outlook.com）
  LEION_SMTP_PORT      587（STARTTLS）/ 465（隐式 TLS）/ 25（明文，别用）
  LEION_SMTP_SECURE    1 = 隐式 TLS（465）；缺省按端口猜
  LEION_SMTP_STARTTLS  1 = 升级 TLS（587）；缺省非 465/25 都试
  LEION_SMTP_USER      登录用户名（通常是完整邮箱）
  LEION_SMTP_PASS      登录密码 / 授权码（QQ、163 要的是"授权码"，不是登录密码）
  LEION_SMTP_FROM      发件人（缺省 = 用户名）
  LEION_SMTP_FROM_NAME 发件人显示名（缺省 译连 TransLink）
`

function parseArgs(argv) {
  const options = { to: '', dry: false, timeoutMs: 15000 }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (key === '--help' || key === '-h') { options.help = true; continue }
    if (key === '--dry') { options.dry = true; continue }
    const next = argv[index + 1]
    if (key === '--to') { options.to = String(next ?? '').trim(); index += 1; continue }
    if (key === '--timeout-ms') { options.timeoutMs = Number(next); index += 1; continue }
    throw new Error(`未知选项：${key}`)
  }
  return options
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) { process.stdout.write(HELP); return 0 }

  const config = smtpConfigFromEnv()
  console.log('── 1. 配置 ─────────────────────────────────────────────')
  console.log(`  当前： ${describeMailConfig(config)}`)
  if (config !== null) {
    console.log(`  发件人：${config.fromName} <${config.from}>`)
    console.log(`  认证：  ${config.user === '' ? '无（匿名中继）' : config.user + '（密码已隐藏）'}`)
    // 5.162：主机与账号域名对不上是 535 最常见的原因，**在连接之前**就说出来。
    // 实测踩过：账号 xxx@qq.com，主机写成 smtp.exmail.qq.com（那是腾讯企业邮，两套账号体系），
    // 服务器只回一句 535，看起来像授权码过期。
    const mismatch = smtpHostMismatch(config)
    if (mismatch !== '') {
      console.log(`  ⚠️  ${mismatch}`)
      console.log('      个人 QQ 邮箱用 smtp.qq.com；企业邮（有自己的域名）才用 smtp.exmail.qq.com。')
    }
  }
  if (config === null) {
    console.log('')
    console.log('❌ 没有配置 SMTP —— 服务器的 /auth/code 只会把验证码打印在控制台。')
    console.log('   在启动 relay 前设好这些环境变量（写进 systemd/启动脚本里才能长期生效）：')
    console.log('     export LEION_SMTP_HOST=smtp.qq.com')
    console.log('     export LEION_SMTP_PORT=465          # 465=隐式 TLS，587=STARTTLS')
    console.log('     export LEION_SMTP_USER=you@qq.com')
    console.log('     export LEION_SMTP_PASS=你的授权码    # 不是登录密码')
    console.log('     export LEION_SMTP_FROM=you@qq.com')
    return 2
  }
  if (options.to === '') {
    console.log('')
    console.log('⚠️ 没给 --to：只检查了配置，没有真连。加上 --to <邮箱> 才会真发一封。')
    return 0
  }
  if (options.dry === true) {
    console.log('')
    console.log('（--dry：不真连、不发）')
    return 0
  }

  console.log('')
  console.log('── 2. 连接 + 认证 + 投递 ───────────────────────────────')
  const startedAt = Date.now()
  const result = await sendMail({
    to: options.to,
    subject: '译连 TransLink · 邮件通道测试',
    text: `这是一封测试邮件（${new Date().toISOString()}）。\n\n'
      + '收到它说明服务器的 SMTP 配置是对的，注册验证码也能这样发出去。`,
  }, { config, timeoutMs: options.timeoutMs })
  const elapsed = Date.now() - startedAt

  if (result.transcript !== undefined && result.transcript.length > 0) {
    console.log('  SMTP 对话（已脱敏，密码不会出现在这里）：')
    for (const line of result.transcript) console.log(`    ${line}`)
  }
  console.log('')
  if (result.ok === true) {
    console.log(`✅ 发送成功（${elapsed}ms）。去 ${options.to} 的收件箱看看（可能在"垃圾邮件"里）。`)
    return 0
  }
  console.log(`❌ 发送失败（${elapsed}ms）：${result.error}`)
  console.log('')
  console.log('常见原因与处理：')
  console.log('  · ECONNREFUSED / ETIMEDOUT     → 端口不对，或服务器/机房封了 25 端口（改用 465/587）')
  console.log('  · 认证失败（535 / 5.7.8）      → 密码要用"授权码"；QQ/163 必须先在邮箱设置里开启 SMTP')
  console.log('  · 发件人被拒（550 / 553）      → LEION_SMTP_FROM 必须与登录用户名同一域名')
  console.log('  · STARTTLS 失败                → 换 465 + LEION_SMTP_SECURE=1，或 LEION_SMTP_STARTTLS=0')
  console.log('  · 证书错误（self signed）      → 服务器证书链不全；别为了绕过而关掉校验')
  return 1
}

const isCli = process.argv[1] !== undefined
  && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href
if (isCli) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error('❌ ' + String(error && error.message ? error.message : error))
    process.exit(1)
  })
}

export { main, parseArgs }
