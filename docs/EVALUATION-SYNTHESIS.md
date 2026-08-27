# 六份第三方技术评估综合分析与优化路线（2026-08-27）

对 `/persistent/home/YouLi/办公云盘/MingDao-Harness` 下六份评估（DuMate / Hermes / Kimi / MiniMax / OfficeACE×3 / workbuddy）逐份研读后，结合当前代码核实的综合结论与行动计划。

## 一、报告结论速览

| 报告 | 视角 | 结论 |
|---|---|---|
| DuMate | 逐文件代码审计 + 评分卡 | 架构 9/10、安全 9/10、可维护性 7/10；定位兑现度高 |
| Hermes | 省钱定位深度剖析 + 冒烟实跑 | "实现程度高、技术路线正确"；缓存前缀稳定性是"最值钱的设计判断" |
| Kimi | 实现度评估 | 8.2/10；发现 1 个 P0（峰谷窗口）与多个 P1（思考强度/上下文字段） |
| MiniMax | Token 优化评估 | 重度使用可降至裸调 20–35%；P0-1"压缩破坏前缀"（与 Kimi 表扬相矛盾，经核实为观察角度差异） |
| OfficeACE | 迭代方向 + 优化方案 O-01~O-19 | 8.5/10；显式缓存控制/技能压缩/路由优化为共识 P0 |
| workbuddy | 全量克隆 + 实测 | 8.5/10；smoke 51 + e2e 16 全过 |

**共识**：六份报告一致认可"省 Token 省钱"定位兑现度高；共同短板是 WebUI 单体、价格/词表数据硬编码、记忆检索弱、评测基准缺失。

## 二、已核实并修正的问题（本版 0.1.66 实施）

### P0-1 峰谷窗口与避峰顺延错误（Kimi 报告 P0，官方口径核实）
- 现象：代码按单窗口"工作日 9:00–14:00 高峰"计价；`--offpeak` 把任务顺延到 14:00——恰是第二段高峰起点，**功能效果与意图相反**；14:00–18:00 费用被低估一倍。
- 官方权威口径（https://api-docs.deepseek.com/zh-cn/quick_start/pricing/）：**高峰 = 北京时间周一至周五 9:00–12:00、14:00–18:00；其余为闲时；闲时价 = 高峰价一半**。
- 已修复（`src/pricing.js` / `cli.js` / `schedule.js` / `tasks.js` / `models.js` / WebUI / README / docs / smoke 12 组断言）：
  - `isPeakHour`：双窗口判定，午间 12:00–14:00 与周末全天为闲时；
  - `deferToOffpeak`：上午高峰 → 顺延 12:00；下午高峰 → 顺延 18:00；闲时原时刻执行；
  - 高峰窗口经 `config.pricing.peakWindows` 可配置（官方调整时可零代码跟随）；
  - 新增 `peakStatusLabel()` 供面板/备注显示当前时段。

### P0-2 桌面版「检查更新」点击无响应（用户反馈）
- 现象：菜单点击后任何路径异常（electron-updater 导入失败 / 事件不触发 / 网络挂起）都会静默吞掉。
- 已修复（`desktop/main.js`）：全程 try/catch + promise 结果兜底 + 30 秒超时兜底；已是最新时提示 **"当前版本：v0.1.66，已是最新版本"**；检查中并发给出可见反馈。

### P1 桌面版设置改多级菜单（用户反馈）
- 现象：⚙ 设置一拉到底（模型/同步/沙箱/调度/工作空间/记忆/仪表盘/MCP/技能库 9 块混排）。
- 已修复（`src/web/index.html`）：左侧分组导航 + 右侧面板（🔑模型与密钥 / ☁️云同步与协作 / 🛡️通用与权限 / ⏰调度队列 / 📁工作空间 / 🧠长期记忆 / 📊缓存仪表盘 / 🔌MCP 生态 / 🧩技能库），记住上次分组、窄屏自动横向导航，全部控件 id 不变。

### P1 界面与会话样式对齐 DeepSeek-Harness
- 以 gitcode.com/MingDaoTCM/deepseek-harness 的 `packages/client/ui-theme/src/styles/design-platform.css` 实测值为准对齐暗色体系：
  - 基色 `#151517`、侧栏 `#1B1B1C`、面板 `#2C2C2E`、悬浮 `#353638`、边框 `rgba(255,255,255,.12)`；
  - 文字 `#F9FAFB` / `#ADB2B8` / `#81858C`；错误 `#F25A5A`、警告 `#F59E0B`；
  - 用户气泡改 DSH 式扁平中性底 + **22px 圆角** + 16px/24px 排版（上限 min(525px,82%)）；
  - 行内代码 `#2C2C2E` 底；代码块 `#1B1B1C` + 横幅 `#2C2C2E` + 12px 圆角 + 语言标签 + 一键复制；
  - 主按钮 DSH 暗色近白填充；滚动条 `#3C3C3D`/hover `#545557`。

