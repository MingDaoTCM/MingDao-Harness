# MingDao Harness v0.6.42 发布说明

> 状态：**已发布**（tag `v0.6.42`）
> 主题：**§1.1 B2-a：事件日志完整记录消息 + 双读对拍**
> 范围：`v0.6.41..HEAD` 的 3 个提交——`708036b`（`messages.replace` 双写 + `event-parity` 工具）、
> `952eb48`（CI 接线 + 路线图拆分）、`b55f13d`（变异计数文档对齐）。
> 影响面：**新增一个事件类型** `messages.replace`；`rewriteSession()` 在会话写盘成功后追加它；
> 读取路径（`loadSession`）、UI、SSE、账本、配置**均未改变**。
> **用户可见：无可见变化**——这是为 v0.7.0「事件日志成为真源」补地基的内部改动。

---

## 〇、先读：本版解决的是「历史重建不出来」，不是重放算错

B2 的目标是把「谁是真源」从消息数组换成事件日志。切之前发现一个**覆盖漏洞**：

- `appendMessages()` 一直有 `message.append` 双写；
- 但 `rewriteSession()`（手动 `/compact`、`/clear`、CLI/worker 全量重写等）**一个事件都不写**；
- 自动压缩路径**另有一条** agent 侧 `compact` 事件（携带压缩后的基线），所以它此前尚可重放；
  缺口在**其余整份重写**：手动 `/compact`、`/clear`、CLI 全量重写只改消息文件。

于是这些重写之后，事件流里只有旧基线，**新窗口只存在于 `.jsonl`**——不是
`replayToMessages()` 算错，而是事件流里根本没记。更糟的是它**静默**：读取路径不读事件，
所以日常使用完全看不出问题，只有对拍时才暴露。

本版把这条写盘路径补齐，并留下一个**可持续检查**的对拍工具与硬门槛。

---

## 一、用户可见

### 1.1 无可见变化

- 对话、工具卡片、权限确认、排队/插话、账本、调度、SSE 帧、WebUI 全部保持 v0.6.41 的行为；
- 事件日志是**旁路**：`loadSession()` 不读它，UI 不渲染它，它不参与云同步；
- 新增的事件写入发生在会话文件**已经写盘成功之后**，不改变会话内容、顺序与返回值；
- `eventLog=false` / `MINGDAO_EVENT_LOG=0` 的用户完全不受影响（整条路径跳过）；
- 唯一可观察的差异在磁盘上：`<session>.events.ndjson` 会多出 `messages.replace` 行
  （append-only，单条可能较大，因为要记整份窗口）。

### 1.2 为什么值得做（用户不直接感知）

压缩/resume 之后的会话**从此可以从事件流完整重建**——这是 v0.7.0 B2-b 切真源的前提。
没有它，切换那天所有被压缩过的历史会话都会静默变形（少消息、标题/工具卡片错位）。

---

## 二、开发者可见

### 2.1 新增事件 `messages.replace`（`EVENT_TYPES` 12 → 13）

```jsonc
{
  "seq": 42,
  "time": "2026-11-08T03:00:00.000Z",
  "type": "messages.replace",
  "data": {
    "messages": [ /* 整份新基线，与 .jsonl 写盘内容逐条一致 */ ],
    "reason": "compact"   // compact | resume | rewrite
  }
}
```

语义：

- **整体替换**当前派生窗口为 `data.messages`；后续 `message.append` 按 seq 顺序接在它后面；
- **append-only**：不删、不改任何历史行（事件日志的既有约束不变）；
- `reason` 是**有限集合**：`compact` / `resume` / `rewrite`；缺省、空串、非法值一律归一化为
  `rewrite`（事件里的 reason 永远不会是任意字符串）；
- 重放：`replayToMessages()` 把 `messages.replace` 与既有 `compact` 当**同义**的「替换基线」，
  按 seq 顺序生效——replace 之前的 append 被覆盖，之后的接上；
- 兼容：读侧对未知 type 一律跳过并计入 `skipped`（既有策略），因此
  **旧版本读者遇到 `messages.replace` 只当它不存在**，不会读坏日志；反过来，
  **旧日志（没有该类型）在新版本照常可读**，语义退化为只有 `compact` + `message.append`。

谁写它：

| 写盘路径 | 是否写 `messages.replace` | reason |
| --- | --- | --- |
| 自动压缩（CLI / REPL / worker / WebUI 内的 `onCompact`） | 是 | `compact`（CLI/REPL/worker 显式传；WebUI 走默认 `rewrite`） |
| 手动 `/compact` | 是 | `compact` |
| `/clear` | 是 | `rewrite`（缺省） |
| CLI 全量重写 / 其它 `rewriteSession()` 调用 | 是 | `rewrite`（缺省） |
| `appendMessages()` 增量追加 | 否（仍是 `message.append`） | — |
| `eventLog=false` / `MINGDAO_EVENT_LOG=0` | **完全不写** | — |

