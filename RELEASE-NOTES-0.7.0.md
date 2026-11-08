# MingDao Harness v0.7.0 发布说明

> 状态：**已发布**（tag `v0.7.0`）
> 主题：**会话真源翻转为事件日志（可一键回退）**
> 范围：`v0.6.45..HEAD` 的 1 个提交——`6378034`（`DEFAULT_EVENT_SOURCE = events` +
> `MINGDAO_EVENT_SOURCE` 环境变量覆盖 + 旧格式永久回退 + 文案修正 + 证据/套件）。
> 影响面：**会话读取路径**（新会话默认由事件日志重放派生；历史会话仍走消息数组）。
> 对话、工具、账本、调度、同步、认证的行为**均未改变**。
> **用户可见：无强制变化。**

---

## 〇、先读：本版到底改了什么

`0.6.x` 里 `loadSession()` 的默认真源一直是 `.jsonl` 消息数组；事件日志
（`<会话>.events.ndjson`）只是双写的旁路，仅当 `config.eventSource = "events"` 时才被读取，
且必须与消息数组对拍一致才采用。v0.6.44 引入这个灰度开关时写明：**翻默认要等真实会话的
对拍证据**。

本版就是那一天：

- `src/config.js` 的 `DEFAULT_EVENT_SOURCE` 从 `messages` 改为 `events`；
- 读取优先级变为 **`MINGDAO_EVENT_SOURCE`（环境变量）> `config.eventSource` > 默认 `events`**；
- 旧格式日志（`session.start.data.format < 2`）、无侧车、侧车读失败 → **永远回退消息数组**；
- 派生结果与消息文件对拍不一致 → warn（带文件与首个差异位置）+ **回退消息数组**；
- 证据在 `docs/EVENT-SOURCE-EVIDENCE.md`：4 类真实写入路径对拍 4/4、双读 `deepEqual` 4/4，
  `fail=0`、`incomplete=0`。

一句话：**新会话开始由事件日志派生消息；任何不确定都退回老路，且有一条环境变量可以一键回退。**

---

## 一、用户可见

### 1.1 无强制变化

- **历史会话仍按原样显示**：本版之前写下的会话（`format < 2`、或无事件侧车）**永远**从
  消息数组读取，与 0.6.x 逐字节一致；不会迁移、改名、改写任何既有文件。
- 对话、工具卡片、账本、调度、同步、WebUI 的行为**没有变化**；不需要用户做任何操作。
- 升级后**不需要**重新登录、重放会话或清缓存。

### 1.2 新会话以事件日志为真源

- 新会话（`session.start.format >= 2`）正常写入事件侧车；读取时优先用
  `replayToMessages()` 从事件流派生消息，再与 `.jsonl` 消息数组**逐条对拍**。
- 对拍等价 → 采用事件派生结果（两条路径此时完全一致，用户无感）。
- 事件侧车**仍是旁路文件**：`.jsonl` 消息数组始终完整保留，是最后兜底真源。

### 1.3 异常时自动回退并记日志

- 事件日志缺失 / 旧格式 / 读失败 / 对拍不一致：**静默或 warn 后回退消息数组**，会话照常打开。
- 对拍不一致的 warn 会带**文件路径**与**首个差异位置**，例如：

  ```text
  [MingDao] ⚠ 会话事件源对拍不一致（<file>）：<原因>；差异位置：第 N 条——已回退到消息数组
  （消息数组始终是兜底真源；可设 MINGDAO_EVENT_SOURCE=messages 强制回退）。
  ```

- 回退只影响**本次读取**，不删除、不改写事件侧车，便于事后排查。

---

## 二、运维

### 2.1 一键回退（不改配置、不重启改文件）

```bash
MINGDAO_EVENT_SOURCE=messages mingdao ...     # 立即回到旧真源
```

- 环境变量**只对当前进程生效**，不写入 `config.json`；去掉变量即恢复配置文件里的值。
- 适用于「翻默认后怀疑读取路径」的止血：先设变量确认是否与事件源有关，再决定是否改配置。
- 也可以显式写配置 `"eventSource": "messages"`（长期回退）；两者同时存在时**环境变量优先**。

### 2.2 优先级与非法值

| 来源 | 取值 | 结果 |
| --- | --- | --- |
| 环境变量 `MINGDAO_EVENT_SOURCE` | 精确 `messages` / `events` | 采用（最高优先） |
| 环境变量 | 未设 / 空串 / 非法值（拼错、大小写不符） | **视为未设**，继续看配置/默认 |
| `config.eventSource` | 精确 `messages` / `events` | 采用 |
| `config.eventSource` | 缺省 / 非法值 | 默认 `events` |
| 都没有 | — | 默认 `events` |

**非法值不会回落 `messages`**——否则一个拼错的变量会悄悄把真源切回旧路径，而这正是本版要
避免的「看起来生效了、其实没生效」。

### 2.3 旧格式会话永远走消息数组

- `session.start.data.format < 2`：本版之前的事件日志缺少 `messages.replace` 记录，
  压缩 / `--resume` / `/clear` 后的消息窗口无法从事件流回溯 → **无条件回退**，判据不看环境变量。
- 无事件侧车（大量 0.6.x 及更早会话）、侧车损坏/读失败：同样回退，最多 warn 一次。

### 2.4 对拍工具：`node scripts/event-parity.mjs`

