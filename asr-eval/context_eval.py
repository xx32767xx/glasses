#!/usr/bin/env python3
"""
context_eval.py —— 切短、边界、丢上下文到底让口语识别多损失了多少？
========================================================================================

问题（用户提的）：口语那 15~17% 里，有多少是"**切句本身**造成的"？
    同一段话，整段喂进去 vs 切成一句一句喂进去 vs 按**产线切句**喂进去，
    差别有多大？如果差别很大，那优化方向就不是换模型，而是改切句。

做法：**同一段音频、同一个参考、只改"怎么切"**（受控对照，一次只变一个因素）。

    从原始录音（MagicData 31 分钟整场）里取一段**连续**发言，三种喂法：

      A 整段        整段一次识别（保留全部上下文，边界由录音本身给）
      B 官方句边界  按官方逐句时间戳切成一句一句，各自识别后**拼接**
      C 产线切句    用产线上那个 UtteranceSegmenter（**基线档**静音判定 500ms）切，各自识别后拼接

    A−B = 「切短 + 边界 + 丢上下文」的代价
    A−C = 上面这些 + 「产线切句自己的毛病（丢碎片、合并、切错位置）」的代价

⚠️ C 的"基线档"是**改造前的产线参数**（500ms），不是今天的产线（800ms + 上下文续传）——
   它被冻在这里当历史对照的基准，理由见下面 PRODUCTION_SEGMENTER 的注释。

⚠️ 三个必须说清楚的公平性前提（不满足的话这个对照就不成立）：

  1. **参考文本必须覆盖整段音频**。所以选段时要求段内**每一条转写都是"干净"的**
     —— 没有重叠语音 `[+]`、没有"听不清" `[*]`、没有笑声/咳嗽/音乐。
     否则参考里没有的内容，模型从音频里听出来了会被算成插入，A 组白吃亏。
  2. **三种喂法用同一批解码参数**（同一个模型、语种、beam、VAD 设置），
     只改"音频怎么切"。否则量到的是参数差异，不是切句差异。
  3. **拼接不能加分隔符**：中文按字算，拼的时候直接接起来 ——
     加空格会让 B/C 凭空多出"单位"，反而显得更准。

用法
    # 先小跑验证（2 段、small 模型）
    python asr-eval/context_eval.py --count 2 --model small --device cuda

    # 正式：24 段、large-v3（约 10 分钟 GPU）
    python asr-eval/context_eval.py --count 24 --model large-v3 --device cuda \
        --out-json var/asr-eval/results/context_eval__large-v3.json
"""

import argparse
import json
import os
import re
import sys
import time
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent          # 本文件在 asr-eval/ 下
ROOT = HERE.parent                              # 仓库根
sys.path.insert(0, str(HERE))                   # 同层的兄弟模块（asr_score / asr_pack …）
# ⚠️ 依赖方向是**单向**的：评测层可以用 bridge/（产线引擎、共享工具），
#    但 bridge/ 永远不许 import asr-eval/。
sys.path.insert(0, str(ROOT / "bridge"))

# ⚠️ 模型缓存必须指向**仓库里那份**（与 lib/paths.mjs 的 WHISPER_CACHE_DIR 同一个目录）。
#    不指的话 faster-whisper 会去 huggingface 现下：本机直连不通，而且那个过期 token
#    会报一个 401「Repository Not Found」—— 看起来像"模型不存在"，
#    真实原因只是缓存目录没告诉它（这个坑在 scripts/test-asr.mjs 里也踩过、也写了注释）。
#    手动跑这个脚本时没人帮着设环境变量，所以脚本自己设。
os.environ.setdefault("HF_HOME", str(ROOT / "var" / "cache" / "hf"))

from asr_pack import MAGICDATA_DEFAULT, MAGICDATA_EVENTS                      # noqa: E402
from asr_score import (                                                       # noqa: E402
    NORMALIZED_RULES_VERSION, SCORING_RULES_VERSION, error_rate, normalize,
    normalized_error_rate, overall_rate,
)
from whisper_stream import (                                                  # noqa: E402
    LANGUAGE_PROMPTS, UtteranceSegmenter, force_utf8_stdio, looks_like_prompt_echo,
)
from whisper_transcribe import TARGET_RATE                                    # noqa: E402

force_utf8_stdio()


def hint_prompt(language):
    """产线那句语种提示词（**从产线代码取，不另抄一份**）—— 见 `--prod-hint`。"""
    return LANGUAGE_PROMPTS.get(language or "", "") or ""


# ⚠️ **这是"实验基线"，不是当前产线缺省**，两者现在**不一样**，别搞混：
#    · 这里的 500/15000 是**改造前的产线参数**，也是所有已发布对照表里 "C1/现状" 那一列的基准。
#      改它 = 把历史结果全部作废（同一批段、同一个参考的比较就不成立了），所以**故意冻在这里**。
#    · 当前产线是 `--silence-ms 800 --max-speech-ms 30000 --context-depth 2`、
#      中文**不发**语种提示词（见 docs/06 §2 与 docs/14 §6.7.5）。
#    想量"新产线 vs 老产线"就用 `--sweep 800/30000 --prompt-depth 2`（不要带动这个常量）。
PRODUCTION_SEGMENTER = {
    "block_ms": 100,
    "silence_ms": 500,
    "min_speech_ms": 500,        # 短于这个的碎片会被**丢掉**（这正是要量的损失之一）
    "max_speech_ms": 15000,
    "rms_threshold": 0.01,
    "preroll_ms": 250,
    "adaptive": True,
    "short_utterance_ms": 800,
    "short_silence_ms": 1100,
    "cut_pause_ms": 200,
}

