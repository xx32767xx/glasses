#!/usr/bin/env python3
"""check-asr-env.py —— 在服务器上先跑这个，再决定用哪个模型/精度

它回答四个问题（按顺序，前面失败就不往下走）：
  ① Python 与依赖：faster-whisper / ctranslate2 能不能 import
  ② CUDA 运行库：ctranslate2 要的是 **cuBLAS 12 + cuDNN 9（CUDA 12 版）**；
     服务器装的是 CUDA 13 时，这两个 .so 往往不在，会报
     `libcublas.so.12: cannot open shared object file` 或 `cudnn_ops64_9` —— 本脚本会提前指出来
  ③ GPU：能否建 WhisperModel（device=cuda）
  ④ 实测：同一段音频跑 float16 / int8_float16，给出耗时与 RTF，用来选档

用法（在目标 conda 环境里）：
    python scripts/check-asr-env.py                      # 用自带的 3 秒合成音频
    python scripts/check-asr-env.py --audio 某段.wav      # 用真实录音更准
    python scripts/check-asr-env.py --models large-v3,medium
"""

import argparse
import os
import shutil
import subprocess
import sys
import time


def line(title):
    print(f"\n── {title} " + "─" * max(0, 60 - len(title)))


def check_python():
    line("① Python 与依赖")
    print(f"  python      {sys.version.split()[0]}（{sys.executable}）")
    ok = True
    for module in ("faster_whisper", "ctranslate2", "numpy"):
        try:
            imported = __import__(module)
            version = getattr(imported, "__version__", "?")
            print(f"  {module:12}{version}")
        except Exception as error:                      # noqa: BLE001
            ok = False
            print(f"  {module:12}✗ 没装上（{type(error).__name__}: {error}）")
    if not ok:
        print("\n  修法：pip install faster-whisper numpy")
    return ok


def find_libs(pattern):
    """在常见位置找 .so（含 pip 装的 nvidia-* 包里的 lib 目录）。"""
    roots = []
    try:
        import site
        roots.extend(site.getsitepackages())
        user_site = site.getusersitepackages()
        if user_site:
            roots.append(user_site)
    except Exception:                                   # noqa: BLE001
        pass
    roots.append(os.path.dirname(sys.executable) + "/../lib")
    found = []
    for root in roots:
        for base, _dirs, files in os.walk(os.path.join(root, "nvidia")) if os.path.isdir(os.path.join(root, "nvidia")) else []:
            for name in files:
                if pattern in name:
                    found.append(os.path.join(base, name))
    return found


def check_cuda_libs():
    line("② CUDA 运行库（ctranslate2 要 cuBLAS 12 + cuDNN 9）")
    cublas12 = find_libs("libcublas.so.12")
    cudnn9 = find_libs("libcudnn") + find_libs("libcudnn_ops")
    print(f"  libcublas.so.12   {'✓ ' + cublas12[0] if cublas12 else '✗ 没找到'}")
    print(f"  libcudnn*（cu12） {'✓ 找到 ' + str(len(cudnn9)) + ' 个' if cudnn9 else '✗ 没找到'}")
    if cublas12:
        libdir = os.path.dirname(cublas12[0])
        print(f"  建议把这一串加进 LD_LIBRARY_PATH：\n    export LD_LIBRARY_PATH={libdir}:$LD_LIBRARY_PATH")
    else:
        print("\n  这是 CUDA 13 机器上最常见的坑：系统/conda 里只有 cu13 的库，"
              "而 ctranslate2 要 cu12 版的。\n  修法（装到同一个 env 里）：\n"
              "    pip install nvidia-cublas-cu12 nvidia-cudnn-cu12==9.*\n"
              "  然后把 .../site-packages/nvidia/*/lib 加进 LD_LIBRARY_PATH（上面提示的那串）。")
    nvidia_smi = shutil.which("nvidia-smi")
    if nvidia_smi:
        try:
            out = subprocess.run([nvidia_smi, "--query-gpu=name,memory.total,driver_version",
                                  "--format=csv,noheader"], capture_output=True, text=True, timeout=20)
            print(f"  GPU：{out.stdout.strip() or out.stderr.strip()}")
        except Exception as error:                      # noqa: BLE001
            print(f"  nvidia-smi 调用失败：{error}")
    else:
        print("  ✗ 没有 nvidia-smi：这台机器可能没有 N 卡驱动")
    return len(cublas12) > 0


