#!/usr/bin/env python3
"""
tts-doctor.py —— 「在服务器上自己合成语音（巴葡 / 中文 / 英文）」的开工自检
============================================================================

    python scripts/tts-doctor.py                        # 只看环境+音色文件（不合成、不改任何东西）
    python scripts/tts-doctor.py --list-voices           # 打印已知音色与应有的文件路径
    python scripts/tts-doctor.py --selftest              # 只跑纯函数自检（不需要任何引擎）
    python scripts/tts-doctor.py --engine piper          # 真合成 3 句巴葡，量耗时/RTF/体积
    python scripts/tts-doctor.py --engine piper --lang zh-CN --voice zh_CN-huayan-medium
    python scripts/tts-doctor.py --engine piper --text "Bom dia a todos." --runs 5 --out var/tmp/pt.wav

为什么要这个脚本：手机系统的 TTS 能不能念某种语言，取决于**那台手机装了哪些语音包**，
而实测巴葡没有（巴西葡语在国内机型基本不带）。于是想在**自己的服务器**上合成
（不接云端 API：音频不出内网、不按句计费、没有 Key 要管）。这个脚本回答三个问题：

  ① 这台机器上装了哪个 TTS 包？（piper / kokoro / coqui，三者 API 完全不同）
  ② 巴葡音色的文件在不在？路径对不对？
  ③ 合成一句真话要多久？音频多长、多大？RTF 是多少？—— 给数字，不拍脑袋。

⚠️ 本脚本**只读**：不 pip install、不改配置、不动策略表。装什么、怎么装由你决定。

⚠️ 装包会互相牵连：`kokoro` / `coqui-tts` 都依赖 torch，而 pip 顺手升级 torch 会踩上次那个坑
   （装完 torch 变 `+cu130`，驱动 550 只到 CUDA 12.4，`torch.cuda.is_available()` 直接 False）。
   `piper-tts` 走 ONNX Runtime，**完全不碰 torch** —— 这也是先推荐它的原因。

⚠️ 许可：XTTS-v2（coqui）的权重是 **CPML，非商用**；piper 运行时 GPL-3.0、模型 MIT；
   kokoro 是 Apache-2.0。商用产品选谁，这一条就得先想清楚。
"""

import argparse
import array
import math
import os
import shutil
import statistics
import sys
import tempfile
import time
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MODELS_DIR = os.environ.get("LEION_TTS_MODELS") or "/opt/leion/models/piper"

# Windows 控制台是 GBK：不显式改成 UTF-8 的话，中文与 ✓/✗ 会让脚本自己在 print 上崩掉
# （这跟当初 Java 的 TtsChunkerCheck 踩的是同一个坑）。Linux 上这行是无害的。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:                                 # noqa: BLE001
        pass
del _stream

# 已知音色：只用来说明"该有哪些文件、多大、什么语言"，不联网。
# 音色清单来自 rhasspy/piper-voices（pt_BR 目前主要是 faber 与 edresson 两个）。
KNOWN_VOICES = {
    "pt_BR-faber-medium": {"lang": "pt-BR", "rate": 22050, "mb": 63,
                           "note": "巴葡（巴西）男声，社区里最常用的 pt_BR 音色"},
    "pt_BR-edresson-low": {"lang": "pt-BR", "rate": 16000, "mb": 20,
                           "note": "巴葡兜底音色：体积小、音质明显差一档"},
    "en_US-lessac-medium": {"lang": "en-US", "rate": 22050, "mb": 63,
                            "note": "英语（美国）女声"},
    "zh_CN-huayan-medium": {"lang": "zh-CN", "rate": 22050, "mb": 63,
                            "note": "中文女声（如果手机本地中文够用，其实不必走服务器）"},
}

# 验证用句子：全部取自真实会议里会出现的话，不是朗读材料。
SAMPLES = {
    "pt-BR": [
        "Bom dia a todos, vamos começar a reunião às três da tarde.",
        "O mercado esperava um corte de zero vírgula vinte e cinco pontos percentuais.",
        "Por favor, confirme se o relatório foi enviado antes de sexta-feira.",
    ],
    "zh-CN": [
        "早上好，我们今天的会议改到了下午三点，在十二楼的会议室。",
        "市场原本预期降息零点二五个百分点。",
        "请在周五之前确认报告是否已经发出。",
    ],
    "en-US": [
        "Good morning everyone, the meeting has been moved to three in the afternoon.",
        "The market had expected a cut of twenty-five basis points.",
        "Please confirm whether the report went out before Friday.",
    ],
}


