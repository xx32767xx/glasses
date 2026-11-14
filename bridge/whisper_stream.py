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
import contextlib
import json
import os
import queue
import re
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
    # 2026-10-22 实测逮到的另一族：安静音频上 Whisper 吐出了**影视上传水印**
    # 「优优独播剧场——YoYo Television Series Exclusive」（电平只有 0.0080，接近静音）。
    # 这行水印在原视频里是常驻的，训练数据里出现得极多，于是静音时被"复读"出来。
    # 它连英文名一起吐出来了，翻译模型再把它翻成「O que significa YoYo …」——
    # 用户根本没说过这些字。所以把这段水印（中英两侧）都钉进幻听表。
    "优优独播剧场", "YoYo Television Series Exclusive", "独播剧场",
    # 2026-10-23 实测逮到的第三族：安静音频上吐「中文字幕提供」/「中文字幕志愿者 李宗盛」。
    # 这两条是**字幕组/志愿者的水印**，与上一族同源（训练数据里常驻）。
    # 只钉完整短语、不钉「中文字幕」这种短词 —— 否则用户真说"中文字幕"也会被吃掉。
    "中文字幕提供", "中文字幕志愿者",
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

# 每句输出格式（main 里按 --format 覆盖）。text = 一行原文；json = 带语种标记。
# 语种标记用**插件那套 tag**（zh-CN / pt-BR），不是 whisper 的两位码。
EMIT_FORMAT = "text"

# whisper 的两位语种码 → 收件箱/插件用的 tag。表外的语种不标 ——
# 让插件按句子自动判定，比标一个它不认识的 tag 安全。
LANG_TAGS = {"zh": "zh-CN", "pt": "pt-BR", "en": "en-US"}


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
    # 5.79：命令行也能指定**引擎家族**（whisper / parakeet / tencent）。
    # 为什么需要它：`--file` 与麦克风流式模式只吃"启动时加载的那一份"，
    # 而在此之前引擎只能从策略表里来 —— 于是想用同一批音频离线量 parakeet，
    # 就必须先起整套管线、改表、再说一遍话。有了这个参数，一行命令就能量。
    # 优先级与模型相同：命令行 → 表 default → strategies → languages。
    parser.add_argument("--engine", default=None,
                        help="引擎家族：whisper（缺省）/ parakeet / tencent（策略表里的 engine 会覆盖它）")
    parser.add_argument("--device", default="cpu", help="cpu 或 cuda（本机实测两者都能跑，见 --stats）")
    parser.add_argument("--compute-type", default="int8",
                        help="int8 / int8_float32 / int8_float16 / float16 / float32"
                             "（CPU 用 int8；GPU 用 float16；Pascal 卡如 Tesla P40 没有 FP16 加速，用 int8_float32）")
    parser.add_argument("--format", default="text", choices=("text", "json"),
                        help="每句输出格式：text=一行原文（插件自动判语向）；"
                             "json={\"text\":…,\"from\":\"zh-CN\"}，语种跟着每句话走（推荐）")
    parser.add_argument("--language", default=None, help="固定语种（zh / pt）；缺省自动判定")
    # 限定候选语种：不指定 `--language` 时，只在候选里挑，而不是在 99 种语言里挑。
    #
    # 实测依据（pt-coraa 20 条真实巴葡口语，large-v3）：
    #   不限定 → 判定 {pt:19, he:1}，词错率 13.3%，那条被认成希伯来语的整句报废（100%）
    #   限定   → 只会是 pt 或 zh，整体 12.2%
    # 这个系统只可能是中文、巴葡与英语，所以"在 99 种里挑"是纯亏的自由度。
    #
    # ⚠️ 这条缺省值**漏过英语**（5.05 修，用户实测报的）：
    #    5.00 起支持三种语言，但这里仍然是 `zh,pt` —— 于是"手机没上报语种"的那些段，
    #    英语被强制按中文解码，日志里写着
    #    「语种限定生效：全局最大是 en，限定到 ('zh','pt') 后取 zh」，
    #    而出来的中文字幕是**听着像话、其实全错**的那一类（再译成葡语就更像真的了）。
    #    护栏本身没错，错的是"候选集没跟着语言数量一起改"。
    # 传空串（`--lang-candidates ""`）可以关掉限定，回到"全域挑最大"。
    parser.add_argument("--lang-candidates", default="zh,pt,en",
                        help="不指定语种时的候选集（逗号分隔，缺省 zh,pt,en；空串=不限定）")
    parser.add_argument("--file", default=None, help="转写一个音频文件而不是麦克风")
    parser.add_argument("--follow", default=None,
                        help="尾随一个**不断追加**的裸 PCM 文件（16-bit 小端、单声道）。"
                             "手机端「录音上传」走的就是这条：relay 往文件追加，这里跟着读")
    # 5.08：按说话人分轨（多语言房间必需）
    #
    # 为什么不能只有 --follow 那一条：一个房间一条音频流时，`.lang` 旁文件是"最后写入者获胜"。
    # 两个人交替用不同语言说话，切出来的段会带着**上一个人**的语种 ——
    # 表现就是"英语被当成中文识别"，而语言这件事下游无论怎么修都是补丁。
    # relay 现在按 (房间, 说话人) 各写一条 `audio/<房间>/<说话人>.pcm`，这里尾随那个目录。
    parser.add_argument("--follow-dir", default=None,
                        help="尾随一个目录里的**所有** <说话人>.pcm（每个说话人一路，"
                             "各带自己的 .rate / .lang；切出的段带 speaker）")
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
                             "② 后来用**真实口语**重量了一遍（带官方逐句时间戳的原始录音，"
                             "取 20 个连续段，同一个参考、同一套切句器做受控对照）："
                             "silence 500 → 16.8%%，800 → 15.5%%，1200 → 13.3%%，2000 → 12.2%%。"
                             "③ 再后来**跨 19 场录音**复核（每场抽 1 段，488 秒）："
                             "500 → 27.17%%，800 → 20.76%%，1200 → 19.34%%（整段离线参照 19.48%%）。"
                             "⚠️ 机制要说准：删掉的错误多了 73 个词，但只跑分段器的实测显示"
                             "**被丢掉的句内语音只有约 3.7 秒 / 488 秒（0.8%%）** —— "
                             "所以主因是**短段解码质量差**，不是「碎片被丢」（详见 docs/14 §6.7.1）。"
                             "⚠️ **缺省取 800 而不是最准的 1200 是产品取舍**（越准字幕越晚）。"
                             "字幕延迟只能**模型化估算**（段内位置 + 静音判定 + 识别），"
                             "不是实测；真要那个数必须打时间戳（docs/14 §9）。"
                             "要更准用 1200，要和以前完全一样用 500。")
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
    parser.add_argument("--context-depth", type=int, default=None,
                        help="**上下文续传**：把前 N 段已定稿的文本喂给下一段当提示词"
                             "（0 = 关）。不给就用按语种的缺省："
                             "中文 2、葡语 0 —— 见下面 CONTEXT_DEPTH_BY_LANGUAGE 的理由")
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
    parser.add_argument("--highpass-hz", type=float, default=0.0,
                        help="高通滤波截止频率（5.186）：教室/会议室里空调、桌子震动、音箱低音"
                             "会顶高能量门槛。100 几乎不伤语音；0 = 关（缺省）")
    parser.add_argument("--vad", action="store_true",
                        help="用 silero VAD 做**二次确认**（5.186）：过了能量闸之后，再用"
                             "「像不像人声」判一遍，专治'有声音但不是人'的幻听。缺省关")
    parser.add_argument("--no-vad", action="store_true", help="显式关掉 VAD（策略表里写好记得清掉）")
    parser.add_argument("--vad-max-ms", type=int, default=2000,
                        help="只对**短于这么多毫秒**的段做 VAD（缺省 2000）。"
                             "幻听几乎都发生在短段/弱段上，长段基本不会编，"
                             "这样 VAD 的耗时被压在几十毫秒以内，不影响字幕延迟")
    parser.add_argument("--lid-model", default=None,
                        help="语种识别模型目录（sherpa-onnx 的 encoder/decoder/tokens）。"
                             "给了才启用：**切句之后、引擎分发之前**判定语种。"
                             "也可以用环境变量 LEION_LID_MODEL")
    parser.add_argument("--lid-switch-after", type=int, default=2,
                        help="LID 连续几次判成同一个新语种才切换（缺省 2：防抖。"
                             "一路会场麦里判错一次就可能把整句送错引擎）")
    parser.add_argument("--lid-threads", type=int, default=0,
                        help="语种判定的线程数（缺省 0 = 自动 min(4, CPU 核数)）。"
                             "实测一台 4 核机器上 int8 + 4 线程 ≈ 139ms，单线程 ≈ 411ms —— "
                             "这一步就压在每句的延迟预算里，别用 1")
    parser.add_argument("--lid-window-ms", type=int, default=10000,
                        help="判语种时只喂**最后这么多毫秒**的音频（缺省 10000；0 = 整段都喂）。"
                             "实测成本按秒线性长：accept ≈ 27ms/秒 + compute ≈ 7ms/秒，"
                             "20 秒的段要 ~680ms；截到 10 秒省一半且照样判得准"
                             "（实测 10s → zh 正确，3s → nn 错误）")
    parser.add_argument("--lid-gap-ms", type=int, default=1500,
                        help="只在**前面静了这么多毫秒**之后才重判（缺省 1500；0 = 每段都判）。"
                             "语种是按人/按话题变的、不是按句变的：换人几乎都发生在静音之后，"
                             "所以没必要每段都花那 0.3 秒")
    parser.add_argument("--vad-threshold", type=float, default=0.5,
                        help="VAD 判人声的门槛（缺省 0.5，越大越严：0.6 更少幻听、可能漏轻话）")
    parser.add_argument("--silence-skip-level", type=float, default=SILENCE_SKIP_RMS,
                        help="原始电平（归一化之前）低于这个值就在**解码前**丢掉："
                             "既不给幻听机会，也省一次识别。缺省 0.02 与人声门槛同一个数；"
                             "实测在 0.012~0.019 的敲击/呼吸段上，Whisper 会吐「谢谢大家」「搅拌均匀」这类假字幕。")
    parser.add_argument("--self-check", action="store_true", help="只检查依赖与模型能否加载")
    # ── 生产者 / 消费者两步（显存只够一份模型时的架构）────────────────────────
    #
    # 背景：一场会一套"切句+识别"= 一份模型（large-v3 float16 约 5GB）。两场会同时开就要
    # 两份 —— 显存不够。拆成两步之后：
    #   ① `--segment-dir <dir> --tag <房间id>`：只切句（纯 CPU，**不加载模型**），
    #      每切出一段就写一个 <时间>-<房间>.pcm + .json 到队列目录；
    #   ② `--queue-dir <dir>`：只有一个进程，**模型只加载一次**，按到达顺序取队列最前面
    #      的那一段转写，把文字连同房间号一起输出。
    # 好处：两场会都能持续出字幕（各自慢一点），而不是一场彻底饿着；模型不再反复加载。
    parser.add_argument("--segment-dir", default=None,
                        help="生产者模式：只切句、不加载模型，把每段话写进这个队列目录")
    parser.add_argument("--queue-dir", default=None,
                        help="消费者模式：从这个队列目录按到达顺序取段转写（模型只加载一次）")
    parser.add_argument("--tag", default=None,
                        help="生产者模式：给切出的段打上房间 id（消费者靠它把文字送回正确的房间）")
    parser.add_argument("--room-code", default=None,
                        help="房间的 6 位邀请码（5.177）：日志里的句子编号写成 <邀请码>#<序号>，"
                             "这样'原文行 / 摘要行 / 字幕帧'能用同一个号对上。不给就只写 #<序号>")
    parser.add_argument("--log-level", default="summary", choices=["quiet", "summary", "detail", "trace"],
                        help="日志档位（5.177）：summary=每句一行摘要 + 原文（**缺省**）；"
                             "detail=再把切句/识别/延迟账逐句打出来；trace=全都打")
    parser.add_argument("--queue-poll-ms", type=int, default=60,
                        help="消费者模式：多久看一次队列（缺省 60ms）")
    parser.add_argument("--queue-depth-report-s", type=float, default=30.0,
                        help="消费者模式：每隔多少秒报一次队列深度（缺省 30；0 = 不报）。"
                             "**不丢数据**，只是把「落后多少」变成看得见的数字 —— "
                             "要不要开始丢弃，等看到真实数字再定")
    parser.add_argument("--model-map", default=None,
                        help="按语言选模型的表（JSON，5.40）。给了它，每段话就按自己的语种"
                             "查表决定用哪个模型/解码参数；改了文件会自动重新读，不用重启。"
                             "优先级：languages[语种] > strategies > default > 命令行")
    parser.add_argument("--data-dir", default=None,
                        help="数据目录（5.41）：试测/体检会用到它（例如 `asr-try` 找 `audio/<房间>/`）。"
                             "⚠️ 5.108 起它**不再**用于读房间侧车 —— 那一层已删除")
    parser.add_argument("--try-audio", default=None,
                        help="【单独试识别】只跑这一段音频（wav，或配合 --try-rate 给裸 PCM），"
                             "直接进引擎 —— 不经切句、不经队列、不经大脑。用来把"
                             "\"识别坏了\"与\"链路坏了\"分开")
    parser.add_argument("--try-rate", type=int, default=None,
                        help="--try-audio 是裸 PCM 时它的采样率（队列里的段就是这种）。"
                             "不给会去找同名 .rate 旁文件，再不行按 --samplerate")
    parser.add_argument("--try-queue", default=None,
                        help="【单独试识别】把队列目录里**现有**的段逐段跑一遍（只读，不删文件）—— "
                             "用的就是流水线真正产出的那些段，最接近现场")
    parser.add_argument("--try-offset", type=float, default=0.0,
                        help="--try-audio 从第几秒开始取（缺省 0）。分轨文件往往几分钟长，"
                             "切一小段试更快，也更接近现场被切成的那一句")
    parser.add_argument("--try-seconds", type=float, default=0.0,
                        help="--try-audio 取多长（缺省 0 = 到结尾）")
    parser.add_argument("--max-models", type=int, default=2,
                        help="模型池最多同时留在显存里的份数（缺省 2；超了淘汰最久没用的）。"
                             "⚠️ 调大就是多吃显存，不够时表现是 OOM 崩溃而不是变慢")
    args = parser.parse_args(argv)
    # 把 `--lang-candidates zh,pt` 解析成元组；空串 = 不限定（回到全域挑最大）。
    # 顺带做校验：写错了就**明确报错**，而不是静默变成一个空集（空集会让限定悄悄失效，
    # 而"护栏悄悄失效"正是最难发现的一类问题）。
    try:
        args.lang_candidates = parse_lang_candidates(args.lang_candidates)
    except ValueError as error:
        parser.error(str(error))
    # 5.177：日志档位交给模块级的那个开关（各打印点用 log_level_at_least 判断）
    _LOG_LEVEL["value"] = str(getattr(args, "log_level", "summary") or "summary")
    return args


# ── 生产者 / 消费者（切句与识别分开，见 --segment-dir / --queue-dir 的说明）──────

QUEUE_META_SUFFIX = ".json"

# ── 5.177：句子编号（`<邀请码>#<房间内序号>`）────────────────────────────────
#
# 为什么要有它：一句字幕的"一生"经过四个进程（切句 → 识别 → 大脑 → 转发），
# 而日志里各打各的 —— 想追"这句话为什么慢 / 为什么没出字"，只能靠时间戳猜。
# 现在切句时就把编号写进 meta，随数据一路带到帧里：原文行、摘要行、字幕帧用的是
# **同一个号**（用户要求：打印识别到的原文 + 对应编号，好去追踪）。
#
# 邀请码由 start-multi 通过 `--room-code` 传进来（进程内拿不到数据库）；
# 没传时退化成 `#<序号>`，房间仍能从日志前缀 `[切句·<房间>]` 看出来。
_SEG_SEQ = {}


def next_seq_id(tag, room_code=None):
    """给这一段分配编号。返回 `(序号, "邀请码#序号")`。

    <p>序号是**按房间进程内自增**的：切句进程一房间一个，重启会从 1 重来。
    真要防重号得落盘，但那会把"日志好读"换成"多一个能被写坏的文件" —— 不值。
    时间戳（每行开头）足以区分重启前后的 `#29`。
    """
    key = str(tag or "unknown")
    seq = int(_SEG_SEQ.get(key, 0)) + 1
    _SEG_SEQ[key] = seq
    prefix = str(room_code or "").strip()
    return seq, (f"{prefix}#{seq}" if prefix else f"#{seq}")


def preview(text, limit=40):
    """一句话的一行预览（截到 limit 字，超了补省略号）。

    为什么按"字"而不是"字节"：中文一行放不下几个字节，按字节截会把句子截成乱码。
    """
    flat = " ".join(str(text or "").split())
    if len(flat) <= limit:
        return flat
    return flat[:limit] + "…"


# 5.177：日志档位。缺省 summary —— 现场只看到"每句一行"，详情请加 --log-level detail。
_LOG_LEVEL = {"value": "summary"}
# 5.181：quiet 才是生产用的（只报警）；每句的原文/译文去会议记录看。
# ⚠️ 这份名单与 lib/log-levels.mjs **必须一致**（python 没法 import JS，由
# tests/log-level-suite.mjs 交叉核对；改一边就得改另一边）。
_LOG_RANK = {"quiet": 0, "summary": 1, "detail": 2, "trace": 3}

# 5.186：VAD 依赖不在时只说一次（别每段都刷）
_VAD_WARNED = {"done": False}


def log_level_at_least(level):
    """当前档位够不够打这一行（summary < detail < trace）。"""
    return _LOG_RANK.get(_LOG_LEVEL["value"], 1) >= _LOG_RANK.get(level, 2)



def _write_segment(queue_dir, tag, samplerate, audio, np, language=None, speaker=None,
                   strategy=None, room_code=None, mode=None):
    """把一段话落进队列：裸 PCM + 一份 meta。返回写出的文件名（供日志/测试）。"""
    os.makedirs(queue_dir, exist_ok=True)
    # 文件名按**时间戳**排：消费者直接按名字排序就是"到达顺序"（FIFO），
    # 不需要额外的队列索引文件 —— 少一个能被写坏的东西。
    stamp = f"{int(time.time() * 1000):013d}"
    room = str(tag or "unknown")
    seq = 0
    while True:
        base = f"{stamp}-{room}-{seq:03d}"
        pcm_path = os.path.join(queue_dir, base + ".pcm")
        if not os.path.exists(pcm_path):
            break
        seq += 1
    data = np.asarray(audio, dtype=np.float32)
    pcm = (np.clip(data, -1.0, 1.0) * 32767.0).astype(np.int16).tobytes()
    # 5.177：句子编号（`<邀请码>#<房间内序号>`）—— 随数据一路走到字幕帧
    seg_no, seg_id = next_seq_id(room, room_code)
    meta = {
        "room": room,
        "rate": int(samplerate),
        "ms": int(round(len(data) * 1000.0 / float(samplerate))),
        "seg": seg_no,
        "segId": seg_id,
        "lang": None if language is None else str(language),
        # 5.08：这段话是谁说的。分轨之后这是**数据自带的**，不用下游再猜"最近的说话人"。
        "speaker": None if speaker is None else str(speaker),
        # 5.204：说这段话的人是**面对面**还是**远程**（`onsite`/`remote`，读不到是 None）。
        # 识别端据此决定要不要判语种 —— 远程的语种本人选的，无条件相信。
        "mode": None if not mode else str(mode),
        # 5.41：这一段是用哪份**识别策略**切的（名字）。随数据一路往下走，
        # 这样 A/B 报告能按策略分组，而不是事后靠时间顺序猜"这几句是改之前还是之后"。
        "strategy": None if strategy is None else str(strategy),
        "queuedAt": int(time.time() * 1000),
    }
    # ⚠️ **先写 pcm、最后写 meta**：消费者只认 meta 存在的段。
    # 反过来的话，可能读到"有 meta、pcm 还没写完"的半段 —— 那会把半句话送去识别。
    tmp = pcm_path + ".part"
    with open(tmp, "wb") as handle:
        handle.write(pcm)
    os.replace(tmp, pcm_path)
    meta_tmp = os.path.join(queue_dir, base + QUEUE_META_SUFFIX + ".part")
    with open(meta_tmp, "w", encoding="utf-8") as handle:
        json.dump(meta, handle, ensure_ascii=False)
    os.replace(meta_tmp, os.path.join(queue_dir, base + QUEUE_META_SUFFIX))
    # 返回**基名**（不含扩展名）：消费者那边（`_pending_segments` / asr-worker）也用它当键，
    # 两边用同一个东西才不会有"多了个 .pcm 的键"这种低级错位。
    return base


# 5.192：**全局切句旋钮已删除**（原来读 `<data-dir>/segmentation.json`）。
#
# 为什么删：同一组参数有了两个来源，而全局文件**压过**识别策略表里按语种的设定 ——
# 管理台上于是永远挂着「⚠️ 全局旋钮正压着：silence_ms、min_speech_ms…」，
# 意思等于"你按语种调的值其实没生效"。而策略表本来就热读（改完下一段生效），
# "现场应急调一下"在表里同样做得到，不需要第二个文件。
#
# 现在只有一条链：内置缺省 → default → strategies[名字] → languages[语种] → 命令行（最强）。


def legacy_segmentation_file(data_dir):
    """数据目录里是否还躺着一份废弃的 `segmentation.json`（返回路径，没有就空串）。

    <p>**不删它**：里面可能有管理员手调过的值，悄悄删掉等于悄悄丢配置。
    只是提示一次，并把人指到对的地方（识别策略表）。
    """
    if not data_dir:
        return ""
    path = os.path.join(str(data_dir), "segmentation.json")
    return path if os.path.exists(path) else ""


def warn_legacy_segmentation(flag, data_dir):
    """废弃文件只提示一次（每进程一次，别每段刷一行）。"""
    if flag.get("done") is True:
        return
    path = legacy_segmentation_file(data_dir)
    if path == "":
        return
    flag["done"] = True
    print(f"[切句] ⚠️ {path} 已废弃，**不再被读取**（5.192 起全局旋钮删除）。"
          "要保留其中的值，请写进识别策略表的 segmentation（管理台「识别模型」里按语种填），"
          "这份文件可以删掉了", file=sys.stderr, flush=True)


_LEGACY_SEG_WARNED = {"done": False}


def _new_segmenter(args, np, segmentation=None, rms_threshold=None, rms_floor=None,
                   noise_multiplier=None):
    """按当前参数造一个切句器（一路音频一个：各自的能量统计必须独立）。

    <p>5.41：`segmentation` 给了就按它（来自识别策略）；没给就沿用命令行那套 ——
    所以"不配策略表"的行为与以前一模一样。

    <p>5.109：`rms_threshold` 也能由策略表给（"切句侧的电平门槛"）。给了就用它，
    没给才用命令行 `--rms-threshold` —— 这样"说话轻"的场景可以在电脑上按语种调，
    而不用重启整条管线。

    <p>⚠️ 5.111：**自适应模式（缺省开）下 `rms_threshold` 只在开头 2 秒起作用** ——
    一旦量出噪声底，门槛就变成 `max(rms_floor, 噪声底 × noise_multiplier)`。
    所以"调切句侧电平"真正要动的是 `rms_floor`（自适应下限），它同样能由表给。
    """
    seg = dict(SEGMENTATION_DEFAULTS)
    seg.update(_numbers_or_skip(segmentation, SEGMENTATION_FIELDS))
    # 5.192：全局旋钮（`<data-dir>/segmentation.json`）已删除，这里不再叠加任何文件。
    # 命令行那几项仍然最强 —— 它们走的是 _new_segmenter 的参数（rms_* / 各 ms），不是这里。
    threshold = args.rms_threshold
    if isinstance(rms_threshold, (int, float)) and rms_threshold > 0:
        threshold = float(rms_threshold)
    floor = args.rms_floor
    if isinstance(rms_floor, (int, float)) and rms_floor > 0:
        floor = float(rms_floor)
    # 5.115：噪声倍数也能由表给。这一项在**底噪高**的房间最要紧 ——
    #   门槛 = max(rms_floor, 噪声底 × 倍数)，倍数是 4 时很容易顶到安全阀（0.5×语音档），
    #   而顶到安全阀就意味着"门槛和正常说话一样高"，说话会被当静音。
    multiplier = args.noise_multiplier
    if isinstance(noise_multiplier, (int, float)) and noise_multiplier > 0:
        multiplier = float(noise_multiplier)
    return UtteranceSegmenter(
        args.samplerate, args.block_ms, seg["silence_ms"],
        seg["min_speech_ms"], seg["max_speech_ms"], threshold, args.preroll_ms, np,
        adaptive=args.adaptive, rms_floor=floor, noise_multiplier=multiplier,
        short_utterance_ms=seg["short_utterance_ms"], short_silence_ms=seg["short_silence_ms"],
        cut_pause_ms=seg["cut_pause_ms"],
    )


def _read_lang_sidecar(pcm_path):
    """读 `<pcm>.lang` 里的语种标签，返回 Whisper 语种码（读不到返回 None）。

    <p>为什么不直接用 {@link PcmFollower.read_language}：那要先有 follower，
    而 follower 的块长来自切句器，切句器又要先知道语种（5.41 的策略是按语种选的）——
    顺序上绕不开。这里只做"读一个文件"，不维护任何状态。
    """
    try:
        tag = Path(str(pcm_path) + ".lang").read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return whisper_language_of(tag)


def _read_mode_sidecar(pcm_path):
    """读 `<pcm>.mode` 里的参会方式（`onsite` / `remote`），读不到返回 `""`。

    <p>5.204：这一路是**面对面**（一部手机当会场麦）还是**远程**（他自己一个人说话），
    决定识别端要不要判语种：
      · `remote` —— 无条件相信他入会时选的语种（先验是准的，再判一次只会引入错判）；
      · 其它（`onsite` / 读不到 / 老数据）—— 切句之后由识别端判语种。

    ⚠️ 读不到时**返回空串（= 该判还得判）**，绝不返回 `remote`：
    relay 那边没登记参会方式时（老 APK、token 缺失）语种是上游兜底填的
    （`pt-BR`），把它当"本人声明"正是"说中文被按葡语解码"的老病根。
    """
    try:
        text = Path(str(pcm_path) + ".mode").read_text(encoding="utf-8").strip().lower()
    except OSError:
        return ""
    return text if text in ("onsite", "remote") else ""


