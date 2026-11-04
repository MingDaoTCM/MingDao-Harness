# MingDao Harness 开发者指南

> 契约化起于 v0.4.0；本指南不绑定具体版本，接口稳定性以 `src/index.js` 的 `@stable`/`@experimental` 标注为准。

> 战略依据：[STRATEGY-NEXT.md](internal/STRATEGY-NEXT.md)（垂直产品 × 开放内核）。
> 本指南面向**用 MingDao 做二次开发 / 定制自己智能体**的开发者。
> 稳定契约：`@stable` 导出在 minor 版本内保持向后兼容；`@experimental` 可能调整。

## 零、三种使用方式

| 方式 | 适合 | 命令 |
| --- | --- | --- |
| 产品终端 | 开箱即用的 DeepSeek 省钱 Coding Agent | `npm i -g mingdao-harness && mingdao` |
| **Agent Preset** | 不改代码，声明式定制智能体（本指南重点） | `mingdao --preset <名>` |
| **库嵌入** | 把 Agent 嵌进自己的 Node 程序 | `npm i mingdao-harness` + `import { createAgent } from 'mingdao-harness'` |

零依赖承诺：安装无 node_modules 树；公共 API 只用 Node ≥18.17 内置能力。

## 一、Agent Preset：声明式定制智能体

### 1.1 什么是预设

一个 JSON 文件 = { 系统提示定制段, 工具白名单, 权限模式, 模型建议, 参数 }。
放在三个位置（同名后者遮蔽前者）：

1. `<项目>/.mingdao/presets/<名>.json` — 项目级（随项目走）
2. `~/.mingdao/presets/<名>.json` — 用户级（本机全局）
3. `presets/`（随 npm 包分发）— 内置参考。**内置预设的定位：只提供参数类默认值——不携带人格、
   不限制工具、不涉及权限**（发行版面向普通大众，不为某种任务做定制）。因此内置**只有一个**：
   - `local-model` —— **只放"让本地模型跑得动"的参数**（`contextBudget`/`maxOutputTokens`/`maxRounds`）。
     本地模型只是替换云模型 API，**功能一致**：所以它不带人格、不限制工具、不涉及权限。
   - 老名字 `local-audit` 保留为**别名**（指向 `local-model`）：按老名字调用仍可用，且会打印一次
     「已更名」提示（CLI/内核日志）并在 WebUI 用 banner 说明——改名兼容，但不静默。
     若你自己在项目级/用户级写了 `local-audit.json`，**以你的文件为准**（别名只在没找到同名预设时兜底）。
   - v0.6.16 起内置**不再有**「只读代码审计」预设（`readonly-audit` 已删除：代码审计只是负责人拿
     MDH 做的一次较长任务的测试，发行版不做任务定制）。要只读效果请**自己组合**权限档（`readonly`）
     与工具白名单（`tools`）——见 §1.2。

### 1.2 格式

```json
{
  "name": "code-reviewer",
  "label": "代码审查员",
  "description": "只读审查并输出分级报告",
  "systemPrompt": "你是代码审查员。只读审查，按严重度分级输出，每条带文件:行号证据。",
  "tools": ["read", "ls", "glob", "grep", "skill", "git", "fetch", "todo"],
  "permission": "auto",
  "recommendedPermission": "readonly",
  "model": "deepseek-v4-flash",
  "temperature": 0.3,
  "maxOutputTokens": 4096,
  "maxRounds": 4,
  "contextBudget": 96000
}
```

字段全部可选（缺省保持当前配置）。`tools` 白名单外的工具对模型不可见、调用会被硬拦。
未知字段会**校验报错**（防拼写错误静默失效）。
`model` 是**建议**：CLI 在未显式 `-m` 时采纳；WebUI 以用户当前选择的模型为准（预设不覆盖）。

`permission` 与 `recommendedPermission` **不是一回事**（v0.6.14 起）：

| 字段 | 语义 | 谁该用 |
| --- | --- | --- |
| `permission` | **覆盖**本回合的权限档（仍受反提权规则约束：只能更保守，不能更宽松） | 第三方/老预设；**内置预设不涉及权限，不使用它** |
| `recommendedPermission` | **建议**：只透出给界面/诊断，**不参与判定、不覆盖用户选择** | 第三方/自写预设想表达"建议档"时可用；**内置预设不使用它**（避免任何权限偏好暗示） |

