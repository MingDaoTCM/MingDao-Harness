# v0.7.0 方案复盘：对照 DSH 与 Octop（2026-11-06）

> 目的：动手做剩下三件事（0.6.39 签名/CI 直推、§1.1 切片 B、输入队列）之前，
> 先核一遍**我们的方案里哪些是错的、哪些已经落实、哪些该按两家的真实做法改**。
>
> 证据口径：DSH 取自本机 `app.asar` 解包后的实码（`/tmp/dshx`，路径根 = `app.asar/`）；
> Octop 取自其仓库公开文档/源码。凡引用都带 `path:line`；**没有证据的一律标"待确认"，不写成结论**。

---

## 0. 先说三条**必须纠正**的原有判断

| # | 原方案写的 | 实际（证据） | 处理 |
|---|---|---|---|
| ① | 0.7.1 要做 **`tool_search` 渐进加载**，依据"DSH `[代码]` + Octop `[文档]`（两家共识）" | **"两家共识"是错的**：DSH **没有** tool_search（只有 `defineTool({deferLoading})` + 步级 `when`）；**Octop 有** `deferred_tools` + `tool_search_mode=client\|native\|eager`（`config/__init__.py:723-729`、`middleware/tool_search.py:1-10`）。 | **方案本身不改**（先做 client 模式本就等于 Octop 的做法），但**归属改对**：tool_search 抄 Octop，deferLoading/`when` 抄 DSH，两者互补 |
| ② | §1.1 切片 B 要做 **SSE 帧加 seq + Last-Event-ID 断线补尾页** | 两家做法不同：**Octop 用 `after_seq`/Last-Event-ID 续订**（`docs/api.md:241`）；**DSH 不用 SSE**，用 `cursor` 快照重取，跳号即 `skipped seq` → `resync()` 丢弃重建窗口（`dsh-session/lib/index.js:1539`、controller:1975-1979、client.js:2568）。 | **保留 after_seq（Octop，我们已有 SSE）+ 采纳 DSH 的跳号重取**：seq 连续、客户端持 cursor，跳号**整窗重取**而不是逐帧续接 |
| ③ | HITL 要"暂停—审批—续跑，保留原请求上下文" | DSH 的审批是**进程内在途 promise**（waterfall），**不是持久化挂起**；崩溃恢复靠**合成闭合事件**（`dsh-user-approval/lib/index.js:156-210`、`dsh-session/lib/types/repair.js:33-56`） | 保留我们的"挂起+恢复"，但**补上崩溃闭合**：启动时对未闭合的 (asked,decided) 对合成结束事件，避免日志永久悬空 |

---

## 1. 已经落实的（对照 v0.7.0 计划表）

| 计划项 | 状态 | 证据 |
|---|---|---|
| §1.2 修覆盖率尺子（三口径、叶子区间） | ✅ 0.6.32 | `scripts/coverage-report.mjs`、`test/coverage-metric.js` |
| §1.2 前端抽 `viewmodel.js` 可测化 | ✅ 0.6.33 | `src/web/viewmodel.js`、`test/viewmodel.js`（110→134 条） |
| §1.3 六类状态写入加锁/原子化 | ✅ 0.6.32 | `test/state-locks.js`（10 项，含崩溃可解析） |
| §1.4 请求路径去同步锁 | ✅ 0.6.32 | `test/request-path-locks.js`、心跳实测 0→22–44 次 |
| §1.5 内核切分（文案层 / server 两刀） | ✅ 0.6.34 | `agent.js` 2762→2303、`server.js` 1509→1308、`runWebServer` 1211→1007；`test/structure-limits.js` |
| §1.1 切片 A（事件日志 + 双写 + 重放对拍） | ✅ 0.6.35 | `src/session-events.js`、`test/session-events.js`（34 项）、`batch76`（12 条） |
| §1.2 变异盲区（0 变异模块 15→13、结构守卫） | ✅ 0.6.32–0.6.36 | `scripts/mutation-coverage.mjs`、`batch69–77` |
| 发布链路：站点 404、收割代理+续传、签名密钥环、CI 直推（本轮） | ✅/进行中 | 见 `docs/DEPLOY-NODES.md`、`docs/CODE-SIGNING.md §六` |

