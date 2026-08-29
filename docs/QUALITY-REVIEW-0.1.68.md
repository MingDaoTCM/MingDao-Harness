# MingDao-Harness v0.1.68 全面质量评估与分期优化方案（2026-08-28）

四路独立只读审计（核心引擎 / CLI 与后台任务 / Web 与桌面壳 / 测试与质量基础设施）交叉完成，覆盖全部 56+ 源文件、12,023 行源码。本文档为评估结论与分期方案，**待方案敲定后再实施**。

## 一、总评

| 区域 | 评分 | 一句话结论 |
|---|---|---|
| 核心引擎 | **7.5/10** | 防御意识强（fail-closed、护栏、mtime 缓存），有 1 个高危计费缺陷与若干跨模块口径不一致 |
| CLI 与后台任务 | **6.0/10** | 安全基线好（无命令注入、路径穿越基本防住），有 1 个确定性 bug 与成体系的并发写隐患 |
| Web 与桌面壳 | **6.5/10** | 鉴权/转义/SSE 清理扎实；短板在 SSRF 目标校验、并发上限竞争、server.js 巨石 |
| 测试与质量基础设施 | **6.9/10** | 4 套离线 e2e + 三平台 CI 优秀；缺覆盖率/运行时汇总/CHANGELOG，tsconfig 只覆盖 22/52 文件 |
| **综合** | **≈6.8/10** | 功能成熟度高、安全基线好；主要债务集中在**结构（巨石文件）、并发正确性、工程化度量**三类 |

体检指标：源码 12,023 行 / 最大单体 server.js 1267、cli.js 1166、index.html 1342；空 catch 83 处（多为刻意降级，需逐处甄别）；console.log 177 处；无 CHANGELOG；测试 ~445 组 ok()/738 条断言、全部离线、三平台 CI（Node 18/20/22 + Win + Mac）。

## 二、问题总清单（合并去重，按严重度）

### 🔴 高（必须修）

| # | 区域 | 位置 | 问题 | 修复 | 工时 |
|---|---|---|---|---|---|
| H1 | 计费 | pricing.js:185-201 | 根级 `pricing.overrides.{input,output}` 只并入 offpeak 不传播 peak：高峰时段自定义价格按内置 peak 计价，费用护栏/前置预估口径失真且无信号 | overrides 传播到 peak（或文档化并加日志警告） | 0.5h |
| H2 | 调度 | schedule.js:399-414 | **确定性 bug**：every 任务执行中 `pause` 会被 runSleeper 主循环无条件覆盖回 `pending`，暂停失效 | 读 cur2 后先检查 `paused/failed` 再落状态 | 0.3h |
| H3 | 并发 | 全局（schedule/tasks/session/sync/session-index/sync-server 等 8 处） | 跨进程「读-改-写」无锁 + 共享固定 `.tmp` 名 → 丢更新/半写入 | 每文件锁（O_EXCL lockfile）+ tmp 名加 pid+随机后缀 | 1.5–2 人日 |
| H4 | 数据安全 | config.js:59 / credentials.js:29 / update.js:75 / sync.js:315,325 / audit.js:42 | 关键状态非原子直写（与项目自身 tmp+rename 口径分裂）；credentials 含全部密钥，崩溃写一半即损坏 | 统一原子写工具函数（tmp+rename，密钥文件 0o600） | 0.5h |
| H5 | 结构 | web/server.js:447-1210 | 30+ 路由单函数巨石，鉴权/业务/清理混排，难维护难测 | 拆 `src/web/routes/*.js` 按域聚合，SSE 独立文件 | 20–24h |

### 🟠 中（应当修）

