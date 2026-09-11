# 更新日志（Changelog）

本项目自 v0.1.69 起维护变更日志；此前版本（0.1.0–0.1.68）的演进见 docs/QA-REPORT.md 与 git 历史。

## 未发布 — v0.6.0「合规与确定性」（确定性③：行为确定性）

> 落地计划与滚动进度见 `docs/PLAN-v0.6.0.md`。目标：给定一次历史执行，能离线回答并证明
> 「每一步做了什么、触发了哪条规则、花了多少钱、数据有没有出网」，且结论可脱敏导出供第三方复核。

- **执行账本（C1，进行中）**：新增 `src/ledger.js` 与 `mingdao ledger list|show|export|verify`。
  一次回合一个账本文件（`~/.mingdao/ledger/<runId>.jsonl`），统一记录**八类事件**：
  回合开始 / 模型轮次 / 工具调用 / 工具结果 / 约束触发 / 权限决策 / 费用 / 回合结束。
  **不改造 `audit.jsonl`**——后者有 20000 行截断（回放会缺段，被静默截断的合规账本比不记账更糟）
  且只记工具调用，粒度不足以回答「这个结论是怎么来的」；`mingdao audit` 行为不变。
  两条不可让步的纪律：**写入即脱敏**（明细先过密钥规则再落盘，不留「先存明文靠导出兜底」的口子）
  与**摘要替代原文**（`argsDigest`/`resultDigest` = sha256 前 16 位，可比对、可防篡改、不泄露内容）；
  约束事件只记「哪条约束/什么时机/如何处理」，**不回显命中原文**（否则账本自身成为泄露渠道）。
  导出时在密钥规则之上再叠加私网 IP + 家目录掩码；无价模型落 `priced:false` 与「无法估算」，
  绝不写 `¥0.0000` 冒充免费。每行以 `prev` 串成**哈希链**，`ledger verify` 能发现改行**与删行**。
  诚实边界：哈希链只能证明「自写入后未被改动」，**不含可信时间戳**，不等同于审计级不可否认。

## v0.5.0（2026-09-11）— 垂域 Pack 契约 v1（约束确定性 + 成本确定性）

定位升级：从「省钱 Coding Agent + 开放内核」→ **可私有化的垂域智能体内核**（详见 `docs/STRATEGY-0.5.md`）。
本期落地上游与下游之间的正式契约：垂域团队**不改内核源码**即可把领域工具、领域红线、领域提示词、领域费用接进内核。
决策已确认：v0.5 做确定性①约束 + ②成本；③行为确定性（执行账本/可回放/合规导出）放 v0.6.0。

- **Pack API v1（契约冻结）**：`pack.json`（manifest）+ `pack.mjs`（contributions）。三级遮蔽发现（项目 > 用户 > 内置）+ `config.packs` 声明；manifest 严格校验（未知字段/版本窗口/保留名/权限/贡献项），错误信息可操作；极简 semver 按 npm 语义（`^` 对 0.x 锁 minor）；挂载**幂等**；**坏 Pack 只告警、不阻塞启动**。契约见 `docs/PACK-API.md`，变更史 `docs/CHANGELOG-PACK.md`
- **约束引擎（确定性①）**：领域红线从「提示词里的一句话」升级为**内核强制**——`tool-deny` / `tool-arg-require` / `arg-forbid` / `output-forbid` / `completeness` / `confirm`，三个时机（调用工具前 / 工具返回后 / 正文输出前）强制执行，命中写审计。**fail-closed**（求值异常按阻断处理）；**零约束时三处检查点全部惰性**（对既有行为零影响）。输出约束在**回填会话历史之前**生效，避免违规措辞被当既成事实喂回；`block`/`block-and-rewrite` **不回显**命中措辞
- **成本确定性（②）**：`ctx.llm()` 统一模型出口——Pack 内模型调用复用内核 Provider 解析/重试/超时/能力表，usage 并入当前回合 → **今日费用 / 缓存命中率 / 峰谷 / 日费用护栏同时生效**（对照：垂域层此前把调用写在 Provider 里，usage 硬编码 0，完全不计费也不触护栏）。新增 **Pack 归因记录**（`cost=null` 标记，与回合级总账不重复计费）与 `mingdao cost --by pack` 分账视图；Pack 级预算 `budget.dailyYuan` + `action`（block/warn）在调用前拦截
- **领域提示词段**：`promptSections` 注入系统提示（预设/记忆/技能之后），按 `order` + `pack/id` 确定性排序，**字节稳定不破坏前缀缓存**
- **CLI**：`mingdao pack list / verify / new / info`；`pack verify` 为静态校验（不 import 代码）→ 可直接作**下游 CI 门禁**；`pack verify` 对「Pack 自建模型调用（fetch 且不用 ctx.llm）」给出静态告警（先剥注释，防脚手架模板注释掩盖真实调用）
- **内置中立示例** `packs/example-hello/`（1 工具 + 1 输出红线 + 1 提示词段）；随 npm 包与桌面版分发，并有静态护栏断言
- **文档**：`PACK-API.md`（v1 冻结）/ `PLAN-v0.5.0.md`（落地计划与进度）/ **`MIGRATION-DEYI-v0.5.md`（下游回迁指南）**；README 增「垂域 Pack」小节；`DEVELOPER.md` 增 Pack 章节
- 测试：smoke 81→**86 组断言**；6/6 套测试全绿 · tsc 0 错误 · strict 棘轮 0/0 · 三平台 CI（Ubuntu 18/20/22 + Windows + macOS）全绿

