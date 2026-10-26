# MingDao Harness v0.6.25 发布说明

> 状态：**已发布**（tag `v0.6.25`）
> 主题：**UI 去重与右栏提密度**（§3.90）
> ——本版只动 WebUI（`src/web/index.html` + `src/web/app.js`），按负责人的四条界面意见做「去重 +
> 提密度」：① 左窄条删掉与右栏四标签重复的 🧭 轨迹 / 🤖 子Agent 两个按钮；② 顶栏「新对话」删除，
> **可见的新建入口只剩左侧「＋ 新建对话」**；③「最近会话」可折叠（chevron + 计数，偏好记忆）；
> ④ 右栏顺序改为 **标题 → 四标签 → 概览（默认折叠为一行摘要）→ 内容区**，四个标签的可视高度
> **约 204px → 约 637px**（+433px）。细节见
> `docs/internal/AUDIT-v0.6.1-第三方报告登记.md` **§3.90**。
> 没有新增后端、请求或轮询；所有改动只涉及 DOM 顺序、可见性、两个 `localStorage` 偏好键。

## 一、四条意见与修法

### ① 左窄条：删掉与右栏重复的「轨迹」「子Agent」

**证据**：42px 窄条里的 🧭（轨迹）/ 🤖（子Agent）与右栏四个标签页是**同一份内容的两个入口**，
窄条本身已因右侧抽屉开关而拥挤。

**修法**：删除 `#trajRailBtn` / `#subRailBtn` 两个可见按钮，连同
`$('#trajRailBtn').onclick`、`$('#subRailBtn').onclick`、`lastMsgWithTraj()`、
`toggleSubPanel()` 等绑定/死函数一并移除；窄条只剩 ☰ / ＋ / 📁 / 💬 四个入口
（`#sideNavRailBtn` 是窄条唯一可见按钮）。右栏「轨迹」「子Agent」标签仍是详情入口
（默认仍为轨迹），顶栏「任务」与费用徽标仍分别走 `activateRailTab('tasks'|'dash')`——
**删的是重复入口，不是能力**。

为保住既有变异批次的锚点，保留 `#legacyRailCompat` **hidden 兼容节点**：`hidden`、无点击绑定、
不参与布局与可见性，不进入任何用户路径。

### ② 顶栏「新对话」删除，可见新建入口只剩左侧

**证据**：顶栏「新对话」与 v0.6.24 新增的左侧「＋ 新建对话」是同一个 handler 的两份入口。

**修法**：`<button id="newChat">新对话</button>` 收进 `<span id="newChatCompat" hidden>`
隐藏兼容节点——`#newChat` 的 id 与 `onclick` 语义仍在（左侧 `#sideNavNew` 与 ⌘K 仍点它），
但**可见的新建入口只剩左侧「＋ 新建对话」**，顶栏右侧因此少一个按钮。

### ③「最近会话」可折叠（并记忆偏好）

**修法**：标题改成按钮 `#sideNavRecentToggle`（chevron + 标题 + 数量 `#sideNavRecentCount`）；
点击只切 `#sideNavSessions.hidden`，标题与计数常驻（收起后仍能看到「最近会话 · N」）；
状态写 `localStorage['mingdao-recent-collapsed']`（默认展开），`initSideNav()` 启动时恢复。

### ④ 右栏：四标签上移 + 概览默认折叠，内容区拿回高度

**证据**：四标签栏原本在「会话配置 + 本轮数据」之后，标签内容区被压到约 204px。

**修法**：

- DOM 顺序改为「`rp-head` → 四标签 `rp-tabs` → `#rpOverview`（会话配置 + 本轮数据）→
  `rp-tabbody` → `rp-foot`」；
- `#rpOverview` **默认折叠**为一行摘要：`deepseek-flash · ask · 空闲 · 0 次工具调用`——
  四段完全取 `runPanelView()` 的 `model/permission/phase/tools`，与状态条同源；
  展开偏好写 `localStorage['mingdao-rp-overview-expanded']`；
- 展开后字段 id 与数据来源**一个未改**（`#rpModel`/`#rpPerm`/六个 `data-rk` 仍由
  `renderRunPanel()` 写）；
- `.rp-tabbody`/`.rp-tab` 保持 `flex:1;min-height:0` + 内部滚动；收起概览后内容区可视高度
  由约 **204px** 增至约 **637px**（1440×900 实测），摘要可在 300px 右栏内完整显示。
- 未引入设计稿 CSS；未改 `.app` 网格列宽、顶栏高度、主题 token、字号阶。

## 二、测试与变异

- `test/smoke.js` 新增 **§159**（六条覆盖）：
  ① 左窄条无重复按钮（id / aria-label / 图标都不在、只剩一个可见按钮、两个 onclick 绑定已删）
  且右栏四标签 / 顶栏任务 / 费用入口不回归；
  ② 可见新建入口唯一（`#newChat` 唯一且包在 hidden 兼容节点里、`#sideNavNew` 仍转发 click）；
  ③ 最近会话可折叠且记忆（`mingdao-recent-collapsed` 写 / 读 / 模拟重载，`aria-expanded` 与计数仍在）；
  ④ 右栏 DOM 顺序「标题→四标签→概览→内容区→底部」+ 内容区 `flex:1/min-height:0` 与内部滚动；
  ⑤ 概览默认折叠且展开后字段同源（`#rpModel`/`#rpPerm` 仍取 `v.modelLabel||v.model` /
  `v.permission`）；
  ⑥ 既有能力不回归（四标签切换、⌘K、设置、状态条、错误卡、内联确认各至少一条结构断言）。
