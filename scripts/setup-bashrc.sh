#!/usr/bin/env bash
# ============================================================================
# setup-bashrc.sh —— 一次性把本机（服务器）需要的环境变量与别名写进 ~/.bashrc
#
#   bash setup-bashrc.sh              # 演练：只打印将要追加的内容
#   bash setup-bashrc.sh --apply      # 真正追加（可重复执行，不会重复写）
#
# 它只做三件事：
#   ① 生成 cu12 运行库路径文件（venv 里的 nvidia/*/lib，路径含 Python 版本，不能写死）
#   ② 往 ~/.bashrc 追加一段**带标记**的配置（重复执行会替换旧的那段，不会叠加）
#   ③ 打印验证命令
#
# 刻意**不**写进 bashrc 的：DEEPSEEK_API_KEY（会被所有进程继承、容易泄露）。
# ============================================================================
set -euo pipefail

APPLY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "看不懂的参数：$arg（用 --apply 或 --help）" >&2; exit 2 ;;
  esac
done

# ── 路径（本脚本假设仓库在 ~/glasses，venv 在 /opt/leion/venv）
REPO="${LEION_REPO:-$HOME/glasses}"
VENV="${LEION_VENV:-/opt/leion/venv}"
DSH="${LEION_DSH:-$HOME/deepseek-harness}"
MODELS="${LEION_MODELS:-/opt/leion/models}"
DATA="${LEION_DATA_DIR:-/var/lib/leion/live}"
MARK_BEGIN="# >>> leion env (managed by setup-bashrc.sh) >>>"
MARK_END="# <<< leion env <<<"

say() { printf '%s\n' "$*"; }

# ── ① 前置检查（缺什么直接说清楚，不要走到一半才炸）
[ -x "$VENV/bin/python" ] || { echo "找不到 venv 解释器：$VENV/bin/python" >&2
  echo "  用 LEION_VENV=/你的/venv bash $0 指定" >&2; exit 1; }
[ -d "$REPO" ] || { echo "找不到仓库目录：$REPO" >&2; echo "  用 LEION_REPO=... 指定" >&2; exit 1; }
[ -d "$DSH" ] || echo "⚠️  DSH 检出不存在：$DSH（大脑会起不来；先 git clone + pnpm build）" >&2

mkdir -p "$REPO/var/cache" "$MODELS"
LD_FILE="$REPO/var/cache/ld-path.txt"
"$VENV/bin/python" - <<'PY' > "$LD_FILE"
import glob, os, site
paths = []
for base in [b for b in dict.fromkeys(list(site.getsitepackages())) if b]:
    paths += sorted(glob.glob(os.path.join(base, 'nvidia', '*', 'lib')))
print(':'.join(dict.fromkeys(paths)))
PY
if [ -s "$LD_FILE" ]; then
  say "✅ cu12 运行库路径：$(cat "$LD_FILE")"
else
  say "⚠️  没找到 nvidia/*/lib（GPU 模式需要 pip install nvidia-cublas-cu12 \"nvidia-cudnn-cu12==9.*\"）"
fi

# ── ② 生成要追加的配置块
BLOCK="$(cat <<EOF
$MARK_BEGIN
# Python 环境：识别进程靠 PATH 里的 python 起，所以必须激活（Ubuntu 只有 python3）
source $VENV/bin/activate

# 模型缓存与下载源（换机器时最容易忘；定好别改）
export HF_HOME=$MODELS
export HF_ENDPOINT=https://hf-mirror.com
export HF_HUB_DISABLE_XET=1

# Python 输出编码（不设会让识别结果变乱码）
export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

# 大脑（scripts/harness-side.mjs）要用的 DSH 检出
export DSH_CHECKOUT=$DSH

# cu12 运行库（ctranslate2 要 libcublas.so.12 / libcudnn*_9）
if [ -s $LD_FILE ]; then
  export LD_LIBRARY_PATH="\$(cat $LD_FILE)\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"
fi

# 数据目录：生产默认；测测试环境就在当前 shell 里覆盖
export LEION_DATA_DIR=$DATA

# 便捷别名
alias leion='cd $REPO'
alias leion-up='$REPO/start-leion.sh'
alias leion-test='$REPO/start-leion.sh /var/lib/leion/test 8789'
alias leion-doctor='node $REPO/scripts/preflight.cjs --data-dir "\$LEION_DATA_DIR"'
alias leion-check='python3 $REPO/scripts/check-relay.py --data-dir "\$LEION_DATA_DIR"'
alias leion-say='python3 $REPO/scripts/check-relay.py --data-dir "\$LEION_DATA_DIR" --say "这是一条测试信息"'
$MARK_END
EOF
)"

# ── ③ 打印 / 写入
RC="$HOME/.bashrc"
say ""
say "── 将要写入 $RC 的配置块 ─────────────────────────────"
say "$BLOCK"
say "──────────────────────────────────────────────────────"

if [ "$APPLY" -ne 1 ]; then
  say ""
  say "演练模式：什么都没改。确认无误后执行： bash $0 --apply"
  exit 0
fi

touch "$RC"
# 旧块存在就先删掉（连同标记），再追加新的 —— 保证可重复执行
if grep -qF "$MARK_BEGIN" "$RC"; then
  cp "$RC" "$RC.bak.$(date +%Y%m%d-%H%M%S)"
  awk -v b="$MARK_BEGIN" -v e="$MARK_END" '
    $0 == b { skip = 1; next }
    $0 == e { skip = 0; next }
    skip != 1 { print }
  ' "$RC" > "$RC.tmp"
  mv "$RC.tmp" "$RC"
  say "已移除旧的 leion 配置块（备份留在 $RC.bak.*）"
fi
printf '\n%s\n' "$BLOCK" >> "$RC"
say "✅ 已写入 $RC（重新登录或 exec bash 生效）"

# ── ④ 启动脚本（一起生成，免得手抄参数抄错）
START="$REPO/start-leion.sh"
cat > "$START" <<EOF
#!/usr/bin/env bash
# 启动整条链路。用法： ./start-leion.sh [数据目录] [端口]
set -e
cd "$REPO"
DATA="\${1:-\$LEION_DATA_DIR}"
PORT="\${2:-8788}"
exec node scripts/start-all.mjs --public \\
  --data-dir "\$DATA" --port "\$PORT" \\
  --whisper-model large-v3 --compute int8_float32
EOF
chmod +x "$START"
say "✅ 已生成启动脚本：$START"

say ""
say "── 接下来验证（先 exec bash 或重开终端）───────────────"
say "  python --version                     # 应为 3.10.12（venv 生效）"
say "  echo \$LD_LIBRARY_PATH                # 应显示 .../nvidia/cublas/lib:..."
say "  node --version                       # 应为 v22+"
say "  echo \$LEION_DATA_DIR                 # /var/lib/leion/live"
say "  leion-doctor                         # 六项体检"
say "  leion-say                            # 塞一句话等译文（大脑链路）"
say "  leion-up                             # 启动整条链路"
say ""
say "常驻运行（systemd）不读 .bashrc，见 docs/10 §6："
say "  sudo python3 $REPO/scripts/make-env-file.py $VENV --hf-home $MODELS --out /etc/leion/asr.env"
