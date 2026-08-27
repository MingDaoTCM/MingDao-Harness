# MingDao-Harness 质检报告

> 质检日期：2026-08-18
> 项目路径：`/home/YouLi/AI/DeepSeek-harness-Space/MingDao-Harness`
> 版本：0.1.54（历史归档；现行 0.1.x 口径见根 README 与各版本 tag。纯 ESM，零 npm 依赖，Node.js ≥ 18.17）
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

## 六、迭代复评（2026-08-18 晚 · 用户两轮修复后）

> 第一节报告发出后，用户按建议完成两轮修复（第二轮 18:19–18:20，第三轮 18:21–18:23，版本升至 **0.5.0**）。以下为逐轮复评结论。

### 6.1 第二轮复评：改进 6 项（全部正确实施 ✅）

| 建议项 | 实施情况 | 核查结论 |
| --- | --- | --- |
| 费用计算逻辑统一（原五-小瑕疵） | 新建 `src/pricing.js`（`isPeakHour` / `estimateCost` / `estimateCostLabel`），cli.js 与 ui.js 均已接线、旧内联实现删除 | ✅ 完整，无死代码；计价口径与旧实现一致 |
| 只读工具集合单一来源（原五-小瑕疵） | `READONLY_TOOLS` 移至 `src/tools/index.js` 导出，permissions.js 改为 import | ✅ 完整 |
| 子代理权限确认加「（子任务）」标记（原 4.3.1） | `permission.check(name, args, label)` 新增 label 参数；子代理包装传入 `（子任务）` | ✅ 完整 |
| undo 备份跨实例共享 | `createAgent` 新增 `undoStore` / `maxSteps` 参数；子代理与主代理共享同一 undo 仓；`SUBAGENT_MAX_STEPS`（12）真正接入（此前为未使用的死常量） | ✅ 完整，`/model` 切换、单次提问、JSON 模式三处 createAgent 调用均已传 `sessionUndoStore` |
| 单次提问 `--format json`（原 4.3.3） | `parseArgs` 支持 `-f/--format json`；单次提问输出单行 JSON `{ok, text, reasoning, usage, durationMs, steps, finish, aborted, truncated, session}`；错误输出 `{ok:false, error}`；HELP 已更新 | ✅ 完整 |
| 公共 API 补全 | `src/index.js` 导出 pricing 模块 | ✅（第三轮补） |

### 6.2 第三轮复评：修复与改进 7 处

| 文件 | 改动 | 评价 |
| --- | --- | --- |
| `src/agent.js` | **最终纯文本回复回填消息历史**（runTurn 结束 push assistant 消息） | 🔧 重要修复——此前会话文件只存 user 消息、丢失 assistant 回复，`--continue` 恢复后上下文残缺；smoke 新增断言覆盖 |
| `src/providers/openai-compatible.js` | 请求体显式加 `payload.stream = true` | 🔧 重要修复——此前请求未带 `stream` 字段，所有网关返回**非流式** JSON（走 parseNonStream 分支），TUI 流式渲染/增量输出从未真正生效；同时修正 `stream_options` 与 `stream` 的一致性（此前无 stream 却发 stream_options，部分网关会 400） |
| `src/cli.js` | 新增 `/title <别名>` 会话命名（含非法字符过滤、空文件 rename 保护），HELP 同步更新 | ✅ 新功能，实现稳健 |
| `src/index.js` | 公共 API 补全：`estimateCost` / `estimateCostLabel` / `isPeakHour` | ✅ |
| `package.json` | 版本升至 0.5.0 | ✅ |
| `test/smoke.js` | 新增「最终纯文本回复应回填消息历史」断言 | ✅ |
| `test/e2e-local.js` | **4 组扩至 9 组**，mock 升级为可编程三模式（write / task / plain） | ✅ 补齐原 4.2 测试缺口：ask 权限拒绝/放行闭环、`/plan` 计划→确认→执行、`/compact`、task 子代理真实往返、`--format json` 结构化输出 |

