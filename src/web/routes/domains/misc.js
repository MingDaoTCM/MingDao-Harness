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
    // P1 修复（v0.4.6）：必须校验服务端下发、仅经该任务 SSE 流送达的 ask id。
    // 此前只凭 taskId 取 pendingAsk（taskId 是 t1/t2… 顺序号，且 GET /api/tasks 全量列出），
    // 任何能访问 API 的一方都能替他人挂起的确认直接答「允许」，绕过默认 ask 档人工闸门。
    if (!pa.id || String(body.id || '') !== String(pa.id)) {
      return json(res, 403, { error: '权限确认标识不匹配（该确认属于另一个客户端会话）' });
    }
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
    /**
     * 停止一个任务：**必须同时做两件事**——
     *   ① 置中断标志：`abortHandler()`（agent.js 注册的回调：`aborted = true; currentAc?.abort()`）；
     *   ② 解除挂起的权限确认（`pendingAsk`）。
     * 只做 ① 是本次用户实测 bug 的根因：回合正卡在 `await io.ask()` 上时，`aborted` 置真不会让
     * 那个 await 醒来，工具循环要一直等到 ASK_TIMEOUT_MS（120 秒）超时才继续——用户看到的就是
     * 「按停止没反应」，日志里则是连着一串「权限确认超时（120 秒未收到应答）」（见 §138）。
     * 顺序：**先置中断标志、再解除 ask**——`aborted=true` 必须在 ask 的 await 续体被调度前生效，
     * 否则工具按「拒绝」返回后循环会照常发起下一次模型请求（停止＝没停）。
     * 与超时的交互：`pendingAsk.resolve()` 内部会 `clearTimeout(askTimer)`，所以停止**优先于**
     * 120 秒 ask 超时，停止之后不会再冒一条"权限确认超时"的 error。
     * @param {any} entry
     * @returns {{ abortedTurn: boolean, releasedAsk: boolean }}
     */
    const stopTask = (entry) => {
      let abortedTurn = false;
      if (typeof entry?.abortHandler === 'function') {
        try {
          entry.abortHandler();
          abortedTurn = true;
        } catch {}
      }
      let releasedAsk = false;
      if (entry?.pendingAsk) {
        const pa = entry.pendingAsk;
        entry.pendingAsk = null; // 先摘掉引用：await 续体唤醒后不得再看到这个挂起项
        try {
          pa.resolve(''); // 空串 = 拒绝（与超时同一口径：绝不因停止而放行）
          releasedAsk = true;
        } catch {}
      }
      return { abortedTurn, releasedAsk };
    };
    /** @type {any[]} */
    const hits = [];
    let found = true;
    if (body.taskId) {
      const entry = tasks.get(body.taskId);
      if (!entry) found = false;
      else hits.push({ entry, ...stopTask(entry) });
    } else {
      // 未指定任务：中断全部运行中任务
      for (const t of tasks.values()) {
        if (t.status === 'running') hits.push({ entry: t, ...stopTask(t) });
      }
      if (!hits.length) found = false; // 没有运行中的任务可停——别回一个"成功"让前端以为停了
    }
    const stopped = hits.filter((h) => h.abortedTurn).length;
    const releasedAsk = hits.filter((h) => h.releasedAsk).length;
    // 可见反馈（前端点击后必须有东西发生）：停止是用户主动动作，SSE 流里留一句。
    // 特别是「等权限确认时被停止」这条路径——此前的表现是界面完全静默 120 秒。
    for (const h of hits) {
      if (!h.abortedTurn && !h.releasedAsk) continue; // 什么都没有停下就不吹哨（如实）
      try {
        h.entry.send?.({
          type: 'banner',
          text: h.releasedAsk
            ? '■ 已停止本轮：同时解除了挂起的权限确认（按「拒绝」处理，不会放行本次操作）。'
            : '■ 已停止本轮生成。',
        });
      } catch {}
    }
    // 如实回报，便于前端区分「停了」「任务已结束」「没有可停的东西」——不再一律 200 静默。
    json(res, 200, {
      ok: true,
      found,
      stopped,
      releasedAsk,
      status: hits.length === 1 ? hits[0].entry.status : null,
    });
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
