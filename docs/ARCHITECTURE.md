# MingDao-Harness 架构设计

> 版本口径：v0.6.8。本文档覆盖 `src/` 全部 **88** 个模块（`find src -name '*.js' | wc -l` = 88），
> 按层给出每个模块的职责与它守住的那条不变量；判定以文件头注释与实际实现为准，不做推断性描述。
>
> 阅读顺序建议：§2 模块索引（查「某件事归谁管」）→ §3 数据流（看一次回合怎么走）→ §4 已知边界（看它**保证不了**什么）。
> 用户视角的配置项见 [CONFIG.md](CONFIG.md)，扩展契约见 [DEVELOPER.md](DEVELOPER.md) 与 [PACK-API.md](PACK-API.md)。

## 1. 总体形态

MingDao 是一个「模型循环 + 工具 + 权限」内核，纯 Node.js ≥ 18.17、纯 ESM、**零 npm 运行时依赖**，
无构建步骤。能力以库形式导出（`src/index.js`），UI 只是内核的一个适配器。

```
┌──────────────────────────────────────────────────────────────┐
│ UI 适配层（可替换）                                           │
│  TUI（ui.js） · 单次提问/headless（cli.js）                    │
│  WebUI（web/**，HTTP + SSE）· 后台任务（tasks/worker.js）      │
└───────────────────────────┬──────────────────────────────────┘
                            │ io 接口（print / writeText / writeReasoning / ask / confirm / choose）
┌───────────────────────────▼──────────────────────────────────┐
│ Agent 核心循环（agent.js）                                     │
│  上下文裁剪 → Provider 流式请求 → PreToolUse 钩子 → 约束引擎     │
│  → 权限引擎 → 工具执行 → PostToolUse 钩子 → 结果回填 → 循环      │
│  （≤24 步/轮，最多 3 轮续跑）→ 输出 + 渲染 + 账本 runEnd         │
└───┬───────────────┬───────────────┬───────────────┬──────────┘
    │               │               │               │
┌───▼─────┐  ┌──────▼───────┐  ┌─────▼───────┐  ┌────▼──────────┐
│Provider │  │ 权限 permissions│ │ 工具 tools/ │  │ 上下文 context │
│providers/│ │ + 约束 constraints││ + 围栏 ssrf/ │  │ + tokenizer   │
│ 路由/计价 │  │ + Hooks      │  │   net-guard │  │ + compact     │
└───┬─────┘  └──────────────┘  └─────────────┘  └───────────────┘
    │
┌───▼──────────────────────────────────────────────────────────┐
│ OpenAI 兼容协议（HTTP + SSE）· 自定义 Provider 模块（<home>/providers/*.mjs）│
└──────────────────────────────────────────────────────────────┘

横切基础设施：config.js / credentials.js（凭证与配置分离）· atomic-write.js（原子写 + 跨进程锁）
             session.js / ledger.js / audit.js（三类落盘记录，语义各不相同）
```

技术决策与理由：

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 运行时 | Node.js ≥ 18.17，纯 ESM，零 npm 依赖 | 内置 `fetch`/`readline`/`node:http` 覆盖全部需求；免构建、免依赖下载 |
| 模型协议 | OpenAI 兼容 `chat/completions` 为通用层 | DeepSeek/OpenAI/Qwen/GLM/Kimi 与多数网关同协议；非兼容协议走自定义 Provider 模块 |
| 工具协议 | OpenAI function-calling Schema | 与协议层一致，模型无需适配 |
| 会话存储 | JSONL 追加写 | 零依赖、可流式恢复、人类可读；检索另建倒排索引（session-index.js） |
| 密钥存储 | 独立凭证库 `credentials.json`（600） | `config.json` 可分享可提交，密钥只在本机；`mingdao key` 命令族管理 |
| 权限 | 独立权限引擎，默认 `ask` | 写文件/执行命令默认逐次确认；`deny` 优先于 `allow` |
| 上下文 | 官方 BPE 词表精确计数 + 启发式兜底 | `tokenizer.js` 内置官方词表（`assets/tokenizer-data.json.gz`，762,629 B）；无词表的模型才回退估算 |
| 扩展点 | Provider 模块 / Tool 注册表 / io 接口 / Pack / Preset / Hooks / MCP | 零依赖注册表实现，不引入插件内核 |

## 2. 模块索引

以下逐文件列出 `src/` 全部 88 个模块。每条格式为「职责 —— 关键不变量/边界」。

### 2.1 内核循环与上下文（6）

