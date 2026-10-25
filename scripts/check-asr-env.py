#!/usr/bin/env python3
"""check-asr-env.py —— 在服务器上先跑这个，再决定用哪个模型/精度

它回答五个问题（按顺序，前面失败就不往下走）：
  ① Python 与依赖：faster-whisper / ctranslate2 / numpy 能不能 import
  ② CUDA 运行库：ctranslate2 要的是 **cuBLAS 12 + cuDNN 9（CUDA 12 版）**；
     服务器装的是 CUDA 13 时，这两个 .so 往往不在，会报
     `libcublas.so.12: cannot open shared object file` 或 `cudnn_ops64_9` —— 本脚本会提前指出来
  ③ 这张卡能跑哪些精度：**Pascal（Tesla P40/P100，算力 6.1）没有 FP16 加速**，
     ctranslate2 直接不提供 float16，得用 int8_float32 —— 这一条是本脚本存在的主要理由
  ④ 实测：同一段音频在可用精度档上跑一遍，给出加载/解码耗时与 RTF
  ⑤ 结论：给出可以直接抄进 start-all 的那一行参数

用法（在目标环境里）：
    python scripts/check-asr-env.py                      # 用自带的 3 秒合成音频
    python scripts/check-asr-env.py --audio 某段.wav      # 用真实录音更准
    python scripts/check-asr-env.py --models large-v3,medium
    python scripts/check-asr-env.py --compute int8_float32,int8   # 手动指定要测的精度
"""

import argparse
import os
import shutil
import subprocess
import sys
import time

# 挑"测哪几档"时的优先顺序：能跑 FP16 的卡上 float16 最快；
# 不能跑 FP16 的卡（Pascal）上 int8_float32 最快。顺序即偏好。
COMPUTE_PREFERENCE = ("float16", "int8_float16", "int8_float32", "int8", "float32")

# 算力 → 架构名（只用于把话说得像人话；查不到就只显示数字）
ARCH_BY_CAPABILITY = {
    "5.0": "Maxwell", "5.2": "Maxwell", "5.3": "Maxwell",
    "6.0": "Pascal", "6.1": "Pascal", "6.2": "Pascal",
    "7.0": "Volta", "7.2": "Volta", "7.5": "Turing",
    "8.0": "Ampere", "8.6": "Ampere", "8.7": "Ampere", "8.9": "Ada",
    "9.0": "Hopper", "10.0": "Blackwell", "12.0": "Blackwell",
}


def line(title):
    print(f"\n── {title} " + "─" * max(0, 60 - len(title)))


def arch_of(capability):
    """算力字符串（如 '6.1'）→ 架构名；认不出来就返回空串。"""
    if not capability:
        return ""
    return ARCH_BY_CAPABILITY.get(str(capability).strip(), "")


def has_fp16_acceleration(capability):
    """这张卡有没有 FP16 加速。

    Pascal 及更早（算力 < 7.0）只有 FP16 存储、没有快速矩阵乘，
    ctranslate2 干脆把 float16 从"支持的精度"里去掉；Volta 起才有张量核。
    认不出算力时返回 None（不下结论）。
    """
    try:
        major = int(str(capability).split(".")[0])
    except (ValueError, AttributeError, IndexError):
        return None
    return major >= 7


def pick_compute_candidates(supported, requested=None, limit=2):
    """决定要实测哪几档精度。

    supported:  ctranslate2 报告的"这张卡能跑的精度"；拿不到就给空列表
    requested:  用户显式指定的精度（列表）；给了就只在其中挑能跑的
    limit:      最多测几档（每档都要加载一次模型，慢）

    为什么不能直接照抄文档里的 float16/int8_float16：
    在 P40 这种卡上两档都不支持，于是"自检"会以"一个都没跑起来"结尾，
    看起来像是环境装坏了，其实只是档位不对。
    """
    supported = list(supported or [])
    if not supported:
        # 拿不到支持列表：按用户要求（或默认两档）原样去试，让 ctranslate2 自己报错
        wanted = list(requested) if requested else list(COMPUTE_PREFERENCE[:limit])
        return wanted
    if requested:
        usable = [item for item in requested if item in supported]
        if usable:
            return usable[:limit] if limit else usable
    usable = [item for item in COMPUTE_PREFERENCE if item in supported]
    return (usable[:limit] if limit else usable) or supported[:limit]


