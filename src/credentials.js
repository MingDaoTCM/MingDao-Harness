// 凭证管理模块：模型 API Key 的独立存储与解析。
//
// 设计原则（借鉴 gh CLI 等成熟工具）：
//   · Key 绝不进入项目仓库、绝不写入 config.json（config 可分享、可提交）；
//   · 默认存储在 <mingdao-home>/credentials.json，文件权限 600（仅本人可读）；
//   · 解析优先级：环境变量 > 本地凭证库 > config.json 显式字段（兼容旧版本）；
//   · 提供独立的命令行管理：mingdao key status / set / remove / import。

import fs from 'node:fs';
import path from 'node:path';
import { mingdaoHome, ensureHome } from './config.js';
import { atomicWriteFileSync, withFileLock, withFileLockSync as withStateFileLockSync } from './atomic-write.js';
import { redactSecrets } from './redact.js';

/**
 * 值级脱敏（凭证库错误/诊断文本用）。
 *
 * **不在本文件维护第二份前缀表**：规则唯一来源是 `redact.js` 的 `SECRET_VALUE_PATTERNS`
 * ——v0.6.29 的教训就是「同一件事两份名单」，凭证层再抄一份必然再次漂移。
 * @param {any} text
 */
export function redactCredentialText(/** @type {any} */ text) {
  return redactSecrets(text); // 复用同一套规则（前缀表/赋值式/URL 内嵌凭据），不在这里重写循环
}

export function credentialsPath() {
  return path.join(mingdaoHome(), 'credentials.json');
}

/**
 * 凭证库的跨进程锁（v0.7.0 §1.3）：`setKey` / 删除 / 同步登录都在这把锁里做
 * 「重读 → 改一个键 → 原子写」。没有锁时两个进程各拿一份旧快照，后写者会把前者刚存的 Key 抹掉
 * ——用户看到「我明明填了 Key 却变回去了」。
 */
export function credentialsLockFile() {
  return credentialsPath() + '.lock';
}

// v0.6.3（审计 H-8）：**必须区分「文件不存在」与「内容损坏」**。
//
// 原实现把两者都 `catch → {}`，而 key set/remove/import 的写路径是
// 「loadCredentials() → 改一个键 → saveCredentials() 全量重写」——
// 于是 credentials.json 一旦损坏（手改/中断写入），执行任意一次 key 写操作就会
// **把其余全部凭据静默清空并打印成功**（实测复现）。
//
// 读路径（getStoredKey / key status）保持宽松语义不变；写路径必须用严格读并**拒绝写**。
/**
 * 严格读凭证库。
 * @returns {{ok: boolean, missing: boolean, data: Record<string, any>, error: string|null}}
 *   ok=false 且 missing=false 表示「文件存在但读不出来/解析失败」——**此时绝不能写**。
 */
export function readCredentialsStrict() {
  let raw;
  try {
    raw = fs.readFileSync(credentialsPath(), 'utf8');
  } catch (err) {
    if (/** @type {any} */ (err)?.code === 'ENOENT') return { ok: true, missing: true, data: {}, error: null };
    return { ok: false, missing: false, data: {}, error: redactCredentialText(String(/** @type {any} */ (err)?.message ?? err)) };
  }
  try {
    // 容错 BOM：Windows 上 PowerShell 的 `Set-Content -Encoding UTF8` 会写出 BOM，
    // 那是**可解析**的内容，不该被当成损坏而拒绝服务（否则用户改一次配置就永远写不进去）。
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, missing: false, data: {}, error: '顶层不是 JSON 对象' };
    }
    return { ok: true, missing: false, data, error: null };
  } catch (err) {
    // 解析失败的原文可能被某些运行时带进 message（含文件片段）；先过同一套值级规则再外露。
    return { ok: false, missing: false, data: {}, error: redactCredentialText(String(/** @type {any} */ (err)?.message ?? err)) };
  }
}

