# MingDao VS Code 插件

把 MingDao 的 WebUI 带入 VS Code：一键启动服务器、一键在浏览器打开。当前版本聚焦「零摩擦接入」，深度集成（侧边栏内嵌面板、选中代码右键发送给 MingDao）在路线图中。

## 安装

前提：已安装 `mingdao-harness`（`mingdao` / `mdh` 命令可用）。

```bash
mkdir -p ~/.vscode/extensions/mingdao-vscode
cp -r ide/vscode/. ~/.vscode/extensions/mingdao-vscode/
# 重启 VS Code 或执行「Developer: Reload Window」
```

Windows（PowerShell）：

```powershell
New-Item -ItemType Directory -Force $env:USERPROFILE\.vscode\extensions\mingdao-vscode | Out-Null
Copy-Item ide\vscode\* $env:USERPROFILE\.vscode\extensions\mingdao-vscode\ -Recurse
```

## 使用

- 命令面板（Ctrl+Shift+P）→ **MingDao: 打开 WebUI**：探测本地服务器，未启动则提示一键启动，然后浏览器打开
- **MingDao: 启动服务器（终端）**：在集成终端中运行 `mingdao web`，日志可见
- 设置（settings.json）：`mingdao.port`（默认 3820）、`mingdao.binary`（默认 `mingdao`，可用 `mdh`）

## 说明

- 本插件通过 HTTP 与本地 WebUI 协作，模型、权限、MCP、技能等全部沿用 `~/.mingdao` 配置
- 首次使用前运行 `mingdao init` 完成配置
