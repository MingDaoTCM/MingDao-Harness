# 更新日志（Changelog）

本项目自 v0.1.69 起维护变更日志；此前版本（0.1.0–0.1.68）的演进见 docs/QA-REPORT.md 与 git 历史。


## v0.6.4（2026-09-21）— 第三方审计九批收口（凭据 / fail-open / 合规空转 / 数据损失 / Web / 供应链 / 并发 / 计费）

> 这一版**不掺新功能**：内容是 v0.6.1 三份第三方审计报告与 v0.6.2 自审报告的**收口修复**（九批）。
> v0.6.3 发布说明「已知边界」里列的那批条目，大部分在本版处理掉了。
> 每批都按「**先复现 → 再定级 → 修复 → 回归断言 → 变异验证断言本身**」推进；
> 复现记录、被推翻的报告结论与自我更正逐条写在 `docs/AUDIT-v0.6.1-第三方报告登记.md`（§3.28–§3.35）。

### 一、凭据暴露面（批一）

- **凭证库损坏后静默清空其余凭据**（实测复现，本批最严重）：`loadCredentials()` 把「文件不存在」
  与「解析失败」都当成 `{}`，而 key 的写路径是「读 → 改一条 → 全量重写」——截断一个字符后再
  `key set`，**其余凭据全部消失且打印成功**。新增严格读取（区分 ENOENT 与损坏，并容错
  PowerShell 写的 BOM：那是可解析的，不该被当成损坏而永久拒绝写入）；三个写路径读不出来即
  **拒绝写**并退非 0，原文件原样保留供人工抢救。
- **会话/记忆/任务文件 0644 且正文含明文密钥**（同仓账本/审计/凭据早已 0600，同模块两套口径）：
  新增 `appendFilePrivateSync` / `atomicWritePrivateSync`（创建即 0600 + **每次写补 chmod 自愈**，
  因为 mode 只在创建时生效），落到 session / memory / cachestats / workspace / session-index /
  schedule / tasks / ledger 共 10 处；相关目录补 0700。
- **会话原文不脱敏就上传云同步**（自动同步默认开启，粘贴过的密钥会明文上传）：
  推送前过 `redactSecrets`——本地文件保持原样，远端与其它设备只拿掩码版；
  并把「上传前已脱敏」的会话数告诉 CLI 与 WebUI。
- **脱敏器自身漏了 PEM / JWT / 赋值式**（不补上，上面两条就是虚假安全感）：赋值式改为
  **按名字分段判定**（`_`/`-` 分段后任一段是密钥词即掩码），覆盖 `AWS_SECRET_ACCESS_KEY=`、
  `MY_TOKEN_V2=`、`x-api-key:`；补 PEM 私钥块、JWT、GitLab `glpat-`；同时反向断言「不误伤」
  （普通中文、`max_tokens: 4096`、JSON 配置、`monkey=` 一律不动，`Bearer <token>` 只掩 token）。
- **自建 registry 允许明文 http**：索引里的 sha256 与正文**同源自证**，TLS 是这条链上唯一的
  外部信任锚 → 非回环的 http 与其它协议一律拒绝（回环仍允许，便于本地开发）。

### 二、安全 fail-open（批二）

- **预设「未提权」分支把 `allow`/`deny` 整体丢掉**（实测）：`{mode:'auto', deny:['fetch:*']}`
  配预设 `permission:'readonly'` → 只读档下 fetch 禁令**静默消失**，方向是**放宽**权限，
  与该函数「只能收紧」的意图相反。改为对象进对象出（只改 mode，保留 allow/deny）。
- **hook 载荷写失败被当成「空输出 = 放行」**（实测）：v0.4.6 为防崩溃加的
  `child.stdin.on('error', () => {})` 只吞不报，而本模块把空输出当放行 → 本该拦截的策略静默通过。
  收口为「**载荷没送到且 hook 无输出 → 按 hook 失败处理（fail-closed）**」；若 hook 仍给出
  输出（它本就没打算读 stdin）则尊重其判定，避免误伤。
- **completeness 的「缺失」哨兵只认中文「未提及」**（实测）：英文/多语种会话里模型写
  `not mentioned` / `N/A` / `unknown` 判不中 → **必填项红线因为语言而静默停止生效**。
  改为保守的多语种哨兵集合并支持约束自声明 `missingValues`；**刻意不含 `无`/`none`**——
  医疗等域里「过敏史: 无」是有效数据，当缺失会误拒。
- **deny 的「硬拦截」——先纠正报告的前提**：报告称「deny 命中后按 y 仍可放行」与文档矛盾。
  核实：**不矛盾**，`docs/CONFIG.md` 明确写着「同意即放行」（v0.4.6 有意加的"不再静默拦截"）；
  与文档不符的是**代码注释**。故不推翻文档化行为，改为三件事：① 新增 **`denyStrict: true`**
  显式选择硬拦截；② 放行提示**点名命中了哪条规则**（知情同意）；③ 注释与文档对齐。
- **`mcpEnvFilter=false` 会把整机凭据交给每一个 MCP 服务器**（多为 npx 拉来的第三方进程）：
  核实**默认是过滤**（未发现默认关闭路径），不改显式配置，改为**一次性告警**点明后果
  并指向更窄的 `mcpEnvKeep`，同时加断言锁住「默认必须过滤」。

### 三、合规静默失效（批三）

共同形态是「不报错、不崩溃，只是主打能力实际空转」。

- **约束事件无 `id`**：账本（`agent.js`）与回放（`replay.js`）两个消费方都读 `id`，
  而 `event()` 只产出 `constraint` → 每次被红线拦下，「是哪条红线拦的」**恒为 null**。补 `id`。
- **`confirm` 从不求值**：它是 `KINDS` 成员、能过装载校验、会计入 `size`（于是 `active=true`），
  却落进 output 桶被 `kind !== 'output-forbid'` 跳过。改为真正求值：权限放行之后仍走
  `io.confirm`，答否或拿不到交互通道（`-p` / 调度 / 子 Agent）一律阻断；回放无交互通道，
  单列 `confirm-required` 如实报告而不是静默算通过。**连带自查出顺序陷阱**：`confirm` 与阻断类
  同轮求值会让「`confirm` 写在 `tool-deny` 之前」遮住 deny → `checkPreTool` 改为两遍，
  先阻断类再 confirm；`packs.js` 同时要求 `confirm` 必须带 `tool`（不带则恒不命中 = 永不生效的红线）。
- **CLI 回放恒假阴性**：命令分发发生在挂 Pack 之前 → 约束恒空 → `ledger replay` 恒报
  「没有任何生效的领域约束」，当 CI 门禁时**恒通过**。replay 分支按启动路径同口径挂 Pack。
- **`--json` 恒失效**：布尔开关是取值型解析、写在末尾取不到值 → 恒走人读分支。
  布尔开关与取值型参数分开解析。
- **失败路径退 0**：`diagnose` 的 `[错误]`、`ledger` 的非法 runId / 找不到账本 / 未知子命令、
  `key` 与 `net` 的未知子命令统一退 1（报告点名的 `update.js` 经复核**不成立**，
  那是子命令劫持防护的设计行为）。

### 四、静默数据损失（批四）

共同形态是「没有报错，数据就是少了一部分」，都发生在并发或多进程场景。

- **配置「读不出来」被当成「没有配置」**：改坏一个字符后跑 init / 桌面首启，
  `customModels` / `mcpServers` / `sync` / `net` / `costGuard` 会被全新对象**整文件覆盖且不备份**。
  新增 `readConfigStrict()` + `quarantineCorruptConfig()`（改名备份而不是覆盖 + 明确告警），
  CLI 向导与桌面首启前先隔离；顺带修掉「带 BOM 的合法 JSON 被误判为损坏」与
  「同秒两次隔离时备份互相覆盖」。
- **手动 `/compact` 用追加落盘**（文件近乎翻倍、`-c` 恢复后历史重复），而自动压缩走的是
  原子重写——同一件事两套口径，统一到重写。
- **压缩后不清读取去重缓存**：正文已被摘要替换，缓存仍说「你看过」→ 模型只拿到占位串。
  压缩成功路径与 `/compact`、`/clear` 都清缓存。
