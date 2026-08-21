// 工作空间：项目目录注册表（参考 WorkBuddy 的项目组织思路）——
// 为常做的项目登记名称与目录，一键回到对应项目，配置与记忆随目录（AGENTS.md / .mingdao/skills 等）自然跟随。
// 注册表：<mingdao-home>/workspaces.json → { "<名称>": { dir, createdAt, lastUsed } }
// 命令：mingdao workspace add/list/use/path/remove

import fs from 'node:fs';
import path from 'node:path';
import { mingdaoHome, ensureHome } from './config.js';

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

export function saveWorkspaces(ws) {
  ensureHome();
  // 原子写：临时文件 + rename，避免崩溃后注册表被冲空
  const target = workspacesFile();
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(ws, null, 2) + '\n');
  fs.renameSync(tmp, target);
}

export function addWorkspace(name, dir) {
  const key = String(name).trim();
  if (!key) return { error: '名称不能为空' };
  if (/[\\/]/.test(key)) return { error: '名称不能包含路径分隔符' };
  const target = path.resolve(dir || process.cwd());
  if (!fs.existsSync(target)) return { error: `目录不存在：${target}` };
  const ws = loadWorkspaces();
  ws[key] = { dir: target, createdAt: ws[key]?.createdAt || Date.now(), lastUsed: Date.now() };
  saveWorkspaces(ws);
  return { name: key, dir: target };
}

export function removeWorkspace(name) {
  const ws = loadWorkspaces();
  if (!ws[name]) return false;
  delete ws[name];
  saveWorkspaces(ws);
  return true;
}

export function renameWorkspace(name, newName) {
  const key = String(newName).trim();
  if (!key) return { error: '新名称不能为空' };
  if (/[\\/]/.test(key)) return { error: '名称不能包含路径分隔符' };
  if (key === name) return { name: key }; // 原样改名：无操作，避免自删条目
  const ws = loadWorkspaces();
  if (!ws[name]) return { error: `工作空间 ${name} 不存在` };
  if (ws[key]) return { error: `名称 ${key} 已存在` };
  ws[key] = { ...ws[name] };
  delete ws[name];
  saveWorkspaces(ws);
  return { name: key };
}

// 修改目录：登记同名即可覆盖目录
export function setWorkspaceDir(name, dir) {
  return addWorkspace(name, dir);
}

export function workspacePath(name) {
  return loadWorkspaces()[name]?.dir || null;
}

export function touchWorkspace(name) {
  const ws = loadWorkspaces();
  if (!ws[name]) return false;
  ws[name].lastUsed = Date.now();
  saveWorkspaces(ws);
  return true;
}

export function listWorkspaces() {
  return Object.entries(loadWorkspaces())
    .map(([name, w]) => ({ name, ...w }))
    .sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
}

// 当前目录是否已登记（供横幅/提示）
export function currentWorkspace(cwd) {
  const target = path.resolve(cwd);
  const hit = listWorkspaces().find((w) => path.resolve(w.dir) === target);
  return hit || null;
}
