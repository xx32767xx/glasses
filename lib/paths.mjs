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
 *     var/audio/   测试音频 → 可删，但重录要花时间
 *     var/logs/    跑出来的日志 → 随便删
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
/** 测试音频：自己录的、拼接出来的、从语料抽出来的 */
export const AUDIO_DIR = join(VAR_DIR, 'audio')
/** 日志 */
export const LOGS_DIR = join(VAR_DIR, 'logs')

/** 收件箱文件名（一行一句话，见 docs/05-数据通路.md） */
export const INBOX_NAME = 'asr-inbox.jsonl'
/** 字幕总线文件名（眼镜屏幕的当前帧） */
export const BUS_NAME = 'subtitle-bus.json'
/** 局域网转发的共享密钥文件名 */
export const SECRET_NAME = 'relay-secret.txt'

/** 某个数据目录下的缺省收件箱路径 */
export const defaultInbox = dir => join(dir, INBOX_NAME)
/** 某个数据目录下的缺省字幕总线路径 */
export const defaultBus = dir => join(dir, BUS_NAME)
/** 某个数据目录下的缺省密钥路径 */
export const defaultSecret = dir => join(dir, SECRET_NAME)

/** Whisper 模型缓存的缺省位置（faster-whisper 认 HF_HOME 环境变量） */
export const WHISPER_CACHE_DIR = join(CACHE_DIR, 'hf')
/** 公开语料（如 FLEURS 巴葡）的缺省存放位置 */
export const CORPUS_DIR = join(CACHE_DIR, 'fleurs')
/** 抽出来的葡语测试集缺省位置 */
export const PT_EVAL_DIR = join(AUDIO_DIR, 'pt-eval')
/** 测试用的收件箱（tests/live 的真实组合用它） */
export const TEST_INBOX = join(TEST_DIR, 'live-inbox.jsonl')
