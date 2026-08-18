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

export function credentialsPath() {
  return path.join(mingdaoHome(), 'credentials.json');
}

export function loadCredentials() {
  try {
    const data = JSON.parse(fs.readFileSync(credentialsPath(), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

export function saveCredentials(creds) {
  ensureHome();
  fs.writeFileSync(credentialsPath(), JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
}

export function getStoredKey(providerName) {
  return loadCredentials()[providerName] || null;
}

export function setStoredKey(providerName, key) {
  const creds = loadCredentials();
  if (key) creds[providerName] = String(key);
  else delete creds[providerName];
  saveCredentials(creds);
}

export function removeStoredKey(providerName) {
  setStoredKey(providerName, null);
}

// 脱敏展示：只显示首 6 位与末 4 位，永不输出完整 Key。
export function maskKey(key) {
  if (!key) return null;
  const s = String(key);
  if (s.length <= 10) return '******';
  return s.slice(0, 6) + '…' + s.slice(-4);
}

// 统一的 Key 解析链：环境变量 → 本地凭证库 → config.json 显式字段
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
