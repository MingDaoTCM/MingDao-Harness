# 下一步迭代规划（v0.2.2 → v0.3.0）

基于四路审计剩余清单、六份评估综合路线与近期反馈收敛。原则不变：每期可独立发布、全绿测试门禁、零依赖不动摇。**待确认后开工。**

## 待办盘点（当前真实剩余）

- 审计遗留（QUALITY-REVIEW 清单中未做的 12 项中低危）：sync-server devices/meta 互斥、sync login 密码走参数、fs-browse 基目录约束、readBody 按路由分级、draft 单槽、日志双文件 O(n) 重写、桌面崩溃循环护栏、notify 转义、cli 共享助手去重（offpeak/mcpFacade/参数解析）、会话/任务 misc。
- 结构渐进（0.2.1 标注的渐进项）：routes/api.js 按域细分、cli.js REPL/worker 拆分。
- strict 棘轮：1584 条隐式 any 待消（每版定削减配额，先安全关键模块）。
- 省钱路线剩余（EVALUATION-SYNTHESIS 中期 6 项）：工具 Schema 按需挂载、Batch 输入侧智能、费用二级分账+看板、护栏 downgrade、评测基准扩充（压缩质量集/路由标注集/V4 词表对拍）。
- 能力演进：跨平台沙箱补位、记忆语义检索、增量上下文。
- 工程：覆盖率阈值随版本上调、CHANGELOG 历史回填、GitHub Release 附件自动清理（需 PAT）。

## 分期方案

### Phase A「正确性收尾」v0.2.2（约 1–1.5 天）
审计遗留全部落地，零新功能：
1. sync-server devices/meta 读改写加锁（withFileLockSync 复用）
2. `mingdao sync login` 密码改隐藏输入/stdin，拒绝位置参数
3. `/api/fs-browse` 限定基目录集合（工作空间根+显式授权），禁止向上越界、不回传绝对路径
4. readBody 按路由分级（chat 40MB，其余 1MB）
5. draft 按会话维度存储（key=session 而非全局单槽）
6. 日志统一工具函数（append+按天滚动+按行截断），桌面/服务端共用口径
7. 桌面渲染进程崩溃计数护栏（超 3 次弹窗提示重启）
8. notify 结构化 argv（去掉启发式转义）
9. cli.js 共享助手抽取（offpeak defer、mcpFacade 构建、run/run-worker 参数解析合一）
- 验收：全绿 + 新增 fs-browse 越界与限流回归断言。

### Phase B「省钱第二轮」v0.2.4（已完成 ✅）
1. ✅ **工具 Schema 按需挂载**：只读阶段只发 read/ls/glob/grep/skill/todo + 已用工具；模型表达写意图后下一轮注入全量（`cfg.schemaTier=false` 可关）；已用工具深度瘦身（工具级 + 参数级描述清除，全用过降 48%）
2. ✅ **Batch 输入侧**：文本哈希去重（结果按 custom_id 回填全部位置）、单问超窗口预检报错、`--max-cost` 提交前估算拦截
3. ✅ **费用二级分账 + 看板**：cache-stats 增 reasoning / byTool 维度；WebUI 仪表盘加模型/工具 Top5 与近 14 天费用折线（零依赖 SVG）；`mingdao cost report` 增按工具分账表
4. ✅ **护栏 downgrade**：`action:'downgrade'` —— 触顶后自动切 flash 继续执行 + 明确提示（warn/block 仍可选；已是 flash 则按 block 处理）
5. ✅ **评测基准扩充**：压缩质量集（5 组长会话样本 → 压缩 → 关键事实存活断言 + 尾部字节不变）、路由标注集扩至 100 条；bench 断言数 38 → 150+；覆盖率阈值 55% → 60%
- 版本说明：v0.2.3 被 0.2.2 桌面启动崩溃的紧急修复占用，Phase B 顺延为 v0.2.4。

### Phase C「结构渐进」v0.2.5（约 2 天）
1. routes/api.js 按域细分（config/sessions/sync/schedule/skills/workspace/misc 7 模块 + 共享中间件），每域配 API 契约测试
2. cli.js REPL → commands/repl.js、worker → tasks/worker.js（e2e-local 16 项全绿做护栏）
3. strict 棘轮削 300 条（先 credentials/permissions/config/sync-server/session 五个安全关键模块全量注解）
- 验收：tsc full 错误数 ≤1284；结构清单在文档登记。

### Phase D「能力演进」v0.3.0（约 3–5 天，可按需裁剪）
1. **跨平台沙箱补位**：Windows Job Object + 降权 token（零依赖原生 API）、macOS seatbelt 规则；敏感命令平台无关拦截清单兜底
2. **记忆语义检索**：零依赖实现（内存向量 + 余弦/哈希相似度；Node 22 可用 node:sqlite 持久化，Node 18 回退 JSONL 索引），记忆注入从「最近 3 条」升级为「相关 3 条」
3. **WebUI 看板扩展**：预算燃尽预测、费用导出 CSV
4. GitHub Release 附件自动清理 + 发布清单文档化

## 已落地（本轮 Phase D 部分项提前完成）
- **GitHub Release 附件自动清理（PAT 已接入）**：新增 `scripts/github-release-cleanup.mjs`——官网同步（收割 + sha512 MATCH 校验）后删除 Release 上的全部构建转运附件，只留指向官网的正文。用法：`MINGDAO_GITHUB_TOKEN=<PAT> node scripts/github-release-cleanup.mjs <版本号> [--dry-run]`。token 存本地 gitignored `.env`（`MINGDAO_GITHUB_TOKEN`，模式 600），不入库。验证：v0.2.2 官网同步后已清理 9 个附件，官网下载不受影响。

## 需要你拍板的事

1. **Phase 顺序**：A→B→C→D 直接推进，还是把 B（省钱）提前到 A 之前？（PAT 已到位，Phase D 附件清理已基本完成）
2. **Phase D 裁剪**：跨平台沙箱与语义检索是否都进 0.3.0，还是只做其一？
