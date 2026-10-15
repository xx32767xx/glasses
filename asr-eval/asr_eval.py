#!/usr/bin/env python3
"""
asr_eval.py —— 用带标准答案的葡语音频，测出"识别得准不准"
========================================================================================
中文那边我们靠耳朵就能判断对不对，葡语不行 —— 用户不会葡语，我也不能靠"看着像"下结论。
所以这里换一种做法：**用带参考文本的公开数据集，算词错率 WER**。

数据来源
    Google FLEURS 的巴西葡语（pt_br）验证集，CC-BY-4.0。
    FLEURS 是"朗读"语音：每条都是一个人念一句书面语，附官方参考文本。
    在 HuggingFace 上以 parquet 形式提供（音频以字节内嵌，一个文件装完整个 split）。

    https://huggingface.co/datasets/google/fleurs

    ⚠️ 必须说清楚：这是**朗读**语音，不是"会议室里真人对话"。
       朗读更清晰、更慢、没有抢话和背景人声，所以这里的 WER 是**乐观下界**，
       真实会议只会更差。但"乐观下界都很差"本身就足以否掉一个模型。

关键指标 WER（Word Error Rate，词错率）
    WER = (替换 + 删除 + 插入) / 参考词数
      0%      完全正确
      <10%    很好，用于字幕基本不影响理解
      10-20%  可用，但需要靠上下文/翻译模型兜一下
      >30%    不可用 —— 错误多到会改变句子意思
    数字可能超过 100%（插入太多时），那不是 bug。

用法
    # 第一步：把 parquet 里的音频抽成一小批 wav + 参考文本（只做一次）
    python asr-eval/asr_eval.py --parquet var/cache/fleurs/pt_br_validation.parquet --extract

    # 第二步：拿抽出来的这批音频测某个模型
    python asr-eval/asr_eval.py --set var/asr-eval/packs/pt-eval --model small --device cuda --compute-type float16
"""

import argparse
import hashlib
import io
import json
import re
import subprocess
import sys
import time
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent          # 本文件在 asr-eval/ 下
ROOT = HERE.parent                              # 仓库根
sys.path.insert(0, str(HERE))                   # 同层的兄弟模块（asr_score …）
# ⚠️ 依赖方向是**单向**的：评测层可以用 bridge/ 里的共享工具（whisper_transcribe 的
#    解码器、whisper_stream 的语种解析），但 bridge/ **永远不许** import asr-eval/。
sys.path.insert(0, str(ROOT / "bridge"))
from whisper_transcribe import TARGET_RATE, decode_with_av   # noqa: E402
from whisper_stream import parse_lang_candidates             # noqa: E402
from asr_score import (                                       # noqa: E402
    NORMALIZED_RULES_VERSION, SCORING_RULES_VERSION, TRADITIONAL_ONLY, count_traditional,
    error_rate, key_term_hits, negation_flags, normalize, normalized_error_rate,
    numeric_report, overall_rate, percentile,
)