### 6.3 复评验证结果（全绿）

| 验证项 | 结果 |
| --- | --- |
| `npm test`（smoke） | ✅ **14 组断言**全部通过 |
| `node test/e2e-local.js` | ✅ **9 项**全部通过（含新增 5 项） |
| 6 个改动文件语法检查（node --check） | ✅ 全部通过 |
| 手动实测：JSON 模式 + ask 权限 + stdin `y` | ✅ 放行→工具执行→stdout 单行纯净 JSON（`{ok:true,...}`），exit 0；非 TTY 下 `io.ask` 不打印提示符，**权限提示不会污染 stdout** |

### 6.4 新观察项（非阻塞，供参考）

1. **`/title` 重命名覆盖风险**（低）：`fs.renameSync` 会静默覆盖已存在的同名 `<别名>.jsonl`，两个会话命名相同别名时后者覆盖前者。建议 rename 前 `fs.existsSync` 检查或附加随机后缀。
2. **空文本 assistant 消息**（极低）：`messages.push({ role:'assistant', content: res.text || '' })` 在模型返回空文本时也会回填空 content，个别 API 对 assistant 空 content 较严格。可改为仅 `res.text` 非空时 push。
3. **JSON 模式 + ask + stdin EOF**（低）：stdin 关闭时权限确认的 EOF 错误会逃逸到 `main()` 顶层 catch（stderr 报错 + exit 1，stdout 无 JSON），破坏「JSON 模式 stdout 恒为单行 JSON」的脚本约定。建议在单次提问 catch 中捕获 EOF 并输出 `{ok:false, error}`。
4. **发布前事项仍未处理**（原 4.1，已提两轮）：项目依然不是 git 仓库；`package.json` 缺 `repository` / `author` / `bugs` / `files` 字段；README 的 clone 地址仍是 `<your-org>` 占位符。
5. **可选加固**：e2e mock 可加一条断言验证请求确实携带 `stream: true`（防止该修复回归）。

### 6.5 复评小结

两轮迭代后项目质量显著提升：两个「隐性失效」功能（会话回复持久化、真正流式传输）被修复，测试覆盖从 4 组 e2e 扩至 9 组并补齐交互类路径，公共 API 与代码复用（pricing / READONLY_TOOLS）更完善。剩余问题均不阻塞核心功能，优先级最高的是发布前事项（git 初始化 + npm 元数据）。

---

## 七、v0.1.42：外部技术评估报告整改批次（2026-08-22）

外部评估（《MingDao-Harness 技术评估报告》，基于 v0.1.41/a0023ed 全量走读 + 实跑）确认
smoke/e2e 全绿，并给出 P0–P3 问题清单。本批次全部落实（P0-1 以外部补丁 `git am` 合入，其余本仓修复）：