export function loadCredentials() {
  // 宽松读（读路径）：读不出来就当空——调用方只想知道「有哪些 key」
  const data = readCredentialsStrict().data;
  rememberCredentials(data); // v0.7.0 §1.3：记下基线，写回时只合并增量
  return data;
}

// ---------------------------------------------------------------------------
// v0.7.0 §1.3：凭证库写回的「基线 + 增量」与锁。
// 与 config.json 同一套道理：loadCredentials() 的快照可能已经陈旧，saveCredentials() 若整份写回，
// 会把并发进程刚写入的 provider 键抹掉。锁内重读磁盘、只合并本次真正变化的键。
// ---------------------------------------------------------------------------
/** @type {WeakMap<object, any>} */
const credentialsSnapshots = new WeakMap();

/** @param {any} v @returns {any} */
function cloneCredentials(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/** @param {any} v @returns {boolean} */
function isCredentialObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** @param {any} a @param {any} b @returns {boolean} */
function credentialsEqual(a, b) {
  if (a === b) return true;
  if (!isCredentialObject(a) || !isCredentialObject(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k) || !credentialsEqual(a[k], b[k])) return false;
  }
  return true;
}

/** @param {any} before @param {any} after @param {string[]} prefix @param {{set: [string[], any][], del: string[][]}} patch */
function collectCredentialsPatch(before, after, prefix, patch) {
  if (isCredentialObject(before) && isCredentialObject(after)) {
    for (const k of Object.keys(after)) {
      if (Object.prototype.hasOwnProperty.call(before, k)) collectCredentialsPatch(before[k], after[k], [...prefix, k], patch);
      else patch.set.push([[...prefix, k], cloneCredentials(after[k])]);
    }
    for (const k of Object.keys(before)) {
      if (!Object.prototype.hasOwnProperty.call(after, k)) patch.del.push([...prefix, k]);
    }
    return;
  }
  if (!credentialsEqual(before, after)) patch.set.push([prefix, cloneCredentials(after)]);
}