只读的**硬约束**是 `tools` 白名单（不含 `write`/`edit`，模型连写工具都看不到），不是权限档。
内置预设不替你决定权限档，也不限制工具：要只读就**自己组合** `permission.mode: "readonly"` 与 `tools` 白名单。

#### 参数怎么给"本地模型"用（v0.6.15）

给本地部署模型写预设时，**只调参数、别加人格**——本地模型与云模型功能一致，它需要的是
"预算合适"，不是"换个角色"：

```json
{ "name": "my-local", "label": "我的本地模型", "contextBudget": 65536, "maxOutputTokens": 4096, "maxRounds": 4 }
```

- `contextBudget` 是**最要紧的一个**：本地引擎的 prefill 时间与内存随上下文线性上涨
  （本机 35B Q4_K_M 实测约 4.9ms/token：2 万 tokens ≈ 1.6 分钟、13 万窗口 ≈ 10 分钟以上，
  且大上下文会顶满引擎内存预算）。给 32k–65k 通常就够单个模块级任务。
- 模型窗口/最大输出等**能力声明**请写在 `config.customModels.<模型名>`
  （`contextWindow`/`maxOutputTokens`/`local`），不要再写一份进预设——两处会漂移。
- 想同时要"本地模型的保守参数 + 只读"：预设**不能叠加**（一次只能选一个内置预设），而且 v0.6.16 起
  内置不再提供只读审计预设。自己的做法是**复制一份 `local-model` 再按需合并**：在 `tools` 白名单里
  只留只读工具，权限档在你那一层显式选 `readonly`（预设里**不要**写 `permission`/`recommendedPermission`
  ——那会分别造成"沉默覆盖"与"权限偏好暗示"）。

### 1.3 使用

- CLI：`mingdao --preset code-reviewer "审查 src/ 目录"`；交互模式 `mingdao --preset code-reviewer`。
- REPL：`/preset` 列出全部；`/preset code-reviewer` 会话内切换（工具白名单/权限/参数即时生效）。
- WebUI：输入框旁「预设…」下拉选择（随本次发送生效，服务端按会话应用）。
- 程序化：`import { loadPreset, presetConfigOverrides, presetSystemBlock } from 'mingdao-harness'`。

## 二、第三方工具：registerTool / config.tools

### 2.1 程序化注册（嵌入自己程序时）

```js
import { registerTool, createAgent } from 'mingdao-harness';

registerTool({
  name: 'weather',
  description: '查询城市天气',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  run: async (args, ctx) => ({ ok: true, output: `${args.city}：晴 24°C` }),
});
// 之后 createAgent 的模型就能调用 weather；执行走统一权限/审计/省钱链路。
```

约束：名字 `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`、不得与内置 13 工具同名、不得重复注册；
`run` 抛异常会转成结构化错误回填（不中断会话）。

### 2.2 声明式挂载（config.json，不改代码）

```json
{ "tools": [ { "name": "date-now", "description": "当前时间", "command": "date" } ] }
```

`command` 经 `/bin/bash -lc` 执行；**参数以 `MINGDAO_TOOL_ARGS`（JSON）环境变量传入**——
不做字符串拼接（防注入），由命令自行解析；执行受权限引擎门控（与 bash 同权重）。
改 config.tools 需重启生效（与 MCP 预设一致）。

## 二之补、垂域 Pack（v0.5.0，Pack API v1）

Preset 定制的是「提示词 + 工具白名单 + 权限」；**Pack 定制的是「一个行业的智能体」**——
领域工具、领域红线、领域提示词、领域费用归因，全部作为可安装单元打包，且**不改内核源码**。

```bash
mingdao pack new tcm             # 脚手架：pack.json + pack.mjs + prompts/domain.md
mingdao pack verify ./packs/tcm  # 静态契约校验（下游 CI 门禁：非 0 退出即失败；**不执行 Pack 代码**）
```

最小 `pack.mjs`：

