#!/usr/bin/env python3
"""
whisper_transcribe.py —— 用 faster-whisper 转写音频文件，并测出真实耗时
========================================================================================
这是"语音识别那一层"的验证工具，也是它变成流水线之前的形态：
给它一个音频文件（m4a / wav / mp3 / opus 都行），它输出文字 + 耗时。

    python bridge/whisper_transcribe.py <音频文件> [选项]

为什么要单独做这个工具
    在把 Whisper 接进同传流水线之前，必须先回答两个问题，而且必须用数字回答：
      1) 转写得对不对？（质量）
      2) 转写要多久？（延迟 —— 同传对延迟比对质量更敏感）
    这两个问题只能用真实录音来答，不能靠猜。

关键指标：实时率 RTF（Real-Time Factor）
    RTF = 转写耗时 ÷ 音频时长
      RTF < 1   比实时快 —— 可以用于同传
      RTF ≈ 1   与实时相当 —— 勉强，每句延迟约等于说话时长
      RTF > 1   比实时慢 —— 做不了实时字幕，得换更小的模型或上 GPU
    这个数字直接决定"本地 Whisper 够不够用"，比任何形容词都有用。

为什么要自己解码音频（load_audio）
    faster-whisper 默认用 PyAV 直接打开音频文件，但 PyAV 19 删掉了
    av.open(metadata_errors=...) 这个参数，而 faster-whisper 1.2.1 还在传它，
    于是 `TypeError: open() got an unexpected keyword argument 'metadata_errors'`。
    我们不降级全局库，而是自己把音频解成 Whisper 要的形状：
        16000 Hz / 单声道 / float32
    然后直接把数组交给 model.transcribe()。
    这样做还有个额外好处：**这正是实时链路要走的形状**。
    真机跑起来时，手机传过来的是原始 PCM，不是 m4a —— 到时候同一段解码代码直接复用。

模型尺寸（-m）
    tiny(39M) / base(74M) / small(244M) / medium(769M) / large-v3(1550M)
    质量与速度成反比。缺省 small 是起点：中葡都够用，CPU 上还能接受。

首次运行会从 HuggingFace 下载模型（small 约 460 MB）。
    如果下载不通（国内常见），用镜像：
        set HF_ENDPOINT=https://hf-mirror.com
    另外：如果当前目录受沙箱限制、不允许删除文件，HuggingFace 的缓存清理会失败，
    这时把缓存放到可写目录：
        set HF_HOME=E:\\GlassesHarness\\var\\cache\\hf
"""

import argparse
import os
import sys
import time
from pathlib import Path

TARGET_RATE = 16000          # Whisper 内部固定按 16 kHz 工作
BYTES_PER_SAMPLE = {1: "u1", 2: "i2", 4: "i4"}


def parse_args():
    parser = argparse.ArgumentParser(description="用 faster-whisper 转写音频文件并测耗时")
    parser.add_argument("audio", help="音频文件路径（m4a / wav / mp3 / opus…）")
    parser.add_argument("-m", "--model", default="small",
                        help="模型尺寸：tiny/base/small/medium/large-v3（缺省 small）")
    parser.add_argument("-d", "--device", default="cpu", help="cpu 或 cuda（缺省 cpu）")
    parser.add_argument("-c", "--compute-type", default="int8",
                        help="int8 / int8_float16 / float16 / float32（缺省 int8，CPU 上最快）")
    parser.add_argument("-l", "--language", default=None,
                        help="固定语种（zh / pt），缺省自动判定")
    parser.add_argument("-b", "--beam-size", type=int, default=1,
                        help="1=贪心（快，同传要这个） / 5=束搜索（准但慢） 缺省 1")
    parser.add_argument("--no-vad", action="store_true",
                        help="不做静音过滤（缺省开着：抑制 Whisper 对静音'编话'的毛病）")
    parser.add_argument("--repeat", type=int, default=1,
                        help="重复转写几次取最快值（测速度时有用，缺省 1）")
    return parser.parse_args()


def human(seconds):
    return f"{seconds:.2f}s"


