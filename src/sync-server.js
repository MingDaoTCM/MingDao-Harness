// MingDao 云同步服务端（零依赖，仅 node:http/https/fs/path/crypto）。
// 部署：node sync-server.js [端口]（默认 443），或 `mingdao sync-server [端口]`
// 环境变量：
//   SYNC_DATA_DIR  数据目录（默认 /var/lib/mingdao-sync）
//   SYNC_HOST      监听地址（默认 0.0.0.0）
//   SYNC_CERT / SYNC_KEY  提供后走 HTTPS（Let's Encrypt 证书路径）
//   MINGDAO_SYNC_REGISTRATION  注册开关：open（默认）| invite（需邀请码）| closed
//   MINGDAO_SYNC_INVITE_CODES  邀请码列表（逗号分隔，仅 invite 模式生效）
// 数据布局：
//   <DATA_DIR>/users.json                 {用户名: {salt, hash, createdAt}}
//   <DATA_DIR>/devices.json               {用户名: {设备ID: {name, tokenHash, createdAt, lastSeen}}}
//   <DATA_DIR>/data/<用户名>/sessions/    各设备会话 JSONL
//   <DATA_DIR>/data/<用户名>/meta.json    {会话名: {mtime, size}}
// 安全：密码 sha256(salt:password) 存储；设备 token 48 位随机数，服务端只存哈希；
//       会话名白名单校验；body ≤ 20MB；推荐 HTTPS 部署（明文 HTTP 仅限内网/过渡）。

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWriteFileSync } from './atomic-write.js';

const DEFAULT_DATA_DIR = process.env.SYNC_DATA_DIR || '/var/lib/mingdao-sync';
let ACTIVE_DIR = DEFAULT_DATA_DIR;
const HOST = process.env.SYNC_HOST || '0.0.0.0';
const PORT = Number(process.env.SYNC_PORT || process.argv[2] || 443);
const CERT = process.env.SYNC_CERT;
const KEY = process.env.SYNC_KEY;
const MAX_BODY = 20 * 1024 * 1024;
const MAX_FILE = 20 * 1024 * 1024;
const startedAt = Date.now();
// 注册开关（P3-10）：公网自建时用 invite/closed 限制自助注册
const REGISTRATION = String(process.env.MINGDAO_SYNC_REGISTRATION || 'open').toLowerCase();
const INVITE_CODES = new Set(
  String(process.env.MINGDAO_SYNC_INVITE_CODES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- 存储 ----------
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(file, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 }); // 质检 H4
}
function usersFile() {
  return path.join(ACTIVE_DIR, 'users.json');
}
function devicesFile() {
  return path.join(ACTIVE_DIR, 'devices.json');
}
function userDir(username) {
  return path.join(ACTIVE_DIR, 'data', username);
}
function sessionsDir(username) {
  return path.join(userDir(username), 'sessions');
}
function metaFile(username) {
  return path.join(userDir(username), 'meta.json');
}
function sharesFile() {
  return path.join(ACTIVE_DIR, 'shares.json');
}
function acceptedFile() {
  return path.join(ACTIVE_DIR, 'accepted.json');
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
// 常量时间比较（P3-10）：token/密码哈希等值判断防时序侧信道
function safeEqualHex(a, b) {
  try {
    const ba = Buffer.from(String(a), 'hex');
    const bb = Buffer.from(String(b), 'hex');
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}
// 密码存储用 scrypt（带盐 KDF）；旧数据兼容：verify 时 sha256 回退
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), String(salt), 32).toString('hex');
}
function verifyPassword(password, salt, hash) {
  if (!hash) return false;
  try {
    if (safeEqualHex(hash, crypto.scryptSync(String(password), String(salt), 32).toString('hex'))) return true;
  } catch {}
  // 兼容早期 sha256 存储
  return safeEqualHex(hash, sha(`${salt}:${password}`));
}
function isValidUsername(u) {
  return typeof u === 'string' && /^[A-Za-z0-9_.-]{2,32}$/.test(u) && u !== '.' && u !== '..';
}
function isValidSessionName(n) {
  return typeof n === 'string' && /^[\w\u4e00-\u9fa5.-]{1,140}\.jsonl$/.test(n) && !n.includes('..');
}

