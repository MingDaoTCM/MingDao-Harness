# MingDao Harness v0.6.44 发布说明

> 状态：**已发布**（tag `v0.6.44`）
> 主题：**事件为源的灰度开关（默认不变）+ 判据单源**
> 范围：`v0.6.43..HEAD` 的 2 个提交——`2965302`（`config.eventSource` + `loadSession` 的
> `events` 分支 + `test/event-source.js` 19 项 + `batch86-event-source`）、`03b43c9`
> （`diffMessages` 单源 + 变异锚点跟随 + CI 接线）。
> 影响面：新增一个**默认 `messages`** 的配置项；`loadSession(file)` 的默认读取路径与返回值
> 形状**未变**；只有显式 `eventSource: "events"` 时才多走一条「事件派生 + 对拍兜底」分支。
> 会话读取路径（默认）、UI、SSE、账本、调度、会话文件格式**均未改变**。
> **用户可见：无变化**。

---

## 〇、先读：本版的核心是「默认不变」

v0.7.0 B2-b 的目标是让**事件日志**成为会话的读取真源。直接翻默认是一次「大爆炸」式切换：
任何一份事件日志的缺口都会立刻变成用户看到的历史缺失。

本版只做**第一步**：加一个**默认关闭**的灰度开关 `config.eventSource`。

- 默认值仍是 `"messages"`——读取逻辑、返回值、字节输出与 v0.6.43 一致；
- 只有显式配置 `"events"`，才尝试用事件日志派生消息；
- 即使开了，派生结果也**必须与 `.jsonl` 消息数组逐条对拍一致才采用**；
- 不一致就 **warn（带首个差异位置）并回退到消息数组**——灰度开关不能改变用户看到的历史。

换句话说：**本版新增的是一条「验证通道」，不是一条新的默认读取路径。**
翻默认必须等 `scripts/event-parity.mjs` 的真实会话证据（pass 覆盖足够广、incomplete 清零），
本版明确**不翻**。

---

## 一、用户可见

### 1.1 无可见变化

- 对话、工具卡片、权限确认、排队/插话、账本、调度、SSE 帧、WebUI 全部保持 v0.6.43 的行为；
- 默认读取路径仍只读 `.jsonl` 消息数组，**不读事件源、不产生 warn**；
- `loadSession()` 返回值形状仍是 `{ file, messages }`，没有新增字段；
- 用户配置文件里**不会自动多出** `eventSource` 字段：只有用户自己写进去，读/写路径才会
  归一化它；字段不存在时保持旧文件字节不变；
- 默认模式下事件侧车的行为不变（仍按 `eventLog` 开关双写，旁路）。

### 1.2 为什么值得做

如果只在「切默认」的那一刻才第一次验证事件源，风险会集中爆发：日志缺口、旧格式、并发写入
顺序问题都只能在用户会话里暴露。灰度开关把验证提前到**默认切换之前**：

- `"events"` 是**显式 opt-in**，默认用户完全不受影响；
- 对拍兜底保证「派生值 != 消息数组」时**永远回退**，最坏情况只是多一条 warn；
- 真实会话可以先在开关下跑一遍，把 `event-parity` 的 pass 覆盖和 incomplete 清零作为翻默认
  的前置证据。

本版的价值不在「新增功能」，而在**把下一次切换的风险变成可验证、可回退的**。

---

## 二、开发者可见

### 2.1 `config.eventSource` 的取值与风险

`src/config.js` 导出：

```js
export const EVENT_SOURCE_MESSAGES = 'messages';
export const EVENT_SOURCE_EVENTS = 'events';
export const DEFAULT_EVENT_SOURCE = EVENT_SOURCE_MESSAGES; // 'messages'
export function normalizeEventSource(value) {
  return value === EVENT_SOURCE_EVENTS ? EVENT_SOURCE_EVENTS : EVENT_SOURCE_MESSAGES;
}
```

| 值 | 含义 | 风险 |
| --- | --- | --- |
| `"messages"`（默认） | 只读 `.jsonl` 消息数组，与 0.6.x 逐字节一致 | 无新增风险 |
| `"events"` | 尝试用事件日志 `replayToMessages` 派生；对拍一致才采用 | 灰度验证用；旧日志/缺侧车会静默回退；对拍不一致会 warn 并回退 |

归一化口径（三条路径共用）：

- **读配置**：`loadConfig()` 把非法/缺省值归一化为 `messages`；
- **写回**：`saveConfig()` 不会把非法值落盘；
- **直接调用**：`loadSession(file, { eventSource: ... })` 同样归一化。

只认**字面量** `"events"`：大小写不符（`"EVENTS"`）、拼错（`"bogus"`）、`undefined` 一律按
`messages` 处理。**不要**因为一个拼错的值把读取路径切到实验分支。

**翻默认的条件**：`scripts/event-parity.mjs` 在真实会话上持续给出足够广的 pass 覆盖，且
incomplete 清零。仅「把配置设成 events 没报错」不构成证据——多数旧日志本来就会静默回退。

### 2.2 对拍兜底与回退语义

`loadSession(file, cfg)` 的 `events` 分支（`src/session.js`）：

1. 事件侧车不存在 → **静默回退**消息数组（不 warn）；
2. 读取失败 / 半行损坏 → **静默回退**（旁路异常不能让会话读不出来）；
3. 没有 `session.start.data.format >= EVENT_LOG_FORMAT`（2）→ **静默回退**（旧格式无法完整回溯）；
4. `replayToMessages()` 成功 → 与消息数组做 `diffMessages`：
   - **一致** → 采用派生结果（新数组，深拷贝，可安全修改）；
   - **不一致** → `console.warn` 一行（含会话文件、原因、`差异位置：第 N 条`），
     并**回退消息数组**——灰度期不允许实验分支改变用户看到的历史。