- `agent.js` —— Agent 核心循环：消息 → 模型（流式）→ 钩子 → 约束 → 权限 → 工具执行 → 回填 → 循环，直至模型给出纯文本；附带子代理（task 工具）、todo 状态、undo 备份仓、Ctrl+C 中断 —— 每回合结局由 `outcome` 单一来源收敛，返回值与账本 `runEnd` 必须同源。
- `context.js` —— token 计数与预算裁剪：恒保留首条 system，从尾部向前取到预算，被裁剪时插入说明消息；工具结果上限 20000 字符（`TOOL_RESULT_LIMIT`）—— 计数优先走 `tokenizer.js` 精确计数，只在无词表模型上回退启发式；截断按码点安全切分，不留孤立代理项。
- `tokenizer.js` —— 精确 tokenizer：内置 DeepSeek 官方词表（`assets/tokenizer-data.json.gz`）做字节级 BPE 计数，内容级缓存使同一文本重复计数为 O(1)；非 DeepSeek 模型回退启发式估算（英文≈4 字符/token、CJK≈0.75 token/字）—— 只用于上下文预算计数，不输出 token id；词表加载失败会重试而非终生锁死。
- `routing.js` —— 自动模型路由：长文本 + 规划关键词 → planner，极短指令 → executor，其余用 executor 模型做一次约几十 token 的分类（结果按文本哈希 LRU 缓存）；执行类会话粘滞，避免 pro⇄flash 抖动破坏缓存前缀 —— 子代理固定走 executor。
- `titles.js` —— 会话标题自动生成：首轮完成后用 executor 模型生成简短中文标题并重命名会话文件（`autoTitle: false` 可关）—— 生成失败只跳过，不影响回合结论。
- `model-caps.js` —— 模型能力解析的单一来源：上下文窗口 / 单次最大输出 / 是否本地部署，供预算推导、超时、工具截断统一引用 —— 本地判定复用 `ssrf-guard.js#isPrivateHost`，不另维护一份；本地小模型自动收紧预算与超时。

### 2.2 Provider 与计价（8）

- `providers/index.js` —— Provider 注册表与工厂：`resolveProviderConfig`（模型预设 → 服务商预设 → config → 凭证库/环境变量）、超时与 429/5xx 指数退避重试、自定义模块加载（`<home>/providers/<name>.mjs`）—— 解析优先级只此一份。
- `providers/openai-compatible.js` —— OpenAI 兼容协议的 HTTP + SSE 流式客户端：增量解析容错跨 chunk 断行、分片 tool_calls 拼接、`reasoning_content` 分流 —— 只负责协议搬运，不感知权限与工具语义。
- `models.js` —— 模型与服务商预设目录：上下文窗口 1M、`maxOutputCeiling` 384K、pro/flash 的温度与输出上限、缓存命中价差（命中价 = 未命中 1/30）、峰谷价 —— 默认模型名与价格表的唯一来源，禁止在别处写模型名字面量。
- `model-discovery.js` —— 模型动态发现：按已设 Key 的服务商拉取线上 `/models` 名单，缓存 `<home>/model-cache.json`（TTL 1 小时）—— 线上名单优先，预设只作无网络回退；未收录模型走通用默认参数、计价显示 n/a。
- `pricing.js` —— 费用估算：缓存感知计价（命中部分按 cacheHit 价，未命中按 input 价）、峰谷判定锚定北京时间（高峰 = 周一至周五 9:00–12:00 与 14:00–18:00，其余含午间与周末为闲时半价）、避峰顺延（`deferToOffpeak`）—— 峰谷按**请求发起时刻**判定，非法时区回退必须与日界/护栏同源；价格可按 `pricing.overrides` 覆盖。
- `cachestats.js` —— 缓存命中统计：每轮用量落 `<home>/cache-stats.jsonl`（`{at, model, prompt, completion, hit, miss, cost, saved}`），支撑命中率仪表盘与 `/cost` 分解 —— 区分 ENOENT 与读失败（`listCacheStatsStrict`），读失败不得当成 0。
- `cost-guard.js` —— 费用护栏：按北京时间自然日累计真实费用，`warn` 线提醒、`limit` 线按 `action` 处理（`warn` / `block` / `downgrade` 到便宜模型）—— 长回合把在途费用并入今日已用，否则统计文件不变会烧穿日限。
- `batch.js` —— Batch API 半价通道：单轮批量任务（无工具、无流式）走 OpenAI 兼容批处理协议（`/files` → `/batches` → 轮询 → 下载结果，DeepSeek 风格结果端点回退 OpenAI）—— 端点不可用（404/405）必须明确报错告知网关不支持，**绝不静默假装成功**；计费按闲时全未命中 × 0.5，结果记入 `cachestats.js`（`batch: true`）。

### 2.3 工具与围栏（12）

