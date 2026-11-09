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
import { ROOT, VAR_DIR } from '../lib/paths.mjs'
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

  await it('根本没有表时只给一句 note（不按三门语言各报一条"没写模型名"）', async () => {
    const emptyRoot = join(BASE, 'no-table')
    mkdirSync(emptyRoot, { recursive: true })
    const read = await handleOrg({ root: emptyRoot, method: 'GET', path: '/org/asr/models', user: 'boss@x', role: 'admin' })
    check('200 且 source.found=false', read.status === 200 && read.json.source.found === false,
      JSON.stringify(read.json.source))
    check('有一条 note 说明"用的是内置缺省"', typeof read.json.note === 'string'
      && /缺省/.test(read.json.note), String(read.json.note))
    check('**不再**冒出三条"策略表里没写模型名"', (read.json.warnings || []).length === 0,
      JSON.stringify(read.json.warnings))
    check('languages 为空（不编数据）', Object.keys(read.json.languages || {}).length === 0)
  })

  await it('策略表里的中文是乱码时，明确提示"文件可能被按 GBK 存过"', async () => {
    const mojibakeRoot = join(BASE, 'mojibake')
    mkdirSync(mojibakeRoot, { recursive: true })
    // 用乱码字构造一份"看起来像表、中文全坏"的文件（模拟 Windows 上按 GBK 另存过）
    const broken = sampleTable()
    broken._comment = ['\u953B\u9428\u9384\u935B']  // 乱码字（用转义写，保持本文件 UTF-8 干净）
    writeFileSync(join(mojibakeRoot, 'asr-models.json'), JSON.stringify(broken, null, 2), 'utf-8')
    const read = await handleOrg({ root: mojibakeRoot, method: 'GET', path: '/org/asr/models', user: 'boss@x', role: 'admin' })
    check('提示里点名"乱码"与"GBK"',
      (read.json.warnings || []).some((one) => /乱码/.test(one) && /GBK/.test(one)),
      JSON.stringify(read.json.warnings))
  })

  await it('初始化示例表：写入一份带全部候选策略的 UTF-8 模板（换机器后能直接选）', async () => {
    const seedRoot = join(BASE, 'seed')
    mkdirSync(seedRoot, { recursive: true })
    const seeded = await handleOrg({ root: seedRoot, method: 'POST', path: '/org/asr/models/seed', user: 'boss@x', role: 'admin', body: {} })
    check('200 且表里有 en-parakeet-gpu', seeded.status === 200
      && seeded.json.table.strategies && seeded.json.table.strategies['en-parakeet-gpu'] !== undefined,
      JSON.stringify(Object.keys(seeded.json.table.strategies || {})))
    check('写盘的是 UTF-8 且没有乱码',
      !/锛|鐨|鏄|鍦|浜|鎴/.test(readFileSync(join(seedRoot, 'asr-models.json'), 'utf-8')))
    check('没有原文件时不产生备份（backup 为空）', seeded.json.backup === '', String(seeded.json.backup))
    const again = await handleOrg({ root: seedRoot, method: 'POST', path: '/org/asr/models/seed', user: 'boss@x', role: 'admin', body: {} })
    check('重复初始化会先备份', typeof again.json.backup === 'string' && again.json.backup.includes('.bak-'),
      String(again.json.backup))
    const denied = await handleOrg({ root: seedRoot, method: 'POST', path: '/org/asr/models/seed', user: 'dev@x', role: 'dev', body: {} })
    check('dev 不能初始化 → 403', denied.status === 403, String(denied.status))
  })

  await it('管理页前端：对象体统一序列化（"请求体不是合法 JSON" 的根因）+ 示例表按钮', () => {
    const html = readFileSync(join(ROOT, 'scripts', 'admin-ui.html'), 'utf-8')
    check('api() 会把对象体 JSON.stringify（调用方传对象不再变成 [object Object]）',
      /typeof body !== 'string'\) body = JSON\.stringify\(body\)/.test(html))
    check('结束会议/改账号状态/续期都走同一个 api()（不会再出现裸对象体）',
      /closeRoom/.test(html) && /api\('\/org\/accounts\//.test(html))
    check('面板有「初始化示例表」按钮', /onclick="seedModels\(\)"/.test(html))
    check('面板会显示服务端的 note（"还没有表"只提示一句）', /data\.note/.test(html))
    // 5.149：语言行**只选策略**；模型/精度挂在策略上 —— 这是"换策略、模型名不变"的修法
    check('语言行只有策略下拉（没有 mdModel_/mdCompute_ 这种语言级覆盖输入）',
      !/mdModel_/.test(html) && !/mdCompute_/.test(html))
    check('有一块「策略定义（模型 + 精度）」用来编辑 default 与具名策略',
      /策略定义（模型 \+ 精度）/.test(html) && /id="modelStrategies"/.test(html)
      && /stModel_/.test(html) && /stCompute_/.test(html))
    check('保存时会清掉 languages 行里的模型/精度覆盖（否则压住新策略）',
      /delete layer\.model/.test(html) && /delete layer\.compute_type/.test(html))
  })
}
