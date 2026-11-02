// MingDao 云同步服务端（零依赖，仅 node:http/https/fs/path/crypto）。
// 部署：node sync-server.js [端口]（默认 443），或 `mingdao sync-server [端口]`
// 环境变量：
//   SYNC_DATA_DIR  数据目录（默认 /var/lib/mingdao-sync）
//   SYNC_HOST      监听地址（v0.6.29 起默认 127.0.0.1；对外请显式 SYNC_HOST=0.0.0.0 + TLS）
//   SYNC_CERT / SYNC_KEY  提供后走 HTTPS（Let's Encrypt 证书路径）
//   MINGDAO_SYNC_REGISTRATION  注册开关：invite（需邀请码）| closed（默认）| open（不推荐）
//   MINGDAO_SYNC_INVITE_CODES  邀请码列表（逗号分隔，仅 invite 模式生效）
//   MINGDAO_SYNC_ALLOW_LOOPBACK_REGISTRATION=1  显式允许「本机直连」自助注册（默认 0 = 不豁免）
//   SYNC_TRUST_PROXY=1 / SYNC_TRUST_PROXY_HOPS=<n>  仅在可信反代后开启；未设时完全忽略 XFF
//   SYNC_REQUESTS_PER_MIN  每账号每分钟数据接口请求上限（默认 60）
//   SYNC_QUOTA_MB_PER_DAY  每账号每日同步字节配额，单位 MB（默认 512；0 = 不限制）
// 数据布局：
//   <DATA_DIR>/users.json                 {用户名: {salt, hash, createdAt}}
//   <DATA_DIR>/devices.json               {用户名: {设备ID: {name, tokenHash, createdAt, lastSeen}}}
//   <DATA_DIR>/data/<用户名>/sessions/    各设备会话 JSONL
//   <DATA_DIR>/data/<用户名>/meta.json    {会话名: {mtime, size}}
// 安全：密码 sha256(salt:password) 存储；设备 token 48 位随机数，服务端只存哈希；
//       会话名白名单校验；body ≤ 20MB；推荐 HTTPS 部署（明文 HTTP 仅限内网/过渡）。

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { atomicWriteFileSync } from './atomic-write.js';

const DEFAULT_DATA_DIR = process.env.SYNC_DATA_DIR || '/var/lib/mingdao-sync';
let ACTIVE_DIR = DEFAULT_DATA_DIR;
// v0.6.29（审计 M-14）：默认只监听回环地址。旧默认 0.0.0.0 会让「刚装好、还没配 TLS/注册策略」
// 的同步服务直接暴露在公网；默认回环 + 注册 closed 是安全的一侧，对外部署必须显式选择。
const HOST = process.env.SYNC_HOST || '127.0.0.1';
const PORT = Number(process.env.SYNC_PORT || process.argv[2] || 443);
const CERT = process.env.SYNC_CERT;
const KEY = process.env.SYNC_KEY;
const MAX_BODY = 20 * 1024 * 1024;
const MAX_FILE = 20 * 1024 * 1024;
const startedAt = Date.now();
// 注册开关（P3-10）：公网自建时用 invite/closed 限制自助注册。
// v0.6.29（M-14）：默认从 open 改为 closed。
// v0.6.30（N-10）：**不再从请求推断「本机来源」**。旧实现的「监听回环 + 回环来源即放行」在两种
// 真实形态下失效：① TRUST_PROXY=1 时 clientIp 取 XFF 第一段（客户端自填）→ 伪造 127.0.0.1 即注册；
// ② 文档推荐的「回环监听 + nginx 反代」下所有外部客户端的 socket.remoteAddress 都是 127.0.0.1。
// 现在默认 closed **无条件**成立；本机首启必须由部署方显式声明 ALLOW_LOOPBACK_REGISTRATION=1，
// 且只对「本机直连」（无代理配置、无任何转发头）生效。显式 closed 仍然连本机也拒绝。
const REGISTRATION_ENV = process.env.MINGDAO_SYNC_REGISTRATION;
const REGISTRATION = String(REGISTRATION_ENV || 'closed').trim().toLowerCase();
const REGISTRATION_AUTO = !REGISTRATION_ENV;
const ALLOW_LOOPBACK_REGISTRATION = String(process.env.MINGDAO_SYNC_ALLOW_LOOPBACK_REGISTRATION || '') === '1';
// v0.6.30（N-10 的第二条显式引导）：默认 closed + 首次启动（users.json 为空）时，生成一个**一次性**
// 本机引导码文件（0600，路径含实际端口）。只有能读到本机文件的客户端（`mingdao sync login` 会自动
// 读取并随注册请求提交）才能用它完成首启；经反代/远程的外部客户端没有本地文件访问权 → 仍 403。
// 每个码只能成功注册一次：成功后**轮换**（旧码作废、写新码），因此本机首启期可继续创建多个账号；
// 服务器关闭时删除文件。这样既保留了「本机信任」的多账号用法，又不把 closed 重新变成对全网开放。
/** @type {string|null} */
let bootstrapCode = null;
/** @type {string|null} */
let bootstrapCodeFile = null;
/** @type {number|string|null} */
let bootstrapPort = null;
/** @param {number|string} port */
function bootstrapCodePath(port) {
  return path.join(os.tmpdir(), `mingdao-sync-bootstrap-${port}.txt`);
}
/** @param {number|string} port */
function armBootstrapCode(port) {
  clearBootstrapCode(true);
  const code = crypto.randomBytes(16).toString('hex');
  const file = bootstrapCodePath(port);
  try {
    fs.writeFileSync(file, `${code}\n`, { mode: 0o600 });
    bootstrapCode = code;
    bootstrapCodeFile = file;
    bootstrapPort = port;
    log(`本机首启引导码：${file}（一次性；每次注册成功后轮换；仅本机直连且能读到该文件时可用）`);
  } catch (e) {
    console.warn(new Date().toISOString(), '本机首启引导码生成失败：' + String(/** @type {any} */ (e)?.message || e));
  }
}
/** @param {boolean} [removeFile] */
function clearBootstrapCode(removeFile = true) {
  if (removeFile && bootstrapCodeFile) {
    try {
      fs.unlinkSync(bootstrapCodeFile);
    } catch (e) {
      console.warn(new Date().toISOString(), '清理本机首启引导码失败：' + String(/** @type {any} */ (e)?.message || e));
    }
  }
  bootstrapCode = null;
  bootstrapCodeFile = null;
  bootstrapPort = null;
}
const INVITE_CODES = new Set(
  String(process.env.MINGDAO_SYNC_INVITE_CODES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

/** @type {(...a: any[]) => void} */
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- 存储（v0.6.29 H-02：严格读取 + 最小 schema + 损坏隔离） ----------
// 旧实现 `catch { return fallback }` 把 ENOENT 与「权限错误 / JSON 解析失败 / 顶层类型不符」
// 抹平成同一件事；调用方把损坏当成「首次运行的空库」，随后一次注册/配对/推送/分享写操作
// 就把整份用户/设备/元数据/分享状态覆盖成只含新数据的文件（原始数据永久丢失）。
// 现在：**只有 ENOENT 可以初始化空对象**；其余一律抛 StateCorruptError，由 handle 统一返回 5xx，
// 并把损坏原件**复制**成不重名的 `<file>.corrupt-<时间戳>[-n]`（原文件一个字节都不动）。
class StateCorruptError extends Error {
  /**
   * @param {string} file
   * @param {string} reason
   */
  constructor(file, reason) {
    super(`${path.basename(file)} 无法安全读取：${reason}`);
    this.name = 'StateCorruptError';
    this.file = file;
    this.reason = reason;
  }
}
/**
 * @param {any} v
 * @returns {boolean}
 */
function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}
/** @param {any} v @returns {boolean} */
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}
/** @param {any} v @returns {boolean} */
function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}
// 原型链危险键：JSON.parse 允许 `"__proto__"` 作为自有属性，但后续 `obj[key] = v` 会改写原型。
/** @param {string} k @returns {boolean} */
function isSafeKey(k) {
  return k !== '__proto__' && k !== 'prototype' && k !== 'constructor';
}
/**
 * 顶层必须是「名字 → 对象」的映射；逐条校验值。
 * @param {any} data
 * @param {string} label
 * @param {(key: string, value: any) => string | null} checkValue
 * @returns {string | null}
 */