| 编号 | 问题 | 处置 |
| --- | --- | --- |
| P0-1 | tokenizer 字节映射缺陷（73% merge 永不命中，中文计数虚高约 2 倍） | ✅ 补 GPT-2 `BYTE_TO_UNICODE` 映射 + 官方 Split 预分词序列；12 组黄金值 + 长文本 5550 精确断言。**独立复核**：用 HF tokenizers 0.23.1 + DeepSeek-V3 官方 tokenizer.json 逐值比对 12/12 + 5550 一致 |
| P0-2 | 启发式回退低估/高估 CJK | ✅ 校准为 0.75 token/字（CJK 区间识别，emoji/符号保持 1），smoke 精确断言 |
| P1-3 | WebUI 无认证、可远程切 auto 权限 | ✅ 访问令牌：非回环绑定强制（自动生成随机令牌并打印 `?token=` 链接），`--auth-token`/`MINGDAO_WEB_TOKEN`/`web.token` 三途径配置；全部 `/api/*` 校验（含 `/api/permission` 应答），前端 query→sessionStorage→`X-MingDao-Token` 头透传并清除地址栏令牌 |
| P1-4 | CSRF 可被 DNS rebinding 绕过 | ✅ Host 白名单（回环名 + 绑定地址），伪造 Host 一律 403（带对令牌也不行），e2e 断言覆盖 |
| P1-5 | bash 全量透传 process.env | ✅ 沙箱模式（readonly/safe）剥离 `*_API_KEY`/`*_TOKEN`/`*_SECRET`/`*_PASSWORD`/`*_CREDENTIAL` 等（segment 级匹配，不误伤 `TOKENIZERS_PARALLELISM`），`bashEnvKeep` 按名放行，smoke 三态断言 |
| P1-6 | sync `--insecure` 是进程级 TLS 开关 | ✅ 请求级 `https.Agent({rejectUnauthorized:false})`（node:https 原生实现，零依赖），不再改写 `NODE_TLS_REJECT_UNAUTHORIZED` |
| P2-7 | token 计数每步全量重算 + added-token O(n×818) | ✅ 818 个 added token 合并为单个正则一次扫描（O(n)）；内容级计数缓存（512 条/模型，超长不进缓存）+ trimMessages 消息级 WeakMap 缓存；实测 63K 中文 114ms 冷计 / 0.01ms 缓存命中 |
| P2-8 | 工具串行执行 | ✅ auto 模式连续只读工具（read/ls/glob/grep）Promise.all 并行；事件顺序/结果回填顺序不变，写入类不并入并行（批次边界保护），smoke 事件序列断言 |
| P3-9 | 版本回退/无 CI | ✅ 加 `.github/workflows/ci.yml`（Node 18/20/22 四套件矩阵）。版本号维持 0.1.x 系（项目决策：npm 发布前保持 0.1.x 预发布线） |
| P3-10 | 安全小项 | ✅ sync-server 密码/设备 token 哈希比较改 `crypto.timingSafeEqual`；注册开关 `MINGDAO_SYNC_REGISTRATION=open|invite|closed` + 邀请码（smoke 子进程实测）；hooks 文档明示 `shell:true` 配置即代码执行；定价支持 `pricing.overrides.<模型>` 覆盖 + `pricingAsOf` 数据日期 |

回归验证（2026-08-22）：smoke **33 组**、e2e-local **14 项**、e2e-schedule **4 项**、e2e-web **16 项**（新增「访问控制：token 认证 + Host 白名单」），全部通过。

---

## 八、第三轮外部复审（2026-08-22，v0.1.43 + v0.1.44）

外部第三轮复审结论：**两轮迭代全部达标，测试 70/70 通过**（smoke 35 + e2e-local 14 + e2e-schedule 4 + e2e-web 17）。v0.1.43（journal 串上下文修复 + 自更新模块）与 v0.1.44（安装渠道平台化）获「闭环」评价：自更新补「装上之后怎么升」、安装脚本补「不同网络怎么装」、journal 修复补「会话边界」。无新增正确性/安全性问题，结论为「适合公开发布与真实用户试用」。

**遗留 P3 增强项（无风险，按建议优先级）**：

