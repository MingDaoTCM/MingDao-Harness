# MingDao Harness v0.4.5 发布说明

**版本：0.4.5 — 费用护栏根因修复 + 本地模型 507 中断根治 + 调度/CLI/安全正确性收尾**

> 项目简称 **MDH**（MingDao Harness）。

## 本次更新

### 费用护栏：无价模型不再静默「当免费」（P0-4）

1. `estimateCost` 对无价格数据的模型从 `return 0` 改为 `return null`——0 与「未知」语义分离，
   不再把「没定价」冒充成「没花钱」；`estimateCostLabel` 同步置空（不显示 ≈¥0.0000）。
2. `costGuardStatus`/`checkCostGuard` 新增 `noPricing` 显式告警：当前模型无价格数据时，
   费用护栏无法累计，直接提示「请补充定价或改用有价的 DeepSeek 模型」，**绝不静默放行**。
3. `recordUsage` 直接记录 null 成本（覆盖内置定价 / 外部定价 / `config.pricing.overrides` 三条来源），
   Agent 前置预估与在途费用遇 null 视为「无法判断」跳过，交由主护栏显式告警。

### 任务锁与 kill：死锁 / 非 Linux 失效 / 调度 pause 被覆盖（P0-1/2/3）

4. **文件锁可重入**：`withFileLockSync` 本进程已持该锁时直接执行——此前 `killTask` 持锁内
   二次抢同一把锁自死锁 5s，任务 kill/pause/remove 全失效。
5. `schedule` 的 pause/remove 对 `killTask` 包 try/catch：kill 失败不再阻断「删除/暂停」这一更强意图。
6. **非 Linux（无 /proc）kill 降级**：`owned===null` 时按 pid 存活即杀——此前 null 直接跳过，
   macOS/Windows 上 kill 只改状态不杀进程、worker 跑完覆盖状态。

### 调度器：pause 语义彻底不被覆盖（P1-15 / P2-4 / P2-29）

7. 标记 `running`、once/after 收尾终态、after 判 `skipped`、offpeak note、runOnce 收尾元数据
   五处状态写全部改为「加锁 + 复查 `paused`」——用户在任务执行期间 pause，绝不被后续写入覆盖回
   running/done/failed（此前 `every` 经 `postRunStatus` 有防护、once/after 没有，属同一逻辑的不一致残留）。

### MacBook 本地模型 507 memory_refusal 中断根治（network-error 报告）

8. **200 响应夹带 error 对象不再被吞**：`parseStream`/`parseNonStream` 识别
   `{"error":{"code":507,"message":"memory_refusal"}}` 并上抛（此前 choices 为空即忽略，
   误报成「模型本轮没有输出正文。」）。
9. **507 直接终结合回合**：`provider.chat` 抛 507 或含 `memory_refusal` 时，立即返回
   「本地模型内存不足——压缩上下文 / 减少并发子任务 / 重启模型服务」提示，不再计入空轮、
   不再注入「继续」空烧重试请求（3 连 507 撞 `maxEmptyRounds` 的根因）。
10. **本地模型判定补齐自定义主机名**：`isLocalBaseUrl` 增加 `/etc/hosts`（含 Windows）
    「主机名→私网/回环 IP」复检；支持 `customModels.<name>.local=true / isLocal=true` 显式强制本地档。
    ——此前 `mtplx.server.openai` 这类主机名被误判远程，导致只读子代理不串行（9 路大 prefill
    并发击穿内存）、压缩触发线用远程档（0.8 而非 0.6≈59k）、超时档位错；判定修正后自动全部生效。

### SSE / CLI / 安全正确性收尾（P1/P2）

11. **SSE [DONE] 后有界排空**：捕获 `[DONE]` 之后部分网关才发的 usage-only 尾帧（费用不漏计），
    又不因网关不主动关流挂到 streamIdleMs（120s）——500ms 短超时 + 释放连接。
12. **readBody close→499**：请求体上传中断（客户端刷新/abort）时 reject，释放 `/api/chat` 的
    inflight 槽——此前只 clearTimeout 不 reject，Promise 永久 pending，重复 N 次后服务对所有会话 429。
13. **CLI `--model` 贪婪解析修复**：遇首个位置参数后停止剥全局 flag——此前后台/定时任务指定的
    `--model` 被顶层剥除静默失效，且提问文本含「init」即误触发初始化向导。
14. **worker 判 capHit / every 崩溃恢复不终态化**：跑满步数上限（未真正完成）判 failed 而非 done；
    every 周期任务崩溃恢复经 `postRunStatus` 重排回 pending（不再静默永停）。
15. **git 只读工具参数过滤**：拒绝 `--no-index`（越界读任意文件）/`--output`（写文件）/
    `-D/-f/-m`（破坏元数据）等参数。
16. **技能目录拒绝符号链接**：`lstat` 判定 + `containsSymlink` 扫描，防越权读本机文件/架空 sha256 篡改检测。
17. **memory / pricing 整写改原子写**：防崩溃/断电留半截文件。
18. 子代理 `onUsage` 透传（子代理消耗逐轮计入今日费用）；`task(readOnly:true)` 权限自动放行；
    fetch 重定向超限死代码修复；`onUsage` 回调带模型名归属。

## 安装

- **Windows**：`mingdao-setup-0.4.5-x64.exe`
- **Linux**：`mingdao-0.4.5-amd64.deb` 或 `mingdao-0.4.5-x86_64.AppImage`
- **macOS (Intel)**：`mingdao-0.4.5-x64.dmg` / `mingdao-0.4.5-x64-mac.zip`
- **macOS (Apple 芯片)**：`mingdao-0.4.5-arm64.dmg` / `mingdao-0.4.5-arm64-mac.zip`

> 桌面版安装包统一由官网分发（国内直连极速）：https://harness.mingdao.ai/#downloads
> 校验值与更新日志以官网为准。

## 反馈

- 官网：https://harness.mingdao.ai
- 论坛：https://harness.mingdao.ai/forum/
- 问题反馈请附 `~/.mingdao/logs/web-server.log`（Linux/macOS）或
  `%USERPROFILE%\.mingdao\logs\web-server.log`（Windows）与桌面端 `mingdao.log`。
