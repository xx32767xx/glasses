#!/usr/bin/env python3
"""
segment_sim.py —— 切句参数的**预筛**工具：没有模型、没有语料也能先量出方向
========================================================================================
这个工具回答的是**切句器自己的行为**，不是识别质量。两件事必须分清：

  · 这里量的（可离线、秒级）：一句话会不会被切成两段 / 两句会不会被并成一段 /
    短句会不会被丢掉 / 切点会不会落在单词中间 / 说完到出段要等多久。
  · 这里**量不了**的：Whisper 拿到这些片段之后认成什么（WER）。
    那需要真音频 + 模型，用 `asr-eval/segment_eval.py --recognize`（同一套切句器）。

为什么值得先做这一层：
    机器上没有模型、也拿不到英文语料时，最常见的做法是"凭直觉调一个数"（比如
    "英文句子短，把 silence 降到 500"）。但这一层的失败模式是**静默的** ——
    短句被 `min_speech_ms` 丢掉时不会有任何报错，用户只看到"说了没字幕"。
    所以先把"哪些参数组合会把内容吃掉"量出来，再去花 GPU 时间量 WER。

它是怎么模拟的（这是本工具最需要被怀疑的地方，所以写清楚）
    1. 按语种给一套**发音时长模型**（词长、词间停顿、句末停顿的分布），
       不是从录音里统计出来的，而是取自语音学上常引用的量级 —— 见 PATTERNS。
    2. 每个词 = 若干个音节包络叠加的带限噪声，能量在词内保持高于自适应门槛；
       词与词之间留真实的短停顿；句与句之间留真实的换气停顿。
    3. 全程叠一层房间底噪（缺省 RMS 0.003），因为自适应门槛要**有底噪**才有意义
       （填零会让门槛退到硬下限，量出来的东西和真实录音不是一回事）。
    4. 把这条流喂进**产线那个** `UtteranceSegmenter`（直接 import，不复制代码），
       用 `TrackedSegmenter` 记账拿到每段的样本区间，再和"真值词边界/句边界"对账。

    结论的可信度取决于第 1、2 步的模型有多像真人。所以报告里每个数都带"这是模拟"的
    标记，而且工具**故意**先跑一遍已知结论的对照（中文 silence 500 比 800 更容易切碎），
    如果连那个方向都跑不出来，说明模拟本身有问题，下面的数一个都不该信。

用法
    python asr-eval/segment_sim.py --lang en                       # 看缺省参数的现状
    python asr-eval/segment_sim.py --lang en --sweep               # 扫一遍主要参数
    python asr-eval/segment_sim.py --lang zh --sweep --check       # 对照已知结论
    python asr-eval/segment_sim.py --lang en --sweep --out var/asr-eval/reports/seg-sim-en.md
"""

import argparse
import json
import sys
from itertools import product
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "bridge"))

from segment_eval import TrackedSegmenter          # noqa: E402  （复用"能记账"的版本）
from whisper_stream import force_utf8_stdio        # noqa: E402

force_utf8_stdio()

RATE = 16000
BLOCK_MS = 100          # 与产线一致（whisper_stream 的 --block-ms 缺省）


# ── 语种发音时长模型 ─────────────────────────────────────────────────────────
#
# ⚠️ 这些数是**量级参考**，不是从我们自己的语料统计出来的。它们决定模拟有多像真人：
#   · 词长：英语实词 250~450ms（含词尾），虚词更短；中文一个字 180~260ms。
#   · 词间停顿：同一短语内部 40~150ms；短语之间 200~400ms。
#   · 句末停顿：450~900ms（换气 + 思考）。
# 如果哪天拿到了英文语料，第一件事应该是用这里的 `--report-timings` 对一下，
# 而不是继续相信下面这几行。

# ⚠️ 哪些数是**量过的**、哪些是**估的**，必须分清：
#   · 句内停顿的中位数/分档：用 `asr-eval/pause_stats.py` 在本机 6 段真实录音上量过
#     （808 个停顿，中位 320ms；120~250ms 占多数，600ms 以上约两成）——
#     下面的 inner_gap / phrase_gap 就按这个分布对齐。
#   · 词长、句末停顿、每句词数、短回应比例：**没有**我们自己的英文语料，取的是语音学上
#     常引用的量级。这几行是模拟里最该被怀疑的地方 —— 有了英文包里第一件事就是用
#     `pause_stats.py` 对一遍（同一个工具也能读英文包的 wav，转成 pcm 即可）。

