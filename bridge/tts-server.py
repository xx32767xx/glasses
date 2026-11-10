#!/usr/bin/env python3
"""
tts-server.py —— 服务器自建语音合成（piper，不接云端 API）
============================================================================

    # 起服务（生产上由 start-all / start-multi 带起来）
    python bridge/tts-server.py --port 8790 --voice-dir /opt/leion/models/piper

    # 只自检：查引擎与音色文件，不做合成、不起服务
    python bridge/tts-server.py --selftest
    python bridge/tts-server.py --check

    # 自己听一下（起服务后另开一个窗口）
    curl -s -X POST http://127.0.0.1:8790/tts \\
         -H 'Content-Type: application/json' \\
         -d '{"text":"Bom dia a todos.","lang":"pt-BR"}' -o /tmp/pt.wav

为什么是"本机 HTTP 小服务"而不是复用识别那条队列：
  识别是**单向**的（音频进、文字出，进了收件箱就不管了）；语音合成要**把字节还给调用方**，
  队列得再加一条回程通道才能做同一件事。而 relay 已经在跑 HTTP，直接 POST 一下最省事。

为什么用标准库 http.server 而不是 flask/fastapi：
  这个进程只做一件事 —— "文本进、wav 出"，没有路由树、没有中间件、没有并发形态。
  引入 web 框架等于给一台本来就只需要 piper 的机器又添一套依赖（而它还可能是 GPU 机器，
  装错一个包就会把 torch 升上去，见 docs/26 的坑）。

⚠️ 它是**内网服务**：只监听 127.0.0.1，由 relay 的 `POST /tts` 代理出去。
   不要把 8790 暴露到公网 —— 鉴权、限流、版本门禁都在 relay 那一层。
"""

import argparse
import io
import json
import os
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_VOICE_DIR = os.environ.get("LEION_TTS_MODELS") or "/opt/leion/models/piper"

# 语言 → 音色（piper 的音色名就是文件名前缀：<name>.onnx + <name>.onnx.json）
DEFAULT_VOICES = {
    "zh-CN": "zh_CN-huayan-medium",
    "pt-BR": "pt_BR-faber-medium",
    "en-US": "en_US-lessac-medium",
}

MAX_TEXT_CHARS = 600          # 一句译文不可能更长；超了就是别人的调用搞错了
SETTLE_MS = 0                 # 占位：以后要加"预热"再填

# Windows 控制台是 GBK：不显式改成 UTF-8 的话，中文日志会让进程自己在 print 上崩
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:                                     # noqa: BLE001
        pass
del _stream


def log(message):
    print(f"[tts] {message}", flush=True)


def voice_path(voice_dir, name):
    """音色名 → (onnx, json)。piper 要两个同名文件，少一个的报错很难懂。"""
    base = Path(str(voice_dir)) / str(name)
    return Path(str(base) + ".onnx"), Path(str(base) + ".onnx.json")


def normalize_lang(raw):
    """把各种写法收敛成三门之一；认不出来返回空串（**不猜**）。"""
    text = str(raw or "").strip().lower().replace("_", "-")
    if text == "":
        return ""
    if text.startswith("zh"):
        return "zh-CN"
    if text.startswith("pt"):
        return "pt-BR"
    if text.startswith("en"):
        return "en-US"
    return ""


def wav_duration_ms(payload):
    """从 wav 字节里读时长（毫秒）；读不出来返回 0（不猜）。"""
    try:
        with wave.open(io.BytesIO(payload), "rb") as handle:
            rate = handle.getframerate() or 0
            frames = handle.getnframes()
            if rate <= 0:
                return 0
            return int(frames * 1000 / rate)
    except Exception:                                     # noqa: BLE001
        return 0


