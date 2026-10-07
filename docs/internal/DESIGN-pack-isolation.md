# 设计：Pack 执行隔离（审计 M-1：把 `permissions` 从「声明」变成「强制」）

- 状态：**设计稿，待评审**。本文不含任何已落地的实现；引用行号对应本文写作时的工作树（v0.6.10 之后）。
- 关联：审计登记 §3.42 未纳入项「M-1（Pack 能力代理或子进程隔离，需架构改动）」、`docs/PACK-API.md` §2 的 ⚠、
  `SECURITY.md` 已知边界第 2 条「Packs have no isolation」、`docs/internal/CHANGELOG-PACK.md`。
- 约束前提（本文所有取舍都受它支配）：**零运行时依赖**、Node ≥ 18.17、工具调用在**热路径**上、Pack API v1 是
  **已冻结的下游契约**（下游第三方 Pack 已存在）。§6 的实测数字来自本机 macOS + Node v24.20.0，**非**跨平台基准。

---

## 0. 结论先说（TL;DR）

1. **推荐方案 A：长驻子进程 + 换行分隔 JSON-RPC 协议，宿主侧持权限与约束。** 子进程不是"多一层管道"，
   它是本项目唯一能把「超时/挂死/崩溃/权限」四条失败路径收在**一个边界**上的机制——进程内做不到。
2. 子进程**本身不等于沙箱**。真正的强制来自三件套：①子进程 bootstrap 用 `node:module` 的
   CJS `_load` 补丁 + ESM `register()` 钩子把 `node:fs` / `node:net` / `node:child_process` 换成
   受控门面；②Linux 有 bwrap 时追加 `--unshare-net` 等（与 `src/tools/bash.js` 的沙箱档复用同一探测）；
   ③**可选**用 Node 自带 `--permission`（仅 Node ≥ 20/22 可用，见 §7 的诚实边界）。三者缺一，
   强制力就会掉回"诚实声明 + 静态扫描"。
3. **默认拒绝**（deny-by-default），但**不**在同一个版本里切换：`warn` 档先跑一个 minor 收集真实数据，
   再翻成 `enforce`。原因见 §3 —— "一刀切拒绝"会让今天所有第三方 Pack（含仓内 `packs/example-hello`
   与下游 TCM Pack）在升级内核后**直接失效**，那是比现状更坏的结果。
4. 代价是真实的：**冷启动约 20 ms/Pack**（本机实测），每调用多一跳 IPC（实测微秒级，可忽略），
   以及**一个新的协议面**要维护与测试。§6 给量级，§7 给不解决的问题，§9 给分阶段与回滚点。

---

## 1. 问题陈述（今天到底发生了什么）

`mountPacks()` → `loadPack()` 在宿主进程内 `await import(pathToFileURL(entry).href)`
（`src/packs.js:506`），随后 `mod.createPack(makePackCtx(manifest, dir))`（`src/packs.js:515`）
以**完整 Node 权限、同进程、同事件循环**执行。`makePackCtx()` 只给 4 个字段（`src/packs.js:536-543`）。

而 `permissions` 的唯一消费者是 `validateManifest()` 的**形状校验**（`src/packs.js:127-137`：键名限
`fs`/`net`/`env`、值必须是字符串数组），加上一段**正则级静态对照**（`src/packs.js:490-502`）——
它读 `pack.mjs` 源码、剥注释、按 `/\bfetch\s*\(/`、`/\bfs\.(?:readFile|...)/`、`/\bprocess\.env\b/`
猜"用到了哪些能力"，与声明不符就打印一条 `未声明` 告警（`src/packs.js:497-501`），**不阻断**。
文档侧口径已经诚实（`docs/PACK-API.md:131-148`：`permissions` 只是声明；`SECURITY.md:114-116`：
Packs have no isolation），但**一个 Pack 装进来，它在进程内是什么都能做的**。

今天真正的边界只有**信任门**：项目级 Pack 默认不挂载，需 `mingdao pack trust` 记录目录内容指纹、
内容一变即失效（`src/packs.js:257-272`、`316-325`、`570-580`）。这是**"装之前看一眼"**的边界，
不是**"装上之后跑得住"**的边界。两者不可互相替代——后者才是 M-1 要补的。

---

## 2. 威胁模型

### 2.1 今天一个恶意/被投毒的 Pack 能做什么（逐条，带代码位置）

假设它被 `trust` 了（或就是下游自己写的 Pack，或内置 `packs/` 被人改过），它有 `createPack`
与每次 `run(args, toolCtx)` 两条执行窗口；`toolCtx` 就是 agent 的 ctx（`src/agent.js:1044` 把
`ctx` 原样交给 `dispatch`，`src/tools/index.js:500-508` 再交给自定义工具的 `run`）。

1. **读任意文件、包括凭据**。没有任何门面：`import fs from 'node:fs'` 即可读
   `~/.mingdao/credentials.json`（`mingdaoHome()`，默认 `~/.mingdao`）、会话 `~/.mingdao/sessions/*.jsonl`、
   SSH 私钥、患者数据目录。仓内示例自己就在用裸 `fs`（`packs/example-hello/pack.mjs` 读 `ctx.packDir` 下的提示词）。