**结论**：v0.7.0 的"地基"五件事里，4 件已完成、1 件（§1.1）完成一半（A 已完成，B 未做）。

---

## 2. 按 DSH 实码要改/要补的具体项

### 2.1 输入队列：**两条 lane**，不是一条

- DSH：`followup/steer/inject → send(msg,target,wakeup)`（`dsh-agent-loop/lib/index.js:571-578`）；
  `claim()`：**next-step 全量取走**、**next-turn 每轮只取 1 条**（同文件 `:105-106`）；
  `turnEnds && nextStep 空`才 break，否则本轮继续（`:738/:798/:799`）。
- 交互：Enter=排队（next-turn）、**Cmd/Ctrl+Enter=插话**（next-step），设置项 `ui-conversation.busyEnter` 取反
  （`dsh-client-ui-conversation/lib/client.js:16358-16361`）；队列项可编辑/删除/一键全插话（`:16773-16782`、`:19626`）。
- **我们要做的**：把当前"单队列"升级为**两 lane**；插话只在**步边界**生效；插话会让本轮**不结束**（继续下一步）。

### 2.2 事件溯源：cursor + 跳号重取 + 不可变日志

- DSH：`seq = log.length`（单写者 + 重放连续性校验，不连续即抛，`dsh-session/lib/index.js:1539`、`:427`）；
  62 种事件（`known-event-types.js:21-84`）；**未知类型除非声明 ignorable 否则拒绝读**；
  改历史用 **surface replace** 事件（`surfaceOp:{startSeq,endSeq}`），**不 in-place 改日志**。
- 客户端**没有消息数组**，全靠事件派生（`client/sessions/session.js:80-91`）。
- **我们要做的（切片 B 重定义）**：
  1. `session-events.js` 增加**连续性校验**（读到的 seq 必须连续，否则 `{ok:false, reason:'gap'}`）；
  2. 事件类型表加 `ignorable` 标记，未知且不可忽略 → 拒绝，而不是静默跳过；
  3. SSE 帧带 `seq`，前端持 `cursor`；跳号 → **整窗重取**（不是逐帧补）；
  4. UI 从事件派生（先做"双读对拍"：事件派生 vs 消息数组，一致后再切换），**不 in-place 改日志**。

### 2.3 工具定义：`deferLoading` + 步级 `when`（不是 tool_search）

- DSH `defineTool`：`parameters` / `output.schema` / `timeoutMs` / `deferLoading`（`dsh-tools/lib/types/schema.js:296-315`）；
  返回校验失败 → `INVALID_TOOL_OUTPUT`；超时 → `TOOL_TIMEOUT`；另有 `UNKNOWN_TOOL/INVALID_ARGS/ABORTED[_BEFORE_DISPATCH]`。
- 步级激活：`register(def,{when})` 每步求值，条件异常 → `ToolActivationError('TOOL_ACTIVATION_FAILED')`
  （`dsh-tools/lib/types/index.js:83,198-202`）。
- **我们要做的**：0.7.1 的 defineTool 三件套保留（参数/输出/错误码/超时），**把 tool_search 换成 deferLoading**，
  并区分"工具不可用"与"激活求值失败"（后者要有独立错误码）。

### 2.4 审批：审计对 + turn 闭合不变量

- DSH：`approval/asked` 必须 turn 内；`decide()` 走 waterfall，默认 `unavailable`（**fail closed**）；
  崩溃恢复 `openTurnClosers` 合成 `tool/result` 错误 + `step/end` + `turn/end`（`dsh-session/lib/types/repair.js:33-56`）。
- **我们要做的**：审计对 + 启动补齐闭合；策略文本写进 system prompt（我们已有 hook/permission，缺"闭合"）。

---

## 3. 与 Octop 的对照

## 3. 与 Octop 的对照（实码核对，非文档转述）

