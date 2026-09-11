# Deyi-TCM-Harness 回迁指南（v0.5.0 → Pack API v1）

> 面向：下游 Line B（中医垂域层，Linux 原机开发）
> 上游契约：`PACK-API.md`（v1 已冻结）· 变更史 `CHANGELOG-PACK.md`
> 触发：**v0.5.0 发布即回迁**（决策已确认）。目标：把 3 个域工具从 `providers/dify.mjs` 的 `chat()` 里搬出来。
> 纪律：下游**只通过扩展点接入，绝不修改上游源码**；内核 bug 在上游修。

---

## 一、为什么必须迁（迁移前的真实损失）

当前 `Deyi-TCM-Harness/layer/providers/dify.mjs` 把整个中医域逻辑写进了 Provider 的 `chat()`。这是上游缺抽象导致的，不是下游的问题。具体损失：

| 应有能力 | 迁移前现状 |
| --- | --- |
| 权限引擎门控 | 域内「工具」是 `chat()` 里的正则匹配（`/^(回访\|随访)\s*(.*)$/`），绕过 `permissions.js` |
| 审计追溯 | 不写 `audit.jsonl`——无法回答「谁在何时读了哪位患者的病历」 |
| **费用与护栏** | 域内每次 DeepSeek 调用硬编码 `usage: { prompt_tokens: 0, completion_tokens: 0 }` → **完全不计费、不触发日费用护栏** |
| UI 工具卡片 / 流式 | 只能手工 `opts.onDelta` |
| 独立版本与兼容 | 整文件覆盖，无 `apiVersion`，无法 CI 校验 |
| 记忆 / 技能 / 预设复用 | 全部用不上 |

迁移后这六项全部进入内核的既有链路。

---

## 二、目标结构

```
Deyi-TCM-Harness/
  layer/
    packs/
      tcm/
        pack.json            # manifest（apiVersion / engines / permissions / contributes / budget）
        pack.mjs             # createPack(ctx) → tools / constraints / promptSections
        prompts/domain.md    # 中医领域提示词（从 README 的职责描述落成正式文本）
        constraints.json     # 三条领域红线（也可内联在 pack.mjs）
  examples/config.example.json
  install.sh                 # 改为安装 packs/ 而不是 providers/
```

`providers/dify.mjs` 里的**Dify 调用本身**保留为 Provider（协议适配是 Provider 的职责）；
**三个域工具、四条流程、患者注册表、四态对比、回访看板**迁到 `pack-tcm`。

---

## 三、逐项迁移

### 3.1 三个「命令式工具」→ 真工具

迁移前（`chat()` 内字符串匹配，无权限、无审计、无卡片）：

```js
const fu = /^(回访|随访)\s*(.*)$/.exec(query);
if (fu) { /* …直接产出文本，手工 opts.onDelta… */ }
```

迁移后：

```js
// packs/tcm/pack.mjs
export function createPack(ctx) {
  return {
    tools: [
      { name: 'intake_collect',  description: '首诊十问采集与病历落盘（缺项必须继续追问）', parameters: {…}, readOnly: false, run: intakeCollect },
      { name: 'visit_compare',   description: '复诊四态对比（消失/减轻/无变化/加重，只陈述事实）', parameters: {…}, readOnly: false, run: visitCompare },
      { name: 'followup_board',  description: '回访看板与单患者随访（趋势 + 预警 + 话术草稿）', parameters: {…}, readOnly: true,  run: followupBoard },
    ],
    // …
  };
}
```

注册后内核自动加前缀：`pack__tcm__intake_collect` 等，与内置工具走**同一条**权限 / 审计 / schema 瘦身 / 费用链路。

### 3.2 三条红线 → 约束引擎（从提示词升级为内核强制）

| 现有红线（写在 prompt 里） | 迁移后的约束声明 |
| --- | --- |
| 缺项绝不编造 | `{ id:'ten-questions', kind:'completeness', tool:'intake_collect', fields:['zhushu','zhenduan','hanre','han','toushen','erbian','yinshi','xiongfu','kouke','jiubing'], onMissing:'reject' }` |
| 不输出诊疗结论 | `{ id:'no-diagnosis', kind:'output-forbid', pattern:'有效\|好转\|治愈\|确诊为', action:'block-and-rewrite' }` |
| 不得跨患者串病历 | `{ id:'no-cross-patient', kind:'tool-arg-require', tool:'intake_collect', requireArg:'patientId' }` |

执行时机：调用工具前（工具/参数）、工具返回后（缺项则**拒绝该结果**并回填「请继续采集」）、正文输出前（**回填会话历史之前**改写/拦截）。命中写审计事件。

> 注意：`output-forbid` 的 `block` / `block-and-rewrite` **不回显**命中的措辞——回显会把违规表述重新写进正文与历史。

