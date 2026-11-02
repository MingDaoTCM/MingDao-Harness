# MingDao Harness v0.6.30 发布说明

> 状态：**已发布**（tag `v0.6.30`）
> 主题：**二轮审计修复——4 个严重级 + N-10/N-11/N-12 + 门禁可信度**
> 来源：`MingDao-Harness-v0.6.29-修复情况核验报告.md`（C-1～C-4、N-10～N-12、H-1 等）、
> `MingDao-Harness-v0.6.29-修复验证审计报告.md`、`MingDao-Harness-v0.6.29-代码审计报告.md`
> （C-04/H-10 等）、`MingDao-Harness-v0.6.29-审计报告.md`。
> 细节登记：`docs/internal/AUDIT-v0.6.1-第三方报告登记.md`（本轮新增条目见该文件对应小节）。

---

## ⚠ 一、升级须知（先读，**六条行为变更**）

### 1. 同步服务：注册**默认 `closed` 且无条件**（本机首启也要显式开启）

| 项 | v0.6.29 | **v0.6.30** |
| --- | --- | --- |
| 默认注册策略 | `closed`，但「未显式配置 + 监听回环 + 来源是回环」时**隐式放行** | **`closed` 无条件**——不再从请求推断「本机来源」 |
| `SYNC_HOST` 默认 | `127.0.0.1`（v0.6.29 起） | 不变 |
| 本机首启自助注册 | 隐式允许 | 仅两条**显式**路径（见下） |
| `X-Forwarded-For` | `SYNC_TRUST_PROXY=1` 时取左起第一段 | **`SYNC_TRUST_PROXY_HOPS=n` 取右起第 n 跳**；未设则**完全忽略 XFF** |

- **为什么要改**：v0.6.29 的「回环即允许」可被一个伪造的 `X-Forwarded-For: 127.0.0.1` 击穿
  （核验报告 N-10）；「回环监听 + nginx 反代」形态下，外部客户端的 socket 恒为 `127.0.0.1`，
  反代等于把注册口开到公网。
- **对外部署**（必需）：`SYNC_HOST=0.0.0.0` + `SYNC_CERT` / `SYNC_KEY`（TLS），并按需设置
  `MINGDAO_SYNC_REGISTRATION=invite` + `MINGDAO_SYNC_INVITE_CODES=码1,码2`（推荐）。
- **本机自建 / 首启**（二选一）：
  1. `MINGDAO_SYNC_ALLOW_LOOPBACK_REGISTRATION=1`——**仅**对本机**直连**生效：不得配置可信反代、
     请求不得带任何转发头；
  2. **一次性引导码**——默认 `closed` 且库里还没有账号时，服务端生成
     `os.tmpdir()/mingdao-sync-bootstrap-<端口>.txt`（`0600`），本机 `mingdao sync login`
     自动读取并随注册提交；**每成功注册一次即轮换**（旧码立即失效），服务端关闭时删除该文件。
     经代理或带转发头的请求即使持有引导码也**仍被拒绝**。
- **反代部署**：必须显式声明 `SYNC_TRUST_PROXY_HOPS=<你信任的代理跳数>`（取 XFF **右起**第 n 跳，
  左起第一段客户端可自填）；不要用 `SYNC_TRUST_PROXY=1` 去「宽松放行」。
- **已有账号不受影响**：配对、同步、改密、拉取/推送全部照旧。
- 启动日志会打印：监听地址、注册策略、以及本机首启的两条引导方式。

### 2. `fetch` 在**未配置 `config.net` 时默认拒绝出网**（此前静默放行）

- **之前**：未配置 `config.net` → 出网闸门不安装 → 模型面向的 `fetch` 工具**零确认、零记录**
  即可访问任意地址（零确认外传通道，核验报告 C3）。
- **现在**：未配置 = **fail-closed，拒绝**，并给出「如何配置白名单」的可操作提示；
  已配置 `config.net` 的部署维持原语义（按 `mode` 与 `allow` 执行）。
- **需要出网的部署**：在 `config.json` 里显式加白名单（`net.mode` + `net.allow`），
  否则所有 `fetch` 都会被拒。**这一条最容易在升级后表现为「功能坏了」，其实是新的安全默认。**