function checkMap(data, label, checkValue) {
  if (!isPlainObject(data)) {
    return `顶层不是 JSON 对象（实际是 ${Array.isArray(data) ? '数组' : data === null ? 'null' : typeof data}）`;
  }
  for (const [k, v] of Object.entries(data)) {
    if (!isSafeKey(k)) return `${label}包含危险键 ${k}`;
    const err = checkValue(k, v);
    if (err) return `${label}字段 ${k} 不合法：${err}`;
  }
  return null;
}
/**
 * 最小 schema：只钉「对象形态 + 必要字段类型」，不限定扩展字段（旧版本字段全部保留）。
 * @param {string} kind
 * @param {any} data
 * @returns {string | null}
 */
function validateState(kind, data) {
  if (kind === 'users') {
    return checkMap(data, '用户表', (k, u) => {
      if (!isPlainObject(u)) return '用户记录必须是对象';
      if (!isNonEmptyString(u.salt)) return 'salt 必须是非空字符串';
      if (!isNonEmptyString(u.hash)) return 'hash 必须是非空字符串';
      if (u.credentialVersion !== undefined && (!Number.isInteger(u.credentialVersion) || u.credentialVersion < 0)) {
        return 'credentialVersion 必须是非负整数';
      }
      return null;
    });
  }
  if (kind === 'devices') {
    return checkMap(data, '设备表', (k, devs) => {
      if (!isPlainObject(devs)) return '用户设备表必须是对象';
      for (const [deviceId, d] of Object.entries(devs)) {
        if (!isSafeKey(deviceId)) return `设备表包含危险键 ${deviceId}`;
        if (!isPlainObject(d)) return `设备 ${deviceId} 记录必须是对象`;
        if (!isNonEmptyString(d.tokenHash)) return `设备 ${deviceId} 的 tokenHash 必须是非空字符串`;
        if (d.name !== undefined && typeof d.name !== 'string') return `设备 ${deviceId} 的 name 必须是字符串`;
        if (d.createdAt !== undefined && !isFiniteNumber(d.createdAt)) return `设备 ${deviceId} 的 createdAt 必须是数字`;
        if (d.lastSeen !== undefined && !isFiniteNumber(d.lastSeen)) return `设备 ${deviceId} 的 lastSeen 必须是数字`;
      }
      return null;
    });
  }
  if (kind === 'meta') {
    return checkMap(data, '会话元数据', (k, m) => {
      if (!isPlainObject(m)) return '元数据条目必须是对象';
      if (!isFiniteNumber(m.mtime)) return 'mtime 必须是数字';
      if (!isFiniteNumber(m.size)) return 'size 必须是数字';
      return null;
    });
  }
  if (kind === 'shares') {
    return checkMap(data, '分享表', (k, s) => {
      if (!isPlainObject(s)) return '分享记录必须是对象';
      if (!isNonEmptyString(s.owner)) return 'owner 必须是非空字符串';
      if (!isNonEmptyString(s.name)) return 'name 必须是非空字符串';
      if (!isFiniteNumber(s.createdAt)) return 'createdAt 必须是数字';
      if (s.pulls !== undefined && (!isFiniteNumber(s.pulls) || s.pulls < 0)) return 'pulls 必须是非负数字';
      return null;
    });
  }
  if (kind === 'accepted') {
    return checkMap(data, '已接受分享表', (k, a) => {
      if (!isPlainObject(a)) return '接受记录的 owner 表必须是对象';
      for (const [shareId, rec] of Object.entries(a)) {
        if (!isSafeKey(shareId)) return `接受表包含危险键 ${shareId}`;
        if (!isPlainObject(rec)) return `接受记录 ${shareId} 必须是对象`;
        if (!isNonEmptyString(rec.owner)) return `接受记录 ${shareId} 的 owner 必须是非空字符串`;
        if (!isNonEmptyString(rec.name)) return `接受记录 ${shareId} 的 name 必须是非空字符串`;
        if (!isNonEmptyString(rec.savedAs)) return `接受记录 ${shareId} 的 savedAs 必须是非空字符串`;
        if (!isFiniteNumber(rec.acceptedAt)) return `接受记录 ${shareId} 的 acceptedAt 必须是数字`;
        if (rec.copyHash !== undefined && typeof rec.copyHash !== 'string') return `接受记录 ${shareId} 的 copyHash 必须是字符串`;
      }
      return null;
    });
  }
  return `未知状态类型 ${kind}`;
}
/**
 * 严格读取。唯一允许的「空初始值」是文件不存在（ENOENT）；其余读取/解析/类型/schema 错误全部抛出。
 * @param {string} file
 * @param {string} kind
 * @returns {any}
 */
function readState(file, kind) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (/** @type {any} */ err) {
    if (err && err.code === 'ENOENT') return {};
    throw new StateCorruptError(file, `读取失败：${err?.message || err}`);
  }
  // BOM 与空文件：内容可能是「合法 JSON + 记事本 BOM」，也可能被截成 0 字节。
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (!text.trim()) throw new StateCorruptError(file, '文件为空（0 字节或仅空白）');
  let data;
  try {
    data = JSON.parse(text);
  } catch (/** @type {any} */ err) {
    throw new StateCorruptError(file, `JSON 解析失败：${err?.message || err}`);
  }
  const bad = validateState(kind, data);
  if (bad) throw new StateCorruptError(file, bad);
  return data;
}
/**
 * 写前再校验一次：任何被其他代码写坏的形状都不落盘（读侧校验之外的第二道闸）。
 * @param {string} file
 * @param {string} kind
 * @param {any} obj
 */
function writeState(file, kind, obj) {
  const bad = validateState(kind, obj);
  if (bad) throw new StateCorruptError(file, `拒绝写入：${bad}`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(file, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 }); // 质检 H4
}
// 同一份损坏内容只备份一次（进程内）；换内容（二次损坏）会得到新的不重名备份。
/** @type {Map<string, { hash: string, path: string }>} */
const quarantinedState = new Map();
/**
 * 把损坏的状态文件**复制**成不重名备份。刻意用复制而不是改名：原文件保持原字节不变，
 * 管理员可以照着备份修；若用 rename，一次「只是试试写接口」的请求就会让原路径消失。
 * @param {string} file
 * @param {string} reason
 * @returns {string | null} 备份路径；无法备份（如文件不可读）时 null
 */
