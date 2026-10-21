# MingDao Harness v0.6.23 发布说明

> 状态：**已发布**（tag `v0.6.23`）
> 主题：**Windows 文件锁争用硬化 + 消息时间戳统一**
> ——本版两件事：① 把 Windows 上 `EACCES`/`EPERM`/`EBUSY` 这类**瞬时拒绝**从「永久失败」
> 改判为「争用」，给独立、有界、指数退避的重试预算（§3.86）；② 把消息 `ts` 的补齐收敛到
> **唯一写入口** `appendMessages()`，CLI / REPL / 调度 / Web 共用同一份实现（§3.87）。
> 细节见 `docs/internal/AUDIT-v0.6.1-第三方报告登记.md` **§3.86 / §3.87**。

## 一、§3.86 Windows 锁/重命名争用硬化（`src/atomic-write.js`）

### 为什么改

v0.6.21 发布时，CI **Windows 腿**的 BUG-068（8 个子进程并发 `saveTaskStateMerge`）出现过
**7/8、6/8**，`rerun` 一次才绿；同期 macOS/Linux 万条×5 轮、64 进程×5 轮 **0 丢**。
v0.6.22（§3.85）已把测试侧改成「判提交」并能把子进程的 `{ok:false,error}` 带出来，
但**产品侧仍把 Windows 的瞬时拒绝当永久失败**——这才是无归因差数的来源。

两个 errno 都属于「**名字暂时不可用**」，不是权限配置错：

1. **锁获取**：NTFS 上 `.lock` 刚被 `unlink` 但句柄尚未释放（delete-pending）时，
   `openSync(…,'wx')` 返回 `EACCES`/`EPERM`；Defender / 索引器扫描锁文件时同样。
   旧 `tryAcquire` 只把 `EEXIST` 当「别人持有」，其它 errno 直接抛。
2. **原子写**：杀软/索引器短暂持有刚写出的 `.tmp` 或目标文件时，`renameSync` 返回
   `EACCES`/`EPERM`/`EBUSY`；旧实现一次都不重试。

### 改了什么

- `tryAcquire` 返回结构化 `{ok,code,error}`；`EEXIST` **以及** `EACCES`/`EPERM`/`EBUSY`
  都算争用，其余错误（路径非法等）仍直接抛。
- **两条等待路径分开**（语义不同，不能共用一条超时闸）：
  - `EEXIST`（确实有人持锁）保持既有 `timeoutMs=5s` / `staleMs=4s` 与陈旧锁回收；
  - 瞬时拒绝单独 **2s 预算：首次 5ms、每次 ×2、封顶 100ms**。5ms 起是因为 delete-pending
    通常几个 tick 就清掉；指数退避避免在杀软扫描窗口里高频敲盘；封顶 100ms 让晚期恢复也不慢；
    2s 覆盖数十~数百 ms 的单文件扫描窗口，同时**有界**——真 ACL/只读目录不会永久冻住进程。
  - **同步（`Atomics.wait`）与异步（`sleepAsync`）同一判据**；异步版轮询间隔由固定 25ms
    改为同样的「首次 5ms + 指数退避」。
- `atomicWriteFileSync` 的 `writeFileSync(tmp)` 与 `renameSync(tmp,target)` **共享同一份
  2s deadline**（避免两段各等 2s），只对上述三个 errno 重试。
- **预算耗尽原样 rethrow 原始 errno**（保留 path），不折成「获取文件锁超时」、不 `catch{}`
  吞掉；写失败时清理 `.tmp`。`saveTaskStateMerge` 因此返回的是
  `{ok:false, error:"EACCES: permission denied, open '…s1.json.lock'"}`——原始错误文本。
- 成功路径零开销、返回值形状（`{ok:true,error:null}`）与合并语义（保留 goal、artifacts 并集）不变。

### 测试与变异

- `test/smoke.js` 新增 **§156**（用 fs 门面注入 errno，不依赖 Windows 真机）：
  ① 真实子进程持 `.lock` 300ms → 必须等待后 `ok:true` 且锁被释放；
  ② 注入 `openSync` `EACCES`×3 / `EPERM`×2（**同步 + 异步两条路径**）→ 重试后成功，
  断言注入次数被真实消耗、重试间有退避；
  ③ 持续 `EACCES` → 约 2s 耗尽返回 `{ok:false}`，`error` 含 `EACCES` 且**不含**「超时」，
  失败不污染状态；
  ④ `rename` 注入 `EPERM`×2 → 原子写成功；持续 `EPERM` → 抛原始 errno、目标保持旧值、不留 `.tmp`；
  ⑤ `writeFileSync(tmp)` 注入 `EACCES`×2 → 重试后成功；
  ⑥ 退避参数边界（初始 5–10ms / 封顶 ≤200ms / 总预算 ~2s）与成功返回值、合并语义不变。
- 新增 `test/mutate/batch47-lock-retry.mjs`：**9/9 全中**。变异总数 **388 → 397**。

## 二、§3.87 消息 `ts` 统一到会话层（`src/session.js`）

### 为什么改

v0.6.22（§3.84）的 `ts` 只在 `src/web/server.js` 的 Web 落盘路径上打，而 CLI / REPL / 调度
worker 走 `src/session.js` 的 `appendMessages()`——于是同一份会话文件里，Web 写的消息有时间、
非 Web 写的没有；这条规则实际上有**两份实现**。

### 改了什么

- `src/session.js` 新增 `stampMessageTs(messages, now)`，并在**唯一公共写入口**
  `appendMessages()` 内调用：**只补缺少 `ts` 的消息**（ISO 字符串），已有 `ts` 原样保留；
  `role` / `content` / 顺序不变，`ts` 为新增字段。
