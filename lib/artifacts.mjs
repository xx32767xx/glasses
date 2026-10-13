/**
 * artifacts.mjs —— 产物生成（纯函数形式，供 CLI 与测试共用）
 * ============================================================================
 * 从两个"唯一来源"派生全部生成物：
 *
 *   plugin/core.mjs        业务逻辑  →  plugin/schemas.generated.mjs（预编译 schema）
 *                                   →  dynamic/leion-pro.host.js（内联 core + 沙箱适配器）
 *   policy/br-pt.json      巴葡策略  →  plugin/policy.generated.mjs（正式包 import 它）
 *                                   →  dynamic/…（内联成常量）
 *                                   →  skills/leion-interpreter/SKILL.md（生成术语表那一节）
 *
 * 为什么编译 schema：正式插件走 ctx.tools.register() 需要**原始** JSON Schema，而
 * author-facing 的 DSL 不给它；派生而不是手抄，所以两个包装目标不可能漂移。
 *
 * 为什么策略也要派生：巴葡口径（"不是葡葡"）是本项目最大的质量资产。以前它在插件里是
 * 5 句原则、在技能文档里是一张术语表 —— 两处会漂移，而且技能文档那张表还写坏过两行。
 * 现在术语表、口语特征、字幕纪律全部从 policy/br-pt.json 生成。
 *
 * CLI 包装见 scripts/generate.mjs；新鲜度门禁由 tests/run-all.mjs 调用本模块完成
 * （刻意不 spawn 子进程：受限沙箱下捕获子进程管道输出会 EPERM）。
 */

import { readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { defineTool } from './real-tools.mjs'
// 句集是**唯一真相**：文档由它生成，跑批也直接引用它 —— 两边不会各说各话
import { PHRASES } from '../scripts/test-phrases.mjs'
import { SAMPLE_ZH, SAMPLE_PT } from './display-samples.mjs'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CORE = join(ROOT, 'plugin', 'core.mjs')
const POLICY_JSON = join(ROOT, 'policy', 'br-pt.json')
const SKILL = join(ROOT, 'skills', 'leion-interpreter', 'SKILL.md')

/** SKILL.md 里那段由策略数据生成的内容，用成对标记 delimiting。 */
export const POLICY_MARKER_BEGIN = '<!-- BEGIN GENERATED br-pt-policy'
export const POLICY_MARKER_END = '<!-- END GENERATED br-pt-policy -->'

/** 去掉顶层 `export ` 前缀，让模块源码能作为一段函数体存在。 */
function inlineModule(source, file) {
  const lines = source.split('\n')
  const unsupported = lines.filter(l => /^export\s+(default|\{|function\s*\*|class)/.test(l))
  if (unsupported.length > 0) {
    throw new Error(
      `${file} 里出现了生成器不支持的导出形式，无法内联到动态插件：\n  ${unsupported.join('\n  ')}\n`
      + '请只使用 `export const` / `export function` 两种形式。',
    )
  }
  return lines.map(l => l.replace(/^export /, '')).join('\n')
}

/** 读出巴葡策略（唯一来源）。 */
export function readPolicy() {
  return JSON.parse(readFileSync(POLICY_JSON, 'utf-8'))
}

/** 把策略渲染成 SKILL.md 里那一节 Markdown。 */
function renderPolicySection(policy) {
  return [
    `用户要的是 **${policy.variety.name}（${policy.variety.code}）**，不是葡萄牙本土葡语。`
    + `这是评分点，不是风格偏好。以下是必须遵守的差异：`,
    '',
    '| 中文 | 巴葡 ✅ | 葡葡 ❌ |',
    '|---|---|---|',
    ...policy.terminology.map(entry => `| ${entry.zh} | ${entry.br} | ${entry.ptpt} |`),
    '',
    '巴葡口语特征：',
    ...policy.speakingFeatures.map(feature => '- ' + feature),
    '',
    '## 字幕长度纪律（AR 显示区只有 40 列 × 3 行）',
    '',
    ...policy.subtitleDiscipline.map(item => '- ' + item),
  ].join('\n')
}

/** 只替换标记之间的内容，两侧的手写散文原样保留。 */
export function applyPolicySection(existing, policy) {
  const begin = existing.indexOf(POLICY_MARKER_BEGIN)
  const end = existing.indexOf(POLICY_MARKER_END)
  if (begin < 0 || end < 0 || end < begin) {
    throw new Error(`在 SKILL.md 里找不到策略生成区标记：\n  ${POLICY_MARKER_BEGIN} …\n  ${POLICY_MARKER_END}\n`
      + '这两个标记必须成对出现，否则生成器拒绝改写（宁可报错也不猜）。')
  }
  // 保留 BEGIN **整行**（含结尾的 ` -->`）—— 只保留标记前缀会把 HTML 注释尾巴切掉，
  // 于是整节在 Markdown 里变成一段没闭合的注释。
  const beginLineEnd = existing.indexOf('\n', begin)
  if (beginLineEnd < 0) throw new Error('BEGIN 标记那一行没有换行，文件可能被破坏')
  const head = existing.slice(0, beginLineEnd)
  const tail = existing.slice(end)
  return head + '\n' + renderPolicySection(policy) + '\n' + tail
}

/**
 * 构建全部产物的内容。
 * @returns [{ path, label, content }]
 */
export async function buildArtifacts() {
  const core = await import(pathToFileURL(CORE).href)
  const policy = readPolicy()

  // 用一个没有服务的假 ctx 建解释器：构建工具规格不碰 ctx，只有 execute 才会。
  const rt = core.createInterpreter({ get: () => undefined }, core.CONFIG_DEFAULTS, { policy })
  const specs = core.buildToolSpecs(rt)

  const compiled = {}
  for (const spec of specs) {
    // 走真实 defineTool：schema 不合法就在这里炸，而不是等到创造模式会话里才炸。
    const tool = defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: { schema: spec.outputSchemaDsl, render: spec.render },
      async execute() { return {} },
    })
    compiled[spec.name] = {
      description: tool.description,
      parameters: tool.parameters,
      outputSchema: tool.output.schema,
    }
  }

  const policyLiteral = JSON.stringify(policy, null, 2)

  const schemasSource = `/**
 * 自动生成 —— 请勿手改。
 * ============================================================================
 * 来源：plugin/core.mjs 里的 author-facing value schema DSL，
 *       经检出里真实的 @deepseek-ai/dsh-tools defineTool 编译后的原始形式。
 * 用途：正式插件（plugin/index.mjs）走 ctx.tools.register() 时需要的原始 JSON Schema。
 * 重新生成：node scripts/generate.mjs
 * 新鲜度门禁：tests/run-all.mjs
 */

export const TOOL_SCHEMAS = ${JSON.stringify(compiled, null, 2)}
`

  const policySource = `/**
 * 自动生成 —— 请勿手改。
 * ============================================================================
 * 来源：policy/br-pt.json（巴葡策略的唯一来源）。
 * 用途：正式插件（plugin/index.mjs）把它作为 deps.policy 传给 createInterpreter，
 *       由 translationSystem() 生成提示词。
 * 重新生成：node scripts/generate.mjs
 * 新鲜度门禁：tests/run-all.mjs
 */

export const POLICY = ${policyLiteral}
`

  const coreInlined = inlineModule(readFileSync(CORE, 'utf-8'), relative(ROOT, CORE))

  const dynamicSource = `/**
 * leion-pro —— 亮亮视野 (LLVision) Leion Pro / GLXSS ME AR 眼镜 · Cordis 动态插件 Host 半
 * ⚠️ 本文件由 scripts/generate.mjs 从 plugin/core.mjs 与 policy/br-pt.json 生成，
 *    **请勿手改**。改逻辑 → plugin/core.mjs；改巴葡口径 → policy/br-pt.json；
 *    然后 node scripts/generate.mjs
 * ============================================================================
 *
 * 这是什么
 *   把「一台亮亮眼镜」做成 harness 认识的一个设备：注册一组模型工具，让 agent 可以把
 *   字幕推到眼镜上；并内置中↔巴西葡语双向翻译管线，让这套东西成为一个同传 app。
 *
 * 怎么用
 *   在 Web GUI 新建一个「创造模式」会话，把本文件的全部内容作为 \`code.host\` 传给
 *   cordis_define，再 cordis_run。详见 docs/02-创造模式加载指南.md。
 *
 * 沙箱约束（动态插件，不是普通源码插件）
 *   - 代码是 async 函数体，必须 \`return\` 一个插件对象；
 *   - 纯 JavaScript，不能写 TypeScript 类型标注；
 *   - 没有 require / fetch / setTimeout / process / Buffer；
 *   - 可用全局只有：ctx（受限）、harness、console、btoa/atob/TextEncoder/TextDecoder；
 *   - 外部能力一律走 Cordis 服务：ctx.get('llm') / ctx.get('fs') ...
 *
 * 下面是 policy/br-pt.json 的内联内容（巴葡策略唯一来源）
 * ============================================================================
 */

const POLICY = ${policyLiteral}

// ============================================================================
// 下面是 plugin/core.mjs 的内联内容（业务逻辑唯一来源）
// ============================================================================

${coreInlined}

// ─────────────────────────────────────────────────────────────────────────────
// 动态插件沙箱适配器（由 scripts/generate.mjs 生成）
// ─────────────────────────────────────────────────────────────────────────────

// 动态包没有 config 通道：要改配置就改上面的 CONFIG_DEFAULTS，或改这里的覆盖对象，
// 然后重新 cordis_define。正式插件版本则通过 cordis.yml 的 config 传同样的字段。
const CONFIG_OVERRIDE = {}

return {
  name: 'leion-pro',
  inject: ['tools', 'timer'],

  apply(ctx) {
    const rt = createInterpreter(
      ctx,
      Object.assign({}, CONFIG_DEFAULTS, CONFIG_OVERRIDE),
      { policy: POLICY },
    )
    for (const spec of buildToolSpecs(rt)) {
      harness.registerTool(ctx, harness.defineTool({
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        output: { schema: spec.outputSchemaDsl, render: spec.render },
        execute: spec.execute,
      }))
    }
    console.log(loadedMessage(rt))
  },
}
`

  const skillSource = applyPolicySection(readFileSync(SKILL, 'utf-8'), policy)

  return [
    { path: join(ROOT, 'plugin', 'schemas.generated.mjs'), label: 'plugin/schemas.generated.mjs', content: schemasSource },
    { path: join(ROOT, 'plugin', 'policy.generated.mjs'), label: 'plugin/policy.generated.mjs', content: policySource },
    { path: join(ROOT, 'dynamic', 'leion-pro.host.js'), label: 'dynamic/leion-pro.host.js', content: dynamicSource },
    { path: join(ROOT, 'skills', 'leion-interpreter', 'SKILL.md'), label: 'skills/leion-interpreter/SKILL.md', content: skillSource },
    { path: join(ROOT, 'docs', '11-验证句集.md'), label: 'docs/11-验证句集.md', content: phrasesDocSource() },
    { path: join(ROOT, 'android', 'app', 'src', 'main', 'res', 'values', 'display_samples.xml'),
      label: 'android/.../res/values/display_samples.xml',
      content: displaySamplesXmlSource() },
  ]
}

