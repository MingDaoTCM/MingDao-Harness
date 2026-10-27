# MingDao Harness v0.6.28 发布说明

> 状态：**已发布**（tag `v0.6.28`）
> 主题：**去掉空窄条 + 面板不遮顶栏（`--hdr-h` 不变量）+ TTFT 提示去重**
> ——三件事都来自负责人的实测反馈：① 左侧 42px 空窄条（按钮在 v0.6.27 已删、列还白占宽）
> 整体删除，左栏贴 `left:0`、正文补偿 `282/90/48 → 240/48/0`；② 固定面板不再写死 `top:52px`，
> 新增 `--hdr-h` 实测不变量，顶栏 `z-index:70` 高于所有面板；③ `⏱ 首帧` 每回合只打一行，
> 长审计不再被十几次提示刷屏。细节见 `docs/internal/AUDIT-v0.6.1-第三方报告登记.md` **§3.96**。

## 一、删除空的左窄条 `#trajRail`（§3.96）

**证据**：`#trajRail` 里的轨迹/子Agent 按钮在 v0.6.25（§3.94）已删，但 42px 的固定列还在：
左栏从 `left:42px` 才开始，正文/输入区的补偿里也一直含着这 42px。按钮没了、列还占着，
宽度白扔，左缘看起来像一条空槽。

**修法**：

- 删除 `#trajRail` 元素与全部相关 CSS：`#trajRail`、`.rail-btn`、`.rail-badge`、
  `body.narrow-side #trajRail{width:44px}`；
- `#sideNav` 从 `left:42px` 改为 `left:0`；布局补偿只留左栏自身宽度：

  | 档位 | 旧补偿 | 新补偿 |
  | --- | --- | --- |
  | `side-wide`（≥1180） | 282px（240 + 42） | **240px** |
  | `side-wide.side-collapsed` | 90px（48 + 42） | **48px** |
  | `side-mid`（900–1180） | 90px（48 + 42） | **48px** |
  | `side-drawer`（<900） | 48px | **0px** |

- `<900` 左栏是**覆盖式抽屉**，默认不占列，正文左缘回到 0；抽屉开关 `#sideNavRailBtn` 从窄条
  移入顶栏，且只在 `body.side-drawer` 时显示（宽屏/mid 由左栏自带的折叠按钮负责，不占列），
  仍复用同一个 `toggleSideNav`；
- `#trajPanel` **保留**：它不是死节点——`openTraj()` 仍写 `#tjList`、`#tjClose` 仍绑定
  `setRunPanel(false)`；只是 `left:42px → 0`、`top` 改用 `var(--hdr-h,56px)`。

## 二、面板不再遮挡顶栏：`--hdr-h` 不变量（§3.96）

**证据**：`#runPanel` / `#tasksPanel` / `#subPanel` / `#trajPanel` / `#dashPanel` / `#sideNav`
都写死 `top:52px`。header 的真实高度不是常数（`min-height` + `padding` + 横向滚动条 + 字体），
一旦被撑到 56 或更高，面板就会压住顶栏的下缘。

**修法**：

1. **顶栏抬到所有面板之上**：`header{position:relative;z-index:70}`——右栏抽屉 60、
   任务/子Agent/轨迹 40、仪表盘 45 都在其下；`.modal-mask` 同步 `50 → 90`，
   避免顶栏浮到模态遮罩之上（模态期间 header 仍不可点）。
2. **新增 `--hdr-h` 不变量**：`syncHeaderHeight()` 用
   `header.getBoundingClientRect().height || offsetHeight` 实测，写入
   `document.documentElement.style.setProperty('--hdr-h', h+'px')`；`applyResponsiveLayout()`
   在页面加载与 `resize` 都调用它，并用 `ResizeObserver` 兜住顶栏自身尺寸变化
   （没有该 API 时，加载/resize 两次测量已覆盖）。
3. **所有固定面板的 `top` 统一为 `var(--hdr-h,56px)`**：`#runPanel`、`#tasksPanel`、`#subPanel`、
   `#trajPanel`、`#dashPanel`、`#sideNav`（含窄屏右栏抽屉）；全文不再出现 `top:52px`。

**实测（真实 Electron，880×900）**：`--hdr-h=52px`、`panelTop=52`、`gap=0`、
`headerZ=70 > panelZ=60`；把 header 人为撑到 68 后 `--hdr-h=68`、`overlap=false`。
本机是 macOS 覆盖式滚动条，header 实际就是 52px，所以旧的遮挡视觉在本机截图里不一定出现；
但面板 `top` 已经不再依赖 52 这个猜测值。

## 三、TTFT 提示去重（§3.96，`src/agent.js`）

**证据**：本地模型长审计每回合十几次模型请求，`⏱ 首帧 …` 在「第 1 次」与「≥30s」两个条件下反复
打印，同一条信息刷满一屏。

**修法**：`if (turnProgress.llmCalls === 1 || ttft >= 30000)` → `if (turnProgress.llmCalls === 1)`，
每回合只在第 1 次模型请求打印一行；首帧值仍在状态条/右栏可见。

**验证**：§163 用桩 agent 跑 **3 次模型请求**，`⏱ 首帧` 实际只输出 1 行：

```text
[§163] 3 次模型请求实际打印的 TTFT 行：["⏱ 首帧 0.0s（第 1 次模型请求；本地模型这一项直接反映 prefill 快慢）"]
```

## 四、测试与变异（484 → 492）

