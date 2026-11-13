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
import re
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
SHEET_HEADER = ["seg", "file", "start_ms", "end_ms", "dur_ms", "rms",
                 "prodSeg", "prod", "suspect", "truth", "reviewed"]

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

    compare = sub.add_parser(
        "compare", help="**不需要参考文本**：跑几组配置，把输出并排摆出来用人眼比（快）")
    compare.add_argument("--sheet", default=None, help="对照表（缺省 <workdir>/sheet.tsv）")
    # ⚠️ 缺省只能写 base。2026-11-13 踩到：缺省当初写了 "base,float16"，
    # 于是"什么都不给、就跑当前配置"这条最常用的路，会因为 float16 是 whisper 专属
    # 而在 parakeet 机器上被硬挡下来 —— 用户看到的是"我明明只要跑当前配置"。
    # 缺省值也是一种"我替你决定"，它必须能跑得通。
    compare.add_argument("--variants", default="base",
                         help="要对比的配置（逗号分隔；缺省只跑策略表里的现状）")
    compare.add_argument("--baseline", default="prod",
                         help="拿谁当对照：prod = 用对照表里**产线当时**的原文（零额外推理）；"
                              "base = 重新跑一遍当前配置；也可以写某个变体名")
    compare.add_argument("--terms-file", default=None, help="术语清单（一行一个；统计写得对不对）")
    compare.add_argument("--model", default=None, help="覆盖模型名")
    compare.add_argument("--compute-type", default=None, help="覆盖精度")
    compare.add_argument("--device", default="auto", help="auto / cuda / cpu")
    compare.add_argument("--top", type=int, default=40, help="逐段列出变化最大的多少段（缺省 40）")
    compare.add_argument("--out", default=None, help="报告写到哪（缺省 <workdir>/diff.md）")
    shared(compare)

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


def align_by_duration(replay_durs, prod_durs, max_match_ms=1200, gap_ms=700):
    """按**段长序列**把重放切出来的段对齐到产线的句子。

    <p>⚠️ 为什么不能用"第 N 段对第 N 句"（2026-11-13 实测踩到）：产线那次会丢过段
    （静音闸/最短语音把它吃了），于是产线的句子编号本来就有洞（…7, 9, 10…）。
    按序号对会让**从第一个洞开始全部错位一句** —— 而错位表现出来的样子特别坏：
    表里看起来正常，人工照着听、按"对"确认，等于把**别的句子**记成了这一句的真话。
    实测那份 386 段的表里，从第 8 段起就全体错位了一句。

    <p>为什么段长能当指纹：重放用的是**同一段音频、同一套切句参数**，
    所以真正对应的那两句，段长基本相等（毫秒级）。用序列对齐 + 允许两边各有缺口，
    就能把"产线丢了的段"和"重放多出来的段"都摆到正确位置上。

    @returns {list[int|None]} 与 replay_durs 等长：对应 prod_durs 的下标，None = 产线没有这一句
    """
    a = [int(value) for value in replay_durs]
    b = [int(value) for value in prod_durs]
    n = len(a)
    m = len(b)
    if n == 0:
        return []
    if m == 0:
        return [None] * n
    # 动态规划：对角线=配对（代价=段长差，超过 max_match_ms 视为很差的配对），
    # 上/左=某一侧多出来的一段（代价 gap_ms）。
    #
    # 参数是怎么定的（实测，2026-11-13 那场 71 分钟的课）：同一句话在两边段长最多差 ~800ms
    #   —— 前导缓存、句尾裁静音、以及产线的 idle 截断都会让边界差一截。
    # 所以容差取 1200ms（宁可认下差一点的一对，也不要因为差 800ms 就判成"产线没有这一句"），
    # 缺口代价取 700ms：小段（几百毫秒）宁可算缺口，也不能把小段错配到长句上。
    cap = max_match_ms * 2
    inf = float("inf")
    cost = [[inf] * (m + 1) for _ in range(n + 1)]
    move = [[None] * (m + 1) for _ in range(n + 1)]
    cost[0][0] = 0
    for i in range(n + 1):
        for j in range(m + 1):
            here = cost[i][j]
            if here == inf:
                continue
            if i < n and j < m:
                step = min(abs(a[i] - b[j]), cap) + here
                if step < cost[i + 1][j + 1]:
                    cost[i + 1][j + 1] = step
                    move[i + 1][j + 1] = "match"
            if i < n and here + gap_ms < cost[i + 1][j]:
                cost[i + 1][j] = here + gap_ms
                move[i + 1][j] = "drop_replay"
            if j < m and here + gap_ms < cost[i][j + 1]:
                cost[i][j + 1] = here + gap_ms
                move[i][j + 1] = "drop_prod"
    out = [None] * n
    i, j = n, m
    while i > 0 or j > 0:
        step = move[i][j]
        if step == "match":
            # 差得太多就不认这一对（宁可空着，也不要给人工一个错的原话）
            if abs(a[i - 1] - b[j - 1]) <= max_match_ms:
                out[i - 1] = j - 1
            i -= 1
            j -= 1
        elif step == "drop_replay":
            i -= 1
        else:
            j -= 1
    return out


