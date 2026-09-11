# Deyi-TCM-Harness 回迁指南（v0.5.0 → Pack API v1）

> **已按下游真实代码核对**（核对对象：`Deyi-TCM-Harness@c6b4397`，文件
> `layer/providers/dify.mjs`、`docs/ARCHITECTURE.md`、`README.md`）。
> 核对后更正了两处会误导回迁的地方：§3.1.1 补上「同名多命中」这条**模型之前的安全闸门**
> （初版只举了 `随访` 命令，把安全关键的那条漏了）；§6 更正「执行账本不可用」的过期说法
> （v0.6.0 已交付）。指南里凡是标注「按真实代码核对」的结论，都来自读代码而不是推测。


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

#### 3.1.1 ⚠ 两条「模型之前」的短路，不能当成普通工具直接搬

> 本节是按**下游真实代码**核对后补写的（核对对象：`Deyi-TCM-Harness@c6b4397`，
> 文件 `layer/providers/dify.mjs` 的 `chat()`）。初版指南只举了 `随访` 一条，
> 漏掉了下面第 2 条——而它才是安全关键的那条。

下游的 `chat()` 里有**两处**在调用模型**之前**就返回的短路分支：

| # | 触发 | 现状行为 | 直接改成工具会怎样 |
| --- | --- | --- | --- |
| 1 | `^(回访\|随访)\s*(.*)$` | 不调用 Dify、不走问诊，直接产出看板/随访话术（`usage: {0,0}`） | 多一次模型往返（延迟与 token 开销）。**若在意这点**：保留在下游 Provider 里是允许的——`<home>/providers/` 本就是下游的自留地（见 §6） |
| 2 | **同名多命中** `match.ambiguous` | **直接返回候选列表、请医师确认，不落盘、不问诊**（`dify.mjs` 中 `if (match.ambiguous)` 分支） | ⚠ **这是安全降级**：现在的语义是「**Provider 在模型之前就拒绝继续**」，改成普通工具后变成「模型自行决定要不要先问一句」。对「同名多命中不静默合并、避免混病历」这条医疗安全属性，**把决定权从内核交给模型是不可接受的** |

第 2 条的正确迁移方式不是「做成工具」，而是**用约束引擎把它升级为内核强制**（这正是 v0.5.0 约束确定性存在的意义）：

```js
// packs/tcm/pack.mjs 的 constraints —— 让「没有确认病历号就不得写入」由内核强制，
// 且对**所有**写类工具生效，不依赖模型自觉、可审计、可被测试阻断。
constraints: [
  { id: 'must-have-patient', kind: 'tool-arg-require', tool: 'intake_collect', requireArg: 'patientId' },
  { id: 'must-have-patient', kind: 'tool-arg-require', tool: 'visit_compare',  requireArg: 'patientId' },
  // 采集缺项照样由 completeness 兜住（见 §3.2）
]
```

这样得到的性质**比现状更强**：现状只在「同名多命中」这一种情况下拒绝，而 `tool-arg-require` 是
「**任何**没有确认病历号的写入都拒绝」——把「避免混病历」从一条 if 分支变成一条内核不变量，
并且进审计、可回放（§6 的账本已可用）。

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

#### 3.3.1 逐参数核对结论（`deepseekJson` → `ctx.llm()`）

> 按下游真实代码逐参数核对过（`dify.mjs` 的 `deepseekJson`），**可以等价替换**：

| 下游 `deepseekJson` 的线上参数 | `ctx.llm()` 的写法 | 核对结果 |
| --- | --- | --- |
| `model: 'deepseek-v4-flash'`（硬编码） | `model` | ✅ |
| `temperature: 0` | `temperature: 0` | ✅ 支持（缺省回落到会话温度） |
| `max_tokens: maxTokens` | `maxTokens` | ✅（缺省 2048，受模型输出上限封顶） |
| **`thinking: { type: 'disabled' }`** | `reasoningEffort: 'off'` | ✅ **线上参数完全一致**——内核在 `reasoningEffort==='off'` 时正是发 `thinking:{type:'disabled'}` |
| 自己 `indexOf('{')…lastIndexOf('}')` 再 `JSON.parse` | `json: true` | ✅ 内核 `ctx.llm` 用**同一套**花括号切片解析，结果放在 `data`；解析失败为 `null` 而**不抛错**（与下游返回 `null` 同语义） |

