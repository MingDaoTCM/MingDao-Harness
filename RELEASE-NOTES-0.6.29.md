# MingDao Harness v0.6.29 发布说明

> 状态：**已发布**（tag `v0.6.29`）
> 主题：**v0.6.28 审计修复——4 高危 + 13 中低危 + 测试隔离**
> 来源：`MingDao-Harness-v0.6.28-代码审计报告.md`（第三方，H-01～H-04）与
> `MingDao-Harness-v0.6.28-minimax代码审计报告.md`（M/L 项）。
> 细节登记：`docs/internal/AUDIT-v0.6.1-第三方报告登记.md` §3.97 / §3.98 / §3.99 / §4.1 / §4.2。

---

## ⚠ 一、升级须知（先读，两个行为变更）

### 1. `M-14`：同步服务默认值改为安全侧（**对外部署必须显式配置**）

| 变量 | v0.6.28 及以前 | **v0.6.29** |
| --- | --- | --- |
| `SYNC_HOST` | `0.0.0.0`（所有网卡） | **`127.0.0.1`（仅本机）** |
| `MINGDAO_SYNC_REGISTRATION` | `open`（任何人可注册） | **`closed`（默认拒绝注册）** |

- **之前靠默认 `0.0.0.0` 对外提供服务的部署**：升级后只会监听本机。请显式设置
  `SYNC_HOST=0.0.0.0`，并配置 `SYNC_CERT` / `SYNC_KEY`（TLS）。否则远端客户端会连不上——
  这不是故障，是新的安全默认。
- **注册**：已有账号**完全不受影响**（配对、同步、改密、拉取/推送都不变）。要接纳新用户，显式设置
  `MINGDAO_SYNC_REGISTRATION=invite` + `MINGDAO_SYNC_INVITE_CODES=码1,码2`（推荐）或 `open`
  （不推荐）。**本机自建/首启**在「未显式配置 + 只监听回环 + 来源是回环」时仍允许自助注册，
  不需要改任何环境变量。
- 显式写 `MINGDAO_SYNC_REGISTRATION=closed` 时，连回环来源也拒绝（严格按配置执行）。
- 启动日志会打印：监听地址、注册策略、以及上面这段迁移命令。

### 2. `L-9`：HTTP 返回的密钥掩码改为**只回末 4 位**

- `/api/models-config` 等 HTTP 出口的 `keyMasked` 由「前 6 位…后 4 位」改为固定形态 `…末4位`
  （≤8 位密钥回 `******`）；**浏览器侧不再拿到密钥前 6 位**。
- **若你有脚本/面板在解析 HTTP 响应里的前 6 位前缀，需要调整**（改为只按末 4 位比对）。
- 本机 CLI（`mingdao key list` 等）**保留**「前 6…后 4」，终端辨认能力不变（受既有
  `test/smoke.js:958` 约束，已登记）。两者口径不同是有意的：HTTP 出口面向浏览器/日志，
  CLI 面向操作者本人。

---

## 二、高危修复（4 条，全部关闭）

### H-01　Web 单个畸形 `request-target` 可让进程退出

**问题**：`new URL(String(req.url || '/'), 'http://localhost')` 在 `dispatch(req, res).catch(...)`
**之外**同步执行。Node HTTP 解析器接受 `GET http://[::1 HTTP/1.1` 后，应用层 `new URL` 抛
`TypeError: Invalid URL`，整个 WebUI 进程退出——未认证的单请求即可中断所有会话与后台任务。

