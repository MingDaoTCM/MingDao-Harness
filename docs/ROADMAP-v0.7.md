# MingDao-Harness v0.7 路线图（基于 v0.6.31 自审 + DSH/Octop 对照）

> 撰写依据：本仓 v0.6.31 全量自审（只读实测，Node 24.20 / macOS）、DeepSeek Harness 0.2.1-rc.5
> 实现研读、腾讯云 Octop v1.0.3b2 文档。**证据等级标注**：`[实测]` 本机跑出来的数字；
> `[代码]` 有 file:line；`[反推]` 从构建产物推断（未读到源码）；`[文档]` 来自公开文档。

## 0. 一页结论

三个最贵的问题，都不是"缺功能"：

| # | 问题 | 关键数字 | 后果 |
|---|---|---|---|
| 1 | **门禁虚高，"绿"不可信** | 自报覆盖 88.7% → 真实 **63.9%**（差 18.2pp）；`src/web/app.js` 2876 行 **0% 覆盖**，只靠 369 条源码正则守卫（176 条打在 app/index.html）；**43/90 模块 0 条变异** | 每次 UI/内核改动都在"文本没变"上过关，缺陷靠第三方审计发现 |
| 2 | **持久状态有 6 类无锁/非原子** | config.json、credentials.json、model-cache.json（**截断直写**）、endpoint-limits.json、ledger append、egress 日志 | "我明明填了 Key 却变回去了"、"学到的预算莫名丢失"——最难复现的一类 |
| 3 | **内核结构把缺陷集中放大** | `agent.js` 单函数 `runTurnInner` **1725 行**（62%）、55 个闭包状态；`server.js` 单函数 1208 行；无单调 seq，UI/账本/SSE 靠字段猜对齐 | 历史严重缺陷（C-01 孤儿 tool_calls、H-02 顺序倒置、H-03 出口绕过）**全部**出自这里 |

**v0.7.0 因此不新增用户功能**，只做地基：**让"绿"重新可信 + 让状态不再丢 + 让内核可拆**。

## 1. v0.7.0（地基，约 16 人日）

### 1.1 事件溯源会话日志 + SSE 单调 seq　`[代码][文档]`　4d

现状：会话只存消息数组，SSE 帧无 seq；`ledger` 是合规哈希链（只重判决策），**没有可续传事件流**，
断线即丢（Octop 的 trajectory 有 `after_seq`/`Last-Event-ID`；DSH 的 SessionEvent 是唯一真源）。

做法：
- 新增 `src/session-events.js`：13 类事件（turn/step/tool/usage/compact/…），append-only JSONL，
  每条 `{seq, time, type, data}`，seq 单调；
- `agent.js` 的 turn/step 边界写入事件（先**双写**，不删旧路径）；
- `web/server.js` 的 SSE 帧补 `seq`，支持 `Last-Event-ID` 补尾页；
- UI/账本从事件派生（投影），不再各自解析消息数组。

验收：① 同一份事件日志 → 派生历史**逐字节确定**（重放对拍）；② 断线重连补到不漏一帧；
③ seq 单调且无洞；④ 旧会话文件仍可读（迁移函数 + 5 组用例，学 DSH 的 `session-format-v*-to-v*`）。
回滚：`cfg.eventLog=false` 回到双写前的旧路径（一个开关）。

**执行拆分（2026-11-07 复盘后定，降低"一改就翻车"的风险）**

| 切片 | 版本 | 内容 | 状态 |
|---|---|---|---|
| **A** | 0.6.35 | 事件日志模块 + 双写 + 确定性重放对拍（不动读取路径） | ✅ 已发布 |
| **B1** | 0.6.41 | **传输层**：SSE 帧带 `seq`/`id`、`/api/events?after=` 游标、前端**跳号 → 整窗重取**；UI 仍按增量渲染 | 🔄 进行中 |
| **B2-a** | 0.6.42 | **事件完整性**：`rewriteSession` 也写 `messages.replace`（此前压缩/resume 的整份重写完全不写事件）；`scripts/event-parity.mjs` 双读对拍（pass / fail / incomplete 三分类） | ✅ 本次 |
| **B2-b** | 0.7.0 | **真源切换**：UI/账本改为从事件派生（对拍 pass 后才允许开始），并补 `session-format-*` 迁移用例 | ⬜ 未开始 |

**两套编号域（B1 实施时发现，必须区分）**

