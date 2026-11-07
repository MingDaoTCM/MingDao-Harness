# MingDao Harness v0.6.40 发布说明

> 状态：**已发布**（tag `v0.6.40`）
> 主题：**插话（steer）+ 悬空事件闭合**
> 范围：`v0.6.39..HEAD` 的 5 个提交（`c00b796`、`95be24b`、`b76fe33`、`c651e9d`、`a111197`）。
> 其中 `a111197` 只改变异运行器（`run.mjs --changed`）与 README，**产品代码零改动**。
> 影响面：Web UI 新增一条交互车道（生成中插话）；会话事件侧车新增**加载时自愈**。
> 无破坏性 API / 账本 / 数据格式 / 配置变化；`Enter` 排队行为与 0.6.39 完全一致。

---

## 〇、先读：两条车道，别混

v0.6.39 只有 **next-turn（排队）** 一条车道：生成中按 Enter 的消息要等**本轮全部结束**才发。
v0.6.40 增加 **next-step（插话）**：生成中按 `Cmd/Ctrl+Enter`，消息在**下一个 step 边界**
作为新的 user 消息注入**当前轮**，当前任务不会因此结束。

| 按键（生成中） | 车道 | 什么时候生效 | 视觉 |
| --- | --- | --- | --- |
| `Enter` | next-turn 排队 | 本轮结束后按序逐条发送 | 蓝色 `#queueStrip`，chip 带序号 |
| `Cmd/Ctrl+Enter` | next-step 插话 | 下一个 step 边界，注入当前轮 | 橙色 ⚡ `#steerStrip`，chip 带 ⚡ |

两条队列**互不覆盖**：插话失败或本轮结束时尚未注入的插话，会**自动转回排队**（绝不丢输入）。

---

## 一、用户可见

### 1.1 生成中可以「插话」——插入当前轮（`95be24b`）

> **新快捷键**：生成中 **`Cmd+Enter`（macOS）/ `Ctrl+Enter`（Windows/Linux）= 插话**（注入当前轮）；
> **`Enter` = 排队**（本轮结束后发）。

**场景**：模型正在执行一个长任务，你发现方向偏了，想立刻补一句「先别改那个文件，先跑测试」。
以前只能等本轮结束（或按停止）才能说；现在可以在生成中直接把它插进当前轮。

- 消息进入**橙色 ⚡ 插话条**（输入框上方）：`⚡ 插话中 N 条（下一步注入本轮，不结束当前任务；上限 8 条）`；
- 模型在**下一个 step 边界**收到它（作为新的 user 消息），当前任务继续，不会重启、不会结束；
- 如果模型这一步本来已经**不调用工具、准备收尾**，插话会让它**继续下一步**——用户不会看到"说完就结束"；
- 插话条上：点**文本** → 放回输入框编辑（同时撤销这条插话）；点 **✕** → 撤销；
- 注入成功后，对话流里留一条 `↳ 已插入本轮：…`。

**与排队的关系（重要）**：

- `Enter` 仍然是**排队**——0.6.39 行为不变，本轮结束后自动依次发；蓝色 chip 显示序号与文本；
- 插话**失败**（网络错误 / 任务已结束 / 超长 / 满 8 条）→ 自动**回落为排队**并提示「已改为排队：本轮结束后自动发送」；
- 本轮结束时若还有**没来得及注入**的插话 → 自动转回排队；若排队也满，提示未保留条数；
- 上限：**8 条**，单条 **200KB**（UTF-8 字节——中文一字 3 字节）。超长提示拆短或用 Enter 分次发。

**中止优先**：点「■ 停止」后不再注入插话；`stalled`（无进展看门狗）触发时同理——
"停下"的语义高于"插话"。

### 1.2 崩溃 / 强杀后的事件侧车自愈（`c00b796`）

界面无感，但下次打开会话时事件日志会自动补齐：以前等审批/跑工具时崩溃或强杀，会永久留下
「一直在等审批」「工具没有结果」「回合没有结束」的悬空事件；现在首次加载会话时会追加
**合成的闭合事件**（带 `synthetic:true` 标记），时间线与统计不再卡在"进行中"。

### 1.3 界面变化仅两处文案

插话条默认隐藏，未插话时**布局与 0.6.39 完全一致**（逐像素 diff 只有输入框占位文案一行，
见 §3.1）。占位文案改为 `输入任务…（Enter 发送；生成中 Enter=排队、⌘/Ctrl+Enter=插话）`，
⌘/ 快捷键表同步更新两行——这是新快捷键唯一的即时提示，是有意的文案变更。

---

## 二、开发者可见

### 2.1 `POST /api/steer` 与两种 SSE 事件（`95be24b`）

```http
POST /api/steer
Content-Type: application/json

{ "taskId": "…", "message": "先跑测试再改" }
```

