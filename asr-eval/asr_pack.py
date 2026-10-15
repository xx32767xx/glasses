"""
asr_pack.py —— 从本地缓存的公开语料切出**固定、可复现、可审计**的识别测试包
================================================================================

老师给的测试建议里，"先冻结一套起步测试包" + "统一数据和评分规则"是整件事的地基：
没有冻结的切分，后面每一个数字都说不清是"模型变好了"还是"换了一批样本"。

这个脚本只做三件事，都围绕"可复现"：

  1. **确定性抽样** —— 用固定种子把语料打散后取前 N 条。
     不靠随机数、不靠文件系统顺序（同一批数据在两台机器上必须切出同一份）。
  2. **与历史回归集不相交** —— 已经反复看过的那 20 条 CORAA / 30 条 FLEURS
     按老师的说法"保留为历史回归集，不再当作未见测试集"，所以从新包里**排除**。
  3. **按说话人/会话整组切分** —— 同一段会话的片段必须落在同一侧，
     否则就是"把同一段录音随机切开分到两组"，那是典型的泄漏。

用法
  python asr-eval/asr_pack.py --list                  # 列出能切哪些包、各有多少条
  python asr-eval/asr_pack.py --build zh-read-dev     # 切一个包
  python asr-eval/asr_pack.py --build all             # 全切

每个包容器的内容
  <pack>/manifest.jsonl   每条样本一行，字段见 docs/14（样本身份 / 音频 / 会话 / 正确答案 / 分组标签）
  <pack>/pack.json        这一包是怎么切出来的（数据集、版本、切分规则、种子、统计）—— 审计用

切出来的包放在哪
  var/asr-eval/packs/<包名>/   —— 识别评测的数据**单独一层**，不跟生产录音混在 var/audio，
                                  也不跟"随便删"的日志混在 var/logs（见 lib/paths.mjs 的说明）。
"""

import argparse
import hashlib
import json
import os
import random
import re
import sys
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent          # 本文件在 asr-eval/ 下
ROOT = HERE.parent                              # 仓库根
sys.path.insert(0, str(HERE))                   # 同层的兄弟模块（asr_eval / asr_score …）
# ⚠️ 依赖方向是**单向**的：评测层（asr-eval/）可以用 bridge/ 里的产线引擎与共享工具
#    （whisper_stream / whisper_transcribe），但 bridge/ **永远不许** import asr-eval/ ——
#    反了就等于把测量工具塞进了产线。这条不靠自觉：tests/asr-pack-suite.mjs 里有断言在查。
sys.path.insert(0, str(ROOT / "bridge"))

from asr_eval import load_wav_bytes                      # noqa: E402
from whisper_stream import force_utf8_stdio               # noqa: E402
from whisper_transcribe import TARGET_RATE                # noqa: E402

# ⚠️ 中文输出必须走 UTF-8，而且**导入时就要生效**（理由见 whisper_stream 里的说明）：
#    这个脚本是**手动**跑的，没有 start-all 帮忙设 PYTHONUTF8 ——
#    实测过：Windows 中文环境下不带这一行，`--list` 打到 GBK 管道上会直接
#    UnicodeEncodeError 崩在 `⚠️` 上（`✅` 同理）。手动跑得最多的脚本最需要自己扛住。
force_utf8_stdio()

FLEURS_CACHE = ROOT / "var" / "cache" / "fleurs"
CORAA_CACHE = ROOT / "var" / "cache" / "coraa"
# ⚠️ 这个字面量与 lib/paths.mjs 里的 `ASR_PACKS_DIR` **必须指向同一个目录** ——
#    Python 侧读不到 JS 常量，所以只能各写一份；靠 tests/asr-pack-suite.mjs 里
#    一条断言（真的去问 python 要这个值）挡住漂移，而不是靠人记得同步。
PACKS_DIR = ROOT / "var" / "asr-eval" / "packs"

# MagicData-RAMC（中文日常交流口语）默认放在仓库外 —— 它 19.8 GB，不该进 var/。
# ⚠️ 绝对路径**不写死**：可用 --magicdata-dir 覆盖，实际用的路径会记进 pack.json。
#    （写死绝对路径会让这个脚本换台机器就跑不了，而这类脚本最该是能搬的。）
MAGICDATA_DEFAULT = Path(r"E:\MagicData")

# MagicData 转写里的事件标记（README 里定义的）：
#   [+] 重叠语音   [*] 听不清/整段外语   [LAUGHTER] 笑声   [SONANT] 咳嗽喷嚏等   [MUSIC] 音乐
# 为什么要把它们剔掉：
#   · 重叠语音**不能作为单说话人样本评分** —— 老师也要求"多人重叠片段单独报告"；
#   · [*] 本来就是"听不清"，参考文本本身不可信；
#   · 笑声/咳嗽/音乐不是说话，拿它算 CER 没有意义。
# 只保留"纯说话 + 整句可判"的片段。
MAGICDATA_EVENTS = ("[+]", "[*]", "[LAUGHTER]", "[SONANT]", "[MUSIC]")

# 已经反复看过的评测集 —— 老师的要求：留作**历史回归集**，不再当未见测试集。
# 新包里必须排除它们（按原始 id / 文件名比对），否则"保留集"是脏的。
REGRESSION_SETS = ("zh-eval", "pt-eval", "pt-coraa")