FRAGMENT_DROPPED_MS = 500        # 产线会丢掉的碎片长度（用来统计"丢了多少语音"）


def parse_transcript(path):
    """读一场录音的官方逐句转写：`[start,end]\\tspeaker\\t性别,语言\\t文本`。"""
    rows = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.strip() == "":
            continue
        parts = line.split("\t")
        if len(parts) < 4:
            continue
        match = re.match(r"^\[([\d.]+),([\d.]+)\]$", parts[0].strip())
        if match is None:
            continue
        rows.append({
            "start": float(match.group(1)), "end": float(match.group(2)),
            "speaker": parts[1].strip(), "text": "\t".join(parts[3:]).strip(),
        })
    rows.sort(key=lambda row: row["start"])
    return rows


def is_clean(row):
    return not any(event in row["text"] for event in MAGICDATA_EVENTS)


def pick_spans(rows, *, target_seconds, min_seconds, min_utterances, max_gap,
               count, seed):
    """挑出**连续且干净**的段落（段内每条转写都没有事件标记）。

    为什么要"干净"：参考文本必须覆盖整段音频，否则模型从音频里听到而参考里没有的内容
    会被算成插入 —— 那样 A 组（整段）会白吃亏，对照就不公平了。
    """
    spans = []
    index = 0
    while index < len(rows) and len(spans) < count:
        start_row = rows[index]
        if not is_clean(start_row):
            index += 1
            continue
        chosen = [start_row]
        cursor = index + 1
        while cursor < len(rows):
            previous, current = rows[cursor - 1], rows[cursor]
            if not is_clean(current):
                break                                  # 干净段落到此为止
            if current["start"] - previous["end"] > max_gap:
                break                                  # 中间空了太久，不算连续
            if current["end"] - start_row["start"] > target_seconds:
                break
            chosen.append(current)
            cursor += 1
        duration = chosen[-1]["end"] - chosen[0]["start"]
        if duration >= min_seconds and len(chosen) >= min_utterances:
            spans.append({"start": chosen[0]["start"], "end": chosen[-1]["end"],
                          "utterances": chosen, "duration": duration})
            index = cursor
        else:
            index += 1
    return spans


def read_slice(path, start, end):
    """只读原始录音里 [start, end) 那一段（31 分钟的整场不读进内存）。"""
    with wave.open(str(path), "rb") as handle:
        rate, channels, width = handle.getframerate(), handle.getnchannels(), handle.getsampwidth()
        if width != 2:
            sys.exit(f"{path} 不是 16 位 wav（位深 {width * 8}）")
        handle.setpos(int(start * rate))
        frames = handle.readframes(int((end - start) * rate))
    audio = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    return audio, rate


def slice_audio(audio, rate, start, end):
    return audio[int(start * rate):int(end * rate)]


def production_segments(audio, rate, config=None):
    """用**产线那个分段器**切（直接 import 生产类，不复制一份逻辑）。

    `config` 用来做参数扫描：只覆盖其中几项，其余取产线缺省 —— 这样扫出来的
    每一个点都是"同一套产线切句逻辑 + 一个参数不同"，不是两套实现。
    """
    settings = dict(PRODUCTION_SEGMENTER)
    settings.update(config or {})
    segmenter = UtteranceSegmenter(
        rate, settings["block_ms"], settings["silence_ms"],
        settings["min_speech_ms"], settings["max_speech_ms"],
        settings["rms_threshold"], settings["preroll_ms"], np,
        adaptive=settings["adaptive"],
        short_utterance_ms=settings["short_utterance_ms"],
        short_silence_ms=settings["short_silence_ms"],
        cut_pause_ms=settings["cut_pause_ms"],
    )
    found = []
    for index in range(0, len(audio), segmenter.block):
        found.extend(segmenter.push(audio[index:index + segmenter.block]))
    last = segmenter.flush()
    if last is not None:
        found.append(last)
    return found


def parse_sweep(text):
    """解析参数扫描写法：`500,800,1200,2000` 或带上限 `500/15000,800/30000`。

    返回 [{label, silence_ms, max_speech_ms}]。**参数写在命令行里**，
    所以"这一行数字是怎么跑出来的"永远能从命令本身看回来。
    """
    configs = []
    for part in str(text).split(","):
        part = part.strip()
        if part == "":
            continue
        if "/" in part:
            silence, maximum = part.split("/", 1)
        else:
            silence, maximum = part, str(PRODUCTION_SEGMENTER["max_speech_ms"])
        config = {"silence_ms": int(silence), "max_speech_ms": int(maximum)}
        config["label"] = f"C silence {config['silence_ms']} / 上限 {config['max_speech_ms'] // 1000}s"
        configs.append(config)
    return configs


