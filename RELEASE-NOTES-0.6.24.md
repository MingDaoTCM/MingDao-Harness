# MingDao Harness v0.6.24 发布说明

> 状态：**已发布**（tag `v0.6.24`）
> 主题：**新增左侧会话栏（三栏成型）+ 账本权限来源补全**
> ——本版两件事：① 按设计稿补上**左侧会话栏**（§3.88，**只增不删**）：新建对话 / 工作空间 /
> 最近会话（今天·昨天·本周·更早）第一次有了常驻位置，顶栏九个既有入口**一个都没删**；
> ② 把执行账本的 `permissionSource` 从 WebUI/CLI 前台**补全到 worker 与 REPL**（§3.89），
> 并新增来源枚举 `job`——后台/REPL 会话的 `auto`/`readonly` 是谁定的，事后能回答了。
> 细节见 `docs/internal/AUDIT-v0.6.1-第三方报告登记.md` **§3.88 / §3.89**。

## 一、§3.88 左侧会话栏（三栏成型，只增不删）

### 为什么改

设计稿是「窄条 → 会话栏 → 主区 → 右栏」三栏骨架，而 v0.6.23 只有 42px 窄条 + 主区 + 右栏：
新建对话、历史会话、工作空间全挤在顶栏，顶栏在 1000px 下已需要横向滚动。
左栏是设计稿的标志性部分，但 v0.6.19 的翻车教训正是「重排时把顶栏入口删掉」——所以本版
按**只增不删**做：左栏是新增的第四段，不是把顶栏搬空。

### 改了什么

- 新增 `<aside id="sideNav">`，固定在既有窄条右侧（`left:42px`），**240px**；折叠 **48px**；
  视口 **≥1180** 展开、**900–1180** 自动折叠为 48px 图标列、**<900** 变**覆盖式抽屉**
  （默认收起，窄条新增 `#sideNavRailBtn` 打开）。主区 / 输入区用 `margin-left` 右移
  **282 / 90 / 0**，左栏**不遮正文**；**顶栏保持整条横贯、高度与九个入口不动**，
  `#runPanel` 宽度、主题 token、字号阶均**未改**。
- 内容只复用既有数据与 handler，**不新增后端、请求或轮询**：
  - **`+ 新建对话`** → 转发既有 `#newChat.click()`（同一 handler）；
  - **最近会话** → 复用 `refreshSessions()` 已有的 `sessionsGroupedCache`
    （`groupSessionsByUpdatedAt` 的**今天 / 昨天 / 本周 / 更早**四组），当前会话高亮；
    点击写回 `#sessions.value` 并派发 `change`（复用既有切换逻辑）；
  - **工作空间** → 新增 `#sideNavWs` **镜像**顶栏 `#wsSel` 的选项与选中值，change 时写回
    `#wsSel` 并派发 `change`（`__add__` / `__manage__` 也走原 handler）；顶栏 `#wsSel`
    原控件、原 id、原位置保留；
  - **折叠按钮** `#sideNavCollapse` → 偏好写 `localStorage['mingdao-sidenav-collapsed']`，
    启动时由 `initSideNav()` 恢复。
- 不引入设计稿 CSS / 外部样式表，只新增左栏自身规则，复用既有 `--bg2/--bg3/--border/--accent` token。

### 顶栏入口（本版核心防回归点）

顶栏**九个入口全部保留且 id 唯一**：`#wsSel` / `#sessions` / `#sessMgrBtn` / `#tasksBtn` /
`#newChat` / `#themeBtn` / `#costBadge` / `#paletteBtn` / `#cfgBtn`——`test/smoke.js` **§158**
逐个点名断言它们仍在 `<header>` 内、且 `id` 在整份 HTML 中唯一。

### 顺带修的测试日期炸弹

