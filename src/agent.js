// Agent 核心循环：消息 → 模型（流式）→ PreToolUse 钩子 → 权限引擎 → 工具执行
// → PostToolUse 钩子 → 结果回填 → 循环，直到模型给出纯文本回复。
// 附带：子代理（task 工具）、todo 清单状态、undo 备份仓、Ctrl+C 中断。

import { trimMessages, clampText, messageTokens, approxTokens } from './context.js';
import { compactConversation } from './compact.js';
import { buildToolSchemas, dispatch } from './tools/index.js';
import { modelPreset } from './models.js';
import { makeTokenCounter } from './tokenizer.js';
import { createHooks } from './hooks.js';
import { createIO, style, C } from './ui.js';
import { subagentModel } from './routing.js';
import { writeAudit, redactSecrets } from './audit.js';
import { checkCostGuard, costGuardConfig, todayCost } from './cost-guard.js';
import { estimateCost } from './pricing.js';
import { resolveProviderConfig } from './providers/index.js';

const MAX_STEPS = 24;
const SUBAGENT_MAX_STEPS = 12;

/**
 * 创建 Agent 循环（调用方只需传 provider/permission/io/modelName/workingDir，其余可选）
 * @param {{ provider: any, permission: any, io: any, modelName: any, workingDir: any,
 *   cfg?: any, undoStore?: any, maxSteps?: number, mcp?: any, onCompact?: any, sessionRef?: any }} params
 */