/**
 * 把 `lib/display-samples.mjs` 里的校准句渲染成 Android 资源。
 *
 * <p><b>为什么生成而不是手写进 strings.xml</b>：这两组句子的价值在于**它们是真实的** ——
 * 中文来自项目自己的测试句集、葡语来自 relay 日志里真实的定稿帧。
 * 一旦手抄进资源文件，"它是真的"这层出处就丢了，而且以后改句集会与资源文件悄悄不一致。
 * 生成 + `--check` 门禁把这件事变成机械可查的。
 */
function displaySamplesXmlSource() {
  const escape = text => text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')

  const arrayOf = (name, items, pick) => {
    const out = [`    <string-array name="${name}">`]
    for (const item of items) out.push(`        <item>${escape(pick(item))}</item>`)
    out.push('    </string-array>')
    return out
  }

  const lines = []
  lines.push('<?xml version="1.0" encoding="utf-8"?>')
  lines.push('<!--')
  lines.push('  ⚠️ 本文件由 lib/artifacts.mjs 从 lib/display-samples.mjs 生成，**不要手改**。')
  lines.push('  改句子请改 lib/display-samples.mjs，然后 npm run generate。')
  lines.push('  不一致时 npm run check 会直接报错（和插件产物同一个门禁）。')
  lines.push('')
  lines.push('  用途：眼镜预览页的「投屏样例」——不开同传也能推一句话到眼镜上，用来校字号/留白/翻页。')
  lines.push('  中文样例来自 scripts/test-phrases.mjs 的测试句集；葡语样例来自 relay.log 里真实的定稿帧。')
  lines.push('  两组**互相独立、不是互译**（日志里没记源句，硬配对就是编数据）。')
  lines.push('-->')
  lines.push('<resources>')
  lines.push(...arrayOf('glasses_sample_zh_label', SAMPLE_ZH, item => item.label))
  lines.push(...arrayOf('glasses_sample_zh', SAMPLE_ZH, item => item.text))
  lines.push(...arrayOf('glasses_sample_pt_label', SAMPLE_PT, item => item.label))
  lines.push(...arrayOf('glasses_sample_pt', SAMPLE_PT, item => item.text))
  lines.push('</resources>')
  lines.push('')
  return lines.join('\n')
}