```js
export const apiVersion = 1;
export function createPack(ctx) {
  return {
    tools: [{
      name: 'intake_collect',
      description: '采集并落盘；缺项必须继续追问',
      parameters: { type: 'object', properties: { patientId: { type: 'string' } }, required: ['patientId'] },
      readOnly: false,
      async run(args, toolCtx) {
        // 统一模型出口：usage 自动入账 + 受日费用护栏约束 + Pack 归因
        const r = await toolCtx.llm({ model: 'deepseek-v4-flash', system: '…', user: '…', purpose: 'patient-extract' });
        return { ok: true, output: r.text, data: { /* 供 completeness 约束校验的字段 */ } };
      },
    }],
    constraints: [
      { id: 'no-cross-patient', kind: 'tool-arg-require', tool: 'intake_collect', requireArg: 'patientId' },
      { id: 'ten-questions', kind: 'completeness', tool: 'intake_collect', fields: ['zhushu', 'zhendan'] },
      { id: 'no-conclusion', kind: 'output-forbid', pattern: '好转|治愈|确诊为', action: 'block-and-rewrite' },
    ],
    promptSections: [{ id: 'domain', order: 100, content: '…' }],
  };
}
```

三条要点：

1. **领域红线由内核强制**，不是提示词建议。三个时机：调用工具前（工具/参数）、工具返回后（缺项则拒绝该结果）、正文输出前（回填会话历史**之前**改写/拦截）。命中写审计事件。
2. **Pack 内模型调用必须走 `ctx.llm()`**。自己 `fetch` 模型接口会让费用隐身、日费用护栏失效、`--by pack` 看不到——`pack verify` 会对此给出静态告警。
3. **只收紧、不放松**：约束不授予任何权限，也不改变 `permissions.js` 的判定。

完整契约（manifest 字段、约束 kind、`ctx.llm` 语义、版本兼容窗口）见 [PACK-API.md](PACK-API.md)；
Pack API 变更史见 [CHANGELOG-PACK.md](internal/CHANGELOG-PACK.md)。

## 三、库嵌入：最小示例

```js
import { createProvider, createAgent, createPermission, createIO } from 'mingdao-harness';

const provider = await createProvider(cfg, 'deepseek-v4-flash'); // cfg: 同 config.json 结构
const io = createIO(); // 或自实现 print/ask 接口
const agent = createAgent({
  provider,
  permission: createPermission('ask', io),
  io,
  modelName: 'deepseek-v4-flash',
  workingDir: process.cwd(),
  cfg,
});
const res = await agent.runTurn([
  { role: 'system', content: '你是代码助手。' },
  { role: 'user', content: '帮我看看 package.json 的依赖' },
]);
console.log(res.text, res.usage, res.perf);
```

## 四、公共 API 速查（@stable 面）

| 分组 | 导出（共 70 个 `@stable`） |
| --- | --- |
| Agent 内核 | `createAgent` · `createPermission` · `createIO` · `style` · `C` |
| Provider 与模型 | `createProvider` · `resolveProviderConfig` · `MODELS` · `PROVIDERS` · `modelPreset` · `providerPreset` · `resolveModelCaps` · `safeBudget` · `isLocalBaseUrl` |
| 工具（含 v0.4.0 第三方注册） | `toolSchemas` · `dispatch` · `registerTool` · `listRegisteredTools` · `mountConfigTools` · `buildToolSchemas` |
| Agent Preset（v0.4.0） | `listPresets` · `loadPreset` · `validatePreset` · `presetConfigOverrides` · `presetSystemBlock` · `presetDirs` |
| 垂域 Pack（v0.5.0 契约，Pack API v1） | `listPacks` · `loadPack` · `validateManifest` · `mountPacks` · `satisfiesRange` · `packDirs` · `coreVersionOf` · `loadedPackNames` · `SUPPORTED_PACK_API` · `CONSTRAINT_KINDS` |
| 约束引擎（v0.5.0 契约，Pack API v1 的领域红线） | `compileConstraints` · `checkPreTool` · `checkPostTool` · `checkOutput` · `blockedOutputText` · `toolMatches` |
| 上下文与压缩 | `trimMessages` · `approxTokens` · `clampText` · `TOOL_RESULT_LIMIT` · `compactConversation` · `summarizeConversation` |
| 配置与凭证 | `mingdaoHome` · `ensureHome` · `loadConfig` · `saveConfig` · `runWizard` · `effectiveApiKey` · `credentialsPath` · `loadCredentials` · `saveCredentials` · `getStoredKey` · `setStoredKey` · `removeStoredKey` · `maskKey` · `resolveApiKey` |
| 计价与计量 | `estimateCost` · `estimateCostLabel` · `isPeakHour` · `PRICE_DATA_AS_OF` · `countTokens` · `heuristicTokens` · `makeTokenCounter` · `isTokenizable` |

