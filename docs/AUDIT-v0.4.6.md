# MingDao-Harness 全量代码审计报告（v0.4.6）

> 审计日期：2026-09-11 · 迁移至 macOS 后首次全量审计
> 审计对象：`MingDao-Harness`（v0.4.5 发布态基线 `5db5ef2`；本报告即 v0.4.6 的发布前自检）
> 方法：六路并行只读深度审计（工具/权限、WebUI、同步/调度、经济学、CLI/TUI/技能、官网/打包）＋ 主智能体独立复核与修复
> 结论：**已修复 50 处缺陷与口径问题（含 1 项 P0、19 项 P1）**，另有 14 项登记待办；修复后 6 套测试全绿（smoke 81 组断言）、strict 棘轮 0/0、tsc 0 错误。
>
> 本轮最重要的一条不是某个 bug，而是**一次口径自纠**：省钱基准「综合省 64%」实为虚高（详见 §2.3）。

### 后续轮次进展（README 式索引，正文保持 v0.4.6 发布时的快照不改写）

本报告的「登记待办」清单此后又消化了七轮，**仓库内可修的条目已全部收口**：

| 轮次 | 消化条目 | 主题 |
| --- | --- | --- |
| 第二轮 | T4–T9、T11–T13、T16 | 权限/工具/同步边角 |
| 第三轮 | T18、T21（两项）、T22（转义）、T23（描述上限） | WebUI/CLI 边角 |
| 第四轮 | T15、T14 | 调度生命周期（并发重跑 / 暂停后仍执行） |
| 第五轮 | T17、F7、T19（工作空间部分） | 同步与注册表 |
| 第六轮 | T1、T3 | 工作空间闸门 / 技能完整性诚实边界 |
| 第七轮 | T21/T22/T23 收尾、T10 | 同一会话回合串行化 |
| 第八轮 | T22 终项 | `box()` 宽度收敛、隐藏输入保留提示语 |
| 第九轮 | T20（三项）、T19（`sync-state`）、T22 收尾 | 进程归属跨平台 / 僵尸任务回收 / 终态写语义 / 密钥不经 argv / 帮助单一来源 |

**仅剩 2 项，均非「写代码就能修」**：
1. **T2 完整客户端隔离**——共享令牌语义下引入「每客户端作用域」会改变既有脚本客户端的行为，属**产品决策**；
   现状已在 README「安全」一节明写「共享令牌 = 同一用户，多人需一人一实例」，属诚实边界而非隐瞒。
2. **T24 openresty 对不存在路径返回 200+首页**——需服务器侧 `try_files` 配置，**不在本仓库内**，
   已在官网仓库说明。

> 提示：下方 §2 的「50 处」与「smoke 81 组」等数字是 **v0.4.6 发布当时**的快照，后续轮次未回填改写，
> 以免把历史结论改成事后更漂亮的样子。当前基线见 `RELEASE-NOTES-0.5.0.md` 与测试输出。

---

## 一、环境与基线（迁移后首次验证）

| 项 | 结果 |
| --- | --- |
| 平台 | macOS 26.6 (Darwin 25.6.0) · arm64 · Apple Silicon |
| Node / npm | v24.20.0 / 12.0.2（`engines` 要求 ≥18.17，CI 覆盖 18/20/22） |
| 依赖安装 | `npm install` ✅ 仅 4 个 devDependencies（typescript + @types/node），运行时仍零依赖 |
| 类型门禁 | `npm run typecheck` → **0 错误** |
| strict 棘轮 | `scripts/strict-ratchet.mjs` → 当前 0 / 基线 0 ✅ |
| 测试 | `test/run-all.mjs` → **6/6 套通过**（smoke / e2e-local / e2e-web / e2e-schedule / api-contracts / bench） |
| 基准 | tokenizer 16 · routing 118 · compaction 46 · cost 14 · savings 20 = **214 断言全绿**，综合省 **51%**（v0.4.6 口径自纠：此前报 208 断言 / 64%，含启发式计数与过期只读档副本） |
| 断言总数 | smoke 由 74 组提升至 **78 组**（新增回归断言） |

> 说明：本机为 Beijing 时区（UTC+8）。已额外用 `TZ=UTC/America/New_York/Europe/London/Australia/Sydney` 交叉验证峰谷计价与宿主时区无关 —— 主张成立。

---

## 二、已修复（50 处：主线 22 项 + 第二轮 10 项 + 第三轮 9 项 + 官网 3 项 + 口径自纠 6 项）

### P0 / P1 —— 安全与正确性

