# 更新日志（Changelog）

本项目自 v0.1.69 起维护变更日志；此前版本（0.1.0–0.1.68）的演进见 docs/QA-REPORT.md 与 git 历史。


## v0.6.22（2026-10-21）— 会话分组/消息时间戳 + CI 断言确定性

> 本版两件事：① **会话分组 + 消息时间戳**（§3.84）——按「只增字段、不新增面板、不改布局」
> 的小步做法，把会话列表按本地时间分「今天/昨天/本周/更早」，并给 Web 新落盘的消息加 `ts`；
> ② **CI 不可判定断言**（§3.85）——v0.6.21 发布时 Windows 首跑红、`rerun` 才绿的
> BUG-068 并发 merge 写断言，改成「等全部写入提交后再断言终态」，判提交而不判中间态。
> 细节见 `docs/internal/AUDIT-v0.6.1-第三方报告登记.md` **§3.84 / §3.85**。

### 一、§3.84 会话列表按 updatedAt 分组 + 消息时间戳

**后端（只增字段，既有字段语义不变）**

- `GET /api/sessions` 每项在既有 `file` / `mtime` / `label` 之外**只增**三个字段：
  `updatedAt`（文件 mtime 的 ISO 字符串）、`messageCount`（JSONL 里合法 `role` 的行数，坏行跳过）、
  `title`（复用既有文件名标题：自动标题 / 手工重命名都落在文件名上）。
- `GET /api/session?file=` 每条消息**只增** `ts`：旧会话没有 `ts` → **`null`**；
  `role` / `content` 等既有字段的值与语义不变；**不用文件 mtime 冒充消息时间**。
- **半截 JSONL 跳坏行不 500**：末尾未写完的行、损坏的行只跳过，不影响其余消息。
- 新消息在 **Web 服务端落盘时**写 ISO `ts`（`stampMessageTs()`：只为缺 ts 的新增消息补，
  已有 ts 原样保留；压缩重写不冲掉历史时间）。未改 `src/session.js`、`src/agent.js`。

**前端（只加展示，不动布局）**

- `groupSessionsByUpdatedAt()` / `sessionGroupKey()` 纯函数：按**本地 00:00 边界**分
  「今天 / 昨天 / 本周（本地周一 00:00 起）/ 更早」，「现在」可注入（测试固定 now，不跨午夜抖动）；
  旧接口的 `mtime`（毫秒）也能分组。
- 落点：既有顶栏「历史会话」下拉用原生 `<optgroup label="今天|昨天|本周|更早">`；既有
  「会话管理」弹层 `#sessList` 用 `.sess-group` 小号次要文本（`--dim`）显示同样四组。
- **分组只算一次**：只在 `refreshSessions()` 里算并缓存，渲染不重算，**没有新增 `setInterval`**。
- 消息显示小号时间：同日 `14:32`、跨天 `10-19 14:32`；`ts` 缺失/非法返回空串，
  `addUser` / `newAiMsg` **不建时间节点**——不出现 `Invalid Date` / `undefined`。

**测试与变异**

- 新增 `test/ui-sessions.js`（5 组）：分组边界（固定 now）/ API 三字段 + 旧会话（无 ts、
  半截 JSONL）不报错 / 真实 `addUser`·`newAiMsg` 源码渲染（有 ts 显示、无 ts 不显示）/
  标题文案与顺序 / 分组只算一次 + 无 `setInterval`。已接入 `test/run-all.mjs` 与 CI（**仅 Linux 腿**）。
- 新增 `test/mutate/batch46-sessions.mjs`：**12/12 全中**。变异总数 **376 → 388**
  （34 批 / 388 条，`test/mutate/README.md` 计数行已改，`doc-lint` 通过）。

### 二、§3.85 CI 不可判定断言：BUG-068 并发 merge 写改成「判提交」

**现象**：v0.6.21 发布时 CI 第 1 次尝试只有 **windows 腿**红在 `test/smoke.js` 的 BUG-068
并发 merge 写检查点（终态 6/8），`rerun-failed-jobs` 后第 2 次五腿全绿，产品代码未改；
历史同类红还有 7/8、6/8 各一次，其余四腿同期全绿。

**根因（时序）**：不是「父进程读早了」——子进程走同步合并写（`writeFileSync(tmp)` +
`renameSync`，都在 `exit` 之前返回）。不可判定的是**失败被抹平**：旧写法把子进程
`saveTaskStateMerge()` 的返回值丢进 `stdio: 'ignore'`，只用「进程退了没有」当完成信号；
而这一步在 Windows 上偶发返回 `{ ok: false }`（最可能是 `s1.json.lock` 处于 NTFS
delete-pending 时 `openSync(…, 'wx')` 被拒 EACCES/EPERM，或杀软扫描刚写的 `.tmp` 时
`rename` 被拒），子进程**照常 exit 0**，父进程只看到条数少 1–2。

**改成什么（三条都不看时序）**：

1. **发令栅栏**：8 个子进程先 `READY` 报到，父进程收齐 8 个才 `stdin.end('go\n')`——
   8 个写**必然重叠**；没报到就退出的立刻带 stderr 报错，而不是静默少一条。
2. **判提交，不判退出**：子进程把 `{ ok, error, seen, hasOwn }` 从 stdout 交回，父进程等
   `'close'`（管道读空）后逐条核对；任何一次合并 `ok !== true` 就用它自己的 OS 错误文案失败。
3. **终态集合判等**：`artifacts` 排序后必须**恰好等于** 8 个预期标记（不再是 `length === 8`），
   且每个子进程自报「提交后自己的标记仍在」——锁内合并不得丢**已提交**项。

**没有做的事**：没有放宽成 `≥6`、没有加重试、没有改 `src/**`（含 `src/atomic-write.js`）。
Windows 上「锁获取遇到 EACCES/EPERM 应算争用而不是失败」是产品侧硬化项，按约束未动；
若那条腿再红，新断言会把 errno 原文打进 CI 注解，可据此立项，不再靠 rerun 猜。

### 三、验证

- `npm run typecheck` → 0；`npm run typecheck:strict` → 0 / 基线 0
- `node test/smoke.js` 单独连跑 **2 次** → 均全通过（§3.85：不再出现 6/8 / 7/8；开发期另跑过 3 次）
- `e2e-local` 17 项 / `e2e-web` 24 项 / `e2e-schedule` 11 项 / `api-contracts` 8 项 → 全通过
- `pack-ctx-privesc` / `ledger-source` / `model-names` / `memory-recovery` / `ui-sessions` → 全通过
- `mutate/selfcheck` 通过；`npm run bench` 5 套基准 0 失败
- `node test/mutate/run.mjs` → **34/34 批、388/388 条全中、0 逃逸**
- `doc-lint` 通过（变异总数 388）；`diagnose` 报告正常、密钥脱敏

### 四、已知边界

- **当前没有左栏**：v0.6.19 的三栏骨架已在 v0.6.20 整体回滚（§3.79），本版未重排 `.app`，
  分组只落在**既有**的「历史会话」下拉与**既有**的「会话管理」列表，没有新建面板/左栏。
- **CLI / REPL / 调度写入的消息暂无 `ts`**：本版只有 **Web 服务端落盘**会写 `ts`，
  `src/session.js` 未动。因此**旧会话**与**非 Web 会话**接口返回 `ts: null`、前端**不显示时间**
  ——这是「缺失不建节点」的正确行为。要覆盖所有入口需在 `src/session.js` 的 `appendMessages`
  统一补 ts（不在本版改动面）。
- `updatedAt` 取会话文件 mtime（ISO），不是「最后一条消息的 ts」；手工 `touch` 会改变分组。
  分组按本地时区计算，「本周」从本地周一 00:00 起算。
- 组标题不可点击、不可折叠（原生 `<optgroup>` 行为）；`messageCount` 只计合法 `role` 的行。
- 本版未改 `src/providers/**`、`src/agent.js`、`src/session.js`、`presets/**`、`desktop/**`
  （除版本号）、`ide/**`；未改 `.app` 网格、顶栏、右栏、`#sessSheet`、主题变量或字号阶。

## v0.6.21（2026-10-19）— 界面重排（三步走，每步截图验证）

> v0.6.19 的界面重排在真机翻车、v0.6.20 已逐字节回滚到 v0.6.18。本版按「小步、每步先出
> Electron 截图、经负责人过目」重新上线界面重排：① 顶栏补当前会话面包屑、会话设置补预设
> 来源；② 右栏改成轨迹/子Agent/任务/仪表盘四标签页；③ 只做视觉细节（对比度、1000px 顶栏、
> seg 标签、会话设置间距）。**所有既有入口保留**，右栏面板节点原样搬迁、id 保留、handler
> 未重写。细节与截图见 `docs/internal/AUDIT-v0.6.1-第三方报告登记.md` **§3.81 / §3.82 / §3.83**。

### 一、三步改动（每步独立提交，先截图后进入下一步）

**步骤 1（§3.81）顶栏 crumb + 会话设置预设来源 + 截图工具 `--open`**

- 顶栏 logo 后新增 `#crumbWs › #crumbSession`（工作空间 › 当前会话），复用 `.badge`，
  不新增 CSS 骨架；`renderCrumb()` 只读 `currentWorkspaceName` / `sessionsCache` /
  `currentSession`，不新增后端字段，在 `refreshSessions()` / `refreshWsSel()` /
  `loadSession()` / 新对话后刷新。
- **既有入口全部保留**：工作空间 / 历史会话 / 会话管理 / 任务 / 新对话 / 主题 / 费用一个未删。
  模型 / 预设 / 权限本来就在 `#sessSheet`（v0.6.18 起），本步未搬 DOM、未重写 change handler。
- `#sessSheet` 新增 `#ssPresetSrc`：显示「当前：… · 来源：你的选择 · 仅下一轮」。
- `scripts/ui-shot.mjs` 新增 `--open <css-selector>`（`#sessSheet` 退回点击
  `#sessSettingsBtn`）与每次运行额外输出 `sheet.png`，并校验弹层三个选择器可见。
- `smoke §153` + `batch43-header-sheet`（10 条）钉住「入口不回归 / 弹层可开 / `--open` 有效」。

**步骤 2（§3.82）右栏四个标签页：轨迹 / 子Agent / 任务 / 仪表盘**

- `#runPanel` 内：`rp-head` → `rp-top`（会话配置 + 本轮六项）→ `rp-tabs`（`#tabTrace` /
  `#tabSub` / `#tabTasks` / `#tabDash`，均 `role="tabpanel"`）→ `rp-foot`；默认轨迹。
- **`#trajPanel` / `#subPanel` / `#tasksPanel` / `#dashPanel` 节点原样搬迁、id 保留、
  handler 未重写**：`#tjList` / `#sbList` / `#tpList` / `#kpiToday` / `#trendChart` 等子节点
  全在，`updateTasksPanel()` / `renderDashboard()` / `openTraj()` / `renderSubPanel()` 的
  数据逻辑与调用点未改。
- 新增 `railTabDisplay(tab)` 纯函数与 `setRailTab(tab)`：只改 `display` / `.on` /
  `aria-selected`，不重建节点；未知标签回退轨迹。`syncPanelLayout()` 不再用
  `traj-open/sub-open/tasks-open/dash-open` 推正文。
- 顶栏「任务」、费用徽标、左栏 🧭 / 🤖 改为 `activateRailTab()` = 切标签 + 开右栏；关闭仍用
  「收起」/ ✕。窄屏仍是顶栏「运行」抽屉，内容同一套标签。
- `smoke §154` + `batch44-run-tabs`（10 条）。

**步骤 3（§3.83）视觉细节四条**

- **对比度**：28 个承载信息的选择器 `color:var(--faint)` → `var(--dim)`（时间戳、来源、计数、
  说明等）；`--faint` / `--dim` token 本身未改。暗色：bg 4.92→8.54、bg2 4.64→8.06、
  panel 3.76→6.53、bg3 3.26→5.67；亮色最小 4.21→6.73，修后均达 WCAG AA。
- **顶栏 1000px 裁切修复**：新增 `header .hdr-right`（`display:flex;flex:1 1 auto;
  min-width:0;overflow-x:auto`、4px 滚动条），费用 / 搜索 / 历史会话 / 任务 / ✎ / 新对话
  收进容器；`#wsSel` 130→110px、`#crumb` 180→120px；新增 `@media (max-width:1100px)`
  收窄间距并隐藏 `#envBadge`。实测 `#sessions` 从视口外 **1055–1153px** 变为视口内
  **886–984px**。
- **右栏标签 `.seg` 化**：`.rp-tabs` 外框 bg3 + 3px padding + 9px 圆角；内按钮 26px / 透明底 /
  6px 圆角；选中 panel 底 + text 字 + 600。只加类与 CSS，`app.js` 未改。
- **会话设置弹层间距圆角**：宽 410→400，head/body padding 10/12→11/13，field 标题下间距
  4→5，effective 外边距 12/8→13/11，foot 8/12→9/13。
- `smoke §155` + `batch45-visual`（14 条）。

### 二、v0.6.19 的翻车与处置

- v0.6.19 一次性合入约 3,000 行前端改动（设计稿 CSS 整段追加、三栏骨架与旧样式叠加、面板
  默认态统一接管），真机表现为界面凌乱、菜单/设置消失、按钮失灵、主按钮亮色硬编码，而
  `smoke` 字符串断言与桩 DOM 测试**全绿**。
- v0.6.20 处置：`src/web/index.html` / `src/web/app.js` 逐字节回滚到 v0.6.18，并移除断言被
  回滚骨架的 `smoke §153`、`test/ui-p2.js`、`batch43-ui-shell`、`batch42-ui-p2`。
- 同时新增 `scripts/ui-shot.mjs`（真实 Electron `capturePage()`），并在 `docs/DEVELOPER.md §六`
  立下硬纪律：**UI 改动必须先截图、经负责人过目再提交**；字符串断言不能当界面可用的证据。
  本版三步每一步都先出 wide / 1000px 截图再进入下一步。

### 三、变异与测试

- 新增 `batch43-header-sheet`（10）、`batch44-run-tabs`（10）、`batch45-visual`（14），
  变异总数 **362 → 376**（共 **33 批 / 376 条**，全中，0 逃逸）。
- `smoke` 重新启用 §153（回滚时删除的节号），并新增 §154 / §155。

### 四、已知边界（如实登记）

- 设计稿里**未做**：会话分组 / 副标题、轮次时间戳 / 权限 chip、折叠动画、toast、
  **980px 图标化侧栏**（现为 **<880px 抽屉**）、「更多 ▾」下拉。
- **1000px 下「任务 / ✎ / 新对话」仍需横向滚动**才能触达（历史会话已在视口内），本步只修
  任务书点名的裁切，未搬下拉菜单。
- `--faint → --dim` **只改承载信息的用法**（28 个选择器）；纯装饰文字仍保留 `--faint`。
- **动态运行文案仍中文**：运行阶段 / 任务状态等文案未接 i18n；`src/web/i18n.js` 仍未被引用。
- `#envBadge` 在 ≤1100px 隐藏；`#wsSel` / `#crumb` 限宽只影响视觉宽度（完整名称在 `title`）。
- 未改 `.app` 网格、顶栏高度、`#runPanel` 宽度、`body.run-open` 推开量、主题变量、字号阶；
  未引设计稿样式表。

## v0.6.20（2026-10-19）— 紧急回滚界面重排，恢复 v0.6.18 可用 UI

> **紧急 hotfix**：v0.6.19 的界面骨架重排（§3.78）在真机翻车——界面凌乱、菜单/设置消失、
> 按钮失灵。按既定决策把 `src/web/index.html` / `src/web/app.js` **逐字节回滚到 v0.6.18**
> （`git diff v0.6.18 -- src/web/index.html src/web/app.js` 为空），这是唯一可靠的恢复手段；
> 与 UI 无关的改进全部保留。移除断言被回滚骨架/交互的 `§153`、`test/ui-p2.js`、
> `batch43-ui-shell`，以及只跑 ui-p2、锚点已不存在的 `batch42-ui-p2`；变异 **369 → 342 条
> （32 → 30 批）**。真机现象、根因（约 3,000 行前端改动 + 无视觉验证 + 设计稿 CSS 整段覆盖）
> 与重新上线前置条件见 `docs/internal/AUDIT-v0.6.1-第三方报告登记.md` **§3.79**。

### 一、回滚（§3.79）

- `git checkout v0.6.18 -- src/web/index.html src/web/app.js`：顶栏 / 侧栏 / 右栏 / 底部
  回到 v0.6.18 的已知可用结构；`diff` 为空（逐字节恢复）。
- 随回滚下线：§3.78 三栏骨架与右栏四标签页、§3.77 设置三列 / 六类危险操作二次确认 /
  dialog 无障碍 / 语言选择（`src/web/i18n.js` 文件保留但**不再被引用**）。
- v0.6.19 的「id 与 handler 保留」没有救回现场：id 在、节点搬家后默认态与 CSS 级联变了，
  字符串断言全绿而真机整页不可用——这条教训写进 §3.79。

### 二、移除失效的 UI 断言与批次

- `test/smoke.js`：删除 **§153**（界面骨架整节，含设计稿 CSS 逐值/对比度断言）。
- 删除 `test/ui-p2.js`（P2 只测回滚后的 `app.js`，已不可测），并从 `test/run-all.mjs` 与
  `.github/workflows/ci.yml` 移除注册。
- 删除 `test/mutate/batch43-ui-shell.mjs`（12 条，锚定新骨架）。
- 连带删除 `test/mutate/batch42-ui-p2.mjs`（15 条）：每条都锚定回滚后**已不存在**的 P2 代码、
  且只跑 `test/ui-p2.js`，保留必然「变异点未找到」。
- `test/mutate/README.md` 计数按 `node scripts/doc-lint.mjs` 实测：**342**。

### 三、保留（与 UI 无关）

- `src/web/i18n.js`：**暂不引用**，作为后续重建的资产保留（zh/en 同键，零依赖）。
- `src/web/server.js` 的 `/api/state.defaults`：**纯新增只读字段**，不参与判定、不写盘，
  向后兼容；前端当前不消费它。
- 端口治理（`listen(0)` 运行时端口 + `doc-lint ⑨` 守卫）、本地引擎内存不足自动恢复（§3.74）、
  变异跨 worktree 全局锁（§3.75）、调度熔断测试进程内确定性驱动等，一行未动。

### 四、重新上线的前置条件（硬要求）

- **必须用 Electron 截图验证再上线**：真实 Electron 窗口，覆盖 **≥1280 / 1000 / 880** 三档宽度、
  暗/亮两主题，逐页打开顶栏/侧栏/右栏四标签/会话设置/危险确认/空态，截图随 PR 与发布说明存档；
  截图不通过不得发布。
- **字符串断言不能代替渲染验证**：`smoke` 是回归底线，不是 UI 可用的证据。
- 重建时不要整段覆盖设计稿 CSS：`header` 只留一处基准定义、主按钮只用主题令牌、
  面板默认态由单一函数决定，初始化失败要回退到可用布局而不是「全部隐藏」。

### 五、新增 Electron 截图工具（§3.80）

- 新增 `scripts/ui-shot.mjs`：起真实 `src/cli.js web`（临时 `MINGDAO_HOME` + token），用真实
  Electron 加载页面并 `capturePage()` 输出 `home/settings/palette/session` 四张 PNG；支持
  `--viewport wide|mid|narrow`（1440/1000/880）、`--theme dark|light`、`--mobile`、`--out`，
  服务/参数/Electron/页面报错/截图失败分别以非 0 退出。
- `docs/DEVELOPER.md` 新增 §六：**UI 改动必须先用 `node scripts/ui-shot.mjs` 截图自查**，
  至少覆盖三档宽度与暗/亮两主题，截图不对不提交。
- 本版起 UI 改动必须先跑 `node scripts/ui-shot.mjs` 截图自查（工具见 `docs/DEVELOPER.md §六`）。

### 六、验证

- `npm run typecheck` 0；`node test/smoke.js`（单独跑）**156 组断言全通过**；
  `e2e-local` 17 项 / `e2e-web` 24 项 / `e2e-schedule` 11 项 / `api-contracts` 8 项全部通过。
- `node test/mutate/run.mjs --allow-dirty`：**30/30 批、342/342 条全中、0 逃逸**
  （跑前 `pgrep -f "test/mutate"` 为空，全局锁正常获取/释放）。
- `node scripts/doc-lint.mjs` 全通过（⑥ 实际 342 = README 342；⑨ 固定端口 0 处）。
- 回滚提交与发布提交分离：发布提交只含 CHANGELOG / RELEASE-NOTES / `package.json` /
  `package-lock.json` / `desktop/package.json` 五个文件；`git diff --name-only <门禁SHA>..<tagSHA>
  -- src test` 为空。

## v0.6.19（2026-10-18）— 界面骨架照设计稿重排 + UI P2 收口 + 测试端口全部动态化

> 补丁版，三件事：① **界面骨架照设计稿重排**（§3.78）——三栏 `.app`（264 / 1fr / 300、48px 顶栏），
> 顶栏只留 brand / 面包屑 / 草稿徽标 / `⌘K` / 设置；侧栏会话 / 工作空间 / 新对话 / 搜索；底部
> `#runStrip` 六项 + `#composer` + `#statusBar`；右栏 `#runPanel` 四标签页（轨迹 / 子Agent / 任务 /
> 仪表盘），**原 5 个并列面板全部搬进右栏且 id 与 handler 保留**；设计稿布局/组件 CSS 原样搬运
> （约 760 行，只做颜色变量映射 + 9 个新增变量照抄）；`--faint → --dim` 61 条规则（对比度
> 3.26/3.76 → 5.67/6.53）；`§153` **从设计稿解析 59 个选择器**逐条比对。② **UI P2**（§3.77）——
> 设置项三列（默认 / 当前 / 影响，默认值由 `/api/state.defaults` 透出）、六类危险操作二次确认
> （初始焦点在取消、回车不确认、Esc 取消）、无障碍（`role=dialog` / `aria-modal` / 焦点陷阱 /
> Esc 回焦 / `aria-live` 节流 / 图标 `aria-label`）、i18n（`src/web/i18n.js`，zh/en **109 键同键**，
> 缺失回退 zh）。③ **固定端口治理**（§3.76）——测试中 **8 个写死监听端口全部改 `listen(0)`**
> 运行时端口（含 §145 两次 `listen(0)` 且断言端口不同）、`e2e-web` 的 `40000+random` 改
> `freePort()`；`doc-lint ⑨` 守卫拦 `listen(4xxxx/5xxxx)` 字面量。变异验证 **32 批 369 条全中**
> （原 357 + batch42 的 15 + batch43 的 12；计数由 `scripts/doc-lint.mjs` ⑥ 守卫）。

### 一、界面骨架照设计稿重排（§3.78）

**骨架**：`.app` = `264px minmax(0,1fr) 300px`、行 `48px minmax(0,1fr) auto`、areas
`"top top top" / "side main run" / "side foot run"`，与设计稿逐字一致。顶栏只留
**brand / 面包屑（`#crumbWs › #crumbSession`）/ 草稿徽标 / `⌘K` / 设置**；`#modelSel`、`#presetSel`、
`#permSel` 只在**会话设置弹层** `#sessSheet` 里；工作空间、搜索、会话列表、新对话、环境徽标、
成本徽标、会话管理、主题切换移入侧栏。**底部合并成一条区**：`#runStrip`（六项 `data-k` + 上下文
`.bar#rsCtxBar` + 停止）+ `#composer`（附件 / 输入 / 当前值胶囊 / 发送）+ `#hint` + `#statusBar`。

**右栏四标签页**：`.runpanel` 头部（运行状态 + 本轮 + 收起）→ 会话配置 `.kv` → 本轮数据
`.metrics`（六项 `data-rk`）→ `#rpTabs .seg` 四页；原 `#trajPanel` / `#subPanel` / `#tasksPanel` /
`#dashPanel` 全部搬入且 **id 保留**，`#trajRailBtn` / `#subRailBtn` / `#subBadge` / `#tasksBtn` 变成
标签按钮/徽章；handler（`openTraj()` / `renderSubPanel()` / `updateTasksPanel()` /
`renderDashboard()`）**未重写**，显隐统一由 `railPanelDisplay()` + `syncPanelLayout()` 控制
（同一时刻只显示一页）。

