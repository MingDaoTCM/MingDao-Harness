# PLAN-v0.6.0「合规与确定性」— 落地计划

> 依据：`STRATEGY-0.5.md` §四·确定性③（行为确定性）+ §六 阶段 C（v0.6.0）。
> 前置：v0.4.6 审计登记表**仓库内条目已全部收口**（见 `AUDIT-v0.4.6.md` 后续轮次索引），
> v0.5.0「垂域 Pack 契约」已发布（tag `v0.5.0`），Pack API v1 冻结。
> 纪律：同 v0.5.0——每步可独立验证；全绿门禁（6 套测试 + strict 0/0 + tsc 0）+ 新增回归断言；
> 每个「能测的行为」都要有断言，每个「测不了的边界」都要写进文档而不是假装覆盖。

---

## 〇、为什么是这三件事（而不是继续加能力）

头部厂商在拼**能力上限**：更强的模型、更多的工具、更大的生态。这些我们追不平，也不该追。
私有化 / 受监管场景真正卡住采购的是另外三件事，而云平台的多租户托管模型**架构上给不了**：

| # | 确定性 | 状态 |
| --- | --- | --- |
| ① | **约束确定性**——红线由内核强制，不是提示词里的一句话 | ✅ v0.5.0（约束引擎，6 kind × 3 时机） |
| ② | **成本确定性**——每一分钱可归因、可预测、可拦截 | ✅ v0.5.0（`ctx.llm()` 统一出口 + Pack 级预算） |
| ③ | **行为确定性**——每步可审计、可回放、可追责 | ⏳ **本计划** |

③ 的现状差距：`audit.jsonl` 只是**工具调用**的追加日志，粒度不足以回答
「这个结论是怎么来的、当时依据什么规则、花了多少钱」，也不能回放。这就是 v0.6.0 要补的。

---

## 一、目标与验收（一句话）

给定一次历史执行，能够**离线**回答并证明：**每一步做了什么、触发了哪条规则、花了多少钱、数据有没有出网**；
且这些结论可以**脱敏导出**交给第三方复核。

**硬验收（DoD）**：

1. 一次真实回合结束后，`mingdao ledger show <runId>` 能完整呈现「模型轮次 / 工具调用 / 约束触发 /
   权限决策 / 费用」五类事件，且**默认导出即已脱敏**（密钥、私网 IP、家目录路径三级规则，复用 `src/redact.js`）。
2. `mingdao ledger export --since --until --format json|md` 产出的文件**不含任何密钥与私网地址**——
   有回归断言：把故意构造的密钥喂进一次执行，导出物中必须搜不到明文。
3. `mingdao ledger replay <runId>` 能在**不联网**的前提下，把账本里的工具调用序列按**当前**的
   权限/约束栈重放一遍，明确报告「哪些调用今天会被拒绝」——用于事故复盘与合规复检。
4. 出网白名单：`config.net.allow` 声明允许的域名/IP；命中白名单的调用逐条入账，越界的行为按
   `warn|block` 处理，并可 `mingdao net report` 导出「本机这段时间访问了哪些外部地址」用于自证。
5. 离线安装：`install.sh --offline`（或独立脚本）在**无外网**环境完成安装，零 npm 依赖拉取；
   附信创/国产推理栈的 Provider 预设（OpenAI 兼容端点为主）。

---

## 二、关键设计决策（先拍板，再动手）

### C0.1 账本与 audit.jsonl 的关系：新建，不改写历史

`audit.jsonl` 有两个不适合当账本的既有性质：**20000 行截断**（回放会缺段）与**只记工具调用**。
因此新建 `~/.mingdao/ledger/`，**不动** `audit.jsonl` 的既有语义（`mingdao audit` 行为不变）。

- 一回合一个文件：`ledger/<runId>.jsonl`，`runId = <启动时刻 base36>-<随机 6 位>`。
- 追加写、600 权限、每条 `JSON.stringify` 一行（与 audit 同款，便于 `tail -f` 与流式处理）。
- **不做截断**，改为按容量配额轮转（保留最近 N 个 run / M MB，超限删最旧并在索引里标记「已轮转」）。
  理由：合规账本被静默截断比不记更糟——看起来有、实际上缺。

