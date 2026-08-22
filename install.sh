#!/usr/bin/env bash
# MingDao-Harness 一键安装脚本（三平台通用：Gitee / GitCode / GitHub 内容一致）
# 用法：
#   1) 在仓库目录内：bash install.sh                       —— 就地安装
#   2) 一行安装：curl -fsSL <本平台 raw install.sh> | bash -s -- <gitee|gitcode|github>
#      —— 脚本自动从指定平台（失败时依次兜底其余平台）获取仓库到 ~/.mingdao/repo 后安装
# 功能：检查/自动安装 Node.js（官方源 → Gitee 镜像）→ 安装 mingdao 命令（npm link，或用户目录软链）
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

# 首选平台（可选参数；未指定时按 gitee → gitcode → github 依次尝试，哪个通装哪个）
PLATFORM="${1:-}"

# 各平台 git 克隆地址与源码包下载地址（|分隔：平台|git|tarball）
REPO_URLS="
gitee|https://gitee.com/MingDaoTCM/MingDao-harness.git|https://gitee.com/MingDaoTCM/MingDao-harness/repository/archive/main.tar.gz
gitcode|https://gitcode.com/MingDaoTCM/MingDao-Harness.git|https://gitcode.com/MingDaoTCM/MingDao-Harness/-/archive/main/MingDao-Harness-main.tar.gz
github|https://github.com/MingDaoTCM/MingDao-Harness.git|https://github.com/MingDaoTCM/MingDao-Harness/archive/refs/heads/main.tar.gz
"

url_for(){ printf '%s\n' "$REPO_URLS" | grep "^$1|" | cut -d'|' -f"$2"; }
is_repo(){ [ -f "$1/package.json" ] && [ -f "$1/src/cli.js" ]; }
REPO_MODE="local"   # local（仓库内就地）| git（克隆）| tarball（源码包，无 .git）

# 获取仓库到 ~/.mingdao/repo（git 优先，没有 git 时下载源码包）
fetch_repo(){
  local dir="$HOME/.mingdao/repo"
  if [ -d "$dir/.git" ]; then
    info "检测到已有仓库，尝试更新…"
    git -C "$dir" pull --ff-only --quiet >/dev/null 2>&1 || warn "更新失败，继续使用现有仓库"
    REPO_MODE="git"; cd "$dir"; return 0
  fi
  for p in ${PLATFORM:-} gitee gitcode github; do
    local git_url tgz
    git_url="$(url_for "$p" 2)"; tgz="$(url_for "$p" 3)"
    if command -v git >/dev/null 2>&1 && git clone --depth 1 --quiet "$git_url" "$dir" 2>/dev/null; then
      REPO_MODE="git"; cd "$dir"; info "已从 $p 克隆仓库（git）"; return 0
    fi
    rm -rf "$dir"
    if curl -fsSL -m 120 "$tgz" -o /tmp/mingdao-repo.tgz 2>/dev/null; then
      mkdir -p "$dir"
      if tar -xzf /tmp/mingdao-repo.tgz -C "$dir" --strip-components=1 2>/dev/null; then
        rm -f /tmp/mingdao-repo.tgz
        REPO_MODE="tarball"; cd "$dir"
        info "已从 $p 下载源码包（无 .git；升级请重新运行本安装脚本）"
        return 0
      fi
      rm -rf "$dir"
    fi
    rm -f /tmp/mingdao-repo.tgz
  done
  die "无法获取仓库（git 与源码包下载均失败）。请手动克隆任意平台仓库后，在仓库内运行 bash install.sh。"
}

# 定位安装源：仓库目录内 → 就地；否则（curl|bash）→ 自动获取仓库。
# 注意：curl | bash 管道执行时 BASH_SOURCE 未绑定，需给默认值（set -u 下否则报错）。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-}")" && pwd)"
if is_repo "$SCRIPT_DIR"; then
  cd "$SCRIPT_DIR"
else
  info "未在仓库目录中运行，自动获取仓库（平台：${PLATFORM:-自动}）…"
  fetch_repo
fi

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
  # nvm 安装源：官方 raw.githubusercontent → 失败回落 Gitee 镜像（国内可用）
  local official=1
  if ! curl -fsSL -m 60 https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh -o /tmp/mingdao-nvm.sh 2>/dev/null; then
    official=0
    warn "nvm 官方源不可达，改用 Gitee 镜像 + npmmirror 的 Node 下载源（国内网络）…"
    curl -fsSL -m 60 https://gitee.com/mirrors/nvm/raw/master/install.sh -o /tmp/mingdao-nvm.sh || die "nvm 下载失败（官方与镜像均不可达），请手动安装 Node.js 18+"
    export NVM_NODEJS_ORG_MIRROR="${NVM_NODEJS_ORG_MIRROR:-https://npmmirror.com/mirrors/node}"
  fi
  bash /tmp/mingdao-nvm.sh >/dev/null 2>&1 || true
  rm -f /tmp/mingdao-nvm.sh
  # shellcheck disable=SC1090
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  if ! command -v nvm >/dev/null 2>&1; then
    die "nvm 安装失败，请手动安装 Node.js：https://nodejs.org"
  fi
  nvm install 20 >/dev/null || nvm install --lts
  nvm use 20 2>/dev/null || true
  if [ "$official" = "0" ]; then unset NVM_NODEJS_ORG_MIRROR; fi
  info "Node.js 已就绪：$(node --version)"
}

if ! need_node; then install_node; fi
if ! need_node; then die "Node.js 版本检查失败。"; fi

# ---------- 2. 安装 mingdao 命令 ----------
# 优先 npm link：全局命令软链到仓库 → 仓库常驻，mingdao update 可自更新
info "安装 mingdao 命令…"
if command -v npm >/dev/null 2>&1 && npm link --silent >/dev/null 2>&1; then
  info "已全局安装（npm link → 指向仓库，支持 mingdao update 自更新）"
else
  warn "npm link 失败（可能没有管理员权限），改为用户目录软链（同样支持 mingdao update）…"
  chmod +x "$(pwd)/src/cli.js"
  mkdir -p "$HOME/.local/bin"
  ln -sf "$(pwd)/src/cli.js" "$HOME/.local/bin/mingdao"
  ln -sf "$(pwd)/src/cli.js" "$HOME/.local/bin/mdh"
  if ! printf '%s' "$PATH" | tr ':' '\n' | grep -qx "$HOME/.local/bin"; then
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
  if [ "$REPO_MODE" = "tarball" ]; then
    echo "    4. 新版本发布后重新运行本安装脚本即可升级"
  else
    echo "    4. 新版本发布后 'mingdao update' 一键升级（失败自动回滚）"
  fi
else
  warn "安装完成，但当前终端还找不到 mingdao 命令。"
  warn "请重新打开终端，或按上方提示把 ~/.local/bin 加入 PATH 后重试。"
fi
