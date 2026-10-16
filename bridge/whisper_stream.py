#!/usr/bin/env python3
"""
whisper_stream.py —— 用 faster-whisper 把音频流实时转写成逐行文本
========================================================================================
它的 stdout 每一行是一句识别结果，交给 bridge/asr-bridge.mjs 转发到
leion-pro 的 ASR 收件箱：

    python bridge/whisper_stream.py --language pt | node bridge/asr-bridge.mjs --inbox <收件箱>
    node bridge/asr-bridge.mjs --inbox <收件箱> --engine whisper --from pt-BR

依赖
    pip install faster-whisper numpy
    python bridge/whisper_stream.py --self-check     # 只检查依赖与模型能否加载

用法
    python bridge/whisper_stream.py                          # 麦克风，自动判语种
    python bridge/whisper_stream.py --language pt            # 固定语种（更准更快，同传应该固定）
    python bridge/whisper_stream.py --file x.wav             # 转写文件（不需要麦克风）
    python bridge/whisper_stream.py --follow <裸PCM文件>      # 尾随手机上传的音频（见下）

⚠️ 接管道时**千万不要**写 `2>&1`
    这个脚本的 stdout 是"识别结果"，stderr 是"日志/进度/报错"。管道下游的
    bridge/asr-bridge.mjs 会把 stdin 的每一行都当成一句话写进收件箱。
    一旦把 stderr 也合进管道（`python ... 2>&1 | node ...`），日志和报错就会被
    当成"对方说的话"送进同传链路 —— 眼镜上会出现"缺少 sounddevice"这种字幕。
    这个坑真的踩到过（就是 --follow 那次）。正确写法是不写重定向：

        python bridge/whisper_stream.py --follow var/live/audio-in.pcm --language pt |
          node bridge/asr-bridge.mjs --inbox var/live/asr-inbox.jsonl --from pt-BR

手机端「录音上传」那条路（--follow）
    手机把麦克风音频按块 POST 给 relay，relay 追加写进一个裸 PCM 文件，
    这个脚本尾随该文件做切句与识别。所以"录音"和"识别"可以分在两台机器上：
        手机（录音）→ relay（落盘）→ 本脚本（识别）→ 桥（写收件箱）→ leion-pro（翻译）

    python bridge/whisper_stream.py --file x.wav --realtime  # 按真实时间喂音频，测"真实延迟"
    python bridge/whisper_stream.py --file x.wav --stats     # 只跑一遍并打印统计

设计取舍
    · 用「静音切分」而不是流式解码：同传要的是**整句**，半句翻出去毫无意义，而
      faster-whisper 对短片段的效果差。所以按 RMS 能量切出语音段，每段整句识别。
    · 每识别出一句就 print + flush，绝不缓冲多句 —— 延迟就是同传的命。
    · 句子边界是「静音超过 N 毫秒」，也就是 asr-bridge 那边 --flush-on-pause-ms 的
      物理对应物，区别只是这里的判断更可靠（有音频能量信息）。

⚠️ 关于"延迟"这个数
    同传的真实延迟 ≈ **这一句话要攒多久成为一段** + 静音判定时长(silence_ms)
    + 识别耗时 + 翻译耗时。
    静音判定那段是**等出来的**：你必须等对方停下来才知道一句说完了。
    ⚠️ 第一项（段本身有多长）曾经被漏掉：字幕是**整段**识别完才发的，
    所以从用户说出这段的第一个字到字幕出现，还要加上段内位置。
    `--stats` 现在把「平均段长」和三项相加的估算一起报出来（见 Stats.report）。

⚠️ 关于 Whisper 在静音上"编话"
    Whisper 遇到噪声或静音会凭空调出训练数据里的高频句（中文常见"请不吝点赞订阅"
    这类，葡语常见字幕组署名）。所以这里加了两道闸：能量门槛 + no_speech_prob 门槛，
    另外还有 avg_logprob 门槛。三个阈值都可以调，见 --no-speech-prob / --min-logprob。
"""

import argparse
import os
import queue
import sys
import time
from pathlib import Path

# ⚠️ 直接跑这个脚本时要指到仓库里的模型缓存：走 scripts/start-all.mjs 时是那边设的，
#    但本文件头部的用法示例都是**手动跑**。没设的话 faster-whisper 会去
#    ~/.cache/huggingface 找模型，然后报一个**和真实原因无关**的 401
#    （"Repository Not Found"）—— 实测踩过。已设过的环境变量不动。
os.environ.setdefault("HF_HOME", str(Path(__file__).resolve().parent.parent
                                     / "var" / "cache" / "hf"))
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

HALLUCINATION_SAMPLES = (
    "请不吝点赞", "订阅", "转发", "打赏", "明镜", "点点栏目",   # 中文常见幻听
    # 下面这条是**实测逮到的**：按真实上传节奏重放用户录音时，
    # 一段几乎没内容的 2.0 秒碎片（电平 0.0359）被识别成「谢谢观看,下次见!」，
    # 而它当时混过了这道闸，直接当字幕发了出去 —— 假字幕比没有字幕糟得多。
    "谢谢观看",
    "amara.org", "legendas", "subtitles by", "subscribe",       # 葡/英常见幻听
)

TARGET_RATE = 16000          # Whisper 内部固定按 16 kHz 工作


