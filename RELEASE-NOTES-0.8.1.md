# MingDao Harness v0.8.1 发布说明

> 状态：**已发布**（tag `v0.8.1`）
> 主题：**WebUI 应用模式开关 + 空态示例随机化**
> 范围：`v0.8.0..HEAD` 的 4 个提交——`21b7f2f`（应用模式开关：模块/执行器/前端三帧渲染）、
> `5039296`（开关可被发现 + 空态示例随机化 + 图标化与占位文案）、`da82c78`（闸门收进
> `shouldRunAppMode`，结构守卫行数回到基线）、`8aa14e9`（发布前门禁修复：仅移动一处 JSDoc 位置，
> 见 §四）。
> 影响面：**WebUI 输入区新增一个可选开关**（默认关闭）。不开启时请求体与行为逐字节不变；
> `src/agent.js` 的工具循环**一行未改**，`server.js#handleChat` 只加**一行**分派。
> **用户可见：有**（🔍 应用模式；空态示例每次不同）。

---

## 〇、先读：本版到底改了什么

v0.8.0 把 DeepSeek「应用全家桶」API 接进了 CLI（`mingdao app`），但 WebUI 没有入口——
想在网页里联网搜索/读链接，只能回到终端。本版补上这个入口：输入框旁多一个 **🔍 应用模式**，
开启后这一轮交给服务端应用接口执行（联网搜索 / 深度思考 / 阅读链接），
**一轮只发 1 次 HTTP 请求**，服务端把「搜索 → 打开页面 → 阅读 → 作答 → 标题」全做完。

同时修掉用户报障的空态示例问题：原来三条示例都是开发向（「给这个仓库写 README / 跑测试修失败 /
解释 agent.js」），对普通用户不实用。现在改为**办公 / 生活 / 编程三类各 5 条**的池子，
每次进入空态**随机抽三条**（每类各一条，再打散顺序）——截图两次结果不同即证。

它**不是**替代 Agent 模式，而是一条并行路径：
应用接口的**服务端工具与客户端工具互斥**（同时声明 → 官方 400），所以它不经过工具循环，
也就没有工具卡片、轨迹面板与预算护栏（见 §三）。

---

## 一、用户可见 / 可用

### 1.1 输入框旁的 🔍「应用模式」

- 位置：composer 里附件按钮右侧，一个 **🔍 图标按钮**（`#appSearchBtn`），默认**关闭**；
  开启态按钮变蓝高亮（`.on`），并带 `aria-pressed="true"`。
- 开启后发送的这一轮：请求体带 `appMode: true` / `search: true` / `think`（思考档位沿用
  「思考模式」下拉的当前值）；关闭时**一个字段都不加**（请求体与改动前逐字节一致）。
- 鼠标悬停有说明：**「应用模式：联网搜索 / 深度思考 / 阅读链接（服务端执行，一轮只 1 次请求；
  会产生搜索/抓取费用）」**。
- **什么时候能看到这个按钮**：只要当前配置的模型是 **flash 家族**（`deepseek-flash*`）就显示；
  `config.json` 里写了 `appApi.enabled: true` 也会显示。不再出现「默认关就永远看不见」。
- 渲染：搜索/阅读以既有 `msg-sys` 小字**插在正文之前**（读起来是「先搜索、再回答」）；
  服务端返回的引用在正文结束后汇总成一条「参考：…」（按 url/标题去重，**最多 5 条**）。
  思考内容仍进既有「思考过程」折叠块，正文仍是同一个 Markdown 渲染器。

### 1.2 应用模式怎么工作（为什么更省）

| | 应用模式（🔍 开启） | Agent 模式（默认） |
| --- | --- | --- |
| 一轮请求数 | **1 次**（服务端一次请求内完成搜索/阅读/作答/标题） | 每搜一次都要「模型 → 工具 → 再发一次带全上下文」 |
| 谁能用工具 | 只有服务端工具（`deepseek_web_search` / `deepseek_read_url`） | 客户端工具（read/write/bash…全部） |
| 费用 | 会产生**搜索/抓取费用**（DeepSeek 侧计费） | 只有模型 token |