> 下游衔接：按决策「v0.5.0 发布即迁」，`Deyi-TCM-Harness` 的 3 个域工具从 `providers/dify.mjs` 的 `chat()` 搬进 `pack-tcm`，
> 并让 `mingdao pack verify` 进下游 CI。迁移前域内调用硬编码 `usage: 0`（完全不计费），迁移后进入 `cost --by pack`。

## v0.4.6（2026-09-11）— 迁移 macOS 后首次全量审计：P0 费用护栏盲区 + 50 项根因修复 + 省钱口径自纠

- **省钱口径自纠（重要）**：`bench-savings`「综合省 64%」系虚高，真实值 **51%**——④Schema 瘦身 / ⑤只读阶段此前用**启发式**计数去测「面向 DeepSeek 的省钱主张」（工具 Schema 是 JSON，结构字符占 46%，两种计数偏差 1.1–1.8 倍），且 ⑤ 的基准里维护了一份**过期 6 工具副本**（实现的只读档自 v0.4.4 起已含 `task`）。两项改用随包官方词表**精确**计数、只读档集合从 `agent.js` 单源导出，并新增类别化断言防止再次虚高；真实值 ④48.9%（1145→585）、⑤28.9%（1145→814）。`docs/SAVINGS-BENCHMARK.md` 与 `docs/STRATEGY-NEXT.md` 同步修正
- P0 费用护栏盲区：`effectivePricing` 在读 `pricing.overrides` **之前**就因无内置价返回 null → gpt-5/qwen/glm/kimi/本地/动态发现模型全部 hasPricing=false、estimateCost=null、cost 记 null（当 0 累计）→ 今日费用看不到消费、护栏永不拦截；而护栏给出的补救办法恰是这条不生效的路径。现 overrides 与内置/外部价等价作为来源，并要求仅靠 overrides 供价时 input+output 均为有限正数
- P1 安全 ×5：**WebUI 权限确认可被任意客户端代答**（`/api/permission` 从不校验 ask id，而 taskId 是顺序号且 `/api/tasks` 全量列出 → 任何能访问 API 的一方都能替他人挂起的写文件/执行命令确认答「允许」，绕过默认 ask 档唯一人工闸门）· **任意环境变量外泄**（自定义模型 `envKey`+`baseUrl` 均用户可控，密钥解析把宿主任意变量当 Bearer 发到攻击者端点，不填 envKey 还回落主密钥）· **SSRF 绕过**（URL 解析器把 `[::ffff:127.0.0.1]` 规范化成 `[::ffff:7f00:1]`，旧判定只认点分四段 → 可抓回环 WebUI/内网/云元数据）· **`deny` 规则 fail-open**（防 allow 提权的白名单字符校验被同一函数用于 deny，命令含 `& ; | @ = ' "` 即失配，auto 档下 deny 形同不存在）· **sync-server 限流可用随机查询串绕过**（桶键用含 query 的 `req.url` 而路由用 pathname）
- P1 正确性 ×8：**`git` 工具 100% 失效**（`await execFile` 非 thenable → 输出恒 `[object Object][object Object]`、退出码/ENOENT/timeout 全被吞）· **`edit` 静默写坏文件**（`$&`/`$'`/`$$` 被当替换模式）· **read-after-write 命中旧缓存**（写后再读返回写前内容，模型误判写入未生效）· **自动压缩吞掉整段会话**（`compactTrigger<0.6` 或 force 时除 system 外全部压成摘要，WebUI 还会永久写回会话文件）· **`reasoning_content` 不计入预算**（思考型会话低估 61 倍）· **冲突备份对产品不可见**（producer/consumer 文件名正则不一致 → 「冲突三选一」100% 失效，且备份被当普通会话推送到其他设备变成幽灵会话）· **hooks/MCP 子进程 stdin 无 error 监听**（载荷 >64KB 且子进程先退出时 EPIPE 未捕获异常带走整个进程）· **步数上限兜底总结被静默丢弃**（长任务终端只看到一屏工具调用、没有最终答复）
- P1 费用 ×2：**子代理 token 从不并入父回合**（CLI/REPL 恒漏计，README 主推的「多方向并行调研」漏计最重）· **启发式计数并非其自称的「保守上界」**（纯标点低估 3 倍、单字母词/随机字母数字 2 倍 → 非 DeepSeek 模型预算/压缩/批量预检系统性偏小）
- P1 打包 ×2：**`skills-lib/` 未随 npm 包与桌面版分发**（README/官网主打的「36 个技能」在两条主分发渠道只剩 14 个，失败还被 try/catch 静默吞）· **桌面版版本漂移**（`desktop/package.json` 停在 0.2.0，而 README 教用户的 `dist:linux|win|mac` 不跑同步 → 本地打包产出 0.2.0）
- P2 安全/健壮性：预设提权防护对**对象形态** `{mode,allow,deny}`（文档推荐写法）失效（只读档可被静默提权为 ask）· 点击劫持防护缺失（`frame-ancestors` 不支持 meta 标签而服务端未下发 HTTP 头）· 审计日志泄漏 URL 内嵌凭据 · `config.tools` 子进程不筛敏感环境变量 · `undo` 越界回落回滚**无关文件** · hook `matcher` 不支持文档写明的 `|`（策略钩子永不触发）· `grep` ReDoS 可绕过（`(a|aa)+$` 同步回溯 >180s 冻结整个进程）· `fetch` 上限在整包下载后才判（实测写满 30MB 才报错）· 深嵌套 MCP schema 抛 RangeError · `SSH_AUTH_SOCK` 被误剥离致 git-over-SSH 失效 · TLS 静默降级
- P2/P3 成本与平台：**峰谷单价按落账时刻判定**（跨 12:00/18:00 边界错记一档）· **cache-stats 轮转丢当天费用**（日费用护栏被静默重置）· **日界/避峰时区错位**（`beijingToDate` 硬编码 UTC+8，而 `beijingParts` 用可配置时区 → 覆盖 `pricing.timezone` 后错 12 小时）· Batch `--max-cost` 对无价模型静默失效 · `maxOutputCeiling`(384K) 只定义不生效（README 的「单次输出上限 384K」拿不到）· **macOS 自启必然静默失败**（plist 用裸命令 `mingdao`，launchd 极简 PATH 找不到，且从不 `launchctl` 注册）→ 改绝对路径 + 注入 PATH + bootstrap/bootout · 日志轮转写放大（达上限后每次追加整文件重写，2000 次 ≈1GB I/O；中文日志因字节/码元混用几乎不截断）· CI strict 棘轮排在 `npm ci` 之前空转假通过（tsc 缺失被当成 0 错误）
- 测试与工程：smoke 74→**81 组断言** · bench 208→**214 断言** · 全绿门禁 + strict 0/0 + tsc 0 错误；**并修正两处「测试自身编码缺陷行为」**——smoke 曾断言 `git status` 在非 git 目录**成功**（只有坏实现才成立）、tokenizer 断言锁定旧口径，二者都会让回归测试反过来保护 bug
- 官网（独立仓库）：论坛板块名未转义进列表页 `<h2>`（存储型 XSS）· 反代下限速按 `127.0.0.1` 聚合成全站共享配额 · `deploy.sh` 漏部署 `site-stats.mjs`
- 审计方法与剩余项：六路并行只读审计 + 独立复核，逐项给出 `file:line` 与复现证据；完整报告见 `docs/AUDIT-v0.4.6.md`（含 14 项登记待办与「已确认无问题」清单）

