# MingDao Harness v0.6.22 发布说明

> 状态：**已发布**（tag `v0.6.22`）
> 主题：**会话分组 / 消息时间戳 + CI 断言确定性**
> ——本版两件事：① 把「会话按时间分组 + 消息时间戳」做成**只增字段、不新增面板、不改布局**的小步改动
> （§3.84）；② 把 v0.6.21 发布时 Windows 首跑红、rerun 才绿的那条并发断言，改成**判提交而不是判中间态**
> （§3.85），让抖动变成「要么全绿、要么可复现地带原因红」。细节见
> `docs/internal/AUDIT-v0.6.1-第三方报告登记.md` **§3.84 / §3.85**。

## 一、§3.84 会话列表按 updatedAt 分组 + 消息时间戳

### 后端（只增字段，既有字段语义不变）

- `GET /api/sessions` 每项在 `file` / `mtime` / `label` 之外新增：
  `updatedAt`（文件 mtime 的 ISO 字符串）、`messageCount`（该会话 JSONL 里合法 role 的行数，坏行跳过）、
  `title`（复用既有文件名标题：自动标题 / 手工重命名都落在文件名上）。
- `GET /api/session?file=` 每条消息新增 `ts`：旧会话没有 `ts` → **`null`**；
  `role` / `content` 等既有字段的值与语义不变；**不用文件 mtime 冒充消息时间**。
- **半截 JSONL 跳坏行，不 500**：末尾未写完的行、损坏的行只跳过，不影响其余消息。
- 新消息在 **Web 服务端落盘时**写入 ISO `ts`（`stampMessageTs()`：只为缺 ts 的新增消息补，
  已有 ts 原样保留；压缩重写不会冲掉历史时间）。
- 未改 `src/session.js`、`src/agent.js`。

### 前端（只加展示，不动布局）

- **分组**：`groupSessionsByUpdatedAt()` / `sessionGroupKey()` 是纯函数，按**本地 00:00 边界**
  分「今天 / 昨天 / 本周（本地周一 00:00 起）/ 更早」，「现在」可注入（测试固定 now，不跨午夜抖动）；
  旧接口的 `mtime`（毫秒）也能分组。
- 落点：既有顶栏「历史会话」下拉用原生 `<optgroup label="今天|昨天|本周|更早">`（组标题不可点、
  不可折叠）；既有「会话管理」弹层 `#sessList` 用 `.sess-group` 小号次要文本（`--dim`）显示同样四组。
- **分组只算一次**：只在 `refreshSessions()` 里算并缓存，渲染不重算，**没有新增 `setInterval`**。
- **消息时间**：同日 `14:32`、跨天 `10-19 14:32`；`ts` 缺失/非法返回空串，
  `addUser` / `newAiMsg` **不建时间节点**——不会出现 `Invalid Date` / `undefined`。

### 测试

- 新增 `test/ui-sessions.js`（5 组）：① 固定 now 的分组/边界；② API 三字段 + 旧会话（无 ts /
  半截 JSONL）不报错；③ 用真实 `addUser` / `newAiMsg` 源码渲染（有 ts 显示、无 ts 不显示、
  无 `Invalid Date` / `undefined`）；④ 标题文案与顺序；⑤ 分组只算一次 + 新代码无 `setInterval`。
  已接入 `test/run-all.mjs` 与 CI（**仅 Linux 腿**）。
- 新增 `test/mutate/batch46-sessions.mjs`：**12/12 全中**。变异总数 **376 → 388**。

## 二、§3.85 CI 不可判定断言：BUG-068 并发 merge 写改成「判提交」

**现象（v0.6.21 发布时的真实证据）**：CI 第 1 次尝试只有 **windows 腿**红在
`test/smoke.js` 的 BUG-068 并发 merge 写检查点（终态 6/8），`rerun-failed-jobs` 后第 2 次五腿全绿，
产品代码未改；历史同类红还有 7/8、6/8 各一次，其余四腿同期全绿。

**原断言在比什么**：8 个子进程各自 `saveTaskStateMerge('s1', { artifacts: [...] })`，
父进程 `Promise.all` 等 8 个子进程 `exit` 后读回文件，比 `artifacts.length === 8`。
**6/8 就是终态只剩 6 条**——那 2 次合并没有进文件。

**抖动根因（时序）**：不是「父进程读早了」——子进程走同步合并写（`writeFileSync(tmp)` +
`renameSync`，都在 `exit` 之前返回）。真正不可判定的是**失败被抹平**：旧写法把子进程
`saveTaskStateMerge()` 的返回值丢进 `stdio: 'ignore'`，只用「进程退了没有」当完成信号。
而这一步在 Windows 上会偶发返回 `{ ok: false }`（最可能是 `s1.json.lock` 处于 NTFS
delete-pending 状态时 `openSync(…, 'wx')` 被拒 EACCES/EPERM，或杀软扫描刚写的 `.tmp` 时
`rename` 被拒），子进程**照常 exit 0**，父进程只看到条数少 1–2。归因信息在 spawn 的一刻就被扔掉，
所以同一份产品代码时而 8/8、时而 7/8、时而 6/8，rerun 只是再掷一次骰子。

