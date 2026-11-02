/**
 * translate-suite.mjs —— 翻译模块（lib/translate.mjs）的隔离门禁（5.33）
 * ============================================================================
 * 这一层是**翻译质量的全部**（提示词、热词归一/观测、校对两道闸）。它被搬出
 * `plugin/core.mjs` 之后，"是不是真的隔离干净了"靠三条机械判据守：
 *
 *   ① **零 import**：它要被内联进动态插件沙箱（沙箱里没有模块系统），
 *      所以它不能 import 任何东西——连 `node:fs` 都不行；
 *   ② **不重复实现**：core 里不许再有 `normalizeTerms`/`proofreadSystem` 这些定义，
 *      只能 import。否则"两处各错一遍"的老毛病会回来；
 *   ③ **词表在模块内部**：调用方只传 `entries`，不许自己拿表去 replace。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

export async function runTranslateSuite({ it, check }) {
  const translatePath = join(ROOT, 'lib', 'translate.mjs')
  const corePath = join(ROOT, 'plugin', 'core.mjs')
  const artifactsPath = join(ROOT, 'lib', 'artifacts.mjs')
  const read = (path) => readFileSync(path, 'utf-8')

  await it('翻译模块是纯模块：零 import（否则内联进沙箱就崩）', () => {
    const source = read(translatePath)
    check('没有任何 import 语句', /^\s*import\s/m.test(source) === false,
      '被内联的模块必须自包含')
    check('没有 require', /\brequire\(/.test(source) === false)
    check('没有 node: 内置依赖', /from '(node:|fs|path)/.test(source) === false)
    check('没有网络/文件 API', /fetch\(|readFileSync|writeFileSync/.test(source) === false)
  })

  await it('翻译模块拥有它该拥有的三块（提示词 / 热词 / 校对）', () => {
    const source = read(translatePath)
    for (const name of ['translationSystem', 'proofreadSystem', 'targetName', 'EN_OUTPUT_RULES']) {
      check(`提示词：导出 ${name}`, new RegExp(`export (function|const) ${name}\\b`).test(source), name)
    }
    for (const name of ['mentionedEntries', 'normalizeTerms',
      'detectTermsMiss', 'planRescue', 'locateTermSpan', 'proofreadKeptNames']) {
      check(`热词：导出 ${name}`, new RegExp(`export (function|const) ${name}\\b`).test(source), name)
    }
    for (const name of ['proofreadRequest', 'proofreadRegression', 'revisionProblem']) {
      check(`校对：导出 ${name}`, new RegExp(`export (function|const) ${name}\\b`).test(source), name)
    }
  })

  await it('core 只 import、不重复实现（防止两处各错一遍）', () => {
    const core = read(corePath)
    check('core 里有 import 指向 lib/translate.mjs',
      /from '\.\.\/lib\/translate\.mjs'/.test(core))
    for (const name of ['normalizeTerms', 'proofreadSystem', 'proofreadRegression',
      'revisionProblem', 'detectTermsMiss', 'mentionedEntries', 'planRescue']) {
      check(`core 里不再定义 ${name}`, new RegExp(`^function ${name}\\(`, 'm').test(core) === false,
        `${name} 应该只在 translate.mjs 里实现`)
      check(`core 里不再导出 ${name}`, new RegExp(`^export function ${name}\\(`, 'm').test(core) === false,
        `${name} 的导出应在 translate.mjs`)
    }
  })

  await it('语言码两边一致（内容重复所以必须钉住）', async () => {
    // Windows 上 dynamic import 必须给 file:// URL（给绝对路径会被当成协议 e:）
    const { pathToFileURL } = await import('node:url')
    const translate = await import(pathToFileURL(translatePath).href)
    const core = await import(pathToFileURL(corePath).href)
    for (const key of ['ZH', 'PT', 'EN']) {
      check(`${key} 取值一致（core=${core[key]}）`, translate[key] === core[key],
        `translate=${translate[key]} core=${core[key]}`)
    }
  })

  await it('内联门禁：生成器会拒绝带 import 的模块、并去重语言码', () => {
    const artifacts = read(artifactsPath)
    check('生成器知道要内联哪些模块', /INLINE_MODULES/.test(artifacts)
      && /lib\/translate\.mjs/.test(artifacts))
    check('会检查被内联模块里有没有 import', /里有 import，无法内联/.test(artifacts))
    check('会把 core 里那条 import 换掉', /translate\.mjs 的正文已拼在本文件开头/.test(artifacts))
    check('会去掉重复的语言码定义', /内联构建：\$1 来自 translate\.mjs/.test(artifacts))
  })

  await it('生成物：含翻译函数、且没有 import（沙箱能直接跑）', () => {
    const bundle = read(join(ROOT, 'dynamic', 'leion-pro.host.js'))
    check('内联了 translationSystem', /function translationSystem\(/.test(bundle))
    check('内联了 normalizeTerms', /function normalizeTerms\(/.test(bundle))
    check('内联了校对闸', /function proofreadRegression\(/.test(bundle))
    check('整份生成物没有 import 语句', /^\s*import\s/m.test(bundle) === false)
    const langDefs = (bundle.match(/^const (ZH|PT|EN) =/gm) ?? []).length
    check('语言码只定义一次（去重生效）', langDefs === 3, `出现了 ${langDefs} 次`)
  })
}
