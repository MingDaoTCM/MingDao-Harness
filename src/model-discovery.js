// 模型动态发现：设置 API Key 后从服务商 /models 接口拉取真实可用模型，
// 模型名称以线上为准（不硬编码），预设仅作为无网络时的回退与价格/参数的补充。
//  - 缓存 <home>/model-cache.json，TTL 1 小时，避免每次打开都请求
//  - availableModels：只列出已设置 Key 的服务商（凭证库或环境变量），
//    动态名单优先，预设名单回退；自定义模型（config.customModels）恒列出
//  - 未收录预设的线上模型走通用默认（Agent 有兜底参数），计价显示 n/a

import fs from 'node:fs';
import path from 'node:path';
import { mingdaoHome, ensureHome } from './config.js';
import { PROVIDERS, MODELS } from './models.js';
import { getStoredKey } from './credentials.js';

const TTL_MS = 60 * 60 * 1000;

export function modelCacheFile() {
  return path.join(mingdaoHome(), 'model-cache.json');
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(modelCacheFile(), 'utf8'));
  } catch {
    return {};
  }
}

function saveCache(data) {
  try {
    ensureHome();
    fs.writeFileSync(modelCacheFile(), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  } catch {}
}

export function providerHasKey(providerName) {
  const pp = PROVIDERS[providerName];
  if (!pp) return false;
  if (getStoredKey(providerName)) return true;
  if (pp.envKey && process.env[pp.envKey]) return true;
  return false;
}

export function providerBaseUrl(cfg, providerName) {
  const pp = PROVIDERS[providerName];
  if (!pp) return '';
  // 当前服务商的 baseUrl 覆盖优先
  if (providerName === cfg?.provider && cfg?.baseUrl) return cfg.baseUrl;
  return pp.baseUrl || '';
}

export function providerApiKey(providerName) {
  const pp = PROVIDERS[providerName];
  const stored = getStoredKey(providerName);
  if (stored) return stored;
  if (pp?.envKey && process.env[pp.envKey]) return process.env[pp.envKey];
  return '';
}

function isChatModel(id) {
  return !/embedding|rerank|moderation/i.test(id);
}

// 拉取某服务商的真实模型名单（缓存优先；force 强制刷新）
// 返回 { models: [名称], fromCache, fetchedAt }；失败返回 { error }
export async function fetchProviderModels(cfg, providerName, { force = false } = {}) {
  const base = providerBaseUrl(cfg, providerName).replace(/\/+$/, '');
  const key = providerApiKey(providerName);
  if (!base || !key) return { error: '该服务商未设置 API Key' };
  const cache = loadCache();
  const entry = cache[providerName];
  if (!force && entry && Date.now() - entry.fetchedAt < TTL_MS && Array.isArray(entry.models)) {
    return { models: entry.models, fromCache: true, fetchedAt: entry.fetchedAt };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const j = await res.json().catch(() => null);
    const list = (j?.data || [])
      .map((m) => String(m?.id || '').trim())
      .filter((id) => id && isChatModel(id))
      .slice(0, 200);
    if (!list.length) return { error: '接口未返回可用模型' };
    cache[providerName] = { models: list, fetchedAt: Date.now() };
    saveCache(cache);
    return { models: list, fromCache: false, fetchedAt: Date.now() };
  } catch (e) {
    return { error: e.name === 'AbortError' ? '请求超时（8s）' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

// 合并可用模型列表：只含已设置 Key 的服务商；动态名单优先、预设回退；自定义模型恒在。
export async function availableModels(cfg, currentModel) {
  const out = [];
  const seen = new Set();
  for (const [pname, pp] of Object.entries(PROVIDERS)) {
    if (pname === 'custom') continue;
    if (!providerHasKey(pname)) continue;
    const dynamic = await fetchProviderModels(cfg, pname);
    const names = dynamic.models?.length ? dynamic.models : pp.models || [];
    for (const n of names) {
      if (seen.has(n)) continue;
      seen.add(n);
      const preset = MODELS[n];
      out.push({
        name: n,
        label: preset ? `${n} — ${preset.label}` : `${n}（线上最新）`,
        provider: pname,
        providerLabel: pp.label,
        dynamic: !MODELS[n],
      });
    }
  }
  for (const [cmName, cm] of Object.entries(cfg?.customModels || {})) {
    if (seen.has(cmName)) continue;
    seen.add(cmName);
    out.push({
      name: cmName,
      label: `${cmName} — ${cm.label || '自定义模型'}`,
      provider: 'custom',
      providerLabel: '自定义',
      custom: true,
    });
  }
  if (currentModel && !out.some((m) => m.name === currentModel)) {
    out.unshift({
      name: currentModel,
      label: `${currentModel}（当前配置）`,
      provider: 'current',
      providerLabel: '当前',
    });
  }
  return out;
}
