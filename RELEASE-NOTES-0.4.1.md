# MingDao Harness v0.4.1 发布说明

**版本：0.4.1 — 安全版本（偿还 v0.4.0 审计安全债 + macOS 本地模型修复）**

> 定调：暂停新功能，先清零 P0 安全债——一个能自动执行 shell 的 agent，安全边界优先级高于任何新特性。

## 本次更新

### 安全修复（P0 × 5）

1. **路径穿越防护**：read/write/edit/ls/glob/grep/undo 全部限定在工作目录 + `config.fsAllowDirs`
   白名单内，`realpath` 逐级校验防软链接逃逸——auto 模式也无法读 `~/.ssh`、`credentials.json`。
2. **SSRF 302 重定向绕过**：fetch 工具改 `redirect:'manual'` 手动跟随，每跳重新做内网地址 + DNS
   复检，跳数上限 5，杜绝「先过检再被 302 带到内网」。
3. **权限前缀规则绕过**：bash 前缀规则从黑名单改为白名单字符 `[A-Za-z0-9_ ./\\:-]`，`&`、`< >`、
   回车等一切 shell 元字符都不再命中前缀规则，回落权限确认。
4. **预设 permission 提权**：Agent Preset 声明的 permission 若比当前更宽松（ask→auto）会被忽略并
   提示；CLI / REPL / WebUI 三入口统一接入。
5. **MCP 权限收紧**：只读自动放行改为「仅 `mcpServers.<name>.trusted:true` 才信任」，未授信服务器
   谎报只读也要走权限确认。

### 正确性与质量（P1 × 6 + P2 × 6）

6. 去重缓存、窗口压力、批量预检、语义检索回退、沙箱探测等 6 处正确性修复；
   正则笔误、git 限量、TDZ、死代码、O(n²) 清洗等 6 处质量修复（详见 CHANGELOG）。

### macOS 本地模型「输出截断 / 子代理无反馈」双根因修复

7. **子代理无反馈**：routing 开启时 `subagentModel` 此前恒返回 executor 模型名，本地/自定义模型派
   子代理会把 executor 模型名发到本地 baseUrl → 服务端 400 → 子代理全灭。现池外跟随当前模型。
8. **输出截断 / text=0**：兜底总结此前用全量历史（本地 q8 ≈98k token prefill 逼近 600s 超时被静默
   吞掉）。现改轻量输入（system + 交付物清单，几 k token），慢 prefill 也能秒出总结；失败不再静默。
9. `diagnose` 新增「当前模型能力」报告：本地模型未声明 contextWindow 时显式提示兜底 32k 及其后果。

### 桌面版设置增强

10. WebUI 自定义模型「修改」按钮现在可直接改 API 地址、标签、**上下文窗口**、**最大输出**（留空
    表示不变），本地模型不必手改 `config.json` 即可声明 contextWindow/maxOutputTokens。

## 安装

- **Windows**：`mingdao-setup-0.4.1-x64.exe`
- **Linux**：`mingdao-0.4.1-amd64.deb` 或 `mingdao-0.4.1-x86_64.AppImage`
- **macOS (Intel)**：`mingdao-0.4.1-x64.dmg` / `mingdao-0.4.1-x64-mac.zip`
- **macOS (Apple 芯片)**：`mingdao-0.4.1-arm64.dmg` / `mingdao-0.4.1-arm64-mac.zip`

> 桌面版安装包统一由官网分发（国内直连极速）：https://harness.mingdao.ai/#downloads
> 校验值与更新日志以官网为准。

## 反馈

- 官网：https://harness.mingdao.ai
- 论坛：https://harness.mingdao.ai/forum/
- 问题反馈请附 `~/.mingdao/logs/web-server.log`（Linux/macOS）或
  `%USERPROFILE%\.mingdao\logs\web-server.log`（Windows）与桌面端 `mingdao.log`。