**CSS 原样搬运**：设计稿 `<style>` 的布局/组件规则体约 **760 行**直接进 `src/web/index.html`
（新增 §3.78 样式块），只做颜色令牌映射（14 个）；设计稿有、既有变量没有的 **9 个新增变量照抄数值**
（`--line-strong`、`--ok`、`--tint-warn/err/ok`、`--sh-panel/overlay`、`--scroll/hover`、`--on-accent`、
`--btn-primary-*`）。class 名与设计稿一致。

**可访问性对比度**：承载信息的次要文本 `--faint → --dim` 共 **61 条规则 + 2 处行内 style**，
`--panel` 上 3.76:1 → 6.53:1、`--bg3` 上 3.26:1 → 5.67:1；纯装饰（分隔符/三角/禁用占位）仍用
`--faint`，令牌原值未动。设计稿的 `--t3` 用法是**唯一有意偏离**，已在 CSS 就地注明。

**断点**：≥1180 三栏；900–1180 右栏为覆盖式抽屉（`body.run-drawer`）；<900 侧栏为抽屉
（`body.side-drawer`，顶栏 `#sideToggle`），Esc 分层关闭（先侧栏再右栏）；宽屏收起右栏时
`body.rail-collapsed` 把第 3 列归零。

**断言**：`test/smoke.js` 新增 **§153**（①顶栏不含模型/预设/权限等 10 个控件；②右栏四标签 +
原面板 id + `railPanelDisplay` 行为 + handler 仍查原 id；③侧栏五件套 + `renderSessionNav` 复用
`sessionsCache`；④底部 composer 胶囊 + 状态条六项；⑤1280/1000/880 断点类名；⑥**从设计稿解析**
颜色映射/新增变量/字号间距圆角/**59 个选择器**逐声明比对；⑦对比度现算 ≥4.5:1）。新建
`batch43-ui-shell.mjs`：**12/12 全中**。

### 二、UI P2：设置三列 / 危险操作二次确认 / 无障碍 / i18n（§3.77）

- **设置三列**：每个可改项在控件下渲染 `默认 / 当前 / 影响`（`.cfg-cols[data-cols]`）。默认值来自
  `src/config.js` 内置默认表，经 `GET /api/state` 新增的**只读** `defaults` 透出（不参与判定、
  不写盘），前端有同值兜底 `SETTING_DEFAULTS_FALLBACK`；影响文案在 `SETTING_IMPACT`，英文在
  `i18n.js` 的 `impact.*`。
- **六类危险操作**：删除工作空间 / 删除会话 / 清空记忆 / 恢复默认配置 / 切 `permission=auto` /
  关闭沙箱，统一走 `runDanger()`（**先 await confirm，取消直接返回、绝不 execute**）；`#dangerDialog`
  说明后果，初始焦点在「取消」，**回车不确认**，Esc 取消，确认按钮 `type=button`。
- **无障碍**：`installDialog()` 统一 `role=dialog` + `aria-modal` + `aria-label`、Tab/Shift+Tab
  焦点陷阱、Esc 关闭、关闭后焦点归还触发元素（⌘K / 会话设置 / 危险确认三个弹层已接入）；
  状态条/轨迹/子Agent 行 `aria-live="polite"`，另有节流的 `#a11yLive`；图标按钮补 `aria-label`。
- **i18n**：`src/web/i18n.js` 零依赖，zh/en **109 键同键**；默认跟随 `navigator.language`，
  `localStorage['mingdao-lang']` 可覆盖，设置 › 外观可选语言；缺失回退 zh，zh 也没有返回空串。
  只抽静态 UI 文案，不翻译日志/错误原文。
- **断言**：`test/ui-p2.js` 6 项（三列数据源/影响非空、六类危险操作取消不执行/确认才执行、
  dialog 语义与焦点陷阱/回焦/aria-live/对比度、i18n 同键与回退、语言持久化、`defaults` 同口径）；
  `batch42-ui-p2.mjs` **15/15 全中**。

### 三、测试固定端口 → `listen(0)` 运行时端口（§3.76）

全仓 `test/**` 扫描出 **8 个写死的监听端口值、20 处代码引用**：`smoke.js` §34 / §116 / §123 /
§144 / §145（两个实例）/ §146 / §148，`api-contracts.js` 启动端口，`e2e-web.js` 的
`40000 + random * 20000`。全部改为 `port: 0` 后取 `srv.address().port`；`e2e-web` 复用既有
`freePort()` 并从子进程就绪日志解析实际端口；§145 两次 `listen(0)` 并断言
`base145b !== base145a`（语义是"两个不同端口"，不是两个特定数字）。未改任何断言语义。

**结构守卫**：`scripts/doc-lint.mjs` 新增 ⑨——扫描 `test/**/*.js|*.mjs`（排除
`test/mutate/.generated/`），先抹块注释再按行剔行注释（`://` 不误伤），命中
`/\blisten\(\s*([45]\d{4})\b/` 即失败；`listen(0)`、`listen(port)`、`freePort()` 均不误报。

**验证**：smoke 连跑多次 **0 `EADDRINUSE`**；`e2e-local` 17 / `e2e-web` 24 / `e2e-schedule` 11 /
`api-contracts` 8 全部通过；全量变异 **32 批 / 369 条全中、0 逃逸**。

## v0.6.18（2026-10-18）— 本地内存不足自动降级一次 + 轨迹收纳 + 变异跨 worktree 互斥

> 补丁版，四件事：① **本地引擎内存/显存不足自动恢复**——`isMemoryPressureError()` 单一判据
> （507 / `insufficient memory` / `memory_refusal` / `allocator wall` / `shed-caches` / OOM 词边界），
> **仅本地端点**压缩上下文（×0.6，下限 4k）+ 输出 ×0.5 + 强制并发 1，**只重试一次**；二次失败把
> 具体数值与建议一并抛出（§3.74）；② **轨迹/子 Agent 收纳**——宽屏进右栏「轨迹」「子Agent」
> 可折叠区，<1180px 落到对话流末尾 `#traceDock`，对话流每轮只留一行摘要（§3.73）；③ **变异跨
> worktree 互斥**——全局锁 `os.tmpdir()/mingdao-mutate.lock/`，陈旧判据「pid 不在 **且**
> mtime>15min」双条件，接管用 `.takeover` 令牌 + rename（§3.75）；④ **更新未验证来源签名提示
> 精简为两行**（§3.72）。变异验证 **30 批 342 条全中**（原 323 + batch40 的 11 + batch41 的 8；
> 计数由 `scripts/doc-lint.mjs` ⑥ 守卫）。

### 一、本地引擎内存不足自动恢复（§3.74）

**判据单一**：`src/providers/openai-compatible.js` 的 `isMemoryPressureError()` 认 HTTP **507**、
`insufficient memory`、`memory_refusal`、`allocator wall`、
`engine shed its caches and stays up`、OOM（**词边界**，`room` / `zoom` 不误判）；
**不含** 400/401/429 与普通 5xx。`describeUpstreamError()` 新增 `recoverableByShrinking`，
**只对本地端点**为真（`isLocalBaseUrl` 或 `customModels.<名>.local`）；provider 的瞬态重试对内存
错误直接放行，避免 500+`insufficient memory` 被白重发两次。

**一次有界降级**（`src/agent.js`，`MAX_MEMORY_RETRIES = 1`）：命中后本回合 `contextBudget × 0.6`
（**下限 4096**——压到连系统提示都放不下就永远失败）、`maxOutputTokens × 0.5`，重试请求带
`localConcurrency: 1`（provider 复用既有 `acquireLocalSlot` 把并发压回 1）；第二次仍失败即如实
抛错，**不无限重试**。降级不额外消耗 `maxSteps` 的一步（否则 `maxSteps=1` 时根本没机会重试）。

**不掩盖**：界面/日志打 `♻ 因本地引擎内存不足，已压缩上下文（32,768 → ~19,660）…并重试一次
（串行化：并发上限 1）`；失败路径的文案带压缩前后数值、输出上限、`config.contextBudget` 建议值与
`--ctx-size` / q8 KV 建议；`done.note` 追加压缩前后数值与重试结果，`src/web/server.js` 把同一份
说明写进 `web-server.log`。

**自适应 clamp**：新增纯函数 `clampContextBudgetToEngine()`；预检读到引擎 `n_ctx` 且预算 >
`n_ctx × 0.8` 时，**发请求前**（创建 agent 时）clamp 并提示；没读到 `n_ctx` 时不猜、不 clamp。

**云端不变**：云 API 的 507 仍走既有路径（不重试），400/401/429 行为不变——上下文压缩改不了
远端容量，重试只会多烧一次请求。

**断言**：新套件 `test/memory-recovery.js`（5 项）接 `test/run-all.mjs` 与 CI（仅 Linux 腿），
桩引擎逐条覆盖：降级后成功 / 两次失败 / 云端 507 / clamp 与 0.8 比例 / 4xx 不变；
新建 `batch40-memory-recovery.mjs`（11 条变异）逐条抓回退。

### 二、轨迹与子 Agent 收纳（§3.73）

**对话流只留一行**：每轮正文末尾一行 `🧭 本轮 12 次工具调用 · 3 个子代理 · 1m42s ›`（复用既有
`.trace-row`，失败轮加 `has-fail`），不再把工具卡与子代理内联堆在正文之间；无工具且无子代理时
整行隐藏。

**宽屏进右栏**：`≥1180` 时「轨迹」「子Agent」两块在右栏，均可折叠；子代理行显示名称 · 轮次 ·
工具次数 · 最后进展 · 状态（运行中/完成/失败），运行中由既有 `progress.subagent` 快照实时更新，
**不新增轮询**。

**窄屏落末尾**：`<1180` 且右栏收起时，两块移到对话流末尾 `#traceDock`（`traceDockVisible()` 判定，
与 `layoutClassesFor()` 同一断点）；点摘要按钮定位该轮：窄屏滚到 dock、宽屏/抽屉已开则定位右栏。

**同一函数 / 同一数据源**：摘要与右栏都走 `traceRoundForMsg()` → `traceRoundView()`，只读
`msg._traj` 与会话子代理列表，不读 `runState`、不另算一套（§151 断言两处都调用同一函数）。

### 三、变异跨 worktree 互斥（§3.75）

**全局锁**：从「各 worktree 一把 `<worktree>/.generated/mutate.lock`」改为
`os.tmpdir()/mingdao-mutate.lock/`；`mkdirSync` 原子创建，锁内 `owner.json` 记
`pid` / `startedAt` / `cwd`（被变异的 worktree 根）/ `argv` / `host`。同 pid 重复获取幂等
（引用计数归零才真正释放）；批次子进程经 `MINGDAO_MUTATE_LOCK` 继承父进程的锁。

**严格两条件陈旧判据**：① 锁里的 pid 已不在；② 锁目录 mtime 已超过 **15 分钟**。两条**同时**
满足才判陈旧；只有 ① 时明确拒绝（"锁很新但 pid 已死"→ 不接管）；owner 还读不到（刚 `mkdir`、
尚未落盘）同样拒绝。接管不裸删：先拿 `.takeover` 令牌串行化，再把锁目录整体 `rename` 成唯一
tombstone 后重建。释放覆盖正常/异常/`SIGINT`/`SIGTERM`；`SIGKILL` 留给陈旧判据或
`check.mjs` 显式自愈兜底。

**错误信息**统一含 pid / cwd / 已运行秒数 / 锁目录，并给出手工解锁入口。
`selfcheck` **14/14**（原 8 + 新增 6，含今天踩的坑的回归：活锁但 mtime 很新、pid 已死 → 不接管；
两个 worktree 同时跑只有一个进入）；全量 **30/30 批次、342/342 条**。

### 四、更新提示精简为两行（§3.72）

桌面版 `warn-and-install`（无签名 + 默认档）的更新就绪弹窗正文由五句缩成两行：
`本次更新未验证来源签名（发布链路尚未接入签名）——已按默认策略安装。` /
`高安全场景可设 MINGDAO_REQUIRE_UPDATE_SIGNATURE=1 拒绝无签名更新；详情见日志与官网。`
标题与主句不变，`allowInstall` 仍为 `true`，**判据一行未动**；弹窗短了，日志反而更详细
（`logLine` 追加「完整说明」：为何放行、投毒不可区分、官网与 `docs/CODE-SIGNING.md §五`）。
`smoke` §135 补断言：用户可见文案 `title+message+detail` **≤220 字符**、正文 ≤2 行、四类关键串
必须在、日志行仍含完整说明。仍**每次更新提示一次**（没有"不再提示"配置）。

### 五、测试与文档

- 新增 `test/memory-recovery.js`（5 项）并接入 `test/run-all.mjs` 与 CI（仅 Linux 腿）。
- 新增 `batch40-memory-recovery.mjs`（11 条）、`batch41-ui-trace.mjs`（8 条）；`batch31 ①` 的
  `acquireLocalSlot` 锚点跟随新增的 `localConcurrency` 传参更新；`src/web/server.js` 的
  `note: [baseNote, zeroNote]…` 行保持原形，`batch33 ⑧` 无需改动。
- `test/mutate/README.md` / `FAILSAFE.md` 同步锁语义与计数；`node scripts/doc-lint.mjs` ⑥
  核对 **342** 条；`smoke` 补 §151 收纳断言与 §135 文案上限断言。

## v0.6.17（2026-10-18）— UI P1 八项 + 模型显示别名（界面看官方宣传名，请求仍用 API id）

> 功能版，两件事：① `docs/DESIGN-UI-v1.md` 的 **P1 八项**落地：工具调用时间线卡片、`⌘K` 命令面板、
> 快捷键表（`⌘/`）、右栏「本轮运行」、会话设置弹层、空态三步引导、设置分组 + 搜索、
> 明暗主题 + 窄屏断点（§3.70）；② 模型名称新增**显示别名** `config.modelLabels`：
> 官方宣传名（如 `DeepSeek-V4.1-Flash 1017`）只影响界面显示，**请求体 `model` 始终是 API id**
> （§3.69 后端 + §3.71 UI 接线）。顺带把 §145 的时序断言改为**负载自适应**（限频语义不变，
> 去掉限频的变异仍会失败）。逐条根因与取舍见
> `docs/internal/AUDIT-v0.6.1-第三方报告登记.md` §3.69–§3.71。
> 变异验证 **28 批 323 条全中**（数字由 `scripts/doc-lint.mjs` ⑥ 守卫）。

### 一、UI P1：工具时间线 / ⌘K / 快捷键表 / 右栏本轮运行 / 会话设置 / 空态 / 设置分组搜索 / 主题与断点（§3.70）

**工具调用时间线卡片**：同一轮工具调用聚合成**一张** `.toolcard`（头部「工具时间线 · N 步 ·
总耗时 · K 个失败」+ 整卡折叠）；每步一行「序号 · 状态 · 工具名 · 参数摘要 · 耗时」，
失败步 `li.tl-step.fail`（红色边条 + 8% 红底 + `✖`）；点击展开完整参数（JSON）与输出，
长输出默认折叠并显示**真实行数/字节数**（`TextEncoder` 计字节）；默认只显示前 3 步 +
**所有失败步**，其余收成「展开其余 K 步」；开始/完成复用同一 DOM 节点（`msg._toolTimeline`
+ `tl.steps.get(seq)`），不再删卡重建。

**`⌘K` / `Ctrl+K` 命令面板**（纯前端）：分组列出 会话 / 工作空间 / 模型 / 预设 / 权限 / 命令 / 设置；
打开时只刷新一次 `/api/sessions` 与 `/api/workspaces`（不是轮询）；↑↓/Home/End 选择、
Enter 执行、Esc 关闭、焦点回到打开前元素，`e.isComposing` 期间不响应。动作覆盖新对话、切换会话/
工作空间/模型/预设/权限、停止本轮、快捷键表、收起展开右栏、切换明暗、打开设置（可深链到四个主分组）、
诊断路径。**Web 端没有 `/compact` 就不列该项**，不造新后端。

**快捷键表**（`⌘/` / `Ctrl+/`）：只列**实际实现**的 7 项（`⌘K`、`⌘/`、`Esc`、`Enter`、
`Shift+Enter`、`⌘Enter`、权限确认 `y/n`）；不列 `⌘N`、`F5` 等未实现项。

**右栏「本轮运行」**：宽屏（≥1180）默认展开并推开正文 300px；<1180 默认收起，顶栏「运行」
chip 点开为覆盖式抽屉。字段为模型 label + `API id` + 来源、预设、权限 + 来源，以及
**六项本轮数据**（阶段/首帧/吞吐/上下文/工具步数/费用）+ 停止按钮与压缩入口（无后端时 hidden）。
六项与 P0 状态条**同源**：`renderRunPanel()` 只调用 `runPanelView()`，后者只调用
`runStripView()`、只读同一个 `runState`，不另算、不加轮询。

**会话设置弹层**：模型 / 预设 / 权限三件套收进 `#sessSheet`，输入区只留一个「⚙ 会话设置」按钮
（按钮上直接印当前模型 label 与权限标签）；模型显示服务端 `/api/state.models` 的 `label` 与
`API id: <name>` 副标题（缺失回退 id，不编造）；预设标「仅下一轮」；权限显示
`permission=auto（来源：explicit/preset/config/default）`；底部「本轮实际生效」由同一 `runState` 组装。
原 `#modelSel`/`#presetSel`/`#permSel`/`#reasoningSel` 保留在弹层内，既有契约不变。

**空态引导**：无消息且非生成中显示三步（选模型 → 选工作空间 → 输入任务），每步有完成状态；
缺模型时第①步直接给「选择模型…」；3 个示例任务点击**只填进输入框并聚焦，不发送**。

**设置分组 + 搜索**：导航改为 10 组（模型与端点 / 运行与超时 / 权限与沙箱 / 外观 / 工作空间 /
调度队列 / 云同步与协作 / 长期记忆 / MCP 生态 / 技能库）；顶部 `#cfgSearch` 按标题/说明/
placeholder/`data-kw` 过滤，不匹配项带 `hidden`，命中项描边高亮，自动切到首个命中分组并显示匹配数。

**明暗主题 + 窄屏断点**：`<html data-theme>` 两套 token；偏好写
`localStorage['mingdao-theme']`（`light|dark|system`），选 system 时用
`matchMedia('(prefers-color-scheme: dark)')` 跟随并监听 `change`；顶栏一键切换。
`<1180` 切 `body.narrow-run`（右栏收起）、`<900` 切 `body.narrow-side`（隐藏次要顶栏项、
图标轨收窄、空态留白收紧），判据与类名由 `layoutClassesFor(width)` 单一函数给出；
补 `prefers-reduced-motion`。

### 二、模型显示别名后端 `config.modelLabels`（§3.69）

**起因**：负责人真机实测 `GET /v1/models` 只返回 `deepseek-flash` / `deepseek-v4-pro`；
拿宣传名 `DeepSeek-V4.1-Flash 1017` 请求会被 400 拒绝。因此宣传名只能做**显示别名**。

- `src/models.js`：新增 `MODEL_LABEL_MAX_LENGTH`（80）、`normalizeModelLabels()`、
  `modelDisplayLabel()`；key 非空、value 为字符串且去空白非空、≤80 字符，拦
  `__proto__`/`constructor`/`prototype`；**非法项忽略并 `console.warn`，不阻断启动**
  （同一项每进程只提醒一次）；不写回 `config.model` / `routing.*`。
- `src/config.js`：`loadConfig()` / `ensureMinimalConfig()` 读配置时就地归一化，非法值在内存丢弃，
  磁盘原文不静默改写。
- `src/model-discovery.js`：服务商线上条目新增 `id`（API 实际 id）与 `detail`（能力/来源说明），
  `label = modelLabels[id] || id`，`label !== id` 时附 `labelSource: "config"`；`name` 仍是 id。
  `/api/models` 与 `/api/state` 都走 `availableModels()`，两个接口同时获得上述字段。
- **请求 `model` 仍是 API id**：显示别名只出现在 `label`/`detail`；`/api/config` 切换模型仍按
  `body.model`（id）校验落盘；有 `/api/chat` 桩断言**所有出网请求**（含预检）的 `model` 都等于 API id。
- 文档：`docs/CONFIG.md` 新增「显示别名 `config.modelLabels`」一节（400 实测证据、校验表、接口字段表）。

### 三、UI 接上别名：下拉 / 会话设置 / 设置页 / ⌘K（§3.71）

- **两处模型下拉**（`init()` / `reloadModels()`）：`value` 取 `m.id`、可见文本取 `m.label`（回退 id）、
  `title` 含 `API id: <id>` 与 detail；选择比较与 `modelsCache` 查找统一按 id。
- **会话设置**：新增默认 `hidden` 的 `#ssModelAliasHint`（「显示名来自 config.modelLabels，
  请求使用 API id。」），仅在 `label !== id` 时显示。
- **设置页**：模型与 API Key 标题下补说明「模型 id 以 API 返回为准；官方宣传名可在
  `config.modelLabels` 里映射为显示名（请求仍用 API id）。」，**不新增控件**。
- **`⌘K` 模型项**：文本 `m.label || m.id`（旧快照无 id 时回退 `m.name`），提示带「API id: <id>」，
  执行仍 `setModel(id)`；搜索同时匹配 label / id / name，新旧名字都搜得到。

### 四、§145 时序断言改为负载自适应（负责人要求）

原断言「11 秒回合日志里恰好 1 行进度」和 `slowMs>=5000` 在并发/慢机下会把基线打红
（表现为变异「逃逸」）。现改为：`slowMs >= 10000`（命令固定 `sleep 11s`，覆盖 5s/10s 两次心跳）；
进度行上限 = `ceil(slowMs / 30000)`（30s 限频的语义上限，随实测耗时增长）。
去掉了限频的变异（每 5s 一行）仍会超过该上限——**这是收紧语义，不是松断言**。

### 五、测试

- `test/smoke.js` 追加 §149（P1 八项的结构与行为断言）与 §150（模型显示别名的下拉/会话设置/
  设置页/请求仍 id/⌘K）；既有 P0/P1 守卫保持绿。
- `test/model-names.js` 追加第 ⑧ 组（label/id 分离、非法值 ignore+warn、无映射回退、
  `/api/chat` 桩断言请求 model 仍是 API id）。
- 新变异批：`batch37-model-labels` **10 条**、`batch38-ui-p1` **14 条**、
  `batch39-ui-label` **7 条**；总数 292 → **323**（28 批）。
- `scripts/doc-lint.mjs` ⑥ 守卫核对 README 计数 323。

## v0.6.16（2026-10-18）— 模型名称与能力判定以 API 实时官方名为准 + UI P0（常驻状态条 / 错误折叠卡 / 内联权限确认）

> 功能版，两件事：① 官方升级模型（如 `DeepSeek-V4.1-Flash 1017`）后，默认值与界面提示仍指着旧名 →
> 模型名称与能力判定改为**以 API 实时返回的官方名为准**（家族正则匹配，精确 id 只作别名；
> 未知新版本可选中并标"能力未知"，不拒绝；§3.67）；② `docs/DESIGN-UI-v1.md` 的 **P0 三项**落地：
> 常驻运行状态条、错误折叠卡、对话流内联权限确认，并透出 `/api/state.permissionSource`（§3.68）。
> 逐条根因与取舍见 `docs/internal/AUDIT-v0.6.1-第三方报告登记.md` §3.67–§3.68。
> 变异验证 **25 批 292 条全中**（数字由 `scripts/doc-lint.mjs` ⑥ 守卫）。

### 一、模型名称与能力判定以 API 实时官方名为准（§3.67）

**起因**：负责人反馈"DeepSeek 官方已推出 DeepSeek-V4.1-Flash 1017，API 拉取到的也是该版本，
模型名称应该相应改为官方名称，或者一步到位，以后版本一律以 API 实时拉取到的官方名称为准"。
旧实现把 `deepseek-v4-pro` / `deepseek-flash` / `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp`
写成精确键，官方每升一次版本就要改一次代码。

- **家族模式表 `MODEL_FAMILIES`**（`src/models.js`）：用正则匹配 **pro / flash / vision**
  （大小写、空格/下划线/连字符、`v4`/`v4.1`/`V5` 版本号均兼容）；上下文窗口、输出上限、
  工具/推理/视觉能力与峰谷定价挂在**模式**上。精确 id 只作已知别名表 `MODELS_KNOWN`，
  旧名 `deepseek-v4-flash` 仍可用（标签注明"旧名别名"）。
