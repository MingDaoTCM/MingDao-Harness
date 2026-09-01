// 技能库线上 registry 客户端（零依赖，纯 fetch + 本地缓存）：
//  - 默认 registry：MingDao-Harness 仓库 registry/index.json（github/gitee/gitcode 三镜像自动回退）
//  - 自建 registry：设置环境变量 MINGDAO_REGISTRY_URL 指向自己的 index.json（企业内网可用）
//  - 本地缓存 <home>/skill-registry-cache.json，TTL 1 小时（force 可强制刷新）
//  - 安装：按索引逐文件下载 → dry-run 校验 frontmatter → 写入用户级技能目录
//    （来源元数据 source=registry，mingdao skill update 可重装）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { mingdaoHome, ensureHome } from './config.js';
import { userSkillsDir, validateSkillDir, installedUserSkillNames, skillDirHash, writeSourceMeta } from './skill-lib.js';

const DEFAULT_HOSTS = [
  'https://raw.githubusercontent.com/MingDaoTCM/MingDao-Harness/main',
  'https://gitee.com/MingDaoTCM/MingDao-harness/raw/main',
  'https://gitcode.com/MingDaoTCM/MingDao-Harness/raw/main',
];

const TTL_MS = 60 * 60 * 1000;
const MAX_FILE = 512 * 1024;

function registryBase() {
  const env = process.env.MINGDAO_REGISTRY_URL;
  if (env) {
    const u = String(env).replace(/\/index\.json$/, '').replace(/\/+$/, '');
    return { hosts: [u], isCustom: true };
  }
  return { hosts: DEFAULT_HOSTS, isCustom: false };
}

function cacheFile() {
  return path.join(mingdaoHome(), 'skill-registry-cache.json');
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
  } catch {
    return null;
  }
}

function saveCache(/** @type {any} */ data, /** @type {any} */ host) {
  try {
    ensureHome();
    fs.writeFileSync(cacheFile(), JSON.stringify({ fetchedAt: Date.now(), host, data }, null, 2) + '\n', { mode: 0o600 });
  } catch {}
}

async function fetchText(/** @type {any} */ url, timeoutMs = 20000, maxBytes = 2 * 1024 * 1024) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Content-Length 预检：超限直接拒绝，不再全量下载进内存
    const len = Number(res.headers.get('content-length'));
    if (Number.isFinite(len) && len > maxBytes) throw new Error('响应超过大小上限');
    const text = await res.text();
    if (text.length > maxBytes) throw new Error('响应超过大小上限');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// 取远端索引（缓存优先；force 强制刷新；allowNetwork=false 时只读缓存，用于 WebUI 常规加载避免阻塞）
export async function fetchRegistryIndex({ force = false, allowNetwork = true } = {}) {
  const cached = loadCache();
  const fresh = cached && Date.now() - cached.fetchedAt < TTL_MS;
  if (!force && (fresh || !allowNetwork)) {
    if (cached?.data?.skills) return { data: cached.data, host: cached.host, fromCache: true, stale: !fresh };
    if (!allowNetwork) {
      return { error: '尚无线上技能库缓存（点击「刷新线上」拉取，或设置 MINGDAO_REGISTRY_URL 指向自建 registry）' };
    }
  }
  const { hosts } = registryBase();
  let lastErr = null;
  for (const host of hosts) {
    try {
      const text = await fetchText(`${host}/registry/index.json`, 8000);
      const data = JSON.parse(text);
      if (!Array.isArray(data.skills)) throw new Error('索引缺少 skills 数组');
      saveCache(data, host);
      return { data, host, fromCache: false };
    } catch (e) {
      lastErr = e;
    }
  }
  // 网络失败时回退旧缓存（过期也可用）
  if (cached?.data?.skills) return { data: cached.data, host: cached.host, fromCache: true, stale: true };
  return { error: `无法获取线上技能库：${(/** @type {any} */ (lastErr))?.message || '网络不可达'}（可用 MINGDAO_REGISTRY_URL 指向自建 registry）` };
}