def parse_args(argv=None):
    """argv 可传（缺省读 sys.argv）—— 与 whisper_stream.parse_args 同一个形状，
    这样测试才能直接断言"缺省值到底是什么 / 写错了会不会报错"，而不是靠人读源码。"""
    parser = argparse.ArgumentParser(description="用带参考文本的音频测错误率（中文 CER / 葡语 WER）与延迟")
    parser.add_argument("--parquet", help="FLEURS parquet 文件（--extract 时用）")
    parser.add_argument("--set", dest="wavset", help="抽好的测试集目录（测错误率时用）")
    parser.add_argument("--out", default=None,
                        help="抽取到哪里，缺省 <parquet 同目录>/<语料名>-eval")
    parser.add_argument("--count", type=int, default=30, help="抽/测多少条（缺省 30）")
    parser.add_argument("--extract", action="store_true", help="只抽取音频与参考文本，不跑模型")
    parser.add_argument("--unit", default="auto", choices=["auto", "char", "word"],
                        help="错误率单位：auto（缺省，中文自动按字）/ char / word。"
                             "中文必须按字 —— 没有空格分词，按词算整句就是一个 token，"
                             "错一个字和整句全错得到一样的结果")
    parser.add_argument("--model", default="small")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--language", default=None,
                        help="固定语种（zh / pt）；缺省限定在 --lang-candidates 里挑")
    parser.add_argument("--lang-candidates", default="zh,pt",
                        help="不指定语种时的候选集（逗号分隔，缺省 zh,pt；空串=不限定，"
                             "回到「99 种里挑最大」—— 那正是会挑出 he 的旧行为）")
    parser.add_argument("--beam-size", type=int, default=5, help="缺省 5（与生产链路一致）")
    # ⚠️ 这两个开关是"评测与产线不一致"查出来的，见 docs/14 §5.4：
    #    产线 whisper_stream.py 是 `vad_filter=False`（它自己已经按能量切好了），
    #    而且**默认会发语种提示词**（zh: 请用简体中文输出 / pt: 巴西葡语）。
    #    评测这边原来一直是 `vad_filter=True` 且**不发提示词** ——
    #    也就是说"基线"其实不是在产线的解码参数下测的。老师要求"保留现有解码参数"，
    #    所以把这两项做成显式开关，两种配置都要能跑、并在 provenance 里记下来。
    parser.add_argument("--vad-filter", dest="vad_filter", action="store_true", default=True,
                        help="用 faster-whisper 内置的 Silero VAD 再切一遍（缺省开；"
                             "**产线是关的**，因为它自己已经切好了）")
    parser.add_argument("--no-vad-filter", dest="vad_filter", action="store_false",
                        help="关掉内置 VAD —— 与产线一致，做产线口径的基准时要用这个")
    parser.add_argument("--no-normalize", action="store_true",
                        help="不做峰值归一化（缺省做，与生产链路一致）")
    parser.add_argument("--initial-prompt", default=None,
                        help="提示词（缺省不发，与生产链路一致）")
    parser.add_argument("--show", type=int, default=5, help="打印前几条对照（缺省 5）")
    # 规范化口径（asr-norm-v1）**始终**与严格口径一起算（两条一起报才有意义），
    # 这两个开关只决定"要不要额外放宽"——默认都不开，因为两条规则都不安全：
    #   · 删感叹词：`嗯/呃` 漏掉用户是听得出来的（字幕变硬），而且 `啊/呀/吧/呢/嘛` 带语气；
    #   · 折叠重复：中文里 `看看` `说说` `慢慢` 是**正常词**，折叠会把真漏字盖掉。
    parser.add_argument("--norm-interjections", action="store_true",
                        help="规范化口径里顺带删掉纯感叹词（嗯/呃/哦…）—— **默认不删**")
    parser.add_argument("--norm-collapse-repeats", action="store_true",
                        help="规范化口径里折叠相邻重复 —— **默认不折叠**（「看看」是正常词）")
    parser.add_argument("--out-json", default=None,
                        help="把结构化结果写到这里（供 asr-eval/test-asr.mjs 汇总用）。"
                             "只增加输出，不改任何计算逻辑 —— 这样两边的口径永远一致")
    # 调参通道：faster-whisper 有 35 个可调参数，逐个加命令行开关既啰嗦、又永远加不全。
    # 给一个 JSON 通道，把任意参数透传进 transcribe()，并记进 provenance。
    #
    # ⚠️ 参数名写错必须**明确报错**，不能静默忽略 —— 否则"我调了那个参数"会变成一句空话，
    #    实验结论就建立在"其实没生效"的配置上。这个项目已经栽过同类跟头（护栏悄悄失效）。
    parser.add_argument("--decode-json", default=None,
                        help="透传给 transcribe() 的参数（JSON）。例："
                             "'{\"no_speech_threshold\": null, \"log_prob_threshold\": -2.0}'")
    args = parser.parse_args(argv)

    # 解析并校验候选语种。
    # ⚠️ 这里原来把 `--lang-candidates` 的**原始字符串**直接拿去用，两处都错：
    #    · provenance 里 `list("zh,pt")` 记成 ['z','h',',','p','t']（记错了配置）；
    #    · 挑语种时 `code in "zh,pt"` 是**子串**匹配而不是"在候选集里"。
    #    现在两边共用产线那个解析函数，语义不可能再漂 —— 而"评测口径 = 产线口径"
    #    正是这些数字能不能代表产线的全部依据。写错语种码一律**明确报错**。
    try:
        args.lang_candidates = parse_lang_candidates(args.lang_candidates)
    except ValueError as error:
        parser.error(str(error))

    # 解析并校验透传参数
    args.decode = {}
    if args.decode_json:
        try:
            parsed = json.loads(args.decode_json)
        except Exception as error:
            parser.error(f"--decode-json 不是合法 JSON：{error}")
        if not isinstance(parsed, dict):
            parser.error("--decode-json 必须是一个 JSON 对象")
        import inspect as _inspect

        from faster_whisper import WhisperModel as _WhisperModel

        allowed = set(_inspect.signature(_WhisperModel.transcribe).parameters)
        unknown = [key for key in parsed if key not in allowed]
        if unknown:
            parser.error(f"--decode-json 里有 transcribe() 不认的参数：{unknown}")
        args.decode = parsed
    return args