| # | 级别 | 缺陷 | 位置 | 修复 |
| --- | --- | --- | --- | --- |
| 1 | **P1** | **`git` 工具 100% 失效**：`await execFile(...)` 中 execFile 是回调式 API、返回 ChildProcess（非 thenable），解构出的 stdout/stderr 是两个可读流 → 恒返回 `ok:true exitCode:0 output:"[object Object][object Object]"`，不等待、退出码/ENOENT/maxBuffer/timeout 全被吞。git 属免确认只读工具且 schema 反复推荐 → 模型把「不是仓库/版本不存在」全当成功 | `src/tools/git.js:36` | `promisify(execFile)`；实测 `log` 返回真实提交、坏 revision 返回 exitCode 128 |
| 2 | **P1** | **WebUI 权限确认可被任意客户端代答**：`/api/permission` 只用可枚举的 `body.taskId` 取 pendingAsk，**从不校验 `body.id`**（ask nonce），也不校验调用方归属 → 任何能访问 API 的一方都能替他人挂起的写文件/执行命令确认直接答「允许」，绕过默认 ask 档的唯一人工闸门 | `src/web/routes/domains/misc.js:59`、`src/web/server.js:493` | 服务端强制校验 ask id；id 由 `crypto.randomBytes(16)` 生成（原 `Math.random` 非加密随机）；恢复 `options` 传递 |
| 3 | **P1** | **任意环境变量外泄**：自定义模型的 `envKey` 由 WebUI 接受任意输入、`baseUrl` 亦由调用方指定，密钥解析链 `[cm.envKey, 'MINGDAO_API_KEY']` 会把宿主环境里**任意变量**（AWS_SECRET_ACCESS_KEY/GITHUB_TOKEN…）当 Bearer 发到攻击者端点；不填 envKey 也会回落主密钥 | `src/providers/index.js:23-34` | envKey 收敛为「形如模型密钥」的白名单模式且排除 SECRET/TOKEN/PASSWORD/…；未声明（或被拒）时**不读任何环境变量**，只认凭证库 |
| 4 | **P1** | **SSRF 绕过（IPv4-mapped IPv6 十六进制形态）**：URL 解析器把 `[::ffff:127.0.0.1]` 规范化为 `[::ffff:7f00:1]`，旧判定只处理点分四段 → 判为公网；DNS 复检又对带方括号的 IPv6 字面量 lookup 失败后放行 → 可抓回环 WebUI(3820，默认无令牌)/内网服务/云元数据 | `src/tools/fetch.js:7-21`、`src/web/server.js:279-294`（副本） | 按数值展开 IPv6 八组判定，覆盖 IPv4-mapped / IPv4-compatible / NAT64 64:ff9b::/96 / fe80::/10 / fc00::/7；删除 server.js 副本改为单一来源；22 条 IP 形态断言全绿 |
| 5 | **P1** | **hooks / MCP 子进程 stdin 无 error 监听** → 子进程先退出且载荷 >64KB 时 EPIPE 异步未捕获异常，**整个进程崩溃**（WebUI 下所有并发会话一起死）；仓库无 `uncaughtException` 兜底 | `src/hooks.js:92`、`src/mcp.js:140,151` | 两处 `child.stdin.on('error', () => {})` |
| 6 | **P1** | **`edit` 静默写坏文件**：单处替换用 `String.replace(old, new)`，`new_string` 里的 `$&`/`` $` ``/`$'`/`$$` 被当替换模式 → 写 shell/模板字符串/正则/sed 时静默产生错误内容甚至复制文件尾部，仍回报「已编辑成功」 | `src/tools/fs-tools.js:294` | 改用函数式替换值 `replace(old, () => newString)`，与 `replace_all` 路径语义统一 |
| 7 | **P1** | **`deny` 规则 fail-open**：防 allow 提权的「白名单字符校验」被同一函数用于 deny，命令含 `& ; \| @ = ' " Tab` 等元字符即失配 → 回落 mode；auto 档下 deny 是唯一防线，等于不存在（`deny:['bash:rm *']` 放过 `rm -rf /x; echo done`、`curl -d @/etc/passwd …`） | `src/permissions.js:37` | deny 与 allow 分开匹配：deny 一律按命令原文匹配，不设字符白名单（allow 白名单保留） |
| 8 | **P0** | **费用护栏对 9/12 内置模型完全失效**：`effectivePricing` 在读 `pricing.overrides` **之前**就因无内置价 `return null` → hasPricing=false → estimateCost=null → cache-stats 记 cost=null（当 0 累计）→ todayCost 看不到消费 → 护栏永不拦截；而护栏给出的补救办法恰是这条不生效的路径。gpt-5/qwen/glm/kimi/本地/动态发现模型全部中招 | `src/pricing.js:231` | overrides 与 ext/preset 等价作为价格来源；仅靠 overrides 供价时要求 input+output 均为有限正数（防半张价格表把缺失侧当 0）。实测：配 overrides 后 hasPricing=true、todayCost 由 ¥0.15 → ¥100.21、护栏正确 block |
| 9 | **P1** | **read-after-write 命中旧缓存**：v0.4.1 把 `turnToolCache` 提到轮内让去重跨步生效，却没有失效点 → 同回合「read a → write a → read a」第 3 步返回**写入前**内容，模型误判写入未生效 | `src/agent.js:227,574` | 有副作用工具执行（含失败）后整片作废只读缓存；只读工具与 `task(readOnly)` 保留缓存 |
| 10 | **P1** | **子代理 token 消耗完全不计费**：`spawnTask` 只用子代理返回文本，其 usage 从不并入父回合 → CLI/REPL（无 onUsage）恒漏计，README 主推的「多方向并行调研」漏计最重 | `src/agent.js:104-116` | 子代理 usage 并入父回合累加器；同时不再向子代理透传 onUsage（避免 WebUI 对同一笔重复入账） |
| 11 | **P1** | **步数上限兜底总结永远不显示**：进入兜底总结前已多次 `io.endTurn()`，TUI 的 renderer 被置空，而 `onDelta → writeText` 只做 `renderer?.push()` → 总结被静默丢弃。跑满 24 步的长任务（审计/重构/调研）在终端只看到一屏工具调用、没有最终答复 | `src/agent.js:823,840` | 兜底总结前重新 `io.beginTurn()`、结束后 `io.endTurn()`（web-io 的 beginTurn 为空实现，不受影响） |
| 12 | **P1** | **自动压缩吞掉整段会话**：`compactTrigger < 0.6`（文档化的 0–1 可调项）或 `force` 时，保留循环不 break，boundary 保持 messages.length → 除 system 外**全部**压成摘要（连最新用户指令只剩转述），WebUI 的 onCompact 还会 rewriteSession 永久写回会话文件 | `src/compact.js:67-80` | 触发线夹紧到 ≥ TARGET_RATIO；并在「无可丢前缀」时改为保留最后 2 条原文（至少覆盖最近一轮问答），不再产出「system + 摘要」 |
| 13 | **P1** | **`reasoning_content` 完全不计入上下文预算**：带 tool_calls 的 assistant 消息会原样回传完整 reasoning（DeepSeek thinking 硬要求），但 messageTokens 只算 content+tool_calls → 实测单条 4400 字 reasoning=2000 token 只算 33（低估 61 倍），预算/压缩/护栏预检同源低估 | `src/context.js:13-19` | `partTokens` 计入 `reasoning_content` |
| 14 | **P1** | **冲突备份对产品不可见**：producer 写 `<名>.server-<时间戳>-<随机>.jsonl`，consumer 正则只认 `<名>.server-<纯数字>.jsonl` → `listSyncConflicts` 恒空、`resolveSyncConflict` 恒报「没有找到」，「冲突三选一」100% 失效；备份还会被当成普通会话推送到其他设备变成幽灵会话 | `src/sync.js:222` vs `:440,467`、`src/session.js:11` | `session.js` 导出共享 `CONFLICT_BACKUP_RE` + `isConflictBackupName`；三处共用；`listSessions` 排除备份（同步/会话列表/搜索一并修复）；补真实 producer 的端到端回归断言 |
| 15 | **P1** | **sync-server 限流可被查询串绕过**：桶键用 `req.url`（含 query）而路由用 pathname → 每个请求加随机 `?x=` 即每次落进新桶，登录/配对/改密限流整体失效（scrypt 18ms/次 → 无限速爆破 + 阻塞事件循环的 DoS） | `src/sync-server.js:152` | 桶键改用解析后的 pathname；新增独立服务器的限流回归断言 |