- **默认值运行时解析**（`src/model-discovery.js`）：新增 `resolveDefaultModel(role)` /
  `resolveRoutingDefaults(cfg)`，优先级 `config.routing.planner|executor`、`config.model`
  → 当前 `/v1/models` 名单按家族挑官方名（多版本取最高）→ 内置家族代表名兜底，
  并同时返回 `fallback`/`offline` 与提示。`ensureMinimalConfig` / `loadConfig` / 向导 /
  WebUI 路由开关全部接入；新增 `GET /api/models`（含默认 planner/executor、
  `source=config|api|fallback`、`offlineFallback`、`note`）。
- **不打扰只实现 chat 的网关**：`provider: custom` 与未内置服务商**不主动探测** `GET /models`
  （空 body 会 `JSON.parse` 崩，e2e-web 回归即由此而来）；默认值用家族代表名兜底，
  显式 `config.routing.*` 仍优先。
- **未知新版本可选、不拒绝**：家族能匹配但比已核对规格新的版本（如 `DeepSeek-V4.2-Flash 1101`）
  可选中、标"能力未知（新版本）"，按家族规格保守估算；非家族线上新模型同样列在列表里。
- **离线兜底显式**：API 不可达时列表回退内置家族代表名，每条标 `offlineFallback: true`，
  并统一提示"离线兜底：模型名可能不是最新的（API 不可达，已使用内置家族代表名）"。
- **四处文案去版本号**：`cost-guard.js`（pro/flash 家族）、`help.js`（家族 + 以 API 为准）、
  `web/attachments.js`（vision 家族）、`web/routes/domains/config.js`（路由默认值不再写死版本）。
- 文档：`docs/CONFIG.md` 新增「模型名称以 API 为准」。

### 二、UI P0：常驻状态条 / 错误折叠卡 / 内联权限确认（§3.68）

- **P0-1 常驻运行状态条**：`index.html` 用 `#runStrip` 替换 `#workStatus`（六项 `data-k`：
  阶段/首帧/吞吐/上下文/工具数/本轮费用）；删除查不存在 `#liveBar` 的 `renderLiveBar()` 死代码，
  `renderWorkStatus()` 收成**唯一**刷新出口。数据只来自既有 SSE（progress/usage/done）与
  `/api/state.contextBudget`，**不新增轮询**。阶段收敛五档；生成中的上下文标 `≈`（done 后才精确）；
  无工具调用时明写"0 次"；窄窗 `flex-wrap` 换行。
- **P0-3 错误折叠卡**：多行长错误改走 `.err-card`——首行摘要 + 归属标签、处置建议独立成行
  （`white-space:pre-line`）、上游原文默认折叠（`<pre>` + `pre-wrap` 保留换行）、带"展开原文"与"复制"。
  普通横幅（已停止/已保存/预设提示）保持原样。
- **P0-2 内联权限确认**：`askModal` 改为对话流里的 `.perm-card`（普通文档流），不再
  `position:fixed;inset:0` 遮罩——输入区、附件、停止键、滚动全程可用；三键为**本次放行 / 拒绝 /
  始终允许本会话**，`y`/`n` 可用、`Esc`=拒绝；同一轮多个确认串行展示；**120s 超时按拒绝、停止优先于超时**。
- **P0-4 `/api/state` 透出 `permissionSource`**（`explicit|preset|config`），与账本
  `LEDGER_PERMISSION_SOURCE` / `resolveTurnPermission()` 同源，不另立判定；前端放进状态条悬浮详情。
- **§144 测试卫生**：`test/smoke.js` §144 的写盘标记改为 `fs.mkdtempSync(os.tmpdir())` +
  `finally` 清理，`.gitignore` 加 `.tmp-p144-*` 兜底。

### 三、测试与门禁

- 新套件 `test/model-names.js`（7 组断言）接入 `test/run-all.mjs` 与 `.github/workflows/ci.yml`
  （仅 Linux 腿，带失败注解）：官方名显示/选中、未知新版本可选、默认值解析顺序、旧名别名、
  custom 端点 0 次 `/models` 探测、离线兜底提示。
- 新变异批 `batch35-modelnames` **9 条** + `batch36-ui-p0` **12 条**，总数 271 → **292**
  （25 批，`doc-lint` ⑥ 守卫）；`smoke` 追加 §148（状态条六字段/错误卡/内联确认/来源/§144 卫生）。

## v0.6.15（2026-10-17）— 变异框架 fail-safe + 本地端点并发串行化 + 工具参数解析纯函数（含空值回填修复）

> 补丁版，三件事分别来自**两次真实事故**与两轮已登记的审计债：① 变异在飞被扫描误报成"残留"、
> 进程被强杀后补丁留在工作树（曾差点把"停止键失效"发进版本）→ 变异框架补 fail-safe（§3.61）；
> ② v0.6.14 真机上本地引擎在长任务中途报内存不足 → 同一 baseUrl 串行化、并区分"引擎活着丢缓存"（§3.59/§3.60）；
> ③ P1-1 前置门的第四刀：工具参数解析抽成纯函数，并修掉顶层空值被回填成字面量 `"undefined"`/`"null"`（§3.62）。
> 逐条根因与取舍见 `docs/internal/AUDIT-v0.6.1-第三方报告登记.md` §3.60–§3.62。
> 变异验证 **23 批 271 条全中**（数字由 `scripts/doc-lint.mjs` ⑥ 守卫）。

### 一、变异框架 fail-safe：残留标记 + 互斥锁 + 开跑前字节级自愈（§3.61）

两次真实事故：① 变异**在飞**时被扫描误报成"残留"；② 进程被**强杀**后补丁留在工作树，
看起来像"有意改动"（曾差点把"停止键失效"发进版本）。

- **持久残留标记**：`mutate()` 写补丁前先落 `test/mutate/.generated/pending/<hash>.json`
  （`file` / `from` / `to` / `pid` / 时间戳 + **原始字节** + 补丁全文），还原后删除；
  **原子写**，强杀不留半截 JSON。
- **开跑前自检 `check.mjs`**：文件仍等于 patched → **按原始字节自动还原**（含 CRLF）；
  文件被第三方改过 / 标记里的 pid 还活着（**在飞**）→ **拒绝运行并列清单**，绝不误碰。
- **互斥锁** `.generated/mutate.lock`（pid + 启动时间）：第二个 mutator 被告知"已有 mutator 在跑"；
  陈旧锁自动清理；`run.mjs` 全程持锁、批次子进程继承；`exit`/`SIGINT`/`SIGTERM` 清锁并**还原在途补丁**。
- **强杀可感知**：`run.mjs` 启动时与**每批之间**自检；脏工作树（`src/**`、`test/**`）默认拒绝，
  `--allow-dirty` 放行。stdout/journal 落「变异进行中：<file>」/「已还原：<file>」——**在飞与残留可区分**。
- 新增 `test/mutate/selfcheck.mjs` **8/8**：干净启动 / 残留自愈 / 冲突拒绝 + 在飞不误治 / 活锁 /
  脏树 / SIGTERM（143 还原）/ **SIGKILL（标记 + 陈旧锁留下 → 下次 check 自愈）**。
  文档：新增 `test/mutate/FAILSAFE.md`，`docs/CONFIG.md` 加指路。

### 二、本地端点并发与内存：同一 baseUrl 串行化 + "引擎活着丢缓存"独立分型（§3.60，§3.59 收口）

复现：v0.6.14 真机 8081 qwen 长任务中途被引擎拒绝（`insufficient memory` / `allocator wall` /
`engine shed its caches and stays up`）；同错在 60091 的 35B 上也出现 → 不是模型问题，是**本机内存压力**；
该回合此前有子代理在跑（13 轮 / 17 次调用）→ **父回合 + 子代理同时向同一本地引擎发大 prefill** 是主要来源。

- **进程级 `acquireLocalSlot` 串行化**（`src/providers/index.js`）：默认 `localConcurrency=1`，
  `0` 关闭、上限 **16**；`localQueueTimeoutMs` 默认 **30 分钟**，排队超时报 `LOCAL_QUEUE_TIMEOUT`
  （**可见错误、不重试**）。覆盖**父回合 / 子代理 / 预检**（`model-discovery.js` 的 `open()` 同过闸门）；
  **云端 baseUrl 直接放行**。
- **计时口径**：首帧计时在**取得名额后**起算；**总时长含排队**且可中断（Ctrl-C 排队中也能停）。
- **四处可见"已串行化（防内存压力）"**：入队日志、进度行、界面状态条、发送前预告。
- **错误分型**：`describeUpstreamError` 新增 `shed-caches` 独立分支——明确"**引擎未崩溃、不要重启**"；
  `agent` 的 507 早退排除该措辞。`prefillForecast` 在本地端点已有在途请求时给**并发强警告**
  （"并发会加剧内存压力 / 已串行化 / 减少子代理"）。
- 文档：`docs/CONFIG.md` 新增「本地模型：并发与内存」；`docs/CONFIG.en.md` 同步。
- 回归：`test/smoke.js` §142（真桩实测最大并发=1、云端并发=2、排队超时可见、预检串行化、
  shed-caches 分型、并发预告强警告、配置/进度行/结构守卫）；`batch31-localconcurrency.mjs` **8 条全中**。

### 三、P1-1 第四刀：`parseToolArgs` 抽成纯函数 + 顶层空值回填修复（§3.62）

第三刀刻意否决了整个前置门（hooks → 白名单 → 权限 → 约束确认的顺序与短路、账本 `toolCall`
内容依赖门的结果）；本刀只取门前最前端、**零 await 零副作用**的一步。

- `src/tools-flow.js` 新增 `export parseToolArgs(raw)`，**行为清单 8 条**（原表达式逐条对照钉在 §143）：
  假值 raw（`undefined`/`null`/`''`/`0`/`false`/`NaN`）→ `{}`；合法 JSON 对象 → 原样；
  合法但非对象（`'null'`/`'[]'`/`'42'`/`'"s"'`/`'true'`）→ `{}`；空白串 / 非法 JSON → 三段文案逐字一致；
  **不做前后缀宽容**（代码围栏、多余尾巴都失败）；**不做长度上限**；非字符串走 `JSON.parse` 的隐式 ToString。
- `src/agent.js` 不再内联 `JSON.parse` / `|| '{}'` / 非对象归一化与三段文案，改为调用；
  三条副作用（`renderToolDenied` / 审计 / `messages.push` 分块指引）按原顺序保留。
- **空值回填修复**：`serializeToolResult(undefined)` 此前经 `clampText` 的 `String()` 变成字面量
  `"undefined"`（顶层 `null` 则是 `"null"`），模型会把它们当成工具输出。现在顶层
  `undefined`/`null`/**函数**/**符号**统一回填**空串**；**嵌套 null 与字符串 `"null"` 保留**。
- 回归：`test/smoke.js` §143（21 个输入与抽取前表达式逐条对照、三段文案逐字、超长不设闸门、
  空值回填、三条端到端、单源结构守卫）；`batch32-toolargs.mjs` **10 条全中**；`batch22` 锚点随新实现同步。
- 变异总数 **219 → 271**（`batch31` 8 条 + `batch32` 10 条 + `batch34` 7 条 + 并行道 `batch33` 27 条），README 与 `doc-lint` ⑥ 同一提交一致。

### 四、同批确认（核对结论，不重复计入）

- `docs/DESKTOP-AUTO-UPDATE.md`、`test/mutate/FAILSAFE.md` 等文档**已在库内**；
- 前置门整体仍未抽（`prepTool` 里的顺序/短路仍是原样）——本版只切了 `parseToolArgs`，见发布说明「已知边界」。

### 五、同批并入的并行道（§3.63 / §3.64 / §3.65）

- **账本 `run.start.permissionSource`（§3.64）**：把"生效的权限值"与"这个值是谁定的"分开记——
  `explicit`（用户显式选择）/ `preset`（预设声明的 permission 生效）/ `config` / `cli` / `default`；
  **非法或缺失一律 `null`**（来源未知，不猜成 `config`）。`LEDGER_VERSION` 仍为 1，旧账本照常校验，
  `ledger show` 只在字段存在时多一行（输出契约不变）。
- 回归：新增独立套件 `test/ledger-source.js`（7 组，已接 `run-all` 与 CI 的 Linux 腿）、
  `batch34-ledger-source.mjs` **7 条全中**。边界：`worker.js` / `schedule.js` / `repl.js` 不在本轮
  改动清单，**后台任务与 REPL 内 `/preset` 切换的来源暂为 `null`**（来源未知）。
- **英文文档同步（§3.65）**：`README.en.md` / `SECURITY.md` / `docs/CONFIG.en.md` 与中文文档、代码对齐
  （本地串行化、无进展看门狗、端点预检、账本签名）。
- **M-8 源码守卫收口（§3.63）**：`src/web/server.js` 的全部 **43 处**单行源码文本守卫**整簇处理**
  （25 处改为行为化断言，真起 Web 服务 + 桩 provider 从 SSE/日志取证；18 处加固为行尾归一化并标注
  "文本绊线，不是行为证明"）。新增 `batch33-guards2.mjs` **27 条全中**，并修掉一处
  「守卫被同文件另一处字面量满足」的假绿（§141 的 `reason=` 被引擎探针日志行顶替）。
- **测试可移植性修复（两处）**：① `test/smoke.js` §145 的 11 秒慢命令改为平台自带等待
  （Unix `sleep 11` / Windows `ping -n 12`）——原命令 `node -e "…"` 在 `bash -lc` 下可能丢 toolcache PATH、
  在 `cmd.exe /d /s /c` 下嵌套引号被吃掉；② §134 不再改**全局** `child_process.spawn`，改为经
  `Module._load` 只把桩 spawn 注入给被加载的 IDE 扩展——Node 18 下同进程 ESM 导入的 bash 工具
  （`src/tools/bash.js`）会拿到桩 child（只有 `kill`、没有 `stdout`），把 §145 的 11 秒回合打成 **15ms**，
  这就是 CI ubuntu-18 与 windows 上「本用例需要跨过 5s 心跳」假红的真正根因。
- **UI 设计提案 v1（§3.66，仅文档）**：`docs/DESIGN-UI-v1.md` + `docs/design/ui-preview.html`，**不改产品代码**。
- 本版全批次 **23 批 271 条全中**（含 `batch33` 27 条与 `batch34` 7 条）。

## v0.6.14（2026-10-09）— 预检误报"不可达"修复（失败分型 + 失败结论只保鲜 60s）+ 内置预设精简为唯一 local-model

> 补丁版，两件事都来自**负责人真机使用 v0.6.13 的过程**，不是代码审查的推演。
> ① 内核把一条 **7 小时 10 分钟前**的失败结论原样念给用户、并据此把用户引去重启引擎，
> 而**同一回合其实完全可用**（首帧 8.7s）；② 发行版面向普通大众，**不替用户决定任务类型**，
> 于是内置预设收窄为只提供参数类默认值的唯一一个 `local-model`。
> 逐条现场证据、根因与取舍见 `docs/internal/AUDIT-v0.6.1-第三方报告登记.md` §3.56 / §3.57。
> 变异验证 **19 批 219 条全中**（数字由 `scripts/doc-lint.mjs` ⑥ 守卫）。

### 一、端点预检误报"不可达"：失败分型 + 超时覆盖首帧 + 退避 + **失败结论只保鲜 60s**（§3.56）

- 现场（真机 `~/.mingdao/logs/web-server.log`，可复核）：`:413`（07:03:02）**进程启动**时引擎还没起来，
  唯一一次真实探测得到 `unreachable`，**这条结论进了进程内备忘且没有任何 TTL**；
  `:415/:416`（07:08:13.912/.931，相距 **19ms**）与 `:798/:799`（10:13:58.877/.900，相距 **23ms**）
  两次 `chat 预检 … ❌ 不可达：fetch failed（本地引擎没起来？先确认端口/进程）`，
  两次都**没有** `预检 <模型>` 行 ⇒ **没重测，直接念旧结论**。而 `:419`（07:08:59）引擎已 `ok-tools`、
  `:803` 同一回合 `chat 首帧 … 8.7s`、`:844` 已跑 21m06s——`:799` 距 `:413` 已 **7h10m**。
  **用户照这句话去重启了引擎。**
- 根因（改前行号）：①`src/web/server.js:312/337` 的 `probeByModel` 备忘**只按"有没有"判**，
  短路了 `model-discovery` 的 10 分钟缓存（`probeCache` / `PROBE_TTL_MS`）；
  ②`src/model-discovery.js:306-310` 所有网络层失败（超时/被断开/HTTP 4xx/裸 `fetch failed`）**共用一句"不可达"**；
  ③`:222-230` `once()` 在**响应头**到达时就 `clearTimeout`，而探针是 `stream:true` ⇒ **超时不覆盖首帧**
  （引擎"回了头、卡在 prefill"时探针一直挂着，而它在回合发起前被 `await`）；
  ④`:252-274` 三次尝试**无退避**（引擎"正在启动"时 1ms 内连撞 3 次判不可达）；
  ⑤`:346/410` `toolState=unknown → state=unreachable` + "多为被 max_tokens 截断" ⇒ **HTTP 404 的真实原因被盖住**。
- **修法**：
  - **失败结论只保鲜 60s**：新增 `PROBE_FAIL_TTL_MS = 60 * 1000` + 纯函数 `probeVerdictFailed()` /
    `probeMemoUsable()`，模块级 `probeCache` 与 `server.js` 的 `probeByModel` **两处统一按它判**；
    **成功结论仍按 `PROBE_TTL_MS`（10 分钟）复用**。这是"7h10m 重放"的根治点。
  - **失败原因分型 + 文案分叉**：`classifyProbeError()` → `refused`（连接被拒 / `ECONNREFUSED`）/
    `reset`（被对端断开）/ `timeout` / `other`；`classifyProbeHttp()` → `http-unimplemented`（404/405/501）/
    `http-auth`（401/403）/ `http`；结论带 `probe.reason`，**日志与文案都跟着判据走**（`probeFailureNote()`）。
    **只有连接被拒 / 被断开才说"不可达"**；超时说"⏱ 探针超时：1.5s 内没有首帧（端口是通的，引擎在
    prefill 或**正在启动**）"；404 说"❌ 探针被拒绝：HTTP 404（端点未实现该探针请求）"；**不再出现裸 `fetch failed`**。
  - **超时覆盖到首帧**：`timeoutMs` 改为**整个探针的时间预算**（`server.js` 仍传 15000），单次
    `attemptMs = PROBE_ATTEMPT_MS`（**1.5s**）且**只在读到首帧后才 clear**（body 阶段触发首帧超时会被抛出
    并按"超时"归类）；参考 prefill 单独放宽到 20s（本机 35B 实测 6.6~7.8s / 2000 tokens），
    样本数仍 `PROBE_ATTEMPTS = 3`（工具三态判据不变）。
  - **退避重试** `PROBE_BACKOFF_MS = [300, 700]`；**降级语义显式化**（`ensureProbe` 吞掉一切探针异常，
    只留一行"失败（忽略，按默认超时继续）"，回合级预检整段 try/catch，每句失败文案都带
    "**预检是尽力而为，失败只降级、不阻断本回合**"）。
  - **新增复核日志行**：`chat 预检复核 <taskId> 预检曾判不可达（reason=…），但本回合实际可用（首帧 Xs）
    ——预检判据需复核`——**判错了要留痕**。
  - **不打扰"只实现 chat 的端点"**：探针只打 `POST {base}/chat/completions`（与主请求同构），
    `GET /props` 仍只在引擎自报模型名后才打 ⇒ 桩验证 GET 次数 = **0**。
- 回归：`test/smoke.js` §141（真桩服务 + 桩引擎：拒连 / 只实现 chat / 首帧慢 / 永不回帧 / 404 /
  启动中 / 保鲜期 / 探针异常只降级 / 结构守卫）；`test/mutate/batch30-preflight.mjs` **10 条全中**。

### 二、内置预设精简：**只剩 `local-model` 一个参数预设**（§3.57）

- **删除** `presets/readonly-audit.json`；内置预设只剩 `presets/local-model.json`，定位收窄为
  **只提供参数类默认值**（`contextBudget` / `maxOutputTokens` / `maxRounds`）——
  **不携带人格、不限制工具、不涉及权限**。需要"只读"请自行组合**权限档**（`readonly`）
  与**工具白名单**（`tools`）。
- 老名 `local-audit` **保留为别名**并指向 `local-model`，加载时打印
  「已更名为 local-model（本次已按 local-model 执行；建议尽快改用新名字）」。
- 决策理由（负责人原话，登记 §3.57）：代码审计只是他作为一项较大型较长任务对 MDH 做的**测试**；
  **发行版面向普通大众**，不是某种任务的定制——用户可能执行不同任务、不一定用本地模型、
  也不一定用来审计代码。**发行版不替用户决定任务类型。**
- `src/presets.js`：文件头新增「内置预设的定位」整段；`PRESET_ALIASES` 保持
  `{ 'local-audit': 'local-model' }`；`KNOWN_FIELDS` 保留 `recommendedPermission`
  并注明"内置预设不使用它"（第三方预设声明它仍应通过校验）。
- `test/api-contracts.js`：契约改为——内置预设（`source === 'builtin'`）**深比较等于 `['local-model']`**、
  **不得含** `permission` / `recommendedPermission`、`local-audit` 解析到 `local-model` 且带 `aliasedFrom`、
  **`readonly-audit` 必须已不存在**（`loadPreset` 为 `null` + 无别名 + 文件不存在）。

### 三、同批测试残留清理

- `test/smoke.js` §47 / §139 断言按新契约改写（内置**只应有 `local-model`**、`readonly-audit`
  必须不存在 / 加载为空、项目级遮蔽用例改用 `local-model.json`）。
- `test/mutate/batch28-stall.mjs` 删 ㉖（随 `readonly-audit` 删除），条数 **26 → 25**；
  `batch27-preset.mjs` 锚点改指 `presets/local-model.json`，条数**保持 6 条**。
- 变异总数 **210 → 219**（新增 `batch30-preflight.mjs` 10 条）。

### 四、本次未纳入的既有内容（核对结论）

- `aa76304`《桌面版自动更新实现指南》**已在 v0.6.13 的 tag 内**（`git merge-base --is-ancestor` 已确认），
  本版**不重复计入**。


## v0.6.13（2026-10-09）— 真机四问题：预告由预检推导 + 引擎自述上下文 + 子代理进展算父回合进展 + stalled 用户可见

> 补丁版，全部内容来自**负责人用 v0.6.12 做的一轮真机测试**（本机 llama.cpp 端点，跑"用本地模型
> 审计 MDH 代码"这类长任务），不是代码审查的推演。四个问题各自独立，但都是同一个毛病的不同表现：
> **内核拿到了数据，却不拿它做判断**——v0.6.12 把"看得见"做出来了，这一版把"看得见的东西真的影响结论"补上。
> 逐条现场证据、根因与取舍见 `docs/internal/AUDIT-v0.6.1-第三方报告登记.md` §3.55。
> 变异验证 **18 批 210 条全中**（数字由 `scripts/doc-lint.mjs` ⑥ 守卫）。

### 一、`chat 预告` 改为**由预检实测线性外推**，并如实标注外推的局限（问题 1）

- 现场：`web-server.log:304`（04:13:27）同一条预告里写着「prefill 可能需**数分钟至数十分钟**」，
  后半句又写着「参考 prefill 2000 tokens **0.08s**」——**自己打自己**；52 秒后 `:307`
  `chat 首帧 t424aaab2aecab8a3 53.7s`，按同一份预检外推只有 **0.6s**（差 **90 倍**）。
- 根因：本地分支是**与端点无关的固定文案**，预检实测只被当附注拼在后面，**从不参与推导**。
  后果不是"数字不准"，而是同一条横幅自相矛盾 → 用户学会忽略这条告警。
- 新增 `prefillEstimateMs()`（纯函数）：有 `probe.prefillMs` 时按
  `参考耗时 × 本轮 tokens ÷ 参考 tokens` 外推，没有则返回 `null`。
  `prefillForecast()` 改为三分支、**顺序即优先级**：
  ①有实测 → 报外推值（`按预检 0.08s/2,000 tokens 外推，本轮 ≈0.6s`）并**如实**附上真机差值
  （常量 `PREFILL_LONGCTX_EVIDENCE`，文案与注释同源）；②无预检数据（不可达/不可判定/未预检）→
  **退回**原保守文案；③远程端点 → 各自一句。