def run_segment_producer_dir(args, np):
    """**按说话人分轨**的切句端（5.08，每场会一个进程）。

    为什么要有这个模式：原来一场会只有一条音频流 `audio/<房间>.pcm`，而语种旁文件
    `.lang` 是"最后写入者获胜"。两个人交替用不同语言说话时，切出来的段会带着
    **上一个人**的语种 —— 表现就是"英语被当成中文识别""我说中文，字幕却按英语出"。
    语言从源头上就分不清，下游怎么修都是补丁。

    现在 relay 按 `(房间, 说话人)` 分文件：`audio/<房间>/<说话人>.pcm`（+ `.rate` / `.lang`），
    这里尾随那个**目录**：
      · 每个文件一套 `PcmFollower` + `UtteranceSegmenter`（各自的能量底、各自的语种）；
      · 切出的段带上 `speaker`，一路传到收件箱行（下游可以按人落名字）；
      · 新说话人出现就自动开跟（不用重启进程），文件消失就丢掉那一路。

    <p><b>为什么不用"每个说话人一个进程"</b>：进程数会随人数线性长，而这里是纯 CPU 的
    能量判定 —— 一个进程里多跟几路几乎不要钱，但进程数、日志、退出管理全都要翻倍。
    """
    if not args.follow_dir:
        print("[whisper_stream] --segment-dir 需要配 --follow-dir（按说话人分轨的目录）",
              file=sys.stderr)
        return 2
    root = Path(args.follow_dir)
    try:
        root.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        print(f"[whisper_stream] 建不了分轨目录 {root}：{error}", file=sys.stderr)
        return 2
    print(f"[切句] {args.tag or '?'} 尾随分轨目录 {root} → 队列 {args.segment_dir}"
          f"（**不加载模型**；每个说话人一路，各带自己的语种）", file=sys.stderr, flush=True)
    # 5.116：把"多久没新音频就交半句"和"门槛是自适应还是固定"写进启动横幅。
    # 为什么要写：`--idle-flush-ms` 太小会在**说话中间**切句（表现是"句子很碎"），
    # 而它原来在日志里完全不可见 —— 现场只能猜。这一行以后每一场都能自证。
    gate_mode = (f"自适应（噪声底 × {args.noise_multiplier:g}，下限 {args.rms_floor}）"
                 if args.adaptive else f"固定 {args.rms_threshold}")
    print(f"[切句] {args.tag or '?'} 多久没新音频就交半句：{args.idle_flush_ms}ms"
          f"；能量门槛：{gate_mode}", file=sys.stderr, flush=True)
    # 5.192：数据目录里那份废弃的 segmentation.json 只提示一次（它已经不再被读取）
    warn_legacy_segmentation(_LEGACY_SEG_WARNED, getattr(args, "data_dir", None))

    idle = IdleTracker(args.idle_flush_ms, args.follow_poll_ms)
    idle_stop_ms = (None if args.stop_after_idle is None
                    else max(1, int(args.stop_after_idle * 1000)))
    # speaker → {follower, segmenter, language, reported, unknown, strategy, segmenter_key}
    tracks = {}
    produced = 0
    announced = set()
    # 5.41：策略表（切句这里只读它的 `segmentation` 那一半）
    table, table_problem = load_asr_models(args.model_map)
    if table_problem:
        print(f"[切句] ⚠️ 策略表有问题，先用命令行那套参数：{table_problem}",
              file=sys.stderr, flush=True)
    table_stamp = _stamp_of(args.model_map)
    if args.model_map and table:
        print(f"[切句] 策略表 {args.model_map}（改了会自动重新读，不用重启）",
              file=sys.stderr, flush=True)
        for line in describe_strategies(table):
            print(f"[切句] {line}", file=sys.stderr, flush=True)

    def strategy_for(language):
        """这一路该用哪份策略（含切句参数）。策略名会跟着段一路传到收信箱。

        <p>5.108：这里原来还叠加了一层"房间覆盖"（relay 按手机上报写的侧车）。
        手机端的模型选择早在 5.69 就删了，那一层于是变成"只可能过期、不可能正确"的负担 ——
        它的优先级还最高，实测踩过一次"表改了没生效"。现在整层删除，见 §5.108。
        """
        return resolve_strategy(language, {
            "model": args.model, "compute_type": args.compute_type, "beam_size": args.beam_size,
        }, table)

    def segmenter_key(strategy):
        """切句器的"身份"：这些值任何一个变了就得重造一个。

        <p>5.111：两个切句侧门槛（`rms_threshold` / `rms_floor`）也算进"身份" ——
        改了却不重造，表里新值就只对**新开的**那一路生效，现场看到的是"改了没反应"。
        """
        key = tuple(strategy["segmentation"].get(field) for field in SEGMENTATION_FIELDS)
        return key + (strategy.get("rms_threshold"), strategy.get("rms_floor"),
                      strategy.get("noise_multiplier"))

    def make_segmenter(strategy):
        """按策略里的切句参数造切句器（一路一个：能量统计必须独立）。"""
        return _new_segmenter(args, np, segmentation=strategy["segmentation"],
                              rms_threshold=strategy.get("rms_threshold"),
                              rms_floor=strategy.get("rms_floor"),
                              noise_multiplier=strategy.get("noise_multiplier"))

    def report_gate(name, state):
        """把这一路**实际**用的能量门槛说一次（5.112）。

        <p>为什么需要：切句器真正的门槛是**自适应算出来的**（`max(rms_floor, 噪声底×4)`，
        再加安全阀），而原来它只在 `--stats` 的结尾报表里出现 —— 也就是
        **产线（start-multi）永远看不到**。于是"我调了门槛有没有用""现在到底多少"
        只能靠猜，而这正是本项目反复踩的那类问题。

        <p>只在两个时刻各说一次：① 噪声底量出来之后（每路一次）；
        ② 安全阀被触发时（说明门槛已经顶到"较响档的一半"，行为会变）。
        """
        segmenter = state["segmenter"]
        if segmenter.noise_floor is None:
            return                       # 还没攒够 2 秒，估不了
        if not state.get("gate_reported"):
            state["gate_reported"] = True
            print(f"[切句] {args.tag or '?'} {name} 能量门槛：{segmenter.gate_report()}",
                  file=sys.stderr, flush=True)
        elif segmenter.capped and not state.get("gate_capped_reported"):
            state["gate_capped_reported"] = True
            print(f"[切句] {args.tag or '?'} {name} ⚠️ 门槛顶到安全阀（{segmenter.threshold:.4f}）："
                  f"底噪太高，已经在「不让门槛高到把说话当静音」的边界上；"
                  f"要更稳就调大 --rms-floor 或改善收音环境",
                  file=sys.stderr, flush=True)

    def track_of(name):
        """该说话人的那一路（第一次见到就开跟）。"""
        state = tracks.get(name)
        if state is not None:
            return state
        path = root / f"{name}.pcm"
        language = None if args.no_sidecar_lang else _read_lang_sidecar(path)
        if language is None:
            language = args.language
        strategy = strategy_for(language)
        segmenter = make_segmenter(strategy)
        follower = PcmFollower(path, args.samplerate, np, segmenter.block,
                              from_start=args.follow_from_start)
        follower.lang_notice = None
        state = {"follower": follower, "segmenter": segmenter, "language": language,
                 "reported": None, "unknown": False,
                 # 5.204：参会方式（`onsite`/`remote`/空）。跟着旁文件走，一路传进每段的 meta。
                 "mode": _read_mode_sidecar(path),
                 "strategy": strategy, "segmenter_key": segmenter_key(strategy)}
        tracks[name] = state
        print(f"[切句] {args.tag or '?'} {name} 策略 = {strategy['strategy']}"
              f"（切句 {', '.join(f'{k}={v}' for k, v in strategy['segmentation'].items())}）",
              file=sys.stderr, flush=True)
        if state["mode"] != "":
            print(f"[切句] {args.tag or '?'} {name} 参会方式 = "
                  + ("远程（他选的语种就当真的，不判语种）" if state["mode"] == "remote"
                     else "面对面（谁开口不一定 —— 切句之后由识别端判语种）"),
                  file=sys.stderr, flush=True)
        return state

    def flush(name, state, utterance, why=None):
        """写出一段。`why` 只为日志服务（`idle` = 被"多久没新音频"截断的）。

        <p>⚠️ 5.115：`尾部静音裁掉 0ms` 是**可疑信号** —— 靠静音收句时 tail 一定
        ≥ silence_ms（裁掉的正是那一段静音），所以 0ms 说明这句是**被 idle 截断的**，
        也就是"手机这批音频之间停顿太久了"。实机日志里大量出现，正是"句子很碎"的主因之一。
        以前这个区别只能靠人去推，现在直接写在行尾。
        """
        nonlocal produced
        if utterance is None or len(utterance) == 0:
            return
        base = _write_segment(args.segment_dir, args.tag, args.samplerate, utterance, np,
                              state["language"], speaker=name,
                              strategy=state["strategy"]["strategy"],
                              room_code=getattr(args, "room_code", None),
                              mode=state.get("mode") or None)
        produced += 1
        # 5.177：切出一段就清零"丢弃突发"计数 —— 恢复正常了，不该继续累计旧账
        burst = getattr(state["segmenter"], "drop_burst", None)
        if isinstance(burst, dict):
            burst["count"] = 0
            burst["ms"] = 0
            burst["last_print"] = 0.0
        # 每一句都把策略名打出来（用户要求：便于对照与调节）
        # 5.52：尾巴裁掉多少也带上 —— 它紧贴最后一个音节，是"句尾缺一截"的头号嫌疑
        trim = getattr(state["segmenter"], "last_tail_trim_ms", 0)
        note = ""
        if trim == 0 and why == "idle":
            note = (f"（⚠️ 不是静音收的句：连续 {args.idle_flush_ms}ms 没有新音频就交了"
                    f" —— 手机上传是断续的，这个值要比上传间隔大，见 docs/06 §4）")
        if log_level_at_least("detail"):
            print(f"[切句] {args.tag or '?'} {name} → {base}"
                  f"（{len(utterance) / args.samplerate:.1f}s，策略 {state['strategy']['strategy']}，"
                  f"尾部静音裁掉 {trim}ms，累计 {produced} 段）{note}",
                  file=sys.stderr, flush=True)

    def report(name, state):
        """这一路现在带什么语种（只在变化时报一次）。"""
        language = state["language"]
        if language is not None:
            state["unknown"] = False
            if language != state["reported"]:
                state["reported"] = language
                notice = state["follower"].lang_notice
                state["follower"].lang_notice = None
                tag = notice[0] if notice is not None else language
                print(f"[切句] {args.tag or '?'} {name} 语种 = {tag}（Whisper 码 {language}）"
                      f"→ 之后他的每段都带它", file=sys.stderr, flush=True)
            return
        if not state["unknown"]:
            state["unknown"] = True
            # 旁文件是**追加后缀**（`<pcm>.lang`），与 relay 写的位置一致
            lang_path = root / f"{name}.pcm.lang"
            print(f"[切句] {args.tag or '?'} {name} 没有语种可带（{lang_path} 读不到或为空）"
                  f"→ 他的段不带语种，识别时在 {tuple(args.lang_candidates or ())} 里按模型判定",
                  file=sys.stderr, flush=True)

    try:
        while True:
            # 5.41：策略表热加载。读到坏表就**沿用上一份好配置**（切句权重轻、改坏一个逗号
            # 不该让这整场会一句话都切不出来 —— 这一点和模型侧不同，那边宁可跳过也不换）。
            if args.model_map:
                new_stamp = _stamp_of(args.model_map)
                if new_stamp != table_stamp:
                    table_stamp = new_stamp
                    fresh, problem = load_asr_models(args.model_map)
                    if problem:
                        print(f"[切句] ⚠️ 策略表更新失败，继续用上一份：{problem}",
                              file=sys.stderr, flush=True)
                    else:
                        table = fresh
                        print(f"[切句] 策略表已重新加载", file=sys.stderr, flush=True)
                        for line in describe_strategies(table):
                            print(f"[切句] {line}", file=sys.stderr, flush=True)
            any_data = False
            try:
                names = sorted(p.stem for p in root.glob("*.pcm"))
            except OSError:
                names = []
            for name in names:
                state = track_of(name)
                if name not in announced:
                    announced.add(name)
                    print(f"[切句] {args.tag or '?'} 新的一路：{name}（{root / (name + '.pcm')}）",
                          file=sys.stderr, flush=True)
                blocks = state["follower"].read()
                if not args.no_sidecar_lang:
                    state["language"] = state["follower"].read_language(default=state["language"])
                    report(name, state)
                # 5.204：参会方式跟着旁文件走（改一次生效一次，不用重启）。
                # 为什么值得每轮读：手机上换人用、或者老客户端补登记时，
                # 这一路该不该判语种是会变的 —— 而"变了却没生效"正是本项目最贵的那类 bug。
                fresh_mode = _read_mode_sidecar(root / f"{name}.pcm")
                if fresh_mode != (state.get("mode") or ""):
                    state["mode"] = fresh_mode
                    print(f"[切句] {args.tag or '?'} {name} 参会方式 → "
                          + {"remote": "远程（不判语种）",
                             "onsite": "面对面（判语种）",
                             "": "未知（按面对面处理：判语种）"}[fresh_mode],
                          file=sys.stderr, flush=True)
                # 语种或策略表变了 → 这一路换参数。**只在没在说话时换**：
                # 手上正攒着的那句话必须按旧参数收尾，否则同一句会被两套阈值判两次
                # （那正是"半句旧参数半句新参数"的噪声，A/B 时最难解释的一种）。
                wanted = strategy_for(state["language"])
                # ⚠️ 5.115：**策略名要单独跟住语种**。原来只在 `segmenter_key` 变化时更新
                #    `state["strategy"]`，而"语种变了但切句参数一样"（比如 en-US→pt-BR
                #    都用 default 的 segmentation）时 key 不变 —— 于是段里带的策略名一直是旧的。
                #    实机表现：英文那一路写成 `策略 pt-funasr（模型 parakeet 目录）`，
                #    A/B 按策略名分组直接失效，日志自相矛盾。
                name_changed = wanted["strategy"] != state["strategy"]["strategy"]
                if segmenter_key(wanted) != state["segmenter_key"]:
                    if state["segmenter"].speaking:
                        print(f"[切句] {args.tag or '?'} {name} 策略变了"
                              f"（{state['strategy']['strategy']} → {wanted['strategy']}），"
                              f"但这一句还在说 —— 等它收尾后再换", file=sys.stderr, flush=True)
                    else:
                        state["strategy"] = wanted
                        state["segmenter_key"] = segmenter_key(wanted)
                        state["segmenter"] = make_segmenter(wanted)
                        print(f"[切句] {args.tag or '?'} {name} 换策略 → {wanted['strategy']}"
                              f"（切句 {', '.join(f'{k}={v}' for k, v in wanted['segmentation'].items())}）",
                              file=sys.stderr, flush=True)
                elif name_changed:
                    # 切句参数没变，只是名字（= 引擎/模型）变了：换名字，不重造切句器
                    state["strategy"] = wanted
                    print(f"[切句] {args.tag or '?'} {name} 策略名跟随语种 → {wanted['strategy']}"
                          f"（切句参数相同，不重造切句器）", file=sys.stderr, flush=True)
                if blocks:
                    any_data = True
                    idle.saw_data()
                    for block in blocks:
                        for utterance in state["segmenter"].push(block):
                            flush(name, state, utterance)
                    report_gate(name, state)
                elif idle.saw_nothing() and state["segmenter"].speaking:
                    flush(name, state, state["segmenter"].flush(), why="idle")
            # 文件消失（换人 / 清理）：那一路的缓冲也别丢
            for name in list(tracks.keys()):
                if name in names:
                    continue
                state = tracks.pop(name)
                flush(name, state, state["segmenter"].flush())
                print(f"[切句] {args.tag or '?'} 这一路没了：{name}", file=sys.stderr, flush=True)
            if any_data is False:
                if idle_stop_ms is not None and idle.idle_ms >= idle_stop_ms:
                    print(f"[切句] 连续 {args.stop_after_idle}s 没有新音频，收尾退出",
                          file=sys.stderr, flush=True)
                    break
                time.sleep(max(0.01, args.follow_poll_ms / 1000.0))
    except KeyboardInterrupt:
        print("\n[切句] 收到 Ctrl-C", file=sys.stderr)
    for name, state in list(tracks.items()):
        flush(name, state, state["segmenter"].flush())
    print(f"[切句] 退出：共切出 {produced} 段（{len(announced)} 路）", file=sys.stderr, flush=True)
    return 0


def run_segment_producer(args, np):
    """只切句、不加载模型（每场会一个进程，几乎不占资源）。"""
    if args.follow_dir:
        return run_segment_producer_dir(args, np)
    if not args.follow:
        print("[whisper_stream] --segment-dir 需要配 --follow（尾随那场会的 pcm）", file=sys.stderr)
        return 2
    segmenter = _new_segmenter(args, np)
    follower = PcmFollower(
        args.follow, args.samplerate, np, segmenter.block,
        follow_rate_path=args.follow_rate,
        from_start=args.follow_from_start,
    )
    language = None if args.no_sidecar_lang else follower.read_language(default=args.language)
    if language is None:
        language = args.language
    follower.lang_notice = None
    idle = IdleTracker(args.idle_flush_ms, args.follow_poll_ms)
    # 与 follow 模式一致：给了 --stop-after-idle 就自己收尾退出（测试与"手机停了"都要它）
    idle_stop_ms = (None if args.stop_after_idle is None
                    else max(1, int(args.stop_after_idle * 1000)))
    print(f"[切句] {args.tag or '?'} 尾随 {args.follow} → 队列 {args.segment_dir}"
          f"（**不加载模型**，只做能量切句）", file=sys.stderr, flush=True)
    # 语种旁文件的路径（与 PcmFollower 用的是同一个规则：`<pcm>.lang`，**追加**不是替换）
    lang_path = Path(str(args.follow) + '.lang')
    # 5.05：**没有语种这件事必须说出来**。原来它是静默降级的：
    #   切出的段 `lang: null` → 识别端退回候选集挑一个 → 英语被按中文解码，
    #   而日志里只有一行"语种限定生效"，看不出根因是"旁文件没写/没读到"。
    #   现在两种情形各报一次（启动时报一次，之后只在变化时报）：
    #     · 有语种 → 说清是什么、从哪一段起生效；
    #     · 没有语种 → 说清哪条路径读不到、这些段将不带语种、识别时会在哪些语言里挑。
    reported_language = None
    unknown_noticed = False

    produced = 0
    # 5.204：单文件模式也要带参会方式（老模式/`--try-audio` 之外的现场排障用）
    single_mode = {"value": _read_mode_sidecar(args.follow)}

    def flush(utterance):
        nonlocal produced
        if utterance is None or len(utterance) == 0:
            return
        name = _write_segment(args.segment_dir, args.tag, args.samplerate, utterance, np, language,
                              room_code=getattr(args, "room_code", None),
                              mode=single_mode["value"] or None)
        produced += 1
        if log_level_at_least("detail"):
            print(f"[切句] {args.tag or '?'} → {name}"
                  f"（{len(utterance) / args.samplerate:.1f}s，累计 {produced} 段）",
                  file=sys.stderr, flush=True)

    def report_language():
        """把"之后切出的段带什么语种"说清楚（只在变化时打印一次）。"""
        nonlocal unknown_noticed, reported_language
        if language is not None:
            unknown_noticed = False
            if language != reported_language:
                reported_language = language
                tag = follower.lang_notice[0] if follower.lang_notice is not None else language
                follower.lang_notice = None
                print(f"[切句] {args.tag or '?'} 语种 = {tag}（Whisper 码 {language}）"
                      f"→ 之后切出的每段都带它", file=sys.stderr, flush=True)
            return
        if not unknown_noticed:
            unknown_noticed = True
            print(f"[切句] {args.tag or '?'} 没有语种可带（{lang_path} 读不到或为空）"
                  f"→ 这些段不带语种，识别时在 {tuple(args.lang_candidates or ())} 里按模型判定",
                  file=sys.stderr, flush=True)

    if not args.no_sidecar_lang:
        report_language()

    try:
        while True:
            blocks = follower.read()
            if not args.no_sidecar_lang:
                language = follower.read_language(default=language)
                report_language()
            single_mode["value"] = _read_mode_sidecar(args.follow)
            if blocks:
                idle.saw_data()
                for block in blocks:
                    for utterance in segmenter.push(block):
                        flush(utterance)
            else:
                if idle.saw_nothing() and segmenter.speaking:
                    flush(segmenter.flush())
                if idle_stop_ms is not None and idle.idle_ms >= idle_stop_ms:
                    print(f"[切句] 连续 {args.stop_after_idle}s 没有新音频，收尾退出",
                          file=sys.stderr, flush=True)
                    break
                time.sleep(max(0.01, args.follow_poll_ms / 1000.0))
    except KeyboardInterrupt:
        print("\n[切句] 收到 Ctrl-C", file=sys.stderr)
    flush(segmenter.flush())
    print(f"[切句] 退出：共切出 {produced} 段", file=sys.stderr, flush=True)
    return 0


def _pending_segments(queue_dir):
    """队列里"已经写完"的段，按到达顺序（文件名即时间戳）排好。

    <p>只认 `.json` meta 存在的段：pcm 是先写的、meta 是最后写的，
    所以"有 meta"就等于"这段完整写完了"（见 `_write_segment` 的说明）。
    """
    try:
        names = os.listdir(queue_dir)
    except OSError:
        return []
    bases = sorted(name[:-len(QUEUE_META_SUFFIX)] for name in names
                   if name.endswith(QUEUE_META_SUFFIX) and not name.endswith(".part"))
    return [base for base in bases
            if os.path.exists(os.path.join(queue_dir, base + ".pcm"))]


# ── 按语言选模型（5.40）─────────────────────────────────────────────────────
#
# 用户要的能力：**不同的语言可以用不同的模型/解码参数**，而且换模型这件事
# "像插拔一样" —— 改一个 JSON 就换，不用重编译、不用改代码、最好也不用重启。
#
# 为什么这件事只能在识别进程里做（不能在手机/重启脚本里做）：
#   · 模型在服务器上，谁加载谁说话；手机只能"请求"，不能决定；
#   · 队列里**每一段都自带语种**（切句时从 `.lang` 旁文件读的），所以"这一段该用
#     哪个模型"是这一段的属性，天然属于消费它的进程。
#
# 代价必须说清楚：一个进程里并存几份模型 = 几份显存。所以有 `--max-models`（缺省 2），
# 超了就按"最久没用"淘汰。真要同时跑 3 种模型，先看显存够不够 —— 不够时的表现是
# OOM 崩溃，而不是"慢一点"，这条不藏着。
#
# 优先级（从高到低），每一级都会在日志里写明是**哪一级**决定的：
#   ① `asr-models.json` 的 `languages[<语种>]`（可以钉模型，也可以钉策略名）
#   ② `asr-models.json` 的 `strategies[<策略名>]`
#   ③ `asr-models.json` 的 `default`
#   ④ 命令行 `--model / --compute-type / --beam-size`（老行为，一个模型服务所有语种）
#
# ⚠️ 5.108：这里原来还有一级"房间覆盖"（`<data-dir>/asr-profiles/<房间>.json`，
#    relay 按手机上报写下来），现已**整层删除**。理由见 §5.108：手机端的模型选择
#    在 5.69 就删了，那一层于是只可能带着过期值，却拥有最高优先级 ——
#    实测踩过"表改了没生效"，而现场日志只能靠猜。

ASR_MODELS_FILE = "asr-models.json"

# ── 「识别策略」：一个策略 = 用哪个模型 + 怎么切句（5.41）────────────────────
#
# 为什么把两件东西放进**同一个对象**：它们总是要一起变。切句窗口从 800 调到 650 之后，
# 段变短了，同一个模型在上面可能会变得更容易"猜"，而调参的人需要**成对地**对待
# "切在哪"和"拿什么认"。分成两张表，迟早出现"切句改了、模型忘了跟"的半新半旧状态。
#
# 但要注意：这两半**由两个不同进程消费**（切句进程 / 识别进程），所以表是同一张，
# 消费方各取所需 —— 切句进程只读 `segmentation`，识别进程只读 `model/compute_type/beam_size`。
#
# 策略**必须有名字**（`default` / `en-fast` / `en-accurate`）：
# 名字会随数据往下走（队列 meta → 收件箱行 → 日志），否则 A/B 报告里全是裸数字，
# 事后根本说不清"这一句是哪个策略出的"。

# 切句侧可配的字段 → 与 UtteranceSegmenter 的参数同名，便于对照。
SEGMENTATION_FIELDS = (
    "silence_ms", "min_speech_ms", "max_speech_ms",
    "short_utterance_ms", "short_silence_ms", "cut_pause_ms",
)

# 识别侧可配的字段。`engine` 是 5.50 加的：**先选引擎家族，再选它里面的模型**。
# 为什么要分两级：`large-v3` 只在 whisper 里有意义，换成云端引擎（比如某个 ASR HTTP 接口）
# 时"模型名"和"解码参数"的概念都不一样 —— 把它们混在一层，第二个引擎就接不进来。
# 不写 engine = whisper（老行为不变）。
MODEL_FIELDS = ("engine", "model", "compute_type", "beam_size")
DEFAULT_ENGINE = "whisper"

# 5.109：两个"电平"旋钮。放在**档案这一层**（不是 segmentation 里面），
# 因为 segmentation 那一组统一按整数解析，而这两个是小数。
#   · `silence_skip_level`：识别侧，解码前按电平丢弃的门槛
#   · `rms_threshold`     ：切句侧，"算不算在说话"的门槛
LEVEL_FIELDS = ("silence_skip_level", "rms_threshold", "rms_floor", "noise_multiplier")

# 命令行没给值时的缺省（与 parse_args 的 default 保持一致；表里没写就落在这里）
SEGMENTATION_DEFAULTS = {
    "silence_ms": 800,
    "min_speech_ms": 500,
    "max_speech_ms": 30000,
    "short_utterance_ms": 800,
    "short_silence_ms": 1100,
    "cut_pause_ms": 200,
}


def _numbers_or_skip(entry, fields):
    """从一条配置里挑出这些字段的**合法整数值**（写错了就跳过这一项，不污染整份策略）。"""
    out = {}
    if not isinstance(entry, dict):
        return out
    for key in fields:
        value = entry.get(key)
        if value is None or value == "":
            continue
        try:
            number = int(value)
        except (TypeError, ValueError):
            continue
        if number > 0:
            out[key] = number
    return out


def merge_strategy(base, *layers):
    """把若干层配置叠起来（后面的覆盖前面的）；`segmentation` 逐字段合并。

    为什么要"逐字段"：只想改 silence 的人不该被迫把另外五个字段也抄一遍 ——
    抄写就是漂移的来源。没写的字段一律继承上一层。
    """
    merged = {key: value for key, value in (base or {}).items() if key != "segmentation"}
    merged["segmentation"] = dict((base or {}).get("segmentation") or {})
    for layer in layers:
        if not isinstance(layer, dict):
            continue
        for key, value in layer.items():
            if key == "segmentation":
                if isinstance(value, dict):
                    merged["segmentation"].update(_numbers_or_skip(value, SEGMENTATION_FIELDS))
                continue
            if key in ("strategy", "note", "source"):
                continue
            if value is None or value == "":
                continue
            merged[key] = value
    return merged


# ── 5.148：会议创建时**冻结**的识别策略（`<data-dir>/room-strategy/<房间>.json`）──
#
# 为什么要有这一层：`asr-models.json` 是**热读**的，管理员一改表，正在开的会
# 当场换模型（前半段一个模型、后半段另一个），事后无法归因。现在建房那一刻
# 服务端把当时的策略抄一份冻结下来，识别侧**优先读它**；读不到/坏了才回落全局表。
#
# ⚠️ 与 5.108 删掉的"手机上报的房间覆盖"是**两件不同的事**：
#   那一层来源是**客户端**（可能过期，却拥有最高优先级）；
#   这一层来源是**服务端自己的表**，且写一次不覆盖 —— 谁是真相一目了然。
ROOM_STRATEGY_DIR = "room-strategy"


def room_strategy_path(data_dir, room):
    """这场会议的快照路径；房间号要清洗成安全文件名（与 relay 那边同一套规则）。"""
    if not data_dir or not room:
        return None
    safe = re.sub(r"[^A-Za-z0-9_-]", "_", str(room))[:64] or "unknown"
    return os.path.join(str(data_dir), ROOM_STRATEGY_DIR, safe + ".json")


def load_room_strategy(data_dir, room, cache=None):
    """读冻结快照（带 mtime 缓存）。

    返回 `(snapshot|None, 说明)`；`说明` 为空表示"正常读到"，非空表示**为什么没有**。
    读不到就是"这间房没有快照"（老会议、或建房时没写成）→ 调用方回落全局表，
    **不是错误**；但"文件在、内容坏了"要能说出来，否则又变成"日志说假话"。
    """
    path = room_strategy_path(data_dir, room)
    if path is None:
        return None, "没有房间号"
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        if isinstance(cache, dict):
            cache.pop(str(room), None)
        return None, "没有冻结快照"
    if isinstance(cache, dict):
        hit = cache.get(str(room))
        if hit is not None and hit[0] == mtime:
            return hit[1], hit[2]
    try:
        with open(path, "r", encoding="utf-8") as handle:
            snapshot = json.load(handle)
    except (OSError, ValueError) as error:
        note = f"快照读不了：{type(error).__name__}"
        if isinstance(cache, dict):
            cache[str(room)] = (mtime, None, note)
        return None, note
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get("languages"), dict):
        note = "快照形状不对（缺 languages）"
        if isinstance(cache, dict):
            cache[str(room)] = (mtime, None, note)
        return None, note
    if isinstance(cache, dict):
        cache[str(room)] = (mtime, snapshot, "")
    return snapshot, ""


def nemo_local_path(name):
    """本地 .nemo 文件 → 展开后的绝对路径；否则返回空串（表示"这是个 HF 仓库名"）。

    <p>为什么必须区分：NeMo 3.x 的 `ASRModel.from_pretrained(model_name=...)` 把字符串
    **一律当仓库 id**，传本地路径会报
    `HFValidationError: Repo id must be in the form 'repo_name' or 'namespace/repo_name'`；
    本地文件要走 `ASRModel.restore_from(path)`。

    <p>判据只用"这个文件在不在"，不做别的猜测：
    `nvidia/parakeet-tdt-0.6b-v2` 这种仓库名里也带斜杠，但本地没有同名文件，
    于是自然落到"按仓库名加载"那条路。
    """
    text = str(name or "").strip()
    if text == "":
        return ""
    expanded = os.path.expanduser(text)
    return expanded if os.path.isfile(expanded) else ""


def room_profile_of(snapshot, language):
    """从快照里取**这门语言**的识别字段（只取模型这半边；切句参数不冻结）。"""
    if not isinstance(snapshot, dict):
        return None
    languages = snapshot.get("languages")
    if not isinstance(languages, dict):
        return None
    tag = language_tag(language)
    entry = languages.get(language)
    if not isinstance(entry, dict) and tag is not None:
        entry = languages.get(tag)
    if not isinstance(entry, dict):
        return None
    out = {}
    # ⚠️ `runtime`（onnx / nemo）不在 MODEL_FIELDS 里，但 parakeet 的 GPU/CPU 就靠它 ——
    #    少了它，"这场到底跑 GPU 还是 CPU"这件事会从快照里丢掉。
    for key in MODEL_FIELDS + ("runtime",):
        value = entry.get(key)
        if value is None or value == "":
            continue
        out[key] = value
    if isinstance(entry.get("strategy"), str) and entry["strategy"].strip():
        out["strategy"] = entry["strategy"].strip()
    if isinstance(snapshot.get("lockedAt"), str) and snapshot["lockedAt"].strip():
        out["locked_at"] = snapshot["lockedAt"].strip()
    return out or None


def resolve_strategy(language, cli, table=None, room_profile=None):
    """算出一段话该用的**整份识别策略**（模型 + 切句参数 + 名字 + 来源）。

    叠加顺序（后面的覆盖前面的）：
      ① 内置缺省（`SEGMENTATION_DEFAULTS` + 命令行给的模型参数）
      ② 表里的 `default`
      ③ 表里的 `strategies[名字]`（名字来自 ②/languages 的 `strategy` 字段）
      ④ 表里的 `languages[语种]`（行内可以再覆盖任意字段）

    <p>⚠️ 5.108：参数里的 `room_profile`（原第 ⑤ 层"房间覆盖"）已删除 ——
    手机端的模型控制在 5.69 就删了，这一层只可能带着过期值却拥有最高优先级。

    返回的字典包含：
      · `strategy`：策略名（日志/数据都用它，**做 A/B 时按它分组**）
      · `model` / `compute_type` / `beam_size`
      · `segmentation`：六个切句字段（切句进程用）
      · `sources`：每个部分最终是**哪一层**定的（"为什么是这个值"要有答案）
    """
    cli = cli or {}
    table = table if isinstance(table, dict) else {}

    base = {
        "model": cli.get("model"),
        "compute_type": cli.get("compute_type"),
        "beam_size": cli.get("beam_size"),
        # 5.79：命令行也能指定引擎家族（表里的 engine 会覆盖它）。
        # 不放进 base 的话 `--engine parakeet` 会被**静默忽略** —— 那正是最难查的一类错。
        "engine": cli.get("engine"),
        "segmentation": dict(SEGMENTATION_DEFAULTS),
    }
    sources = {"model": "命令行", "segmentation": "内置缺省"}

    default_layer = table.get("default") if isinstance(table.get("default"), dict) else {}
    layered = merge_strategy(base, default_layer)
    if default_layer:
        sources["model"] = "表 default"
        if default_layer.get("segmentation"):
            sources["segmentation"] = "表 default"

    # 策略名：languages 行里写的优先，其次 default 里写的，再其次 "default"
    languages = table.get("languages") if isinstance(table.get("languages"), dict) else {}
    strategies = table.get("strategies") if isinstance(table.get("strategies"), dict) else {}
    tag = language_tag(language) or (language if isinstance(language, str) else "")

    lang_entry = None
    for key in (tag, language):
        if key and key in languages:
            lang_entry = languages[key]
            break

    name = ""
    if isinstance(lang_entry, dict) and isinstance(lang_entry.get("strategy"), str):
        name = lang_entry["strategy"].strip()
    if not name and isinstance(default_layer.get("strategy"), str):
        name = default_layer["strategy"].strip()
    if not name:
        name = "default"

    named = strategies.get(name)
    if isinstance(named, dict):
        layered = merge_strategy(layered, named)
        if named.get("model") or named.get("compute_type") or named.get("beam_size"):
            sources["model"] = f"策略 {name}"
        if named.get("segmentation"):
            sources["segmentation"] = f"策略 {name}"

    if lang_entry is not None:
        layered = merge_strategy(layered, lang_entry)
        label = f"languages.{tag or language}"
        if isinstance(lang_entry, dict) and any(k in lang_entry for k in MODEL_FIELDS):
            sources["model"] = label
        if isinstance(lang_entry, dict) and lang_entry.get("segmentation"):
            sources["segmentation"] = label


    # ── 5.109：两个"电平"旋钮也随策略下来 ────────────────────────────────
    #
    # 为什么要放进表：这两个值的调法**跟语种走**（葡语说话轻、中文正常），
    # 而且它们是现场最常被问"能不能改"的两个 —— 放在表里就自动获得
    # "改完下一段生效、不用重启"这条性质（识别侧按 mtime 热读）。
    #
    #   · `silence_skip_level`：**识别侧**，"解码前先按电平丢掉"的门槛（whisper 那条路）
    #   · `rms_threshold`     ：**切句侧**，"算不算在说话"的门槛（决定切不切得出来）
    #
    # 写了非法值（非数字/≤0）就**忽略这一项**并把原因记在 sources 里 ——
    # 不让一个打错的字段把整份策略变成另一种行为。
    tuned = {}
    for label, layer in (
        ("表 default", default_layer),
        (f"策略 {name}", named if isinstance(named, dict) else {}),
        (f"languages.{tag or language}", lang_entry if isinstance(lang_entry, dict) else {}),
    ):
        for key in LEVEL_FIELDS:
            if isinstance(layer, dict) and layer.get(key) not in (None, ""):
                tuned[key] = label
    for key in LEVEL_FIELDS:
        raw = layered.get(key)
        if raw is None or raw == "":
            layered.pop(key, None)
            continue
        try:
            number = float(raw)
        except (TypeError, ValueError):
            layered.pop(key, None)
            sources[key] = f"{tuned.get(key, '?')} 里写了个非法值 {raw!r}，已忽略"
            continue
        if number <= 0:
            layered.pop(key, None)
            sources[key] = f"{tuned.get(key, '?')} 里写的 {raw!r} ≤ 0，已忽略"
            continue
        layered[key] = number
        sources[key] = tuned.get(key, "?")

    # ── 5.148：**房间冻结快照**（会议创建时锁定）优先级最高 ────────────────
    #
    # 它只有"模型这半边"（engine / runtime / model / compute_type / beam_size），
    # **不含切句参数** —— 切句属于"怎么收音"，仍按表热生效（用户 2026-11-09 定的）。
    # 名字也以快照里那个为准：这样日志/收件箱里的策略名能直接对应到"建房时锁的那份"。
    if isinstance(room_profile, dict) and room_profile:
        overlay = {key: value for key, value in room_profile.items()
                   if key not in ("strategy", "locked_at")}
        if overlay:
            layered = merge_strategy(layered, overlay)
            sources["model"] = "房间冻结（建房时锁定）"
        frozen_name = room_profile.get("strategy")
        if isinstance(frozen_name, str) and frozen_name.strip():
            name = frozen_name.strip()
        if room_profile.get("locked_at"):
            layered["strategyLockedAt"] = room_profile["locked_at"]

    layered["strategy"] = name
    layered["sources"] = sources
    layered["engine"] = str(layered.get("engine") or DEFAULT_ENGINE).strip().lower() or DEFAULT_ENGINE
    layered["segmentation"] = {key: layered["segmentation"].get(key, SEGMENTATION_DEFAULTS[key])
                               for key in SEGMENTATION_FIELDS}
    return layered


def describe_strategies(table):
    """把表里的策略摊成几行（启动日志与文档对照用）。"""
    if not isinstance(table, dict) or not table:
        return ["（没有策略表：所有语种都用命令行那一套）"]
    lines = []
    strategies = table.get("strategies") if isinstance(table.get("strategies"), dict) else {}
    for name in sorted(strategies):
        one = strategies[name] if isinstance(strategies[name], dict) else {}
        bits = []
        for key in MODEL_FIELDS:
            if one.get(key) is not None:
                bits.append(f"{key}={one[key]}")
        seg = _numbers_or_skip(one.get("segmentation"), SEGMENTATION_FIELDS)
        if seg:
            bits.append("segmentation{" + ", ".join(f"{k}={v}" for k, v in seg.items()) + "}")
        lines.append(f"  · {name}：{', '.join(bits) if bits else '（全部继承 default）'}")
    languages = table.get("languages") if isinstance(table.get("languages"), dict) else {}
    for lang in sorted(languages):
        entry = languages[lang]
        if isinstance(entry, str):
            lines.append(f"  · {lang} → 模型 {entry}（简写）")
        elif isinstance(entry, dict):
            named = entry.get("strategy")
            extra = [k for k in MODEL_FIELDS if entry.get(k) is not None]
            seg = _numbers_or_skip(entry.get("segmentation"), SEGMENTATION_FIELDS)
            bits = ([f"策略={named}"] if named else []) + [f"{k}={entry[k]}" for k in extra]
            if seg:
                bits.append("segmentation{" + ", ".join(f"{k}={v}" for k, v in seg.items()) + "}")
            lines.append(f"  · {lang}: {', '.join(bits) if bits else '（继承 default）'}")
    return lines or ["  （表是空的）"]