- 自带网络访问的同步 / 模型调用等用户主动触发的功能**不在此列**（维持「未配置零影响」不变量）。

### 3. `git` 只读工具改为**选项白名单**（未登记选项一律拒绝，fail-closed）

- **之前**：`git` 整体视为只读工具，只靠一份**黑名单**兜底——于是 `git blame --contents`
  可读**仓库外任意文件**，`git branch <名>` / `git tag <名>` 可创建 ref 却免询问。
- **现在**：每个子命令只放行**已登记**的只读选项（`src/tools/git.js` 的
  `ALLOWED_LONG` / `ALLOWED_SHORT` / `COMMON_ALLOWED_LONG`）；`branch` / `tag` 仅允许
  「列出 ref」的形态；`stash` / `remote` / `push` 等写类子命令直接拒绝。
- **影响**：你或你的 Pack 若用到未登记的只读选项（例如某个少见的 `git log --xxx`），
  升级后会**被拒绝**。请按需在 `ALLOWED_LONG` / `ALLOWED_SHORT` 里增补，而不是退回黑名单。

### 4. 无令牌的 WebUI **不能把权限改成 `auto`**

- 未配置访问令牌（`web.token` / `--auth-token`）时，设置接口只接受 `ask` / `readonly`；
  改成 `auto` 会返回 **403 `PERMISSION_AUTO_REQUIRES_TOKEN`**。
- 原因：回环监听 + 无令牌时，**同机任意进程**都能驱动 Agent 执行命令；`auto` 等于把
  「唯一防线」交给 deny 名单（核验报告 H-11 / H-13）。
- 需要 `auto`：先配置令牌，再改权限。

### 5. 同步数据面新增配额（每账号 60 次/分 + 512MB/日）

- `SYNC_REQUESTS_PER_MIN`（默认 **60**，最小 1）：`/api/sessions/push`、`/api/sessions/pull`
  每分钟上限；超限 **429 + `ACCOUNT_RATE_LIMIT`** + `retryAfterMs`。
- `SYNC_QUOTA_MB_PER_DAY`（默认 **512** MB，`0` = 关闭）：每日字节配额；超限
  **429 + `DAILY_QUOTA_EXCEEDED`** + `usedBytes` / `limitBytes` / `resetAt`（UTC 零点重置）。
- 大库首次全量同步、或多设备频繁推送的部署，请**先调高** `SYNC_QUOTA_MB_PER_DAY`。

### 6. 其余收紧（非阻塞，但值得知道）

- **deny 归一化**：`deny` 规则现在会剥 `env` / `sudo` / `doas` / `xargs` / `command` /
  `builtin` / `exec` / `nohup` / `time` / `nice` / `timeout` / `stdbuf` / `setsid` / `watch` /
  `busybox` 前缀，递归解释 `sh -c` / `eval`，按**全名 + 基名双匹配**，并识别绝对路径。
  以前「写了 deny 却能被绕过」的规则，现在会**真的拦住**（可能让某些既有脚本开始被拒）。
- **账本键名脱敏**：`{api_key:'…'}` 这类**键名即语义**的记录，整值写 `***`（此前明文落盘）。
- **原子写补 fsync**（文件 + 目录；Windows 标 `skipped` 并显式 `chmod` 收权）：掉电语义更硬，
  I/O 略增。
- **`ARCHITECTURE.md` 模块计数 / `SECURITY.md` 支持版本** 已同步到 v0.6.30 口径。

---

## 二、四个严重级（核验报告 §3.1 的四个 PoC：从「原样复现」到「拒绝 / 正确」）

### C-1　grep 的 ReDoS 判据漏「相邻无界量词」→ 事件循环完全冻结

**问题**：`src/regex-safety.js` 只看「量词是否作用于含交替的组」，漏掉 `a*a*a*…b` 这种
**相邻无界量词**；`src/tools/fs-tools.js` 又自维护了一份**更弱**的判据，且 5 秒预算**只在文件之间**
检查。核验 PoC：`a*a*a*a*a*a*a*a*b` + 20KB 单行文件 → **45s 超时 124**（连 watchdog 定时器都不触发，
事件循环完全冻结）。pattern 来自模型输出，可被提示注入影响。