- **幂等**：同一批消息重复写入（追加再读再写、自动压缩 `rewriteSession` 整文件重写）不会刷新
  时间；补齐是**就地写回同一批消息对象**，因此内存数组也带上 `ts`，压缩重写会原样保留。
- **兼容**：读取路径（`loadSession` / `/api/session`）完全不动。旧消息没有 `ts` 就返回 `null`，
  **不补、不推测、不用文件 mtime 冒充**；旧文件不会被批量改写（只有显式压缩重写才会重写文件）。
- **去重**：删除 `src/web/server.js` 里的 `stampMessageTs`；Web 用户消息与回合新增消息都只调
  `appendMessages`，用户消息落盘后把该对象上的 `ts` 同步回内存用于压缩重写——不再有第二套时间来源。
- `docs/CONFIG.md` 的「WebUI 会话列表字段与消息时间」同步改为「`ts` 由
  `session.appendMessages` 统一补齐」。

### 测试与变异

- `test/smoke.js` 新增 **§157**：① 写入即补合法 ISO `ts`，`role`/`content`/顺序不变；
  ② 已有 `ts` 不覆盖，同一对象重复写入 + `rewriteSession` 整文件重写后均不变；
  ③ 旧会话（无 `ts`）经真实 `/api/session` 路由读取返回 `null`，文件内容与 mtime 均未被改写；
  ④ 结构断言：`server.js` 不得再自建 `stampMessageTs`，Web 两处落盘都必须走 `appendMessages`；
  ⑤ 非法 `ts` 读取 200、content 不丢、原样返回（前端 `msgTimeText` 负责不显示）。
- 新增 `test/mutate/batch48-ts.mjs`：**10/10 全中**。变异总数 **397 → 407**。

## 三、验证（本机 macOS，最终 HEAD）

- `npm run typecheck` → **0**；`npm run typecheck:strict` → **当前 0 / 基线 0**
- `node test/smoke.js` 单独跑 → **156 组断言全部通过**（含新增 §156 / §157）
- `node test/e2e-local.js` → 17 项；`node test/e2e-web.js` → 24 项；
  `node test/e2e-schedule.js` → 11 项；`node test/api-contracts.js` → 8 项
- `pack-ctx-privesc` 4 组 / `ledger-source` 7 组 / `model-names` 8 组 /
  `memory-recovery` 5 项 / `ui-sessions` 5 项 → 全通过
- `node test/mutate/selfcheck.mjs` → 14/14 场景通过
- `npm run bench` → 5 套基准全通过（savings 基准 20 通过 / 0 失败）
- `node test/mutate/run.mjs` → **36/36 批全中、变异 407/407 条被抓到**（batch47 9/9 +
  batch48 10/10；跑完自动还原，无残留）
- `node scripts/doc-lint.mjs` → 全通过（变异总数 407）
- `node src/cli.js diagnose` → 报告生成正常、密钥脱敏
- 发布提交只含五个发布文件（`CHANGELOG.md` / `RELEASE-NOTES-0.6.23.md` / `package.json` /
  `package-lock.json` / `desktop/package.json`）；
  `git diff --name-only <门禁SHA>..<tagSHA> -- src test` → **0 行**
- 发布树截图（真实 Electron）：`node scripts/ui-shot.mjs --out /tmp/shots-0623` → 5 张

## 四、已知边界（逐条如实登记）

- **未在真实 Windows 机器上验证**：本机（macOS）只能按 Node fs 行为**注入 errno** 复现；
  Windows CI 是第一次真实证据，注入无法复现 NTFS delete-pending 的具体时序。
  若 CI 仍然红，请按 §1.1 的注解接口取**失败断言与 errno 原文**，不要用 rerun 掩盖。
- `releaseLock` 的 `unlinkSync` 仍是 **best-effort**（`catch {}`）：若 unlink 被拒且持有者 pid
  还活着，下一个写方会等到 5s 超时（持有者退出后可立刻回收）。
- `mkdirSync(dir)` 的 `EACCES`/`EPERM` **不重试**（父目录 ACL 是永久错误，不是瞬时争用）；
  锁文件 `writeSync` 失败也不重试。
- Windows 上把目标路径占成**目录**时 `rename` 也可能报 `EPERM`，这类**永久**错误同样会先等
  2s 才报出（无法与杀软瞬时占用区分）。
- **未回填旧会话的 `ts`**：旧会话在界面上仍不显示时间，直到该会话产生新消息；本版没有批量
  迁移 / 改写任何历史会话文件。
- `rewriteSession` **不为压缩生成的合成摘要补 `ts`**：摘要没有真实发生时间；已有 `ts` 由内存
  对象原样带入，缺失的仍保持缺失。
- **前端本轮未改**（`src/web/app.js` / `index.html`）：`msgTimeText()` 的缺失/非法口径在
  v0.6.22（§3.84）已实现，本版只补后端写入。
- 极端情况下一次同步保存最坏先等 2s 锁预算、再等 2s 写预算后报错（正常路径零开销）；
  未给预算加环境变量/配置项（保持零配置）。
- 本版未改 `src/providers/**`、`src/agent.js`、`presets/**`、`desktop/**`（除版本号）、`ide/**`。

## 五、升级须知

1. 从 v0.6.22 升级是**纯增量**：没有新面板、不改布局，会话列表与对话流照旧。
2. Windows 用户在高并发保存/会话写入时会看到更少「偶发失败」；真权限错误仍会报出原始 errno，
   不会被伪装成锁超时。
3. `ts` 只影响新写入的消息；旧会话不显示时间不是回归，是「不回填历史」的既有口径。
4. 本版不删除任何历史产物；需要回退可继续安装 v0.6.22 / v0.6.21。