| # | 区域 | 位置 | 问题 | 修复 | 工时 |
|---|---|---|---|---|---|
| M1 | 安全 | server.js:684-733,1122 | SSRF：自定义模型/sync 的 baseUrl 只验 http(s) 不验目标，可指向回环/云元数据/内网 | host 校验拒绝 loopback/私网/链路本地 + 超时/重定向限制 | 4h |
| M2 | 并发 | server.js:812-836 | MAX_CONCURRENT 检查在 readBody 前，占位即删 → 并发瞬时超限 + 多份 40MB 缓冲 | inflight 计数绑定请求生命周期（进入++/finally--） | 3h |
| M3 | 并发 | server.js:306,360,388 + session.js:36-48 | 会话文件 append 与 rewrite（compact）交错丢消息 | 按文件进程内 async mutex 串行化 | 4h |
| M4 | 桌面 | server.js:1234-1266 + desktop/main.js | `runWebServer` 在 listen 成功前 resolve，端口被占黑屏反复 reload 无恢复 | Promise 包装 listen；桌面对 EADDRINUSE 重试或提示退出 | 3h |
| M5 | 同步 | sync-server.js:109-123,228-267,451-457 | 限流表超限整表 clear（可被攻击重置全员限额）；devices/meta 读改写无锁；代理后 IP 桶共享 | 淘汰最旧而非 clear；按 ip+username+路由建桶；meta 互斥合并写；`server.maxConnections` | 4h |
| M6 | 同步 | commands/sync.js:49-52 | `sync login` 密码走命令行参数（ps/history 泄露） | 一律隐藏输入/stdin | 0.3h |
| M7 | 压缩 | cli.js:160-182 vs compact.js | 两份近似压缩实现已分叉：手动 /compact 无 `<conversation_summary>` 标记，自动增量压缩识别不了 → 重复压缩/格式漂移 | /compact 统一走 compactConversation（或注入同款标记） | 0.5h |
| M8 | 口径 | memory.js:156,34 | journal 用 UTC 日期、appendMemory 硬编码 Asia/Shanghai，与 pricing.timezone 口径不一致 | 统一用 beijingParts()/配置时区 | 0.3h |
| M9 | 内存 | fs-tools.js:26-36 | undo 备份无上限（每文件 10 份完整 Buffer，文件数不限） | 按文件数/总字节双上限 LRU 淘汰 | 0.5h |
| M10 | 性能 | context.js:73-96 / cost-guard.js | 语义回收循环每次全量重算 totalOf（≤500×n）；todayCost 每步整文件解析 stats | 增量求和；stats 行级缓存/索引 | 0.5h |
| M11 | 误杀 | schedule.js:150,165 | 用陈旧 PID `process.kill`，PID 复用会误杀无关进程 | kill 前校验 cmdline/nonce（同 daemonAlive）；终态清 pid | 0.2h |
| M12 | 进程 | tasks.js:57-88 等 | worker/daemon spawn 无 `child.on('error')`，ENOENT/ARG_MAX 崩溃；worker 被 SIGTERM 时 MCP 子进程可能孤儿 | 补 error 监听 + 终态；确认 MCP 进程组归属 | 0.3h |
| M13 | 结构 | cli.js:300-316 + 全文件 | 命令分发用「模块名≠命令名」字符串拼接 map；mcpFacade/offpeak/参数解析多处重复；死导入 | 显式命令→{module,handler} 映射；抽共享函数；删死代码 | 1 人日 |
| M14 | UI | index.html:6,584-593,891-913 | CSP `unsafe-inline`；工具图标 map 三处重复；refreshCostBadge 与 refreshStatusBar 每 15s 双拉同接口 | JS 外置后收紧 CSP；图标表抽常量；合并一次拉取 | 6–8h（随 JS 外置） |

### 🟡 低（顺手修）

