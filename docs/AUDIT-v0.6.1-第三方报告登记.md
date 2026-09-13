# v0.6.1 第三方审计报告登记表

> 起因：负责人让 v0.6.1 审计自己的代码，过程中暴露了三个**过程缺陷**（见 §2），
> 并留下四份报告在工作区根目录。本文件的作用是把三方结论**登记成可追踪清单**，
> 分清「我已亲自核实」与「第三方结论未复核」，避免把没核过的行号当结论用。

## 1. 报告来源

| 文件 | 产出方 | 口径 |
| --- | --- | --- |
| `MingDao-harness-v0.6.1-技术评估报告.md` | MDH v0.6.1 自己（主代理 + 并行子代理） | 自评 P1×2 / P2×11 / P3×7 + 待复核 10；**自述因步数上限未读完部分文件** |
| `MingDao-Harness-v0.6.1-代码审计报告.md` | 第三方（另一工具链） | 全量精读 + 本地实跑测试套件 |
| `audit-report.md` | 第三方（六阶段流水线） | 243/243 文件覆盖，P0×17 / P1×15 / P2×8 |
| `verification-report.md` | 第三方（对上份报告的验证） | DFX 红线核查，15 条 PASS |

**读这些报告时必须注意**：自评报告是在**步数受限**下产出的（它自己写了「未交付内容：限于步数，
`src/providers/*`、`src/context.js`、`src/compact.js`、`src/tokenizer.js` 等未逐行精读」），
所以它的「未发现问题」不等于没问题。两份第三方报告之间也有口径差异（严重度分级、总数不同），
本表只登记**位置明确、可复核**的条目。

## 2. 已在本轮修复（v0.6.2）

### 2.1 三个过程缺陷（负责人实测）

| # | 现象 | 根因（已核实） | 修复 |
| --- | --- | --- | --- |
| 1 | 步数受限，**未能产出交付物**，要追问才继续 | ① 预算用尽时**不打印任何提示**，用户只看到一段总结，误以为完成；② 兜底总结用 `tools: []`，收尾时**已无法写文件**，所以上限一到必然没有交付物；③ 兜底提示语写的是「任务已执行完毕」——在步数上限这条路径上是假话 | 预算用尽打印**明确、可执行**的提示（含 `--continue` / 「继续」/ 调高 `config.maxRounds`）；续跑提示要求**优先落盘**（只留在对话里的不算交付物）并告知剩余轮次；兜底提示语改为如实说明「被迫中断、可能尚未完成」并列出未完成部分 |
| 2 | 子代理**字数超限被截断** | `src/web/app.js` 用 `truncText(resultText(...), 1500)` **硬截断**——1500 字以外的内容用户再也看不到（同页 bash/diff/ls/grep 早已用可展开的 `expandableBody`，只有文本类结果不一致） | 新增 `textBody()`：短文本原样、长文本给「预览 + 展开全文」，一个字都不丢 |
| 3 | 桌面版调用工具时**不停弹出终端** | Windows 上 `spawn` 默认 `windowsHide: false`，GUI 进程每次 spawn 都弹控制台；`detached: true` 还会**新建**控制台并打断管道。此前**只有 hooks.js 单独修过**，其余 9 处 spawn 全部遗漏 | 新增单一来源 `src/proc.js#spawnOpts()`，**13 处 spawn / 10 个文件**全部收口；并加**结构守卫测试**（新增 spawn 漏走即失败） |

### 2.2 第三方报告的 P1-2（我已复核并修复）

**read 去重缓存跨代理污染** —— 此前 `readCache` 是 `src/tools/fs-tools.js` 的**模块级 Map**，
键只是文件绝对路径，同一 Node 进程内主代理 / 并行子代理 / 多个 WebUI 会话**共用一个缓存**。
后果：子代理读过某文件后，**主代理再读同一文件拿到的是「内容与上次读取一致」占位串**，
而主代理上下文里从来没有这段内容——属于「静默给出错误信息」。

自评报告正是踩在这一条上：它写「并行子代理读过 `bash.js`/`permissions.js`/`fetch.js`，
随后我在主上下文用 read 读同样三个文件，返回的正是『内容与上次读取一致』」。

