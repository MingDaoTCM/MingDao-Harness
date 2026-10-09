# 配置详解（~/.mingdao/config.json）

配置文件**不含任何密钥**，团队内可安全共享、可提交仓库。API Key 一律存独立凭证库
`~/.mingdao/credentials.json`（权限 600），解析优先级：**环境变量 > 凭证库 > 配置字段**。

## 基本字段

```json
{
  "provider": "deepseek",
  "model": "deepseek-v4-flash",
  "baseUrl": "https://api.deepseek.com/v1",
  "permission": "ask",
  "sandbox": "off",
  "contextBudget": 128000
}
```

| 字段 | 说明 |
| --- | --- |
| `provider` | `deepseek` / `openai` / `qwen` / `glm` / `moonshot` / `custom` / 自定义 Provider 模块名 |
| `model` | 模型名（预设见 `src/models.js`；自定义端点可任意命名） |
| `baseUrl` | OpenAI 兼容 API 地址（可覆盖内置服务商默认值） |
| `permission` | `ask`（默认）/ `auto` / `readonly`，或规则对象（见下） |
| `sandbox` | `off` / `readonly` / `safe`（Linux + bubblewrap；其余平台自动降级） |
| `contextBudget` | 期望的上下文预算 tokens；实际预算按模型窗口自动收紧（见「本地模型自适应」） |

可选字段：`temperature`、`maxOutputTokens`、`includeUsage`（流式请求 usage 统计，个别网关不支持
`stream_options` 时设 `false`）、`autoTitle`（自动生成会话标题，默认开）、`notify`（任务桌面通知，默认开）、
`autoCompact`（上下文自动压缩，默认开，见下）、`audit`（工具调用审计，默认开，见下）。

## 工具调用审计（P3-5）

每个工具调用（含被拒/被钩子阻止/参数解析失败）自动落 `~/.mingdao/audit.jsonl`（600 权限）：
时间、会话、模型、工具名、参数（`sk-` 系 Key 自动脱敏）、执行结果/退出码/超时/耗时/输出大小、
拒绝原因。查看：`mingdao audit [数量]`（默认 20 条）或会话内 `/audit`；`"audit": false` 关闭。
超过 **4 MB**（约 2 万行，按平均 200 字节/条估算）触发轮转，保留最近 **10000 行**。
判据是**字节数**而不是行数（`src/audit.js`：进程内行计数对 CLI 会话永远不触发）；工具参数很长时
实际保留的行数会明显少于 2 万行。

## 技能完整性（P3-3）

registry 技能安装时逐文件校验索引声明的 `sha256`（不符即拒绝安装）；安装后在
`.mingdao-source.json` 记录目录指纹，加载时校验——被本地篡改的技能**拒绝加载**并在
`mingdao skill` 列表 / WebUI 技能面板中警示。确认是自己改的：`mingdao skill trust <名称>`
重新记录指纹；否则卸载重装。

## 上下文自动压缩（auto-compaction）

长会话超出 `contextBudget`、静默裁剪即将丢弃早期段落时（被裁段落 ≥3 条且 ≥2000 tokens），
MingDao 先用 executor 模型（路由关闭时为当前模型）把被裁段落压成 ≤500 字摘要，以单条 user
消息注入，替代「失忆」；压缩后会话文件同步重写为压缩形态，不会每轮重复压缩。摘要失败自动
回退普通裁剪，绝不阻塞会话。设置 `"autoCompact": false` 可关闭（回到纯静默裁剪）。

触发线（滞回缓冲）：默认达到预算 **80%** 即提前压缩、压到约 60%——避免在预算线附近反复
裁剪/压缩导致缓存前缀频繁失效（每次失效 = 该轮 prompt 全额按未命中计费）。可用
`"compactTrigger": 0.9` 调整触发线（0–1 之间的小数；**超出 0–1 会被夹到边界并告警**——
此前只夹下限，配成 >1 会让自动压缩永不触发）。

## 会话检索索引（P3-2）

`mingdao sessions search <关键词>` 与 WebUI 历史会话搜索走增量词表索引
（`~/.mingdao/sessions-index/` 分片目录，v0.2.8 起按会话名 sha1 前 2 位分 256 片）：
中文按 bigram+单字、英文按词，多词 AND 匹配；只有内容变化（mtime/size）的会话才重新
分词，删除的会话自动清出索引。索引目录可随时删除（下次搜索自动重建）。

## 会话级工作空间（P3-4）

WebUI 中每个会话记住自己的工作目录：新会话记录创建时的全局工作空间；继续该会话时任务
固定写回它的目录，**全局切换工作空间只影响新会话**，多任务并行互不串目录（服务端不再
`process.chdir`）。载入历史会话时全局工作空间自动聚焦到该会话的目录；头部下拉显式切换
时当前会话跟随。映射存于 `~/.mingdao/session-workspaces.json`，会话改名/删除自动维护。

**目录围栏（v0.6.4 起按真实路径判定）**：可登记/可浏览的目录限定在 家目录 / 启动目录 /
当前工作空间 / `web.browseRoots` 显式授权 之内（Windows 上为 桌面·文档·下载 三个常用目录）。
判定走 `realpath`，因此：

- **符号链接不会成为逃生通道**——指向围栏之外的链接目录会被 403（此前只做字符串前缀比较，
  `ln -s / <家>/escape` 之后 `?dir=…/escape` 就能枚举全盘）；
- **悬空的符号链接同样不是通道（v0.6.5 起）**：Agent 的文件工具（`write`/`edit`）此前会跟随
  "目标还不存在"的链接把内容写到围栏之外（`realpath` 对悬空链接报错时退回字符串比较所致）。
  现在解析失败就按 `lstat` 判定并**递归解析链接目标**，围栏外的悬空链接一律拒绝，
  链接成环也**有界返回失败**；指向围栏**内**的悬空链接照常可用；