会话越长，省下的「重发全上下文」token 越多。代价是这条路径没有客户端工具能力。

### 1.3 空态示例：每次随机三条（办公 / 生活 / 编程）

- 示例池 **15 条**（`viewmodel.EXAMPLE_PROMPTS`）：办公 5 条、生活 5 条、编程 5 条，每条 ≤26 字
  （超长会让 chip 换行、顶高空态布局）。
- `pickExamples()`：**每类先随机取 1 条**（三类覆盖是硬要求，不靠随机碰运气），再打散顺序；
  同一批内绝不重复。**每次「进入空态」重抽一次**（新建对话 / 删到没有消息时）。
- 旧的开发向三条已移除；编程类只保留 1 条与本仓库相关的（「解释 src/agent.js 的主循环」），
  其余是通用编程任务——空态不再只对开发者有意义。

### 1.4 占位文案收紧

输入框占位改为：`输入任务…（Enter 发送 · 生成中 ⌘/Ctrl+Enter 插话）`。
原因：图标按钮占位后，原长文案在 1440 宽下会换行被裁切。

---

## 二、开发者

### 2.1 新增两个模块（`src/web/`）

- **`app-mode.js`（纯函数层，无 IO）**
  - `appFrameOf(delta)`：把 `streamAppChat` 的 delta 映射成 WebUI 既有 SSE 帧；
  - `buildAppMessages(history, text, {maxTurns=8})`：由会话历史构造应用接口的 `messages`；
  - `appModeEnabled(cfg)`：配置闸门（只认字面量 `true`）；
  - `appModelOf(cfg)`：`cfg.appApi.model || 'deepseek-flash'`；
  - `shouldRunAppMode(body, cfg, model)`：服务端**单点**闸门（见 2.4）；
  - `APP_NO_KEY_MESSAGE`：缺 Key 的用户可见文案（server 与测试共用一份）。
- **`app-mode-run.js`（服务端编排）**：`runAppModeChat(deps)`；从 `server.js#handleChat` 切出，
  只做生命周期编排（解析 provider → `streamAppChat` → 逐帧 `send()` → 落盘/改名/`done`/收尾）。

与 Agent 路径的关系：`src/agent.js` **一行未改**；应用接口的服务端工具与客户端工具互斥，
所以这条路径不经过工具循环。

### 2.2 帧映射表（`appFrameOf`）

| delta | SSE 帧 | 说明 |
| --- | --- | --- |
| `thinking` | `{type:'reasoning', text}` | 沿用既有帧类型（前端思考折叠块直接复用） |
| `text` | `{type:'text', text}` | **字段名是 `text`**（Agent 路径历史帧用 `delta`） |
| `search` | `{type:'appSearch', queries, kind, results:[{title,url,snippet,site_name}]}` | 结果只保留 4 字段；搜索开始与结果到达各一帧 |
| `fetch` | `{type:'appFetch', action, url, title}` | 打开页面/抓取 |
| `citation` | `{type:'appCitation', url, title}` | 正文结束后汇总「参考」（≤5 条） |
| `title` | `{type:'appTitle', title}` | 服务端会话标题（只用于改名，正文不渲染） |
| `usage` / `stop` / 未知 | `null` | 不产生帧（用量与结局由 `done` 帧承担） |

前端在事件入口做一次兼容：`ev.delta ?? ev.text`——不复制第二套渲染分支。

### 2.3 历史裁剪（`buildAppMessages`）

- 只保留 `role` 为 `user` / `assistant` 且 `content` 为**字符串**的消息；
- `tool` / `system` 消息、数组内容（多模态附件）、`_` 开头的附加字段**一律丢弃**，并重建为
  `{role, content}`（不透传任何原字段）；
