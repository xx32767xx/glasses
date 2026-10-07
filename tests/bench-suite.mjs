/**
 * bench-suite.mjs —— 翻译模型横评那一套判据的自检
 * ============================================================================
 *
 * 为什么这一套值得进全量验证：**横评表好看不等于结论可信**。
 * 判据（数字有没有丢、有没有出现葡葡词、是不是压根没翻译）只要写错一点，
 * 结果就是"所有模型都满分"或"所有模型都不及格"—— 而这两种都会让人做出错误选型。
 *
 * 这里钉住的正是**判据本身**：
 *   · 真该报错的必须报（欧葡词、回显原文、加前言、空译文）
 *   · **不该报错的必须不报** —— 这一半更重要：`tu` 当子串匹配会命中
 *     faturamento/tudo，`metro` 会命中 parâmetros，`equipa` 会命中 equipamentos。
 *     这类误报会让"最守规矩的模型"看起来最差（真踩过）。
 *
 * 另外钉住两条**结构性**的东西：提示词只有 policy 一个来源；表格单元格不带竖线。
 */

import { readFileSync } from 'node:fs'

import { verdictOf, selfCheck, toMarkdown, CANDIDATES } from '../scripts/bench-models.mjs'
import { judgeRegional, REGIONAL } from '../scripts/bench-regional.mjs'
import { translationSystem } from '../plugin/core.mjs'

