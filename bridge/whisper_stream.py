#!/usr/bin/env python3
"""
whisper_stream.py —— 用 faster-whisper 把音频流实时转写成逐行文本
========================================================================================
它的 stdout 每一行是一句识别结果，交给 bridge/asr-bridge.mjs 转发到
leion-pro 的 ASR 收件箱：

    python bridge/whisper_stream.py --language pt | node bridge/asr-bridge.mjs --inbox <收件箱>
    node bridge/asr-bridge.mjs --inbox <收件箱> --engine whisper --from pt-BR

依赖
    pip install faster-whisper numpy
    python bridge/whisper_stream.py --self-check     # 只检查依赖与模型能否加载

用法
    python bridge/whisper_stream.py                          # 麦克风，自动判语种
    python bridge/whisper_stream.py --language pt            # 固定语种（更准更快，同传应该固定）
    python bridge/whisper_stream.py --file x.wav             # 转写文件（不需要麦克风）
    python bridge/whisper_stream.py --file x.wav --realtime  # 按真实时间喂音频，测"真实延迟"
    python bridge/whisper_stream.py --file x.wav --stats     # 只跑一遍并打印统计

设计取舍
    · 用「静音切分」而不是流式解码：同传要的是**整句**，半句翻出去毫无意义，而
      faster-whisper 对短片段的效果差。所以按 RMS 能量切出语音段，每段整句识别。
    · 每识别出一句就 print + flush，绝不缓冲多句 —— 延迟就是同传的命。
    · 句子边界是「静音超过 N 毫秒」，也就是 asr-bridge 那边 --flush-on-pause-ms 的
      物理对应物，区别只是这里的判断更可靠（有音频能量信息）。

⚠️ 关于"延迟"这个数
    同传的真实延迟 ≈ 静音判定时长(silence_ms) + 识别耗时 + 翻译耗时。
    静音判定那段是**等出来的**：你必须等对方停下来才知道一句说完了。
    所以 --stats 会把这个"理论最短延迟"和实测识别耗时一起报出来，
    报给老师的是一个可复现的数字，而不是"感觉挺快"。

⚠️ 关于 Whisper 在静音上"编话"
    Whisper 遇到噪声或静音会凭空调出训练数据里的高频句（中文常见"请不吝点赞订阅"
    这类，葡语常见字幕组署名）。所以这里加了两道闸：能量门槛 + no_speech_prob 门槛，
    另外还有 avg_logprob 门槛。三个阈值都可以调，见 --no-speech-prob / --min-logprob。
"""

import argparse
import queue
import sys
import time

HALLUCINATION_SAMPLES = (
    "请不吝点赞", "订阅", "转发", "打赏", "明镜", "点点栏目",   # 中文常见幻听
    "amara.org", "legendas", "subtitles by", "subscribe",       # 葡/英常见幻听
)


# ── 参数 ─────────────────────────────────────────────────────────────────────

