"""
fetch-coraa-sample.py —— 从 CORAA 抽一份**按口音分层的小样本**成 wav + 清单
================================================================================

    python scripts/fetch-coraa-sample.py --list                    # 只报分布，不下载
    python scripts/fetch-coraa-sample.py                           # 每地区 20 句（缺省）
    python scripts/fetch-coraa-sample.py --per-accent 30           # 每地区 30 句
    python scripts/fetch-coraa-sample.py --force                   # 重写已存在的 wav

前置：
    node scripts/fetch-coraa.mjs --metadata     # 口音/风格元数据（约 77 MB）
    node scripts/fetch-coraa.mjs --shards 6     # 含音频的分片（约 1.9 GB）

抽完直接测：
    node scripts/test-asr.mjs --set pt-coraa --compare --by-accent

三个刻意的取舍
--------------
① **不全量下载**。CORAA 全量约 41.7 GB（136 个 parquet 分片）。
   评测要的是"每个口音够不够代表性"，不是"数据越多越好" ——
   按口音分层抽 20~30 句就足以量出**口音差异**，而体积只有几百 MB。

② **只抽手里分片里真有的**。不同分片来自不同子语料（SP2010 / NURC-Recife / ALIP /
   C-ORAL-BRASIL I / TEDx），所以抽之前先报"这些分片里能抽到哪些口音、还缺哪些"，
   而不是从全量元数据里随机抽一堆找不着的行。
   （第一版就是从 40 万条里随机抽 60 条，而手里只有一个 2113 条的分片 ——
     交集只有 1 条，"抽样"变成了白白一场。）

③ **只挑干净且是巴葡的**。判据见 clean()。其中 `speech_style` 那条踩过坑：
   一开始要求**恰好等于** "Spontaneous Speech"，结果**圣保罗整块被淘汰**
   （SP2010 的标注是 "Spontaneous and Read Speech"）——
   而那恰恰是方案点名的四个地区之一。所以改成"含 Spontaneous 即可"。
"""

import argparse
import csv
import io
import json
import os
import random
import struct
import sys
import wave
from collections import Counter, defaultdict

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "bridge"))

# 复用生产链路的解码器 —— 它本来就在处理"语料里的 wav 是 32 位浮点"这件事。
# ⚠️ 绝对不要自己解析 RIFF 头：真踩过，见下面 write_wav 的注释。
from whisper_transcribe import decode_with_av  # noqa: E402

# 路径约定与 lib/paths.mjs 一致（那边是 JS 侧的唯一来源；这里是 Python 侧的对应值）。
# ⚠️ 为什么不 import：lib/paths.mjs 是 .mjs，Python 读不了；为它起一个 node 子进程
#    又太重、还多一个运行依赖。所以这里直接算，并**用下面这条检查防漂移**：
#    只要目录名和 scripts/test-asr.mjs 的发现规则对不上，就明确报错而不是悄悄跑空。
VAR = os.path.join(ROOT, "var")
CORAA_CACHE_DIR = os.path.join(VAR, "cache", "coraa")
CORAA_SHARD_DIR = os.path.join(CORAA_CACHE_DIR, "shards")
PT_CORAA_DIR = os.path.join(VAR, "audio", "pt-coraa")


def clean(row):
    """只留"干净、巴葡、口语"的条目 —— 判据都写在一处，便于复核。"""
    if row.get("variety") != "pt_br":
        return False        # 语料里有 1040 条 pt_pt（欧葡），混进来会污染"巴葡"结论
    if "Spontaneous" not in (row.get("speech_style") or ""):
        return False
    text = (row.get("text") or "").strip()
    # 太短（"aham"、"maneira né"）没有翻译价值；太长不适合单句同传
    if len(text) < 12 or len(text) > 120:
        return False
    try:
        if float(row.get("votes_for_noise_or_low_voice") or 0) > 0:
            return False    # 众包标注说"有噪声或音量低"→ 排掉，避免把噪声当模型问题
        if float(row.get("votes_for_no_identified_problem") or 0) < 1:
            return False    # 没人认为"没识别出问题"→ 排掉
    except ValueError:
        return False
    return True


