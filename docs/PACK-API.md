# 垂域 Pack API v1（草案）

> 状态：**草案 / 待实现**（目标版本 v0.5.0）。本文是上游与下游之间的接口契约。
> 定位：让垂域团队（中医、法律、教育、制造、政务…）**不修改内核源码**就能做出可私有化、可审计、受约束的智能体。
> 关联：`STRATEGY-0.5.md`（战略）、`DEVELOPER.md`（现有扩展点）、`CONFIG.md`（配置）。

---

## 0. 为什么需要 Pack（下游实证）

`Deyi-TCM-Harness` 今天把整个中医域逻辑写进了 `<home>/providers/dify.mjs` 的 `chat()` 里。这不是下游的错——是上游缺抽象。由此造成的损失：

| 应有的能力 | 现状 |
| --- | --- |
| 权限引擎门控 | 域内「工具」是 `chat()` 里的正则匹配，绕过 `permissions.js` |
| 审计追溯 | 不写 `audit.jsonl` |
| 费用与护栏 | 域内模型调用硬编码 `usage: 0`，不计费、不触护栏 |
| UI 工具卡片 / 流式思考 | 只能手工 `onDelta({text})` |
| 独立版本与兼容 | 整文件覆盖，无 `apiVersion`、无 CI 校验 |
| 记忆 / 技能 / 预设复用 | 全部用不上 |

**Pack 就是把这个缺口补上**：把垂域能力变成内核的一等公民，与内置工具走同一条链路（权限 → 审计 → schema 瘦身 → 费用归因 → 约束校验）。

---

## 1. 目录与文件

```
<pack-dir>/
  pack.json          # manifest：身份、版本、兼容窗口、贡献声明（可静态校验）
  pack.mjs           # contributions：导出 createPack(ctx) → { tools, ... }（按需）
  prompts/*.md       # 可选：提示词段
  skills/*/SKILL.md  # 可选：随包技能（复用现有 SKILL.md 格式）
```

安装位置（三级遮蔽，优先级高者胜）：
1. `<项目>/.mingdao/packs/<name>/`（项目级，私有）
2. `<MINGDAO_HOME>/packs/<name>/`（用户级）
3. 包内 `packs/`（内置，仅官方参考实现使用）

`config.json` 声明：

```jsonc
{
  "packs": [
    "./packs/tcm",                          // 本地目录
    "npm:@mingdao/pack-legal",              // npm 包（需 --allow-npm）
    "https://example.com/pack-tcm.tgz"      // 归档（需 --allow-remote + sha256）
  ]
}
```

---

## 2. `pack.json`（manifest）

```jsonc
{
  "apiVersion": 1,                       // 必填：本 Pack 面向的 Pack API 主版本
  "name": "tcm",                         // 必填：唯一名（[a-z0-9-]{2,32}）
  "displayName": "中医垂域层",
  "version": "0.2.0",                    // 必填：Pack 自身版本（semver）
  "engines": { "mingdao": ">=0.5 <0.7" },// 必填：兼容的内核版本窗口
  "description": "中医问诊采集 / 复诊四态 / 回访追踪",
  "author": "…",
  "license": "private",

  "permissions": {                       // Pack 声明它需要的宿主能力（最小权限，加载时校验）
    "fs": ["<home>/intake/**", "<home>/patients.json"],
    "net": ["https://dify.example.com"],
    "env": ["DIFY_API_KEY"]
  },

  "contributes": {
    "tools": true,                       // 由 pack.mjs 提供
    "provider": "dify",                  // 复用/覆盖 Provider 名
    "presets": ["presets/tcm.json"],
    "promptSections": ["prompts/tcm-domain.md"],
    "constraints": ["constraints.json"],
    "skills": ["skills/tcm-intake"],
    "commands": ["tcm:recall", "tcm:followup"]
  }
}
```

**校验规则（加载时即失败并告警，绝不崩启动）：**
- `apiVersion` 不在内核支持列表 → 拒绝加载，提示升级内核或降级 Pack；
- `engines.mingdao` 与本内核版本不匹配 → 拒绝加载；
- `name` 冲突 / 保留名（`mcp`、`core`）→ 拒绝；
- `permissions.fs` 越出 `config.fsAllowDirs` → 拒绝；
- 任何 contributions 声明但文件缺失 → 拒绝该条并告警，其余继续。

---

## 3. `pack.mjs`（contributions）