PATTERNS = {
    "en": {
        "word_ms": (300, 120, 150, 700),     # 均值、标准差、下限、上限
        "inner_gap_ms": (120, 55, 30, 280),  # 词与词之间（对齐全量录到的 120~250ms 主峰）
        "phrase_gap_ms": (300, 90, 160, 520),
        # 句子**内部**的长停顿（犹豫、"and… uh"、换气）：这是 silence_ms 会不会误切的上界。
        # 真实口语里这类停顿很常见（本机录音里 600ms 以上的停顿约占两成）。
        "hesitation_chance": 0.18,
        "hesitation_gap_ms": (620, 200, 350, 1100),
        "sentence_gap_ms": (700, 200, 380, 1200),
        "words_per_sentence": (9, 3, 4, 20),
        "sentences_per_turn": (2.2, 1.1, 1, 6),
        "short_turn_chance": 0.25,           # 英语对话里大量的一两个词回应
    },
    "zh": {
        "word_ms": (210, 60, 130, 420),
        "inner_gap_ms": (115, 55, 25, 300),
        "phrase_gap_ms": (280, 90, 150, 480),
        "hesitation_chance": 0.15,
        "hesitation_gap_ms": (600, 190, 340, 1050),
        "sentence_gap_ms": (660, 190, 350, 1100),
        "words_per_sentence": (12, 3, 5, 26),
        "sentences_per_turn": (2.0, 1.0, 1, 5),
        "short_turn_chance": 0.18,
    },
    "pt": {
        "word_ms": (330, 130, 170, 760),
        "inner_gap_ms": (125, 55, 30, 300),
        "phrase_gap_ms": (310, 90, 170, 540),
        "hesitation_chance": 0.16,
        "hesitation_gap_ms": (610, 190, 350, 1080),
        "sentence_gap_ms": (710, 200, 380, 1200),
        "words_per_sentence": (8, 3, 3, 18),
        "sentences_per_turn": (2.1, 1.0, 1, 5),
        "short_turn_chance": 0.20,
    },
}


def clamp(value, low, high):
    return max(low, min(high, value))


def draw(rng, spec, integer=True):
    mean, sd, low, high = spec
    value = max(low, min(high, rng.normal(mean, sd)))
    return int(round(value)) if integer else float(value)


# ── 合成音频 ─────────────────────────────────────────────────────────────────

def speech_burst(rng, ms, level, rate=RATE):
    """一个"词"的音频：每 60~140ms 一个音节包络，能量保持在门槛以上。

    为什么不用真实语音：这里要的是**位置已知**的能量结构。音节包络让 RMS 有起伏
    （真实语音本来就有），但不让词内部掉到静音 —— 生产切句器只在静音够长时才断句，
    词内的起伏远短于 silence_ms，所以不会造成"词中间被切开"这种假故障。
    """
    count = int(rate * ms / 1000)
    if count <= 0:
        return np.zeros(0, dtype=np.float32)
    noise = rng.normal(0.0, 1.0, count).astype(np.float32)
    # 简单低通：让噪声听起来"有带宽"，不改变能量的量级
    kernel = np.ones(6, dtype=np.float32) / 6.0
    noise = np.convolve(noise, kernel, mode="same")
    envelope = np.ones(count, dtype=np.float32)
    cursor = 0
    while cursor < count:
        syllable = int(rate * rng.uniform(0.06, 0.14))
        if syllable <= 0:
            break
        piece = min(syllable, count - cursor)
        shape = np.hanning(piece + 2)[1:-1].astype(np.float32)
        amplitude = rng.uniform(0.65, 1.25) * level
        envelope[cursor:cursor + piece] = np.maximum(shape * amplitude, 0.35 * level)
        cursor += piece
    audio = noise * envelope
    # 音节包络本身会让 RMS 偏低，再乘回目标档位
    measured = float(np.sqrt(np.mean(audio ** 2))) or 1e-9
    return (audio * (level / measured)).astype(np.float32)


def silence(rng, ms, level, rate=RATE):
    count = int(rate * ms / 1000)
    if count <= 0:
        return np.zeros(0, dtype=np.float32)
    return rng.normal(0.0, level, count).astype(np.float32)