## v0.4.5（2026-09-07）— 费用护栏根因修复 + 本地模型 507 中断根治 + 调度/CLI/安全收尾

- P0 费用护栏：`estimateCost` 无价返 null（0 与「未知」语义分离）+ `costGuard` 显式 `noPricing` 告警，不再静默当「没花钱」；`recordUsage` 记录 null 成本（覆盖内置/外部/overrides 三来源）
- P0 任务锁与 kill：`withFileLockSync` 可重入（killTask 持锁二次抢锁自死锁 5s）；schedule pause/remove 的 killTask 包 try/catch；非 Linux（无 /proc）kill 降级为按 pid 存活即杀
- 调度器 pause 语义：标记 running / once-after 终态 / skipped / offpeak note / runOnce 元数据五处状态写全部「加锁 + 复查 paused」，执行期间 pause 不再被覆盖（every 已有防护，once/after 补齐）
- MacBook 本地 507 根治：parseStream/parseNonStream 识别 200 里夹带的 error 对象（memory_refusal）并上抛；agent 507 直结合回合透出降级提示（不计空轮、不空烧续写）；isLocalBaseUrl 补 /etc/hosts 复检 + customModels.local/isLocal 显式本地档（mtplx 自定义主机名不再误判远程）
- SSE [DONE] 后有界排空（捕获尾帧 usage 又不挂网关）；readBody close→499 释放 inflight 槽
- CLI `--model` 贪婪解析修复（后台/定时指定模型不再被顶层剥除、文本含 init 不误触发向导）
- worker 判 capHit（跑满步数上限判 failed）；every 崩溃恢复经 postRunStatus 重排回 pending
- git 只读工具拒绝 `--no-index`/`--output`/`-D`/`-f`/`-m` 等越界/破坏性参数；技能目录拒绝符号链接（lstat + containsSymlink）
- memory/pricing 整写改原子写；子代理 onUsage 透传；task(readOnly) 自动放行；fetch 重定向死代码；onUsage 带模型名归属

