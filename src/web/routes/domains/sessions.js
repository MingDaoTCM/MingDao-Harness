// 会话域（Phase C C1）：/api/sessions /api/session /api/draft
// 会话列表/搜索、载入（聚焦工作空间）、重命名/删除、按会话隔离的草稿槽。
import fs from 'node:fs';
import path from 'node:path';
import {
  listSessions,
  loadSession,
  searchSessions,
  relativeTime,
  sessionPreview,
} from '../../../session.js';
import { sanitizeTitle, renameSessionFile, titleModel } from '../../../titles.js';
import { loadTaskState } from '../../../task-state.js';
import {
  workspaceForDir,
  touchWorkspace,
  getSessionWorkspace,
  moveSessionWorkspace,
  removeSessionWorkspace,
} from '../../../workspace.js';

/**
 * 会话域路由。命中返回 true，未命中返回 false。
 * @param {{req:any,res:any,method:any,p:any,url:any}} ctx
 * @param {any} deps
 * @param {{json:any,readBody:any,MAX_API_BODY:any}} shared
 */
export async function handle({ req, res, method, p, url }, deps, shared) {
  const { json, readBody, MAX_API_BODY } = shared;
  const { home, state, draftTexts } = deps;

  if (method === 'GET' && p === '/api/sessions') {
    const q = url.searchParams.get('q');
    const found = q
      ? searchSessions(home, q, { limit: 30 }).map((/** @type {any} */ s) => ({ file: s.name, mtime: s.mtime, label: `${relativeTime(s.mtime)} · ${s.snippet}` }))
      : listSessions(home).slice(0, 30).map((s) => ({ file: s.name, mtime: s.mtime, label: `${relativeTime(s.mtime)} · ${sessionPreview(s.file)}` }));
    json(res, 200, { ok: true, sessions: found });
    return true;
  }

  if (method === 'GET' && p === '/api/session') {
    const file = url.searchParams.get('file');
    if (!file) return json(res, 400, { error: '缺少 file 参数' });
    try {
      const loaded = loadSession(path.join(home, 'sessions', path.basename(file)));
      // 载入会话时聚焦其工作空间（P3-4）：全局默认切到该会话的目录，前端下拉同步显示
      const wsDir = getSessionWorkspace(path.basename(file));
      const ws = workspaceForDir(wsDir);
      if (wsDir && path.resolve(wsDir) !== path.resolve(state.workingDir)) {
        state.workingDir = wsDir; // 审计 P2-5：仅在目录不同时才切换，减少全局状态抖动
        if (ws) touchWorkspace(ws.name);
      }
      json(res, 200, {
        ok: true,
        messages: loaded.messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ role: m.role, content: m.content ?? '' })),
        workspace: ws?.name || null,
        // v0.3.0 P0-2：未完成检查点（供前端提示续跑）
        taskState: loadTaskState(path.basename(file)),
      });
    } catch {
      json(res, 404, { error: '会话不存在' });
    }
    return true;
  }

  if (method === 'POST' && p === '/api/session') {
    const body = await readBody(req, MAX_API_BODY);
    const file = path.basename(String(body.file || ''));
    const full = path.join(home, 'sessions', file);
    if (!file || !fs.existsSync(full)) return json(res, 404, { error: '会话不存在' });
    if (body.action === 'rename') {
      const title = sanitizeTitle(String(body.title || '会话'));
      const renamed = renameSessionFile(fs, path, home, { file: full }, title);
      if (!renamed) return json(res, 500, { error: '重命名失败（可能存在同名会话）' });
      moveSessionWorkspace(file, path.basename(renamed));
      return json(res, 200, { ok: true, file: path.basename(renamed) });
    }
    if (body.action === 'delete') {
      try {
        fs.unlinkSync(full);
        removeSessionWorkspace(file);
        return json(res, 200, { ok: true });
      } catch (/** @type {any} */ err) {
        return json(res, 500, { error: String(err?.message || err) });
      }
    }
    return json(res, 400, { error: '未知操作：rename|delete' });
  }

  // v0.3.0 P0-3：会话收尾（前端「新对话/切换会话」时调用）——在会话边界提取项目记忆+日志，
  // 而非逐轮提取，避免项目记忆文件在会话中途变化破坏前缀缓存（省钱核心）。
  if (method === 'POST' && p === '/api/session-finalize') {
    const body = await readBody(req, MAX_API_BODY);
    const file = path.basename(String(body.file || ''));
    if (!file) return json(res, 400, { error: '缺少 file 参数' });
    try {
      const loaded = loadSession(path.join(home, 'sessions', file));
      if (loaded.messages.length) {
        const wsDir = getSessionWorkspace(file) || state.workingDir;
        const { finalizeSession } = await import('../../../memory.js');
        const lastAsst = [...loaded.messages].reverse().find((/** @type {any} */ m) => m.role === 'assistant');
        await finalizeSession({
          cfg: deps.cfg,
          provider: deps.provider,
          model: titleModel(deps.cfg, state.modelName),
          home,
          workingDir: wsDir,
          messages: loaded.messages,
          turns: loaded.messages.filter((/** @type {any} */ m) => m.role === 'user').length,
          lastText: lastAsst?.content || '',
        });
      }
      // 清掉该会话的项目记忆快照：下次重新打开会用最新记忆重建系统提示
      if (deps.sessionMemoryCache) deps.sessionMemoryCache.delete(file);
      json(res, 200, { ok: true });
    } catch (/** @type {any} */ e) {
      json(res, 500, { error: String(e?.message || e) });
    }
    return true;
  }

  if (method === 'GET' && p === '/api/draft') {
    // 质检 A5：按会话维度读取（无 file 参数用全局槽，兼容旧客户端）
    const key = String(url.searchParams.get('file') || '');
    const text = draftTexts.get(key) || '';
    draftTexts.delete(key); // 读取即清除
    json(res, 200, { ok: true, text });
    return true;
  }

  if (method === 'POST' && p === '/api/draft') {
    const body = await readBody(req, MAX_API_BODY);
    const key = String(body.file || '');
    draftTexts.set(key, String(body.text ?? '').slice(0, 200000));
    json(res, 200, { ok: true });
    return true;
  }

  return false;
}