/**
 * 把 `scripts/test-phrases.mjs` 里的测试句集渲染成一份**文档**。
 *
 * <p><b>为什么是生成而不是手写</b>：句集已经被 `scripts/bench-models.mjs` 直接引用
 * （模型横评就是拿它跑的）。手抄一份到文档里，两边迟早不一致 ——
 * 而"照着文档念的句子"和"跑批用的句子"一旦不同，验证就失去意义了。
 * 所以文档由句集生成、并纳入 `generate.mjs --check` 的门禁：**改句集不改文档会直接报错**。
 *
 * <p>顺便给每句算**列宽**（汉字 2 列、其他 1 列，与眼镜排版同一个模型）。
 * 为什么要这个：眼镜上长句会**翻页**，而是否翻页取决于列宽而不是"几个字"。
 *
 * <p>⚠️ 但**判据必须按译文的宽度**，不能按中文输入 —— 中文很紧凑，
 * 葡语会明显变长。实测一例：
 * <pre>
 *   输入  北京航空航天大学是一所优质大学。                    30 列
 *   输出  A Universidade de Aeronáutica e Astronáutica de
 *         Pequim é uma universidade de alta qualidade.        88 列（2.9 倍）
 * </pre>
 * 所以下面按"输入列宽 × 展开系数"估译文宽度，再据此判断会翻几页。
 * 系数取 2.9（实测值），并**明确标成估算** —— 真实译文取决于模型。
 */
