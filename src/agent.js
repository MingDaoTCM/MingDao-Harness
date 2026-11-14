// Agent 核心循环：消息 → 模型（流式）→ PreToolUse 钩子 → 权限引擎 → 工具执行
// → PostToolUse 钩子 → 结果回填 → 循环，直到模型给出纯文本回复。
// 附带：子代理（task 工具）、todo 清单状态、undo 备份仓、Ctrl+C 中断。
//
// v0.7.0 §1.5：**文案 / 预测层已迁至 ./messages.js**（逐字搬运、逻辑零变化）——
// 本文件只保留循环与编排；导出面由下方 `export { … } from './messages.js'` 逐字保留。

import path from 'node:path';
import { trimMessages, messageTokens, approxTokens } from './context.js';
import { compactConversation } from './compact.js';
// 审计 M-1 §2.1 第 4 条（Pack 反向提权）：`makeToolCtx` 把内核 ctx 剪成"工具面向的 ctx"并冻结。
// 两个对象从此分开：内核 ctx（makeCtx() 的产物）只在循环内用；工具只拿到 makeToolCtx() 的白名单对象。
import { buildToolSchemas, dispatch, makeToolCtx } from './tools/index.js';
import { DEFAULT_MODEL, modelPreset } from './models.js';
import { resolveModelCaps, safeBudget, EDGE_RATIO, isLocalBaseUrl } from './model-caps.js';
// v0.6.18 §3.74：预检已读到引擎自述 n_ctx 时，**发请求前**按 n_ctx×0.8 clamp 预算（纯函数）。
import { clampContextBudgetToEngine } from './model-discovery.js';
import { makeTokenCounter } from './tokenizer.js';
import { createHooks } from './hooks.js';
import { createIO, style, C } from './ui.js';
import { subagentModel } from './routing.js';
import { writeAuditAsync } from './audit.js';
import { redactSecrets } from './redact.js';
import { checkCostGuard, costGuardConfig, todayCost, preflightBlockMessage, roundGuardAction } from './cost-guard.js';
import { recordCacheStats, packDailyCost } from './cachestats.js';
import { estimateCost, cacheSplit, isPeakHour } from './pricing.js';
import {
  resolveProviderConfig,
  createProvider,
  localGateSnapshot,
  localConcurrencyLimit,
  // v0.6.26 §3.91：端点级内存安全预算的读/学/上调（文件读失败一律降级为"无学习值"）
  endpointLimitFor,
  learnEndpointMemoryFailure,
  noteEndpointSuccess,
  ENDPOINT_UPGRADE_SUCCESS_STREAK,
} from './providers/index.js';
import { compileConstraints, checkPreTool, checkPostTool, checkOutput, blockedOutputText } from './constraints.js';
import { createLedger, newRunId } from './ledger.js';
import { registerEgressSink } from './net-guard.js';
import { getActivePackContext } from './packs.js';
import { mingdaoHome } from './config.js';
import { appendEvent, eventFileFor, eventLogEnabled, missingToolCallIds, setEventLogEnabled } from './session-events.js';
// v0.6.11（审计 P1-1 拆分第三刀）：工具编排两端的判据单源在 tools-flow.js——
// ① 本轮可见哪些工具（只读档 × 预设白名单 × 已用工具快照 × MCP 只读标注）；
// ② 工具结果怎么回填（序列化 / 复用前缀 / 约束拒绝文案 / 按窗口截断）；
// ③ 工具参数怎么解析（v0.6.17 第四刀：JSON + 容错 + 归一化 + 错误文案）。
import { READONLY_TIER_SET, visibleToolsFor, serializeToolResult, toolResultMessage, parseToolArgs } from './tools-flow.js';
// v0.6.40：插话"有→继续、无→收尾"的判据与前端共用同一份纯函数（viewmodel 不读 DOM/全局）。
import { shouldContinueAfterModel } from './web/viewmodel.js';

const MAX_STEPS = 24;
// 子代理步数上限：审计/精读类只读子任务需要读多个文件 + 交叉引用，12 步易在「读不全」时被截断
// （v0.3.0 桌面版审计实测：多个只读子代理报「因达到步数上限停止读取」或「子任务无输出」）。
// 提到与主循环一致（24），只读子任务每步是 read/grep（输入便宜、无输出 token），成本增量可忽略。
const SUBAGENT_MAX_STEPS = 24;
// v0.7.0 §1.5（拆分第一刀）：**文案 / 预测层已迁至 ./messages.js**，本文件只保留循环与编排。
// 迁移是逐字搬运、逻辑零变化；导出面用显式列名再导出（见下方 `export { … } from './messages.js'`），
// 因此既有的 `import { X } from './agent.js'` 调用点（tests 与 src/web/server.js）**一行都不用改**。
import {
  shouldPrintTtftNotice,
  ttftNoticeStateFor,
  SUBAGENT_WAIT_GRACE_MS,
  MEMORY_RECOVERY_LEVELS,
  MAX_MEMORY_RETRIES,
  memoryRecoveryTarget,
  resolveNoProgressTimeoutMs,
  prefillForecast,
  noProgressNotice,
  inheritedStopNotice,
  zeroToolCallNotice,
  describeUpstreamError,
  startsInReadOnlyPhase,
  // 下面三个不是对外导出面：本文件的循环里还要用（只读档自愈要复判写意图/未达成意图，
  // 内存降级与账本日志要格式化数字）。它们与判定逻辑留在同一处，避免第二份词表。
  hasWriteIntent,
  looksLikeUnmetIntent,
  TTFT_NOTICE_DEFAULT_QUIET_MS,
  fmtTok,
} from './messages.js';

// ---------------------------------------------------------------------------
// v0.7.0 §1.5：以下文案 / 预测层（TTFT / 看门狗 / 内存降级 / prefill 外推 / 收尾与进度文案 / 只读档判定）
// 的实现已迁至 ./messages.js。这里只做**再导出**——显式列名（便于 grep，不用 `export *`），
// 导出面与迁移前逐字一致，所以测试与 src/web/server.js 的导入一行都不用改。
// ---------------------------------------------------------------------------
export {
  shouldPrintTtftNotice,
  ttftNoticeStateFor,
  DEFAULT_NO_PROGRESS_TIMEOUT_MS,
  SUBAGENT_WAIT_GRACE_MS,
  MEMORY_RECOVERY_LEVELS,
  MAX_MEMORY_RETRIES,
  memoryRecoveryTarget,
  endpointLearnedNotice,
  resolveNoProgressTimeoutMs,
  PREFILL_WARN_RATIO,
  PREFILL_WARN_TOKENS,
  PREFILL_SLOW_WARN_MS,
  PREFILL_LONGCTX_EVIDENCE,
  prefillEstimateMs,
  prefillForecast,
  noProgressNotice,
  inheritedStopNotice,
  zeroToolCallNotice,
  describeUpstreamError,
  formatTurnProgress,
  startsInReadOnlyPhase,
} from './messages.js';

// 只读档工具集（省钱 B1 的「只读阶段」）——**单一来源已移到 `tools-flow.js`**（v0.6.11 / P1-1 第三刀）：
// 它与「本轮可见哪些工具」的判据是同一条规则，放在一起才能保证"改一处就够"。
// 这里只做**再导出**：bench/smoke 既有的 `from './agent.js'` 导入面与集合内容都不变（行为零变化）。
export { READONLY_TIER_SET };

/** 该模型请求实际发往的 baseUrl（端点级学习/并发闸门共用同一口径；取不到时返回 ''）。 */
function resolveEndpointBaseUrl(/** @type {any} */ cfg, /** @type {any} */ modelName) {
  try {
    return String(resolveProviderConfig(cfg, modelName)?.baseUrl || cfg?.baseUrl || '');
  } catch {
    return String(cfg?.baseUrl || '');
  }
}

/**
 * v0.7.0 §1.1：解析本会话的事件侧车。优先级：`cfg.eventFile`（测试/嵌入方显式指定）>
 * `sessionRef.file` > `<MINGDAO_HOME>/sessions/<sessionRef.name>`。
 * 任何异常都返回 null——事件日志是旁路，路径解析失败不得影响回合。
 * @param {any} sessionRef
 * @param {any} cfg
 * @returns {string|null}
 */
function resolveAgentEventFile(sessionRef, cfg) {
  try {
    if (cfg?.eventFile) return eventFileFor(String(cfg.eventFile));
    const ref = sessionRef || {};
    if (ref.file) return eventFileFor(String(ref.file));
    if (ref.name) return eventFileFor(path.join(mingdaoHome(), 'sessions', String(ref.name)));
  } catch {}
  return null;
}

/**
 * v0.6.40：把插话缓冲里的**全部**条目注入当前回合的消息数组。
 *
 * 车道语义（与 next-turn 排队严格区分）：
 *   · 每个 step 边界调用一次，`drain()` 必须**全量取走**（不是一条一步）；
 *   · 每条插话以 `{role:'user', content:text}` 追加在末尾——模型下一步请求就能看到；
 *   · 通过既有 io 事件通道推 `{type:'steer', text}`（Web 端渲染"↳ 已插入本轮"）。
 *
 * 纯判据（"有插话→继续"）在 web/viewmodel.js 的 shouldContinueAfterModel；这里只做副作用。
 * drain 抛异常的边界：视为本轮没有插话（插话是旁路，绝不能让一个坏 buffer 打断回合）。
 *
 * @param {{ drain?: () => any } | undefined} steering
 * @param {any[]} messages
 * @param {any} io
 * @returns {any[]} 本次实际注入的条目（供收尾分支判断是否继续）
 */
function drainSteeringInto(steering, messages, io) {
  /** @type {any} */
  let raw;
  try {
    raw = steering?.drain?.() || [];
  } catch {
    return [];
  }
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.taken) ? raw.taken : [];
  /** @type {any[]} */
  const injected = [];
  for (const it of list) {
    const text = String(it && typeof it === 'object' ? it.text ?? '' : it ?? '');
    if (!text.trim()) continue;
    messages.push({ role: 'user', content: text });
    injected.push(it);
    try {
      if (typeof io?.steer === 'function') io.steer(text);
      else if (typeof io?.push === 'function') io.push({ type: 'steer', text });
    } catch {}
  }
  return injected;
}

// v0.7.1（审计报告1 S-2/H-2）：把"并行只读批 + allSettled 收集"抽成模块级 helper，
// 避免把这段展开在 runTurnInner 里又把结构基线顶破（基线只许降不许升）。
// allSettled：单个兄弟工具即使拒绝也绝不整体丢弃其余并行结果；rejected 记 {ok:false} 占位。
async function runToolBatch(
  /** @type {any[]} */ items,
  /** @type {(prep: any) => Promise<any>} */ runTool,
  /** @type {(prep: any, result: any, t0: number) => Promise<any>} */ finishTool
) {
  const settled = await Promise.allSettled(
    items.map((/** @type {any} */ b) => {
      const t0 = Date.now();
      return runTool(b.prep).then((r) => ({ r, t0 }));
    })
  );
  for (let idx = 0; idx < items.length; idx += 1) {
    const s = settled[idx];
    if (s.status === 'fulfilled') await finishTool(items[idx].prep, s.value.r, s.value.t0);
    else await finishTool(items[idx].prep, JSON.stringify({ ok: false, error: String(s.reason?.message || s.reason) }), Date.now());
  }
}

/**
 * 创建 Agent 循环（调用方只需传 provider/permission/io/modelName/workingDir，其余可选）
 * @param {{ provider: any, permission: any, io: any, modelName: any, workingDir: any,
 *   cfg?: any, undoStore?: any, maxSteps?: number, mcp?: any, onCompact?: any, sessionRef?: any,
 *   onUsage?: (modelName: string, usage: any) => void,
 *   constraints?: any[],
 *   steering?: { drain?: () => any } }} params
 */