`test/ui-sessions.js` 此前用**硬编码日期**（2026-10-21），跨天后必红；本版改成**相对今天**
构造夹具，batch46 的 ⑤/⑫ 由「依赖当天日期」转为稳定断言——`batch46` 现在 **12/12 全中**
（`node test/ui-sessions.js` 套件本身仍是 5 项断言，输出「5 项 ✓」）。

## 二、§3.89 账本 `permissionSource` 补全 worker / REPL（新增 `job`）

### 为什么改

§3.64 的 `run.start.permissionSource` 只覆盖 WebUI 与 CLI 前台。`src/tasks/worker.js`
（后台任务 / 调度）不向 agent 传来源，`src/commands/repl.js` 的 `/preset` 切换会重建
`agentCfg` 并丢掉来源——两条路径的 `run.start.permissionSource` 恒为 `null`，
事后无法回答「后台/REPL 会话的 `auto`/`readonly` 是谁定的」。
worker 另有一处**生效值**口径问题：`agent.js` 记的是 `cfg.permission ?? permission.mode`，
`mingdao run --permission auto` 被 `config.permission=readonly` 盖过时，账本记下的是
**没有生效**的 readonly。

### 改了什么

- **worker**（`src/tasks/worker.js`）：来源口径 = 任务规格显式 `permission` → **`job`**；
  否则 `config.permission` → `config`；都没有 → `default`。同时把**降级后**的权限放进交给
  agent 的 `agentCfg.permission`，使账本 `permission` 记**实际生效值**
  （`ask → readonly` 降级只改生效值，来源仍按上述口径）。不写回 `loadConfig()` 的 `cfg`。
- **REPL**（`src/commands/repl.js`）：启动时**原地**沿用入口（`cli.js`）算好的来源——
  未切预设 → `config`（有 `config.permission`）/ `default`（无），**不再写 `null`**；
  `--preset` 已声明 permission → `preset`；会话内 `/preset` **仅当预设声明、且被反提权判定
  采纳了 `permission`** 才记 `preset`，只换提示词/工具白名单/模型的预设不冒充来源。
- **账本**（`src/ledger.js`）：`PERMISSION_SOURCES` 新增 **`job`**——后台任务/调度任务规格
  显式指定的 `permission`。**不复用 `explicit`**：`explicit` 表示「用户在本回合交互里选的」，
  而 `job` 是提交任务时写进规格的；混用会让事后看到 `explicit` 的人误以为跑的时候有人按了
  权限档。导出物的来源图例同步补 `job`；`cli` 的注释改为「保留给前台 CLI 的显式权限参数
  （当前无前台入口）」。
- **兼容**：`LEDGER_VERSION` **不变**；旧账本（无该字段）`verify` 仍通过，`show` 只是少一行
  可选的「权限来源」，不会多打印行。
- `docs/CONFIG.md` 补 `permissionSource` 的完整枚举表与 WebUI / CLI / worker / REPL
  四类入口的取值口径（含新增 `job`）。

### 测试与变异

- `test/ledger-source.js`：**7 组 → 11 组**。新增 4 组：worker 默认（无任务规格 permission）
  → `config`；任务规格显式 permission → `job`（并钉住显式 `auto` 必须压过
  `config=readonly` 的生效值）；REPL 启动 → `config` / `default`；REPL `/preset` → `preset`。
  旧账本无字段仍 `verify` 通过、`show` 不多出「权限来源」行的回归保留。
- `test/mutate/batch49-side-nav.mjs` **11/11 全中**、`batch50-perm-source.mjs` **7/7 全中**；
  全仓变异总数 **407 → 425**（38 批）。

## 三、验证（本机 macOS，最终 HEAD）

- `npm run typecheck` → **0**；`npm run typecheck:strict` → **当前 0 / 基线 0**
- `node test/smoke.js` 单独跑 → **全部通过：156 组断言**（含新增 **§158**）
- `node test/e2e-local.js` → 17 项；`node test/e2e-web.js` → 24 项；
  `node test/e2e-schedule.js` → 11 项；`node test/api-contracts.js` → 8 项