def recommend_compute(supported):
    """从"能跑的精度"里挑一个推荐值：能跑 FP16 就 float16，否则 int8_float32。"""
    supported = list(supported or [])
    if not supported:
        return ""
    for candidate in ("float16", "int8_float16", "int8_float32", "int8", "float32"):
        if candidate in supported:
            return candidate
    return supported[0]


def check_python():
    line("① Python 与依赖")
    print(f"  python      {sys.version.split()[0]}（{sys.executable}）")
    ok = True
    for module in ("faster_whisper", "ctranslate2", "numpy"):
        try:
            imported = __import__(module)
            version = getattr(imported, "__version__", "?")
            print(f"  {module:15}{version}")
        except Exception as error:                      # noqa: BLE001
            ok = False
            print(f"  {module:15}✗ 没装上（{type(error).__name__}: {error}）")
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
        nvidia_dir = os.path.join(root, "nvidia")
        if not os.path.isdir(nvidia_dir):
            continue
        for base, _dirs, files in os.walk(nvidia_dir):
            for name in files:
                if pattern in name:
                    found.append(os.path.join(base, name))
    return found


def gpu_info():
    """一次 nvidia-smi，拿到卡名 / 驱动 / 显存 / 算力。拿不到就给空值。"""
    info = {"name": "", "driver": "", "vram_gb": None, "capability": "", "error": ""}
    nvidia_smi = shutil.which("nvidia-smi")
    if not nvidia_smi:
        info["error"] = "没有 nvidia-smi（这台机器可能没装 N 卡驱动）"
        return info
    try:
        done = subprocess.run(
            [nvidia_smi, "--query-gpu=name,driver_version,memory.total,compute_cap",
             "--format=csv,noheader"],
            capture_output=True, text=True, timeout=20,
        )
    except Exception as error:                          # noqa: BLE001
        info["error"] = f"nvidia-smi 调用失败：{error}"
        return info
    if done.returncode != 0:
        info["error"] = (done.stderr or done.stdout).strip()[:200]
        return info
    first = (done.stdout or "").strip().splitlines()
    if first:
        parts = [part.strip() for part in first[0].split(",")]
        info["name"] = parts[0] if parts else ""
        info["driver"] = parts[1] if len(parts) > 1 else ""
        if len(parts) > 2:
            number = parts[2].split()[0] if parts[2] else ""
            try:
                info["vram_gb"] = round(float(number) / 1024, 1)
            except ValueError:
                info["vram_gb"] = None
        info["capability"] = parts[3] if len(parts) > 3 else ""
    return info


def check_cuda_libs(info):
    line("② CUDA 运行库（ctranslate2 要 cuBLAS 12 + cuDNN 9）")
    cublas12 = find_libs("libcublas.so.12")
    cudnn9 = find_libs("libcudnn") + find_libs("libcudnn_ops")
    print(f"  libcublas.so.12   {'✓ ' + cublas12[0] if cublas12 else '✗ 没找到'}")
    print(f"  libcudnn*（cu12） {'✓ 找到 ' + str(len(cudnn9)) + ' 个' if cudnn9 else '✗ 没找到'}")
    if cublas12:
        libdir = os.path.dirname(cublas12[0])
        print(f"  建议把这一串加进 LD_LIBRARY_PATH：\n    export LD_LIBRARY_PATH={libdir}:$LD_LIBRARY_PATH")
    else:
        print("\n  这是 CUDA 13 机器上最常见的坑：系统/环境里只有 cu13 的库，"
              "而 ctranslate2 要 cu12 版的。\n  修法（装到同一个环境里）：\n"
              "    pip install nvidia-cublas-cu12 nvidia-cudnn-cu12==9.*\n"
              "  然后把 .../site-packages/nvidia/*/lib 加进 LD_LIBRARY_PATH（上面提示的那串）。")
    if info.get("error"):
        print(f"  ✗ {info['error']}")
    else:
        vram = f"，显存 {info['vram_gb']} GB" if info.get("vram_gb") else ""
        print(f"  GPU：{info['name']}（驱动 {info['driver']}{vram}）")
    return len(cublas12) > 0


