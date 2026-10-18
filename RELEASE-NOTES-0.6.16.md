# MingDao Harness v0.6.16 发布说明

> 状态：**已发布**（tag `v0.6.16`）（`npm version` 时由 `scripts/bump-changelog.mjs` 自动翻转）。
> 主题：**模型名不再由代码猜，界面开始说实话**——
> 模型名称与能力判定改为以 API 实时返回的官方名为准（家族正则 + 运行时解析默认值，§3.67）；
> UI P0 三项落地：常驻运行状态条、错误折叠卡、对话流内联权限确认，并透出 `/api/state.permissionSource`（§3.68）。
> 逐条根因与取舍见 `docs/internal/AUDIT-v0.6.1-第三方报告登记.md` §3.67–§3.68。

## 为什么发这一版

两件事都是**现场反馈**，不是代码审查的推演：

| # | 现场 | 这一版怎么处理 |
| --- | --- | --- |
| 1 | 官方推出 `DeepSeek-V4.1-Flash 1017`，API 已能拉到，但默认模型与提示仍指着旧名；每升一次版本就要改一次代码 | 家族模式表（pro/flash/vision 正则）+ 默认值运行时从 `/v1/models` 取官方名；精确 id 只作别名；未知新版本可选中并标"能力未知"（§3.67） |
| 2 | 同一轮运行信息散在 5 处、权限确认是全屏遮罩挡住停止键、上游错误原文与建议糊成一段 | P0 三项：常驻状态条收成唯一刷新出口、错误折叠卡保留原文换行、内联权限卡不遮输入区（§3.68） |

> 一句话：**版本号不该写死在代码里，权限确认也不该挡住停止键。**

## 变化

### 一、模型名称与能力判定以 API 实时官方名为准（§3.67）

- **家族模式表 `MODEL_FAMILIES`**（`src/models.js`）：正则匹配 **pro / flash / vision**
  （大小写、空格/下划线/连字符、`v4`/`v4.1`/`V5` 版本号均兼容）；上下文窗口、输出上限、
  工具/推理/视觉能力与峰谷定价挂在**模式**上。精确 id 只作已知别名表 `MODELS_KNOWN`，
  旧名 `deepseek-v4-flash` 仍可用。
- **默认值运行时解析**：`resolveDefaultModel(role)` / `resolveRoutingDefaults(cfg)`，
  优先级 `config.routing.planner|executor`、`config.model` → 当前 `/v1/models` 按家族挑官方名
  （多版本取最高）→ 内置家族代表名兜底，并**显式提示兜底/离线**。
  `ensureMinimalConfig` / `loadConfig` / 向导 / WebUI 路由开关全部接入；新增 `GET /api/models`。
- **不打扰只实现 chat 的网关**：`provider: custom` 与未内置服务商**不主动探测** `GET /models`
  （空 body 会 `JSON.parse` 崩；e2e-web 回归即由此而来）。显式 `config.routing.*` 仍优先。
- **未知新版本可选中、不拒绝**：如 `DeepSeek-V4.2-Flash 1101` 标"能力未知（新版本）"，
  按家族规格保守估算；非家族线上新模型同样列在列表里。
- **离线兜底显式**：API 不可达 → 列表回退内置家族代表名并标 `offlineFallback: true`，
  统一提示"离线兜底：模型名可能不是最新的"。
- **四处文案去版本号**：`cost-guard.js` / `help.js` / `web/attachments.js` /
  `web/routes/domains/config.js`。文档：`docs/CONFIG.md` 新增「模型名称以 API 为准」。

### 二、UI P0：常驻状态条 / 错误折叠卡 / 内联权限确认（§3.68）

- **常驻运行状态条**：`#runStrip` 六字段（阶段/首帧/吞吐/上下文/工具数/本轮费用）；
  删除 `renderLiveBar()` 死代码，`renderWorkStatus()` 是**唯一**刷新出口；
  只用既有 SSE 与 `/api/state.contextBudget`，**不新增轮询**。上下文在生成中标 `≈`，
  无工具调用时明写"0 次"，窄窗自动换行。
- **错误折叠卡**：首行摘要 + 处置建议独立成行（`pre-line`）+ 上游原文默认折叠
  （`<pre>` 保留换行）+ 一键复制；普通横幅不受影响。
- **内联权限确认**：对话流内 `.perm-card`，不再全屏遮罩；三键 本次放行/拒绝/始终允许本会话；
  `y`/`n`/`Esc` 可用；120s 超时按拒绝，**停止优先于超时**。
- **`/api/state.permissionSource`**：`explicit|preset|config`，与账本 `LEDGER_PERMISSION_SOURCE`
  和 `resolveTurnPermission()` 同源。
- **§144 测试卫生**：临时文件改 `os.tmpdir()` + `finally` 清理，`.gitignore` 兜底。

### 三、测试

- 新套件 `test/model-names.js`（7 组）接入 `run-all` 与 CI（Linux 腿）。
- 新变异批 `batch35-modelnames` **9 条** + `batch36-ui-p0` **12 条**；总数 271 → **292**（25 批）。
- `smoke` 追加 §148：状态条六字段 / 错误卡三段式 / 内联确认三键与超时·停止优先 /
  会话级 allow 接线 / `permissionSource` 端到端 / §144 卫生。