- **费用明细追加在锁外**：A 追加 → B 追加 → A 锁内读到含 A 的快照并替换，B 那一行被覆盖；
  追加与轮转收进同一把锁。
- **审计日志轮转窗口吃行**（审计是合规证据，丢一行等于证据链有洞）：与 cachestats 同法。
  Web 日志跑在请求路径上，加同步锁会引入阻塞 → 改为**改名式轮转**（整文件 rename + create
  语义），没有读-改-写窗口因此不需要锁。

### 五、Web 攻击面（批五）

- **符号链接逃逸（P0-3，实测复现）**：围栏只做 `path.resolve` 前缀比较，而 `statSync`/`readdirSync`
  **跟随符号链接** → `ln -s / <家>/escape` 即可任意目录枚举，再 `POST /api/workspaces` 登记
  就让 Agent 的 bash/write/edit 整体跑到围栏外。改为按 **realpath** 判定，且**目标与允许根
  两边都归一化**（只归一化一边会误判合法目录，macOS `/var`→`/private/var` 即是实例）；
  目标不存在时回退到最近存在祖先；直接访问链接路径也 403。报告的另一半（readdir 不过滤链接条目）
  实测**不可利用**（`Dirent.isDirectory()` 对链接本就是 false）——已在注释里如实写明，
  不把它当防线，断言也换成能真失败的那条。
- **回环绑定整段跳过 SSRF**：元数据端点改为**无条件拒绝**（`isMetadataHost` 单一来源，
  `allowPrivate` 也不放行）；刻意**不采纳**「CGNAT 段无条件拒绝」——100.64/10 正是 Tailscale
  地址段，无条件拒绝会打断真实自托管用法。
- **无令牌 + GET 有副作用可被跨站盲打**：引入 `Sec-Fetch-Site` 判定，cross-site / same-site
  一律 403（覆盖 `<img>`/no-cors 盲打，含「读取即删除」的 `GET /api/draft`）；
  Origin 校验扩展到所有方法。**不采纳**「回环也强制令牌」（桌面版本就随机生成令牌，
  强制会让 CLI 日常用法每次回终端取令牌），改为启动横幅明说「本机信任模式」并如实登记残留。
- **自定义 Provider 名穿越 import**：`provider: '../evil'` 原本可 `import` 目录之外的模块
  （`path.join(providers, name + '.mjs')`）→ 名字白名单 + 路径包含性检查，
  非法名退化为「没有自定义模块」，并用「恶意模块放在 providers/ 之外」端到端验证其未被执行。

### 六、供应链（批六）

- **`pack verify` 会执行被审代码**：帮助文本写「只做静态校验」，实现却无条件 `loadPack` →
  `import pack.mjs`。下游 CI 拿它当门禁，等于**以完整 Node 权限执行被审仓库的任意代码**。
  新增 `loadPackStatic()`（manifest / 兼容窗口 / 声明文件 / `pack.mjs` 存在性，全程不 import），
  `verify` 默认静态，要执行必须显式 `--runtime` 且先警告。
- **未信任的项目级同名 Pack 能把内置版本静默顶掉**（而它自己又不挂载 = 两边都没生效）：
  未信任 tier 不再参与遮蔽，同名冲突变成启动告警；已信任的遮蔽同样可见。
- **项目级预设按名静默遮蔽内置/用户级**（可注入 `systemPrompt`/`tools`）：不改变遮蔽语义，
  但命中时打印含两份路径的告警。
- **git 安装器**加形态白名单（只收 `https`/`ssh`/`git`/`git@host:path`），
  `file://` 与本地路径明确拒绝。
- 技能库 sha256 与索引**同源自证**，不宜擅自改成签名制——改为安装后如实说明这条边界。

### 七、并发与长驻（批七）

- **同步服务的写锁没有 `await`** → 临界区异常变 `unhandledRejection` → 整个同步服务退出。
  补 `await` + try/catch 留痕，并加**扫描式守卫**（任何未 await 的调用行即失败）。
- **锁外读快照、锁内整份写回**：revoke 后并发 accept 会把 `shareId` 写回（分享复活）；
  改密时锁外删设备会让已吊销 token 复活。改为锁内重读 / 整体持锁。
- **调度 `markRunning` 把 `runnerPid` 写成自己**，而恢复判据是「该 pid 是否存活」→ 恒真
  → 任务永久卡 `running`；宿主死了但 worker 还活着时又会重排 → **同一任务跑两遍**。
  加「宿主即自己」例外 + worker 存活则不重排 + 协程异常留痕。
- **锁陈旧回收只看 pid 存活**，**pid 复用**会让锁僵死：锁内记入口脚本名，回收前用
  `pidOwnedBy` 复核身份（读不到命令行时维持原判据）。
- 避峰长等待按 **≤60s 切片**，每片复查租约。

### 八、计费与可用性（批八）

- **非幂等重试导致重复计费**：`chat` 是 POST，上游一旦开始生成就按量计费，而重试只看
  「错误是否瞬态」——流式空闲超时（已开始输出）也会重试 → **用户看到一份回答、账本记两次**。
  改为「收到过任何一帧就不再重试」；代价（已开始输出后不再静默重试）如实写进注释与登记。
- **重试循环头部复查总量护栏**（原来只在 catch 里看，退避期间超时仍会再发一次）；
  **退避 sleep 接 signal**，Ctrl+C 立即中断（原来最长干等 30s）。
- **`compactTrigger` 只夹下限不夹上限**：写成 >1 会让自动压缩**永久失效**；上限夹到 1 并告警。
- **降级回合按 `modelName` 计价** → 与实际调用的模型单价差数倍，「降级省钱」反而看不出来；
  改用 `activeModel`。
- **上游提前关流**（无 `[DONE]`、无 `finish_reason`）标 `truncated` → 界面提示 + 账本标记 +
  回合结果 `upstreamTruncated`（刻意不复用既有 `truncated` 字段，那个含义是「兜底总结失败」）。
- **content-type 被网关改写成 `application/json`** 时按内容嗅探回退，正文不再整段丢失。

### 九、上游能力与文档（批九）

- **skill 安装器的临时目录清理**原先只在「校验失败」这一条早退上删，中途抛异常就留下整个目录
  → 收进 `finally`；`readSkillMeta` 返回 null 时给可读错误而不是 `TypeError`。
- **检查点文件名可 `../../` 穿越**到目录之外 → 加包含性检查（`path.relative` 必须落在
  `taskstates/` 内），非法会话名如实返回失败。
- **`--auth-token` 写在命令行会进 argv / `ps` / shell 历史** → 支持 `--auth-token=-` 从 stdin 读，
  字面量令牌给出明确告警并指向环境变量。
- **P3 文档漂移**：`pack verify` 静态/`--runtime`、目录围栏 realpath 语义与规范路径契约、
  本机信任模式与令牌三来源、跨站请求 403、元数据端点无条件拒绝、`compactTrigger` 0–1
  逐处对齐，并**加断言钉住文档**（文档回退即失败）。

### 工程侧收尾（不影响使用）

- 界面文案：右侧面板与详情的 **9 处用户可见字符串**「子代理」→「子 Agent」；
  代码注释与标识符一律未动（`sessionSubs`/`curTasks`/`subLabel` 等）。
- 两处跨平台测试夹具修正（Windows CI 红）：符号链接逃逸用例改用**平台相关且真实存在**的目标
  （原写 `path.sep + 'usr'`，Windows 上不存在 → realpath 回退到最近存在祖先，护栏被绕过）；
  源码级正则断言容忍 CRLF。**教训**：在「文本」上断言，就要按各平台的文本形态写。
- hook stdin 失败用例改为**确定性触发**（关闭 fd0 + 存活 300ms），并消除「判据依赖 error
  事件到达时机」的跨平台竞态；Linux 上原载荷 200KB 会被 AF_UNIX 发送缓冲整个吞下
  （"写不完"这个事实没被暴露），提到 4MB。
- 修 `loadPackStatic` 的 JSDoc 返回类型（`tsc` strict 棘轮曾因此 13 条超基线）。

### 验证

- `smoke` **148 组断言**、`e2e-local` / `e2e-web` / `e2e-schedule` / `api-contracts` /
  `bench` 全通过；`tsc` 0 错误、strict 棘轮 **0/0**；CI 五腿（ubuntu 18/20/22 + macOS + Windows）全绿。