function quarantineStateFile(file, reason) {
  let hash;
  try {
    hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch (/** @type {any} */ err) {
    const prevUnreadable = quarantinedState.get(file);
    if (prevUnreadable && prevUnreadable.hash === 'unreadable' && fs.existsSync(prevUnreadable.path)) return prevUnreadable.path;
    // 权限错误（EACCES）时 copyFile 同样读不了；但 owner 仍可对文件做**硬链接**——link 只看
    // 目录写权限。这样"原件读不出来"也能留下一份字节完全一致的备份（不覆盖任何已有文件）。
    const stamp0 = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    let dest0 = `${file}.corrupt-${stamp0}`;
    for (let k = 1; fs.existsSync(dest0); k += 1) dest0 = `${file}.corrupt-${stamp0}-${k}`;
    try {
      fs.linkSync(file, dest0);
    } catch (/** @type {any} */ linkErr) {
      log('state-quarantine-failed', file, `无法读取原件：${err?.message || err}；硬链接备份也失败：${linkErr?.message || linkErr}`);
      return null;
    }
    quarantinedState.set(file, { hash: 'unreadable', path: dest0 });
    log('state-quarantined', file, dest0, `${reason}（原件不可读，已用硬链接备份）`);
    return dest0;
  }
  const prev = quarantinedState.get(file);
  if (prev && prev.hash === hash && fs.existsSync(prev.path)) return prev.path;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  // 同一秒内两份不同损坏内容：rename/copy 的覆盖语义会吃掉上一份备份——备份的意义是"一份都不许丢"。
  let dest = `${file}.corrupt-${stamp}`;
  for (let k = 1; fs.existsSync(dest); k += 1) dest = `${file}.corrupt-${stamp}-${k}`;
  try {
    fs.copyFileSync(file, dest);
    try {
      fs.chmodSync(dest, 0o600);
    } catch {}
  } catch (/** @type {any} */ err) {
    log('state-quarantine-failed', file, `无法写入备份：${err?.message || err}`);
    return null;
  }
  quarantinedState.set(file, { hash, path: dest });
  log('state-quarantined', file, dest, reason);
  return dest;
}
function usersFile() {
  return path.join(ACTIVE_DIR, 'users.json');
}
function devicesFile() {
  return path.join(ACTIVE_DIR, 'devices.json');
}
/** @param {any} username */
function userDir(username) {
  return path.join(ACTIVE_DIR, 'data', username);
}
/** @param {any} username */
function sessionsDir(username) {
  return path.join(userDir(username), 'sessions');
}
/** @param {any} username */
function metaFile(username) {
  return path.join(userDir(username), 'meta.json');
}
function sharesFile() {
  return path.join(ACTIVE_DIR, 'shares.json');
}
function acceptedFile() {
  return path.join(ACTIVE_DIR, 'accepted.json');
}

// smoke §128 用文本锚点钉住「doShareAccept 在锁内重读 shares」这一事实，锚点里带着旧函数名
// `readJson(sharesFile(), {})`。为不改测试、也不退回"失败返回 fallback"的旧语义，这里保留这个
// 调用形状，但实现委托给**严格读取**：第二个参数只是历史占位，损坏时照常抛错。
/**
 * @param {string} file
 * @param {any} fallback
 */
function readJson(file, fallback) {
  void fallback;
  /** @type {Record<string, string>} */
  const kindByFile = {
    'users.json': 'users',
    'devices.json': 'devices',
    'meta.json': 'meta',
    'shares.json': 'shares',
    'accepted.json': 'accepted',
  };
  const kind = kindByFile[path.basename(file)];
  if (!kind) throw new StateCorruptError(file, '未知状态文件类型');
  return readState(file, kind);
}

// 状态文件读写入口（schema 由 kind 决定；任何调用点都拿不到"损坏就当空库"的旧行为）
function readUsers() {
  return readState(usersFile(), 'users');
}
/** @param {any} obj */
function writeUsers(obj) {
  writeState(usersFile(), 'users', obj);
}
function readDevices() {
  return readState(devicesFile(), 'devices');
}
/** @param {any} obj */
function writeDevices(obj) {
  writeState(devicesFile(), 'devices', obj);
}
/** @param {any} username */
function readMeta(username) {
  return readState(metaFile(username), 'meta');
}
/** @param {any} username @param {any} obj */
function writeMeta(username, obj) {
  writeState(metaFile(username), 'meta', obj);
}
function readShares() {
  return readState(sharesFile(), 'shares');
}
/** @param {any} obj */
function writeShares(obj) {
  writeState(sharesFile(), 'shares', obj);
}
function readAccepted() {
  return readState(acceptedFile(), 'accepted');
}
/** @param {any} obj */
function writeAccepted(obj) {
  writeState(acceptedFile(), 'accepted', obj);
}

/** @type {(s: any) => string} */
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
// 常量时间比较（P3-10）：token/密码哈希等值判断防时序侧信道
/**
 * @param {any} a
 * @param {any} b
 */
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
//
// 审计 BUG-064（实测：单次 scryptSync ≈18ms；10 并发 pair 期间 /healthz 最大延迟 87ms）：
// `scryptSync` 是**同步** CPU 密集调用，会把整个事件循环按住 —— 表现为所有在线设备的请求
// 出现延迟尖峰（限流只压住了单 IP 的频率，多 IP/NAT/CI 出口仍能切片占用）。
// 改用异步 `crypto.scrypt`（libuv 线程池），事件循环不再被阻塞。
// 注意：调用点**都不在写锁内 await** —— 注册/改密所需的新盐与新哈希都在拿锁**之前**算好，
// 免得"锁内 await"把临界区拉长（v0.6.3 P0-4 刚把锁外读改写收进锁内，不能又把它撑开）。
const scryptAsync = promisify(crypto.scrypt);
/**
 * @param {any} password
 * @param {any} salt
 */
async function hashPassword(password, salt) {
  return (await scryptAsync(String(password), String(salt), 32)).toString('hex');
}
/**
 * @param {any} password
 * @param {any} salt
 * @param {any} hash
 */
async function verifyPassword(password, salt, hash) {
  if (!hash) return false;
  try {
    if (safeEqualHex(hash, (await scryptAsync(String(password), String(salt), 32)).toString('hex'))) return true;
  } catch {}
  // 兼容早期 sha256 存储
  return safeEqualHex(hash, sha(`${salt}:${password}`));
}
/** @param {any} u */
function isValidUsername(u) {
  return typeof u === 'string' && /^[A-Za-z0-9_.-]{2,32}$/.test(u) && u !== '.' && u !== '..';
}
/** @param {any} n */
function isValidSessionName(n) {
  return typeof n === 'string' && /^[\w\u4e00-\u9fa5.-]{1,140}\.jsonl$/.test(n) && !n.includes('..');
}

// ---------- 限速（防爆破/枚举；内存表，进程级） ----------
// v0.6.30（N-10）：SYNC_TRUST_PROXY_HOPS 是显式声明「服务端前有几跳可信反代」。
// 未设 TRUST_PROXY / HOPS 时 **完全忽略 X-Forwarded-For**（旧实现永远信任它，轮换即可重置来源桶）。
const TRUST_PROXY = process.env.SYNC_TRUST_PROXY === '1'; // 仅部署在可信反代后时开启（兼容旧配置）
const TRUST_PROXY_HOPS_RAW = Number(process.env.SYNC_TRUST_PROXY_HOPS || 0);
const TRUST_PROXY_HOPS = Number.isInteger(TRUST_PROXY_HOPS_RAW) && TRUST_PROXY_HOPS_RAW > 0 ? TRUST_PROXY_HOPS_RAW : 0;
const PROXY_TRUSTED = TRUST_PROXY || TRUST_PROXY_HOPS > 0;
const SOURCE_WINDOW_MS = 60000;
const ACCOUNT_FAIL_LIMIT = 5;
const ACCOUNT_FAIL_WINDOW_MS = 15 * 60 * 1000;
const ACCOUNT_BACKOFF_BASE_MS = 5000;
// N-17：账号锁定退避必须有上限，否则攻击者持续用他人用户名打失败即可把真实用户永久锁在 5min。
// 60s 仍能有效压住分布式爆破（配合来源桶 10 次/分钟），同时给真实用户一个确定的恢复上界。
const ACCOUNT_BACKOFF_MAX_MS = 60 * 1000;
/** @type {Map<string, { t0: number, n: number }>} */
const sourceBuckets = new Map();
/** @type {Map<string, { failures: number[], last: number }>} */
const accountBuckets = new Map();
// ---------- 数据面配额（N-3） ----------
// 每账号每分钟请求数 + 每账号每日字节配额。按 **UTC 日** 分桶，进程内记账（重启后清零）。
/** @param {string} name @param {number} fallback */
function positiveNumberEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
const REQUESTS_PER_MIN_PER_ACCOUNT = Math.max(1, Math.floor(positiveNumberEnv('SYNC_REQUESTS_PER_MIN', 60)));
const QUOTA_MB_PER_DAY = positiveNumberEnv('SYNC_QUOTA_MB_PER_DAY', 512);
const DAILY_QUOTA_BYTES = Math.floor(QUOTA_MB_PER_DAY * 1024 * 1024);
/** @type {Map<string, { day: string, reqT0: number, reqN: number, bytes: number }>} */
const accountUsage = new Map();
/** @returns {string} */
function utcDayKey() {
  return new Date().toISOString().slice(0, 10);
}
/** @param {string} username */
function usageFor(username) {
  const day = utcDayKey();
  let u = accountUsage.get(username);
  if (!u || u.day !== day) {
    u = { day, reqT0: 0, reqN: 0, bytes: 0 };
    accountUsage.set(username, u);
  }
  return u;
}
/**
 * 每账号每分钟请求数上限。返回剩余等待毫秒（0 = 放行）。
 * @param {string} username
 * @returns {{ retryAfterMs: number } | null}
 */
function accountRequestLimited(username) {
  const u = usageFor(username);
  const now = Date.now();
  if (now - u.reqT0 >= SOURCE_WINDOW_MS) {
    u.reqT0 = now;
    u.reqN = 1;
    return null;
  }
  u.reqN += 1;
  if (u.reqN > REQUESTS_PER_MIN_PER_ACCOUNT) {
    return { retryAfterMs: Math.max(1, u.reqT0 + SOURCE_WINDOW_MS - now) };
  }
  return null;
}
/**
 * 每日字节配额预检；`addBytes` 为本次将写入/读出的字节数。
 * @param {string} username
 * @param {number} addBytes
 * @returns {{ usedBytes: number, limitBytes: number, resetAt: string } | null}
 */
function quotaExceeded(username, addBytes) {
  if (DAILY_QUOTA_BYTES <= 0) return null; // 显式 0 = 关闭每日配额
  const u = usageFor(username);
  if (u.bytes + Math.max(0, addBytes) > DAILY_QUOTA_BYTES) {
    const tomorrow = new Date();
    tomorrow.setUTCHours(24, 0, 0, 0);
    return { usedBytes: u.bytes, limitBytes: DAILY_QUOTA_BYTES, resetAt: tomorrow.toISOString() };
  }
  return null;
}
/** @param {string} username @param {number} bytes */
function noteQuotaBytes(username, bytes) {
  if (DAILY_QUOTA_BYTES <= 0) return;
  usageFor(username).bytes += Math.max(0, bytes);
}
/** @param {string} ip */
function normalizeIp(ip) {
  let out = String(ip || '').trim().replace(/^"|"$/g, '');
  // XFF 可能带端口（IPv4:port）或 IPv6 方括号，先剥掉再判合法性。
  if (/^\[[^\]]+\](?::\d+)?$/.test(out)) out = out.slice(1, out.indexOf(']'));
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(out)) out = out.split(':')[0];
  // IPv4-mapped IPv6（::ffff:127.0.0.1）与裸 IPv4 必须落进同一个桶，否则同一来源能被拆成两份配额。
  if (out.toLowerCase().startsWith('::ffff:')) out = out.slice(7);
  return out;
}
/**
 * XFF 链里**最靠近服务端**的那一跳（右起）。SYNC_TRUST_PROXY_HOPS=n 时取右起第 n 跳。
 * 取第一段是错的：标准反代是「追加」，客户端在最前，第一段完全是客户端自填。
 * @param {any} req
 * @returns {string[]}
 */