class Synth:
    """
    持有一份 piper 模型（每个音色一个），串行合成。

    <p>为什么串行：piper 的 `PiperVoice` 不是线程安全的（内部复用一个进程状态），
    并发调它会得到**交错的两句话**。一场会议同时念两句的情况本来就不该发生
    （队列在手机端已经保证一次一句），所以用锁比用线程池诚实。
    """

    def __init__(self, voice_dir, voices):
        self.voice_dir = voice_dir
        self.voices = dict(voices)
        self.loaded = {}
        self.lock = threading.Lock()
        self.stats = {"requests": 0, "failures": 0, "audioMs": 0, "synthMs": 0}

    def available(self):
        """哪些语言现在**真能合成**（两个文件都在）。"""
        out = {}
        for lang, name in self.voices.items():
            onnx, config = voice_path(self.voice_dir, name)
            out[lang] = {"voice": name, "ready": onnx.exists() and config.exists()}
        return out

    def _load(self, lang):
        if lang in self.loaded:
            return self.loaded[lang]
        name = self.voices.get(lang)
        if not name:
            raise KeyError(f"没有为 {lang} 配置音色")
        onnx, config = voice_path(self.voice_dir, name)
        if not onnx.exists() or not config.exists():
            raise FileNotFoundError(f"音色文件不在：{onnx}")
        from piper import PiperVoice                          # 延迟到真要用时才 import
        started = time.time()
        voice = PiperVoice.load(str(onnx))
        log(f"加载 {name}（{(time.time() - started) * 1000:.0f} ms）")
        self.loaded[lang] = voice
        return voice

    def synthesize(self, text, lang):
        """文本 → wav 字节。返回 (payload, 毫秒信息)。"""
        started = time.time()
        with self.lock:
            voice = self._load(lang)
            sink = io.BytesIO()
            with wave.open(sink, "wb") as out:
                # piper 两代 API：1.2 是 synthesize(text, wave_writer)，新的是 synthesize_wav
                if hasattr(voice, "synthesize_wav"):
                    voice.synthesize_wav(text, out)
                elif hasattr(voice, "synthesize"):
                    voice.synthesize(text, out)
                else:
                    raise RuntimeError("这个 piper 版本既没有 synthesize_wav 也没有 synthesize")
            payload = sink.getvalue()
        synth_ms = int((time.time() - started) * 1000)
        audio_ms = wav_duration_ms(payload)
        self.stats["requests"] += 1
        self.stats["synthMs"] += synth_ms
        self.stats["audioMs"] += audio_ms
        return payload, {"synthMs": synth_ms, "audioMs": audio_ms,
                         "rtf": round(synth_ms / audio_ms, 3) if audio_ms > 0 else 0.0}


def make_handler(synth):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):                # 安静点：不要每个请求两行
            return

        def _json(self, status, body):
            payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self):                                 # noqa: N802
            if self.path.split("?")[0] == "/healthz":
                self._json(200, {"ok": True, "voices": synth.available(),
                                 "loaded": sorted(synth.loaded.keys()), "stats": synth.stats})
                return
            self._json(404, {"ok": False, "error": "只支持 GET /healthz 与 POST /tts"})

        def do_POST(self):                                # noqa: N802
            if self.path.split("?")[0] != "/tts":
                self._json(404, {"ok": False, "error": "只支持 GET /healthz 与 POST /tts"})
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            if length <= 0 or length > 64 * 1024:
                self._json(400, {"ok": False, "error": "请求体为空或过大（上限 64 KB）"})
                return
            try:
                body = json.loads(self.rfile.read(length).decode("utf-8"))
            except Exception as error:                    # noqa: BLE001
                self._json(400, {"ok": False, "error": f"请求体不是合法 JSON：{type(error).__name__}"})
                return
            text = str(body.get("text") or "").strip()
            if text == "":
                self._json(400, {"ok": False, "error": "text 不能为空"})
                return
            if len(text) > MAX_TEXT_CHARS:
                self._json(400, {"ok": False, "error": f"text 太长（{len(text)} 字，上限 {MAX_TEXT_CHARS}）"})
                return
            lang = normalize_lang(body.get("lang"))
            if lang == "":
                self._json(400, {"ok": False, "error": f"lang 认不出来：{body.get('lang')!r}（只支持 zh-CN / pt-BR / en-US）"})
                return
            if lang not in synth.voices:
                self._json(400, {"ok": False, "error": f"没有为 {lang} 配置音色"})
                return
            try:
                payload, timing = synth.synthesize(text, lang)
            except FileNotFoundError as error:
                synth.stats["failures"] += 1
                self._json(503, {"ok": False, "error": str(error)})
                return
            except Exception as error:                    # noqa: BLE001
                synth.stats["failures"] += 1
                log(f"合成失败（{lang}）：{type(error).__name__}: {error}")
                self._json(500, {"ok": False, "error": f"合成失败：{type(error).__name__}: {error}"})
                return
            # 音频本身用 **wav** 原样回去：手机端 MediaPlayer 直接吃得下。
            # 为什么不在服务端转码/降采样：多一步就多一个依赖与一处失真，
            # 而 22 kHz/16-bit 的单声道 wav 一条 4 秒的句子只有 ~180 KB，够用。
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("X-Leion-Tts-Synth-Ms", str(timing["synthMs"]))
            self.send_header("X-Leion-Tts-Audio-Ms", str(timing["audioMs"]))
            self.send_header("X-Leion-Tts-Voice", synth.voices.get(lang, ""))
            self.end_headers()
            self.wfile.write(payload)

    return Handler