def transcribe_one(model, audio, args, language, prompt=None):
    """识别一段音频；返回 (文本, 耗时)。

    ⚠️ `prompt` 是**唯一允许**在"同一批段的不同喂法"之间变化的东西（上下文续传实验）：
       其余解码参数一律不动，否则量到的是参数差异，不是"补语境"的效果。
       按字算的口径下这个函数也被 `context_overlap.py` 复用（那边自己传 prompt）。
    ⚠️ `--prod-hint` 打开时，**每一种**喂法都先缀上产线那句语种提示词
       （顺序与产线一致：提示词在前、续传文本在后）。
    """
    if getattr(args, "prod_hint", False):
        prompt = hint_prompt(language) + (prompt or "")
    decode = {
        "language": language,
        "beam_size": args.beam_size,
        "vad_filter": args.vad_filter,
        "condition_on_previous_text": False,
        "initial_prompt": prompt,
    }
    start = time.perf_counter()
    segments, _info = model.transcribe(audio, **decode)
    text = " ".join(segment.text.strip() for segment in segments).strip()
    return text, time.perf_counter() - start


def join_texts(texts, unit):
    """把多段识别结果拼成一段。**不加分隔符**（中文按字算，加空格会凭空多出单位）。"""
    if unit == "char":
        return "".join(text.replace(" ", "") for text in texts)
    return " ".join(text.strip() for text in texts if text.strip())


def score(reference, hypothesis, unit):
    strict = error_rate(reference, hypothesis, unit)
    norm = normalized_error_rate(reference, hypothesis, unit)
    return strict, norm


# ── 段清单的**固化**：同一批段要能被反复使用（否则两次跑的数字不可比）──────────
#
# ⚠️ 为什么必须固化：选段是按"连续且干净"算出来的，改一次脚本、改一个默认值，
#    选出来的段就可能变（甚至只是顺序变）。而参数扫描要比较的是**同一个参考上的
#    不同切法** —— 段一变，比较就不成立了。所以：第一次跑把段写成 json，
#    之后每跑一次都从那个 json 读，并检查"用的还是不是同一批"。

def save_spans(path, spans):
    # ⚠️ `pick_spans` 只负责"挑哪几句"，`recording` 是调用方补上的（它得知道是哪场录音）。
    #    缺了就直接报错，不要写成空串 —— 段清单是"可重复执行"的地基，
    #    里面少一个字段会让下次跑出来的是**另一批段**，而且看不出来。
    for span in spans:
        if "recording" not in span:
            raise ValueError("段清单里每条都要有 recording（pick_spans 不产出这个字段，调用方补上）")
    payload = [{"recording": s["recording"], "start": s["start"], "end": s["end"],
                "duration": s["duration"],
                "utterances": [{"start": u["start"], "end": u["end"], "speaker": u["speaker"],
                                "text": u["text"]} for u in s["utterances"]]}
               for s in spans]
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return target


