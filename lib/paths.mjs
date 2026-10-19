/**
 * paths.mjs —— 运行时路径与文件名的**唯一来源**
 * ============================================================================
 * 为什么要有这个文件：
 *   改造之前，'.tmp/live' 这个目录在 lib/composition.mjs 和 relay/lan-relay.mjs 里
 *   各写了一遍，'asr-inbox.jsonl' / 'subtitle-bus.json' 这两个文件名在 relay、
 *   harness-side、demo、demo-driver 里各写了一遍。改一个名字要同时改四五个地方，
 *   而现在只是"运气好"还没漂移。更糟的是有几处直接把 'E:/GlassesHarness/...'
 *   写死了 —— 仓库换个盘、或者交给别人，那几处会直接崩。
 *
 *   所以：**凡是落盘的路径，都从这里取。** 别在别处再写字面量。
 *
 * 数据目录分层的原则（为什么不是全塞一个 .tmp）：
 *   三种东西的性质完全不同，混在一起的代价很具体 ——
 *     · 想清缓存会把正在跑的链路打断（收件箱/字幕总线是进程间通信状态）
 *     · 五 GB 模型缓存和"随手产生的日志"混在一处，就很难安心整目录删
 *   所以按"能不能随便删"来分层：
 *
 *     var/live/    进程间通信状态 → **不能删**，删了要重启整条链路
 *     var/demo/    演示用的收件箱与字幕总线 → 可删，跑 demo 会重建
 *     var/test/    测试用的收件箱 → 可删
 *     var/cache/   模型与语料缓存 → **随便删**，下次自动重下
 *     var/audio/   测试音频（手机上传、自己录的、拼出来的）→ 可删，但重录要花时间
 *     var/asr-eval/ 识别评测的测试包与结果 → **别随手删**：测试包能一键重建，
 *                   但那是几十分钟的机器时间；结果更是"这一版到底多准"的唯一凭据
 *     var/logs/    跑出来的日志 → 随便删
 *
 *   ⚠️ 识别评测的数据（测试包 + 结果）**单独一层**，不混在 var/audio 与 var/logs 里：
 *     · 它是**可以被复用的测量结果**，不是随手记的日志 —— `--compare` 会拿历史结果拼表，
 *       所以不能跟"随便删"的日志放在一起（混在一起的代价是想清日志时不敢删）；
 *     · 它跟"手机上传的原始音频"是两种东西（一个是测量基准，一个是原始素材），
 *       混在 var/audio 里以后很难一眼分清哪个能删。
 *     代码在 `asr-eval/`（与这一层一一对应），入口是 `asr-eval/test-asr.mjs`。
 *
 *   var/ 整个目录不进版本库（见 .gitignore）。
 */

import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/** 仓库根目录。**不要**在别处再写绝对路径。 */
export const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '')

/** 运行时数据根目录（整体被 git 忽略） */
export const VAR_DIR = join(ROOT, 'var')

/** 进程间通信状态：收件箱、字幕总线、转发密钥。删了要重启链路 */
export const LIVE_DIR = join(VAR_DIR, 'live')
/** 一键演示（scripts/demo.mjs）的数据目录 */
export const DEMO_DIR = join(VAR_DIR, 'demo')
/** 测试用数据（tests/live 的真实组合） */
export const TEST_DIR = join(VAR_DIR, 'test')
/** 可重建的缓存：Whisper 模型、公开语料。随便删 */
export const CACHE_DIR = join(VAR_DIR, 'cache')
/** 测试音频：自己录的、拼接出来的、手机上传的原始音频 */
export const AUDIO_DIR = join(VAR_DIR, 'audio')
/** 日志 */
export const LOGS_DIR = join(VAR_DIR, 'logs')

/**
 * 识别评测这一层（代码在 `asr-eval/`，数据在这里）——**单独一层，见文件头的说明**。
 */
export const ASR_DIR = join(VAR_DIR, 'asr-eval')
/** 切出来的识别测试包：一个包一个目录，里面有 `manifest.jsonl`（见 docs/14） */
export const ASR_PACKS_DIR = join(ASR_DIR, 'packs')
/**
 * 评测结果：`asr-eval/test-asr.mjs` 写、`--compare` / `--by-accent` 读。
 *
 * ⚠️ 它原来在 `var/logs/asr-eval/`，现在搬到评测这一层里。理由不是"整齐"，
 * 而是原来的位置与本文件的分层原则**自相矛盾**：logs 是"随便删"的东西，
 * 而这是**能复用的测量结果**（`--compare` 会拿历史结果拼对照表，
 * 删了就得重跑几十分钟的 GPU）。名字也从 `ASR_EVAL_DIR` 改成 `ASR_RESULTS_DIR`：
 * 一个路径一个名字，不留别名，免得两处各叫各的。
 */