def line(title):
    print(f"\n── {title} " + "─" * max(0, 64 - len(title)))


def fail(message, code=2):
    print(f"\n✗ {message}")
    sys.exit(code)


def human_bytes(size):
    """字节数 → 人话（KB / MB）。"""
    if size is None:
        return "?"
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    return f"{size / (1024 * 1024):.1f} MB"


def rtf_of(cost_ms, audio_seconds):
    """RTF = 合成耗时 / 音频时长。**小于 1 才算跟得上实时**。

    <p>注意 TTS 的用法与 ASR 不同：ASR 是"进来 6 秒音频、花 60ms 出字"，
    TTS 是"进来一句话、花 X 毫秒产出一段音频"。RTF 越小，用户等得越短。
    """
    if not audio_seconds or audio_seconds <= 0:
        return 0.0
    return cost_ms / 1000.0 / audio_seconds


def voice_files(name_or_path, models_dir):
    """音色名 → (onnx 路径, json 路径)。也接受直接给 .onnx 的完整路径。

    <p>为什么单独拎成函数：piper 的两个文件必须**同名**放在一起（`x.onnx` + `x.onnx.json`），
    少一个就会在加载时报一句很难懂的错。这一层把"该在哪、缺哪个"说清楚。
    """
    raw = str(name_or_path or "").strip()
    if raw.lower().endswith(".onnx"):
        onnx = Path(raw)
        return onnx, Path(str(onnx) + ".json")
    base = Path(str(models_dir or DEFAULT_MODELS_DIR)) / raw
    return Path(str(base) + ".onnx"), Path(str(base) + ".onnx.json")


def read_wav_info(path):
    """读 wav 的采样率/声道/位深/时长/音量 —— 用标准库，不 import audioop（3.13 已删）。"""
    info = {"ok": False}
    try:
        with wave.open(str(path), "rb") as fp:
            channels = fp.getnchannels()
            width = fp.getsampwidth()
            rate = fp.getframerate()
            frames = fp.getnframes()
            payload = fp.readframes(frames)
    except Exception as error:                        # noqa: BLE001
        info["error"] = f"{type(error).__name__}: {error}"
        return info
    seconds = frames / float(rate or 1)
    rms = None
    if width == 2 and payload:
        samples = array.array("h")
        samples.frombytes(payload[: len(payload) - (len(payload) % 2)])
        if samples:
            total = sum(float(value) * float(value) for value in samples[::17])  # 抽样，够判静音
            count = len(samples[::17])
            rms = math.sqrt(total / count) / 32768.0
    info.update({"ok": True, "rate": rate, "channels": channels, "bits": width * 8,
                 "seconds": seconds, "rms": rms, "bytes": Path(path).stat().st_size})
    return info


def detect_engine(preferred):
    """返回实际用的引擎名与"为什么是它"。没装的引擎不报错，只记下来。"""
    found = []
    for name in ("piper", "kokoro", "coqui"):
        module = {"piper": "piper", "kokoro": "kokoro", "coqui": "TTS"}[name]
        try:
            __import__(module)
            found.append(name)
        except Exception:                             # noqa: BLE001
            continue
    if preferred and preferred != "auto":
        if preferred not in found:
            fail(f"你说 --engine {preferred}，但 `import { {'piper': 'piper', 'kokoro': 'kokoro', 'coqui': 'TTS'}[preferred] }` 失败。\n"
                 f"   已装的：{'、'.join(found) if found else '（一个都没有）'}\n"
                 "   装法见下面第①段的提示；也可以不加 --engine 让脚本自己挑。")
        return preferred
    if not found:
        return ""
    return found[0]


