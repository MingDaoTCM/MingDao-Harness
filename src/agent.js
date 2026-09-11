// Agent 核心循环：消息 → 模型（流式）→ PreToolUse 钩子 → 权限引擎 → 工具执行
// → PostToolUse 钩子 → 结果回填 → 循环，直到模型给出纯文本回复。
// 附带：子代理（task 工具）、todo 清单状态、undo 备份仓、Ctrl+C 中断。

import { trimMessages, clampText, messageTokens, approxTokens } from './context.js';
import { compactConversation } from './compact.js';
import { buildToolSchemas, dispatch } from './tools/index.js';
import { modelPreset } from './models.js';
import { resolveModelCaps, safeBudget, EDGE_RATIO } from './model-caps.js';
import { makeTokenCounter } from './tokenizer.js';
import { createHooks } from './hooks.js';
import { createIO, style, C } from './ui.js';
import { subagentModel } from './routing.js';
import { writeAudit } from './audit.js';
import { redactSecrets } from './redact.js';
import { checkCostGuard, costGuardConfig, todayCost } from './cost-guard.js';
import { recordCacheStats, packDailyCost } from './cachestats.js';
import { estimateCost, cacheSplit, isPeakHour } from './pricing.js';
import { resolveProviderConfig, createProvider } from './providers/index.js';
import { compileConstraints, checkPreTool, checkPostTool, checkOutput, blockedOutputText } from './constraints.js';
import { createLedger, newRunId } from './ledger.js';
import { getActivePackContext } from './packs.js';

const MAX_STEPS = 24;
// 子代理步数上限：审计/精读类只读子任务需要读多个文件 + 交叉引用，12 步易在「读不全」时被截断
// （v0.3.0 桌面版审计实测：多个只读子代理报「因达到步数上限停止读取」或「子任务无输出」）。
// 提到与主循环一致（24），只读子任务每步是 read/grep（输入便宜、无输出 token），成本增量可忽略。
const SUBAGENT_MAX_STEPS = 24;

// 只读档工具集（省钱 B1 的「只读阶段」）——模块级单一来源。
// v0.4.6：此前 test/bench 各自维护一份副本，已经漂移（漏了 v0.4.4 加入的 task），
// 导致基准测的不是真实只读档。导出后基准与实现共用同一集合。
export const READONLY_TIER_SET = new Set(['read', 'ls', 'glob', 'grep', 'skill', 'todo', 'git', 'fetch', 'task']);

/**
 * 创建 Agent 循环（调用方只需传 provider/permission/io/modelName/workingDir，其余可选）
 * @param {{ provider: any, permission: any, io: any, modelName: any, workingDir: any,
 *   cfg?: any, undoStore?: any, maxSteps?: number, mcp?: any, onCompact?: any, sessionRef?: any,
 *   onUsage?: (modelName: string, usage: any) => void,
 *   constraints?: any[] }} params
 */
