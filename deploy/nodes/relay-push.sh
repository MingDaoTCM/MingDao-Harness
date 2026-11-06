#!/bin/bash
# 本机 → 深圳中转 → 香港源站（v0.6.39 起的标准产物搬运方式）
#
# 为什么需要：本机（国内）到香港源站的上行实测只有 ~110KB/s，500MB 要 75 分钟；
# 而本机→深圳 8.4MB/s、深圳→香港 14MB/s，同一批文件走中转只要 2–3 分钟。
# 这不是"网络玄学"：国内→香港的国际段被限速，而国内→国内、国内→香港（同云商内网/优质线路）都快。
#
# 用法：
#   bash deploy/nodes/relay-push.sh <本地目录> <远端相对子目录> [--verify]
# 例：
#   bash deploy/nodes/relay-push.sh /tmp/hv-0639 downloads --verify
#
# 依赖：本机到深圳的密钥（~/.ssh/mdh-sz 或用 RELAY_KEY 指定）、深圳到香港的免密（id_ed25519_hk，已配置）。
set -euo pipefail
SRC=${1:?用法: relay-push.sh <本地目录> <远端子目录> [--verify]}
SUB=${2:?远端子目录（例如 downloads 或 updates）}
VERIFY=${3:-}

SZ_HOST=${SZ_HOST:-root@47.115.136.85}
SZ_KEY=${RELAY_KEY:-/tmp/mdh-sz.pem}
HK_HOST=${HK_HOST:-8.210.103.117}
HK_DIR=${HK_DIR:-/opt/1panel/www/sites/mingdao-site}
STAGE=/tmp/mdh-relay-$$

echo "① 本机 → 深圳（${SZ_HOST}:${STAGE}）"
ssh -i "$SZ_KEY" -o StrictHostKeyChecking=no "$SZ_HOST" "mkdir -p $STAGE"
scp -q -i "$SZ_KEY" -o StrictHostKeyChecking=no -o ServerAliveInterval=20 "$SRC"/* "$SZ_HOST:$STAGE/"
echo "   已上传 $(ssh -i "$SZ_KEY" -o StrictHostKeyChecking=no "$SZ_HOST" "ls $STAGE | wc -l") 个文件"

echo "② 深圳 → 香港（${HK_HOST}:${HK_DIR}/${SUB}）"
ssh -i "$SZ_KEY" -o StrictHostKeyChecking=no "$SZ_HOST" \
  "scp -q -o StrictHostKeyChecking=no -o ServerAliveInterval=20 -i /root/.ssh/id_ed25519_hk $STAGE/* root@$HK_HOST:$HK_DIR/$SUB/"

if [ "$VERIFY" = "--verify" ]; then
  echo "③ 逐文件 size+sha256 复核（深圳 ↔ 香港）"
  ssh -i "$SZ_KEY" -o StrictHostKeyChecking=no "$SZ_HOST" \
    "cd $STAGE && sha256sum * | sort -k2" > /tmp/relay-src.sha
  ssh -i "$SZ_KEY" -o StrictHostKeyChecking=no "$SZ_HOST" \
    "ssh -o StrictHostKeyChecking=no -i /root/.ssh/id_ed25519_hk root@$HK_HOST 'cd $HK_DIR/$SUB && sha256sum * | sort -k2'" > /tmp/relay-dst.sha
  if diff -q /tmp/relay-src.sha /tmp/relay-dst.sha >/dev/null; then
    echo "   ✓ 全部一致（$(wc -l < /tmp/relay-src.sha | tr -d ' ') 个文件）"
  else
    echo "   ✗ 有不一致："; diff /tmp/relay-src.sha /tmp/relay-dst.sha | head -10; exit 1
  fi
fi

ssh -i "$SZ_KEY" -o StrictHostKeyChecking=no "$SZ_HOST" "rm -rf $STAGE"
echo "✓ 完成：$SRC → 香港 $SUB"