**修复**：

1. `regex-safety.js` 增加**顶层相邻无界量词**判定：相邻两个原子量词均无上界
   （`*` / `+` / `{n,}`）且首末字符集**相交**才拒绝——`(abc|abd)+` / `[a-z]+@[a-z]+` 因此不误伤。
2. 交替分支从「首字符集相交即拒」改为 **NFA 语言级判定**：分支编译成 NFA（Thompson 构造，
   带状态数与乘积预算），只拒**语言有交集**或**一支是另一支前缀**。
   `(abc|abd)+` / `.*\d+` / `\w+\s+\d+` / `[a-z]+@[a-z]+` **放行**；
   `(a|aa)+` / `(a+)+` / `a*a*` / `(\d|[\d])+` / `(a|)+` **拒绝**。
3. `fs-tools.js` **删掉第二份判据**，只复用 `patternRejectionReason`；预算**下推到行级**，
   行循环内每次 `testLine` 前后都查，超时立即停扫。

**验证**：同一 PoC **45s 超时（124）→ 0ms 被拒**；正常 grep 20KB 单行 **145ms**；
12 个恶意 pattern 全部装载时拒绝且原因可见；假时钟证明行级预算真的存在。

### C-2　safe-fetch 跨源重定向不剥凭据头 → Provider API Key 被 302 带走

**问题**：`net-guard.js` 早已实现「跨源剥 `Authorization`」，`safe-fetch.js` 却自己写了一套
「只跟不剥」；`model-discovery.js` 还传 `allowPrivate: true`，重定向目标可以是内网。
核验 PoC：302 目标收到 `Authorization: Bearer sk-VICTIM-…`。

**修复**：`net-guard.js` 抽出**唯一**的 `prepareRedirectHeaders(headers, from, to)`：
协议 / 端口 / 主机任一变化即**跨源**，`https→http` 另记**降级**；`safe-fetch` 与 `net-guard`
的重定向循环**共用同一份**判定与裁剪。`allowPrivate` **只在首跳**（及首跳同源重定向）生效；
跨源（含降级）后剥 `Authorization` / `Cookie` / `Proxy-Authorization`。

**验证**：PoC 目标 **0 命中**、`Authorization` 为 `null`；同源重定向仍保留头；
`allowPrivate` 跨源后不再豁免内网。

### C-3　SSE 兜底 `tool_call_id` 只用工具名 → 会话永久 400

**问题**：`id: c.id || \`call_${c.name}\``——同名工具并行调用（并行 read / 并行 grep）生成重复 id，
下一轮请求被网关 400；消息已落盘，**该会话之后每轮都必然 400**。

**修复**：兜底 id 改为 `call_<name>_<idx>_<ts/rand>`，并用 `usedIds` 去重（撞名继续加 `_<n>`）。

**验证**（`test/agent-context-hardening.js` D4）：两条 / 三条同名调用 id 两两不同；
显式 id 原样保留且不与兜底 id 冲突；用这些 id 拼出的请求体通过**严格网关**校验（每个 id 恰一条响应）。

### C-4　`withSessionLock` 无条件 delete → 第 4 个并发任务的互斥失效

**问题**：先结束的任务把后来者刚入队的链一起删掉 → 第 4 个任务与第 2 个**重叠执行** →
`appendMessages` 与 `rewriteSession` 并发 → **用户消息凭空消失**。

**修复**：cleanup 只在 `sessionLocks.get(file) === tail`（自己仍是尾链）时才 delete。

**验证**：四个并发任务的进入/退出区间**两两不重叠**，结束后尾链清空（无泄漏）。

---

## 三、v0.6.29 自己新引入的三条

### N-10　默认 `closed` 可被一个伪造请求头击穿

