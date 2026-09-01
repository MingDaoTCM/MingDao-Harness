# 更新日志（Changelog）

本项目自 v0.1.69 起维护变更日志；此前版本（0.1.0–0.1.68）的演进见 docs/QA-REPORT.md 与 git 历史。

## v0.2.5（2026-09-01）

- Phase C 结构渐进：routes/api.js 按域拆分（7 域 + 编排器 + API 契约测试 8 组，修 icon 路径 bug）· cli REPL→commands/repl.js、worker→tasks/worker.js（tuiState 共享槽修复 onCompact 跨文件闭包）· strict 棘轮 1112→0（全量注解 + annotate-strict 辅助器，基线归零）

## v0.2.4（2026-08-31）

- Phase B 省钱第二轮：工具 schema 按需挂载（只读阶段收缩/已用工具瘦身-48%）· Batch 去重回填/超窗口预检/--max-cost · 费用二级分账（reasoning/byTool/byDay + WebUI Top5/折线）· 护栏 downgrade 切 flash · bench 扩到 150+ 断言 + 覆盖率阈值 60%

## v0.2.3（2026-08-31）

- 紧急修复 0.2.2 桌面三平台启动即崩：main.js 顶层 createLogWriter 漏导入（A6 重构遗留）——改为顶层 await import(srcRoot/log-writer.js)；新增静态护栏 + CI 打包冒烟（xvfb + MINGDAO_DESKTOP_SMOKE）

## v0.2.2（2026-08-31）

- Phase A 正确性收尾：sync 写锁、密码隐藏输入、fs-browse 基目录、body 分级、草稿按会话、日志统一、崩溃护栏、notify 结构化、run 参数合一

## v0.2.1（2026-08-31）

- Phase 3 工程化：测试汇总运行器、V8 覆盖率门禁、strict 棘轮、bench 入 CI、CHANGELOG 发布钩子；桌面 deb 更新引导、后台任务横幅、活动条合并、模型连通性测试、轨迹窄栏同显

## v0.2.0（2026-08-28）— Phase 2 结构治理

### 结构
- **server.js 拆路由模块**：全部 HTTP 路由抽至 `src/web/routes/api.js`（1299 → 579 行），服务器局部状态经 deps 显式传入（可变原语 state/refs 包装）
- **SPA JS 外置**：index.html 内联脚本抽至 `src/web/app.js`，CSP 收紧移除 `script-src 'unsafe-inline'`（417 行壳 + 1008 行逻辑）
- **cli.js 命令分发显式化**：`命令 → {module, handler}` 映射表替换字符串拼接三元嵌套；死导入清理

### 安全与正确性
- **SSRF 防护**：自定义模型/同步端点校验目标地址——对外监听时拒绝私网/回环/链路本地（本机回环绑定时放行本机模型服务，`web.allowPrivateEndpoints` 显式放行）
- **并发上限修复**：inflight 计数绑定请求生命周期（readBody 期间不再并发超限）
- **会话写互斥**：同一会话文件的追加与压缩重写按文件串行化
- **listen 修复**：runWebServer 等待绑定成功才 resolve，失败 reject；桌面端端口占用自动换端口重试（6 次），CLI 明确报错
- **sync-server 限流加固**：整表 clear → 最旧淘汰；键含用户名（防分布式 IP 绕过）；SYNC_TRUST_PROXY 控制 X-Forwarded-For；maxConnections 500
- **API Key 即时生效**：设置/删除 Key 后 provider 缓存失效，无需重启
- **更新下载失败可见**：发现新版本后下载出错弹窗提示官网手动下载；下载进度写日志

## v0.1.70（2026-08-28）— 更新器修复 · 静默可见性 · 布局重构

### 修复
- **Linux 自动更新下载失败根因**：打包环境下 `update-available` 回调的 info 参数为 undefined，旧代码 `info.version` 在监听器内抛 TypeError，中断 updater 事件派发导致 autoDownload 永不启动——全部监听器改 null-safe 且绝不在事件回调抛错
- **阶段静默深度优化**：服务端 progress 心跳新增阶段语义（模型推理中/执行工具中/等待权限确认）与子代理计数；客户端新增**顶部常驻活动条**（生成期间始终可见、滚动不影响：阶段 + 第 N 步 + 已 X 分 Y 秒 + N 工具步 + M 子代理）；回合边界（turnStart/turnEnd）继续播报
- **text=0 补偿反馈**：模型执行完工具但未输出总结时，done 提示改为「本轮共执行 N 步工具操作、交付 M 个文件，模型没有输出总结文字——可追问『总结一下刚才的工作』」

### 界面
- 输入框上方状态条文案缩短（⏳ N 步 · X 分 Y 秒 · N 工具步），移除冗余停止提示（按钮就在下方）
- **轨迹面板固定左侧栏**：聊天框左侧常驻「🧭 轨迹」栏，点击展开本轮轨迹详情（回合/工具/子代理），与消息顶部按钮等效
- **子代理面板右置**：顶栏「🤖 子代理 N」按钮展开右侧面板，列出本会话全部子代理（任务 + 结果可展开），与任务面板互斥
- Windows 更新完成弹窗改为友好提示（「更新已就绪」+ 正向文案，不再是报错观感）

## v0.1.69（2026-08-28）— 质量加固版（Phase 1）

### 修复
- 计费：`pricing.overrides` 根级价格现在同时传播到高峰价——此前高峰时段自定义价格被内置 peak 价替代，费用估算/护栏口径失真（H1）
- 调度：修复 every 任务执行期间 `pause` 被隐式恢复的确定性 bug（H2）；kill 前校验 PID 归属，防 PID 复用误杀（M11）
- 并发：新增 `src/atomic-write.js`（pid+随机 tmp 原子写 + O_EXCL 文件锁与陈旧锁回收）；config/credentials/update-state/session/session-index/sync 状态全部原子化；调度与任务读改写加锁（H3/H4）
- 压缩：手动 `/compact` 与自动压缩统一实现（同款 `<conversation_summary>` 标记，增量压缩可识别），修复双实现分叉（M7）
- 记忆：日期戳统一走配置时区（默认北京时间），修复 journal UTC 口径漂移（M8）
- 内存：undo 备份增加全局上限（64 文件 / 20MB，超限淘汰最旧），防长会话内存膨胀（M9）
- WebUI：主「■ 停止」只中断本任务（带 taskId），不再误伤其他标签页并发任务（L1）；`_activeTools` 被拒条目即时清理（L2）；任务面板保留最近完成历史并按年龄+数量双阈值清理（L3）
- 桌面/后台：worker/daemon/sleeper spawn 补 error 监听，ENOENT 不再崩进程（M12）；WebUI 自启失败给出可见提示（L6）

### 性能
- 上下文语义回收改为增量 token 求和（原每步全量重算，≤500×n）（M10）
- 费用护栏今日累计按 cache-stats 文件 mtime 缓存，不再每步全量解析（M10）

### 测试
- smoke 52 组 / e2e 21+16+7 / bench 38 断言全绿；新增原子写与文件锁、计费覆盖传播、pause 状态决策三组回归