- 三条告警线据实调整：占窗口 ≥80% 照旧；**外推 ≥ `PREFILL_SLOW_WARN_MS`（60s）**才告警且**写出依据**；
  「本地端点 + ≥60k tokens」**降级为仅无实测时的兜底**——"0.08s 的端点被说成需要数十分钟"正是它造成的。

### 二、预检新增 `GET /props`：读**引擎自述上下文**并与配置并排（问题 2）

- 现场：`web-server.log:229` 引擎报 `insufficient memory … during prefill`，而配置
  `customModels.MLocalModel3.6.2.contextWindow = 131072`、引擎自述 `n_ctx = 32768`（配置是能力的 **4 倍**）。
- 根因：预检只测"能不能跑"，**从不问"引擎装得下多少"**。这正是负责人"**换预设也没用**"的根因——
  预设只改 `contextBudget`，改不了引擎的 `n_ctx`。
- 新增 `engineContextFromProps()` / `engineContextNotice()`（均为纯函数）：本地端点额外读一次
  `GET /props`（`baseUrl` 带 `/v1` 时先剥前缀再试），按"越贴近引擎真实装载值越靠前"抽
  `default_generation_settings.n_ctx` / `n_ctx` / `n_ctx_train` / `max_model_len` / `context_length`，
  一律要求**正整数**（假值不拿去和配置比）。
- **门槛**：只有引擎**自报了模型名**才多打这一个请求。llama.cpp 家族总会回模型名/文件路径；
  回不了名的多半是只实现 `/v1/chat/completions` 的网关或测试桩，它们**不认识 `/props`**
  （实测教训：`test/e2e-web.js` 的 mock 只按 `POST + JSON body` 解析，收到空 body 的 GET 会抛
  `JSON.parse('')` 把整条 e2e 打挂）。**不认识 `/props` 的端点一个字节都不多发。**
- 三态结论**不合并、不省略**：配置 ≤ 引擎 → 明说"一致"（用户才知道这条核对**做过**了）；
  配置 > 引擎 → 警告并点明**换预设/调 `contextBudget` 都改不了引擎上限**，给出两条真修法；
  读不到/跳过 → 如实说"未读到/跳过"，**不猜**、不据此否定端点、不假装核对过。
- 内核：配置超限时发**独立告警 banner**；`预检 <模型> …` 日志行改为带 `prefill2000=`、
  真实四态 `tools=` 与 `引擎自述上下文=… 配置=…`（此前用的是**从来不存在**的 `probe.toolCalls`，
  真机日志里恒为 `tools=未知`）。

### 三、子代理进展**算父回合进展**（问题 3）

- 现场：`web-server.log:292-300`（02:42:31→03:13:16，**30m45s**）父回合 `status=stalled`；
  同会话 `:28/29` 两条 `task` 结果写着「连续 **1 分钟**没有任何工具调用（模型请求 **15 轮**、
  工具调用 **18 次**）」——**子代理一直在干活**，却被判"连续 1 分钟没有进展"。
- 根因（**两个原因同时成立**）：父回合在 `await task` 期间的进展判据只认"工具结果/正文增量"，
  **子代理的进展不在其中**（主因，决定整轮结局）；子代理继承的截止时刻是 spawn 时刻的**绝对快照**，
  到点即掐，触发时又拿"子代理自己的最后进展"当等待时长 → **谎报"连续 1 分钟"**（次因）。
- 修法：①子代理每次真实进展（成功且不重复的工具结果 / 新正文增量）经 `cfg.onSubagentProgress`
  **回调父回合**（增量帧节流 1s，工具结果不节流）→ 父回合续期；
  ②`turnProgress.subagent` 记录"在等哪个子任务、第几轮/几次工具调用/最后进展距今多久"；
  ③继承的截止时刻改为**活的**——`max(spawn 快照, 父回合 lastProgressAt + noProgressMs)`，
  **只前移不倒退**；④父回合等子代理时多等 `SUBAGENT_WAIT_GRACE_MS`（**15s**），
  保证**子代理自己的看门狗先响**并把原因回传；⑤看门狗带 `cause`（`own`/`inherited`），
  `inherited` 走 `inheritedStopNotice()`——明说"父回合整轮无进展，**不是子代理卡住**"，并如实报出
  子代理自己的轮次/工具调用数；⑥`task` 结果带上子代理进度与收口原因；
  ⑦**不足 1 分钟按秒说**（不再把 300ms 说成"连续 1 分钟"）。

### 四、`stalled` 用户可见，且与 `capped`/`aborted` 显式区分（问题 4）

- 现场：桌面壳 `mingdao.log:2996` 只有一行 `回合收尾：generating=false，按钮恢复发送`；
  同刻内核写的是 `chat 发送 done … status=stalled 总耗时=1845271ms`——**两条日志对不上**。
- 根因：`stalled` 只有内核状态与一条 `done.note`，没有 banner；前端 `done` 处理只打印 session
  不打印 status，而**桌面壳日志取的就是渲染进程 console**。
- 修法：内核 `stalled` 发**告警 banner**（与 `done.note` **同源**），`done` 事件新增 `stallCause`；
  收尾文案（`noProgressNotice()`）必须同时说清"多久没进展""发生了什么""**在等谁、等了多久**"
  与"下一步怎么办"，并**显式**说明"这是整轮零进展——不是 `capped`（跑满预算、可续跑），
  也不是 `aborted`（你点的停止）"；前端把结局（`done`/`capped`/`aborted`/两种 `stalled`）**写进控制台**，
  并在消息下方留一条 `stalled` 说明；进度行/进度条显示子代理轮次、工具数与最后进展。

### 升级须知（行为变更）

- **`chat 预告`的耗时数字换了口径**：有预检数据时报的是**线性外推值**（可能显著小于真实值，
  真机差 90 倍），文案已写明这条实测差值——**当量级参考，别当承诺**；无预检数据时与 v0.6.12 完全一致。
- **本地端点会多打一个 `GET /props`**（仅当引擎自报了模型名），随预检缓存 10 分钟。
- **「配置超出引擎能力」是警告，不是自动修复**：内核**不**替你改 `contextWindow`、
  **不**重启也不杀引擎进程。
- **看门狗默认值与判据未变**（默认仍 60 分钟、仍关不掉、自适应仍
  `clamp(max(ttft×100, prefill×20), 10min, 60min)`）；变的只有**"子代理的真实进展现在算进展"**。
- **父回合等子代理会多等 15s 才收口**（相对默认 60 分钟是 0.4%），换的是"子代理自己的结论能回传"。

### 断言与变异

- `test/smoke.js` 新增 **§140**（接 §139）：预告外推/保守分支/慢端点告警/线性关系/行为级接线、
  `/props` 读数（含"未自报模型名时**一个字节都不多发**"）/三态结论、父回合**不误杀**有进展的子代理、
  快照到期但父回合仍活时**不**收口、父回合真零进展时按 `inherited` 收口、进度行含子代理进度、
  `stalled` 文案与 `capped`/`aborted` 区分、内核 banner / `done.stallCause` / 前端控制台结局。
- 新建 `test/mutate/batch29-localmodel.mjs`：**27 条**，独立 worktree 跑 **27/27 全中**
  （全批次 **18/18、210/210**）。
- `test/mutate/README.md` 变异总数 183 → **210**（= `node scripts/doc-lint.mjs` 打印的"实际 210 条"，同提交）。
- 结构守卫**未被顺手改掉**：`test/smoke.js` §139 与 `batch28-stall.mjs` 里钉着
  `noProgressTimer = setTimeout(fireNoProgress, left);` 与 spawnTask 的三行 spread；
  本轮第一版改形状导致两条既有变异**假绿**（"变异点未找到"），已改回原形状——
  触发原因改由 `noProgressCause` 闭包变量传递，新增行追加在 spread 之后。**变异脚本是守卫，不是注释。**

### 已知边界

- **线性外推仍然只是外推**：长上下文下引擎会显著变慢（真机 90 倍），只在文案里**如实标注**，
  **不**按上下文长度分段建模、**不**按引擎内存压力动态修正（那需要引擎侧 KV/显存数据）。
- **`/props` 只读这一个只读端点、只认这几个字段名**：引擎不实现或字段另有其名时只能"说明未读到"，
  **不猜**；也没读 `n_ctx_per_seq`/并发 slot 数——**单条请求实际可用上下文可能因并行 slot 更小**。
- **不自动改配置、不自动重启引擎**：只告警 + 给修法。
- **15s 宽限是固定值**：未按子代理数量/历史时延自适应；只影响"父回合等子代理"这一种形态。
- **子代理进展靠回调而非"读取子代理状态"**：子代理在**单次模型请求内部**长时间无增量（本地长 prefill）
  时父回合同样看不到——那种形态仍由请求级首帧超时负责。
- **`stalled` 的界面呈现只做了 WebUI/桌面壳共用的 `src/web/app.js`**：**CLI/REPL 仍只有一行 `io.print`**，
  无额外 TUI 状态条；`desktop/**` 本轮未改动。
- **进度日志仍是 30s 一行**（沿用 v0.6.12 取舍），本轮只加了子代理字段，未做自适应频率。

## v0.6.12（2026-10-08）— 本地模型可观测性与无进展看门狗 + 模型来源标注 + 预设按语义拆分

> 补丁版，起因是**一次真机实测**而不是代码审查的推演：负责人用本地 `MLocalModel3.6.2`
> （llama.cpp，`llama-server` 常驻 32.6GB / CPU 11%）跑全量仓库审计，引擎跑了 **4 小时 30 分**，
> 而 `web-server.log` **8 小时零行**、界面只有一个「生成中」、`audit.jsonl` 里 610 次工具调用
> 绝大多数是**逐字重复**的失败调用。复核结论：**没有一次"挂住的 await"**，
> 缺的是**回合级判据**与**可观测性**——既有三个超时全是"单请求级"，
> 而一个回合最坏是 `maxRounds × stepLimit = 72` 次请求（子代理还可递归派生），
> "每十几分钟返回一次、什么都没做成"的回合可以**合法地**跑掉几小时。
> 这一版把"看起来在工作"变成"看得见、说得清、停得下来"。
> 变异验证 **17 批 183 条全中**（数字由 `scripts/doc-lint.mjs` ⑥ 守卫）。
> 逐条复现与取舍见 `docs/internal/AUDIT-v0.6.1-第三方报告登记.md` §3.54。

### 一、本地模型可观测性与无进展看门狗（A）

- **回合级无进展看门狗**（`src/agent.js`，新增 `config.noProgressTimeoutMs`，默认 **60 分钟**）：
  判据 = 连续 N 分钟**既无"成功且不重复的工具结果"、也无新的正文/推理增量**；
  **重复调用与失败调用不算进展**（真机现场正是它们）。命中即以 `stalled` 结局收尾并如实报告
  （模型轮次 / 工具调用数 / 其中多少次重复或失败），不再冒充 `done`/`capped`。
  默认取 60 分钟 = 现有本地单请求总量上限（1800s）的 **2 倍**，保证"一次慢 prefill"永远由更具体的
  请求级超时先说话；该值**关不掉**（`0`/负数/`NaN`/`Infinity` 一律回落默认）；
  子代理**继承父回合的截止时刻**（`cfg.turnProgressDeadlineAt`），一整棵树一起收口。
- **上游/引擎错误透出原文 + 可操作解读**（`describeUpstreamError`）：模板/Jinja、内存拒绝、
  三类超时、401/403/404/429/5xx 各给一条"这是什么 + 该怎么办"；识别不出时**一字不改**保留原文。
- **"0 次工具调用"必须说出来**：`perf.zeroToolCalls` 单一来源，WebUI `done.note` 直接取它——
  不会再出现"看起来在工作、其实一次工具都没调用"。
- **可观测性三件套**：发送前**规模预告**（估算本轮 prompt tokens + 窗口占比 + 生效首帧上限 +
  预检结论，≥80% 或"本地端点 + ≥60k tokens"时告警）；**TTFT 首帧时延**（界面 + `chat 首帧` 日志行）；
  运行中**进度**（阶段/模型轮次/工具调用数/已收字符/≈tok/s/正在等待哪个工具），
  `web-server.log` **每 30 秒定期落一行** `chat 进度 …`（此前只在回合首尾各一行）。
- **端点预检**（`probeEndpoint`，仅本地端点，缓存 10 分钟）：`/v1/models` 对照引擎实际加载的模型名
  （`modelNameMismatch`）；**3 次**极小请求（带工具声明、`max_tokens: 256`）判
  **稳定支持 / 不稳定（N/3）/ 不支持**，被 `max_tokens` 截断的样本判为**不可判定**（思考型模型常见）；
  另测一次**参考 prefill**（约 2000 tokens），与本机历史值比对，**≥3 倍变慢**提示"可能仍有旧请求占着"。
- **按实测自适应超时**（`adaptiveTimeouts`）：首帧上限 = `clamp(max(实测首帧×20, 参考prefill×5),
  既有默认, 1800s)`；看门狗 = `clamp(max(实测首帧×100, 参考prefill×20), 10min, 60min)`。
  **用户显式配置永远优先**（显式 > 自适应）。

### 二、模型下拉的**来源标注**（B）

- 下游环境里 Dify chatflow 的应用名混进"模型"列表、看不出是不是官方模型。核实结论（写进
  `src/model-discovery.js` 注释作为单源说明）：下拉是**配置驱动**的——自定义条目**只来自
  `config.customModels`**，`fetchProviderModels` 显式跳过 `custom`，自定义端点的 `/models`
  **从不写进 `model-cache.json`**，**不存在跨环境运行时串数据**；但此前只标 `providerLabel='自定义'`，
  看不出**来自哪个端点**。
- 现在每条自定义条目带 `source`（`custom-endpoint`/`custom-capability`）/`sourceLabel`/`endpoint`/
  `isLocalEndpoint`/`note`（`customSourceOf`），下拉**分组名本身就是来源**，例如
  「自定义端点 · dify.example.com/v1」，不再与官方模型混在一起。判据走 `resolveProviderConfig`，
  不另抄一份"哪些字段算端点声明"的键表。

### 三、内置预设按语义**拆分**（C）

- 负责人定位："本地模型只是用来代替云模型 API 而已，功能是一样的；预设的目的是预设上下文窗口/
  最大输出 tokens 等，让本地模型正常工作——它并不是专为代码审计而设。" 原内置 `local-audit`
  **一个名字扛了三件事**（本地参数 + 审计人格 + 只读白名单），名实不符。现拆为：
  - `local-model` —— 只放保守参数（`contextBudget: 65536`/`maxOutputTokens: 4096`/`maxRounds: 4`），
    **不加人格、不限制工具、不建议权限档**；
  - `readonly-audit` —— 审计人格 + 只读工具白名单 + `recommendedPermission: "readonly"` + 保守参数。
- **老名字 `local-audit` 保留为别名**（`PRESET_ALIASES` → `local-model`）：仍可用，但**会说出来**
  （CLI `console.warn` 一次 + WebUI banner，经 `aliasedFrom` 透出）；**兼容但不静默**。
  若项目级/用户级自己写了 `local-audit.json`，**以磁盘为准**（别名只在没找到同名预设时兜底）。
- ⚠ **升级须知（行为变更）**：`--preset local-audit` 现在解析到 `local-model`，
  **不再有审计人格与只读工具白名单**——此前用它做只读审计的调用点会**失去只读约束**。
  请改用 `readonly-audit`；两个预设**不能叠加**。

### 断言与变异

- `test/smoke.js` 新增 **§139**（8 组行为 + 结构断言；桩 provider **全部尊重 `signal`**，
  与真实 provider 同形，否则测的是"不会挂的假桩"）。
- `test/mutate/batch28-stall.mjs`：**26 条**，**26/26 全中**；
  `test/mutate/README.md` 变异总数 **157 → 183**。
- `test/api-contracts.js`：契约改为钉 `local-model`（**不得**带 `systemPrompt`/`tools`/`permission`/
  `recommendedPermission`，必须带保守参数与 `aliases: ["local-audit"]`）与 `readonly-audit`
  （必须带人格 + 只读白名单 + `recommendedPermission`，**不得**带 `permission`）。

### 已知边界

- **不做自动重启引擎**：预检只能提示"建议重启"，内核不会替用户杀进程；
- **预检只覆盖本地端点**（远程不预检，避免每次开聊多打请求）；
- **工具调用预检是启发式**（同一端点实测两次结论相反 2.7s / 23.9s），四态并提示后果，**不保证**一致；
- **`contextBudget` 不感知引擎内存**（65536 是本机经验值，按量化/显存自调）；
- **进度日志 30s 一行是折中**（未做自适应频率）；
- **看门狗判据依赖"成功且不重复"**：本身就要反复调用同一工具且次次成功的轮询型任务会被判"无进展"，
  这类任务请调大 `config.noProgressTimeoutMs`；
- **`recommendedPermission` 本版只透出、未接界面**（只出现在 `GET /api/presets` 的 JSON 里，
  前端无任何消费点），且**不参与判定**；只读硬约束始终是 `tools` 白名单；
- **更新包签名校验默认档未变**：无签名 → `warn-and-install`（发布链路仍未接签名步骤），
  有签名但验不过 → 一律 `reject`；严格模式需 `MINGDAO_REQUIRE_UPDATE_SIGNATURE=1`。

## v0.6.11（2026-10-07）— Pack 反向提权 + 两项「来源信任」+ 三个用户实测缺陷

> 补丁版。这一版**不是**清理版：每个条目都对应一个可复现的缺陷或一个明确的合规缺口。
> 最重的是审计 M-1 的 **P0**——第三方 Pack 的工具拿到内核 `ctx` 本身，一行改写就能让权限引擎失效。
> 另有三个**用户实测**的 WebUI 缺陷（权限模式被预设静默压过 / 停止键在等权限确认时形同虚设 /
> 内置预设写死 `permission`），以及桌面版**打包漏 `preload.cjs`**。
> 变异验证 **16 批 157 条全中**（数字由 `scripts/doc-lint.mjs` ⑥ 守卫）。
> 逐条复现与取舍见 `docs/internal/AUDIT-v0.6.1-第三方报告登记.md` §3.44~§3.53。

### 一、安全：Pack 反向提权（审计 M-1，P0）+ 两处来源信任

- **Pack 反向提权收口**：此前第三方 Pack 的工具拿到的就是内核 `ctx`——不是"能不能读文件"的问题，
  而是**能不能关掉管它的那道门**（`ctx.permission.check = () => ({allow:true})` 一行即可）。
  现在给第三方 Pack 的 ctx 做**白名单裁剪 + 冻结**（`cfg` 去掉 `providers`/`io`/`permission`/`spawnTask`/`provider`），
  分档**只能收紧**（内置 → 第三方会重建），内核 ctx 不裁剪不冻结（否则误伤内置工具）。
  回归套件 `test/pack-ctx-privesc.js`（4 组）**已接入 CI**：改写 `permission`/替换 `provider` 全部无效。
- **账本来源签名 `ledger --sign-key`（ed25519）**：哈希链 + 封条的**全部输入都来自账本自身**、算法公开——
  改 `ok:false`→`ok:true`、逐行重算 `prev`、按新末行改写封条，**不需要任何密钥**，旧 `verify` 三项逐项通过。
  即旧 verify 只回答"自写入后没被随手改过"，回答不了**"是谁写的"**。签名落在**封条**上
  （规范载荷 runId/v/total/head/at），公钥指纹 `sigKey` 写进**链内**（否则只删封条就能伪装成"历史无签名账本"）。
  默认开启、密钥 `<home>/ledger-key.json`（600、原子写、**不并进 `credentials.json`**——凭证库的
  读-改-全量重写会顺手清掉它）；`LEDGER_VERSION` **保持 1**。`verify` 四态：
  有效 → 0；**无签名（历史账本）→ 0**（升级不得把历史账本判成坏账本）；**签名无效 → 非 0**；
  **无法验签 → 非 0**（"无法确认来源"不等于通过）。`verifyRun` 的 `ok` 含义不变，来源结论另放
  `provenance`/`trusted`——塞进 `ok` 会让所有旧调用点在没读新字段的情况下改变行为。
- **桌面版更新包来源签名校验（K-8 完整版）**：electron-updater 的 sha512 只说"字节与**同一份 feed**
  的清单一致"，控制 feed 的一方两边一起换——**不构成来源信任**。客户端内置公钥（**不从网络取**，
  从网络取等于没 pin），判据是纯函数 `decideUpdatePolicy()` → `install / warn-and-install / reject`：
  **有签名但验不过一律 reject**；**无签名默认 `warn-and-install`**（发布链路还没有签名步骤，
  默认 reject 等于一夜之间掐死所有存量用户的自动更新），UI + 日志都如实写"本次更新未验证来源签名"；
  `MINGDAO_REQUIRE_UPDATE_SIGNATURE=1` 转 reject 并**同时关掉 `autoInstallOnAppQuit`**
  （否则用户点"稍后"、退出时被拒的包照样会装上）。发布侧 `scripts/update-sign.mjs` 与客户端**同一实现**。
- **IDE 插件令牌（K-9）**：改存 VS Code `SecretStorage` / JetBrains `PasswordSafe`，
  **工作区级旧令牌一律忽略**（顺带堵掉"克隆一个仓库即注入 `mingdao.port`/`mingdao.token`"），
  结果分 `ok / unauthorized / unreachable` 三态——此前"只认 200"，401 被当成"连不上"，
  用户看不到真正的原因。

### 二、用户实测缺陷：权限模式 / 停止键 / 预设覆盖

- **WebUI「权限模式」显式选择被预设静默压过**（选了「自动」仍按只读跑，不报错、无提示）：
  优先级固化为**显式选择 > 预设建议 > `config.json`**，界面显示生效档位与来源（banner）。
- **停止键在等待权限确认时形同虚设**：服务端挂在一个 120 秒等待上，停止要等它自然到点。
  现在**解除挂起确认优先于超时**；前端所有停止路径收敛到唯一出口 `stopTurn()`（失败重试 3 次 + 可见提示）；
  权限确认遮罩不再盖住停止按钮，作废弹窗不再留在界面上。
- **内置预设「本地模型审计」写死 `permission: "readonly"`**：`permission` 是**覆盖**语义，
  等于把"建议"写成了"覆盖"。改为 `recommendedPermission: "readonly"`（**建议**语义），
  `label` 改「只读代码审计（本地模型）」——只读效果本来就由 `tools` 白名单保证（里面没有 `write`/`edit`）。
  `src/presets.js` 的字段白名单收下 `recommendedPermission` 并校验取值域；
  **`presetPermissionOverride()` 的反提权语义一字未改**（老/第三方预设仍可声明 `permission`，仍只拦"变宽松"），
  但在注释里写死纪律：**内置预设不得声明 `permission`**。
  `test/api-contracts.js` 新增三条契约断言（在列表里 / 透出 `recommendedPermission` / **不带 `permission`**）。
- **桌面版打包漏 `preload.cjs` + `update-verify.js`**：两个文件进 asar 的配置补齐
  （漏 `preload.cjs` = 桌面版前端桥整个失效）；设置面板「＋ 登记工作空间」接上目录选择器
  （v0.6.8 只接了主界面那条路，设置面板此前只能手打绝对路径）。

### 三、重构与守卫（审计 P1-1 第三刀 / M-8 第一批）

- `src/tools-flow.js`（新增）：工具编排两端——**可见性判据**（只读档 / 白名单 / 已用工具 / MCP 三态 / 顺序）
  与**回填正文**（原样 / 紧凑 JSON / 复用前缀 / 约束拒绝 / 截断且前缀不计入）抽成纯函数（P1-1 第三刀；
  前两刀为 `src/cost-guard.js` 的护栏前置判据与每轮决策）。
- **M-8 结构守卫收口第一批（15 处）**：7 处"跨行源码文本匹配"改**行为化**断言、8 处加固为**单源**守卫——
  守卫自己也会腐化，"文档里写了"≠"代码里做了"。
- 新增变异批次 `batch17`~`batch27`（含 `privesc`/`perm-mode`/`stop`/`preset` 四条针对性批次），
  总数 **157**；`test/e2e-schedule.js` 墙钟断言改为**按本机实测的自适应预算** +
  **进程内确定性**断言（写死 25s 曾在 Windows 腿假红）。