export function createAgent({ provider, permission, io, modelName, workingDir, cfg = {}, undoStore, maxSteps, mcp, onCompact, sessionRef }) {
  const preset = modelPreset(modelName) || {};
  const budget = cfg.contextBudget || preset.budgetTokens || 128000;
  const maxOutput = cfg.maxOutputTokens || preset.maxOutputTokens || 8192;
  const temperature = cfg.temperature ?? preset.temperature ?? 0.6;
  const reasoningEffort = cfg.reasoningEffort ?? preset.reasoningEffort?.default ?? undefined;
  const hooks = createHooks(cfg.hooks, workingDir);
  const todos = /** @type {any[]} */ ([]);
  // 会话级共享：调用方传入则复用（/model 切换、子代理均共享，undo 不丢失）
  const undo = undoStore || { backups: new Map() };
  const stepLimit = maxSteps || MAX_STEPS;
  // 只读工具集合（子代理只读模式 + 并行批次共用）
  const READONLY_TOOLS_SET = new Set(['read', 'ls', 'glob', 'grep', 'skill']);
  // 精确 token 计数：DeepSeek 词表，其他模型回退启发式
  const count = makeTokenCounter(modelName);
  // MCP 工具集（每次取，服务器晚就绪也能在后续轮次出现）
  const mcpSchemas = () => (mcp ? mcp.toolSchemas() : []);
  // 省钱 B1：本会话已调用过的工具名（内置名/MCP 前缀名）——其 schema 在后续轮次省略 description，
  // 模型已在消息历史里见过用途；未用过的保留完整描述。省输入 token（工具 schema 按需瘦身）。
  const usedToolNames = new Set();
  // 省钱 B1（按需挂载）：回合起始为「只读阶段」时只发只读工具（read/ls/glob/grep/skill/todo）
  // + 已用过的工具；检测到写意图（用户消息或模型明说需要写/改/建）后注入全量工具。
  const READONLY_TIER_SET = new Set(['read', 'ls', 'glob', 'grep', 'skill', 'todo']);
  // 中英双语写意图（CodeArts 报告：纯中文正则让英文会话整回合只读死锁）
  const WRITE_INTENT_RE = /写|建|创|改|修|删|装|加|添|增|补|换|移|部署|执行|运行|实现|重构|生成|迁移|安装|更新|升级|发布|调整|优化|修复|提交|推送|打包|编译|测试|implement|fix|create|modify|update|delete|deploy|build|make|generate|install|write|refactor|migrate|test|run|commit|push|remove|add|change|patch/i;
  const hasWriteIntent = (/** @type {any} */ text) => WRITE_INTENT_RE.test(String(text || ''));
  const toolsFor = (/** @type {boolean} */ readOnlyPhase) => {
    const schemas = buildToolSchemas(usedToolNames, mcpSchemas());
    if (!readOnlyPhase) return schemas;
    return schemas.filter((/** @type {any} */ t) => {
      const n = t?.function?.name;
      if (!n) return true;
      if (READONLY_TIER_SET.has(n) || usedToolNames.has(n)) return true;
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
    const text = res.text || (res.truncated ? '（子任务达到步骤上限，未完成）' : '（子任务无输出）');
    io.print(style(`  ↳ 子任务完成（${ms}ms）`, C.magenta));
    return text;
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
    };
  }

  async function runTurn(/** @type {any} */ messages) {
    let steps = 0;
    let finish = null;
    const usage = /** @type {{ prompt_tokens: number, completion_tokens: number, prompt_cache_hit_tokens?: number, prompt_cache_miss_tokens?: number }} */ ({ prompt_tokens: 0, completion_tokens: 0 });
    const startedAt = Date.now();
    // 回合性能指标（状态栏：LLM 时长 / 工具时长 / 首 token 延迟 / 步数）
    let llmMsTotal = 0;
    let toolMsTotal = 0;
    let firstTokenAt = /** @type {any} */ (null);
    // 省钱 B3（费用二级分账）：推理 token 估算（按增量累计）与逐工具调用/耗时累加
    let reasoningTokens = 0;
    const toolStats = /** @type {Map<string, {calls: number, ms: number}>} */ (new Map());
    const perf = () => ({
      llmMs: llmMsTotal,
      toolMs: toolMsTotal,
      firstTokenMs: firstTokenAt == null ? null : firstTokenAt - startedAt,
      steps,
      reasoningTokens,
      toolStats: [...toolStats.entries()].map(([tool, s]) => ({ tool, calls: s.calls, ms: s.ms })),
      usedModel: activeModel, // 省钱 B4：本回合实际使用模型（降级后归属它）
    });
    let aborted = false;
    let emptyRounds = 0; // 连续空/截断输出计数（防止无限续写）
    let currentAc = /** @type {any} */ (null);
    // 省钱 B4（护栏降级）：action='downgrade' 超限后本回合切换到便宜模型继续执行；
    // activeModel 是本回合实际使用的模型（分账/记录归属它），downgraded 保证只提示一次。
    let activeModel = modelName;
    let downgraded = false;
    // 护栏在途费用（MiniMax P0）：本回合已累计 usage 的保守估算（无缓存折扣），
    // 护栏检查/前置拦截时并入今日已用——否则长回合内统计文件不变，可烧穿日限。
    const inFlightCost = () => estimateCost(activeModel, usage.prompt_tokens, usage.completion_tokens, null, new Date());
    const usedTodayWithInflight = () => {
      const today = todayCost();
      return today == null ? null : today + inFlightCost();
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
    // 整个回合注册一次 SIGINT：思考、工具执行、权限询问期间都能中断
    const offSigint = io.onSigint ? io.onSigint(() => { aborted = true; currentAc?.abort(); }) : () => {};
    const ctx = makeCtx();
    const stripOrphanCalls = () => {
      const last = messages[messages.length - 1];
      if (last?.role === 'assistant' && Array.isArray(last.tool_calls) && last.tool_calls.length) {
        messages[messages.length - 1] = { ...last, tool_calls: undefined };
      }
    };
    try {
    while (steps < stepLimit) {
      steps += 1;
      // 同回合只读工具去重（Hermes C4）：相同 name+args 的只读调用只执行一次，结果复用回填
      const turnToolCache = new Map();
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
            triggerRatio: cfg.compactTrigger, // 可配置触发线（默认 80%）
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
      let sanitized = trimmed;
      for (const m of sanitized) {
        const rc = m.reasoning_content;
        if (typeof rc !== 'string' || (Array.isArray(m.tool_calls) && m.tool_calls.length)) continue;
        if (rc.length > 4000) {
          sanitized = sanitized.map((/** @type {any} */ x) => (x === m ? { ...x, reasoning_content: `[思考过程已省略（原 ${rc.length} 字）]` } : x));
        } else if (rc.length > 1000) {
          sanitized = sanitized.map((/** @type {any} */ x) => (x === m ? { ...x, reasoning_content: rc.slice(-500) + ' …[思考过程已截断]' } : x));
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
          if (used == null) {
            // todayCost 读取失败：无法判断，跳过前置拦截（护栏主检查同样跳过并告警）
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
        const guard = checkCostGuard();
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
      try {
        res = await provider.chat({
          model: activeModel,
          messages: sanitized,
          tools: toolsFor(readOnlyPhase),
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
        throw err;
      }

      finish = res.finish ?? finish;
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
      }

      if (res.toolCalls?.length) {
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
          let allowed = false;
          if (isMcp && mcp?.isReadonly(name)) {
            allowed = true; // MCP 工具的只读标注自动放行
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
            messages.push({ role: 'tool', tool_call_id: tc.id, content: '用户拒绝了该工具的执行权限。' });
            return null;
          }
          return { tc, name, args, isMcp };
        }

        // 执行单个工具（渲染「执行中」→ dispatch → 捕获异常转错误结果）
        // 审计 Hermes C4：同回合相同参数的只读工具（read/ls/glob/grep/skill）合并执行一次，
        // 后续相同调用直接复用结果（仍逐个回填 tool 消息以保持 tool_call_id 配对）
        async function runTool(/** @type {any} */ prep) {
          io.renderToolStart?.(prep.name, prep.args);
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
            if (dedupKey) turnToolCache.set(dedupKey, result);
            return result;
          } catch (/** @type {any} */ err) {
            return JSON.stringify({ ok: false, error: String(err?.message || err) });
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
          const text = typeof result === 'string' ? result : JSON.stringify(result); // 紧凑 JSON（评估 B3）：嵌套结果省 10-20% 回填 token，且下轮按 prompt 重复计费
          const prefix = prep.cached ? '（与同回合相同调用结果一致，已复用）\n' : '';
          messages.push({ role: 'tool', tool_call_id: prep.tc.id, content: prefix + clampText(text) });
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
            if (!batchable && canBatch && Boolean(prep) && name === 'task' && prep.args?.readOnly === true) batchable = true;
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
      } else {
        io.endTurn();
        // 最终纯文本回复回填消息历史（会话持久化与多轮上下文依赖它）；
        // 空文本不回填，避免个别 API 对 assistant 空 content 报错
        if (res.text) {
          messages.push({ role: 'assistant', content: res.text });
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
          text: res.text || '',
          reasoning: res.reasoning || '',
          usage,
          steps,
          finish,
          truncated: false,
          aborted: false,
          durationMs: Date.now() - startedAt,
          perf: perf(),
        };
      }
    }
    io.endTurn();
    // 步数上限：清掉未执行的 tool_calls，避免下一轮/恢复后 API 400
    stripOrphanCalls();
    return { text: null, reasoning: '', usage, steps, finish, truncated: true, aborted: false, durationMs: Date.now() - startedAt, perf: perf() };
    } finally {
      currentAc = null;
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