2. **读敏感环境变量**。`process.env` 直接可见。注意这与 bash 的口径**相反**：`bash`/`hooks`/`MCP`/`config.tools`
   四个子进程入口都过 `buildChildEnv()` 过滤（`src/tools/bash.js:33-41`，段词表与脱敏器共用 `ENV_SECRET_SEGMENTS`），
   **唯一不过滤的执行体就是 Pack 自己**——它是同进程，压根没有 env 可控。于是 `MINGDAO_API_KEY` 对它就是明文。
3. **任意出网外传**。`globalThis.fetch` 可用；`src/net-guard.js` 的出网闸门在**未配置 `config.net` 时根本不安装**，
   且它的已知边界写得很清楚：只覆盖内核自己发起的请求（`src/net-guard.js:10-14`）。Pack 是"内核进程里的
   一等公民"，只要它不走内核出口，闸门与它无关。
4. **反向提权：改运行时对象，让权限引擎失效**。`toolCtx` 里有 `permission`/`cfg`/`io`/`provider`/`spawnTask`
   （`src/agent.js:356-374`）。`permission.check` 只是对象上的一个闭包函数属性（`src/permissions.js:163`），
   一次 `toolCtx.permission.check = async () => true` 就让**本会话后续所有**工具调用自动放行（含 `bash`）；
   同理 `toolCtx.provider.chat(...)` 绕开 `ctx.llm` 的账本与日费用护栏（`src/agent.js:317-335`）、
   `toolCtx.spawnTask(...)`（`src/agent.js:369`）再拿一次工具面、`toolCtx.io.print` 伪造用户可见提示。
   "只读工具自动放行"这类设计在**同进程**前提下对恶意 Pack 毫无约束力。
5. **宿主可用性**：`while(true){}` 冻结整个进程（CLI 卡死、WebUI 全部并发会话一起无响应——本仓 v0.4.1 就为
   `spawnSync` 冻结修过同类问题，见 `src/tools/index.js:331-333`）；未捕获异常/`process.exit()` 直接带走 harness。
   **没有超时能救它**：同进程里没有可用的抢占点。
6. **静态扫描可被轻松绕过**：`未声明` 那段告警读的是源码文本，`await import('node:fs')`、`fs['read'+'FileSync']`、
   `globalThis['fet'+'ch']`、路径拼接全都不进它的正则。它是"让诚实作者看见差距"的工具，**不是**对抗性检测——
   本文不把它当防线，只当迁移期的诊断。

### 2.2 隔离之后**仍然**能做什么（如实）

- 被授予 `net` 的 Pack **仍然可以把数据外传**：它拿到的授权是"能访问 https://dify.example.com"，
  而外传的**内容**（患者 ID、病历片段）内核看不懂也拦不住；想再收窄只能上 DLP/内容审阅，不在本设计范围。
- 被授予某个 `fs` 前缀的 Pack 在那个前缀内**仍可随意读写**（含删除）；被授予 `env` 的变量，值全给它。
- 隔离**不防**"合法能力被滥用"：Pack 的 `run` 返回的 `output` 会进模型上下文、可借此**注入提示词**（这是 Pack
  的合法能力，不是缺陷；防线是约束引擎与人工复核）。
- 子进程内的强制**可以被同进程内的恶意代码拆掉**（§7 第 1 条）：bootstrap 挡住的是"直接 `import node:fs`"这类
  **攻击面最大、成本最低**的路径，不是"有能力写 300 行绕过代码"的对手。
- Pack 之间**互相影响**依然存在（共享 `~/.mingdao` 下的账本/存储/配额）。见 §7。

---

## 3. 方案对比

三个方案都按同一口径评价：**强制力**（非协作方能被挡住吗）、**零依赖可行性**、**热路径代价**、
**契约破坏面**、**失败模式可控性**。

### 方案 A：子进程 + JSON-RPC / stdio 能力协议（推荐）

Pack 的 `pack.mjs` 在一个常驻子进程里跑（`spawn(process.execPath, [bridgePath, packDir])`），宿主与子进程之间走
**换行分隔 JSON** 的请求/响应（与 `src/mcp.js:133-191` 同款传输：零依赖、有 Buffer 上限、有超时、有 `_failAll`）：
- `createPack(ctx)` 在**装载期**执行一次，产出的 `tools`/`constraints`/`promptSections`/`memorySchema` 作为
  **数据**回传并注册（工具名仍是 `pack__<pack>__<tool>`，约束仍由宿主 `constraints.js` 编译——见 §4.2 不变量）；
- 每次工具调用 → `tools/call` → 子进程执行 `run(args, toolCtx)` → 结果回传；宿主负责权限（`src/permissions.js`）、
  审计、账本、约束、结果截断——一行都不挪进子进程；
- 子进程 bootstrap（`--import` 预加载）安装门面：CJS `Module._load` 补丁 + ESM `module.register()` 钩子把
  `node:fs`/`node:fs/promises`/`node:net`/`node:tls`/`node:dgram`/`node:http(s)`/`node:child_process`/
  `node:worker_threads` 换成受控实现，`fetch`/`process.env` 换成门面；并装 `uncaughtException`/
  `unhandledRejection` 兜底（否则子进程挂住不退出，宿主只能干等超时）。

