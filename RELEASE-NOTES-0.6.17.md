# MingDao Harness v0.6.17 发布说明

> 状态：**已发布**（tag `v0.6.17`）
> 主题：**界面开始像一套工具，模型名不再假装能直接请求**——
> `docs/DESIGN-UI-v1.md` 的 **P1 八项**落地（工具时间线 / `⌘K` 命令面板 / 快捷键表 /
> 右栏「本轮运行」/ 会话设置 / 空态引导 / 设置分组搜索 / 明暗主题与窄屏断点，§3.70）；
> 模型名称新增**显示别名** `config.modelLabels`：官方宣传名只影响界面，**请求仍用 API id**
> （§3.69 后端 + §3.71 UI 接线）。顺带把 §145 的时序断言改为**负载自适应**。
> 逐条根因与取舍见 `docs/internal/AUDIT-v0.6.1-第三方报告登记.md` §3.69–§3.71。

## 为什么发这一版

两件事都来自**现场与设计文档**，不是代码审查的推演：

| # | 现场 | 这一版怎么处理 |
| --- | --- | --- |
| 1 | `docs/DESIGN-UI-v1.md` 的 P1 八项仍停在提案：工具调用散成多张卡、没有命令面板/快捷键表、运行信息只在状态条、模型/预设/权限分散、空态没有引导、设置页一长条、只有暗色 | P1 八项全部落地；数据只消费既有 SSE 与 `/api/state`，**不新增轮询**（§3.70） |
| 2 | 官方宣传名 `DeepSeek-V4.1-Flash 1017` 在界面上看不到；但拿它请求会被 400 拒绝（API 只认 `deepseek-flash` / `deepseek-v4-pro`） | `config.modelLabels` 做**显示别名**；`/api/models` 返回 `id`/`label`/`detail`/`labelSource`；下拉/⌘K/会话设置都显示 label，**请求体 `model` 始终是 API id**（§3.69、§3.71） |

> 一句话：**能点的东西要能点到，不能请求的名字就不要拿去请求。**

## 变化

### 一、UI P1 八项（§3.70）

- **工具调用时间线卡片**：一轮工具调用聚合为一张卡（N 步 / 总耗时 / K 个失败 + 整卡折叠）；
  每步一行，失败步红色高亮 + `✖`；点击展开完整参数与输出，长输出显示真实行数/字节数并默认折叠；
  默认前 3 步 + 所有失败步；开始/完成复用同一 DOM 节点，不跳位。
- **`⌘K` / `Ctrl+K` 命令面板**：会话 / 工作空间 / 模型 / 预设 / 权限 / 命令 / 设置分组；
  ↑↓/Home/End、Enter、Esc、焦点恢复、输入法组合期不响应；打开时只刷新一次列表，不轮询。
  动作包括新对话、切换会话/工作空间/模型/预设/权限、停止本轮、快捷键表、右栏、明暗、设置深链、
  诊断路径。Web 端没有 `/compact`，因此**不列**该项。
- **快捷键表（`⌘/`）**：只列实际实现的 7 项，不列 `⌘N`、`F5` 等未实现键。
- **右栏「本轮运行」**：≥1180 默认展开并推开正文；<1180 收起为覆盖式抽屉。模型 label + `API id`
  + 来源、预设、权限 + 来源、六项本轮数据（阶段/首帧/吞吐/上下文/工具步数/费用）+ 停止；
  六项与 P0 状态条同源（`runPanelView()` → `runStripView()`），不另算。
- **会话设置弹层**：模型 / 预设 / 权限合并，显示生效值与来源；模型带 `API id` 副标题；
  预设标「仅下一轮」；权限显示 `permission=auto（来源：…）`；输入区只留一个设置按钮。
- **空态三步引导 + 示例任务**：选模型 → 选工作空间 → 输入任务；示例点击**只填入不发送**。
- **设置分组 + 搜索**：10 个分组；按标题/说明/placeholder/`data-kw` 过滤，不匹配项 `hidden`，
  自动切到首个命中分组并显示匹配数。
- **明暗主题 + 窄屏断点**：`localStorage['mingdao-theme']`（`light|dark|system`）；
  system 跟随并监听 `prefers-color-scheme`；<1180 右栏收起、<900 侧栏/次要顶栏收起；
  判据由 `layoutClassesFor(width)` 单点给出；补 `prefers-reduced-motion`。
- **§145 时序断言改为负载自适应**：`slowMs >= 10000`、进度行上限 `ceil(slowMs / 30000)`；
  去掉限频的变异仍会失败，不是放松断言。

### 二、模型显示别名后端（§3.69）

- `config.modelLabels`：`{ "<API id>": "<显示名>" }`；key 非空、value 去空白非空且 ≤80 字符，
  拦截 `__proto__` / `constructor` / `prototype`；非法项**忽略并 warn**，不阻断启动。
- `/api/models` 与 `/api/state` 的模型条目新增 `id` / `label` / `detail` / `labelSource`；
  `label = modelLabels[id] || id`，`label !== id` 时 `labelSource = "config"`；`name` 仍是 API id。
- **请求 `model` 仍是 API id**：显示名不写回 `config.model` / `routing.*`；
  `/api/chat` 桩断言所有出网请求（含预检）的 `model` 都等于 API id。

### 三、UI 接上别名（§3.71）

