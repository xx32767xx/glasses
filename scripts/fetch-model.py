#!/usr/bin/env python3
"""fetch-model.py —— 把 faster-whisper 的模型下到指定目录（可续传、走镜像、关掉 Xet）

为什么单独有这个脚本：
    服务器上第一次跑识别时，模型是从 HuggingFace 现下的（large-v3 约 3 GB）。
    国内直连 huggingface.co 经常失败，报错长这样：

        '[SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of protocol'
        Retrying in 1s [Retry 1/5] ...
        .../xet-read-token/edac...  ← 注意这个路径

    这不是"环境坏了"，是**模型下不下来**。两个开关就能解决：
      ① HF_ENDPOINT=https://hf-mirror.com      （换镜像站）
      ② HF_HUB_DISABLE_XET=1                  （新版 huggingface_hub 默认用 Xet 传输，
                                                而镜像站不转 Xet 接口 → 就是上面那个 SSL 报错）
    这两件事在识别进程里是很难看不出来的，所以单独做成一个可以反复重试的脚本：
    缓存是按文件续传的，中断了再跑一遍就行，不会从头再来。

用法：
    python scripts/fetch-model.py                        # 下 large-v3 到 $HF_HOME
    python scripts/fetch-model.py medium                 # 换模型
    python scripts/fetch-model.py large-v3 --mirror      # 走 hf-mirror.com（国内推荐）
    python scripts/fetch-model.py large-v3 --dest /opt/leion/models
    python scripts/fetch-model.py --list                 # 看这个目录里已经有什么

下完之后把它打印的 export 行贴进 shell（或写进 systemd 的 EnvironmentFile），
再跑 python scripts/check-asr-env.py 做实测。
"""

import argparse
import os
import sys

DEFAULT_MIRROR = "https://hf-mirror.com"
OFFICIAL = "https://huggingface.co"

# faster-whisper 支持的名字 → HuggingFace 仓库
REPO_TEMPLATE = "Systran/faster-whisper-{name}"
KNOWN_SIZES = ("tiny", "base", "small", "medium", "large-v1", "large-v2", "large-v3", "large-v3-turbo",
               "distil-small.en", "distil-medium.en", "distil-large-v2", "distil-large-v3")


def repo_of(name):
    """模型名 → 仓库 id。已经写成 "组织/仓库" 的原样返回。"""
    name = (name or "").strip()
    if not name:
        raise ValueError("模型名不能为空")
    if "/" in name:
        return name
    return REPO_TEMPLATE.format(name=name)


def human_size(num_bytes):
    """字节数 → 人话（3.1 GB 这种）。"""
    value = float(num_bytes or 0)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if value < 1024 or unit == "TB":
            return f"{value:.1f} {unit}" if unit != "B" else f"{int(value)} B"
        value /= 1024
    return f"{value:.1f} TB"


def dir_size(path):
    total = 0
    for base, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(base, name))
            except OSError:
                pass
    return total