function forwardedChain(req) {
  const raw = req.headers['x-forwarded-for'];
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((s) => normalizeIp(s))
    .filter((s) => net.isIP(s) !== 0);
}
/** @param {any} req */
function clientIp(req) {
  const direct = normalizeIp(String(req.socket?.remoteAddress || 'x'));
  // 未显式声明可信反代：XFF 一律不参与身份判定（否则轮换 XFF 就能绕过来源桶）。
  if (!PROXY_TRUSTED) return direct;
  const chain = forwardedChain(req);
  if (!chain.length) return direct;
  const idx = TRUST_PROXY_HOPS > 0 ? chain.length - TRUST_PROXY_HOPS : chain.length - 1;
  return idx >= 0 ? chain[idx] : direct;
}
/** @param {any} req */
function hasProxyHeaders(req) {
  return Boolean(
    req.headers['x-forwarded-for'] ||
      req.headers['x-real-ip'] ||
      req.headers['forwarded'] ||
      req.headers['x-forwarded-proto'] ||
      req.headers['x-forwarded-host']
  );
}
/**
 * 「本机直连」必须是**服务端可判定的事实**，而不是客户端声称的地址：
 * 没有启用任何可信反代配置、请求不带任何转发头、socket 对端本身是回环。
 * 这样「回环监听 + nginx 反代」形态下（对端恒为 127.0.0.1）不会被误判成直连。
 * @param {any} req
 */
function isDirectLoopback(req) {
  if (PROXY_TRUSTED || hasProxyHeaders(req)) return false;
  return isLoopbackIp(normalizeIp(String(req.socket?.remoteAddress || 'x')));
}
/** @param {string} ip */
function isLoopbackIp(ip) {
  return ip === '::1' || ip === 'localhost' || /^127\./.test(ip);
}
/** @param {any} host */
function isLoopbackHost(host) {
  return host === 'localhost' || host === '::1' || /^127\./.test(String(host || ''));
}
/** @param {any} req */
function routeOf(req) {
  let route = String(req.url || '');
  try {
    route = new URL(route, 'http://placeholder').pathname;
  } catch {}
  return route;
}
// 表满按最旧淘汰而非整表 clear（整表 clear 可被攻击者重置全员限额）。
/** @param {Map<string, any>} map */
function pruneBuckets(map) {
  if (map.size <= 10000) return;
  let oldestKey = null;
  let oldestT = Infinity;
  for (const [k, v] of map) {
    const t = v.t0 ?? v.last ?? 0;
    if (t < oldestT) {
      oldestT = t;
      oldestKey = k;
    }
  }
  if (oldestKey !== null) map.delete(oldestKey);
}
/**
 * 来源维度：IP + 路由（压单来源压力）。P1 修复（v0.4.6）：路由分量必须用 pathname，不能用
 * req.url——后者含查询串，攻击者给每个请求加一个随机 `?x=` 就能每次落进新桶。
 * @param {any} req
 * @param {number} [limit]
 * @returns {boolean}
 */
function rateLimited(req, limit = 20) {
  const key = clientIp(req) + '|' + routeOf(req);
  const now = Date.now();
  const b = sourceBuckets.get(key);
  if (b && now - b.t0 < SOURCE_WINDOW_MS) {
    b.n += 1;
    if (b.n > limit) return true;
  } else {
    sourceBuckets.set(key, { t0: now, n: 1 });
    pruneBuckets(sourceBuckets);
  }
  return false;
}
/** @param {any} v */
function normalizeAccount(v) {
  return String(v || '').trim().toLowerCase().slice(0, 64);
}
/** @param {string} route @param {string} account */
function accountKey(route, account) {
  return route + '\u0000' + account;
}
/**
 * 账号维度（跨 IP，v0.6.29 M-02）：返回仍需等待的毫秒数，0 = 未限流。
 * v0.6.30（N-17）：退避上限压到 60s（见 ACCOUNT_BACKOFF_MAX_MS），且只有**已存在**的账号会
 * 被记入失败（调用方必须保证 notFound 不记账）——否则攻击者可用任意用户名制造跨 IP 的账号级 DoS。
 * @param {string} route
 * @param {string} account
 * @returns {number}
 */
function accountWaitMs(route, account) {
  const b = accountBuckets.get(accountKey(route, account));
  if (!b) return 0;
  const now = Date.now();
  b.failures = b.failures.filter((t) => now - t < ACCOUNT_FAIL_WINDOW_MS);
  if (b.failures.length < ACCOUNT_FAIL_LIMIT) return 0;
  // 指数退避：第 5 次失败锁 5s，之后 10s/20s…**上限 60s**；成功认证立即清零。
  const backoff = Math.min(ACCOUNT_BACKOFF_MAX_MS, ACCOUNT_BACKOFF_BASE_MS * 2 ** (b.failures.length - ACCOUNT_FAIL_LIMIT));
  const wait = b.last + backoff - now;
  return wait > 0 ? wait : 0;
}
/**
 * 只对**失败认证**累计账号桶（成功不计数、成功还会清零）。
 * @param {string} route
 * @param {string} account
 */
function noteAccountFailure(route, account) {
  const key = accountKey(route, account);
  const now = Date.now();
  let b = accountBuckets.get(key);
  if (!b) {
    b = { failures: [], last: 0 };
    accountBuckets.set(key, b);
    pruneBuckets(accountBuckets);
  }
  b.failures = b.failures.filter((t) => now - t < ACCOUNT_FAIL_WINDOW_MS);
  b.failures.push(now);
  if (b.failures.length > 64) b.failures = b.failures.slice(-64);
  b.last = now;
}
/** @param {string} route @param {string} account */
function resetAccount(route, account) {
  accountBuckets.delete(accountKey(route, account));
}