- 新增英文配置文档 `docs/CONFIG.en.md`；修两处已核实的中文文档勘误。

> 升级须知与已知边界（`recommendedPermission` 未接界面、老预设仍可 `permission`、
> 更新包签名默认仍 warn-and-install、Electron 真机点击未验证、账本签名不防同权限本机对手等）
> 见 `RELEASE-NOTES-0.6.11.md`。

## v0.6.10（2026-10-01）— 公开仓库不再出现"形似密钥"的字面量

> 补丁版，**零行为变化**：只改样例的写法与测试夹具。
> 来源：下游 PR #10（已合并）+ 它对"PR #1 暴露密钥"的澄清。

下游先报了"PR #1 暴露了密钥"。查证结论：那是 `app-<24 位 base62>` 这类**占位样例**（字母表顺序拼接，
不是任何真实凭据），但在公开仓库里长得就像密钥——会被密钥扫描命中，也会让人误以为仓库漏了真钥。

- `src/redact.js`：前缀表的 `sample` 改为**运行时拼装**（`sampleOf(prefix) = prefix + 'x'.repeat(24)`），
  与 PR #10 一致（该 PR 已合并）；表驱动断言的语义完全不变。
- 其余同类字面量一次清完：`test/smoke.js`（§11 掩码期望、§54c/§71/§112/§130 的样例）、
  `test/e2e-local.js` / `e2e-web.js` / `e2e-schedule.js` 的夹具密钥 → 统一用 `FAKE(prefix, n)` 拼装；
  新增 `test/fixtures/fake-secrets.mjs` 说明为什么不能用字面量。
- `docs/internal/` 里的下游反馈归档：样例改为 `<24 位 base62>` 形态说明。
- 全仓 `grep` 已无 `(app|dataset)-[A-Za-z0-9]{20,}` / `sk-[A-Za-z0-9]{12,}` 形态字面量。

**配套（仓库设置，代码之外）**：GitHub 端已开启 **secret scanning** 与 **push protection** ——
以后真有密钥被 push 会被直接拦下，而不是等下游来报。PR #1 的正文/评论已改写为占位形式、
来源分支已删除（PR 页面本身 GitHub 不提供删除接口）。

## v0.6.9（2026-10-01）— 下游反馈的脱敏缺口 + 文档债清偿 + 变异脚手架的平台假设

> 补丁版。三件事：**脱敏器漏 Dify 密钥**（下游实测反馈 + PR #1）、**第三方 v0.6.7 文档审计的逐条清偿**、
> 以及 CI 在 Windows 上**变异验证整批假红**的根因。变异验证本批 **6/6**（累计 **47** 条，
> 数字由 `scripts/doc-lint.mjs` 守卫）。逐条复现与处置见
> `docs/internal/AUDIT-v0.6.1-第三方报告登记.md` §3.43。

### 一、脱敏器：Dify `app-` 密钥原样漏出（下游反馈）

下游在"每人一把密钥私下分发"的场景里实测：同一份日志中 DeepSeek 的 `sk-…` 被掩成 `sk-***`，
而 **Dify 的 `app-…` 原样漏出**——**半掩比不掩更危险**，贴日志的人会以为"已经脱敏了"。
影响面是审计日志、WebUI 日志、以及用户会主动贴到公开渠道的**诊断包**。

修法不止补一行：前缀表以前散在 `redactSecrets` 里的若干行 `replace`，**每接一个厂商就多一个漏点、
而且漏了不会报错**（v0.6.3 漏 PEM/JWT/赋值式，这次漏 Dify，同一句话：**"表里有规则"≠"规则认得你正在用的那种 key"**）。
现在收敛成单一来源的 **`SECRET_PREFIXES` 表**，每行 `{vendor, re, mask, sample}`；
`redactSecrets` 只是逐行替换的循环。**每行必须带 `sample`**，由 `test/smoke.js` §130 的**表驱动断言**
验证"这一行真的认得它声称认得的形态"——新增厂商忘配或正则写错，测试当场红。

- 采纳 PR #1 的判据：`\bapp-[A-Za-z0-9]{20,}`（**不含** `-`/`_`，避免误掩 `app-deployment-config-2024`）；
- 同厂商的 `dataset-`（知识库 Key）一并补上（同源扩展，已在登记文档说明）；
- **刻意不做"高熵兜底"**：熵启发会对 sha256/会话 id/base64 大量误报，而"脱敏器误伤"的直接后果是**被人关掉**；
- 边界如实写进断言：`my-app-<长 base62>` 会被掩（`\b` 在 `-` 处成立）——fail-closed，刻意取舍。

### 二、文档债清偿（第三方 v0.6.7 文档审计，1 高 3 / 中 12 / 低 9）

- **重建 `docs/ARCHITECTURE.md`**（290 行）：旧版只提到 12/88 个模块、把已发布功能写成"路线图"、
  还把内置 762KB 官方 BPE 词表的精确分词写成"启发式、无分词器依赖"。新版覆盖 **88/88** 模块 +
  数据流 + **12 条已知边界（如实）**；
- **`PROVIDERS.md` 不再教用户把 Key 写进 `config.json`**（与三处"绝不写 config"的承诺直接冲突）；
- **英文入口**：新增 `README.en.md`（定位 / 3 步上手 / **安全模型表：机制 + 边界逐行** / 命令索引）
  与英文 `SECURITY.md`（私密披露渠道、范围、8 条部署加固清单、已知边界）；语言政策写进两个 README；
- **`@stable` API 表生成**：旧表只列 32/70，且完全没有 Pack API v1 与约束引擎（下游 Pack 作者最需要的面）。
  新增 `scripts/gen-api-table.mjs` 从 `src/index.js` 生成（现 **70 `@stable` + 19 `@experimental`**）；
- **内部过程文档不再随 npm 分发**：19 个计划/评估/审计登记移到 `docs/internal/`，
  `package.json` 的 `files` 只列用户面文档（此前 `npm i -g` 会把 ~500KB 内部策略与审计散文装进 `node_modules`）；
- 其余逐条：`PACK-API` 给未实现的 `require-citation` 打标、`CONFIG` 的 Host 例外与审计轮转口径、
  README 的 CI 矩阵/模型 id/零依赖口径/目录树、`--help` 补齐 `batch`/`cost`/`pack`/`mcp`/`ledger replay`/`sync` 子命令、
  删掉仓库根那个被 commit 的 4 字节垃圾文件 `1200`、`install.sh` 不再推荐（且**运行期拒绝**）`curl … | bash`、
  新增 `CONTRIBUTING.md`/`CODE_OF_CONDUCT.md`/issue 模板/PR 模板/dependabot；
- **新增文档守卫 `scripts/doc-lint.mjs`（8 项，已接入 CI）**：相对链接、子命令覆盖、PACK-API kind、
  模型 id、**ARCHITECTURE 是否覆盖全部 src 模块**、变异总数、API 表一致性、只读工具集合。
  报告只建议"加两个守卫"，这里做了 8 项——上面每一条漂移都能被机械判定，留给人肉复查才是浪费。

### 三、变异脚手架的平台假设：Windows 上整批"变异点未找到"

v0.6.8 的 Windows 腿红的**不是产品**，而是第 13 步的变异验证：4 个批次 7/8、6/10、9/10、12/13，
原因清一色 `变异点未找到`。根因：多行锚点用 `'\n'` 拼，而 Git for Windows 默认把工作树检出成 CRLF
→ `includes()` 永不匹配（单行锚点全过，相关系数 100%）。

- `test/mutate/lib.mjs`：匹配前做行尾归一化，**还原时写回原始字节**（跑完工作树 sha256 不变）；
  `suite()` 的临时目录改用 `os.tmpdir()`；`run.mjs` 增加行尾归一化自检（删了它任何平台当场红）；
- 仓库级配套：新增 **`.gitattributes`（`* text=auto eol=lf`）**。本仓测试与文档守卫大量按 `\n`
  匹配源码文本，CRLF 检出已**四次**造成假红，钉死 LF 是这一类的根治。

## v0.6.8（2026-09-30）— v0.6.7 审计收口（外圈质量洼地）+ 桌面版目录选择器

> 补丁版。来源：第三方 v0.6.7 审计报告（50 项：1 严重 / 9 高 / 22 中 / 18 低）与文档专项报告，
> 以及负责人在桌面版实测后提出的交互要求。报告对项目缺陷模式的总结值得原样引用：
> **「检测能力很强，收口环节偏弱」**——检测到**局部**事实后升级成**全局**结论。
> 本版按「局部失败 → 局部影响」逐条收口；变异验证 13/13（本批累计 41 条）。
> 逐项复现见 `docs/internal/AUDIT-v0.6.1-第三方报告登记.md` §3.42。

### 一、K-1（严重）：hook 的"载荷是否送达"判据不可靠 → Windows 上合规 hook 被误拦

`src/hooks.js` 用 `child.stdin` 的 `'finish'` 事件判定"载荷已交给内核"，注释还写着"这个判据不依赖事件先后"。
实测它在 **Windows 命名管道上不可靠**：Node 24.14.0 下 40 次复现 **0 次通过**（24.21.0 才 40/40），
于是「载荷已送达」被误判成「未送达」→ 任何读 stdin 的合规 hook 在大文件写入时都被拦，
测试/发布链路在 Windows 上断裂。

现在改用**可计量的证据**：写入回调（**必须判 `err`**）交付的字节数 ≥ 载荷字节数。
本机探针：300KB 载荷下读 stdin 的 hook 收到 **307,296 字节 = 我们发出的字节数**并放行；
不读 stdin 的 hook 明确 `block`（理由 `write EPIPE`）。
顺带修掉一处 fail-open——Node 的写回调**出错时也会被调用**，不判 `err` 会把 EPIPE 当成送达成功。

### 二、K-3/K-4（高）：一个坏字节毁掉整段输出

严格 UTF-8 解码一抛错就把**整个缓冲区**按 GBK 重解：一个被截断的多字节序列或网络噪声字节
（0xFF）能让 360KB 合法中文全部变乱码（报告实测 `输出.includes('测') === false`）。
现在分层：严格 UTF-8 成功即用；失败时看**首个非法字节之前**的合法多字节序列数（≥2 → 非致命 UTF-8，
坏字节只影响自己，输出里 1 个 `U+FFFD`）；否则才按 GBK 解（Windows `cmd.exe` 输出仍然正确）。
断言改为**逐字保真**（比"含某个字"强：整段按 GBK 解时 300 字里可能碰巧命中）。

### 三、K-5/K-6/K-7（高）：三道能"假绿"的质量门禁

- **K-5**：V8 覆盖率数据里的 `file://` URL 用 `replace('file://','')` 解路径——Windows 上留下 `/D:/…`，
  分母恒为 0，脚本打印 `0%（0/0 行）`。改用 `fileURLToPath`；且**分母为 0 即失败**（数据采不到 ≠ 覆盖率低）。
- **K-6**：未加载的文件此前被**直接从分母剔除**——"少测一个文件"反而让覆盖率更好看。
  现在分母 = `src/**/*.js` 全部文件，未加载的按 0 计入并逐个列出。
- **K-7**：strict 棘轮走 `npx tsc`——`npx` 会去网上找 `tsc` 存根，**工具缺失被算成 0 错误**。
  改用仓库内 `node_modules/typescript/bin/tsc`，缺失即 exit 1。
- **M-6**：变异脚本的切片边界取"文件里第一处收尾标记"（可能在节之前 → 空切片 → 生成的脚本
  一条断言都没有，变异验证变假绿）。改为**本节之后的第一个节头**，并断言切片里必须有实质断言；
  同时把**变异套件接入 CI**（报告点名的欠账：「发布说明写 28/28，但 CI 从不跑它」）。

### 四、K-2（高）：IDE 插件的命令注入

- **JetBrains**：`sh -c "nohup ${s.binary} web ${s.port} >/dev/null 2>&1 &"` ——binary 里填
  `x; rm -rf ~ #` 就是一次真实命令注入（Windows 分支经 `cmd /c` 同样会被再解析）。
  改为 argv 数组直接 `ProcessBuilder(binary, "web", port)` + 输出丢弃，注入面归零。
- **VS Code**：`getConfiguration('mingdao').get('binary')` 会返回**工作区级**的值，而工作区级设置来自
  被打开仓库的 `.vscode/settings.json` ——恶意仓库填 `"mingdao.binary": "./payload.sh"`，
  用户点一次「启动服务」就执行了仓库自带的程序。现在只读 `inspect().globalValue`（用户级），
  并拒绝工作区内的相对路径，`spawn` 显式 `shell: false`。

### 五、K-8 的两处廉价部分 + 桌面版目录选择器（负责人要求）

- 窗口内导航此前放行 `http://127.0.0.1:` 的**任意端口**（本机常有别的服务），现在钉死到本窗口端口；
  外链 `openExternal` 此前不校验协议（`file:`/`smb:` 会被交给系统），现在限 http(s)。
- **登记/添加工作空间时弹系统原生目录选择器，默认停在当前用户家目录**：
  新增 `desktop/preload.cjs`（contextBridge **只**暴露 `pickDirectory`/`isDesktop`）+
  `ipcMain.handle('mdh:pick-directory')`（`dialog.showOpenDialog`，`defaultPath = os.homedir()`）；
  前端优先用原生选择器，浏览器场景回退内置弹窗且起点同样是家目录；
  `/api/fs-browse` 不带 `dir` 时默认家目录并在响应里带 `home`；弹窗新增「🏠 用户目录」按钮。
  **踩到并修掉一个真坑**：`desktop` 是 `"type":"module"`，而 `sandbox: true` 下 Electron 不支持 ESM preload
  —— preload 必须是 `.cjs`。

### 六、桌面版实测日志的读法（负责人提供）

`~/Library/Application Support/mingdao-desktop/logs/mingdao.log` + `~/.mingdao/logs/web-server.log` 显示
v0.6.7 在真机上是好的：自动更新已到 0.6.7、4 个回合正常完成（含 17–43 分钟的本地长任务）；
唯一一条 `网络请求失败：fetch failed` 是模型端点瞬时不可达——`isTransient` 命中后已退避重试 2 次
（1s+2s，与日志里 3 秒的窗口一致）后如实报错。**这不是丢数据**，但错误信息不够可操作（第三批登记）。

## v0.6.7（2026-09-30）— 三份 v0.6.6 审计报告收口（出网单一口径 / 账本与计费诚实性 / 安全面中危 + P3 速修）

> 这一版**只做正确性与安全**，零新功能。内容是三份第三方报告（全量代码审计、第六轮复审、
> 安全与质量审计）的共同头号发现与其 v0.6.7 建议范围。三份报告独立地把
> 「**同一规则多份实现 → 最弱的那份说了算**」指为本项目安全缺陷的唯一共性根因——
> 本版的四个批次正是按这条根因收口。
> 每批走「**先复现 → 定级 → 修复 → 回归断言 → 变异验证断言本身**」；
> 变异验证脚本首次**入库**（`test/mutate/`，报告一 S-3② 的欠账：此前"7/7"是手工过程，谁也复现不了），
> 本批累计 **38 条**变异全部被抓到（其中 3 条曾被指出是"假绿"，已收紧后重验）。
> 逐条复现与机制核实见 `docs/internal/AUDIT-v0.6.1-第三方报告登记.md` §3.41。

### 一、出网收成一条管道（报告一 C-1/H-1、报告二 P2-2、报告三 P1）

- **`fetch` 工具此前自己维护了一份更弱的 SSRF 实现**：DNS 复检的 catch 是**放行**（fail-open）、
  校验用 `lookup()` 而连接由 undici **再解析一次**（DNS rebinding 窗口）、元数据只按主机名判。
  而 `safe-fetch.js` 早在 BUG-057 就把这三条修好了（fail-closed + 把已校验 IP **钉给连接层** + 逐跳复检）
  ——只是没同步到 fetch 工具。`fetch` 属只读免确认工具，提示注入经网页内容即可触发完整攻击链。
- 现在：新增 `src/ssrf-guard.js` 作为**判定与钉扎的单一来源**（IPv4/IPv6 全形态、IPv4-mapped、
  NAT64、zone-id 与解析不出的形态一律 fail-closed），`runFetch` 整条走 `safeFetchText`，
  `tools/fetch.js` 只保留工具契约并再导出**同一个函数对象**。
- **出网闸门盲区**（报告三 M1）：`safe-fetch` 走 `node:http(s)`，完全绕过只钩 `globalThis.fetch` 的闸门
  ——「skill 下载 / registry 拉取 / 模型发现」三条自动出口既不受 block 拦截也不进出网账本。
  现在 net-guard 暴露 `guardEgress()`，safe-fetch 每跳显式过闸 + 记账（与 `sync.js` 的既有做法同款）。
- **`fetch(Request, init)` 静默降级成空 GET**（报告二 P2-3）：带 `{signal}` 的常见写法会丢掉
  method/body/headers → 现在逐字段合并，服务端收到的是 POST + 正文。
- **跨 origin 只剥三个头**（报告一 M-4）→ 改**反向白名单**：没被点名的头一律不跨源
  （`x-api-key` 这类自定义凭据头此前会原样送给重定向目标）。

### 二、账本与计费诚实性（报告一 H-3/H-4/M-10、报告二 P2-1、登记 §3.39①）

- **账本结局口径分裂**（报告二 P2-1）：`runEnd` 在 finally 里拿不到返回值，只能用 `finish` 重算，
  于是跑满步数时返回值 `capHit:true` 而账本记 `done/capHit:false`；`'max_steps'` 是**死条件**；
  截断方向还反向分裂。现在 runTurn 内只有一个 `outcome`，所有出口写它、账本与返回值都从它取。
- **费用护栏读失败当 0**（报告一 H-3）：此前经宽松读取（`catch → []`），"文件存在但读不出来"
  被当成今日 ¥0 → 护栏放行且无告警。新增严格读取：ENOENT 是 0、"读不出来"是 **null**（护栏降级 + 告警）。
- **usage 缺失记 ¥0**（报告一 H-4）：网关不回 usage 时这回合在账上"不存在"，三档护栏全部失明。
  现在记 `cost:null + usageUnknown`、账本带 `usageUnknown` 字段、护栏给出"今日 N 次用量未知"的可见提示。
  **「未知」绝不等于「0」**。
- **Batch 通道**：失败/取消/超窗/轮询失败四条路径此前**一条记录都不写**（账单在涨、账上没有这笔），
  现在记「用量未知」；且 Batch 提交前**也要过费用护栏**（block 档直接拒绝，服务端零请求）。
- **降级不是免检通道**：`action:'downgrade'` 此前完全不看在途费用（单回合可烧穿日限），
  现在换上便宜模型后按同一口径复查，仍超限即停。

### 三、安全面中危（报告一 H-2/H-5/M-1/M-2/M-3/M-5）

- **脱敏器不认带引号的键**（`{"api_key": …}`、`{'api_key': '…'}`）→ 明文进审计日志与诊断包。已修。
- **凭证写用宽松读**：`credentials.json` 损坏时，一次 `init` 或 WebUI 设 Key 就会**清空其余全部凭据**。
  现在写函数内置严格读、损坏即拒绝写，且三个入口把失败**说出来**。
- **deny 拆段**补上命令替换/子 shell/`
`/续行；`denyStrict` 下 `sh -c '…'` 这类包装执行**直接拒绝**
  （deny 规则看不穿参数里的真实命令）。
- **bash 子进程 env 词表**与脱敏器共用同一来源——此前漏了 `key` 段，`OPENAI_KEY`/`GITHUB_KEY`
  会原样透传（一条 `env` 就进模型上下文）。
- **ReDoS 判定单一来源**（新增 `src/regex-safety.js`）：约束引擎此前只看嵌套量词，
  `(a|aa)+`、`(a|a?)+`、`((a|ab)x)+` 装载即通过（实测 28 字符可卡死进程）；grep 另有一份不完整实现。现在三处共用。
- **`workspaces set` 存未归一化路径** → 登记一个合法目录后把符号链接改指向 `/`，围栏整体塌陷（登记 P1-21 的 set 入口）。

### 四、P3 速修与测试基建

- `redactDeep` 对象键数无上限（10 万键对象拖慢每次写账本）、`/memory add` 裸 `appendFileSync`
  （0644 且无日期戳）、worker 的 ask 判定漏对象形态 `{mode:'ask'}`、`pack new` 写进**不在发现路径**的
  `cwd/packs`、自定义 Provider 模块按 `Date.now()` **无限重载**（ESM 缓存按 URL 计）、
  `clampText` 裸 slice 可切出半个代理对、schedule **锁内**做同步 `ps`/`killTask`（持锁数秒 → 等锁方超时）、
  share-accept 的会话文件写在**锁外**且非原子写、会话 id 同秒碰撞静默覆盖。
- **变异验证入库**：`test/mutate/`（`node test/mutate/run.mjs`）。这是报告一点名的欠账：
  「项目在发布说明里写变异验证 7/7，但全仓没有脚本，**谁也复现不了**」——与项目自己
  「守卫必须可回归」的要求不一致。现在每批一个脚本，条目写清「改坏什么 → 期望哪条断言抓到」。

## v0.6.6（2026-09-23）— 补丁版：Windows 测试门禁收口（bench 静默空转 / 调度接管延迟 / 软链用例假失败）

> 这一版**只做正确性**，零新功能：内容来自第三方对 v0.6.5 的技术评估报告 §4.1–§4.3。
> 三处都是同一形态——**CI 五腿全绿，但在标准 Windows 账户上跑不起来**，也就是"门禁本身在真机上是空的"。
> 每处都走「**先复现 → 定级 → 修复 → 回归断言 → 变异验证断言本身**」，变异验证 **7/7**
> （把每处修复逐个改回缺陷，断言当场失败）。
> 逐条复现结论与机制核实见 `docs/internal/AUDIT-v0.6.1-第三方报告登记.md` §3.40。

### 一、bench 的 214 条断言在 Windows 上从不执行（评估 §4.3）

- `test/run-all.mjs` 是 `npm test` 与 `npm run coverage` 的入口。Node ≥18.20.2 / 20.12.2
  （CVE-2024-27980 那批修复）起，**spawn `.cmd`/`.bat` 而不开 shell 会同步抛 EINVAL**；
  此时 ChildProcess 根本没被创建，`child.on('error')` 永远收不到，Promise 直接 reject →
  汇总器崩溃，前面套件的失败详情与汇总表一起丢失。后果：**bench 五套（214 断言，含"省钱只降不升"
  的基准回归）在 Windows 上从未运行过**。
- 为什么 CI 是绿的：run-all 的唯一自动化入口 `npm run coverage` 只在 **Linux + Node 20**
  那条腿上跑，Windows 腿从不执行它。
- 修复：win32 给 spawn 加 `shell: true`，并把同步启动路径包进 `try/catch`（记为套件失败，
  不崩汇总器）。该失败模式只在 Windows 出现（POSIX 上 spawn 不存在的 `.cmd` 是异步 ENOENT），
  本机无法行为级复现，故补**源码级守卫**（§125）并如实标注验证层级。

### 二、被接管后旧 daemon 最坏 60s 才退出（评估 §4.2，主审复现）

- `every` 型任务的等待是**一整段** `min(max(nextRunAt−now, 1s), 60s)` 的 sleep，期间不查租约。
  探针实测（`--every 60s` + 预热 5s 让 sleeper 进入等待片，再篡改 pidfile 租约）：
  **旧 daemon >40s 仍存活**；修复后同一探针 **4.0s 退出**。虽然不会双跑（唤醒后才查租约），
  但这 60s 窗口里新旧 daemon 会交错操作同一批调度状态——它同时是 e2e-schedule 租约用例
  在标准 Windows 账户上确定性失败的根因（用例只等 20s）。
- 修复：`every` 与 `once`（**同一处缺陷的第二个入口**，报告只点了 `every`）都改走
  `waitGuarded(…, 3000)`——≤3s 切片、逐片复查租约，最坏接管延迟 60s → **≈5s**
  （监督轮询 2s + 一个等待片 3s），语义不变（睡够才继续）。

### 三、软链用例把"没抛错"当成"建出了链接"（评估 §4.1）