def parse_args():
    parser = argparse.ArgumentParser(description="faster-whisper 实时转写，逐行输出")
    parser.add_argument("--model", default="small", help="模型大小：tiny/base/small/medium/large-v3（缺省 small）")
    parser.add_argument("--device", default="cpu", help="cpu 或 cuda（本机实测两者都能跑，见 --stats）")
    parser.add_argument("--compute-type", default="int8",
                        help="int8 / int8_float16 / float16 / float32（CPU 用 int8，GPU 用 float16）")
    parser.add_argument("--language", default=None, help="固定语种（zh / pt）；缺省自动判定")
    parser.add_argument("--file", default=None, help="转写一个音频文件而不是麦克风")
    parser.add_argument("--realtime", action="store_true",
                        help="文件模式按真实时间喂块（不加速），用来测真实延迟")
    parser.add_argument("--stats", action="store_true", help="退出时打印统计（延迟、RTF）")
    parser.add_argument("--samplerate", type=int, default=16000, help="采样率（Whisper 要 16000）")
    parser.add_argument("--block-ms", type=int, default=100, help="每次读取的音频块长度")
    parser.add_argument("--silence-ms", type=int, default=700, help="静音超过这么久就认为一句话结束")
    parser.add_argument("--min-speech-ms", type=int, default=300, help="短于这么久的语音段丢弃（多半是噪声）")
    parser.add_argument("--max-speech-ms", type=int, default=15000, help="单句最长时长，超过就强制切句（防止一直不说停）")
    parser.add_argument("--rms-threshold", type=float, default=0.01, help="判定「有语音」的能量阈值（配合 --no-adaptive 使用）")
    parser.add_argument("--adaptive", dest="adaptive", action="store_true", default=True,
                        help="自动估计环境噪声并据此定阈值（缺省开）")
    parser.add_argument("--no-adaptive", dest="adaptive", action="store_false",
                        help="关掉自适应，固定用 --rms-threshold")
    parser.add_argument("--rms-floor", type=float, default=0.004,
                        help="自适应阈值的最低值，防止静音房把阈值压到 0（缺省 0.004）")
    parser.add_argument("--noise-multiplier", type=float, default=4.0,
                        help="阈值 = 噪声底 × 这个倍数（缺省 4.0）")
    parser.add_argument("--no-warmup", action="store_true",
                        help="跳过预热。首次推理在 CUDA 上要十几秒（见文档），生产环境必须预热")
    parser.add_argument("--preroll-ms", type=int, default=250,
                        help="把语音起点之前这么久的音频也带上（避免削掉开头的气声/辅音）")
    parser.add_argument("--no-speech-prob", type=float, default=0.60,
                        help="no_speech_prob 高于这个值就丢弃该段（防幻听）")
    parser.add_argument("--min-logprob", type=float, default=-1.00,
                        help="avg_logprob 低于这个值就丢弃该段（太不确定就别显示）")
    parser.add_argument("--self-check", action="store_true", help="只检查依赖与模型能否加载")
    return parser.parse_args()


# ── 依赖 ─────────────────────────────────────────────────────────────────────

def load_dependencies(need_audio: bool):
    """按需导入，缺依赖时给出能照着做的错误信息。"""
    try:
        import numpy as np
    except ImportError:
        sys.exit("缺少 numpy：pip install numpy")
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        sys.exit("缺少 faster-whisper：pip install faster-whisper")

    sounddevice = None
    if need_audio:
        try:
            import sounddevice as sd
        except ImportError:
            sys.exit("缺少 sounddevice（麦克风输入需要它）：pip install sounddevice")
        sounddevice = sd
    return np, WhisperModel, sounddevice


# ── 音频分段 ─────────────────────────────────────────────────────────────────