# ── 错误率：中文按**字**，葡语按**词** ────────────────────────────────────────
#
# 为什么必须分两种单位：中文不用空格分词。按"词"算的话，整句就是一个 token，
# 错一个字和整句全错得到的数字一样（要么 0、要么 1）—— 完全没法用来调参。
# 所以中文按**字**算 CER（Character Error Rate），葡语按词算 WER。

# 只在繁体里出现的常用字。用来把"输出成繁体"这个已知毛病**量化**出来 ——

CJK = re.compile(r"[\u4e00-\u9fff]")


def looks_chinese(text):
    """这段参考文本是不是中文？（用来决定按字还是按词算）

    门槛刻意放到"至少 2 个汉字" —— 短句也要算中文。
    第一版写的是 `cjk >= 4`，结果「你好」这种两字短句被判成"不是中文"，
    单位退回 word，整句变成一个 token，错误率就失去意义了（一条两字句测出来的
    不是 0% 就是 100%）。
    """
    if not text:
        return False
    stripped = text.strip()
    cjk = len(CJK.findall(stripped))
    return cjk >= 2 and cjk / max(1, len(stripped)) > 0.3


def detect_unit(reference_texts):
    """auto：中文 → char，其它 → word。"""
    samples = [t for t in reference_texts if t and t.strip()]
    if not samples:
        return "word"
    chinese = sum(1 for t in samples if looks_chinese(t))
    return "char" if chinese * 2 > len(samples) else "word"


# ⚠️ 评分相关的实现（normalize / count_traditional / error_rate / edit_distance）
#    **已经搬到 asr-eval/asr_score.py**，理由写在那里：评分规则要冻结、带版本号、能被逐条测试。
#    这里只从那边 import 再转出来 —— 以前 `asr_eval.error_rate` 是 3 元组，
#    现在统一成 dict（多了替换/删除/插入），segment_eval.py 已跟着改。
#    ⚠️ **绝对不要在本文件里重新定义这些函数**：定义了就会把 import 进来的**盖掉**，
#    于是"用新评分"变成"看着像用新评分、其实还是旧的" —— 我这一版就是这么错了一次。


# ── 抽取测试集 ───────────────────────────────────────────────────────────────

def load_wav_bytes(data):
    """parquet 里内嵌的是 wav 字节。

    注意：FLEURS 的 wav 是 **32-bit 浮点**（wFormatTag=3），标准库的 wave 模块读不了 ——
    所以这里交给 PyAV 解码，而不是自己解析 RIFF 头。
    """
    return decode_with_av(io.BytesIO(data), container_format="wav")


