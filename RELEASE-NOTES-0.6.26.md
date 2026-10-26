# MingDao Harness v0.6.26 发布说明

> 状态：**已发布**（tag `v0.6.26`）
> 主题：**本地引擎内存韧性 v2 + 布局断点修复**
> ——两件事，互不依赖：① 本地引擎（Ollama 等）在上下文装不下时，不再「压一次就放弃」：
> 改为**两级压缩（硬上限 2 次重试）**，并把「这个端点装不下」**学到**
> `~/.mingdao/endpoint-limits.json`，**下一回合起手即用**（`chat 预告` 注明来源）；
> 子代理继承父回合的压缩预算，且自己也会两级压缩。② <900 的窄条不再压住正文，
> 右栏收起点 **1180 → 1100**（1100 / 1180 整点都是三栏）。细节见
> `docs/internal/AUDIT-v0.6.1-第三方报告登记.md` **§3.91 / §3.92**。

## 一、内存恢复 v2（§3.91，`src/agent.js` + `src/providers/index.js`）

**证据**：`~/.mingdao/logs/web-server.log` 在 10-18 / 10-19 / 10-26 三次出现同一形态——
子代理跑到 31 轮 / 50 次工具调用后，本地引擎返回
`insufficient memory … aborted before the allocator wall`；v0.6.18 的「一级压缩（×0.6）+ 一次重试」
压到 19,660 仍被拒，整回合直接失败。

根因三条：①只有一级压缩，没有下一级；②内核**不记住**「这个端点装不下」，下一回合又从 32,768
撞同一堵墙（建议里的 13,762 只是文案，没有落盘）；③子代理仍按父回合压缩**前**的预算发请求，
父子预算不一致，29 分钟白跑。

### 1.1 两级压缩，硬上限 2 次重试

| 级别 | 上下文预算 | 输出上限 |
| --- | --- | --- |
| 第 1 级 | `× 0.6`（32,768 → 19,660） | `× 0.5`（8,192 → 4,096） |
| 第 2 级 | `× 0.35`（32,768 → 11,468） | `× 0.25`（8,192 → 2,048） |
| 下限 | **4,096** | **512** |

- 比例都相对**本回合起手值**（不是逐级连乘），日志/文档里的数字一一对应；
- `MAX_MEMORY_RETRIES = 2`：第 3 次失败直接报错，**不存在无限重试**；
- 每次重试各打一行日志（第几次 + 压缩前后数值），`done.note` 带完整链路
  `32,768 → 19,660 → 11,468`；
- 串行化照旧：每次重试都传 `localConcurrency: 1`（复用既有 `acquireLocalSlot`）。

### 1.2 端点级学习：`endpoint-limits.json`

- **键 = 归一化 `baseUrl`**，值
  `{safeContextBudget, learnedAt, source:'memory-failure', attempts, maxOutputTokens}`；
- **只有两级压缩都失败**才把「最后尝试的预算」写入；
- 下一回合（`createAgent` / 每回合起手）**重读**该文件，直接以 `safeContextBudget` 起手
  （用户配置本来更小则用户优先），并在 `chat 预告` 写明
  `该端点曾因内存不足降级，本轮预算 N（来自 YYYY-MM-DD 的失败学习…）`；
- **恢复**：连续 **3 次干净成功**（无压缩 / 无中断 / 无截断）→ 学习值 **+25%**，
  上限 = 用户配置预算；上调后若再撞墙，会被重新学下来；
- **失败不阻断会话**：读失败（损坏 / 权限）→ warn + 按无学习值继续，且**不覆盖**损坏文件；
  写失败 → warn + 降级，回合仍按正常内存失败文案收口。

### 1.3 子代理继承（两条都实现）

- 父回合压缩时同步更新 `currentTurnBudget/currentTurnMaxOutput`，`spawnTask` 用它们作为
  子代理的 `contextBudget/maxOutputTokens`（不再是压缩前的原预算）；
- 子代理自己也走同一套两级压缩（独立于父回合；父回合没压缩时也能自救）。

### 1.4 提示词与学习值对齐