- 每一批都用**变异验证断言本身**：批一 7 / 批二 5 / 批三 9 / 批四 8 / 批五 8，其余批次逐条同类验证。
  被如实记录的失败情形包括 **3 处等价变异**（删掉那行断言照旧全绿，说明它本就不是防线）
  与若干处「断言第一版抓不到变异」（收紧后重验才算数）。

### 已知边界（如实说明）

- 仍有 **15 处**同步文件锁在极端争用下会阻塞其所在进程——已核实不在 WebUI 请求路径上
  （`schedule` 在守护进程内、`sync` 是 CLI 一次性命令、`cachestats` 仅在 >4MB 轮转时），
  且列成受审阅清单（新增即测试失败）。**不宣称"阻塞面已彻底消除"。**
- 账本**可选签名**（`--sign-key`）仍未实现：封条只提升到「防误删/漏写」，
  **不等同审计级不可否认**，这一点已写进导出物。
- `audit-report.md` 里其余约 15 项只有**代号**（明细需逐条复现），`B-CS-1` 记为
  「部分落实」——**不宣称穷尽**。

> 版本标注说明：这九批改动在开发期按 `v0.6.3/批一…批九` 标记（提交信息与部分源码注释仍是该标记），
> 但 v0.6.3 已于 2026-09-15 发版，因此它们**实际随 v0.6.4 发布**；
> 用户文档（`docs/CONFIG.md`、`docs/PACK-API.md`）中的「v0.6.3 起」已按实际发布版本更正。

## v0.6.3（2026-09-15）— 下游与桌面版的三个卡点（域内指令拿不到工具 / bash 乱码 / vision 门控）

> 这一版不掺新功能，只修**下游与桌面版实际被卡住**的三件事，外加两项工程侧收尾。
> 三项都是"本来该能用却用不了"，且用户看不出原因——所以优先打包发出来。

### 一、域内任务拿不到工具（下游实测：只读档挡住了「回访」）

原实现要求**命中写意图关键词**才给全量工具，否则整回合只读档（write/edit/bash 对模型**不可见**）。
而域内任务用的是**开集**动词/名词——回访、排班、盘点、对账……永远枚举不完。
下游实测：「请生成回访看板」命中"生成"→ 能用；**「回访」不命中 → 工具不可见 → 高频入口直接废掉**。
更糟的是释放条件（"模型文字里出现写意图"）也等不到：工具看不见时模型只会答一段话，根本不进第二轮。

已修（不做关键词堆砌，那是对着开集打补丁）：
1. **判定方向反转**：只有"看起来是纯提问 **且** 无写意图"才进只读档，其余一律全量工具；
2. **域内 Pack 在场时永不进只读档**——这类部署的价值在"任务能做"，不在省 schema token；
3. **自愈**：只读档若以纯文本收尾且透出"做不到/需要…"，放开工具集重试一次（与词表无关，只放一次）。

> 代价说明：非提问的普通消息现在也走全量档，那部分轮次的输入 token 会上升（刻意取舍：能力 > 省 token）。
> `config.schemaTier=false` 仍可整体关掉。

### 二、桌面版 bash 输出乱码（两处独立根因）

| 根因 | 机制 | 修法 |
| --- | --- | --- |
| **逐块解码** | 采集时把 Buffer **逐块** `toString()`：3 字节汉字被管道切成两半，两半各自解出 `�` | 按 Buffer 累积、结束时**一次**解码 |
| **Windows 代码页** | Windows 上 bash 工具走 `cmd.exe /d /s /c`，输出是 OEM 代码页（中文 = GBK/936），按 UTF-8 解就是花屏 | 严格 UTF-8 失败时用 **GBK** 再解一次 |

顺带修两处同类问题：按字节裁剪会把 UTF-8 从字符中间切断 → 严格解码失败 → **误走 GBK 回退反而花屏**
（这是修复过程中被单测抓出来的自身缺陷），现已"裁剪后对齐字符边界"；`tail()` 的截断不再劈开代理对。

### 三、vision 门控不认自定义 Provider（下游 Dify 工作流已支持视觉）

原门控只看"内置预设 `supportsVision`"或 `customModels.<名>.vision`，于是**自定义 Provider
（Dify/网关适配器）永远被判不支持图片**；而为了让门控通过去写 `customModels`，又会把
provider 解析**劫持**到 `custom:<模型名>` 的 OpenAI 兼容直连——**自定义 Provider 模块被整个绕开**，
请求发去了 `baseUrl` 而不是适配器。一句话：「打开一个能力开关」不该改变「请求发给谁」。

已修（两条都做，覆盖两种表达方式）：
1. `customModels` 条目分两类：含 `baseUrl`/`apiKey`/`envKey`/`headers`/`path`/`kind`
   → **声明式端点**（原行为不变）；只含能力字段 → **纯能力覆盖，不改变 transport**
   （其中 `provider` 只作路由提示，可指向自定义模块）；
2. 自定义 Provider 模块可**静态声明**：`export const supportsVision = true`
   或 `export const capabilities = { vision: true }`；门控统一走 `resolveVisionSupport`
   （显式声明 > 内置预设 > Provider 静态声明 > 保守 false），只读静态导出、按 mtime 缓存。

附件被拒时的文案改为给出**三条**正确做法；`docs/PROVIDERS.md` 补「声明能力」一节与对照表。

### 工程侧收尾

- **文件锁的阻塞面**：新增异步锁 `withFileLock`（等待时让出事件循环），WebUI 请求路径上的
  `workspace`（7 处锁）已迁移；临界区里不再做外部进程调用；同步锁等待上限依实测从 20s 收到 **5s**
  （实测最坏临界区 6ms）。残留 15 处同步锁已列受审阅清单，新增即测试失败。
- **发布校验脚本**：瞬时网络失败不再误报「四平台未对齐」（加三次有界重试，
  并区分「取不到」与「真的不一致」）；发版清单里那条会把 token 写进 ssh argv 的命令已改正。

**诚实边界**：文件锁仍有 15 处在极端争用下会阻塞其所在进程（不在请求路径上，已列清单）；
三份历史第三方报告与一份 v0.6.2 自审报告共有约 **60 条**待处理条目（凭据暴露面、fail-open、
并发与长驻稳定性等），本版**未包含**，正按优先级分批推进。

## v0.6.2（2026-09-14）— 第三方审计欠账清算（26 批）+ 四平台发布纪律固化

> 本轮把三份第三方报告的**可执行条目**按 `docs/AUDIT-v0.6.1-第三方报告登记.md` §5 的优先级清完，
> 共 **26 批**、42 个提交。每一批都要求：**先复现 → 再定级 → 修复 → 回归断言 → 变异验证断言本身**。
> 过程中两次推翻自己的结论（把"未发现缺陷"改成"确有缺陷"、把一处"已设防"改成"可被绕过"），
> 也多次抓出**自己写的假绿断言**——这些过程都记在登记表里，没有抹掉。

### 两处最严重（均为实测复现，不是推测）

- **registry 索引名可清空用户家底（B-SR-1）**：安装技能时，拼路径用的是**索引里的 name**，
  而校验的是**下载文件里的 frontmatter.name**——两个独立输入。入口那道
  `^[A-Za-z0-9_.-]+$` 看着像白名单，**却允许 `.` 与 `..`**：
  `{"name": "."}` 让 `rmSync` 递归删除**全部已装技能**；`{"name": ".."}`
  实测**清空整个 `MINGDAO_HOME`**（配置/凭据/会话/账本全没）**且返回安装成功**。
  索引是网络内容且不在任何哈希覆盖范围内（文件的 sha256 是**对着索引**校验的）。
  已修：入口先校验索引名 + 安装目录改用校验过的 frontmatter 名 + 底层兜底校验（三道）。
- **账本"尾部截断"查不出来（A-LG-1）**：旧 `verifyRun` 只比对链内 `prev`，
  而删掉尾部若干行（含 `run.end`）后链内**完全自洽**——实测「只留前 3 行」照样报 `ok:true`。
  而尾部截断恰恰是最常见的形状（部分写入、误删、随手截断）。
  已加**封条侧车**（`<runId>.seal.json`：应有条数 + 链头哈希）：条数少了报截断、多了报追加、
  末行链头不符报尾部改写；**没有封条时不再谎报完整**，而是明确警告。
  命令层同步收紧：`mingdao ledger verify` 对"链内一致但完整性未知"**退出码 1**（行为变更）。