`@experimental`（接口可能调整，共 19 个）：`updateCheck` · `mingdaoUpdate` · `mingdaoRollback` · `findRepoRoot` · `writeAudit` · `listAudit` · `redactSecrets` · `auditFile` · `trustSkill` · `skillDirHash` · `readSourceMeta` · `tamperedSkillNames` · `McpClient` · `startMcpServers` · `createSession` · `latestSession` · `listSessions` · `appendMessages` · `loadSession`。

> 本表由 `node scripts/gen-api-table.mjs` 从 `src/index.js` 生成；`scripts/doc-lint.mjs` 会校验它与代码一致（漂移即失败）。

## 五、约定

- 预设/工具的扩展点沿用既有安全链路（权限引擎、审计、脱敏、沙箱），**不提供绕过入口**。
- 公共 API 变更必须过测试门禁（smoke 含「公共 API 导出面」断言）+ 发布前自检。
- 自定义 Provider 模块（非 OpenAI 兼容协议）见 [PROVIDERS.md](PROVIDERS.md)。

## 六、UI 改动必须先用 `node scripts/ui-shot.mjs` 截图自查

> 背景：v0.6.19 前端约 2,561 行改动只有字符串/桩 DOM 断言、没有渲染真实页面，真机出现界面凌乱/按钮失灵（§3.79/§3.80）。改 `src/web/**` 的人必须先留下真实 Electron 截图。

1. 跑一次默认截图：起真实 `src/cli.js web`、用 Electron 打开带 token 的 URL，产出 `home.png` / `settings.png` / `palette.png` / `session.png`；临时 `MINGDAO_HOME` 在退出时自动删除。
2. 至少覆盖三档宽度与暗/亮两主题：`--viewport wide|mid|narrow`（1440/1000/880）+ `--theme dark|light`；窄屏必须单独跑一次 `--viewport narrow`。
3. 逐张打开 `/tmp/mdh-shots/*.png` 检查布局、遮挡、白底白字与按钮可见性；截图不对就不要提交 UI 改动（工具对服务/Electron/页面报错/截图失败分别以非 0 退出）。

```bash
node scripts/ui-shot.mjs --viewport narrow --theme light --out /tmp/mdh-shots-narrow-light
```

## 七、覆盖率口径与棘轮（v0.7.0）

> 背景：v0.6.31 及以前，`scripts/coverage-report.mjs` 把每个文件所有 `count>0` 的 V8 区间
> **取并集**来判"这一行覆盖了没有"。V8 的区间是**嵌套**的，而模块外壳（顶层函数体）区间横跨
> 全文——只要文件被 import 过，外壳区间就覆盖整份文件，未执行的分支与从未调用的函数体统统被
> 算成"已覆盖"。后果：仓库自报 88.7%，真实 code-lines 只有 63.9%（差 18.2pp），"覆盖率最低
> 的 8 个文件"全部显示 95–99%。尺子坏了，"绿"就不可信。

### 7.1 三种口径

| 口径 | 分母 | 分子 |
| --- | --- | --- |
| `code-lines`（主指标 / 门禁） | 排除空行与纯注释行后的代码行 | 有执行的代码行 |
| `all-lines`（保守下界） | 文件全部行（含空行 / 纯注释行） | 同上 |
| `functions` | 已加载文件里 V8 `functions` 数组的函数（**不含模块外壳**） | `ranges[0].count > 0`（函数被调用过） |