- `tools/index.js` —— 工具注册表：模型可见的工具 Schema（OpenAI function-calling 格式）与执行分发器，含第三方 `registerTool` 与 `config.tools` 挂载 —— Schema 与 dispatch 分支必须成对增加。
- `tools/fs-tools.js` —— 文件系统工具 read / write / edit / ls / glob / grep：统一返回 `{ok, output?|error?}` —— 工作空间围栏 `withinRoot()` 对悬空软链递归复检、深度超 16 层 fail-closed；写/编辑自动备份供 undo。
- `tools/bash.js` —— bash 工具：子进程执行、超时强杀、输出截断；沙箱三档 `off` / `readonly`（全盘只读 + /tmp tmpfs）/ `safe`（只读文件系统 + `--unshare-net` 断网 + 工作目录可写）—— 仅 Linux + bubblewrap 可用，缺失时降级为 `off` 并在结果中注明，不静默假装沙箱。
- `tools/fetch.js` —— HTTP 只读抓取工具：GET 任意 http(s) URL，返回文本（512KB 上限，正文截 20K）—— 只保留工具契约（参数校验、呈现口径、错误措辞），实际抓取整条走 `safeFetchText`。
- `tools/git.js` —— git 只读工具：仅允许 `status/log/diff/show/blame/rev-parse/branch/tag/ls-files/shortlog`，经 `execFile` 无 shell 执行 —— 白名单之外的子命令一律拒绝。
- `permissions.js` —— 权限引擎：三档 `ask`（默认，只读自动放行）/ `auto` / `readonly`，规则支持「工具名」与「工具名:参数前缀」模式 —— `deny` 优先于 `allow`；非法模式一律退回 `ask`。
- `constraints.js` —— 约束引擎 v1（Pack API v1）：PreToolUse（`tool-deny` / `tool-arg-require` / `arg-forbid` / `confirm`）、PostToolUse（`completeness` / `result-forbid`）、输出前（`output-forbid`）三个执行时机 —— **只能收紧、不能放松**，不授予权限也不改变权限引擎判定；pattern 类约束装载即 fail-closed 校验，非法正则必须报错而非静默永不命中。
- `regex-safety.js` —— 灾难性回溯（ReDoS）判定的单一来源：只拦「被量词修饰的组内出现歧义分支/嵌套量词」这类教科书形状 —— 判定对象来自第三方 Pack 与用户配置、匹配对象是模型输出，装载时 fail-closed 拒绝；`(a|b)+`、`(ab)+` 等常见安全写法不误伤。
- `ssrf-guard.js` —— SSRF 判定 + DNS 钉扎的单一来源：字面量私网/回环/元数据拒绝（含 IPv6 全形态、IPv4-mapped、NAT64）、域名必须解析且逐个地址判定、校验通过的地址 `pinned` 给连接层 —— 三条口径必须同时满足，任何一条不确定就 fail-closed；解析失败不能当安全判据。
- `safe-fetch.js` —— 带逐跳 SSRF 复检的文本下载单一来源：`redirect:'manual'` + 每跳过 `ssrf-guard` + 跳数上限，每跳显式过出网闸门并记账 —— 新增下载路径必须走这里，不得再写第二份；跨源重定向按反向白名单剥头。
- `net-policy.js` —— 出网白名单策略：纯函数，不碰 IO、不改全局状态，便于单测与文档化 —— 命中哪条规则、拦还是放，判定只此一份。
- `net-guard.js` —— 出网闸门：在 `globalThis.fetch` 收口做出口判定 + 记账，`guardEgress()` 供 `node:http(s)` 路径（safe-fetch、sync 的 rawRequest）复用 —— **默认不安装**（未配置 `config.net` 时完全不介入）；只覆盖内核自己发起的请求，不代表整机不出网。

### 2.4 会话 / 记忆 / 任务（10）

- `session.js` —— 会话持久化：`<home>/sessions/<时间戳>-<随机>.jsonl` 每轮追加，`--continue` 载入最近一次，`--resume` 打开选择器 —— 会话文件是消息结构的唯一权威，检查点等旁挂状态另存侧车文件。
- `session-index.js` —— 会话检索索引：词表倒排 + 按 mtime/size 的增量同步，分片存 `<home>/sessions-index/<2位sha1前缀>.json`（256 片）—— 未变化直接用缓存词表，>8MB 文件跳过并移除条目；中文按 bigram + 单字、查询串同口径分词后 AND 匹配。
- `memory.js` —— 长记忆与自主进化：用户记忆 `~/.mingdao/AGENTS.md`（手动 + 会话结束自动提取用户偏好并去重追加）、会话日志 `journal.jsonl`（默认不注入系统提示，`--journal` / WebUI 勾选才取最近 3 条）—— 自动提取用 executor 模型（约几十 token），`autoMemory: false` 可关。
- `tasks.js` —— 多会话后台任务面板：`mingdao run` 拉起独立 worker 子进程，状态落 `<home>/tasks/<id>.json`，命令族 `run` / `tasks` / `tasks watch` / `tasks kill` —— taskId 用不可枚举随机值；kill 前必须过 PID 归属校验（见 `proc.js`）。
- `tasks/worker.js` —— 后台任务 worker：独立进程执行一轮任务并写状态文件，复用 Agent 核心（权限/模型/MCP/标题/会话/入账/通知/自动同步）—— 无交互，`ask` 权限降级为 `readonly`。
- `task-state.js` —— 任务检查点：把「一轮跑满即止」升级为「可续跑」，状态存 `<home>/taskstates/<会话名>.json`（原子写 + 锁）—— 只记 `cap` / `interrupted` 两种可续跑状态，任务正常完成即清除。
- `schedule.js` —— 任务队列与调度：单 `schedule-daemon` 进程以协程监督全部定时任务（一次性/周期）与依赖编排（`after`/链式），到期拉起 worker；状态落 `<home>/schedule/<id>.json`，`daemon.pid` 防重复 —— 旧式逐任务 sleeper 只作 daemon 启动失败的兜底；`tasks`/`run` 触发时自动 reconcile 补挂到期任务。
- `compact.js` —— 上下文自动压缩：超预算且被裁段落达阈值时，先用 executor 模型压成摘要以单条 user 消息注入，替代静默失忆 —— 被裁段落不足阈值仍走普通裁剪；摘要失败绝不阻塞会话，异常一律回退普通裁剪；保留段头部经 `cleanToolPairing` 清洗孤儿 tool 消息。
- `prompts.js` —— 系统提示词构建：基础角色 + 用户记忆 + 技能清单 + 项目 AGENTS.md + Pack 提示段（`packPromptBlock`）—— 记忆类内容必须「关不住围栏」，零宽/双向控制字符需剥离；断行/围栏闭合由 `fencedBlock` 统一处理。
- `workspace.js` —— 会话级工作空间：登记/切换/重命名/删除，每个会话记住自己的项目目录，多任务并行不串目录 —— 本模块加锁函数**全部**使用异步版 `withFileLock`，因为它正好在 WebUI 请求路径上（同步版会冻结整个事件循环）。

