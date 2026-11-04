#!/usr/bin/env bash
# asr-cloud-env.example.sh —— 云端引擎环境变量的**模板**（5.94）
# ============================================================================
#
# 这个文件**不含任何密钥**，可以直接进仓库。真正的值放在服务器上的
# `/var/lib/leion/<环境>/secrets/*.env`（chmod 600），由运维自己填。
#
# 为什么要把密钥放文件而不是写在启动命令里：
#   · 环境变量会进 shell history、systemd 单元文件，`ps` 里也看得见；
#   · 一个 chmod 600 的文件只有该用户能读，排障时也不会被截图带出去；
#   · 换账号只改这一个文件，不用改任何命令或代码。
#
# 用法（服务器上）：
#   bash asr-cloud-env.sh            # 写入并生效，然后打印体检结果
#   bash asr-cloud-env.sh --check    # 只检查现在的环境变量齐不齐，不写文件
#
# ⚠️ 三个引擎各自需要什么（缺哪个 doctor 会直接说）：
#   funasr   : DASHSCOPE_API_KEY + DASHSCOPE_WS_URL（**账号专属域名**，不是公共 dashscope.aliyuncs.com）
#   tencent  : TENCENT_ASR_SECRET_ID + TENCENT_ASR_SECRET_KEY（可选 TENCENT_ASR_REGION）
#   parakeet : 不需要密钥；onnx 路只要模型目录（PARAKEET_MODEL_DIR 或策略里的 model）

set -euo pipefail

DATA_DIR="${LEION_DATA_DIR:-/var/lib/leion/test}"
SECRET_DIR="$DATA_DIR/secrets"
ENV_FILE="$SECRET_DIR/cloud.env"

if [ "${1:-}" = "--check" ]; then
  echo "当前环境变量："
  for name in DASHSCOPE_API_KEY DASHSCOPE_WS_URL DASHSCOPE_WS_URL \
              TENCENT_ASR_SECRET_ID TENCENT_ASR_SECRET_KEY PARAKEET_MODEL_DIR; do
    value="$(printenv "$name" || true)"
    if [ -n "$value" ]; then
      # ⚠️ 只打印长度与前 4 位，绝不打印完整密钥
      echo "  ✓ $name：长度 ${#value}（${value:0:4}…）"
    else
      echo "  ✗ $name：未设置"
    fi
  done
  exit 0
fi

mkdir -p "$SECRET_DIR"
chmod 700 "$SECRET_DIR"

# 在这里填真实值（**别把填好的版本提交进仓库**）
cat > "$ENV_FILE" <<'ENVEOF'
DASHSCOPE_API_KEY=替换成你的-key
DASHSCOPE_WS_URL=wss://ws-替换成你的.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference
TENCENT_ASR_SECRET_ID=
TENCENT_ASR_SECRET_KEY=
TENCENT_ASR_REGION=ap-shanghai
ENVEOF

chmod 600 "$ENV_FILE"
echo "已写 $ENV_FILE（权限 600）"

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
echo "已导入当前 shell（只对新开的进程有效；要持久写进 systemd 的 Environment= 或 ~/.bashrc）"
echo ""
echo "下一步："
echo "  cd ~/glasses && node scripts/asr-doctor.mjs --data-dir $DATA_DIR | grep -E 'funasr|tencent|parakeet'"
