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
}
