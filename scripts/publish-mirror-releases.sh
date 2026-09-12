#!/usr/bin/env bash
# 镜像平台发版（gitee + gitcode）：为指定版本创建 Release 并上传官网同源安装包附件。
# 用法：
#   MINGDAO_GITEE_TOKEN=xxx MINGDAO_GITCODE_TOKEN=yyy bash scripts/publish-mirror-releases.sh 0.1.65 [备注文件.md]
#
# 发行政策（2026-09-11，负责人确认）：**三平台都建 Release，但附件只留在 GitHub**。
#   · GitHub Release：保留全部安装包附件（长期保留，不再清理）；
#   · gitee / gitcode：只创建 Release（正文指向官网 https://harness.mingdao.ai/#downloads），
#     **不上传附件**——国内用户走官网直连，避免 gitee 配额与数小时的上传耗时。
# 如需恢复附件上传：MIRROR_WITH_ATTACH=1。
#
# ⚠ 若启用附件上传需知道：gitee 附件单文件上限 100MB，而 AppImage 通常 >100MB 会被拒。
#   本脚本对附件**逐个文件**判断大小，超限的跳过并在结尾清单里写明（不让整轮上传失败）。
#
# 前置条件：
#   1. 官网服务器 /opt/1panel/www/sites/mingdao-site/downloads/ 已有该版本的 7 个安装包（收割流程产出）
#   2. gitee / gitcode 仓库已有对应 tag（本脚本会强制推送本地同名 tag，与 GitHub 发布 commit 对齐）
#
# 说明：token 只从环境变量读取，绝不写入仓库文件。上传限速约 50–100KB/s（gitee/服务器带宽），
# 7 个包约 640MB，两平台并行约需 3–5 小时，脚本在服务器后台运行：nohup ... & 并 tail /tmp/mirror-release-$V.log
# 已知限制：gitee 附件单文件上限 100MB（AppImage 108.6MB 会被拒）——发布文案需自带官网直连链接兜底。
set -euo pipefail
V="${1:?用法: publish-mirror-releases.sh <版本号> [备注文件]}"
NOTES="${2:-}"
GITEE_TOKEN="${MINGDAO_GITEE_TOKEN:-}"
GITCODE_TOKEN="${MINGDAO_GITCODE_TOKEN:-}"
[ -n "$GITEE_TOKEN" ] || { echo "缺少 MINGDAO_GITEE_TOKEN"; exit 1; }
[ -n "$GITCODE_TOKEN" ] || { echo "缺少 MINGDAO_GITCODE_TOKEN"; exit 1; }

TAG="v$V"
DL="/opt/1panel/www/sites/mingdao-site/downloads"
FILES="mingdao-setup-$V-x64.exe mingdao-$V-amd64.deb mingdao-$V-arm64.dmg mingdao-$V-x64.dmg mingdao-$V-x86_64.AppImage mingdao-$V-arm64-mac.zip mingdao-$V-x64-mac.zip"

# 发行版标题：从 CHANGELOG 的 `## vX.Y.Z（日期）— 描述` 取「vX.Y.Z 描述」。
# 此前标题被直接设成 tag（如 "v0.6.1"），于是 Gitee/GitCode 的发行版只剩一个裸版本号：
# 在仓库首页「发行版」组件和发行版列表里，用户只看到一个 v0.6.1，看不出这版干了什么。
# 而 v0.4.4 及更早是有描述的——那时是在 Gitee 网页上手工建、标题照抄 CHANGELOG。
# 首页组件本来就不会渲染「最新版」徽标（那是 Gitee 平台行为，对比其它仓库同样如此），
# 所以标题就是唯一能让人读懂的信息，别再退化成裸版本号。
rel_name() {
  python3 - "$1" <<'PY'
import re, sys
v = sys.argv[1]
try:
    t = open('CHANGELOG.md', encoding='utf8').read()
except OSError:
    print('v' + v); raise SystemExit
m = re.search(r'^## v' + re.escape(v) + r'[^\n]*', t, re.M)
if not m:
    print('v' + v); raise SystemExit
line = re.sub(r'^## ', '', m.group(0))
line = re.sub(r'（\d{4}-\d{2}-\d{2}）', '', line)   # 只去掉日期那个括号。不能写成
                                                    # （[^）]*）——那会把「（补丁版）」
                                                    # 「（确定性③）」等真描述一起吃掉
line = re.sub(r'\s*—\s*', ' ', line).strip()        # 长破折号换成空格
print(line)
PY
}
NAME="$(rel_name "$V")"
echo "发行版标题：$NAME"

