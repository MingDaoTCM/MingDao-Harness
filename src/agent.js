// Agent 核心循环：消息 → 模型（流式）→ PreToolUse 钩子 → 权限引擎 → 工具执行
// → PostToolUse 钩子 → 结果回填 → 循环，直到模型给出纯文本回复。
// 附带：子代理（task 工具）、todo 清单状态、undo 备份仓、Ctrl+C 中断。

import { trimMessages, clampText } from './context.js';
import { compactConversation } from './compact.js';
import { toolSchemas, dispatch } from './tools/index.js';
import { modelPreset } from './models.js';
import { makeTokenCounter } from './tokenizer.js';
import { createHooks } from './hooks.js';
import { createIO, style, C } from './ui.js';
import { subagentModel } from './routing.js';
import { writeAudit, redactSecrets } from './audit.js';

const MAX_STEPS = 24;
const SUBAGENT_MAX_STEPS = 12;

export function createAgent({ provider, permission, io, modelName, workingDir, cfg = {}, undoStore, maxSteps, mcp, onCompact, sessionRef }) {
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
      sessionRef, // 子代理的审计记录归入主会话
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
    let emptyRounds = 0; // 连续空/截断输出计数（防止无限续写）
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

        // 只读工具并行（P2-8）：同一 response 里的连续 read/ls/glob/grep 无相互依赖，
        // 在 auto 权限模式下（无交互询问、无副作用的纯读）Promise.all 并发执行；
        // 其余模式/工具保持串行，避免多个权限对话框交错。事件顺序（start/render/post/回填）不变。
        const READONLY_BATCH = new Set(['read', 'ls', 'glob', 'grep']);
        const canBatch = permission.mode === 'auto';

        // 预检：解析参数 → PreToolUse 钩子 → 权限检查；拒绝/失败只回填不执行（返回 null）
        async function prepTool(tc) {
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
          let args = null;
          try {
            args = JSON.parse(tc.function?.arguments || '{}');
          } catch {
            // 参数 JSON 解析失败：回填错误给模型，不拿空参数去执行工具
            io.renderToolDenied(name, {}, '参数解析失败（输出超限被截断？建议分块）');
            if (auditOn) auditEntry({ denied: true, reason: '参数解析失败' });
            messages.push({ role: 'tool', tool_call_id: tc.id, content: '工具参数 JSON 解析失败，请重新输出合法参数。' });
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
        async function runTool(prep) {
          io.renderToolStart?.(prep.name, prep.args);
          try {
            if (prep.isMcp) {
              if (!mcp) throw new Error('MCP 工具未启用');
              return await mcp.call(prep.name, prep.args);
            }
            return await dispatch(prep.name, prep.args, ctx);
          } catch (err) {
            return JSON.stringify({ ok: false, error: String(err?.message || err) });
          }
        }

        // 收尾：渲染结果 → todo 更新 → PostToolUse 钩子 → 回填消息（顺序与串行一致）
        function finishTool(prep, result, t0) {
          const ms = Date.now() - t0;
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
          messages.push({ role: 'tool', tool_call_id: prep.tc.id, content: clampText(text) });
        }

        let i = 0;
        while (i < res.toolCalls.length) {
          // 收集批次：连续且可并行的只读工具成批；首个非并行项（写入类/被拒/MCP）结束批次
          const batch = []; // {prep, batchable}
          while (i < res.toolCalls.length) {
            const tc = res.toolCalls[i];
            const prep = await prepTool(tc);
            const name = tc.function?.name || '';
            const batchable = canBatch && Boolean(prep) && !prep.isMcp && READONLY_BATCH.has(name);
            batch.push({ prep, batchable });
            i += 1;
            if (!batchable) break;
          }
          const allBatchable = batch.length > 1 && batch.every((b) => b.batchable);
          if (allBatchable) {
            // 纯只读批次：并行执行（顺序收集结果，UI 事件顺序不变）
            const t0 = Date.now();
            const results = await Promise.all(batch.map((b) => runTool(b.prep)));
            batch.forEach((b, idx) => finishTool(b.prep, results[idx], t0));
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
        // 输出被长度上限截断（DeepSeek 推理吃满 maxOutput 时正文为空）：让模型从断点续写，绝不静默结束
        if (res.finish === 'length') {
          emptyRounds += 1;
          if (emptyRounds >= 12) {
            stripOrphanCalls();
            return {
              text: res.text || null,
              reasoning: res.reasoning || '',
              usage,
              steps,
              finish,
              truncated: true,
              aborted: false,
              note: '模型连续输出被截断，请换用更长输出的模型或拆分任务。',
              durationMs: Date.now() - startedAt,
            };
          }
          messages.push({
            role: 'user',
            content: '（系统提示）你的上一条输出因达到长度上限被截断。请直接继续未完成的部分：不要重复已写内容，从断点接着完成。',
          });
          continue;
        }
        if (!res.text) {
          // 静默空输出（无工具无正文）：同样回填续写提示，避免界面"没动静"
          emptyRounds += 1;
          if (emptyRounds >= 2) {
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
