# MingDao Harness v0.6.19 发布说明

> 状态：**已发布**（tag `v0.6.19`）
> 主题：**界面骨架照设计稿重排；UI P2 收口（三列设置 / 危险操作二次确认 / 无障碍 / i18n）；测试端口全部动态化**
> ——三栏骨架与右栏四标签页（§3.78）；设置三列、六类危险操作二次确认、dialog 无障碍与 zh/en 109 键
> i18n（§3.77）；测试里 8 个写死监听端口改 `listen(0)`，`doc-lint ⑨` 加结构守卫（§3.76）。
> 逐条根因与取舍见 `docs/internal/AUDIT-v0.6.1-第三方报告登记.md` §3.76–§3.78。

## 为什么发这一版

| # | 现场 | 这一版怎么处理 |
| --- | --- | --- |
| 1 | 负责人打开设计稿后问「UI 怎么不是这个样子」——页面仍是「52px 顶栏塞 11 个控件 + 左侧图标轨 + 4 个固定面板 + 单列正文」，与设计稿的三栏骨架是两套结构 | 把设计稿布局/组件 CSS **原样搬运**（约 760 行，只做令牌映射 + 9 个新增变量照抄），重排成三栏 + 右栏四标签页；原 5 个面板全搬进右栏且 **id 与 handler 保留**（§3.78） |
| 2 | 设置项看不出「默认值是什么、改了影响什么」；删除会话/工作空间、清空记忆、恢复默认、切 `auto`、关沙箱都是一点就执行 | 设置项三列（默认/当前/影响，默认值由只读 `/api/state.defaults` 透出）；六类危险操作统一二次确认，初始焦点在取消、**回车不确认**、Esc 取消（§3.77） |
| 3 | 弹层没有 dialog 语义/焦点陷阱，键盘用户 Tab 会跑到背景；界面只有中文 | `installDialog()` 统一 `role=dialog`/`aria-modal`/焦点陷阱/Esc 回焦；`aria-live` 节流播报、图标 `aria-label`；`src/web/i18n.js` zh/en **109 键同键**，缺失回退 zh（§3.77） |
| 4 | 测试里 8 个写死监听端口（45972/45974/45980/45991/45996/45997/45998/45999）在高负载/并行时 `EADDRINUSE`，§145 时序断言假红；`e2e-web` 用 `40000+random` | 全部改 `listen(0)` 取运行时端口（§145 两次 `listen(0)` 且断言端口不同）；`e2e-web` 复用 `freePort()`；`doc-lint ⑨` 守卫拦 `listen(4xxxx/5xxxx)` 字面量（§3.76） |

> 一句话：**布局按设计稿来，危险操作要确认，端口交给内核，文案能切换。**

## 变化

### 一、界面骨架照设计稿重排（§3.78）

- **三栏骨架**：`.app` = `264px minmax(0,1fr) 300px`、行 `48px minmax(0,1fr) auto`、areas
  `"top top top" / "side main run" / "side foot run"`（与设计稿逐字一致）。
- **顶栏只剩** brand / 面包屑（`#crumbWs › #crumbSession`）/ 草稿徽标（`#draftBadge`，有未发送文字才显示）/
  `⌘K`（`#paletteBtn`）/ 设置（`#cfgBtn`）；`#modelSel`、`#presetSel`、`#permSel` 只在**会话设置弹层**。
- **侧栏**：工作空间行 / 搜索 / 新对话 / 会话列表（`renderSessionNav()` 复用既有 `sessionsCache` 与
  `#sessions` change handler）/ 底部（环境、成本、会话管理、主题）。
- **底部一条区**：`#runStrip` 六项 + 上下文条 + 停止 → `#composer`（附件 / 输入 / 当前模型与权限胶囊 /
  发送）→ `#hint` → `#statusBar`。
- **右栏四标签页**：轨迹 / 子Agent / 任务 / 仪表盘；原 `#trajPanel`、`#subPanel`、`#tasksPanel`、
  `#dashPanel` 与 `#rpTraceList`、`#tjList`、`#sbList`、`#tpList`、`#tpCount`、`#kpiToday` 等 id 全部保留，
  handler 未重写；显隐由 `railPanelDisplay()` + `syncPanelLayout()` 统一控制。
- **设计稿 CSS 原样搬运**：新增 §3.78 样式块约 760 行；14 个颜色变量映射，9 个新增变量
  （`--line-strong` / `--ok` / `--tint-warn|err|ok` / `--sh-panel` / `--sh-overlay` / `--scroll` /
  `--scroll-hover` / `--on-accent` / `--btn-primary-*`）照抄数值；class 名与设计稿一致。