- `test/smoke.js` 新增 **§163**：①`#trajRail` 元素/CSS 均不存在、左栏 `left:0`、240/48/0 补偿、
  正文左缘几何（880 容器左缘 0、1440 与左栏相邻）、抽屉开关在顶栏、`#trajPanel` 仍被 handler 使用；
  ②header `z-index:70` 大于所有面板、六处面板 `top:var(--hdr-h,56px)`、无 `top:52px`、JS 在
  加载/resize 实测写入；③3 次模型请求只打印 1 行 TTFT（行为断言，不是源码文本）；
  ④四标签/⌘K/设置/状态条六项/错误卡/内联确认/左栏新建入口不回归。
- 新建 `test/mutate/batch56-layout-ttft.mjs`：**8/8 全中**（恢复空窄条、恢复 `.rail-btn`、
  删 header z-index、面板 z-index 反超 header、`top` 写死 52、删除 JS 写 `--hdr-h`、
  TTFT 每轮都打、`<900` 恢复 48px 补偿）。
- **同步旧锚点（只改旧窄条事实，未放宽语义）**：`§158/§159/§160` 原本静态断言「窄条必须存在 /
  44px / 正文补偿 48px」，与 §163「窄条必须不存在 / 正文左缘 0」互斥；若只追加 §163，
  `node test/smoke.js` 不可能通过。因此对这三节做了最小同步；同时同步 `batch49 ⑪` 的
  `margin-left` 锚点、`batch51 ①②` 的窄条锚点、`batch52 ③④⑤⑦⑧` 的窄条/补偿锚点。
- 变异总数 **492**（`scripts/doc-lint.mjs` ⑥ 校验文档数字 = 各 `batch*.mjs` 真实 `name:` 条数）。

## 五、验证（本机 macOS，最终 HEAD）

- `npm run typecheck` → **0**；`npm run typecheck:strict` → **当前 0 / 基线 0**
- `node test/smoke.js` 单独跑 → 全部通过（含新增 **§163**）
- `e2e-local` 17 / `e2e-web` 24 / `e2e-schedule` 11 / `api-contracts` 8 → 全通过
- `pack-ctx-privesc` 4 组 / `ledger-source` 11 组 / `model-names` 8 组 /
  `memory-recovery` 11 项 / `ui-sessions` 5 项 → 全通过
- `node test/verify-release.js` → 6 项通过；`node test/mutate/selfcheck.mjs` → 14/14
- `npm run bench` → 5 套基准 0 失败
- `node test/mutate/run.mjs` → **45/45 批、492/492 条全中**
- `node scripts/doc-lint.mjs` → 全部通过；`node src/cli.js diagnose` → 报告正常、密钥脱敏
- 发布提交只含发布文件；`git diff --name-only <门禁SHA>..<tagSHA> -- src test` → **0 行**

## 六、已知边界（逐条如实登记）

- **TTFT 劣化的额外警告本轮未做**：后续请求的首帧即使显著变慢，也不会再单独提示（每回合只在
  第 1 次请求打印一行）。首帧值仍在状态条可见；「后续明显劣化警告」需要先把**每请求 TTFT**
  与回合首帧分开计量，本轮没有为一条提示改测量口径（`firstTokenAt` 是回合级的，硬用会算出负值）。
- **`#newChat` / `#sessions` / `#sessMgrBtn` 仍以 `hidden` 形式保留**：`test/smoke.js` §158 仍静态
  断言顶栏入口存在（本轮不改该断言），因此这三个节点只是隐藏、不渲染、不进入用户路径；
  能力已由左栏 `#sideNavNew` / `#sideNavSessions` / `#sideNavSessMgr` 承接。计划下轮连同 §158
  的入口断言一起清理。
- **1180 视口顶栏右侧仍需横向滚动**：`.hdr-right` 是 `overflow-x:auto` 的可滚动容器
  （v0.6.21 既定），本版只是删掉了左侧空列，没有重排顶栏；1180 下最右侧控件仍可能需要
  横向滚动才能看到。
- **Windows 真机未验证**：本版以 CI 的 `test (windows-latest, 20)` 腿绿 + 四个桌面构建为准；
  未在标准 Windows 账户（未开 Developer Mode / 非管理员）上重跑 `npm test`，也未逐按钮点选。
  若真机仍红，请贴断言原文（不要只 rerun）。
- **本轮同步修改了旧断言锚点**：`§158/§159/§160` 与 `batch49 ⑪ / batch51 ①② / batch52 ③④⑤⑦⑧`
  的锚点因「旧断言锚定窄条存在 / 44px / 补偿 48」而必须同步；改动只针对这些窄条事实，
  未放宽任何缺陷语义（详见 §四）。
- **本机截图看不到「面板盖顶栏」的旧视觉**：macOS 是覆盖式滚动条，header 实测 52px，
  与旧 `top:52px` 相等；不变量由 880/68px 的人为撑高实测与 §163 的结构断言共同证明。

## 七、升级须知

1. 从 v0.6.27 升级**无迁移**：只是左侧少了一条 42px 空列、面板 `top` 改为实测高度、
   TTFT 提示不再重复。
2. `<900` 窗口下打开会话侧栏：点顶栏的 **☰**（`#sideNavRailBtn`）；宽屏/mid 仍用左栏标题栏
   右侧的折叠按钮。
3. 轨迹面板（`#trajPanel`）仍由 `openTraj()` 使用，位置改为贴左缘、顶栏之下。
4. 本版不删除任何历史产物；需要回退可继续安装 v0.6.27 / v0.6.26。