export function createAgent({ provider, permission, io, modelName, workingDir, cfg = {}, undoStore, maxSteps, mcp, onCompact, sessionRef, onUsage, constraints: rawConstraints, steering }) {
  const preset = modelPreset(modelName) || {};
  // v0.3.2 模型自适应：预算按模型上下文窗口推导（留输出余量 + 75% 舒适区），
  // 自定义/本地小模型不再套 128000 默认撑爆窗口；prompt 永不逼近窗口边缘（prefill 不爆炸）。
  const caps = resolveModelCaps(cfg, modelName);
  // v0.6.26 §3.91：子代理实例（spawnTask 传入 parentProgress / 子任务标记）。子代理的成功**不**计入
  // 端点"连续干净成功"——一个父回合里可能跑多个子代理，否则一次回合就能把 +25% 的上调门槛凑满。
  const isSubagent = Boolean(cfg?.parentProgress || cfg?.subagentLabel);
  // v0.7.0 §1.1：事件双写的开关与出口（旁路：任何失败只 warn，绝不影响回合结果）。
  // `cfg.eventLog === false` 时**同时**停掉 session.appendMessages 的 message.append 双写，
  // 否则只会关掉 agent 事件、留下半份事件流。子代理不重复设置进程开关（父代理已设）。
  const eventsOn = eventLogEnabled(cfg);
  if (!isSubagent) setEventLogEnabled(eventsOn);
  let eventFileKey = '';
  let eventFileCache = /** @type {string|null} */ (null);
  let eventWarned = false;
  const sessionEventFile = () => {
    const ref = /** @type {any} */ (sessionRef || {});
    const key = `${String(cfg?.eventFile || '')}|${String(ref.file || '')}|${String(ref.name || '')}`;
    if (key !== eventFileKey) {
      eventFileKey = key;
      eventFileCache = resolveAgentEventFile(sessionRef, cfg);
    }
    return eventFileCache;
  };
  /** @param {string} type @param {any} data */
  const emitEvent = (type, data) => {
    try {
      if (!eventLogEnabled(cfg)) return;
      const file = sessionEventFile();
      if (!file) return;
      const r = appendEvent(file, { type, data });
      if (!r.ok && !eventWarned) {
        eventWarned = true;
        console.warn(`[MingDao] ⚠ 会话事件日志写入失败（${file}）：${r.error}——事件日志本次不完整，不影响会话与回合结果。`);
      }
    } catch {}
  };
  // step 边界：step.start 在本步开始时写；step.end 在**下一步开始前 / 回合收尾**补写，
  // 因此即使某个出口提前 return，事件流里也不会留下永远不结束的 step。
  /** @type {{step:number,round:number}|null} */
  let openStep = null;
  /** @param {string} status */
  const closeStep = (status) => {
    if (!openStep) return;
    const s = openStep;
    openStep = null;
    emitEvent('step.end', { step: s.step, round: s.round, status });
  };
  /** @param {number} step @param {number} round */
  const beginStep = (step, round) => {
    closeStep('next');
    openStep = { step, round };
    emitEvent('step.start', { step, round });
  };
  // safeBudget 恒用：即使用户显式 contextBudget 也套「窗口−输出−余量」上限与 75% 舒适区，
  // 防显式值撑爆窗口（本地模型窗口可能只有 32k/131k，用户却留了默认 128000）。
  const safeB = safeBudget(cfg, caps);
  // v0.6.18 §3.74（自适应上下文）：预检若已读到**引擎自述 n_ctx**，配置预算再大也没用——
  // 发出去就会在 prefill 阶段被引擎以 insufficient memory 拒绝。这里在**创建 agent 时**
  // （即第一次请求之前）就 clamp 到 n_ctx×0.8，并在第一回合开始前打印一条明确提示。
  const budgetClamp = clampContextBudgetToEngine({
    contextBudget: safeB,
    configuredBudget: Number(cfg?.contextBudget) > 0 ? Number(cfg.contextBudget) : null,
    engineCtx: cfg?.endpointProbe?.engineCtx ?? null,
  });
  const configuredBudget = budgetClamp.budget ?? safeB;
  // v0.6.26 §3.91（端点级学习）：该 baseUrl 若曾"多级压缩后仍失败"，**本回合起手就用学到的
  // safeContextBudget**，而不是每回合从同一个注定失败的预算重撞一次（真机三次同形态失败）。
  // 读文件失败只打一条 warn 并退化为"无学习值"，绝不影响会话（见 readEndpointLimits）。
  const endpointBaseUrl = resolveEndpointBaseUrl(cfg, modelName);
  const learnedLookup = endpointLimitFor(endpointBaseUrl);
  if (learnedLookup.error) {
    try { if (io?.print) io.print(style(`⚠ ${learnedLookup.error}`, C.yellow)); } catch {}
  }
  const learnedBudget = Math.floor(Number(learnedLookup.record?.safeContextBudget) || 0);
  // 只在学习值**确实小于**配置预算时接管；配置本来就比学习值小时，用户的选择优先。
  const learnedApplied = Boolean(learnedBudget > 0 && learnedBudget < configuredBudget);
  const budget = learnedApplied ? learnedBudget : configuredBudget;
  const learnedStart = learnedApplied ? { ...learnedLookup.record, appliedBudget: budget } : null;
  const budgetClampNotice = budgetClamp.clamped ? budgetClamp.notice : '';
  // maxOutput 也按窗口封顶：显式配超大 maxOutputTokens 时，prompt(预算)+output 仍不得越过窗口
  // （预算已按 caps.maxOutputTokens 留余量，但显式值可能更大——此处兜底，防服务端截断/拒绝）
  const maxOutput = Math.min(
    cfg.maxOutputTokens || caps.maxOutputTokens,
    // v0.4.6：显式 maxOutputTokens 也要受官方单次输出规格（maxOutputCeiling，DeepSeek 384K）约束——
    // 该字段此前只定义不生效，README 的「单次输出上限 384K」实际拿不到。
    caps.maxOutputCeiling || Number.MAX_SAFE_INTEGER,
    Math.max(1024, caps.contextWindow - budget)
  );
  // v0.3.2 工具输出截断自适应：窗口越小截得越狠（单条工具结果按窗口 1/16 封顶，最少 2000 字），
  // 但绝不超过旧默认 20000（大窗口模型如 1M 不因公式放大回灌、不推高成本）。
  // 本地小模型（32k 窗口 → 2k 字）不再把大段代码/日志整条回灌，省 prompt 且不撑爆窗口。
  const toolResultCap = Math.min(20000, Math.max(2000, Math.floor(caps.contextWindow / 16)));
  const temperature = cfg.temperature ?? preset.temperature ?? 0.6;
  const reasoningEffort = cfg.reasoningByModel?.[modelName] ?? cfg.reasoningEffort ?? preset.reasoningEffort?.default ?? undefined;
  const hooks = createHooks(cfg.hooks, workingDir, cfg);
  // v0.5.0 阶段 A3：领域约束（Pack API v1 的「领域红线」）——在三个时机强制：
  // PreToolUse（工具/参数）、PostToolUse（工具结果缺项）、输出前（正文禁用措辞）。
  // 约束**只收紧不放松**权限；未传约束时 compiled.active=false，所有检查点完全惰性，
  // 对既有行为零影响（这是接入主循环时最重要的不变量）。
  // 显式传入优先；否则取进程级已挂载的 Pack 约束；都没有 → 空集合（惰性）
  const constraints = compileConstraints(
    Array.isArray(rawConstraints) ? rawConstraints : cfg?.constraints ?? getActivePackContext()?.constraints
  );
  /** 约束事件写审计（pack/constraint/kind/stage/action）——受监管场景要能回答「红线何时被触发」 */
  // v0.7.0 §1.4：约束事件也在 Web 请求路径上（工具执行/输出前检查），审计写必须异步，
  // 否则外部进程持 audit.jsonl.lock 时会冻住整个事件循环。同步版 writeAudit 保留给 CLI 调用链。
  const auditConstraint = async (/** @type {any} */ ev) => {
    // v0.6.0 C1：账本与 audit 在此**同一处**记录——三个时机（pre/post/output）都汇聚到这里，
    // 新增时机时不需要记得再补一处账本埋点。
    // 只记「哪条约束、什么时机、如何处理」，**不记命中的原文**（否则账本自身成为泄露渠道）。
    if (turnLedger && ev) {
      turnLedger.constraint({ kind: ev.kind, id: ev.id, stage: ev.stage, tool: ev.tool, action: ev.action ?? ev.decision });
    }
    if (cfg.audit === false || !ev) return;
    try {
      await writeAuditAsync({ at: Date.now(), session: sessionRef?.name ?? null, model: modelName, tool: null, constraint: ev });
    } catch {}
  };
  const todos = /** @type {any[]} */ ([]);
  // v0.4.6 修复：当前 runTurn 的 usage 累加器引用——spawnTask 定义在 runTurn 之外，
  // 此前子代理的 token 消耗只用于生成汇报文本、从不并入父回合 usage，导致「今日费用」系统性少计
  // （CLI/REPL 每次派子代理都漏计；README 主推的「多方向并行调研」场景漏计最重）。
  // runTurn 开始时指向本轮 usage，finally 清空；runTurn 之外调用 spawnTask 时为 null（安全跳过）。
  let currentUsage = /** @type {any} */ (null);
  // v0.6.18 §3.74：本回合的「内存降级重试」记录（runTurn 内写、runTurn 包装层读）与本回合
  // 必须进 done.note 的提示（clamp 提示 / 压缩重试提示）。声明在 runTurn 之外，包装层才能把
  // 这些提示统一追加到**每一条** return 路径上（runTurn 内部有十几个 return，逐条补会漏）。
  let lastMemoryRecovery = /** @type {any} */ (null);
  let turnNotes = /** @type {string[]} */ ([]);
  /** clamp 提示每个 agent 只打一次（子代理各自持有一份，但只在各自第一回合出现）。 */
  let clampNoticeShown = false;
  // v0.6.0 C1：当前回合的账本写入器（与 currentUsage 同款：runTurn 内赋值、finally 清空）。
  // 账本不可用/被关闭时它是 no-op，**绝不影响主流程**——与 writeAudit 同款容错。
  let turnLedger = /** @type {any} */ (null);
  // v0.5.0 A4：当前正在执行的 Pack 工具所属 Pack（由 runTool 按 `pack__<pack>__` 前缀设置），
  // 供 ctx.llm 写归因记录时标注来源。
  let currentPack = /** @type {any} */ (null);
  // v0.6.13（A）：当前回合的进度快照（runTurn 内赋值、finally 清空）。
  // spawnTask 用它把父回合的"无进展截止时刻"传给子代理：子代理树必须一起收口，
  // 否则 24 个并行子代理各自跑满自己的看门狗，父回合看起来就是"挂了几小时"。
  let currentTurnProgress = /** @type {any} */ (null);
  // v0.6.26 §3.91（子代理继承）：本回合**实际生效**的预算/输出上限（内存压缩后立刻更新）。
  // spawnTask 必须读它，否则父回合已压到 19,660、子代理仍按 32,768 发——真机那次「子代理
  // 已跑 31 轮 / 50 次工具调用、29 分钟白跑」正是父子预算不一致的直接后果。
  let currentTurnBudget = /** @type {number|null} */ (null);
  let currentTurnMaxOutput = /** @type {number|null} */ (null);
  // 本回合的端点学习值（runTurn 内按回合重读；runTurnInner 的发送前预告据此说明预算出处）。
  let turnLearned = /** @type {any} */ (null);
  // 本回合最后一次请求实际发往的端点（费用护栏降级可能换模型；成功学习要记在真正的端点上）。
  let currentRequestBaseUrl = '';
  // 会话级共享：调用方传入则复用（/model 切换、子代理均共享，undo 不丢失）
  const undo = undoStore || { backups: new Map() };
  const stepLimit = maxSteps || MAX_STEPS;
  // 只读工具集合（子代理只读模式 + 并行批次共用）。v0.3.1 起含 git/fetch（只读、审计常用）
  // v0.6.2（代码审计 P2-11）：**不要另写一份集合**——从只读档派生，把刻意差异写清楚。
  // 此前这里是手写的第二份副本（与模块顶部的 READONLY_TIER_SET 内容相近但不同），
  // 两处各自演化必然漂移（本仓已多次吃过"同一逻辑多份副本"的亏）。
  //   差异（刻意，不是遗漏）：
  //     · 去掉 task：子代理不再派子代理，避免无限嵌套与成本失控；
  //     · 去掉 todo：子代理的任务清单不与主线程共享（主线程 todo 由主代理维护）。
  const READONLY_TOOLS_SET = new Set([...READONLY_TIER_SET].filter((n) => n !== 'task' && n !== 'todo'));
  // 精确 token 计数：DeepSeek 词表，其他模型回退启发式
  const count = makeTokenCounter(modelName);
  // MCP 工具集（每次取，服务器晚就绪也能在后续轮次出现）
  const mcpSchemas = () => (mcp ? mcp.toolSchemas() : []);
  // 省钱 B1：本会话已调用过的工具名（内置名/MCP 前缀名）——其 schema 在后续轮次省略 description，
  // 模型已在消息历史里见过用途；未用过的保留完整描述。省输入 token（工具 schema 按需瘦身）。
  const usedToolNames = new Set();
  // 省钱 B1（按需挂载）：回合起始为「只读阶段」时只发只读工具（read/ls/glob/grep/skill/todo）
  // + 已用过的工具；检测到写意图（用户消息或模型明说需要写/改/建）后注入全量工具。
  // v0.4.4：加 task——审计/调研等只读长任务此前因 task 不在只读档而看不到「派只读子代理」能力
  // （readOnly 子代理只读，权限引擎仍门控写操作，无越权）。
  // 只读档工具集：单一来源见模块顶部导出的 READONLY_TIER_SET
  // 中英双语写意图（CodeArts 报告：纯中文正则让英文会话整回合只读死锁）

  // A1（前缀稳定）：剥描述集合按「回合冻结快照」——回合内恒定（至多两态：只读档/全量档），
  // 新使用的工具只在下一回合才进入剥描述集合；回合边界本身就有新 user 消息，schema 变化免费。
  // v0.4.0 Agent Preset：cfg.presetTools 白名单恒生效（在只读档过滤之后收紧——预设只减不增）。
  const presetToolSet = Array.isArray(cfg.presetTools) ? new Set(cfg.presetTools.map(String)) : null;
  const activePresetName = String(cfg.presetName || ''); // 白名单拦截提示用
  // 工具可见性判据（v0.6.11 / P1-1 第三刀）：白名单过滤 + 只读档过滤的实现已单源到 `tools-flow.js`。
  // 这里只负责把"当前拿得到的东西"递进去（判据本身不在本文件里；结构守卫见 smoke §136）。
  const toolsFor = (/** @type {boolean} */ readOnlyPhase, /** @type {Set<string>} */ usedNames) =>
    visibleToolsFor(buildToolSchemas(usedNames, mcpSchemas()), {
      readOnlyPhase,
      usedNames,
      presetToolSet,
      // MCP 的只读标注按名查询；`isReadonly` 是 mcp 对象上的方法（内部用 this），必须包一层
      isMcpReadonly: mcp ? (/** @type {string} */ n) => mcp.isReadonly(n) : null,
    });

  // 子代理：全新上下文 + 同一 Provider/权限（提示带「子任务」标记），独立完成子任务后汇报
  async function spawnTask(/** @type {any} */ prompt, { description = '', readOnly = false } = {}) {
    const subIo = createIO({ quiet: true });
    // 只读子代理（评估 A4：可并行）：只读工具自动放行、写类直接拒绝，无交互询问
    const subPermission = readOnly
      ? { mode: 'readonly-noask', check: (/** @type {any} */ name) => READONLY_TOOLS_SET.has(name) }
      : { check: (/** @type {any} */ name, /** @type {any} */ args) => permission.check(name, args, '（子任务）') };
    // 自动路由：子代理固定走 executor 模型（便宜的执行单元）
    const subModel = subagentModel(cfg, modelName);
    // v0.6.13（A）：子代理**继承父回合的无进展截止时刻**——24 个并行子代理各自跑几十分钟时，
    // 父回合不该等它们把各自的看门狗超时跑完（真机实测：一个回合因此跑了 4+ 小时）。
    // v0.6.13（问题 3 修法）：这个 `turnProgressDeadlineAt` **只是 spawn 时刻的快照兜底**；
    // 真正的判据在子代理侧取 `parentProgress`（父回合的进度对象，**活的引用**）：
    //   · 快照版的问题（真机 02:42–03:13）：子代理刚有进展（15 轮 / 18 次工具调用）也被
    //     "父回合剩余时间"掐掉，而且触发时按子代理自己的最后进展算等待时长 → 谎报"连续 1 分钟"；
    //   · 现在子代理每次真实进展都会回调父回合（onSubagentProgress）→ 父回合续期 →
    //     父回合的 lastProgressAt 前移 → 子代理读到的截止时刻随之前移。**真在干活就不收口**。
    const subAgent = createAgent({
      provider,
      permission: subPermission,
      io: subIo,
      modelName: subModel,
      workingDir,
      cfg: {
        ...cfg,
        // v0.6.26 §3.91（子代理继承）：优先用**父回合当前生效**的预算/输出上限——
        // 父回合因内存不足压到 19,660/4,096 后，子代理不得再按 32,768/8,192 发（那会再次撞墙）。
        // 子代理自己也会走同一套多级压缩（createAgent 内部逻辑相同），两条路都保留。
        contextBudget: Math.min(currentTurnBudget ?? budget, 64000),
        maxOutputTokens: currentTurnMaxOutput ?? maxOutput,
        ...(currentTurnProgress
          ? { turnProgressDeadlineAt: currentTurnProgress.lastProgressAt + currentTurnProgress.noProgressMs }
          : {}),
        // 下面是 v0.6.13（问题 3）补的两项。**上面 `turnProgressDeadlineAt` 那个 spread 一个字都不动**：
        // 它是 §139 与 batch28 ⑥ 共同钉住的形状（改缩进/换写法会让既有变异变成"变异点未找到"——
        // 本轮实际踩到过），而它现在的语义只当"spawn 时刻的快照兜底"，真正的判据是 parentProgress（活引用）。
        ...(currentTurnProgress ? { parentProgress: currentTurnProgress } : {}),
        ...(description ? { subagentLabel: description } : {}),
        onSubagentProgress: (/** @type {any} */ info) => {
          try {
            currentTurnProgress?.onSubagentProgress?.(info);
          } catch {}
        },
      },
      undoStore: undo,
      maxSteps: SUBAGENT_MAX_STEPS,
      mcp,
      sessionRef, // 子代理的审计记录归入主会话
      // 注意：这里**不**透传 onUsage。子代理的消耗改为在下方 runTurn 返回后一次性并入父回合 usage
      // （v0.4.6）。若同时透传 onUsage 又并入总量，WebUI 会对子代理已逐轮入账的部分重复计费。
    });
    const sys =
      `你是主智能体 MingDao 派出的子代理，独立完成一项子任务。` +
      `你与主线程共享同一台电脑与项目（工作目录：${workingDir}）。` +
      (readOnly ? `本次为只读调研任务：只能使用 read/ls/glob/grep/skill 工具，不得写入或执行命令。` : '') +
      `完成后用简洁中文汇报结果、关键结论与涉及的文件路径；不要向用户提问。`;
    const messages = [
      { role: 'system', content: sys },
      { role: 'user', content: prompt },
    ];
    io.print(style(`  ↳ 子任务${description ? '：' + description : ''}`, C.magenta));
    const t0 = Date.now();
    const res = await subAgent.runTurn(messages);
    const ms = Date.now() - t0;
    // v0.4.6 P1 修复：子代理 token 消耗并入父回合 usage（缓存命中/未命中字段一并累加）——
    // 否则子代理完全不计费：CLI/REPL（无 onUsage）恒漏计；WebUI 仅在子代理跨轮时偶发计入。
    // 并入后父回合 res.usage 即「真总量」，护栏在途估算、分账、今日费用同时变准。
    if (currentUsage && res?.usage) {
      const u = res.usage;
      currentUsage.prompt_tokens += u.prompt_tokens || 0;
      currentUsage.completion_tokens += u.completion_tokens || 0;
      if (Number.isFinite(u.prompt_cache_hit_tokens)) {
        currentUsage.prompt_cache_hit_tokens = (currentUsage.prompt_cache_hit_tokens || 0) + u.prompt_cache_hit_tokens;
      }
      if (Number.isFinite(u.prompt_cache_miss_tokens)) {
        currentUsage.prompt_cache_miss_tokens = (currentUsage.prompt_cache_miss_tokens || 0) + u.prompt_cache_miss_tokens;
      }
    }
    // v0.4.1：子代理空输出给主线程可用的失败信号（含 note 原因），而非笼统「无输出」——
    // 主智能体据此决定是否重试/换法，而非把子代理静默当作「已完成但没说话」。
    // v0.6.13（问题 3）：把子代理**自己跑到哪一步**一并回传（轮次/工具调用/最后进展距今）——
    // 真机上父回合只知道"在等 task 620s"，完全看不出子代理是在干活还是卡死；
    // 而子代理被收口的**原因**（自己无进展 / 父回合整轮无进展）也必须原样带给父回合。
    const subTp = /** @type {any} */ (/** @type {any} */ (subIo).turnProgress);
    const subStat = subTp
      ? `已跑 ${Number(subTp.modelRounds) || 0} 轮 / ${Number(subTp.toolCalls) || 0} 次工具调用` +
        (Number(subTp.lastProgressAt) > 0 ? `，最后进展 ${Math.max(0, Math.round((Date.now() - Number(subTp.lastProgressAt)) / 1000))}s 前` : '') +
        (subTp.stallCause === 'inherited' ? '（因父回合整轮无进展而收口）' : subTp.stalled ? '（子代理自身无进展而收口）' : '')
      : '';
    const text =
      res.text ||
      `（子任务${res.stalled ? '被无进展看门狗中止' : res.truncated ? '达到步骤上限，未完成' : '无输出'}` +
        (subStat ? `；${subStat}` : '') +
        (res.note ? '：' + res.note : '') +
        ')';
    io.print(style(`  ↳ 子任务完成（${ms}ms${res.stalled ? '，被无进展看门狗中止' : ''}）`, C.magenta));
    return text;
  }

  /**
   * v0.5.0 A4：Pack 统一模型出口 `ctx.llm()`（Pack API §5）。
   *
   * 为什么必须有它：垂域层此前把模型调用写在 Provider 的 chat() 里（Deyi 的 dify.mjs 就是如此），
   * usage 硬编码为 0 —— 域内调用**完全不计费、不触发日费用护栏、无法归因**。
   * 走这里则：复用内核的 Provider 解析/重试/超时/能力表；usage 并入当前回合累加器 →
   * 今日费用、缓存命中率、峰谷判断、日费用护栏在途估算**同时生效**。
   * @param {any} opts
   */
  async function packLlm(/** @type {any} */ opts = {}) {
    const usedModel = String(opts.model || modelName);
    const system = String(opts.system || '');
    const user = String(opts.user ?? opts.prompt ?? '');
    if (!user) throw new Error('ctx.llm 需要 user（或 prompt）参数');
    // v0.5.0 A4.5：Pack 级预算前置检查（与日费用护栏同语义，粒度到 Pack）。
    // 预算在 pack.json 的 budget 声明；超限按 action 处理（block 抛错 / warn 放行并提示）。
    const packBudget = getActivePackContext()?.mounted?.find((/** @type {any} */ x) => x.name === currentPack)?.budget;
    if (packBudget && Number(packBudget.dailyYuan) > 0) {
      const spent = packDailyCost(currentPack);
      if (spent >= Number(packBudget.dailyYuan)) {
        const msg = `垂域 Pack「${currentPack}」今日费用 ≈¥${spent.toFixed(5)} 已达上限 ¥${Number(packBudget.dailyYuan).toFixed(2)}`;
        if (String(packBudget.action || 'block') === 'block') throw new Error(`${msg}（budget.action=block，已阻止本次模型调用）`);
        try { io.print(style(`⚠ ${msg}（budget.action=warn，本次放行）`, C.yellow)); } catch {}
      }
    }
    const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: user }];
    let prov = provider;
    if (usedModel !== modelName) {
      const pc = resolveProviderConfig(cfg, usedModel);
      if (!pc || !pc.apiKey) throw new Error(`ctx.llm：模型 ${usedModel} 未配置 API Key`);
      prov = await createProvider(cfg, usedModel);
    }
    const subCaps = resolveModelCaps(cfg, usedModel);
    const maxTokens = Math.min(
      Number(opts.maxTokens) > 0 ? Number(opts.maxTokens) : 2048,
      subCaps.maxOutputCeiling || subCaps.maxOutputTokens
    );
    const t0 = Date.now();
    const res = await prov.chat({
      model: usedModel,
      messages,
      tools: [],
      temperature: opts.temperature ?? temperature,
      maxTokens,
      ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
      ...(opts.json ? { responseFormat: { type: 'json_object' } } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    // 并入当前回合 usage（与子代理同一机制）：CLI 直接按 res.usage 入账，
    // WebUI 的 remaining 补记与护栏在途估算随之变准。
    if (currentUsage && res?.usage) {
      const u = res.usage;
      currentUsage.prompt_tokens += u.prompt_tokens || 0;
      currentUsage.completion_tokens += u.completion_tokens || 0;
      if (Number.isFinite(u.prompt_cache_hit_tokens)) {
        currentUsage.prompt_cache_hit_tokens = (currentUsage.prompt_cache_hit_tokens || 0) + u.prompt_cache_hit_tokens;
      }
      if (Number.isFinite(u.prompt_cache_miss_tokens)) {
        currentUsage.prompt_cache_miss_tokens = (currentUsage.prompt_cache_miss_tokens || 0) + u.prompt_cache_miss_tokens;
      }
    }
    // v0.5.0 A4：写一条 **Pack 归因标记记录**（cost=null，不计入 todayCost → 与回合级记录不重复计费；
    // packCost 仅供 `mingdao cost report --by pack` 展示）。这样垂域团队能看到「自己的红线/工具花了多少」。
    try {
      const u = res?.usage || {};
      const pack = currentPack || opts.pack || null;
      const pCost = estimateCost(usedModel, u.prompt_tokens || 0, u.completion_tokens || 0, null);
      recordCacheStats({
        model: usedModel,
        prompt: u.prompt_tokens || 0,
        completion: u.completion_tokens || 0,
        hit: null,
        miss: null,
        cost: null,
        saved: null,
        pack,
        purpose: opts.purpose || null,
        packCost: pCost,
      });
    } catch {}

    const text = String(res?.text || '');
    let data = null;
    if (opts.json) {
      const a = text.indexOf('{');
      const b = text.lastIndexOf('}');
      if (a >= 0 && b > a) {
        try {
          data = JSON.parse(text.slice(a, b + 1));
        } catch {}
      }
    }
    return { text, data, usage: res?.usage || null, model: usedModel, purpose: opts.purpose || null, durationMs: Date.now() - t0 };
  }

  // v0.6.2（第三方审计 P1-2）：读取去重缓存**每个代理实例一份**。
  // 之前是模块级共享，导致子代理读过的文件在主代理里返回「内容与上次读取一致」占位串
  // ——主代理上下文里根本没有内容。子代理由 createAgent 另建实例，因此天然隔离。
  const agentReadCache = new Map();

  function makeCtx() {
    return {
      cwd: workingDir,
      io,
      readCache: agentReadCache,
      workingDir,
      modelName,
      provider,
      permission,
      cfg,
      budget,
      todos,
      undoStore: undo,
      spawnTask: (/** @type {any} */ prompt, /** @type {any} */ opts) => spawnTask(prompt, opts),
      // v0.5.0 A4：Pack 内所有模型调用必须走这里（禁止自己 fetch 模型接口）——
      // 否则费用隐身、护栏失效、无法归因。详见 PACK-API §5。
      llm: (/** @type {any} */ opts) => packLlm(opts),
    };
  }

  async function runTurnInner(/** @type {any} */ messages, /** @type {number} */ startBudget = budget) {
    let steps = 0;
    let finish = null;
    // v0.6.18 §3.74 / v0.6.26 §3.91：本回合实际生效的 prompt 预算 / 输出上限——内存不足时
    // **只在本回合内**按 MEMORY_RECOVERY_LEVELS 逐级压小，不写回用户配置。
    // turnBase* 是"起手值"，两级压缩都相对它计算（不是逐级连乘），保证日志数值与文档一致。
    let turnBaseBudget = startBudget;
    let turnBaseMaxOutput = maxOutput;
    let turnBudget = turnBaseBudget;
    let turnMaxOutput = turnBaseMaxOutput;
    // 子代理继承用：本回合当前生效值（压缩后立即更新，见 spawnTask）。
    currentTurnBudget = turnBudget;
    currentTurnMaxOutput = turnMaxOutput;
    /** 本回合已用掉的内存降级重试次数（硬性上限 MAX_MEMORY_RETRIES = 2）。 */
    let memoryRetries = 0;
    lastMemoryRecovery = null;
    /** v0.6.3（M-16）：本回合是否出现过"上游提前关流"（回答可能不完整）。
     * 刻意不叫 truncated——既有 `truncated` 的含义是"步数兜底总结也失败了"，两者必须分开。 */
    let upstreamTruncated = false;
    // v0.6.7（报告二 P2-1）：**结局判定的单一来源**。
    // 此前账本 runEnd 在 finally 里拿不到返回值，只能用局部变量 `finish` 重算结局，于是四处口径分裂：
    //   ① 跑满步数：返回值 capHit:true，账本却记 status='done'、capHit=false；
    //   ② `finish === 'max_steps'` 是**死条件**（全文件无人赋该值，析取支永不成立）；
    //   ③ 步数耗尽的另一条分支（末轮仍有正文+工具调用）返回时**根本没有 capHit 字段**，
    //      与同一 if 的 `break` 分支（capHit:true）自相矛盾；
    //   ④ `finish === 'length'` 时账本记 capHit:true，而循环跑满的返回值是 truncated:true —— 同一次运行两个说法。
    // 现在：所有出口都调用 markOutcome 写进同一个 outcome，返回值与 runEnd 都从它取。
    /** @type {{status: string, capHit: boolean, truncated: boolean, aborted: boolean, upstreamTruncated: boolean, usageUnknown: boolean}} */
    const outcome = { status: 'done', capHit: false, truncated: false, aborted: false, upstreamTruncated: false, usageUnknown: false };
    /** 收敛本回合结局（后写覆盖，便于"先默认、后升级"）。
     * @param {string} status @param {Partial<{capHit: boolean, truncated: boolean, aborted: boolean}>} [extra] */
    const markOutcome = (status, extra = {}) => {
      outcome.status = status;
      Object.assign(outcome, extra);
    };
    // v0.3.1 自动续跑（长程执行）：跑满 stepLimit 步后不再直接中断，而是注入进度摘要再续跑，
    // 最多 maxRounds 轮（默认 3，可用 cfg.maxRounds 调）；审计/重构等大任务不再「一步中断」。
    const maxRounds = Math.max(1, Number(cfg.maxRounds) || 3);
    let round = 0;
    const usage = /** @type {{ prompt_tokens: number, completion_tokens: number, prompt_cache_hit_tokens?: number, prompt_cache_miss_tokens?: number }} */ ({ prompt_tokens: 0, completion_tokens: 0 });
    currentUsage = usage; // 子代理消耗并入本回合总量（见 spawnTask）
    const startedAt = Date.now();
    // v0.6.0 C1：本回合的执行账本（cfg.ledger=false 可关；写失败整体降级为 no-op）
    turnLedger = createLedger(newRunId(), { enabled: cfg.ledger !== false });
    // v0.6.0 C3：把本回合账本接成出网事件的 sink——这样「这一步向哪些外部地址发了请求」
    // 与其它账本事件同处一份时间线，而不是散在另一个文件里对不上时间。
    const offEgressSink = registerEgressSink((info) => {
      try {
        turnLedger?.netEgress({ host: info.host, port: info.port, allowed: info.allowed, reason: info.rule ? `命中白名单 ${info.rule}` : info.reason });
      } catch {}
    });
    turnLedger.runStart({
      model: modelName,
      provider: cfg.provider ?? null,
      session: sessionRef?.name ?? null,
      cwd: workingDir,
      permission: cfg.permission ?? permission?.mode ?? null,
      // v0.6.17 §3.64：来源由入口（WebUI/CLI）算好随 cfg 传入；agent 只透传，不猜。
      // 后台任务/REPL 内切换预设等未传来源的路径写 null（来源未知），绝不冒充 config。
      permissionSource: cfg.permissionSource ?? null,
      preset: preset?.name ?? cfg.preset ?? null,
      // v0.6.7（报告二 P3-1）：activeCtx 的形状是 { mounted, warnings, promptSections, constraints, toolCount }，
      // **没有 `.packs` 键** —— 这里此前恒为 []，账本里"本次运行挂了哪些 Pack"永远记空。
      packs: (getActivePackContext()?.mounted || []).map((/** @type {any} */ p) => p?.name).filter(Boolean),
    });
    // 回合性能指标（状态栏：LLM 时长 / 工具时长 / 首 token 延迟 / 步数）
    let llmMsTotal = 0;
    let toolMsTotal = 0;
    let firstTokenAt = /** @type {any} */ (null);
    // v0.4.6：记录最近一次模型请求的**发起**时刻——峰谷单价必须按发起时刻判定。
    // 此前 recordUsage 在响应落地后用 new Date() 计价，跨 12:00/18:00 边界的请求会错记一档
    // （1M prompt 的 pro 调用是 ¥9 vs ¥4.5 的差别）。
    let lastRequestStartAt = /** @type {any} */ (null);
    // 省钱 B3（费用二级分账）：推理 token 估算（按增量累计）与逐工具调用/耗时累加
    let reasoningTokens = 0;
    const toolStats = /** @type {Map<string, {calls: number, ms: number}>} */ (new Map());
    const deliverables = /** @type {string[]} */ ([]); // 本回合 write/edit 成功落盘的文件路径（去重）
    const perf = () => ({
      llmMs: llmMsTotal,
      toolMs: toolMsTotal,
      firstTokenMs: firstTokenAt == null ? null : firstTokenAt - startedAt,
      steps,
      reasoningTokens,
      toolStats: [...toolStats.entries()].map(([tool, s]) => ({ tool, calls: s.calls, ms: s.ms })),
      usedModel: activeModel, // 省钱 B4：本回合实际使用模型（降级后归属它）
      requestStartAt: lastRequestStartAt, // v0.4.6：峰谷计价锚点（请求发起时刻，非落账时刻）
      deliverables: [...deliverables], // v0.3.1：CLI/REPL 续跑检查点复用（此前 artifacts 恒空）
      // v0.6.7（报告一 H-4）：本回合是否出现过"模型有响应但服务端没回 usage"
      usageUnknown: outcome.usageUnknown,
      // v0.6.13（A/可观测性）：工具调用与首帧时延随 perf 一起回给调用方（WebUI 的 done 事件
      // 用它写"本回合 0 次工具调用"，状态栏/账本也能读到 TTFT）。
      toolCalls: turnProgress.toolCalls,
      noToolCalls: turnProgress.toolCalls === 0,
      llmCalls: turnProgress.llmCalls,
      ttftMs: turnProgress.ttftMs,
      stalled: turnProgress.stalled,
      // v0.6.13（问题 3/4）：stalled 的**原因**（'own' 自己零进展 / 'inherited' 父回合整轮零进展）——
      // 前端与日志据此区分"子代理卡住"和"父回合没算子代理的进展"（真机上这两者被混成一句）。
      stallCause: turnProgress.stallCause,
      subagent: turnProgress.subagent,
      // v0.6.13（A）：收尾提示的**单一来源**（服务端直接取这条字符串，不再自己拼一遍文案）。
      // 注意：return 里的 perf() 先于 finally 求值，所以这里必须**惰性计算**（否则返回值里恒为 null，
      // 而日志/界面那边却已经打印过——同一事实两个说法，正是本项目反复栽过的那类不一致）。
      zeroToolCalls: ensureZeroToolCallNotice(),
    });
    let aborted = false;
    // v0.7.0 §1.1：中断事件只写一次（SIGINT 可能在思考/工具/权限询问期间到达）。
    // toolCallIds 交给 replay 延迟补占位：随后 message.append 若已含占位，不会重复。
    let interruptEmitted = false;
    const emitInterruptOnce = (/** @type {string} */ reason) => {
      if (interruptEmitted) return;
      interruptEmitted = true;
      emitEvent('interrupt', { reason, toolCallIds: missingToolCallIds(messages) });
    };
    // 连续空/截断输出计数（防止无限续写）。v0.6.28（M-10）：**必须真的复位**——
    // 有进展的工具轮（成功且不重复，与看门狗同判据）与有内容的模型轮都会清零，
    // 否则「3 次非连续空轮」会被误判成「连续 3 轮」而中止（文案与实现的判据必须一致）。
    let emptyRounds = 0; // 连续空/截断输出计数（防止无限续写）
    // v0.6.13（A）：本轮用户消息是否为"任务态"（含写/执行意图）——用于收尾时的「0 次工具调用」提示
    const turnUserTaskLike = hasWriteIntent(String([...messages].reverse().find((m) => m?.role === 'user')?.content ?? ''));
    let currentAc = /** @type {any} */ (null);
    // v0.3.2 边缘检测状态：模型上报 prompt_tokens 逼近窗口 → 下一轮强制压缩（见下方 compactConversation force）
    let windowPressure = false;
    let pressureWarned = false;
    // 省钱 B4（护栏降级）：action='downgrade' 超限后本回合切换到便宜模型继续执行；
    // activeModel 是本回合实际使用的模型（分账/记录归属它），downgraded 保证只提示一次。
    let activeModel = modelName;
    let downgraded = false;
    // 护栏在途费用（MiniMax P0）：本回合已累计 usage 的保守估算（无缓存折扣），
    // 护栏检查/前置拦截时并入今日已用——否则长回合内统计文件不变，可烧穿日限。
    const inFlightCost = () => estimateCost(activeModel, usage.prompt_tokens, usage.completion_tokens, null, new Date());
    const usedTodayWithInflight = () => {
      const today = todayCost();
      if (today == null) return null;
      const inflight = inFlightCost();
      // P0-4（v0.4.5）：无价模型在途费用为 null（未知）——整体视为「无法判断」而非 +null→today 的静默忽略
      return inflight == null ? null : today + inflight;
    };
    // 省钱 B1：本回合只读阶段判定——最新用户消息无写意图则先只发只读工具，
    // 模型明确表达写意图后（下一轮）注入全量。cfg.schemaTier=false 可关。
    let readOnlyPhase = true;
    // 自愈只允许一次（否则与 stepLimit 形成"放开→再收起"的循环）
    let readOnlyHealed = false;
    {
      const lastUser = [...messages].reverse().find((m) => m?.role === 'user');
      // 域内 Pack 在场时**不进只读档**（域内词是开集，靠关键词判定必然漏）
      const packCtx0 = getActivePackContext();
      const packActive = Array.isArray(packCtx0?.mounted) && packCtx0.mounted.length > 0;
      readOnlyPhase = startsInReadOnlyPhase(cfg, String(lastUser?.content ?? ''), packActive);
    }
    // A1：本回合的剥描述冻结快照（会话级 usedToolNames 的副本）——回合内 schema 字节不变
    const turnStrippedSet = new Set(usedToolNames);
    // 整个回合注册一次 SIGINT：思考、工具执行、权限询问期间都能中断
    const offSigint = io.onSigint ? io.onSigint(() => { aborted = true; emitInterruptOnce('sigint'); currentAc?.abort(); }) : () => {};
    // ---- v0.6.13（A）：回合级进度快照 + 无进展看门狗 ----
    // 快照挂在 io 上：WebUI 服务端（src/web/server.js）每 5s 读它下发状态条、每 30s 落一行日志。
    // 这里不改 web-io.js 的接口（它不在本次改动面内），字段是"只读约定"。
    const noProgressMs = resolveNoProgressTimeoutMs(cfg);
    /** @type {any} */
    const turnProgress = {
      startedAt,
      phase: '待发请求',
      llmCalls: 0,
      modelRounds: 0,
      toolCalls: 0,
      toolExecuted: 0,
      // v0.6.13（A）：**无效**工具调用数（重复调用或失败）——"工具在跑、什么都没做成"的量化依据
      unproductive: 0,
      streamFrames: 0,
      contentChars: 0,
      ttftMs: null,
      lastTtftMs: null,
      pendingTool: null,
      // v0.6.13（问题 3）：当前正在跑的子代理快照（由 onSubagentProgress 刷新）——
      // 界面/日志据此显示"在等哪个子任务、它跑到第几轮 / 几次工具调用"
      subagent: null,
      forecast: null,
      // v0.6.15（§3.59）：本地端点串行化快照（排队时由 provider 的 onQueueWait 填入）
      localQueue: null,
      localQueueNoticed: false,
      noProgressMs,
      lastProgressAt: Date.now(),
      progressReason: '回合开始',
      stalled: false,
      stallCause: null,
      note: null,
      zeroToolCalls: false,
    };
    try {
      io.turnProgress = turnProgress;
    } catch {}
    currentTurnProgress = turnProgress; // 子代理据此继承同一个截止时刻（见 spawnTask）
    let noProgressTimer = /** @type {any} */ (null);
    let noProgressFired = false;
    // 本回合的"调用签名 → 次数"：完全相同（name+args）的重复调用不算进展（见 finishTool）
    const turnSigCounts = new Map();
    /**
     * 继承来的"整棵树一起收口"截止时刻——**每次都重新取**，不是 spawn 那一刻的快照。
     *
     * 真机 bug（02:42–03:13，`status=stalled`）：快照版把子代理的等待压到"父回合剩余时间"，
     * 子代理刚有进展（会话记录里写着「模型请求 15 轮、工具调用 18 次」）就被掐掉，
     * 且文案按子代理自己的最后进展算时长 → 谎报"连续 1 分钟没有任何工具调用"。
     * 现在父回合的 lastProgressAt 会被子代理的进展续期（见 markProgress / onSubagentProgress），
     * 于是这个截止时刻**只前移不倒退**：真在干活就不收口，真停了才一起收口。
     */
    const inheritedDeadlineAt = () => {
      const snap = Number(cfg.turnProgressDeadlineAt) > 0 ? Number(cfg.turnProgressDeadlineAt) : 0;
      const pp = /** @type {any} */ (cfg.parentProgress);
      const live = pp && Number(pp.noProgressMs) > 0 && Number(pp.lastProgressAt) > 0 ? Number(pp.lastProgressAt) + Number(pp.noProgressMs) : 0;
      const d = Math.max(snap, live);
      return d > 0 ? d : null;
    };
    /**
     * 看门狗到点。`cause` 必须如实区分（问题 3/4）：
     *   · 'own'       —— 本回合自己连续 N 没有真实进展；
     *   · 'inherited' —— 父回合已判定整轮无进展，子代理随整棵树收口（**不是**子代理卡住）。
     */
    // 触发原因由 armNoProgress 在**安排计时器前**写入（而不是当参数传进 fireNoProgress）：
    // `noProgressTimer = setTimeout(fireNoProgress, left);` 这一行的形状被 §139 与 batch28 ① 共同钉住，
    // 不能为了多带一个参数去改它（那会让既有变异验证变成"变异点未找到"——本轮实际踩到过）。
    let noProgressCause = /** @type {'own'|'inherited'} */ ('own');
    const fireNoProgress = () => {
      const cause = noProgressCause;
      noProgressFired = true;
      const waited = Date.now() - turnProgress.lastProgressAt;
      turnProgress.stalled = true;
      turnProgress.stallCause = cause;
      turnProgress.phase = cause === 'inherited' ? '已中止（父回合无进展）' : '已中止（无进展）';
      turnProgress.waitedMs = waited;
      const pt = turnProgress.pendingTool;
      turnProgress.note =
        cause === 'inherited'
          ? inheritedStopNotice({ waitedMs: waited, toolCalls: turnProgress.toolCalls, modelRounds: turnProgress.modelRounds })
          : noProgressNotice({
              waitedMs: waited,
              toolCalls: turnProgress.toolCalls,
              modelRounds: turnProgress.modelRounds,
              unproductive: turnProgress.unproductive,
              // 问题 4：必须说清"在等哪个工具、等了多久"，否则用户无从判断该调什么
              pendingTool: pt ? { name: String(pt.name || ''), ms: Date.now() - Number(pt.startedAt || Date.now()) } : null,
              subagent: turnProgress.subagent,
            });
      try { io.print(style(turnProgress.note, C.yellow)); } catch {}
      try { currentAc?.abort(new Error(`无进展 ${Math.max(1, Math.round(waited / 60000))} 分钟，已中止`)); } catch {}
    };
    const armNoProgress = () => {
      if (noProgressTimer) clearTimeout(noProgressTimer);
      const ownDeadline = turnProgress.lastProgressAt + noProgressMs;
      const inh = inheritedDeadlineAt();
      // 正等子代理时给一点点宽限，保证**子代理自己的看门狗先响**并把原因回传父回合（见常量注释）。
      const grace = turnProgress.subagent && turnProgress.pendingTool ? SUBAGENT_WAIT_GRACE_MS : 0;
      // 继承的截止时刻只**提前**（"一整棵树一起收口"）；自己的判据之外只多那点宽限。
      const useInherited = inh != null && inh < ownDeadline;
      const target = useInherited ? inh : ownDeadline + grace;
      const left = Math.max(1000, target - Date.now());
      noProgressCause = useInherited ? 'inherited' : 'own';
      noProgressTimer = setTimeout(fireNoProgress, left);
      try { noProgressTimer.unref?.(); } catch {} // 不因为这个计时器拖住进程退出
    };
    /** 收尾提示：惰性计算一次并缓存（perf() 与 finally 都取它，界面只打印一次）。 */
    const ensureZeroToolCallNotice = () => {
      if (turnProgress.zeroToolCallsNote === undefined || turnProgress.zeroToolCallsNote === null) {
        const n = zeroToolCallNotice({ modelRounds: turnProgress.modelRounds, steps, taskLike: turnUserTaskLike });
        turnProgress.zeroToolCallsNote = n || null;
        if (n) turnProgress.zeroToolCalls = true;
      }
      return turnProgress.zeroToolCallsNote;
    };
    /** 有真实进展才续期：工具结果返回 / 模型正文或推理增量。 */
    let lastSubNotifyAt = 0;
    const markProgress = (/** @type {string} */ why) => {
      const now = Date.now();
      turnProgress.lastProgressAt = now;
      turnProgress.progressReason = why;
      armNoProgress();
      // v0.6.13（问题 3 的核心修法）：**子代理的进展必须算父回合的进展**。
      // 真机现场：父回合第 12 轮派出两个只读子代理，子代理在 10 分钟里跑了 15 轮 / 18 次工具调用
      // （会话记录原文），父回合却只看得到"正在等待工具 task（已 620s）"→ 看门狗判"整轮无进展"
      // 把父子一起掐了。父回合此刻并不能从工具结果里拿到任何中间信号，所以进展必须由子代理
      // **主动回传**（onSubagentProgress）——父回合据此续期，并把快照挂到 turnProgress.subagent，
      // 让界面/日志能写出"在等哪个子任务、它跑到第几轮"。
      // 节流 1s：增量帧可能成百上千，父回合的续期只需"还在动"这个事实。
      // 例外：**工具结果**是低频且高价值的进展信号（"子代理跑到第几步"就靠它），一律照原样回传。
      const isToolStep = /^工具 /.test(why);
      if (typeof cfg?.onSubagentProgress === 'function' && (isToolStep || now - lastSubNotifyAt >= 1000)) {
        lastSubNotifyAt = now;
        try {
          cfg.onSubagentProgress({
            label: String(cfg?.subagentLabel || ''),
            modelRounds: turnProgress.modelRounds,
            toolCalls: turnProgress.toolCalls,
            reason: why,
          });
        } catch {}
      }
    };
    /** 子代理进展 → 本回合续期 + 记录快照（供 UI/日志"在等哪个子任务、它到哪一步了"）。 */
    turnProgress.onSubagentProgress = (/** @type {any} */ info) => {
      const label = String(info?.label || '');
      const rounds = Number(info?.modelRounds) || 0;
      const calls = Number(info?.toolCalls) || 0;
      // 只前进不后退：并行子代理里"后到的旧快照"不得把更靠前的进展覆盖回去
      const prev = turnProgress.subagent;
      if (!prev || rounds + calls >= (Number(prev.modelRounds) || 0) + (Number(prev.toolCalls) || 0)) {
        turnProgress.subagent = { label, modelRounds: rounds, toolCalls: calls, at: Date.now(), reason: String(info?.reason || '') };
      } else if (prev) {
        prev.at = Date.now();
      }
      markProgress(`子代理进展${label ? `（${label}）` : ''}`);
    };
    armNoProgress();
    // ⚠ 两个 ctx，别混：
    //   · `ctx`（内核 ctx）——本轮内核自己用（循环里的权限判定走闭包里的 permission 本体）；
    //     它**不裁剪、不冻结**，且**不交给任何工具**。
    //   · `toolCtx`（工具 ctx）——由 makeToolCtx(ctx) 派生：白名单字段 + Object.freeze，
    //     没有 provider / io / 原始 permission 对象；只有这一份会经 dispatch 交到工具手上
    //     （dispatch 内还会按"内置 / 第三方"分档再收紧一次，见 src/tools/index.js 的注释）。
    const ctx = makeCtx();
    const toolCtx = makeToolCtx(ctx);
    /**
   * v0.5.0 A3 ③：输出前领域约束（正文禁用措辞）。
   * 无约束时零开销（constraints.active=false 直接返回原文）；有约束时按 action 处理：
   *   warn → 放行并附提示；block → 替换为合规说明；block-and-rewrite → 请求一次改写，仍命中则拦截。
   * 改写请求计入本回合 usage（费用归属当前模型），并写约束审计事件。
   */
  const applyOutputConstraints = async (/** @type {any} */ text, /** @type {any} */ ctxRun) => {
    if (!constraints.active || !text) return { text, note: null };
    const hit = checkOutput(constraints, text);
    if (!hit) return { text, note: null };
    await auditConstraint(hit.event);
    const cid = hit.constraint?.id || '领域红线';
    if (hit.action === 'warn') {
      try { io.print(style(`⚠ 领域约束「${cid}」提示：${hit.reason}`, C.yellow)); } catch {}
      return { text, note: `⚠ 领域约束「${cid}」：${hit.reason}（已放行，请自行复核）` };
    }
    if (hit.action === 'block-and-rewrite') {
      try {
        io.print(style(`⛔ 领域约束「${cid}」命中，正在自动改写…`, C.yellow));
        const sys = ctxRun.messages.find((/** @type {any} */ m) => m.role === 'system');
        const fix = await ctxRun.provider.chat({
          model: ctxRun.activeModel,
          messages: [
            ...(sys ? [sys] : []),
            {
              role: 'user',
              content: `下面这段回复命中了领域红线（${hit.reason}）。请在不改变事实内容的前提下改写成**不含该措辞**的表述，只输出改写后的正文：\n\n${text}`,
            },
          ],
          tools: [],
          temperature: ctxRun.temperature,
          maxTokens: Math.min(ctxRun.maxOutput, 2048),
          signal: ctxRun.signal,
        });
        if (fix?.usage) {
          ctxRun.usage.prompt_tokens += fix.usage.prompt_tokens || 0;
          ctxRun.usage.completion_tokens += fix.usage.completion_tokens || 0;
        }
        const fixed = String(fix?.text || '').trim();
        if (fixed) {
          const re = checkOutput(constraints, fixed);
          if (!re) return { text: fixed, note: `⛔ 领域约束「${cid}」命中，已自动改写` };
          await auditConstraint(re.event);
          return { text: blockedOutputText(re), note: `⛔ 领域约束「${re.constraint?.id || cid}」改写后仍命中，已拦截` };
        }
      } catch {
        // 改写失败：回落到拦截（fail-closed）
      }
      return { text: blockedOutputText(hit), note: `⛔ 领域约束「${cid}」命中，已拦截` };
    }
    return { text: blockedOutputText(hit), note: `⛔ 领域约束「${cid}」命中，已拦截` };
  };

  /** 安全解析工具结果字符串（约束引擎需要结构化对象） */
  const safeParse = (/** @type {any} */ v) => {
    if (typeof v !== 'string') return v;
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  };
  // 回合收尾的唯一配对补齐点（审计 v0.6.29 C-01 / 严重-1）。
  //
  // 旧实现 `stripOrphanCalls()` 只会把**最后一条** assistant 的 tool_calls 清空：
  // 中断发生在工具执行期间时，末条往往是 `tool` 消息，清理静默失效，留下
  // assistant(2 个 tool_calls) + tool(仅第 1 个) 的残缺历史。OpenAI 兼容端点要求
  // tool_calls 与 tool 消息严格一一对应，这份历史会让会话**从此每一轮都 400**
  //（WebUI 还会把它 appendMessages 落盘成永久坏会话）。
  //
  // 正确做法是**补齐**而不是删除：按最后一条带 tool_calls 的 assistant 的 id 集合，
  // 给没有对应 tool 响应的调用插入 `{role:'tool', tool_call_id, content:'（已中断，未执行）'}`。
  // 保留 assistant.tool_calls 是必须的——删掉它会让同批次**已经执行**的工具结果与历史错位。
  // 插入点紧跟该 assistant 之后**连续**的 tool 消息块（历史修复时也不会被后续消息隔开）。
  const INTERRUPTED_TOOL_CONTENT = '（已中断，未执行）';
  const finishTurn = () => {
    let idx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return;
    const answered = new Set();
    for (let i = idx + 1; i < messages.length; i++) {
      const m = messages[i];
      if (m?.role === 'tool' && m.tool_call_id != null) answered.add(String(m.tool_call_id));
    }
    const missing = [];
    const seen = new Set();
    for (const tc of messages[idx].tool_calls) {
      if (!tc || tc.id == null) continue; // 无 id 无法配对（SSE 兜底 id 已保证有 id）
      const key = String(tc.id);
      if (answered.has(key) || seen.has(key)) continue;
      seen.add(key);
      missing.push(tc.id);
    }
    if (!missing.length) return;
    let insertAt = idx + 1;
    while (insertAt < messages.length && messages[insertAt]?.role === 'tool') insertAt += 1;
    messages.splice(insertAt, 0, ...missing.map((id) => ({ role: 'tool', tool_call_id: id, content: INTERRUPTED_TOOL_CONTENT })));
  };
  // D5（审计 v0.6.29 H-02 / 高-2）：本批工具结果先在内存里按 `tool_calls` 原序排队，
  // 整批结束后统一回填。旧实现里「拒绝/参数解析失败」在 prepTool 就地 push、成功项在
  // finishTool 才 push，批次 [A 成功, B 被拒] 的历史顺序会变成 B → A，与 assistant.tool_calls
  // 错位（严格网关按顺序校验时同样 400）。队列记录 idx（在 res.toolCalls 里的原始序号），
  // 回填前排序；中断/异常出口也会先 flush 已执行的结果，再由 finishTurn 补齐其余占位。
  const pendingToolMessages = /** @type {{idx: number, msg: any}[]} */ ([]);
  const flushToolMessages = () => {
    if (!pendingToolMessages.length) return;
    pendingToolMessages.sort((a, b) => a.idx - b.idx);
    for (const p of pendingToolMessages) messages.push(p.msg);
    pendingToolMessages.length = 0;
  };
    try {
    // 同回合只读工具去重（Hermes C4）：相同 name+args 的只读调用只执行一次，结果复用回填。
    // v0.4.1 P1 修复：turnToolCache 必须声明在 while 之外、for 轮内——此前在 while 体内每步重建，
    // 去重只在本步的多个工具调用间生效，跨步（如先 grep 定位再 read 确认同一文件）完全失效。
    const turnToolCache = new Map();
    // v0.4.6 P1 修复：有副作用的工具一旦执行，本回合的只读去重缓存必须整片作废。
    // v0.4.1 把 turnToolCache 提到 for 轮内，让去重跨步生效（评估 A4），却没有失效点——
    // 同回合「read a → write a → read a」的第 3 步会命中第 1 步缓存，模型拿到写入前的内容、
    // 误判写入未生效，进而重复写入或得出错误结论（已实测复现）。只读工具与 task(readOnly)
    // 不改变文件状态，缓存保留（去重收益不受影响）。
    const invalidateReadCache = (/** @type {any} */ prep) => {
      if (!prep.isMcp && READONLY_TOOLS_SET.has(prep.name)) return;
      if (prep.name === 'task' && prep.args?.readOnly === true) return;
      turnToolCache.clear();
    };
    for (round = 0; round < maxRounds; round++) {
      steps = 0;
      // v0.4.4：每轮结束回调本轮增量 usage（长任务费用逐轮入账——此前只在 runTurn 全结束后才
      // recordUsage，长任务期间「今日费用」恒为 0 被误读为「无统计」；中断时已完成轮次费用也保留）。
      const roundUsageStart = { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, prompt_cache_hit_tokens: usage.prompt_cache_hit_tokens || 0, prompt_cache_miss_tokens: usage.prompt_cache_miss_tokens || 0 };
      while (steps < stepLimit) {
      beginStep(steps + 1, round + 1);
      steps += 1;
      // v0.6.28（L-13）：`finish` 是**本次模型请求**的 finish_reason，不是回合级状态。
      // 每步开始重置，且只由本步的 res.finish 写入（见下方赋值）——否则上一轮 length/capped
      // 会残留到下一轮正常回复，把 `truncated`/`capped` 判给一次正常收尾。
      finish = null;
      // v0.6.5（审计 BUG-025，实测复现）：Ctrl+C 落在**工具执行期间**时，此前只把 `aborted`
      // 置真、却没有任何收敛点——工具跑完仍会走回这里发出**下一次请求**（实测：SIGINT 之后
      // chat 仍被调用 2 次）。这里与工具循环里的检查一起把它收口成「立刻停止、如实回报 aborted」。
      if (aborted || noProgressFired) {
        finishTurn();
        // v0.6.13（A）：无进展看门狗触发——如实报告，而不是当作"正常结束"或"用户中断"。
        if (noProgressFired) {
          markOutcome('stalled');
          return {
            text: null, reasoning: '', usage, steps, finish, truncated: false, aborted: false, stalled: true,
            note: turnProgress.note || noProgressNotice({ waitedMs: Date.now() - turnProgress.lastProgressAt, toolCalls: turnProgress.toolCalls, modelRounds: turnProgress.modelRounds }),
            durationMs: Date.now() - startedAt, perf: perf(),
          };
        }
        return {
          text: null, reasoning: '', usage, steps, finish, truncated: false, aborted: true,
          note: '已按 Ctrl+C 中断（工具执行期间收到中断信号），本回合未再发出请求。',
          durationMs: Date.now() - startedAt, perf: perf(),
        };
      }
      // 接线点①（v0.6.40）：每个 step 边界全量取走插话；放在中止检查之后 = 停止优先。
      drainSteeringInto(steering, messages, io);
      // 本轮的 AbortController 提到压缩之前创建（审计 BUG-037）：压缩是一次**大开销的真实请求**
      // （30K 输入 × executor 模型），此前它在 `ac` 创建之前发生、拿不到任何 signal，
      // 于是压缩期间 Ctrl+C 只能等它返回（远程 600s / 本地 1800s，且还有一次重试）。
      const ac = new AbortController();
      currentAc = ac;
      // 自动压缩（P3-1）：预算不足、静默裁剪即将丢弃早期段落时，先用 executor 模型
      // 把被裁段落压成摘要注入，替代「失忆」；失败/不值得时回退普通裁剪。
      if (cfg.autoCompact !== false) {
        try {
          if (turnProgress.phase !== '已中止（无进展）') turnProgress.phase = '压缩上下文';
          const compacted = await compactConversation({
            messages,
            budget: turnBudget,
            count,
            provider,
            executorModel: subagentModel(cfg, modelName),
            // 可配置触发线：默认远程 80%；本地模型默认 60% 提前压缩——本地推理内存预算有限，
            // 等到 80% 再压时上下文已累积过多、prefill 与内存双高（v0.4.2 本地模型 507 修复）
            triggerRatio: Number(cfg.compactTrigger) > 0 ? cfg.compactTrigger : (caps.isLocal ? 0.6 : undefined),
            force: windowPressure, // v0.3.2：逼近窗口时强制压缩（忽略最小阈值门槛）
            // v0.6.5（审计 BUG-037）：摘要请求也要能被打断（此前压缩链路完全没有 signal）
            signal: ac.signal,
          });
          if (compacted) {
            messages.splice(0, messages.length, ...compacted.messages);
            if (compacted.usage) {
              usage.prompt_tokens += compacted.usage.prompt_tokens || 0;
              usage.completion_tokens += compacted.usage.completion_tokens || 0;
            }
            io.print(
              style(
                `♻ 自动压缩上下文：${compacted.droppedCount} 条早期消息 → 摘要（回收约 ${compacted.droppedTokens} tokens）`,
                C.dim
              )
            );
            // v0.4.1 P1 修复：压缩成功后复位 windowPressure——此前永不复位，后续每轮都 force 压缩，
            // 叠加 compact.js force 分支跳过 2000 token 最小阈值，增量段极短也发真实模型调用持续烧钱。
            if (windowPressure) {
              windowPressure = false;
              pressureWarned = false;
            }
            // v0.6.3（M-1）：压缩把早期消息（含文件正文）换成了摘要，但**读取去重缓存**还记着
            // "这个文件你看过（mtime+size 未变）"——模型随后再读同一文件只会拿到「内容与上次读取一致」
            // 的占位串，而正文已经不在上下文里了，于是它可能凭残缺信息继续改文件。
            // 压缩是"上下文被替换"的事件，缓存必须跟着失效（代价只是重新读一次文件）。
            agentReadCache.clear();
            try {
              onCompact?.(messages);
            } catch {}
            // v0.7.0 §1.1：compact 事件携带压缩后的**完整基线**——重放据此整体替换，
            // 与 onCompact 把同一份 messages 重写进 .jsonl 是同一事实。
            emitEvent('compact', { droppedCount: compacted.droppedCount, droppedTokens: compacted.droppedTokens, messages });
          }
        } catch {}
      }
      const trimmed = trimMessages(messages, turnBudget, count);

      // reasoning 回填防护（Kimi P0 修正）：带 tool_calls 的 assistant 消息必须「完整」回传
      // reasoning_content（DeepSeek thinking_mode 官方要求：后续请求含 tools 时缺/截断即 400，
      // 多轮工具会话必崩）；仅纯文本回复的 reasoning 可裁剪（不回传也不影响）。
      // v0.4.1 P2 修复：单次遍历构建新数组（O(n)），此前循环内每次替换都 sanitized.map 全量重建（O(n²)）。
      let sanitized = trimmed;
      let dirty = false;
      for (let i = 0; i < sanitized.length; i++) {
        const m = sanitized[i];
        const rc = m.reasoning_content;
        if (typeof rc !== 'string' || (Array.isArray(m.tool_calls) && m.tool_calls.length)) continue;
        let replacement = null;
        if (rc.length > 4000) {
          replacement = `[思考过程已省略（原 ${rc.length} 字）]`;
        } else if (rc.length > 1000) {
          replacement = rc.slice(-500) + ' …[思考过程已截断]';
        }
        if (replacement !== null) {
          if (!dirty) {
            sanitized = sanitized.slice();
            dirty = true;
          }
          sanitized[i] = { ...m, reasoning_content: replacement };
        }
      }

      // v0.8.0 性能（审计报告A M-5）：`sanitized` 本步内不再变，token 总数只遍历一次。
      // 此前成本护栏与 prefill 预告各遍历一遍（每步 2 次 O(n)），长会话下是纯浪费。
      let promptTokens = 0;
      for (const m of sanitized) promptTokens += messageTokens(m, count);

      // 护栏前置预估（Kimi P2-E）：发送前按本轮最坏成本估算（trimmed prompt × 未命中输入价
      // + maxOutput × 输出价，峰谷按当前时段）；「今日已用 + 最坏成本」超上限时发送前拦截，
      // 而不是等 200K 上下文的贵请求发出后才 block。action='downgrade'（省钱 B4）不在此拦截——
      // 由降级流程接管：切到便宜模型后按 flash 价格重新估算，通常即可放行。
      if (cfg.costGuard) {
        const g = costGuardConfig();
        if (g && Number(g.dailyLimitYuan) > 0 && g.action !== 'downgrade') {
          const worst = estimateCost(activeModel, promptTokens, turnMaxOutput, null, new Date());
          // 判据本身抽到 cost-guard.js 的 preflightBlockMessage（v0.6.11 / P1-1 第一刀）：
          // 它能被单测逐条钉边界，而 runTurn 只负责"拿到数字 → 问判据 → 该拦就拦"。
          // 统计不可读 / 无价格数据时判据返回 null（不误拦、也不静默放行——主检查会告警）。
          const msg = preflightBlockMessage(g.dailyLimitYuan, usedTodayWithInflight(), worst);
          if (msg) {
            finishTurn();
            return {
              text: null, reasoning: '', usage, steps, finish, truncated: false, aborted: false,
              note: msg,
              durationMs: Date.now() - startedAt, perf: perf(),
            };
          }
        }
      }

      // 费用护栏（A2/B4）：每轮开始前按今日实际费用检查；block 暂停本轮；
      // downgrade 自动切换便宜模型继续执行（每回合只切一次，切换即粘滞）
      if (cfg.costGuard) {
        // 判据全部抽到 cost-guard.js 的 roundGuardAction()（v0.6.11 / P1-1 第二刀）：
        // 这里只负责"问决策 → 按决策执行副作用"（打印、切换模型、提前返回）。
        // 之所以值得抽：这段里有两处**实测复现过的计费缺陷**（降级后又静默继续、
        // 在途费用不参与决策），埋在循环里时只能靠端到端验证，现在四个动作可以被逐条钉死。
        const d = roundGuardAction(
          checkCostGuard(activeModel),
          costGuardConfig(),
          usedTodayWithInflight(),
          downgraded,
          activeModel,
          DEFAULT_MODEL
        );
        if (d.action === 'block') {
          finishTurn();
          return {
            text: null, reasoning: '', usage, steps, finish, truncated: false, aborted: false,
            note: d.message, durationMs: Date.now() - startedAt, perf: perf(),
          };
        }
        if (d.action === 'already-cheapest') {
          finishTurn();
          return {
            text: null, reasoning: '', usage, steps, finish, truncated: false, aborted: false,
            note: `今日费用已达上限（实际 ¥${String((todayCost() ?? 0).toFixed(4))}），且已在最便宜模型上执行，已暂停——调整 config.costGuard 或明天自动恢复。`,
            durationMs: Date.now() - startedAt, perf: perf(),
          };
        }
        if (d.action === 'try-downgrade') {
          const target = String(d.model);
          // MiniMax P0：降级目标零校验会崩溃——必须与当前模型同服务商且已有 Key，
          // 否则 provider.chat 必然 400；校验失败按 block 处理并给修复指引。
          const curPc = resolveProviderConfig(cfg, activeModel);
          const dgPc = resolveProviderConfig(cfg, target);
          // Key 归属服务商（provider 级），同服务商即天然共享同一 Key，无需再查 apiKey
          if (dgPc && dgPc.name === curPc.name) {
            activeModel = target;
            downgraded = true;
            io.print(style(d.message, C.yellow));
          } else {
            finishTurn();
            return {
              text: null, reasoning: '', usage, steps, finish, truncated: false, aborted: false,
              note: `费用护栏想降级到 ${target}，但它与当前服务商不一致或缺少 API Key——已暂停执行。请把 config.costGuard.downgradeModel 改为与当前模型同服务商（当前：${curPc.name}）的模型名，或调高 dailyLimitYuan。`,
              durationMs: Date.now() - startedAt, perf: perf(),
            };
          }
        } else if (d.action === 'warn') {
          io.print(style(d.message, C.yellow));
        }
      }

      io.beginTurn();
      io.startSpinner('正在思考…');

      // v0.6.13（A）：**发送前的规模预告**——本地模型"prefill 数十分钟"必须先说出来，
      // 而不是让用户盯着一个没有任何输出的界面猜。阈值与文案见 prefillForecast()。
      // 首帧上限与 providers/index.js 同口径（那里没有导出，这里镜像；本地 600s / 远程 300s）。
      {
        const effFirstTokenMs =
          Number(cfg?.timeout?.firstTokenMs) > 0 ? Number(cfg.timeout.firstTokenMs) : caps.isLocal ? 600000 : 300000;
        try {
          // v0.6.15（§3.59 第 3 条）：本地端点是否已有在途/排队请求（父回合、子代理、预检共用同一队列）。
          // 这里读的是**进程级闸门快照**（provider.config.baseUrl），不是猜——云端端点恒为 0。
          let gate = { active: 0, queued: 0, limit: 1 };
          try {
            if (caps.isLocal) gate = localGateSnapshot(provider?.config?.baseUrl);
          } catch {}
          const f = prefillForecast({
            promptTokens,
            contextWindow: caps.contextWindow,
            isLocal: caps.isLocal,
            firstTokenMs: Number(cfg?.timeout?.firstTokenMs) > 0 ? Number(cfg.timeout.firstTokenMs) : effFirstTokenMs,
            budget: turnBudget,
            probe: cfg?.endpointProbe || null,
            localBusy: Boolean(caps.isLocal && (gate.active > 0 || gate.queued > 0)),
            localActive: gate.active,
            localQueued: gate.queued,
            localConcurrency: localConcurrencyLimit(cfg),
            // v0.6.26 §3.91：只在**本回合第一次**请求的预告里说明"预算来自哪天的失败学习"
            // （后续每轮重复同一条说明只会刷屏）。
            learned: turnProgress.llmCalls === 0 ? turnLearned : null,
          });
          turnProgress.forecast = f;
          // 首次请求一定说；之后只在命中告警线时说（否则每步一条横幅会刷屏）
          if (turnProgress.llmCalls === 0 || f.warn) io.print(style(f.text, f.warn ? C.yellow : C.dim));
        } catch {}
      }

      let res;
      // 审计（tsc 扩面发现）：llmT0 此前在 try 内声明、catch 内引用——chat 抛错时
      // catch 自身 ReferenceError，掩盖原始错误且计时丢失；提到 try 外声明。
      const llmT0 = Date.now();
      lastRequestStartAt = llmT0;
      turnProgress.llmCalls += 1;
      turnProgress.phase = '发请求（等首帧）';
      // v0.6.26 §3.91：本次请求实际发往的端点（费用护栏可能把 activeModel 降级到别家模型，
      // 端点学习必须记在**真正发请求的那个 baseUrl** 上，而不是 agent 创建时的模型）。
      const requestBaseUrl = resolveEndpointBaseUrl(cfg, activeModel);
      currentRequestBaseUrl = requestBaseUrl;
      try {
        res = await provider.chat({
          model: activeModel,
          messages: sanitized,
          tools: toolsFor(readOnlyPhase, turnStrippedSet),
          temperature,
          maxTokens: turnMaxOutput,
          // v0.6.26 §3.91：把本回合**实际生效**的 prompt 预算一并传给 provider。
          // openai-compatible 会忽略它（不属于协议字段）；它的用途是让端点级学习、诊断与
          // 回归套件能断言"这一请求到底按多大预算发的"（子代理继承也靠它验证）。
          budget: turnBudget,
          // MiniMax P0：仅当 activeModel 声明支持 reasoning 才发送（否则 400 终止回合）；'off' 显式禁用例外
          reasoningEffort: modelPreset(activeModel)?.supportsReasoning || reasoningEffort === 'off' ? reasoningEffort : undefined,
          // v0.6.18 §3.74：发生过内存降级后，本回合后续请求**一律压回单并发**（即便用户把
          // config.localConcurrency 配成 0/2）——provider 会把它传给 acquireLocalSlot。
          ...(memoryRetries > 0 ? { localConcurrency: 1 } : {}),
          signal: ac.signal,
          // v0.6.15（§3.59 第 1 条）：本地端点串行化必须**在界面上可见**——
          // 排队时状态条/进度行写"排队等待本地端点（已串行化防内存压力）"，
          // 拿到名额后恢复"发请求（等首帧）"（onDelta 之后会覆盖成"解码中"）。
          onQueueWait(/** @type {any} */ ev) {
            if (!ev) return;
            if (ev.waiting) {
              turnProgress.localQueue = { active: ev.active, queued: ev.queued, limit: ev.limit };
              turnProgress.phase = `排队等待本地端点（已串行化防内存压力：${ev.active} 个在途）`;
              if (!turnProgress.localQueueNoticed) {
                turnProgress.localQueueNoticed = true;
                try {
                  io.print(
                    style(
                      `⏳ 本地端点串行化：等待 ${ev.active} 个在途请求（并发上限 ${ev.limit}）——` +
                        `本地模型内存压力，父回合与子代理不再同时 prefill`,
                      C.dim
                    )
                  );
                } catch {}
              }
            } else {
              turnProgress.localQueue = null;
              if (String(turnProgress.phase || '').startsWith('排队等待本地端点')) turnProgress.phase = '发请求（等首帧）';
            }
          },
          onDelta(/** @type {any} */ d) {
            io.stopSpinner();
            // v0.6.13（A）：帧/字符计数 + 首帧时延（TTFT）——本地模型最关键的指标
            turnProgress.streamFrames += 1;
            const chunkChars = (d.text ? String(d.text).length : 0) + (d.reasoning ? String(d.reasoning).length : 0);
            if (chunkChars) turnProgress.contentChars += chunkChars;
            if (firstTokenAt == null) firstTokenAt = Date.now(); // 首个增量即首 token
            const ttft = firstTokenAt - llmT0;
            turnProgress.lastTtftMs = ttft;
            if (turnProgress.ttftMs == null) turnProgress.ttftMs = ttft;
            turnProgress.phase = '解码中（收到增量）';
            // v0.6.28 §3.96：TTFT 每回合只在**第 1 次模型请求**时打印一行；后续请求静默
            // （状态条/右栏已有首帧值）。长审计里本地模型会有十几次请求，重复打印只会刷屏。
            // 可选的"后续明显劣化警告"本轮未实现：现有 firstTokenAt 是回合级的，
            // 不能用来量后续请求的 TTFT（否则会得到负值），不为一条提示去改测量口径。
            // v0.6.31：会话级节流（见文件顶部 shouldPrintTtftNotice）——长审计里「继续」会产生
            // 很多新回合，每回合都打一次会把聊天区刷满；但首帧**明显变慢**时必须照常报（劣化信号）。
            {
              const nk = String(cfg?.sessionRef?.name || cfg?.sessionKey || workingDir || 'default');
              const st = ttftNoticeStateFor(nk);
              const verdict = shouldPrintTtftNotice({
                llmCalls: turnProgress.llmCalls,
                ttftMs: ttft,
                lastMs: st.ms,
                lastAt: st.at,
                now: Date.now(),
                quietMs: Number(cfg?.ttftNoticeQuietMs) > 0 ? Number(cfg.ttftNoticeQuietMs) : TTFT_NOTICE_DEFAULT_QUIET_MS,
              });
              if (verdict.print) {
                st.ms = ttft;
                st.at = Date.now();
                try {
                  io.print(style(
                    verdict.slowdown
                      ? `⏱ 首帧 ${(ttft / 1000).toFixed(1)}s（比上次明显变慢，本地模型这一项直接反映 prefill 快慢）`
                      : `⏱ 首帧 ${(ttft / 1000).toFixed(1)}s（第 ${turnProgress.llmCalls} 次模型请求；本地模型这一项直接反映 prefill 快慢）`,
                    verdict.slowdown ? C.yellow : C.dim
                  ));
                } catch {}
              }
            }
            markProgress('模型增量');
            if (d.text) io.writeText(d.text);
            if (d.reasoning) {
              reasoningTokens += approxTokens(d.reasoning); // 省钱 B3：推理 token 估算（分账维度）
              io.writeReasoning(d.reasoning);
            }
          },
        });
        llmMsTotal += Date.now() - llmT0;
        turnProgress.modelRounds += 1;
        // v0.6.13（A）：**"轮次返回"本身不算进展**——真机现场就是"每十几分钟返回一次、
        // 每次都是一模一样的失败工具调用"，若把返回当进展，看门狗永远不会响。
        // 只有真的产出了正文/推理才算（工具调用的进展由 finishTool 按"成功且不重复"判定）。
        if (res.text || res.reasoning) markProgress('模型轮次返回（有正文/推理）');
      } catch (err) {
        llmMsTotal += Date.now() - llmT0;
        io.stopSpinner();
        io.endTurn();
        // v0.6.13（A）：看门狗触发的中止——如实报告"连续 N 分钟无进展"，不冒充 Ctrl+C/正常结束
        if (noProgressFired) {
          finishTurn();
          markOutcome('stalled');
          return {
            text: null, reasoning: '', usage, steps, finish, truncated: false, aborted: false, stalled: true,
            note: turnProgress.note || noProgressNotice({ waitedMs: Date.now() - turnProgress.lastProgressAt, toolCalls: turnProgress.toolCalls, modelRounds: turnProgress.modelRounds }),
            durationMs: Date.now() - startedAt, perf: perf(),
          };
        }
        if (aborted) {
          finishTurn();
          markOutcome('aborted', { aborted: true });
          return { text: null, reasoning: '', usage, steps, finish, truncated: false, aborted: outcome.aborted, upstreamTruncated, durationMs: Date.now() - startedAt, perf: perf() };
        }
        // MacBook 本地 507 memory_refusal 根因（v0.4.5）：服务端内存拒绝不是「空输出」——
        // 直接终结合合并透出降级提示，不计入空轮、不注入续写重试（内存未释放必再 507，空烧请求）。
        const e = /** @type {any} */ (err);
        // ---------------------------------------------------------------------------
        // v0.6.26 §3.91：**多级压缩（最多 2 次）+ 端点级学习 + 子代理继承**
        //
        // 真机证据（~/.mingdao/logs/web-server.log，10-18 / 10-19 / 10-26 三次同形态）：
        //   子代理「审计网络与安全防线」已跑 31 轮 / 50 次工具调用
        //   然后 `insufficient memory … aborted before the allocator wall`
        //   旧恢复只压一级（32,768 → 19,660）、只重试一次，仍失败就整回合失败。
        // 现在：
        //   · 第 1 级：预算 ×0.6、输出 ×0.5；第 2 级：预算 ×0.35、输出 ×0.25（都相对起手值）；
        //   · 每级都打日志（第几次 / 压缩前后数值），**硬性上限 2 次**，绝不无限重试；
        //   · 两级都失败 → 把最后尝试的预算写成该端点的 safeContextBudget（endpoint-limits.json），
        //     下一回合起手直接用它（不再从同一个注定失败的预算重撞一次）；
        //   · 云端端点不在此列：云 API 的 507/容量问题不是本地上下文能改的，压缩重试只会多烧一次请求。
        // ---------------------------------------------------------------------------
        let localEndpoint = false;
        try {
          // 用**本回合实际使用**的模型判本地：费用护栏可能把 activeModel 降级到云端模型，
          // 此时不能拿原始 modelName 的 caps.isLocal 误判成"本地内存不足"。
          const activeCaps = resolveModelCaps(cfg, activeModel);
          const pcNow = resolveProviderConfig(cfg, activeModel);
          localEndpoint = Boolean(activeCaps.isLocal || isLocalBaseUrl(pcNow?.baseUrl || provider?.config?.baseUrl || ''));
        } catch {}
        const localMemory = describeUpstreamError(e, { isLocal: localEndpoint });
        if (localMemory.recoverableByShrinking) {
          if (memoryRetries >= MAX_MEMORY_RETRIES) {
            // 两级压缩都失败：**先学习、再报错**——学习值要立刻落盘并出现在建议里，
            // 否则用户看到的建议与下回合实际预算继续分裂（真机正是这样）。
            const rec = /** @type {any} */ (lastMemoryRecovery) || {};
            let learned = /** @type {any} */ (null);
            try {
              learned = learnEndpointMemoryFailure(requestBaseUrl, {
                budget: Number(rec.toBudget) > 0 ? Number(rec.toBudget) : turnBudget,
                maxOutput: turnMaxOutput,
                attempts: Math.max(1, memoryRetries),
                at: Date.now(),
              });
            } catch (learnErr) {
              learned = {
                ok: false,
                record: null,
                file: '',
                error: `端点学习失败：${(/** @type {any} */ (learnErr))?.message || learnErr}——本轮按无学习值继续`,
              };
            }
            const learnedBudget = learned?.ok ? Math.floor(Number(learned.record?.safeContextBudget) || 0) : 0;
            // 建议文案必须与学习值**同一个数字**（describeUpstreamError 负责把 hint 对齐）。
            const finalDiag = describeUpstreamError(e, { isLocal: localEndpoint, learned: learned?.ok ? learned.record : null });
            const budgetChain =
              Array.isArray(rec.history) && rec.history.length
                ? rec.history.map((/** @type {any} */ h) => fmtTok(h.fromBudget)).concat(fmtTok(rec.toBudget)).join(' → ')
                : `${fmtTok(rec.fromBudget)} → ${fmtTok(rec.toBudget)}`;
            const outputChain =
              Array.isArray(rec.history) && rec.history.length
                ? rec.history.map((/** @type {any} */ h) => fmtTok(h.fromMaxOutput)).concat(fmtTok(rec.toMaxOutput)).join(' → ')
                : `${fmtTok(rec.fromMaxOutput)} → ${fmtTok(rec.toMaxOutput)}`;
            const learnedText =
              learned?.ok && learnedBudget > 0
                ? `已把该端点内存安全预算记为 ${fmtTok(learnedBudget)}（写入 ${learned.file}），下轮起手自动使用——` +
                  `config.contextBudget 也可手动调到 ${fmtTok(learnedBudget)}。`
                : `⚠ ${learned?.error || '端点学习值未写入'}——本轮按无学习值继续，不阻断会话。`;
            const detail =
              `本地引擎内存不足：已压缩上下文 ${memoryRetries} 级（${budgetChain}）、输出上限 ${outputChain}，` +
              `并重试 ${memoryRetries} 次（硬性上限 ${MAX_MEMORY_RETRIES}），仍失败——不再重试。${learnedText}` +
              `请关闭其他占用显存的模型进程/并行会话，并在引擎侧调大 --ctx-size 或使用 q8 KV 量化。`;
            try { io.print(style(`⚠ ${finalDiag.message}\n   ${finalDiag.hint || ''}\n   ↩ ${detail}`, C.yellow)); } catch {}
            const enriched = new Error(`${finalDiag.message}\n   ${finalDiag.hint || ''}\n   ↩ ${detail}`);
            /** @type {any} */ (enriched).status = e?.status ?? 507;
            if (e?.headers !== undefined) /** @type {any} */ (enriched).headers = e.headers;
            throw enriched;
          }
          memoryRetries += 1;
          const target = memoryRecoveryTarget({ budget: turnBaseBudget, maxOutput: turnBaseMaxOutput, retry: memoryRetries });
          const fromBudget = turnBudget;
          const fromMaxOutput = turnMaxOutput;
          turnBudget = target.budget;
          turnMaxOutput = target.maxOutput;
          // 子代理继承：压缩后的值必须立刻对后续 spawnTask 可见（见 spawnTask 的 cfg）。
          currentTurnBudget = turnBudget;
          currentTurnMaxOutput = turnMaxOutput;
          const attempt = {
            level: target.level,
            fromBudget,
            toBudget: turnBudget,
            fromMaxOutput,
            toMaxOutput: turnMaxOutput,
            at: Date.now(),
          };
          const prevHistory = Array.isArray(lastMemoryRecovery?.history) ? lastMemoryRecovery.history : [];
          lastMemoryRecovery = {
            attempts: memoryRetries,
            fromBudget: turnBaseBudget,
            toBudget: turnBudget,
            fromMaxOutput: turnBaseMaxOutput,
            toMaxOutput: turnMaxOutput,
            history: [...prevHistory, attempt],
            at: Date.now(),
          };
          const msg =
            `♻ 内存降级重试 第 ${memoryRetries}/${MAX_MEMORY_RETRIES} 次：因本地引擎内存不足，已压缩上下文` +
            `（${fmtTok(fromBudget)} → ~${fmtTok(turnBudget)}）、输出上限 ${fmtTok(fromMaxOutput)} → ${fmtTok(turnMaxOutput)}` +
            `（串行化：并发上限 1）`;
          try { io.print(style(msg, C.yellow)); } catch {}
          turnNotes.push(msg);
          turnProgress.phase = `内存降级重试（第 ${memoryRetries}/${MAX_MEMORY_RETRIES} 次压缩）`;
          turnProgress.memoryRecovery = lastMemoryRecovery;
          steps = Math.max(0, steps - 1); // 重试不额外消耗一步，避免 maxSteps=1 时根本没机会重试
          continue;
        }
        // v0.6.15（§3.59 第 2 条）：`engine shed its caches and stays up` / `allocator wall`
        // 说明引擎**活着**（自己丢缓存后继续服务）——不走这条"507 旧文案"（那里建议重启引擎，
        // 对活着但内存吃紧的引擎是错误处置）；交给下面 describeUpstreamError 的独立分型。
        const engineShedCaches = /engine shed its caches and stays up|allocator wall/i.test(String(e?.message || ''));
        if (!engineShedCaches && (e?.status === 507 || /memory_refusal|内存不足|内存拒绝/i.test(String(e?.message || '')))) {
          finishTurn();
          markOutcome('done');
          return {
            text: null,
            reasoning: '',
            usage,
            steps,
            finish,
            truncated: false,
            aborted: false,
            upstreamTruncated,
            note: '本地模型内存不足（507 memory_refusal）——请压缩上下文（减小 config.contextBudget 或 /compact）、减少并发子任务，或重启模型服务释放内存后再继续。',
            durationMs: Date.now() - startedAt,
            perf: perf(),
          };
        }
        // v0.6.13（A）：**上游/引擎错误必须透出且可操作**。
        // 此前这里直接 `throw err`：原文（400 的模板报错、引擎的 memory_refusal、内核自己的三类超时）
        // 只在最外层变成一条 error 事件，用户看到一坨堆栈式原文却不知道该改什么；子代理路径里
        // 它更会被压成一行工具结果。现在统一补一条"这是什么 + 该怎么办"，并**同时**在界面上打一条，
        // 让"错误被谁吞掉"不再可能（原始 message 一字不改地保留在首行）。
        {
          const d = describeUpstreamError(e);
          if (d.hint) {
            try { io.print(style(`⚠ 上游错误：${d.message}\n   ${d.hint}`, C.yellow)); } catch {}
            const enriched = new Error(`${d.message}\n   ${d.hint}`);
            if (e && typeof e === 'object') {
              if (e.status !== undefined) /** @type {any} */ (enriched).status = e.status;
              if (e.headers !== undefined) /** @type {any} */ (enriched).headers = e.headers;
            }
            throw enriched;
          }
        }
        throw err;
      }

      // v0.6.28（L-13）：`?? finish` 只在**本步**已写入时才有值；上面每步开始已重置为 null，
      // 因此缺失 finish_reason 时这里落到 null，绝不会把上一步的 length/capped 带进本轮收尾。
      finish = res.finish ?? finish;
      // v0.6.3（M-16）：上游**提前关流**（没有 [DONE]、也没有 finish_reason）说明这次回答很可能是半截的。
      // 此前它与正常结束完全无法区分：用户拿到半句、账本记 done、也没有任何告警。
      // 这里至少做到"说出来"——置标记并在界面上提示，让人知道该复核输出而不是直接采信。
      // v0.6.28（M-10）：**有内容的模型轮**复位空轮计数。`finish === 'length'` 的轮次不算
      // （正文即使非空也是被截断的半截，正是本护栏要计数的形态），否则截断续写护栏会被清零。
      if (String(res.text || '').trim() && res.finish !== 'length') emptyRounds = 0;
      if (res.truncated) {
        upstreamTruncated = true;
        try {
          io.print(style('⚠ 上游提前结束响应（未收到结束标记），本次回答可能不完整——请复核输出后再采用。', C.yellow));
        } catch {}
      }
      // v0.6.0 C1：模型轮次事件（耗时/首 token/用量/完成原因）——「这一步花了多少钱、等了多久」的最小依据
      turnLedger.modelRound({
        round,
        step: steps,
        ms: Date.now() - llmT0,
        firstTokenMs: firstTokenAt ? firstTokenAt - llmT0 : null,
        requestStartAt: lastRequestStartAt,
        finish: res.finish ?? null,
        // 提前关流是"这次回答不可信"的事实，必须进账本（否则事后无法区分它和正常完成）
        ...(res.truncated ? { truncated: true } : {}),
        usage: res.usage ?? null,
      });
      // 省钱 B1：只读阶段中模型文字明确表达写意图 → 下一轮注入全量工具（多一轮，几乎无感）
      if (readOnlyPhase && hasWriteIntent(res.text)) readOnlyPhase = false;
      if (!res.usage && (res.text || res.toolCalls?.length)) {
        // v0.6.7（报告一 H-4）：网关/自定义端点不返回 usage 时，此前这回合在账上**不存在**——
        // warn/block/downgrade 三档护栏全部失明且没有任何信号。这里置位 + 明确告知，
        // 落账时按"用量未知"处理（cost:null / priced:false），绝不冒充"这次花了 ¥0"。
        if (!outcome.usageUnknown) {
          outcome.usageUnknown = true;
          try {
            io.print(
              style(
                '⚠ 服务端未返回本次调用的用量（usage 缺失）：这一回合无法计费，今日费用护栏会少计这部分消费。\n' +
                  '  常见于自建网关/中转端点；如需精确护栏，请让网关透传 usage 字段。',
                C.yellow
              )
            );
          } catch {}
        }
      }
      if (res.usage) {
        usage.prompt_tokens += res.usage.prompt_tokens || 0;
        usage.completion_tokens += res.usage.completion_tokens || 0;
        // 保留 DeepSeek 缓存命中/未命中字段（费用估算与命中率展示依赖）
        if (Number.isFinite(res.usage.prompt_cache_hit_tokens)) {
          usage.prompt_cache_hit_tokens = (usage.prompt_cache_hit_tokens || 0) + res.usage.prompt_cache_hit_tokens;
        }
        if (Number.isFinite(res.usage.prompt_cache_miss_tokens)) {
          usage.prompt_cache_miss_tokens = (usage.prompt_cache_miss_tokens || 0) + res.usage.prompt_cache_miss_tokens;
        }
        // v0.3.2 边缘检测：模型上报的真实 prompt_tokens（含缓存命中）逼近窗口 85% 即标记——
        // 下一轮强制激进压缩（force），不让 prompt 逼近窗口边缘导致 prefill 指数恶化。
        const realPrompt = Number(res.usage.prompt_tokens);
        if (Number.isFinite(realPrompt) && realPrompt > 0 && realPrompt >= caps.contextWindow * EDGE_RATIO) {
          windowPressure = true;
          if (!pressureWarned) {
            pressureWarned = true;
            io.print(style(`⚠ 上下文已逼近模型窗口（${realPrompt}/${caps.contextWindow}，≥${Math.round(EDGE_RATIO * 100)}%），下轮将强制压缩历史防 prefill 恶化`, C.yellow));
          }
        }
      }
      // v0.7.0 §1.1：本步模型用量（逐轮，便于与 message/tool 事件对齐）
      if (res.usage) emitEvent('usage', { model: activeModel, round, step: steps, usage: res.usage, total: { ...usage } });

      if (res.toolCalls?.length) {
        // v0.6.13（A）：本回合 tool_call 计数（界面/日志/收尾提示的单一来源）
        turnProgress.toolCalls += res.toolCalls.length;
        // v0.2.8 步数上限收尾（对齐 DSH）：末轮仍返回工具调用（无视收尾指令）时不再执行工具——
        // 有正文直接收尾，无正文跳出循环进入兜底总结，避免再次跑满步数后静默结束。
        if (steps === stepLimit) {
          io.endTurn();
          if (res.text) {
            const ap = await applyOutputConstraints(res.text, { messages, provider, activeModel, temperature, maxOutput: turnMaxOutput, usage, signal: currentAc?.signal });
            messages.push({ role: 'assistant', content: ap.text });
            // 步数已耗尽：这一条与下方 `break`（→ 兜底总结/截断收尾）必须是同一口径
            markOutcome('capped', { capHit: true });
            return { text: ap.text, reasoning: res.reasoning || '', usage, steps, finish, truncated: false, aborted: false, capHit: outcome.capHit, upstreamTruncated, note: ap.note || undefined, durationMs: Date.now() - startedAt, perf: perf() };
          }
          break;
        }
        io.endTurn();
        const assistantMsg = {
          role: 'assistant',
          content: res.text || null,
          tool_calls: res.toolCalls,
          // Kimi P0：带工具调用的消息必须携带完整 reasoning_content（否则下一轮 400）
          ...(res.toolCalls?.length && res.reasoning ? { reasoning_content: res.reasoning } : {}),
        };
        messages.push(assistantMsg);

        // 只读工具并行（P2-8）：同一 response 里的连续 read/ls/glob/grep 无相互依赖，
        // 在 auto 权限模式下（无交互询问、无副作用的纯读）Promise.all 并发执行；
        // 其余模式/工具保持串行，避免多个权限对话框交错。事件顺序（start/render/post/回填）不变。
        const READONLY_BATCH = new Set(['read', 'ls', 'glob', 'grep']);
        const canBatch = permission.mode === 'auto';
        // v0.4.2（本地模型 507 memory_refusal 修复）：子代理目标为本地模型时，只读子代理不并行——
        // 多路大 prefill 同时冲进本地推理服务会击穿其单进程内存预算（507 memory_refusal），
        // 串行化只读子代理避免并发峰值（只读 read/ls/glob/grep 仍并行，它们不额外触发大 prefill）。
        const subagentIsLocal = resolveModelCaps(cfg, subagentModel(cfg, modelName)).isLocal;

        // 预检：解析参数 → PreToolUse 钩子 → 权限检查；拒绝/失败只回填不执行。
        // v0.6.29（H-02）：拒绝项不再就地 push（那会与成功项的执行顺序错位），而是返回
        // `{denied}`，由批次循环按 `tool_calls` 原序排入回填队列。
        // task 工具标记 readOnly 时也可并行（评估 A4：只读子代理 Promise.all）
        async function prepTool(/** @type {any} */ tc) {
          const name = tc.function?.name || '';
          // 审计（P3-5）：参数与拒绝原因都记录（配置 audit:false 可关）
          const auditOn = cfg.audit !== false;
          const auditArgs = () => redactSecrets(JSON.stringify(args ?? {})).slice(0, 2000);
          // v0.7.0 §1.4：工具执行路径上的审计（每次工具调用一条）改异步写，锁等待让出事件循环。
          const auditEntry = async (extra = {}) =>
            writeAuditAsync({
              at: Date.now(),
              session: sessionRef?.name ?? null,
              model: modelName,
              tool: name,
              args: auditArgs(),
              ...extra,
            });
          let args = /** @type {any} */ (null);
          // 参数解析/容错/归一化单源在 tools-flow.js 的 parseToolArgs()（v0.6.17，P1-1 第四刀）：
          // 本函数只返回判据，下面三条副作用（渲染拒绝 / 审计 / 回填分块指引）仍按原顺序执行。
          const parsedArgs = parseToolArgs(tc.function?.arguments);
          if (!parsedArgs.ok) {
            // 参数 JSON 解析失败：回填错误给模型，不拿空参数去执行工具
            io.renderToolDenied(name, {}, parsedArgs.deniedReason);
            if (auditOn) await auditEntry({ denied: true, reason: parsedArgs.auditReason });
            // 审计（长生成截断循环）：给出明确分块指引，避免模型反复用单个超大 write 撞输出上限
            return { tc, name, denied: parsedArgs.message };
          }
          args = parsedArgs.args;

          // PreToolUse 钩子
          const hook = await hooks.pre(name, args);
          if (hook.decision === 'block') {
            io.renderToolDenied(name, args, '被钩子阻止');
            if (auditOn) await auditEntry({ denied: true, reason: `PreToolUse 钩子阻止：${String(hook.reason || '').slice(0, 200)}` });
            return { tc, name, denied: `工具被 PreToolUse 钩子阻止：${hook.reason}` };
          }

          const isMcp = name.startsWith('mcp__');
          // v0.4.0 Agent Preset：白名单强制（模型可能调用白名单外工具——schema 已不发，此处兜底硬拦）
          if (presetToolSet && !presetToolSet.has(isMcp ? name.slice(5) : name)) {
            io.renderToolDenied(name, args, `不在预设工具白名单内（${activePresetName || 'preset'}）`);
            if (auditOn) await auditEntry({ denied: true, reason: '预设工具白名单拦截' });
            return { tc, name, denied: `工具 ${name} 不在当前预设的工具白名单内，已拒绝执行。` };
          }
          let allowed = false;
          if (isMcp && mcp?.isReadonly(name)) {
            allowed = true; // MCP 工具的只读标注自动放行
          } else if (name === 'task' && args.readOnly === true) {
            allowed = true; // P2-2（v0.4.5）：只读子代理自动放行——它本身只读（readOnly 子代理只能读），
            // 与 release note「可派 readOnly 子代理」意图一致；非 readOnly 的 task 仍走权限询问
          } else {
            try {
              allowed = await permission.check(name, args);
            } catch {
              allowed = false; // 交互通道异常（如 stdin EOF）时按拒绝处理，不中断整个回合
            }
          }
          if (!allowed) {
            io.renderToolDenied(name, args, '未授权');
            if (auditOn) await auditEntry({ denied: true, reason: '未授权' });
            // v0.6.0 C1：权限拒绝是「为什么没执行」的头号答案，必须入账
            turnLedger.permission({ name, mode: permission?.mode ?? cfg.permission ?? null, decision: 'deny', source: 'permission.check' });
            turnLedger.toolCall({ callId: tc.id, name, rawArgs: args, args, permission: { decision: 'deny' } });
            turnLedger.toolResult({ callId: tc.id, name, ok: false, blocked: true, ms: 0, error: '权限拒绝' });
            return { tc, name, denied: '用户拒绝了该工具的执行权限。' };
          }
          // v0.5.0 A3 ①：领域约束（PreToolUse）——权限放行之后、执行之前强制。
          // 与权限引擎的分工：权限回答「用户是否允许」，约束回答「领域是否允许」；两者都通过才执行。
          const cv = checkPreTool(constraints, name, args);
          // v0.6.3（P1-2）：confirm 类约束——权限放行之后**仍要人工确认**。
          // 它存在的意义正是「权限档位是 auto 时也要问一次」；拿不到确认通道（非交互：
          // -p / 调度 / 子 Agent）或用户答否，一律按阻断处理，与权限引擎在同一情形下的
          // 「按拒绝处理」保持同一口径（fail-closed，见下方 permission.check 的 catch）。
          let confirmFailure = /** @type {string|null} */ (null);
          if (cv?.needsConfirm) {
            let granted = false;
            try {
              granted = await io.confirm(`【领域约束】${cv.reason}。是否继续执行？(y/N)`);
            } catch {
              granted = false;
            }
            if (granted) {
              if (auditOn) await auditEntry({ confirmRequired: true, granted: true, reason: cv.reason });
              turnLedger.permission({ name, mode: permission?.mode ?? cfg.permission ?? null, decision: 'confirm-granted', source: 'constraint.confirm', rule: cv.event?.id ?? null });
            } else {
              confirmFailure = `领域约束「${cv.event?.id ?? ''}」要求人工确认，未获确认（拒绝或当前环境无法交互）——已按 fail-closed 阻止执行`;
            }
          }
          // v0.6.0 C1：工具调用事件——参数留「脱敏明细 + 原文指纹」两份，指纹用于比对/防篡改；
          // 权限与约束**两者都记**：受监管场景要能回答「权限放行了，但领域红线拦住了」这类问题。
          turnLedger.toolCall({
            callId: tc.id,
            name,
            pack: /^pack__([a-z0-9-]+)__/.exec(String(name || ''))?.[1] ?? null,
            rawArgs: args,
            args,
            permission: { decision: 'allow', source: 'permission.check' },
            constraint: cv?.blocked || confirmFailure ? { blocked: true, id: cv?.event?.id ?? null, kind: cv?.event?.kind ?? null } : null,
          });
          if (cv?.blocked || confirmFailure) {
            const reason = confirmFailure ?? cv?.reason ?? '领域约束拦截';
            io.renderToolDenied(name, args, reason);
            if (auditOn) await auditEntry({ denied: true, reason });
            if (cv?.event) await auditConstraint(cv.event);
            // 被约束拦下的调用不会有 tool.result，这里补一条终态，避免账本出现「只有调用没有结果」的悬空步
            turnLedger.toolResult({ callId: tc.id, name, ok: false, blocked: true, ms: 0, error: '领域约束拦截' });
            return { tc, name, denied: `【领域约束】${reason}` };
          }
          return { tc, name, args, isMcp };
        }

        // 执行单个工具（渲染「执行中」→ dispatch → 捕获异常转错误结果）
        // 审计 Hermes C4：同回合相同参数的只读工具（read/ls/glob/grep/skill）合并执行一次，
        // 后续相同调用直接复用结果（仍逐个回填 tool 消息以保持 tool_call_id 配对）
        async function runTool(/** @type {any} */ prep) {
          // 渲染 / 去重键 / 进度登记全部移入 try：任何一步抛错都落成错误结果，绝不把整批拖进 Promise 拒绝
          // （审计报告1 S-1/S-2/H-2：渲染在 try 外抛错即 Promise 拒绝，Promise.all 下其余并行工具结果被丢弃）。
          const prevPending = turnProgress.pendingTool;
          const prevPack = currentPack;
          try {
            io.renderToolStart?.(prep.name, prep.args);
            // v0.7.0 §1.1：工具边界事件（只记 id/名字/是否命中缓存，不记参数正文）
            emitEvent('tool.start', { callId: prep.tc?.id ?? null, name: String(prep.name || ''), cached: Boolean(prep.cached) });
            // v0.6.13（A）：登记"正在等待哪个工具"——`task` 子代理/长命令动辄几十分钟，
            // 界面与日志必须能显示"在等谁、等了多久"，否则与卡死无法区分。
            turnProgress.pendingTool = { name: String(prep.name || ''), startedAt: Date.now() };
            turnProgress.phase = `执行工具 ${prep.name}`;
            // Pack 工具名形如 pack__<pack>__<tool>；执行期间标注来源，供 ctx.llm 归因
            const pkMatch = /^pack__([a-z0-9-]+)__/.exec(String(prep.name || ''));
            currentPack = pkMatch ? pkMatch[1] : null;
            usedToolNames.add(prep.name); // 省钱 B1：执行过即标记，后续轮次省略其 description
            const dedupKey = !prep.isMcp && READONLY_TOOLS_SET.has(prep.name) ? prep.name + ':' + JSON.stringify(prep.args || {}) : null;
            if (dedupKey && turnToolCache.has(dedupKey)) {
              prep.cached = true;
              turnProgress.pendingTool = prevPending;
              return turnToolCache.get(dedupKey);
            }
            let result;
            if (prep.isMcp) {
              if (!mcp) throw new Error('MCP 工具未启用');
              result = await mcp.call(prep.name, prep.args);
            } else {
              // 交出去的是 `toolCtx`（工具面向：白名单 + 冻结），**不是** `ctx`（内核那个）。
              // 内置工具与 Pack / config.tools 工具走同一入口，因此在这一行之后没有任何工具
              // 能碰到内核的 permission / provider / io（审计 M-1 §2.1 第 4 条）。
              result = await dispatch(prep.name, prep.args, toolCtx);
            }
            invalidateReadCache(prep); // 有副作用 → 作废本回合只读缓存（写后再读必须看到新内容）
            if (dedupKey) turnToolCache.set(dedupKey, result);
            return result;
          } catch (/** @type {any} */ err) {
            // 失败也可能已产生副作用（半写入/部分执行）→ 同样作废缓存
            invalidateReadCache(prep);
            return JSON.stringify({ ok: false, error: String(err?.message || err) });
          } finally {
            currentPack = prevPack; // 还原（并行只读批次下 finally 保证不乱序）
            turnProgress.pendingTool = prevPending;
          }
        }

        // 收尾：渲染结果 → todo 更新 → PostToolUse 钩子 → 回填消息（顺序与串行一致）
        // v0.7.0 §1.4：审计写改为异步（工具执行路径），收尾顺序用 await 保持原序。
        async function finishTool(/** @type {any} */ prep, /** @type {any} */ result, /** @type {any} */ t0) {
          const ms = Date.now() - t0;
          toolMsTotal += ms;
          // v0.6.13（A）：**只有"成功且不重复"的工具结果才算进展**。
          // 真机现场（610 次工具调用、4+ 小时零交付）里大量是**完全相同**的重复调用
          // （`skill {}` 155 次、同一个 `git clone` 43 次…）与失败调用——若把它们也算进展，
          // 看门狗永远不会响，"工具在跑但什么都没做成"就永远抓不住。
          turnProgress.toolExecuted += 1;
          const sig = `${prep.name}|${JSON.stringify(prep.args || {})}`;
          const repeatedBefore = turnSigCounts.get(sig) || 0;
          turnSigCounts.set(sig, repeatedBefore + 1);
          let toolOk = true;
          if (typeof result === 'string') {
            // 顶层 ok 解析（与下方审计/账本的 rObj 判定同款）：字符串是合法 JSON 且带顶层 ok 时看顶层，
            // 正文里出现 `"ok": false` 只是文本、不是失败信号（审计报告A H-1）。
            let rObj = null;
            try { rObj = JSON.parse(result); } catch { rObj = null; }
            toolOk = rObj ? rObj.ok !== false : !result.includes('"ok": false');
          } else if (result && typeof result === 'object') {
            toolOk = result.ok !== false;
          }
          if (toolOk && repeatedBefore === 0) markProgress(`工具 ${prep.name} 返回`);
          else if (toolOk) { turnProgress.unproductive += 1; turnProgress.repeatedCalls = (turnProgress.repeatedCalls || 0) + 1; }
          else turnProgress.unproductive += 1;
          // v0.6.28（M-10）：有进展的工具轮复位空轮计数（失败/重复调用不算进展，与看门狗同判据）。
          if (toolOk && repeatedBefore === 0) emptyRounds = 0;
          emitEvent('tool.end', { callId: prep.tc?.id ?? null, name: String(prep.name || ''), ok: toolOk, ms, cached: Boolean(prep.cached) });
          // 省钱 B3：逐工具调用/耗时累加（费用二级分账的 byTool 维度）
          const ts = toolStats.get(prep.name) || { calls: 0, ms: 0 };
          ts.calls += 1;
          ts.ms += ms;
          toolStats.set(prep.name, ts);
          io.renderTool(prep.name, prep.args, result, ms);
          // v0.3.1 P1-2 修复：write/edit 成功落盘的路径记入交付物（CLI/REPL 续跑检查点用）
          if ((prep.name === 'write' || prep.name === 'edit') && prep.args?.path && result && result.ok !== false) {
            const p = String(prep.args.path);
            if (p && !deliverables.includes(p)) deliverables.push(p);
          }
          if (prep.name === 'todo' && result?.todos) io.renderTodo(result.todos);
          hooks.post(prep.name, prep.args, typeof result === 'string' ? { output: result } : result).catch(() => {});
          // 审计（P3-5）：执行结果摘要（含退出码/超时/输出大小）
          if (cfg.audit !== false) {
            let rObj = result;
            if (typeof result === 'string') {
              try {
                rObj = JSON.parse(result);
              } catch {
                rObj = null;
              }
            }
            await writeAuditAsync({
              at: Date.now(),
              session: sessionRef?.name ?? null,
              model: modelName,
              tool: prep.name,
              args: redactSecrets(JSON.stringify(prep.args ?? {})).slice(0, 2000),
              denied: false,
              ok: rObj ? rObj.ok !== false : !String(result ?? '').includes('"ok": false'),
              exitCode: rObj?.exitCode ?? null,
              timedOut: Boolean(rObj?.timedOut),
              durationMs: ms,
              outputBytes: Buffer.byteLength(typeof result === 'string' ? result : JSON.stringify(result ?? {}), 'utf8'),
            });
          }
          // v0.6.0 C1：工具结果事件（只记指纹/大小/成败/耗时，不记正文——正文可能很长且含敏感内容）
          {
            let rObj2 = result;
            if (typeof result === 'string') {
              try { rObj2 = JSON.parse(result); } catch { rObj2 = null; }
            }
            turnLedger.toolResult({
              callId: prep.tc?.id ?? null,
              name: prep.name,
              ok: rObj2 ? rObj2.ok !== false : !String(result ?? '').includes('"ok": false'),
              exitCode: rObj2?.exitCode ?? null,
              ms,
              result,
              error: rObj2?.error ?? null,
            });
          }
          // 序列化（字符串原样 / 对象紧凑 JSON）单源在 tools-flow.js：**先序列化、再问约束**，
          // 与抽取前的求值顺序一字不差（原来这两步就是这个先后）。
          const text = serializeToolResult(result); // 紧凑 JSON（评估 B3）：嵌套结果省 10-20% 回填 token，且下轮按 prompt 重复计费
          // v0.5.0 A3 ②：领域约束（PostToolUse）——completeness 缺项时**拒绝该工具结果**，
          // 让模型必须继续采集而不是把「未提及」当作已完成（「缺项绝不编造」从提示词升级为内核强制）。
          const pv = checkPostTool(constraints, prep.name, typeof result === 'string' ? safeParse(result) : result);
          if (pv?.rejected) await auditConstraint(pv.event);
          // 回填正文（复用前缀 / 约束拒绝文案 / 按窗口截断）单源在 tools-flow.js 的 toolResultMessage()
          // v0.6.29（H-02）：不在这里直接 push——先按 `tool_calls` 原序入队，整批结束后统一回填。
          pendingToolMessages.push({
            idx: prep.idx,
            msg: {
              role: 'tool',
              tool_call_id: prep.tc.id,
              content: toolResultMessage(text, { cached: prep.cached, cap: toolResultCap, post: pv }),
            },
          });
        }

        // 拒绝项（参数解析失败/钩子阻止/预设白名单/权限拒绝/领域约束）同样按原序入队。
        // 它们没有执行、没有耗时/账本结果，只回填一条 tool 消息——顺序必须与成功项一致。
        function emitDeniedToolEvents(/** @type {any} */ prep) {
          // 拒绝项没有执行/耗时，但同样是「一次工具调用」：补 start/end 让时间线成对。
          emitEvent('tool.start', { callId: prep.tc?.id ?? null, name: String(prep.name || ''), denied: true });
          emitEvent('tool.end', { callId: prep.tc?.id ?? null, name: String(prep.name || ''), ok: false, denied: true, ms: 0 });
        }

        function finishDenied(/** @type {any} */ prep) {
          pendingToolMessages.push({
            idx: prep.idx,
            msg: { role: 'tool', tool_call_id: prep.tc.id, content: prep.denied },
          });
        }

        let i = 0;
        while (i < res.toolCalls.length) {
          // v0.6.5（审计 BUG-025）：工具执行期间用户按了 Ctrl+C → 立刻停止，不再执行后续批次
          // （此前没有任何检查点，长工具序列会把中断信号拖到整串跑完）
          if (aborted) {
            // v0.6.29（H-02）：已执行批次的结果先按原序落盘，再由 finishTurn 补齐未执行项；
            // 否则中断会把"已经跑完的工具"变成"未执行"占位，账实不符。
            flushToolMessages();
            finishTurn();
            return {
              text: null, reasoning: '', usage, steps, finish, truncated: false, aborted: true,
              note: '已按 Ctrl+C 中断（工具执行期间收到中断信号），本回合未再发出请求。',
              durationMs: Date.now() - startedAt, perf: perf(),
            };
          }
          // 收集批次：连续且可并行的只读工具成批；首个非并行项（写入类/被拒/MCP）结束批次
          const batch = []; // {prep, batchable}
          while (i < res.toolCalls.length) {
            const tc = res.toolCalls[i];
            const prep = /** @type {any} */ (await prepTool(tc));
            prep.idx = i; // v0.6.29（H-02）：记录在 res.toolCalls 中的原始序号，回填时按它排序
            const name = tc.function?.name || '';
            let batchable = canBatch && !prep.denied && !prep.isMcp && READONLY_BATCH.has(name);
            if (!batchable && canBatch && !prep.denied && name === 'task' && prep.args?.readOnly === true && !subagentIsLocal) batchable = true;
            batch.push({ prep, batchable });
            i += 1;
            if (!batchable) break;
          }
          const firstNon = batch.findIndex((b) => !b.batchable);
          const prefix = firstNon === -1 ? batch : batch.slice(0, firstNon); // 审计 B11：非并行项前的前导只读子批仍可并行
          const allBatchable = prefix.length > 1 && prefix.every((b) => b.batchable);
          if (allBatchable && prefix.length === batch.length) {
            // 纯只读批次：并行执行（顺序收集结果，UI 事件顺序不变）；per-tool 计时（审计 B3）
            // allSettled：单个兄弟工具即使拒绝也绝不整体丢弃其余并行结果（审计报告1 S-2/H-2）。
            await runToolBatch(batch, runTool, finishTool);
          } else if (allBatchable && prefix.length > 1) {
            // 前导只读子批并行 + 其余串行
            await runToolBatch(prefix, runTool, finishTool);
            for (const b of batch.slice(prefix.length)) {
              if (b.prep.denied != null) {
                emitDeniedToolEvents(b.prep);
                finishDenied(b.prep);
                continue;
              }
              const t0 = Date.now();
              await finishTool(b.prep, await runTool(b.prep), t0);
            }
          } else {
            for (const b of batch) {
              if (b.prep.denied != null) { // 拒绝/失败成员：只入队，不执行
                emitDeniedToolEvents(b.prep);
                finishDenied(b.prep);
                continue;
              }
              const t0 = Date.now();
              await finishTool(b.prep, await runTool(b.prep), t0);
            }
          }
        }
        // v0.6.29（H-02）：整批结束后按 `tool_calls` 原序一次性回填，保证
        // assistant.tool_calls 与 tool 消息逐项对齐（拒绝项不再抢在成功项前面）。
        flushToolMessages();
        // v0.2.8 步数预留收尾（对齐 DSH）：仅「最后一轮」的末步追加收尾指令，
        // 让模型在末轮输出总结；中间轮不注入（交给自动续跑继续干活，而非提前收尾中断）。
        if (steps === stepLimit - 1 && round === maxRounds - 1) {
          messages.push({
            role: 'user',
            content:
              '（系统提示）已达到工具调用步数上限（下一步是最后一步），请停止调用工具，直接输出最终总结：' +
              '① 已完成的工作；② 已落盘的交付物（文件路径）；③ **尚未完成的部分**；④ 下一步建议。不要声称任务已全部完成。',
          });
        }
      } else {
        io.endTurn();
        // 最终纯文本回复回填消息历史（会话持久化与多轮上下文依赖它）；
        // 空文本不回填，避免个别 API 对 assistant 空 content 报错
        let outputNote = /** @type {any} */ (null);
        let finalText = res.text || '';
        if (res.text) {
          // v0.5.0 A3 ③：输出前领域约束必须在**回填历史之前**应用——
          // 否则被拦下的违规措辞会留在会话里，下一轮又被当作既成事实喂回模型。
          const ap = await applyOutputConstraints(res.text, { messages, provider, activeModel, temperature, maxOutput: turnMaxOutput, usage, signal: currentAc?.signal });
          finalText = ap.text;
          outputNote = ap.note;
          messages.push({ role: 'assistant', content: finalText });
        }
        // 输出被长度上限截断（DeepSeek 推理吃满 maxOutput 时正文为空）：让模型从断点续写，绝不静默结束。
        // 空轮护栏（评估 4.2-2）：每轮空输出都是全额 completion 计费（pro 32k 闲时 ≈ ¥0.43/轮），
        // 上限从 12 收紧到 3（cfg.maxEmptyRounds 可调），超限直接终止并明确提示。
        const maxEmptyRounds = Math.max(1, Number(cfg.maxEmptyRounds) || 3);
        if (res.finish === 'length') {
          emptyRounds += 1;
          if (emptyRounds >= maxEmptyRounds) {
            finishTurn();
            markOutcome('capped', { truncated: true }); // 截断续写也是「预算用尽」：账本/返回值/事件流三口径必须一致（审计报告1 S-1/H-2）
            return {
              text: res.text || null,
              reasoning: res.reasoning || '',
              usage,
              steps,
              finish,
              truncated: true,
              aborted: false,
              note: `模型连续 ${maxEmptyRounds} 轮输出被截断，已停止续写——请换用更长输出的模型或拆分任务（maxEmptyRounds 可调）。`,
              durationMs: Date.now() - startedAt,
              perf: perf(),
            };
          }
          messages.push({
            role: 'user',
            content: '（系统提示）你的上一条输出因达到长度上限被截断。请直接继续未完成的部分：不要重复已写内容，从断点接着完成。',
          });
          continue;
        }
        if (!res.text) {
          // 静默空输出（无工具无正文）：同样回填续写提示，避免界面"没动静"（审计 Q1：与截断续写统一护栏）
          emptyRounds += 1;
          if (emptyRounds >= maxEmptyRounds) {
            markOutcome('done');
            return {
              text: null,
              reasoning: res.reasoning || '',
              usage,
              steps,
              finish,
              truncated: false,
              aborted: false,
              upstreamTruncated,
              note: '模型本轮没有输出正文。',
              durationMs: Date.now() - startedAt,
              perf: perf(),
            };
          }
          messages.push({
            role: 'user',
            content: '（系统提示）你刚才没有输出任何正文就结束了。请继续完成用户的任务，给出实际内容。',
          });
          continue;
        }
        // v0.6.3 自愈：只读档下 write/edit/bash 不可见，域内任务只会收到一段
        // "我做不到/需要你提供…"的文字，而**根本不会进第二轮**——原释放条件
        // （模型文字里出现写意图）因此永远等不到。这里补一条与词表无关的兜底。
        if (readOnlyPhase && !readOnlyHealed && looksLikeUnmetIntent(finalText)) {
          readOnlyHealed = true;
          readOnlyPhase = false;
          try {
            io.print(style('⚠ 上一轮处于只读档、未暴露写入类工具；已放开工具集并重试一次', C.dim));
          } catch {}
          messages.push({
            role: 'user',
            content:
              '（系统提示）你上一轮可能因为没有可用的写入/执行工具而未能完成任务。' +
              '现在工具集已放开：如果用户的要求需要写文件或执行命令，**请直接调用相应工具去做**，不要只描述计划或让用户自己完成。',
          });
          continue;
        }
        // 接线点②（v0.6.40）：没有工具调用、本要收尾——刚插话就继续下一步（本轮不结束）。
        const steeredNow = drainSteeringInto(steering, messages, io);
        if (shouldContinueAfterModel({ steer: steeredNow, aborted, stalled: noProgressFired })) continue;
        markOutcome(finish === 'length' ? 'capped' : 'done', { capHit: false, truncated: finish === 'length' });
        return {
          text: finalText,
          reasoning: res.reasoning || '',
          usage,
          steps,
          finish,
          truncated: outcome.truncated,
          aborted: false,
          upstreamTruncated,
          note: outputNote || undefined,
          durationMs: Date.now() - startedAt,
          perf: perf(),
        };
      }
    }
    // v0.3.1 自动续跑（长程执行）：还有剩余轮次且未中断 → 注入进度摘要直接续跑，不落收尾总结
    if (round < maxRounds - 1 && !aborted) {
      // 每轮结束：回调本轮增量 usage（含缓存命中拆分），供调用方逐轮入账。activeModel 为本轮实际模型
      // （护栏降级/子代理都据此正确归属——P2-5 模型名一致性 + P1-5 子代理费用入账）。
      try {
        onUsage?.(activeModel, {
          prompt_tokens: usage.prompt_tokens - roundUsageStart.prompt_tokens,
          completion_tokens: usage.completion_tokens - roundUsageStart.completion_tokens,
          prompt_cache_hit_tokens: (usage.prompt_cache_hit_tokens || 0) - roundUsageStart.prompt_cache_hit_tokens,
          prompt_cache_miss_tokens: (usage.prompt_cache_miss_tokens || 0) - roundUsageStart.prompt_cache_miss_tokens,
        });
      } catch {}
      const art = deliverables.length ? '已交付文件：' + deliverables.join('、') + '。' : '';
      // v0.6.2（用户实测：长任务「步数受限未产出交付物」）：续跑前必须明确要求**落盘**。
      // 原因：兜底总结是无工具请求（tools: []），预算一旦用尽就再也写不了文件——
      // 只留在对话里的结论等于没有交付物。所以在还有工具的轮次里就得把结论写进文件。
      // 同时告知剩余轮次，让模型自己按预算收口，而不是一路做「未完成」直到被硬停。
      const roundsLeft = maxRounds - round - 1;
      messages.push({
        role: 'user',
        content:
          `（系统提示）已连续执行 ${stepLimit} 步工具操作，任务尚未完成，请继续完成剩余工作。${art}` +
          `还剩 ${roundsLeft} 轮（每轮 ${stepLimit} 步）预算：请**优先把已完成的结论写入交付物文件**` +
          `（只留在对话里的内容不算交付物），再做未完成的部分。先核对已完成部分（勿重复）。`,
      });
      io.print(style(`♻ 步数上限，自动续跑第 ${round + 2} 轮…（还剩 ${roundsLeft} 轮）`, C.dim));
      continue;
    }
    io.endTurn();
    // 步数上限：清掉未执行的 tool_calls，避免下一轮/恢复后 API 400
    finishTurn();
    // v0.6.2（用户实测：「步数受限未能产出交付物，需要继续追问方能继续下一步」）：
    // 预算用尽必须**明确告诉用户**发生了什么、以及怎么继续。此前这里一行都不打印，
    // 用户只看到一段总结，很容易误判为「任务已完成」，只能自己追问。
    try {
      io.print(style(
        `⚠ 步数预算已用尽（${maxRounds} 轮 × ${stepLimit} 步，本轮实际执行 ${steps} 步），任务可能尚未完成。\n` +
        // v0.6.2：这里**不能**再写「已保存检查点」——检查点由调用方在 runTurn 返回**之后**
        // 才写（cli/web/repl 各自落盘），此刻一个字都还没写；写失败时的提示也在那边。
        // 一个未经核实的断言会让用户以为断点已经安全，这正是 B-WS-1/2 那类「看起来有、其实没有」。
        `  检查点会在本回合收尾时保存（保存失败会另行提示），继续方式：\n` +
        `   · REPL / WebUI / 桌面版：直接发送「继续」即可（会自动注入断点续跑提示）\n` +
        `   · 命令行：加 --continue（如 mingdao -c "接着往下做"）\n` +
        `   · 想让单次跑得更久：调高 config.maxRounds（当前 ${maxRounds}，每轮 ${stepLimit} 步），或改用更大预算的预设`,
        C.yellow
      ));
    } catch {}
    // v0.2.8 兜底总结（对齐 DSH）：跑满步数/末轮无正文且未中断时，补一次 no-tool 小输出请求，
    // 让任务以「总结文字 + 交付物清单」收尾，而非静默结束；失败则回退旧行为（text:null）。
    // v0.4.1 修复：输入轻量化——此前用 trimMessages(messages, budget) 全量历史，本地 q8 量化模型
    // （prefill ~165 tok/s）≈98k token 的 prefill 逼近/超过 600s 首 token 超时 → 总结请求失败被吞 →
    // 表现为「输出截断/子代理无反馈」。改用 system + 交付物清单 + 提示（几 k token），慢 prefill 也能秒出总结。
    // v0.6.13（A）：看门狗已判定"整回合无进展"时**不再发兜底总结请求**——
    // 那正是又一次要等几分钟到几十分钟的请求，而 0 工具调用/0 增量的事实不会因此改变。
    if (!aborted && !noProgressFired && messages.length) {
      try {
        const sys = messages.find((/** @type {any} */ m) => m.role === 'system');
        const wrapReq = [
          ...(sys ? [sys] : []),
          ...(deliverables.length
            ? [{ role: 'user', content: '已交付文件：\n' + deliverables.map((/** @type {string} */ f) => `- ${f}`).join('\n') }]
            : []),
          // v0.6.2：原话是「任务已执行完毕」——在**步数上限**这条路径上那是假话，
          // 模型据此汇报「已完成」，用户就以为交付完成了。改为如实说明是被迫中断。
          {
            role: 'user',
            content:
              '（系统提示）步数预算已用尽，本轮**被迫中断，任务可能尚未完成**（不要声称已全部完成）。' +
              '请如实总结：① 已完成的工作；② 已落盘的交付物（文件路径）；③ **尚未完成的部分**；④ 下一步该做什么（供继续时使用）。',
          },
        ];
        currentAc = new AbortController();
        lastRequestStartAt = Date.now();
        // v0.4.6 P1 修复：进入兜底总结前本回合已多次 io.endTurn()（步数上限分支），TUI 的 renderer
        // 已被置空，而 onDelta → io.writeText 只做 `renderer?.push(...)`——总结文本被静默丢弃，
        // 跑满 24 步的长任务（审计/重构/调研）在终端里只看到一屏工具调用、没有最终答复。
        // 重新 beginTurn() 开一个渲染段（web-io 的 beginTurn 是空实现，不受影响）。
        io.beginTurn();
        const wrapRes = await provider.chat({
          model: activeModel,
          messages: wrapReq,
          tools: [],
          temperature,
          maxTokens: Math.min(turnMaxOutput, 2048),
          reasoningEffort: modelPreset(activeModel)?.supportsReasoning ? 'low' : undefined,
          signal: currentAc.signal,
          onDelta(/** @type {any} */ d) {
            if (d.text) io.writeText(d.text);
          },
        });
        io.endTurn(); // 收尾：flush 流式渲染段（与正常 turn 一致）
        if (wrapRes.usage) {
          usage.prompt_tokens += wrapRes.usage.prompt_tokens || 0;
          usage.completion_tokens += wrapRes.usage.completion_tokens || 0;
        }
        // v0.5.0 A3 ③：兜底总结同样过一遍输出约束
        const wrapApplied = wrapRes.text
          ? await applyOutputConstraints(wrapRes.text, { messages, provider, activeModel, temperature, maxOutput: turnMaxOutput, usage, signal: currentAc?.signal })
          : { text: null, note: null };
        if (wrapApplied.text) messages.push({ role: 'assistant', content: wrapApplied.text });
        // capHit：本轮因步数上限被迫收尾（任务可能未真正完成）→ 供上层落检查点续跑
        markOutcome('capped', { capHit: true });
        return { text: wrapApplied.text || null, reasoning: wrapRes.reasoning || '', usage, steps, finish, truncated: false, aborted: false, capHit: outcome.capHit, upstreamTruncated, note: wrapApplied.note || undefined, durationMs: Date.now() - startedAt, perf: perf() };
      } catch (/** @type {any} */ err) {
        // v0.4.1：不再静默吞异常——总结失败原因透出，便于定位（此前用户只见「输出截断/无反馈」）
        try { io.print(style(`⚠ 兜底总结失败：${String(err?.message || err)}`, C.yellow)); } catch {}
      }
    }
    // v0.6.13（A）：看门狗触发时以 'stalled' 收尾（不是 capped：不是预算用尽，是"零进展"）
    markOutcome(noProgressFired ? 'stalled' : 'capped', { capHit: !noProgressFired, truncated: !noProgressFired });
    return {
      text: null, reasoning: '', usage, steps, finish, truncated: outcome.truncated, aborted: false,
      capHit: outcome.capHit, upstreamTruncated, ...(noProgressFired ? { stalled: true, note: turnProgress.note || undefined } : {}),
      durationMs: Date.now() - startedAt, perf: perf(),
    };
    }
    // 理论不可达（for 循环末轮必 return）；给 tsc 一个兜底，保证 runTurn 恒有返回值
    markOutcome(noProgressFired ? 'stalled' : 'capped', { capHit: !noProgressFired, truncated: !noProgressFired });
    return {
      text: null, reasoning: '', usage, steps, finish, truncated: outcome.truncated, aborted: false,
      capHit: outcome.capHit, upstreamTruncated, ...(noProgressFired ? { stalled: true, note: turnProgress.note || undefined } : {}),
      durationMs: Date.now() - startedAt, perf: perf(),
    };
    } catch (/** @type {any} */ err) {
      // 审计 P2-6（v0.4.2）：工具管线异常（hooks.pre / permission.check / prepTool 等）沿大 try 上抛时，
      // assistant tool_calls 已 push 进 messages 却无对应 tool 回填——会话恢复后 API 因孤儿 tool_call_id 400。
      // v0.6.29（C-01）：先落盘已执行批次的结果（H-02 队列），再把缺失项补齐成"未执行"占位再抛；
      // 只删 assistant.tool_calls 会让**已经执行**的 tool 结果失去配对，同样 400。
      flushToolMessages();
      finishTurn();
      markOutcome('error'); // 崩溃回合必须被账本记"异常"，不得记"正常完成"（审计报告1 S-1/H-2）
      throw err;
    } finally {
      // v0.6.29（C-01）：最后一道保险——所有出口（正常/中断/预算/异常）都做一次配对补齐。
      // 显式调用点仍保留：它们让"返回前历史已经完整"，这里兜住任何新增的 early return。
      flushToolMessages();
      finishTurn();
      currentAc = null;
      currentUsage = null; // 回合结束：避免 runTurn 之外调用的 spawnTask 写入陈旧累加器
      // v0.6.13（A）：看门狗计时器必须随回合结束清掉（每回合一个，长驻 WebUI 里不能泄漏）；
      // 同时把"本回合 0 次工具调用"如实说出来——否则端点不返回 tool_calls 时，界面看起来
      // 一切正常（有正文、ok:true），实际一次工具都没调，"看起来在工作、其实什么都没做"。
      if (noProgressTimer) clearTimeout(noProgressTimer);
      turnProgress.pendingTool = null;
      currentTurnProgress = null;
      try {
        const notice = ensureZeroToolCallNotice();
        if (notice && !turnProgress.zeroToolCallsPrinted) {
          turnProgress.zeroToolCallsPrinted = true;
          io.print(style(notice, C.yellow));
        }
      } catch {}
      // v0.6.0 C1：回合收尾事件（状态/步数/费用）。
      // 费用按**发起时刻**计价（lastRequestStartAt）——与 recordUsage 同款口径，跨 12:00/18:00
      // 边界的请求才不会被错记一档。estimateCost 对无价模型返回 null，于是 priced:false 会与
      // 金额一起落盘：账本里「无法估算」是一个显式事实，而不是被读成 ¥0.0000（v0.4.5 的诚实原则）。
      if (turnLedger) {
        try {
          const costDate = lastRequestStartAt ? new Date(lastRequestStartAt) : new Date();
          // v0.6.3（BUG-024）：计价必须用**本回合实际使用**的模型。
          // 此前用 modelName（用户配置的模型），而成本护栏降级后请求实际发给 activeModel——
          // 两者单价不同（flash 便宜数倍），于是账本与日费用护栏系统性偏移，
          // 而"降级省钱"恰恰是靠这里体现的。
          const yuan = estimateCost(activeModel, usage.prompt_tokens, usage.completion_tokens, cacheSplit(usage), costDate);
          // v0.6.7（H-4）：用量未知时哪怕 0/0 也算出一个真 0（estimateCost(0,0)===0），
          // 那会把"没记账"伪装成"没花钱"。未知一律 priced:false + yuan:null。
          const usageKnown = !outcome.usageUnknown && (usage.prompt_tokens > 0 || usage.completion_tokens > 0 || steps === 0);
          const priced = usageKnown && typeof yuan === 'number' && Number.isFinite(yuan);
          turnLedger.cost({
            // BUG-024：归属同样要用实际计费的模型（run.start 里已记过"用户请求的模型"，
            // 这里再写 modelName 会让"花了钱的那次调用"归属到一个没被调用的模型）
            model: activeModel,
            usage,
            yuan: priced ? yuan : null,
            priced,
            // v0.6.7（H-4）：把"用量未知"作为显式事实落账，事后可区分「没花钱」与「没记账」
            ...(usageKnown ? {} : { usageUnknown: true }),
            pricing: { requestStartAt: lastRequestStartAt, peak: isPeakHour(costDate) },
          });
          turnLedger.runEnd({
            ms: Date.now() - startedAt,
            // status 是「这次运行怎么结束的」，与模型层的 finish_reason（stop/tool_calls/length）
            // 不是一回事：前者给人看账本，后者记在 model.round 里。混用会让「status=stop」这种
            // 记录无法回答「这次到底完成了没有」。
            // v0.6.7（P2-1）：一律取自 outcome —— 与返回值**同一个来源**，不可能再分裂
            status: outcome.status,
            steps,
            rounds: round + 1,
            yuanTotal: priced ? yuan : null,
            priced,
            capHit: outcome.capHit,
            truncated: outcome.truncated,
            aborted: outcome.aborted,
            // v0.6.7（P3-2）：上游提前关流此前只置位、不落账（"检测到了、传递断了"）
            upstreamTruncated: Boolean(upstreamTruncated || outcome.upstreamTruncated),
          });
          // v0.6.2（B-WS-1/2）：记账降级必须让用户看见。
          // 此前写账本失败只把 alive 置 false，用户拿到一段「正常」总结却不知道这次运行
          // **没有任何账本**——而「被静默截断的合规账本比不记账更糟」正是账本自己的纪律。
          // 仍然不抛异常（记账失败绝不能影响正常执行），但必须留下可见痕迹与补救方式。
          if (turnLedger.degraded) {
            io.print(
              style(
                `⚠ 本回合执行账本未能完整写入：${turnLedger.lastError ?? '未知原因'}（失败 ${turnLedger.failures} 次）。\n` +
                  `  这意味着**这次运行在 ~/.mingdao/ledger 里可能不完整**，不能作为完整审计依据。\n` +
                  `  常见原因：磁盘写满、目录权限、MINGDAO_HOME 指向不可写位置。可用 mingdao ledger list 核对。`,
                C.yellow
              )
            );
          }
        } catch (err) {
          // 收尾自身失败也不能静默：账本是合规物，用户在意的正是「有没有记全」
          try {
            io.print(style(`⚠ 执行账本收尾失败：${/** @type {any} */ (err)?.message ?? err}`, C.yellow));
          } catch {}
        }
        turnLedger = null;
      }
      offEgressSink();
      offSigint();
    }
  }

  /**
   * 回合包装层（v0.6.18 §3.74）：把「本回合必须让用户看见」的提示统一追加到 done.note。
   *
   * 为什么需要包装：`runTurnInner` 有十几个 return 路径（工具收尾、cap、stalled、aborted…），
   * 逐条补 note 必漏。这里只做两件事：
   *   ① 第一回合发请求前打印「按引擎 n_ctx clamp 预算」的提示（只打一次，避免每回合刷屏）；
   *   ② 回合结束后把 clamp 提示与内存降级重试的**压缩前后数值 / 重试次数 / 最终结果**
   *      追加到 `note`——WebUI 的 done.note、CLI 的收尾说明因此共用同一份口径。
   */
  async function runTurn(/** @type {any} */ messages) {
    turnNotes = [];
    if (budgetClampNotice && !clampNoticeShown) {
      clampNoticeShown = true;
      try { io.print(style(budgetClampNotice, C.yellow)); } catch {}
      turnNotes.push(budgetClampNotice);
    }
    // v0.6.26 §3.91：**每回合重读**端点学习值——同一 agent 连续多回合时，上一回合可能刚学到一个
    // 更低的预算（或成功上调了一个更高的值）；只用 createAgent 时读到的那份会过时。
    // 学习值只在**低于**当前起手预算时接管（配置本来就小 → 用户选择优先）。
    let startBudget = budget;
    turnLearned = learnedStart;
    const freshLearned = endpointLimitFor(endpointBaseUrl);
    if (freshLearned.error) {
      try { io.print(style(`⚠ ${freshLearned.error}`, C.yellow)); } catch {}
    }
    const freshSafe = Math.floor(Number(freshLearned.record?.safeContextBudget) || 0);
    if (freshSafe > 0 && freshSafe < budget) {
      startBudget = freshSafe;
      turnLearned = { ...freshLearned.record, appliedBudget: freshSafe };
    }
    let r = /** @type {any} */ (null);
    // v0.7.0 §1.1：turn 边界（双写旁路；cfg.eventLog=false 时 emitEvent 内部直接 no-op）
    emitEvent('turn.start', { model: modelName, session: sessionRef?.name ?? null, messages: Array.isArray(messages) ? messages.length : 0 });
    try {
      r = await runTurnInner(messages, startBudget);
    } catch (err) {
      closeStep('error');
      emitEvent('turn.end', { status: 'error', error: String(/** @type {any} */ (err)?.message ?? err) });
      throw err;
    } finally {
      turnLearned = null;
      currentTurnBudget = null;
      currentTurnMaxOutput = null;
    }
    // 收尾：最后一个 step 也要有 step.end（事件流里不留下永远不结束的 step），再写 turn.end。
    closeStep(r?.aborted ? 'aborted' : r?.stalled ? 'stalled' : 'completed');
    emitEvent('turn.end', {
      status: r?.stalled ? 'stalled' : r?.aborted ? 'aborted' : r?.capHit ? 'capped' : 'done',
      steps: Number(r?.perf?.steps) || 0,
      usage: r?.usage ?? null,
      aborted: Boolean(r?.aborted),
      capHit: Boolean(r?.capHit),
      truncated: Boolean(r?.truncated),
    });
    // v0.6.26 §3.91（端点级学习·上调）：**干净成功**（无内存压缩、无中断/无进展/截断）才计数，
    // 连续 3 次把学习值 +25%（上限 = 用户配置的预算）。上调后若再撞内存墙，
    // 两级压缩仍失败会把它重新学下来——降级与恢复都基于真实结果。
    if (!isSubagent && r && r.text && !r.aborted && !r.stalled && !r.truncated && !lastMemoryRecovery) {
      try {
        const success = noteEndpointSuccess(currentRequestBaseUrl || endpointBaseUrl, {
          budget: startBudget,
          ceiling: configuredBudget,
        });
        if (success?.raised && success.record) {
          const msg =
            `📈 该端点已连续 ${ENDPOINT_UPGRADE_SUCCESS_STREAK} 次干净成功：内存安全预算上调 ` +
            `${fmtTok(success.previous?.safeContextBudget)} → ${fmtTok(success.record.safeContextBudget)}（+25%），下轮起手使用`;
          try { io.print(style(msg, C.green)); } catch {}
          turnNotes.push(msg);
        }
      } catch {}
    }
    currentRequestBaseUrl = '';
    const notes = turnNotes.filter(Boolean);
    if (lastMemoryRecovery && r) {
      const rec = lastMemoryRecovery;
      const final = r.aborted ? '重试后被中断' : r.stalled ? '重试后无进展中止' : r.text ? '重试后成功' : '重试后仍无正文';
      const chain =
        Array.isArray(rec.history) && rec.history.length
          ? rec.history.map((/** @type {any} */ h) => fmtTok(h.fromBudget)).concat(fmtTok(rec.toBudget)).join(' → ')
          : `${fmtTok(rec.fromBudget)} → ${fmtTok(rec.toBudget)}`;
      const outChain =
        Array.isArray(rec.history) && rec.history.length
          ? rec.history.map((/** @type {any} */ h) => fmtTok(h.fromMaxOutput)).concat(fmtTok(rec.toMaxOutput)).join(' → ')
          : `${fmtTok(rec.fromMaxOutput)} → ${fmtTok(rec.toMaxOutput)}`;
      notes.push(
        `↩ 内存降级重试（${Number(rec.attempts) || 0} 次，最多 ${MAX_MEMORY_RETRIES} 次，已压缩上下文）：预算 ${chain}、` +
          `输出上限 ${outChain}；${final}。`
      );
    }
    if (notes.length && r && typeof r === 'object') {
      r.note = [r.note, ...notes].filter(Boolean).join('\n');
    }
    return r;
  }

  return {
    modelName,
    budget,
    maxOutput,
    temperature,
    runTurn,
    spawnTask: (/** @type {any} */ prompt, /** @type {any} */ opts) => spawnTask(prompt, opts),
    getTodos: () => todos.slice(),
    // v0.6.3（M-1）：凡是"上下文被整体替换"的地方（/compact、/clear、手动重写历史）都要能
    // 让读取去重缓存一起失效，否则模型会被"你已读过"的占位串误导。
    clearReadCache: () => agentReadCache.clear(),
  };
}