- **对比度**：承载信息的次要文本 `--faint → --dim` 共 61 条规则 + 2 处行内 style，
  `--panel` 3.76:1 → 6.53:1、`--bg3` 3.26:1 → 5.67:1；纯装饰仍 `--faint`，令牌原值未动。
- **断点**：≥1180 三栏；900–1180 右栏覆盖式抽屉（`body.run-drawer`）；<900 侧栏抽屉
  （`body.side-drawer`，顶栏 `#sideToggle`）；Esc 分层关闭（先侧栏再右栏）；收起右栏时
  `body.rail-collapsed` 把第 3 列归零。
- **断言**：`smoke` §153（含**从设计稿解析 59 个选择器**逐声明比对、对比度现算）；
  `batch43-ui-shell.mjs` **12/12**。

### 二、UI P2：设置三列 / 危险操作二次确认 / 无障碍 / i18n（§3.77）

- **设置三列**：每项控件下 `默认 / 当前 / 影响`；默认值由 `src/config.js` 内置默认表经
  `GET /api/state.defaults` **只读透出**（不参与判定、不写盘），前端 `SETTING_DEFAULTS_FALLBACK` 同值兜底。
- **六类危险操作**：删除工作空间 / 删除会话 / 清空记忆 / 恢复默认配置 / 切换 `permission=auto` /
  关闭沙箱 → `runDanger()` 先 await confirm，**取消直接返回、绝不 execute**；`#dangerDialog` 初始焦点在
  「取消」，**回车不确认**，Esc 取消，确认按钮 `type=button`。
- **无障碍**：`installDialog()` 统一 `role=dialog` + `aria-modal` + `aria-label`、Tab/Shift+Tab 焦点陷阱、
  Esc 关闭、关闭后焦点归还触发元素；已接入 ⌘K、会话设置、危险确认三个弹层；状态条/轨迹/子Agent 行
  `aria-live="polite"`，另有节流 `#a11yLive`；图标按钮补 `aria-label`。
- **i18n**：`src/web/i18n.js`（零依赖），zh/en **109 键同键**；默认跟随 `navigator.language`，
  `localStorage['mingdao-lang']` 可覆盖，设置 › 外观可切换；缺失键回退 zh，zh 也没有返回空串。
  只抽静态 UI 文案，不翻译日志/错误原文。
- **断言**：`test/ui-p2.js` 6 项；`batch42-ui-p2.mjs` **15/15**。

### 三、测试固定端口 → `listen(0)` 运行时端口（§3.76）

- 8 个写死端口 / 20 处引用全部改为 `port: 0` + `srv.address().port`：`smoke.js` §34 / §116 / §123 /
  §144 / §145（两个实例）/ §146 / §148，`api-contracts.js`，`e2e-web.js`（`40000+random` → `freePort()`）。
- §145 两次 `listen(0)` 并在最多 5 次重试内断言 `base145b !== base145a`（语义是「两个不同端口」，
  不是两个特定数字）。
- `scripts/doc-lint.mjs` 新增 ⑨：扫描 `test/**`（排除 `test/mutate/.generated/`），抹注释后命中
  `/\blisten\(\s*([45]\d{4})\b/` 即失败；`listen(0)` / `listen(port)` / `freePort()` 不误报。
- 验证：smoke 连跑多次 **0 `EADDRINUSE`**；`e2e-local` 17 / `e2e-web` 24 / `e2e-schedule` 11 /
  `api-contracts` 8 全部通过。

## 升级须知

1. **DOM 结构变了，id 没变**：顶栏不再有模型/预设/权限选择器（在会话设置 `#sessSheet` 里），
   原左侧图标轨 `#trajRail` 已移除（两个按钮 id 保留在右栏标签栏）。若有自定义 CSS / 用户脚本
   依赖旧结构（顶栏控件、`.rail`、面板位置），需要适配；按 id 定位的脚本不受影响。
2. **危险操作现在要二次确认**：删除会话/工作空间、清空记忆、恢复默认、切 `auto`、关沙箱都会弹
   `#dangerDialog`，**默认焦点是「取消」，回车不会确认**。自动化脚本若点这些按钮，需要显式点「确认」。
3. **i18n 默认跟随浏览器语言**：英文环境会看到英文静态 UI（日志、错误原文、动态运行文案仍是原文/中文）。
   想固定语言：设置 › 外观 › 语言，或 `localStorage.setItem('mingdao-lang','zh')`。
4. **`--faint` 的部分用法改为 `--dim`**：自定义主题若覆盖 `--faint` 并期待它出现在来源/计数/说明/
   空态等位置，需同时覆盖 `--dim`（令牌原值本身未改）。
