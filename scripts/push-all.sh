#!/usr/bin/env bash
# 三平台同步推送（GitHub / Gitee / GitCode）——**日常提交也要用这个**，不要只推 origin。
#
# 起因（2026-09-21 负责人报障）：「三平台不同步，github 是 5dc7739，gitee/gitcode 是 b0c872c」。
# 排查结论：发版脚本 `publish-mirror-releases.sh` 只在**发版时**把分支与 tag 推到镜像，
# 而发版之后的日常提交（批十那次）只推了 origin —— 镜像的 main 就静静停在上一版，
# 用户从 gitee/gitcode 克隆到的是过期代码。这正是 RELEASE-CHECKLIST §3.0 ② 记过的同一类问题：
# 「文档约束不住流程，脚本才能」。所以把「推 main」这件事也收进脚本。
#
# 用法：
#   bash scripts/push-all.sh              # 推 main 到三平台并核对 SHA
#   bash scripts/push-all.sh v0.6.5       # 额外推一个 tag（仍是三平台）
#
# 行为：逐个 remote 推送；任一失败即以非 0 退出；最后逐个核对远端 main 的 SHA 与本地一致，
# 不一致同样非 0（避免"推了一半"）。
set -uo pipefail
cd "$(dirname "$0")/.."

REMOTES=(origin gitee gitcode)
REF_EXTRA="${1:-}"

LOCAL_MAIN="$(git rev-parse main)"
echo "本地 main = ${LOCAL_MAIN:0:8}"

fail=0
for r in "${REMOTES[@]}"; do
  git remote get-url "$r" >/dev/null 2>&1 || { echo "✗ 未配置 remote $r（见 RELEASE-CHECKLIST §3.0 ②的一次性准备）"; fail=1; continue; }
  echo "== 推送 $r =="
  if ! git push "$r" main:main; then
    echo "✗ $r 推送失败"
    fail=1
  fi
  if [ -n "$REF_EXTRA" ]; then
    git push "$r" "$REF_EXTRA" || { echo "✗ $r 推 tag $REF_EXTRA 失败"; fail=1; }
  fi
done

echo "== 对齐核对（远端 main 必须等于本地）=="
for r in "${REMOTES[@]}"; do
  git remote get-url "$r" >/dev/null 2>&1 || continue
  remote_sha="$(git ls-remote "$r" refs/heads/main 2>/dev/null | cut -f1)"
  if [ "$remote_sha" = "$LOCAL_MAIN" ]; then
    echo "  ✓ $r ${LOCAL_MAIN:0:8}"
  else
    echo "  ✗ $r ${remote_sha:0:8}（本地 ${LOCAL_MAIN:0:8}）"
    fail=1
  fi
done

[ "$fail" = "0" ] || { echo "✗ 三平台未对齐，别当成推完了"; exit 1; }
echo "✓ 三平台 main 已对齐 ${LOCAL_MAIN:0:8}"