| 状态码 | 含义 |
| --- | --- |
| **200** | 入队成功（`{ok:true, queued:N}`） |
| **400** | 空文本 / 空白文本 |
| **404** | `taskId` 不存在，或任务已结束（只接受 `status === 'running'`，避免写入无人消费的缓冲） |
| **413** | 单条超过 200KB（UTF-8 字节）；**先于**满员判定，所以"又能插但太长"始终是 413 |
| **429** | 缓冲已满 8 条 |

SSE 侧两种 `steer` 事件，语义不同、不要混用：

- 入队即推：`{ type: 'steer', text, queued: true, queuedCount: N }` —— 只是"服务端收下了"；
- 真正注入当前轮时：`{ type: 'steer', text, injected: true }` —— 由 agent 的 drain 发出。

前端只在 `injected` 时于对话流写「↳ 已插入本轮」；`queued` 只用于 `POST` 的即时反馈，避免同一句显示两次。

实现位置：

- 缓冲 / HTTP / SSE：`src/web/server.js` 的 `createSteering`（每个 task 一份，任务结束 `clear`）；
- 路由分发：`src/web/routes/domains/misc.js`（鉴权/CSRF 仍由 `routes/api.js` 统一完成）；
- 纯语义：`src/web/viewmodel.js` 的 `enqueueSteer` / `drainSteer` / `steerView` /
  `shouldContinueAfterModel`，以及常量 `STEER_MAX = 8`、`STEER_TEXT_MAX = 200 * 1024`。
  服务端与前端共用同一份实现（上限、字节口径、全量取走不会两边写歪）。

### 2.2 agent 的两处 drain 点（`95be24b`）

插话**只在 step 边界生效，不会打断进行中的模型调用**：

1. **每个 step 边界**（`src/agent.js:1086`）：放在中止检查**之后**，所以"停止"优先；
   `drainSteeringInto` **全量取走**（一次取走全部，不是一条一步），逐条 append 为 `{role:'user', content:text}`，
   并通过 `io.steer(text)` / `io.push({type:'steer'})` 推 `injected:true`。
2. **模型本要收尾时**（`src/agent.js:2112-2113`）：本次没有工具调用、准备 `return` 前再 drain 一次；
   `shouldContinueAfterModel({steer, aborted, stalled})` 为真就 `continue`（本轮不结束），
   否则正常收尾。`aborted` / `stalled` 任一为真都不继续。

边界：drain 抛异常视为"本轮没有插话"（插话是旁路，坏 buffer 不得打断回合）。

### 2.3 悬空事件闭合：`findDangling` / `synthClosers` / `repairEventLog`（`c00b796`）

三个函数都在 `src/session-events.js`，`repairSessionEvents` 在 `src/session.js`，
由 `loadSession(file, cfg)` 在**消息读完后**顺带调用（每个会话文件每进程只尝试一次）。

**`findDangling(events)`** —— 纯函数，按 `seq` 升序配对：

- `approval.asked` ↔ `approval.decided`：按 `requestId/approvalId/approvalRequestId/id/callId`；
  无 id 时 `decided` 关闭"最近一条无 id 的 ask"；
- `tool.start` ↔ `tool.end`：按 `callId/toolCallId/id`；无 id 时关闭最近一条；
- `turn.start` ↔ `turn.end`：turn 无 id，用栈配对；
- **同 id 多次出现以最后一次为准**（后一次 start/asked 覆盖前一次），不会把已覆盖的旧事件误报成悬空。

**`synthClosers(dangling, {at, reason})`** —— 纯函数，按嵌套顺序生成要追加的事件：
`approval.decided(decision:'aborted')` → `tool.end(ok:false, error:'进程中断，工具结果未知')` →
`turn.end(status:'aborted')`。每条都带 `data.synthetic=true` 与 `data.reason`；
合成事件不带 `seq`，由 `appendEvent` 在锁内分配，接在尾部不重号。

**`repairEventLog(eventFile, {reason})`** —— 语义四条硬约束：

1. **只追加**：不删除、不改写任何既有行（历史字节不变，测试逐字节断言）；
2. **只认完整日志**：`readEvents` 的 `skipped > 0` 视为损坏，返回 `{ok:false}` 且**一个字节都不写**
   ——在坏日志上追加只会把损坏固化进事实源；
3. **幂等**：没有悬空时连文件都不碰（`repaired:0`）；连续第二次修补 `repaired:0`、字节不变；
4. **可关闭**：`cfg.eventLog === false` 或环境变量关闭时完全跳过；修补失败只 `warn`，绝不影响会话读取。

外部事件类型：`EVENT_TYPES` 仍是**对外公开的 12 类**；审批 2 类
（`approval.asked` / `approval.decided`）由 `APPROVAL_EVENT_TYPES` 单独导出，
内部可读写集合 = 12 + 2，既有回归断言不变。