5. **测试端口动态化**：`smoke` / `api-contracts` / `e2e-web` 不再监听固定端口；如有外部脚本硬编码
   459xx 去连测试服务器，需要改为从日志解析实际端口。
6. **桌面版无构建链路改动**：安装包版本随 `desktop:sync` 与根版本一致；自动更新链路未改。

## 已知边界（如实登记）

- **布局按设计稿重排，但细节有差异**：逐项对照见 §3.78 **第三节**（「逐项对照」表）。未做的有：
  会话分组「今天/昨天/更早」与每项「N 步 · 时间」、轮次时间戳与「今天 14:05 · 仓库」分隔行
  （`/api/sessions` 与历史消息没有这些字段，不伪造）、对话流**内联工具卡**（按 §3.73 的决定收纳到
  右栏，两者不能同时满足）、**折叠动画/右栏 opacity 过渡**（右栏收起仍是 `display:none`）、
  **toast**（只搬了 CSS，产品没有 toast 产出点，不伪造）、**980 图标化侧栏**（按任务要求改为 <900 抽屉）、
  720 隐藏 crumb。顶栏主题按钮移到侧栏底部（能力保留）；右栏本轮数据比设计稿多一个「阶段」盒子
  （P1 §149 要求 `data-rk` 六项含 phase）。
- **`--t3` 有意改用 `--dim`**：这是**唯一一处数值不跟设计稿**的地方——设计稿 `--t3` 原样在
  `--bg3`/`--panel` 上只有 3.26/3.76，低于 WCAG 4.5:1；改用 `--dim` 后 5.67/6.53。已在 CSS 就地注明。
- **状态条/轨迹等动态运行文案仍是中文**，未并入 i18n：它们与 SSE 字段、既有 smoke 断言强耦合，
  翻译会破坏排障证据与断言；本版 i18n 只覆盖静态 UI 文案、设置项、确认框与新增 P2 组件。
- **`#cfgModal` 与快捷键表未加焦点陷阱**：本轮 `installDialog()` 只接了 ⌘K、会话设置、危险确认三个弹层；
  设置弹层与快捷键表仍是旧的焦点行为。
- **堆叠弹层 `Esc` 需后续 dialog stack 收口**：同时打开多个弹层时，Esc 的关闭顺序目前是分层判据
  （先侧栏再右栏、再弹层），没有统一的「后开先关」栈；已登记为后续工作。
- **固定端口守卫只抓字面量**：`doc-lint ⑨` 认 `listen(45997)` 这类写法；`const P = 45997; listen(P)`
  抓不到（本轮扫描后 `test/**` 已无此类写法，但属于刻意绕过时仍需人工 review）。
- **更新弹窗仍每次提示**：没有「不再提示」配置（不写 config、不做静默）；本版未改该行为。
- **窄屏未做真实截图验证**：断点由 smoke 的类名/行为断言覆盖，未在真实 Electron 窗口逐档截图；
  「900px 无横向滚动/无裁切」仍建议人工过一遍。

## 验证

- 全量门禁（逐项单独跑、逐项取 `$?`；`MINGDAO_HOME` 用临时目录）：`npm run typecheck` 0 /
  `npm run typecheck:strict` 当前 0 基线 0 / `node test/smoke.js` **156 组断言全通过（单独跑）** /
  `node test/e2e-local.js` 17 项 / `node test/e2e-web.js` 24 项 / `node test/e2e-schedule.js` 11 项 /
  `node test/api-contracts.js` 8 项 / `node test/pack-ctx-privesc.js` 4 组 /
  `node test/ledger-source.js` 7 组 / `node test/model-names.js` 8 组 /
  `node test/memory-recovery.js` 5 项 / `node test/ui-p2.js` 6 项 /
  `node test/mutate/selfcheck.mjs` **14/14** / `npm run bench` 五套 **214 通过 / 0 失败** /
  `node test/mutate/run.mjs` **32/32 批、369/369 条全中、0 逃逸（单独跑，全局锁正常获取/释放）** /
  `node scripts/doc-lint.mjs` 全通过（⑥ 369 = README 369，⑨ 固定端口 0 处）/
  `node src/cli.js diagnose` 正常。
- 发布提交只含发布文件（CHANGELOG / RELEASE-NOTES / `package.json` / `package-lock.json` /
  `desktop/package.json`）；`git diff --name-only <门禁SHA>..<tagSHA> -- src test` 为 **0 行**。
- 三平台 main 与 tag 对齐；npm 已发布 `mingdao-harness@0.6.19`；官网 hero、三份 `/updates/*.yml`、
  7 个下载 URL 与两个域名线上核对通过；镜像 Release 日志出现 `MIRROR_RELEASE_DONE v0.6.19`。