def synthesize_conversation(pattern, args, rng):
    """造一条"连续对话"的流：返回 (音频, 句子真值, 词真值)。

    句子真值：[(起点秒, 终点秒, 词数)] —— 用来判合并/切碎。
    词真值：(起点秒, 终点秒) —— 用来判"切点是不是落在词中间"。

    为什么是"多轮"而不是一句：切合/合并这类错只在**多句连续**时才会发生
    （一段话里的句间停顿被当成句内停顿）。只造一句的话，任何参数看着都完美。
    """
    speech_level = args.speech_level
    noise_level = args.noise_level
    parts = [silence(rng, 800, noise_level)]        # 开场静音（也让自适应门槛有个底）
    cursor = len(parts[0])
    sentences, words = [], []

    for _turn in range(max(1, args.turns)):
        if rng.random() < pattern["short_turn_chance"]:
            # 短回应（"Yeah." / "Sorry?" / "对。"）：英语对话里非常多，
            # 也是 `min_speech_ms` 最容易吃掉的一类
            sentence_count = 1
            word_count = 1 if rng.random() < 0.6 else 2
        else:
            sentence_count = max(1, int(round(draw(rng, pattern["sentences_per_turn"]))))
            word_count = None
        for _index in range(sentence_count):
            if word_count is not None:
                count = word_count
            else:
                count = max(1, int(round(draw(rng, pattern["words_per_sentence"]))))
            sentence_start = cursor
            for _position in range(count):
                word_ms = draw(rng, pattern["word_ms"])
                burst = speech_burst(rng, word_ms, speech_level)
                w_start = cursor / RATE
                parts.append(burst)
                cursor += len(burst)
                words.append((w_start, cursor / RATE))
                # 词间停顿：多数是短停顿，少数是犹豫/换气 —— 后者正是 silence_ms
                # 会不会"把一句话从中间切开"的关键（模拟里必须有这一类）。
                if rng.random() < pattern["hesitation_chance"]:
                    gap_ms = draw(rng, pattern["hesitation_gap_ms"])
                elif rng.random() < 0.2:
                    gap_ms = draw(rng, pattern["phrase_gap_ms"])
                else:
                    gap_ms = draw(rng, pattern["inner_gap_ms"])
                pad = silence(rng, gap_ms, noise_level)
                parts.append(pad)
                cursor += len(pad)
            sentences.append((sentence_start / RATE, cursor / RATE, count))
            # 句末停顿：最后一句之后也留（收句要靠它）
            tail = silence(rng, draw(rng, pattern["sentence_gap_ms"]), noise_level)
            parts.append(tail)
            cursor += len(tail)
    parts.append(silence(rng, 1200, noise_level))   # 收尾静音
    return np.concatenate(parts), sentences, words


# ── 跑切句器 ─────────────────────────────────────────────────────────────────

def make_segmenter(args, params):
    """按**这一组参数**造切句器（不能只传 silence —— 那样其它三个 knob 等于没扫）。"""
    return TrackedSegmenter(
        RATE, BLOCK_MS, params["silence_ms"], params["min_speech_ms"], params["max_speech_ms"],
        args.rms_threshold, args.preroll_ms, np,
        adaptive=True, rms_floor=args.rms_floor, noise_multiplier=args.noise_multiplier,
        short_utterance_ms=params["short_utterance_ms"],
        short_silence_ms=params["short_silence_ms"],
        cut_pause_ms=params["cut_pause_ms"],
    )


def feed(segmenter, audio):
    block = segmenter.block
    remainder = len(audio) % block
    if remainder:
        audio = np.concatenate([audio, np.zeros(block - remainder, dtype=np.float32)])
    for offset in range(0, len(audio), block):
        segmenter.push(audio[offset:offset + block])
    segmenter.flush()
    return list(segmenter.spans)


def overlap(a_start, a_end, b_start, b_end):
    return max(0.0, min(a_end, b_end) - max(a_start, b_start))


