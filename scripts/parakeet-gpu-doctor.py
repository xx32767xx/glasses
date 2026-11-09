#!/usr/bin/env python3
"""
parakeet-gpu-doctor.py —— 「英语改用 GPU 上的 parakeet（NeMo）」的开工自检
============================================================================

    python scripts/parakeet-gpu-doctor.py                       # 只看环境（不下载模型）
    python scripts/parakeet-gpu-doctor.py --wav var/tmp/en.wav  # 真跑一遍并报耗时/RTF
    python scripts/parakeet-gpu-doctor.py --wav x.wav --runs 5 --model nvidia/parakeet-tdt-0.6b-v2

它按**生产代码路径**验，不是另写一段 demo：
  ① 打印 torch / CUDA / 卡名 / 算力，并在 GPU 上真做一次 fp16 矩阵乘
     （Volta 有张量核、Pascal 没有 —— 这一步就是区分两者的地方）；
  ② import nemo，打印版本（缺它时把安装命令写清楚）；
  ③ 用 `bridge/whisper_stream.py` 里的 `ParakeetEngine` + 一份策略档案
     （runtime=nemo / compute_type=fp16）加载模型、转写一段 16k 单声道 wav，
     重复 N 次取中位数，报 **RTF = 识别耗时 / 音频时长**；
  ④ 打印"下一步怎么切"（策略表 + 热生效命令）。

⚠️ 第一次跑会从 HuggingFace/NeMo 下载模型（约 2.4 GB），耗时与网络相关；
   已经下载过就会走缓存。用 `HF_ENDPOINT=https://hf-mirror.com` 可以走镜像。

⚠️ 这里**不改任何策略表**，只验证"能不能跑、跑多快"。切换见输出的最后一段。
"""

import argparse
import os
import statistics
import sys
import time
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MODEL = "nvidia/parakeet-tdt-0.6b-v2"
SAMPLE_RATE = 16000


def line(title):
    print(f"\n── {title} " + "─" * max(0, 64 - len(title)))


def fail(message, code=2):
    print(f"\n✗ {message}")
    sys.exit(code)


def read_wav_16k(path):
    """读 16k 单声道 16-bit wav → float32 [-1,1]。别的格式直接说清楚，不猜。"""
    try:
        with wave.open(str(path), "rb") as fp:
            channels = fp.getnchannels()
            width = fp.getsampwidth()
            rate = fp.getframerate()
            frames = fp.readframes(fp.getnframes())
    except Exception as error:                       # noqa: BLE001
        fail(f"读不了这个 wav：{type(error).__name__}: {error}")
    if rate != SAMPLE_RATE or channels != 1 or width != 2:
        fail(f"这段音频是 {rate} Hz / {channels} 声道 / {width * 8} bit；"
             f"parakeet 要 {SAMPLE_RATE} Hz / 单声道 / 16 bit。"
             "先转一下：ffmpeg -i in.wav -ar 16000 -ac 1 -sample_fmt s16 out.wav")
    import numpy as np
    audio = np.frombuffer(frames, dtype="<i2").astype("float32") / 32768.0
    if audio.size == 0:
        fail("这段 wav 是空的")
    return audio


def check_torch(device):
    line("① torch / CUDA / 这张卡能不能跑 fp16")
    try:
        import torch
    except Exception as error:                       # noqa: BLE001
        fail(f"import torch 失败：{type(error).__name__}: {error}\n"
             '   装法：pip install "torch"（要与这台机器的 CUDA 12.x 匹配）')
    print(f"  torch        {torch.__version__}")
    print(f"  编译 CUDA    {torch.version.cuda or '（这是 CPU 版 torch，装错了）'}")
    if not torch.cuda.is_available():
        fail("torch 看不到 CUDA 设备。常见原因：装的是 CPU 版 wheel，或驱动/CUDA 版本不匹配。\n"
             "   先 `nvidia-smi` 确认卡在，再按 https://pytorch.org 上 CUDA 12.x 的索引重装。")
    index = torch.cuda.current_device() if device == "cuda" else int(device.split(":")[-1])
    name = torch.cuda.get_device_name(index)
    capability = torch.cuda.get_device_capability(index)
    print(f"  卡名         {name}")
    print(f"  算力         {capability[0]}.{capability[1]}"
          + ("（Volta：有 FP16 张量核，fp16 可以开）" if capability[0] == 7
             else ("（Pascal：没有 FP16 张量核，只能用 fp32）" if capability[0] == 6 else "")))
    try:
        a = torch.randn(1024, 1024, device=device, dtype=torch.float16)
        b = torch.randn(1024, 1024, device=device, dtype=torch.float16)
        c = a @ b
        torch.cuda.synchronize()
        print(f"  fp16 矩阵乘  通过（结果 {tuple(c.shape)}）")
    except Exception as error:                       # noqa: BLE001
        fail(f"GPU 上 fp16 矩阵乘失败：{type(error).__name__}: {error}\n"
             "   这张卡或这个 torch 版本不能跑 fp16 —— 策略里的 compute_type 要改成 fp32。")
    return torch


