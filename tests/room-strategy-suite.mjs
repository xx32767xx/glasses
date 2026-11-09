/**
 * room-strategy-suite.mjs —— 会议创建时**冻结**识别策略（5.148）
 * ============================================================================
 *
 * 这套断言守的是一件事：**改策略表不能影响已经在开的会**。
 * 那条不变量一旦破了，表现是"前半场一个模型、后半场另一个"，而且事后查不出来 ——
 * 所以这里把"快照优先 / 逐字段不变 / 幂等 / 坏文件不阻断"逐条钉住。
 *
 * 另有一条同样重要：**没有快照时回落全局表**（老会议、或建房时没写成），
 * 界面靠 `source` 分清"冻结的"和"当前表"，所以这里连 `source` 也一起断言。
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { VAR_DIR } from '../lib/paths.mjs'
import { loadStrategyTable, resolveProfile, strategyNameOf } from '../lib/asr-engines.mjs'
import {
  appendAudit, auditPath, lockRoomStrategy, readRoomStrategy, resolveAllLanguages, resolveForRoom,
  roomStrategyPath, snapshotForRoom, writeRoomStrategy,
} from '../lib/room-strategy.mjs'

const BASE = join(VAR_DIR, 'test', 'room-strategy')

/** 一份"三种语言各不同"的策略表（用来验证逐语言解析，而不是只看一门）。 */
const TABLE_A = {
  version: 2,
  default: { strategy: 'default', engine: 'whisper', model: 'large-v3', compute_type: 'float16' },
  strategies: {
    'en-parakeet-gpu': { engine: 'parakeet', runtime: 'nemo', model: 'nvidia/parakeet-tdt-0.6b-v2', compute_type: 'fp16' },
    'pt-funasr': { engine: 'funasr', model: 'fun-asr-realtime' },
  },
  languages: {
    'en-US': { strategy: 'en-parakeet-gpu' },
    'pt-BR': { strategy: 'pt-funasr' },
    'zh-CN': { strategy: 'default' },
  },
}