def synth_audio(seconds=3.0, rate=16000):
    """合成一段"像说话"的音频：不是为了识别准，而是为了让编码器真的跑起来。"""
    try:
        import numpy as np
    except Exception:                                   # noqa: BLE001
        return None
    t = np.arange(int(rate * seconds)) / rate
    rng = np.random.default_rng(7)
    # 几个共振峰附近的调制 + 轻微噪声，比纯正弦更接近语音的频谱占用
    wave = 0.25 * np.sin(2 * np.pi * 180 * t) + 0.12 * np.sin(2 * np.pi * 900 * t)
    wave *= (0.6 + 0.4 * np.sin(2 * np.pi * 3 * t))
    return (wave + rng.normal(0, 0.004, wave.size)).astype(np.float32)


def load_audio(path):
    import wave
    with wave.open(path) as handle:
        frames = handle.readframes(handle.getnframes())
    import numpy as np
    audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    return audio


def check_models(models, compute_types, audio, device):
    line("③ 建模型 + ④ 实测（同一段音频，比较精度档）")
    from faster_whisper import WhisperModel
    results = []
    for model_name in models:
        for compute in compute_types:
            label = f"{model_name}/{compute}"
            try:
                t0 = time.perf_counter()
                model = WhisperModel(model_name, device=device, compute_type=compute)
                load_ms = (time.perf_counter() - t0) * 1000
            except Exception as error:                  # noqa: BLE001
                message = str(error).strip().splitlines()[0][:160]
                print(f"  {label:26} ✗ 起不来：{message}")
                continue
            try:
                t0 = time.perf_counter()
                segments = list(model.transcribe(audio, language="zh", beam_size=1)[0])
                elapsed = time.perf_counter() - t0
                text = "".join(segment.text for segment in segments).strip()
                rtf = elapsed / max(len(audio) / 16000, 1e-6)
                results.append({"label": label, "loadMs": load_ms, "seconds": elapsed, "rtf": rtf, "text": text})
                print(f"  {label:26} ✓ 加载 {load_ms:7.0f}ms · 解码 {elapsed * 1000:7.0f}ms · RTF {rtf:.2f}")
            except Exception as error:                  # noqa: BLE001
                print(f"  {label:26} ✗ 解码失败：{str(error).splitlines()[0][:160]}")
            finally:
                del model
                try:
                    import ctranslate2
                    ctranslate2.set_random_seed(0)
                except Exception:                       # noqa: BLE001
                    pass
    if results:
        fastest = min(results, key=lambda item: item["rtf"])
        print(f"\n  最快的是 {fastest['label']}（RTF {fastest['rtf']:.2f}）。")
        print("  注意：RTF 是「解码耗时 / 音频秒数」，越小越好；这段是合成音，"
              "真实语音会更慢一点，但相对关系成立。")
    return results


def main():
    parser = argparse.ArgumentParser(description="服务器上先跑这个：确认 faster-whisper 能不能用 GPU")
    parser.add_argument("--audio", default=None, help="用一段真实 wav 测（16k 单声道）")
    parser.add_argument("--models", default="large-v3,medium")
    parser.add_argument("--compute", default="float16,int8_float16")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--seconds", type=float, default=3.0)
    args = parser.parse_args()

    print("faster-whisper 环境自检")
    print("（在目标 conda 环境里跑：conda activate <你的环境> && python scripts/check-asr-env.py）")
    if check_python() is not True:
        return 1
    check_cuda_libs()

    audio = load_audio(args.audio) if args.audio else synth_audio(args.seconds)
    if audio is None:
        print("\n✗ numpy 不可用，无法造测试音频")
        return 1

    models = [item.strip() for item in args.models.split(",") if item.strip()]
    compute_types = [item.strip() for item in args.compute.split(",") if item.strip()]
    results = check_models(models, compute_types, audio, args.device)
    line("结论")
    if not results:
        print("  ✗ 一个都没跑起来。先解决 ② 的 CUDA 库问题，或者加 --device cpu 看是不是环境问题。")
        return 1
    print("  ✓ 至少有一种组合可用。挑 RTF 能接受、模型尽量大的那个：")
    for item in results:
        print(f"    {item['label']:26} RTF {item['rtf']:.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