### 一类系统性问题：写入失败却报告成功

对合规物与用户数据而言，这比"少一个文件"严重得多——**用户被告知成功**。
本轮把这一类**穷举后**逐个处理：账本（`ledger`）、任务检查点（`task-state`）、
费用明细（`cachestats`）、会话索引（`session-index`）、工作空间注册表（`workspace`）、
守护进程 pidfile（`schedule`）、项目记忆去重（`memory`）、审计日志（`audit`）。
其中 `schedule` 的 pidfile 写失败会让 `daemonAlive()` 永远为 false → **每次调用都再拉起一个守护进程**
→ 同一批定时任务被并发执行多次，**正是那段锁注释要防的 P0 被静默重新引进门**。

关键手段不是"这次仔细点"，而是**把穷举固化成测试**：一个全仓扫描器找出所有
「`catch` 里不打日志、不抛、不返回，而 `try` 块含写操作」的位置，与一份**已审阅白名单**比对——
白名单每处都写明"为什么可以吞"。新增一处或数量变化，测试**立即失败**。

### 其余修复（按类别）

- **安全/注入**：约束 pattern 的灾难性回溯（实测 `(a+)+$` 对 29 字符耗时 **4786ms**，
  一个 Pack 就能让内核卡死）→ 装载期拒绝嵌套量词并给出具体原因；SSRF 逐跳复检收成
  `safe-fetch.js` 单一来源；出网闸门保留 `Request` 的方法与正文（不再静默降级为 GET）；
  能力声明与实现一致（deny 按段匹配、git 缩写前缀双向拦截）；诊断包结构脱敏 + 0600。
- **崩溃/资源**：`process.stdout.write` 的 EPIPE 此前会**带堆栈崩溃**（`mingdao … | head -1`
  这种最常见的用法正好命中）→ 新增 `installPipeGuards()`，CLI 安静退出 0、常驻服务静默降级；
  文件锁陈旧判据改看持有者 pid（消除 15 秒死区，并不再误抢活锁）。
- **静默失效**：词表读失败**终生锁死**（一次失败后永远走启发式估算，误差可达 ±2 倍，且无声）
  → 改为有界重试 + 一次性说清后果；默认模型名单一来源（旧名不再让自动路由静默失效）；
  自启文件按格式转义；MCP 预设区分目录/文件参数；启动日志轮转改按**文件大小**触发
  （此前用进程内计数，对 CLI 永远是死代码）。
- **注入面**：项目记忆注入围栏加固（伪造闭合被中和、零宽字符剥掉、声明为数据非指令）；
  `io.print` 统一过滤终端控制序列（OSC/清屏必剥、SGR 保留）。
- **发布链路凭据（D-REL-1/2）**：`publish-mirror-releases.sh` 此前把 token 当 **ssh argv** 传给
  服务器、还把那一行**连明文一起回显**，gitee 的 token 又写在 URL 查询串里——
  三条泄露路径同时存在（上传跑几小时，argv 就挂几小时）。改为经 **ssh stdin** 落到
  `umask 077` 的临时文件、**读后即删**，两个平台都改用 HTTP 头鉴权
  （gitee `Authorization: token …` 已实测：真 200 / 假 401 / 匿名 401）。
  同时补上**内层脚本从未被送达到服务器**（回显的运行命令其实跑不起来）。
- **发布纪律固化**：新增 `scripts/verify-release.mjs`，把「四平台（GitHub + Gitee + GitCode + npm）」
  从口头约定变成**发版最后一步的自动校验**——git refs、Release、npm 版本与 dist-tags 逐项核对，
  任一缺失即退出非 0。

### 处理方式上的一条经验

**「库里有函数」不等于修好**。本轮多次遇到"修复只做了一半"：
只加校验而后面的破坏性操作没挪、只改库而命令层还在说反话、
只修一处而同类还有九处。因此现在每处修复都要求：
**接线（调用点）+ 断言（含对照组）+ 变异验证（把守卫拆掉必须让测试变红）**。

## v0.6.1（2026-09-12）— 厂家改名后模型选不了也计不了费（补丁版）

- **DeepSeek 把 `deepseek-v4-flash` 改名为 `deepseek-flash`**（依据：`GET /v1/models` 现只返回
  `deepseek-flash` 与 `deepseek-v4-pro`），而内核里「设置界面用动态名单、切换接口只认静态表」
  两处不同步 → 应用自己列出来的模型选不了（报「未知模型」并弹回旧模型）。
  已修：切换接口接纳动态发现的模型（拦任意字符串的护栏仍在），并把 `deepseek-flash` 补成一等公民
  （含上下文上限与**价格**——否则费用会退化成「无法估算」）；旧名保留以兼容老配置与历史会话。
- 工程侧：修 e2e-web 挑端口落在 Linux 临时端口范围（32768–60999）导致 `EADDRINUSE` 的偶发 CI 失败；
  官网 `/updates/` 的 macOS feed 由 dmg 改为 **zip**（electron-updater 的硬性要求，对已装 0.6.0 的用户即时生效）。

## v0.6.0（2026-09-12）— 合规与确定性（确定性③）

> 落地计划与滚动进度见 `docs/PLAN-v0.6.0.md`。目标：给定一次历史执行，能离线回答并证明
> 「每一步做了什么、触发了哪条规则、花了多少钱、数据有没有出网」，且结论可脱敏导出供第三方复核。

- **内网 / 信创部署（C4）**：`install.sh --offline`（Linux/macOS）与 **`install.ps1 -Offline`（Windows）**
  两侧对齐，均支持**完全断网**安装（不下载 Node、不走 npm、
  直接软链；本项目运行时零依赖），已用「屏蔽 curl/wget/git/npm + 代理指向黑洞」实测通过；
  `scripts/build-offline-bundle.sh` 产出带内网操作说明与校验值的离线包。新增 `vllm` / `ollama` /
  `oneapi` 预设覆盖国产推理栈（昇腾 MindIE、海光 DCU、寒武纪等以 vLLM 为后端的栈）与内网聚合网关。
  **本机/内网端点免除「必须有 API Key」的硬校验**（这类端点通常不校验也不发密钥，此前会把私有化部署
  挡在门外），公网端点仍必须有 Key；无 Key 时不再发空的 `Authorization` 头（部分网关会因此 401）。
  顺带修掉 `install.ps1` 的同类版本判断缺陷：此前只看 major（`-lt 18`），于是 18.0–18.16 被判合格，
  而内核 `engines` 要求 ≥18.17——用户会拿到「装得上、跑不起来」的安装（POSIX 侧修过同类问题 T23，Windows 侧漏了）。
  诚实登记：离线模式不支持 `mingdao update` 自更新，离线包不含 Node 运行时。
- **出网白名单 + 出网自证（C3）**：新增 `config.net`（`allow` 支持精确主机 / `*.子域` / IPv4 CIDR，
  `mode: warn|block`）与 `mingdao net report|policy`。出口只在一处收口——包 `globalThis.fetch`，
  而不是逐个改调用点（出网点分散在 Provider / fetch 工具 / 技能库 / 模型发现 / 定价 / Batch，
  逐个改既易漏、也会随时间漂移）。记账写 `~/.mingdao/net.jsonl`，**只记主机/端口/判定/命中规则，
  不记请求体与完整 URL**；启用后每个回合的账本里也会出现 `net.egress` 事件。回环（localhost/127/::1）
  始终豁免——它出不了本机，本地模型场景不该被当外发；私网不豁免，需显式列入。
  **未配置 `net` 时闸门完全不安装**，既有行为零影响。`sync.js` 自签名证书走 `node:https` 会绕过
  全局 fetch，已显式过闸。**诚实边界**：只覆盖内核自己发起的请求，用户在 bash 里自己敲的 `curl`
  不走这里——它证明「内核没有偷偷外传」，不等于「这台机器绝对没有外传」。
