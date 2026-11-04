# MingDao Harness v0.6.32 发布说明

> 状态：**已发布**（tag `v0.6.32`）
> 主题：**v0.7.0 地基第一批：覆盖率口径修正 + 六类状态写入加固 + 请求路径去同步锁**
> 范围：**无新功能**。`v0.6.31..HEAD` 共 8 个提交，改的是"门禁不可信"与"状态会丢"两件地基。
> 影响面：覆盖率数字的口径、六类持久状态的写入安全、Web 请求路径的事件循环阻塞。
> **没有新增用户功能，没有 API 破坏性变更，没有数据格式迁移。**

---

## ⚠ 一、升级须知（先读，四条）

### 1. 覆盖率数字会从 88.7% 掉到 68.3%——这不是退步

旧算法把"该文件所有 `count>0` 的 V8 区间取并集"，而模块外壳（顶层函数体）区间横跨全文——
**文件只要被 import 过，几乎整份都算已覆盖**。现在改为**最内层（叶子）区间**判定：

| 口径 | 旧算法（同一份数据） | **新算法（本版）** | 说明 |
| --- | --- | --- | --- |
| all-lines | 88.7% | **49.7%**（18354/36918） | 分母含空行/纯注释行（保守下界） |
| code-lines | 86.9% | **68.3%**（18354/26854） | **主指标 / 门禁指标** |
| functions | —（未实现） | **87.8%**（1605/1828） | V8 functions，排除模块外壳 |

- **旧算法的 88.7% 已逐位复现**，证明数据集/分母没换，换的只是判定规则。
  上表 68.3% 是**基线**（`HEAD=0dec8aa` 时生成）；发布前在本版树上实测 **68.4%**（18366/26854），
  高于基线 0.1pp（新增套件多跑了 12 行），详见 §六。
- 第三方审计报告写的 63.9 / 70.5 属**另一种锚点约定**（行尾锚点 + 注释计覆盖）；同一份数据用该口径实测
  64.3 / 71.1——**不是数字错，是锚点约定不同**。这一点已写进 `AUDIT §6.1` 与 `DEVELOPER §7.1`。
- 因此：**看到 68.3% 不要当成质量下降**，它是第一次量到真实值。

### 2. `npm run coverage` 从此会"卡住"覆盖率回退

新增 `scripts/coverage-baseline.json`（过渡基线，含生成时间与 node 版本）与 ratchet：
**任一指标低于基线即 exit 1**，容差 **-0.2pp**（只吸收四舍五入，不是允许慢慢降）。
抬升基线必须**显式**执行 `npm run coverage:baseline`（= `--update-baseline`），不允许静默改写。
→ 贡献者新增 `src/` 代码却没补测试时，`npm run coverage` 会红；这是本版想要的效果。

### 3. `smoke §109` 的同步锁守卫改为**别名感知**，新增同步锁必须写理由

旧守卫只 grep 字面量 `withFileLockSync(`；审计 H-05 指出 `import { withFileLockSync as lockFileSync }`
可让"新增即失败"的护栏整份失效——实测本仓已有 **7 个文件、18 处**走别名。
现在解析 `import { … as X }` / `export { … as X }` 后计数，且清单**每条必须写明"为什么它可以同步"**
（必须含 CLI / daemon / 非 web 之一），否则视为未审阅 → CI 红。
→ 如果你在 web 请求路径上新增同步锁，**CI 会拦住你**，请改用 `*Async` 入口。

### 4. 无需迁移，回滚代价低

- 状态文件**格式不变**：`config.json` / `credentials.json` / `model-cache.json` / `endpoint-limits.json`
  仍可被 v0.6.31 读取；新增的只是旁路 `*.lock` 文件（删掉会自动重建）。
- 锁内"重读 + 按字段增量合并"只改变**写入时机**，不改变字段语义。
- 回滚方式：回退 `src/config.js`、`credentials.js`、`model-discovery.js`、`ledger.js`、`net-guard.js`
  即回到旧写入路径，**无需回退用户数据**。

