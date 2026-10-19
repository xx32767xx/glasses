/**
 * test-asr.mjs —— 指定模型跑 ASR 测试（识别评测这一层的入口）
 * ============================================================================
 *
 *   node asr-eval/test-asr.mjs --list                          # 看有哪些测试集、哪些模型
 *   node asr-eval/test-asr.mjs --set zh-speech-dev             # 用缺省模型（large-v3/GPU）跑
 *   node asr-eval/test-asr.mjs --set pt-coraa --model medium   # 指定模型
 *   node asr-eval/test-asr.mjs --set pt-coraa --compare        # 跑多个模型并排序
 *   node asr-eval/test-asr.mjs --set pt-eval --device cpu --compute-type int8
 *   node asr-eval/test-asr.mjs --set pt-coraa --by-accent      # 按口音分组出分
 *   node asr-eval/test-asr.mjs --set zh-eval --count 10        # 先跑一小批看趋势
 *   node asr-eval/test-asr.mjs --set zh-speech-dev --errors-above 0.2   # 只列错误率 >20% 的
 *
 * 跑完会给出**问题样本清单**：日志里每条首行带 `ERROR` 前缀（`Select-String ERROR` 就能筛），
 * 同时写到 `<结果>.errors.txt`。每条带音频完整路径、参考、识别、以及具体差异
 * （`漏X`=漏字、`多X`=多字、`A→B`=听成 B），按错误率从高到低排 —— 直接照着听就行。
 *
 * 这一层的其余脚本（都在同一个目录里，见 asr-eval/README.md）：
 *   asr_pack.py            切测试包 / 查切分卫生
 *   asr_eval.py            真正跑模型并算错误率（本脚本调它）
 *   asr_score.py           评分规则（冻结、版本化）
 *   asr_error_analysis.py  两套口径对照 + 错因归因 + 关键信息检查
 *   segment_eval.py        量切句（静音判定该设多久）
 *   context_eval.py        **切句方式**实验（--cut 调它）
 *   context_overlap.py     **上下文方式**实验（--context 调它）
 *
 * ── 一个入口，三种用法（`--cut` / `--context` 是后加的实验；不带它们时行为与原来一致）──
 *
 *   node asr-eval/test-asr.mjs --set zh-speech-dev --model large-v3 --language zh --count 0
 *       模型横评：跑一个**冻结的包**（一条条独立片段），出错误率与延迟。
 *
 *   node asr-eval/test-asr.mjs --cut --count 20 --sweep 500/15000,800/30000,1200/30000
 *       切句实验：从**原始录音**取连续段，同一段音频按不同切法各识别一遍，
 *       量"切碎吃掉多少""少切一点值不值"（结论见 docs/14 §6.7）。
 *
 *   node asr-eval/test-asr.mjs --context [--modes C1,T2] [--spans-file …]
 *       上下文实验：同一批段上比"提示词续传 / 左邻重叠 / 右邻重叠"（docs/14 §6.7.2）。
 *       `--modes` 决定跑哪几种喂法，**缺省只跑 C1,T2**（现状 vs 已选定方案），
 *       `--modes all` 才是全部五种 C1/T1/T2/L/R —— 已经否掉的方案不必每次复核都付一遍算力。
 *
 * ⚠️ **为什么不把两个实验的逻辑也搬进这个脚本**：它们的样本来源与比较基准都不一样 ——
 *    包 = 一条条**互不相邻**的片段（每场录音只抽十几条），实验 = 原始录音里的**连续段**。
 *    把连续段的选取塞进包的流程里，"整段"那一路的音频会混进参考没覆盖的别人的话，
 *    对照就不公平了。所以这里只**拼命令 + 统一产物路径**，判据留在各引擎里。
 *
 * ── 设计上的三个决定，都是为了别把事情搞砸 ─────────────────────────────────
 *
 * ① **指标计算不重写，调同目录的 asr_eval.py。**
 *    那个脚本已经把难的地方做对了：中文按**字**算 CER（按词算的话整句是一个 token，
 *    错一个字和整句全错得到同一个数字）、葡语按词算 WER、去标点但保留葡语重音、
 *    单独统计"输出成繁体"这个 Whisper 已知毛病、CUDA 预热（第一次推理十几秒，
 *    不预热会污染第一个样本）。重写一份 = 两个地方的口径迟早漂移。
 *    这个脚本只做**编排 + 汇总 + 结果留存**。
 *
 * ② **测试集自动发现，不用记路径。**
 *    凡是在 var/asr-eval/packs/ 下有 manifest.jsonl 的目录就是一个测试集
 *    （现在是四个"语种 × 语体"组合各带 dev 与保留集，外加三个历史回归集）。
 *    加新语料不用改这个脚本；别处的包用 `--set-path <目录>` 直接指定。
 *
 * ③ **结果写到 var/asr-eval/results/，跨次留存。**
 *    这样 --compare 能拿历史结果拼一张对照表，而不是每次都要把模型全跑一遍
 *    （large-v3 在 CPU 上很慢，跑一轮是好几分钟）。
 *
 * ⚠️ 一条会让整个测试**静默作废**的坑，脚本会主动检查：
 *    **采样率**。wav 头写错采样率时，模型听到的是被拉伸的音频 —— 字错率会难看，
 *    但你看不出原因（音频文件本身"没问题"，能播放）。这里对每条音频的实际头做校对，
 *    不是 16 kHz 就明确报警。
 */

import { readFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve, basename, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 路径从 lib/paths.mjs 取 —— 仓库的规矩是"凡是落盘的路径都从这里取"。
// ⚠️ 第一版这里用 process.cwd() 自己拼了测试包与结果目录，
//    等于在别处又写了一份路径字面量（正是 paths.mjs 文件头禁止的做法）。
//    用常量之后，路径改一处就够，而且和 fetch-coraa 用的是同一份定义。
import { ASR_DIR, ASR_PACKS_DIR, ASR_RESULTS_DIR, WHISPER_CACHE_DIR } from '../lib/paths.mjs'

/**
 * 仓库根：**从本文件的位置推**，不用 `process.cwd()`。
 *
 * ⚠️ 原来这里是 `process.cwd()`。脚本还在 `scripts/` 里时看不出问题（大家总是
 *    在仓库根跑它），搬到 `asr-eval/` 之后它变成一个真的陷阱：`cd asr-eval && node test-asr.mjs`
 *    会去 `asr-eval/var/asr-eval/packs` 找测试集、并把错误的工作目录传给 python 子进程 ——
 *    报错信息只会说"一个测试集都没有"，看不出真实原因。
 *    从文件位置推就没有这个问题，而且和 lib/paths.mjs 的 ROOT 是同一种做法。
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const RESULT_DIR = ASR_RESULTS_DIR
/** 报告目录：写成人读的 Markdown（与 results 分开，别跟机器读的混在一处） */
const REPORT_DIR = join(ASR_RESULTS_DIR, '..', 'reports')
/** 固化的段清单（切句/上下文实验的输入，见 asr-eval/context_eval.py 的 save_spans） */
const SPANS_DIR = join(ASR_DIR, 'spans')

/**
 * 上下文实验（`--context`）里可选哪几种喂法，以及**缺省跑哪几种**。
 *
 * ⚠️ 缺省是 `C1,T2` 而不是全部五种：五种各要一遍全段识别，而 T1（只看上一句）
 *    与 L/R（声学重叠）在 docs/14 §6.7.2 里已经被否掉了 —— 复核一个已定的结论
 *    不该每次都付五遍算力。要完整对照就显式 `--modes all`。
 * ⚠️ 这个字符串必须与 `context_overlap.py` 里的 `DEFAULT_MODES` 一致。
 *    两处字面量没有编译器帮你对齐，所以 `tests/asr-pack-suite.mjs` 会**读那个 py 文件**
 *    比对，改一边不改另一边会红。
 */
export const DEFAULT_CONTEXT_MODES = 'C1,T2'
export const MODE_MENU = 'C1,T1,T2,L,R'
/** 一次运行里最多允许的代号数（= 五种），以及"整个参数长得像不像代号列表"的判据。 */
const MODE_CODES = new Set(MODE_MENU.split(','))
const MODE_LIST_RE = new RegExp(`^(all|\\*|(${MODE_MENU.replace(/,/g, '|')})(,(${MODE_MENU.replace(/,/g, '|')}))*)$`, 'i')

/** 这一次 `--context` 实际要跑哪几种（没指定就用缺省）—— 命令、产物名、报告三处共用它。 */
export function contextModes(options) {
  return options?.modes ?? DEFAULT_CONTEXT_MODES
}

/**
 * 产物名里的喂法后缀：跑全部五种 → 空（保持 `context_overlap__…` 这个老名字），
 * 只跑一部分 → `-C1T2`。
 *
 * ⚠️ 为什么非要有这个后缀：一份"只跑了 C1,T2"的结果文件，如果名字和完整对照一样，
 *    下次 `--compare` / 读报告的人就会把它当完整对照 —— 这正是 `--count 2` 覆盖
 *    全量基线那件事的同一种错法（那次是 238 KB 被 2.8 KB 盖掉）。
 */
export function modesSuffix(modes) {
  const codes = String(modes ?? '').trim().toLowerCase()
  if (codes === 'all' || codes === '*') return ''
  const picked = codes.split(',').map(part => part.trim().toUpperCase()).filter(Boolean)
  // 引擎会给没选 C1 的清单**自动补上 C1**（它是所有比较的基线），
  // 所以文件名按"实际会跑的那几种"写 —— 名字要比命令行更诚实。
  if (picked.length > 0 && picked.includes('C1') === false) picked.push('C1')
  if (picked.length === 0 || picked.length === MODE_CODES.size) return ''
  return '-' + [...new Set(picked)].sort().join('')
}

/**
 * 给 Python 子进程准备环境变量。
 *
 * ⚠️ 两条都是**照抄 scripts/start-all.mjs 的既有做法**，不是自创：
 *
 *  1. **`HF_HOME` 必须指向仓库里的 `var/cache/hf`**。不设的话 faster-whisper 认的是
 *     默认缓存（`~/.cache/huggingface`），而模型全在仓库缓存里 ——
 *     表现是"明明下过模型，却卡在下载"，然后撞上网络问题报一个**和真实原因无关的错**。
 *     我第一次跑这个脚本就是这样：缓存里 5 个模型都在（连 tiny 都有 77 MB），
 *     却报 `CERTIFICATE_VERIFY_FAILED`。真实原因是缓存目录没告诉它。
 *     （这条在 start-all 里也被一次真实事故逼出来过，见那边的注释。）
 *
 *  2. **`HF_ENDPOINT` 用镜像**。直连 huggingface.co 在本机不通。
 *     用户自己设了就听用户的（和 start-all 的行为一致）。
 *
 *  另外 `PYTHONUTF8` / `PYTHONIOENCODING` 也要设：中文语料的参考文本走 stdout，
 *  Windows 默认 GBK 会直接把打印炸掉（我这次就撞到过 `UnicodeEncodeError: 'gbk'`）。
 */
function childEnv() {
  const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
  if (!env.HF_HOME) env.HF_HOME = WHISPER_CACHE_DIR
  if (!env.HF_ENDPOINT) env.HF_ENDPOINT = 'https://hf-mirror.com'
  return env
}

/**
 * 候选模型。**顺序就是推荐顺序**，不是字母序。
 *
 * 为什么这几个：docs/04 实测过 6 种配置，其中
 *   · large-v3 / CUDA / float16 —— 产线在用的，字错率 3.9%，基准
 *   · medium     / CUDA / float16 —— 98.9% 相对基准，显存更省
 *   · small      / CPU  / int8   —— 纯 CPU 方案，字错率 18.9%（质量分界线）
 *   · base / tiny —— 留在这里是为了**证明它们不能用**（实测输出繁体 + 错字），
 *                   而不是为了推荐。跑它们的价值是给汇报一个"我们试过"的证据。
 */
const MODELS = [
  { name: 'large-v3', device: 'cuda', compute: 'float16', note: '产线在用 · 基准（实测字错率 3.9%）' },
  { name: 'medium', device: 'cuda', compute: 'float16', note: '省显存的次选（实测 CER 7.4%）' },
  { name: 'small', device: 'cuda', compute: 'float16', note: 'GPU 上的小模型' },
  { name: 'small', device: 'cpu', compute: 'int8', note: '纯 CPU 方案（实测 CER 18.9%）' },
  { name: 'base', device: 'cpu', compute: 'int8', note: '⚠️ 已知会把简体输出成繁体' },
  { name: 'tiny', device: 'cpu', compute: 'int8', note: '⚠️ 已知错误多，只作反面对照' },
]

const keyOf = (model, device, compute) => `${model}@${device}/${compute}`

/**
 * 把 `--model <名字>` 解析成一个**被验证过**的配置。
 *
 * ⚠️ 为什么是"查表"而不是"猜"：
 *    第一版按模型名猜设备（只有 large-v3/medium 猜 cuda，其余猜 cpu），
 *    于是 `--model large-v3 --device cpu` 会去跑一个**从没测过的组合** ——
 *    在 CPU 上跑 large-v3 要几分钟/句，而且没人知道那个数字意味着什么。
 *    改成一查表：每个模型对应一条已经量过的配置，
 *    `--device` 只用来**在同一个模型有多条配置时选一条**（现在只有 small 有两条：
 *    CPU/int8 与 GPU/float16，两者实测结果几乎一样）。
 */
function resolveModel(options) {
  const candidates = MODELS.filter(model => model.name === options.model)
  if (candidates.length === 0) {
    console.log(`不认识的模型：${options.model}`)
    console.log('可选的：' + [...new Set(MODELS.map(m => m.name))].join('、'))
    return null
  }
  const chosen = options.device === null
    ? candidates[0]
    : (candidates.find(model => model.device === options.device) ?? candidates[0])
  return {
    ...chosen,
    compute: options.compute ?? chosen.compute,
    note: options.device !== null && chosen.device !== options.device
      ? `（这个模型没有 ${options.device} 的配置，改用 ${chosen.device}）`
      : chosen.note,
  }
}

/**
 * 命令行解析。**纯函数、可导出**：参数写错必须当场报错（不能悄悄跑成缺省），
 * 而"报不报错"只有测试真的去调它才算数 —— 靠人读源码看不出漏了哪一支。
 */
export function parseArgs(argv) {
  const options = {
    set: null, setPath: null, model: null, device: null, compute: null, language: null,
    count: null, errorsAbove: 0.10, compare: false, list: false, byAccent: false,
    hotwords: null,
    show: 3, keep: false,
    // ── 两个"实验"模式（见文件头的说明：入口统一，引擎分开）────────────────
    cut: false,            // 切句方式（context_eval.py）
    context: false,        // 上下文方式：提示词续传 / 声学重叠（context_overlap.py）
    modes: null,           // --context 要跑哪几种喂法（见 DEFAULT_CONTEXT_MODES）
    spansFile: null, sweep: null, limit: null, skipB: false, promptDepth: null,
    outJson: null, outMd: null,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--list') { options.list = true; continue }
    if (token === '--compare') { options.compare = true; continue }
    if (token === '--by-accent') { options.byAccent = true; continue }
    if (token === '--set') { options.set = argv[++index]; continue }
    // --set-path：直接给**目录**（绝对或相对都行），不必非得放在 var/asr-eval/packs 下。
    // 为什么要这条：别处切好的包（另一台机器、另一块盘、临时实验）不该被逼着先拷进
    // var/asr-eval/packs —— 拷贝既费时间，又会让"测的到底是哪一份"变得说不清。
    if (token === '--set-path') { options.setPath = argv[++index]; continue }
    if (token === '--model') { options.model = argv[++index]; continue }
    if (token === '--device') { options.device = argv[++index]; continue }
    if (token === '--compute-type') { options.compute = argv[++index]; continue }
    if (token === '--language') { options.language = argv[++index]; continue }
    if (token === '--count') { options.count = Number(argv[++index]); continue }
    if (token === '--errors-above') { options.errorsAbove = Number(argv[++index]); continue }
    // 热词：空格分隔的词表，原样透传给 asr_eval.py 的 --hotwords。
    // 产物文件名会自动带 `-hw`（见 resultPath），所以不会覆盖基线。
    if (token === '--hotwords') {
      const value = argv[++index]
      if (value === undefined || String(value).trim() === '') {
        throw new Error('--hotwords 需要一串词（空格分隔），例：--hotwords "亮亮视野 LLVision Leion Pro"')
      }
      options.hotwords = String(value).trim()
      continue
    }
    if (token === '--show') { options.show = Number(argv[++index]); continue }
    if (token === '--cut') { options.cut = true; continue }
    // `--context` 后面**可以**直接跟一组代号（`--context C1,T2` / `--context all`）——
    // 只有当下一个参数**整个**长得像代号列表时才吃掉它，否则当成"不指定、用缺省"。
    // 判据是精确匹配而不是"猜"：不匹配就走 --modes 那条路，写错了会明确报错。
    if (token === '--context') {
      options.context = true
      const next = argv[index + 1]
      if (next !== undefined && MODE_LIST_RE.test(next)) { options.modes = argv[++index] }
      continue
    }
    if (token === '--modes') {
      const value = argv[++index]
      // 与 --context 用同一份校验：写错必须**当场报错**，不许悄悄跑成缺省那两种
      // （否则报告看起来正常，实际只跑了一种，而文件名还写着别的）。
      if (value === undefined || MODE_LIST_RE.test(value) === false) {
        throw new Error(`--modes 写错了：${value ?? '（没给值）'}；`
          + `可用 ${MODE_MENU}（逗号分隔）或 all，例：--modes C1,T2 / --modes all`)
      }
      options.modes = value
      continue
    }
    if (token === '--spans-file') { options.spansFile = argv[++index]; continue }
    if (token === '--sweep') { options.sweep = argv[++index]; continue }
    if (token === '--limit') { options.limit = Number(argv[++index]); continue }
    if (token === '--skip-b') { options.skipB = true; continue }
    if (token === '--prompt-depth') { options.promptDepth = Number(argv[++index]); continue }
    if (token === '--out-json') { options.outJson = argv[++index]; continue }
    if (token === '--out-md') { options.outMd = argv[++index]; continue }
    throw new Error('看不懂的参数：' + token)
  }
  if (options.cut && options.context) {
    throw new Error('--cut 与 --context 是两个不同的实验，一次只能跑一个')
  }
  if (options.modes !== null && options.context === false) {
    throw new Error('--modes 只对 --context 有意义（切句那一路的开关是 --sweep / --prompt-depth）')
  }
  return options
}

/**
 * 段清单：`--spans-file` 给了就用它；没给就挑 `var/asr-eval/spans/` 里**最新的**一份。
 *
 * 为什么允许"自动挑最新的"：段清单是**固化**的（见 context_eval.py 的 save_spans），
 * 而实验报告里会记它的**指纹** —— 所以"用了哪一批段"永远不会含糊。
 * 这样 `--context` 就不必先手工去查文件名。
 */
export function resolveSpansFile(options, spansDir = SPANS_DIR) {
  if (options.spansFile) return options.spansFile
  if (existsSync(spansDir) === false) return null
  const files = readdirSync(spansDir).filter(name => name.endsWith('.json'))
    .map(name => join(spansDir, name))
  if (files.length === 0) return null
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return files[0]
}

/**
 * 结果/报告文件名：`<实验>__<段清单名>__<模型>.json` / `.md`（两类产物同名，好对上）。
 *
 * ⚠️ 两种"这次不是完整结果"的情况都会写进文件名（与 `--set` 那条 `-nN` 同一个道理）：
 *    · 只跑一部分喂法（`--modes`）→ `-C1T2`
 *    · 只跑前 N 段（`--limit`）  → `-n1`
 *    否则一份"只有 1 段 / 只有两种喂法"的文件会和完整对照同名，下次被当成完整结果读。
 */
export function experimentPaths(options, modelKey, spansName) {
  const engine = options.context ? 'context_overlap' : 'context_eval'
  const suffix = options.context ? modesSuffix(contextModes(options)) : ''
  const limitSuffix = options.limit ? `-n${options.limit}` : ''
  const stem = `${engine}${suffix}${limitSuffix}__${spansName}__${modelKey.replace(/[/@]/g, '_')}`
  return {
    engine,
    json: options.outJson ?? join(ASR_RESULTS_DIR, `${stem}.json`),
    md: options.outMd ?? join(ASR_RESULTS_DIR, '..', 'reports', `${stem}.md`),
  }
}

/**
 * 把命令行拼成"要跑哪个引擎 + 给它什么参数"。**纯函数**：不碰文件系统、不起进程，
 * 所以能被测试直接断言（这一节的价值全在"拼得对不对"）。
 *
 * ⚠️ 三个引擎各有自己的数据模型，入口只负责**转交**，不替它们做决定：
 *    · `asr_eval.py`      —— 冻结的包（一条条独立片段），模型横评
 *    · `context_eval.py`  —— 原始录音里的**连续段**，比"怎么切"
 *    · `context_overlap.py` —— 同样的连续段，比"给多少上下文"
 *    它们**不能共用 `--set`**：包里的片段不连续，当"整段"喂进去时音频里会混进
 *    参考没覆盖的别人的话，那个对照就不公平了（详见 docs/14 §6.7）。
 */
export function experimentCommand(options, model, spansFile) {
  const common = ['--model', model.name, '--device', model.device,
    '--compute-type', model.compute, '--language', options.language ?? 'zh',
    '--show', String(options.show)]
  if (options.cut) {
    const args = [join(ROOT, 'asr-eval', 'context_eval.py'), ...common]
    // ⚠️ 段清单与 `--count` 的关系要说清（第一版这里会踩坑）：
    //    · 显式给了 `--spans-file` → 就用它（复用同一批段）
    //    · 否则给了 `--count N` → 让引擎去**挑 N 段并固化**（它会写到
    //      var/asr-eval/spans/context-<split>-<N>.json；已存在同名的就复用它）
    //    · 两者都没有 → 复用`spans/` 里最新的那一份
    //    不能"有 spans 文件就无条件复用"，否则 `--cut --count 30` 会悄悄只跑 20 段。
    if (options.spansFile) args.push('--spans-file', options.spansFile)
    else if (options.count !== null) args.push('--count', String(options.count))
    else if (spansFile) args.push('--spans-file', spansFile)
    if (options.sweep) args.push('--sweep', options.sweep)
    // 第二个旋钮：把前 N 段的文本当提示词续传（与"切多长"是两笔独立的账）
    if (options.promptDepth !== null) args.push('--prompt-depth', String(options.promptDepth))
    if (options.skipB) args.push('--skip-b')
    if (options.limit !== null) args.push('--limit', String(options.limit))
    return args
  }
  const args = [join(ROOT, 'asr-eval', 'context_overlap.py'),
    '--spans-file', spansFile, ...common]
  // 喂法清单**总是显式传**：入口不再依赖引擎的缺省值，否则两边各有一个缺省，
  // 迟早一个改了另一个没改（有断言在读 py 文件比对这两处）。
  args.push('--modes', contextModes(options))
  if (options.limit !== null) args.push('--limit', String(options.limit))
  return args
}

/** 凡是有 manifest.jsonl 的目录就是一个测试集 —— 加语料不用改这个脚本。 */
function listSets() {
  if (existsSync(ASR_PACKS_DIR) === false) return []
  return readdirSync(ASR_PACKS_DIR)
    .filter(name => existsSync(join(ASR_PACKS_DIR, name, 'manifest.jsonl')))
    .map(name => setFromDir(name, join(ASR_PACKS_DIR, name)))
}

/** 从一个目录读出一个测试集 —— `--set`（var/asr-eval/packs 下的名字）和 `--set-path`（任意路径）共用。 */
function setFromDir(name, dir) {
  const items = readManifest(dir)
  const wavs = readdirSync(dir).filter(file => file.endsWith('.wav'))
  return {
    name, dir, items, wavCount: wavs.length,
    accents: [...new Set(items.map(item => item.accent).filter(Boolean))],
    corpus: corpusLabel(items),
  }
}

/**
 * 从**任意路径**读出测试集（`--set-path`），没切过的目录返回 null。
 *
 * 结果文件名与打印出来的名字都用**目录名** —— 所以目录名要能认出是哪一包
 * （`zh-speech-dev` 而不是 `tmp1`），否则 `var/asr-eval/results/` 里会堆一堆看不出是什么的 json。
 */
function setFromPath(path) {
  const dir = resolve(path)
  if (existsSync(join(dir, 'manifest.jsonl')) === false) return null
  return setFromDir(basename(dir), dir)
}

/**
 * 语料/语体标签 —— **从 manifest 里读**，不从脚本里的假设推。
 *
 * ⚠️ 这里原来是 `items.some(item => item.source) ? 'CORAA（真实口语）' : 'FLEURS（朗读）'`：
 *    只认识"有 source 字段 = CORAA"，别的语料一律当成 FLEURS 朗读。
 *    于是新切的 MagicData 中文口语包会被标成「FLEURS（朗读）」——
 *    而"朗读还是口语"恰恰是这些数字最关键的限定条件（口语的错误率高得多）。
 *    标签错了比没有标签更糟：它会让人拿两个不可比的数字并排看。
 */
export function corpusLabel(items) {
  const dataset = items.find(item => item.dataset)?.dataset ?? null
  // ⚠️ 这里踩过一次：写成 `find(...)?.register`（漏了 `.tags`）→ 每个包都算出 null，
  //    于是所有语料都没了语体标签。**它不报错**，只是悄悄把"真实口语"降级成没标签。
  //    所以下面有一条测试专门钉住"新切的包必须带得出语体"。
  const register = items.find(item => item.tags?.register)?.tags.register ?? null
  // 语体：能在 manifest 里读到就用读到的；读不到才退回老口径（有 source 字段 = CORAA）
  const kind = register === 'spontaneous' ? '真实口语'
    : register === 'read' ? '朗读'
      : (items.some(item => item.source) ? '真实口语' : null)
  return [dataset, kind ? `（${kind}）` : ''].join('') || 'FLEURS（朗读）'
}

function readManifest(dir) {
  const text = readFileSync(join(dir, 'manifest.jsonl'), 'utf8')
  return text.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line))
}