**修复**：新增纯函数 `parseRequestTarget(raw)` 作为唯一解析点，只接受 **origin-form**：
拒绝空目标、控制字符、协议相对 `//`、反斜杠（WHATWG 会把 `\` 当 `/`，`/\evil.com` 会被解析成
另一个主机）、绝对形式 URI、超长（>8192B）与 URL 解析异常（非法 IPv6 / 非法端口）。HTTP 回调
整体进同步 `try/catch`：解析失败 → **400 + `Connection: close`**，在认证与域分发之前结束；
解析之后的其它同步异常 → 未发头 500 / 已发头 `res.end()` / 仍失败 `res.destroy()`。
**没有**用 `process.on('uncaughtException')` 兜底（那会掩盖真实缺陷）。

### H-02　同步服务把损坏 JSON 当空库，写操作会覆盖原数据

**问题**：`readJson` 对「文件不存在 / 权限错误 / 读取失败 / JSON 解析失败」一律返回空对象，
调用方无法区分「首次运行」与「数据库损坏」。一次磁盘损坏或半截人工编辑，会在下一次注册/配对/
推送/分享时被永久覆盖。

**修复**：严格读取——**仅 `ENOENT`** 允许初始化；读取失败、空文件、解析失败、顶层不是对象、
字段类型不符一律 `StateCorruptError`。users / devices / meta / shares / accepted 各有最小 schema
（含 `credentialVersion` 非负整数、拒绝 `__proto__`/`constructor` 等危险键），**写前再校验一次**。
损坏时统一回 **500 + `code:"STATE_CORRUPT"` + 文件名 + 备份名**；备份为
`<file>.corrupt-<时间戳>[-n]`，用**复制**而非 rename——**原文件字节一个不动**，同秒重名顺延编号；
原件不可读（EACCES）时回退硬链接备份。写路径先严格读 meta/accepted/devices 再落盘，
不再出现「文件已写、元数据报 500」的半截状态。

### H-03　改密与配对 TOCTOU：旧密码可在改密后拿到新设备令牌

**问题**：配对在写锁外读取用户并等待 `scrypt`，进锁后直接新增设备；改密虽在锁内删设备，却无法
让「已开始、尚未入锁」的旧密码验证失效。知道旧密码的攻击者可在改密窗口内重新获得有效令牌。

**修复**：用户记录新增单调 `credentialVersion`（旧记录缺失视为 0，注册写 0）。`doPair` 仍在
**锁外**跑 `scrypt`（不把 CPU 等待放进临界区），**入锁后重读 users 并比对版本**，不一致 → 401
且不新增设备；`doChangePassword` 在锁内核对验证时的预期版本，不一致 → 409（并发改密只有一个
成功），成功后版本 +1 并吊销全部设备。

### H-04　改 `baseUrl` 后仍向旧端点发请求与凭据

**问题**：`setBaseUrl` 保存新地址后没有清 provider 缓存，缓存实例的 `chat` 闭包继续用创建时的
`pc.baseUrl` 与 `pc.apiKey`。实测切换后第二轮仍打到旧端点 A，A 仍收到 `Authorization: Bearer …`
（自动标题、记忆等后续请求同样泄露）。

**修复**：缓存键从「只按模型名」改为「模型 + 出网配置指纹」——**代际号 + `baseUrl` +
`apiKey` 的 sha256 摘要 + `timeout`**；新增 `invalidateProviderCache()`（代际 +1，同时清 provider
实例**与本地端点预检备忘**，避免旧端点的 TTFT/预检结果套到新端点）。`setBaseUrl`（含清空）、
Key 增删、自定义模型增删改、超时修改全部走它；创建期间配置再变化时**旧实例不写回缓存**；
已开始的旧任务持旧实例自然结束，不强杀。

---

## 三、中低危修复（13 条）

| ID | 问题 | 修法 |
| --- | --- | --- |
| `M-01` | 同步服务畸形 URL 吞错、连接悬挂 | 解析收进内层 `try` → 400 + `Connection: close`；外层 catch 不再空吞：未发头 500 / 已发头 `res.destroy()` |
| `M-02` | 账号限流绑定 IP，跨 IP 不共享 | 来源桶（IP+路由 60s/10 次）+ 账号桶（路由+规范化账号，跨 IP 共享；5 次失败后 5s 起指数退避、上限 5min、成功清零）；任一超限 429 |
| `M-03` | 聊天早期异常留假 `running` | 幂等 `finishChat()` 覆盖附件错误/会话忙/Provider 不可用/工作空间锁/落盘/建会话与主路径 `finally`；路由层 `try/catch/finally` 兜底再调它 |
| `M-08` | SSE 多行 `data:` 与坏帧静默丢弃 | 事件级解析：多行按 `\n` 拼接、空行派发；坏帧 warn 一次并计入 `badFrames`（预览先脱敏）；`[DONE]` 立即派发，其后 usage 尾帧仍捕获 |
| `M-09` | SSE 抛错不取消 reader | 读取循环 `try/finally`，成功/失败/中断一律幂等 `reader.cancel()` |
| `M-10` | `emptyRounds` 永不复位（文案「连续」实现「累计」） | 有进展即复位：成功且不重复的工具轮、非 `length` 截断的非空模型轮；失败/重复不算进展 |
| `M-11` | 会话索引分片无锁写 | 读-改-写抽 `syncShardGroup`，持 `<分片>.json.lock`（256 片可并行）；锁不可用时只在内存算、不落盘、记错误，绝不退回无锁整片写 |
| `M-12` | `AGENTS.md` 去重/删除无锁 | 四条写路径（append/dedupe/remove/write）共用 `<AGENTS.md>.lock` |
| `M-13` | 脱敏词表与子进程 env 漏常见形态 | 新增 `hf_`/`shpat_`/`dckr_pat_`/`xai-`/`gsk_`/`pplx-`/`r8_`/`npm_`/`sk_live_`/`sk_test_`/`fal_`；env 增 `SSH_PASSPHRASE`/`PGPASSWORD`/`DATABASE_URL`/`MYSQL_URL`/`POSTGRES_URL`/`REDIS_URL`/`MONGODB_URI`/`AMQP_URL`/`RABBITMQ_URL` + `*_URL` / `*_URI` / `*_DSN` 兜底 |
| `M-14` | **默认值不安全（行为变更）** | `SYNC_HOST` → `127.0.0.1`；注册 → `closed`；仅「未显式配置 + 监听回环 + 回环来源」允许本机首启注册 |
| `M-17` | `saveTaskState`（无锁）与合并写（有锁）并存 | 抽 `writeTaskStateLocked(sessionName, ts, merge)` 唯一临界区，裸写与合并写共用同一把锁 |
| `L-9` | HTTP 掩码回前 6 位 | 新增 `maskKeyTail()`，HTTP 只回末 4 位；CLI `maskKey` 保留前 6（`smoke:958` 约束，已登记） |
| `L-13` | `finish` 跨轮残留 → 正常轮误判 capped | 每个模型请求开始 `finish = null` |

---

## 四、测试隔离：并发跑 smoke 不再假红

**问题**：两个 worktree 同时跑 `node test/smoke.js` 时，§120「失败路径不得留下临时目录」断言会
报 `mingdao-skill-git-*`——那是**另一个 run 正在用**的目录；旧断言扫的是全机共享 `os.tmpdir()`。
这是测试隔离缺陷，不是产品缺陷（`src/skill-lib.js` 的清理本身正确）。

**修复（只改测试，产品零改动）**：§120 开始处建本 run 私有目录
`os.tmpdir()/mingdao-smoke-<pid>-<epoch>-<rand>`，把 `TMPDIR`（POSIX）/ `TMP`+`TEMP`（Windows）
指向它；`leftovers120()` 只扫该私有目录（保留前/后快照差集语义），段末恢复原值并删除。
新增**结构守卫**：smoke 源文件不得在全局临时目录上列目录、残留扫描必须只针对 `runTmpRoot120`、
`os.tmpdir()` 必须等于私有根——防止「改回全局扫描」这种单跑永远绿、只在并发时假红的回归。

**验证**：确定性噪声下改前必红、改后 191 项全过；并发双 worktree `A_EXIT:0` / `B_EXIT:0`；
故障注入（额外漏一个 `mingdao-skill-git-*`）断言仍红，证明守卫没有被放宽。

---

## 五、接线、变异与门禁

- **四个新套件**已接入 `test/run-all.mjs` 与 CI（仅 Linux 腿，避免 Windows 腿时长翻倍）：
  - `test/sync-hardening.js` —— **24 项**
  - `test/web-robustness.js` —— **8 项**
  - `test/provider-hardening.js` —— **5 组**
  - `test/state-integrity.js` —— **9 项**
- **新增变异批次**：`batch57-sync-hardening`（16）、`batch58-web-robustness`（10）、
  `batch59-provider-hardening`（12）、`batch60-state-integrity`（11）。
  全仓变异总数 **492 → 541**，权威全量 `node test/mutate/run.mjs` = **49/49 批、541/541 条全中**。
- **最终 HEAD 门禁**（逐项退出码见发布报告）：`typecheck` 0、`typecheck:strict` 当前 0 / 基线 0、
  `node test/smoke.js`（单独跑）全绿、`node test/run-all.mjs` 全绿、`mutate` 49/49、
  `doc-lint` 全绿、`diagnose` 正常（密钥/路径脱敏）。
- 发布提交只含版本与文档；`git diff --name-only <门禁SHA>..<tag> -- src test` → **0 行**。

---

## 六、未修 / 留待后续（如实登记）

### `M-19` 未修：pair 的用户名枚举与 push 无速率限制

- **现象**：pair 接口对「用户不存在」返回 404、对「密码错误」返回 401，可被用来枚举用户名；
  push 接口没有独立的速率限制。
- **为什么本版不修**：`src/sync.js`（客户端）**依赖 404 判断「用户不存在 → 走自动注册」**。
  服务端若把 404/401 统一成 401，会直接破坏客户端首登/自动注册流程——这不是改一行状态码，
  而是要先改**客户端自动注册协议**（例如显式 `register` 探测或带能力的握手），并保持旧客户端兼容。
  本版先做了两层缓解：账号桶限流已覆盖 pair 的失败尝试（跨 IP 共享、指数退避），
  枚举**频率**被压住；但**响应区分**仍在，故如实登记为未修。
- **后续**：与客户端自动注册协议一起改（专项任务），不在本版偷偷改状态码。

### minimax 其余 L 项与第 2/3 波

- minimax 报告中本版未涉及的其余 **L 项**（L-1～L-8、L-10～L-12、L-14～L-18：路径围栏/原子写
  fsync/账本截断/会话坏行策略/约束事件 id/调度行崩溃/socket 泄漏/文档版本漂移等）留待后续版本；
- **另有 3 条中危未纳入本版**（同样如实登记，不做「静默跳过」）：
  - `M-15`：`syncPush` 遇超限会话提前 `return`，已推送会话的状态增量被丢弃 → 下次重复全量推送
    （带宽/存储浪费，非数据损坏）；
  - `M-16`：`syncPull` 的状态增量丢掉 `localMtime`（`commitState` 是整键替换），同样导致重复推送；
  - `M-18`：压缩摘要回退路径丢失 `usage` → 该次请求已计费但费用少计（账目口径问题）。
  这三条都在 `src/sync.js` / `src/compact.js` 的同步与计量路径，改动会牵动协议/账本兼容，
  按「一次只收一类风险」的原则留到下一波，与 M-19 的客户端协议改动一起排期。
- 报告建议的**第 2 波（架构收敛：拆分超长模块等）与第 3 波（覆盖率/供应链治理）**不在本版范围。

---

## 七、已知边界（必须知道）

- **CLI 掩码仍是前 6 位**：`maskKey` 与 HTTP 的 `maskKeyTail` 口径不同（见「升级须知」§2）。
- **M-02 多来源为模拟**：本机 macOS 没有 `127.0.0.0/8` 别名（绑 `127.0.0.2` 会 `EADDRNOTAVAIL`），
  多用例用 `SYNC_TRUST_PROXY=1` + 可信 XFF 模拟多来源；**真实直连多 IP 未在本机实测**。
  不可信直连时 XFF 仍被忽略（既有语义）。
- **EACCES 备份依赖硬链接**：不支持硬链接的文件系统只能记录 `state-quarantine-failed`，
  无法留备份（但**原件仍不会被覆盖**）。
- **绝对形式 URI 一律 400**：本服务是 origin server；若将来要放在反向代理后接受绝对 URI，
  需另做「authority 与绑定地址一致」的显式放行，不能退回裸 `new URL`。
- **同步锁清单未登记**：`test/smoke.js` §109④ 的「剩余同步锁清单」是「新增即失败」的受审阅清单，
  本轮未改 smoke，M-11/M-12 的临界区以**同一原语的别名**（`withFileLockSync as lockFileSync`）
  调用（锁文件、超时、陈旧回收、可重入语义完全一致），因此不出现在该清单里；建议下一轮正式登记
  或迁到异步锁（WebUI 请求路径上的同步锁会阻塞事件循环）。
- **`docs/CONFIG.md` / `CONFIG.en.md` 的同步默认值**：本版已把注册/监听的默认值口径同步到文档；
  若你的部署脚本解析这些表格，请以 v0.6.29 的行为为准（`127.0.0.1` / `closed`）。
- **Windows 真机未逐按钮验收**：以 CI `test (windows-latest, 20)` 腿与四个桌面构建为准；
  四个新套件的 CI 步骤只在 Linux 腿执行。
