#!/usr/bin/env bash
# MingDao-Harness 一键安装脚本
# 用法：bash install.sh
# 功能：检查/自动安装 Node.js（通过 nvm）→ 安装 mingdao 命令（全局或用户目录）→ 提示初始化
set -euo pipefail

GREEN='\033[32m'; YELLOW='\033[33m'; RED='\033[31m'; NC='\033[0m'
info(){ echo -e "${GREEN}[MingDao]${NC} $*"; }
warn(){ echo -e "${YELLOW}[警告]${NC} $*"; }
die(){ echo -e "${RED}[错误]${NC} $*" >&2; exit 1; }

# Windows 环境（Git Bash / MSYS）应改用 PowerShell 安装器
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*)
    warn "检测到 Windows 环境，请改用 Windows 安装器："
    echo "    双击 install.bat，或运行："
    echo "    powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1"
    exit 0
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ---------- 1. 检查 Node.js >= 18.17 ----------
need_node() {
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [ "$major" -ge 18 ]; then return 0; fi
    warn "检测到 Node.js $(node -p 'process.versions.node' 2>/dev/null)，需要 >= 18.17"
    return 1
  fi
  return 1
}

install_node() {
  info "未找到合适的 Node.js，尝试通过 nvm 自动安装…"
  if ! command -v curl >/dev/null 2>&1; then
    die "缺少 curl，无法自动安装。请手动安装 Node.js 18+（https://nodejs.org）后重新运行本脚本。"
  fi
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  # shellcheck disable=SC1090
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  if ! command -v nvm >/dev/null 2>&1; then
    die "nvm 安装失败，请手动安装 Node.js：https://nodejs.org"
  fi
  nvm install 20 >/dev/null || nvm install --lts
  nvm use 20 2>/dev/null || true
  info "Node.js 已就绪：$(node --version)"
}

if ! need_node; then install_node; fi
if ! need_node; then die "Node.js 版本检查失败。"; fi

# ---------- 2. 安装 mingdao 命令 ----------
info "安装 mingdao 命令…"
if npm install -g . >/dev/null 2>&1; then
  info "已全局安装（npm -g）"
else
  warn "全局安装失败（可能没有管理员权限），改为安装到用户目录…"
  mkdir -p "$HOME/.mingdao"
  rm -rf "$HOME/.mingdao/app"
  cp -r "$SCRIPT_DIR" "$HOME/.mingdao/app"
  rm -rf "$HOME/.mingdao/app/node_modules" "$HOME/.mingdao/app/.git"
  mkdir -p "$HOME/.local/bin"
  ln -sf "$HOME/.mingdao/app/src/cli.js" "$HOME/.local/bin/mingdao"
  chmod +x "$HOME/.mingdao/app/src/cli.js" "$HOME/.local/bin/mingdao"
  if ! echo "$PATH" | tr ':' '\n' | grep -qx "$HOME/.local/bin"; then
    warn "请把 $HOME/.local/bin 加入 PATH（在 ~/.bashrc 或 ~/.zshrc 末尾添加）："
    echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
  fi
fi

# ---------- 3. 完成 ----------
if command -v mingdao >/dev/null 2>&1; then
  info "安装完成！"
  echo ""
  echo "  接下来："
  echo "    1. 运行 'mingdao init' 配置模型（API Key 从 https://platform.deepseek.com 获取）"
  echo "    2. 输入 'mingdao' 开始对话"
  echo "    3. 'mingdao \"你的问题\"' 可单次提问，'mingdao --continue' 继续上次会话"
else
  warn "安装完成，但当前终端还找不到 mingdao 命令。"
  warn "请重新打开终端，或按上方提示把 ~/.local/bin 加入 PATH 后重试。"
fi
