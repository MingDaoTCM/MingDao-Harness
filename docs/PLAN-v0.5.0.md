# PLAN-v0.5.0「垂域 Pack 契约」— 落地计划

> 依据：`STRATEGY-0.5.md` §七（阶段 A）+ §十（✅ 已确认 2026-09-11）。
> 决策：v0.5 只做 **确定性① 约束确定性 + ② 成本确定性**；③ 行为确定性（执行账本/可回放/合规导出）**放 v0.6.0**。
> 契约：接口定义见 `PACK-API.md`（v1 冻结目标）。
> 纪律：每步可独立验证；全绿门禁（6 套测试 + strict 0/0 + tsc 0）+ 新增回归断言；**v0.5.0 发布即触发 Deyi 回迁**。

---

## 〇、进度（滚动更新）

| 阶段 | 状态 | 产出 |
| --- | --- | --- |
| A0 契约冻结 | ✅ 完成 | `PACK-API.md` v1 冻结 + 三条决策拍板；`docs/CHANGELOG-PACK.md`（v1 条目） |
| A1 Pack 加载器 | ✅ 完成 | `src/packs.js`：三级遮蔽发现 / manifest 严格校验 / 极简 semver（npm 语义）/ 工具注册 / 坏 Pack 只告警 / 幂等挂载 |
| A2 CLI | ✅ 完成 | `src/commands/pack.js`：`list / verify / new / info`；`verify` 即下游 CI 门禁 |
| A3 约束引擎 | ✅ 完成（含接线） | `src/constraints.js` 三时机 + 6 kind + fail-closed；**已接入 agent**：PreToolUse（工具/参数）、PostToolUse（缺项拒绝结果）、输出前（回填历史之前改写/拦截）；约束事件写审计；CLI/WebUI/worker 启动各挂载一次 |
| A4 成本确定性 | ✅ 完成 | `ctx.llm()` 统一模型出口（usage 并入当前回合 → 今日费用/缓存/峰谷/护栏全部生效）；**Pack 归因记录**（cost=null 标记，不与回合级重复计费）；`mingdao cost --by pack`；`pack verify` 对「自建模型调用」的静态告警（A4.6）；**Pack 级预算**（A4.5：`budget.dailyYuan` + action，调用前拦截） |
| A5 提示词段 | ✅ 完成 | `buildSystemPrompt` 注入 `<pack_rules>`（按 order + pack/id 确定性排序，字节稳定不破坏前缀缓存） |
| A6 文档 | ✅ 完成 | `packs/example-hello/` 示例 + `PACK-API.md` + `CHANGELOG-PACK.md`；README「垂域 Pack」小节 + `DEVELOPER.md` Pack 章节（含最小 pack.mjs 与三条要点） |
| A7 发布 | ✅ 完成 | 版本 0.5.0；CHANGELOG + `RELEASE-NOTES-0.5.0.md`；tag `v0.5.0` |
| A7 下游回迁 | ⏳ 待下游执行 | 上游已交付 `docs/MIGRATION-DEYI-v0.5.md`；回迁在 Linux 原机进行 |

**已验证的端到端行为**（均有回归断言）：

- `pack verify/list/info/new` 四条命令可用；`example-hello` 工具进 schema 且可执行；坏 Pack 只告警不崩启动；重复挂载幂等；
- 约束三时机在真实 agent 循环里生效：`tool-deny` 拦住已获权限的工具、`completeness` 缺项时**原始结果不进入模型上下文**、输出命中红线时在**回填会话历史之前**改写/拦截（否则违规措辞会被当既成事实喂回）；
- 零约束时三处检查点全部惰性，正文原样返回（对既有行为零影响）；
- `ctx.llm` 的子调用 usage **并入父回合**（实测 1000+500+1000=2500 prompt），并在账本留下 Pack 归因记录而不重复计费；`mingdao cost --by pack` 可见。

断言规模：smoke 83 → **86 组**；6/6 套测试全绿；tsc 0 错误；strict 0/0。

**下一步**：
0. **v0.6.0「合规与确定性」已立项**：落地计划见 `PLAN-v0.6.0.md`（确定性③：执行账本 / 决策回放 /
   出网白名单自证 / 离线安装）。上游在等待下游回迁反馈的窗口期，先推进这条不依赖下游的线。
1. **下游执行回迁**（Linux 原机）：按 `MIGRATION-DEYI-v0.5.md` 把 3 个域工具搬进 `pack-tcm`，
   `pack verify` 进下游 CI；回迁中遇到的每个「别扭点」都反馈上游当契约缺陷修（dogfooding）。
2. **v0.5.x**：Pack API 按回迁反馈做兼容性加固（minor 只增不改）。
3. **v0.6.0「合规与确定性」**：确定性③——执行账本（脱敏可导出）+ 可回放 + 离线/内网安装包 + 出网白名单自证。

---

## 一、目标（一句话）

