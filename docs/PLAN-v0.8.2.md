# v0.8.2 修复与 v0.8.3 / v0.9.0 迭代方案

> 基线：v0.8.1（`f8d7032`，三平台已发布）
> 依据：5 份 v0.8.1 审计报告（1 份自审 + 4 份第三方）+ 审计方给出的 24 项协议准入套件
> 原则：**v0.8.2 是纯修复版本**——只收缺陷与门禁诚实化，不引入任何新能力（应用模式仍标 experimental）

---

## 0. 先说三条实测结论（不是转述报告）

| 实测 | 结果 |
| --- | --- |
| 协议准入套件 `deepseek-v0.8.2-contract.test.mjs` 跑在 v0.8.1 | **24 项只有 3 项通过**（DS-03/08/09 阳性对照），21 项红；与审计方基线 json 完全一致 |
| `node scripts/doc-lint.mjs` 的 ② | **「分发 0 个」却打印「help 文本已核对」并判绿** —— 守卫在空转（v0.8.0 我把分发表提为模块常量后失效） |
| `node scripts/mutation-coverage.mjs` | `deepseek-app.js` 记 **0 条变异**，而 `batch90` 实际有 12 条（脚本只认 `file: '…'` 字面量，不认 `const F='…'` 别名） |

> 后两条是**门禁假绿**：比单点 bug 更危险，因为它是"发现问题的能力"坏了。

---

## 1. 五份报告的交叉共识（按出现次数排序）

| 共识 | 报告数 | 关键证据 |
| --- | --- | --- |
| **应用模式绕过记账 / 成本护栏 / 上下文预算** | **4/4** | `web/app-mode-run.js` 全文无 `recordUsage`/`checkCostGuard`；`commands/app.js` 同 |
| 协议终态机缺失（`stream:true`、非 SSE 2xx、缺 `message_stop`、坏帧、`event:error`、多行 `data:`） | 3/4 | `deepseek-app.js:61,121,192,206` |
| `refusal` 当成功且正文落盘 | 2/4 | `deepseek-app.js:304`、`app-mode-run.js:90` |
| `tool_use_id` 取错位置（外层 vs `content_block` 内）+ 未知 ID 回落"最后一次搜索" | 3/4 | `deepseek-app.js:272–275` |
| `buildAppMessages` 丢弃原始块 / 裁剪后首条可能是 assistant | 2/4 | `web/app-mode.js:72` |
| `supportsAppTools` 正则未锚定 + 三入口不统一回落 | 3/4 | `deepseek-app.js:46`、`config.js:300`、`app-mode.js:136` |
| 文件/ASR/TTS 无本地预算、整文件同步读 | 3/4 | `commands/app.js:512,614` |
| 门禁假绿（doc-lint ② 空转、变异归属漏记） | 2/4 | 上述实测 |

**报告自身的矛盾（已剔除，不作为依据）**：
- 「run-all 三 OS 一次都不执行」与同文 §0「macOS 55/55」矛盾（实测 CI 有跑）；
- 「`deepseek-app.js` 零变异」与既有 `batch90` 冲突（属统计脚本漏记，非无覆盖）；
- 「doc-lint 解析到 0 个子命令」在 v0.8.1 确实是 0——但**原因是我的分发表重构**，不是报告过时（这条反而命中）；
- 多份报告的代码行数/测试项数与仓库实测有偏差，本方案一律以**仓库实测**为准。

---

## 2. v0.8.2 范围（P0，纯修复）

按依赖排序，共 7 个任务 + 2 个门禁诚实化 + 2 个一行修复。

