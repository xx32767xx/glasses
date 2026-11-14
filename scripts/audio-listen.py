#!/usr/bin/env python3
"""audio-listen.py —— 把一场会的分轨录音，按**当前产线参数**切成句、转成能听的 WAV、打成 zip
============================================================================

为什么要有它
------------

用户原话：「切分之后的结果就更好了，参数就用目前正在跑的那套参数，此时你要把切分后的
音频打包，我方便下载」。

他要的不是"整条 71 分钟的音轨"，而是**按现在这套切句参数切出来的每一句**——
只有这样听到的才是"系统当时看到的那个东西"：同样的段长、同样的边界、同样的丢段。
整条音轨听着正常、但每段都切碎，这种问题是听整条听不出来的。

和产线共用同一份实现（这一条不可省）
------------------------------------

  · 切段：`whisper_stream._new_segmenter` + `UtteranceSegmenter`（就是产线那个切句器）
  · 参数：`whisper_stream.resolve_strategy(语种, {}, 策略表)` —— **读的就是
          `<data-dir>/asr-models.json`**，也就是"现在正在跑的那套"
  · 读音频：分轨 `audio/<房间>/<说话人>.pcm` + `.rate` / `.lang` 旁文件

不复制切句逻辑，否则量到的是"另一个切句器的切法"。

用法
----

    # 1) 一键：自己找那场会最大的一路音轨，用当前参数切，打包
    python3 scripts/audio-listen.py --data-dir /var/lib/leion/test --room room-mweog8vv-y93e

    # 2) 指定说话人与语种
    python3 scripts/audio-listen.py --data-dir ... --room ... --speaker test9 --lang en-US

    # 3) 顺手带出产线当时的原文（便于对照）
    python3 scripts/audio-listen.py --data-dir ... --room ... \
        --meeting-log /var/lib/leion/test/logs/rooms/170359-room-mweog8vv-y93e.jsonl

    # 4) 只要最长的 40 段（包小、挑重点听）
    python3 scripts/audio-listen.py --data-dir ... --room ... --top 40

产出（都在 --out 目录里）
-------------------------

    seg-0001.wav …   每段一个 WAV（16 kHz / 16-bit / 单声道，双击就能放）
    index.html       本地网页：逐段点播放，旁边写着时长、电平、产线原文
    manifest.tsv     一张表（段号 / 起止秒 / 时长 / RMS / 产线原文）
    <房间>-segments.zip   **整包**，直接 scp 到本地解压即可

两个刻意的取舍
--------------

  1. **音量默认不动**。你们那场课说话段 RMS 只有 0.003~0.005（正常人声要 0.03），
     所以听起来会很小声。但**归一化会改变音量**，那就没法用它判断"当时收音够不够"。
     想听清楚加 `--normalize`，报告里会写明"已放大"，别拿它当原始电平看。
  2. **产线原文只是参考**。会议记录里只有句号和时长，没有精确的音频偏移；
     所以按"段长序列对齐"（与 replay 那套同一个函数）去配，配不上的留空，
     并在 index.html 里标出"参考"二字。
"""

import argparse
import json
import os
import shutil
import sys
import wave
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "bridge"))
sys.path.insert(0, str(ROOT / "asr-eval"))

import numpy as np                                              # noqa: E402

import whisper_stream                                          # noqa: E402
from replay_cer import align_by_duration                       # noqa: E402


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="按当前产线参数切段 → 转 WAV → 打包 zip（方便下载后逐句听）")
    parser.add_argument("--data-dir", required=True,
                        help="数据目录（读 asr-models.json 的切句参数 + 找 audio/ 分轨）")
    parser.add_argument("--room", default=None, help="房间 id（不给就用 --track）")
    parser.add_argument("--track", default=None, help="直接指定一路 pcm")
    parser.add_argument("--speaker", default=None,
                        help="说话人文件名（不给就取该房间体积最大的那一路）")
    parser.add_argument("--lang", default=None,
                        help="语种（不给就读 .lang 旁文件；都没有就用策略表的 default）")
    parser.add_argument("--meeting-log", default=None,
                        help="那场会的会议记录 JSONL（用来带出产线原文，仅供参考）")
    parser.add_argument("--top", type=int, default=0, help="只导出最长的 N 段（0 = 全部）")
    parser.add_argument("--out", default=None, help="输出目录（缺省 var/audio-listen/<房间>）")
    parser.add_argument("--normalize", action="store_true",
                        help="把每段峰值拉到 0.9（听着清楚，但**不再反映原始电平**）")
    parser.add_argument("--no-zip", action="store_true", help="不打包（只留目录）")
    parser.add_argument("--rate", type=int, default=0, help="裸 pcm 的采样率（有 .rate 旁文件就不用给）")
    return parser.parse_args(argv)


