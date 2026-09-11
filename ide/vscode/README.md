# MingDao VS Code 插件

把 MingDao 的 WebUI 带入 VS Code：一键启动服务器、一键在浏览器打开，以及选中代码右键「发送给 MingDao」。

> v0.4.7 修正：此前写「在路线图中」，但侧边栏内嵌面板与「发送选中代码」都已交付；
> 其中「发送选中代码」在本版修好了一个真实缺陷——扩展把草稿写进全局槽，而 WebUI 只在页面
> 初始化时按会话槽读取一次，导致代码始终没进输入框（现改为窗口重新获得焦点时兜底读全局槽）。

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