- 登记与切换返回的是**规范化后的真实路径**（macOS 上 `/var/folders/…` 会显示为
  `/private/var/folders/…`），围栏判定与返回值同口径；
- 确需家目录之外的位置（外置卷/网络盘）：`web.browseRoots` 加进白名单，或
  `web.allowAnyWorkspaceDir: true`（**这会整体放开围栏**，仅在完全可信的本机环境使用）。

## 权限规则（工具级 allow/deny）

```json
{
  "permission": {
    "mode": "ask",
    "allow": ["bash", "bash:git *"],
    "deny": ["write"]
  }
}
```

- `allow` / `deny` 为工具名列表，支持「工具名:参数前缀」匹配（如 `bash:git *` 只放行 git 命令）；
- `deny` 优先于 `allow`；匹配不到时回落到 `mode`（`ask` 逐次确认）；
- **需要特殊授权时弹窗交互**：被 `deny` 规则拦截、或 `readonly` 模式下执行写操作时，WebUI/TUI 会弹出询问（「是否本次强制放行？」），同意即放行、拒绝/无响应即拒绝——不再静默拦截。提示里会**点名命中了哪条规则**，便于判断这次放行是不是你想要的；
- **`denyStrict: true`（v0.6.4 起）**：把 `deny` 升级为**不可临时放行**的硬拦截（连弹窗都没有，直接拒绝并在输出里说明命中了哪条规则）。默认 `false`，保持上面那条"可放行"的既有语义。

```json
{ "permission": { "mode": "auto", "deny": ["bash:rm *", "fetch:*"], "denyStrict": true } }
```

> 什么时候该开：无人值守 / 强合规场景（定时任务、CI 门禁、下游容器），
> 那里"一次误按 y 就绕过自己写的禁令"是不可接受的；
> 交互式日常使用保持默认即可——每次放行都是一次明确的、点名规则的确认。

### 权限优先级与预设（v0.6.14，v0.6.16 收窄）

口径：**显式选择 > 预设建议（`recommendedPermission`）> config.json**。
（这句说的是"档位意图从哪来"的优先序；落到判定上，`recommendedPermission` **只是建议**——不参与判定、
不自动改档。真正会改档的只有两处：你的显式选择，以及老/第三方预设声明的 `permission`（受反提权约束）。）

| 层级 | 从哪来 | 性质 |
| --- | --- | --- |
| 显式选择 | CLI `mingdao run "…" --permission auto\|ask\|readonly`、REPL `/mode`、WebUI「权限模式」下拉（随本次请求发出） | **覆盖**：本回合的终值，任何预设都压不过它 |
| 预设建议 | 预设 JSON 的 `recommendedPermission`（**内置预设不使用它**；字段支持保留给第三方/自写预设）；`GET /api/presets` 会透出该字段 | **只是建议**：不参与权限判定、不静默改档；想让建议生效，就在上面那一层显式选它 |
| config.json | `permission` 字段（支持 `{mode, allow, deny}` 对象形态） | **兜底**：没有显式选择、预设也没声明 `permission` 时才用它 |

三条要点（别再踩）：

- **要"只读"，请自己组合权限档与工具白名单。** 预设的 `tools` 白名单是只读的**硬约束**
  （白名单里没有 `write`/`edit`，写工具根本不会出现在模型可见的工具表里——这比任何权限档都硬，
  权限档只决定"要不要逐次询问"）；把会话钉在 `readonly` 档则是另一层。内置预设**不替你决定**这两件事，
  正确的做法是在权限档里显式选 `readonly`，并在自己的预设里收 `tools` 白名单。
- **`permission` 字段是覆盖。** 预设声明它会改本回合的档位（更宽松的方向被反提权拦掉：
  `readonly→auto` 一律拒绝并只发一条 ⚠ banner）。**内置预设不携带任何权限字段**——`permission`
  的实际效果只是"沉默覆盖用户的选择"：负责人实测的坑就是界面上选了「自动」，勾上当时的审计预设后仍按
  `readonly` 跑，于是每调用一次非只读工具都弹「只读模式将拦截 task，是否本次放行？」。
  第三方/老预设仍可声明（兼容），但同样受反提权约束，且要自己承担"覆盖用户选择"的后果。
- **`recommendedPermission` 只是建议，且内置预设不使用它。** 它是预设对"我适合跑在哪个档"的表达，
  只做展示/透出，不写进任何权限判定；权限档以你的显式选择为准，其次才是 config.json 里的默认值。
  v0.6.16 起**内置预设连这个字段也不用**（避免任何形式的权限覆盖/权限偏好暗示）——字段本身保留，
  第三方/自写预设可以继续用它。

> **内置预设只提供参数类默认值。** 发行版面向普通大众，不为某种任务做定制，因此内置只保留
> `local-model`（只调 `contextBudget`/`maxOutputTokens`/`maxRounds`，**不加人格、不限制工具、
> 不涉及权限**）。v0.6.16 已**删除**原来的内置「只读代码审计」预设 `readonly-audit`（它只是负责人
> 拿 MDH 做的一次较长任务的测试）；老名字 `local-audit` 仍可用，但会提示已更名为 `local-model`。
> 另：审计日志/账本与预设无关——那是 `config.audit` 与 `mingdao audit` / `mingdao ledger` 的事，
> 别把任何预设当合规审计开关。

## 项目记忆（自动写入项目目录，默认已自忽略）

会话收尾时会从对话里提炼几条长期有效的结论，写进**当前项目**目录：

```
<你的项目>/.mingdao/memory.md      # 形如「- [2026-09-11] 决定：配置拆成多文件」
```

