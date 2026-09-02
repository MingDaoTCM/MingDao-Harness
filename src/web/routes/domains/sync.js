// 同步域（Phase C C1）：/api/sync /api/sync-conflicts
// 云同步登录/登出/推拉/改密/分享与冲突处理。
import {
  syncStatus,
  syncLogin,
  syncLogout,
  syncPush,
  syncPull,
  syncRemoteList,
  syncChangePassword,
  syncShareCreate,
  syncShareList,
  syncShareAccept,
  syncShareRevoke,
  listSyncConflicts,
  resolveSyncConflict,
} from '../../../sync.js';

/**
 * 同步域路由。命中返回 true，未命中返回 false。
 * @param {{req:any,res:any,method:any,p:any,url:any}} ctx
 * @param {any} deps
 * @param {{json:any,readBody:any,MAX_API_BODY:any,validateRemoteUrl:any}} shared
 */
export async function handle({ req, res, method, p, url }, deps, shared) {
  const { json, readBody, MAX_API_BODY, validateRemoteUrl } = shared;

  if (method === 'GET' && p === '/api/sync') {
    const st = syncStatus();
    let remote = null;
    if (st.loggedIn) {
      const r = await syncRemoteList();
      remote = r.ok ? { sessions: r.sessions.slice(0, 50) } : { error: r.error };
    }
    json(res, 200, { ok: true, ...st, remote });
    return true;
  }

  if (method === 'POST' && p === '/api/sync') {
    const body = await readBody(req, MAX_API_BODY);
    if (body.action === 'login') {
      const vurl = await validateRemoteUrl(body.url); // 质检 S1：SSRF 防护（同步端点同样只允许公网）
      if (vurl.error) return json(res, 400, { error: vurl.error });
      const r = await syncLogin({ url: body.url, username: body.username, password: body.password, deviceName: body.deviceName });
      if (r.error) return json(res, 400, { error: r.error });
      return json(res, 200, { ok: true, ...r });
    }
    if (body.action === 'logout') {
      syncLogout();
      return json(res, 200, { ok: true });
    }
    if (body.action === 'push') {
      const r = /** @type {any} */ (await syncPush(body.name));
      if (r.error) return json(res, 400, { error: r.error });
      return json(res, 200, { ok: true, pushed: r.pushed.length, conflicts: r.conflicts });
    }
    if (body.action === 'pull') {
      const r = /** @type {any} */ (await syncPull(body.name));
      if (r.error) return json(res, 400, { error: r.error });
      return json(res, 200, { ok: true, pulled: r.pulled.length, conflicts: r.conflicts });
    }
    if (body.action === 'passwd') {
      const r = await syncChangePassword({ oldPassword: body.oldPassword, newPassword: body.newPassword });
      if (r.error) return json(res, 400, { error: r.error });
      return json(res, 200, { ok: true });
    }
    if (body.action === 'share') {
      const r = await syncShareCreate(body.name);
      if (r.error) return json(res, 400, { error: r.error });
      return json(res, 200, { ok: true, shareId: r.shareId, name: r.name });
    }
    if (body.action === 'shares') {
      const r = await syncShareList();
      if (r.error) return json(res, 400, { error: r.error });
      return json(res, 200, { ok: true, mine: r.mine, accepted: r.accepted });
    }
    if (body.action === 'accept') {
      const r = await syncShareAccept(body.shareId);
      if (r.error) return json(res, 400, { error: r.error });
      return json(res, 200, { ok: true, ...r });
    }
    if (body.action === 'unshare') {
      const r = await syncShareRevoke(body.shareId);
      if (r.error) return json(res, 400, { error: r.error });
      return json(res, 200, { ok: true });
    }
    if (body.action === 'resolveConflict') {
      const r = resolveSyncConflict(body.base, body.choice);
      if (r.error) return json(res, 400, { error: r.error });
      return json(res, 200, { ok: true, ...r });
    }
    return json(res, 400, { error: '未知操作：login|logout|push|pull|passwd|share|shares|accept|unshare|resolveConflict' });
  }

  if (method === 'GET' && p === '/api/sync-conflicts') {
    json(res, 200, { ok: true, conflicts: listSyncConflicts() });
    return true;
  }

  return false;
}
