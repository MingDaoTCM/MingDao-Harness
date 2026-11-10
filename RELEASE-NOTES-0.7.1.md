# MingDao Harness v0.7.1 发布说明

> 状态：**已发布**（tag `v0.7.1`）
> 主题：**四份审计报告的止血与性能**
> 范围：`v0.7.0..HEAD` 的 11 个提交——`4704a69`（H-02 桌面更新验签接入密钥环）、
> `b1b64d9`（H-6 模型发现并发 + M-6 SSE 背压）、`30fd246`（S-5 会话写锁 + S-1/S-2/H-2
> outcome 单源）、`ee31bfc`（S4 事件读放大）、`d5fd2ce`（H-01 只读 git 外部 diff 围栏 +
> 门禁接线 + smoke 密钥环守卫）、以及 `67461b6`（官方 Pack 版本窗口守卫）、
> `be90aba`/`c1dfda5`/`041d244`/`c286b3a`（变异锚点与 strict 收口）。
> 影响面：**桌面自动更新验签路径（翻车级）**、只读 git 出网围栏、会话读写性能、
> 会话写锁、回合结局/工具成败判定单源、模型发现、SSE 背压。
> 对话、工具、账本、调度、同步、认证的对外行为**均未改变**。
> **用户可见：有**（更新验签修复 + 只读 git 不再触发外部程序 + 会话加载更快）。

---

## 〇、先读：本版到底改了什么

四份审计报告（S/H/M/A）里那些「翻车级」和「热路径」问题，本版集中收口。最要命的一条是
**H-02**：桌面更新的验签主路径此前仍走 `legacy-2025` 单钥，而发布链路自 0.6.45 起已经改用
`current` 私钥签发——真实客户端拿到 `current` 签名会「验签失败 → 拒绝更新」。本版把主路径
接回密钥环 `UPDATE_PUBLIC_KEYS`（含 `current`），让 0.6.45 起发布的签名重新可验。

其余是**性能**（事件读放大、会话列表 N×2、模型发现、SSE 背压）、**正确性**（会话写锁、
agent outcome 漏网出口）、**安全**（只读 git 外部 diff/textconv 围栏）与**门禁接线**。

---

## 一、用户可见

### 1.1 桌面自动更新验签修复（否则更新会被拒）

- `desktop/update-verify.js` 的 `evaluateUpdate` 主路径从「legacy 单钥」改为
  **密钥环 `UPDATE_PUBLIC_KEYS`**（含 `role: 'current'`）。
- **修之前**：0.6.45 起发布链路用 `current` 私钥签发，而客户端主路径只拿 legacy 公钥验，
  结果「验签失败 → 拒绝」，真实客户端会拒绝本应正常的更新。
- **修之后**：密钥环命中 `current` → `install`，并正确报告命中的 `keyId` 指纹。
- 回归钉在 `test/update-signing.js` ⑩ / ⑩b（14 项）。

### 1.2 只读 git 不再能触发外部程序（H-01）

- 只读 git 命令（`status` / `log` / `diff` 等）此前可能经 `diff.external` /
  `diff.<driver>.command` / `textconv` 触发**外部程序**。本版加了围栏，只读 git 路径
  不再把仓库内容交给外部进程。
- PoC 级回归：`C2-14` / `C2-15`（只读 git 出网围栏）。

### 1.3 性能：会话加载更快（S4 事件读放大修复）

- 读路径不再逐条重放：`readLastEventSeq` 导出、`loadSession` 一次解析、
  `diffMessages` 结构化、`readAfter` 尾窗游标、`sessionPreview` 8KB 上限、消息计数缓存。
- 用户能感知的是**会话列表 / 打开会话更快**，尤其在会话较多时。

---

## 二、开发者 / 运维

### 2.1 事件读放大修复（S4）

- 上面 1.3 的六处改动全部落在 `src/session.js` / `src/session-events.js` 读路径，
  对既有会话格式**零迁移、零改写**。

### 2.2 会话写锁（S-5）

- 新增 `withFileLockSync` 会话写锁；`test/state-locks.js` 覆盖 **16 子进程**并发场景。
- 注意（诚实）：本版仍用**同步锁**（见 §四 已知遗留）。