- 空行 / 纯注释行不可能被执行，所以两个行口径的**分子相同**，差别只在分母：
  `all-lines ≤ code-lines` 恒成立。别把 `all-lines` 当主指标（它会被注释多的文件稀释）。
- `functions` 里排除的是 V8 为模块包的那层函数体（`functionName === ''` 且区间横跨全文），
  它不是业务函数。未加载文件在 `functions` 口径里没有函数数据（0/0），其代价由行口径承担。
- 判定算法（`computeLineCoverage`）：对每行的**第一个非空白代码字符**取包含它的**最内层（叶子）
  区间**，该区间 `count > 0` 才算覆盖。父区间**不代表**子行覆盖——未执行的分支 / 函数体本身
  就是一条 `count=0` 的更内层区间。
- 纯注释 / 空行的判定是**简单词法启发式**（项目此前没有实现）：逐字符扫描，跳过 `//`、`/* */`
  （可跨行）与字符串 / 模板字面量。**不解析正则字面量**——`/["']/` 这类写法可能让扫描器误进
  字符串状态，只影响"哪一行算代码行"，不影响区间计数；要精确就得引入真正的解析器。
- 已知保守点：函数声明行（`function foo() {` 与函数体同处一行）在 V8 里属于该函数自己的区间，
  函数从未调用时这一行按未覆盖计。它只会让数字偏低，不会把没执行的代码算成绿色。
- **与 v0.6.31 自审数字的关系（避免误读）**：旧"父区间并集"口径的 all-lines 88.7% 可以逐位复现
  （31794/35846 行）；审计文里的"真实 70.5%（全行）/ 63.9%（仅代码行）"用的是另一套行锚点与分母
  （注释行按外层区间算覆盖、分母不含空行；行尾锚点），**同一份数据**按那套口径实测是
  71.1% / 64.3%。本实现选"行首代码字符 + 空行/注释行恒未覆盖"，所以 all-lines 更低
  （50.1%）、code-lines 略高（68.4%）。差别只在"同一行的哪个偏移代表这一行"，不是
  "叶子区间"原则本身——套件钉住的是原则（父区间不得覆盖子行），与锚点选择无关。

### 7.2 为什么不许用"父区间并集"

V8 块覆盖率（`isBlockCoverage`）的语义是：一条区间的计数只作用于**没有被更内层区间覆盖的部分**。
把 `count>0` 的区间取并集，等于宣布"父区间执行过 ⇒ 它里面的每一行都执行过"，与 V8 的语义正相反；
模块外壳又恰好横跨全文，于是缺陷被放大成"import 过 = 全覆盖"。它让未执行的分支、从未调用的
函数体在报告里变成绿色——覆盖率门禁因此失去意义，而不是"数字难看"的问题。

正确做法就是 7.1 的"最内层区间"：区间天然嵌套（V8 保证父子关系），用"外层先入栈、行推进时
弹出已结束区间、栈顶即叶子"的单遍扫描即可。`test/coverage-metric.js` 用手写 V8 片段把这条
算法钉住（嵌套 / 兄弟 / 整文件函数 / 未执行函数 / 纯注释 / 空文件 / 多进程合并）。

### 7.3 基线（ratchet）

`scripts/coverage-baseline.json` 记录三口径真实基线（含 `generatedAt` 与 `node` 版本）：

```json
{
  "version": 1,
  "generatedAt": "<ISO 时间>",
  "node": "v24.x",
  "platform": "darwin arm64",
  "srcFiles": 90,
  "note": "过渡基线；发布前重生成",
  "metrics": {
    "code-lines": { "covered": 0, "total": 0, "pct": 0 },
    "all-lines": { "covered": 0, "total": 0, "pct": 0 },
    "functions": { "covered": 0, "total": 0, "pct": 0 }
  }
}
```

- `npm run coverage`（= `node test/run-all.mjs --coverage && node scripts/coverage-report.mjs`）
  逐项比较，**任一指标低于基线即 exit 1**（相等通过，只许升不许降）。
- 比较带 **-0.2pp 容差**（`RATCHET_TOLERANCE_PP`）：只吸收 `63.94 → 63.9` 这类四舍五入与
  同一次提交内的微小噪声；真正的回退（≥0.3pp）照样红。容差**不是**"允许慢慢降"的配额。
