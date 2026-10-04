#!/usr/bin/env python3
"""
asr_eval.py —— 用带标准答案的葡语音频，测出"识别得准不准"
========================================================================================
中文那边我们靠耳朵就能判断对不对，葡语不行 —— 用户不会葡语，我也不能靠"看着像"下结论。
所以这里换一种做法：**用带参考文本的公开数据集，算词错率 WER**。

数据来源
    Google FLEURS 的巴西葡语（pt_br）验证集，CC-BY-4.0。
    FLEURS 是"朗读"语音：每条都是一个人念一句书面语，附官方参考文本。
    在 HuggingFace 上以 parquet 形式提供（音频以字节内嵌，一个文件装完整个 split）。

    https://huggingface.co/datasets/google/fleurs

    ⚠️ 必须说清楚：这是**朗读**语音，不是"会议室里真人对话"。
       朗读更清晰、更慢、没有抢话和背景人声，所以这里的 WER 是**乐观下界**，
       真实会议只会更差。但"乐观下界都很差"本身就足以否掉一个模型。

关键指标 WER（Word Error Rate，词错率）
    WER = (替换 + 删除 + 插入) / 参考词数
      0%      完全正确
      <10%    很好，用于字幕基本不影响理解
      10-20%  可用，但需要靠上下文/翻译模型兜一下
      >30%    不可用 —— 错误多到会改变句子意思
    数字可能超过 100%（插入太多时），那不是 bug。

用法
    # 第一步：把 parquet 里的音频抽成一小批 wav + 参考文本（只做一次）
    python bridge/asr_eval.py --parquet var/cache/fleurs/pt_br_validation.parquet --extract

    # 第二步：拿抽出来的这批音频测某个模型
    python bridge/asr_eval.py --set var/audio/pt-eval --model small --device cuda --compute-type float16
"""

import argparse
import io
import json
import re
import sys
import time
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from whisper_transcribe import TARGET_RATE, decode_with_av   # noqa: E402


def parse_args():
    parser = argparse.ArgumentParser(description="用带参考文本的葡语音频测 WER 与延迟")
    parser.add_argument("--parquet", help="FLEURS parquet 文件（--extract 时用）")
    parser.add_argument("--set", dest="wavset", help="抽好的测试集目录（测 WER 时用）")
    parser.add_argument("--out", default=None, help="抽取到哪里，缺省 <parquet 同目录>/pt")
    parser.add_argument("--count", type=int, default=30, help="抽/测多少条（缺省 30）")
    parser.add_argument("--extract", action="store_true", help="只抽取音频与参考文本，不跑模型")
    parser.add_argument("--model", default="small")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--language", default="pt")
    parser.add_argument("--show", type=int, default=5, help="打印前几条对照（缺省 5）")
    return parser.parse_args()


# ── WER ──────────────────────────────────────────────────────────────────────

def normalize(text):
    """比较前先归一：小写、去标点、合并空白。重音符号保留 —— 葡语的重音是有意义的。"""
    text = text.lower().replace("’", "'")
    text = re.sub(r"[^\w\s']", " ", text, flags=re.UNICODE)
    return " ".join(text.split())


def wer(reference, hypothesis):
    """词错率。用滚动数组做编辑距离，避免长句吃内存。"""
    ref = normalize(reference).split()
    hyp = normalize(hypothesis).split()
    if not ref:
        return float("nan"), 0, 0, 0, 0
    previous = list(range(len(hyp) + 1))
    for i, ref_word in enumerate(ref, start=1):
        current = [i] + [0] * len(hyp)
        for j, hyp_word in enumerate(hyp, start=1):
            cost = 0 if ref_word == hyp_word else 1
            current[j] = min(previous[j] + 1,          # 删除
                             current[j - 1] + 1,       # 插入
                             previous[j - 1] + cost)   # 替换 / 正确
        previous = current
    distance = previous[len(hyp)]
    return distance / len(ref), len(ref), distance, len(ref), len(hyp)


# ── 抽取测试集 ───────────────────────────────────────────────────────────────

def load_wav_bytes(data):
    """parquet 里内嵌的是 wav 字节。

    注意：FLEURS 的 wav 是 **32-bit 浮点**（wFormatTag=3），标准库的 wave 模块读不了 ——
    所以这里交给 PyAV 解码，而不是自己解析 RIFF 头。
    """
    return decode_with_av(io.BytesIO(data), container_format="wav")