| 维度 | 评价 |
| --- | --- |
| 强制力 | **中→高**。门面挡住直接 `import node:fs`（攻击面最大的一条）；Linux 有 bwrap 时可追加 `--unshare-net` 变成"真断网"；有 Node ≥ 20/22 时可加 `--permission` 再抬一档。macOS/Windows 无廉价 syscall 沙箱，**网络强制降级为门面级**。 |
| 代价 | 每 Pack 一个常驻进程（内存估算 ~30–50MB/个）；冷启动 ~20 ms；**新增一个要长期维护的协议面**；`createPack` 从"同步可用 fs"变成"经 RPC 取数据"（§4.3 给兼容策略）。 |
| 热路径 | 每调用 +1 次 IPC（实测 ~1.6 µs 往返 + JSON 序列化；256KB 结果 ~0.17 ms），相对秒级的模型回答可忽略。 |
| 契约破坏面 | **中**。manifest 与导出面可保持 v1（§4）；破坏点是"Pack 里裸用 `node:fs` 读自己目录"这类**既有习惯**。 |
| 失败模式 | **最好**。超时/挂死 = 杀进程组；崩溃 = `close` 立刻 `_failAll`；退出码异常/输出洪泛 = 有上限可判。全部 fail-closed 且不牵连宿主。 |

### 方案 B：能力代理（宿主内，把 fs/net/env 换成受控门面）

不换进程，只把 `ctx` 从 4 个字段扩成完整门面（`ctx.readJson` / `ctx.writeJsonAtomic` / `ctx.storage` /
`ctx.audit` / `ctx.fetch` / `ctx.secret`——注意这些在 `docs/PACK-API.md:165-173` **已经写成契约**，
但今天 `makePackCtx()` 一个都没实现，属于文档与实现的既有欠账），并在 `createPack` 与 `run` 期间
用一个 `Proxy` 包裹 `toolCtx`，把 `permission`/`provider`/`io`/`spawnTask` 摘掉。

| 维度 | 评价 |
| --- | --- |
| 强制力 | **低（协作式）**。ESM 的 `import fs from 'node:fs'` 拿的是真模块，改 `globalThis` 或给 `ctx`
  加 `Proxy` 都改不了它；`process.env` 也是真对象。所以 B 只能约束**愿意配合的作者**，对投毒 Pack 无效。 |
| 代价 | **低**：实现小、无协议、无进程、无冷启动。 |
| 热路径 | 无额外进程，调用开销 ≈ 0。 |
| 契约破坏面 | 最小（只加字段，不动执行模型）。 |
| 失败模式 | 与今天一样：没有超时、没有隔离、崩溃仍带走宿主。 |
| 结论 | **作为方案 A 的第一阶段是有价值的（门面先到位、契约先补齐）**，但把它当成 M-1 的答复是
  "把声明换个措辞再声明一次"——正是审计报告点名的**失真安全叙事**。**不可单独交付。** |

### 方案 C：`worker_threads` + 受限全局

`new Worker(bridgeUrl)`，bootstrap 改 `globalThis`，宿主与 worker 走 `postMessage`。

| 维度 | 评价 |
| --- | --- |
| 强制力 | **低**。同进程、同 `process`（`process.env` 是真的、`process.exit()` 真能杀宿主、
  `process.binding`/`node:module` 可绕过 global 改写）。 |
| 代价 | 比子进程低：实测 ready ~9.5 ms vs spawn ~20.6 ms；`MessageChannel` 往返 ~1.6 µs。 |
| 热路径 | 略优于 A（省一次进程间管道），但同样要 JSON 序列化。 |
| 失败模式 | **最差**：worker 里 `while(true){}` 照样冻结整个事件循环；`process.exit()` 直接带走宿主；
  内存不隔离。也就是说 C 换来的性能改善，**恰好买不到本项目最需要的两件事**（抢占式超时、崩溃不牵连）。 |
| 结论 | 不推荐做主方案。唯一可能用得上的位置：`createPack` 的装载期（一次性、短），性价比不值。 |

### 推荐与理由

**推荐 A（分两阶段：先 B 的门面补齐，再切 A 的执行模型）。** 三条理由，按重要性排：

1. **A 是唯一能同时解决"权限"与"失败模式"的方案**，而失败模式在本仓有前科：v0.4.1 为 `spawnSync` 冻结
   WebUI 修过（`src/tools/index.js:331-333`）、v0.6.2 为超时不整组清理修过（`src/tools/index.js:365-380`）、
   MCP 子进程异常退出无兜底修过（`src/mcp.js:25-49`）。这些坑的共同形状是**"进程外才有的边界"**。
2. **零依赖下 A 的传输层是现成的**：`src/mcp.js` 已证明"换行 JSON + 超时 + `_failAll` + 进程组回收 + Windows
   不闪黑窗的 `spawnOpts`"可以零依赖、可测、跨平台。A 是**复用**而非新发明。
3. **强制力来自 bootstrap 门面与 OS 沙箱，而不是"子进程"本身**——但必须先有子进程，门面才有意义
   （进程内门面可被 `import` 绕过）。顺序不能反。

反过来，**如果评审认为 M-1 的代价大于收益**（例如本项目真实用户全是自建/自写 Pack、信任门已足够），
我给的替代方案是 **B + 静态扫描 + 把 `permissions` 从契约里降级为"信息性字段"**，
并在 `pack list`/`info`/启动横幅上明确写"本内核不强制 permissions"。这是**诚实的降级**，
代价是放弃"安装第三方 Pack"这条产品叙事（`docs/PACK-API.md` §0 的动机之一）。见 §10。