def load_spans(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def spans_digest(spans):
    """段清单的指纹 —— 用来一眼看出"这次跑的参考文本和上次是不是同一批"。"""
    import hashlib
    text = "|".join(f"{s['recording']}:{s['start']:.2f}-{s['end']:.2f}:" +
                    ";".join(u["text"] for u in s["utterances"]) for s in spans)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def main():
    parser = argparse.ArgumentParser(
        description="切短/边界/丢上下文造成的额外损失：整段 vs 官方句边界 vs 产线切句（可做参数扫描）")
    parser.add_argument("--magicdata-dir", default=str(MAGICDATA_DEFAULT))
    parser.add_argument("--split", default="dev", choices=["dev", "test"],
                        help="用哪份原始录音（缺省 dev：调参只看 dev）")
    parser.add_argument("--count", type=int, default=12, help="取几段（缺省 12）")
    parser.add_argument("--target-seconds", type=float, default=30.0,
                        help="每段目标时长（缺省 30 秒）")
    parser.add_argument("--min-seconds", type=float, default=12.0, help="段最短时长")
    parser.add_argument("--min-utterances", type=int, default=4, help="段内至少几句")
    parser.add_argument("--max-gap", type=float, default=2.0,
                        help="句间停顿超过这个就不算「连续」（缺省 2 秒）")
    parser.add_argument("--model", default="large-v3")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--compute-type", default="float16")
    parser.add_argument("--beam-size", type=int, default=5)
    parser.add_argument("--language", default="zh")
    parser.add_argument("--vad-filter", dest="vad_filter", action="store_true", default=True,
                        help="所有喂法都用这个设置（缺省开，与评测口径一致）")
    parser.add_argument("--no-vad-filter", dest="vad_filter", action="store_false",
                        help="关掉内置 VAD（与产线一致）—— 所有喂法仍然一致")
    parser.add_argument("--prod-hint", action="store_true",
                        help="每种喂法都先缀上产线那句语种提示词（配合 --no-vad-filter "
                             "就等于**产线的解码条件**）")
    # 参数扫描：一个值一个点，跑在同一批段、同一个参考上。
    # 写法 `500,800,1200,2000`，或 `500/15000,800/30000`（斜杠后面是句子上限 ms）。
    parser.add_argument("--sweep", default=None,
                        help="产线切句参数扫描，例：500/15000,800/30000,1200/30000,2000/30000")
    # 第二个旋钮：**上下文续传**（把前 N 段的最终文本当提示词喂回去）。
    # 它的收益与"少切一点"是两笔独立的账，所以这里做成"每一档切法再各配一份带提示词的"，
    # 一次跑完就能看出两个旋钮各自值多少、以及叠加是不是真能相加。
    parser.add_argument("--prompt-depth", type=int, default=0,
                        help="把前 N 段的最终文本当提示词（0 = 关，缺省；2 = 前两段）")
    parser.add_argument("--skip-b", action="store_true",
                        help="跳过 B（官方句边界）—— 它与参数无关，扫第二轮时可以省时间")
    # 段清单固化：同一批段能被反复使用（见 save_spans 上面的说明）
    parser.add_argument("--spans-file", default=None,
                        help="段清单 json（缺省 var/asr-eval/spans/context-<split>-<count>.json；"
                             "存在就读它，不存在就挑好之后写下来）")
    parser.add_argument("--refresh-spans", action="store_true",
                        help="忽略已有段清单，重新挑（会覆盖）")
    parser.add_argument("--limit", type=int, default=0,
                        help="只跑前 N 段（冒烟测试用；**段清单本身不动**）")
    parser.add_argument("--show", type=int, default=2, help="打印几段的详细对照")
    parser.add_argument("--out-json", default=None, help="结构化结果写到这里")
    parser.add_argument("--out-md", default=None, help="人读的报告写到这里（Markdown）")
    parser.add_argument("--allow-download", action="store_true",
                        help="允许联网下载模型（**默认不联网**，只用 var/cache/hf 里的）")
    args = parser.parse_args()

    root = Path(args.magicdata_dir)
    partition = root / "DataPartition" / f"{args.split}.tsv"
    if partition.is_file() is False:
        sys.exit(f"找不到官方划分 {partition}（用 --magicdata-dir 指定）")
    wav_dir = root / "MDT2021S003" / "WAV"
    txt_dir = root / "MDT2021S003" / "TXT"

    # ⚠️ 划分文件是「录音名 <TAB> 采样点数」两列 —— 不能按"整行以 .wav 结尾"筛，
    #    那样一行都筛不出来（实测踩到：打印出「0 场原始录音」）。
    recordings = sorted({Path(line.split("\t")[0].strip()).name
                         for line in partition.read_text(encoding="utf-8").splitlines()
                         if line.split("\t")[0].strip().endswith(".wav")})

    # 要跑哪些"喂法"：A 整段、B 逐句切，以及 C 的若干组产线切句参数
    configs = parse_sweep(args.sweep) if args.sweep else [
        dict(PRODUCTION_SEGMENTER,
             label=f"C 产线切句（基线档 silence {PRODUCTION_SEGMENTER['silence_ms']}ms）")]
    modes = [{"key": "A", "label": "A 整段（留全部上下文）", "kind": "whole", "config": None}]
    if not args.skip_b:
        modes.append({"key": "B", "label": "B 官方句边界（逐句切）", "kind": "utterance",
                      "config": None})
    for index, config in enumerate(configs, 1):
        modes.append({"key": f"C{index}", "label": config["label"], "kind": "segmenter",
                      "config": config})
        if args.prompt_depth > 0:
            # 同一档切法再配一份"带提示词续传"的 —— 两个旋钮各自独立，必须能分开看
            modes.append({"key": f"C{index}P", "kind": "segmenter", "config": config,
                          "promptDepth": args.prompt_depth,
                          "label": config["label"] + f" +提示词(前{args.prompt_depth}段)"})

    print("=" * 96)
    print("切短/边界/丢上下文的影响：同一段音频、同一个参考，只改「怎么切」")
    print(f"  语料 MagicData-RAMC {args.split} 划分 · {len(recordings)} 场原始录音")
    print(f"  模型 {args.model} / {args.device} / {args.compute_type} / beam {args.beam_size}"
          f" / vad_filter={args.vad_filter} / 语种 {args.language}")
    print(f"  丢弃 <{PRODUCTION_SEGMENTER['min_speech_ms']}ms 的碎片（产线设置，所有 C 相同）")
    print("  喂法：")
    for mode in modes:
        print(f"    {mode['key']:<4} {mode['label']}")
    print("=" * 96)

    # ── 段清单：存在就用同一批（参数扫描必须如此），不存在就挑好写下来 ─────────
    spans_file = Path(args.spans_file) if args.spans_file else (
        ROOT / "var" / "asr-eval" / "spans" / f"context-{args.split}-{args.count}.json")
    if spans_file.is_file() and not args.refresh_spans:
        spans = load_spans(spans_file)
        print(f"\n段清单：**复用** {spans_file}")
        print(f"  {len(spans)} 段，指纹 {spans_digest(spans)}"
              f"（换一批段会让两次结果不可比，所以这里默认复用）")
    else:
        spans = []
        for recording in recordings:
            transcript = txt_dir / (Path(recording).stem + ".txt")
            if transcript.is_file() is False or (wav_dir / recording).is_file() is False:
                continue
            picked = pick_spans(parse_transcript(transcript),
                                target_seconds=args.target_seconds,
                                min_seconds=args.min_seconds,
                                min_utterances=args.min_utterances, max_gap=args.max_gap,
                                count=args.count - len(spans), seed=0)
            for span in picked:
                span["recording"] = recording
                spans.append(span)
            if len(spans) >= args.count:
                break
        if not spans:
            sys.exit("一段都没挑出来（把 --min-seconds / --min-utterances 放宽试试）")
        save_spans(spans_file, spans)
        print(f"\n段清单：**新挑**并写到 {spans_file}")
        print(f"  {len(spans)} 段，指纹 {spans_digest(spans)}（下次跑会复用这一批）")
    # `--limit` 只截取"这次跑几段"，**不改段清单文件** —— 冒烟测试不该污染固化的输入。
    if args.limit:
        spans = spans[:args.limit]
    # ⚠️ 指纹要报**实际跑的那几段**的：它就是"这批数字对应哪一批样本"的唯一凭据。
    #    （第一版这里报的是文件本身的指纹，而报告里存的是实际跑的那几段 —— 两处对不上。）
    digest = spans_digest(spans)
    if args.limit:
        print(f"  ⚠️ --limit {args.limit}：这次只跑前 {len(spans)} 段"
              f"（段清单文件没动；下面的指纹与报告里记的都是**实际跑的这几段**）")
    print(f"  本次跑 {len(spans)} 段，指纹 {digest}")
    total_seconds = sum(span["duration"] for span in spans)
    print(f"  合计 {total_seconds:.1f} 秒音频、"
          f"{sum(len(s['utterances']) for s in spans)} 句参考")

    # ── 载入模型 ────────────────────────────────────────────────────────────
    from faster_whisper import WhisperModel
    print(f"\n载入模型 {args.model}（device={args.device}, compute_type={args.compute_type}）…")
    try:
        model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type,
                             local_files_only=not args.allow_download)
    except Exception as error:
        sys.exit(f"模型载不进来：{type(error).__name__}: {error}\n"
                 f"  · 缺省只用本地缓存 {os.environ['HF_HOME']}；缓存里没有就加 --allow-download\n"
                 f"  · 想换模型先确认它在 var/cache/hf 里（仓库里现有的是产线在用的那几个）")
    warmup = np.zeros(int(TARGET_RATE * 1.0), dtype=np.float32)
    transcribe_one(model, warmup, args, args.language)      # 预热：第一次推理十几秒
    print("预热完成\n")

    # ── 逐段 × 逐喂法 ───────────────────────────────────────────────────────
    records = []
    for index, span in enumerate(spans, 1):
        audio, rate = read_slice(wav_dir / span["recording"], span["start"], span["end"])
        reference = join_texts([row["text"] for row in span["utterances"]], "char")
        unit = "char"
        entry = {"recording": span["recording"], "start": span["start"], "end": span["end"],
                 "duration": span["duration"], "utterances": len(span["utterances"]),
                 "reference": reference}

        for mode in modes:
            if mode["kind"] == "whole":
                text, used = transcribe_one(model, audio, args, args.language)
                pieces = [{"seconds": len(audio) / rate, "text": text, "used": used}]
            elif mode["kind"] == "utterance":
                pieces = []
                for row in span["utterances"]:
                    piece = slice_audio(audio, rate, row["start"] - span["start"],
                                        row["end"] - span["start"])
                    piece_text, piece_used = transcribe_one(model, piece, args, args.language)
                    pieces.append({"seconds": len(piece) / rate, "text": piece_text,
                                   "used": piece_used})
                text = join_texts([p["text"] for p in pieces], unit)
                used = sum(p["used"] for p in pieces)
            else:
                segments = production_segments(audio, rate, mode["config"])
                pieces = []
                history = []                       # 这一档自己的历史（**不跨档借用**）
                for piece in segments:
                    prompt = None
                    if mode.get("promptDepth"):
                        prompt = "".join(history[-mode["promptDepth"]:]) or None
                    piece_text, piece_used = transcribe_one(model, piece, args, args.language,
                                                            prompt=prompt)
                    if prompt and looks_like_prompt_echo(piece_text, prompt):
                        entry.setdefault("promptEcho", {})
                        entry["promptEcho"][mode["key"]] = entry["promptEcho"].get(mode["key"], 0) + 1
                    history.append(piece_text)
                    pieces.append({"seconds": len(piece) / rate, "text": piece_text,
                                   "used": piece_used})
                text = join_texts([p["text"] for p in pieces], unit)
                used = sum(p["used"] for p in pieces)
            strict, norm = score(reference, text, unit)
            entry[mode["key"]] = {
                "text": text, "segments": len(pieces), "used": used,
                "covered": sum(p["seconds"] for p in pieces),
                "meanSeconds": sum(p["seconds"] for p in pieces) / len(pieces) if pieces else 0.0,
                "meanUsed": used / len(pieces) if pieces else 0.0,
                **strict, "normalized": norm,
            }
        records.append(entry)
        preview = "  ".join(f"{m['key']} {entry[m['key']]['rate'] * 100:5.1f}%"
                            + (f"({entry[m['key']]['segments']}段)"
                               if m["kind"] == "segmenter" else "")
                            for m in modes)
        print(f"  #{index:<3} {span['recording'][:30]:<30} {preview}")

    # ── 汇总 ────────────────────────────────────────────────────────────────
    def summarize(mode):
        rows = [{"units": r[mode["key"]]["units"], "distance": r[mode["key"]]["distance"],
                 "substitutions": r[mode["key"]]["substitutions"],
                 "deletions": r[mode["key"]]["deletions"],
                 "insertions": r[mode["key"]]["insertions"]} for r in records]
        rate, units, distance, sdi = overall_rate(rows)
        norm_rate, _nu, _nd, _nsdi = overall_rate([r[mode["key"]]["normalized"] for r in records])
        segments = sum(r[mode["key"]]["segments"] for r in records)
        covered = sum(r[mode["key"]]["covered"] for r in records)
        mean_used = (sum(r[mode["key"]]["used"] for r in records) / segments) if segments else 0.0
        silence_ms = (mode["config"] or {}).get("silence_ms")
        return {
            "key": mode["key"], "label": mode["label"], "rate": rate, "normalized": norm_rate,
            "units": units, "distance": distance, "sdi": sdi, "segments": segments,
            "meanSegmentsPerSpan": segments / len(records),
            "meanSegmentSeconds": covered / segments if segments else 0.0,
            "coverage": covered / total_seconds if total_seconds else 0.0,
            "meanUsedPerSegment": mean_used,
            # 等待时间**估算**：说话人停下 → 等 silence_ms 判定句子结束 → 识别这一段。
            # A/B 不是产线能用的喂法，所以不报等待（None）。
            "waitSeconds": ((silence_ms / 1000.0) + mean_used) if silence_ms else None,
        }

    summary = [summarize(mode) for mode in modes]
    baseline = next((s for s in summary if s["key"] == "A"), summary[0])
    # ⚠️ 基准是**最碎的那一档**（silence 最小），不是列表里最后一行 ——
    #    第一版写成"最后一行"，于是"比最碎好"和"多等"两列的符号全反了（smoke test 抓到）。
    c_modes = [s for s in summary if s["key"].startswith("C")]
    terse = min(c_modes, key=lambda s: (s["key"] != "C1", s["key"])) if c_modes else None

    print("\n" + "=" * 96)
    print("汇总（同一批音频、同一个参考、同一套解码参数，只改「怎么切」）")
    print("=" * 96)
    header = (f"{'喂法':<34}{'严格':>8}{'规范化':>8}{'S':>6}{'D':>6}{'I':>6}"
              f"{'段数':>6}{'平均段长':>9}{'覆盖':>7}{'等待*':>8}{'vs A':>8}")
    print(header)
    print("-" * len(header))
    for item in summary:
        delta = (item["rate"] - baseline["rate"]) * 100
        wait = f"{item['waitSeconds']:.2f}s" if item["waitSeconds"] else "—"
        print(f"{item['label']:<34}{item['rate'] * 100:>7.1f}%{item['normalized'] * 100:>7.1f}%"
              f"{item['sdi'][0]:>6}{item['sdi'][1]:>6}{item['sdi'][2]:>6}"
              f"{item['segments']:>6}{item['meanSegmentSeconds']:>8.1f}s"
              f"{item['coverage'] * 100:>6.1f}%{wait:>8}{delta:>+7.1f}p")
    print("-" * len(header))
    print("  * 等待 = silence_ms（判定句子结束要等的时间）+ 平均识别耗时/段 —— **估算**，不是端到端实测。")
    print("  ⚠️ A/B 不是产线能用的喂法（流式必须切），它们只用来给 C 当参照。")

    if terse and len(c_modes) > 1:
        print(f"\n「少切一点」的取舍（以最碎的那一档为基准：{terse['label']}）")
        print(f"  {'配置':<40}{'错误率':>9}{'比最碎好':>10}{'等待':>9}{'多等':>8}  值不值")
        for item in c_modes:
            gain = (terse["rate"] - item["rate"]) * 100
            extra = (item["waitSeconds"] or 0.0) - (terse["waitSeconds"] or 0.0)
            verdict = ("**划算**" if gain > 0.5 and extra <= 0.5
                       else "要权衡" if gain > 0.5
                       else "更差" if gain < -0.5 else "持平")
            print(f"  {item['label']:<40}{item['rate'] * 100:>8.1f}%{gain:>+9.1f}p"
                  f"{item['waitSeconds'] or 0.0:>8.2f}s{extra:>+7.2f}s  {verdict}")

    # ── 两个旋钮各自的账（有提示词档时才打）───────────────────────────────────
    # 为什么单独打这一块：**"少切一点"（切得多长）与"提示词续传"（给不给上下文）是两笔
    # 独立的账**，混在一张按 label 排序的表里看不出"叠加到底是不是真能相加"。
    plain = next((s for s in c_modes if s["key"] == "C1"), None)
    prompted = {s["key"]: s for s in c_modes if s["key"].endswith("P")}
    if plain and prompted:
        print("\n两个旋钮各自的账（都是相对**现状** C1：逐段独立、无提示词）")
        print(f"  {'改动':<44}{'错误率':>9}{'收益':>9}{'等待':>9}")
        rows = [("（现状）", plain["rate"], 0.0, plain["waitSeconds"])]
        for key, item in prompted.items():
            if key[:-1] == "C1":
                rows.append((f"只加提示词（前 {args.prompt_depth} 段）", item["rate"],
                             (plain["rate"] - item["rate"]) * 100, item["waitSeconds"]))
        for item in c_modes:
            if item["key"].endswith("P") or item["key"] == "C1":
                continue
            rows.append((f"只少切（{item['label']}）", item["rate"],
                         (plain["rate"] - item["rate"]) * 100, item["waitSeconds"]))
        both = prompted.get("C2P")
        if both:
            rows.append(("两个都上（少切 + 提示词）", both["rate"],
                         (plain["rate"] - both["rate"]) * 100, both["waitSeconds"]))
        for label, rate, gain, wait in rows:
            print(f"  {label:<44}{rate * 100:>8.1f}%{gain:>+8.1f}p{wait or 0.0:>8.2f}s")
        # 是否可加：两笔账相加 vs 实际叠加
        only_prompt = next(((p["rate"] - plain["rate"]) * 100 for k, p in prompted.items()
                            if k[:-1] == "C1"), None)
        only_cut = next(((i["rate"] - plain["rate"]) * 100 for i in c_modes
                         if i["key"] == "C2"), None)
        if only_prompt is not None and only_cut is not None and both:
            actual = (both["rate"] - plain["rate"]) * 100
            print(f"  → 两笔账相加 = {only_prompt + only_cut:+.1f}p，"
                  f"实际叠加 = {actual:+.1f}p，"
                  f"{'基本可加' if abs(actual - (only_prompt + only_cut)) < 1.0 else '**不可加**（有重叠）'}")
        echoes = sum(r.get("promptEcho", {}).get(key, 0) for r in records for key in prompted)
        print(f"  ⚠️ 提示词回显（产线那道闸判定）: {echoes} 次"
              f"（闸的阈值是按 17 字短提示词调的，提示词变长它会变松 —— 见 docs/14 §6.7.2）")
        print(f"    提示词内容量：每段多喂前 {args.prompt_depth} 段的文本，"
              f"**不增加音频量、不增加等待**")

    if args.show:
        print("\n" + "=" * 96)
        print(f"逐段对照（前 {min(args.show, len(records))} 段）")
        print("=" * 96)
        for record in records[:args.show]:
            print(f"\n{record['recording']}  {record['start']:.1f}–{record['end']:.1f}s"
                  f"（{record['duration']:.1f}s / {record['utterances']} 句）")
            print(f"  参考 {record['reference']}")
            for mode in modes:
                print(f"  {mode['key']:<4} {record[mode['key']]['text']}")

    # ── 落盘：结构化 + 人读 ─────────────────────────────────────────────────
    payload = {
        "config": {
            "split": args.split, "spansFile": str(spans_file), "spansDigest": spans_digest(spans),
            "spans": len(spans), "totalSeconds": total_seconds, "model": args.model,
            "device": args.device, "computeType": args.compute_type,
            "beamSize": args.beam_size, "language": args.language, "vadFilter": args.vad_filter,
            "prodHint": bool(getattr(args, "prod_hint", False)),
            "hintPrompt": (hint_prompt(args.language)
                           if getattr(args, "prod_hint", False) else None),
            "promptDepth": args.prompt_depth,
            "scoringRules": SCORING_RULES_VERSION, "normalizedRules": NORMALIZED_RULES_VERSION,
            "segmenterBase": PRODUCTION_SEGMENTER,
            "modes": [{k: m[k] for k in ("key", "label", "kind", "config")} for m in modes],
            "rerun": "python asr-eval/context_eval.py --spans-file " + str(spans_file)
                     + (f" --sweep {args.sweep}" if args.sweep else "")
                     + (f" --prompt-depth {args.prompt_depth}" if args.prompt_depth else "")
                     + (" --no-vad-filter --prod-hint" if getattr(args, "prod_hint", False) else "")
                     + f" --model {args.model} --device {args.device}"
                     + f" --compute-type {args.compute_type}",
        },
        "summary": summary,
        "records": records,
    }
    if args.out_json:
        target = Path(args.out_json)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n结构化结果已写到 {target}")
    if args.out_md:
        target = Path(args.out_md)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(render_report(payload), encoding="utf-8")
        print(f"人读报告已写到   {target}")
    return 0