# ── 读音频 ───────────────────────────────────────────────────────────────────

def read_track(path, rate_hint=0):
    """读一路分轨（裸 s16le PCM）。采样率依次取：参数 > `.rate` 旁文件 > 16000。"""
    path = Path(path)
    rate = int(rate_hint or 0)
    sidecar = Path(str(path) + ".rate")
    if rate <= 0 and sidecar.exists():
        try:
            rate = int(sidecar.read_text(encoding="utf-8").strip())
        except (OSError, ValueError):
            rate = 0
    if rate <= 0:
        rate = 16000
    raw = path.read_bytes()
    if len(raw) % 2 != 0:
        raw = raw[:-1]
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    return audio, rate


def resample_to(audio, rate, target=16000):
    """线性重采样（产线已经是 16k，正常走不到这里）。"""
    if rate == target or rate <= 0:
        return audio, rate
    count = int(round(len(audio) * target / rate))
    if count <= 0:
        return np.zeros(0, dtype=np.float32), target
    src = np.linspace(0.0, 1.0, num=len(audio), endpoint=False)
    dst = np.linspace(0.0, 1.0, num=count, endpoint=False)
    return np.interp(dst, src, audio).astype(np.float32), target


def write_wav(path, audio, rate=16000, normalize=False):
    """写 16-bit 单声道 WAV（播放器直接认）。

    <p>裸 PCM 没有文件头，播放器一律报"未知格式" —— 这就是这个脚本最核心的一步：
    加上那 44 字节的头。
    """
    data = np.asarray(audio, dtype=np.float32)
    if normalize and data.size > 0:
        peak = float(np.max(np.abs(data)))
        if peak > 1e-6:
            data = data * (0.9 / peak)
    pcm = (np.clip(data, -1.0, 1.0) * 32767.0).astype(np.int16)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(int(rate))
        handle.writeframes(pcm.tobytes())


# ── 切段（与产线同一套） ─────────────────────────────────────────────────────

def cut_segments(audio, rate, segmentation, data_dir=None):
    """用产线那个切句器切，返回 [{audio,start_ms,end_ms,dur_ms,rms}]。

    <p>start/end 是**近似值**（按已经送进切句器的采样数倒推），够用来定位，别当精确时间轴。
    """
    args = argparse.Namespace(
        samplerate=rate, block_ms=100, rms_threshold=0.01, rms_floor=0.004,
        noise_multiplier=4.0, preroll_ms=250, adaptive=True, data_dir=data_dir)
    segmenter = whisper_stream._new_segmenter(args, np, segmentation=segmentation)
    block = int(rate * 100 / 1000)
    out = []
    for start in range(0, len(audio), block):
        chunk = audio[start:start + block]
        if chunk.size == 0:
            continue
        for utterance in segmenter.push(np.asarray(chunk, dtype=np.float32)):
            samples = int(utterance.size)
            end_ms = int(round(segmenter.fed_samples * 1000.0 / rate))
            out.append({
                "audio": np.asarray(utterance, dtype=np.float32),
                "start_ms": max(0, end_ms - int(round(samples * 1000.0 / rate))),
                "end_ms": end_ms,
                "dur_ms": int(round(samples * 1000.0 / rate)),
                "rms": float(np.sqrt(np.mean(np.square(utterance)))) if samples else 0.0,
            })
    tail = getattr(segmenter, "buffer", None)
    if tail:
        try:
            utterance = segmenter._take()                       # noqa: SLF001 与产线同一处
        except Exception:                                       # noqa: BLE001
            utterance = None
        if utterance is not None and len(utterance) > 0:
            samples = int(utterance.size)
            end_ms = int(round(segmenter.fed_samples * 1000.0 / rate))
            out.append({
                "audio": np.asarray(utterance, dtype=np.float32),
                "start_ms": max(0, end_ms - int(round(samples * 1000.0 / rate))),
                "end_ms": end_ms,
                "dur_ms": int(round(samples * 1000.0 / rate)),
                "rms": float(np.sqrt(np.mean(np.square(utterance)))),
            })
    return out