def evaluate(stream, sentences, words, spans):
    """把"切出来的段"和"真值"对账，算这一组参数的表现。"""
    segs = [(s / RATE, e / RATE) for s, e in spans]
    segs = [(a, b) for a, b in segs if b > a]

    # ① 每句被几段盖住（按覆盖时长算，不算边缘擦碰）
    cover = 0.2
    per_sentence = []
    for s_start, s_end, _count in sentences:
        hits = [seg for seg in segs if overlap(seg[0], seg[1], s_start, s_end) > cover]
        per_sentence.append(len(hits))
    split = sum(1 for hits in per_sentence if hits >= 2)
    dropped = sum(1 for hits in per_sentence if hits == 0)

    # ② 每段盖住几句（≥2 = 合并）
    merged, max_merge = 0, 0.0
    for seg in segs:
        covered = [1 for s_start, s_end, _ in sentences
                   if overlap(seg[0], seg[1], s_start, s_end) > cover]
        if len(covered) >= 2:
            merged += 1
            max_merge = max(max_merge, seg[1] - seg[0])

    # ③ 切点落在词中间（英语里这是"半个词"，Whisper 最容易凭空补全）
    cuts = [seg[0] for seg in segs[1:]]
    mid_word = 0
    for at in cuts:
        for w_start, w_end in words:
            if w_start + 0.02 < at < w_end - 0.02:
                mid_word += 1
                break

    # ④ 说完到出段要多久：只认"装着这句结尾的那一段"（合并时它拖得更久）。
    #    用"句尾那 100ms 落在哪个段"来判，避免拿"覆盖这句的任意段"去算，
    #    否则切碎时会出现负值（段在这句结束之前就收口了）——那是测量假象。
    latencies = []
    for s_start, s_end, _ in sentences:
        tail = (max(s_start, s_end - 0.1), s_end)
        closing = [seg for seg in segs
                   if overlap(seg[0], seg[1], tail[0], tail[1]) > 0.02]
        if closing:
            latencies.append(max(seg[1] for seg in closing) - s_end)

    durations = [seg[1] - seg[0] for seg in segs]
    words_in_seg = []
    for seg in segs:
        count = sum(1 for w_start, w_end in words
                    if overlap(seg[0], seg[1], w_start, w_end) > 0.05)
        words_in_seg.append(count)

    return {
        "segments": len(segs),
        "split": split,
        "merged": merged,
        "dropped": dropped,
        "mid_word": mid_word,
        "max_merge_s": max_merge,
        "max_seg_s": max(durations) if durations else 0.0,
        "median_seg_s": float(np.median(durations)) if durations else 0.0,
        "median_words": float(np.median(words_in_seg)) if words_in_seg else 0.0,
        "median_latency": float(np.median(latencies)) if latencies else float("nan"),
        "max_latency": max(latencies) if latencies else float("nan"),
    }


def make_conversations(args, pattern):
    """把"跑几遍"的对话**先造出来**，所有参数组合共用同一批。

    为什么必须这样：如果每个参数组合都换一批随机对话，量的就不是"参数的影响"，
    而是"这批对话比那批难"——第一版就是这样，同一行的数上下来回跳（段数 10 ~ 19），
    看起来像参数很敏感，其实全是抽样噪声。配对比较才看得出真实差异。
    """
    streams = []
    for index in range(args.repeat):
        rng = np.random.default_rng(args.seed + index)
        streams.append(synthesize_conversation(pattern, args, rng))
    return streams


def run_once(args, streams, params):
    totals = {}
    for stream, sentences, words in streams:
        segmenter = make_segmenter(args, params)
        spans = feed(segmenter, stream)
        outcome = evaluate(stream, sentences, words, spans)
        for key, value in outcome.items():
            bucket = totals.setdefault(key, [])
            bucket.append(value)
    return {key: float(np.mean(values)) for key, values in totals.items()}


# ── 参数网格 ─────────────────────────────────────────────────────────────────

BASE = {
    "silence_ms": 800,
    "min_speech_ms": 500,
    "max_speech_ms": 30000,
    "short_utterance_ms": 800,
    "short_silence_ms": 1100,
    "cut_pause_ms": 200,
}


def grid_for(language):
    """要扫的组合。顺序刻意是"当前产线默认值在最前面"，方便一眼对上基线。"""
    silence = [800, 500, 650, 1000, 1200, 1500]
    min_speech = [500, 300, 400, 700]
    max_speech = [30000, 15000, 10000, 8000]
    short_silence = [1100, 900, 1400]
    return silence, min_speech, max_speech, short_silence


# 候选档案：`--compare` 跑这几组（含**当前产线**那组作基线）。
#
# ⚠️ 除 "当前产线" 外都不是结论，只是**待验证的候选**：它们要过两关才算数 ——
#    ① 这张表里不出现丢句、切碎不比基线多；② `segment_eval.py --recognize` 在真英文音频上
#    量出的 WER 不比基线差。只过第一关就上线，等于拿"看起来更整齐"当"识别更好"。
CANDIDATES = [
    ("当前产线", {**BASE}),
    ("英文-A 折中", {**BASE, "silence_ms": 650, "min_speech_ms": 400, "max_speech_ms": 12000}),
    ("英文-B 更短段", {**BASE, "silence_ms": 600, "min_speech_ms": 300, "max_speech_ms": 10000}),
    ("英文-C 最激进", {**BASE, "silence_ms": 500, "min_speech_ms": 300, "max_speech_ms": 8000}),
]


