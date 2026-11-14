# DeepSeek 应用全家桶 API（v0.8.0）

> 读这篇的人分两类：**用的人**只看 §1/§5，**维护的人**看 §3/§7。
> 实现：`src/deepseek-app.js`（零依赖、可注入 fetch）；回归：`test/deepseek-app.js`（17 项）；
> 变异守卫：`test/mutate/batch90-app-api.mjs`。协议以官方文档与
> [chat-demo 源码](https://github.com/deepseek-ai/chat-demo) 为准，本文不重复抄字段表。

## 1. 能力清单

| 能力 | 开关（Messages 请求） | 客户端要做的 |
| --- | --- | --- |
| 联网搜索 | `tools: [deepseek_web_search]`，`thinking` 关 | 渲染 `server_tool_use` + `web_search_tool_result`，引用用 `citations` |
| 深度思考搜索 | 同上，`thinking` 开 | 同上；多出 `open_page` / `find_in_page` 步骤 |
| 阅读链接 | `tools: [deepseek_read_url]`（默认开） | 保留 `web_fetch_tool_result` 的 `signature`，下一轮原样回传 |
| 文件输入 | 先 `POST /anthropic/v1/files` 拿 `file_id`，请求里放 `document` 块 | 上传时定 `purpose`；引用文件带 `anthropic-beta` 头 |
| 安全校验 | `safety_check: {level:'high'|'low'}` | 处理 `stop_reason: refusal`（换成拒答文案） |
| 会话标题 | `title: {enabled:true}` | 从 `message_delta.delta.title` 取，**不再单独调一次模型** |
| 日期/位置提醒 | `latest_reminder` 文本（见 §4） | 拼进 system 或首条 user 消息 |
| ASR（语音转文字） | `POST {base}/v1/tools/asr`（multipart） | Bearer 鉴权；取回 `text` |
| TTS（朗读） | `POST {base}/v1/tools/tts`（JSON） | Bearer 鉴权；返回裸 PCM（24kHz 单声道 16-bit 小端） |

端点与鉴权：对话 `POST {base}/anthropic/v1/messages`（`x-api-key`）；文件 `POST {base}/anthropic/v1/files`
（`x-api-key` + beta 头）；语音两个端点用 `Authorization: Bearer`。模型用 `deepseek-flash`；
`supportsAppTools()` 之外的模型**不要**下发这些字段（400）。

文件 `purpose` 三档（官方用「解析两档 + user_data」表述）：

| `purpose` | 模型拿到什么 | 适用 |
| --- | --- | --- |
| `rich_layout_recognition`（默认） | 正文 + 原位置的图表/照片 | 报表、幻灯片、带图手册 |
| `text_recognition` | 仅正文，图全部丢弃 | 合同、论文、扫描文本 |
| `user_data` | 不解析：txt/md/csv/json/源码/XLSX/EPUB 直接转 Markdown | 纯文本与表格、电子书（不按页计费） |

## 2. 为什么是性能改进（可测口径，不编毫秒）

这不是「又接了一个功能」，而是把两次往返压成一次：

- **服务端搜索**：客户端工具循环里，每搜一次都要「模型 → 工具 → **再发一次带全上下文**」；
  应用模式里 `search → open_page → find_in_page → 作答` 全在一次 HTTP 请求内完成。
  可测口径：`test/deepseek-app.js` ⑰ 断言 **一轮深度思考搜索只发 1 次 `fetch`**（`calls === 1`），
  会话越长省下的重发 token 越多。
- **服务端标题**：标题随 `message_delta` 返回，省掉每个会话一次独立的标题补全请求（少 1 次调用）。
- **文件解析**：版面解析在服务端上传阶段完成，客户端不再整包读文本再塞进消息。

上述三条都能用「请求次数 / 重发 token 数」量，不需要秒表；我们不承诺具体延迟数字。

## 3. 协议要点与坑

1. **服务端工具与客户端工具互斥**：同一请求里不能既有 `deepseek_web_search`/`deepseek_read_url`
   又有自定义 `tools`——官方明确 400。所以本路径只服务「纯问答/搜索」；要改文件、跑命令走 Agent。
2. **`tool_choice` 不能指定服务端工具**（400）；设成 `none` 会把工具全关，**包括阅读链接**。
   搜索/阅读由模型自己决定。
3. **`safety_check` 会忽略一批采样参数**。请求同时声明服务端工具、`safety_check: high` 或 `title` 时，
   官方按 Chat Completions 列的忽略表为准：`temperature`、`top_p`、`frequency_penalty`、
   `presence_penalty`、`stop`、`seed`、`n`、`preserve_thinking`、`parallel_tool_calls`。
   另：`max_tokens` 正常生效，但只限**每一步推理**的输出，不是整轮总输出。
4. **`read_link` 的页面正文在 `signature` 里**，`content.source.data` 恒为空串。多轮必须把上一轮
   assistant 块**原样**（含 `kind`、`tool_use_id`、`signature`）回传，页面才会被还原进上下文；
   `signature` 丢了不报错、但页面静默丢失。`url`/`title`/`data` 只用于展示，改了没用。
5. **`stop_reason: refusal` 要替换为拒答文案**：`safety_check` 开启时，连接不会在模型吐完就关，
   服务端还要复审整段输出。已经流出的文本撤不回——收到 refusal 必须移除已显示答案、改显拒答文案。
   `stop_details.explanation` 可能带被拦图片的定位（如 `messages.1.content.0`），可记录但别原样展示。
6. **图片搜索**是 `deepseek_web_search` 的一部分：`kind=image_search`（深度思考搜索中为
   `deep_image_search`），`queries` 为空数组，结果多一个仅供展示的 `image_url`。
7. **深度思考搜索** 的 `kind=deep_search`，`input.action` 有 `search` / `open_page` / `find_in_page`；
   模型通常做最多约 20 次工具调用再作答。这里打开的页面只有 URL/标题/时间，`data` 为空且**没有**
   `signature`——与「读用户给的链接」不是一回事。
8. **流内 `error` 事件**：生成中途失败时 HTTP 仍是 200，流以 `type: "error"` 收尾（可能带 `usage`）。
   不识别就会把半截回答当成功——`streamAppChat` 用 `streamError` 判 `ok:false`，但保留已产出正文。
9. **文件上传顺序**：multipart 里 `purpose` 必须在 `file` **之前**（官方明确，否则 400）；引用文件的
   对话请求要带 `anthropic-beta: files-api-2025-04-14`。单请求最多 20 个文档、文本合计 8 MiB。
10. **usage 口径**：`message_start.message.usage` 只覆盖第一步推理；最终用量读 `message_delta.usage`
    （含 `server_tool_use` 的次数统计）。
11. **`max_tokens` 停止原因**：搜索/读链接后上下文耗尽也会是 `max_tokens`，别一概当成「输出太长」。
12. **带 web 工具的回复不能续写**（continue → 400），要重发上一轮请求。

响应块到 UI 的映射（详见 [官方 Build a Chatbot](https://api-docs.deepseek.com/guides/build_a_chatbot)）：

| 块 | 渲染 |
| --- | --- |
| `thinking` | 可折叠思考面板 |
| `server_tool_use` + `web_search_tool_result` | 搜索步骤 + 结果卡片（标题/站点/摘要） |
| `server_tool_use` + `web_fetch_tool_result` | 打开/阅读的页面 |
| `text`（带 `citations`） | 正文 + 引用角标 |
| `message_delta.delta.title` | 会话标题 |

## 4. latest_reminder

官方 demo 的格式是**五项逗号分隔**、日期用**本地**时区：

```
2026-11-14,Saturday,浙江杭州,Web,中文
```

`buildLatestReminder({now, weekday, location, channel, language})` 按此产出；缺省渠道 `Web`、语言 `中文`。
日期换成 UTC 会在跨时区时差一天，别改。

## 5. MDH 里怎么用

```bash
mingdao app "问题"                     # 纯问答（默认只开阅读链接）
mingdao app "问题" --search           # 联网搜索（thinking 关）
mingdao app "问题" --think --search   # 深度思考搜索
mingdao app "问题" --file report.pdf  # 文件输入（自动上传 + 引用 file_id）
```

- 配置项 `appApi` **默认关闭**：不开就不把请求发往应用端点，避免悄悄换掉默认链路。
- **分工**：需要工具/改文件/多步操作的走 **Agent 工具循环**；纯问答、搜索、读链接、文件问答走
  **app 模式**。原因是 §3.1 的互斥——两者不可能塞进同一个请求。

## 6. 费用

官方按「次/页/时长/字符」分别计费，这里不写死价格数字（价格会变，以官方为准）：

- 搜索、图片搜索、页面抓取：**按次另计**，而且工具调用次数会出现在 `usage.server_tool_use`。
- 文件：上传解析成功时**按页**计费；`user_data` 类（纯文本/表格/电子书）上传不收费；对话里只按输入 token。
- 安全复审消耗的 token 计入 output，并在 `usage.output_tokens_details.safety_tokens` 单列；
  输入被拦（400）时输入 token 仍按缓存命中价计费。
- ASR 按音频时长、TTS 按字符计费。

官方入口：[Web Tools](https://api-docs.deepseek.com/guides/web_tools)、
[File Parsing](https://api-docs.deepseek.com/guides/document_parsing)、
[ASR](https://api-docs.deepseek.com/guides/asr)、[TTS](https://api-docs.deepseek.com/guides/tts)。

## 7. 合规

- **对外提供服务必须开 `safety_check: {level:'high'}`**。它只提供基础风控，不替代你的主体责任：
  内容安全审核、大模型登记（备案）、AI 生成内容标识等义务由服务提供方**自行承担**。
- 拒答是正常返回路径，不是异常：UI 必须能替换答案（§3.5），日志里不要只记「空回答」。
- 用户上传的文件/语音可能含个人信息：MDH 侧不做长期留存（上传后仅引用 `file_id`），
  但你要在隐私政策里说明会转交 DeepSeek 服务端解析。

## 8. 维护者清单

- 改 `src/deepseek-app.js` 后必须跑：`node test/deepseek-app.js` → `node test/mutate/batch90-app-api.mjs`
  → `node scripts/preflight.mjs` → `node scripts/doc-lint.mjs`。
- 改协议形状（请求字段/块类型）时，`batch90` 的 `from` 锚点要同步更新，否则批次会报「变异点未找到」。
- 已知未覆盖：ASR 的 `Bearer` 头没有独立断言（改坏不会被现有测试抓到），见 `batch90` 注释。
- `read_link` 的 `signature` 只在 `web_fetch_tool_result` 里保存；`server_tool_use` 的 `signature`
  delta 目前不参与回传拼装——多轮回传需求若变，需要连带改 `applyAppEvent`。
