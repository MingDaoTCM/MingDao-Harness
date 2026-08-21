// 技能库（借鉴 WorkBuddy 技能市场「搜索 + 一键安装」的思路）：
//  - 内置技能库 <安装包>/skills-lib/：预置常用技能，按需安装，不默认注入系统提示
//  - 安装来源四选一（自动识别）：
//      · 库名      → 从内置库复制（mingdao skill install sql）
//      · 本地目录   → 目录内含 SKILL.md 即整体复制
//      · 远程 URL   → http(s) 下载单个 SKILL.md（.md 结尾）
//      · git 仓库   → git clone --depth 1 后扫描含 SKILL.md 的目录
//  - 统一安装到用户级 <home>/skills/<name>/：可编辑、可删除、同名覆盖内置（用户级优先级最高）
//  - 每个技能写 .mingdao-source.json 记录来源，供卸载 / 重新安装（update）使用
//  - 安装后自动进入系统提示技能清单，Agent 按需用 skill 工具加载全文（渐进式披露）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mingdaoHome, ensureHome } from './config.js';

const LIB_DIR = fileURLToPath(new URL('../skills-lib', import.meta.url));

export function skillLibDir() {
  return LIB_DIR;
}

export function userSkillsDir() {
  return path.join(mingdaoHome(), 'skills');
}