def read_meeting_sentences(path):
    """读会议记录里的句子（按 seg 排序）。读不到就返回空。"""
    if not path:
        return []
    rows = []
    try:
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    item = json.loads(line)
                except ValueError:
                    continue
                if item.get("kind") == "sentence":
                    rows.append(item)
    except OSError as error:
        print(f"[listen] ⚠️ 会议记录读不了（{error}）→ 不带产线原文", file=sys.stderr)
        return []
    rows.sort(key=lambda item: int(item.get("seg") or 0))
    return rows


def pick_track(data_dir, room, speaker):
    """找那一路分轨：给了 speaker 就用它，否则取体积最大的（通常是主要说话人）。"""
    if room is None:
        return None
    folder = Path(data_dir) / "audio" / str(room)
    if not folder.is_dir():
        return None
    if speaker:
        candidate = folder / (str(speaker) + ".pcm") if not str(speaker).endswith(".pcm") else folder / str(speaker)
        return candidate if candidate.exists() else None
    tracks = sorted(folder.glob("*.pcm"), key=lambda one: one.stat().st_size, reverse=True)
    return tracks[0] if tracks else None


def mmss(ms):
    total = max(0, int(ms)) // 1000
    return f"{total // 60:02d}:{total % 60:02d}"


def escape(text):
    return (str(text).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def write_index(path, rows, title, normalize, has_prod):
    """一个能双击打开的本地页面：逐段点播放，旁边写着时长/电平/产线原文。"""
    parts = []
    for row in rows:
        prod = row.get("prod") or ""
        prod_html = (f'<div class="prod">产线原文（参考）：{escape(prod)}</div>'
                     if prod else "")
        parts.append(
            f'<div class="row"><div class="meta"><b>#{row["seg"]}</b><br>'
            f'{row["dur_ms"] / 1000.0:.1f}s<br>'
            f'rms {row["rms"]:.4f}<br>'
            f'<span class="t">{mmss(row["start_ms"])}</span></div>'
            f'<div><audio controls preload="none" src="{row["file"]}"></audio>{prod_html}</div></div>')

    notes = []
    if normalize:
        notes.append("⚠️ 已做峰值归一化（每段拉到 0.9）—— <b>音量不再反映原始电平</b>，"
                     "别用它判断收音够不够大。")
    else:
        notes.append("音量是<b>原始电平</b>。教室里说话段 RMS 往往只有 0.003~0.005，"
                     "听的时候可能要开大音量；想听清楚就重跑一次加 <code>--normalize</code>。")
    if has_prod:
        notes.append("「产线原文」是按<b>段长</b>对齐出来的参考（会议记录里没有精确偏移），"
                     "配不上的段留空。判读以音频为准。")

    html = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>{escape(title)}</title>
<style>
 :root {{ color-scheme: light dark; }}
 body {{ font: 14px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 0; padding: 16px; }}
 h1 {{ font-size: 16px; margin: 0 0 8px; }}
 .note {{ font-size: 12px; opacity: .8; margin: 4px 0; }}
 .row {{ display: grid; grid-template-columns: 92px 1fr; gap: 10px; padding: 8px 0;
   border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent); }}
 .meta {{ font-size: 12px; opacity: .85; }}
 .t {{ opacity: .6; }}
 .prod {{ font-size: 12px; opacity: .75; margin-top: 4px; }}
 audio {{ width: 100%; height: 32px; }}
