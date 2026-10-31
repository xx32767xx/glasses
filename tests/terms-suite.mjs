/**
 * terms-suite.mjs —— 用户热词对照表（阶段 1：校验 + 存取 + 三个端点）
 * ============================================================================
 *
 * 这一层**不做任何替换**，所以这里的每一条断言都不需要模型、不需要网络
 * （HTTP 也是本机回环）。它守的是"表写坏了只能让上传失败"这条边界：
 * 表再烂，也不能影响正在跑的字幕。
 *
 * 覆盖四块：
 *   1. 每条拒绝码真的会被触发，且**好表一条都不许拒**（负对照成对出现）
 *   2. 阈值与真实专名的关系（「高通」「安卓」必须能进来 —— 这条是我改过一次阈值的证据）
 *   3. 落盘：原子写、整体替换、同名覆盖、空表等价于关闭
 *   4. 三个端点：validate 不落盘、PUT 全有或全无、GET 回读、鉴权、超大请求体
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startRelay } from '../relay/lan-relay.mjs'
import { VAR_DIR } from '../lib/paths.mjs'
import {
  DEFAULT_USER, TERMS_LIMITS, foldKey, getTable, loadActiveUser, loadTerms, mergePending, normalizeUser,
  saveActiveUser, saveTerms, termsPendingPath, validateTerms,
} from '../lib/terms.mjs'

const TMP = join(VAR_DIR, 'test', 'terms-suite')

const GOOD = [
  { zh: '亮亮视野', pt: 'LLVision' },
  { zh: '亮亮眼镜', pt: 'Leion' },
  { zh: '高通', pt: 'Qualcomm' },
]

export async function runTermsSuite({ it, check, assert }) {
  await rm(TMP, { recursive: true, force: true })
  await mkdir(TMP, { recursive: true })

  // ── 1. 纯函数：校验 ────────────────────────────────────────────────────
  await it('好表一条都不许拒（含 2 字中文名与 3 字符拉丁名）', () => {
    const result = validateTerms([...GOOD, { zh: '安卓', pt: 'Android' }, { zh: '机器学习', pt: 'IBM' }])
    check('全部通过', result.ok === true, JSON.stringify(result.rejected))
    check('接受的条数对', result.accepted === 5, String(result.accepted))
    // 2 字中文名要给**警告**（不拦），因为「高通」会命中「高通量」
    check('2 字中文名给警告而不是拒绝',
      result.warnings.some(w => w.code === 'WARN_SHORT_ZH'), JSON.stringify(result.warnings))
  })

  await it('太短的条目按两档处理：1 个汉字/2 字符硬拒，2 汉字/3 字符只警告', () => {
    const hard = validateTerms([{ zh: '中', pt: 'Zhong' }])
    check('1 个汉字被拒', hard.ok === false && hard.rejected[0].code === 'TOO_SHORT', JSON.stringify(hard.rejected))
    const hardLatin = validateTerms([{ zh: '机器学习', pt: 'Me' }])
    check('2 字符拉丁被拒', hardLatin.ok === false && hardLatin.rejected[0].code === 'TOO_SHORT', JSON.stringify(hardLatin.rejected))
    const warnLatin = validateTerms([{ zh: '机器学习', pt: 'IBM' }])
    check('3 字符拉丁只警告', warnLatin.ok === true && warnLatin.warnings.some(w => w.code === 'WARN_SHORT_LATIN'))
  })

  await it('每条拒绝码都真的会触发（逐条钉住，避免"加了新检查却没人触发"）', () => {
    const cases = [
      [{ zh: '亮亮视野', pt: '' }, 'MISSING_SIDE'],
      [{ zh: '亮亮视野', pt: 'LLVision' }, null],            // 对照组：好条目
      [{ zh: 'X'.repeat(TERMS_LIMITS.maxTextChars + 1), pt: 'LLVision' }, 'TOO_LONG'],
      [{ zh: '亮亮\u200b视野', pt: 'LLVision' }, 'CONTROL_CHARS'],
      [{ zh: '亮亮视野', pt: 'LLVision亮' }, 'HAN_IN_PT'],
      [{ zh: '亮亮视野', pt: 'LLVision', direction: 'up' }, 'BAD_ENUM'],
      [{ zh: '亮亮视野', pt: 'LLVision', enforce: 'strict' }, 'BAD_ENUM'],
      [{ zh: '亮亮视野', pt: 'LLVision', gender: 'x' }, 'BAD_ENUM'],
      [{ zh: '亮亮视野', pt: 'LLVision', variants: 'Liangliang' }, 'ENTRY_MALFORMED'],
      ['不是一个对象', 'ENTRY_MALFORMED'],
    ]
    for (const [entry, expected] of cases) {
      const result = validateTerms([entry])
      if (expected === null) {
        check('对照组必须通过', result.ok === true, JSON.stringify(result.rejected))
        continue
      }
      check(`${expected} 被触发`, result.ok === false && result.rejected[0].code === expected,
        JSON.stringify(result.rejected.map(r => r.code)))
    }
  })

  await it('中文侧写英文名**不拦**（「保留 Leion Pro」是正常需求，只给提醒）', () => {
    const kept = validateTerms([{ zh: 'Leion Pro', pt: 'Leion Pro' }])
    check('两侧同名原样保留 → 接受', kept.ok === true, JSON.stringify(kept.rejected))
    check('给一条"中文侧没有汉字"的提醒',
      kept.warnings.some(w => w.code === 'WARN_NO_HAN_ZH'), JSON.stringify(kept.warnings))
    // 但"两侧写反"仍要拦：葡语侧出现汉字
    const reversed = validateTerms([{ zh: 'Liangliang', pt: '亮亮视野' }])
    check('两侧写反被拒', reversed.ok === false && reversed.rejected[0].code === 'HAN_IN_PT')
  })

  await it('别名冲突按**同一套折叠规则**查（冲突常藏在 variants / approved 里）', () => {
    // A 的变体与 B 的 zh 撞车 → 匹配时会两个条目都命中，必须在上传时就拒
    const clash = validateTerms([
      { zh: '亮亮视野', pt: 'LLVision', variants: ['亮亮视野科技'] },
      { zh: '亮亮视野科技', pt: 'LLVision Tech' },
    ])
    check('跨条目的变体冲突被拒', clash.ok === false && clash.rejected[0].code === 'ALIAS_CONFLICT',
      JSON.stringify(clash.rejected))
    // pt 与 approved 只是大小写/重音不同 → **合法**（approved 的用途就是"同一目标的其它写法"）。
    // 这条是改过的：原来把它算成冲突，于是 `São Paulo` + `Sao Paulo` 这种正常写法会被拒。
    const accents = validateTerms([{ zh: '圣保罗', pt: 'São Paulo', approved: ['Sao Paulo'] }])
    check('重音不同的 approved 应当被接受', accents.ok === true, JSON.stringify(accents.rejected))
    // 但同一个串**既当源写法又当目标写法**必须被拒（会来回替换）
    const selfClash = validateTerms([{ zh: '亮亮视野', pt: 'LLVision', approved: ['亮亮视野'] }])
    check('源写法出现在 approved 里被判冲突',
      selfClash.ok === false && selfClash.rejected[0].code === 'ALIAS_CONFLICT',
      JSON.stringify(selfClash.rejected))
  })

  await it('有歧义的条目可以关掉折叠（docs/15 §5.3）', () => {
    // secretária 与 secretaria 折叠后同一串，但它们是两个词 → 关掉折叠才能并存
    const strict = validateTerms([{ zh: '秘书处', pt: 'secretaria' }, { zh: '秘书', pt: 'secretária', fold: false }])
    check('关掉折叠后可以并存', strict.ok === true, JSON.stringify(strict.rejected))
    const loose = validateTerms([{ zh: '秘书处', pt: 'secretaria' }, { zh: '秘书', pt: 'secretária' }])
    check('不关折叠就按重复处理（宁可拦下，也不要静默互相覆盖）',
      loose.ok === false && ['ALIAS_CONFLICT', 'DUPLICATE_SOURCE'].includes(loose.rejected[0].code),
      JSON.stringify(loose.rejected))
  })

  await it('重复与来回替换：同一源两种目标被拒、A→B 与 B→A 被拒', () => {
    const dup = validateTerms([{ zh: '亮亮视野', pt: 'LLVision' }, { zh: '亮亮视野', pt: 'Leion' }])
    check('同一源写法两个目标被拒', dup.ok === false && dup.rejected[0].code === 'DUPLICATE_SOURCE', JSON.stringify(dup.rejected))
    const exact = validateTerms([{ zh: '亮亮视野', pt: 'LLVision' }, { zh: '亮亮视野', pt: 'LLVision' }])
    check('完全重复被拒', exact.ok === false && exact.rejected[0].code === 'DUPLICATE_SOURCE')
    // 来回替换：这里必须让两侧**写法上能通过字符/长度检查**才测得到 CYCLE ——
    // 中文↔葡语互倒会先被 HAN_IN_PT 拦下（"葡语侧含汉字"），那是另一条更早的闸。
    const cycle = validateTerms([{ zh: 'Leion', pt: 'Lexcon' }, { zh: 'Lexcon', pt: 'Leion' }])
    check('A→B 与 B→A 被拒', cycle.ok === false && cycle.rejected[0].code === 'CYCLE', JSON.stringify(cycle.rejected))
    // 两侧写反的那种，仍然必须进不来（走的是 HAN_IN_PT）
    const reversed = validateTerms([{ zh: '亮亮视野', pt: 'LLVision' }, { zh: 'LLVision', pt: '亮亮视野' }])
    check('写反的两条不会被同时接受',
      reversed.ok === false && ['CYCLE', 'HAN_IN_PT'].includes(reversed.rejected[0].code),
      JSON.stringify(reversed.rejected))
  })

  await it('大小写/重音折叠后算同一个词（docs/15 §5.3 方案 D）', () => {
    check('大小写折叠', foldKey('Leion Pro') === foldKey('LEION PRO'))
    check('重音折叠', foldKey('São Paulo') === foldKey('Sao Paulo'))
    check('空格归一', foldKey('Leion  Pro') === foldKey('Leion Pro'))
    const dupCase = validateTerms([{ zh: '亮亮视野', pt: 'LLVision' }, { zh: '亮亮视野', pt: 'llvision' }])
    check('仅大小写不同的重复也被判重', dupCase.ok === false && dupCase.rejected[0].code === 'DUPLICATE_SOURCE')
  })

  await it('条目 id 由内容决定：同内容同 id，改动即变', () => {
    const a = validateTerms([{ zh: '亮亮视野', pt: 'LLVision' }]).entries[0].id
    const b = validateTerms([{ zh: '亮亮视野', pt: 'LLVision' }]).entries[0].id
    const c = validateTerms([{ zh: '亮亮视野', pt: 'Leion' }]).entries[0].id
    check('同内容同 id（日志里不会一物两号）', a === b, a + ' vs ' + b)
    check('内容变了 id 就变', a !== c)
    check('id 有前缀便于辨认', a.startsWith('t_'), a)
  })

  // ── 1b. 三语术语（5.02）───────────────────────────────────────────────
  //
  // 用户定的规则：中文 / 英语 / 巴葡三种写法**彼此等价** —— 一种语言的句子
  // 要按表里的等价关系译成另外两种。真实词表常常缺一栏，所以允许"两栏"，
  // 缺的那一栏就是"没有等价关系"，**不假装有**。
  await it('5.02 三语：三栏齐全通过，两栏可用（缺栏只警告），一栏拒绝', () => {
    const three = validateTerms([{ zh: '亮亮眼镜', pt: 'Leion Pro', en: 'Leion Pro' }])
    check('三栏通过', three.ok === true, JSON.stringify(three.rejected))
    check('英语那一栏被保留', three.entries[0].en === 'Leion Pro', JSON.stringify(three.entries[0]))
    check('三栏齐全 → 没有缺栏警告',
      three.warnings.every(w => w.code !== 'WARN_SIDE_MISSING'), JSON.stringify(three.warnings))

    const two = validateTerms([{ zh: '货代', en: 'freight forwarder' }])
    check('两栏（中 + 英）通过', two.ok === true, JSON.stringify(two.rejected))
    check('缺的葡语栏留空（不假装有等价关系）', two.entries[0].pt === '', JSON.stringify(two.entries[0]))
    check('缺栏给警告，且说清是哪一栏',
      two.warnings.some(w => w.code === 'WARN_SIDE_MISSING' && w.reason.includes('巴葡')),
      JSON.stringify(two.warnings))

    const one = validateTerms([{ zh: '货代' }])
    check('只有一栏被拒（构不成等价关系）',
      one.ok === false && one.rejected[0].code === 'MISSING_SIDE', JSON.stringify(one.rejected))
    const noZh = validateTerms([{ pt: 'agente de carga', en: 'freight forwarder' }])
    check('没有中文被拒（中文是这张表的主键侧）',
      noZh.ok === false && noZh.rejected[0].code === 'MISSING_SIDE', JSON.stringify(noZh.rejected))
  })

  await it('5.02 三语：英语那一栏同样受"别写反/别写太短"的检查', () => {
    const hanInEn = validateTerms([{ zh: '亮亮视野', pt: 'LLVision', en: '亮亮视野' }])
    check('英语侧含汉字被拒', hanInEn.ok === false && hanInEn.rejected[0].code === 'HAN_IN_EN',
      JSON.stringify(hanInEn.rejected))
    // 只有中 + 英两栏时，"拉丁侧长度"必须取**英语那一栏**（葡语栏是空的）
    const shortEn = validateTerms([{ zh: '机器学习', en: 'Me' }])
    check('两栏条目按已填那一栏判长度 → 英语 2 字符被拒',
      shortEn.ok === false && shortEn.rejected[0].code === 'TOO_SHORT', JSON.stringify(shortEn.rejected))
    const badVariants = validateTerms([{ zh: '亮亮视野', pt: 'LLVision', enVariants: 'LL Vision' }])
    check('enVariants 不是数组被拒',
      badVariants.ok === false && badVariants.rejected[0].code === 'ENTRY_MALFORMED',
      JSON.stringify(badVariants.rejected))
  })

  await it('5.02 三语：同一个写法跨栏出现要拦（葡=英是例外，替换幂等）', () => {
    // 真实需求：产品名在葡语和英语里写法一样 —— 必须放行
    const same = validateTerms([{ zh: '亮亮眼镜', pt: 'Leion Pro', en: 'Leion Pro' }])
    check('葡语与英语同写法 → 通过', same.ok === true, JSON.stringify(same.rejected))
    // 危险：某条的英语规范写法出现在另一条的葡语变体里 → 会来回替换
    const clash = validateTerms([
      { zh: '亮亮视野', pt: 'LLVision' },
      { zh: '亮亮眼镜', pt: 'Óculos', en: 'llvision' },
    ])
    check('跨栏撞车被拦', clash.ok === false && ['ALIAS_CONFLICT', 'DUPLICATE_SOURCE', 'CYCLE'].includes(clash.rejected[0].code),
      JSON.stringify(clash.rejected))
  })

  await it('5.02 三语：条目 id 只在内容真的变了才变（老条目不会被换号）', () => {
    const legacy = validateTerms([{ zh: '亮亮视野', pt: 'LLVision' }]).entries[0].id
    const explicit = validateTerms([{ zh: '亮亮视野', pt: 'LLVision', en: '' }]).entries[0].id
    check('没填英语 ≈ 显式填空串 → 同一个 id',
      legacy === explicit, legacy + ' vs ' + explicit)
    const withEn = validateTerms([{ zh: '亮亮视野', pt: 'LLVision', en: 'LLVision' }]).entries[0].id
    check('补上英语写法 → id 变（内容变了）', withEn !== legacy, withEn)
  })

  await it('用户名归一：空 → default，非法字符被拒', () => {
    check('空回落 default', normalizeUser('').user === DEFAULT_USER)
    check('undefined 回落 default', normalizeUser(undefined).user === DEFAULT_USER)
    check('正常用户名保留', normalizeUser(' wu ').user === 'wu')
    check('带路径分隔符被拒', normalizeUser('../etc').ok === false)
    check('太长的被拒', normalizeUser('x'.repeat(TERMS_LIMITS.maxUserChars + 1)).ok === false)
  })

  // ── 2. 落盘 ────────────────────────────────────────────────────────────
  await it('落盘后能原样读回；没有文件时读成空文档而不是报错', async () => {
    const dir = join(TMP, 'store')
    await mkdir(dir, { recursive: true })
    const before = await loadTerms(dir)
    check('没有文件 → 空文档', Object.keys(before.tables).length === 0)

    const entries = validateTerms(GOOD).entries
    const doc = { version: 1, updatedAt: '2026-10-19T00:00:00.000Z', tables: { wu: { updatedAt: '2026-10-19T00:00:00.000Z', entries } } }
    await saveTerms(dir, doc)
    const after = await loadTerms(dir)
    check('读回来的条数一致', getTable(after, 'wu').entries.length === 3, String(getTable(after, 'wu').entries.length))
    check('读回来的内容一致', getTable(after, 'wu').entries[0].pt === 'LLVision')
    check('没有的用户 → 空表而不是报错', getTable(after, 'nobody').entries.length === 0)
  })

  await it('写坏的文件不影响使用：读成空文档（字幕不能因为这个功能坏掉）', async () => {
    const dir = join(TMP, 'broken')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'terms.json'), '{ 这不是 JSON', 'utf-8')
    const doc = await loadTerms(dir)
    check('坏文件读成空文档', Object.keys(doc.tables).length === 0)

    await writeFile(join(dir, 'terms.json'), JSON.stringify({ version: 1, tables: [] }), 'utf-8')
    const doc2 = await loadTerms(dir)
    check('结构不对（tables 是数组）也读成空文档', Object.keys(doc2.tables).length === 0)
  })

  await it('原子写：临时文件不残留', async () => {
    const dir = join(TMP, 'atomic')
    await mkdir(dir, { recursive: true })
    await saveTerms(dir, { version: 1, updatedAt: null, tables: {} })
    const raw = await readFile(join(dir, 'terms.json'), 'utf-8')
    check('写出来的文件是合法 JSON', JSON.parse(raw) !== null)
    let leftover = true
    try {
      await readFile(join(dir, 'terms.json.tmp'), 'utf-8')
    } catch {
      leftover = false
    }
    check('没有残留 .tmp', leftover === false)
  })

  await it('"当前会话用哪个用户"能存能读，读不到返回 null（不猜）', async () => {
    const dir = join(TMP, 'active')
    await mkdir(dir, { recursive: true })
    check('没有文件 → null', (await loadActiveUser(dir)) === null)
    await saveActiveUser(dir, 'wu')
    check('存了能读回', (await loadActiveUser(dir)) === 'wu')
  })

  // ── 3. HTTP 端点 ───────────────────────────────────────────────────────
  const relay = await startRelay({
    port: 0, host: '127.0.0.1', secret: 'terms-secret',
    dataDir: TMP, inbox: join(TMP, 'asr-inbox.jsonl'), bus: join(TMP, 'subtitle-bus.json'),
    pollHoldMs: 200, busPollMs: 30, quiet: true,
  })
  const base = `http://127.0.0.1:${relay.port}`
  const call = async (path, { method = 'GET', body, secret = 'terms-secret' } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(secret === null ? {} : { 'x-leion-secret': secret }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    })
    const text = await response.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch { /* 保留 null */ }
    return { status: response.status, json, text }
  }

  try {
    await it('没有密钥一律 401（表和字幕用同一把锁）', async () => {
      const result = await call('/terms?user=wu', { secret: null })
      check('401', result.status === 401, String(result.status))
    })

    await it('validate 只校验不落盘：文件不存在，好表返回 ok', async () => {
      const result = await call('/terms/validate', { method: 'POST', body: { user: 'wu', entries: GOOD } })
      check('200', result.status === 200, result.text)
      check('没有保存', result.json.saved === false, result.text)
      let exists = true
      try {
        await readFile(join(TMP, 'terms.json'), 'utf-8')
      } catch {
        exists = false
      }
      check('文件确实没被创建', exists === false)
    })

    await it('PUT 坏表 → 400 且原表**一条都不变**（全有或全无）', async () => {
      const good = await call('/terms', { method: 'PUT', body: { user: 'wu', entries: GOOD } })
      check('先存一张好表', good.status === 200 && good.json.saved === true, good.text)

      const bad = await call('/terms', {
        method: 'PUT',
        body: { user: 'wu', entries: [{ zh: '亮亮视野', pt: 'LLVision' }, { zh: '中', pt: 'Zhong' }] },
      })
      check('400', bad.status === 400, bad.text)
      check('指出了第几条', bad.json.rejected[0].index === 1, bad.text)

      const after = await call('/terms?user=wu')
      check('重读还是原来那 3 条（坏表没写进去）', after.json.entries.length === 3, after.text)
      check('内容没被污染', after.json.entries[0].pt === 'LLVision')
    })

    await it('PUT 好表 → 存下、能读回、并写明"下次同传生效"与冲突信息', async () => {
      // 用一个没用过的用户名，免得受前面测试写过的表影响（顺序无关）
      const first = await call('/terms', { method: 'PUT', body: { user: 'fresh', entries: GOOD } })
      check('首次上传 overwritten=false', first.json.overwritten === false, first.text)
      const second = await call('/terms', {
        method: 'PUT',
        body: { user: 'fresh', entries: [{ zh: '亮亮眼镜', pt: 'Leion' }] },
      })
      check('再次上传 overwritten=true 且带上原来的条数',
        second.json.overwritten === true && second.json.previousEntries === 3, second.text)
      check('生效时机写明', second.json.effectiveAt === 'next-session', second.text)
      const after = await call('/terms?user=fresh')
      check('整体替换（旧条目不会残留）', after.json.entries.length === 1, after.text)
    })

    await it('用户之间互不干扰', async () => {
      await call('/terms', { method: 'PUT', body: { user: 'wu', entries: GOOD } })
      await call('/terms', { method: 'PUT', body: { user: 'li', entries: [{ zh: '机器学习', pt: 'Aprendizado de máquina' }] } })
      const wu = await call('/terms?user=wu')
      const li = await call('/terms?user=li')
      const none = await call('/terms?user=nobody')
      check('wu 还是 3 条', wu.json.entries.length === 3, wu.text)
      check('li 是 1 条', li.json.entries.length === 1, li.text)
      check('没传过的用户是空表（等价于关闭）', none.status === 200 && none.json.entries.length === 0, none.text)
    })

    await it('空表可以传，且行为等同"没有热词表"', async () => {
      const put = await call('/terms', { method: 'PUT', body: { user: 'blank', entries: [] } })
      check('200', put.status === 200, put.text)
      const got = await call('/terms?user=blank')
      check('读回 0 条', got.json.entries.length === 0, got.text)
    })

    await it('用户名非法 → 400（它会变成文件名与日志字段）', async () => {
      const result = await call('/terms?user=../etc%2Fpasswd')
      check('400', result.status === 400, result.text)
    })

    await it('请求体超上限 → 413，且连接不被污染（下一个请求照常）', async () => {
      const huge = { user: 'wu', entries: [{ zh: '亮亮视野', pt: 'x'.repeat(TERMS_LIMITS.maxBodyBytes) }] }
      const result = await call('/terms', { method: 'PUT', body: huge })
      check('413', result.status === 413, String(result.status))
      const after = await call('/status')
      check('后续请求正常', after.status === 200, String(after.status))
    })

    await it('/status 里能看到热词表状态（不用 grep 日志）', async () => {
      const result = await call('/status')
      check('有 termsSaves 计数', typeof result.json.termsSaves === 'number', result.text)
      check('已经记过至少一次', result.json.termsSaves > 0, result.text)
      check('记下了最近上传的用户', typeof result.json.termsUser === 'string' && result.json.termsUser !== '', result.text)
    })

    await it('/hello?user= 会记下当前用户（供插件下一场取表），非法用户名不拦握手', async () => {
      const hello = await call('/hello?user=zhang')
      check('握手成功', hello.status === 200 && hello.json.ok === true, hello.text)
      check('状态里记下了', (await call('/status')).json.termsUser === 'zhang')
      const bad = await call('/hello?user=..%2F..%2Fetc')
      check('非法用户名不拦握手（连接优先）', bad.status === 200, bad.text)
      check('但也没有被当成用户名', (await call('/status')).json.termsUser === 'zhang')
    })
  } finally {
    await relay.close()
  }

  // ── 5. 待入表队列（B 方案：插件追加、relay 合并，docs/15 §18.2）────────
  await it('待入表合并：合法的进 wrong、队列被清空、能原样读回', async () => {
    const dir = join(TMP, 'pending-merge')
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    const checked = validateTerms([{ zh: '亮亮眼镜', pt: 'Leion', approved: ['Leion'] }])
    await saveTerms(dir, { version: 1, updatedAt: null, tables: { default: { updatedAt: null, entries: checked.entries } } })
    const line = JSON.stringify({ t: 'now', event: 'pending', user: 'default', zh: '亮亮眼镜', candidate: 'Liangliang Ótica', canonical: 'Leion' })
    await writeFile(termsPendingPath(dir), line + '\n', 'utf-8')

    const result = await mergePending(dir)
    check('合入一条', result.merged === 1, JSON.stringify(result))
    const doc = await loadTerms(dir)
    const entry = getTable(doc, 'default').entries.find(item => item.zh === '亮亮眼镜')
    check('变体进了 wrong', JSON.stringify(entry.wrong) === JSON.stringify(['Liangliang Ótica']), JSON.stringify(entry.wrong))
    check('队列被清空', (await readFile(termsPendingPath(dir), 'utf-8').catch(() => '')) === '', '队列还在')
  })

  await it('待入表合并：已登记/与规范写法相同 → 跳过；表里没有 → 拒绝并留证据', async () => {
    const dir = join(TMP, 'pending-skip')
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    const checked = validateTerms([{ zh: '亮亮眼镜', pt: 'Leion', approved: ['Leion'], wrong: ['Liangliang Ótica'] }])
    await saveTerms(dir, { version: 1, updatedAt: null, tables: { default: { updatedAt: null, entries: checked.entries } } })
    const lines = [
      { event: 'pending', user: 'default', zh: '亮亮眼镜', candidate: 'Liangliang Ótica', canonical: 'Leion' },  // 已登记
      { event: 'pending', user: 'default', zh: '亮亮眼镜', candidate: 'leion', canonical: 'Leion' },               // 与规范写法相同
      { event: 'pending', user: 'default', zh: '不存在的名字', candidate: 'Xxx', canonical: 'Leion' },              // 表里没有
      '坏行不是 JSON',
    ]
    await writeFile(termsPendingPath(dir), lines.map(item => (typeof item === 'string' ? item : JSON.stringify(item))).join('\n') + '\n', 'utf-8')
    const result = await mergePending(dir)
    check('合入 0 条', result.merged === 0, JSON.stringify(result))
    check('跳过 2 条（已登记 + 相同）', result.skipped === 2, JSON.stringify(result))
    check('拒绝 2 条（表里没有 + 坏行）', result.rejected.length === 2, JSON.stringify(result.rejected))
    check('拒绝明细落盘（可查为什么没合进去）',
      result.rejectedFile !== null && (await readFile(result.rejectedFile, 'utf-8')).includes('不存在的名字'),
      String(result.rejectedFile))
  })

  await it('待入表合并：没有队列文件 → 什么都不做，不报错', async () => {
    const dir = join(TMP, 'pending-none')
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    const result = await mergePending(dir)
    check('返回 0', result.merged === 0 && result.rejected.length === 0, JSON.stringify(result))
  })
}