# ── 解码：把任意音频变成 Whisper 要的 16000 Hz / 单声道 / float32 ────────────────
def _to_mono(samples):
    """多声道 → 单声道（按声道求平均）。samples 形状是 (帧数, 声道数)"""
    import numpy as np
    if samples.ndim == 2 and samples.shape[1] > 1:
        return samples.mean(axis=1)
    return samples.reshape(-1)


def _resample_linear(samples, src_rate, dst_rate):
    """线性插值重采样。够用就行 —— 这是测试工具，不是成品音频链路。"""
    import numpy as np
    if src_rate == dst_rate:
        return samples
    duration = samples.shape[0] / float(src_rate)
    dst_count = int(round(duration * dst_rate))
    if dst_count <= 0:
        return samples[:0]
    src_index = np.linspace(0.0, samples.shape[0] - 1, dst_count)
    return np.interp(src_index, np.arange(samples.shape[0]), samples).astype("float32")


def _load_wav(path):
    """用标准库读 wav —— 不依赖任何第三方库，手机端传 PCM/WAV 时走的就是这条路。"""
    import numpy as np
    import wave

    with wave.open(str(path), "rb") as handle:
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        rate = handle.getframerate()
        frames = handle.getnframes()
        raw = handle.readframes(frames)

    if width not in BYTES_PER_SAMPLE:
        raise ValueError(f"不认识的 wav 采样位宽：{width * 8} bit")

    dtype = np.dtype(BYTES_PER_SAMPLE[width]).newbyteorder("<")
    data = np.frombuffer(raw, dtype=dtype)
    if width == 1:                       # 8 bit wav 是无符号，其余是有符号
        data = (data.astype("float32") - 128.0) / 128.0
    else:
        data = data.astype("float32") / float(2 ** (width * 8 - 1))
    if channels > 1:
        data = data.reshape(-1, channels)
    return _resample_linear(_to_mono(data), rate, TARGET_RATE)


def _frames_of(result):
    """PyAV 19 的 AudioResampler.resample() 返回列表（旧版本返回单帧），两种都兼容。"""
    if result is None:
        return []
    return list(result) if isinstance(result, (list, tuple)) else [result]


def decode_with_av(source, container_format=None):
    """用 PyAV 解码任意音频（文件路径、BytesIO 都行），返回 16k 单声道 float32。

    source 是 file-like 时最好传 container_format（例如 'wav'）—— 从流里嗅探格式不如从
    文件路径可靠。faster-whisper 自己走的就是 PyAV，但它在 PyAV 19 上会炸（见文件头说明），
    所以这里我们直接用它，只做解码这一件事。
    """
    import av
    import numpy as np

    container = av.open(source, format=container_format)
    try:
        stream = container.streams.audio[0]
        resampler = av.audio.resampler.AudioResampler(
            format="fltp", layout="mono", rate=TARGET_RATE)
        chunks = []
        for frame in container.decode(stream):
            for piece in _frames_of(resampler.resample(frame)):
                chunks.append(piece.to_ndarray().reshape(-1))
        for piece in _frames_of(resampler.resample(None)):      # 收尾：把重采样器里剩的吐出来
            chunks.append(piece.to_ndarray().reshape(-1))
    finally:
        container.close()

    if not chunks:
        raise ValueError("解码后没有拿到任何音频帧")
    return np.concatenate(chunks).astype("float32")


def load_audio(path):
    """统一入口：返回 float32 单声道 16000 Hz 数组。path 可以是 str 或 Path。"""
    path = Path(path)
    if path.suffix.lower() == ".wav":
        return _load_wav(path)
    return decode_with_av(path)