- 未开开发者模式/非管理员的 Windows 上（Node 通常抛 EPERM；某些受限或沙箱文件系统会
  **静默把建链请求降级成普通文件**），`try { fs.symlinkSync(...) } catch {}` 只判"抛不抛错"
  ——于是用例实际测的是"读/写一个普通文件"，断言必然失败；而 CI runner 有管理员权限能建真链，
  所以长期是绿的（v0.2.5 的 `%TEMP%`⊂`%USERPROFILE%` 是同一类事故）。
- 修复：新增 `makeRealSymlink()` 能力探测（建链后用 `lstat().isSymbolicLink()` **复核**），
  替换**全部 6 处**软链用例（报告只点了 2 处）；建不成显式打印「⚠ 跳过」，绝不假装测过。
- 反向自检（§125）：`test/smoke.js` 里再出现裸 `fs.symlinkSync` 即测试失败。

### 四、围栏判据平台无关化（评估 §4.1 后半，采纳其建议）

- `withinRoot(root, target, depth, io = fs)`：导出并支持注入 fs 实现。
- 新增 `test/smoke.js` §124：用桩 fs 覆盖 **悬空指向围栏外（拒）/ 悬空指向围栏内（放行）/
  链接成环（有界拒，断言 readlink 调用 ≤20 次）/ 新建文件（放行）/ 根与子路径（放行）**
  ——**任何平台都跑**；另加探测器自身的桩测试（静默降级 / 真建成 / EPERM 三种环境）。
  符号链接围栏是安全边界，**不该由"机器有没有开开发者模式"决定它是否被验证**。

### 五、流程补强

- `docs/RELEASE-CHECKLIST.md` 新增 §1.3「Windows 实机验收」：**在未开 Developer Mode 的普通
  Windows 账户上 `npm test` 必须全绿且产出汇总表**，并写明两次"CI 绿而实机红"的事故与成因。

## v0.6.5（2026-09-22）— 补丁版：三条越权链收口（悬空软链写逃逸 / `pack info` 执行未信任代码 / 改 API 地址外带 Key）

> 这一版**只做安全**，范围由负责人指定：独立审计报告（8 名审计员、58 项发现）里**唯三的
> 越权／任意执行链**，外加把这三条钉死的回归断言。其余发现按报告 §10 的优先级排队，
> **不在本版范围内** —— 补丁版的价值就在于"可整包升级、风险面收敛"，掺进功能修复就失去这个性质。
> 审计报告本体随交付提供（含 55 项**尚未修复**的问题，故不随仓库发布）；
> 已修部分的机制、复现与变异验证记录在 `docs/internal/AUDIT-v0.6.1-第三方报告登记.md` §3.39。
> 四条修复都走「**先复现 → 定级 → 修复 → 回归断言 → 变异验证断言本身**」，
> 变异验证 4/4 全部被抓到（把修复逐个改回去，断言当场失败）。

### 一、悬空符号链接可以把写操作送出工作目录围栏（P0-1，主审已复现）

- `withinRoot()` 用 `realpathSync` 归一后做前缀比较，而 `realpathSync` 对**目标不存在**的链接抛
  `ENOENT` —— 旧实现于是回退到"只比较字符串路径"，判定**链接本身**（而非它的目标）在工作目录内并放行；
  随后 `writeFileSync` **跟随链接**把文件建到围栏之外。实测：工作目录里放一个
  `link.txt -> /tmp/out/created.txt`（目标不存在），`write link.txt` 返回成功且围栏外文件真的被创建。
  同一条路径 `read` 会被拒 —— 读写判定不一致，不是设计取舍。
  可覆盖 `~/.ssh/authorized_keys`、`~/.zshrc`、`~/.mingdao/config.json`，`auto` 档下无人工闸门。
- 修复：`realpathSync` 失败时不再"上跳一级猜"，改判 `lstatSync` —— 是符号链接就 `readlinkSync`
  解析目标后**递归**判定，并加 16 层深度上限（链接成环**有界返回 false**，不再可能无限解析）。
- 断言同时钉住反向用例：**悬空但指向围栏内**的链接必须照常可写 —— 修复不能退化成
  "凡悬空链接一律拒绝"，否则会误伤"先建链接、后建目标"的正常工作流。

### 二、`pack info` 执行未信任 Pack 的代码（P0-2，主审已复现）

- v0.6.2 修"clone 一个仓库 → 跑个子命令 → 任意代码执行"时，把信任门加在了 `mountPacks` 这条路径上，
  `pack list` 也会正确显示「⛔ 未信任（不挂载）」并给出 trust 指引 —— 但 `pack info`
  （帮助文本第 15 行主动推荐它）直接 `loadPack` → `import pack.mjs`。
  于是"换个子命令就能执行"：未信任第三方代码以**完整 Node 权限**在同进程跑（可读
  `~/.mingdao/credentials.json`、可出网）。
- 修复：`info` 分支在 `loadPack` 之前判 `found.gate`（与 `mountPacks` 同口径），未信任则打印
  「为什么（完整 Node 权限）+ 怎么办（`mingdao pack trust <目录>`）」并以非 0 退出。
- 断言钉住三点：未信任不执行、拒绝理由要点明"未信任"、**显式 trust 后必须恢复可用**
  （门挂在信任状态上，不是"永远拒绝"）；另外钉住"信任后内容一变即失效"的既有语义。

### 三、改 API 地址＝把已存储的 Key 交给谁（P1-20，主审已复现）

- `setBaseUrl` 是**凭证级操作**，但旧实现只校验地址格式不看凭证：回环绑定（默认）下
  `validateRemoteUrl` 的私网校验**整段跳过**，任意调用方（无令牌模式下＝同机任意进程）
  三步就能把**已存储的完整 API Key** 骗到自己的端点：① `POST setBaseUrl` 指向
  `http://127.0.0.1:<攻击者端口>/v1` ② 任意一次 `/api/config` 清 provider 缓存 ③ 触发一次对话。
  实测攻击者端点收到 `Bearer sk-victim-FULL-SECRET-…`。而 `GET /api/models-config` 只回脱敏 Key
  （`sk-vic…3456`）、凭证文件 0600、`~/.mingdao` 0700 —— **这条链把三层保护一起绕过**；
  且改动是持久的，受害者后续每次对话都继续把 Key 发给攻击者。
- 修复：新增 `endpointChangeGuard()` —— 该 Provider **已有存储 Key** 且本次改动会改变目的地
  `origin` 时，必须在同一请求里重新提交该 Key（SHA-256 摘要比对），否则返回 `{needKey:true}`；
  WebUI 收到 `needKey` 后用隐藏输入提示补输并自动重试一次。
  判据是"**目的地变了**"而不是"字符串变了"：同 origin 只换路径（本机模型 `/v1` → `/v2`）照旧放行，
  该服务商本来就没有 Key 时也不受任何影响（没有可外带的秘密）。
- **同类第二个入口一并收口**（修复期间新发现，主审复现）：「修改」已有自定义模型
  （`updateCustom`）同样会把该模型已存 Key 发往新地址 —— 实测攻击者端点收到
  `Bearer sk-victim-CUSTOM-KEY-…`。它用的是同一个 `endpointChangeGuard`；
  `addCustom` 不需要这道门（它的 Key 来自同一请求，没有已存秘密可被劫持）。
  这条回归断言是**行为级**的：先断言正常端点真的收到了 Key（证明这条链平时是通的，
  而不是"因为链坏了所以没外带"），再断言改向被拒后攻击者端点**0 次访问**。

### 四、验证与边界

- 新增 `test/smoke.js` §123（220 行断言），覆盖上述四条 + 反例保护 + 环状链接有界返回；
  变异验证 4/4：把每处修复逐个改回缺陷，断言当场失败。
- **如实声明边界**：`test/` 里钉住的是**行为级**链路（起真实 WebUI + 真实凭据文件 + 打桩端点），
  但 UI 交互本身（补输 Key 的弹窗）在无浏览器环境下只能做**源码级**断言，已在断言里标注层级。
- 本版**未**处理的相邻项（避免"看起来修完了"）：同一"改端点即外带凭证"的类别里，
  `workspace.js` 的符号链接"注册后改指向"（报告 P1-21，审计员复现）仍按原样存在 ——
  它是另一个机制的同类越权，已列入报告 §10 的下一批第一项。

## v0.6.4（2026-09-21）— 第三方审计九批收口（凭据 / fail-open / 合规空转 / 数据损失 / Web / 供应链 / 并发 / 计费）

> 这一版**不掺新功能**：内容是 v0.6.1 三份第三方审计报告与 v0.6.2 自审报告的**收口修复**（九批）。
> v0.6.3 发布说明「已知边界」里列的那批条目，大部分在本版处理掉了。
> 每批都按「**先复现 → 再定级 → 修复 → 回归断言 → 变异验证断言本身**」推进；
> 复现记录、被推翻的报告结论与自我更正逐条写在 `docs/internal/AUDIT-v0.6.1-第三方报告登记.md`（§3.28–§3.35）。

### 一、凭据暴露面（批一）

- **凭证库损坏后静默清空其余凭据**（实测复现，本批最严重）：`loadCredentials()` 把「文件不存在」
  与「解析失败」都当成 `{}`，而 key 的写路径是「读 → 改一条 → 全量重写」——截断一个字符后再
  `key set`，**其余凭据全部消失且打印成功**。新增严格读取（区分 ENOENT 与损坏，并容错
  PowerShell 写的 BOM：那是可解析的，不该被当成损坏而永久拒绝写入）；三个写路径读不出来即
  **拒绝写**并退非 0，原文件原样保留供人工抢救。
- **会话/记忆/任务文件 0644 且正文含明文密钥**（同仓账本/审计/凭据早已 0600，同模块两套口径）：
  新增 `appendFilePrivateSync` / `atomicWritePrivateSync`（创建即 0600 + **每次写补 chmod 自愈**，
  因为 mode 只在创建时生效），落到 session / memory / cachestats / workspace / session-index /
  schedule / tasks / ledger 共 10 处；相关目录补 0700。
- **会话原文不脱敏就上传云同步**（自动同步默认开启，粘贴过的密钥会明文上传）：
  推送前过 `redactSecrets`——本地文件保持原样，远端与其它设备只拿掩码版；
  并把「上传前已脱敏」的会话数告诉 CLI 与 WebUI。
- **脱敏器自身漏了 PEM / JWT / 赋值式**（不补上，上面两条就是虚假安全感）：赋值式改为
  **按名字分段判定**（`_`/`-` 分段后任一段是密钥词即掩码），覆盖 `AWS_SECRET_ACCESS_KEY=`、
  `MY_TOKEN_V2=`、`x-api-key:`；补 PEM 私钥块、JWT、GitLab `glpat-`；同时反向断言「不误伤」
  （普通中文、`max_tokens: 4096`、JSON 配置、`monkey=` 一律不动，`Bearer <token>` 只掩 token）。
- **自建 registry 允许明文 http**：索引里的 sha256 与正文**同源自证**，TLS 是这条链上唯一的
  外部信任锚 → 非回环的 http 与其它协议一律拒绝（回环仍允许，便于本地开发）。

### 二、安全 fail-open（批二）

- **预设「未提权」分支把 `allow`/`deny` 整体丢掉**（实测）：`{mode:'auto', deny:['fetch:*']}`
  配预设 `permission:'readonly'` → 只读档下 fetch 禁令**静默消失**，方向是**放宽**权限，
  与该函数「只能收紧」的意图相反。改为对象进对象出（只改 mode，保留 allow/deny）。
- **hook 载荷写失败被当成「空输出 = 放行」**（实测）：v0.4.6 为防崩溃加的
  `child.stdin.on('error', () => {})` 只吞不报，而本模块把空输出当放行 → 本该拦截的策略静默通过。
  收口为「**载荷没送到且 hook 无输出 → 按 hook 失败处理（fail-closed）**」；若 hook 仍给出
  输出（它本就没打算读 stdin）则尊重其判定，避免误伤。
- **completeness 的「缺失」哨兵只认中文「未提及」**（实测）：英文/多语种会话里模型写
  `not mentioned` / `N/A` / `unknown` 判不中 → **必填项红线因为语言而静默停止生效**。
  改为保守的多语种哨兵集合并支持约束自声明 `missingValues`；**刻意不含 `无`/`none`**——
  医疗等域里「过敏史: 无」是有效数据，当缺失会误拒。
- **deny 的「硬拦截」——先纠正报告的前提**：报告称「deny 命中后按 y 仍可放行」与文档矛盾。
  核实：**不矛盾**，`docs/CONFIG.md` 明确写着「同意即放行」（v0.4.6 有意加的"不再静默拦截"）；
  与文档不符的是**代码注释**。故不推翻文档化行为，改为三件事：① 新增 **`denyStrict: true`**
  显式选择硬拦截；② 放行提示**点名命中了哪条规则**（知情同意）；③ 注释与文档对齐。
- **`mcpEnvFilter=false` 会把整机凭据交给每一个 MCP 服务器**（多为 npx 拉来的第三方进程）：
  核实**默认是过滤**（未发现默认关闭路径），不改显式配置，改为**一次性告警**点明后果
  并指向更窄的 `mcpEnvKeep`，同时加断言锁住「默认必须过滤」。

### 三、合规静默失效（批三）

共同形态是「不报错、不崩溃，只是主打能力实际空转」。

- **约束事件无 `id`**：账本（`agent.js`）与回放（`replay.js`）两个消费方都读 `id`，
  而 `event()` 只产出 `constraint` → 每次被红线拦下，「是哪条红线拦的」**恒为 null**。补 `id`。
- **`confirm` 从不求值**：它是 `KINDS` 成员、能过装载校验、会计入 `size`（于是 `active=true`），
  却落进 output 桶被 `kind !== 'output-forbid'` 跳过。改为真正求值：权限放行之后仍走
  `io.confirm`，答否或拿不到交互通道（`-p` / 调度 / 子 Agent）一律阻断；回放无交互通道，
  单列 `confirm-required` 如实报告而不是静默算通过。**连带自查出顺序陷阱**：`confirm` 与阻断类
  同轮求值会让「`confirm` 写在 `tool-deny` 之前」遮住 deny → `checkPreTool` 改为两遍，
  先阻断类再 confirm；`packs.js` 同时要求 `confirm` 必须带 `tool`（不带则恒不命中 = 永不生效的红线）。
- **CLI 回放恒假阴性**：命令分发发生在挂 Pack 之前 → 约束恒空 → `ledger replay` 恒报
  「没有任何生效的领域约束」，当 CI 门禁时**恒通过**。replay 分支按启动路径同口径挂 Pack。
- **`--json` 恒失效**：布尔开关是取值型解析、写在末尾取不到值 → 恒走人读分支。
  布尔开关与取值型参数分开解析。
- **失败路径退 0**：`diagnose` 的 `[错误]`、`ledger` 的非法 runId / 找不到账本 / 未知子命令、
  `key` 与 `net` 的未知子命令统一退 1（报告点名的 `update.js` 经复核**不成立**，
  那是子命令劫持防护的设计行为）。

### 四、静默数据损失（批四）

共同形态是「没有报错，数据就是少了一部分」，都发生在并发或多进程场景。

- **配置「读不出来」被当成「没有配置」**：改坏一个字符后跑 init / 桌面首启，
  `customModels` / `mcpServers` / `sync` / `net` / `costGuard` 会被全新对象**整文件覆盖且不备份**。
  新增 `readConfigStrict()` + `quarantineCorruptConfig()`（改名备份而不是覆盖 + 明确告警），
  CLI 向导与桌面首启前先隔离；顺带修掉「带 BOM 的合法 JSON 被误判为损坏」与
  「同秒两次隔离时备份互相覆盖」。
- **手动 `/compact` 用追加落盘**（文件近乎翻倍、`-c` 恢复后历史重复），而自动压缩走的是
  原子重写——同一件事两套口径，统一到重写。
- **压缩后不清读取去重缓存**：正文已被摘要替换，缓存仍说「你看过」→ 模型只拿到占位串。
  压缩成功路径与 `/compact`、`/clear` 都清缓存。
- **费用明细追加在锁外**：A 追加 → B 追加 → A 锁内读到含 A 的快照并替换，B 那一行被覆盖；
  追加与轮转收进同一把锁。
- **审计日志轮转窗口吃行**（审计是合规证据，丢一行等于证据链有洞）：与 cachestats 同法。
  Web 日志跑在请求路径上，加同步锁会引入阻塞 → 改为**改名式轮转**（整文件 rename + create
  语义），没有读-改-写窗口因此不需要锁。

### 五、Web 攻击面（批五）

- **符号链接逃逸（P0-3，实测复现）**：围栏只做 `path.resolve` 前缀比较，而 `statSync`/`readdirSync`
  **跟随符号链接** → `ln -s / <家>/escape` 即可任意目录枚举，再 `POST /api/workspaces` 登记
  就让 Agent 的 bash/write/edit 整体跑到围栏外。改为按 **realpath** 判定，且**目标与允许根
  两边都归一化**（只归一化一边会误判合法目录，macOS `/var`→`/private/var` 即是实例）；
  目标不存在时回退到最近存在祖先；直接访问链接路径也 403。报告的另一半（readdir 不过滤链接条目）
  实测**不可利用**（`Dirent.isDirectory()` 对链接本就是 false）——已在注释里如实写明，
  不把它当防线，断言也换成能真失败的那条。
- **回环绑定整段跳过 SSRF**：元数据端点改为**无条件拒绝**（`isMetadataHost` 单一来源，
  `allowPrivate` 也不放行）；刻意**不采纳**「CGNAT 段无条件拒绝」——100.64/10 正是 Tailscale
  地址段，无条件拒绝会打断真实自托管用法。
- **无令牌 + GET 有副作用可被跨站盲打**：引入 `Sec-Fetch-Site` 判定，cross-site / same-site
  一律 403（覆盖 `<img>`/no-cors 盲打，含「读取即删除」的 `GET /api/draft`）；
  Origin 校验扩展到所有方法。**不采纳**「回环也强制令牌」（桌面版本就随机生成令牌，
  强制会让 CLI 日常用法每次回终端取令牌），改为启动横幅明说「本机信任模式」并如实登记残留。
- **自定义 Provider 名穿越 import**：`provider: '../evil'` 原本可 `import` 目录之外的模块
  （`path.join(providers, name + '.mjs')`）→ 名字白名单 + 路径包含性检查，
  非法名退化为「没有自定义模块」，并用「恶意模块放在 providers/ 之外」端到端验证其未被执行。

### 六、供应链（批六）

- **`pack verify` 会执行被审代码**：帮助文本写「只做静态校验」，实现却无条件 `loadPack` →
  `import pack.mjs`。下游 CI 拿它当门禁，等于**以完整 Node 权限执行被审仓库的任意代码**。
  新增 `loadPackStatic()`（manifest / 兼容窗口 / 声明文件 / `pack.mjs` 存在性，全程不 import），
  `verify` 默认静态，要执行必须显式 `--runtime` 且先警告。
- **未信任的项目级同名 Pack 能把内置版本静默顶掉**（而它自己又不挂载 = 两边都没生效）：
  未信任 tier 不再参与遮蔽，同名冲突变成启动告警；已信任的遮蔽同样可见。
- **项目级预设按名静默遮蔽内置/用户级**（可注入 `systemPrompt`/`tools`）：不改变遮蔽语义，
  但命中时打印含两份路径的告警。
- **git 安装器**加形态白名单（只收 `https`/`ssh`/`git`/`git@host:path`），
  `file://` 与本地路径明确拒绝。
- 技能库 sha256 与索引**同源自证**，不宜擅自改成签名制——改为安装后如实说明这条边界。

### 七、并发与长驻（批七）

- **同步服务的写锁没有 `await`** → 临界区异常变 `unhandledRejection` → 整个同步服务退出。
  补 `await` + try/catch 留痕，并加**扫描式守卫**（任何未 await 的调用行即失败）。
- **锁外读快照、锁内整份写回**：revoke 后并发 accept 会把 `shareId` 写回（分享复活）；
  改密时锁外删设备会让已吊销 token 复活。改为锁内重读 / 整体持锁。
- **调度 `markRunning` 把 `runnerPid` 写成自己**，而恢复判据是「该 pid 是否存活」→ 恒真
  → 任务永久卡 `running`；宿主死了但 worker 还活着时又会重排 → **同一任务跑两遍**。
  加「宿主即自己」例外 + worker 存活则不重排 + 协程异常留痕。
- **锁陈旧回收只看 pid 存活**，**pid 复用**会让锁僵死：锁内记入口脚本名，回收前用
  `pidOwnedBy` 复核身份（读不到命令行时维持原判据）。
- 避峰长等待按 **≤60s 切片**，每片复查租约。

### 八、计费与可用性（批八）

- **非幂等重试导致重复计费**：`chat` 是 POST，上游一旦开始生成就按量计费，而重试只看
  「错误是否瞬态」——流式空闲超时（已开始输出）也会重试 → **用户看到一份回答、账本记两次**。
  改为「收到过任何一帧就不再重试」；代价（已开始输出后不再静默重试）如实写进注释与登记。
- **重试循环头部复查总量护栏**（原来只在 catch 里看，退避期间超时仍会再发一次）；
  **退避 sleep 接 signal**，Ctrl+C 立即中断（原来最长干等 30s）。
- **`compactTrigger` 只夹下限不夹上限**：写成 >1 会让自动压缩**永久失效**；上限夹到 1 并告警。
- **降级回合按 `modelName` 计价** → 与实际调用的模型单价差数倍，「降级省钱」反而看不出来；
  改用 `activeModel`。
- **上游提前关流**（无 `[DONE]`、无 `finish_reason`）标 `truncated` → 界面提示 + 账本标记 +
  回合结果 `upstreamTruncated`（刻意不复用既有 `truncated` 字段，那个含义是「兜底总结失败」）。
- **content-type 被网关改写成 `application/json`** 时按内容嗅探回退，正文不再整段丢失。

### 九、上游能力与文档（批九）

- **skill 安装器的临时目录清理**原先只在「校验失败」这一条早退上删，中途抛异常就留下整个目录
  → 收进 `finally`；`readSkillMeta` 返回 null 时给可读错误而不是 `TypeError`。
- **检查点文件名可 `../../` 穿越**到目录之外 → 加包含性检查（`path.relative` 必须落在
  `taskstates/` 内），非法会话名如实返回失败。
- **`--auth-token` 写在命令行会进 argv / `ps` / shell 历史** → 支持 `--auth-token=-` 从 stdin 读，
  字面量令牌给出明确告警并指向环境变量。
- **P3 文档漂移**：`pack verify` 静态/`--runtime`、目录围栏 realpath 语义与规范路径契约、
  本机信任模式与令牌三来源、跨站请求 403、元数据端点无条件拒绝、`compactTrigger` 0–1
  逐处对齐，并**加断言钉住文档**（文档回退即失败）。

### 工程侧收尾（不影响使用）

- 界面文案：右侧面板与详情的 **9 处用户可见字符串**「子代理」→「子 Agent」；
  代码注释与标识符一律未动（`sessionSubs`/`curTasks`/`subLabel` 等）。
- 两处跨平台测试夹具修正（Windows CI 红）：符号链接逃逸用例改用**平台相关且真实存在**的目标
  （原写 `path.sep + 'usr'`，Windows 上不存在 → realpath 回退到最近存在祖先，护栏被绕过）；
  源码级正则断言容忍 CRLF。**教训**：在「文本」上断言，就要按各平台的文本形态写。
- hook stdin 失败用例改为**确定性触发**（关闭 fd0 + 存活 300ms），并消除「判据依赖 error
  事件到达时机」的跨平台竞态；Linux 上原载荷 200KB 会被 AF_UNIX 发送缓冲整个吞下
  （"写不完"这个事实没被暴露），提到 4MB。
- 修 `loadPackStatic` 的 JSDoc 返回类型（`tsc` strict 棘轮曾因此 13 条超基线）。

### 验证

- `smoke` **148 组断言**、`e2e-local` / `e2e-web` / `e2e-schedule` / `api-contracts` /
  `bench` 全通过；`tsc` 0 错误、strict 棘轮 **0/0**；CI 五腿（ubuntu 18/20/22 + macOS + Windows）全绿。
