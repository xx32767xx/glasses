/**
 * asr-models-api-suite.mjs —— 管理员改识别策略表（5.148 第 3 段）
 * ============================================================================
 *
 * 这一层要守的不是"能不能存"，而是**谁能存、存进去的会不会坏**：
 *   · 只有 admin 能写（dev / user 一律 403）—— 它影响之后**所有**新建会议；
 *   · 结构不对（精度写错、策略名指向不存在的东西）**拒绝入库**，不留一张跑不起来的表；
 *   · 能存但跑不起来的（模型没下载）**允许保存但必须警告** —— 管理员可能有意先定表、稍后下载；
 *   · 每次写入留备份 + 审计（谁、改之前是什么）。
 *
 * 另有一条同样重要的反向断言：**写完表之后，已有房间的冻结快照逐字段不变**。
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { VAR_DIR } from '../lib/paths.mjs'
import { resolveDataDir } from '../lib/store.mjs'
import { handleOrg } from '../relay/org-api.mjs'
import { auditPath } from '../lib/room-strategy.mjs'
import { loadStrategyTable } from '../lib/asr-engines.mjs'

const BASE = join(VAR_DIR, 'test', 'asr-models-api')

/** 一份能用的表（三门语言各不同，英语走 parakeet 的 GPU 路线）。 */
function sampleTable() {
  return {
    version: 2,
    default: { strategy: 'default', model: 'large-v3', compute_type: 'float16', beam_size: 5 },
    strategies: {
      'en-parakeet-gpu': {
        engine: 'parakeet', runtime: 'nemo', model: 'nvidia/parakeet-tdt-0.6b-v2',
        compute_type: 'fp16', langs: ['en-US'],
      },
      'pt-funasr': { engine: 'funasr', model: 'fun-asr-realtime', langs: ['pt-BR'] },
    },
    languages: {
      'zh-CN': { strategy: 'default' },
      'en-US': { strategy: 'en-parakeet-gpu' },
      'pt-BR': { strategy: 'pt-funasr' },
    },
  }
}

