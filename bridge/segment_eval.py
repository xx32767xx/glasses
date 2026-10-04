#!/usr/bin/env python3
"""
segment_eval.py —— 切句基准：把「停顿多久算说完一句」从拍脑袋变成一个可以量的数
========================================================================================
为什么要有这个工具
    同传的字幕质量，**先取决于切句，再取决于识别**。
    切错有两种表现，方向相反，而且都会让字幕没法看：

      · 切碎（一句话被切成两段）：Whisper 对 <1 秒的碎片识别质量急剧下降。
        实测「这是一条测试语音」被切开后，后半段变成「测试语音」甚至「你以後」。
      · 合并（两句话被并成一段）：翻译模型拿到的是两句话揉在一起的长句，译文会串味；
        而且第一句的字幕要等到第二句说完才出来 —— 延迟白白变长。

    而「该不该按 1 秒停顿切句」这种事靠感觉是判不出来的：
    正常说话时词与词之间本来就有 300~500 毫秒停顿，句子之间也可能只有 300 毫秒。
    两个分布一旦重叠，就不存在「完美阈值」，只能选一个权衡点 ——
    到底重叠多少、窗口有多宽，必须量出来。

这个工具怎么量
    用的是生产链路上**同一个** UtteranceSegmenter（直接 import，不复制代码，
    所以量的不可能是"另一个东西"），分三个阶段：

    阶段一「单句自测」：每条参考句**单独**喂进去。
        一句话本来只该切出 1 段，切出 ≥2 段就说明这个阈值会把完整句子切碎。
        这一阶段不需要人造停顿 —— 用的是录音里真实存在的自然停顿。

    阶段二「连续对话」：把所有句按指定的**句间停顿**（--gap-ms）拼成一整条流再喂进去。
        整条流才是真实场景（包括"一直不停口"时的强制断句）。数出来：
          · 1:1 对的句子有几条
          · 合并几次（一个片段盖住 ≥2 句）、切碎几条（一句被 ≥2 个片段盖住）
          · 最长合并片段的时长 —— 这是"第一句字幕被拖了多久"的直接度量
        句间停顿取决于说话人习惯（未知量），所以要对它扫一遍，
        看**工作窗口**有多宽：窗口越宽，说明这个阈值越不挑人。

    阶段三「连识别一起量」（--recognize，慢）：把片段真的送进 Whisper，
        按片段实际覆盖的参考文本算**整段错误率**（总编辑距离 / 总参考单位，长度加权）。
        这是唯一能回答"切法变了，字幕到底变好还是变坏"的指标 ——
        段数、合并数都只是过程指标，错误率才是结果指标。

    --pauses：只打印停顿分布（句内自然停顿 vs 句间静音）。
        这是整件事的关键数据：两个分布分不分得开，决定了"有没有一个好阈值"。

用法
    python bridge/segment_eval.py --set var/audio/zh-eval --count 12 --pauses
    python bridge/segment_eval.py --set var/audio/zh-eval --silence-ms 500,700,1000,1500 `
        --gap-ms 300,500,700,1200
    python bridge/segment_eval.py --set var/audio/zh-eval --silence-ms 700,1500 --recognize

⚠️ 写这个工具时踩到的三个坑（都是"量出来的数是假的"这类，记下来免得重犯）
    1. 直接拼 clip 做句间停顿扫描 → **五个 gap 值给出完全相同的表格**。
       原因：FLEURS 每条 clip 自己头尾带着 5 秒上下的录音静音，
       真实句间静音 = 前句尾巴 + 我插的 gap + 后句开头，gap 完全被淹没。
       修法：先削掉 clip 头尾静音（--trim-keep-ms）再插 gap。
    2. 削头尾时用"第一个超过阈值的块"当语音起点 → 被文件开头的**编码杂波**骗了：
       clip 000 在 0.19 秒和 0.32 秒各有一个 0.007 的孤立尖峰（真实语音要到 5 秒后才开始），
       于是"开头静音"被报成 0.19 秒，后面那 5 秒静音反而被算成"句内停顿 3.92 秒"。
       修法：要求**连续 300 毫秒**都超过阈值才算语音开始（`loud_bounds`）。
    3. 全套 clip 用同一个绝对阈值 → 同一份语料里，各条录音电平差 20 倍
       （每秒 RMS 0.005 到 0.10），低电平那些句子的正常起伏会被当成停顿。
       修法：先按每条自己的语音档位归一化（`normalize_level`），再统一判定。
"""