- `pack-ctx-privesc` 4 组 / `ledger-source` **11 组** / `model-names` 8 组 /
  `memory-recovery` 5 项 / `ui-sessions` 5 项 → 全通过（batch46 变异 12/12）
- `node test/mutate/selfcheck.mjs` → 14/14 场景通过
- `npm run bench` → 5 套基准全通过
- `node test/mutate/run.mjs` → **38/38 批全中、变异 425/425 条被抓到**（跑完自动还原，无残留）
- `node scripts/doc-lint.mjs` → 全通过；`node src/cli.js diagnose` → 报告生成正常、密钥脱敏
- 发布提交只含五个发布文件（`CHANGELOG.md` / `RELEASE-NOTES-0.6.24.md` / `package.json` /
  `package-lock.json` / `desktop/package.json`）；
  `git diff --name-only <门禁SHA>..<tagSHA> -- src test` → **0 行**
- 发布树截图（真实 Electron，`scripts/ui-shot.mjs`）：
  - `/tmp/shots-0624`（1440×900）
  - `/tmp/shots-0624-1000`（1000×900）
  - `/tmp/shots-0624-narrow`（`--viewport narrow`，880×900）

## 四、已知边界（逐条如实登记）

- **1180 整点不是严格三栏**：视口 **恰好 1180** 时右栏仍按既有 `max-width:1180px` 规则
  **不推开正文**（覆盖式），严格三栏需要 **>1180**；这条既有规则本版**未改**。
- **<900 的左栏是覆盖式抽屉**，不是推挤式：默认收起，由窄条 `☰`（`#sideNavRailBtn`）打开，
  打开时覆盖在主区之上（带阴影），不改变正文宽度。
- **顶栏重复入口本轮未删**：工作空间 `#wsSel` 与左栏 `#sideNavWs`、新对话 `#newChat` 与左栏
  `+ 新建对话` 现在是**两份入口指向同一逻辑**；这是「只增不删」的刻意取舍，下一轮再逐个迁出，
  本版**没有**删除或移动任何顶栏控件。
- **REPL 无 `/permission` 命令**（当前不存在）：REPL 里显式改权限仍只能靠 `/preset`
  （记 `preset`），因此本版**不会**在 REPL 路径产生 `explicit`；`explicit` 仍只由 WebUI 权限档写入。
- **未改 `src/agent.js` 的 permission 取值顺序**（`cfg.permission ?? permission.mode`）：
  worker 是通过传入「已降级的生效值」修正自己的账本，其它入口的既有口径不变。
- 左栏工作空间是**镜像控件**而非移动：顶栏 `#wsSel` 仍是唯一真实状态源，左栏只回写并派发
  `change`；两边选项在极端时序下以顶栏下一次刷新为准。
- 左栏会话列表**只在 `refreshSessions()` 时刷新**（与既有下拉同一数据源），没有新增轮询；
  会话很多时列表只是一次性渲染，未做虚拟滚动。
- 本版未改 `src/providers/**`、`src/session.js`、`presets/**`、`desktop/**`（版本号除外）、
  `ide/**`、`scripts/ui-shot.mjs`。

## 五、升级须知

1. 从 v0.6.23 升级是**增量**：左栏是新出现的第四段，宽屏默认展开（240px），
   900–1180 自动折叠成 48px 图标列，<900 需点窄条 `☰` 打开抽屉。
2. 折叠偏好存在浏览器 `localStorage['mingdao-sidenav-collapsed']`（不写 `config.json`），
   换浏览器/清缓存后回到默认展开。
3. 顶栏所有入口位置未变——如果你习惯顶栏操作，升级后不用改习惯；左栏只是多一个入口。
4. 旧账本不受影响：`permissionSource` 是**只增字段**，旧账本 `verify` 仍通过。
5. 本版不删除任何历史产物；需要回退可继续安装 v0.6.23 / v0.6.22。
