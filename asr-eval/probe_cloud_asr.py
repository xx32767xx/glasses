#!/usr/bin/env python3
"""
probe_cloud_asr.py —— 一次性问清「这个账号的实时语音识别，到底哪个模型名能用」（5.89）
========================================================================================

为什么要这个工具：DashScope 有**两套模型命名空间** ——
  · 兼容模式（OpenAI 风格 HTTP）看得到的：`fun-asr-flash-2026-06-15`、`qwen3-asr-flash-realtime`…
  · 实时 WebSocket 端（`/api-ws/v1/inference`）认的：可能是 `fun-asr-realtime`、
    `fun-asr-realtime-2026-02-15`、`paraformer-realtime-v2`…
两者**不一致**：实测把兼容模式列表里的模型名塞进 WS，会直接 `ModelNotFound`。
而手工一个个试，一轮对话只能试一个 —— 所以这里一次全试完。

用法
    export DASHSCOPE_API_KEY=sk-...
    python asr-eval/probe_cloud_asr.py                      # 试内置候选
    python asr-eval/probe_cloud_asr.py --model fun-asr-realtime --model paraformer-realtime-v2
    python asr-eval/probe_cloud_asr.py --file var/audio/short-16k.wav

约定：**只报告事实**（每个模型名的结果/错误码），不替你选。
"""

import argparse
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "bridge"))
sys.path.insert(0, str(HERE))

DEFAULT_CANDIDATES = [
    # 实时（WebSocket）端常见名字，按"最可能"排
    "fun-asr-realtime",
    "paraformer-realtime-v2",
    "paraformer-realtime-8k-v2",
    "qwen3-asr-flash-realtime",
    # 兼容模式列表里能看到的（大概率在 WS 端不存在，但留着做对照）
    "fun-asr-flash-2026-06-15",
]


def synthetic_audio(seconds=2.0, rate=16000):
    """没有人声时的占位音频（只为把协议跑通；识别结果为空是正常的）。"""
    import numpy as np

    t = np.arange(int(seconds * rate)) / rate
    return (0.1 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)


def load_audio(path, want_rate=16000):
    import wave

    import numpy as np

    with wave.open(str(path), "rb") as handle:
        rate, channels, width = handle.getframerate(), handle.getnchannels(), handle.getsampwidth()
        frames = handle.readframes(min(handle.getnframes(), rate * 10))
    audio = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    if rate != want_rate:
        # 只为探针用：线性重采样，够判断"协议通不通"
        ratio = want_rate / float(rate)
        index = np.arange(int(len(audio) * ratio)) / ratio
        audio = np.interp(index, np.arange(len(audio)), audio).astype(np.float32)
    return audio


def main(argv=None):
    parser = argparse.ArgumentParser(description="探明 DashScope 实时语音识别可用的模型名")
    parser.add_argument("--model", action="append", default=None,
                        help="候选模型名（可重复；缺省用内置候选）")
    parser.add_argument("--file", default=None, help="用这段音频（16k 单声道 wav）；缺省用 2 秒正弦占位")
    parser.add_argument("--language", default="pt-BR", help="语种标签（缺省 pt-BR）")
    args = parser.parse_args(argv)

    import os

    import whisper_stream as ws

    if not (os.environ.get(ws.FunAsrEngine.ENV_KEY) or "").strip():
        print(f"✗ 缺 {ws.FunAsrEngine.ENV_KEY}：先 export 再跑", file=sys.stderr)
        return 2
    try:
        import websockets.sync.client  # noqa: F401
    except ImportError:
        print("✗ 缺 websockets：pip install websockets", file=sys.stderr)
        return 2

    audio = load_audio(args.file) if args.file else synthetic_audio()
    seconds = len(audio) / 16000.0
    print(f"音频 {seconds:.1f}s（{'文件 ' + args.file if args.file else '2 秒正弦占位'}）")
    print(f"语种 {args.language}；候选 {len(args.model or DEFAULT_CANDIDATES)} 个")
    print(f"端点 {engine_url()}\n")

    engine = ws.FunAsrEngine(None, None)

    def engine_url():
        return engine.ws_url()
    good = []
    for model in (args.model or DEFAULT_CANDIDATES):
        try:
            handle = engine.load({"model": model}, "cpu")
        except RuntimeError as error:
            print(f"  ? {model}：{error}")
            continue
        outcome = engine.transcribe(handle, audio, args.language, {"model": model})
        reason = outcome.get("reason") or ""
        if outcome.get("empty") is False:
            print(f"  ✓ {model}：出字（{outcome['text'][:60]!r}）")
            good.append((model, "ok"))
        elif "ModelNotFound" in reason or "model not found" in reason.lower():
            print(f"  ✗ {model}：这个模型名不存在（ModelNotFound）")
        elif "task-failed" in reason:
            # ⚠️ 不截断：错误码能定性，错误信息才说清哪个参数不对
            print(f"  ~ {model}：名字存在，但请求被拒 → {reason}")
            good.append((model, "名字存在"))
        elif "超时" in reason:
            print(f"  ? {model}：{reason}")
        else:
            print(f"  ✗ {model}：{reason}")

    print("")
    if good:
        print("可用（至少协议跑通）：" + "、".join(name for name, _ in good))
        print("把策略表 pt-funasr 的 model 改成上面那个即可：")
        print("  node scripts/asr-model-switch.mjs --data-dir <数据目录> --lang pt-BR "
              f"--strategy pt-funasr   # 先改表里的 model 字段")
        return 0
    print("一个都没通。把上面的输出整段贴回来 —— 它会说明是「名字不对」还是「协议不对」。")
    return 1


if __name__ == "__main__":
    sys.exit(main())