1. **P3-1 上下文自动压缩（auto-compaction）**：✅ **v0.1.45 已落地**——超预算且被裁段落 ≥2000 tokens 时，executor 模型压成摘要注入（替代静默丢中段），会话文件同步重写、摘要用量计入费用、失败自动回退裁剪；smoke #32/#33 + e2e-web #16 覆盖。
2. **P3-5 工具调用审计日志**：✅ **v0.1.46 已落地**——全部工具调用（含拒绝/钩子阻止）落 `~/.mingdao/audit.jsonl`（600、脱敏、轮转），会话归因，`mingdao audit` / `/audit` 查看，`audit:false` 可关；smoke #35 覆盖。
3. **P3-3 技能注册表 sha256 完整性校验**：✅ **v0.1.46 已落地**——registry 安装逐文件校验索引 sha256（不符拒绝），安装后记录目录指纹、加载时校验（篡改拒绝加载 + 警示），`mingdao skill trust` 显式接受修改；`registry/index.json` 全量 22 技能已带哈希（`scripts/build-registry-hashes.js` 再生成）；smoke #34 覆盖。
4. **P3-2 会话索引/检索**：✅ **v0.1.47 已落地**——增量词表倒排索引（中文 bigram+单字 / 英文词 / 多词 AND），mtime/size 增量重算、删除自动清理，`mingdao sessions search` 与 WebUI 检索共用；smoke #36 + e2e 覆盖。
5. **P3-4 按会话隔离 workspace 默认目录**：✅ **v0.1.47 已落地**——每个会话记住自己的工作目录，任务固定写回会话目录、全局切换只影响新会话（移除 process.chdir 全局副作用），载入聚焦/显式切换跟随/改名删除自动维护；smoke #37 + e2e-web #17 覆盖。

**第三轮复审建议项已全部落地**。

---

## 九、Windows 平台评估整改（2026-08-22，v0.1.48）

外部 Windows 11 实测评估（基于 v0.1.44）发现「Windows 支持」宣称与实测不符：journal 在
Windows 上静默丢失（P1 产品缺陷）+ 四套测试在 Windows 全部无法运行（4 个测试级缺陷）。
本批次全部落实：

| 编号 | 问题 | 处置 |
| --- | --- | --- |
| D1 | `appendJournal` 绝对路径二次 join 产生 `D:\a\D:\b` 非法路径 → journal 静默丢失 | ✅ `mkdirSync(path.dirname(journalFile()))` + catch 加 `MINGDAO_DEBUG` 告警（静默吞错面收窄） |
| D2 | 动态 `import(path.join(...))` Windows ESM 不支持 | ✅ 全部测试统一 `pathToFileURL(...).href`（smoke 45 处 + e2e + 子进程脚本） |
| D3 | smoke git 测试依赖 example.com（受限网络挂 120s） | ✅ 改本地裸仓库演练，完全离线确定性 |
| D4 | autostart 测试未隔离 APPDATA → Windows 污染真实启动文件夹 | ✅ win32 下同步隔离 APPDATA |
| D5 | e2e 清理 rmSync 无容错 → Windows EBUSY 使整套失败 | ✅ `safeRm()` 重试版（注：评估件自带 safeRm 为无限递归空操作，已按正确语义实现） |
| D6 | updateCheck 依赖本地 refs 落盘（部分 Windows git 有异常） | ✅ 改 `git fetch <remote> <branch>` → `FETCH_HEAD` 直读版本，不依赖 refs |
| B1/B2 | 裁剪边界反复破坏缓存前缀 / 无自动压缩 | ✅ 压缩触发提前到预算 **80%**、压到 60%（滞回缓冲带，`compactTrigger` 可调） |
| B3 | 工具回填 pretty JSON 白费 10-20% token | ✅ 改紧凑 `JSON.stringify(result)` |
| B8 | 自定义端点 DeepSeek 模型回退启发式（±2 倍误差） | ✅ `customModels.<name>.tokenizer: "deepseek"` 按官方词表精确计数（mtime 缓存） |
| CI | 仅 Linux，Windows 全盲 | ✅ 三平台矩阵（Ubuntu 18/20/22 + Windows + macOS） |

回归验证（2026-08-22，Linux 实测）：smoke **41 组**、e2e-local **14 项**、e2e-schedule **4 项**、
e2e-web **19 项**，全部通过（78 项）；Windows 侧由新增 CI 矩阵常驻守护。

**评估的后续路线图（未纳入本批，按建议排期）**：B4 token 预算化智能截断、B5 费用护栏 +
`--offpeak` 避峰调度、B6 Batch API 半价通道（战略省钱）、B7 路由惯性 + 分类缓存、子代理并行（只读场景）。