| # | 位置 | 问题 | 工时 |
|---|---|---|---|
| L1 | server.js:875-884 + index.html | 主「■ 停止」发 `{}` 中断所有任务（应记本任务 taskId） | 1h |
| L2 | web-io.js:70-77 | `_activeTools` 被拒/中止条目泄漏（无界增长 + seq 错配） | 1h |
| L3 | server.js:217-254 | pruneTasks 惰性 + built.error 早退漏清理；finished 即删 | 0.5h |
| L4 | server.js:1011-1029 | fs-browse 可枚举任意绝对路径（限定基目录 + 不回传绝对路径） | 2h |
| L5 | server.js:70-105 | 所有 POST 统一 40MB 整包内存（非 chat 接口降为 1MB） | 2h |
| L6 | server.js:1249-1250 | 「0.0.0.0 无 token」告警文案与 trustedHost 行为不符 | 0.5h |
| L7 | server.js:199,888-899 | draftText 单一全局槽多客户端互相覆盖 | 1h |
| L8 | desktop/main.js:28-40 + server.js:203-215 | appLog/srvlog 两文件、O(n) 全量重写、512KB 断行截断 | 2h |
| L9 | desktop/main.js:221-228 | 渲染崩溃只 reload 一次，无计数护栏/提示 | 1.5h |
| L10 | autostart.js:40-58 | 端口硬编码 3820、登录 PATH 不可靠 | 0.3h |
| L11 | schedule.js:41-43,102 | parseAt 非法日期回滚不校验；addSchedule 条件冗余 | 0.2h |
| L12 | cli.js 8 处 / schedule.js:413 | 关键路径静默吞错（至少 MINGDAO_DEBUG 打 stderr） | 0.2h |
| L13 | notify.js:19-30 | 转义启发式（spawn argv 已低风险，可结构化化） | 0.2h |

### 🔵 工程化（测试/基础设施审计）

| # | 项 | 问题 | 工时 |
|---|---|---|---|
| E1 | bench 未入 CI | 3 份基准不在 ci.yml；且 bench 有 Windows `new URL().pathname` 跨平台 bug | 1h |
| E2 | 失败即中止 | smoke 首败即停、无全量坏点清单 → 迁 node:test 或逐段 try/catch 汇总 | 6–8h |
| E3 | 无覆盖率 | 无 V8/c8 度量与门禁；mcp-presets/index 公共 API/credentials/permissions/config 边界用例缺失 | 10–12h |
| E4 | tsconfig 覆盖不全 | 只覆盖 22/52 src 文件且 strict:false（漏 sync-server/web/credentials 等安全关键区） | 6–8h |
| E5 | CHANGELOG 缺失 | 0.1.0→0.1.68 无变更日志；prepublishOnly 未跑 e2e-web/bench；发布流程人工 | 3–4h |

## 三、分期实施方案

> 原则：每期可独立发布、可回滚；高危与确定性 bug 一律放最前；结构重构后置并配足回归护栏（现有 94 项测试 + bench 全绿才准合入）。

### Phase 1 —「质量加固」v0.1.69（≈2–3 天）✅ 已实施（2026-08-28）
目标：修掉全部高严重度与低成本中危，零结构变动。实施项：H1 计费 overrides peak 传播（+回归断言）、H2 调度 pause 失效（postRunStatus 纯函数化 + 7 项 e2e）、H3/H4 原子写地基（新增 src/atomic-write.js：pid+随机 tmp、O_EXCL 文件锁+陈旧回收；config/credentials/update/sync/session/session-index/sync-server 全部原子化；schedule/tasks 读改写加锁）、M7 /compact 并入 compactConversation（force 模式）、M8 记忆日期统一配置时区、M9 undo 备份全局上限、M10 trim 增量求和 + todayCost mtime 缓存、M11 kill 前 PID 归属校验、M12 spawn error 监听、L1 主停止按钮带 taskId、L2 _activeTools 拒绝清理、L3 pruneTasks 年龄+数量双阈值、L6 告警文案、L2/L3/L11/L12 小修。
- H1 计费 overrides peak 传播 + 测试断言
- H2 调度 pause 失效 bug + e2e 回归
- H3 并发地基：统一原子写工具（锁 + pid 随机 tmp）——先落 H4 的 5 个文件，再铺 schedule/tasks/session
- M7 压缩双实现合并（/compact 走 compactConversation，保留用户提示文案）
- M8 时区口径统一；M9 undo 上限；M10 性能小修；M11 PID 校验；M12 spawn error 监听
- L1/L2/L3/L6/L11/L12/L13 顺手修
- 验收：94 组测试 + 38 组 bench 全绿、tsc 0 错误、三平台 CI 过

