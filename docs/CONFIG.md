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
`stream_options` 时设 `false`）、`autoTitle`（自动生成会话标题，默认开）、`notify`（任务桌面通知，默认开）。

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
- 协议：stdin 收 JSON（工具名/参数），stdout 回 JSON；`matcher` 支持 `|` 分隔与 `*` 通配。

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
  "web": { "host": "127.0.0.1", "port": 3820 }
}
```

仅本机使用保持默认 `127.0.0.1`；远程/多设备使用改为 `0.0.0.0` 时请注意端口安全。

## 云同步

```json
{
  "sync": {
    "url": "https://你的同步服务器",
    "username": "you",
    "deviceName": "我的笔记本",
    "auto": true
  }
}
```

设备 token 存凭证库（`credentials.json` 的 `sync` 字段），配置里只留非秘密项。自建自签证书
过渡阶段可加 `"insecure": true`（正式证书就绪后删除）。详见 README「云同步与多用户协作」。

## 自定义模型（WebUI 添加后落盘的结构）

```json
{
  "customModels": {
    "my-gpt4": { "label": "我的 GPT-4 网关", "baseUrl": "https://gateway.example.com/v1" }
  }
}
```

自定义模型的 Key 存凭证库 `custom:<模型名>` 键下；增删改建议直接用 WebUI 设置面板完成。

## 自定义 Provider 模块（非 OpenAI 兼容协议）

在 `~/.mingdao/providers/<name>.mjs` 导出：

```js
export async function createProvider(cfg) {
  // cfg: { name, baseUrl, apiKey, envHint, ... }
  return { name: 'my-provider', async chat(opts) { /* 返回流式响应对象 */ } };
}
```

`provider` 填模块名即生效。完整协议见 [PROVIDERS.md](PROVIDERS.md)。
