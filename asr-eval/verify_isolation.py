#!/usr/bin/env python3
"""
verify_isolation.py —— 「接口隔离」有没有真的实现：一条命令跑完，逐项给 PASS/FAIL
========================================================================================
用户要验证的是**架构**，不是"能不能出字幕"。所以这里不测识别质量，只测四件隔离性质：

 ① **按语言选策略**：不同的语言各自拿到自己的策略名、切句参数、模型（互不影响）；
 ② **策略表是热配置**：改表就生效，不需要改代码、也不需要重启进程；
 ③ **两半各归各的消费者**：切句侧只吃 segmentation，识别侧只吃 model，
    改一边不该动另一边（这是"隔离"的定义，不是实现细节）；
 ④ **写错必须说出来**：语言指向没实现的模型 / 不存在的策略，要明确失败，
    **绝不允许**悄悄换成别的模型（否则 A/B 结论是假的）。

全部离线跑：不需要模型、不需要 GPU、不需要手机，几秒钟出结果。

用法
    python asr-eval/verify_isolation.py
    python asr-eval/verify_isolation.py --verbose     # 连每段的细节一起打印
"""

import argparse
import json
import shutil
import sys
import tempfile
from argparse import Namespace
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "bridge"))

import whisper_stream as ws  # noqa: E402

results = []


def check(label, ok, detail=""):
    results.append((label, bool(ok), detail))
    mark = "PASS" if ok else "FAIL"
    print(f"  [{mark}] {label}" + ("" if ok or not detail else f"\n         → {detail}"))


def speak_track(path, seconds=3.0, rate=16000, level=0.25):
    """写一段"像有人在说话"的音频：中间 2 秒有声音，两头是静音。"""
    total = int(rate * seconds)
    clip = np.zeros(total, dtype=np.float32)
    start = int(rate * 0.4)
    end = min(total, start + int(rate * 1.8))
    clip[start:end] = level
    path.write_bytes((np.clip(clip, -1, 1) * 32767).astype(np.int16).tobytes())
    (path.parent / (path.name + ".rate")).write_text("16000\n", encoding="utf-8")


def make_producer_args(workdir, table_path, tag="room-iso"):
    return Namespace(
        segment_dir=str(workdir / "queue"), tag=tag, follow=None,
        follow_dir=str(workdir / "audio" / tag), follow_rate=None,
        follow_from_start=True, follow_poll_ms=40, stop_after_idle=0.5,
        idle_flush_ms=200, samplerate=16000, block_ms=100,
        silence_ms=800, min_speech_ms=500, max_speech_ms=30000,
        rms_threshold=0.01, preroll_ms=250, adaptive=True, rms_floor=0.004,
        noise_multiplier=4.0, short_utterance_ms=800, short_silence_ms=1100,
        cut_pause_ms=200, language=None, lang_candidates=None, no_sidecar_lang=False,
        model="large-v3", compute_type="int8_float32", beam_size=5,
        model_map=str(table_path), max_models=2, data_dir=str(workdir),
    )


def run_cutter(workdir, table_path, tracks, tag="room-iso"):
    """跑一次**真实的**切句进程，返回它切出来的每段 meta。"""
    audio_dir = workdir / "audio" / tag
    audio_dir.mkdir(parents=True, exist_ok=True)
    queue_dir = workdir / "queue"
    queue_dir.mkdir(parents=True, exist_ok=True)
    for stem, lang in tracks.items():
        path = audio_dir / f"{stem}.pcm"
        speak_track(path)
        (audio_dir / f"{stem}.pcm.lang").write_text(lang + "\n", encoding="utf-8")
    args = make_producer_args(workdir, table_path, tag)
    ws.run_segment_producer(args, np)
    metas = []
    for item in sorted(queue_dir.glob("*.json")):
        metas.append(json.loads(item.read_text(encoding="utf-8")))
    for item in list(queue_dir.glob("*")):
        item.unlink()
    shutil.rmtree(audio_dir, ignore_errors=True)
    return metas