---

## 十、四报告综合整改（2026-08-23，v0.1.49）

综合 Kimi / MiniMax / OfficeACE / WorkBuddy 四份评估（评分 8.4–8.9/10，均认可「零依赖 +
DeepSeek 深度适配」护城河；共识最高价值项 = **缓存前缀字节稳定性**：前缀 1 字节变化 = 整段
cache miss，命中 0.15 元 vs 未命中 4.5 元 **30 倍价差**）。本批落地「信任与缓存经济学」13 项：

| # | 来源 | 处置 |
| --- | --- | --- |
| P0-1 | WB/Kimi | Windows 冒烟 600 权限断言（NTFS 恒 0666）→ win32 跳过；恢复 Windows `mingdao update` 自更新能力 |
| P1-1/2 | WB/MiniMax | 系统提示移除「当前模型/当前日期」易变字段 → 同工作空间前缀字节恒定；smoke 恒定性断言 |
| P2-1/B7 | WB/Kimi/OfficeACE | 路由分类器 sha256 LRU 缓存（100 条）+ 会话粘滞（执行类不再逐轮分类）；smoke #38 覆盖 |
| P3-6 | WB/Kimi | 自动路由切换不再 `saveConfig`（`switchToModel persist:false`），不悄悄改写用户默认模型 |
| P2-2 | WB | 辅助模型 provider 正确解析：`helperProvider()` + `titleModel` 路由关闭回退当前模型；标题/记忆/分类在自定义网关上不再 404 静默失败 |
| P2-3 | Kimi | bash 敏感环境变量过滤默认常开（与沙箱档位解耦），`bashEnvFilter:false` 关闭 |
| P2-1 | Kimi | `/clear` 会话文件原子重写（旧上下文不再被 `--continue` 读回、消息不再重复追加） |
| P2-2 | Kimi | e2e-web 随机端口命中 Hyper-V 保留段 → EACCES 换端口重试（最多 3 次） |
| P0-4 | Kimi/WB | `isPeakHour` 锚定 `Asia/Shanghai`（Intl 零依赖），`pricing.timezone` 可覆盖 |
| P3-9 | Kimi | MCP 握手 clientInfo.version 读 package.json（不再硬编码 0.6.0） |
| 4.2-2 | WB | 空轮续写上限 12→3（每轮空输出 = 全额 completion 计费），`maxEmptyRounds` 可调 |
| P3-2/3 | Kimi | audit/journal/cache-stats 写入计数内存化 + 低频轮转（不再每次写都全量读盘） |
| P3-1 | Kimi | 子命令劫持防护：update/rollback/audit/web 参数结构不合法 → 回退为普通提问 |
| P2-3 | WB/Kimi/MiniMax | 云同步增量：本地 mtime 未变零网络跳过；pull 远端 mtime 未变跳过下载；真实冲突回归仍覆盖 |

回归验证（2026-08-23，Linux 实测）：smoke **42 组**、e2e-local **14 项**、e2e-schedule **4 项**、
e2e-web **19 项**，全部通过（79 项）；Windows 侧由三平台 CI 常驻守护。

**下一批（v0.1.50 → v0.2.0 战略省钱，四报告共识路线图）**：Batch API 半价通道、费用护栏
`costGuard`、避峰调度 `--offpeak`、token 预算可视化、/cost 分账与节省归因、辅助调用结构化输出、
Retry-After 退避；远期：拆 cli.js、子代理并行、插件生命周期、hooks 沙箱、SQLite 索引、流式 JSON。

---

## 十一、战略省钱批次（2026-08-23，v0.1.50）

按四报告共识路线图落地「主动省钱」五件套，把峰谷/批量定价从「展示」升级为「主动干预」：