> `resume` 已在 `rewriteSession(file, messages, 'resume')` 中支持并有用例覆盖，但生产侧目前没有
> 调用点显式传它——本版不新增 resume 写盘路径，只把语义位留好。

### 2.2 `rewriteSession()` 双写与容错

```js
export function rewriteSession(file, messages, reason = 'rewrite') {
  // ① 会话文件先原子写（写失败直接抛，事件一个都不写）
  atomicWriteFileSync(file, lines + (lines ? '\n' : ''), { mode: 0o600 });
  // ② 写盘成功之后才追加 messages.replace
  doubleWriteReplaceEvents(file, messages, reason);
}
```

四条纪律：

1. **顺序不可交换**：先会话、后事件。反过来的话，会话写失败会留下「事件侧车已前进、消息文件没动」
   的分叉，且不可恢复（`batch85` 第 ⑨ 条变异专门钉这个顺序）。
2. **侧车缺失时先补 `session.start`**：与 `appendMessages()` 同口径，保证事件流有头部。
3. **事件失败只 warn**：`appendEvent()` 返回 `{ok:false}`（锁超时/校验失败）或抛异常（EACCES/EISDIR）
   都只走 `warnEventFailure()`，**不抛、不回滚、不改变 rewrite 的返回值**。会话已经落盘，
   旁路的完整性不能反过来决定会话是否成功。测试用 EACCES/EISDIR 注入实测（`event-completeness` ⑫）。
4. **回滚开关**：`eventLogEnabled()` 为假时整条路径跳过（`event-completeness` ⑪）。

### 2.3 修「单条事件 > 64KB 写后校验误判失败」

`appendEvent()` 写后校验原来只读尾部 `TAIL_BYTES = 64 * 1024` 并取最后一行：

- `messages.replace` 要记**整份窗口**，很容易超过 64KB；
- 尾窗从文件中间开始，会把最后一行截断 → `JSON.parse` 必然失败 → 被误判成「事件写入后校验失败」，
  于是大事件永远写不进去（且只 warn，静默丢失）。

现在：首次校验失败且 **`size > TAIL_BYTES`（尾窗确实没覆盖整个文件）** 时，回退读整文件重验最后
一行。小事件路径不变；大事件代价与事件大小同阶（本来就刚写过同样大小的内容）。
`event-completeness` ⑬ 用 200KB 消息钉住「不截断、与写盘一致」。

### 2.4 `scripts/event-parity.mjs`：双读对拍，三分类

```bash
node scripts/event-parity.mjs                    # 扫当前 MINGDAO_HOME/sessions
node scripts/event-parity.mjs --home <dir>       # 指定 home
node scripts/event-parity.mjs --limit 50 --verbose
```

对每个会话，比较「消息数组（旧真源）」与「事件重放（候选真源）」：

- 只比较**语义字段**：`role` / `content` / `tool_calls`（按 id 排序）/ `tool_call_id`；
- 不比较 `_` 开头的运行时注记（`_endedAt` 等不落盘）；
- 逐条比较，报第一个不同的下标与原因。

| 分类 | 判据 | 是否失败 |
| --- | --- | --- |
| **`pass`** | 逐条等价 | 否 |
| **`fail`** | 不一致，且整条日志里**有** `messages.replace` | **是（exit 1）** |
| **`incomplete`** | 不一致，且整条日志里**没有** `messages.replace`（日志写于本版之前，历史不可回溯） | 否 |
| **`skip`** | 没有事件侧车（旧会话 / `eventLog=false`） | 否 |

退出码：`0` = 无 fail；`1` = 有 fail；`2` = 用法/环境错误。

`incomplete` 是**历史噪声**，不是重放回归：本版之前 `rewriteSession()` 不写事件，压缩/重写后的
窗口本来就无法从事件流恢复。把它单列，避免把「旧会话本来就没记录」误报成「重放坏了」，
也避免为了刷绿去删用户的历史会话。

### 2.5 硬门槛（写进 `docs/ROADMAP-v0.7.md`）

> **B2-b 开始前，`node scripts/event-parity.mjs` 在真实会话上必须 fail = 0。**
> `incomplete` 只表示旧日志不可回溯，不算失败。

本机真实会话（`~/.mingdao`，75 个会话）本版实测：**pass 1 / incomplete 3 / fail 0 / skip 71**，exit 0。
这正是「可以开始 B2-b」的证据；反过来，只要真实会话出现 fail，就**不允许**开始切真源。

---

## 三、测试、CI 与文档