def check_capabilities(info, device):
    """③ 这张卡能跑哪些精度 —— Pascal 没有 FP16 加速，就在这一步说清楚。"""
    line("③ 这张卡能跑哪些精度")
    supported = []
    if device != "cuda":
        print("  （device=cpu，跳过）")
        return supported, ""
    try:
        import ctranslate2
        supported = sorted(ctranslate2.get_supported_compute_types("cuda"))
    except Exception as error:                          # noqa: BLE001
        print(f"  查不到支持的精度：{type(error).__name__}: {error}")
        print("  —— 多半是 ② 的 CUDA 库没解决；先修 ②。")
        return [], ""

    capability = info.get("capability") or ""
    arch = arch_of(capability)
    if capability:
        print(f"  算力       {capability}" + (f"（{arch}）" if arch else ""))
    print(f"  支持的精度 {', '.join(supported) if supported else '（空）'}")

    fp16 = has_fp16_acceleration(capability)
    if fp16 is False:
        print(f"  ⚠️ {arch or '这张卡'}没有 FP16 加速：float16 / int8_float16 用不了，"
              "要用 int8_float32（权重 INT8、激活 FP32）。")
        print("     这是算力决定的，跟驱动、CUDA 版本、装没装 cuDNN 都无关 —— 换库没用，换档位才有用。")
    elif fp16 is True:
        print("  ✓ 有张量核：float16 可用，通常是最快的一档。")

    recommendation = recommend_compute(supported)
    if recommendation:
        print(f"  推荐档位   {recommendation}")
    if info.get("vram_gb"):
        vram = info["vram_gb"]
        if vram >= 20:
            print(f"  显存 {vram} GB：large-v3（float16 约 5 GB / int8 约 3 GB）很宽裕。")
        elif vram >= 7:
            print(f"  显存 {vram} GB：large-v3 能放下；还要腾显存就用 int8 档。")
        else:
            print(f"  显存 {vram} GB：large-v3 有风险，先用 medium 或 int8 档（见 docs/10 §7.6）。")
    return supported, recommendation


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
    line("④ 实测（同一段音频，比较精度档）")
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
    parser.add_argument("--compute", default="",
                        help="要实测的精度，逗号分隔；缺省按这张卡能跑的自动挑两档")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--seconds", type=float, default=3.0)
    args = parser.parse_args()

    print("faster-whisper 环境自检")
    print("（在目标环境里跑：source <venv>/bin/activate 或 conda activate <环境>，再 python scripts/check-asr-env.py）")
    if check_python() is not True:
        return 1

    info = gpu_info()
    check_cuda_libs(info)
    supported, recommendation = check_capabilities(info, args.device)

    audio = load_audio(args.audio) if args.audio else synth_audio(args.seconds)
    if audio is None:
        print("\n✗ numpy 不可用，无法造测试音频")
        return 1

    models = [item.strip() for item in args.models.split(",") if item.strip()]
    requested = [item.strip() for item in args.compute.split(",") if item.strip()] or None
    if not requested and args.device != "cuda":
        # CPU 上没有"卡支持的精度"这回事，别拿 GPU 的默认两档去试
        requested = ["int8", "float32"]
    compute_types = pick_compute_candidates(supported, requested)
    if requested and supported:
        skipped = [item for item in requested if item not in supported]
        if skipped:
            print(f"\n  跳过 {'/'.join(skipped)}：这张卡不支持（能跑的是 {', '.join(supported)}）")
    if compute_types:
        print(f"\n  将实测：{', '.join(compute_types)}")

    results = check_models(models, compute_types, audio, args.device)
    line("⑤ 结论")
    if not results:
        if args.device == "cuda":
            print("  ✗ 一个都没跑起来。先解决 ② 的 CUDA 库问题，或者加 --device cpu 判断是不是显卡环境的事。")
            print("    如果报的是「没有 kernel image / no kernel image is available」，"
                  "那是 ctranslate2 这个 wheel 没编进这张卡的算力内核（见 docs/10 §9.7），换版本而不是修驱动。")
        else:
            print("  ✗ 一个都没跑起来。多半是模型没下下来（看上面的报错是不是 401/超时），"
                  "或 numpy/依赖不全。")
        return 1
    best = min(results, key=lambda item: item["rtf"])
    print("  ✓ 至少有一种组合可用：")
    for item in results:
        print(f"    {item['label']:26} RTF {item['rtf']:.2f}")
    print(f"\n  建议直接抄这一行（最快的一档）：")
    print(f"    node scripts/start-all.mjs --whisper-model {best['label'].split('/')[0]} "
          f"--compute {best['label'].split('/')[1]}")
    if recommendation and best["label"].split("/")[1] != recommendation:
        print(f"  （③ 推荐的是 {recommendation}；上面这行以实测最快为准）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