def render_report(payload):
    """生成**能直接看的** Markdown 报告：结论、取舍表、逐段明细、怎么重跑。"""
    config, summary, records = payload["config"], payload["summary"], payload["records"]
    baseline = next((s for s in summary if s["key"] == "A"), summary[0])
    c_modes = [s for s in summary if s["key"].startswith("C")]
    b_mode = next((s for s in summary if s["key"] == "B"), None)
    lines = []
    lines.append("# 切句代价实验（整段 / 逐句切 / 产线切句参数扫描）\n")
    lines.append(f"- 语料：MagicData-RAMC **{config['split']}** 划分，{config['spans']} 段"
                 f"（{config['totalSeconds']:.0f} 秒）")
    lines.append(f"- 模型：{config['model']} / {config['device']} / {config['computeType']}"
                 f" / beam {config['beamSize']} / vad_filter={config['vadFilter']}"
                 f" / 语种 {config['language']}")
    lines.append(f"- 段清单：`{config['spansFile']}`（指纹 `{config['spansDigest']}`）"
                 f"—— **同一批段**，所以两次跑的数字可比")
    lines.append(f"- 评分：严格 `{config['scoringRules']}` + 规范化 `{config['normalizedRules']}`")
    lines.append(f"- 重跑命令：`{config['rerun']}`\n")
    lines.append("## 汇总\n")
    lines.append("| 喂法 | 严格 | 规范化 | S | D | I | 段数 | 平均段长 | 覆盖 | 等待* | vs A |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|---|")
    for item in summary:
        wait = f"{item['waitSeconds']:.2f}s" if item["waitSeconds"] else "—"
        delta = f"{(item['rate'] - baseline['rate']) * 100:+.1f}p"
        lines.append(f"| {item['label']} | **{item['rate'] * 100:.1f}%** | "
                     f"{item['normalized'] * 100:.1f}% | {item['sdi'][0]} | {item['sdi'][1]} | "
                     f"{item['sdi'][2]} | {item['segments']} | "
                     f"{item['meanSegmentSeconds']:.1f}s | {item['coverage'] * 100:.1f}% | "
                     f"{wait} | {delta} |")
    lines.append("\n\\* 等待 = silence_ms（判定句子结束要等的时间）+ 平均识别耗时/段 —— "
                 "**估算**，不是端到端实测。A/B 不是产线能用的喂法，所以不报等待。\n")
    if len(c_modes) > 1:
        lines.append("## 「少切一点」的取舍\n")
        terse = c_modes[0]
        lines.append(f"以最碎的那一档（{terse['label']}）为基准：\n")
        lines.append("| 配置 | 严格错误率 | 比最碎好 | 等待 | 多等 | 值不值 |")
        lines.append("|---|---|---|---|---|---|")
        for item in c_modes:
            gain = (terse["rate"] - item["rate"]) * 100
            wait_now = item["waitSeconds"] or 0.0
            wait_base = terse["waitSeconds"] or 0.0
            extra = wait_now - wait_base
            verdict = "持平"
            if gain > 0.5 and extra <= 0.5:
                verdict = "**划算**"
            elif gain > 0.5:
                verdict = "要权衡"
            elif gain < -0.5:
                verdict = "更差"
            lines.append(f"| {item['label']} | {item['rate'] * 100:.1f}% | {gain:+.1f}p | "
                         f"{wait_now:.2f}s | {extra:+.2f}s | {verdict} |")
        lines.append("")
    if b_mode:
        lines.append("## 两个参照点\n")
        lines.append(f"- **A 整段 {baseline['rate'] * 100:.1f}%**：不切的**上界**（产线做不到，流式必须切）")
        lines.append(f"- **B 逐句切 {b_mode['rate'] * 100:.1f}%**：按官方句边界切，"
                     f"代表「切得最符合语言单位」的那种切法")
        lines.append("")
    lines.append("## 逐段明细\n")
    keys = [item["key"] for item in summary]
    lines.append("| 录音 | 时间 | 秒 | 句 | 参考字 | " + " | ".join(keys) + " |")
    lines.append("|---|---|---|---|---|" + "---|" * len(keys))
    for record in records:
        cells = " | ".join(f"{record[key]['rate'] * 100:.0f}%" for key in keys)
        lines.append(f"| {record['recording']} | {record['start']:.0f}–{record['end']:.0f}s | "
                     f"{record['duration']:.0f} | {record['utterances']} | "
                     f"{len(record['reference'])} | {cells} |")
    lines.append("\n## 样本（每段原文与各喂法输出）\n")
    for index, record in enumerate(records, 1):
        lines.append(f"### {index}. {record['recording']} {record['start']:.0f}–{record['end']:.0f}s"
                     f"（{record['duration']:.1f}s）\n")
        lines.append(f"- 参考　{record['reference']}")
        for item in summary:
            lines.append(f"- {item['key']}　{record[item['key']]['text']}")
        lines.append("")
    lines.append("## 边界（读这些数字前必须知道）\n")
    lines.append("1. 三种喂法用的是**同一个模型、同一套解码参数**，只改「音频怎么切」——"
                 "量的是切句代价，不是模型好坏。")
    lines.append("2. **A 不是产线能做到的**（流式必须切），它只是「不切能有多好」的上界；"
                 "Whisper 感受野本来就是 30 秒窗，所以 A 与 B/C 的差别是"
                 "「一段话 vs 一句一句」，不是「无限上下文」。")
    lines.append("3. **等待是估算**：`silence_ms` + 平均识别耗时/段，不含网络与翻译。"
                 "端到端延迟要另测（见 docs/14 §5.2 对「这批属于哪种模式」的说明）。")
    lines.append("4. 样本量有限（见上），逐段方差大，所以只看**量级与方向**，别当精确值。")
    return "\n".join(lines) + "\n"

if __name__ == "__main__":
    sys.exit(main())