```js
// 垂域 Pack 入口：纯 ESM，**不引入任何 npm 依赖**（与内核同约束）
export const apiVersion = 1;

export function createPack(ctx) {
  // ctx（宿主注入，只读 + 受控能力）：
  //   ctx.home            MINGDAO_HOME
  //   ctx.workingDir      当前工作目录
  //   ctx.cfg             生效配置（只读快照）
  //   ctx.log(msg)        写入内核日志（自动脱敏）
  //   ctx.llm(opts)       统一模型出口（见 §5，自动计入费用/护栏/审计）
  //   ctx.readJson(p)/writeJsonAtomic(p, o)   受 permissions.fs 白名单约束的原子读写
  //   ctx.audit(entry)    写审计事件（自动带 pack 名）
  //   ctx.storage         包私有持久化命名空间（<home>/packs/<name>/data/）
  return {
    tools: [
      {
        name: 'intake_collect',            // 内核自动加前缀：pack__tcm__intake_collect
        description: '中医问诊采集：缺失必填项必须继续追问，不得编造。',
        parameters: { type: 'object', properties: { patientId: { type: 'string' } }, required: ['patientId'] },
        readOnly: false,                   // 进权限引擎；readOnly 的进只读档与只读子代理
        // 声明本工具受哪些约束（约束引擎在 PreToolUse / PostToolUse 强制）
        constraints: ['ten-questions-complete', 'no-cross-patient'],
        async run(args, toolCtx) {         // toolCtx = ctx + { signal, sessionRef }
          const prev = await toolCtx.readJson(`intake/${args.patientId}/latest.json`).catch(() => null);
          const summary = await toolCtx.llm({ model: 'deepseek-v4-flash', system: '…', user: '…' });
          return { ok: true, output: '…', data: { prev, summary } };  // data 不进模型上下文，仅供 UI/约束
        },
      },
    ],

    // 领域提示词段：注入系统提示的独立段落（预设/记忆/技能之后，可声明顺序）
    promptSections: [{ id: 'tcm-domain', order: 100, content: '你是中医知识工作助手，不输出诊疗结论。' }],

    // 领域约束（见 §4）
    constraints: [
      { id: 'no-diagnosis-conclusion', kind: 'output-forbid', pattern: '有效|好转|治愈|确诊为', action: 'block' },
      { id: 'ten-questions-complete', kind: 'completeness', tool: 'intake_collect',
        fields: ['zhushu','zhenduan','hanre','han','toushen','erbian','yinshi','xiongfu','kouke','jiubing'],
        onMissing: 'reject' },
      { id: 'no-cross-patient', kind: 'tool-arg-require', tool: 'intake_read', requireArg: 'patientId', action: 'block' },
    ],

    // 可选：领域记忆条目的结构（内核按此做语义检索与注入）
    memorySchema: { fields: ['patientId', 'fact', 'source', 'at'] },
  };
}
```

**命名与隔离**
- 所有 Pack 工具在内核注册为 `pack__<packName>__<toolName>`，避免跨 Pack 与内置冲突；
- 权限规则、审计事件、费用分账、UI 卡片全部带 `pack` 维度；
- Pack 之间默认互不可见（除非 manifest 显式 `dependsOn`）。

---

## 4. 约束引擎 v1

约束是**内核级强制**，不是提示词建议。执行时机三处：

| 时机 | 可用的 kind | 行为 |
| --- | --- | --- |
| PreToolUse | `tool-deny`、`tool-arg-require`、`arg-forbid` | 命中即阻止执行，回填工具错误给模型，写审计 |
| PostToolUse | `completeness`、`result-forbid` | `completeness` 缺项 → 拒绝该工具结果，要求模型补采；`result-forbid` → 屏蔽结果并提示 |
| 输出前 | `output-forbid`、`require-citation` | 命中 → 按 `action` 处理：`block`（改为固定合规文案）/ `block-and-rewrite`（再请求一次修正）/ `warn`（放行并标注） |

约束事件统一结构（进执行账本）：

```jsonc
{ "at": 1757…, "pack": "tcm", "constraint": "no-diagnosis-conclusion",
  "kind": "output-forbid", "stage": "pre-output", "action": "block-and-rewrite",
  "matched": "好转", "session": "…", "model": "deepseek-v4-flash" }
```