import argparse
import sys
import time
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from asr_eval import detect_unit, error_rate, read_manifest, TRADITIONAL_ONLY   # noqa: E402
from whisper_stream import UtteranceSegmenter, force_utf8_stdio                 # noqa: E402

force_utf8_stdio()          # 中文输出必须走 UTF-8（见 whisper_stream 里的说明）

DEFAULT_RATE = 16000


# ── 能记住位置的切句器 ───────────────────────────────────────────────────────
#
# 生产的 UtteranceSegmenter 只返回"这一段的音频"，不返回"它在流里的哪一段"。
# 但基准要的正是位置 —— 只有知道位置，才能判断它切在了句子中间还是句子之间。
# 所以这里继承它、只加"记账"，判定逻辑一个字都不改，量的就是线上行为。

class TrackedSegmenter(UtteranceSegmenter):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fed = 0            # 已经喂进去多少块；进入 push 时，当前块的下标就是它
        self.spans = []         # 每次收句的样本区间 [起, 止)

    def _span(self, blocks, tail, current):
        """把「buffer 里还有几块 + 尾巴有几块静音」翻译成流上的样本区间。"""
        shift = 1 if current else 0
        first = max(0, self.fed - blocks + shift)
        end = max(0, self.fed - tail + shift)
        return (first * self.block, end * self.block)

    def _take(self):
        blocks, tail = len(self.buffer), self.silent_run
        span = self._span(blocks, tail, current=True)
        utterance = super()._take()
        if utterance is not None:
            self.spans.append(span)
        return utterance

    def _cut_at_pause(self):
        """到上限时按内部停顿断句 —— 这条路径**不经过 _take**，必须单独记账。

        ⚠️ 第一版忘了覆盖这个方法，量出来的结果是假的：凡是在停顿处断出来的
        片段都不在 spans 里，于是基准把它们算成"没进模型"，
        报告出"29.6 秒语音没被覆盖、66 个字丢失"—— 全是测量误差，
        生产代码其实把那些音频好好地交出去了。而且后面的片段位置还会整体前移，
        连带把错误率也算歪。**工具自己错的时候，看起来和真故障一模一样。**
        """
        before = len(self.buffer)
        utterance = super()._cut_at_pause()
        if utterance is not None:
            count = len(utterance) // self.block
            start_block = self.fed - before + 1
            self.spans.append((max(0, start_block) * self.block,
                               (max(0, start_block) + count) * self.block))
        return utterance

    def push(self, block):
        out = super().push(block)
        self.fed += 1
        return out

    def flush(self):
        blocks, tail = len(self.buffer), self.silent_run
        span = self._span(blocks, tail, current=False)
        utterance = super().flush()
        if utterance is not None:
            self.spans.append(span)
        return utterance


# ── 音频工具 ─────────────────────────────────────────────────────────────────

def read_wav(path):
    """读 16-bit 单声道 wav → float32。测试集是 asr_eval 抽出来的，格式固定。"""
    with wave.open(str(path), "rb") as handle:
        if handle.getsampwidth() != 2:
            sys.exit(f"{path} 不是 16-bit wav（要用 asr_eval.py --extract 抽出来的）")
        raw = handle.readframes(handle.getnframes())
        rate = handle.getframerate()
    return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0, rate


def block_rms(audio, block):
    usable = len(audio) // block * block
    if usable == 0:
        return np.zeros(0, dtype=np.float32)
    return np.sqrt(np.mean(audio[:usable].reshape(-1, block) ** 2, axis=1))


def normalize_level(audio, rate, target, block_ms=100):
    """按**语音档位**（能量的 90 百分位）把每条 clip 缩放到同一水平。

    为什么要做：同一份 FLEURS 语料里各条录音电平差 20 倍（每秒 RMS 0.005 ~ 0.10）。
    用同一个绝对阈值去判"这是语音还是停顿"，低电平那条的正常句子起伏就会被当成停顿，
    于是"句内停顿"被凭空量多。归一化之后，"停顿时长"才是可比的量。
    （生产链路的 normalize_peak 做的是同一件事，只是口径不同。）
    """
    energies = block_rms(audio, max(1, int(rate * block_ms / 1000)))
    if energies.size < 5:
        return audio, 1.0
    loud = float(np.percentile(energies, 90))
    if loud <= 1e-6:
        return audio, 1.0
    scale = min(target / loud, 20.0)     # 限制放大倍数，免得把底噪也抬上来
    return audio * scale, scale


