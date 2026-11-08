# MingDao Harness v0.6.43 发布说明

> 状态：**已发布**（tag `v0.6.43`）
> 主题：**修主入口守卫的静默失效 + 事件日志格式戳**
> 范围：`v0.6.42..HEAD` 的 1 个提交——`cf77afc`（realpath 主入口守卫 + `EVENT_LOG_FORMAT=2` +
> 对拍判据收紧 + `test/event-parity.js` 5 项 + CI 接线）。
> 影响面：只改**工具与事件旁路**——`scripts/event-parity.mjs`、`scripts/oss-sync.mjs` 的主入口判定，
> `session.start` 事件多一个 `data.format` 字段，对拍工具的三分类判据；会话读取路径（`loadSession`）、
> UI、SSE、账本、配置、会话文件格式**均未改变**。
> **用户可见：无可见变化**。

---

## 〇、先读：本版修的是「守卫自己失效」

v0.6.42 发布时实测发现：`scripts/event-parity.mjs` 通过**符号链接路径**调用（macOS 的
`/tmp` → `/private/tmp`）会**静默 exit 0、零输出**。

根因不是脚本逻辑，而是主入口守卫本身：

```js
// 旧写法（失效）
if (import.meta.url === `file://${process.argv[1]}`) { /* CLI */ }
```

Node 默认把模块解析成 **realpath**（`/private/tmp/...`），而 `process.argv[1]` 仍是调用者
给的**链接路径**（`/tmp/...`），两者字符串永不相等 → `if` 整块被跳过 → **看起来成功**。

这类失败比报错危险：exit 0、无 stderr、无输出，CI 与人眼都容易当成「跑过了」。
**只断言 exit 0 的测试抓不到它**——静默失效恰好也是 exit 0。

同一个根因在本仓已经出现**三次**：

| 位置 | 触发条件 |
| --- | --- |
| `scripts/sign-release-assets.mjs` | Windows 盘符大小写/路径形态不同 |
| `scripts/prune-downloads.mjs` | 同上 |
| `scripts/event-parity.mjs`（本版） | 符号链接路径（Node 解析 realpath） |

三次都是**用字符串比路径**。结论写进代码：主入口判定必须比较 `fs.realpathSync`。

第二件事是给对拍加**格式戳**。v0.6.42 的初版判据是「不一致且日志里没有 `messages.replace`
→ 判 `incomplete`（历史噪声）」。它过宽：一份**新**日志只要没发生重写，本来就没有 replace；
如果它的内容被改坏了，同样落进 incomplete，**真回归被静默放过**。
本版用 `session.start.data.format` 明确区分「日志写于哪个版本」，不再靠类型有无去猜。

---

## 一、用户可见

### 1.1 无可见变化

- 对话、工具卡片、权限确认、排队/插话、账本、调度、SSE 帧、WebUI 全部保持 v0.6.42 的行为；
- 事件日志仍是**旁路**：`loadSession()` 不读它，UI 不渲染它，它不参与云同步；
- 本版不新增/删除任何事件类型，不改变 `messages.replace` 的写入时机与语义；
- 新字段 `session.start.data.format` 只在**新建事件侧车**时写一次，旧日志照常可读；
- 用户磁盘上的唯一差异：0.6.42 之后新建的 `.events.ndjson` 首行会多一个 `"format": 2`；
  0.6.42 之前已有的侧车不会被回填（append-only，不改历史行）。

### 1.2 为什么值得修

`event-parity` 是 v0.7.0 B2-b「切真源」的硬门槛工具。一个会在符号链接路径下静默 no-op 的门槛，
等于**没有门槛**：它会在最需要它的时候给出 exit 0。本版把它修到「换任何路径形态都会真的执行」，
并用一条专门的符号链接回归钉住。

---

## 二、开发者可见

### 2.1 主入口守卫改 realpath（`scripts/event-parity.mjs`、`scripts/oss-sync.mjs`）

```js
function isMainModule() {
  try {
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    const argv = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
    return Boolean(argv) && self === argv;
  } catch { return false; }
}

