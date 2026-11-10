/**
 * mail-suite.mjs —— 邮件通道的「配置自检」与 535 的可解释性（5.162）
 * ============================================================================
 *
 * 实测踩到的那次：账号是个人 QQ 邮箱（xxx@qq.com），主机却配成 `smtp.exmail.qq.com`
 * （腾讯**企业邮**）。两者是互不相通的账号体系，服务器只回一句
 * `535 Error: authentication failed, system busy` —— 看起来像授权码过期，
 * 实际上是**主机用错了**。
 *
 * 这一套钉两件事：
 *   ① 域名 → 该用哪台 SMTP 的判据（纯函数，可测）；
 *   ② 535 的**错误文案必须带上原因**（主机对不上 / 该用授权码），而不是照抄服务器那句话。
 *
 * 不真连网络：SMTP 握手要真的敲服务器，那是 `scripts/check-mail.mjs --to …` 的事。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expectedSmtpHost, smtpHostMismatch, SMTP_HOST_HINTS } from '../lib/mail.mjs'

const ROOT = join(import.meta.dirname, '..')

export async function runMailSuite({ it, check }) {
  await it('5.162：账号域名 → 该用哪台 SMTP（个人 QQ 与企业邮不是一回事）', () => {
    check('个人 QQ 邮箱用 smtp.qq.com', expectedSmtpHost('1272475158@qq.com') === 'smtp.qq.com',
      expectedSmtpHost('1272475158@qq.com'))
    check('foxmail 也走 smtp.qq.com', expectedSmtpHost('someone@foxmail.com') === 'smtp.qq.com')
    check('exmail.qq.com 自己的域名用 smtp.exmail.qq.com',
      expectedSmtpHost('a@exmail.qq.com') === 'smtp.exmail.qq.com',
      expectedSmtpHost('a@exmail.qq.com'))
    // 企业邮的真实用法是"自有域名 + 企业邮主机"，域名推不出主机 —— 这种情况必须**不猜**
    check('自有域名（企业邮）推不出来，宁可给空串',
      expectedSmtpHost('ops@corp.example.com') === '')
    check('163 / 126 各用各的', expectedSmtpHost('a@163.com') === 'smtp.163.com'
      && expectedSmtpHost('b@126.com') === 'smtp.126.com')
    check('gmail / outlook 也有判据',
      expectedSmtpHost('c@gmail.com') === 'smtp.gmail.com'
      && expectedSmtpHost('d@outlook.com') === 'smtp-mail.outlook.com')
    check('认不出来的域名给空串（不猜）',
      expectedSmtpHost('e@nope.example') === '' && expectedSmtpHost('no-at-sign') === ''
      && expectedSmtpHost('') === '' && expectedSmtpHost(null) === '')
    check('大小写不敏感', expectedSmtpHost('A@QQ.COM') === 'smtp.qq.com')
  })

  await it('5.162：主机与账号对不上要能说出来（这次 535 的真因）', () => {
    const wrong = smtpHostMismatch({ host: 'smtp.exmail.qq.com', user: '1272475158@qq.com' })
    check('主机写成企业邮时给出提示', wrong !== '', wrong)
    check('提示里点明"该用哪台"和"现在用的是哪台"',
      wrong.includes('smtp.qq.com') && wrong.includes('smtp.exmail.qq.com'), wrong)
    check('对得上时不啰嗦', smtpHostMismatch({ host: 'smtp.qq.com', user: 'x@qq.com' }) === '')
    check('认不出账号域名时不乱报',
      smtpHostMismatch({ host: 'smtp.whatever.example', user: 'x@nope.example' }) === '')
    check('配置为空也不炸', smtpHostMismatch(null) === '')
    check('表里每一行都写了主机', Object.values(SMTP_HOST_HINTS).every((one) => typeof one === 'string' && one !== ''))
  })

  await it('5.162：535 的错误文案必须带原因（不许照抄服务器那句话）', () => {
    const source = readFileSync(join(ROOT, 'lib', 'mail.mjs'), 'utf-8')
    check('单独处理了 535', /if \(passReply\.code === 535\)/.test(source))
    check('535 分支会去查"主机/账号"是否对得上',
      /const mismatch = smtpHostMismatch\(config\)/.test(source))
    check('对不上时把两件事连起来说（主机 + 535 就是这个原因）',
      /535 多半就是这个原因/.test(source))
    check('对得上时提示"该用授权码而不是登录密码"', /授权码/.test(source) && /不是登录密码/.test(source))
    // 密码永远不许进日志/文案（这一条从 5.30 就在守，别在加提示时漏回来）
    check('提示里不含密码本身', !/passReply\.text.*config\.pass/.test(source))

    const checker = readFileSync(join(ROOT, 'scripts', 'check-mail.mjs'), 'utf-8')
    check('check-mail 在**连接之前**就把主机不匹配说出来',
      /smtpHostMismatch\(config\)/.test(checker) && /个人 QQ 邮箱用 smtp\.qq\.com/.test(checker))
  })
}
