// 云同步客户端（零依赖 fetch）：会话 JSONL 的跨设备同步。
//  - 服务端：见 src/sync-server.js（账号 + 设备 token + 会话存储）
//  - 配置：config.json 的 sync 字段 {url, username, deviceName, auto}（无秘密）
//  - 凭证：credentials.json 的 sync 字段 {token, deviceId}（600 权限）
//  - 冲突规则（M1，绝不丢数据）：
//      push：远端存在且内容不同 → 先把远端拉回本地备份 .server-<时间戳>.jsonl，再以本地覆盖
//      pull：本地存在且内容不同 → 本地不动，远端写入 .remote-<时间戳>.jsonl
//  - auto：会话结束时静默推送（失败不影响对话）

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import { loadConfig, saveConfig, mingdaoHome, ensureHome } from './config.js';
import { loadCredentials, saveCredentials } from './credentials.js';
import { listSessions } from './session.js';

const TIMEOUT_MS = 20000;
// 自签证书（--insecure）只影响同步请求本身，不再改写进程级 NODE_TLS_REJECT_UNAUTHORIZED
const insecureOn = () => syncSettings()?.insecure === true;

// 请求级不安全 TLS 传输（P1-6）：为本次请求单独建立 rejectUnauthorized:false 的 https.Agent，
// 与并发的 provider 请求（各自的 TLS 校验）互不干扰；安全路径仍走 fetch（连接复用）。
function rawRequest(target, { headers, body, timeoutMs, insecure }) {
  return new Promise((resolve, reject) => {
    const mod = target.protocol === 'http:' ? http : https;
    const opts = { method: 'POST', headers };
    if (insecure && target.protocol === 'https:') opts.agent = new https.Agent({ rejectUnauthorized: false });
    const req = mod.request(target, opts, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (d) => {
        size += d.length;
        if (size > 25 * 1024 * 1024) {
          req.destroy();
          resolve({ status: 413, json: {} });
          return;
        }
        chunks.push(d);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let j = {};
        try {
          j = text ? JSON.parse(text) : {};
        } catch {}
        resolve({ status: res.statusCode, json: j });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function apiCall(baseUrl, method, payload, token, timeoutMs = TIMEOUT_MS, insecure = false) {
  const target = new URL(baseUrl.replace(/\/+$/, '') + method);
  const body = JSON.stringify(payload || {});
  const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  try {
    if (insecure) {
      const { status, json: j } = await rawRequest(target, { headers, body, timeoutMs, insecure: true });
      if (status !== 200) {
        const err = new Error(j.error || `HTTP ${status}`);
        err.status = status;
        err.body = j;
        throw err;
      }
      return j;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(target, {
        method: 'POST',
        headers,
        body,
        signal: ctrl.signal,
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(j.error || `HTTP ${res.status}`);
        err.status = res.status;
        err.body = j;
        throw err;
      }
      return j;
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    if (e.name === 'AbortError' || e.message === '请求超时') throw new Error('请求超时（20s）');
    throw e;
  }
}

export function syncSettings() {
  const cfg = loadConfig();
  return cfg?.sync || null;
}

export function syncCredential() {
  return loadCredentials()?.sync || null;
}

export function syncStatus() {
  const s = syncSettings();
  const c = syncCredential();
  return {
    configured: Boolean(s?.url),
    loggedIn: Boolean(c?.token),
    url: s?.url || '',
    username: s?.username || '',
    deviceName: s?.deviceName || '',
    auto: s?.auto !== false,
  };
}

// 登录/注册 + 设备配对：注册失败（用户不存在）先注册再配对
export async function syncLogin({ url, username, password, deviceName, insecure = false }) {
  const base = String(url || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return { error: '服务器地址需以 http(s):// 开头' };
  const name = String(username || '').trim();
  if (!/^[A-Za-z0-9_.-]{2,32}$/.test(name)) return { error: '用户名需 2–32 位字母/数字/._-' };
  if (!password || password.length < 8) return { error: '密码至少 8 位' };
  const dev = String(deviceName || '').trim().slice(0, 60) || os.hostname().slice(0, 60) || '未命名设备';
  const loginInsecure = insecure || insecureOn();
  try {
    let pair;
    try {
      pair = await apiCall(base, '/api/pair', { username: name, password, deviceName: dev }, undefined, TIMEOUT_MS, loginInsecure);
    } catch (e) {
      if (e.status === 401) return { error: '用户名或密码错误' };
      if (e.status !== 404) return { error: `连接失败：${e.message}` };
      pair = { notFound: true }; // 用户不存在 → 先注册
    }
    if (pair.notFound) {
      const reg = await apiCall(base, '/api/register', { username: name, password }, undefined, TIMEOUT_MS, loginInsecure);
      if (reg.error) return { error: reg.error };
      pair = await apiCall(base, '/api/pair', { username: name, password, deviceName: dev }, undefined, TIMEOUT_MS, loginInsecure);
    }
    if (!pair.ok || !pair.token) return { error: pair.error || '配对失败' };
    // 保存：config 只存非秘密，token 进凭证库
    const cfg = loadConfig() || {};
    cfg.sync = { url: base, username: name, deviceName: dev, auto: cfg.sync?.auto !== false, insecure: loginInsecure };
    saveConfig(cfg);
    const creds = loadCredentials();
    creds.sync = { token: pair.token, deviceId: pair.deviceId };
    saveCredentials(creds);
    return { ok: true, username: name, deviceName: dev, url: base };
  } catch (e) {
    if (e.status === 401) return { error: '用户名或密码错误' };
    if (e.status === 404) return { error: '服务器接口不存在（确认是 mingdao 同步服务端）' };
    return { error: `连接失败：${e.message}` };
  }
}

export function syncLogout() {
  const creds = loadCredentials();
  if (creds.sync) {
    delete creds.sync;
    saveCredentials(creds);
  }
  const cfg = loadConfig();
  if (cfg?.sync) {
    cfg.sync = { ...cfg.sync, username: undefined, deviceName: undefined };
    // 清理无意义的空字段
    for (const k of ['username', 'deviceName']) if (cfg.sync[k] === undefined) delete cfg.sync[k];
    saveConfig(cfg);
  }
  return { ok: true };
}

function tokenGuard() {
  const s = syncSettings();
  const c = syncCredential();
  if (!s?.url) return { error: '未配置同步服务器（mingdao sync login <用户名>）' };
  if (!c?.token) return { error: '未登录（mingdao sync login <用户名>）' };
  return { url: s.url, token: c.token };
}

// 拉取远端会话清单
export async function syncRemoteList() {
  const g = tokenGuard();
  if (g.error) return { error: g.error };
  try {
    const r = await apiCall(g.url, '/api/sessions/list', {}, g.token, TIMEOUT_MS, insecureOn());
    return { ok: true, sessions: r.sessions || [] };
  } catch (e) {
    return { error: e.message };
  }
}

// 会话名白名单（与 sync-server 同款）：远端返回的名字不满足即拒绝落盘，防恶意服务器任意文件写
function isValidRemoteName(n) {
  return typeof n === 'string' && /^[\w\u4e00-\u9fa5.-]{1,140}\.jsonl$/.test(n) && !n.includes('..');
}
// 冲突副本名：时间戳 + 随机后缀，防同一毫秒冲突静默覆盖
function conflictCopyName(base, side) {
  return base.replace(/\.jsonl$/, `.${side}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jsonl`);
}

// 同步状态（记录每个会话最近见过的远端 mtime，用于判断冲突：只有远端被其他设备改过才算冲突）
function stateFile() {
  return path.join(mingdaoHome(), 'sync-state.json');
}
function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return {};
  }
}
function writeState(state) {
  ensureHome();
  const target = stateFile();
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, target);
}

// 推送单个/全部会话。仅当远端被其他设备改过（mtime 与本地记录不一致且内容不同）才视为冲突并备份远端。
export async function syncPush(name) {
  const g = tokenGuard();
  if (g.error) return { error: g.error };
  const home = mingdaoHome();
  const locals = listSessions(home).filter((s) => !name || s.name === name);
  if (!locals.length) return { error: name ? `本地没有会话 ${name}` : '本地没有会话可推送' };
  const state = readState();
  const pushed = [];
  const conflicts = [];
  const skipped = [];
  for (const s of locals) {
    const content = fs.readFileSync(s.file, 'utf8');
    if (!content.trim()) {
      skipped.push(s.name); // 空会话文件（刚创建未写消息）不推送
      continue;
    }
    if (Buffer.byteLength(content) > 19 * 1024 * 1024) {
      return { error: `${s.name} 超过 20MB 上限，跳过同步` };
    }
    let remote = null;
    try {
      remote = await apiCall(g.url, '/api/sessions/pull', { name: s.name }, g.token, TIMEOUT_MS, insecureOn());
    } catch (e) {
      if (e.status !== 404) return { error: `读取远端 ${s.name} 失败：${e.message}` };
    }
    if (remote?.ok) {
      const lastMtime = state[s.name]?.remoteMtime;
      if (remote.content !== content && remote.mtime !== lastMtime) {
        const backup = path.join(home, 'sessions', conflictCopyName(s.name, 'server'));
        fs.writeFileSync(backup, remote.content, { mode: 0o600 });
        conflicts.push(s.name);
      }
    }
    try {
      const r = await apiCall(g.url, '/api/sessions/push', { name: s.name, content }, g.token, TIMEOUT_MS, insecureOn());
      if (r.ok) {
        pushed.push(s.name);
        state[s.name] = { remoteMtime: r.mtime };
      }
    } catch (e) {
      return { error: `推送 ${s.name} 失败：${e.message}` };
    }
  }
  writeState(state);
  return { ok: true, pushed, conflicts, skipped };
}

// 拉取单个/全部会话。本地有不同内容时保留本地，远端写入 .remote- 副本。
export async function syncPull(name) {
  const g = tokenGuard();
  if (g.error) return { error: g.error };
  const home = mingdaoHome();
  let sessions;
  try {
    const r = await apiCall(g.url, '/api/sessions/list', {}, g.token, TIMEOUT_MS, insecureOn());
    sessions = (r.sessions || []).filter((s) => !name || s.name === name);
  } catch (e) {
    return { error: `获取远端清单失败：${e.message}` };
  }
  if (!sessions.length) return { error: name ? `远端没有会话 ${name}` : '远端没有会话' };
  const state = readState();
  const pulled = [];
  const conflicts = [];
  for (const s of sessions) {
    if (!isValidRemoteName(s.name)) continue; // 恶意服务器返回的非法名：跳过，绝不落盘
    const target = path.join(home, 'sessions', s.name);
    let local = null;
    try {
      local = fs.readFileSync(target, 'utf8');
    } catch {}
    const r = await apiCall(g.url, '/api/sessions/pull', { name: s.name }, g.token, TIMEOUT_MS, insecureOn());
    if (!r.ok) continue;
    if (local !== null && local !== r.content) {
      const copy = path.join(home, 'sessions', conflictCopyName(s.name, 'remote'));
      fs.writeFileSync(copy, r.content, { mode: 0o600 });
      conflicts.push(s.name);
      state[s.name] = { remoteMtime: r.mtime };
      continue;
    }
    if (local === r.content) {
      state[s.name] = { remoteMtime: r.mtime };
      continue;
    }
    fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
    fs.writeFileSync(target, r.content, { mode: 0o600 });
    pulled.push(s.name);
    state[s.name] = { remoteMtime: r.mtime };
  }
  writeState(state);
  return { ok: true, pulled, conflicts };
}

// ---------- 密码修改 ----------
export async function syncChangePassword({ oldPassword, newPassword }) {
  const g = tokenGuard();
  if (g.error) return { error: g.error };
  if (!newPassword || newPassword.length < 8) return { error: '新密码至少 8 位' };
  try {
    const r = await apiCall(g.url, '/api/password', { oldPassword: oldPassword || '', newPassword }, g.token, TIMEOUT_MS, insecureOn());
    return r.ok ? { ok: true } : { error: r.error || '修改失败' };
  } catch (e) {
    if (e.status === 401) return { error: '旧密码错误' };
    return { error: `修改失败：${e.message}` };
  }
}

// ---------- 会话分享与协作 ----------
export async function syncShareCreate(name) {
  const g = tokenGuard();
  if (g.error) return { error: g.error };
  try {
    const r = await apiCall(g.url, '/api/share/create', { name }, g.token, TIMEOUT_MS, insecureOn());
    return r.ok ? { ok: true, shareId: r.shareId, name: r.name } : { error: r.error };
  } catch (e) {
    return { error: `分享失败：${e.status === 404 ? '你还没有这个会话' : e.message}` };
  }
}

export async function syncShareList() {
  const g = tokenGuard();
  if (g.error) return { error: g.error };
  try {
    const r = await apiCall(g.url, '/api/share/list', {}, g.token, TIMEOUT_MS, insecureOn());
    return { ok: true, mine: r.mine || [], accepted: r.accepted || [] };
  } catch (e) {
    return { error: `获取分享列表失败：${e.message}` };
  }
}

export async function syncShareAccept(shareId) {
  const g = tokenGuard();
  if (g.error) return { error: g.error };
  try {
    const r = await apiCall(g.url, '/api/share/accept', { shareId }, g.token, TIMEOUT_MS, insecureOn());
    if (!r.ok) return { error: r.error };
    // 服务端已决定落盘位置与冲突语义：直接写入本地会话目录并记录远端 mtime
    if (!isValidRemoteName(r.savedAs)) return { error: '服务器返回的会话名非法，已拒绝落盘' };
    const home = mingdaoHome();
    fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(home, 'sessions', r.savedAs), r.content, { mode: 0o600 });
    const state = readState();
    state[r.savedAs] = { remoteMtime: r.mtime };
    writeState(state);
    return { ok: true, shareId, savedAs: r.savedAs, conflict: r.conflict || false };
  } catch (e) {
    return { error: `接受分享失败：${e.status === 404 ? '分享不存在（可能已撤销）' : e.message}` };
  }
}

export async function syncShareRevoke(shareId) {
  const g = tokenGuard();
  if (g.error) return { error: g.error };
  try {
    const r = await apiCall(g.url, '/api/share/revoke', { shareId }, g.token, TIMEOUT_MS, insecureOn());
    return r.ok ? { ok: true } : { error: r.error };
  } catch (e) {
    return { error: `撤销失败：${e.status === 404 ? '分享不存在' : e.status === 403 ? '只能撤销自己的分享' : e.message}` };
  }
}

// ---------- 冲突图形化选择 ----------
// 扫描本地的 .server-*（远端版本）与 .remote-*（远端拉取版本）备份，按会话基础名分组
export function listSyncConflicts() {
  const home = mingdaoHome();
  let files = [];
  try {
    files = fs.readdirSync(path.join(home, 'sessions'));
  } catch {
    return [];
  }
  const groups = new Map();
  const m = /^(.+)\.(server|remote)-(\d+)\.jsonl$/;
  for (const f of files) {
    const mm = f.match(m);
    if (!mm) continue;
    const base = `${mm[1]}.jsonl`;
    const entry = { file: f, side: mm[2], ts: Number(mm[3]) };
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(entry);
  }
  return [...groups.entries()]
    .map(([base, entries]) => ({
      base,
      localExists: fs.existsSync(path.join(home, 'sessions', base)),
      entries: entries.sort((a, b) => b.ts - a.ts),
    }))
    .sort((a, b) => a.base.localeCompare(b.base));
}

// choice: local（保留本地，删除备份）| remote（采用远端备份替换本地）| both（把最新备份转正为可见会话）
export function resolveSyncConflict(base, choice) {
  const home = mingdaoHome();
  if (!/^[\w\u4e00-\u9fa5.-]{1,140}\.jsonl$/.test(base)) return { error: '会话名非法' };
  const sessions = path.join(home, 'sessions');
  const m = /^(.+)\.(server|remote)-(\d+)\.jsonl$/;
  let files = [];
  try {
    files = fs.readdirSync(sessions);
  } catch {
    return { error: '会话目录不存在' };
  }
  const backups = files
    .filter((f) => {
      const mm = f.match(m);
      return mm && `${mm[1]}.jsonl` === base;
    })
    .sort((a, b) => Number(b.match(m)[3]) - Number(a.match(m)[3]));
  if (!backups.length) return { error: `没有找到 ${base} 的冲突备份` };
  const newest = backups[0];
  if (choice === 'local') {
    for (const f of backups) fs.unlinkSync(path.join(sessions, f));
    return { ok: true, base, choice, removed: backups.length };
  }
  if (choice === 'remote') {
    fs.copyFileSync(path.join(sessions, newest), path.join(sessions, base));
    for (const f of backups) fs.unlinkSync(path.join(sessions, f));
    return { ok: true, base, choice, applied: newest };
  }
  if (choice === 'both') {
    const keep = base.replace(/\.jsonl$/, `.merged-${Date.now()}.jsonl`);
    fs.renameSync(path.join(sessions, newest), path.join(sessions, keep));
    for (const f of backups.filter((f) => f !== newest)) fs.unlinkSync(path.join(sessions, f));
    return { ok: true, base, choice, kept: keep };
  }
  return { error: 'choice 必须是 local / remote / both' };
}

// 会话结束后的静默自动同步（失败不打扰）
export async function maybeAutoSync() {
  const s = syncSettings();
  if (!s?.url || s.auto === false) return null;
  if (!syncCredential()?.token) return null;
  try {
    const r = await syncPush();
    return r.ok ? r : { error: r.error };
  } catch {
    return { error: '自动同步失败' };
  }
}