def main():
    args = parse_args()
    audio_path = Path(args.audio)
    if not audio_path.is_file():
        sys.exit(f"找不到音频文件：{audio_path}")

    size_kb = audio_path.stat().st_size / 1024
    print(f"音频文件：{audio_path.name}（{size_kb:.1f} KB）")
    print(f"模型下载源：{os.environ.get('HF_ENDPOINT') or 'HuggingFace 官方'}")
    if os.environ.get("HF_HOME"):
        print(f"模型缓存目录：{os.environ['HF_HOME']}")

    try:
        import numpy as np          # noqa: F401  （下面要用）
        from faster_whisper import WhisperModel
    except ImportError as error:
        sys.exit(f"缺少依赖：{error}\n  pip install faster-whisper")

    # ── 解码音频 ────────────────────────────────────────────────────────────
    print("\n解码音频（目标格式：16000 Hz / 单声道 / float32）…")
    decode_start = time.perf_counter()
    try:
        audio = load_audio(audio_path)
    except Exception as error:
        sys.exit(f"解码失败：{type(error).__name__}: {error}")
    decode_seconds = time.perf_counter() - decode_start
    duration_from_pcm = audio.shape[0] / float(TARGET_RATE)
    print(f"解码完成：{human(decode_seconds)}；得到 {audio.shape[0]} 个采样点 "
          f"= {human(duration_from_pcm)} 音频")

    # ── 载入模型（首次会下载）────────────────────────────────────────────────
    print(f"\n载入模型 {args.model}（device={args.device}, compute_type={args.compute_type}）…")
    load_start = time.perf_counter()
    try:
        model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
    except Exception as error:
        sys.exit(f"载入模型失败：{type(error).__name__}: {error}\n"
                 f"  提示：如果是 CUDA 相关错误，改用 -d cpu；\n"
                 f"       如果是下载失败，设 HF_ENDPOINT=https://hf-mirror.com 再试；\n"
                 f"       如果是缓存目录权限问题，设 HF_HOME=<可写目录>。")
    load_seconds = time.perf_counter() - load_start
    print(f"模型载入完成：{human(load_seconds)}（首次含下载，之后走缓存会快很多）")

    # ── 转写（重复多次取最快）───────────────────────────────────────────────
    best = None
    # vad_filter 关掉 Whisper 对静音的"编话"毛病；同传链路上我们自己也会做静音切分
    vad = not args.no_vad
    for attempt in range(1, max(1, args.repeat) + 1):
        print(f"\n第 {attempt} 次转写…")
        start = time.perf_counter()
        try:
            segments, info = model.transcribe(
                audio,                               # 直接喂数组，绕开 PyAV 的版本坑
                language=args.language,
                beam_size=args.beam_size,
                vad_filter=vad,
                condition_on_previous_text=False,    # 句间独立，别让上一句的错误污染下一句
            )
            # faster-whisper 是惰性的：不遍历 segments 就什么都没算，所以计时必须包住这一步
            collected = [(seg.start, seg.end, seg.text.strip(), seg.avg_logprob) for seg in segments]
        except Exception as error:
            sys.exit(f"转写失败：{type(error).__name__}: {error}")
        elapsed = time.perf_counter() - start

        duration = getattr(info, "duration", 0.0) or duration_from_pcm
        rtf = elapsed / duration if duration > 0 else float("nan")
        print(f"  耗时 {human(elapsed)}；音频时长 {human(duration)}；RTF {rtf:.3f}")

        if best is None or elapsed < best["elapsed"]:
            best = {
                "elapsed": elapsed, "duration": duration, "rtf": rtf,
                "segments": collected, "info": info,
            }

    # ── 结果 ────────────────────────────────────────────────────────────────
    info = best["info"]
    print("\n" + "=" * 72)
    print("转写结果")
    print("=" * 72)
    print(f"自动判定语种：{info.language}（置信度 {info.language_probability:.2f}）")
    print(f"音频时长：{human(best['duration'])}")
    print(f"解码耗时：{human(decode_seconds)}")
    print(f"转写耗时：{human(best['elapsed'])}（最快一次）")
    print(f"实时率 RTF：{best['rtf']:.3f}  "
          + ("← 比实时快，可以用于同传" if best["rtf"] < 1 else "← 慢于实时，需要更小的模型或 GPU"))
    print("")
    print("分段：")
    for start_at, end_at, text, logprob in best["segments"]:
        print(f"  [{start_at:6.2f} → {end_at:6.2f}]  置信度 {logprob:+.2f}  {text}")
    print("")
    print("整段文字：")
    print("  " + " ".join(text for _, _, text, _ in best["segments"]).strip())
    print("=" * 72)
    return 0


if __name__ == "__main__":
    sys.exit(main())
