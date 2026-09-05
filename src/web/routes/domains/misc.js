// 杂项域（Phase C C1）：/api/chat /api/permission /api/abort /api/memory /api/cache-stats
// 对话 SSE 流（并发上限 + 生命周期计数）、权限确认、任务中断、长期记忆、费用/缓存统计。
import { loadMemory, writeMemory, dedupeMemory } from '../../../memory.js';
import { recordUsage, listCacheStats, summarizeCacheStats, costBreakdown } from '../../../cachestats.js';
import { costGuardStatus } from '../../../cost-guard.js';
import { listPresets } from '../../../presets.js';

/**
 * 杂项域路由。命中返回 true，未命中返回 false。
 * @param {{req:any,res:any,method:any,p:any,url:any}} ctx
 * @param {any} deps
 * @param {{json:any,readBody:any,MAX_API_BODY:any}} shared
 */
export async function handle({ req, res, method, p, url }, deps, shared) {
  const { json, readBody, MAX_API_BODY } = shared;
  const { tasks, refs, MAX_CONCURRENT, handleChat, pruneTasks } = deps;

  if (method === 'POST' && p === '/api/chat') {
    // 质检 S2：inflight 计数绑定请求生命周期（进入 ++ / 结束 --）。
    // 此前检查发生在 readBody 之前且占位即删，多请求可同时卡在 readBody 后批量登记 → 瞬时超并发
    refs.inflight += 1;
    if (refs.inflight > MAX_CONCURRENT) {
      refs.inflight -= 1;
      return json(res, 429, { error: `并发任务已达上限（${MAX_CONCURRENT}），请等待任务完成或中断` });
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let body;
    try {
      // chat 保留默认 40MB 上限（附件 base64 可达 ~26MB）；普通 JSON 接口才用 MAX_API_BODY=1MB
      body = await readBody(req);
    } catch (/** @type {any} */ e) {
      refs.inflight -= 1;
      res.write(`data: ${JSON.stringify({ type: 'error', message: e.message })}\n\n`);
      res.end();
      return true;
    }
    try {
      await handleChat(res, body);
    } catch (/** @type {any} */ err) {
      // 兜底（审计：「点发送无反应」根因防护）：handleChat 内任意未捕获异常若直接外抛，
      // SSE 已开流却无事件 → 前端永远停在「正在思考…」。此处统一转为 error 事件回给界面。
      try {
        res.write(`data: ${JSON.stringify({ type: 'error', message: '对话失败：' + String(err?.message || err) })}\n\n`);
      } catch {}
      try {
        res.end();
      } catch {}
      pruneTasks();
    }
    refs.inflight -= 1; // 与 handleChat 的 finally 无关：handleChat 内部路径全部会返回/结束
    return true;
  }

  if (method === 'POST' && p === '/api/permission') {
    const body = await readBody(req, MAX_API_BODY);
    const entry = tasks.get(body.taskId);
    if (!entry || !entry.pendingAsk) return json(res, 409, { error: '没有挂起的权限确认' });
    const pa = entry.pendingAsk;
    entry.pendingAsk = null;
    const answer = String(body.answer ?? '');
    if (pa.options && Array.isArray(pa.options)) {
      const opt = pa.options.find((/** @type {any} */ o) => String(o.value) === answer);
      pa.resolve(opt ? opt.value : answer);
    } else {
      pa.resolve(answer);
    }
    json(res, 200, { ok: true });
    return true;
  }

  if (method === 'POST' && p === '/api/abort') {
    const body = await readBody(req, MAX_API_BODY);
    if (body.taskId) {
      const entry = tasks.get(body.taskId);
      if (entry?.abortHandler) {
        try {
          entry.abortHandler();
        } catch {}
      }
    } else {
      // 未指定任务：中断全部运行中任务
      for (const t of tasks.values()) {
        if (t.status === 'running' && t.abortHandler) {
          try {
            t.abortHandler();
          } catch {}
        }
      }
    }
    json(res, 200, { ok: true });
    return true;
  }

  if (method === 'GET' && p === '/api/memory') {
    json(res, 200, { ok: true, content: loadMemory() });
    return true;
  }

  // v0.4.0 Agent Preset：列出可用预设（项目 → 用户 → 内置，同名遮蔽）
  if (method === 'GET' && p === '/api/presets') {
    const workingDir = deps.state?.workingDir || process.cwd();
    json(res, 200, { ok: true, presets: listPresets(workingDir) });
    return true;
  }

  if (method === 'POST' && p === '/api/memory') {
    const body = await readBody(req, MAX_API_BODY);
    if (body.action === 'dedupe') {
      const removed = dedupeMemory();
      return json(res, 200, { ok: true, removed });
    }
    if (body.content !== undefined) {
      writeMemory(body.content);
      return json(res, 200, { ok: true });
    }
    return json(res, 400, { error: '缺少 content 或 action=dedupe' });
  }

  if (method === 'GET' && p === '/api/cache-stats') {
    const entries = listCacheStats();
    json(res, 200, {
      ok: true,
      summary: summarizeCacheStats(entries),
      breakdown: costBreakdown(),
      guard: costGuardStatus(),
      recent: entries.slice(-10).reverse(),
    });
    return true;
  }

  return false;
}