def noise_like(seconds, rate, level, rng):
    """一段背景噪声。

    **不能填数字零**：自适应门槛是按"噪声底的 4 倍"定的，填零会让噪声底为 0、
    门槛退到硬下限，量出来的东西和真实录音就不是一回事了（真实房间永远有底噪）。
    """
    count = int(rate * seconds)
    if count <= 0:
        return np.zeros(0, dtype=np.float32)
    return rng.normal(0.0, level, count).astype(np.float32)


def clip_threshold(audio, args):
    """和切句器同口径定阈值：噪声底 × 倍数，但不低于硬下限。"""
    energies = block_rms(audio, 1600)
    if energies.size < 5:
        return args.rms_floor
    return max(args.rms_floor, args.noise_multiplier * float(np.percentile(energies, 10)))


def loud_bounds(audio, rate, threshold, block_ms=10, sustain_ms=300):
    """语音真正从哪里开始、到哪里结束。

    必须要求**连续 sustain_ms 都超过阈值**，不能只看"第一个超过阈值的块"：
    文件开头常有编码杂波（实测 clip 000 在 0.19 秒有个 0.007 的孤立尖峰，
    而真实语音 5 秒后才开始），只看单块会把起点定到杂波上，
    结果整段开头静音被误算成"句内停顿"。
    """
    block = max(1, int(rate * block_ms / 1000))
    energies = block_rms(audio, block)
    need = max(1, int(sustain_ms / block_ms))
    first = last = None
    run = 0
    for index, energy in enumerate(energies):
        if energy >= threshold:
            run += 1
            if run >= need:
                if first is None:
                    first = index - need + 1
                last = index
        else:
            run = 0
    return first, last, block


def silent_runs(audio, rate, threshold, block_ms=10, min_ms=150):
    """找出所有「低于阈值」的连续段，返回 [(起点秒, 时长秒), …]。

    块取得比生产切句器细（10ms 而不是 100ms），因为这里是要**量**停顿有多长：
    100ms 的分辨率会把 250ms 和 340ms 的停顿都报成 300ms。
    """
    block = max(1, int(rate * block_ms / 1000))
    energies = block_rms(audio, block)
    runs, start = [], None
    for index, energy in enumerate(energies):
        if energy < threshold:
            if start is None:
                start = index
        elif start is not None:
            runs.append((start * block_ms / 1000.0, (index - start) * block_ms / 1000.0))
            start = None
    if start is not None:
        runs.append((start * block_ms / 1000.0, (len(energies) - start) * block_ms / 1000.0))
    return [(at, length) for at, length in runs if length * 1000 >= min_ms]


def trim_edges(audio, rate, threshold, keep_ms=100, sustain_ms=300):
    """削掉头尾静音，只留 keep_ms。

    **这一步是为了让 --gap-ms 说了算**：FLEURS 每条 clip 头尾自带几秒录音静音，
    直接拼起来的话，真实句间静音 = 前句尾巴 + 我插的 gap + 后句开头，
    gap 从 300 改到 1200 结果一模一样 —— 第一版就是这么被自己骗了一轮。
    """
    first, last, block = loud_bounds(audio, rate, threshold, sustain_ms=sustain_ms)
    if first is None:
        return audio
    keep = max(1, int(keep_ms / (block / rate * 1000)))
    start = max(0, first - keep) * block
    end = min(len(audio), (last + 1 + keep) * block)
    return audio[start:end]


def overlap(a_start, a_end, b_start, b_end):
    return max(0, min(a_end, b_end) - max(a_start, b_start))


def make_segmenter(rate, silence_ms, args):
    return TrackedSegmenter(
        rate, args.block_ms, silence_ms, args.min_speech_ms, args.max_speech_ms,
        args.rms_threshold, args.preroll_ms, np,
        adaptive=not args.no_adaptive, rms_floor=args.rms_floor,
        noise_multiplier=args.noise_multiplier,
        short_utterance_ms=args.short_utterance_ms,
        short_silence_ms=args.short_silence_ms,
        cut_pause_ms=args.cut_pause_ms,
    )