def main(argv=None):
    parser = argparse.ArgumentParser(description="验证接口隔离（离线、几秒钟）")
    parser.add_argument("--verbose", action="store_true", help="打印每一段的细节")
    parser.add_argument("--table", default=None,
                        help="额外检查一张**真实的**策略表（例如 /var/lib/leion/test/asr-models.json）："
                             "只读，逐语言打印它会解析成什么，不改动它")
    args = parser.parse_args(argv)

    if args.table:
        print(f"\n⓿ 检查真实部署的策略表：{args.table}")
        real, problem = ws.load_asr_models(args.table)
        if problem:
            check("表能读", False, problem)
        else:
            check("表能读", True)
            for line in ws.describe_strategies(real):
                print(f"     {line}")
            cli0 = {"model": "large-v3", "compute_type": "int8_float32", "beam_size": 5}
            for lang in ("zh-CN", "pt-BR", "en-US"):
                one = ws.resolve_strategy(lang, cli0, real)
                print(f"     {lang} → 策略 {one['strategy']} / 模型 {one['model']}"
                      f" / silence {one['segmentation']['silence_ms']}ms"
                      f"（模型来源：{one['sources']['model']}）")

    # 工作目录放在仓库的 var/ 下（不在系统临时目录）：受限环境里系统临时目录可能不可写，
    # 而这个脚本要真写音频/队列/策略表才能验"切句端"。
    workdir = Path(ROOT / "var" / "test" / "iso-verify")
    shutil.rmtree(workdir, ignore_errors=True)
    workdir.mkdir(parents=True, exist_ok=True)
    table_path = workdir / "asr-models.json"
    try:
        # ── ① 策略解析：每门语言拿到自己的那一份 ─────────────────────────────
        print("\n① 按语言选策略（解析层）")
        table = {
            "default": {"strategy": "default", "model": "large-v3",
                        "segmentation": {"silence_ms": 800, "min_speech_ms": 500}},
            "strategies": {
                "en-fast": {"model": "medium",
                            "segmentation": {"silence_ms": 650, "min_speech_ms": 600}},
                "zh-steady": {"segmentation": {"silence_ms": 900}},
            },
            "languages": {"en-US": {"strategy": "en-fast"},
                          "zh-CN": {"strategy": "zh-steady"},
                          "pt-BR": {"strategy": "default"}},
        }
        table_path.write_text(json.dumps(table, ensure_ascii=False), encoding="utf-8")
        cli = {"model": "large-v3", "compute_type": "int8_float32", "beam_size": 5}
        resolved = {lang: ws.resolve_strategy(lang, cli, table)
                    for lang in ("en-US", "zh-CN", "pt-BR", "ja-JP")}
        for lang, one in resolved.items():
            if args.verbose:
                print(f"     {lang}: 策略={one['strategy']} 模型={one['model']} "
                      f"切句={one['segmentation']} 来源={one['sources']}")
        check("en-US 拿到 en-fast", resolved["en-US"]["strategy"] == "en-fast")
        check("zh-CN 拿到 zh-steady", resolved["zh-CN"]["strategy"] == "zh-steady")
        check("pt-BR 走 default", resolved["pt-BR"]["strategy"] == "default")
        check("不认识的语言也走 default（不猜）", resolved["ja-JP"]["strategy"] == "default")
        check("策略里的切句参数真的生效",
              resolved["en-US"]["segmentation"]["silence_ms"] == 650
              and resolved["zh-CN"]["segmentation"]["silence_ms"] == 900)
        check("策略里的模型真的生效", resolved["en-US"]["model"] == "medium"
              and resolved["pt-BR"]["model"] == "large-v3")
        check("没写的字段继承 default（en-fast 没写 max_speech_ms）",
              resolved["en-US"]["segmentation"]["max_speech_ms"] == 30000)
        check("每一条都写清了来源（越权排障靠它）",
              all(one["sources"]["model"] and one["sources"]["segmentation"]
                  for one in resolved.values()))

        # ── ② 切句侧真的按语言各切各的 ────────────────────────────────────
        print("\n② 切句侧各归各的（真跑切句进程）")
        metas = run_cutter(workdir, table_path, {"alice": "en-US", "bob": "zh-CN"})
        by_speaker = {}
        for meta in metas:
            by_speaker.setdefault(meta.get("speaker"), []).append(meta)
        if args.verbose:
            for meta in metas:
                print(f"     {meta.get('speaker')}/{meta.get('lang')} "
                      f"策略={meta.get('strategy')} {meta.get('ms')}ms")
        check("两路都切出了段", len(by_speaker) == 2, f"实际 {sorted(by_speaker)}")
        check("英语那一路的策略名是 en-fast",
              all(m.get("strategy") == "en-fast" for m in by_speaker.get("alice", [])))
        check("中文那一路的策略名是 zh-steady",
              all(m.get("strategy") == "zh-steady" for m in by_speaker.get("bob", [])))
        check("两路的语种各自独立（en / zh，没有串）",
              {m.get("lang") for m in by_speaker.get("alice", [])} == {"en"}
              and {m.get("lang") for m in by_speaker.get("bob", [])} == {"zh"})

        # ── ③ 热配置：改表就生效，不用重启 ────────────────────────────────
        print("\n③ 策略表是热配置（改完立即生效）")
        table["languages"]["en-US"] = {"strategy": "en-slow"}
        table["strategies"]["en-slow"] = {"segmentation": {"silence_ms": 1500}}
        table_path.write_text(json.dumps(table, ensure_ascii=False), encoding="utf-8")
        again = run_cutter(workdir, table_path, {"alice": "en-US"})
        check("改表后新切出的段换了策略（没有重启进程）",
              bool(again) and all(m.get("strategy") == "en-slow" for m in again),
              str([m.get("strategy") for m in again]))
        resolved2 = ws.resolve_strategy("en-US", cli, table)
        check("同一张表重新解析也立刻反映新值",
              resolved2["segmentation"]["silence_ms"] == 1500, str(resolved2["segmentation"]))

        # ── ④ 两半互不干扰 ────────────────────────────────────────────────
        print("\n④ 切句与识别是分开的两半（改一边不动另一边）")
        only_seg = {"default": {"model": "large-v3"},
                    "strategies": {"x": {"segmentation": {"silence_ms": 700}}},
                    "languages": {"en-US": {"strategy": "x"}}}
        only_model = {"default": {"model": "large-v3"},
                      "languages": {"en-US": {"model": "medium"}}}
        seg_view = ws.resolve_strategy("en-US", cli, only_seg)
        model_view = ws.resolve_strategy("en-US", cli, only_model)
        check("只改切句时，模型保持命令行那个", seg_view["model"] == "large-v3")
        check("只改模型时，切句保持缺省", model_view["segmentation"]["silence_ms"] == 800)
        check("两边各自的来源互不掩盖",
              "x" in seg_view["sources"]["segmentation"] and "languages.en-US" in model_view["sources"]["model"])

        # ── ⑤ 写错必须说出来（不许悄悄换一个）────────────────────────────
        print("\n⑤ 配错了要明确失败（绝不静默兜底）")
        class BoomHandle:
            pass

        class BoomEngine(ws.AsrEngine):
            key = "boom"
            display = "会失败的引擎"

            def load(self, profile, device):
                raise RuntimeError("no such model")

            def transcribe(self, handle, audio, language, profile=None):
                return {}

        pool = ws.ModelPool({"boom": BoomEngine()}, max_models=1, log=lambda _line: None)
        raised = ""
        try:
            pool.get({"engine": "boom", "model": "not-installed",
                      "compute_type": "int8_float32", "strategy": "bad"}, device="cpu")
        except RuntimeError as error:
            raised = str(error)
        check("模型不存在时**抛出**而不是换一个模型", raised == "no such model", raised)
        unknown = ""
        try:
            pool.get({"engine": "whisper", "model": "x"})
        except ValueError as error:
            unknown = str(error)
        check("策略写了没注册的引擎 → 抛错并列出已知引擎（不静默换成 whisper）",
              "whisper" in unknown and "boom" in unknown, unknown)
        empty_table = {}
        fallback = ws.resolve_strategy("en-US", cli, empty_table)
        check("没有策略表时行为回落到命令行（老行为不变）",
              fallback["model"] == "large-v3" and fallback["segmentation"]["silence_ms"] == 800)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    failed = [one for one in results if not one[1]]
    print(f"\n=== 接口隔离验证：{len(results) - len(failed)} 通过 / {len(failed)} 失败 ===")
    if failed:
        print("失败项：")
        for label, _ok, detail in failed:
            print(f"  · {label}" + (f"（{detail}）" if detail else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
