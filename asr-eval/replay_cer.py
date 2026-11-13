#!/usr/bin/env python3
"""asr-eval/replay_cer.py —— 用**真实会议录音**重跑识别，按多组配置比 CER（5.188）

为什么要有这个工具
==================

用户 2026-11-13 明确纠正过一次判断：**「更多的是识别错误」**。而识别错误到底
是"哪个旋钮"造成的（精度？beam？上下文？术语？切段？），靠调完听着顺耳是分不出来的 ——
必须用同一段录音、同一套参考文本，把几组配置的错字率量出来。

这份工具就是那条路：拿一场**已经在服务器上跑过的会**的分轨录音，按产线同一套切句
重新切一遍，然后每个段用 N 组配置各识别一次，按人工对照文本算 CER/WER。

刻意与产线共用同一份实现（不复制代码）
======================================

  · 切段：`whisper_stream.UtteranceSegmenter` + `_new_segmenter`（同一个类、同一套参数解析）
  · 识别：`whisper_stream.transcribe`（四道闸都在里面：静音闸 / 高通 / 归一化 / 幻听与回显）
  · 打分：`asr_score.track_scores` / `aggregate_tracks` / `key_term_hits`（与评测同一口径）

这样量出来的差才是"改配置的差"，而不是"另一个实现与产线的差"。

两步用法（第二步可以不在这台机器上做，但第一步必须能听到音频）
=============================================================

    # ① 切段 + 出对照表（**不需要模型/GPU**）：每段落成单独一个 pcm，方便逐条听
    python asr-eval/replay_cer.py sheet \\
        --data-dir /var/lib/leion/test --room room-mweog8vv-y93e --lang en-US \\
        --meeting-log /var/lib/leion/test/logs/rooms/170359-room-mweog8vv-y93e.jsonl \\
        --out var/asr-eval/replay/170359.tsv

    # ② 打开 tsv，把 truth 那一列填上人工对照（留空的段会被跳过，不用全填）

    # ③ 跑多组配置比 CER（需要 GPU/模型）
    python asr-eval/replay_cer.py score --refs var/asr-eval/replay/170359.tsv \\
        --variants base,float16,beam8,hp0,vad,terms \\
        --terms-file var/asr-eval/replay/terms.txt --out var/asr-eval/replay/report.md

口径要说清的三件事
==================

  1. **只填了 truth 的段才计分**；报告里如实写"跳过了多少段"。没参考文本的段不是"识别对"。
  2. **两条口径一起报**（严格 / 规范化）：差值大说明错主要是写法（数字/繁简），不是听错；
     只看对自己有利的那一条，等于自欺。
  3. **切段是重放的，不是现场的**：现场还有 `--idle-flush-ms`、实时排队。
     所以这个工具能回答"哪组识别配置更准"，不能回答"当时为什么慢了 300ms"。
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "bridge"))

import numpy as np                                                    # noqa: E402

import asr_score                                                      # noqa: E402
import whisper_stream                                                 # noqa: E402

DEFAULT_WORKROOT = ROOT / "var" / "asr-eval" / "replay"
SHEET_HEADER = ["seg", "file", "start_ms", "end_ms", "dur_ms", "rms", "prodSeg", "prod", "truth"]

# ── 变体：一组配置 = 一次识别要用到的全部差异 ────────────────────────────────
#
# 为什么是这几个（每一个都对应一条现场怀疑，见 §5.186–§5.188）：
#   base     : 产线当前配置，作为对照原点
#   float16  : 精度（int8 量化最伤低频词/术语 —— 现场术语错得最多）
#   beam8    : 解码宽度（5 → 8）
#   hp0      : 关掉高通（5.187 把它设成默认开，得证明它没伤识别）
#   vad      : 开 VAD 二次确认（5.186 加的能力，一直没在真实课堂上量过）
#   terms    : 术语热词（走 initial_prompt）—— 需要 --terms-file
VARIANT_ORDER = ["base", "float16", "beam8", "hp0", "vad", "terms"]


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="用一场会的真实录音重跑识别，按多组配置比 CER（不碰线上服务）")
    sub = parser.add_subparsers(dest="command", required=True)

    def shared(one):
        one.add_argument("--data-dir", default=None,
                         help="数据目录（读 asr-models.json / segmentation.json；缺省不含）")
        one.add_argument("--workdir", default=None,
                         help=f"切出来的段放哪（缺省 {DEFAULT_WORKROOT}/<room 或 track 名>）")
        one.add_argument("--lang", default="en-US", help="这一路的语种标签（缺省 en-US）")
        one.add_argument("--rate", type=int, default=0, help="裸 pcm 的采样率（有 .rate 旁文件就不用给）")
        one.add_argument("--silence-ms", type=int, default=0, help="覆盖切句静音（0 = 用表/日志里的）")
        one.add_argument("--min-speech-ms", type=int, default=0, help="覆盖 min_speech_ms（0 = 用表里的）")
        one.add_argument("--sample", type=int, default=0,
                         help="只取均匀分布的 N 段（想快速试一组配置时用；0 = 全部）")
        one.add_argument("--limit", type=int, default=0, help="只取最前面 N 段（0 = 全部）")

    sheet = sub.add_parser("sheet", help="切段 + 出对照表（不需要模型）")
    sheet.add_argument("--room", default=None, help="房间 id（自动去 <data-dir>/audio/<room>/ 找分轨）")
    sheet.add_argument("--track", default=None, help="直接指定一路 pcm（给了就不找 room）")
    sheet.add_argument("--meeting-log", default=None, help="那场会的会议记录 JSONL（用来带出产线原文）")
    sheet.add_argument("--out", default=None, help="对照表写到哪（缺省 <workdir>/sheet.tsv）")
    shared(sheet)

    score = sub.add_parser("score", help="按填好的对照表跑多组配置并打分（需要模型）")
    score.add_argument("--refs", required=True, help="填好 truth 的对照表（sheet 的输出）")
    score.add_argument("--variants", default="base",
                       help=f"逗号分隔，可选：{','.join(VARIANT_ORDER)}")
    score.add_argument("--terms-file", default=None, help="术语热词清单（一行一个，给 terms 变体用）")
    score.add_argument("--model", default=None, help="覆盖模型名（缺省用策略表里的）")
    score.add_argument("--compute-type", default=None, help="覆盖精度（缺省用策略表里的）")
    score.add_argument("--device", default="auto", help="auto / cuda / cpu")
    score.add_argument("--unit", default=None, help="char / word（缺省按语种自动）")
    score.add_argument("--out", default=None, help="报告写到哪（缺省 <workdir>/report.md）")
    shared(score)
    return parser.parse_args(argv)


# ── 读音频 ───────────────────────────────────────────────────────────────────

def read_track(path, rate_hint=0):
    """读一路分轨：裸 s16le PCM（产线格式）或 wav。返回 (float32 mono [-1,1], rate)。"""
    path = Path(path)
    if path.suffix.lower() == ".wav":
        import wave
        with wave.open(str(path)) as handle:
            channels = handle.getnchannels()
            rate = handle.getframerate()
            raw = handle.readframes(handle.getnframes())
        audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        if channels > 1:
            audio = audio.reshape(-1, channels).mean(axis=1)
        return audio, rate
    rate = rate_hint
    sidecar = Path(str(path) + ".rate")
    if not rate and sidecar.exists():
        try:
            rate = int(sidecar.read_text(encoding="utf-8").strip())
        except (OSError, ValueError):
            rate = 0
    if not rate:
        rate = 16000                      # 产线的录音格式就是 16k/16bit/mono
    raw = path.read_bytes()
    if len(raw) % 2 != 0:
        raw = raw[:-1]
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0, rate


def resample_to(audio, rate, target=16000):
    """线性重采样（只在采样率不是 16k 时用；产线已经是 16k，正常走不到这里）。"""
    if rate == target or rate <= 0:
        return audio, rate
    count = int(round(len(audio) * target / rate))
    if count <= 0:
        return np.zeros(0, dtype=np.float32), target
    src = np.linspace(0.0, 1.0, num=len(audio), endpoint=False)
    dst = np.linspace(0.0, 1.0, num=count, endpoint=False)
    return np.interp(dst, src, audio).astype(np.float32), target


# ── 切段（与产线同一套） ─────────────────────────────────────────────────────

def segmentation_for(args, table, log_hint=None):
    """这一路该用的切句参数：策略表 > 会议记录里当时的 silenceMs > 命令行覆盖。

    为什么要把日志里的值当依据：表可能在这之后被改过（现场调过旋钮），
    而**要重放的是当时那次切段**，不是今天的配置。
    """
    profile = whisper_stream.resolve_strategy(args.lang, {}, table or {})
    segmentation = dict(profile.get("segmentation") or {})
    source = f"策略表 {profile.get('strategy')}"
    if log_hint and isinstance(log_hint.get("silenceMs"), (int, float)) and log_hint["silenceMs"] > 0:
        if segmentation.get("silence_ms") != log_hint["silenceMs"]:
            print(f"[replay] 会议记录里当时的 silenceMs={log_hint['silenceMs']}，"
                  f"而表里现在是 {segmentation.get('silence_ms')} → 按**当时**的来")
        segmentation["silence_ms"] = int(log_hint["silenceMs"])
        source = "会议记录"
    if args.silence_ms > 0:
        segmentation["silence_ms"] = int(args.silence_ms)
        source = "命令行"
    if args.min_speech_ms > 0:
        segmentation["min_speech_ms"] = int(args.min_speech_ms)
        source = "命令行"
    return segmentation, profile, source


def cut_segments(audio, rate, segmentation, data_dir=None):
    """把一路音频切成段，返回 [{audio, start_ms, end_ms, dur_ms, rms}]。

    ⚠️ 段里的 `start_ms/end_ms` 是**近似值**（按"已经送进切句器的采样数"倒推，
       再加上尾部静音被裁掉的部分）。够用来定位，别拿来当精确时间轴。
    """
    args = argparse.Namespace(
        samplerate=rate, block_ms=100, rms_threshold=0.01, rms_floor=0.004,
        noise_multiplier=4.0, preroll_ms=250, adaptive=True, data_dir=data_dir,
    )
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
    # 收尾：把最后没说完的一段也交出来（产线是 `--idle-flush-ms` 干的活）
    tail = getattr(segmenter, "buffer", None)
    if tail:
        utterance = segmenter._take()          # noqa: SLF001 —— 与产线同一处实现
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


def write_pcm(path, audio):
    pcm = (np.clip(np.asarray(audio, dtype=np.float32), -1.0, 1.0) * 32767.0).astype(np.int16)
    path.write_bytes(pcm.tobytes())


def read_pcm(path):
    return np.frombuffer(Path(path).read_bytes(), dtype=np.int16).astype(np.float32) / 32768.0


# ── 会议记录（产线原文，用来对照"哪一句被听错了"） ──────────────────────────

def read_meeting_sentences(path):
    """读一场会的句子记录（按 seg 排序）。读不了就返回空并在 stderr 说一句。"""
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
        print(f"[replay] ⚠️ 会议记录读不了（{error}）→ prod 列会是空的", file=sys.stderr)
        return []
    rows.sort(key=lambda item: int(item.get("seg") or 0))
    return rows


def pick_track(args):
    if args.track:
        return Path(args.track)
    if not args.room or not args.data_dir:
        sys.exit("要么给 --track，要么同时给 --room 与 --data-dir")
    folder = Path(args.data_dir) / "audio" / args.room
    if not folder.exists():
        sys.exit(f"没有这个房间的录音目录：{folder}")
    candidates = sorted(folder.glob("*.pcm"), key=lambda one: one.stat().st_size, reverse=True)
    if not candidates:
        sys.exit(f"{folder} 里没有 .pcm（可能已被 leion-clean 清掉）")
    print(f"[replay] 取体积最大的那一路：{candidates[0].name}"
          f"（同一目录下的其它文件：{'、'.join(one.name for one in candidates[1:]) or '无'}）")
    return candidates[0]


def take_sampled(items, sample, limit):
    if limit > 0:
        items = items[:limit]
    if sample > 0 and len(items) > sample:
        step = len(items) / float(sample)
        items = [items[int(index * step)] for index in range(sample)]
    return items


# ── 子命令：sheet ────────────────────────────────────────────────────────────

def command_sheet(args):
    track = pick_track(args)
    workdir = Path(args.workdir) if args.workdir else (DEFAULT_WORKROOT / track.stem)
    segments_dir = workdir / "segments"
    segments_dir.mkdir(parents=True, exist_ok=True)
    for stale in segments_dir.glob("*.pcm"):
        stale.unlink()

    table = None
    if args.data_dir:
        path = Path(args.data_dir) / whisper_stream.ASR_MODELS_FILE
        if path.exists():
            table, problem = whisper_stream.load_asr_models(str(path))
            if problem:
                print(f"[replay] ⚠️ 策略表读不了：{problem}")
    table = table or {}
    meeting = read_meeting_sentences(args.meeting_log)
    hint = meeting[0] if meeting else None
    segmentation, profile, source = segmentation_for(args, table, hint)
    print(f"[replay] 切句参数（来自 {source}）："
          + "、".join(f"{key}={segmentation[key]}" for key in whisper_stream.SEGMENTATION_FIELDS))
    print(f"[replay] 识别策略（产线语义）：{profile.get('strategy')} / "
          f"{profile.get('engine') or 'whisper'}:{profile.get('model')} / "
          f"{profile.get('compute_type')}")

    audio, rate = read_track(track, args.rate)
    audio, rate = resample_to(audio, rate)
    seconds = len(audio) / float(rate or 16000)
    print(f"[replay] 音频 {seconds:.1f} 秒（{track.name}）")
    segments = cut_segments(audio, rate, segmentation, data_dir=args.data_dir)
    segments = take_sampled(segments, args.sample, args.limit)
    if not segments:
        sys.exit("一段都没切出来（检查 --silence-ms / --rate 或这路录音是不是静音）")
    print(f"[replay] 切出 {len(segments)} 段，合计 "
          f"{sum(one['dur_ms'] for one in segments) / 1000.0:.1f} 秒语音")

    # 段数与产线句子数差得多时**必须说出来**：那份 prod 列就不是"同一句"的意思了
    if meeting:
        ratio = len(segments) / float(len(meeting))
        if not (0.9 <= ratio <= 1.1):
            print(f"[replay] ⚠️ 重放切出 {len(segments)} 段，而产线记录是 {len(meeting)} 句"
                  f"（相差 {(ratio - 1) * 100:+.0f}%）→ prod 列**只能参考**，不能当成逐句对齐",
                  file=sys.stderr)

    rows = []
    for index, one in enumerate(segments, start=1):
        name = f"seg-{index:04d}.pcm"
        write_pcm(segments_dir / name, one["audio"])
        prod = meeting[index - 1] if index - 1 < len(meeting) else None
        rows.append({
            "seg": index,
            "file": name,
            "start_ms": one["start_ms"],
            "end_ms": one["end_ms"],
            "dur_ms": one["dur_ms"],
            "rms": round(one["rms"], 4),
            "prodSeg": int(prod.get("seg")) if prod else "",
            "prod": str(prod.get("src") or "") if prod else "",
            "truth": "",
        })
    out = Path(args.out) if args.out else (workdir / "sheet.tsv")
    write_sheet(out, rows)
    print(f"[replay] 对照表已写出：{out}")
    print(f"[replay] 每段音频在：{segments_dir}")
    print("[replay] 下一步：把 truth 那一列填上人工对照（留空的段会被跳过），"
          "然后跑 score 子命令")
    return 0


def _cell(value):
    """一格 TSV：制表符与换行会把整张表错位（识别文本偶尔带换行），压成空格。"""
    return " ".join(str(value).replace("\t", " ").split("\n")).strip()


def write_sheet(path, rows):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = ["\t".join(SHEET_HEADER)]
    for row in rows:
        lines.append("\t".join(_cell(row.get(key, "")) for key in SHEET_HEADER))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def read_sheet(path):
    """读对照表，按表头还原成字典列表（**不过滤** —— 过滤 truth 非空是调用方的事）。

    ⚠️ 用 `utf-8-sig` 读：这张表是给人**手工编辑**的（Excel / 记事本 / VS Code 都可能加 BOM），
    带 BOM 时第一格会变成 `\\ufeffseg`，于是"表头不对"这种莫名其妙的报错就出现了。
    """
    text = Path(path).read_text(encoding="utf-8-sig")
    # 再兜一层：手工编辑时 BOM 常常**留在正文里**（一次存成 BOM、下一次又当普通字符写回），
    # 这时表头第一格会是 "\ufeffseg" —— 报"表头不对"等于让人去猜一个看不见的字符。
    text = text.lstrip("\ufeff")
    lines = [line for line in text.split("\n") if line.strip() != ""]
    if not lines:
        return []
    header = lines[0].split("\t")
    if header[:2] != ["seg", "file"]:
        sys.exit(f"对照表第一行应该是表头 {SHEET_HEADER}，实际是 {header}")
    rows = []
    for line in lines[1:]:
        cells = line.split("\t")
        if len(cells) < len(header):
            cells += [""] * (len(header) - len(cells))
        rows.append(dict(zip(header, cells)))
    return rows


# ── 子命令：score ────────────────────────────────────────────────────────────

def variant_specs(names, profile, terms):
    """把变体名翻译成"覆盖哪些字段"。缺省值全部来自策略表（也就是产线当前配置）。"""
    base = {
        "model": profile.get("model") or "large-v3",
        "compute_type": profile.get("compute_type") or "float16",
        "beam_size": profile.get("beam_size") or 5,
        "highpass_hz": float(profile.get("highpass_hz") or 0.0),
        "vad": bool(profile.get("vad") or False),
        "vad_max_ms": int(profile.get("vad_max_ms") or 2000),
        "vad_threshold": float(profile.get("vad_threshold") or 0.5),
        "initial_prompt": None,
    }
    out = []
    for name in names:
        name = name.strip()
        if name == "":
            continue
        if name == "base":
            out.append((name, dict(base)))
        elif name == "float16":
            out.append((name, {**base, "compute_type": "float16"}))
        elif name == "int8":
            out.append((name, {**base, "compute_type": "int8_float32"}))
        elif name == "beam8":
            out.append((name, {**base, "beam_size": 8}))
        elif name == "hp0":
            out.append((name, {**base, "highpass_hz": 0.0}))
        elif name == "hp100":
            out.append((name, {**base, "highpass_hz": 100.0}))
        elif name == "vad":
            out.append((name, {**base, "vad": True}))
        elif name == "terms":
            if not terms:
                print("[replay] ⚠️ 要了 terms 变体但没给 --terms-file → 跳过它", file=sys.stderr)
                continue
            out.append((name, {**base, "initial_prompt": build_prompt(terms)}))
        else:
            sys.exit(f"不认识的变体：{name}（可选 {','.join(VARIANT_ORDER)}，外加 int8 / hp100）")
    return out


def build_prompt(terms):
    """术语热词拼成一句提示词。

    为什么拼成句子而不是裸词表：Whisper 的 `initial_prompt` 是**上文的语气**，
    一串逗号隔开的裸词会让它偶尔把这串词当正文吐出来（`looks_like_prompt_echo` 会拦，
    但拦掉就白跑了）。写成"以下是这节课常用的术语：…"更像正常上文。
    """
    cleaned = [word.strip() for word in terms if word.strip()]
    if not cleaned:
        return None
    return "以下是这节课常用的术语：" + "、".join(cleaned) + "。"


def read_terms(path):
    if not path:
        return []
    text = Path(path).read_text(encoding="utf-8")
    return [line.strip() for line in text.split("\n")
            if line.strip() != "" and not line.strip().startswith("#")]


def load_model(spec, args, cache):
    key = (spec["model"], spec["compute_type"])
    if key in cache:
        return cache[key]
    _, WhisperModel, _ = whisper_stream.load_dependencies(need_audio=False)
    device = args.device
    if device == "auto":
        # 自己判，而不是把 "auto" 交给底层：CPU 上 float16 会直接抛错（用户第一次跑就撞墙），
        # 而"产线在有卡的机器上跑的是 cuda"这件事本来就要说清楚。
        try:
            import ctranslate2
            device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
        except Exception:                                   # noqa: BLE001
            device = "cpu"
    compute = spec["compute_type"]
    # 精度要按这台机器**实际支持**的来（与产线 5.42 同一套思路，只是这里按 device 查表）：
    # CPU 上没有 float16，Pascal 卡上也没有 —— 照抄表里的值会直接抛 ctranslate2 的一行英文。
    try:
        import ctranslate2
        supported = set(ctranslate2.get_supported_compute_types(device))
    except Exception:                                       # noqa: BLE001
        supported = set()
    if supported and compute not in supported:
        for candidate in ("int8_float32", "int8", "float32"):
            if candidate in supported:
                print("[replay] ⚠️ " + device + " 跑不了 " + str(compute)
                      + "，改用 " + candidate, flush=True)
                compute = candidate
                break
    print("[replay] 加载 " + str(spec["model"]) + "（" + device + "/" + str(compute) + "）…",
          flush=True)
    started = time.perf_counter()
    model = WhisperModel(spec["model"], device=device, compute_type=compute)
    print(f"[replay] 加载完成 {time.perf_counter() - started:.1f}s", flush=True)
    cache[key] = model
    return model


def transcribe_clip(model, audio, spec, lang, silence_floor):
    """用**产线那个 transcribe()** 识别一段（四道闸都在里面）。返回 (text, ms)。"""
    started = time.perf_counter()
    text, empty, _reason, _override, _kind, _lang = whisper_stream.transcribe(
        model, audio, lang, -1.0, 0.6,
        beam_size=int(spec["beam_size"]),
        hint_text=spec.get("initial_prompt"),
        context_text=None,
        do_normalize=True,
        silence_floor=silence_floor,
        highpass_hz=float(spec["highpass_hz"]),
        vad=bool(spec["vad"]),
        vad_max_ms=int(spec["vad_max_ms"]),
        vad_threshold=float(spec["vad_threshold"]),
    )
    elapsed = int(round((time.perf_counter() - started) * 1000))
    return ("" if empty else str(text or "")), elapsed


def score_variant(model, refs, workdir, spec, lang, unit, silence_floor):
    """一个变体跑完全部段，返回逐段结果 + 汇总。"""
    rows = []
    for row in refs:
        audio = read_pcm(workdir / "segments" / row["file"])
        if int(row.get("dur_ms") or 0) <= 0 and audio.size == 0:
            continue
        text, ms = transcribe_clip(model, audio, spec, lang, silence_floor)
        scores = asr_score.track_scores(row["truth"], text, unit=unit,
                                        drop_interjections=True, collapse_repeats=True)
        rows.append({
            "seg": row["seg"],
            "reference": row["truth"],
            "hypothesis": text,
            "ms": ms,
            "scores": scores,
        })
    aggregate = asr_score.aggregate_tracks([one["scores"] for one in rows]) if rows else {}
    times = sorted(one["ms"] for one in rows)
    return {
        "rows": rows,
        "aggregate": aggregate,
        "mean_ms": (sum(times) / len(times)) if times else 0,
        "p95_ms": asr_score.percentile(times, 0.95) if times else 0,
    }


def delta_of(current, base):
    """规范化口径的相对变化（百分点）。正的 = 变差。"""
    if not base or not current:
        return None
    was = base.get("normalized", {}).get("rate")
    now = current.get("normalized", {}).get("rate")
    if was is None or now is None:
        return None
    return (now - was) * 100.0


def format_report(args, variants, results, refs, unit, terms):
    """把对比写成 markdown：一张总表 + 每组"变好/变差最多"的段（照着去听）。

    <p>为什么一定要给"逐段差异"：总表告诉你"哪组更好"，但**为什么更好/更差**只有对着
    具体段落才看得出来（是术语修好了，还是把一整句吃掉了）。而"吃掉一整句"这种退化
    在平均值上可能只差半点，在体感上却是灾难 —— 所以两边都要列。
    """
    scored = len(refs)
    lines = []
    lines.append("# 重放对比：同一段录音，多组识别配置的错字率\n")
    lines.append("- 对照表：`" + str(args.refs) + "`")
    lines.append("- 参与计分的段：**" + str(scored) + "**（truth 已填；留空的段被跳过，不算识别对）")
    lines.append("- 计分单位：`" + unit + "`（中文按字、英文按词）")
    if terms:
        shown = "、".join(terms[:20]) + ("…" if len(terms) > 20 else "")
        lines.append("- 术语热词 " + str(len(terms)) + " 个：" + shown)
    lines.append("")
    lines.append("| 配置 | 段数 | 严格错误率 | 规范化错误率 | 相对 base | S / D / I | 平均耗时 | p95 耗时 |")
    lines.append("|---|---|---|---|---|---|---|---|")
    base_result = results.get("base")
    for name, result in results.items():
        if not result["rows"]:
            continue
        strict = result["aggregate"].get("strict", {})
        normal = result["aggregate"].get("normalized", {})
        delta = delta_of(result["aggregate"],
                         base_result["aggregate"] if base_result else None)
        delta_text = "—" if delta is None else format(delta, "+.2f") + " 个百分点"
        strict_rate = "{:.2f}%".format(strict.get("rate", float("nan")) * 100)
        normal_rate = "{:.2f}%".format(normal.get("rate", float("nan")) * 100)
        sdi = "{}/{}/{}".format(strict.get("substitutions", 0), strict.get("deletions", 0),
                                strict.get("insertions", 0))
        lines.append("| `" + name + "` | " + str(len(result["rows"])) + " | " + strict_rate
                     + " | " + normal_rate + " | " + delta_text + " | " + sdi
                     + " | {:.0f} ms | {:.0f} ms |".format(result["mean_ms"], result["p95_ms"]))
    lines.append("")
    lines.append("读法：**规范化错误率**是主口径（数字写法/繁简不算错），"
                 "「相对 base」为正 = 比产线现在更差。")
    lines.append("")

    if base_result and base_result["rows"]:
        was_by_seg = {one["seg"]: one for one in base_result["rows"]}
        for name, result in results.items():
            if name == "base" or not result["rows"]:
                continue
            moved = []
            for one in result["rows"]:
                was = was_by_seg.get(one["seg"])
                if was is None:
                    continue
                diff = one["scores"]["normalized"]["rate"] - was["scores"]["normalized"]["rate"]
                moved.append((diff, one, was))
            moved.sort(key=lambda item: item[0])
            better = [item for item in moved if item[0] < -1e-9][:5]
            worse = [item for item in reversed(moved) if item[0] > 1e-9][:5]
            lines.append("## `" + name + "` 相对 base 的变化（挑最值得听的）\n")
            if not better and not worse:
                lines.append("（没有任何一段的识别结果变化 —— 这个旋钮在这批音频上没影响）\n")
                continue
            for label, items in (("变好", better), ("变差", worse)):
                if not items:
                    continue
                lines.append("**" + label + "的段**\n")
                for diff, one, was in items:
                    lines.append("- seg" + str(one["seg"]) + "（" + format(diff * 100, "+.1f")
                                 + " 个百分点，听 `segments/seg-" + str(one["seg"]).zfill(4) + ".pcm`）")
                    lines.append("  - 参考：" + str(one["reference"]))
                    lines.append("  - base：" + str(was["hypothesis"]))
                    lines.append("  - " + name + "：" + str(one["hypothesis"]))
                lines.append("")
    lines.append("## 这份报告**不能**说明的事\n")
    lines.append("- 不能说明绝对准确率：只统计了填了 truth 的那些段，其余段被跳过；")
    lines.append("- 不能说明现场延迟：切段是事后重放的，没有 `--idle-flush-ms` 与实时排队；")
    lines.append("- 不能说明别的语种：一次只跑一路录音、一个语种。")
    return "\n".join(lines) + "\n"


def command_score(args):
    refs = [row for row in read_sheet(args.refs) if str(row.get("truth") or "").strip() != ""]
    if not refs:
        sys.exit("对照表里没有一行填了 truth —— 至少填几段再跑（留空的段会被跳过）")
    workdir = Path(args.workdir) if args.workdir else Path(args.refs).parent
    missing = [row["file"] for row in refs if not (workdir / "segments" / row["file"]).exists()]
    if missing:
        sys.exit(f"缺音频文件：{missing[:3]}（先用 sheet 子命令切段，并给同一个 --workdir）")

    table = {}
    if args.data_dir:
        path = Path(args.data_dir) / whisper_stream.ASR_MODELS_FILE
        if path.exists():
            table, _problem = whisper_stream.load_asr_models(str(path))
    table = table or {}
    profile = whisper_stream.resolve_strategy(args.lang, {}, table)
    if args.model:
        profile["model"] = args.model
    if args.compute_type:
        profile["compute_type"] = args.compute_type
    silence_floor = float(profile.get("silence_skip_level") or whisper_stream.SILENCE_SKIP_RMS)
    unit = args.unit or ("char" if asr_score.has_cjk(refs[0]["truth"]) else "word")
    terms = read_terms(args.terms_file)
    specs = variant_specs(args.variants.split(","), profile, terms)

    print(f"[replay] 计分单位 {unit}；{len(refs)} 段；变体 "
          f"{'、'.join(name for name, _spec in specs)}")
    cache = {}
    results = {}
    base_spec = dict(specs[0][1]) if specs else {}
    for name, spec in specs:
        if name != "base" and dict(spec) == base_spec:
            # 表里本来就是 0 高通 / 没开 VAD 时，"hp0""vad=off" 这类变体与 base 完全一样 ——
            # 不说一句就会被读成"这个旋钮没影响"，其实是"没测到差别"。
            print("[replay] ⚠️ " + name + " 与 base 的配置**完全相同**（表里本来就是这个值）"
                  "→ 它只能证明『没测到差别』，不能证明『没影响』；"
                  "顺带还能验一件事：两边输出应当逐字一致，不一致说明解码有随机性", flush=True)
        model = load_model(spec, args, cache)
        said = ("[replay] ▶ " + name + "：模型的 " + str(spec["model"]) + "/"
                 + str(spec["compute_type"]) + "，beam " + str(spec["beam_size"])
                 + "，高通 " + format(float(spec["highpass_hz"]), "g")
                 + "，VAD " + ("开" if spec["vad"] else "关")
                 + ("，带术语提示词" if spec.get("initial_prompt") else ""))
        print(said, flush=True)
        started = time.perf_counter()
        results[name] = score_variant(model, refs, workdir, spec, args.lang, unit, silence_floor)
        normal = results[name]["aggregate"].get("normalized", {})
        print(f"[replay]   规范化错误率 {normal.get('rate', float('nan')) * 100:.2f}%"
              f"（{time.perf_counter() - started:.0f}s）", flush=True)

    report = format_report(args, specs, results, refs, unit, terms)
    out = Path(args.out) if args.out else (workdir / "report.md")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(report, encoding="utf-8")
    print(f"\n[replay] 报告已写出：{out}")
    print(report.split("## ")[0])
    return 0


def main(argv=None):
    args = parse_args(argv)
    if getattr(args, "command", None) == "sheet":
        return command_sheet(args)
    return command_score(args)


if __name__ == "__main__":
    sys.exit(main())
