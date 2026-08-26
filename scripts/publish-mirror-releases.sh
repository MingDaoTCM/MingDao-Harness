#!/usr/bin/env bash
# 镜像平台发版（gitee + gitcode）：为指定版本创建 Release 并上传官网同源安装包附件。
# 用法：
#   MINGDAO_GITEE_TOKEN=xxx MINGDAO_GITCODE_TOKEN=yyy bash scripts/publish-mirror-releases.sh 0.1.65 [备注文件.md]
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

# 1) 同步 tag（与 GitHub 同 commit）
git push gitee "$TAG" --force
git push gitcode "$TAG" --force

# 2) 发布文案（默认取仓库 RELEASE-NOTES，或用指定文件）
BODY="${NOTES:-RELEASE-NOTES-$V.md}"
[ -f "$BODY" ] || { echo "找不到发布文案 $BODY"; exit 1; }
scp -q "$BODY" mingdao-server:/tmp/mirror-release-$V-body.md
BODY="/tmp/mirror-release-$V-body.md"

cat > /tmp/mirror-release-$V.sh <<'INNER'
#!/bin/bash
set -uo pipefail
V="$1"; TAG="v$1"; BODY="$2"
GITEE_TOKEN="$3"; GITCODE_TOKEN="$4"
DL="/opt/1panel/www/sites/mingdao-site/downloads"
FILES="mingdao-setup-$V-x64.exe mingdao-$V-amd64.deb mingdao-$V-arm64.dmg mingdao-$V-x64.dmg mingdao-$V-x86_64.AppImage mingdao-$V-arm64-mac.zip mingdao-$V-x64-mac.zip"

echo "== gitee release =="
GID=$(curl -s -X POST "https://gitee.com/api/v5/repos/MingDaoTCM/MingDao-harness/releases?access_token=$GITEE_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(python3 -c 'import json,sys;print(json.dumps({"tag_name":sys.argv[1],"name":sys.argv[1]+" 修复版重建","body":open(sys.argv[2]).read(),"target_commitish":"main"}))' "$TAG" "$BODY")" \
  | python3 -c 'import json,sys;print(json.load(sys.stdin).get("id",""))')
echo "gitee release id=$GID"
[ -n "$GID" ] || { echo "gitee 创建失败"; exit 1; }

echo "== gitcode release =="
curl -s -X POST "https://api.gitcode.com/api/v5/repos/MingDaoTCM/MingDao-Harness/releases" \
  -H "Content-Type: application/json" -H "private-token: $GITCODE_TOKEN" \
  -d "$(python3 -c 'import json,sys;print(json.dumps({"tag_name":sys.argv[1],"name":sys.argv[1]+" 修复版重建","body":open(sys.argv[2]).read(),"target_commitish":"main"}))' "$TAG" "$BODY")" \
  -o /tmp/gc-rel.json -w "gitcode http=%{http_code}\n"
grep -q tag_name /tmp/gc-rel.json || { echo "gitcode 创建失败"; head -c 300 /tmp/gc-rel.json; exit 1; }

# gitee 附件（curl 逐个上传）
for f in $FILES; do
  echo "== gitee attach $f"
  curl -s --connect-timeout 30 --max-time 3600 -X POST \
    "https://gitee.com/api/v5/repos/MingDaoTCM/MingDao-harness/releases/$GID/attach_files?access_token=$GITEE_TOKEN" \
    -F "file=@$DL/$f" -o /tmp/up.json -w "http=%{http_code} bytes=%{size_upload} time=%{time_total}s\n"
  head -c 150 /tmp/up.json; echo
done

# gitcode 附件（upload_url + OBS PUT）
for f in $FILES; do
  echo "== gitcode attach $f"
  python3 - "$f" "$GITCODE_TOKEN" "$DL" <<'PY'
import json, os, sys, urllib.request
name, token, dl = sys.argv[1], sys.argv[2], sys.argv[3]
api = "https://api.gitcode.com/api/v5/repos/MingDaoTCM/MingDao-Harness/releases/v0.1.65/upload_url"
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
echo "  ssh mingdao-server 'nohup bash /tmp/mirror-release-$V.sh \"$V\" \"$BODY\" \"$GITEE_TOKEN\" \"$GITCODE_TOKEN\" > /tmp/mirror-release-$V.log 2>&1 &'"