| # | 任务 | 关键改动 | 验收 |
| --- | --- | --- | --- |
| **T01** | Messages 客户端改成显式终态机 | `stream:true`；2xx 非 SSE 明确失败；`sawMessageStart/Stop`、`outcome:'ok'\|'truncated'\|'failed'\|'refused'`；合并多行 `data:`；坏帧计数；`event:error` 或无 `type` 的 `{error}`；`finally` 释放 reader/timer/listener | DS-01/02/04/05/06/07 + 阳性 DS-03/08/09 |
| **T02** | refusal 撤回 | `outcome:'refused'`；`appFrameOf` → `{type:'appRefusal'}`；`runAppModeChat` 拒答**不写盘、不发 done**；CLI 非零退出且不夹带原文 | DS-10/11/12 |
| **T03** | 只按 `content_block.tool_use_id` 配对 | 删除外层 `ev.tool_use_id` 与"最后一次搜索"回落；未配对结果保留进 `blocks` 供诊断 | DS-13/14 |
| **T04** | 协议历史与展示模型分离 | `buildAppMessages` 原样保留 assistant 块数组（`kind`/`signature`/`id`）；裁剪按完整回合；旧字符串历史仍可读 | DS-15 |
| **T05** | 附件与语音预算前置 | 图片按 `document` 引用；单文件 100 MiB / 请求文档 32 MiB / ≤20 个；ASR 仅 WAV/Ogg Opus、8 MiB、120 秒；TTS 10000 字符 / 64 KiB；**超限零网络调用**；异步有界读 | DS-16～22 |
| **T06** | 模型能力单点判据 | `supportsAppTools` 精确表；CLI/Web/配置共用 `resolveAppModel`，未支持 → **回落 `deepseek-flash` 并给可见提示** | DS-23/24 |
| **T07** | 协议套件进默认门禁 | 移植为 `test/deepseek-app-contract.js` 并注册 run-all/CI；夹具注明官方来源；发布说明区分"假 fetch 契约 / 真实账户验收 / 未执行" | 24/24 + 既有 55 套 |
| **G1** | `doc-lint ②` 修复 | 分发表解析改为读 `DISPATCH_TABLE` 常量；**匹配到 0 个即判红**（空守卫是最坏情况） | ② 输出 ≥19 且与 help 对齐 |
| **G2** | 变异归属修复 | `mutation-coverage.mjs` 支持 `const F='…'` 别名；`deepseek-app.js` 应记 ≥12 | 覆盖率报表不再出现"零覆盖"假象 |
| **F1** | 账本：中断出口 | `agent.js` Ctrl+C 中断补 `markOutcome('aborted')`（2 行） | 账本 status=aborted |
| **F2** | 预算：非末轮步数耗尽 | `agent.js:1664` 的提前 return 加 `round === maxRounds-1` 条件（1 行） | 长任务不再被吞 |

**另并入（4/4 共识，唯一"花钱且无记录"）**：应用模式记账收成**单一入口**（T02 之后做）——
`app-mode-run.js` 与 `commands/app.js` 必须走同一条 `recordUsage` + `checkCostGuard`，否则日上限形同虚设。

**不做（避免热修复扩面）**：会话侧车生命周期、配置保存事务、读缓存、Batch 记账、desktop 供应链、架构拆分。

---

## 3. v0.8.3（P1，1–2 个迭代）

- 会话生命周期统一（删/改名时 `.jsonl` / `.events.ndjson` / task-state 同步）——报告 M-06/M1；
- `saveConfig` 事务（写失败返回 5xx，不再 200）——M-07；
- 读缓存正确性（`path+mtime+size` 不足）——M-08；
- Batch 记账（完成后异常记"未知用量"）——M-09；
- hooks 在 Windows/Node 24 的 `write EOF` 判定——报告3 H2（会让 smoke 中断）；
- 符号链接测试能力探测（非管理员 Windows EPERM）——报告3 H3；
- `util.js#highlight()` 字符串分支永不命中 + 补一批变异——报告3 M3/M4；
- 覆盖率基线刷新（11-05 之后新增 1436 行无基线）。

## 4. v0.9.0（P2，架构级）

- `agent.js` 拆阶段（`callModel / execToolBatch / accountRound / finalize`），先把 outcome 补全做成结构守卫；
- `web/app.js` 3334 行拆 ESM 模块并纳入 strict 类型检查；
- 请求路径去同步化（`Atomics.wait` 锁迁移、cost-guard 增量解析、session-events 批量 append）；
- 覆盖率闸门重开（`COVERAGE_GATE=1`，三步前置条件见 DEVELOPER §7.3）；
- 发布门禁加固：tag↔版本断言、publish 依赖全量门禁、`postversion` 去 `|| true`；
- 版本语义收紧：**对外可见新能力一律 minor，patch 只收修复**（0.8.1 是 minor 级却按 patch 发）。

---

## 5. 验收口径（v0.8.2 Definition of Done）

1. 协议套件 **24/24**，无 skip/todo；阳性对照 DS-03/08/09 仍绿（防"一律失败"的伪修复）；
2. 既有 `run-all` **55 套 + 新套件**全绿；变异 `mutate:shard` 0 逃逸且 `deepseek-app.js` ≥12 条被统计到；
3. `doc-lint` ② 输出 ≥19 且**匹配到 0 个即红**；
4. `typecheck` / `strict` / `preflight` / `smoke` 全绿；
5. 应用模式记账：一次 Web 调用与一次 CLI 调用都进入 `cache-stats`，且日上限可拦截；
6. 拒答四层验收：传输层 `outcome:'refused'`、Web 发 `appRefusal` 并清空正文、会话文件无正文、CLI 非零退出；
7. 附件/语音超限时**网络替身调用次数为 0**；
8. 真实开发账户一次性验收（保存时间/文档版本/终态摘要，不存密钥与正文）；
9. 回滚方案：应用模式入口可关（`appApi.enabled=false` 必须能真正关掉），Agent 路径不受影响。