让一个垂域团队（以中医为第一个参考实现）**不改内核源码**，就能把领域工具、领域红线、领域提示词、领域费用接进内核，并让它们全部进入权限 / 审计 / 费用 / UI 链路。

**验收的硬标准**：Deyi 的 3 个域工具从 `providers/dify.mjs` 的 `chat()` 里搬进 `pack-tcm`，且：
- 每次域内模型调用都出现在 `mingdao cost report` 里（当前硬编码 `usage: 0`，完全隐身）；
- 中医三条红线由内核强制并可被测试阻断（当前只是提示词里的一句话）；
- 域工具在 WebUI 里显示为正常工具卡片（当前只能在 `chat()` 里手工 `onDelta`）。

---

## 二、交付物与顺序

### A0. 契约冻结（0.5 天）

| 项 | 内容 | 验收 |
| --- | --- | --- |
| A0.1 | 定稿 `PACK-API.md` 三个待定问题（§9）：内置 Provider 不可覆盖 / `block-and-rewrite` 计费归 Pack / Pack 内 `fetch` 允许但需白名单+入账 | 文档更新并标注「v1 冻结」 |
| A0.2 | 新增 `docs/CHANGELOG-PACK.md`（Pack API 变更日志，从 v1 起） | 文件存在且有 v1 条目 |

### A1. Pack 加载器 + manifest（2 天）

| 项 | 内容 | 验收 |
| --- | --- | --- |
| A1.1 | 新增 `src/packs.js`：`listPacks()` / `loadPack(dir)` / `validateManifest()` / `mountPacks(cfg)` | 单元断言：合法 manifest 通过、非法字段/版本不匹配/保留名被拒 |
| A1.2 | 三级遮蔽：`<项目>/.mingdao/packs/` > `<MINGDAO_HOME>/packs/` > 内置 `packs/` | 同名时高优先级胜出（断言） |
| A1.3 | `config.packs` 声明式加载（本地目录 / `npm:` / `https:` 归档 + sha256） | 三种来源各一条断言；坏 Pack 不阻塞启动（回归断言） |
| A1.4 | 工具注册进既有注册表：命名 `pack__<pack>__<tool>`，走 `registerTool` | `buildToolSchemas` 能看到；权限/审计链路复用（断言） |
| A1.5 | `permissions` 最小权限校验（fs 白名单越界即拒、net 白名单） | 越界 manifest 被拒（断言） |

### A2. CLI（1 天）

| 命令 | 行为 | 验收 |
| --- | --- | --- |
| `mingdao pack list` | 已加载 Pack / 来源 / 版本 / 兼容状态 | 输出含名称与 apiVersion |
| `mingdao pack verify <dir>` | 静态校验：manifest + 文件齐全 + 约束合法 + 权限不越界 | 合法 Pack 退出 0；坏 Pack 退出非 0 **并给出可操作原因**（下游 CI 门禁） |
| `mingdao pack new <name>` | 脚手架（pack.json + pack.mjs + 示例工具 + 一条约束） | 生成的目录 `pack verify` 通过 |
| `mingdao pack info <name>` | 贡献面 + 费用统计（A4 完成后） | — |
| `mingdao pack test <name>` | 跑内置反例样本（约束 + 工具契约） | — |

### A3. 约束引擎 v1（3 天，**本阶段核心**）

| 项 | 内容 | 验收 |
| --- | --- | --- |
| A3.1 | 约束声明解析 + 校验（`kind` ∈ tool-deny / tool-arg-require / arg-forbid / output-forbid / completeness / confirm） | 非法 kind 被 `pack verify` 拒绝 |
| A3.2 | **PreToolUse 时机**：`tool-deny` / `tool-arg-require` / `arg-forbid` → 阻止执行并回填错误给模型 | 每条 kind 一条阻断断言 |
| A3.3 | **PostToolUse 时机**：`completeness`（缺项则拒绝该工具结果并要求补采）/ `result-forbid` | 缺项场景断言：工具结果被拒、模型被要求补采 |
| A3.4 | **输出前时机**：`output-forbid` + `action` ∈ block / block-and-rewrite / warn | 命中「好转/治愈」时按 action 处理（断言） |
| A3.5 | 约束事件进审计（`pack`/`constraint`/`kind`/`stage`/`action`/`matched`） | 审计文件含该结构（断言） |
| A3.6 | 约束**只能收紧不能放松**权限（约束不授予任何权限） | 声明了约束也不改变权限判定（断言） |
| A3.7 | 失败 fail-closed | 约束求值异常时按阻断处理（断言） |

### A4. 成本确定性（2.5 天）