## v0.4.4（2026-09-07）— macOS 熄屏断连根治 + 审计可用性 + 技术评估修复

- macOS 长任务 network error 根治：生成期 `powerSaveBlocker('prevent-display-sleep')` 防熄屏（熄屏/Idle Sleep 中断 Chromium 网络栈是最终根因）；SSE 异常日志 JSON 化（此前 Electron 落 [object Object]）；统一中断续跑提示
- 审计可用性：`task` 工具加入只读档（审计/调研只读长任务可派 readOnly 子代理）；`recordUsage` 改逐轮入账（长任务期间「今日费用」实时累计、中断不丢）
- 技术评估 6.x：fs-browse 先 path.resolve 消解 `..` 段（中危）；MCP 子进程环境变量过滤（中危）；调度器 resume/once/after 状态写加锁；hooks spawn detached 整组清理；工作空间注册表原子写；附件文本上限按字节数

## v0.4.3（2026-09-06）— 正确性收尾（审计修复 + network error 诊断）

- network error 诊断闭环：渲染层 SSE 异常补全量诊断日志（此前静默中断零日志）；服务端断连日志区分「正常收尾 vs 客户端中途断开」；「网络错误」兜底改为可操作提示（检查点已保存，发「继续」续跑）
- 审计 P1×3：WebUI 自启 100% 失效（spawn 目标改 cli.js web）；sync-server 内容落盘锁内原子写；skill 安装 spawnSync→异步 spawn（不再冻结事件循环）
- 审计 P2×6：installFromUrl SSRF 防护（CLI 显式 URL 放行内网）；pricing ttlDays 初值 bug；cachestats 轮转加文件锁；autoTitle 独立 try/catch；--format json 输出纯净；孤儿 tool_calls 清理
- 低成本 P3×5：家目录脱敏边界、预设 name 字段遮蔽、IPv6 本地判定、hook 环境变量过滤、sandbox 空串归一化
- 项目简称 MDH 写入 README（自 v0.4.3 起统一使用）