# 切分包定义。`source` 指向本地缓存的语料；`count` 是条数上限（实际取到多少要报出来）。
PACKS = {
    "zh-read-dev":      {"source": "fleurs-cmn", "split": "validation", "count": 100,
                         "note": "中文朗读 · 开发集"},
    "zh-read-holdout":  {"source": "fleurs-cmn", "split": "validation", "count": 300,
                         "note": "中文朗读 · 保留集"},
    "pt-read-dev":      {"source": "fleurs-ptbr", "split": "validation", "count": 100,
                         "note": "巴葡朗读 · 开发集"},
    "pt-read-holdout":  {"source": "fleurs-ptbr", "split": "validation", "count": 286,
                         "note": "巴葡朗读 · 保留集（本地只有 386 条，凑不满 300，如实取 286）"},
    "pt-speech-dev":    {"source": "coraa", "split": "test", "count": 300,
                         "note": "巴葡口语 · 开发集（⚠️ 从 test 切出来的，不是官方 dev —— 见 pack.json）"},
    "pt-speech-holdout": {"source": "coraa", "split": "test", "count": 500,
                          "note": "巴葡口语 · 保留集"},
    # ── 中文口语：MagicData-RAMC（中文日常交流）─────────────────────────────
    # 这一格之前是空的（本地没有数据）。它比 CORAA 还好用：
    # 有**官方划分**（dev 19 场 / test 43 场）、逐句时间戳、说话人 ID、重叠语音标记。
    #
    # ⚠️ `group_by: session` 是**必须的**，不是可选优化：一场 31 分钟的录音有 ~350 句
    #    合格片段，按说话人分组取 300 条会只拿到 2 个说话人（实测）。
    #    按录音分组 + 每场给名额，才能让 300 条摊到全部 19 场。
    "zh-speech-dev":    {"source": "magicdata", "split": "dev", "count": 300,
                         "group_by": "session",
                         "note": "中文口语 · 开发集（官方 dev 划分）"},
    "zh-speech-holdout": {"source": "magicdata", "split": "test", "count": 500,
                          "group_by": "session",
                          "note": "中文口语 · 保留集（官方 test 划分）"},
}

# 片段筛选：中文口语里太短的句子算不准（两个字错一个字就是 50%），
# 太长的句子又会让一次识别跨很多个静音段。老师给的是"起步建议"，
# 这里取 1.5~15 秒、且参考文本至少 4 个汉字。
MAGICDATA_MIN_SECONDS = 1.5
MAGICDATA_MAX_SECONDS = 15.0
MAGICDATA_MIN_CHARS = 4

# 池子条数上限（内存护栏，不是抽样）：最大的一包要 500 条，
# 留 3 倍余量给"按组整取"和"排除历史回归集"造成的损耗。
MAGICDATA_MAX_POOL_ROWS = 1500

# 占位说话人标记（**实测**出来的，不是从 README 抄的）：
#   `G00000000` 在 dev 的 19 场、test 的 43 场里**全部出现**（62/62 场）。
#   一个人不可能出现在所有录音里 —— 它是"非注册说话人/其他"这类标记，不是身份。
#
# ⚠️ 但要如实说清它现在的**实际影响**（这条我第一版说错了，是实测纠正的）：
#   它那些句子**全都过不了合格门槛** —— 实测 dev 6627 条、test 13198 条合格片段里，
#   它占 **0 条**（那些片段基本是"嗯/对"这类太短的回执，或带事件标记）。
#   所以现在这两个包里根本没有它，这个特判在当前切分下是**空操作**。
#   那为什么还留着：它是**降价才踩到的雷**。一旦把 MAGICDATA_MIN_CHARS 放低，
#   这些片段就会进包，而那时它会同时造成两件坏事：
#     · 它在 dev 和 test 里都有 → dev/test 的"说话人不相交"检查会**天天报假警报**；
#     · 保留集的排除名单里会有它 → 精确地把"短回执"整类从保留集里删掉，
#       而 dev 保留着 —— 两包之间凭空多出一个系统性差别。
#   代价是一个 frozenset，留住它比事后查这个雷便宜。
PLACEHOLDER_SPEAKERS = frozenset({"G00000000"})


def regression_ids():
    """历史回归集里已经用过的原始 id / 文件名 —— 新包要避开它们。"""
    used = set()
    for name in REGRESSION_SETS:
        manifest = PACKS_DIR / name / "manifest.jsonl"
        if not manifest.is_file():
            continue
        for line in manifest.read_text(encoding="utf-8").splitlines():
            if line.strip() == "":
                continue
            item = json.loads(line)
            for key in ("original_id", "source", "file", "reference"):
                if item.get(key):
                    used.add(str(item[key]))
                    used.add(os.path.basename(str(item[key])))
    return used


def seeded_shuffle(items, seed_text):
    """按内容定序 + 固定种子打散。

    先按 key 排序再打散，是为了**不依赖 parquet 的行序**：
    换一个 pyarrow 版本、换一次读法，行序都可能变，那切分就不可复现了。
    """
    ordered = sorted(items, key=lambda item: item["original_id"])
    seed = int(hashlib.sha256(seed_text.encode("utf-8")).hexdigest()[:12], 16)
    random.Random(seed).shuffle(ordered)
    return ordered, seed


def speaker_of(original_id):
    """从原文件名里取"说话人/会话"标识。

    CORAA 的文件名形如 `46252_sp_.wav`，前面的数字是受访者编号 ——
    所以按它整组切分，"同一个人"不会跨 dev/保留集。
    FLEURS 每条都是独立录音、没有说话人标注，只能返回 None（如实反映，不假装有）。
    """
    stem = Path(str(original_id)).stem
    head = stem.split("_")[0]
    return head if head.isdigit() else None


def real_speakers(items):
    """一个包/一个清单里的**真实**说话人集合（剔掉占位标记）。

    抽成函数是为了能被测到：说话人数是"这一包覆盖了几个说话人"的唯一来源，
    而占位标记会让每个包都虚报一位 —— 这种事不该只靠一段注释保证。
    """
    return {item["speaker"] for item in items
            if item.get("speaker") and item["speaker"] not in PLACEHOLDER_SPEAKERS}


