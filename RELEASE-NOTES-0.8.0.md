# MingDao Harness v0.8.0 发布说明

> 状态：**已发布**（tag `v0.8.0`）
> 主题：**DeepSeek「应用全家桶」接入（搜索/文件/语音）+ 两处性能优化**
> 范围：`v0.7.2..HEAD` 的 7 个提交——`5951291`（应用全家桶 API 客户端）、`c3cfb4d`（搜索结果按
> `tool_use_id` 配对）、`cfe4a0d`（`mingdao app` 命令）、`ccde964`（M-5 每步 token 只遍历一次）、
> `c362d95`（性能断言：一轮搜索 1 次 HTTP）、`c1d165d`（文档 + batch90 变异守卫）、
> `335e2bd`（接线 2 套件 + 分发表提升 + 对拍分类修正）。
> 影响面：**新增能力（默认关闭）**。不配置 `appApi` 时，对话/工具/账本/调度/同步/认证的
> 对外行为**一字未变**；`src/agent.js` 的工具循环**零改动**（仅 token 统计从两遍收成一遍）。
> **用户可见：有**（`mingdao app` 新命令；应用模式下搜索更快、标题不再多调一次模型）。

---

## 〇、先读：本版到底改了什么

DeepSeek 除了 OpenAI 兼容的对话端点，还有一套「应用全家桶」端点（Anthropic Messages 风格）：
**联网搜索、深度思考搜索、阅读链接、文件解析、安全校验、服务端会话标题、语音转写与合成**。
这些能力过去在 MDH 里没有入口——需要搜索时只能靠模型自己调客户端工具，一轮搜索要多次
「模型 → 工具 → 再发一次带全上下文」。

本版把这条路径接进来，并新增 CLI：`mingdao app "问题" --search`。

它**不是**替代 Agent 模式，而是补一块「不需要工具循环」的场景：纯问答、联网搜索、读链接、
文件问答、语音。原因是协议硬约束：**服务端工具与客户端工具互斥**（同时声明 → 官方 400），
所以两者不可能塞进同一个请求。

**默认关闭**：`cfg.appApi` 不配置时，`mingdao app` 仍可用（命令自带默认值），但不会改变
Agent 模式的任何行为。

---

## 一、用户可见 / 可用

### 1.1 新命令 `mingdao app`

```bash
mingdao app "问题"                        # 纯问答（默认只开「阅读链接」）
mingdao app "问题" --search              # 联网搜索（含「边想边搜」）
mingdao app "问题" --think --search      # 深度思考搜索（边想边搜，一次请求内多步）
mingdao app "问题" --file report.pdf     # 文件输入（自动上传 + 以 file_id 引用）
mingdao app --asr meeting.m4a            # 语音转文字（只转写，不对话）
mingdao app --tts "要朗读的文本"          # 语音合成（裸 PCM，默认写 ./out.pcm）
```

常用开关：

| 开关 | 作用 |
| --- | --- |
| `--search` | 开启服务端联网搜索（含图片搜索、`deep_search`） |
| `--think` | 开启深度思考 |
| `--no-url` | 关闭服务端阅读链接（**默认开启**） |
| `--file <路径>` | 可多次；PDF/Word/PPT/图片走「版面解析」，md/txt/csv/源码走 `user_data` |
| `--json` | 输出结构化结果 `{text, thinking, title, searches, citations, fetches, usage, stopReason}` |
| `--voice stella\|tide` | 聊天后把正文合成裸 PCM（24kHz 单声道 16-bit 小端） |
| `--out <文件>` | PCM 输出路径（默认 `./out.pcm`） |
| `--asr <音频>` / `--tts "文本"` | 两种单接口调用：只转写 / 只合成，不进入对话 |

退出码：`0` 成功；`1` 参数 / 配置 / 密钥 / 请求 / 语音 / 文件读写失败。
**失败绝不静默 `exit 0`**：流内失败会先打出已产出的正文/思考，再说明原因并非零退出；
无 API Key 时提示 `mingdao init` / `mingdao key set deepseek`。