if (isMainModule()) { /* CLI */ }
```

要点：

- **两侧都归一化**：只归一化 `argv[1]` 或只归一化 `import.meta.url` 都不够；
- realpath 失败（路径已删除、权限不足、非文件）时返回 `false`，**不误判**为主模块；
- `oss-sync.mjs` 一并修：它同样被符号链接/MirrorSync 之外的本地调用触发；
- 这不是「只修一个脚本」：以后新增带 CLI 的 `scripts/*.mjs` 必须用同一判定，字符串比较不再接受。

### 2.2 事件日志格式戳 `EVENT_LOG_FORMAT = 2`

`src/session-events.js`：

```js
export const EVENT_LOG_FORMAT = 2;
```

`src/session.js` 在**新建**事件侧车时把它写进首条事件：

```jsonc
{ "seq": 1, "type": "session.start",
  "data": { "session": "2026-11-08T...jsonl", "format": 2 } }
```

语义：

| format | 覆盖版本 | 含义 |
| --- | --- | --- |
| `1` | 0.6.35–0.6.41 | 只有 `appendMessages` 双写；`rewriteSession()` **不写事件**，压缩/重写后的窗口不可从事件流恢复 |
| `2` | 0.6.42 起 | `rewriteSession()` 也写 `messages.replace`，整份历史可从事件流重建 |

边界：

- 只在**侧车文件不存在**时写一次，与既有 `session.start` 同口径；并发下最多重复一条，无害；
- **旧日志不会被回填**：没有 `format` 字段的日志就是旧日志，读侧按旧语义处理；
- `format` 是整条日志的属性，不是逐事件属性——中途升级的日志首行仍是旧戳，对拍按「没有新戳」处理；
- **打戳从 0.6.43 起**：0.6.42 写下的日志没有 `format`（但已有 `messages.replace`），
  所以「有 replace、无戳」是 0.6.42 的正常形态，不是数据损坏。

### 2.3 双读对拍的三分类：判定依据变了

| 分类 | 判据 | 是否失败 |
| --- | --- | --- |
| **`pass`** | 逐条等价（role / content / tool_calls / tool_call_id） | 否 |
| **`fail`** | 不一致，且日志**有新格式戳**（`session.start.format >= 2`）**或**已有 `messages.replace` | **是（exit 1）** |
| **`incomplete`** | 不一致，且**没有新格式戳、也没有 `messages.replace`**（0.6.41 及以前，rewrite 无事件） | 否 |
| **`skip`** | 没有事件侧车 | 否 |

为什么必须收紧：

- 旧判据「不一致且整条日志**没有** `messages.replace` → incomplete」把两件事混为一谈：
  ① 旧日志本来就没记 rewrite（历史噪声，可以放过）；② 新日志内容被改坏但**从未发生重写**
  （没有 replace，是真回归，必须红）。
- `incomplete` 必须同时满足**两个否定**：没有新格式戳、且整条日志没有 `messages.replace`。
  这才足以证明日志写于 0.6.41 及以前（那时重写根本不记事件）；
- 反过来说，只要日志**能重放**（有 replace），对不上就是真回归，一律 `fail`；
- `isPrefixPair` 保留为**辅助诊断**（解释「少了尾巴/多了尾巴」的形态），**不参与判定**。

一个刻意保留的严格性：0.6.42 写下的日志有 `messages.replace`、但没有 `format`，出现不一致时判
**`fail`**（不是 `incomplete`）——它们已经具备完整重写记录，不能用「旧日志」豁免。
从 0.6.43 起新建的侧车全部带 `format: 2`，新日志即使从未重写（没有 replace）也会被判 `fail`。

### 2.4 测试与 CI

`test/event-parity.js` **5 项**：

1. 等价会话：exit 0 且打印汇总（证明主入口真的执行了）；
2. **经符号链接目录调用**：exit 0 且 stdout 含「对拍结果」——**核心回归**；
3. 新格式日志 + 内容不一致：exit 1，汇总计数正确；
4. 无事件侧车的旧会话：`skip`，不失败；
5. 旧格式日志 + 内容不一致：`incomplete`，不失败。

`test/run-all.mjs` → **44 套**；CI 新增独立步骤 `event-parity`（Linux / Windows，macOS 跳过，
与既有套件一致），失败时把断言原文做成 `::error` 注解。

---

## 三、门禁（发布树）

在**发布提交**上逐项运行（`git diff cf77afc..v0.6.43 -- src test` = **0 字节**，
即门禁树与 tag 树的 `src/` `test/` 完全一致）：

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | 0 错误（exit 0） |
| `npm run typecheck:strict` | 当前 0 条 / 基线 0 条（exit 0） |
| `npm run preflight` | ✓ 预检通过（批次结构 / 变异残留 / 计数一致），exit 0 |
| `node test/smoke.js`（单独 + 私有 `TMPDIR`） | 两次均全通过，exit 0 |
| `node test/run-all.mjs` | **44/44 套通过，0 失败**（exit 0） |
| `npm run mutate:shard`（4 片全量） | **4/4 片全中；73 批 / 794 条（191+198+207+198），0 逃逸**（exit 0） |
| `node scripts/event-parity.mjs --home ~/.mingdao` | pass 1 / incomplete 3 / fail 0 / skip 71（共 75），exit 0 |
| `npm run coverage` | 只报告，exit 0；code-lines **68.6%**（19098/27837）、all-lines 49.2%、functions 68.4%——低于 72.5% 基线，**仅报告不判失败** |
| `node scripts/doc-lint.mjs` | 全绿（10 项检查，exit 0） |
| `node src/cli.js diagnose` | exit 0（密钥/token/私网路径已脱敏） |

发布前工作树干净、三平台 main 已对齐；tag `v0.6.43` 指向发布提交。

---

## 四、未做 / 已知边界

- **B2-b 切真源未做**：UI/账本改为从事件派生（投影）、真源切换，仍留 v0.7.0。
  本版只修工具与判据，**没有任何读取路径改读事件日志**。
- **`session-format-*` 迁移用例未做**：仍留 v0.7.0。本版只有 `EVENT_LOG_FORMAT` 常量与戳，
  没有「旧格式 → 新格式」的迁移器，也没有 `session-format-*` 系列测试。
- **`.sig` 站点发布（阶段二）仍未开**：`/updates/latest.yml.sig` 必须保持 **404**；
  签名只进 GitHub Release（存量客户端只有旧公钥，放上去会让它们永久拒绝更新）。
- **Windows Authenticode 未接入**：与更新来源签名是两件事，SmartScreen 提示不变。
- **旧日志无法回填**：0.6.41 及以前写下的日志没有 `format`、也没有 `messages.replace`，
  压缩/重写后的窗口仍不能从事件流恢复；事件日志是 append-only 的审计旁路，不得事后篡改历史。
  （0.6.42 的日志已有 `messages.replace`，可以重放，只是没有格式戳。）
- **0.6.42 的日志没有格式戳**：它们有 `messages.replace`，对拍不一致时判 **`fail`**（不是
  `incomplete`）——重写记录已完整，不能用旧日志豁免。0.6.43 只保证**新**日志带戳，不回填历史。
- **主入口守卫只修了「比较 realpath」**：没有做仓库级 lint 去强制所有 `scripts/*.mjs` 都这么写；
  新增 CLI 脚本仍可能退回字符串比较。符号链接回归目前只覆盖 `event-parity.mjs`。
- **Windows 实机（checklist §1.3）未跑**：本机 macOS；CI `windows-latest` 腿覆盖了
  `event-parity` 步骤，但不是「标准账户、未开 Developer Mode」的实机点验。
- **自动标题重命名不搬迁事件侧车**：既有边界（`docs/CONFIG.md` 已记），本版未改；
  重命名后 `event-parity` 对该会话判 `skip`。