**问题**：v0.6.29 的豁免判据是「未显式配置 + 监听回环 + 来源回环」，而「来源」取自
`X-Forwarded-For` ——攻击者自带 `X-Forwarded-For: 127.0.0.1` 即可自助注册；
「回环 + 反代」形态下 socket 恒为 `127.0.0.1`，等于把注册口开到公网。

**修复**：默认 `closed` **无条件**，删除隐式豁免（见「升级须知」§1）。本机首启只保留两条**显式**路径：
`MINGDAO_SYNC_ALLOW_LOOPBACK_REGISTRATION=1`（仅直连、无代理配置、无转发头）与**一次性引导码**
（`os.tmpdir()/mingdao-sync-bootstrap-<port>.txt`，`0600`，每次注册轮换，关闭即删）。
`clientIp` 改由 `SYNC_TRUST_PROXY_HOPS=n` 取 **XFF 右起第 n 跳**；未设则**完全忽略 XFF**。

**验证**（`test/sync-registration-hardening.js` F1）：伪造 XFF → **403**；回环 + 反代形态 → **403**；
显式 `ALLOW` 且直连 → **200**；`HOPS=1` 取右起第 1 跳；未设 `TRUST_PROXY` 时轮换 XFF 12 次
仍被来源桶限流。

### N-11　新加的同步锁落在 WebUI 请求路径 → 事件循环冻结 2 秒

**问题**：v0.6.29 给会话索引/记忆加锁时用的是**同步**锁，而 `/api/sessions?q=`、`finalizeSession`、
`POST /api/memory` 都在请求路径上调用它；锁争用时整个事件循环停摆（PoC：**冻结 2008ms**，
100ms 心跳不触发）。

**修复**：新增 `syncSessionIndexAsync` / `searchSessionsAsync` / `appendMemoryAsync` /
`writeMemoryAsync` / `dedupeMemoryAsync`；上述三个 WebUI 入口改用异步版；
同步版保留给 CLI / REPL，并在注释里写明边界。

**验证**（`test/fs-integrity-hardening.js` E3）：同一 PoC 下 100ms 心跳**全程正常触发**；
异步版与同步版对同一夹具的落盘结果逐字节一致。

### N-12　迁移失败仍删唯一副本

**问题**：`migrateLegacyIndex` 逐分片调 `saveShard`，但没有把 `{ok:false}` 计入 `allOk`——
分片写失败后仍删掉旧索引，而新索引并不完整 → **唯一副本丢失**。

**修复**：`{ok:false}` 参与 `allOk`；失败即**保留旧索引**、打印可见 warn、下次自动重试。

**验证**（`test/fs-integrity-hardening.js` E2）：注入分片写失败 → 旧索引仍在、新索引不生效、
warn 可见；恢复后下一次迁移成功。

---

## 四、其余高危 / 中危（逐条）