### 2.5 合规与账本（3）

- `ledger.js` —— 执行账本：一次回合 = 一个文件，事件流（`runStart` / `toolCall` / `constraint` / `permission` / `usage` / `netEgress` / `runEnd`）可导出、可校验、可回放 —— 三条不可让步的纪律：写入即脱敏、摘要替代原文（`*Digest`）、降级必须可见；`runEnd` 额外写封条侧车文件，使「尾部截断但链内自洽」可检出。
- `audit.js` —— 工具调用审计日志：每次调用（含被拒/被钩子阻止/参数解析失败）落 `~/.mingdao/audit.jsonl`（600），纯追加 + >20000 行保留最近 10000 行 —— 记录做轻量脱敏，`config.audit: false` 可关（默认开）。
- `replay.js` —— 决策回放：把账本里的工具调用序列按**当前**权限/约束栈重新评估 —— 承诺「决策回放」（历史上这些操作用今天的规则重判会被拦哪些），**不承诺**模型级回放；用的是账本中已脱敏的参数，依赖被掩码内容的规则可能不命中。
- `redact.js` —— 统一脱敏：`redactSecrets`（密钥前缀/Bearer/URL 内嵌凭据）与 `redactSensitive`（叠加私网 IP + 家目录掩码）—— 审计/日志/会话/诊断/错误消息共用同一套规则，禁止各层自扫门前雪。

### 2.6 同步与共享（2）

- `sync.js` —— 云同步客户端：会话 JSONL 跨设备同步，配置在 `config.json` 的 `sync`（无秘密），凭证在 `credentials.json` 的 `sync`（600）—— 冲突规则绝不丢数据：push 前先把远端备份为 `.server-<时间戳>.jsonl`，pull 时本地不动、远端写 `.remote-<时间戳>.jsonl`；`auto` 静默推送失败不影响对话。
- `sync-server.js` —— 云同步服务端（零依赖 `node:http/https`）：账号 + 设备 token + 会话存储，数据布局 `<DATA_DIR>/users.json`、`devices.json`、`data/<用户名>/sessions/` —— 密码存 `sha256(salt:password)`，设备 token 只存哈希；注册开关 `open` / `invite` / `closed`。

### 2.7 Web 层（13）

- `web/server.js` —— WebUI 服务器：零依赖 `node:http` + SSE，复用 `createAgent` + `createPermission` + `createWebIO` —— 非回环绑定强制访问令牌（参数/配置/本次随机生成，`timingSafeEqual` 比对）；Host 白名单防 DNS rebinding；同一会话并发回合由进程级 `busySessions` 串行化。
- `web/routes/api.js` —— API 编排器：访问控制（token / Host / CSRF）→ 静态壳资源 → 按域分发 —— 跨站浏览器请求按 `Sec-Fetch-Site` 一律 403。
- `web/routes/domains/config.js` —— 配置域：`/api/state` `/api/config` `/api/models-config`，服务商 Key 管理、自定义模型增删改、API 地址覆盖、系统状态快照 —— `endpointChangeGuard` 防「改地址把 Key 送到别处」。
- `web/routes/domains/sessions.js` —— 会话域：`/api/sessions` `/api/session` `/api/draft`，列表/搜索、载入（聚焦工作空间）、重命名/删除、按会话隔离的草稿槽。
- `web/routes/domains/skills.js` —— 技能域：`/api/skills` `/api/skill-library` `/api/mcp-presets`，技能列表/安装/卸载、内置库与线上注册表搜索、MCP 预设接入。
- `web/routes/domains/schedule.js` —— 调度域：`/api/schedule` `/api/tasks`，定时任务增删暂停恢复/链式编排，聊天 SSE 任务 + 后台 worker + 调度任务合并面板。
- `web/routes/domains/sync.js` —— 同步域：`/api/sync` `/api/sync-conflicts`，登录/登出/推拉/改密/分享与冲突处理。
- `web/routes/domains/workspace.js` —— 工作空间域：`/api/workspaces` `/api/fs-browse`，登记/切换/重命名/删除与受限目录浏览 —— 登记闸门与浏览基目录共用同一份 `allowedRoots`。
- `web/routes/domains/misc.js` —— 杂项域：`/api/chat` `/api/permission` `/api/abort` `/api/memory` `/api/cache-stats`，对话 SSE 流（并发上限 + 生命周期计数）、权限确认、中断、长期记忆、费用/缓存统计。
- `web/constants.js` —— 前端与服务端共享常量：并发上限 8（`MAX_CONCURRENT`）、附件数与体积上限、单文件读取上限 —— 数值只在此定义，防客户端预检/服务端校验/工具读取三处漂移。
- `web/attachments.js` —— 聊天附件构造（纯函数）：图片转 `data:` URL（仅视觉模型，单张 ≤5MB、最多 4 个），文本文件拼接进消息（≤200KB）—— 服务端按同一组常量校验。
- `web/web-io.js` —— WebUI 的 io 适配器：把 Agent 的 io 事件翻译为 SSE 事件，权限确认/选择类交互经 `askHandler` 转发到浏览器模态框并等待 `POST /api/permission` 应答。
- `web/util.js` / `web/app.js` —— 前端：`util.js` 是零状态工具（选择器/转义/Markdown/格式化），`app.js` 是页面主脚本（消息渲染与轨迹、设置面板、自绘气泡与模态框）—— 地址带 `?token=` 时记入 `sessionStorage` 并从地址栏移除，此后请求统一附加 `X-MingDao-Token`。