### P2 / P3 —— 正确性、健壮性与打包

| # | 级别 | 缺陷 | 位置 | 修复 |
| --- | --- | --- | --- | --- |
| 16 | P1 | **npm 包与桌面版都缺 `skills-lib/`**：22 个可安装技能库既不在 `package.json#files` 也不在 Electron `extraResources`，而 `skill-lib.js` 运行时按 `../skills-lib` 读取（ENOENT 被 try/catch 静默吞）→ README/官网主打的「36 个技能」在两条主分发渠道只剩 14 个 | `package.json:14`、`desktop/electron-builder.yml:20` | 两处补 `skills-lib/`；新增静态护栏断言「src 里所有 `new URL('../dir')` 资源目录必须同时出现在 npm files 与 extraResources」 |
| 17 | P1 | **桌面版版本漂移**：`desktop/package.json`=0.2.0（根 0.4.5），而 `npm run dist:linux\|win\|mac`（README 教用户的入口）**不跑同步脚本** → 本地按文档打包产出 0.2.0 安装包/应用 | `desktop/package.json:3,13` | 为 4 个 `dist:*` 增加 `predist:*` 前置同步；当前已同步为 0.4.6；新增版本一致性断言 |
| 18 | P2 | **日志轮转写放大**：保留区恰好等于上限 → 达上限后**每次追加都整文件重写**（实测 2000 次追加 ≈1GB I/O）；且 `raw.length`（UTF-16 码元）与 `st.size`（字节）单位混用，中文日志只砍一行 | `src/log-writer.js:16-25` | 按字节定位行边界（`Buffer.lastIndexOf(0x0a)`）+ 轮转到 `maxBytes/2` 低水位；实测 3000 次追加仅 5 次轮转 |
| 19 | P3 | 已存在的 644 日志永不收权（mode 只在创建/轮转生效） | `src/log-writer.js:13` | 每次追加后 `chmodSync(0o600)` |
| 20 | P2 | TLS 静默降级：只设 `SYNC_CERT`/`SYNC_KEY` 之一时启动明文 HTTP（默认端口 443），部署方以为在跑 HTTPS | `src/sync-server.js:674` | 两者必须同时提供，否则拒绝启动；非回环明文绑定追加醒目告警 |
| 21 | P2 | `estimateBatchCost` 对无价模型返 0 → `--max-cost` 预算拦截静默失效、/cost 把未知费用显示成「免费」 | `src/pricing.js:185`、`src/batch.js:141` | 返 null（与 `estimateCost` 的 P0-4 同口径）；`--max-cost` 遇未知即 fail-closed 中止并给配置指引；CLI 显示「未知」而非 ¥0 |
| 22 | P3 | 桌面版 `files`/`extraResources` 与运行时资源目录的一致性无任何测试守护（正是 #16 长期未被发现的原因） | `test/smoke.js` | 见 #16 的静态护栏 |