## v0.4.2（2026-09-06）— 预设下拉体验修复 + 本地模型长任务 507 截断缓解

- Agent Preset 下拉：桌面版打包补 `presets/` 目录（此前漏打包致内置预设恒空、下拉无可选）；预设下拉接入自绘 tooltip（悬停秒现，不再等原生 title）；选中即时弹出「这是什么 + 覆盖字段」反馈；占位符改「无预设」显式退出；内置 local-audit 预设 permission auto→readonly（语义更准且避免 ask 用户被提权拦截静默忽略）
- 本地模型 507 截断缓解（依据排查报告）：只读子代理目标为本地模型时串行化（不再 Promise.all 无并发上限，避免多路大 prefill 打满内存）；本地模型压缩触发线默认 60%（远程仍 80%）；API 507 附「内存不足：压缩上下文/减少并发子任务/重启服务」可操作提示

## v0.4.1（2026-09-06）— 安全版本（偿还 v0.4.0 审计安全债 + macOS 本地模型修复）

- P0 安全 ×5：路径穿越防护（fs-tools 全工具限定工作目录 + `config.fsAllowDirs` 白名单 + `realpath` 逐级校验防软链接逃逸）；SSRF 302 重定向绕过（`redirect:'manual'` 手动跟随每跳复检、上限 5 跳）；权限前缀规则黑名单改白名单字符 `[A-Za-z0-9_ ./\\:-]`；预设 permission 提权拦截（`presetPermissionOverride` 三入口统一）；MCP 只读自动放行收紧为「仅 `trusted:true`」
- P1 正确性 ×6：turnToolCache 去重跨步生效（声明提到 for 轮内）；windowPressure 压缩成功后复位；mountConfigTools spawnSync→异步 spawn；batch.js 超窗口预检跟进 model-caps；语义检索无匹配回退最近 N 条；detectSandbox 改最小真实沙箱探测（bwrap 不可用降级 none）
- P2 质量 ×6：正则笔误 `/^f[c d]/`→`/^f[cd]/`；git log/diff 限量实现；cost-guard TDZ 前置；registerTool 增 `readOnly` 选项；context.js 死代码移除；reasoning 清洗 O(n²)→O(n)
- macOS 本地模型双根因：routing 开启时 `subagentModel` 恒返回 executor 致本地/自定义模型子代理 400 全灭 → 池外跟随当前模型；兜底总结全量历史（≈98k prefill 逼近 600s 超时被静默吞）→ 轻量输入 + 失败不再静默
- 子代理空输出透出 note 原因；`diagnose` 新增「当前模型能力」报告（本地模型未声明 contextWindow 时提示兜底 32k 后果）
- 桌面版 WebUI 自定义模型「修改」可直接改 API 地址/标签/上下文窗口/最大输出（留空不变）

## v0.4.0（2026-09-05）— 开放内核（Agent Preset · 第三方工具 · 公共 API）

- Agent Preset：声明式智能体预设 JSON（系统提示+工具白名单+权限+模型+参数），项目/用户/内置三级遮蔽 + schema 严格校验 + 会话级 overlay（不污染 config.json）+ 白名单硬拦截；CLI `--preset` / REPL `/preset` / WebUI 预设下拉三入口；内置「本地模型审计」示例
- 第三方工具：`registerTool` 程序化注册（进权限/审计/省钱 schema 链路，mcp__ 前缀护栏、坏条目不崩启动）+ `config.tools` 声明式 shell 命令包装（参数经 MINGDAO_TOOL_ARGS 环境变量防注入，幂等）
- 公共 API 冻结：`src/index.js` 按 @stable/@experimental 分组，24 个 stable 导出有契约测试锁定（minor 内向后兼容）；新增 `docs/DEVELOPER.md`（预设格式/工具注册/库嵌入/API 速查）
- 战略定调（STRATEGY-NEXT）：垂直产品 × 开放内核；本地/私有化第一公民与 DeepSeek 省钱并列双主攻；不引入插件内核、不做云平台
- 测试：smoke 72 / e2e-local 17 / e2e-web 22（CLI+WebUI 预设真实进程端到端：白名单真实下发/系统提示到达服务端/cfg 不污染）

## v0.3.2（2026-09-05）— 本地模型自适应（资源受限部署长任务不再中断）