### 2.8 CLI 层（13）

- `cli.js` —— CLI 入口与唯一 argv 解析点：初始化向导、凭证管理、单次提问、交互式会话分发；会话能力含 `/plan` `/compact` `/init` `/memory` `/skills` `/mode` `/verbose` `/status` `/cost` —— 遇第一个位置参数即停止解析全局 flag，子命令 flag 交子命令自行解析（防 `mingdao run "任务" --model X` 被顶层剥除）。
- `commands/repl.js` —— 交互式 TUI REPL 主循环：斜杠命令 + 多行输入 + 回合执行 + 自动压缩/标题/记忆/同步。
- `commands/key.js` —— `mingdao key`：status / set / remove / import，凭证库读写与掩码展示。
- `commands/update.js` —— `update` / `rollback` / `batch` / `cost` / `audit` 子命令 —— 每个 handler 返回 `true` 表示已处理，`false` 表示按普通提问继续（子命令劫持防护）。
- `commands/ledger.js` —— `mingdao ledger`：list / show / export（json|md，脱敏）/ verify（哈希链 + 封条）/ replay —— 输出必须写明它证明不了什么：哈希链只证明自写入后未被改动，不含可信时间戳，导出物字段经过截断。
- `commands/net.js` —— `mingdao net`：report（`[--since 7d|24h|N] [--json]`）与 policy —— 用途是自证「内核没有偷偷外传」，因此输出必须同时说清边界。
- `commands/pack.js` —— `mingdao pack`：list / trust / untrust / verify / new / info —— `pack verify` 默认**只做静态校验、不 import Pack 代码**（在 CI 上执行被审仓库代码是越权），要执行须显式 `--runtime`。
- `commands/schedule.js` —— `mingdao tasks` / `mingdao schedule`：任务与定时任务的增删改查、暂停恢复、链式编排、终止与守护进程状态。
- `commands/skill.js` —— `mingdao skill` / `web` / `sessions`：技能安装/卸载/重装/信任、启动 WebUI、会话检索 —— `--auth-token=-` 从 stdin 读，避免令牌进 argv/shell 历史。
- `commands/sync.js` —— `mingdao sync`：login / logout / passwd / share / shares / accept / unshare / conflicts / conflict-resolve / push / pull / status。
- `commands/workspace.js` —— `mingdao workspace` 与 `mingdao mcp preset`：工作空间登记切换、MCP 生态预设列出与接入。
- `commands/desktop.js` —— `mingdao desktop`：定位仓库、检查 `desktop/node_modules` 里的 Electron 并拉起，缺依赖给出镜像安装指引。
- `commands/diagnose.js` —— `mingdao diagnose`：只读打包诊断信息（环境/版本/config 脱敏/日志尾/审计尾/工作空间），凭证库只注明存在不读内容 —— 单文件输出，便于贴到反馈渠道。

### 2.9 运行时基础设施（19）