---

## 4. Pack API v1 兼容策略

### 4.1 manifest：保持 v1，只增不改

- `permissions` 仍是可选对象，仍只接受 `fs`/`net`/`env` 三个键、值仍是字符串数组
  （`src/packs.js:127-137` 的形状校验**不动**）。语义从"声明"升级为"**授权清单**"：
  未列出的能力在执行期被拒。**这是语义变更，需要写进 `docs/PACK-API.md` 与
  `docs/internal/CHANGELOG-PACK.md`，但不改 `apiVersion`**——`apiVersion` 描述的是**协议形态**
  （manifest 字段 + `pack.mjs` 导出面），不是内核的强制策略。
- **新增字段必须同步白名单**：`KNOWN_MANIFEST_FIELDS`（`src/packs.js:41`）是 deny-unknown 的，
  任何新字段（如 `permissionsMode`）漏加就会被判"未知字段"而**整包拒绝**——这是本仓踩过的形状
  （`result-forbid` 只加文档没加集合的漂移，见 `docs/PACK-API.md:37-38` 的注释）。
- Pack 级逃生口：`"permissionsMode": "warn"`（暂缓强制，仅对该 Pack 生效，装载时打印并进
  `pack list` 状态列）。它的存在是**为了迁移**，不是为了让人长期躺在它上面：文档要写明
  "该字段会在 v2 移除"，并在运行足够久后统计它的使用率。

### 4.2 `pack.mjs` 导出面：`createPack(ctx)` 不变，`ctx` 收窄

- 导出面不变：`apiVersion` + `createPack(ctx)`，返回值仍是那个对象（`src/packs.js:510-515` 的校验不动）。
- `ctx` 从今天的 4 个字段（`home`/`packDir`/`packName`/`log`）扩到**契约里已经承诺的那一套**
  （`docs/PACK-API.md:165-173`）：`readJson`/`writeJsonAtomic`/`storage`/`audit`/`llm`/`fetch`/`secret`。
  这是**补欠账**：今天的 Pack 之所以能跑，是因为它绕过 ctx 直接用了裸 `fs`——那正是要收掉的口子。
- **关键不变量（写进测试）**：**约束永远由宿主编译与判定**。Pack 贡献的 `constraints` 只是数据，经
  `validateConstraint()`（`src/packs.js:365-398`）与 `compileConstraints()` 走既有引擎；`constraints`
  表达不了"任意代码"，因此子进程化**不会**给约束引擎制造第二实现（本仓为"同一规则两份实现"栽过两次）。

### 4.3 会真实破掉的两类写法，以及怎么接

1. **装载期裸读自己的文件**（`packs/example-hello/pack.mjs`：`fs.readFileSync(path.join(ctx.packDir, 'prompts/domain.md'))`）。
   隔离后子进程默认只被授予 `packDir` 的**只读**权限，故这类写法**仍可用**——这是有意的（Pack 读自己的资产合理）；
   会被拒的是它去读 `ctx.home` 或任意路径。
2. **`createPack` 里做网络/计算密集型初始化**（如启动时 fetch 业务系统拿字典）：迁移路径是改成 `ctx.fetch`
   （走宿主门面、计入出网账本）或搬进第一次工具调用里按需做。文档给一段 before/after 片段即可，不需要 codemod。

### 4.4 默认拒绝还是默认放行？迁移期怎么办？

**目标态：默认拒绝**（`enforce`）。**迁移期：三档，默认不跳到 enforce**：

| 档位 | 未声明能力的调用 | 用途 |
| --- | --- | --- |
| `off` | 放行，仅现状告警 | 兼容老内核行为（也是**回滚点**） |
| `warn` | **放行**，但写审计 + 启动横幅汇总 + `pack info` 列出"该 Pack 实际用了哪些未声明能力" | 默认一个 minor，用来收集真实数据 |
| `enforce` | **拒绝**，错误文案给出"请在 pack.json 的 permissions 里声明 X 或改用 ctx.*" | 目标态 |

配置：`config.packsPermissions: "warn" | "enforce" | "off"`（默认值随版本推进，见 §10），环境变量
`MINGDAO_PACKS_PERMISSIONS` 覆盖，Pack 级 `permissionsMode` 只能**放宽到 warn**（不能反向收紧别人）。

**为什么不一上来就 enforce**：仓内自身的 `packs/example-hello` 与下游 TCM Pack 都在用裸 `fs`；一刀切会让它们
在升级内核后**整包加载失败**——而 `mountPacks` 的既定哲学是"坏 Pack 只 warn 不阻塞启动"（`src/packs.js:9`），
静默少加载一个领域包在医疗/政务场景是**静默的合规失效**。所以先 warn：让真实用户看到差距并改声明，再翻档。

**弃用节奏**（与 `docs/PACK-API.md` §6 的"窗口 = 最近 2 个 minor"对齐）：

1. `v0.7.x`：门面 + `warn` 默认 + 审计/横幅可见（**零中断**；`permissions` 语义仍按老口径解释）。
2. `v0.8.x`：`enforce` 成为默认；`pack verify` 增加 `--strict-permissions`（下游 CI 可提前对齐）。
3. `v1.0`（或 v2 契约窗口）：`permissionsMode` 移除；`pack verify` **默认**校验"声明与实际一致"（见 §8）。