/**
 * 校对音频头 —— 这是唯一会让整个测试**静默作废**的地方。
 *
 * 为什么值得单独查：如果 wav 头写着 16000 但实际是 48000（采样率标错），
 * 模型听到的是**放慢三倍的音频**，识别结果会一塌糊涂，而音频文件本身能正常播放、
 * 看不出任何问题。我生成 CORAA 样本时就**是靠假设**写死的 16000（后来才验证对），
 * 这种事只会在结论做出来之后才被发现。
 */
function checkAudio(dir, limit = 5) {
  const wavs = readdirSync(dir).filter(file => file.endsWith('.wav')).slice(0, limit)
  const bad = []
  for (const name of wavs) {
    const buffer = readFileSync(join(dir, name))
    if (buffer.subarray(0, 4).toString() !== 'RIFF') { bad.push(`${name} 不是 RIFF/wav`); continue }
    const rate = buffer.readUInt32LE(24)
    const bits = buffer.readUInt16LE(34)
    const channels = buffer.readUInt16LE(22)
    if (rate !== 16000) bad.push(`${name} 采样率 ${rate} Hz（期望 16000）`)
    if (bits !== 16) bad.push(`${name} 位深 ${bits}（asr_eval.py 只读 16 位 PCM）`)
    if (channels !== 1) bad.push(`${name} 声道 ${channels}（期望单声道）`)
  }
  return bad
}