```bash
node scripts/event-parity.mjs                 # 扫当前 MINGDAO_HOME/sessions
node scripts/event-parity.mjs --home ~/.mingdao --verbose
```

- 退出码 `0` = 没有不一致；`1` = 有**不一致**（真回归）；`2` = 用法/环境错误。
- 结果分四类：`等价` / `不可回溯（incomplete）` / `不一致（fail）` / `跳过（skip）`。
  - **`fail` 才算回归**；
  - `incomplete` 是**旧日志不可回溯**（写于本版之前、没有任何 `messages.replace`），
    属于历史噪声，**不计入失败**；
  - `skip` = 旧会话没有事件侧车。
- 本机真实会话实测（75 个）：等价 1 · 不可回溯 3 · **不一致 0** · 跳过 71，exit 0。

---

## 三、风险与边界

### 3.1 派生以对拍为门，不一致只 warn + 回退

本版**没有**把「事件派生」变成不可回退的单向路径：每次读取都先对拍，不一致就 warn 并回退。
因此：

- 最坏情况是**退回 0.6.x 的读取行为**，不会出现「事件流坏了、会话打不开」；
- 代价是每次读取多一次对拍开销（与既有灰度路径相同，未新增 IO 模式）；
- warn 不会阻断会话，也不会自动「修复」事件文件——可疑样本请保留现场并用 `event-parity` 复查。

### 3.2 未覆盖的样本类型（翻转后仍建议补样）

以下写入路径**没有**纳入本次 4 类证据，翻默认后仍建议继续采样：

- 中断占位（`interrupt` 事件 + 悬空 tool 调用的占位回填）；
- 审批拒绝（permission deny）产生的消息形态；
- `/clear` 产生的 `messages.replace`（本版证据覆盖了 `/compact` 与自动压缩的重写，未覆盖 `/clear`）；
- 工具执行失败 / 参数解析失败的消息形态；
- **WebUI 服务端写入路径**（本次证据走 CLI / REPL）；
- 真实远端 provider 的 usage / reasoning 字段差异（本次用本地 SSE 桩，消息形态真实但上游行为简化）。

这些路径下若出现对拍不一致，行为是**warn + 回退**，不会静默变形；但仍应视为待补证据。

### 3.3 其它边界

- 事件日志双写一直是「写失败只 warn、不影响会话」（0.6.x 起），本版未改；
- 回退是**读路径**行为，不迁移数据、不清理旧侧车；
- `eventLog=false` / `MINGDAO_EVENT_LOG=0` 仍可整体关闭事件日志（此时读取自然全部走消息数组）。

---

## 四、未做

- **更新来源签名（`.sig`）阶段二已接入（0.6.45）**——本版**不再是待办**；客户端按
  `/updates/<包名>.sig` 取签名并用内置 `current` 公钥验签，默认档仍是 `warn-and-install`。
- **Windows Authenticode 未接入**：与更新来源签名是两件事，SmartScreen 提示不变。
- **桌面更新下载仍走 OSS 香港**：国内镜像提速（就近回源 / CDN 调度）待做；本版未改下载链路。
- 本版**不**把默认签名档改成 fail-closed，也**不**新增会话格式版本。

---

## 五、门禁（发布树）

在**发布提交**上逐项运行（`git diff 6378034..v0.7.0 -- src test` = **0 字节**，即门禁树与
tag 树的 `src/` `test/` 完全一致）：

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | 0 错误（exit 0） |
| `npm run typecheck:strict` | 当前 0 条 / 基线 0 条（exit 0） |
| `npm run preflight` | ✓ 预检通过（批次结构 / 变异残留 / 计数一致），exit 0 |
| `node test/smoke.js`（单独 + 私有 `TMPDIR`） | 两次均全通过，exit 0 |
| `node test/run-all.mjs` | **46/46 套通过，0 失败**（exit 0） |
| `npm run mutate:shard`（4 片全量） | **4/4 片全中；74 批 / 804 条，0 逃逸**（exit 0） |
| `node scripts/event-parity.mjs --home ~/.mingdao` | 对拍 exit 0（等价 1 / 不可回溯 3 / 不一致 0 / 跳过 71，共 75） |
| `node scripts/make-event-fixtures.mjs --rm` | 4/4 样本 pass，双读 `deepEqual` 4/4（exit 0） |
| `npm run coverage` | 只报告，exit 0；行覆盖率 **68.6%**（19141/27907）、all-lines 49.1%、functions 68.8% |
| `node scripts/doc-lint.mjs` | 全绿（10 项检查，exit 0） |
| `node src/cli.js diagnose` | exit 0（密钥 / token / 私网路径已脱敏） |

发布前工作树干净、三平台 main 已对齐；tag `v0.7.0` 指向发布提交。

---

## 六、升级建议

- **所有用户**：正常升级即可，**不需要**做任何事；历史会话显示不变，新会话自动走事件真源。
- **怀疑会话读取异常时**：先 `MINGDAO_EVENT_SOURCE=messages` 启动一次（一键回退），
  再跑 `node scripts/event-parity.mjs --home ~/.mingdao --verbose` 看是否有 `fail`；
  `incomplete` 是旧日志的正常现象，不是故障。
- **运维**：本版发布后仍按 0.6.45 的流程发布更新签名（`publish-update-sigs.mjs`），
  否则客户端会退回「未验证来源签名」提示（默认档放行，不拒绝）。