export async function runAsrModelsApiSuite({ it, check }) {
  console.log('\n管理员改识别策略表（5.148）：权限 / 校验 / 备份 + 审计 / 不动已冻结的会议')

  rmSync(BASE, { recursive: true, force: true })
  await mkdirSync(BASE, { recursive: true })
  const root = resolveDataDir(BASE, 'test')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'asr-models.json'), JSON.stringify(sampleTable(), null, 2), 'utf-8')

  const call = (options) => handleOrg({
    root, log: () => {}, strategyOf: () => null, pipelineOf: () => null, ...options,
  })

  await it('读：admin 与 dev 都能看，未登录 401', async () => {
    const anonymous = await call({ method: 'GET', path: '/org/asr/models' })
    check('没登录 → 401', anonymous.status === 401, String(anonymous.status))

    for (const role of ['admin', 'dev']) {
      const read = await call({ method: 'GET', path: '/org/asr/models', user: `${role}@x`, role })
      check(`${role} 能读表`, read.status === 200 && read.json.ok === true, String(read.status))
      check(`${role} 看到的逐语言结果是对的（英语 parakeet / fp16）`,
        read.json.languages['en-US'].engine === 'parakeet'
        && read.json.languages['en-US'].compute_type === 'fp16', JSON.stringify(read.json.languages['en-US']))
      check(`${role} 能拿到 runtime（GPU 还是 CPU 全靠它）`,
        read.json.languages['en-US'].runtime === 'nemo', JSON.stringify(read.json.languages['en-US']))
    }

    const userRead = await call({ method: 'GET', path: '/org/asr/models', user: 'u@x', role: 'user' })
    check('普通用户读 → 403（model.read 只给 admin/dev）', userRead.status === 403, String(userRead.status))
  })

  await it('写：只有 admin；dev / user 一律 403', async () => {
    for (const [role, who] of [['dev', 'dev@x'], ['user', 'u@x']]) {
      const denied = await call({
        method: 'PUT', path: '/org/asr/models', user: who, role, body: { table: sampleTable() },
      })
      check(`${role} 写 → 403`, denied.status === 403 && denied.json.code === 'forbidden',
        JSON.stringify(denied.json).slice(0, 120))
    }
  })

  await it('校验：结构坏的东西**拒绝入库**（且逐条说清哪里错）', async () => {
    const bad = sampleTable()
    bad.default = { strategy: 'default', model: 'large-v3', compute_type: 'float666' }
    const rejected = await call({
      method: 'PUT', path: '/org/asr/models', user: 'boss@x', role: 'admin', body: { table: bad },
    })
    check('409 invalid-table', rejected.status === 409 && rejected.json.error === 'invalid-table',
      JSON.stringify(rejected.json).slice(0, 120))
    check('problems 指出是 compute_type 写错', /compute_type/.test(String(rejected.json.problems)),
      JSON.stringify(rejected.json.problems))

    const stillOld = loadStrategyTable(root).table
    check('被拒的表**没有**写进库（还是原来那份）',
      stillOld.default.compute_type === 'float16', JSON.stringify(stillOld.default))

    const dangling = sampleTable()
    dangling.languages['zh-CN'] = { strategy: '不存在的策略' }
    const danglingReject = await call({
      method: 'PUT', path: '/org/asr/models', user: 'boss@x', role: 'admin', body: { table: dangling },
    })
    check('引用不存在的策略名 → 拒绝', danglingReject.status === 409
      && /不存在的策略/.test(String(danglingReject.json.problems)), JSON.stringify(danglingReject.json.problems))

    const validate = await call({
      method: 'POST', path: '/org/asr/models/validate', user: 'boss@x', role: 'admin', body: { table: bad },
    })
    check('validate 是 dry-run（只报不写）', validate.status === 200
      && validate.json.ok === false && Array.isArray(validate.json.problems))
    check('validate 之后库还是原来的', loadStrategyTable(root).table.default.compute_type === 'float16')
  })

  await it('能存但跑不起来的策略：**允许保存 + 明确警告**', async () => {
    const withMissing = sampleTable()
    withMissing.strategies['en-turbo'] = {
      engine: 'whisper', model: '/opt/leion/models/不存在的模型', compute_type: 'float16', langs: ['en-US'],
    }
    withMissing.languages['en-US'] = { strategy: 'en-turbo' }
    const saved = await call({
      method: 'PUT', path: '/org/asr/models', user: 'boss@x', role: 'admin', body: { table: withMissing },
    })
    check('保存成功（200）', saved.status === 200 && saved.json.ok === true, String(saved.status))
    check('警告里点名"这条策略现在跑不起来"',
      saved.json.warnings.some((one) => /跑不起来|不存在/.test(one)), JSON.stringify(saved.json.warnings))
    check('写完之后库里就是新的（en-US 指向 en-turbo）',
      loadStrategyTable(root).table.languages['en-US'].strategy === 'en-turbo')
  })

  await it('写表留下备份与审计（谁、什么时候、改之前是什么）', async () => {
    const beforeCount = (() => {
      try { return readFileSync(auditPath(root), 'utf-8').trim().split('\n').filter(Boolean).length } catch { return 0 }
    })()
    const next = sampleTable()
    next.languages['en-US'] = { strategy: 'en-parakeet-gpu' }
    const saved = await call({
      method: 'PUT', path: '/org/asr/models', user: 'boss@x', role: 'admin', body: { table: next },
    })
    check('返回里带备份文件名', typeof saved.json.backup === 'string' && saved.json.backup.includes('.bak-'),
      String(saved.json.backup))
    const backupBody = readFileSync(saved.json.backup, 'utf-8')
    check('备份内容 = 改之前那份（en-US 还指向 en-turbo）',
      /en-turbo/.test(backupBody), backupBody.slice(0, 80))

    const lines = readFileSync(auditPath(root), 'utf-8').trim().split('\n').filter(Boolean)
    check('审计多了一行', lines.length === beforeCount + 1, `${beforeCount} -> ${lines.length}`)
    const last = JSON.parse(lines[lines.length - 1])
    check('审计记了谁、动作、改前后',
      last.by === 'boss@x' && last.action === 'models.write'
      && last.before?.['en-US']?.strategy === 'en-turbo'
      && last.after?.['en-US']?.strategy === 'en-parakeet-gpu', JSON.stringify(last).slice(0, 160))

    const history = await call({ method: 'GET', path: '/org/asr/models/history?limit=10', user: 'boss@x', role: 'admin' })
    check('history 能读到（最新的在最前）',
      history.status === 200 && history.json.entries.length >= 1
      && history.json.entries[0].action === 'models.write', String(history.json.entries.length))
  })

  await it('**改表不动已冻结的会议**（这条是整件事的意义）', async () => {
    const { lockRoomStrategy, readRoomStrategy } = await import('../lib/room-strategy.mjs')
    const { resolveAllLanguages } = await import('../lib/room-strategy.mjs')
    const locked = lockRoomStrategy(root, 'room-old', { by: 'boss@x' })
    check('先冻结一场会（用改之前的表）', locked.ok === true, JSON.stringify(locked.ok))
    const snapshotBefore = JSON.stringify(readRoomStrategy(root, 'room-old'))

    const next = sampleTable()
    next.languages['en-US'] = { strategy: 'default' }
    next.default = { strategy: 'default', model: 'large-v3-turbo', compute_type: 'int8_float32' }
    const saved = await call({
      method: 'PUT', path: '/org/asr/models', user: 'boss@x', role: 'admin', body: { table: next },
    })
    check('改表成功', saved.status === 200)

    const snapshotAfter = JSON.stringify(readRoomStrategy(root, 'room-old'))
    check('旧会议的冻结快照一个字节都没变', snapshotBefore === snapshotAfter, '不该变')

    const tableNow = loadStrategyTable(root).table
    const oldResolved = resolveAllLanguages(tableNow, readRoomStrategy(root, 'room-old'))
    check('旧会议按快照解析（英语仍是 parakeet / fp16）',
      oldResolved['en-US'].engine === 'parakeet' && oldResolved['en-US'].compute_type === 'fp16',
      JSON.stringify(oldResolved['en-US']))
    const newResolved = resolveAllLanguages(tableNow, null)
    check('新会议按新表（英语回 whisper / large-v3-turbo）',
      newResolved['en-US'].engine === 'whisper' && newResolved['en-US'].model === 'large-v3-turbo',
      JSON.stringify(newResolved['en-US']))
  })

  await it('表被外部写坏时，GET 如实说"读不了"（不假装有表）', async () => {
    writeFileSync(join(root, 'asr-models.json'), '{ 这不是 JSON', 'utf-8')
    const read = await call({ method: 'GET', path: '/org/asr/models', user: 'boss@x', role: 'admin' })
    check('200 但 source.problem 说清读不了',
      read.status === 200 && read.json.source.found === true
      && typeof read.json.source.problem === 'string' && read.json.source.problem !== '',
      JSON.stringify(read.json.source))
    check('此时 table 是空的（不编一份假的）', Object.keys(read.json.table).length === 0,
      JSON.stringify(Object.keys(read.json.table)))
    writeFileSync(join(root, 'asr-models.json'), JSON.stringify(sampleTable(), null, 2), 'utf-8')
  })
}