- **执行账本（C1，进行中）**：新增 `src/ledger.js` 与 `mingdao ledger list|show|export|verify`。
  一次回合一个账本文件（`~/.mingdao/ledger/<runId>.jsonl`），统一记录**八类事件**：
  回合开始 / 模型轮次 / 工具调用 / 工具结果 / 约束触发 / 权限决策 / 费用 / 回合结束。
  **不改造 `audit.jsonl`**——后者有 20000 行截断（回放会缺段，被静默截断的合规账本比不记账更糟）
  且只记工具调用，粒度不足以回答「这个结论是怎么来的」；`mingdao audit` 行为不变。
  两条不可让步的纪律：**写入即脱敏**（明细先过密钥规则再落盘，不留「先存明文靠导出兜底」的口子）
  与**摘要替代原文**（`argsDigest`/`resultDigest` = sha256 前 16 位，可比对、可防篡改、不泄露内容）；
  约束事件只记「哪条约束/什么时机/如何处理」，**不回显命中原文**（否则账本自身成为泄露渠道）。
  导出时在密钥规则之上再叠加私网 IP + 家目录掩码；无价模型落 `priced:false` 与「无法估算」，
  绝不写 `¥0.0000` 冒充免费。每行以 `prev` 串成**哈希链**，`ledger verify` 能发现改行**与删行**。
  诚实边界：哈希链只能证明「自写入后未被改动」，**不含可信时间戳**，不等同于审计级不可否认。

## v0.5.0（2026-09-11）— 垂域 Pack 契约 v1（约束确定性 + 成本确定性）

定位升级：从「省钱 Coding Agent + 开放内核」→ **可私有化的垂域智能体内核**（详见 `docs/STRATEGY-0.5.md`）。
本期落地上游与下游之间的正式契约：垂域团队**不改内核源码**即可把领域工具、领域红线、领域提示词、领域费用接进内核。
决策已确认：v0.5 做确定性①约束 + ②成本；③行为确定性（执行账本/可回放/合规导出）放 v0.6.0。

- **Pack API v1（契约冻结）**：`pack.json`（manifest）+ `pack.mjs`（contributions）。三级遮蔽发现（项目 > 用户 > 内置）+ `config.packs` 声明；manifest 严格校验（未知字段/版本窗口/保留名/权限/贡献项），错误信息可操作；极简 semver 按 npm 语义（`^` 对 0.x 锁 minor）；挂载**幂等**；**坏 Pack 只告警、不阻塞启动**。契约见 `docs/PACK-API.md`，变更史 `docs/CHANGELOG-PACK.md`
- **约束引擎（确定性①）**：领域红线从「提示词里的一句话」升级为**内核强制**——`tool-deny` / `tool-arg-require` / `arg-forbid` / `output-forbid` / `completeness` / `confirm`，三个时机（调用工具前 / 工具返回后 / 正文输出前）强制执行，命中写审计。**fail-closed**（求值异常按阻断处理）；**零约束时三处检查点全部惰性**（对既有行为零影响）。输出约束在**回填会话历史之前**生效，避免违规措辞被当既成事实喂回；`block`/`block-and-rewrite` **不回显**命中措辞
- **成本确定性（②）**：`ctx.llm()` 统一模型出口——Pack 内模型调用复用内核 Provider 解析/重试/超时/能力表，usage 并入当前回合 → **今日费用 / 缓存命中率 / 峰谷 / 日费用护栏同时生效**（对照：垂域层此前把调用写在 Provider 里，usage 硬编码 0，完全不计费也不触护栏）。新增 **Pack 归因记录**（`cost=null` 标记，与回合级总账不重复计费）与 `mingdao cost --by pack` 分账视图；Pack 级预算 `budget.dailyYuan` + `action`（block/warn）在调用前拦截
- **领域提示词段**：`promptSections` 注入系统提示（预设/记忆/技能之后），按 `order` + `pack/id` 确定性排序，**字节稳定不破坏前缀缓存**
- **CLI**：`mingdao pack list / verify / new / info`；`pack verify` 为静态校验（不 import 代码）→ 可直接作**下游 CI 门禁**；`pack verify` 对「Pack 自建模型调用（fetch 且不用 ctx.llm）」给出静态告警（先剥注释，防脚手架模板注释掩盖真实调用）
- **内置中立示例** `packs/example-hello/`（1 工具 + 1 输出红线 + 1 提示词段）；随 npm 包与桌面版分发，并有静态护栏断言
- **文档**：`PACK-API.md`（v1 冻结）/ `PLAN-v0.5.0.md`（落地计划与进度）/ **`MIGRATION-DEYI-v0.5.md`（下游回迁指南）**；README 增「垂域 Pack」小节；`DEVELOPER.md` 增 Pack 章节
- 测试：smoke 81→**86 组断言**；6/6 套测试全绿 · tsc 0 错误 · strict 棘轮 0/0 · 三平台 CI（Ubuntu 18/20/22 + Windows + macOS）全绿

> 下游衔接：按决策「v0.5.0 发布即迁」，`Deyi-TCM-Harness` 的 3 个域工具从 `providers/dify.mjs` 的 `chat()` 搬进 `pack-tcm`，
> 并让 `mingdao pack verify` 进下游 CI。迁移前域内调用硬编码 `usage: 0`（完全不计费），迁移后进入 `cost --by pack`。

## v0.4.6（2026-09-11）— 迁移 macOS 后首次全量审计：P0 费用护栏盲区 + 50 项根因修复 + 省钱口径自纠

