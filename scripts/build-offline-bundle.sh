#!/usr/bin/env bash
# 构建离线安装包（v0.6.0 C4）：把仓库打包成**零外网依赖**的投递物，供内网/air-gap 环境使用。
#
# 用法：
#   bash scripts/build-offline-bundle.sh [版本号] [输出目录]
#
# 产出：
#   <输出目录>/mingdao-offline-<版本>.tar.gz   解压即用（含 install.sh 与全部源码）
#   <输出目录>/mingdao-offline-<版本>.sha256   校验值（内网投放前核对）
#
# 为什么打包整个仓库而不是 npm 包：本项目**运行时零依赖**，源码即产物；用户拿到 tarball 后
# 解压 → `bash install.sh --offline` 即可，全程不访问 registry 与任何外部地址。
#
# ⚠ 离线包**不含 Node.js 运行时**（几十 MB，且各内网基线不同）。要求：内网预装 Node ≥ 18.17。
#   Windows 另见 install.ps1。这一点必须写进投递说明，否则内网部署会卡在这一步。
set -euo pipefail
cd "$(dirname "$0")/.."

V="${1:-$(node -p "require('./package.json').version")}"
OUT="${2:-dist}"
NAME="mingdao-offline-$V"
STAGE="$(mktemp -d)"
mkdir -p "$OUT"

echo "== 构建离线包 $NAME =="
# 只带走运行时需要的东西：源码 + 随包资源 + 安装脚本 + 文档。
# 刻意排除：.git（离线升级靠重新投放，不靠 git）、node_modules（零运行时依赖）、
# desktop/（桌面版是另一条分发链，体积大且与内网部署无关）、dist/ 自身。
mkdir -p "$STAGE/$NAME"
for item in src skills skills-lib presets packs assets docs package.json package-lock.json \
            install.sh install.ps1 install.bat README.md LICENSE CHANGELOG.md RELEASE-NOTES-*.md; do
  [ -e "$item" ] || continue
  cp -R "$item" "$STAGE/$NAME/"
done

# 投递说明：内网现场的人需要知道前置条件，而不是解压后猜
cat > "$STAGE/$NAME/离线安装说明.md" <<'NOTE'
# 离线（内网 / air-gap）安装说明

## 前置条件
- **Node.js ≥ 18.17** —— 离线包**不含** Node 运行时，请先用内网源/离线介质装好。
  验证：`node --version`
- 无需 npm、无需访问任何外部地址。本项目运行时**零依赖**。

## 安装
```bash
tar -xzf mingdao-offline-<版本>.tar.gz
cd mingdao-offline-<版本>
bash install.sh --offline
```
安装脚本会**跳过 npm**（直接软链到 ~/.local/bin），并把 `mingdao` / `mdh` 放到 PATH。
若提示加入 PATH，按提示在 `~/.bashrc` 或 `~/.zshrc` 追加。

验证：`mingdao --version`

## Windows
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Offline
```
（Windows 侧同样是离线路径：不通过 winget 装 Node、不走 npm，改用用户目录下的 .cmd 包装。）

## 内网模型（信创 / 国产推理栈）
内网通常没有公网模型 API。用 OpenAI 兼容端点（vLLM / Ollama / OneAPI / TGI / 国产推理栈）：
```bash
mingdao key set custom           # 或直接编辑 ~/.mingdao/config.json
```
```json
{ "model": "<内网模型名>",
  "providers": { "<内网模型名>": { "provider": "custom", "baseUrl": "http://10.0.0.9:8000/v1" } } }
```
ollama / vllm 等预设见 `mingdao init` 的服务商列表。

## 出网白名单（可选，用于自证「数据不出门」）
```json
{ "net": { "allow": ["10.0.0.0/8"], "mode": "block" } }
```
之后 `mingdao net report` 可导出本机访问过的外部地址。
注意其边界：只覆盖**内核自己发起**的请求；用户在 bash 里自己敲的 `curl` 不在其列。

## 已知限制（请如实转达）
- 离线模式**不支持 `mingdao update` 自更新**（没有 .git，升级需重新投放离线包）。
- 桌面版安装包（Windows/macOS/Linux GUI）是**另一条分发链**，不在本离线包内。
NOTE

# 打包参数分两套：GNU tar（Linux/CI）额外固定 mtime 与属主，使同一份源码产出**可复现**的哈希；
# bsdtar（macOS 自带）不支持 --sort/--mtime，只能常规打包——此时 sha256 仍是**传输完整性**校验
# （够内网核对「收到的包没坏、没被改」），但不保证跨机可复现。这一点如实写出来，不假装都一样。
if tar --version 2>/dev/null | head -1 | grep -qi 'gnu tar'; then
  tar --sort=name --mtime='UTC 2020-01-01' --owner=0 --group=0 --numeric-owner \
      -czf "$OUT/$NAME.tar.gz" -C "$STAGE" "$NAME"
  echo "   （GNU tar：已固定 mtime/属主，产物哈希可复现）"
else
  tar -czf "$OUT/$NAME.tar.gz" -C "$STAGE" "$NAME"
  echo "   （bsdtar：哈希用于传输完整性校验，跨机不可复现——如实标注）"
fi
rm -rf "$STAGE"

if command -v sha256sum >/dev/null 2>&1; then
  ( cd "$OUT" && sha256sum "$NAME.tar.gz" > "$NAME.sha256" )
else
  ( cd "$OUT" && shasum -a 256 "$NAME.tar.gz" > "$NAME.sha256" )
fi

echo "✓ $OUT/$NAME.tar.gz  ($(du -h "$OUT/$NAME.tar.gz" | cut -f1))"
echo "✓ $OUT/$NAME.sha256  $(cut -d' ' -f1 < "$OUT/$NAME.sha256")"
echo
echo "投放后在内网执行："
echo "  tar -xzf $NAME.tar.gz && cd $NAME && bash install.sh --offline"
