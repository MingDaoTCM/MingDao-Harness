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
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { fileURLToPath } from 'node:url';
import { mingdaoHome, ensureHome } from './config.js';
import { isPrivateHost } from './tools/fetch.js';

const LIB_DIR = fileURLToPath(new URL('../skills-lib', import.meta.url));

// ---------- 完整性（P3-3）：技能目录联合哈希 ----------
// 对目录内全部文件（排除 .mingdao-source.json 自身）按相对路径排序，
// 逐文件 sha256 后拼成 "rel:hash\n" 再取一次 sha256，作为目录内容指纹。
/**
 * @param {any} dir
 */
export function skillDirHash(dir) {
  /** @type {any[]} */
  const out = [];
  /** @type {(d: any, base: any) => void} */
  const walk = (d, base) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      const rel = path.join(base, e.name).split(path.sep).join('/');
      if (rel === '.mingdao-source.json') continue;
      if (e.isDirectory()) walk(full, rel);
      else if (e.isFile()) out.push([rel, crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')]);
    }
  };
  walk(dir, '');
  out.sort((a, b) => a[0].localeCompare(b[0]));
  return crypto
    .createHash('sha256')
    .update(out.map(([rel, h]) => `${rel}:${h}`).join('\n'))
    .digest('hex');
}

/**
 * @param {any} dir
 */
export function readSourceMeta(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, '.mingdao-source.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {any} dir
 * @param {any} meta
 */
export function writeSourceMeta(dir, meta) {
  fs.writeFileSync(path.join(dir, '.mingdao-source.json'), JSON.stringify(meta, null, 2) + '\n', { mode: 0o600 });
}

// 显式信任当前内容（用户改过 registry/library 安装的技能后重新记录指纹）
/**
 * @param {any} name
 */
// v0.4.7（T23）：技能名统一校验（纵深防御）。此前只有 uninstallSkill 校验名字，
// trustSkill / reinstallSkill / 库安装入口都直接用入参拼路径——一条名为 ".." 的远端索引条目
// 就足以让 path.join(userSkillsDir(), '..') 指向上级目录（配合 rmSync 后果严重）。
// 单一来源，所有入口共用。
/** @param {any} name @returns {string|null} 合法则返回规范化后的名字，否则 null */
export function assertSafeSkillName(name) {
  const key = String(name ?? '').trim();
  if (!key || key === '.' || key === '..') return null;
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key)) return null;
  if (key.includes('..')) return null;
  return key;
}

export function trustSkill(/** @type {any} */ name) {
  const safe = assertSafeSkillName(name);
  if (!safe) return { error: `技能名非法：${String(name)}` };
  const target = path.join(userSkillsDir(), safe);
  const meta = readSourceMeta(target);
  if (!meta) return { error: `技能 ${name} 没有来源记录（无需 trust）` };
  meta.sha256 = skillDirHash(target);
  meta.trustedAt = Date.now();
  writeSourceMeta(target, meta);
  return { ok: true, name, sha256: meta.sha256.slice(0, 16) };
}

export function skillLibDir() {
  return LIB_DIR;
}

export function userSkillsDir() {
  return path.join(mingdaoHome(), 'skills');
}

// 从技能目录读取 name / description（frontmatter 优先，回退标题/目录名）
/**
 * @param {any} dir
 * @returns {any}
 */
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
  /** @type {any[]} */
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

/**
 * @param {any} kw
 */
export function searchLibrary(kw) {
  const k = String(kw || '').trim().toLowerCase();
  return libraryList().filter(
    (s) => !k || s.name.toLowerCase().includes(k) || (s.description || '').toLowerCase().includes(k)
  );
}

// 安装前 dry-run 校验 SKILL.md 格式（借鉴 npm 打包前的格式检查思路）：
//  - 必须含合法 frontmatter（--- 起止）
//  - name：字母/数字/连字符/点/下划线，1–64 位
//  - description：非空且 ≤ 200 字
// 校验失败返回具体错误，绝不装入技能目录。
/**
 * @param {any} text
 * @param {any} hint
 */
export function validateSkillMarkdown(text, hint) {
  const src = hint ? `（${hint}）` : '';
  if (!text || !String(text).trim()) return { error: `SKILL.md 为空${src}` };
  const fm = String(text).match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!fm) return { error: `缺少 frontmatter（应以 --- 开头并闭合）${src}` };
  const name = fm[1].match(/^name:\s*(.+)$/m)?.[1]?.trim() || '';
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) {
    return { error: `frontmatter.name 非法：${name || '（缺失）'}（允许字母/数字/点/连字符/下划线，1–64 位）${src}` };
  }
  const desc = fm[1].match(/^description:\s*(.+)$/m)?.[1]?.trim() || '';
  if (!desc) return { error: `frontmatter.description 缺失或为空${src}` };
  if (desc.length > 200) return { error: `frontmatter.description 超过 200 字（当前 ${desc.length}）${src}` };
  return { ok: true, name, description: desc };
}