- 只取**最后** `maxTurns*2` 条（默认 8 轮 = 16 条），末尾追加当前这一轮的 user 文本；
- 空/非法历史安全（返回 `[{role:'user',content:text}]`）。

### 2.4 闸门口径（`shouldRunAppMode`，v0.8.1 唯一判据）

```js
// 显式 UI 开关是**必要条件**；然后「配置开启」或「本回合模型是 flash 家族」任一成立即走应用模式。
if (!body || body.appMode !== true) return false;
return appModeEnabled(cfg) || supportsAppTools(String(model || ''));
```

- `supportsAppTools(model)` = `/deepseek-flash/i`（服务端工具目前只有 flash 家族支持；
  其它模型声明会 400）。
- 即：**UI 开关本身是显式同意**，与 CLI `mingdao app` 同口径（那条命令也不看 `appApi.enabled`）。
- 反之：不带 `appMode:true` 的请求**永远**走原 Agent 路径（关闭态回落有测试钉住）。
- `/api/state` 新增 `appMode` 字段（`appModeEnabled(cfg) || supportsAppTools(cfg.model)`），
  前端据此决定按钮可见性——不给用户一个「点了没反应」的开关。

### 2.5 服务端接线（`server.js`）

- `handleChat` 里只加一行：
  `if (shouldRunAppMode(body, cfg, runModel)) return await runAppModeChat({...});`
- 成功：`appendMessages([user, assistant])`（与 Agent 路径同一把会话锁 / 同一个写入口）→
  仅在会话文件是**默认时间戳名**时按服务端标题 `renameSessionFile`（不覆盖用户起的名字）→
  发 `done`（含 session / text / usage / durationMs）→ 统一 `finishChat()`。
- 失败：**先发完已产出的正文/思考**，再补一条 error（`chatFailure(msg, '')` 沿用原文），仍然
  `finishChat()` 收尾；缺 Key 时直接给可执行提示（`mingdao key set deepseek`），不发半截正文。
- 客户端断开（`res close`）→ `AbortController.abort()` 中止上游，避免白烧 token。
- SSE 的 `taskId` / `streamSeq` 全部走既有 `send()` 封装——断线续订/跳号检测**不需要第二套编号**。
- 可注入点：`MINGDAO_APP_BASEURL`（显式优先于 provider 配置的 baseUrl）；不写配置文件，
  供自托管网关与测试桩使用。

### 2.6 前端接线（`app.js` / `index.html` / `viewmodel.js`）

- `#appSearchBtn`：默认 `hidden`，`.on` 表示开启；`send()` 只在开启时加 `appMode/search/think`。
- 三帧渲染：`appSearch`（🔍 搜索：关键词 · N 条）、`appFetch`（📄 阅读：url）以 `msg-sys`
  插正文前；`appCitation` 收集到数组，回合收尾时 `renderAppCitations()` 汇总「参考：…」≤5 条。
- 空态：`renderEmptyState()` 用一次性标记 `emptyExamplesDrawn` 保证每次「进入」空态只抽一次
  （输入/频繁重绘不抖动）；离开空态重置，下次新建对话再抽。

### 2.7 结构守卫（行数只许降不许升）

应用模式分支切到 `app-mode-run.js` 后，`server.js` 两个长函数实测各降 1 行：
`runWebServer` 1009 → **1008**、`handleChat` 696 → **695**；`test/structure-limits.js` 基线
按实测同步（不预留余量）。闸门判据移进 `shouldRunAppMode`，`server.js` 只剩一行调用。

---

## 三、已知边界（诚实写，别指望本版没有）

1. **WebUI 附件不进应用接口**：`buildAppMessages` 只留字符串 `content`，图片/文件附件在应用
   模式这一轮**被丢弃**（不报错、不生效）。要带附件请关掉 🔍 走 Agent 模式（v0.8.0 的
   `mingdao app --file` 仍是 CLI 侧的附件入口）。