def load_asr_models(path):
    """读模型表。返回 `(table, problem)`；读不到/坏了都**不抛**，让调用方决定怎么报。

    <p>`problem` 非空时**保留上一次成功读到的表**（`previous`）—— 热改表时写坏一个逗号，
    不该让正在跑的识别瞬间退回一个"没人预期"的模型。
    """
    if not path:
        return {}, ""
    import json as _json
    try:
        with open(path, encoding="utf-8") as handle:
            raw = _json.load(handle)
    except FileNotFoundError:
        return {}, ""                      # 没配这张表是正常情况，不是错误
    except Exception as error:             # noqa: BLE001
        return {}, f"模型表 {path} 读不了：{type(error).__name__}: {error}"
    if not isinstance(raw, dict):
        return {}, f"模型表 {path} 顶层必须是一个对象（现在读到 {type(raw).__name__}）"
    return raw, ""


def _profile_of(entry, base):
    """把表里的一条（或命令行那组缺省）整理成统一的档案字典。"""
    profile = dict(base)
    if isinstance(entry, dict):
        for key in ("model", "compute_type", "beam_size"):
            value = entry.get(key)
            if value is None or value == "":
                continue
            if key == "beam_size":
                try:
                    profile[key] = max(1, int(value))
                except (TypeError, ValueError):
                    continue
            else:
                profile[key] = str(value)
    elif isinstance(entry, str) and entry.strip():
        # 允许 `"zh-CN": "large-v3"` 这种简写
        profile["model"] = entry.strip()
    return profile


def resolve_asr_profile(language, cli, table=None):
    """决定这一段用哪个模型/解码参数。**纯函数**（好测，也不依赖模型）。

    返回 `{"model", "compute_type", "beam_size", "source"}`，`source` 写清是
    languages / default / 命令行 哪一级决定的（日志与排障都靠它）。

    <p>⚠️ 5.108：参数里的 `room_profile`（原来的"房间覆盖"）已删除 ——
    手机端的模型控制在 5.69 就删掉了，这一层只可能带着过期值。
    """
    base = {
        "model": (cli or {}).get("model"),
        "compute_type": (cli or {}).get("compute_type"),
        "beam_size": (cli or {}).get("beam_size"),
    }
    table = table if isinstance(table, dict) else {}

    languages = table.get("languages")
    if isinstance(languages, dict):
        tag = language_tag(language) or (language if isinstance(language, str) else "")
        for key in (tag, language):
            if key and key in languages:
                profile = _profile_of(languages[key], base)
                profile["source"] = f"模型表 languages.{key}"
                return profile

    if "default" in table:
        profile = _profile_of(table.get("default"), base)
        profile["source"] = "模型表 default"
        return profile

    profile = dict(base)
    profile["source"] = "命令行"
    return profile


@contextlib.contextmanager
def _nemo_temp_wav(audio, rate=16000):
    """把 float32 [-1,1] 的段写成一个临时 16-bit 单声道 wav（给"只认路径"的 NeMo 版本）。

    <p>为什么放在模块级别而不是引擎类里：它是纯 I/O 工具，与"哪门语言/哪个引擎"无关；
    而且测试可以直接 import 它做往返验证（写出去再读回来，样点数与幅度都对得上）。
    """
    import tempfile
    import wave

    import numpy as np

    pcm = np.clip(np.asarray(audio, dtype="float32"), -1.0, 1.0)
    handle, path = tempfile.mkstemp(prefix="leion-nemo-", suffix=".wav")
    os.close(handle)
    try:
        with wave.open(path, "wb") as fp:
            fp.setnchannels(1)
            fp.setsampwidth(2)
            fp.setframerate(int(rate))
            fp.writeframes((pcm * 32767.0).astype("<i2").tobytes())
        yield path
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


class AsrEngine:
    """一个**识别引擎**的最小接口（5.50）。

    <p>为什么要这层：策略表原来只能表达"whisper 的哪个尺寸"。一旦要接 whisper 之外的
    识别（云端 ASR、设备侧 SDK 的服务器版…），"模型名"和"解码参数"就不再是同一套概念了。
    所以把"引擎家族"与"引擎内的模型"分开：

    ```
    策略: { engine: "whisper", model: "large-v3", compute_type: "int8_float32", segmentation: {...} }
           { engine: "gpt6audio", model: "default", segmentation: {...} }
    ```

    <p><b>三条实现契约</b>（写新引擎时照着做，违反任何一条都会让排障失去依据）：
    <ol>
    <li>`load()` **只做加载**，慢与不慢都在这一步；失败要抛异常，让上层"跳过这一段并留证"
        （绝不允许在引擎内部偷偷换成另一个模型 —— 那会让 A/B 结论作废）；</li>
    <li>`transcribe()` 返回 `{"text", "empty", "reason", "resolved_language"}`，
        **不要**自己写收件箱、不要自己打日志的组织格式（上层统一负责）；</li>
    <li>引擎只吃 `profile` 里它认识的字段。`args` 命名空间会整个传进来，但**别依赖**
        whisper 专有的旋钮（`--no-speech-prob` / `--min-logprob` / 上下文续传…）——
        那些对云端引擎没有意义，依赖它们等于把引擎焊死在 whisper 上。</li>
    </ol>
    """

    key = "?"
    display = "?"

    def describe(self, profile):
        """一行说明"这个策略在跑什么"（启动日志与 /status 用）。"""
        return f"{self.display}:{profile.get('model') or 'default'}"

    def needs_local_model(self, profile=None):
        """这一路的"模型"是不是**本地文件**（决定启动时要不要查缓存/目录）。

        <p>为什么要问引擎而不是在 main() 里写死：云端引擎的 `model` 字段是**引擎编码**
        （腾讯 `16k_en`）或**模型 ID**（DashScope `fun-asr-flash-…`），拿它去查本地缓存
        必然查不到 —— 而报错会说"本地没有模型，请 rsync / 换镜像"，与真实原因无关。
        """
        return True

    def load(self, profile, device):
        """加载（或建立连接）。返回一个句柄，之后原样传给 `transcribe`。"""
        raise NotImplementedError

    def transcribe(self, handle, audio, language, profile=None):
        """把一段音频转成文字。`audio` 是 16k 单声道 float32 的 numpy 数组。"""
        raise NotImplementedError


class WhisperEngine(AsrEngine):
    """本地 faster-whisper。**默认引擎，行为与 5.50 之前完全一致。**"""

    key = "whisper"
    display = "本地 whisper"

    def __init__(self, model_class, args):
        self.model_class = model_class
        self.args = args           # 只在这里读 whisper 专有旋钮，不外泄

    def describe(self, profile):
        return f"whisper:{profile.get('model') or 'default'}"

    def load(self, profile, device):
        """加载模型（含"精度这台设备跑不跑得了"的兜底）。返回 `(model, 实际精度)`。"""
        name = profile.get("model") or self.args.model
        requested = profile.get("compute_type") or "float16"
        compute, note = resolve_compute_type(requested, device)
        if note:
            print(f"[识别] {note}（策略 {profile.get('strategy') or '?'} 要求 {requested}）",
                  file=sys.stderr, flush=True)
        try:
            return self.model_class(name, device=device, compute_type=compute), compute
        except Exception as error:      # noqa: BLE001
            # 精度不支持是**硬件能力**问题（Pascal 卡没有 FP16），不是策略选择：
            # 换掉它不污染模型 A/B 的结论，但必须说清换过。
            if not is_compute_type_error(error):
                raise
            fallback = "int8_float32" if device == "cuda" else "int8"
            if fallback == compute:
                raise
            print(f"[识别] ⚠️ 这台设备跑不了 {compute}（{type(error).__name__}），"
                  f"改用 {fallback} 继续 —— 请把策略表里的 compute_type 删掉或改成 {fallback}；"
                  f"精度是硬件能力，不参与模型对比", file=sys.stderr, flush=True)
            return self.model_class(name, device=device, compute_type=fallback), fallback

    def transcribe(self, handle, audio, language, profile=None):
        model, _compute = handle
        beam = (profile or {}).get("beam_size") or self.args.beam_size
        # 5.109：电平门槛可以按策略给（表里写了就用表里的，没写才用命令行的）。
        # 这样"说话轻"的场景不用重启整条管线 —— 改表下一段就生效。
        floor = (profile or {}).get("silence_skip_level")
        if not isinstance(floor, (int, float)) or floor <= 0:
            floor = self.args.silence_skip_level
        # ── 5.197：降噪两项**不在这里做了** ───────────────────────────────
        # 以前（5.186/5.187）高通和 VAD 是 whisper 分支专有的：写在 transcribe() 里，
        # 而 parakeet / 腾讯 / 云端那些引擎走的是各自的 transcribe()，**根本不经过这里**。
        # 于是"管理台把高通开了"这件事，在英语走 parakeet 的机器上等于没开 ——
        # 界面上看着配好了，实际一行都没执行，这是最坏的一种"配了但没生效"。
        #
        # 现在统一挪到**引擎分发之前**（preprocess_segment，见 run_queue_consumer）：
        #   · 高通：所有引擎都过一遍，只在这一处；
        #   · VAD ：改成语义更稳的"判定式"——判这段里有没有人声，没有就不送去识别，
        #           **不剪音频**（剪首尾会吃音节，5.186 踩过）。
        # 所以这里显式传 0/关：不是"没配"，是"不归我管"。
        # ⚠️ 千万别在这里再按 profile 取一遍：那样会**滤两遍**（高频被削两次），
        #    听感上只是"变薄了"，日志里完全看不出来。
        text, empty, reason, overrode, kind, resolved_language = transcribe(
            model, audio, language,
            self.args.min_logprob, self.args.no_speech_prob,
            beam_size=beam,
            silence_floor=floor,
            hint_text=None if self.args.no_prompt else prompt_for(language, self.args.initial_prompt),
            context_text=None,
            do_normalize=not self.args.no_normalize,
            candidates=self.args.lang_candidates,
            highpass_hz=0.0,
            vad=False,
        )
        return {"text": text, "empty": empty, "reason": reason,
                "resolved_language": resolved_language}


class ParakeetEngine(AsrEngine):
    """NVIDIA Parakeet TDT 0.6B v2，**本地 ONNX + sherpa-onnx（CPU int8）**（5.75）。

    <p>为什么不是官方那条 NeMo 路线：部署文档写的推理框架是 NeMo 2.2（`pip install
    nemo_toolkit[asr]`，要 torch + cuDNN，几个 GB），而官方的 0.13 秒/条是 **RTX 3060
    FP16** 的成绩；我们这台是 **Tesla P40（Pascal，没有 FP16 张量核心）**，
    照抄官方配置只会慢，还会把"模型的锅"和"硬件的锅"混在一起。
    sherpa-onnx 这条路只依赖 onnxruntime（这台机器已经装了），因此可以先用 CPU 把
    **识别质量**量准，再谈硬件。

    <p><b>缺依赖时大声报错、不静默回退</b>：`load()` 里没有 try/except 兜底到 whisper ——
    悄悄换模型会让"我在测 Parakeet"变成一句假话。

    <p>模型目录（三选一，按顺序）：策略里的 `model`（就是目录路径）→ 环境变量
    `PARAKEET_MODEL_DIR` → 数据目录下的 `models/parakeet-tdt-0.6b-v2`。
    """

    key = "parakeet"
    display = "本地 parakeet"
    ENV_DIR = "PARAKEET_MODEL_DIR"
    REQUIRED_SUFFIXES = ("tokens.txt",)
    REQUIRED_PREFIXES = ("encoder", "decoder", "joiner")
    # 两种后端（5.77）：同一个引擎键，策略里用 `runtime` 字段选
    #   onnx → sherpa-onnx（CPU int8，不装 torch；适合把**准确率**量准）
    #   nemo → NeMo 2.x（GPU；适合上产线，但 P40 是 Pascal，没有 FP16 张量核心）
    RUNTIMES = ("onnx", "nemo")

    def __init__(self, model_class, args):
        self.args = args

    def needs_local_model(self, profile=None):
        # onnx 路要模型目录；nemo 路交给 NeMo 自己按仓库名下载/缓存
        return self.runtime_of(profile) == "onnx"

    def runtime_of(self, profile):


        wanted = str((profile or {}).get("runtime") or "").strip().lower() or "onnx"
        if wanted not in self.RUNTIMES:
            raise RuntimeError(
                f"parakeet 不认识的 runtime `{wanted}`：只能是 {' / '.join(self.RUNTIMES)}"
                "（onnx = sherpa-onnx CPU int8；nemo = NeMo + torch GPU）")
        return wanted

    def describe(self, profile):
        runtime = str((profile or {}).get("runtime") or "onnx").strip().lower()
        tag = "" if runtime == "onnx" else f"[{runtime}]"
        return f"parakeet{tag}:{profile.get('model') or self.ENV_DIR}"

    def model_dir(self, profile):
        """这一份 parakeet 的模型目录（找不到就抛出**能照着做**的报错）。"""
        candidates = []
        wanted = str((profile or {}).get("model") or "").strip()
        if wanted:
            candidates.append(wanted)
        env_dir = os.environ.get(self.ENV_DIR, "").strip()
        if env_dir:
            candidates.append(env_dir)
        data_dir = getattr(self.args, "data_dir", None)
        if data_dir:
            candidates.append(os.path.join(str(data_dir), "models", "parakeet-tdt-0.6b-v2"))
        for path in candidates:
            if os.path.isdir(path):
                return path
        raise RuntimeError(
            "parakeet 的模型目录找不到。试过这些位置："
            + "、".join(candidates or ["（策略里没写 model，也没有 PARAKEET_MODEL_DIR）"])
            + "。把 ONNX 目录放好，或用策略表的 model 字段指过去（目录里应有 "
            + "tokens.txt + encoder*.onnx + decoder*.onnx + joiner*.onnx）")

    def load(self, profile, device):
        """按 `runtime` 分会两条路；**缺依赖时各自报清缺什么**，不互相兜底。"""
        runtime = self.runtime_of(profile)
        if runtime == "onnx":
            return self.load_onnx(profile, device)
        return self.load_nemo(profile, device)

    def load_onnx(self, profile, device):
        """ONNX 路：sherpa-onnx + int8（这台机器只需 onnxruntime，不需要 torch）。"""
        # 1) 依赖：sherpa-onnx（这台机器上目前没装，那就直接说清楚，别在段上反复失败）
        try:
            import sherpa_onnx                                     # noqa: F401
        except ImportError as error:
            raise RuntimeError(
                "parakeet(runtime=onnx) 需要 sherpa-onnx（它只依赖 onnxruntime，不需要 torch）。"
                f"当前环境导入失败：{type(error).__name__}: {error}。"
                "装法（**由部署方执行**）：pip install sherpa-onnx。"
                "如果你想要 GPU 那条路，把策略里的 runtime 改成 nemo（需要 torch + NeMo）") from error
        directory = self.model_dir(profile)
        found = set(os.listdir(directory))
        missing = [suffix for suffix in self.REQUIRED_SUFFIXES if suffix not in found]
        for prefix in self.REQUIRED_PREFIXES:
            if not any(name.startswith(prefix) and name.endswith(".onnx") for name in found):
                missing.append(f"{prefix}*.onnx")
        if missing:
            raise RuntimeError(
                f"parakeet 模型目录 {directory} 里缺文件：{'、'.join(missing)}。"
                "（sherpa-onnx 的 NeMo transducer 模型需要 encoder/decoder/joiner 三个 onnx + tokens.txt）")
        # 线程数：8 核机器上把线程全给它最快，但**它会和切句进程/转发抢 CPU**。
        # 所以策略里可以写 `"threads": 6` 留两核；没写就用满。
        # ⚠️ 不要复用 beam_size 当线程数（那是解码宽度，语义完全不同）。
        threads = int((profile or {}).get("threads") or 0) or max(1, os.cpu_count() or 4)
        kwargs = {
            "encoder": self._pick(found, directory, "encoder"),
            "decoder": self._pick(found, directory, "decoder"),
            "joiner": self._pick(found, directory, "joiner"),
            "tokens": os.path.join(directory, "tokens.txt"),
            "num_threads": threads,
            "sample_rate": 16000,
            "feature_dim": 80,
            "decoding_method": "greedy_search",
            "provider": "cpu",
            # Parakeet 是 NeMo 导出的 transducer；sherpa-onnx 用这个值区分模型家族
            "model_type": str((profile or {}).get("model_type") or "nemo_transducer"),
        }
        try:
            recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(**kwargs)
        except Exception as error:                                  # noqa: BLE001
            raise RuntimeError(
                f"parakeet(onxx) 加载失败（目录 {directory}，参数 {sorted(kwargs)}）："
                f"{type(error).__name__}: {error}。"
                "常见原因：onnx 与 sherpa-onnx 版本不匹配，或这份导出不是 NeMo transducer"
                "（那样要在策略里把 model_type 改对）") from error
        return {"runtime": "onnx", "recognizer": recognizer, "dir": directory, "threads": threads}

    def load_nemo(self, profile, device):
        """NeMo 路：GPU + PyTorch（**预研用**，P40 上请用 fp32）。

        <p>为什么这条也写进来：它是"真上产线"的候选（sherpa-onnx 在 8 核 Haswell 上
        大概 RTF 0.3~0.8，17 秒的段要 5~14 秒）。同一个引擎键下换 `runtime` 就能 A/B，
        不必等写完另一套代码。
        """
        try:
            import nemo.collections.asr as nemo_asr                 # noqa: F401
        except ImportError as error:
            raise RuntimeError(
                "parakeet(runtime=nemo) 需要 NeMo + torch。"
                f"当前环境导入失败：{type(error).__name__}: {error}。"
                "装法（**由部署方执行**，几个 GB，且 CUDA 版本要对）："
                'pip install -U "nemo_toolkit[asr]" torch'
                "。只想量准确率的话不必装它：把 runtime 改回 onnx（sherpa-onnx，几十 MB）") from error
        name = str((profile or {}).get("model") or "").strip()
        if name == "":
            raise RuntimeError(
                "parakeet(runtime=nemo) 的 model 要写**模型名或 .nemo 路径**"
                "（例如 nvidia/parakeet-tdt-0.6b-v2），不能留空 —— ONNX 目录那条路不适用")
        precision = str((profile or {}).get("compute_type") or "").strip().lower() or "fp32"
        # ⚠️ 5.148：**本地 .nemo 走 restore_from，不能走 from_pretrained**。
        # NeMo 3.x 的 `from_pretrained(model_name=...)` 把字符串一律当 **HF 仓库 id**，
        # 传一个本地路径会直接报：
        #   HFValidationError: Repo id must be in the form 'repo_name' or 'namespace/repo_name'
        # （实测踩到：模型下好了、却报"加载失败"，看着像模型坏了，其实是走错了入口）。
        local = nemo_local_path(name)
        try:
            if local != "":
                model = nemo_asr.models.ASRModel.restore_from(local)
            else:
                model = nemo_asr.models.ASRModel.from_pretrained(model_name=name)
        except Exception as error:                                   # noqa: BLE001
            raise RuntimeError(
                f"NeMo 加载 {name} 失败（{'本地文件 restore_from' if local else '仓库名 from_pretrained'}）："
                f"{type(error).__name__}: {error}。"
                "常见原因：路径写错/文件不完整（本地 .nemo 用 restore_from）、模型名写错、"
                "没有网络或没预下载、或 NeMo 版本与模型不匹配") from error
        target = "cuda" if str(device or "").startswith("cuda") else "cpu"
        try:
            if hasattr(model, "eval"):
                model.eval()
            if hasattr(model, "to"):
                model.to(target)
            # ⚠️ Pascal（P40）没有 FP16 张量核心：fp16 在这里只会更慢甚至报错
            if precision == "fp16":
                if hasattr(model, "half"):
                    model.half()
            elif hasattr(model, "float"):
                model.float()
        except Exception as error:                                  # noqa: BLE001
            raise RuntimeError(
                f"NeMo 模型搬到 {target}/{precision} 失败：{type(error).__name__}: {error}。"
                "P40 是 Pascal（无 FP16 张量核心），请把 compute_type 删掉或写成 fp32") from error
        return {"runtime": "nemo", "model": model, "device": target, "precision": precision}

    @staticmethod
    def _pick(found, directory, prefix):
        """挑 encoder/decoder/joiner 的 onnx；**优先 int8 量化版**（CPU 上快很多）。"""
        candidates = [name for name in sorted(found)
                      if name.startswith(prefix) and name.endswith(".onnx")]
        for name in candidates:
            if "int8" in name.lower():
                return os.path.join(directory, name)
        for name in candidates:
            return os.path.join(directory, name)
        return os.path.join(directory, f"{prefix}.onnx")      # 走不到（前面已校验），留着防呆

    def transcribe(self, handle, audio, language, profile=None):
        tag = language_tag(language) or ""
        if not tag.startswith("en"):
            # ⚠️ 不"尽力而为"：英文模型喂中文不会报错，只会吐乱码 —— 那种结果比空更好骗人。
            return {"text": "", "empty": True,
                    "reason": f"parakeet 只支持英语（这一段是 {tag or '未知语种'}）→ 跳过，"
                              f"要识别这种语言请给那个语种配 whisper/云端引擎",
                    "resolved_language": language}
        if handle.get("runtime") == "nemo":
            return self.transcribe_nemo(handle, audio, language)
        recognizer = handle["recognizer"]
        stream = recognizer.create_stream()
        stream.accept_waveform(16000, audio)
        recognizer.decode_stream(stream)
        text = str(stream.result.text or "").strip()
        return {"text": text, "empty": text == "", "reason": None if text else "parakeet 没出字",
                "resolved_language": "en"}

    def transcribe_nemo(self, handle, audio, language):
        """NeMo 的 `transcribe` 在不同版本返回 str 或 Hypothesis —— 两种都要吃得下。

        <p>5.147：NeMo 对不同**输入形态**的支持按版本不同 —— 新版本直接吃 float32 ndarray，
        老版本只认**文件路径**。这条路径此前从没在真 GPU 上跑过（P40 上没装 NeMo），
        所以按"先数组、失败一次就改用临时 wav 并记住"处理：只降级一次，
        记在 handle 里（`nemo_audio_mode`），不会每段都抛一条异常、刷满日志。
        """
        model = handle["model"]
        if handle.get("nemo_audio_mode", "array") == "array":
            try:
                return self._nemo_result(model.transcribe([audio]), language, "parakeet(NeMo)")
            except Exception as error:                               # noqa: BLE001
                first = f"{type(error).__name__}: {error}"
                if not self._nemo_paths_only(error):
                    return {"text": "", "empty": True,
                            "reason": f"NeMo 转写失败：{first}",
                            "resolved_language": language}
                # 只认路径的 NeMo 版本：切成临时 wav，并记下来（后续段不再试数组）
                handle["nemo_audio_mode"] = "wav"
                print(f"⚠️ NeMo 不吃 ndarray（{first}）→ 改用临时 wav 送转写", file=sys.stderr)
        try:
            with _nemo_temp_wav(audio) as path:
                return self._nemo_result(model.transcribe([path]), language, "parakeet(NeMo)")
        except Exception as error:                                   # noqa: BLE001
            return {"text": "", "empty": True,
                    "reason": f"NeMo 转写失败（wav 模式）：{type(error).__name__}: {error}",
                    "resolved_language": language}

    @staticmethod
    def _nemo_paths_only(error):
        """这句异常是不是"NeMo 只认文件路径"那一类（决定要不要降级成 wav）。"""
        text = f"{type(error).__name__}: {error}".lower()
        return any(word in text for word in ('path', 'file', 'str', 'os.pathlike', 'not a valid'))

    @staticmethod
    def _nemo_result(result, language, who):
        """NeMo 可能返回 str 列表、Hypothesis 列表，或单条 —— 统一成我们的 {"text"} 形状。"""
        first = result[0] if isinstance(result, (list, tuple)) and result else result
        text = getattr(first, "text", first)
        text = str(text or "").strip()
        return {"text": text, "empty": text == "",
                "reason": None if text else f"{who} 没出字",
                "resolved_language": "en"}


# ── 腾讯云一句话识别（5.75）─────────────────────────────────────────────────
#
# 为什么走"一句话识别"（SentenceRecognition，REST）而不是它的实时流式：
#   · 我们的管线本身就是**按句切好**再送的（段长 0.6–20 秒），一句话接口正对形状；
#   · REST 只要标准库（urllib + hmac），不需要装腾讯 SDK —— 这台机器不许装东西；
#   · 流式要维持长连接、处理 part/final 事件，只有在"边说边出字"才划算。
# ⚠️ 参数名以腾讯文档为准，全部集中在下面 `SentenceRecognition` 的那一处；
#    第一次真调用如果报参数错，把腾讯返回的原文贴出来即可，改一处就够。
# ⚠️ 5.124：端点从"只写域名"改成**完整 URL**，并允许 `TENCENT_ASR_ENDPOINT` 覆盖。
#   两个理由，都不是为了好看：
#   ① **离线演练**：没有密钥时把端点指到本地假服务，整条调用链（签名头 / 请求体 /
#      错误分类 / 退出码）就能在测试里跑 —— 省掉的正是 docs/25 里那 8~9 轮
#      "我改代码 → 部署 → 用户重启 → 贴日志"；
#   ② 地域/专线域名与官方不同时只改环境变量，不改代码（签名用的 host 跟着 URL 走）。
TENCENT_ENDPOINT = "https://asr.tencentcloudapi.com"
TENCENT_ENDPOINT_ENV = "TENCENT_ASR_ENDPOINT"
TENCENT_SERVICE = "asr"
TENCENT_VERSION = "2019-06-14"
TENCENT_ACTION = "SentenceRecognition"
# 各语种默认用哪个引擎编码；策略里的 `model` 字段会覆盖它（直接把编码写进 model）
TENCENT_ENGINE_BY_LANG = {"en-US": "16k_en", "zh-CN": "16k_zh", "pt-BR": "16k_pt"}
# 腾讯云的引擎编码长这样：16k_en / 16k_zh / 16k_zh_large / 8k_zh……（前段是采样率）。
# ⚠️ 5.124 离线演练逮到的一个真 bug：命令行只给 `--engine tencent` 时，档案里的 model
#    仍是 whisper 那一份（large-v3），照原样当引擎编码发过去 —— 腾讯返回的是
#    "引擎类型不对"，而在现场它和"密钥错"看起来一模一样。所以**先看形状**再说。
TENCENT_ENGINE_CODE_RE = re.compile(r"^(8k|16k)_[A-Za-z0-9_-]+$")
# ⚠️ 5.126：腾讯一句话识别的**硬上限**（官方文档「接口描述」第 7 条）：
#   音频时长 ≤ 60 秒、音频文件 ≤ 3 MB（base64 之后也算）。我们在发请求**之前**就判，
#   不让一次注定失败的调用跑完 20 秒超时；错误码也翻成人话（见 TENCENT_ERROR_HINTS）。
TENCENT_MAX_AUDIO_SECONDS = 60.0
TENCENT_MAX_VOICEDATA_BYTES = 3 * 1024 * 1024


def tencent_endpoint():
    """这次调用打哪个端点：`TENCENT_ASR_ENDPOINT` 优先，缺省官方域名。返回 (url, host)。

    <p>`host` 单独返回来是因为**签名算的是 host**（`content-type;host` 那一段）。
    两者取自同一个 URL，就不会出现"请求发到 A、签名按 B 算"这种永远对不上的局面。
    """
    import urllib.parse

    raw = (os.environ.get(TENCENT_ENDPOINT_ENV) or "").strip() or TENCENT_ENDPOINT
    parts = urllib.parse.urlsplit(raw)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise RuntimeError(
            f"腾讯云端点看不懂：{TENCENT_ENDPOINT_ENV}={raw!r}。"
            f"要么删掉这个环境变量，用缺省 {TENCENT_ENDPOINT}；"
            f"要么写成 http(s)://域名 的样子（离线演练指向本地假服务：http://127.0.0.1:8765）")
    return raw, parts.netloc


# 腾讯云错误码 → "下一步该干什么"（docs/25 §6 第 3 条：报错误就要说人话并给出下一步）。
# ⚠️ 只收**已确认/文档明确**的几条（错误码取自官方「一句话识别」文档 §6）；表里没有的错误码
#    就**不添一句解释**，原样把腾讯的 JSON 带出来 —— 宁可少说，也不许把"看起来像"的推断当事实写进日志。
TENCENT_ERROR_HINTS = {
    "AuthFailure.UnauthorizedOperation": (
        "鉴权已通过，但**没有权限**：控制台开通「语音识别」，并给这个 SecretId 授权 "
        "QcloudASRFullAccess（或自定义策略允许 asr:SentenceRecognition）。"
        "能走到这条错误，说明 TC3 签名与请求参数都是对的"),
    "AuthFailure.SignatureFailure": (
        "签名对不上：先用 `node scripts/asr-doctor.mjs` 查密钥形状（尾随换行最常见），"
        "再核对这台机器的系统时间（偏差超过 5 分钟就会失败）"),
    "AuthFailure.SecretIdNotFound": (
        "SecretId 不存在：核对控制台「访问管理 → API 密钥」，注意别把 SecretKey 填进 SecretId"),
    "FailedOperation.UserNotRegistered": "语音识别服务**没开通**：控制台 → 语音识别 → 开通服务（与 CAM 授权是两件事）",
    "FailedOperation.ServiceIsolate": "账号欠费或被隔离：控制台结清/解冻后再试",
    "FailedOperation.UserHasNoAmount": "资源包耗尽：控制台购买资源包或开通后付费",
    "FailedOperation.UserHasNoFreeAmount": "免费额度用完了：控制台开通后付费或购买资源包",
    "LimitExceeded": "被限流/超配额：降低并发或稍后再试",
    "RequestLimitExceeded": "被限流/超配额：降低并发或稍后再试",
    "InvalidParameterValue.ErrorInvalidEngservice": (
        "引擎编码无效：把 model 写成官方那几个（16k_en / 16k_zh / 16k_pt / 8k_zh…，见 docs/26 §2.4）"),
    "InvalidParameterValue.ErrorVoicedataTooLong": "音频超过 60 秒：切成更短的段再发（管线的段是 0.6–30 秒）",
    "InvalidParameterValue.ErrorInvalidVoicedata": "这段音频腾讯认不了：确认是 16k 单声道 16bit 的 wav/pcm（我们发的是 wav 容器）",
    "InvalidParameter.ErrorContentlength": "DataLen 与 Data 不匹配：这是代码问题（原始字节数 vs base64 长度），把这条报给维护者",
}


def tencent_error_hint(code):
    """按错误码给一句"下一步"；不认识的码返回空串（不编解释）。"""
    return TENCENT_ERROR_HINTS.get(str(code or "").strip(), "")