def extract(args):
    import pyarrow.parquet as pq

    source = Path(args.parquet)
    if not source.is_file():
        sys.exit(f"找不到 parquet：{source}")
    # 缺省抽到 parquet 同目录下一个以语料名命名的子目录（如 cmn_hans_cn-eval）。
    # 实际用的时候建议显式 --out（文档里的命令都带着），免得找不着。
    stem = re.sub(r"_(validation|test|train)$", "", source.stem)
    target = Path(args.out) if args.out else source.parent / f"{stem}-eval"
    target.mkdir(parents=True, exist_ok=True)

    table = pq.read_table(source, columns=["audio", "raw_transcription", "transcription", "gender"])
    rows = table.to_pylist()[: args.count]
    manifest = []
    for index, row in enumerate(rows):
        samples = load_wav_bytes(row["audio"]["bytes"])
        name = f"{stem}-{index:03d}.wav"
        pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2")
        with wave.open(str(target / name), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(TARGET_RATE)
            handle.writeframes(pcm.tobytes())
        manifest.append({
            "file": name,
            "seconds": round(len(samples) / TARGET_RATE, 2),
            "reference": row["raw_transcription"],
        })

    with open(target / "manifest.jsonl", "w", encoding="utf-8") as handle:
        for item in manifest:
            handle.write(json.dumps(item, ensure_ascii=False) + "\n")

    total = sum(item["seconds"] for item in manifest)
    print(f"抽出 {len(manifest)} 条，共 {total:.1f} 秒 → {target}")
    print(f"参考文本写在 {target / 'manifest.jsonl'}")
    print("")
    for item in manifest[:5]:
        print(f"  [{item['seconds']:5.2f}s] {item['reference'][:88]}")
    return 0


# ── 评测 ─────────────────────────────────────────────────────────────────────

def read_manifest(wavset):
    path = Path(wavset)
    manifest = Path(wavset) / "manifest.jsonl"
    if not manifest.is_file():
        sys.exit(f"没找到 {manifest}（先用 --extract 抽一批）")
    items = []
    for line in manifest.read_text(encoding="utf-8").splitlines():
        if line.strip():
            items.append(json.loads(line))
    return path, items


def run_provenance(args, wavset, items, unit):
    """把"这次运行到底是什么配置"固化下来。

    老师 §六 的要求：每次运行绑定 **代码 / 模型 / 提示词 / 参数 / 数据清单 / 评分规则版本**。
    为什么要这么细：报告一旦离开现场，"这个 12.2% 是哪一版代码、哪个模型、哪批数据算的"
    就没人说得清 —— 而过几周连自己都记不住。git 提交号与数据清单指纹能让它可复现。
    """
    manifest = Path(wavset) / "manifest.jsonl"
    digest = hashlib.sha256()
    if manifest.is_file():
        digest.update(manifest.read_bytes())
    commit = None
    try:
        commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=str(HERE.parent),
                                capture_output=True, text=True, timeout=5).stdout.strip() or None
    except Exception:
        commit = None
    return {
        "codeCommit": commit,
        "scoringRules": SCORING_RULES_VERSION,
        # 两套口径都记下来：结果文件里同时有严格分与规范分，
        # 所以"这一版是按哪套规则算的"永远说得清（老师要求规则绑定版本号）。
        "normalizedRules": NORMALIZED_RULES_VERSION,
        "normalizedOptions": {"dropInterjections": bool(args.norm_interjections),
                              "collapseRepeats": bool(args.norm_collapse_repeats)},
        "model": args.model,
        "device": args.device,
        "computeType": args.compute_type,
        "beamSize": args.beam_size,
        "language": args.language,
        "langCandidates": list(args.lang_candidates) if args.lang_candidates else None,
        "initialPrompt": args.initial_prompt,
        "normalizePeak": not args.no_normalize,
        "vadFilter": args.vad_filter,
        "decodeOverrides": args.decode,
        "unit": unit,
        "dataset": str(wavset),
        "manifestSha256": digest.hexdigest()[:16],
        "sampleCount": len(items),
    }