def extract(args):
    import pyarrow.parquet as pq

    source = Path(args.parquet)
    if not source.is_file():
        sys.exit(f"找不到 parquet：{source}")
    target = Path(args.out) if args.out else source.parent / "pt"
    target.mkdir(parents=True, exist_ok=True)

    table = pq.read_table(source, columns=["audio", "raw_transcription", "transcription", "gender"])
    rows = table.to_pylist()[: args.count]
    manifest = []
    for index, row in enumerate(rows):
        samples = load_wav_bytes(row["audio"]["bytes"])
        name = f"pt-{index:03d}.wav"
        pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2")
        with wave.open(str(target / name), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(TARGET_RATE)
            handle.writeframes(pcm.tobytes())
        manifest.append({
            "file": name,
            "seconds": round(len(samples) / TARGET_RATE, 2),
            "reference": row["raw_transcription"],
        })

    with open(target / "manifest.jsonl", "w", encoding="utf-8") as handle:
        for item in manifest:
            handle.write(json.dumps(item, ensure_ascii=False) + "\n")

    total = sum(item["seconds"] for item in manifest)
    print(f"抽出 {len(manifest)} 条，共 {total:.1f} 秒 → {target}")
    print(f"参考文本写在 {target / 'manifest.jsonl'}")
    print("")
    for item in manifest[:5]:
        print(f"  [{item['seconds']:5.2f}s] {item['reference'][:88]}")
    return 0


# ── 评测 ─────────────────────────────────────────────────────────────────────

def read_manifest(wavset):
    path = Path(wavset)
    manifest = Path(wavset) / "manifest.jsonl"
    if not manifest.is_file():
        sys.exit(f"没找到 {manifest}（先用 --extract 抽一批）")
    items = []
    for line in manifest.read_text(encoding="utf-8").splitlines():
        if line.strip():
            items.append(json.loads(line))
    return path, items


def main():
    args = parse_args()
    if args.extract:
        if not args.parquet:
            sys.exit("--extract 需要 --parquet <文件>")
        return extract(args)

    if not args.wavset:
        sys.exit("测 WER 需要 --set <测试集目录>（先用 --extract 抽一批）")

    wavset, items = read_manifest(args.wavset)
    print(f"测试集：{wavset}（{len(items)} 条）")

    from faster_whisper import WhisperModel

    print(f"载入模型 {args.model}（device={args.device}, compute_type={args.compute_type}）…")
    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)

    # 先预热：CUDA 上第一次推理要十几秒，混进统计会污染第一个样本（见 docs/04）
    warm_start = time.perf_counter()
    list(model.transcribe(np.zeros(TARGET_RATE, dtype=np.float32), language=args.language)[0])
    print(f"预热完成：{time.perf_counter() - warm_start:.2f}s")

    rows = []
    for item in items:
        sys.stdout.write(".")
        sys.stdout.flush()
        _, samples = None, None
        audio = _read_wav(wavset / item["file"])
        start = time.perf_counter()
        segments, info = model.transcribe(
            audio, language=args.language, beam_size=1,
            vad_filter=True, condition_on_previous_text=False,
        )
        text = " ".join(seg.text.strip() for seg in segments).strip()
        elapsed = time.perf_counter() - start
        score, words, _, _, _ = wer(item["reference"], text)
        rows.append({
            "file": item["file"],
            "seconds": item["seconds"],
            "reference": item["reference"],
            "hypothesis": text,
            "wer": score,
            "words": words,
            "seconds_used": elapsed,
            "detected": getattr(info, "language", "?"),
            "detected_prob": getattr(info, "language_probability", 0.0),
        })
    print("")

    scored = [r for r in rows if r["words"] > 0 and not np.isnan(r["wer"])]
    total_words = sum(r["words"] for r in scored)
    weighted_wer = sum(r["wer"] * r["words"] for r in scored) / total_words if total_words else float("nan")
    audio_seconds = sum(r["seconds"] for r in rows)
    used_seconds = sum(r["seconds_used"] for r in rows)
    detections = {}
    for r in rows:
        detections[r["detected"]] = detections.get(r["detected"], 0) + 1

    print("=" * 76)
    print(f"结果 · 模型 {args.model} / {args.device} / {args.compute_type}")
    print("=" * 76)
    print(f"  样本数        {len(rows)} 条（葡语朗读语音）")
    print(f"  语种判定      {detections}（期望全部是 pt）")
    print(f"  加权词错率    {weighted_wer * 100:.1f}%   ← 按句子长度加权，反映整体")
    print(f"  按句平均      {np.mean([r['wer'] for r in scored]) * 100:.1f}%")
    good = sum(1 for r in scored if r["wer"] <= 0.10)
    print(f"  完全/近乎正确 {good}/{len(scored)} 句的 WER ≤ 10%")
    print(f"  音频总时长    {audio_seconds:.1f}s")
    print(f"  识别总耗时    {used_seconds:.1f}s（RTF {used_seconds / audio_seconds:.3f}）")
    print(f"  每句识别      {used_seconds / len(rows):.2f}s（含静音过滤）")
    print("")
    print(f"  随机看 {min(args.show, len(rows))} 条对照：")
    for row in rows[: args.show]:
        print(f"    参考  {row['reference']}")
        print(f"    识别  {row['hypothesis']}")
        print(f"    WER {row['wer'] * 100:5.1f}%   [{row['seconds']:.2f}s 音频 / {row['seconds_used']:.2f}s]")
        print("")
    print("=" * 76)
    return 0


def _read_wav(path):
    with wave.open(str(path), "rb") as handle:
        raw = handle.readframes(handle.getnframes())
    return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0


if __name__ == "__main__":
    sys.exit(main())