### 1.2 与 Agent 模式的分工（重要）

| 场景 | 走哪里 | 为什么 |
| --- | --- | --- |
| 纯问答 / 联网搜索 / 读链接 / 文件问答 / 语音 | **`mingdao app`（应用模式）** | 服务端在一次请求内完成多步，往返更少 |
| 改文件 / 跑命令 / 多步操作 / 需要自定义工具 | **Agent 工具循环（`mingdao` 对话）** | 服务端工具与客户端工具互斥，不可能同请求 |

### 1.3 可选配置 `appApi`（默认关闭）

`config.json` 里可写 `appApi` 提供默认值（`model` / `search` / `readUrl` / `thinking` /
`safetyLevel` / `title`）。三条守则：

- **默认关闭**：`enabled` 只认字面量 `true`（`"true"`、`1` 都不算）；
- 缺省时**不落盘、不在内存里新增字段**——既有配置文件的读写字节不变；
- 非法值只降级不抛错：`safetyLevel` 白名单（`high`/`low`/`off`）外回落 `high`，
  非 flash 系模型回落 `deepseek-flash`（应用工具目前只有 flash 系支持）。

---

## 二、性能

本节的每一条都能用「请求次数 / 遍历次数」量，不承诺具体毫秒数。

### 2.1 应用模式一轮深度思考搜索只发 **1 次 HTTP 请求**

- 客户端工具循环里，每搜一次都要「模型 → 工具 → **再发一次带全上下文**」，会话越长重发越贵；
- 应用模式把 `search → open_page → find_in_page → 作答` 全放在**一次** HTTP 请求内。
- **可测口径**：`test/deepseek-app.js` ⑰ 断言一轮深度思考搜索只发生 **1 次 `fetch`**
  （`calls === 1`）。改回客户端循环，这条当场红。

### 2.2 服务端标题省掉一次模型调用

标题随 `message_delta.delta.title` 返回，应用模式不再为每个会话单独发一次标题补全请求。

### 2.3 M-5：每步 token 总数只遍历一次（`src/agent.js`）

`sanitized` 在一步内不变，`promptTokens` 只算一遍；此前成本护栏与 prefill 预告各遍历一遍
（每步 2 次 O(n)），长会话下是纯浪费。**行为不变**，只是少一遍遍历。

---

## 三、默认关闭：Agent 工具循环零改动

- `cfg.appApi` 缺省时，请求**不会**被发往应用端点；默认链路（OpenAI 兼容 + 工具循环）不变。
- `src/agent.js` 的改动**只有** 2.3 那一处 token 统计，没有切换协议、没有新增分支。
- 客户端工具与服务端工具互斥这一条，决定了本版**不可能**悄悄改变 Agent 行为——两者不在同一条路径上。

---

## 四、已知边界（诚实写）

1. **服务端工具与客户端工具互斥（官方 400）**。所以应用模式只用于**纯对话 / 搜索 / 读链接 /
   文件问答 / 语音**；要改文件、跑命令、多步操作，仍走 Agent 工具循环。两者不能合并成一个请求。
2. **暂无 WebUI 搜索开关**：本版只做了 CLI（`mingdao app`），Web 界面里没有搜索/深度思考开关。
3. **`S-3` 事件 append 仍是同步锁**（`Atomics.wait`）：审计点名要异步化，属大改，**留后续版本**；
   本版未动。