---

### 第二轮：安全与健壮性（T1–T13 中的低风险项，全部已修）

| # | 级别 | 缺陷 | 位置 | 修复 |
| --- | --- | --- | --- | --- |
| 23 | P2 | **`undo` 越界回落**：显式传越界 path 时静默落到「撤销最近一次」分支，回滚**无关文件**（指定 `/etc/hosts` 却还原了 `important.txt`）并回报成功 | `src/tools/fs-tools.js:126` | 指定路径与省略路径语义分开：越界直接返回边界错误 |
| 24 | P2 | **hook `matcher` 不支持 `\|`**：CONFIG.md 官方示例写 `"write\|edit\|bash"` 并声明支持 `\|`，实现只按 `,` 切分 → 按文档写的策略钩子永不触发（fail-open） | `src/hooks.js:22` | 同时支持 `,` 与 `\|` |
| 25 | P2 | **URL 内嵌凭据未脱敏**：文件头注释一直声称覆盖，规则里却没有 → `git clone https://oauth2:glpat-…@host`、`postgres://user:pw@host` 原样落入 `audit.jsonl` 与诊断包 | `src/redact.js:15` | 新增 `://user:pass@` 掩码规则（保留用户名/主机便于排查） |
| 26 | P2 | **预设提权防护对对象形态失效**：`permission` 为文档推荐的 `{mode,allow,deny}` 时对象做 `in` 运算键名变 `[object Object]` → 当前 `{mode:'readonly'}` 被判为 `ask`，项目级预设可把只读**静默提权**为 ask | `src/presets.js:160` | 归一化 mode；识别不出的输入取最保守 readonly（fail-closed）；拦截时保留原对象结构 |
| 27 | P2 | **深嵌套 schema 崩溃**：`stripDescriptions` 无深度上限，恶意 MCP `inputSchema`（20 万层）抛 RangeError，且 `buildToolSchemas` 每轮都跑 → 该会话此后每轮报错 | `src/tools/index.js:388` | 深度上限 32，超深原样保留 |
| 28 | P3 | **`config.tools` 子进程不筛敏感环境变量**（bash/hooks/MCP 都筛）——唯一不一致的子进程入口，可读到 `MINGDAO_API_KEY`/`AWS_SECRET_ACCESS_KEY` | `src/tools/index.js:339` | 复用 `buildChildEnv`（从 bash.js 导出） |
| 29 | P3 | **`SSH_AUTH_SOCK` 被误判为敏感变量剥离** → bash 内 git-over-SSH / ssh-agent 失效（macOS 常态） | `src/tools/bash.js:17` | 连接句柄显式放行，其余过滤语义不变 |
| 30 | P3 | **缺点击劫持防护**：CSP 的 `frame-ancestors` 不支持 meta 标签，而服务端未下发 HTTP 头 → 任意网页可 iframe 嵌 WebUI 并叠透明层把点击导向权限弹窗「允许」 | `src/web/constants.js`、`api.js`、`server.js` | 统一下发 `frame-ancestors 'none'` / `X-Frame-Options` / `nosniff` / `Referrer-Policy` |
| 31 | P2 | **`fetch` 上限在整包下载后才判**：实测服务端写满 30MB 才报错（15s abort 只限时不限字节）→ 内存 DoS | `src/tools/fetch.js:131` | 先看 Content-Length，再边读边累计，超限立即 `cancel()`（实测 1MB 内中止） |
| 32 | P2 | **`grep` ReDoS 可绕过**：`(a\|aa)+$` 的括号内无量词，逃过「嵌套量词」启发式 → 20KB 行同步回溯 >180s，冻结整个 Node 进程 | `src/tools/fs-tools.js:445` | 新增「同前缀歧义分支 + 量词」精确判定（不误伤 `(foo\|bar)+`）+ 5s 总时间预算 |

### 第三轮：成本口径与平台正确性