- `config.js` —— 配置管理：`<mingdao-home>/config.json`（默认 `~/.mingdao/config.json`）与初始化向导，优先级「命令行 > 环境变量 > config.json > 内置预设」—— 文件**不含任何密钥字段**；损坏配置会被隔离（`quarantineCorruptConfig`）而非静默重置。
- `credentials.js` —— 凭证管理：Key 存 `<home>/credentials.json`（600，保存时 chmod 收权），解析优先级「环境变量 > 凭证库 > config.json 显式字段（兼容旧版）」—— 绝不写入仓库、绝不写入 `config.json`；提供 `maskKey` 脱敏。
- `atomic-write.js` —— 原子写与跨进程互斥：`atomicWriteFileSync`（tmp 名含 pid + 随机后缀，写完 rename）、`withFileLockSync`（O_EXCL lockfile + 超时 + 陈旧锁回收）、`withFileLock`（同语义异步版）—— 常驻服务请求路径必须用异步版：同步版用 `Atomics.wait` 会让整个事件循环停摆。
- `proc.js` —— 进程身份核验：判断「pid 活着」与「pid 仍属于我启动的那个进程」；判定语义严格区分 `true`（命令行含 needle）/ `false`（明确不是自己的进程，绝不能杀）/ `null`（无从判断，由调用方 best-effort）—— 把 `null` 当 `false` 就会误杀复用 pid 的无关进程；同时提供 EPIPE 管道守卫。
- `hooks.js` —— 生命周期钩子（PreToolUse / PostToolUse）：向子进程 stdin 写 JSON，`PreToolUse` 的 stdout `{decision:"block", reason}` 可阻止执行 —— matcher 支持精确名、逗号分隔多名、`*` 通配；PostToolUse 只记录不阻塞。
- `mcp.js` —— MCP 客户端（零依赖 stdio 传输 + JSON-RPC 2.0）：配置 `config.json` 的 `mcpServers`，工具命名 `mcp__<服务器>__<工具>` 后与内置工具合并 —— 服务器以子进程运行，其网络行为不受 `net-guard.js` 约束。
- `mcp-presets.js` —— MCP 生态预设：9 个官方常用服务器的一键接入目录 —— 每个可用预设**钉死版本**（`<pkg>@<version>`），npx 不再按 dist-tag 漂移；升级是改这里版本的**有意动作**。
- `skill-registry.js` —— 线上技能库客户端：默认仓库 registry 的 `registry/index.json`（github/gitee/gitcode 三镜像回退），`MINGDAO_REGISTRY_URL` 可指向企业内网自建；本地缓存 TTL 1 小时 —— 逐文件 sha256 校验，索引缺哈希时 **fail-closed 拒绝安装**。
- `skill-lib.js` —— 技能库安装器：来源四选一（内置库名 / 本地目录 / 远程 URL / git 仓库），统一装到用户级 `<home>/skills/<name>/` 并记录 `.mingdao-source.json` —— 下载路径必须走 `safeFetchText`，不得自己写第二份。
- `skills.js` —— Skills 技能系统：三级来源覆盖优先级「用户级 `<home>/skills/` > 项目级 `<项目>/.mingdao/skills/` > 内置 `<安装包>/skills/`」，每个技能一个目录含 `SKILL.md` —— 清单（名称+描述）注入系统提示，全文按需用 `skill` 工具加载（渐进式披露）；项目级技能来源不可验证，标注提示且 `disableProjectSkills` 可整层关断。
- `presets.js` —— Agent Preset：把「系统提示 + 工具集 + 权限 + 模型 + 参数」打包为可安装/分享的 JSON；发现顺序「项目级 > 用户级 > 内置」—— 未知字段校验报错（防拼写错误静默失效）；`model` 只是建议，WebUI 以用户当前模型为准。
- `packs.js` —— 垂域 Pack 加载器（Pack API v1）：manifest（`pack.json`）+ contributions（`pack.mjs`）—— 坏 Pack 绝不阻塞启动（每条贡献独立 try/catch，失败只 warn 并跳过）；加载幂等；静态校验与动态 import 分离；`permissions` 只是**声明**，内核不据此强制。
- `autostart.js` —— 开机自启：Linux XDG `.desktop` / Windows 启动文件夹 `.bat` / macOS LaunchAgent plist —— 命令 `mingdao autostart on|off|status`。
- `notify.js` —— 桌面通知（零依赖）：后台任务完成/失败时经 `notify-send` / `osascript` / PowerShell 弹出 —— `config.notify` 可关，通知失败静默忽略，绝不影响任务流程。
- `update.js` —— 自更新：`update`（拉取并跑冒烟测试，失败自动回滚）、`update --check`、`rollback`（依据 `<home>/update-state.json`）—— 安装形态是仓库 + 全局符号链接，仓库更新即命令更新。
- `log-writer.js` —— 统一日志写入器：追加写 + 超限轮转（改名式，不做 O(n) 全量重写）—— 桌面主进程与 Web 服务端共用同一实现，消除双文件口径漂移。
- `ui.js` —— TUI 输入输出层：流式 Markdown 渲染、轻量语法高亮、写入预览与编辑 diff、bash 退出码徽章、思考流、spinner、Ctrl+C 中断、Tab 补全、会话横幅与状态行 —— 核心引擎只依赖 io 接口，换 UI 只需实现同一接口。
- `help.js` —— 帮助文本的唯一来源：CLI 与 REPL 各用 `variant` 声明自己多出来的那几行 —— 两个入口的差异必须是显式的，不允许各存一份正文。
- `index.js` —— 库公共 API：导出 `@stable`（minor 内向后兼容）与 `@experimental` 两组能力，契约与示例见 DEVELOPER.md。

模块计数核对：6 + 8 + 12 + 10 + 3 + 2 + 13 + 13 + 19 = **86** 个条目，其中 §2.7 的
`web/util.js` / `web/app.js` 一条覆盖 2 个文件，故条目覆盖 **88** 个 `src/**/*.js`，
与 `find src -name '*.js' | wc -l` 的结果一致。

