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
| `contextBudget` | 上下文预算 tokens（模型预设默认值：flash 128k / pro 200k） |

可选字段：`temperature`、`maxOutputTokens`、`includeUsage`（流式请求 usage 统计，个别网关不支持
`stream_options` 时设 `false`）、`autoTitle`（自动生成会话标题，默认开）、`notify`（任务桌面通知，默认开）、
`autoCompact`（上下文自动压缩，默认开，见下）、`audit`（工具调用审计，默认开，见下）。

## 工具调用审计（P3-5）

每个工具调用（含被拒/被钩子阻止/参数解析失败）自动落 `~/.mingdao/audit.jsonl`（600 权限）：
时间、会话、模型、工具名、参数（`sk-` 系 Key 自动脱敏）、执行结果/退出码/超时/耗时/输出大小、
拒绝原因。查看：`mingdao audit [数量]`（默认 20 条）或会话内 `/audit`；`"audit": false` 关闭。
超过 20000 行自动保留最近 10000 行。

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
`"compactTrigger": 0.9` 调整触发线（0–1 之间的小数）。

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
- **需要特殊授权时弹窗交互**：被 `deny` 规则拦截、或 `readonly` 模式下执行写操作时，WebUI/TUI 会弹出询问（「是否本次强制放行？」），同意即放行、拒绝/无响应即拒绝——不再静默拦截。

## Hooks（工具调用生命周期）

```json
{
  "hooks": {
    "PreToolUse":  [{ "matcher": "write|edit|bash", "cmd": "node ~/hooks/pre.js" }],
    "PostToolUse": [{ "matcher": "*", "cmd": "curl -X POST http://localhost:9000/audit" }]
  }
}
```

- `PreToolUse`：工具执行前调用，命令输出非空即阻止执行（返回的文本交给模型）；
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

格式与 Claude Code 相同；工具以 `mcp__<服务器>__<工具>` 并入 Agent 循环，带 `readOnlyHint`
标注的工具自动放行。会话内 `/mcp` 查看状态；`mingdao mcp preset list/add` 一键接入常用服务器。

## WebUI 服务器

```json
{
  "web": { "host": "127.0.0.1", "port": 3820, "token": "可选访问令牌" }
}
```

- 仅本机使用保持默认 `127.0.0.1`（无需令牌）；
- 绑定 `0.0.0.0`/局域网地址时**强制令牌认证**：未配置则每次启动随机生成并打印
  `http://<地址>:<端口>/?token=…` 访问链接；固定令牌三种方式（优先级从高到低）：
  `mingdao web --auth-token <令牌>`、环境变量 `MINGDAO_WEB_TOKEN`、`web.token`；
- 令牌同时接受 URL `?token=`、请求头 `X-MingDao-Token` 或 `Authorization: Bearer`；
- 服务端校验 `Host` 头必须等于回环名或绑定地址（防 DNS rebinding），代理场景会 403 属预期。

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
  · `reasoningEffort`：思考强度 `off`/`low`/`high`/`max`（默认模型内置 high；`off` 显式关闭思考省推理 token；REPL `/think` 或 WebUI 设置「通用与权限」→ 思考模式开关 + 推理等级）
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

## 会话日志与「带上文」（跨会话连续性）每个会话结束时写入 `~/.mingdao/journal.jsonl`（首条用户消息 + 结果摘要）。**默认不注入**新会话的
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
    "my-ds": { "label": "自建 DeepSeek 网关", "baseUrl": "https://gw.example.com/v1", "tokenizer": "deepseek" }
  }
}
```

自定义模型的 Key 存凭证库 `custom:<模型名>` 键下；增删改建议直接用 WebUI 设置面板完成。

自定义端点若跑的是 DeepSeek 系模型（模型名不以 `deepseek` 开头时默认走启发式估算、预算误差
可达 ±2 倍），加 `"tokenizer": "deepseek"` 即按官方词表精确计数：

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

## 月度费用报告

`mingdao cost` 控制台速览；`mingdao cost report [YYYY-MM|all]` 导出 Markdown 报告
（按模型分账、每日费用柱状图、缓存命中率、Batch 子项），文件落当前目录
`mingdao-cost-report-<月>.md`。数据源为 cache-stats.jsonl（含缓存折扣与 Batch 半价的真实口径）。