2. **应用模式不注入 Agent 的系统提示 / 项目记忆 / 预设**：`system:''`，与 `mingdao app`
   同一口径。它拿不到工作区上下文与预设约束。
3. **没有 UI 写 `appApi.enabled` 的入口**：`config.json` 里手写 `appApi` 才会「默认预开启」；
   界面上**没有**开关去改这个配置。反过来说：点 🔍 就是**显式同意**（不需要也不修改配置）。
4. **失败时的半截回答不落盘**：失败路径只把正文发到界面、不写会话；刷新后这一轮消失
   （成功才落 `user + assistant` 两条）。
5. **应用模式没有工具 / 轨迹 / budget**：不经过 `agent.js` 工具循环，因此没有工具卡片、
   轨迹面板、步数与预算护栏；服务端搜索/阅读的计费发生在 DeepSeek 侧（会产生搜索/抓取费用）。
6. **可见性按「配置模型」判定，执行按「本回合模型」判定**：按钮在配置模型为 flash 家族时显示；
   若自动路由把本回合模型切到非 flash，且 `appApi.enabled` 未开，则会**静默回落 Agent 路径**
   （不出现应用模式帧）。
7. **历史只保留最近 8 轮文本**：更早的上下文不进应用请求；历史里的工具消息与附件重放会被丢弃。
8. **服务端标题**只在会话仍是默认时间戳名时采用，绝不覆盖用户自己起的名字。

---

## 四、测试与门禁（发布树）

- 新增 `test/app-mode.js` **21 项**：① `appFrameOf` 六种映射 + 未知/null 不产帧；②
  `buildAppMessages` 丢弃/截断/追加；③ 配置默认值；④ **真实 HTTP 服务 + 本地 Anthropic SSE 桩**
  的完整链路（无 Key 文案 / 一轮 1 次请求 / 服务端工具与 think / 帧序列 / 会话落盘 user+assistant /
  服务端标题改名 / 关闭态回落 Agent 路径零应用帧）；⑤ 接线绊线（按钮 / 请求字段 / 三帧渲染 /
  双闸门 / Agent 路径仍在）。
- `test/viewmodel.js` 新增示例池断言：三类覆盖、每条 ≤26 字、同批不重复、固定 rng 可复现、
  连续抽签有随机性、`count` 越界安全。
- `test/run-all.mjs` **54 → 55 套**；`ci.yml` 增加 `app-mode` 一步（失败时断言原文进注解，与其它步骤同口径）。
- **发布前门禁修复（`8aa14e9`，仅注释移动）**：`da82c78` 把 `shouldRunAppMode` 的 JSDoc 插在了
  `appModelOf` 的 JSDoc 与函数之间，导致 `appModelOf(cfg)` 失去 `@param` 类型 →
  `tsc` 报 `TS7006`（typecheck/strict 双红）。修复方式**只移动注释位置**，函数体与行为零变化；
  这是发布前门禁复跑发现的问题（不在 v0.8.0 发布提交里）。
- 门禁结论（发布树，工作树干净）：typecheck 0 / strict 0-0 / preflight ✓ / smoke ✓（单独 + 私有
  TMPDIR）/ run-all **55/55** / `mutate:shard` 4 片 **840 条 0 逃逸** / event-parity / coverage
  （只报告）/ doc-lint ✓ / diagnose ✓。

---

## 五、升级与兼容

- **请求体兼容**：不开启 🔍 时，`POST /api/chat` 的请求体与 v0.8.0 **逐字节一致**；旧前端连新服务端、
  新前端连旧服务端都安全（`appMode` 缺省 = 关闭）。
- **配置兼容**：不写 `appApi` 时行为一字不变；写了也只认 `enabled === true`（`"true"` 不算）。
- **API / 命令**：CLI 与库接口无变化；本版只动 WebUI 与 `web/` 模块。