- 新增 `test/mutate/batch51-ui-dedupe.mjs`：**14/14 全中**（窄条恢复 🧭/🤖、顶栏 `#newChat`
  去掉 hidden、折叠不落盘、折叠不藏列表、计数不更新、概览 id 丢失、内容区 flex 回退、
  概览默认展开、摘要漏工具数、`#rpModel` 换常量、`#sideNavNew` 不转发、恢复 `#trajRailBtn`
  绑定、`RAIL_TABS` 少标签）。
- 全仓变异总数 **425 → 439**（39 批；`test/mutate/README.md` 计数行同步）。

## 三、验证（本机 macOS，最终 HEAD）

- `npm run typecheck` → **0**；`npm run typecheck:strict` → **当前 0 / 基线 0**
- `node test/smoke.js` 单独跑 → **全部通过：156 组断言**（含新增 **§159**）
- `node test/e2e-local.js` → 17 项；`node test/e2e-web.js` → 24 项；
  `node test/e2e-schedule.js` → 11 项；`node test/api-contracts.js` → 8 项
- `pack-ctx-privesc` 4 组 / `ledger-source` 11 组 / `model-names` 8 组 /
  `memory-recovery` 5 项 / `ui-sessions` 5 项 → 全通过
- `node test/mutate/selfcheck.mjs` → 14/14 场景通过
- `npm run bench` → 5 套基准全通过（tokenizer 16 / routing 118 / compaction 46 / cost 14 / savings 20）
- `node test/mutate/run.mjs` → **39/39 批全中、439/439 条变异被抓到**（跑完自动还原，无残留）
- `node scripts/doc-lint.mjs` → 全通过；`node src/cli.js diagnose` → 报告生成正常、密钥脱敏
- 发布提交只含五个发布文件（`CHANGELOG.md` / `RELEASE-NOTES-0.6.25.md` / `package.json` /
  `package-lock.json` / `desktop/package.json`）；
  `git diff --name-only <门禁SHA>..<tagSHA> -- src test` → **0 行**
- 发布树截图（真实 Electron，`scripts/ui-shot.mjs`）：
  - `/tmp/shots-0625`（1440×900）
  - `/tmp/shots-0625-1000`（1000×900）
  - `/tmp/shots-0625-narrow`（`--viewport narrow`，880×900）

## 四、已知边界（逐条如实登记）

- **为保住旧变异锚点保留了 hidden 兼容节点**（`#legacyRailCompat` / `#newChatCompat`，
  **后续可清理**）：两者都是 `hidden`、无点击绑定、不渲染、不进入任何用户路径；只服务于既有
  测试锚点与历史 class 清理，清理时需同步改 batch 里的锚点。
- **1180 整点右栏仍按既有规则收起**：视口**恰好 1180** 时右栏按既有 `max-width:1180px` 规则
  不推开正文（覆盖式），严格三栏需要 **>1180**；该既有规则本版未改。
- **<900 左栏为覆盖式抽屉**，不是推挤式：默认收起，由窄条 ☰（`#sideNavRailBtn`）打开，
  打开时覆盖在主区之上（带阴影），不改变正文宽度。
- **880px 下既有窄条会压住正文左缘**（v0.6.23 起存在，**未修**）：窄条固定定位，而主区
  `margin-left` 在 <900 归零，抽屉收起时正文左缘仍有 42px 被窄条覆盖。
- **顶栏其余重复入口本轮未删**：历史会话 `#sessions` / 会话管理 `#sessMgrBtn` 与左栏
  「最近会话」仍是两份入口指向同一逻辑；本轮只处理负责人点名的「新对话」与窄条两枚，
  其余下一轮再收。
- 未改 `src/providers/**`、`src/session.js`、`src/agent.js`、`presets/**`、`desktop/**`
  （版本号除外）、`ide/**`、`scripts/ui-shot.mjs`；不新增后端、请求或轮询。

## 五、升级须知

1. 从 v0.6.24 升级是**纯前端增量**：窄条少两个图标、顶栏少一个「新对话」，功能入口都还在
   （轨迹/子Agent 在右栏、新建在左侧）。
2. 两个偏好在浏览器 `localStorage`：`mingdao-recent-collapsed`（最近会话折叠）与
   `mingdao-rp-overview-expanded`（右栏概览展开）；不写 `config.json`，换浏览器/清缓存后回默认
   （最近会话展开、概览折叠）。
3. 右栏默认先看到四标签与一行概览摘要，点概览标题即可展开会话配置与本轮数据。
4. 本版不删除任何历史产物；需要回退可继续安装 v0.6.24 / v0.6.23。
