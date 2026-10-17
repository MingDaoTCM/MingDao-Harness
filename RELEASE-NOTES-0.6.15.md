# MingDao Harness v0.6.15 发布说明

> 状态：**已发布**（tag `v0.6.15`）（`npm version` 时由 `scripts/bump-changelog.mjs` 自动翻转）。
> 主题：**把"差点造成事故的流程"和"真机上真的把引擎压垮的并发"都关掉**——
> 变异框架补 fail-safe（残留标记 + 互斥锁 + 开跑前字节级自愈 + 强杀可感知，§3.61）；
> 同一本地 `baseUrl` 串行化、并把"引擎活着丢缓存"从"重启引擎"里分出来（§3.60，§3.59 收口）；
> 工具参数解析抽成纯函数 `parseToolArgs`，并修掉顶层空值被回填成字面量 `"undefined"`/`"null"`（§3.62）。
> 逐条根因与取舍见 `docs/internal/AUDIT-v0.6.1-第三方报告登记.md` §3.60–§3.62。

## 为什么发这一版

三件事都不是代码审查的推演，而是**事故与真机现场**：

| # | 现场 | 这一版怎么处理 |
| --- | --- | --- |
| 1 | 变异**在飞**时被扫描误报成"残留"；进程被**强杀**后补丁留在工作树，看起来像"有意改动"（曾差点把"停止键失效"发进版本） | 残留标记里存**原始字节 + 补丁 + pid**；开跑前自检**字节级自愈**；互斥锁 + `SIGTERM`/`Break` 还原；强杀留下标记 → 下次 `check` 自愈（§3.61） |
| 2 | v0.6.14 真机 8081 qwen 长任务中途被引擎拒绝（`insufficient memory` / `allocator wall` / `engine shed its caches and stays up`）；同错在 60091 的 35B 上也出现 | 不是模型问题，是**本机内存压力**：父回合 + 子代理同时向同一本地引擎发大 prefill。同一 `baseUrl` 串行化（默认 1 并发），并给"引擎活着丢缓存"独立分型（§3.60） |
| 3 | P1-1 第四刀：前置门里最前端、零副作用的一步仍内联在 `agent.js`；且顶层 `undefined`/`null` 会被回填成字面量 `"undefined"`/`"null"` | 抽出纯函数 `parseToolArgs(raw)`（8 条行为清单），顶层空值统一回填空串（§3.62） |

> 一句话：**流程的"半成品"和内存的"并发"都必须有硬约束**——口头约定与"这次应该没事"都不算。

## 变化

### 一、变异框架 fail-safe（§3.61）

- **持久残留标记**：`mutate()` 写补丁前先落 `test/mutate/.generated/pending/<hash>.json`
  （`file` / `from` / `to` / `pid` / 时间戳 + **原始字节** + 补丁全文），还原后删除；原子写。
- **开跑前自检 `check.mjs`**：文件仍等于 patched → 按原始字节**自动还原**（含 CRLF）；
  文件被第三方改过 / 标记 pid 还活着（在飞）→ **拒绝运行并列清单**。
- **互斥锁**：第二个 mutator 被告知"已有 mutator 在跑"；陈旧锁自动清理；`exit`/`SIGINT`/`SIGTERM`
  清锁并还原在途补丁；脏工作树（`src/**`、`test/**`）默认拒绝，`--allow-dirty` 放行。
- **强杀可感知**：`run.mjs` 启动时与每批之间自检；stdout/journal 区分「变异进行中」与「已还原」。
- `test/mutate/selfcheck.mjs` **8/8**（含**真 SIGKILL** 模拟：标记 + 陈旧锁留下 → 下次 check 自愈）。
  文档新增 `test/mutate/FAILSAFE.md`。

### 二、本地端点并发与内存（§3.60，§3.59 收口）