**修复**：缓存挂到 `ctx.readCache`（`createAgent` 每个实例一份）。同一代理重复读仍去重省 token，
跨代理不再污染；没有 `ctx.readCache` 时不去重（宁可多花 token，也不给错信息）。

## 3. 已修复：P1-1 项目级 Pack「克隆即执行」（**已亲自核实并修复**）

```js
// src/packs.js#packDirs —— 项目级目录无条件进入搜索路径（priority 2）
if (projectDir) out.push({ dir: path.join(projectDir, '.mingdao', 'packs'), source: 'project', priority: 2 });
// src/packs.js#mountOne —— 同进程执行
mod = await import(pathToFileURL(entry).href);
// src/cli.js:413-419 —— 启动路径无条件挂载
const packCtx = await mountPacks(cfg, { cwd: workingDir });
```

**触发**：`git clone <不可信仓库>` → `cd` 进去 → 跑任意 `mingdao` 子命令（桌面版把工作目录切过去也一样）。
仓库里放 `.mingdao/packs/evil/pack.json` + `pack.mjs` 即可。

**后果**：`pack.mjs` 以完整 Node 权限同进程运行——可读 `~/.mingdao/credentials.json`、可出网外传、
可读 bash 工具专门过滤掉的敏感环境变量（`bash.js` 的黑名单在进程内代码面前毫无意义）。
**与 `permission` 模式（ask/readonly）完全无关，也不询问用户。**

**修复（v0.6.2，负责人已同意该行为变更）**：

- 项目级 Pack **默认不挂载**：`packDirs` 只在内容指纹被显式信任后才把它并入搜索路径；
- 复用 `mingdao skill trust` 的**内容指纹**模式（同一实现 `skillDirHash`）——指纹变化即自动失效；
- 新增 `mingdao pack trust` / `untrust`；`mingdao pack list` 把未信任的显示为
  「⛔ 未信任（不挂载）」并给出开启命令；
- 未信任时启动打印告警，说明**目录、原因与开启命令**——静默执行与静默跳过同样糟糕；
- `config.packs` 显式声明**不受此门限制**（那是用户自己写下的授权）；
- 信任表 `${MINGDAO_HOME}/pack-trust.json`，权限 `0600`。

**实现中额外抓到的一个坑**（单元测试漏掉、CLI 端到端实测抓到）：信任表键必须按
`realpath` 归一。macOS 上 `/tmp` → `/private/tmp`，`os.tmpdir()` 同样是符号链接，
不归一时「trust 记一个路径、运行时按 `process.cwd()` 查另一个路径」→ 信任看起来完全没生效。
已修，并补了「经符号链接 trust 后按真实路径也必须命中」的回归断言。

**下游影响**：`docs/MIGRATION-DEYI-v0.5.md` §四 已加迁移步骤与两条一次性命令
（`mingdao pack trust <仓库根>` 或写进 `config.packs`）。装在 `$MINGDAO_HOME/packs/`
（用户级）的 Pack 不受影响。

## 4. 其余登记项（**第三方结论，我未逐条复核**）

### 4.1 自评报告（`MingDao-harness-v0.6.1-技术评估报告.md`）

| 级别 | 位置 | 摘要 |
| --- | --- | --- |
| P2-1 | `pack.json` 的 `permissions` | 纯声明，全仓无人读取 |
| P2-2 | 权限 `deny` | 前缀规则仍可被链式命令绕过 |
| P2-3 | `git` 参数黑名单 | 可被长选项唯一前缀缩写绕过 |
| P2-4 | Web 会话忙锁 | 键在自动改名后失效 |
| P2-5 | 终端渲染 | 模型输出可注入终端控制序列（OSC 52 等） |
| P2-6 | `sleeperAlive` | 全仓唯一裸 `process.kill(pid,0)`，无归属校验 |
| P2-7 | 文件锁 | `Atomics.wait` 阻塞事件循环；`timeoutMs < staleMs` 形成 15s 死区 |
| P2-8 | 出网闸门 | 包装 `fetch` 时丢失 `Request` 对象语义 |
| P2-9 | 项目记忆 | 自动写入 + 注入 system prompt = 持久化提示注入通道 |
| P2-10 | `killTask` | 只发 SIGTERM 且立即改状态（Windows 无进程组语义） |
| P2-11 | 调度 `runOnce` | 轮询期间不检查租约，最长空转 2 小时 |
| P3-1 | 避峰备注 | 写「北京时间」却打印 UTC（错 8 小时） |
| P3-2 | `kind:'every'` | `nextRunAt` 缺失时每 1 秒空转 |
| P3-3 | git 工具 | 默认加 `--stat` 与模型显式 `--no-stat` 冲突 |
| P3-4 | 模型默认值 | 改名后仍散落 8 处，与「单一来源」教训相悖 |
| P3-5 | Pack lint | 去注释正则会把字符串里的 `//` 一起删掉（漏报） |