def describe(params):
    return (f"silence {params['silence_ms']} / min-speech {params['min_speech_ms']} / "
            f"max-speech {params['max_speech_ms']} / short-silence {params['short_silence_ms']}")


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="切句参数预筛（模拟语音时长结构，不需要模型）")
    parser.add_argument("--lang", default="en", choices=sorted(PATTERNS), help="按哪种语言的时长模型模拟")
    parser.add_argument("--sweep", action="store_true", help="扫参数网格（否则只跑基线）")
    parser.add_argument("--compare", action="store_true",
                        help="只跑几组候选档案（含当前产线作基线），适合贴进讨论")
    parser.add_argument("--check", action="store_true", help="跑对照：确认模拟能复现已知方向")
    parser.add_argument("--repeat", type=int, default=3, help="每条参数跑几遍取均值（缺省 3）")
    parser.add_argument("--turns", type=int, default=10,
                        help="每条流里模拟几轮发言（缺省 10：够让句间/句内停顿互相干扰）")
    parser.add_argument("--seed", type=int, default=20240710)
    parser.add_argument("--speech-level", type=float, default=0.06, help="语音档 RMS（缺省 0.06）")
    parser.add_argument("--noise-level", type=float, default=0.003, help="房间底噪 RMS（缺省 0.003）")
    parser.add_argument("--out", default=None, help="把结果写成 markdown（可选）")
    parser.add_argument("--json", default=None, help="把结果写成 json（可选）")
    # 与产线一致的其余缺省
    parser.add_argument("--silence-ms", type=int, default=BASE["silence_ms"])
    parser.add_argument("--min-speech-ms", type=int, default=BASE["min_speech_ms"])
    parser.add_argument("--max-speech-ms", type=int, default=BASE["max_speech_ms"])
    parser.add_argument("--short-utterance-ms", type=int, default=BASE["short_utterance_ms"])
    parser.add_argument("--short-silence-ms", type=int, default=BASE["short_silence_ms"])
    parser.add_argument("--cut-pause-ms", type=int, default=BASE["cut_pause_ms"])
    parser.add_argument("--preroll-ms", type=int, default=250)
    parser.add_argument("--rms-threshold", type=float, default=0.01)
    parser.add_argument("--rms-floor", type=float, default=0.004)
    parser.add_argument("--noise-multiplier", type=float, default=4.0)
    return parser.parse_args(argv)


def fmt(value, digits=2, suffix=""):
    if value != value:          # NaN
        return "—"
    return f"{value:.{digits}f}{suffix}"


