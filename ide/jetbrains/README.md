# MingDao JetBrains 插件（IntelliJ 全家桶）

把 MingDao 的 WebUI 一键接入 JetBrains IDE：Tools 菜单「MingDao: 打开 WebUI」自动探测/启动服务器并打开浏览器。

## 构建与安装

前置：JDK 17 + 已安装 `mingdao-harness`（`mingdao`/`mdh` 可用）。

```bash
cd ide/jetbrains
./gradlew buildPlugin          # 产物：build/distributions/mingdao-jetbrains-0.5.0.zip
```

安装：IDE → Settings → Plugins → ⚙ → Install Plugin from Disk → 选择 zip。开发调试：

```bash
./gradlew runIde               # 启动带插件的沙箱 IDE
```

说明：`build.gradle.kts` 默认面向 IntelliJ IDEA Community（IC）；PyCharm/WebStorm 请把 `intellij.type` 改为 `PC`/`WS` 等并调整版本号。

## 功能

- **MingDao: 打开 WebUI**：探测 127.0.0.1:3820 是否已运行，未运行则后台启动（Windows 用 cmd，Linux/macOS 用 nohup），就绪后浏览器打开
- **MingDao: 启动服务器**：仅启动（后台静默）
- 端口与命令可在 IDE 注册表设置（`mingdao.port` / `mingdao.binary`）

## 状态说明

本插件已含工具窗深度集成（JCEF 内嵌 WebUI + 选中代码发送），Kotlin 代码经审阅但未在真实 IDE 中构建验证（本仓库环境无 IntelliJ SDK）（本仓库环境无 IntelliJ SDK）；构建或运行报错请反馈，深度集成（工具窗内嵌 WebUI、选中代码发送）在路线图中。
