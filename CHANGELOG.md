# 更新日志（Changelog）

本项目自 v0.1.69 起维护变更日志；此前版本（0.1.0–0.1.68）的演进见 docs/QA-REPORT.md 与 git 历史。

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