- 开关：`config.autoProjectMemory`（默认 `true`）；全局记忆另在 `~/.mingdao/memory.md`（`/memory add` 写入）。
- **这个目录会自忽略**：`appendProjectMemory` 在创建 `.mingdao/` 时一并写入 `.gitignore`（内容 `*`），
  以免「关于你和你的工作」的笔记被一次 `git add -A` 顺手提交并推到远端。
- 想跟团队共享项目记忆（例如把约定随仓库传递）：删掉 `<项目>/.mingdao/.gitignore` 即可——
  已存在的 `.gitignore` 不会被程序覆盖，所以你的改动是安全的。
- 记忆按工作空间隔离：A 项目的记忆不会出现在 B 项目的系统提示里。

## 出网白名单（v0.6.0 C3）

`config.json` 的 `net` 字段把「数据不出门」从口头承诺变成可导出的记录：

```json
{
  "net": {
    "allow": ["api.deepseek.com", "*.internal.corp", "10.0.0.0/8", "192.168.1.50"],
    "mode": "warn",
    "allowLoopback": true
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `allow` | 允许的出网目标。四种写法：精确主机（`api.deepseek.com`）、通配子域（`*.example.com`，**不隐含裸域**）、IPv4 CIDR（`10.0.0.0/8`）、精确 IP |
| `mode` | `warn`（默认）：越界请求**放行但逐条记账**，适合「先观测再收紧」；`block`：越界请求直接拒绝并给出放行指引 |
| `allowLoopback` | 默认 `true`。回环（`localhost` / `127.0.0.0/8` / `::1`）始终豁免——它出不了本机，把它算成外发只会制造噪音（本地模型 Ollama/vLLM 是主力场景）。**私网不算回环**，要放行需显式写进 `allow` |

**未配置 `net` 时闸门完全不安装**，既有行为零影响（与约束引擎同款不变量）。

查看与自证：

```bash
mingdao net policy                      # 当前策略与是否生效
mingdao net report                      # 本机访问过哪些外部地址（次数 / 放行 / 拦截 / 命中哪条规则）
mingdao net report --since 7d --json    # 支持 7d / 24h / 90m
```

自更新的 git 远端也会过闸门：`mingdao update` 会先解析远端 URL 并判定，block 模式下若**所有**远端
都不在白名单内则直接拒绝联网（多镜像部署里只要有一个可达即放行）。SSH 的 `git@host:path` 写法同样支持——
否则「白名单里写了 `github.com` 却依然被拦」会变成一个功能故障。

记账写在 `~/.mingdao/net.jsonl`（600 权限，低频轮转），**只记主机、端口、判定与命中规则，不记请求体、不记完整 URL**。启用白名单后，每个回合的账本（`mingdao ledger show`）里也会出现 `net.egress` 事件，与其它事件同处一条时间线。

> ⚠ **这个闸门覆盖什么、不覆盖什么（完整版，请按此理解，不要扩大）**
> 
> 覆盖（内核自己发起、且经过 `globalThis.fetch` 或已显式接线的路径）：
> 模型 API · `fetch` 工具 · 技能库 registry · 模型发现 · 定价数据 · Batch · 云同步（含自签名证书的 `node:https` 路径）
> · **自更新 `git fetch/pull`**（远端 URL 先过闸门，见下）。
> 
> **不**覆盖（都是「内核拉起的别的进程」，它们自己发请求，闸门看不到）：
> - **MCP 服务器**：内核只负责拉起，网络请求由 MCP 进程自己发；
> - **`config.tools` / Pack 工具自己起的子进程**：同上；
> - **桌面版（Electron）外壳自身的更新检查**：那是 Electron 侧的网络栈；
> - **用户在 `bash` 里自己敲的命令**（`curl`/`git`/`pip`…）。
> 
> 所以它证明的是「**内核经由 HTTP 出口与自更新去联系的目标**都在白名单内」，
> 而**不是**「这台机器绝对没有外传」。把它当后者用就是误用——需要进程级强制时，
> 应在操作系统/网关层面做（出网代理、防火墙、EDR），本闸门是**内核自证**工具，不是沙箱。

## Hooks（工具调用生命周期）

```json
{
  "hooks": {
    "PreToolUse":  [{ "matcher": "write|edit|bash", "cmd": "node ~/hooks/pre.js" }],
    "PostToolUse": [{ "matcher": "*", "cmd": "curl -X POST http://localhost:9000/audit" }]
  }
}
```

- `PreToolUse`：工具执行前调用；**只有** stdout 回 `{"decision":"block","reason":"…"}` 才阻止执行
  （非 JSON 的非空输出按 fail-closed 也阻止；输出为空、或 JSON 里 `decision` 不是 `block`（如 `approve`）则放行）。
  > 勘误（v0.6.11）：此处此前写作"命令输出非空即阻止执行"，与实现不符——照它写合规钩子会以为
  > "随便打印点什么就能拦住"，实际必须回那个 JSON 结构。
- `PostToolUse`：执行后调用（审计/日志）；
- 协议：stdin 收 JSON（工具名/参数），stdout 回 JSON；`matcher` 支持 `|` 分隔与 `*` 通配；
- ⚠ **hooks 命令以 `shell: true` 执行——配置即代码执行**：命令会在每次工具调用时运行，请只填自己完全信任的命令（例如不直接填 `curl <不可信地址>`）。

## MCP 服务器

```json
{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/你的/目录"] },
    "everything": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything"] }
  }
}
```

格式与 Claude Code 相同；工具以 `mcp__<服务器>__<工具>` 并入 Agent 循环。

- **只读自动放行需显式授信（v0.4.1 P0）**：带 `readOnlyHint` 的工具默认**不再**自动放行——
  服务器可谎称只读绕过权限确认。只有加了 `"trusted": true` 的服务器，其 `readOnlyHint` 才被
  信任（只读档自动放行、ask 档不询问）；未授信服务器的全部工具（含标注只读的）都走权限确认。

```json
{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/你的/目录"], "trusted": true }
  }
}
```

会话内 `/mcp` 查看状态；`mingdao mcp preset list/add` 一键接入常用服务器。

## WebUI 服务器

```json
{
  "web": { "host": "127.0.0.1", "port": 3820, "token": "可选访问令牌" }
}
```

- 仅本机使用保持默认 `127.0.0.1`（**本机信任模式**：不校验令牌）。启动横幅会明确提示这一点——
  同机的其它进程/其它用户可以直接访问 `/api/*`，多用户机器与共享 CI 上请启用令牌；
- 绑定 `0.0.0.0`/局域网地址时**强制令牌认证**：未配置则每次启动随机生成并打印
  `http://<地址>:<端口>/?token=…` 访问链接；固定令牌（优先级从高到低）：
  `mingdao web --auth-token <令牌>`（或 `--auth-token=-` 从 stdin 读）、环境变量 `MINGDAO_WEB_TOKEN`、`web.token`
  ——即**命令行 > 环境变量 > 配置**（`src/commands/skill.js` 的 `--auth-token` 分支 > `MINGDAO_WEB_TOKEN` > `config.web.token`）。
  > 勘误（v0.6.11）：此处此前把顺序写反成"环境变量、配置、命令行"。文档审计（F-M2 同批）核对了代码，
  > 实际是"命令行优先"——照旧文档配置的人会以为环境变量最高，从而留下一个自己没意识到的固定令牌。
  **命令行字面量会进入 argv 与 shell 历史（`ps` 可见）**，故用它时会给出告警；
- 令牌同时接受 URL `?token=`、请求头 `X-MingDao-Token` 或 `Authorization: Bearer`；
- 服务端校验 `Host` 头必须等于回环名或绑定地址（防 DNS rebinding），代理场景会 403 属预期。
  **例外（v0.6.8 补记）**：当 `host: 0.0.0.0` 且已启用令牌时，服务端**不再校验 Host**——
  此时访问边界是令牌（攻击者页面拿不到令牌）。这是为局域网/手机访问设计的模式，
  所以**必须**配令牌；未显式配置时服务端会自动生成随机令牌（见上文 `web.token`）；
- **跨站浏览器请求一律 403**（按 `Sec-Fetch-Site` 判定，含 `<img>`/`no-cors` 盲打）：
  本机端口不受同源策略保护，这是"任意网页盲打本机 API"的唯一有效拦截点；
- 云元数据端点（`169.254.169.254` 等）在任何绑定与任何开关下**都拒绝**。

## 沙箱环境变量过滤

bash 工具**默认**从子进程环境中剥离敏感变量（`*_API_KEY`、`*_TOKEN`、`*_SECRET`、
`*_PASSWORD`、`*_CREDENTIAL` 等），防止模型驱动的命令一条 `env` 读走密钥——与沙箱档位
无关（`sandbox: "off"` 同样过滤）。按名放行 / 整体关闭：

```json
{ "bashEnvKeep": ["NPM_TOKEN"], "bashEnvFilter": false }
```

## 定价覆盖

内置价格表数据时点为 2026-08（`/api/state` 的 `pricingAsOf` 字段），官方调价后无需等
发版即可覆盖（单位：元/百万 tokens）：

```json
{
  "pricing": {
    "overrides": {
      "deepseek-v4-flash": { "input": 1.5, "output": 4.5, "cacheHit": 0.05, "peak": { "input": 3 } }
    }
  }
}
```

`peak` 缺省的字段沿用闲时价；未覆盖的模型继续用内置价格表。峰谷判断默认锚定**北京时间**
（`Asia/Shanghai`，与 DeepSeek 计费口径一致，海外用户本机时区不再错位），可覆盖：
`"pricing": { "timezone": "Asia/Shanghai" }`。

其他护栏字段：`maxEmptyRounds`（连续空输出续写轮数上限，默认 3——每轮空输出都是全额
completion 计费，防止推理吃满上限时空轮白烧）、`compactTrigger`（自动压缩触发线，默认 0.8）。

## 费用护栏（costGuard）

按北京时间自然日累计实际费用（含缓存折扣与 Batch 半价后的真实口径），Agent 每轮开始前检查：

```json
{ "costGuard": { "dailyLimitYuan": 10, "warnAtYuan": 8, "action": "block" } }
```

- `action: "warn"`（默认）超限仅提醒；`"block"` 到达上限暂停执行（明天自动恢复）；`"downgrade"` 触顶后自动切换到同服务商更便宜模型（如 flash）继续执行并提示（已是 flash 则按 block 处理）；
- `/cost` 与 WebUI 头部费用徽标实时显示「今日费用 / 上限百分比」。

## 战略省钱：Batch 半价 + 避峰调度

- **Batch API（50% off）**：`mingdao batch <问题文件|->` 每行一个问题，单轮批量任务走
  批处理通道（无工具无流式），结果落 `mingdao-batch-result-<时间戳>.jsonl` 并计入 `/cost`
  分账（`batch` 标记）。端点不支持的网关会明确报错；可用 `config.batchBaseUrl` 指定支持
  批处理的网关、`batchEndpoint`/`batchWindow` 覆盖协议字段。
- **避峰执行（高峰输入价 2 倍）**：`mingdao run --offpeak` / `mingdao schedule add --offpeak`
  ——高峰时段（北京时间工作日 9:00–12:00、14:00–18:00 两段）自动顺延到最近闲时（12:00 / 18:00）执行；**周末与午间 12:00–14:00 按闲时计价**
  · `pricing.peakWindows`：高峰窗口覆盖（[[起,止],...] 北京时间整点）；`pricing.timezone`：计价时区
  · `pricing.source`：官方价格 JSON 地址（`mingdao update --pricing` 拉取，TTL 默认 7 天，`pricing.ttlDays` 可调）；`pricing.overrides`：按模型覆盖价格
  · `reasoningByModel`：思考强度按模型独立覆盖，`{ "deepseek-v4-pro": "low" }`（`off`/`low`/`high`/`max`，默认模型内置 high；`off` 显式关闭思考省推理 token；REPL `/think` 或 WebUI 设置「模型与密钥」→ 思考模式开关 + 推理等级）；旧版全局 `reasoningEffort` 仍兼容，优先级低于 `reasoningByModel`
  · `routing.upgradeSteps` / `routing.upgradeTruncated`：粘滞 flash 会话累计步数/截断超过阈值自动升 planner（默认 10 / 2）
  （DeepSeek 官方邮件确认），不触发避峰等待。WebUI 调度面板勾选「🌙 避峰执行」。

## 云同步

```json
{
  "sync": {
    "url": "https://session.mingdao.ai",
    "username": "you",
    "deviceName": "我的笔记本",
    "auto": true
  }
}
```

设备 token 存凭证库（`credentials.json` 的 `sync` 字段），配置里只留非秘密项。自建自签证书
过渡阶段可加 `"insecure": true`（正式证书就绪后删除）。详见 README「云同步与多用户协作」。

同步**服务端**（`mingdao sync-server`）支持注册开关环境变量：
`MINGDAO_SYNC_REGISTRATION=open|invite|closed`（默认 open）+ `MINGDAO_SYNC_INVITE_CODES=码1,码2`
（invite 模式生效），公网自建建议至少 `invite`。

## 会话日志与「带上文」（跨会话连续性）

每个会话结束时写入 `~/.mingdao/journal.jsonl`（首条用户消息 + 结果摘要）。**默认不注入**新会话的
系统提示——新会话应当全新开始，避免「新会话却接着上一次会话的工作」的上下文混淆；需要延续上次
工作时显式开启：

- WebUI：输入框下方「📌 带上文」勾选（仅本次发送生效）；
- CLI：`mingdao --journal`（新会话或 `--continue` 均可叠加）。

长期偏好仍走用户记忆（`AGENTS.md`，见上），不受此开关影响。

## 自定义模型（WebUI 添加后落盘的结构）

```json
{
  "customModels": {
    "my-gpt4": { "label": "我的 GPT-4 网关", "baseUrl": "https://gateway.example.com/v1" },
    "my-ds": { "label": "自建 DeepSeek 网关", "baseUrl": "https://gw.example.com/v1", "tokenizer": "deepseek" },
    "local-qwen": { "label": "本机 Qwen", "baseUrl": "http://127.0.0.1:8081/v1", "contextWindow": 131072, "maxOutputTokens": 8192 }
  }
}
```

自定义模型的 Key 存凭证库 `custom:<模型名>` 键下；增删改建议直接用 WebUI 设置面板完成。

自定义端点若跑的是 DeepSeek 系模型（模型名不以 `deepseek` 开头时默认走启发式估算、预算误差
可达 ±2 倍），加 `"tokenizer": "deepseek"` 即按官方词表精确计数：

### 本地模型自适应（v0.3.2）

本机/内网部署的推理框架（baseUrl 为 `127.0.0.1`/`localhost`/私网 IP）自动按「资源有限」对待，
避免长任务把上下文撑到窗口边缘后 prefill 指数恶化、被客户端超时掐断（典型：127k 上下文首 token
需 200s+，客户端 3 分钟无响应断开 → network error）。机制：

- **上下文窗口感知**：`customModels.<name>.contextWindow` 显式声明模型真实窗口；未声明时本地
  模型兜底 **32k**、远程兜底 **128k**。
- **安全预算**：`contextBudget` 会被自动收紧到 `min(contextBudget, 窗口×75%, 窗口−maxOutput−余量)`，
  prompt 永不逼近窗口边缘（75% 舒适区以上 prefill 时间陡增）。
- **边缘检测**：模型每轮上报真实 `prompt_tokens`，≥ 窗口 85% 时下一轮强制压缩历史（即使启发式
  计数低估也强制触发）。
- **工具输出截断**：单条工具结果按 `窗口/16` 封顶（最少 2000 字），小窗口不再整条回灌大段代码。
- **分层超时**：`timeout.firstTokenMs`（首 token 等待，本地默认 600s / 远程 300s）、
  `timeout.streamIdleMs`（流式空闲，默认 120s）、`timeout.totalMs`（总量，本地 30min / 远程 10min），
  留空则自适应；本地慢 prefill 不再被一刀切超时误杀。

```json
{ "timeout": { "firstTokenMs": 600000, "streamIdleMs": 120000, "totalMs": 1800000 } }
```

#### 单请求超时之外的"回合级"护栏（v0.6.13）

上面三个超时**都是单请求级**：一次请求最多耗到 `totalMs`。而一个回合最坏是
`maxRounds × stepLimit` 次请求（默认 3 × 24 = 72），`task` 子代理各自还有一整套预算且可递归派生——
真机实测出现过「本地 35B 的审计回合跑了 4 小时 20 分、界面 0 步、`web-server.log` 只有一行」的现场
（`audit.jsonl` 里那 4 小时里有 610 次工具调用，绝大多数是**逐字重复**的失败调用）。
所以补了一条回合级判据：

```json
{ "noProgressTimeoutMs": 3600000 }
```

- **判据**：连续 N 分钟**既没有"成功且不重复的工具结果"、也没有新的正文/推理增量** → 主动中止整个
  回合，并如实报告「连续 N 分钟没有任何工具调用、也没有新内容，已中止」+ 已发生的模型轮次/工具调用数，
  外加**中止时正在等待哪个工具、等了多久**，以及与 `capped`/`aborted` 的区别
  （capped = 跑满步数上限、可续跑；aborted = 你点的停止；stalled = 再等下去也不会产出新东西）。
  重复调用（name+args 完全相同）与失败调用**不算进展**——真机现场正是它们把时间烧光的。
- **默认 60 分钟**的依据：现有单请求总量上限是本地 1800s；回合级阈值取它的 **2 倍**，
  保证"一次慢 prefill"永远由更具体的请求级超时（首帧/空闲/总量各有文案）先说话，看门狗不抢答；
  而真干活的回合每隔几秒就有工具结果或正文增量，60 分钟零增量在任何正常回合都不可能。
- 该值**不能**用 0/负数/Infinity 关掉（一律回落默认，fail-safe）；子代理会**继承父回合的阈值**
  （24 个并行子代理不会各跑各的几小时），且继承的**截止时刻是活的**——它随父回合的进展前移。
- **子代理的进展算父回合的进展**（v0.6.13 真机修复）：父回合在 `await task` 期间拿不到任何中间信号，
  所以子代理每有一次真实进展（成功且不重复的工具结果 / 新正文增量）就回调父回合，父回合据此续期，
  并把快照挂在 `io.turnProgress.subagent` 上——`web-server.log` 的进度行与界面状态条因此能写出
  「正在等待工具 task（已 620s）· 子代理「审计 agent.js」已跑 12 轮 / 17 次工具调用，最后进展 3s 前」，
  "在等子代理"与"卡死"才分得开（真机现场日志里只有前者，看不出子代理是在干活还是死了）。
- **子代理卡住由它自己的看门狗先响**：父回合在等待子代理时只多等 15s
  （`SUBAGENT_WAIT_GRACE_MS`，相对默认 60 分钟是 0.4%——**不是**放宽阈值），
  这样子代理的收口结论（"自己无进展"还是"父回合整轮无进展"）能原样回传父回合，
  而不是被父回合抢先掐断、只剩一句"父回合中止"。
- **stalled 在界面上必须有说明**：内核发一条告警 banner（内容与 `done.note` 同源），
  前端在消息下方再留一条，并把结局（含两种 stalled 原因）写进控制台
  ——桌面壳日志取的就是渲染进程 console，此前那里只有「回合收尾：generating=false」，
  与内核的 `status=stalled` 对不上。

#### 端点预检（v0.6.13，本地端点自动执行）

对**本地端点**（baseUrl 是回环/内网，或 `customModels.<名>.local: true`）在开工前做一次轻量预检
（结果缓存 10 分钟，只读不写你的配置）：

1. 读**引擎自述上下文**（`GET /props`，见下一条）——配置的 `contextWindow` 超没超引擎能力，只有这里能知道；
2. 发 **3 次**极小请求（1 条 user + 1 个工具声明 + `max_tokens: 256`），看 `tool_calls` 与 `finish_reason`，
   给出三态之一：**稳定支持**（3/3）/ **不稳定**（N/3，会提示"agent 任务可能步数为 0"）/ **不支持**（0/3）；
   被 `max_tokens` 截断的样本（`finish_reason: length`，思考型模型常见）判为**不可判定**，不当作"不支持"；
   （引擎实际加载的模型名从 chat 响应的 `model` 字段读——**不**额外打 `GET /models`：有的端点没实现它，
   而 llama.cpp 在流式响应里直接回完整文件路径，语义等价且少一个请求。）
3. 再发一次 **参考 prefill**（约 2000 tokens 的提示）测耗时；
4. 与本机历史值比对：**同一端点明显变慢**（≥3 倍）会提示"该端点可能仍在处理上一个请求，建议重启引擎"。

#### 预检读「引擎自述上下文」（v0.6.13）

本地端点预检时**额外读一次引擎自述**（`GET /props`，只读、不改配置）：

- llama.cpp 的 `/props` 通常返回 `default_generation_settings.n_ctx`（有的版本另有顶层 `n_ctx`/`n_ctx_train`）；
  其他引擎能读多少读多少（`max_model_len`、`context_length`、`model_info.*.context_length`），
  **读不到就跳过并说明**（不猜、不编造、也不据此判定端点不行）。
  `/props` 挂在根上，而 `baseUrl` 通常带 `/v1`，预检会先剥掉 `/v\d+` 再试，失败再退回原样。
- **什么时候会去打这个请求**：只有端点**自报了模型名**才打。llama.cpp 家族（含 llama-cpp-python/
  koboldcpp/LM Studio）总会在响应里回模型名或模型文件路径；回不了名的多半是"只实现了
  `/v1/chat/completions`"的网关或测试桩——它们不认识 `/props`，多打一个 GET 可能把对方打断
  （本仓 `test/e2e-web.js` 的 mock 就是这样被打挂的：它只按 `POST + JSON body` 解析）。
  跳过时结论里会写「引擎自述上下文：跳过（该端点未自报模型名，不确认它实现 /props）」，
  不会假装核对过。
- 结论会与配置**并排**写出来，同时出现在界面 banner、`web-server.log`
  （`预检 <模型> … 引擎自述上下文=… 配置=…`）与发送前的规模预告里：

  ```
  ⚠ 引擎自述上下文 32768 vs 配置 131072 —— 配置超出引擎能力，长上下文将直接被引擎拒绝
  ```

- 为什么这条必须有：真机实测配置 `contextWindow: 131072`、引擎只装了 32768，
  15,983 tokens 的 prompt 在 prefill 阶段就被引擎拒绝（`insufficient memory: the request exceeded
  available GPU memory … during prefill`）。此时**换预设、调小 `contextBudget`、调大 `timeout.*`
  都无效**——它们改不了引擎的 `n_ctx`；要么在引擎侧把上下文窗口调大
  （llama.cpp 的 `--ctx-size` / `--context-window`），要么把 `customModels.<名>.contextWindow` 改成 ≤ 引擎值。

#### 发送前的规模预告由预检实测推导（v0.6.13）

回合开始前的 `📏 本轮上下文 ≈ …` 预告，在**有预检实测**时按
`参考 prefill 耗时 × 本轮 tokens ÷ 参考 tokens` 线性外推，并在文案里注明这是外推、以及
"长上下文下引擎可能显著变慢"的实测差值（本机 16k tokens 首帧 53.7s，而按同一份预检外推只有 0.6s）——
只报乐观值会训练用户忽略这条告警。**只有拿不到预检数据**（端点不可达 / 不可判定）时才退回
"prefill 可能需数分钟至数十分钟"的保守文案；外推超过 60s（`PREFILL_SLOW_WARN_MS`）才告警，
且必须写出依据（预检实测值 + 本轮 tokens + 阈值）。

预检结论会出现在：回合开始时的界面 banner、`web-server.log`（`预检 <模型> …` 行）、
以及发送前的规模预告里。并且**按实测 TTFT 自适应**超时：首帧上限 = clamp(max(实测首帧×20, 参考prefill×5),
既有默认, 1800s)、无进展看门狗 = clamp(max(实测首帧×100, 参考prefill×20), 10min, 60min)；
**你显式配置的 `timeout.*` / `noProgressTimeoutMs` 永远优先**（显式 > 自适应）。

### 用本地模型测 harness（测试者步骤清单）

> 这一段是**操作清单**，不是原理说明。按顺序做，能在几分钟内区分"端点不行"和"harness 不行"。

**第 0 步：确认引擎在跑、名字对不对**

```bash
curl -s http://127.0.0.1:8081/v1/models | head -c 400      # 端口按你的部署改
```

- 返回里应当看到**配置项名**对应的模型。若引擎回的是完整文件路径/别的名字（本机实测：
  配置 `MLocalModel3.6.2`，引擎回 `/Users/…/mLocalModel3.6.2.gguf`），预检会把两者都写出来——
  先确认"配的就是跑的那个"，再谈性能。

**第 1 步：先跑预检（一条命令看到 TTFT 与工具支持）**

预检在**每轮对话开始前自动执行**（仅本地端点），界面上会出现两行：

```
🔎 本地端点预检：✅ 稳定支持工具调用（3/3） · 首帧 1.22s · 参考 prefill 2000 tokens 9.71s · 引擎加载 …gguf
   自适应：首帧上限 600s、无进展看门狗 60 分钟（依据：预检实测 首帧 1220ms + 参考 prefill 9708ms）
```

同一条结论会落进 `~/.mingdao/logs/web-server.log`（`预检 <模型> <状态>(<toolState> N/M) ttft=… prefill2000=…`）。
看到这些就说明通路与能力都测过了；**不要**跳过这步直接放大任务。

**第 2 步：小任务验证通路**

```
帮我看看这个仓库的 README，列出三层小标题
```

验收标准：几十秒内出现正文；`web-server.log` 里有 `chat 首帧 <taskId> <秒>` 与每 30s 一行的
`chat 进度 <taskId> 已跑 …阶段=… 模型轮次=… 工具调用=…`；界面状态条上有「工具调用 N 次」（0 也要显示为 0）。

**第 3 步：按模块切分，再放大**

35B 级模型 + 131k 窗口做**全量仓库审计**时：上下文越大，prefill 越久（本机实测 35B Q4_K_M
约 4.9ms/token：2 万 tokens ≈ 1.6 分钟；13 万窗口 ≈ 10 分钟以上，且会顶满引擎内存预算）。
所以：

- 先用预设 `local-model`（`contextBudget` 65536）或自己在预设里调小 `contextBudget`；
- 一次只做一个模块/一个目录，别一次喂整仓；
- 真要长跑，把 `timeout.firstTokenMs` 调大（例如 900000）——但要知道**这只会让失败更晚被发现**，
  不会让 prefill 变快。

**第 4 步：认识四类"卡住"分别长什么样**

| 现象 | 内核会给什么信号 |
| --- | --- |
| 引擎没起来 / 端口不对 | 预检 `❌ 不可达：…`；请求以 `网络请求失败` 报错（几秒内） |
| 连上但不发首帧 | 到 `timeout.firstTokenMs` 报「首 token 等待超限（Ns，本地模型长上下文 prefill 可能很慢）——可调大 config.timeout.firstTokenMs…」 |
| 有帧但长时间没新数据 | 到 `timeout.streamIdleMs`（默认 120s）报「流式响应空闲超限（Ns 无新数据）」 |
| 每轮都能返回、但什么都没做成 | 到 `noProgressTimeoutMs`（默认 60min，快端点自适应到 10min）报「连续 N 分钟没有任何工具调用、也没有新内容，已中止」，并附**中止时正在等待哪个工具/等了多久**；界面另有告警 banner（与 `capped` 跑满步数、`aborted` 你点的停止**区分开**） |
| 一直在等 `task` 子代理 | 进度行/状态条会写出**子代理自己的进度**（第几轮、几次工具调用、最后进展距今多久）；子代理有进展时父回合不会被判无进展，子代理真卡住则由**它自己的**看门狗先中止并把原因回传父回合 |
| 引擎装不下配置的窗口 | 预检读 `GET /props` 得到引擎自述上下文，与配置并排；配置超出即告警「配置超出引擎能力，长上下文将直接被引擎拒绝」（换预设/调 `contextBudget` 都无效） |
| 上游 4xx/5xx（模板/内存/鉴权…） | 错误里带**上游原文**并附一条可操作判断（例如"该端点的模板不接受当前 messages 形态"） |

**第 5 步：模型不支持工具调用时会怎样**

若预检判定 **不支持/不稳定**，或整回合 0 次工具调用：回合结束时界面会明确写出
「⚠ 本回合 0 次工具调用（共 N 轮模型请求 / M 步）：该端点看起来不返回 tool_calls」——
不会出现"看起来在工作、其实什么都没做"。此时换支持 function calling 的端点，或只把它用于纯问答。

### 文件访问边界（v0.4.1 P0 路径穿越防护）

read/write/edit/ls/glob/grep/undo 默认限定在**工作目录**内——auto 权限模式下，模型（或被提示注入
诱导）也无法读 `~/.ssh`、`~/.mingdao/credentials.json`（API Key 明文）等越界文件；`realpath` 逐级
校验防软链接逃逸。需要访问工作目录外时，显式加白名单：

```json
{ "fsAllowDirs": ["/home/you/projects/shared", "/tmp/build-output"] }
```

白名单目录同样受 `realpath` 校验（目录内的软链接指向白名单外仍拒绝）。

## 自定义 Provider 模块（非 OpenAI 兼容协议）

在 `~/.mingdao/providers/<name>.mjs` 导出：

```js
export async function createProvider(cfg) {
  // cfg: { name, baseUrl, apiKey, envHint, ... }
  return { name: 'my-provider', async chat(opts) { /* 返回流式响应对象 */ } };
}
```

`provider` 填模块名即生效。完整协议见 [PROVIDERS.md](PROVIDERS.md)。

## 辅助调用结构化输出与并行子代理

- 标题生成/记忆提取/路由分类器三类辅助调用走 `response_format: json_object`（maxTokens
  120→50、300→200、80→20），解析失败自动回退纯文本路径——不支持的网关静默兼容。
- `task` 子代理工具支持 `readOnly: true`：只读调研任务（read/ls/glob/grep/skill）自动并行
  执行（auto 权限模式下），写类任务仍串行。
- 调度器为**单守护进程**：`mingdao schedule daemon [status|stop]` 查看/停止；有任务时任意
  schedule 命令自动拉起，无任务自动退出（每任务一个 sleeper 进程的旧方案仅作兜底）。

## 账本来源签名（v0.6.11：`mingdao ledger --sign-key`）

哈希链 + 封条证明的是「这份账本自写入后没被改动、尾部没被截断」，但它们的全部输入都来自
账本自身、算法（sha256）是公开的——**改内容 + 逐行重算 prev + 改写封条**之后照样逐项吻合
（实测复现，见 `docs/internal/AUDIT-v0.6.1-第三方报告登记.md` §3.45）。来源签名补上的是另一半：
「这条账本是不是**持有本机那把密钥**的一方写的」。

```bash
mingdao ledger --sign-key                 # 查看密钥状态（只显示公钥与指纹，绝不回显私钥）
mingdao ledger --sign-key --generate      # 生成密钥 → <home>/ledger-key.json（权限 600）
mingdao ledger --sign-key --generate --force   # 覆盖已有密钥（会让旧账本变成"另一把密钥签发"，先备份）
mingdao ledger verify <runId>             # 链/封条 + 来源签名（默认用本机密钥验签）
mingdao ledger verify <runId> --key <文件>     # 用指定公钥验签（本模块密钥文件，或 PEM/SPKI 公钥）
```

- **算法 ed25519**（`node:crypto` 原生，零新增依赖）：非对称，公钥可以交给第三方复核，
  对方能验证「由那把密钥签发且未被改动」，但**不能**补签一份新账本。HMAC 做不到这一点——
  它的验证密钥就是签名密钥，把审查权交出去等于把伪造能力一起交出去。
- **密钥文件** `<home>/ledger-key.json`：权限 600、原子写、**绝不进 `config.json`、凭证库
  （`credentials.json`）与仓库**。不并进凭证库是因为 `key remove` / `key import` 会全量重写它，
  顺手一次就会把签名密钥清掉、让全部历史账本变成"另一把密钥签发"。
- **默认开启**：新账本在首次收尾时若本机还没有密钥会**自动生成**并签名（可选签名在合规上等于
  没有签名）。封条里带 `sig{alg,keyId,value}`，`run.end` 链内带 `sigKey`（公钥指纹）。
- **`ledger verify` 的三种结论**（前两者退出码 0，第三者非 0）：

  | 结论 | 含义 | 退出码 |
  | --- | --- | --- |
  | 链完整 + 签名有效 | 由持有该密钥的一方写入，且内容/封条自签名后未被改动 | 0 |
  | 链完整但无签名 | 写于启用签名之前的老账本（或签名证据被整体抹除，两者本项无法区分）——只证明哈希链完整 | 0 |
  | 链完整但签名无效 | 内容被改写后重算过链，或换了一把密钥签发（含"本条账本来自另一台机器"） | 非 0 |

  另有第四态「签名无法校验」（本机/`--key` 没有对应公钥）同样非 0——**不能确认来源**不等于通过。
- **诚实边界**：私钥与账本同机同权限，能改账本的对手通常也能读私钥，本层不防同权限的本机对手；
  不含可信时间戳，不等同于审计级不可否认；私钥丢失后历史账本只能报"由另一把密钥签发"。

## 月度费用报告

`mingdao cost` 控制台速览；`mingdao cost report [YYYY-MM|all]` 导出 Markdown 报告
（按模型分账、每日费用柱状图、缓存命中率、Batch 子项），文件落当前目录
`mingdao-cost-report-<月>.md`。数据源为 cache-stats.jsonl（含缓存折扣与 Batch 半价的真实口径）。

