# MingDao-Harness Windows 一键安装脚本（Windows 10/11）
# 方式一（推荐）：双击 install.bat
# 方式二：powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
# 方式三（内网 / air-gap）：powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Offline
#
# -Offline（v0.6.0 C4）：**不联网**——不通过 winget 装 Node、不走 npm（npm install -g . 可能因
# devDependencies 访问 registry），改用用户目录下的 .cmd 包装直接调用源码。
# 前置条件：本机已装 Node.js ≥ 18.17。
# 与 POSIX 侧 `install.sh --offline` 对应；两侧行为保持一致，避免「Linux 能离线、Windows 不能」。

param([switch]$Offline)

$ErrorActionPreference = 'Stop'

function Info($m) { Write-Host "[MingDao] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[警告] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "[错误] $m" -ForegroundColor Red; exit 1 }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

# ---------- 1. 检查 Node.js >= 18.17 ----------
# v0.6.0：改回**完整版本**比较。此前只看 major（`$major -lt 18`），于是 18.0–18.16 会被判为合格，
# 而内核 `engines` 要求 ≥ 18.17——用户会拿到一个装得上、跑不起来的安装。
# POSIX 侧修过同类问题（审计 T23），Windows 侧此前漏了。
function Get-NodeVersion {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { return $null }
  try {
    $v = (& node -p "process.versions.node" 2>$null | Out-String).Trim()
    if ($v -match '^\d+\.\d+\.\d+') { return [version]$v }
  } catch { }
  return $null
}

$nodeVer = Get-NodeVersion
if (-not $nodeVer -or $nodeVer -lt [version]'18.17.0') {
  if ($Offline) {
    Fail "离线安装不下载 Node.js。请先在离线包/内网源中安装 Node.js >= 18.17，再重新执行本脚本。"
  }
  Info "未找到合适的 Node.js，尝试通过 winget 自动安装（Windows 11 已内置 winget）…"
  $wg = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $wg) {
    Fail "未找到 winget。请手动安装 Node.js 18.17+（https://nodejs.org）后重新运行本脚本。"
  }
  winget install OpenJS.NodeJS.LTS --scope user --accept-package-agreements --accept-source-agreements --silent
  # 刷新当前会话 PATH，尽量免去重开终端
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')
  $nodeVer = Get-NodeVersion
  if (-not $nodeVer -or $nodeVer -lt [version]'18.17.0') {
    Warn "Node.js 已安装，但当前窗口尚未生效。请关闭并重新打开终端，然后重新双击 install.bat。"
    exit 0
  }
}
Info "Node.js 已就绪：v$nodeVer"

# ---------- 2. 安装 mingdao 命令 ----------
if ($Offline) {
  # 离线模式：不碰 npm（`npm install -g .` 可能访问 registry），改用 .cmd 包装。
  # 本项目运行时零依赖，源码即产物，因此包装直接指向 src/cli.js 即可。
  Info "离线模式：跳过 npm，改用用户目录命令包装（不访问 registry）"
  $bin = Join-Path $env:USERPROFILE '.local\bin'
  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  $cli = Join-Path $ScriptDir 'src\cli.js'
  if (-not (Test-Path $cli)) { Fail "找不到 $cli —— 离线安装需要在本仓库目录内运行（离线包解压后进入该目录再执行）。" }
  $wrapper = "@echo off`r`nnode `"$cli`" %*`r`n"
  Set-Content -Path (Join-Path $bin 'mingdao.cmd') -Value $wrapper -Encoding ASCII
  Copy-Item (Join-Path $bin 'mingdao.cmd') (Join-Path $bin 'mdh.cmd') -Force
  # 当前会话立即可用（持久化 PATH 交给用户确认，与 POSIX 侧只提示的做法保持一致）
  if (($env:Path -split ';') -notcontains $bin) { $env:Path = "$bin;$env:Path" }
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (($userPath -split ';') -notcontains $bin) {
    Warn "请把 $bin 加入用户 PATH（设置 → 系统 → 系统信息 → 高级系统设置 → 环境变量）："
    Write-Host "    $bin"
  }
  Info "已安装到 $bin（离线模式不支持 mingdao update 自更新——没有 .git，且升级需重新投放离线包）"
} else {
  Info "安装 mingdao 命令…"
  npm install -g .
}

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