def write_wav(path, samples, rate=16000):
    """把浮点采样写成 16 位单声道 wav。

    ⚠️ `samples` 必须是**已经解码好的浮点波形**（-1.0~1.0），不是文件字节。
    真踩过：CORAA 的 `audio.bytes` 是**完整的 WAV 文件**（开头就是 `RIFF....WAVEfmt`，
    里面写着 wFormatTag=3 = IEEE 32 位浮点）。把整个文件当 16 位 PCM 写进 wav 头，
    等于**把容器头也当音频** —— 结果是峰值全顶到 1.0、RMS 是正常值的 12 倍、
    静音窗 0%，而 Whisper 收到这种音频会**输出空文本、语种判成 en/nn（挪威语）**。
    症状看起来完全像"模型不行"，非常容易把结论带偏。
    """
    pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
    with open(path, "wb") as handle:
        handle.write(b"RIFF")
        handle.write(struct.pack("<I", 36 + len(pcm)))
        handle.write(b"WAVEfmt ")
        handle.write(struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16))
        handle.write(b"data")
        handle.write(struct.pack("<I", len(pcm)))
        handle.write(pcm)


def read_metadata(directory):
    """读**全部** split 的元数据。

    ⚠️ 只读 train 会踩坑：分片里的行可能是 `test/sp/...`，而 train 元数据里没有这条
    file_path —— 于是"取出来 0 条"。分批下的分片可能来自任何一个 split，
    所以三个都读，靠 file_path（它本身带 split 前缀）去匹配。
    """
    rows = []
    if not os.path.isdir(directory):
        return rows
    for name in sorted(os.listdir(directory)):
        if not name.startswith("metadata_") or not name.endswith(".csv"):
            continue
        with open(os.path.join(directory, name), encoding="utf-8", newline="") as handle:
            for row in csv.DictReader(handle):
                rows.append(row)
        print(f"  读了 {name}：累计 {len(rows)} 条")
    return rows