## 升级须知

1. **模型默认值现在可能与你 `config.json` 里写的不一样。** 默认值按
   `config.routing.*` / `config.model` → API 官方名 → 家族代表名的顺序解析。
   如果你希望固定某个精确 id，**显式写进 `config.routing.planner` / `config.routing.executor`**
   （或 `config.model`），它永远优先。
2. **旧名仍然可用。** `deepseek-v4-flash` 等历史 id 保留为别名并归一化；
   无需改配置即可继续用，但界面上显示的是 API 官方名。
3. **自定义网关（`provider: custom`）不再被 `GET /models` 探测。** 如果你的网关只实现
   chat，这是修复；若你依赖"自动发现模型名"，请显式配置 `config.routing.*`——
   默认值会退到家族代表名并提示兜底。
4. **"始终允许本会话"只在前端会话级生效**：不写 `config.json`、刷新页面或新会话后失效，
   其它标签页/重连后的同会话也不会继承（见「已知边界」）。
5. **权限确认不再遮住输入区。** 同一轮有多个确认时按顺序逐个展示；`Esc` 等于拒绝；
   停止键优先于 120s 超时。
6. 本版不改 `desktop/**` 的构建与自动更新链路；桌面安装包版本随 `desktop:sync` 与根版本一致。

## 已知边界（如实登记）

- **「始终允许本会话」只是前端会话级 allow**（`sessionAllowedAsks`，键 = 确认问题原文）：
  **不写 config、不进服务端持久层、刷新即失效**；其它标签页/重连后的同会话不继承。
  要跨页面生效需内核在 `POST /api/permission` 落会话级规则（本轮不在允许改动面内）。
- **UI 的 P1/P2 未做**：⌘K 命令面板、快捷键表（⌘/）、工具时间线折叠卡、右栏"本轮运行"面板、
  会话设置三件套（收编模型/预设/权限）、空态三步引导、设置搜索/三列/危险项、明暗主题、
  字号圆角与焦点环全量收口、窄屏 1180/900 断点重排。本版只做 P0 三项 + 两处配套；
  `docs/DESIGN-UI-v1.md` 仍是设计提案，`docs/design/ui-preview.html` 只是版式参照。
- **模型家族表用 `verifiedThrough` 标注已验证版本**：目前为 `4.1`。更新的版本（如 4.2）会标
  "能力未知（新版本）"并**按家族规格估算**——能力/定价可能与实际不同，等官方文档核对后
  更新 `verifiedThrough`。这不是"猜"，是显式的保守估算。
- **`DEFAULT_*` 仍保留为家族代表名兜底**：`DEFAULT_PLANNER_MODEL` / `DEFAULT_EXECUTOR_MODEL`
  等常量没有删除，它们现在是"API 不可达/未探测"时的兜底名；**离线兜底时模型名可能不是最新**，
  界面会提示"模型名可能不是最新的"。要彻底消除这个边界，需要联网拉一次 `/v1/models`。
- **非家族线上新模型**可被选中，但没有家族规格可依，能力字段可能为空/未知。
- **状态条上下文占用是估算**：生成中用"上一轮 used + 本轮字符估算"并标 `≈`，
  只有 `done` 带回 budget 后才显示精确值；不新增轮询是刻意取舍。
- **`permissionSource` 的来源粒度**：只有 `explicit|preset|config`；后台任务与 REPL 内
  `/preset` 切换的来源暂为 `null`（与 §3.64 一致）。
- **未改内核事件协议**：状态条/错误卡/权限卡都只消费既有事件与既有 `/api/state` 字段。
- **真机未复跑**：本版验证是本地全量门禁 + CI 三平台（含 Windows 与 4 条 desktop build）；
  负责人真机上的模型端点本轮未逐一复跑。

## 验证

- 全量门禁（逐项单独跑、逐项取 `$?`）：`npm run typecheck` 0 / `npm run typecheck:strict` 当前 0 基线 0 /
  `node test/smoke.js` **156 组全通过（单独跑）** / `node test/e2e-local.js` 17 项 /
  `node test/e2e-web.js` 24 项 / `node test/e2e-schedule.js` 11 项 / `node test/api-contracts.js` 8 项 /
  `node test/pack-ctx-privesc.js` 4 组 / `node test/ledger-source.js` 7 组 /
  `node test/model-names.js` 7 组 / `node test/mutate/selfcheck.mjs` **8/8** /
  `npm run bench` **5 套 0 失败** / `node test/mutate/run.mjs` **25/25 批、292/292 条全中** /
  `node scripts/doc-lint.mjs` 全通过 / `node src/cli.js diagnose` 正常。
- 发布提交只含发布文件（CHANGELOG / RELEASE-NOTES / `package.json` / `package-lock.json` /
  `desktop/package.json`）；`git diff --name-only <门禁SHA>..<tagSHA> -- src test` 为 **0 行**。
