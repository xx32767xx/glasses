#!/usr/bin/env python3
"""
make_long_wav.py —— 把短录音拼长，用来测"真实的"转写速度
========================================================================================
为什么不直接用那条 5.7 秒的录音测速度：
    转写里有很大一块"固定开销"（模型预热、首帧、VAD 扫描），跟音频长短无关。
    5.7 秒的音频里，固定开销占比过高，算出来的 RTF 会被严重高估。
    真正的同传场景是一句接一句连续说，所以要拿一段几十秒的音频来测才准。

这个脚本把 bridge/whisper_transcribe.py 里的解码器复用一遍（同一个 load_audio），
把短音频解码成 PCM 后重复 N 遍，句间插入 1 秒静音（模拟真实说话停顿），
最后写成标准 16-bit PCM 的 wav。

    python bridge/make_long_wav.py <源音频> <目标wav> [--times 10] [--gap 1.0]
"""

import argparse
import sys
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from whisper_transcribe import TARGET_RATE, load_audio   # noqa: E402


def parse_args():
    parser = argparse.ArgumentParser(description="把短录音重复拼接成一段长音频用于测速")
    parser.add_argument("source", help="源音频文件")
    parser.add_argument("target", help="输出的 wav 文件")
    parser.add_argument("--times", type=int, default=10, help="重复几遍（缺省 10）")
    parser.add_argument("--gap", type=float, default=1.0, help="句间静音秒数（缺省 1.0）")
    parser.add_argument("--noise", type=float, default=0.0,
                        help="叠加白噪声的 RMS（缺省 0）。用来模拟真实房间底噪，"
                             "验证自适应门槛能不能跟着环境调整")
    parser.add_argument("--seed", type=int, default=20261004, help="噪声随机种子（保证可复现）")
    return parser.parse_args()


def main():
    args = parse_args()
    source = Path(args.source)
    if not source.is_file():
        sys.exit(f"找不到源音频：{source}")

    audio = load_audio(source)
    one = audio.shape[0] / float(TARGET_RATE)
    gap = np.zeros(int(round(args.gap * TARGET_RATE)), dtype="float32")

    pieces = []
    for index in range(args.times):
        pieces.append(audio)
        if index != args.times - 1:
            pieces.append(gap)
    long_audio = np.concatenate(pieces)

    noise_note = "无"
    if args.noise > 0:
        # 关键：噪声加在**拼接之后**，连静音段也一起加 —— 真实房间里不存在"数字零"的静音。
        # 所以这里必须把噪声铺满整段，否则噪声底会被算成 0，自适应门槛就成了假的自适应。
        rng = np.random.default_rng(args.seed)
        noise = rng.normal(0.0, 1.0, long_audio.shape[0]).astype("float32")
        noise *= args.noise / float(np.sqrt(np.mean(noise ** 2)))     # 归一到指定 RMS
        long_audio = long_audio + noise
        noise_note = f"白噪声 RMS {args.noise}（铺满整段，含静音）"

    target = Path(args.target)
    target.parent.mkdir(parents=True, exist_ok=True)
    pcm = np.clip(long_audio, -1.0, 1.0)
    pcm = (pcm * 32767.0).astype("<i2")
    with wave.open(str(target), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(TARGET_RATE)
        handle.writeframes(pcm.tobytes())

    total = long_audio.shape[0] / float(TARGET_RATE)
    print(f"源音频：{source.name}  {one:.2f}s")
    print(f"拼接 {args.times} 遍，句间静音 {args.gap}s，噪声：{noise_note}")
    print(f"输出：{target}  共 {total:.1f}s（{target.stat().st_size / 1024 / 1024:.1f} MB）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