def feed(segmenter, audio):
    """按块喂完再收尾，返回片段区间列表。

    末尾补齐到一个整块，是为了让"块下标 × 块长"严格等于样本位置 ——
    否则最后那个残缺块会把所有位置算偏。
    """
    block = segmenter.block
    remainder = len(audio) % block
    if remainder:
        audio = np.concatenate([audio, np.zeros(block - remainder, dtype=np.float32)])
    for offset in range(0, len(audio), block):
        segmenter.push(audio[offset:offset + block])
    segmenter.flush()
    return list(segmenter.spans)


# ── 停顿分布 ─────────────────────────────────────────────────────────────────
#
# 这个报告是整件事的关键：切句能不能做好，取决于**句内停顿**和**句间停顿**
# 这两个分布分不分得开。分得开 → 存在一个好阈值；重叠 → 只能选权衡点。

BUCKETS = ((150, 300), (300, 500), (500, 700), (700, 1000), (1000, 1500), (1500, 10 ** 9))


def bucket_label(low, high):
    return f"{low}~{high}ms" if high < 10 ** 8 else f"≥{low}ms"


def classify_pauses(audio, rate, threshold, args):
    """把静音段分成：开头静音 / 句内停顿 / 结尾静音。

    判据是"它落在语音区的里面还是外面"（用 loud_bounds 定语音区），
    不是"它离文件头近不近" —— 后者会被文件开头的编码杂波骗到（见文件头的坑 2）。
    """
    first, last, block = loud_bounds(audio, rate, threshold, sustain_ms=args.sustain_ms)
    seconds = len(audio) / rate
    if first is None:
        return None, None, [], 0.0
    start_s = first * block / rate
    end_s = (last + 1) * block / rate
    is_leading = lambda at: at + 1e-6 < start_s      # noqa: E731
    is_trailing = lambda at, length: at + length > end_s + 1e-6    # noqa: E731
    leading = trailing = None
    inside = []
    for at, length in silent_runs(audio, rate, threshold, min_ms=args.min_pause_ms):
        if is_leading(at):
            leading = (at, length)
        elif is_trailing(at, length):
            trailing = (at, length)
        else:
            inside.append(length)
    return leading, trailing, inside, seconds


def pause_report(clips, rate, args):
    print("停顿分布：每条句子**内部**的自然停顿 vs 句子**之间**的静音")
    print("（句子之间的静音 = 录音头尾自带的那段 —— 这就是「说完一句停多久」的现实值）")
    print("")
    print(f"{'文件':>24} {'时长':>7} {'开头静音':>9} {'结尾静音':>9}  {'句内自然停顿（秒）':<28}")
    internal_all, edge_all = [], []
    for item in clips:
        audio = item["audio"]
        threshold = clip_threshold(audio, args)
        leading, trailing, inside, seconds = classify_pauses(audio, rate, threshold, args)
        internal_all.extend(inside)
        edge_all.extend([v for v in (leading[1] if leading else None,
                                     trailing[1] if trailing else None) if v])
        shown = " ".join(f"{v:.2f}" for v in sorted(inside, reverse=True)[:7]) or "—"
        print(f"{item['name'][-24:]:>24} {seconds:>6.1f}s "
              f"{(leading[1] if leading else 0):>8.2f}s {(trailing[1] if trailing else 0):>8.2f}s  {shown}")
    print("")
    print(f"  句内自然停顿共 {len(internal_all)} 个，分档：")
    for low, high in BUCKETS:
        count = sum(1 for v in internal_all if low <= v * 1000 < high)
        if count:
            flag = "  ← 都会被阈值 ≥ 这个数的静音判定误当成句末" if low >= 500 else ""
            print(f"    {bucket_label(low, high):>10}：{count:>3} 个{flag}")
    print("")
    print(f"  句子之间的静音（{len(edge_all)} 处）：最大 {max(edge_all, default=0):.2f}s / "
          f"中位 {float(np.median(edge_all)) if edge_all else 0:.2f}s")
    print("")
    print(f"  {'静音判定':>8}   句内停顿会被误判成句末的个数")
    for threshold_ms in (500, 700, 1000, 1200):
        broken = sum(1 for v in internal_all if v * 1000 >= threshold_ms)
        print(f"  {threshold_ms:>6}ms   {broken:>3} 个")
    print("")
    if internal_all and edge_all:
        worst = max(internal_all) * 1000
        between = float(np.median(edge_all)) * 1000
        verdict = ("两个分布**重叠** —— 不存在能同时做到不切碎、不合并的阈值"
                   if worst > between else "两个分布分得开 —— 存在一个好阈值")
        print(f"  结论性对比：最长的句内停顿 {worst:.0f}ms vs 句间静音中位 {between:.0f}ms → {verdict}")


