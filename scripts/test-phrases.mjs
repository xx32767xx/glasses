/**
 * test-phrases.mjs —— 同传效果的测试句集 + 一键跑批
 * ============================================================================
 *
 *   node scripts/test-phrases.mjs --list          # 只把句子打出来（照着念）
 *   node scripts/test-phrases.mjs                 # 全部跑一遍（走「手输一句话」通道）
 *   node scripts/test-phrases.mjs --only 7        # 只跑第 7 条
 *   node scripts/test-phrases.mjs --read-aloud    # 打印朗读提示
 *
 * 为什么要有这个：同传的"效果"很容易凭感觉评价，而感觉会漏掉几类**看不见**的错：
 *
 *   · **数字被译错或漏掉** —— 同传里最严重的一类错（时间、金额、房间号）
 *   · **用了葡葡说法**（autocarro / telemóvel / tu）—— 用户要的是巴葡，这是硬约束
 *   · **眼镜上开头被截掉** —— 显示预算只有 40 列 × 3 行，超出的部分是**从开头**丢的，
 *     手机上的预览面板看不出这一点（它就是按 3 行渲染的）
 *   · **繁体字 / 提示词回显 / 幻听惯用语** —— 这几类是已知会漏出来的假字幕
 *
 * 所以这个脚本把上面四项**逐条判一遍**并给出结论，而不是只把译文打出来让人看。
 *
 * 两种测法（对应两类问题）：
 *   · 走「手输一句话」通道（本脚本缺省）：**绕过语音识别**，只测翻译 + 显示 + 口径
 *   · 自己朗读：测的才是整条链（切句 → 识别 → 翻译 → 显示）
 *     朗读时**故意在逗号处停 0.6~1 秒**，就能看出静音判定会不会把一句话切碎。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = decodeURIComponent(pathToFileURL(join(process.cwd(), '.')).pathname).replace(/^\//, '')

/**
 * 测试句集。每条都写清"它测的是什么"——不然跑完也不知道该看哪里。
 * 全部是**中文的长难句**：短句测不出问题（切句、显示预算、从句结构都要长句才压得出来）。
 */
