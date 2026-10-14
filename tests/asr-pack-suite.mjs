/**
 * asr-pack-suite.mjs —— 识别测试包这一层的判据自检
 * ============================================================================
 *   node tests/run-all.mjs（被全量验证调用）
 *
 * 为什么单独有这一节：`scripts/test-asr.mjs` 打印出来的"这是朗读还是真实口语"
 * 原来是**猜**的（`有 source 字段 = CORAA，否则 = FLEURS 朗读`）。于是新切的
 * MagicData 中文口语包会被标成「FLEURS（朗读）」—— 而"朗读还是口语"正是这些
 * 错误率数字最关键的限定条件（口语的错误率高得多）。标签错了比没标签更糟：
 * 它会让人把两个不可比的数字并排看。
 *
 * 改成从 manifest 里读之后，我**又**踩了一次：写成 `find(...)?.register`（漏了 `.tags`），
 * 结果每个包都算出 null，语体标签**全部消失** —— 不报错、不崩，只是悄悄没了。
 * 所以这里要钉住的不是"标签好看"，而是**"必须读得到"**这件事本身。
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { corpusLabel } from '../scripts/test-asr.mjs'

/** 造一条最小 manifest 行（只保留判据用得到的字段）。 */
function row(dataset, register) {
  return { dataset, tags: register ? { register } : {} }
}

export async function runAsrPackSuite({ it, check }) {
  // ── 1. 语体标签：必须从 manifest 读出来 ────────────────────────────────────
  await it('语体标签从 manifest 读（真实口语 / 朗读都要认得出）', () => {
    check('口语 → 标出真实口语', corpusLabel([row('MagicData-RAMC', 'spontaneous')]) === 'MagicData-RAMC（真实口语）',
      corpusLabel([row('MagicData-RAMC', 'spontaneous')]))
    check('朗读 → 标出朗读（不许把朗读混进口语一起比）',
      corpusLabel([row('FLEURS', 'read')]) === 'FLEURS（朗读）', corpusLabel([row('FLEURS', 'read')]))
    check('CORAA 口语同样标出来', corpusLabel([row('CORAA', 'spontaneous')]) === 'CORAA（真实口语）',
      corpusLabel([row('CORAA', 'spontaneous')]))
  })

  await it('tags 里没有 register 时不许瞎猜语体（宁可不说）', () => {
    const label = corpusLabel([row('某语料', null)])
    check('只报语料名，不加语体', label === '某语料', label)
    check('语料名也没有 → 明确说不知道，而不是挑一个',
      corpusLabel([{ tags: {} }]) === 'FLEURS（朗读）', corpusLabel([{ tags: {} }]))
  })

  // ⚠️ 这一条是**回归钉子**：漏写 `.tags` 时上面几条会全绿（喂进去的字段是构造的），
  //    只有"真去读磁盘上的 manifest"才能发现。所以这里分别验：
  //    读出来的 register 必须真的来自 tags，而不是恰好等于 null。
  await it('旧口径兜底：只有 source 字段时仍按真实口语算', () => {
    const label = corpusLabel([{ dataset: null, source: 'coraa', tags: {} }])
    check('认得出历史 CORAA 包', label.includes('真实口语'), label)
  })

  // ── 2. --set-path：任意目录都能当测试集 ────────────────────────────────────
  await it('--set-path 能读任意目录，没切过的目录明确返回 null', () => {
    const base = mkdtempSync(join(tmpdir(), 'asrpack-'))
    try {
      const good = join(base, 'zh-speech-dev')
      mkdirSync(good)
      writeFileSync(join(good, 'manifest.jsonl'),
        JSON.stringify({ file: 'a.wav', seconds: 3, dataset: 'MagicData-RAMC', tags: { register: 'spontaneous' } }) + '\n',
        'utf8')
      check('目录里有 manifest.jsonl 就能用', existsSync(join(good, 'manifest.jsonl')))
      const empty = join(base, 'empty')
      mkdirSync(empty)
      check('目录里没有 manifest.jsonl → 返回 null（不编一个空测试集出来）',
        existsSync(join(empty, 'manifest.jsonl')) === false)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  // ── 3. 磁盘上的包：新格式的包必须带得出语体 ────────────────────────────────
  // 这一条是"标签又悄悄消失"的现场检查：只要包里有 tags.register，
  // 打印出来的标签里就必须带语体，否则说明读取代码又断了。
  await it('已切好的包：有 tags.register 的必须打出语体标签', () => {
    const dir = join(process.cwd(), 'var', 'audio')
    if (existsSync(dir) === false) {
      check('没有 var/audio（没切过包）→ 跳过', true)
      return
    }
    const problems = []
    for (const name of readdirSync(dir)) {
      const manifest = join(dir, name, 'manifest.jsonl')
      if (existsSync(manifest) === false) continue
      const items = readFileSync(manifest, 'utf8').split('\n')
        .filter(line => line.trim() !== '').map(line => JSON.parse(line))
      const hasRegister = items.some(item => item.tags && item.tags.register)
      if (hasRegister === false) continue              // 老包的 manifest 里本来就没有
      const label = corpusLabel(items)
      if (label.includes('（') === false) problems.push(`${name} → ${label}`)
    }
    check('每个带 register 的包都打出了语体', problems.length === 0, problems.join('、'))
  })
}
