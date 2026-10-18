# MingDao Harness v0.6.18 发布说明

> 状态：**已发布**（tag `v0.6.18`）
> 主题：**本地引擎撑不住时，先压小再试一次；界面只留正文和一行轨迹；变异不再跨 worktree 打架**
> ——本地引擎「显存/内存不足」自动降级重试一次（§3.74）；轨迹/子 Agent 收进右栏与窄屏末尾
> `#traceDock`（§3.73）；变异验证改为跨 worktree 全局锁（§3.75）；更新未验证来源签名提示精简为两行
> （§3.72）。逐条根因与取舍见 `docs/internal/AUDIT-v0.6.1-第三方报告登记.md` §3.72–§3.75。

## 为什么发这一版

三件事都来自**真机与当天的真实故障**，不是代码审查的推演：

| # | 现场 | 这一版怎么处理 |
| --- | --- | --- |
| 1 | v0.6.17 真机（8081 qwen）：子代理并发/长解码时引擎在 prefill 前拒绝——`insufficient memory: … sustained critical memory pressure during prefill; aborted before the allocator wall`。当时上下文只有 ≈2,773 tokens、预算 32,768，压小后极可能成功，但整回合**直接失败** | **仅本地端点**：命中内存判据后上下文 ×0.6（下限 4k）+ 输出 ×0.5 + 强制并发 1，**只重试一次**；二次失败带具体数值与建议（§3.74） |
| 2 | 长任务时 N 次工具调用与子代理内联堆在对话流里，把正文淹没；窄窗口右栏一收（<1180）又完全看不到细节 | 轨迹/子Agent 进右栏可折叠区；<1180 落到对话流末尾 `#traceDock`；对话流每轮只留**一行摘要**（§3.73） |
| 3 | 当天两次「两道并行执行者各在自己的 worktree 跑 `run.mjs`」：锁是各 worktree 一把，等于没有互斥——固定端口冲突，§145 时序断言在负载下假红；人工 `mkdir` 协议的陈旧判据又把活锁删掉 | 互斥做进 `run.mjs`：全局锁 + 「pid 不在 **且** mtime>15min」双条件 + `.takeover` 令牌 rename（§3.75） |
| 4 | 负责人实测更新就绪弹窗「太长、像一篇说明书」（五句） | 正文精简为两行，完整说明留在日志行；判据一行未动（§3.72） |

> 一句话：**能恢复的失败不要直接判死，能收纳的信息不要占正文，能互斥的锁不要靠人肉协议。**

## 变化

### 一、本地引擎内存不足自动恢复（§3.74）

- **判据单一** `isMemoryPressureError()`：HTTP **507**、`insufficient memory`、`memory_refusal`、
  `allocator wall`、`engine shed its caches and stays up`、OOM（**词边界**，`room`/`zoom` 不误判）；
  **不含** 400/401/429 与普通 5xx。
- **仅本地端点**：`isLocalBaseUrl` 或 `customModels.<名>.local` 才算；云端 507 不重试。
- **一次有界降级**：本回合 `contextBudget × 0.6`（**下限 4096**）、`maxOutputTokens × 0.5`、
  重试请求 `localConcurrency: 1`；`MAX_MEMORY_RETRIES = 1`，第二次仍失败即如实抛错。
- **不掩盖**：`♻ 因本地引擎内存不足，已压缩上下文（32,768 → ~19,660）…并重试一次（串行化：并发上限 1）`；
  失败文案带压缩前后数值、输出上限、`config.contextBudget` 建议与 `--ctx-size` / q8 KV；
  `done.note` 与 `web-server.log` 同源记录。
- **自适应 clamp**：预检读到引擎 `n_ctx` 且预算 > `n_ctx × 0.8` 时，**发请求前** clamp 并提示。
- **断言**：新套件 `test/memory-recovery.js`（5 项）+ `batch40-memory-recovery.mjs`（11 条变异）。

### 二、轨迹与子 Agent 收纳（§3.73）

- 对话流每轮正文末尾**一行**：`🧭 本轮 12 次工具调用 · 3 个子代理 · 1m42s ›`；无工具且无子代理时隐藏。
- ≥1180：右栏「轨迹」「子Agent」两块，均可折叠；子代理行 = 名称 · 轮次 · 工具次数 · 最后进展 · 状态。
- <1180 且右栏收起：两块落对话流末尾 `#traceDock`；点摘要定位该轮（窄屏滚 dock / 宽屏定位右栏）。
- **同一函数、同一数据源**：摘要与右栏都走 `traceRoundForMsg()` → `traceRoundView()`，不另算一套。

### 三、变异跨 worktree 互斥（§3.75）

- 全局锁 `os.tmpdir()/mingdao-mutate.lock/`；`owner.json` 记 `pid`/`startedAt`/`cwd`/`argv`/`host`。
- 陈旧判据**双条件**：pid 不在 **且** mtime > 15 分钟；只有一条成立一律**拒绝不接管**
  （含"锁很新但 pid 已死"与"owner 读不到"）。
- 接管用 `.takeover` 令牌 + 整目录 `rename` 成 tombstone 后重建，不裸删。
- `selfcheck` **14/14**（新增 6 个真跑场景，含当天踩的坑的回归）；全量 **30/30 批、342/342 条**。

