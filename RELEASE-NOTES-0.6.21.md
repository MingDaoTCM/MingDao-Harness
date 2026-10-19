# MingDao Harness v0.6.21 发布说明

> 状态：**已发布**（tag `v0.6.21`）
> 主题：**界面重排（三步走，每步截图验证）**
> ——`v0.6.19` 的界面重排在真机翻车、`v0.6.20` 已回滚到 `v0.6.18`；本版按「小步、每步先出
> Electron 截图、经负责人过目」的方式重新上线：第一步补顶栏面包屑与会话设置来源，第二步把
> 右栏改成四个标签页，第三步只做视觉细节。细节与截图记录见
> `docs/internal/AUDIT-v0.6.1-第三方报告登记.md` **§3.81 / §3.82 / §3.83**。

## 一、本版做了什么（三步，各自独立提交）

### 步骤 1（§3.81）顶栏补 crumb + 会话设置补预设来源 + 截图工具增强

- 顶栏 logo 后新增 `#crumbWs › #crumbSession`（工作空间 › 当前会话），复用现有 `.badge`
  样式，不新增 CSS 骨架；数据只取 `currentWorkspaceName` / `sessionsCache` / `currentSession`，
  不新增后端字段。会话切换、工作空间切换、新对话、清空选择后都会刷新。
- **所有既有入口保留**：工作空间 / 历史会话 / 会话管理 / 任务 / 新对话 / 主题 / 费用一个未删。
- 模型 / 预设 / 权限三个下拉本来就在 `#sessSheet`（v0.6.18 起），本步没有搬 DOM、没有重写
  handler；只在该弹层新增 `#ssPresetSrc`，显示「当前：… · 来源：你的选择 · 仅下一轮」。
- `scripts/ui-shot.mjs` 新增 `--open <css-selector>`（传 `#sessSheet` 时退回点击
  `#sessSettingsBtn`）与每次运行额外输出 `sheet.png`，并校验弹层三个选择器可见、记录
  `sheetInfo` 生效值/来源。

### 步骤 2（§3.82）右栏改成四个标签页：轨迹 / 子Agent / 任务 / 仪表盘

- `#runPanel` 内结构：`rp-head` → `rp-top`（会话配置 + 本轮六项数据）→ `rp-tabs`
  （四个 `role="tabpanel"` 的 `#tabTrace` / `#tabSub` / `#tabTasks` / `#tabDash`）→ `rp-foot`。
- **节点原样搬迁、id 保留、handler 未重写**：`#trajPanel` / `#subPanel` / `#tasksPanel` /
  `#dashPanel` 整体搬入对应标签页，`#tjList` / `#sbList` / `#tpList` / `#kpiToday` 等子节点 id
  全部保留；`updateTasksPanel()`、`renderDashboard()`、`openTraj()`、`renderSubPanel()` 的数据
  逻辑与调用点未改。
- 新增 `railTabDisplay(tab)` 纯函数与 `setRailTab(tab)`：只改 `display` / `.on` /
  `aria-selected`，不重建、不销毁节点，未知标签回退轨迹。
- 顶栏「任务」、顶栏费用徽标、左栏 🧭 / 🤖 改为「切到对应标签 + 打开右栏」；关闭仍用右栏
  「收起」或 ✕。窄屏仍是顶栏「运行」抽屉，内容同一套标签。

### 步骤 3（§3.83）视觉细节四条

1. **次要文本对比度**：28 个承载信息的选择器 `color:var(--faint)` → `var(--dim)`（时间戳、
   来源、计数、说明等）。`--faint` / `--dim` 两个 token 本身未改。暗色对比度例如 bg
   4.92→8.54、bg2 4.64→8.06、panel 3.76→6.53、bg3 3.26→5.67；亮色最小 4.21→6.73。
   修后承载信息的次要文本在四个底色上均达 WCAG AA。
2. **顶栏 1000px 裁切修复**：新增 `header .hdr-right` 横向滚动容器（`overflow-x:auto`、
   `min-width:0`、4px 滚动条），把费用 / 搜索 / 历史会话 / 任务 / ✎ / 新对话收进去；
   `#wsSel` 130→110px、`#crumb` 180→120px，并新增 `@media (max-width:1100px)` 收窄间距、
   隐藏 `#envBadge`。实测 `#sessions`（历史会话）从视口外 **1055–1153px** 变为视口内
   **886–984px**。
3. **右栏标签统一为 `.seg` 观感**：外框 bg3 + 3px padding + 9px 圆角，内按钮 26px/透明底/
   6px 圆角，选中态 panel 底 + text 字 + 600 字重；只加类与 CSS，`app.js` 未改。
4. **会话设置弹层间距圆角微调**：宽 410→400，head/body padding 10/12→11/13，field 标题下
   间距 4→5，effective 外边距 12/8→13/11，foot 8/12→9/13。

- 变异总数 **362 → 376**（新增 `batch43-header-sheet` 10 条、`batch44-run-tabs` 10 条、
  `batch45-visual` 14 条；共 **33 批 / 376 条**，全中）。

## 二、v0.6.19 的翻车与处置（必须记住的一次）

- **翻车事实**：v0.6.19 把设计稿骨架（约 3,000 行前端改动）一次性合入——三栏骨架与旧样式
  叠加、面板默认态被新函数统一接管、设计稿 CSS 整段追加。真机结果是界面凌乱、菜单/设置
  消失、按钮失灵、主按钮亮色硬编码；而 `smoke` 的字符串断言与桩 DOM 切片测试**全绿**。
