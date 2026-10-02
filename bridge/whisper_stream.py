#!/usr/bin/env python3
"""
whisper_stream.py —— 用 faster-whisper 把麦克风（或一个音频文件）实时转写成逐行文本
========================================================================================
它的 stdout 每一行是一句识别结果，交给 bridge/asr-bridge.mjs 转发到
leion-pro 的 ASR 收件箱：

    python bridge/whisper_stream.py --language pt | node bridge/asr-bridge.mjs --inbox <收件箱>
    node bridge/asr-bridge.mjs --inbox <收件箱> --engine whisper --from pt-BR

⚠️ 未在本机验证：这个脚本需要 pip 安装依赖并下载模型，而开发环境里没有装。
   逻辑本身很短、也很直白，但请把它当作「起点」而不是「已验证的实现」。
   自检方式见文件末尾的 --self-check。

依赖
    pip install faster-whisper sounddevice numpy

用法
    python bridge/whisper_stream.py                      # 麦克风，自动判语种
    python bridge/whisper_stream.py --language pt        # 固定巴西葡语（更准更快）
    python bridge/whisper_stream.py --file audio.wav     # 转写一个文件（不需要麦克风）
    python bridge/whisper_stream.py --self-check         # 只检查依赖与模型能否加载

设计取舍
    · 用「静音切分」而不是流式解码：同传要的是**整句**，半句翻出去毫无意义，而
      faster-whisper 的流式接口对短片段效果差。所以按 RMS 能量切出语音段，每段整句识别。
    · 每识别出一句就 print + flush，绝不缓冲多句 —— 延迟就是同传的命。
    · 句子边界是「静音超过 N 毫秒」，也就是桥那边的 --flush-on-pause-ms 的物理对应物，
      区别只是这里的判断更可靠（有音频能量信息）。
"""

import argparse
import queue
import sys
import time

# ── 参数 ─────────────────────────────────────────────────────────────────────

def parse_args():
    parser = argparse.ArgumentParser(description="faster-whisper 实时转写，逐行输出")
    parser.add_argument("--model", default="small", help="模型大小：tiny/base/small/medium/large-v3（缺省 small）")
    parser.add_argument("--device", default="cpu", help="cpu 或 cuda")
    parser.add_argument("--compute-type", default="int8", help="int8 / int8_float16 / float16 / float32")
    parser.add_argument("--language", default=None, help="固定语种（zh / pt）；缺省自动判定")
    parser.add_argument("--file", default=None, help="转写一个音频文件而不是麦克风")
    parser.add_argument("--samplerate", type=int, default=16000, help="采样率（Whisper 要 16000）")
    parser.add_argument("--block-ms", type=int, default=100, help="每次读取的音频块长度")
    parser.add_argument("--silence-ms", type=int, default=700, help="静音超过这么久就认为一句话结束")
    parser.add_argument("--min-speech-ms", type=int, default=300, help="短于这么久的语音段丢弃（多半是噪声）")
    parser.add_argument("--max-speech-ms", type=int, default=15000, help="单句最长时长，超过就强制切句（防止一直不说停）")
    parser.add_argument("--rms-threshold", type=float, default=0.01, help="判定「有语音」的能量阈值")
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
    而一个能量阈值 + 静音时长在安静的会议场景已经够用，且零额外依赖。
    """

    def __init__(self, samplerate, block_ms, silence_ms, min_speech_ms, max_speech_ms, rms_threshold, np):
        self.np = np
        self.block = int(samplerate * block_ms / 1000)
        self.silence_blocks = max(1, int(silence_ms / block_ms))
        self.min_blocks = max(1, int(min_speech_ms / block_ms))
        self.max_blocks = max(1, int(max_speech_ms / block_ms))
        self.rms_threshold = rms_threshold
        self.buffer = []
        self.silent_run = 0
        self.speaking = False

    def push(self, block):
        """送入一块音频，返回本次凑齐的所有整句（通常是 0 或 1 个）。"""
        energy = float(self.np.sqrt(self.np.mean(self.np.square(block)))) if block.size else 0.0
        loud = energy >= self.rms_threshold
        out = []

        if loud:
            self.speaking = True
            self.silent_run = 0
            self.buffer.append(block)
        elif self.speaking:
            self.buffer.append(block)
            self.silent_run += 1
            if self.silent_run >= self.silence_blocks:
                out.append(self._take())

        # 一直不停口也要强制断句，否则字幕会永远不出来
        if self.speaking and len(self.buffer) >= self.max_blocks:
            out.append(self._take())

        return [x for x in out if x is not None]

    def _take(self):
        blocks = self.buffer
        self.buffer = []
        self.silent_run = 0
        self.speaking = False
        if len(blocks) < self.min_blocks:
            return None
        return self.np.concatenate(blocks)

    def flush(self):
        """流结束时把剩下的语音交出来。"""
        if self.speaking and len(self.buffer) >= self.min_blocks:
            return self._take()
        self.buffer = []
        self.speaking = False
        return None


# ── 主流程 ───────────────────────────────────────────────────────────────────

def emit(text: str):
    """一行一句话，立刻 flush：延迟就是同传的命。"""
    clean = " ".join(text.split())
    if clean:
        print(clean, flush=True)


def transcribe(model, audio, language):
    segments, _info = model.transcribe(
        audio,
        language=language,
        beam_size=1,            # 同传要快：贪心解码比 beam search 快得多，质量损失可接受
        vad_filter=False,       # 我们已经按能量切好了，不需要再切
        condition_on_previous_text=False,   # 句间独立，避免上一句的错误污染下一句
    )
    return " ".join(seg.text.strip() for seg in segments).strip()


def main():
    args = parse_args()
    need_audio = args.file is None
    np, WhisperModel, sounddevice = load_dependencies(need_audio)

    print(f"[whisper_stream] 加载模型 {args.model}（device={args.device}, compute_type={args.compute_type}）…", file=sys.stderr)
    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
    print("[whisper_stream] 模型就绪", file=sys.stderr)

    if args.self_check:
        print("[whisper_stream] --self-check 通过：依赖与模型都能加载", file=sys.stderr)
        return 0

    segmenter = UtteranceSegmenter(
        args.samplerate, args.block_ms, args.silence_ms,
        args.min_speech_ms, args.max_speech_ms, args.rms_threshold, np,
    )

    if args.file is not None:
        # 文件模式：整段读进来按时长分块喂给分段器，模拟实时（方便没有麦克风时验证）
        import wave
        with wave.open(args.file, "rb") as wav:
            if wav.getframerate() != args.samplerate:
                print(f"[whisper_stream] 警告：文件采样率 {wav.getframerate()} ≠ {args.samplerate}，请先重采样", file=sys.stderr)
            raw = wav.readframes(wav.getnframes())
        audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        for start in range(0, len(audio), segmenter.block):
            for utterance in segmenter.push(audio[start:start + segmenter.block]):
                emit(transcribe(model, utterance, args.language))
        last = segmenter.flush()
        if last is not None:
            emit(transcribe(model, last, args.language))
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
                    emit(transcribe(model, utterance, args.language))
        except KeyboardInterrupt:
            last = segmenter.flush()
            if last is not None:
                emit(transcribe(model, last, args.language))
            print("\n[whisper_stream] 已停止", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
