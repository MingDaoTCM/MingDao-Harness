# MingDao Harness v0.3.0 发布说明

**版本：0.3.0 — 记忆与长跑**

## 本次更新

1. **任务续跑 v1**：跑到步数上限不再"戛然而止"——自动落检查点，`--continue` 或 WebUI
   重新打开会话时注入进度摘要从断点续跑，已完成文件不会重复做。
2. **项目级自动记忆 v1**：每个工作空间自动沉淀「关键决定/事实/结构/教训」到
   `<工作空间>/.mingdao/memory.md`，换会话不重来、换项目不串。
3. **省钱基准**：`bench-savings` 把「比裸调 DeepSeek API 省 X%」变成可复现断言
   （8 任务·综合省 63% 基线），并入 bench 门禁，省钱幅度只降不升。
4. **一键诊断**：`mingdao diagnose` 生成脱敏诊断包（环境/配置脱敏/日志尾/审计尾/
   工作空间与项目记忆定位），贴给反馈即查。
5. 增量上下文（基线+变化）顺延 v0.3.1（续跑进度摘要已覆盖省钱主场景）。

## 安装

- **Windows**：`mingdao-setup-0.3.0-x64.exe`
- **Linux**：`mingdao-0.3.0-amd64.deb` 或 `mingdao-0.3.0-x86_64.AppImage`
- **macOS (Intel)**：`mingdao-0.3.0-x64.dmg` / `mingdao-0.3.0-x64-mac.zip`
- **macOS (Apple 芯片)**：`mingdao-0.3.0-arm64.dmg` / `mingdao-0.3.0-arm64-mac.zip`

> 桌面版安装包统一由官网分发（国内直连极速）：https://harness.mingdao.ai/#downloads
> 校验值与更新日志以官网为准。

## 反馈

- 官网：https://harness.mingdao.ai
- 论坛：https://harness.mingdao.ai/forum/
- 问题反馈请附 `~/.mingdao/logs/web-server.log`（Linux/macOS）或
  `%USERPROFILE%\.mingdao\logs\web-server.log`（Windows）与桌面端 `mingdao.log`。