export function createAgent({ provider, permission, io, modelName, workingDir, cfg = {}, undoStore, maxSteps, mcp, onCompact, sessionRef, onUsage, constraints: rawConstraints }) {
  const preset = modelPreset(modelName) || {};
  // v0.3.2 模型自适应：预算按模型上下文窗口推导（留输出余量 + 75% 舒适区），
  // 自定义/本地小模型不再套 128000 默认撑爆窗口；prompt 永不逼近窗口边缘（prefill 不爆炸）。
  const caps = resolveModelCaps(cfg, modelName);
  // safeBudget 恒用：即使用户显式 contextBudget 也套「窗口−输出−余量」上限与 75% 舒适区，
  // 防显式值撑爆窗口（本地模型窗口可能只有 32k/131k，用户却留了默认 128000）。
  const budget = safeBudget(cfg, caps);
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
  const auditConstraint = (/** @type {any} */ ev) => {
    // v0.6.0 C1：账本与 audit 在此**同一处**记录——三个时机（pre/post/output）都汇聚到这里，
    // 新增时机时不需要记得再补一处账本埋点。
    // 只记「哪条约束、什么时机、如何处理」，**不记命中的原文**（否则账本自身成为泄露渠道）。
    if (turnLedger && ev) {
      turnLedger.constraint({ kind: ev.kind, id: ev.id, stage: ev.stage, tool: ev.tool, action: ev.action ?? ev.decision });
    }
    if (cfg.audit === false || !ev) return;
    try {
      writeAudit({ at: Date.now(), session: sessionRef?.name ?? null, model: modelName, tool: null, constraint: ev });
    } catch {}
  };
  const todos = /** @type {any[]} */ ([]);
  // v0.4.6 修复：当前 runTurn 的 usage 累加器引用——spawnTask 定义在 runTurn 之外，
  // 此前子代理的 token 消耗只用于生成汇报文本、从不并入父回合 usage，导致「今日费用」系统性少计
  // （CLI/REPL 每次派子代理都漏计；README 主推的「多方向并行调研」场景漏计最重）。
  // runTurn 开始时指向本轮 usage，finally 清空；runTurn 之外调用 spawnTask 时为 null（安全跳过）。
  let currentUsage = /** @type {any} */ (null);
  // v0.6.0 C1：当前回合的账本写入器（与 currentUsage 同款：runTurn 内赋值、finally 清空）。
  // 账本不可用/被关闭时它是 no-op，**绝不影响主流程**——与 writeAudit 同款容错。
  let turnLedger = /** @type {any} */ (null);
  // v0.5.0 A4：当前正在执行的 Pack 工具所属 Pack（由 runTool 按 `pack__<pack>__` 前缀设置），
  // 供 ctx.llm 写归因记录时标注来源。
  let currentPack = /** @type {any} */ (null);
  // 会话级共享：调用方传入则复用（/model 切换、子代理均共享，undo 不丢失）
  const undo = undoStore || { backups: new Map() };
  const stepLimit = maxSteps || MAX_STEPS;
  // 只读工具集合（子代理只读模式 + 并行批次共用）。v0.3.1 起含 git/fetch（只读、审计常用）
  const READONLY_TOOLS_SET = new Set(['read', 'ls', 'glob', 'grep', 'skill', 'git', 'fetch']);
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
  const WRITE_INTENT_RE = /写|建|创|改|修|删|装|加|添|增|补|换|移|部署|执行|运行|实现|重构|生成|迁移|安装|更新|升级|发布|调整|优化|修复|提交|推送|打包|编译|测试|implement|fix|create|modify|update|delete|deploy|build|make|generate|install|write|refactor|migrate|test|run|commit|push|remove|add|change|patch/i;
  const hasWriteIntent = (/** @type {any} */ text) => WRITE_INTENT_RE.test(String(text || ''));
  // A1（前缀稳定）：剥描述集合按「回合冻结快照」——回合内恒定（至多两态：只读档/全量档），
  // 新使用的工具只在下一回合才进入剥描述集合；回合边界本身就有新 user 消息，schema 变化免费。
  // v0.4.0 Agent Preset：cfg.presetTools 白名单恒生效（在只读档过滤之后收紧——预设只减不增）。
  const presetToolSet = Array.isArray(cfg.presetTools) ? new Set(cfg.presetTools.map(String)) : null;
  const activePresetName = String(cfg.presetName || ''); // 白名单拦截提示用
  const toolsFor = (/** @type {boolean} */ readOnlyPhase, /** @type {Set<string>} */ strippedSet) => {
    let schemas = buildToolSchemas(strippedSet, mcpSchemas());
    if (presetToolSet) {
      schemas = schemas.filter((/** @type {any} */ t) => {
        const n = t?.function?.name;
        if (!n) return true;
        return presetToolSet.has(n) || (n.startsWith('mcp__') && presetToolSet.has(n.slice(5)));
      });
    }
    if (!readOnlyPhase) return schemas;
    return schemas.filter((/** @type {any} */ t) => {
      const n = t?.function?.name;
      if (!n) return true;
      if (READONLY_TIER_SET.has(n) || strippedSet.has(n)) return true;
      if (n.startsWith('mcp__')) return mcp ? mcp.isReadonly(n) : false;
      return false;
    });
  };

  // 子代理：全新上下文 + 同一 Provider/权限（提示带「子任务」标记），独立完成子任务后汇报
  async function spawnTask(/** @type {any} */ prompt, { description = '', readOnly = false } = {}) {
    const subIo = createIO({ quiet: true });
    // 只读子代理（评估 A4：可并行）：只读工具自动放行、写类直接拒绝，无交互询问
    const subPermission = readOnly
      ? { mode: 'readonly-noask', check: (/** @type {any} */ name) => READONLY_TOOLS_SET.has(name) }
      : { check: (/** @type {any} */ name, /** @type {any} */ args) => permission.check(name, args, '（子任务）') };
    // 自动路由：子代理固定走 executor 模型（便宜的执行单元）
    const subModel = subagentModel(cfg, modelName);
    const subAgent = createAgent({
      provider,
      permission: subPermission,
      io: subIo,
      modelName: subModel,
      workingDir,
      cfg: { ...cfg, contextBudget: Math.min(budget, 64000) },
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
    const text =
      res.text ||
      (res.truncated ? '（子任务达到步骤上限，未完成' : '（子任务无输出') +
      (res.note ? '：' + res.note : '') + ')';
    io.print(style(`  ↳ 子任务完成（${ms}ms）`, C.magenta));
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

  function makeCtx() {
    return {
      cwd: workingDir,
      io,
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

  async function runTurn(/** @type {any} */ messages) {
    let steps = 0;
    let finish = null;
    // v0.3.1 自动续跑（长程执行）：跑满 stepLimit 步后不再直接中断，而是注入进度摘要再续跑，
    // 最多 maxRounds 轮（默认 3，可用 cfg.maxRounds 调）；审计/重构等大任务不再「一步中断」。
    const maxRounds = Math.max(1, Number(cfg.maxRounds) || 3);
    let round = 0;
    const usage = /** @type {{ prompt_tokens: number, completion_tokens: number, prompt_cache_hit_tokens?: number, prompt_cache_miss_tokens?: number }} */ ({ prompt_tokens: 0, completion_tokens: 0 });
    currentUsage = usage; // 子代理消耗并入本回合总量（见 spawnTask）
    const startedAt = Date.now();
    // v0.6.0 C1：本回合的执行账本（cfg.ledger=false 可关；写失败整体降级为 no-op）
    turnLedger = createLedger(newRunId(), { enabled: cfg.ledger !== false });
    turnLedger.runStart({
      model: modelName,
      provider: cfg.provider ?? null,
      session: sessionRef?.name ?? null,
      cwd: workingDir,
      permission: cfg.permission ?? permission?.mode ?? null,
      preset: preset?.name ?? cfg.preset ?? null,
      packs: getActivePackContext()?.packs ?? [],
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
    });
    let aborted = false;
    let emptyRounds = 0; // 连续空/截断输出计数（防止无限续写）
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
    if (cfg.schemaTier !== false) {
      const lastUser = [...messages].reverse().find((m) => m?.role === 'user');
      readOnlyPhase = !hasWriteIntent(lastUser?.content);
    } else {
      readOnlyPhase = false;
    }
    // A1：本回合的剥描述冻结快照（会话级 usedToolNames 的副本）——回合内 schema 字节不变
    const turnStrippedSet = new Set(usedToolNames);
    // 整个回合注册一次 SIGINT：思考、工具执行、权限询问期间都能中断
    const offSigint = io.onSigint ? io.onSigint(() => { aborted = true; currentAc?.abort(); }) : () => {};
    const ctx = makeCtx();
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
    auditConstraint(hit.event);
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
          auditConstraint(re.event);
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
  const stripOrphanCalls = () => {
      const last = messages[messages.length - 1];
      if (last?.role === 'assistant' && Array.isArray(last.tool_calls) && last.tool_calls.length) {
        messages[messages.length - 1] = { ...last, tool_calls: undefined };
      }
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
      steps += 1;
      // 自动压缩（P3-1）：预算不足、静默裁剪即将丢弃早期段落时，先用 executor 模型
      // 把被裁段落压成摘要注入，替代「失忆」；失败/不值得时回退普通裁剪。
      if (cfg.autoCompact !== false) {
        try {
          const compacted = await compactConversation({
            messages,
            budget,
            count,
            provider,
            executorModel: subagentModel(cfg, modelName),
            // 可配置触发线：默认远程 80%；本地模型默认 60% 提前压缩——本地推理内存预算有限，
            // 等到 80% 再压时上下文已累积过多、prefill 与内存双高（v0.4.2 本地模型 507 修复）
            triggerRatio: Number(cfg.compactTrigger) > 0 ? cfg.compactTrigger : (caps.isLocal ? 0.6 : undefined),
            force: windowPressure, // v0.3.2：逼近窗口时强制压缩（忽略最小阈值门槛）
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
            try {
              onCompact?.(messages);
            } catch {}
          }
        } catch {}
      }
      const trimmed = trimMessages(messages, budget, count);

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

      // 护栏前置预估（Kimi P2-E）：发送前按本轮最坏成本估算（trimmed prompt × 未命中输入价
      // + maxOutput × 输出价，峰谷按当前时段）；「今日已用 + 最坏成本」超上限时发送前拦截，
      // 而不是等 200K 上下文的贵请求发出后才 block。action='downgrade'（省钱 B4）不在此拦截——
      // 由降级流程接管：切到便宜模型后按 flash 价格重新估算，通常即可放行。
      if (cfg.costGuard) {
        const g = costGuardConfig();
        if (g && Number(g.dailyLimitYuan) > 0 && g.action !== 'downgrade') {
          let promptTokens = 0;
          for (const m of sanitized) promptTokens += messageTokens(m, count);
          const worst = estimateCost(activeModel, promptTokens, maxOutput, null, new Date());
          const used = usedTodayWithInflight(); // 含本回合在途费用（防长回合烧穿）
          if (used == null || worst == null) {
            // P0-4（v0.4.5）：统计不可读 或 无价格数据（最坏成本未知）→ 无法判断，跳过前置拦截
            // （护栏主检查 checkCostGuard 会显式告警「无价格数据」，此处不重复误拦也不静默放行）
          } else if (used + worst >= Number(g.dailyLimitYuan)) {
            stripOrphanCalls();
            return {
              text: null, reasoning: '', usage, steps, finish, truncated: false, aborted: false,
              note: `⛔ 护栏前置拦截：本轮最坏成本 ≈¥${worst.toFixed(4)}，今日已用 ≈¥${used.toFixed(4)}，合计将超过上限 ¥${Number(g.dailyLimitYuan).toFixed(2)}——请求未发出。可调高 config.costGuard.dailyLimitYuan 或改用更小模型。`,
              durationMs: Date.now() - startedAt, perf: perf(),
            };
          }
        }
      }

      // 费用护栏（A2/B4）：每轮开始前按今日实际费用检查；block 暂停本轮；
      // downgrade 自动切换便宜模型继续执行（每回合只切一次，切换即粘滞）
      if (cfg.costGuard) {
        const guard = checkCostGuard(activeModel);
        if (guard) {
          if (guard.blocked) {
            stripOrphanCalls();
            return {
              text: null,
              reasoning: '',
              usage,
              steps,
              finish,
              truncated: false,
              aborted: false,
              note: guard.message,
              durationMs: Date.now() - startedAt,
              perf: perf(),
            };
          }
          if (guard.downgrade && !downgraded) {
            if (guard.downgradeModel !== activeModel) {
              // MiniMax P0：降级目标零校验会崩溃——必须与当前模型同服务商且已有 Key，
              // 否则 provider.chat 必然 400；校验失败按 block 处理并给修复指引。
              const curPc = resolveProviderConfig(cfg, activeModel);
              const dgPc = resolveProviderConfig(cfg, guard.downgradeModel);
              // Key 归属服务商（provider 级），同服务商即天然共享同一 Key，无需再查 apiKey
              if (dgPc && dgPc.name === curPc.name) {
                activeModel = guard.downgradeModel;
                downgraded = true;
                io.print(style(guard.message, C.yellow));
              } else {
                stripOrphanCalls();
                return {
                  text: null, reasoning: '', usage, steps, finish, truncated: false, aborted: false,
                  note: `费用护栏想降级到 ${guard.downgradeModel}，但它与当前服务商不一致或缺少 API Key——已暂停执行。请把 config.costGuard.downgradeModel 改为与当前模型同服务商（当前：${curPc.name}）的模型名，或调高 dailyLimitYuan。`,
                  durationMs: Date.now() - startedAt, perf: perf(),
                };
              }
            } else {
              // 已经是降级目标模型：无法再降，按 block 处理
              stripOrphanCalls();
              return {
                text: null, reasoning: '', usage, steps, finish, truncated: false, aborted: false,
                note: `今日费用已达上限（实际 ¥${String((todayCost() ?? 0).toFixed(4))}），且已在最便宜模型上执行，已暂停——调整 config.costGuard 或明天自动恢复。`,
                durationMs: Date.now() - startedAt, perf: perf(),
              };
            }
          } else if (!guard.downgrade) {
            io.print(style(guard.message, C.yellow));
          }
        }
      }

      const ac = new AbortController();
      currentAc = ac;
      io.beginTurn();
      io.startSpinner('正在思考…');

      let res;
      // 审计（tsc 扩面发现）：llmT0 此前在 try 内声明、catch 内引用——chat 抛错时
      // catch 自身 ReferenceError，掩盖原始错误且计时丢失；提到 try 外声明。
      const llmT0 = Date.now();
      lastRequestStartAt = llmT0;
      try {
        res = await provider.chat({
          model: activeModel,
          messages: sanitized,
          tools: toolsFor(readOnlyPhase, turnStrippedSet),
          temperature,
          maxTokens: maxOutput,
          // MiniMax P0：仅当 activeModel 声明支持 reasoning 才发送（否则 400 终止回合）；'off' 显式禁用例外
          reasoningEffort: modelPreset(activeModel)?.supportsReasoning || reasoningEffort === 'off' ? reasoningEffort : undefined,
          signal: ac.signal,
          onDelta(/** @type {any} */ d) {
            io.stopSpinner();
            if (firstTokenAt == null) firstTokenAt = Date.now(); // 首个增量即首 token
            if (d.text) io.writeText(d.text);
            if (d.reasoning) {
              reasoningTokens += approxTokens(d.reasoning); // 省钱 B3：推理 token 估算（分账维度）
              io.writeReasoning(d.reasoning);
            }
          },
        });
        llmMsTotal += Date.now() - llmT0;
      } catch (err) {
        llmMsTotal += Date.now() - llmT0;
        io.stopSpinner();
        io.endTurn();
        if (aborted) {
          stripOrphanCalls();
          return { text: null, reasoning: '', usage, steps, finish, truncated: false, aborted: true, durationMs: Date.now() - startedAt, perf: perf() };
        }
        // MacBook 本地 507 memory_refusal 根因（v0.4.5）：服务端内存拒绝不是「空输出」——
        // 直接终结合合并透出降级提示，不计入空轮、不注入续写重试（内存未释放必再 507，空烧请求）。
        const e = /** @type {any} */ (err);
        if (e?.status === 507 || /memory_refusal|内存不足|内存拒绝/i.test(String(e?.message || ''))) {
          stripOrphanCalls();
          return {
            text: null,
            reasoning: '',
            usage,
            steps,
            finish,
            truncated: false,
            aborted: false,
            note: '本地模型内存不足（507 memory_refusal）——请压缩上下文（减小 config.contextBudget 或 /compact）、减少并发子任务，或重启模型服务释放内存后再继续。',
            durationMs: Date.now() - startedAt,
            perf: perf(),
          };
        }
        throw err;
      }

      finish = res.finish ?? finish;
      // v0.6.0 C1：模型轮次事件（耗时/首 token/用量/完成原因）——「这一步花了多少钱、等了多久」的最小依据
      turnLedger.modelRound({
        round,
        step: steps,
        ms: Date.now() - llmT0,
        firstTokenMs: firstTokenAt ? firstTokenAt - llmT0 : null,
        requestStartAt: lastRequestStartAt,
        finish: res.finish ?? null,
        usage: res.usage ?? null,
      });
      // 省钱 B1：只读阶段中模型文字明确表达写意图 → 下一轮注入全量工具（多一轮，几乎无感）
      if (readOnlyPhase && hasWriteIntent(res.text)) readOnlyPhase = false;
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

      if (res.toolCalls?.length) {
        // v0.2.8 步数上限收尾（对齐 DSH）：末轮仍返回工具调用（无视收尾指令）时不再执行工具——
        // 有正文直接收尾，无正文跳出循环进入兜底总结，避免再次跑满步数后静默结束。
        if (steps === stepLimit) {
          io.endTurn();
          if (res.text) {
            const ap = await applyOutputConstraints(res.text, { messages, provider, activeModel, temperature, maxOutput, usage, signal: currentAc?.signal });
            messages.push({ role: 'assistant', content: ap.text });
            return { text: ap.text, reasoning: res.reasoning || '', usage, steps, finish, truncated: false, aborted: false, note: ap.note || undefined, durationMs: Date.now() - startedAt, perf: perf() };
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

        // 预检：解析参数 → PreToolUse 钩子 → 权限检查；拒绝/失败只回填不执行（返回 null）
        // task 工具标记 readOnly 时也可并行（评估 A4：只读子代理 Promise.all）
        async function prepTool(/** @type {any} */ tc) {
          const name = tc.function?.name || '';
          // 审计（P3-5）：参数与拒绝原因都记录（配置 audit:false 可关）
          const auditOn = cfg.audit !== false;
          const auditArgs = () => redactSecrets(JSON.stringify(args ?? {})).slice(0, 2000);
          const auditEntry = (extra = {}) =>
            writeAudit({
              at: Date.now(),
              session: sessionRef?.name ?? null,
              model: modelName,
              tool: name,
              args: auditArgs(),
              ...extra,
            });
          let args = /** @type {any} */ (null);
          try {
            args = JSON.parse(tc.function?.arguments || '{}');
          } catch {
            // 参数 JSON 解析失败：回填错误给模型，不拿空参数去执行工具
            io.renderToolDenied(name, {}, '参数解析失败（输出超限被截断？建议分块）');
            if (auditOn) auditEntry({ denied: true, reason: '参数解析失败' });
            // 审计（长生成截断循环）：给出明确分块指引，避免模型反复用单个超大 write 撞输出上限
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content:
                '工具参数 JSON 解析失败（大概率是输出超过模型单次上限被截断）。请把内容拆分成多个较小文件或多次调用逐步写入：单个 write 的参数总长控制在 6000 字符以内；先写核心骨架，再逐文件补充。',
            });
            return null;
          }
          if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};

          // PreToolUse 钩子
          const hook = await hooks.pre(name, args);
          if (hook.decision === 'block') {
            io.renderToolDenied(name, args, '被钩子阻止');
            if (auditOn) auditEntry({ denied: true, reason: `PreToolUse 钩子阻止：${String(hook.reason || '').slice(0, 200)}` });
            messages.push({ role: 'tool', tool_call_id: tc.id, content: `工具被 PreToolUse 钩子阻止：${hook.reason}` });
            return null;
          }

          const isMcp = name.startsWith('mcp__');
          // v0.4.0 Agent Preset：白名单强制（模型可能调用白名单外工具——schema 已不发，此处兜底硬拦）
          if (presetToolSet && !presetToolSet.has(isMcp ? name.slice(5) : name)) {
            io.renderToolDenied(name, args, `不在预设工具白名单内（${activePresetName || 'preset'}）`);
            if (auditOn) auditEntry({ denied: true, reason: '预设工具白名单拦截' });
            messages.push({ role: 'tool', tool_call_id: tc.id, content: `工具 ${name} 不在当前预设的工具白名单内，已拒绝执行。` });
            return null;
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
            if (auditOn) auditEntry({ denied: true, reason: '未授权' });
            // v0.6.0 C1：权限拒绝是「为什么没执行」的头号答案，必须入账
            turnLedger.permission({ name, mode: permission?.mode ?? cfg.permission ?? null, decision: 'deny', source: 'permission.check' });
            turnLedger.toolCall({ callId: tc.id, name, rawArgs: args, args, permission: { decision: 'deny' } });
            turnLedger.toolResult({ callId: tc.id, name, ok: false, blocked: true, ms: 0, error: '权限拒绝' });
            messages.push({ role: 'tool', tool_call_id: tc.id, content: '用户拒绝了该工具的执行权限。' });
            return null;
          }
          // v0.5.0 A3 ①：领域约束（PreToolUse）——权限放行之后、执行之前强制。
          // 与权限引擎的分工：权限回答「用户是否允许」，约束回答「领域是否允许」；两者都通过才执行。
          const cv = checkPreTool(constraints, name, args);
          // v0.6.0 C1：工具调用事件——参数留「脱敏明细 + 原文指纹」两份，指纹用于比对/防篡改；
          // 权限与约束**两者都记**：受监管场景要能回答「权限放行了，但领域红线拦住了」这类问题。
          turnLedger.toolCall({
            callId: tc.id,
            name,
            pack: /^pack__([a-z0-9-]+)__/.exec(String(name || ''))?.[1] ?? null,
            rawArgs: args,
            args,
            permission: { decision: 'allow', source: 'permission.check' },
            constraint: cv?.blocked ? { blocked: true, id: cv.event?.id ?? null, kind: cv.event?.kind ?? null } : null,
          });
          if (cv?.blocked) {
            io.renderToolDenied(name, args, cv.reason);
            if (auditOn) auditEntry({ denied: true, reason: cv.reason });
            auditConstraint(cv.event);
            // 被约束拦下的调用不会有 tool.result，这里补一条终态，避免账本出现「只有调用没有结果」的悬空步
            turnLedger.toolResult({ callId: tc.id, name, ok: false, blocked: true, ms: 0, error: '领域约束拦截' });
            messages.push({ role: 'tool', tool_call_id: tc.id, content: `【领域约束】${cv.reason}` });
            return null;
          }
          return { tc, name, args, isMcp };
        }

        // 执行单个工具（渲染「执行中」→ dispatch → 捕获异常转错误结果）
        // 审计 Hermes C4：同回合相同参数的只读工具（read/ls/glob/grep/skill）合并执行一次，
        // 后续相同调用直接复用结果（仍逐个回填 tool 消息以保持 tool_call_id 配对）
        async function runTool(/** @type {any} */ prep) {
          io.renderToolStart?.(prep.name, prep.args);
          // Pack 工具名形如 pack__<pack>__<tool>；执行期间标注来源，供 ctx.llm 归因
          const pkMatch = /^pack__([a-z0-9-]+)__/.exec(String(prep.name || ''));
          const prevPack = currentPack;
          currentPack = pkMatch ? pkMatch[1] : null;
          usedToolNames.add(prep.name); // 省钱 B1：执行过即标记，后续轮次省略其 description
          const dedupKey = !prep.isMcp && READONLY_TOOLS_SET.has(prep.name) ? prep.name + ':' + JSON.stringify(prep.args || {}) : null;
          if (dedupKey && turnToolCache.has(dedupKey)) {
            prep.cached = true;
            return turnToolCache.get(dedupKey);
          }
          try {
            let result;
            if (prep.isMcp) {
              if (!mcp) throw new Error('MCP 工具未启用');
              result = await mcp.call(prep.name, prep.args);
            } else {
              result = await dispatch(prep.name, prep.args, ctx);
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
          }
        }

        // 收尾：渲染结果 → todo 更新 → PostToolUse 钩子 → 回填消息（顺序与串行一致）
        function finishTool(/** @type {any} */ prep, /** @type {any} */ result, /** @type {any} */ t0) {
          const ms = Date.now() - t0;
          toolMsTotal += ms;
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
            writeAudit({
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
          let text = typeof result === 'string' ? result : JSON.stringify(result); // 紧凑 JSON（评估 B3）：嵌套结果省 10-20% 回填 token，且下轮按 prompt 重复计费
          const prefix = prep.cached ? '（与同回合相同调用结果一致，已复用）\n' : '';
          // v0.5.0 A3 ②：领域约束（PostToolUse）——completeness 缺项时**拒绝该工具结果**，
          // 让模型必须继续采集而不是把「未提及」当作已完成（「缺项绝不编造」从提示词升级为内核强制）。
          const pv = checkPostTool(constraints, prep.name, typeof result === 'string' ? safeParse(result) : result);
          if (pv?.rejected) {
            auditConstraint(pv.event);
            text = `【领域约束】${pv.reason}`;
          }
          messages.push({ role: 'tool', tool_call_id: prep.tc.id, content: prefix + clampText(text, toolResultCap) });
        }

        let i = 0;
        while (i < res.toolCalls.length) {
          // 收集批次：连续且可并行的只读工具成批；首个非并行项（写入类/被拒/MCP）结束批次
          const batch = []; // {prep, batchable}
          while (i < res.toolCalls.length) {
            const tc = res.toolCalls[i];
            const prep = /** @type {any} */ (await prepTool(tc));
            const name = tc.function?.name || '';
            let batchable = canBatch && Boolean(prep) && !prep.isMcp && READONLY_BATCH.has(name);
            if (!batchable && canBatch && Boolean(prep) && name === 'task' && prep.args?.readOnly === true && !subagentIsLocal) batchable = true;
            batch.push({ prep, batchable });
            i += 1;
            if (!batchable) break;
          }
          const firstNon = batch.findIndex((b) => !b.batchable);
          const prefix = firstNon === -1 ? batch : batch.slice(0, firstNon); // 审计 B11：非并行项前的前导只读子批仍可并行
          const allBatchable = prefix.length > 1 && prefix.every((b) => b.batchable);
          if (allBatchable && prefix.length === batch.length) {
            // 纯只读批次：并行执行（顺序收集结果，UI 事件顺序不变）；per-tool 计时（审计 B3）
            const results = await Promise.all(
              batch.map((b) => {
                const t0 = Date.now();
                return runTool(b.prep).then((r) => ({ r, t0 }));
              })
            );
            batch.forEach((b, idx) => finishTool(b.prep, results[idx].r, results[idx].t0));
          } else if (allBatchable && prefix.length > 1) {
            // 前导只读子批并行 + 其余串行
            const results = await Promise.all(
              prefix.map((b) => {
                const t0 = Date.now();
                return runTool(b.prep).then((r) => ({ r, t0 }));
              })
            );
            prefix.forEach((b, idx) => finishTool(b.prep, results[idx].r, results[idx].t0));
            for (const b of batch.slice(prefix.length)) {
              if (!b.prep) continue;
              const t0 = Date.now();
              finishTool(b.prep, await runTool(b.prep), t0);
            }
          } else {
            for (const b of batch) {
              if (!b.prep) continue; // 拒绝/失败成员已在 prepTool 回填
              const t0 = Date.now();
              finishTool(b.prep, await runTool(b.prep), t0);
            }
          }
        }
        // v0.2.8 步数预留收尾（对齐 DSH）：仅「最后一轮」的末步追加收尾指令，
        // 让模型在末轮输出总结；中间轮不注入（交给自动续跑继续干活，而非提前收尾中断）。
        if (steps === stepLimit - 1 && round === maxRounds - 1) {
          messages.push({
            role: 'user',
            content:
              '（系统提示）已达到工具调用步数上限，请停止调用工具，直接输出最终总结：① 已完成的工作；② 交付物清单（文件路径）；③ 遗留问题与后续建议。',
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
          const ap = await applyOutputConstraints(res.text, { messages, provider, activeModel, temperature, maxOutput, usage, signal: currentAc?.signal });
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
            stripOrphanCalls();
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
            return {
              text: null,
              reasoning: res.reasoning || '',
              usage,
              steps,
              finish,
              truncated: false,
              aborted: false,
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
        return {
          text: finalText,
          reasoning: res.reasoning || '',
          usage,
          steps,
          finish,
          truncated: false,
          aborted: false,
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
      messages.push({
        role: 'user',
        content: `（系统提示）已连续执行 ${stepLimit} 步工具操作，任务尚未完成，请继续完成剩余工作。${art}先核对已完成部分（勿重复），再做未完成的部分。`,
      });
      io.print(style(`♻ 步数上限，自动续跑第 ${round + 2} 轮…`, C.dim));
      continue;
    }
    io.endTurn();
    // 步数上限：清掉未执行的 tool_calls，避免下一轮/恢复后 API 400
    stripOrphanCalls();
    // v0.2.8 兜底总结（对齐 DSH）：跑满步数/末轮无正文且未中断时，补一次 no-tool 小输出请求，
    // 让任务以「总结文字 + 交付物清单」收尾，而非静默结束；失败则回退旧行为（text:null）。
    // v0.4.1 修复：输入轻量化——此前用 trimMessages(messages, budget) 全量历史，本地 q8 量化模型
    // （prefill ~165 tok/s）≈98k token 的 prefill 逼近/超过 600s 首 token 超时 → 总结请求失败被吞 →
    // 表现为「输出截断/子代理无反馈」。改用 system + 交付物清单 + 提示（几 k token），慢 prefill 也能秒出总结。
    if (!aborted && messages.length) {
      try {
        const sys = messages.find((/** @type {any} */ m) => m.role === 'system');
        const wrapReq = [
          ...(sys ? [sys] : []),
          ...(deliverables.length
            ? [{ role: 'user', content: '已交付文件：\n' + deliverables.map((/** @type {string} */ f) => `- ${f}`).join('\n') }]
            : []),
          { role: 'user', content: '（系统提示）任务已执行完毕。请用一段话总结刚才完成的工作，列出交付物（文件路径），并说明遗留问题与后续建议。' },
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
          maxTokens: Math.min(maxOutput, 2048),
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
          ? await applyOutputConstraints(wrapRes.text, { messages, provider, activeModel, temperature, maxOutput, usage, signal: currentAc?.signal })
          : { text: null, note: null };
        if (wrapApplied.text) messages.push({ role: 'assistant', content: wrapApplied.text });
        // capHit：本轮因步数上限被迫收尾（任务可能未真正完成）→ 供上层落检查点续跑
        return { text: wrapApplied.text || null, reasoning: wrapRes.reasoning || '', usage, steps, finish, truncated: false, aborted: false, capHit: true, note: wrapApplied.note || undefined, durationMs: Date.now() - startedAt, perf: perf() };
      } catch (/** @type {any} */ err) {
        // v0.4.1：不再静默吞异常——总结失败原因透出，便于定位（此前用户只见「输出截断/无反馈」）
        try { io.print(style(`⚠ 兜底总结失败：${String(err?.message || err)}`, C.yellow)); } catch {}
      }
    }
    return { text: null, reasoning: '', usage, steps, finish, truncated: true, aborted: false, capHit: true, durationMs: Date.now() - startedAt, perf: perf() };
    }
    // 理论不可达（for 循环末轮必 return）；给 tsc 一个兜底，保证 runTurn 恒有返回值
    return { text: null, reasoning: '', usage, steps, finish, truncated: true, aborted: false, capHit: true, durationMs: Date.now() - startedAt, perf: perf() };
    } catch (/** @type {any} */ err) {
      // 审计 P2-6（v0.4.2）：工具管线异常（hooks.pre / permission.check / prepTool 等）沿大 try 上抛时，
      // assistant tool_calls 已 push 进 messages 却无对应 tool 回填——会话恢复后 API 因孤儿 tool_call_id 400。
      // 清理孤儿调用后再抛（stripOrphanCalls 此前只在中断/收尾路径调用）。
      stripOrphanCalls();
      throw err;
    } finally {
      currentAc = null;
      currentUsage = null; // 回合结束：避免 runTurn 之外调用的 spawnTask 写入陈旧累加器
      // v0.6.0 C1：回合收尾事件（状态/步数/费用）。
      // 费用按**发起时刻**计价（lastRequestStartAt）——与 recordUsage 同款口径，跨 12:00/18:00
      // 边界的请求才不会被错记一档。estimateCost 对无价模型返回 null，于是 priced:false 会与
      // 金额一起落盘：账本里「无法估算」是一个显式事实，而不是被读成 ¥0.0000（v0.4.5 的诚实原则）。
      if (turnLedger) {
        try {
          const costDate = lastRequestStartAt ? new Date(lastRequestStartAt) : new Date();
          const yuan = estimateCost(modelName, usage.prompt_tokens, usage.completion_tokens, cacheSplit(usage), costDate);
          const priced = typeof yuan === 'number' && Number.isFinite(yuan);
          turnLedger.cost({
            model: modelName,
            usage,
            yuan: priced ? yuan : null,
            priced,
            pricing: { requestStartAt: lastRequestStartAt, peak: isPeakHour(costDate) },
          });
          turnLedger.runEnd({
            ms: Date.now() - startedAt,
            // status 是「这次运行怎么结束的」，与模型层的 finish_reason（stop/tool_calls/length）
            // 不是一回事：前者给人看账本，后者记在 model.round 里。混用会让「status=stop」这种
            // 记录无法回答「这次到底完成了没有」。
            status: aborted ? 'aborted' : finish === 'length' || finish === 'max_steps' ? 'capped' : 'done',
            steps,
            rounds: round + 1,
            yuanTotal: priced ? yuan : null,
            priced,
            // capHit/truncated 的判定与下方返回值保持同一口径：跑到步数上限被迫收尾
            capHit: Boolean(finish === 'length' || finish === 'max_steps'),
            truncated: Boolean(finish === 'length'),
            aborted,
          });
        } catch {}
        turnLedger = null;
      }
      offSigint();
    }
  }

  return {
    modelName,
    budget,
    maxOutput,
    temperature,
    runTurn,
    spawnTask: (/** @type {any} */ prompt, /** @type {any} */ opts) => spawnTask(prompt, opts),
    getTodos: () => todos.slice(),
  };
}
