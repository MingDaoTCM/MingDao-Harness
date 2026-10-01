# v0.4.1 规划：安全版本（偿还 v0.4.0 审计安全债）

> 依据：`MingDao Harness v0.4.0 完整审计报告.docx`（2026-09-05，源码通读 + 4 项实测复现）。
> 定调：**暂停新功能，先清零 P0 安全债**——一个能自动执行 shell 的 agent，安全边界优先级高于任何新特性。
> 纪律：实现后不单独发布，与 v0.4.1 一起发布；等用户在 3820 验收后再发。

## 已修复（本批次）

### P0 安全（5 项）
1. **路径穿越防护**（fs-tools.js）：read/write/edit/ls/glob/grep/undo 限定工作目录 + `config.fsAllowDirs`
   白名单；`realpath` 逐级校验防软链接逃逸。auto 模式也无法读 ~/.ssh、credentials.json。
2. **SSRF 302 重定向绕过**（fetch.js）：`redirect:'manual'` 手动跟随，每跳重新 isPrivateHost + DNS 复检，
   跳数上限 5。
3. **权限前缀规则绕过**（permissions.js）：黑名单改白名单字符 `[A-Za-z0-9_ ./\\:-]`，单 `&`、重定向
   `< >`、回车 `\r` 及一切 shell 元字符都不匹配前缀规则，回落权限确认。
4. **预设 permission 提权**（presets.js）：新增 `presetPermissionOverride`——预设声明 permission 若
   比当前更宽松（ask→auto 等）则忽略并提示；CLI/REPL/WebUI 三入口统一接入。
5. **MCP 权限收紧**（mcp.js）：`readOnlyHint` 自动放行改为「仅 `mcpServers.<name>.trusted:true` 才信任」，
   未授信服务器谎报只读也走权限确认。

### P1 正确性（6 项）
6. **turnToolCache 跨步去重失效**（agent.js）：声明从 while 体内提到 for 轮内——去重跨步生效。
7. **windowPressure 永不复位**（agent.js）：压缩成功后复位，不再每轮 force 压缩持续烧钱。
8. **mountConfigTools 阻塞事件循环**（tools/index.js）：spawnSync → 异步 spawn + Promise。
9. **batch.js 未跟进 model-caps**：超窗口预检改用 `resolveModelCaps(cfg, model).contextWindow`。
10. **语义检索无匹配记忆全丢**（memory.js）：无共同词时回退最近 N 条（相关性失败 ≠ 记忆不存在）。
11. **沙箱探测缺陷**（bash.js）：`detectSandbox` 从 `--version` 改为最小真实沙箱探测
    （`bwrap --ro-bind / / --tmpfs /tmp true`），容器内 bwrap 不可用则降级 none。

### P2 质量（6 项）
12. 正则笔误 `/^f[c d]/` → `/^f[cd]/`（fetch.js + server.js）。
13. git.js log/diff 限量实现（log 默认 -n 50、diff 默认 --stat），修注释与实现不符。
14. cost-guard.js `todayCostWarned` TDZ 前置。
15. registerTool 增 `readOnly` 选项（进 READONLY_TOOLS，只读档自动放行）。
16. context.js 幂等守卫死代码移除（回收结果从不回写原 messages，守卫恒 false）。
17. agent.js reasoning 清洗 O(n²) → 单次遍历 O(n)。

### macOS 本地模型「输出截断 / 子代理无反馈」（追加修复，2026-09-05）

用户 MacBook 用 mtplx-qwen38-27b（routing.enabled=true）复现，日志 `text=0` 且 `status=done`。两个根因：

18. **子代理无反馈**（routing.js）：`subagentModel` 在 routing 开启时恒返回 executor
    （deepseek-v4-flash），无 routeTask 的「池外不干预」检查——本地/自定义模型派子代理时，把
    executor 模型名发到本地 baseUrl（8081）→ 服务端不认识 → 400 → 子代理全灭。修复：池外跟随当前模型。
19. **输出截断/text=0**（agent.js）：兜底总结请求此前用 `trimMessages(messages, budget)` 全量历史，
    本地 q8 模型 ≈98k token 的 prefill 逼近/超过 600s 首 token 超时 → 总结请求失败被 `catch {}` 静默吞 →
    返回 text:null。修复：兜底总结改用轻量输入（system + 交付物清单 + 提示，几 k token），慢 prefill
    也能秒出总结；失败不再静默（io.print 提示原因）。
20. 子代理空输出透出 note 原因（agent.js）：不再笼统「（子任务无输出）」，主线程可据此决策。
21. diagnose 报告新增「当前模型能力」段：本地模型未声明 contextWindow 时显式提示兜底 32k 及其后果
    （输出/预算被压缩），帮用户自诊。

## 顺延（明确记录，不强行塞入本批次）

- **WebUI 速率限制**：本地优先工具默认回环绑定 + token 认证已挡远程；已有 `MAX_CONCURRENT=8`
  并发上限 + `costGuard` 日费用上限双保险。令牌桶的维度（IP/会话/token）与阈值需产品决策，
  待 v0.4.2 单独设计。
- **容器环境 CI job**：审计建议加 container 矩阵覆盖 bwrap 不可用路径（沙箱探测修复已从代码层
  缓解，CI 覆盖作为后续工程项）。
- **省钱机制有效性自检**（/cost 展示各机制实际节省额）：依赖更细的分账埋点，顺延。

## 验收

- smoke 新增路径穿越/SSRF 重定向/权限绕过/预设提权/MCP trusted/语义检索回退等回归断言。
- 全绿门禁 + strict 0/0 + typecheck；发布前自检；用户 3820 验收后再随 v0.4.1 发布。
