#!/usr/bin/env bash
# MingDao 桌面集成安装（Linux）：桌面图标 + 可选开机自启（双击即用，无需浏览器手动开）
# 用法：bash install-desktop.sh [--autostart]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$HOME/.local/share/applications" "$HOME/.local/share/icons/hicolor/scalable/apps"
cp "$SCRIPT_DIR/mingdao-web.desktop" "$HOME/.local/share/applications/mingdao-web.desktop"
if [ -f "$SCRIPT_DIR/../../src/web/icon.svg" ]; then
  cp "$SCRIPT_DIR/../../src/web/icon.svg" "$HOME/.local/share/icons/hicolor/scalable/apps/mingdao.svg"
fi
chmod +x "$HOME/.local/share/applications/mingdao-web.desktop"
echo "✓ 桌面图标已安装（应用菜单搜索 MingDao）"

if [ "${1:-}" = "--autostart" ]; then
  mkdir -p "$HOME/.config/autostart"
  cp "$SCRIPT_DIR/mingdao-web.desktop" "$HOME/.config/autostart/mingdao-web.desktop"
  echo "✓ 已加入开机自启（登录后自动启动服务器）"
fi
echo "提示：双击图标会启动 mingdao web 并打开 http://127.0.0.1:3820；改端口请编辑 desktop 文件中的 3820。"