- **处置**：v0.6.20 把 `src/web/index.html` / `src/web/app.js` **逐字节回滚到 v0.6.18**
  （`git diff v0.6.18 -- src/web/index.html src/web/app.js` 为空），并把断言被回滚骨架的
  `smoke §153`、`test/ui-p2.js`、`batch43-ui-shell`、`batch42-ui-p2` 一并移除。
  不在坏骨架上继续打补丁，是当时唯一能恢复界面的可靠手段。
- **新增截图工具**：v0.6.20 同时新增 `scripts/ui-shot.mjs`——起真实 `src/cli.js web`
  （临时 `MINGDAO_HOME` + token），用**真实 Electron** 加载页面并 `capturePage()` 输出 PNG；
  支持 `--viewport wide|mid|narrow`、`--width/--height`、`--theme`、`--mobile`、`--out`、
  `--open`。服务、参数、Electron、页面报错、截图失败分别以非 0 退出。
- **此后纪律（硬要求）**：**UI 改动必须先跑 `node scripts/ui-shot.mjs` 截图，经负责人过目后
  才能提交/发布**（见 `docs/DEVELOPER.md §六`）。字符串断言只能当回归底线，不能当「界面
  可用」的证据。本版三步每一步都先出截图再进入下一步。

## 三、验证

- `npm run typecheck` → **0**；`npm run typecheck:strict` → **0 / 基线 0**
- `node test/smoke.js`（单独跑）→ 全通过（含新增 §153 / §154 / §155）
- `node test/e2e-local.js` → 17 项；`node test/e2e-web.js` → 24 项；
  `node test/e2e-schedule.js` → 11 项；`node test/api-contracts.js` → 8 项
- `node test/pack-ctx-privesc.js` / `ledger-source.js` / `model-names.js` /
  `memory-recovery.js` → 全通过
- `node test/mutate/selfcheck.mjs` → 自检通过
- `npm run bench` → 5 套基准全通过
- `node test/mutate/run.mjs` → **33/33 批、376/376 条全中、0 逃逸**
- `node scripts/doc-lint.mjs` → 全通过（`doc-lint ⑥` 实际 376 = `test/mutate/README.md` 376）
- `node src/cli.js diagnose` → 报告生成正常、密钥脱敏
- 发布提交只含五个发布文件（`CHANGELOG.md` / `RELEASE-NOTES-0.6.21.md` / `package.json` /
  `package-lock.json` / `desktop/package.json`）；`git diff --name-only <门禁SHA>..<tagSHA>
  -- src test` → **0 行**
- 发布树截图（真实 Electron）：
  - `node scripts/ui-shot.mjs --out /tmp/shots-0621` → 1440×900 五张
  - `node scripts/ui-shot.mjs --out /tmp/shots-0621-1000 --width 1000 --height 900` → 1000×900 五张
  - 路径/尺寸/字节见发布回复与 `docs/internal/AUDIT-v0.6.1-第三方报告登记.md` §3.83。

## 四、已知边界（逐条如实登记）

**设计稿里未做的项**（本版只做了上面三步，以下都没做）：

- **会话分组 / 会话副标题**：未做，会话列表仍是平铺 + 现有元信息。
- **轮次时间戳 / 权限 chip**：未做，消息头与轮次信息维持现状。
- **折叠动画**：未做，面板/折叠区仍是即时显隐，没有过渡动画。
- **toast**：未做，操作反馈仍走现有状态条/提示，没有浮层 toast。
- **980px 图标化侧栏**：未做，当前仍是 **<880px 抽屉**（隐藏侧栏 + 抽屉按钮）。
- **1000px 下「任务 / ✎ / 新对话」仍需横向滚动**：`.hdr-right` 可滚动，历史会话已完整可见，
  但最右侧三个控件在 1000px 视口内仍需横向滚动才能触达；未把它们搬成「更多 ▾」下拉。
- **未做「更多 ▾」下拉**：顶栏没有溢出菜单，低频入口仍直接排在 `.hdr-right` 里。

**其他边界**：

- `--faint → --dim` **只改承载信息的用法**（时间戳/来源/计数/说明等 28 个选择器）；
  纯装饰性文字（分隔符、未选中标签轨道等）仍保留 `--faint`，token 本身未改。
- **动态运行文案仍为中文**：运行阶段、任务状态等动态文案没有接入 i18n；`src/web/i18n.js`
  仍未被引用，界面语言切换仍不可用。
- `#envBadge` 在 ≤1100px 隐藏（≤900 原本就隐藏），为「历史会话」让位；>1100px 仍显示。
- `#wsSel` / `#crumb` 限宽只影响顶栏下拉的视觉宽度，完整名称仍在 `title` 属性中。
- 本版未改 `src/providers/**`、`src/agent.js`、`presets/**`、`desktop/**`（除版本号）、
  `ide/**`；未改 `.app` 网格、顶栏高度、`#runPanel` 宽度、主题变量或字号阶。

## 五、升级须知

1. 从 v0.6.20 升级是**纯增量**：没有回滚，也没有整段覆盖设计稿 CSS；三步分别可独立回退。
2. 顶栏新增「工作空间 › 当前会话」面包屑；长会话名会在 120px 内截断，悬停可见完整标题。
3. 右栏变成四个标签页；顶栏「任务」、费用徽标、左栏 🧭/🤖 现在都会打开右栏并切到对应标签，
   关闭用右栏「收起」或 ✕。
4. 会话设置弹层宽度 410→400，模型/预设/权限位置不变；新增预设来源行。
5. 1000px 宽度下顶栏右侧可横向滚动，历史会话不再被裁到视口外。
6. 本版不删除任何历史产物；需要回退可继续安装 v0.6.20 / v0.6.18。
