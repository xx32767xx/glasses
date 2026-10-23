#!/usr/bin/env python3
"""眼镜收音质量量化：同一内容的信号层 + 任务层指标

回答的问题（老师那句"评价眼镜收音效果"到底怎么变成一个数）：
  ① 信噪比够不够：语音档 vs 噪声底差多少 dB（Whisper 对 SNR 极敏感）
  ② 噪声底有多高、稳不稳（空调/风扇/电路底噪）
  ③ 有效带宽到哪：眼镜是 44.1kHz 采集，但高频可能被滤掉
  ④ 有没有削波、直流偏置、工频哼声、块接缝咔哒
  ⑤ 最终任务指标：同一段话的字错率（CER），以及表内名字的正确率
  ⑥ 与手机麦克风比：上面每一项的差值（这是"收音效果"的落地定义）

用法
    # 单路：只看信号指标（不需要参考文本）
    python asr-eval/mic_eval.py var/asr-eval/mic/glasses-quiet-1m-0.wav

    # A/B：眼镜 vs 手机（同一内容、同一位置，顺序录）
    python asr-eval/mic_eval.py var/asr-eval/mic/glasses-quiet-1m-0.wav ^
        var/asr-eval/mic/phone-quiet-1m-0.wav --ref "亮亮眼镜这条产品线在圣保罗的团队…"

    # 裸 PCM（转发进程落的 audio-in.pcm）要显式给采样率
    python asr-eval/mic_eval.py var/asr-eval/mic/glasses-quiet-1m-0.pcm --rate 44100 --ref "…"

自我检查（不依赖任何录音，验证指标算法本身对不对）
    python asr-eval/mic_eval.py --selftest

⚠️ 口径说明（写进报告时必须带上）：
  · 「语音档」取帧 RMS 的 90 百分位，「噪声底」取 10 百分位 —— 前提是**录音里确实有一段静音**
    （协议要求每次录 3 秒静音），否则噪声底会被说话声抬高，SNR 虚高。
  · 频响是**相对**的（只看形状），不能当绝对声压级用；麦克风绝对灵敏度需要校准信号。
  · CER 用 large-v3 的产线参数（beam 5、无提示词），只反映"这条链路对识别有多友好"，
    不能代替真实会议录音。
"""
import argparse
import json
import pathlib
import sys
import wave

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "var" / "asr-eval" / "reports" / "mic-eval.md"
FRAME_MS = 100
CLIP_LEVEL = 0.999          # |x| 达到这个值就记一次削波


# ── 读音频 ───────────────────────────────────────────────────────────────────

def read_audio(path, rate=None):
    """读 wav 或裸 s16le PCM。返回 (mono float32 [-1,1), 采样率, 原始格式说明)。"""
    path = pathlib.Path(path)
    if path.suffix.lower() == ".wav":
        with wave.open(str(path)) as handle:
            channels = handle.getnchannels()
            width = handle.getsampwidth()
            rate = handle.getframerate()
            data = handle.readframes(handle.getnframes())
        if width != 2:
            raise SystemExit(f"只支持 16-bit PCM：{path}（{width*8}-bit）")
        audio = np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0
        if channels > 1:
            audio = audio.reshape(-1, channels).mean(axis=1)
        return audio, rate, f"wav {channels}ch {width*8}bit"
    if rate is None:
        raise SystemExit(f"裸 PCM 必须给 --rate：{path}")
    audio = np.frombuffer(path.read_bytes(), dtype="<i2").astype(np.float32) / 32768.0
    return audio, rate, "raw s16le mono"


def resample(samples, src, dst=16000):
    if src == dst:
        return samples
    count = int(round(len(samples) * dst / src))
    positions = np.linspace(0, len(samples) - 1, count)
    return np.interp(positions, np.arange(len(samples)), samples).astype(np.float32)


# ── 信号层指标 ───────────────────────────────────────────────────────────────

def frame_rms(audio, rate, frame_ms=FRAME_MS):
    frame = max(1, int(rate * frame_ms / 1000))
    count = len(audio) // frame
    if count == 0:
        return np.zeros(1, dtype=np.float32)
    return np.sqrt((audio[: count * frame].reshape(count, frame) ** 2).mean(axis=1))