def main():
    args = parse_args()
    if args.extract:
        if not args.parquet:
            sys.exit("--extract 需要 --parquet <文件>")
        return extract(args)

    if not args.wavset:
        sys.exit("测错误率需要 --set <测试集目录>（先用 --extract 抽一批）")

    wavset, items = read_manifest(args.wavset)
    # --count 也限制**测多少条**（不只是抽取多少条）——
    # 想先跑一小批看趋势时很有用：large-v3 在 CPU 上跑满 30 条要好几分钟。
    if args.count and args.count < len(items):
        items = items[: args.count]
        print(f"（--count {args.count}：只测前 {len(items)} 条）")
    unit = args.unit if args.unit != "auto" else detect_unit([i["reference"] for i in items])
    unit_label = "字" if unit == "char" else "词"
    # ⚠️ 这句原来写的是 `'，auto 判定为中文' if args.unit == 'auto'` —— 只要 unit 是 auto 就
    #    印"判定为中文"，**不管实际判成什么**。跑葡语时也会印出来，看着像是判错了语种。
    #    这里要说明的是"单位是怎么定的"，与语种无关，所以直接写清依据。
    unit_note = "" if args.unit != "auto" else "，单位按参考文本是否含空格自动判"
    print(f"测试集：{wavset}（{len(items)} 条；错误率按**{unit_label}**算{unit_note}）")

    from faster_whisper import WhisperModel

    print(f"载入模型 {args.model}（device={args.device}, compute_type={args.compute_type}"
          f"{'' if args.no_normalize else '，峰值归一化'}；beam {args.beam_size}）…")
    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)

    # 先预热：CUDA 上第一次推理要十几秒，混进统计会污染第一个样本（见 docs/04）
    warm_start = time.perf_counter()
    list(model.transcribe(np.zeros(TARGET_RATE, dtype=np.float32), language=args.language)[0])
    print(f"预热完成：{time.perf_counter() - warm_start:.2f}s")

    rows = []
    failures = []
    for item in items:
        sys.stdout.write(".")
        sys.stdout.flush()
        # ⚠️ 每条的加载与推理都单独兜住 —— 老师的要求："检查样本是否全部完成；
        #    **加载失败不能静默排除**"。静默排除会让"只测了 460/500 条"看起来像"全测完了"，
        #    而且失败的那些往往是坏文件/异常音频，恰恰最该被看见。
        try:
            audio = _read_wav(wavset / item["file"])
        except Exception as error:
            failures.append({"file": item["file"], "stage": "load",
                             "error": f"{type(error).__name__}: {error}"})
            continue
        if not args.no_normalize:
            peak = float(np.max(np.abs(audio))) if audio.size else 0.0
            if peak > 1e-6:
                audio = audio * (0.9 / peak)
        start = time.perf_counter()
        # 不指定语种时**限定候选集**：与产线 whisper_stream.py 同一个做法、同一个理由。
        # 不加这一步的话，评测里的"语种判定"是在 99 种语言里挑最大 ——
        # 实测就会挑出 he（希伯来语）并把整句报废，而产线根本不会那样做，
        # 于是评测与产线的行为**不一致**，数字也就不能代表产线。
        language = args.language
        if language is None and args.lang_candidates:
            _detected, _prob, all_probs = model.detect_language(audio)
            picks = [(code, p) for code, p in all_probs if code in args.lang_candidates]
            if picks:
                language = max(picks, key=lambda item: item[1])[0]
        decode_kwargs = {
            "language": language,
            "beam_size": args.beam_size,
            "vad_filter": args.vad_filter,
            "condition_on_previous_text": False,
            "initial_prompt": args.initial_prompt,
        }
        decode_kwargs.update(args.decode)          # --decode-json 最后覆盖
        try:
            segments, info = model.transcribe(audio, **decode_kwargs)
            text = " ".join(seg.text.strip() for seg in segments).strip()
        except Exception as error:
            # 推理失败也要记下来，不能让它把"少测了几条"藏起来
            failures.append({"file": item["file"], "stage": "transcribe",
                             "error": f"{type(error).__name__}: {error}"})
            continue
        elapsed = time.perf_counter() - start
        score = error_rate(item["reference"], text, unit)
        # 同一批识别输出上，规范化口径**重新对齐再算一遍**（不是从严格分里扣桶）。
        # 两条口径都存进结果文件：这样"严格 vs 规范化"永远基于**同一次解码**，
        # 差别只可能来自评分规则本身，不会混进模型随机性。
        normalized = normalized_error_rate(item["reference"], text, unit,
                                           drop_interjections=args.norm_interjections,
                                           collapse_repeats=args.norm_collapse_repeats)
        rows.append({
            "file": item["file"],
            "seconds": item["seconds"],
            "reference": item["reference"],
            "hypothesis": text,
            # ── 老师的 §八：逐条保存 参考原文 / 识别原文 / 替换·删除·插入 / 耗时 ──
            "rate": score["rate"],
            "units": score["units"],
            "distance": score["distance"],
            "substitutions": score["substitutions"],
            "deletions": score["deletions"],
            "insertions": score["insertions"],
            # ── 规范化口径（asr-norm-v1）：同一段识别输出换文本重新对齐 ──
            "normalized_rate": normalized["rate"],
            "normalized_units": normalized["units"],
            "normalized_distance": normalized["distance"],
            "normalized_substitutions": normalized["substitutions"],
            "normalized_deletions": normalized["deletions"],
            "normalized_insertions": normalized["insertions"],
            "traditional": count_traditional(text),
            "seconds_used": elapsed,
            "detected": getattr(info, "language", "?"),
            "detected_prob": getattr(info, "language_probability", 0.0),
            "language_used": language,
            # 分组标签从 manifest 带过来，报告才能按口音/语体分组
            "tags": item.get("tags") or {},
            "key_terms": key_term_hits(item["reference"], text, item.get("key_terms")),
            # 关键内容检查：数字（值+单位）在不在、否定词在不在
            "numbers": numeric_report(item["reference"], text, unit),
            "negation_reference": sorted(negation_flags(item["reference"], unit)),
            "negation_hypothesis": sorted(negation_flags(text, unit)),
        })
    print("")

    scored = [r for r in rows if r["units"] > 0 and not np.isnan(r["rate"])]
    # 整体错误率 = 全部编辑错误 ÷ 全部参考单位（老师明确要求，不是每句百分比的平均）；
    # 同时把 S/D/I 拆开报出来。
    weighted, total_units, total_distance, (sum_s, sum_d, sum_i) = overall_rate(scored)
    # 规范化口径在**同一批**样本上重算（单位数可能略有差别：数字写法统一后单位数会变）
    normalized_rows = [{"units": r["normalized_units"], "distance": r["normalized_distance"],
                        "substitutions": r["normalized_substitutions"],
                        "deletions": r["normalized_deletions"],
                        "insertions": r["normalized_insertions"]}
                       for r in scored]
    norm_weighted, norm_units, norm_distance, (norm_s, norm_d, norm_i) = overall_rate(normalized_rows)
    mean_per_sentence = (sum(r["rate"] for r in scored) / len(scored)) if scored else float("nan")
    audio_seconds = sum(r["seconds"] for r in rows)
    used_seconds = sum(r["seconds_used"] for r in rows)
    latencies = [r["seconds_used"] for r in rows]
    detections = {}
    for r in rows:
        detections[r["detected"]] = detections.get(r["detected"], 0) + 1
    traditional_total = sum(r["traditional"] for r in rows)
    traditional_sentences = sum(1 for r in rows if r["traditional"] > 0)

    # ⚠️ 这段标签换过两次，两次都是因为"猜语料性质"而不是"读语料自报的性质"：
    #    第一版**写死**成「朗读语音」，跑 CORAA（真实口语）时也照印；
    #    第二版改成"manifest 里有 source/dataset 就算真实口语" ——
    #    结果新的测试包（FLEURS）也带 `dataset` 字段，于是**朗读包被标成真实口语**。
    #    现在优先读样本**自报的语体**（tags.register，切包时按语料官方标签写入），
    #    不靠猜；读不到才如实说"未标注"。
    _, raw_items = read_manifest(wavset)
    registers = {(i.get("tags") or {}).get("register")
                 for i in raw_items if isinstance(i, dict)}
    registers.discard(None)
    if registers == {"read"}:
        corpus_label = "朗读语音 —— 比真实会议**乐观**（见 docs/14 §2）"
    elif "spontaneous" in registers:
        corpus_label = ("真实口语（自发说话，含口音/语速变化）—— 比朗读更接近真实会议，"
                        "但仍不是多人抢话的会议室")
    else:
        corpus_label = ("语体未标注（老格式 manifest，没有 tags.register）—— "
                        "请对照 docs/14 §2 确认它是朗读还是口语")

    print("=" * 76)
    print(f"结果 · 模型 {args.model} / {args.device} / {args.compute_type} / beam {args.beam_size}")
    print(f"评分规则 {SCORING_RULES_VERSION}")
    print("=" * 76)
    print(f"  样本数        {len(rows)} 条（{corpus_label}）")
    if failures:
        # 老师的 §四：加载失败不能静默排除。所以**显式报出来**，
        # 并且说清"分母是多少" —— 否则"跑了 500 条"看起来像"500 条都算出了分"。
        print(f"  ⚠️ 失败样本    {len(failures)} 条（已排除出评分，分母是 {len(items)}）")
        for item in failures[:5]:
            print(f"       {item['stage']}: {item['file']} — {item['error']}")
        if len(failures) > 5:
            print(f"       …还有 {len(failures) - 5} 条")
    print(f"  错误率单位    {unit_label}"
          f"（中文必须按字：没有空格，按词算整句就是一个 token）")
    print(f"  语种判定      {detections}"
          f"{'（已固定为 ' + args.language + '）' if args.language else '（自动判定）'}")
    print(f"  整体错误率    {weighted * 100:.1f}%   ← 全部编辑错误 ÷ 全部参考{unit_label}数"
          f"（{total_distance}/{total_units}）")
    print(f"    其中替换    {sum_s} 次（{sum_s / max(1, total_units) * 100:.1f}%）")
    print(f"    其中删除    {sum_d} 次（{sum_d / max(1, total_units) * 100:.1f}%）"
          f"  ← 漏字/漏词，同传里最容易被忽略的一类")
    print(f"    其中插入    {sum_i} 次（{sum_i / max(1, total_units) * 100:.1f}%）"
          f"  ← 多字/重复")
    print(f"  规范化错误率  {norm_weighted * 100:.1f}%   ← 同一批识别输出换文本**重新对齐**再算"
          f"（{norm_distance}/{norm_units}）")
    print(f"    其中替换    {norm_s} 次（{norm_s / max(1, norm_units) * 100:.1f}%）")
    print(f"    其中删除    {norm_d} 次（{norm_d / max(1, norm_units) * 100:.1f}%）")
    print(f"    其中插入    {norm_i} 次（{norm_i / max(1, norm_units) * 100:.1f}%）")
    print(f"  两条口径差    {(weighted - norm_weighted) * 100:.1f} 个百分点"
          f"（{NORMALIZED_RULES_VERSION}：只统一标点/成对繁简/数值与单位等价的数字写法）")
    print("                ⚠️ 这个差**不是**「声学错误率」：它是换文本重算出来的，"
          "不是从严格分里扣掉几个分类桶")
    print(f"  按句平均      {mean_per_sentence * 100:.1f}%（**仅供参考**：短句权重过大，"
          f"不作为主指标 —— 老师明确要求用上面的整体错误率）")
    good = sum(1 for r in scored if r["rate"] <= 0.10)
    print(f"  完全/近乎正确 {good}/{len(scored)} 句的错误率 ≤ 10%")
    if unit == "char":
        print(f"  疑似繁体输出  {traditional_total} 个字，涉及 {traditional_sentences}/{len(rows)} 句"
              f"（Whisper 在中文上的已知毛病，这一项单独列出来）")
    keyed = [r for r in rows if r["key_terms"]]
    if keyed:
        hits = sum(1 for r in keyed for k in r["key_terms"] if k["hit"])
        alls = sum(len(r["key_terms"]) for r in keyed)
        print(f"  关键内容专项  {hits}/{alls} 个关键项在识别输出里还在"
              f"（{len(keyed)}/{len(rows)} 条样本有人工确认的清单）")
    else:
        print(f"  关键内容专项  ⚠️ 本批样本没有人工确认的 key_terms，**这一项不可用**"
              f"（老师要求关键内容必须人工确认，脚本不猜；"
              f"用 python asr-eval/asr_pack.py --keys 生成候选清单）")
    print(f"  音频总时长    {audio_seconds:.1f}s")
    print(f"  识别总耗时    {used_seconds:.1f}s（RTF {used_seconds / audio_seconds:.3f}）")
    p50, p95 = percentile(latencies, 0.50), percentile(latencies, 0.95)
    print(f"  单条识别耗时  P50 {p50:.2f}s / P95 {p95:.2f}s"
          f"（老师的 §八 要求 P50/P95，不是只看平均）")
    print("")
    print(f"  随机看 {min(args.show, len(rows))} 条对照：")
    for row in rows[: args.show]:
        extra = f"，疑似繁体 {row['traditional']} 字" if row["traditional"] else ""
        print(f"    参考  {row['reference']}")
        print(f"    识别  {row['hypothesis']}")
        print(f"    {'CER' if unit == 'char' else 'WER'} {row['rate'] * 100:5.1f}%"
              f"  S{row['substitutions']} D{row['deletions']} I{row['insertions']}"
              f"  [{row['seconds']:.2f}s 音频 / {row['seconds_used']:.2f}s{extra}]")
        print("")
    print("=" * 76)

    # 结构化结果（供 asr-eval/test-asr.mjs 汇总）。刻意与上面打印的内容**同源**：
    # 都从同一批 rows 算出来，所以不会出现"打印说 3.9%、JSON 说 4.1%"这种漂移。
    if args.out_json:
        summary = {
            # ── 运行可追溯（老师的 §六：每次运行绑定代码/模型/提示词/参数/数据清单/规则版本）──
            "provenance": run_provenance(args, wavset, items, unit),
            "set": str(wavset),
            "model": args.model,
            "device": args.device,
            "compute_type": args.compute_type,
            "beam_size": args.beam_size,
            "language": args.language,
            "langCandidates": list(args.lang_candidates) if args.lang_candidates else None,
            "scoringRules": SCORING_RULES_VERSION,
            "unit": unit,
            "count": len(rows),
            "scoredCount": len(scored),
            "failures": failures,
            "weightedRate": None if np.isnan(weighted) else float(weighted),
            "substitutions": sum_s,
            "deletions": sum_d,
            "insertions": sum_i,
            "totalUnits": total_units,
            "totalDistance": total_distance,
            # ── 规范化口径（asr-norm-v1）：同一批识别输出换文本重新对齐 ──
            "normalizedRules": NORMALIZED_RULES_VERSION,
            "normalizedRate": None if np.isnan(norm_weighted) else float(norm_weighted),
            "normalizedSubstitutions": norm_s,
            "normalizedDeletions": norm_d,
            "normalizedInsertions": norm_i,
            "normalizedUnits": norm_units,
            "normalizedDistance": norm_distance,
            "meanRate": None if len(scored) == 0 else float(mean_per_sentence),
            "goodCount": good,
            "detections": detections,
            "traditionalTotal": traditional_total,
            "traditionalSentences": traditional_sentences,
            "audioSeconds": float(audio_seconds),
            "usedSeconds": float(used_seconds),
            "latencyP50": p50,
            "latencyP95": p95,
            "rows": rows,
        }
        Path(args.out_json).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out_json).write_text(
            json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"结构化结果已写到 {args.out_json}")
    return 0


def _read_wav(path):
    with wave.open(str(path), "rb") as handle:
        raw = handle.readframes(handle.getnframes())
    return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0


if __name__ == "__main__":
    sys.exit(main())