# 1) 同步**分支与** tag（与 GitHub 同 commit）
#
# **分支必须一起推。** 只推 tag 的话镜像的 main 会停在旧提交，用户在 gitee/gitcode
# 上看到的仍是过期代码——RELEASE-CHECKLIST §3.0 ② 记的就是这个坑，而 2026-09-12 又犯了
# 一次：GitHub 的 main 到了 d986d1c，两个镜像却还停在 f6b7d92 的
# "chore: release v0.6.1"。原因是本脚本当时只推 tag，且本机没配 gitee/gitcode 两个
# remote（只有 origin），于是 `git push origin main` 之后镜像毫无变化。
#
# 前置（一次性，SSH，不需要 token）：
#   git remote add gitee   git@gitee.com:MingDaoTCM/MingDao-Harness.git
#   git remote add gitcode git@gitcode.com:MingDaoTCM/MingDao-Harness.git
for R in gitee gitcode; do
  git remote get-url "$R" >/dev/null 2>&1 || { echo "✗ 未配置 remote $R——按上面注释加好再跑（否则镜像分支会停在旧提交）"; exit 1; }
done
git push gitee main:main
git push gitcode main:main
git push gitee "$TAG" --force
git push gitcode "$TAG" --force

# 1b) 对齐自证：三平台 main 必须是同一个 commit（不一致就别继续发版）
echo "== main 对齐检查 =="
LOCAL_SHA="$(git rev-parse main)"
ALIGN_OK=1
for R in origin gitee gitcode; do
  git remote get-url "$R" >/dev/null 2>&1 || continue
  REMOTE_SHA="$(git ls-remote "$R" refs/heads/main 2>/dev/null | cut -f1)"
  if [ "$REMOTE_SHA" = "$LOCAL_SHA" ]; then
    echo "  ✓ $R ${LOCAL_SHA:0:8}"
  else
    echo "  ✗ $R ${REMOTE_SHA:0:8}（本地 ${LOCAL_SHA:0:8}）"
    ALIGN_OK=0
  fi
done
[ "$ALIGN_OK" = "1" ] || { echo "✗ 三平台 main 未对齐，先修好再发版"; exit 1; }

# 2) 发布文案（默认取仓库 RELEASE-NOTES，或用指定文件）
BODY="${NOTES:-RELEASE-NOTES-$V.md}"
[ -f "$BODY" ] || { echo "找不到发布文案 $BODY"; exit 1; }
scp -q "$BODY" mingdao-server:/tmp/mirror-release-$V-body.md
BODY="/tmp/mirror-release-$V-body.md"

cat > /tmp/mirror-release-$V.sh <<'INNER'
#!/bin/bash
set -uo pipefail
V="$1"; TAG="v$1"; BODY="$2"
GITEE_TOKEN="$3"; GITCODE_TOKEN="$4"; NAME="$5"
DL="/opt/1panel/www/sites/mingdao-site/downloads"
FILES="mingdao-setup-$V-x64.exe mingdao-$V-amd64.deb mingdao-$V-arm64.dmg mingdao-$V-x64.dmg mingdao-$V-x86_64.AppImage mingdao-$V-arm64-mac.zip mingdao-$V-x64-mac.zip"

echo "== gitee release =="
GID=$(curl -s -X POST "https://gitee.com/api/v5/repos/MingDaoTCM/MingDao-harness/releases?access_token=$GITEE_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(python3 -c 'import json,sys;print(json.dumps({"tag_name":sys.argv[1],"name":sys.argv[3],"body":open(sys.argv[2]).read(),"target_commitish":"main"}))' "$TAG" "$BODY" "$NAME")" \
  | python3 -c 'import json,sys;print(json.load(sys.stdin).get("id",""))')
echo "gitee release id=$GID"
[ -n "$GID" ] || { echo "gitee 创建失败"; exit 1; }

