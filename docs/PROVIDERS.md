# 模型接入指南（Provider）

MingDao 支持三种接入方式，从易到难：

## 密钥存放与解析

所有接入方式的 Key 统一由**独立凭证模块**管理，绝不写入 `config.json`：

- 默认位置：`~/.mingdao/credentials.json`（权限 600，仅本机可读）；
- 管理命令：`mingdao key`（status 脱敏显示）/ `key set <服务商>` / `key remove` / `key import`；
- 解析优先级：**环境变量 > 本地凭证库 > config.json 显式字段**；
- `mingdao init` 向导中输入的 Key 自动存入凭证库。

## 方式一：内置服务商预设

`mingdao init` 直接选择：

| 服务商 | 默认 baseUrl | 环境变量 |
| --- | --- | --- |
| deepseek | https://api.deepseek.com/v1 | DEEPSEEK_API_KEY |
| openai | https://api.openai.com/v1 | OPENAI_API_KEY |
| qwen（阿里云百炼） | https://dashscope.aliyuncs.com/compatible-mode/v1 | DASHSCOPE_API_KEY |
| glm（智谱） | https://open.bigmodel.cn/api/paas/v4 | ZHIPUAI_API_KEY |
| moonshot（Kimi） | https://api.moonshot.cn/v1 | MOONSHOT_API_KEY |

## 方式二：任意 OpenAI 兼容端点

任何兼容 `POST /chat/completions`（含工具调用）的服务都能直接用：

```json
// ~/.mingdao/config.json（不含密钥）
{
  "provider": "custom",
  "model": "your-model-name",
  "baseUrl": "https://your-gateway.example.com/v1",
  "permission": "ask"
}
```

密钥用 `mingdao key set custom` 存入凭证库，或使用环境变量 `MINGDAO_API_KEY`。适用：本地 vLLM/Ollama(OpenAI 兼容模式)/OneAPI/各种中转网关。

## 方式三：自定义 Provider 模块（非 OpenAI 兼容协议）

> 说明：DeepSeek-V4 正式版官方同时提供 Responses API 与 Anthropic 兼容接口。MingDao 默认走 OpenAI 兼容的 chat/completions（覆盖全部 V4 能力，含工具调用），如确需原生协议，可按下面方式写对应模块。

在 `~/.mingdao/providers/<名称>.mjs` 导出 `createProvider(cfg)`，返回带 `chat(opts)` 的对象：

```js
// ~/.mingdao/providers/anthropic.mjs
// 示例：Anthropic 原生协议适配骨架
export async function createProvider(cfg) {
  // cfg: { name, baseUrl, apiKey }
  return {
    name: 'anthropic',
    async chat({ model, messages, tools, temperature, maxTokens, onDelta }) {
      // 1. 把 OpenAI 格式 messages/tools 翻译成 Anthropic 格式
      // 2. 请求 https://api.anthropic.com/v1/messages（流式）
      // 3. 把增量文本/工具调用翻译回 MingDao 格式，边收边 onDelta
      // 返回结构（与内置 OpenAI 兼容层一致）：
      return {
        text,          // string：最终正文
        reasoning,     // string|null：推理内容（可选，dim 展示）
        toolCalls,     // [{id, type:'function', function:{name, arguments}}] | null
        usage,         // {prompt_tokens, completion_tokens} | null
        finish,        // 'stop' | 'tool_calls' | 'length' | null
      };
    },
  };
}
```

然后配置：

```json
{ "provider": "anthropic", "model": "claude-sonnet-4-5", "apiKey": "sk-ant-..." }
```

规则：`provider` 名不在内置预设中且存在同名模块文件时，优先加载该模块；否则按 OpenAI 兼容方式使用 `baseUrl`。

## 模型预设（src/models.js）

每个模型预设定义：`provider` / `contextWindow` / `budgetTokens`（默认注入预算）/ `maxOutputTokens` / `temperature` / `supportsReasoning`。自定义模型名没有预设时使用安全默认值（预算 128k、输出 8k、温度 0.6），都可以在 `config.json` 用 `contextBudget` / `maxOutputTokens` / `temperature` 覆盖。

## 新增内置模型（提 PR 或本地修改）

在 `src/models.js` 的 `MODELS` 中加一条即可，例如：

```js
'my-new-model': {
  label: '某新模型',
  provider: 'custom',      // 或已有服务商
  contextWindow: 262144,
  budgetTokens: 128000,
  maxOutputTokens: 16384,
  temperature: 0.6,
  supportsReasoning: false,
},
```