---

## 二、用户可感知变化（三类"最难复现"的毛病）

本版修的三类现象都只在**并发 / 多进程 / 慢盘**下出现；正常单进程使用**看不到差别**。

| 现象（用户视角） | 根因 | 本版修法 | 验证 |
| --- | --- | --- | --- |
| **"我填的 API Key 会自己变回去"** | credentials/config 的读-改-写没有锁：两个进程各读旧快照，后写者覆盖前者；损坏时还静默清空其余凭据 | 锁内**重读 + 按字段增量合并**；`setStoredKey` 遇到损坏库**拒绝写入**（原文件字节不变），严格读报错 | `state-locks ②b`（损坏必须拒写 + 字节不变）、`batch14 ⑦` 变异全中 |
| **"学到的内存预算莫名丢失"** | `model-cache.json` 截断直写（崩溃即半截）+ 无单一入口；`endpoint-limits.json` 无锁 | model-cache 收成**单一读写入口 + 原子替换**；endpoint-limits **锁内按 baseUrl 合并** | `state-locks ③④`（kill -9 注入后文件仍可解析）、16 路并发写不丢 |
| **UI 在慢盘上偶发卡死** | 请求路径用**同步锁**：锁一争用，整个 Node 事件循环停摆（持锁 5s = 页面 5s 无响应） | 14 个真实调用点（schedule / tasks / task-state / sync）+ cachestats / audit 改**异步锁**；同步版只留给 CLI / daemon 并逐处注释 | 持锁 2.3s 时心跳 **0 次 → 22–44 次/4.5s**；`request-path-locks` 9 项 |

> 六条写失败路径（config / credentials / model-cache / endpoint-limits / ledger / egress）现在都会
> 打**可见 warn** 并返回 `{ok:false}`，不再"静默成功"。

---

## 三、开发者可感知变化（口径、脚本与门禁）

| 项 | v0.6.31 | **v0.6.32** |
| --- | --- | --- |
| `npm run coverage` | 只打一行旧格式覆盖率 | **三口径表 + 基线对比 + ratchet**（低于基线 exit 1） |
| `npm run coverage:baseline` | 不存在 | **新增**：显式抬升 `scripts/coverage-baseline.json` |
| 覆盖率算法 | 所有 `count>0` 区间并集 | **最内层（叶子）区间**；跨进程同区间取 **max** |
| "覆盖率最低的 8 个文件" | 按行数降序取末 8 个（= 最小的 8 个文件，标题从未与内容对应） | **按 code-lines 升序**，名副其实 |
| `smoke §109` | 只认字面量 `withFileLockSync(` | **别名感知** + 清单强制写"为什么可以同步" |
| 测试套件 | 23 套 | **26 套**（新增 `state-locks` / `request-path-locks` / `coverage-metric`） |
| 变异总数 | 633 | **669**（新增 batch68/69/70/71，共 4 批 36 条） |
| CI | — | 3 个新套件步骤挂 **Linux 腿**（与既有文件锁套件同口径） |

---

## 四、这一批具体修了什么

### 4.1 §1.2 覆盖率口径（`8406f73`）

- `scripts/coverage-report.mjs` 改判定：行锚点 = 该行**首个非空白代码字符**的偏移，取包含它的
  **最内层区间**，只有该区间 `count>0` 才算覆盖；父区间不再代表子行覆盖。
- 三口径同时输出：**code-lines**（主指标）、**all-lines**（保守下界）、**functions**。
- 跨进程合并：同一区间取 **max**（否则后到的 0 会覆盖先到的 3）。
- 输出**向后兼容**：首行旧格式、"未加载文件"清单、旧标题都保留（发版脚本/文档可能 grep）。
- 新增 `test/coverage-metric.js`（8 项：嵌套/兄弟/整文件函数/未执行函数/纯注释/空文件/
  三口径关系/多进程合并+ratchet）与 `batch68`（7/7 全中）。

### 4.2 §1.3 六类持久状态加锁 / 原子化（`0dec8aa`）