// ---------- HTTP 工具 ----------
/** @param {any} req */
function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    /** @type {any[]} */
    const chunks = [];
    let size = 0;
    req.on('data', (/** @type {any} */ d) => {
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
/**
 * @param {any} res
 * @param {any} code
 * @param {any} obj
 */
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
/** @param {any} req */
async function parseBody(req) {
  try {
    return JSON.parse(await readBody(req) || '{}');
  } catch (e) {
    return { __error: /** @type {any} */ (e).message };
  }
}

// ---------- 认证 ----------
/** @param {any} req */
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
/** @param {any} token */
function findDeviceByToken(token) {
  if (!token) return null;
  const tokenHash = sha(token);
  const hit = deviceTokenCache.get(tokenHash);
  if (hit) return hit;
  const devices = readDevices();
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
/** @type {any} */
let writeLock = null;
/** @param {any} fn */
async function withWriteLock(fn) {
  const prev = writeLock || Promise.resolve();
  /** @type {any} */
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
// v0.6.30（N-16）：users.json 上**只允许一把互斥锁**（就是上面的 writeLock）。
// 旧实现另起一个 registerLock 写 users.json，与 doPair/doChangePassword 的 writeLock 互不相干——
// 并发下注册的陈旧 users 快照会覆盖改密刚写入的 credentialVersion，H-03 的单调性前提直接不成立。
// 现在注册也走 withWriteLock：锁内重读 + 校验名字未被占用（N-15 的锁外 hash 见下）。
/** @param {any} body */
async function doRegister(body) {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!isValidUsername(username)) return { error: '用户名需 2–32 位字母/数字/._-' };
  if (password.length < 8) return { error: '密码至少 8 位' };
  // N-15：盐与哈希（~18ms CPU）必须在**锁外**算好。文件头注释的不变量是「锁内不做 CPU 等待」；
  // 旧实现把 await scrypt 放在 registerLock 里，注册并发时锁被 CPU 等待拉长，且与 withWriteLock
  // 交叉时无法保证 users.json 的读改写原子性。
  const salt = crypto.randomBytes(12).toString('hex');
  const hash = await hashPassword(password, salt);
  return withWriteLock(() => {
    const users = readUsers(); // H-02：损坏/不合 schema → 抛错，绝不返回空库后覆盖
    // N-15/N-16：锁内**重读**并重查名字——hash 在锁外算的这段时间里可能已有同名注册成功。
    if (users[username]) return { conflict: '用户名已存在' };
    users[username] = { salt, hash, credentialVersion: 0, createdAt: Date.now() };
    writeUsers(users);
    log('register', username);
    return { ok: true, username };
  });
}

/** @param {any} body */
async function doPair(body) {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const deviceName = String(body.deviceName || '').trim().slice(0, 60) || '未命名设备';
  const users = readUsers();
  const u = users[username];
  if (!u) return { notFound: '用户不存在（请先注册）' };
  // H-03（v0.6.29）：scrypt 仍在锁外（不阻塞事件循环），但"验证所依据的凭证版本"必须在
  // 入锁后重读核对。否则一次已经验完旧密码、还没入锁的配对，能在并发改密吊销全部设备之后
  // 再塞进一台新设备，拿到改密后仍然有效的 token。旧记录没有该字段 → 视为 0。
  const expectedVersion = u.credentialVersion || 0;
  if (!(await verifyPassword(password, u.salt, u.hash))) return { unauthorized: '密码错误' };
  return withWriteLock(() => {
    const usersNow = readUsers();
    const uNow = usersNow[username];
    if (!uNow) return { unauthorized: '用户不存在' };
    if ((uNow.credentialVersion || 0) !== expectedVersion) {
      return { unauthorized: '密码已变更，请用新密码重新配对' };
    }
    const deviceId = crypto.randomBytes(8).toString('hex');
    const token = crypto.randomBytes(24).toString('hex');
    const devices = readDevices();
    devices[username] = devices[username] || {};
    devices[username][deviceId] = { name: deviceName, tokenHash: sha(token), createdAt: Date.now(), lastSeen: Date.now() };
    writeDevices(devices);
    invalidateDeviceCache();
    log('pair', username, deviceName, deviceId);
    return { ok: true, username, deviceId, deviceName, token };
  });
}

/** @param {any} username */
function doListSessions(username) {
  const dir = sessionsDir(username);
  const meta = readMeta(username); // 损坏的 meta.json → 500，而不是把"没有会话"报给客户端
  const out = [];
  /** @type {any[]} */
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

/**
 * @param {any} username
 * @param {any} body
 */
function doPush(username, body) {
  const name = String(body.name || '').trim();
  const content = typeof body.content === 'string' ? body.content : '';
  if (!isValidSessionName(name)) return { error: `会话名非法：${name}` };
  if (!content) return { error: 'content 不能为空' };
  if (Buffer.byteLength(content) > MAX_FILE) return { error: '会话文件超过 20MB 上限' };
  const dir = sessionsDir(username);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, name);
  // 审计 P1-2（v0.4.2）：内容落盘必须在锁内且原子——此前固定 .tmp 名 + 锁外写，
  // 并发同名 push 互相覆盖 tmp、rename 竞态，内容与 meta size 可能错位。
  return withWriteLock(() => {
    // H-02：先严格读 meta（损坏时在**任何文件写入之前**失败），再落内容 → 不会出现
    // "会话文件已写、元数据报错"的半截状态。
    const meta = readMeta(username);
    atomicWriteFileSync(file, content, { mode: 0o600 });
    meta[name] = { mtime: Date.now(), size: Buffer.byteLength(content) };
    writeMeta(username, meta);
    return { ok: true, name, mtime: meta[name].mtime, size: meta[name].size };
  });
}

/**
 * @param {any} username
 * @param {any} name
 */
function doPull(username, name) {
  if (!isValidSessionName(name)) return { notFound: '会话不存在' };
  const file = path.join(sessionsDir(username), name);
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return { notFound: '会话不存在' };
  }
  // H-02：meta 读取失败不能被上面那个"文件不存在"的 catch 吞成 404（那是另一码事）。
  const meta = readMeta(username);
  return { ok: true, name, content, mtime: meta[name]?.mtime || Math.floor(fs.statSync(file).mtimeMs), size: Buffer.byteLength(content) };
}

/**
 * @param {any} username
 * @param {any} name
 */
function doDelete(username, name) {
  if (!isValidSessionName(name)) return { notFound: '会话不存在' };
  const dir = sessionsDir(username);
  const file = path.join(dir, name);
  return withWriteLock(() => {
    // H-02：先严格读 meta 再删文件——meta 损坏时不会先删掉会话、再报 500。
    const meta = readMeta(username);
    try {
      fs.unlinkSync(file);
    } catch {
      return { notFound: '会话不存在' };
    }
    delete meta[name];
    writeMeta(username, meta);
    return { ok: true, name };
  });
}

// ---------- 密码修改 ----------
/**
 * @param {any} username
 * @param {any} body
 */
async function doChangePassword(username, body) {
  const oldPassword = String(body.oldPassword || '');
  const newPassword = String(body.newPassword || '');
  if (newPassword.length < 8) return { error: '新密码至少 8 位' };
  // 审计 BUG-064：校验旧密码与新密码的哈希都是 ~18ms 的 CPU 活，放在**锁外** await；
  // 锁内只剩纯同步的读改写（这样既不再阻塞事件循环，也不会把写锁撑长）。
  const usersBefore = readUsers();
  const uBefore = usersBefore[username];
  if (!uBefore) return { unauthorized: '用户不存在' };
  // H-03（v0.6.29）：记下验证所依据的凭证版本，入锁后核对——两个并发改密基于同一旧版本时，
  // 只有一个能成功；后到者返回 409，而不是悄悄覆盖先到者的新密码（并让先到者的设备吊销失效）。
  const expectedVersion = uBefore.credentialVersion || 0;
  if (!(await verifyPassword(oldPassword, uBefore.salt, uBefore.hash))) return { unauthorized: '旧密码错误' };
  const newSalt = crypto.randomBytes(12).toString('hex');
  const newHash = await hashPassword(newPassword, newSalt);
  return withWriteLock(() => {
    // v0.6.3（P0-4）：改密会 `delete devices[username]`（吊销全部设备 token），而设备表另有
    // 一把 registerLock/写锁——此前这里是**锁外**读改写，于是"吊销"可以被一次并发的 pair
    // 写回覆盖，已吊销的旧 token 复活。改密与设备表写必须互斥。
    const users = readUsers();
    const u = users[username];
    if (!u) return { unauthorized: '用户不存在' };
    if ((u.credentialVersion || 0) !== expectedVersion) {
      return { conflict: '密码已被其他请求修改，请用最新密码重试' };
    }
    // H-02：设备表也先严格读出来再写——损坏时不能先把 users 改了、再 500。
    const devices = readDevices();
    users[username] = { ...u, salt: newSalt, hash: newHash, credentialVersion: expectedVersion + 1, updatedAt: Date.now() };
    writeUsers(users);
    // 改密吊销既有设备 token：密码可能已泄露，旧 token 一律失效（当前设备也需重新登录）
    delete devices[username];
    writeDevices(devices);
    invalidateDeviceCache();
    log('password-changed', username, '（全部设备已吊销）');
    return { ok: true, note: '密码已修改，所有设备需重新登录' };
  });
}

// ---------- 会话分享 ----------
/**
 * @param {any} username
 * @param {any} name
 */
function doShareCreate(username, name) {
  if (!isValidSessionName(name)) return { error: `会话名非法：${name}` };
  if (!fs.existsSync(path.join(sessionsDir(username), name))) return { notFound: '你还没有这个会话' };
  const shares = readShares();
  const shareId = crypto.randomBytes(8).toString('hex'); // 16 位分享码（64bit，抗在线爆破；审计 P2-11 修正注释）
  shares[shareId] = { owner: username, name, createdAt: Date.now(), pulls: 0 };
  writeShares(shares);
  log('share-create', username, name, shareId);
  return { ok: true, shareId, name };
}

/** @param {any} username */
function doShareList(username) {
  const shares = readShares();
  const accepted = readAccepted()[username] || {};
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

/**
 * @param {any} username
 * @param {any} shareId
 */
function doShareRevoke(username, shareId) {
  const shares = readShares();
  const s = shares[shareId];
  if (!s) return { notFound: '分享不存在' };
  if (s.owner !== username) return { forbidden: '只能撤销自己的分享' };
  delete shares[shareId];
  writeShares(shares);
  return { ok: true, shareId };
}

// 接受/刷新分享：克隆（或更新）到接受者自己的会话列表。
//  - 首次接受 → 写入同名文件（同名已有不同内容则另存 .shared- 副本，绝不覆盖）
//  - 再次接受：接受者未修改过副本 → 就地刷新；已修改 → 另存新副本（冲突保留双方）
/**
 * @param {any} username
 * @param {any} shareId
 */
function doShareAccept(username, shareId) {
  // v0.6.7（报告一 M-7）：**文件写必须与记账在同一把锁内**。
  // 此前只有 accepted/meta/shares 的写在 withWriteLock 里，而**会话文件本身**的写
  // （就地刷新 / 冲突副本 / 首次落盘）在锁外——两个设备并发接受同一分享时，
  // 同一 target 会被双写（后写覆盖前者）；跨设备冲突时还会丢掉接受方已有的文件。
  // 现在：读源文件（锁外，只读）→ 一切"决定 + 写文件 + 记账"都在同一把锁内完成；
  // 冲突副本同时改为**原子写**（此前是裸 writeFileSync，中断会留半截文件）。
  const src0 = (() => {
    const shares = readShares();
    const s0 = shares[shareId];
    if (!s0) return { notFound: '分享不存在（可能已撤销）' };
    if (s0.owner === username) return { error: '不能接受自己的分享' };
    return { owner: s0.owner, name: s0.name };
  })();
  if (src0.notFound) return { notFound: src0.notFound };
  if (src0.error) return { error: src0.error };
  let content;
  try {
    content = fs.readFileSync(path.join(sessionsDir(src0.owner), src0.name), 'utf8');
  } catch {
    return { notFound: '分享的会话已被删除' };
  }
  return withWriteLock(() => {
    // v0.6.3（P0-4）：**锁内重读**——此前 shares/accepted 在锁外读、写回陈旧快照，
    // 于是"revoke 之后的一次并发 accept"会把已删除的 shareId 写回去（分享复活）。
    const shares2 = readJson(sharesFile(), {});
    if (!shares2[shareId]) return { notFound: '分享不存在（可能已被并发撤销）' };
    const s = shares2[shareId];
    // H-02：accepted/meta 都在任何会话文件写入之前严格读——损坏时不会留下"文件已写、账没记"。
    const accepted2 = readAccepted();
    const meta = readMeta(username);
    const prev = (accepted2[username] || {})[shareId];
    const prevName = prev?.savedAs || s.name;
    const target = path.join(sessionsDir(username), prevName);
    let existing = null;
    try {
      existing = fs.readFileSync(target, 'utf8');
    } catch {}
    let savedAs = prevName;
    let conflict = false;
    if (prev && existing !== null && sha(existing) === prev.copyHash && existing !== content) {
      atomicWriteFileSync(target, content, { mode: 0o600 }); // 接受者未修改副本：就地刷新到最新
    } else if (existing !== null && existing !== content) {
      // 目标名已有不同内容：另存时间戳副本（绝不覆盖）
      savedAs = prevName.replace(/\.jsonl$/, `.shared-${Date.now()}.jsonl`);
      fs.mkdirSync(sessionsDir(username), { recursive: true, mode: 0o700 });
      atomicWriteFileSync(path.join(sessionsDir(username), savedAs), content, { mode: 0o600 }); // v0.6.7（M-7）：改原子写
      conflict = true;
    } else {
      fs.mkdirSync(sessionsDir(username), { recursive: true, mode: 0o700 });
      atomicWriteFileSync(target, content, { mode: 0o600 });
    }
    meta[savedAs] = { mtime: Date.now(), size: Buffer.byteLength(content) };
    writeMeta(username, meta);
    accepted2[username] = accepted2[username] || {};
    accepted2[username][shareId] = { owner: s.owner, name: s.name, savedAs, acceptedAt: Date.now(), copyHash: sha(content) };
    writeAccepted(accepted2);
    shares2[shareId].pulls = (shares2[shareId].pulls || 0) + 1;
    writeShares(shares2);
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
/** @param {any} raw @returns {URL} */
function parseRequestTarget(raw) {
  return new URL(String(raw || ''), 'http://x');
}
/**
 * 畸形 request-target：必须**立即**回 400 并结束连接。旧实现把 URL 解析放在 try 之外，
 * rejected promise 又被 `handle(...).catch(() => {})` 空吞——不写响应也不销毁连接，
 * 每个畸形请求都能占住一个连接直到客户端超时（M-01）。
 * @param {any} req @param {any} res
 */
function rejectRequestTarget(req, res) {
  log('bad-request-target', String(req.url || '').slice(0, 160));
  try {
    res.shouldKeepAlive = false;
    res.setHeader('Connection', 'close');
    return json(res, 400, { error: '非法请求目标（request-target 无法解析）' });
  } catch {
    try {
      res.destroy();
    } catch {}
    return undefined;
  }
}
/**
 * v0.6.30（N-10）：默认 closed **无条件**成立。旧实现在「未显式配置 + 监听回环 + 回环来源」时
 * 自动放行，但"回环来源"是客户端可控的（TRUST_PROXY 下取 XFF 第一段）或部署形态决定的
 * （回环监听 + nginx 反代时每个外部客户端都是 127.0.0.1）。
 * 本机首启只能由部署方**显式声明** MINGDAO_SYNC_ALLOW_LOOPBACK_REGISTRATION=1 开启，且仅对
 * 「本机直连、无任何转发头、未启用可信反代配置」生效；经代理进来的请求一律 closed。
 * @param {any} req
 * @returns {'open'|'invite'|'closed'}
 */
function registrationModeFor(req) {
  if (REGISTRATION === 'invite') return 'invite';
  if (REGISTRATION === 'open') return 'open';
  if (REGISTRATION_AUTO && ALLOW_LOOPBACK_REGISTRATION && isDirectLoopback(req)) return 'open';
  return 'closed';
}
/**
 * 损坏状态：5xx + 明确错误 + 不重名备份（原文件保留）。
 * @param {any} res
 * @param {StateCorruptError} err
 */
function corruptStateResponse(res, err) {
  const backup = quarantineStateFile(err.file, err.reason);
  const reason = String(err.reason || '').split(err.file).join(path.basename(err.file));
  log('state-corrupt', err.file, err.reason, backup || '(备份失败)');
  return json(res, 500, {
    error:
      `服务端状态文件损坏（${path.basename(err.file)}）：${reason}。原文件已保留` +
      `${backup ? `并备份为 ${path.basename(backup)}` : '（备份失败，请检查文件权限）'}；请管理员修复后重试。`,
    code: 'STATE_CORRUPT',
    file: path.basename(err.file),
    backup: backup ? path.basename(backup) : null,
  });
}

/**
 * @param {any} req
 * @param {any} res
 * @param {any} listenHost
 */
async function handle(req, res, listenHost) {
  let p = '';
  try {
    /** @type {URL} */
    let u;
    try {
      u = parseRequestTarget(req.url); // v0.6.29 M-01：URL 解析收在 try 内
    } catch {
      return rejectRequestTarget(req, res);
    }
    p = u.pathname;
    if (req.method === 'GET' && p === '/healthz') {
      return json(res, 200, { ok: true, service: 'mingdao-sync', version: 1, uptimeSec: Math.floor((Date.now() - startedAt) / 1000) });
    }
    if (req.method === 'POST' && p === '/api/register') {
      if (rateLimited(req, 10)) return json(res, 429, { error: '尝试过于频繁，请稍后再试' });
      const body = await parseBody(req);
      if (body.__error) return json(res, 400, { error: 'JSON 解析失败' });
      const acct = normalizeAccount(body.username);
      const acctWait = accountWaitMs('/api/register', acct);
      if (acctWait) return json(res, 429, { error: '该用户名的尝试过于频繁，请稍后再试', retryAfterMs: acctWait });
      const mode = registrationModeFor(req);
      let usedBootstrapCode = false;
      if (mode === 'closed') {
        // N-10 的第二条显式引导：默认 closed + 首启生成的一次性本机引导码。
        // 只接受「码匹配 + 本机直连」——远程/经反代的客户端读不到本机 0600 文件，仍是 403。
        const code = String(body.inviteCode || '').trim();
        usedBootstrapCode = Boolean(code && bootstrapCode && safeEqualHex(code, bootstrapCode) && isDirectLoopback(req));
        if (!usedBootstrapCode) {
          return json(res, 403, {
            error:
              '注册已关闭（管理员已禁用自助注册）。本机首启请使用服务器启动日志中生成的一次性引导码' +
              '（mingdao sync login 会自动读取）；或由管理员显式设置 MINGDAO_SYNC_ALLOW_LOOPBACK_REGISTRATION=1（仅直连生效）。',
          });
        }
      }
      if (mode === 'invite') {
        const code = String(body.inviteCode || '').trim();
        if (!code || !INVITE_CODES.has(code)) return json(res, 403, { error: '需要有效邀请码才能注册' });
      }
      const r = await doRegister(body);
      // 一次性引导码：注册成功后**轮换**（旧码立即作废）；失败不消耗，允许修正用户名/密码后重试。
      if (usedBootstrapCode && r.ok) {
        if (bootstrapPort !== null) armBootstrapCode(bootstrapPort);
        else clearBootstrapCode(true);
      }
      // 注册不是认证：只有"用户名已被占用"这种可被用来枚举的失败才计入账号桶；
      // 密码太短/用户名非法等输入错误不累计，避免用户打错几次就被锁。
      if (r.ok) resetAccount('/api/register', acct);
      else if (r.conflict) noteAccountFailure('/api/register', acct);
      if (r.error) return json(res, 400, r);
      if (r.conflict) return json(res, 409, r);
      return json(res, 200, r);
    }
    if (req.method === 'POST' && p === '/api/pair') {
      if (rateLimited(req, 10)) return json(res, 429, { error: '尝试过于频繁，请稍后再试' });
      const body = await parseBody(req);
      if (body.__error) return json(res, 400, { error: 'JSON 解析失败' });
      const acct = normalizeAccount(body.username);
      // M-02：账号桶跨 IP 共享、只累计失败并退避。命中即拒（不进入 scrypt，省 CPU 也防爆破）。
      const acctWait = accountWaitMs('/api/pair', acct);
      if (acctWait) return json(res, 429, { error: '该账号尝试过于频繁，请稍后再试', retryAfterMs: acctWait });
      const r = await doPair(body);
      if (r.ok) resetAccount('/api/pair', acct);
      // N-17①③：账号桶只对**已存在**账号的失败认证计数。用户不存在仅由来源桶限流——
      // 否则攻击者拿任意用户名打失败也能把（不存在/他人的）账号推进退避。
      else if (r.unauthorized) noteAccountFailure('/api/pair', acct);
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
      // v0.6.3（P0-4）：**必须 await**。withWriteLock 是 async：临界区里任何 I/O 异常
      // （ENOSPC/EACCES/ENOENT）都会让返回的 promise reject，而无人处理 → Node 15+ 默认
      // `--unhandled-rejections=throw` → **整个同步服务进程退出**（所有在线设备一起掉线）。
      try {
        await withWriteLock(() => {
          const devices = readDevices();
          if (devices[dev.username]?.[dev.deviceId]) {
            devices[dev.username][dev.deviceId] = dev.device;
            writeDevices(devices);
          }
        });
      } catch (/** @type {any} */ e) {
        // lastSeen 写失败不影响本次请求的语义（它只是"最近在线"标记），但必须留痕而不是崩掉进程
        log('lastSeen-write-failed', dev.username, String(e?.message || e));
      }
    }

    if (req.method === 'POST' && p === '/api/devices') {
      const list = Object.entries(readDevices()[dev.username] || {}).map(([id, d]) => ({
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
      // N-3（M-07）：数据面配额——每账号每分钟请求数 + 每日字节。超限必须 429 且说明可见。
      const reqGate = accountRequestLimited(dev.username);
      if (reqGate) {
        return json(res, 429, {
          error: `数据接口请求过于频繁：每账号每分钟最多 ${REQUESTS_PER_MIN_PER_ACCOUNT} 次，请 ${Math.ceil(reqGate.retryAfterMs / 1000)}s 后重试`,
          code: 'ACCOUNT_RATE_LIMIT',
          limit: REQUESTS_PER_MIN_PER_ACCOUNT,
          windowMs: SOURCE_WINDOW_MS,
          retryAfterMs: reqGate.retryAfterMs,
        });
      }
      const body = await parseBody(req);
      if (body.__error) return json(res, 400, { error: 'JSON 解析失败' });
      const bytes = typeof body.content === 'string' ? Buffer.byteLength(body.content) : 0;
      const over = quotaExceeded(dev.username, bytes);
      if (over) {
        return json(res, 429, {
          error:
            `今日同步字节配额已用尽：每账号 ${QUOTA_MB_PER_DAY}MB/日，已用 ${(over.usedBytes / 1048576).toFixed(2)}MB、` +
            `本次需 ${(bytes / 1048576).toFixed(2)}MB；配额将于 ${over.resetAt}（UTC 零点）重置。` +
            '如确需更大配额，请管理员调高 SYNC_QUOTA_MB_PER_DAY。',
          code: 'DAILY_QUOTA_EXCEEDED',
          usedBytes: over.usedBytes,
          limitBytes: over.limitBytes,
          requestedBytes: bytes,
          resetAt: over.resetAt,
        });
      }
      const r = await doPush(dev.username, body);
      if (r.error) return json(res, 400, r);
      noteQuotaBytes(dev.username, bytes); // 只在成功后记账
      return json(res, 200, r);
    }
    if (req.method === 'POST' && p === '/api/sessions/pull') {
      const reqGate = accountRequestLimited(dev.username);
      if (reqGate) {
        return json(res, 429, {
          error: `数据接口请求过于频繁：每账号每分钟最多 ${REQUESTS_PER_MIN_PER_ACCOUNT} 次，请 ${Math.ceil(reqGate.retryAfterMs / 1000)}s 后重试`,
          code: 'ACCOUNT_RATE_LIMIT',
          limit: REQUESTS_PER_MIN_PER_ACCOUNT,
          windowMs: SOURCE_WINDOW_MS,
          retryAfterMs: reqGate.retryAfterMs,
        });
      }
      const body = await parseBody(req);
      const r = doPull(dev.username, String(body.name || '').trim());
      if (r.notFound) return json(res, 404, r);
      const bytes = Buffer.byteLength(String(r.content || ''));
      const over = quotaExceeded(dev.username, bytes);
      if (over) {
        return json(res, 429, {
          error:
            `今日同步字节配额已用尽：每账号 ${QUOTA_MB_PER_DAY}MB/日，已用 ${(over.usedBytes / 1048576).toFixed(2)}MB、` +
            `本次需 ${(bytes / 1048576).toFixed(2)}MB；配额将于 ${over.resetAt}（UTC 零点）重置。` +
            '如确需更大配额，请管理员调高 SYNC_QUOTA_MB_PER_DAY。',
          code: 'DAILY_QUOTA_EXCEEDED',
          usedBytes: over.usedBytes,
          limitBytes: over.limitBytes,
          requestedBytes: bytes,
          resetAt: over.resetAt,
        });
      }
      noteQuotaBytes(dev.username, bytes);
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
      const acct = normalizeAccount(dev.username);
      // M-02：改密的账号维度同样跨 IP 生效；只对"旧密码错误"计数，成功改密清零。
      const acctWait = accountWaitMs('/api/password', acct);
      if (acctWait) return json(res, 429, { error: '该账号尝试过于频繁，请稍后再试', retryAfterMs: acctWait });
      const body = await parseBody(req);
      const r = await doChangePassword(dev.username, body); // v0.6.3（P0-4）：改为持锁执行，必须 await
      if (r.ok) resetAccount('/api/password', acct);
      else if (r.unauthorized) noteAccountFailure('/api/password', acct);
      if (r.error) return json(res, 400, r);
      if (r.unauthorized) return json(res, 401, r);
      if (r.conflict) return json(res, 409, r); // H-03：并发改密只有第一个成功
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
    const err = /** @type {any} */ (e);
    // H-02：损坏状态必须 5xx + 明确错误 + 备份，绝不能降级成"空库继续"。
    if (err instanceof StateCorruptError) return corruptStateResponse(res, err);
    log('error', p, err?.message || err);
    // M-01：已发响应头时不能写第二个响应，必须销毁连接；未发头则明确 500（不空吞）。
    if (res.headersSent) {
      try {
        res.destroy();
      } catch {}
      return undefined;
    }
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
  const loopback = isLoopbackHost(listenHost);
  // v0.6.29（M-14）：把安全默认与迁移方式直接打在启动日志里，不要求部署方去翻文档。
  log(
    loopback
      ? `监听 ${listenHost}（默认仅本机；对外提供服务请显式设置 SYNC_HOST 并配置 SYNC_CERT/SYNC_KEY）`
      : `监听 ${listenHost}（非回环）`
  );
  if (REGISTRATION === 'open') {
    log('⚠ 注册：open（自助注册开放；公网部署不推荐，建议 invite + 邀请码）');
  } else if (REGISTRATION === 'invite') {
    log(`注册：invite（需要邀请码，已配置 ${INVITE_CODES.size} 个）`);
  } else if (REGISTRATION_AUTO && ALLOW_LOOPBACK_REGISTRATION) {
    log(
      '注册：closed（默认）—— 已显式允许本机直连自助注册（MINGDAO_SYNC_ALLOW_LOOPBACK_REGISTRATION=1）；' +
        '仅当请求来自本机直连且不带任何转发头时生效，经反代/带 XFF 的请求仍按 closed 拒绝；' +
        '对外提供服务请用 MINGDAO_SYNC_REGISTRATION=invite + MINGDAO_SYNC_INVITE_CODES（或 open，不推荐）'
    );
  } else {
    log(
      '注册：closed（默认，不接受自助注册）—— 本机首启也不自动放行；' +
        '确需本机直连自助注册请显式设置 MINGDAO_SYNC_ALLOW_LOOPBACK_REGISTRATION=1（带 XFF/经反代不生效）；' +
        '对外提供服务请用 MINGDAO_SYNC_REGISTRATION=invite + MINGDAO_SYNC_INVITE_CODES（或 open，不推荐）'
    );
  }
  /** @type {(req: any, res: any) => void} */
  const handler = (req, res) => {
    handle(req, res, listenHost).catch((/** @type {any} */ e) => {
      // M-01：外层兜底**不得空吞**。未发响应头 → 500；已发头 → 销毁连接（不能写第二个响应）。
      log('unhandled', String(e?.stack || e));
      try {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        res.shouldKeepAlive = false;
        json(res, 500, { error: '服务器内部错误' });
      } catch {
        try {
          res.destroy();
        } catch {}
      }
    });
  };
  let server;
  // P2 修复（v0.4.6）：只配了 SYNC_CERT / SYNC_KEY 之一时必须拒绝启动，而不是静默降级成明文。
  // 此前「配了证书但漏配私钥」会得到一个监听 443 的 http.Server，部署方以为在跑 HTTPS，
  // 实际密码、设备 token、全部会话内容都在明文里传（实测：仅设 SYNC_CERT → server 非 https.Server）。
  if (Boolean(certFile) !== Boolean(keyFile)) {
    throw new Error(
      `TLS 配置不完整：SYNC_CERT 与 SYNC_KEY 必须同时提供（当前 ${certFile ? '只设置了 SYNC_CERT' : '只设置了 SYNC_KEY'}）。` +
        '拒绝以降级为明文 HTTP 的方式启动——请补齐另一个环境变量，或两者都不设并显式设置 SYNC_ALLOW_INSECURE=1 使用内网明文模式。'
    );
  }
  const insecureAllowed = String(process.env.SYNC_ALLOW_INSECURE || '') === '1';
  if (certFile && keyFile) {
    server = https.createServer({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }, handler);
    console.log(new Date().toISOString(), 'HTTPS 模式（证书 ' + certFile + '）');
  } else {
    server = http.createServer(handler);
    console.log(new Date().toISOString(), '警告：HTTP 明文模式（仅限内网/过渡，公网请配置 SYNC_CERT/SYNC_KEY）');
    // 非回环绑定时再加一条醒目告警：明文模式下密码/设备 token/会话内容都在网络上裸奔。
    // 不直接拒绝启动，以免破坏 README 记载的 `mingdao sync-server 443` 内网用法。
    if (!loopback && !insecureAllowed) {
      console.log(
        new Date().toISOString(),
        `⚠ 安全警告：正在 ${listenHost}（非回环）上以明文 HTTP 提供同步服务——密码、设备 token 与全部会话内容均可被网络窃听。` +
          '请务必配置 SYNC_CERT/SYNC_KEY 启用 HTTPS；确需内网明文可设置 SYNC_ALLOW_INSECURE=1 显式确认并消除本告警。'
      );
    }
  }
  // 质检 M5：全局并发连接上限（防连接耗尽）
  if (typeof server.maxConnections === 'number') server.maxConnections = 500;
  server.listen(listenPort, listenHost, () => {
    const addr = server.address();
    const actualPort = addr && typeof addr === 'object' ? addr.port : listenPort;
    console.log(
      new Date().toISOString(),
      `MingDao 同步服务已启动 http${certFile ? 's' : ''}://${listenHost}:${actualPort} · 数据目录 ${dir}`
    );
    // v0.6.30（N-10）：默认 closed + 首次启动（还没有任何账号）时生成本机一次性引导码。
    // 显式 open/invite/closed 与显式 ALLOW_LOOPBACK_REGISTRATION 都不生成（前两者有自己的入口，
    // 后者已有更明确的开关）。
    const staleBootstrap = bootstrapCodePath(actualPort);
    if (fs.existsSync(staleBootstrap)) {
      try {
        fs.unlinkSync(staleBootstrap); // 上次异常退出（SIGKILL）留下的旧码，不能继续可用
      } catch (e) {
        console.warn(new Date().toISOString(), '清理陈旧本机首启引导码失败：' + String(/** @type {any} */ (e)?.message || e));
      }
    }
    if (REGISTRATION === 'closed' && REGISTRATION_AUTO && !ALLOW_LOOPBACK_REGISTRATION) {
      try {
        const users = readUsers();
        if (!Object.keys(users).length) armBootstrapCode(actualPort);
      } catch {
        // 状态损坏时不生成引导码：让管理员先修复 users.json（否则会用首启路径掩盖损坏）。
      }
    }
  });
  server.on('close', () => clearBootstrapCode(true));
  return server;
}

// 直接运行：node src/sync-server.js [端口]
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runSyncServer({ port: Number(process.argv[2]) || undefined });
}