### 2.4 接线与测试

- `test/run-all.mjs` 增加 `session-repair`、`steering` 两套 → **39 套**；
- CI（`.github/workflows/ci.yml`）增加两个独立步骤（Linux/Windows，非 macOS，与既有套件一致）；
- `test/steering.js` **18 项**、`test/session-repair.js` **15 项**；
- 变异：`batch81-steering` **10 条**、`batch82-repair` **8 条**；总数 750 → **768**。

---

## 三、门禁（发布树）

在**发布提交**（`a111197` + 文档/版本提交；发布提交对 `src test` 的 diff 为 0）上逐项运行，全部 exit 0：

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | 0 错误（exit 0） |
| `npm run typecheck:strict` | 当前 0 条 / 基线 0 条 |
| `node test/smoke.js` | 全通过（单独 + 私有 `TMPDIR`） |
| `node test/run-all.mjs` | **39/39 套通过，0 失败** |
| `node test/mutate/run.mjs` | **70/70 批、768 条全中，0 逃逸** |
| `npm run coverage` | 只报告，exit 0（数据见下） |
| `node scripts/doc-lint.mjs` | 全绿 |
| `node src/cli.js diagnose` | exit 0（密钥/token/私网路径已脱敏） |

覆盖率（只报告，不判失败）：

```
行覆盖率（分母 = src 全部 94 个文件）：68.6%（18970/27656 行）· 阈值 72.5%
  · code-lines  68.6%（18970/27656 行）  基线 72.5%  ⛔ 低于基线 3.9pp（仅报告）
  · all-lines   49.3%（18970/38468 行）  基线 52.3%  ✅
  · functions   69.1%（3364/4865 个）     基线 75.4%  ✅
```


### 3.1 发布树截图（1440×900，Electron 真实渲染）

`node scripts/ui-shot.mjs --width 1440 --out /tmp/shots-0640`；与 `/tmp/shots-0639` 逐张比 sha256。
基线不是"凭记忆"，而是**在 `v0.6.39` 的 tag worktree 里用同一命令重跑**，5 张 sha256 与
`RELEASE-NOTES-0.6.39.md` 记录的值**逐字节一致**（排除了环境漂移导致的假差异）。

`#steerStrip` 默认隐藏；逐像素 diff 的 bounding box **5 张完全相同**：
`(474,809)-(762,828)`，即输入框那一行的**占位文案**，**其余像素零差异**——无布局残留。

| 页面 | `/tmp/shots-0640` sha256 | 与 v0.6.39 |
| --- | --- | --- |
| `home.png` | `8c83ba54761107b34c8818f6d1979db8883f8abf77cd722484f14a75a667f161` | ⚠ 仅占位文案 |
| `settings.png` | `a5b7adc46c016d390f476d8c19f8daed82cd19724218eb16821d031847c5ad4b` | ⚠ 仅占位文案 |
| `palette.png` | `06541e15287f3602d108914cad7ef2323f9090eb1e1850df511fea903ed4b2a2` | ⚠ 仅占位文案 |
| `session.png` | `7753aebc2b5fb91c54859f5ae9b9cea2548dcb97d9f9d77e677a3d25d83ed40d` | ⚠ 仅占位文案 |
| `sheet.png` | `229434414e5f411076a107ef4592491feb35fe377a148be4065685d6423106ef` | ⚠ 仅占位文案 |

**为什么"不一致"仍可发布**：这处差异是**有意的文案变更**——占位从
`输入任务…（Enter 发送，Shift+Enter 换行）` 改为
`输入任务…（Enter 发送；生成中 Enter=排队、⌘/Ctrl+Enter=插话）`，
它是插话快捷键**唯一**的即时可见提示。布局类残留（`#steerStrip` 隐藏时留空条）已由
"bbox 只有文字行、其余像素零差异"排除。


---

## 四、未做 / 已知边界

- **插话只在 step 边界生效**：不会打断正在进行的模型调用（没有"中途取消当前请求再发"）。
  这是有意的——中途取消会破坏工具调用与结果回填的配对。
- **`.sig` 站点发布（阶段二）仍未开**：0.6.40 的 `/updates/*.sig` 必须保持 **404**；
  签名只进 GitHub Release（存量客户端只有旧公钥，放上去会让它们永久拒绝更新）。
- **Windows Authenticode 未接入**：与更新来源签名是两件事，SmartScreen 提示不变。
- **已知边界（留 0.6.41）**：跨进程同时修复同一会话时，两个进程可能各写一份 closers。
  因为只追加、且有 `synthetic` 标记，不影响正确性（重放能看到两条合成收尾）；
  彻底解决需要跨进程锁，留到 0.6.41。
- 插话队列不持久化：页面刷新即丢（与 0.6.39 的排队一致，是"这一刻的意图"）。