- 本地模型自适应：本机/内网推理框架自动按「资源有限」对待——上下文窗口/预算/超时/工具输出截断按模型能力自动收紧，小模型低内存部署不撑爆、不误杀
- 安全预算推导：`budget = min(期望, 窗口×75% 舒适区, 窗口−输出−余量)`，prompt 永不逼近窗口边缘（根治长上下文 prefill 指数恶化 → 首 token 200s+ 被客户端掐断的 network error）
- 分层超时：首 token 等待（本地 600s/远程 300s）+ 流式空闲（120s）+ 总量（本地 30min/远程 10min），按「帧到达」判定存活，慢 prefill 不再被 3 分钟一刀切超时误杀；`config.timeout.*` 可覆盖
- 边缘检测 + 强制压缩：模型上报真实 prompt_tokens ≥ 窗口 85% 时下轮强制压缩（绕过非 DeepSeek 模型启发式计数 ±2 倍低估门槛）
- 工具输出截断自适应：单条工具结果按窗口/16 封顶（2k–20k 字），小窗口不再整条回灌大段代码
- 自定义模型声明 `contextWindow`/`maxOutputTokens`（WebUI 打通）；超时/自定义模型改配置即时生效（清 provider 缓存）

## v0.3.1（2026-09-04）— 真·省钱仪表盘 + 语义检索 + 只读调研 + 自动续跑

- 真·省钱仪表盘：费用徽标从设置移出、置顶主界面，点击展开（KPI 卡 + 命中率环状仪表 + 14 天趋势面积图 + 模型/工具 Top5 条形 + 最近缓存明细）
- 语义检索（零依赖）：项目记忆从「全量截断注入」→「按任务取相关条目」（分词 Jaccard），换任务只注入相关记忆、省 token 且保前缀缓存
- 只读调研工具：`git`（只读子命令白名单 + execFile 防注入）与 `fetch`（公网只读抓取，SSRF 防护 + DNS 复检），只读档扩至 8 工具；子代理步数 12→24 防截断
- 自动续跑：跑满步数不再中断，注入进度摘要自动续下一轮（`cfg.maxRounds` 默认 3）；收尾指令仅末轮注入，中间轮不提前打断
- 统一脱敏：`redact.js` 收敛审计/日志/诊断密钥脱敏（sk-/ghp_/Bearer/私网 IP/家目录路径）
- 续跑检查点合并（保留原始 goal + 合并 artifacts）+ CLI/REPL 交付物收集 + journal 工作空间归属
- 增量上下文（基线+变化）顺延 v0.3.2

## v0.3.0（2026-09-04）— 记忆与长跑

- 省钱基准：`bench-savings`（8 任务·综合省 63% 基线）+ `docs/SAVINGS-BENCHMARK.md` 并入 bench 链（bench 208 断言）
- 任务续跑 v1：agent `capHit` + task-state 侧车检查点；`--continue`/WebUI 恢复会话时注入进度摘要续跑（24 步不再死，已完成文件不重做）
- 项目级自动记忆 v1：`<工作空间>/.mingdao/memory.md` 轮末自动沉淀「决定/事实/结构/教训」并去重注入；会话内快照保证前缀缓存稳定
- `mingdao diagnose`：一键生成脱敏诊断包（环境/配置脱敏/日志尾/审计尾/工作空间 + 项目记忆定位）
- 增量上下文（基线+变化）顺延 v0.3.1（风险高，续跑进度摘要已覆盖主场景）

## v0.2.8（2026-09-03）

- 任务收尾总结对齐 DSH：跑满步数前注入收尾指令、末轮仍调工具时补 no-tool 兜底总结，交付物清单随总结输出（agent.js + server.js 兜底文案改写 + smoke 5c/5d 回归）
- B/C/D 计划：会话索引按会话名 sha1 分片（256 片，>1000 会话免单文件全量解析 + 增量只写脏片 + 旧单文件自动迁移）· 常量单源化（MAX_CONCURRENT/5MB/200KB 附件上限收敛到 src/web/constants.js，app.js/attachments.js/fs-tools.js 不再漂移）· WebUI ES Modules 拆分（app.js → util.js 纯工具 + constants.js）· 文档门禁（QA-REPORT 断言规模快照、CONFIG 补 downgrade/思考档位、CI 类型门禁统一 tsconfig.full.json）
- 思考模式/推理等级**按模型独立**（`reasoningByModel[模型]` 覆盖，旧全局 reasoningEffort 兼容；/api/state reasoning 字段 + /api/config 校验 + REPL /think 同步）
- UI 对齐 DSH：模型（紧凑选择器）、权限、思考下拉下移到输入区（发送键左侧），顶栏瘦身；权限/思考中文选项（询问/自动/只读 · 关/低/高/最高）
- 自绘悬浮气泡 tooltip 替换原生 title（权限/模型/思考/附件按钮/后台任务 chip，暗色主题一致）；轨迹/子代理「关闭」按钮字号缩小 + 不换行

