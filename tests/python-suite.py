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
"""

import sys
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "bridge"))

from whisper_stream import PcmFollower, UtteranceSegmenter, looks_like_hallucination   # noqa: E402
from whisper_transcribe import TARGET_RATE, load_audio                    # noqa: E402

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
                  min_speech_ms=300, silence_ms=700, preroll_ms=250):
    segmenter = UtteranceSegmenter(
        TARGET_RATE, 100, silence_ms, min_speech_ms, max_speech_ms,
        rms_threshold, preroll_ms, np,
        adaptive=adaptive,
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

    # ── 结果 ────────────────────────────────────────────────────────────────
    print(f"\n=== 结果：{passed} 通过 / {len(failures)} 失败 ===")
    if failures:
        print("")
        for where, label, detail in failures:
            print(f"失败 [{where}] {label}" + (f"\n  {detail}" if detail else ""))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