# ── 阶段一：单句自测 ─────────────────────────────────────────────────────────

def phase_single(clips, rate, silence_ms, args, rng):
    """每条参考句单独喂进去，数它切出几段。"""
    rows = []
    for item in clips:
        stream = np.concatenate([
            noise_like(args.pad_s, rate, args.noise, rng),
            item["audio"],
            noise_like(args.pad_s, rate, args.noise, rng),
        ])
        segmenter = make_segmenter(rate, silence_ms, args)
        head = int(args.pad_s * rate)
        spans = [s for s in feed(segmenter, stream)
                 if overlap(s[0], s[1], head, head + len(item["audio"])) > 0]
        rows.append({"name": item["name"], "reference": item["reference"],
                     "segments": len(spans), "threshold": segmenter.threshold})
    return rows


# ── 阶段二：连续对话 ─────────────────────────────────────────────────────────

def build_conversation(clips, rate, gap_ms, args, rng):
    """把所有句按 gap_ms 的句间停顿拼成一整条流，并记下每句的位置。"""
    parts, spans, cursor = [], [], 0
    lead = noise_like(args.pad_s, rate, args.noise, rng)
    if len(lead):
        parts.append(lead)
        cursor += len(lead)
    for item in clips:
        audio = item["audio"]
        if not args.no_trim:
            audio = trim_edges(audio, rate, clip_threshold(audio, args),
                               keep_ms=args.trim_keep_ms, sustain_ms=args.sustain_ms)
        spans.append((cursor, cursor + len(audio)))
        parts.append(audio)
        cursor += len(audio)
        filler = noise_like(gap_ms / 1000.0, rate, args.noise, rng)
        if len(filler):
            parts.append(filler)
            cursor += len(filler)
    return np.concatenate(parts), spans