- **省钱口径自纠（重要）**：`bench-savings`「综合省 64%」系虚高，真实值 **51%**——④Schema 瘦身 / ⑤只读阶段此前用**启发式**计数去测「面向 DeepSeek 的省钱主张」（工具 Schema 是 JSON，结构字符占 46%，两种计数偏差 1.1–1.8 倍），且 ⑤ 的基准里维护了一份**过期 6 工具副本**（实现的只读档自 v0.4.4 起已含 `task`）。两项改用随包官方词表**精确**计数、只读档集合从 `agent.js` 单源导出，并新增类别化断言防止再次虚高；真实值 ④48.9%（1145→585）、⑤28.9%（1145→814）。`docs/SAVINGS-BENCHMARK.md` 与 `docs/STRATEGY-NEXT.md` 同步修正
- P0 费用护栏盲区：`effectivePricing` 在读 `pricing.overrides` **之前**就因无内置价返回 null → gpt-5/qwen/glm/kimi/本地/动态发现模型全部 hasPricing=false、estimateCost=null、cost 记 null（当 0 累计）→ 今日费用看不到消费、护栏永不拦截；而护栏给出的补救办法恰是这条不生效的路径。现 overrides 与内置/外部价等价作为来源，并要求仅靠 overrides 供价时 input+output 均为有限正数
- P1 安全 ×5：**WebUI 权限确认可被任意客户端代答**（`/api/permission` 从不校验 ask id，而 taskId 是顺序号且 `/api/tasks` 全量列出 → 任何能访问 API 的一方都能替他人挂起的写文件/执行命令确认答「允许」，绕过默认 ask 档唯一人工闸门）· **任意环境变量外泄**（自定义模型 `envKey`+`baseUrl` 均用户可控，密钥解析把宿主任意变量当 Bearer 发到攻击者端点，不填 envKey 还回落主密钥）· **SSRF 绕过**（URL 解析器把 `[::ffff:127.0.0.1]` 规范化成 `[::ffff:7f00:1]`，旧判定只认点分四段 → 可抓回环 WebUI/内网/云元数据）· **`deny` 规则 fail-open**（防 allow 提权的白名单字符校验被同一函数用于 deny，命令含 `& ; | @ = ' "` 即失配，auto 档下 deny 形同不存在）· **sync-server 限流可用随机查询串绕过**（桶键用含 query 的 `req.url` 而路由用 pathname）
- P1 正确性 ×8：**`git` 工具 100% 失效**（`await execFile` 非 thenable → 输出恒 `[object Object][object Object]`、退出码/ENOENT/timeout 全被吞）· **`edit` 静默写坏文件**（`$&`/`$'`/`$$` 被当替换模式）· **read-after-write 命中旧缓存**（写后再读返回写前内容，模型误判写入未生效）· **自动压缩吞掉整段会话**（`compactTrigger<0.6` 或 force 时除 system 外全部压成摘要，WebUI 还会永久写回会话文件）· **`reasoning_content` 不计入预算**（思考型会话低估 61 倍）· **冲突备份对产品不可见**（producer/consumer 文件名正则不一致 → 「冲突三选一」100% 失效，且备份被当普通会话推送到其他设备变成幽灵会话）· **hooks/MCP 子进程 stdin 无 error 监听**（载荷 >64KB 且子进程先退出时 EPIPE 未捕获异常带走整个进程）· **步数上限兜底总结被静默丢弃**（长任务终端只看到一屏工具调用、没有最终答复）
- P1 费用 ×2：**子代理 token 从不并入父回合**（CLI/REPL 恒漏计，README 主推的「多方向并行调研」漏计最重）· **启发式计数并非其自称的「保守上界」**（纯标点低估 3 倍、单字母词/随机字母数字 2 倍 → 非 DeepSeek 模型预算/压缩/批量预检系统性偏小）
- P1 打包 ×2：**`skills-lib/` 未随 npm 包与桌面版分发**（README/官网主打的「36 个技能」在两条主分发渠道只剩 14 个，失败还被 try/catch 静默吞）· **桌面版版本漂移**（`desktop/package.json` 停在 0.2.0，而 README 教用户的 `dist:linux|win|mac` 不跑同步 → 本地打包产出 0.2.0）
- P2 安全/健壮性：预设提权防护对**对象形态** `{mode,allow,deny}`（文档推荐写法）失效（只读档可被静默提权为 ask）· 点击劫持防护缺失（`frame-ancestors` 不支持 meta 标签而服务端未下发 HTTP 头）· 审计日志泄漏 URL 内嵌凭据 · `config.tools` 子进程不筛敏感环境变量 · `undo` 越界回落回滚**无关文件** · hook `matcher` 不支持文档写明的 `|`（策略钩子永不触发）· `grep` ReDoS 可绕过（`(a|aa)+$` 同步回溯 >180s 冻结整个进程）· `fetch` 上限在整包下载后才判（实测写满 30MB 才报错）· 深嵌套 MCP schema 抛 RangeError · `SSH_AUTH_SOCK` 被误剥离致 git-over-SSH 失效 · TLS 静默降级
- P2/P3 成本与平台：**峰谷单价按落账时刻判定**（跨 12:00/18:00 边界错记一档）· **cache-stats 轮转丢当天费用**（日费用护栏被静默重置）· **日界/避峰时区错位**（`beijingToDate` 硬编码 UTC+8，而 `beijingParts` 用可配置时区 → 覆盖 `pricing.timezone` 后错 12 小时）· Batch `--max-cost` 对无价模型静默失效 · `maxOutputCeiling`(384K) 只定义不生效（README 的「单次输出上限 384K」拿不到）· **macOS 自启必然静默失败**（plist 用裸命令 `mingdao`，launchd 极简 PATH 找不到，且从不 `launchctl` 注册）→ 改绝对路径 + 注入 PATH + bootstrap/bootout · 日志轮转写放大（达上限后每次追加整文件重写，2000 次 ≈1GB I/O；中文日志因字节/码元混用几乎不截断）· CI strict 棘轮排在 `npm ci` 之前空转假通过（tsc 缺失被当成 0 错误）
- 测试与工程：smoke 74→**81 组断言** · bench 208→**214 断言** · 全绿门禁 + strict 0/0 + tsc 0 错误；**并修正两处「测试自身编码缺陷行为」**——smoke 曾断言 `git status` 在非 git 目录**成功**（只有坏实现才成立）、tokenizer 断言锁定旧口径，二者都会让回归测试反过来保护 bug
- 官网（独立仓库）：论坛板块名未转义进列表页 `<h2>`（存储型 XSS）· 反代下限速按 `127.0.0.1` 聚合成全站共享配额 · `deploy.sh` 漏部署 `site-stats.mjs`
- 审计方法与剩余项：六路并行只读审计 + 独立复核，逐项给出 `file:line` 与复现证据；完整报告见 `docs/AUDIT-v0.4.6.md`（含 14 项登记待办与「已确认无问题」清单）

## v0.4.5（2026-09-07）— 费用护栏根因修复 + 本地模型 507 中断根治 + 调度/CLI/安全收尾

- P0 费用护栏：`estimateCost` 无价返 null（0 与「未知」语义分离）+ `costGuard` 显式 `noPricing` 告警，不再静默当「没花钱」；`recordUsage` 记录 null 成本（覆盖内置/外部/overrides 三来源）
- P0 任务锁与 kill：`withFileLockSync` 可重入（killTask 持锁二次抢锁自死锁 5s）；schedule pause/remove 的 killTask 包 try/catch；非 Linux（无 /proc）kill 降级为按 pid 存活即杀
- 调度器 pause 语义：标记 running / once-after 终态 / skipped / offpeak note / runOnce 元数据五处状态写全部「加锁 + 复查 paused」，执行期间 pause 不再被覆盖（every 已有防护，once/after 补齐）
- MacBook 本地 507 根治：parseStream/parseNonStream 识别 200 里夹带的 error 对象（memory_refusal）并上抛；agent 507 直结合回合透出降级提示（不计空轮、不空烧续写）；isLocalBaseUrl 补 /etc/hosts 复检 + customModels.local/isLocal 显式本地档（mtplx 自定义主机名不再误判远程）
- SSE [DONE] 后有界排空（捕获尾帧 usage 又不挂网关）；readBody close→499 释放 inflight 槽
- CLI `--model` 贪婪解析修复（后台/定时指定模型不再被顶层剥除、文本含 init 不误触发向导）
- worker 判 capHit（跑满步数上限判 failed）；every 崩溃恢复经 postRunStatus 重排回 pending
- git 只读工具拒绝 `--no-index`/`--output`/`-D`/`-f`/`-m` 等越界/破坏性参数；技能目录拒绝符号链接（lstat + containsSymlink）
- memory/pricing 整写改原子写；子代理 onUsage 透传；task(readOnly) 自动放行；fetch 重定向死代码；onUsage 带模型名归属

## v0.4.4（2026-09-07）— macOS 熄屏断连根治 + 审计可用性 + 技术评估修复

- macOS 长任务 network error 根治：生成期 `powerSaveBlocker('prevent-display-sleep')` 防熄屏（熄屏/Idle Sleep 中断 Chromium 网络栈是最终根因）；SSE 异常日志 JSON 化（此前 Electron 落 [object Object]）；统一中断续跑提示
- 审计可用性：`task` 工具加入只读档（审计/调研只读长任务可派 readOnly 子代理）；`recordUsage` 改逐轮入账（长任务期间「今日费用」实时累计、中断不丢）
- 技术评估 6.x：fs-browse 先 path.resolve 消解 `..` 段（中危）；MCP 子进程环境变量过滤（中危）；调度器 resume/once/after 状态写加锁；hooks spawn detached 整组清理；工作空间注册表原子写；附件文本上限按字节数

## v0.4.3（2026-09-06）— 正确性收尾（审计修复 + network error 诊断）

- network error 诊断闭环：渲染层 SSE 异常补全量诊断日志（此前静默中断零日志）；服务端断连日志区分「正常收尾 vs 客户端中途断开」；「网络错误」兜底改为可操作提示（检查点已保存，发「继续」续跑）
- 审计 P1×3：WebUI 自启 100% 失效（spawn 目标改 cli.js web）；sync-server 内容落盘锁内原子写；skill 安装 spawnSync→异步 spawn（不再冻结事件循环）
- 审计 P2×6：installFromUrl SSRF 防护（CLI 显式 URL 放行内网）；pricing ttlDays 初值 bug；cachestats 轮转加文件锁；autoTitle 独立 try/catch；--format json 输出纯净；孤儿 tool_calls 清理
- 低成本 P3×5：家目录脱敏边界、预设 name 字段遮蔽、IPv6 本地判定、hook 环境变量过滤、sandbox 空串归一化
- 项目简称 MDH 写入 README（自 v0.4.3 起统一使用）

## v0.4.2（2026-09-06）— 预设下拉体验修复 + 本地模型长任务 507 截断缓解