/**
 * 结果文件名：`<测试集>__<模型>_<设备>_<精度>.json`。
 *
 * ⚠️ **小批运行（`--count N`）会带上 `-nN` 后缀** —— 这条是踩出来的：
 *    我为了验证搬家把 `--set zh-speech-dev --count 2` 跑了一遍，
 *    结果它**直接覆盖了那份 304 条跑出来的完整基线**（238 KB → 2.8 KB），
 *    而文件名的看不出任何区别。所以现在：
 *      · 完整跑（`--count 0`）→ `zh-speech-dev__large-v3_cuda_float16.json`（`--compare` 只读这种）
 *      · 小批跑（`--count 2`）→ `zh-speech-dev-n2__large-v3_cuda_float16.json`
 *    **一个样本量一个文件名**，跑小批就不可能再悄悄盖掉完整结果。
 *
 * ⚠️ 带 `--hotwords` 的跑法同理：文件名带 `-hw`，**绝不和基线同名**。
 *    热词是"先验通道"的一种，跑一次就该留下独立的一份结果，不能覆盖基线。
 */
export function resultPath(setName, modelKey, count = null, hotwords = null) {
  const suffix = (count !== null && count > 0) ? `-n${count}` : ''
  const tag = hotwords ? '-hw' : ''
  return join(RESULT_DIR, `${setName}${suffix}${tag}__${modelKey.replace(/[/@]/g, '_')}.json`)
}