def main():
    parser = argparse.ArgumentParser(description="从 CORAA 抽按口音分层的小样本")
    parser.add_argument("--per-accent", type=int, default=20, help="每个口音抽多少条")
    parser.add_argument("--list", action="store_true", help="只报分布，不抽")
    parser.add_argument("--seed", type=int, default=7, help="随机种子（固定种子=结果可复现）")
    parser.add_argument("--force", action="store_true", help="重写已存在的 wav")
    parser.add_argument("--out", default=PT_CORAA_DIR, help="抽到哪里（缺省 var/audio/pt-coraa）")
    args = parser.parse_args()

    print(f"语料缓存 {CORAA_CACHE_DIR}")
    rows = read_metadata(CORAA_CACHE_DIR)
    if not rows:
        raise SystemExit(
            "没有元数据。先跑：node scripts/fetch-coraa.mjs --metadata")
    good = [row for row in rows if clean(row)]
    print(f"合计 {len(rows)} 条 → 干净且是巴葡口语的 {len(good)} 条")

    by_accent = defaultdict(list)
    for row in good:
        by_accent[row["accent"]].append(row)

    print("")
    print("=== 元数据里可选（按口音）===")
    for accent, items in sorted(by_accent.items(), key=lambda kv: -len(kv[1])):
        print(f"  {accent:24s} {len(items):7d} 条")
    if args.list:
        return 0

    if not os.path.isdir(CORAA_SHARD_DIR):
        raise SystemExit(
            "没有分片（音频在里面）。先跑：node scripts/fetch-coraa.mjs --shards 6")

    import pyarrow.parquet as pq

    # ⚠️ 抽样只针对**手里有的分片**，不是从全量元数据里随机抽（第 2 条取舍）。
    available = []
    files = sorted(name for name in os.listdir(CORAA_SHARD_DIR) if name.endswith(".parquet"))
    if not files:
        raise SystemExit("分片目录是空的，先跑：node scripts/fetch-coraa.mjs --shards 6")
    for name in files:
        table = pq.read_table(os.path.join(CORAA_SHARD_DIR, name),
                              columns=["file_path", "accent", "text", "speech_style",
                                       "dataset", "variety", "votes_for_noise_or_low_voice",
                                       "votes_for_no_identified_problem"])
        for index, row in enumerate(table.to_pylist()):
            if clean(row):
                available.append((name, index, row))

    by_shard_accent = defaultdict(list)
    for name, index, row in available:
        by_shard_accent[row["accent"]].append((name, index, row))

    print("")
    print(f"手里 {len(files)} 个分片，可用（干净巴葡口语）{len(available)} 条")
    print("=== 分片里实际能抽到的（按口音）===")
    for accent, items in sorted(by_shard_accent.items(), key=lambda kv: -len(kv[1])):
        print(f"  {accent:24s} {len(items):7d} 条")

    missing = [accent for accent in by_accent if accent not in by_shard_accent]
    if missing:
        print("")
        print("⚠️ 元数据里有、但**这些分片里抽不到**的地区：" + "、".join(missing))
        print("   不同分片来自不同子语料（SP2010 / NURC-Recife / ALIP / C-ORAL-BRASIL I / TEDx），")
        print("   所以要覆盖它们得多下几个分片：")
        print("     node scripts/fetch-coraa.mjs --shards " + str(len(files) + 5))

    random.seed(args.seed)
    wanted = {accent: random.sample(items, min(args.per_accent, len(items)))
              for accent, items in by_shard_accent.items()}

    os.makedirs(args.out, exist_ok=True)
    plan = defaultdict(list)
    for accent, items in wanted.items():
        for name, index, row in items:
            plan[name].append((index, accent))

    manifest = []
    for name in sorted(plan):
        table = pq.read_table(os.path.join(CORAA_SHARD_DIR, name),
                              columns=["file_path", "audio", "text", "accent",
                                       "speech_style", "dataset"])
        shard_rows = table.to_pylist()
        for index, accent in plan[name]:
            row = shard_rows[index]
            raw = (row.get("audio") or {}).get("bytes")
            if not raw:
                print(f"  ⚠️ {row.get('file_path')} 没有音频字节，跳过")
                continue
            target = os.path.join(args.out, os.path.basename(row["file_path"]))
            if os.path.exists(target) and not args.force:
                pass
            else:
                samples = decode_with_av(io.BytesIO(raw), container_format="wav")
                write_wav(target, samples)
            with wave.open(target) as handle:
                seconds = handle.getnframes() / handle.getframerate()
            manifest.append({
                "file": os.path.basename(target),
                "accent": accent,
                "dataset": row.get("dataset"),
                "speech_style": row.get("speech_style"),
                "seconds": round(seconds, 2),
                "reference": (row.get("text") or "").strip(),
                "source": "CORAA-v1.1 " + str(row.get("file_path")),
            })
        print(f"  {name}: 已写出 {len(manifest)} 条")

    with open(os.path.join(args.out, "manifest.jsonl"), "w", encoding="utf-8") as handle:
        for item in manifest:
            handle.write(json.dumps(item, ensure_ascii=False) + "\n")

    print("")
    print(f"✅ 写出 {len(manifest)} 条 → {args.out}")
    for accent, count in Counter(item["accent"] for item in manifest).most_common():
        print(f"   {accent:24s} {count} 条")
    total = sum(item["seconds"] for item in manifest)
    print(f"   合计 {total:.0f} 秒（{total / 60:.1f} 分钟）")

    # 防漂移检查：test-asr.mjs 的规则是"凡是有 manifest.jsonl 的目录就是一个测试集"。
    # 如果哪天目录约定变了（比如挪到别的名字），这条会立刻发现，
    # 而不是让你去猜"为什么 --set pt-coraa 说没有这个测试集"。
    expected = os.path.join(VAR, "audio", "pt-coraa")
    if os.path.abspath(args.out) == os.path.abspath(expected):
        print("")
        print("下一步：node scripts/test-asr.mjs --set pt-coraa --compare --by-accent")
    else:
        print("")
        print(f"注意：--out 不是缺省位置（{expected}），")
        print(f"      test-asr.mjs 会按目录名把它当成 --set {os.path.basename(args.out)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