4. **应用模式的费用口径与 Agent 模式不同**（按官方计费，本说明不写死价格，以官方为准）：
   - 搜索、图片搜索、页面抓取：**按次另计**（调用次数出现在 `usage.server_tool_use`）；
   - 文件：解析成功按**页**计费；`user_data` 类（纯文本/表格/电子书）上传不收费，对话只按输入 token；
   - 安全复审消耗的 token 计入 output（`usage.output_tokens_details.safety_tokens` 单列）；
   - ASR 按音频时长、TTS 按字符。
   - 官方入口：[Web Tools](https://api-docs.deepseek.com/guides/web_tools)、
     [File Parsing](https://api-docs.deepseek.com/guides/document_parsing)、
     [ASR](https://api-docs.deepseek.com/guides/asr)、[TTS](https://api-docs.deepseek.com/guides/tts)。

另外几条协议坑（实现细节见 `docs/DEEPSEEK-APP-API.md` §3）：`read_link` 的页面正文在
`signature` 里，多轮必须原样回传；`stop_reason: refusal` 要替换为拒答文案；带 web 工具的回复
不能续写；流内 `error` 时 HTTP 仍是 200（本版已区分，不会把半截回答当成功）。

---

## 五、其他修正与测试

- **对拍分类修正**（`scripts/event-parity.mjs`）：`format=2` 但**只有 `compact` 没有
  `messages.replace`**（某次整份重写未落事件）单列 `incomplete` 并点明原因，不再误判为
  「重放回归」。本机真实会话对拍：等价 3 · 不可回溯 4 · 不一致 0。
- 新增 `test/deepseek-app.js` **19 项**、`test/app-command.js` **32 项**；
  `test/mutate/batch90-app-api.mjs` **12 条**；`test/run-all.mjs` **52 → 54 套**。
- `ci.yml` 新增 `deepseek-app` / `app-command` 两步（失败同样把断言原文做成注解，便于无令牌诊断）。
- `packs/example-hello/pack.json`：`engines.mingdao` 放宽为 `>=0.4.6 <0.9`；
  `test/smoke.js` 同步 16 处 manifest 夹具窗口（`<0.8` → `<0.9`，断言意图不变）。
  （v0.7.0 教训：版本号 bump 本身就是一次代码变更——官方示例 Pack 与 smoke 夹具的
  版本窗口都会在 0.8.0 上当场红。这是发布提交里**唯一**动到 `test/` 的地方。）

---

## 六、门禁（发布树）

在**发布提交**上逐项运行（`git diff 335e2bd..<tag> -- src` = **0 字节**；`test/` 的唯一差异是
`test/smoke.js` 16 处 manifest 夹具的版本窗口 `<0.8` → `<0.9`——版本 bump 的连带变更，
断言意图不变，见 §五。除此之外门禁树与 tag 树的 `src/` `test/` 完全一致）：

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | 0 错误（exit 0） |
| `npm run typecheck:strict` | 当前 0 条 / 基线 0 条（exit 0） |
| `npm run preflight` | ✓ 预检通过（批次结构 / 变异残留 / 计数一致），exit 0 |
| `node test/smoke.js`（单独 + 私有 `TMPDIR`） | 全通过，exit 0 |
| `node test/run-all.mjs` | **54/54 套通过，0 失败**（exit 0） |
| `npm run mutate:shard`（4 片全量） | **4/4 片全中；78 批 / 840 条，0 逃逸**（exit 0） |
| `node scripts/event-parity.mjs --home ~/.mingdao` | 对拍 exit 0（等价 3 / 不可回溯 4 / 不一致 0） |
| `npm run coverage` | 只报告，exit 0（趋势参考，不拦发布） |
| `node scripts/doc-lint.mjs` | 全绿（exit 0） |
| `node src/cli.js diagnose` | exit 0（密钥 / token / 私网路径已脱敏） |
| tag 树：`node test/deepseek-app.js` / `node test/app-command.js` | **19 项 / 32 项通过** |
| tag 树：无 key 实跑 `node src/cli.js app "hi"` | **退出码 1**，提示 `mingdao init` / `key set`（不静默成功） |

发布前工作树干净、三平台 main 已对齐；tag `v0.8.0` 指向发布提交。

---

## 七、升级建议

- **任何 ≥0.6.36 版本**：直接自动更新即可。本版是新增能力，不改既有默认链路。
- **想用应用模式**：确保已配 DeepSeek API Key（`mingdao init` 或 `mingdao key set deepseek`），
  然后 `mingdao app "问题" --search` 即可；不需要改 `config.json`。
- **运维**：本版发布**必须先发签名（`publish-update-sigs.mjs 0.8.0`）再翻 feed**
  （v0.7.1 空窗事故的教训），否则客户端会弹「未验证来源签名」。