/** 调同目录的 asr_eval.py 跑一轮，把它的 JSON 结果读回来。 */
function runOne(set, model, options) {
  mkdirSync(RESULT_DIR, { recursive: true })
  const outJson = resultPath(set.name, keyOf(model.name, model.device, model.compute),
    options.count, options.hotwords)
  const args = [
    // 与这个脚本同目录 —— 评测层的脚本互相调用，不跨层去 bridge/ 找。
    join(ROOT, 'asr-eval', 'asr_eval.py'),
    '--set', set.dir,
    '--model', model.name,
    '--device', model.device,
    '--compute-type', model.compute,
    '--out-json', outJson,
    // Python 侧也按 --show 打对照：不然它的总结里会留一句"随机看 0 条对照"，
    // 看起来像功能坏了，其实是没要求它打。
    '--show', String(options.show),
    // 问题样本清单：每条日志行首带 ERROR，同时写到 <结果>.errors.txt。
    // 这样一轮跑完不用去翻 JSON 就知道"哪几条坏了、音频在哪"。
    '--errors-above', String(options.errorsAbove),
  ]
  if (options.language !== null) args.push('--language', options.language)
  if (options.count !== null) args.push('--count', String(options.count))
  if (options.hotwords) args.push('--hotwords', options.hotwords)
  console.log(`\n▶ ${set.name} × ${model.name} / ${model.device} / ${model.compute} …`
    + (options.hotwords ? `\n  热词：${options.hotwords}` : ''))
  try {
    // 直接把子进程输出透传（进度点、预热耗时、逐条对照都在里面，别藏起来）
    execFileSync('python', args, { stdio: 'inherit', cwd: ROOT, env: childEnv() })
  } catch (error) {
    return { ok: false, failure: String(error && error.message ? error.message : error) }
  }
  if (existsSync(outJson) === false) return { ok: false, failure: '评测没有写出结果 JSON' }
  return { ok: true, result: JSON.parse(readFileSync(outJson, 'utf8')) }
}