## 三、下一步优化路线（按投入产出排序）

### 近期（0.1.67~0.2.0，每项半天~1 天）
1. **思考强度三档透传**（Kimi P1-B，单点收益最高）：`models.js` 加 `reasoningEffort`、Provider 透传 `reasoning_effort`，辅助调用（标题/记忆/分类器）固定 `low`，`/think low|high|max` 切换。预期简单问答输出 token 降 50%+。
2. **上下文窗口字段修正**（Kimi P1-C）：`contextWindow` 1M、新增 `maxOutputCeiling`、pro 默认 `maxOutputTokens` 65536，减少大文件生成的续写重复计费。
3. **价格表外置 + 自动刷新**（Hermes C1）：内置表兜底 + `~/.mingdao/pricing.json` 官方价跟随（TTL 7 天），`/cost` 在数据时点超 60 天时提示"价格表可能过期"。
4. **轻量语义回收**（Hermes B1）：预算 80% 触发 O(1) 回收（最老 tool 消息 → 摘要行、旧 assistant 长文截前 200 字），不破坏前缀，重压缩线下移到 90%。
5. **路由升级检测 + 第三态**（Hermes C2 / Kimi）：粘滞会话内按生成词/截断次数/工具步数允许升 planner；分类器"不确定"→ 保守走 planner。

### 中期（0.2.x，2–5 天）
6. **reasoning 回填裁剪**（MiniMax P0-2）：推理链 >1000 字符截尾 500 + 关键决策标记；>4000 完全丢弃留一句概括。
7. **增量式压缩**（Kimi P2-D）：`compressedUntil` 游标，只对增量段摘要，压缩输入从 O(历史) 降为 O(增量)。
8. **护栏前置预估**（Kimi P2-E）：发请求前按"trimmed prompt×未命中价 + maxOutput×输出价"估算最坏成本，超限发送前拦截。
9. **同回合工具去重 + 会话级 read 缓存**（Hermes C4 / MiniMax P2-2）：相同参数只读工具合并执行；read 按 mtime+size 去重。
10. **工具 Schema 按需挂载**（MiniMax P3-5 / Hermes A1）：只读阶段只给 read/ls/glob/grep，每请求省 1–2K tokens。
11. **Batch 输入侧优化**（Kimi P3-F）：文本哈希去重、单问超窗口报错、`--max-cost` 截断。
12. **评测基准起步**（Hermes E2）：`test/bench/` 压缩质量集 / 路由准确率集 / tokenizer 黄金值回归。

### 长期（0.3.x+，可选）
13. 跨平台沙箱补位（Windows Job Object + 降权 token；macOS seatbelt）。
14. tokenizer 缓存真 LRU + 大文本分级缓存（Kimi P3 / Hermes E3）。
15. 费用二级分账（reasoning/tool 维度）+ WebUI 看板扩展。
16. WebUI 单体拆分（`routes/` + 前端区块化）——与"轻量单文件易部署"权衡后分阶段做。

## 四、不建议采纳（通用 AI 幻觉式建议）

| 建议 | 原因 |
|---|---|
| TypeScript 全量迁移 / i18n 框架 / OpenTelemetry | 工具链级重写，与"零运行时依赖 + 单文件可部署"冲突；渐进 JSDoc 即可 |
| onnxruntime WASM tokenizer / fasttext 本地分类器 / 向量嵌入检索（外部库） | 引入重依赖；语义检索可用 `node:sqlite` + 简单相似度保持零依赖 |
| better-sqlite3 会话索引 | Node <22 无内置 `node:sqlite`；当前 JSONL+bigram 倒排够用 |
| A/B 双模型对比路由 | 与省钱目标直接矛盾（同时调两模型） |
| "固定 prefix 参数 / since message_id 增量 API" | 以可能不存在的 API 为前提 |
| LLMLingua 压缩 / Speculative Execution | 外部库或高风险推测收益 |
| MiniMax P0-1 "压缩延迟注入" | 与 Kimi 对滞回压缩的表扬相矛盾；压缩本就发生在轮间，收益被夸大 |

## 五、口径勘误记录（报告间矛盾核实结果）

- 峰谷窗口：Kimi 正确（双窗口），MiniMax 漏查 → 已按官方口径修复。
- "无自动避峰调度"（OfficeACE 二/三）：不实，`run --offpeak` / `schedule add --offpeak` / WebUI 均已实现 → 本版修正了顺延目标。
- 上下文窗口 384K vs 1M：Kimi 指出 384K 实为最大输出规格 → 已列入近期路线第 2 条。