class UtteranceSegmenter:
    """按 RMS 能量把连续音频切成一句一句。

    刻意保持成一个小状态机而不是用 VAD 模型：同传链路里真正的瓶颈是识别与翻译，
    而一个能量阈值 + 静音时长在安静场景已经够用，且零额外依赖。

    两个容易写错的地方，这里是刻意处理过的：
      · 前导缓存（preroll）：如果只从"检测到能量的那一块"开始收，句首的轻声、
        塞音（p/t/k）经常被削掉，转写就会丢字。所以持续保留最近 N 毫秒，
        一旦确认说话，把它拼到最前面。
      · 静音尾巴：句子结束时 buffer 里已经攒了 silence_ms 的静音。这部分照原样
        送去识别会浪费算力、还会诱发幻听，所以在 _take 里裁掉。
    """

    def __init__(self, samplerate, block_ms, silence_ms, min_speech_ms, max_speech_ms,
                 rms_threshold, preroll_ms, np,
                 adaptive=True, rms_floor=0.004, noise_multiplier=4.0):
        self.np = np
        self.block = int(samplerate * block_ms / 1000)
        self.silence_blocks = max(1, int(round(silence_ms / block_ms)))
        self.min_blocks = max(1, int(round(min_speech_ms / block_ms)))
        self.max_blocks = max(1, int(round(max_speech_ms / block_ms)))
        self.preroll_blocks = max(0, int(round(preroll_ms / block_ms)))
        self.rms_threshold = rms_threshold
        self.buffer = []
        self.preroll = []
        self.silent_run = 0
        self.speaking = False
        self.voiced = 0          # 本句里"确实超过门槛"的块数（前导缓存不算，见 _take）

        # ── 自适应门槛 ────────────────────────────────────────────────────────
        # 固定阈值为什么不够用：会议室安静时说话声可能只有 0.008（低于阈值 → 整句丢失），
        # 开着空调的教室噪声底可能就有 0.02（高于阈值 → 永远不认为句子结束）。
        # 所以改成"先量环境噪声，再按倍数定门槛"。
        #
        # ⚠️ 第一版写错过，值得记下来：
        #   最初只在"没在说话"的块上更新噪声底 —— 结果噪声一大（0.01 底噪 ≥ 0.01 阈值），
        #   第一块就被判成"在说话"，于是永远进不了"没在说话"的分支，噪声底永远是"未测出"，
        #   自适应彻底失效，整段 66 秒被并成 5 句（只能在 15 秒的强制断句处出字幕）。
        #   这是典型的先有鸡还是先有蛋：要靠静音来校准门槛，又得靠门槛来认出静音。
        # 修法：不管当前判定是什么，**每块都进统计窗口**，用近 10 秒能量的 10 百分位
        #   当作噪声底。它不依赖"已经正确识别出静音"，所以不会卡死。
        # 再加一道安全阀：门槛不允许高到连说话都算静音（否则会一句话都出不来）。
        self.adaptive = adaptive
        self.rms_floor = rms_floor
        self.noise_multiplier = noise_multiplier
        self.window = []                 # 最近所有块的能量（约 10 秒）
        self.noise_window = 100          # block 缺省 100ms → 100 块 = 10 秒
        self.noise_floor = None
        self.peak = None
        self.threshold = rms_threshold
        self.capped = False

    def _refresh_threshold(self):
        """用最近的能量的低分位数估计噪声底，据此定门槛。每块都调用。"""
        if not self.adaptive:
            self.threshold = self.rms_threshold
            return
        if len(self.window) < 20:        # 不足 2 秒不估，免得用开局的一两个块瞎定
            return
        quiet = float(self.np.percentile(self.window, 10))
        loud = float(self.np.percentile(self.window, 90))
        self.noise_floor = quiet
        self.peak = loud
        wanted = max(self.rms_floor, self.noise_multiplier * quiet)
        # 安全阀：门槛最多只能到"比较响的那一档"的一半，否则会把说话也当静音，
        # 结果是一句话都不切出来 —— 那比切得太碎严重得多。
        cap = max(self.rms_floor * 1.5, 0.5 * loud)
        self.capped = wanted > cap
        self.threshold = min(wanted, cap)

    def gate_report(self):
        if not self.adaptive:
            return f"固定阈值 {self.threshold:.4f}"
        if self.noise_floor is None:
            return f"自适应阈值 {self.threshold:.4f}（还没测出噪声底，先用缺省值）"
        note = "，已触发安全阀" if self.capped else ""
        return (f"自适应阈值 {self.threshold:.4f}"
                f"（噪声底 {self.noise_floor:.4f} × {self.noise_multiplier:g}"
                f"，语音档 {self.peak:.4f}{note}）")

    def push(self, block):
        """送入一块音频，返回本次凑齐的所有整句（通常是 0 或 1 个）。"""
        energy = float(self.np.sqrt(self.np.mean(self.np.square(block)))) if block.size else 0.0
        loud = energy >= self.threshold
        out = []

        if loud:
            if not self.speaking:
                self.speaking = True
                self.buffer = list(self.preroll)     # 补上句首之前的一点音频
                self.preroll = []
                self.voiced = 0
            self.silent_run = 0
            self.voiced += 1
            self.buffer.append(block)
        elif self.speaking:
            self.buffer.append(block)
            self.silent_run += 1
            if self.silent_run >= self.silence_blocks:
                utterance = self._take()
                if utterance is not None:
                    out.append(utterance)
        else:
            # 没在说话：维护前导缓存
            if self.preroll_blocks > 0:
                self.preroll.append(block)
                if len(self.preroll) > self.preroll_blocks:
                    self.preroll.pop(0)

        # 每块都进统计窗口，再用它校准下一块的判定门槛（见上面关于"鸡生蛋"的说明）
        if self.adaptive:
            self.window.append(energy)
            if len(self.window) > self.noise_window:
                self.window.pop(0)
            self._refresh_threshold()

        # 一直不停口也要强制断句，否则字幕会永远不出来
        if self.speaking and len(self.buffer) >= self.max_blocks:
            utterance = self._take()
            if utterance is not None:
                out.append(utterance)

        return out

    def _take(self):
        blocks = self.buffer
        tail = self.silent_run
        voiced = self.voiced
        self.buffer = []
        self.silent_run = 0
        self.speaking = False
        self.voiced = 0
        # 注意：判断"够不够长"必须用**真正超过门槛的块数**，不能用 buffer 的总长度。
        # buffer 里还混着前导缓存（句首前那 250ms 环境音），拿它计数的话，一声 0.1 秒的
        # 爆音会被算成 0.35 秒的"一句话"送进识别 —— 白算一次，还容易诱发幻听。
        if voiced < self.min_blocks:
            return None
        if tail > 0:
            blocks = blocks[:len(blocks) - tail]
        return self.np.concatenate(blocks)

    def flush(self):
        """流结束时把剩下的语音交出来。"""
        if self.speaking:
            tail = self.silent_run
            voiced = self.voiced
            blocks = self.buffer[:len(self.buffer) - tail] if tail else self.buffer
            self.buffer = []
            self.speaking = False
            self.silent_run = 0
            self.voiced = 0
            if voiced >= self.min_blocks:
                return self.np.concatenate(blocks)
        self.buffer = []
        self.speaking = False
        self.voiced = 0
        return None


