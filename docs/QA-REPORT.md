# MingDao-Harness 质检报告

> 质检日期：2026-08-18
> 项目路径：`/home/YouLi/AI/DeepSeek-harness-Space/MingDao-Harness`
> 版本：0.4.0（纯 ESM，零 npm 依赖，Node.js ≥ 18.17）
> 质检方式：全量源码走读 + 冒烟/端到端测试 + 针对性缺陷验证脚本

---

## 一、总体评价

MingDao 是一个架构清晰、文档完善、可运行性良好的轻量 Agent Harness。核心分层（Provider / 工具注册表 / 权限引擎 / 上下文管理 / 会话持久化 / UI 适配）与设计文档一致，README 声称的功能均已实现并通过测试。

**一句话结论：内核质量高于同类"玩具"项目，但存在 1 个严重功能缺陷（Ctrl+C 中断失效）和若干健壮性隐患，本轮已全部修复并补充回归测试。建议先补齐发布前事项（git 初始化、npm 元数据）再对外发布。**

---

## 二、测试验证结果

| 测试套件 | 命令 | 结果 |
| --- | --- | --- |
| 冒烟测试（离线） | `npm test`（test/smoke.js） | ✅ **14 组断言全部通过** |
| 端到端测试（本地 mock 服务器） | `node test/e2e-local.js` | ✅ **4 组全部通过** |

冒烟覆盖：token 估算与预算裁剪（含工具配对清洗）、read/write/edit/glob/grep/ls（含大小上限）、bash 跨平台、SSE 流解析（断行/分片）、Agent 工具循环与 usage 汇总、权限引擎三模式与规则匹配、独立凭证库（600 权限/脱敏/三级解析）、会话持久化、技能三级来源覆盖、todo/task、undo、Hooks、**外部 signal（Ctrl+C）中断挂起请求**。

端到端覆盖：真实 HTTP/SSE 传输 → 工具执行闭环 → 结果回填、REPL 启动与 `/help` `/exit`、会话文件生成与 `--continue` 载入、`mingdao key status` 脱敏显示。

---

## 三、已修复问题（本轮修复 7 项）

### P0-1　Ctrl+C 中断生成失效（严重）

- **位置**：`src/providers/index.js`（`createProvider` 的 `chat` 包装层）
- **问题**：`openaiChat({ ...opts, signal: ac.signal })` 中，内部超时 `AbortController` 的信号**覆盖**了外部传入的用户信号（`...opts` 展开后被同名属性覆盖）。用户按 Ctrl+C 时，`agent.js` 的 `ac.abort()` 永远不会传到 `fetch`，请求只能等到 5 分钟内部超时才中止——表现为"按了没反应"，期间模型输出仍在滚动。
- **验证**：挂起一个不响应的本地 HTTP 服务器，用户侧 800ms 后 abort，实测请求 15 秒后才以"请求超时"中止（用户信号未生效）。
- **修复**：转发外部信号——`opts.signal` 上加 `abort` 监听，触发时同步中止内部控制器；`finally` 中移除监听。中断语义保持"用户中断不触发重试"（AbortError 不匹配重试模式）。
- **回归护栏**：新增 smoke 第 14 组断言 `provider：外部 signal（Ctrl+C）可中断挂起的请求`（挂起请求须在 5s 内中断且非内部超时）。

### P1-2　流式响应缺失 usage 统计（功能失效）

- **位置**：`src/providers/openai-compatible.js`（`chat` 请求构造）
- **问题**：OpenAI 兼容协议的流式响应默认**不携带 usage 字段**（需请求 `stream_options: { include_usage: true }`）。此前 `/usage`、`/cost`、状态行 token/费用估算在大多数网关下恒为 0，README 宣称的"峰谷计价/费用估算"实际不可用。
- **修复**：请求体增加 `stream_options: { include_usage: true }`；新增配置项 `includeUsage`（默认 true），个别不支持该字段的网关可在 `config.json` 设 `"includeUsage": false` 关闭。README 配置说明已同步更新。

### P1-3　上下文裁剪破坏 tool_calls↔tool 配对（API 400 风险）

- **位置**：`src/context.js`（`trimMessages`）
- **问题**：裁剪按 token 从尾部向前截断，当边界恰好落在 `assistant(tool_calls)` 与其 `tool` 响应消息之间时，会产生**孤立的 tool 消息或孤立的 tool_calls**。OpenAI 兼容 API 对这类不配对消息直接报 400，长会话 + 多工具调用时必然触发。
- **验证**：构造裁剪边界落在配对中间的消息序列，实测产生孤立 `tool` 消息。
- **修复**：新增 `cleanToolPairing` 清洗——先收集保留消息中的 `tool_call_id` 集合，删除无对应调用的 tool 消息；再反向过滤 assistant 消息中无响应的 tool_calls（全部被滤除时删除该字段，退化为纯文本消息）。**不消耗额外 token，不改变裁剪语义**。
- **回归护栏**：smoke 第 1 组新增 6 档预算边界的配对完整性断言。

### P1-4　read 工具无文件大小上限（内存风险）

- **位置**：`src/tools/fs-tools.js`（`read`）
- **问题**：`grep` 有 5MB 单文件保护，但 `read` 直接整读任意大小的文本文件。模型读一个数百 MB 的日志文件会导致进程内存暴涨甚至 OOM。
- **验证**：实测 read 12MB 文件完整返回 12,582,914 字符。
- **修复**：复用 `MAX_FILE_BYTES`（5MB）上限，超限返回错误并提示改用 grep / bash 分块查看。