### C0.2 事件 schema（v1 冻结，字段只增不改）

统一信封 + 类型化载荷，全部字段可 JSON 序列化（不得塞入 live 对象）：

| 事件 | 关键字段 |
| --- | --- |
| `run.start` | `runId, at, model, provider, session, cwd, permission, preset, packs[]` |
| `model.round` | `round, step, at, ms, firstTokenMs, usage{prompt,completion,cacheHit,cacheMiss}, finish, requestStartAt` |
| `tool.call` | `callId, name, pack?, argsDigest, args(redacted, 截断), permission{decision,reason}, constraint?` |
| `tool.result` | `callId, ok, exitCode, ms, resultDigest, resultSize, truncated, error?` |
| `constraint` | `kind, id, stage(pre\|post\|output), tool?, action, matched(不回显命中短语)` |
| `permission` | `name, mode, decision(allow/deny/ask), source(rule/交互/hook), rule?` |
| `cost` | `model, usage, pricing{in,out,cacheHit,batch,window}, yuan, priced:boolean` |
| `net.egress` | `host, port, allowed, reason, bytesOut?` |
| `run.end` | `at, ms, status, steps, rounds, yuanTotal, capHit, truncated, aborted` |

两条纪律：
- **`priced:false` 必须显式存在**——无价模型绝不写 `¥0.0000` 冒充免费（沿用 v0.4.5 的诚实原则）。
- **约束事件不回显被命中的短语**（沿用 v0.4.7 `blockedOutputText` 的做法），否则账本本身成了泄露渠道。

### C0.3 关联与脱敏：写入时脱敏，导出时再脱敏一次

- **写入时**就用 `redactSecrets` 处理 `args`（与 audit 一致，避免明文密钥先落盘再靠导出兜）。
- **导出时**再跑一遍 `redactSensitive`（叠加私网 IP + 家目录），因为导出物是**对外**的。
- 摘要用 `sha256(原文)` 前 16 位（`argsDigest`）：既能证明「两次执行的这一步完全相同」，
  又不泄露原文；`replay` 用摘要校验账本未被篡改。

### C0.4 签名：不引入依赖，做「可校验的完整性」而非「不可否认」

零依赖是硬约束（等保/信创评测门槛），不引入 OpenSSL 绑定或第三方库。因此：

- 账本每行带 `prev`（上一行的 hash）形成**哈希链**；`ledger verify <runId>` 校验链完整。
- 可选 `--sign-key <ed25519 私钥文件>`：Node 内置 `crypto` 已支持 Ed25519，**零新增依赖**。
- 诚实边界：**没有可信时间戳**，签名只能证明「账本自签署起未被改动」，不能证明「生成时刻」。
  文档必须这么写，不得暗示成审计级不可否认。

### C0.5 回放语义：重放「决策」，不重放「模型」

真正的「同一模型重放同一路径」不可靠（模型非确定性、且要求离线有同一权重）。
我们**不承诺**这个。承诺并交付的是：

- **决策回放**：把账本里的工具调用序列（名称 + 参数摘要 + 参数）按**当前**权限/约束栈重新评估，
  输出三类差异：`now-denied`（今天会被拒）/ `now-constrained`（今天会触发约束）/ `args-changed`（参数摘要不符）。
- 价值明确：合规复检（「新加的红线能不能拦住历史上那批操作」）与回归测试（把生产事故账本变成测试用例）。
- `--model` 可选：若给了 provider，则连模型一起跑（best-effort，结果可能不同，输出标注为 `live`）。

---

## 三、交付物与顺序

### C1. 执行账本 + 导出（约 1 周）