def tencent_tc3_headers(secret_id, secret_key, payload, timestamp=None,
                        region="ap-shanghai", action=TENCENT_ACTION,
                        version=TENCENT_VERSION, service=TENCENT_SERVICE,
                        host=None):
    """生成 TC3-HMAC-SHA256 签名头（**纯函数**，可离线测）。

    <p>单独成函数只为一个理由：签名错的表现是 `AuthFailure.SignatureFailure`，
    而它和"密钥错""时间漂移"长得一模一样 —— 没法在函数外一眼看出是谁的锅。
    拆出来以后可以拿固定输入钉住每一步（docs 里的算法有三段派生密钥，容易写漏一段）。

    <p>`host=None` 时取 {@link tencent_endpoint} 解析出来的那个 —— 签名算的就是 host，
    所以它必须和请求真正发去的地址同源；测试里传固定 host 才能复现同一份签名。
    """
    import hashlib
    import hmac

    host = host or tencent_endpoint()[1]
    stamp = int(timestamp if timestamp is not None else time.time())
    date = time.strftime("%Y-%m-%d", time.gmtime(stamp))
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    content_type = "application/json; charset=utf-8"
    # 1) 规范请求（CanonicalRequest）：方法 / 路径 / 查询串 / 头 / 签名头 / 载荷哈希
    signed_headers = "content-type;host"
    canonical_headers = f"content-type:{content_type}\nhost:{host}\n"
    hashed_payload = hashlib.sha256(body.encode("utf-8")).hexdigest()
    canonical_request = "\n".join(["POST", "/", "", canonical_headers, signed_headers, hashed_payload])
    # 2) 待签字符串
    scope = f"{date}/{service}/tc3_request"
    string_to_sign = "\n".join(["TC3-HMAC-SHA256", str(stamp), scope,
                                hashlib.sha256(canonical_request.encode("utf-8")).hexdigest()])
    # 3) 三段派生密钥（secret_key → date → service → signing）——漏一段就永远对不上
    def _hmac(key, message):
        return hmac.new(key, message.encode("utf-8"), hashlib.sha256).digest()

    secret_date = _hmac(("TC3" + secret_key).encode("utf-8"), date)
    secret_service = _hmac(secret_date, service)
    secret_signing = _hmac(secret_service, "tc3_request")
    signature = hmac.new(secret_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    return {
        "Authorization": (f"TC3-HMAC-SHA256 Credential={secret_id}/{scope}, "
                          f"SignedHeaders={signed_headers}, Signature={signature}"),
        "Content-Type": content_type,
        "Host": host,
        "X-TC-Action": action,
        "X-TC-Timestamp": str(stamp),
        "X-TC-Version": version,
        "X-TC-Region": region,
    }, body


def pcm16_wav_bytes(audio, rate=16000):
    """float32 [-1,1] → 16-bit 单声道 WAV 字节串（云端接口要的是音频文件，不是裸 PCM）。"""
    import io
    import wave

    import numpy as np

    samples = np.clip(np.asarray(audio, dtype=np.float32), -1.0, 1.0)
    pcm = (samples * 32767.0).astype("<i2").tobytes()
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(pcm)
    return buffer.getvalue()


def secret_file_read_error(path, error):
    """把"读密钥文件失败"说成一句能照做的话 —— 权限错是这一类里最常见的一种（5.132）。

    <p>真机现场：`/etc/leion/tencent.csv` 是 `600` 归 root，而**服务不是 root 跑的**
    （或 `/etc/leion` 是 700），于是 python 侧 `open()` 直接
    `PermissionError: [Errno 13] Permission denied`，日志里每段一句、读起来像"腾讯坏了"。
    光说"读失败"不够：这里把两种修法都写清楚，并给出"先确认服务用户是谁"的命令。
    """
    message = (f"读密钥文件失败（{TencentEngine.ENV_FILE}={path}）："
               f"{type(error).__name__}: {error}")
    if isinstance(error, PermissionError):
        message += (
            "\n→ **服务用户读不到这个文件**。先确认服务用户：`systemctl show leion -p User`，然后二选一："
            "① 让它能读 —— `sudo chown <服务用户> " + str(path) + "`（仍保持 600）或 "
            "`sudo chgrp <服务用户> " + str(path) + " && sudo chmod 640 " + str(path) + "`；"
            "② 更省事：把 TENCENT_ASR_SECRET_ID / TENCENT_ASR_SECRET_KEY 直接写进 "
            "/etc/leion/secrets.env —— 那份由 **systemd(以 root) 解析**，任何服务用户都能拿到。"
            "改完必须 `sudo systemctl restart leion`")
    return RuntimeError(message)


class TencentEngine(AsrEngine):
    """腾讯云一句话识别（云端，按句调用）。**密钥从环境变量读，不进仓库。**"""

    key = "tencent"
    display = "腾讯云一句话识别"

    def needs_local_model(self, profile=None):
        return False        # 云端：可用性取决于密钥，不是本地文件
    ENV_ID = "TENCENT_ASR_SECRET_ID"
    ENV_KEY = "TENCENT_ASR_SECRET_KEY"
    ENV_REGION = "TENCENT_ASR_REGION"
    # 5.76：也可以把密钥放**文件**里（JSON 或腾讯控制台导出的 CSV），再用这个变量指过去。
    # 为什么需要：环境变量会进 shell history / systemd 单元文件；把密钥放一个 chmod 600 的
    # 文件里更安全，也更不容易在 ps 里被看到。
    ENV_FILE = "TENCENT_ASR_SECRET_FILE"

    def __init__(self, model_class, args):
        self.args = args

    def describe(self, profile):
        return f"tencent:{self.engine_code(profile, 'en-US')}"

    def read_secret_file(self):
        """从 `TENCENT_ASR_SECRET_FILE` 读 SecretId/SecretKey（JSON 或带表头的 CSV）。"""
        path = os.environ.get(self.ENV_FILE, "").strip()
        if not path:
            return {}
        text = open(path, encoding="utf-8-sig").read()
        stripped = text.strip()
        if stripped.startswith("{"):
            data = json.loads(stripped)
            return {key.lower(): str(value).strip() for key, value in data.items()}
        rows = [line.split(",") for line in stripped.splitlines() if line.strip()]
        if len(rows) >= 2:
            header = [name.strip().lower() for name in rows[0]]
            return dict(zip(header, [value.strip() for value in rows[1]]))
        raise RuntimeError(
            f"密钥文件 {path} 的格式不认识：要 JSON（键是 SecretId / SecretKey）"
            f"或带表头的 CSV（SecretId,SecretKey）")

    def engine_code(self, profile, language):
        """这一段用哪个引擎编码：策略的 `model` 直接写编码就覆盖语言默认值。"""
        wanted = str((profile or {}).get("model") or "").strip()
        if wanted:
            # ⚠️ 5.124：model 里可能是 whisper 的模型名（`--engine tencent` 但没给 `--model` 时
            #    档案里就是 large-v3）。把它当引擎编码发出去，腾讯会说"引擎类型不对"，
            #    而现场那和"密钥错"长得一样 —— 所以在**发请求之前**先按形状拦下来。
            if not TENCENT_ENGINE_CODE_RE.match(wanted):
                raise RuntimeError(
                    f"腾讯云引擎的 model 是**引擎编码**（形如 16k_en / 16k_pt / 8k_zh），"
                    f"但这一份写的是 {wanted!r}。这通常是命令行只给了 `--engine tencent`、"
                    f"没有同时给 `--model 16k_en`（于是沿用了 whisper 的模型名）。"
                    f"两种改法：命令行加 `--model 16k_en`；或在策略表里把该语种指向 "
                    f"`en-tencent` 这种把 model 写成引擎编码的策略")
            return wanted
        tag = language_tag(language) or ""
        code = TENCENT_ENGINE_BY_LANG.get(tag)
        if code is None:
            raise RuntimeError(
                f"腾讯云引擎不知道怎么处理语种 {tag or '未知'}：已知 {sorted(TENCENT_ENGINE_BY_LANG)}。"
                "要加就改 TENCENT_ENGINE_BY_LANG，或在策略里把 model 写成引擎编码（例如 16k_en）")
        return code

    def load(self, profile, device):
        secret_id = os.environ.get(self.ENV_ID, "").strip()
        secret_key = os.environ.get(self.ENV_KEY, "").strip()
        region = os.environ.get(self.ENV_REGION, "").strip()
        if not secret_id or not secret_key:
            # 环境变量没给就试密钥文件（5.76：更安全，也不会在 ps 里露出来）
            try:
                from_file = self.read_secret_file()
            except RuntimeError:
                raise
            except Exception as error:                              # noqa: BLE001
                raise secret_file_read_error(os.environ.get(self.ENV_FILE), error) from error
            secret_id = secret_id or from_file.get("secretid", "")
            secret_key = secret_key or from_file.get("secretkey", "")
            region = region or from_file.get("region", "")
        if not secret_id or not secret_key:
            # ⚠️ 这里**不**退回到 whisper：静默换引擎会让 A/B 结论作废
            raise RuntimeError(
                f"腾讯云引擎缺少密钥：设置环境变量 {self.ENV_ID} / {self.ENV_KEY}，"
                f"或者把密钥放进文件再用 {self.ENV_FILE} 指向它"
                f"（JSON 或带表头 SecretId,SecretKey 的 CSV；可选 {self.ENV_REGION}，缺省 ap-shanghai）。"
                "密钥只从环境变量/文件读，不写进仓库。")
        return {
            "secret_id": secret_id,
            "secret_key": secret_key,
            "region": region or "ap-shanghai",
        }

    def transcribe(self, handle, audio, language, profile=None):
        import base64
        import urllib.error
        import urllib.request

        code = self.engine_code(profile, language)
        url, host = tencent_endpoint()
        # ⚠️ 5.126：先判腾讯的硬上限（≤60 秒 / ≤3 MB）。这一步在**任何网络请求之前** ——
        #    超限的段腾讯必然回 ErrorVoicedataTooLong，白等一次超时、日志还更容易看错。
        seconds = len(audio) / 16000.0
        if seconds > TENCENT_MAX_AUDIO_SECONDS:
            return {"text": "", "empty": True,
                    "reason": f"这段音频 {seconds:.1f}s，超过腾讯一句话识别的 {TENCENT_MAX_AUDIO_SECONDS:.0f}s 上限："
                              "切成更短的段再发（管线里切出来的段是 0.6–30s，不会撞到这条）",
                    "resolved_language": language}
        wav = pcm16_wav_bytes(audio)
        if len(wav) > TENCENT_MAX_VOICEDATA_BYTES:
            return {"text": "", "empty": True,
                    "reason": f"这段 wav 有 {len(wav)} 字节，超过腾讯的 "
                              f"{TENCENT_MAX_VOICEDATA_BYTES // (1024 * 1024)} MB 上限：切成更短的段再发",
                    "resolved_language": language}
        payload = {
            "EngSerViceType": code,
            "SourceType": 1,               # 1 = 音频数据（0 是音频 URL）
            "VoiceFormat": "wav",
            "Data": base64.b64encode(wav).decode("ascii"),
            "DataLen": len(wav),           # 原始字节数（**不是** base64 之后的长度）
            "UsrAudioKey": "leion-live",   # 腾讯要求调用方给的一句话标识
        }
        headers, body = tencent_tc3_headers(handle["secret_id"], handle["secret_key"], payload,
                                           region=handle["region"], host=host)
        request = urllib.request.Request(
            url, data=body.encode("utf-8"), headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                reply = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")[:400]
            return {"text": "", "empty": True,
                    "reason": f"腾讯云 HTTP {error.code}：{detail}", "resolved_language": language}
        except Exception as error:                                  # noqa: BLE001
            return {"text": "", "empty": True,
                    "reason": f"腾讯云请求失败：{type(error).__name__}: {error}",
                    "resolved_language": language}
        response = (reply or {}).get("Response") or {}
        problem = response.get("Error")
        if problem:
            # 把腾讯自己的错误**原样**带出来：参数名错了、密钥错了、欠费了，都能从这句看出来。
            # 再按错误码补一句"下一步"—— 但只对认识的码补（不认识就不编，见 TENCENT_ERROR_HINTS）。
            hint = tencent_error_hint(problem.get("Code"))
            reason = "腾讯云返回错误：" + json.dumps(problem, ensure_ascii=False)
            if hint:
                reason += f"\n→ {hint}"
            return {"text": "", "empty": True, "reason": reason, "resolved_language": language}
        text = str(response.get("Result") or "").strip()
        return {"text": text, "empty": text == "", "reason": None if text else "腾讯云没出字",
                "resolved_language": language}


# ── 阿里 DashScope Fun-ASR（5.84）────────────────────────────────────────────
#
# 为什么是它：用户那份 500 条 CORAA 巴葡评测里，Fun-ASR 是**最快且唯一 100% 成功**的
# （P50/P95 = 938/3202 ms，微平均 WER 19.81%）。准确率最高的是豆包（16.02%），
# 但 P95 5362 ms —— 两个都接，用策略表 A/B，而不是先替用户选。
#
# 协议形状（DashScope 实时语音识别，WebSocket + JSON 控制帧）：
#   连 wss://dashscope.aliyuncs.com/api-ws/v1/inference，头 `Authorization: bearer <key>`
#   发 run-task → 收 task-started → 发**二进制**音频帧 → 发 finish-task
#   → 收若干 result-generated（payload.output.sentence.text）→ task-finished
# ⚠️ 所有字段名都集中在这一处；第一次真调用若报错，把 DashScope 的原文贴出来改这里就够。
DASHSCOPE_WS_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/inference"
# ⚠️ 5.90：实时语音识别的端点往往是**账号/工作空间专属**的域名
#   （百炼控制台示例：wss://ws-xxxx.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference）。
# 连公共域名的表现是：**鉴权通过、但模型报 InvalidParameter**（不是 ModelNotFound）
#   —— 看起来像"参数错"，实际是"连错了端点"。所以这里允许用环境变量覆盖。
DASHSCOPE_ENV_WS_URL = "DASHSCOPE_WS_URL"
# ⚠️ 不同账号「模型广场」里可见的 ASR 模型**不一样**（实测：某个账号能看到
# `fun-asr-flash-2026-06-15` / `qwen3-asr-flash-realtime` / `qwen-audio-3.0-asr-flash`，
# 却**没有** `fun-asr-realtime`）。所以这里**不给默认值**：模型 ID 必须写在策略表里，
# 代码不猜 —— 猜错的表现是"连接成功但 task-failed"，比缺参数更难查。
DASHSCOPE_MODEL_HINTS = ("fun-asr-flash-2026-06-15", "qwen3-asr-flash-realtime",
                         "fun-asr-realtime", "paraformer-realtime-v2")
# ⚠️ 5.99：收到最后一个 result-generated 之后，**多久没新事件就算说完了**。
#   为什么要这个：有些账号/模型只回 result-generated、**不回 task-finished**，
#   照原样等满 30 秒上限的话，每段话都要白等 30 秒 —— 2 秒的音频、30 秒的延迟，
#   现场表现就是"一直没有输出"。判据改成"安静了没有"，比"等它说结束"可靠。
#   取 1.2 秒：中文/葡语的实时识别增量间隔通常 200~600 ms，1.2 秒足够区分
#   "还在出字"和"说完了"；太小会把一句话截成两半（那样反而更糟）。
CLOUD_QUIET_FLUSH_S = 1.2
# 一个字都没收到时最多等多久（这是"服务端彻底不给东西"的上限，不是常态等待）
CLOUD_RESULT_WAIT_S = 30.0
# ⚠️ 5.103：关闭握手的等待上限。websockets 默认 10 秒，而我们对端常常不回关闭帧 ——
#   于是**每段白等 10 秒**（识别 1 秒、退出 10 秒）。压到 1 秒后实测仍撞满（`断开 1.00s`），
#   说明对端**从不**回关闭帧。文本在关闭之前就已经收在手里了，所以再压到 0.35 秒：
#   一段省下 0.65 秒，占一次调用的近三成。
CLOUD_CLOSE_TIMEOUT_S = 0.35


def _mask_secret(value):
    """把密钥遮成 `sk-ws-…L74yg（56 字符）` —— 够认出来，又不至于被截图带走。"""
    text = str(value or "")
    if len(text) <= 10:
        return f"（{len(text)} 字符）"
    return f"{text[:6]}…{text[-4:]}（{len(text)} 字符）"


def normalize_api_key(raw, env_name="DASHSCOPE_API_KEY"):
    """把环境变量里的密钥整理成**能放进 HTTP 头**的字符串，整理不了就大声报错。

    <p>⚠️ 5.98 真实事故：`websockets.exceptions.InvalidHeaderValue:
    invalid Authorization header` —— 一条第三方 traceback，看不出任何线索。
    真因是**密钥里混进了换行**（长 key 复制时被折成两行，或者从 Windows 文件里
    带着 `\\r\\n` 贴进来）。而 `.strip()` 只去两头，中间那个换行会一路送到
    `Authorization` 头上，被 HTTP 头校验拒掉。

    <p>为什么是"清掉空白"而不是"报错"：API Key 里**不存在**有意义的空白字符，
    把它当错误拒绝，只会让人对着一个看起来完全正确的字符串发愁。真正没法救的是
    非 ASCII 或控制字符 —— 那种必须点名说出是哪个字符、在第几位。

    <p>顺带收拾三种最常见的粘贴事故（都不静默，都会说一句）：
      · 连 `export DASHSCOPE_API_KEY=` 一起贴进来；
      · 带着成对的引号；
      · 带着 `bearer ` 前缀（我们在请求里会再加，重复了就是错）。
    另外：如果值看起来是 `wss://…`，那是**把两个变量接反了** —— 直接点出来。

    @returns (key, notes) —— notes 是"清洗时动过什么"的人话列表（没有就是空表）
    """
    text = "" if raw is None else str(raw)
    notes = []
    # ① 连 `export XXX=` 一起贴进来（最常见的复制方式）
    if "=" in text:
        head, _, tail = text.partition("=")
        if head.strip().endswith(env_name) or head.strip().endswith(env_name.split("_")[-1]):
            text = tail
            notes.append(f"值里带着 `{head.strip()}=` 前缀，已去掉")
    text = text.strip()
    # ② 成对引号
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'":
        text = text[1:-1]
        notes.append("值外面包了一层引号，已去掉")
    # ③ 头部 `bearer ` / `Bearer `（请求里会再加一次）
    lowered = text.lower()
    for prefix in ("bearer ", "bearer:"):
        if lowered.startswith(prefix):
            text = text[len(prefix):].lstrip()
            notes.append(f"值里带着 `{prefix.strip()}` 前缀，已去掉（请求头里会自动加）")
            break
    # ④ 任何位置的空白/控制字符（换行最常见）：API Key 里不可能有意义
    cleaned = "".join(ch for ch in text if not (ch.isspace() or ord(ch) < 0x21 or ord(ch) == 0x7f))
    if cleaned != text:
        how_many = len(text) - len(cleaned)
        notes.append(f"值里有 {how_many} 个空白/控制字符（换行最常见），已去掉 —— "
                     "HTTP 头放不下它们，会报 InvalidHeaderValue")
        text = cleaned
    if not text:
        raise RuntimeError(
            f"{env_name} 是空的（去掉空白之后什么都不剩）。"
            "DashScope 的密钥要从控制台复制**完整一行**再 export："
            f"export {env_name}='sk-…'")
    # ⑤ 两个变量接反了：值看着像端点
    if text.lower().startswith(("wss://", "ws://", "https://", "http://")):
        raise RuntimeError(
            f"{env_name} 里填的是**端点地址**（{text[:24]}…），不是密钥 —— "
            "多半是把 DASHSCOPE_API_KEY 和 DASHSCOPE_WS_URL 接反了")
    # ⑥ 剩下的必须都是可见 ASCII；否则点名说是哪个字符
    for index, ch in enumerate(text):
        if ord(ch) > 0x7e or ord(ch) < 0x21:
            raise RuntimeError(
                f"{env_name} 第 {index + 1} 个字符是 {ch!r}（U+{ord(ch):04X}），"
                "它放不进 HTTP 头。请重新复制**一整行**密钥"
                f"（现在看到的是 {_mask_secret(text)}）")
    if not text.startswith("sk-"):
        # 不拦（有些代理网关的 key 不是这个前缀），但要说 —— 多半是拿错了变量
        notes.append(f"这个值不是以 `sk-` 开头（{_mask_secret(text)}），"
                     f"确认一下 {env_name} 填的是 DashScope 的密钥而不是别的服务")
    return text, notes


def _describe_header(header):
    """把服务端返回的 header 读成一句话：**错误码 + 完整错误信息**。

    <p>为什么要拆开写：实测里错误码（ModelNotFound / InvalidParameter）就能定性，
    而错误信息里才有"哪个参数不对"。截断成 120 字符会把后半句切掉。
    """
    code = str(header.get("error_code") or "")
    message = str(header.get("error_message") or header.get("message") or "")
    if code or message:
        return f"[{code or '?'}] {message}".strip()
    return json.dumps(header, ensure_ascii=False)


class FunAsrEngine(AsrEngine):
    """阿里 DashScope 实时语音识别（Fun-ASR），按句调用一次 WebSocket。"""

    key = "funasr"
    display = "DashScope Fun-ASR"

    def needs_local_model(self, profile=None):
        return False        # 云端：可用性取决于密钥，不是本地文件
    ENV_KEY = "DASHSCOPE_API_KEY"

    def __init__(self, model_class, args):
        self.args = args

    def __init__(self, model_class, args):
        self.args = args
        # 5.99：只在**第一次**遇到"没回 task-finished"时打一行说明，之后不再刷屏
        self._noted_quiet_flush = False

    def describe(self, profile):
        return f"funasr:{profile.get('model') or '(未指定模型)'}"

    def ws_url(self):
        """用哪个 WebSocket 端点：环境变量优先（账号专属域名）。"""
        return os.environ.get(DASHSCOPE_ENV_WS_URL, "").strip() or DASHSCOPE_WS_URL

    def load(self, profile, device):
        try:
            import websockets.sync.client                          # noqa: F401
        except ImportError as error:
            raise RuntimeError(
                "funasr 需要 websockets 包（DashScope 的实时识别是 WebSocket 协议）。"
                f"当前环境导入失败：{type(error).__name__}: {error}。"
                "装法（**由部署方执行**）：pip install websockets") from error
        # ⚠️ 5.98：不能只 `.strip()`。实测密钥被折成两行贴进来时，中间那个换行会一路
        #    送到 Authorization 头上，报的是第三方 traceback（InvalidHeaderValue），
        #    看不出任何线索。normalize_api_key 会清掉空白并在真救不了时点名说是哪个字符。
        api_key, key_notes = normalize_api_key(os.environ.get(self.ENV_KEY, ""), self.ENV_KEY)
        for note in key_notes:
            print(f"[whisper_stream] ⚠️ {self.ENV_KEY}：{note}", file=sys.stderr)
        if not api_key:
            raise RuntimeError(
                f"funasr 缺少 API Key：请设置环境变量 {self.ENV_KEY}"
                "（DashScope 控制台里创建；只从环境变量读，不写进仓库）")
        model = str((profile or {}).get("model") or "").strip()
        if not model:
            # ⚠️ 不给默认模型：账号之间可用模型不同，猜错只会得到 task-failed
            raise RuntimeError(
                "funasr 的模型 ID 必须写在策略表里（`\"model\": \"…\"`）—— 不同账号「模型广场」"
                f"里可见的 ASR 模型不同，代码不猜。常见候选：{'、'.join(DASHSCOPE_MODEL_HINTS)}；"
                "以你那台账号控制台里显示的名称为准")
        return {"api_key": api_key, "model": model}

    def transcribe(self, handle, audio, language, profile=None):
        """一句话一条连接：run-task → **等 task-started** → 音频 → finish-task → 收文本。

        <p>为什么不用长连接池：我们的段是**离散的整句**（0.6–20 秒），每段一条连接
        换来的是"没有跨句状态"—— 而跨句状态正是同传里最难查的那类 bug。
        代价是每段多一次握手（几十毫秒），可接受。

        <p>⚠️ 5.88：必须**先收到 `task-started` 再发音频**。实测直接连发会拿到
        `1007 invalid frame payload data` —— 服务端还没进入接收状态，二进制帧被当成
        非法载荷。这个错看起来像"音频格式不对"，其实是**时序**问题，所以这里把顺序写死。
        """
        import json as _json

        # ⚠️ `np` 在这个脚本里是 main() 的**局部变量**（load_dependencies 的返回值），
        # 不是模块级全局 —— whisper 那条路靠参数把 np 传下去，模块级函数要用就自己 import。
        # 实测踩过：这里直接写 np.clip(...)，第一段就 NameError（预热那条还被我 try 吞了）。
        import numpy as np
        from websockets.sync.client import connect

        model = handle["model"]
        task_id = f"leion-{int(time.time() * 1000)}"
        parameters = {"format": "pcm", "sample_rate": 16000}
        # 5.93：语言提示。策略里写 `"language_hints": ["pt"]` 就带上（Fun-ASR 用它压语种）；
        # 不写就不带 —— 让服务端自己判断。**不猜**：把 en 硬塞给葡语模型会让它把葡语当英语。
        hints = (profile or {}).get("language_hints")
        if isinstance(hints, list) and hints:
            parameters["language_hints"] = [str(one).strip() for one in hints if str(one).strip()]
        run_task = {
            "header": {"action": "run-task", "task_id": task_id, "streaming": "duplex"},
            "payload": {
                "task_group": "audio", "task": "asr", "function": "recognition",
                "model": model,
                "parameters": parameters,
                "input": {},
            },
        }
        samples = np.clip(np.asarray(audio, dtype=np.float32), -1.0, 1.0)
        pcm = (samples * 32767.0).astype("<i2").tobytes()
        # ⚠️ 5.88：DashScope 的 result-generated 是"当前这句的最新文本"（增量更新），
        # **不是**新句子 —— 直接列表拼接会把「bom dia」+「bom dia como vai」拼成
        # 「bom diabom dia como vai」（实测就是这么复现的）。所以按 sentence_id 取最后一版。
        sentences = {}
        order = []
        last_event = ""
        # 最后一次收到 result-generated 的时刻（5.99：用来判断"安静了没有"，而不是干等）
        last_text_at = None
        saw_finished = False

        def parse(message):
            """返回 (event_name, event_dict)；非 JSON 返回 ("", {})。"""
            if isinstance(message, (bytes, bytearray)):
                return "", {}
            try:
                event = _json.loads(message)
            except Exception:                                      # noqa: BLE001
                return "", {}
            return str((event.get("header") or {}).get("event") or ""), event

        def joined_text():
            """把按 sentence_id 存下的最新文本拼成一句。成功与超时两条路都用它。"""
            parts = [sentences[key].strip() for key in order if sentences[key].strip()]
            # 句间分隔：中日韩不加空格，其余加一个空格
            return ("" if has_cjk(" ".join(parts)) else " ").join(parts).strip()

        def collect(event):
            """result-generated → 按 sentence_id 记住这句的**最新**文本。"""
            sentence = (((event.get("payload") or {}).get("output") or {}).get("sentence") or {})
            piece = str(sentence.get("text") or "")
            key = sentence.get("sentence_id")
            if key is None:
                # 没有 id 的服务端版本：把每一次当成新句子（宁可多句，不要拼错）
                key = f"anon-{len(order)}"
            if key not in sentences:
                order.append(key)
            if piece.strip() or key not in sentences:
                sentences[key] = piece

        # ⚠️ 5.102：**分阶段计时**。实测 `asr-try` 上 8 秒音频花了 11.8 秒（RTF 1.47）——
        #    这种"整体慢"的报法没法定位：是握手慢、送音频慢，还是服务端算得慢？
        #    四段各自计时，一眼就知道该优化哪儿（也才知道该不该换模型 ID）。
        timings = {}
        _t0 = time.perf_counter()

        def with_timings(payload):
            payload["timings"] = dict(timings)
            return payload

        try:
            # ⚠️ 5.103：**`close_timeout` 必须显式给**。默认 10 秒 —— 而且它不是"最多等 10 秒"，
            #    实测服务端不回应关闭握手时它是**真的等满约 10 秒**。
            #    分阶段计时一看就清楚了：连接 0.14 + 等开始 0.03 + 送音频 0.03 + 收结果 1.00 =
            #    1.2 秒，而总耗时 11.2 秒 —— 那 10 秒全花在 `with` 退出（ws.close()）上，
            #    也就是**识别早就做完了，我们在等一个礼貌的再见**。
            #    每段白搭 10 秒，队列必然越积越深 —— 现场表现就是"一直没有输出"。
            with connect(self.ws_url(), max_size=None, open_timeout=10,
                         close_timeout=CLOUD_CLOSE_TIMEOUT_S,
                         additional_headers={"Authorization": f"bearer {handle['api_key']}"}) as ws:
                # (连上了就把实际用的端点记下来；出错时能分辨是不是连错地方)
                timings["connect"] = round(time.perf_counter() - _t0, 3)
                used_url = self.ws_url()
                ws.send(_json.dumps(run_task, ensure_ascii=False))
                # ① 等 task-started（这一步漏了就 1007）
                started = False
                deadline = time.time() + 15
                started_at = time.perf_counter()
                while time.time() < deadline and not started:
                    try:
                        name, event = parse(ws.recv(timeout=max(0.2, deadline - time.time())))
                    except TimeoutError:
                        # 我们给的等待到期了 —— 交给下面那句人话去解释，
                        # 别让 TimeoutError 冒到外层的"请求失败"里（那样看不出是卡在哪一步）
                        break
                    if name:
                        last_event = name
                    if name == "task-started":
                        started = True
                    elif name == "task-failed":
                        return with_timings({"text": "", "empty": True,
                                "reason": "DashScope task-failed（还没开始送音频，端点 " + used_url + "）："
                                          + _describe_header(event.get("header") or {}),
                                "resolved_language": language})
                    elif name == "result-generated":
                        collect(event)
                timings["wait_started"] = round(time.perf_counter() - started_at, 3)
                if not started:
                    return with_timings({"text": "", "empty": True,
                            "reason": f"等 task-started 超时（最后收到 {last_event or '什么都没有'}）"
                                      "—— 可能是模型 ID 不支持实时（换成 *-realtime 的模型）",
                            "resolved_language": language})
                # ② 送音频（100 ms 一帧）
                send_at = time.perf_counter()
                chunk = 1600 * 2
                for start in range(0, len(pcm), chunk):
                    ws.send(pcm[start:start + chunk])
                # ③ 告诉服务端音频结束
                # ⚠️ 5.92：finish-task 也**必须**带 payload（实测报
                #    `Missing required parameter 'payload'! Please follow the protocol!`）。
                #    第一版只给 header 不给 payload，于是每条控制帧都被拒；
                #    而错误里既不说是哪条帧也不说是哪个字段，只能对照协议推。
                ws.send(_json.dumps({"header": {"action": "finish-task", "task_id": task_id,
                                                "streaming": "duplex"},
                                     "payload": {"input": {}}},
                                    ensure_ascii=False))
                timings["send_audio"] = round(time.perf_counter() - send_at, 3)
                # ④ 收结果直到 task-finished
                #
                # ⚠️ 5.99：**不能干等 30 秒**。实测有些账号/模型只回 `result-generated`
                #    就再也没有 `task-finished`，于是每一段都要等满 30 秒才返回 ——
                #    2 秒的音频等 30 秒，一段接一段排队，现场看到的就是"一直没有输出"。
                #    正确判据不是"等它说完"，而是"**已经拿到文本，而且安静下来了**"：
                #    收到过结果之后，只要连续 CLOUD_QUIET_FLUSH_S 秒没有新事件就收工；
                #    一个字都没收到时才继续等满上限（那种确实是服务端没给东西）。
                overall_deadline = time.time() + CLOUD_RESULT_WAIT_S
                quiet_s = CLOUD_QUIET_FLUSH_S
                saw_finished = False
                while True:
                    now = time.time()
                    if now >= overall_deadline:
                        break
                    got_text = last_text_at is not None and joined_text() != ""
                    budget = overall_deadline - now
                    if got_text:
                        left = last_text_at + quiet_s - now
                        if left <= 0:
                            # 有文本 + 安静够了 → 这就是最终结果，立刻返回
                            if not self._noted_quiet_flush:
                                self._noted_quiet_flush = True
                                print(f"[识别] 云端没回 task-finished，但已经拿到文本；"
                                      f"按「安静 {quiet_s:g}s 就收工」处理（不再等满 30s）",
                                      file=sys.stderr, flush=True)
                            break
                        budget = min(budget, left)
                    try:
                        name, event = parse(ws.recv(timeout=max(0.05, budget)))
                    except TimeoutError:
                        # 有文本就让它转一圈（下一轮 left<=0 → break）；没文本继续等
                        continue
                    if name:
                        last_event = name
                    if name == "result-generated":
                        collect(event)
                        last_text_at = time.time()
                    elif name == "task-finished":
                        saw_finished = True
                        break
                    elif name == "task-failed":
                        return with_timings({"text": "", "empty": True,
                                "reason": "DashScope task-failed（端点 " + used_url + "）："
                                          + _describe_header(event.get("header") or {}),
                                "resolved_language": language})
                timings["collect"] = round(time.perf_counter() - send_at - timings.get("send_audio", 0.0), 3)
                close_started = time.perf_counter()
            # `with` 退出 = 关闭握手。这一段的耗时以前**完全看不见**，
            # 而它一度占了一次调用 11.2 秒里的 10 秒（见上面 close_timeout 的说明）。
            timings["close"] = round(time.perf_counter() - close_started, 3)
        except Exception as error:                                  # noqa: BLE001
            # ⚠️ 5.96：实测遇到过「收到了 result-generated，却等不到 task-finished」
            #    （TimeoutError after 29.7s）。那时**文字已经拿到了**，当失败丢掉是最坑的选择
            #    —— 用户看到的是"没字幕"，而实际上识别已经完成了。
            partial = joined_text()
            if partial:
                return with_timings({"text": partial, "empty": False, "reason": None,
                        "resolved_language": language})
            # ⚠️ 5.98：握手阶段的头校验失败必须是**人话**。第三方原始 traceback
            #    （`InvalidHeaderValue: invalid Authorization header`）连"是密钥的问题"
            #    都没说出口，现场只能靠猜。
            hint = ""
            if "Header" in type(error).__name__ or "invalid Authorization" in str(error):
                hint = ("—— 这是 **API Key 里有 HTTP 头放不下的字符**（换行/控制字符最常见，"
                        f"长 key 复制时被折成两行就会这样）。重设一个干净的 {self.ENV_KEY} 即可")
            return with_timings({"text": "", "empty": True,
                    "reason": (f"DashScope 请求失败：{type(error).__name__}: {error}"
                               f"（最后收到的事件：{last_event or '无'}）{hint}"),
                    "resolved_language": language})
        text = joined_text()
        # 没出字时说清是"服务端说完了但没内容"还是"根本没等到结束"——
        # 这两种的下一步完全不同（前者查音频/模型，后者查协议/网络）
        if text:
            return with_timings({"text": text, "empty": False, "reason": None,
                                 "resolved_language": language})
        reason = ("Fun-ASR 没出字" if saw_finished
                  else f"等不到 task-finished，且一个字都没收到（最后收到 {last_event or '什么都没有'}）")
        return with_timings({"text": "", "empty": True, "reason": reason,
                             "resolved_language": language})


def build_engines(model_class, args):
    """引擎注册表。**加一个新引擎 = 在这里加一行 + 写一个 AsrEngine 子类。**

    <p>注意：这里刻意没有"缺省引擎兜底"的逻辑。策略里写了不认识的 engine，
    {@link resolve_engine} 会直接报错并列出已知引擎 —— 悄悄用 whisper 顶上，
    等于让人以为在测新引擎。

    <p>5.75 起多了两个**依赖/密钥没到位就会大声报错**的引擎：`parakeet`（本地 ONNX）
    与 `tencent`（云端一句话识别）。它们**不会**在缺依赖时静默退回 whisper ——
    那会让"我在测 Parakeet"变成"其实一直在测 whisper"，正是这套实验最怕的事。
    """
    return {
        WhisperEngine.key: WhisperEngine(model_class, args),
        ParakeetEngine.key: ParakeetEngine(model_class, args),
        TencentEngine.key: TencentEngine(model_class, args),
        FunAsrEngine.key: FunAsrEngine(model_class, args),
    }


def resolve_engine(profile, engines):
    """按策略取引擎；不认识就**抛错**（附上已知引擎清单）。"""
    key = str((profile or {}).get("engine") or DEFAULT_ENGINE).strip().lower() or DEFAULT_ENGINE
    engine = (engines or {}).get(key)
    if engine is None:
        known = "/".join(sorted(engines or {})) or "（一个都没注册）"
        raise ValueError(
            f"策略 {str((profile or {}).get('strategy') or '?')} 要求引擎 `{key}`，"
            f"但这台机器上只注册了：{known}。"
            f"要接新引擎：写一个 AsrEngine 子类并在 build_engines() 里登记（见 docs/21 §5.50）")
    return engine


class ModelPool:
    """模型池：按档案取模型，缺就加载，超过上限按"最久没用"淘汰。

    <p>单独成类是为了让"到底加载了几份模型"这件事只有一个出口 ——
    显存事故几乎都来自"以为只有一份，其实悄悄加了一份"。
    """

    def __init__(self, engines, max_models=2, log=print, device="cuda"):
        self.engines = engines
        self.max_models = max(1, int(max_models))
        self.log = log
        self.device = device
        self.models = {}        # key -> handle（whisper 是 (model, compute)，云端引擎可以是客户端对象）
        self.order = []         # 最近使用顺序（末尾最新）
        self.loads = []         # [{"key", "seconds"}] 加载耗时记录（--stats 用）
        self.counts = {}        # 策略名 → 处理段数
        self.compute_of = {}    # 策略名 → 实际用的 precision（A/B 时要能看见）
        self.engine_of = {}     # 策略名 → 引擎 key

    @staticmethod
    def key_of(profile):
        """池子的键 = **引擎 + 模型**（精度由引擎自己兜底，不进键 —— 否则同一模型会存两份）。"""
        engine = str((profile or {}).get("engine") or DEFAULT_ENGINE).strip().lower() or DEFAULT_ENGINE
        return (engine, (profile or {}).get("model"))

    def get(self, profile, device=None):
        device = device or self.device
        engine = resolve_engine(profile, self.engines)
        name = profile.get("strategy") or profile.get("model")
        key = self.key_of(profile)
        self.engine_of[name] = engine.key
        if key in self.models:
            self.order.remove(key)
            self.order.append(key)
            return self.models[key]
        while len(self.models) >= self.max_models and self.order:
            drop = self.order.pop(0)
            self.models.pop(drop, None)
            self.log(f"[识别] 模型池已满（--max-models {self.max_models}），"
                     f"淘汰 {drop[0]}:{drop[1]}（要同时留更多份就调大它，代价是显存）")
        self.log(f"[识别] 加载 {engine.describe(profile)}（引擎 {engine.key}）…")
        started = time.perf_counter()
        handle = engine.load(profile, device)
        took = time.perf_counter() - started
        self.models[key] = handle
        self.order.append(key)
        # whisper 的句柄是 (model, 实际精度)：把实际精度记下来（A/B 报告要显示它）
        if isinstance(handle, tuple) and len(handle) == 2 and isinstance(handle[1], str):
            self.compute_of[name] = handle[1]
        self.loads.append({"key": key, "seconds": round(took, 2)})
        self.log(f"[识别] 模型就绪 {engine.describe(profile)}（{took:.1f}s）")
        return handle

    def note(self, profile, strategy_name=""):
        """记一段的处理数（按策略名分组 —— 这就是 A/B 报告的分组口径）。"""
        name = strategy_name or profile.get("strategy") or "?"
        engine = self.engine_of.get(name) or profile.get("engine") or DEFAULT_ENGINE
        compute = self.compute_of.get(name) or profile.get("compute_type") or ""
        tag = f"{name} → {engine}:{profile.get('model')}" + (f"/{compute}" if compute else "")
        self.counts[tag] = self.counts.get(tag, 0) + 1

    def report(self):
        if not self.counts:
            return "（还没有按档案分过的段）"
        return "；".join(f"{tag} ×{count}" for tag, count in sorted(self.counts.items()))


# ── 5.197：引擎分发**之前**统一做的降噪（对所有引擎生效）─────────────────────
#
# 为什么要挪到这一层：高通和 VAD 原来只写在 whisper 分支里，而 parakeet / 腾讯 / 云端
# 走各自的实现，**根本不经过** whisper 的 transcribe()。于是管理台开了高通，在英语走
# parakeet 的机器上等于没开 —— "配了但没生效"是最难查的一类问题。
#
# 两项的语义（都不改音频长度，和 whisper 内部的 VAD **不一样**）：
#   · 高通：二阶 Butterworth，砍掉 cutoff 以下的低频轰鸣。线性、不剪时长。
#   · VAD ：**判定式** —— 问"这段里有没有人声"，没有就**整段丢掉**，不送去识别。
#           ⚠️ 刻意**不剪首尾**：剪掉头 60~100ms 在短句上就是吃掉第一个音节
#           （5.186 的实测教训：评测里写死 vad_filter=True，删除率凭空涨到 88%）。
#           判定式最坏只丢一段"本来就没人的"，不会伤到真话。
VAD_DECIDE_MAX_MS = 2000      # 只给不超过这么长的段做判定（长段几乎不会没人声，省时间）
_VAD_PREFILTER_WARNED = {"done": False}


def highpass_amount(profile, fallback=0.0):
    """这一路要不要高通、截止多少（表里给了就用表里的）。"""
    value = (profile or {}).get("highpass_hz")
    if not isinstance(value, (int, float)) or value < 0:
        return float(fallback or 0.0)
    return float(value)


def vad_wanted(profile):
    """这一路要不要做 VAD 判定（表里显式写了 true 才做）。"""
    return (profile or {}).get("vad") is True


def has_speech(audio, samplerate, threshold=0.5, np=None):
    """这段音频里**有没有人声**（silero VAD，只判定、不剪）。

    <p>依赖不在（老版本 faster-whisper）时**说一次**然后返回 True —— 宁可多送一段给引擎，
    也不能因为一个可选优化把整句真话丢掉。
    """
    try:
        from faster_whisper.vad import VadOptions, get_speech_timestamps
    except Exception as error:                                  # noqa: BLE001
        if _VAD_PREFILTER_WARNED["done"] is not True:
            _VAD_PREFILTER_WARNED["done"] = True
            print(f"[识别] ⚠️ 这台机器的 faster-whisper 没有 VAD（{type(error).__name__}: {error}）"
                  "→ 前置 VAD 判定**没生效**，所有段照常送识别", file=sys.stderr, flush=True)
        return True
    try:
        options = VadOptions(threshold=float(threshold),
                             min_speech_duration_ms=200,    # 更短的"语音"多半是噪声瞬态
                             min_silence_duration_ms=100,
                             speech_pad_ms=60)
        stamps = get_speech_timestamps(audio, options)
        return bool(stamps)
    except Exception:                                          # noqa: BLE001
        # 判定本身出错不改变业务：照常送识别
        return True


def preprocess_segment(audio, samplerate, profile, np):
    """引擎分发前统一做两件事：高通、以及"这段到底有没有人声"的判定。

    @returns (处理后的音频, None | 丢弃原因)。原因非空 → 这一段**不要送去识别**。
    """
    processed = np.asarray(audio, dtype=np.float32)
    cutoff = highpass_amount(profile)
    if cutoff > 0:
        processed = highpass_biquad(processed, samplerate, cutoff)
    if not vad_wanted(profile):
        return processed, None
    ms = int(len(processed) * 1000.0 / float(samplerate or 16000))
    max_ms = (profile or {}).get("vad_max_ms")
    limit = int(max_ms) if isinstance(max_ms, int) and max_ms > 0 else VAD_DECIDE_MAX_MS
    if ms > limit:
        # 长段不做判定：几乎不会是"没人声"，做了只是白花时间
        return processed, None
    threshold = (profile or {}).get("vad_threshold")
    if not isinstance(threshold, (int, float)) or not (0.05 <= threshold <= 0.95):
        threshold = 0.5
    try:
        speech = has_speech(processed, samplerate, threshold, np=np)
    except Exception as error:                                 # noqa: BLE001
        # 判定本身抛异常 → **放行**。降噪是可选优化，它坏了绝不许连累识别
        # （这类"护栏变路障"是本项目反复踩过的坑：宁可多送一段，也不能丢真话）。
        print(f"[识别] ⚠️ 前置 VAD 判定出错（{type(error).__name__}: {error}）→ 这一段照常送识别",
              file=sys.stderr, flush=True)
        speech = True
    if speech:
        return processed, None
    return processed, f"前置 VAD 判定这段没有人声（{ms}ms，threshold {threshold}）—— 不送识别"


# ── 5.202：切句之后、引擎分发之前的**语种识别**（LID）──────────────────────────
#
# 要解决的问题（用户原话）：「在面对面情况下…无论谁开麦，我们都去接收当前的声音，
# 然后在分发之前做一个语种的识别，这样就不需要两个人切来切去了」。
#
# 为什么不用 whisper 的 detect_language：它要把短音频补到 30 秒窗口跑一遍编码器，
# 1.63 秒的段要 **507ms**；而我们给整段的延迟预算才 1.3~2.2 秒，这一项吃掉四分之一不划算。
#
# ⚠️ 5.207 更正一句实话：专用 LID（sherpa-onnx 的 SpokenLanguageIdentification）
# **并不比那 507ms 快** —— 它用的就是 whisper 编码器、同样补到 30 秒窗口，
# 实机 fp32/单线程量到 **约 480~540ms**（教室里 20 秒的段）。当初写"只要几十毫秒"是估算，错了。
# 它真正值钱的地方是**候选集收窄**：只在"本场有人说的那几种语言"里挑，
# 而不是在 100 多种里挑（实测不限定语种时，20 条巴葡口语有 1 条被判成希伯来语、整句报废）。
# 所以用法上要认账：这 0.5 秒要么用 int8/多线程压下去，要么按"每 N 段判一次"摊销，
# 两者都是后续要量的（见 docs/21 §5.207）。
#
# 为什么判定结果要**按 (房间, 说话人) 带粘滞（hysteresis）**：一路会场麦里语种会随人切换，
# 但 LID 在句边、口音重、句子短时会抖 —— 每段都跟着抖，就会出现"同一个人忽中忽英"，
# 而"判成英文就送 parakeet（只认英文）"，判错一次就是整句乱码。
# 所以：**新判定要连续赢过旧判定才切换**（见 lid_switch_after），否则沿用上一次。
LID_STATE = {"model": None, "failed": False, "warned": False, "path": None}
# 5.207：判定出问题时的一次性提示（每进程最多三条，见 _lid_note）
_LID_NOTES = {"count": 0, "seen": set()}
# 5.210：判定的**时机**常量（不是旋钮，按实测定的，见 docs/21 §5.210）
#   · 短于这个毫秒数的段不判：1~3 秒的段实测会给出 `nn`（挪威语新诺斯克）这种码，
#     宁可用上一次的判定，也别拿一句"嗯/好"去改整路语种；
#   · 一路连着说很久（中间没有静音）时，隔这么久兜底重判一次，
#     否则"同一个人中途换了语言"永远发现不了。
#     12 秒是拿延迟换来的：判一次 ≈340ms（10 秒窗口），摊到 12 秒的连续说话上
#     约合 +55ms/句（按 2 秒一句算），而"换人后最多 6 句还用着旧语种"。
LID_MIN_JUDGE_MS = 1200
LID_MAX_AGE_MS = 12000
# 语言码（sherpa-onnx / whisper 都可能是两字母码）→ 我们系统里的语种标签
_LID_TAG = {
    "zh": "zh-CN", "cmn": "zh-CN", "yue": "zh-CN",
    "en": "en-US",
    "pt": "pt-BR",
}


def lid_available(args):
    """这一路要不要做语种识别（命令行给了模型才做，缺省关 —— 不做就是老行为）。"""
    if getattr(args, "lid_model", None):
        return True
    import os as _os
    return bool(_os.environ.get("LEION_LID_MODEL", "").strip())


def _lid_config_attempts(sherpa_onnx, encoder, decoder, threads=1):
    """按 sherpa-onnx 的版本，列出"怎么造 LID 配置"的几种写法（新 → 旧）。

    <p>为什么不是一句话就能写死：LID 的配置类**换过形状**，实机踩到过 ——
    服务器上那份 sherpa-onnx 里，外层 `SpokenLanguageIdentificationConfig` 只吃
    `SpokenLanguageIdentificationWhisperConfig`，而我们代码里写的是语音识别那套
    `OfflineWhisperModelConfig`，于是 pybind 直接拒绝：

        TypeError: __init__(): incompatible constructor arguments … Invoked with:
        kwargs: whisper=<OfflineWhisperModelConfig …>

    这类错误**不是"模型没装好"**，但报出来长得就像，最后人跑去重下模型。
    而 pybind 的构造函数只认关键字、不认"多余参数"，所以这里把已知的几种形状
    都列出来逐个试（含"只传最少参数"的兜底），谁成了就用谁，全失败才报错 ——
    并且在报错里**列出试过哪些写法**，别再让人去猜。

    @returns {Array<[string, Function]>} `[说明, 造配置的闭包]`，按可能性从高到低
    """
    attempts = []

    # 5.209：线程数由调用方给（缺省 min(4, CPU 核数)）—— 实测单线程 411ms、4 线程 139ms，
    # 这一步的耗时直接算在每句延迟里，别用 1。
    threads = max(1, int(threads or 1))

    def outer_variants():
        """外层配置的两种写法：带 num_threads/debug/provider，或只给 whisper。"""
        return (
            ("", {"num_threads": threads, "debug": False, "provider": "cpu"}),
            ("（外层最少参数）", {}),
        )

    whisper_cls = getattr(sherpa_onnx, "SpokenLanguageIdentificationWhisperConfig", None)
    if whisper_cls is not None:
        for inner_label, inner in (
            ("（全参数）", {"encoder": encoder, "decoder": decoder,
                            "num_threads": threads, "debug": False, "provider": "cpu"}),
            ("（最少参数）", {"encoder": encoder, "decoder": decoder}),
            # 兜底：某些版本的内层只要 encoder（解码器那份在某版里换成了内置分类头）
            ("（只有 encoder）", {"encoder": encoder}),
        ):
            for outer_label, outer in outer_variants():
                attempts.append((
                    f"SpokenLanguageIdentificationWhisperConfig{inner_label}{outer_label}",
                    lambda inner=inner, outer=outer: sherpa_onnx.SpokenLanguageIdentificationConfig(
                        whisper=whisper_cls(**inner), **outer)))

    offline_cls = getattr(sherpa_onnx, "OfflineWhisperModelConfig", None)
    if offline_cls is not None:
        for outer_label, outer in outer_variants():
            attempts.append((
                f"OfflineWhisperModelConfig{outer_label}",
                lambda outer=outer: sherpa_onnx.SpokenLanguageIdentificationConfig(
                    whisper=offline_cls(encoder=encoder, decoder=decoder, language="",
                                        task="transcribe", tail_paddings=-1), **outer)))
    return attempts


def load_lid(args):
    """加载 LID 模型（懒加载 + 失败只喊一次）。返回对象或 None。"""
    if LID_STATE["failed"]:
        return None
    if LID_STATE["model"] is not None:
        return LID_STATE["model"]
    import os as _os
    model_dir = str(getattr(args, "lid_model", None) or _os.environ.get("LEION_LID_MODEL", "")).strip()
    if model_dir == "":
        return None
    try:
        import sherpa_onnx
    except Exception as error:                                  # noqa: BLE001
        LID_STATE["failed"] = True
        if not LID_STATE["warned"]:
            LID_STATE["warned"] = True
            print(f"[识别] ⚠️ 要做语种识别，但没装 sherpa-onnx（{type(error).__name__}: {error}）"
                  "→ 退回按段自带的语种识别", file=sys.stderr, flush=True)
        return None
    try:
        import glob
        import os as _os2

        def _pick(pattern_list):
            """在模型目录里挑一个文件；同一族里**优先 int8**（速度，见下）。

            <p>为什么优先 int8（5.209 改了 5.205 的选择）：实测同一段 20 秒课堂音频，
            `tiny-encoder.onnx` 单线程 **550ms**、`tiny-encoder.int8.onnx` 单线程 **411ms**、
            int8 + 4 线程 **139ms**。语种判定是个**粗任务**（100 多种里挑一种），
            int8 掉的那点精度对它的影响远小于这 400ms 对延迟的影响 ——
            这 400ms 是直接压在每一句上的。
            """
            for pattern in pattern_list:
                hits = sorted(glob.glob(_os2.path.join(model_dir, pattern)))
                if hits:
                    quantized = [one for one in hits
                                 if "int8" in _os2.path.basename(one).lower()
                                 or "quant" in _os2.path.basename(one).lower()]
                    plain = [one for one in hits
                             if one not in quantized]
                    return (quantized or plain)[0]
            return ""

        encoder = _pick(["*encoder*.onnx", "*encoder*.ort"])
        decoder = _pick(["*decoder*.onnx", "*decoder*.ort"])
        # ⚠️ tokens **不是必需的**：语种判定只跑 whisper 编码器 + 语言分类头，
        # 根本不用 tokenizer。原来要求它，结果"模型包里有 encoder/decoder 但没有
        # tokens"就会判成"模型加载失败"—— 那是错的失败（人会被指去重下模型）。
        if encoder == "" or decoder == "":
            raise FileNotFoundError(
                f"{model_dir} 里找不到 encoder/decoder（LID 用的是 whisper 那种编码器+解码器）")
        # 5.209：线程数 —— 缺省 min(4, CPU 核数)。这一步的耗时直接算在每句延迟里，
        # 用 1 线程就是白等（实测 411ms vs 139ms）。
        threads = int(getattr(args, "lid_threads", 0) or 0)
        if threads <= 0:
            threads = min(4, _os.cpu_count() or 1)
        attempts = _lid_config_attempts(sherpa_onnx, encoder, decoder, threads)
        if not attempts:
            raise RuntimeError("这份 sherpa-onnx 里既没有 SpokenLanguageIdentificationWhisperConfig，"
                               "也没有 OfflineWhisperModelConfig —— 版本太老，装不上 LID")
        config = None
        tried = []
        last_error = ""
        for label, factory in attempts:
            try:
                config = factory()
                tried.append(label + " → 成")
                break
            except Exception as error:                          # noqa: BLE001
                tried.append(f"{label} → {type(error).__name__}")
                last_error = f"{type(error).__name__}: {error}"
        if config is None:
            raise RuntimeError(f"造不出 LID 配置（试过：{'；'.join(tried)}）。最后一次：{last_error}")
        LID_STATE["model"] = sherpa_onnx.SpokenLanguageIdentification(config)
        LID_STATE["path"] = model_dir
        version = str(getattr(sherpa_onnx, "__version__", "") or "未知版本")
        # 报出**实际用哪两个文件 + 哪种配置写法**：现场最常出错的是"挑错了包"和
        # "sherpa-onnx 版本与代码里的写法不一致"，这两行以后一眼能看出来。
        print(f"[识别] 语种识别已启用：{model_dir}"
              f"（{_os2.path.basename(encoder)} + {_os2.path.basename(decoder)}；"
              f"{threads} 线程；sherpa-onnx {version}，配置写法 {tried[-1]}；"
              "CPU；只在切句之后、分发之前用）", file=sys.stderr, flush=True)
        return LID_STATE["model"]
    except Exception as error:                                  # noqa: BLE001
        LID_STATE["failed"] = True
        if not LID_STATE["warned"]:
            LID_STATE["warned"] = True
            print(f"[识别] ⚠️ 语种识别模型加载失败（{type(error).__name__}: {error}）"
                  f"→ 退回按段自带的语种识别。模型在 {model_dir}", file=sys.stderr, flush=True)
        return None


def lid_tags_of(raw_codes, fallback=("zh-CN", "en-US", "pt-BR")):
    """把 LID 的候选码映射成系统的语种标签；**只留我们支持的三种**。

    <p>候选集必须收窄 —— 实测（代码里 pt-cao 那条）：不限定语种时 Whisper 会在 99 种里挑，
    20 条巴葡口语有 1 条被判成希伯来语、整句报废（WER 100%）。
    """
    out = []
    for code in raw_codes or ():
        tag = _LID_TAG.get(str(code).strip().lower())
        if tag is not None and tag not in out:
            out.append(tag)
    return out or list(fallback)


def lid_candidates_for(data_dir, room, fallback=("zh-CN", "en-US", "pt-BR")):
    """这一场的候选语种 = **本场说话人语种的并集**（用户要求）。

    <p>来源是 relay 写的侧车 `<data-dir>/room-langs/<房间>.json`。两个字段：
      · `speakLangs`（5.204）：本场**有人说的**语言（成员 `lang` 的并集）—— 首选；
      · `langs`：本场**有人想读的**语言（可能比说的多，更早的版本只有它）。
    读不到就退回三种都给 —— 宁可多给一个候选，也不要把真语种挡在外面。
    """
    import json as _json
    import os as _os
    if not data_dir or not room:
        return list(fallback)
    path = _os.path.join(str(data_dir), "room-langs", str(room) + ".json")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            payload = _json.load(handle)
    except (OSError, ValueError):
        return list(fallback)
    tags = []
    if isinstance(payload, dict):
        for field in ("speakLangs", "langs"):
            value = payload.get(field)
            if isinstance(value, list) and value:
                tags = [str(one).strip() for one in value
                        if isinstance(one, str) and str(one).strip() != ""]
                if tags:
                    break
    # 只留下我们支持的三种，保持顺序稳定
    keep = [one for one in tags if one in _LID_TAG.values()]
    return list(dict.fromkeys(keep)) or list(fallback)


def _lid_pick_code(raw):
    """从 LID 的返回值里取语种码（几种形态都认）。

    ⚠️ 实机踩过（5.207）：`model.compute(stream)` 返回的是**结果对象**
    （`.lang` / `.languages` / `.probs`），而这里原来写的是 `str(raw)` ——
    于是永远对不上映射表、永远返回 None。表现是"语种判定：判成（不确定）"，
    看着像"音频听不出来"，其实是**代码根本没读结果**。
    """
    code = getattr(raw, "lang", None)
    if code is None and isinstance(raw, dict):
        code = raw.get("lang")
    if code is None:
        code = raw
    return str(code or "").strip().lower()


def _lid_prob_table(raw):
    """结果对象里的 `(语种码, 概率)` 表；拿不到就返回空表。

    <p>有了概率表才能做一件关键的事：**在候选集里挑最可能的那个**，
    而不是"全局第一名不在候选里就判不出来"（后者在候选只有中/英/葡时会把
    "葡语被读成西语"直接变成一次失败的判定）。
    """
    probs = getattr(raw, "probs", None)
    langs = getattr(raw, "languages", None)
    if probs is None or langs is None:
        return []
    try:
        return [(str(lang).strip().lower(), float(prob)) for lang, prob in zip(langs, probs)]
    except (TypeError, ValueError):
        return []


def _lid_note(message):
    """LID 出问题时的**一次性**提示（每进程最多三条，别刷屏）。

    <p>为什么必须说出来：原来 `except Exception: return None` 把一切都吞掉了 ——
    "模型抛错"和"这段音频真的听不出语种"在日志里长得**完全一样**，
    于是第一版就踩了"结果对象当成字符串"这种 bug 而现场毫无线索。
    """
    if message in _LID_NOTES["seen"]:
        return
    if _LID_NOTES["count"] >= 3:
        return
    _LID_NOTES["count"] += 1
    _LID_NOTES["seen"].add(message)
    print(f"[识别] ⚠️ 语种判定没能出结果：{message}"
          "（这一段沿用上一次/段自带的语种，不影响识别）", file=sys.stderr, flush=True)


def _lid_compute(model, audio, samplerate, np):
    """跑一次 LID，返回 `(原始结果对象, 用的是哪种写法)`。

    <p>**签名在版本之间变过，已经踩到两次**（都长得像"模型/音频有问题"）：
      <ol>
        <li>`stream.accept_waveform(...)` + `stream.input_finished()` + `model.compute(stream)`
            —— 第一版这么写，而实机里 LID 的流是 `OfflineStream`，**没有 `input_finished`**
            （`AttributeError: 'OfflineStream' object has no attribute 'input_finished'`）；</li>
        <li>`model.compute(waveform, sample_rate)` —— 直接给数组的签名。</li>
      </ol>
    所以这里按"最可能 → 次可能"逐个试，成功即返回；全失败就把三种写法的错误一起报出来。

    @returns {[object, string]} 结果对象 + 用了哪种写法（写进 detail 日志，便于下次一眼认出）
    """
    samples = np.asarray(audio, dtype=np.float32)
    rate = int(samplerate)

    def via_stream_kwargs():
        stream = model.create_stream()
        stream.accept_waveform(sample_rate=rate, waveform=samples)
        finish = getattr(stream, "input_finished", None)
        if callable(finish):
            finish()
        return model.compute(stream)

    def via_array():
        return model.compute(samples, rate)

    def via_stream_positional():
        stream = model.create_stream()
        stream.accept_waveform(rate, samples)
        finish = getattr(stream, "input_finished", None)
        if callable(finish):
            finish()
        return model.compute(stream)

    problems = []
    for label, run in (("流式（create_stream → compute）", via_stream_kwargs),
                       ("直接给数组（compute(waveform, rate)）", via_array),
                       ("流式（位置参数）", via_stream_positional)):
        try:
            return run(), label
        except Exception as error:                              # noqa: BLE001
            problems.append(f"{label}: {type(error).__name__}: {error}")
    raise RuntimeError("；".join(problems))


def detect_lang(audio, samplerate, model, candidates, np):
    """跑一次 LID，返回 (语种标签或 None, 置信度 0~1, 耗时 ms)。

    <p>判定不出 / 模型抛错都返回 None —— 调用方沿用上一次的语种，绝不因为"这次没判出来"改语种。

    <p>候选集给了就**只在这几个语种里挑最可能的那个**（用户要求：候选 = 本场说话人语种的并集）。
    这比"先取全局第一名、再看它在不在候选里"稳得多：全局第一名是西语、候选中只有葡语时，
    前者判不出来，后者直接给出葡语（且概率是真实的那个数）。
    """
    if model is None:
        return None, 0.0, 0
    started = time.perf_counter()
    try:
        raw, how = _lid_compute(model, audio, samplerate, np)
        elapsed = int(round((time.perf_counter() - started) * 1000))
        if log_level_at_least("trace"):
            print(f"[识别] 语种判定的调用方式：{how}（{elapsed}ms）", file=sys.stderr, flush=True)
        code = _lid_pick_code(raw)
        tag = _LID_TAG.get(code)
        allowed = [one for one in (candidates or ()) if one in _LID_TAG.values()]
        table = _lid_prob_table(raw)
        # ① 有概率表 + 有候选集：**只在候选里挑最可能的那个**（这是候选集收窄的正解）。
        #    注意顺序：先按候选挑，再看"全局第一名是什么" —— 否则"葡语被读成西语"时
        #    会因为西语不在支持范围而直接判不出来（那正好丢掉了最有用的一次判定）。
        if allowed and table:
            best_tag, best_prob = None, 0.0
            for one_code, prob in table:
                mapped = _LID_TAG.get(one_code)
                if mapped in allowed and prob > best_prob:
                    best_tag, best_prob = mapped, prob
            if best_tag is not None:
                return best_tag, best_prob, elapsed
        if tag is None:
            _lid_note(f"判出的语种码是 {code or '（空）'}，不在支持范围（我们只有 zh-CN / en-US / pt-BR）")
            return None, 0.0, elapsed
        # ② 有候选但拿不到概率表（老版本只给一个码）：不在候选里就只能认命
        if allowed and tag not in allowed:
            _lid_note(f"判成 {tag}，但这一场的候选只有 {'/'.join(allowed)}")
            return None, 0.0, elapsed
        confidence = 1.0
        for one_code, prob in table:
            if _LID_TAG.get(one_code) == tag:
                confidence = prob
                break
        return tag, confidence, elapsed
    except Exception as error:                                  # noqa: BLE001
        _lid_note(f"{type(error).__name__}: {error}")
        return None, 0.0, int(round((time.perf_counter() - started) * 1000))


def lid_gap_of(seg_end, seg_ms, seen):
    """这一段**前面静了多久**（毫秒）。

    <p>⚠️ 5.211 修的一个 bug：`meta.queuedAt` 是段**收完才写**的，所以它是**段尾**
    而不是段首。第一版把状态记成 `queuedAt + ms`（多算了一个段长），于是静音间隔
    被算成 `实际静音 - 上段长`、几乎总是 0 —— `--lid-gap-ms 1.5 秒`这个条件**从不触发**，
    真正生效的只有"兜底重判"。表现是"换人之后最多 20 秒还在用旧语种"，
    而日志上看起来一切正常（这条 bug 是自查时对着时间轴手算才发现的）。

    <p>现在：`段首 = 段尾 - 段长`，`静音 = 本段段首 - 上段段尾`。
    """
    if seen is None:
        return 0
    seg_start = seg_end - max(0, int(seg_ms or 0))
    return max(0, seg_start - int(seen.get("end") or 0))


def lid_should_judge(seen, seg_end, seg_ms, gap_ms, gap_threshold_ms):
    """这一段要不要**重新判**语种（5.210 的时机规则，单独成函数是为了能测）。

    <p>为什么不能每段都判：实测成本按音频秒数线性长 ——
    `accept_waveform` ≈ **27ms/秒**（sherpa-onnx 内部逐样本重采样/特征搬运，
    与模型精度、线程数都无关），`compute` ≈ **7ms/秒**（这部分吃 int8/线程）。
    一段 20 秒 = ~680ms，占 p50 总延迟 1.93s 的三分之一。

    <p>而语种是**按人 / 按话题**变的，不是按句变的。所以只在三种时刻判：
    <ol>
      <li>这一路第一次（`seen is None`）；</li>
      <li>中间隔着一段明显静音（`gap_ms >= gap_threshold_ms`，缺省 1.5 秒）——
          换人几乎都发生在这里；`gap_threshold_ms <= 0` 表示"每段都判"（应急开关）；</li>
      <li>连着说了很久、一直没有静音，那也隔 {@link LID_MAX_AGE_MS} 兜底重判一次，
          否则"同一个人中途换了语言"就永远发现不了。</li>
    </ol>
    另外：**太短的段不判** —— 实测 1~3 秒的段会给出 `nn`（挪威语新诺斯克）这种码，
    宁可用上一次的判定，也别拿一句"嗯/好"去改整路语种。

    @param {object|null} seen 上一状态 `{end, judged_at}`（毫秒时间戳，**都是段尾**）；没判过是 null
    @param {number} seg_end 这一段的**段尾**（meta.queuedAt，段是收完才写的）
    @param {number} seg_ms 这一段有多长
    @param {number} gap_ms 与上一段之间静了多久（用 {@link lid_gap_of} 算）
    @param {number} gap_threshold_ms 静音门槛；<=0 表示不做这个限制
    """
    if seg_ms < LID_MIN_JUDGE_MS:
        return False
    if seen is None:
        return True
    if gap_threshold_ms <= 0:
        return True
    if gap_ms >= gap_threshold_ms:
        return True
    return (seg_end - seen["judged_at"]) >= LID_MAX_AGE_MS


def sticky_language(previous, detected, switch_margin=0.0):
    """**粘滞**：新判定只有"明显不同且可信"时才切换，否则沿用上一次。

    <p>为什么需要它：一路会场麦里 LID 会在句边、短句、口音重时抖；而"判成英文就送
    parakeet（只认英文）"，抖一次就是整句乱码。宁可用上一句的语种（同一人连续说话时
    几乎总是对的），也不要在一次不可靠的判定上赌。
    """
    if detected is None:
        return previous
    if previous is None:
        return detected
    if detected == previous:
        return previous
    # 没有置信度区分时（sherpa 的 LID 只给一个码），保守起见：要求连续两次一致才切
    if switch_margin <= 0:
        return previous if previous is not None else detected
    return detected


def _read_segment(queue_dir, base, np):
    """读出一段；读不到返回 None（可能刚被别的进程消费掉了）。"""
    try:
        with open(os.path.join(queue_dir, base + QUEUE_META_SUFFIX), encoding="utf-8") as handle:
            meta = json.load(handle)
        with open(os.path.join(queue_dir, base + ".pcm"), "rb") as handle:
            raw = handle.read()
    except (OSError, ValueError):
        return None
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    return meta, audio


def run_queue_consumer(args, np, pool):
    """消费者：按到达顺序取队列最前面的一段转写；**每段按自己的语种选模型**。

    <p><b>为什么"一个进程"而不是每场一个</b>：显存。而为什么用队列而不是"切到那一场去跟"：
    切场要重载模型（几秒），队列只是"换一段音频喂给同一个模型"，代价接近 0
    —— 除非这一段要求的模型和当前加载的不一样（5.40 起会按需加载第二份，见 ModelPool）。
    <p><b>不丢数据</b>（2026-10-30 用户拍板）：积压时只**报队列深度与最长等待**，
    让人看到"落后多少"，再决定要不要引入丢弃策略。
    """
    print(f"[识别] 队列模式：{args.queue_dir}（按段自带的语种选模型；"
          f"模型池上限 {pool.max_models} 份；按到达顺序取，不丢数据）",
          file=sys.stderr, flush=True)
    # 5.192：数据目录里那份废弃的 segmentation.json 只提示一次（它已经不再被读取）
    warn_legacy_segmentation(_LEGACY_SEG_WARNED, getattr(args, "data_dir", None))
    if args.model_map:
        print(f"[识别] 模型表 {args.model_map}（改了会自动重新读，不用重启）",
              file=sys.stderr, flush=True)
    # 5.202：语种识别（可选）。开了才加载模型 —— 没给模型就是老行为，一个字都不变。
    lid_model = load_lid(args) if lid_available(args) else None
    if lid_model is not None:
        # 5.209：**预热**。第一次 accept/compute 会带上 ONNX Runtime 的会话初始化
        # （实测多花 ~0.5s），不能让第一段真实音频替我们付这笔钱 —— 那一段的延迟会
        # 莫名其妙多出半秒，而且只有**这一场的第一句**慢，最难查的那种。
        try:
            detect_lang(np.zeros(16000, dtype=np.float32), 16000, lid_model, (), np)
        except Exception:                                      # noqa: BLE001
            pass
    # 5.204：粘滞按 **(房间, 说话人)** 记 —— 一路一判，互不污染（见下面那段说明）
    lid_last = {}        # (房间, 人) → 上一次的语种（粘滞用）
    lid_pending = {}     # (房间, 人) → (候选语种, 连续次数)
    lid_used = 0         # 这段判出了语种
    lid_differs = 0      # 判定结果与段自带语种不同
    lid_trusted = 0      # 远程的段：按他选的语种直接走，**没判**（5.204）
    # 5.210：每一路"上一次判定的时间 / 上一次判到哪一段"（决定这一段要不要重判）
    lid_seen = {}
    lid_reused = 0       # 沿用上一次判定的段数（不重判，省下的那 0.3 秒）
    processed = 0
    # 5.197：被"前置 VAD 判定这段没有人声"丢掉的段数。
    # 单独记一个数、而不是混进 processed：这正是"漏了一句"和"这一段本来就没说话"
    # 的分界线，事后要能分开看。
    vad_dropped = 0
    last_report = time.monotonic()
    waited_ms_max = 0
    map_stamp = _stamp_of(args.model_map)
    # 5.148：房间冻结快照的缓存（按 mtime）与"每间房只说明一次"的登记表
    room_snapshots = {}
    room_snapshot_notes = {}
    # 连丢几段「电平偏低」就喊一次（见 LevelWatch）
    level_watch = LevelWatch(getattr(args, "silence_skip_level", SILENCE_SKIP_RMS))
    # 5.110：表里的电平门槛与命令行不一致时，每个语种只说一次（不然一段刷一行）
    level_notes = {}
    while True:
        # 模型表热加载：每轮看一眼 mtime，变了就重读 —— "插拔接口"要真的是插拔
        if args.model_map:
            new_stamp = _stamp_of(args.model_map)
            if new_stamp != map_stamp:
                map_stamp = new_stamp
                table, problem = load_asr_models(args.model_map)
                if problem:
                    print(f"[识别] 模型表更新失败，继续用上一份：{problem}", file=sys.stderr, flush=True)
                else:
                    args.asr_table = table
                    print(f"[识别] 模型表已重新加载：{describe_asr_table(table, _cli_profile(args))}",
                          file=sys.stderr, flush=True)
        bases = _pending_segments(args.queue_dir)
        if not bases:
            time.sleep(max(0.01, args.queue_poll_ms / 1000.0))
        for base in bases:
            got = _read_segment(args.queue_dir, base, np)
            if got is None:
                continue
            meta, audio = got
            # 5.169：延迟账要用"这一段什么时候被取走"（排队的终点）
            picked_at_ms = int(time.time() * 1000)
            waited_ms_max = max(waited_ms_max, int(time.time() * 1000) - int(meta.get("queuedAt") or 0))
            # 5.202/5.204：**先判语种，再选策略** —— 顺序就是用户要的"插在切句-分发之间"。
            #
            # 5.204 起只对**该判的那些段**判：用户定的规则是
            #   · 远程的人：他入会时选的语种**无条件相信**（他在自己机器前说话，
            #     选的什么就说什么；再判一次只会引入新的错判，还白花几十毫秒）；
            #   · 面对面的会场麦：谁开口、说什么语言都随机，手机上的语种只是"机主说什么"，
            #     必须由这里判（切句之后、分发之前）。
            # 参会方式由 relay 写进 `audio/<房间>/<人>.pcm.mode`，随段 meta 一路带过来。
            declared_language = meta.get("lang") or args.language
            language = declared_language
            lid_note = None
            seg_mode = str(meta.get("mode") or "").strip().lower()
            # ⚠️ 粘滞（hysteresis）与"该不该重判"都按 **(房间, 说话人)** 记，不是按房间：
            # 一场会里两个面对面的人各用一部手机（各一路），按房间记会互相污染
            # —— 甲刚把这一路判成英文，乙的中文段就跟着"英文"了。
            room_id = meta.get("room")
            lid_key = (str(room_id), str(meta.get("speaker") or ""))
            seg_ms = int(meta.get("ms") or 0)
            # 段是**收完才写**的，所以 queuedAt 是**段尾**（不是段首）。
            # ⚠️ 5.211：状态里存的就是段尾；静音间隔要用 lid_gap_of 算（段首 - 上段尾）。
            seg_end = int(meta.get("queuedAt") or 0)
            seen = lid_seen.get(lid_key)
            if lid_model is not None and seg_mode != "remote":
                rate_now = int(meta.get("rate") or args.samplerate)
                candidates = lid_candidates_for(getattr(args, "data_dir", None), room_id)
                # ── 5.210：**不是每段都判** ────────────────────────────────────────
                # 实测（4 核机器，同一段 20 秒课堂音频）：
                #   accept ≈ 27ms/秒音频（sherpa-onnx 内部逐样本重采样/特征搬运，
                #                     与精度、线程都无关），compute ≈ 7ms/秒（这部分吃 int8/线程）。
                #   一段 20 秒 = ~680ms，占 p50 总延迟 1.93s 的三分之一 —— 每段都判不能上线。
                # 而语种是**按人/按话题**变的，不是按句变的，所以只在三种时刻判：
                #   ① 这一路第一次；② 中间隔着一段明显静音（换人几乎都发生在这里）；
                #   ③ 连着说了很久（没静音）也隔 LID_MAX_AGE_MS 兜底重判一次。
                # ⚠️ 5.211：静音间隔 = 本段**段首** - 上段**段尾**（见 lid_gap_of 的说明，
                # 第一版这里把段尾当段首用，导致"静音 1.5 秒才重判"从不触发）。
                gap_ms = lid_gap_of(seg_end, seg_ms, seen)
                due = lid_should_judge(seen, seg_end, seg_ms, gap_ms,
                                       int(getattr(args, "lid_gap_ms", 0) or 0))
                if due:
                    # 只喂**最后 window 毫秒**：成本按秒线性长，20 秒段截到 10 秒能省一半，
                    # 而 10 秒已经足够判准（实测 10s → zh 正确，3s → nn 错误）。
                    lid_window_ms = int(getattr(args, "lid_window_ms", 0) or 0)
                    samples = audio
                    if lid_window_ms > 0:
                        limit = int(rate_now * lid_window_ms / 1000.0)
                        if len(samples) > limit:
                            samples = samples[len(samples) - limit:]
                    detected, _score, lid_ms = detect_lang(
                        samples, rate_now, lid_model, candidates, np)
                    previous = lid_last.get(lid_key)
                    if detected is not None:
                        lid_used += 1
                        if detected == previous or previous is None:
                            lid_last[lid_key] = detected
                            lid_pending.pop(lid_key, None)
                        else:
                            want, count = lid_pending.get(lid_key, (detected, 0))
                            count = count + 1 if want == detected else 1
                            need = max(1, int(getattr(args, "lid_switch_after", 2) or 1))
                            if count >= need:
                                lid_last[lid_key] = detected
                                lid_pending.pop(lid_key, None)
                            else:
                                lid_pending[lid_key] = (detected, count)
                    # ⚠️ 5.211：`end` 与 `judged_at` 存的都是**段尾**（queuedAt 的语义），
                    # 别再 + seg_ms —— 那正是静音间隔算错、gap 门槛从不触发的根因。
                    lid_seen[lid_key] = {"end": seg_end, "judged_at": seg_end}
                    language = lid_last.get(lid_key) or declared_language
                    if language != declared_language:
                        lid_differs += 1
                    lid_note = {"lang": language, "detected": detected,
                                "declared": declared_language, "ms": lid_ms,
                                "windowMs": 0 if lid_window_ms <= 0 else lid_window_ms,
                                "gapMs": gap_ms,
                                "candidates": candidates, "mode": seg_mode or "unknown"}
                    if log_level_at_least("detail"):
                        print(f"[识别] 语种判定：判成 {detected or '（不确定）'} → 用 "
                              f"{language}（段自带 {declared_language}；候选 {'/'.join(candidates)}；"
                              f"静音 {gap_ms}ms；{lid_ms}ms）", file=sys.stderr, flush=True)
                else:
                    # 这一段不重判 → **沿用上一次的判定**（这正是"只在换人时判"的意思）。
                    language = lid_last.get(lid_key) or declared_language
                    if lid_last.get(lid_key) is not None:
                        lid_reused += 1
                    if language != declared_language:
                        lid_differs += 1
                    lid_note = {"lang": language, "detected": None,
                                "declared": declared_language, "ms": 0,
                                "gapMs": gap_ms, "reused": True,
                                "candidates": candidates, "mode": seg_mode or "unknown"}
                    # 只有"判过的那一路"才更新进度；没判过的（比如开场一句"嗯"）
                    # 不建状态 —— 这样下一段仍然会当"第一次"去判。
                    if seen is not None:
                        seen["end"] = seg_end
            elif seg_mode == "remote" and declared_language:
                # 远程：**无条件相信**（用户口径：远程的人选的语种就是准的）。
                # 仍然记一笔，好让事后能对上"哪些句是判出来的、哪些句是声明的"。
                lid_trusted += 1
                lid_note = {"lang": language, "detected": None,
                            "declared": declared_language, "ms": 0,
                            "candidates": [], "mode": "remote", "trusted": True}
            # 5.148：**这一场（建房时）冻结的识别策略**优先于全局表。
            # 读不到是正常情况（老会议/建房时没写成）→ 回落全局表；
            # 文件在但坏了要说一次（否则又变成"日志说假话"）。
            room = meta.get("room")
            snapshot, snap_note = load_room_strategy(
                getattr(args, "data_dir", None), room, room_snapshots)
            room_profile = room_profile_of(snapshot, language)
            note_key = str(room)
            if snapshot is not None:
                if note_key not in room_snapshot_notes:
                    room_snapshot_notes[note_key] = True
                    listed = "、".join(
                        f"{key}={value}" for key, value in (room_profile or {}).items()
                        if key not in ("locked_at",))
                    print(f"[识别] 房间 {room} 用**冻结策略**（建房时锁定于 "
                          f"{(room_profile or {}).get('locked_at') or '?'}）：{listed or '（这条语言没有记录）'}",
                          file=sys.stderr, flush=True)
            elif snap_note and snap_note != "没有冻结快照" and note_key not in room_snapshot_notes:
                room_snapshot_notes[note_key] = True
                print(f"[识别] 房间 {room} 的冻结策略不可用（{snap_note}）→ 本次回落全局表",
                      file=sys.stderr, flush=True)
            # 5.40/5.41：这一段用哪份策略 —— languages → strategies[名字] → default →
            # 命令行（见 resolve_strategy）。策略里既有模型也有切句参数；
            # 切句那半边是切句进程用的，这里只取模型这半边，但**名字要一路带下去**。
            # ⚠️ 5.108：原来这里还会叠一层"房间侧车"，已整层删除（见 §5.108）。
            strategy = resolve_strategy(language, _cli_profile(args),
                                        getattr(args, "asr_table", None),
                                        room_profile=room_profile)
            # 切句那边已经给这一段起过名字（meta["strategy"]）；没给就用这份策略算出来的名字。
            cutStrategy = meta.get("strategy")
            strategyName = str(cutStrategy) if isinstance(cutStrategy, str) and cutStrategy.strip() else strategy["strategy"]
            profile = strategy
            # 5.110：表里的电平门槛和命令行不一致 → 说一次谁赢（每语种一次）。
            # 这正是"两个地方都能设"最容易出错的地方：命令行写着 0.008、表里写着 0.006，
            # 而实际用的是表里的 —— 不说的话现场只能靠猜。
            table_floor = strategy.get("silence_skip_level")
            cli_floor = getattr(args, "silence_skip_level", None)
            if (isinstance(table_floor, (int, float)) and isinstance(cli_floor, (int, float))
                    and abs(float(table_floor) - float(cli_floor)) > 1e-9):
                note_key = f"{language}|{table_floor}"
                if note_key not in level_notes:
                    level_notes[note_key] = True
                    print(f"[识别] 电平门槛：{language} 用**表里**的 {table_floor}"
                          f"（命令行给的是 {cli_floor}）→ 表优先；要让命令行生效就把表里那个字段删掉",
                          file=sys.stderr, flush=True)
            # ── 5.197：**引擎无关的降噪**（高通 + "有没有人声"的判定）─────────────
            # 位置很关键：在 `pool.get` / 引擎分发**之前**。放这里才对所有引擎生效
            # （whisper / parakeet / 腾讯 / 云端走的是各自的 transcribe()，谁也不会替别人调）。
            # 高通是线性滤波、不改时长；VAD 只判不剪 —— 判成"没有人声"就把这一段丢掉。
            try:
                audio, denoise_reason = preprocess_segment(
                    audio, int(meta.get("rate") or args.samplerate), profile, np)
            except Exception as error:                         # noqa: BLE001
                # 降噪出问题绝不拖停识别：退回原始音频，照常往下走（并说一句）
                denoise_reason = None
                print(f"[识别] ⚠️ 前置降噪出错（{type(error).__name__}: {error}）→ 这一段用原始音频",
                      file=sys.stderr, flush=True)
            if denoise_reason is not None:
                vad_dropped += 1
                if log_level_at_least("summary"):
                    print(f"[识别] 跳过一段：{denoise_reason}", file=sys.stderr, flush=True)
                continue
            pool.note(strategy, strategyName)
            try:
                handle = pool.get(profile, device=args.device)
            except Exception as error:      # noqa: BLE001
                # 不能静默退回别的模型/引擎：那会让"我在测 A"变成"其实一直在测 B"。
                # 这一段也**不能留在队列里**（会一直堵住后面所有段），但更不能直接删：
                # 内容是用户的语音，删了就是无声丢失。所以挪进 `failed/` 子目录 ——
                # 队列（只看本层的 .json）不再取它，但音频还在，事后能查能重放。
                print(f"[识别] 这一段要求的引擎/模型 {profile.get('engine')}:{profile.get('model')} "
                      f"加载失败（策略 {strategyName}，来源 {profile['sources'].get('model')}），"
                      f"已挪到 failed/ 留证：{type(error).__name__}: {error}",
                      file=sys.stderr, flush=True)
                failed_dir = os.path.join(args.queue_dir, "failed")
                try:
                    os.makedirs(failed_dir, exist_ok=True)
                    for suffix in (".pcm", QUEUE_META_SUFFIX):
                        if os.path.exists(os.path.join(args.queue_dir, base + suffix)):
                            os.rename(os.path.join(args.queue_dir, base + suffix),
                                      os.path.join(failed_dir, base + suffix))
                except OSError as move_error:
                    print(f"[识别] 连挪动都失败了（这段会一直重试）：{move_error}",
                          file=sys.stderr, flush=True)
                continue
            # 5.50：转写交给这一策略选中的**引擎**。whisper 只是其中一个实现。
            # ⚠️ 5.99：顺手掐时间。原来日志里那个 `1.7s` 是**音频长度**，不是耗时 ——
            # 云端某段卡了 30 秒时，日志照样显示"1.7s"，于是"字幕为什么不来"根本看不出来。
            transcribe_started = time.perf_counter()
            try:
                outcome = resolve_engine(profile, pool.engines).transcribe(handle, audio, language, profile)
            except Exception as error:      # noqa: BLE001
                print(f"[识别] 引擎 {profile.get('engine')} 转写这一段失败"
                      f"（策略 {strategyName}，耗时 {time.perf_counter() - transcribe_started:.2f}s）："
                      f"{type(error).__name__}: {error}",
                      file=sys.stderr, flush=True)
                hint = describe_runtime_failure(error)
                if hint:
                    print(f"[识别] {hint}", file=sys.stderr, flush=True)
                failed_dir = os.path.join(args.queue_dir, "failed")
                try:
                    os.makedirs(failed_dir, exist_ok=True)
                    for suffix in (".pcm", QUEUE_META_SUFFIX):
                        if os.path.exists(os.path.join(args.queue_dir, base + suffix)):
                            os.rename(os.path.join(args.queue_dir, base + suffix),
                                      os.path.join(failed_dir, base + suffix))
                except OSError:
                    pass
                continue
            text = outcome.get("text", "")
            empty = outcome.get("empty", False)
            reason = outcome.get("reason")
            resolved_language = outcome.get("resolved_language")
            elapsed = time.perf_counter() - transcribe_started
            override_beam = profile.get("beam_size")
            if isinstance(handle, tuple) and len(handle) == 2 and isinstance(handle[1], str):
                pass            # whisper 句柄：(model, 实际精度)，beam 由引擎从 args 读
            _ = override_beam
            seconds = len(audio) / float(meta.get("rate") or args.samplerate)
            # ⚠️ 5.103：**慢了要说出慢在哪**。曾经一次调用 11.2 秒里有 10 秒既不在连接、
            # 也不在收结果 —— 因为那 10 秒是关闭握手且**完全没被计时**，于是"为什么没字幕"
            # 查了两轮。现在只要明显慢于音频长度，就把分阶段摊在日志里。
            if elapsed > max(2.0, seconds * 1.5):
                segment_timings = outcome.get("timings") if isinstance(outcome.get("timings"), dict) else {}
                if segment_timings:
                    covered = sum(value for value in segment_timings.values()
                                  if isinstance(value, (int, float)))
                    print("[识别] 这一段慢（耗时 "
                          f"{elapsed:.2f}s / 音频 {seconds:.2f}s）："
                          + " / ".join(f"{label} {segment_timings.get(key, 0):.2f}s"
                                       for key, label in (("connect", "连接"), ("wait_started", "等开始"),
                                                          ("send_audio", "送音频"), ("collect", "收结果"),
                                                          ("close", "断开"))
                                       if key in segment_timings)
                          + (f" / 其他 {elapsed - covered:.2f}s" if elapsed - covered > 0.05 else ""),
                          file=sys.stderr, flush=True)
            if empty:
                print(f"  [丢弃 {seconds:.1f}s，房间 {meta.get('room')}：{reason or '没有内容'}"
                      f"（耗时 {elapsed:.2f}s）]",
                      file=sys.stderr, flush=True)
                # 5.72：连丢到第 3 段就喊一次（只在"电平偏低"那种上喊，见 LevelWatch）
                # 5.109：门槛按这一段的策略算（表里没写才用命令行那个值）——
                # 否则"表里调了 silence_skip_level"和这条提示会各说一套。
                advisory = level_watch.note(meta.get("room"), reason,
                                            threshold=profile.get("silence_skip_level"))
                if advisory:
                    print(f"[识别] {advisory}", file=sys.stderr, flush=True)
            else:
                level_watch.reset(meta.get("room"))
                # ⚠️ 每行都带 room：下游（asr-worker）靠它把文字送回**这一场**的收件箱。
                # 队列模式与"一个收件箱"的旧模式差别就在这里 —— 归属是**数据自带的**，不靠猜。
                #
                # ⚠️ 4.94：`from` 必须是**语种标签**（`zh-CN`），不是 Whisper 码（`zh`）。
                #    这里原样写 `resolved_language` 时，插件判不出翻译方向，报的是
                #    「目标语种无法推导，请显式传 to」—— 而识别其实完全正常，
                #    所以这条错误会把人的注意力引到错误的地方（用户实测踩到）。
                # 5.177：**这一段的账跟着数据走** —— 段长 / 排队 / 识别耗时都在这儿算好了，
                # 以前只打在日志里，于是"一句一行摘要"只能在 relay 那边靠时间戳猜。
                # 现在随 payload 进收件箱、进帧，最后由 relay 在推送那一刻一次打出来。
                seg_ms = int(meta.get("ms") or 0)
                queue_ms = max(0, picked_at_ms - int(meta.get("queuedAt") or picked_at_ms))
                asr_ms = int(round(elapsed * 1000))
                seg_no = int(meta.get("seg") or 0)
                seg_id = str(meta.get("segId") or "")
                # 5.177："等静音"那一段也要带上 —— 摘要把 ⇒ 定义成
                # **说完到手机**（静音判定 + 排队 + 识别 + 翻译 + 推送），少了它就少算一截。
                # 5.192：这个段的"等静音"取**它自己那份策略**里的值
                # （以前从全局文件拿，那份文件已删除；从策略里拿也更准确：
                #  同一场会里不同语种可以用不同的 silence_ms）
                try:
                    profile_seg = profile.get("segmentation") or {}
                    silence_ms_now = int(profile_seg.get("silence_ms") or args.silence_ms)
                except Exception:                              # noqa: BLE001
                    silence_ms_now = int(getattr(args, "silence_ms", 0) or 0)
                payload = {"room": meta.get("room"), "text": text,
                           "seg": seg_no, "segId": seg_id,
                           "segMs": seg_ms, "queueMs": queue_ms, "asrMs": asr_ms,
                           "silenceMs": silence_ms_now}
                tag = language_tag(resolved_language)
                if tag is not None:
                    payload["from"] = tag
                # 5.08：段是从谁的分轨文件切出来的，就把那个人带下去（下游给字幕落名字时
                # 不用再猜"这个房间最近谁上传过" —— 两人交替说话时那个会记错人）。
                who = meta.get("speaker")
                if isinstance(who, str) and who.strip() != "":
                    payload["speaker"] = who.strip()
                # 5.41：策略名随数据往下走（收件箱行 → 大脑 → 日志）。
                payload["strategy"] = strategyName
                if lid_note is not None:
                    # 判定过程随数据走：会议记录/重放报告里能直接看"这段被判成什么、
                    # 段自带的又是什么、花了几毫秒" —— 这就是"先看 LID 效果"的依据。
                    payload["lid"] = lid_note
                payload["model"] = profile.get("model")
                # 5.148：冻结时间也带下去 —— 事后核对"这一句用的是哪一份快照"
                if isinstance(profile.get("strategyLockedAt"), str) and profile["strategyLockedAt"]:
                    payload["strategyLockedAt"] = profile["strategyLockedAt"]
                print(json.dumps(payload, ensure_ascii=False), flush=True)
                # 5.177：**原文行**（用户要求：打印识别到的原文 + 对应编号，才能追踪）。
                # 这是 summary 档唯一"每句必有"的一行，所以它同时承担编号的锚点。
                units = spoken_units(text)
                label = seg_id or f"#{seg_no}" if seg_no > 0 else str(meta.get("room") or "?")
# 5.181：这一行属于 summary 档；quiet（生产）下不打 —— 原文与译文都在会议记录里。
                if log_level_at_least("summary"):
                    print(f"[原文] {label} {tag or '?'} {units}{'字' if has_cjk(text) else '词'}"
                          f"「{preview(text)}」", file=sys.stderr, flush=True)
                # 以下两行（策略明细 / 延迟账）现在是 detail 档：内容已经进了摘要行，
                # 现场不需要每句看两遍；排障时 --log-level detail 原样拿得到。
                if log_level_at_least("detail"):
                    print(f"[识别] 房间 {meta.get('room')} 策略 {strategyName}"
                          f"（模型 {profile.get('model')}，切句由 {cutStrategy or '旧版段（无策略名）'}）"
                          f" → {seconds:.1f}s 出{'字' if has_cjk(text) else '词'} {units}"
                          f"，耗时 {elapsed:.2f}s",
                          file=sys.stderr, flush=True)
                    # 5.169：**延迟账**（用户要求：不用录音对表也能看出时间花在哪一段）。
                    # 切句那一段这里量不到（它是"等静音 / 等到上限"，发生在切句进程里），
                    # 所以把**配置值**写出来 —— 一眼就知道该不该去管理台调小。
                    try:
                        # 5.192：切句参数取**这一段自己那份策略**里的值（全局旋钮已删除；
                        # 而且同一场会里不同语种可以用不同的 silence/max，猜命令行反而错）
                        profile_seg = profile.get("segmentation") or {}
                        silence_ms = profile_seg.get("silence_ms", args.silence_ms)
                        max_ms = profile_seg.get("max_speech_ms", args.max_speech_ms)
                        print(f"[延迟] 房间 {meta.get('room')}：音频 {seg_ms / 1000.0:.1f}s"
                              f"｜排队 {queue_ms / 1000.0:.2f}s｜识别 {elapsed:.2f}s"
                              f"｜切句 silence={silence_ms}ms/max={max_ms}ms",
                              file=sys.stderr, flush=True)
                    except Exception as error:                # noqa: BLE001
                        print(f"[延迟] 记不了这一段（{type(error).__name__}: {error}）",
                              file=sys.stderr, flush=True)
            processed += 1
            # ⚠️ 处理完就删：队列目录同时是"待处理清单"，删掉才算消费完。
            for suffix in (".pcm", QUEUE_META_SUFFIX):
                try:
                    os.unlink(os.path.join(args.queue_dir, base + suffix))
                except OSError:
                    pass
        now = time.monotonic()
        if args.queue_depth_report_s > 0 and now - last_report >= args.queue_depth_report_s:
            last_report = now
            pending = len(_pending_segments(args.queue_dir))
            if pending > 0:
                # 5.177：队列**空着**时不报 —— 安静时那两行是纯噪音；有积压才说
                # （那是"识别跟不上"的唯一证据），而且并成一行。
                print(f"[识别] 队列积压 {pending} 段，最长已等 {waited_ms_max / 1000.0:.1f}s"
                      f"（累计转写 {processed} 段"
                      + (f"，前置 VAD 丢掉 {vad_dropped} 段" if vad_dropped > 0 else "")
                      + (f"，语种判定 {lid_used} 段（与段自带不同 {lid_differs} 段）"
                         if lid_used > 0 else "")
                      + (f"，远程按声明语种 {lid_trusted} 段（不判）"
                         if lid_trusted > 0 else "")
                      + (f"，沿用上一次判定 {lid_reused} 段（省下的那 0.3 秒）"
                         if lid_reused > 0 else "")
                      + "）", file=sys.stderr, flush=True)
                # 5.40：把"哪一级决定了哪个模型、各处理了多少段"摊开 ——
                # 没有这一行，A/B 时根本说不清"这些字幕到底是哪个模型出的"
                if log_level_at_least("detail"):
                    print(f"[识别] 按档案分流：{pool.report()}", file=sys.stderr, flush=True)
            elif log_level_at_least("detail"):
                print(f"[识别] 队列深度 0 段（累计转写 {processed} 段），"
                      f"按档案分流：{pool.report()}", file=sys.stderr, flush=True)
            waited_ms_max = 0


def _stamp_of(path):
    """文件的 mtime（用来判断模型表有没有被改过）。读不到返回 None。"""
    if not path:
        return None
    try:
        return os.stat(path).st_mtime_ns
    except OSError:
        return None


def _cli_profile(args):
    """命令行那组"缺省档案"，与队列消费者里 resolve_strategy 的 base **同一口径**。

    <p>口径必须只有一份：日志按一套算、实际按另一套算，就是"日志和现场对不上"的根源。
    这里刻意用**启动时真正加载的那一份**（`startup_model` / `resolved_compute`）——
    表的 `default` 可能已经把它们改过，用旧命令行值会把表的结论盖掉。
    """
    return {
        "model": getattr(args, "startup_model", None) or getattr(args, "model", None),
        "compute_type": getattr(args, "resolved_compute", None) or getattr(args, "compute_type", None),
        "beam_size": getattr(args, "beam_size", None),
        "engine": getattr(args, "engine", None),
    }


def probe_cloud_engines(table, engines):
    """启动时探一次**云端引擎**的密钥（只读环境/文件，不联网、不加载模型）。

    <p>为什么要有它：5.131 真机上 `en-US → en-tencent` 切完之后，表现是**每段**都打一行
    「这一段要求的引擎/模型 tencent:16k_en 加载失败（…缺密钥…）」，而真正的原因
    （服务环境里没有 `TENCENT_ASR_SECRET_FILE`）要在几十行滚动日志里翻才看得出来。
    密钥是**静态配置**，跟这一段音频是什么无关 —— 这类错误应该在启动时就说清。

    @returns 要打到 stderr 的若干行（没有问题时是空列表）
    """
    lines = []
    used = _engines_used_by(table)
    for key, hint in (
        ("tencent", "变量应写进 /etc/leion/secrets.env（asr.env 是 make-env-file.py 生成的那份），"
                    "改完要 restart；再核对：sudo tr '\\0' '\\n' < /proc/$(pgrep -f asr-worker | head -1)"
                    "/environ | grep TENCENT"),
        ("funasr", "检查 DASHSCOPE_API_KEY / DASHSCOPE_WS_URL 是否进了服务环境"
                   "（/etc/leion/secrets.env），改完要 restart"),
    ):
        if key not in used:
            continue
        engine = (engines or {}).get(key)
        if engine is None:
            # 表里写了这个引擎但注册表里没有 —— resolve_engine 会在别处直接报错，这里不重复喊
            continue
        try:
            # ⚠️ 5.183：带上表里给这个引擎的 model —— 不给的话 funasr 会误报
            #    「模型 ID 必须写在策略表里」，把人的注意力引到完全错误的地方。
            profile = {"engine": key}
            model_of_engine = ""
            if isinstance(used, dict):
                model_of_engine = used.get(key) or ""
            if isinstance(model_of_engine, str) and model_of_engine != "":
                profile["model"] = model_of_engine
            engine.load(profile, "cpu")
        except Exception as error:                                  # noqa: BLE001
            lines.append(f"[whisper_stream] ⚠️ 表里用到了云端引擎 {key}，但这台机器的环境里用不了它："
                         f"{type(error).__name__}: {error}")
            lines.append(f"[whisper_stream]    → {hint}")
    return lines


def _engines_used_by(table):
    """这张表里用到了哪些**引擎** —— 返回 {引擎: 它对应的 model}（三层都看）。

    <p>⚠️ 5.183：原来只返回引擎名的 set，于是 probe 里拿**空的 profile** 去 load() ——
    funasr 的 load 一看没有 model 就报「模型 ID 必须写在策略表里」，而表里明明写着
    fun-asr-realtime。现场看到的是一句指向完全错误的警告。
    现在把 model 一并带出来：探测用真实 profile，报的才是真实原因（缺密钥 / 缺依赖）。

    @returns {dict[str, str]} 引擎 → 表里给它的 model（多层都写时取最后出现的那个）
    """
    used = {}

    def add(entry):
        if isinstance(entry, dict):
            engine = str(entry.get("engine") or "").strip().lower()
            if not engine:
                return
            model = entry.get("model")
            if isinstance(model, str) and model.strip() != "":
                used[engine] = model.strip()
            elif engine not in used:
                used[engine] = ""

    if not isinstance(table, dict):
        return used
    add(table.get("default"))
    for group in ("strategies", "languages"):
        bucket = table.get(group)
        if isinstance(bucket, dict):
            for entry in bucket.values():
                add(entry)
    return used


def describe_asr_table(table, cli=None):
    """把模型表摊成一行（启动日志与热加载日志都用它）。

    <p>⚠️ 5.97：原来这里只打印 `languages[语种].model`，于是"语种里钉的是**策略**"
    （`{"pt-BR": {"strategy": "pt-funasr"}}`）在日志里被显示成 `pt-BR=（沿用 default）`。
    现场看到的就是"我的葡语云端配置怎么没了"，而实际上 Fun-ASR 一直在用。
    **日志说错话比不打印更糟** —— 它会把人支到错误的方向上去查。

    现在按**实际解析出来的结果**打印 `语种=策略名 → 引擎/模型`；策略名在表里根本不存在
    时（拼错、或者表是别人手改的）也当场喊出来，而不是安静地按继承的层跑。

    @param cli 命令行那组缺省（模型/精度/引擎）。不传就只按表算 ——
               启动日志里传了才能看出"这个值到底来自哪一层"。
    """
    if not isinstance(table, dict) or not table:
        return "（没有模型表，所有语种都用命令行那一个模型）"
    cli = cli or {}
    strategies = table.get("strategies") if isinstance(table.get("strategies"), dict) else {}
    parts = []
    default = _profile_of(table.get("default"), {})
    if default.get("model"):
        default_engine = str(default.get("engine") or DEFAULT_ENGINE)
        parts.append(f"default={default_engine}/{default['model']}")
    languages = table.get("languages")
    if isinstance(languages, dict):
        for key in sorted(languages):
            # 用真的解析器算，别自己猜层级 —— 猜出来的日志迟早和实际行为对不上
            profile = resolve_strategy(key, cli, table)
            name = str(profile.get("strategy") or "default")
            engine = str(profile.get("engine") or DEFAULT_ENGINE)
            model = profile.get("model") or "（引擎缺省）"
            label = f"{key}={name} → {engine}/{model}"
            if name != "default" and name not in strategies:
                label += f"（⚠️ 表里没有策略 '{name}'，实际走的是它继承的那几层）"
            parts.append(label)
    return "；".join(parts) if parts else "（表是空的）"


# ── 单独试识别（5.99）────────────────────────────────────────────────────────
#
# 用户原话：「还是没有输出 我建议单独测试识别功能」。
# 这话是对的 —— 现场那条链路有四个环节（手机→转发→切句→识别→大脑），
# 任何一环坏了表现出来都是"没字幕"，而从日志上很难一眼看出是哪一环。
# 这个模式把中间三层全部拆掉：**一段音频直接进引擎**，只回答一个问题 ——
# "这份引擎+模型+这份音频，到底出不出字，多久出，报什么错"。
#
# 两种输入：
#   --try-queue <队列目录>  把流水线**真正产出**的那些段逐段跑（只读，不删）
#   --try-audio <文件>      跑任意一段（wav，或 --try-rate 给裸 PCM）
# 两者都按**每一段自己的语种**走完整的 resolve_strategy，所以房间侧车/表/languages
# 这几层照样生效 —— 否则"单独测"会得出与实际不同的结论，那比不测更糟。

TRY_RAW_SUFFIXES = (".pcm", ".raw", ".s16", ".sw")


def read_try_audio(path, rate_hint, np):
    """读一段音频成 float32 单声道，返回 `(audio, rate, 来源说明)`。

    <p>wav 按头里的采样率；裸 PCM 按 `--try-rate` → 同名 `.rate` 旁文件 → 报错让
    人明说，**不猜** —— 猜错采样率的表现是"识别出一堆乱码"，而人会以为模型坏了。
    """
    import wave

    lowered = str(path).lower()
    if lowered.endswith(".wav"):
        with wave.open(path, "rb") as wav:
            rate = wav.getframerate()
            channels = wav.getnchannels()
            width = wav.getsampwidth()
            raw = wav.readframes(wav.getnframes())
        if width != 2:
            raise RuntimeError(f"{path} 是 {width * 8} bit 的 wav，只支持 16 bit（PCM）")
        audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        if channels > 1:
            audio = audio.reshape(-1, channels).mean(axis=1)
        return audio, rate, f"wav 头（{channels} 声道 / {width * 8} bit）"
    rate = rate_hint
    origin = "--try-rate"
    if rate is None:
        sidecar = os.path.splitext(str(path))[0] + ".rate"
        if os.path.exists(sidecar):
            try:
                with open(sidecar, encoding="utf-8") as handle:
                    rate = int(str(handle.read()).strip())
                origin = f"旁文件 {os.path.basename(sidecar)}"
            except (OSError, ValueError):
                rate = None
    if rate is None:
        raise RuntimeError(
            f"{path} 是裸 PCM，不知道采样率。给 --try-rate 16000（队列里的段都是 16k），"
            "或者同名写一个 `.rate` 旁文件")
    with open(path, "rb") as handle:
        raw = handle.read()
    # 奇数长度说明文件被截断了：直接说，别悄悄当成少一个采样点
    if len(raw) % 2 != 0:
        print(f"[try] ⚠️ {path} 的字节数是奇数（{len(raw)}），末尾那半个采样点会被丢掉",
              file=sys.stderr)
        raw = raw[:-1]
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    return audio, rate, f"裸 PCM（{origin}）"


def describe_try_sources(data_dir):
    """队列空了以后，告诉人"还能拿什么试" —— 返回几行人话（不含任何写入）。

    <p>为什么要这个：实测第一次跑 `asr-try` 时队列**已经空了**（识别消费者处理完就删段），
    于是只得出一句"没有待处理的段"，人除了"再录一次"没别的办法。
    而现场**本来就留着更原始的东西**：`<data-dir>/audio/<房间>/<说话人>.pcm`
    —— relay 按说话人分流的原始音频。拿它切一段来试，比重新录一遍更接近事故现场。
    """
    lines = []
    audio_root = os.path.join(str(data_dir or ""), "audio") if data_dir else ""
    tracks = []
    if audio_root and os.path.isdir(audio_root):
        for room in sorted(os.listdir(audio_root)):
            room_dir = os.path.join(audio_root, room)
            if not os.path.isdir(room_dir):
                continue
            for name in sorted(os.listdir(room_dir)):
                path = os.path.join(room_dir, name)
                if not name.endswith(".pcm") or not os.path.isfile(path):
                    continue
                try:
                    size = os.path.getsize(path)
                    mtime = os.path.getmtime(path)
                except OSError:
                    continue
                tracks.append((mtime, path, size, room, name))
    tracks.sort(reverse=True)
    if tracks:
        lines.append("[try] 队列空了，但**原始分轨音频还在**（relay 按说话人写的那份）：")
        for _mtime, path, size, room, name in tracks[:5]:
            seconds = size / 2.0 / 16000.0        # 16k 单声道 16bit
            lines.append(f"[try]   {path}（{seconds:.1f}s，房间 {room}，说话人 "
                         f"{name[:-4]}）")
        first = tracks[0][1]
        first_seconds = tracks[0][2] / 2.0 / 16000.0
        want = max(1, min(8, int(round(first_seconds))))
        lines.append("[try] 从里面切一段来试（16k 单声道裸 PCM）：")
        lines.append(f"[try]   node scripts/asr-try.mjs --pcm {first} --rate 16000 "
                     f"--offset 0 --seconds {want} --lang pt-BR")
    failed_dir = os.path.join(str(data_dir or ""), "queue", "asr", "failed") if data_dir else ""
    if failed_dir and os.path.isdir(failed_dir):
        stuck = [name for name in sorted(os.listdir(failed_dir)) if name.endswith(".json")]
        if stuck:
            lines.append(f"[try] ⚠️ 另外 queue/asr/failed/ 里有 {len(stuck)} 段"
                         "（那几段是**转写时抛异常**被挪出来的，需要单独看原因）")
    return lines


def run_try(args, np, engines):
    """单独试识别：一段或一批音频直接进引擎。返回进程退出码。

    <p>退出码：0 = 至少有一段出字；3 = 引擎都正常但没出字（"识别确实听不出东西"）；
    2 = 配置/依赖/加载就没过（"根本没跑到识别"）。三种情况必须能区分 ——
    混成一个"失败"就等于让人回去猜。
    """
    table = args.asr_table if isinstance(args.asr_table, dict) else {}
    pool = ModelPool(engines, max_models=max(1, args.max_models),
                     log=lambda line: print(line, file=sys.stderr, flush=True),
                     device=args.device)
    # ① 收集要试的段
    items = []
    if args.try_queue:
        bases = sorted(_pending_segments(args.try_queue))
        if not bases:
            print(f"[try] 队列 {args.try_queue} 里没有待处理的段"
                  "（识别消费者处理完就删段，所以空队列是正常的）",
                  file=sys.stderr)
            for line in describe_try_sources(args.data_dir):
                print(line, file=sys.stderr)
            return 3
        for base in bases:
            got = _read_segment(args.try_queue, base, np)
            if got is None:
                print(f"[try] 跳过 {base}（读不出来）", file=sys.stderr)
                continue
            meta, audio = got
            items.append((base, meta, audio))
    else:
        try:
            audio, rate, origin = read_try_audio(args.try_audio, args.try_rate, np)
        except Exception as error:                                  # noqa: BLE001
            print(f"[try] ✗ 读不了 {args.try_audio}：{type(error).__name__}: {error}", file=sys.stderr)
            return 2
        # 分轨文件会越写越长，常常是几分钟；直接整段送去识别既慢又不是"一句"
        total_seconds = len(audio) / float(rate)
        offset = max(0.0, float(getattr(args, "try_offset", 0.0) or 0.0))
        want = float(getattr(args, "try_seconds", 0.0) or 0.0)
        if offset > 0 or want > 0:
            start = int(offset * rate)
            stop = int((offset + want) * rate) if want > 0 else len(audio)
            audio = audio[start:stop]
            if len(audio) == 0:
                print(f"[try] ✗ --offset {offset:g}s 已经超出这段音频（总长 {total_seconds:.2f}s）",
                      file=sys.stderr)
                return 2
            print(f"[try] 截取 {offset:g}s 起、{len(audio) / float(rate):.2f}s"
                  f"（原长 {total_seconds:.2f}s）", file=sys.stderr)
        print(f"[try] 音频 {args.try_audio}：{origin}，{rate} Hz，"
              f"{len(audio) / float(rate):.2f}s", file=sys.stderr)
        items.append((os.path.basename(args.try_audio), {"lang": args.language, "rate": rate}, audio))

    print(f"[try] 共 {len(items)} 段，语种按**每一段自己的**来（表 languages/strategies/default 三层照常生效）",
          file=sys.stderr)
    total = {"text": 0, "empty": 0, "failed": 0}
    elapsed_sum = 0.0
    audio_sum = 0.0
    for index, (label, meta, audio) in enumerate(items, start=1):
        rate = int(meta.get("rate") or args.try_rate or args.samplerate)
        seconds = len(audio) / float(rate)
        language = meta.get("lang") or args.language
        room = meta.get("room")
        strategy = resolve_strategy(language, _cli_profile(args), table)
        name = str(meta.get("strategy") or strategy.get("strategy"))
        engine_key = str(strategy.get("engine") or DEFAULT_ENGINE)
        print(f"\n[try] ── 第 {index}/{len(items)} 段：{label}"
              f"（房间 {room or '—'}／{language or '自动'}／{seconds:.2f}s）", file=sys.stderr)
        print(f"[try]    解析：策略 {name} → 引擎 {engine_key}／模型 "
              f"{strategy.get('model') or '（引擎缺省）'}"
              f"（模型来自 {strategy.get('sources', {}).get('model') or '?'}）", file=sys.stderr)
        # 5.109：两个"电平"旋钮也打出来 —— 试测的目的常常就是"这个门槛对不对"
        tuned = []
        for key, label in zip(LEVEL_FIELDS, ("识别侧", "切句侧")):
            if strategy.get(key) is not None:
                tuned.append(f"{label} {key}={strategy[key]}"
                             f"（来自 {strategy.get('sources', {}).get(key) or '?'}）")
        if tuned:
            print("[try]    电平门槛：" + "；".join(tuned), file=sys.stderr)
        level = float(np.sqrt(np.mean(np.square(audio)))) if len(audio) else 0.0
        peak = float(np.max(np.abs(audio))) if len(audio) else 0.0
        print(f"[try]    电平：RMS {level:.4f} 峰值 {peak:.4f}"
              f"（人声一般峰值 > 0.1；这里低就说明**这段音频本来就没声音**，"
              "不是识别的问题）", file=sys.stderr)
        try:
            engine = resolve_engine(strategy, engines)
            handle = pool.get(strategy, device=args.device)
        except Exception as error:                                  # noqa: BLE001
            total["failed"] += 1
            print(f"[try] ✗ 引擎/模型没起来：{type(error).__name__}: {error}", file=sys.stderr)
            if str(engine_key) == DEFAULT_ENGINE:
                print(model_load_failure(strategy.get("model"), error,
                                         strategy.get("compute_type") or "float16"), file=sys.stderr)
            continue
        started = time.perf_counter()
        try:
            outcome = engine.transcribe(handle, audio, language, strategy)
        except Exception as error:                                  # noqa: BLE001
            elapsed = time.perf_counter() - started
            elapsed_sum += elapsed
            audio_sum += seconds
            total["failed"] += 1
            print(f"[try] ✗ 转写抛异常（耗时 {elapsed:.2f}s）：{type(error).__name__}: {error}",
                  file=sys.stderr)
            continue
        elapsed = time.perf_counter() - started
        elapsed_sum += elapsed
        audio_sum += seconds
        text = str(outcome.get("text") or "")
        timings = outcome.get("timings") if isinstance(outcome.get("timings"), dict) else {}
        if timings:
            # 分阶段耗时：整体慢的时候，"慢在哪一段"是唯一有用的信息。
            # "其他"是**没有被这五段覆盖的部分**（模型加载、numpy 转换等）——
            # 留着它不是洁癖：11 秒里曾经有 10 秒既不在连接也不在收结果，
            # 正是因为那 10 秒没有名字，才查了两轮。
            covered = sum(value for value in timings.values() if isinstance(value, (int, float)))
            leftover = elapsed - covered
            print("[try]    分阶段：" + " / ".join(
                f"{label} {timings.get(key, 0):.2f}s"
                for key, label in (("connect", "连接"), ("wait_started", "等开始"),
                                   ("send_audio", "送音频"), ("collect", "收结果"),
                                   ("close", "断开"))
                if key in timings)
                + (f" / 其他 {leftover:.2f}s" if leftover > 0.05 else ""), file=sys.stderr)
        if outcome.get("empty") or text.strip() == "":
            total["empty"] += 1
            print(f"[try] · 没出字（耗时 {elapsed:.2f}s，RTF {elapsed / seconds:.2f}）："
                  f"{outcome.get('reason') or '引擎没说原因'}", file=sys.stderr)
        else:
            total["text"] += 1
            print(f"[try] ✓ 出字（耗时 {elapsed:.2f}s，RTF {elapsed / seconds:.2f}，"
                  f"语种 {outcome.get('resolved_language') or '?'}）：{text}", file=sys.stderr)

    print("", file=sys.stderr)
    print(f"[try] 小结：出字 {total['text']} / 没出字 {total['empty']} / 失败 {total['failed']}"
          f"（音频合计 {audio_sum:.1f}s，识别耗时合计 {elapsed_sum:.1f}s，"
          f"RTF {elapsed_sum / audio_sum:.2f}）" if audio_sum > 0
          else f"[try] 小结：出字 {total['text']} / 没出字 {total['empty']} / 失败 {total['failed']}",
          file=sys.stderr)
    if total["text"] > 0:
        return 0
    if total["failed"] > 0 and total["empty"] == 0:
        return 2
    return 3


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
        # 5.52：上一段收句时**尾部静音裁掉了多少毫秒**（0 = 没裁）。日志用它解释
        # "为什么句尾那个词少了一截"——裁掉的尾巴紧贴最后一个音节。
        self.last_tail_trim_ms = 0
        # ── 被丢弃的短碎片（只记录位置与长度，**不改变任何行为**）──────────────
        # 为什么要能取出来：`--silence-ms` 从 500 提到 800 的收益里，有一大块来自
        # "碎片不再被丢"，但 `覆盖率` 这个数**说不清丢的到底是静音还是真话**
        # （审阅意见就是这个：82.1% 的覆盖率不等于漏了 17.9% 的话）。
        # 记下每一段被丢掉的区间之后，就能拿官方句的起止时间对照：
        # 落在句内的多半是**有效语音**，落在句间空白的基本是静音/换气。
        self.samplerate = samplerate
        self.fed_samples = 0     # 已经送进切句器的采样数（用来算丢掉的区间在流里的位置）
        self.dropped_runs = []   # [{"start": 秒, "end": 秒, "voicedMs": 毫秒}]

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
        self.fed_samples += int(block.size)      # 供"被丢掉的区间"定位（见 dropped_runs）
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
            # 记下这次丢掉的区间（只记录，不改变行为）——见 __init__ 里 dropped_runs 的说明
            length = sum(int(block.size) for block in blocks) if blocks else 0
            end = self.fed_samples
            run = {
                "start": round((end - length) / float(self.samplerate), 3),
                "end": round(end / float(self.samplerate), 3),
                "voicedMs": round(self.block_ms * voiced, 1),
            }
            self.dropped_runs.append(run)
            # 5.52：**丢东西必须说出来**。以前这里只进内存列表，日志里一个字都没有 ——
            # 于是"某些音节被删掉了"这种问题只能靠猜（用户实测报过：academic → Islamic）。
            #
            # 5.177：但**不能每段一行** —— 实机 40 秒里就有 6 行"丢掉一段碎片"，
            # 把真正要看的东西淹了。现在：突发里**第一段立刻说**（真丢话不能等），
            # 之后只计数，攒够 30 秒再汇总一行；切出正常句子就把计数清零。
            burst = getattr(self, "drop_burst", None)
            if not isinstance(burst, dict):
                burst = {"count": 0, "ms": 0.0, "min_ms": None, "short": 0}
                for attribute in ("last_print",):
                    burst[attribute] = 0.0
                self.drop_burst = burst
            burst["count"] = int(burst.get("count", 0)) + 1
            burst["ms"] = float(burst.get("ms", 0.0)) + float(run["voicedMs"])
            shortest = burst.get("min_ms")
            burst["min_ms"] = run["voicedMs"] if shortest is None else min(float(shortest), run["voicedMs"])
            now_s = time.monotonic()
            first_in_burst = burst["count"] == 1
            long_enough_to_matter = run["voicedMs"] >= 1000
            due = now_s - float(burst.get("last_print", 0.0)) >= 30.0
            if first_in_burst or long_enough_to_matter or due:
                burst["last_print"] = now_s
                if burst["count"] > 1:
                    print(f"[切句] ⚠️ 丢弃 {burst['count']} 段（共 {burst['ms']:.0f}ms，"
                          f"最短 {burst['min_ms']:.0f}ms < min-speech "
                          f"{self.min_blocks * self.block_ms}ms）—— 那里如果其实在说话，"
                          f"这些就是**被吃掉的音节**",
                          file=sys.stderr, flush=True)
                else:
                    print(f"[切句] ⚠️ 丢掉一段碎片：{run['start']:.1f}s–{run['end']:.1f}s "
                          f"（语音只有 {run['voicedMs']:.0f}ms < min-speech "
                          f"{self.min_blocks * self.block_ms}ms）"
                          f"—— 如果那里其实是说话，这就是**被吃掉的音节**",
                          file=sys.stderr, flush=True)
                if long_enough_to_matter:
                    # 超过 1 秒的整段被丢，是"真的少了半句话"，计数清零重新算
                    burst["count"] = 0
                    burst["ms"] = 0.0
                    burst["min_ms"] = None
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
        # 5.52：把"裁掉多少尾巴静音"记下来，交给上层打日志。
        # 为什么重要：这个裁剪**紧贴最后一个音节**，如果最后一个音节偏轻（被算成静音块），
        # 它就会被一起削掉 —— 表现是"句尾那个词少了一截"，比如 meeting → meetin。
        # 以前这个数完全不可见，用户只能凭"好像少了点"去猜。
        self.last_tail_trim_ms = tail * self.block_ms
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
            self.last_tail_trim_ms = tail * self.block_ms
            return self._release(blocks, voiced)
        self.buffer = []
        self.speaking = False
        self.voiced = 0
        self.last_tail_trim_ms = 0
        return None


# ── 识别 ─────────────────────────────────────────────────────────────────────

def looks_like_hallucination(text: str) -> bool:
    lowered = text.lower()
    return any(sample in lowered for sample in HALLUCINATION_SAMPLES)


# ── 解码前的静音闸（2026-10-23 加：实测又出了一次幻听）──────────────────────
#
# 现场日志（电平是 relay 记的原始值）：
#   RMS 0.0012 / 0.0019 / 0.0025 / 0.0028 / 0.0033 / 0.0038 / 0.0043 / 0.0049
#   人声一般 ≥ 0.02（SPEECH_RMS_FLOOR）
#   → 这些段被识别成「中文字幕提供」「中文字幕志愿者 李宗盛」，还当成真字幕发了出去。
#
# 机制：`normalize_peak()` 会把**峰值低于 0.3** 的音频抬到 0.9 附近。
#   "说话声偏小"时这是好事（实测过），但"几乎没声音"时它等于**把噪声放大上百倍**再喂模型，
#   模型于是一定会"听出"点东西。幻听词表只能事后拦，拦不住新花样。
#
# 所以正确做法是**在解码之前**按原始电平丢掉：不出幻听，还省一次识别。
# 阈值取 0.02 = 与 SPEECH_RMS_FLOOR **同一个数**（人声门槛）。
# 判据用**归一化之前**的电平 —— 归一化之后就没有"安静"可言了。
SILENCE_SKIP_RMS = 0.02


class LevelWatch:
    """盯「因为电平太低而连丢好几段」—— 这是这次实机最贵的一个坑（5.72）。

    <p>每段丢弃时日志里那句 `[丢弃 … 电平偏低 … 调到 0.0105 就能救回]` **太安静了**：
    它埋在几十行里，而现象是"一句字幕都没有"，人第一反应是"识别坏了"。
    实机上就这么查了三轮才回到电平上 —— 所以这里改成**连丢到第 3 段就喊一次**：
    一条包含"连丢几段 / 电平范围 / 建议门槛"的醒目提示，每个房间每次进程只喊一次。

    <p>⚠️ 只统计 `电平偏低`（接近门槛那种）。`近乎静音` 不进来 —— 那是"真的没有声音"，
    对这类也喊"调低门槛"会把人引去把静音送去识别（更糟）。
    """

    WARN_AFTER = 3

    def __init__(self, threshold):
        self.threshold = threshold
        self.counts = {}
        self.levels = {}
        self.warned = set()

    def reset(self, room):
        """有段成功出字 → 说明门槛没挡住正常说话，重新计数。"""
        if room is None:
            return
        self.counts.pop(room, None)
        self.levels.pop(room, None)

    def note(self, room, reason, threshold=None):
        """记一次丢弃；到阈值返回提示文本（已提示过就返回 None）。

        <p>5.109：`threshold` 可以每段不同（来自策略表）。只影响**提示里写哪个门槛**，
        计数与"每房间只喊一次"的语义不变 —— 否则换了门槛之后那句建议会写得对不上。
        """
        if threshold is not None:
            self.threshold = threshold
        if room is None or not isinstance(reason, str):
            return None
        if not reason.startswith("电平偏低"):
            return None
        level = _level_from_reason(reason)
        self.counts[room] = self.counts.get(room, 0) + 1
        if level is not None:
            self.levels.setdefault(room, []).append(level)
        if self.counts[room] < self.WARN_AFTER or room in self.warned:
            return None
        self.warned.add(room)
        levels = self.levels.get(room) or []
        span = ""
        if levels:
            span = f"电平 {min(levels):.4f}~{max(levels):.4f}"
        suggested = None
        if levels:
            suggested = max(0.004, round(min(levels) * 0.8, 4))
        return (f"房间 {room} 已经连丢 {self.counts[room]} 段（{span}，门槛 {self.threshold}）—— "
                f"⚠️ 这几乎不是「识别坏了」，而是**麦克风偏轻**："
                + (f"把 --silence-skip-level 调到 {suggested} 左右再看"
                   if suggested is not None else "把 --silence-skip-level 调低一点再看")
                + "（这条提示每个房间只出现一次）")


def _level_from_reason(reason):
    """从 `silence_skip_reason` 的文本里取回原始电平（取不到就返回 None，不猜）。"""
    match = re.search(r"原始(?:电平)?\s*([\d.]+)", reason)
    if match is None:
        return None
    try:
        return float(match.group(1))
    except (TypeError, ValueError):
        return None


def has_cjk(text):
    """文本里有没有中日韩文字（用来决定"字"还是"词"做计数单位）。"""
    return any("\u3400" <= char <= "\u9fff" or "\u3040" <= char <= "\u30ff" for char in str(text or ""))


def spoken_units(text):
    """一段识别结果有多少**话**：中文按字、其它按词（5.73）。

    <p>为什么不能直接用 `len(text)`：英文 `hello world` 是 11 个字符、2 个词，
    拿字符数当"字数"会让英文的语速虚高好几倍。而这里要拿它算"每秒多少话"，
    单位错了，后面所有折算（丢掉的段 ≈ 几句话）都跟着错。

    <p>中文按字（不含标点/空白）、其余按空白分词 —— 与评测里 `asr_score` 的
    "中文字 / 葡英词"口径一致，两处不要各写一套。
    """
    value = str(text or "")
    if has_cjk(value):
        return sum(1 for char in value if "\u3400" <= char <= "\u9fff" or "\u3040" <= char <= "\u30ff")
    return len(value.split())


# ── 5.186：高通滤波（去低频轰鸣：空调、桌子震动、音箱低音）──────────────────────
#
# 为什么值得做：教室里的低频轰鸣能量很高，会让"按能量切句"以为一直有人在说话，
# 也会把识别侧的电平门槛顶高。砍掉 100 Hz 以下几乎不伤语音（人声基频男 ~85Hz、
# 女 ~200Hz，但**可懂度主要靠 300Hz 以上**），代价却接近零。
#
# 为什么自己写 biquad 而不是用 scipy：这台机器上 scipy 不是必需依赖，为了一行滤波
# 再引入一个几十 MB 的包不划算。二阶 IIR 用 numpy 循环 4 行就够（每段音频几毫秒）。
def highpass_biquad(signal, samplerate, cutoff_hz):
    """二阶高通（Butterworth Q=0.707）。返回新数组，不改原地。"""
    import numpy as np
    x = np.asarray(signal, dtype=np.float32)
    if x.size == 0 or cutoff_hz <= 0 or samplerate <= 0:
        return x
    nyquist = 0.5 * float(samplerate)
    if cutoff_hz >= nyquist * 0.9:          # 截止频率高到没意义：不动
        return x
    import math
    w0 = 2.0 * math.pi * float(cutoff_hz) / float(samplerate)
    cos_w0 = math.cos(w0)
    alpha = math.sin(w0) / (2.0 * (1.0 / math.sqrt(2.0)))
    b0 = (1.0 + cos_w0) / 2.0
    b1 = -(1.0 + cos_w0)
    b2 = (1.0 + cos_w0) / 2.0
    a0 = 1.0 + alpha
    a1 = -2.0 * cos_w0
    a2 = 1.0 - alpha
    # 归一化系数（a0 除到左边）
    b0, b1, b2, a1, a2 = b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0
    # 直接 II 型转置，逐样本递推（段只有几百毫秒到几秒，numpy 标量循环也够快）
    y = np.empty_like(x)
    x1 = x2 = y1 = y2 = 0.0
    for index in range(x.size):
        value = float(x[index])
        out = b0 * value + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        x2, x1 = x1, value
        y2, y1 = y1, out
        y[index] = out
    return y


def silence_skip_reason(audio, threshold=SILENCE_SKIP_RMS) -> str | None:
    """明显不是人声就返回丢弃原因（None = 照常解码）。

    单独成函数是为了能被测试直接钉住：这个闸判错一次，要么吃真字幕、要么放幻听进来。

    <p>5.52：**接近门槛时要说清楚**。电平在 threshold 的一半以上、又没过线，
    往往是"话说得很轻"而不是"没有声音"。以前一律报"近乎静音"，人就会去查麦克风，
    而真正该做的是把 `--silence-skip-level` 调低一点。
    """
    if audio is None or len(audio) == 0:
        return "空音频"
    level = rms_of(audio)
    if level < threshold:
        if level >= threshold * 0.5:
            return (f"电平偏低（原始 {level:.4f}，门槛 {threshold}）→ 按静音丢弃。"
                    f"⚠️ 这不是「没有声音」：如果这段确实在说话，把 --silence-skip-level 调到 "
                    f"{max(0.004, round(level * 0.8, 4))} 左右就能救回这一句")
        return (f"近乎静音（原始电平 {level:.4f} < {threshold}）"
                f"→ 解码前丢弃：不花识别时间，也不给幻听机会")
    return None


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
    # 5.00：英语这一条只是"想显式用时的候选"，**不进 DEFAULT_PROMPTS** ——
    # 理由和中文那句被否掉一样：引导语在短片段上会被模型回显成一句假字幕。
    "en": "The following are sentences in English.",
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
# 为什么加它（实测，同一段 31 分钟中文口语录音取 20 个连续段、同一个参考）：
#   · 逐段独立 16.8% → 前两段文本续传 15.1%（**零额外等待**：不多听一秒音频）
#   · 再配合 silence 500→800：13.9%（只差 1 个百分点追平"整段不切"）
# 机制：切碎的段缺上文，同音词只能靠猜；把上一两句的**文字**喂回去等于免费补语境。
# 代价：提示词变长，模型"照抄上文"的风险上升 —— 所以同时加了 looks_like_context_echo。
#
# ⚠️ **按语种给缺省，现在两个语种都是「关」（0）** —— 这不是没测，是测了中文、
#    而葡语**在真实连续录音上没测过**，所以按"没验证就别默认开"处理：
#
#    ① 中文，**一场录音**的 20 段（MagicData CTS-CN-F2F-2019-11-15-1421）：
#       500ms 16.8% → 15.0%、800ms 15.44% → 13.94%、1200ms 13.3% → 12.0%（都是 −1.3~−1.8p）
#       —— 这是最初"打开它"的依据。
#    ② 中文**跨 19 场录音**的 19 段（每场抽 1 段，段清单 context-dev-cross19，指纹 5cb8d418）：
#       800ms 20.76% → 24.24% = **+3.48 个百分点，反而更差**。
#       而且不是普遍变差：**中位变化 0.00p、8 段更好 / 7 段更差 / 4 段持平** ——
#       均值是被两段**灾难性失败**拉爆的：
#         · CTS-CN-F2F-2019-11-15-1449：25.8% → 90.7%（整段变成幻听惯用语
#           「请不吝点赞订阅转发打赏支持明镜与点点栏目」，产线的幻听表会丢掉它）
#         · CTS-CN-F2F-2019-11-15-1447：19.4% → 47.3%（整段飘成**繁体**，繁体字 9 → 25 个）
#       去掉这两段，其余 17 段平均是 −1.6p（与 ① 一致）→ 收益是"通常小幅有用"，
#       风险是"少数场次灾难性变差"，**期望值为负**。
#    ③ 葡语：**没有连续录音可测**（CORAA 只有一句一条的片段），所以"续传在葡语上到底有没有用"
#       **没有结论**。那个代理实验（把不同人的相邻片段当上文）不能当证据 —— 它不是同一回事。
#
#    所以**两个语种的缺省都关**，但**保留开关**：`--context-depth 2` 可以显式打开。
#    什么时候可以重开？等"跨场、跨语料"的证据显示净收益为正 —— 现在缺的正是这个。
#    ⚠️ 别再拿"单场录音上 −1.5p"当依据：那正是这次被推翻的那个结论。
CONTEXT_DEPTH_BY_LANGUAGE = {"zh": 0, "pt": 0}
CONTEXT_DEPTH_FALLBACK = 0        # 语种不明时不开：没量过的组合不要默认打开


def context_depth_for(language):
    """这个语种缺省用不用上下文续传、取前几段（`--context-depth` 显式给了就以它为准）。"""
    return CONTEXT_DEPTH_BY_LANGUAGE.get(language or "", CONTEXT_DEPTH_FALLBACK)


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


def whisper_language_code(code):
    """语种**标签** → Whisper **语种码**（`pt-BR` → `pt`）；认不出就原样返回。

    <p>⚠️ 5.101 实测踩到：`--try-audio … --language pt-BR` 直接抛
    `ValueError: 'pt-BR' is not a valid language code (accepted language codes: af, …)`。
    更糟的是这条错误发生在**模型加载完之后**（那次加载花了 39.8 秒），
    现场看到的是"模型坏了"，而不是"语种码写法不对"。

    <p>`language_tag()` 是反方向（码 → 标签 `pt` → `pt-BR`）。两个方向都应该有名字：
    只有一边的时候，另一边就会被人"顺手"传错 —— 而这两个字符串长得都像语种。
    """
    if not isinstance(code, str):
        return code
    text = code.strip()
    if text == "":
        return None
    if text.lower() == "auto":
        # Whisper 里"自动判定"就是 None；传 "auto" 同样会报 invalid language code
        return None
    return text.split("-")[0].lower()


def transcribe(model, audio, language, min_logprob, no_speech_prob,
               beam_size=1, initial_prompt=None, do_normalize=True,
               speech_floor=SPEECH_RMS_FLOOR, candidates=None, context_text=None,
               hint_text=None, silence_floor=SILENCE_SKIP_RMS, highpass_hz=0.0,
               vad=False, vad_max_ms=2000, vad_threshold=0.5):
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
    # ⚠️ 5.101：先把语种标签换成 Whisper 码（`pt-BR` → `pt`）。faster-whisper 只认两字母码，
    #    传标签会抛 ValueError —— 而且在**模型已经加载完**之后才抛（几十秒白等）。
    language = whisper_language_code(language)
    # ⚠️ 静音闸必须在 normalize_peak **之前**判：归一化会把近乎静音的段放大到正常电平，
    #    之后再判就没有"安静"可言了（实战中正是它把噪声喂成了「中文字幕志愿者 李宗盛」）。
    skip = silence_skip_reason(audio, silence_floor)
    if skip is not None:
        return "", True, skip, False, "silence", language
    # 5.186：**高通在电平闸之后、归一化之前** —— 顺序有讲究：
    #   电平闸要看原始录音的真实电平（高通会削掉低频能量，先滤会让门槛判断失真）；
    #   归一化要放大"滤波后的语音"，所以高通必须在它前面。
    data = None
    if highpass_hz > 0:
        data = highpass_biquad(audio, 16000, highpass_hz)
    data = normalize_peak(data if data is not None else audio) if do_normalize else (
        data if data is not None else audio)

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
    # 5.186：**VAD 二次确认**（silero，faster-whisper 自带，不需要额外装包）。
    #
    # 为什么只对**短段**做：幻听几乎都发生在"短 + 弱"的段上（1.8 秒、电平刚好过闸那种），
    # 长段模型有足够上下文，极少凭空编话。而 silero 的耗时大致与音频长度成正比，
    # 只给 ≤2 秒的段做，实测在几十毫秒量级 —— 用户给的预算是 0.1 秒。
    use_vad = bool(vad) and int(len(data) * 1000 / 16000) <= int(vad_max_ms)
    vad_kwargs = {}
    if use_vad:
        try:
            from faster_whisper.vad import VadOptions
            vad_kwargs = {
                "vad_filter": True,
                "vad_parameters": VadOptions(
                    threshold=float(vad_threshold),
                    min_speech_duration_ms=200,     # 太短的"语音"多半是噪声瞬态
                    min_silence_duration_ms=100,
                    speech_pad_ms=60,
                ),
            }
        except Exception as error:                      # noqa: BLE001
            # 依赖不在（老版本 faster-whisper）：**说一次**然后照常跑，绝不因此丢字幕
            if _VAD_WARNED["done"] is not True:
                _VAD_WARNED["done"] = True
                print(f"[识别] ⚠️ 这台机器上的 faster-whisper 没有 VAD 支持（{type(error).__name__}: "
                      f"{error}）→ 这一段照常识别，VAD 二次确认**没生效**",
                      file=sys.stderr, flush=True)
            use_vad = False
            vad_kwargs = {}
    # 5.186：VAD 的耗时要能看见（用户给的预算是 0.1 秒/段）—— 只在真开了 VAD 时测
    vad_started = time.perf_counter() if use_vad else None
    segments, _info = model.transcribe(
        data,
        language=language,
        # beam search 比贪心准，代价是多花一点解码时间。GPU 上实测很便宜
        # （14.7 秒音频：small beam5 只要 0.35~0.56 秒），所以缺省用 5 而不是 1。
        beam_size=beam_size,
        # 能量闸已经切好了段；这里只让 VAD 做"这一段到底像不像人声"的二次确认
        **vad_kwargs,
        condition_on_previous_text=False,   # 句间独立，避免上一句的错误污染下一句
        initial_prompt=prompt,
    )
    if vad_started is not None and log_level_at_least("detail"):
        print(f"[识别] VAD 二次确认 {len(data) / 16000.0:.1f}s 段，耗时 "
              f"{(time.perf_counter() - vad_started) * 1000:.0f} ms（含在这段识别耗时里）",
              file=sys.stderr, flush=True)

    # 这一句实际用的语种：显式指定了就是它；没指定时是模型检测出来的那个。
    # 它要跟着句子一起发出去（--format json），否则插件只能自己再猜一遍。
    resolved_language = language if language is not None else getattr(_info, "language", None)

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
            (overrode and kept != []), kind, resolved_language)


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
        # ⚠️ 旁文件是**追加后缀**：`<pcm>.rate` / `<pcm>.lang`（relay 就是那么写的）。
        #
        # 这里原来是 `with_suffix('.rate')` —— 那会**替换**扩展名：`test2.pcm` → `test2.rate`，
        # 而 relay 写的是 `test2.pcm.rate`。两边看着都"符合文档"，实际永远读不到：
        #   · 语种读不到 → 段里 `lang: null` → 识别端退回候选集，日志上只看到
        #     「语种限定生效：全局最大是 en，限定到 ('zh','pt') 后取 zh」这种下游现象；
        #   · 采样率读不到 → 手机降级到 44.1kHz 时会被当成 16kHz 解码（声音变调、识别全乱）。
        # 2026-10-31 用户实测的「没有语种可带」就是这个：relay 日志写着写了
        # `.../test2.pcm.lang`，切句端却在读 `.../test2.lang`。
        self.rate_path = Path(follow_rate_path) if follow_rate_path else Path(str(self.path) + '.rate')
        self.lang_path = Path(str(self.path) + '.lang')
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

def language_tag(code):
    """Whisper 语种码 → 收件箱/手机用的语种标签（`zh` → `zh-CN`）。

    <p>为什么必须单独一个函数：这是**两种码的边界**，而两边都"看起来对"——
    `zh` 和 `zh-CN` 都长得像语种，写错了不会报错，只会让插件判不出翻译方向。
    4.94 就是这么错的：队列消费者把 `resolved_language`（Whisper 码 `zh`）原样写进
    `from`，插件于是报「目标语种无法推导，请显式传 to」——识别是好的、翻译全废，
    而日志里只有一句与语种无关的报错。
    认不出来返回 None（让下游自己判，**不猜**）。已经是标签的（`zh-CN`）原样返回 ——
    幂等，免得"归一化两次"这种低级错误。
    """
    if not isinstance(code, str):
        return None
    text = code.strip()
    if text == "":
        return None
    if text in LANG_TAGS.values():
        return text
    return LANG_TAGS.get(text.split("-")[0].lower())


def emit(text: str, language=None):
    """一行一句话，立刻 flush：延迟就是同传的命。

    --format json 时把**这一句实际用到的语种**一起写出去（`{"text":…,"from":"zh-CN"}`）。
    为什么这件事重要：语种不再由命令行固定，而是跟着每句话走 —— 手机切语种、双方交替发言，
    每一句都能按自己的语种翻译，不会出现"整路被定错语种、安静地输出另一种语言的译文"。
    """
    clean = " ".join(text.split())
    if not clean:
        return
    if EMIT_FORMAT == "json":
        payload = {"text": clean}
        tag = language_tag(language)
        if tag is not None:
            payload["from"] = tag
        print(json.dumps(payload, ensure_ascii=False), flush=True)
    else:
        print(clean, flush=True)


def _runtime_hint_for_text(text):
    """把"运行库/驱动/显存"类报错翻译成**能照做**的中文。认不出就返回空串，不瞎猜。"""
    low = str(text or "").lower()
    if "libcublas" in low or "libcudnn" in low or "cannot be loaded" in low or \
            "cannot open shared object" in low or "cudnn" in low:
        return (
            "这是 CUDA 运行库没找到（cuBLAS/cuDNN 12），不是代码问题，也不是模型没搬过来。\n"
            "  ① 库在不在：ls $VENV/lib/python*/site-packages/nvidia/cublas/lib/libcublas.so.12\n"
            "  ② 重新生成环境文件（把 LD_LIBRARY_PATH 指到那些目录）：\n"
            "     sudo python3 scripts/make-env-file.py $VENV --hf-home /opt/leion/models --out /etc/leion/asr.env\n"
            "  ③ systemd 单元里必须有 EnvironmentFile=/etc/leion/asr.env —— 少了它，"
            "手跑能过、服务里每一段都失败（PATH 里有 venv，LD_LIBRARY_PATH 却没有）\n"
            "  ④ 库确实没装：pip install nvidia-cublas-cu12 nvidia-cudnn-cu12\n"
            "  ⑤ 只想先出字：把这张策略的 device 改成 cpu（慢，但不报错）\n"
            "  一条命令查全：python3 scripts/check-asr-env.py")
    if "out of memory" in low:
        return (
            "显存不够：别的进程占着卡，或同时加载的模型太多。\n"
            "  看谁占着：nvidia-smi；  少加载点：--max-models 2（或把这张策略的 device 改成 cpu）")
    if "no cuda-capable device" in low or "cuda driver" in low or "cudaerrornodevice" in low:
        return (
            "驱动/设备层面不通：GPU 不在、驱动太旧、或容器里没映射 /dev/nvidia*。\n"
            "  看驱动：nvidia-smi；  ctranslate2 要 CUDA 12 的驱动（P40 需要 ≥ 525 版本）")
    if "no kernel image" in low or "not compiled with cuda" in low:
        return (
            "这份 ctranslate2 没带对应计算能力的内核（P40 是 sm_61）。\n"
            "  换回官方 wheel（pip install --force-reinstall ctranslate2），或改 device=cpu")
    return ""


# 同一种故障只解释一次：一段一失败、每段都贴五行说明，日志会被刷成噪声。
_SHOWN_RUNTIME_HINTS = set()


def describe_runtime_failure(error, dedupe=True):
    """GPU/运行库类异常的**中文说明**（认不出返回空串）。

    <p>`dedupe=True`（现场用的）：同一类故障只贴一次完整说明，之后每次只回一句
    「已解释过」，免得一段一行把日志刷成噪声。`dedupe=False`：永远返回完整说明，
    也不记账（测试和一次性排查用）。</p>

    <p>为什么需要：现场日志里只有 `RuntimeError: Library libcublas.so.12 is not found
    or cannot be loaded` 这种一行英文，用户会去反复重装 ctranslate2 —— 修错地方。
    </p>
    """
    text = f"{type(error).__name__}: {error}"
    hint = _runtime_hint_for_text(text)
    if not hint:
        return ""
    key = hint.splitlines()[0]
    if dedupe:
        if key in _SHOWN_RUNTIME_HINTS:
            return "（同类故障已解释过，见上面的完整说明；这次仍然失败）"
        _SHOWN_RUNTIME_HINTS.add(key)
    return hint


def resolve_compute_type(requested, device):
    """返回 (实际使用的精度, 说明)。GPU 上把不支持的精度换成这台卡能跑的。

    为什么需要（真实环境逼出来的）：ctranslate2 能跑哪些精度是**按卡查表**的，
    而 **Pascal 架构（Tesla P40/P100，算力 6.1）没有 FP16 加速**，ctranslate2
    直接不提供 float16 —— 偏偏我们的缺省精度就是 float16。于是"照着文档抄"
    在一台 24 GB 的 P40 上会起不来，报的是 ctranslate2 的一行英文。
    这类机器的正确档位是 int8_float32（权重 INT8、激活 FP32），实测也快。

    只在 device=cuda 时过一遍；查不到（没有 ctranslate2 / 机器没卡）就原样返回，
    让 WhisperModel 自己去报价，不在这里假装知道。
    """
    if device != "cuda":
        return requested, ""
    try:
        import ctranslate2

        supported = sorted(ctranslate2.get_supported_compute_types("cuda"))
    except Exception as error:                          # noqa: BLE001
        return requested, f"（查不到本机支持的精度：{type(error).__name__}: {error}；按 {requested} 直接试）"
    if not supported or requested in supported:
        return requested, ""
    # 这些卡上 int8_float32 最快；int8 是它的老名字；float32 保底
    for candidate in ("int8_float32", "int8", "float32"):
        if candidate in supported:
            return candidate, (
                f"⚠️ 这台 GPU 不支持 {requested}（能跑的是 {'/'.join(supported)}），"
                f"已自动改用 {candidate}")
    return requested, f"⚠️ 本机支持的精度里没有可替换项：{'/'.join(supported)}"


def _hub_cache_roots():
    """faster-whisper(HuggingFace Hub) 可能把模型放在哪几处。"""
    roots = []
    for key in ("HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE"):
        value = os.environ.get(key)
        if value:
            roots.append(value)
    hf_home = os.environ.get("HF_HOME")
    if hf_home:
        roots.append(os.path.join(hf_home, "hub"))
    roots.append(os.path.expanduser("~/.cache/huggingface/hub"))
    return roots


def model_is_local(model):
    """
    模型到底能不能**离线**加载。

    · 传的是目录 -> 直接用它（`--model /opt/leion/models/faster-whisper-large-v3`）；
    · 传的是仓库名（`large-v3` / `Systran/faster-whisper-large-v3`）-> 看本地缓存里有没有
      对应 `models--<org>--<name>` 目录，且里面有 snapshot。

    ⚠️ 为什么不"让它自己试试"：试的结果是在中国机房里连 huggingface.co，
    表现是卡几分钟然后一屏 traceback（httpcore.RemoteProtocolError）。
    宁可在这里早退，并且把"该 rsync 哪个目录"写清楚。
    """
    if os.path.isdir(model):
        return True
    repo = model if "/" in model else f"Systran/faster-whisper-{model}"
    folder = "models--" + repo.replace("/", "--")
    for root in _hub_cache_roots():
        candidate = os.path.join(root, folder)
        if os.path.isdir(os.path.join(candidate, "snapshots")):
            return True
    return False


def missing_model_advice(model):
    roots = "\n".join(f"    - {root}" for root in _hub_cache_roots())
    return (
        f"[whisper_stream] ✗ 本地没有模型 {model}，而连 HuggingFace 下载在这台机器上通常不通。\n"
        f"  找过这些缓存目录：\n{roots}\n"
        "  三种解法（任选其一）：\n"
        "    1) 从旧机器把模型目录整个搬过来（**推荐**，搬迁服务器时最容易漏这一步）：\n"
        "         rsync -av 旧机器:/opt/leion/models/ /opt/leion/models/\n"
        "       并确保启动时 export HF_HOME=/opt/leion/models\n"
        "    2) 用镜像站下载：export HF_ENDPOINT=https://hf-mirror.com\n"
        "    3) 直接指向本地目录：--model /opt/leion/models/faster-whisper-large-v3\n"
        "  自检：python bridge/whisper_stream.py --self-check"
    )


def is_compute_type_error(error):
    """这次加载失败是不是"精度不支持"（而不是"模型不存在"）。

    <p>为什么必须分开：两类错误的**解法完全相反** —— 精度不支持要改 `--compute`（或表里的
    `compute_type`），模型不存在要搬模型。混在一起报，用户会去搬一个本来就有的模型。
    """
    text = f"{type(error).__name__}: {error}".lower()
    if "compute type" in text or "compute_type" in text or "float16" in text:
        return True
    return "not support" in text and ("half" in text or "precision" in text)


def model_load_failure(model, error, compute_type=None):
    raw = f"{type(error).__name__}: {error}"
    if is_compute_type_error(error):
        return (
            f"[whisper_stream] ✗ 加载模型 {model} 失败：这台设备跑不了 {compute_type or '这个'} 精度\n"
            f"  {raw}\n"
            "  这不是「模型没搬过来」：Pascal 架构（P40/P100，算力 6.1）没有 FP16 加速，\n"
            "  ctranslate2 直接不提供 float16。改精度就能起来：\n"
            "    ① 命令行：--compute int8_float32\n"
            "    ② 如果精度来自**策略表**（asr-models.json 的 compute_type），把它删掉或改成 int8_float32\n"
            "  查这台卡能跑哪些精度：python -c \"import ctranslate2;print(ctranslate2.get_supported_compute_types('cuda'))\""
        )
    return (
        f"[whisper_stream] ✗ 加载模型 {model} 失败：{raw}\n"
        + missing_model_advice(model)
        + "\n  想看到完整 traceback：LEION_DEBUG=1 再跑一次"
    )


def main():
    global EMIT_FORMAT
    args = parse_args()
    EMIT_FORMAT = args.format
    # 只有"真要从麦克风收"才需要 sounddevice。
    # 注意 follow 模式也算"不是麦克风" —— 早先这里只判了 --file，于是
    # `--follow` 会因为没有 sounddevice 直接退出（而退出前那句错误信息又被管道
    # 下游的桥当成"识别结果"写进了收件箱，见文件末尾的警告）。
    # 只要有"从文件读"的来源就不要麦克风依赖（--follow / --follow-dir 都算）
    # ⚠️ 5.99：试识别（--try-*）也**不吃麦克风** —— 漏了这两个条件，测试机上没有
    #    sounddevice 时会以"缺少 sounddevice"退出，而它跟这次要测的事毫无关系。
    need_audio = (args.file is None and args.follow is None and args.follow_dir is None
                  and args.try_audio is None and args.try_queue is None)
    np, WhisperModel, sounddevice = load_dependencies(need_audio)

    # ── 生产者模式（--segment-dir）：只切句，不加载模型 ────────────────────────
    #
    # 为什么要这个模式（2026-10-30，按显存现状定的架构）：
    # 一场会一套"分段+识别"= 一份 whisper 模型（large-v3 float16 约 5GB），
    # 而两场会同时开是真实需求。把**切句**（纯 CPU 的能量判定）与**识别**（吃显存）
    # 拆开之后，切句可以每场一个进程（几乎不占资源），识别只留**一个**进程：
    # 它从队列里按到达顺序取"一段话"，转写完把文字送回那一段所属的房间。
    # 这样两场会都能持续出字幕（各自慢一点），而且模型只加载一次。
    if args.segment_dir is not None:
        return run_segment_producer(args, np)

    compute_type, compute_note = resolve_compute_type(args.compute_type, args.device)
    if compute_note:
        print(f"[whisper_stream] {compute_note}", file=sys.stderr)

    # 5.40：先读模型表，再决定启动时加载**哪一份**。
    # 为什么要这么排：如果先按命令行模型加载、再按表说"其实该用另一个"，
    # 那第一份就白占一整份显存（large-v3 就是几个 GB）—— 显存事故几乎都从这种"顺手多一份"来。
    args.asr_table, map_problem = load_asr_models(args.model_map)
    if map_problem:
        print(f"[whisper_stream] ⚠️ 模型表有问题，先按命令行模型跑：{map_problem}", file=sys.stderr)
    startup = resolve_strategy(args.language, {
        "model": args.model, "compute_type": compute_type, "beam_size": args.beam_size,
        "engine": args.engine,
    }, args.asr_table)
    startup_model = startup.get("model") or args.model
    # ⚠️ 5.42：**表里的 precision 也要过硬件检查**。真实事故：表里抄了
    # `"compute_type": "float16"`，而这台卡（Pascal，算力 6.1）根本不支持 FP16 ——
    # 命令行明明给了 int8_float32，被表覆盖成 float16 之后启动即失败，
    # 而报错还说"本地没有模型"（把精度问题说成模型问题，方向全错）。
    # 现在的做法是：按命令行同样的规则把 precision 换成这台卡能跑的，并且**大声说明换过**。
    startup_compute_raw = startup.get("compute_type") or compute_type
    startup_compute, compute_note = resolve_compute_type(startup_compute_raw, args.device)
    if compute_note:
        # 5.110：`resolve_strategy` 记的键叫 `sources`（复数）；原来这里读 `source`，
        # 于是这一行永远印"来自 配置"。顺手把这个死兜底删掉。
        source = (startup.get("sources") or {}).get("compute_type") or "配置"
        print(f"[whisper_stream] {compute_note}"
              f"（这个精度来自 {source}；策略表里的 compute_type 会覆盖命令行 --compute）",
              file=sys.stderr)
    elif str(startup_compute_raw) != str(compute_type):
        # 5.110：表里的精度和命令行给的**不一样**（但两个都跑得了）→ 也要说清谁赢，
        # 否则"我明明给了 --compute"这件事在现场无法核对。
        print(f"[whisper_stream] ⚠️ 命令行 --compute {compute_type}，表里是 {startup_compute_raw}"
              f" → **按表走**（要让命令行生效就把表里那个字段删掉）", file=sys.stderr)
    # 队列消费者要用同一组值当"命令行档案"，否则表里的 default 会被命令行旧值盖住
    args.startup_model = startup_model
    args.resolved_compute = startup_compute
    if args.model_map and args.asr_table:
        # ⚠️ 5.110：这里原来写的是 `startup.get('source')` —— 而 resolve_strategy 记录的键叫
        #    `sources`（复数），于是这一行**永远印 "来源：None"**。正是那种"看着像信息、
        #    其实什么都没有"的日志（§5.105 那条纪律）。
        startup_source = (startup.get("sources") or {}).get("model") or "命令行"
        print(f"[whisper_stream] 模型表：{describe_asr_table(args.asr_table, _cli_profile(args))}"
              f"（启动先加载 {startup_model}，来自 {startup_source}）", file=sys.stderr)
        # ⚠️ 5.110：命令行与表**都给了**、而值不一样时，必须当场说清谁赢 ——
        #    否则"我明明给了 --whisper-model"和"表里改的才是生效的"会各说一套，
        #    正是这两周反复踩的那类"两个地方都能设"的坑。表优先是刻意设计（改表不用重启）。
        if args.model and startup_model and str(args.model) != str(startup_model):
            print(f"[whisper_stream] ⚠️ 命令行写的是 {args.model}，但表里那一层是 {startup_model}"
                  f"（来自 {startup_source}）→ **按表走**；要让命令行生效就把表里那个字段删掉",
                  file=sys.stderr)

    # 5.86：先建引擎注册表并解析出**这一路是哪个引擎**，再决定要不要做"本地模型"检查。
    # 原来这个检查排在解析引擎之前，于是云端引擎（tencent / funasr）的"模型"（其实是
    # 引擎编码 / 模型 ID）被当成文件路径去查缓存，直接以"本地没有模型"退出 ——
    # 而现场看是一堆 rsync / HF 镜像的建议，方向和真实原因完全无关。
    engines = build_engines(WhisperModel, args)
    try:
        startup_engine = resolve_engine(startup, engines)
    except ValueError as error:
        print(f"[whisper_stream] ✗ {error}", file=sys.stderr)
        return 2

    # 5.131：**云端引擎的密钥在启动时先探一次**。
    #
    # 为什么：真机现场（`en-US → en-tencent` 切完之后）的表现是——
    #   每段都打一行「这一段要求的引擎/模型 tencent:16k_en 加载失败（…缺密钥…）」，
    #   而要在几十行滚动日志里翻到那句才能知道"是密钥没进服务环境"。
    # 密钥这类**静态配置**不该等到第一段音频才暴露：它跟音频内容无关，启动时就该说清。
    # 探的方式与真正加载同一个函数（engine.load），而且云端引擎的 load 只读环境变量/文件、
    # **不联网**，所以这一步没有副作用；本地 whisper/parakeet 不探（会真加载模型）。
    for line in probe_cloud_engines(args.asr_table, engines):
        print(line, file=sys.stderr)

    # 5.99：单独试识别 —— 一段（或一批）音频直接进引擎，不经切句/队列/大脑。
    # 放在这里：表已经读完，引擎注册表也有，但**还没加载启动模型** ——
    # 试测要按每一段自己的策略取模型，不该先白占一份显存。
    if args.try_audio is not None or args.try_queue is not None:
        if args.try_audio is not None and args.try_queue is not None:
            print("[whisper_stream] ✗ --try-audio 与 --try-queue 只能给一个", file=sys.stderr)
            return 2
        return run_try(args, np, engines)

    print(f"[whisper_stream] 加载 {startup_engine.describe(startup)}"
          f"（engine={startup_engine.key}, device={args.device}, compute_type={startup_compute}）…",
          file=sys.stderr)
    if startup_engine.needs_local_model(startup):
        # 把"模型从哪儿来"打出来。这一行是被一次真实事故逼出来的：
        # 用户自己跑的时候没设 HF_HOME，于是模型从零开始下载到默认缓存 ——
        # 直连 HuggingFace 三分钟只下了 2.5MB，识别进程 4 分钟都没开始听，
        # 而终端上只看到"加载模型…"一句，完全看不出它在下载。
        hf_home = (os.environ.get("HF_HOME") or os.environ.get("HF_HUB_CACHE")
                   or "(默认 ~/.cache/huggingface)")
        hf_endpoint = os.environ.get("HF_ENDPOINT") or "huggingface.co"
        print(f"[whisper_stream] 模型缓存 {hf_home}；下载源 {hf_endpoint}", file=sys.stderr)
        print("[whisper_stream] 若这里显示的是默认缓存，而模型仓库里已经有了，"
              "说明 HF_HOME 没设 —— 它会重新下一个几百 MB 的模型，慢得像是卡住了",
              file=sys.stderr)
        if not model_is_local(startup_model):
            missing = missing_model_advice(startup_model)
            print(missing, file=sys.stderr)
            return 2
    else:
        print(f"[whisper_stream] 这一路是云端引擎 {startup_engine.key}，不需要本地模型文件",
              file=sys.stderr)
    try:
        # ⚠️ 5.81：这个变量**不能**叫 `handle`
        # —— 后面 `def handle(utterance)` 会在同一作用域重新绑定它，
        # 于是引擎句柄变成函数对象（实测：预热能过、第一段就崩
        # `AttributeError: 'function' object has no attribute 'get'`）。
        startup_handle = startup_engine.load(startup, args.device)
    except Exception as error:  # noqa: BLE001
        # 真事故（搬迁服务器后）：模型不在本地缓存，于是 faster-whisper 去 HuggingFace 拉，
        # 而新机器出网被掐 -> httpcore.RemoteProtocolError: Server disconnected without sending
        # a response，一屏 traceback，看不出"其实是模型没搬过来"。
        print(model_load_failure(startup_model, error, startup_compute), file=sys.stderr)
        if os.environ.get("LEION_DEBUG") == "1":
            raise
        return 2
    # whisper 的句柄是 (model, 实际精度)；其它引擎的句柄是别的形状（dict 等），原样留着。
    model = startup_handle[0] if isinstance(startup_handle, tuple) else startup_handle
    startup_compute = (startup_handle[1]
                       if isinstance(startup_handle, tuple) and len(startup_handle) == 2
                       else startup_compute)
    args.resolved_compute = startup_compute
    print("[whisper_stream] 模型就绪", file=sys.stderr)

    if args.self_check:
        print("[whisper_stream] --self-check 通过：依赖与模型都能加载", file=sys.stderr)
        return 0

    # ── 消费者模式（--queue-dir）：按段自带的语种选模型（5.40）────────────────
    # 放在预热**之后**：队列里可能已经堆着几段，第一段不该再付那十几秒的固定开销。
    if args.queue_dir is not None:
        pool = ModelPool(
            engines,
            max_models=args.max_models,
            log=lambda line: print(line, file=sys.stderr, flush=True),
            device=args.device,
        )
        # 把已经加载好的那份塞进池子：命令行模型的加载与失败提示仍走原来那条路
        seeded = {"engine": startup_engine.key, "model": startup_model,
                  "compute_type": startup_compute, "beam_size": args.beam_size,
                  "source": startup.get("source")}
        pool.models[ModelPool.key_of(seeded)] = startup_handle
        pool.order.append(ModelPool.key_of(seeded))
        return run_queue_consumer(args, np, pool)

    segmenter = UtteranceSegmenter(
        args.samplerate, args.block_ms, args.silence_ms,
        args.min_speech_ms, args.max_speech_ms, args.rms_threshold, args.preroll_ms, np,
        adaptive=args.adaptive, rms_floor=args.rms_floor, noise_multiplier=args.noise_multiplier,
        short_utterance_ms=args.short_utterance_ms, short_silence_ms=args.short_silence_ms,
        cut_pause_ms=args.cut_pause_ms,
    )
    stats = Stats()

    def engine_transcribe(sample, language, hint=None, carried=None):
        """这一份样本交给**启动时加载的那个引擎**（5.79）。

        <p>为什么要有这层：单文件/麦克风流式这条路原来直接调模块级 `transcribe(model, …)`，
        那是 whisper 专用函数 —— 于是 `--engine parakeet` 加载得到、却根本用不上
        （运行时报一堆参数不匹配，或者干脆把 dict 句柄当模型用）。
        现在把"喂谁"统一到这里：whisper 走原来那条（保留 `--min-logprob` / 续传提示等旋钮），
        其它引擎走它们的 `transcribe(handle, …)`，返回值补成同一个六元组。
        """
        if startup_engine.key == "whisper":
            return transcribe(
                model, sample, language,
                args.min_logprob, args.no_speech_prob,
                beam_size=args.beam_size,
                silence_floor=args.silence_skip_level,
                hint_text=hint, context_text=carried or None,
                do_normalize=not args.no_normalize,
                candidates=args.lang_candidates,
            )
        outcome = startup_engine.transcribe(startup_handle, sample, language, startup)
        return (outcome.get("text", ""), bool(outcome.get("empty", False)),
                outcome.get("reason"), False, "", outcome.get("resolved_language"))

    # ── 预热 ────────────────────────────────────────────────────────────────
    # 实测：CUDA 上第一次推理要 11.3 秒（cuDNN 选算法、分配显存），之后的句子只要 0.1 秒。
    # 不预热的话，用户说出的第一句话会被卡十几秒 —— 这是同传最不能接受的失败方式。
    # 办法是启动时先拿 1 秒静音跑一遍，把这块固定开销提前付掉。
    if not args.no_warmup:
        warm_start = time.perf_counter()
        silent = np.zeros(args.samplerate, dtype=np.float32)
        try:
            engine_transcribe(silent, args.language)
        except NameError:
            # ⚠️ NameError 是**代码 bug**，不是"预热偶尔不稳" —— 吃掉它会让下一步看起来正常
            raise
        except Exception as error:      # 预热失败不该让整个程序起不来
            # ⚠️ 5.119：但**不能再写成"（忽略）"** —— 预热就是那个"GPU 到底能用吗"的探针。
            # 运行库/驱动缺失时它必然失败，而失败被吞掉之后，程序看着一切正常、
            # 每一段却在 0.03 秒内失败（实机日志：`Library libcublas.so.12 is not found`）。
            # 这里不退出（同一个识别进程还要服务 pt/en 两条云端/CPU 策略，
            # 杀掉它等于把好的语种也一起弄没），但要把后果说清楚。
            hint = describe_runtime_failure(error)
            print(f"[whisper_stream] 预热失败：{type(error).__name__}: {error}", file=sys.stderr)
            if hint:
                print(f"[whisper_stream] {hint}", file=sys.stderr)
                print(f"[whisper_stream] ⚠️ 后果：走到这个引擎上的语种（缺省 {args.language}）"
                      "会**每一段都失败、一直没字幕**；走云端/CPU 的语种不受影响。",
                      file=sys.stderr)
        print(f"[whisper_stream] 预热完成：{time.perf_counter() - warm_start:.2f}s"
              f"（这段固定开销如果不提前付，会砸在第一句字幕上）", file=sys.stderr)

    # 当前语种放在可变容器里：手机中途切「听葡语/听中文」时要能改，
    # 而且下一句就生效（Whisper 的 language 是逐次调用给的，所以切换很便宜）。
    active = {"language": args.language}

    # 上下文续传（前 N 段的定稿文本当提示词）—— 见 ContextCarry 上面那段说明。
    # ⚠️ 缺省**按语种**取，而且手机中途可能切语种，所以深度在每次 handle 里现算：
    #    --context-depth 显式给了就用它（对所有语种生效）；没给就 zh=2 / pt=0 / 其他=0。
    carry = ContextCarry(args.context_depth if args.context_depth is not None else 0,
                         args.context_gap_s)
    stats.carry = carry

    def handle(utterance):
        seconds = len(utterance) / float(args.samplerate)
        start = time.perf_counter()
        now = time.monotonic()
        language = active["language"]
        # ⚠️ 续传深度**按当前语种现算**（手机中途可能切语种）：显式给了 --context-depth 就用它，
        #    否则中文 2、葡语 0（两个语种的实测答案相反，见 CONTEXT_DEPTH_BY_LANGUAGE）。
        carry.depth = (args.context_depth if args.context_depth is not None
                       else context_depth_for(language))
        # 提示词 = 语种提示词 + 续传文本（顺序与实验一致：**指令在前、上文在后**）；
        # ⚠️ 但两段**分开传给 transcribe**：它们的闸判据强度不一样（见 transcribe 的说明）。
        hint = None if args.no_prompt else prompt_for(language, args.initial_prompt)
        carried = carry.prompt(language, now)
        text, empty, reason, overrode, kind, resolved_language = engine_transcribe(
            # 5.79：交给**启动时加载的那个引擎**（whisper / parakeet / tencent 都行）
            utterance, language, hint=hint, carried=carried,
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
        emit(text, resolved_language)

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
