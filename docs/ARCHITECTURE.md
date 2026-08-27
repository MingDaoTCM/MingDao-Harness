# MingDao-Harness 架构设计

本文档说明 MingDao 的设计决策、架构分层，以及对四个参考实现的学习结论。

## 1. 对参考实现的学习

| 参考实现 | 值得借鉴的设计 | MingDao 的采纳 |
| --- | --- | --- |
| **Claude Code** | TUI 会话循环；工具循环（模型 ↔ 工具调用）；权限系统（ask / acceptEdits / bypassPermissions + allow/deny 规则）；`--continue`/`--resume` 会话续聊；headless `-p` 模式；AGENTS.md 目录约定 | 全部采纳（TUI + 三档权限 + JSONL 会话 + 单次提问 + AGENTS.md） |
| **OpenAI Codex CLI** | TypeScript 单体；skills；沙箱化 bash；config.toml 分层配置 | 采纳「配置分层 + 预设目录」；skills/沙箱进入路线图 |
| **DeepSeek-Harness** | Cordis「一切皆插件」组合架构；`llm-retry` 自动重试；`token-meter` 计量；context 预算与 compaction 分层；host/client 解耦 | 采纳「重试 + 计量 + 预算裁剪 + UI 与核心解耦」；以轻量注册表（Provider/Tool）替代重依赖的插件内核，保持零依赖 |
| **CodeWhale** | 单一耐用运行时（TUI / `exec` / Fleet 同内核）；审批策略引擎独立（execpolicy）；SQLite 持久化；OpenAI + Anthropic 双适配层；MCP/hooks 分层 | 采纳「权限引擎独立 + Provider 适配层」；`mingdao "…"` 单次提问即 headless 入口；SQLite/MCP/hooks 进入路线图 |

**结论**：一个 Harness 的最小可行内核 = `模型 Provider 层 + 工具注册表 + 权限引擎 + 上下文管理 + 会话持久化`，UI 只是内核的一个适配器。MingDao 按此分层实现。

## 2. 总体架构

```
┌────────────────────────────────────────────────────────────┐
│                     UI 适配层（可替换）                      │
│   TUI（流式 Markdown/代码高亮/diff 预览/spinner/中断/补全）  │
│   · 单次提问 headless · WebUI（HTTP+SSE，复用同一 io 抽象）                          │
└───────────────────────────┬────────────────────────────────┘
                            │ io 接口（print/ask/confirm/流式写入）
┌───────────────────────────▼────────────────────────────────┐
│                      Agent 核心循环（agent.js）              │
│   消息 → Provider（流式）→ 工具调用？→ 权限引擎 → 执行工具    │
│        → 结果回填 → 循环（上限 24 步）→ 输出最终文本          │
└──────┬──────────────────────┬──────────────────────┬────────┘
       │                      │                      │
┌──────▼──────┐   ┌───────────▼───────────┐  ┌───────▼────────┐
│ Provider 层 │   │ 权限引擎 permissions.js │  │ 上下文管理      │
│ 注册表+工厂  │   │ ask/auto/readonly      │  │ token 估算+裁剪 │
│ 重试/超时   │   │ + allow/deny 规则      │  │ 工具输出截断    │
└──────┬──────┘   └───────────────────────┘  └────────────────┘
       │
┌──────▼───────────────────────────────────────────────┐
│ OpenAI 兼容协议（HTTP + SSE 流，DeepSeek/OpenAI/...）  │
│ 自定义 Provider 模块（~/.mingdao/providers/*.mjs）    │
└──────────────────────────────────────────────────────┘

横切：config.js（~/.mingdao/config.json + 向导，不含密钥） · credentials.js（~/.mingdao/credentials.json，密钥独立凭证库，权限 600） · session.js（JSONL）
```

## 3. 技术选型与关键决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 运行时 | Node.js ≥ 18（纯 ESM，**零 npm 依赖**） | 内置 `fetch`/`readline`/`fs` 覆盖全部需求；免构建、免依赖下载，一键安装最可靠 |
| UI 起步形态 | **TUI**（终端会话式） | 实现成本最低（Claude Code 同形态）；核心与 UI 解耦，WebUI/IDE 后置 |
| 模型接入协议 | OpenAI 兼容 chat/completions 作为通用层 | DeepSeek/OpenAI/Qwen/GLM/Kimi/大量网关同协议；非兼容协议走自定义 Provider 模块 |
| 工具协议 | OpenAI function-calling Schema | 与协议层一致，模型无需适配 |
| 会话存储 | JSONL 追加写 | 零依赖、可流式恢复、人类可读；SQLite 留作索引化路线图 |
| 密钥存储 | 独立凭证库 `credentials.json`（600 权限）+ 环境变量 | Key 与 config.json/仓库完全隔离：config 可分享可提交，密钥只在本机；`mingdao key` 命令族管理 |
| 权限 | 独立权限引擎，默认 ask | 借鉴 CodeWhale execpolicy 分层；写/命令类工具默认逐次确认 |
| 上下文 | CJK 感知启发式估算 + 尾部保留裁剪 | 无分词器依赖；保留 system + 最近消息；裁剪插入说明消息 |
| 扩展点 | Provider 模块 / Tool 注册表 / io 接口 / 库 API | 对应 DSH「插件点」思想，但用零依赖注册表实现 |

## 4. 关键组件