| 项 | 问题 | 修法 | 验证 |
| --- | --- | --- | --- |
| 账本键名脱敏 | 逐「叶子值」脱敏，`{api_key:'…'}` 的键名与值被拆开 → 明文落盘 | 键名层脱敏（`api_key`/`token`/`password`/`secret`/`credential`/`authorization`/`cookie`/`private_key` 等整值 `***`） | `credential-hardening` B3 |
| 脱敏单一来源 | 脱敏词表与子进程 env 名单各一份（`PGPASSWORD` 只进了 env） | `redact.js` 导出唯一名单，`tools/bash.js` 再导出同一函数；补 `MY_CRED`、大写 `SK-` | `credential-hardening` B2（结构断言：第二份名单必须扫得出来） |
| deny 归一化 | 绝对路径 / 包装前缀 / 引号拆分全绕过 | 剥 15 个包装前缀、`sh -c`/`eval` 递归、全名 + 基名双匹配；`denyStrict` 严格档不解释脚本 | `permission-hardening` C1 |
| git 只读白名单 | `blame --contents` 读仓库外；`branch`/`tag` 建 ref 免询问 | `ALLOWED_LONG`/`ALLOWED_SHORT` 白名单 + ref 列形态判定 + 写类子命令拒绝 | `permission-hardening` C2 |
| fetch 出网 | 只读集合 + 未配置 `config.net` 时闸门不安装 | 移出只读集合；未配置 = 默认拒绝 | `permission-hardening` C3 |
| 多模态计数 | `content` 数组被 `String()` → 204KB 图文只计 13 token | 按 `parts` 计数（文本 + 图片按尺寸估算）→ 数千 token | `agent-context-hardening` D2 |
| `trimMessages` | 尾部贪心遇超预算即 break → 最新用户消息被丢 | **末条必留** + 中间二分截断并标注 | `agent-context-hardening` D3 |
| 中断孤儿 `tool_calls` | 只清最后一条 → 会话永久 400 | 按 `tool_call_id` **补齐占位**（等量、同序） | `agent-context-hardening` D1 |
| 工具消息顺序 | 拒绝项就地 push → 与 `tool_calls` 顺序不一致 | 按 `tool_calls` **原序回填** | `agent-context-hardening` D5 |
| 原子写 fsync | 只 rename 不 fsync | 文件 + 目录 `fsync`；Windows 标 `skipped` 并 `chmod` 收权 | `fs-integrity-hardening` E4 |
| 会话列表容错 | 单个 `stat` 失败清空列表 | 逐项 `try/catch`，坏条目跳过并计数 | `fs-integrity-hardening` E5 |
| 同步配额 | 数据面无限制 | 60 次/分 + 512MB/日，429 带用量 | `sync-registration-hardening` F4 |
| 无令牌禁 auto | 回环无令牌可改 `auto` | 403 `PERMISSION_AUTO_REQUIRES_TOKEN` | `sync-registration-hardening` F3 |
| Intl 性能 | 每次新建 formatter；2 万条 `costBreakdown` ~1s | formatter 缓存 + 北京日预分桶：**994ms → 17ms**、`beijingParts` **849ms → 72ms**（与旧算法逐条对拍） | `freeze-hardening` A2 |

---

## 五、门禁可信度（本轮的另一半）

- **两条时限假红**改为「**软阈值告警 + 硬上限**」：慢机器只告警，超硬上限才失败。
- **`batch57 ②` 改能力探测**：root 容器下「读失败」观测面不存在 → 旧写法**静默逃逸**；
  现在先探测能力，不具备则**如实跳过并计入跳过数**（CI 日志可见）。
- **新增 `M-17c` 确定性断言**：merge 遇持锁**必须等待**（真子进程持锁 + 时间窗），
  不靠时序运气。
- **`doc-lint ⑩` 新守卫**：`src/**` 出现 `// 变异：` 残留即 CI 红；本版据此修掉了
  `74ec0a1` 误提交的 `pendingTool: null` 变异残留。
- **接线**：`freeze-hardening` / `permission-hardening` / `credential-hardening` /
  `agent-context-hardening` / `fs-integrity-hardening` / `sync-registration-hardening`
  六个新套件接入 `run-all` 与 CI（**仅 Linux 腿**）。
- **变异总数 541 → 627**；权威全量 `node test/mutate/run.mjs` = **55/55 批、627/627 条全中**。
- **本版最终门禁**（逐项退出码见发布报告）：`typecheck` 0、`typecheck:strict` 当前 0 / 基线 0、
  `node test/smoke.js`（单独跑）全绿、`node test/run-all.mjs` **22 套全绿**、
  `mutate` 55/55、`doc-lint` 全绿、`diagnose` 正常（密钥/路径脱敏）。
- 发布提交只含版本与文档；`git diff --name-only <门禁SHA>..<tag> -- src test` → **0 行**。

---

## 六、未修 / 留待后续（如实登记）

### 1. `C-04` 未修：自更新与安装链没有可验证的来源

- **现象**：`mingdao update` 是裸 `git pull --ff-only`（无签名 / 无 tag 校验 / 无哈希）；
  `install.sh` 是 `curl | bash`（含 Gitee 镜像路径）、`git clone --depth 1` 不固定 commit。
- **为什么本版不修**：正确修法需要**先有签名基建**——发布侧生成并托管签名清单（tag 验签 /
  tarball sha256 + 公钥分发），客户端才有东西可验。只改客户端校验而没有可验证的来源，
  等于把「无法验证」换成「永远失败」，或退回「自签自验」的假安全。