export const PHRASES = [
  { group: 'A 长句 / 多重从句（压切句）',
    text: '我们这款眼镜的核心思路是把翻译结果直接放在佩戴者的视野里，这样对方说话的时候你不需要低头看手机，也不用打断对话。',
    why: '逗号多、有自然停顿 → 看会不会被切成好几段、每段译文是否还算完整' },
  { group: 'A 长句 / 多重从句（压切句）',
    text: '如果对方的语速比较快，或者会议室里有好几个人同时在说话，那么第一版的识别准确率会明显下降，这也是我们下一步要解决的问题。',
    why: '从句套从句 → 看译文有没有把两个条件都翻出来（漏掉"或者"那一支很常见）' },

  { group: 'B 数字 / 时间 / 金额（必须原样）',
    text: '我们今天的会议改到了下午三点二十，地点从十二楼的第二会议室换到了八楼的 802 房间。',
    why: '时间 + 楼层 + 房间号三个数字都要在译文里找到' },
  { group: 'B 数字 / 时间 / 金额（必须原样）',
    text: '这批设备的报价是每台 3980 元，如果一次采购五十台以上，可以按九折结算，也就是每台 3582 元。',
    why: '数字 + 折扣逻辑 → 看数字有没有被"换算"或漏掉' },
  { group: 'B 数字 / 时间 / 金额（必须原样）',
    text: '去年我们的营收是 2.7 亿，今年上半年的增长是 18.6%，其中海外市场贡献了差不多三分之一。',
    why: '小数、百分数、分数 → 三类数字写法都容易出现偏差' },

  { group: 'C 专有名词（不翻译）',
    text: '我们和亮亮视野合作开发的这款 Leion Pro，用的是高通的芯片，系统版本是安卓十二。',
    why: '公司名/产品名要保持原文，安卓十二要译成 Android 12 而不是"十二"' },

  { group: 'D 巴葡 vs 葡葡（术语表陷阱）',
    text: '从酒店出来，你可以坐公交车或者地铁，在第三个站下车，然后换乘火车，车票在手机应用上买就行。',
    why: '一句话踩五个术语：公交车/地铁/火车/车票/手机 —— 出现 autocarro、metro、comboio、bilhete、telemóvel 就是葡葡' },
  { group: 'D 巴葡 vs 葡葡（术语表陷阱）',
    text: '冰箱里有果汁和冰淇淋，早餐是七点半开始，团队会在八点集合出发。',
    why: '冰箱/果汁/冰淇淋/早餐/团队 —— 对应 geladeira/suco/sorvete/café da manhã/time' },
  { group: 'D 巴葡 vs 葡葡（术语表陷阱）',
    text: '你如果需要借充电器，可以问前台，我们的计划是明天上午先参观工厂，下午再谈合同。',
    why: '人称要用 você 而不是 tu；"计划（动词）"要用 planejar 而不是 planear' },

  { group: 'E 口语 / 成语（不能直译）',
    text: '这件事说起来容易做起来难，我们只能摸着石头过河，先做一个小范围试点看看效果。',
    why: '两句成语 → 看是硬直译还是意译；硬直译对方听不懂' },
  { group: 'E 口语 / 成语（不能直译）',
    text: '他这个人刀子嘴豆腐心，你别看他说话冲，其实特别愿意帮忙。',
    why: '"刀子嘴豆腐心"是最难直译的一类；看有没有翻成人话' },
  { group: 'E 口语 / 成语（不能直译）',
    text: '这次是背水一战，成了就一飞冲天，不成的话，恐怕连老本都要赔进去。',
    why: '三个成语连用 → 容易出现逐字硬译' },

  { group: 'F 听错风险（同音 / 短片段）',
    text: '这条测试语音是为了验证整条链路，从麦克风采集到字幕显示，每一步都要记录耗时。',
    why: '「测试语音」这四个字曾被识别成「你以後」——朗读这条最能复现' },
  { group: 'F 听错风险（同音 / 短片段）',
    text: '请在设置里把语言切换成简体中文，然后重新开始录音。',
    why: '这句和提示词内容接近 → 看会不会被回显过滤误杀（该出的字幕没出）' },

  { group: 'G 否定与条件（逻辑不能翻反）',
    text: '除非对方明确同意，否则我们不应该把这份数据交给第三方，哪怕只是做演示也不行。',
    why: '双重否定 + 让步 → 翻反了是最危险的错' },
  { group: 'G 否定与条件（逻辑不能翻反）',
    text: '并不是说这个方案不能用，而是说在当前预算下，它的性价比不如另一个方案。',
    why: '"不是…而是…"结构，翻反了就变成否掉了整个方案' },

  { group: 'H 极长句（触发 15 秒强制断句）',
    text: '我们的目标是在明年第一季度之前把这套同传系统的延迟压到两秒以内，同时把中文识别的字错率控制在百分之五以下，并且让佩戴者连续使用两小时之后仍然觉得字幕跟得上对话的节奏，因为如果一句话要等三四秒才出现，那用户就会干脆不用了。',
    why: '一口气念完（中间少停）→ 会撞上 15 秒上限；看断句点是否落在停顿上、而不是说到一半被切断' },

  { group: 'I 中英混说（术语与产品名）',
    text: '我们把 SDK 封装成了一个插件，调用的时候只需要传两个参数，一个是 text，另一个是目标语言。',
    why: '中英混说 → 看英文词是否保留、有没有被音译成奇怪的东西' },
]

// ── 判定用的素材 ────────────────────────────────────────────────────────────

/** 只在繁体里出现的常用字（不是完备对照表，够抓"整句输出成繁体"这种情况）。 */
const TRADITIONAL = new Set('這說麼為個們來時會對開過實現學國產與東車門見長問間題讓從應該裡樣還進發經頭幾語聽讀寫電話點認識覺辦體條壓無萬業員實際處理總機關於當後馬鳥魚龍風飛隻億據處臟選擇觀運動圖書館總結經驗營運營養')

const ECHO = ['请用简体中文输出', '以下是普通话的句子']
const HALLUCINATION = ['请不吝点赞', '订阅', '转发', '打赏', '谢谢观看', 'amara.org', 'legendas', 'subtitles by']