- 每一批都用**变异验证断言本身**：批一 7 / 批二 5 / 批三 9 / 批四 8 / 批五 8，其余批次逐条同类验证。
  被如实记录的失败情形包括 **3 处等价变异**（删掉那行断言照旧全绿，说明它本就不是防线）
  与若干处「断言第一版抓不到变异」（收紧后重验才算数）。

### 已知边界（如实说明）

- 仍有 **15 处**同步文件锁在极端争用下会阻塞其所在进程——已核实不在 WebUI 请求路径上
  （`schedule` 在守护进程内、`sync` 是 CLI 一次性命令、`cachestats` 仅在 >4MB 轮转时），
  且列成受审阅清单（新增即测试失败）。**不宣称"阻塞面已彻底消除"。**
- 账本**可选签名**（`--sign-key`）仍未实现：封条只提升到「防误删/漏写」，
  **不等同审计级不可否认**，这一点已写进导出物。
- `audit-report.md` 里其余约 15 项只有**代号**（明细需逐条复现），`B-CS-1` 记为
  「部分落实」——**不宣称穷尽**。

> 版本标注说明：这九批改动在开发期按 `v0.6.3/批一…批九` 标记（提交信息与部分源码注释仍是该标记），
> 但 v0.6.3 已于 2026-09-15 发版，因此它们**实际随 v0.6.4 发布**；
> 用户文档（`docs/CONFIG.md`、`docs/PACK-API.md`）中的「v0.6.3 起」已按实际发布版本更正。

## v0.6.3（2026-09-15）— 下游与桌面版的三个卡点（域内指令拿不到工具 / bash 乱码 / vision 门控）

> 这一版不掺新功能，只修**下游与桌面版实际被卡住**的三件事，外加两项工程侧收尾。
> 三项都是"本来该能用却用不了"，且用户看不出原因——所以优先打包发出来。

### 一、域内任务拿不到工具（下游实测：只读档挡住了「回访」）

原实现要求**命中写意图关键词**才给全量工具，否则整回合只读档（write/edit/bash 对模型**不可见**）。
而域内任务用的是**开集**动词/名词——回访、排班、盘点、对账……永远枚举不完。
下游实测：「请生成回访看板」命中"生成"→ 能用；**「回访」不命中 → 工具不可见 → 高频入口直接废掉**。
更糟的是释放条件（"模型文字里出现写意图"）也等不到：工具看不见时模型只会答一段话，根本不进第二轮。

已修（不做关键词堆砌，那是对着开集打补丁）：
1. **判定方向反转**：只有"看起来是纯提问 **且** 无写意图"才进只读档，其余一律全量工具；
2. **域内 Pack 在场时永不进只读档**——这类部署的价值在"任务能做"，不在省 schema token；
3. **自愈**：只读档若以纯文本收尾且透出"做不到/需要…"，放开工具集重试一次（与词表无关，只放一次）。

> 代价说明：非提问的普通消息现在也走全量档，那部分轮次的输入 token 会上升（刻意取舍：能力 > 省 token）。
> `config.schemaTier=false` 仍可整体关掉。

### 二、桌面版 bash 输出乱码（两处独立根因）

| 根因 | 机制 | 修法 |
| --- | --- | --- |
| **逐块解码** | 采集时把 Buffer **逐块** `toString()`：3 字节汉字被管道切成两半，两半各自解出 `�` | 按 Buffer 累积、结束时**一次**解码 |
| **Windows 代码页** | Windows 上 bash 工具走 `cmd.exe /d /s /c`，输出是 OEM 代码页（中文 = GBK/936），按 UTF-8 解就是花屏 | 严格 UTF-8 失败时用 **GBK** 再解一次 |

顺带修两处同类问题：按字节裁剪会把 UTF-8 从字符中间切断 → 严格解码失败 → **误走 GBK 回退反而花屏**
（这是修复过程中被单测抓出来的自身缺陷），现已"裁剪后对齐字符边界"；`tail()` 的截断不再劈开代理对。

### 三、vision 门控不认自定义 Provider（下游 Dify 工作流已支持视觉）

原门控只看"内置预设 `supportsVision`"或 `customModels.<名>.vision`，于是**自定义 Provider
（Dify/网关适配器）永远被判不支持图片**；而为了让门控通过去写 `customModels`，又会把
provider 解析**劫持**到 `custom:<模型名>` 的 OpenAI 兼容直连——**自定义 Provider 模块被整个绕开**，
请求发去了 `baseUrl` 而不是适配器。一句话：「打开一个能力开关」不该改变「请求发给谁」。

已修（两条都做，覆盖两种表达方式）：
1. `customModels` 条目分两类：含 `baseUrl`/`apiKey`/`envKey`/`headers`/`path`/`kind`
   → **声明式端点**（原行为不变）；只含能力字段 → **纯能力覆盖，不改变 transport**
   （其中 `provider` 只作路由提示，可指向自定义模块）；
2. 自定义 Provider 模块可**静态声明**：`export const supportsVision = true`
   或 `export const capabilities = { vision: true }`；门控统一走 `resolveVisionSupport`
   （显式声明 > 内置预设 > Provider 静态声明 > 保守 false），只读静态导出、按 mtime 缓存。

附件被拒时的文案改为给出**三条**正确做法；`docs/PROVIDERS.md` 补「声明能力」一节与对照表。

### 工程侧收尾

- **文件锁的阻塞面**：新增异步锁 `withFileLock`（等待时让出事件循环），WebUI 请求路径上的
  `workspace`（7 处锁）已迁移；临界区里不再做外部进程调用；同步锁等待上限依实测从 20s 收到 **5s**
  （实测最坏临界区 6ms）。残留 15 处同步锁已列受审阅清单，新增即测试失败。
- **发布校验脚本**：瞬时网络失败不再误报「四平台未对齐」（加三次有界重试，
  并区分「取不到」与「真的不一致」）；发版清单里那条会把 token 写进 ssh argv 的命令已改正。

**诚实边界**：文件锁仍有 15 处在极端争用下会阻塞其所在进程（不在请求路径上，已列清单）；
三份历史第三方报告与一份 v0.6.2 自审报告共有约 **60 条**待处理条目（凭据暴露面、fail-open、
并发与长驻稳定性等），本版**未包含**，正按优先级分批推进。

## v0.6.2（2026-09-14）— 第三方审计欠账清算（26 批）+ 四平台发布纪律固化

> 本轮把三份第三方报告的**可执行条目**按 `docs/internal/AUDIT-v0.6.1-第三方报告登记.md` §5 的优先级清完，
> 共 **26 批**、42 个提交。每一批都要求：**先复现 → 再定级 → 修复 → 回归断言 → 变异验证断言本身**。
> 过程中两次推翻自己的结论（把"未发现缺陷"改成"确有缺陷"、把一处"已设防"改成"可被绕过"），
> 也多次抓出**自己写的假绿断言**——这些过程都记在登记表里，没有抹掉。

### 两处最严重（均为实测复现，不是推测）

- **registry 索引名可清空用户家底（B-SR-1）**：安装技能时，拼路径用的是**索引里的 name**，
  而校验的是**下载文件里的 frontmatter.name**——两个独立输入。入口那道
  `^[A-Za-z0-9_.-]+$` 看着像白名单，**却允许 `.` 与 `..`**：
  `{"name": "."}` 让 `rmSync` 递归删除**全部已装技能**；`{"name": ".."}`
  实测**清空整个 `MINGDAO_HOME`**（配置/凭据/会话/账本全没）**且返回安装成功**。
  索引是网络内容且不在任何哈希覆盖范围内（文件的 sha256 是**对着索引**校验的）。
  已修：入口先校验索引名 + 安装目录改用校验过的 frontmatter 名 + 底层兜底校验（三道）。
- **账本"尾部截断"查不出来（A-LG-1）**：旧 `verifyRun` 只比对链内 `prev`，
  而删掉尾部若干行（含 `run.end`）后链内**完全自洽**——实测「只留前 3 行」照样报 `ok:true`。
  而尾部截断恰恰是最常见的形状（部分写入、误删、随手截断）。
  已加**封条侧车**（`<runId>.seal.json`：应有条数 + 链头哈希）：条数少了报截断、多了报追加、
  末行链头不符报尾部改写；**没有封条时不再谎报完整**，而是明确警告。
  命令层同步收紧：`mingdao ledger verify` 对"链内一致但完整性未知"**退出码 1**（行为变更）。

### 一类系统性问题：写入失败却报告成功

对合规物与用户数据而言，这比"少一个文件"严重得多——**用户被告知成功**。
本轮把这一类**穷举后**逐个处理：账本（`ledger`）、任务检查点（`task-state`）、
费用明细（`cachestats`）、会话索引（`session-index`）、工作空间注册表（`workspace`）、
守护进程 pidfile（`schedule`）、项目记忆去重（`memory`）、审计日志（`audit`）。
其中 `schedule` 的 pidfile 写失败会让 `daemonAlive()` 永远为 false → **每次调用都再拉起一个守护进程**
→ 同一批定时任务被并发执行多次，**正是那段锁注释要防的 P0 被静默重新引进门**。

关键手段不是"这次仔细点"，而是**把穷举固化成测试**：一个全仓扫描器找出所有
「`catch` 里不打日志、不抛、不返回，而 `try` 块含写操作」的位置，与一份**已审阅白名单**比对——
白名单每处都写明"为什么可以吞"。新增一处或数量变化，测试**立即失败**。

### 其余修复（按类别）

- **安全/注入**：约束 pattern 的灾难性回溯（实测 `(a+)+$` 对 29 字符耗时 **4786ms**，
  一个 Pack 就能让内核卡死）→ 装载期拒绝嵌套量词并给出具体原因；SSRF 逐跳复检收成
  `safe-fetch.js` 单一来源；出网闸门保留 `Request` 的方法与正文（不再静默降级为 GET）；
  能力声明与实现一致（deny 按段匹配、git 缩写前缀双向拦截）；诊断包结构脱敏 + 0600。
- **崩溃/资源**：`process.stdout.write` 的 EPIPE 此前会**带堆栈崩溃**（`mingdao … | head -1`
  这种最常见的用法正好命中）→ 新增 `installPipeGuards()`，CLI 安静退出 0、常驻服务静默降级；
  文件锁陈旧判据改看持有者 pid（消除 15 秒死区，并不再误抢活锁）。
- **静默失效**：词表读失败**终生锁死**（一次失败后永远走启发式估算，误差可达 ±2 倍，且无声）
  → 改为有界重试 + 一次性说清后果；默认模型名单一来源（旧名不再让自动路由静默失效）；
  自启文件按格式转义；MCP 预设区分目录/文件参数；启动日志轮转改按**文件大小**触发
  （此前用进程内计数，对 CLI 永远是死代码）。
- **注入面**：项目记忆注入围栏加固（伪造闭合被中和、零宽字符剥掉、声明为数据非指令）；
  `io.print` 统一过滤终端控制序列（OSC/清屏必剥、SGR 保留）。
- **发布链路凭据（D-REL-1/2）**：`publish-mirror-releases.sh` 此前把 token 当 **ssh argv** 传给
  服务器、还把那一行**连明文一起回显**，gitee 的 token 又写在 URL 查询串里——
  三条泄露路径同时存在（上传跑几小时，argv 就挂几小时）。改为经 **ssh stdin** 落到
  `umask 077` 的临时文件、**读后即删**，两个平台都改用 HTTP 头鉴权
  （gitee `Authorization: token …` 已实测：真 200 / 假 401 / 匿名 401）。
  同时补上**内层脚本从未被送达到服务器**（回显的运行命令其实跑不起来）。
- **发布纪律固化**：新增 `scripts/verify-release.mjs`，把「四平台（GitHub + Gitee + GitCode + npm）」
  从口头约定变成**发版最后一步的自动校验**——git refs、Release、npm 版本与 dist-tags 逐项核对，
  任一缺失即退出非 0。

### 处理方式上的一条经验

**「库里有函数」不等于修好**。本轮多次遇到"修复只做了一半"：
只加校验而后面的破坏性操作没挪、只改库而命令层还在说反话、
只修一处而同类还有九处。因此现在每处修复都要求：
**接线（调用点）+ 断言（含对照组）+ 变异验证（把守卫拆掉必须让测试变红）**。

## v0.6.1（2026-09-12）— 厂家改名后模型选不了也计不了费（补丁版）

- **DeepSeek 把 `deepseek-v4-flash` 改名为 `deepseek-flash`**（依据：`GET /v1/models` 现只返回
  `deepseek-flash` 与 `deepseek-v4-pro`），而内核里「设置界面用动态名单、切换接口只认静态表」
  两处不同步 → 应用自己列出来的模型选不了（报「未知模型」并弹回旧模型）。
  已修：切换接口接纳动态发现的模型（拦任意字符串的护栏仍在），并把 `deepseek-flash` 补成一等公民
  （含上下文上限与**价格**——否则费用会退化成「无法估算」）；旧名保留以兼容老配置与历史会话。
- 工程侧：修 e2e-web 挑端口落在 Linux 临时端口范围（32768–60999）导致 `EADDRINUSE` 的偶发 CI 失败；
  官网 `/updates/` 的 macOS feed 由 dmg 改为 **zip**（electron-updater 的硬性要求，对已装 0.6.0 的用户即时生效）。

## v0.6.0（2026-09-12）— 合规与确定性（确定性③）

> 落地计划与滚动进度见 `docs/internal/PLAN-v0.6.0.md`。目标：给定一次历史执行，能离线回答并证明
> 「每一步做了什么、触发了哪条规则、花了多少钱、数据有没有出网」，且结论可脱敏导出供第三方复核。

- **内网 / 信创部署（C4）**：`install.sh --offline`（Linux/macOS）与 **`install.ps1 -Offline`（Windows）**
  两侧对齐，均支持**完全断网**安装（不下载 Node、不走 npm、
  直接软链；本项目运行时零依赖），已用「屏蔽 curl/wget/git/npm + 代理指向黑洞」实测通过；
  `scripts/build-offline-bundle.sh` 产出带内网操作说明与校验值的离线包。新增 `vllm` / `ollama` /
  `oneapi` 预设覆盖国产推理栈（昇腾 MindIE、海光 DCU、寒武纪等以 vLLM 为后端的栈）与内网聚合网关。
  **本机/内网端点免除「必须有 API Key」的硬校验**（这类端点通常不校验也不发密钥，此前会把私有化部署
  挡在门外），公网端点仍必须有 Key；无 Key 时不再发空的 `Authorization` 头（部分网关会因此 401）。
  顺带修掉 `install.ps1` 的同类版本判断缺陷：此前只看 major（`-lt 18`），于是 18.0–18.16 被判合格，
  而内核 `engines` 要求 ≥18.17——用户会拿到「装得上、跑不起来」的安装（POSIX 侧修过同类问题 T23，Windows 侧漏了）。
  诚实登记：离线模式不支持 `mingdao update` 自更新，离线包不含 Node 运行时。
- **出网白名单 + 出网自证（C3）**：新增 `config.net`（`allow` 支持精确主机 / `*.子域` / IPv4 CIDR，
  `mode: warn|block`）与 `mingdao net report|policy`。出口只在一处收口——包 `globalThis.fetch`，
  而不是逐个改调用点（出网点分散在 Provider / fetch 工具 / 技能库 / 模型发现 / 定价 / Batch，
  逐个改既易漏、也会随时间漂移）。记账写 `~/.mingdao/net.jsonl`，**只记主机/端口/判定/命中规则，
  不记请求体与完整 URL**；启用后每个回合的账本里也会出现 `net.egress` 事件。回环（localhost/127/::1）
  始终豁免——它出不了本机，本地模型场景不该被当外发；私网不豁免，需显式列入。
  **未配置 `net` 时闸门完全不安装**，既有行为零影响。`sync.js` 自签名证书走 `node:https` 会绕过
  全局 fetch，已显式过闸。**诚实边界**：只覆盖内核自己发起的请求，用户在 bash 里自己敲的 `curl`
  不走这里——它证明「内核没有偷偷外传」，不等于「这台机器绝对没有外传」。
- **执行账本（C1，进行中）**：新增 `src/ledger.js` 与 `mingdao ledger list|show|export|verify`。
  一次回合一个账本文件（`~/.mingdao/ledger/<runId>.jsonl`），统一记录**八类事件**：
  回合开始 / 模型轮次 / 工具调用 / 工具结果 / 约束触发 / 权限决策 / 费用 / 回合结束。
  **不改造 `audit.jsonl`**——后者有 20000 行截断（回放会缺段，被静默截断的合规账本比不记账更糟）
  且只记工具调用，粒度不足以回答「这个结论是怎么来的」；`mingdao audit` 行为不变。
  两条不可让步的纪律：**写入即脱敏**（明细先过密钥规则再落盘，不留「先存明文靠导出兜底」的口子）
  与**摘要替代原文**（`argsDigest`/`resultDigest` = sha256 前 16 位，可比对、可防篡改、不泄露内容）；
  约束事件只记「哪条约束/什么时机/如何处理」，**不回显命中原文**（否则账本自身成为泄露渠道）。
  导出时在密钥规则之上再叠加私网 IP + 家目录掩码；无价模型落 `priced:false` 与「无法估算」，
  绝不写 `¥0.0000` 冒充免费。每行以 `prev` 串成**哈希链**，`ledger verify` 能发现改行**与删行**。
  诚实边界：哈希链只能证明「自写入后未被改动」，**不含可信时间戳**，不等同于审计级不可否认。

## v0.5.0（2026-09-11）— 垂域 Pack 契约 v1（约束确定性 + 成本确定性）

定位升级：从「省钱 Coding Agent + 开放内核」→ **可私有化的垂域智能体内核**（详见 `docs/internal/STRATEGY-0.5.md`）。
本期落地上游与下游之间的正式契约：垂域团队**不改内核源码**即可把领域工具、领域红线、领域提示词、领域费用接进内核。
决策已确认：v0.5 做确定性①约束 + ②成本；③行为确定性（执行账本/可回放/合规导出）放 v0.6.0。

- **Pack API v1（契约冻结）**：`pack.json`（manifest）+ `pack.mjs`（contributions）。三级遮蔽发现（项目 > 用户 > 内置）+ `config.packs` 声明；manifest 严格校验（未知字段/版本窗口/保留名/权限/贡献项），错误信息可操作；极简 semver 按 npm 语义（`^` 对 0.x 锁 minor）；挂载**幂等**；**坏 Pack 只告警、不阻塞启动**。契约见 `docs/PACK-API.md`，变更史 `docs/internal/CHANGELOG-PACK.md`
- **约束引擎（确定性①）**：领域红线从「提示词里的一句话」升级为**内核强制**——`tool-deny` / `tool-arg-require` / `arg-forbid` / `output-forbid` / `completeness` / `confirm`，三个时机（调用工具前 / 工具返回后 / 正文输出前）强制执行，命中写审计。**fail-closed**（求值异常按阻断处理）；**零约束时三处检查点全部惰性**（对既有行为零影响）。输出约束在**回填会话历史之前**生效，避免违规措辞被当既成事实喂回；`block`/`block-and-rewrite` **不回显**命中措辞
- **成本确定性（②）**：`ctx.llm()` 统一模型出口——Pack 内模型调用复用内核 Provider 解析/重试/超时/能力表，usage 并入当前回合 → **今日费用 / 缓存命中率 / 峰谷 / 日费用护栏同时生效**（对照：垂域层此前把调用写在 Provider 里，usage 硬编码 0，完全不计费也不触护栏）。新增 **Pack 归因记录**（`cost=null` 标记，与回合级总账不重复计费）与 `mingdao cost --by pack` 分账视图；Pack 级预算 `budget.dailyYuan` + `action`（block/warn）在调用前拦截
- **领域提示词段**：`promptSections` 注入系统提示（预设/记忆/技能之后），按 `order` + `pack/id` 确定性排序，**字节稳定不破坏前缀缓存**
- **CLI**：`mingdao pack list / verify / new / info`；`pack verify` 为静态校验（不 import 代码）→ 可直接作**下游 CI 门禁**；`pack verify` 对「Pack 自建模型调用（fetch 且不用 ctx.llm）」给出静态告警（先剥注释，防脚手架模板注释掩盖真实调用）
- **内置中立示例** `packs/example-hello/`（1 工具 + 1 输出红线 + 1 提示词段）；随 npm 包与桌面版分发，并有静态护栏断言
- **文档**：`PACK-API.md`（v1 冻结）/ `internal/PLAN-v0.5.0.md`（落地计划与进度）/ **`MIGRATION-DEYI-v0.5.md`（下游回迁指南）**；README 增「垂域 Pack」小节；`DEVELOPER.md` 增 Pack 章节
- 测试：smoke 81→**86 组断言**；6/6 套测试全绿 · tsc 0 错误 · strict 棘轮 0/0 · 三平台 CI（Ubuntu 18/20/22 + Windows + macOS）全绿

> 下游衔接：按决策「v0.5.0 发布即迁」，`Deyi-TCM-Harness` 的 3 个域工具从 `providers/dify.mjs` 的 `chat()` 搬进 `pack-tcm`，
> 并让 `mingdao pack verify` 进下游 CI。迁移前域内调用硬编码 `usage: 0`（完全不计费），迁移后进入 `cost --by pack`。

## v0.4.6（2026-09-11）— 迁移 macOS 后首次全量审计：P0 费用护栏盲区 + 50 项根因修复 + 省钱口径自纠