# ── 识别 ─────────────────────────────────────────────────────────────────────

def looks_like_hallucination(text: str) -> bool:
    lowered = text.lower()
    return any(sample in lowered for sample in HALLUCINATION_SAMPLES)


def transcribe(model, audio, language, min_logprob, no_speech_prob):
    """返回 (文字, 是否被丢弃, 丢弃原因)。"""
    segments, _info = model.transcribe(
        audio,
        language=language,
        beam_size=1,            # 同传要快：贪心解码比 beam search 快得多，质量损失可接受
        vad_filter=False,       # 我们已经按能量切好了，不需要再切
        condition_on_previous_text=False,   # 句间独立，避免上一句的错误污染下一句
    )
    kept = []
    dropped = None
    for seg in segments:
        text = seg.text.strip()
        if not text:
            continue
        if getattr(seg, "no_speech_prob", 0.0) > no_speech_prob:
            dropped = f"no_speech_prob={seg.no_speech_prob:.2f}"
            continue
        if getattr(seg, "avg_logprob", 0.0) < min_logprob:
            dropped = f"avg_logprob={seg.avg_logprob:.2f}"
            continue
        if looks_like_hallucination(text):
            dropped = "命中幻听惯用语"
            continue
        kept.append(text)
    return " ".join(kept).strip(), kept == [], dropped


class Stats:
    def __init__(self):
        self.utterances = 0
        self.dropped = 0
        self.audio_seconds = 0.0
        self.transcribe_seconds = 0.0
        self.lags = []

    def add(self, audio_seconds, transcribe_seconds, dropped):
        self.utterances += 1
        self.audio_seconds += audio_seconds
        self.transcribe_seconds += transcribe_seconds
        if dropped:
            self.dropped += 1
        else:
            self.lags.append(transcribe_seconds)

    def report(self, silence_ms, gate=None):
        print("", file=sys.stderr)
        print("─" * 72, file=sys.stderr)
        print("统计", file=sys.stderr)
        print("─" * 72, file=sys.stderr)
        if gate:
            print(f"  语音门槛：{gate}", file=sys.stderr)
        print(f"  语音段数：{self.utterances}（其中被防幻听闸丢弃 {self.dropped} 段）", file=sys.stderr)
        print(f"  语音总时长：{self.audio_seconds:.2f}s", file=sys.stderr)
        print(f"  识别总耗时：{self.transcribe_seconds:.2f}s", file=sys.stderr)
        if self.audio_seconds > 0:
            print(f"  实时率 RTF：{self.transcribe_seconds / self.audio_seconds:.3f}", file=sys.stderr)
        if self.lags:
            average = sum(self.lags) / len(self.lags)
            print(f"  平均识别耗时：{average:.2f}s（每段）", file=sys.stderr)
            print(f"  理论最短延迟：{silence_ms / 1000 + average:.2f}s"
                  f" = 静音判定 {silence_ms / 1000:.2f}s + 识别 {average:.2f}s", file=sys.stderr)
            print("  （还没算翻译耗时；整链延迟要把 leion-pro 的翻译时间加上去）", file=sys.stderr)
        print("─" * 72, file=sys.stderr)


# ── 主流程 ───────────────────────────────────────────────────────────────────

def emit(text: str):
    """一行一句话，立刻 flush：延迟就是同传的命。"""
    clean = " ".join(text.split())
    if clean:
        print(clean, flush=True)


