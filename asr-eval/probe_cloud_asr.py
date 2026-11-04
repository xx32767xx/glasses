#!/usr/bin/env python3
"""
probe_cloud_asr.py —— 一次问清「这个账号的实时语音识别，到底哪个模型名能用」（5.91）
========================================================================================

为什么要这个工具：DashScope 有两个容易混淆的地方，都只能靠真打一次才知道 ——

  ① **两套模型命名空间**：兼容模式（OpenAI 风格 HTTP）列表里看得到的名字
     （`fun-asr-flash-2026-06-15`、`qwen3-asr-flash-realtime`…）在实时 WebSocket 端
     **不存在**（报 `ModelNotFound`）；实时端认的是 `fun-asr-realtime` /
     `paraformer-realtime-v2` 这类。
  ② **端点常常是账号专属域名**：控制台示例里是
     `wss://ws-<id>.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference`，
     而连公共域名 `dashscope.aliyuncs.com` 的表现是 —— 鉴权过、但模型报
     `InvalidParameter`。看起来像"参数写错"，其实是"连错地方"。

所以本工具：对候选模型名逐个真打一次 WS，**只报事实**（出字 / 名字不存在 / 请求被拒），
错误信息一律**完整打印**（错误码能定性，错误信息才说清哪个参数不对）。

用法
    export DASHSCOPE_API_KEY=sk-...
    export DASHSCOPE_WS_URL=wss://ws-<你的>.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference
    python asr-eval/probe_cloud_asr.py                        # 试内置候选
    python asr-eval/probe_cloud_asr.py --model fun-asr-realtime --model paraformer-realtime-v2
    python asr-eval/probe_cloud_asr.py --file var/audio/short-16k.wav

退出码：0 = 至少一个「能出字」；1 = 都不行；2 = 缺前置（key / websockets）。
"""

import argparse
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "bridge"))
sys.path.insert(0, str(HERE))

# 候选顺序 = 最可能先试：实时端的常见名字在前，兼容模式的名字放最后做对照
DEFAULT_CANDIDATES = [
    "fun-asr-realtime",
    "paraformer-realtime-v2",
    "paraformer-realtime-8k-v2",
    "qwen3-asr-flash-realtime",
    "fun-asr-flash-2026-06-15",
]


def synthetic_audio(seconds=2.0, rate=16000):
    """没有人声时的占位音频：只为把协议跑通（识别结果为空是正常的）。"""
    import numpy as np

    t = np.arange(int(seconds * rate)) / rate
    return (0.1 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)


def load_audio(path, want_rate=16000):
    """读 wav 并（必要时）线性重采样到 16k —— 探针不追求音质，只求能送进去。"""
    import wave

    import numpy as np

    with wave.open(str(path), "rb") as handle:
        rate, channels, width = handle.getframerate(), handle.getnchannels(), handle.getsampwidth()
        if width != 2:
            raise SystemExit(f"{path} 不是 16-bit wav（{width * 8}-bit），换一个或先转码")
        frames = handle.readframes(min(handle.getnframes(), rate * 10))
    audio = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    if rate != want_rate:
        ratio = want_rate / float(rate)
        index = np.arange(int(len(audio) * ratio)) / ratio
        audio = np.interp(index, np.arange(len(audio)), audio).astype(np.float32)
    return audio


def classify(reason):
    """把失败原因归类：这两种的处理方式完全不同。"""
    lowered = (reason or "").lower()
    if "modelnotfound" in lowered or "model not found" in lowered:
        return "no-model"
    if "task-failed" in lowered:
        return "rejected"
    return "other"


def main(argv=None):
    parser = argparse.ArgumentParser(description="探明 DashScope 实时语音识别可用的模型名与端点")
    parser.add_argument("--model", action="append", default=None,
                        help="候选模型名（可重复；缺省用内置候选）")
    parser.add_argument("--file", default=None,
                        help="用这段 16k 单声道 wav；缺省用 2 秒正弦占位（协议探针够用）")
    parser.add_argument("--language", default="pt-BR", help="语种标签（缺省 pt-BR）")
    args = parser.parse_args(argv)

    import whisper_stream as ws

    api_key = (os.environ.get(ws.FunAsrEngine.ENV_KEY) or "").strip()
    if not api_key:
        print(f"✗ 缺 {ws.FunAsrEngine.ENV_KEY}：先 export 再跑", file=sys.stderr)
        return 2
    try:
        import websockets.sync.client  # noqa: F401
    except ImportError:
        print("✗ 缺 websockets：pip install websockets", file=sys.stderr)
        return 2

    engine = ws.FunAsrEngine(None, None)
    endpoint = engine.ws_url()
    candidates = args.model or DEFAULT_CANDIDATES

    audio = load_audio(args.file) if args.file else synthetic_audio()
    print(f"端点 {endpoint}")
    print(f"音频 {len(audio) / 16000.0:.1f}s"
          f"（{'文件 ' + args.file if args.file else '2 秒正弦占位'}）")
    print(f"语种 {args.language}；候选 {len(candidates)} 个\n")

    worked = []
    reached = []
    for model in candidates:
        try:
            handle = engine.load({"model": model}, "cpu")
        except RuntimeError as error:
            print(f"  ? {model}：{error}")
            continue
        outcome = engine.transcribe(handle, audio, args.language, {"model": model})
        reason = outcome.get("reason") or ""
        kind = classify(reason)
        if outcome.get("empty") is False:
            print(f"  ✓ {model}：出字（{outcome['text'][:70]!r}）")
            worked.append(model)
        elif kind == "no-model":
            print(f"  ✗ {model}：这个模型名在实时端不存在（ModelNotFound）")
        elif kind == "rejected":
            # ⚠️ 不截断：错误码能定性，错误信息才说清哪个参数不对
            print(f"  ~ {model}：名字存在，但请求被拒 → {reason}")
            reached.append(model)
        else:
            print(f"  ✗ {model}：{reason}")

    print("")
    if worked:
        print("能用的：" + "、".join(worked))
        print("把策略表里 pt-funasr 的 model 改成它，然后：")
        print("  node scripts/asr-model-switch.mjs --data-dir <数据目录> --lang pt-BR --strategy pt-funasr")
        return 0
    if reached:
        print("名字都存在但请求被拒（" + "、".join(reached) + "）—— 看上面的完整报错，"
              "通常是参数（format / sample_rate）或配额问题，不是名字问题。")
        return 1
    print("一个都没通。按顺序查：① 端点是不是账号专属域名 ② 该模型是否已在控制台开通 "
          "③ 是否只有兼容模式（HTTP）的模型可用")
    return 1


if __name__ == "__main__":
    sys.exit(main())