# 产线那几条幻听惯用语（与 whisper_stream.HALLUCINATION_SAMPLES 同源，这里只用来挑可疑段）
SUSPECT_HINTS = ("感谢观看", "中文字幕", "请不吝点赞", "订阅", "thank you for watching",
                 "thanks for watching", "subscribe")


def suspicion_of(row):
    """这一段为什么值得人听一遍（返回原因列表；空列表 = 看起来正常）。

    <p>挑可疑段的三个信号都不需要参考文本：段太短（碎片区）、电平太低（听不清）、
    产线那句本身就像幻听。**排序**用它们，是为了把人工时间花在错得最多的地方；
    但要记住由此抽出来的样本偏难，绝对 CER 会偏高（报告里会写明这一点）。
    """
    reasons = []
    dur = int(row.get("dur_ms") or 0)
    rms = float(row.get("rms") or 0)
    prod = str(row.get("prod") or "")
    if dur < 1200:
        reasons.append("碎片")
    if 0 < rms < 0.055:
        reasons.append("电平低")
    if prod == "":
        reasons.append("产线无此句")
    lowered = prod.lower()
    if any(hint.lower() in lowered for hint in SUSPECT_HINTS):
        reasons.append("像幻听")
    return reasons


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
    # ⚠️ 5.200：给了 --out 就把段放在**表的旁边**。
    # 2026-11-13 实机踩到：--out 指到 /var/lib/leion/test/replay/170359.tsv，
    # 而段默认落到了仓库里的 var/asr-eval/replay/<文件名>/segments/ —— 于是随后
    # compare 按"表旁边的 segments/"去找，报 FileNotFoundError: seg-0001.pcm。
    # 表和段本来就是一个整体（表里写的就是段文件名），不该分居两地。
    if args.workdir:
        workdir = Path(args.workdir)
    elif args.out:
        workdir = Path(args.out).parent
    else:
        workdir = DEFAULT_WORKROOT / track.stem
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

    # 5.191：**按段长对齐**，不是按序号（序号对齐会从产线第一个丢段开始全体错位一句，
    # 而那会让"照听、按对"变成把别的句子记成这一句的真话 —— 实测踩到过）。
    aligned = align_by_duration([one["dur_ms"] for one in segments],
                                [int(row.get("segMs") or 0) for row in meeting])
    if meeting:
        missed_replay = sum(1 for one in aligned if one is None)
        used = {index for index in aligned if index is not None}
        missed_prod = len(meeting) - len(used)
        print(f"[replay] 段长对齐：{len(segments)} 段 ↔ 产线 {len(meeting)} 句"
              f"（重放多出 {missed_replay} 段，产线多出 {missed_prod} 句）")
        # 差得多的配对要列出来：段长差超过 500ms 还硬凑成一对，说明这条对齐不可靠，
        # 而 prod 列是要被人当"这一句的原话"看的 —— 错一句就等于记错一句真话。
        loose = []
        for index, prod_index in enumerate(aligned):
            if prod_index is None:
                continue
            left = int(segments[index]["dur_ms"])
            right = int(meeting[prod_index].get("segMs") or 0)
            if abs(left - right) > 500:
                loose.append((index + 1, int(meeting[prod_index].get("seg")) or 0, left, right))
        if loose:
            print(f"[replay] ⚠️ {len(loose)} 对段长差超过 500ms（边界不完全一样），"
                  f"前 5 对：" + "、".join(f"重放{s}#{a} {b}ms↔产线#{c} {d}ms"
                                          for s, a, b, c, d in [(one[0], one[0], one[2], one[1], one[3])
                                                                for one in loose[:5]]))
            print("[replay]   这些段的 prod 列只能参考；审听时以音频为准")

    rows = []
    for index, one in enumerate(segments, start=1):
        name = f"seg-{index:04d}.pcm"
        write_pcm(segments_dir / name, one["audio"])
        prod = None if aligned[index - 1] is None else meeting[aligned[index - 1]]
        row = {
            "seg": index,
            "file": name,
            "start_ms": one["start_ms"],
            "end_ms": one["end_ms"],
            "dur_ms": one["dur_ms"],
            "rms": round(one["rms"], 4),
            "prodSeg": int(prod.get("seg")) if prod else "",
            "prod": str(prod.get("src") or "") if prod else "",
            "truth": "",
            "reviewed": 0,
        }
        row["suspect"] = "|".join(suspicion_of(row))
        rows.append(row)
    out = Path(args.out) if args.out else (workdir / "sheet.tsv")
    write_sheet(out, rows)
    # 记下段目录的绝对路径：表被挪到别处、或者段被整目录搬走时，工具还能找回来
    try:
        Path(str(out) + ".segments").write_text(str(segments_dir.resolve()) + "\n", encoding="utf-8")
    except OSError:
        pass
    print(f"[replay] 对照表已写出：{out}")
    print(f"[replay] 每段音频在：{segments_dir}")
    print("[replay]   ⚠️ 段目录和对照表必须在一起（compare 默认按「表旁边的 segments/」找）；"
          "要挪就整目录一起挪，或挪完传 --workdir")
    suspicious = sum(1 for row in rows if str(row.get("suspect") or "") != "")
    print(f"[replay] 其中可疑段 {suspicious} 段（碎片 / 电平低 / 产线无此句 / 像幻听）")
    print("[replay] 下一步：跑 review 子命令生成**审听页**（本地浏览器里点着听、点着确认），"
          "或者在 tsv 里手工填 truth 列")
    return 0