### 2.3 outcome 单源（S-1 / S-2 / H-2）

- agent 回合结局与工具成败此前有「漏网出口」：`allSettled` 抽 `runToolBatch`、
  `markOutcome` 补点、`toolOk` 顶层解析——结局判定收口到单一来源，避免漏记 / 误记。

### 2.4 模型发现并发（H-6）

- 模型发现并发 + 负缓存 + single-flight：同一次发现的重复请求合并，失败结果负缓存，
  减少冷启动抖动与重复外呼。

### 2.5 SSE 背压（M-6）

- WebUI SSE 写入增加背压：`write` 返回 `false` 时暂停、`drain` 恢复、128 帧未消费即断开，
  避免慢客户端把内存/连接打爆。

### 2.6 会话列表 N×2 读（H-7）

- 会话列表由「每会话两次读」收为一次读。

---

## 三、门禁接线

- **S2**：`ci.yml` 增加 tag 触发；`desktop.yml` 新增 `test` job，`publish` 依赖
  `needs: [build, test]`。
- **M-11**：`session-events` 套件注册进 `test/run-all.mjs` 默认运行器（此前
  「46/46」含水分），现在 **52 套**。
- 覆盖率步骤名诚实化（不再把「只报告」说成「门禁」）。

---

## 四、已知遗留（诚实写）

- **S-3 事件 append 仍用同步锁**；**S-5 会话写锁也用同步锁**——这两条热路径的同步锁是
  审计点名要异步化的，**本轮为控风险未做**。
- **覆盖率门禁仍关闭**（只报告趋势，不拦发布）。
- **strict 靠 1270 处 `@type {any}`**（逐步消除中，棘轮只许降不许升）。
- **agent.js 仍未拆分**（体量与职责边界是审计点名的结构债）。
- **`.sig` 默认档仍是 `warn-and-install`**：签名缺失（发布侧故障 / 网络取不到）时提示后放行，
  不把用户挡在更新之外；`MINGDAO_REQUIRE_UPDATE_SIGNATURE=1` 仍可切 fail-closed。

---

## 五、未做

- **Windows Authenticode**：与更新来源签名是两件事，SmartScreen 提示不变。
- **版本语义重整**：未把 0.x 语义重整为 1.x。
- **Pack 子进程隔离**：Pack 仍在同进程 / 同权限域执行（审计点名的隔离加固）。

---

## 六、门禁（发布树）

在**发布提交**上逐项运行（`git diff c286b3a..<tag> -- src test` = 0 字节，即门禁树与
tag 树的 `src/` `test/` 完全一致，见发布收尾报告）：

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | 0 错误（exit 0） |
| `npm run typecheck:strict` | 当前 0 条 / 基线 0 条（exit 0） |
| `npm run preflight` | ✓ 预检通过（批次结构 / 变异残留 / 计数一致），exit 0 |
| `node test/smoke.js`（单独 + 私有 `TMPDIR`） | 均全通过，exit 0 |
| `node test/run-all.mjs` | **52/52 套通过，0 失败**（exit 0） |
| `npm run mutate:shard`（4 片全量） | **4/4 片全中；77 批 / 828 条，0 逃逸**（exit 0） |
| `node scripts/event-parity.mjs --home ~/.mingdao` | 对拍 exit 0（等价 3 / 不可回溯 3 / 不一致 0 / 跳过 71，共 77） |
| `npm run coverage` | 只报告，exit 0（趋势参考，不拦发布） |
| `node scripts/doc-lint.mjs` | 全绿（10 项检查，exit 0） |
| `node src/cli.js diagnose` | exit 0（密钥 / token / 私网路径已脱敏） |

发布前工作树干净、三平台 main 已对齐；tag `v0.7.1` 指向发布提交。

---

## 七、升级建议

- **≥0.6.36 且已装 0.6.45 之后版本**：直接自动更新即可，本版起 `current` 签名验签恢复正常。
- **≤0.6.35**：自动更新仍会被拒（`legacy-2025` 私钥已丢弃，无法补签名），手动下载一次本版后恢复。
- **运维**：本版发布后**必须**执行签名发布（`publish-update-sigs.mjs 0.7.1`），否则客户端退回
  「未验证来源签名」提示（默认档）。