PIP_HINTS = {
    "piper": ('pip install piper-tts\n'
              '   （ONNX Runtime，不碰 torch —— 与服务器上钉死的 torch 2.6.0+cu124 不冲突）\n'
              '   还需要音素化工具：sudo apt install -y espeak-ng'),
    "kokoro": ('pip install "kokoro>=0.9" misaki\n'
               '   （要 torch；⚠️ 装完确认 torch 没被升级，见文件头的警告）'),
    "coqui": ('pip install coqui-tts\n'
              '   （⚠️ XTTS-v2 权重是 CPML **非商用**；需要 torch；体积几个 GB）'),
}


def check_engines():
    line("① TTS 引擎（本机装了哪个）")
    notes = []
    for name, module in (("piper", "piper"), ("kokoro", "kokoro"), ("coqui", "TTS")):
        try:
            imported = __import__(module)
            version = getattr(imported, "__version__", "?")
            print(f"  {name:<7} 已装     {module} {version}")
            notes.append(name)
        except Exception as error:                    # noqa: BLE001
            reason = f"{type(error).__name__}: {error}"
            print(f"  {name:<7} 没装     （{reason[:70]}）")
            print(f"           装法： {PIP_HINTS[name].splitlines()[0].strip()}")
    # 音素化：piper（尤其 1.2.x）靠 espeak-ng 把文字变成音素，缺了会在合成时报错
    espeak = shutil.which("espeak-ng") or shutil.which("espeak")
    print(f"  espeak-ng {'有' if espeak else '没有'}     {espeak or '（piper 需要它把文字转成音素：sudo apt install -y espeak-ng）'}")
    print(f"  onnxruntime {'有' if _has_module('onnxruntime') else '没有'}     "
          f"（piper 的推理后端；没有就先 pip install onnxruntime）")
    return notes


def _has_module(name):
    try:
        __import__(name)
        return True
    except Exception:                                 # noqa: BLE001
        return False


def check_torch_guard():
    """装了 torch 的引擎（kokoro/coqui）会连带影响识别侧 —— 这里只**报告**，不改。"""
    try:
        import torch
    except Exception:                                 # noqa: BLE001
        return
    version = str(getattr(torch, "__version__", "?"))
    cuda = str(getattr(getattr(torch, "version", None), "cuda", "") or "")
    print(f"  torch    {version}（编译 CUDA {cuda or '无'}）", end="")
    expected_version = "2.6.0"
    expected_cuda = "12.4"
    if version.split("+")[0] != expected_version or (cuda and not cuda.startswith(expected_cuda)):
        print(f"\n           ⚠️ 与识别侧的约定不一致：期望 torch {expected_version}+cu{expected_cuda.replace('.', '')}。")
        print("              装 kokoro/coqui 时 pip 可能顺手把 torch 升上去（装完 torch 看不到 CUDA 的经典坑）。")
        print('              钉住的办法：echo "torch==2.6.0" > /tmp/constraints.txt && '
              'pip install -c /tmp/constraints.txt <包名>')
    else:
        print("  ✅ 与识别侧一致")
    try:
        if torch.cuda.is_available():
            print(f"  GPU      {torch.cuda.get_device_name(0)}（可用）")
        else:
            print("  GPU      不可用（torch.cuda.is_available() = False）")
    except Exception as error:                        # noqa: BLE001
        print(f"  GPU      查询失败：{type(error).__name__}: {error}")


def list_voices(models_dir, selected=""):
    line("② 音色文件（piper 的 .onnx + .onnx.json 必须同名同目录）")
    print(f"  音色目录     {models_dir}")
    rows = list(KNOWN_VOICES.items())
    if selected:
        rows = [(name, spec) for name, spec in rows if name == selected] or [(selected, {})]
    for name, spec in rows:
        onnx, config = voice_files(name, models_dir)
        have_onnx, have_json = onnx.exists(), config.exists()
        if have_onnx and have_json:
            mark = "✅"
        elif have_onnx or have_json:
            mark = "⚠️ 缺一半"
        else:
            mark = "·"
        print(f"  {mark} {name:<22} {spec.get('lang', '?'):<6} ~{spec.get('mb', '?')} MB  {spec.get('note', '')}")
        print(f"      {onnx}")
        if not (have_onnx and have_json):
            missing = []
            if not have_onnx:
                missing.append(".onnx")
            if not have_json:
                missing.append(".onnx.json")
            print(f"      缺：{'、'.join(missing)}")
    print("  下载（服务器上一条命令，约几十 MB）：")
    print("    python -m piper.download_voices pt_BR-faber-medium --data-dir " + str(models_dir))
    print("  （没有 download_voices 子命令的老版本：从 huggingface.co/rhasspy/piper-voices 的")
    print("    pt/pt_BR/faber/medium/ 下把 .onnx 与 .onnx.json 两个文件下到同一目录）")
    return rows