def resolve_workdir(sheet_path, given=None):
    """段目录在哪：给的 > 表旁边的 segments/ > sidecar 里记的绝对路径。

    <p>为什么要三层：段和表是**两份东西**，人是会挪的（尤其"表放到数据目录、段留在仓库"）。
    找不到就报一句"缺什么、去哪找"，而不是一个孤零零的 FileNotFoundError。
    """
    candidates = []
    if given is not None:
        candidates.append(Path(given))
    candidates.append(Path(sheet_path).parent)
    sidecar = Path(str(sheet_path) + ".segments")
    if sidecar.exists():
        try:
            recorded = sidecar.read_text(encoding="utf-8").strip()
            if recorded != "":
                candidates.append(Path(recorded).parent)
        except OSError:
            pass
    for one in candidates:
        if (one / "segments").is_dir():
            return one
    return candidates[0]


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

# 这些变体只对 whisper 有意义（精度 / beam / 高通 / VAD / 术语提示词都是它的参数）。
# 2026-11-13 实测踩到：那台机器的 en-US 在策略表里走的是 **parakeet**（.nemo 文件），
# 于是 base 变体把 "/opt/leion/models/parakeet-tdt-0.6b-v2.nemo" 当模型名喂给
# faster-whisper，报的是 huggingface_hub 的 "Repo id must be in the form ..." ——
# 一个和真实原因（引擎不对）毫无关系的错。所以这里必须**先看引擎**。
# 只有 whisper 认的变体（精度 / 解码宽度 / 提示词都是 faster-whisper 的参数）。
WHISPER_ONLY_VARIANTS = ("float16", "int8", "beam8", "terms")
# 5.197 起高通与 VAD 挪到"引擎之前"，**对所有引擎都生效** —— 所以这两个不再是 whisper 专属。
ENGINE_AGNOSTIC_VARIANTS = ("hp0", "hp100", "vad")


def engine_of(profile):
    """策略表里这一路用哪个引擎（空 = whisper）。"""
    return str((profile or {}).get("engine") or "whisper").strip().lower() or "whisper"