const percent = value => (value === null || value === undefined) ? '—' : (value * 100).toFixed(1) + '%'

/**
 * 实验模式下没写 `--model` 时用哪一条配置。
 *
 * ⚠️ 这条是**真踩到的**：`runExperiment` 原来直接调 `resolveModel(options)`，
 *    而 `--model` 不给时它是 `null` → 打印「不认识的模型：null」然后什么都不跑。
 *    `--set` 那一路一直有缺省（MODELS[0]），只有后加的两个实验漏了 ——
 *    而文档里的实验命令恰好都写着 `--model large-v3`，所以一直没暴露。
 *    现在两边行为一致：不给就用第一条（large-v3 / cuda / float16）。
 */
function defaultExperimentModel(options) {
  const chosen = MODELS.find(model => options.device === null || model.device === options.device)
    ?? MODELS[0]
  console.log(`（没指定 --model，用缺省：${keyOf(chosen.name, chosen.device, chosen.compute)}）`)
  return chosen
}

/**
 * 跑"切句方式"或"上下文方式"两个实验。
 *
 * ⚠️ 为什么入口统一、引擎分开（而不是把两个实验的逻辑搬进这个脚本）：
 *    它们的**数据模型不同** —— 实验要的是"原始录音里的连续段"（带官方逐句时间戳），
 *    而 `--set` 那个"包"里是一条条**独立片段**（每场录音只抽十几条，彼此不连续）。
 *    把连续段的选取逻辑塞进包的那套流程里，会让"整段"那一路的音频混进参考没覆盖的话，
 *    对照就不公平了。所以这里只做三件事：**拼命令、统一产物路径、把产物指给用户**。
 *    三个引擎各自的判据与参数说明留在它们自己的 `--help` 里。
 */
function runExperiment(options) {
  const model = options.model === null ? defaultExperimentModel(options) : resolveModel(options)
  if (model === null) return

  const spansFile = resolveSpansFile(options)
  if (options.context && spansFile === null) {
    console.log('缺段清单：上下文实验**必须先有一批固化的段**（它要在同一批段上比不同喂法）。')
    console.log('  先挑一批（会固化下来，之后复用）：')
    console.log('    node asr-eval/test-asr.mjs --cut --count 20')
    return
  }
  const spansName = spansFile ? basename(spansFile).replace(/\.json$/, '') : 'new'
  const paths = experimentPaths(options, keyOf(model.name, model.device, model.compute), spansName)
  const args = [...experimentCommand(options, model, spansFile), '--out-json', paths.json, '--out-md', paths.md]

  console.log('='.repeat(96))
  console.log(options.cut ? '实验 · 切句方式（整段 / 逐句切 / 产线切句参数扫描）'
    : '实验 · 上下文方式（提示词续传 / 左邻重叠 / 右邻重叠）')
  console.log('='.repeat(96))
  console.log(`  模型        ${keyOf(model.name, model.device, model.compute)}（${model.note}）`)
  console.log(`  段清单      ${spansFile ?? '（这次新挑一批，会写到 var/asr-eval/spans/）'}`)
  if (options.sweep) console.log(`  扫描        ${options.sweep}`)
  if (options.context) {
    const asked = contextModes(options)
    const all = modesSuffix(asked) === ''
    console.log(`  喂法        ${asked}${options.modes === null ? '（缺省，不是全部五种）' : ''}`
      + `${all ? '　＝全部五种' : '　（全跑用 --modes all）'}`)
  }
  console.log(`  结果        ${paths.json}`)
  console.log(`  报告        ${paths.md}`)
  console.log(`  说明        这两个实验的样本来源是**原始录音里的连续段**，不是 --set 那个包 ——`)
  console.log(`              包里是一条条独立片段，当"整段"喂会混进参考没覆盖的话（见 docs/14 §6.7）`)
  console.log('')
  mkdirSync(dirname(paths.json), { recursive: true })
  mkdirSync(dirname(paths.md), { recursive: true })
  try {
    execFileSync('python', args, { stdio: 'inherit', cwd: ROOT, env: childEnv() })
  } catch (error) {
    console.log(`\n✗ 实验失败：${String(error && error.message ? error.message : error)}`)
    return
  }
  console.log('')
  console.log('─'.repeat(96))
  console.log('产物（都可反复使用）：')
  console.log(`  结构化结果  ${paths.json}`)
  console.log(`  人读报告    ${paths.md}${existsSync(paths.md) ? '' : '（引擎没有写出来？）'}`)
  console.log(`  段清单      ${spansFile ?? '见报告里的 spansFile 字段'}`)
  console.log('  重跑        报告里有本次的完整重跑命令（含段清单路径与指纹）')
}

