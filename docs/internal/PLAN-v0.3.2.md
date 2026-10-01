# v0.3.2 规划：本地模型自适应（资源受限部署不中断）

## 背景（用户 MacBook M5 Pro 实测定位结论）

本地部署 `mtplx-qwen38-27b`（131072 窗口 + q8 KV 量化）跑 71 步长任务时 network error。
其他 agent 定位结论：**不是内存拒绝，是「长上下文 prefill 过慢 → 客户端等待超时主动断连」**。

- 服务端无任何 507/内存拒绝，q8 生效，峰值 47.38GB < 48G 预算。
- 失败请求：prompt=127,912 / 131,072（窗口边缘），`request_cancelled=client_disconnected`，
  188.9s 内 0 token 输出。
- prefill 指数恶化：ttft 46.4s → 67.8s → 96.0s → 196.5s → 中断（189s 无输出）。
  根因：每轮全量历史 + 上一轮大段代码输出回灌，新增 prefill 从 7.9k 涨到 32k，
  prefill 速度仅 ~165–185 tok/s，ttft 超过客户端等待阈值。

调用 DeepSeek 官方 API 无此问题（窗口 1M + prefill 极快），说明瓶颈在「资源受限的本地模型」，
必须做成**共性能力**：其他客户本地部署更小模型（窗口小/内存少）也会踩，不能只修 MacBook。

## 目标

让 MingDao 针对不同「参数 / 上下文窗口 / KV cache / 机器资源」的模型**灵活自适应**，
小模型、低内存自动收紧参数适应，不撑爆、不误杀；本地慢 prefill 不被一刀切超时掐断。

## 方案（本次实现）

### 1. 模型能力解析（`src/model-caps.js` 新增）
单一来源解析 `contextWindow / maxOutputTokens / isLocal`：
- 优先级：`customModels.<name>.contextWindow/maxOutputTokens` > 内置 preset > 兜底。
- 兜底：本地模型 32k、远程 128k（本地小模型宁可保守不撑爆）。
- `isLocalBaseUrl`：127.0.0.1 / localhost / 私网 IP 判定本地推理框架。

### 2. 安全预算推导（`safeBudget`）
`budget = min(期望 contextBudget, 窗口×75% 舒适区, 窗口 − maxOutput − 2048 余量)`。
prompt 永不逼近窗口边缘（75% 以上 prefill 时间陡增），从根上避免 prefill 爆炸。
对内置模型零影响（pro 200k / flash 128k 均远小于各自窗口 75%）。

### 3. 分层超时（providers）
- 首 token 等待：本地 600s / 远程 300s（覆盖慢 prefill）。
- 流式空闲：有帧后 120s 无新帧即断（真挂死才断）。
- 总量：本地 30min / 远程 10min。
- `config.timeout.{firstTokenMs,streamIdleMs,totalMs}` 可覆盖；`parseStream` 按「帧到达」刷新
  空闲计时（prefill 阶段服务端可能先发 usage-only 帧，不误杀）。

### 4. 边缘检测 + 强制压缩
模型每轮上报真实 `prompt_tokens`，≥ 窗口 85% 时下一轮 `force` 压缩——即便非 DeepSeek 模型
启发式计数低估（误差 ±2 倍）也强制触发（`compact.js` force 绕过触发线门槛）。

### 5. 工具输出截断自适应
单条工具结果按 `窗口/16` 封顶（最少 2000 字），小窗口不再整条回灌大段代码。

### 6. 配置/UI 打通
- `customModels.<name>.contextWindow/maxOutputTokens`（WebUI 添加自定义模型表单新增两项）。
- `config.timeout.*`（设置 → 通用面板新增三项，秒为单位，留空自适应）。
- `/api/config`、`/api/models-config` 契约扩展。

## 验收

- smoke 新增 model-caps（本地/远程判定、窗口兜底/显式声明、舒适区+输出余量预算）与
  provider 分层超时（首 token vs 流式空闲）两组断言。
- 全绿：smoke 69 组 / e2e-local / e2e-web / e2e-schedule / api-contracts / bench；strict 0/0。
- 用户在 3820 用本地模型跑长任务验收，确认无 network error 中断后发布。

## 非目标（顺延）

- 增量上下文（基线+变化）——自动续跑 + 语义检索已覆盖省钱与长程主场景。
- 本地窗口自动探测（从服务端 /models 读 max_model_len）——依赖各家推理框架能力，暂用显式声明。