| # | 级别 | 缺陷 | 位置 | 修复 |
| --- | --- | --- | --- | --- |
| 33 | **P1** | **启发式计数不是「保守上界」**：纯标点低估 3 倍、单字母词/随机字母数字 2 倍、纯数字 1.3 倍（10 类样本 6 类偏低）→ 非 DeepSeek 模型预算/压缩/批量预检系统性偏小 | `src/tokenizer.js:137` | 改为按字符类别 + 连续串估算（标点 1:1、数字 1/2、字母串 ≥1、空白不重复计）；实测 11 类样本 3 类轻微低估（≤9%）、平均比值 1.14。**并修正文档中「普适上界」的虚假表述** |
| 34 | **P1** | **省钱基准虚高（口径自纠）**：④⑤ 用启发式计数测「面向 DeepSeek 的省钱主张」（JSON 结构字符多，偏差 1.1–1.8 倍）；⑤ 还维护了一份**过期 6 工具副本**（实现已在 v0.4.4 加入 `task`）→ 报出「综合省 64%」 | `test/bench/bench-cost.mjs`、`bench-savings.mjs`、`test/smoke.js` | 改用随包官方词表精确计数；只读档集合从 `agent.js` 单源导出；新增类别化断言。**真实值：④48.9%、⑤28.9%、综合 51%**，并同步修正 `SAVINGS-BENCHMARK.md` / `STRATEGY-NEXT.md` |
| 35 | P3 | `maxOutputCeiling`（官方 384K 单次输出规格）**只定义零引用** → README「单次输出上限 384K」在框架里拿不到 | `src/models.js:57`、`model-caps.js`、`agent.js:47` | 纳入能力面并作为显式 `maxOutputTokens` 的硬上限 |
| 36 | P2 | **日界/避峰时区错位**：`beijingParts` 用可配置时区，`beijingToDate` 却硬编码 UTC+8 → 覆盖 `pricing.timezone` 后日界与 `--offpeak` 顺延错 12 小时（美东实测） | `src/pricing.js:145` | 按目标时区真实偏移换算（两遍法处理夏令时） |
| 37 | P2 | **峰谷单价按落账时刻判定**：跨 12:00/18:00 边界的请求错记一档（1M prompt 的 pro 调用 ¥9 vs ¥4.5） | `src/agent.js`、`src/cachestats.js` | 记录请求**发起**时刻并作为计价锚点 |
| 38 | P2 | **cache-stats 轮转可丢当天早期费用**：只保留最后 1 万行 → todayCost 变小、日费用护栏被静默重置 | `src/cachestats.js:47` | 轮转保留「当天全部 + 最近 KEEP_LINES」并保持原顺序 |
| 39 | P2 | **macOS 自启必然失败**：plist 用 `/bin/sh -c "mingdao web 3820"`，launchd 极简 PATH 下找不到命令，且从不 `launchctl` 注册 → 静默不自启 | `src/autostart.js:41` | 改用 `process.execPath` + `cli.js` 绝对路径 + 注入 PATH + `launchctl bootstrap/bootout`（plutil 校验通过） |
| 40 | P2 | **CI strict 棘轮空转**：`npm ci` 排在棘轮之后，`npx tsc` 找不到 typescript 时按「0 错误」报 ✅ | `.github/workflows/ci.yml`、`scripts/strict-ratchet.mjs` | `npm ci` 前置；棘轮在 tsc 不可用时以退出码 2 失败（实测） |
| 41 | — | 测试本身编码了缺陷行为：smoke 断言 `git status` 在非仓库中**成功**（只有坏实现才成立）、tokenizer 断言锁定旧口径 | `test/smoke.js` | 改为断言真实语义（含 git 退出码 128 透传、真实 log 输出） |

### 第四轮：官网仓库（独立仓库，已单独提交）

| # | 级别 | 缺陷 | 位置 | 修复 |
| --- | --- | --- | --- | --- |
| 42 | P2 | 论坛**板块名未转义**进列表页 `<h2>`（仅搜索分支转了义）→ 管理员/首位注册者可持久化 XSS | `bbs/index.html:246` | 板块名同样 `esc()` |
| 43 | P2 | 论坛限速在 openresty 反代下按 `127.0.0.1` 聚合 → 退化为**全站共享**配额（11 次登录/分钟即锁死全站） | `bbs/bbs-server.js:95` | 来自本机代理时信任 `X-Forwarded-For`（格式校验）+ 桶按时间淘汰（原先整表 clear 可自解限速） |
| 44 | P3 | `deploy.sh` 不部署 `site/site-stats.mjs`，与 README「服务器以本仓库为唯一事实来源」矛盾 | `deploy.sh` | 纳入部署范围 |

## 三、登记待办（14 项，未在本轮修复）

> 均已定位到 `file:line` 并有可复现路径；按优先级排列，建议 v0.4.7 / v0.5.0 消化。
> 消化进度：第二轮 T4–T9、T11–T13、T16；第三轮 T18 / T21（两项）/ T22（转义）/ T23（描述上限）；
> **第四轮 T15 + T14（调度生命周期）**——这两条是本清单里影响面最大的（同一任务被并发执行两次 / 暂停删除后仍执行）；
> **第五轮 T17 + F7 + T19；第六轮 T1（工作空间登记闸门）+ T3（技能完整性诚实边界）；
> 第七轮 T21/T22/T23 收尾（WebUI/CLI 边角 + 技能名校验）+ T10（同一会话回合串行化）；
> **第八轮 T22 终项（`box()` 终端宽度收敛 + 隐藏输入保留提示语）；
> 第九轮 T20（进程归属跨平台 / 僵尸任务回收 / 终态写不复活 killed）+ T19（`sync-state` 末尾合并）
> + T22 收尾（`key set` 改走 stdin、帮助正文合并为单一来源）；
> 第十轮 T25–T29（v0.6.0 实现决策回放时发现的约束引擎 fail-open 与契约缺口）。**
> 下表为**剩余**项。

### 第十轮（v0.6.0 实现 C2 时发现，均已修）

> 这一轮的共同形态值得单独记住：**合规特性静默失效比直接报错危险得多**。
> 报错会被人看见；「看起来在保护你、其实没有」不会。四项里有三项属于此类。