| 项 | 实现 |
| --- | --- |
| **Batch API 半价通道（A1）** | `src/batch.js` + `mingdao batch <文件|->`：单轮批量任务走 OpenAI 兼容批处理协议（上传→建批→轮询→取回），结果落盘 JSONL 并计入 `/cost` 分账（`batch:true`，×0.5 计价）；轮询连续失败 10 次报错、端点不支持明确报错；`batchBaseUrl/batchEndpoint/batchWindow` 可配。smoke #41 全协议 mock 演练 |
| **费用护栏（A2）** | `src/cost-guard.js`：按北京时间自然日累计真实费用（含缓存折扣与 batch 半价），`costGuard{dailyLimitYuan,warnAtYuan,action:warn\|block}`；Agent 每轮开始前检查，block 时暂停并明确告知；`/cost`、WebUI 头部费用徽标实时显示。smoke #40 覆盖 |
| **避峰调度** | `run --offpeak` / `schedule add --offpeak` / WebUI「🌙 避峰执行」：高峰（北京工作日 9:00–12:00、14:00–18:00，官方口径）自动顺延到最近闲时（12:00 / 18:00）执行；**周末与午间识别为闲时**。e2e-schedule #5 覆盖 |
| **/cost 分账升级** | 按模型分账、今日费用、Batch 子项、节省归因（相比全未命中省 ¥X）、护栏状态；Web `/api/cache-stats` 同步输出 |
| **token 预算可视化（A5）** | WebUI done 事件携带会话 token 占用/预算，提示栏显示 `预算 45K/128K（35%）`；头部费用徽标 15s 刷新「今日 ¥x · 命中 y% · 护栏 z%」 |
| **Retry-After 退避（P3-1）** | provider 重试尊重 `Retry-After` 头（封顶 30s），错误对象透传响应头 |
| **附带修复** | e2e `safeRm` 内部误替换为递归调用（清理静默失效）→ 恢复 `fs.rmSync` 语义 |

回归验证（2026-08-23，Linux 实测）：smoke **45 组**、e2e-local **14 项**、e2e-schedule **5 项**、
e2e-web **19 项**，全部通过（83 项）。

**下一批候选**：辅助调用结构化输出（`response_format`，maxTokens 80–300 → 8–50）、/cost 月度报告导出、
子代理并行（只读）、单守护进程调度器（P3-5）、拆 cli.js。

## 十二、工程化与效率批次（2026-08-23，v0.1.52）

按四报告路线图 v0.3.0 能力纵深项提前落地五项：

| 项 | 实现 |
| --- | --- |
| 辅助调用结构化输出（4.2-4） | 标题/记忆提取/路由分类器走 `response_format: json_object`，maxTokens 120→50、300→200、80→20；解析失败自动回退纯文本（smoke #43 覆盖 json 与回退双路径） |
| /cost 月度报告导出 | `mingdao cost report [YYYY-MM\|all]` 生成 Markdown（按模型分账/每日柱状图/命中率/Batch 子项）；`costMonthlyReport` 按北京时区月/日聚合（smoke #42） |
| 子代理并行（A4） | `task` 工具 `readOnly:true` 并入并行批次——只读子代理（read/ls/glob/grep/skill 放行、写类拒绝、零交互）Promise.all 执行，结果按调用顺序回填（smoke #44：并发≥2 断言） |
| 单守护进程调度器（P3-5） | `schedule-daemon` 一进程监督全部任务（协程复用 runSleeper），pid 文件防重复、无任务自动退出、旧式 sleeper 存活时避让防双跑；`mingdao schedule daemon status/stop`；reconcile 自动拉起（e2e-schedule 5 项全绿） |
| 拆 cli.js（P0-1） | cli.js 1957→1098 行：`src/commands/` 九个命令族模块（update/rollback/batch/cost/audit、tasks/schedule、workspace/mcp、sync、skill/web/sessions、key），统一 `(cmd, args) → boolean` 分发协议，保留词劫持防护语义不变；全部命令实测通过 |