/** 把结果按口音分组 —— CORAA 独有（带 accent 标注）。 */
function byAccent(set, result) {
  const groups = new Map()
  const accentOf = new Map(set.items.map(item => [item.file, item.accent ?? '（无标注）']))
  for (const row of result.rows) {
    const accent = accentOf.get(row.file) ?? '（无标注）'
    if (groups.has(accent) === false) groups.set(accent, [])
    groups.get(accent).push(row)
  }
  return [...groups.entries()].map(([accent, rows]) => {
    const units = rows.reduce((sum, row) => sum + row.units, 0)
    const distance = rows.reduce((sum, row) => sum + row.distance, 0)
    return {
      accent, count: rows.length, units,
      rate: units === 0 ? null : distance / units,
      seconds: rows.reduce((sum, row) => sum + row.seconds, 0),
      used: rows.reduce((sum, row) => sum + row.seconds_used, 0),
    }
  }).sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0))
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const sets = listSets()

  if (options.list || sets.length === 0) {
    console.log('测试集（凡是有 manifest.jsonl 的目录）：')
    for (const set of sets) {
      const seconds = set.items.reduce((sum, item) => sum + (item.seconds ?? 0), 0)
      console.log(`  ${set.name.padEnd(12)} ${String(set.items.length).padStart(3)} 条 / ${seconds.toFixed(0)} 秒   ${set.corpus}`
        + (set.accents.length > 0 ? '   口音：' + set.accents.join('、') : ''))
    }
    if (sets.length === 0) console.log('  （一个都没有 —— 先准备语料，见 scripts/fetch-coraa.mjs）')
    console.log('')
    console.log('候选模型（顺序即推荐顺序）：')
    for (const model of MODELS) {
      console.log(`  ${keyOf(model.name, model.device, model.compute).padEnd(22)} ${model.note}`)
    }
    // 两个实验的输入（固化的段清单）也在这里列出来 —— 它们不是"包"，
    // 是**原始录音里的连续段**，见 context_eval.py 的说明。
    const spanFiles = existsSync(SPANS_DIR)
      ? readdirSync(SPANS_DIR).filter(name => name.endsWith('.json'))
      : []
    console.log('')
    console.log('段清单（切句/上下文实验的输入；不是测试包）：')
    if (spanFiles.length === 0) {
      console.log('  （还没有 —— 用 --cut --count 20 挑一批并固化下来）')
    } else {
      for (const name of spanFiles) {
        console.log(`  var/asr-eval/spans/${name}`)
      }
    }
    console.log('')
    console.log('用法：node asr-eval/test-asr.mjs --set ' + (sets[0]?.name ?? 'zh-eval') + ' [--model large-v3] [--compare]')
    console.log('      node asr-eval/test-asr.mjs --set-path <任意绝对/相对目录>（目录里要有 manifest.jsonl）')
    console.log('      node asr-eval/test-asr.mjs --cut [--count 20] [--sweep 500/15000,800/30000,…]')
    console.log('      node asr-eval/test-asr.mjs --context [--modes C1,T2 | --modes all]'
      + ' [--spans-file var/asr-eval/spans/xxx.json]')
    console.log(`        （--context 缺省只跑 ${DEFAULT_CONTEXT_MODES}；--modes all 才是全部五种：${MODE_MENU}）`)
    return
  }

  // ── 两个实验模式：入口在这里，引擎还是各自的脚本（见 experimentCommand 的说明）──
  if (options.cut || options.context) {
    return runExperiment(options)
  }

  if (options.set === null && options.setPath === null) {
    console.log('缺 --set（或 --set-path）。可选的测试集：' + sets.map(set => set.name).join('、'))
    return
  }
  const set = options.setPath !== null ? setFromPath(options.setPath) : sets.find(item => item.name === options.set)
  if (set === null) {
    console.log('没有这个测试集：' + options.setPath + '（这个目录里没有 manifest.jsonl）')
    return
  }
  if (set === undefined) {
    console.log('没有这个测试集：' + options.set + '（可选：' + sets.map(item => item.name).join('、') + '）')
    return
  }

  console.log('='.repeat(76))
  console.log(`测试集 ${set.name}   ${set.items.length} 条 / ${set.items.reduce((s, i) => s + (i.seconds ?? 0), 0).toFixed(0)} 秒   ${set.corpus}`)
  if (set.accents.length > 0) console.log(`口音标注 ${set.accents.join('、')}`)
  console.log('='.repeat(76))

  const problems = checkAudio(set.dir)
  if (problems.length > 0) {
    console.log('')
    console.log('⚠️ 音频格式有问题 —— 这会让整个测试**静默作废**，先修它：')
    for (const problem of problems) console.log('   · ' + problem)
    console.log('   （采样率标错时，模型听到的是被拉伸的音频，字错率难看但你看不出原因）')
    return
  }
  console.log('音频格式校对通过（16000 Hz / 16 位 / 单声道）')

  if (set.wavCount !== set.items.length) {
    console.log(`⚠️ 目录里有 ${set.wavCount} 个 wav，清单只有 ${set.items.length} 条 —— 多出来的不会被测到`)
  }

  // 决定这次跑哪些组合
  let plan
  if (options.compare) {
    plan = MODELS.filter(model => options.device === null || model.device === options.device)
    if (plan.length === 0) {
      console.log(`没有 device=${options.device} 的候选组合（可选：${[...new Set(MODELS.map(m => m.device))].join('、')}）`)
      return
    }
    if (options.device === null && plan.length < MODELS.length) {
      // 说清为什么不跑全部：CPU 上跑 large-v3 要几分钟，默认不拖这么久
      const skipped = MODELS.filter(m => plan.includes(m) === false).length
      console.log(`（--compare 缺省只跑 GPU 组合；想跑 CPU 那 ${skipped} 个加 --device cpu）`)
    }
  } else if (options.model === null) {
    plan = [MODELS[0]]
    console.log('（没指定 --model，用缺省：' + keyOf(MODELS[0].name, MODELS[0].device, MODELS[0].compute) + '）')
  } else {
    const resolved = resolveModel(options)
    if (resolved === null) return
    console.log(`（--model ${options.model} → ${keyOf(resolved.name, resolved.device, resolved.compute)}；${resolved.note}）`)
    plan = [resolved]
  }

  for (const model of plan) {
    const outcome = runOne(set, model, options)
    if (outcome.ok !== true) {
      console.log(`\n✗ ${model.name} 失败：${outcome.failure}`)
      continue
    }
    const result = outcome.result
    console.log('')
    console.log('─'.repeat(76))
    console.log(`结果 · ${set.name} × ${keyOf(model.name, model.device, model.compute)}`)
    console.log('─'.repeat(76))
    console.log(`  加权错误率    ${percent(result.weightedRate)}   ← 按句长加权，反映整体`)
    console.log(`  按句平均      ${percent(result.meanRate)}`)
    console.log(`  高准确句      ${result.goodCount}/${result.scoredCount} 句 ≤ 10%`)
    if (result.traditionalTotal !== undefined && result.traditionalTotal > 0) {
      console.log(`  ⚠️ 疑似繁体    ${result.traditionalTotal} 字，涉及 ${result.traditionalSentences} 句`
        + '（Whisper 中文的已知毛病，这一项要单独看）')
    }
    console.log(`  语种判定      ${JSON.stringify(result.detections)}`)
    console.log(`  音频/耗时     ${result.audioSeconds.toFixed(1)}s / ${result.usedSeconds.toFixed(1)}s`
      + `（RTF ${(result.usedSeconds / result.audioSeconds).toFixed(3)}，每句 ${(result.usedSeconds / result.rows.length).toFixed(2)}s）`)
    console.log(`  结果已存      ${resultPath(set.name, keyOf(model.name, model.device, model.compute), options.count)}`
      + (options.count > 0 ? `（小批运行，文件名带 -n${options.count}，不会覆盖完整结果）` : ''))
    if (options.errorsAbove <= 1.0) {
      const errorsFile = resultPath(set.name, keyOf(model.name, model.device, model.compute),
                                    options.count).replace(/\.json$/, '.errors.txt')
      const bad = result.rows.filter(row => row.rate > options.errorsAbove).length
      console.log(`  问题样本      ${bad}/${result.rows.length} 条错误率 > ${(options.errorsAbove * 100).toFixed(0)}%`
        + `（上面日志里带 ERROR 前缀）`)
      console.log(`  清单文件      ${existsSync(errorsFile) ? errorsFile : '（没生成，见 --errors-above）'}`)
    }

    if (options.byAccent && set.accents.length > 0) {
      console.log('')
      console.log('  按口音分组（错误率高的排前面 —— 这就是"口音适配"的答案）：')
      for (const group of byAccent(set, result)) {
        console.log(`    ${group.accent.padEnd(22)} ${String(group.count).padStart(3)} 条  `
          + `错误率 ${percent(group.rate)}  每句 ${(group.used / group.count).toFixed(2)}s`)
      }
    }

    if (options.show > 0) {
      console.log('')
      console.log(`  对照 ${Math.min(options.show, result.rows.length)} 条：`)
      for (const row of result.rows.slice(0, options.show)) {
        console.log(`    参考  ${row.reference}`)
        console.log(`    识别  ${row.hypothesis}`)
        console.log(`    错误率 ${percent(row.rate)}  [${row.seconds.toFixed(2)}s 音频 / ${row.seconds_used.toFixed(2)}s]`)
        console.log('')
      }
    }
  }

  // 汇总：把所有留存的结果按错误率排序 —— 这才是"该选哪个模型"的答案
  if (options.compare) {
    const rows = []
    for (const model of plan) {
      const path = resultPath(set.name, keyOf(model.name, model.device, model.compute))
      if (existsSync(path) === false) continue
      const result = JSON.parse(readFileSync(path, 'utf8'))
      rows.push({ key: keyOf(model.name, model.device, model.compute), ...result })
    }
    if (rows.length > 1) {
      console.log('')
      console.log('='.repeat(76))
      console.log(`对照汇总 · ${set.name}（按错误率升序，**越靠前越好**）`)
      console.log('='.repeat(76))
      console.log('  模型                    错误率    每句耗时   RTF     疑似繁体')
      for (const row of rows.sort((a, b) => a.weightedRate - b.weightedRate)) {
        console.log(`  ${row.key.padEnd(22)} ${percent(row.weightedRate).padStart(6)}   `
          + `${(row.usedSeconds / row.rows.length).toFixed(2)}s`.padStart(7) + '   '
          + (row.usedSeconds / row.audioSeconds).toFixed(3).padStart(6) + '   '
          + String(row.traditionalTotal ?? 0).padStart(6))
      }
      const best = rows[0]
      const worst = rows[rows.length - 1]
      console.log('')
      console.log(`  最好 ${best.key}：${percent(best.weightedRate)}`)
      console.log(`  对照 ${worst.key}：${percent(worst.weightedRate)}`)
      console.log('  提示：错误率差几倍时结论可靠；只差一两个百分点时样本太小，别当结论用。')
    }
  }
}

// ⚠️ 只在**直接运行**时才跑 main()（照抄 start-all.mjs 的做法）：
//    测试要 import 这个文件来单独验 corpusLabel 这类纯函数，
//    无条件跑 main() 的话 import 一次就等于跑一遍评测。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error('失败：' + String(error && error.message ? error.message : error))
    process.exitCode = 1
  }
}