### Agent 循环（src/agent.js）
每轮：裁剪消息至预算 → 请求模型（流式输出 text/reasoning）→ 若有 `tool_calls`，逐项走 PreToolUse 钩子 → 权限引擎 → 执行 → PostToolUse 钩子 → `tool` 角色消息回填 → 循环（≤24 步）。返回 text/usage/steps/finish/duration。内置子代理（task）、todo 清单状态、undo 备份仓、Ctrl+C 中断。

### Provider 层（src/providers/）
- `openai-compatible.js`：SSE 增量解析（容错跨 chunk 断行、分片 tool_calls 拼接、`reasoning_content` 渲染）；
- `index.js`：`resolveProviderConfig`（模型预设 → 服务商预设 → config → 凭证库/环境变量）、超时 + 429/5xx 指数退避重试、自定义模块加载。

### 工具层（src/tools/）
文件/命令工具（read/write/edit/ls/glob/grep/bash）+ 智能体工具（skill 技能加载 / task 子代理 / todo 清单 / undo 撤销）；write/edit 自动备份支持 undo（每文件 10 份，会话级）。

### Skills 技能系统（src/skills.js）
渐进式披露：技能清单（名称+描述）注入系统提示，模型按需用 `skill` 工具加载 SKILL.md 全文。三级来源与同名覆盖优先级：**用户级 `~/.mingdao/skills/` > 项目级 `<项目>/.mingdao/skills/` > 内置 `<安装包>/skills/`**（借鉴 DeepSeek-Harness 的 SKILL.md 格式，内置 14 个常用技能）。

### Hooks（src/hooks.js）
PreToolUse（stdin 收 JSON，stdout 输出 `{decision:"block", reason}` 可阻止执行）与 PostToolUse（审计/通知）；matcher 支持 `*`、逗号分隔多工具、前缀通配。协议借鉴 Claude Code hooks。

### 上下文管理（src/context.js）
估算：英文 ≈ 4 字符/token，CJK ≈ 1 字符/token。裁剪：恒保留首条 system，从尾部向前取到预算；被裁剪时插入说明消息。工具输出上限 2 万字符。`/compact` 用模型压缩旧上下文（完整历史保留在会话文件）。

### 权限引擎（src/permissions.js）
只读工具（read/ls/glob/grep/skill）默认放行；写/命令按模式处理。`deny` 优先于 `allow`；规则支持「工具名」与「工具名:参数前缀」模式匹配（如 `bash:git *`）。

### 配置与凭证（src/config.js / src/credentials.js）
- `config.js`：`~/.mingdao/config.json` 与初始化向导。**不含任何密钥字段**，可安全分享、提交仓库。
- `credentials.js`：独立凭证模块。Key 存 `~/.mingdao/credentials.json`（权限 600）；解析优先级为「环境变量 → 本地凭证库 → config.json 显式字段（兼容旧版本）」；提供 `maskKey` 脱敏（前 6 位…后 4 位）与 `mingdao key status/set/remove/import` 命令族。安装包与仓库零密钥，每个用户安装后配置自己的 Key。

### 会话（src/session.js）
`~/.mingdao/sessions/<时间戳>-<随机>.jsonl`，每轮自动追加；`--continue` 载入最近会话，`--resume` 打开选择器（首条消息预览 + 相对时间）；`/init` 生成项目 AGENTS.md，`/memory` 维护用户级记忆（`~/.mingdao/AGENTS.md`），两者自动注入系统提示。

## 5. 面向 DeepSeek-V4 的优化设计

1. **预设调优**：v4-pro（推理/规划：温度 0.4、输出上限 32k、预算 200k）；v4-flash（日常：温度 0.6、输出 8k、预算 128k）；两者 `contextWindow` 均为 384K（正式版规格：2026-08-17 起 V4-Pro 转正商用），预算可随时调高。
2. **推理内容流式展示**：`reasoning_content` 以暗色增量渲染，与正文同流。
3. **峰谷定价适配**：每轮后展示 prompt/completion tokens，便于用户把批处理放在谷时段（v4 系列 2026-08-17 起峰谷定价，高峰＝北京工作日 9:00–12:00、14:00–18:00，闲时价＝高峰一半）。官方同时提供 Responses API 与 Anthropic 兼容接口；MingDao 默认走 OpenAI 兼容 chat/completions，如需原生协议可写自定义 Provider 模块。
4. **模型路由（路线图）**：规划用 v4-pro、执行用 v4-flash 的自动分工；Provider 抽象已支持任意切换。
5. **可靠性**：超时 + 指数退避重试，长上下文下避免瞬时错误中断任务。

## 6. 扩展指南速览

- **加一个模型网关**：`mingdao init` → custom → 填 baseUrl（OpenAI 兼容即可）。
- **加一个非兼容协议**：见 [PROVIDERS.md](PROVIDERS.md) 的模块示例。
- **加一个工具**：在 `src/tools/index.js` 的 `TOOLS` 里加 Schema + `dispatch` 分支（返回 `{ok, output|error}`）。
- **换 UI**：实现 `io` 接口（print/writeText/writeReasoning/ask/confirm/choose），`createAgent` 不感知终端。
- **库方式复用**：`import { createAgent, createProvider, dispatch } from 'mingdao-harness'`。

## 7. 路线图

WebUI（HTTP/SSE 适配器）→ MCP 客户端 → 子代理与 plan 模式 → 精确 tokenizer + 自动压缩 → Hooks/Skills → SQLite 会话检索 → bash 沙箱 → IDE 插件。