- Agent Preset 下拉：桌面版打包补 `presets/` 目录（此前漏打包致内置预设恒空、下拉无可选）；预设下拉接入自绘 tooltip（悬停秒现，不再等原生 title）；选中即时弹出「这是什么 + 覆盖字段」反馈；占位符改「无预设」显式退出；内置 local-audit 预设 permission auto→readonly（语义更准且避免 ask 用户被提权拦截静默忽略）
- 本地模型 507 截断缓解（依据排查报告）：只读子代理目标为本地模型时串行化（不再 Promise.all 无并发上限，避免多路大 prefill 打满内存）；本地模型压缩触发线默认 60%（远程仍 80%）；API 507 附「内存不足：压缩上下文/减少并发子任务/重启服务」可操作提示

## v0.4.1（2026-09-06）— 安全版本（偿还 v0.4.0 审计安全债 + macOS 本地模型修复）

- P0 安全 ×5：路径穿越防护（fs-tools 全工具限定工作目录 + `config.fsAllowDirs` 白名单 + `realpath` 逐级校验防软链接逃逸）；SSRF 302 重定向绕过（`redirect:'manual'` 手动跟随每跳复检、上限 5 跳）；权限前缀规则黑名单改白名单字符 `[A-Za-z0-9_ ./\\:-]`；预设 permission 提权拦截（`presetPermissionOverride` 三入口统一）；MCP 只读自动放行收紧为「仅 `trusted:true`」
- P1 正确性 ×6：turnToolCache 去重跨步生效（声明提到 for 轮内）；windowPressure 压缩成功后复位；mountConfigTools spawnSync→异步 spawn；batch.js 超窗口预检跟进 model-caps；语义检索无匹配回退最近 N 条；detectSandbox 改最小真实沙箱探测（bwrap 不可用降级 none）
- P2 质量 ×6：正则笔误 `/^f[c d]/`→`/^f[cd]/`；git log/diff 限量实现；cost-guard TDZ 前置；registerTool 增 `readOnly` 选项；context.js 死代码移除；reasoning 清洗 O(n²)→O(n)
- macOS 本地模型双根因：routing 开启时 `subagentModel` 恒返回 executor 致本地/自定义模型子代理 400 全灭 → 池外跟随当前模型；兜底总结全量历史（≈98k prefill 逼近 600s 超时被静默吞）→ 轻量输入 + 失败不再静默
- 子代理空输出透出 note 原因；`diagnose` 新增「当前模型能力」报告（本地模型未声明 contextWindow 时提示兜底 32k 后果）
- 桌面版 WebUI 自定义模型「修改」可直接改 API 地址/标签/上下文窗口/最大输出（留空不变）

## v0.4.0（2026-09-05）— 开放内核（Agent Preset · 第三方工具 · 公共 API）

- Agent Preset：声明式智能体预设 JSON（系统提示+工具白名单+权限+模型+参数），项目/用户/内置三级遮蔽 + schema 严格校验 + 会话级 overlay（不污染 config.json）+ 白名单硬拦截；CLI `--preset` / REPL `/preset` / WebUI 预设下拉三入口；内置「本地模型审计」示例
- 第三方工具：`registerTool` 程序化注册（进权限/审计/省钱 schema 链路，mcp__ 前缀护栏、坏条目不崩启动）+ `config.tools` 声明式 shell 命令包装（参数经 MINGDAO_TOOL_ARGS 环境变量防注入，幂等）
- 公共 API 冻结：`src/index.js` 按 @stable/@experimental 分组，24 个 stable 导出有契约测试锁定（minor 内向后兼容）；新增 `docs/DEVELOPER.md`（预设格式/工具注册/库嵌入/API 速查）
- 战略定调（STRATEGY-NEXT）：垂直产品 × 开放内核；本地/私有化第一公民与 DeepSeek 省钱并列双主攻；不引入插件内核、不做云平台
- 测试：smoke 72 / e2e-local 17 / e2e-web 22（CLI+WebUI 预设真实进程端到端：白名单真实下发/系统提示到达服务端/cfg 不污染）

## v0.3.2（2026-09-05）— 本地模型自适应（资源受限部署长任务不再中断）

- 本地模型自适应：本机/内网推理框架自动按「资源有限」对待——上下文窗口/预算/超时/工具输出截断按模型能力自动收紧，小模型低内存部署不撑爆、不误杀
- 安全预算推导：`budget = min(期望, 窗口×75% 舒适区, 窗口−输出−余量)`，prompt 永不逼近窗口边缘（根治长上下文 prefill 指数恶化 → 首 token 200s+ 被客户端掐断的 network error）
- 分层超时：首 token 等待（本地 600s/远程 300s）+ 流式空闲（120s）+ 总量（本地 30min/远程 10min），按「帧到达」判定存活，慢 prefill 不再被 3 分钟一刀切超时误杀；`config.timeout.*` 可覆盖
- 边缘检测 + 强制压缩：模型上报真实 prompt_tokens ≥ 窗口 85% 时下轮强制压缩（绕过非 DeepSeek 模型启发式计数 ±2 倍低估门槛）
- 工具输出截断自适应：单条工具结果按窗口/16 封顶（2k–20k 字），小窗口不再整条回灌大段代码
- 自定义模型声明 `contextWindow`/`maxOutputTokens`（WebUI 打通）；超时/自定义模型改配置即时生效（清 provider 缓存）

## v0.3.1（2026-09-04）— 真·省钱仪表盘 + 语义检索 + 只读调研 + 自动续跑

- 真·省钱仪表盘：费用徽标从设置移出、置顶主界面，点击展开（KPI 卡 + 命中率环状仪表 + 14 天趋势面积图 + 模型/工具 Top5 条形 + 最近缓存明细）
- 语义检索（零依赖）：项目记忆从「全量截断注入」→「按任务取相关条目」（分词 Jaccard），换任务只注入相关记忆、省 token 且保前缀缓存
- 只读调研工具：`git`（只读子命令白名单 + execFile 防注入）与 `fetch`（公网只读抓取，SSRF 防护 + DNS 复检），只读档扩至 8 工具；子代理步数 12→24 防截断
- 自动续跑：跑满步数不再中断，注入进度摘要自动续下一轮（`cfg.maxRounds` 默认 3）；收尾指令仅末轮注入，中间轮不提前打断
- 统一脱敏：`redact.js` 收敛审计/日志/诊断密钥脱敏（sk-/ghp_/Bearer/私网 IP/家目录路径）
- 续跑检查点合并（保留原始 goal + 合并 artifacts）+ CLI/REPL 交付物收集 + journal 工作空间归属
- 增量上下文（基线+变化）顺延 v0.3.2

## v0.3.0（2026-09-04）— 记忆与长跑

- 省钱基准：`bench-savings`（8 任务·综合省 63% 基线）+ `docs/SAVINGS-BENCHMARK.md` 并入 bench 链（bench 208 断言）
- 任务续跑 v1：agent `capHit` + task-state 侧车检查点；`--continue`/WebUI 恢复会话时注入进度摘要续跑（24 步不再死，已完成文件不重做）
- 项目级自动记忆 v1：`<工作空间>/.mingdao/memory.md` 轮末自动沉淀「决定/事实/结构/教训」并去重注入；会话内快照保证前缀缓存稳定
- `mingdao diagnose`：一键生成脱敏诊断包（环境/配置脱敏/日志尾/审计尾/工作空间 + 项目记忆定位）
- 增量上下文（基线+变化）顺延 v0.3.1（风险高，续跑进度摘要已覆盖主场景）

## v0.2.8（2026-09-03）

- 任务收尾总结对齐 DSH：跑满步数前注入收尾指令、末轮仍调工具时补 no-tool 兜底总结，交付物清单随总结输出（agent.js + server.js 兜底文案改写 + smoke 5c/5d 回归）
- B/C/D 计划：会话索引按会话名 sha1 分片（256 片，>1000 会话免单文件全量解析 + 增量只写脏片 + 旧单文件自动迁移）· 常量单源化（MAX_CONCURRENT/5MB/200KB 附件上限收敛到 src/web/constants.js，app.js/attachments.js/fs-tools.js 不再漂移）· WebUI ES Modules 拆分（app.js → util.js 纯工具 + constants.js）· 文档门禁（QA-REPORT 断言规模快照、CONFIG 补 downgrade/思考档位、CI 类型门禁统一 tsconfig.full.json）
- 思考模式/推理等级**按模型独立**（`reasoningByModel[模型]` 覆盖，旧全局 reasoningEffort 兼容；/api/state reasoning 字段 + /api/config 校验 + REPL /think 同步）
- UI 对齐 DSH：模型（紧凑选择器）、权限、思考下拉下移到输入区（发送键左侧），顶栏瘦身；权限/思考中文选项（询问/自动/只读 · 关/低/高/最高）
- 自绘悬浮气泡 tooltip 替换原生 title（权限/模型/思考/附件按钮/后台任务 chip，暗色主题一致）；轨迹/子代理「关闭」按钮字号缩小 + 不换行