- 新套件 `test/event-completeness.js` **17 项**：
  ① 类型清单含 `messages.replace`（13 类）；② rewrite 后出现事件且 `data.messages` 与写盘一致；
  ③ 只追加、既有事件行与 seq 不变；④ reason 区分三种值、缺省/非法回退 `rewrite`；
  ⑤–⑧ 混合序列（压缩 / resume / 空会话 / `tool_calls`）与 `loadSession` deepEqual；
  ⑨–⑩ append↔replace 顺序语义；⑪ `eventLog=false` 不写侧车；⑫ EACCES/EISDIR 只 warn；
  ⑬ 200KB 大消息不截断；⑭ 旧日志仍可读；⑮ 未知 type 跳过；⑯ 会话写盘失败时零事件；
  ⑰ `replayToMessages` 纯函数（不改入参）。
- 新变异 `batch85-completeness` **9 条**：rewrite 不写事件 / 不带 messages / replay 忽略新类型 /
  事件失败拖垮 rewrite / `eventLog=false` 仍写 / reason 丢失 / replace 当作追加 / 大消息截断 /
  先写事件后写会话。变异总数 **785 → 794**（73 批）。
- `test/run-all.mjs` → **43 套**；CI 新增独立步骤 `event-completeness`（Linux/Windows，macOS 跳过，
  与既有套件一致），失败时把断言原文做成 `::error` 注解。
- 文档：`docs/ROADMAP-v0.7.md` 把 B2 拆成 **B2-a（0.6.42）/ B2-b（0.7.0）** 并写入上述硬门槛；
  `docs/ARCHITECTURE.md` / `docs/CONFIG.md` 同步 13 类事件、双写顺序、容错与回滚语义。

---

## 四、门禁（发布树）

在**发布提交**上逐项运行（`git diff 952eb48..v0.6.42 -- src test` = **0 字节**，即门禁树与
tag 树的 `src/` `test/` 完全一致）：

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | 0 错误（exit 0） |
| `npm run typecheck:strict` | 当前 0 条 / 基线 0 条（exit 0） |
| `npm run preflight` | ✓ 预检通过（批次结构 / 变异残留 / 计数一致），exit 0 |
| `node test/smoke.js`（单独 + 私有 `TMPDIR`） | 两次均全通过，exit 0 |
| `node test/run-all.mjs` | **43/43 套通过，0 失败**（**5 分 54 秒**） |
| `npm run mutate:shard`（4 片全量） | **4/4 片全中；73 批 / 794 条，0 逃逸**（**8 分 00.87 秒**；分片 191+198+207+198 条） |
| `node scripts/event-parity.mjs --home ~/.mingdao` | pass 1 / incomplete 3 / fail 0，exit 0 |
| `npm run coverage` | 只报告，exit 0；code-lines **68.6%**（19097/27836）、all-lines 49.2%、functions 68.2%——低于 72.5% 基线，**仅报告不判失败** |
| `node scripts/doc-lint.mjs` | 全绿（10 项检查，exit 0） |
| `node src/cli.js diagnose` | exit 0（密钥/token/私网路径已脱敏） |

发布前工作树干净、三平台 main 已对齐；tag `v0.6.42` 指向发布提交。

---

## 五、未做 / 已知边界

- **B2-b 未做**：UI/账本改为从事件派生（投影）、真源切换，仍留 v0.7.0。本版只补齐事件覆盖，
  **没有**任何读取路径改读事件日志。
- **`session-format-*` 迁移用例未做**：仍留 v0.7.0。
- **`.sig` 站点发布（阶段二）仍未开**：`/updates/latest.yml.sig` 必须保持 **404**；
  签名只进 GitHub Release（存量客户端只有旧公钥，放上去会让它们永久拒绝更新）。
- **Windows Authenticode 未接入**：与更新来源签名是两件事，SmartScreen 提示不变。
- **旧日志无法回填**：本版之前写下的日志没有 `messages.replace`，压缩/resume 后的窗口
  **不能**从事件流恢复。`event-parity` 把这类会话判为 `incomplete`（不计失败），
  而不是伪造/补写事件——事件日志是 append-only 的审计旁路，不得事后篡改历史。
- **`reason` 生产侧覆盖不完整**：只有压缩路径显式传 `compact`；`/clear` 与 WebUI `onCompact`
  走默认 `rewrite`，`resume` 尚无生产调用点。语义位已留好，但不要据此写「resume 已记录」。
- **大事件会让侧车变大**：`messages.replace` 记整份窗口，压缩频繁的长会话事件文件增长更快；
  且**自动压缩会给同一份基线写两条事件**（agent 侧 `compact` + `rewriteSession` 的
  `messages.replace`）——重放等价，但侧车约为原来的两倍。这是「完整记录」的代价，
  B2-b 可再评估合并/快照策略（本版不改，保持 append-only 与既有 `compact` 语义）。
- **Windows 实机（§1.3）未跑**：本机 macOS；CI `windows-latest` 腿已绿，但不是「标准账户、
  未开 Developer Mode」的实机点验。