- 首行仍是旧格式（`行覆盖率（分母 = src 全部 N 个文件）：X%（h/l 行）· 阈值 T%`），
  其中 X 现在是 code-lines 的真实值，阈值默认取基线的 code-lines；可用
  `MINGDAO_COVERAGE_THRESHOLD=70` 覆盖成绝对下限（例如临时收紧门禁）。
- 要抬升基线（补了测试 / 确认口径变化）时**显式**运行 `npm run coverage:baseline`
  （= `node scripts/coverage-report.mjs --update-baseline`）：它把三口径、生成时间与 node 版本
  写回基线文件，review 里能看到这次"抬升"是刻意做的。**规矩：抬基线必须与"让覆盖率变好/口径
  变化"的改动在同一次提交里完成**，不允许单独提交一个"把门槛调低"的基线 diff。
  已有的 `note` 字段会被保留，要改说明就加 `--note "..."`。**不要**为了变绿去改算法或手工改数字。
- 指定数据目录：`node scripts/coverage-report.mjs --dir /tmp/cov`（或 `MINGDAO_COVERAGE_DIR=/tmp/cov`）。
  本地完整复现：

  ```bash
  rm -rf /tmp/cov && NODE_V8_COVERAGE=/tmp/cov node test/run-all.mjs
  node scripts/coverage-report.mjs --dir /tmp/cov
  ```

- 报告里"覆盖率最低的 8 个文件"现在按 **code-lines 升序**取真正的低覆盖文件（旧实现按行数
  降序取末 8 个 = 最小的 8 个文件，所以那行标题下的名单从来没和"最低覆盖"对应过）。
- 基线是在本机 Node v24 / macOS 上实测生成的；CI 覆盖率腿跑 Linux + Node 20。V8 对同一份源码
  的块区间理论上一致，若 CI 实测略有出入，应按 CI 的实测值重建基线并在提交说明里写明原因。

## 八、变异覆盖盲区检查（v0.7.0 §1.2）

> 变异验证回答的是「**改坏了的代码会不会被抓到**」；它不回答「从没被改过的模块安不安全」。
> 2026-11 的自审实测：633→669 条变异里 4 个文件占了 285 条，而 90 个模块里 43 个**一条变异都没有**。
> 分数高只说明「改过的都测了」，盲区模块在报告里是**沉默**的——这一节把沉默变成可复跑的清单。

### 8.1 三件套：行为套件 → 变异批次 → 盲区检查

给一个「有真实逻辑但 0 条变异」的模块补覆盖，顺序不能颠倒：

1. **先建行为套件**（`test/<模块>-<主题>.js`）。没有套件就没有可抓的变异。
   - 调**真实函数**看结果，不做源码文本匹配；
   - 用本机临时目录（`fs.mkdtempSync(path.join(os.tmpdir(), ...))`）+ 桩服务端，不连网；
   - 每条断言带稳定前缀（如 `E1：`、`P7：`、`W13：`），后面写变异批次要用它当关键词。
2. **再写变异批次**（`test/mutate/batchNN-<主题>.mjs`，参照 `batch72`/`73`/`74`）。
   - 只改 `src/**` 里**最容易写错**的那一行：整键替换 vs 合并、mtime 丢失、围栏少一层 realpath、
     软链不判、能力声明不校验、错误被吞……；
   - 每条都在套件上**真跑一遍**，必须红；
   - `expect` 填**失败输出里真实出现的关键词**（断言原文的一部分）。
     本仓在这上面踩过两次：一次是 `expect` 写了同一断言组里另一条分支的文案；一次是
     `'工具名非法'` 同时出现在 `registerTool` 的兜底报错里，变异把 Pack 层主动告警删掉后
     **仍然命中**、看起来"抓到了"。所以 `expect` 要尽量长、尽量是**你删掉的那条路径**独有的话。
3. **跑一遍盲区检查**（下节），确认这个模块从清单里消失。

### 8.2 盲区检查：`scripts/mutation-coverage.mjs`