- **省钱口径自纠（重要）**：`bench-savings`「综合省 64%」系虚高，真实值 **51%**——④Schema 瘦身 / ⑤只读阶段此前用**启发式**计数去测「面向 DeepSeek 的省钱主张」（工具 Schema 是 JSON，结构字符占 46%，两种计数偏差 1.1–1.8 倍），且 ⑤ 的基准里维护了一份**过期 6 工具副本**（实现的只读档自 v0.4.4 起已含 `task`）。两项改用随包官方词表**精确**计数、只读档集合从 `agent.js` 单源导出，并新增类别化断言防止再次虚高；真实值 ④48.9%（1145→585）、⑤28.9%（1145→814）。`docs/SAVINGS-BENCHMARK.md` 与 `docs/internal/STRATEGY-NEXT.md` 同步修正
- P0 费用护栏盲区：`effectivePricing` 在读 `pricing.overrides` **之前**就因无内置价返回 null → gpt-5/qwen/glm/kimi/本地/动态发现模型全部 hasPricing=false、estimateCost=null、cost 记 null（当 0 累计）→ 今日费用看不到消费、护栏永不拦截；而护栏给出的补救办法恰是这条不生效的路径。现 overrides 与内置/外部价等价作为来源，并要求仅靠 overrides 供价时 input+output 均为有限正数
- P1 安全 ×5：**WebUI 权限确认可被任意客户端代答**（`/api/permission` 从不校验 ask id，而 taskId 是顺序号且 `/api/tasks` 全量列出 → 任何能访问 API 的一方都能替他人挂起的写文件/执行命令确认答「允许」，绕过默认 ask 档唯一人工闸门）· **任意环境变量外泄**（自定义模型 `envKey`+`baseUrl` 均用户可控，密钥解析把宿主任意变量当 Bearer 发到攻击者端点，不填 envKey 还回落主密钥）· **SSRF 绕过**（URL 解析器把 `[::ffff:127.0.0.1]` 规范化成 `[::ffff:7f00:1]`，旧判定只认点分四段 → 可抓回环 WebUI/内网/云元数据）· **`deny` 规则 fail-open**（防 allow 提权的白名单字符校验被同一函数用于 deny，命令含 `& ; | @ = ' "` 即失配，auto 档下 deny 形同不存在）· **sync-server 限流可用随机查询串绕过**（桶键用含 query 的 `req.url` 而路由用 pathname）
- P1 正确性 ×8：**`git` 工具 100% 失效**（`await execFile` 非 thenable → 输出恒 `[object Object][object Object]`、退出码/ENOENT/timeout 全被吞）· **`edit` 静默写坏文件**（`$&`/`$'`/`$$` 被当替换模式）· **read-after-write 命中旧缓存**（写后再读返回写前内容，模型误判写入未生效）· **自动压缩吞掉整段会话**（`compactTrigger<0.6` 或 force 时除 system 外全部压成摘要，WebUI 还会永久写回会话文件）· **`reasoning_content` 不计入预算**（思考型会话低估 61 倍）· **冲突备份对产品不可见**（producer/consumer 文件名正则不一致 → 「冲突三选一」100% 失效，且备份被当普通会话推送到其他设备变成幽灵会话）· **hooks/MCP 子进程 stdin 无 error 监听**（载荷 >64KB 且子进程先退出时 EPIPE 未捕获异常带走整个进程）· **步数上限兜底总结被静默丢弃**（长任务终端只看到一屏工具调用、没有最终答复）
- P1 费用 ×2：**子代理 token 从不并入父回合**（CLI/REPL 恒漏计，README 主推的「多方向并行调研」漏计最重）· **启发式计数并非其自称的「保守上界」**（纯标点低估 3 倍、单字母词/随机字母数字 2 倍 → 非 DeepSeek 模型预算/压缩/批量预检系统性偏小）
- P1 打包 ×2：**`skills-lib/` 未随 npm 包与桌面版分发**（README/官网主打的「36 个技能」在两条主分发渠道只剩 14 个，失败还被 try/catch 静默吞）· **桌面版版本漂移**（`desktop/package.json` 停在 0.2.0，而 README 教用户的 `dist:linux|win|mac` 不跑同步 → 本地打包产出 0.2.0）
- P2 安全/健壮性：预设提权防护对**对象形态** `{mode,allow,deny}`（文档推荐写法）失效（只读档可被静默提权为 ask）· 点击劫持防护缺失（`frame-ancestors` 不支持 meta 标签而服务端未下发 HTTP 头）· 审计日志泄漏 URL 内嵌凭据 · `config.tools` 子进程不筛敏感环境变量 · `undo` 越界回落回滚**无关文件** · hook `matcher` 不支持文档写明的 `|`（策略钩子永不触发）· `grep` ReDoS 可绕过（`(a|aa)+$` 同步回溯 >180s 冻结整个进程）· `fetch` 上限在整包下载后才判（实测写满 30MB 才报错）· 深嵌套 MCP schema 抛 RangeError · `SSH_AUTH_SOCK` 被误剥离致 git-over-SSH 失效 · TLS 静默降级
- P2/P3 成本与平台：**峰谷单价按落账时刻判定**（跨 12:00/18:00 边界错记一档）· **cache-stats 轮转丢当天费用**（日费用护栏被静默重置）· **日界/避峰时区错位**（`beijingToDate` 硬编码 UTC+8，而 `beijingParts` 用可配置时区 → 覆盖 `pricing.timezone` 后错 12 小时）· Batch `--max-cost` 对无价模型静默失效 · `maxOutputCeiling`(384K) 只定义不生效（README 的「单次输出上限 384K」拿不到）· **macOS 自启必然静默失败**（plist 用裸命令 `mingdao`，launchd 极简 PATH 找不到，且从不 `launchctl` 注册）→ 改绝对路径 + 注入 PATH + bootstrap/bootout · 日志轮转写放大（达上限后每次追加整文件重写，2000 次 ≈1GB I/O；中文日志因字节/码元混用几乎不截断）· CI strict 棘轮排在 `npm ci` 之前空转假通过（tsc 缺失被当成 0 错误）
- 测试与工程：smoke 74→**81 组断言** · bench 208→**214 断言** · 全绿门禁 + strict 0/0 + tsc 0 错误；**并修正两处「测试自身编码缺陷行为」**——smoke 曾断言 `git status` 在非 git 目录**成功**（只有坏实现才成立）、tokenizer 断言锁定旧口径，二者都会让回归测试反过来保护 bug
- 官网（独立仓库）：论坛板块名未转义进列表页 `<h2>`（存储型 XSS）· 反代下限速按 `127.0.0.1` 聚合成全站共享配额 · `deploy.sh` 漏部署 `site-stats.mjs`
- 审计方法与剩余项：六路并行只读审计 + 独立复核，逐项给出 `file:line` 与复现证据；完整报告见 `docs/internal/AUDIT-v0.4.6.md`（含 14 项登记待办与「已确认无问题」清单）

## v0.4.5（2026-09-07）— 费用护栏根因修复 + 本地模型 507 中断根治 + 调度/CLI/安全收尾

- P0 费用护栏：`estimateCost` 无价返 null（0 与「未知」语义分离）+ `costGuard` 显式 `noPricing` 告警，不再静默当「没花钱」；`recordUsage` 记录 null 成本（覆盖内置/外部/overrides 三来源）
- P0 任务锁与 kill：`withFileLockSync` 可重入（killTask 持锁二次抢锁自死锁 5s）；schedule pause/remove 的 killTask 包 try/catch；非 Linux（无 /proc）kill 降级为按 pid 存活即杀
- 调度器 pause 语义：标记 running / once-after 终态 / skipped / offpeak note / runOnce 元数据五处状态写全部「加锁 + 复查 paused」，执行期间 pause 不再被覆盖（every 已有防护，once/after 补齐）
- MacBook 本地 507 根治：parseStream/parseNonStream 识别 200 里夹带的 error 对象（memory_refusal）并上抛；agent 507 直结合回合透出降级提示（不计空轮、不空烧续写）；isLocalBaseUrl 补 /etc/hosts 复检 + customModels.local/isLocal 显式本地档（mtplx 自定义主机名不再误判远程）
- SSE [DONE] 后有界排空（捕获尾帧 usage 又不挂网关）；readBody close→499 释放 inflight 槽
- CLI `--model` 贪婪解析修复（后台/定时指定模型不再被顶层剥除、文本含 init 不误触发向导）
- worker 判 capHit（跑满步数上限判 failed）；every 崩溃恢复经 postRunStatus 重排回 pending
- git 只读工具拒绝 `--no-index`/`--output`/`-D`/`-f`/`-m` 等越界/破坏性参数；技能目录拒绝符号链接（lstat + containsSymlink）
- memory/pricing 整写改原子写；子代理 onUsage 透传；task(readOnly) 自动放行；fetch 重定向死代码；onUsage 带模型名归属

## v0.4.4（2026-09-07）— macOS 熄屏断连根治 + 审计可用性 + 技术评估修复

- macOS 长任务 network error 根治：生成期 `powerSaveBlocker('prevent-display-sleep')` 防熄屏（熄屏/Idle Sleep 中断 Chromium 网络栈是最终根因）；SSE 异常日志 JSON 化（此前 Electron 落 [object Object]）；统一中断续跑提示
- 审计可用性：`task` 工具加入只读档（审计/调研只读长任务可派 readOnly 子代理）；`recordUsage` 改逐轮入账（长任务期间「今日费用」实时累计、中断不丢）
- 技术评估 6.x：fs-browse 先 path.resolve 消解 `..` 段（中危）；MCP 子进程环境变量过滤（中危）；调度器 resume/once/after 状态写加锁；hooks spawn detached 整组清理；工作空间注册表原子写；附件文本上限按字节数

## v0.4.3（2026-09-06）— 正确性收尾（审计修复 + network error 诊断）

- network error 诊断闭环：渲染层 SSE 异常补全量诊断日志（此前静默中断零日志）；服务端断连日志区分「正常收尾 vs 客户端中途断开」；「网络错误」兜底改为可操作提示（检查点已保存，发「继续」续跑）
- 审计 P1×3：WebUI 自启 100% 失效（spawn 目标改 cli.js web）；sync-server 内容落盘锁内原子写；skill 安装 spawnSync→异步 spawn（不再冻结事件循环）
- 审计 P2×6：installFromUrl SSRF 防护（CLI 显式 URL 放行内网）；pricing ttlDays 初值 bug；cachestats 轮转加文件锁；autoTitle 独立 try/catch；--format json 输出纯净；孤儿 tool_calls 清理
- 低成本 P3×5：家目录脱敏边界、预设 name 字段遮蔽、IPv6 本地判定、hook 环境变量过滤、sandbox 空串归一化
- 项目简称 MDH 写入 README（自 v0.4.3 起统一使用）

## v0.4.2（2026-09-06）— 预设下拉体验修复 + 本地模型长任务 507 截断缓解

- Agent Preset 下拉：桌面版打包补 `presets/` 目录（此前漏打包致内置预设恒空、下拉无可选）；预设下拉接入自绘 tooltip（悬停秒现，不再等原生 title）；选中即时弹出「这是什么 + 覆盖字段」反馈；占位符改「无预设」显式退出；内置 local-audit 预设 permission auto→readonly（语义更准且避免 ask 用户被提权拦截静默忽略）
- 本地模型 507 截断缓解（依据排查报告）：只读子代理目标为本地模型时串行化（不再 Promise.all 无并发上限，避免多路大 prefill 打满内存）；本地模型压缩触发线默认 60%（远程仍 80%）；API 507 附「内存不足：压缩上下文/减少并发子任务/重启服务」可操作提示

## v0.4.1（2026-09-06）— 安全版本（偿还 v0.4.0 审计安全债 + macOS 本地模型修复）

- P0 安全 ×5：路径穿越防护（fs-tools 全工具限定工作目录 + `config.fsAllowDirs` 白名单 + `realpath` 逐级校验防软链接逃逸）；SSRF 302 重定向绕过（`redirect:'manual'` 手动跟随每跳复检、上限 5 跳）；权限前缀规则黑名单改白名单字符 `[A-Za-z0-9_ ./\\:-]`；预设 permission 提权拦截（`presetPermissionOverride` 三入口统一）；MCP 只读自动放行收紧为「仅 `trusted:true`」
- P1 正确性 ×6：turnToolCache 去重跨步生效（声明提到 for 轮内）；windowPressure 压缩成功后复位；mountConfigTools spawnSync→异步 spawn；batch.js 超窗口预检跟进 model-caps；语义检索无匹配回退最近 N 条；detectSandbox 改最小真实沙箱探测（bwrap 不可用降级 none）
- P2 质量 ×6：正则笔误 `/^f[c d]/`→`/^f[cd]/`；git log/diff 限量实现；cost-guard TDZ 前置；registerTool 增 `readOnly` 选项；context.js 死代码移除；reasoning 清洗 O(n²)→O(n)
- macOS 本地模型双根因：routing 开启时 `subagentModel` 恒返回 executor 致本地/自定义模型子代理 400 全灭 → 池外跟随当前模型；兜底总结全量历史（≈98k prefill 逼近 600s 超时被静默吞）→ 轻量输入 + 失败不再静默
- 子代理空输出透出 note 原因；`diagnose` 新增「当前模型能力」报告（本地模型未声明 contextWindow 时提示兜底 32k 后果）
- 桌面版 WebUI 自定义模型「修改」可直接改 API 地址/标签/上下文窗口/最大输出（留空不变）

## v0.4.0（2026-09-05）— 开放内核（Agent Preset · 第三方工具 · 公共 API）

- Agent Preset：声明式智能体预设 JSON（系统提示+工具白名单+权限+模型+参数），项目/用户/内置三级遮蔽 + schema 严格校验 + 会话级 overlay（不污染 config.json）+ 白名单硬拦截；CLI `--preset` / REPL `/preset` / WebUI 预设下拉三入口；内置「本地模型审计」示例
- 第三方工具：`registerTool` 程序化注册（进权限/审计/省钱 schema 链路，mcp__ 前缀护栏、坏条目不崩启动）+ `config.tools` 声明式 shell 命令包装（参数经 MINGDAO_TOOL_ARGS 环境变量防注入，幂等）
- 公共 API 冻结：`src/index.js` 按 @stable/@experimental 分组，24 个 stable 导出有契约测试锁定（minor 内向后兼容）；新增 `docs/DEVELOPER.md`（预设格式/工具注册/库嵌入/API 速查）
- 战略定调（STRATEGY-NEXT）：垂直产品 × 开放内核；本地/私有化第一公民与 DeepSeek 省钱并列双主攻；不引入插件内核、不做云平台
- 测试：smoke 72 / e2e-local 17 / e2e-web 22（CLI+WebUI 预设真实进程端到端：白名单真实下发/系统提示到达服务端/cfg 不污染）

## v0.3.2（2026-09-05）— 本地模型自适应（资源受限部署长任务不再中断）

- 本地模型自适应：本机/内网推理框架自动按「资源有限」对待——上下文窗口/预算/超时/工具输出截断按模型能力自动收紧，小模型低内存部署不撑爆、不误杀
- 安全预算推导：`budget = min(期望, 窗口×75% 舒适区, 窗口−输出−余量)`，prompt 永不逼近窗口边缘（根治长上下文 prefill 指数恶化 → 首 token 200s+ 被客户端掐断的 network error）
- 分层超时：首 token 等待（本地 600s/远程 300s）+ 流式空闲（120s）+ 总量（本地 30min/远程 10min），按「帧到达」判定存活，慢 prefill 不再被 3 分钟一刀切超时误杀；`config.timeout.*` 可覆盖
- 边缘检测 + 强制压缩：模型上报真实 prompt_tokens ≥ 窗口 85% 时下轮强制压缩（绕过非 DeepSeek 模型启发式计数 ±2 倍低估门槛）
- 工具输出截断自适应：单条工具结果按窗口/16 封顶（2k–20k 字），小窗口不再整条回灌大段代码
- 自定义模型声明 `contextWindow`/`maxOutputTokens`（WebUI 打通）；超时/自定义模型改配置即时生效（清 provider 缓存）

## v0.3.1（2026-09-04）— 真·省钱仪表盘 + 语义检索 + 只读调研 + 自动续跑

- 真·省钱仪表盘：费用徽标从设置移出、置顶主界面，点击展开（KPI 卡 + 命中率环状仪表 + 14 天趋势面积图 + 模型/工具 Top5 条形 + 最近缓存明细）
- 语义检索（零依赖）：项目记忆从「全量截断注入」→「按任务取相关条目」（分词 Jaccard），换任务只注入相关记忆、省 token 且保前缀缓存
- 只读调研工具：`git`（只读子命令白名单 + execFile 防注入）与 `fetch`（公网只读抓取，SSRF 防护 + DNS 复检），只读档扩至 8 工具；子代理步数 12→24 防截断
- 自动续跑：跑满步数不再中断，注入进度摘要自动续下一轮（`cfg.maxRounds` 默认 3）；收尾指令仅末轮注入，中间轮不提前打断
- 统一脱敏：`redact.js` 收敛审计/日志/诊断密钥脱敏（sk-/ghp_/Bearer/私网 IP/家目录路径）
- 续跑检查点合并（保留原始 goal + 合并 artifacts）+ CLI/REPL 交付物收集 + journal 工作空间归属
- 增量上下文（基线+变化）顺延 v0.3.2

## v0.3.0（2026-09-04）— 记忆与长跑

- 省钱基准：`bench-savings`（8 任务·综合省 63% 基线）+ `docs/SAVINGS-BENCHMARK.md` 并入 bench 链（bench 208 断言）
- 任务续跑 v1：agent `capHit` + task-state 侧车检查点；`--continue`/WebUI 恢复会话时注入进度摘要续跑（24 步不再死，已完成文件不重做）
- 项目级自动记忆 v1：`<工作空间>/.mingdao/memory.md` 轮末自动沉淀「决定/事实/结构/教训」并去重注入；会话内快照保证前缀缓存稳定
- `mingdao diagnose`：一键生成脱敏诊断包（环境/配置脱敏/日志尾/审计尾/工作空间 + 项目记忆定位）
- 增量上下文（基线+变化）顺延 v0.3.1（风险高，续跑进度摘要已覆盖主场景）

## v0.2.8（2026-09-03）

- 任务收尾总结对齐 DSH：跑满步数前注入收尾指令、末轮仍调工具时补 no-tool 兜底总结，交付物清单随总结输出（agent.js + server.js 兜底文案改写 + smoke 5c/5d 回归）
- B/C/D 计划：会话索引按会话名 sha1 分片（256 片，>1000 会话免单文件全量解析 + 增量只写脏片 + 旧单文件自动迁移）· 常量单源化（MAX_CONCURRENT/5MB/200KB 附件上限收敛到 src/web/constants.js，app.js/attachments.js/fs-tools.js 不再漂移）· WebUI ES Modules 拆分（app.js → util.js 纯工具 + constants.js）· 文档门禁（QA-REPORT 断言规模快照、CONFIG 补 downgrade/思考档位、CI 类型门禁统一 tsconfig.full.json）
- 思考模式/推理等级**按模型独立**（`reasoningByModel[模型]` 覆盖，旧全局 reasoningEffort 兼容；/api/state reasoning 字段 + /api/config 校验 + REPL /think 同步）
- UI 对齐 DSH：模型（紧凑选择器）、权限、思考下拉下移到输入区（发送键左侧），顶栏瘦身；权限/思考中文选项（询问/自动/只读 · 关/低/高/最高）
- 自绘悬浮气泡 tooltip 替换原生 title（权限/模型/思考/附件按钮/后台任务 chip，暗色主题一致）；轨迹/子代理「关闭」按钮字号缩小 + 不换行

## v0.2.7（2026-09-02）

- 自查 6 条修复 + 界面三项：stopDaemon 解析 pid + daemon 租约自退（防双守护重复执行，含 finally 条件删 pidfile 自检拦截的连锁退出回归）+ e2e-schedule 回归 · MCP 超时孤儿清理 · 护栏徽标 NaN 守卫 · 价格源协议/大小校验 · 日志权限 600 · 任务活动条宽度自适应+阶段回归 · task 子代理派发时机引导 · 后台任务 chip 详情 tooltip

## v0.2.6（2026-09-02）

- A 计划（前缀缓存稳定性与费用基准）：A1 工具 Schema 两态冻结（回合内 ≤2 payload，剥描述按回合快照）· A2 MCP 预热（6s 超时本会话冻结工具集）· A3 bench-cost 费用基准（schema 收益/两态冻结/护栏拦截/batch 半价 14 断言入 bench 链）· A4 回收幂等守卫（修复嵌套重截导致保留区字节逐轮漂移）+ 前沿对齐结论入基准

## v0.2.5（2026-09-01）

- Phase C 结构渐进：routes/api.js 按域拆分（7 域 + 编排器 + API 契约测试 8 组，修 icon 路径 bug）· cli REPL→commands/repl.js、worker→tasks/worker.js（tuiState 共享槽修复 onCompact 跨文件闭包）· strict 棘轮 1112→0（全量注解 + annotate-strict 辅助器，基线归零）

## v0.2.4（2026-08-31）

- Phase B 省钱第二轮：工具 schema 按需挂载（只读阶段收缩/已用工具瘦身-48%）· Batch 去重回填/超窗口预检/--max-cost · 费用二级分账（reasoning/byTool/byDay + WebUI Top5/折线）· 护栏 downgrade 切 flash · bench 扩到 150+ 断言 + 覆盖率阈值 60%

## v0.2.3（2026-08-31）

- 紧急修复 0.2.2 桌面三平台启动即崩：main.js 顶层 createLogWriter 漏导入（A6 重构遗留）——改为顶层 await import(srcRoot/log-writer.js)；新增静态护栏 + CI 打包冒烟（xvfb + MINGDAO_DESKTOP_SMOKE）

## v0.2.2（2026-08-31）

- Phase A 正确性收尾：sync 写锁、密码隐藏输入、fs-browse 基目录、body 分级、草稿按会话、日志统一、崩溃护栏、notify 结构化、run 参数合一

## v0.2.1（2026-08-31）

- Phase 3 工程化：测试汇总运行器、V8 覆盖率门禁、strict 棘轮、bench 入 CI、CHANGELOG 发布钩子；桌面 deb 更新引导、后台任务横幅、活动条合并、模型连通性测试、轨迹窄栏同显

## v0.2.0（2026-08-28）— Phase 2 结构治理

### 结构
- **server.js 拆路由模块**：全部 HTTP 路由抽至 `src/web/routes/api.js`（1299 → 579 行），服务器局部状态经 deps 显式传入（可变原语 state/refs 包装）
- **SPA JS 外置**：index.html 内联脚本抽至 `src/web/app.js`，CSP 收紧移除 `script-src 'unsafe-inline'`（417 行壳 + 1008 行逻辑）
- **cli.js 命令分发显式化**：`命令 → {module, handler}` 映射表替换字符串拼接三元嵌套；死导入清理

### 安全与正确性
- **SSRF 防护**：自定义模型/同步端点校验目标地址——对外监听时拒绝私网/回环/链路本地（本机回环绑定时放行本机模型服务，`web.allowPrivateEndpoints` 显式放行）
- **并发上限修复**：inflight 计数绑定请求生命周期（readBody 期间不再并发超限）
- **会话写互斥**：同一会话文件的追加与压缩重写按文件串行化
- **listen 修复**：runWebServer 等待绑定成功才 resolve，失败 reject；桌面端端口占用自动换端口重试（6 次），CLI 明确报错
- **sync-server 限流加固**：整表 clear → 最旧淘汰；键含用户名（防分布式 IP 绕过）；SYNC_TRUST_PROXY 控制 X-Forwarded-For；maxConnections 500
- **API Key 即时生效**：设置/删除 Key 后 provider 缓存失效，无需重启
- **更新下载失败可见**：发现新版本后下载出错弹窗提示官网手动下载；下载进度写日志

## v0.1.70（2026-08-28）— 更新器修复 · 静默可见性 · 布局重构

### 修复
- **Linux 自动更新下载失败根因**：打包环境下 `update-available` 回调的 info 参数为 undefined，旧代码 `info.version` 在监听器内抛 TypeError，中断 updater 事件派发导致 autoDownload 永不启动——全部监听器改 null-safe 且绝不在事件回调抛错
- **阶段静默深度优化**：服务端 progress 心跳新增阶段语义（模型推理中/执行工具中/等待权限确认）与子代理计数；客户端新增**顶部常驻活动条**（生成期间始终可见、滚动不影响：阶段 + 第 N 步 + 已 X 分 Y 秒 + N 工具步 + M 子代理）；回合边界（turnStart/turnEnd）继续播报
- **text=0 补偿反馈**：模型执行完工具但未输出总结时，done 提示改为「本轮共执行 N 步工具操作、交付 M 个文件，模型没有输出总结文字——可追问『总结一下刚才的工作』」

### 界面
- 输入框上方状态条文案缩短（⏳ N 步 · X 分 Y 秒 · N 工具步），移除冗余停止提示（按钮就在下方）
- **轨迹面板固定左侧栏**：聊天框左侧常驻「🧭 轨迹」栏，点击展开本轮轨迹详情（回合/工具/子代理），与消息顶部按钮等效
- **子代理面板右置**：顶栏「🤖 子代理 N」按钮展开右侧面板，列出本会话全部子代理（任务 + 结果可展开），与任务面板互斥
- Windows 更新完成弹窗改为友好提示（「更新已就绪」+ 正向文案，不再是报错观感）

## v0.1.69（2026-08-28）— 质量加固版（Phase 1）

### 修复
- 计费：`pricing.overrides` 根级价格现在同时传播到高峰价——此前高峰时段自定义价格被内置 peak 价替代，费用估算/护栏口径失真（H1）
- 调度：修复 every 任务执行期间 `pause` 被隐式恢复的确定性 bug（H2）；kill 前校验 PID 归属，防 PID 复用误杀（M11）
- 并发：新增 `src/atomic-write.js`（pid+随机 tmp 原子写 + O_EXCL 文件锁与陈旧锁回收）；config/credentials/update-state/session/session-index/sync 状态全部原子化；调度与任务读改写加锁（H3/H4）
- 压缩：手动 `/compact` 与自动压缩统一实现（同款 `<conversation_summary>` 标记，增量压缩可识别），修复双实现分叉（M7）
- 记忆：日期戳统一走配置时区（默认北京时间），修复 journal UTC 口径漂移（M8）
- 内存：undo 备份增加全局上限（64 文件 / 20MB，超限淘汰最旧），防长会话内存膨胀（M9）
- WebUI：主「■ 停止」只中断本任务（带 taskId），不再误伤其他标签页并发任务（L1）；`_activeTools` 被拒条目即时清理（L2）；任务面板保留最近完成历史并按年龄+数量双阈值清理（L3）
- 桌面/后台：worker/daemon/sleeper spawn 补 error 监听，ENOENT 不再崩进程（M12）；WebUI 自启失败给出可见提示（L6）

### 性能
- 上下文语义回收改为增量 token 求和（原每步全量重算，≤500×n）（M10）
- 费用护栏今日累计按 cache-stats 文件 mtime 缓存，不再每步全量解析（M10）

### 测试
- smoke 52 组 / e2e 21+16+7 / bench 38 断言全绿；新增原子写与文件锁、计费覆盖传播、pause 状态决策三组回归
