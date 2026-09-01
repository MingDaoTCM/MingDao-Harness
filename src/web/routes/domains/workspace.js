// 工作空间域（Phase C C1）：/api/workspaces /api/fs-browse
// 工作空间登记/切换/重命名/删除；受限目录浏览（基目录白名单）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  currentWorkspace,
  listWorkspaces,
  addWorkspace,
  removeWorkspace,
  renameWorkspace,
  setWorkspaceDir,
  workspacePath,
  touchWorkspace,
  setSessionWorkspace,
} from '../../../workspace.js';

/**
 * 工作空间域路由。命中返回 true，未命中返回 false。
 * @param {{req:any,res:any,method:any,p:any,url:any}} ctx
 * @param {any} deps
 * @param {{json:any,readBody:any,MAX_API_BODY:any}} shared
 */
export async function handle({ req, res, method, p, url }, deps, shared) {
  const { json, readBody, MAX_API_BODY } = shared;
  const { cfg, state, startupCwd } = deps;

  if (method === 'GET' && p === '/api/workspaces') {
    json(res, 200, { ok: true, workspaces: listWorkspaces(), current: currentWorkspace(state.workingDir)?.name || null, cwd: state.workingDir });
    return true;
  }

  if (method === 'POST' && p === '/api/workspaces') {
    const body = await readBody(req, MAX_API_BODY);
    const name = String(body.name || '').trim();
    if (body.action === 'add') {
      if (!name) return json(res, 400, { error: '名称不能为空' });
      // 目录为空/不存在时自动新建（默认开，create:false 关闭）
      const target = path.resolve(body.dir || state.workingDir);
      if (body.create !== false) {
        try {
          fs.mkdirSync(target, { recursive: true });
        } catch (/** @type {any} */ e) {
          return json(res, 400, { error: `无法创建目录：${target}（${e.message}）` });
        }
      }
      const r = addWorkspace(name, target);
      if (r.error) return json(res, 400, { error: r.error });
      return json(res, 200, { ok: true, name: r.name, dir: r.dir, created: body.create !== false });
    }
    if (body.action === 'rename') {
      const r = renameWorkspace(name, body.newName);
      if (r.error) return json(res, 400, { error: r.error });
      return json(res, 200, { ok: true, name: r.name });
    }
    if (body.action === 'set') {
      // 切换全局工作空间（新会话默认目录；可带 dir 修改目录）；目录缺失自动重建。
      // 携带 file 时同时把当前会话的工作空间切过去（P3-4：会话跟随显式切换）。
      if (body.dir) {
        const r = setWorkspaceDir(name, body.dir);
        if (r.error) return json(res, 400, { error: r.error });
      }
      const dir = workspacePath(name);
      if (!dir) return json(res, 400, { error: `工作空间 ${name} 不存在` });
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (/** @type {any} */ e) {
        return json(res, 400, { error: `无法创建目录：${dir}（${e.message}）` });
      }
      touchWorkspace(name);
      state.workingDir = dir;
      // 不再 process.chdir：运行中任务的 cwd 在创建时已固定，全局切换只影响新会话
      if (body.file) setSessionWorkspace(String(body.file), dir, /** @type {any} */ (name));
      return json(res, 200, { ok: true, name, dir, current: name });
    }
    if (body.action === 'remove') {
      if (!name) return json(res, 400, { error: '缺少名称' });
      return json(res, 200, { ok: removeWorkspace(name) });
    }
    return json(res, 400, { error: '未知操作：add|rename|set|remove' });
  }

  // 目录浏览器（「新建工作空间」选择电脑磁盘目录用）：本机运行时即用户电脑的目录树；
  // 只列子目录（不含隐藏目录），供前端逐级导航选择
  if (method === 'GET' && p === '/api/fs-browse') {
    let dir = String(url.searchParams.get('dir') || '').trim();
    if (!path.isAbsolute(dir)) return json(res, 400, { error: '需要绝对路径' });
    // 质检 A3：目录浏览限定基目录（默认家目录 + config.web.browseRoots 显式授权），
    // 拒绝越界——此前可枚举服务器任意绝对路径（整机目录结构探测面）
    const browseRoots = [os.homedir(), startupCwd, state.workingDir, ...(Array.isArray(cfg.web?.browseRoots) ? cfg.web.browseRoots : [])].map((r) => path.resolve(String(r)));
    const inRoot = browseRoots.some((r) => dir === r || dir.startsWith(r + path.sep));
    if (!inRoot) return json(res, 403, { error: '目录不在可浏览范围内（家目录或 web.browseRoots 授权目录）' });
    try {
      const st = fs.statSync(dir);
      if (!st.isDirectory()) return json(res, 400, { error: '不是目录' });
      const entries = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
        .slice(0, 300);
      let parent = path.dirname(dir);
      // 父目录同样不得越出基目录
      if (!browseRoots.some((r) => parent === r || parent.startsWith(r + path.sep))) parent = /** @type {any} */ (null);
      json(res, 200, { ok: true, path: dir, parent: parent === dir ? null : parent, entries });
    } catch (/** @type {any} */ err) {
      json(res, 400, { error: String(err?.message || err) });
    }
    return true;
  }

  return false;
}
