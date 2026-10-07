/**
 * lint-suite.mjs —— 译文质检判据（`lib/translation-lint.mjs`）的测试
 * ============================================================================
 *
 * ⚠️ 这一套的重点**不是**"该报的报"，而是"**不该报的不报**"。
 *
 * 理由是实测过的代价：判据误报一次（Hunyuan-MT 把「字幕」正确译成 `legendas`
 * 却被幻听词表判成事故），结果就是**译文质量好的模型排名垫底** —— 那是结论级错误，
 * 比漏报严重得多。所以每个判据都配了成对的负对照：
 * 左边验"真错必须报"，右边验"**正确译法一个都不许报**"。
 *
 * 三层对应 docs/08 第 4 节：
 *   ① 专名（音译/新造）  ② 实体槽（楼层/房间号丢失）  ③ 性数一致
 */

import { readFileSync } from 'node:fs'

import {
  lintTranslation, properNounProblems, slotProblems, agreementProblems,
  numberValues, hasNumber, parseChineseNumber, floorSlots, roomSlots,
} from '../lib/translation-lint.mjs'

export async function runLintSuite({ it, check, assert }) {
  const policy = JSON.parse(readFileSync('policy/br-pt.json', 'utf8'))
  const lint = (source, translation) => lintTranslation(source, translation, policy)

  // ── 0. 数字归一化：三层判据全都建在它上面，先把它钉死 ──────────────────────

  await it('中文数字能解析（「十二楼」=12，不是 2）', async () => {
    check('十二 → 12', parseChineseNumber('十二') === 12, String(parseChineseNumber('十二')))
    check('单字「十」→ 10', parseChineseNumber('十') === 10, String(parseChineseNumber('十')))
    check('三点二十里的「二十」→ 20', parseChineseNumber('二十') === 20)
    check('八 → 8', parseChineseNumber('八') === 8)
    check('二十五 → 25', parseChineseNumber('二十五') === 25)
    check('一百二十 → 120', parseChineseNumber('一百二十') === 120)
    check('非数字返回 null', parseChineseNumber('abc') === null)
  })

  await it('中葡两种写法能算成同一个数（这是"数字对不对"判据的地基）', async () => {
    const cases = [
      ['2.7 亿', '270 milhões', true, '必须换算后相等：2.7×10⁸ = 270×10⁶'],
      ['2.7 亿', '2,7 bilhões', false, '差 10 倍 —— 实测 Qwen2.5 的真错'],
      ['18.6%', '18,6%', true, '小数点写法不同'],
      ['3980', '3980', true, '原样'],
      ['十二楼', '12º andar', true, '中文数字 ↔ 阿拉伯数字'],
      ['十二楼', 'décimo segundo andar', true, '序数词'],
      ['802', 'quarto 802', true, '房间号'],
      ['398000', 'trezentos e noventa e oito mil', true, '累加式：大单位前的部分要先累加再乘（398×1000）'],
      ['3980', 'três mil novecentos e oitenta', true, '3980 的正确葡语写法'],
      ['5', 'mil', false, '5 不是 1000'],
    ]
    for (const [source, translation, expected, note] of cases) {
      const actual = hasNumber(source, translation)
      check(`${source} ↔ ${translation} → ${expected ? '应当算对上' : '应当算对不上'}（${note}）`,
        actual === expected, `实际 ${actual}`)
    }
  })

  await it('floorSlots：楼层抽取只认「数字+楼」，不误抓别的数字', async () => {
    assert.deepEqual(floorSlots('地点从十二楼的第二会议室换到了八楼的 802 房间'), [12, 8])
    assert.deepEqual(floorSlots('12楼和8楼'), [12, 8])
    check('「三点二十」不被当楼层', floorSlots('下午三点二十开会').length === 0,
      JSON.stringify(floorSlots('下午三点二十开会')))
    check('「3980 元」不被当楼层', floorSlots('每台 3980 元').length === 0,
      JSON.stringify(floorSlots('每台 3980 元')))
  })

  await it('roomSlots：房间号必须挨着「房间/会议室/号」，不误抓金额', async () => {
    assert.deepEqual(roomSlots('换到了八楼的 802 房间'), [802])
    assert.deepEqual(roomSlots('会议室 1201'), [1201])
    check('金额不被当房间号', roomSlots('每台 3980 元').length === 0, JSON.stringify(roomSlots('每台 3980 元')))
    check('年份不被当房间号', roomSlots('2026 年的计划').length === 0, JSON.stringify(roomSlots('2026 年的计划')))
  })

  // ── ① 专名 ─────────────────────────────────────────────────────────────────

  await it('① 专名：音译了公司名必须报', async () => {
    const source = '我们和亮亮视野合作开发的这款 Leion Pro。'
    const bad = lint(source, 'Desenvolvemos este Leion Pro em parceria com a Liangliang Vision.')
    check('Liangliang Vision → 判事故', bad.fatal.some(note => note.kind === '专名新造'),
      JSON.stringify(bad.fatal))
  })

  await it('① 专名：认可写法与"原样保留中文"都不许报', async () => {
    const source = '我们和亮亮视野合作开发的这款 Leion Pro。'
    const approved = lint(source, 'Desenvolvemos este Leion Pro em parceria com a LLVision.')
    check('LLVision（认可写法）→ 不判事故',
      approved.fatal.some(note => note.kind === '专名新造') === false, JSON.stringify(approved.fatal))
    const kept = lint(source, 'Desenvolvemos este Leion Pro em parceria com a 亮亮视野.')
    check('原样保留中文 → 不判事故',
      kept.fatal.some(note => note.kind === '专名新造') === false, JSON.stringify(kept.fatal))
  })

  await it('① 专名：用了认可写法但靠"先验知识"时要给警告（结果对、理由不对）', async () => {
    // DeepSeek 把「亮亮视野」写成 LLVision —— 结果对，但那是模型自己知道，
    // 不是从原文推出来的。同传里这属于擅自替说话人改词，不可控，所以要提示。
    const warned = lint('我们和亮亮视野合作。', 'Em parceria com a LLVision.')
    check('给"专名蹭对"的警告', warned.warn.some(note => note.kind === '专名蹭对'),
      JSON.stringify(warned.warn))
    check('但不算事故', warned.fatal.length === 0, JSON.stringify(warned.fatal))
  })

  await it('① 专名：警告不能吵 —— 正常翻译（高通→Qualcomm）不许报', async () => {
    // ⚠️ 这条是"噪音"的护栏。实测第一版对「高通 → Qualcomm」也报"蹭对"警告，
    //    但那是**正常翻译**，每次都报就成了噪音 —— 而噪音的代价是让人开始忽略警告，
    //    那比不报还糟。所以由 policy 里的 warnWhenApproved 决定报不报。
    const normal = lint('用的是高通的芯片。', 'usa chip da Qualcomm.')
    check('高通→Qualcomm 不报警告', normal.warn.length === 0, JSON.stringify(normal.warn))
    check('也不报事故', normal.fatal.length === 0, JSON.stringify(normal.fatal))
  })

  await it('① 专名：高通被音译成 Gaotong 仍然要报（留着这条是为了防将来）', async () => {
    const bad = lint('用的是高通的芯片。', 'usa chip da Gaotong.')
    check('Gaotong → 判新造', bad.fatal.some(note => note.kind === '专名新造'), JSON.stringify(bad.fatal))
  })

  await it('① 专名：原文没提到的专名，译文里怎么译都不管（不许误报）', async () => {
    const clean = lint('我们今天的会议改到了下午三点。', 'Nossa reunião de hoje mudou para as três da tarde.')
    check('没有专名 → 一条都不报', clean.notes.length === 0, JSON.stringify(clean.notes))
  })

  await it('① 专名：太短的"疑似音译"串不许误命中', async () => {
    // 长度下限 4 个字母的护栏：否则短串会在无关单词里命中
    const notes = properNounProblems('高通', 'O chip é da Qualcomm.', policy.properNouns)
    check('Qualcomm 是认可写法 → 不判新造', notes.some(n => n.kind === '专名新造') === false,
      JSON.stringify(notes))
  })

  // ── ② 实体槽 ───────────────────────────────────────────────────────────────

  await it('② 实体槽：楼层丢了必须报（实测 Qwen2.5 的真错）', async () => {
    const source = '地点从十二楼的第二会议室换到了八楼的 802 房间。'
    const bad = lint(source, 'O local foi mudado para o quarto 802 no oitavo andar.')
    check('12 楼不见了 → 判楼层丢失', bad.fatal.some(note => note.kind === '楼层丢失'),
      JSON.stringify(bad.fatal))
  })

  await it('② 实体槽：楼层都在就不许报（各种写法都算）', async () => {
    const source = '地点从十二楼的第二会议室换到了八楼的 802 房间。'
    const variants = [
      'O local mudou da segunda sala de reuniões no 12º andar para a sala 802 no 8º andar.',
      'O local mudou da segunda sala de reuniões no décimo segundo andar para a sala 802 no oitavo andar.',
    ]
    for (const translation of variants) {
      const judged = lint(source, translation)
      check('楼层齐全 → 不判丢失', judged.fatal.some(n => n.kind === '楼层丢失') === false,
        JSON.stringify(judged.fatal) + '｜' + translation)
    }
  })

  await it('② 实体槽：房间号丢了必须报', async () => {
    const source = '换到了八楼的 802 房间。'
    const bad = lint(source, 'Mudou para o oitavo andar.')
    check('802 不见了 → 判房间号丢失', bad.fatal.some(note => note.kind === '房间号丢失'),
      JSON.stringify(bad.fatal))
  })

  await it('② 实体槽：没有楼层/房间号的句子不许报', async () => {
    const judged = lint('我们今天的会议改到了下午三点二十。', 'Nossa reunião de hoje mudou para as três e vinte da tarde.')
    check('无槽可丢 → 不报', judged.fatal.length === 0, JSON.stringify(judged.fatal))
    check('也不报警告', judged.warn.length === 0, JSON.stringify(judged.warn))
  })

  // ── ③ 性数一致 ─────────────────────────────────────────────────────────────

  await it('③ 性数一致：`do segundo sala` 必须报（实测 Hunyuan-MT 的真错）', async () => {
    const bad = agreementProblems('A reunião foi alterada do segundo sala de reuniões.', policy.nounGenders)
    check('序数词与冠词性不一致 → 报', bad.some(note => note.kind === '性数不一致'),
      JSON.stringify(bad))
  })

  await it('③ 性数一致：`da segunda sala` 与 `do segundo andar` 都不许报', async () => {
    const good = [
      'A reunião foi alterada da segunda sala de reuniões.',
      'A reunião foi alterada do segundo andar.',
      'Mudou para a sala 802 no oitavo andar.',
      'A gente vai para o escritório novo.',
      'Ela comprou uma passagem nova.',
    ]
    for (const translation of good) {
      const notes = agreementProblems(translation, policy.nounGenders)
      check(`正确性数 → 不报（${translation.slice(0, 34)}…）`, notes.length === 0, JSON.stringify(notes))
    }
  })

  await it('③ 性数一致：`para o sala` 也要报（`o` 是明确阳性冠词，不是歧义的 `a`）', async () => {
    // ⚠️ 实测漏报过这一处：一开始连 `o` 都没收进词形表（怕它像 `a` 一样歧义），
    //    于是 `para o sala 802` 放过了。但 `o` 只可能是阳性冠词，没有歧义。
    //    而 `a` 是真的歧义（既是阴性冠词又是介词），所以**只**排除 `a`。
    const bad = agreementProblems('O local foi mudado para o sala 802.', policy.nounGenders)
    check('o sala → 报', bad.some(note => note.kind === '性数不一致'), JSON.stringify(bad))
    const fine = agreementProblems('Ele foi para a sala 802 e depois a gente saiu.', policy.nounGenders)
    check('a sala / a gente 里的 a → 不报', fine.length === 0, JSON.stringify(fine))
  })

  await it('③ 性数一致：大范围重评真实译文，只报真错、不报正常葡语', async () => {
    // ⚠️ 这一条是"误报护栏"，也是本轮最有价值的一条：
    //    判据收紧（把 `o/os/as` 收进词形表）之后，拿**四个模型的全部真实译文**重评一遍。
    //    收紧会让召回上去，但也最容易冒出误报 —— 而误报会让好模型排名垫底。
    //    这里把"正常葡语一个都不许报"钉死。
    const source = '我们和亮亮视野合作开发的这款 Leion Pro 用的是高通的芯片，系统版本是安卓十二。'
    const legit = [
      'A gente desenvolveu esse Leion Pro em parceria com a LLVision, ele usa chip da Qualcomm, e a versão do sistema é Android 12.',
      'O local mudou da segunda sala de reuniões no 12º andar para a sala 802 no 8º andar.',
      'A reunião de hoje foi adiada para as 15h20, e o local foi alterado do segundo auditório no 12º andar para a sala 802 no 8º andar.',
      'No refrigerador há suco e sorvete. O café da manhã começa às sete e meia, e a equipe se reunirá às oito horas para partir.',
      'Ele é uma pessoa que fala duro, mas tem um coração mole. Não se deixe enganar pela forma como fala.',
      'Isso é fácil de dizer, mas difícil de fazer. Só podemos tentar e ver o que acontece com um pequeno projeto piloto.',
      'O preço de cada unidade desses equipamentos é de 3980 reais. Se a compra for de cinquenta unidades ou mais de uma vez, é possível obter um desconto de 10%.',
      'Encapsulamos o SDK em um plugin. Para chamar, basta passar dois parâmetros: um é o text e o outro é o idioma de destino.',
    ]
    for (const translation of legit) {
      const notes = agreementProblems(translation, policy.nounGenders)
      check(`正常葡语不报（${translation.slice(0, 30)}…）`, notes.length === 0, JSON.stringify(notes))
    }
    // 而真错的必须报
    const wrong = agreementProblems(
      'A reunião foi alterada do segundo sala de reuniões para o sala 802.', policy.nounGenders)
    check('do segundo sala → 报', wrong.length > 0, JSON.stringify(wrong))
  })

  await it('③ 性数一致：词表里查不到的名词一律放过（宁可不报）', async () => {
    // 「xyzabc」不在词表里 —— 不许因为不认识就瞎判
    const notes = agreementProblems('Ele falou do xyzabc ontem.', policy.nounGenders)
    check('词表查不到 → 不报', notes.length === 0, JSON.stringify(notes))
    const half = agreementProblems('Ela viu uma xyzabc.', policy.nounGenders)
    check('阴性冠词 + 不认识的词 → 不报', half.length === 0, JSON.stringify(half))
  })

  await it('③ 性数一致：名词性对得上就不报（阴性配阴性、阳性配阳性）', async () => {
    const notes = agreementProblems('Ela foi na recepção e falou com um usuário.', policy.nounGenders)
    check('recepção(f) 配 na、usuário(m) 配 um → 不报', notes.length === 0, JSON.stringify(notes))
  })

  // ── 汇总层 ─────────────────────────────────────────────────────────────────

  await it('lint 汇总：三层一起跑，正确译文一条都不报', async () => {
    const good = [
      ['我们和亮亮视野合作开发的这款 Leion Pro，用的是高通的芯片，系统版本是安卓十二。',
        'Desenvolvemos este Leion Pro em parceria com a LLVision, usa chip da Qualcomm, e a versão do sistema é Android 12.'],
      ['地点从十二楼的第二会议室换到了八楼的 802 房间。',
        'O local mudou da segunda sala de reuniões no 12º andar para a sala 802 no 8º andar.'],
      ['去年我们的营收是 2.7 亿，今年上半年的增长是 18.6%。',
        'No ano passado nosso faturamento foi de 270 milhões, e no primeiro semestre deste ano o crescimento foi de 18,6%.'],
      ['从酒店出来，你可以坐公交车或者地铁，车票在手机应用上买就行。',
        'Saindo do hotel, você pode pegar ônibus ou metrô, e comprar a passagem pelo aplicativo do celular.'],
    ]
    for (const [source, translation] of good) {
      const judged = lint(source, translation)
      check(`正确译文不报事故（${source.slice(0, 14)}…）`, judged.fatal.length === 0,
        JSON.stringify(judged.fatal))
    }
  })

  await it('lint 汇总：真错要报，而且报的是"哪一层"（可追溯）', async () => {
    const judged = lint('地点从十二楼的第二会议室换到了八楼的 802 房间。',
      'O local foi mudado para o quarto 802 no oitavo andar.')
    check('报了楼层丢失', judged.fatal.some(note => note.kind === '楼层丢失'), JSON.stringify(judged.fatal))
    for (const note of judged.fatal) {
      check('每条都写了 kind 与解释', typeof note.kind === 'string' && note.text.length > 10,
        JSON.stringify(note))
    }
  })

  await it('lint 不碰"词义错"这类需要人判断的（明确不做）', async () => {
    // `legendário`（传奇的）应为 `legendas`（字幕）—— 这是词义错，规则写不完。
    // 判据**刻意不报**它；这类只能靠回译出"待审清单"，绝不自动判事故。
    const judged = lint('用户仍然觉得字幕跟得上对话的节奏。',
      'o usuário ainda sente que o legendário acompanha o ritmo da conversa.')
    check('词义错不自动判（这是刻意的边界）', judged.fatal.length === 0, JSON.stringify(judged.fatal))
  })
}