**过程中修复的两个真 bug**：① 分发表首次接入漏传 `cmd`（`update --check`/`cost` 被当成提问
交给模型）——已修复签名协议并清理误建会话；② `costMonthlyReport` 缺 `beijingParts` 导入。

回归验证（2026-08-23，Linux 实测）：smoke **48 组**、e2e-local **14 项**、e2e-schedule **5 项**、
e2e-web **19 项**，全部通过（86 项）。

## 十三、全面质检与发布准备（2026-08-23，v0.1.54）

三路并行人工审计（内核 / 工具与 providers / Web 与 CLI）逐行通读全仓，共修复 **20 项**真实问题：

**P1 级**：① 调度 resume 在守护进程存活时双跑任务（改由 daemon 独占接管）② bash forceTimer 不杀进程组且误标超时（补 SIGKILL + 仅真超时标 timedOut）③ MCP 启动失败泄漏 detached 子进程树（catch 中 stop()）④ WebUI 僵尸任务耗尽并发（provider 失败时任务清理）⑤ 单次提问自动路由后用旧 provider 发请求（重建 provider）⑥ renderMarkdown codeLang 信息串 XSS（esc 转义）⑦ 坏时区配置使费用护栏/月度报告崩溃（beijingParts 回退北京时间）。

**P2 级（择要）**：SSE `[DONE]` 后吞残帧/挂超时（break + usage 尾帧仍吸收）、tool_calls `idx-10`/`idx-2` 字典序错排（数字排序）、工具卡片 seq 并行错配（name+args 配对）、内部超时识别死代码（标志化）、sync-server 每请求全表扫 token（内存缓存 + 失效钩子）、注册并发覆盖（进程内互斥）、首次推送误判冲突备份（状态缺失特判）、daemon PID 复用误判（nonce 校验）、runOnce 超时孤儿 worker（killTask）、update 把 spawn 失败当测试失败（区分 error）、Batch `/v1` 前缀不一致（按服务商约定）、web 端口解析与校验不一致、notify title 注入、hooks 超时孙进程泄漏、fs-tools off-by-one 与 offset 越界空输出、sessionPreview null 行中断、tokenizer emoji 低估、索引点号子词漏检、memory 日期口径/条目回退、cachestats 无 ensureHome/非 DeepSeek 计 0 元、compact maxTokens 与摘要上限矛盾、workspace 返回约定与写盘异常。

**TS 决策**：不整体转 TypeScript（零构建步骤是项目身份、1.3 万行快速迭代中、发布前大改风险高）；改为 **JSDoc + `tsc --checkJs` 类型护栏**——`npm run typecheck` 覆盖 pricing/tokenizer/context/titles/routing/cost-guard 核心模块，CI 常驻，首跑即抓出 Error 自定义属性问题并修复。

**发布准备**：package.json 元数据补齐（homepage 指向官网、prepublishOnly 测试门禁）、`npm pack --dry-run` 通过（78 文件 / 970KB）；npm 未登录（ENEEDAUTH），发布需用户侧 `npm login` 后执行 `npm publish`。

**Electron 桌面版**：`desktop/` 薄壳（主进程内嵌 WebUI、随机端口+一次性令牌、单实例锁、外链走系统浏览器、无 nodeIntegration）；electron-builder 配置三平台安装包（npmmirror 镜像）；本地 `dist:dir` 打包验证通过（mingdao-desktop + app.asar + src/assets/skills 资源齐全）；`desktop.yml` 在打 tag 时自动构建三平台安装包。

回归验证（2026-08-23，Linux 实测）：smoke **50 组**、e2e-local **14 项**、e2e-schedule **5 项**、e2e-web **19 项**、`tsc --checkJs` 全部通过（88 项 + 类型护栏）。

---

*报告生成：Hermes Agent · 基于全量源码走读、17 项针对性验证、smoke + e2e 回归测试（含三轮复评）*