| 游标 | 作用域 | 用途 |
|---|---|---|
| `streamSeq`（SSE 帧） | **每个 task** 从 1 单调 | 前端检测"这一轮流有没有丢帧" |
| `eventSeq`（事件日志） | **每个会话**跨轮单调 | `/api/events?after=`、B2 的事件派生 |

**绝不能用 `lastEventSeq` 去初始化流游标**：同一会话第二轮的首帧 seq=1 会被判成"旧帧"而整轮不渲染
（B1 客户端道实测到这个坑）。B1 只用 `streamSeq`；跳号只做**整窗 snapshot 重取**，
"事件 → UI 投影"（即 `/api/events` 重放）留到 B2。

> **硬门槛**：B2-b 开始前，`node scripts/event-parity.mjs` 在真实会话上必须 **fail = 0**（incomplete 只表示旧日志不可回溯，不算失败）。
> 为什么拆：B1 是**纯增量**（加字段 + 加端点 + 跳号兜底），任一步失败都能单独回滚；
> B2 会改变"谁是真相"，必须先在 B1 上跑稳，再用双读对拍证明等价——一次做两步是 0.6.19 的老路。

### 1.2 测试地基：先修尺子，再补断言　`[实测][代码]`　5d

- **覆盖率算法**（`scripts/coverage-report.mjs:76-83`）：现在是"所有 count>0 区间取并集"，
  模块外壳跨越全文 → 最低 8 个文件都显示 95-99%。改为**最内层区间计数**，阈值按真实 63.9% 重定 + ratchet；
- **app.js 抽纯函数**：`errCardParts`(558)、`runStripView`(1012)、`sideNavLayout`(359)、`traceRoundView`(1394)
  → `src/web/viewmodel.js`，node 直测；目标 **viewmodel ≥40% 覆盖、app.js 不再是 0**；
- **369 条源码正则守卫中挑 40 条行为化**（176 条打在 app/index.html 的那批优先级最高）；
- **补变异盲区**：`sync.js`(592 行 0 条)、`packs.js`(665)、`workspace.js`(226) 各补一批；
  加"模块 0 条变异"门禁（新模块必须带批次）。

验收：真实覆盖 **63.9% → ≥75%**；`app.js` 覆盖 >0 且 viewmodel ≥40%；0 变异模块 **43 → <20**；
变异总数 633 → ≥700 且全中。

### 1.3 状态文件锁与原子写收口　`[实测][代码]`　2d

四处"一行改类型"级修复：
- `config.js:215` / `credentials.js:75`：`load→save` 用 `withFileLock`（web 路径用异步版）；
- `model-discovery.js:918-925`：截断直写 → `atomicWriteJsonSync` + 单一读写入口；
- `providers/index.js:425,468`：`endpoint-limits` 锁内重读合并（否则 v0.6.26 学的预算会丢）；
- `ledger.js:537` append、`net-guard.js:83` egress 日志：加锁或改 append-only。

验收：16 路并发写不丢（真子进程 + 屏障）；崩溃注入（kill -9 于写中）后文件仍可解析；
`doc-lint` 加一条"持久状态必须声明锁策略"的守卫。

### 1.4 请求路径去同步锁　`[实测][代码]`　1d

18 处 `withFileLockSync` 被 web 路由直达（`schedule.js` 12 处、`tasks.js`、`task-state.js`），
持锁方活 5s 则整站冻结（`Atomics.wait` 阻塞事件循环）。`workspace.js` 已全量迁移到异步版，照抄即可。

验收：外部持锁 5s 期间 100ms 心跳 ≥15 次/2s（`poc-blocking` 同款）；同步版仍可用于 CLI。

### 1.5 内核切分（先切"零依赖"部分）　`[实测][代码]`　4d

- `agent.js:102-585`（约 480 行**零依赖文案层**：错误分类、提示生成）外移 `src/messages.js`，可单测；
- `server.js` 三块：`auth`(320-368)、`provider-cache`(420-560)、`chat`(686-1370) 分文件；
- 加结构守卫：**单函数 ≤500 行**（当前 `runTurnInner` 1725、`runWebServer` 1208），
  并用"函数边界事件"为 1.1 的状态机铺路。

验收：smoke + 全量变异全绿（行为不变）；`runTurnInner` 首次降到 ≤900 行；文案层覆盖 ≥60%。

## 2. v0.7.1（工具契约与 prompt 预算，约 5 人日）

