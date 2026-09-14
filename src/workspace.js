// 工作空间：项目目录注册表（参考 WorkBuddy 的项目组织思路）——
// 为常做的项目登记名称与目录，一键回到对应项目，配置与记忆随目录（AGENTS.md / .mingdao/skills 等）自然跟随。
// 注册表：<mingdao-home>/workspaces.json → { "<名称>": { dir, createdAt, lastUsed } }
// 命令：mingdao workspace add/list/use/path/remove

import fs from 'node:fs';
import path from 'node:path';
import { mingdaoHome, ensureHome } from './config.js';
import { atomicWriteFileSync, withFileLockSync } from './atomic-write.js';

export function workspacesFile() {
  return path.join(mingdaoHome(), 'workspaces.json');
}

export function loadWorkspaces() {
  try {
    const j = JSON.parse(fs.readFileSync(workspacesFile(), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

/**
 * 写注册表，**返回结果而不是静默吞掉**（v0.6.2，audit-report B-WS-1/2 第五处）。
 *
 * 危害形态是**假成功**：调用方（addWorkspace / renameWorkspace）无论写没写成
 * 都返回 `{ok:true}`，CLI 与 WebUI 于是照常打印「✓ 已添加」。用户以为登记好了，
 * 实际 `mingdao workspace list` 里永远不会有它——下次进入项目时目录也没跟着切换。
 * @param {any} ws @returns {{ok: boolean, error: string|null}}
 */
export function saveWorkspaces(/** @type {any} */ ws) {
  try {
    ensureHome();
    // 原子写（评估 6.6）：随机 tmp 名 + rename，避免崩溃冲空与跨进程共名 tmp 串扰
    atomicWriteFileSync(workspacesFile(), JSON.stringify(ws, null, 2) + '\n');
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: String(/** @type {any} */ (err)?.message ?? err) };
  }
}

export function addWorkspace(/** @type {any} */ name, /** @type {any} */ dir) {
  const key = String(name).trim();
  if (!key) return { error: '名称不能为空' };
  if (/[\\/]/.test(key)) return { error: '名称不能包含路径分隔符' };
  const target = path.resolve(dir || process.cwd());
  if (!fs.existsSync(target)) return { error: `目录不存在：${target}` };
  // v0.4.7（T19）：读-改-写必须在跨进程锁内——WebUI 每次建会话都会 touch 工作空间，
  // 与 CLI 的 add/remove 并发时未加锁会丢更新（注册表少一条工作空间）。
  return withFileLockSync(workspacesFile() + '.lock', () => {
    const ws = loadWorkspaces();
    ws[key] = { dir: target, createdAt: ws[key]?.createdAt || Date.now(), lastUsed: Date.now() };
    const saved = saveWorkspaces(ws);
    if (!saved.ok) return { error: `工作空间注册表写入失败：${saved.error}` };
    return { ok: true, name: key, dir: target };
  });
}

export function removeWorkspace(/** @type {any} */ name) {
  return withFileLockSync(workspacesFile() + '.lock', () => {
    const ws = loadWorkspaces();
    if (!ws[name]) return false;
    delete ws[name];
    const saved = saveWorkspaces(ws);
    // 返回类型仍是 true/false（调用方存在性判断），写失败用 {error} 区分——
    // 只回 false 会被读成「没找到这个工作空间」，那是另一回事
    if (!saved.ok) return { error: `工作空间注册表写入失败：${saved.error}` };
    return true;
  });
}

export function renameWorkspace(/** @type {any} */ name, /** @type {any} */ newName) {
  const key = String(newName).trim();
  if (!key) return { error: '新名称不能为空' };
  if (/[\\/]/.test(key)) return { error: '名称不能包含路径分隔符' };
  if (key === name) return { name: key }; // 原样改名：无操作，避免自删条目
  return withFileLockSync(workspacesFile() + '.lock', () => {
    const ws = loadWorkspaces();
    if (!ws[name]) return { error: `工作空间 ${name} 不存在` };
    if (ws[key]) return { error: `名称 ${key} 已存在` };
    ws[key] = { ...ws[name] };
    delete ws[name];
    const saved = saveWorkspaces(ws);
    if (!saved.ok) return { error: `工作空间注册表写入失败：${saved.error}` };
    return { ok: true, name: key };
  });
}

// 修改目录：登记同名即可覆盖目录
export function setWorkspaceDir(/** @type {any} */ name, /** @type {any} */ dir) {
  return addWorkspace(name, dir);
}

export function workspacePath(/** @type {any} */ name) {
  return loadWorkspaces()[name]?.dir || null;
}

export function touchWorkspace(/** @type {any} */ name) {
  // v0.4.7（T19）：同上，加锁防并发丢更新
  return withFileLockSync(workspacesFile() + '.lock', () => {
    const ws = loadWorkspaces();
    if (!ws[name]) return false;
    ws[name].lastUsed = Date.now();
    saveWorkspaces(ws);
    return true;
  });
}

export function listWorkspaces() {
  return Object.entries(loadWorkspaces())
    .map(([name, w]) => ({ name, ...w }))
    .sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
}

// 当前目录是否已登记（供横幅/提示）
export function currentWorkspace(/** @type {any} */ cwd) {
  const target = path.resolve(cwd);
  const hit = listWorkspaces().find((w) => path.resolve(w.dir) === target);
  return hit || null;
}

// 按目录反查工作空间名（会话记录的是目录，展示时需要名字）
export function workspaceForDir(/** @type {any} */ dir) {
  if (!dir) return null;
  const target = path.resolve(dir);
  return listWorkspaces().find((w) => path.resolve(w.dir) === target) || null;
}

// —— 会话级工作空间（P3-4）：WebUI 并行任务互不串目录 ——
// 每个会话记住自己的工作目录；运行中的任务使用会话记录目录，全局切换只影响新会话，
// 不再有 process.chdir 影响所有运行中任务的全局副作用。
export function sessionWorkspacesFile() {
  return path.join(mingdaoHome(), 'session-workspaces.json');
}

export function loadSessionWorkspaces() {
  try {
    const j = JSON.parse(fs.readFileSync(sessionWorkspacesFile(), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

// 会话→目录映射写失败：后果是「这个会话记不住自己的工作目录」，下个回合可能落到错误目录。
// 这里没有逐层把结果透到 WebUI 横幅（调用链太长），因此用一次性 console.warn 保证**至少不无声**。
let sessionMapWarned = false;
let lastSessionMapError = /** @type {string|null} */ (null);

/** 会话→目录映射最近一次写失败原因（无则 null）。 */
export function sessionWorkspaceWriteError() {
  return lastSessionMapError;
}

/**
 * @param {any} map @returns {{ok: boolean, error: string|null}}
 */
export function saveSessionWorkspaces(/** @type {any} */ map) {
  try {
    ensureHome();
    // 原子写（评估 6.6）：随机 tmp 名 + rename
    atomicWriteFileSync(sessionWorkspacesFile(), JSON.stringify(map, null, 2) + '\n', { mode: 0o600 });
    return { ok: true, error: null };
  } catch (err) {
    const msg = String(/** @type {any} */ (err)?.message ?? err);
    lastSessionMapError = msg;
    if (!sessionMapWarned) {
      sessionMapWarned = true;
      console.warn(
        `[MingDao] ⚠ 会话工作目录映射写入失败：${msg}\n` +
          `  该会话下个回合可能回到默认目录（记不住工作空间）；请检查 ${sessionWorkspacesFile()} 的磁盘空间与权限。`
      );
    }
    return { ok: false, error: msg };
  }
}

export function getSessionWorkspace(/** @type {any} */ sessionName) {
  return loadSessionWorkspaces()[sessionName]?.dir || null;
}

export function setSessionWorkspace(/** @type {any} */ sessionName, /** @type {any} */ dir, wsName = null) {
  // v0.4.7（T19）：多标签页/多任务并行时会话级映射同样会被并发改写
  return withFileLockSync(sessionWorkspacesFile() + '.lock', () => {
    const map = loadSessionWorkspaces();
    map[sessionName] = { dir: path.resolve(dir), name: wsName || workspaceForDir(dir)?.name || null, at: Date.now() };
    saveSessionWorkspaces(map);
  });
}

export function removeSessionWorkspace(/** @type {any} */ sessionName) {
  return withFileLockSync(sessionWorkspacesFile() + '.lock', () => {
    const map = loadSessionWorkspaces();
    if (!map[sessionName]) return false;
    delete map[sessionName];
    saveSessionWorkspaces(map);
    return true;
  });
}

// 会话改名时迁移映射（记录保留）
export function moveSessionWorkspace(/** @type {any} */ oldName, /** @type {any} */ newName) {
  return withFileLockSync(sessionWorkspacesFile() + '.lock', () => {
    const map = loadSessionWorkspaces();
    if (!map[oldName]) return false;
    map[newName] = map[oldName];
    delete map[oldName];
    saveSessionWorkspaces(map);
    return true;
  });
}