**改成什么（三条都不看时序）**：

1. **发令栅栏**：8 个子进程先 `READY` 报到，父进程收齐 8 个才 `stdin.end('go\n')`——8 个写
   **必然重叠**；没报到就退出的立刻带 stderr 报错，而不是静默少一条。
2. **判提交，不判退出**：子进程把 `{ ok, error, seen, hasOwn }` 从 stdout 交回，父进程等
   `'close'`（管道读空）后逐条核对；任何一次合并 `ok !== true` 就用它自己的 OS 错误文案失败。
3. **终态集合判等**：`artifacts` 排序后必须**恰好等于** 8 个预期标记（不再是 `length === 8`），
   且每个子进程自报「提交后自己的标记仍在」——这正是 BUG-068 要守的不变量：锁内合并不得丢
   **已提交**项。

**为什么不再抖**：旧判据里有一个「失败会被抹平成数字」的量，分不清「锁丢了更新」和「这次写被
OS 拒了」，只能靠 rerun 掷骰子。新判据只有两种结局：8 次提交全部 `ok` → 终态必然恰好是那 8 个
标记；否则以**原始错误**红在同一条断言上（CI 注解里能看到 errno 原文）。

**没有做的事**：没有放宽成 `≥6`，没有加重试，没有改 `src/**`（含 `src/atomic-write.js`）。
Windows 上「锁获取遇到 EACCES/EPERM 应算争用而不是失败」是产品侧硬化项，本版按约束未动；
若那条腿再红，新断言会把 errno 直接打进注解，可据此立项，不再需要 rerun 猜。

## 三、验证

- `npm run typecheck` → **0**；`npm run typecheck:strict` → **0 / 基线 0**
- `node test/smoke.js` 单独连跑 **2 次** → 均全通过（§3.85 的确定性：不再出现 6/8 / 7/8；
  另在开发期连跑 3 次全绿）
- `node test/e2e-local.js` → 17 项；`node test/e2e-web.js` → 24 项；
  `node test/e2e-schedule.js` → 11 项；`node test/api-contracts.js` → 8 项
- `node test/pack-ctx-privesc.js` / `ledger-source.js` / `model-names.js` /
  `memory-recovery.js` / `ui-sessions.js` → 全通过
- `node test/mutate/selfcheck.mjs` → 自检通过
- `npm run bench` → 5 套基准全通过
- `node test/mutate/run.mjs` → **34/34 批、388/388 条全中、0 逃逸**
- `node scripts/doc-lint.mjs` → 全通过
- `node src/cli.js diagnose` → 报告生成正常、密钥脱敏
- 发布提交只含五个发布文件（`CHANGELOG.md` / `RELEASE-NOTES-0.6.22.md` / `package.json` /
  `package-lock.json` / `desktop/package.json`）；`git diff --name-only <门禁SHA>..<tagSHA>
  -- src test` → **0 行**
- 发布树截图（真实 Electron）：
  - `node scripts/ui-shot.mjs --out /tmp/shots-0622` → 1440×900
  - `node scripts/ui-shot.mjs --out /tmp/shots-0622 --open "#sessions"` → 1440×900

## 四、已知边界（逐条如实登记）

- **当前没有左栏**：v0.6.19 的三栏骨架已在 v0.6.20 整体回滚（`§3.79`），本版没有为分组去重排
  `.app`。分组因此落在**既有的**「历史会话」下拉与**既有的**「会话管理」列表；没有新建面板，
  也没有新增左侧会话列。
- **CLI / REPL / 调度写入的消息暂无 `ts`**：本版只有 **Web 服务端落盘**会写 `ts`，
  `src/session.js` 未动。因此**旧会话**（Web 落盘之前写的）与**非 Web 会话**（CLI/REPL/调度写的）
  接口返回 `ts: null`，前端**不显示时间**——这是「缺失不建节点」的正确行为，不是漏渲染。
  要覆盖所有入口，需要在 `src/session.js` 的 `appendMessages` 统一补 ts（不在本版改动面）。
- 分组按**本地时区**计算；「本周」从本地周一 00:00 起算，跨时区漫游时分组会随本地时区变化。
  组标题不可点击、不可折叠（原生 `<optgroup>` 行为）。
- `updatedAt` 取的是会话文件 mtime（ISO），不是「最后一条消息的 ts」；手工 `touch` 文件会改变分组。
- `messageCount` 只统计合法 `role` 的行，坏行不计入；半截 JSONL 不影响读取。
- 本版未改 `src/providers/**`、`src/agent.js`、`src/session.js`、`presets/**`、`desktop/**`
  （除版本号）、`ide/**`；未改 `.app` 网格、顶栏、右栏、`#sessSheet`、主题变量或字号阶。

## 五、升级须知

1. 从 v0.6.21 升级是**纯增量**：不新增面板、不改布局，会话列表与对话流照旧可回滚。
2. 「历史会话」下拉里的会话会按今天/昨天/本周/更早分组；老会话没有消息时间，不显示时间戳。
3. CI 侧的变化只影响测试判据（`test/smoke.js` 的 BUG-068 一组），产品行为不变。
4. 本版不删除任何历史产物；需要回退可继续安装 v0.6.21 / v0.6.20。