def si_snr_like(audio, rate):
    """语音档 / 噪声底 → 近似信噪比（dB）。

    用分位数而不是"挑静音段"：分位数对"静音占多长"不敏感，
    但**必须**保证录音里有静音（协议要求 3 秒），否则噪声底会被说话声抬高。
    """
    rms = frame_rms(audio, rate)
    noise = float(np.percentile(rms, 10))
    speech = float(np.percentile(rms, 90))
    ratio = 20 * np.log10(max(speech, 1e-9) / max(noise, 1e-9))
    return {"noise": noise, "speech": speech, "snrDb": round(float(ratio), 1)}


def ltas(audio, rate, bands=("100", "250", "500", "1k", "2k", "4k", "6k", "8k", "12k", "16k")):
    """长时平均谱：各频带相对总能量的占比（%），用来和另一路比"形状"。"""
    size = 1024
    if len(audio) < size:
        return {}
    window = np.hanning(size)
    step = size // 2
    frames = 1 + (len(audio) - size) // step
    spectrum = np.zeros(size // 2 + 1)
    for index in range(frames):
        chunk = audio[index * step: index * step + size] * window
        spectrum += np.abs(np.fft.rfft(chunk)) ** 2
    freqs = np.fft.rfftfreq(size, 1 / rate)
    total = spectrum.sum() or 1e-12
    edges = [float(band.replace("k", "000")) for band in bands]
    out = {}
    for index, low in enumerate(edges):
        high = edges[index + 1] if index + 1 < len(edges) else rate / 2
        mask = (freqs >= low) & (freqs < high)
        out[bands[index]] = round(float(spectrum[mask].sum() / total * 100), 2)
    out["_above4k"] = round(float(spectrum[freqs >= 4000].sum() / total * 100), 2)
    out["_above8k"] = round(float(spectrum[freqs >= 8000].sum() / total * 100), 2)
    return out


def hum_level(audio, rate):
    """工频哼声：50/60 Hz 附近能量 vs 相邻频带。> 1 说明有明显的电源干扰。"""
    if len(audio) < 4096:
        return {}
    spectrum = np.abs(np.fft.rfft(audio[: 1 << 16] * np.hanning(min(len(audio), 1 << 16)))) ** 2
    freqs = np.fft.rfftfreq(min(len(audio), 1 << 16), 1 / rate)
    out = {}
    for main in (50, 60):
        target = ((freqs >= main - 2) & (freqs <= main + 2)).sum()
        near = ((freqs >= main - 20) & (freqs <= main + 20)).sum() - target
        peak = spectrum[(freqs >= main - 2) & (freqs <= main + 2)].sum() / max(target, 1)
        flank = spectrum[(freqs >= main - 20) & (freqs <= main + 20)].sum() / max(near, 1)
        out[f"{main}Hz"] = round(float(peak / max(flank, 1e-12)), 2)
    return out


def block_clicks(audio, rate, block_ms=1000):
    """块接缝咔哒：每 block_ms 边界处的样本跳变，比局部平均跳变高出多少倍。

    为什么值得测：43.1k→16k 的重采样、以及"每秒一块"的上传切块都可能留接缝，
    表现为周期性"咔"。这类噪声在 CER 上不一定马上显现，但很烦人。
    """
    block = int(rate * block_ms / 1000)
    if len(audio) < 3 * block:
        return {"ratio": None, "count": 0}
    diff = np.abs(np.diff(audio))
    average = float(diff.mean()) or 1e-9
    hits = 0
    for at in range(block, len(audio) - 1, block):
        local = float(diff[max(0, at - 200): at + 200].max())
        if local > 6 * average:
            hits += 1
    return {"ratio": round(float(hits / max(len(audio) // block, 1)), 2), "count": hits}


def clipping(audio):
    return round(float((np.abs(audio) >= CLIP_LEVEL).mean() * 100), 4)


def dc_offset(audio):
    return round(float(np.mean(audio)), 6)


def silence_stability(audio, rate):
    """静音段的电平抖动（相对标准差）——AGC 抖动或底噪不稳会表现为这个值偏大。"""
    rms = frame_rms(audio, rate)
    quiet = rms[rms <= np.percentile(rms, 20)]
    if quiet.size < 3 or quiet.mean() <= 0:
        return None
    return round(float(quiet.std() / quiet.mean()), 3)


# ── 任务层指标 ───────────────────────────────────────────────────────────────

NAMES = ["亮亮视野", "亮亮眼镜", "Leion Pro", "高通", "骁龙", "安卓", "圣保罗"]


def cer(reference, hypothesis):
    """字级编辑距离 / 参考字数（去标点）。"""
    strip = lambda text: "".join(ch for ch in text if ch not in "，。！？；：、,.!?;: \t\u3000「」《》()（）-—…")
    ref, hyp = strip(reference), strip(hypothesis)
    if not ref:
        return None
    previous = list(range(len(hyp) + 1))
    for i, char_a in enumerate(ref, 1):
        current = [i]
        for j, char_b in enumerate(hyp, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (char_a != char_b)))
        previous = current
    return round(previous[-1] / len(ref), 4)


def recognize(audio, rate, model, prompt=None):
    from faster_whisper import WhisperModel  # noqa: F401  (类型提示用)
    samples = resample(audio, rate, 16000)
    segments, _ = model.transcribe(samples, language="zh", beam_size=5, initial_prompt=prompt,
                                   condition_on_previous_text=False, vad_filter=False)
    return "".join(segment.text for segment in list(segments)).strip()


# ── 自我检查 ─────────────────────────────────────────────────────────────────

def selftest():
    """用合成信号验证指标算法本身：已知 SNR、已知削波、已知直流、已知带宽。"""
    rate = 16000
    seconds = 6
    t = np.arange(rate * seconds) / rate
    rng = np.random.default_rng(7)
    tone = 0.2 * np.sin(2 * np.pi * 440 * t)
    tone[rate: 2 * rate] = 0.0          # 1 秒静音（供噪声底用）
    tone[3 * rate: 4 * rate] = 0.0
    noise = rng.normal(0, 0.002, tone.size)   # SNR ≈ 20log10(0.1414/0.002) ≈ 37 dB
    signal = tone + noise
    checks = []

    def check(name, ok, detail):
        checks.append((name, bool(ok), detail))

    stats = si_snr_like(signal, rate)
    check("SNR 落在 30~45 dB（合成值约 37 dB）", 30 <= stats["snrDb"] <= 45, stats["snrDb"])
    check("噪声底接近真实噪声 0.002", abs(stats["noise"] - 0.002) < 0.001, stats["noise"])
    check("削波率检出为 0", clipping(signal) == 0, clipping(signal))

    clipped = np.clip(signal * 8, -1, 1)
    check("人为削波后削波率 > 0", clipping(clipped) > 0, clipping(clipped))
    check("直流偏置能检出", abs(dc_offset(signal + 0.05) - 0.05) < 1e-3, dc_offset(signal + 0.05))

    spectrum = ltas(signal, rate)
    check("440 Hz 能量集中在 250–1k 带", spectrum["250"] + spectrum["500"] > 60,
          f"250={spectrum['250']} 500={spectrum['500']}")

    quiet = np.zeros(rate * 2, dtype=np.float32) + rng.normal(0, 0.0005, rate * 2)
    check("纯噪声段不报削波", clipping(quiet) == 0, clipping(quiet))

    fails = [item for item in checks if not item[1]]
    print("自我检查：")
    for name, ok, detail in checks:
        print(f"  {'✅' if ok else '❌'} {name}  → {detail}")
    print(f"\n{'全部通过' if not fails else f'{len(fails)} 项失败'}")
    return 0 if not fails else 1


# ── 主流程 ───────────────────────────────────────────────────────────────────

def analyse(path, rate, label, reference, model, prompt):
    audio, rate, fmt = read_audio(path, rate)
    stats = si_snr_like(audio, rate)
    row = {"label": label, "file": str(path), "format": fmt, "rate": rate,
           "seconds": round(len(audio) / rate, 2),
           "peak": round(float(np.abs(audio).max()), 4),
           **stats,
           "clippingPercent": clipping(audio),
           "dcOffset": dc_offset(audio),
           "silenceJitter": silence_stability(audio, rate),
           "clicks": block_clicks(audio, rate),
           "hum": hum_level(audio, rate),
           "ltas": ltas(audio, rate)}
    if reference:
        text = recognize(audio, rate, model, prompt)
        row["text"] = text
        row["cer"] = cer(reference, text)
        row["namesHit"] = sum(1 for name in NAMES if name in text)
        row["namesExpected"] = sum(1 for name in NAMES if name in reference)
    return row


def main():
    parser = argparse.ArgumentParser(description="眼镜收音质量量化（信号层 + 任务层）")
    parser.add_argument("files", nargs="*", help="音频文件（wav 或裸 s16le PCM）")
    parser.add_argument("--rate", type=int, default=None, help="裸 PCM 的采样率")
    parser.add_argument("--labels", default=None, help="逗号分隔的标签，缺省用文件名")
    parser.add_argument("--ref", default=None, help="参考文本（给了才算 CER）")
    parser.add_argument("--refs", default=None, help="逗号分隔的多段参考，与 files 一一对应")
    parser.add_argument("--prompt", default=None, help="给识别器的提示词（默认不给）")
    parser.add_argument("--model", default="large-v3")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--compute-type", default="float16")
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()

    if args.selftest:
        return selftest()
    if not args.files:
        parser.error("要么给音频文件，要么 --selftest")

    labels = args.labels.split(",") if args.labels else [pathlib.Path(f).stem for f in args.files]
    refs = args.refs.split("|") if args.refs else [args.ref] * len(args.files)
    # 长度不一致时必须报错：zip 会静默截断，结果表看起来"只测了一个文件"，
    # 而这种"少了一列"的错误最容易在写报告时才被发现。
    if len(labels) != len(args.files):
        parser.error(f"--labels 给了 {len(labels)} 个，但有 {len(args.files)} 个文件")
    if len(refs) != len(args.files):
        parser.error(f"--refs 给了 {len(refs)} 段，但有 {len(args.files)} 个文件（用 | 分隔）")
    labels = [label.replace("|", "/") for label in labels]

    model = None
    if any(refs):
        from faster_whisper import WhisperModel
        model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
        model.transcribe(np.zeros(16000, dtype=np.float32), language="zh", beam_size=5)

    rows = [analyse(path, args.rate, label, ref, model, args.prompt)
            for path, label, ref in zip(args.files, labels, refs)]

    lines = ["# 眼镜收音质量量化", "",
             "| 指标 | " + " | ".join(row["label"] for row in rows) + " |",
             "|---" * (len(rows) + 1) + "|"]
    fields = [("时长（秒）", "seconds"), ("采样率", "rate"), ("峰值", "peak"),
              ("语音档 RMS", "speech"), ("噪声底 RMS", "noise"), ("信噪比（dB）", "snrDb"),
              ("削波（%）", "clippingPercent"), ("直流偏置", "dcOffset"),
              ("静音抖动", "silenceJitter"), ("块接缝咔哒率", "clicks")]
    for title, key in fields:
        cells = []
        for row in rows:
            value = row.get(key)
            if isinstance(value, dict):
                value = value.get("ratio")
            cells.append("—" if value is None else str(value))
        lines.append(f"| {title} | " + " | ".join(cells) + " |")

    lines += ["", "## 频响（各频带占总能量 %）", "",
              "| 频带 | " + " | ".join(row["label"] for row in rows) + " |",
              "|---" * (len(rows) + 1) + "|"]
    for band in ("100", "250", "500", "1k", "2k", "4k", "6k", "8k", "12k", "16k", "_above4k", "_above8k"):
        cells = [str(row["ltas"].get(band, "—")) for row in rows]
        lines.append(f"| {band} | " + " | ".join(cells) + " |")

    lines += ["", "## 工频哼声（50/60Hz 峰值 / 附近底噪，>1 才有干扰）", "",
              "| 频率 | " + " | ".join(row["label"] for row in rows) + " |",
              "|---" * (len(rows) + 1) + "|"]
    for band in ("50Hz", "60Hz"):
        lines.append(f"| {band} | " + " | ".join(str(row["hum"].get(band, "—")) for row in rows) + " |")

    if any(row.get("cer") is not None for row in rows):
        lines += ["", "## 任务层", "",
                  "| 项目 | " + " | ".join(row["label"] for row in rows) + " |",
                  "|---" * (len(rows) + 1) + "|",
                  "| 字错率（CER） | " + " | ".join(str(row.get("cer", "—")) for row in rows) + " |",
                  "| 表内名字命中/应出现 | " + " | ".join(
                      f"{row.get('namesHit', '—')}/{row.get('namesExpected', '—')}" for row in rows) + " |",
                  "| 识别文本 | " + " | ".join((row.get("text") or "—") for row in rows) + " |"]

    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    (out.with_suffix(".json")).write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\n".join(lines))
    print(f"\n已写出：{out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
