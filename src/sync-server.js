// MingDao 云同步服务端（零依赖，仅 node:http/https/fs/path/crypto）。
// 部署：node sync-server.js [端口]（默认 443），或 `mingdao sync-server [端口]`
// 环境变量：
//   SYNC_DATA_DIR  数据目录（默认 /var/lib/mingdao-sync）
//   SYNC_HOST      监听地址（默认 0.0.0.0）
//   SYNC_CERT / SYNC_KEY  提供后走 HTTPS（Let's Encrypt 证书路径）
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

const DEFAULT_DATA_DIR = process.env.SYNC_DATA_DIR || '/var/lib/mingdao-sync';
let ACTIVE_DIR = DEFAULT_DATA_DIR;
const HOST = process.env.SYNC_HOST || '0.0.0.0';
const PORT = Number(process.env.SYNC_PORT || process.argv[2] || 443);
const CERT = process.env.SYNC_CERT;
const KEY = process.env.SYNC_KEY;
const MAX_BODY = 20 * 1024 * 1024;
const MAX_FILE = 20 * 1024 * 1024;
const startedAt = Date.now();

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
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
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

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function hashPassword(password, salt) {
  return sha(`${salt}:${password}`);
}
function isValidUsername(u) {
  return typeof u === 'string' && /^[A-Za-z0-9_.-]{2,32}$/.test(u) && u !== '.' && u !== '..';
}
function isValidSessionName(n) {
  return typeof n === 'string' && /^[\w\u4e00-\u9fa5.-]{1,140}\.jsonl$/.test(n) && !n.includes('..');
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
function findDeviceByToken(token) {
  if (!token) return null;
  const tokenHash = sha(token);
  const devices = readJson(devicesFile(), {});
  for (const [username, devs] of Object.entries(devices)) {
    for (const [deviceId, d] of Object.entries(devs)) {
      if (d.tokenHash === tokenHash) return { username, deviceId, device: d };
    }
  }
  return null;
}

// ---------- 业务 ----------
function doRegister(body) {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!isValidUsername(username)) return { error: '用户名需 2–32 位字母/数字/._-' };
  if (password.length < 8) return { error: '密码至少 8 位' };
  const users = readJson(usersFile(), {});
  if (users[username]) return { conflict: '用户名已存在' };
  const salt = crypto.randomBytes(12).toString('hex');
  users[username] = { salt, hash: hashPassword(password, salt), createdAt: Date.now() };
  writeJson(usersFile(), users);
  log('register', username);
  return { ok: true, username };
}

function doPair(body) {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const deviceName = String(body.deviceName || '').trim().slice(0, 60) || '未命名设备';
  const users = readJson(usersFile(), {});
  const u = users[username];
  if (!u) return { notFound: '用户不存在（请先注册）' };
  if (hashPassword(password, u.salt) !== u.hash) return { unauthorized: '密码错误' };
  const deviceId = crypto.randomBytes(8).toString('hex');
  const token = crypto.randomBytes(24).toString('hex');
  const devices = readJson(devicesFile(), {});
  devices[username] = devices[username] || {};
  devices[username][deviceId] = { name: deviceName, tokenHash: sha(token), createdAt: Date.now(), lastSeen: Date.now() };
  writeJson(devicesFile(), devices);
  log('pair', username, deviceName, deviceId);
  return { ok: true, username, deviceId, deviceName, token };
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
  const meta = readJson(metaFile(username), {});
  meta[name] = { mtime: Date.now(), size: Buffer.byteLength(content) };
  writeJson(metaFile(username), meta);
  return { ok: true, name, mtime: meta[name].mtime, size: meta[name].size };
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
  const meta = readJson(metaFile(username), {});
  delete meta[name];
  writeJson(metaFile(username), meta);
  return { ok: true, name };
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
      const body = await parseBody(req);
      if (body.__error) return json(res, 400, { error: 'JSON 解析失败' });
      const r = doRegister(body);
      if (r.error) return json(res, 400, r);
      if (r.conflict) return json(res, 409, r);
      return json(res, 200, r);
    }
    if (req.method === 'POST' && p === '/api/pair') {
      const body = await parseBody(req);
      if (body.__error) return json(res, 400, { error: 'JSON 解析失败' });
      const r = doPair(body);
      if (r.notFound) return json(res, 404, r);
      if (r.unauthorized) return json(res, 401, r);
      return json(res, 200, r);
    }
    // —— 以下均需设备 token ——
    const dev = findDeviceByToken(tokenOf(req));
    if (!dev) return json(res, 401, { error: '未认证：请先 mingdao sync login' });
    dev.device.lastSeen = Date.now();
    const devices = readJson(devicesFile(), {});
    devices[dev.username][dev.deviceId] = dev.device;
    writeJson(devicesFile(), devices);

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
      const r = doPush(dev.username, body);
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
      const r = doDelete(dev.username, String(body.name || '').trim());
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
