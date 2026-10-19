/**
 * asr-pack-suite.mjs —— 识别评测这一层的结构自检（测试包、标签、路径、分层方向）
 * ============================================================================
 *   node tests/run-all.mjs（被全量验证调用）
 *
 * 为什么单独有这一节：`asr-eval/test-asr.mjs` 打印出来的"这是朗读还是真实口语"
 * 原来是**猜**的（`有 source 字段 = CORAA，否则 = FLEURS 朗读`）。于是新切的
 * MagicData 中文口语包会被标成「FLEURS（朗读）」—— 而"朗读还是口语"正是这些
 * 错误率数字最关键的限定条件（口语的错误率高得多）。标签错了比没标签更糟：
 * 它会让人把两个不可比的数字并排看。
 *
 * 改成从 manifest 里读之后，我**又**踩了一次：写成 `find(...)?.register`（漏了 `.tags`），
 * 结果每个包都算出 null，语体标签**全部消失** —— 不报错、不崩，只是悄悄没了。
 * 所以这里要钉住的不是"标签好看"，而是**"必须读得到"**这件事本身。
 *
 * 后来评测层从 bridge/ 与 scripts/ 搬到 asr-eval/（数据搬到 var/asr-eval/），
 * 这一节又多了三件事要钉 —— 都是"搬家之后**只有靠自动检查才发现得了**"的那类：
 *   · 完整跑与小批跑的结果文件名不能撞（撞了就会用 2 条的结果覆盖 304 条的基线，
 *     我自己就这么干过一次）；
 *   · Python 侧写的路径字面量必须与 `lib/paths.mjs` 指向同一个目录（两种语言各写一份，
 *     没有编译器帮你对）；
 *   · **分层方向**：bridge/（产线）不许 import asr-eval/（评测）。
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ASR_PACKS_DIR, ASR_RESULTS_DIR } from '../lib/paths.mjs'
import {
  DEFAULT_CONTEXT_MODES, corpusLabel, experimentCommand, experimentPaths, modesSuffix,
  parseArgs, resolveSpansFile, resultPath,
} from '../asr-eval/test-asr.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '')

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
    const dir = ASR_PACKS_DIR
    if (existsSync(dir) === false) {
      check('没有 var/asr-eval/packs（没切过包）→ 跳过', true)
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

  // ── 4. 小批运行不许覆盖完整结果 ────────────────────────────────────────────  //
  // 这条是**踩出来的**，不是想出来的：搬家之后我为了验证路径，跑了
  // `--set zh-speech-dev --count 2`，结果它写到与完整基线**同一个文件名**上，
  // 238 KB 的 304 条基线被 2.8 KB 的 2 条结果覆盖了，而文件名上没有任何区别。
  // 现在一个样本量一个文件名，这条断言钉的就是这个性质。
  await it('小批运行的结果文件名带样本量（不许盖掉完整基线）', () => {
    const full = resultPath('zh-speech-dev', 'large-v3_cuda_float16', 0)
    const partial = resultPath('zh-speech-dev', 'large-v3_cuda_float16', 2)
    check('完整跑用标准文件名', full.endsWith('zh-speech-dev__large-v3_cuda_float16.json'), full)
    check('小批跑带 -nN 后缀', partial.endsWith('zh-speech-dev-n2__large-v3_cuda_float16.json'), partial)
    check('两者不是同一个文件（否则小批会覆盖完整结果）', full !== partial)
    check('没传 count 时保持旧口径（--compare 读的就是它）',
      resultPath('zh-speech-dev', 'large-v3_cuda_float16') === full)
    // 热词跑出来的结果必须有独立文件名：它和基线是**两种配置**，混在一起会毁掉可比性。
    const hotworded = resultPath('zh-speech-dev', 'large-v3_cuda_float16', 0, '亮亮视野 LLVision')
    check('带热词的跑法文件名带 -hw', hotworded.endsWith('zh-speech-dev-hw__large-v3_cuda_float16.json'),
      hotworded)
    check('热词结果与基线不是同一个文件', hotworded !== full)
    check('没传热词时不加后缀（基线仍可被 --compare 读到）',
      resultPath('zh-speech-dev', 'large-v3_cuda_float16', 0, null) === full)
    check('小批 + 热词两个后缀能同时出现',
      resultPath('zh-speech-dev', 'large-v3_cuda_float16', 2, 'x')
        .endsWith('zh-speech-dev-n2-hw__large-v3_cuda_float16.json'))
    check('结果目录就是 paths.mjs 里那一个（不另写路径）',
      full.startsWith(ASR_RESULTS_DIR), full)
    check('模型名里的 / 与 @ 会被替换掉（否则会写进子目录）',
      resultPath('x', 'a/b@c').includes('a_b_c'), resultPath('x', 'a/b@c'))
  })

  // ── 4b. 两个实验的命令拼装（入口统一、引擎分开）────────────────────────────
  //
  // 这三块的数据模型不同（包=独立片段 / 实验=连续段），所以入口只**拼命令**、
  // 不搬逻辑。这里钉的就是"拼得对不对"——拼错了会跑到另一个引擎上，
  // 或者悄悄丢掉一个参数（比如 --sweep），而结果看起来仍然像一份正常报告。
  await it('实验模式：切句走 context_eval，上下文走 context_overlap', () => {
    const model = { name: 'large-v3', device: 'cuda', compute: 'float16' }
    const cut = experimentCommand({ cut: true, context: false, sweep: '500/15000,1200/30000',
      show: 2, language: 'zh', spansFile: null, count: null, limit: null, skipB: true }, model, 'x.json')
    check('切句那一路调的是 context_eval.py', cut[0].endsWith('context_eval.py'), cut[0])
    check('扫描参数被原样带过去（丢了它就跑成单配置）',
      cut.includes('--sweep') && cut[cut.indexOf('--sweep') + 1] === '500/15000,1200/30000')
    check('--skip-b 只影响切句那一路', cut.includes('--skip-b'))
    check('模型/设备/精度/语种都带上了',
      cut.includes('large-v3') && cut.includes('cuda') && cut.includes('float16') && cut.includes('zh'))

    const ctx = experimentCommand({ cut: false, context: true, show: 3, language: 'zh',
      spansFile: 'spans/a.json', count: null, limit: 4, skipB: false }, model, 'spans/a.json')
    check('上下文那一路调的是 context_overlap.py', ctx[0].endsWith('context_overlap.py'), ctx[0])
    check('上下文那一路必须带段清单（它要在同一批段上比）',
      ctx.includes('--spans-file') && ctx[ctx.indexOf('--spans-file') + 1] === 'spans/a.json')
    check('--limit 带过去了（冒烟测试用）', ctx.includes('--limit') && ctx.includes('4'))
    check('上下文那一路**不该**收到 --sweep（它没有这个参数，传了会直接报错）',
      ctx.includes('--sweep') === false, ctx.join(' '))
  })

  // ── 热词（`--hotwords`）：先验通道的一种，必须能量、且不能覆盖基线 ──────────
  //
  // faster-whisper 的 hotwords 是把词表编成 token 塞进 decoder 的 previous_tokens，
  // 和 initial_prompt 走同一条通道 —— 所以它既可能修好专名拼写，也可能诱发漏字/回显。
  // 这里钉的是"能不能传、传错了会不会报错、产物名会不会撞基线"。
  await it('热词参数：能传、写错要报错、产物名带 -hw 不撞基线', () => {
    const parsed = parseArgs(['--set', 'zh-read-dev', '--hotwords', 'Chhappan Bhog CEP'])
    check('--hotwords 被解析成一整串（空格分隔的词表）',
      parsed.hotwords === 'Chhappan Bhog CEP', String(parsed.hotwords))
    check('不给 --hotwords 时是 null（不是空串 —— 空串会拼出空 token）',
      parseArgs(['--set', 'zh-read-dev']).hotwords === null)
    let message = ''
    try { parseArgs(['--set', 'zh-read-dev', '--hotwords']) } catch (error) { message = String(error.message) }
    check('--hotwords 后面没给值要明确报错', message.includes('--hotwords'), message)
    message = ''
    try { parseArgs(['--set', 'zh-read-dev', '--hotwords', '  ']) } catch (error) { message = String(error.message) }
    check('--hotwords 只给空白也要报错（不许静默当成"没开热词"）',
      message.includes('--hotwords'), message)
  })

  await it('实验模式：段清单与 --count 的关系（不许悄悄只跑旧的那一批）', () => {
    const model = { name: 'large-v3', device: 'cuda', compute: 'float16' }
    const base = { cut: true, context: false, show: 2, language: 'zh', limit: null, skipB: false }
    const explicit = experimentCommand({ ...base, spansFile: 's.json', count: 30 }, model, 's.json')
    check('显式给了 --spans-file 就听它的', explicit[explicit.indexOf('--spans-file') + 1] === 's.json')
    const byCount = experimentCommand({ ...base, spansFile: null, count: 30 }, model, 'old.json')
    check('只给 --count 时交给引擎去挑（否则 --count 30 会悄悄跑成旧的 20 段）',
      byCount.includes('--count') && byCount.includes('30') && byCount.includes('--spans-file') === false,
      byCount.join(' '))
    const reuse = experimentCommand({ ...base, spansFile: null, count: null }, model, 'newest.json')
    check('两个都没给就复用最新的那一份', reuse[reuse.indexOf('--spans-file') + 1] === 'newest.json')
  })

  // ── 上下文实验的 `--modes`：跑哪几种喂法 ────────────────────────────────
  //
  // 为什么这条要单独钉：缺省从"五种全跑"改成"C1,T2"之后，**"只跑了一部分"这件事
  // 必须同时出现在命令行、产物名、报告和 JSON 里** —— 否则一份缺了三种喂法的报告
  // 长得和完整对照一模一样。同一种错法这个仓库已经吃过一次（`--count 2` 覆盖全量基线）。
  await it('上下文实验的 --modes：缺省、全部、文件名后缀、与 Python 侧一致', () => {
    const model = { name: 'large-v3', device: 'cuda', compute: 'float16' }
    const base = { cut: false, context: true, show: 2, language: 'zh',
      spansFile: 'spans/a.json', count: null, limit: null, skipB: false, promptDepth: null }

    check('缺省不是"全部五种"（已否掉的方案不该每次复核都付一遍算力）',
      DEFAULT_CONTEXT_MODES === 'C1,T2', DEFAULT_CONTEXT_MODES)
    check('缺省时也**显式**把 --modes 传给引擎（两边各有一个缺省迟早会漂）',
      experimentCommand({ ...base, modes: null }, model, 'spans/a.json')
        .join(' ').includes('--modes C1,T2'))

    const all = parseArgs(['--context', '--modes', 'all'])
    check('--modes all → 五种全跑', all.modes === 'all', String(all.modes))
    check('--context 后面可以**直接**跟代号（省得写两遍）',
      parseArgs(['--context', 'T1,T2']).modes === 'T1,T2')
    check('--context 后面不是代号就不吃它（`--context --limit 4` 不能被当成代号）',
      parseArgs(['--context', '--limit', '4']).modes === null)
    let message = ''
    try { parseArgs(['--context', '--modes', 'T9']) } catch (error) { message = String(error.message) }
    check('代号写错必须当场报错，不许悄悄跑成缺省那两种', message.includes('--modes 写错了'), message)
    message = ''
    try { parseArgs(['--cut', '--modes', 'all']) } catch (error) { message = String(error.message) }
    check('--modes 配 --cut 要报错（那个引擎没有这个参数）', message.includes('只对 --context 有意义'), message)

    check('跑全部五种时产物名**不带**后缀（保住原来的完整对照文件名）',
      modesSuffix('all') === '' && modesSuffix(DEFAULT_CONTEXT_MODES) === '-C1T2',
      `${modesSuffix('all')} / ${modesSuffix(DEFAULT_CONTEXT_MODES)}`)
    check('只跑一部分时后缀按**固定顺序**（C1,T2 与 T2,C1 得到同一个名字）',
      modesSuffix('T2,C1') === modesSuffix('C1,T2'))
    check('没选 C1 时后缀补上 C1（引擎会自动加它，名字要跟实际跑的一致）',
      modesSuffix('T2') === '-C1T2', modesSuffix('T2'))
    const subset = experimentPaths({ context: true, outJson: null, outMd: null, modes: 'C1,T2' },
      'large-v3_cuda_float16', 'context-dev-20')
    check('只跑一部分 → 文件名带 -C1T2（不会被当成完整对照）',
      subset.json.endsWith('context_overlap-C1T2__context-dev-20__large-v3_cuda_float16.json'),
      subset.json)
    const full = experimentPaths({ context: true, outJson: null, outMd: null, modes: 'all' },
      'large-v3_cuda_float16', 'context-dev-20')
    check('跑全部 → 与原来的完整结果**同名**（历史结果还能对上）',
      full.json.endsWith('context_overlap__context-dev-20__large-v3_cuda_float16.json'), full.json)

    // ⚠️ 两处字面量（JS 的 DEFAULT_CONTEXT_MODES 与 py 的 DEFAULT_MODES）没有编译器对齐，
    //    所以这里**真的去读那个 py 文件**，而不是靠人记得同步改。
    const python = readFileSync(join(ROOT, 'asr-eval', 'context_overlap.py'), 'utf8')
    const declared = /DEFAULT_MODES\s*=\s*\(([^)]*)\)/.exec(python)
    const parsed = declared === null ? null
      : declared[1].split(',').map(part => part.trim().replace(/['"]/g, '')).filter(Boolean).join(',')
    check('py 侧 DEFAULT_MODES 能被读出来（格式别改花）', parsed !== null, String(parsed))
    check('JS 的缺省与 py 的 DEFAULT_MODES 一致（改一边不改另一边会红）',
      parsed === DEFAULT_CONTEXT_MODES, `${parsed} vs ${DEFAULT_CONTEXT_MODES}`)
    check('py 侧真的按这个缺省跑（不是只写了个常量没人用）',
      python.includes('parse_modes(args.modes)') && python.includes('run_span(model, args, span, audio, rate, segments, modes)'))
  })

  await it('实验模式的产物路径：结果与报告同名、都在 var/asr-eval 下', () => {
    const paths = experimentPaths({ context: true, outJson: null, outMd: null, modes: 'all' },
      'large-v3_cuda_float16', 'context-dev-20')
    check('文件名里带实验名、段清单名、模型（一眼看出是哪一批）',
      paths.json.endsWith('context_overlap__context-dev-20__large-v3_cuda_float16.json'), paths.json)
    check('报告与结果同名（好对上）', paths.md.endsWith('.md')
      && paths.md.replace(/\.md$/, '.json').endsWith(paths.json.split(/[\\/]/).pop()), paths.md)
    check('结果在 results/ 下', paths.json.includes('results'), paths.json)
    check('报告在 reports/ 下（人读的与机器读的分开）', paths.md.includes('reports'), paths.md)
    check('显式指定就听指定的', experimentPaths({ context: true, outJson: 'a.json', outMd: 'b.md' },
      'm', 's').json === 'a.json')
    const cutPaths = experimentPaths({ cut: true, context: false }, 'm', 's')
    check('切句那一路的文件名带 context_eval（不用 context_overlap）',
      cutPaths.json.includes('context_eval__'), cutPaths.json)
    // ⚠️ 缺省（不写 --modes）现在是 C1,T2，所以**必然带后缀** ——
    //    这条与上面那条一起钉住"部分结果不与完整对照同名"。
    check('不给 --modes 走缺省时带 -C1T2 后缀（部分结果不许叫完整对照的名字）',
      experimentPaths({ context: true, outJson: null, outMd: null },
        'm', 's').json.includes('context_overlap-C1T2__'))
    check('--limit 冒烟测试也带 -nN（1 段的结果更不能叫完整对照的名字）',
      experimentPaths({ context: true, outJson: null, outMd: null, modes: 'all', limit: 1 },
        'm', 's').json.includes('context_overlap-n1__'),
      experimentPaths({ context: true, outJson: null, outMd: null, modes: 'all', limit: 1 }, 'm', 's').json)
    check('两种后缀能同时出现（--modes C1,T2 --limit 1）',
      experimentPaths({ context: true, outJson: null, outMd: null, modes: 'C1,T2', limit: 2 },
        'm', 's').json.includes('context_overlap-C1T2-n2__'))
  })

  await it('段清单自动解析：没有 spans 目录/空目录都要如实返回 null', () => {
    check('不给 --spans-file 且目录不存在 → null', resolveSpansFile({ spansFile: null },
      join(ROOT, 'var', 'test', 'no-such-span-dir')) === null)
    check('显式给的那份直接返回（不做存在性检查，交给引擎报错）',
      resolveSpansFile({ spansFile: 'whatever.json' }) === 'whatever.json')
  })

  // ── 5. Python 侧写的路径必须与 lib/paths.mjs 指向同一个目录 ────────────────
  //
  // Python 读不到 JS 常量，所以 `asr_pack.py` 里只能再写一份 `var/asr-eval/packs`。
  // 两份字面量没有任何编译器帮你对齐 —— 所以这里**真的去问 python 要那个值**，
  // 而不是在源码里搜字符串（搜字符串只能证明"写了什么"，证明不了"算出来是什么"）。
  await it('Python 侧的数据目录与 lib/paths.mjs 一致（跨语言不许各写各的）', () => {
    let printed = null
    try {
      printed = execFileSync('python', ['-c',
        'import sys; sys.path.insert(0, r"' + join(ROOT, 'asr-eval') + '");'
        + ' import asr_pack; print(asr_pack.PACKS_DIR)',
      ], { encoding: 'utf8', cwd: ROOT }).trim()
    } catch (error) {
      check('没找到 python → 跳过这一节（装 python + numpy 后会跑起来）', true)
      return
    }
    check('两边指向同一个目录', printed === ASR_PACKS_DIR, `python=${printed} js=${ASR_PACKS_DIR}`)
    check('而且那个目录真的存在（路径对了但目录没有，也是错的）',
      existsSync(ASR_PACKS_DIR) && statSync(ASR_PACKS_DIR).isDirectory(), ASR_PACKS_DIR)
  })

  // ── 6. 分层方向：产线不许依赖评测 ──────────────────────────────────────────
  //
  // 评测层 import 产线（whisper_stream / whisper_transcribe）是**有意**的：
  // 它要量的是产线那个分段器本身，不是复制一份。但方向反过来就糟了 ——
  // 那意味着产线跑起来要带着测量工具，改测试代码会影响产线行为。
  // 这条只有靠自动检查才守得住（人不会每次都去读 5 个文件的 import）。
  await it('依赖方向：bridge/（产线）不 import asr-eval/（评测）', () => {
    const evalModules = ['asr_eval', 'asr_pack', 'asr_score', 'asr_error_analysis', 'segment_eval']
    const offenders = []
    for (const name of readdirSync(join(ROOT, 'bridge'))) {
      if (name.endsWith('.py') === false) continue
      const source = readFileSync(join(ROOT, 'bridge', name), 'utf8')
      for (const module of evalModules) {
        if (new RegExp(`^\\s*(from|import)\\s+${module}\\b`, 'm').test(source)) {
          offenders.push(`bridge/${name} → ${module}`)
        }
      }
    }
    check('一个都没有', offenders.length === 0, offenders.join('、'))
    // 反过来要确认"评测确实在用产线的类"（不然上面那条可能只是因为谁都没 import）
    const segEval = readFileSync(join(ROOT, 'asr-eval', 'segment_eval.py'), 'utf8')
    check('而且评测层确实在复用产线的分段器（不是复制一份）',
      /from whisper_stream import .*UtteranceSegmenter/.test(segEval), '没找到 UtteranceSegmenter')
  })
}