| 项 | 内容 | 验收 |
| --- | --- | --- |
| A4.1 | `ctx.llm(opts)`：统一模型出口（复用 Provider 重试/超时/能力表；支持 `json:true`、`purpose` 标签） | Pack 内调用一次，`usage` 非 0（断言） |
| A4.2 | usage 自动并入当前回合 → 今日费用 / 缓存命中 / 峰谷 / 日护栏全部生效 | 记录前后 `todayCost()` 增加（断言） |
| A4.3 | 四维归因账本：`(pack, tool, purpose, model, session)` | `cost report --by pack` 可见 |
| A4.4 | `mingdao cost report --by pack` / WebUI 仪表盘加 Pack 维度 | 报告含 Pack 分账表 |
| A4.5 | Pack 级预算（日/任务）与护栏 action 联动 | 超预算按 action 处理（断言） |
| A4.6 | 禁止 Pack 内直连模型接口绕过（评审用：`pack verify` 静态告警 `fetch` 到模型端点） | 告警可复现 |

### A5. 提示词段与分离（1 天）

| 项 | 内容 | 验收 |
| --- | --- | --- |
| A5.1 | `promptSections`（id + order + content）注入系统提示，位置在预设/记忆/技能之后 | 系统提示含该段（断言） |
| A5.2 | 快照语义：Pack 提示词段在会话内不变（不破坏前缀缓存） | 同回合两次构建字节一致（断言） |

### A6. 文档与示例（1 天）

| 项 | 内容 |
| --- | --- |
| A6.1 | `docs/PACK-API.md` 定稿 + 「5 分钟做出第一个 Pack」教程 |
| A6.2 | `packs/example-hello/` 内置最小示例（1 工具 + 1 条 output-forbid 约束） |
| A6.3 | `docs/DEVELOPER.md` 增加 Pack 章节，指向 PACK-API |
| A6.4 | README 增加「垂域 Pack」卖点段（对齐新定位，不夸大） |

### A7. 发布与回迁（1 天）

| 项 | 内容 | 验收 |
| --- | --- | --- |
| A7.1 | 版本 0.4.6 → **0.5.0**（minor：新增 Pack API）；`CHANGELOG-PACK.md` 记录 v1 冻结 | 版本一致 + 全绿 |
| A7.2 | 发布（自检 → commit → tag → 推 origin → 官网/镜像按既有流程） | CI + Desktop 绿 |
| A7.3 | **Deyi 回迁**：`pack-tcm` 从 `providers/dify.mjs` 拆出 3 工具 + 3 条约束 + 提示词段；`mingdao pack verify` 进下游 CI | 域内费用可见、红线可阻断、工具卡片正常 |

---

## 三、排期（建议，合计 ≈ 11.5 个工作日）

```
A0 契约冻结 ──▶ A1 Pack 加载器 ──▶ A2 CLI ──┬─▶ A3 约束引擎 ──┐
                                            └─▶ A4 成本确定性 ─┴─▶ A5 提示词段 ──▶ A6 文档 ──▶ A7 发布+回迁
```

A3 与 A4 可并行（不同模块），A5 依赖 A1。

---

## 四、风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| Pack API 设计不足，Deyi 迁不动 | v1 冻结即返工 | **A1/A3 完成后先用 `example-hello` 走通**；Deyi 回迁中发现的每个别扭点都当契约缺陷修 |
| 约束引擎改变 agent 主循环，伤到现有行为 | 回归风险 | 约束默认空集合 → 零 Pack 时行为与今天**完全一致**（用现有 6 套测试守住）；有 Pack 才生效 |
| `ctx.llm()` 破坏已有的费用链路 | P0 级回归 | 复用 `recordUsage` 同一条路径，不新开记账；断言「Pack 调用与普通回合进同一账本」 |
| Pack 加载拖慢启动 | 体验 | 懒加载贡献面；manifest 静态校验与文件读取分离；启动只读 manifest |
| 零依赖被破坏 | 根基 | Pack 加载器只用 `node:fs`/`node:url`；`npm:` 来源走 `require.resolve` 语义但不引入依赖树；CI 加「运行时 0 依赖」断言 |

---

## 五、明确不做（本阶段）

- ❌ 不做 Pack 商店 / 在线市场（v0.7+ 议题）
- ❌ 不做行为确定性（执行账本 / 可回放 / 合规导出）→ **v0.6.0**
- ❌ 不引入 Cordis 或任何重依赖
- ❌ 不把中医逻辑写进内核（只在 `example-hello` 里放中立示例）
- ❌ 不动已有省钱链路的行为（只在其上增加 Pack 维度）

---

## 六、完成定义（DoD）

1. `mingdao pack verify` 能对任意 Pack 目录给出**可操作**的通过/失败结论；
2. 一个不含领域逻辑的中立示例 Pack（`example-hello`）端到端跑通（工具可用、约束可阻断、提示词段到达、费用入账）；
3. **Deyi 的 3 个域工具成功从 Provider 迁出**，域内费用出现在 `cost report` 里，中医红线可被测试阻断；
4. 全绿门禁 + strict 0/0 + tsc 0 + 运行时 0 依赖；
5. `PACK-API.md` 标注 v1 冻结，`CHANGELOG-PACK.md` 有 v1 条目，兼容性矩阵写下「0.5.x / 0.6.x 支持 v1」。
