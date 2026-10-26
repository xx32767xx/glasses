#!/usr/bin/env python3
"""check-relay.py —— 测"这台机器能不能连上服务器"（手机连之前先在这里排掉八成问题）

为什么单独有一个脚本：
    接不上服务器时，不同原因在手机上看起来是**同一件事**（"连不上""卡住""没反应"）。
    但在服务器这边其实分得很清楚：进程没起、端口没开、防火墙没放行、密钥不对、
    地址写错、TLS 证书不对……处置完全不同。这个脚本按顺序逐项测，并把
    "哪一步断了 + 下一步做什么"直接打出来。

它测什么（顺序执行，某一步断了就停）：
    ① 地址写法                    192.168.1.5:8788 → http://192.168.1.5:8788
    ② TCP 能不能连上               连不上 = 服务没起 / 端口不对 / 防火墙
    ③ GET /hello  （验证共享密钥）  连接正常但密钥错，会在这里第一次暴露
    ④ GET /status （确诊计数）      看它真的在跑、有没有收到过音频
    ⑤ GET /admin  （管理页）        返回 HTML 就说明整条 Web 路由是通的
    ⑥ 可选：登录 → /org/libraries  → /org/meeting/current   （测账号与术语链路）

用法：
    # 在服务器自己身上（最常见的第一步）
    python3 scripts/check-relay.py --data-dir /var/lib/leion/live

    # 在另一台电脑上（测局域网）
    python3 scripts/check-relay.py --base http://192.168.1.5:8788 --secret <密钥>

    # 测公网域名（TLS）
    python3 scripts/check-relay.py --base https://translate.example.com --secret <密钥>

    # 连账号那一段一起测
    python3 scripts/check-relay.py --base http://192.168.1.5:8788 --data-dir var/live \\
        --user boss --password '******'

密钥从哪来：`<数据目录>/relay-secret.txt`；`start-all --public` 会在横幅里打印。
"""

import argparse
import json
import os
import socket
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request


# ── 纯函数（都有测试钉着，见 tests/python-suite.py）────────────────────────────

def normalize_base_url(raw):
    """把用户随手写的地址补成合法 base url。

    人写地址的方式太多了：192.168.1.5:8788 / http://x:8788/ / https://a.b/c
    这里只做三件事：补 scheme、去掉末尾斜杠、去掉多余的路径前缀（服务器路由都挂在根上）。
    """
    text = (raw or "").strip()
    if not text:
        raise ValueError("地址不能为空")
    if "://" not in text:
        text = "http://" + text
    parsed = urllib.parse.urlsplit(text)
    if not parsed.hostname:
        raise ValueError(f"地址里没有主机名：{raw!r}")
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"只支持 http / https，收到 {parsed.scheme!r}")
    netloc = parsed.hostname
    if parsed.port:
        netloc = f"{netloc}:{parsed.port}"
    return f"{parsed.scheme}://{netloc}"


def read_secret_file(path):
    """读 relay-secret.txt；没有就返回空串（由调用方决定怎么提示）。"""
    try:
        with open(path, encoding="utf-8") as handle:
            return handle.read().strip()
    except OSError:
        return ""


def frame_of(payload):
    """从 /frame 的响应里取出这一帧的 (原文, 译文, 是否增量)；没有帧就返回 None。

    /frame 的形状是 {ok, changed, seq, frame:{source, text, partial}}。
    抽成函数是为了能被测试钉住 —— "取了半天说没有帧" 是排查时最费时间的一种错。
    """
    if not isinstance(payload, dict):
        return None
    frame = payload.get("frame")
    if not isinstance(frame, dict):
        return None
    return {
        "source": frame.get("source") if isinstance(frame.get("source"), str) else "",
        "text": frame.get("text") if isinstance(frame.get("text"), str) else "",
        "partial": frame.get("partial") is True,
    }