| 项 | 做法 | 依据 | 验收 |
|---|---|---|---|
| **defineTool 三件套** | 参数 JSON Schema 校验（`ToolArgsError`）→ **输出 schema 必填** → 错误分码（`TOOL_OUTCOME_UNKNOWN`/`TOOL_NOT_STARTED`）+ `timeoutMs` 正数校验 + `deferLoading` | DSH `[代码]` | 每个工具都有输出契约；非法参数不落到实现 |
| **`tool_search` 渐进加载** | deferred 工具只注入"名字+一句描述"，schema 按需展开；先做 `client` 模式（只多 1 个 function） | DSH `[代码]` + Octop `[文档]`（两家共识） | 40 个工具时 system+tool schema token 降 ≥30% |
| **只读集合单源** | 5 份只读集合（`tools/index.js:20`、`tools-flow.js:57`、`agent.js:699/1995`、`git.js:34`）收口到 `READONLY_TIER_SET`；**权限闸门必须用同一份**（现在用最窄的，导致 fetch/todo 可见却被拦） | 自审 `[实测]` | 只读档下"可见即可执行"；结构守卫禁新增副本 |

## 3. v0.7.2（人机协作闭环，约 5 人日）

- **HITL 暂停—审批—续跑**：审批挂起时**保留原请求上下文**，批准后用同一 turn 继续（现在只有 hook/permission，
  没有"暂停再续"闭环）；依据：Octop `[文档]`（SSE 仅用于 HITL resume）。
- **ACP 双向**：`mdh acp`（被 Zed 等 IDE 驱动）+ 出站 runner（把活派给别的 agent）；依据：Octop `[文档]`。
- 验收：暂停 30 分钟后批准 → 续跑不重发已完成工具；ACP 会话能在 IDE 里跑通一次工具调用。

## 4. v0.7.3（多 agent 与配置生态，约 8 人日）

- **主持人—成员 + inbox 幂等记账**（**不做 DAG**）：主持人工具裁到 `agent_list/ask_agent/记忆`，
  dispatch 并行派发，成员 checkpoint 独立，回复带 speaker；依据：Octop `[文档]`（"用少工具换稳定调度"）。
- **专家库 + SKILL.md 按需加载**：目录只放 `name+description`，正文 load 时读（DSH `[代码]`）；
- **profile.yml patch 叠加**：按 id 覆盖/禁用，替代现在"改代码才能改默认"（DSH `[代码]`）。

## 5. 明确不做（及原因）

| 不做 | 为什么 |
|---|---|
| 多用户 JWT + Postgres + LangGraph（Octop） | 破坏"零依赖、单机优先"；MDH 文档已把"共享令牌=同一用户"写成可接受边界 |
| Cordis 依赖注入 + React（DSH） | 我们是手写 DOM 单页；v0.6.19 的教训就是"大改前端=翻车"。Slot 思想可以借（先落 slot 表），技术栈不换 |
| DAG 编排 | 主持人—成员更便宜，且天然适配单机串行 |
| 自建 K8s/网关形态 | 与产品定位相反 |

## 6. 风险与隔离

| 改造 | 风险 | 隔离策略 |
|---|---|---|
| 事件溯源（1.1） | **高**：触及会话/SSE/UI | 双写开关 + 逐特性切换 + 重放对拍 + 三视口截图 |
| agent.js 切分（1.5） | **中**：大量变异锚点漂移 | 先加"函数 ≤500 行"守卫；分 3 步迁移，每步同步锚点并跑全量变异 |
| defineTool（2） | 中：所有工具 | 兼容层包装旧 schema，逐工具迁移 |
| 前端抽 viewmodel（1.2） | 中：可能改变渲染细节 | 纯函数先"复制实现 + 对拍旧输出"，再删除旧路径 |

## 7. 验收总表（v0.7.0 完成时）

| 指标 | v0.6.31 | 目标 |
|---|---|---|
| 真实行覆盖（严格口径） | 63.9% | **≥75%** |
| `src/web/app.js` 覆盖 | 0% | **>0%（viewmodel ≥40%）** |
| 源码正则守卫占比 | 369 条 | **减少 ≥40 条**（转行为断言） |
| 0 变异模块 | 43/90 | **<20** |
| 持久状态无锁类 | 6 类 | **0** |
| 请求路径同步锁 | 18 处 | **0** |
| `runTurnInner` 行数 | 1725 | **≤900** |
| 空吞 catch（无码） | 271 | **<150 且必须带码** |
| 单次调用可对齐 | 无 seq | **seq → UI/账本/事件流三方一致** |
