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
    python bridge/asr_eval.py --parquet var/cache/fleurs/pt_br_validation.parquet --extract

    # 第二步：拿抽出来的这批音频测某个模型
    python bridge/asr_eval.py --set var/audio/pt-eval --model small --device cuda --compute-type float16
"""

import argparse
import io
import json
import re
import sys
import time
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from whisper_transcribe import TARGET_RATE, decode_with_av   # noqa: E402


def parse_args():
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
                        help="固定语种（zh / pt）；缺省自动判定")
    parser.add_argument("--beam-size", type=int, default=5, help="缺省 5（与生产链路一致）")
    parser.add_argument("--no-normalize", action="store_true",
                        help="不做峰值归一化（缺省做，与生产链路一致）")
    parser.add_argument("--initial-prompt", default=None,
                        help="提示词（缺省不发，与生产链路一致）")
    parser.add_argument("--show", type=int, default=5, help="打印前几条对照（缺省 5）")
    parser.add_argument("--out-json", default=None,
                        help="把结构化结果写到这里（供 scripts/test-asr.mjs 汇总用）。"
                             "只增加输出，不改任何计算逻辑 —— 这样两边的口径永远一致")
    return parser.parse_args()


# ── 错误率：中文按**字**，葡语按**词** ────────────────────────────────────────
#
# 为什么必须分两种单位：中文不用空格分词。按"词"算的话，整句就是一个 token，
# 错一个字和整句全错得到的数字一样（要么 0、要么 1）—— 完全没法用来调参。
# 所以中文按**字**算 CER（Character Error Rate），葡语按词算 WER。

# 只在繁体里出现的常用字。用来把"输出成繁体"这个已知毛病**量化**出来 ——
# 否则 CER 只会告诉你"错了"，不会告诉你"错在哪一类"。
# （不是完备的繁简对照表，只覆盖口语里最常出现的一批；所以指标叫"疑似繁体字数"。）
TRADITIONAL_ONLY = set(
    "這說麼為個們來時會對開過實現學國產與東車門見長問間題讓從應該裡樣還進發經頭幾語聽讀寫"
    "電話點認識覺辦體條壓點無萬業員這樣實際應該處理總機關於當來後東車馬鳥魚龍風飛隻億據"
    "處臟選擇觀觀點運動員圖書館總結經驗營運營養")
# 这些字在简体里也这么写，去掉以免误报（上面列表里混进来的）。
TRADITIONAL_ONLY -= set("由只几只")

CJK = re.compile(r"[\u4e00-\u9fff]")
PUNCT = re.compile(r"[^\w\u4e00-\u9fff]", flags=re.UNICODE)


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


def normalize(text, unit="word"):
    """比较前先归一。

    两种单位都要做的：统一小写、去标点。
    差别在于**空白**：
      · word —— 用空白分词，所以把标点换成空格再合并（葡语的重音**必须保留**，那是有意义的）。
      · char —— 中文里的空白不是语义的一部分（而且 FLEURS 的 transcription 字段是逐字用空格
        分开的），所以要把空白**全部删掉**，否则"字数"会被空格搞错。
    """
    text = text.lower().replace("’", "'")
    if unit == "char":
        return PUNCT.sub("", text)
    text = re.sub(r"[^\w\s']", " ", text, flags=re.UNICODE)
    return " ".join(text.split())


def count_traditional(text):
    """数一数输出里出现了多少个"疑似繁体专用字"。"""
    return sum(1 for char in text if char in TRADITIONAL_ONLY)


def edit_distance(sequence_a, sequence_b):
    """编辑距离（滚动数组，长句不吃内存）。"""
    previous = list(range(len(sequence_b) + 1))
    for i, item_a in enumerate(sequence_a, start=1):
        current = [i] + [0] * len(sequence_b)
        for j, item_b in enumerate(sequence_b, start=1):
            cost = 0 if item_a == item_b else 1
            current[j] = min(previous[j] + 1,        # 删除
                             current[j - 1] + 1,     # 插入
                             previous[j - 1] + cost)  # 替换 / 正确
        previous = current
    return previous[len(sequence_b)]


def error_rate(reference, hypothesis, unit="word"):
    """返回 (错误率, 参考单位数, 距离)。中文 unit='char' 时就是 CER。"""
    if unit == "char":
        ref = list(normalize(reference, "char"))
        hyp = list(normalize(hypothesis, "char"))
    else:
        ref = normalize(reference, "word").split()
        hyp = normalize(hypothesis, "word").split()
    if not ref:
        return float("nan"), 0, 0
    distance = edit_distance(ref, hyp)
    return distance / len(ref), len(ref), distance


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
    for item in items:
        sys.stdout.write(".")
        sys.stdout.flush()
        audio = _read_wav(wavset / item["file"])
        if not args.no_normalize:
            peak = float(np.max(np.abs(audio))) if audio.size else 0.0
            if peak > 1e-6:
                audio = audio * (0.9 / peak)
        start = time.perf_counter()
        segments, info = model.transcribe(
            audio, language=args.language, beam_size=args.beam_size,
            vad_filter=True, condition_on_previous_text=False,
            initial_prompt=args.initial_prompt,
        )
        text = " ".join(seg.text.strip() for seg in segments).strip()
        elapsed = time.perf_counter() - start
        score, ref_units, distance = error_rate(item["reference"], text, unit)
        rows.append({
            "file": item["file"],
            "seconds": item["seconds"],
            "reference": item["reference"],
            "hypothesis": text,
            "rate": score,
            "units": ref_units,
            "distance": distance,
            "traditional": count_traditional(text),
            "seconds_used": elapsed,
            "detected": getattr(info, "language", "?"),
            "detected_prob": getattr(info, "language_probability", 0.0),
        })
    print("")

    scored = [r for r in rows if r["units"] > 0 and not np.isnan(r["rate"])]
    total_units = sum(r["units"] for r in scored)
    weighted = sum(r["rate"] * r["units"] for r in scored) / total_units if total_units else float("nan")
    audio_seconds = sum(r["seconds"] for r in rows)
    used_seconds = sum(r["seconds_used"] for r in rows)
    detections = {}
    for r in rows:
        detections[r["detected"]] = detections.get(r["detected"], 0) + 1
    traditional_total = sum(r["traditional"] for r in rows)
    traditional_sentences = sum(1 for r in rows if r["traditional"] > 0)

    # ⚠️ 这句原来**写死**成「朗读语音 —— 比真实会议乐观」。跑 CORAA（真实口语）时也是这么印的，
    #    把那批数字说成了朗读 —— 而 CORAA 恰恰是这三个测试集里**最接近真实**的一个。
    #    标签错了会直接误导读数的人，所以按语料本身判断（manifest 里有 source/dataset 的是 CORAA）。
    _, raw_items = read_manifest(wavset)
    heard = any(isinstance(i, dict) and (i.get("source") or i.get("dataset")) for i in raw_items)
    corpus_label = ("真实口语（自发说话，含口音/语速变化）—— 比朗读更接近真实会议，"
                    "但仍不是多人抢话的会议室" if heard
                    else "朗读语音 —— 比真实会议**乐观**，见 docs/04 §8")

    print("=" * 76)
    print(f"结果 · 模型 {args.model} / {args.device} / {args.compute_type} / beam {args.beam_size}")
    print("=" * 76)
    print(f"  样本数        {len(rows)} 条（{corpus_label}）")
    print(f"  错误率单位    {unit_label}"
          f"（中文必须按字：没有空格，按词算整句就是一个 token）")
    print(f"  语种判定      {detections}"
          f"{'（已固定为 ' + args.language + '）' if args.language else '（自动判定）'}")
    print(f"  加权错误率    {weighted * 100:.1f}%   ← 按句子长度加权，反映整体")
    print(f"  按句平均      {np.mean([r['rate'] for r in scored]) * 100:.1f}%")
    good = sum(1 for r in scored if r["rate"] <= 0.10)
    print(f"  完全/近乎正确 {good}/{len(scored)} 句的错误率 ≤ 10%")
    if unit == "char":
        print(f"  疑似繁体输出  {traditional_total} 个字，涉及 {traditional_sentences}/{len(rows)} 句"
              f"（Whisper 在中文上的已知毛病，这一项单独列出来）")
    print(f"  音频总时长    {audio_seconds:.1f}s")
    print(f"  识别总耗时    {used_seconds:.1f}s（RTF {used_seconds / audio_seconds:.3f}）")
    print(f"  每句识别      {used_seconds / len(rows):.2f}s（含静音过滤）")
    print("")
    print(f"  随机看 {min(args.show, len(rows))} 条对照：")
    for row in rows[: args.show]:
        extra = f"，疑似繁体 {row['traditional']} 字" if row["traditional"] else ""
        print(f"    参考  {row['reference']}")
        print(f"    识别  {row['hypothesis']}")
        print(f"    {'CER' if unit == 'char' else 'WER'} {row['rate'] * 100:5.1f}%"
              f"   [{row['seconds']:.2f}s 音频 / {row['seconds_used']:.2f}s{extra}]")
        print("")
    print("=" * 76)

    # 结构化结果（供 scripts/test-asr.mjs 汇总）。刻意与上面打印的内容**同源**：
    # 都从同一批 rows 算出来，所以不会出现"打印说 3.9%、JSON 说 4.1%"这种漂移。
    if args.out_json:
        summary = {
            "set": str(wavset),
            "model": args.model,
            "device": args.device,
            "compute_type": args.compute_type,
            "beam_size": args.beam_size,
            "language": args.language,
            "unit": unit,
            "count": len(rows),
            "scoredCount": len(scored),
            "weightedRate": None if np.isnan(weighted) else float(weighted),
            "meanRate": None if len(scored) == 0 else float(np.mean([r["rate"] for r in scored])),
            "goodCount": good,
            "detections": detections,
            "traditionalTotal": traditional_total,
            "traditionalSentences": traditional_sentences,
            "audioSeconds": float(audio_seconds),
            "usedSeconds": float(used_seconds),
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