def synth_piper(text, lang, onnx, out_path):
    """按 piper 的两代 API 依次尝试（1.2 的 synthesize 与新版 synthesize_wav/stream）。"""
    from piper import PiperVoice
    started = time.time()
    voice = PiperVoice.load(str(onnx))
    load_ms = (time.time() - started) * 1000
    started = time.time()
    with wave.open(str(out_path), "wb") as sink:
        if hasattr(voice, "synthesize_wav"):
            voice.synthesize_wav(text, sink)
        elif hasattr(voice, "synthesize"):
            voice.synthesize(text, sink)
        else:
            fail("这个 piper 版本既没有 synthesize_wav 也没有 synthesize —— 把 `pip show piper-tts` 的版本号发出来")
    cost_ms = (time.time() - started) * 1000
    return {"load_ms": load_ms, "cost_ms": cost_ms}


def synth_kokoro(text, lang, voice_name, out_path):
    import numpy as np
    from kokoro import KPipeline
    code = {"pt-BR": "p", "pt": "p", "en-US": "a", "en": "a", "zh-CN": "z", "zh": "z"}.get(lang, "p")
    started = time.time()
    pipeline = KPipeline(lang_code=code)
    load_ms = (time.time() - started) * 1000
    voice = voice_name or ("pf_dora" if code == "p" else ("af_heart" if code == "a" else "zf_xiaobei"))
    started = time.time()
    chunks = []
    for result in pipeline(text, voice=voice):
        audio = None
        if isinstance(result, tuple) and result:
            audio = result[-1]
        else:
            audio = getattr(result, "audio", None)
        if audio is not None:
            chunks.append(np.asarray(audio, dtype="float32"))
    cost_ms = (time.time() - started) * 1000
    if not chunks:
        fail("kokoro 没有产出音频（换一句 --text 再试；或看上面的报错）")
    audio = np.concatenate(chunks)
    rate = int(getattr(getattr(pipeline, "model", None), "sampling_rate", 24000) or 24000)
    pcm = np.clip(audio, -1.0, 1.0)
    with wave.open(str(out_path), "wb") as sink:
        sink.setnchannels(1)
        sink.setsampwidth(2)
        sink.setframerate(rate)
        sink.writeframes((pcm * 32767.0).astype("<i2").tobytes())
    return {"load_ms": load_ms, "cost_ms": cost_ms}