def main(argv=None):
    args = parse_args(argv)
    pattern = PATTERNS[args.lang]
    print(f"模拟语种 {args.lang}（时长模型见 PATTERNS；语音档 {args.speech_level}，底噪 {args.noise_level}）")
    print(f"每条参数跑 {args.repeat} 遍、每遍 {args.turns} 轮发言取均值")
    print("⚠️ 这是**模拟**：量的是切句器的行为，不是识别错误率（WER 要真音频 + 模型）")
    print("")

    rows = []
    labelled = False
    if args.sweep:
        silence, min_speech, max_speech, short_silence = grid_for(args.lang)
        combos = []
        for silence_ms, min_ms, max_ms in product(silence, min_speech, max_speech):
            combos.append({**BASE, "silence_ms": silence_ms,
                           "min_speech_ms": min_ms, "max_speech_ms": max_ms})
        # short-silence 单独一行扫（它和其它三个的交互不是重点，混在一起表太大）
        for short_ms in short_silence:
            combos.append({**BASE, "short_silence_ms": short_ms})
    elif args.compare:
        combos = [dict(params) for _name, params in CANDIDATES]
        labelled = True
    else:
        combos = [dict(BASE)]

    header = (f"{'参数':<64} {'段数':>5} {'切碎':>5} {'合并':>5} {'丢句':>5} "
              f"{'切在词中':>8} {'最长段':>7} {'句尾等待':>8}")
    print(header)
    print("-" * len(header))
    streams = make_conversations(args, pattern)
    total_audio = sum(len(stream) for stream, _s, _w in streams) / RATE / max(1, len(streams))
    print(f"（每遍 {total_audio:.0f} 秒、约 {len(streams[0][1])} 句；"
          f"所有参数组合**共用同一批对话**，所以差异不来自抽样）")
    print("-" * len(header))
    for index, params in enumerate(combos):
        outcome = run_once(args, streams, params)
        row = {**params, **outcome}
        rows.append(row)
        name = CANDIDATES[index][0] if labelled else describe(params)
        print(f"{name:<14} {describe(params):<64}"
              f"{int(outcome['segments']):>5} {int(outcome['split']):>5} {int(outcome['merged']):>5} "
              f"{int(outcome['dropped']):>5} {int(outcome['mid_word']):>8} "
              f"{fmt(outcome['max_seg_s'], 1, 's'):>7} {fmt(outcome['median_latency'], 2, 's'):>8}")

    if args.check:
        print("")
        print("对照（已知结论）：中文 silence 500 应当比 800 切碎更多")
        zh_streams = make_conversations(args, PATTERNS["zh"])
        for silence_ms in (500, 800, 1200):
            params = {**BASE, "silence_ms": silence_ms}
            outcome = run_once(args, zh_streams, params)
            print(f"  zh silence {silence_ms}ms → 切碎 {int(outcome['split'])} / 合并 "
                  f"{int(outcome['merged'])} / 丢句 {int(outcome['dropped'])}")
        print("  （方向对得上，说明模拟的约束是真在起作用；对不上就别信上面的数）")

    if args.out:
        write_report(args, pattern, rows)

    if args.json:
        path = Path(args.json)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"lang": args.lang, "simulated": True,
                                    "speech_level": args.speech_level,
                                    "noise_level": args.noise_level,
                                    "rows": rows}, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n已写出 {path}")
    return 0


def write_report(args, pattern, rows):
    path = Path(args.out)
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        f"# 切句参数预筛（{'模拟' if True else ''}）：{args.lang}",
        "",
        "> ⚠️ **这份报告是模拟的**：它量的是**切句器的行为**（切碎 / 合并 / 丢句 / 切在词中 / 句尾等待），",
        "> **不是识别错误率**。WER 必须用真音频 + 模型量：`python asr-eval/segment_eval.py "
        "--set var/asr-eval/packs/en-eval --recognize --language en --unit word --model large-v3 --device cuda`",
        "",
        f"- 时长模型：`{args.lang}`（见 `asr-eval/segment_sim.py` 的 `PATTERNS`；"
        "词长/词间/句间停顿的分布是量级参考，不是我们自己语料的统计）",
        f"- 语音档 RMS {args.speech_level}、房间底噪 RMS {args.noise_level}、每条参数跑 {args.repeat} 遍取均值",
        "- 用的是**产线同一个** `UtteranceSegmenter`（`bridge/whisper_stream.py`，直接 import）",
        "",
        "| 参数 | 段数 | 切碎 | 合并 | 丢句 | 切在词中 | 最长段 | 句尾等待 | 中位词数/段 |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for row in rows:
        lines.append(
            f"| {describe(row)} | {int(row['segments'])} | {int(row['split'])} | {int(row['merged'])} "
            f"| {int(row['dropped'])} | {int(row['mid_word'])} | {fmt(row['max_seg_s'], 1, 's')} "
            f"| {fmt(row['median_latency'], 2, 's')} | {fmt(row['median_words'], 1)} |")
    lines += [
        "",
        "指标含义：",
        "- **切碎**：一句被切成 ≥2 段（每条字幕都不完整 → 译文残缺）；",
        "- **合并**：一段盖住 ≥2 句（第一句字幕要等第二句说完）；",
        "- **丢句**：一句的音频**一段都没交出去**（内容无声消失 —— 比认错更严重）；",
        "- **切在词中**：切点落在某个词的内部（英语里这是半个词，最容易诱发模型凭空补全）；",
        "- **句尾等待**：这一句说完到能出段的时间（这部分直接叠加在同传延迟上）。",
        "",
        "怎么用这份表：先按**丢句 = 0、切碎尽量小**筛掉不安全的组合，再在剩下的里挑",
        "句尾等待最小的那几个，最后用真音频 + 模型（`segment_eval.py --recognize`）量 WER 定案。",
        "",
    ]
    path.write_text("\n".join(lines), encoding="utf-8")
    print(f"\n已写出 {path}")


if __name__ == "__main__":
    sys.exit(main())