- **本版的缓解**：无。这条如实登记为**未修**，与 v0.6.29 说明中的判断一致。
- **后续**：签名基建（`docs/CODE-SIGNING.md` 已有桌面侧设计）落地后，与 `update` 的
  `prevSha` 回滚点、`install.sh` 的 sha256 校验一起做。

### 2. `M-19` 未修：pair 的 404/401 用户枚举

- **现象**：pair 对「用户不存在」返回 404、对「密码错误」返回 401，可枚举用户名。
- **为什么本版不修**：`src/sync.js`（客户端）**依赖 404 判断「用户不存在 → 自动注册」**。
  服务端统一成 401 会直接破坏客户端首登/自动注册，必须先改**客户端注册协议**并兼容旧客户端。
- **本版的缓解**：账号桶限流覆盖 pair 失败尝试（跨 IP 共享、指数退避），枚举**频率**被压住；
  响应区分仍在，故登记未修。

### 3. `runTurnInner` 1,618 行未拆分

- **现象**：`createAgent` 2,075 行，内层 `runTurnInner` **1,618 行、11 层嵌套、55 个闭包状态、
  11 处手写返回对象**；本轮 C-01/C-02/C-03/D1–D5 多数落在这片区域。
- **为什么本版不拆**：拆分是纯重构，需要独立回归窗口（一版只收一类风险）。本版已在
  「有明确缺陷」的点上逐条修，但不做结构手术。
- **后续**：按报告方案拆成 `contextBudget` / `toolBatch` / `turnState` 三块，每块 ≤300 行，
  55 个闭包变量收进显式 `turnState` 对象——列入 v0.6.31 工程债。

### 4. minimax 其余低危（未修）

- `L-1` 端口 3820 硬编码 7 处、`L-3` `generatePlan` 17 行逐字符复制、`L-4` 只读工具集合多处手写副本、
  `L-5` 路径围栏 5 套独立实现、`L-6` 首帧超时默认值 3 处镜像、`L-8` `tryAcquire` 写锁内容失败
  会泄漏锁文件、`L-16`～`L-18`；
- 这些属**结构性债务**（复制 / 硬编码 / 单一来源），不构成本版已修的缺陷面；
  本版只顺带把与安全直接相关的 `L-7`（原子写 fsync）修掉，其余列入 v0.6.31 工程债。

---

## 七、已知边界（必须知道）

- **`X-Forwarded-For` 的多来源为模拟**：本机 macOS 没有 `127.0.0.0/8` 别名（绑 `127.0.0.2` 会
  `EADDRNOTAVAIL`），多来源用例用 `SYNC_TRUST_PROXY_HOPS=1` + 可信 XFF 模拟；
  **真实直连多 IP 未在本机实测**。
- **引导码只对本机直连生效**：经代理或带任何转发头的请求即使持有引导码也会 403（这是设计，
  不是缺陷）；反代部署请用 `invite` 或 `open`（不推荐）。
- **`bat` / 脚本类命令的 deny 归一化**：`sh -c` / `eval` 递归解释到有限深度；刻意构造的
  多重嵌套（归一化深度上限 5）仍可能绕过，属**尽力而为**的加严（`auto` 档下不应依赖 deny 作为唯一防线）。
- **NFA 判定有预算上限**：超大交替（状态数 >1024 或乘积 >200000）会**保守拒绝**
  （fail-closed，可能误伤极复杂的正常 pattern）。
- **Windows 原子写没有目录 fsync**：`dirFsync: 'skipped'`（平台无对应语义），文件 fsync 与
  显式 `chmod` 仍生效。
- **六个新套件的 CI 步骤只在 Linux 腿**：Windows 腿不跑（避免时长翻倍与平台假红）；
  Windows 上的行为以 `smoke` / `run-all` 的既有套件与桌面构建为准。
- **`test/freeze-hardening.js` 头部注释误写「v0.6.31」**：纯注释笔误（非断言、非行为），
  因发布提交不触碰 `src/` / `test/` 而**未在本版修正**，留待下一版随手改。