// P1-5（v0.4.5）：检测目录树内是否含符号链接——symlink 可越权读任意本机文件并架空 sha256 指纹检测。
function containsSymlink(/** @type {string} */ dir) {
  const stack = [dir];
  while (stack.length) {
    const d = /** @type {string} */ (stack.pop());
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) return true;
      if (e.isDirectory()) stack.push(path.join(d, e.name));
    }
  }
  return false;
}

/** @param {any} dir @param {any} hint */
export function validateSkillDir(dir, hint) {
  const skillMd = path.join(dir, 'SKILL.md');
  let text;
  try {
    text = fs.readFileSync(skillMd, 'utf8');
  } catch {
    return { error: `未找到 SKILL.md：${skillMd}` };
  }
  if (containsSymlink(dir)) {
    return { error: '技能目录含符号链接，已拒绝（防越权读取本机文件/绕过篡改检测）' };
  }
  return validateSkillMarkdown(text, hint);
}

/**
 * @param {any} dir
 * @param {any} name
 * @param {any} source
 * @param {any} extra
 */
function copySkillIntoUser(dir, name, source, extra) {
  ensureHome();
  const target = path.join(userSkillsDir(), name);
  if (path.resolve(dir) === path.resolve(target)) {
    // 源目录就是用户级安装位置：视为已安装，保持现状
    return { name, dir: target };
  }
  const check = validateSkillDir(dir, name);
  if (check.error) return { error: check.error };
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(dir, target, { recursive: true });
  // 安装即记录内容指纹（P3-3）：加载时校验，被篡改则拒绝加载
  const meta = { source, installedAt: Date.now(), sha256: skillDirHash(target), ...(extra || {}) };
  fs.writeFileSync(path.join(target, '.mingdao-source.json'), JSON.stringify(meta, null, 2) + '\n');
  return { name, dir: target };
}

/**
 * @param {any} name
 */
export function installFromLibrary(name) {
  const found = libraryList().find((s) => s.name === name);
  if (!found) return { error: `技能库中没有 ${name}（mingdao skill search 查看全部）` };
  return copySkillIntoUser(found.dir, found.name, 'library', {});
}

/**
 * @param {any} dir
 */
export function installFromDir(dir) {
  const abs = path.resolve(dir);
  if (!fs.existsSync(path.join(abs, 'SKILL.md'))) {
    return { error: `目录内未找到 SKILL.md：${abs}` };
  }
  const meta = readSkillMeta(abs);
  if (!meta) return { error: `无法解析 SKILL.md：${abs}` };
  return copySkillIntoUser(abs, meta.name, 'dir', { from: abs });
}

/**
 * @param {any} url
 */
export async function installFromUrl(url, { allowPrivate = false } = {}) {
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
    // 审计 P2-1（v0.4.2）：SSRF 防护——与 fetch 工具/validateRemoteUrl 同口径：
    // 初始与每一跳重定向都做私网/回环字面量判定 + DNS 复检（防域名重绑定），跳数上限 5。
    // allowPrivate（CLI 显式输入 URL 时开启）：本地用户自担意图，内网地址可安装；WebUI 默认拦截。
    let cur = u;
    let res = /** @type {any} */ (null);
    for (let hop = 0; hop <= 5; hop++) {
      const ch = String(cur.hostname || '').toLowerCase();
      let blocked = !allowPrivate && isPrivateHost(ch);
      if (!blocked && ch && ch !== 'localhost' && !/^\d{1,3}(\.\d{1,3}){3}$/.test(ch)) {
        try {
          const addrs = await lookup(ch, { all: true, verbatim: true });
          blocked = !allowPrivate && addrs.some((/** @type {any} */ a) => isPrivateHost(a.address));
        } catch {
          // DNS 解析失败：放行，连接阶段会报错
        }
      }
      if (blocked) return { error: `拒绝访问内网/本机地址（${ch}）——SSRF 防护。` };
      res = await fetch(cur, { signal: ctrl.signal, redirect: 'manual' });
      if (res.status >= 300 && res.status < 400) {
        if (hop >= 5) return { error: '重定向次数超过上限（5 跳）。' };
        const loc = res.headers.get('location');
        if (!loc) break;
        try {
          cur = new URL(loc, cur);
        } catch {
          return { error: `非法重定向地址：${loc}` };
        }
        if (cur.protocol !== 'http:' && cur.protocol !== 'https:') {
          return { error: '重定向到非 http(s) 地址，已拒绝。' };
        }
        continue;
      }
      break;
    }
    if (!res) return { error: '下载失败：无响应' };
    if (!res.ok) return { error: `下载失败：HTTP ${res.status}` };
    text = await res.text();
    if (text.length > 512 * 1024) return { error: 'SKILL.md 超过 512KB 上限' };
  } catch (/** @type {any} */ e) {
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
  const check = validateSkillDir(tmp, url);
  if (check.error) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return { error: check.error };
  }
  const meta = readSkillMeta(tmp);
  const r = copySkillIntoUser(tmp, meta.name, 'url', { url });
  fs.rmSync(tmp, { recursive: true, force: true });
  return r;
}

/** 异步 spawn（审计 P1-3）：child_process.spawn + Promise，返回 { error?, code, signal }。 */
function runSpawn(/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {{ timeoutMs?: number }} */ { timeoutMs } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'ignore', timeout: timeoutMs });
    child.on('error', (/** @type {any} */ err) => resolve({ error: err }));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
}