| # | 级别 | 缺陷 | 位置 |
| --- | --- | --- | --- |
| T25 | **P1** | `arg-forbid` 的 `pattern` 非法正则时求值失败 → `re` 为 null → **红线永不命中**，且不进 `invalid`。作者以为有约束、实际没有；与本模块自述的「fail-closed」原则直接矛盾（✅ 已修：`isValidPattern` 单一来源 + 运行期 fail-closed + 装载即拒绝） | `src/constraints.js` |
| T26 | P2 | `arg-forbid` 缺失 `pattern` 退化成 `new RegExp('')`（匹配一切），「忘了写」变成「该参数任何取值都拦」，理由印出 `/undefined/`（✅ 已修：缺失即判不可用并在装载时拒绝） | `src/constraints.js`、`src/packs.js` |
| T27 | **P1** | `result-forbid` 在 `PACK-API.md` v1 契约表格与引擎头注释中列出，但 kind 集合与实现**都没有它**——下游按冻结契约写会被判「kind 非法」而整包装载失败。成因是 `packs.js` 另存了一份 kind 集合副本并已漂移（✅ 已修：实现补齐 + kind 集合单一来源） | `src/constraints.js`、`src/packs.js`、`docs/PACK-API.md` |
| T28 | P2 | `arg-forbid` 只校验 `tool` 不校验 `arg`：漏写 `arg` 时引擎读 `args[undefined]` 并与字符串 `"undefined"` 做匹配——看起来在跑、其实判错对象（✅ 已修：装载时要求 `arg` 必填） | `src/packs.js` |
| T29 | P2 | 契约缺口未登记：`require-citation`（输出前 kind）与 `mingdao constraint test <pack>` 在 `PACK-API.md` 中列出但从未实现，文档等于在做空头承诺（✅ 已修：新增 `PACK-API.md §4.1` 明确标注「请勿依赖」，并说明 `require-citation` 需先与下游定规格） | `docs/PACK-API.md` |

### 安全 / 隔离

| # | 级别 | 问题 | 位置 |
| --- | --- | --- | --- |
| ~~T1~~ | ✅ 已修 | ~~`/api/workspaces` 对任意绝对路径 `mkdirSync(recursive)`；登记 `/` 后 `fs-browse` 围栏自我解除~~ 现 `add`/`set` 均设**登记闸门**（仅允许 家目录 / 系统临时目录 / 启动目录 / 当前工作目录 / `web.browseRoots`，可用 `web.allowAnyWorkspaceDir: true` 显式放开）；`add` 的自动建目录同样受限；浏览基目录与登记闸门**共用同一份 `allowedRoots`**（此前两处各写一份） | `web/routes/domains/workspace.js:28-52,86-110,120-135` |
| T2 | P2 | `/api/abort`、`/api/tasks` 无归属校验：同一 token 下可中断他人任务、读取他人任务消息与会话名。**部分收敛**：taskId 由顺序号改为不可枚举随机值（消除盲猜）；**完整隔离未做**——共享 token 语义下没有「每客户端作用域」，引入客户端 cookie 作用域属产品决策（会影响无 cookie 的脚本客户端）。已在 README「安全」一节明确写下「共享令牌 = 同一用户，多人需一人一实例」这一边界 | `web/server.js:349`、`README.md` |
| ~~T3~~ | ✅ 已修 | ~~项目级技能 sha256「防仓库投毒」可自签/可缺失，属过度承诺~~ 按「诚实」修：注释改为准确描述（只能发现**安装后本地被改动**，对投毒零收益）；项目级技能在系统提示里标注「（项目级·来源不可验证）」；加载时给一次性 stderr 提示；新增 `config.disableProjectSkills` 可整层关断（受监管场景） | `src/skills.js:50-60,104-115,135-170` |

### 正确性 / 健壮性

