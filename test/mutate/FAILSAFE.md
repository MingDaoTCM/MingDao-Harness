# 变异验证的 fail-safe（v0.6.17；互斥锁 v0.6.18 改为跨 worktree 全局锁）

> 一句话：`mutate()` 写补丁前先落**持久标记**，进程退出/信号时清理锁并还原在途补丁；
> 开跑前自检能**自动还原**"上次被强杀留下的补丁"，遇到"被第三方改过"的文件则**拒绝运行**。
> 互斥是**全局**的（`os.tmpdir()/mingdao-mutate.lock/`）：两个 worktree 同时跑也只有一个能进。

## 为什么需要它（两次事故）

1. **在飞被误报成残留**：一条扫描线看到工作树里有"看起来像缺陷"的文本，就把它当残留处理，
   而当时变异正在跑——差点把正在验证的补丁写回错的内容。根因是"在飞"与"残留"没有可区分的凭据。
2. **强杀后补丁留在工作树**：`mutate()` 的还原在 `finally` 里，`Ctrl-C` / 超时 `kill -9` 时
   `finally` **不执行**，补丁留在 `src/**` 里，git 看起来像"有意改动"，曾差点把"停止键失效"
   当成正常改动发进版本。

还有一类事故促成了 v0.6.18 的全局锁：**并行 worktree 的互斥靠人肉协议**。两道路各在自己的
worktree 里跑 `run.mjs`，锁却在各自的 `.generated/` 下，等于没有互斥——固定端口 45997/45998
冲突，§145 的时序断言在负载下"逃逸"、假红。临时用 `/tmp/mdh-mutate.lockdir` + `mkdir` 协调时，
陈旧判据又只看"进程在不在"：从 `mkdir` 到 node 真正跑起来有几秒空窗，结果把活锁删掉，两道都
以为自己持锁。**互斥必须做进工具本身**，这就是下面这把锁。

## 机制

| 东西 | 位置 | 作用 |
| --- | --- | --- |
| `pending/<hash>.json` | `test/mutate/.generated/`（已 gitignore） | 每次变异写补丁**之前**落的持久标记：`file` / `from` / `to` / `pid` / `startedAt`，另存原始字节 `originalRaw` 与补丁全文 `patched`（自愈靠内容判据，不靠猜文本） |
| **全局锁目录** | `os.tmpdir()/mingdao-mutate.lock/` | 互斥锁：`owner.json` 记 `pid` / `startedAt` / `cwd`（被变异的 **worktree 根**）/ `argv` / `host`。原子创建靠 `mkdirSync`；同一时刻只有一个进程能持锁 |
| `mutate.journal` | `test/mutate/.generated/` | JSONL 事件流：`lock-acquired` / `lock-refused` / `lock-stale` / `start`（变异进行中）/ `restore`（已还原）/ `heal` / `abort` …… 让日志能区分"在飞"与"残留" |

变异期间 stdout 也会落两行，便于在 CI 日志里直接看出在飞状态：

```
变异进行中：src/ssrf-guard.js（pid 1234，标记 test/mutate/.generated/pending/8b8b990a5aa4afaa.json）
已还原：src/ssrf-guard.js
```

## 互斥（跨 worktree 全局锁）

### 路径与内容

```text
os.tmpdir()/mingdao-mutate.lock/
├── owner.json        # { pid, startedAt, cwd, argv, host, v:2 }
└── owner.<pid>.tmp   # 仅写锁瞬间存在（先写临时文件再 rename）
```

- `cwd` 是**被变异的 worktree 根**（不是进程当前目录），报错时直接告诉你"哪一道在跑"。
- 锁目录本身**不放在任何 worktree 里**：放进 `.generated/` 就会变成每个 worktree 一把锁，
  这正是 v0.6.17 的漏洞。
- `MINGDAO_MUTATE_LOCK_DIR` 只给 `selfcheck.mjs` 隔离测试用，正常跑不要设置。

### 抢锁规则