## v0.2.7（2026-09-02）

- 自查 6 条修复 + 界面三项：stopDaemon 解析 pid + daemon 租约自退（防双守护重复执行，含 finally 条件删 pidfile 自检拦截的连锁退出回归）+ e2e-schedule 回归 · MCP 超时孤儿清理 · 护栏徽标 NaN 守卫 · 价格源协议/大小校验 · 日志权限 600 · 任务活动条宽度自适应+阶段回归 · task 子代理派发时机引导 · 后台任务 chip 详情 tooltip

## v0.2.6（2026-09-02）

- A 计划（前缀缓存稳定性与费用基准）：A1 工具 Schema 两态冻结（回合内 ≤2 payload，剥描述按回合快照）· A2 MCP 预热（6s 超时本会话冻结工具集）· A3 bench-cost 费用基准（schema 收益/两态冻结/护栏拦截/batch 半价 14 断言入 bench 链）· A4 回收幂等守卫（修复嵌套重截导致保留区字节逐轮漂移）+ 前沿对齐结论入基准

## v0.2.5（2026-09-01）

- Phase C 结构渐进：routes/api.js 按域拆分（7 域 + 编排器 + API 契约测试 8 组，修 icon 路径 bug）· cli REPL→commands/repl.js、worker→tasks/worker.js（tuiState 共享槽修复 onCompact 跨文件闭包）· strict 棘轮 1112→0（全量注解 + annotate-strict 辅助器，基线归零）

## v0.2.4（2026-08-31）

- Phase B 省钱第二轮：工具 schema 按需挂载（只读阶段收缩/已用工具瘦身-48%）· Batch 去重回填/超窗口预检/--max-cost · 费用二级分账（reasoning/byTool/byDay + WebUI Top5/折线）· 护栏 downgrade 切 flash · bench 扩到 150+ 断言 + 覆盖率阈值 60%

## v0.2.3（2026-08-31）

- 紧急修复 0.2.2 桌面三平台启动即崩：main.js 顶层 createLogWriter 漏导入（A6 重构遗留）——改为顶层 await import(srcRoot/log-writer.js)；新增静态护栏 + CI 打包冒烟（xvfb + MINGDAO_DESKTOP_SMOKE）

## v0.2.2（2026-08-31）

- Phase A 正确性收尾：sync 写锁、密码隐藏输入、fs-browse 基目录、body 分级、草稿按会话、日志统一、崩溃护栏、notify 结构化、run 参数合一

## v0.2.1（2026-08-31）

- Phase 3 工程化：测试汇总运行器、V8 覆盖率门禁、strict 棘轮、bench 入 CI、CHANGELOG 发布钩子；桌面 deb 更新引导、后台任务横幅、活动条合并、模型连通性测试、轨迹窄栏同显

## v0.2.0（2026-08-28）— Phase 2 结构治理

### 结构
- **server.js 拆路由模块**：全部 HTTP 路由抽至 `src/web/routes/api.js`（1299 → 579 行），服务器局部状态经 deps 显式传入（可变原语 state/refs 包装）
- **SPA JS 外置**：index.html 内联脚本抽至 `src/web/app.js`，CSP 收紧移除 `script-src 'unsafe-inline'`（417 行壳 + 1008 行逻辑）
- **cli.js 命令分发显式化**：`命令 → {module, handler}` 映射表替换字符串拼接三元嵌套；死导入清理

### 安全与正确性
- **SSRF 防护**：自定义模型/同步端点校验目标地址——对外监听时拒绝私网/回环/链路本地（本机回环绑定时放行本机模型服务，`web.allowPrivateEndpoints` 显式放行）
- **并发上限修复**：inflight 计数绑定请求生命周期（readBody 期间不再并发超限）
- **会话写互斥**：同一会话文件的追加与压缩重写按文件串行化
- **listen 修复**：runWebServer 等待绑定成功才 resolve，失败 reject；桌面端端口占用自动换端口重试（6 次），CLI 明确报错
- **sync-server 限流加固**：整表 clear → 最旧淘汰；键含用户名（防分布式 IP 绕过）；SYNC_TRUST_PROXY 控制 X-Forwarded-For；maxConnections 500
- **API Key 即时生效**：设置/删除 Key 后 provider 缓存失效，无需重启
- **更新下载失败可见**：发现新版本后下载出错弹窗提示官网手动下载；下载进度写日志

## v0.1.70（2026-08-28）— 更新器修复 · 静默可见性 · 布局重构

### 修复
- **Linux 自动更新下载失败根因**：打包环境下 `update-available` 回调的 info 参数为 undefined，旧代码 `info.version` 在监听器内抛 TypeError，中断 updater 事件派发导致 autoDownload 永不启动——全部监听器改 null-safe 且绝不在事件回调抛错
- **阶段静默深度优化**：服务端 progress 心跳新增阶段语义（模型推理中/执行工具中/等待权限确认）与子代理计数；客户端新增**顶部常驻活动条**（生成期间始终可见、滚动不影响：阶段 + 第 N 步 + 已 X 分 Y 秒 + N 工具步 + M 子代理）；回合边界（turnStart/turnEnd）继续播报
- **text=0 补偿反馈**：模型执行完工具但未输出总结时，done 提示改为「本轮共执行 N 步工具操作、交付 M 个文件，模型没有输出总结文字——可追问『总结一下刚才的工作』」

### 界面
- 输入框上方状态条文案缩短（⏳ N 步 · X 分 Y 秒 · N 工具步），移除冗余停止提示（按钮就在下方）
- **轨迹面板固定左侧栏**：聊天框左侧常驻「🧭 轨迹」栏，点击展开本轮轨迹详情（回合/工具/子代理），与消息顶部按钮等效
- **子代理面板右置**：顶栏「🤖 子代理 N」按钮展开右侧面板，列出本会话全部子代理（任务 + 结果可展开），与任务面板互斥
- Windows 更新完成弹窗改为友好提示（「更新已就绪」+ 正向文案，不再是报错观感）

## v0.1.69（2026-08-28）— 质量加固版（Phase 1）

### 修复
- 计费：`pricing.overrides` 根级价格现在同时传播到高峰价——此前高峰时段自定义价格被内置 peak 价替代，费用估算/护栏口径失真（H1）
- 调度：修复 every 任务执行期间 `pause` 被隐式恢复的确定性 bug（H2）；kill 前校验 PID 归属，防 PID 复用误杀（M11）
- 并发：新增 `src/atomic-write.js`（pid+随机 tmp 原子写 + O_EXCL 文件锁与陈旧锁回收）；config/credentials/update-state/session/session-index/sync 状态全部原子化；调度与任务读改写加锁（H3/H4）
- 压缩：手动 `/compact` 与自动压缩统一实现（同款 `<conversation_summary>` 标记，增量压缩可识别），修复双实现分叉（M7）
- 记忆：日期戳统一走配置时区（默认北京时间），修复 journal UTC 口径漂移（M8）
- 内存：undo 备份增加全局上限（64 文件 / 20MB，超限淘汰最旧），防长会话内存膨胀（M9）
- WebUI：主「■ 停止」只中断本任务（带 taskId），不再误伤其他标签页并发任务（L1）；`_activeTools` 被拒条目即时清理（L2）；任务面板保留最近完成历史并按年龄+数量双阈值清理（L3）
- 桌面/后台：worker/daemon/sleeper spawn 补 error 监听，ENOENT 不再崩进程（M12）；WebUI 自启失败给出可见提示（L6）

### 性能
- 上下文语义回收改为增量 token 求和（原每步全量重算，≤500×n）（M10）
- 费用护栏今日累计按 cache-stats 文件 mtime 缓存，不再每步全量解析（M10）

### 测试
- smoke 52 组 / e2e 21+16+7 / bench 38 断言全绿；新增原子写与文件锁、计费覆盖传播、pause 状态决策三组回归