---

## 5. 失败模式（fail-closed / fail-open 逐条）

先说两个**不可动摇的方向性决定**：

- **权限判定永远在宿主、且永远先于 IPC**：子进程不可能"绕过权限执行"——它没这个机会：请求在进入子进程
  之前就被 `evaluatePermission`（`src/permissions.js:135-154`）与 `checkPreTool`（`src/agent.js:979`）挡过一轮。
  这是把"权限"与"执行"分开的最大收益：**权限不再依赖被授权方的配合**。
- **工具失败的默认方向是 fail-closed（报错、不执行、不假装成功）**；唯一允许 fail-open 的位置是
  **启动期的可观测性**（一个 Pack 挂了不能让整个 harness 不启动：既有哲学 `src/packs.js:9`），但必须**大声**：
  `pack list` 状态、启动横幅、审计事件三处都要能看到"该 Pack 未生效 / 其约束未生效"。

| 情形 | Pack 工具调用 | 约束检查 | 方向与理由 |
| --- | --- | --- | --- |
| 子进程**启动失败**（bootstrap 报错/`spawn` ENOENT） | 该 Pack 的工具**不注册**；模型看不到它们 | 该 Pack 的约束**不生效** | **fail-open（带大声告警）**。约束不生效是危险的，所以必须让"这个 Pack 现在没在保护你"可见；也可加 `config.packsStrict: true` 让"声明了约束却装载失败"变成**启动失败**（受监管场景用）。 |
| 装载期 `createPack` **抛错/超时** | 同上（不注册） | 同上 | 同上；今天的实现也是"加载失败就跳过"（`src/packs.js:596-599`），只是现在**有超时**兜底（今天同步 `createPack` 挂死会冻住启动）。 |
| 调用期**超时**（`tools/call` 无响应） | 杀**整个进程组**，回填 `{ok:false, error, timedOut:true}`，并把该 Pack **标记为 degraded**（后续调用快速失败，不每次等满超时） | 与本调用相关的 Pre 约束已判定过；Post 约束**没有结果可判**（因为结果不存在）→ 不执行 | **fail-closed**。与 `bash` 工具同口径（`src/tools/index.js:377-395` 的 `timedOut`/`exitCode:null` 结果形状）。 |
| 调用期**挂死**（事件循环冻结，进程还在） | 与超时同路径（心跳/请求超时触发），杀进程组 | 同上 | **fail-closed**。这是进程内方案（B/C）做不到的一条。 |
| **退出码异常 / 崩溃**（`close` 事件 code≠0，或 stderr 有栈） | `_failAll(原因)` → 所有在途调用立即 reject → 各自回填错误；下一调用触发**重启**（带退避，连续 N 次失败后停止重启并降级） | 同上 | **fail-closed**。对齐 `src/mcp.js:116-121`：`close` 时 `_failAll`，**绝不静默丢弃在途请求**（丢了会让模型以为工具"没输出"）。 |
| **输出洪泛 / 半截 JSON**（恶意或异常） | 缓冲上限（MCP 用 20MB，Pack 建议 8MB）+ 行解析失败即断开该响应并杀进程；结果大小另有上限（截断并标注，学 `bash` 的 `MAX_OUTPUT` 口径） | 若结果已回传则 Post 约束照常；若被截断/丢弃则**按失败处理**（不把半截结果当完整结果喂给 `completeness` 判定） | **fail-closed**。半截输出当完整结果，是本仓 M-16「提前关流被当正常完成」的同款故障（`docs/internal/AUDIT-v0.6.1-第三方报告登记.md:732`）。 |
| **流式输出中断**（本设计给 Pack 工具加的可选 `progress` 通知） | 宿主保留已收到的部分进度用于 UI，但**最终结果按失败处理**（`{ok:false, error:'输出流中断', partial:...}`） | 同"结果不存在" | **fail-closed**。理由同 M-16：不把"半个回答"当交付。 |
| 宿主退出（正常/异常） | `process.on('exit')` 整组清理（POSIX `process.kill(-pid)`），对齐 `src/mcp.js:25-49` 的退出钩子 | — | SIGKILL 宿主时钩子不执行，子进程可能成孤儿——**如实写进文档**（`src/mcp.js:44-46` 已有同样声明）。 |
| 子进程试图**越权**（调未声明的 `net`/越界 `fs`） | 门面抛错 → 结果 `{ok:false, error:'未声明的能力：net → https://…'}`；写审计 + 账本 | 不涉及 | **fail-closed**，且**错误文案要可操作**（说清改哪里），否则作者只会看到"工具坏了"。 |

---

## 6. 性能（量级估计，附本机实测）

实测环境：macOS（本工作区）、Node v24.20.0。方法：`node -e` 起子进程 / `Worker(eval)` /
`MessageChannel` 空往返 / 256KB JSON 往返，各取 6–8 次的 min/中位：

