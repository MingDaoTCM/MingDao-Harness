// 技能库线上 registry 客户端（零依赖，纯 fetch + 本地缓存）：
//  - 默认 registry：MingDao-Harness 仓库 registry/index.json（github/gitee/gitcode 三镜像自动回退）
//  - 自建 registry：设置环境变量 MINGDAO_REGISTRY_URL 指向自己的 index.json（企业内网可用）
//  - 本地缓存 <home>/skill-registry-cache.json，TTL 1 小时（force 可强制刷新）
//  - 安装：按索引逐文件下载 → dry-run 校验 frontmatter → 写入用户级技能目录
//    （来源元数据 source=registry，mingdao skill update 可重装）

import fs from 'node:fs';
import { safeFetchText } from './safe-fetch.js';
import { assertSafeSkillName } from './skill-lib.js';
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

async function fetchText(/** @type {any} */ url, timeoutMs = 20000, maxBytes = 2 * 1024 * 1024, allowPrivate = false) {
  // v0.6.2（代码审计 P2-7）：原来这里是 `fetch(url, { redirect: 'follow' })`——自动跟随重定向
  // 且**每一跳都不做私网复检**，于是线上技能库这条路径可被重定向到内网（云元数据/内网服务）。
  // 而隔壁 skill-lib 早就做了逐跳复检——同一判定两套口径，等于最弱的那套说了算。
  // 现统一走 src/safe-fetch.js（单一来源）；这里保留"失败抛异常"的既有契约，调用方无需改动。
  const r = await safeFetchText(url, { timeoutMs, maxBytes, allowPrivate });
  if (r.error) throw new Error(r.error);
  return String(r.text ?? ''); // 成功路径必有 text；显式收敛类型，避免调用方拿到 string|undefined
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
  const { hosts, isCustom } = registryBase();
  let lastErr = null;
  for (const host of hosts) {
    try {
      // v0.6.2：用户**显式配置**的 registry（MINGDAO_REGISTRY_URL）允许内网地址——
      // 「自建 registry 供企业内网使用」是文档明确支持的场景，与 CLI 显式输入 URL 同口径；
      // 默认公网源保持严格（不允许被重定向到内网）。
      const text = await fetchText(`${host}/registry/index.json`, 8000, 2 * 1024 * 1024, isCustom);
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
  // v0.6.2（B-SR-1）：索引名先过技能名白名单。
  // 此前只由 installSkill 的 /^[A-Za-z0-9_.-]+$/ 过滤，而那个字符集**允许 "." 与 ".."**——
  // 索引是网络内容（自建 registry / 被篡改的镜像 / 未签名的第三方索引），
  // 一条 {"name": ".."} 就能让后面的 rmSync(target, {recursive:true}) 删掉整个 MINGDAO_HOME。
  const safeIndexName = assertSafeSkillName(name);
  if (!safeIndexName) return { error: `技能名非法：${String(name)}` };
  const r = await fetchRegistryIndex();
  if (r.error) return { error: r.error };
  const entry = r.data.skills.find((/** @type {any} */ s) => s.name === name);
  if (!entry) return { error: `线上技能库中没有 ${name}（mingdao skill search 查看）` };
  if (!Array.isArray(entry.files) || !entry.files.length) return { error: `技能 ${name} 的索引缺少文件清单` };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-reg-'));
  try {
    // 逐文件下载按镜像回退（审计：国内网络下 raw.githubusercontent 常超时/被断，
    // 此前只试首选主机 → 安装报「This operation was aborted」；gitee/gitcode 国内秒开）
    const base = registryBase();
    const hosts = [r.host, ...base.hosts.filter((h) => h !== r.host)];
    const allowPrivate = base.isCustom; // 用户显式配置的源（可能是内网自建 registry）
    let verified = false; // 每个文件都必须通过 sha256 校验（缺哈希直接拒绝安装），成功即 true
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
          text = await fetchText(`${host}/skills-lib/${encodeURI(name)}/${rel.split('/').map(encodeURIComponent).join('/')}`, 30000, MAX_FILE, allowPrivate);
          break;
        } catch (e) {
          const ee = /** @type {any} */ (e);
          lastErr = ee?.name === 'AbortError' ? '下载超时' : String(ee?.message || ee);
        }
      }
      if (text === null) return { error: `下载 ${name}/${rel} 失败：${lastErr}（已尝试全部镜像）` };
      if (text.length > MAX_FILE) return { error: `${name}/${rel} 超过 512KB 上限` };
      // 完整性校验（P3-3）：**索引必须声明 sha256，否则拒绝安装**（v0.6.2 改为 fail-closed）。
      //
      // 原状是 `if (f.sha256 && ...)`——索引没写哈希时**完全不校验**，文件照样落盘，
      // 而 CLI 无条件打印「✓ 已安装技能」，用户以为这是校验过的技能。
      // 技能是从**远端索引**下载的，属于供应链路径：缺哈希 = 无从判断是否被篡改，
      // 这种「静默降级为不校验」必须改成显式失败（与约束引擎 fail-closed 同口径）。
      if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(f.sha256)) {
        return {
          error:
            `索引未为 ${name}/${rel} 声明合法的 sha256，已拒绝安装（无法校验完整性）。` +
            `自建 registry 请先运行 scripts/build-registry-hashes.js 为 index.json 补齐哈希。`,
        };
      }
      const got = crypto.createHash('sha256').update(text).digest('hex');
      if (got !== f.sha256.toLowerCase()) {
        return { error: `完整性校验失败：${name}/${rel} 与 registry 声明的 sha256 不符（文件可能被篡改或索引过期），已拒绝安装` };
      }
      verified = true;
      fs.writeFileSync(dest, text);
    }
    const check = validateSkillDir(tmp, name);
    if (check.error) return { error: check.error };
    // 安装目录用**校验过的 frontmatter 名字**，不用索引名。
    // 索引名与技能自己声明的名字本来就是两个独立输入：前者只过字符集，后者过 validateSkillMarkdown
    // 的完整格式校验。既然要落盘的是"这个技能"，目录名就该取它自己声明的那个——
    // 顺带让"索引名与内容不符"这种可疑情况不会变成一次越界写入。
    // 用 assertSafeSkillName 收口（而不是直接取 check.name）：既把类型收窄成 string，
    // 又让"校验过的 frontmatter 名"再过一次白名单——万一 validateSkillMarkdown 的规则将来放宽，
    // 这里仍然不会把 `.` / `..` 拼进路径。
    const safeName = assertSafeSkillName(check.name);
    if (!safeName) return { error: `技能 frontmatter.name 非法：${String(check.name)}` };
    const target = path.join(userSkillsDir(), safeName);
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
      name: safeName,
      sha256: skillDirHash(target), // 安装即记录指纹：加载时校验防本地篡改
      verified: Boolean(verified),
    });
    return { name: safeName, dir: target, host: r.host, verified: Boolean(verified) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