def measure(engine, args, texts, lang, models_dir):
    line(f"③ 合成实测（engine={engine}，{len(texts)} 句 × {max(1, args.runs)} 次）")
    onnx, config = voice_files(args.voice or default_voice_for(lang), models_dir)
    if engine == "piper":
        if not onnx.exists() or not config.exists():
            fail(f"音色文件不在：{onnx}\n   先按上面第②段的命令下载，或用 --voice 指到已有的 .onnx")
        print(f"  音色         {onnx.name}（{human_bytes(onnx.stat().st_size)}）")
    elif engine == "kokoro":
        print(f"  音色         {args.voice or '按语言取默认（pt→pf_dora）'}")
    elif engine == "coqui":
        fail("coqui(XTTS-v2) 需要参考音色（--speaker-wav），而且权重是 CPML **非商用** ——\n"
             "   本脚本只验证它的安装可用性，不做合成。把结论想清楚再决定要不要接它。")

    all_rtf = []
    scratch = Path(args.out) if args.out else Path(tempfile.gettempdir()) / "leion-tts-doctor"
    for index, text in enumerate(texts, start=1):
        costs = []
        info = {}
        keep = bool(args.out) and len(texts) == 1
        for _ in range(max(1, args.runs)):
            keep_this = keep and index == 1
            if keep_this:
                out_path = Path(args.out)
            else:
                out_path = Path(str(scratch) + f"-{index}-{os.getpid()}-{int(time.time() * 1000)}.wav")
            if engine == "piper":
                result = synth_piper(text, lang, onnx, out_path)
            else:
                result = synth_kokoro(text, lang, args.voice, out_path)
            info = read_wav_info(out_path)
            if not info.get("ok"):
                fail(f"合成出来的 wav 读不了：{info.get('error')}")
            costs.append(result["cost_ms"])
            if not keep_this:
                out_path.unlink(missing_ok=True)
        median = statistics.median(costs)
        ratio = rtf_of(median, info["seconds"])
        all_rtf.append(ratio)
        print(f"  第{index}句      原话 {len(text)} 字")
        print(f"              音频 {info['seconds']:.2f} s / {info['rate']} Hz / "
              f"{info['channels']} 声道 / {info['bits']} bit / {human_bytes(info['bytes'])}")
        print(f"              合成 中位 {median:.0f} ms（最快 {min(costs):.0f} / 最慢 {max(costs):.0f} ms，"
              f"{max(1, args.runs)} 次）")
        print(f"              RTF  {ratio:.3f}（{'跟得上实时' if ratio < 1 else '跟不上实时'}）"
              f"，音频/字 {human_bytes(info['bytes'] / max(1, len(text)))}")
        if info.get("rms") is not None:
            print(f"              响度 RMS {info['rms']:.4f}"
                  + ("  ⚠️ 几乎没声音 —— 音色文件坏了？" if info["rms"] < 0.005 else ""))
        if index == 1:
            print(f"              加载 {result['load_ms'] / 1000:.2f} s（首次含模型读盘；服务里只加载一次）")
            print(f"              首音 ≈ 合成耗时（整段合成完才播；手机端的 TtsChunker 已按句切块，"
                  f"所以短句的首音比这里更短）")
    if all_rtf and max(all_rtf) < 1:
        print(f"\n  结论：最快的一句 RTF {min(all_rtf):.3f}，最慢 {max(all_rtf):.3f} —— 单进程串行就能跟上会议语速。")
    return all_rtf


def default_voice_for(lang):
    code = str(lang or "").lower()
    if code.startswith("pt"):
        return "pt_BR-faber-medium"
    if code.startswith("en"):
        return "en_US-lessac-medium"
    if code.startswith("zh"):
        return "zh_CN-huayan-medium"
    return "pt_BR-faber-medium"