def classify_failure(message):
    """把网络/HTTP 失败翻成"下一步做什么"。返回若干行。"""
    text = (message or "").lower()
    if "refused" in text or "10061" in text or "actively refused" in text:
        return [
            "服务没在这个端口上监听（或端口写错了）。",
            "  ① 服务器上确认进程活着：node scripts/start-all.mjs …（或 systemctl status leion）",
            "  ② 确认端口：ss -ltnp | grep 8788 —— 应看到 0.0.0.0:8788（只监听 127.0.0.1 的话外部连不上）",
            "  ③ 监听在本机时要加 --public（绑 0.0.0.0），否则只有服务器自己能连。",
        ]
    if "timed out" in text or "timeout" in text:
        return [
            "连接超时：地址可达但没回包，通常是**防火墙/安全组/端口转发**没放行。",
            "  ① 服务器上：sudo ufw status（要 allow 8788/tcp，或只放行 443 交给反代）",
            "  ② 云主机：安全组里放行对应端口",
            "  ③ 家里服务器：路由器上做端口转发，并确认公网 IP 是运营商没有做 NAT 的那种",
        ]
    if "name or service not known" in text or "getaddrinfo" in text or "nodename" in text:
        return [
            "域名解析不了。先备份：用 IP:端口 直接试，能通就是域名/解析的问题。",
            "  域名还没生效或拼错；公网访问还要先做备案（国内服务器）。",
        ]
    if "certificate" in text or "ssl" in text:
        return [
            "TLS 证书有问题（自签证书、证书与域名不匹配、或还没配反代）。",
            "  局域网内直接用 http://IP:8788 就行；公网必须配证书，见 docs/10 §4（Caddy 最省事）。",
        ]
    if "401" in text or "unauthorized" in text:
        return [
            "连上了，但**密钥不对**（这一步最容易被误判成'连不上'）。",
            "  用服务器上的 <数据目录>/relay-secret.txt，或 start-all 横幅里打印的那串。",
            "  手机端也要同步改：密钥错和网络错在手机上看起来一模一样。",
        ]
    if "404" in text:
        return [
            "连上了，但这个路径没有（说明 base 地址多了路径前缀）。",
            "  把地址写成 http://主机:端口（不要带 /xxx 后缀）。",
        ]
    return []


# ── 网络探测 ────────────────────────────────────────────────────────────────

class Probe:
    def __init__(self, base, secret, timeout):
        self.base = base
        self.secret = secret
        self.timeout = timeout
        self.failures = []
        self.context = None
        if base.startswith("https://"):
            # 自签证书也要能测通，否则"证书问题"和"连不上"分不开
            self.context = ssl.create_default_context()
            self.context.check_hostname = False
            self.context.verify_mode = ssl.CERT_NONE

    def request(self, path, method="GET", body=None, token=None, timeout=None):
        url = f"{self.base}{path}"
        data = None
        headers = {}
        if self.secret:
            headers["X-Leion-Secret"] = self.secret
        if token:
            headers["X-Leion-Token"] = token
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        effective_timeout = self.timeout if timeout is None else timeout
        try:
            with urllib.request.urlopen(request, timeout=effective_timeout, context=self.context) as response:
                raw = response.read()
                return response.status, raw
        except urllib.error.HTTPError as error:
            return error.code, error.read()
        except urllib.error.URLError as error:
            reason = getattr(error, "reason", error)
            raise ConnectionError(f"{path}: {reason}") from None
        except socket.timeout:
            raise ConnectionError(f"{path}: timed out") from None

    def json(self, path, **kwargs):
        status, raw = self.request(path, **kwargs)
        text = raw.decode("utf-8", errors="replace")
        try:
            return status, json.loads(text), text
        except ValueError:
            return status, None, text


def say(ok, label, detail=""):
    mark = "✓" if ok else "✗"
    print(f"  {mark} {label}" + (f"：{detail}" if detail else ""))
    return ok