- **进程级 `acquireLocalSlot` 串行化**：默认 `localConcurrency=1`，`0` 关闭、上限 **16**；
  `localQueueTimeoutMs` 默认 **30 分钟**，排队超时报 `LOCAL_QUEUE_TIMEOUT`（**可见错误、不重试**）。
  覆盖**父回合 / 子代理 / 预检**；**云端 `baseUrl` 直接放行**。
- **计时口径**：首帧计时在**取得名额后**起算；**总时长含排队**且可中断。
- **四处可见"已串行化（防内存压力）"**：入队日志、进度行、界面状态条、发送前预告。
- **错误分型**：`engine shed its caches and stays up` / `allocator wall` **独立分型**——
  明确"**引擎未崩溃、不要重启**"；`agent` 的 507 早退排除该措辞。`prefillForecast` 在本地端点
  已有在途请求时给**并发强警告**（"并发会加剧内存压力 / 已串行化 / 减少子代理"）。
- 文档：`docs/CONFIG.md` 新增「本地模型：并发与内存」；`docs/CONFIG.en.md` 同步。

### 三、`parseToolArgs` 纯函数 + 顶层空值回填修复（§3.62）

- `src/tools-flow.js` 新增 `export parseToolArgs(raw)`，把 `agent.js` 内联的
  `JSON.parse` / `|| '{}'` / 非对象归一化 / 三段错误文案收成**一个纯函数**；
  三条副作用（`renderToolDenied` / 审计 / `messages.push` 分块指引）**按原顺序保留**。
- **行为清单（8 条，零行为变化）**：假值 raw → `{}`；合法 JSON 对象 → 原样；
  合法但非对象（`'null'`/`'[]'`/`'42'`/`'"s"'`/`'true'`）→ `{}`；空白串 / 非法 JSON → 三段文案逐字一致；
  **不做前后缀宽容**（代码围栏、多余尾巴都失败）；**不做长度上限**；非字符串走隐式 ToString。
- **空值回填修复**：顶层 `undefined`/`null`/**函数**/**符号** → **空串**
  （此前会给模型字面量 `"undefined"`/`"null"`）；**嵌套 `null` 与字符串 `"null"` 保留**。

## 升级须知

1. **同一本地端点的请求现在默认排队。** 默认 `localConcurrency=1`：父回合、子代理、预检共用
   一个名额。并发子代理多时，**墙钟时间会变长**（这是刻意的——用等待换"不再被引擎拒绝"）。
   需要恢复旧行为可设 `localConcurrency: 0`（不建议在内存紧张的机器上这么做），或调大（上限 16）。
2. **排队超时默认 30 分钟**，超时报 `LOCAL_QUEUE_TIMEOUT`（**不会自动重试**）。
   若你的单请求本来就要跑很久，请调大 `localQueueTimeoutMs`。
3. **首帧计时从"取得名额后"起算**；但**界面上的总时长包含排队**——看到"总时长很长、首帧很短"
   是正常的，说明时间花在排队上。
4. **"引擎活着但丢了缓存"不再被建议重启。** 看到 `engine shed its caches and stays up` /
   `allocator wall` 时，正确做法是**减少并发 / 减少子代理 / 缩小上下文**；重启引擎不解决问题。
5. **工具参数解析对模型更严格，也更诚实。** 代码围栏（```json … ```）与前后缀**仍然不被宽容**；
   超长参数**不设闸门**。工具返回顶层空值时，模型现在收到**空串**而不是 `"undefined"`。
6. 本版**不改** `desktop/**` 的构建与自动更新链路；桌面安装包版本随 `desktop:sync` 与根版本一致。

## 同批并入（并行道）

- **账本 `run.start.permissionSource`（§3.64）**：记录生效权限值的来源（`explicit` / `preset` /
  `config` / `cli` / `default`；非法或缺失为 `null`）。旧账本与 `LEDGER_VERSION` 不变；
  后台任务与 REPL 内 `/preset` 切换的来源暂为 `null`。回归：`test/ledger-source.js` 7 组 + `batch34` 7 条。