`describeUpstreamError` 的 hint 与最终失败文案改用**同一个学习值数字**
（`已把该端点内存安全预算记为 11,468（写入 …/endpoint-limits.json），下轮起手自动使用——config.contextBudget 也可手动调到 11,468`），
不再出现「建议值」与「实际起手值」分裂。`docs/CONFIG.md` 同步重写本节（两级表格、
学习文件 schema、上调策略、边界）。

## 二、布局断点修复（§3.92，`src/web/index.html` + `src/web/app.js`）

**证据**：负责人对 v0.6.25 指出两处已确认的布局缺陷（只动布局、不动功能）：
①<900 左栏变成覆盖式抽屉后，44/42px 的固定窄条仍压住居中正文左缘（880×900 截图里欢迎语/
消息卡左缘落在窄条下方）；②`#runPanel` 的 `@media (max-width:1180px)` 在 1180 整点把右栏
`display:none`，1180 因此不是设计稿要求的三栏。

### 2.1 <900：窄条不再压正文

`body.side-drawer main,body.side-drawer footer` 的左边距由 0 改为 **48px**（44px 窄条 + 4px 间隙）；
窄条仍是 `position:fixed`（不占文档流），补偿只加偏移、不设宽度。880 下主区宽 832px、
`#chat` 左缘 48px ≥ 窄条右缘 44px，正文不再被压，也不出现横向滚动。

### 2.2 右栏收起点 1180 → 1100（由 `body.narrow-run` 收口）

- 收起规则由 `@media (max-width:1180px)` 下调为 `@media (max-width:1100px)`，并加
  `body.narrow-run` 限定（`body.narrow-run #runPanel{display:none}`、
  `body.narrow-run.run-drawer #runPanel{display:flex}`）；`narrow-run` 只在 `w < 1100` 时挂上，
  因此 **1100 与 1180 整点都是三栏**；
- 新增 `@media (min-width:1101px) and (max-width:1180px)`：`#runPanel{width:260px}`、
  `body.run-open{padding-right:260px}`，`#sessSheet`/`#scrollBottomBtn` 同步右移；
  右栏仍可见、内部照常滚动，1180 三栏时正文仍有 638px；
- **1000 / 880 仍是抽屉**（左右抽屉 `display:flex` 未动）；`src/web/app.js` 的
  `layoutClassesFor()` 只改阈值：`narrowRun: w < 1180` → `w < 1100`；
- 左栏三档（1180 / 900）、≥1200 列宽、顶栏高度、主题、字号阶、入口均未动；
- `test/mutate/batch38-ui-p1.mjs` ⑦ 的锚点同步 `1180 → 1100`（**语义未放宽**，
  断言「900px 以下必须收起侧栏」不变）。

## 三、测试与变异

- `test/memory-recovery.js`：**5 项 → 11 项**——两级压缩各自生效、学习值落盘 / 生效 / 预告、
  子代理继承、子代理自压缩、+25% 上调、损坏 / 不可写降级；保留云端 507 不重试、`n_ctx` clamp、
  400/401/429 不触发。
- `test/mutate/batch40-memory-recovery.mjs` 按 v2 判据重写：**11/11**；
  新建 `test/mutate/batch52-memory-v2.mjs`：**11/11**（第 2 级不降预算 / 不降输出、学习值不落盘、
  学习值不生效、子代理不继承、多一次重试、建议与学习值脱节、损坏文件被覆盖、写失败直接抛、
  上调比例错、学早了）。
- `test/smoke.js` 新增 **§160**：窄条 `fixed/absolute` 不占流、<900 窄条 44px、补偿 48px ≥ 44px、
  补偿不设固定宽度、880 下 `#chat` 左缘 ≥ 窄条右缘、`body{overflow-x:hidden}`；
  `@media (max-width:1100px)` 存在且由 `body.narrow-run` 收口、`max-width:1180px` 不再收起右栏、
  `layoutClassesFor(1099)=narrowRun:true`、`1100/1180=narrowRun:false`；1101–1180 右栏 260px；
  1000/880 仍抽屉；各视口正文可用宽度 ≥320px。
- 新建 `test/mutate/batch52-layout-bp.mjs`：**11/11**（收起点改回 1180、JS 阈值回退、
  补偿归零 / 缩到 30px、窄条恢复占流、1101–1180 右栏 `display:none`、左右抽屉丢失、
  补偿加 `min-width` 与 `body{overflow-x:auto}` 造成横向滚动、收起规则去掉 `narrow-run` 收口）。