def selftest():
    """纯函数自检：不需要任何引擎、不写任何文件。给 CI 与"改完先自检"用。"""
    passed = []
    failed = []

    def check(name, condition):
        (passed if condition else failed).append(name)

    check("human_bytes 小数字节", human_bytes(512) == "512 B")
    check("human_bytes KB", human_bytes(2048) == "2.0 KB")
    check("human_bytes MB", human_bytes(2 * 1024 * 1024) == "2.0 MB")
    check("rtf 正常", abs(rtf_of(500, 2.0) - 0.25) < 1e-9)
    check("rtf 音频为 0 时不炸", rtf_of(500, 0) == 0.0)
    onnx, config = voice_files("pt_BR-faber-medium", "/opt/leion/models/piper")
    check("音色路径 .onnx", str(onnx).endswith("pt_BR-faber-medium.onnx"))
    check("音色配置同名 .onnx.json", str(config).endswith("pt_BR-faber-medium.onnx.json"))
    onnx2, config2 = voice_files("/models/x.onnx", "/ignored")
    check("直接给 .onnx 路径时不再拼目录", str(onnx2).replace("\\", "/").endswith("/models/x.onnx"))
    check("直接给 .onnx 路径时配置是 .onnx.json",
          str(config2).replace("\\", "/").endswith("/models/x.onnx.json"))
    check("pt → faber", default_voice_for("pt-BR") == "pt_BR-faber-medium")
    check("zh → huayan", default_voice_for("zh-CN") == "zh_CN-huayan-medium")
    check("en → lessac", default_voice_for("en-US") == "en_US-lessac-medium")
    check("未知语言兜底 pt", default_voice_for("xx") == "pt_BR-faber-medium")
    check("三门语言的验证句都在", all(SAMPLES.get(code) for code in ("pt-BR", "zh-CN", "en-US")))
    check("每门语言至少 3 句", all(len(SAMPLES[code]) >= 3 for code in SAMPLES))
    check("巴葡验证句不是中文", not any("的" in one for one in SAMPLES["pt-BR"]))
    check("已知音色都写了语言与体积",
          all(spec.get("lang") and spec.get("mb") for spec in KNOWN_VOICES.values()))

    print(f"passed={len(passed)} failed={len(failed)}")
    if failed:
        for name in failed:
            print(f"  ✗ {name}")
        return 1
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description="服务器自建 TTS（巴葡/中文/英文）开工自检")
    parser.add_argument("--engine", default="auto", choices=["auto", "piper", "kokoro", "coqui"],
                        help="用哪个引擎（缺省 auto：按 piper → kokoro 顺序挑一个已装的）")
    parser.add_argument("--lang", default="pt-BR", help="目标语言（缺省 pt-BR：手机本地缺的正是它）")
    parser.add_argument("--voice", default="", help="音色名或 .onnx 完整路径（缺省按语言取）")
    parser.add_argument("--models-dir", default=DEFAULT_MODELS_DIR,
                        help=f"piper 音色目录（缺省 {DEFAULT_MODELS_DIR}，也可用环境变量 LEION_TTS_MODELS）")
    parser.add_argument("--text", default="", help="只合成这一句（不给就跑内置的 3 句）")
    parser.add_argument("--runs", type=int, default=3, help="每句重复次数（缺省 3，取中位数）")
    parser.add_argument("--out", default="", help="把音频留在这个路径（只在单句时有效，便于自己听）")
    parser.add_argument("--list-voices", action="store_true", help="只列音色与应有路径，不合成")
    parser.add_argument("--selftest", action="store_true", help="只跑纯函数自检")
    args = parser.parse_args(argv)

    if args.selftest:
        return selftest()

    print("服务器自建 TTS 自检（不接云端 API：音频不出内网）")
    print(f"仓库         {ROOT}")
    print(f"python       {sys.version.split()[0]}  ({sys.executable})")
    print(f"音色目录     {args.models_dir}")

    installed = check_engines()
    check_torch_guard()

    if args.list_voices:
        list_voices(args.models_dir, args.voice)
        return 0

    engine = detect_engine(args.engine)
    if not engine:
        line("③ 结论")
        print("  这台机器一个 TTS 引擎都没装 —— 先把第①段里那个装法跑一遍。")
        print("  推荐先装 piper（ONNX，不碰 torch，pt_BR 有现成音色）：")
        print("    source /opt/leion/venv/bin/activate")
        print("    pip install piper-tts")
        print("    sudo apt install -y espeak-ng")
        print(f"    python -m piper.download_voices pt_BR-faber-medium --data-dir {args.models_dir}")
        print("  装完再跑本脚本（不带参数也行，它会告诉你还缺什么）。")
        return 3
    print(f"\n  用 {engine}（已装：{'、'.join(installed)}）")

    list_voices(args.models_dir, args.voice)

    texts = [args.text] if args.text else SAMPLES.get(args.lang) or SAMPLES["pt-BR"]
    measure(engine, args, texts, args.lang, args.models_dir)

    line("④ 下一步（本脚本不改任何配置，接线由你/我另做）")
    print("  ① 服务端：合成器做成常驻进程（与 bridge/asr-worker.mjs 同一套思路：")
    print("     队列 + 单进程加载一次模型 + 失败落 failed/），relay 加 POST /tts → 返回 wav。")
    print("  ② 手机端：TtsSpeaker.synthesize() 里加一个 ServerTtsEngine（本地系统 TTS 保持不变），")
    print("     按语言分流：中文走本地（零延迟、离线），巴葡/英语走服务器 —— 与 AsrRouter 同构。")
    print("  ③ 队列策略、耳机优先、禁外放、过期不播、与实时传声互斥都**不用动**，它们在上层。")
    print("  ④ 音质不满意再考虑换引擎：换的只是合成那一步，管线（队列/耳机/过期不播）不动。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
