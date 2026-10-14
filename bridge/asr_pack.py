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
  python bridge/asr_pack.py --list                  # 列出能切哪些包、各有多少条
  python bridge/asr_pack.py --build zh-read-dev     # 切一个包
  python bridge/asr_pack.py --build all             # 全切

每个包容器的内容
  <pack>/manifest.jsonl   每条样本一行，字段见 docs/14（样本身份 / 音频 / 会话 / 正确答案 / 分组标签）
  <pack>/pack.json        这一包是怎么切出来的（数据集、版本、切分规则、种子、统计）—— 审计用
"""

import argparse
import hashlib
import json
import os
import random
import sys
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))

from asr_eval import load_wav_bytes                      # noqa: E402
from whisper_transcribe import TARGET_RATE               # noqa: E402

FLEURS_CACHE = ROOT / "var" / "cache" / "fleurs"
CORAA_CACHE = ROOT / "var" / "cache" / "coraa"
AUDIO_DIR = ROOT / "var" / "audio"

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
}


def regression_ids():
    """历史回归集里已经用过的原始 id / 文件名 —— 新包要避开它们。"""
    used = set()
    for name in REGRESSION_SETS:
        manifest = AUDIO_DIR / name / "manifest.jsonl"
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


def load_source(source, split):
    if source.startswith("fleurs-"):
        return fleurs_rows(source, split)
    if source == "coraa":
        return coraa_rows(source, split)
    sys.exit(f"不认识的语料：{source}")


def pool_for(source, split, base):
    """把语料读成"按组排好的候选池"，dev 与保留集**共用同一份池**。

    关键点：顺序由 (base, source, split) 决定，而**不是**由包名决定 ——
    这样 `X-dev` 与 `X-holdout` 看到的是同一个顺序，才能在同一份池上**顺序切**，
    从而保证两包不相交。如果两边各自按自己的包名打散，切出来的必然重叠。
    """
    rows = load_source(source, split)
    excluded = regression_ids()
    kept = []
    for row in rows:
        if {row["original_id"], os.path.basename(row["original_id"])} & excluded:
            continue                                  # 属于历史回归集 → 不进新包
        # ⚠️ 老的历史评测集（zh-eval / pt-eval）**没有记 original_id**，只记了参考文本。
        #    所以只按 id 比对是漏的：那 30 条会重新出现在"新"保留集里，
        #    而老师明确要求它们"保留为历史回归集，不再当作未见测试集"。
        #    这里按**参考文本**再兜一道 —— 文本相同就当作同一条，宁可多排除一条。
        if (row["reference"] or "").strip() in excluded:
            continue
        kept.append(row)
    ordered, seed = seeded_shuffle(kept, f"{base}:{source}:{split}")

    # 按"说话人/会话"整组：老师的原话是"不能把同一段录音随机切开分到两组"。
    # CORAA 的文件名里有受访者编号，所以同一个人必须整组落在同一侧。
    groups = {}
    for row in ordered:
        key = row["session"] if row["session"] is not None else row["original_id"]
        groups.setdefault(key, []).append(row)
    return [groups[key] for key in sorted(groups)], kept, seed, len(rows)


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


def build(name, force=False):
    spec = PACKS[name]
    target = AUDIO_DIR / name
    manifest_path = target / "manifest.jsonl"
    if manifest_path.is_file() and not force:
        print(f"⏭  {name} 已经存在（要重建加 --force）")
        return None

    base = name.rsplit("-", 1)[0]                     # zh-read / pt-speech / pt-read
    groups, kept, seed, raw_count = pool_for(spec["source"], spec["split"], base)

    # dev 先占前段，保留集接在后面 —— 两包共用同一个池与同一条顺序切规则。
    #
    # 偏移用 dev **实际**取到的条数（按组整取会让实际值略大于请求值，实测 100 → 101）。
    # ⚠️ 我一度以为这里用"请求条数"会造成**泄漏**，实测**不是**：
    #    `select_from_pool` 里那道 `seen < offset` 的守卫会把"跨在边界上的组"整组跳过，
    #    所以偏移略有偏差也不会重叠（有测试钉住这个性质）。
    #    用实际条数仍然更好 —— 它让"保留集从 dev 之后紧接着开始"这件事是**显然的**，
    #    而不是依赖守卫的副作用。
    dev_name = f"{base}-dev"
    if name.endswith("-holdout") and dev_name in PACKS:
        offset = len(select_from_pool(groups, 0, PACKS[dev_name]["count"]))
    else:
        offset = 0
    chosen = select_from_pool(groups, offset, spec["count"])

    target.mkdir(parents=True, exist_ok=True)
    manifest = []
    for index, row in enumerate(chosen):
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
    speakers = {item["speaker"] for item in manifest if item["speaker"]}
    pack_meta = {
        "pack": name,
        "note": spec["note"],
        "source": spec["source"],
        "official_split": spec["split"],
        "seed": seed,
        "requested": spec["count"],
        "actual": len(manifest),
        "total_seconds": round(sum(seconds_all), 1),
        "median_seconds": round(float(np.median(seconds_all)), 2) if seconds_all else None,
        "speakers": len(speakers),
        "available_after_exclusion": len(kept),
        "excluded_as_regression": raw_count - len(kept),
        "exclusion_rule": ("按 original_id / 文件名 / **参考文本** 三重比对排除历史回归集。"
                           "⚠️ 排除数远多于回归集条数（30 条却排掉 82 行）是**正常的**："
                           "FLEURS 同一句话由 2~3 个说话人各录一遍，"
                           "按文本比对会把同一句的所有录音一起排掉。"
                           "这也是保留集凑不满 300 条的原因之一。"),
        "split_rule": ("按说话人编号整组取（同一受访者的片段不跨包）"
                       if speakers else "无说话人标注，按确定性打散后取前 N 条"),
        "caveat": ("⚠️ 本地只有 CORAA 的 test 分片，所以这一包是从 **test** 切出来的，"
                   "不是官方 dev。dev 与保留集之间按说话人编号做了不相交，"
                   "但仍在同一批采集条件下 —— 结论的强度不如"
                   "「官方 dev 调参 + 官方 test 验收」。"
                   if spec["source"] == "coraa" else None),
    }
    with open(target / "pack.json", "w", encoding="utf-8") as handle:
        json.dump(pack_meta, handle, ensure_ascii=False, indent=2)

    print(f"✅ {name:<20} {len(manifest):>4} 条  {sum(seconds_all):>7.1f} 秒  "
          f"说话人 {len(speakers) or '—'}  →  var/audio/{name}")
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
        manifest = AUDIO_DIR / name / "manifest.jsonl"
        if not manifest.is_file():
            continue
        items = [json.loads(line) for line in manifest.read_text(encoding="utf-8").splitlines() if line.strip()]
        rows = []
        for item in items:
            candidates = key_term_candidates(item["reference"])
            if candidates:
                rows.append({"file": item["file"], "reference": item["reference"],
                             "candidates": candidates})
        target = AUDIO_DIR / name / "key-candidates.jsonl"
        with open(target, "w", encoding="utf-8") as handle:
            for row in rows:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        total += len(rows)
        print(f"  {name:<20} {len(rows):>4}/{len(items)} 条有候选 → var/audio/{name}/key-candidates.jsonl")
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
        manifest = AUDIO_DIR / name / "manifest.jsonl"
        if not manifest.is_file():
            print(f"  ⬜ {name:<20} 未切")
            continue
        items = [json.loads(line) for line in manifest.read_text(encoding="utf-8").splitlines() if line.strip()]
        seconds = sum(item["seconds"] for item in items)
        speakers = {item["speaker"] for item in items if item.get("speaker")}
        ids = [item["original_id"] for item in items]
        if len(set(ids)) != len(ids):
            problems.append(f"{name}: original_id 有重复（{len(ids)} 条里只有 {len(set(ids))} 个唯一）")
        missing = [item["file"] for item in items if not (AUDIO_DIR / name / item["file"]).is_file()]
        if missing:
            problems.append(f"{name}: {len(missing)} 个 wav 文件不在（如 {missing[0]}）")
        print(f"  ✅ {name:<20} {len(items):>4} 条 {seconds:>8.1f} 秒  "
              f"说话人 {len(speakers) or '—'}  中位时长 "
              f"{sorted(i['seconds'] for i in items)[len(items) // 2]:.1f}s")

    print("")
    print("切分卫生：")
    reg = regression_ids()
    for base in sorted({name.rsplit("-", 1)[0] for name in PACKS}):
        dev = AUDIO_DIR / f"{base}-dev" / "manifest.jsonl"
        hold = AUDIO_DIR / f"{base}-holdout" / "manifest.jsonl"
        if not (dev.is_file() and hold.is_file()):
            print(f"  ⬜ {base}: dev 或保留集未切，跳过")
            continue
        def read(path):
            return [json.loads(line) for line in
                    Path(path).read_text(encoding="utf-8").splitlines() if line.strip()]

        dev_items, hold_items = read(dev), read(hold)
        ids = {item["original_id"] for item in dev_items}
        texts = {item["reference"] for item in dev_items}
        speaker_dev = {item["speaker"] for item in dev_items if item.get("speaker")}
        speaker_hold = {item["speaker"] for item in hold_items if item.get("speaker")}
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
    args = parser.parse_args()

    if args.keys:
        return write_key_candidates()

    if args.verify:
        return verify()

    if args.list or args.build is None:
        print("可切的测试包：")
        for name, spec in PACKS.items():
            have = AUDIO_DIR / name / "manifest.jsonl"
            mark = "已存在" if have.is_file() else "未切"
            print(f"  {name:<20} {spec['count']:>4} 条  [{mark}]  {spec['note']}")
        print("")
        print("本地语料（切分只能用这些 —— 其余需要下载）：")
        print(f"  FLEURS cmn_hans_cn_validation   {FLEURS_CACHE / 'cmn_hans_cn_validation.parquet'}")
        print(f"  FLEURS pt_br_validation         {FLEURS_CACHE / 'pt_br_validation.parquet'}")
        print(f"  CORAA 元数据 dev/test + shards  {CORAA_CACHE}")
        return 0

    names = list(PACKS) if args.build == "all" else [args.build]
    for name in names:
        if name not in PACKS:
            sys.exit(f"没有这个包：{name}（用 --list 看）")
    print(f"排除历史回归集：{', '.join(REGRESSION_SETS)}")
    print("")
    for name in names:
        build(name, force=args.force)
    return 0


if __name__ == "__main__":
    sys.exit(main())