def phase_stream(clips, rate, silence_ms, gap_ms, args, rng):
    """整条连续流喂进去，数 1:1 / 合并 / 切碎。"""
    stream, spans = build_conversation(clips, rate, gap_ms, args, rng)
    segmenter = make_segmenter(rate, silence_ms, args)
    cover = args.cover_ms * rate / 1000
    segments = [s for s in feed(segmenter, stream)
                if any(overlap(s[0], s[1], a, b) > 0 for a, b in spans)]

    covered_per_segment = [
        [j for j, (a, b) in enumerate(spans) if overlap(seg[0], seg[1], a, b) > cover]
        for seg in segments
    ]
    merged = [seg for seg, covered in zip(segments, covered_per_segment) if len(covered) >= 2]
    split = [j for j, (a, b) in enumerate(spans)
             if sum(1 for seg in segments if overlap(seg[0], seg[1], a, b) > cover) >= 2]
    good = sum(1 for covered in covered_per_segment if len(covered) == 1)
    offsets = sorted((seg[0] - spans[covered[0]][0]) / rate * 1000
                     for seg, covered in zip(segments, covered_per_segment) if covered)
    return {
        "stream": stream, "spans": spans, "segment_spans": segments,
        "segments": len(segments), "good": good,
        "merged": len(merged), "split": len(split),
        "max_merge_s": max((s[1] - s[0] for s in merged), default=0) / rate,
        "offset_ms": offsets[len(offsets) // 2] if offsets else float("nan"),
        "threshold": segmenter.threshold,
    }


# ── 阶段三：连识别一起量 ─────────────────────────────────────────────────────

def load_model(rate, args):
    """载入并预热模型。**只做一次** —— 每个配置都重载一遍会白等 4×20 秒，
    而且预热时间会混进 RTF 统计。"""
    from faster_whisper import WhisperModel

    print(f"载入模型 {args.model}（device={args.device}, compute_type={args.compute_type}）…")
    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
    warm = time.perf_counter()
    list(model.transcribe(np.zeros(rate, dtype=np.float32), language=args.language)[0])
    print(f"预热 {time.perf_counter() - warm:.1f}s")
    return model


def recognize(clips, result, rate, args, unit, model):
    """把片段真的送进模型，按片段覆盖的参考文本算错误率。

    **两个口径都要报，因为它们回答的是两个不同的问题**（第一版只算了前一个，
    结果把一个"其实没错"的配置报成 52% 错误率，差点得出反向结论）：

      · 逐段错误率（per-unit）：每个片段各自和它盖住的整句参考比。
        这个数**天然偏高**：一句话被切成两段时，两个片段各自只念了半句，
        却都要对着整句参考算 —— 两段都记成"漏了一半字"。
        它衡量的是**每一条字幕自己是不是一个完整的翻译单位**（译文会不会残缺）。

      · 整段错误率（joined）：把所有片段的结果按顺序拼起来，
        和所有涉及句子的参考按顺序比。切碎但没丢字的话，这个数**不会变差**。
        它衡量的是**观众最终拿到的文字对不对**（有没有丢内容、有没有胡话）。

    两个数的差，正好告诉我们：切碎是"伤在字幕分段"还是"真的丢了内容"。
    """
    stream, spans = result["stream"], result["spans"]
    distance = units = traditional = kept = 0
    elapsed = 0.0
    reached = set()          # 哪些句子的音频真的进了模型
    texts = []
    for seg in result["segment_spans"]:
        audio = stream[seg[0]:seg[1]]
        covered = [j for j, (a, b) in enumerate(spans) if overlap(seg[0], seg[1], a, b) > 0]
        if not covered or audio.size < 0.2 * rate:
            continue
        reached.update(covered)
        reference = " ".join(clips[j]["reference"] for j in covered)
        start = time.perf_counter()
        pieces, _ = model.transcribe(
            audio, language=args.language, beam_size=args.beam_size,
            vad_filter=True, condition_on_previous_text=False,
            initial_prompt=args.initial_prompt,
        )
        text = "".join(p.text for p in pieces).strip()
        elapsed += time.perf_counter() - start
        _, ref_units, dist = error_rate(reference, text, unit)
        units += ref_units
        distance += dist
        traditional += sum(1 for c in text if c in TRADITIONAL_ONLY)
        texts.append(text)
        kept += 1

    # 漏掉多少字：一次都没进过模型的句子。切得太碎时碎片会被 min_speech_ms 丢掉，
    # 那些内容就是**无声地消失**了 —— 比识别错更严重，所以单独报一个数。
    missed = sum(error_rate(clips[j]["reference"], "", unit)[1]
                 for j in range(len(clips)) if j not in reached)
    joined_reference = " ".join(clips[j]["reference"] for j in sorted(reached))
    joined_rate, joined_units, _ = error_rate(joined_reference, " ".join(texts), unit)
    return {"rate": distance / units if units else float("nan"), "units": units,
            "joined": joined_rate, "joined_units": joined_units,
            "traditional": traditional, "elapsed": elapsed, "segments": kept,
            "missed": missed}


# ── 主流程 ───────────────────────────────────────────────────────────────────

def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="切句基准：量一量「停顿多久算说完一句」，以及这样切会不会把句子切碎")
    parser.add_argument("--set", dest="wavset", required=True,
                        help="测试集目录（asr_eval.py --extract 抽出来的那个）")
    parser.add_argument("--count", type=int, default=12, help="用多少条（缺省 12，够看分布）")
    parser.add_argument("--silence-ms", default="500,700,1000,1200",
                        help="要对比的静音判定时长，逗号分隔（缺省 500,700,1000,1200）")
    parser.add_argument("--gap-ms", default="500", help="句间停顿，逗号分隔（缺省 500）")
    parser.add_argument("--pauses", action="store_true",
                        help="只打印停顿分布（句内自然停顿 vs 句间静音），不跑切句")
    parser.add_argument("--recognize", action="store_true", help="连识别一起量（慢，需要模型）")
    parser.add_argument("--unit", default="auto", choices=["auto", "char", "word"])
    parser.add_argument("--model", default="large-v3")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--compute-type", default="float16")
    parser.add_argument("--language", default=None)
    parser.add_argument("--beam-size", type=int, default=5)
    parser.add_argument("--initial-prompt", default=None)
    parser.add_argument("--noise", type=float, default=0.0015,
                        help="填充用背景噪声的 RMS（缺省 0.0015）")
    parser.add_argument("--pad-s", type=float, default=0.8, help="每段前后垫多久的静音（缺省 0.8 秒）")
    parser.add_argument("--level-target", type=float, default=0.06,
                        help="每条 clip 归一化后语音档（90 百分位）的目标 RMS（缺省 0.06）")
    parser.add_argument("--no-normalize-level", action="store_true",
                        help="不按语音档归一化各条 clip（缺省归一化，见文件头坑 3）")
    parser.add_argument("--min-pause-ms", type=int, default=150, help="多长的静音才算一个停顿（缺省 150ms）")
    parser.add_argument("--sustain-ms", type=int, default=300,
                        help="连续多久超过阈值才算语音开始/结束（缺省 300ms，见文件头坑 2）")
    parser.add_argument("--no-trim", action="store_true",
                        help="不削掉每条 clip 头尾自带的静音。缺省**削** —— 不削的话 "
                             "真实句间静音会被录音头尾的静音淹没，--gap-ms 就失去意义了")
    parser.add_argument("--trim-keep-ms", type=int, default=100, help="削头尾时保留多久（缺省 100ms）")
    parser.add_argument("--cover-ms", type=int, default=200,
                        help="片段与句子重叠超过这么久才算「盖住了这句」（缺省 200ms，避开边缘擦碰）")
    parser.add_argument("--seed", type=int, default=20240607)
    # 以下参数直接透传给生产的切句器，缺省值与 whisper_stream.py 保持一致
    parser.add_argument("--block-ms", type=int, default=100)
    parser.add_argument("--min-speech-ms", type=int, default=500)
    parser.add_argument("--max-speech-ms", type=int, default=15000,
                        help="单句最长时长，超过强制切句（缺省 15000，与生产一致）")
    parser.add_argument("--short-utterance-ms", type=int, default=800)
    parser.add_argument("--short-silence-ms", type=int, default=1100)
    parser.add_argument("--cut-pause-ms", type=int, default=200,
                        help="到上限强制断句时，要找多长的内部停顿才肯切（缺省 200，与生产一致）。"
                             "设成 99999 可以复现「到上限硬切」的旧行为")
    parser.add_argument("--preroll-ms", type=int, default=250)
    parser.add_argument("--rms-threshold", type=float, default=0.01)
    parser.add_argument("--no-adaptive", action="store_true")
    parser.add_argument("--rms-floor", type=float, default=0.004)
    parser.add_argument("--noise-multiplier", type=float, default=4.0)
    return parser.parse_args(argv)


