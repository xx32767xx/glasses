#!/usr/bin/env python3
"""生成 systemd 用的 EnvironmentFile：PATH + LD_LIBRARY_PATH（可选 HF_HOME）。

为什么需要它：`bridge/asr-bridge.mjs` 起识别进程用的是 PATH 里的 `python`
（`spawn('python …')`），而 `ctranslate2` 需要 cu12 的运行库
（`libcublas.so.12`、`libcudnn*_9`）。手动跑时 `source` 一下环境就够了；
交给 systemd 之后没有 shell，这两个变量必须显式写进单元文件。
路径又长又容易抄错，所以用脚本生成。

用法：
  python3 scripts/make-env-file.py /opt/leion/venv
  sudo python3 scripts/make-env-file.py /opt/leion/venv --out /etc/leion/asr.env
  python3 scripts/make-env-file.py /opt/conda/envs/leion --hf-home /opt/leion/models

环境目录可以是 venv（`python3 -m venv` 建的），也可以是 conda 环境
（`conda create -n leion` 建的）——两者的布局都是 `<目录>/bin/python`。

只用标准库，可离线运行。
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import subprocess
import sys

PROBE = r"""
import glob, json, os, site, sys

paths = []
bases = []
try:
    bases.extend(site.getsitepackages())
except Exception:
    pass
try:
    bases.append(site.getusersitepackages())
except Exception:
    pass
for base in [b for b in dict.fromkeys(bases) if b]:
    for d in sorted(glob.glob(os.path.join(base, 'nvidia', '*', 'lib'))):
        if d not in paths:
            paths.append(d)

info = {'python': sys.version.split()[0], 'ld_paths': paths}

try:
    import ctranslate2
    info['ctranslate2'] = getattr(ctranslate2, '__version__', '?')
except Exception as exc:
    info['ctranslate2_error'] = type(exc).__name__ + ': ' + str(exc)[:120]

try:
    import faster_whisper
    info['faster_whisper'] = str(getattr(faster_whisper, '__version__', '?'))
except Exception as exc:
    info['faster_whisper_error'] = type(exc).__name__ + ': ' + str(exc)[:120]

print(json.dumps(info, ensure_ascii=False))
"""

DEFAULT_PATH_TAIL = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
FALLBACK_LD = '/usr/local/nvidia/lib:/usr/local/nvidia/lib64'


def fail(message: str, hint: str = '') -> None:
    sys.stderr.write(message.rstrip() + '\n')
    if hint:
        sys.stderr.write(hint.rstrip() + '\n')
    raise SystemExit(1)


def probe(python: str) -> dict:
    try:
        done = subprocess.run(
            [python, '-c', PROBE],
            capture_output=True,
            text=True,
            timeout=180,
        )
    except OSError as exc:
        fail(f'跑不起来 {python}：{exc}', '确认这是一个能正常启动的解释器。')
    if done.returncode != 0:
        detail = (done.stderr or '').strip().splitlines()
        tail = detail[-1] if detail else f'退出码 {done.returncode}'
        fail(f'在 {python} 里跑探测脚本失败：{tail}', '先手动执行 "{} -c \'import sys; print(sys.version)\'" 确认。'.format(python))
    try:
        return json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        fail(f'探测脚本没有返回可解析的结果：{done.stdout[:200]!r}')


def main(argv: list) -> int:
    parser = argparse.ArgumentParser(
        description='生成 systemd 用的 EnvironmentFile（PATH + LD_LIBRARY_PATH）。',
        epilog='环境目录是 venv 或 conda 环境根目录（里面有 bin/python）。',
    )
    parser.add_argument('env_dir', help='venv 或 conda 环境根目录，例如 /opt/leion/venv、/opt/conda/envs/leion')
    parser.add_argument('--out', help='写到这个文件（例如 /etc/leion/asr.env）；省略则打印到屏幕')
    parser.add_argument('--python', dest='python_override', help='指定解释器，默认 <env_dir>/bin/python（排查时有用）')
    parser.add_argument('--hf-home', dest='hf_home', help='模型缓存目录，写进 HF_HOME（下载模型前先定好，别用默认家目录）')
    parser.add_argument('--check', action='store_true', help='只做检查、不输出环境文件')
    args = parser.parse_args(argv)

    env_dir = args.env_dir
    if not os.path.isdir(env_dir):
        fail(f'找不到环境目录：{env_dir}', 'venv 常见在 /opt/leion/venv；conda 环境在 /opt/conda/envs/<名字>。')
    env_dir = os.path.abspath(env_dir)

    python = args.python_override or os.path.join(env_dir, 'bin', 'python')
    if not args.python_override and not os.path.exists(python):
        fail(
            f'找不到解释器：{python}',
            '这个目录看起来不是 venv/conda 环境（缺 bin/python）。\n'
            '如果想指定别的解释器，加 --python /path/to/python。',
        )

    info = probe(python)
    ld_paths = [p for p in info.get('ld_paths') or [] if p]

    path_value = f'{env_dir}/bin:{DEFAULT_PATH_TAIL}'
    ld_value = ':'.join([*ld_paths, FALLBACK_LD]) if ld_paths else FALLBACK_LD

    lines = [f'PATH={path_value}', f'LD_LIBRARY_PATH={ld_value}']
    hf_home = args.hf_home or os.environ.get('HF_HOME') or ''
    if hf_home:
        lines.append(f'HF_HOME={os.path.abspath(hf_home)}')
    text = '\n'.join(lines) + '\n'

    if not args.check:
        if args.out:
            out_path = os.path.abspath(args.out)
            try:
                fd = os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
                with os.fdopen(fd, 'w', encoding='utf-8') as handle:
                    handle.write(text)
            except OSError as exc:
                fail(
                    f'写不进 {out_path}：{exc}',
                    f'多半是权限问题，试：sudo python3 scripts/make-env-file.py {env_dir} --out {out_path}',
                )
            sys.stderr.write(f'已写入 {out_path}\n')
        else:
            sys.stdout.write(text)

    # ---- 诊断（全走 stderr，方便 --out 时管道读取干净）----
    sys.stderr.write('---\n')
    sys.stderr.write(f'环境目录 : {env_dir}\n')
    sys.stderr.write(f'解释器   : {python}\n')
    sys.stderr.write(f'Python   : {info.get("python") or "?"}\n')

    if info.get('ctranslate2'):
        sys.stderr.write(f'ctranslate2    : OK {info["ctranslate2"]}\n')
    else:
        why = info.get('ctranslate2_error') or '未安装'
        sys.stderr.write(f'ctranslate2    : 缺少（{why}）→ pip install faster-whisper\n')
    if info.get('faster_whisper'):
        sys.stderr.write(f'faster_whisper : OK {info["faster_whisper"]}\n')
    else:
        why = info.get('faster_whisper_error') or '未安装'
        sys.stderr.write(f'faster_whisper : 缺少（{why}）\n')

    if ld_paths:
        sys.stderr.write(f'cu12 运行库: {ld_value}\n')
    else:
        sys.stderr.write(
            'cu12 运行库: 没找到（GPU 模式需要 pip install nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*"；'
            '纯 CPU 跑可忽略）\n'
        )

    sys.stderr.write(
        '下一步：把上面的变量交给 systemd（EnvironmentFile=），'
        '或在当前 shell 里 export 后跑 python3 scripts/check-asr-env.py 自检。\n'
    )

    bad = bool(info.get('ctranslate2_error')) or bool(info.get('faster_whisper_error'))
    return 1 if bad else 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
