# 事件为真源：翻默认前的覆盖性证据（v0.7.0）

> 结论先行：4 类**真实写入路径**上的样本（工具调用 / 自动压缩 / 手动 `/compact` / resume 继续）
> 全部 `pass`，`incomplete=0`、`fail=0`；`eventSource=events` 与 `messages` 两种读取逐条
> `deepEqual` **4/4**。按既定门槛（`fail=0` 且 4 类覆盖），**满足翻默认条件**。

## 1. 为什么需要这份证据

`config.eventSource` 此前默认 `messages`；v0.7.0 B2-b 已翻成 `events`（本文即翻默认的证据）。
翻成 `events` 后，历史会话将由事件日志 `replayToMessages()` 派生。派生结果只要与 `.jsonl`
消息数组有一处不同，用户看到的历史就会静默变形（标题、工具卡片、压缩后的窗口、中断占位）。
因此「事件与消息数组等价」不能靠推理，必须在**每一种会改写会话文件的真实路径**上留下样本
与对拍输出。此前本机只有 1 个 `session.start.data.format >= 2` 的真实会话，样本太薄，
不足以支撑翻默认。

判据（[event-parity.mjs](../scripts/event-parity.mjs)）：`fail` 才算回归；旧日志缺格式戳
（`format < 2`）且无 `messages.replace` 判 `incomplete`，不计失败。

## 2. 四类样本怎么造

### 2.1 共同手法（不手写 .jsonl）

[make-event-fixtures.mjs](../scripts/make-event-fixtures.mjs) 用**临时 `MINGDAO_HOME`** +
仓库既有的「桩 provider」手法（真实 HTTP + SSE，参考 `test/e2e-web.js`），`spawn` **真实入口**
`src/cli.js`（单次提问 / REPL），让会话经 `appendMessages()` / `rewriteSession()` 自然落盘。
关键配置：

```json
{ "provider": "custom", "model": "mock-model", "baseUrl": "http://127.0.0.1:<port>/v1",
  "permission": "auto", "contextBudget": 12000,
  "autoTitle": false, "autoMemory": false, "autoProjectMemory": false,
  "customModels": { "mock-model": { "contextWindow": 131072,
                                  "maxOutputTokens": 8192, "local": true } } }
```

桩 provider 对 `tools=[]` 的压缩请求返回 `{"summary": ...}`；工具模式首枪返回 `read` 调用，
看到 `tool` 消息后收尾；自动压缩模式返回长文本累积上下文。

### 2.2 四类入口与关键参数

| # | 类别 | 入口 | 关键手法 |
|---|------|------|----------|
| ① | 工具调用（成功往返） | `node src/cli.js "请读取 hello.txt…"` | 桩返回 `read({path:"hello.txt"})`，真实执行工具 |
| ② | 自动压缩 | REPL（stdin 喂 3 轮长对话，`/exit`） | `contextBudget=12000` + 长回复，第 3 轮 `autoCompact` 触发 |
| ③ | 手动 `/compact` | REPL（3 轮对话后输入 `/compact`，再 `/exit`） | 命令强制压缩，`rewriteSession(...,'compact')` |
| ④ | resume 后继续 | REPL 跑一轮 `/exit` → `node src/cli.js -c` 再跑一轮 | `-c/--continue`（`--resume` 的非交互等价位）续写同一文件 |

四类样本的 `session.start` 均实测为 `format=2`（事件条数分别 16 / 24 / 23 / 15）。

## 3. 对拍输出（原样）

```text
$ node scripts/event-parity.mjs --home <临时目录> --verbose
  ✓ 2026-11-08T14-02-51-3cc3.jsonl（4 条）
  ✓ 2026-11-08T14-02-51-45at.jsonl（5 条）
  ✓ 2026-11-08T14-02-52-fxz1.jsonl（4 条）
  ✓ 2026-11-08T14-02-52-jkw3.jsonl（4 条）

对拍结果：等价 4 · 不可回溯 0 · 不一致 0 · 跳过 0（共 4）
```

`event-parity.mjs` 退出码为 0（无 `fail`；`incomplete` 与 `skip` 也都是 0）。

## 4. 两种 eventSource 的 deepEqual

对每个样本分别调用 `loadSession(file)` 与 `loadSession(file, { eventSource: 'events' })`，
并断言两条路径返回的 `messages` **`assert.deepStrictEqual`**（事件模式不得 warn/回退）：

```text
[3/3] loadSession 双读交叉验证（messages vs events）
  ✓ ① 工具调用（read 往返）：deepEqual 通过（5 条）
  ✓ ② 自动压缩（autoCompact + contextBudget=12000）：deepEqual 通过（4 条）
  ✓ ③ 手动 /compact（REPL 命令）：deepEqual 通过（4 条）
  ✓ ④ resume 后继续（-c）：deepEqual 通过（4 条）

结论：pass=4 / incomplete=0 / fail=0；双读 deepEqual 4/4。
```

## 5. 结论、复现与边界

**门槛判定：满足。** 覆盖了四类会改写会话的写入路径（工具消息追加、自动压缩重写、手动
`/compact` 重写、`-c` 续写），`fail=0`，且两种读取结果完全一致。未发现产品 bug。

复现（不落仓库、只写 `os.tmpdir()`；成功后默认保留临时目录供复查，`--rm` 删除）：

```bash
node scripts/make-event-fixtures.mjs          # 造 4 类样本 + 对拍 + 双读交叉验证
node scripts/make-event-fixtures.mjs --rm     # 同上，成功后清理临时目录
```

边界（本次**未**覆盖，翻默认后仍建议后续补样）：

- 中断占位（`interrupt` + 悬空 tool 回填）、审批拒绝、`/clear` 产生的 `messages.replace`；
- 工具执行失败 / 参数解析失败的消息形态；
- 同秒并发的两条会话、WebUI 服务端写入路径（本证据走 CLI/REPL）；
- 真实远端 provider 的 usage/reasoning 字段差异（本证据用本地 SSE 桩，消息形态真实但上游行为简化）。