/**
 * @param {any} gitUrl
 */
export async function installFromGit(gitUrl) {
  if (typeof gitUrl !== 'string' || gitUrl.trim().startsWith('-')) {
    return { error: 'git 地址不能以 - 开头（防选项注入）' };
  }
  // 审计 P1-3（v0.4.2）：spawnSync 最长阻塞 120s 冻结整个 Node 事件循环（WebUI 全部并发会话/
  // 权限确认/SSE 流无响应）。改异步 spawn，与 v0.4.1 mountConfigTools 修复同口径。
  const check = await runSpawn('git', ['--version']);
  if (check.error || check.code !== 0) {
    return { error: '未找到 git（git 仓库安装需要系统 git，可用 URL 安装单文件技能）' };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-skill-git-'));
  // -- 分隔符：gitUrl 即使形似选项也只按路径处理
  const r = await runSpawn('git', ['clone', '--depth', '1', '--', gitUrl, tmp], { timeoutMs: 120000 });
  if (r.error || r.code !== 0) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return { error: `git clone 失败：${r.error?.message || (r.signal ? `超时/被终止（${r.signal}）` : `退出码 ${r.code}`)}` };
  }
  const found = [];
  const stack = [tmp];
  while (stack.length && found.length < 20) {
    const dir = /** @type {any} */ (stack.pop());
    /** @type {any[]} */
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
  const installed = [];
  const skipped = [];
  for (const d of found) {
    const meta = readSkillMeta(d);
    const r = copySkillIntoUser(d, meta.name, 'git', { url: gitUrl });
    if (r.error) skipped.push(`${meta.name}：${r.error}`);
    else installed.push(r);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (!installed.length) {
    return { error: `仓库中的技能均未通过校验${skipped.length ? '（' + skipped.join('；') + '）' : ''}` };
  }
  return { names: installed.map((i) => i.name), dirs: installed.map((i) => i.dir), skipped };
}

/**
 * @param {any} name
 */
export function uninstallSkill(/** @type {any} */ name) {
  const key = assertSafeSkillName(name); // v0.4.7：与 trust/reinstall 共用同一校验
  if (!key) return { error: `技能名非法：${String(name)}` };
  const target = path.join(userSkillsDir(), key);
  if (!fs.existsSync(path.join(target, 'SKILL.md'))) {
    return { error: `用户级未安装技能 ${name}（内置技能不可卸载，可同名覆盖）` };
  }
  fs.rmSync(target, { recursive: true, force: true });
  return { name: String(name).trim() };
}

// 按元数据来源重新安装（库：重新复制；url：重新下载；git：重新克隆）
/**
 * @param {any} name
 */
export async function reinstallSkill(/** @type {any} */ name) {
  const safe = assertSafeSkillName(name);
  if (!safe) return { error: `技能名非法：${String(name)}` };
  const target = path.join(userSkillsDir(), safe);
  let meta = /** @type {any} */ ({});
  try {
    meta = JSON.parse(fs.readFileSync(path.join(target, '.mingdao-source.json'), 'utf8'));
  } catch {
    return { error: `未找到安装元数据（${name} 可能是手动创建或内置技能）` };
  }
  if (meta.source === 'library') return installFromLibrary(name);
  if (meta.source === 'url') return installFromUrl(meta.url);
  if (meta.source === 'git') return installFromGit(meta.url);
  if (meta.source === 'dir') return installFromDir(meta.from);
  if (meta.source === 'registry') {
    const { installFromRegistry } = await import('./skill-registry.js');
    return installFromRegistry(name);
  }
  return { error: `未知来源：${meta.source}` };
}

// 统一入口：自动识别 库名 | 本地目录 | SKILL.md URL | git 仓库
/**
 * @param {any} arg
 * @param {{ allowPrivateUrl?: boolean }} [opts] allowPrivateUrl=true 时 URL 安装放行内网地址（CLI 显式输入场景）
 */
export async function installSkill(arg, opts = {}) {
  const a = String(arg || '').trim();
  if (!a) return { error: '缺少参数：mingdao skill install <库名|目录|SKILL.md URL|git 仓库地址>' };
  const libHit = libraryList().find((s) => s.name === a);
  if (libHit) return installFromLibrary(a);
  if (fs.existsSync(path.resolve(a))) return installFromDir(a);
  if (/^https?:\/\//i.test(a)) {
    if (/\.md(#.*)?$/i.test(a.split('?')[0])) return installFromUrl(a, { allowPrivate: opts.allowPrivateUrl === true });
    return installFromGit(a);
  }
  if (/^git@/.test(a)) return installFromGit(a);
  if (/^[A-Za-z0-9_.-]+$/.test(a)) {
    // 本地库没有：回退线上 registry（离线时报错并给出提示）
    const { installFromRegistry } = await import('./skill-registry.js');
    return installFromRegistry(a);
  }
  return { error: `无法识别安装来源：${a}（支持：技能库名 / 本地目录 / SKILL.md 的 http(s) URL / git 仓库地址）` };
}