| 锁目录状态 | 行为 |
| --- | --- |
| 不存在 | `mkdirSync` 原子创建，写入 `owner.json`，**持锁** |
| 已是自己（`owner.pid === 本进程 pid`） | **幂等放行**（同一进程重复 `acquireLock` 不会自锁；引用计数归零才真正释放） |
| 存在，`pid` 仍存活 | **拒绝运行**：「已有 mutator 在跑（pid N，cwd X，已运行 Ys）」 |
| 存在，`pid` 已不在，但锁 mtime **≤ 15 分钟** | **拒绝运行，不接管**（见下：防 mkdir→node 空窗） |
| 存在，`pid` 已不在，且锁 mtime **> 15 分钟** | **判陈旧**：先拿 `.takeover` 令牌，把整个锁目录 `rename` 成唯一 tombstone 再删，重建后接管 |
| 存在，`owner.json` 还读不到，锁很新 | **拒绝运行，不接管**（`mkdir` 成功、owner 尚未落盘的几毫秒；这同样是空窗） |

**陈旧判据必须两个条件同时满足**：① 锁里的 pid 已不在；② 锁目录 mtime 超过 15 分钟。
只看 ① 是错的——`mkdir` 到 node 启动之间进程可能还没写 pid，"看到进程不在就删锁"会把活锁删掉，
两道都以为自己持锁（今天两次事故的共同根因）。两个条件都满足时也不用裸删：先拿 `.takeover`
令牌串行化，再 `rename` 整个目录（原子）后重建，避免两个进程同时判陈旧、同时删。

### 被拒时的提示

活锁（最常见）：

```text
✗ 已有 mutator 在跑（pid 42317，cwd /Users/rockie/AI/DeepSeek-harness-Space/MingDao-Harness-mutate-lock，已运行 42s）；锁目录：/var/folders/.../T/mingdao-mutate.lock。它正在跑：等它结束，或确认该 pid 不是 mutator 后再手工解锁。
```

死 pid 但锁很新（**不接管**，防空窗）：

```text
✗ 已有 mutator 在跑（pid 42299，cwd /Users/.../MingDao-Harness，已运行 3s）；锁目录：/var/folders/.../T/mingdao-mutate.lock。该 pid 当前不在，但锁的 mtime 只有 3s（未超过 15 分钟）——可能正处在 mkdir→node 启动的空窗，按"不接管"处理；确认无人在跑后再手工解锁（见 test/mutate/FAILSAFE.md）。
```

空窗里 owner 还没落盘：

```text
✗ 已有 mutator 在跑（pid 未知，cwd 未知（owner 尚未落盘），已运行 0s）；锁目录：/var/folders/.../T/mingdao-mutate.lock。锁内容还读不到（可能刚 mkdir、owner 尚未落盘）——按"不接管"处理，稍后重试；确认无人在跑后再手工解锁（见 test/mutate/FAILSAFE.md）。
```

### 如何手工解锁

**先看 owner，再决定删不删**（别重复今天那个错误）：

```bash
LOCK="$(node -p 'require("os").tmpdir()')/mingdao-mutate.lock"
cat "$LOCK/owner.json"                 # pid / cwd / startedAt / argv
ps -p <pid> -o pid,etime,command       # pid 还在？在就别删

# 只有确认 pid 不在、且不是正在启动的 mutator 时才删：
rm -rf "$LOCK" "$LOCK".takeover "$LOCK".stale-*
```

`check.mjs` 是**显式自愈入口**：锁里的 pid 已死时它允许立即接管（否则 SIGKILL 后要等 15 分钟
才能清残留补丁）。它仍然**绝不**接管 pid 存活、或 owner 还读不到的锁；`run.mjs` 永远走严格两条件。
所以强杀后的标准动作是：先 `node test/mutate/check.mjs`（自愈 + 清锁），再跑 `run.mjs`。

## 怎么用

