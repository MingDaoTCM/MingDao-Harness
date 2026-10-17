# 变异验证的 fail-safe（v0.6.17）

> 一句话：`mutate()` 写补丁前先落**持久标记**，进程退出/信号时清理锁并还原在途补丁；
> 开跑前自检能**自动还原**"上次被强杀留下的补丁"，遇到"被第三方改过"的文件则**拒绝运行**。

## 为什么需要它（两次事故）

1. **在飞被误报成残留**：一条扫描线看到工作树里有"看起来像缺陷"的文本，就把它当残留处理，
   而当时变异正在跑——差点把正在验证的补丁写回错的内容。根因是"在飞"与"残留"没有可区分的凭据。
2. **强杀后补丁留在工作树**：`mutate()` 的还原在 `finally` 里，`Ctrl-C` / 超时 `kill -9` 时
   `finally` **不执行**，补丁留在 `src/**` 里，git 看起来像"有意改动"，曾差点把"停止键失效"
   当成正常改动发进版本。

## 机制（三件东西，都在 `test/mutate/.generated/`，已 gitignore）

| 文件 | 作用 |
| --- | --- |
| `pending/<hash>.json` | 每次变异写补丁**之前**落的持久标记：`file` / `from` / `to` / `pid` / `startedAt`，另存原始字节 `originalRaw` 与补丁全文 `patched`（自愈靠内容判据，不靠猜文本） |
| `mutate.lock` | 互斥锁（`pid` + 启动时间）。第二个 mutator 启动即拒绝：「已有 mutator 在跑（pid N）」；持有者已死的陈旧锁会被自动清理 |
| `mutate.journal` | JSONL 事件流：`lock-acquired` / `start`（变异进行中）/ `restore`（已还原）/ `heal` / `abort` …… 让日志能区分"在飞"与"残留" |

变异期间 stdout 也会落两行，便于在 CI 日志里直接看出在飞状态：

```
变异进行中：src/ssrf-guard.js（pid 1234，标记 test/mutate/.generated/pending/8b8b990a5aa4afaa.json）
已还原：src/ssrf-guard.js
```

## 怎么用

```bash
node test/mutate/check.mjs                 # 只做开跑前自检（扫描 + 自愈 / 拒绝）
node test/mutate/check.mjs --allow-dirty   # 允许在脏工作树（src/**、test/**）上跑
node test/mutate/run.mjs                   # 全批次（启动时自动跑一遍 check）
node test/mutate/run.mjs batch12           # 只跑某一批
node test/mutate/selfcheck.mjs             # fail-safe 自验：8 个场景（见下）
```

`check.mjs` 的三种结论：

| 工作树状态 | 结论 |
| --- | --- |
| 文件仍等于标记里的 `patched`（我们写下的补丁） | **自动还原成 `originalRaw`**（字节级，Windows 上就是 CRLF 原样），打印「已自愈 1 处残留变异」，删除标记，退出 0 |
| 文件既不是 `patched` 也不是 `originalRaw`（被第三方改过） | **拒绝运行**，列出冲突文件、指纹与标记路径，退出 1；标记**保留**等人工判断 |
| 标记里的 `pid` 还活着 | 视为"**在飞**"，**绝不触碰**，拒绝运行并提示先确认该进程（事故①的回归） |

脏工作树（`src/**`、`test/**` 的未提交改动，`test/mutate/` 自身除外）默认**拒绝运行**：
变异会把文件改写成补丁再写回，脏改动一旦被碰过就无法区分"用户的有意改动"与"残留变异"。
确认无碍后加 `--allow-dirty` 显式放行，它只放行、不会回滚你的改动。

## 强杀模拟（`node test/mutate/selfcheck.mjs`）

自验用临时目录复制同一份 `lib.mjs` / `check.mjs` 来模拟整棵树，不碰真实工作树；8 个场景：

1. 干净启动：check 退出 0，无标记、无锁残留；
2. **模拟残留**（手工写标记 + 把文件改成 `to`）→ check 自动还原，打印「已自愈 1 处残留变异」；
3. **模拟冲突**（文件被改成第三方内容）→ check 拒绝、打印清单，标记保留；
4. 在飞不被误治（标记 pid 存活）→ check 拒绝，文件与标记都不动；
5. 并发互斥（活锁）→ 第二个 mutator 被拒：「已有 mutator 在跑（pid N）」；
6. 脏工作树 → 默认拒绝并给清单，`--allow-dirty` 放行；
7. **SIGTERM**（可捕获）→ 在途补丁还原、标记与锁清掉，退出 143；
8. **SIGKILL**（捕获不到）→ 补丁 + 标记 + 陈旧锁**留下**（这就是"残留"），下一次 `check` 自愈并清陈旧锁。

`SIGKILL` 无法被任何 `process.once` 捕获——所以它不靠"退出时清理"，而靠持久标记 + 下一次
`check`（`run.mjs` 启动时、以及每批之间都会跑）。场景 ⑧ 就是照这个路径断言的。

## 边界（如实登记，不假装兜住）

- **SIGKILL 期间没有任何代码能执行**：在途补丁一定先留在工作树里，直到下一次 `check` / `run.mjs`。
  如果这期间有人 `git commit -a`，仍可能把补丁当"有意改动"提交——所以 `run.mjs` 会在每批之间
  自检，且**不要把变异和提交放在同一条流水线上**。
- **Node 信号派发的边界**：进程阻塞在 `spawnSync` 里、且脚本结束时**没有任何活动句柄**时，排队的
  信号回调可能不被派发（进程正常退出 0）。此时 `finally` 已还原、`process.on('exit')` 仍会清锁；
  不会留下"锁 + 补丁"。selfcheck 的 ⑦ 用保活句柄确定性地验证 `process.once` 路径。
- **pid 复用**：标记里的 `pid` 被系统回收给无关进程时会误判为"在飞"（安全侧，拒绝运行）。
  输出里带 `startedAt` 与标记路径；确认那个 pid 不是 mutator 后再人工删标记。
- **跨 worktree 不互斥**：锁是每个工作树自己的 `.generated/mutate.lock`。并行跑多个 worktree
  仍可能同时变异，跑之前先 `pgrep -f "test/mutate"` 确认。
- 标记存了原文与补丁全文（便于字节级还原），单个标记可能到数百 KB；它在还原成功后立即删除，
  只在被强杀时短暂留下。
- 本机制只保护 `test/mutate/*` 自己改写的文件；它不阻止你手工改 `src/**`（那属于脏工作树检查的范围）。
