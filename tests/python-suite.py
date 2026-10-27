#!/usr/bin/env python3
"""
python-suite.py —— 语音分段器与音频读入的验证套件
========================================================================================
    python tests/python-suite.py

为什么要单独给这一层写测试：
    tests/ 里的 JS 套件覆盖的是"插件"（翻译、收件箱、字幕总线、局域网转发）。
    但同传链路上还有一段完全在 JS 之外的东西：**把连续音频切成一句一句**。
    它没有模型也能测 —— 用合成的正弦波当"说话"，用噪声当"环境"，
    于是"该切几句"是已知的，可以断言。

    这里最重要的一条是"高噪声下自适应门槛不能失效"：
    它对应的是一类**静默失败** —— 程序不报错、也不崩，只是再也不切句，
    结果字幕十几秒才出一次。这种 bug 光看日志很难发现，必须有测试钉住。

本套件只依赖 numpy（不加载 Whisper 模型），所以跑得很快，适合放进全量验证。

被验的代码分布在两处，都是有意的：
    产线（bridge/）：分段器、音频读入、闸门、缺省参数
    评测层（asr-eval/）：评分规则、测试包切分、错误来源分类、命令行解析
两层的关系是**单向**的（评测层可以 import 产线，产线永远不 import 评测层），
所以这里把两个目录都加进 sys.path —— 这条方向本身也有断言在查
（tests/asr-pack-suite.mjs）。
"""

import sys
import os
import subprocess
import importlib.util
import wave
import contextlib
import inspect
import io
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
# 产线那一半（分段器、音频读入、闸门）
sys.path.insert(0, str(ROOT / "bridge"))
# 识别评测那一半（评分规则、测试包切分、错误分类）—— 代码在 asr-eval/ 下，
# 数据在 var/asr-eval/ 下，见 asr-eval/README.md
sys.path.insert(0, str(ROOT / "asr-eval"))

from whisper_stream import (   # noqa: E402
    LANGUAGE_PROMPTS, SPEECH_RMS_FLOOR, ContextCarry, IdleTracker, PcmFollower, Stats,
    UtteranceSegmenter, context_depth_for, decide_no_speech, looks_like_context_echo,
    emit, looks_like_hallucination, looks_like_prompt_echo, normalize_peak, parse_args,
    pick_language, prompt_for, rms_of, transcribe, whisper_language_of,
)
import whisper_stream                                                    # noqa: E402
from whisper_transcribe import TARGET_RATE, load_audio                    # noqa: E402
import asr_pack                                                          # noqa: E402
from asr_pack import (select_from_pool, per_session_quota, pool_for,     # noqa: E402
                      real_speakers, PLACEHOLDER_SPEAKERS)
import asr_eval                                                          # noqa: E402
import asr_error_analysis as analysis                                    # noqa: E402
from asr_eval import (   # noqa: E402
    count_traditional, detect_unit, error_rate, looks_chinese,
)
from asr_score import (                                                  # noqa: E402
    NORMALIZED_RULES_VERSION, SCORING_RULES_VERSION, VARIANT_TO_SIMPLIFIED, TRADITIONAL_ONLY,
    align, align_ops, chinese_numeral_value, error_rate, format_problem_samples,
    is_variant_pair, negation_flags, normalize, normalize_for_scoring, normalized_error_rate,
    numeric_report, portuguese_number_value, problem_samples,
)

passed = 0
failures = []
section = ""


def heading(text):
    global section
    section = text
    print("\n" + text)


def check(label, condition, detail=""):
    global passed
    if condition:
        passed += 1
        print(f"  ✅ {label}")
    else:
        failures.append((section, label, detail))
        print(f"  ❌ {label}" + (f"\n     {detail}" if detail else ""))


def _raises(thunk):
    """跑一个应当报错的调用；只关心"报没报错"（错误文案另有断言）。"""
    try:
        thunk()
    except ValueError:
        return True
    return False


def _error_of(thunk):
    try:
        thunk()
    except ValueError as error:
        return str(error)
    return ""


def _exit_message_of(thunk):
    """命令行工具里有几处用 SystemExit 报错（对用户就是一句提示）。

    ⚠️ 它是 BaseException 的子类，`_error_of`（只接 ValueError）接不住 ——
    直接把 lambda 传给 `_error_of` 会让整个测试进程退出、退出码 1，
    看起来像"整套失败了"，实际只是那条断言没被这条路径覆盖到。
    """
    try:
        thunk()
    except SystemExit as error:
        return str(error)
    return ""


def _partial_payload():
    """造一份"只跑了 C1,T2"的最小 payload，用来验证报告有没有如实标注。"""
    row = {
        "recording": "R1.wav", "start": 0.0, "end": 30.0, "duration": 30.0, "segments": 8,
        "reference": "你好",
        "modes": {
            "C1": {"rate": 0.16, "normalized": {"rate": 0.15, "units": 2, "distance": 0,
                                                "substitutions": 0, "deletions": 0, "insertions": 0},
                   "units": 2, "distance": 1, "substitutions": 1, "deletions": 0, "insertions": 0,
                   "text": "尼好", "segmentRates": [0.0, 0.5], "promptEcho": 0, "fallbacks": 0,
                   "disagreements": 0},
            "T2": {"rate": 0.10, "normalized": {"rate": 0.10, "units": 2, "distance": 0,
                                                "substitutions": 0, "deletions": 0, "insertions": 0},
                   "units": 2, "distance": 0, "substitutions": 0, "deletions": 0, "insertions": 0,
                   "text": "你好", "segmentRates": [0.0, 0.2], "promptEcho": 0, "fallbacks": 0,
                   "disagreements": 0},
        },
    }
    summary = {mode: {"rate": row["modes"][mode]["rate"],
                      "normalized": 0.15, "units": 2, "sdi": (1, 0, 0),
                      "used": 1.0, "echo": 0, "fallbacks": 0, "disagreements": 0}
               for mode in ("C1", "T2")}
    return {
        "config": {"spansFile": "spans/x.json", "spansDigest": "d", "spans": 1,
                   "totalSeconds": 30.0, "model": "large-v3", "device": "cuda",
                   "computeType": "float16", "beamSize": 5, "vadFilter": True,
                   "scoringRules": SCORING_RULES_VERSION,
                   "normalizedRules": NORMALIZED_RULES_VERSION,
                   "modesRun": ["C1", "T2"], "modesSkipped": ["T1", "L", "R"],
                   "modesAutoBase": False, "limit": 0,
                   "modeLabels": {"C1": "C1 逐段独立解码（产线现状）", "T2": "T2 逐段 + 提示词（前两段文本）"},
                   "rerun": "python asr-eval/context_overlap.py --spans-file spans/x.json --modes C1,T2"},
        "summary": summary,
        "paired": {"T2": {"better": 1, "worse": 0, "same": 1, "meanDelta": -0.15}},
        "verdict": {}, "records": [row],
    }


def tone(seconds, amplitude=0.15):
    """用正弦波冒充"说话声"。频率取 220Hz，避开直流和采样率边界。"""
    t = np.arange(int(round(seconds * TARGET_RATE)), dtype=np.float32) / TARGET_RATE
    return (amplitude * np.sin(2 * np.pi * 220.0 * t)).astype(np.float32)


def noise(seconds, level, seed=7):
    rng = np.random.default_rng(seed)
    data = rng.normal(0.0, 1.0, int(round(seconds * TARGET_RATE))).astype(np.float32)
    return (data * (level / float(np.sqrt(np.mean(data ** 2))))).astype(np.float32)


def build(segments):
    """segments 是 (类型, 时长) 的列表：('tone', 1.2) / ('silence', 1.0) / ('noise', 2.5)"""
    pieces = []
    for kind, seconds in segments:
        if kind == "tone":
            pieces.append(tone(seconds))
        elif kind == "noise":
            pieces.append(noise(seconds, NOISE_LEVEL))
        else:
            pieces.append(np.zeros(int(round(seconds * TARGET_RATE)), dtype=np.float32))
    return np.concatenate(pieces)


def run_segmenter(audio, adaptive=True, rms_threshold=0.01, max_speech_ms=15000,
                  min_speech_ms=300, silence_ms=700, preroll_ms=250,
                  short_utterance_ms=800, short_silence_ms=1100, cut_pause_ms=200):
    segmenter = UtteranceSegmenter(
        TARGET_RATE, 100, silence_ms, min_speech_ms, max_speech_ms,
        rms_threshold, preroll_ms, np,
        adaptive=adaptive,
        short_utterance_ms=short_utterance_ms, short_silence_ms=short_silence_ms,
        cut_pause_ms=cut_pause_ms,
    )
    found = []
    for start in range(0, len(audio), segmenter.block):
        found.extend(segmenter.push(audio[start:start + segmenter.block]))
    last = segmenter.flush()
    if last is not None:
        found.append(last)
    return found, segmenter


NOISE_LEVEL = 0.012      # 比缺省的固定阈值 0.01 更高 —— 正是让第一版自适应失效的条件