```bash
node test/mutate/check.mjs                 # 只做开跑前自检（扫描 + 自愈 / 拒绝）
node test/mutate/check.mjs --allow-dirty   # 允许在脏工作树（src/**、test/**）上跑
node test/mutate/run.mjs                   # 全批次（启动时自动跑一遍 check）
node test/mutate/run.mjs batch12           # 只跑某一批
node test/mutate/selfcheck.mjs             # fail-safe 自验：14 个场景（见下）
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

自验用临时目录复制同一份 `lib.mjs` / `check.mjs` / `run.mjs` 来模拟整棵树，不碰真实工作树；
锁目录用 `MINGDAO_MUTATE_LOCK_DIR` 指向独立的临时路径。共 14 个场景：

1. 干净启动：check 退出 0，无标记、无锁残留；
2. **模拟残留**（手工写标记 + 把文件改成 `to`）→ check 自动还原，打印「已自愈 1 处残留变异」；
3. **模拟冲突**（文件被改成第三方内容）→ check 拒绝、打印清单，标记保留；
4. 在飞不被误治（标记 pid 存活）→ check 拒绝，文件与标记都不动；
5. 并发互斥（活锁）→ 第二个 mutator 被拒：「已有 mutator 在跑（pid N）」；
6. 脏工作树 → 默认拒绝并给清单，`--allow-dirty` 放行；
7. **SIGTERM**（可捕获）→ 在途补丁还原、标记与锁清掉，退出 143；
8. **SIGKILL**（捕获不到）→ 补丁 + 标记 + 陈旧锁**留下**（这就是"残留"），下一次 `check` 自愈并清陈旧锁；
9. **同进程重复获取** → 幂等；引用计数归零才真正释放；
10. **另一进程持锁**（sleep 子进程 + 锁）→ 第二个 `run.mjs` 被拒，提示含 pid 与 cwd；
11. **陈旧锁**（不存在的 pid + `utimes` 把 mtime 拨到 20 分钟前）→ 接管并清理；
12. **锁很新、pid 已死** → **不接管**（mkdir→node 空窗的回归；今天踩过的坑）；
13. **SIGTERM 打在 `run.mjs` 上** → 全局锁被释放；
14. **两个 worktree 目录同时跑 `run.mjs`** → 只有一个进入，另一个的提示指出胜者 cwd。

`SIGKILL` 无法被任何 `process.once` 捕获——所以它不靠"退出时清理"，而靠持久标记 + 下一次
`check`（`run.mjs` 启动时、以及每批之间都会跑）。场景 ⑧ 就是照这个路径断言的；场景 ⑪⑫ 则把
"什么时候能接管陈旧锁"钉死成可回归的用例。

## 边界（如实登记，不假装兜住）

- **SIGKILL 期间没有任何代码能执行**：在途补丁一定先留在工作树里，直到下一次 `check` / `run.mjs`。
  如果这期间有人 `git commit -a`，仍可能把补丁当"有意改动"提交——所以 `run.mjs` 会在每批之间
  自检，且**不要把变异和提交放在同一条流水线上**。
- **强杀后的 15 分钟**：`run.mjs` 不会接管"pid 已死但锁很新"的锁（防 mkdir→node 空窗）。
  需要立刻继续时先跑 `node test/mutate/check.mjs`（显式自愈入口，可立即接管死 pid 的锁），
  或按上面的"如何手工解锁"确认后删锁。
- **Node 信号派发的边界**：进程阻塞在 `spawnSync` 里、且脚本结束时**没有任何活动句柄**时，排队的
  信号回调可能不被派发（进程正常退出 0）。此时 `finally` 已还原、`process.on('exit')` 仍会清锁；
  不会留下"锁 + 补丁"。selfcheck 的 ⑦ 用保活句柄确定性地验证 `process.once` 路径。
- **pid 复用**：锁/标记里的 `pid` 被系统回收给无关进程时会误判为"在跑"（安全侧，拒绝运行）。
  输出里带 `cwd` / `startedAt` / 锁目录；确认那个 pid 不是 mutator 后再手工解锁或删标记。
- **不是分布式锁**：只在本机 `os.tmpdir()` 上互斥。多台机器/多个容器共享同一个工作树仍会并发，
  那需要文件系统级锁或 CI 并发组（未做）。
- 标记存了原文与补丁全文（便于字节级还原），单个标记可能到数百 KB；它在还原成功后立即删除，
  只在被强杀时短暂留下。
- 本机制只保护 `test/mutate/*` 自己改写的文件；它不阻止你手工改 `src/**`（那属于脏工作树检查的范围）。
