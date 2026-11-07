/**
 * tencent-secret.mjs —— 读腾讯云 ASR 的密钥（环境变量或**文件**）（5.128）
 * ============================================================================
 *
 * 为什么要单独一个模块：**"文件模式"只有引擎能读、体检读不到，就等于体检在说假话**。
 * 5.126 真机配密钥时现场就是这样：
 *
 *   asr.env 里写了 `TENCENT_ASR_SECRET_FILE=/etc/leion/tencent.csv`，
 *   而 `asr-doctor` 只查 `TENCENT_ASR_SECRET_ID` / `..._KEY` 两个环境变量 →
 *   报告「✗ tencent 缺 secretId；缺 secretKey」，看起来像**没配上**。
 *   可实际上识别进程（python 那边）读文件、是能通的。
 *
 * 一份配置两种读法，必然出现"一个说通、一个说没配"。所以两边共用这一份解析：
 *   · `bridge/whisper_stream.py` 的 `TencentEngine.read_secret_file` 认 JSON / CSV；
 *   · 这里给出**同样的规则**的 JS 版本，给 `scripts/asr-doctor.mjs` 用。
 *
 * 支持两种文件形态（都是腾讯控制台/常见导出格式）：
 * <pre>
 *   CSV（表头，可带 BOM / CRLF）：            JSON：
 *   SecretId,SecretKey                       {"SecretId": "AKID…", "SecretKey": "…",
 *   AKIDxxxx,xxxx                              "Region": "ap-shanghai"}
 * </pre>
 *
 * ⚠️ 本模块**永不打印密钥值**：返回的是原值（给引擎用）与"形状问题"（给人看），
 * 打印与打码一律交给调用方（`describeKeyShape`）。
 */

import { readFileSync } from 'node:fs'

/** 环境变量名（与 python 侧、文档 `docs/26` §2.4 必须一致）。 */
export const TENCENT_ENV = Object.freeze({
  id: 'TENCENT_ASR_SECRET_ID',
  key: 'TENCENT_ASR_SECRET_KEY',
  region: 'TENCENT_ASR_REGION',
  file: 'TENCENT_ASR_SECRET_FILE',
})

/**
 * 解析密钥文件（JSON 或带表头的 CSV）。
 *
 * @param {string} path
 * @returns {{ok: boolean, secretId?: string, secretKey?: string, region?: string, problem?: string}}
 */
export function parseTencentSecretFile(path) {
  let text
  try {
    // 去掉 BOM：Windows 上另存的 CSV 几乎一定带，`SecretId` 会因此变成 `\uFEFFSecretId`
    text = readFileSync(path, 'utf-8').replace(/^\uFEFF/, '')
  } catch (error) {
    const code = String(error?.code ?? '')
    if (code === 'ENOENT') return { ok: false, problem: `文件不存在（${path}）` }
    if (code === 'EACCES') {
      return {
        ok: false,
        problem: `读不了（权限）：${path}。服务是 root 跑的所以它能读，但**当前这个用户**读不了 —— `
          + '用 `sudo env TENCENT_ASR_SECRET_FILE=… node scripts/asr-doctor.mjs` 复查',
      }
    }
    return { ok: false, problem: `读失败（${code || 'unknown'}）：${String(error?.message ?? error)}` }
  }

  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    let data
    try {
      data = JSON.parse(trimmed)
    } catch (error) {
      return { ok: false, problem: `不是合法 JSON：${String(error?.message ?? error)}` }
    }
    const secretId = pickString(data, ['SecretId', 'secretId', 'secretid'])
    const secretKey = pickString(data, ['SecretKey', 'secretKey', 'secretkey'])
    const region = pickString(data, ['Region', 'region'])
    return finish(secretId, secretKey, region, 'JSON')
  }

  const rows = trimmed.split(/\r?\n/).map(line => line.split(',').map(cell => cell.trim()))
    .filter(cells => cells.some(cell => cell !== ''))
  if (rows.length < 2) {
    return { ok: false, problem: '格式不认识：要 JSON（SecretId/SecretKey）或带表头的 CSV（SecretId,SecretKey）' }
  }
  const header = rows[0].map(name => name.toLowerCase())
  const idAt = header.indexOf('secretid')
  const keyAt = header.indexOf('secretkey')
  if (idAt < 0 || keyAt < 0) {
    return { ok: false, problem: `CSV 表头里没有 SecretId/SecretKey（实际是：${rows[0].join(',')}）` }
  }
  const regionAt = header.indexOf('region')
  const row = rows[1]
  return finish(row[idAt] ?? '', row[keyAt] ?? '', regionAt >= 0 ? (row[regionAt] ?? '') : '', 'CSV')
}

function pickString(data, names) {
  if (data === null || typeof data !== 'object') return ''
  for (const name of names) {
    const value = data[name]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
    if (typeof value === 'number') return String(value)
  }
  return ''
}

function finish(secretId, secretKey, region, kind) {
  const id = String(secretId ?? '').trim()
  const key = String(secretKey ?? '').trim()
  if (id === '' && key === '') {
    return { ok: false, problem: `${kind} 里两个值都是空的` }
  }
  if (id === '') return { ok: false, problem: `${kind} 里缺 SecretId` }
  if (key === '') return { ok: false, problem: `${kind} 里缺 SecretKey` }
  return { ok: true, secretId: id, secretKey: key, region: String(region ?? '').trim(), kind }
}

/**
 * 这次到底用哪一把密钥：**环境变量优先，文件兜底**（与引擎那边同一个顺序）。
 *
 * @param {Record<string, string | undefined>} env 进程环境（测试里可以传假环境）
 * @returns {{secretId: string, secretKey: string, region: string, from: string, problem: string}}
 *   `from` 是"值来自哪一层"（环境变量 / 文件路径 / 空串）—— 体检要把它说出来，
 *   否则"改了 asr.env 没生效"这种问题只能靠猜。
 */
export function resolveTencentSecret(env = process.env) {
  const id = String(env[TENCENT_ENV.id] ?? '').trim()
  const key = String(env[TENCENT_ENV.key] ?? '').trim()
  const region = String(env[TENCENT_ENV.region] ?? '').trim()
  if (id !== '' && key !== '') {
    return { secretId: id, secretKey: key, region, from: '环境变量', problem: '' }
  }
  const file = String(env[TENCENT_ENV.file] ?? '').trim()
  if (file === '') {
    return { secretId: id, secretKey: key, region, from: '', problem: '' }
  }
  const parsed = parseTencentSecretFile(file)
  if (!parsed.ok) return { secretId: '', secretKey: '', region, from: file, problem: parsed.problem }
  return {
    secretId: id || parsed.secretId,
    secretKey: key || parsed.secretKey,
    region: region || parsed.region || '',
    from: file,
    problem: '',
  }
}