// 从技能目录读取 name / description（frontmatter 优先，回退标题/目录名）
function readSkillMeta(dir) {
  try {
    const text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    const fm = text.match(/^---\n([\s\S]*?)\n---/);
    let name = '';
    let description = '';
    if (fm) {
      name = fm[1].match(/^name:\s*(.+)$/m)?.[1]?.trim() || '';
      description = fm[1].match(/^description:\s*(.+)$/m)?.[1]?.trim() || '';
    }
    if (!name) name = path.basename(dir);
    if (!description) description = text.match(/^#\s+(.+)$/m)?.[1]?.trim() || '';
    return { name, description };
  } catch {
    return null;
  }
}

export function installedUserSkillNames() {
  const out = new Set();
  let entries;
  try {
    entries = fs.readdirSync(userSkillsDir(), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      if (fs.statSync(path.join(userSkillsDir(), e.name, 'SKILL.md')).isFile()) out.add(e.name);
    } catch {}
  }
  return out;
}

export function libraryList() {
  const installed = installedUserSkillNames();
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(LIB_DIR, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const meta = readSkillMeta(path.join(LIB_DIR, e.name));
    if (!meta) continue;
    out.push({ ...meta, dir: path.join(LIB_DIR, e.name), installed: installed.has(meta.name) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function searchLibrary(kw) {
  const k = String(kw || '').trim().toLowerCase();
  return libraryList().filter(
    (s) => !k || s.name.toLowerCase().includes(k) || (s.description || '').toLowerCase().includes(k)
  );
}

function copySkillIntoUser(dir, name, source, extra) {
  ensureHome();
  const target = path.join(userSkillsDir(), name);
  if (path.resolve(dir) === path.resolve(target)) {
    // 源目录就是用户级安装位置：视为已安装，保持现状
    return { name, dir: target };
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(dir, target, { recursive: true });
  fs.writeFileSync(
    path.join(target, '.mingdao-source.json'),
    JSON.stringify({ source, installedAt: Date.now(), ...(extra || {}) }, null, 2) + '\n'
  );
  return { name, dir: target };
}

export function installFromLibrary(name) {
  const found = libraryList().find((s) => s.name === name);
  if (!found) return { error: `技能库中没有 ${name}（mingdao skill search 查看全部）` };
  return copySkillIntoUser(found.dir, found.name, 'library', {});
}

export function installFromDir(dir) {
  const abs = path.resolve(dir);
  if (!fs.existsSync(path.join(abs, 'SKILL.md'))) {
    return { error: `目录内未找到 SKILL.md：${abs}` };
  }
  const meta = readSkillMeta(abs);
  if (!meta) return { error: `无法解析 SKILL.md：${abs}` };
  return copySkillIntoUser(abs, meta.name, 'dir', { from: abs });
}

export async function installFromUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { error: 'URL 无效' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { error: '仅支持 http/https URL（下载单个 SKILL.md）' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  let text;
  try {
    const res = await fetch(u, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) return { error: `下载失败：HTTP ${res.status}` };
    text = await res.text();
    if (text.length > 512 * 1024) return { error: 'SKILL.md 超过 512KB 上限' };
  } catch (e) {
    return { error: `下载失败：${e.name === 'AbortError' ? '30 秒超时' : e.message}` };
  } finally {
    clearTimeout(timer);
  }
  const head = text.trim();
  if (!head.startsWith('---') && !head.startsWith('# ')) {
    return { error: '内容不是合法的 SKILL.md（需 frontmatter 或 # 标题开头）' };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-skill-'));
  fs.writeFileSync(path.join(tmp, 'SKILL.md'), text);
  const meta = readSkillMeta(tmp);
  const r = copySkillIntoUser(tmp, meta.name, 'url', { url });
  fs.rmSync(tmp, { recursive: true, force: true });
  return r;
}

export function installFromGit(gitUrl) {
  const check = spawnSync('git', ['--version'], { stdio: 'ignore' });
  if (check.error || check.status !== 0) {
    return { error: '未找到 git（git 仓库安装需要系统 git，可用 URL 安装单文件技能）' };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-skill-git-'));
  const r = spawnSync('git', ['clone', '--depth', '1', gitUrl, tmp], { stdio: 'ignore', timeout: 120000 });
  if (r.error || r.status !== 0) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return { error: `git clone 失败：${r.error?.message || `退出码 ${r.status}`}` };
  }
  const found = [];
  const stack = [tmp];
  while (stack.length && found.length < 20) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
      found.push(dir);
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory() && e.name !== '.git') stack.push(path.join(dir, e.name));
    }
  }
  if (!found.length) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return { error: '仓库中未找到含 SKILL.md 的技能目录' };
  }
  ensureHome();
  const installed = found.map((d) => {
    const meta = readSkillMeta(d);
    return copySkillIntoUser(d, meta.name, 'git', { url: gitUrl });
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  return { names: installed.map((i) => i.name), dirs: installed.map((i) => i.dir) };
}

export function uninstallSkill(name) {
  const target = path.join(userSkillsDir(), String(name).trim());
  if (!/^[A-Za-z0-9_.-]+$/.test(String(name)) || !fs.existsSync(path.join(target, 'SKILL.md'))) {
    return { error: `用户级未安装技能 ${name}（内置技能不可卸载，可同名覆盖）` };
  }
  fs.rmSync(target, { recursive: true, force: true });
  return { name: String(name).trim() };
}

// 按元数据来源重新安装（库：重新复制；url：重新下载；git：重新克隆）
export async function reinstallSkill(name) {
  const target = path.join(userSkillsDir(), name);
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(path.join(target, '.mingdao-source.json'), 'utf8'));
  } catch {
    return { error: `未找到安装元数据（${name} 可能是手动创建或内置技能）` };
  }
  if (meta.source === 'library') return installFromLibrary(name);
  if (meta.source === 'url') return installFromUrl(meta.url);
  if (meta.source === 'git') return installFromGit(meta.url);
  if (meta.source === 'dir') return installFromDir(meta.from);
  return { error: `未知来源：${meta.source}` };
}

// 统一入口：自动识别 库名 | 本地目录 | SKILL.md URL | git 仓库
export async function installSkill(arg) {
  const a = String(arg || '').trim();
  if (!a) return { error: '缺少参数：mingdao skill install <库名|目录|SKILL.md URL|git 仓库地址>' };
  const libHit = libraryList().find((s) => s.name === a);
  if (libHit) return installFromLibrary(a);
  if (fs.existsSync(path.resolve(a))) return installFromDir(a);
  if (/^https?:\/\//i.test(a)) {
    if (/\.md(#.*)?$/i.test(a.split('?')[0])) return installFromUrl(a);
    return installFromGit(a);
  }
  if (/^git@/.test(a)) return installFromGit(a);
  if (/^[A-Za-z0-9_.-]+$/.test(a)) return { error: `技能库中没有 ${a}（mingdao skill search 查看全部）` };
  return { error: `无法识别安装来源：${a}（支持：技能库名 / 本地目录 / SKILL.md 的 http(s) URL / git 仓库地址）` };
}