### Phase 2 —「结构治理」v0.2.0（≈4–6 天）✅ 已实施（2026-08-29）
实施项：server.js 拆路由模块（src/web/routes/api.js，1299→579 行）、cli.js 命令分发显式化、SPA JS 外置 app.js + CSP 收紧、SSRF 目标校验、inflight 并发、会话写互斥、listen Promise + 桌面端口重试、sync-server 限流加固、API Key 即时生效、更新下载失败可见化。
（cli.js 的 REPL/worker 进一步拆分与 routes/api.js 按域细分留待 0.2.1 渐进完成。）
- H5 server.js 拆 `src/web/routes/*.js`（chat/sessions/config/sync/schedule/skills/workspace/fs-browse 等）+ 共享中间件
- M13 cli.js 命令分发重构 + REPL/worker 拆分 + 重复逻辑抽取
- M14 index.html JS 外置 `app.js` + CSP 收紧（去 unsafe-inline）+ 图标表/双拉取去重
- M1 SSRF 目标校验；M2 inflight 并发；M3 会话文件互斥；M4 listen Promise + 桌面端口重试
- M5 sync-server 限流与 meta 互斥；M6 密码不再走参数
- L4/L5/L7/L8/L9/L10
- 验收：同上全绿 + 新增 API 契约测试（routes 拆分后每个域至少 3 条断言）+ 桌面端口占用重试实测

### Phase 3 —「工程化纵深」v0.2.1（≈3–5 天）
目标：把"质量"变成可度量、可持续的门禁。
- E1 bench 入 CI + Windows 兼容；E2 node:test 迁移（或分段汇总）；E3 覆盖率接入 + 阈值门禁 + 安全关键模块补测；E4 tsconfig 全覆盖 + 收紧 strict
- E5 CHANGELOG + preversion/postversion 自动化 + prepublishOnly 补 e2e-web/bench + 发布清单文档化
- 遗留项：sync-server 独立安全测试（限流/认证/并发）、fs-browse 基目录、D3 崩溃护栏（若 Phase 2 未含）
- 验收：CI 输出覆盖率报告；`npm run bench` 全绿；tsc strict 0 错误；CHANGELOG 自动生成首版

### Phase 4 —「能力演进」v0.3.x（可选，按需启动）
从《六份评估综合分析》（docs/EVALUATION-SYNTHESIS.md）与审计收敛出的长期项：
- 跨平台沙箱补位（Windows Job Object / macOS seatbelt）
- 记忆语义检索（node:sqlite + 简单相似度，保持零依赖）
- WebUI 看板扩展（费用二级分账、按小时/天折线）
- 评测基准扩充（压缩质量集、路由 100 条标注集、tokenizer V4 词表对拍）

## 四、明确不做（保持零依赖与轻量定位）

- 不引入 TypeScript 全量迁移 / 构建工具链 / 前端框架 / i18n 框架 / OpenTelemetry
- 不引入 better-sqlite3 等外部数据库驱动（如需 SQLite 用 Node 22+ 内置 node:sqlite 且保持 Node≥18 回退路径）
- 不做 A/B 双模型对比路由（与省钱目标矛盾）

## 五、交付物与验收口径

每期合入前必须满足：`npm test`（smoke 51 组）+ 三套 e2e（21/16/6）+ `npm run bench`（38 断言）+ `tsc` 全绿；涉及 Web/桌面改动额外要求 e2e-web 全绿与打包抽查。每期发布按既有流水线（npm → 桌面 CI → 官网 feed → 镜像 Release 正文），桌面版统一官网分发。