## 3. 数据流：一次 `runTurn` 的关键路径

以 CLI（`cli.js` / `commands/repl.js`）、WebUI（`web/routes/domains/misc.js#/api/chat`）与后台任务（`tasks/worker.js`）三条入口为例，
它们最终都汇聚到同一个 `agent.js#runTurn`。

**① 入口与准备**

1. `cli.js` 解析 argv（遇第一个位置参数即停），或 `web/server.js` 收到 `POST /api/chat` 并过掉令牌/Host/CSRF 三道闸；
   或 `schedule.js` 到期拉起 `tasks/worker.js` 子进程。
2. `config.js#loadConfig` 读配置，`credentials.js` 按优先级解析 Key，`model-caps.js` 依据模型解析窗口/输出上限/是否本地，
   `pricing.js` 给出当前时段的峰谷单价，`cost-guard.js` 检查今日已用（含在途费用）。
3. `prompts.js` 组装系统提示（角色 + 用户记忆 + 技能清单 + 项目 AGENTS.md + 已挂载 Pack 的提示段）；
   `agent.js` 挂载工具（`tools/index.js` 与 `mcp.js` 合并的 MCP 工具 + Pack 贡献的工具），
   并建立本回合账本 `ledger.js#createLedger(newRunId())`，把出网事件注册成账本 sink（`registerEgressSink`）。

**② 回合内每一步**

4. `context.js` 用 `tokenizer.js` 精确计数，超预算时 `compact.js` 先把被裁段落压成摘要再注入，否则执行尾部保留裁剪。
5. `routing.js` 决定本步用 planner 还是 executor（会话粘滞）；`providers/index.js` 解析出 Provider 配置，
   `providers/openai-compatible.js` 发流式请求，SSE 增量经 `ui.js`（TUI）或 `web/web-io.js` → SSE（浏览器）渲染。
6. 若响应带 `tool_calls`：`hooks.js` 先跑 PreToolUse（`block` 即中止）→ `constraints.js` 求值（可强制人工确认或拒绝）
   → `permissions.js` 判定（`ask` 模式下经 io 询问用户；WebUI 走浏览器模态框）→ `tools/index.js#dispatch` 执行。
7. 工具内部再受各自围栏约束：文件类过 `tools/fs-tools.js#withinRoot`，出网类过 `ssrf-guard.js` + `net-guard.js`
   （`tools/fetch.js` → `safe-fetch.js`），命令类过 `tools/bash.js` 沙箱档。
8. 结果回填为 `tool` 角色消息，`hooks.js` 跑 PostToolUse，`ledger.js` 写 `toolCall` / `permission` / `constraint` / `netEgress` 事件；
   `cachestats.js` 累计用量。回到步骤 4 循环（单轮 ≤24 步，跑满可续跑，最多 3 轮）。

**③ 收束与落盘**

9. 循环出口统一调用 `markOutcome()`，由同一份 `outcome` 同时供返回值与 `ledger.js#runEnd` 使用（口径分裂属缺陷）；
   账本写 `usage` 事件（含 `usageUnknown` 标记）与 `runEnd`，并写封条侧车文件。
10. `session.js` 追加本轮消息到 JSONL，`session-index.js` 增量更新检索分片，`pricing.js` +
    `cachestats.js` 计入费用，`cost-guard.js` 复核日限。
11. `titles.js` 首轮后生成标题并重命名会话文件；`memory.js` 按需提取用户偏好与写 journal；
    `sync.js#maybeAutoSync` 静默推送；`tasks.js#patchTask` 更新任务状态；`notify.js` 弹完成通知。
12. `audit.js` 全程独立记录每次工具调用（含被拒与被钩子阻止），与账本互为补充：
    audit 记「工具调用了什么」，账本记「这一步是怎么被决定的」。

## 4. 已知边界

以下边界是实现的真实状态，写在代码里也写在这里；把它们读成更强的承诺即为误用。

**出网与网络**

- `net-guard.js` 只覆盖内核自己发起的请求。用户在 **bash 里自己敲 curl 不走这里**——那是子进程的网络栈；
  MCP 服务器同样以子进程运行，其网络行为不受闸门约束。它证明的是「内核没有偷偷外传」，不是「这台机器绝对没有外传」。
- `sync.js` 在自签名证书场景走 `node:https`（`rawRequest`）而非全局 `fetch`，该路径由调用方显式调 `decideEgress()` 记账；
  漏调即漏记。
- `safe-fetch.js` 走 `node:http(s)`，不经 `https_proxy` 等环境变量代理；需要代理的部署环境需自行确认可达性。
- `ssrf-guard.js` 的判定是 fail-closed 的保守口径，可能拒绝个别合法的内网域名解析场景。

**平台与进程**

- PID 归属校验是 best-effort：Linux 读 `/proc/<pid>/cmdline`、macOS 用 `ps`、**Windows 两者都读不到**，
  此时返回 `null`（无从判断），调用方按 best-effort 处理——不存在「Windows 上也能确认 PID 归属」的保证。