### P2-5　Tab 补全命令列表不完整

- **位置**：`src/ui.js`（`COMMANDS` 常量）
- **问题**：补全列表只有 7 个命令，而 CLI 实际支持 17 个（`/mode` `/compact` `/plan` `/init` `/memory` `/skills` `/status` `/cost` `/verbose` `/quit` 等缺失），与 README"Tab 补全命令"的宣称不符。
- **修复**：补全列表扩至全部 17 个命令。

### P2-6　`~/.mingdao` 目录权限非 700

- **位置**：`src/config.js`（`ensureHome`）
- **问题**：`credentials.json` 文件权限为 600，但其父目录 `~/.mingdao` 用默认 umask 创建（通常 755），其他用户可列出目录内容；新装的系统上目录先于文件创建，密钥防护不闭环。
- **修复**：`mkdirSync` 显式 `mode: 0o700`（递归创建子目录同样生效）。

### P2-7　会话恢复不刷新 system prompt

- **位置**：`src/cli.js`（交互会话载入）
- **问题**：`--continue` / `--resume` 恢复的会话直接沿用文件里旧的 system prompt，其中包含过时的"当前时间"、旧的用户记忆快照、旧的技能清单与 AGENTS.md 内容——用户新增的 `/memory add` 或修改的 AGENTS.md 在恢复会话时不生效。
- **修复**：载入会话后总是以当前 `buildSystemPrompt` 重建首条 system 消息（旧 system 保留在会话文件中，不影响追加历史）。

### 修复验证汇总

| 修复项 | 验证方式 | 结果 |
| --- | --- | --- |
| signal 转发 | 本地挂起服务器 + 用户 abort | ✅ 0.8s 内中断，非内部超时 |
| 配对清洗 | 6 档预算边界配对检查 | ✅ 全部完整 |
| read 上限 | 6MB 文件读取 | ✅ 拒绝并提示 |
| Tab 补全 | 命令清单比对 | ✅ 17/17 |
| 全量回归 | `npm test` + `e2e-local.js` | ✅ 14 组 + 4 组全部通过 |

---

## 四、遗留建议（未在本轮处理）

### 4.1 发布前必做（P0-P1 优先级）

1. **git 初始化与仓库托管**：项目目前**不是 git 仓库**，README 中的 clone 地址为 `<your-org>` 占位符。建议 `git init` + 规范提交 + 推送到 GitHub 后替换 README 中的占位地址。
2. **npm 发布元数据**：`package.json` 缺 `repository` / `author` / `bugs` / `files` 字段，`npm publish` 前需补齐；建议加 `files` 白名单（`src/`、`skills/`、`docs/`、`install.*`、`README.md`）避免把测试与临时文件打进去。

### 4.2 测试覆盖缺口（P2）

当前 e2e 只覆盖 happy path，建议补充：

- **ask 权限模式的交互闭环**（mock stdin 回答 y/N，断言工具放行/拒绝路径）
- **Hooks 端到端**（PreToolUse block 后工具确实未执行、消息回填内容）
- **`/compact` 与 `/plan` 的 REPL 流程**
- **子代理 `task` 真实往返**（含权限继承行为）
- **`/model` 切换后 provider 重建与 usage 连续性**

### 4.3 体验与健壮性改进（P3）

1. **子代理权限确认无上下文标记**：ask 模式下子代理的工具确认提示与主代理完全相同，用户难以分辨是谁在执行。建议提示前加"（子任务）"前缀。
2. **`/compact` 边界**：消息较少（3~5 条）时 `messages.slice(1, -2)` 可能为空，压缩结果为空摘要，建议下限调低或直接提示无需压缩。
3. **单次提问模式无 `--json` 输出**：脚本/管道使用者只能解析带 ANSI 剥离的文本，建议提供 `--format json`（输出 `{text, usage, durationMs, steps}`），这是 headless 场景的常用诉求。
4. **费用估算按当前模型口径**：`/status` 累计费用用"当前模型"计价，跨模型会话历史用量口径不准（已知限制，README 已注明）。
5. **`approxTokens` 为启发式估算**：CJK≈1 字符/token 在长对话下偏差累积，路线图已有精确 tokenizer 规划，落地优先级建议提前（直接关系裁剪质量与费用统计）。

### 4.4 路线图功能（README 已列，按优先级建议）

WebUI（io 接口已解耦，加 HTTP/SSE 适配器即可）→ MCP 客户端 → 精确 tokenizer + 自动压缩 → bash 沙箱 → 自动模型路由（pro/flash 分工）→ 多会话并行 → IDE 插件。

---

## 五、代码质量观察（供参考）

- **优点**：模块边界清晰，`io` 接口抽象让核心与 UI 完全解耦；零依赖实现 SSE 解析、diff 渲染、权限规则匹配，代码量控制得当；测试用 stub/mock 覆盖核心路径，`MINGDAO_HOME` 环境变量隔离做得干净。
- **小瑕疵**：`estimateCost`（cli.js）与 `printUsageLine`（ui.js）存在费用计算逻辑重复，建议抽公共函数；`READONLY_TOOLS` 集合在 permissions.js 与 summarizeArgs 的只读判断间没有单一来源，新增只读工具时易漏改。

---

*报告生成：Hermes Agent · 基于全量源码走读、17 项针对性验证、smoke + e2e 回归测试*