### 四、更新未验证来源签名提示精简（§3.72）

- `warn-and-install` 弹窗正文两行：未验证 + 已按默认策略安装 / 环境变量 + 详情见日志与官网。
- 标题与主句不变，`allowInstall` 仍为 `true`；日志 `logLine` 反而更详细（完整说明）。
- `smoke` §135 新增：用户可见文案 ≤220 字符、正文 ≤2 行、四类关键串必须在、日志含完整说明。

## 升级须知

1. **内存自动恢复只对本地端点**：云端 507/400/401/429 行为与之前完全一致（不重试），
   不要指望它修复云端容量问题。
2. **只重试一次，且不承诺一定成功**：第二次仍失败会如实报错并给出建议；恢复与否取决于引擎侧
   剩余内存/显存。
3. **压缩不改写历史**：只下调**本回合**预算并复用既有 compact/trim 投影，会话历史文件不变；
   预算下调后本回合后续请求沿用，不会在成功一次后自动恢复原值。
4. **clamp 只在读到 `n_ctx` 时发生**：没读到引擎自述上下文时不猜、不 clamp（保留既有行为）。
5. **轨迹没有新增轮询**：右栏与 `#traceDock` 只消费既有 SSE（progress≈1s / usage / done）与
   `/api/state`；子代理运行中更新用的是快照聚合。
6. **变异互斥是「本机」协议**：`os.tmpdir()` 级互斥，不是分布式锁；CI 与本地同时跑仍需人确认。
7. 本版不改桌面版构建与自动更新链路；安装包版本随 `desktop:sync` 与根版本一致。

## 已知边界（如实登记）

- **内存自动恢复只对本地端点**：云端端点 507 不压缩、不重试（多烧一次请求换不来任何容量）。
- **只重试一次**：`MAX_MEMORY_RETRIES = 1`；第二次失败即失败，不做第二、第三次降级。
- **不改写历史上下文**：压缩只作用于本回合预算与既有 compact/trim 投影，不重写会话历史文件；
  本回合成功后也不会自动恢复原预算。
- **无 `n_ctx` 时不 clamp**：引擎没有自述上下文（或预检失败）时保持原预算，不猜测。
- **子代理内部工具未逐条回传**：SSE 只给聚合快照（工具次数/自身轮次/最后进展时间），
  子代理内部每一次工具调用的参数与输出不在主会话流里逐条可见；要看细节仍需子代理自己的日志。
- **窄屏未做真实截图验证**：<1180 的 `#traceDock` 与 <900 断点由 smoke 的类名/行为断言覆盖，
  但没有在真实 Electron 窗口逐档截图；「900px 无横向滚动/无裁切」仍建议人工过一遍。
- **变异互斥不是分布式锁**：只在本机 `os.tmpdir()` 上互斥；多机/多容器共享同一个工作树仍会并发。
- **强杀后 15 分钟内不接管**：`run.mjs` 不会接管「pid 已死但锁很新」的锁（防 `mkdir`→node 空窗）；
  需立刻继续时先跑 `node test/mutate/check.mjs`（显式自愈入口），或按 `FAILSAFE.md` 手工解锁。
- **pid 复用仍按安全侧拒绝**：锁/标记里的 pid 被系统回收给无关进程时，输出 cwd/startedAt/锁目录
  供人工判断，不自动接管。
- **更新弹窗仍是每次提示一次**：没有「不再提示」配置（不写 config、不做静默）；「详情见日志与官网」
  没有内联 URL（两行放不下两个 URL），URL 在日志行与拒绝分支里。
- **真机未复跑**：内存恢复的验证全部是桩 provider + 纯函数；窄屏/亮色/子代理收纳的逐项点击
  本轮未在负责人真机复跑。

## 验证

- 全量门禁（逐项单独跑、逐项取 `$?`）：`npm run typecheck` 0 / `npm run typecheck:strict` 当前 0 基线 0 /
  `node test/smoke.js` **156 组断言全通过（单独跑）** / `node test/e2e-local.js` 17 项 /
  `node test/e2e-web.js` 24 项 / `node test/e2e-schedule.js` 11 项 / `node test/api-contracts.js` 8 项 /
  `node test/pack-ctx-privesc.js` 4 组 / `node test/ledger-source.js` 7 组 /
  `node test/model-names.js` 8 组 / `node test/memory-recovery.js` 5 项 /
  `node test/mutate/selfcheck.mjs` **14/14** / `npm run bench` **20 通过 / 0 失败** /
  `node test/mutate/run.mjs` **30/30 批、342/342 条全中** /
  `node scripts/doc-lint.mjs` 全通过 / `node src/cli.js diagnose` 正常。
- 发布提交只含发布文件（CHANGELOG / RELEASE-NOTES / `package.json` / `package-lock.json` /
  `desktop/package.json`）；`git diff --name-only <门禁SHA>..<tagSHA> -- src test` 为 **0 行**。
- 三平台 main 与 tag 对齐；npm 已发布 `mingdao-harness@0.6.18`；官网 hero、三份 `/updates/*.yml`、
  7 个下载 URL 与两个域名线上核对通过；镜像 Release 日志出现 `MIRROR_RELEASE_DONE v0.6.18`。