## v0.2.7（2026-09-02）

- 自查 6 条修复 + 界面三项：stopDaemon 解析 pid + daemon 租约自退（防双守护重复执行，含 finally 条件删 pidfile 自检拦截的连锁退出回归）+ e2e-schedule 回归 · MCP 超时孤儿清理 · 护栏徽标 NaN 守卫 · 价格源协议/大小校验 · 日志权限 600 · 任务活动条宽度自适应+阶段回归 · task 子代理派发时机引导 · 后台任务 chip 详情 tooltip

## v0.2.6（2026-09-02）

- A 计划（前缀缓存稳定性与费用基准）：A1 工具 Schema 两态冻结（回合内 ≤2 payload，剥描述按回合快照）· A2 MCP 预热（6s 超时本会话冻结工具集）· A3 bench-cost 费用基准（schema 收益/两态冻结/护栏拦截/batch 半价 14 断言入 bench 链）· A4 回收幂等守卫（修复嵌套重截导致保留区字节逐轮漂移）+ 前沿对齐结论入基准

## v0.2.5（2026-09-01）

- Phase C 结构渐进：routes/api.js 按域拆分（7 域 + 编排器 + API 契约测试 8 组，修 icon 路径 bug）· cli REPL→commands/repl.js、worker→tasks/worker.js（tuiState 共享槽修复 onCompact 跨文件闭包）· strict 棘轮 1112→0（全量注解 + annotate-strict 辅助器，基线归零）

## v0.2.4（2026-08-31）

- Phase B 省钱第二轮：工具 schema 按需挂载（只读阶段收缩/已用工具瘦身-48%）· Batch 去重回填/超窗口预检/--max-cost · 费用二级分账（reasoning/byTool/byDay + WebUI Top5/折线）· 护栏 downgrade 切 flash · bench 扩到 150+ 断言 + 覆盖率阈值 60%

## v0.2.3（2026-08-31）

- 紧急修复 0.2.2 桌面三平台启动即崩：main.js 顶层 createLogWriter 漏导入（A6 重构遗留）——改为顶层 await import(srcRoot/log-writer.js)；新增静态护栏 + CI 打包冒烟（xvfb + MINGDAO_DESKTOP_SMOKE）

## v0.2.2（2026-08-31）

- Phase A 正确性收尾：sync 写锁、密码隐藏输入、fs-browse 基目录、body 分级、草稿按会话、日志统一、崩溃护栏、notify 结构化、run 参数合一

## v0.2.1（2026-08-31）

- Phase 3 工程化：测试汇总运行器、V8 覆盖率门禁、strict 棘轮、bench 入 CI、CHANGELOG 发布钩子；桌面 deb 更新引导、后台任务横幅、活动条合并、模型连通性测试、轨迹窄栏同显

## v0.2.0（2026-08-28）— Phase 2 结构治理

### 结构
- **server.js 拆路由模块**：全部 HTTP 路由抽至 `src/web/routes/api.js`（1299 → 579 行），服务器局部状态经 deps 显式传入（可变原语 state/refs 包装）
- **SPA JS 外置**：index.html 内联脚本抽至 `src/web/app.js`，CSP 收紧移除 `script-src 'unsafe-inline'`（417 行壳 + 1008 行逻辑）
- **cli.js 命令分发显式化**：`命令 → {module, handler}` 映射表替换字符串拼接三元嵌套；死导入清理

