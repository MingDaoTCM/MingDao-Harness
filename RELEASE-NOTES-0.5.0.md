# MingDao Harness v0.5.0 发布说明

> 主题：**垂域 Pack 契约 v1** —— 定位从「省钱 Coding Agent + 开放内核」升级为
> **可私有化的垂域智能体内核**。这一版把上游与下游之间的扩展点变成正式契约。
> 战略见 [docs/STRATEGY-0.5.md](docs/STRATEGY-0.5.md)，落地计划与进度见 [docs/PLAN-v0.5.0.md](docs/PLAN-v0.5.0.md)。

## 一句话

垂域团队**不改内核源码**，就能把**领域工具、领域红线、领域提示词、领域费用**打包成一个可安装、可校验、可版本化的单元。

## 新增能力

### 1. Pack API v1（契约冻结）

```bash
mingdao pack new tcm              # 脚手架
mingdao pack verify ./packs/tcm   # 静态 + 运行时契约校验（下游 CI 门禁：非 0 退出即失败）
mingdao pack list / info tcm      # 查看已加载 Pack 与贡献面
```

- **三级遮蔽**：`<项目>/.mingdao/packs/` > `~/.mingdao/packs/` > 内置 `packs/`；`config.packs` 可声明；
- **manifest 严格校验**：未知字段 / 版本窗口 / 保留名 / 权限 / 贡献项，错误信息可操作；
- **极简 semver** 按 npm 语义（`^0.5.0` 对 0.x 锁 minor，与 `^1.2.0` 不同）；
- **坏 Pack 只告警、不阻塞启动**；挂载幂等。

### 2. 约束引擎：领域红线由内核强制（确定性①）

| kind | 时机 | 作用 |
| --- | --- | --- |
| `tool-deny` | 调用前 | 禁止某工具 |
| `tool-arg-require` | 调用前 | 必需参数缺失即拒绝（如「不得跨患者串病历」要有 patientId） |
| `arg-forbid` | 调用前 | 参数命中禁用模式即拒绝 |
| `completeness` | 工具返回后 | 必填项缺项则**拒绝该结果**并要求继续采集（「缺项绝不编造」） |
| `output-forbid` | 正文输出前 | 命中禁用措辞按 `block` / `block-and-rewrite` / `warn` 处理 |
| `confirm` | 调用前 | 需显式确认 |

三条设计原则：**只收紧不放松权限**（约束不授予任何权限）、**fail-closed**（求值异常按阻断）、
**零约束时完全惰性**（三处检查点全部跳过，对既有行为零影响）。

输出约束在**回填会话历史之前**生效——否则被拦下的违规措辞会留在会话里，下一轮又被当既有事实喂回模型。
`block` / `block-and-rewrite` **不回显**命中措辞（回显等于把它重新写进正文与历史）。

### 3. 成本确定性（确定性②）

- **`ctx.llm()` 统一模型出口**：Pack 内模型调用复用内核 Provider 解析 / 重试 / 超时 / 能力表，
  usage **并入当前回合** → 今日费用、缓存命中率、峰谷判断、日费用护栏**同时生效**。
  对照迁移前：垂域层把调用写在 Provider 的 `chat()` 里，usage 硬编码 `{0,0}` —— 完全不计费、不触护栏。
- **Pack 归因记录**：`cost=null` 标记记录，与回合级总账**不重复计费**；`mingdao cost --by pack` 分账可见。
- **Pack 级预算**：`budget.dailyYuan` + `action`（`block`/`warn`），在调用前拦截——垂域团队可为自己包住的调用单独设上限。
- **静态告警**：`pack verify` 对「Pack 自建模型调用（`fetch` 且不用 `ctx.llm`）」提示，先剥注释以防模板注释掩盖真实调用。

### 4. 领域提示词段

`promptSections` 注入系统提示（预设/记忆/技能之后），按 `order` + `pack/id` **确定性排序**、字节稳定——
不破坏 DeepSeek 前缀缓存（这是与「每轮重算记忆」的关键区别）。

### 5. 文档

- `docs/PACK-API.md`（v1 冻结，含三条拍板决策）
- `docs/CHANGELOG-PACK.md`（Pack API 变更史）
- `docs/PLAN-v0.5.0.md`（落地计划 + 滚动进度）
- **`docs/MIGRATION-DEYI-v0.5.md`（下游回迁指南，含逐项迁移步骤与 DoD）**
- README「垂域 Pack」小节 + `docs/DEVELOPER.md` Pack 章节

## 下游衔接

按已确认决策「**v0.5.0 发布即迁**」：`Deyi-TCM-Harness` 的 3 个域工具从 `providers/dify.mjs` 的 `chat()` 搬进 `pack-tcm`，
三条中医红线写成约束，域内 DeepSeek 调用改走 `ctx.llm()`，并让 `mingdao pack verify` 进下游 CI。
迁移收益的**可验证形式**：域内费用出现在 `cost --by pack` 里、红线可被测试阻断、域工具在 WebUI 显示为正常工具卡片。

## 验证

- `node test/run-all.mjs` → **6/6 套通过**（smoke **86 组断言**）
- `npm run typecheck` → 0 错误；`scripts/strict-ratchet.mjs` → 0 / 0
- `npm run bench` → 214 断言全绿
- 三平台 CI（Ubuntu 18/20/22 + **Windows** + macOS）全绿
- `mingdao pack verify packs/example-hello` → 通过（1 工具 / 1 约束 / 1 提示词段）

## 明确不做（本版）

- ❌ Pack 商店 / 在线市场（v0.7+）
- ❌ 行为确定性（执行账本 / 可回放 / 合规导出）→ **v0.6.0**
- ❌ 不引入 Cordis 或任何重依赖（零依赖不变）
- ❌ 不把任何单一垂域的业务逻辑写进内核

## 上游尚未提供（下游请勿依赖）

`ctx.storage`（Pack 私有持久化）· Pack 贡献非 OpenAI 兼容 Provider · Pack 私有存储加密 · 执行账本导出/回放。
前三项当前用 `<home>/providers/` 与 `permissions.fs` 显式路径替代，第四项在 v0.6.0。