function phrasesDocSource() {
  const phrases = PHRASES
  /**
   * 中文 → 葡语的列宽展开系数。
   *
   * ⚠️ **离散度很大**，两次实测差了 2 倍多：
   *   北京航空航天大学是一所优质大学。   30 列 → 88 列（2.93 倍）
   *   关于这个问题，我们的做法是这样的   34 列 → 44 列（1.29 倍）
   * 所以取中间值 2.2 只作**粗略参考**，不能当判据用 ——
   * 真要确认会不会翻页，看实际译文（眼镜预览页的诊断行 / relay.log）。
   */
  const EXPANSION = 2.2
  /**
   * 一页能放约多少列（默认字号 40px、实测可用宽 563px 下）。
   *
   * <p><b>这些数是真机量出来的，不是推的</b>（用户点了「排版自检」，原样抄录）：
   * <pre>
   *   画布 640×400 · 可用宽 563px · 字号 40px
   *   中文：一行 14 个字符 · 行高 53px · 每页放 6 行
   * </pre>
   * 汉字算 2 列 → 一行 28 列，一页 6 行 → **168 列**。
   *
   * <p>⚠️ 它随**字号与左右留白**变 —— 可用宽 563px 对应左右留白合计 12%
   * （默认留白 4%/22% 只有 474px，那时一行 11 个字、一页约 132 列）。
   * 所以这里给的是"默认字号 + 那次实测留白"下的约数，换设置就不准了。
   *
   * <p>另外**葡语按单词换行**，每行末尾会浪费几个字符；`EXPANSION` 也是估的。
   * 真要确认某一句话会不会翻页，用眼镜预览页的「排版自检」量，别用这里的估算。
   */
  const COLS_PER_PAGE = 168

  const groups = []
  for (const phrase of phrases) {
    let bucket = groups.find(item => item.name === phrase.group)
    if (bucket === undefined) {
      bucket = { name: phrase.group, items: [] }
      groups.push(bucket)
    }
    bucket.items.push(phrase)
  }

  const columnsOf = text => {
    let width = 0
    for (const ch of text) width += ch.codePointAt(0) < 0x2e80 ? 1 : 2
    return width
  }

  const lines = []
  lines.push('<!-- BEGIN GENERATED phrases-doc -->')
  lines.push('# 验证句集（照着念 / 跑批共用的一份）')
  lines.push('')
  lines.push('> ⚠️ **本文件由 `lib/artifacts.mjs` 从 `scripts/test-phrases.mjs` 生成，不要手改。**')
  lines.push('> 改句子请改 `scripts/test-phrases.mjs`，然后 `npm run generate`。')
  lines.push('> 句子集与文档不一致时 `npm run check` 会直接报错（和插件产物同一个门禁）。')
  lines.push('')
  lines.push('## 为什么是"长难句"')
  lines.push('')
  lines.push('短句测不出问题：切句、显示预算、从句结构、数字、术语表、成语')
  lines.push('—— 这些都要长句才压得出来。所以这一份**全是长难句**，每条都写明"它测的是什么"')
  lines.push('（不然跑完也不知道该看哪里）。')
  lines.push('')
  lines.push('## 两种用法')
  lines.push('')
  lines.push('| 用法 | 命令 | 测到哪一段 |')
  lines.push('|---|---|---|')
  lines.push('| **只列出来照着念** | `node scripts/test-phrases.mjs --list` | 整条链：切句 → 识别 → 翻译 → 显示 |')
  lines.push('| **跑批（手输通道）** | `node scripts/test-phrases.mjs` | 绕过识别，只测翻译 + 显示 + 口径 |')
  lines.push('| 只跑某一条 | `node scripts/test-phrases.mjs --only 3` | 同上 |')
  lines.push('')
  lines.push('朗读时**故意在逗号处停 0.6~1 秒**，就能看出静音判定会不会把一句话切碎。')
  lines.push('')
  lines.push('## 会不会翻页：要按**译文**的宽度算，不是按中文')
  lines.push('')
  lines.push('眼镜上超长句会翻页，而是否翻页取决于**显示出来的那串文字的列宽**')
  lines.push('（汉字 2 列、其他 1 列 —— 和眼镜排版同一个模型）。')
  lines.push('')
  lines.push('⚠️ **这里最容易判断错**：中文很紧凑，葡语会变长，而且**长短不一**。两次实测：')
  lines.push('')
  lines.push('```')
  lines.push('北京航空航天大学是一所优质大学。      30 列 →')
  lines.push('  A Universidade de Aeronáutica e Astronáutica de')
  lines.push('  Pequim é uma universidade de alta qualidade.      88 列（2.93 倍）')
  lines.push('')
  lines.push('关于这个问题，我们的做法是这样的        34 列 →')
  lines.push('  Sobre essa questão, a nossa abordagem é assim,    44 列（1.29 倍）')
  lines.push('```')
  lines.push('')
  lines.push('**差了 2 倍多**，所以光看中文列宽**判断不出**会不会翻页。')
  lines.push(`下面按中间值 ${EXPANSION} 倍给一个**粗略参考**，真实情况请以实际译文为准 ——`)
  lines.push('最直接的判断办法：看眼镜预览页的诊断行，或 `var/logs/relay.log` 里那一句的真实译文。')
  lines.push('')
  lines.push('默认设置（画布 640×400、留白 4%/22%、字号 ×1.35、字号下限 24px）下每页约 ')
  lines.push(`${COLS_PER_PAGE} 列：`)
  lines.push('')
  lines.push(`- **译文 ≤ ${COLS_PER_PAGE} 列** → 不翻页（字号不再随句子缩放，一页固定放 6 行）`)
  lines.push(`- **${COLS_PER_PAGE} ~ ${COLS_PER_PAGE * 2} 列** → 翻 2 页（第一页开头、停在第二页结尾）`)
  lines.push('- 更长 → 每页约一页的量，依次增加')
  lines.push('')
  lines.push('> 阈值随"字号 / 左右留白 / 画布分辨率"变化，所以是**默认值下的约数**。')
  lines.push('> 字号**不再随句子长度自动缩放**（见 [`12-眼镜排版设计.md`](12-眼镜排版设计.md)），')
  lines.push('> 所以"会不会翻页"现在只取决于这句话有多长 —— 规则比过去简单。')
  lines.push('')
  lines.push(`## 全部 ${phrases.length} 句 · ${groups.length} 组`)
  lines.push('')

  let index = 0
  for (const group of groups) {
    lines.push(`### ${group.name}`)
    lines.push('')
    for (const phrase of group.items) {
      index += 1
      const columns = columnsOf(phrase.text)
      const shown = Math.round(columns * EXPANSION)
      const pages = Math.max(1, Math.ceil(shown / COLS_PER_PAGE))
      const verdict = pages === 1 ? '不翻页' : `翻 ${pages} 页`
      lines.push(`**[${index}]** ${phrase.text}`)
      lines.push('')
      lines.push(`- 中文 ${columns} 列 → 译文约 ${shown} 列 → 默认设置下 **${verdict}**`)
      lines.push(`- 测什么：${phrase.why}`)
      lines.push('')
    }
  }

  lines.push('## 相关的其他评测集')
  lines.push('')
  lines.push('| 想测什么 | 用哪个 |')
  lines.push('|---|---|')
  lines.push('| 同传效果（本文件） | `scripts/test-phrases.mjs` |')
  lines.push('| 翻译模型横评（开源 vs 闭源） | `scripts/bench-models.mjs`（直接引用上面这份句集） |')
  lines.push('| 区域口音 / 非标准中文 | `scripts/bench-regional.mjs` |')
  lines.push('| 识别准确率（WER） | `scripts/test-asr.mjs`，见 [`04-语音识别验证.md`](04-语音识别验证.md) |')
  lines.push('| 长句在眼镜上怎么排 / 怎么翻页 | [`09-眼镜SDK接入.md`](09-眼镜SDK接入.md) §12 |')
  lines.push('')
  lines.push('<!-- END GENERATED phrases-doc -->')
  lines.push('')
  return lines.join('\n')
}
