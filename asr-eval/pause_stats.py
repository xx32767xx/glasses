#!/usr/bin/env python3
"""
pause_stats.py —— 从**真实录音**里量停顿分布（用来校准 segment_sim 的时长模型）
========================================================================================
为什么需要它：`asr-eval/segment_sim.py` 里的词长/停顿分布是"量级参考"，
如果那些数和真实录音差一倍，模拟出来的结论就一文不值。所以先用真实录音量出：

  · 语音里**句内**停顿的分布（词间、短语间）—— 这是 silence_ms 会不会误切的上界；
  · 句子之间的停顿（换气/接话）—— 这是"切得开不开"的下界；
  · 语音占空比（有声时长 / 总时长）—— 判断录音是不是"一直在说"。

输入是裸 PCM（16-bit 小端单声道），和产线 `audio/<房间>/<说话人>.pcm` 同一种格式。

用法
    python asr-eval/pause_stats.py var/asr-eval/mic/phone-quiet-0.3m-0.pcm
    python asr-eval/pause_stats.py --glob "var/asr-eval/mic/*.pcm"
"""

import argparse
import sys
from glob import glob
from pathlib import Path

import numpy as np

RATE = 16000
BLOCK_MS = 10


def read_pcm(path, rate=RATE):
    raw = Path(path).read_bytes()
    usable = len(raw) // 2 * 2
    return np.frombuffer(raw[:usable], dtype="<i2").astype(np.float32) / 32768.0, rate


def blocks(audio, rate, block_ms=BLOCK_MS):
    block = max(1, int(rate * block_ms / 1000))
    usable = len(audio) // block * block
    if usable == 0:
        return np.zeros(0, dtype=np.float32), block
    return np.sqrt(np.mean(audio[:usable].reshape(-1, block) ** 2, axis=1)), block


def threshold_of(energies, noise_multiplier=4.0, floor=0.004):
    """和产线同一口径：噪声底（10 百分位）× 倍数，不低于硬下限。"""
    if energies.size < 20:
        return floor
    return max(floor, noise_multiplier * float(np.percentile(energies, 10)))


def runs(energies, threshold, block, rate, min_ms):
    """低于阈值（= 静音）的连续段，返回 [(起点秒, 时长秒)]。"""
    out, start = [], None
    for index, energy in enumerate(energies):
        if energy < threshold:
            if start is None:
                start = index
        elif start is not None:
            length = (index - start) * block / rate
            if length * 1000 >= min_ms:
                out.append((start * block / rate, length))
            start = None
    if start is not None:
        length = (len(energies) - start) * block / rate
        if length * 1000 >= min_ms:
            out.append((start * block / rate, length))
    return out


def report_one(path, min_ms=120):
    audio, rate = read_pcm(path)
    energies, block = blocks(audio, rate)
    if energies.size == 0:
        print(f"{path}: 太短，跳过")
        return None
    threshold = threshold_of(energies)
    gaps = runs(energies, threshold, block, rate, min_ms)
    voiced = float(np.mean(energies >= threshold))
    lengths = np.array([length * 1000 for _at, length in gaps]) if gaps else np.zeros(0)
    seconds = len(audio) / rate
    print(f"\n{path}")
    print(f"  时长 {seconds:.1f}s · 阈值 {threshold:.4f} · 有声占空比 {voiced * 100:.1f}%")
    if lengths.size == 0:
        print("  没有够长的停顿（几乎一直在说）")
        return {"path": str(path), "seconds": seconds, "threshold": threshold,
                "voiced": voiced, "gaps": []}
    buckets = [(120, 250), (250, 400), (400, 600), (600, 800), (800, 1200), (1200, 10 ** 9)]
    for low, high in buckets:
        count = int(np.sum((lengths >= low) & (lengths < high)))
        if count:
            label = f"{low}~{high}ms" if high < 10 ** 8 else f"≥{low}ms"
            print(f"    {label:>12}: {count:>4} 个")
    print(f"  停顿数 {len(lengths)} · 中位 {np.median(lengths):.0f}ms · 最长 {lengths.max():.0f}ms")
    return {"path": str(path), "seconds": seconds, "threshold": threshold,
            "voiced": voiced, "gaps": lengths.tolist()}


def main(argv=None):
    parser = argparse.ArgumentParser(description="从真实录音量停顿分布（校准 segment_sim）")
    parser.add_argument("files", nargs="*", help="裸 PCM 文件（16-bit 单声道 16k）")
    parser.add_argument("--glob", dest="pattern", default=None, help="用通配符批量读，例如 var/asr-eval/mic/*.pcm")
    parser.add_argument("--min-ms", type=int, default=120, help="多长的静音算一个停顿（缺省 120ms）")
    args = parser.parse_args(argv)

    paths = [Path(p) for p in args.files]
    if args.pattern:
        paths.extend(Path(p) for p in sorted(glob(args.pattern)))
    if not paths:
        parser.error("至少给一个文件或 --glob")

    results = []
    for path in paths:
        outcome = report_one(path, args.min_ms)
        if outcome:
            results.append(outcome)
    if len(results) > 1:
        allpauses = np.concatenate([np.array(item["gaps"]) for item in results if item["gaps"]])
        if allpauses.size:
            print("\n==== 全部文件合并 ====")
            print(f"  停顿 {allpauses.size} 个 · 中位 {np.median(allpauses):.0f}ms · "
                  f"p90 {np.percentile(allpauses, 90):.0f}ms · 最长 {allpauses.max():.0f}ms")
            print("  这段时间的分布就是 segment_sim 里句间停顿模型应当对齐的量")
    return 0


if __name__ == "__main__":
    sys.exit(main())
