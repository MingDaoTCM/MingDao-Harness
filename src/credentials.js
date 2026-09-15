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
import { atomicWriteFileSync } from './atomic-write.js';

export function credentialsPath() {
  return path.join(mingdaoHome(), 'credentials.json');
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
    return { ok: false, missing: false, data: {}, error: String(/** @type {any} */ (err)?.message ?? err) };
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
    return { ok: false, missing: false, data: {}, error: String(/** @type {any} */ (err)?.message ?? err) };
  }
}

export function loadCredentials() {
  // 宽松读（读路径）：读不出来就当空——调用方只想知道「有哪些 key」
  return readCredentialsStrict().data;
}

/** @param {any} creds */
export function saveCredentials(creds) {
  ensureHome();
  const p = credentialsPath();
  atomicWriteFileSync(p, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 }); // 质检 H4：密钥文件原子写
  // mode 只在创建时生效：对已存在但权限过宽的文件强制收权
  try {
    fs.chmodSync(p, 0o600);
  } catch {}
}

/** @param {any} providerName */
export function getStoredKey(providerName) {
  return loadCredentials()[providerName] || null;
}

/** @param {any} providerName @param {any} key */
export function setStoredKey(providerName, key) {
  const creds = loadCredentials();
  if (key) creds[providerName] = String(key);
  else delete creds[providerName];
  saveCredentials(creds);
}

/** @param {any} providerName */
export function removeStoredKey(providerName) {
  setStoredKey(providerName, null);
}

// 脱敏展示：只显示首 6 位与末 4 位，永不输出完整 Key。
/** @param {any} key */
export function maskKey(key) {
  if (!key) return null;
  const s = String(key);
  if (s.length <= 10) return '******';
  return s.slice(0, 6) + '…' + s.slice(-4);
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
