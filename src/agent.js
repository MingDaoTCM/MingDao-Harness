// Agent 核心循环：消息 → 模型（流式）→ PreToolUse 钩子 → 权限引擎 → 工具执行
// → PostToolUse 钩子 → 结果回填 → 循环，直到模型给出纯文本回复。
// 附带：子代理（task 工具）、todo 清单状态、undo 备份仓、Ctrl+C 中断。

import { trimMessages, clampText } from './context.js';
import { toolSchemas, dispatch } from './tools/index.js';
import { modelPreset } from './models.js';
import { makeTokenCounter } from './tokenizer.js';
import { createHooks } from './hooks.js';
import { createIO, style, C } from './ui.js';
import { subagentModel } from './routing.js';

const MAX_STEPS = 24;
const SUBAGENT_MAX_STEPS = 12;

export function createAgent({ provider, permission, io, modelName, workingDir, cfg = {}, undoStore, maxSteps, mcp }) {
  const preset = modelPreset(modelName) || {};
  const budget = cfg.contextBudget || preset.budgetTokens || 128000;
  const maxOutput = cfg.maxOutputTokens || preset.maxOutputTokens || 8192;
  const temperature = cfg.temperature ?? preset.temperature ?? 0.6;
  const hooks = createHooks(cfg.hooks, workingDir);
  const todos = [];
  // 会话级共享：调用方传入则复用（/model 切换、子代理均共享，undo 不丢失）
  const undo = undoStore || { backups: new Map() };
  const stepLimit = maxSteps || MAX_STEPS;
  // 精确 token 计数：DeepSeek 词表，其他模型回退启发式
  const count = makeTokenCounter(modelName);
  // MCP 工具集（每次取，服务器晚就绪也能在后续轮次出现）
  const mcpSchemas = () => (mcp ? mcp.toolSchemas() : []);

  // 子代理：全新上下文 + 同一 Provider/权限（提示带「子任务」标记），独立完成子任务后汇报
  async function spawnTask(prompt, { description = '' } = {}) {
    const subIo = createIO({ quiet: true });
    const subPermission = {
      check: (name, args) => permission.check(name, args, '（子任务）'),
    };
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
    });
    const sys =
      `你是主智能体 MingDao 派出的子代理，独立完成一项子任务。` +
      `你与主线程共享同一台电脑与项目（工作目录：${workingDir}）。` +
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
      spawnTask: (prompt, opts) => spawnTask(prompt, opts),
    };
  }

  async function runTurn(messages) {
    let steps = 0;
    let finish = null;
    const usage = { prompt_tokens: 0, completion_tokens: 0 };
    const startedAt = Date.now();
    let aborted = false;
    let currentAc = null;
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
      const trimmed = trimMessages(messages, budget, count);

      const ac = new AbortController();
      currentAc = ac;
      io.beginTurn();
      io.startSpinner('正在思考…');

      let res;
      try {
        res = await provider.chat({
          model: modelName,
          messages: trimmed,
          tools: [...toolSchemas(), ...mcpSchemas()],
          temperature,
          maxTokens: maxOutput,
          signal: ac.signal,
          onDelta(d) {
            io.stopSpinner();
            if (d.text) io.writeText(d.text);
            if (d.reasoning) io.writeReasoning(d.reasoning);
          },
        });
      } catch (err) {
        io.stopSpinner();
        io.endTurn();
        if (aborted) {
          stripOrphanCalls();
          return { text: null, reasoning: '', usage, steps, finish, truncated: false, aborted: true, durationMs: Date.now() - startedAt };
        }
        throw err;
      }

      finish = res.finish ?? finish;
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
        const assistantMsg = { role: 'assistant', content: res.text || null, tool_calls: res.toolCalls };
        messages.push(assistantMsg);
        for (const tc of res.toolCalls) {
          const name = tc.function?.name || '';
          let args = null;
          try {
            args = JSON.parse(tc.function?.arguments || '{}');
          } catch {
            // 参数 JSON 解析失败：回填错误给模型，不拿空参数去执行工具
            io.renderToolDenied(name, {});
            messages.push({ role: 'tool', tool_call_id: tc.id, content: '工具参数 JSON 解析失败，请重新输出合法参数。' });
            continue;
          }
          if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};

          // PreToolUse 钩子
          const hook = await hooks.pre(name, args);
          if (hook.decision === 'block') {
            io.renderToolDenied(name, args);
            messages.push({ role: 'tool', tool_call_id: tc.id, content: `工具被 PreToolUse 钩子阻止：${hook.reason}` });
            continue;
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
            io.renderToolDenied(name, args);
            messages.push({ role: 'tool', tool_call_id: tc.id, content: '用户拒绝了该工具的执行权限。' });
            continue;
          }

          const t0 = Date.now();
          let result;
          try {
            if (isMcp) {
              if (!mcp) throw new Error('MCP 工具未启用');
              result = await mcp.call(name, args);
            } else {
              result = await dispatch(name, args, ctx);
            }
          } catch (err) {
            result = JSON.stringify({ ok: false, error: String(err?.message || err) });
          }
          const ms = Date.now() - t0;
          io.renderTool(name, args, result, ms);
          if (name === 'todo' && result?.todos) io.renderTodo(result.todos);
          hooks.post(name, args, typeof result === 'string' ? { output: result } : result).catch(() => {});

          const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
          messages.push({ role: 'tool', tool_call_id: tc.id, content: clampText(text) });
        }
      } else {
        io.endTurn();
        // 最终纯文本回复回填消息历史（会话持久化与多轮上下文依赖它）；
        // 空文本不回填，避免个别 API 对 assistant 空 content 报错
        if (res.text) {
          messages.push({ role: 'assistant', content: res.text });
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
        };
      }
    }
    io.endTurn();
    // 步数上限：清掉未执行的 tool_calls，避免下一轮/恢复后 API 400
    stripOrphanCalls();
    return { text: null, reasoning: '', usage, steps, finish, truncated: true, aborted: false, durationMs: Date.now() - startedAt };
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
    spawnTask: (prompt, opts) => spawnTask(prompt, opts),
    getTodos: () => todos.slice(),
  };
}
