# MingDao Harness 开发者指南（v0.4.0 契约化）

> 战略依据：[STRATEGY-NEXT.md](STRATEGY-NEXT.md)（垂直产品 × 开放内核）。
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
3. `presets/`（随 npm 包分发）— 内置参考（已内置 `local-audit` 示例）

### 1.2 格式

```json
{
  "name": "code-reviewer",
  "label": "代码审查员",
  "description": "只读审查并输出分级报告",
  "systemPrompt": "你是代码审查员。只读审查，按严重度分级输出，每条带文件:行号证据。",
  "tools": ["read", "ls", "glob", "grep", "skill", "git", "fetch", "todo"],
  "permission": "auto",
  "model": "deepseek-v4-flash",
  "temperature": 0.3,
  "maxOutputTokens": 4096,
  "maxRounds": 4,
  "contextBudget": 96000
}
```

字段全部可选（缺省保持当前配置）。`tools` 白名单外的工具对模型不可见、调用会被硬拦。
未知字段会**校验报错**（防拼写错误静默失效）。

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

| 分组 | 导出 |
| --- | --- |
| Agent 内核 | `createAgent` · `createPermission` · `createIO` |
| Provider/模型 | `createProvider` · `resolveProviderConfig` · `modelPreset` · `resolveModelCaps` · `safeBudget` · `isLocalBaseUrl` |
| 工具 | `registerTool` · `listRegisteredTools` · `mountConfigTools` · `buildToolSchemas` · `dispatch` |
| Agent Preset | `listPresets` · `loadPreset` · `validatePreset` · `presetConfigOverrides` · `presetSystemBlock` |
| 上下文 | `trimMessages` · `approxTokens` · `clampText` · `compactConversation` |
| 配置/凭证 | `loadConfig` · `saveConfig` · `mingdaoHome` · `setStoredKey` · `maskKey` |
| 计价/计量 | `estimateCost` · `isPeakHour` · `countTokens` · `makeTokenCounter` |

@experimental（接口可能调整）：update/audit/skill-lib/skills/mcp/session 组。

## 五、约定

- 预设/工具的扩展点沿用既有安全链路（权限引擎、审计、脱敏、沙箱），**不提供绕过入口**。
- 公共 API 变更必须过测试门禁（smoke 含「公共 API 导出面」断言）+ 发布前自检。
- 自定义 Provider 模块（非 OpenAI 兼容协议）见 [PROVIDERS.md](PROVIDERS.md)。