def require_engine(args, profile, variant_names):
    """非 whisper 引擎时的处置：要么明确切到 whisper，要么说清为什么不做。

    <p>为什么不让它自动改成 whisper 就跑：那样 base 就悄悄换成了另一个引擎，
    报告会写"base = 产线配置"但实际不是 —— 这种**看起来对、其实换了被测对象**的错，
    比直接报错糟得多。
    """
    engine = engine_of(profile)
    if engine == "whisper":
        return engine
    model = str(profile.get("model") or "")
    whisper_only = [name for name in variant_names if name.strip() in WHISPER_ONLY_VARIANTS]
    # ⚠️ 顺序：先看用户有没有显式 --model（那是**明确要求换引擎**），再看变体需不需要 whisper。
    # 反过来的话，"给了 --model large-v3 但变体只写了 base"会被当成"按表里的引擎跑"，
    # 于是 --model 被静默忽略 —— 又是一次"我明明给了参数却没生效"。
    if args is not None and getattr(args, "model", None):
        print("[replay] ⚠️ 策略表里这一路是 " + engine + "（" + model + "）；"
              "已按 --model 换成 whisper —— 报告里的 base **不是**产线配置", file=sys.stderr)
        return "whisper"
    if not whisper_only:
        # 只要选的变体都是**引擎无关**的（base / hp0 / hp100 / vad），就按表里的引擎跑 ——
        # 5.197 起高通与 VAD 挪到了"引擎之前"，对 parakeet 同样有效，没有理由拒绝。
        print("[replay] 引擎 = " + engine + "（" + model + "，按策略表）", flush=True)
        return engine
    sys.exit(
        "这一路在策略表里走的是 **" + engine + "**（模型 " + model + "），" + "\n" +
        "而这个工具的所有变体（" + " / ".join(WHISPER_ONLY_VARIANTS) + "）都是 **whisper** 的参数。" + "\n" +
        "\n" +
        "两个选择：" + "\n" +
        "  ① 比 whisper 的这几档：加 --model large-v3" + "\n" +
        "     （base 就变成 whisper large-v3；--baseline prod 仍是产线 " + engine + " 当时的原文" + "\n" +
        "       —— 这正好就是「换成 whisper 会不会更好」的 A/B）" + "\n" +
        "  ② 比 " + engine + " 自己的参数：这个工具还没接（要我接就说一声）" + "\n")