// 远端搜索（合并展示：name/description/source/installed）
export async function searchRegistry(/** @type {any} */ kw, { force = false, allowNetwork = true } = {}) {
  const r = await fetchRegistryIndex({ force, allowNetwork });
  if (r.error) return { error: r.error };
  const k = String(kw || '').trim().toLowerCase();
  const installed = installedUserSkillNames();
  const skills = r.data.skills
    .filter((/** @type {any} */ s) => !k || s.name.toLowerCase().includes(k) || (s.description || '').toLowerCase().includes(k))
    .map((/** @type {any} */ s) => ({ name: s.name, description: s.description, source: 'registry', installed: installed.has(s.name) }));
  return { skills, host: r.host, updatedAt: r.data.updatedAt, fromCache: r.fromCache, stale: r.stale || false };
}

// 按索引安装（逐文件下载 + dry-run 校验）
export async function installFromRegistry(/** @type {any} */ name) {
  const r = await fetchRegistryIndex();
  if (r.error) return { error: r.error };
  const entry = r.data.skills.find((/** @type {any} */ s) => s.name === name);
  if (!entry) return { error: `线上技能库中没有 ${name}（mingdao skill search 查看）` };
  if (!Array.isArray(entry.files) || !entry.files.length) return { error: `技能 ${name} 的索引缺少文件清单` };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-reg-'));
  try {
    // 逐文件下载按镜像回退（审计：国内网络下 raw.githubusercontent 常超时/被断，
    // 此前只试首选主机 → 安装报「This operation was aborted」；gitee/gitcode 国内秒开）
    const hosts = [r.host, ...registryBase().hosts.filter((h) => h !== r.host)];
    let verified = false; // 是否至少一个文件做了 sha256 校验（索引声明了哈希才校验）
    for (const f of entry.files) {
      const rel = String(f.path || '').replace(/\\/g, '/');
      if (!rel || rel.includes('..') || rel.startsWith('/')) {
        return { error: `技能 ${name} 的文件路径非法：${f.path}` };
      }
      const dest = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      let text = null;
      let lastErr = '';
      for (const host of hosts) {
        try {
          text = await fetchText(`${host}/skills-lib/${encodeURI(name)}/${rel.split('/').map(encodeURIComponent).join('/')}`, 30000, MAX_FILE);
          break;
        } catch (e) {
          const ee = /** @type {any} */ (e);
          lastErr = ee?.name === 'AbortError' ? '下载超时' : String(ee?.message || ee);
        }
      }
      if (text === null) return { error: `下载 ${name}/${rel} 失败：${lastErr}（已尝试全部镜像）` };
      if (text.length > MAX_FILE) return { error: `${name}/${rel} 超过 512KB 上限` };
      // 完整性校验（P3-3）：索引声明 sha256 时逐文件比对，不符即拒绝安装（供应链防护）
      if (f.sha256 && typeof f.sha256 === 'string') {
        const got = crypto.createHash('sha256').update(text).digest('hex');
        if (got !== f.sha256.toLowerCase()) {
          return { error: `完整性校验失败：${name}/${rel} 与 registry 声明的 sha256 不符（文件可能被篡改或索引过期），已拒绝安装` };
        }
        verified = true;
      }
      fs.writeFileSync(dest, text);
    }
    const check = validateSkillDir(tmp, name);
    if (check.error) return { error: check.error };
    const target = path.join(userSkillsDir(), name);
    if (path.resolve(tmp) !== path.resolve(target)) {
      ensureHome();
      fs.rmSync(target, { recursive: true, force: true });
      fs.mkdirSync(target, { recursive: true });
      fs.cpSync(tmp, target, { recursive: true });
    }
    writeSourceMeta(target, {
      source: 'registry',
      installedAt: Date.now(),
      host: r.host,
      name,
      sha256: skillDirHash(target), // 安装即记录指纹：加载时校验防本地篡改
      verified: Boolean(verified),
    });
    return { name, dir: target, host: r.host, verified: Boolean(verified) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