export const ASR_RESULTS_DIR = join(ASR_DIR, 'results')

/** 收件箱文件名（一行一句话，见 docs/05-数据通路.md） */
export const INBOX_NAME = 'asr-inbox.jsonl'
/** 字幕总线文件名（眼镜屏幕的当前帧） */
export const BUS_NAME = 'subtitle-bus.json'
/** 局域网转发的共享密钥文件名 */
export const SECRET_NAME = 'relay-secret.txt'
/**
 * 手机上传的原始音频（PCM S16LE 单声道，追加写）。
 * 手机端「录音上传」走的就是这条路：relay 追加写 → 转写进程尾随读。
 */
export const AUDIO_IN_NAME = 'audio-in.pcm'
/**
 * 上面那段音频的采样率（纯文本，就一个数字）。
 * 为什么单独用一个文件：安卓不保证每台设备都能以 16 kHz 录音，手机失败时会降级到
 * 44.1 kHz 并如实上报。转写进程读到这个数字才知道要不要重采样 —— 猜错会让识别全乱。
 */
export const AUDIO_RATE_NAME = 'audio-in.rate'
/**
 * 手机当前"在听哪种语言"（纯文本，例如 `pt-BR` / `zh-CN`）。
 * 手机上切「听葡语/听中文」时随音频一起发过来，识别进程按它切语种 ——
 * 所以录音进行中切换也立刻生效，不用停止再开始。
 */
export const AUDIO_LANG_NAME = 'audio-in.lang'
/**
 * 用户热词对照表（`{ tables: { "<用户名>": { entries: [...] } } }`）。
 * 为什么在 `var/live/` 而不是手机本地：翻译发生在电脑侧，手机存了也用不上。
 * 规程见 docs/15-热词对照表.md；读写实现见 lib/terms.mjs。
 */
export const TERMS_NAME = 'terms.json'
/** "当前会话用哪个用户"的小文件：插件按它决定读哪张表。 */
export const TERMS_ACTIVE_NAME = 'terms-active.json'
/** 替换事件日志（一行一条 JSON），上线后才写，路径先在这里定死。 */
export const TERMS_LOG_NAME = 'terms.jsonl'

/** 某个数据目录下的缺省收件箱路径 */
export const defaultInbox = dir => join(dir, INBOX_NAME)
/** 某个数据目录下的缺省字幕总线路径 */
export const defaultBus = dir => join(dir, BUS_NAME)
/** 某个数据目录下的缺省密钥路径 */
export const defaultSecret = dir => join(dir, SECRET_NAME)
/** 手机上传音频的缺省落盘位置 */
export const defaultAudioIn = dir => join(dir, AUDIO_IN_NAME)
/** 手机上传音频的采样率旁文件 */
export const defaultAudioRate = dir => join(dir, AUDIO_RATE_NAME)
/** 手机上传音频的语种旁文件 */
export const defaultAudioLang = dir => join(dir, AUDIO_LANG_NAME)
/** 某个数据目录下的热词对照表路径 */
export const defaultTerms = dir => join(dir, TERMS_NAME)
/** "当前会话用哪个用户"的旁文件路径 */
export const defaultTermsActive = dir => join(dir, TERMS_ACTIVE_NAME)

/** Whisper 模型缓存的缺省位置（faster-whisper 认 HF_HOME 环境变量） */
export const WHISPER_CACHE_DIR = join(CACHE_DIR, 'hf')
/** 公开语料（如 FLEURS 巴葡）的缺省存放位置 */
export const CORPUS_DIR = join(CACHE_DIR, 'fleurs')
/** CORAA（巴葡口语语料，含口音标注）的下载位置：元数据 CSV + parquet 分片 */
export const CORAA_CACHE_DIR = join(CACHE_DIR, 'coraa')
/** CORAA 的 parquet 分片（体积大，单独一层便于只删分片保留元数据） */
export const CORAA_SHARD_DIR = join(CORAA_CACHE_DIR, 'shards')
/** 抽出来的葡语测试集缺省位置（历史回归集，仍在用） */
export const PT_EVAL_DIR = join(ASR_PACKS_DIR, 'pt-eval')
/** 从 CORAA 抽出来的、带口音标注的巴葡测试集（历史回归集，仍在用） */
export const PT_CORAA_DIR = join(ASR_PACKS_DIR, 'pt-coraa')

/** 测试用的收件箱（tests/live 的真实组合用它） */
export const TEST_INBOX = join(TEST_DIR, 'live-inbox.jsonl')
