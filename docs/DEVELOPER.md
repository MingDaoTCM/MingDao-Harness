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