/** 与插件 fitSubtitle 同一套规则：汉字算 2 列，超出就折行。 */
export function wrap(text, cols) {
  const out = []
  let line = ''
  let width = 0
  for (const ch of String(text)) {
    const w = ch.codePointAt(0) < 0x2e80 ? 1 : 2
    if (width + w > cols) {
      out.push(line)
      line = ''
      width = 0
    }
    line += ch
    width += w
  }
  out.push(line)
  return out
}

/**
 * 词边界匹配。
 *
 * ⚠️ 第一版这里用的是 `includes()`，结果满屏误报：葡葡词 `tu` 命中了
 * 「fa**tu**ramento」「**tu**do」「a**tu**al」，`metro` 命中了「parâ**metro**s」，
 * `equipa` 命中了「**equipa**mentos」。用子串判词，等于没判。
 * 这里的边界规则：前后紧邻的字符不能是字母（带重音的也算字母）。
 */
export function containsWord(haystack, needle) {
  const text = String(haystack).toLowerCase()
  const word = String(needle).toLowerCase()
  if (word === '') return false
  const isLetter = ch => ch !== undefined && /\p{L}/u.test(ch)
  let from = 0
  for (;;) {
    const at = text.indexOf(word, from)
    if (at < 0) return false
    const before = at === 0 ? undefined : text[at - 1]
    const after = text[at + word.length]
    if (!isLetter(before) && !isLetter(after)) return true
    from = at + 1
  }
}

/** 只留数字：把千分位/小数点都去掉再比，免得 "3980" 与 "3.980" 被当成不一致。 */
export function digitsOf(text) {
  return (String(text).match(/\d+(?:[.,]\d+)*/g) ?? [])
    .map(value => value.replace(/[.,]/g, ''))
    .join('|')
}

/** 逐条判定，返回一组可打印的结论（纯函数，便于测试）。 */
export function inspect(source, translation, options) {
  const cols = options.cols ?? 40
  const lineBudget = options.lineBudget ?? 3
  const notes = []

  // ① 数字
  const wanted = String(source).match(/\d+(?:[.,]\d+)*/g) ?? []
  const normalized = digitsOf(translation)
  const missing = wanted.filter(value => !normalized.includes(value.replace(/[.,]/g, '')))
  if (wanted.length > 0) {
    notes.push(missing.length === 0
      ? { level: 'ok', text: `数字都保留了（${wanted.join('、')}）` }
      : { level: 'bad', text: `数字可能丢了：${missing.join('、')}（也可能是被换算成了别的写法，比如 2.7 亿 → 270 milhões）` })
  }

  // ② 葡葡说法：译文中出现了葡葡词就提醒（并给出应该用的巴葡词）
  const ptBr = options.terminology ?? []
  const european = ptBr.filter(entry => entry.ptpt && containsWord(translation, entry.ptpt))
  if (european.length > 0) {
    notes.push({ level: 'bad', text: '出现葡葡说法：'
      + european.map(e => `${e.ptpt}（巴葡应为 ${e.br}）`).join('、') })
  } else if (ptBr.length > 0) {
    const brazilian = ptBr.filter(entry => entry.br && containsWord(translation, entry.br))
    if (brazilian.length > 0) {
      notes.push({ level: 'ok', text: '巴葡用词：' + brazilian.map(e => e.br).join('、') })
    }
  }

  // ③ 显示预算：超 3 行的话，眼镜上被丢掉的是**开头**
  const wrapped = wrap(translation, cols)
  const shown = wrapped.length > lineBudget ? wrapped.slice(wrapped.length - lineBudget) : wrapped
  if (wrapped.length > lineBudget) {
    notes.push({ level: 'bad', text: `译文折行 ${wrapped.length} 行 > ${lineBudget} 行预算`
      + ` —— 眼镜上会丢掉开头 ${wrapped.length - lineBudget} 行` })
  }

  // ④ 假字幕与字形
  if (ECHO.some(sample => String(translation).includes(sample))) {
    notes.push({ level: 'bad', text: '提示词被回显成了字幕' })
  }
  if (HALLUCINATION.some(sample => String(translation).toLowerCase().includes(sample))) {
    notes.push({ level: 'bad', text: '命中幻听惯用语' })
  }
  const traditional = [...String(translation)].filter(ch => TRADITIONAL.has(ch))
  if (traditional.length > 0 && options.sourceIsChinese) {
    notes.push({ level: 'warn', text: `译文里出现疑似繁体字：${traditional.join('')}（译成葡语时不该有中文，这里多半是回显了原文）` })
  }

  return { wrapped, shown, notes }
}