def cached_models(dest):
    """dest/hub 下已下过的仓库（huggingface_hub 的缓存布局）。"""
    import glob
    hub = os.path.join(dest, "hub")
    found = []
    for path in sorted(glob.glob(os.path.join(hub, "models--*"))):
        name = os.path.basename(path).replace("models--", "").replace("--", "/")
        found.append((name, dir_size(path)))
    return found


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="下载 faster-whisper 模型（可续传、支持镜像、默认关掉 Xet）",
        epilog="已经下了一半？直接重跑同一条命令，缓存会续传。",
    )
    parser.add_argument("model", nargs="?", default="large-v3",
                        help="模型名（tiny/base/small/medium/large-v3/...）或完整仓库 id")
    parser.add_argument("--dest", default=os.environ.get("HF_HOME") or "var/cache/hf",
                        help="缓存目录，会写进 HF_HOME；缺省用环境里的 HF_HOME 或 var/cache/hf")
    parser.add_argument("--mirror", action="store_true", help=f"走镜像 {DEFAULT_MIRROR}（国内推荐）")
    parser.add_argument("--endpoint", default=None, help="指定 HF_ENDPOINT（优先于 --mirror）")
    parser.add_argument("--xet", action="store_true", help="保留 Xet 传输（缺省关掉：镜像站不支持它）")
    parser.add_argument("--workers", type=int, default=4, help="并发下载数，缺省 4（镜像站别开太大）")
    parser.add_argument("--timeout", type=float, default=30.0, help="单次请求超时秒数，缺省 30")
    parser.add_argument("--revision", default=None, help="指定 revision（缺省 main）")
    parser.add_argument("--list", action="store_true", help="只列出 dest 里已下载的模型，不联网")
    args = parser.parse_args(argv)

    dest = os.path.abspath(args.dest)
    os.makedirs(dest, exist_ok=True)

    if args.list:
        found = cached_models(dest)
        print(f"缓存目录：{dest}")
        if not found:
            print("  （还没有下载过模型）")
        for name, size in found:
            print(f"  {name:46} {human_size(size)}")
        return 0

    endpoint = args.endpoint or (DEFAULT_MIRROR if args.mirror else os.environ.get("HF_ENDPOINT") or OFFICIAL)
    os.environ["HF_HOME"] = dest
    os.environ["HF_ENDPOINT"] = endpoint
    # 注意：HF_HUB_DOWNLOAD_TIMEOUT 必须是整数秒，写成 "30.0" 会让 huggingface_hub
    # 一 import 就抛 ValueError（踩过一次，报错完全看不出是这个变量的事）。
    os.environ["HF_HUB_DOWNLOAD_TIMEOUT"] = str(int(max(1.0, float(args.timeout))))
    if not args.xet:
        os.environ["HF_HUB_DISABLE_XET"] = "1"

    repo = repo_of(args.model)
    print("下载 faster-whisper 模型")
    print(f"  仓库     {repo}")
    print(f"  缓存     {dest}")
    print(f"  下载源   {endpoint}" + ("（镜像）" if endpoint != OFFICIAL else "（官方，国内常常连不上）"))
    print(f"  Xet      {'开（官方源默认）' if args.xet else '关（镜像站不转 Xet 接口，关掉更稳）'}")

    try:
        from huggingface_hub import snapshot_download
    except Exception as error:                          # noqa: BLE001
        print(f"\n✗ huggingface_hub 用不了（{type(error).__name__}: {error}）")
        print("  修法：pip install -U huggingface_hub      （faster-whisper 一般会自带它）")
        return 1

    import time
    started = time.perf_counter()
    try:
        path = snapshot_download(
            repo_id=repo,
            revision=args.revision,
            max_workers=max(1, int(args.workers)),
        )
    except Exception as error:                          # noqa: BLE001
        message = str(error).strip().splitlines()[0][:200]
        print(f"\n✗ 下载失败：{message}")
        print("\n  常见原因与处置：")
        print("    · 国内直连官方源失败 → 用镜像重试：python scripts/fetch-model.py "
              f"{args.model} --mirror")
        print("    · 出现 xet-read-token / SSL 报错 → 确认 HF_HUB_DISABLE_XET=1（本脚本默认已设）")
        print("    · 卡住不动 → 加大超时：--timeout 120；或减少并发：--workers 2")
        print("    · 需要登录/限流（401/403）→ export HF_TOKEN=... 再试")
        print("    · 已经下了一半不会浪费：缓存按文件续传，直接重跑同一条命令")
        return 1
    elapsed = time.perf_counter() - started
    size = dir_size(os.path.dirname(path))

    print(f"\n✓ 下载完成：{path}")
    print(f"  用时 {elapsed:.0f}s，占用 {human_size(size)}")

    # 用 faster-whisper 自己的查找逻辑验证一遍：能在这里找到，识别进程才找得到
    try:
        from faster_whisper.utils import download_model as fw_download_model
        located = fw_download_model(args.model if "/" not in repo_of(args.model) else repo,
                                     local_files_only=True)
        print(f"✓ faster-whisper 找得到它：{located}")
    except Exception as error:                          # noqa: BLE001
        print(f"⚠️ 没能用 faster-whisper 的查找逻辑验证（{type(error).__name__}: {error}）")
        print("   只要上面的路径里有 model.bin 就基本没事；识别时仍找不到就是 HF_HOME 没对上（见下面两行）。")

    print("\n接下来（shell 里）：")
    print(f"  export HF_HOME={dest}" + ("" if endpoint == OFFICIAL else f"\n  export HF_ENDPOINT={endpoint}"))
    print("  python scripts/check-asr-env.py --models " + (args.model if "/" not in args.model else "large-v3"))
    print("\n交给 systemd 时（写进 EnvironmentFile，别指望 shell 变量）：")
    print(f"  HF_HOME={dest}")
    if endpoint != OFFICIAL:
        print(f"  HF_ENDPOINT={endpoint}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