/** @param {any} base @param {string[]} keys @param {any} value */
function credentialsSetAt(base, keys, value) {
  let cur = base;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const k = keys[i];
    if (!isCredentialObject(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

/** @param {any} base @param {string[]} keys */
function credentialsDeleteAt(base, keys) {
  let cur = base;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const k = keys[i];
    if (!isCredentialObject(cur[k])) return;
    cur = cur[k];
  }
  if (isCredentialObject(cur)) delete cur[keys[keys.length - 1]];
}

/**
 * 记下「这份对象从哪个 home 读出来、当时是什么样」。
 * 跨 home 的字段没有可比性：换了 MINGDAO_HOME 必须退回整份写入（测试/桌面版会切 home）。
 * @param {any} creds
 */
function rememberCredentials(creds) {
  if (isCredentialObject(creds)) credentialsSnapshots.set(creds, { home: mingdaoHome(), data: cloneCredentials(creds) });
}

/** 写凭证库（调用方必须已持锁）：原子写 + 0600。 */
function writeCredentialsUnlocked(/** @type {any} */ creds) {
  ensureHome();
  const p = credentialsPath();
  atomicWriteFileSync(p, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
  // mode 只在创建时生效：对已存在但权限过宽的文件强制收权
  try {
    fs.chmodSync(p, 0o600);
  } catch {}
}

/**
 * 锁内准备要落盘的凭证：重读磁盘 + 合并本次增量。
 * 读不出来时**拒绝写**（H-8：否则一次 key 写操作会清空其余全部凭据）。
 * @param {any} creds @returns {{ok: true, data: any, error: null} | {ok: false, data: null, error: string}}
 */
function prepareCredentialsForWrite(creds) {
  const snapshot = credentialsSnapshots.get(creds);
  const sameHome = Boolean(snapshot) && snapshot.home === mingdaoHome();
  const r = readCredentialsStrict();
  if (!r.ok) {
    return {
      ok: false,
      data: null,
      error: `凭证库读不出来，已拒绝写入以免清空其余凭据：${r.error}（原文件保持原样，请人工检查 ${credentialsPath()}）`,
    };
  }
  if (!sameHome) return { ok: true, data: creds, error: null };
  /** @type {{set: [string[], any][], del: string[][]}} */
  const patch = { set: [], del: [] };
  collectCredentialsPatch(snapshot.data, creds, [], patch);
  const base = r.data || {};
  for (const keys of patch.del) credentialsDeleteAt(base, keys);
  for (const [keys, value] of patch.set) credentialsSetAt(base, keys, value);
  return { ok: true, data: base, error: null };
}

/**
 * 保存整个凭证对象（**签名不变**；返回 `{ok,error}`，旧调用方忽略返回值不受影响）。
 * v0.7.0 §1.3：锁内重读 + 增量合并 + 原子写；失败 warn 且不抛。
 * @param {any} creds @returns {{ok: boolean, error: string|null}}
 */
export function saveCredentials(creds) {
  try {
    ensureHome();
    return withStateFileLockSync(credentialsLockFile(), () => {
      const p = prepareCredentialsForWrite(creds);
      if (!p.ok) {
        console.warn(`[MingDao] ⚠ 凭证库写入被拒绝：${p.error}`);
        return { ok: false, error: p.error };
      }
      writeCredentialsUnlocked(p.data);
      rememberCredentials(creds);
      return { ok: true, error: null };
    });
  } catch (err) {
    const msg = String(/** @type {any} */ (err)?.message ?? err);
    console.warn(`[MingDao] ⚠ 凭证库写入失败（${credentialsPath()}）：${msg}——本次 Key 未保存，请检查磁盘空间/目录权限后重试。`);
    return { ok: false, error: msg };
  }
}

/**
 * 异步版 saveCredentials（WebUI 请求路径）：同一把 credentials.json.lock。
 * @param {any} creds @returns {Promise<{ok: boolean, error: string|null}>}
 */
export async function saveCredentialsAsync(creds) {
  try {
    ensureHome();
    return await withFileLock(credentialsLockFile(), () => {
      const p = prepareCredentialsForWrite(creds);
      if (!p.ok) {
        console.warn(`[MingDao] ⚠ 凭证库写入被拒绝：${p.error}`);
        return { ok: false, error: p.error };
      }
      writeCredentialsUnlocked(p.data);
      rememberCredentials(creds);
      return { ok: true, error: null };
    });
  } catch (err) {
    const msg = String(/** @type {any} */ (err)?.message ?? err);
    console.warn(`[MingDao] ⚠ 凭证库写入失败（${credentialsPath()}）：${msg}——本次 Key 未保存，请检查磁盘空间/目录权限后重试。`);
    return { ok: false, error: msg };
  }
}

/** @param {any} providerName */
export function getStoredKey(providerName) {
  return loadCredentials()[providerName] || null;
}

/**
 * 写入/删除一把 Key（同步版）。v0.7.0 §1.3：整段「读 → 改一个键 → 原子写」持有凭证库锁，
 * 且在锁内**重新读磁盘**——并发 setKey 两把不同 provider 时，两边都会保留。
 *
 * v0.6.7（报告一 M-1；H-8 只修了 key 命令那一层）：**严格读必须内置在写函数里**。
 * 写路径是「读 → 改一个键 → 全量重写」，宽松读（读不出来当空对象）会让一次 `init` 向导
 * 或 WebUI 设 Key 就把其余全部凭据静默清空——修在调用点等于要求每个调用点都自觉。
 * 现在：读不出来就**拒绝写**，并把原因返回给调用方（谁也不许静默"成功"）；同时打一条可见 warn。
 * @param {any} providerName @param {any} key
 * @returns {{ok: boolean, error: string|null}}
 */
export function setStoredKey(providerName, key) {
  try {
    ensureHome();
    return withStateFileLockSync(credentialsLockFile(), () => {
      const r = readCredentialsStrict();
      if (!r.ok) {
        const error = `凭证库读不出来，已拒绝写入以免清空其余凭据：${r.error}（原文件保持原样，请人工检查 ${credentialsPath()}）`;
        console.warn(`[MingDao] ⚠ ${error}`);
        return { ok: false, error };
      }
      const creds = r.data;
      if (key) creds[providerName] = String(key);
      else delete creds[providerName];
      writeCredentialsUnlocked(creds);
      return { ok: true, error: null };
    });
  } catch (err) {
    const msg = String(/** @type {any} */ (err)?.message ?? err);
    console.warn(`[MingDao] ⚠ 凭证库写入失败（${credentialsPath()}）：${msg}——本次 Key 未保存，请检查磁盘空间/目录权限后重试。`);
    return { ok: false, error: msg };
  }
}

/**
 * 异步版 setStoredKey（WebUI 请求路径）：同一把锁、同样的锁内重读语义，等待时让出事件循环。
 * @param {any} providerName @param {any} key
 * @returns {Promise<{ok: boolean, error: string|null}>}
 */
export async function setStoredKeyAsync(providerName, key) {
  try {
    ensureHome();
    return await withFileLock(credentialsLockFile(), () => {
      const r = readCredentialsStrict();
      if (!r.ok) {
        const error = `凭证库读不出来，已拒绝写入以免清空其余凭据：${r.error}（原文件保持原样，请人工检查 ${credentialsPath()}）`;
        console.warn(`[MingDao] ⚠ ${error}`);
        return { ok: false, error };
      }
      const creds = r.data;
      if (key) creds[providerName] = String(key);
      else delete creds[providerName];
      writeCredentialsUnlocked(creds);
      return { ok: true, error: null };
    });
  } catch (err) {
    const msg = String(/** @type {any} */ (err)?.message ?? err);
    console.warn(`[MingDao] ⚠ 凭证库写入失败（${credentialsPath()}）：${msg}——本次 Key 未保存，请检查磁盘空间/目录权限后重试。`);
    return { ok: false, error: msg };
  }
}

/** @param {any} providerName */
export function removeStoredKey(providerName) {
  return setStoredKey(providerName, null);
}

/** 异步版 removeStoredKey（WebUI 请求路径）。 @param {any} providerName */
export function removeStoredKeyAsync(providerName) {
  return setStoredKeyAsync(providerName, null);
}

// 脱敏展示（**本机 CLI 专用**）：显示首 6 位与末 4 位，便于在终端里认出"是哪把 key"。
// 注意：这**不是** HTTP 返回口径——v0.6.29（minimax L-9）起，所有 /api/* 响应一律改用
// `maskKeyTail()`（只回末 4 位），因为 Web 响应会进浏览器历史/截图/剪贴板，首 6 位同样是
// 不该外露的指纹信息。保留本函数是为了 `mingdao key list` 等本机终端输出不退化。
/** @param {any} key */
export function maskKey(key) {
  if (!key) return null;
  const s = String(key);
  if (s.length <= 10) return '******';
  return s.slice(0, 6) + '…' + s.slice(-4);
}

// HTTP/API 返回口径（v0.6.29，minimax L-9）：**只回末 4 位**，固定长度、不含任何前缀字符。
// 例：`sk-live-abcdef…wxyz` → `…wxyz`。过短（≤8）用固定 `******`，不回显长度以外的信息。
/** @param {any} key */
export function maskKeyTail(key) {
  if (!key) return null;
  const s = String(key);
  if (s.length <= 8) return '******';
  return '…' + s.slice(-4);
}

// 统一的 Key 解析链：环境变量 → 本地凭证库 → config.json 显式字段
/** @param {any} cfg @param {any} providerName @param {any} envKeyHint */
export function resolveApiKey(cfg, providerName, envKeyHint) {
  const envKeys = [envKeyHint, 'MINGDAO_API_KEY'].filter((k, i, a) => k && a.indexOf(k) === i);
  for (const k of envKeys) {
    const v = process.env[k];
    if (v) return v;
  }
  const stored = getStoredKey(providerName);
  if (stored) return stored;
  return cfg?.apiKey || '';
}
