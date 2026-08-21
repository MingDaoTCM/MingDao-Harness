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
import { loadConfig, saveConfig, mingdaoHome, ensureHome } from './config.js';
import { loadCredentials, saveCredentials } from './credentials.js';
import { listSessions } from './session.js';

const TIMEOUT_MS = 20000;

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

async function apiCall(baseUrl, method, payload, token, timeoutMs = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  // 自建服务器用自签证书的阶段：config.sync.insecure=true 跳过证书校验（正式证书就绪后应关闭）
  if (syncSettings()?.insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    const res = await fetch(baseUrl.replace(/\/+$/, '') + method, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload || {}),
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
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('请求超时（20s）');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 登录/注册 + 设备配对：注册失败（用户不存在）先注册再配对
export async function syncLogin({ url, username, password, deviceName, insecure = false }) {
  const base = String(url || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return { error: '服务器地址需以 http(s):// 开头' };
  const name = String(username || '').trim();
  if (!/^[A-Za-z0-9_.-]{2,32}$/.test(name)) return { error: '用户名需 2–32 位字母/数字/._-' };
  if (!password || password.length < 8) return { error: '密码至少 8 位' };
  const dev = String(deviceName || '').trim().slice(0, 60) || os.hostname().slice(0, 60) || '未命名设备';
  const useInsecure = insecure || syncSettings()?.insecure === true;
  if (useInsecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    let pair;
    try {
      pair = await apiCall(base, '/api/pair', { username: name, password, deviceName: dev });
    } catch (e) {
      if (e.status === 401) return { error: '用户名或密码错误' };
      if (e.status !== 404) return { error: `连接失败：${e.message}` };
      pair = { notFound: true }; // 用户不存在 → 先注册
    }
    if (pair.notFound) {
      const reg = await apiCall(base, '/api/register', { username: name, password });
      if (reg.error) return { error: reg.error };
      pair = await apiCall(base, '/api/pair', { username: name, password, deviceName: dev });
    }
    if (!pair.ok || !pair.token) return { error: pair.error || '配对失败' };
    // 保存：config 只存非秘密，token 进凭证库
    const cfg = loadConfig() || {};
    cfg.sync = { url: base, username: name, deviceName: dev, auto: cfg.sync?.auto !== false, insecure: useInsecure };
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
    const r = await apiCall(g.url, '/api/sessions/list', {}, g.token);
    return { ok: true, sessions: r.sessions || [] };
  } catch (e) {
    return { error: e.message };
  }
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
  fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
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
      remote = await apiCall(g.url, '/api/sessions/pull', { name: s.name }, g.token);
    } catch (e) {
      if (e.status !== 404) return { error: `读取远端 ${s.name} 失败：${e.message}` };
    }
    if (remote?.ok) {
      const lastMtime = state[s.name]?.remoteMtime;
      if (remote.content !== content && remote.mtime !== lastMtime) {
        const backup = path.join(home, 'sessions', s.name.replace(/\.jsonl$/, `.server-${Date.now()}.jsonl`));
        fs.writeFileSync(backup, remote.content, { mode: 0o600 });
        conflicts.push(s.name);
      }
    }
    try {
      const r = await apiCall(g.url, '/api/sessions/push', { name: s.name, content }, g.token);
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
    const r = await apiCall(g.url, '/api/sessions/list', {}, g.token);
    sessions = (r.sessions || []).filter((s) => !name || s.name === name);
  } catch (e) {
    return { error: `获取远端清单失败：${e.message}` };
  }
  if (!sessions.length) return { error: name ? `远端没有会话 ${name}` : '远端没有会话' };
  const state = readState();
  const pulled = [];
  const conflicts = [];
  for (const s of sessions) {
    const target = path.join(home, 'sessions', s.name);
    let local = null;
    try {
      local = fs.readFileSync(target, 'utf8');
    } catch {}
    const r = await apiCall(g.url, '/api/sessions/pull', { name: s.name }, g.token);
    if (!r.ok) continue;
    if (local !== null && local !== r.content) {
      const copy = path.join(home, 'sessions', s.name.replace(/\.jsonl$/, `.remote-${Date.now()}.jsonl`));
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
