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
    // 5.149：每列最上面要有最短解释（用户要求），并且具名策略可以删
    check('策略表有表头（策略名 / engine / runtime / 模型名 / 精度）',
      /buildHeader/.test(html) && /engine 引擎/.test(html)
      && /runtime 后端/.test(html) && /模型名 \/ 本地路径/.test(html) && /精度 compute_type/.test(html))
    check('语言行也有表头（语种 / 用哪个策略 / 实际会用到什么）',
      /语种/.test(html) && /用哪个策略/.test(html))
    check('具名策略能删（default 不能删）；删除会登记到 modelDeletedStrategies',
      /modelDeletedStrategies/.test(html) && /name !== 'default'/.test(html))
    check('删除后引用它的语言改回 default（不留悬空引用）',
      /strategy === name\) next\.languages\[lang\]\.strategy = 'default'/.test(html))

    // 5.149：示例模板里删掉了三条"不是模型"的候选
    const example = JSON.parse(readFileSync(join(ROOT, 'config', 'asr-models.json'), 'utf-8'))
    check('示例表里不再有 en-tiny / en-fast / en-accurate',
      ['en-tiny', 'en-fast', 'en-accurate'].every((name) => example.strategies[name] === undefined),
      JSON.stringify(Object.keys(example.strategies)))
    check('示例表仍保留该有的候选（parakeet CPU/GPU、云端、葡语、中文）',
      ['en-parakeet', 'en-parakeet-gpu', 'en-tencent', 'pt-funasr', 'zh-steady']
        .every((name) => example.strategies[name] !== undefined),
      JSON.stringify(Object.keys(example.strategies)))

    // 5.182：三个语种各一套策略（用户要求"手动去调，互不牵扯"）。
    //   起手值一样（min_speech 700 / max_speech 8000 / float16），但**必须分成三条**：
    //   只在一条里调，才知道改的是哪种语言的效果。
    const per = { 'zh-CN': 'zh-steady', 'en-US': 'en-steady', 'pt-BR': 'pt-steady' }
    for (const [lang, name] of Object.entries(per)) {
      const layer = example.strategies[name]
      check(`${lang} 有自己的策略 ${name}`, layer !== undefined, JSON.stringify(Object.keys(example.strategies)))
      check(`${name} 自己写明了切句参数（不靠继承，方便按语种单独调）`,
        layer?.segmentation?.min_speech_ms === 700 && layer?.segmentation?.max_speech_ms === 8000,
        JSON.stringify(layer?.segmentation))
      check(`${lang} 指向 ${name}`, example.languages[lang]?.strategy === name,
        JSON.stringify(example.languages[lang]))
    }
    check('三条策略都写死 float16（换卡之后不该再是 int8_float32）',
      Object.values(per).every((name) => String(example.strategies[name].compute_type).toLowerCase() === 'float16'),
      JSON.stringify(Object.fromEntries(Object.values(per).map((name) => [name, example.strategies[name].compute_type]))))
    check('缺省层也跟着改用 float16（老机器要在部署时改回 int8_float32）',
      String(example.default.compute_type).toLowerCase() === 'float16', String(example.default.compute_type))
    check('三条策略各自绑一个语种（A/B 时不会串台）',
      example.strategies['zh-steady'].langs?.includes('zh-CN')
      && example.strategies['en-steady'].langs?.includes('en-US')
      && example.strategies['pt-steady'].langs?.includes('pt-BR'),
      JSON.stringify(Object.values(per).map((name) => example.strategies[name].langs)))
  })
  // 5.185：用户要求"按语种各自调切句参数，而且要在管理台里调"。
  // 这一组钉住：写进 languages[语种].segmentation、读回来、越界拒绝、以及"谁覆盖谁"。
  await it('5.185：按语种的切句参数在管理台可读可写（越界拒写）', async () => {
    const table = sampleTable()
    table.languages['zh-CN'] = { strategy: 'zh-steady', segmentation: { silence_ms: 700, min_speech_ms: 700, max_speech_ms: 8000 } }
    table.strategies['zh-steady'] = { model: 'large-v3', compute_type: 'float16' }
    const saved = await call({
      method: 'PUT', path: '/org/asr/models', user: 'admin@x', role: 'admin', body: { table },
    })
    check('admin 能保存带切句参数的表', saved.status === 200 && saved.json.ok === true,
      JSON.stringify(saved.json?.problems ?? saved.json))

    const read = await call({ method: 'GET', path: '/org/asr/models', user: 'admin@x', role: 'admin' })
    check('读回来带着这门语言的切句参数',
      read.json.table.languages['zh-CN'].segmentation.max_speech_ms === 8000,
      JSON.stringify(read.json.table.languages['zh-CN']))
    check('服务端算出了"实际生效值"（界面占位符用它）',
      read.json.segmentation?.['zh-CN']?.values?.min_speech_ms === 700,
      JSON.stringify(read.json.segmentation?.['zh-CN']?.values))
    check('并标出每个字段来自哪一层（语言 > 策略 > default）',
      read.json.segmentation['zh-CN'].layers.min_speech_ms === '语言 zh-CN',
      JSON.stringify(read.json.segmentation['zh-CN'].layers))
    check('其他语言没被牵连（英语还是 default 层）',
      read.json.segmentation['en-US'].layers.min_speech_ms !== '语言 zh-CN',
      JSON.stringify(read.json.segmentation['en-US'].layers))
    check('界面能拿到字段规则（每个框的 min/max/label）',
      read.json.segmentationRules?.max_speech_ms?.max > 0
      && typeof read.json.segmentationRules.max_speech_ms.label === 'string',
      JSON.stringify(read.json.segmentationRules?.max_speech_ms))

    // 越界：拒绝保存（切句侧拿到这种值只会每段报错/静默失效）
    const bad = sampleTable()
    bad.languages['zh-CN'] = { strategy: 'zh-steady', segmentation: { silence_ms: 999999 } }
    const rejected = await call({
      method: 'PUT', path: '/org/asr/models', user: 'admin@x', role: 'admin', body: { table: bad },
    })
    check('切句参数越界 → 409 invalid-segmentation',
      rejected.status === 409 && rejected.json.error === 'invalid-segmentation',
      JSON.stringify(rejected.json))
    check('错误里指出是哪门语言', String((rejected.json.problems ?? []).join(' ')).includes('zh-CN'),
      JSON.stringify(rejected.json.problems))
    const stillGood = await call({ method: 'GET', path: '/org/asr/models', user: 'admin@x', role: 'admin' })
    check('拒写之后表还是好的（没被写坏）',
      stillGood.json.table.languages['zh-CN'].segmentation.max_speech_ms === 8000,
      JSON.stringify(stillGood.json.table.languages['zh-CN']))
  })

  await it('5.185/5.192：管理台有"每语种一行"的切句输入框，并显示当前生效值', async () => {
    const html = readFileSync(join(ROOT, 'scripts', 'admin-ui.html'), 'utf-8')
    check('每门语言一行切句输入框（id 带语种与字段名）',
      /'segLang_' \+ lang \+ '_' \+ key/.test(html), '缺输入框构造')
    check('六个字段都在名单里', /const SEG_FIELDS = \['silence_ms', 'min_speech_ms', 'max_speech_ms',/.test(html))
    check('留空 = 继承（占位符显示实际生效值）', /input\.placeholder = String\(effective\[key\]/.test(html))
    check('保存时写进 languages[语种].segmentation',
      /layer\.segmentation = seg/.test(html) && /delete layer\.segmentation/.test(html))
    // 5.192：全局旋钮删除后，这一行改成**直接显示生效值**（用户要的就是这个）
    check('每门语言那一行显示当前生效值', /生效：/.test(html) && /effective\[key\]/.test(html))
    check('面板位置指向按语种入口，并说清"留空 = 继承"',
      /已并入「识别模型」/.test(html) && /留空 = 继承/.test(html))
  })

  // 5.187：用户拍板"高通默认打开、VAD 做成和切句参数一样的配法、管理台手动开关"。
  // 这一组钉住四件事：读得到实际生效值与来源、按语种可写、越界拒写、界面真有那两排开关。
  await it('5.187：降噪四项（高通 / VAD）逐语种可读可写（越界拒写）', async () => {
    const base = sampleTable()
    base.default = { ...(base.default || {}), highpass_hz: 100 }
    base.languages['zh-CN'] = { strategy: 'default' }
    const savedDefault = await call({
      method: 'PUT', path: '/org/asr/models', user: 'admin@x', role: 'admin', body: { table: base },
    })
    check('高通写在 default 层也能保存', savedDefault.status === 200 && savedDefault.json.ok === true,
      JSON.stringify(savedDefault.json?.problems ?? savedDefault.json))

    const read = await call({ method: 'GET', path: '/org/asr/models', user: 'admin@x', role: 'admin' })
    check('界面拿得到每门语言实际生效的降噪值',
      read.json.noise?.['zh-CN']?.values?.highpass_hz === 100,
      JSON.stringify(read.json.noise?.['zh-CN']?.values))
    check('并说清高通是 default 层给的（继承链能看见）',
      read.json.noise['zh-CN'].layers.highpass_hz === 'default',
      JSON.stringify(read.json.noise['zh-CN'].layers))
    check('VAD 缺省是关（会剪首尾，不悄悄开）',
      read.json.noise['zh-CN'].values.vad === false, JSON.stringify(read.json.noise['zh-CN'].values))
    check('字段规则给到界面（VAD 是开关、高通有上下限）',
      read.json.noiseRules?.vad?.type === 'switch' && read.json.noiseRules?.highpass_hz?.max > 0,
      JSON.stringify(read.json.noiseRules))
    check('内置缺省也给了（没有表时界面照实显示"高通关、VAD 关"）',
      read.json.noiseDefaults?.highpass_hz === 0 && read.json.noiseDefaults?.vad === false,
      JSON.stringify(read.json.noiseDefaults))

    // 关掉高通的写法就是 0（否则用户只能删字段，而删字段是"继承"不是"关"）
    const offTable = sampleTable()
    offTable.default = { ...(offTable.default || {}), highpass_hz: 100 }
    offTable.languages['zh-CN'] = { strategy: 'default', highpass_hz: 0, vad: true, vad_threshold: 0.6 }
    const offSaved = await call({
      method: 'PUT', path: '/org/asr/models', user: 'admin@x', role: 'admin', body: { table: offTable },
    })
    check('按语种关掉高通（0）、开 VAD、调门槛都能存',
      offSaved.status === 200 && offSaved.json.ok === true, JSON.stringify(offSaved.json?.problems ?? ''))
    const offRead = await call({ method: 'GET', path: '/org/asr/models', user: 'admin@x', role: 'admin' })
    check('中文这一路读回来是高通关 / VAD 开',
      offRead.json.noise['zh-CN'].values.highpass_hz === 0 && offRead.json.noise['zh-CN'].values.vad === true,
      JSON.stringify(offRead.json.noise['zh-CN'].values))
    check('语言层压过 default 层（来源写得出来）',
      offRead.json.noise['zh-CN'].layers.vad === '语言 zh-CN',
      JSON.stringify(offRead.json.noise['zh-CN'].layers))
    check('别的语言没被牵连（英语还是 default 的 100 / 关）',
      offRead.json.noise['en-US'].values.highpass_hz === 100
      && offRead.json.noise['en-US'].values.vad === false,
      JSON.stringify(offRead.json.noise['en-US'].values))

    // 写错的东西不许进表：识别侧遇到 "100" 这种字符串只会静默不生效，比报错难查得多
    const badString = sampleTable()
    badString.languages['zh-CN'] = { strategy: 'default', highpass_hz: '100' }
    const rejectedType = await call({
      method: 'PUT', path: '/org/asr/models', user: 'admin@x', role: 'admin', body: { table: badString },
    })
    check('高通写成字符串 → 409 invalid-noise',
      rejectedType.status === 409 && rejectedType.json.error === 'invalid-noise',
      JSON.stringify(rejectedType.json))
    check('错误里指出是哪门语言的哪一项',
      String((rejectedType.json.problems ?? []).join(' ')).includes('zh-CN'),
      JSON.stringify(rejectedType.json.problems))

    const badRange = sampleTable()
    badRange.languages['en-US'] = { strategy: 'en-parakeet-gpu', vad_threshold: 3 }
    const rejectedRange = await call({
      method: 'PUT', path: '/org/asr/models', user: 'admin@x', role: 'admin', body: { table: badRange },
    })
    check('VAD 门槛写 3（超出 0.05~0.95）也被拒',
      rejectedRange.status === 409 && rejectedRange.json.error === 'invalid-noise',
      JSON.stringify(rejectedRange.json.problems))

    const badVad = sampleTable()
    badVad.languages['pt-BR'] = { strategy: 'pt-funasr', vad: 'yes' }
    const rejectedVad = await call({
      method: 'PUT', path: '/org/asr/models', user: 'admin@x', role: 'admin', body: { table: badVad },
    })
    check('VAD 只能写 true / false（写字符串会被拒，而不是当成开）',
      rejectedVad.status === 409 && rejectedVad.json.error === 'invalid-noise',
      JSON.stringify(rejectedVad.json.problems))

    const stillGood = await call({ method: 'GET', path: '/org/asr/models', user: 'admin@x', role: 'admin' })
    check('拒写之后表还是上一版好的（没被写坏）',
      stillGood.json.table.languages['zh-CN'].highpass_hz === 0,
      JSON.stringify(stillGood.json.table.languages['zh-CN']))
  })

  await it('5.187：管理台有「降噪」面板（全局一行 + 每语种一行，高通/VAD 手动开关）', async () => {
    const html = readFileSync(join(ROOT, 'scripts', 'admin-ui.html'), 'utf-8')
    check('面板容器在（#noisePanel）', /id="noisePanel"/.test(html), '缺面板')
    check('每个语种一行、id 带语种与字段名',
      /'noiseLang_' \+ scope \+ '_' \+ key/.test(html) && /noiseLang_/.test(html), '缺按语种的输入框')
    check('全局那一行也有（写 default 层）', /noiseDefault_/.test(html), '缺全局输入框')
    check('VAD 是下拉开关（继承 / 开 / 关），不是一个要手输 true 的框',
      /\['', '继承'\], \['on', '开'\], \['off', '关'\]/.test(html), 'VAD 不是开关')
    check('留空 = 继承（占位符显示实际生效值）',
      /input\.placeholder = effective && effective\[key\]/.test(html))
    check('行尾写明"生效值 + 是谁定的"', /生效：高通/.test(html) && /from\('vad'\)/.test(html))
    check('说明里点明代价不同（高通缺省开 / VAD 缺省关）',
      /高通缺省开/.test(html) && /VAD 缺省关/.test(html) && /剪掉不像人声的头尾/.test(html))
    check('保存时写进 languages[语种] / default 的同名层',
      /readNoiseRow\(lang\)/.test(html) && /readNoiseRow\(''\)/.test(html))
    check('校验失败会把具体问题带到界面上（不只一个错误码）',
      /Array\.isArray\(data\.problems\)/.test(html), 'problems 没带出来')
  })

  await it('5.193：降噪那一块**就地**有保存按钮（用户报过"根本找不到保存"）', async () => {
    const html = readFileSync(join(ROOT, 'scripts', 'admin-ui.html'), 'utf-8')
    // 用户原话：界面里「降噪（逐语种）」根本没有保存按钮。
    // 事实是整表保存的按钮在「策略定义」之后，隔了两个小节 —— 找得到才怪。
    const noiseAt = html.indexOf('id="noisePanel"')
    check('降噪面板还在', noiseAt > 0)
    const after = html.slice(noiseAt, noiseAt + 1200)
    check('降噪面板**紧跟着**就有一排按钮（不是隔两个小节）',
      /onclick="saveModels\(\)"/.test(after), '降噪那一块附近没有保存按钮')
    check('那个按钮写明它保存的是什么（切句 + 降噪 + 策略，整表）',
      /切句 \+ 降噪 \+ 策略/.test(after), '按钮文案没说清保存范围')
    check('旁边还有"放弃改动 / 重新读取"',
      /onclick="loadModels\(\)"/.test(after))
    check('说明里点明"改完点下面那排保存，不点只在页面上好看"',
      /不点保存只在页面上好看/.test(html))
    check('改过东西会在按钮旁提示"有未保存改动"',
      /id="noiseDirty"/.test(html) && /有未保存改动/.test(html))
    check('提示用事件委托挂（innerHTML 重建也不会掉）',
      /body\.addEventListener\('input', mark\)/.test(html), '监听挂在会重建的节点上了')
    check('底部那排按钮也写明"整张表"（两处是同一个动作，别让人以为范围不同）',
      /保存（整张表 · 只影响新会议）/.test(html))
  })

  await it('5.187：界面渲染出的 id 与保存时读的 id 对得上（最小 DOM 桩真跑一遍）', () => {
    // 这条不能只靠正则：`noiseDefault_x` / `noiseLang_<语种>_x` 是**渲染**与**保存**两处各写一遍的
    // 字符串，写歪了界面上一片正常、保存时却把值悄悄丢了 —— 最难查的一类。
    const html = readFileSync(join(ROOT, 'scripts', 'admin-ui.html'), 'utf-8')
    const grabFn = (name) => {
      const start = html.indexOf(`function ${name}(`)
      check(`${name} 还在（改名时这条测试要跟着改）`, start > 0, name)
      return html.slice(start, html.indexOf('\n}', start) + 2)
    }
    const grabConst = (name) => {
      const start = html.indexOf(`const ${name} = `)
      check(`${name} 还在`, start > 0, name)
      return html.slice(start, html.indexOf('\n', start))
    }
    const code = [grabConst('NOISE_FIELDS'), grabConst('NOISE_SHORT'), grabFn('buildHeader'),
      grabFn('buildNoiseRow'), grabFn('readNoiseRow'),
      'return { buildNoiseRow, readNoiseRow }'].join('\n')

    const makeEl = (tag) => ({
      tag, id: '', className: '', style: {}, dataset: {}, children: [], value: '', textContent: '',
      type: '', min: '', max: '', step: '', placeholder: '', title: '',
      appendChild(child) { this.children.push(child); return child },
    })
    const byId = new Map()
    const stubDocument = {
      createElement: (tag) => makeEl(tag),
      getElementById: (id) => byId.get(id) ?? null,
    }
    const rules = {
      highpass_hz: { min: 0, max: 2000, step: 10, label: '高通 (Hz)', note: 'x' },
      vad: { type: 'switch', note: 'y' },
      vad_max_ms: { min: 200, max: 30000, step: 100 },
      vad_threshold: { min: 0.05, max: 0.95, step: 0.05 },
    }
    // eslint-disable-next-line no-new-func
    const built = new Function('document', 'noiseRules', code)(stubDocument, rules)
    const register = (el) => {
      if (el.id) byId.set(el.id, el)
      for (const child of el.children) register(child)
      return el
    }

    const effective = { highpass_hz: 100, vad: false, vad_max_ms: 2000, vad_threshold: 0.5 }
    register(built.buildNoiseRow('', '全局', { highpass_hz: 100 }, effective, { highpass_hz: 'default' }))
    check('全局那一行渲染出四个控件（高通 / VAD / 短段上限 / 门槛）',
      ['highpass_hz', 'vad', 'vad_max_ms', 'vad_threshold']
        .every((key) => byId.has('noiseDefault_' + key)), [...byId.keys()].join(','))
    check('只写了高通的全局行，读回来也只有高通（留空 = 继承，不写这一项）',
      JSON.stringify(built.readNoiseRow('')) === '{"highpass_hz":100}',
      JSON.stringify(built.readNoiseRow('')))

    register(built.buildNoiseRow('zh-CN', '中文', { highpass_hz: 0, vad: true }, effective, {}))
    check('语种行渲染出的 id 带语种（保存时读得到同一批值）',
      ['highpass_hz', 'vad', 'vad_max_ms', 'vad_threshold']
        .every((key) => byId.has('noiseLang_zh-CN_' + key)), [...byId.keys()].join(','))
    check('高通 0 与 VAD 开都能原样读回来（0 是"关"，不是"没填"）',
      JSON.stringify(built.readNoiseRow('zh-CN')) === '{"highpass_hz":0,"vad":true}',
      JSON.stringify(built.readNoiseRow('zh-CN')))

    byId.get('noiseDefault_highpass_hz').value = ''
    byId.get('noiseDefault_vad').value = ''
    check('全留空 = 一项都不写（回到继承 / 内置缺省）',
      Object.keys(built.readNoiseRow('')).length === 0, JSON.stringify(built.readNoiseRow('')))
  })

}