def main():
    print("\n=== 语音分段与音频读入 验证 ===")

    # ── 1. 干净环境下按静音切句 ───────────────────────────────────────────────
    heading("分段器 · 干净环境")
    clean = build([("silence", 0.5)] + [("tone", 1.2), ("silence", 1.0)] * 3)
    found, seg = run_segmenter(clean)
    check("三段声音切成三段（不多不少）", len(found) == 3, f"实际切出 {len(found)} 段")
    lengths = [len(x) / TARGET_RATE for x in found]
    check("每段长度约等于说话时长（含前导缓存，不超上限）",
          all(1.2 <= n <= 1.7 for n in lengths), f"各段长度 {[round(n, 2) for n in lengths]}")

    # ── 2. 高噪声环境下自适应门槛必须仍然工作（回归测试）────────────────────
    # 这条钉住的是真实发生过的 bug：最初自适应只在"没在说话"的块上更新噪声底，
    # 而噪声 0.012 ≥ 缺省阈值 0.01 时，第一块就被判成"在说话"，于是永远进不了
    # "没在说话"分支 → 噪声底永远测不出来 → 自适应完全失效 → 整段并成一句。
    heading("分段器 · 高噪声环境（回归：自适应门槛不能失效）")
    noisy = build([("noise", 2.5)] + [("tone", 1.2), ("noise", 1.0)] * 3 + [("noise", 1.0)])
    found_noisy, seg_noisy = run_segmenter(noisy)
    check("底噪 0.012 高于缺省阈值 0.01 时，仍然切成三段",
          len(found_noisy) == 3, f"实际切出 {len(found_noisy)} 段 —— 并句了，字幕会十几秒才出一次")
    check("噪声底被真的测出来了（不是 None）", seg_noisy.noise_floor is not None,
          "噪声底测不出来 = 自适应没生效")
    check("门槛被抬到噪声之上", seg_noisy.threshold > NOISE_LEVEL,
          f"门槛 {seg_noisy.threshold:.4f} ≤ 噪声 {NOISE_LEVEL}")
    check("门槛没有高到把说话也当静音", seg_noisy.threshold < 0.15 * 0.7,
          f"门槛 {seg_noisy.threshold:.4f} 高得可疑")

    # ── 3. 同一段音频，固定阈值确实会失败 ────────────────────────────────────
    # 有这条，"自适应"才算被证明是有用的，而不是加了段没人验证过的复杂度。
    heading("分段器 · 同一段高噪声音频，固定阈值会失败（证明上面的修复不是白加的）")
    found_fixed, _ = run_segmenter(noisy, adaptive=False, rms_threshold=0.01)
    check("固定阈值 0.01 时明显并句（少于 3 段）",
          len(found_fixed) < 3, f"固定阈值也切出了 {len(found_fixed)} 段，那这条测试没测到东西")

    # ── 4. 太短的响声当噪声丢掉 ──────────────────────────────────────────────
    heading("分段器 · 丢弃过短的响声")
    blip = build([("silence", 0.5), ("tone", 0.1), ("silence", 1.0), ("tone", 1.2), ("silence", 0.5)])
    found_blip, _ = run_segmenter(blip)
    check("0.1 秒的响声被丢掉，只留下那句 1.2 秒的", len(found_blip) == 1,
          f"实际切出 {len(found_blip)} 段")

    # ── 5. 一直不停口就强制断句 ──────────────────────────────────────────────
    heading("分段器 · 长时间不停口时强制断句")
    endless = build([("silence", 0.3), ("tone", 20.0), ("silence", 0.3)])
    found_endless, _ = run_segmenter(endless, max_speech_ms=4000)
    check("连续说话被切成多段（否则字幕永远不出）", len(found_endless) >= 4,
          f"实际切出 {len(found_endless)} 段")
    check("没有任何一段超过强制上限太多",
          all(len(x) / TARGET_RATE <= 4.5 for x in found_endless),
          f"最长 {max(len(x) / TARGET_RATE for x in found_endless):.2f}s")

    # ── 6. 到上限时优先在"停顿"处断，而不是在固定位置硬切 ────────────────────
    #
    # 这条钉住的是真实发生过的故障：说话人被合并成长段后，断点正好落在第 15 秒
    # 那个样本上 —— 说话说到一半被切断，两条字幕各拿半句。用户报的就是
    # "长对话被截断"。用 asr-eval/segment_eval.py 量到的现象是：合并片段的最大时长
    # **精确等于**上限（15.0s），那就是硬切的指纹。
    #
    # 造一段"每 3 秒有一次短停顿"的连续说话：短停顿（0.3s）不足以触发正常收句
    # （静音判定 700ms），所以只有"到上限"这条路会切它 —— 正好用来测断点选在哪里。
    heading("分段器 · 到上限时在停顿处断，而不是硬切（回归：长对话被截断）")
    pausing = build([("silence", 0.3)] + [("tone", 3.0), ("silence", 0.3)] * 3 + [("silence", 0.5)])
    soft, _ = run_segmenter(pausing, max_speech_ms=4000)
    hard, _ = run_segmenter(pausing, max_speech_ms=4000, cut_pause_ms=99999)
    soft_lengths = [len(x) / TARGET_RATE for x in soft]
    hard_lengths = [len(x) / TARGET_RATE for x in hard]
    check("找到停顿就提前断：第一段明显短于上限（不是 4.0s 硬切）",
          soft_lengths and soft_lengths[0] < 3.7,
          f"各段 {[round(n, 2) for n in soft_lengths]}")
    check("负数对照：关掉找停顿（cut_pause_ms 极大）就退回硬切，第一段正好顶到上限",
          hard_lengths and hard_lengths[0] >= 3.7,
          f"各段 {[round(n, 2) for n in hard_lengths]} —— 负对照没复现出旧行为，"
          f"那上面那条通过也不能说明是找停顿起了作用")
    check("断在停顿处不会丢内容：三段声音的长度基本都交出来了",
          sum(soft_lengths) >= 8.9,
          f"三段合计 9.0s，实际交出 {sum(soft_lengths):.2f}s")

    # ── 7. 强制断句绝不能丢语音（不变量测试）────────────────────────────────
    #
    # 这条是补的，因为上面那个改动**连续踩了两次坑**，两次都表现为"内容无声消失"：
    #   第一次：选"最长的停顿"切，后面剩一小截（< min_speech_ms）→ 后面被 _take 丢掉；
    #   第二次：算"前半段有几个语音块"时 self.energies 已经被切成后半段了，
    #           数出来偏低 → _release 判它太短 → 把**整个前半段**扔掉。
    # 两次都是"看起来还在跑、字幕照出、就是少了几个字"，光看现象根本发现不了。
    # 所以这里不测具体行为，直接测不变量：**送进去多少有声音的音频，就必须交出多少**。
    # 两种信号都要测 —— 它们走的是不同的代码路径：
    #   · 停顿后面还有一大截话 → 在停顿处切（走"两头都够长"的正常分支）
    #   · 停顿后面只剩一小截话 → 找不到"两头都够长"的停顿，走兜底分支
    # 而那两次丢内容的 bug 分别藏在两条路径里，只测一条会漏。
    #
    # 注意兜底分支里那一小截尾巴**本来就该被丢掉**（不到 min_speech_ms 的碎片是防
    # 噪声爆音用的，这是设计如此），所以那条用例不能要求"块数不少"，
    # 只能要求**前半段活着** —— 而丢内容的 bug 丢的恰恰是前半段（几秒钟的话）。
    heading("分段器 · 不变量：强制断句不能丢掉语音")
    block = int(TARGET_RATE * 0.1)

    def loud_blocks(audio):
        usable = len(audio) // block * block
        if not usable:
            return 0
        rms = np.sqrt(np.mean(audio[:usable].reshape(-1, block) ** 2, axis=1))
        return int(np.sum(rms >= 0.05))

    def total_emitted(audio, max_ms, cut_pause_ms):
        emitted, _ = run_segmenter(audio, max_speech_ms=max_ms, cut_pause_ms=cut_pause_ms)
        return sum(loud_blocks(x) for x in emitted), [loud_blocks(x) for x in emitted]

    long_tail = build([("silence", 0.3)] + [("tone", 2.0), ("silence", 0.25)] * 4
                      + [("tone", 0.4), ("silence", 1.2)])
    expected = loud_blocks(long_tail)
    for cut_pause_ms in (200, 99999):
        got, _ = total_emitted(long_tail, 3000, cut_pause_ms)
        check(f"停顿后面还有一大截话 · cut_pause_ms={cut_pause_ms}：交出的语音块数不少于送进去的"
              f"（{got} ≥ {expected}）",
              got >= expected - 1,
              f"送进去 {expected} 块、只交出 {got} 块 —— 少了 {expected - got} 块语音，"
              f"字幕会静默缺内容")

    # 这一段要造得能真的走进兜底分支：停顿后面必须有**一点**话把停顿"关上"
    # （_pause_candidates 只记录被后面的话终止的停顿），但这点话又必须短到
    # 两头都够长的分支不接受它 —— 0.25s（2 块）< min_speech_ms（3 块）刚好满足。
    # 上限取 3600ms，让上限正好在"那点话刚进 buffer"时触发。
    # 第一版把这段造错了（上限卡在停顿结束那一刻），结果兜底分支根本没被走到，
    # 负对照（故意写错一行）照样全绿 —— 测试等于没测。
    short_tail = build([("silence", 0.3), ("tone", 3.0), ("silence", 0.25),
                        ("tone", 0.25), ("silence", 1.5)])
    head_expected = 30        # 前面那 3.0 秒的话
    for cut_pause_ms in (200, 99999):
        _, per_segment = total_emitted(short_tail, 3600, cut_pause_ms)
        biggest = max(per_segment, default=0)
        check(f"停顿后面只剩一小截话 · cut_pause_ms={cut_pause_ms}："
              f"前面那 {head_expected} 块语音必须交出来（实测最大一段 {biggest} 块）",
              biggest >= head_expected,
              f"最大的片段只有 {biggest} 块，而前面那段话有 {head_expected} 块 —— "
              f"前半段被整个丢掉了（曾因为算块数时用错了数组而真的发生）")

    # ── 6. 前导缓存：句首的低能量音频要被带上 ────────────────────────────────
    heading("分段器 · 句首前导缓存")
    fade = np.concatenate([
        np.zeros(int(0.5 * TARGET_RATE), dtype=np.float32),
        (tone(0.3) * np.linspace(0.0, 1.0, int(0.3 * TARGET_RATE))).astype(np.float32),
        tone(0.9),
        np.zeros(int(0.8 * TARGET_RATE), dtype=np.float32),
    ])
    found_fade, _ = run_segmenter(fade)
    check("切出了一段", len(found_fade) == 1, f"实际 {len(found_fade)} 段")
    if found_fade:
        duration = len(found_fade[0]) / TARGET_RATE
        check("长度超过 1.2 秒（说明句首那 0.25 秒淡入被带上了，没被削掉）",
              duration > 1.25, f"实际 {duration:.2f}s")

    # ── 7. 幻听惯用语过滤 ────────────────────────────────────────────────────
    heading("防幻听 · 惯用语过滤")
    check("中文常见幻听句被认出", looks_like_hallucination("请不吝点赞 订阅 转发 打赏支持明镜与点点栏目"))
    check("葡语/英语字幕组署名被认出", looks_like_hallucination("Legendas pela comunidade Amara.org"))
    check("正常句子不会被误杀", not looks_like_hallucination("你好，这是一条测试信息"))
    check("正常葡语句子不会被误杀", not looks_like_hallucination("Bom dia, tudo bem?"))

    # ── 8. 音频读入（wav 路径，不依赖 PyAV）─────────────────────────────────
    # 刻意不用 tempfile：受限沙箱下系统临时区可能不允许写/删（本机就是），
    # 而仓库里的 var/ 确定可写，而且已被 .gitignore 忽略。
    heading("音频读入 · 标准库读 wav")
    scratch = ROOT / "var" / "test" / "python-suite"
    scratch.mkdir(parents=True, exist_ok=True)
    target = scratch / "check.wav"
    samples = tone(0.5)
    pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(str(target), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(TARGET_RATE)
        handle.writeframes(pcm.tobytes())
    loaded = load_audio(target)
    check("长度一致", abs(len(loaded) - len(samples)) <= 1, f"{len(loaded)} vs {len(samples)}")
    check("是 float32", loaded.dtype == np.float32, str(loaded.dtype))
    check("幅值量级正确（没有整体缩放错）",
          0.10 < float(np.sqrt(np.mean(loaded ** 2))) < 0.13,
          f"RMS {float(np.sqrt(np.mean(loaded ** 2))):.4f}")
    check("路径传字符串也能用，不必是 Path 对象",
          len(load_audio(str(target))) == len(loaded))

    # ── 9. 尾随手机上传的音频（录音上传那条路）──────────────────────────────
    #
    # 这一节测的是"手机只当麦克风"那条路的读侧。它没有模型也能测：
    # 我们往一个文件里追加字节，看 PcmFollower 读出来的采样对不对。
    # 三个最容易写错的地方各有一条：追加增量、文件被截断、奇数字节的半帧。
    heading("尾随上传音频 · PcmFollower（手机录音上传）")

    follow_dir = ROOT / "var" / "test" / "python-suite" / "follow"
    follow_dir.mkdir(parents=True, exist_ok=True)
    follow_pcm = follow_dir / "audio-in.pcm"
    follow_rate = follow_dir / "audio-in.rate"
    follow_pcm.write_bytes(b"")
    follow_rate.write_text("16000\n", encoding="utf-8")

    def ramp(count, start=0):
        """可辨认的 16-bit PCM：值随序号变化，错位一眼就能看出来。"""
        values = ((np.arange(count) + start) % 1000 - 500).astype("<i2")
        return values.tobytes()

    def append(data):
        with open(follow_pcm, "ab") as handle:
            handle.write(data)

    block_samples = 1600                      # 100ms @ 16k
    follower = PcmFollower(follow_pcm, TARGET_RATE, np, block_samples,
                           follow_rate_path=follow_rate)

    check("空文件读不出东西（不崩）", follower.read() == [])

    append(ramp(3200))                        # 0.2 秒
    blocks = follower.read()
    check("追加 0.2 秒 → 读出两块 100ms", len(blocks) == 2 and all(b.shape[0] == block_samples for b in blocks),
          f"块数 {len(blocks)}，各块长度 {[b.shape[0] for b in blocks]}")
    expected = (np.arange(3200) % 1000 - 500).astype(np.float32) / 32768.0
    check("采样值与写入的一致（没有错位、没有整体缩放错）",
          blocks and float(np.max(np.abs(np.concatenate(blocks) - expected))) < 1e-6,
          "读回来的波形与写入的不一致")

    check("没有新数据时读出空（不是重复吐旧数据）", follower.read() == [])

    # 半帧：PCM 一帧 2 字节，而文件是边写边读的，读到"半帧"是常态。
    # 如果直接把这 1 个字节当成一帧，之后**所有**采样都会错位（听感是刺啦声、识别必崩）。
    append(ramp(1)[:1])                       # 只写 1 个字节
    check("只有半个采样时不出数据（留在缓冲里等下次）", follower.read() == [])
    append(ramp(2)[1:])                       # 补齐第 1 帧 + 再写 1 帧
    blocks = follower.read()
    total = sum(b.shape[0] for b in blocks)
    check("补齐后正好读出 2 个采样（半帧没有被丢掉、也没有被错位解释）", total == 2,
          f"读出 {total} 个采样")

    # 文件被截断重来（手机重新开始录音时 relay 会清空它）。
    # 不处理的话读指针永远停在旧偏移，表现成"录音上传没反应"。
    follow_pcm.write_bytes(b"")
    append(ramp(1600, start=7))
    blocks = follower.read()
    check("文件被截断后能从 0 重新读（否则会永远卡在旧偏移）",
          sum(b.shape[0] for b in blocks) == block_samples,
          f"读出 {sum(b.shape[0] for b in blocks)} 个采样")

    # 采样率降级：安卓录不到 16k 时会用 44.1k，识别进程必须按旁文件重采样。
    follow_rate.write_text("44100\n", encoding="utf-8")
    rate = follower.read_rate()
    check("读到旁文件里的新采样率", rate == 44100, str(rate))
    check("把变化记下来通知调用方（好在日志里说清楚）", follower.rate_notice == 44100,
          str(follower.rate_notice))
    follow_pcm.write_bytes(b"")
    follower.read()                           # 让指针跟着截断回到 0
    append(ramp(44100))                       # 44.1k 的 1 秒
    blocks = follower.read()
    resampled = sum(b.shape[0] for b in blocks)
    check("44.1k 的 1 秒被重采样成 16k 的 1 秒（约 16000 个采样）",
          abs(resampled - TARGET_RATE) <= block_samples,
          f"重采样后 {resampled} 个采样（期望约 {TARGET_RATE}）")

    # ★ 连续多块：这才是真实节奏（手机每秒上传一块，跟随进程每轮读一块）。
    #
    # 上面那条"一次性写 44100 个采样、只 read 一次"的断言**放过了真 bug**：
    # 老实现里 resample_pos 记的是绝对位置，而每块 samples 都是新数组 ——
    # 第一块正常，之后每块 count 都算成 0、永远返回空。
    # 结果就是"识别器只在最开始拿到约 1 秒音频"，而转发进程的电平/字节数全正常。
    # 眼镜固定 44.1k，必然走这条路径，所以这个 bug 一上眼镜就暴露。
    follow_pcm.write_bytes(b"")
    follower.read()
    follower.resample_pos = 0.0
    block_sizes = []
    for _ in range(5):
        append(ramp(44100))                   # 又一块 1 秒的 44.1k 音频
        blocks = follower.read()
        block_sizes.append(sum(b.shape[0] for b in blocks))
    check("连续 5 块 44.1k 音频，**每一块**都要出约 16000 个采样（不能只有第一块有）",
          all(abs(size - TARGET_RATE) <= block_samples for size in block_sizes),
          f"各块重采样后采样数：{block_sizes}")
    check("多块总量也对（没有累积漂移）",
          abs(sum(block_sizes) - TARGET_RATE * 5) <= block_samples * 5,
          f"总量 {sum(block_sizes)}，期望约 {TARGET_RATE * 5}")

    # 语种标记 → Whisper 码。手机说的是 pt-BR / zh-CN，Whisper 要的是 pt / zh；
    # 认不出来时要返回 None（让 Whisper 自己判），而不是猜一个错的语种。
    heading("语种标记转换 · whisper_language_of")
    check("pt-BR → pt", whisper_language_of("pt-BR") == "pt", str(whisper_language_of("pt-BR")))
    check("zh-CN → zh", whisper_language_of("zh-CN") == "zh", str(whisper_language_of("zh-CN")))
    check("大小写与空白都能忍", whisper_language_of("  PT-br ") == "pt", str(whisper_language_of("  PT-br ")))
    check("认不出来返回 None（交给 Whisper 自动判定，不瞎猜）",
          whisper_language_of("klingon") is None, str(whisper_language_of("klingon")))
    check("None / 空值不炸", whisper_language_of(None) is None and whisper_language_of("") is None)

    # ── 9b. 限定候选语种（护栏）───────────────────────────────────────────────
    #
    # 不指定语种时，Whisper 会在**99 种语言**里挑一个。实测（pt-coraa 20 条真实口语）：
    #   不限定 → 判定 {pt:19, **he**:1}，词错率 13.3%，被认成希伯来语的那条**整句报废**
    #   限定到 zh,pt → 只会是这两种，词错率 12.2%（与"直接强制 pt"一模一样）
    # 这个系统只可能是中文与巴葡，所以"在 99 种里挑"是纯亏的自由度。
    heading("限定候选语种 · --lang-candidates")
    check("缺省就是 zh,pt（护栏默认生效，不靠人记得加）",
          parse_args([]).lang_candidates == ("zh", "pt"), str(parse_args([]).lang_candidates))
    check("显式写也对", parse_args(["--lang-candidates", "zh,pt"]).lang_candidates == ("zh", "pt"))
    check("顺序按写法走、重复会去掉",
          parse_args(["--lang-candidates", "pt,pt,zh"]).lang_candidates == ("pt", "zh"),
          str(parse_args(["--lang-candidates", "pt,pt,zh"]).lang_candidates))
    check("空串 = 关掉限定（回到全域挑最大，即会挑出 he 的旧行为）",
          parse_args(["--lang-candidates", ""]).lang_candidates is None,
          str(parse_args(["--lang-candidates", ""]).lang_candidates))
    # ⚠️ 写错语种码必须**明确报错**，不能静默变成空集 ——
    #    空集会让"限定"悄悄失效，而"护栏悄悄失效"是最难发现的一类问题。
    #
    # 把 argparse 的报错**收进缓冲区**：它是被故意触发的，不该出现在全量验证的输出里 ——
    # 否则每次跑完都会有一行 `error: ...` 挂在 stderr 上，让人以为真出错了
    # （"狼来了"的代价是下次真出错时没人看）。
    bad_codes_rejected = False
    noise = io.StringIO()
    try:
        with contextlib.redirect_stderr(noise):
            parse_args(["--lang-candidates", "zh,tlh"])
    except SystemExit:
        bad_codes_rejected = True
    check("认不出的语种码直接报错（不许静默失效）", bad_codes_rejected,
          "写了 zh,tlh 却没报错")
    check("报错里说清了是哪个码不对（可照做）",
          "tlh" in noise.getvalue(), noise.getvalue()[:80])

    # ── 9b-2. 评测脚本**用同一份语义**（真踩过）──────────────────────────────
    #
    # 实测逮到的 bug：asr_eval.py 把 `--lang-candidates` 的**原始字符串**直接拿去用 ——
    #   · provenance 里 `list("zh,pt")` 记成 ['z','h',',','p','t']（配置记错了）；
    #   · 挑语种时 `code in "zh,pt"` 是**子串**匹配，不是"在候选集里"。
    # 这些数字能不能代表产线，全押在"评测口径 = 产线口径"上，所以两处必须同一个解析函数。
    heading("评测脚本的候选语种 · 与产线同一份语义")
    eval_args = asr_eval.parse_args(["--set", "x"])
    check("缺省解析成元组（不是原始字符串）",
          eval_args.lang_candidates == ("zh", "pt") and isinstance(eval_args.lang_candidates, tuple),
          f"{eval_args.lang_candidates!r}")
    check("provenance 记下来的是 ['zh','pt'] 而不是被逐字拆开",
          list(asr_eval.parse_args(["--set", "x"]).lang_candidates) == ["zh", "pt"],
          str(list(eval_args.lang_candidates)))
    check("空串 = 关掉限定（与产线一致）",
          asr_eval.parse_args(["--set", "x", "--lang-candidates", ""]).lang_candidates is None)
    eval_bad = False
    eval_noise = io.StringIO()
    try:
        with contextlib.redirect_stderr(eval_noise):
            asr_eval.parse_args(["--set", "x", "--lang-candidates", "zh,xx"])
    except SystemExit:
        eval_bad = True
    check("评测脚本同样对错码明确报错", eval_bad, "写了 zh,xx 却没报错")
    check("两边解析结果逐项一致（防止以后再漂）",
          [parse_args(["--lang-candidates", raw]).lang_candidates for raw in ("zh,pt", "pt", "")]
          == [asr_eval.parse_args(["--set", "x", "--lang-candidates", raw]).lang_candidates
              for raw in ("zh,pt", "pt", "")])

    # 挑选逻辑本身：喂假概率表，不需要模型。
    # 这正是"抽成纯函数"的目的 —— 判错了整句都错，所以必须能被逐条钉住。
    tricky = [("he", 0.64), ("pt", 0.30), ("zh", 0.02)]
    check("全局最大是 he 时，限定到 zh,pt 要取 pt（实测那条整句报废就是 he）",
          pick_language(tricky, ("zh", "pt")) == "pt", str(pick_language(tricky, ("zh", "pt"))))
    check("不限定时仍然取全局最大（保留旧行为，便于对照）",
          pick_language(tricky, None) is None, "None = 不判，由调用方交给 Whisper 自动")
    clear = [("pt", 0.91), ("zh", 0.05)]
    check("本来就是对的时候结果不变", pick_language(clear, ("zh", "pt")) == "pt",
          str(pick_language(clear, ("zh", "pt"))))
    check("中文占优时取 zh（双向都要能用）",
          pick_language([("zh", 0.88), ("pt", 0.06)], ("zh", "pt")) == "zh")
    check("候选里一个都没有 → 返回 None（不硬选一个）",
          pick_language([("en", 0.5), ("fr", 0.4)], ("zh", "pt")) is None)

    # ── 9c. 测试包切分：dev 与保留集**必须**不相交 ────────────────────────────
    #
    # 这是老师那份测试建议里最容易被忽略、也最致命的一条：
    # 切分一旦泄漏，**后面所有"保留集上的成绩"都是假的** ——
    # 它不会报错、不会崩，只会让数字好看一点。
    heading("测试包切分 · dev 与保留集不相交")
    # 造一批"组"：每组 1~3 条，模拟 CORAA 同一个受访者录了多段的情况。
    groups = [[{"i": n} for n in range(start, start + size)]
              for start, size in ((0, 3), (3, 1), (4, 2), (6, 1), (7, 3), (10, 1), (11, 2), (13, 1))]
    requested = 5
    dev = select_from_pool(groups, 0, requested)
    check("按组整取会略超出请求条数（所以偏移不能用请求值算）",
          len(dev) > requested, f"请求 {requested} 条，实际 {len(dev)} 条")
    holdout = select_from_pool(groups, len(dev), 6)
    dev_ids = {item["i"] for item in dev}
    hold_ids = {item["i"] for item in holdout}
    check("dev 与保留集没有重复样本",
          dev_ids & hold_ids == set(), f"dev={sorted(dev_ids)} holdout={sorted(hold_ids)}")
    # 边界守卫：偏移略有偏差时**也不会**重叠。
    # ⚠️ 这一条是我原本判错的证据：我一度以为"偏移用请求条数"会造成泄漏，
    #    实际写反面对照才发现——`seen < offset` 那道守卫会把跨边界的组整组跳过，
    #    所以怎么算偏移都不重叠（代价是那一组只落在 dev 里，不会两边都有）。
    #    把这条性质钉下来，比留一个我猜想的"bug 复现"要有用。
    skew_ids = {item["i"] for item in select_from_pool(groups, requested, 6)}
    check("偏移用请求条数（偏小）时也不重叠 —— 边界守卫在起作用",
          dev_ids & skew_ids == set(), f"重叠 {sorted(dev_ids & skew_ids)}")
    check("两包合起来不丢样本（顺序切，不跳）",
          dev_ids | hold_ids == set(range(len(dev_ids) + len(hold_ids))),
          f"{sorted(dev_ids | hold_ids)}")
    check("同一个组不会被拆到两包",
          all(len({item["i"] for item in group} & dev_ids) in (0, len(group)) for group in groups),
          "组内样本必须整组落在同一侧")
    again = select_from_pool(groups, 0, requested)
    check("同一输入 → 同一结果（可复现）",
          [item["i"] for item in again] == [item["i"] for item in dev],
          f"{[item['i'] for item in again]}")

    # ── 9d. 每场名额：为什么必须**向上取整** ────────────────────────────────
    #
    # 这一条是切 zh-speech 时实测出来的坑：第一版按说话人分组取前 N 条，
    # 300 条只覆盖了 **2 个说话人**（按组整取 = 取字典序最靠前的两组）。
    # 改成"按录音分组 + 每场给名额"之后才铺开。名额的算术很小，
    # 但它直接决定"这一包覆盖了几个说话人"，所以单独钉住。
    heading("测试包切分 · 每场名额（覆盖度）")
    check("名额向上取整：19 场取 300 条 → 16 条/场（15 会装不下）",
          per_session_quota(300, 19) == 16, str(per_session_quota(300, 19)))
    check("向上取整后 名额×场数 ≥ 请求条数（不然总有场次被挤掉）",
          per_session_quota(300, 19) * 19 >= 300 and per_session_quota(500, 43) * 43 >= 500)
    check("至少 1 条/场（请求条数比场数还少时也不能有 0）",
          per_session_quota(5, 43) == 1, str(per_session_quota(5, 43)))
    check("没给 spread 就不限名额（老语料的行为不变）",
          per_session_quota(None, 19) is None and per_session_quota(300, 0) is None)

    # ── 9e. 占位说话人不能污染身份统计 ─────────────────────────────────────
    #
    # MagicData 里 `G00000000` 出现在**全部** 62 场录音的转写里（实测），它是标记不是身份。
    # ⚠️ 这里要说准它**现在**的影响（我第一版说错了，是实测纠正的）：
    #    它那些句子全都过不了合格门槛 —— dev 6627 条、test 13198 条合格片段里它占 **0 条**。
    #    所以"排除它会清空池子"是**错的**，当前切分下这个特判是空操作。
    #    它防的是门槛放低之后：那时它会让 dev/test **天天报说话人重叠**（假警报），
    #    并且"精确地"把短回执整类从保留集里删掉。所以留下它，但把话说准。
    heading("测试包切分 · 占位说话人（G00000000）")
    check("占位说话人被登记为特例", "G00000000" in PLACEHOLDER_SPEAKERS, str(PLACEHOLDER_SPEAKERS))
    check("说话人统计剔掉占位标记（不然每个包都虚报一位）",
          real_speakers([{"speaker": "G00000000"}, {"speaker": "spk-1"}, {"speaker": "spk-1"},
                         {"speaker": None}, {}]) == {"spk-1"})
    check("全是占位标记 → 真实说话人为空（如实报 0，不硬凑一个）",
          real_speakers([{"speaker": "G00000000"}]) == set())

    fake = []
    for session, count in (("rec-a", 40), ("rec-b", 40), ("rec-c", 40)):
        for index in range(count):
            fake.append({
                "original_id": f"{session}#{index}", "dataset": "fake", "dataset_version": "t",
                "split": "dev", "reference": f"{session} 第 {index} 句",
                "reference_char_spaced": None, "session": session,
                "speaker": "G00000000" if index % 3 == 0 else f"spk-{session}-{index % 2}",
                "tags": {"register": "spontaneous"}, "audio_bytes": b"",
            })
    original_load = asr_pack.load_source
    try:
        asr_pack.load_source = lambda *a, **k: list(fake)
        spread_pool = pool_for("magicdata", "dev", "zh-speech", group_by="session", spread=60)
        sizes = [len(group) for group in spread_pool["groups"]]
        check("按场分组 + 名额：三场都有份（不是只取前一场）",
              len(spread_pool["groups"]) == 3, str(sizes))
        check("每场不超过名额（60 条请求 / 3 场 → 20 条/场）",
              max(sizes) <= 20 and spread_pool["per_group"] == 20, f"{sizes} {spread_pool['per_group']}")
        check("池子够得着请求条数（向上取整的意义）",
              spread_pool["available"] >= 60, str(spread_pool["available"]))

        # 排除到底怎么起作用 —— 这里钉住的是**实测行为**，不是我的猜想：
        #   在"按场分组 + 每场有名额"的语料上，排除是**换掉片段**（被排掉的位置由
        #   本场剩下的片段补上），而不是把池子变小。所以该查的是"被排除的人还在不在"，
        #   不是"池子小了多少"。（我第一版就是这么写错的，测试直接把它顶回来了。）
        def speakers_in(pool):
            return {row["speaker"] for group in pool["groups"] for row in group}

        without_placeholder = pool_for("magicdata", "dev", "zh-speech", group_by="session",
                                       spread=60, exclude_speakers={"G00000000"})
        check("排除占位标记：池子里确实不再有它",
              "G00000000" not in speakers_in(without_placeholder)
              and "G00000000" in speakers_in(spread_pool))
        check("而且名额由本场剩下的片段补满（池子不会因此变小）",
              without_placeholder["available"] == spread_pool["available"],
              f"{without_placeholder['available']} vs {spread_pool['available']}")
        without_real = pool_for("magicdata", "dev", "zh-speech", group_by="session", spread=60,
                                exclude_speakers={"spk-rec-a-0"})
        check("排除真实说话人：同样只换片段，不影响其他场次",
              "spk-rec-a-0" not in speakers_in(without_real)
              and without_real["available"] == spread_pool["available"]
              and len(without_real["groups"]) == 3)
    finally:
        asr_pack.load_source = original_load

    # ── 10. 输出编码（真实事故：识别结果变乱码，一句字幕都出不来）─────────────
    #
    # Windows 中文环境下，Python 往**管道**写东西时用本地编码（GBK/cp936），
    # 而下游的桥（node）按 UTF-8 读 —— 于是识别出来的「你好」变成 3 个替换符 `���`，
    # 写进收件箱后插件"判不出源语种"，**一句字幕都出不来**。
    # 而每一环看起来都是好的：音频有声音、识别有输出、收件箱有行数。
    #
    # 所以这里真的起一个子进程、**故意不带 UTF-8 环境变量**，把中文输出抓回来验字节。
    # 这是唯一能真正证明"脚本自己扛住了编码"的测法 —— 只查源码里有没有那行调用是假验证。
    heading("输出编码 · 不带 UTF-8 环境变量时中文仍要正确")

    # 关键：这里**只 import，不调用任何东西**。修法是在模块导入时就生效，
    # 所以这条测的正是"生产路径真的扛住了"，而不是"有个函数能用"。
    # （早先的写法显式调了一次 force_utf8_stdio()，结果把 main() 里的调用注释掉测试照样全绿 ——
    #   那等于什么都没测。）
    script = (
        "import sys; sys.path.insert(0, r'%s');\n"
        "import whisper_stream;\n"
        "print('你好，这是一条测试信息');\n"
        "print('Olá, tudo bem?');\n"
    ) % str(ROOT / "bridge")

    clean_env = {k: v for k, v in os.environ.items()
                 if k not in ("PYTHONUTF8", "PYTHONIOENCODING", "PYTHONLEGACYWINDOWSSTDIO")}
    try:
        proc = subprocess.run(
            [sys.executable, "-c", script],
            capture_output=True, env=clean_env, timeout=60,
        )
        raw = proc.stdout
        check("子进程正常退出", proc.returncode == 0,
              proc.stderr.decode("utf-8", "replace")[-300:])

        # ⚠️ 注意别用"输出里有没有 U+FFFD 的字节"来判：GBK 的输出里也不含那三个字节
        # （替换符是**解码时**才产生的）。所以这里直接做严格 UTF-8 解码 ——
        # GBK 的中文（如「你好」= C4 E3 BA C3）在 UTF-8 下必然解不出来。
        try:
            decoded = raw.decode("utf-8")
            decode_error = None
        except UnicodeDecodeError as error:
            decoded = raw.decode("utf-8", "replace")
            decode_error = error
        check("输出是合法 UTF-8（是 GBK 的话这里就会失败）", decode_error is None,
              f"{decode_error}；原始字节 {raw[:40]!r}")
        check("按 UTF-8 能解出正确的中文", "你好，这是一条测试信息" in decoded, repr(decoded[:120]))
        check("葡语重音也没坏", "Olá, tudo bem?" in decoded, repr(decoded[:120]))
        # 「你好」的 GBK 字节是 C4 E3 BA C3；如果输出里出现它，说明走的还是本地编码。
        # （这条比"看有没有 U+FFFD"可靠：替换符是解码时才产生的，原始字节里没有。）
        check("输出里没有 GBK 编码的「你好」字节",
              "你好".encode("gbk") not in raw,
              "输出仍然是 GBK —— 桥按 UTF-8 读就会变成乱码")
    except FileNotFoundError:
        check("能起 python 子进程（本机应能）", False, "找不到 python")
    except subprocess.TimeoutExpired:
        check("子进程不超时", False, "60 秒没结束")

    # ── 11. 准确率相关的几个改动（都是"拿真实录音测出来"才加的）──────────────
    # 背景：用户反馈"语音转文字的偏差很大"。用他自己那段录音做对照实验后发现，
    # 主要问题不是模型大小（small/medium/large-v3 结果几乎一样），而是：
    #   · 切得太碎 —— 0.03~0.27 秒的碎片送进识别只会产出胡话（「你以後」这种）；
    #   · 电平没归一化 —— 手机远距离录音峰值只有 0.2 左右，Whisper 明显掉准确率；
    #   · 缺提示词 —— 中文上容易输出繁体、也更容易胡猜；
    #   · beam=1 —— 贪心解码比束搜索差一截，而 GPU 上束搜索很便宜。
    heading("准确率 · 归一化 / 提示词 / 默认值")
    args = parse_args([])

    # 归一化只在**电平确实低**时才做。原来是无条件做，但中文基准（30 条）测出来
    # 一律归一化反而略差（6.7% → 7.4%，medium 无提示词），因为公开语料本来就录得正常。
    # 所以改成"只在需要时动手"：峰值低于 0.3 才抬。
    quiet = tone(0.5, amplitude=0.2)          # 峰值 0.2（手机远距离录音那种）
    loud = tone(0.5, amplitude=0.8)           # 峰值 0.8（公开语料那种，本来就录得好）
    check("电平低（峰值 0.2）时归一化到 0.9",
          abs(float(np.max(np.abs(normalize_peak(quiet)))) - 0.9) < 1e-5,
          str(float(np.max(np.abs(normalize_peak(quiet))))))
    check("电平已经正常（峰值 0.8）时**不动它**",
          abs(float(np.max(np.abs(normalize_peak(loud)))) - 0.8) < 1e-6,
          str(float(np.max(np.abs(normalize_peak(loud))))))
    check("归一化不改变静音的静音性（全 0 不炸、也不会变出声音）",
          float(np.max(np.abs(normalize_peak(np.zeros(1600, dtype=np.float32))))) == 0.0)
    check("归一化不改变波形形状（只是整体缩放）",
          bool(np.allclose(normalize_peak(quiet) / 0.9, quiet / 0.2, atol=1e-5)))

    # 提示词：一波三折，最后**中文那句被实测否掉了** —— 这段历史必须留在测试里，
    # 否则下次有人看到"以前开着"又会顺手打开。
    #   ① 起初开：想压繁体。② 因为被回显成假字幕而关，加了回显闸之后又开。
    #   ③ 现在关：在**真实口语**包 zh-speech-dev（304 条、跨多场录音）上只改这一个变量——
    #      不发 15.55%/14.51%（删除 352、繁体 45 字）；发 18.24%/17.96%（删除 489、繁体 1 字）。
    #      多错 2.7~3.5 个点换 0.8 个点的繁体，净亏。
    check("中文**缺省不发**那句提示词（口语包实测：发了要多错 2.7~3.5 个百分点）",
          prompt_for("zh", None) is None, str(prompt_for("zh", None)))
    check("那句提示词仍然留在目录里（要显式发、或别的实验要模拟它时还用得上）",
          "简体" in LANGUAGE_PROMPTS["zh"] and "普通话" in LANGUAGE_PROMPTS["zh"])
    check("葡语那句缺省仍然发（⚠️ 它还没量过，所以不跟着一起关）",
          "Brasil" in (prompt_for("pt", None) or ""), str(prompt_for("pt", None)))
    check("认不出语种就不发提示词（别硬塞一个错的）",
          prompt_for("xx", None) is None, str(prompt_for("xx", None)))
    check("显式给的提示词优先（想临时开回来就 --initial-prompt）",
          prompt_for("zh", "自定义") == "自定义")
    check("--no-prompt 能关掉任何缺省提示词",
          args.no_prompt is False and parse_args(["--no-prompt"]).no_prompt is True)

    # 回显过滤：这条闸必须真的拦得住 —— 按实测复现出来的真实样本
    PROMPT = LANGUAGE_PROMPTS["zh"]
    check("整句回显被认出（复现出来的真实输出）",
          looks_like_prompt_echo("请用简体中文输出。", PROMPT), "「请用简体中文输出。」没被认出")
    check("重复两次的回显也被认出",
          looks_like_prompt_echo("请用简体中文输出。 请用简体中文输出。", PROMPT))
    check("带前缀的回显也被认出（短提示词那版复现出来的）",
          looks_like_prompt_echo("您好 简体中文。", "简体中文。"))
    check("正常字幕不会被误判成回显",
          not looks_like_prompt_echo("你好，简单介绍一下你自己。", PROMPT))
    check("正常字幕在**没发提示词**时也不会被误判",
          not looks_like_prompt_echo("你好", None))
    check("空文本不炸", not looks_like_prompt_echo("", PROMPT) and not looks_like_prompt_echo("你好", ""))

    # 回显过滤的**长度下限**是先加护栏、后收紧的：提示词「以下是普通话的句子，请用简体中文输出。」
    # 里全是常用字，所以只看"是不是子串"的话，「中文」「输出」「句子」「的话」这些
    # 两三个字的**正常短句**也会被静默吃掉 —— 用户真说了这些词，字幕就没了，
    # 而且日志里看不出原因。所以现在要求至少 4 个字、且占到提示词的 40%。
    heading("回显过滤 · 不能吃掉正常短句（收紧后的护栏）")
    for short_utterance in ("中文", "输出", "句子", "的话", "以下", "请用"):
        check(f"「{short_utterance}」是常用词，不该被判成回显",
              not looks_like_prompt_echo(short_utterance, PROMPT),
              "被吃掉了 —— 用户真说这两个字就永远看不到字幕")
    check("真实回显仍然拦得住：整条提示词",
          looks_like_prompt_echo(PROMPT, PROMPT))
    check("真实回显仍然拦得住：实测那次丢弃的原文",
          looks_like_prompt_echo("请用简体中文输出。", PROMPT),
          "这个漏了就等于闸门形同虚设")

    # 第 4 条判据：**半截提示词混在正常字幕里** —— 这条是补的，来源是一次真实测量。
    # 产线解码条件（vad 关 + 提示词开）下跑 20 段连续录音，C1 的错误率 21.9%（关掉提示词是
    # 16.8%），而样本输出里能直接看到漏进来的提示词尾巴：
    #   `人们活了很长时间,只记住这四千年。请用简体中文输出。二百五十年…`
    # 整段既不是提示词的子串、也不是它的"一部分"，原来三条判据**全部放行** → 假字幕照发。
    heading("回显过滤 · 半截提示词混在正常字幕里（实测漏网样本）")
    leak = "人们活了很长时间,只记住这四千年。请用简体中文输出。二百五十年他在干什么"
    check("实测漏掉的那句现在拦得住", looks_like_prompt_echo(leak, PROMPT),
          "半截提示词会被当成正常字幕显示出去")
    check("单独一句半截提示词也拦得住", looks_like_prompt_echo("请用简体中文输出", PROMPT))
    check("但 2~3 字的常用词仍然一律放行（这条不能松）",
          all(not looks_like_prompt_echo(word, PROMPT) for word in ("中文", "输出", "句子", "的话")))
    check("正常长句仍然放行（新判据只认「整句就是提示词里的一段」）",
          not looks_like_prompt_echo("我觉得这个方案不行，明天再讨论一下。", PROMPT))

    # ── 上下文续传（把前 N 段的定稿文本喂回去当提示词）──────────────────────
    #
    # 实测（同一段口语录音的 20 个连续段、同一个参考）：逐段独立 16.8% → 前两段续传 15.1%，
    # 而且**零额外等待**（不多听一秒音频）。它比"声学重叠"便宜也有效（后者要拼窗口、
    # 右邻还要多等一段）。但提示词变长会带来"模型复读上文"这个新失败方式，
    # 所以这一节同时钉住三条边界：换语种清空、隔太久清空、只记定稿文本。
    heading("上下文续传 · 取哪几段、什么时候清空")
    carry = ContextCarry(2, max_gap_seconds=60.0)
    check("一开始没有上文（第一段不该凭空带上一句）", carry.prompt("zh", 0.0) == "")
    carry.push("第一句话。", "zh", 0.0)
    carry.push("第二句话。", "zh", 1.0)
    check("取到最近两段、按原顺序",
          carry.prompt("zh", 2.0) == "第一句话。第二句话。", carry.prompt("zh", 2.0))
    carry.push("第三句话。", "zh", 3.0)
    check("只保留最近 N 段（第三句进来，第一句就该掉出去）",
          carry.prompt("zh", 4.0) == "第二句话。第三句话。", carry.prompt("zh", 4.0))
    check("空文本不入库（否则上文的空档会把窗口挤掉）",
          (carry.push("", "zh", 5.0), carry.prompt("zh", 5.0))[1] == "第二句话。第三句话。")
    check("换语种立刻清空（中文上文喂给葡语解码 = 逼模型继续写中文）",
          carry.prompt("pt", 6.0) == "" and carry.resets["language"] == 1,
          f"prompt={carry.prompt('pt', 6.0)!r} resets={carry.resets}")
    carry.push("Agora em português.", "pt", 7.0)
    check("清空之后能重新攒（不是被永久关掉）",
          carry.prompt("pt", 8.0) == "Agora em português.")
    check("隔太久清空（缺省 60 秒：几分钟前的上一句不属于同一段上文）",
          carry.prompt("pt", 8.0 + 61) == "" and carry.resets["gap"] == 1, str(carry.resets))
    check("depth=0 时整个功能关掉（不记也不带）",
          (lambda c: (c.push("x", "zh", 0.0), c.prompt("zh", 1.0))[1])(ContextCarry(0)) == "")

    heading("上下文续传 · 复读上文的闸（宁可漏拦，也不能吃掉正常字幕）")
    context = "我们今天讨论三个问题。第一个是预算。"
    check("整段几乎全是上文时判为复读",
          looks_like_context_echo("我们今天讨论三个问题。第一个是预算。", context),
          "模型把上一句整句又说了一遍，字幕会重复")
    check("**接着往下说**不算复读（这是这条闸最重要的性质）",
          not looks_like_context_echo("第一个是预算，第二个是排期。", context),
          "重复了上文的一句、后面还有新内容 —— 后半句的新内容不能跟着一起丢")
    check("正常的新句子不会被误判",
          not looks_like_context_echo("第二个是排期，下周一之前定下来。", context))
    check("只是**用词重合**不算复读（用户真的重复说一句时不能吃掉字幕）",
          not looks_like_context_echo("我觉得这个方案不行，我们先看预算。", context))
    check("没有上文时永远不判（别把第一句吃掉）",
          not looks_like_context_echo("第一个是预算", ""))
    check("短句不判（宁可放过，也不冒吃字幕的险）",
          not looks_like_context_echo("预算", context))

    # ⚠️ 两道"抄"的闸必须**分开用**：指令用严判据、上文用松判据。
    #    实测踩到过：把"指令 + 上文"拼成一个 initial_prompt 一起过严判据之后，
    #    800ms 那一轮实验回显计数器报了 1 次，而那一整段输出里**没有任何重复片段** ——
    #    它报的只是"用户自己重复用了几个字/一句话"。在产线上那就是真字幕被吃掉。
    heading("两道闸分开用：指令严判、上文松判")
    carried = "这个盒子里边放的东西很重要。"
    continued = "这个盒子里边放的东西很重要，只有第二级才真的严重。"
    check("严判据**确实会**把「含有上文」当成回显（所以它不能用来判上文）",
          looks_like_prompt_echo(continued, carried),
          "这条断言是在记录「为什么必须分开」：严判据对上文必然误杀")
    check("松判据放行「重复上文 + 新内容」（真字幕不能被吃掉）",
          not looks_like_context_echo(continued, carried))
    check("transcribe 的签名把两段分开收（hint_text / context_text）",
          {"hint_text", "context_text"} <= set(inspect.signature(transcribe).parameters),
          str(list(inspect.signature(transcribe).parameters)))
    check("handle 传的是 hint_text=hint / context_text=carried（不是拼在一起）",
          "hint_text=hint, context_text=carried or None"
          in (ROOT / "bridge" / "whisper_stream.py").read_text(encoding="utf-8"))

    # ── 归因工具（`asr-eval/carry_attribution.py`）：拆"上下文帮在哪、伤在哪"──────
    #
    # 这个工具的价值全在"口径对不对"，所以把两处最容易错的地方钉住：
    #   ① 按句内位置归属时，「=」也必须推进参考位置（第一版漏了它，
    #      算出"第 1 句 83% 错误率"这种显然不可能的假数）；
    #   ② "抄上文"的比例必须真的按"更早出现的参考词"算，而不是全段词表。
    import carry_attribution as attrib

    heading("归因工具 · 上下文帮在哪 / 伤在哪")
    reference = "são paulo capital são"
    hypothesis = "são paulo capital são"
    bounds = [(0, 3), (3, 6)]
    first, later, units_first, units_later = attrib.split_errors(
        reference, hypothesis, bounds, "word")
    check("全对时 S/D/I 都是 0（先确认它不会凭空造错）",
          sum(first.values()) + sum(later.values()) == 0, str((first, later)))
    check("每句的单位数按参考算（上面的例子是 3 + 3）",
          (units_first, units_later) == (3, 3), f"{units_first}/{units_later}")
    # 「=」漏推进的后果：所有错误都会被算进第 1 句 —— 这条就是当时的回归点
    first, later, _units_first, _units_later = attrib.split_errors(
        "一二三四五六七八", "一二X四五六Y八", [(0, 4), (4, 8)], "char")
    check("错误按句内位置分得开（第 2 句的错不会被算进第 1 句）",
          first["S"] == 1 and later["S"] == 1, f"first={first} later={later}")
    hits, total = attrib.bleeding("viajei pelo país viajei", "viajei pelo país viajei", "word")
    check("全对时没有替换/插入可统计（分母为 0，不能除出个假比例）",
          (hits, total) == (0, 0), f"{hits}/{total}")
    hits, total = attrib.bleeding("viajei pelo país", "viajei pelo viajei", "word")
    check("抄上文的替换被数出来（'país'→'viajei'，而 viajei 前面出现过）",
          hits == 1 and total == 1, f"{hits}/{total}")
    counts, _examples = attrib.classify_new_substitutions(
        "viajei pelo país", "viajei pelo cidade", "viajei pelo viajei", "word")
    check("新出现的替换若来自本段早前 → 记成「抄上文」",
          counts["bleed"] == 1, str(counts))
    counts, _examples = attrib.classify_new_substitutions("eh bom", "eh bom", "é bom", "word")
    check("口语→书面（eh→é）单独算一档，不混进「真听错」",
          counts["spoken"] == 1, str(counts))

    # 统计口径：延迟必须把"一段本身有多长"算进去 —— 这条口径错过很久，
    # 报告里把 1200ms 那档说成"只多等 2.3 秒"，实际是 6.2 秒（一句话要先攒成一整段）。
    heading("统计口径 · 字幕延迟不能漏掉段长")
    stats = Stats()
    for _ in range(10):
        stats.add(4.0, 0.6, False)
    report = io.StringIO()
    with contextlib.redirect_stderr(report):
        stats.report(1200, gate="测试门槛")
    text = report.getvalue()
    check("报告里有平均段长", "平均段长" in text and "4.00s" in text, text[-300:])
    check("延迟 = 段内位置 + 静音判定 + 识别（三项都在）",
          "段内平均位置 2.00s" in text and "静音判定 1.20s" in text and "识别 0.60s" in text,
          text[-300:])
    check("同时给最坏情况（段长 + 静音 + 识别）", "最坏 5.80s" in text, text[-300:])
    check("标明是**估算**，不是实测", "估算" in text)
    stats.carry = ContextCarry(2)
    report = io.StringIO()
    with contextlib.redirect_stderr(report):
        stats.report(1200)
    check("报告里能看出续传有没有在工作（清空次数 + 复读拦了几段）",
          "上下文续传" in report.getvalue() and "照抄上文被丢弃" in report.getvalue(),
          report.getvalue()[-300:])

    # 幻听闸：那条「谢谢观看,下次见!」是实测混过去的假字幕（按真实上传节奏重放时出来的），
    # 它当时直接当字幕发到了眼镜上 —— 假字幕比没有字幕糟得多。
    heading("幻听惯用语 · 实测逮到的那条")
    check("「谢谢观看,下次见!」被拦下（曾混过去发到眼镜上）",
          looks_like_hallucination("谢谢观看,下次见!"), "漏了就会在眼镜上出现假字幕")
    check("「请不吝点赞订阅」仍然被拦下", looks_like_hallucination("请不吝点赞、订阅、转发"))
    check("正常中文句不会被幻听闸误伤",
          not looks_like_hallucination("这是一条测试音频。"), "把正常话拦掉就白干了")
    check("葡语幻听（legendas 之类）仍然被拦下", looks_like_hallucination("Legendas pela comunidade"))
    check("正常葡语句不会被幻听闸误伤",
          not looks_like_hallucination("Olá, por favor, diga seu nome."))

    # ── 上传节奏不能被当成"说话人停了"（真实故障的回归测试）──────────────────
    #
    # 故障经过：手机按 1 秒一块上传，块与块之间本来就有近 1 秒没数据。
    # 而原来的判据是"连续 5 次轮询没读到数据"，每次轮询睡 80ms → 只有 400ms，
    # 于是正常上传时它反复判定"说话人停了"，往切句器里塞 500ms 数字零，把句子切开。
    # 实测：同一段音频数据一次性到位 → [2.9, 4.9] 两段；按真实节奏喂 → 五段，
    # 其中一段 1.0 秒的电平与 relay 日志里某一块**完全一致**（就是被按块切开的一块）。
    # 切出来的短碎片正是 Whisper 爱出幻觉的长度 —— 用户看到的「丢弃…回显了提示词」
    # 就是这么来的：丢字幕只是症状，按上传节奏切句才是病。
    heading("尾随判据 · 上传间隔不能被当成句子结束（回归）")
    cadence = IdleTracker(2000, 80)          # 缺省：2 秒才认"停了"
    fired_during_upload = False
    for _ in range(12):                      # 1 秒的上传间隔 = 12 次空轮询
        if cadence.saw_nothing():
            fired_during_upload = True
    check("每秒一块的上传节奏下，绝不触发（12 次空轮询 = 960ms）",
          not fired_during_upload,
          "触发了 —— 说话人还在说，句子会被按上传节奏切开")
    long_idle = IdleTracker(2000, 80)
    reached_at = None
    for index in range(1, 40):
        if long_idle.saw_nothing():
            reached_at = index
            break
    check("空转约 2 秒才真的认（实测在第 25 次轮询）", reached_at == 25,
          f"第 {reached_at} 次就认了，阈值不对")
    recovered = IdleTracker(2000, 80)
    for _ in range(20):
        recovered.saw_nothing()
    recovered.saw_data()
    check("一旦读到新数据，计数归零（不来一次误判就永久卡住）",
          not recovered.saw_nothing() and recovered.idle_ms == 80,
          f"idle_ms={recovered.idle_ms}")

    # 负对照：把阈值调回旧行为（400ms），同一段上传节奏必须触发 ——
    # 证明上面那条"不触发"确实是阈值改对了，而不是测试没测到东西。
    old = IdleTracker(400, 80)
    fired_old = any(old.saw_nothing() for _ in range(12))
    check("负对照：阈值 400ms（旧行为）在同一节奏下会触发",
          fired_old, "负对照没复现出旧行为，上面那条通过也不能说明问题")

    check("缺省用束搜索 beam=5（基准实测：7.4% vs beam1 的 9.2%）",
          args.beam_size == 5, str(args.beam_size))
    check("缺省做峰值归一化", args.no_normalize is False, str(args.no_normalize))
    check("缺省丢弃 <500ms 的碎片（碎片只会变成胡话）",
          args.min_speech_ms == 500, str(args.min_speech_ms))
    check("缺省开启短句保护，但阈值克制（不把相邻两句合起来）",
          args.short_utterance_ms == 800 and args.short_silence_ms == 1100,
          f"{args.short_utterance_ms}/{args.short_silence_ms}")
    # 静音判定的缺省值是**量出来改过两次**的，两次都记在这里，免得下次又有人凭直觉改回去：
    #   ① 起初 700 → 500：在"朗读语料 + 合成停顿"上，判 1000ms 会把句子并成 12~14 秒的长段，
    #      错误率 23.9%；判 500ms 是 10.0%。
    #   ② 500 → 800（现在）：在**真实口语**（31 分钟原始录音取 20 个连续段、同一个参考、
    #      同一套切句器）上做受控对照：500 → 16.8%、800 → 15.5%、1200 → 13.3%、2000 → 12.2%。
    #      机制：段太碎时 min_speech_ms 会丢碎片（500ms 档只覆盖 79.1% 的音频，800 档 82.8%）。
    #      ⚠️ **没取最准的 1200，是产品取舍**：字幕延迟（含"段内等待"）500 档 2.7 秒、
    #      800 档 3.8 秒、1200 档 6.2 秒 —— 800 是拿一半延迟换一半准确率的折中档。
    check("缺省静音判定 800ms（口语受控实测：500 是 16.8%，800 是 15.5%，1200 是 13.3%）",
          args.silence_ms == 800, str(args.silence_ms))
    check("静音判定放宽了，句子上限也要跟着放宽（否则长段会被硬切）",
          args.max_speech_ms == 30000, str(args.max_speech_ms))
    check("缺省会在上限处优先找停顿断句（不是硬切）",
          args.cut_pause_ms == 200, str(args.cut_pause_ms))
    # 上下文续传：**缺省两个语种都关**（不是没测，是测了之后决定默认不开）。
    #   ① 中文单场录音：500/800/1200 三档都是 −1.3~−1.8p（最初打开它的依据）
    #   ② 中文跨 19 场录音：+3.48p（中位 0，8 好 / 7 差 / 4 平，均值被两段灾难性失败拉爆：
    #      一段整段变幻听惯用语、一段整段飘成繁体）→ 期望值为负
    #   ③ 葡语：**没有连续录音可测** → 未验证，不默认开
    # 结论：默认关、保留开关。别再拿"单场录音 −1.5p"当依据 —— 那正是被 ② 推翻的结论。
    check("--context-depth 缺省不写死，按语种取（None）",
          args.context_depth is None, str(args.context_depth))
    check("中文缺省**关**（跨 19 场录音实测 +3.48p，单场 −1.5p 的结论已被推翻）",
          context_depth_for("zh") == 0, str(context_depth_for("zh")))
    check("葡语缺省也关（真实对话实测噪声到略负）",
          context_depth_for("pt") == 0, str(context_depth_for("pt")))
    check("语种不明时不默认开（没量过的组合不要默认打开）",
          context_depth_for(None) == 0 and context_depth_for("xx") == 0)
    check("续传的时间窗是 60 秒（必须长于一段本身，否则连续说话也会被误清）",
          args.context_gap_s == 60.0, str(args.context_gap_s))
    check("--context-depth 0 能显式关掉它", parse_args(["--context-depth", "0"]).context_depth == 0)
    check("--context-depth 2 能显式打开（绕过按语种的缺省，给「想再试一次」留口子）",
          parse_args(["--context-depth", "2"]).context_depth == 2)

    # 短句保护的实际行为：<800ms 的碎片后面跟 0.8 秒停顿，**不该**就此收句，
    # 而是等它接上后面的话；但正常长度的话仍然按 700ms 收句（不然字幕会拖）。
    speech = build([("silence", 0.3), ("tone", 0.5), ("silence", 0.8),
                    ("tone", 1.0), ("silence", 1.0)])
    guarded, _ = run_segmenter(speech, short_utterance_ms=800, short_silence_ms=1100)
    plain, _ = run_segmenter(speech, short_utterance_ms=0, short_silence_ms=0)
    check("开短句保护：0.5s 的碎片与后面的话合成一段（不切成两半）",
          len(guarded) == 1, f"切出 {len(guarded)} 段")
    check("关掉保护：同样音频会被切成两段（说明这个开关确实在起作用）",
          len(plain) == 2, f"切出 {len(plain)} 段")

    # ── 12. 防幻听闸不能误杀正常说话（真实事故）────────────────────────────────
    #
    # 用户连着说「你好 欢迎」，两段都被判 no_speech_prob=0.68 / 0.87 并**丢弃**，
    # 而日志显示音频电平是 0.086 / 0.067 —— 明明是人声。他的原话是
    # "我后面明明还在说话 但是被丢弃了"。
    #
    # 原因：no_speech_prob 是模型对**一小段**的自我报告，在 1 秒级片段上很不可靠。
    # 修法：电平明显是人声时，不让模型自述否决它（物理证据压过模型自述）；
    # 电平很弱时仍然让这个闸拦（那正是它擅长的场景）。
    heading("防幻听 · 电平证据压过 no_speech_prob（曾把用户的话扔掉）")

    check("no_speech_prob 没超阈值：不丢",
          decide_no_speech(0.30, 0.60, 0.09) == (False, False),
          str(decide_no_speech(0.30, 0.60, 0.09)))
    check("刚好等于阈值：不丢（用的是 <= 判定）",
          decide_no_speech(0.60, 0.60, 0.09) == (False, False),
          str(decide_no_speech(0.60, 0.60, 0.09)))

    # 这条就是事故现场的数字：0.87 + 电平 0.067
    drop, overrode = decide_no_speech(0.87, 0.60, 0.067)
    check("电平明显是人声时**不丢**，并标记'压过了模型自述'",
          drop is False and overrode is True, f"drop={drop} overrode={overrode}")
    check("事故里的另一段（0.68 + 电平 0.086）同样不丢",
          decide_no_speech(0.68, 0.60, 0.086) == (False, True))

    # 另一半：闸不能被废掉 —— 噪声/气声仍然要拦
    check("电平很弱时仍然丢（噪声、气声正是这个闸擅长的）",
          decide_no_speech(0.90, 0.60, 0.0012) == (True, False),
          str(decide_no_speech(0.90, 0.60, 0.0012)))
    check("刚好等于电平下限：不丢（>= 判定，宁可多留）",
          decide_no_speech(0.90, 0.60, SPEECH_RMS_FLOOR) == (False, True),
          str(decide_no_speech(0.90, 0.60, SPEECH_RMS_FLOOR)))
    check("电平下限比本机实测的底噪（约 0.0005）高得多、比说话（约 0.07）低得多",
          0.0005 < SPEECH_RMS_FLOOR < 0.07, str(SPEECH_RMS_FLOOR))

    check("rms_of 能算出电平（静音 0、满幅约 1）",
          rms_of(np.zeros(1600, dtype=np.float32)) == 0.0
          and 0.99 < rms_of(np.ones(1600, dtype=np.float32)) <= 1.0,
          str(rms_of(np.ones(1600, dtype=np.float32))))

    # ── 13. 准确率基准的工具函数（中文按字算 CER）────────────────────────────
    #
    # 中文不用空格分词：按"词"算的话整句就是一个 token，错一个字和整句全错得到一样的数字，
    # 完全没法用来调参。所以基准必须按**字**算（CER），并且要能自动认出中文。
    heading("准确率基准 · 中文按字算 CER")

    check("中文短句也认得出（「你好」两字也要算中文）",
          looks_chinese("这是一条测试信息") and looks_chinese("你好"),
          f"{looks_chinese('这是一条测试信息')} / {looks_chinese('你好')}")
    check("葡语不被误认成中文",
          not looks_chinese("Bom dia, tudo bem?") and not looks_chinese("A reunião é às três"),
          "葡语被判成中文了")
    check("整批样本的单位判定：中文 → char",
          detect_unit(["这是一条测试信息", "你好"]) == "char",
          detect_unit(["这是一条测试信息", "你好"]))
    check("整批样本的单位判定：葡语 → word",
          detect_unit(["Bom dia", "tudo bem"]) == "word",
          detect_unit(["Bom dia", "tudo bem"]))

    # ⚠️ error_rate 现在返回 dict（多了替换/删除/插入三项），不再是 3 元组 ——
    #    这是本次升级的一部分，所以这里全部改成按字段取。
    check("CER：完全正确 = 0",
          error_rate("这是一条测试信息", "这是一条测试信息", "char")["rate"] == 0.0)
    case = error_rate("这是一条测试信息", "这是一条测试消息", "char")
    check("CER：错一个字 = 1/8",
          abs(case["rate"] - 0.125) < 1e-9 and case["units"] == 8 and case["distance"] == 1,
          f"{case}")
    check("而且归类为**替换 1**（不是删除或插入）",
          case["substitutions"] == 1 and case["deletions"] == 0 and case["insertions"] == 0,
          f"S{case['substitutions']} D{case['deletions']} I{case['insertions']}")
    traditional_case = error_rate("这是一条测试信息", "這是一條測試信息", "char")
    check("CER：整句输出成繁体 = 0.5（4 个字不同）",
          abs(traditional_case["rate"] - 0.5) < 1e-9 and traditional_case["distance"] == 4,
          f"{traditional_case}")
    check("按字算时忽略标点与空格（中文的空白没有语义）",
          error_rate("这是一条测试信息。", "这 是 一 条 测 试 信 息", "char")["rate"] == 0.0,
          str(error_rate("这是一条测试信息。", "这 是 一 条 测 试 信 息", "char")))
    # 漏字/多字要能被分开报出来 —— 这是老师 §八 明确要的"含替换／删除／插入"
    missing = error_rate("这是一条测试信息", "这是一条信息", "char")
    extra = error_rate("这是一条信息", "这是一条测试信息", "char")
    check("漏字 → 删除（D>0、S=0）",
          missing["deletions"] > 0 and missing["substitutions"] == 0,
          f"S{missing['substitutions']} D{missing['deletions']}")
    check("多字 → 插入（I>0、S=0）",
          extra["insertions"] > 0 and extra["substitutions"] == 0,
          f"S{extra['substitutions']} I{extra['insertions']}")

    check("疑似繁体计数：繁体句 > 0，简体句 = 0",
          count_traditional("這是一條測試信息") > 0 and count_traditional("这是一条测试信息") == 0,
          f"{count_traditional('這是一條測試信息')} / {count_traditional('这是一条测试信息')}")

    # ── 评分规则冻结（asr_score v1）──────────────────────────────────────────
    #
    # 老师 §三：评分规则必须**冻结并绑定版本号**，否则历史数字不可比。
    # 所以这里钉三件事：① 归一化与旧实现逐字一致（历史可比）
    # ② 整体错误率是"总错误÷总单位"，不是每句百分比的平均 ③ S/D/I 拆得开。
    heading("评分规则 · asr-score-v1 冻结")
    from asr_score import SCORING_RULES_VERSION, key_term_hits, overall_rate, percentile
    check("规则带版本号（报告里要打出来）", SCORING_RULES_VERSION == "asr-score-v1",
          SCORING_RULES_VERSION)
    # ① 归一化：逐字对齐旧实现（旧实现的两条正则抄在这里，免得将来"顺手改好"了没人发现）
    import re as _re
    _old_punct = _re.compile(r"[^\w\u4e00-\u9fff]", flags=_re.UNICODE)

    def _old_normalize(text, unit="word"):
        text = text.lower().replace("\u2019", "'")
        if unit == "char":
            return _old_punct.sub("", text)
        return " ".join(_re.sub(r"[^\w\s']", " ", text, flags=_re.UNICODE).split())

    from asr_score import normalize as _new_normalize
    fixtures = [("报告警告称，没有人能保证。", "char"), ("报 告 警 告", "char"),
                ("Hello, world!", "word"), ("Versão é 3980 reais.", "word")]
    for text, unit in fixtures:
        check(f"归一化与旧实现一致 [{unit}] {text[:14]}",
              _old_normalize(text, unit) == _new_normalize(text, unit),
              f"旧={_old_normalize(text, unit)!r} 新={_new_normalize(text, unit)!r}")
    check("重音必须保留（é ≠ e）", _new_normalize("versão", "word") == "versão")
    check("中文按字时空白要去掉（否则 FLEURS 的逐字字段会算错字数）",
          _new_normalize("报 告 警 告", "char") == "报告警告", _new_normalize("报 告 警 告", "char"))
    # ② 整体错误率 vs 平均每句：长度差异大时才看得出区别
    pair = [error_rate("a b", "a b", "word"), error_rate("a b c d e f g h i j", "x x x x x x x x x x", "word")]
    pooled, pooled_units, pooled_distance, pooled_sdi = overall_rate(pair)
    mean_each = sum(r["rate"] for r in pair) / len(pair)
    check("整体错误率 = 总错误 ÷ 总单位（不是每句平均）",
          abs(pooled - 10 / 12) < 1e-9 and pooled_units == 12 and pooled_distance == 10,
          f"pooled={pooled:.3f} units={pooled_units}")
    check("而且它与「每句平均」确实不同（否则这条测试没意义）",
          abs(pooled - mean_each) > 0.2, f"pooled={pooled:.3f} mean={mean_each:.3f}")
    check("S/D/I 三项能加总回总错误",
          sum(pooled_sdi) == pooled_distance, f"{pooled_sdi} vs {pooled_distance}")

    # ── 逐项对齐（"错在哪些字上"必须能反复跑出来）───────────────────────────
    #
    # 由来：中文朗读那个 12.3% 里有 ~77% 是**计分假象** —— 参考里的拉丁字母括注
    # （`（Maciej Krezel ）`、`(NHK)`）从来没被念出来。查出这件事靠的不是"整体错误率"，
    # 而是**把删除项逐条打出来**。所以"错在哪些单位上"必须是可复现的输出。
    heading("评分规则 · 逐项对齐 align_ops")
    ops = align_ops("从十二楼换到八楼", "从八楼换到十二楼", "char")
    check("逐项对齐能看出数字被调换了（不是「看着差不多就算对」）",
          any(op[0] in ("S", "D", "I") for op in ops)
          and align("从十二楼换到八楼", "从八楼换到十二楼", "char")[0] > 0,
          str(ops))
    check("删除项带得出漏掉的那个字（插入项反之）",
          all(op[1] is not None and op[2] is None for op in ops if op[0] == "D")
          and all(op[1] is None and op[2] is not None for op in ops if op[0] == "I"),
          str(ops[:8]))
    # ⚠️ 这一条是**防两套实现漂移**：align() 现在只是把 align_ops() 的结果数出来；
    #    如果哪天又变成各算一遍，"总数对得上、S/D/I 分配不一样"就会悄悄发生
    #    —— 而报告里那三项正是老师要求单列的东西。
    cases = [("你好世界这是测试", "你好世界是测试", "char"),
             ("从十二楼换到八楼", "从八楼换到十二楼", "char"),
             ("Versão é 3980 reais", "versao e 3980 reais", "word"),
             ("明镜与点点栏目", "明镜与点点栏目。", "char"),
             ("", "多说了一句", "word")]
    same = True
    for ref, hyp, unit in cases:
        if align(ref, hyp, unit) != tuple(sum(1 for op in align_ops(ref, hyp, unit) if op[0] == kind)
                                          for kind in ("S", "D", "I")):
            same = False
    check("align() 与 align_ops() 逐例一致（同一份实现的两种视图）", same, str(cases))

    # ── 错误来源分类（"错在什么上"的判据本身也要被钉住）──────────────────────
    #
    # 这个分类器决定的是**结论方向**：中文口语那 15.6% 里有多少是"不是听错"的写法差异、
    # 葡语口语那 16.8% 里有多少是语气词。分类规则松一点，结论就会整个反过来 ——
    # 我第一版把"整句里还出现过"当成"自我重复"，于是 71~83% 的删除都被归到那一格，
    # 真实漏词被掩盖。所以这里逐类验，并且专门验**不该归进去的不许归**。
    heading("错误来源分类（asr_error_analysis 的判据）")
    check("她→他是「音频分不出来」（tā 同音，不是听错）",
          analysis.classify_substitution("她", "他", "char").startswith("同音异形"),
          analysis.classify_substitution("她", "他", "char"))
    check("后→後 归到繁简对应字（**已验证两字成对**，不是听错但用户看得到）",
          analysis.classify_substitution("后", "後", "char").startswith("繁简对应字"),
          analysis.classify_substitution("后", "後", "char"))
    check("一→1 归到数字写法（念出来一样）",
          analysis.classify_substitution("一", "1", "char").startswith("数字写法"),
          analysis.classify_substitution("一", "1", "char"))
    check("睡→摔 老老实实算真错（不许被归进「写法」那几格）",
          analysis.classify_substitution("睡", "摔", "char") == "真错",
          analysis.classify_substitution("睡", "摔", "char"))
    check("pra→para 归到口语缩写（葡语里念出来是同一个词）",
          analysis.classify_substitution("pra", "para", "word").startswith("口语缩写"),
          analysis.classify_substitution("pra", "para", "word"))
    check("à→a 归到变音符号差异", analysis.classify_substitution("à", "a", "word").startswith("只差变音"),
          analysis.classify_substitution("à", "a", "word"))
    check("martelly→martelli 算真错（专名听错，不给它找理由）",
          analysis.classify_substitution("martelly", "martelli", "word") == "真错",
          analysis.classify_substitution("martelly", "martelli", "word"))
    # ⚠️ 这条**改过一次口径**（评审意见）：原来断言"葡语 é/eh 被归成语气词"，
    #    那是把一个词普遍当成无信息 —— 而 é 在句子里就是"是"、sei 是"知道"、cê 是"你"。
    #    现在它们只作为**线索**单列，并注明"可能有实义，需看上下文"。
    check("葡语虚词只作为线索单列（明确写着可能有实义，不当成无信息）",
          "高频虚词" in analysis.classify_deletion(["é"], "word", False)
          and "实义" in analysis.classify_deletion(["é"], "word", False),
          analysis.classify_deletion(["é"], "word", False))
    check("葡语实词老老实实算内容词",
          analysis.classify_deletion(["para"], "word", False) == "内容词",
          analysis.classify_deletion(["para"], "word", False))

    # ⚠️ 位置判据：只认**相邻**的重复。放宽到"附近出现过"会把同句里任何一个相同的字
    #    都算成"口吃"，于是"内容字"这一格被吃空（真实漏词全被掩盖）。
    stutter_ops = align_ops("就就就这样", "就这样", "char")
    runs = analysis.deleted_runs(stutter_ops)
    check("口吃（就就就）判得出自我重复",
          len(runs) == 1 and analysis.looks_like_repetition(runs[0][0], runs[0][1],
                                                            list("就就就这样")),
          str(runs))
    far_ops = align_ops("他来了他走了", "来了他走了", "char")
    far_runs = analysis.deleted_runs(far_ops)
    check("隔了几个字的同一个字**不算**自我重复（否则真实漏字会被掩盖）",
          len(far_runs) == 1
          and analysis.looks_like_repetition(far_runs[0][0], far_runs[0][1],
                                             list("他来了他走了")) is False,
          str(far_runs))
    check("删除片段带得出它在参考里的起始位置（不然位置判据无从谈起）",
          analysis.deleted_runs(align_ops("从十二楼换到八楼", "从八楼换到十二楼", "char"))
          and all(isinstance(start, int) for _span, start in
                  analysis.deleted_runs(align_ops("甲乙丙", "甲丙", "char"))))
    # ③ 关键内容专项只按人工给的清单判，且清单为空时不许瞎猜
    check("清单为空 → 一条都不判（不许自己猜哪些是专名）",
          key_term_hits("八楼的 802 房间", "no oitavo andar 802", []) == [])
    check("清单命中/未命中都能如实分开",
          [h["hit"] for h in key_term_hits("八楼的 802 房间", "no oitavo andar 802", ["802", "1201"])]
          == [True, False])
    check("听错的数字不许被洗成正确（802 听成 800 → 未命中）",
          key_term_hits("房间 802", "quarto 800", ["802"])[0]["hit"] is False)
    check("分位数：空列表返回 None，不假装是 0", percentile([], 0.5) is None)
    check("葡语重音不被当成繁体字（那是两回事）",
          count_traditional("A reunião é às três") == 0)

    # ── 规范化口径 asr-norm-v1（评审要求的"双评分"）──────────────────────────
    #
    # 评审指出的核心问题：原来的做法是"从严格错误率里扣掉几个分类桶，把剩下的叫
    # 声学错误率"—— 那个数**既不是严格分也不是规范分**，却看起来像个分数。
    # 正确做法是两套口径**各自重新对齐算一遍**。这一节钉的就是这件事：
    #   ① 规范化只统一"同一个东西的写法"，且每类都必须**验证**等价；
    #   ② 两边算分走的是同一个对齐函数（只是比较文本不同）；
    #   ③ 不许出现"扣桶"式的第三条路径。
    heading("规范化口径 · asr-norm-v1（与严格口径并列，不是替换）")
    check("规范化有自己的版本号（规则变了历史才说得清）",
          NORMALIZED_RULES_VERSION == "asr-norm-v1", NORMALIZED_RULES_VERSION)
    check("严格口径的版本号没动（历史数字必须可比）",
          SCORING_RULES_VERSION == "asr-score-v1", SCORING_RULES_VERSION)

    # ① 数字：**必须验证数值+单位相等**（评审第 1 条：`一 → 9` 曾被当成写法差异）
    check("一 → 1 等价（同一个值的两种写法）",
          normalize_for_scoring("一", "char") == normalize_for_scoring("1", "char"))
    check("一 → 9 **不等价**（值不同就是听错，不许算写法差异）",
          normalize_for_scoring("一", "char") != normalize_for_scoring("9", "char"),
          f"{normalize_for_scoring('一', 'char')} vs {normalize_for_scoring('9', 'char')}")
    check("十 → 0 不等价（10 与 0 不是同一个值）",
          normalize_for_scoring("十", "char") != normalize_for_scoring("0", "char"))
    check("一百元 ↔ 100元 等价（值+单位都比过）",
          normalize_for_scoring("一百元", "char") == normalize_for_scoring("100元", "char"))
    check("三万元 ↔ 30000元 等价（乘数也算进去）",
          normalize_for_scoring("三万元", "char") == normalize_for_scoring("30000元", "char"))
    check("八楼 ↔ 8楼 等价", normalize_for_scoring("八楼", "char") == normalize_for_scoring("8楼", "char"))
    check("八 ↔ 8楼 **不等价**（少了单位就是少了信息）",
          normalize_for_scoring("八", "char") != normalize_for_scoring("8楼", "char"))
    check("一四二四 ↔ 1424 等价（逐位念的数字，口径一致的两个人）",
          normalize_for_scoring("一四二四", "char") == normalize_for_scoring("1424", "char"))
    check("结构不合法的中文数字**不猜**（十十 → None，宁可不算也不猜）",
          chinese_numeral_value("十十") is None and chinese_numeral_value("十五") == 15)
    check("小数点在按字模式下不会被标点规则吃掉（3.5 ≠ 35）",
          normalize_for_scoring("3.5", "char") != normalize_for_scoring("35", "char"))

    # ② 繁简：**必须验证两字成对**（评审第 2 条：`我 → 國` 曾被当成字形差异）
    check("后 → 後 是成对的繁简对应字（可统一）",
          is_variant_pair("后", "後")
          and normalize_for_scoring("后", "char") == normalize_for_scoring("後", "char"))
    check("我 → 國 **不成对**（`我` 不是 `国` 的简体，这是听错）",
          is_variant_pair("我", "國") is False
          and normalize_for_scoring("我", "char") != normalize_for_scoring("國", "char"),
          f"{normalize_for_scoring('我', 'char')} vs {normalize_for_scoring('國', 'char')}")
    check("了 → 覺、些 → 點、五 → 無 都不成对（实测里这些全是听错）",
          all(is_variant_pair(a, b) is False
              for a, b in (("了", "覺"), ("些", "點"), ("五", "無"))))
    check("繁简表里没有「自己映射到自己」的废条目",
          all(key != value for key, value in VARIANT_TO_SIMPLIFIED.items()),
          str([k for k, v in VARIANT_TO_SIMPLIFIED.items() if k == v]))

    # ③ 葡语虚词**不再**被当成"无信息"（评审第 3 条）
    from asr_error_analysis import classify_deletion as _del, classify_substitution as _sub
    check("葡语 é / sei / cê 不再被归成「语气词」（它们可能是是/知道/你）",
          all("高频虚词" in _del([word], "word", False)
              for word in ("é", "sei", "cê")),
          _del(["é"], "word", False))
    check("葡语虚词那一格的说明里写明了「可能有实义」",
          "实义" in _del(["sei"], "word", False))
    check("中文语气词只剩纯感叹词（吧/呢/嘛/啊 都不算）",
          "嗯" in _del(["嗯"], "char", False) and all(
              "感叹词" not in _del([word], "char", False) for word in ("吧", "呢", "嘛", "啊")))

    # ④ 拉丁字母/数字的删除**不许**默认"本来就没念"（评审第 4 条）
    check("含拉丁字母的删除归到「需听音频」那一格（不再预设它没念）",
          "需听音频" in _del(list("scp"), "char", False), _del(list("scp"), "char", False))
    check("含数字的删除同样要人工确认",
          "需听音频" in _del(list("4s店"), "char", False))

    # ⑤ 重复判定的位置必须与对齐**用同一份归一化文本**（评审第 5 条）
    check("reference_items 与对齐用的是同一套归一化（标点不参与下标）",
          analysis.reference_items("他说：就就就这样。", "char")
          == list(normalize("他说：就就就这样。", "char")),
          str(analysis.reference_items("他说：就就就这样。", "char")))
    check("因此标点不会把「附近」的位置算错",
          analysis.reference_items("甲，乙。丙", "char") == ["甲", "乙", "丙"],
          str(analysis.reference_items("甲，乙。丙", "char")))

    # ⑥ 替换分类：验证式归类（这几条直接对应评审点出的两个 bug）
    check("一 → 9 归到真错（不再进「数字写法」）",
          _sub("一", "9", "char").startswith("真错"), _sub("一", "9", "char"))
    check("一 → 1 才算数字写法", _sub("一", "1", "char").startswith("数字写法"), _sub("一", "1", "char"))
    check("我 → 國 归到真错（繁体但不成对）",
          "不成对" in _sub("我", "國", "char"), _sub("我", "國", "char"))
    check("后 → 後 才算繁简对应字", "繁简对应字" in _sub("后", "後", "char"), _sub("后", "後", "char"))

    # ⑦ 两套口径的关系：必须是"重新对齐算"而不是"扣桶"
    strict = error_rate("他说了一百元", "他说了100元", "char")
    normalized = normalized_error_rate("他说了一百元", "他说了100元", "char")
    check("严格口径把 一百元/100元 算成错（历史可比）", strict["distance"] > 0, str(strict))
    check("规范化口径把它们看成一样（重新对齐后距离为 0）",
          normalized["distance"] == 0, str(normalized))
    check("规范化**不是**扣桶：单位数也跟着变了（扣桶不会改变分母）",
          strict["units"] != normalized["units"] or normalized["distance"] == 0,
          f"严格 {strict['units']} 单位 / 规范化 {normalized['units']} 单位")
    check("规范化不会把改值的数字洗掉（一 → 9 仍然算错）",
          normalized_error_rate("一", "9", "char")["distance"] > 0)
    check("规范化不会把否定词洗掉（不 → 无 仍算错）",
          normalized_error_rate("这不是我的", "这是我的", "char")["distance"] > 0)

    # ⑧ 关键内容检查：数字核对值+单位、否定只报出现性
    report = numeric_report("从十二楼的802换到八楼", "从8楼的800换到12楼", "char")
    check("数字核对能挑出被改值的那个（802 → 800）",
          [item for item in report if item["ok"] is False]
          and any(item["value"] == "802" and item["ok"] is False for item in report),
          str(report))
    check("数字核对认得出同义写法（八楼 ↔ 8楼 都算命中）",
          all(item["ok"] for item in numeric_report("八楼的802", "8楼的802", "char")),
          str(numeric_report("八楼的802", "8楼的802", "char")))
    check("光秃秃的一位数不算关键数字（否则「一些/一死」会满屏误报）",
          numeric_report("一些东西", "一些东西", "char") == []
          and numeric_report("一个东西", "一个东西", "char") != [])
    check("否定词只报出现性差异（不判极性）",
          negation_flags("这不是我要的", "char") == {"不"}
          and negation_flags("这是我想要的", "char") == set())

    # ⑨ 葡语数字词 ↔ 阿拉伯数字（实测踩到：规范化一度**比严格更差**）
    #
    # 参考把数字写成词（`vinte anos`）、模型写成数字（`20 anos`），念出来一模一样。
    # 不做这一步，规范化会把它们判成"替换+删除"，于是"规范化"反而更差 ——
    # 那是规则的缺陷。这些断言把实测出现的那几种写法钉住。
    check("vinte ↔ 20 等价", normalize_for_scoring("vinte anos", "word")
          == normalize_for_scoring("20 anos", "word"))
    check("quatorze ↔ 14 等价（巴西葡语两种拼法都要认）",
          normalize_for_scoring("quatorze anos", "word") == normalize_for_scoring("14 anos", "word")
          and normalize_for_scoring("catorze anos", "word") == normalize_for_scoring("14 anos", "word"))
    check("合成数也对：trinta e cinco ↔ 35、cento e vinte ↔ 120、mil e quinhentos ↔ 1500",
          all(normalize_for_scoring(words, "word") == str(value)
              for words, value in (("trinta e cinco", 35), ("cento e vinte", 120),
                                   ("mil e quinhentos", 1500), ("dois mil e vinte", 2020))))
    check("five and six ≠ eleven：不合法的 `e` 连接**不许**猜成一个数",
          portuguese_number_value(["cinco", "e", "seis"]) is None
          and normalize_for_scoring("cinco e seis", "word")
          != normalize_for_scoring("onze", "word"))
    check("升档乘数：mil milhões = 10^9（不是 1000 + 10^6）",
          portuguese_number_value(["mil", "milhões"]) == 10 ** 9,
          str(portuguese_number_value(["mil", "milhões"])))
    check("数字后面的单位仍然跟着数字（3 milhões ↔ 3milhões 等价）",
          normalize_for_scoring("3 milhões", "word") == normalize_for_scoring("3milhões", "word"),
          f"{normalize_for_scoring('3 milhões', 'word')!r}")
    check("葡语小数与千分位在标点处理里不会被切碎（1.234,56 仍是同一个数）",
          normalize_for_scoring("1.234,56 reais", "word") == normalize_for_scoring("1234,56 reais", "word"),
          f"{normalize_for_scoring('1.234,56 reais', 'word')!r}")

    # ⑩ 问题样本清单（用户要的"日志里带 ERROR，方便筛"）
    #
    # 原来的报告只有"随机看 N 条对照"—— 随机看对排查**没有用**（多半是好的）。
    # 现在给出的是"全部有问题、最差排最前、带音频路径与具体差异"的清单，
    # 每条首行以 ERROR 开头，所以 `Select-String ERROR` 就能捞出来。
    heading("问题样本清单 · 日志里带 ERROR 前缀")
    sample_rows = [
        {"file": "a.wav", "seconds": 3.0, "rate": 0.05, "units": 100, "substitutions": 3,
         "deletions": 2, "insertions": 0, "reference": "这是一条好句", "hypothesis": "这是一条好句"},
        {"file": "b.wav", "seconds": 2.0, "rate": 0.50, "units": 10, "substitutions": 4,
         "deletions": 1, "insertions": 0, "reference": "从十二楼换到八楼", "hypothesis": "从八楼换到十二楼"},
        {"file": "c.wav", "seconds": 4.0, "rate": 1.00, "units": 8, "substitutions": 8,
         "deletions": 0, "insertions": 0, "reference": "小李飞刀听说过呀", "hypothesis": "夏立福的聽說過耶"},
    ]
    picked = problem_samples(sample_rows, threshold=0.10, unit="char")
    check("只挑出超过阈值的（好的那条不进来）",
          [item["file"] for item in picked] == ["c.wav", "b.wav"], str([i["file"] for i in picked]))
    check("最差的排最前（排查要先看最坏的）",
          picked[0]["rate"] >= picked[-1]["rate"])
    check("阈值给足 1.1 就什么都不报（可以一键关掉）",
          problem_samples(sample_rows, threshold=1.1, unit="char") == [])
    check("count/limit 能限制条数",
          len(problem_samples(sample_rows, threshold=0.10, unit="char", limit=1)) == 1)
    body = format_problem_samples(picked, pack_dir="var/asr-eval/packs/zh-speech-dev")
    error_lines = [line for line in body.splitlines() if line.startswith("ERROR")]
    check("每条首行都以 ERROR 开头（日志里能直接筛）",
          len(error_lines) == len(picked) and all("c.wav" in error_lines[0] for _ in [0]),
          str(error_lines[:2]))
    check("清单里带音频**完整路径**（照着就能打开听）",
          "var" in body and "zh-speech-dev" in body and ".wav" in body,
          body.splitlines()[1])
    check("清单里带具体差异（漏了哪个字、听成什么）",
          "漏" in body and "→" in body, body.splitlines()[4])
    check("差异用「漏X / 多X / A→B」三种写法，不用看懂日志格式",
          all(marker in body for marker in ("漏", "→")))

    # ⑪ 切句代价实验（context_eval：整段 vs 逐句切 vs 产线切）
    #
    # 这一节钉的是**实验的公平性前提** —— 前提不成立，量出来的差值就没有意义。
    # 三条前提都在文件头写明了，这里把它们变成断言：
    #   ① 参考必须覆盖整段音频（所以段内转写必须全部"干净"）
    #   ② 三种喂法用同一套解码参数（脚本层面结构上保证，不在这一节测）
    #   ③ 拼接不加分隔符（加了会让切过的凭空多出单位、显得更准）
    import context_eval as ctx

    heading("切句代价实验 · 挑段的公平性前提")
    rows = [
        {"start": 0.0, "end": 2.0, "speaker": "A", "text": "第一句话"},
        {"start": 2.1, "end": 4.0, "speaker": "B", "text": "第二句话"},
        {"start": 10.0, "end": 12.0, "speaker": "A", "text": "隔了很久的一句"},   # 中间空了 6 秒
        {"start": 12.1, "end": 14.0, "speaker": "A", "text": "这里[+]有重叠"},
        {"start": 14.1, "end": 16.0, "speaker": "A", "text": "正常的一句"},
    ]
    check("带事件标记（重叠/听不清/笑声）的转写不算「干净」",
          ctx.is_clean(rows[0]) and ctx.is_clean(rows[3]) is False,
          f"{ctx.is_clean(rows[0])} / {ctx.is_clean(rows[3])}")

    spans = ctx.pick_spans(rows, target_seconds=30.0, min_seconds=3.0,
                           min_utterances=2, max_gap=2.0, count=5, seed=0)
    check("挑出来的段**不跨事件标记**（否则参考盖不住音频）",
          all(all(ctx.is_clean(row) for row in span["utterances"]) for span in spans) and spans)
    check("挑出来的段**不跨长时间空档**（停顿 > max_gap 就断开）",
          all(span["end"] - span["start"] <= 30.0 for span in spans))
    check("段内句数与时长都满足下限（否则样本太短、量不准）",
          all(len(span["utterances"]) >= 2 and span["duration"] >= 3.0 for span in spans))
    check("前两句会被挑成一段（它们是连续且干净的）",
          spans and len(spans[0]["utterances"]) == 2, str([len(s["utterances"]) for s in spans]))
    tight = ctx.pick_spans(rows, target_seconds=30.0, min_seconds=3.0,
                           min_utterances=2, max_gap=2.0, count=5, seed=0)
    check("同一输入 → 同一输出（实验可复现）",
          [s["utterances"] for s in tight] == [s["utterances"] for s in spans])

    check("拼接**不加分隔符**（中文按字算，加空格会凭空多出单位）",
          ctx.join_texts(["你好", "世界"], "char") == "你好世界",
          ctx.join_texts(["你好", "世界"], "char"))
    check("葡语按词拼接才加空格（不然词会粘成一个）",
          ctx.join_texts(["bom dia", "tudo bem"], "word") == "bom dia tudo bem")
    # 逐句转写解析：真写一个文件让它读（而不是查"函数有没有文档"这种假断言）
    transcript = ROOT / "var" / "test" / "python-suite" / "ctx-transcript.txt"
    transcript.parent.mkdir(parents=True, exist_ok=True)
    transcript.write_text(
        "[0.811,6.057]\tG00000168\t男,普通话\t第一句话\n"
        "坏行（没有时间戳，应当被跳过）\n"
        "[6.100,8.200]\tG00000000\t女,普通话\t第二句[+]重叠\n",
        encoding="utf-8")
    parsed = ctx.parse_transcript(transcript)
    check("逐句转写解析得对（时间戳/说话人/文本）",
          len(parsed) == 2 and parsed[0]["speaker"] == "G00000168"
          and abs(parsed[0]["start"] - 0.811) < 1e-6 and parsed[0]["text"] == "第一句话",
          str(parsed))
    check("坏行被跳过，不炸（真实语料里什么行都有）", len(parsed) == 2, str(len(parsed)))
    check("带 [ + ] 的那句会被判成不干净（重叠语音不能当参考）",
          ctx.is_clean(parsed[1]) is False)

    # 参数扫描 + 段清单固化 + 报告（用户要求"我能重复执行、也要能读"）
    heading("切句代价实验 · 参数扫描与可复现")

    def _spans_error(good_spans):
        """缺 recording 时应当抛错 —— 返回 True 表示**没有**报错（＝测试失败）。"""
        import tempfile
        target = ROOT / "var" / "test" / "python-suite" / "ctx-spans-bad.json"
        try:
            ctx.save_spans(target, [{"start": 0.0, "end": 1.0, "utterances": []}])
            return True
        except ValueError:
            return False
        finally:
            target.unlink(missing_ok=True)

    check("扫描写法解析得对（500,800 → 用缺省上限）",
          [(c["silence_ms"], c["max_speech_ms"]) for c in ctx.parse_sweep("500,800")]
          == [(500, ctx.PRODUCTION_SEGMENTER["max_speech_ms"]), (800, ctx.PRODUCTION_SEGMENTER["max_speech_ms"])],
          str(ctx.parse_sweep("500,800")))
    check("带句子上限的写法也对（800/30000）",
          [(c["silence_ms"], c["max_speech_ms"]) for c in ctx.parse_sweep("800/30000")]
          == [(800, 30000)])
    check("每一档都带得出人能读的标签（报告里要打出来）",
          all(c["label"].startswith("C silence") for c in ctx.parse_sweep("500/15000,2000/30000")),
          str([c["label"] for c in ctx.parse_sweep("500/15000,2000/30000")]))

    spans_file = ROOT / "var" / "test" / "python-suite" / "ctx-spans.json"
    spans_file.parent.mkdir(parents=True, exist_ok=True)
    # `pick_spans` 只管挑哪几句，`recording` 由调用方补（真跑时是 main() 补的）
    named_spans = [dict(span, recording="CTS-TEST-0001.wav") for span in spans]
    ctx.save_spans(spans_file, named_spans)
    reloaded = ctx.load_spans(spans_file)
    check("段清单能存能读（同一批段才能反复比较）",
          len(reloaded) == len(named_spans)
          and reloaded[0]["recording"] == named_spans[0]["recording"]
          and len(reloaded[0]["utterances"]) == len(named_spans[0]["utterances"]),
          f"{len(reloaded)} vs {len(named_spans)}")
    check("段清单里缺 recording 会**明确报错**（不许静默写成空串）",
          _spans_error(named_spans) is False,
          "缺字段时没有报错")
    check("段清单带指纹（一眼看出两次跑的是不是同一批）",
          ctx.spans_digest(reloaded) == ctx.spans_digest(named_spans)
          and len(ctx.spans_digest(named_spans)) == 16,
          ctx.spans_digest(named_spans))
    check("换了参考文本，指纹就变（不是恒定值）",
          ctx.spans_digest([{"recording": "a", "start": 0.0, "end": 1.0,
                             "utterances": [{"text": "甲"}]}])
          != ctx.spans_digest([{"recording": "a", "start": 0.0, "end": 1.0,
                                "utterances": [{"text": "乙"}]}]))
    # 附加字段必须活着：建库脚本会给每段写 source（来自哪场录音哪一秒），
    # 而第一版 save_spans 只挑固定字段，把它**静默丢了** —— 报告里就再也查不回
    # "这段是从语料哪个位置拼出来的"。可追溯性不能依赖"我记得它原来在哪"。
    richer = [dict(named_spans[0], source={"recording": "SRC-1", "start": 1.5, "end": 9.0})]
    ctx.save_spans(spans_file, richer)
    again = ctx.load_spans(spans_file)
    check("段清单保存时**保留附加字段**（source 这类可追溯信息不许丢）",
          again[0].get("source", {}).get("recording") == "SRC-1", str(again[0].keys()))

    fake_payload = {
        "config": {"split": "dev", "spansFile": str(spans_file), "spansDigest": "abcd1234",
                   "spans": 2, "totalSeconds": 50.0, "model": "large-v3", "device": "cuda",
                   "computeType": "float16", "beamSize": 5, "language": "zh", "vadFilter": True,
                   "scoringRules": SCORING_RULES_VERSION,
                   "normalizedRules": NORMALIZED_RULES_VERSION,
                   "segmenterBase": ctx.PRODUCTION_SEGMENTER,
                   "modes": [{"key": "A", "label": "A 整段（留全部上下文）", "kind": "whole",
                              "config": None},
                             {"key": "C1", "label": "C silence 500 / 上限 15s",
                              "kind": "segmenter", "config": {"silence_ms": 500}}],
                   "rerun": "python asr-eval/context_eval.py --spans-file x.json"},
        "summary": [
            {"key": "A", "label": "A 整段（留全部上下文）", "rate": 0.12, "normalized": 0.10,
             "units": 100, "distance": 12, "sdi": (5, 6, 1), "segments": 2,
             "meanSegmentsPerSpan": 1.0, "meanSegmentSeconds": 25.0, "coverage": 1.0,
             "meanUsedPerSegment": 5.0, "waitSeconds": None},
            {"key": "C1", "label": "C silence 500 / 上限 15s", "rate": 0.17, "normalized": 0.15,
             "units": 100, "distance": 17, "sdi": (8, 8, 1), "segments": 12,
             "meanSegmentsPerSpan": 6.0, "meanSegmentSeconds": 3.3, "coverage": 0.8,
             "meanUsedPerSegment": 1.2, "waitSeconds": 1.7},
        ],
        "records": [{"recording": "r.wav", "start": 1.0, "end": 26.0, "duration": 25.0,
                     "utterances": 6, "reference": "甲乙丙丁",
                     "A": {"rate": 0.12, "text": "甲乙丙丁", "segments": 1},
                     "C1": {"rate": 0.17, "text": "甲乙丁", "segments": 6}}],
    }
    report = ctx.render_report(fake_payload)
    check("报告里有汇总表", "## 汇总" in report and "| 喂法 |" in report, report[:80])
    check("报告里有**怎么重跑**（用户要的可重复执行）",
          "重跑命令" in report and "--spans-file" in report)
    check("报告里写明用的是哪一批段（含指纹）", "abcd1234" in report)
    check("报告里有逐段明细与样本原文", "## 逐段明细" in report and "甲乙丙丁" in report)
    check("报告里写明等待是**估算**、不是端到端实测",
          "估算" in report and "端到端" in report)

    # ⑫ 重叠解码的拼接逻辑（这一步错了，整个实验的结论就是错的）
    #
    # 重叠方案最贵的地方不是算力，而是**拼接**：窗口 AB 的输出要切成"A 的部分 + B 的部分"。
    # 所以这里的判据必须钉死：按**词的中点**归属，边界上那个词只归一边，不重不漏。
    import context_overlap as ov

    heading("上下文实验 · 重叠窗口的拼接判据")
    words = [  # 窗口里三个词：前两个属于上一段，第三个属于本段（边界在 2.0s）
        {"start": 0.0, "end": 1.0, "text": "上"},
        {"start": 1.0, "end": 1.9, "text": "段"},
        {"start": 2.1, "end": 3.0, "text": "本"},
    ]
    kept, dropped, ok = ov.slice_by_boundary(words, 2.0, "after")
    check("左邻窗口：只取边界之后的词（本段）",
          ok and [w["text"] for w in kept] == ["本"] and [w["text"] for w in dropped] == ["上", "段"],
          f"{[w['text'] for w in kept]} / {[w['text'] for w in dropped]}")
    kept, dropped, ok = ov.slice_by_boundary(words, 2.0, "before")
    check("右邻窗口：只取边界之前的词（本段）",
          ok and [w["text"] for w in kept] == ["上", "段"] and [w["text"] for w in dropped] == ["本"],
          f"{[w['text'] for w in kept]}")
    check("跨在边界上的词按**中点**归属（只归一边，不重不漏）",
          [w["text"] for w in ov.slice_by_boundary(
              [{"start": 1.8, "end": 2.6, "text": "跨"}], 2.0, "after")[0]] == ["跨"]
          and [w["text"] for w in ov.slice_by_boundary(
              [{"start": 1.4, "end": 2.2, "text": "跨"}], 2.0, "after")[0]] == [],
          "中点在边界右侧应归本段，左侧应归上一段")
    check("中点**正好落在边界**时归本段（`>=`，规则要确定、不能两边都拿）",
          [w["text"] for w in ov.slice_by_boundary(
              [{"start": 1.6, "end": 2.4, "text": "跨"}], 2.0, "after")[0]] == ["跨"]
          and [w["text"] for w in ov.slice_by_boundary(
              [{"start": 1.6, "end": 2.4, "text": "跨"}], 2.0, "before")[0]] == [],
          "中点落在边界时应只归一边")
    check("没有时间戳时明确报告（调用方要如实记成「兜底」）",
          ov.slice_by_boundary([], 2.0, "after")[2] is False)
    check("词拼回来时不加空格（中文按字算）",
          ov.join_words([{"text": "你"}, {"text": "好"}]) == "你好",
          ov.join_words([{"text": "你"}, {"text": "好"}]))
    check("五种喂法的名字与标签都在（报告要按它们打表）",
          ov.MODES == ("C1", "T1", "T2", "L", "R")
          and all(mode in ov.MODE_LABELS for mode in ov.MODES),
          str(ov.MODES))

    # ⑬ 葡语那个**代理**实验的标注与回显核对
    #
    # 它是代理这件事必须是**机器也能看见**的：既写在输出里，也写进 JSON。
    # 另外钉住"巧合 vs 真回显"的判据 —— 实测踩到过：前后两条参考都只是 `aham`，
    # 模型两次都写 `Uhum.`，闸就报了回显，而它其实跟提示词无关。
    import pt_context_proxy as proxy

    heading("葡语代理实验 · 标注与回显核对")
    check("脚本输出里明确写了「这是代理、不能与中文表并列」",
          "代理" in proxy.__doc__ and "不要和中文那张表并排放" in proxy.__doc__,
          (proxy.__doc__ or "")[:60])
    check("代理的三条限制都写在文件头（缺一条就会被误读）",
          all(word in proxy.__doc__ for word in
              ("没有时间戳、没有场次编号", "下界", "真实葡语连续录音")))
    check("喂法就是中文那三种，标签带说明（C1 ＝产线现状）",
          proxy.MODES == ("C1", "T1", "T2") and "现状" in proxy.LABELS["C1"],
          str(proxy.MODES))
    detail = proxy.echo_detail("Uhum.", "Uhum.", "aham")
    check("撞上的片段会打印出来，并说明参考里有没有",
          detail["overlap"] == "uhum" and detail["backedByReference"] is False,
          str(detail))
    check("参考里本来就有的重合 → 判成「不是回显」",
          proxy.echo_detail("是的我知道", "是的", "是的我知道")["backedByReference"] is True)
    check("标点/大小写不影响比对（`Uhum.` 与 `uhum` 是同一段）",
          proxy._plain("Uhum.") == proxy._plain("uhum") == "uhum",
          proxy._plain("Uhum."))
    check("没东西可比时返回 None（不能凭空空报）",
          proxy.echo_detail("", "tchau", "bom dia") is None
          and proxy.echo_detail("bom dia", "", "bom dia") is None)

    # ⑭ `--modes`：只跑选中的喂法（缺省 C1,T2，all = 全部五种）
    #
    # 用户的要求：不要每次 `--context` 都把五种跑一遍 —— 已否掉的方案（T1/L/R，
    # 见 docs/14 §6.7.2）复核时不该再付算力。这条测试钉三件事：
    # 缺省是什么、写错会不会报错、**"只跑了一部分"有没有写进报告**。
    heading("上下文实验 · --modes 选喂法")
    check("不填 → 缺省 C1,T2（**不是**全部五种）",
          ov.parse_modes(None) == (("C1", "T2"), False), str(ov.parse_modes(None)))
    check("`all` → 全部五种，按固定顺序", ov.parse_modes("all") == (ov.MODES, False),
          str(ov.parse_modes("all")))
    check("大小写与空格都容忍", ov.parse_modes(" t1, t2 , l ") == (("C1", "T1", "T2", "L"), True),
          str(ov.parse_modes(" t1, t2 , l ")))
    check("顺序固定：T2,C1 与 C1,T2 得到同一个元组（产物名才不会两种写法）",
          ov.parse_modes("T2,C1") == ov.parse_modes("C1,T2"))
    check("没选 C1 会**自动补上**并如实报告（C1 是所有比较的基线）",
          ov.parse_modes("T2") == (("C1", "T2"), True))
    for bad in ("T9", "C1,Z", "1", ""):
        try:
            ov.parse_modes(bad) if bad else ov.parse_modes("x")
        except ValueError:
            pass
    check("写错的代号必须报错，不许静默当成缺省",
          all(_raises(lambda value=value: ov.parse_modes(value)) for value in ("T9", "C1,Z", "1")))
    check("`all` 混在列表里给出专门的提示（不是含混的「不认识 ALL」）",
          "单独写" in _error_of(lambda: ov.parse_modes("C1,all")))
    check("run_span 真的按选中的喂法跑（没选的解码一次都不做）",
          "def run_span(model, args, span, audio, rate, segments, modes)" in
          (ROOT / "asr-eval" / "context_overlap.py").read_text(encoding="utf-8")
          and 'if "L" in modes:' in (ROOT / "asr-eval" / "context_overlap.py").read_text(encoding="utf-8"))

    partial = _partial_payload()
    report = ov.render_report(partial)
    check("报告里写明本次跑了哪几种", "本次跑了几种" in report and "C1、T2" in report)
    check("报告里写明**没跑**哪几种、以及怎么跑全部",
          "未跑：T1、L、R" in report and "--modes all" in report)
    check("没跑 L/R 时不出「拼接分歧」那一节（空表比没有表更误导）",
          "拼接分歧时谁对" not in report)
    check("逐段明细只列跑了的喂法（不会出现空列/借来的数字）",
          "| 录音 | 时间 | 秒 | C1 | T2 |" in report)
    auto = dict(partial)
    auto["config"] = {**partial["config"], "modesAutoBase": True, "modesSkipped": ["T1", "L", "R"],
                      "modesRun": ["C1", "T2"]}
    check("自动补 C1 时报告里说清楚（否则读报告的人以为连现状都没测）",
          "已自动加入" in ov.render_report(auto))
    limited = dict(partial)
    limited["config"] = {**partial["config"], "limit": 3}
    check("--limit 的结果在报告里标明**不是完整结果**",
          "不能当基线读" in ov.render_report(limited))

    # ⑭ 收音质量量化（mic_eval）：指标算法本身必须先在合成信号上对过
    #
    # 这些检查为什么必须有：报告里会出现"眼镜比手机 SNR 高 X dB"这样的结论，
    # 而一旦指标算法本身错了（比如分位数取反、削波门槛写错），
    # 结论会**看起来完全正常**却是假的。所以先用已知答案的合成信号钉住算法。
    import mic_eval as mic

    # 解码前的静音闸（2026-10-23）：实测在 RMS 0.001~0.005 的安静段上，
    # 归一化把噪声放大后 Whisper 吐出「中文字幕提供 / 中文字幕志愿者 李宗盛」并当字幕发了出去。
    # 这里钉住"什么该拦、什么不该拦"两侧 —— 判严了会吃真字幕，判松了幻听照旧。
    heading("解码前的静音闸（安静段不喂模型 / 小声人声照常识别）")
    import whisper_stream as _ws

    quiet = (np.random.default_rng(3).normal(0, 0.002, 16000 * 2)).astype(np.float32)
    check("近乎静音（RMS≈0.002）会被判为丢弃并给出原因",
          _ws.silence_skip_reason(quiet) is not None, str(_ws.silence_skip_reason(quiet)))
    check("原因里写清了电平与阈值（日志能直接看出为什么丢）",
          "电平" in str(_ws.silence_skip_reason(quiet)))

    # 真实说话电平（RMS≈0.03）必须放行 —— 这是"sorry 别吃真字幕"那一侧
    speechy = (np.random.default_rng(4).normal(0, 0.03, 16000 * 2)).astype(np.float32)
    check("正常人声电平（RMS≈0.03）必须放行",
          _ws.silence_skip_reason(speechy) is None, str(_ws.silence_skip_reason(speechy)))
    # 大声与小音量之间：0.008 阈值附近两侧都要有断言（阈值本身就是契约）
    check("阈值下沿（0.019 = 实测幻听段所在区间）拦、上沿（0.021）放",
          _ws.silence_skip_reason(np.full(16000, 0.019, dtype=np.float32)) is not None
          and _ws.silence_skip_reason(np.full(16000, 0.021, dtype=np.float32)) is None)

    check("空音频直接判丢弃，不会送给模型", _ws.silence_skip_reason(np.zeros(0, dtype=np.float32)) is not None)
    # 归一化本身会把静音放大 —— 这正是"闸必须放在归一化之前"的原因
    boosted = _ws.normalize_peak(quiet)
    check("归一化确实会把静音抬到正常电平（所以静音闸必须在它之前）",
          float(np.abs(boosted).max()) > 0.5, float(np.abs(boosted).max()))
    check("幻听表新增了实测到的两条水印短语",
          _ws.looks_like_hallucination("中文字幕提供") and _ws.looks_like_hallucination("中文字幕志愿者 李宗盛"))
    check("但不把「中文字幕」这种短词一并钉死（用户真说时不能被吃）",
          _ws.looks_like_hallucination("请打开中文字幕") is False)

    heading("收音质量量化 · 指标算法（合成信号，已知答案）")
    probe_rate = 16000
    probe_seconds = 6
    probe_t = np.arange(probe_rate * probe_seconds) / probe_rate
    probe_tone = 0.2 * np.sin(2 * np.pi * 440 * probe_t)
    probe_tone[probe_rate: 2 * probe_rate] = 0.0
    probe_tone[3 * probe_rate: 4 * probe_rate] = 0.0
    rng = np.random.default_rng(7)
    synthetic = probe_tone + rng.normal(0, 0.002, probe_tone.size)   # 语音档 0.1414 / 噪声 0.002 → 约 37 dB

    stats = mic.si_snr_like(synthetic, probe_rate)
    check("信噪比：合成信号约 37 dB，算法算出来要落在这个区间",
          30 <= stats["snrDb"] <= 45, stats["snrDb"])
    check("噪声底取自静音段（不是被说话声抬高）",
          abs(stats["noise"] - 0.002) < 0.001, stats["noise"])
    check("干净信号不报削波", mic.clipping(synthetic) == 0, mic.clipping(synthetic))
    check("人为放大到削波后必须检出", mic.clipping(np.clip(synthetic * 8, -1, 1)) > 0,
          mic.clipping(np.clip(synthetic * 8, -1, 1)))
    check("直流偏置能检出", abs(mic.dc_offset(synthetic + 0.05) - 0.05) < 1e-3,
          mic.dc_offset(synthetic + 0.05))
    check("纯噪声段不报削波",
          mic.clipping(np.zeros(probe_rate * 2, dtype=np.float32)
                       + rng.normal(0, 0.0005, probe_rate * 2)) == 0)

    spectrum = mic.ltas(synthetic, probe_rate)
    check("频带能量占比合计应接近 100%（缺频带会让百分比失真）",
          abs(sum(value for key, value in spectrum.items() if not key.startswith("_")) - 100) < 1,
          sum(value for key, value in spectrum.items() if not key.startswith("_")))
    check("440 Hz 的能量必须落进 250–1k 两个带里（频带边界写错会跑到别处）",
          spectrum["250"] + spectrum["500"] > 60, f"250={spectrum['250']} 500={spectrum['500']}")
    check("高于 Nyquist/2 的频带对 16k 音频必须是 0（否则说明带边界算错）",
          spectrum["_above8k"] == 0, spectrum["_above8k"])

    check("平静信号不应被报成块接缝咔哒",
          mic.block_clicks(np.tile(probe_tone[:probe_rate], 3), probe_rate)["ratio"] == 0,
          mic.block_clicks(np.tile(probe_tone[:probe_rate], 3), probe_rate))
    clicky = np.tile(np.zeros(probe_rate, dtype=np.float32) + 0.001, 3)
    clicky[probe_rate] = 0.9
    clicky[2 * probe_rate] = 0.9
    check("人为加了周期性跳变时必须检出", mic.block_clicks(clicky, probe_rate)["count"] >= 1,
          mic.block_clicks(clicky, probe_rate))

    check("CER：完全相同为 0",
          mic.cer("亮亮眼镜这条产品线", "亮亮眼镜这条产品线") == 0)
    check("CER：错一个字 = 1/字数（亮亮眼镜→亮亮眼睛 是 1/4）",
          abs(mic.cer("亮亮眼镜", "亮亮眼睛") - 0.25) < 1e-9, mic.cer("亮亮眼镜", "亮亮眼睛"))
    check("CER 会先去掉标点（否则标点差异会被算成错字）",
          mic.cer("你好，世界。", "你好世界") == 0)
    check("裸 PCM 没给采样率时必须报错（猜错采样率会让指标全错）",
          "必须给 --rate" in _exit_message_of(lambda: mic.read_audio(
              ROOT / "var" / "asr-eval" / "__nope__.pcm")))

    # 8-bit wav 必须被**明确拒绝**，而不是被当成 16-bit 读成乱码；
    # 16-bit 的读回来必须与写入一致 —— 这两条一起锁住"读音频"这一层。
    probe_dir = ROOT / "var" / "tmp"
    probe_dir.mkdir(parents=True, exist_ok=True)
    bad_wav = probe_dir / "mic-eval-probe-8bit.wav"
    with wave.open(str(bad_wav), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(1)
        handle.setframerate(16000)
        handle.writeframes(b"\x80" * 1600)
    check("8-bit wav 明确拒绝（不静默读成乱码）",
          "只支持 16-bit" in _exit_message_of(lambda: mic.read_audio(bad_wav)))
    good_wav = probe_dir / "mic-eval-probe-16bit.wav"
    payload = (np.sin(np.arange(1600) / 20) * 8000).astype("<i2")
    with wave.open(str(good_wav), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(16000)
        handle.writeframes(payload.tobytes())
    loaded, loaded_rate, _fmt = mic.read_audio(good_wav)
    check("16-bit wav 读回来的采样值与采样率都与写入一致",
          loaded_rate == 16000 and int(round(loaded[10] * 32768)) == int(payload[10]),
          f"rate={loaded_rate} value={loaded[10]}")
    bad_wav.unlink()
    good_wav.unlink()

    # ── systemd 环境文件生成（scripts/make-env-file.py）──────────────────────
    # 裸机/conda 部署都要把 PATH 与 LD_LIBRARY_PATH 交给 systemd。
    # 这两个值是手工抄写最容易出错的地方（路径长、含多级目录），
    # 所以让脚本按环境目录现算，并用测试锁住"算不出来时要明确报错"。
    heading("systemd 环境文件生成（make-env-file.py）")
    env_script = ROOT / "scripts" / "make-env-file.py"
    fake_env = probe_dir / "fake-venv"
    fake_env.mkdir(parents=True, exist_ok=True)
    (fake_env / "bin").mkdir(exist_ok=True)

    def run_env_file(*extra):
        # 子进程强制 UTF-8：Windows 上 Python 往管道写中文会按 cp936 编码，
        # 父进程再按 utf-8 解码就是乱码（断言会莫名其妙地失败）。
        # 顺便用 errors='replace' 兜住，不抛 UnicodeDecodeError。
        env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
        return subprocess.run(
            [sys.executable, str(env_script), *[str(item) for item in extra]],
            capture_output=True, text=True, encoding="utf-8", errors="replace", env=env,
        )

    good = run_env_file(fake_env, "--python", sys.executable)
    check("能按环境目录算出 PATH（指向该环境的 bin）",
          good.returncode == 0 and "PATH=" in good.stdout and "/bin:" in good.stdout,
          good.stdout[:200] + good.stderr[:200])
    check("一定会给出 LD_LIBRARY_PATH（缺 cu12 库时退回到驱动默认目录）",
          "LD_LIBRARY_PATH=" in good.stdout and len(good.stdout.strip().splitlines()) >= 2,
          good.stdout[:200])
    check("诊断信息走 stderr（stdout 只有环境变量，方便重定向成文件）",
          "环境目录" in good.stderr and "环境目录" not in good.stdout,
          good.stderr[:200])

    out_file = probe_dir / "asr.env"
    written = run_env_file(fake_env, "--python", sys.executable, "--out", out_file)
    check("--out 写出的文件内容与打印内容一致",
          written.returncode == 0 and out_file.read_text(encoding="utf-8") == good.stdout,
          f"returncode={written.returncode}")
    with_hf = run_env_file(fake_env, "--python", sys.executable, "--hf-home", fake_env)
    check("--hf-home 会写进 HF_HOME（模型缓存别落在默认家目录）",
          with_hf.returncode == 0 and f"HF_HOME={fake_env}" in with_hf.stdout,
          with_hf.stdout[:200])

    missing = run_env_file(probe_dir / "__no_such_env__")
    check("环境目录不存在 → 退出码 1 且说清怎么办",
          missing.returncode == 1 and "找不到环境目录" in missing.stderr, missing.stderr[:200])

    no_python = probe_dir / "fake-dir-without-python"
    no_python.mkdir(exist_ok=True)
    plain = run_env_file(no_python)
    check("目录在但缺 bin/python → 明确指出这不是 venv/conda 环境",
          plain.returncode == 1 and "不是 venv/conda 环境" in plain.stderr, plain.stderr[:200])

    broken = run_env_file(fake_env, "--python", probe_dir / "__no_such_python__")
    check("解释器跑不起来 → 退出码 1（不静默生成一份错的环境文件）",
          broken.returncode == 1 and "跑不起来" in broken.stderr, broken.stderr[:200])

    out_file.unlink(missing_ok=True)

    # ── GPU 精度档位（Pascal 没有 FP16 加速）────────────────────────────────
    # 这条是被真实环境逼出来的：Tesla P40（算力 6.1）上 ctranslate2 不提供
    # float16，而我们的缺省值就是 float16 —— 用户的 24 GB 卡"照文档抄"起不来。
    heading("GPU 精度档位（Pascal 没有 FP16 加速）")
    import ctranslate2

    check_asr_env = importlib.util.spec_from_file_location(
        "check_asr_env", ROOT / "scripts" / "check-asr-env.py")
    env_module = importlib.util.module_from_spec(check_asr_env)
    check_asr_env.loader.exec_module(env_module)

    check("算力 6.1 → Pascal，且判定为「没有 FP16 加速」",
          env_module.arch_of("6.1") == "Pascal"
          and env_module.has_fp16_acceleration("6.1") is False)
    check("算力 8.6 → Ampere，有 FP16 加速",
          env_module.arch_of("8.6") == "Ampere"
          and env_module.has_fp16_acceleration("8.6") is True)
    check("算力认不出来时不硬下结论（返回 None 而不是 False）",
          env_module.has_fp16_acceleration("") is None
          and env_module.arch_of("99.9") == "")

    pascal_supported = ["int8", "int16", "float32", "int8_float32"]
    ada_supported = ["bfloat16", "float16", "float32", "int8", "int8_float16", "int8_float32"]
    check("P40 这类卡自动选 int8_float32（不是照抄文档里的 float16）",
          env_module.pick_compute_candidates(pascal_supported) == ["int8_float32", "int8"],
          env_module.pick_compute_candidates(pascal_supported))
    check("有 FP16 的卡仍然先测 float16（别为了 Pascal 把常见卡拖慢）",
          env_module.pick_compute_candidates(ada_supported) == ["float16", "int8_float16"],
          env_module.pick_compute_candidates(ada_supported))
    check("拿不到支持列表时按请求原样去试（让 ctranslate2 自己报错，不假装知道）",
          env_module.pick_compute_candidates([], ["float16", "int8_float16"]) == ["float16", "int8_float16"])
    check("显式要求了不支持的档位 → 退回能跑的，而不是直接放弃",
          env_module.pick_compute_candidates(pascal_supported, ["float16"]) == ["int8_float32", "int8"])
    check("推荐档位：Pascal 推 int8_float32，Ada 推 float16",
          env_module.recommend_compute(pascal_supported) == "int8_float32"
          and env_module.recommend_compute(ada_supported) == "float16")
    check("什么精度都查不到时返回空串（上层据此只说「查不到」）",
          env_module.recommend_compute([]) == "")

    # 识别端自己也要能兜住：把"支持的精度"打桩成 P40 的样子，看会不会自动改档
    original_supported = ctranslate2.get_supported_compute_types
    try:
        ctranslate2.get_supported_compute_types = lambda device="cuda": set(pascal_supported)
        effective, note = whisper_stream.resolve_compute_type("float16", "cuda")
        check("识别进程收到这台卡不支持的 float16 → 自动改用 int8_float32 并说清楚",
              effective == "int8_float32" and "不支持 float16" in note,
              f"{effective} / {note}")
        kept, kept_note = whisper_stream.resolve_compute_type("int8_float32", "cuda")
        check("本来就能跑的档位原样保留、不产生多余告警",
              kept == "int8_float32" and kept_note == "", f"{kept} / {kept_note}")
    finally:
        ctranslate2.get_supported_compute_types = original_supported
    check("CPU 上不查表（CPU 的档位与显卡无关）",
          whisper_stream.resolve_compute_type("float16", "cpu") == ("float16", ""))

    # ── 模型下载与环境自检的"报错翻译"────────────────────────────────────────
    # 用户在服务器上第一次跑时遇到的是：
    #   '[SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of protocol'
    #   .../xet-read-token/...
    # 这不是环境坏，是模型下不下来（镜像站不转 Xet 接口）。把处置直接摆在屏幕上，
    # 否则用户会去反复重装 ctranslate2 —— 修错地方。
    heading("模型下载（fetch-model.py）与报错翻译")
    fetch_spec = importlib.util.spec_from_file_location(
        "fetch_model", ROOT / "scripts" / "fetch-model.py")
    fetch_module = importlib.util.module_from_spec(fetch_spec)
    fetch_spec.loader.exec_module(fetch_module)

    check("模型短名 → Systran/faster-whisper-<名字>",
          fetch_module.repo_of("large-v3") == "Systran/faster-whisper-large-v3")
    check("已经是 组织/仓库 的原样返回（不重复拼）",
          fetch_module.repo_of("Systran/faster-whisper-medium") == "Systran/faster-whisper-medium")
    check("空模型名报错（而不是拼出一个 Systran/faster-whisper- 去下）",
          _raises(lambda: fetch_module.repo_of("  ")))
    check("字节数说成人话：3 GiB → 3.0 GB",
          fetch_module.human_size(3 * 1024 ** 3) == "3.0 GB",
          fetch_module.human_size(3 * 1024 ** 3))
    check("0 字节显示 0 B（不显示 0.0 B）", fetch_module.human_size(0) == "0 B")

    ssl_advice = " ".join(env_module.diagnose_load_error(
        "'[SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of protocol' "
        "thrown while requesting GET https://huggingface.co/api/models/.../xet-read-token/abc"))
    check("SSL/xet 报错 → 指向镜像与 HF_HUB_DISABLE_XET（而不是让人去重装 ctranslate2）",
          "HF_ENDPOINT" in ssl_advice and "HF_HUB_DISABLE_XET" in ssl_advice, ssl_advice[:200])
    kernel_advice = " ".join(env_module.diagnose_load_error(
        "CUDA error: no kernel image is available for execution on the device"))
    check("no kernel image → 指向 ctranslate2 版本，并明说与驱动/cu12 库无关",
          "ctranslate2" in kernel_advice and "无关" in kernel_advice, kernel_advice[:200])
    check("401 → 指向 HF_TOKEN",
          "HF_TOKEN" in " ".join(env_module.diagnose_load_error("401 Client Error: Unauthorized")))
    check("显存不够 → 指向换小模型/低精度档",
          "显存" in " ".join(env_module.diagnose_load_error(
              "CUDA failed with error out of memory")))
    check("认不出的报错不硬编建议（返回空列表，别乱指挥）",
          env_module.diagnose_load_error("something totally unexpected") == [])

    # 自检给的是"export LD_LIBRARY_PATH=..."整行，抄错一个目录就白折腾：
    # cuBLAS 与 cuDNN 在不同目录，只给前者会报 cudnn 缺库。
    lib_root = probe_dir / "libs"
    cublas_dir = lib_root / "nvidia" / "cublas" / "lib"
    cudnn_dir = lib_root / "nvidia" / "cudnn" / "lib"
    joined = env_module.join_lib_dirs([
        str(cudnn_dir / "libcudnn.so.9"),
        str(cublas_dir / "libcublas.so.12"),
        str(cublas_dir / "libcublasLt.so.12"),      # 同一目录下的第二个库不应重复出现
    ])
    expected_joined = ":".join(sorted([str(cublas_dir), str(cudnn_dir)]))
    check("LD_LIBRARY_PATH 建议把 cuBLAS 与 cuDNN 的目录都凑齐（且去重）",
          joined == expected_joined, f"{joined} != {expected_joined}")
    check("一个库都没找到时给空串（不产出「:」这种半截路径）",
          env_module.join_lib_dirs([]) == "" and env_module.join_lib_dirs(None) == "")

    # ── 连通性自检（scripts/check-relay.py）────────────────────────────────
    # 接不上服务器时，不同原因在手机上长得一模一样（"连不上"）。
    # 这个脚本的价值全在"哪一步断了 + 下一步做什么"，所以断言钉的是分类与地址规整。
    heading("连通性自检（check-relay.py）")
    relay_spec = importlib.util.spec_from_file_location(
        "check_relay", ROOT / "scripts" / "check-relay.py")
    relay_module = importlib.util.module_from_spec(relay_spec)
    relay_spec.loader.exec_module(relay_module)

    check("随手写的地址补成 http://（局域网最常见的手误）",
          relay_module.normalize_base_url("192.168.1.5:8788") == "http://192.168.1.5:8788")
    check("末尾斜杠去掉（否则拼出来是 //hello）",
          relay_module.normalize_base_url("http://10.0.0.2:8788/") == "http://10.0.0.2:8788")
    check("https 与默认端口保留",
          relay_module.normalize_base_url("https://translate.example.com/") == "https://translate.example.com")
    check("空地址 / 不支持的协议要报错（而不是拼出个怪 URL 去连）",
          _raises(lambda: relay_module.normalize_base_url("  "))
          and _raises(lambda: relay_module.normalize_base_url("ftp://x")))

    refused = " ".join(relay_module.classify_failure("[WinError 10061] 由于目标计算机积极拒绝"))
    check("连接被拒 → 指向“服务没起 / 端口不对 / 只听 127.0.0.1”",
          "没在这个端口上监听" in refused and "--public" in refused, refused[:160])
    check("超时 → 指向防火墙/安全组/端口转发（而不是让人去重装依赖）",
          "防火墙" in " ".join(relay_module.classify_failure("timed out")))
    check("401 → 明确说“连上了但密钥不对”（这条最容易被误判成连不上）",
          "密钥不对" in " ".join(relay_module.classify_failure("HTTP 401 unauthorized")))
    check("认不出的失败不给胡说八道的建议",
          relay_module.classify_failure("weird failure") == [])
    check("密钥文件不存在时返回空串（由调用方提示，不抛异常）",
          relay_module.read_secret_file(ROOT / "var" / "tmp" / "__no_secret__.txt") == "")

    # --say 要能可靠地从 /frame 的响应里判断"译文到没到"
    frame = relay_module.frame_of({"ok": True, "changed": True, "seq": 3,
                                   "frame": {"source": "这是一条测试信息",
                                             "text": "Esta é uma mensagem de teste",
                                             "partial": False}})
    check("能从 /frame 里取出原文与译文",
          frame is not None and frame["source"] == "这是一条测试信息"
          and frame["text"] == "Esta é uma mensagem de teste" and frame["partial"] is False,
          str(frame))
    check("增量帧被标出来（half-sentence 与定稿在眼镜上显示不同）",
          relay_module.frame_of({"frame": {"text": "Esta", "partial": True}})["partial"] is True)
    check("没有帧时返回 None（不能把 None 当成'空译文'去等）",
          relay_module.frame_of({"ok": True, "changed": False, "frame": None}) is None
          and relay_module.frame_of({}) is None
          and relay_module.frame_of({"frame": "不是对象"}) is None)

    # ── 结果 ────────────────────────────────────────────────────────────────
    # ── 每句话自带语种（--format json，4.37）────────────────────────────────
    #
    # 语种不再由命令行固定（--from/--to 已删除），它**只能**由识别侧随句子写出去。
    # 写丢了，插件就退回"自己猜语种" —— 猜错会让整句安静地译成另一种语言
    # （实测词错率 100%），比报错更危险。所以这条要钉住。
    heading("每句话自带语种：--format json 写出 {text, from}")

    def _capture_emit(format_name, text, language):
        captured = []

        class _Capture:
            # emit() 里是 print(..., flush=True)：替身必须也有 flush，否则测的是替身的脾气
            def write(self, chunk):
                captured.append(chunk)

            def flush(self):
                pass

        old_stdout, old_format = sys.stdout, whisper_stream.EMIT_FORMAT
        try:
            sys.stdout = _Capture()
            whisper_stream.EMIT_FORMAT = format_name
            emit(text, language)
        finally:
            sys.stdout, whisper_stream.EMIT_FORMAT = old_stdout, old_format
        return captured

    plain = _capture_emit("text", "纯文本一句", "zh")
    check("text 格式只输出原文", plain and plain[0].strip() == "纯文本一句", str(plain))

    zh_line = whisper_stream.json.loads(_capture_emit("json", "中文一句", "zh")[0])
    check("中文句带 from=zh-CN", zh_line == {"text": "中文一句", "from": "zh-CN"}, str(zh_line))

    pt_line = whisper_stream.json.loads(_capture_emit("json", "葡语一句", "pt")[0])
    check("葡语句带 from=pt-BR", pt_line == {"text": "葡语一句", "from": "pt-BR"}, str(pt_line))

    unknown = whisper_stream.json.loads(_capture_emit("json", "语种未知", None)[0])
    check("语种未知时不硬编 from（让插件自己判）", unknown == {"text": "语种未知"}, str(unknown))

    other = whisper_stream.json.loads(_capture_emit("json", "hello", "en")[0])
    check("表外语种也不硬编 from", other == {"text": "hello"}, str(other))

    check("空白句不产生任何行", _capture_emit("json", "   ", "zh") == [])

    check("--format 缺省 text（老管线不受影响）",
          parse_args(["--follow", "x.pcm"]).format == "text")
    check("--format json 可用", parse_args(["--follow", "x.pcm", "--format", "json"]).format == "json")


    print(f"\n=== 结果：{passed} 通过 / {len(failures)} 失败 ===")
    if failures:
        print("")
        for where, label, detail in failures:
            print(f"失败 [{where}] {label}" + (f"\n  {detail}" if detail else ""))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