```bash
node scripts/mutation-coverage.mjs                 # 只报告（退出 0）
node scripts/mutation-coverage.mjs --fail-over 0   # 盲区数 > 0 即失败（CI 卡新增盲区）
node scripts/mutation-coverage.mjs --fail-over 13  # 只允许存量 13 个（存量基线，逐步下调）
node scripts/mutation-coverage.mjs --min-lines 150  # 调整"有真实逻辑"的代码行门槛
node scripts/mutation-coverage.mjs --json          # 机器可读
```

口径（简单、可解释）：

- **代码行** = 去掉空行与纯注释行后的行数（逐字符识别 `//`、`/* */`；字符串里的 `//` 不算注释）。
- **变异条数** = 该文件在全部 `test/mutate/batch*.mjs` 的 `file:` 字段里出现的次数（只统计 `src/**`）。
- **盲区** = 代码行 > `--min-lines`（默认 150）且变异条数 = 0。

`--fail-over N` 的语义：**盲区模块数 > N 时非零退出**；不带该参数绝不失败（只报告）。
CI 想"只卡新增盲区"就用当前存量数当基线（例如 `--fail-over 13`），想"一个都不能有"就用 0。
本任务**未**把它接进 `.github/workflows/ci.yml`（不在允许改动范围）——接线时注意：直接上
`--fail-over 0` 会让今天的存量盲区全部变红，应先按存量收敛。

### 8.3 当前盲区清单（2026-11-04，v0.6.32 / HEAD b5cd199 + 本任务三批变异）

`node scripts/mutation-coverage.mjs` 的实跑输出（如实抄录；数字随后续批次变化，**以脚本输出为准**）：

```text
变异覆盖盲区检查（阈值：代码行 > 150 且 0 条变异）
  src 模块：91 个；src/** 变异条目：630 条；盲区模块：13 个

  模块（按代码行降序）：
  模块                        代码行  变异
  src/ui.js                    600     0
  src/mcp.js                   303     0
  src/tokenizer.js             302     0
  src/commands/sync.js         288     0
  src/update.js                244     0
  src/web/viewmodel.js         243     0
  src/web/i18n.js              225     0
  src/commands/skill.js        218     0
  src/web/util.js              198     0
  src/commands/update.js       187     0
  src/commands/schedule.js     181     0
  src/skill-registry.js        171     0
  src/compact.js               154     0

  合计：13 个模块、3314 行代码没有可抓的变异。
```

本任务补掉的三处（此前均 0 条）：

| 模块 | 行为套件 | 变异批次 | 条数 |
| --- | --- | --- | --- |
| `src/sync.js` 状态增量 / 冲突 / 边界 | `test/sync-state.js`（16 项） | `test/mutate/batch72-sync-state.mjs` | 10 |
| `src/packs.js` manifest / 版本 / 能力声明 / 信任门 | `test/packs-capabilities.js`（16 项） | `test/mutate/batch73-packs.mjs` | 10 |
| `src/workspace.js` 注册表 / 归一 / 跨进程锁 | `test/workspace-fence.js`（15 项） | `test/mutate/batch74-workspace.mjs` | 11 |

> 模块边界如实说明：`src/workspace.js` 本身**不含**路径围栏（`withinRoot`），围栏真实实现于
> `src/tools/fs-tools.js` 与 `src/web/routes/domains/workspace.js`。`batch74` 的 11 条里有 8 条打在
> `src/workspace.js`，2 条打在前者的 `withinRoot`，2 条打在后者（允许根 / realpath 两层围栏）。
> 另外 `src/sync.js` 在本任务前已有 1 条（`batch70` ⑦），并非严格 0 条。

### 8.4 边界

- 本任务的三个新套件**没有**接进 `test/run-all.mjs` 与 CI（不在允许改动范围）。要接的话，
  在 `SUITES` 里加 `['sync-state', 'node', ['test/sync-state.js']]` 等三行即可；
  三个套件都是零外部依赖、只用本机临时目录。
- 盲区检查只回答"有没有变异"，不回答"变异质量"——`--fail-over` 只能挡住新增盲区，
  挡不住"给一个 600 行模块写 1 条无关变异"这种凑数。质量仍靠 review 与 `expect` 关键词约束。