def say_once(probe, text, source_lang, wait_seconds):
    """把一句话塞进收件箱，等大脑翻出译文。返回是否成功。

    为什么值得做成一个开关：这条链路（relay → 收件箱 → 大脑 → 字幕总线）用 curl 手搓
    很容易被引号/转义坑住（JSON 里带中文、shell 里带空格），然后你得分辨
    "是我 curl 写错了" 还是 "大脑没工作"。这里一次说清。
    """
    import time

    print("  · ⑦ 大脑链路：塞一句话，等译文")
    try:
        status, stats, body = probe.json("/status")
    except ConnectionError as error:
        say(False, "   /status 读不到，没法定位新帧", str(error))
        return False
    since = stats.get("seq") if isinstance(stats, dict) else 0
    if not isinstance(since, int):
        since = 0

    try:
        status, payload, body = probe.json(
            "/say", method="POST",
            body={"text": text, "from": source_lang},
        )
    except ConnectionError as error:
        say(False, "   POST /say 失败", str(error))
        for item in classify_failure(str(error)):
            print(f"      {item}")
        return False
    if status != 200 or not payload or payload.get("ok") is not True:
        say(False, "   POST /say 被拒", f"HTTP {status} {body[:140]}")
        for item in classify_failure(f"{status} {body}"):
            print(f"      {item}")
        return False
    say(True, "   已写入收件箱", f"「{text}」")
    print(f"   等译文，最多 {wait_seconds:.0f} 秒（大脑要先调一次模型）…")

    deadline = time.time() + max(1.0, wait_seconds)
    while time.time() < deadline:
        remaining = deadline - time.time()
        if remaining <= 0:
            break
        # /frame 是**长轮询**：没有新帧时它会挂住最多 25 秒（relay 的 pollHoldMs）。
        # 所以这里的单次超时不能被当成错误 —— 它正是"还没有译文"的正常表现。
        per_request = max(1.0, min(remaining, 8.0))
        try:
            status, payload, body = probe.json(f"/frame?since={since}", timeout=per_request)
        except ConnectionError as error:
            if "timed out" in str(error).lower():
                continue                     # 长轮询到点没新帧，继续等（直到 deadline）
            say(False, "   /frame 请求失败", str(error))
            return False
        if status != 200:
            say(False, "   /frame 返回异常", f"HTTP {status} {body[:120]}")
            return False
        frame = frame_of(payload)
        if frame is not None and frame["text"]:
            label = "增量（半句）" if frame["partial"] else "定稿"
            say(True, f"   译文到了（{label}）", frame["text"])
            if frame["source"]:
                print(f"      原文 {frame['source']}")
            return True
        # 没等到就继续长轮询；服务端自己会挂住到有新帧或超时
        time.sleep(0.2)

    say(False, "   没等到译文", f"{wait_seconds:.0f} 秒内字幕总线没有新帧")
    print("      多半是大脑没在工作，按顺序查：")
    print("        ① 有没有起大脑：ps aux | grep harness-side")
    print("        ② 大脑日志：tail -30 <仓库>/var/logs/brain.log")
    print("        ③ 翻译凭据：没配 DEEPSEEK_API_KEY（或 $DSH_HOME/.credentials.yaml）时大脑翻不出来")
    print("        ④ 想先排除大脑：用 --offline 起 start-all，只认剧本那 14 句")
    return False


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="测这台机器能不能连上转发服务器（手机连之前先跑这个）",
        epilog="地址可以写 192.168.1.5:8788，脚本会补成 http://",
    )
    parser.add_argument("--base", default="http://127.0.0.1:8788", help="服务器地址，缺省本机 8788")
    parser.add_argument("--secret", default=None, help="共享密钥；不给就读 --data-dir/relay-secret.txt")
    parser.add_argument("--data-dir", default=os.environ.get("LEION_DATA_DIR") or "var/live", help="数据目录（找 relay-secret.txt）；缺省取 $LEION_DATA_DIR 或 var/live")
    parser.add_argument("--user", default=None, help="可选：账号，用来自动测 /auth/login 与 /org")
    parser.add_argument("--password", default=None, help="可选：密码")
    parser.add_argument("--timeout", type=float, default=5.0, help="单次请求超时秒数，缺省 5")
    parser.add_argument("--say", default=None,
                        help="塞一句话进收件箱并等译文（测 relay+大脑 的整条链路，不含识别）")
    parser.add_argument("--from", dest="source_lang", default="zh-CN",
                        help="配合 --say：源语种，缺省 zh-CN")
    parser.add_argument("--wait", type=float, default=20.0,
                        help="配合 --say：等译文的最长秒数，缺省 20")
    args = parser.parse_args(argv)

    print("转发服务器连通性检查")
    try:
        base = normalize_base_url(args.base)
    except ValueError as error:
        print(f"  ✗ 地址不对：{error}")
        return 2
    print(f"  目标  {base}")

    secret = args.secret
    secret_source = "命令行 --secret"
    if secret is None:
        secret_path = os.path.join(args.data_dir, "relay-secret.txt")
        secret = read_secret_file(secret_path)
        secret_source = secret_path
    if not secret:
        print(f"  ⚠️ 没有密钥（找过 {secret_source}）；下面第 ③ 步大概率会 401")
    else:
        print(f"  密钥  {secret[:4]}…（来自 {secret_source}）")

    probe = Probe(base, secret, args.timeout)

    # ② TCP
    host = urllib.parse.urlsplit(base).hostname
    port = urllib.parse.urlsplit(base).port or (443 if base.startswith("https") else 80)
    try:
        with socket.create_connection((host, port), timeout=args.timeout):
            pass
        say(True, "② TCP 能连上", f"{host}:{port}")
    except OSError as error:
        say(False, "② TCP 连不上", f"{host}:{port} → {error}")
        for item in classify_failure(str(error)):
            print(f"      {item}")
        return 1

    # ③ /hello
    try:
        status, payload, text = probe.json("/hello")
    except ConnectionError as error:
        say(False, "③ GET /hello 失败", str(error))
        for item in classify_failure(str(error)):
            print(f"      {item}")
        return 1
    if status != 200 or not payload or payload.get("ok") is not True:
        say(False, "③ GET /hello 被拒", f"HTTP {status} {text[:120]}")
        for item in classify_failure(f"{status} {text}"):
            print(f"      {item}")
        return 1
    features = payload.get("features") or []
    say(True, "③ /hello 通过（密钥对）",
        f"显示 {payload.get('cols')}×{payload.get('lineBudget')} · 帧序号 {payload.get('seq')}")
    print(f"      设备  {payload.get('device')}   后端  {payload.get('bridge')}")
    print(f"      能力  {', '.join(features) if features else '(未报告)'}")

    # ④ /status
    try:
        status, stats, text = probe.json("/status")
    except ConnectionError as error:
        say(False, "④ GET /status 失败", str(error))
        return 1
    if status == 200 and isinstance(stats, dict):
        scalars = {k: v for k, v in stats.items() if isinstance(v, (int, float, str)) and not isinstance(v, bool)}
        show = ", ".join(f"{k}={v}" for k, v in list(scalars.items())[:8])
        say(True, "④ /status 正常", show or "(没有可显示的计数)")
    else:
        say(False, "④ /status 异常", f"HTTP {status} {text[:120]}")

    # ⑤ /admin
    try:
        status, raw = probe.request("/admin")
        html = raw.decode("utf-8", errors="replace")
        ok = status == 200 and "<" in html
        say(ok, "⑤ /admin 管理页", f"HTTP {status}，{len(html)} 字节")
        if not ok:
            for item in classify_failure(f"{status}"):
                print(f"      {item}")
    except ConnectionError as error:
        say(False, "⑤ /admin 失败", str(error))

    # ⑥ 账号与术语（可选）
    if args.user and args.password:
        try:
            status, payload, text = probe.json("/auth/login", method="POST",
                                               body={"username": args.user, "password": args.password})
        except ConnectionError as error:
            say(False, "⑥ 登录失败", str(error))
            return 1
        if status != 200 or not payload or not payload.get("token"):
            say(False, "⑥ 登录失败", f"HTTP {status} {text[:140]}")
            print("      账号还没建？服务器上：python3 scripts/terms-admin.mjs admin --username ... --password ...")
            return 1
        token = payload["token"]
        say(True, "⑥ 登录成功", f"用户 {payload.get('user')} · 角色 {payload.get('role')}")
        for path, label in (("/auth/whoami", "身份"), ("/org/libraries", "术语库"),
                            ("/org/meeting/current", "当前会议术语")):
            try:
                status, payload2, text = probe.json(path, token=token)
            except ConnectionError as error:
                say(False, f"   {label}（{path}）", str(error))
                continue
            if status == 200 and payload2 is not None:
                if path.endswith("/libraries"):
                    items = payload2.get("libraries") or payload2.get("items") or []
                    say(True, f"   {label}（{path}）", f"{len(items)} 个库")
                elif path.endswith("/current"):
                    say(True, f"   {label}（{path}）",
                        f"会议 {payload2.get('meetingId')} · {len(payload2.get('entries') or [])} 条词条")
                else:
                    say(True, f"   {label}（{path}）", str(payload2.get("user") or payload2.get("role") or "ok"))
            elif status == 404 and path.endswith("/current"):
                say(True, f"   {label}（{path}）", "还没有会议术语（正常：手机还没开始同传）")
            else:
                say(False, f"   {label}（{path}）", f"HTTP {status} {text[:120]}")
    else:
        print("  · ⑥ 账号与术语：没给 --user/--password，跳过（要测就补上）")

    # ⑦ 塞一句话，等译文（测 relay + 大脑；不含识别）
    if args.say:
        if not say_once(probe, args.say, args.source_lang, args.wait):
            return 1
    else:
        print("  · ⑦ 大脑链路：没给 --say，跳过（要测大脑就加 --say \"这是一条测试信息\"）")

    print("\n全部通过。现在可以在手机上填这个地址了：")
    print(f"  {base}")
    print("  手机端还有两件事容易漏：① 密钥要和服务器的 relay-secret.txt 一致；")
    print("  ② 手机与服务器在同一局域网，或服务器已经做了公网映射（见 docs/10 §4）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