def force_utf8_stdio():
    """把 stdout/stderr 强制成 UTF-8。

    ⚠️ 这一步是必须的，不是保险措施。真实事故：
      Windows 中文环境下，Python 往**管道**写东西时用的是本地编码（GBK/cp936），
      而下游的桥（node）按 UTF-8 读 —— 于是识别出来的"你好"变成 3 个替换符 `���`，
      写进收件箱后插件"判不出源语种"，**一句字幕都出不来**。
      而链路每一环看起来都是好的：音频有声音、识别有输出、收件箱有行数。
      字节层面能对上：`你好` 的 GBK 是 4 字节（C4 E3 BA C3），按 UTF-8 解正好是 3 个坏字节。

    为什么放在脚本里而不是只靠环境变量：
      环境变量（PYTHONUTF8/PYTHONIOENCODING）只有 start-all 会设；
      用户手动起这个脚本时就没了 —— 而这个 bug 恰恰只在手动起的时候出现，
      所以必须让脚本自己扛住。

    为什么在**导入时**就调用（而不是只在 main() 里）：
      编码是整个进程的事，跟"有没有走到 main()"无关。
      只在 main() 里调的话，"忘了调用"这个失败模式就测不出来 —— 实测过：
      把 main() 里那行注释掉，测试照样全绿，因为测试脚本自己调了一次。
      放在导入时，这个失败模式根本不存在。
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            # 不是可重配的文本流（比如被重定向成别的对象）就算了，不该因此起不来
            pass


force_utf8_stdio()      # 导入即生效，见上面"为什么在导入时就调用"


def whisper_language_of(tag):
    """把收件箱/手机用的语种标记转成 Whisper 认的语种码。

    手机说的是 `pt-BR` / `zh-CN`，Whisper 要的是 `pt` / `zh`。
    认不出来就返回 None（交给 Whisper 自己判定，而不是猜一个错的）。
    """
    if not isinstance(tag, str):
        return None
    code = tag.strip().split("-")[0].strip().lower()
    return code if code in WHISPER_LANG_CODES else None


# 这个系统可能出现的语种码（与 relay 的 LANGS、桥接的校验保持一致）。
# 用来校验 `--lang-candidates`，免得写错了变成"限定悄悄失效"。
WHISPER_LANG_CODES = ("pt", "zh", "en", "es")


def parse_lang_candidates(raw):
    """把 `--lang-candidates zh,pt` 解析成元组；空串 = None（不限定）。

    为什么抽成函数、而不是留在 parse_args 里：
      **产线（whisper_stream）与评测（asr_eval）都要用同一个语义**。
      评测那边原来直接把原始字符串拿去用 —— `code in "zh,pt"` 是**子串**匹配，
      provenance 里还记成 `list("zh,pt")` = ['z','h',',','p','t']。
      两处一旦不一致，"评测口径 = 产线口径"就成了一句空话，而这些数字能不能
      代表产线，全部押在这句话上。

    写错语种码**必须报错**，不能静默变成空集：空集会让限定失效，
    退回"99 种语言里挑最大"，而那正是会挑出 he 的旧行为（实测踩过）。
    """
    raw = (raw or "").strip()
    if raw == "":
        return None
    codes = [part.strip().lower() for part in raw.split(",") if part.strip() != ""]
    unknown = [code for code in codes if code not in WHISPER_LANG_CODES]
    if unknown:
        raise ValueError(f"--lang-candidates 里有认不出的语种码：{unknown}"
                         f"（可用：{', '.join(sorted(WHISPER_LANG_CODES))}）")
    return tuple(dict.fromkeys(codes))                   # 去重且保持顺序


# ── 参数 ─────────────────────────────────────────────────────────────────────

def parse_args(argv=None):
    """argv 可传（缺省读 sys.argv）—— 仓库里别的工具（asr-bridge / start-all）都是这个形状，
    这样测试才能直接断言"缺省值到底是什么"，而不是靠人去读一遍源码。"""
    parser = argparse.ArgumentParser(description="faster-whisper 实时转写，逐行输出")
    parser.add_argument("--model", default="small", help="模型大小：tiny/base/small/medium/large-v3（缺省 small）")
    parser.add_argument("--device", default="cpu", help="cpu 或 cuda（本机实测两者都能跑，见 --stats）")
    parser.add_argument("--compute-type", default="int8",
                        help="int8 / int8_float16 / float16 / float32（CPU 用 int8，GPU 用 float16）")
    parser.add_argument("--language", default=None, help="固定语种（zh / pt）；缺省自动判定")
    # 限定候选语种：不指定 `--language` 时，只在候选里挑，而不是在 99 种语言里挑。
    #
    # 实测依据（pt-coraa 20 条真实巴葡口语，large-v3）：
    #   不限定 → 判定 {pt:19, he:1}，词错率 13.3%，那条被认成希伯来语的整句报废（100%）
    #   限定   → 只会是 pt 或 zh，整体 12.2%
    # 这个系统只可能是中文与巴葡，所以"在 99 种里挑"是纯亏的自由度。
    # 传空串（`--lang-candidates ""`）可以关掉限定，回到"全域挑最大"。
    parser.add_argument("--lang-candidates", default="zh,pt",
                        help="不指定语种时的候选集（逗号分隔，缺省 zh,pt；空串=不限定）")
    parser.add_argument("--file", default=None, help="转写一个音频文件而不是麦克风")
    parser.add_argument("--follow", default=None,
                        help="尾随一个**不断追加**的裸 PCM 文件（16-bit 小端、单声道）。"
                             "手机端「录音上传」走的就是这条：relay 往文件追加，这里跟着读")
    parser.add_argument("--follow-rate", default=None,
                        help="尾随文件的采样率旁文件（缺省 <--follow>.rate）。"
                             "手机可能降级到 44.1 kHz 录音，读它才知道要不要重采样")
    parser.add_argument("--idle-flush-ms", type=int, default=2000,
                        help="尾随时，多久没读到新音频就把已在缓冲里的半句交出去（缺省 2000）。"
                             "**必须明显大于手机的上传间隔**（实测约 1 秒一块）："
                             "原来的判据只有 400ms 且往切句器里塞数字零，"
                             "结果正常上传时反复误判成「说话人停了」，按上传节奏把句子切开 —— "
                             "切出来的 1 秒碎片正是 Whisper 最爱出幻觉的长度（见 IdleTracker）")
    parser.add_argument("--follow-poll-ms", type=int, default=80,
                        help="尾随时检查新数据的间隔（缺省 80ms）")
    parser.add_argument("--follow-from-start", action="store_true",
                        help="尾随时从文件开头读（缺省从末尾开始，这样不会把上次的录音重放一遍）")
    parser.add_argument("--stop-after-idle", type=float, default=None,
                        help="尾随模式下，连续多少秒没有新音频就收尾退出（缺省不退出）。"
                             "手机停止录音后用它自动结束；测试也靠它自动收敛")
    parser.add_argument("--no-sidecar-lang", action="store_true",
                        help="不听手机发来的语种（audio-in.lang），一律用 --language。"
                             "尾随时**缺省听手机的** —— 手机上切「听葡语/听中文」要能生效。"
                             "但如果你在同一个数据目录上跑离线测试，那里可能留着上一次"
                             "手机用过的语种，这时用这个开关强制用命令行的值")
    parser.add_argument("--realtime", action="store_true",
                        help="文件模式按真实时间喂块（不加速），用来测真实延迟")
    parser.add_argument("--stats", action="store_true", help="退出时打印统计（延迟、RTF）")
    parser.add_argument("--samplerate", type=int, default=16000, help="采样率（Whisper 要 16000）")
    parser.add_argument("--block-ms", type=int, default=100, help="每次读取的音频块长度")
    parser.add_argument("--silence-ms", type=int, default=800,
                        help="静音超过这么久就认为一句话结束（缺省 800）。"
                             "⚠️ 这个数**改过几次**，每次都有实测支撑，理由不同："
                             "① 起初 700：读到「句间停顿 500ms 时判 1000ms → 错字率 27.0%%」就调快，"
                             "于是改成 500（那是**朗读**语料 + 合成停顿的测法）。"
                             "② 2025 又用**真实口语**重量了一遍（带官方逐句时间戳的原始录音，"
                             "取 20 个连续段，同一个参考、同一套切句器做受控对照）："
                             "silence 500 → 16.8%%，800 → 15.5%%，1200 → 13.3%%，2000 → 12.2%%。"
                             "机制是：段太碎时 min_speech_ms 会**丢弃**一些碎片（500ms 那档只覆盖了 "
                             "79.1%% 的音频，800 档 82.8%%，1200 档 88.9%%），而且缺上文的短段更容易听错。"
                             "⚠️ **缺省取 800 而不是最准的 1200，是产品取舍**：越准就越晚，"
                             "而「晚」这件事以前被算漏过一次 —— 字幕是**整段**识别完才发的，"
                             "所以从这一句话开头到字幕出现，要加上**这一段本身有多长**："
                             "500 档平均 2.7 秒、800 档 3.8 秒、1200 档 **6.2 秒**（P95 11.8 秒）。"
                             "800 是「拿一半延迟换一半准确率」的折中档；"
                             "要更准用 1200，要和以前完全一样用 500。完整数据见 docs/14 §6.7 / docs/06 §3.2")
    parser.add_argument("--min-speech-ms", type=int, default=500,
                        help="短于这么久的语音段丢弃（多半是噪声/气声）。缺省 500 —— "
                             "实测 0.03~0.27 秒的碎片送进识别只会产出胡话（「你以後」这种）")
    parser.add_argument("--max-speech-ms", type=int, default=30000,
                        help="单句最长时长，超过就强制断句（防止一直不说停）。"
                             "断句点会优先选内部停顿（见 --cut-pause-ms），"
                             "找不到停顿才在这个长度上硬切。"
                             "缺省 30000 是跟着 `--silence-ms` 一起定的：静音判定放宽以后，"
                             "一段里会装进更多话，上限留在 15000 会把长段**硬切**掉，"
                             "那量到的就不是「少切一点」而是「被截断」（实测口径见 docs/14 §6.7.1）")
    parser.add_argument("--cut-pause-ms", type=int, default=200,
                        help="强制断句时，至少要找到这么长的内部停顿才肯切（缺省 200）。"
                             "设成很大（比如 5000）就退化成「到上限硬切」的旧行为")
    parser.add_argument("--short-utterance-ms", type=int, default=800,
                        help="短句保护：还没攒够这么久的语音，要等更长的静音才收句（缺省 800）。"
                             "正常说话词间就有 300~500ms 停顿，固定 700ms 会把一句话切成两半，"
                             "而短片段（<1 秒）的识别质量急剧下降。实测调这个值要注意："
                             "调到 1200 会把「说完一句、停 1 秒、再说一句」合并成一段"
                             "（字幕更慢更少），所以缺省只保护接近下限的碎片")
    parser.add_argument("--short-silence-ms", type=int, default=1100,
                        help="配合上一项：短句需要多长的静音才收句（缺省 1100）")
    parser.add_argument("--beam-size", type=int, default=5,
                        help="1=贪心（快） / 5=束搜索（准，缺省）。GPU 上实测很便宜"
                             "（14.7 秒音频 small 只要 0.35~0.56 秒），准确率差别明显")
    parser.add_argument("--no-normalize", action="store_true",
                        help="不做峰值归一化。缺省**做** —— 手机远距离录音电平偏低，"
                             "实测归一化能把「测试语音」纠正成「这是一条测试语音」")
    parser.add_argument("--initial-prompt", default=None,
                        help="给模型的提示词（引导语种/字形）。缺省按语种自动选："
                             "中文「以下是普通话的句子，请用简体中文输出。」（压掉繁体输出）；"
                             "葡语一句巴葡引子。**实测有用**：中文基准上 medium 的 CER "
                             "从 7.4%% 降到 5.9%%、疑似繁体 8 字降到 1 字。"
                             "副作用是短片段上会被模型回显成一句假字幕，那个由回显过滤挡住")
    parser.add_argument("--no-prompt", action="store_true",
                        help="不发提示词（想看纯模型输出、或怀疑提示词在捣乱时用）")
    parser.add_argument("--context-depth", type=int, default=2,
                        help="**上下文续传**：把前 N 段已定稿的文本喂给下一段当提示词"
                             "（0 = 关；缺省 2 = 前两段）。"
                             "实测（同一段口语录音的 20 个连续段）：逐段独立 16.8%% → "
                             "前两段续传 15.1%%，**零额外等待**（不多听一秒音频）；"
                             "再配合 --silence-ms 1200 一起用是 12.0%%。"
                             "副作用（模型复读上文）由 looks_like_context_echo 挡住")
    parser.add_argument("--context-gap-s", type=float, default=60.0,
                        help="上下文续传的时间窗：距上一段定稿超过这么多秒就清空（缺省 60）。"
                             "⚠️ 这个数是**保守选择，不是测出来的最优值**，两个理由："
                             "① 实测条件是「同一段连续发言」（句间 ≤2 秒），"
                             "隔了几分钟的上一句不属于同一段上文；"
                             "② 窗口必须**明显长于一段本身**（--max-speech-ms 可以到 30 秒），"
                             "否则连续说话时长段也会被误清 —— 那会让这个功能在最需要它的"
                             "长段上悄悄失效。真正的长时间静默会自然超过 60 秒")
    parser.add_argument("--rms-threshold", type=float, default=0.01, help="判定「有语音」的能量阈值（配合 --no-adaptive 使用）")
    parser.add_argument("--adaptive", dest="adaptive", action="store_true", default=True,
                        help="自动估计环境噪声并据此定阈值（缺省开）")
    parser.add_argument("--no-adaptive", dest="adaptive", action="store_false",
                        help="关掉自适应，固定用 --rms-threshold")
    parser.add_argument("--rms-floor", type=float, default=0.004,
                        help="自适应阈值的最低值，防止静音房把阈值压到 0（缺省 0.004）")
    parser.add_argument("--noise-multiplier", type=float, default=4.0,
                        help="阈值 = 噪声底 × 这个倍数（缺省 4.0）")
    parser.add_argument("--no-warmup", action="store_true",
                        help="跳过预热。首次推理在 CUDA 上要十几秒（见文档），生产环境必须预热")
    parser.add_argument("--preroll-ms", type=int, default=250,
                        help="把语音起点之前这么久的音频也带上（避免削掉开头的气声/辅音）")
    parser.add_argument("--no-speech-prob", type=float, default=0.60,
                        help="no_speech_prob 高于这个值就丢弃该段（防幻听）")
    parser.add_argument("--min-logprob", type=float, default=-1.00,
                        help="avg_logprob 低于这个值就丢弃该段（太不确定就别显示）")
    parser.add_argument("--self-check", action="store_true", help="只检查依赖与模型能否加载")
    args = parser.parse_args(argv)
    # 把 `--lang-candidates zh,pt` 解析成元组；空串 = 不限定（回到全域挑最大）。
    # 顺带做校验：写错了就**明确报错**，而不是静默变成一个空集（空集会让限定悄悄失效，
    # 而"护栏悄悄失效"正是最难发现的一类问题）。
    try:
        args.lang_candidates = parse_lang_candidates(args.lang_candidates)
    except ValueError as error:
        parser.error(str(error))
    return args


# ── 依赖 ─────────────────────────────────────────────────────────────────────

def load_dependencies(need_audio: bool):
    """按需导入，缺依赖时给出能照着做的错误信息。"""
    try:
        import numpy as np
    except ImportError:
        sys.exit("缺少 numpy：pip install numpy")
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        sys.exit("缺少 faster-whisper：pip install faster-whisper")

    sounddevice = None
    if need_audio:
        try:
            import sounddevice as sd
        except ImportError:
            sys.exit("缺少 sounddevice（麦克风输入需要它）：pip install sounddevice")
        sounddevice = sd
    return np, WhisperModel, sounddevice


# ── 音频分段 ─────────────────────────────────────────────────────────────────

class UtteranceSegmenter:
    """按 RMS 能量把连续音频切成一句一句。

    刻意保持成一个小状态机而不是用 VAD 模型：同传链路里真正的瓶颈是识别与翻译，
    而一个能量阈值 + 静音时长在安静场景已经够用，且零额外依赖。

    两个容易写错的地方，这里是刻意处理过的：
      · 前导缓存（preroll）：如果只从"检测到能量的那一块"开始收，句首的轻声、
        塞音（p/t/k）经常被削掉，转写就会丢字。所以持续保留最近 N 毫秒，
        一旦确认说话，把它拼到最前面。
      · 静音尾巴：句子结束时 buffer 里已经攒了 silence_ms 的静音。这部分照原样
        送去识别会浪费算力、还会诱发幻听，所以在 _take 里裁掉。
    """

    def __init__(self, samplerate, block_ms, silence_ms, min_speech_ms, max_speech_ms,
                 rms_threshold, preroll_ms, np,
                 adaptive=True, rms_floor=0.004, noise_multiplier=4.0,
                 short_utterance_ms=800, short_silence_ms=1100, cut_pause_ms=200):
        self.np = np
        self.block = int(samplerate * block_ms / 1000)
        self.block_ms = block_ms
        self.silence_blocks = max(1, int(round(silence_ms / block_ms)))
        self.min_blocks = max(1, int(round(min_speech_ms / block_ms)))
        self.max_blocks = max(1, int(round(max_speech_ms / block_ms)))
        self.preroll_blocks = max(0, int(round(preroll_ms / block_ms)))
        # "短句保护"：还不到 short_utterance_ms 的片段，要等 short_silence_ms 的静音才收句
        self.short_utterance_blocks = max(1, int(round(short_utterance_ms / block_ms)))
        self.short_silence_blocks = max(1, int(round(short_silence_ms / block_ms)))
        # 到上限强制断句时，至少要找到这么长的内部停顿才肯切（见 _best_inner_pause）
        self.cut_pause_blocks = max(1, int(round(cut_pause_ms / block_ms)))
        self.rms_threshold = rms_threshold
        self.buffer = []
        self.energies = []       # 与 buffer 一一对应的能量（为"按停顿切"服务）
        self.preroll = []
        self.preroll_energies = []
        self.silent_run = 0
        self.speaking = False
        self.voiced = 0          # 本句里"确实超过门槛"的块数（前导缓存不算，见 _take）
        self.cut_count = 0       # 因为到上限而断句的次数（供统计与诊断）

        # ── 自适应门槛 ────────────────────────────────────────────────────────
        # 固定阈值为什么不够用：会议室安静时说话声可能只有 0.008（低于阈值 → 整句丢失），
        # 开着空调的教室噪声底可能就有 0.02（高于阈值 → 永远不认为句子结束）。
        # 所以改成"先量环境噪声，再按倍数定门槛"。
        #
        # ⚠️ 第一版写错过，值得记下来：
        #   最初只在"没在说话"的块上更新噪声底 —— 结果噪声一大（0.01 底噪 ≥ 0.01 阈值），
        #   第一块就被判成"在说话"，于是永远进不了"没在说话"的分支，噪声底永远是"未测出"，
        #   自适应彻底失效，整段 66 秒被并成 5 句（只能在 15 秒的强制断句处出字幕）。
        #   这是典型的先有鸡还是先有蛋：要靠静音来校准门槛，又得靠门槛来认出静音。
        # 修法：不管当前判定是什么，**每块都进统计窗口**，用近 10 秒能量的 10 百分位
        #   当作噪声底。它不依赖"已经正确识别出静音"，所以不会卡死。
        # 再加一道安全阀：门槛不允许高到连说话都算静音（否则会一句话都出不来）。
        self.adaptive = adaptive
        self.rms_floor = rms_floor
        self.noise_multiplier = noise_multiplier
        self.window = []                 # 最近所有块的能量（约 10 秒）
        self.noise_window = 100          # block 缺省 100ms → 100 块 = 10 秒
        self.noise_floor = None
        self.peak = None
        self.threshold = rms_threshold
        self.capped = False

    def _refresh_threshold(self):
        """用最近的能量的低分位数估计噪声底，据此定门槛。每块都调用。"""
        if not self.adaptive:
            self.threshold = self.rms_threshold
            return
        if len(self.window) < 20:        # 不足 2 秒不估，免得用开局的一两个块瞎定
            return
        quiet = float(self.np.percentile(self.window, 10))
        loud = float(self.np.percentile(self.window, 90))
        self.noise_floor = quiet
        self.peak = loud
        wanted = max(self.rms_floor, self.noise_multiplier * quiet)
        # 安全阀：门槛最多只能到"比较响的那一档"的一半，否则会把说话也当静音，
        # 结果是一句话都不切出来 —— 那比切得太碎严重得多。
        cap = max(self.rms_floor * 1.5, 0.5 * loud)
        self.capped = wanted > cap
        self.threshold = min(wanted, cap)

    def gate_report(self):
        if not self.adaptive:
            return f"固定阈值 {self.threshold:.4f}"
        if self.noise_floor is None:
            return f"自适应阈值 {self.threshold:.4f}（还没测出噪声底，先用缺省值）"
        note = "，已触发安全阀" if self.capped else ""
        return (f"自适应阈值 {self.threshold:.4f}"
                f"（噪声底 {self.noise_floor:.4f} × {self.noise_multiplier:g}"
                f"，语音档 {self.peak:.4f}{note}）")

    def push(self, block):
        """送入一块音频，返回本次凑齐的所有整句（通常是 0 或 1 个）。"""
        energy = float(self.np.sqrt(self.np.mean(self.np.square(block)))) if block.size else 0.0
        loud = energy >= self.threshold
        out = []

        if loud:
            if not self.speaking:
                self.speaking = True
                self.buffer = list(self.preroll)     # 补上句首之前的一点音频
                self.energies = list(self.preroll_energies)
                self.preroll = []
                self.preroll_energies = []
                self.voiced = 0
            self.silent_run = 0
            self.voiced += 1
            self.buffer.append(block)
            self.energies.append(energy)
        elif self.speaking:
            self.buffer.append(block)
            self.energies.append(energy)
            self.silent_run += 1
            # 自适应静音判定：**攒得还短的时候，要求更长的静音才收句**。
            # 为什么：正常说话时词与词、短语与短语之间就有 300~500ms 的停顿，
            # 用固定的 700ms 会把「这是一条 / 测试语音」切成交给 Whisper 的两段 ——
            # 而 Whisper 对短片段（<1s）的识别质量急剧下降，实测就是这样出错的
            # （"这是一条测试语音"被切成两段后，第二段被识别成"测试语音"甚至"你以後"）。
            # 所以：已经攒够 short_utterance_blocks 的，按正常静音判定收句；
            # 还没攒够的，多等一会儿，让句子有机会长到能认的时长。
            needed = self.silence_blocks
            if self.voiced < self.short_utterance_blocks:
                needed = max(self.silence_blocks, self.short_silence_blocks)
            if self.silent_run >= needed:
                utterance = self._take()
                if utterance is not None:
                    out.append(utterance)
        else:
            # 没在说话：维护前导缓存
            if self.preroll_blocks > 0:
                self.preroll.append(block)
                self.preroll_energies.append(energy)
                if len(self.preroll) > self.preroll_blocks:
                    self.preroll.pop(0)
                    self.preroll_energies.pop(0)

        # 每块都进统计窗口，再用它校准下一块的判定门槛（见上面关于"鸡生蛋"的说明）
        if self.adaptive:
            self.window.append(energy)
            if len(self.window) > self.noise_window:
                self.window.pop(0)
            self._refresh_threshold()

        # 一直不停口也要断句，否则字幕永远不出来。
        #
        # ⚠️ 这里原来是"直接 _take()"，也就是**在固定位置硬切**。后果实测过：
        #   句子被合并成长段时，断点正好落在第 15 秒那个样本上 —— 说话说到一半
        #   就被切断，两条字幕各拿半句。这正是"长对话被截断"的来源。
        #   （用 asr-eval/segment_eval.py 量出来的：合并片段的最大时长**精确等于**上限 15.0s。）
        # 现在改成：先找 buffer 里**最长的内部停顿**，在那里切；实在找不到停顿
        #   （真的连着说了 15 秒没换气）才退回硬切。
        if self.speaking and len(self.buffer) >= self.max_blocks:
            # 注意不能写成 `self._cut_at_pause() or self._take()` ——
            # 返回的是 numpy 数组，"or" 会去做逐元素布尔判断并抛
            # "truth value of an array is ambiguous"。必须显式判 None。
            utterance = self._cut_at_pause()
            if utterance is None:
                utterance = self._take()
            if utterance is not None:
                out.append(utterance)

        return out

    def _release(self, blocks, voiced):
        """够长就交出去，太短就丢掉（短的多半是噪声/气声，送进去只会出胡话）。"""
        if voiced < self.min_blocks or not blocks:
            return None
        return self.np.concatenate(blocks)

    def _pause_candidates(self):
        """buffer 里所有长度达标的内部停顿：[(起点块号, 长度块数), …]。"""
        candidates = []
        start = None
        for index, energy in enumerate(self.energies):
            if energy < self.threshold:
                if start is None:
                    start = index
            elif start is not None:
                if index - start >= self.cut_pause_blocks:
                    candidates.append((start, index - start))
                start = None
        return candidates

    def _cut_at_pause(self):
        """buffer 攒到上限时，在**内部停顿**处断开，而不是在固定位置硬切。

        返回前半段音频；剩下的留在 buffer 里当下一段的开头。
        找不到合适的停顿就返回 None，让调用方退回硬切。

        为什么值得这么做：停顿是说话人自己给的边界信号。同样是断句，
        切在停顿上和切在"第 15 秒那个样本"上，对下游的意义完全不同 ——
        前者两边都是完整的话，后者两边都是半句。

        ⚠️ 选哪个停顿是有讲究的，第一版选"最长的那个"就出了事故：
           buffer 末尾如果只剩一小截话（比如切开后只剩 0.3 秒），
           后面说话人一停，_take 会因为"不到 min_speech_ms"把这一小截**直接丢掉**
           （这就是它防噪声爆音的机制）。用 12 句中文量出来的后果是
           **31 个字一次都没进过模型** —— 内容无声地消失了，比识别错严重得多。
        所以现在要求：切开后**两头都够长**（前半段 ≥ 短句下限，后半段 ≥ min_speech_ms），
        在这个前提下尽量靠后切（少切一次、字幕更完整）；
        实在没有两头都合格的，就退而选最靠前的（保证后半段最长，不会丢内容）。
        """
        candidates = self._pause_candidates()
        if not candidates:
            return None

        floor = max(self.min_blocks, self.short_utterance_blocks)
        head_voiced = lambda start: sum(1 for e in self.energies[:start]  # noqa: E731
                                        if e >= self.threshold)
        tail_voiced = lambda end: sum(1 for e in self.energies[end:]     # noqa: E731
                                      if e >= self.threshold)

        viable = [item for item in candidates
                  if head_voiced(item[0]) >= floor
                  and tail_voiced(item[0] + item[1]) >= self.min_blocks]
        if viable:
            best_start, best_length = max(viable, key=lambda item: item[0])
        else:
            fallback = [item for item in candidates if head_voiced(item[0]) >= floor]
            if not fallback:
                return None
            best_start, best_length = min(fallback, key=lambda item: item[0])

        head_end = best_start
        tail_start = best_start + best_length
        head = self.buffer[:head_end]

        # ⚠️ 这个计数必须在**切掉 self.energies 之前**算完。
        #   写成 `return self._release(head, head_voiced(best_start))` 就错了 ——
        #   那时 self.energies 已经是后半段（从停顿末尾开始），
        #   `self.energies[:best_start]` 取到的是后半段的开头，算出来的"前半段语音块数"
        #   是错的；一旦它低于 min_speech_ms，_release 会返回 None，
        #   于是**整个前半段被静默丢掉**。实测后果：12 句里 66 个字从没进过模型。
        head_loud = sum(1 for e in self.energies[:head_end] if e >= self.threshold)
        remainder_energies = self.energies[tail_start:]

        self.buffer = self.buffer[tail_start:]
        self.energies = remainder_energies
        self.voiced = sum(1 for e in self.energies if e >= self.threshold)
        # 剩下这段自己的尾巴静音要重算，否则会拿"整段 buffer 的静音数"去判下一句收尾
        trailing = 0
        for energy in reversed(self.energies):
            if energy < self.threshold:
                trailing += 1
            else:
                break
        self.silent_run = trailing
        self.cut_count += 1
        return self._release(head, head_loud)

    def _take(self):
        blocks = self.buffer
        tail = self.silent_run
        voiced = self.voiced
        self.buffer = []
        self.energies = []
        self.silent_run = 0
        self.speaking = False
        self.voiced = 0
        # 注意：判断"够不够长"必须用**真正超过门槛的块数**，不能用 buffer 的总长度。
        # buffer 里还混着前导缓存（句首前那 250ms 环境音），拿它计数的话，一声 0.1 秒的
        # 爆音会被算成 0.35 秒的"一句话"送进识别 —— 白算一次，还容易诱发幻听。
        if tail > 0:
            blocks = blocks[:len(blocks) - tail]
        return self._release(blocks, voiced)

    def flush(self):
        """流结束时把剩下的语音交出来。"""
        if self.speaking:
            tail = self.silent_run
            voiced = self.voiced
            blocks = self.buffer[:len(self.buffer) - tail] if tail else self.buffer
            self.buffer = []
            self.energies = []
            self.speaking = False
            self.silent_run = 0
            self.voiced = 0
            return self._release(blocks, voiced)
        self.buffer = []
        self.speaking = False
        self.voiced = 0
        return None


# ── 识别 ─────────────────────────────────────────────────────────────────────

def looks_like_hallucination(text: str) -> bool:
    lowered = text.lower()
    return any(sample in lowered for sample in HALLUCINATION_SAMPLES)


# ── initial_prompt：关于它的一波三折，值得完整记下来 ──────────────────────────
#
# 1) 起初我默认发一句「以下是普通话的句子，请用简体中文输出。」，想压掉繁体输出。
# 2) 用户随后报：字幕变成了「请用简体中文输出。」——**提示词被模型回显成了字幕**。
#    这是 initial_prompt 的经典副作用：片段太短或太模糊时，Whisper 会把提示词当成
#    "要接着写的文本"照抄出来。我构造 0.5 秒短片段复现了它，于是**撤掉了默认提示词**，
#    并加了回显过滤（looks_like_prompt_echo）。
# 3) 但建好中文基准（var/audio/zh-eval，30 条带参考文本）之后一测，发现**它确实有用**：
#        medium：7.4% → 5.9% CER，疑似繁体 8 字 → 1 字
#        large-v3：4.0% → 3.9%（大模型上影响很小）
#    所以又把它**默认打开**了 —— 因为回显那道闸已经能挡住"假字幕"这个唯一的坏处，
#    剩下的就只是好处。这就是"先加护栏、再放开"的顺序。
# 4) ⚠️ **2025 年又撤了一次，这次是有数据的**：上面那两条都是在**朗读**语料上量的，
#    而产品的目标场景是**真实口语**。用冻结的口语包 zh-speech-dev（304 条、跨多场录音、
#    同一个参考）做对照，只改"发不发那句提示词"：
#        不发：严格 15.55% / 规范化 14.51%，删除 352，繁体字 45
#        发  ：严格 18.24% / 规范化 17.96%，删除 489，繁体字 1
#    → **多错了 2.7~3.5 个百分点**（伤害集中在"删字"：352 → 489，提示词把话"压平"了），
#      换来的是繁体从 45 字降到 1 字（约 0.8 个百分点）。
#      净亏两个多点，所以在中文上**默认不发**。
#    在 20 段连续录音（491 秒）上单独量也是同一个方向：不发 16.8%，发 21.9%。
#    ⚠️ 但要注意它是**有条件的**：朗读语料上它仍然可能是有利的（大模型上影响本就很小），
#      而且一个**更短**的提示词（只留"请用简体中文输出。"）没量过 ——
#      那是"想保留压繁体、又想避开压平"时下一步该试的东西。
#
# 想显式发就用 --initial-prompt（或看下面的 LANGUAGE_PROMPTS 目录）。
# 想临时关掉任何缺省提示词：--no-prompt
LANGUAGE_PROMPTS = {
    "zh": "以下是普通话的句子，请用简体中文输出。",
    "pt": "A seguir, frases em português do Brasil.",
}

# ⚠️ **缺省会发哪句**：中文那句被实测否掉了（见上），所以这里没有 zh。
#    葡语那句还**没量过**（同一套方法就能验：pt-speech-dev 加/不加提示词各跑一轮）——
#    先原样保留，并在 docs/06 标成待办，不假装它已经验证过。
DEFAULT_PROMPTS = {
    "pt": LANGUAGE_PROMPTS["pt"],
}


def prompt_for(language, explicit):
    """显式给的优先；没给就用该语种的**缺省**提示词（中文那句已被实测否掉，见上）。"""
    if explicit:
        return explicit
    return DEFAULT_PROMPTS.get(language or "", None)


# ── 上下文续传：把前几段**已定稿**的文本，当成下一段提示词的一部分 ────────────
#
# 为什么加它（实测，同一段 31 分钟口语录音取 20 个连续段、同一个参考）：
#   · 逐段独立 16.8% → 前两段文本续传 15.1%（**零额外等待**：不多听一秒音频）
#   · 再配合 silence 500→1200：12.0%，只差 0.3 个百分点追平「整段不切」（11.7%）
# 机制：切碎的段缺上文，同音词只能靠猜；把上一两句的**文字**喂回去等于免费补语境。
# 代价：提示词变长，模型"照抄上文"的风险上升 —— 所以同时加了 looks_like_context_echo。
#
# ⚠️ 三条边界（都不是可选项，各有实测/推理支撑）：
#   1. **换语种就清空**：中文的上下文喂给葡语解码，等于逼模型继续写中文；
#   2. **隔太久就清空**（缺省 60 秒）：实测条件是"同一段连续发言"（句间 ≤2 秒），
#      隔了几分钟的上一句不属于同一段上文。这个 60 秒是**保守选择**，不是测出来的最优值；
#      它同时要**明显长于一段本身**（上限可到 30 秒），否则连续说话的长段会被误清；
#   3. 只记**定稿**的文本 —— 被四道闸丢弃的段不进上下文，否则等于把幻觉喂回给模型。
class ContextCarry:
    """按语种与时间窗口保存**最近 N 段**的定稿文本。"""

    def __init__(self, depth, max_gap_seconds=60.0):
        self.depth = max(0, int(depth))
        self.max_gap_seconds = float(max_gap_seconds)
        self.language = None
        self.texts = []
        self.last_at = None
        self.resets = {"language": 0, "gap": 0}

    def _stale(self, language, now):
        """要不要把历史清掉？返回 True 表示这次不能用上文。"""
        if self.depth <= 0 or not self.texts:
            return True
        if language != self.language:
            if self.texts:
                self.resets["language"] += 1
            self.texts = []
            self.language = language
            return True
        if self.last_at is not None and now - self.last_at > self.max_gap_seconds:
            self.resets["gap"] += 1
            self.texts = []
            return True
        return False

    def prompt(self, language, now):
        """这一段的提示词里该带的续传文本（没有就返回空串）。"""
        if self._stale(language, now):
            return ""
        return "".join(self.texts[-self.depth:])

    def push(self, text, language, now):
        """一段**定稿**之后把它记下来（空文本不记）。"""
        if self.depth <= 0 or not text:
            return
        if language != self.language:
            self.texts = []
            self.language = language
        self.texts.append(text)
        self.texts = self.texts[-self.depth:]
        self.last_at = now


def split_clauses(text, punctuation=None):
    """按标点把文本切成小句（**先切再清洗** —— 反过来的话标点已经被删掉，切不动）。"""
    marks = punctuation if punctuation is not None else "。，,．.！!？?、：:；; 　\n"
    clauses, current = [], ""
    for char in text:
        if char in marks:
            cleaned = strip_punctuation(current)
            if cleaned:
                clauses.append(cleaned)
            current = ""
        else:
            current += char
    cleaned = strip_punctuation(current)
    if cleaned:
        clauses.append(cleaned)
    return clauses


def strip_punctuation(text):
    for char in "。，,．.！!？?、：:；; 　\n":
        text = text.replace(char, "")
    return text


def looks_like_context_echo(text, context, min_share=0.8, min_total=8):
    """这段识别结果是不是在**照抄上文**（续传进去的前几段文本）？

    与回显闸的区别：回显闸防的是"把提示词当正文抄"（提示词是一句固定指令），
    这里防的是"把**上一两句说过的话**又输出一遍"。判据只有一条，而且刻意为难触发：

      · 输出里 **≥80% 的字**都能在上文里找到（整句照抄就是 100%），且总长 ≥8 字。

    ⚠️ 为什么只留这一条、而且不要"某一句与上文完全相同"这种看似更准的判据：
       人是**接着说**的，很自然会重复上一句的一部分再往下说 ——
       「（上文）这个盒子放的东西很重要」＋「（本句）这个盒子放的东西很重要，只有第二级才严重」。
       如果"有一个小句与上文相同"就判复读，那么后半句**真正的新内容会被整句丢掉**。
       所以判据必须是"**整段几乎全是上文**"，不是"碰到了上文"。
    ⚠️ 这条闸还有意留着**漏网的余地**：用户真的把同一句重复两遍时也会被丢掉，
       但那只是少一条重复字幕（内容上一句已经上过屏），比吃掉新内容轻得多。
    """
    if not text or not context:
        return False
    clauses = [piece for piece in split_clauses(text) if piece]
    context_flat = strip_punctuation(context)
    if not clauses or not context_flat:
        return False
    covered = sum(len(clause) for clause in clauses if clause in context_flat)
    total = sum(len(clause) for clause in clauses)
    return total >= min_total and covered >= min_share * total


def looks_like_prompt_echo(text, prompt, min_chars=4, min_coverage=0.4,
                           min_clause_chars=6):
    """这段识别结果是不是在回显提示词？

    判据（满足任一条）：
      1. 去标点空白后，输出等于/包含整条提示词；
      2. 输出是提示词的一部分时，必须**占到提示词的相当一块**（缺省 40%）；
      3. 输出被切成若干块后，**每一块**都出自提示词 —— 对应"同一句回显两遍"的情况。
         实测样本：`请用简体中文输出。 请用简体中文输出。`
         它整体不是提示词的子串（提示词前面还有"以下是普通话的句子"），
         只靠第 1 条会漏掉。
      4. **半截提示词混在正常字幕里**：输出里任何一句 ≥6 字的小句，本身就是提示词的
         一段连续文字。这条是补的（2024 实测，产线参数下 20 段里 3 段中招）：
         真实输出 `人们活了很长时间,只记住这四千年。请用简体中文输出。二百五十年…` ——
         整段既不是提示词的子串、也不是它的"一部分"，前三条**全部放行**，
         于是这段假字幕会被显示出去。

    为什么是这道闸：回显出来的是一句**看起来完全正常的字幕**，
    但它跟用户说的话毫无关系 —— 比"没有字幕"糟得多。

    ⚠️ 第 2 条那个"占相当一块"的要求是后补的，原来只看"是不是子串"。
    那是个隐患：提示词是「以下是普通话的句子，请用简体中文输出。」，
    里面**每一个字都是常用字**，于是「中文」「输出」「句子」「的话」「以下」
    这类两三个字的正常短句全都是它的子串 —— 用户真说了这些词，字幕会被静默吃掉，
    而且日志里看不出原因。现在要求至少 4 个字、且占到提示词的 40%，
    真实的回显（整条、尾巴、重复两遍）都仍然拦得住。
    ⚠️ 第 4 条同样有下限：小句要 ≥6 字。提示词里 6 字以上、又可能是正常句子的片段
    （「请用简体中文输出」这类）在实际对话里不会有人说，所以误杀风险很低；
    而「中文」「输出」这种 2~3 字的常用词仍然一律放行。
    """
    if not prompt or not text:
        return False
    text_clean = strip_punctuation(text)
    prompt_clean = strip_punctuation(prompt)
    if not text_clean or not prompt_clean:
        return False
    if len(text_clean) < min_chars:
        return False
    if text_clean == prompt_clean or prompt_clean in text_clean:
        return True
    if text_clean in prompt_clean:
        return len(text_clean) >= min_coverage * len(prompt_clean)
    pieces = split_clauses(text)
    for piece in pieces:            # 第 4 条：半截提示词混在正常字幕里
        if len(piece) >= min_clause_chars and piece in prompt_clean:
            return True
    meaningful = [piece for piece in pieces if len(piece) >= min_chars]
    if not meaningful or not all(piece in prompt_clean for piece in meaningful):
        return False
    return sum(len(piece) for piece in meaningful) >= min_coverage * len(prompt_clean)


def normalize_peak(audio, target=0.9, quiet_below=0.3):
    """把**电平偏低**的音频按峰值抬到正常量级。

    为什么只在低电平时做：手机离嘴 20~30cm 录进来，峰值常常只有 0.2 左右，
    而 Whisper 是在电平相对正常的音频上训练的。
    但在**已经录得正常**的音频上（比如公开语料，峰值本来就 0.5~1.0）再抬一次没有好处 ——
    实测中文基准 30 条：不归一化 6.7%、一律归一化 7.4%（medium，无提示词）。
    所以加个门槛：只在峰值低于 quiet_below 时才动它。**只在需要时动手**。

    注意：numpy 在这个文件里是**惰性导入**的（让 --help 在没有 numpy 的机器上也能用），
    所以这里不能用模块级的 np。（第一次写就踩了：NameError: name 'np' is not defined。）
    """
    import numpy as np
    if audio.size == 0:
        return audio
    peak = float(np.max(np.abs(audio)))
    if peak <= 1e-6 or peak >= quiet_below:
        return audio
    return audio * (target / peak)


def rms_of(audio):
    """一段音频的 RMS。用来判断"这段到底是人声还是环境噪声"。"""
    import numpy as np
    if audio.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(audio ** 2)))


# 电平达到这个值，就认定"这里面确实有人声"，不再让模型的 no_speech_prob 否决它。
# 取值依据（本机实测）：安静房间底噪约 0.0005，用户手机录音的说话段 RMS 约 0.067~0.12。
# 0.02 大约在两者中间偏人声一侧，留了足够余量（正常说话比它高 3~6 倍）。
SPEECH_RMS_FLOOR = 0.02


def decide_no_speech(no_speech_prob, threshold, level, speech_floor=SPEECH_RMS_FLOOR):
    """要不要因为 no_speech_prob 丢掉这一段？

    @return (是否丢弃, 是否是被"电平证据"压过的)

    为什么单独抽成纯函数：这条规则曾经**把用户正在说的话扔掉**（连着说「你好 欢迎」，
    两段都被判 no_speech_prob=0.68/0.87，而电平是 0.086/0.067 —— 明明是人声）。
    静默丢数据是最难查的一类 bug，所以规则要能被测试逐条钉住，而不是埋在
    transcribe() 里靠人读。

    规则：
      · no_speech_prob 没超阈值 → 不丢（返回 False）。
      · 超了阈值，但这段音频的**电平明显是人声** → 不丢，并标记"压过了模型自述"。
        （no_speech_prob 是模型对一小段的自我报告，在 1 秒级片段上很不可靠；
          而我们自己的切句器已经按能量判过"这是语音"了。）
      · 超了阈值且电平很弱 → 丢。噪声/气声正是这个闸擅长的场景。
    """
    if no_speech_prob <= threshold:
        return False, False
    if level >= speech_floor:
        return False, True
    return True, False


def preview(text, limit=40):
    """把一段文字压成一行短预览，用于日志。

    为什么丢弃日志必须带上文字：日志原来只写"丢弃"和原因，不写**被丢掉的是什么**。
    用户报"经常出现丢弃"时，从日志里完全看不出丢掉的是真话还是幻听 ——
    这跟"静默的 daemon 最难排查"是同一类问题。丢掉的文字正是唯一的证据。
    """
    flat = " ".join(str(text).split())
    return flat if len(flat) <= limit else flat[:limit] + "…"


def pick_language(all_probs, candidates):
    """在**候选集**里挑概率最大的语种码；候选一个都没有就返回 None（表示"不判"）。

    <p>抽成纯函数就是为了能被测试逐条钉住 —— 它决定"这句话按哪种语言去识别"，
    判错了整句都是错的（而且**安静地**错：强制错语种会让识别输出"译文"而非乱码）。
    模型跑不起来的环境里也应该能验它，所以它不碰模型、只吃概率表。

    @param all_probs 形如 [("pt", 0.97), ("he", 0.01), ...]
    @param candidates 语种码的可迭代对象；None/空 表示不限定
    """
    if not candidates:
        return None
    picks = [(code, prob) for code, prob in all_probs if code in set(candidates)]
    if not picks:
        return None
    return max(picks, key=lambda item: item[1])[0]


def transcribe(model, audio, language, min_logprob, no_speech_prob,
               beam_size=1, initial_prompt=None, do_normalize=True,
               speech_floor=SPEECH_RMS_FLOOR, candidates=None, context_text=None,
               hint_text=None):
    """把一段音频识别成文字，并过四道闸。

    返回 `(文字, 是否被丢弃, 丢弃原因, 是否用"电平证据"压过了 no_speech_prob, 丢弃类别)`。

    ⚠️ **两道"抄"的闸必须分开判，判据强度也不一样**（这一条是踩出来的）：

      | 送进模型的东西 | 谁来判 | 判据 |
      |---|---|---|
      | `hint_text`：那句**固定指令**（语种/字形提示） | `looks_like_prompt_echo` | 可以严：指令里的字不可能是用户真说的话 |
      | `context_text`：**上文**（＝用户自己刚说过的话） | `looks_like_context_echo` | **必须松**：用户重复自己刚说的词是常态 |

    一开始我把两者拼成一个 `initial_prompt` 一起判，结果是**用严的判据去判用户自己的话** ——
    实测就抓到一次误判：800ms 那一轮实验的回显计数器报了 1 次，而那一整段的输出里
    **根本没有任何重复片段**，报的就是"用户自己重复用了几个字"。
    那在产线上就是**把一句真字幕吃掉**，而且日志上看不出原因。
    """
    data = normalize_peak(audio) if do_normalize else audio
    # 拼给模型的提示词：指令在前、上文在后（顺序与实验一致）。
    # `initial_prompt` 显式给了就用它（那是调用方直接指定的指令），否则由两段拼出来。
    prompt = initial_prompt if initial_prompt is not None else (
        (hint_text or "") + (context_text or ""))
    # 严判据只对"指令"那一段生效：显式 initial_prompt 也算指令。
    guard_hint = hint_text if hint_text is not None else initial_prompt
    if language is None and candidates:
        # ── 限定候选语种 ────────────────────────────────────────────────────
        #
        # 为什么需要这一步：不指定语种时 Whisper 会在**99 种语言**里挑一个。
        # 实测（pt-coraa，20 条真实巴葡口语，large-v3）：
        #   不限定  → 语种判定 {pt:19, **he**:1}，词错率 13.3%
        #             被认成希伯来语的那一条**整句报废（词错率 100%）**
        #   限定    → 只会是 pt 或 zh，那一条从 100% 降到 60%，整体 12.2%
        #
        # 而这个系统**只可能是两种语言**（中文 / 巴葡），
        # 所以"在 99 种里挑"这件事本身就是多余的自由度：
        # 多出来的每一种语言都是一个**纯亏**的失败可能。
        #
        # ⚠️ 成本要说准，别说成"免费"：**相对于自动判定是零额外成本**
        #    `transcribe(language=None)` 内部本来就是"先检测、再解码"，
        #    这里只是把同一步的结果**在候选里取最大**而不是全域取最大。
        #    实测（large-v3/CUDA，1.63 秒片段，取 5 次最快）：
        #        transcribe('pt')                     650 ms   ← 强制语种最便宜
        #        detect_language()                    507 ms
        #        detect_language() + transcribe('pt') 1045 ms  ← 本函数现在的做法
        #        transcribe(None)（自动判定）          1204 ms  ← 与上一行是同一件事
        #    也就是说：**限定候选集不比自动判定贵，但自动判定比强制语种贵 1.9 倍**
        #    （检测要把短音频补到 30 秒窗口跑一遍编码器，短片段上这笔钱很显眼 ——
        #     同传的总延迟才 1.3~2.2 秒，500ms/句不是小数目）。
        #    所以**最优解仍然是"让手机声明语种"**（那样走强制语种路径、又快又准）；
        #    候选集是"没人声明时"的兜底护栏。
        detected, _prob, all_probs = model.detect_language(data)
        picked = pick_language(all_probs, candidates)
        if picked is not None:
            if picked != detected:
                # 记录下来：这正是"本来会判错"的那些句子，是这条护栏在起作用的证据。
                print(f"[whisper_stream] 语种限定生效：全局最大是 {detected}，"
                      f"限定到 {tuple(candidates)} 后取 {picked}",
                      file=sys.stderr, flush=True)
            language = picked
    segments, _info = model.transcribe(
        data,
        language=language,
        # beam search 比贪心准，代价是多花一点解码时间。GPU 上实测很便宜
        # （14.7 秒音频：small beam5 只要 0.35~0.56 秒），所以缺省用 5 而不是 1。
        beam_size=beam_size,
        vad_filter=False,       # 我们已经按能量切好了，不需要再切
        condition_on_previous_text=False,   # 句间独立，避免上一句的错误污染下一句
        initial_prompt=prompt,
    )
    # 先算一次电平（在**归一化之前**算，那才是真实录音的电平）
    level = rms_of(audio)

    kept = []
    dropped = None
    kind = None
    overrode = False
    for seg in segments:
        text = seg.text.strip()
        if not text:
            continue
        if getattr(seg, "no_speech_prob", 0.0) > no_speech_prob:
            # 规则见 decide_no_speech：**电平明显是人声时，不让模型自述否决它**。
            # 这里曾经无条件丢弃，结果把用户正在说的话扔了（详见该函数的说明）。
            drop, overridden = decide_no_speech(
                seg.no_speech_prob, no_speech_prob, level, speech_floor)
            if drop:
                dropped = (f"no_speech_prob={seg.no_speech_prob:.2f}（电平 {level:.4f}）"
                           f"｜文字：{preview(text)}")
                kind = "no_speech"
                continue
            overrode = overrode or overridden
        if getattr(seg, "avg_logprob", 0.0) < min_logprob:
            dropped = f"avg_logprob={seg.avg_logprob:.2f}｜文字：{preview(text)}"
            kind = "logprob"
            continue
        if looks_like_hallucination(text):
            dropped = f"命中幻听惯用语｜文字：{preview(text)}"
            kind = "hallucination"
            continue
        if looks_like_prompt_echo(text, guard_hint):
            # 回显出来的是一句"看起来完全正常的字幕"，但它跟用户说的话毫无关系。
            # 这比没有字幕糟得多 —— 用户会以为眼镜在乱翻译。
            dropped = f"回显了提示词（initial_prompt 的经典副作用）｜文字：{preview(text)}"
            kind = "prompt_echo"
            continue
        if looks_like_context_echo(text, context_text):
            # 上下文续传带进来的副作用：模型把**上文**又输出了一遍。
            # 与回显不同，这段文字是用户自己刚说过的话 —— 丢掉它内容不会消失
            # （上一句字幕已经发过了），但重复一整条字幕同样会让用户以为系统在乱翻。
            dropped = f"照抄了上文（上下文续传的副作用）｜文字：{preview(text)}"
            kind = "context_echo"
            continue
        kept.append(text)
    return (" ".join(kept).strip(), kept == [], dropped,
            (overrode and kept != []), kind)


class Stats:
    def __init__(self):
        self.utterances = 0
        self.dropped = 0
        self.audio_seconds = 0.0
        self.transcribe_seconds = 0.0
        self.lags = []
        # 上下文续传：跑完要看得出"它到底有没有在工作"（清空过几次？复读拦了几段？）
        self.carry = None
        self.context_echoes = 0

    def add(self, audio_seconds, transcribe_seconds, dropped):
        self.utterances += 1
        self.audio_seconds += audio_seconds
        self.transcribe_seconds += transcribe_seconds
        if dropped:
            self.dropped += 1
        else:
            self.lags.append(transcribe_seconds)

    def report(self, silence_ms, gate=None):
        print("", file=sys.stderr)
        print("─" * 72, file=sys.stderr)
        print("统计", file=sys.stderr)
        print("─" * 72, file=sys.stderr)
        if gate:
            print(f"  语音门槛：{gate}", file=sys.stderr)
        print(f"  语音段数：{self.utterances}（其中被防幻听闸丢弃 {self.dropped} 段）", file=sys.stderr)
        print(f"  语音总时长：{self.audio_seconds:.2f}s", file=sys.stderr)
        print(f"  识别总耗时：{self.transcribe_seconds:.2f}s", file=sys.stderr)
        if self.carry is not None:
            resets = self.carry.resets
            print(f"  上下文续传：前 {self.carry.depth} 段"
                  f"（清空：换语种 {resets['language']} 次 / 超时 {resets['gap']} 次）"
                  f"；照抄上文被丢弃 {self.context_echoes} 段", file=sys.stderr)
        if self.audio_seconds > 0:
            print(f"  实时率 RTF：{self.transcribe_seconds / self.audio_seconds:.3f}", file=sys.stderr)
        if self.lags:
            average = sum(self.lags) / len(self.lags)
            print(f"  平均识别耗时：{average:.2f}s（每段）", file=sys.stderr)
            # ⚠️ 这一行以前是「理论最短延迟 = 静音判定 + 识别」，**漏了最大的一项**：
            #    一句话要先攒够一整段才会被送进识别，所以从用户说出这段的第一个字
            #    到字幕出现，还要加上"这一段本身有多长"（段内位置平均算一半）。
            #    这个口径错误在文档里留了很久（把 1200ms 那档说成只多等 2.3 秒，
            #    实际是 6.2 秒），所以这里直接把两项都打出来。
            mean_segment = self.audio_seconds / self.utterances
            print(f"  平均段长：{mean_segment:.2f}s（= 语音总时长 ÷ 段数）", file=sys.stderr)
            print(f"  字幕延迟（估算）：{mean_segment / 2 + silence_ms / 1000 + average:.2f}s"
                  f" = 段内平均位置 {mean_segment / 2:.2f}s + 静音判定 {silence_ms / 1000:.2f}s"
                  f" + 识别 {average:.2f}s（最坏 {mean_segment + silence_ms / 1000 + average:.2f}s）",
                  file=sys.stderr)
            print("  （还没算翻译耗时；段内位置按平均算，是**估算**不是实测）", file=sys.stderr)
        print("─" * 72, file=sys.stderr)


# ── 尾随一个不断增长的裸 PCM 文件（手机录音上传那条路）──────────────────────

class PcmFollower:
    """读一个被外部进程不断追加的裸 PCM 文件，按块产出 float32 音频。
    为什么要单独一个类、而且不直接 open() 了事：
      · **文件可能被截断重来**（手机重新开始录音时 relay 会清空它）。此时必须把读指针
        退回 0，否则会永远读不到新数据，表现成"录音上传没反应"。
      · **采样率可能不是 16 kHz**（安卓降级到 44.1 kHz 时）。猜错会让识别结果全是乱码，
        所以要读 relay 写的旁文件，并做重采样。
      · **对不齐的半帧要留住**。PCM 一帧 2 字节，而文件是边写边读的：很可能读到"半帧"。
        直接用会把这 1 个字节当成一帧的低位，之后所有采样都错位（听感是刺啦声，识别必然崩）。
        所以不足一帧的尾巴要留在缓冲里，等下次读齐再处理。
      · **说话人半句就停止录音时**，数据流就断在那里，没有尾部静音，切句器会一直等下去。
        所以要能按需补静音（见 idle_silence_blocks）。
      · **语种会中途变**（手机上切「听葡语/听中文」）。所以还要读语种旁文件，
        让下一句就用新语种识别 —— 而不是要求用户停止录音、重开一次。
    """

    def __init__(self, path, fallback_rate, np, block_samples, follow_rate_path=None,
                 from_start=False):
        self.path = Path(path)
        self.rate_path = Path(follow_rate_path) if follow_rate_path else self.path.with_suffix('.rate')
        self.lang_path = self.path.with_suffix('.lang')
        self.fallback_rate = fallback_rate
        self.np = np
        self.block_samples = block_samples
        self.offset = 0                  # 已读到的字节位置
        self.tail = b""                  # 不足一帧的残余字节
        self.rate = fallback_rate
        self.resample_pos = 0.0          # 重采样用的连续位置（跨块保持，避免接缝处跳变）
        self.rate_notice = None
        self.language = None             # 当前语种（Whisper 码）；None = 让 Whisper 自己判
        self.lang_notice = None
        # **从末尾开始跟**，而不是从头：
        # 文件是"只追加"的，里面可能攒着上一次运行的录音。从头读的话，一启动就会把
        # 那些旧音频重新识别一遍，冒出一串莫名其妙的旧字幕 —— 而且用户会以为是刚说的话。
        # 想重放整个文件就用 --follow-from-start。
        if not from_start:
            try:
                self.offset = self.path.stat().st_size
            except OSError:
                self.offset = 0

    def read_rate(self):
        """读采样率旁文件。没有就沿用上一轮的值（relay 还没写过）。"""
        try:
            text = self.rate_path.read_text(encoding="utf-8").strip()
        except OSError:
            return self.rate
        try:
            value = int(float(text))
        except ValueError:
            return self.rate
        if value != self.rate and value > 0:
            self.rate = value
            self.resample_pos = 0.0
            self.rate_notice = value
        return self.rate

    def read_language(self, default=None):
        """读语种旁文件。返回当前该用的 Whisper 语种码（读不到就返回 default）。"""
        try:
            tag = self.lang_path.read_text(encoding="utf-8").strip()
        except OSError:
            return self.language if self.language is not None else default
        code = whisper_language_of(tag)
        if code is not None and code != self.language:
            self.language = code
            self.lang_notice = (tag, code)
        return self.language if self.language is not None else default

    def _resample(self, samples):
        """
        把任意采样率线性插值到 16 kHz。够用：这是给人听的语音，不是音频制品。

        ⚠️ **跨块连续是本方法的全部难点**，踩过一次真机故障，记在这里：

        每次 read() 传进来的 `samples` 都是**从新读到的字节重新构造的数组**，
        不是上一个数组的延续。所以 `resample_pos` 必须记成
        **"下一块里第一个输出采样落在哪个位置（相对本块起点，可能为负）"**，
        而不是一个全局绝对位置。

        写错时的表现极具误导性：第一块正常输出 16000 个采样，
        然后 `resample_pos` 变成 44100 —— 恰好等于块长，
        于是后面每一块的 count 都算成 0，**永远返回空**。
        结果就是"识别器只在最开始拿到过约 1 秒音频，之后一直是空的"，
        而转发进程那边电平、字节数、采样率全都正常 ——
        从日志上看不出任何异常，只有字幕永远不出来。

        为什么一直没暴露：手机麦克风正常是 16 kHz，本方法会直接 return，
        **这条路径从来没被走到过**。眼镜的麦克风固定 44.1 kHz，
        一上来就命中它，问题才现形。
        """
        if self.rate == TARGET_RATE or samples.size == 0:
            return samples
        step = self.rate / float(TARGET_RATE)
        n = samples.shape[0]
        # 上一块的尾巴已经越过这一块了：整块都被吃掉，位置往下一块挪
        if self.resample_pos >= n:
            self.resample_pos -= n
            return samples[:0]
        count = int((n - self.resample_pos) / step)
        if count <= 0:
            self.resample_pos -= n
            return samples[:0]
        index = self.resample_pos + step * self.np.arange(count, dtype="float64")
        result = self.np.interp(index, self.np.arange(n), samples).astype("float32")
        # 关键：换算成**相对下一块**的位置（减掉本块长度），下一次才是对的
        self.resample_pos = index[-1] + step - n
        return result

    def read(self):
        """读一次新数据，返回若干个 float32 块（可能为空列表）。"""
        blocks = []
        try:
            size = self.path.stat().st_size
        except OSError:
            return blocks                     # 文件还没被创建

        if size < self.offset:                # 被截断重来了
            self.offset = 0
            self.tail = b""
            self.resample_pos = 0.0

        if size <= self.offset:
            return blocks

        with open(self.path, "rb") as handle:
            handle.seek(self.offset)
            raw = handle.read(size - self.offset)
        self.offset += len(raw)

        raw = self.tail + raw
        usable = len(raw) - (len(raw) % 2)     # 奇数尾巴留到下次
        self.tail = raw[usable:]
        if usable == 0:
            return blocks

        samples = self.np.frombuffer(raw[:usable], dtype="<i2").astype("float32") / 32768.0
        samples = self._resample(samples)
        for start in range(0, samples.shape[0], self.block_samples):
            piece = samples[start:start + self.block_samples]
            if piece.shape[0] > 0:
                blocks.append(piece)
        return blocks


class IdleTracker:
    """判断"上传真的停了"还是"只是两块音频之间"。

    ⚠️ 这个类是从一次实测故障里拆出来的，值得完整记下来。

    原来的写法是"连续 5 次轮询没读到数据就算停了"，然后**往切句器里塞 500ms 数字零**，
    把当前这句逼出来。看着没问题，其实判据和单位都错了：

      · 单位错：`silence_ms / block_ms` = 500/100 = 5，隐含假设"一次轮询 = 一块 = 100ms"。
        但每次轮询之间睡的是 `--follow-poll-ms`（缺省 **80ms**），
        所以 5 次轮询只有 **400ms**，比它想表达的 500ms 还短。
      · 概念错（更要命）：手机是**按 1 秒一块**上传的，块与块之间本来就有近 1 秒没数据。
        于是"400ms 没新数据"在正常上传时**天天成立** —— 它把"网络还没送来下一块"
        当成了"说话人停下来了"。

    后果用用户那次真实录音量过（var/logs/relay.log 有真实上传时刻表）：
      同一段音频、同样参数，数据一次性到位 → 切成 [2.9, 4.9] 两段；
      按真实节奏（每秒一块）喂 → 切成 [2.6, 1.0, 0.9, 1.9, 2.0] 五段，
      其中那段 1.0 秒的，电平 0.0664 与 relay 日志里第 9 块**一模一样** ——
      说明它正好是"一块音频"，是按上传节奏切出来的。

    切出来的这些短碎片又正好是 Whisper 最容易出幻觉的长度：用户看到的
    「丢弃 …：回显了提示词」就是这些碎片被判成回显（那次确实回显了，
    被丢弃的原文是「请用简体中文输出。」）。所以**丢字幕只是症状，按上传节奏切句才是病**。

    新判据：按**毫秒**累计"一直没读到新数据"的时间，而且要求这个时间明显长于
    上传间隔（缺省 2 秒）。道理很直白：2 秒的静默比"一句话结束"的判定阈值（500ms）
    还长，所以在这个位置断开，和"本来就会在这里断"是一致的；
    而 400ms 就断，是在跟判据打架。
    """

    def __init__(self, flush_ms, poll_ms):
        self.flush_ms = max(1, int(flush_ms))
        self.poll_ms = max(1, int(poll_ms))
        self.idle_ms = 0

    def saw_data(self):
        self.idle_ms = 0

    def saw_nothing(self):
        """这次轮询没读到数据。返回是否已经"停得够久"。"""
        self.idle_ms += self.poll_ms
        return self.idle_ms >= self.flush_ms


# ── 主流程 ───────────────────────────────────────────────────────────────────

def emit(text: str):
    """一行一句话，立刻 flush：延迟就是同传的命。"""
    clean = " ".join(text.split())
    if clean:
        print(clean, flush=True)


def main():
    args = parse_args()
    # 只有"真要从麦克风收"才需要 sounddevice。
    # 注意 follow 模式也算"不是麦克风" —— 早先这里只判了 --file，于是
    # `--follow` 会因为没有 sounddevice 直接退出（而退出前那句错误信息又被管道
    # 下游的桥当成"识别结果"写进了收件箱，见文件末尾的警告）。
    need_audio = args.file is None and args.follow is None
    np, WhisperModel, sounddevice = load_dependencies(need_audio)

    print(f"[whisper_stream] 加载模型 {args.model}"
          f"（device={args.device}, compute_type={args.compute_type}）…", file=sys.stderr)
    # 把"模型从哪儿来"打出来。这一行是被一次真实事故逼出来的：
    # 用户自己跑的时候没设 HF_HOME，于是模型从零开始下载到默认缓存 ——
    # 直连 HuggingFace 三分钟只下了 2.5MB，识别进程 4 分钟都没开始听，
    # 而终端上只看到"加载模型…"一句，完全看不出它在下载。
    hf_home = os.environ.get("HF_HOME") or os.environ.get("HF_HUB_CACHE") or "(默认 ~/.cache/huggingface)"
    hf_endpoint = os.environ.get("HF_ENDPOINT") or "huggingface.co"
    print(f"[whisper_stream] 模型缓存 {hf_home}；下载源 {hf_endpoint}", file=sys.stderr)
    print("[whisper_stream] 若这里显示的是默认缓存，而模型仓库里已经有了，"
          "说明 HF_HOME 没设 —— 它会重新下一个几百 MB 的模型，慢得像是卡住了",
          file=sys.stderr)
    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
    print("[whisper_stream] 模型就绪", file=sys.stderr)

    if args.self_check:
        print("[whisper_stream] --self-check 通过：依赖与模型都能加载", file=sys.stderr)
        return 0

    segmenter = UtteranceSegmenter(
        args.samplerate, args.block_ms, args.silence_ms,
        args.min_speech_ms, args.max_speech_ms, args.rms_threshold, args.preroll_ms, np,
        adaptive=args.adaptive, rms_floor=args.rms_floor, noise_multiplier=args.noise_multiplier,
        short_utterance_ms=args.short_utterance_ms, short_silence_ms=args.short_silence_ms,
        cut_pause_ms=args.cut_pause_ms,
    )
    stats = Stats()

    # ── 预热 ────────────────────────────────────────────────────────────────
    # 实测：CUDA 上第一次推理要 11.3 秒（cuDNN 选算法、分配显存），之后的句子只要 0.1 秒。
    # 不预热的话，用户说出的第一句话会被卡十几秒 —— 这是同传最不能接受的失败方式。
    # 办法是启动时先拿 1 秒静音跑一遍，把这块固定开销提前付掉。
    if not args.no_warmup:
        warm_start = time.perf_counter()
        silent = np.zeros(args.samplerate, dtype=np.float32)
        try:
            transcribe(model, silent, args.language, args.min_logprob, args.no_speech_prob)
        except Exception as error:      # 预热失败不该让整个程序起不来
            print(f"[whisper_stream] 预热失败（忽略）：{type(error).__name__}: {error}", file=sys.stderr)
        print(f"[whisper_stream] 预热完成：{time.perf_counter() - warm_start:.2f}s"
              f"（这段固定开销如果不提前付，会砸在第一句字幕上）", file=sys.stderr)

    # 当前语种放在可变容器里：手机中途切「听葡语/听中文」时要能改，
    # 而且下一句就生效（Whisper 的 language 是逐次调用给的，所以切换很便宜）。
    active = {"language": args.language}

    # 上下文续传（前 N 段的定稿文本当提示词）—— 见 ContextCarry 上面那段说明。
    carry = ContextCarry(args.context_depth, args.context_gap_s)
    stats.carry = carry

    def handle(utterance):
        seconds = len(utterance) / float(args.samplerate)
        start = time.perf_counter()
        now = time.monotonic()
        language = active["language"]
        # 提示词 = 语种提示词 + 续传文本（顺序与实验一致：**指令在前、上文在后**）；
        # ⚠️ 但两段**分开传给 transcribe**：它们的闸判据强度不一样（见 transcribe 的说明）。
        hint = None if args.no_prompt else prompt_for(language, args.initial_prompt)
        carried = carry.prompt(language, now)
        text, empty, reason, overrode, kind = transcribe(
            model, utterance, language,
            args.min_logprob, args.no_speech_prob,
            beam_size=args.beam_size,
            hint_text=hint, context_text=carried or None,
            do_normalize=not args.no_normalize,
            # 只有在**没指定语种**时才用得上（指定了就不检测）。见 transcribe 里的说明。
            candidates=args.lang_candidates,
        )
        elapsed = time.perf_counter() - start
        stats.add(seconds, elapsed, empty)   # 每段都记：短段的固定开销正是同传的敌人
        if kind == "context_echo":
            stats.context_echoes += 1
        # ⚠️ **只有定稿的文本才进上下文**：被四道闸丢弃的段不进 —— 否则等于把幻觉喂回去。
        if empty is False and text:
            carry.push(text, language, time.monotonic())
        rtf = elapsed / seconds if seconds > 0 else float("nan")
        level = rms_of(utterance)
        if empty:
            print(f"  [丢弃 {seconds:.1f}s 音频，{elapsed:.2f}s，RTF {rtf:.2f}，"
                  f"电平 {level:.4f}：{reason or '没有内容'}]",
                  file=sys.stderr, flush=True)
        else:
            note = "（电平明显是人声，已压过 no_speech_prob 的误判）" if overrode else ""
            print(f"  [{seconds:.1f}s 音频 / {elapsed:.2f}s 识别 / RTF {rtf:.2f}"
                  f" / 电平 {level:.4f}]{note}",
                  file=sys.stderr, flush=True)
        emit(text)

    if args.file is not None:
        import wave
        with wave.open(args.file, "rb") as wav:
            rate = wav.getframerate()
            if rate != args.samplerate:
                print(f"[whisper_stream] 警告：文件采样率 {rate} ≠ {args.samplerate}，"
                      f"请先用 make_long_wav.py 生成 16k 单声道 wav", file=sys.stderr)
            raw = wav.readframes(wav.getnframes())
        audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        started = time.perf_counter()
        for start in range(0, len(audio), segmenter.block):
            if args.realtime:      # 模拟音频按真实速度到达
                target = started + (start / float(args.samplerate))
                delay = target - time.perf_counter()
                if delay > 0:
                    time.sleep(delay)
            for utterance in segmenter.push(audio[start:start + segmenter.block]):
                handle(utterance)
        last = segmenter.flush()
        if last is not None:
            handle(last)
        if args.stats:
            stats.report(args.silence_ms, segmenter.gate_report())
        return 0

    if args.follow is not None:
        follower = PcmFollower(
            args.follow, args.samplerate, np, segmenter.block,
            follow_rate_path=args.follow_rate,
            from_start=args.follow_from_start,
        )
        rate = follower.read_rate()
        # 语种：**手机的旁文件优先于命令行的 --language**。
        # 为什么这样定：手机上那个「听葡语/听中文」按钮是用户当下意图的唯一来源，
        # 而 --language（或桥的 --from）是启动时写死的。手机中途切了按钮还要重启识别进程
        # 才能生效的话，这个按钮就成了摆设。
        # 副作用：在同一个数据目录上跑离线测试时，可能读到上一次手机留下的语种。
        # 那种情况下用 --no-sidecar-lang 强制用命令行的值。
        language = args.language
        if not args.no_sidecar_lang:
            language = follower.read_language(default=args.language)
            if language is not None:
                active["language"] = language
            # 启动这次读取也填了 lang_notice；不清掉的话，循环第一轮会把同一件事再报一遍
            follower.lang_notice = None
        source = '命令行'
        if not args.no_sidecar_lang and follower.language is not None and follower.language != whisper_language_of(args.language):
            source = f'来自 {follower.lang_path.name}（手机上的语言按钮）'
        print(f"[whisper_stream] 尾随 {args.follow}（{rate} Hz，"
              f"目标 {TARGET_RATE} Hz，语种 {active['language'] or '自动判定'}，{source}）；Ctrl-C 结束",
              file=sys.stderr, flush=True)
        print("[whisper_stream] 等手机开始录音上传…", file=sys.stderr, flush=True)

        # 说话人半句就松开按钮时，数据流断在那里、没有尾部静音，切句器会一直等。
        # 所以"上传确实停了"就把这一句先交出去。
        # 判据见 IdleTracker：按**毫秒**算，而且阈值要明显长于上传间隔 ——
        # 原来按"轮询次数"算（5 次 × 80ms = 400ms），正常上传时天天误触发。
        idle = IdleTracker(args.idle_flush_ms, args.follow_poll_ms)
        last_notice = None
        last_lang_tag = None
        # --stop-after-idle：连续多久没新音频就收尾。
        # 为什么需要它：手机停止录音后文件就不再增长，尾随循环会永远等下去。
        # 有了它，识别进程能在录音结束后自己把最后一句吐出来并退出。
        idle_stop_ms = (None if args.stop_after_idle is None
                        else max(1, int(args.stop_after_idle * 1000)))
        try:
            while True:
                blocks = follower.read()
                if follower.rate_notice is not None and follower.rate_notice != last_notice:
                    last_notice = follower.rate_notice
                    print(f"[whisper_stream] 采样率变为 {last_notice} Hz，已开始重采样",
                          file=sys.stderr, flush=True)
                # 手机切了语种就跟着切 —— 下一句立刻生效，不用停止录音
                if not args.no_sidecar_lang:
                    language = follower.read_language(default=active["language"])
                    if follower.lang_notice is not None and follower.lang_notice[0] != last_lang_tag:
                        tag, code = follower.lang_notice
                        last_lang_tag = tag
                        active["language"] = code
                        print(f"[whisper_stream] 语种变为 {tag}（Whisper 码 {code}），下一句起生效",
                              file=sys.stderr, flush=True)
                    elif language != active["language"]:
                        active["language"] = language
                if blocks:
                    idle.saw_data()
                    for block in blocks:
                        for utterance in segmenter.push(block):
                            handle(utterance)
                else:
                    if idle.saw_nothing() and segmenter.speaking:
                        # 直接把这半句交出去，**不再往切句器里塞数字零**：
                        # 那些零会污染自适应门槛的统计（噪声底被算成 0），
                        # 而"没数据"和"有静音"本来就是两件事。
                        last = segmenter.flush()
                        if last is not None:
                            print(f"[whisper_stream] 上传停了 {args.idle_flush_ms / 1000:.1f}s，"
                                  f"先把缓冲里的这半句交出去（不塞假静音）",
                                  file=sys.stderr, flush=True)
                            handle(last)
                    if idle_stop_ms is not None and idle.idle_ms >= idle_stop_ms:
                        print(f"[whisper_stream] 连续 {args.stop_after_idle}s 没有新音频，收尾退出",
                              file=sys.stderr, flush=True)
                        break
                    time.sleep(max(0.01, args.follow_poll_ms / 1000.0))
        except KeyboardInterrupt:
            print("\n[whisper_stream] 收到 Ctrl-C", file=sys.stderr)
        last = segmenter.flush()
        if last is not None:
            handle(last)
        stats.report(args.silence_ms, segmenter.gate_report())
        return 0

    # 麦克风模式
    audio_queue = queue.Queue()

    def on_audio(indata, _frames, _time, status):
        if status:
            print(f"[whisper_stream] 音频状态：{status}", file=sys.stderr)
        audio_queue.put(indata[:, 0].copy())

    print("[whisper_stream] 开始收音（Ctrl-C 结束）", file=sys.stderr)
    with sounddevice.InputStream(samplerate=args.samplerate, channels=1, dtype="float32",
                                 blocksize=segmenter.block, callback=on_audio):
        try:
            while True:
                block = audio_queue.get()
                for utterance in segmenter.push(block):
                    handle(utterance)
        except KeyboardInterrupt:
            last = segmenter.flush()
            if last is not None:
                handle(last)
            stats.report(args.silence_ms, segmenter.gate_report())
            print("\n[whisper_stream] 已停止", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
