// 配置域（Phase C C1）：/api/state /api/config /api/models-config
// 服务商 Key 管理、自定义模型增删改、API 地址覆盖、系统状态快照。
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig } from '../../../config.js';
import { setStoredKey, removeStoredKey, getStoredKey, maskKey } from '../../../credentials.js';
import { availableModels, fetchProviderModels, providerHasKey } from '../../../model-discovery.js';
import { createProvider, resolveProviderConfig } from '../../../providers/index.js';
import { MODELS, PROVIDERS, modelPreset } from '../../../models.js';
import { detectSandbox } from '../../../tools/bash.js';
import { enableAutostart, disableAutostart, autostartStatus } from '../../../autostart.js';
import { PRICE_DATA_AS_OF } from '../../../pricing.js';
import { listSessions, relativeTime, sessionPreview } from '../../../session.js';
import { currentWorkspace } from '../../../workspace.js';

/**
 * 配置域路由。命中返回 true，未命中返回 false。
 * @param {{req:any,res:any,method:any,p:any,url:any}} ctx
 * @param {any} deps
 * @param {{json:any,readBody:any,MAX_API_BODY:any,validateRemoteUrl:any}} shared
 */
export async function handle({ req, res, method, p, url }, deps, shared) {
  const { json, readBody, MAX_API_BODY } = shared;
  const { cfg, home, state, providerCache, getProviderFor, mcpFacade } = deps;

  if (method === 'GET' && p === '/api/state') {
    const sessions = listSessions(home)
      .slice(0, 30)
      .map((s) => ({ file: s.name, mtime: s.mtime, label: `${relativeTime(s.mtime)} · ${sessionPreview(s.file)}` }));
    // 模型列表：只列已设置 Key 的服务商，名称以 /models 接口线上名单为准（预设仅回退与补价）
    const models = await availableModels(cfg, state.modelName);
    // 思考模式 / 推理等级（v0.2.8）：当前模型是否支持 reasoning、当前档位与可选档位。
    // 按模型独立：reasoningByModel[当前模型] 覆盖 > 全局 reasoningEffort（旧配置兼容）> 模型预设默认。
    const rp = modelPreset(state.modelName);
    const reasoning = {
      supported: Boolean(rp?.supportsReasoning),
      effort: cfg.reasoningByModel?.[state.modelName] ?? cfg.reasoningEffort ?? rp?.reasoningEffort?.default ?? (rp?.supportsReasoning ? 'high' : 'off'),
      options: rp?.reasoningEffort?.options ?? ['low', 'high', 'max'],
    };
    json(res, 200, {
      ok: true,
      model: state.modelName,
      models,
      // 首次使用引导：当前模型无可用 API Key 时前端显示「去 ⚙ 设置填 Key」横幅
      keyReady: Boolean((resolveProviderConfig(cfg, state.modelName) || {}).apiKey),
      permissions: ['ask', 'auto', 'readonly'],
      permission: cfg.permission ?? 'ask',
      sandbox: cfg.sandbox || 'off',
      sandboxSupported: detectSandbox() !== 'none',
      routing: cfg.routing?.enabled ? cfg.routing : null,
      reasoning,
      contextBudget: cfg.contextBudget || 128000,
      pricingAsOf: PRICE_DATA_AS_OF,
      autostart: autostartStatus(),
      notify: cfg.notify !== false,
      workspace: currentWorkspace(state.workingDir)?.name || null,
      home,
      workingDir: state.workingDir,
      mcp: mcpFacade.status(),
      sessions,
    });
    return true;
  }

  if (method === 'POST' && p === '/api/config') {
    const body = await readBody(req, MAX_API_BODY);
    // 内存 cfg 可能比磁盘旧（如 CLI 改过同步地址）：先从磁盘刷新 sync，避免保存时回滚
    cfg.sync = loadConfig()?.sync || cfg.sync;
    const next = /** @type {any} */ ({ model: state.modelName, permission: cfg.permission ?? 'ask' });
    if (body.model !== undefined) {
      const target = String(body.model).trim();
      if (!target) return json(res, 400, { error: '模型名不能为空' });
      const tpc = resolveProviderConfig(cfg, target);
      if (!tpc.apiKey) {
        const hint = tpc.name.startsWith('custom:')
          ? '请在 设置 → 模型与 API Key 中填写该模型的 Key'
          : `请先运行 mingdao key set ${tpc.name}`;
        return json(res, 400, { error: `模型 ${target} 没有可用 API Key（服务商 ${tpc.name}），${hint}` });
      }
      await getProviderFor(target); // 预热（失败会抛错）
      next.model = target;
    }
    if (body.permission !== undefined) {
      const perm = String(body.permission);
      if (!['ask', 'auto', 'readonly'].includes(perm)) {
        return json(res, 400, { error: '权限模式必须是 ask / auto / readonly' });
      }
      next.permission = perm;
    }
    if (body.sandbox !== undefined) {
      const sbx = String(body.sandbox);
      if (!['off', 'readonly', 'safe'].includes(sbx)) {
        return json(res, 400, { error: '沙箱模式必须是 off / readonly / safe' });
      }
      next.sandbox = sbx;
      cfg.sandbox = sbx;
    }
    if (body.routing !== undefined) {
      const on = body.routing === true || body.routing === 'on';
      cfg.routing = {
        enabled: on,
        planner: cfg.routing?.planner || 'deepseek-v4-pro',
        executor: cfg.routing?.executor || 'deepseek-v4-flash',
      };
      next.routing = on;
    }
    if (body.contextBudget !== undefined) {
      const n = Number(body.contextBudget);
      if (!Number.isInteger(n) || n < 1000) {
        return json(res, 400, { error: '上下文预算必须是 ≥1000 的整数' });
      }
      next.contextBudget = n;
      cfg.contextBudget = n;
    }
    if (body.reasoningEffort !== undefined) {
      const re = String(body.reasoningEffort);
      if (!['off', 'low', 'high', 'max'].includes(re)) {
        return json(res, 400, { error: '思考强度必须是 off / low / high / max' });
      }
      // 按模型独立：写入当前模型的覆盖档位（不污染其他模型）
      cfg.reasoningByModel = cfg.reasoningByModel || {};
      cfg.reasoningByModel[state.modelName] = re;
    }
    let autostartChanged = false;
    if (body.autostart !== undefined) {
      autostartChanged = true;
      const okAuto = body.autostart === true || body.autostart === 'on' ? enableAutostart() : disableAutostart();
      if (!okAuto) return json(res, 500, { error: '开机自启设置失败' });
    }
    if (body.notify !== undefined) {
      next.notify = body.notify === true || body.notify === 'on';
      cfg.notify = next.notify;
    }
    if (body.syncAuto !== undefined) {
      cfg.sync = cfg.sync || {};
      cfg.sync.auto = body.syncAuto === true || body.syncAuto === 'on';
    }
    state.modelName = next.model;
    cfg.model = next.model;
    cfg.permission = next.permission;
    saveConfig(cfg);
    json(res, 200, { ok: true, model: state.modelName, permission: cfg.permission, sandbox: cfg.sandbox, routing: cfg.routing?.enabled, contextBudget: cfg.contextBudget, reasoningEffort: cfg.reasoningByModel?.[state.modelName] ?? cfg.reasoningEffort, autostart: autostartChanged ? autostartStatus() : undefined, notify: cfg.notify !== false });
    return true;
  }

  if (method === 'GET' && p === '/api/models-config') {
    const providers = Object.keys(PROVIDERS).map((name) => {
      const pp = /** @type {Record<string, any>} */ (PROVIDERS)[name];
      const stored = getStoredKey(name);
      const env = pp.envKey && process.env[pp.envKey] ? true : false;
      return {
        name,
        label: pp.label,
        baseUrl: pp.baseUrl,
        envKey: pp.envKey || null,
        keyState: stored ? 'stored' : env ? 'env' : 'none',
        keyMasked: stored ? maskKey(stored) : null,
      };
    });
    const customModels = Object.entries(cfg.customModels || {}).map(([name, cm]) => {
      const stored = getStoredKey(`custom:${name}`);
      return {
        name,
        label: cm.label || '',
        baseUrl: cm.baseUrl || '',
        envKey: cm.envKey || null,
        vision: Boolean(cm.vision),
        keyState: stored ? 'stored' : 'none',
        keyMasked: stored ? maskKey(stored) : null,
      };
    });
    json(res, 200, {
      ok: true,
      providers,
      customModels,
      model: state.modelName,
      provider: resolveProviderConfig(cfg, state.modelName).name,
      baseUrlOverride: cfg.baseUrl || '',
    });
    return true;
  }

  if (method === 'POST' && p === '/api/models-config') {
    const body = await readBody(req, MAX_API_BODY);
    const action = body.action;
    // —— 服务商 Key 管理 ——
    if (action === 'setProviderKey') {
      const provider = String(body.provider || '').trim();
      if (!/** @type {Record<string, any>} */ (PROVIDERS)[provider]) return json(res, 400, { error: `未知服务商 ${provider}` });
      const key = String(body.key || '').trim();
      if (!key) return json(res, 400, { error: 'Key 不能为空（删除请用 removeProviderKey）' });
      setStoredKey(provider, key);
      providerCache.clear(); // 质检：Key 立即生效（缓存持有旧无 Key 实例 → 此前需重启）
      // 设置 Key 后立即拉取线上真实模型名单（失败不影响 Key 保存，回退预设）
      const fr = provider === 'custom' ? { error: '自定义服务商无模型列表' } : await fetchProviderModels(cfg, provider, { force: true });
      return json(res, 200, {
        ok: true,
        provider,
        keyMasked: maskKey(key),
        models: fr.models || [],
        modelsNote: fr.error ? `模型列表暂用预设（拉取失败：${fr.error}），稍后可用「刷新模型」重试` : null,
      });
    }
    if (action === 'refreshModels') {
      const provider = String(body.provider || '').trim();
      if (!/** @type {Record<string, any>} */ (PROVIDERS)[provider] || provider === 'custom') return json(res, 400, { error: '未知服务商' });
      if (!providerHasKey(provider)) return json(res, 400, { error: '该服务商未设置 API Key' });
      const fr = await fetchProviderModels(cfg, provider, { force: true });
      if (fr.error) return json(res, 400, { error: `拉取失败：${fr.error}` });
      return json(res, 200, { ok: true, provider, models: fr.models, fromCache: fr.fromCache });
    }
    if (action === 'removeProviderKey') {
      const provider = String(body.provider || '').trim();
      if (!/** @type {Record<string, any>} */ (PROVIDERS)[provider]) return json(res, 400, { error: `未知服务商 ${provider}` });
      removeStoredKey(provider);
      providerCache.clear(); // 质检：Key 删除立即生效
      return json(res, 200, { ok: true, provider });
    }
    // —— 自定义模型增删改 ——
    if (action === 'addCustom' || action === 'updateCustom') {
      const name = String(body.name || '').trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) {
        return json(res, 400, { error: '模型名非法：字母/数字开头，可含 . _ -，1–64 位' });
      }
      if (/** @type {Record<string, any>} */ (MODELS)[name]) return json(res, 400, { error: `${name} 与内置模型同名，请换一个名字` });
      const label = String(body.label || '').trim();
      const baseUrl = String(body.baseUrl || '').trim();
      if (!baseUrl) return json(res, 400, { error: 'API 地址（baseUrl）不能为空' });
      const vurl = await shared.validateRemoteUrl(baseUrl); // 质检 S1：SSRF 防护
      if (vurl.error) return json(res, 400, { error: vurl.error });
      if (action === 'addCustom' && (cfg.customModels || {})[name]) {
        return json(res, 400, { error: `自定义模型 ${name} 已存在（可修改）` });
      }
      cfg.customModels = cfg.customModels || {};
      cfg.customModels[name] = {
        label,
        baseUrl,
        envKey: String(body.envKey || '').trim() || undefined,
        vision: body.vision === true || body.vision === 'on' ? true : undefined,
      };
      if (String(body.key || '').trim()) setStoredKey(`custom:${name}`, String(body.key).trim());
      saveConfig(cfg);
      return json(res, 200, { ok: true, name });
    }
    if (action === 'removeCustom') {
      const name = String(body.name || '').trim();
      if (!(cfg.customModels || {})[name]) return json(res, 400, { error: `自定义模型 ${name} 不存在` });
      delete cfg.customModels[name];
      removeStoredKey(`custom:${name}`);
      if (state.modelName === name) {
        state.modelName = 'deepseek-v4-flash';
        cfg.model = state.modelName;
      }
      saveConfig(cfg);
      return json(res, 200, { ok: true, name, model: state.modelName });
    }
    // 质检（自定义模型连通性）：发起一次最小对话验证 baseUrl+Key 可用
    if (action === 'testCustom') {
      const name = String(body.name || '').trim();
      const cm = (cfg.customModels || {})[name];
      if (!cm) return json(res, 400, { error: `自定义模型 ${name} 不存在` });
      const pc = resolveProviderConfig(cfg, name);
      if (!pc.apiKey) return json(res, 400, { error: '该模型未设置 API Key，请先「设Key」再测试' });
      const t0 = Date.now();
      try {
        const tp = await createProvider(cfg, name);
        const r = await tp.chat({ model: name, messages: [{ role: 'user', content: 'ping' }], tools: [], temperature: 0, maxTokens: 8 });
        return json(res, 200, { ok: true, name, latencyMs: Date.now() - t0, reply: String(r.text || r.reasoning || '').slice(0, 60) || '（空回复，但连接成功）' });
      } catch (/** @type {any} */ e) {
        return json(res, 200, { ok: false, name, latencyMs: Date.now() - t0, error: String(e?.message || e) });
      }
    }
    if (action === 'setCustomKey') {
      const name = String(body.name || '').trim();
      if (!(cfg.customModels || {})[name]) return json(res, 400, { error: `自定义模型 ${name} 不存在` });
      const key = String(body.key || '').trim();
      if (!key) return json(res, 400, { error: 'Key 不能为空' });
      setStoredKey(`custom:${name}`, key);
      providerCache.clear(); // 质检：Key 立即生效
      return json(res, 200, { ok: true, name, keyMasked: maskKey(key) });
    }
    // —— 当前服务商 API 地址覆盖 ——
    if (action === 'setBaseUrl') {
      const baseUrl = String(body.baseUrl || '').trim();
      if (baseUrl) {
        const vurl = await shared.validateRemoteUrl(baseUrl); // 质检 S1：SSRF 防护
        if (vurl.error) return json(res, 400, { error: vurl.error });
      }
      cfg.baseUrl = baseUrl || undefined;
      if (cfg.baseUrl === undefined) delete cfg.baseUrl;
      saveConfig(cfg);
      return json(res, 200, { ok: true, baseUrl: cfg.baseUrl || '' });
    }
    return json(res, 400, { error: '未知操作：setProviderKey|removeProviderKey|addCustom|updateCustom|removeCustom|setCustomKey|setBaseUrl' });
  }

  return false;
}