| 项 | 实测 | 对热路径的意义 |
| --- | --- | --- |
| `spawn(node, ['-e','0'])` + 退出 | 18.6 / **20.6** / 23.9 ms（min/中位/max） | 这是**每次调用起进程**方案的死刑判决：一次 bash 级调用要多付 20 ms。 |
| 子进程：`import pack.mjs` + `createPack` + 1 次工具调用 | 19.8 / **21.3** / 24.4 ms | 说明**冷启动 ≈ spawn 本身**，ESM 加载一个 Pack（~1ms）可忽略。 |
| 同进程：首次 `import` + `createPack` + 调用 | **1.0 ms** | 今天的一次冷启动成本，作为对照。 |
| 同进程：稳态每次调用 | **0.009 ms** | 今天的热路径成本，几乎为零。 |
| `worker_threads` ready + terminate | 9.1 / **9.5** / 11.7 ms | 方案 C 的启动优势（约省一半），但买不到抢占/隔离。 |
| `MessageChannel` 空往返 | **1.6 µs** | IPC 往返**不是**问题；JSON 序列化才是。 |
| 256KB JSON `parse(stringify(x))` | **0.17 ms** | 大结果序列化也在亚毫秒级。 |

结论与设计选择：

- **长驻子进程（每 Pack 一个），不是每次调用起进程。** 首次调用付 ~20 ms（或 **懒启动**：安装时不 spawn，
  第一次真正调用该 Pack 的工具时才 spawn）；之后每调用 ≈ 一跳 IPC + 一次 JSON 序列化（µs–亚 ms 级）。
- **允许空闲回收**：`config.packsIdleMs`（默认 0 = 不回收；桌面版可设 5 分钟）——省内存，代价是下次调用回到
  冷启动。默认不回收的理由：MingDao 的会话是长回合，反复冷启动会稳定吃掉每 Pack 20 ms × N。
- **`test/bench/*`（tokenizer/routing/compaction/cost/savings）不涉及 Pack 调用**，本设计**不改变它们的判据**。
  真正被影响的是"带 Pack 的端到端延迟"：1 个 Pack、1 次工具调用 ≈ +20 ms（首次）/ +0.1 ms（后续），相对
  秒级的模型回合（<1%）。上线时应新增 `test/bench/bench-pack-isolation.mjs`（冷启动、稳态、100 次调用、
  1MB 结果）作为**回归门禁**，防止将来有人把它写成"每次调用起进程"。
- 内存：每个子进程一个 Node 运行时，**~30–50MB RSS**（估算，上线时实测并写回本文档）。10 个 Pack
  ≈ 300–500MB，这是本设计最真实的代价。缓解：懒启动 + 空闲回收 + 只对"声明了代码贡献"的 Pack 起进程
  （纯声明式 Pack 不需要子进程）。

---

## 7. 不解决的问题（明确写出来）

1. **跨平台沙箱差异**。Linux 有 bwrap（`src/tools/bash.js:45-65` 已有能力探测，且探测会走一次最小真实沙箱
   而不是只看 `--version`），macOS/Windows 没有等价物。因此 **`net` 的强制在 macOS/Windows 上只是"门面级"**：
   挡住 `import node:net`/`fetch`，挡不住 `process.binding` 或自己拼一个 native addon（要编译工具链，成本较高但不为 0）。
   文档与 UI 必须**按平台分别措辞**，不能统一写"Pack 无法出网"。
2. **Pack 之间互相影响**。它们共享 `~/.mingdao`（账本、出网日志、存储、调度配额）：A 可以写爆磁盘让 B 失败，
   A 的 `packCost` 与 B 的混在同一账本里（虽有 `pack` 维度可归因）。本设计**不**引入每 Pack 文件系统命名空间
   （那会破坏"共享 home"的既有契约，也让运维更难）。
3. **宿主被攻破后的边界**。本设计防的是"Pack 是恶意的"，不是"宿主进程已被攻破"：子进程挡不住 `ptrace`
   级别的对手（同用户）。
4. **不防内容级外传**（§2.2 第 1 条）。
5. **不解决 Pack 的供应链**：没有签名校验、没有来源固定（`npm:` 来源与离线缓存见 `docs/PACK-API.md` §9
   「仍未定」）。隔离只降低"装上之后"的爆炸半径，不保证"装的是谁"。
6. **不改 MCP / `config.tools` / hooks 的现状**（它们本来就是子进程，且已有各自的门控与 env 过滤）：
   混在一起改会让这次改动的回滚面变得不可控。

---

## 8. `pack verify` 与"声明 vs 实际"的偏差校验

M-1 的另一半是"让下游 CI 能证明声明是真的"。**默认安全**（`pack verify` 的默认路径**绝不执行 Pack 代码**，这是 v0.6.3/H-9 已修的红线，`src/commands/pack.js:2-4`、`135-140`）：

- **默认（静态）**：把今天的正则扫描升级为"**AST-lite 清单**"——零依赖的文本级扫描（不引解析器）覆盖
  `import ... from 'node:fs'` / `require('node:net')` / 动态 `import('node:' + x)` 的**字面量形态**，输出
  "检测到 fs（3 处）、net（1 处）vs 声明 fs/net ✓"。**它是诊断，不是保证**，输出里必须带这句（否则又是一次失真叙事）；
  `--strict-permissions` 时把"检测到未声明"当**失败**。
