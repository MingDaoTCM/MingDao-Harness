# MingDao Harness v0.6.41 发布说明

> 状态：**已发布**（tag `v0.6.41`）
> 主题：**§1.1 切片 B1：SSE 帧号 / 事件游标 / 跳号整窗重取**（+ 开发效率工具）
> 范围：`v0.6.40..HEAD` 的 6 个提交——`25b28cc`（服务端帧号与事件游标）、`1a1b4aa`（客户端跳号重取）、
> `4d04457`（变异预检/分片）、`200f8d5` + `bae88a7`（路线图拆分）、`f6c6c18`（CI 接线）。
> 影响面：Web 传输层新增 **`streamSeq`** 与 `GET /api/events`；前端在跳号时**整窗重取快照**。
> 既有 `seq`（工具卡片配对号）**一个字节都没动**；无破坏性 API / 账本 / 数据格式 / 配置变化，
> 不改变对话、工具、权限、账本的既有行为。

---

## 〇、先读：两套编号域，绝不互相推导

这是本版**最容易写错的一行代码**：`streamSeq = lastEventSeq`。两者作用域不同，混用会直接让
同一会话的**第二轮首帧**（`streamSeq=1`）被当成"旧帧"而整轮不渲染。

| 游标 | 字段 / 端点 | 作用域 | 用途 |
| --- | --- | --- | --- |
| **流游标** | SSE 帧上的 `streamSeq` + `id:` 行 | **每个 task** 从 1 单调 +1 | 客户端判断"**这一轮流**有没有丢帧"；跳号 → 整窗重取 |
| **事件游标** | `GET /api/events?after=`、`/api/session.lastEventSeq` | **每个会话**跨轮单调 | 事件日志的游标；B2 的事件派生/重放 |
| **工具配对号（既有）** | 帧上原有的 `seq` | 一次工具调用内 | `toolStart` ↔ `tool` 的卡片配对（e2e 有断言） |

三条硬规则：

1. **`streamSeq` 不从 `lastEventSeq` 初始化**——每轮 `send()` 从 0 起算，首帧必须是 1；
2. **既有 `seq` 不复用、不覆盖**——新字段另起名，工具卡片行为与 0.6.40 完全一致；
3. **`after` 只收事件 seq**——不要拿 `streamSeq` 去调 `/api/events`，反过来也一样。

---

## 一、用户可见

### 1.1 SSE 断流 / 丢帧时自动重新同步（不再静默错位）

**场景**：网络抖动、代理截断、页面切后台导致 SSE 少了一帧——以前界面会**停在少了几段正文/
几个工具结果的错误状态**，而且没有任何提示（刷新后才恢复）。

v0.6.41 起：

- 每一帧都带 `streamSeq`；客户端发现**跳号**（收到 3 却没收到 2）就**暂停逐帧渲染**，
  不再把缺口当连续；
- 有会话文件时自动**整窗重取快照**（复用「加载会话」，最终状态以快照为准），成功后从
  触发跳号的那一帧继续；期间到达的帧先暂存，快照返回后按 `streamSeq` 去重放行；
- 成功重取后在对话流里留一条低调提示：`已跳过 N 条事件，正在重新同步…`；
- 连续两次补不回来就停手（避免每帧打网络），后续帧仍继续渲染——**错误可见，但不冻结界面**。

### 1.2 重取失败有明确提示

- 快照请求失败 → 对话流里出现 `⚠ 事件流中断且重取失败，请刷新页面`；
- 新会话首轮（服务端还没落盘、没有可重取的会话文件）→ 只提示、不重建空窗口，后续帧照常渲染。

**绝不静默丢弃**：这是本版对用户唯一的体验承诺。

### 1.3 其余无可见变化

- 帧上新增的 `streamSeq` / `id:` 行对页面渲染没有影响；既有 `seq`、工具卡片、权限确认、
  排队/插话、账本、调度全部保持原样；
- 后端旧、前端新（或反之）都能工作：**无 `streamSeq` 的旧服务端照常分派**（见 §2.4）。

---

## 二、开发者可见

### 2.1 服务端：每帧 `streamSeq` + 标准 `id:` 行（`25b28cc`）

`src/web/server.js` 新增 `createSseWriter(res, taskId)`：

```js
// 每个 chat 请求（task）新建一个闭包计数器
let streamSeq = 0;
res.write(`id: ${streamSeq += 1}\ndata: ${JSON.stringify({ ...obj, taskId, streamSeq })}\n\n`);
```

- **作用域必须是 task**：全局/会话级计数器会让并发任务互相占号，两个都正常的流各自看到"跳号"，
  检测直接失效（`test/event-cursor.js` 用并发两个 task 钉住这一点）；