### 安全与正确性
- **SSRF 防护**：自定义模型/同步端点校验目标地址——对外监听时拒绝私网/回环/链路本地（本机回环绑定时放行本机模型服务，`web.allowPrivateEndpoints` 显式放行）
- **并发上限修复**：inflight 计数绑定请求生命周期（readBody 期间不再并发超限）
- **会话写互斥**：同一会话文件的追加与压缩重写按文件串行化
- **listen 修复**：runWebServer 等待绑定成功才 resolve，失败 reject；桌面端端口占用自动换端口重试（6 次），CLI 明确报错
- **sync-server 限流加固**：整表 clear → 最旧淘汰；键含用户名（防分布式 IP 绕过）；SYNC_TRUST_PROXY 控制 X-Forwarded-For；maxConnections 500
- **API Key 即时生效**：设置/删除 Key 后 provider 缓存失效，无需重启
- **更新下载失败可见**：发现新版本后下载出错弹窗提示官网手动下载；下载进度写日志

## v0.1.70（2026-08-28）— 更新器修复 · 静默可见性 · 布局重构

### 修复
- **Linux 自动更新下载失败根因**：打包环境下 `update-available` 回调的 info 参数为 undefined，旧代码 `info.version` 在监听器内抛 TypeError，中断 updater 事件派发导致 autoDownload 永不启动——全部监听器改 null-safe 且绝不在事件回调抛错
- **阶段静默深度优化**：服务端 progress 心跳新增阶段语义（模型推理中/执行工具中/等待权限确认）与子代理计数；客户端新增**顶部常驻活动条**（生成期间始终可见、滚动不影响：阶段 + 第 N 步 + 已 X 分 Y 秒 + N 工具步 + M 子代理）；回合边界（turnStart/turnEnd）继续播报
- **text=0 补偿反馈**：模型执行完工具但未输出总结时，done 提示改为「本轮共执行 N 步工具操作、交付 M 个文件，模型没有输出总结文字——可追问『总结一下刚才的工作』」

### 界面
- 输入框上方状态条文案缩短（⏳ N 步 · X 分 Y 秒 · N 工具步），移除冗余停止提示（按钮就在下方）
- **轨迹面板固定左侧栏**：聊天框左侧常驻「🧭 轨迹」栏，点击展开本轮轨迹详情（回合/工具/子代理），与消息顶部按钮等效
- **子代理面板右置**：顶栏「🤖 子代理 N」按钮展开右侧面板，列出本会话全部子代理（任务 + 结果可展开），与任务面板互斥
- Windows 更新完成弹窗改为友好提示（「更新已就绪」+ 正向文案，不再是报错观感）

## v0.1.69（2026-08-28）— 质量加固版（Phase 1）

### 修复
- 计费：`pricing.overrides` 根级价格现在同时传播到高峰价——此前高峰时段自定义价格被内置 peak 价替代，费用估算/护栏口径失真（H1）
- 调度：修复 every 任务执行期间 `pause` 被隐式恢复的确定性 bug（H2）；kill 前校验 PID 归属，防 PID 复用误杀（M11）
- 并发：新增 `src/atomic-write.js`（pid+随机 tmp 原子写 + O_EXCL 文件锁与陈旧锁回收）；config/credentials/update-state/session/session-index/sync 状态全部原子化；调度与任务读改写加锁（H3/H4）
- 压缩：手动 `/compact` 与自动压缩统一实现（同款 `<conversation_summary>` 标记，增量压缩可识别），修复双实现分叉（M7）
- 记忆：日期戳统一走配置时区（默认北京时间），修复 journal UTC 口径漂移（M8）
- 内存：undo 备份增加全局上限（64 文件 / 20MB，超限淘汰最旧），防长会话内存膨胀（M9）
- WebUI：主「■ 停止」只中断本任务（带 taskId），不再误伤其他标签页并发任务（L1）；`_activeTools` 被拒条目即时清理（L2）；任务面板保留最近完成历史并按年龄+数量双阈值清理（L3）
- 桌面/后台：worker/daemon/sleeper spawn 补 error 监听，ENOENT 不再崩进程（M12）；WebUI 自启失败给出可见提示（L6）

### 性能
- 上下文语义回收改为增量 token 求和（原每步全量重算，≤500×n）（M10）
- 费用护栏今日累计按 cache-stats 文件 mtime 缓存，不再每步全量解析（M10）

### 测试
- smoke 52 组 / e2e 21+16+7 / bench 38 断言全绿；新增原子写与文件锁、计费覆盖传播、pause 状态决策三组回归