- **`--runtime --isolated`（会执行，需显式）**：在**隔离子进程**里执行 `createPack`，并把**每个工具各调一次**
  （用 manifest 里的 `samples`，或空参数 + 明确允许失败），记录**实际被拦下的能力请求**，输出"声明了 X，
  实际请求了 X ∪ Y"。这是唯一能给出**真实**偏差的路径，而它之所以安全，正因为 M-1 先落地了——**两者互为前提**。

---

## 9. 测试策略（含"把隔离去掉必须变红"的变异验证）

现有 Pack 测试在 `test/smoke.js` 第 57 节（`listPacks` 发现 `example-hello`、`mountPacks` 挂载、
工具名 `pack__example-hello__count_lines`、约束与提示词段带 pack 归属、坏 Pack 不阻塞启动、
`未声明` lint 告警、预算、kind 集合单一来源）——**这些断言必须继续成立**，方式如下：

1. **进程内假 worker（fake bridge）**：协议层先落地，实现为一个**在同进程内**扮演子进程的模块（同一个
   JSON-RPC 接口，`post`/`on` 可注入）。`test/smoke.js` 与 `test/mutate/*` 默认注入它，于是**现有 Pack
   测试全部原样通过**且不引入 20 ms × N 的启动抖动；真实 `spawn` 路径由 `test/e2e-pack-isolation.js` 覆盖。
2. **能力门禁的行为断言**（每条都要能在 fake 与真子进程两种模式下跑）：
   - 未声明 `fs` 的 Pack 读 `~/.mingdao/credentials.json` → 返回 `ok:false`，错误文案含"未声明的能力"与
     `permissions.fs`；**且文件内容不出现在结果里**（断言负向内容，不只断言 ok:false）。
   - 未声明 `net` 的 `fetch('https://example.com')` → 被拦；声明 `net: ["https://example.com"]` 后访问
     `https://other.example.com` → 仍被拦（白名单语义，不是开关语义）。
   - 未声明 `env` 的 Pack 读 `process.env.MINGDAO_API_KEY` → `undefined`（**断言值形态**，不是"抛错"）。
   - `createPack` 里 `while(true){}` → 装载在 ≤N 秒后失败，**宿主仍能继续启动并挂载其余 Pack**（`src/packs.js:9`）。
   - 工具 `run` 里 `while(true){}` → 超时、进程组被杀、结果 `timedOut:true`，**且下一次调用快速失败**（degraded 生效）。
   - 子进程 `process.exit(1)` / 半截 JSON / 灌 100MB → 三种都在 1 次调用内返回错误，宿主存活、其余 Pack 不受影响。
3. **权限不可被绕过的断言**：Pack 在 `run` 里尝试改 `toolCtx.permission.check` → 断言**它拿不到 `permission`
   字段**（子进程化后 ctx 由宿主裁剪），且随后一次 `bash` 调用**仍然被问/被拒**（端到端行为断言，
   而不是"ctx 是只读的"这种结构断言）。
4. **变异验证**（`test/mutate/`，与既有批次同格式，新增 `batch23-pack-isolation.mjs`）——每条都要求
   "**把隔离去掉，断言当场变红**"：
   - 把 bootstrap 的 `node:fs` 门面改回原模块 → 期望 `permissions.fs` 那条断言红。
   - 把 `tools/call` 的超时改成 `0`（永不超时）→ 期望"挂死被中止"那条红。
   - `close` 事件里删掉 `_failAll` → 期望"崩溃时在途调用被 reject"那条红。
   - 把默认档从 `enforce` 改回 `off` → 期望"未声明 fs 被拒"那条红。
   - 让宿主把 `permission.check` 挪进子进程执行 → 期望"改 permission 不能提权"那条红。
   - 把"未声明 → 拒绝"改成"未声明 → 放行 + 告警" → 期望同一批里至少两条红（**方向性变异**：防止
     "降级为 warn"被当成实现细节悄悄改掉）。
   注意既有教训：变异点必须是**唯一**文本锚点，且 `expect` 关键词要与失败信息逐字对齐（`test/mutate/lib.mjs:117-141`）。

---

## 10. 分阶段落地计划（交付物 / 门禁 / 回滚点）

| 阶段 | 交付物 | 门禁（必须全绿才算完） | 回滚点 |
| --- | --- | --- | --- |
| **P0 门面 + 契约补齐**（无执行模型变更） | `makePackCtx` 实现 `readJson`/`writeJsonAtomic`/`storage`/`audit`/`fetch`/`secret`；`toolCtx` 裁剪掉 `permission`/`provider`/`spawnTask`/`io`（改用 `ctx.log`/`ctx.audit`）；`docs/PACK-API.md` 同步 | 现有 Pack 测试全绿；新增"Pack 拿不到 permission/provider"断言；`example-hello` 与 TCM Pack **不改一行**仍能跑 | 单文件回退 `src/packs.js` + `src/agent.js`（无协议、无子进程、无状态迁移） |
| **P1 协议 + fake bridge** | `src/pack-bridge.js`（宿主侧）与 `src/pack-worker.js`（子进程侧 bootstrap）；`tools/call`/`tools/list`/`ping` 三个方法；`warn` 档 + 审计 + `pack list/info` 的"实际能力"列 | 全部现有测试与变异批次全绿（fake bridge 下）；新增 §9.2 的能力断言在 fake 模式下绿；`bench-pack-isolation.mjs` 建立基线 | `config.packsIsolation=false` 一键回到 P0（进程内直跑） |
| **P2 真子进程 + 强制** | 默认 `spawn`；懒启动 + 空闲回收 + degraded/重启退避；`config.packsPermissions` 三档；`pack verify --strict-permissions` | §9.2 全部断言在**真子进程**模式下绿；§9.4 的 `batch23` 变异全中；Windows/macOS/Linux 三腿 CI 绿（Windows 用 `spawnOpts({piped:true})`，见 `src/proc.js:134-144`）；冷启动/稳态/内存三个数字写回本文档 | `packsPermissions=off` + `packsIsolation=false`；**回滚不需要改 Pack**（这是把档位做成配置而不是一次性切换的全部理由） |
| **P3 默认 enforce + 弃用节奏** | `enforce` 默认；`permissionsMode` 使用率统计；文档与 `SECURITY.md`/`PACK-API.md` ⚠ 段落同步改写；迁移指南（before/after） | 下游 TCM Pack 的迁移 issue 已闭环；`未声明` 告警在真实用户目录上归零（或全部走显式 `permissionsMode: "warn"`）；发布说明写明行为变更 | 把默认值改回 `warn` 发一个 patch 版本（**必须能在一个 patch 内回退**，所以默认值只在一处定义） |