| 状态 | 改动 |
| --- | --- |
| `config.json` | 锁内重读 + 增量合并；`saveConfig` 签名不变，新增异步版供 WebUI |
| `credentials.json` | 同上；`setStoredKey` 对损坏库**拒写**，保留原文件 |
| `model-cache.json` | **单一读写入口 + 原子替换**（临时文件 + rename），崩溃不再半截 |
| `endpoint-limits.json` | 锁内**按 baseUrl 合并** |
| `ledger.jsonl` | `append` 持锁 |
| `egress` 日志 | 追加与轮转**同一把锁**；禁止无锁整文件重写 |

六条失败路径均 `warn` + `{ok:false}`；`state-locks` **10 项**（16 路并发 + `kill -9` 注入）、
`batch69` **10/10**。

### 4.3 §1.4 请求路径同步锁改异步（`7715907` + `6624de8`）

- 18 条文本命中实为 **14 个真实调用点**（另 3 行 import、1 行注释）；逐处判定调用方后迁移：
  `schedule.js`（remove/pause/resume/spawnDaemon + list/add/chain/reconcile）、`tasks.js`
  （patch/reap/list/kill）、`task-state.js`（Web 走 `saveTaskStateMergeAsync`）、`sync.js#commitState`。
- 第二提交补齐 `cachestats`（`recordUsage` / `recordAuxUsage`）与 `audit`（`writeAudit`），
  由 `/api/chat` 的 `onUsage`、回合末补记、titles/memory/routing await 点直达请求路径；
  追加 + 轮转仍同一把锁。
- **实测**：基线（改前）持锁 2.5s → `pauseSchedule` 心跳 **0 次/2334ms**；改后
  `listSchedulesAsync` 等 4548ms、心跳 **44 次**；`pauseScheduleAsync` **24 次**；`listTasksAsync` **22 次**。
- 同步版保留给 CLI / REPL / worker / daemon，并**逐处注释**说明为什么可以同步。
- `request-path-locks` **9 项**（含"Web 路由禁止同步锁"结构守卫）、`batch70` 10/10 + `batch71` 9/9。

### 4.4 §109 守卫别名感知（`6b25fe5`，审计 H-05）

解析 `import { withFileLockSync as X }` / `export { … as X }` 两种形态后计数；清单按当前实际重建
（13 个文件），每条必须写明"为什么它可以同步"（CLI / daemon / 非 web 之一）。
实测注入别名到 `src/models.js` → smoke 立刻红并指名"新增 1 处同步锁（不在已审阅清单内）"；
还原后差异 0 行。

### 4.5 接线与逃逸收口（`b9a5b9e` / `8a3e41c` / `292872d`）

- 3 个新套件进 `run-all`（26 套）与 CI（Linux 腿）；`docs/ROADMAP-v0.7.md` 落盘。
- 可变总数 **633 → 669**（`test/mutate/README.md` 同步）。
- 全量变异 **57/60** 暴露 3 处：1 真逃逸（`setStoredKey` 损坏时宽松读，此前无断言）+
  2 锚点漂移（`spawnDaemon` 缩进 6→4；endpoint-limits 加锁后形态变化）。
  补 `state-locks ②b`（损坏必须拒写 + 原文件字节不变）；顺带发现旧锚点 2 空格命中的是
  **另一处**调用（打错靶），现锚定 `setStoredKey` 内 6 空格形态 + 唯一性判据。
- **Windows 腿修复（首次推送后 CI 暴露，本版内修掉）**：§109 的清单键取自 `path.relative`，
  Windows 上返回 `providers\index.js`，而清单用 `/` 写 → windows 腿 smoke 红
  （文案是"新增 2 处同步锁"，实际两处早已在清单内，属**假红**）。已把键归一化为 `/`。
