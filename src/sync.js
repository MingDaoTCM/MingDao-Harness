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
import { listSessions, CONFLICT_BACKUP_RE } from './session.js';
import { atomicWriteFileSync, withFileLockSync } from './atomic-write.js';
import { decideEgress, currentPolicy } from './net-guard.js';

const TIMEOUT_MS = 20000;
// 自签证书（--insecure）只影响同步请求本身，不再改写进程级 NODE_TLS_REJECT_UNAUTHORIZED
const insecureOn = () => syncSettings()?.insecure === true;

// 请求级不安全 TLS 传输（P1-6）：为本次请求单独建立 rejectUnauthorized:false 的 https.Agent，
// 与并发的 provider 请求（各自的 TLS 校验）互不干扰；安全路径仍走 fetch（连接复用）。
/**
 * @param {any} target
 * @param {{ headers?: any, body?: any, timeoutMs?: any, insecure?: any }} opts
 */
function rawRequest(target, { headers, body, timeoutMs, insecure }) {
  return new Promise((resolve, reject) => {
    // v0.6.0 C3：这条路径走 node:https（自签名证书场景），**绕过**全局 fetch 闸门，
    // 因此必须显式过一遍出网判定——否则「只有自签名证书的部署能外传」会成为一个隐蔽缺口。
    const egress = decideEgress(target);
    if (!egress.allowed && currentPolicy()?.mode === 'block') {
      reject(new Error(`出网被拦截：${egress.host} 不在 config.net.allow 白名单内（mode=block）`));
      return;
    }
    const mod = target.protocol === 'http:' ? http : https;
    /** @type {any} */
    const opts = { method: 'POST', headers };
    if (insecure && target.protocol === 'https:') opts.agent = new https.Agent({ rejectUnauthorized: false });
    const req = mod.request(target, opts, (res) => {
      /** @type {any[]} */
      const chunks = [];
      let size = 0;
      res.on('data', (/** @type {any} */ d) => {
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

/**
 * @param {any} baseUrl
 * @param {any} method
 * @param {any} payload
 * @param {any} token
 */
async function apiCall(baseUrl, method, payload, token, timeoutMs = TIMEOUT_MS, insecure = false) {
  const target = new URL(baseUrl.replace(/\/+$/, '') + method);
  const body = JSON.stringify(payload || {});
  const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  try {
    if (insecure) {
      const { status, json: j } = await rawRequest(target, { headers, body, timeoutMs, insecure: true });
      if (status !== 200) {
        const err = /** @type {Error & { status?: number, body?: any }} */ (new Error(j.error || `HTTP ${status}`));
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
      const j = /** @type {any} */ (await res.json().catch(() => ({})));
      if (!res.ok) {
        const err = /** @type {Error & { status?: number, body?: any }} */ (new Error(j.error || `HTTP ${res.status}`));
        err.status = res.status;
        err.body = j;
        throw err;
      }
      return j;
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    if (/** @type {any} */ (e).name === 'AbortError' || /** @type {any} */ (e).message === '请求超时') throw new Error('请求超时（20s）');
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
/**
 * @param {{ url?: any, username?: any, password?: any, deviceName?: any, insecure?: any }} opts
 */
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
      if (/** @type {any} */ (e).status === 401) return { error: '用户名或密码错误' };
      if (/** @type {any} */ (e).status !== 404) return { error: `连接失败：${/** @type {any} */ (e).message}` };
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
    if (/** @type {any} */ (e).status === 401) return { error: '用户名或密码错误' };
    if (/** @type {any} */ (e).status === 404) return { error: '服务器接口不存在（确认是 mingdao 同步服务端）' };
    return { error: `连接失败：${/** @type {any} */ (e).message}` };
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
    return { error: /** @type {any} */ (e).message };
  }
}

// 会话名白名单（与 sync-server 同款）：远端返回的名字不满足即拒绝落盘，防恶意服务器任意文件写
/** @param {any} n */
function isValidRemoteName(n) {
  return typeof n === 'string' && /^[\w\u4e00-\u9fa5.-]{1,140}\.jsonl$/.test(n) && !n.includes('..');
}
// 冲突副本名：时间戳 + 随机后缀，防同一毫秒冲突静默覆盖
/**
 * @param {any} base
 * @param {any} side
 */
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
/** @param {any} state */
function writeState(state) {
  ensureHome();
  const target = stateFile();
  atomicWriteFileSync(target, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 }); // 质检 H4
}

/**
 * 提交本次同步产生的状态**增量**（v0.4.7 P3 T19：末尾合并式加锁）。
 *
 * 为什么不整段加锁：同步的状态变更散落在多次网络往返之间（每个会话一次 pull + 一次 push），
 * 整段持锁会把跨网络的秒级耗时关进临界区——锁超时 5s，必然大面积抢锁失败，
 * 那是拿「并发正确」换「功能不可用」。
 * 为什么不能读-改-写：syncPush / syncPull / syncShareAccept 都持有**自己那份**快照
 * （读取发生在网络调用之前），收尾时整份覆写。两个进程并发（例如 CLI 手动 sync 与后台
 * worker 的 maybeAutoSync）就会互相覆盖对方刚记下的 remoteMtime —— 丢更新之后，
 * 本已同步的会话会被判为「没同步过」而反复全量传输、甚至误判冲突覆盖远端。
 *
 * 合并式：临界区里只做「重读磁盘 → 并入本次改动的那几个键 → 写回」，临界区只有文件 I/O，
 * 毫秒级完成，且并发双方各自贡献的键都不会丢（本模块只增不删，故无需处理删除语义）。
 * @param {any} delta 本次要落盘的状态增量（键 = 会话名）
 */
function commitState(delta) {
  const keys = Object.keys(delta || {});
  if (!keys.length) return;
  ensureHome();
  withFileLockSync(path.join(mingdaoHome(), '.sync-state.lock'), () => {
    const cur = readState();
    for (const k of keys) cur[k] = delta[k];
    writeState(cur);
  });
}

// 推送单个/全部会话。仅当远端被其他设备改过（mtime 与本地记录不一致且内容不同）才视为冲突并备份远端。
/** @param {any} [name] */
export async function syncPush(name) {
  const g = tokenGuard();
  if (g.error) return { error: g.error };
  const home = mingdaoHome();
  const locals = listSessions(home).filter((s) => !name || s.name === name);
  if (!locals.length) return { error: name ? `本地没有会话 ${name}` : '本地没有会话可推送' };
  const state = readState(); // 只用于「是否已同步过」的判断，不再整份回写
  /** @type {Record<string, any>} */
  const delta = {}; // 本次真正变更的状态键（T19：末尾按增量合并）
  const pushed = [];
  const conflicts = [];
  const skipped = [];
  for (const s of locals) {
    // 增量推送（评估 P2-3）：本地文件自上次推送后未变化（mtime 一致）→ 跳过全部网络往返。
    // 远端若被其他设备改过，由对方设备推送、本地 pull 拉取——本地不覆盖也不需要知道。
    let localStat = null;
    try {
      localStat = fs.statSync(s.file);
    } catch {
      continue;
    }
    const prevState = state[s.name];
    if (prevState?.localMtime === localStat.mtimeMs && prevState?.remoteMtime) {
      skipped.push(s.name);
      continue;
    }
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
      if (/** @type {any} */ (e).status !== 404) return { error: `读取远端 ${s.name} 失败：${/** @type {any} */ (e).message}` };
    }
    if (remote?.ok) {
      const lastMtime = state[s.name]?.remoteMtime;
      // 审计 B7：仅当本地曾记录过远端版本且内容不同才判冲突；首次推送不产生虚假 .server- 备份
      if (lastMtime !== undefined && remote.content !== content && remote.mtime !== lastMtime) {
        const backup = path.join(home, 'sessions', conflictCopyName(s.name, 'server'));
        fs.writeFileSync(backup, remote.content, { mode: 0o600 });
        conflicts.push(s.name);
      }
    }
    try {
      const r = await apiCall(g.url, '/api/sessions/push', { name: s.name, content }, g.token, TIMEOUT_MS, insecureOn());
      if (r.ok) {
        pushed.push(s.name);
        delta[s.name] = { remoteMtime: r.mtime, localMtime: localStat.mtimeMs };
      }
    } catch (e) {
      return { error: `推送 ${s.name} 失败：${/** @type {any} */ (e).message}` };
    }
  }
  commitState(delta);
  return { ok: true, pushed, conflicts, skipped };
}

// 拉取单个/全部会话。本地有不同内容时保留本地，远端写入 .remote- 副本。
/** @param {any} [name] */
export async function syncPull(name) {
  const g = tokenGuard();
  if (g.error) return { error: g.error };
  const home = mingdaoHome();
  let sessions;
  try {
    const r = await apiCall(g.url, '/api/sessions/list', {}, g.token, TIMEOUT_MS, insecureOn());
    sessions = (r.sessions || []).filter((/** @type {any} */ s) => !name || s.name === name);
  } catch (e) {
    return { error: `获取远端清单失败：${/** @type {any} */ (e).message}` };
  }
  if (!sessions.length) return { error: name ? `远端没有会话 ${name}` : '远端没有会话' };
  const state = readState(); // 只用于增量判断（T19：不再整份回写）
  /** @type {Record<string, any>} */
  const delta = {};
  const pulled = [];
  const conflicts = [];
  for (const s of sessions) {
    if (!isValidRemoteName(s.name)) continue; // 恶意服务器返回的非法名：跳过，绝不落盘
    // 增量拉取（评估 P2-3）：远端 mtime 与上次拉取一致 → 跳过下载
    if (state[s.name]?.remoteMtime === s.mtime) continue;
    const target = path.join(home, 'sessions', s.name);
    let local = null;
    try {
      local = fs.readFileSync(target, 'utf8');
    } catch {}
    const r = await apiCall(g.url, '/api/sessions/pull', { name: s.name }, g.token, TIMEOUT_MS, insecureOn());
    if (!r.ok) continue;
    if (local !== null && local !== r.content) {
      const copy = path.join(home, 'sessions', conflictCopyName(s.name, 'remote'));
      atomicWriteFileSync(copy, r.content, { mode: 0o600 }); // 质检 H4
      conflicts.push(s.name);
      delta[s.name] = { remoteMtime: r.mtime };
      continue;
    }
    if (local === r.content) {
      delta[s.name] = { remoteMtime: r.mtime }; // 内容一致：只需记下远端版本，避免下轮重复下载
      continue;
    }
    fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
    atomicWriteFileSync(target, r.content, { mode: 0o600 }); // 质检 H4
    pulled.push(s.name);
    delta[s.name] = { remoteMtime: r.mtime };
  }
  commitState(delta);
  return { ok: true, pulled, conflicts };
}

// ---------- 密码修改 ----------
/**
 * @param {{ oldPassword?: any, newPassword?: any }} opts
 */
export async function syncChangePassword({ oldPassword, newPassword }) {
  const g = tokenGuard();
  if (g.error) return { error: g.error };
  if (!newPassword || newPassword.length < 8) return { error: '新密码至少 8 位' };
  try {
    const r = await apiCall(g.url, '/api/password', { oldPassword: oldPassword || '', newPassword }, g.token, TIMEOUT_MS, insecureOn());
    return r.ok ? { ok: true } : { error: r.error || '修改失败' };
  } catch (e) {
    if (/** @type {any} */ (e).status === 401) return { error: '旧密码错误' };
    return { error: `修改失败：${/** @type {any} */ (e).message}` };
  }
}

// ---------- 会话分享与协作 ----------
/** @param {any} name */
export async function syncShareCreate(name) {
  const g = tokenGuard();
  if (g.error) return { error: g.error };
  try {
    const r = await apiCall(g.url, '/api/share/create', { name }, g.token, TIMEOUT_MS, insecureOn());
    return r.ok ? { ok: true, shareId: r.shareId, name: r.name } : { error: r.error };
  } catch (e) {
    return { error: `分享失败：${/** @type {any} */ (e).status === 404 ? '你还没有这个会话' : /** @type {any} */ (e).message}` };
  }
}

export async function syncShareList() {
  const g = tokenGuard();
  if (g.error) return { error: g.error };
  try {
    const r = await apiCall(g.url, '/api/share/list', {}, g.token, TIMEOUT_MS, insecureOn());
    return { ok: true, mine: r.mine || [], accepted: r.accepted || [] };
  } catch (e) {
    return { error: `获取分享列表失败：${/** @type {any} */ (e).message}` };
  }
}

/** @param {any} shareId */
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
    atomicWriteFileSync(path.join(home, 'sessions', r.savedAs), r.content, { mode: 0o600 }); // 质检 H4
    // T19：单键同样走末尾合并（与 syncPush/syncPull 抢同一把锁），避免覆盖并发同步的记账
    commitState({ [r.savedAs]: { remoteMtime: r.mtime } });
    return { ok: true, shareId, savedAs: r.savedAs, conflict: r.conflict || false };
  } catch (e) {
    return { error: `接受分享失败：${/** @type {any} */ (e).status === 404 ? '分享不存在（可能已撤销）' : /** @type {any} */ (e).message}` };
  }
}

/** @param {any} shareId */
export async function syncShareRevoke(shareId) {
  const g = tokenGuard();
  if (g.error) return { error: g.error };
  try {
    const r = await apiCall(g.url, '/api/share/revoke', { shareId }, g.token, TIMEOUT_MS, insecureOn());
    return r.ok ? { ok: true } : { error: r.error };
  } catch (e) {
    return { error: `撤销失败：${/** @type {any} */ (e).status === 404 ? '分享不存在' : /** @type {any} */ (e).status === 403 ? '只能撤销自己的分享' : /** @type {any} */ (e).message}` };
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
  // v0.4.6 P1 修复：用与 producer（conflictCopyName）一致的共享正则——此前这里只认
  // `<名>.server-<纯数字>.jsonl`，而实际写入的是 `<名>.server-<时间戳>-<随机后缀>.jsonl`，
  // 备份永远匹配不到 → 冲突面板恒空、resolveSyncConflict 恒报「没有找到冲突备份」。
  const m = CONFLICT_BACKUP_RE;
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
      entries: entries.sort((/** @type {any} */ a, /** @type {any} */ b) => b.ts - a.ts),
    }))
    .sort((a, b) => a.base.localeCompare(b.base));
}

// choice: local（保留本地，删除备份）| remote（采用远端备份替换本地）| both（把最新备份转正为可见会话）
/**
 * @param {any} base
 * @param {any} choice
 */
export function resolveSyncConflict(base, choice) {
  const home = mingdaoHome();
  if (!/^[\w\u4e00-\u9fa5.-]{1,140}\.jsonl$/.test(base)) return { error: '会话名非法' };
  const sessions = path.join(home, 'sessions');
  const m = CONFLICT_BACKUP_RE; // v0.4.6 P1：与 listSyncConflicts / producer 同一正则
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
    .sort((a, b) => Number(/** @type {any} */ (b.match(m))[3]) - Number(/** @type {any} */ (a.match(m))[3]));
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