其他不变式：

- 返回值形状始终是 `{ file, messages }`；
- `repairSessionEvents(file, cfg)` 仍在派生**之后**执行（与 `scripts/event-parity.mjs` 同口径，
  对拍工具读到的也是修补前的日志）；
- 默认模式**不读事件源**：即使侧车损坏/不一致，也不得产生 warn。

`test/event-source.js` 19 项覆盖了上述每一条分支，包括「条数不同」「格式戳缺失/过旧」
「无侧车」「半行损坏」「读失败」「`messages.replace` 之后 append」「空事件文件」「深拷贝」等。

### 2.3 `diffMessages` 单源位置

**唯一实现**：`src/session-events.js`。

`scripts/event-parity.mjs` 不再自带一份，而是：

```js
import { diffMessages } from '../src/session-events.js';
export { diffMessages }; // 保持脚本对外签名不变
```

为什么收敛：同一判据曾在脚本与被测实现里各存一份，**两份判据迟早漂移**——对拍工具说
「等价」，`loadSession` 却按另一把尺子判「不一致」并回退；或者反过来，工具放过真回归。
**对拍工具与被测代码必须用同一把尺子。**

新增对拍逻辑时**不要复制** `diffMessages`，从 `src/session-events.js` 导入即可。

### 2.4 锚点失配必须红（`batch48 ⑨` 的教训）

`loadSession` 的返回值从直接数组改为 `messages: result` 后，`batch48 ⑨` 的锚点字符串失配。
变异器没有「静默通过」，而是**响亮失败**（`变异点未找到`）——这正是我们想要的失败模式：

- 锚点找不到 = 这条变异没有真正施加，不能算「已变异/未逃逸」；
- 如果把「锚点失配」当成 skip，变异测试会悄悄少跑，覆盖率数字还在，保护却没了；
- 本版已更新 `test/mutate/batch48-ts.mjs` 锚点，batch48 恢复 **10/10**。

原则：**代码形状变了，变异锚点必须跟着改；锚点找不到必须红。**

### 2.5 接线：测试 / CI / 变异

- `test/event-source.js` **19 项**；
- `test/run-all.mjs` → **45 套**；
- CI 新增独立步骤 `event-source`（Linux / Windows，macOS 跳过），失败时把断言原文做成
  `::error` 注解；
- `test/mutate/batch86-event-source.mjs` **9 条**；变异总数 **74 批 803 条**。

---

## 三、门禁（发布树）

在**发布提交**上逐项运行（`git diff 03b43c9..v0.6.44 -- src test` = **0 字节**，即门禁树
与 tag 树的 `src/` `test/` 完全一致）：

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | 0 错误（exit 0） |
| `npm run typecheck:strict` | 当前 0 条 / 基线 0 条（exit 0） |
| `npm run preflight` | ✓ 预检通过（批次结构 / 变异残留 / 计数一致），exit 0 |
| `node test/smoke.js`（单独 + 私有 `TMPDIR`） | 两次均全通过，exit 0 |
| `node test/run-all.mjs` | **45/45 套通过，0 失败**（exit 0） |
| `npm run mutate:shard`（4 片全量） | **4/4 片全中；74 批 / 803 条，0 逃逸**（exit 0） |
| `node scripts/event-parity.mjs --home ~/.mingdao` | pass 1 / incomplete 3 / fail 0 / skip 71（共 75），exit 0 |
| `npm run coverage` | 只报告，exit 0；code-lines **68.6%**（19136/27898）、all-lines 49.1%、functions 68.7%（低于 72.5% 基线，按设计仅报告不判失败） |
| `node scripts/doc-lint.mjs` | 全绿（10 项检查，exit 0） |
| `node src/cli.js diagnose` | exit 0（密钥/token/私网路径已脱敏） |

发布前工作树干净、三平台 main 已对齐；tag `v0.6.44` 指向发布提交。

---

## 四、未做 / 已知边界

- **默认未翻**：`config.eventSource` 默认仍是 `messages`。翻默认要等真实会话的
  `scripts/event-parity.mjs` 证据（pass 覆盖足够广、incomplete 清零），本版不翻。
- **WebUI 无设置项**：`eventSource` 只能通过配置文件/直接传 `cfg` 使用；设置面板不加开关，
  避免把灰度实验暴露成面向用户的功能。
- **`session-format-*` 迁移用例未写**：本版没有「旧格式 → 新格式」迁移器，也没有
  `session-format-*` 系列测试；旧日志继续按「不可回溯」处理，不回填、不篡改历史。
- **`.sig` 站点发布（阶段二）未开**：`/updates/latest.yml.sig` 必须保持 **404**；签名只进
  GitHub Release（存量客户端只有旧公钥，放上去会让它们永久拒绝更新）。
- **Windows Authenticode 未接入**：与更新来源签名是两件事，SmartScreen 提示不变。
- **事件侧车重命名不搬迁**：自动标题重命名会话文件不会搬迁事件侧车（既有边界），重命名后
  `event-parity` 对该会话判 `skip`。
- **人工点验（checklist §2，3820 WebUI）未做**：本会话为自动执行，无人类点按钮确认。
- **Windows 实机（§1.3）未跑**：本机 macOS；CI `windows-latest` 腿覆盖了 `event-source` 步骤，
  但不是「标准账户、未开 Developer Mode」的实机点验。
