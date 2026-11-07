/**
 * tencent-secret-suite.mjs —— 腾讯云密钥的**文件模式**解析（5.128）
 * ============================================================================
 *
 * 为什么值得单独测：现场踩过一次真事 ——
 * `asr.env` 里写的是 `TENCENT_ASR_SECRET_FILE=/etc/leion/tencent.csv`，
 * 引擎（python）读文件能通，而 `asr-doctor` 只查两个环境变量，于是报
 * 「缺 secretId / 缺 secretKey」→ 看起来像**没配上**。
 *
 * 一条日志如果无法区分"配了但读不到"和"根本没配"，它就是 bug。所以这里把
 * 解析规则逐条钉住：CSV（带 BOM/CRLF）、JSON、缺字段、文件不存在、环境变量优先。
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { VAR_DIR } from '../lib/paths.mjs'
import { TENCENT_ENV, parseTencentSecretFile, resolveTencentSecret } from '../lib/tencent-secret.mjs'

const BASE = join(VAR_DIR, 'test', 'tencent-secret')

export async function runTencentSecretSuite({ it, check }) {
  console.log('\n腾讯云密钥（5.128）：环境变量与**文件**两种读法必须是同一份规则')

  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(BASE, { recursive: true })

  await it('CSV：带 BOM 与 CRLF 也认（腾讯控制台导出的就是这种）', () => {
    const path = join(BASE, 'SecretKey.csv')
    // BOM + CRLF：Windows 上另存的 CSV 几乎一定长这样
    writeFileSync(path, '\uFEFFSecretId,SecretKey\r\nAKIDfake01,fakesecretvalue\r\n', 'utf-8')
    const parsed = parseTencentSecretFile(path)
    check('能读出 SecretId / SecretKey（BOM 不会粘在键名上）',
      parsed.ok === true && parsed.secretId === 'AKIDfake01'
      && parsed.secretKey === 'fakesecretvalue', JSON.stringify(parsed))
    check('CSV 没有 Region 列时 region 为空（缺省由调用方补 ap-shanghai）',
      parsed.region === '', JSON.stringify(parsed.region))
  })

  await it('JSON：键名大小写都认，Region 一起带走', () => {
    const path = join(BASE, 'tencent.json')
    writeFileSync(path, JSON.stringify({
      SecretId: 'AKIDjsonid', SecretKey: 'jsonsecret', Region: 'ap-beijing',
    }), 'utf-8')
    const parsed = parseTencentSecretFile(path)
    check('JSON 能读（含 region）',
      parsed.ok === true && parsed.secretId === 'AKIDjsonid'
      && parsed.secretKey === 'jsonsecret' && parsed.region === 'ap-beijing', JSON.stringify(parsed))
  })

  await it('坏输入：说清是哪一种坏法（不吞成"没有密钥"）', () => {
    const noHeader = join(BASE, 'weird.csv')
    writeFileSync(noHeader, 'id,key\nAKIDx,y\n', 'utf-8')
    const badCsv = parseTencentSecretFile(noHeader)
    check('CSV 表头不对 → 说清表头里缺什么（并回显实际表头）',
      badCsv.ok === false && badCsv.problem.includes('SecretId') && badCsv.problem.includes('id,key'),
      badCsv.problem)

    const halfCsv = join(BASE, 'half.csv')
    writeFileSync(halfCsv, 'SecretId,SecretKey\nAKIDonly,\n', 'utf-8')
    const half = parseTencentSecretFile(halfCsv)
    check('只有 SecretId 没有 SecretKey → 点名缺哪个',
      half.ok === false && half.problem.includes('SecretKey'), half.problem)

    const missing = parseTencentSecretFile(join(BASE, 'nope.csv'))
    check('文件不存在 → 说清是"文件不存在"（带路径）',
      missing.ok === false && missing.problem.includes('不存在') && missing.problem.includes('nope.csv'),
      missing.problem)

    const brokenJson = join(BASE, 'broken.json')
    writeFileSync(brokenJson, '{ "SecretId": "x" ', 'utf-8')
    const broken = parseTencentSecretFile(brokenJson)
    check('坏 JSON → 说清不是合法 JSON（不是静默当没有）',
      broken.ok === false && broken.problem.includes('JSON'), broken.problem)
  })

  await it('两种来源的顺序：环境变量优先，文件兜底，并说清值来自哪一层', () => {
    const path = join(BASE, 'SecretKey.csv')
    const fromFile = resolveTencentSecret({ [TENCENT_ENV.file]: path })
    check('只有文件 → 用文件里的值，from 是文件路径',
      fromFile.secretId === 'AKIDfake01' && fromFile.from === path,
      JSON.stringify({ from: fromFile.from, problem: fromFile.problem }))

    const both = resolveTencentSecret({
      [TENCENT_ENV.id]: 'AKIDenvid', [TENCENT_ENV.key]: 'envkey', [TENCENT_ENV.file]: path,
    })
    check('环境变量和文件都有 → 环境变量赢（与引擎那边同一个顺序）',
      both.secretId === 'AKIDenvid' && both.secretKey === 'envkey' && both.from === '环境变量',
      JSON.stringify({ from: both.from, secretId: both.secretId }))

    const regionFromFile = resolveTencentSecret({
      [TENCENT_ENV.id]: 'AKIDx', [TENCENT_ENV.key]: 'y', [TENCENT_ENV.region]: 'ap-guangzhou',
    })
    check('环境变量里的 region 优先于文件里的',
      regionFromFile.region === 'ap-guangzhou', regionFromFile.region)

    const nothing = resolveTencentSecret({})
    check('两样都没有 → from 是空串（体检据此说"没有"，而不是编一个来源）',
      nothing.from === '' && nothing.secretId === '', JSON.stringify(nothing))

    const badFile = resolveTencentSecret({ [TENCENT_ENV.file]: join(BASE, 'nope.csv') })
    check('文件坏了 → problem 带路径（体检会把它打出来）',
      badFile.problem.includes('nope.csv') && badFile.from === join(BASE, 'nope.csv'),
      badFile.problem)
  })

  rmSync(BASE, { recursive: true, force: true })
}