</style></head><body>
<h1>{escape(title)}</h1>
{''.join(f'<div class="note">{one}</div>' for one in notes)}
<div id="rows">{''.join(parts)}</div>
</body></html>
"""
    Path(path).write_text(html, encoding="utf-8")


def main(argv=None):
    args = parse_args(argv)
    data_dir = str(Path(args.data_dir).resolve())

    track = Path(args.track) if args.track else pick_track(data_dir, args.room, args.speaker)
    if track is None or not track.exists():
        sys.exit(f"找不到音频：{args.track or (data_dir + '/audio/' + str(args.room) + '/')}\n"
                 "  是不是被 leion-clean 清掉了？先用 `ls` 确认那场会的分轨还在。")

    # 语种：参数 > .lang 旁文件 > 策略表 default
    lang = args.lang
    if not lang:
        sidecar = Path(str(track) + ".lang")
        if sidecar.exists():
            try:
                lang = sidecar.read_text(encoding="utf-8").strip() or None
            except OSError:
                lang = None

    table = {}
    models_path = Path(data_dir) / whisper_stream.ASR_MODELS_FILE
    if models_path.exists():
        table, problem = whisper_stream.load_asr_models(str(models_path))
        if problem:
            print(f"[listen] ⚠️ 策略表读不了（{problem}）→ 用内置缺省参数")
        table = table or {}
    profile = whisper_stream.resolve_strategy(lang, {}, table)
    segmentation = dict(profile.get("segmentation") or {})
    print("[listen] 切句参数（来自策略表 " + str(profile.get("strategy")) + "）："
          + "、".join(f"{key}={segmentation.get(key)}" for key in whisper_stream.SEGMENTATION_FIELDS))
    print("[listen] 语种 " + str(lang) + "；引擎 " + str(profile.get("engine") or "whisper")
          + " / " + str(profile.get("model")) + "（这里只切段，不识别）")

    audio, rate = read_track(track, args.rate)
    audio, rate = resample_to(audio, rate)
    print(f"[listen] 音轨 {track.name}：{len(audio) / float(rate or 16000):.1f} 秒"
          f"（{rate} Hz）")

    segments = cut_segments(audio, rate, segmentation, data_dir=data_dir)
    if not segments:
        sys.exit("一段都没切出来（检查 --rate / 这段是不是静音）")
    print(f"[listen] 切出 {len(segments)} 段，合计 "
          f"{sum(one['dur_ms'] for one in segments) / 1000.0:.1f} 秒语音")

    meeting = read_meeting_sentences(args.meeting_log)
    aligned = (align_by_duration([one["dur_ms"] for one in segments],
                                 [int(row.get("segMs") or 0) for row in meeting])
               if meeting else [None] * len(segments))

    if args.top > 0 and len(segments) > args.top:
        order = sorted(range(len(segments)), key=lambda i: segments[i]["dur_ms"], reverse=True)
        keep = sorted(order[:args.top])
        segments = [segments[i] for i in keep]
        aligned = [aligned[i] for i in keep]
        print(f"[listen] 只导出最长的 {args.top} 段")

    out_dir = Path(args.out) if args.out else (ROOT / "var" / "audio-listen"
                                               / (str(args.room) if args.room else track.stem))
    if out_dir.exists():
        shutil.rmtree(out_dir, ignore_errors=True)
    out_dir.mkdir(parents=True, exist_ok=True)

    rows = []
    for index, one in enumerate(segments, start=1):
        name = f"seg-{index:04d}.wav"
        write_wav(out_dir / name, one["audio"], rate=rate, normalize=args.normalize)
        prod = "" if aligned[index - 1] is None else str(meeting[aligned[index - 1]].get("src") or "")
        rows.append({
            "seg": index, "file": name, "start_ms": one["start_ms"], "end_ms": one["end_ms"],
            "dur_ms": one["dur_ms"], "rms": one["rms"], "prod": prod,
        })

    with open(out_dir / "manifest.tsv", "w", encoding="utf-8") as handle:
        handle.write("seg\tfile\tstart_ms\tend_ms\tdur_ms\trms\tprod\n")
        for row in rows:
            handle.write("\t".join(str(row[key]).replace("\t", " ").replace("\n", " ")
                                   for key in ("seg", "file", "start_ms", "end_ms",
                                               "dur_ms", "rms", "prod")) + "\n")
    write_index(out_dir / "index.html", rows,
                f"{args.room or track.stem} · {len(rows)} 段（按当前产线参数切）",
                args.normalize, bool(meeting))

    zip_path = ""
    if not args.no_zip:
        zip_path = str(out_dir.parent / (out_dir.name + "-segments.zip"))
        total = 0
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
            for name in ["index.html", "manifest.tsv"] + [row["file"] for row in rows]:
                one = out_dir / name
                bundle.write(one, arcname=name)
                total += one.stat().st_size
        size_mb = Path(zip_path).stat().st_size / 1024 / 1024
        print(f"[listen] 打包：{zip_path}（{size_mb:.1f} MB；原始 {total / 1024 / 1024:.1f} MB）")

    print(f"[listen] 目录：{out_dir}（index.html 双击就能逐段听）")
    print("[listen] 下载到本地：")
    print(f"          scp ubuntu@<服务器>:{zip_path or out_dir} .")
    if args.normalize:
        print("[listen] ⚠️ 已做归一化：音量不再反映原始电平，别拿它判断收音够不够")
    return 0


if __name__ == "__main__":
    sys.exit(main())