- **Windows 腿第二处修复（同一轮 CI 暴露）**：`state-locks ③` 用子进程**自我 SIGKILL** 模拟
  "写中崩溃"，但 Windows 没有 POSIX 信号（`TerminateProcess` → `code=1 / signal=null`），
  断言写死 `signal === 'SIGKILL'` → 套件在 Windows 上先红，`batch69 ④–⑩` 被连带判成
  **7 条"逃逸"**（日志里 7 条同样的 `model-cache 子进程必须真的被 SIGKILL 于写中（code=1 signal=null）`）。
  判据已分平台：Windows 要求"非 0 退出 + 未打印 SHOULD-NOT-REACH + stderr 无第一版写失败"，
  Linux/macOS 仍要求 `signal === 'SIGKILL'`；**原子性断言本身一条未放宽**。

---

## 五、未做（明确边界）

- **`src/web/app.js` 仍 0% 覆盖**（2876 行）：viewmodel 抽取是**下一批**（0.7.0 §1.5）；
  本版只让"覆盖率的尺子"变准，没有补 UI 测试。
- **事件溯源未开始**（0.7.0 §1.1：会话事件日志 / SSE 单调 seq）。
- **`docs/ROADMAP-v0.7.md` 里 0.7.1–0.7.3 未动**（工具契约、人机协作、多 agent）。
- 同步锁**并非全部消灭**：CLI / daemon / 独立进程保留同步版（有意，见 §109 清单）。
- 覆盖基线是**过渡基线**（Node 24.20 / macOS 实测）；其他平台数字可能略有差异（±容差内）。
- 未在 Windows 实机手工点验这三类并发场景（由 `state-locks` / `request-path-locks` 的
  真子进程用例 + CI 覆盖；两条 CI 步骤只挂 Linux 腿，与既有文件锁套件同口径）。

---

## 六、验证（发布前门禁实测，tag 前那棵树）

在 `292872d`（本版的代码树）上按 RELEASE-CHECKLIST §1 全量复跑，全部 exit 0：

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | **0 错误** |
| `npm run typecheck:strict` | 当前 **0** 条 / 基线 **0** 条（✅ 未恶化） |
| `node test/smoke.js`（单独跑，私有 `TMPDIR`） | **156 组断言全通过** |
| `node test/run-all.mjs` | **26/26 套通过，0 失败** |
| `node test/mutate/run.mjs` | **60/60 批、669 条全中**（0 逃逸） |
| `node scripts/doc-lint.mjs` | 全绿（⑥ 变异总数：实际 669 = README 669） |
| `node scripts/coverage-report.mjs` | code-lines **68.4%**（18366/26854，基线 68.3，**+0.1pp**）/ all-lines **49.7%**（18366/36918）/ functions **88.0%**（1611/1830，基线 87.8，**+0.2pp**）——ratchet **通过** |
| `node src/cli.js diagnose` | 自检通过，报告已脱敏 |

> 覆盖率实测比基线（`HEAD=0dec8aa` 时生成）高 0.1pp / 0.2pp：新增的三个套件执行了更多
> `src/` 代码行。**基线未改动**（只许升不许降，`68.3 → 68.4` 无需抬基线）。
> 未加载文件 5 个（`src/web/app.js` 0/2876、`src/web/i18n.js`、`src/commands/{desktop,update,workspace}.js`）——
> 这是 `app.js` 仍 0% 覆盖的**如实体现**，不是算法遗漏。

三平台代码、npm 包、官网下载页与 GitHub Release 为同一 tag 产物。

## 七、已知边界

- `coverage` 的"纯注释/空行"判定用**词法启发式**，不解析正则字面量（`/["']/` 这类写法可能误判，
  只影响分类、不影响区间计数）；边界写在 `docs/DEVELOPER.md §7.1`。
- 覆盖率基线是**单点快照**：`--update-baseline` 是"人明确决定抬升"的动作，CI 不会自动抬。
- `request-path-locks` 的结构守卫靠**源码形态匹配**：大重构时可能假红，需同步更新守卫
  （与 §109 同性质，已在变异批次里覆盖）。
- 本版无 UI 改动，桌面端只跟随版本号，安装包内容与 v0.6.31 功能等价。
