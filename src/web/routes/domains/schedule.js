// 调度域（Phase C C1）：/api/schedule /api/tasks
// 定时任务增删暂停恢复/链式编排；聊天 SSE 任务 + 后台 worker + 调度任务合并面板。
import path from 'node:path';
import {
  addSchedule,
  listSchedules,
  removeSchedule,
  pauseSchedule,
  resumeSchedule,
  chainSchedules,
  reconcileSchedules,
} from '../../../schedule.js';
import { listTasks } from '../../../tasks.js';

/**
 * 调度域路由。命中返回 true，未命中返回 false。
 * @param {{req:any,res:any,method:any,p:any,url:any}} ctx
 * @param {any} deps
 * @param {{json:any,readBody:any,MAX_API_BODY:any}} shared
 */
export async function handle({ req, res, method, p, url }, deps, shared) {
  const { json, readBody, MAX_API_BODY } = shared;
  const { home, state, tasks, MAX_CONCURRENT } = deps;

  if (method === 'GET' && p === '/api/tasks') {
    const running = [...tasks.values()].filter((t) => t.status === 'running').length;
    const list = [...tasks.entries()].map(([id, t]) => ({
      id,
      status: t.status,
      message: t.message,
      startedAt: t.startedAt,
      durationMs: t.status === 'running' ? Date.now() - t.startedAt : t.durationMs,
      session: t.session ? path.basename(t.session.file) : null,
    }));
    // 质检（等待状态静默）：后台 worker 任务与运行中的调度任务并入面板与状态条计数——
    // 此前 /api/tasks 只含聊天 SSE 任务，后台下载/长任务期间界面完全无感知
    let bgRunning = 0;
    const background = [];
    try {
      for (const t of listTasks(home)) {
        if (t.status === 'running') bgRunning += 1;
        background.push({
          id: t.id,
          kind: 'worker',
          status: t.status,
          message: t.message || t.question || '',
          startedAt: t.startedAt,
          durationMs: t.status === 'running' ? Date.now() - t.startedAt : t.durationMs,
          error: t.error || '',
        });
      }
      for (const sch of listSchedules(home)) {
        if (sch.status === 'running') bgRunning += 1;
        background.push({
          id: sch.id,
          kind: 'schedule',
          status: sch.status,
          message: sch.question || sch.id || '',
          startedAt: sch.createdAt || null,
          durationMs: sch.status === 'running' ? Date.now() - (sch.lastRunAt || Date.now()) : null,
        });
      }
    } catch {}
    json(res, 200, { ok: true, running, bgRunning, maxConcurrent: MAX_CONCURRENT, tasks: list, background });
    return true;
  }

  if (method === 'GET' && p === '/api/schedule') {
    reconcileSchedules(home);
    const jobs = listSchedules(home).map((j) => ({
      id: j.id,
      status: j.status,
      kind: j.kind,
      question: j.question,
      nextRunAt: j.nextRunAt,
      lastRunAt: j.lastRunAt,
      lastTaskId: j.lastTaskId,
      runs: j.runs,
      interval: j.interval,
      anchor: j.anchor,
      after: j.after,
      history: j.history || [],
      note: j.note,
    }));
    json(res, 200, { ok: true, jobs });
    return true;
  }

  if (method === 'POST' && p === '/api/schedule') {
    const body = await readBody(req, MAX_API_BODY);
    const action = String(body.action || '');
    try {
      if (action === 'add') {
        if (!body.question || !String(body.question).trim()) return json(res, 400, { error: '任务内容不能为空' });
        const r = addSchedule(home, String(body.question).trim(), {
          at: body.at || null,
          every: body.every || null,
          anchor: body.anchor || null,
          after: Array.isArray(body.after) ? body.after.map(String) : body.after ? String(body.after).split(',').map((x) => x.trim()).filter(Boolean) : undefined,
          permission: body.permission || null,
          model: body.model || null,
          cwd: state.workingDir,
          offpeak: body.offpeak === true,
        });
        if (r.error) return json(res, 400, { error: r.error });
        return json(res, 200, { ok: true, id: r.id });
      }
      if (action === 'chain') {
        const qs = Array.isArray(body.questions) ? body.questions.map(String).filter((/** @type {any} */ q) => q.trim()) : [];
        if (qs.length < 2) return json(res, 400, { error: '链式需要至少两个任务' });
        const r = /** @type {any} */ (chainSchedules(home, qs, { permission: body.permission || null, model: body.model || null }));
        if (r.error) return json(res, 400, { error: r.error });
        return json(res, 200, { ok: true, ids: r.ids });
      }
      const id = String(body.id || '');
      if (!id) return json(res, 400, { error: '缺少 id' });
      if (action === 'remove') return json(res, 200, { ok: removeSchedule(home, id) });
      if (action === 'pause') return json(res, 200, { ok: pauseSchedule(home, id) });
      if (action === 'resume') return json(res, 200, { ok: resumeSchedule(home, id) });
      return json(res, 400, { error: '未知操作：add|chain|remove|pause|resume' });
    } catch (/** @type {any} */ err) {
      return json(res, 500, { error: String(err?.message || err) });
    }
  }

  return false;
}