def variant_specs(names, profile, terms):
    """把变体名翻译成"覆盖哪些字段"。缺省值全部来自策略表（也就是产线当前配置）。"""
    base = {
        "engine": engine_of(profile),
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


def variant_profile(profile, spec):
    """把"本次改哪些字段"叠到产线那份 profile 上，得到**整份**配置。

    <p>为什么要整份：`ModelPool.get(profile)` 要按 `engine`+`model` 找模型、
    `resolve_engine(profile)` 要按 `engine` 选实现、前置降噪要按 `highpass_hz`/`vad` 决定做不做。
    只传一个"模型名"是不够的（那正是 2026-11-13 把 .nemo 喂给 faster-whisper 的原因）。
    """
    merged = dict(profile or {})
    for key, value in (spec or {}).items():
        if key == "initial_prompt":
            continue                      # 提示词走 CLI，不在 profile 里
        merged[key] = value
    return merged


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
    """读术语清单（**一行一个词**，`#` 开头是注释）。

    <p>⚠️ 这份文件是**使用者自己写的**，仓库里没有、也不会替你生成 —— 它回答的是
    "这节课里会出现哪些行话/专名"，而那个只有讲课的人知道。
    所以这里对"给了一个不存在的路径"要说明白，而不是甩一段 FileNotFoundError：
    它有两个用途，缺了它后果不同（见下），人得知道自己在放弃什么。

    <p>两个用途：
    <ol>
      <li>`--variants` 里有 `terms` 时：这些词会被拼成一句提示词喂给模型
          （**真的改变识别结果**，所以是"被测的对象"）；</li>
      <li>报告里那张「术语命中」表：只统计**写出了正确写法的段数**（**不改识别**，只是记分）。</li>
    </ol>
    """
    if not path:
        return []
    target = Path(path)
    if not target.exists():
        sys.exit("没有这份术语清单：" + str(target) + "\n"
                 "  它是**你自己写的**纯文本（一行一个词，`#` 开头是注释），仓库里没有。\n"
                 "  两个选择：\n"
                 "    ① 建一个：printf '%s\\n' Python interpreter compiler > " + str(target) + "\n"
                 "    ② 不用它：把 --terms-file 去掉，并把 terms 从 --variants 里删掉\n"
                 "       （那就只剩 精度 / beam / 高通 / VAD 这些不依赖术语表的配置）")
    text = target.read_text(encoding="utf-8")
    return [line.strip() for line in text.split("\n")
            if line.strip() != "" and not line.strip().startswith("#")]


class ReplayRunner:
    """按策略表里的 `engine` **真跑**那一路（whisper / parakeet / tencent / funasr）。

    <p>为什么必须复用产线那套：这些引擎各有自己的加载方式与参数语义
    （whisper 是 CTranslate2、parakeet 是 sherpa-onnx/NeMo、云端是 HTTP），
    在工具里重写一份"另一条实现"，量到的就是**两条链之间的差**，不是配置的差。

    <p>踩过的坑（2026-11-13 实机）：工具原来写死 `WhisperModel(profile["model"])`，
    而那台机器 en-US 的策略是 parakeet、模型是 `/opt/leion/models/xxx.nemo` —— 于是
    faster-whisper 把它当 HuggingFace 仓库名，报 `Repo id must be in the form ...`。
    那个报错和真实原因（引擎不对）毫无关系。

    <p>还有一件必须一起做的事：**前置降噪**。产线在引擎分发之前会跑
    `preprocess_segment()`（高通 + VAD 判定，5.197），它对所有引擎生效。
    工具如果跳过它，测的就不是产线那条链。
    """

    def __init__(self, args, np):
        self.args = args
        self.np = np
        _, WhisperModel, _ = whisper_stream.load_dependencies(need_audio=False)
        self.whisper_class = WhisperModel
        # 用产线自己的 parse_args 造一份 CLI 缺省：WhisperEngine 会读 args 里的
        # 若干解码参数（min_logprob / no_speech_prob / no_prompt…），自己拼一份容易漏。
        self.cli = whisper_stream.parse_args([
            "--queue-dir", "var/test/replay-cer", "--device", str(args.device)])
        self.engines = whisper_stream.build_engines(WhisperModel, self.cli)
        self.pool = whisper_stream.ModelPool(
            self.engines, max_models=2, device=str(args.device),
            log=lambda text="": print("[replay] " + str(text), file=sys.stderr))
        self.ready = set()

    def engine_of(self, profile):
        """这一路要用的引擎对象（顺便在第一次遇到时把模型加载好）。"""
        name = str((profile or {}).get("engine") or "whisper").strip().lower() or "whisper"
        engine = whisper_stream.resolve_engine(profile, self.engines)
        if name not in self.ready:
            key = whisper_stream.ModelPool.key_of(profile)
            if key not in self.pool.models:
                print("[replay] 加载 " + name + "：" + str((profile or {}).get("model"))
                      + "（" + str((profile or {}).get("compute_type") or "按引擎缺省") + "）…",
                      flush=True)
            self.pool.get(profile, device=self.args.device)
            self.ready.add(name)
        return engine

    def run(self, audio, profile, lang):
        """跑一段：前置降噪 → 引擎分发 → 识别。返回 (文字, 丢弃原因, 耗时 ms)。"""
        rate = 16000
        processed, dropped = whisper_stream.preprocess_segment(audio, rate, profile, self.np)
        if dropped is not None:
            return "", dropped, 0
        engine = self.engine_of(profile)
        handle = self.pool.get(profile, device=self.args.device)
        started = time.perf_counter()
        outcome = engine.transcribe(handle, processed, lang, profile)
        elapsed = int(round((time.perf_counter() - started) * 1000))
        text = "" if outcome.get("empty") else str(outcome.get("text") or "")
        return text, None, elapsed


def score_variant(runner, refs, workdir, profile, lang, unit):
    """一个变体跑完全部段，返回逐段结果 + 汇总。

    <p>走的是 {@link ReplayRunner}：前置降噪 → 引擎分发 → 识别，与产线同一条链。
    """
    rows = []
    for row in refs:
        audio = read_pcm(workdir / "segments" / row["file"])
        if int(row.get("dur_ms") or 0) <= 0 and audio.size == 0:
            continue
        text, dropped, ms = runner.run(audio, profile, lang)
        scores = asr_score.track_scores(row["truth"], text, unit=unit,
                                        drop_interjections=True, collapse_repeats=True)
        rows.append({
            "seg": row["seg"],
            "reference": row["truth"],
            "hypothesis": text,
            "ms": ms,
            "dropped": dropped,
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


def run_variant(runner, rows, workdir, profile, lang):
    """跑一个配置，返回逐段识别结果（**不打分** —— 这条路的判据是人眼）。"""
    out = []
    for row in rows:
        audio = read_pcm(workdir / "segments" / str(row["file"]))
        if audio.size == 0:
            continue
        text, dropped, ms = runner.run(audio, profile, lang)
        out.append({"seg": int(row["seg"]), "text": text, "ms": ms, "dropped": dropped})
    return out


def diff_markup(base_text, other_text, max_marks=6):
    """把两句的差异标出来（词级/字级 LCS），用 ⟦…⟧ 括住变的部分。

    <p>为什么人眼对比需要它：两句长句里改了一个词，肉眼扫十行也看不出来；
    标出来之后"到底改了哪几个词"一眼就看见 —— 而这正是判断"这组配置有没有用"的全部依据。
    """
    import difflib

    def tokens(text):
        # 中文按字、拉丁按词：这样标记不会把整句都包住
        return re.findall(r"[A-Za-z']+|[^\sA-Za-z']", str(text))

    left = tokens(base_text)
    right = tokens(other_text)
    matcher = difflib.SequenceMatcher(None, left, right)
    pieces = []
    marks = 0
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            pieces.append("".join(left[i1:i2]))
            continue
        if marks < max_marks:
            marks += 1
            changed = "".join(right[j1:j2]) if j2 > j1 else ""
            gone = "".join(left[i1:i2]) if i2 > i1 else ""
            if changed != "" and gone != "":
                pieces.append("⟦" + gone + "→" + changed + "⟧")
            elif changed != "":
                pieces.append("⟦+" + changed + "⟧")
            else:
                pieces.append("⟦-" + gone + "⟧")
        else:
            pieces.append("⟦…⟧")
    return " ".join("".join(pieces).split())


def hallucination_hits(text):
    lowered = str(text).lower()
    return [hint for hint in SUSPECT_HINTS if hint.lower() in lowered]


def count_terms(text, terms):
    """这句里写对了几个术语（人眼报告里最硬的一列：那类同音词到底修好没修好）。"""
    hits = []
    for term in terms:
        if term.strip() == "":
            continue
        if re.fullmatch(r"[A-Za-z][A-Za-z .'-]*", term):
            if re.search(r"(?<![A-Za-z])" + re.escape(term.strip()) + r"(?![A-Za-z])", text, re.I):
                hits.append(term.strip())
        elif term.strip().lower() in str(text).lower():
            hits.append(term.strip())
    return hits


def format_diff_report(args, rows, results, baseline_name, baseline_rows, terms, unit_note):
    """把"几组配置对同一批段"的输出摊成人眼能比的表（**不需要参考文本**）。

    <p>为什么要有这条路：标注几百段真话要几个小时，而"哪组配置更好"这件事，
    大多数时候人眼看三十段对照就能定。代价必须说清：**它给不出错误率**，
    只能看出"变了什么、变得像不像人话、有没有少一句"。
    """
    lines = []
    lines.append("# 免标注对比：同一批段，几组配置的输出并排看\n")
    lines.append("- 对照表：" + str(args.sheet or ""))
    lines.append("- 段数：**" + str(len(rows)) + "**" + unit_note)
    lines.append("- 基线：`" + baseline_name + "`"
                 + ("（对照表里**产线当时**的原文，零额外推理）" if baseline_name == "prod" else ""))
    lines.append("- ⚠️ 这不是错误率：没有参考文本就没有 CER。它回答「变了什么」，不回答「对了几成」。")
    lines.append("")

    by_seg_base = {one["seg"]: one for one in baseline_rows}
    lines.append("| 配置 | 有差异的段 | 变短 / 变长 | 整句变空 | 幻听命中 | 前置 VAD 丢弃 | 平均耗时 | p95 |")
    lines.append("|---|---|---|---|---|---|---|---|")
    detail = {}
    for name, rows_of in results.items():
        changed = []
        shorter = longer = emptied = 0
        halluc = 0
        times = []
        for one in rows_of:
            base = by_seg_base.get(one["seg"])
            if base is None:
                continue
            times.append(one["ms"])
            was = str(base.get("text") or "")
            now = str(one["text"] or "")
            if was.strip() == now.strip():
                continue
            changed.append((one["seg"], was, now))
            if was.strip() != "" and now.strip() == "":
                emptied += 1
            delta = len(now) - len(was)
            if delta < 0:
                shorter += 1
            elif delta > 0:
                longer += 1
            halluc += len(hallucination_hits(now)) - len(hallucination_hits(was))
        times.sort()
        mean_ms = (sum(times) / len(times)) if times else 0
        p95 = asr_score.percentile(times, 0.95) if times else 0
        detail[name] = changed
        # 5.198：前置 VAD 判成"没有人声"而被丢掉、**根本没送去识别**的段数。
        # 这一列必须单独给出来 —— 它是"漏了一句"与"这一段本来没说话"的分界线。
        vad_dropped = sum(1 for one in rows_of if one.get("dropped") is not None)
        lines.append("| `" + name + "` | " + str(len(changed)) + " / " + str(len(rows_of))
                     + " | " + str(shorter) + " / " + str(longer) + " | " + str(emptied)
                     + " | " + ("+" + str(halluc) if halluc >= 0 else str(halluc))
                     + " | " + (str(vad_dropped) if vad_dropped > 0 else "—")
                     + " | {:.0f} ms | {:.0f} ms |".format(mean_ms, p95))
    lines.append("")

    if terms:
        lines.append("## 术语命中（" + str(len(terms)) + " 个词；数的是**写出正确写法的段数**）\n")
        lines.append("| 术语 | " + " | ".join("`" + name + "`" for name in results) + " |")
        lines.append("|---" * (1 + len(results)) + "|")
        for term in terms:
            cells = []
            for name in results:
                hits = sum(1 for one in results[name] if term in count_terms(one["text"], [term]))
                cells.append(str(hits))
            lines.append("| " + term + " | " + " | ".join(cells) + " |")
        lines.append("")

    lines.append("## 逐段对照（变化最大的前 " + str(args.top) + " 段）\n")
    for name, changed in detail.items():
        if not changed:
            lines.append("### `" + name + "`：**一句都没变** —— 这个旋钮在这批音频上没影响\n")
            continue
        scored = []
        for seg, was, now in changed:
            size = abs(len(now) - len(was)) + (200 if now.strip() == "" and was.strip() != "" else 0)
            scored.append((size, seg, was, now))
        scored.sort(reverse=True)
        lines.append("### `" + name + "`（" + str(len(changed)) + " 段有变化）\n")
        for size, seg, was, now in scored[:max(0, int(args.top))]:
            lines.append("- **seg" + str(seg) + "**（听 `segments/seg-" + str(seg).zfill(4) + ".pcm`）")
            lines.append("  - " + baseline_name + "：" + str(was))
            lines.append("  - " + name + "：" + diff_markup(was, now))
        lines.append("")
    lines.append("## 怎么读这张表（以及它骗人的地方）\n")
    lines.append("- **「一句都没变」= 这个旋钮没用**，别为了它再折腾；")
    lines.append("- **变短的段多** → 很可能在吃字；")
    lines.append("- **整句变空** → 那一段被四道闸之一丢掉了，听着像「漏了一句」；")
    lines.append("- **幻听命中变多** → 这组配置更容易编话；")
    lines.append("- 想把它变成**错误率**，就得给几十段填真话（跑 review 子命令，几分钟）。")
    return "\n".join(lines) + "\n"


def command_compare(args):
    workdir = Path(args.workdir) if args.workdir else (Path(args.sheet).parent if args.sheet else None)
    if workdir is None:
        sys.exit("要给 --workdir（切段那个目录）或 --sheet")
    sheet_path = Path(args.sheet) if args.sheet else (workdir / "sheet.tsv")
    if not sheet_path.exists():
        sys.exit("没有对照表：" + str(sheet_path) + "（先跑 sheet 子命令）")
    workdir = resolve_workdir(sheet_path, workdir)
    # 报告里要写出**真正用的**那份表（调用方没给 --sheet 时是推导出来的）
    args.sheet = str(sheet_path)
    rows = read_sheet(sheet_path)
    if not rows:
        sys.exit("对照表是空的")

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
    terms = read_terms(args.terms_file)

    names = [name.strip() for name in str(args.variants).split(",") if name.strip() != ""]
    require_engine(args, profile, names)
    baseline_name = str(args.baseline or "prod")
    baseline_rows = []
    if baseline_name == "prod":
        baseline_rows = [{"seg": int(row["seg"]), "text": str(row.get("prod") or "")}
                         for row in rows]
        if all(one["text"].strip() == "" for one in baseline_rows):
            sys.exit("对照表里 prod 列是空的（跑 sheet 时没给 --meeting-log？）→ 换成 --baseline base")
        print("[replay] 基线 = 产线当时的原文（零额外推理）")
    else:
        names = list(dict.fromkeys(names + [baseline_name]))

    specs = dict(variant_specs(names, profile, terms))
    runner = ReplayRunner(args, np)
    results = {}
    for name, spec in specs.items():
        started = time.perf_counter()
        results[name] = run_variant(runner, rows, workdir, variant_profile(profile, spec), args.lang)
        print("[replay] ▶ " + name + "：" + str(len(results[name])) + " 段，"
              + "{:.0f}s".format(time.perf_counter() - started), flush=True)
        if baseline_name != "prod" and name == baseline_name:
            baseline_rows = results[name]
    if baseline_name != "prod":
        results = {name: value for name, value in results.items() if name != baseline_name}

    note = "（" + ("基线来自产线当时" if baseline_name == "prod" else "基线 " + baseline_name) + "）"
    report = format_diff_report(args, rows, results, baseline_name, baseline_rows, terms, note)
    out = Path(args.out) if args.out else (workdir / "diff.md")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(report, encoding="utf-8")
    print("")
    print("[replay] 对比报告已写出：" + str(out))
    print(report.split("## 逐段对照")[0])
    return 0


def command_score(args):
    refs = [row for row in read_sheet(args.refs) if str(row.get("truth") or "").strip() != ""]
    if not refs:
        sys.exit("对照表里没有一行填了 truth —— 至少填几段再跑（留空的段会被跳过）")
    workdir = resolve_workdir(Path(args.refs), Path(args.workdir) if args.workdir else None)
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
    require_engine(args, profile, str(args.variants).split(","))
    terms = read_terms(args.terms_file)
    specs = variant_specs(args.variants.split(","), profile, terms)

    print(f"[replay] 计分单位 {unit}；{len(refs)} 段；变体 "
          f"{'、'.join(name for name, _spec in specs)}")
    runner = ReplayRunner(args, np)
    results = {}
    base_spec = dict(specs[0][1]) if specs else {}
    for name, spec in specs:
        if name != "base" and dict(spec) == base_spec:
            # 表里本来就是 0 高通 / 没开 VAD 时，"hp0""vad=off" 这类变体与 base 完全一样 ——
            # 不说一句就会被读成"这个旋钮没影响"，其实是"没测到差别"。
            print("[replay] ⚠️ " + name + " 与 base 的配置**完全相同**（表里本来就是这个值）"
                  "→ 它只能证明『没测到差别』，不能证明『没影响』；"
                  "顺带还能验一件事：两边输出应当逐字一致，不一致说明解码有随机性", flush=True)
        one = variant_profile(profile, spec)
        said = ("[replay] ▶ " + name + "：引擎 " + str(one.get("engine") or "whisper")
                 + " / 模型 " + str(one.get("model")) + " / " + str(one.get("compute_type"))
                 + "，beam " + str(one.get("beam_size"))
                 + "，高通 " + format(float(one.get("highpass_hz") or 0.0), "g")
                 + "，VAD " + ("开" if one.get("vad") else "关")
                 + ("，带术语提示词" if spec.get("initial_prompt") else ""))
        print(said, flush=True)
        started = time.perf_counter()
        results[name] = score_variant(runner, refs, workdir, variant_profile(profile, spec),
                                       args.lang, unit)
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
    command = getattr(args, "command", None)
    if command == "sheet":
        return command_sheet(args)
    if command == "compare":
        return command_compare(args)
    return command_score(args)


if __name__ == "__main__":
    sys.exit(main())