// ---------- 限速（防爆破/枚举；内存表，进程级） ----------
const TRUST_PROXY = process.env.SYNC_TRUST_PROXY === '1'; // 仅部署在可信反代后时开启
const rateBuckets = new Map();
function clientKey(req) {
  let ip = req.socket?.remoteAddress || 'x';
  if (TRUST_PROXY) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (/^[\d.]+$/.test(xff) || xff.includes(':')) ip = xff;
  }
  return ip;
}
function rateLimited(req, limit = 20, extra = '') {
  // 质检 M5：键 = IP + 路由 + 用户名——单账号爆破按用户名限（分布式 IP 无法绕过）；
  // 表满按最旧淘汰而非整表 clear（整表 clear 可被攻击者重置全员限额）
  const key = clientKey(req) + '|' + req.url + '|' + String(extra || '');
  const now = Date.now();
  const b = rateBuckets.get(key);
  if (b && now - b.t0 < 60000) {
    b.n += 1;
    if (b.n > limit) return true;
  } else {
    rateBuckets.set(key, { t0: now, n: 1 });
    if (rateBuckets.size > 10000) {
      let oldestKey = null;
      let oldestT = Infinity;
      for (const [k, v] of rateBuckets) {
        if (v.t0 < oldestT) { oldestT = v.t0; oldestKey = k; }
      }
      if (oldestKey !== null) rateBuckets.delete(oldestKey);
    }
  }
  return false;
}