- **心跳 `progress` 同走该函数**——它也是状态更新，跳号检测不能漏它；
- **既有 `seq` 不动**：`toolStart` / `tool` / `toolDenied` 上的 `seq` 仍是工具卡片配对号，
  `toolStart.seq === tool.seq` 的 e2e 断言保持成立；
- 写 `id:` 行是为将来的 `Last-Event-ID` 续订留标准位；**B1 不消费它**（见 §四）。

### 2.2 `GET /api/events?file=&after=`：事件游标（`25b28cc`）

```http
GET /api/events?file=<会话文件名>&after=<事件 seq>
```

| 状态码 | 条件 | 返回 |
| --- | --- | --- |
| **200** | 正常 | `{ok:true, file, seqKind:'event', lastSeq, events:[…]}`；只含 `seq > after` |
| **200** | 会话存在、但事件文件不存在（旧会话 / `eventLog=false`） | `{ok:true, lastSeq:0, events:[], seqKind:'event'}` —— **空窗口，不是 404** |
| **400** | 缺 `file` / `file` 含 `/` `\` 或为 `.` `..` | `{error:'…'}`（只接受 basename，防目录穿越） |
| **400** | `after` 非数字 / 负数 / 非安全整数 | `{error:'after 必须是非负整数'}`（**严格**，不把垃圾解析成 0） |
| **404** | 会话 `.jsonl` 不存在 | `{error:'会话不存在'}` |
| **500** | 事件日志存在但读不了（损坏） | `{error:'读取事件日志失败：…'}` |

语义细节：

- `after` **缺省 = 0**（返回全部）；过滤是**严格大于**——客户端持有的 `after` 那帧已经收到过，
  重复下发会让跳号检测把重帧误判成跳号；
- `lastSeq` 是**整条日志**的最大 seq（不是过滤后的最后一条），客户端拿它判断是否追平；
- 事件文件不存在是**正常形态**：事件日志是旁路，缺它不代表会话不可读；
- torn 行 / 未知 type / 缺 seq 的行照旧跳过并计入 `skipped`（可见，不静默丢）；
- `seqKind:'event'` 是机器可读声明：`lastSeq` / `events[].seq` 是**事件日志**编号，不是 `streamSeq`。

`GET /api/session` **只增** `lastEventSeq`（该会话事件日志最大 seq；无日志为 0），既有字段不变。

### 2.3 前端：`seqContinuity` / `resyncPlan` / `seqBanner`（`1a1b4aa`）

三个纯函数都在 `src/web/viewmodel.js`（`test/viewmodel.js` +51 条、`test/seq-gap.js` 44 项）：

| 函数 | 判定 / 返回值 |
| --- | --- |
| `seqContinuity({lastSeq,incomingSeq})` | `null`/非整数 → `ignore`；首帧必须 1；`last+1` → `accept`；重复/乱序 → `ignore`；跳号 → `resync` + `gap` |
| `resyncPlan({gap,hasSession,hasTask})` | **只有两态**：有会话 → `snapshot`；无会话 → `none`。**没有 `events` 态**（投影属 B2） |
| `seqBanner({gap})` | `gap>0` → `已跳过 N 条事件，正在重新同步…`；`gap<=0` → `''` |

接线约定（`src/web/app.js`）：

- 每轮 `send()` 把 `streamSeq` 归 0；**每帧先过连续性闸门，再走业务分派**；
- 重复/乱序帧**只跳过这一帧**，不影响窗口；
- 跳号 → `beginResync(gap, atSeq)`：暂停渲染 → 按 `resyncPlan` 取快照 → 成功则插 `seqBanner`、
  把游标推进到 `atSeq`、按 `streamSeq` 去重重放暂存帧；失败则插可见错误并推进游标继续；
- 重取复用唯一实现 `loadSession`；它改为**先取快照、成功后再清窗**，失败时当前窗口原样保留；
- `lastEventSeq` 在客户端**不参与流游标**（只随快照返回，留给 B2）。

### 2.4 旧服务端兼容策略

**服务端旧、前端新**：帧上没有 `streamSeq` → `seqContinuity` 返回 `ignore`，而 `app.js` 的
`ignore` 分支**只在 `ev.streamSeq != null` 时跳过该帧**；`streamSeq` 缺失时业务分派照常执行。
所以旧服务端 + 新前端 = 0.6.40 的体验，不会整轮不渲染。

**服务端新、前端旧**：旧前端忽略新字段与 `id:` 行，按原逻辑消费 `data:`——新增字段是纯增量。

### 2.5 三个开发效率工具（`4d04457`）

| 场景 | 命令 | 行为 / 实测 |
| --- | --- | --- |
| **提交前**（结构预检） | `npm run preflight` | **0.03 秒**：每批必须有 `M.report()` + `process.exit(…)`、必须有 `M.mutate({...})`、`src/**` 无变异残留、总数与 README 一致。`test/preflight.js` **6 项**验证"坏批次真的会被抓到" |
| **日常迭代** | `npm run mutate:changed` | 只跑"锚点落在 `HEAD~1` 改动文件上"的批次（约 1–6 分钟 / 6–17 批）；改到 `test/**` 自动退回全量 |
| **发版前（推荐）** | `npm run mutate:shard` | 4 片 **LPT 分桶**并行；每片独立 `git worktree`（检出 **HEAD**）+ 独立 `MINGDAO_MUTATE_LOCK_DIR` + 独立 `TMPDIR`；**全量 72 批 / 785 条**由约 25 分钟压到 **7 分钟级** |

注意：`mutate:shard` 跑的是**已提交**代码（worktree 检出 HEAD），所以发版门禁必须在**发布提交**上跑；
要跑未提交改动用 `SHARD_ALLOW_DIRTY=1`（`git diff` 打补丁到各片）。

---

## 三、测试与接线

- 新套件：`test/event-cursor.js` **18 项**（纯函数 + mock Provider + 真实 HTTP/SSE + `/api/events` 状态码）、
  `test/seq-gap.js` **44 项**（判定表 + 两态救援 + 同序分派模型 + `app.js` 接线约定）；
- 新变异：`batch83-event-cursor` **9 条**、`batch84-seq-gap` **8 条**；总数 768 → **785**；
- `test/run-all.mjs` → **42 套**；CI 新增 **3 个独立步骤**：`preflight` 自检、`event-cursor`、`seq-gap`
  （Linux/Windows，非 macOS，与既有套件一致）；
- 文档：`docs/ROADMAP-v0.7.md` 把 §1.1 拆成 A/B1/B2 并写明两套编号域；`docs/ARCHITECTURE.md` 同步双游标。

---

## 四、门禁（发布树）

在**发布提交**（`f6c6c18` + 文档/版本提交；`git diff f6c6c18..v0.6.41 -- src test` = 0）上逐项运行：

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | 0 错误（exit 0） |
| `npm run typecheck:strict` | 当前 0 条 / 基线 0 条（exit 0） |
| `npm run preflight` | ✓ 预检通过（批次结构 / 变异残留 / 计数一致），exit 0 |
| `node test/smoke.js`（单独 + 私有 `TMPDIR`） | 全通过，两次均 exit 0（含私有 `TMPDIR`） |
| `node test/run-all.mjs` | **42/42 套通过，0 失败**（7 分 23 秒） |
| 变异全量（`npm run mutate:shard`，4 片） | **4/4 片全中；72 批 / 785 条，0 逃逸**（7 分 58 秒） |
| `npm run coverage` | 只报告，exit 0；code-lines **68.5%**（19042/27800）、all-lines 49.1%、functions 68%——低于 72.5% 基线，**仅报告不判失败** |
| `node scripts/doc-lint.mjs` | 全绿（10 项检查，exit 0） |
| `node src/cli.js diagnose` | exit 0（密钥/token/私网路径已脱敏） |

发布前工作树干净、三平台 main 已对齐；tag `v0.6.41` 指向发布提交。

---

## 五、未做 / 已知边界

- **B2 未做**：UI/账本改为从事件派生（投影）、`session-format-*` 迁移用例，仍留 v0.7.0。
  本版 `/api/events` 只是**只读游标端点**，客户端还没有消费它做事件重放。
- **`Last-Event-ID` 只写 `id:` 行，未做补尾页**：断线重连仍靠 `resyncPlan` 的整窗快照，
  不是按事件游标续传。服务端不读取 `Last-Event-ID` 请求头。
- **`.sig` 站点发布（阶段二）仍未开**：`/updates/latest.yml.sig` 必须保持 **404**；
  签名只进 GitHub Release（存量客户端只有旧公钥，放上去会让它们永久拒绝更新）。
- **Windows Authenticode 未接入**：与更新来源签名是两件事，SmartScreen 提示不变。
- **0.6.40 的跨进程自愈边界仍未处理**：两个进程同时修复同一会话时可能各写一份 closers
  （只追加、带 `synthetic:true`，不影响正确性）。
- 跳号救援**只有快照一种**：本轮已丢的增量不会补回，最终状态以快照为准；`none` 情形只提示。
- `resyncPlan` 目前不依赖 `hasTask`（为 B2 预留）；B1 的判断只用 `hasSession`。