**设计原则**
- 约束**只能收紧、不能放松**权限（约束不授予任何权限）；
- 约束失败**默认 fail-closed**（拿不准就阻断并提示），与 hooks 同口径；
- 每条约束必须有 `id`，便于审计与测试；
- 提供 `mingdao constraint test <pack>`：对每条约束跑一遍内置反例样本（下游 CI 用）。

---

## 5. 统一模型出口 `ctx.llm()`

Pack 内**禁止**自己 `fetch` 模型接口（否则费用隐身、护栏失效、无法归因）。统一走：

```js
const out = await ctx.llm({
  model: 'deepseek-v4-flash',
  system: '…', user: '…',
  maxTokens: 2000,
  reasoningEffort: 'off',        // 复用内核的模型能力表与参数校验
  json: true,                    // 结构化输出（内核负责解析与重试）
  purpose: 'patient-extract',    // 归因标签（进账本与分账）
});
// → { text, data, usage: { prompt_tokens, completion_tokens, prompt_cache_hit_tokens, … } }
```

内核在 `ctx.llm()` 内自动完成：
1. 走 `resolveProviderConfig` 与 Provider 重试/超时策略；
2. usage 并入当前回合 → **今日费用、缓存命中率、峰谷、日费用护栏全部生效**；
3. 分账维度记录 `(pack, tool?, purpose, model, session)`；
4. 写审计事件（脱敏）；
5. 受当前权限模式与预算约束（超预算按护栏 action 处理）。

> 这一条直接修复「域内调用 `usage: 0`」问题——**Pack 内不可能再有隐身花费**。

---

## 6. 兼容性与版本策略

| 内核版本 | Pack API | 承诺 |
| --- | --- | --- |
| 0.5.x | v1 | 冻结；minor 只增不改；Pack 无需改动即可升级 |
| 0.6.x | v1 | 继续支持（窗口 = 最近 2 个 minor） |
| 1.0.x | v2（若需要） | major 升级，提供迁移指南 + codemod（可行时） |

**下游义务**：在 `pack.json` 声明 `apiVersion` 与 `engines.mingdao`，并把 `mingdao pack verify` 放进 CI。

**上游义务**：任何 Pack API 变更必须同步更新本文 + 兼容性矩阵 + `docs/CHANGELOG-PACK.md`。

---

## 7. CLI

```bash
mingdao pack list                 # 已加载 Pack / 来源 / 版本 / 兼容状态
mingdao pack verify <dir>         # 静态校验 manifest + 文件齐全 + 约束合法性（下游 CI 门禁）
mingdao pack new <name>           # 脚手架
mingdao pack info <name>          # 贡献面：工具/约束/提示词段/权限/费用统计
mingdao pack test <name>          # 跑内置反例样本（约束 + 工具契约）
mingdao constraint test <name>    # 单独跑约束反例
```

---

## 8. 与现有扩展点的关系（不替代，只补位）

| 现有扩展点 | 定位 | Pack 的关系 |
| --- | --- | --- |
| 自定义 Provider（`providers/*.mjs`） | 接入非 OpenAI 兼容协议 | Pack 可**贡献** Provider，但域逻辑不应再写进 `chat()` |
| Agent Preset（JSON） | 声明式智能体（提示词+工具白名单+权限+模型） | Pack 可携带 Preset；Preset 仍是用户可选的「档位」 |
| `registerTool`（程序化） | 单工具注册 | Pack 是其**批量 + 声明式 + 可分发**的封装（内核内部仍走 `registerTool`） |
| `config.tools`（shell 包装） | 无代码的简单工具 | 保持不变（零代码场景）；需要状态/约束/归因时用 Pack |
| Hooks | 生命周期拦截（外部进程） | 约束引擎是**进程内、可移植、可测试**的规则层；Hooks 仍可叠加 |

---

## 9. 待定问题（实现前需拍板）

1. **Pack 是否允许声明式 `provider` 覆盖内置同名 Provider？**（当前倾向：不允许覆盖内置，只允许新增）
2. **约束 `output-forbid` 的 `block-and-rewrite` 计费归属**：修正请求算 Pack 的费用还是内核的？（倾向：算 Pack）
3. **Pack 内 `fetch` 一律禁止，还是允许但需在 `permissions.net` 白名单内并强制入账？**（倾向：允许 + 白名单 + 入账，因为部分域需要直连业务系统）
4. **Pack 私有存储是否加密**（医疗/法律 PII）？v1 先不做，v0.6 「合规与确定性」阶段再定。