// ---------- HTTP 工具 ----------
function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (d) => {
      size += d.length;
      if (size > limit) {
        reject(new Error('body 超限'));
        req.destroy();
        return;
      }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
async function parseBody(req) {
  try {
    return JSON.parse(await readBody(req) || '{}');
  } catch (e) {
    return { __error: e.message };
  }
}

// ---------- 认证 ----------
function tokenOf(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}
// 审计 P2-8：tokenHash → 设备的内存缓存（避免每请求全表扫描 + 频繁读盘）
const deviceTokenCache = new Map();
function invalidateDeviceCache() {
  deviceTokenCache.clear();
}
function findDeviceByToken(token) {
  if (!token) return null;
  const tokenHash = sha(token);
  const hit = deviceTokenCache.get(tokenHash);
  if (hit) return hit;
  const devices = readJson(devicesFile(), {});
  for (const [username, devs] of Object.entries(devices)) {
    for (const [deviceId, d] of Object.entries(devs)) {
      if (safeEqualHex(d.tokenHash, tokenHash)) {
        const out = { username, deviceId, device: d };
        deviceTokenCache.set(tokenHash, out);
        if (deviceTokenCache.size > 5000) deviceTokenCache.clear();
        return out;
      }
    }
  }
  return null;
}

// ---------- 业务 ----------
// 质检 A1：通用写互斥（注册/pair/lastSeen/meta 更新串行化），防 devices.json/meta.json 读改写竞态
let writeLock = null;
async function withWriteLock(fn) {
  const prev = writeLock || Promise.resolve();
  let release;
  writeLock = new Promise((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}
let registerLock = null;
async function doRegister(body) {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!isValidUsername(username)) return { error: '用户名需 2–32 位字母/数字/._-' };
  if (password.length < 8) return { error: '密码至少 8 位' };
  // 审计 P2-10：注册用进程内互斥，避免并发同名注册双双成功（后写覆盖）
  if (!registerLock) {
    registerLock = new Promise((resolve) => {
      queueMicrotask(() => resolve(undefined));
    });
  }
  const prev = registerLock;
  let release;
  registerLock = new Promise((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    const users = readJson(usersFile(), {});
    if (users[username]) return { conflict: '用户名已存在' };
    const salt = crypto.randomBytes(12).toString('hex');
    users[username] = { salt, hash: hashPassword(password, salt), createdAt: Date.now() };
    writeJson(usersFile(), users);
    log('register', username);
    return { ok: true, username };
  } finally {
    release();
  }
}

async function doPair(body) {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const deviceName = String(body.deviceName || '').trim().slice(0, 60) || '未命名设备';
  const users = readJson(usersFile(), {});
  const u = users[username];
  if (!u) return { notFound: '用户不存在（请先注册）' };
  if (!verifyPassword(password, u.salt, u.hash)) return { unauthorized: '密码错误' };
  return withWriteLock(() => {
    const deviceId = crypto.randomBytes(8).toString('hex');
    const token = crypto.randomBytes(24).toString('hex');
    const devices = readJson(devicesFile(), {});
    devices[username] = devices[username] || {};
    devices[username][deviceId] = { name: deviceName, tokenHash: sha(token), createdAt: Date.now(), lastSeen: Date.now() };
    writeJson(devicesFile(), devices);
    invalidateDeviceCache();
    log('pair', username, deviceName, deviceId);
    return { ok: true, username, deviceId, deviceName, token };
  });
}

function doListSessions(username) {
  const dir = sessionsDir(username);
  const meta = readJson(metaFile(username), {});
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {}
  for (const e of entries) {
    if (!e.isFile() || !isValidSessionName(e.name)) continue;
    const st = fs.statSync(path.join(dir, e.name));
    out.push({ name: e.name, mtime: meta[e.name]?.mtime || Math.floor(st.mtimeMs), size: st.size });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function doPush(username, body) {
  const name = String(body.name || '').trim();
  const content = typeof body.content === 'string' ? body.content : '';
  if (!isValidSessionName(name)) return { error: `会话名非法：${name}` };
  if (!content) return { error: 'content 不能为空' };
  if (Buffer.byteLength(content) > MAX_FILE) return { error: '会话文件超过 20MB 上限' };
  const dir = sessionsDir(username);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, name);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return withWriteLock(() => {
    const meta = readJson(metaFile(username), {});
    meta[name] = { mtime: Date.now(), size: Buffer.byteLength(content) };
    writeJson(metaFile(username), meta);
    return { ok: true, name, mtime: meta[name].mtime, size: meta[name].size };
  });
}

function doPull(username, name) {
  if (!isValidSessionName(name)) return { notFound: '会话不存在' };
  const file = path.join(sessionsDir(username), name);
  try {
    const content = fs.readFileSync(file, 'utf8');
    const meta = readJson(metaFile(username), {});
    return { ok: true, name, content, mtime: meta[name]?.mtime || Math.floor(fs.statSync(file).mtimeMs), size: Buffer.byteLength(content) };
  } catch {
    return { notFound: '会话不存在' };
  }
}

function doDelete(username, name) {
  if (!isValidSessionName(name)) return { notFound: '会话不存在' };
  const dir = sessionsDir(username);
  const file = path.join(dir, name);
  try {
    fs.unlinkSync(file);
  } catch {
    return { notFound: '会话不存在' };
  }
  return withWriteLock(() => {
    const meta = readJson(metaFile(username), {});
    delete meta[name];
    writeJson(metaFile(username), meta);
    return { ok: true, name };
  });
}

// ---------- 密码修改 ----------
function doChangePassword(username, body) {
  const oldPassword = String(body.oldPassword || '');
  const newPassword = String(body.newPassword || '');
  if (newPassword.length < 8) return { error: '新密码至少 8 位' };
  const users = readJson(usersFile(), {});
  const u = users[username];
  if (!u) return { unauthorized: '用户不存在' };
  if (!verifyPassword(oldPassword, u.salt, u.hash)) return { unauthorized: '旧密码错误' };
  const salt = crypto.randomBytes(12).toString('hex');
  users[username] = { ...u, salt, hash: hashPassword(newPassword, salt), updatedAt: Date.now() };
  writeJson(usersFile(), users);
  // 改密吊销既有设备 token：密码可能已泄露，旧 token 一律失效（当前设备也需重新登录）
  const devices = readJson(devicesFile(), {});
  delete devices[username];
  writeJson(devicesFile(), devices);
  invalidateDeviceCache();
  log('password-changed', username, '（全部设备已吊销）');
  return { ok: true, note: '密码已修改，所有设备需重新登录' };
}

// ---------- 会话分享 ----------
function doShareCreate(username, name) {
  if (!isValidSessionName(name)) return { error: `会话名非法：${name}` };
  if (!fs.existsSync(path.join(sessionsDir(username), name))) return { notFound: '你还没有这个会话' };
  const shares = readJson(sharesFile(), {});
  const shareId = crypto.randomBytes(8).toString('hex'); // 16 位分享码（64bit，抗在线爆破；审计 P2-11 修正注释）
  shares[shareId] = { owner: username, name, createdAt: Date.now(), pulls: 0 };
  writeJson(sharesFile(), shares);
  log('share-create', username, name, shareId);
  return { ok: true, shareId, name };
}

function doShareList(username) {
  const shares = readJson(sharesFile(), {});
  const accepted = readJson(acceptedFile(), {})[username] || {};
  const mine = Object.entries(shares)
    .filter(([, s]) => s.owner === username)
    .map(([shareId, s]) => ({ shareId, name: s.name, createdAt: s.createdAt, pulls: s.pulls || 0 }));
  const mineAccepted = Object.entries(accepted).map(([shareId, a]) => ({
    shareId,
    owner: a.owner,
    name: a.name,
    savedAs: a.savedAs,
    acceptedAt: a.acceptedAt,
  }));
  return { ok: true, mine, accepted: mineAccepted };
}

function doShareRevoke(username, shareId) {
  const shares = readJson(sharesFile(), {});
  const s = shares[shareId];
  if (!s) return { notFound: '分享不存在' };
  if (s.owner !== username) return { forbidden: '只能撤销自己的分享' };
  delete shares[shareId];
  writeJson(sharesFile(), shares);
  return { ok: true, shareId };
}

// 接受/刷新分享：克隆（或更新）到接受者自己的会话列表。
//  - 首次接受 → 写入同名文件（同名已有不同内容则另存 .shared- 副本，绝不覆盖）
//  - 再次接受：接受者未修改过副本 → 就地刷新；已修改 → 另存新副本（冲突保留双方）
function doShareAccept(username, shareId) {
  const shares = readJson(sharesFile(), {});
  const s = shares[shareId];
  if (!s) return { notFound: '分享不存在（可能已撤销）' };
  if (s.owner === username) return { error: '不能接受自己的分享' };
  const srcFile = path.join(sessionsDir(s.owner), s.name);
  let content;
  try {
    content = fs.readFileSync(srcFile, 'utf8');
  } catch {
    return { notFound: '分享的会话已被删除' };
  }
  const accepted = readJson(acceptedFile(), {});
  const prev = (accepted[username] || {})[shareId];
  const prevName = prev?.savedAs || s.name;
  const target = path.join(sessionsDir(username), prevName);
  let existing = null;
  try {
    existing = fs.readFileSync(target, 'utf8');
  } catch {}
  let savedAs = prevName;
  let conflict = false;
  if (prev && existing !== null && sha(existing) === prev.copyHash && existing !== content) {
    // 接受者未修改副本：就地刷新到最新
    atomicWriteFileSync(target, content, { mode: 0o600 }); // 质检 H4
  } else if (existing !== null && existing !== content) {
    // 目标名已有不同内容：另存时间戳副本（绝不覆盖）
    savedAs = prevName.replace(/\.jsonl$/, `.shared-${Date.now()}.jsonl`);
    fs.mkdirSync(sessionsDir(username), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(sessionsDir(username), savedAs), content, { mode: 0o600 });
    conflict = true;
  } else {
    fs.mkdirSync(sessionsDir(username), { recursive: true, mode: 0o700 });
    atomicWriteFileSync(target, content, { mode: 0o600 }); // 质检 H4
  }
  return withWriteLock(() => {
    const meta = readJson(metaFile(username), {});
    meta[savedAs] = { mtime: Date.now(), size: Buffer.byteLength(content) };
    writeJson(metaFile(username), meta);
    accepted[username] = accepted[username] || {};
    accepted[username][shareId] = { owner: s.owner, name: s.name, savedAs, acceptedAt: Date.now(), copyHash: sha(content) };
    writeJson(acceptedFile(), accepted);
    shares[shareId].pulls = (shares[shareId].pulls || 0) + 1;
    writeJson(sharesFile(), shares);
    log('share-accept', username, shareId, savedAs, conflict ? '(conflict-copy)' : '(refresh)');
    return {
      ok: true,
      shareId,
      savedAs,
      conflict,
      content,
      mtime: meta[savedAs]?.mtime || Date.now(),
    };
  });
}

// ---------- 路由 ----------
async function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  try {
    if (req.method === 'GET' && p === '/healthz') {
      return json(res, 200, { ok: true, service: 'mingdao-sync', version: 1, uptimeSec: Math.floor((Date.now() - startedAt) / 1000) });
    }
    if (req.method === 'POST' && p === '/api/register') {
      if (rateLimited(req, 10)) return json(res, 429, { error: '尝试过于频繁，请稍后再试' });
      const body = await parseBody(req);
      if (body.__error) return json(res, 400, { error: 'JSON 解析失败' });
      if (rateLimited(req, 5, String(body.username || '').toLowerCase())) return json(res, 429, { error: '该用户名的尝试过于频繁，请稍后再试' });
      if (REGISTRATION === 'closed') return json(res, 403, { error: '注册已关闭（管理员已禁用自助注册）' });
      if (REGISTRATION === 'invite') {
        const code = String(body.inviteCode || '').trim();
        if (!code || !INVITE_CODES.has(code)) return json(res, 403, { error: '需要有效邀请码才能注册' });
      }
      const r = await doRegister(body);
      if (r.error) return json(res, 400, r);
      if (r.conflict) return json(res, 409, r);
      return json(res, 200, r);
    }
    if (req.method === 'POST' && p === '/api/pair') {
      if (rateLimited(req, 10)) return json(res, 429, { error: '尝试过于频繁，请稍后再试' });
      const body = await parseBody(req);
      if (body.__error) return json(res, 400, { error: 'JSON 解析失败' });
      if (rateLimited(req, 5, String(body.username || '').toLowerCase())) return json(res, 429, { error: '该用户名的尝试过于频繁，请稍后再试' });
      const r = await doPair(body);
      if (r.notFound) return json(res, 404, r);
      if (r.unauthorized) return json(res, 401, r);
      return json(res, 200, r);
    }
    // —— 以下均需设备 token ——
    const dev = findDeviceByToken(tokenOf(req));
    if (!dev) return json(res, 401, { error: '未认证：请先 mingdao sync login' });
    // lastSeen 节流写盘：60s 一次，避免高频整表读改写与并发丢失（/api/pair 新增设备被覆盖）
    const nowSeen = Date.now();
    if (nowSeen - (dev.device.lastSeen || 0) > 60000) {
      dev.device.lastSeen = nowSeen;
      // 质检 A1：与 pair 的 devices 写入互斥（60s 节流只降频，不消除竞态——加锁消除）
      withWriteLock(() => {
        const devices = readJson(devicesFile(), {});
        if (devices[dev.username]?.[dev.deviceId]) {
          devices[dev.username][dev.deviceId] = dev.device;
          writeJson(devicesFile(), devices);
        }
      });
    }

    if (req.method === 'POST' && p === '/api/devices') {
      const list = Object.entries(readJson(devicesFile(), {})[dev.username] || {}).map(([id, d]) => ({
        id,
        name: d.name,
        createdAt: d.createdAt,
        lastSeen: d.lastSeen,
        current: id === dev.deviceId,
      }));
      return json(res, 200, { ok: true, username: dev.username, devices: list });
    }
    if (req.method === 'POST' && p === '/api/sessions/list') {
      return json(res, 200, { ok: true, sessions: doListSessions(dev.username) });
    }
    if (req.method === 'POST' && p === '/api/sessions/push') {
      const body = await parseBody(req);
      if (body.__error) return json(res, 400, { error: 'JSON 解析失败' });
      const r = await doPush(dev.username, body);
      if (r.error) return json(res, 400, r);
      return json(res, 200, r);
    }
    if (req.method === 'POST' && p === '/api/sessions/pull') {
      const body = await parseBody(req);
      const r = doPull(dev.username, String(body.name || '').trim());
      if (r.notFound) return json(res, 404, r);
      return json(res, 200, r);
    }
    if (req.method === 'POST' && p === '/api/sessions/delete') {
      const body = await parseBody(req);
      const r = await doDelete(dev.username, String(body.name || '').trim());
      if (r.notFound) return json(res, 404, r);
      return json(res, 200, r);
    }
    if (req.method === 'POST' && p === '/api/password') {
      if (rateLimited(req, 10)) return json(res, 429, { error: '尝试过于频繁，请稍后再试' });
      const body = await parseBody(req);
      const r = doChangePassword(dev.username, body);
      if (r.error) return json(res, 400, r);
      if (r.unauthorized) return json(res, 401, r);
      return json(res, 200, r);
    }
    if (req.method === 'POST' && p === '/api/share/create') {
      const body = await parseBody(req);
      const r = doShareCreate(dev.username, String(body.name || '').trim());
      if (r.error) return json(res, 400, r);
      if (r.notFound) return json(res, 404, r);
      return json(res, 200, r);
    }
    if (req.method === 'POST' && p === '/api/share/list') {
      return json(res, 200, doShareList(dev.username));
    }
    if (req.method === 'POST' && p === '/api/share/revoke') {
      const body = await parseBody(req);
      const r = doShareRevoke(dev.username, String(body.shareId || '').trim());
      if (r.notFound) return json(res, 404, r);
      if (r.forbidden) return json(res, 403, r);
      return json(res, 200, r);
    }
    if (req.method === 'POST' && p === '/api/share/accept') {
      if (rateLimited(req, 10)) return json(res, 429, { error: '尝试过于频繁，请稍后再试' });
      const body = await parseBody(req);
      const r = await doShareAccept(dev.username, String(body.shareId || '').trim());
      if (r.error) return json(res, 400, r);
      if (r.notFound) return json(res, 404, r);
      return json(res, 200, r);
    }
    return json(res, 404, { error: '未知接口' });
  } catch (e) {
    log('error', p, e.message);
    return json(res, 500, { error: '服务器内部错误' });
  }
}

// ---------- 启动 ----------
/** @param {{ port?: any, host?: any, dataDir?: any, cert?: any, key?: any }} [opts] */
export function runSyncServer({ port, host, dataDir, cert, key } = {}) {
  const dir = dataDir || DEFAULT_DATA_DIR;
  ACTIVE_DIR = dir;
  const listenPort = Number(port ?? PORT);
  const listenHost = host || HOST;
  const certFile = cert || CERT;
  const keyFile = key || KEY;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const handler = (req, res) => {
    handle(req, res).catch(() => {});
  };
  let server;
  if (certFile && keyFile) {
    server = https.createServer({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }, handler);
    console.log(new Date().toISOString(), 'HTTPS 模式（证书 ' + certFile + '）');
  } else {
    server = http.createServer(handler);
    console.log(new Date().toISOString(), '警告：HTTP 明文模式（仅限内网/过渡，公网请配置 SYNC_CERT/SYNC_KEY）');
  }
  // 质检 M5：全局并发连接上限（防连接耗尽）
  if (typeof server.maxConnections === 'number') server.maxConnections = 500;
  server.listen(listenPort, listenHost, () => {
    console.log(
      new Date().toISOString(),
      `MingDao 同步服务已启动 http${certFile ? 's' : ''}://${listenHost}:${listenPort} · 数据目录 ${dir}`
    );
  });
  return server;
}

// 直接运行：node src/sync-server.js [端口]
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runSyncServer({ port: Number(process.argv[2]) || undefined });
}