export async function runRoomStrategySuite({ it, check }) {
  console.log('\n会议冻结识别策略（5.148）：改表不动在跑的会 / 快照优先 / 回落全局表')

  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(BASE, { recursive: true })
  const dataDir = join(BASE, 'data')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'asr-models.json'), JSON.stringify(TABLE_A, null, 2), 'utf-8')

  await it('快照按语言逐条落成静态值（不是记住策略名）', () => {
    const snapshot = snapshotForRoom(TABLE_A, { roomId: 'room-a', lockedBy: 'boss', at: 1_700_000_000_000 })
    check('三门语言都在', ['zh-CN', 'en-US', 'pt-BR'].every((lang) => snapshot.languages[lang] !== undefined),
      JSON.stringify(Object.keys(snapshot.languages)))
    check('英语落到 parakeet + fp16', snapshot.languages['en-US'].engine === 'parakeet'
      && snapshot.languages['en-US'].runtime === 'nemo'
      && snapshot.languages['en-US'].model === 'nvidia/parakeet-tdt-0.6b-v2'
      && snapshot.languages['en-US'].compute_type === 'fp16', JSON.stringify(snapshot.languages['en-US']))
    // 云端引擎不认 compute_type，但**继承规则照旧**：快照要如实记录"表里解析出来的值"，
    // 不能自作主张把某门语言的字段删掉 —— 否则快照与 resolveProfile 就对不上了。
    check('葡语落到云端 funasr，compute_type 按继承规则来自 default（float16）',
      snapshot.languages['pt-BR'].engine === 'funasr'
      && snapshot.languages['pt-BR'].model === 'fun-asr-realtime'
      && snapshot.languages['pt-BR'].compute_type === 'float16',
      JSON.stringify(snapshot.languages['pt-BR']))
    check('中文落到 large-v3 / float16', snapshot.languages['zh-CN'].model === 'large-v3'
      && snapshot.languages['zh-CN'].compute_type === 'float16', JSON.stringify(snapshot.languages['zh-CN']))
    check('带 lockedAt / lockedBy / sourceHash 字段（事后能归因）',
      typeof snapshot.lockedAt === 'string' && snapshot.lockedBy === 'boss'
      && snapshot.source === 'asr-models.json', JSON.stringify(snapshot).slice(0, 120))
  })

  await it('**改了策略表，已冻结的会议逐字段不变**（本设计最核心的断言）', () => {
    const snapshot = snapshotForRoom(TABLE_A, { roomId: 'room-a' })
    const before = resolveAllLanguages(TABLE_A, snapshot)
    // 模拟管理员把英语换成 whisper、中文换模型
    const TABLE_B = {
      ...TABLE_A,
      default: { ...TABLE_A.default, model: 'large-v3-turbo' },
      languages: { ...TABLE_A.languages, 'en-US': { strategy: 'default' } },
    }
    const after = resolveAllLanguages(TABLE_B, snapshot)
    for (const lang of ['zh-CN', 'en-US', 'pt-BR']) {
      check(`${lang} 的解析结果与快照完全一致`,
        JSON.stringify(before[lang]) === JSON.stringify(after[lang]),
        `${JSON.stringify(before[lang])} vs ${JSON.stringify(after[lang])}`)
    }
    check('新会议会拿到新表（对照：同一份 TABLE_B、没有快照）',
      resolveForRoom(TABLE_B, 'en-US', null).strategy === 'default',
      JSON.stringify(resolveForRoom(TABLE_B, 'en-US', null)))
  })

  await it('没有快照 → 回落全局表，并且 source 说得清是哪一个', () => {
    const fromTable = resolveForRoom(TABLE_A, 'en-US', null)
    check('从表里解析出 en-parakeet-gpu / fp16',
      fromTable.strategy === 'en-parakeet-gpu' && fromTable.compute_type === 'fp16', JSON.stringify(fromTable))
    check('source=asr-models.json', fromTable.source === 'asr-models.json', fromTable.source)
    check('lockedAt 为空（没冻结就别编一个时间）', fromTable.lockedAt === '', fromTable.lockedAt)

    const snapshot = snapshotForRoom(TABLE_A, { roomId: 'room-a', at: 1_700_000_000_000 })
    const fromSnapshot = resolveForRoom(TABLE_A, 'en-US', snapshot)
    check('有快照时 source=room-strategy 且带 lockedAt',
      fromSnapshot.source === 'room-strategy' && fromSnapshot.lockedAt !== '', JSON.stringify(fromSnapshot))
  })

  await it('落盘：写一次、不覆盖（两个请求同时建房也不互相踩）', () => {
    const roomId = 'room-lock-1'
    const first = lockRoomStrategy(dataDir, roomId, { by: 'boss' })
    check('第一次写入成功', first.ok === true && first.existed === false, JSON.stringify(first).slice(0, 120))
    const path = roomStrategyPath(dataDir, roomId)
    const saved = JSON.parse(readFileSync(path, 'utf-8'))
    check('文件内容与返回值一致（roomId + 三门语言）',
      saved.roomId === roomId && Object.keys(saved.languages).length === 3, JSON.stringify(saved).slice(0, 120))

    // 故意把表改掉，再"重复建房"：不允许覆盖已有快照
    writeFileSync(join(dataDir, 'asr-models.json'),
      JSON.stringify({ ...TABLE_A, default: { ...TABLE_A.default, model: 'tiny' } }, null, 2), 'utf-8')
    const second = lockRoomStrategy(dataDir, roomId, { by: 'alice' })
    check('第二次是 existed（幂等，不报错）', second.ok === true && second.existed === true, JSON.stringify(second))
    const still = JSON.parse(readFileSync(path, 'utf-8'))
    check('快照没被第二次覆盖（还是当时的策略）',
      still.languages['zh-CN'].model === 'large-v3' && still.lockedBy === 'boss', JSON.stringify(still.languages['zh-CN']))

    // 恢复表，后面的断言按原来的表算
    writeFileSync(join(dataDir, 'asr-models.json'), JSON.stringify(TABLE_A, null, 2), 'utf-8')
  })

  await it('坏快照不阻断会议：读不出来就当没有（回落全局表）', () => {
    const roomId = 'room-broken'
    const path = roomStrategyPath(dataDir, roomId)
    writeFileSync(path, '{ 这不是 JSON', 'utf-8')
    check('读坏了返回 null（不抛）', readRoomStrategy(dataDir, roomId) === null)
    const resolved = resolveForRoom(TABLE_A, 'en-US', readRoomStrategy(dataDir, roomId))
    check('回落全局表并把 source 写真话', resolved.source === 'asr-models.json', JSON.stringify(resolved))
    check('没有快照的房间同样返回 null', readRoomStrategy(dataDir, 'room-never') === null)
  })

  await it('审计：每次冻结都留一行（谁/哪场/结果），失败也留', () => {
    appendAudit(dataDir, { by: 'boss', action: 'strategy.lock', roomId: 'room-audit', result: 'ok' })
    const lines = readFileSync(auditPath(dataDir), 'utf-8').trim().split('\n')
    const last = JSON.parse(lines[lines.length - 1])
    check('最后一行就是刚写的那条', last.action === 'strategy.lock' && last.roomId === 'room-audit'
      && last.by === 'boss' && typeof last.at === 'string', JSON.stringify(last))
    check('审计文件追加而不是覆盖（前面还有别行）', lines.length > 1, String(lines.length))
  })

  await it('与解析层逐字一致：快照里写的策略名等于表里该语言选的策略名', () => {
    const snapshot = snapshotForRoom(TABLE_A, { roomId: 'room-consistency' })
    for (const lang of ['zh-CN', 'en-US', 'pt-BR']) {
      const expected = strategyNameOf(TABLE_A, lang)
      check(`${lang} 的策略名 = ${expected}`, snapshot.languages[lang].strategy === expected,
        JSON.stringify(snapshot.languages[lang]))
      const profile = resolveProfile(TABLE_A, lang, expected)
      check(`${lang} 的引擎/模型与 resolveProfile 一致`,
        snapshot.languages[lang].engine === profile.engine
        && snapshot.languages[lang].model === profile.model, JSON.stringify(profile))
    }
  })

  await it('数据目录里没有策略表也能冻结（写成内置缺省，有据可查）', () => {
    const emptyDir = join(BASE, 'no-table')
    mkdirSync(emptyDir, { recursive: true })
    const locked = lockRoomStrategy(emptyDir, 'room-default', { by: 'boss' })
    check('没有表也能成功（不报"配置缺失"）', locked.ok === true, JSON.stringify(locked).slice(0, 120))
    check('快照里是内置缺省 whisper（engine 来自 DEFAULT_ENGINE）',
      locked.snapshot.languages['zh-CN'].engine === 'whisper', JSON.stringify(locked.snapshot.languages['zh-CN']))
  })

  await it('表被外部改坏（语法错）时，冻结仍能进行（loadStrategyTable 不抛）', () => {
    const brokenDir = join(BASE, 'broken-table')
    mkdirSync(brokenDir, { recursive: true })
    writeFileSync(join(brokenDir, 'asr-models.json'), '{ "default": ', 'utf-8')
    const loaded = loadStrategyTable(brokenDir)
    check('读表返回 problem 而不是抛异常', loaded.found === true && loaded.table === null
      && typeof loaded.problem === 'string', JSON.stringify(loaded))
    const locked = lockRoomStrategy(brokenDir, 'room-broken-table', { by: 'boss' })
    check('仍然冻结成功（按内置缺省），会议不会因为表写坏而开不了',
      locked.ok === true && locked.snapshot.languages['en-US'].engine === 'whisper', JSON.stringify(locked.ok))
    check('同时把问题留在快照里可供排查（source 仍标 asr-models.json）',
      locked.snapshot.source === 'asr-models.json', String(locked.snapshot.source))
  })

  await it('房间 id 会被清洗成安全文件名（不会因为奇怪 id 写到目录外）', () => {
    const weird = '../../etc/passwd'
    const path = roomStrategyPath(dataDir, weird)
    check('路径仍在 room-strategy/ 下', path.startsWith(join(dataDir, 'room-strategy')), path)
    check('斜杠被替换掉（不含路径分隔）',
      !path.slice(path.lastIndexOf('room-strategy')).includes('/') || path.split('/').length <= 2, path)
  })
}