def main():
    args = parse_args()
    need_audio = args.file is None
    np, WhisperModel, sounddevice = load_dependencies(need_audio)

    print(f"[whisper_stream] 加载模型 {args.model}"
          f"（device={args.device}, compute_type={args.compute_type}）…", file=sys.stderr)
    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
    print("[whisper_stream] 模型就绪", file=sys.stderr)

    if args.self_check:
        print("[whisper_stream] --self-check 通过：依赖与模型都能加载", file=sys.stderr)
        return 0

    segmenter = UtteranceSegmenter(
        args.samplerate, args.block_ms, args.silence_ms,
        args.min_speech_ms, args.max_speech_ms, args.rms_threshold, args.preroll_ms, np,
        adaptive=args.adaptive, rms_floor=args.rms_floor, noise_multiplier=args.noise_multiplier,
    )
    stats = Stats()

    # ── 预热 ────────────────────────────────────────────────────────────────
    # 实测：CUDA 上第一次推理要 11.3 秒（cuDNN 选算法、分配显存），之后的句子只要 0.1 秒。
    # 不预热的话，用户说出的第一句话会被卡十几秒 —— 这是同传最不能接受的失败方式。
    # 办法是启动时先拿 1 秒静音跑一遍，把这块固定开销提前付掉。
    if not args.no_warmup:
        warm_start = time.perf_counter()
        silent = np.zeros(args.samplerate, dtype=np.float32)
        try:
            transcribe(model, silent, args.language, args.min_logprob, args.no_speech_prob)
        except Exception as error:      # 预热失败不该让整个程序起不来
            print(f"[whisper_stream] 预热失败（忽略）：{type(error).__name__}: {error}", file=sys.stderr)
        print(f"[whisper_stream] 预热完成：{time.perf_counter() - warm_start:.2f}s"
              f"（这段固定开销如果不提前付，会砸在第一句字幕上）", file=sys.stderr)

    def handle(utterance):
        seconds = len(utterance) / float(args.samplerate)
        start = time.perf_counter()
        text, empty, reason = transcribe(model, utterance, args.language,
                                        args.min_logprob, args.no_speech_prob)
        elapsed = time.perf_counter() - start
        stats.add(seconds, elapsed, empty)   # 每段都记：短段的固定开销正是同传的敌人
        rtf = elapsed / seconds if seconds > 0 else float("nan")
        if empty:
            print(f"  [丢弃 {seconds:.1f}s 音频，{elapsed:.2f}s，RTF {rtf:.2f}：{reason or '没有内容'}]",
                  file=sys.stderr, flush=True)
        else:
            print(f"  [{seconds:.1f}s 音频 / {elapsed:.2f}s 识别 / RTF {rtf:.2f}]",
                  file=sys.stderr, flush=True)
        emit(text)

    if args.file is not None:
        import wave
        with wave.open(args.file, "rb") as wav:
            rate = wav.getframerate()
            if rate != args.samplerate:
                print(f"[whisper_stream] 警告：文件采样率 {rate} ≠ {args.samplerate}，"
                      f"请先用 make_long_wav.py 生成 16k 单声道 wav", file=sys.stderr)
            raw = wav.readframes(wav.getnframes())
        audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        started = time.perf_counter()
        for start in range(0, len(audio), segmenter.block):
            if args.realtime:      # 模拟音频按真实速度到达
                target = started + (start / float(args.samplerate))
                delay = target - time.perf_counter()
                if delay > 0:
                    time.sleep(delay)
            for utterance in segmenter.push(audio[start:start + segmenter.block]):
                handle(utterance)
        last = segmenter.flush()
        if last is not None:
            handle(last)
        if args.stats:
            stats.report(args.silence_ms, segmenter.gate_report())
        return 0

    # 麦克风模式
    audio_queue = queue.Queue()

    def on_audio(indata, _frames, _time, status):
        if status:
            print(f"[whisper_stream] 音频状态：{status}", file=sys.stderr)
        audio_queue.put(indata[:, 0].copy())

    print("[whisper_stream] 开始收音（Ctrl-C 结束）", file=sys.stderr)
    with sounddevice.InputStream(samplerate=args.samplerate, channels=1, dtype="float32",
                                 blocksize=segmenter.block, callback=on_audio):
        try:
            while True:
                block = audio_queue.get()
                for utterance in segmenter.push(block):
                    handle(utterance)
        except KeyboardInterrupt:
            last = segmenter.flush()
            if last is not None:
                handle(last)
            stats.report(args.silence_ms, segmenter.gate_report())
            print("\n[whisper_stream] 已停止", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