### 4.2 第三方代码审计报告（`MingDao-Harness-v0.6.1-代码审计报告.md`）

| 级别 | 位置 | 摘要 |
| --- | --- | --- |
| P2-1 | `src/memory.js:96` | `removeMemoryLines` 写回无尾换行，下次 append 拼出坏行 |
| P2-2 | `src/audit.js:36-45`、`memory.js:101/117` | 截断依赖**进程内**计数 → CLI 下截断是死代码，日志无界增长 |
| P2-3 | `src/audit.js:41` | 截断用 `writeFileSync` 而非原子写，崩溃丢事件 |
| P2-4 | `src/commands/pack.js:31/166` | `listPacks({}, cwd)` 硬传 `{}`，读不到 `config.packs` 声明的 Pack |
| P2-5 | `src/mcp-presets.js:43-48` | sqlite 预设必填参数含 `{dir}` 未替换，静默落到 cwd |
| P2-6 | `src/commands/sync.js:81-88` | `sync passwd` 新密码走位置参数 → 明文进 `ps aux`/history |
| P2-7 | `src/skill-registry.js:56` | `redirect:'follow'` 无逐跳复检，与 `skill-lib.js` 两种口径 |
| P2-8 | `src/skill-registry.js:144-150` | sha256 校验可选，缺字段仍打印「✓ 已安装」 |
| P2-9 | `src/tools/index.js:332-374` | 声明式工具超时只 kill child，不清理进程组（对照 `bash.js` 的 killGroup） |
| P2-10 | `src/routing.js:17`、`config.js:160` | 路由默认仍是改名前的旧模型名 |
| P2-11 | `src/agent.js:104` vs `:34` | 只读工具集合两份副本（`READONLY_TOOLS_SET` / `READONLY_TIER_SET`） |
| P2-12 | `src/commands/repl.js:677-685` | 自动标题无 try/catch（`cli.js` 已为同类问题加过） |
| P2-13 | `src/commands/diagnose.js:101` | 诊断包未按 0600 落盘，脱敏只按字段名匹配 |
| P2-14 | `src/autostart.js:62-77/86` | plist/desktop 字符串插值未转义，路径含 `&<>` 时静默失效 |

### 4.3 `audit-report.md`（第三方，口径与前两份不同）

自述 243 文件全覆盖，P0×17 / P1×15 / P2×8；结论摘要为「安全 5.0 / 性能 6.0」，
点名「权限收紧（桌面版）、git 只读白名单」为加分，「WeakMap 缓存永远 miss（每步全量 BPE）」
为最严重性能问题。该报告**未给出可直接复现的 file:line 清单**（只在正文散落），
本表暂不逐条登记；若要用它排期，需先把它自己的 issue-index 提取出来核对。

## 5. 建议的处理顺序

1. §4.2 中**凭据泄露类**（P2-6 `sync passwd` 位置参数）与**静默失效类**（P2-8 技能校验可选、P2-5 预设参数）；
2. §4.1 P2-5 终端注入（一次 `io.print` 统一 sanitize 即可封住一族）；
3. §4.1 P2-9 项目记忆「自动写入 + 注入 system prompt」——与 P1-1 同类的持久化注入通道，值得一并收口；
4. 其余按「日志/调度/锁」分组批量处理。

> 已完成：三个过程缺陷（§2.1）、P1-2 缓存跨代理污染（§2.2）、P1-1 Pack 信任门（§3）。