def check(args):
    """只查不跑：引擎、音色文件、能合成哪些语言。"""
    print("服务器自建语音合成 · 环境自检")
    print(f"音色目录     {args.voice_dir}")
    try:
        import piper
        print(f"piper        {getattr(piper, '__version__', '已装')}")
    except Exception as error:                            # noqa: BLE001
        print(f"piper        没装（{type(error).__name__}: {error}）")
        print("             装法：pip install piper-tts && sudo apt install -y espeak-ng")
        return 2
    missing = []
    for lang, name in args.voices.items():
        onnx, config = voice_path(args.voice_dir, name)
        ready = onnx.exists() and config.exists()
        print(f"  {'✅' if ready else '·'} {lang:<6} {name:<22} {onnx}")
        if not ready:
            missing.append(f"{lang}（缺 {'onnx' if not onnx.exists() else '.onnx.json'}）")
    if missing:
        print(f"\n✗ 这些语言还发不出音：{'、'.join(missing)}")
        print("  下载：python -m piper.download_voices <音色名> --data-dir " + str(args.voice_dir))
        return 2
    print("\n✅ 三门语言都能合成。起服务：python bridge/tts-server.py --port 8790")
    return 0


def selftest():
    """纯函数自检：不需要 piper、不需要模型文件。"""
    passed, failed = [], []

    def check_one(name, condition):
        (passed if condition else failed).append(name)

    check_one("语言归一 zh", normalize_lang("zh-CN") == "zh-CN")
    check_one("语言归一下划线", normalize_lang("pt_BR") == "pt-BR")
    check_one("语言归一大小写", normalize_lang("EN-us") == "en-US")
    check_one("语言认不出给空串", normalize_lang("xx-YY") == "")
    check_one("空语言给空串", normalize_lang("") == "")
    onnx, config = voice_path("/models", "pt_BR-faber-medium")
    check_one("音色路径 .onnx", str(onnx).replace("\\", "/").endswith("/models/pt_BR-faber-medium.onnx"))
    check_one("音色路径 .onnx.json", str(config).replace("\\", "/").endswith("/models/pt_BR-faber-medium.onnx.json"))
    # 造一段 0.5 秒的静音 wav，验证时长读取
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(22050)
        handle.writeframes(b"\x00\x00" * 11025)
    check_one("wav 时长读取（0.5 s）", wav_duration_ms(buffer.getvalue()) == 500)
    check_one("坏数据不炸", wav_duration_ms(b"not-a-wav") == 0)
    check_one("三门语言都有默认音色", all(lang in DEFAULT_VOICES for lang in ("zh-CN", "pt-BR", "en-US")))
    check_one("文本上限合理", 200 <= MAX_TEXT_CHARS <= 2000)

    print(f"passed={len(passed)} failed={len(failed)}")
    for name in failed:
        print(f"  ✗ {name}")
    return 1 if failed else 0


def main(argv=None):
    parser = argparse.ArgumentParser(description="服务器自建语音合成（piper）")
    parser.add_argument("--port", type=int, default=8790, help="监听端口（缺省 8790，只绑 127.0.0.1）")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址（缺省只绑本机；别开到公网）")
    parser.add_argument("--voice-dir", default=DEFAULT_VOICE_DIR,
                        help=f"piper 音色目录（缺省 {DEFAULT_VOICE_DIR}，也可用 LEION_TTS_MODELS）")
    parser.add_argument("--zh", default=DEFAULT_VOICES["zh-CN"], help="中文音色名")
    parser.add_argument("--pt", default=DEFAULT_VOICES["pt-BR"], help="巴葡音色名")
    parser.add_argument("--en", default=DEFAULT_VOICES["en-US"], help="英语音色名")
    parser.add_argument("--selftest", action="store_true", help="只跑纯函数自检")
    parser.add_argument("--check", action="store_true", help="只检查引擎与音色文件，不起服务")
    args = parser.parse_args(argv)
    args.voices = {"zh-CN": args.zh, "pt-BR": args.pt, "en-US": args.en}

    if args.selftest:
        return selftest()
    if args.check:
        return check(args)

    synth = Synth(args.voice_dir, args.voices)
    available = synth.available()
    log(f"音色目录 {args.voice_dir}")
    for lang, info in available.items():
        log(f"  {'✅' if info['ready'] else '·'} {lang} → {info['voice']}")
    ready = [one for one, info in available.items() if info["ready"]]
    if not ready:
        log("✗ 一个能用的音色都没有 —— 先按 scripts/tts-doctor.py 的提示下载音色")
        return 2

    server = ThreadingHTTPServer((args.host, args.port), make_handler(synth))
    server.daemon_threads = True
    log(f"听 {args.host}:{args.port}（内网服务，由 relay 的 POST /tts 代理出去）")
    log("可以合成：" + "、".join(ready))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("收到 Ctrl+C，退出")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
