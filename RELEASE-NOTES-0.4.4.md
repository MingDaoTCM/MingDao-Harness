# MingDao Harness v0.4.4 发布说明

**版本：0.4.4 — macOS 熄屏断连根治 + 审计可用性 + 技术评估修复**

> 项目简称 **MDH**（MingDao Harness）。

## 本次更新

### macOS 长任务 network error 根治（熄屏/Idle Sleep）

1. **生成期防睡眠/防熄屏**：桌面版在任务运行期间自动持 `powerSaveBlocker('prevent-display-sleep')`，
   任务结束释放——macOS 熄屏（Idle Sleep）会中断 Chromium 网络栈导致 SSE 断连，这是此前多轮
   network error 的最终根因（v0.4.3 报告以三层时间线秒级对齐证实）。
2. **诊断日志修复**：SSE 流异常日志从对象改 `JSON.stringify`（此前 Electron 落成 `[object Object]`）。
3. **统一中断提示**：非手动中断时一律提示「检查点已保存，发『继续』即可断点续跑」。

### 审计任务可用性（DeepSeek 与本地模型均适用）

4. **只读审计可派子代理**：`task` 工具加入只读档——审计/调研类只读长任务此前全程只读档、
   模型看不到「派子代理」能力；现在可派 `readOnly` 子代理并行复核（写操作仍被权限引擎门控）。
5. **今日费用逐轮累计**：`recordUsage` 此前只在任务全部结束后记录一次，长任务执行期间
   「今日费用」恒为 ¥0 被误读为「无统计」；现每轮结束逐轮入账，执行中实时累计、中断也不丢。

### 技术评估修复（v0.4.3 评估报告 6.x）

6. **fs-browse 路径穿越**（中危）：`..` 段绕过白名单前缀比较，可 stat 到白名单外目录——先
   `path.resolve` 消解再比较。
7. **MCP 环境变量过滤**（中危）：MCP 子进程不再继承完整 `process.env`（含 API Key），与 bash/hooks
   同口径（`mcpEnvKeep`/`mcpEnvFilter`）。
8. 调度器 resume/once/after 状态写加锁、hooks 超时整组清理（`detached`）、工作空间注册表原子写、
   附件文本上限按字节数。

## 安装

- **Windows**：`mingdao-setup-0.4.4-x64.exe`
- **Linux**：`mingdao-0.4.4-amd64.deb` 或 `mingdao-0.4.4-x86_64.AppImage`
- **macOS (Intel)**：`mingdao-0.4.4-x64.dmg` / `mingdao-0.4.4-x64-mac.zip`
- **macOS (Apple 芯片)**：`mingdao-0.4.4-arm64.dmg` / `mingdao-0.4.4-arm64-mac.zip`

> 桌面版安装包统一由官网分发（国内直连极速）：https://harness.mingdao.ai/#downloads
> 校验值与更新日志以官网为准。

## 反馈

- 官网：https://harness.mingdao.ai
- 论坛：https://harness.mingdao.ai/forum/
- 问题反馈请附 `~/.mingdao/logs/web-server.log`（Linux/macOS）或
  `%USERPROFILE%\.mingdao\logs\web-server.log`（Windows）与桌面端 `mingdao.log`。
