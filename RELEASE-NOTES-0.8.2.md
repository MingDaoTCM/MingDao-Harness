# MingDao Harness v0.8.2 发布说明

> 状态：**已发布**（tag `v0.8.2`，2026-11-15）
> 主题：**DeepSeek 应用协议收尾（错误不再成功）+ 两处门禁诚实化 + 应用模式记账**
> 范围：`v0.8.1..HEAD`——`ad7eb61`（方案）、`fe57646`（agent 账本/预算）、`2cbbc7b`（协议终态机）、
> `04fee01`（门禁诚实化 + 24 项准入套件入闸）、`9cbb2c4`（拒答/历史/预算/记账）、`batch91`（新代码变异守卫）
> 依据：5 份 v0.8.1 审计报告（1 份自审 + 4 份第三方）+ 审计方 24 项协议准入套件
> 性质：**patch，纯修复**——不引入新能力，应用模式仍为 experimental、默认关闭

---

## 1. 用户能感知到的变化

| 之前 | 现在 |
| --- | --- |
| 端点返回非 SSE 的 JSON，应用模式"成功但没有正文" | 明确失败并给出原因 |
| 网络断在半截，半截回答被当成完整答案 | 判 `outcome:'truncated'` 并**保留已产出正文**供查看 |
| 内容安全拒答后，**拒答原文被写进会话文件** | 拒答撤回：不落盘、不发成功通知、CLI 非零退出 |
| 上传图片文件必 400（按 `image` 块引用） | 统一按 `document` 引用，图片也能用 |
| 超限文件先上传再报错（白花流量与费用） | **本地先失败，零网络调用**；错误含实际值/上限/单位 |
| 应用模式的调用**完全不进费用统计**，日上限形同虚设 | 每次调用都记账，并受成本护栏约束 |
| 模型不被支持时仍照发请求 | 统一回落 `deepseek-flash` 并给可见提示 |

## 2. 修复清单（按审计编号）

### 协议终态（T01 / 自审 H-1·H-2·H-4·H-5 / 报告1 S3·S4 / 报告2 H-01·H-03）
- 请求体固定 `stream:true`；
- 读 body 前校验 `Content-Type`，非 SSE 的 2xx 一律失败；
- 新增机器可读 **`outcome`**：`'ok' | 'truncated' | 'failed' | 'refused'`，**`ok===true` 仅当 `outcome==='ok'`**；
- SSE 改为**按空行分派事件**：同一事件的多个 `data:` 行合并、正确处理 CRLF、任意 chunk 边界与 EOF 残行；
- 缺 `message_stop` 的 EOF → `truncated`（不再当成功）；坏 JSON 帧 → 失败（不再静默跳过）；
  `event: error` 或无顶层 `type` 的 `{error}` → 失败；
- `finally` 释放 reader / timer / 外部 abort listener。

### 拒答撤回（T02 / 报告2 H-02）
- `outcome:'refused'` + `onDelta({type:'refusal'})` → Web 映射 `appRefusal`；
- `runAppModeChat` 拒答**不写会话、不发 `done.ok:true`**；前端清空本轮已渲染正文并显示固定拒答文案；
- CLI 打印安全拒答而非原文，退出码非零；`--json` 含 `outcome:'refused'` 且不含正文。

### 工具结果配对（T03 / 自审 H-3 / 报告1 H5 / 报告2 M-01）
- 配对键改取官方 **`content_block.tool_use_id`**（此前读外层 `ev.tool_use_id`）；
- **删除"找不到就挂最后一次搜索"的回落**：未知 ID 不污染任何已有搜索，结果块仍保留在 `blocks` 并标 `paired:false`；
- 同一 ID 重复结果采用"后者替换前者"的明确策略。

### 多轮协议历史（T04 / 自审 H-7 / 报告2 M-02）
- `buildAppMessages` 原样保留 assistant 的**原始内容块数组**（`text`/`server_tool_use`/`web_search_tool_result`/
  `web_fetch_tool_result`，含 `id`/`tool_use_id`/`kind`/`signature`），不再压成字符串；
- 裁剪按**完整回合**原子裁剪，首条恒为 `user`；旧的字符串历史仍可读。