- 两处模型下拉：`value = id`、可见文本 = `label`、`title` 含 `API id: <id>`；无映射回退 id。
- 会话设置 `#ssModelAliasHint` 仅在 `label !== id` 时显示（HTML 默认 `hidden`）。
- 设置页说明：「模型 id 以 API 返回为准；官方宣传名可在 `config.modelLabels` 里映射为显示名
  （请求仍用 API id）。」不新增控件。
- `⌘K` 模型项显示 `label`、提示带 `API id`、搜索同时匹配 label/id/name，执行仍切 id。

## 升级须知

1. **`modelLabels` 只影响显示，不会改变请求。** 配置后下拉、`⌘K`、会话设置与右栏显示官方宣传名；
   `/api/config` 与出网请求的 `model` 仍然是**API id**。不要试图把宣传名直接写进 `config.model`，
   API 会以 400 拒绝。
2. **API 当前仍只返回/接受 `deepseek-flash` / `deepseek-v4-pro`。**
   「DeepSeek-V4.1-Flash 1017」是官方**宣传/构建名**，不是 API id；这也是本版只做显示别名的原因。
3. **主题偏好写入浏览器 `localStorage`**（键 `mingdao-theme`），不写 `config.json`；
   换浏览器或清缓存后回到「跟随系统」。
4. **窄屏断点只有 900 / 1180 两档**：<1180 右栏收起为抽屉，<900 侧栏与次要顶栏收起。
   桌面窗口最小宽度仍由 Electron `minWidth:900` 约束，没有第三档。
5. **「始终允许本会话」仍只是前端会话级**：不写 config、刷新即失效，其它标签页/重连不继承。
6. 本版不改 `desktop/**` 的构建与自动更新链路；桌面安装包版本随 `desktop:sync` 与根版本一致。

## 已知边界（如实登记）

- **`modelLabels` 只影响显示，请求仍用 API id**；它不会让 API 接受宣传名。
- **API 当前仍只返回/接受 `deepseek-flash` / `deepseek-v4-pro`**；
  「V4.1-Flash 1017」是宣传名，不在 `/v1/models` 里，也不能用于请求。
- **「始终允许本会话」仅前端会话级**（`sessionAllowedAsks`，键 = 确认问题原文）：
  不写 config、不进服务端持久层、刷新即失效；其它标签页/重连后的同会话不继承。
  要跨页面生效需内核在 `POST /api/permission` 落会话级规则（本轮不在允许改动面内）。
- **UI P2 未做**：设置三列布局、危险项二次确认、无障碍（焦点环/语义/键盘全量收口）、
  i18n 收口。本版只做 P1 八项；`docs/DESIGN-UI-v1.md` 仍是设计提案，
  `docs/design/ui-preview.html` 只是版式参照（未改）。
- **窄屏仅在 900 / 1180 两个断点验证**：断点类名与 CSS 已由 smoke 断言覆盖，
  但没有在真实 Electron 窗口逐档截图；「900px 无横向滚动/无裁切」仍建议人工过一遍。
  亮色是 token 映射，不是全量视觉收口，个别旧组件的对比度可能仍需调。
- **跨 worktree 变异互斥仍靠临时锁协议**（`mkdir /tmp/mdh-mutate.lockdir` 等人工约定），
  **未做进 `run.mjs`**；并发在多个 worktree 跑变异仍需要人先拿锁。
- **`/compact` 未做**：Web 端没有 `/api/compact`，命令面板与右栏按「没有就隐藏」处理
  （`compactAvailable` 恒 false，`#rpCompact` 带 `hidden`），没有造新后端。
- **诊断/日志只「给路径 + 复制」**：Web 端没有打开系统文件管理器的能力，命令面板只显示
  `<home>/logs/`、`web-server.log`、`config.json`、工作目录并可复制，没有 Finder 打开动作。
- **未新增轮询**：时间线/右栏只消费既有 SSE（progress≈1s、usage、done）与 `/api/state`；
  命令面板仅在打开时刷新一次列表。
- **真机未复跑**：本版验证是本地全量门禁 + CI 三平台（含 Windows 与 4 条 desktop build）；
  负责人真机上的窄屏/亮色/⌘K 逐项点击本轮未逐一复跑。

## 验证

- 全量门禁（逐项单独跑、逐项取 `$?`）：`npm run typecheck` 0 / `npm run typecheck:strict` 当前 0 基线 0 /
  `node test/smoke.js` **156 组断言全通过（单独跑；§149/§150 新增节在汇总行之后追加，全部 ✓）** /
  `node test/e2e-local.js` 17 项 / `node test/e2e-web.js` 24 项 / `node test/e2e-schedule.js` 11 项 /
  `node test/api-contracts.js` 8 项 / `node test/pack-ctx-privesc.js` 4 组 /
  `node test/ledger-source.js` 7 组 / `node test/model-names.js` 8 组 /
  `node test/mutate/selfcheck.mjs` **8/8** / `npm run bench` **5 套 0 失败** /
  `node test/mutate/run.mjs` **28/28 批、323/323 条全中** /
  `node scripts/doc-lint.mjs` 全通过 / `node src/cli.js diagnose` 正常。
- 发布提交只含发布文件（CHANGELOG / RELEASE-NOTES / `package.json` / `package-lock.json` /
  `desktop/package.json`）；`git diff --name-only <门禁SHA>..<tagSHA> -- src test` 为 **0 行**。
- 三平台 main 与 tag 对齐；npm 已发布 `mingdao-harness@0.6.17`；官网 hero、三份 `/updates/*.yml`、
  7 个下载 URL 与两个域名线上核对通过；镜像 Release 日志出现 `MIRROR_RELEASE_DONE v0.6.17`。
