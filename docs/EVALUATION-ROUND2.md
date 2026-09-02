# 六方技术评估 · 第二轮甄别与迭代方案（v0.2.5 → v0.2.6）

> 2026-09-02。对 CodeBuddy / MiniMax / Kimi / OfficeACE / workbuddy / CodeArts Agent 六家对
> MingDao Harness v0.2.5 的评估报告逐条对照真实代码甄别（每份报告均由独立子代理核实：
> 文件+行号证据、区分「真实缺陷」与「过时/误判/空泛套话」）。已修复项随本轮提交 `20693ee`。

## 一、本轮已修复（按严重度）

### 崩溃类（0.2.2 教训：打包期无声、运行期爆炸）
1. **域路由 400/403 双写崩溃【最高】**：C1 拆分后 `json()` 无返回值，`return json(...)` 被编排器视为「未处理」→ 兜底 404 对已结束响应二次写入 → Node 18 未捕获 write-after-end 整服务崩溃（CI ubuntu-18 腿连续红灯的真因，报告们误归因于 Windows）。修复：`json()` 返回 truthy。
2. **reasoning_content 工具轮未完整回传**：DeepSeek thinking_mode 官方要求带 tool_calls 的 assistant 消息在后续请求中原样回传 reasoning_content，否则 400——多轮工具会话真实 API 必崩（mock 测试看不见）。修复：回填完整 reasoning；裁剪逻辑只对纯文本回复生效。
3. **降级模型零校验**：`downgradeModel` 填错/跨服务商 → provider.chat 必然 400 终止回合。修复：校验同服务商，失败按 block 处理并给修复指引。
4. **reasoning_effort 无门控**：全局配置发给不支持 reasoning 的模型 → 400。修复：仅 `supportsReasoning` 模型发送；`/think off` 改为显式 `thinking:{type:'disabled'}`（此前 off 无效，pro 默认思考开启）。

### 安全类
5. **SSRF 域名 DNS 重绑定绕过**：校验不解析域名。修复：`validateRemoteUrl` 对域名做 `dns.lookup` 全量 A/AAAA 复检；IPv6 字面量去括号归一（`[::1]`/`[::ffff:127.0.0.1]` 此前直接放行）。
6. **readBody limit 形同虚设**：1MB 注释 vs 实际 40MB 全接口。修复：limit 参数生效 + 超限返回真 413（排水保留连接）+ 契约断言；chat 保留 40MB（附件 base64）。
7. **project 级技能无指纹校验**：仓库投毒可直通提示词注入。修复：project 级同样校验 `.source.json` 指纹（无指纹的旧仓库不受影响）。
8. **Windows fs-browse 白名单过宽**：家目录覆盖整个用户配置树（AppData）。修复：win32 收紧为 桌面/文档/下载 + 启动/工作目录 + 显式授权；路径比较大小写归一。

### 省钱与正确性类
9. **护栏在途费用失明**：长回合内统计文件不变，可烧穿日限。修复：回合内累计 usage 保守估算并入检查/前置拦截。
10. **语义回收缺陷**：>80% 即回收（能塞下也截断丢内容）；回收窗口与被丢弃前缀不相交（白做）。修复：仅真超预算触发 + 按丢弃边界回收 + 只接受变短替换。
11. **工具 Schema 会话内多次变化破坏前缀缓存**（三家共识）：每轮剥描述 + 只读阶段翻转 + MCP 晚到 → 前缀反复失配。**列入 v0.2.6 计划**（需要在线基准裁决收益，见下）。
12. **英文任务只读死锁/误路由**：写意图与生成意图正则纯中文，英文会话整回合只读、生成任务落 8192 输出。修复：双语正则 + 路由标注集英文子集（113 条）。
13. 杂项：PID 归属 `null`（无法校验）不再盲杀；SSE 尾字节并入 buf 统一行解析；原子写陈旧锁回收 TOCTOU 比对；tokenCache 整体清空改 LRU；`todayCost` 读失败返回 null + 一次性告警（不再静默归零）。

### 质量基础设施
14. CI 补跑 `api-contracts`（此前漏掉）；`run-all` spawn 加 error 监听 + Windows `npm.cmd`；e2e-web 越界用例改用系统目录（Windows %TEMP% 在家目录内的假阴性）。

## 二、下一迭代（v0.2.6）方案

**A. 前缀缓存稳定性（省钱核心，唯一需要「先测量再动手」的项）**
- A1：会话内工具 Schema 两态冻结——回合首轮定档后恒定（不再逐轮剥描述/MCP 晚到突变），回合间才更新；
- A2：MCP 预热：启动时 await 连接（带超时，超时本会话冻结工具集）；
- A3：新建 `test/bench/bench-cost.mjs`——mock 模型费用对照（schema 收益、前缀命中、护栏拦截），把「48%/1/30/半价」营销数字变成可回归断言；
- A4：`trimMessages` 前沿对齐（P1-1：轮重写头部消息导致前缀整体失配）——在 A3 基准下裁决是否采纳。

**B. 会话与索引扩展**
- B1：session-index 按会话名分片（>1000 会话时避免全量 JSON.parse）；
- B2：常量单源化（MAX_CONCURRENT=8 实测值、200KB/5MB 附件上限去重，防 app.js/attachments.js/fs-tools.js 漂移）。

**C. 桌面与 WebUI**
- C1：面板推开布局（已随本次提交：轨迹/子代理/任务面板以 body class 推开内容区，≤560px 退化为全宽面板；附件行不再被遮挡）；
- C2：app.js（88KB）原生 ES Modules 零构建拆分（可选，收益=可维护性）。

**D. 文档与门禁**
- D1：docs/QA-REPORT.md 断言数（14→60+）、CONFIG.md 补 `costGuard.action:'downgrade'`；
- D2：CI 类型门禁统一为 tsconfig.full.json（现仍跑弱版 tsconfig.json 双轨）。

**E. 缓做/不采纳（已甄别）**
- sync-server 非 loopback 无 TLS 拒启（需 `--insecure` 逃生门，改行为需用户确认）；87 处空 catch 加 debug 开关（收益低，优先关键路径）；WebUI SPA 拆分；i18n；SQLite（需 Node≥22.5，破坏 18/20 兼容矩阵）；报告中的 roadmap 型空泛项（收益数字无测量依据）。

## 三、验收门槛（防 0.2.2 式回归）
1. 6 套测试全绿 + api-contracts 每域契约 + 新增 bench-cost 断言；
2. strict 棘轮 0/0 不回升；覆盖率 ≥60% 门禁；
3. **每次发版前 CI 打包冒烟（xvfb 真实运行打包产物主进程）**——已固化，不可省略；
4. 新增「Node 18 兼容」意识：CI 已有 ubuntu-18 腿（本次双写崩溃即由它抓住），任何路由改动必须过该腿。
