# MingDao Harness v0.3.1 发布说明

**版本：0.3.1 — 真·省钱仪表盘 + 语义检索 + 只读调研 + 自动续跑**

## 本次更新

1. **真·省钱仪表盘**：费用徽标从设置移出、置顶于主界面——点击展开可视化面板
   （KPI 卡 + 缓存命中率环状仪表 + 14 天费用趋势面积图 + 模型/工具 Top5 条形 +
   最近缓存明细），命中率/节省金额一眼可查。
2. **语义检索（零依赖）**：项目记忆从「全量截断注入」升级为「按任务取相关条目」
   （分词 Jaccard 相似度），换会话/换任务只注入相关记忆，省 token 且保前缀缓存稳定。
3. **只读调研工具**：新增 `git`（只读子命令白名单，防注入）与 `fetch`（公网只读抓取，
   SSRF 防护 + DNS 复检），只读档扩至 8 工具；子代理步数 12→24 防截断。
4. **自动续跑**：跑满步数不再「戛然而止」——注入进度摘要自动续下一轮
   （`cfg.maxRounds` 默认 3，可调），审计/重构等长程任务连续执行到完成。
5. **统一脱敏**：`redact.js` 收敛审计/日志/诊断的密钥脱敏规则（sk-/ghp_/Bearer/私网 IP/
   家目录路径），消除各层自扫门前雪。
6. 增量上下文（基线+变化）顺延 v0.3.2（自动续跑 + 语义检索已覆盖省钱与长程主场景）。

## 安装

- **Windows**：`mingdao-setup-0.3.1-x64.exe`
- **Linux**：`mingdao-0.3.1-amd64.deb` 或 `mingdao-0.3.1-x86_64.AppImage`
- **macOS (Intel)**：`mingdao-0.3.1-x64.dmg` / `mingdao-0.3.1-x64-mac.zip`
- **macOS (Apple 芯片)**：`mingdao-0.3.1-arm64.dmg` / `mingdao-0.3.1-arm64-mac.zip`

> 桌面版安装包统一由官网分发（国内直连极速）：https://harness.mingdao.ai/#downloads
> 校验值与更新日志以官网为准。

## 反馈

- 官网：https://harness.mingdao.ai
- 论坛：https://harness.mingdao.ai/forum/
- 问题反馈请附 `~/.mingdao/logs/web-server.log`（Linux/macOS）或
  `%USERPROFILE%\.mingdao\logs\web-server.log`（Windows）与桌面端 `mingdao.log`。