---

## 11. 我建议的实现顺序 + 最难的三个取舍

### 实现顺序（按依赖，不按价值）

1. **先做 P0 的 ctx 裁剪与门面补齐**：它今天就能交付独立价值（堵住 §2.1 第 4 条的**提权**路径，补上
   `docs/PACK-API.md` 已承诺却未实现的 API），且**零新概念**、可单文件回滚。
2. **再把约束/权限的执行点钉死在宿主**（写进测试的不变量）。这是后面所有工作的前提：如果约束有可能跑在
   子进程里，子进程一挂就等于红线消失。
3. **然后做协议 + fake bridge**，让全部既有测试在不 spawn 的情况下重跑一遍——协议的错误会先在"无进程"
   环境里暴露，而不是在 CI 的进程管理噪声里。
4. **再切真子进程，默认档仍是 `warn`**：让它在真实用户机器上跑一个 minor，收集"谁在用裸 fs/net"的真实数据
   （今天只有仓内一个示例，样本远远不够）。
5. **最后翻 `enforce`**，把 `pack verify --strict-permissions` 接进下游 CI 模板，并把 `--runtime --isolated`
   作为"验证声明与实际一致"的正式手段。
6. 全程：每个阶段都要有**变异验证条目**（§9.4）。没有"掉隔离即变红"的条目，这个特性等于没做。

### 最难的三个取舍

1. **强制力 vs 兼容性（默认值放在哪一档）**。`enforce` 默认是唯一诚实的默认值，但它会让今天所有用裸
   `fs`/`fetch` 的第三方 Pack 在升级后**加载失败**——在医疗/政务场景里"领域包静默少加载"可能比
   "Pack 能读全盘"更危险（红线消失且没人知道）。**结论：先 `warn` 一个 minor，用真实数据换信心再翻档**；
   代价是这一个 minor 里 `permissions` 仍是"半声明"，所以启动横幅与 `pack info` 必须说得比今天更响。
2. **子进程边界 vs 热路径与内存**。长驻子进程是唯一能拿到超时/挂死/崩溃隔离的方案，代价是每 Pack 一个
   Node 进程（估算 30–50MB）与首次 ~20 ms。**结论：懒启动 + 默认不回收 + 只对"声明了代码贡献"的 Pack
   起进程**；绝不接受"每次调用起进程"（那是把 20 ms 稳定塞进热路径）。
3. **"进程内门面"能不能单独算数（即：能不能不换进程）**。它是本设计里最容易妥协的一项：方案 B 便宜、
   无协议、无感，但它**对不配合的作者零强制力**——而 M-1 的全部意义正是"把声明变成强制"。
   **结论：B 只能作为 A 的前置阶段，不能作为 M-1 的答复**；若评审最终判定不改执行模型，正确做法是
   **把 `permissions` 从契约里降级为信息性字段**、在文档与 UI 里明确"本内核不强制"，而不是保留
   "最小权限"的措辞——**失真的安全叙事比没有声明更危险**（`docs/PACK-API.md:138` 原话）。

### 如果判断"不该做这一步"

**有理由**：如果本项目采纳的 Pack 来源全部是自建或已人工审过的第一方（信任门 + 静态对照够用），
那么 A 的代价（新协议面 + 每 Pack 一个进程 + 跨平台差异的长期文档债）确实可能大于收益。
**我会建议的替代方案**（最小代价、不撒谎）：① 落地 P0（ctx 裁剪——它单独就堵掉了"反向提权"，
且不破坏任何契约）；② `enforce` 只对**声明了 `permissions` 的 Pack** 生效，未声明的继续 warn；
③ 把 `permissions` 在文档与 `pack list/info` 里**明确降级为信息性字段**，删掉"最小权限/越出即拒绝"的措辞；
④ 把 `pack verify --runtime --isolated` 的**隔离子进程只用于 CI 验证**（一次性、不常驻、不碰热路径）——
用 20 ms 的 CI 成本换"声明与实际一致"的证明。这样 M-1 的**证据部分**能交付，**边界部分**明确记为不做，
并让它在 `SECURITY.md` 的已知边界里可见。