// ── 跑批 ────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const options = { url: 'http://127.0.0.1:8788', timeout: 12000, settle: 2500,
    only: null, list: false, readAloud: false, secret: null }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--list') { options.list = true; continue }
    if (token === '--read-aloud') { options.readAloud = true; continue }
    if (token === '--url') { options.url = argv[++index]; continue }
    if (token === '--secret') { options.secret = argv[++index]; continue }
    if (token === '--only') { options.only = Number(argv[++index]); continue }
    if (token === '--timeout') { options.timeout = Number(argv[++index]); continue }
    if (token === '--settle') { options.settle = Number(argv[++index]); continue }
    throw new Error(`看不懂的参数：${token}`)
  }
  return options
}

/** 当前帧（不看 changed，直接要 service 手里的那一帧）。 */
async function currentFrame(url, secret) {
  const response = await fetch(`${url}/frame?since=0&secret=${encodeURIComponent(secret)}`,
    { signal: AbortSignal.timeout(5000) })
  if (!response.ok) return null
  const body = await response.json()
  return body.frame ?? null
}

function readSecret() {
  try {
    return readFileSync(join(process.cwd(), 'var', 'live', 'relay-secret.txt'), 'utf8').trim()
  } catch {
    return ''
  }
}

async function submit(url, secret, text) {
  const response = await fetch(`${url}/say?secret=${encodeURIComponent(secret)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, from: 'zh-CN' }),
  })
  if (!response.ok) throw new Error(`POST /say 失败：HTTP ${response.status}`)
  return response.json()
}

/**
 * 等到这一句"尘埃落定"，返回它最终的帧。
 *
 * 为什么要等：开了大模型校对时，屏幕上会先出现初译（定稿帧），
 * 过一会儿**再被改一次**。只看"第一帧定稿"就停下来，量到的永远是初译 ——
 * 那样"校对有没有用"就永远测不出来。
 *
 * 怎么知道后面那一帧还是这一句：本脚本是**一句一句串着发的**，
 * 所以等待期间出现的任何新帧都只可能属于当前这句（下一句还没发）。
 */
async function waitForSettledFrame(url, secret, source, timeout, settleMs) {
  const deadline = Date.now() + timeout
  let draft = null
  while (Date.now() < deadline) {
    const frame = await currentFrame(url, secret).catch(() => null)
    if (frame !== null && (frame.source === source || frame.text === source)
        && frame.partial === false) {
      draft = frame
      break
    }
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  if (draft === null) return null

  // 初译到了之后再盯一会儿，看有没有"第二遍"把它改掉
  const settleUntil = Date.now() + settleMs
  let latest = draft
  while (Date.now() < settleUntil) {
    await new Promise(resolve => setTimeout(resolve, 200))
    const frame = await currentFrame(url, secret).catch(() => null)
    if (frame !== null && frame.partial === false && frame.text !== latest.text) {
      latest = frame
    }
  }
  return { draft, settled: latest, revised: latest.text !== draft.text }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))

  if (options.list || options.readAloud) {
    let group = ''
    PHRASES.forEach((phrase, index) => {
      if (phrase.group !== group) {
        group = phrase.group
        console.log('')
        console.log('── ' + group + ' ──')
      }
      console.log(`[${index + 1}] ${phrase.text}`)
      if (options.readAloud) console.log(`      ↳ 测什么：${phrase.why}`)
    })
    if (options.readAloud) {
      console.log('')
      console.log('朗读提示：')
      console.log('  · 每句**一口气念完**，只在逗号处停 0.6~1 秒 —— 这才压得出静音判定的问题')
      console.log('  · 第 16 条（极长句）请**尽量少停**，它专门用来撞 15 秒强制断句')
      console.log('  · 念完一句停 2 秒，给屏幕上字幕的时间；再念下一句')
    }
    console.log('')
    return
  }

  const secret = options.secret !== null && options.secret !== '' ? options.secret : readSecret()
  if (secret === '') {
    console.log('读不到 var/live/relay-secret.txt —— 转发进程还没起来过？（也可以用 --secret 直接给）')
    return
  }
  const policy = JSON.parse(readFileSync(join(process.cwd(), 'policy', 'br-pt.json'), 'utf8'))
  const terminology = policy.terminology ?? []

  console.log('')
  console.log(`测试句集：${PHRASES.length} 条，走「手输一句话」通道（绕过语音识别，只测翻译/口径/显示）`)
  console.log(`转发进程：${options.url}`)
  console.log('注意：这条通道**不经过麦克风与识别**。要测整条链，请用 --read-aloud 打印句子自己念。')
  console.log('')

  let bad = 0
  let warn = 0
  let revised = 0
  let group = ''
  for (let index = 0; index < PHRASES.length; index += 1) {
    const phrase = PHRASES[index]
    if (options.only !== null && options.only !== index + 1) continue
    if (phrase.group !== group) {
      group = phrase.group
      console.log('')
      console.log('── ' + group + ' ──')
    }
    const started = Date.now()
    let outcome = null
    try {
      await submit(options.url, secret, phrase.text)
      outcome = await waitForSettledFrame(options.url, secret, phrase.text,
        options.timeout, options.settle)
    } catch (error) {
      console.log(`[${index + 1}] ✗ 提交失败：${String(error && error.message ? error.message : error)}`)
      bad += 1
      continue
    }
    const elapsed = Date.now() - started
    if (outcome === null) {
      console.log(`[${index + 1}] ✗ ${options.timeout}ms 内没等到字幕（这句话没有产出结果）`)
      console.log(`     为什么测：${phrase.why}`)
      bad += 1
      continue
    }

    const frame = outcome.settled
    const result = inspect(phrase.text, frame.text, {
      cols: frame.cols ?? 40,
      lineBudget: frame.lineBudget ?? 3,
      terminology,
    })
    const marks = result.notes.filter(n => n.level === 'bad')
    const warns = result.notes.filter(n => n.level === 'warn')
    bad += marks.length > 0 ? 1 : 0
    warn += warns.length > 0 && marks.length === 0 ? 1 : 0
    if (outcome.revised) revised += 1

    console.log(`[${index + 1}] ${frame.lang ?? ''}  ${elapsed}ms${outcome.revised ? '  ✎ 被改过一次' : ''}`)
    console.log(`     原文：${phrase.text}`)
    if (outcome.revised) console.log(`     初译：${outcome.draft.text}`)
    console.log(`     ${outcome.revised ? '校对' : '译文'}：${frame.text}`)
    console.log(`     眼镜上（${frame.cols ?? 40}×${frame.lineBudget ?? 3}）：`)
    result.shown.forEach(line => console.log(`        |${line}`))
    result.notes.forEach(note => {
      const mark = note.level === 'ok' ? '✅' : note.level === 'warn' ? '⚠️ ' : '❌'
      console.log(`     ${mark} ${note.text}`)
    })
    console.log(`     为什么测：${phrase.why}`)
    console.log('')
  }

  console.log('─'.repeat(72))
  console.log(`小结：有问题的 ${bad} 条，有提醒的 ${warn} 条，共 ${PHRASES.length} 条`)
  console.log(`其中被第二遍改过的：${revised} 条（开没开校对，这个数一看就知道）`)
  console.log('判据说明：')
  console.log('  ❌ = 数字可能丢了 / 出现葡葡说法 / 译文超过 3 行（眼镜上开头被截）/ 假字幕')
  console.log('  ⚠️  = 需要人判断的（例如口吻、成语意译是否到位）')
  console.log('  数字与折行是**脚本判的**；译得好不好、对方听不听得懂，还得你自己看。')
  console.log('─'.repeat(72))
  console.log('')
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('test-phrases 出错：' + String(error && error.message ? error.message : error))
    process.exitCode = 1
  })
}