| 项 | 内容 | 验收 |
| --- | --- | --- |
| C1.1 | `src/ledger.js`：事件写入 / runId 管理 / 哈希链 / 配额轮转 / 读取与校验 | 单测：写入可读回、链校验能测出篡改、轮转保留最近 N |
| C1.2 | 接线 `src/agent.js`：`run.start`、`model.round`、`tool.call`、`tool.result`、`run.end` | 一次真实回合（fake provider）产出完整事件序列，断言事件类型齐全且顺序合法 |
| C1.3 | 接线约束/权限：`constraint`、`permission` 事件（复用已有 `onConstraintEvent` 与权限决策点） | 三时机各产出一条事件；`tool-deny` 拦住时 `permission=allow` 但 `constraint=block` 两个事件都在（证明「权限放行 ≠ 可以执行」） |
| C1.4 | 费用：`cost` 事件（含 `priced` 与峰谷窗口标记） | 有价模型 `priced:true` 且金额与 `recordUsage` 一致；无价模型 `priced:false` |
| C1.5 | `src/commands/ledger.js`：`list / show / export / verify` | `export --format md` 产出人工可读报告；`verify` 能报出被改过的那一行 |
| C1.6 | 脱敏回归 | ✅ 已做：喂入含 `sk-` / Bearer / **嵌套**私网 IP / 家目录的参数，导出物与落盘文件中都搜不到明文（**这是本步最重要的断言**） |

**C1 实施记录（已完成部分）**：
- 八类事件全部接线，实测一次真实回合（fake provider + 工具调用）产出
  `run.start → model.round → tool.call → tool.result → model.round → cost → run.end`，哈希链完整；
- 约束事件只在 `auditConstraint` **一处**记账——三个时机本已汇聚到那里，新增时机无需补埋点；
- `status` 与模型层 `finish_reason` 分开（前者是「这次怎么结束的」，后者记在 `model.round` 里），
  否则账本会出现 `status=stop` 这种答不出「完成了没有」的记录；
- 费用按**发起时刻**计价（与 `recordUsage` 同口径），无价模型落 `priced:false` + 「无法估算」；
- 单测 71 组：事件顺序与 seq 连续、哈希链能发现改行**与删行**、两级脱敏**含嵌套结构**、
  无价不冒充免费、配额轮转、非法 runId 拒绝（防路径穿越）。三项关键行为均做变异校验。
- 另修一处自己写出的真缺陷：`redactDeep` 曾把脱敏函数写死为 `redactSecrets`，导致导出时
  「顶层字符串过了 `redactSensitive`、嵌在 `args` 里的私网 IP 原样输出」——同一份导出物上
  两级规则不一致，是最容易被忽略的泄露路径。

**接线点（已勘察，供实施时直接定位）**：`src/agent.js` 中
`runTurn` 起点（`:307`，已在此处建 `usage`/`startedAt`）、每轮 usage 回调（`:452` 附近）、
`provider.chat` 调用（`:620`）、`prepTool` 的权限检查（`:785`）与 `checkPreTool`（`:798`）、
`runTool` 中的 `writeAudit`（`:871`）与 `checkPostTool`（`:889`）、输出约束 `checkOutput`（`:382`）、
`runTurn` 的 finally（`:1111` 附近）。**优先复用已有的回调位（`onConstraintEvent`、`onUsage`/`perf`）**，
而不是把逻辑揉进循环体——这样账本缺失/报错时可以整体短路，绝不影响主流程（与 `writeAudit` 同款容错）。

### C2. 决策回放（约 3–4 天）

| 项 | 内容 | 验收 |
| --- | --- | --- |
| C2.1 | `mingdao ledger replay <runId>`：按当前权限/约束栈重评工具序列 | 构造「账本里放行、今天会被 tool-deny 拦住」的用例，输出 `now-denied` |
| C2.2 | 差异报告（json / 人读表格），含「同一摘要」与「参数已变」两类 | 断言两类差异都能被区分 |
| C2.3 | 可选 `--live`：带 provider 一起跑 | 无 provider 时明确报错，不静默降级 |

### C3. 出网白名单与自证（约 3–4 天）