| # | 级别 | 问题 | 位置 |
| --- | --- | --- | --- |
| ~~T10~~ | ✅ 已修 | ~~同一会话并发回合未串行化~~ 新增进程级 `busySessions`：同一会话文件同一时刻只允许一个回合，第二个请求收到明确引导（不同会话仍可并行——多任务招牌不变）；用 `res` 的 `close` 兜底释放，避免漏放导致会话永久「忙」 | `src/web/server.js:259-264,405-425` |
| ~~T14~~ | ✅ 已修 | ~~daemon 模式 `lastTaskId` 仅在跑完后写 → pause/remove 无法停止在途运行；`--offpeak` 等待期间 pause/remove 后仍会启动~~ 现 `markRunning` 与 `runOnce` 启动瞬间即落 `runnerPid`/`lastTaskId`；避峰等待醒来后复查 paused/已删除 | `src/schedule.js:401,455-470` |
| ~~T15~~ | ✅ 已修 | ~~重复 daemon → 同一调度任务被并发执行两次~~ 四处协同修复：① `spawnDaemon` 的「查活→spawn→写 pidfile」移入跨进程锁（消除并发双 spawn）；② `markRunning` 即写 `runnerPid`、`runOnce` 启动瞬间写 `lastTaskId`（关闭恢复分支的误判窗口）；③ 恢复分支先看 `procAlive(runnerPid)`，「宿主还活着就等它」；④ 租约丢失时通知在途 `runSleeper` 退出（`shouldStop`）并在收尾后 `process.exit(0)`（此前 every 型常驻协程会把旧 daemon 永远撑住）。新增端到端回归：接管后任务 `runs` 必须为 1（修复前实测为 2） | `src/cli.js:289-345`、`schedule.js:319-350,401,455-470` |
| ~~T17~~ | ✅ 已修 | ~~辅助模型调用从不入账~~ 新增 `cachestats.recordAuxUsage`（带 `aux`/`auxReason` 标记，独立入账不与回合级重复计费），接入路由分类器 / 自动标题（两处）/ 记忆提炼（两处） | `src/cachestats.js`、`routing.js:111`、`titles.js:45,60`、`memory.js:185,324` |
| ~~T18~~ | ✅ 已修 | ~~`withFileLockSync` 把 `fn` 的 `EEXIST` 误判为「锁被占」→ 同步死循环~~ 已用 acquiring 标志分离「抢锁」与「执行 fn」两个阶段 | `src/atomic-write.js:47-70` |
| T19 | P3 | ~~`workspaces.json` / `session-workspaces.json` 的 read-modify-write 未加锁~~（✅ 已修：add/remove/rename/touch 与三个会话级映射全部移入跨进程锁）；~~`sync-state.json` 的 RMW 未加锁~~（✅ 已修：改为 `commitState(delta)` **末尾合并**——临界区内只做「重读磁盘 → 并入本次变更的键 → 写回」，毫秒级完成，不把跨网络的秒级耗时关进锁里；`syncPush`/`syncPull`/`syncShareAccept` 三处写点全部改造） | `src/workspace.js`、`src/sync.js` |
| T20 | P3 | 调度/任务的生命周期边角（**三项全部已修**）：~~僵尸任务不回收~~（✅ `reapTasks` + 调度轮询内即时回收，2h 空转 → 数秒）；~~`killed` 被 worker 的终态写覆盖~~（✅ `patchTask(..., {terminal:true})` 锁内复查，`killed` 是用户显式意图不可被复活，诊断字段仍吸收）；~~无 `/proc` 平台无法校验 PID 归属~~（✅ 新增 `src/proc.js`：Linux 走 `/proc`、其余平台回退 `ps -ww -o command=`，三值语义 true/false/null 严格区分「是我们的人 / 明确不是 / 无从判断」；**Windows 无 /proc 也无 ps，
故诚实返回 null 并写明边界**，不为这一处判定引入 PowerShell/WMI 依赖——能力由 `ownershipVerifiable()` 自证，测试按能力分支而非猜平台名） | `src/proc.js`（新增）、`src/tasks.js`、`src/schedule.js`、`src/tasks/worker.js` |
| ~~T21~~ | ✅ 已修 | WebUI 边角全部收敛：草稿槽 LRU 64 槽；`/api/config` 校验模型名（保留 `provider:"custom"` 任意端点形态）；`updateCustom` 不再 upsert（不存在即 400）；非法 JSON body → 400（不再静默当 `{}` 并落盘）；`/api/session-finalize` 缺文件 → 404 且不回显服务端绝对路径；`HEAD` 与 `GET` 同等对待（不再 415） | `web/routes/domains/{sessions,config}.js`、`web/server.js:125`、`routes/api.js:44` |
| T22 | P3 | TUI/CLI 边角：~~ANSI/OSC 转义直通终端~~（✅ `sanitizeTerminal`）、~~`batch` 清空全进程 SIGINT 监听~~（✅ 只摘自己那一个）、~~`box()` 不看终端宽度~~（✅ 总宽统一 + 按 `process.stdout.columns` 收敛，边框行与内容行此前必然错位一列）、~~隐藏输入把提示语一起隐藏~~（✅ 先写提示语再抑制回显，已修）、~~`key set` 经 argv 传密钥~~（✅ 改走 stdin，argv 路径保留但警告其在 `ps` 中可见，明文始终不回显）、~~HELP_LINES 两份已分叉~~（✅ 合并为 `src/help.js` 单一来源，variant 差异显式声明；CLI 与会话内帮助输出经逐字节比对与重构前完全一致）（**本项全部收口**） | `src/ui.js`、`src/help.js`（新增）、`src/commands/{key,repl}.js`、`src/cli.js` |
| T23 | P3 | 技能/安装链边角：~~技能 `description` 无长度上限~~（✅ 200 字符上限）、~~技能「安装/信任/重装」三入口不校验名称~~（✅ 统一到 `assertSafeSkillName`：拒绝 `.`/`..`/含 `..`/含分隔符/超长）、`install.sh` 的 Node 门槛已改为完整版本比较（≥18.17，此前 18.0–18.16 被误判合格）+ 临时文件改用 `mktemp`；一行安装改为「先下载再执行」（README 与官网同步） | `src/skill-lib.js:85`、`install.sh:71,84` |
| T24 | P3 | 官网/IDE 边角：~~VS Code「发送选中代码」不生效~~（✅ 已修：窗口重新获得焦点时兜底读全局草稿槽）、~~JetBrains 文档要 `./gradlew` 但仓库无 wrapper + 产物版本写死 0.5.0~~（✅ 已修文档）；openresty 对不存在路径返回 200+首页（**需服务器侧 `try_files`，不在仓库内**，已在官网仓库说明） | 官网 nginx 配置、`ide/vscode/README.md`、`ide/jetbrains/README.md` |

## 四、已确认无问题（避免过度修复）

以下机制经实测或逐行追踪确认**可靠**，本轮审计中未被列为缺陷：