def load_clips(args):
    wavset, items = read_manifest(args.wavset)
    clips = []
    for item in items[: args.count]:
        audio, rate = read_wav(wavset / item["file"])
        if rate != DEFAULT_RATE:
            sys.exit(f"{item['file']} 是 {rate}Hz，测试集应该是 {DEFAULT_RATE}Hz")
        if not args.no_normalize_level:
            audio, _ = normalize_level(audio, rate, args.level_target)
        clips.append({"name": item["file"], "reference": item["reference"], "audio": audio})
    return clips


def main(argv=None):
    args = parse_args(argv)
    clips = load_clips(args)
    unit = args.unit if args.unit != "auto" else detect_unit([c["reference"] for c in clips])
    label = "字" if unit == "char" else "词"
    total_s = sum(len(c["audio"]) for c in clips) / DEFAULT_RATE

    blocks = np.concatenate([block_rms(c["audio"], DEFAULT_RATE) for c in clips])
    print(f"测试集 {args.wavset}：{len(clips)} 条、{total_s:.1f} 秒；错误率按**{label}**算")
    if not args.no_normalize_level:
        print(f"已按语音档归一化到 RMS {args.level_target}"
              f"（归一化后：停顿档 p10 {np.percentile(blocks, 10):.4f} / "
              f"中位 {np.percentile(blocks, 50):.4f} / 语音档 p90 {np.percentile(blocks, 90):.4f}）")
    print(f"填充背景噪声 RMS {args.noise}，每段前后垫 {args.pad_s}s")
    print("")

    if args.pauses:
        pause_report(clips, DEFAULT_RATE, args)
        return 0

    silences = [int(v) for v in str(args.silence_ms).split(",") if v.strip()]
    gaps = [int(v) for v in str(args.gap_ms).split(",") if v.strip()]

    # ── 阶段一 ──
    print("阶段一：每条参考句**单独**喂进去 —— 本来应该只切出 1 段")
    print("（切出 ≥2 段 = 这个阈值会把完整的一句话切碎）")
    print(f"{'静音判定':>10} {'实测阈值':>10} {'只切出 1 段':>13} {'被切碎的':>10} {'最多切成':>9}")
    single = {}
    for silence_ms in silences:
        rows = phase_single(clips, DEFAULT_RATE, silence_ms, args, np.random.default_rng(args.seed))
        single[silence_ms] = rows
        clean = sum(1 for r in rows if r["segments"] == 1)
        broken = [r for r in rows if r["segments"] >= 2]
        threshold = float(np.mean([r["threshold"] for r in rows]))
        print(f"{silence_ms:>8}ms {threshold:>10.4f} {clean:>9}/{len(rows):<3} "
              f"{len(broken):>10} {max((r['segments'] for r in rows), default=0):>9}")
    cut_examples = [(ms, r) for ms, rows in single.items() for r in rows if r["segments"] >= 2]
    if cut_examples:
        print("")
        print("  被切碎的例子（静音判定越短越容易碎）：")
        for ms, r in cut_examples[:6]:
            print(f"    {ms}ms → 切成 {r['segments']} 段：{r['reference'][:40]}")
    print("")

    # ── 阶段二 ──
    print(f"阶段二：{len(clips)} 句按指定句间停顿拼成**一整条流**再喂进去")
    print(f"{'静音判定':>10} {'句间停顿':>9} {'片段数':>7} {'1:1 对':>8} {'合并':>6} "
          f"{'切碎':>6} {'最长合并':>9} {'起点偏差':>9}")
    results = {}
    for gap_ms in gaps:
        for silence_ms in silences:
            result = phase_stream(clips, DEFAULT_RATE, silence_ms, gap_ms, args,
                                  np.random.default_rng(args.seed))
            results[(gap_ms, silence_ms)] = result
            print(f"{silence_ms:>8}ms {gap_ms:>7}ms {result['segments']:>7} {result['good']:>8} "
                  f"{result['merged']:>6} {result['split']:>6} {result['max_merge_s']:>8.1f}s "
                  f"{result['offset_ms']:>8.0f}ms")
    print("")

    # ── 阶段三 ──
    if args.recognize:
        print("阶段三：片段真的送进模型。两个口径都报 —— 见 recognize() 里的说明")
        print("  逐段 = 每条字幕自己是否是完整翻译单位（偏高，切碎会推高它）")
        print("  整段 = 把所有字幕文字按顺序拼起来对不对（切碎但不丢字时不会变差）")
        print(f"{'静音判定':>10} {'句间停顿':>9} {'片段数':>7} {'逐段错误率':>11} {'整段错误率':>11} "
              f"{'疑似繁体':>9} {'识别耗时':>9} {'漏掉字数':>9}")
        model = load_model(DEFAULT_RATE, args)
        for gap_ms in gaps:
            for silence_ms in silences:
                outcome = recognize(clips, results[(gap_ms, silence_ms)], DEFAULT_RATE,
                                    args, unit, model)
                if not outcome["units"]:
                    print(f"{silence_ms:>8}ms {gap_ms:>7}ms   没有可识别的片段")
                    continue
                print(f"{silence_ms:>8}ms {gap_ms:>7}ms {outcome['segments']:>7} "
                      f"{outcome['rate'] * 100:>10.1f}% {outcome['joined'] * 100:>10.1f}% "
                      f"{outcome['traditional']:>9} {outcome['elapsed']:>8.1f}s "
                      f"{outcome['missed']:>9}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