- **英文文档同步（§3.65）**：`README.en.md` / `SECURITY.md` / `docs/CONFIG.en.md` 与代码对齐。
- **M-8 源码守卫收口（§3.63）**：`src/web/server.js` 的 43 处单行源码文本守卫整簇处理（25 处行为化 +
  18 处加固），新增 `batch33-guards2.mjs` 27 条变异全中。
- **UI 设计提案 v1（§3.66，仅文档）**：`docs/DESIGN-UI-v1.md` + `docs/design/ui-preview.html`，不改产品代码。
- **测试可移植性修复（两处，纯测试代码）**：§145 慢命令改为 Unix `sleep 11` / Windows `ping -n 12`；§134 不再改全局 `child_process.spawn`（改为经 `Module._load` 只注入给被加载的 IDE 扩展）——后者是 CI ubuntu-18/windows「5s 前置」假红的真正根因（Node 18 下同进程 bash 工具拿到桩 child，11 秒回合变 15ms）。

## 已知边界（如实登记）

- **前置门整体仍未抽**：`prepTool` 里的 hooks → 白名单 → 权限 → 约束确认的**顺序与短路仍是原样**，
  账本 `toolCall` 内容仍依赖门的结果。本版只切了门前最前端、零 await 零副作用的一步。
  抽整个前置门需要同时决定"门的结果如何进账本"，不属于补丁版。
- **`parseToolArgs` 不宽容前后缀、无长度上限**：这是**有意的零行为变化**，不是遗漏。
  代码围栏与多余尾巴仍按非法 JSON 失败；20000 字符合法参数照常解析（不设闸门）。
- **本地端点不限制子代理数量**：串行化只约束**同一 `baseUrl` 上的在途请求数**，
  不会阻止你开 10 个子代理（它们会排队）。**不同 `baseUrl` 之间不汇总内存压力**——
  两个本地端点各开 1 并发，对同一台机器的内存仍是 2 份压力。
- **引擎侧参数不归 harness 管**：`--context-window`、`-ngl`、q8 量化等由你启动 llama.cpp 时决定；
  harness 只能读 `/props` 自述并告警，**不能替引擎改**。内存压力的根治仍在引擎侧配置。
- **变异 fail-safe 的 SIGKILL 窗口**：进程被 `SIGKILL` 的**当下**没有机会还原，补丁会留在工作树，
  直到**下一次 `check`（或 `run.mjs` 启动/批次之间）**才自愈。这个窗口内**不要提交/发版**；
  `git status` 看到 `src/**` 改动而你没改过，先跑 `node test/mutate/check.mjs`。
- **`localConcurrency` 是进程级**：多进程（多个 `mingdao` 实例、桌面版 + CLI 同时跑）各自计数，
  互不感知；跨进程的内存压力仍然只能靠人控制。
- **真机未复跑**：本版验证是桩服务 + 桩引擎 + 独立干净 worktree 的全量门禁；
  负责人真机上的三个端点（60091 / 8081 / 8082）本轮**未复跑**——留给下一轮真机验证。

## 验证

- 全量门禁（**在干净 worktree `fe7162f` 上逐项单独跑、逐项取 `$?`**）：
  `npm run typecheck` 0 / `npm run typecheck:strict` 当前 0 基线 0 / `node test/smoke.js` **156 组全通过（单独跑）** /
  `node test/e2e-local.js` 17 项 / `node test/e2e-web.js` 24 项 / `node test/e2e-schedule.js` 11 项 /
  `node test/api-contracts.js` 8 项 / `node test/pack-ctx-privesc.js` 4 组 /
  `node test/mutate/selfcheck.mjs` **8/8** / `npm run bench` **5 套 0 失败** /
  `node test/mutate/run.mjs` **23/23 批、271/271 条全中** / `node scripts/doc-lint.mjs` 全通过 /
  `node src/cli.js diagnose` 正常。
- 发布提交只含发布文件（CHANGELOG / RELEASE-NOTES / `package.json` / `package-lock.json` /
  `desktop/package.json`）；`git diff --name-only <门禁SHA>..<tagSHA> -- src test` 为 **0 行**。