def check_nemo():
    line("② NeMo")
    try:
        import nemo
        import nemo.collections.asr as nemo_asr
    except Exception as error:                       # noqa: BLE001
        fail(f"import NeMo 失败：{type(error).__name__}: {error}\n"
             '   装法（几个 GB，装完重启服务才用得上）：\n'
             '     pip install -U "nemo_toolkit[asr]"\n'
             '   ⚠️ 装之前先看 torch 版本：NeMo 可能顺手把 torch 升级到不再支持 Volta 的版本。\n'
             '     稳妥做法是把当前 torch 钉住：pip install "nemo_toolkit[asr]" "torch==<当前版本>"')
    version = getattr(nemo, "__version__", "?")
    print(f"  nemo         {version}")
    print(f"  nemo_asr     {getattr(nemo_asr, '__version__', '同 nemo')}")
    return nemo_asr


def run_production_path(wav, model_name, runs, device):
    """按生产代码路径跑：ParakeetEngine + runtime=nemo + fp16。"""
    line("③ 生产路径实测（ParakeetEngine / runtime=nemo）")
    sys.path.insert(0, str(ROOT / "bridge"))
    try:
        import whisper_stream as ws
    except Exception as error:                       # noqa: BLE001
        fail(f"import bridge/whisper_stream.py 失败：{type(error).__name__}: {error}")

    profile = {"engine": "parakeet", "model": model_name,
               "runtime": "nemo", "compute_type": "fp16"}
    engine = ws.ParakeetEngine(None, argparse.Namespace(data_dir=None))

    started = time.time()
    try:
        handle = engine.load(profile, device)
    except Exception as error:                       # noqa: BLE001
        fail(f"加载失败：{type(error).__name__}: {error}")
    load_ms = (time.time() - started) * 1000
    print(f"  模型         {model_name}")
    print(f"  加载          {load_ms / 1000:.1f} s（首次含下载；之后走缓存）")

    audio = read_wav_16k(wav)
    audio_seconds = audio.size / SAMPLE_RATE
    print(f"  音频         {wav}（{audio_seconds:.2f} s）")

    # 预热一次：第一次跑包含 cuDNN 选核与显存分配，不能算进 RTF
    first = engine.transcribe(handle, audio, "en-US", profile)
    if not str(first.get("text") or "").strip() and first.get("reason"):
        print(f"  ⚠️ 第一次就返回原因：{first['reason']}")
        if "NeMo 转写失败" in str(first.get("reason")):
            fail("真跑失败 —— 把上面的原话发出来（这是「能不能用」的判据，不是网络问题）")

    costs = []
    texts = []
    for _ in range(max(1, runs)):
        started = time.time()
        result = engine.transcribe(handle, audio, "en-US", profile)
        costs.append((time.time() - started) * 1000)
        texts.append(str(result.get("text") or ""))

    median = statistics.median(costs)
    print(f"  转写         中位 {median:.0f} ms / 最快 {min(costs):.0f} ms / 最慢 {max(costs):.0f} ms"
          f"（{runs} 次）")
    print(f"  RTF          {median / 1000.0 / audio_seconds:.3f}"
          f"（{'跟上实时' if median / 1000.0 / audio_seconds < 1 else '跟不上实时'}）")
    print(f"  文本         {texts[0][:160] if texts[0] else '（空）'}")
    if len(set(texts)) > 1:
        print("  ⚠️ 多次结果不完全一致（解码带随机性或温度回退）—— 把语音固定下来再比")
    return median, audio_seconds


def main(argv=None):
    parser = argparse.ArgumentParser(description="parakeet GPU（NeMo）开工自检")
    parser.add_argument("--wav", default="", help="16k 单声道 16-bit wav；不给就只检查环境")
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"NeMo 模型名或 .nemo 路径（缺省 {DEFAULT_MODEL}）")
    parser.add_argument("--device", default="cuda", help="cuda / cuda:0 / cpu（缺省 cuda）")
    parser.add_argument("--runs", type=int, default=3, help="转写重复次数（缺省 3，取中位数）")
    args = parser.parse_args(argv)

    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

    print("parakeet GPU 自检（英语本地模型 · NeMo 路线）")
    print(f"仓库         {ROOT}")
    check_torch(args.device)
    check_nemo()

    if args.wav == "":
        line("④ 下一步")
        print("  环境没问题。要量速度就带一段英语 wav 再跑一次：")
        print("    python scripts/parakeet-gpu-doctor.py --wav var/tmp/en-sample.wav")
        print("  服务器上没有英语样本的话，从任意一段 16k 单声道 wav 转一段即可。")
        return 0

    run_production_path(args.wav, args.model, args.runs, args.device)

    line("④ 下一步：把英语切到这条路上（服务端策略表，热生效）")
    print('  ① 先确认策略表里有 en-parakeet-gpu：')
    print("       node scripts/asr-model-switch.mjs --data-dir /var/lib/leion/test")
    print('     （没有就用 merge 加一条：runtime=nemo / model=<上面这个模型名> / compute_type=fp16）')
    print("  ② 切过去（只作用于 en-US，不影响中文/葡语）：")
    print("       node scripts/asr-model-switch.mjs --data-dir /var/lib/leion/test \\")
    print("            --lang en-US --strategy en-parakeet-gpu")
    print("  ③ 下一段英语音频开始就走 GPU；回滚是把 --strategy 换回 en-parakeet")
    return 0


if __name__ == "__main__":
    sys.exit(main())