- bash 沙箱三档仅在 **Linux + bubblewrap** 下成立；其他平台与未装 bwrap 时自动降级为 `off`，只在工具结果里注明。
- `atomic-write.js` 的同步锁在等待期间阻塞整个事件循环，仅限纯同步调用链使用；
  极端争用下仍有 15 处同步锁会阻塞其所在进程（多为守护进程内部或一次性 CLI 命令），未宣称「阻塞面已彻底消除」。

**权限与隔离**

- Pack 的 `permissions`（`fs` / `net` / `env`）只是**声明，内核不据此强制**：`pack.mjs` 在宿主进程内运行，
  可读写任意文件、可出网。装载第三方 Pack 等同于信任其作者；`pack verify` 默认静态校验正是为此。
- `constraints.js` 只能收紧不能放松，但它拦的是**已声明的**红线；没写进 manifest 的行为不会被拦。
- `mcp-presets.js` 钉死版本只保证「装的是哪一个确切版本」，不保证该版本自身安全。
- `skill-registry.js` 的 sha256 校验保护的是传输链路与本地文件；`skills.js` 的项目级技能来源不可验证（仅能发现安装后被改动）。

**WebUI 与多用户**

- **共享令牌 = 同一用户**：同一 token 下 `/api/abort`、`/api/tasks` 没有每客户端作用域，可中断他人任务、读取他人任务消息；
  多人使用需一人一实例（已在 README 安全一节写明）。
- 回环绑定且未配置令牌时不启用认证（本机信任模型）；跨站请求按 `Sec-Fetch-Site` 拒绝，但这依赖浏览器如实上报。
- 桌面版遥测只在 `app.isPackaged` 且未关闭时发一次 POST；CLI 与 WebUI 不发遥测。

**账本与合规**

- `ledger.js` 的哈希链只能证明「自写入后未被改动」，**不含可信时间戳**，不等同于审计级不可否认；
  导出物字段经过截断，不是原始数据的完整副本，不能当作证据原件。
- `replay.js` 只重判决策，不重跑工具、不重放模型输出；用的是已脱敏参数，依赖被掩码内容的规则可能不命中。
- 账本/审计写失败时按「降级必须可见」提示用户，但**不保证**磁盘写满等情况下记录仍然完整。

**Token 与计价**

- `tokenizer.js` 的官方词表只覆盖 DeepSeek 系模型；其他模型回退启发式估算（英文≈4 字符/token、CJK≈0.75 token/字），
  预算裁剪因此是近似值而非精确值。
- 未收录模型无内置价格表，费用显示 n/a，护栏对这类模型只能提示「用量未知」。

## 5. 扩展指南速览

- **加一个模型网关**：`mingdao init` → custom → 填 `baseUrl`（OpenAI 兼容即可）。
- **加一个非兼容协议**：写 `<mingdao-home>/providers/<name>.mjs`，导出 `createProvider(cfg)` 返回 `{ chat(opts) }`，
  见 [PROVIDERS.md](PROVIDERS.md)。
- **加一个工具**：在 `tools/index.js` 的 Schema 表与 `dispatch` 分支成对增加（返回 `{ok, output|error}`），
  或用 `registerTool` / `config.tools` 从外部挂载。
- **加一个垂域 Pack**：`mingdao pack new`，契约见 [PACK-API.md](PACK-API.md)（v1 已冻结）。
- **换 UI**：实现 `io` 接口（print / writeText / writeReasoning / ask / confirm / choose），`createAgent` 不感知终端。
- **库方式复用**：`import { createAgent, createProvider, dispatch } from 'mingdao-harness'`。

## 6. 尚未实现（路线图）

以下条目取自审计登记中明确「未闭合/未纳入本批」的清单，**不是**已发布能力。

- **Pack 子进程隔离**（P2）：`pack.mjs` 目前与宿主同进程，`permissions` 声明无强制力。
- **`ledger --sign-key`**：账本可选签名仍未实现，封条只提升到「防误删/漏写」。
- **出网闸门对子进程的补强**（P1-4，含 bash `curl` 与 MCP 子进程）。
- **在线缓存命中基准**（P0-2）：需要真实 Key 与额度，目前「删 token 不会额外劣化」是推理而非实测。
- **`agent.js` 拆分**（P1-1，`runTurn` 已达千行量级）、**结构化摘要 + 关键事实钉死**（P1-2）、
  **预算状态注入上下文**（P1-3）。
- **sync-server 设备级吊销、push 配额与限流**（M-8）与 **memory 子系统的锁外读-改-写**（M-9）。
- **自更新多镜像取最大版本、`install.sh` 校验和**（H-6/L-18）：供应链完整性锚需要发布流程配合，
  与 `ledger --sign-key`、在线缓存基准同列为 v1.0 前项。
- **Electron 更新包签名校验**与 **IDE 令牌安全存储**：随桌面版/IDE 侧发布流程推进。
- **`require-citation` 约束 kind** 与 `mingdao constraint test <pack>`：契约中已标注「请勿依赖」，
  需先与下游定规格。
