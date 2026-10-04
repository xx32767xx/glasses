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
import os
import subprocess
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "bridge"))

from whisper_stream import (   # noqa: E402
    LANGUAGE_PROMPTS, PcmFollower, SPEECH_RMS_FLOOR, UtteranceSegmenter,
    decide_no_speech, looks_like_hallucination, looks_like_prompt_echo,
    normalize_peak, parse_args, prompt_for, rms_of, whisper_language_of,
)
from whisper_transcribe import TARGET_RATE, load_audio                    # noqa: E402
from asr_eval import (   # noqa: E402
    count_traditional, detect_unit, error_rate, looks_chinese,
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
                  short_utterance_ms=800, short_silence_ms=1100):
    segmenter = UtteranceSegmenter(
        TARGET_RATE, 100, silence_ms, min_speech_ms, max_speech_ms,
        rms_threshold, preroll_ms, np,
        adaptive=adaptive,
        short_utterance_ms=short_utterance_ms, short_silence_ms=short_silence_ms,
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

    # 语种标记 → Whisper 码。手机说的是 pt-BR / zh-CN，Whisper 要的是 pt / zh；
    # 认不出来时要返回 None（让 Whisper 自己判），而不是猜一个错的语种。
    heading("语种标记转换 · whisper_language_of")
    check("pt-BR → pt", whisper_language_of("pt-BR") == "pt", str(whisper_language_of("pt-BR")))
    check("zh-CN → zh", whisper_language_of("zh-CN") == "zh", str(whisper_language_of("zh-CN")))
    check("大小写与空白都能忍", whisper_language_of("  PT-br ") == "pt", str(whisper_language_of("  PT-br ")))
    check("认不出来返回 None（交给 Whisper 自动判定，不瞎猜）",
          whisper_language_of("klingon") is None, str(whisper_language_of("klingon")))
    check("None / 空值不炸", whisper_language_of(None) is None and whisper_language_of("") is None)

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

    # 提示词：一波三折之后**默认开着** —— 因为回显那道闸已经能挡住唯一的坏处，
    # 而基准显示它确实提准确率（medium 7.4%→5.9%，疑似繁体 8 字→1 字）。
    check("中文提示词要求普通话 + 简体（压掉繁体输出）",
          "简体" in (prompt_for("zh", None) or "") and "普通话" in (prompt_for("zh", None) or ""),
          str(prompt_for("zh", None)))
    check("葡语提示词是巴葡口吻", "Brasil" in (prompt_for("pt", None) or ""), str(prompt_for("pt", None)))
    check("认不出语种就不发提示词（别硬塞一个错的）",
          prompt_for("xx", None) is None, str(prompt_for("xx", None)))
    check("显式给的提示词优先", prompt_for("zh", "自定义") == "自定义")
    check("缺省会发提示词（不是 None）", prompt_for("zh", args.initial_prompt) is not None)
    check("--no-prompt 能关掉它",
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

    check("缺省用束搜索 beam=5（基准实测：7.4% vs beam1 的 9.2%）",
          args.beam_size == 5, str(args.beam_size))
    check("缺省做峰值归一化", args.no_normalize is False, str(args.no_normalize))
    check("缺省丢弃 <500ms 的碎片（碎片只会变成胡话）",
          args.min_speech_ms == 500, str(args.min_speech_ms))
    check("缺省开启短句保护，但阈值克制（不把相邻两句合起来）",
          args.short_utterance_ms == 800 and args.short_silence_ms == 1100,
          f"{args.short_utterance_ms}/{args.short_silence_ms}")

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

    check("CER：完全正确 = 0",
          error_rate("这是一条测试信息", "这是一条测试信息", "char")[0] == 0.0)
    rate, units, distance = error_rate("这是一条测试信息", "这是一条测试消息", "char")
    check("CER：错一个字 = 1/8",
          abs(rate - 0.125) < 1e-9 and units == 8 and distance == 1,
          f"rate={rate} units={units} distance={distance}")
    rate_trad, _, distance_trad = error_rate("这是一条测试信息", "這是一條測試信息", "char")
    check("CER：整句输出成繁体 = 0.5（4 个字不同）",
          abs(rate_trad - 0.5) < 1e-9 and distance_trad == 4,
          f"rate={rate_trad} distance={distance_trad}")
    check("按字算时忽略标点与空格（中文的空白没有语义）",
          error_rate("这是一条测试信息。", "这 是 一 条 测 试 信 息", "char")[0] == 0.0,
          str(error_rate("这是一条测试信息。", "这 是 一 条 测 试 信 息", "char")))

    check("疑似繁体计数：繁体句 > 0，简体句 = 0",
          count_traditional("這是一條測試信息") > 0 and count_traditional("这是一条测试信息") == 0,
          f"{count_traditional('這是一條測試信息')} / {count_traditional('这是一条测试信息')}")
    check("葡语重音不被当成繁体字（那是两回事）",
          count_traditional("A reunião é às três") == 0)

    # ── 结果 ────────────────────────────────────────────────────────────────
    print(f"\n=== 结果：{passed} 通过 / {len(failures)} 失败 ===")
    if failures:
        print("")
        for where, label, detail in failures:
            print(f"失败 [{where}] {label}" + (f"\n  {detail}" if detail else ""))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