export async function runBenchSuite({ it, check, assert }) {
  const policy = JSON.parse(readFileSync('policy/br-pt.json', 'utf8'))

  await it('判据自检全过（含"不该误报"的负对照）', async () => {
    const problems = selfCheck(policy.terminology)
    check('判据自检没有报出问题', problems.length === 0, problems.join('；'))
  })

  await it('负对照：把术语表改坏，自检必须变红（否则自检形同虚设）', async () => {
    // 把巴葡词与葡葡词设成同一个，等于判据再也分不出巴葡/葡葡
    const broken = policy.terminology.map(entry =>
      entry.zh === '手机' ? { zh: entry.zh, br: 'celular', ptpt: 'celular' } : entry)
    const problems = selfCheck(broken)
    check('坏掉的术语表被自检抓到了', problems.length > 0, '自检在判据坏掉时仍然全绿 —— 它没有在验任何东西')
  })

  await it('真该报错的都报：欧葡词 / 回显原文 / 加前言 / 空译文', async () => {
    const source = '我们今天的会议改到了下午三点。'
    const mustFail = {
      '欧葡词 telemóvel': 'Comprei um telemóvel novo.',
      '欧葡词 autocarro': 'Vou de autocarro para o centro.',
      '欧葡词 comboio': 'Pegamos o comboio às três.',
      '回显中文原文': source,
      '加了前言': '译文：A reunião de hoje mudou para as três da tarde.',
      '空译文': '   ',
      '译文里还夹着汉字': 'A reunião de hoje 改到了下午三点。',
    }
    for (const [name, text] of Object.entries(mustFail)) {
      const judged = verdictOf(source, text, policy.terminology)
      check(`${name} → 判成事故`, judged.fatal.length > 0, JSON.stringify(judged.fatal))
    }
  })

  await it('不该报错的必须不报（子串误报是这一套的头号陷阱）', async () => {
    const source = '去年我们的营收是 2.7 亿。'
    const mustPass = {
      'faturamento 里没有 tu': 'O faturamento foi de 270 milhões no ano passado.',
      'tudo 里没有 tu': 'Deu tudo certo no ano passado.',
      'parâmetros 里没有 metro': 'Precisa passar dois parâmetros.',
      'equipamentos 里没有 equipa': 'Os equipamentos chegaram ontem.',
      'atual 里没有 tu': 'A situação atual está boa.',
      '正常巴葡术语': 'A gente pega o ônibus, depois o metrô, e compra a passagem pelo celular.',
    }
    for (const [name, text] of Object.entries(mustPass)) {
      const judged = verdictOf(source, text, policy.terminology)
      check(`${name} → 不报事故`, judged.fatal.length === 0, JSON.stringify(judged.fatal))
    }
  })

  await it('数字判据：2.7 亿 → 270 milhões 不该算丢数字，漏掉才算', async () => {
    const source = '去年我们的营收是 2.7 亿，增长是 18.6%。'
    const kept = verdictOf(source, 'O faturamento foi de 270 milhões, com crescimento de 18,6%.', policy.terminology)
    // 换算成 270 milhões 时数字串对不上，判据会提醒；但**不能**升级成"事故"，
    // 因为"2.7 亿 → 270 milhões"是正确译法。这正是判据要放行的一类。
    check('换算写法不被判成事故', kept.fatal.length === 0, JSON.stringify(kept.fatal))
    const lost = verdictOf(source, 'O faturamento cresceu bastante no ano passado.', policy.terminology)
    check('整句数字都没了 → 报出丢数字',
      lost.notes.some(n => n.level === 'bad' && n.text.startsWith('数字可能丢了')), JSON.stringify(lost.notes))
  })

  await it('超显示预算要报出来，并说清"丢的是开头几行"', async () => {
    const judged = verdictOf('随便一句话。', 'palavra '.repeat(60).trim(), policy.terminology)
    check('确实超过 3 行', judged.wrapped.length > 3, String(judged.wrapped.length))
    check('报的条数 = 折行数 - 3（丢开头）',
      judged.notes.some(n => n.text.includes(`丢掉开头 ${judged.wrapped.length - 3} 行`)), JSON.stringify(judged.notes))
  })

  await it('横评用的提示词来自 policy，不是脚本里手抄的一份', async () => {
    const prompt = translationSystem(policy, 'zh-CN', 'pt-BR')
    check('带上"巴西葡萄牙语"而不是泛泛的葡语', prompt.includes('巴西葡萄牙语'), prompt.slice(0, 80))
    check('逐条带上了 policy 的翻译规则', policy.translationRules.every(rule => prompt.includes(rule)))
    check('巴葡专用规则也在（译成巴葡时才有意义）', policy.ptBrRules.every(rule => prompt.includes(rule)))
    check('术语表以"不用葡葡说法"的形式附上',
      policy.terminology.every(entry => prompt.includes(entry.br) && prompt.includes(entry.ptpt)))
    check('译成中文时**不**附术语表（用不上，白占上下文）',
      translationSystem(policy, 'pt-BR', 'zh-CN').includes('不用 autocarro') === false)
  })

  await it('候选表里每个模型都有 key 来源、baseUrl 是 OpenAI 兼容端点', async () => {
    check('候选不为空', CANDIDATES.length > 0)
    for (const candidate of CANDIDATES) {
      check(`${candidate.key} 有 apiKeyEnv`, typeof candidate.apiKeyEnv === 'string' && candidate.apiKeyEnv !== '')
      check(`${candidate.key} 的 baseUrl 是 https`, String(candidate.baseUrl).startsWith('https://'))
      check(`${candidate.key} 有 model`, typeof candidate.model === 'string' && candidate.model !== '')
      check(`${candidate.key} 写了"为什么值得测"`, typeof candidate.note === 'string' && candidate.note.length > 10)
    }
    check('产线基线在候选里（不测基线就没法说"要不要换模型"）',
      CANDIDATES.some(c => c.key === 'deepseek'), CANDIDATES.map(c => c.key).join(','))
  })

  await it('对比表里不带裸竖线（否则贴进 Markdown 会散架）', async () => {
    const rows = [{
      model: 'm|1', index: 1, round: 1, ok: true, elapsed: 100,
      text: 'a | b', fatal: [], notes: [], wrapped: ['a'], shown: ['a'], source: 's',
    }]
    const table = toMarkdown(rows, { system: true })
    const dataLines = table.split('\n').filter(line => line.startsWith('| m'))
    check('模型名里的竖线被转义了', dataLines[0].includes('m\\|1'), dataLines[0])
    check('表头行数正确', table.split('\n')[0].startsWith('| 模型 | 句数 |'), table.split('\n')[0])
    assert.ok(table.includes('P95'), '汇总表里应该有 P95')
  })

  // ── 巴葡区域变体那一套 ────────────────────────────────────────────────────
  //
  // 方案把"巴葡口音适配（圣保罗、里约、南部、东北部）"列为**核心指标**，
  // 而原来的句集一条都没覆盖。这一组补上，但它的判据天生比数字/术语那套**松**
  // —— 所以既验"它认得出正确的"，也验"它挡得住明显错的"，
  // 并且把它的两个已知漏洞写在断言里（漏了会让人误以为这个判据很可靠）。

  await it('区域说法判据：认得出正确的，挡得住明显错的', async () => {
    const spec = REGIONAL[0].items[0]
    check('正确译文判过',
      judgeRegional('A gente pode se reunir amanhã de manhã pra conversar sobre isso.', spec).ok === true)
    check('完全翻错判不过', judgeRegional('Eu vou comer arroz hoje.', spec).ok === false)
    check('原样抄回中文判不过', judgeRegional(spec.text, spec).ok === false)
  })

  await it('区域判据的两个已知漏洞（写下来，别让人以为它很可靠）', async () => {
    // 漏洞一：只命中一个常用词就算过 —— 「vamos」这种日常词太容易蒙中
    const loose = REGIONAL[3].items[1]
    check('⚠️ 只蒙中一个常用词就算过（判据偏松，这是已知的）',
      judgeRegional('Vamos embora daqui agora.', loose).ok === true,
      '这个断言如果变红，说明判据收紧了 —— 那是好事，请把这条注释一起改掉')
    // 漏洞二：只翻对一半（"贵"翻出来了、"别买"没有）也算过
    check('⚠️ 只翻对一半也算过（判据偏松，这是已知的）',
      judgeRegional('Isso é caro.', REGIONAL[0].items[1]).ok === true,
      '同上：变红说明收紧了，是好事')
  })

  await it('量级判据：「2.7 亿」译成 bilhões 是差 10 倍的真错，别放过', async () => {
    // 实测漏掉过这一处：Qwen2.5-72B 把「2.7 亿」译成 `2,7 bilhões`（= 27 亿），
    // 而它自己另一句译成了 270 milhões —— 同一批里前后不一致。
    // 旧判据只查"数字在不在"，2.7 与 270 归一化后对得上，于是放过了这处 10 倍错。
    const source = '去年我们的营收是 2.7 亿，今年上半年的增长是 18.6%。'
    const wrong = verdictOf(source, 'No ano passado, nossa receita foi de 2,7 bilhões. No primeiro semestre deste ano, o crescimento foi de 18,6%.', policy.terminology)
    check('bilhões → 判量级错', wrong.fatal.includes('量级错'), JSON.stringify(wrong.fatal))
    const right = verdictOf(source, 'No ano passado nosso faturamento foi de 270 milhões, com crescimento de 18,6%.', policy.terminology)
    check('270 milhões → 不判量级错', right.fatal.includes('量级错') === false, JSON.stringify(right.fatal))
    // 别误伤：原文本来就说了"十亿"时，bilhão 是对的
    const billionSource = '这笔投资是 5 十亿。'
    const billion = verdictOf(billionSource, 'Esse investimento é de 5 bilhões.', policy.terminology)
    check('原文本来就有"十亿"时不判', billion.fatal.includes('量级错') === false, JSON.stringify(billion.fatal))
  })

  await it('幻听判据：legendas 是"字幕"的正确翻译，不该被误判', async () => {
    // 真踩过的误报：Hunyuan-MT 把「…从麦克风采集到字幕显示…」译成
    // `…até a exibição dos legendas…` —— 那是**正确翻译**，但旧判据只看有没有这个词。
    // 判据误报的代价很实在：它会让译文质量好的模型看起来最差。
    const withSource = verdictOf('这条测试语音是为了验证整条链路，从麦克风采集到字幕显示。',
      'Este áudio de teste é para verificar toda a cadeia, desde a captação pelo microfone até a exibição dos legendas.',
      policy.terminology)
    check('原句提到"字幕"时，legendas 不算幻听',
      withSource.fatal.includes('幻听') === false, JSON.stringify(withSource.fatal))

    const noSource = verdictOf('我们今天的会议改到了下午三点。',
      'Legendas pela comunidade. Obrigado por assistir.', policy.terminology)
    check('无出处时仍然判幻听', noSource.fatal.includes('幻听'), JSON.stringify(noSource.fatal))
  })

  await it('区域句集每个区域组都写清"为什么测"，每句都有期待词', async () => {
    check('至少有 4 个区域组（对应方案里的圣保罗/里约/南部/东北部）',
      REGIONAL.length >= 4, String(REGIONAL.length))
    for (const group of REGIONAL) {
      check(`${group.region} 写了 why`, typeof group.why === 'string' && group.why.length > 8)
      check(`${group.region} 至少 2 句`, group.items.length >= 2, String(group.items.length))
      for (const item of group.items) {
        check(`${group.region}｜${item.text.slice(0, 8)}… 有期待词`,
          Array.isArray(item.expectAny) && item.expectAny.length > 0)
      }
    }
  })
}