| 主题 | Octop 的做法（证据） | 对 MDH 的处置 |
|---|---|---|
| **插话（steer）** | 服务端 steer 队列 + 客户端"下一条"队列双层；**phase 白名单** `streaming_text/awaiting_tools/between_model_steps`；上限 `STEER_DEPTH_CAP=8`、`CONTINUATION_CAP=8`、文本 200KB（`infra/gateway/steer/types.py:8-12`）；`admit()`/`drain_for_continuation()`（`coordinator.py:274,497`）；WS 流结束后 drain（`ws_channel.py:236`） | **采纳**：插话只在**安全边界**消费（我们=step 边界）；**采纳上限**（我们队列 20，插话也设上限）；**采纳 phase 语义**（工具执行中/等审批时不消费） |
| **插话的"丢弃"语义** | 越过边界时**丢弃边界前的半截 token**，保证"用户所见 = checkpoint"（`docs/api.md:186-215`） | **部分采纳**：我们不在 token 级抢断，改为"步边界才注入"，天然满足"所见=已提交" |
| **取消时** | 整轮取消 → `steer.discarded(turn_cancelled)`，UI 可撤回已提交的插话 | **采纳**：中止时清空插话并**明确告知**（我们的排队保留、插话丢弃，两者语义不同） |
| **队列存活** | steer/HITL/team inbox **都是进程内存**，重启即丢（`gateway/hitl/store.py:63`、`docs/agent-delegation.md`） | **不采纳**：我们的事件日志已落盘；排队/插话可丢失（原本就是"这一刻的意图"），但**要如实写在 UI 与文档里** |
| **状态真相** | checkpoint 是真相、消息表是投影；同 thread 加执行锁（`agent.py:66-70`、`agents/manager.py:551-553`） | **采纳"单 thread 串行锁"思想**（我们已有 busy 判据，但要确保**同一会话不允许并发回合**） |
| **工具错误** | **一律降级为文本** `Error: …`，永不抛异常穿透循环；MCP 错误还给"改参数重试/别改参数"建议（`builtin/tools/web_fetch.py:50-67`、`middleware/mcp_tool_error.py:1-6`） | **采纳**：0.7.1 的 defineTool 要求"错误码 + 模型可读文本"两者都有，不允许只有异常 |
| **工具分期** | `deferred_tools` + `tool_search_mode=client\|native\|eager`；deferred 先露名字+轻量引用，检索后换真 schema，调用仍走 guard | **采纳 client 模式**（与我们 ROADMAP 一致，只是归属写错了） |
| **权限分级** | `ToolGuard` 三档 `block/warn/require_approval` + 文件系统 allow/deny；命令护栏**永不被 allow_all 自动放行** | **采纳**：`allow_all` 不得覆盖命令护栏（我们已有硬拦截，需补断言） |
| **HITL** | interrupt + `{action_requests, review_configs}` → 决策 `approve\|edit\|reject\|respond`；恢复按暂停时 config 重放（`security/tool_guard/engine.py:99-115`、`agent.py:570`） | **采纳 `edit` 决策**（我们的审批目前只有 允许/拒绝）+ **"审批 vs 提问"区分**（`ask_user_question` 只允许 respond） |

> **明确不抄**：Octop 的"队列全在内存、重启即丢"是它的已知取舍（ADR 001 单进程无队列），我们的事件日志已落盘，没必要退回内存版。


---

## 4. 结论：接下来三个批次怎么排

| 批次 | 内容 | 依据 |
|---|---|---|
| **0.6.39** | 输入队列（两 lane：排队 / 插话）+ CI 直推产物 + 签名阶段一（`.sig` 只进 GitHub Release，不进 `/updates/`） | 本节 2.1 / 本轮实测 |
| **0.6.40** | 插话的服务端与 agent 落地（`/api/steer`、步边界全量消费、插话不结束本轮）+ 审批闭合事件 | 2.1 / 2.4 |
| **0.7.0** | §1.1 切片 B（按 2.2 的 cursor 语义重做）+ UI 事件派生（双读对拍后切换） | 2.2 |

> 原计划里“tool_search”“Last-Event-ID”两项**不再做**，理由见 §0。