def per_session_quota(spread, session_count):
    """每场录音取几条：**向上取整**，保证池子至少能铺到每一场。

    为什么必须向上取整（而不是向下或四舍五入）：向下取整时 `quota × 场数 < spread`，
    池子就装不下请求的条数 —— 于是**总有几场整场进不来**，覆盖度白白丢掉一部分。
    实测：dev 19 场、spread=300 → 16 条/场 → 304 条，19 场全部覆盖；
    若向下取整成 15 → 只有 285 条，够不到 300，最后一两场会被挤掉。

    这个算术很小，但它是"这一包覆盖了几个说话人"的直接决定因素，
    所以单独抽出来、单独测（见 tests/python-suite.py）。
    """
    if not spread or session_count <= 0:
        return None
    return max(1, -(-int(spread) // int(session_count)))


def write_wav(target, samples):
    pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(str(target), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(TARGET_RATE)
        handle.writeframes(pcm.tobytes())
    return len(samples) / TARGET_RATE


def fleurs_rows(source, split):
    import pyarrow.parquet as pq

    name = {"fleurs-cmn": "cmn_hans_cn", "fleurs-ptbr": "pt_br"}[source]
    path = FLEURS_CACHE / f"{name}_{split}.parquet"
    if not path.is_file():
        sys.exit(f"找不到 {path}")
    table = pq.read_table(path, columns=["id", "audio", "raw_transcription", "transcription", "gender"])
    rows = []
    for index, row in enumerate(table.to_pylist()):
        # ⚠️ FLEURS 的 `id` **不是每条唯一**：实测 409 行只有 150 个唯一 id
        #    —— 它是"句子"编号（FLoRes 的行号），同一句由 2~3 个不同说话人各录一遍。
        #    所以 original_id 必须带上行号才唯一；否则"按 id 分组"会把不同说话人
        #    的录音捆成一组，切分与排除都会跟着错。
        #    （附带一个有用的发现：**中文与巴葡按 id 对齐** —— 实测 147 个共同 id，
        #      zh 1510 与 pt 1510 是同一句话的两种语言录音。可以用来做"构造切换测试"。）
        rows.append({
            "original_id": f"{name}-{row['id']}#{index}",
            "sentence_id": f"{name}-{row['id']}",
            "dataset": "FLEURS",
            "dataset_version": f"{name}_{split}",
            "split": split,
            "reference": row["raw_transcription"],
            "reference_char_spaced": row["transcription"],
            "session": None,
            "speaker": None,
            "tags": {"register": "read", "gender": row["gender"]},
            "audio_bytes": row["audio"]["bytes"],
        })
    return rows


def coraa_rows(source, split):
    import csv

    import pyarrow.parquet as pq

    metadata = CORAA_CACHE / f"metadata_{split}_final.csv"
    if not metadata.is_file():
        sys.exit(f"找不到 {metadata}")
    # 我们手上只有 shard-0，所以只取**音频真在手上**的那些条 ——
    # 不能按元数据条数报"可切 12676 条"，那是假的。
    audio = {}
    shards = sorted((CORAA_CACHE / "shards").glob("*.parquet"))
    for shard in shards:
        table = pq.ParquetFile(shard).read(columns=["file_path", "audio"])
        for row in table.to_pylist():
            audio[os.path.basename(str(row["file_path"]))] = row["audio"]["bytes"]

    rows = []
    with open(metadata, encoding="utf-8") as handle:
        for item in csv.DictReader(handle):
            base = os.path.basename(item["file_path"])
            if base not in audio:
                continue
            rows.append({
                "original_id": item["file_path"],
                "dataset": "CORAA",
                "dataset_version": "v1.1",
                "split": split,
                "reference": item["text"],
                "reference_char_spaced": None,
                "session": speaker_of(item["file_path"]),
                "speaker": speaker_of(item["file_path"]),
                "tags": {
                    "register": ("read" if "Read" in (item.get("speech_style") or "")
                                 and "Spontaneous" not in (item.get("speech_style") or "")
                                 else "spontaneous"),
                    "speech_style": item.get("speech_style"),
                    "accent": item.get("accent"),
                    "dataset": item.get("dataset"),
                    "variety": item.get("variety"),
                    "noise_votes": item.get("votes_for_noise_or_low_voice"),
                    "overlap_votes": item.get("votes_for_second_voice"),
                    "hesitation_votes": item.get("votes_for_hesitation"),
                    "filled_pause_votes": item.get("votes_for_filled_pause"),
                },
                "audio_bytes": audio[base],
            })
    return rows


def magicdata_rows(split, root, min_seconds, max_seconds, spread=None,
                   max_rows=MAGICDATA_MAX_POOL_ROWS):
    """读 MagicData-RAMC 的官方划分，切出**逐句**片段。

    数据格式（README 里定义的）：
      · `DataPartition/<split>.tsv`       官方划分：录音名 + 采样点数
      · `MDT2021S003/WAV/<rec>.wav`       16 kHz 单声道 16 bit，每场约 31 分钟
      · `MDT2021S003/TXT/<rec>.txt`       每行 `[start,end]\\tspeaker\\t性别,语言\\t转写`
      · `MDT2021S003/UTTERANCEINFO.txt`   每场的话题与环境（用来当分组标签）

    ⚠️ **只读一个 31 分钟 wav 里需要的那几段**（按帧 seek），不把整场读进内存 ——
       这个数据集 19.8 GB，全读一遍既慢又没必要。

    两趟走（这个顺序是**踩坑改出来的**，不是一开始就这么写的）：
      1. 先只读**转写**（便宜），把每场里合格的片段列成候选；
      2. 每场按 `ceil(spread / 场数)` 抽若干条，**只给抽中的那几条解码音频**。

    为什么不能"边扫边读到够数就停"（第一版就是这么写的，结果切出来的包只覆盖 5 场录音）：
      · 扫到够数就停 = 从**前几场**里取够了就不看后面的场 —— 覆盖度全丢；
      · 就算不限总量，每场"取时间上最靠前的 N 条"也等于每场只取**这场对话的开头**
        （转写是按时间排的），那是有偏的。
      所以候选先全列出来、按种子打散、再各场取前 N 条 —— 每场内部是随机取样，
      各场之间都有份。

    `max_rows` 只是**内存护栏**（真到上限会**大声报出来**，不静默截断）。
    """
    import csv
    import wave

    partition = root / "DataPartition" / f"{split}.tsv"
    if partition.is_file() is False:
        sys.exit(f"找不到官方划分 {partition}（用 --magicdata-dir 指定数据集根目录）")
    wav_dir = root / "MDT2021S003" / "WAV"
    txt_dir = root / "MDT2021S003" / "TXT"

    # 话题/环境：每场一行，拿来做分组标签（报告里可以按环境分组看）
    meta = {}
    info = root / "MDT2021S003" / "UTTERANCEINFO.txt"
    if info.is_file():
        with open(info, encoding="utf-8", errors="replace") as handle:
            for row in csv.DictReader(handle, delimiter="\t"):
                meta[row.get("UTTRANS_ID", "")] = {
                    "topic": row.get("TOPIC"), "environment": row.get("Environment"),
                    "valid_minutes": row.get("VALID(min)"),
                }

    recordings = []
    with open(partition, encoding="utf-8") as handle:
        for row in csv.reader(handle, delimiter="\t"):
            if len(row) >= 1 and row[0].strip().endswith(".wav"):
                recordings.append(row[0].strip())
    recordings.sort()                                 # 定序：不依赖划分文件的行序

    # ── 第一趟：只读转写，列候选（不碰音频）──────────────────────────────
    sessions = []                                     # [(录音名, 音频路径, 候选列表)]
    for recording in recordings:
        transcript = txt_dir / (Path(recording).stem + ".txt")
        audio_path = wav_dir / recording
        if transcript.is_file() is False or audio_path.is_file() is False:
            continue
        with open(transcript, encoding="utf-8", errors="replace") as handle:
            lines = [line.rstrip("\n") for line in handle if line.strip()]
        candidates = []
        for index, line in enumerate(lines):
            parts = line.split("\t")
            if len(parts) < 4:
                continue
            span, speaker, profile, text = parts[0], parts[1], parts[2], "\t".join(parts[3:])
            match = re.match(r"^\[([\d.]+),([\d.]+)\]$", span.strip())
            if match is None:
                continue
            start, end = float(match.group(1)), float(match.group(2))
            seconds = end - start
            if seconds < min_seconds or seconds > max_seconds:
                continue
            # 剔掉事件标记（重叠/听不清/笑声/咳嗽/音乐）——理由见 MAGICDATA_EVENTS 的注释
            if any(event in text for event in MAGICDATA_EVENTS):
                continue
            # 去掉标点后再检查长度：要让"有内容可评"
            clean = re.sub(r"[，。、！？；：,.!?;:\s]", "", text)
            if len(clean) < MAGICDATA_MIN_CHARS:
                continue
            candidates.append({
                "original_id": f"{Path(recording).stem}#{index}",
                "start": start, "end": end, "seconds": seconds,
                "speaker": speaker.strip(), "profile": profile.strip(),
                "reference": text.strip(),
            })
        if candidates:
            sessions.append((Path(recording).stem, audio_path, candidates))

    # 每场名额：让池子**至少能覆盖到每一场**（向上取整）。
    per_session = per_session_quota(spread, len(sessions))

    # ── 第二趟：每场抽够名额，只给抽中的片段解码 ──────────────────────────
    rows = []
    for stem, audio_path, candidates in sessions:
        if per_session is not None:
            # 打散后取前 N 条：每场内部是**随机**取样，不是"这场对话的开头"
            candidates, _ = seeded_shuffle(candidates, f"{split}:{stem}:magicdata")
            candidates = candidates[:per_session]
        tags_extra = meta.get(f"{stem}.wav", {})
        with wave.open(str(audio_path), "rb") as audio:
            rate = audio.getframerate()
            channels = audio.getnchannels()
            # ⚠️ 位深要**按文件读出来的值**决定解码方式，不能想当然写死 int16：
            #    万一这批 wav 不是 16 bit，按 int16 解出来的是一堆**看起来正常的噪声**，
            #    不报错、只是识别全错 —— 这种错最难查。README 说这批是 16 bit，
            #    但"我说的"和"文件里的"必须一致，不一致就以文件为准。
            width = audio.getsampwidth()
            if width == 2:
                dtype = "<i2"
            elif width == 4:
                dtype = "<i4"
            elif width == 1:
                dtype = "u1"
            else:
                sys.exit(f"不认识的位深 {width} 字节：{audio_path}")
            for candidate in candidates:
                start, seconds = candidate["start"], candidate["seconds"]
                audio.setpos(int(start * rate))       # 按帧定位（Wave_read 没有 seek）
                frames = audio.readframes(int(seconds * rate))
                samples = np.frombuffer(frames, dtype=dtype).astype(np.float32)
                if dtype == "<i2":
                    samples /= 32768.0
                elif dtype == "<i4":
                    samples /= 2147483648.0
                elif dtype == "u1":
                    samples = (samples - 128.0) / 128.0
                if channels > 1:
                    samples = samples.reshape(-1, channels).mean(axis=1)
                if samples.size == 0:
                    continue
                rows.append({
                    "original_id": candidate["original_id"],
                    "dataset": "MagicData-RAMC",
                    "dataset_version": "MDT2021S003",
                    "split": split,
                    "reference": candidate["reference"],
                    "reference_char_spaced": None,
                    "session": stem,
                    "speaker": candidate["speaker"],
                    "tags": {
                        "register": "spontaneous",
                        "gender_language": candidate["profile"],
                        "topic": tags_extra.get("topic"),
                        "environment": tags_extra.get("environment"),
                        "start": round(start, 2), "end": round(start + seconds, 2),
                    },
                    "audio_samples": samples,
                })
                if max_rows is not None and len(rows) >= max_rows:
                    # ⚠️ 撞到护栏要**报出来**：静默截断会让"这一包覆盖了全部录音"
                    #    这种说法变成假的，而且看不出任何异常。
                    print(f"⚠️  MagicData 池子撞到内存护栏 {max_rows} 条：后面的场次没读，"
                          f"这一包覆盖的**录音数会明显偏少**（不是全部分划）。"
                          f"把 --count 调小，或调大 MAGICDATA_MAX_POOL_ROWS 再切。")
                    return rows
    return rows


def load_source(source, split, magicdata_root=None, min_seconds=MAGICDATA_MIN_SECONDS,
                max_seconds=MAGICDATA_MAX_SECONDS, spread=None):
    if source.startswith("fleurs-"):
        return fleurs_rows(source, split)
    if source == "coraa":
        return coraa_rows(source, split)
    if source == "magicdata":
        root = Path(magicdata_root) if magicdata_root else MAGICDATA_DEFAULT
        if root.is_dir() is False:
            sys.exit(f"找不到 MagicData 数据集：{root}\n"
                     f"（它是仓库外的 19.8 GB 数据集，用 --magicdata-dir <目录> 指定）")
        return magicdata_rows(split, root, min_seconds, max_seconds, spread=spread)
    sys.exit(f"不认识的语料：{source}")


def pool_for(source, split, base, magicdata_root=None, exclude_speakers=None,
             group_by=None, spread=None):
    """把语料读成"按组排好的候选池"，dev 与保留集**共用同一份池**。

    关键点：顺序由 (base, source, split) 决定，而**不是**由包名决定 ——
    这样 `X-dev` 与 `X-holdout` 看到的是同一个顺序，才能在同一份池上**顺序切**，
    从而保证两包不相交。如果两边各自按自己的包名打散，切出来的必然重叠。

    ⚠️ `exclude_speakers`：官方 dev 与 test 是**两批不同录音**，没法用"同一份池顺序切"
    来保证说话人不相交。所以对这类语料额外按说话人显式排除 —— 见 build() 里的说明。

    ⚠️ `group_by="session"` + `spread=N`：给**每场录音动辄几百句**的语料用（MagicData 就是）。
       不这么做的后果是**实测出来的**，不是猜的：
         · 按说话人分组 + 取前 N 条，第一次切 zh-speech-dev 得到 300 条里只有 **2 个说话人**
           （按组整取 = 取字典序最靠前的两个说话人，每人 ~190 句）；
         · 而一场 31 分钟的录音有 ~350 句合格片段，请求 300 条就等于"差不多一整场录音"，
           按说话人还是按录音分组都躲不开这个事实。
       所以改成：**按录音（session）分组**，先给每场一个名额 `ceil(spread / 场数)`，
       再按场整取 —— 这样 300 条能摊到全部 19 场、500 条能摊到 42/43 场，
       说话人、话题、录音环境都跟着散开。录音是切分单位（一场不会跨两包），
       这个规则不破坏"两包不相交"。
    """
    rows = load_source(source, split, magicdata_root=magicdata_root,
                       # ⚠️ `spread` 要**同时**传进读取层：读取层靠它算"每场取几条"，
                       #    否则会按"从头读够为止"，包会只覆盖前几场录音。
                       spread=spread if group_by == "session" else None)
    excluded = regression_ids()
    kept = []
    for row in rows:
        if exclude_speakers and row["speaker"] in exclude_speakers:
            continue                                  # 与 dev 共用说话人 → 不进保留集
        if {row["original_id"], os.path.basename(row["original_id"])} & excluded:
            continue                                  # 属于历史回归集 → 不进新包
        # ⚠️ 老的历史评测集（zh-eval / pt-eval）**没有记 original_id**，只记了参考文本。
        #    所以只按 id 比对是漏的：那 30 条会重新出现在"新"保留集里，
        #    而老师明确要求它们"保留为历史回归集，不再当作未见测试集"。
        #    这里按**参考文本**再兜一道 —— 文本相同就当作同一条，宁可多排除一条。
        if (row["reference"] or "").strip() in excluded:
            continue
        kept.append(row)
    regression_excluded = len(rows) - len(kept)
    ordered, seed = seeded_shuffle(kept, f"{base}:{source}:{split}")

    # 按"说话人/会话"整组：老师的原话是"不能把同一段录音随机切开分到两组"。
    # CORAA 的文件名里有受访者编号，MagicData 的转写里有说话人 ID —— 同一个人整组不拆。
    groups = {}
    for row in ordered:
        if group_by == "session":
            key = row["session"] or row["original_id"]
        else:
            key = row["speaker"] or row["session"] or row["original_id"]
        groups.setdefault(key, []).append(row)

    # 每场名额：向上取整，让 pool 至少能覆盖到每一场（见 docstring 里的实测理由）。
    # 组内顺序是打散后的顺序，所以"取前 per_group 条"= 这一场里的随机若干条。
    per_group = None
    if spread and groups:
        per_group = per_session_quota(spread, len(groups))
        groups = {key: value[:per_group] for key, value in groups.items()}

    ordered_groups = [groups[key] for key in sorted(groups)]
    return {
        "groups": ordered_groups,
        "available": sum(len(group) for group in ordered_groups),
        "seed": seed,
        "raw": len(rows),
        "regression_excluded": regression_excluded,
        "per_group": per_group,
    }


def select_from_pool(groups, offset, count):
    """从池里**顺序**取：跳过前 offset 个片段，再取 count 个（按组整取，组内不拆）。

    顺序消费是"两包不相交"的全部依据：dev 取 [0, N)，保留集取 [N, N+M)，
    天然不可能重叠。组整取会让实际条数略多于请求值 —— 如实报出来，不四舍五入。
    """
    picked = []
    seen = 0
    for group in groups:
        if len(picked) >= count:
            break
        if seen + len(group) <= offset:               # 整组都在 dev 的地盘里
            seen += len(group)
            continue
        if seen < offset:                             # 跨在边界上的组：跳过（宁可少取）
            seen += len(group)
            continue
        picked.extend(group)
        seen += len(group)
    return picked                                     # 不截断，保住"组内不拆"


def read_manifest(name):
    """读一个已经切好的包的 manifest；没切过就返回 None（不抛异常，让调用方决定怎么办）。"""
    path = PACKS_DIR / name / "manifest.jsonl"
    if path.is_file() is False:
        return None
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def build(name, force=False, magicdata_root=None):
    spec = PACKS[name]
    target = PACKS_DIR / name
    manifest_path = target / "manifest.jsonl"
    if manifest_path.is_file() and not force:
        print(f"⏭  {name} 已经存在（要重建加 --force）")
        return None

    base = name.rsplit("-", 1)[0]                     # zh-read / pt-speech / pt-read
    dev_name = f"{base}-dev"
    is_holdout = name.endswith("-holdout") and dev_name in PACKS

    # 「dev 与保留集怎么分开」有两套规则，取决于语料有没有**官方划分**：
    #
    #   · 在同一份官方划分里自己切（FLEURS validation、CORAA test）——
    #     两包共用同一份池：dev 取前段、保留集接着取，顺序消费天然不相交。
    #   · dev 与 test 是**两批不同录音**（MagicData-RAMC 的官方 dev/test）——
    #     没有"同一份池"可用，靠的是**官方划分本身**（一场录音不会同时出现在两边）。
    #     这里再做一道按说话人的显式排除，作为"说话人没见过"这个说法的护栏。
    #
    # ⚠️ 排除名单必须剔掉**占位说话人**。实测它现在**不**影响结果
    #    （那 62 场里它的合格片段是 0 条），但门槛一放低就会影响，
    #    而且是"安静地删掉整类短回执"这种最难发现的影响 —— 理由见 PLACEHOLDER_SPEAKERS。
    #
    # ⚠️ 第二套规则要求 dev 包**先切好**。缺了它就没有排除名单 —— 所以这里是**硬失败**，
    #    不许静默降级成"没有排除"。实测下来这道护栏现在是 0 排除（真说话人本来就不相交），
    #    但它把"不相交"从一个说法变成一行可核对、可复现的数字。
    exclude_speakers = None
    if is_holdout and PACKS[dev_name]["split"] != spec["split"]:
        dev_items = read_manifest(dev_name)
        if dev_items is None:
            sys.exit(f"❌ {name} 的说话人排除名单来自 {dev_name}，但它还没切。\n"
                     f"   先跑：python asr-eval/asr_pack.py --build {dev_name}")
        exclude_speakers = {item["speaker"] for item in dev_items if item.get("speaker")}
        exclude_speakers -= PLACEHOLDER_SPEAKERS
        print(f"{dev_name} 的真实说话人 {len(exclude_speakers)} 位（占位标记已剔除）")

    pool = pool_for(spec["source"], spec["split"], base,
                    magicdata_root=magicdata_root,
                    exclude_speakers=exclude_speakers,
                    group_by=spec.get("group_by"),
                    spread=spec["count"] if spec.get("group_by") else None)
    groups, seed = pool["groups"], pool["seed"]
    kept, raw_count = pool["available"], pool["raw"]
    if not groups:
        sys.exit(f"❌ {name} 的候选池是空的 —— 不生成空包（检查排除规则与数据集划分）")

    # dev 先占前段，保留集接在后面 —— 两包共用同一个池与同一条顺序切规则。
    #
    # 偏移用 dev **实际**取到的条数（按组整取会让实际值略大于请求值，实测 100 → 101）。
    # ⚠️ 我一度以为这里用"请求条数"会造成**泄漏**，实测**不是**：
    #    `select_from_pool` 里那道 `seen < offset` 的守卫会把"跨在边界上的组"整组跳过，
    #    所以偏移略有偏差也不会重叠（有测试钉住这个性质）。
    #    用实际条数仍然更好 —— 它让"保留集从 dev 之后紧接着开始"这件事是**显然的**，
    #    而不是依赖守卫的副作用。
    # ⚠️ 只有"共用同一份池"时才用偏移。官方划分（dev/test 是两批录音）用的是 0 —— 
    #    池都不是同一份，偏移没有意义，用了只会白白扔掉 test 池的前 300 条。
    if is_holdout and exclude_speakers is None:
        offset = len(select_from_pool(groups, 0, PACKS[dev_name]["count"]))
    else:
        offset = 0
    chosen = select_from_pool(groups, offset, spec["count"])

    target.mkdir(parents=True, exist_ok=True)
    manifest = []
    for index, row in enumerate(chosen):
        # 两种语料喂进来的音频形态不同：FLEURS/CORAA 给的是**未解码的 wav 字节**，
        # MagicData 给的是**已经解码的采样点**（按帧 seek 读出来就是采样点，
        # 再编码回字节纯属浪费）。这里两边都收。
        samples = row.get("audio_samples")
        if samples is None:
            samples = load_wav_bytes(row["audio_bytes"])
        fname = f"{name}-{index:04d}.wav"
        seconds = write_wav(target / fname, samples)
        manifest.append({
            # ── 样本身份 ──
            "file": fname,
            "dataset": row["dataset"],
            "dataset_version": row["dataset_version"],
            "split": row["split"],
            "original_id": row["original_id"],
            # ── 音频 ──
            "seconds": round(seconds, 3),
            "rate": TARGET_RATE,
            "channels": 1,
            # ── 会话信息 ──
            "session": row["session"],
            "speaker": row["speaker"],
            # ── 正确答案（原始转写 + 评分用转写都留）──
            "reference": row["reference"],
            "reference_char_spaced": row["reference_char_spaced"],
            # ── 分组标签 ──
            "tags": row["tags"],
            # ── 关键内容：需要**人工确认过**才能填，脚本不猜 ──
            "key_terms": [],
        })

    with open(manifest_path, "w", encoding="utf-8") as handle:
        for item in manifest:
            handle.write(json.dumps(item, ensure_ascii=False) + "\n")

    seconds_all = [item["seconds"] for item in manifest]
    # 说话人数要**剔掉占位标记**：每个包里都"有" G00000000，算进去等于虚报一位。
    real = real_speakers(manifest)
    sessions = {item["session"] for item in manifest if item.get("session")}

    if spec["source"] == "magicdata":
        split_rule = (f"官方划分（dev/test 是两批不同录音），按**录音**整组取，"
                      f"每场最多 {pool['per_group']} 条"
                      + ("；保留集另外把开发集的真实说话人整人排除"
                         if exclude_speakers is not None else ""))
        caveat = ("✅ 用的是**官方划分**（dev 19 场 / test 43 场），不是自己从一批录音里切的。"
                  "逐句时间戳来自官方转写；重叠语音 / 听不清 / 笑声咳嗽音乐等事件标记片段已剔除"
                  f"（剔除理由见 asr_pack.py 里 MAGICDATA_EVENTS 的注释）。"
                  f"⚠️ 说话人身份里有一个占位标记 {sorted(PLACEHOLDER_SPEAKERS)[0]}"
                  "（实测它出现在全部 62 场录音里），统计说话人数时已剔除。")
    elif spec["source"] == "coraa":
        split_rule = ("按说话人编号整组取（同一受访者的片段不跨包）"
                      if speakers else "无说话人标注，按确定性打散后取前 N 条")
        caveat = ("⚠️ 本地只有 CORAA 的 test 分片，所以这一包是从 **test** 切出来的，"
                  "不是官方 dev。dev 与保留集之间按说话人编号做了不相交，"
                  "但仍在同一批采集条件下 —— 结论的强度不如"
                  "「官方 dev 调参 + 官方 test 验收」。")
    else:
        split_rule = ("按说话人整组取（同一说话人的片段不跨包）"
                      if speakers else "无说话人标注，按确定性打散后取前 N 条")
        caveat = None

    pack_meta = {
        "pack": name,
        "note": spec["note"],
        "source": spec["source"],
        "official_split": spec["split"],
        # 语料根目录：MagicData 这类仓库外的大数据集不写死在代码里，
        # 实际用的是哪份记在这里（免得半年后说不清数字是拿哪份数据跑出来的）。
        "corpus_root": (str(Path(magicdata_root) if magicdata_root else MAGICDATA_DEFAULT)
                        if spec["source"] == "magicdata" else None),
        # 池子被截到多少条（MagicData 的内存护栏）—— 不记下来的话，
        # 半年后没法回答"这一包到底是从多大一个池子里取的"。
        "pool_rows_cap": (MAGICDATA_MAX_POOL_ROWS if spec["source"] == "magicdata" else None),
        "seed": seed,
        "requested": spec["count"],
        "actual": len(manifest),
        "total_seconds": round(sum(seconds_all), 1),
        "median_seconds": round(float(np.median(seconds_all)), 2) if seconds_all else None,
        "speakers": len(real),
        "sessions": len(sessions),
        "available_after_exclusion": pool["available"],
        "excluded_as_regression": pool["regression_excluded"],
        # 每场录音取了多少条（只有按场分组的语料才有意义）
        "per_session_cap": pool["per_group"],
        "excluded_dev_speakers": (sorted(exclude_speakers) if exclude_speakers
                                  else ([] if spec["source"] == "magicdata" else None)),
        # ⚠️ 这条说明要**跟语料走**：FLEURS 那句"排掉 82 行是正常的"只在 FLEURS 上成立，
        #    照抄到 MagicData 上就是一句和事实不符的注释（本包实测排除 0 条）。
        "exclusion_rule": ("按 original_id / 文件名 / **参考文本** 三重比对排除历史回归集。"
                           + ("⚠️ 排除数远多于回归集条数（30 条却排掉 82 行）是**正常的**："
                              "FLEURS 同一句话由 2~3 个说话人各录一遍，"
                              "按文本比对会把同一句的所有录音一起排掉。"
                              "这也是保留集凑不满 300 条的原因之一。"
                              if spec["source"].startswith("fleurs-")
                              else f"本包与历史回归集没有交集（实测排除 {pool['regression_excluded']} 条）。")),
        "split_rule": split_rule,
        "caveat": caveat,
    }
    with open(target / "pack.json", "w", encoding="utf-8") as handle:
        json.dump(pack_meta, handle, ensure_ascii=False, indent=2)

    print(f"✅ {name:<20} {len(manifest):>4} 条  {sum(seconds_all):>7.1f} 秒  "
          f"说话人 {len(real) or '—'}  录音 {len(sessions) or '—'}  →  var/asr-eval/packs/{name}")
    return pack_meta


def write_key_candidates():
    """为每个包生成**关键内容候选清单**，供人工确认。

    老师 §三 要求"专名、数字另做专项评分"，而且 key_terms 必须是**人工确认过的**。
    所以这一步只提候选、不下结论：脚本提客观可判的两类（数字 + 拉丁字母词），
    人过一遍把确认的填回 manifest 的 `key_terms`，之后再跑评测才有专项分数。
    ⚠️ 中文人名/机构名故意不提 —— 没有可靠启发式，硬提会把清单淹掉。
    """
    from asr_score import key_term_candidates

    total = 0
    print("关键内容候选（需人工确认后填回 manifest 的 key_terms）：")
    for name in PACKS:
        manifest = PACKS_DIR / name / "manifest.jsonl"
        if not manifest.is_file():
            continue
        items = [json.loads(line) for line in manifest.read_text(encoding="utf-8").splitlines() if line.strip()]
        rows = []
        for item in items:
            candidates = key_term_candidates(item["reference"])
            if candidates:
                rows.append({"file": item["file"], "reference": item["reference"],
                             "candidates": candidates})
        target = PACKS_DIR / name / "key-candidates.jsonl"
        with open(target, "w", encoding="utf-8") as handle:
            for row in rows:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        total += len(rows)
        print(f"  {name:<20} {len(rows):>4}/{len(items)} 条有候选 → var/asr-eval/packs/{name}/key-candidates.jsonl")
    print("")
    print(f"共 {total} 条待人工确认。确认后把词填进对应 manifest 行的 key_terms 字段。")
    return 0


def verify():
    """把"切分卫生"变成一条命令 —— 老师的要求里最容易被忽略、也最致命的一条：
    dev 与保留集必须不相交（按样本、也按说话人），且都不能混进历史回归集。

    为什么要做成命令而不是我当时看一眼就算了：
    切分一旦有泄漏，**后面所有"保留集上的成绩"都是假的**，
    而它不会报错、不会崩，只会让数字好看一点。这种事必须能被反复查。
    """
    problems = []
    print("包清单：")
    for name in PACKS:
        manifest = PACKS_DIR / name / "manifest.jsonl"
        if not manifest.is_file():
            print(f"  ⬜ {name:<20} 未切")
            continue
        items = [json.loads(line) for line in manifest.read_text(encoding="utf-8").splitlines() if line.strip()]
        seconds = sum(item["seconds"] for item in items)
        # 说话人数剔掉占位标记（理由见 PLACEHOLDER_SPEAKERS）—— 不剔就会每个包都虚报一位。
        speakers = real_speakers(items)
        sessions = {item["session"] for item in items if item.get("session")}
        ids = [item["original_id"] for item in items]
        if len(set(ids)) != len(ids):
            problems.append(f"{name}: original_id 有重复（{len(ids)} 条里只有 {len(set(ids))} 个唯一）")
        missing = [item["file"] for item in items if not (PACKS_DIR / name / item["file"]).is_file()]
        if missing:
            problems.append(f"{name}: {len(missing)} 个 wav 文件不在（如 {missing[0]}）")
        # 覆盖度是**硬指标**，不是好看的数字：300 条只覆盖 2 个说话人的包，
        # 测出来的错率代表不了"这个语料"（这正是第一次切 zh-speech 踩到的坑）。
        # 所以把"录音数 / 说话人数"直接打出来，让人一眼能看见覆盖率。
        # ⚠️ 只在"一场录音确实含多条片段"时才打录音数 —— FLEURS/CORAA 是一句一条记录，
        #    按录音数打出来会和条数一样，看着像覆盖了 300 场，其实那个数字没有意义。
        covered = f"录音 {len(sessions)}" if 0 < len(sessions) < len(items) else ""
        print(f"  ✅ {name:<20} {len(items):>4} 条 {seconds:>8.1f} 秒  "
              f"说话人 {len(speakers) or '—'}  {covered}  中位时长 "
              f"{sorted(i['seconds'] for i in items)[len(items) // 2]:.1f}s")

    print("")
    print("切分卫生：")
    reg = regression_ids()
    for base in sorted({name.rsplit("-", 1)[0] for name in PACKS}):
        dev = PACKS_DIR / f"{base}-dev" / "manifest.jsonl"
        hold = PACKS_DIR / f"{base}-holdout" / "manifest.jsonl"
        if not (dev.is_file() and hold.is_file()):
            print(f"  ⬜ {base}: dev 或保留集未切，跳过")
            continue
        def read(path):
            return [json.loads(line) for line in
                    Path(path).read_text(encoding="utf-8").splitlines() if line.strip()]

        dev_items, hold_items = read(dev), read(hold)
        ids = {item["original_id"] for item in dev_items}
        texts = {item["reference"] for item in dev_items}
        # ⚠️ 说话人比对同样要剔掉占位标记。实测它现在在这两个包里是 0 条（见 PLACEHOLDER_SPEAKERS），
        #    所以这一步现在是空操作 —— 但门槛一放低它就会让 dev/test **天天报重叠**，
        #    而"天天报假警报的检查"等于没有检查。
        speaker_dev = real_speakers(dev_items)
        speaker_hold = real_speakers(hold_items)
        same_id = [item["original_id"] for item in hold_items if item["original_id"] in ids]
        same_text = [item["original_id"] for item in hold_items if item["reference"] in texts]
        same_speaker = speaker_dev & speaker_hold
        leaked = [item["original_id"] for item in dev_items + hold_items
                  if item["original_id"] in reg or item["reference"] in reg]
        # ⚠️ 这三条是**硬失败**：撞上任何一条，"保留集上的成绩"就是假的。
        hard = []
        if same_id:
            hard.append(f"样本重叠 {len(same_id)}")
        if same_speaker:
            hard.append(f"说话人重叠 {len(same_speaker)}")
        if leaked:
            hard.append(f"混入历史回归集 {len(leaked)}")
        # ⚠️ 而"参考文本重复"是**软提示，不是失败** —— 这一点我第一版判错了。
        #    老师警告的是"不能把**同一段录音**随机切开分到两组"（那是样本泄漏）。
        #    文本相同、录音不同（同一句话由不同说话人各录一遍）是**两个独立样本**，
        #    对识别评测不构成泄漏。但它确实削弱了"文本从未见过"这个说法，
        #    所以如实报出来、由读的人决定要不要介意。
        soft = f"参考文本重复 {len(same_text)}" if same_text else None
        if hard:
            problems.append(f"{base}: " + "、".join(hard))
            print(f"  ❌ {base}: " + "、".join(hard))
        else:
            tail = f"（⚠️ {soft}：同一句话由不同说话人各录一遍，样本仍不相交）" if soft else ""
            print(f"  ✅ {base}: 样本不相交、说话人不相交、未混入历史回归集{tail}")

    print("")
    if problems:
        print(f"❌ 发现 {len(problems)} 个问题：")
        for item in problems:
            print(f"   {item}")
        return 1
    print("✅ 切分卫生检查全部通过")
    return 0


def main():
    parser = argparse.ArgumentParser(description="切出可复现的识别测试包")
    parser.add_argument("--list", action="store_true", help="列出所有包与本地可切数量")
    parser.add_argument("--build", default=None, help="包名，或 all")
    parser.add_argument("--verify", action="store_true", help="检查已切好的包（切分卫生）")
    parser.add_argument("--keys", action="store_true",
                        help="为每个包生成关键内容候选清单（供人工确认，脚本不替人拍板）")
    parser.add_argument("--force", action="store_true", help="已存在也重建")
    parser.add_argument("--magicdata-dir", default=None,
                        help=f"MagicData-RAMC 数据集根目录（默认 {MAGICDATA_DEFAULT}）")
    args = parser.parse_args()

    if args.keys:
        return write_key_candidates()

    if args.verify:
        return verify()

    if args.list or args.build is None:
        print("可切的测试包：")
        for name, spec in PACKS.items():
            have = PACKS_DIR / name / "manifest.jsonl"
            mark = "已存在" if have.is_file() else "未切"
            print(f"  {name:<20} {spec['count']:>4} 条  [{mark}]  {spec['note']}")
        print("")
        print("本地语料（切分只能用这些 —— 其余需要下载）：")
        print(f"  FLEURS cmn_hans_cn_validation   {FLEURS_CACHE / 'cmn_hans_cn_validation.parquet'}")
        print(f"  FLEURS pt_br_validation         {FLEURS_CACHE / 'pt_br_validation.parquet'}")
        print(f"  CORAA 元数据 dev/test + shards  {CORAA_CACHE}")
        root = Path(args.magicdata_dir) if args.magicdata_dir else MAGICDATA_DEFAULT
        mark = "" if root.is_dir() else "   ← 不在这里，用 --magicdata-dir 指定"
        print(f"  MagicData-RAMC（中文口语）      {root}{mark}")
        return 0

    names = list(PACKS) if args.build == "all" else [args.build]
    for name in names:
        if name not in PACKS:
            sys.exit(f"没有这个包：{name}（用 --list 看）")
    print(f"排除历史回归集：{', '.join(REGRESSION_SETS)}")
    print("")
    for name in names:
        build(name, force=args.force, magicdata_root=args.magicdata_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
