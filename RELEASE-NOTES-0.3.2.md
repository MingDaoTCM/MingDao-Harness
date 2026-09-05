# MingDao Harness v0.3.2 发布说明

**版本：0.3.2 — 本地模型自适应（资源受限部署长任务不再中断）**

## 本次更新

1. **本地模型自适应**：本机/内网部署的推理框架（127.0.0.1 / localhost / 私网 IP）自动按
   「资源有限」对待——上下文窗口、预算、超时、工具输出截断按模型能力自动收紧，小模型/
   低内存部署不再撑爆窗口、不被一刀切超时误杀。
2. **安全预算推导**：预算自动收紧到 `min(期望值, 窗口×75% 舒适区, 窗口−输出−余量)`，
   prompt 永不逼近窗口边缘——从根上避免「长上下文 prefill 指数恶化 → 首 token 等 200s+
   被客户端掐断」的 network error。
3. **分层超时**：首 token 等待（本地 600s / 远程 300s）、流式空闲（120s）、总量
   （本地 30min / 远程 10min）三段自适应，按「帧到达」判定存活——慢 prefill 不再被
   3 分钟一刀切超时误杀。可用 `config.timeout.*` 覆盖。
4. **边缘检测 + 强制压缩**：模型每轮上报真实 `prompt_tokens`，≥ 窗口 85% 时下一轮强制
   压缩历史（即使非 DeepSeek 模型启发式计数低估也强制触发）。
5. **工具输出截断自适应**：单条工具结果按 `窗口/16` 封顶（2k–20k 字），小窗口不再整条
   回灌大段代码/日志。
6. **自定义模型上下文声明**：`customModels.<name>.contextWindow` / `.maxOutputTokens`
   显式声明模型真实窗口（WebUI 设置面板新增两项），预算据此精确推导。

## 安装

- **Windows**：`mingdao-setup-0.3.2-x64.exe`
- **Linux**：`mingdao-0.3.2-amd64.deb` 或 `mingdao-0.3.2-x86_64.AppImage`
- **macOS (Intel)**：`mingdao-0.3.2-x64.dmg` / `mingdao-0.3.2-x64-mac.zip`
- **macOS (Apple 芯片)**：`mingdao-0.3.2-arm64.dmg` / `mingdao-0.3.2-arm64-mac.zip`

> 桌面版安装包统一由官网分发（国内直连极速）：https://harness.mingdao.ai/#downloads
> 校验值与更新日志以官网为准。

## 反馈

- 官网：https://harness.mingdao.ai
- 论坛：https://harness.mingdao.ai/forum/
- 问题反馈请附 `~/.mingdao/logs/web-server.log`（Linux/macOS）或
  `%USERPROFILE%\.mingdao\logs\web-server.log`（Windows）与桌面端 `mingdao.log`。
