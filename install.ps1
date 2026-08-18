# MingDao-Harness Windows 一键安装脚本（Windows 10/11）
# 方式一（推荐）：双击 install.bat
# 方式二：powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1

$ErrorActionPreference = 'Stop'

function Info($m) { Write-Host "[MingDao] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[警告] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "[错误] $m" -ForegroundColor Red; exit 1 }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

# ---------- 1. 检查 Node.js >= 18.17 ----------
function Get-NodeMajor {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { return 0 }
  try {
    $v = (& node -p "process.versions.node.split('.')[0]" 2>$null | Out-String).Trim()
    if ($v -match '^\d+$') { return [int]$v }
  } catch { }
  return 0
}

$major = Get-NodeMajor
if ($major -lt 18) {
  Info "未找到合适的 Node.js，尝试通过 winget 自动安装（Windows 11 已内置 winget）…"
  $wg = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $wg) {
    Fail "未找到 winget。请手动安装 Node.js 18+（https://nodejs.org）后重新运行本脚本。"
  }
  winget install OpenJS.NodeJS.LTS --scope user --accept-package-agreements --accept-source-agreements --silent
  # 刷新当前会话 PATH，尽量免去重开终端
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')
  $major = Get-NodeMajor
  if ($major -lt 18) {
    Warn "Node.js 已安装，但当前窗口尚未生效。请关闭并重新打开终端，然后重新双击 install.bat。"
    exit 0
  }
}
Info "Node.js 已就绪：v$major"

# ---------- 2. 安装 mingdao 命令 ----------
Info "安装 mingdao 命令…"
npm install -g .

# ---------- 3. 完成 ----------
if (Get-Command mingdao -ErrorAction SilentlyContinue) {
  Info "安装完成！"
  Write-Host ""
  Write-Host "  接下来："
  Write-Host "    1. 运行 'mingdao init' 配置模型（API Key 从 https://platform.deepseek.com 获取）"
  Write-Host "    2. 输入 'mingdao' 开始对话"
  Write-Host "    3. 'mingdao \"你的问题\"' 可单次提问，'mingdao --continue' 继续上次会话"
} else {
  Warn "安装完成，但当前窗口还找不到 mingdao 命令，请重新打开终端后使用。"
}