### 附件与语音预算（T05 / 自审 M-10 / 报告2 M-03·M-04 / 报告1 H4）
- 新增 `src/app-protocol.js`（无 IO 纯函数，单一事实来源）；
- Files：单文件 ≤100 MiB、请求内合计 ≤32 MiB、≤20 个；
- ASR：仅 16-bit PCM WAV / Ogg Opus，≤8 MiB、≤120 秒（读文件头验编码与时长）；
- TTS：≤10000 计费字符、请求体 ≤64 KiB；
- **全部在读取/上传/转写/合成之前失败**，超限时网络替身调用 0 次。

### 模型能力（T06 / 自审 H-6 / 报告2 M-05 / 报告1 H1）
- `supportsAppTools` 改为**精确表**（`custom-deepseek-flash-experimental`、`notdeepseek-flash`、`deepseek-v4-pro` 均为 false）；
- 新增 `resolveAppModel(cfg)`：CLI / Web / 配置归一化**共用同一解析**，未支持模型统一回落 `deepseek-flash` 并给可见提示。

### 应用模式记账（4/4 报告共识）
- CLI 走 `recordUsage`、Web 走 `recordUsageAsync`（峰谷按请求发起时刻锚定）；
- 发送前跑成本护栏（日上限 block/downgrade 拒绝并说明）；记账失败只 warn，不吞回答。

### 门禁诚实化（G1 / G2 / T07）
- **G1**：`doc-lint` ② 此前因 v0.8.0 的分发表重构而**匹配到 0 个命令却判绿**（空转守卫）。
  现在解析 `DISPATCH_TABLE` 常量，输出 `分发 20 个（自检下限 15）`，**匹配 0 个或 <15 即红**；
- **G2**：`mutation-coverage.mjs` 不认 `const F='…'` 别名，导致 `deepseek-app.js` 的 12 条变异被记成 **0 条**。
  现在支持别名与简单拼接，并对「>200 行且 0 变异」打印告警；
- **T07**：审计方 24 项协议准入套件移植为 `test/deepseek-app-contract.js`，登记 `run-all` 与 CI（非 macOS 腿），
  夹具注明官方来源与"未线上录制"；**v0.8.1 基线 3/24 → 现在 24/24**。

### 账本与预算（F1 / F2，自审 S-1·S-2）
- 两处「工具执行期间 Ctrl+C」出口补 `markOutcome('aborted')`——此前账本把用户中断记成 `status:'done'`；
- `steps === stepLimit` 的提前 `return` 加 `round === maxRounds-1` 条件——此前长任务跑满第一轮就被判"完成"，
  `maxRounds-1` 轮的自动续跑预算被整体吞掉。

## 3. 门禁结果（发布树）

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` / `typecheck:strict` | 0 / 0 |
| `npm run preflight` | ✓（批次结构 / 变异残留 / 计数一致） |
| `node test/smoke.js`（私有 TMPDIR） | ✓ |
| `node test/run-all.mjs` | **56 套 / 56 通过**（新增 `deepseek-app-contract`） |
| 协议准入套件 | **24/24**（阳性对照 DS-03/08/09 保持绿） |
| `npm run mutate:shard` | 4 片全中（含新增 `batch91` 新代码守卫） |
| `node scripts/event-parity.mjs` | exit 0 |
| `node scripts/doc-lint.mjs` | ✓（② 分发 20 个，自检下限 15） |

## 4. 已知边界（未做 / 不在本版）

- **真实开发账户验收未执行**：本版全部为**假 fetch** 的协议契约测试；首次真实端点验收需单独安排，
  保存时间/文档版本/终态摘要，不保存密钥与正文；
- WebUI 附件上传仍不进应用接口（应用模式只有文本 + 服务端搜索/阅读）；
- 应用模式不注入 agent 系统提示/记忆/预设；失败半截回答不落盘（界面保留、刷新丢）；
- `latest_reminder` 仍只有定义与测试、主路径未接线；
- 会话侧车生命周期、配置保存事务、读缓存、Batch 记账、desktop 供应链、`agent.js` 拆阶段 → 见 `docs/PLAN-v0.8.2.md` 的 v0.8.3/v0.9.0；
- 覆盖率闸门仍关闭（趋势参考）。

## 5. 回滚

- 应用模式入口可关：`config.json` 的 `appApi.enabled` 置 `false` 且不带 🔍 开关即不走应用路径；
- 本版**未改** Agent 工具循环的语义（仅两处账本/预算出口），回滚应用模式不影响 Agent 路径；
- 若真实端点验收发现协议差异：先关闭应用模式入口，再按 `docs/PLAN-v0.8.2.md` 的 T01 终态表逐项对齐。