一个必须注意的差异：下游 `deepseekJson` 用 `deepseekKey` 直连，**usage 不入账**（这正是要迁的原因）；
改走 `ctx.llm()` 后 usage 并入当前回合 → 今日费用、缓存命中、峰谷、日护栏同时生效。

#### 3.3.2 密钥从哪来（一个必读的坑）

`ctx.llm()` 解析密钥走**内核**，顺序是（`src/credentials.js` 的 `resolveApiKey`，已按代码核对）：

1. `process.env[<服务商的 envKey>]`（DeepSeek 即 `DEEPSEEK_API_KEY`）
2. **`process.env.MINGDAO_API_KEY`**（通用兜底）
3. 凭证库 `<MINGDAO_HOME>/credentials.json` 里以**服务商名**为键的字段（如 `deepseek`）
4. `cfg.apiKey`

好消息：第 3 步读的就是下游现在写的那**同一个文件、同一个字段**（下游 `dify.mjs` 的
`creds.deepseek`）——只要 `MINGDAO_HOME` 是同一个目录，迁移后**不需要搬密钥**。

> ⚠ **坑（已实测复现）**：第 2 步的 `MINGDAO_API_KEY` **优先于**第 3 步。
> 机器上只要残留一个指向别的服务商的 `MINGDAO_API_KEY`，域内调用就会带着**那个** key
> 打到 DeepSeek 端点（或反之）——表现为 401 或「费用算到莫名其妙的账上」。
> 回迁时请检查环境变量：`env | grep -E 'MINGDAO_API_KEY|DEEPSEEK_API_KEY'`。

另一个前置条件：`ctx.llm({ model })` 里的模型名必须是内核**能解析**的——
要么是内置名（`deepseek-v4-flash`），要么在上游 `config.json` 的 `customModels` 里声明过
（含 `baseUrl`）。否则 `ctx.llm` 直接抛「未配置 API Key」，而下游原来的 `deepseekJson`
是自己硬编码 URL 的、不会有这个问题。推荐显式写入凭证库：

```bash
mingdao key set deepseek <你的 DeepSeek Key>     # 写入 <MINGDAO_HOME>/credentials.json
```

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

## 六、上游能力现状（回迁时按此判断能依赖什么）

> 本节已按 **v0.6.0** 实际交付情况更正。初版把「执行账本导出/回放」也列进了缺口，
> 但它在 v0.6.0 已经落地——照旧文办事会让下游白做一套替代方案。

**已可用（可以依赖）**

- **执行账本与决策回放（v0.6.0 确定性③）**：`mingdao ledger list/show/export/verify/replay`。
  对下游的意义：域内模型调用（经 `ctx.llm()`）与约束触发都会进账本，
  「这次结论是怎么来的」可离线回答；`ledger export` 脱敏后可交第三方复核。
  回放还能当**下游 CI 门禁**：`now-blocked > 0` 时退出码为 1。
- `permissions.fs` 显式路径 + `completeness` / `tool-deny` / `tool-arg-require` / `arg-forbid` /
  `output-forbid` / `result-forbid`（后两者见 `PACK-API.md §4`，`result-forbid` 于 v0.6.0 补齐实现）。
- 出网白名单 `config.net` + `mingdao net report`（**注意边界**：只覆盖内核经 HTTP 出口与自更新
  联系的目标，不覆盖 MCP 服务器、以及工具自己起的子进程——见 `CONFIG.md` 出网白名单一节）。

**仍缺（请勿依赖）**

- `ctx.storage`：Pack 私有持久化命名空间（当前用 `permissions.fs` 显式路径替代）；
- `ctx.provider`：由 Pack 贡献非 OpenAI 兼容 Provider（当前 Dify 适配仍放 `<home>/providers/`）；
- **Pack 私有存储加密（医疗 PII）**：**不在 v0.6.0**（初版写「→ v0.6.0」是不准确的，特此更正）。
  下游若有 PII 落盘加密要求，请在上层自行处理（如加密文件系统 / 应用层加密）；
- 账本的**可选签名**（`--sign-key`）未实现：当前只有哈希链完整性校验，
  **不含可信时间戳**，不要当成审计级不可否认。

**能力缺口登记（契约里列了但没实现，别照文档写）**：`require-citation` 约束 kind、
`mingdao constraint test <pack>` —— 见 `PACK-API.md §4.1`。