- **文件边界防护**：`..`/绝对路径越界、软链目录逃逸、写软链目录全部拒绝；`fsAllowDirs` 生效；macOS `/tmp → /private/tmp` 场景正确；`walkFiles` 不跟随软链。22 条越界探针（含 `~/.ssh/id_rsa`、`credentials.json`、`/etc/passwd`、URL 编码与双点花招）全部拦住。
- **bash 沙箱**：档位不可被模型降级；macOS 无 bwrap 时显式 note 降级（不假装）；超时整进程组清理无残留；敏感环境变量默认剥离。
- **MCP**：子进程环境默认过滤；`readOnlyHint` 仅在 `trusted:true` 时被信任；子进程输出 20MB 缓冲上限 + 组杀。
- **WebUI 认证**：非回环强制 token（三通道 + `timingSafeEqual`）、Host 头校验（DNS rebinding 403）、CSRF Origin/Content-Type、全部路径穿越防护、body 按字节分级限制、并发 8 上限后 429、SSE 中断无 inflight 泄漏、XSS 汇聚点全部 `esc`/`textContent` + CSP `script-src 'self'`。
- **sync-server 认证与隔离**：scrypt + 盐 + `timingSafeEqual`、192-bit 设备 token 只存哈希、改密吊销全部设备、用户名/会话名白名单挡穿越、跨用户访问 404。
- **同步数据安全（常规路径）**：pull 不覆盖非空本地文件（差异写 `.remote-*`）；push 备份已知的远端版本；冲突副本原子写。
- **峰谷计价**：单价表与「命中=未命中/30」「闲时=高峰/2」完全自洽；边界（09:00 含 / 12:00 不含 / 14:00 含 / 18:00 不含 / 周末闲时）正确；**宿主时区无关**（6 个时区交叉验证一致）。
- **tokenizer**：BPE 实现经独立参考实现交叉验证 330/330 一致；词表完整（127,741 merges + 818 added）；黄金值在两套独立实现下均成立。
- **裁剪**：不产生孤儿 `tool` 消息、不越预算、system 恒保留。
- **原子写与文件锁**：tmp 名含 pid+随机、rename 原子替换；锁可重入、异常释放、超时保护、陈旧锁 TOCTOU 防护。
- **凭证隔离**：`credentials.json` 独立于 config、0600、`maskKey` 只露首 6 末 4；`redactSecrets` 对 `sk-`/`ghp_`/Bearer/`api_key=` 等有效。
- **桌面壳边界**：`contextIsolation:true` / `nodeIntegration:false` / `sandbox:true`；外链走系统浏览器；`will-navigate` 白名单。
- **官网发布面**：5 个安装包 sha256/sha512/大小与线上**逐字节一致**；6 个下载 URL 全部有效；技能 registry 三镜像索引与 22 个技能文件 sha256 全部吻合；两仓库无密钥入库。

---

## 五、审计方法说明与局限

**方法**：六路并行只读审计（每路覆盖独立子系统，要求给出 `file:line` 证据 + 可复现路径 + 实测确认），主智能体独立复核关键结论并用最小复现脚本验证，再集中修复。所有复现脚本位于 `/tmp`，未污染仓库。

**局限（诚实边界）**：

1. **无法离线验证词表出处**：本机 bash 无外网、`web_fetch` 取不到官方 `tokenizer.json`、环境无 transformers/HF 缓存 → 12 条黄金值只能证明「与随包词表自洽」，不能证明独立来自官方词表（但已用独立参考实现交叉验证实现正确性）。
2. **官方价格数字与 Batch 折扣语义无法离线核对**：只验证了内部一致性与算术正确性。
3. **macOS `launchctl` 真实加载行为**未实测（未触碰真实 `~/Library/LaunchAgents`）。
4. **Windows 特定语义**（进程组、detached、NSIS）未在本机验证。
5. **线上服务器侧的发布/收割流程与 nginx 配置不在任何仓库内**，无法从代码确证。

---

## 六、验证方式

修复后执行（全部通过）：

```bash
npm install                                   # devDependencies（运行时仍零依赖）
npm run typecheck                             # tsc --checkJs 全量：0 错误
node scripts/strict-ratchet.mjs               # strict 棘轮：0 / 0
node test/run-all.mjs                         # 6 套：smoke / e2e-local / e2e-web / e2e-schedule / api-contracts / bench
npm run bench                                 # 214 断言（省钱基准：综合 51%，v0.4.6 口径自纠后）
```

新增回归断言覆盖：写后再读不吃旧缓存、子代理 token 并入父回合、日志低水位轮转 + 收权、限流不可被查询串绕过、随包资源目录齐全 + 桌面版本一致、冲突备份可见性 + 会话列表排除、`git` 工具真实语义（含退出码透传）、IPv4-mapped IPv6 SSRF 拦截、无价模型 Batch 费用为 null、URL 凭据脱敏、`undo` 越界报错、hook `|` matcher、预设对象形态提权拦截、`SSH_AUTH_SOCK` 保留、深嵌套 schema 不崩、`grep` ReDoS 拦截、时区感知日界/避峰、峰谷锚定请求发起时刻、输出上限封顶、自启绝对路径。

**测试本身的两处「编码缺陷行为」也一并修正**：smoke 曾断言 `git status` 在非 git 目录**成功**（只有 `await execFile` 的坏实现才成立），以及 tokenizer 断言锁定旧口径——两者都会让回归测试反过来保护 bug。