| 项 | 内容 | 验收 |
| --- | --- | --- |
| C3.1 | `config.net = { allow: [...], mode: 'warn'\|'block' }`；域名/IP 匹配（支持 `*.example.com` 与 CIDR） | 单测：白名单命中/未命中/子域/大小写/端口 |
| C3.2 | 在 `fetch`/`http` 出口统一判定：越界记 `net.egress` 事件并按 mode 处理 | block 模式下未列入白名单的请求被拒且入账；warn 模式放行但入账 |
| C3.3 | `mingdao net report [--since]`：导出「本机访问过哪些外部地址」 | 输出含 host/次数/是否命中白名单；**不含**请求体 |
| C3.4 | 诚实边界 | 只覆盖**内核自己发起**的请求；bash 里用户自己 `curl` 不走此闸门——文档必须写明，不得声称「全面阻断数据外发」 |

### C4. 离线/内网安装 + 信创预设（约 3–4 天）

| 项 | 内容 | 验收 |
| --- | --- | --- |
| C4.1 | 离线安装：打包 tarball，安装过程零外网（不 `npm install`，运行时本就零依赖） | 断网环境（或 `--offline` 模式）跑通安装 + `mingdao --version` |
| C4.2 | 内网 Provider 预设：vLLM / Ollama / OneAPI / 国产推理栈（OpenAI 兼容端点） | 预设出现在 `PROVIDERS`，`config.json` 可一键切换 |
| C4.3 | 离线校验：`install.sh --offline` 不访问网络（可用「把 http 代理指向黑洞」验证） | 安装日志中无任何外部连接尝试 |

### C5. 发布（约 2 天）

版本 0.6.0；CHANGELOG + `RELEASE-NOTES-0.6.0.md`；tag `v0.6.0`；
README 增「合规与确定性」小节（含 C0.4/C3.4 两处诚实边界）；`docs/LEDGER.md` 契约文档。

---

## 四、非目标（本阶段明确不做）

- **不做「模型级确定性回放」**（见 C0.5）：模型非确定性 + 需要同一权重离线可用，承诺了也做不到。
- **不做审计级不可否认签名**（见 C0.4）：无可信时间戳，只能证明「自签署后未改动」。
- **不做全流量 DLP**：出网闸门只覆盖内核发起的请求（见 C3.4）；不做进程级抓包/流量还原。
- **不改 Pack API v1**：本阶段只增内部能力；Pack 契约的兼容性加固留给 v0.5.x（按 Deyi 回迁反馈）。

---

## 五、风险与依赖

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 账本写盘影响主流程性能 | 每步多一次 append | 与 audit 同款容错（try/catch 静默）、单文件追加、`config.ledger=false` 可关 |
| 账本成为新的泄露面 | 比不记更糟 | 写入即脱敏 + 导出再脱敏 + 摘要替代原文 + 约束事件不回显命中短语（C0.3/C0.2） |
| 事件 schema 反复改 | 下游解析器碎 | v1 冻结「只增不改」；变更走 `docs/CHANGELOG-PACK.md` 同款的变更日志 | 
| 下游 Deyi 回迁反馈改变优先级 | C1–C4 顺序需调整 | Pack API 与账本解耦；回迁反馈只影响 v0.5.x，不阻塞 C1 |
| 出网闸门被误解为「全面防泄露」 | 合规误判 | C3.4 写入 README 与 `LEDGER.md`，并在 `net report` 输出末尾打印边界说明 |

---

## 六、进度（滚动更新）

| 阶段 | 状态 | 产出 |
| --- | --- | --- |
| C0 设计拍板 | ✅ 完成 | 本文件 §二（五条决策 + 两条诚实边界） |
| C1 账本 + 导出 | 🚧 进行中 | `src/ledger.js`（写入器/哈希链/两级脱敏/配额轮转/导出）+ `src/commands/ledger.js`（list/show/export/verify）+ agent 接线（run.start / model.round / tool.call / tool.result / constraint / permission / cost / run.end 八类全部落地）|
| C2 决策回放 | ⏳ 待开始 | — |
| C3 出网白名单 | ⏳ 待开始 | — |
| C4 离线安装 + 信创预设 | ⏳ 待开始 | — |
| C5 发布 | ⏳ 待开始 | — |

> 上游另有一条**不阻塞**本计划的待办：Deyi-TCM 回迁在 Linux 原机执行，
> 按 `MIGRATION-DEYI-v0.5.md` 落地，其反馈进入 v0.5.x 的 Pack 契约加固。