### 3.3 域内模型调用 → `ctx.llm()`

迁移前（费用隐身）：

```js
const res = await fetch(`${deepseekBaseUrl}/chat/completions`, { … });
return { text, usage: { prompt_tokens: 0, completion_tokens: 0 } };   // ← 这笔钱谁也看不到
```

迁移后：

```js
async function deepseekJson(system, user, maxTokens = 2000) {
  const r = await ctx.llm({ model: 'deepseek-v4-flash', system, user, maxTokens, json: true, purpose: 'patient-extract' });
  return r.data;   // json:true 时内核已解析
}
```

收益：usage 并入当前回合 → 今日费用 / 缓存命中率 / 峰谷 / 日费用护栏**同时生效**；并写一条 Pack 归因记录（`cost=null` 标记，与回合级总账不重复计费），`mingdao cost --by pack` 可见。

`purpose` 建议取值：`patient-extract`（患者识别）、`intake-extract`（结构化落盘）、`visit-compare`（四态对比）、`followup-script`（随访话术）。

### 3.4 患者注册表与快照落盘 → 受权限约束的 IO

`patients.json` / `intake/**` 的读写改用 `permissions.fs` 声明的路径（内核据此校验越界）：

```json
"permissions": { "fs": ["<MINGDAO_HOME>/patients.json", "<MINGDAO_HOME>/intake/**"] }
```

同时建议把 `saveRegistry` 的 `writeFileSync` 换成上游的原子写语义（避免崩溃时半写）——这是**下游自己的代码**，上游只提供契约。

### 3.5 领域提示词 → `promptSections`

把现在散在 `chat()` 里的角色/边界说明提炼成 `prompts/domain.md`，以 `promptSections` 注入：

```json
"promptSections": ["prompts/domain.md"]
```

内核按 `order` + `pack/id` **确定性排序**，字节稳定 → 不破坏 DeepSeek 前缀缓存。

---

## 四、迁移步骤（建议顺序）

1. `mingdao pack new tcm`（在 Deyi 仓库里生成 `packs/tcm/` 脚手架）；
2. 把 `dify.mjs` 的 `intakeCollect` / `visitCompare` / `followupDashboard` / `patientFollowup` 搬到 `pack.mjs`，
   函数体基本不动，只把「读凭据 + 直接 fetch」换成 `ctx.llm` + `ctx` 提供的只读信息；
3. 把患者的 JSON 读写挂到 `permissions.fs` 声明的路径；
4. 把三条红线写成 `constraints`；
5. 把领域提示词抽成 `prompts/domain.md`；
6. `layer/providers/dify.mjs` 只保留 **Dify 协议适配**（`createProvider` → `chat`），
   域逻辑全部移出；`install.sh` 改为安装 `layer/packs/` 到 `$MINGDAO_HOME/packs/`；
7. `mingdao pack verify ./layer/packs/tcm` 必须退出 0；
8. 在 Deyi CI 里加：`mingdao pack verify ./layer/packs/tcm`。

**验收（DoD）**：
- 域内每次 DeepSeek 调用都出现在 `mingdao cost --by pack` 里；
- 三条红线可被测试**阻断**（缺项 / 结论性措辞 / 缺 patientId 各一条断言）；
- 三个工具在 WebUI 显示为正常工具卡片；
- 同名多命中仍返回候选列表（不静默合并）——行为不回归。

---

## 五、兼容性与版本

| 项 | 约定 |
| --- | --- |
| 声明 | `pack.json` 写 `apiVersion: 1` + `engines.mingdao: ">=0.5 <0.7"` |
| 支持窗口 | 上游承诺支持最近 2 个 minor（0.5 / 0.6 支持 v1） |
| 上游变更 | 任何 Pack API 变更同步更新 `PACK-API.md` + `CHANGELOG-PACK.md` + 兼容性矩阵 |
| 下游义务 | 每个上游 minor 发布后跑一次 `pack verify`，并入 CI |
| 破坏性变更 | 走 major + 迁移指南（如可行再配 codemod） |

**内核 bug 一律在上游修**：下游遇到的问题如果是「扩展点不够用/行为不对」，直接反馈上游，
不要在下游 fork 内核——这条边界是上下游能长期并行的前提。

---

## 六、上游仍需补齐（下游可先按本节设计，勿依赖）

- `ctx.storage`：Pack 私有持久化命名空间（当前用 `permissions.fs` 显式路径替代）；
- `ctx.provider`：由 Pack 贡献非 OpenAI 兼容 Provider（当前 Dify 适配仍放 `<home>/providers/`）；
- Pack 私有存储加密（医疗 PII）→ v0.6.0「合规与确定性」；
- 执行账本导出 / 可回放（确定性③）→ v0.6.0。

以上四项在 v0.5.0 **不可用**，请勿在回迁中依赖。