echo "== gitcode release =="
curl -s -X POST "https://api.gitcode.com/api/v5/repos/MingDaoTCM/MingDao-Harness/releases" \
  -H "Content-Type: application/json" -H "private-token: $GITCODE_TOKEN" \
  -d "$(python3 -c 'import json,sys;print(json.dumps({"tag_name":sys.argv[1],"name":sys.argv[3],"body":open(sys.argv[2]).read(),"target_commitish":"main"}))' "$TAG" "$BODY" "$NAME")" \
  -o /tmp/gc-rel.json -w "gitcode http=%{http_code}\n"
grep -q tag_name /tmp/gc-rel.json || { echo "gitcode 创建失败"; head -c 300 /tmp/gc-rel.json; exit 1; }

# 附件上传：默认**关闭**（发行政策 2026-09-11：附件只留在 GitHub，gitee/gitcode 只建 Release）
if [ "${MIRROR_WITH_ATTACH:-0}" != "1" ]; then
  echo "已跳过附件上传（政策：附件只留在 GitHub Release；官网直连分发。MIRROR_WITH_ATTACH=1 可恢复）"
  echo "MIRROR_RELEASE_DONE $TAG"
  exit 0
fi

# gitee 单文件上限 100MB：超限的跳过（否则整轮上传会中断），并把跳过原因记进结尾清单
GITEE_MAX=$((100 * 1024 * 1024))
SKIPPED_GITEE=""
for f in $FILES; do
  [ -f "$DL/$f" ] || { echo "== gitee 跳过 $f（文件不存在）"; SKIPPED_GITEE="$SKIPPED_GITEE $f(缺失)"; continue; }
  sz=$(stat -c%s "$DL/$f" 2>/dev/null || stat -f%z "$DL/$f")
  if [ "$sz" -gt "$GITEE_MAX" ]; then
    echo "== gitee 跳过 $f（$((sz/1024/1024))MB 超过 gitee 100MB 附件上限）"
    SKIPPED_GITEE="$SKIPPED_GITEE $f(超限)"
    continue
  fi
  echo "== gitee attach $f ($((sz/1024/1024))MB)"
  curl -s --connect-timeout 30 --max-time 3600 -X POST \
    "https://gitee.com/api/v5/repos/MingDaoTCM/MingDao-harness/releases/$GID/attach_files?access_token=$GITEE_TOKEN" \
    -F "file=@$DL/$f" -o /tmp/up.json -w "http=%{http_code} bytes=%{size_upload} time=%{time_total}s\n"
  head -c 150 /tmp/up.json; echo
done
[ -n "$SKIPPED_GITEE" ] && echo "gitee 未上传（请以官网为准）：$SKIPPED_GITEE"

# gitcode 附件（upload_url + OBS PUT）
for f in $FILES; do
  [ -f "$DL/$f" ] || { echo "== gitcode 跳过 $f（文件不存在）"; continue; }
  echo "== gitcode attach $f"
  python3 - "$f" "$GITCODE_TOKEN" "$DL" "$TAG" <<'PY'
import json, os, sys, urllib.request
name, token, dl, tag = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
api = f"https://api.gitcode.com/api/v5/repos/MingDaoTCM/MingDao-Harness/releases/{tag}/upload_url"
rq = urllib.request.Request(f"{api}?file_name={name}", headers={"private-token": token})
with urllib.request.urlopen(rq, timeout=60) as r:
    meta = json.loads(r.read().decode())
path = os.path.join(dl, name)
size = os.path.getsize(path)
hdr = {k: v for k, v in (meta.get("headers") or {}).items()}
hdr["Content-Length"] = str(size)
with open(path, "rb") as fh:
    rq = urllib.request.Request(meta["url"], data=fh, method="PUT", headers=hdr)
    with urllib.request.urlopen(rq, timeout=3600) as r:
        print("  PUT", r.status, r.read().decode(errors="replace")[:200])
PY
done
echo "MIRROR_RELEASE_DONE $TAG"
INNER
chmod +x /tmp/mirror-release-$V.sh
echo "上传脚本已生成 /tmp/mirror-release-$V.sh —— 在服务器运行："
echo "  ssh mingdao-server 'nohup bash /tmp/mirror-release-$V.sh \"$V\" \"$BODY\" \"$GITEE_TOKEN\" \"$GITCODE_TOKEN\" \"$NAME\" > /tmp/mirror-release-$V.log 2>&1 &'"
