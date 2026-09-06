# MingDao Harness v0.4.3 发布说明

**版本：0.4.3 — 正确性收尾（审计 P1×3 + P2×6 + 低成本 P3 + network error 诊断）**

> 项目简称 **MDH**（MingDao Harness），自本版起文档/日志/发布说明统一使用。

## 本次更新

### 长任务「network error」诊断闭环（macOS 本地模型）

1. **渲染层异常补全量诊断日志**：SSE 流异常时记录错误形态（name/message/原始错误）与回合状态
   （taskId / 已输出字数 / 步数 / 耗时）——此前静默中断零日志，根因不可见。
2. **服务端补断连日志**：用 `res.writableEnded` 区分「正常收尾」与「客户端中途断开」，记录已跑时长。
3. **失败提示可操作化**：中断兜底不再是无信息的「网络错误」，改为明确告知「检查点已保存，直接
   发送『继续』即可从断点续跑」。

### 正确性修复（依据 v0.4.2 完整技术审计报告）

4. **WebUI 自启修复**：退出 TUI 后自启 WebUI 此前 100% 失效且误报「后台启动中」（重构遗留：
   spawn 目标是纯模块 repl.js，`web` 参数被静默丢弃）——改 spawn `cli.js web`。
5. **云同步并发完整性**：sync-server 会话内容落盘改为锁内原子写（此前固定 `.tmp` 名 + 锁外写，
   并发同名 push 存在内容串扰与 rename 竞态）。
6. **技能安装不再卡死**：git 仓库安装 `spawnSync`（最长阻塞 120 秒冻结整个 Node 事件循环）
   改异步 `spawn`。
7. **技能 URL 安装 SSRF 防护**：与 fetch 工具/WebUI 同口径——私网/回环判定 + DNS 复检 +
   手动跟随重定向（跳数上限 5）；CLI 显式输入 URL 时放行内网（用户自担意图）。
8. **费用估算口径**：修复 `pricing.ttlDays` 初值 bug（此前新进程首次调用恒按 7 天判过期、
   持续误报「价格表过期」）。
9. **费用统计轮转**：cache-stats 轮转加跨进程文件锁，杜绝多进程并发轮转丢行。
10. **单次提问误报失败**：自动标题生成失败不再把已成功的回答误报为失败（exitCode=2）。
11. **`--format json` 输出纯净**：预设/tools/MCP 提示在 JSON 模式下静默，stdout 恒为单行合法 JSON。
12. **会话恢复不 400**：工具管线异常路径清理孤儿 tool_calls（此前恢复会话后 API 报
    tool_call_id 不存在）。

### 低危加固（P3 批次）

13. 家目录脱敏加路径边界（`/home/user2/xxx` 不再被误脱敏为 `~2/xxx`）；预设同名遮蔽按 `name`
    字段而非文件名；本地模型判定补齐 IPv6 私网/链路本地（`fc00::/7`、`fe80::/10`）；hook 子进程
    环境变量过滤敏感密钥（与 bash 工具同口径）；`sandbox` 空串归一化。

## 安装

- **Windows**：`mingdao-setup-0.4.3-x64.exe`
- **Linux**：`mingdao-0.4.3-amd64.deb` 或 `mingdao-0.4.3-x86_64.AppImage`
- **macOS (Intel)**：`mingdao-0.4.3-x64.dmg` / `mingdao-0.4.3-x64-mac.zip`
- **macOS (Apple 芯片)**：`mingdao-0.4.3-arm64.dmg` / `mingdao-0.4.3-arm64-mac.zip`

> 桌面版安装包统一由官网分发（国内直连极速）：https://harness.mingdao.ai/#downloads
> 校验值与更新日志以官网为准。

## 反馈

- 官网：https://harness.mingdao.ai
- 论坛：https://harness.mingdao.ai/forum/
- 问题反馈请附 `~/.mingdao/logs/web-server.log`（Linux/macOS）或
  `%USERPROFILE%\.mingdao\logs\web-server.log`（Windows）与桌面端 `mingdao.log`。