- 全仓变异总数 **439 → 461**（41 批；`test/mutate/README.md` 计数行同步）。

## 四、验证（本机 macOS，最终 HEAD）

- `npm run typecheck` → **0**；`npm run typecheck:strict` → **当前 0 / 基线 0**
- `node test/smoke.js` 单独跑 → **全部通过：156 组断言**（含新增 **§160**）
- `node test/e2e-local.js` → 17 项；`node test/e2e-web.js` → 24 项；
  `node test/e2e-schedule.js` → 11 项；`node test/api-contracts.js` → 8 项
- `pack-ctx-privesc` 4 组 / `ledger-source` 11 组 / `model-names` 8 组 /
  `memory-recovery` **11 项** / `ui-sessions` 5 项 → 全通过
- `node test/mutate/selfcheck.mjs` → 14/14 场景通过
- `npm run bench` → 5 套基准全通过
- `node test/mutate/run.mjs` → **41/41 批全中、461/461 条变异被抓到**（跑完自动还原，无残留）
- `node scripts/doc-lint.mjs` → 全通过（变异总数 461）；`node src/cli.js diagnose` → 报告正常、密钥脱敏
- 发布提交只含五个发布文件（`CHANGELOG.md` / `RELEASE-NOTES-0.6.26.md` / `package.json` /
  `package-lock.json` / `desktop/package.json`）；
  `git diff --name-only <门禁SHA>..<tagSHA> -- src test` → **0 行**
- 发布树截图（真实 Electron，`scripts/ui-shot.mjs`）：
  - `/tmp/shots-0626`（1440×900）
  - `/tmp/shots-0626-1180`（1180×900）
  - `/tmp/shots-0626-880`（880×900）

## 五、已知边界（逐条如实登记）

- **两级压缩后仍可能失败**：引擎显存是硬限制。本版保证的是「有界地多试一次 + 记住能用的预算 +
  建议值与起手值一致」，不保证一定跑完；若第 3 次仍失败，回合如实失败，并给出该端点的学习值建议。
- **学习值只按 `baseUrl` 记录，不含模型名**：同一个引擎端口换更小/更大的模型不会自动重置学习值；
  换端口或反代地址会形成第二条记录（刻意：不同端口/反代可能对应不同显存与并发配置）。
- **连续 3 次干净成功才 +25%**：恢复是**渐进的**，一次成功不会立刻回到用户配置；上调后再失败会被
  重新学下来，不保证一次收敛到最优值。
- **1180 顶栏右侧仍需横向滚动**：`hdr-right` 是 `overflow-x:auto` 的可滚动容器（v0.6.21 §3.83 既定），
  本版只下调右栏收起点，未重排顶栏入口；1180 下最右侧按钮仍可能需要横向滚动才能看到。
- **未在真 Windows / 真机逐按钮验收**：本版改动是内存恢复（本地引擎路径）与布局断点；
  Windows 侧证据只有 CI 的 `test (windows-latest, 20)`，未在标准 Windows 账户（未开 Developer Mode）
  上跑 `npm test`，也未逐按钮点选验收。
- **未改** `src/providers/` 的云端路径判据、`presets/**`、`desktop/**`（版本号除外）、`ide/**`；
  不新增后端接口、网络请求或轮询。

## 六、升级须知

1. 从 v0.6.25 升级是**无迁移**的：学习文件在第一次「两级都失败」后才出现，之前不存在也不影响启动。
2. 学习值文件是 `~/.mingdao/endpoint-limits.json`（可用 `MINGDAO_HOME` 改变位置）；
   想手动重置就删掉对应 `baseUrl` 的条目——内核会重新从 `config.contextBudget` 起手。
3. 想彻底关掉降级：把 `config.contextBudget` 直接调到引擎装得下的值（学习值不会超过它）。
4. 布局变化只在 **1101–1180** 与 **<900** 两个区间可见：前者右栏由收起变为 260px 三栏，
   后者正文整体右移 48px；1440 / 1180 / 1100 的三栏形态与 v0.6.25 一致。
5. 本版不删除任何历史产物；需要回退可继续安装 v0.6.25 / v0.6.24。
