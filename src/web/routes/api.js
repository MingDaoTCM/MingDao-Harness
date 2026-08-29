import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ensureHome, loadConfig, saveConfig, mingdaoHome } from '../../config.js';
import { setStoredKey, removeStoredKey, getStoredKey, maskKey } from '../../credentials.js';
import { availableModels, fetchProviderModels, providerHasKey } from '../../model-discovery.js';
import { createProvider, resolveProviderConfig, helperProvider } from '../../providers/index.js';
import { MODELS, modelPreset, PROVIDERS } from '../../models.js';
import { routeTask, routingConfig } from '../../routing.js';
import { buildUserContent } from '../attachments.js';
import { createAgent } from '../../agent.js';
import { createPermission } from '../../permissions.js';
import { buildSystemPrompt } from '../../prompts.js';
import { createWebIO } from '../web-io.js';
import { startMcpServers } from '../../mcp.js';
import {
  createSession,
  listSessions,
  loadSession,
  appendMessages,
  rewriteSession,
  sessionPreview,
  relativeTime,
  searchSessions,
} from '../../session.js';
import { listSkills, tamperedSkillNames } from '../../skills.js';
import { libraryList, installSkill, uninstallSkill, installedUserSkillNames } from '../../skill-lib.js';
import { detectSandbox } from '../../tools/bash.js';
import { generateTitle, renameSessionFile, titleModel, sanitizeTitle } from '../../titles.js';
import {
  addSchedule,
  listSchedules,
  removeSchedule,
  pauseSchedule,
  resumeSchedule,
  chainSchedules,
  reconcileSchedules,
} from '../../schedule.js';
import { enableAutostart, disableAutostart, autostartStatus } from '../../autostart.js';
import { currentWorkspace, workspaceForDir, listWorkspaces, addWorkspace, removeWorkspace, renameWorkspace, setWorkspaceDir, workspacePath, touchWorkspace, getSessionWorkspace, setSessionWorkspace, removeSessionWorkspace, moveSessionWorkspace } from '../../workspace.js';
import { loadMemory, writeMemory, dedupeMemory } from '../../memory.js';
import { recordUsage, listCacheStats, summarizeCacheStats, costBreakdown } from '../../cachestats.js';
import { PRICE_DATA_AS_OF } from '../../pricing.js';
import { costGuardStatus } from '../../cost-guard.js';
import { presetList, buildPreset } from '../../mcp-presets.js';
import { syncStatus, syncLogin, syncLogout, syncPush, syncPull, syncRemoteList, maybeAutoSync, syncChangePassword, syncShareCreate, syncShareList, syncShareAccept, syncShareRevoke, listSyncConflicts, resolveSyncConflict } from '../../sync.js';

export function createApiDispatch(deps) {
  const { json, srvlog, readBody, cfg, home, providerCache, getProviderFor, tasks, MAX_CONCURRENT, pruneTasks, handleChat, mcpFacade, provider, validateRemoteUrl, isPrivateHost, authEnabled, tokenMatches, requestToken, trustedHost, INDEX_HTML } = deps;
  const state = deps.state; // { modelName, workingDir, draftText }
  const refs = deps.refs; // { inflight }
  const dispatch = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    // 访问控制（P1-3/P1-4）：token 校验覆盖数据与操作接口；壳页面与 PWA 静态资源公开
    // （壳不含任何数据，SPA 需要先加载才能读取 ?token=）；Host 白名单覆盖一切请求
    const isStaticAsset =
      p === '/' || p === '/index.html' || p === '/app.js' || p === '/favicon.ico' || p === '/icon.svg' || p === '/icon-192.png' || p === '/icon-512.png' || p === '/manifest.webmanifest' || p === '/sw.js';
    if (authEnabled && !isStaticAsset && !tokenMatches(requestToken(req, url))) {
      return json(res, 401, { error: '未授权：缺少或无效的访问令牌（地址需带 ?token=…，或请求头携带 X-MingDao-Token）' });
    }
    if (!trustedHost(req.headers.host)) {
      return json(res, 403, { error: 'Host 校验失败：请通过绑定地址访问（DNS rebinding 防护）' });
    }

    // CSRF 防护：跨源请求一律拒绝；POST 仅接受 JSON（拦截表单/纯文本跨站盲提交）
    if (req.method !== 'GET' && req.method !== 'OPTIONS') {
      const origin = req.headers.origin;
      if (origin) {
        try {
          if (new URL(origin).host !== req.headers.host) return json(res, 403, { error: '跨源请求被拒绝' });
        } catch {
          return json(res, 403, { error: '非法 Origin' });
        }
      }
      const ct = String(req.headers['content-type'] || '');
      if (!ct.includes('application/json') && !ct.includes('text/plain')) {
        return json(res, 415, { error: '仅接受 JSON 请求体' });
      }
      if (ct.includes('text/plain')) {
        // text/plain 是经典 CSRF 向量（无需预检）：直接拒绝，要求 application/json
        return json(res, 415, { error: '请使用 application/json' });
      }
    }

    if (req.method === 'GET' && p === '/app.js') {
      // 质检 Q2/S5：SPA 外部 JS——从磁盘读取（与 index.html 同目录）
      try {
        const js = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app.js'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(js);
      } catch {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('app.js 加载失败');
      }
      return;
    }
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      try {
        const html = fs.readFileSync(INDEX_HTML);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch {
        json(res, 500, { error: '前端文件缺失' });
      }
      return;
    }
    // 统一品牌图标：浏览器标签页 /favicon.ico 直接返回 192 PNG
    if (req.method === 'GET' && (p === '/favicon.ico' || p === '/icon-192.png' || p === '/icon-512.png')) {
      try {
        const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'icons', p === '/icon-512.png' ? 'icon-512.png' : 'icon-192.png');
        const buf = fs.readFileSync(file);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
        res.end(buf);
      } catch {
        json(res, 404, { error: 'icon missing' });
      }
      return;
    }
    if (req.method === 'GET' && p === '/api/state') {
      const sessions = listSessions(home)
        .slice(0, 30)
        .map((s) => ({ file: s.name, mtime: s.mtime, label: `${relativeTime(s.mtime)} · ${sessionPreview(s.file)}` }));
      // 模型列表：只列已设置 Key 的服务商，名称以 /models 接口线上名单为准（预设仅回退与补价）
      const models = await availableModels(cfg, state.modelName);
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
      return;
    }
    if (req.method === 'POST' && p === '/api/config') {
      const body = await readBody(req);
      // 内存 cfg 可能比磁盘旧（如 CLI 改过同步地址）：先从磁盘刷新 sync，避免保存时回滚
      cfg.sync = loadConfig()?.sync || cfg.sync;
      const next = { model: state.modelName, permission: cfg.permission ?? 'ask' };
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
      json(res, 200, { ok: true, model: state.modelName, permission: cfg.permission, sandbox: cfg.sandbox, routing: cfg.routing?.enabled, contextBudget: cfg.contextBudget, autostart: autostartChanged ? autostartStatus() : undefined, notify: cfg.notify !== false });
      return;
    }
    if (req.method === 'GET' && p === '/api/models-config') {
      const providers = Object.keys(PROVIDERS).map((name) => {
        const pp = PROVIDERS[name];
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
      return;
    }
    if (req.method === 'POST' && p === '/api/models-config') {
      const body = await readBody(req);
      const action = body.action;
      // —— 服务商 Key 管理 ——
      if (action === 'setProviderKey') {
        const provider = String(body.provider || '').trim();
        if (!PROVIDERS[provider]) return json(res, 400, { error: `未知服务商 ${provider}` });
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
        if (!PROVIDERS[provider] || provider === 'custom') return json(res, 400, { error: '未知服务商' });
        if (!providerHasKey(provider)) return json(res, 400, { error: '该服务商未设置 API Key' });
        const fr = await fetchProviderModels(cfg, provider, { force: true });
        if (fr.error) return json(res, 400, { error: `拉取失败：${fr.error}` });
        return json(res, 200, { ok: true, provider, models: fr.models, fromCache: fr.fromCache });
      }
      if (action === 'removeProviderKey') {
        const provider = String(body.provider || '').trim();
        if (!PROVIDERS[provider]) return json(res, 400, { error: `未知服务商 ${provider}` });
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
        if (MODELS[name]) return json(res, 400, { error: `${name} 与内置模型同名，请换一个名字` });
        const label = String(body.label || '').trim();
        const baseUrl = String(body.baseUrl || '').trim();
        if (!baseUrl) return json(res, 400, { error: 'API 地址（baseUrl）不能为空' });
        const vurl = validateRemoteUrl(baseUrl); // 质检 S1：SSRF 防护
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
          const vurl = validateRemoteUrl(baseUrl); // 质检 S1：SSRF 防护
          if (vurl.error) return json(res, 400, { error: vurl.error });
        }
        cfg.baseUrl = baseUrl || undefined;
        if (cfg.baseUrl === undefined) delete cfg.baseUrl;
        saveConfig(cfg);
        return json(res, 200, { ok: true, baseUrl: cfg.baseUrl || '' });
      }
      return json(res, 400, { error: '未知操作：setProviderKey|removeProviderKey|addCustom|updateCustom|removeCustom|setCustomKey|setBaseUrl' });
    }
    if (req.method === 'GET' && p === '/api/sessions') {
      const q = url.searchParams.get('q');
      const found = q
        ? searchSessions(home, q, { limit: 30 }).map((s) => ({ file: s.name, mtime: s.mtime, label: `${relativeTime(s.mtime)} · ${s.snippet}` }))
        : listSessions(home).slice(0, 30).map((s) => ({ file: s.name, mtime: s.mtime, label: `${relativeTime(s.mtime)} · ${sessionPreview(s.file)}` }));
      json(res, 200, { ok: true, sessions: found });
      return;
    }
    if (req.method === 'GET' && p === '/api/session') {
      const file = url.searchParams.get('file');
      if (!file) return json(res, 400, { error: '缺少 file 参数' });
      try {
        const loaded = loadSession(path.join(home, 'sessions', path.basename(file)));
        // 载入会话时聚焦其工作空间（P3-4）：全局默认切到该会话的目录，前端下拉同步显示
        const wsDir = getSessionWorkspace(path.basename(file));
        const ws = workspaceForDir(wsDir);
        if (wsDir && path.resolve(wsDir) !== path.resolve(state.workingDir)) {
          state.workingDir = wsDir; // 审计 P2-5：仅在目录不同时才切换，减少全局状态抖动
          if (ws) touchWorkspace(ws.name);
        }
        json(res, 200, {
          ok: true,
          messages: loaded.messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ role: m.role, content: m.content ?? '' })),
          workspace: ws?.name || null,
        });
      } catch {
        json(res, 404, { error: '会话不存在' });
      }
      return;
    }
    if (req.method === 'POST' && p === '/api/session') {
      const body = await readBody(req);
      const file = path.basename(String(body.file || ''));
      const full = path.join(home, 'sessions', file);
      if (!file || !fs.existsSync(full)) return json(res, 404, { error: '会话不存在' });
      if (body.action === 'rename') {
        const title = sanitizeTitle(String(body.title || '会话'));
        const renamed = renameSessionFile(fs, path, home, { file: full }, title);
        if (!renamed) return json(res, 500, { error: '重命名失败（可能存在同名会话）' });
        moveSessionWorkspace(file, path.basename(renamed));
        return json(res, 200, { ok: true, file: path.basename(renamed) });
      }
      if (body.action === 'delete') {
        try {
          fs.unlinkSync(full);
          removeSessionWorkspace(file);
          return json(res, 200, { ok: true });
        } catch (err) {
          return json(res, 500, { error: String(err?.message || err) });
        }
      }
      return json(res, 400, { error: '未知操作：rename|delete' });
    }
    if (req.method === 'GET' && p === '/api/skills') {
      json(res, 200, { ok: true, skills: listSkills(state.workingDir), tampered: tamperedSkillNames(state.workingDir) });
      return;
    }
    if (req.method === 'GET' && p === '/api/tasks') {
      const running = [...tasks.values()].filter((t) => t.status === 'running').length;
      const list = [...tasks.entries()].map(([id, t]) => ({
        id,
        status: t.status,
        message: t.message,
        startedAt: t.startedAt,
        durationMs: t.status === 'running' ? Date.now() - t.startedAt : t.durationMs,
        session: t.session ? path.basename(t.session.file) : null,
      }));
      json(res, 200, { ok: true, running, maxConcurrent: MAX_CONCURRENT, tasks: list });
      return;
    }
    if (req.method === 'POST' && p === '/api/chat') {
      // 质检 S2：inflight 计数绑定请求生命周期（进入 ++ / 结束 --）。
      // 此前检查发生在 readBody 之前且占位即删，多请求可同时卡在 readBody 后批量登记 → 瞬时超并发
      refs.inflight += 1;
      if (refs.inflight > MAX_CONCURRENT) {
        refs.inflight -= 1;
        return json(res, 429, { error: `并发任务已达上限（${MAX_CONCURRENT}），请等待任务完成或中断` });
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      let body;
      try {
        body = await readBody(req);
      } catch (e) {
        refs.inflight -= 1;
        res.write(`data: ${JSON.stringify({ type: 'error', message: e.message })}\n\n`);
        res.end();
        return;
      }
      try {
        await handleChat(res, body);
      } catch (err) {
        // 兜底（审计：「点发送无反应」根因防护）：handleChat 内任意未捕获异常若直接外抛，
        // SSE 已开流却无事件 → 前端永远停在「正在思考…」。此处统一转为 error 事件回给界面。
        try {
          res.write(`data: ${JSON.stringify({ type: 'error', message: '对话失败：' + String(err?.message || err) })}\n\n`);
        } catch {}
        try {
          res.end();
        } catch {}
        pruneTasks();
      }
      refs.inflight -= 1; // 与 handleChat 的 finally 无关：handleChat 内部路径全部会返回/结束
      return;
    }
    if (req.method === 'POST' && p === '/api/permission') {
      const body = await readBody(req);
      const entry = tasks.get(body.taskId);
      if (!entry || !entry.pendingAsk) return json(res, 409, { error: '没有挂起的权限确认' });
      const pa = entry.pendingAsk;
      entry.pendingAsk = null;
      const answer = String(body.answer ?? '');
      if (pa.options && Array.isArray(pa.options)) {
        const opt = pa.options.find((o) => String(o.value) === answer);
        pa.resolve(opt ? opt.value : answer);
      } else {
        pa.resolve(answer);
      }
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && p === '/api/abort') {
      const body = await readBody(req);
      if (body.taskId) {
        const entry = tasks.get(body.taskId);
        if (entry?.abortHandler) {
          try {
            entry.abortHandler();
          } catch {}
        }
      } else {
        // 未指定任务：中断全部运行中任务
        for (const t of tasks.values()) {
          if (t.status === 'running' && t.abortHandler) {
            try {
              t.abortHandler();
            } catch {}
          }
        }
      }
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && p === '/api/draft') {
      const text = state.draftText;
      state.draftText = ''; // 读取即清除
      json(res, 200, { ok: true, text });
      return;
    }
    if (req.method === 'POST' && p === '/api/draft') {
      const body = await readBody(req);
      state.draftText = String(body.text ?? '').slice(0, 200000);
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && p === '/api/schedule') {
      reconcileSchedules(home);
      const jobs = listSchedules(home).map((j) => ({
        id: j.id,
        status: j.status,
        kind: j.kind,
        question: j.question,
        nextRunAt: j.nextRunAt,
        lastRunAt: j.lastRunAt,
        lastTaskId: j.lastTaskId,
        runs: j.runs,
        interval: j.interval,
        anchor: j.anchor,
        after: j.after,
        history: j.history || [],
        note: j.note,
      }));
      json(res, 200, { ok: true, jobs });
      return;
    }
    if (req.method === 'POST' && p === '/api/schedule') {
      const body = await readBody(req);
      const action = String(body.action || '');
      try {
        if (action === 'add') {
          if (!body.question || !String(body.question).trim()) return json(res, 400, { error: '任务内容不能为空' });
          const r = addSchedule(home, String(body.question).trim(), {
            at: body.at || null,
            every: body.every || null,
            anchor: body.anchor || null,
            after: Array.isArray(body.after) ? body.after.map(String) : body.after ? String(body.after).split(',').map((x) => x.trim()).filter(Boolean) : undefined,
            permission: body.permission || null,
            model: body.model || null,
            cwd: state.workingDir,
            offpeak: body.offpeak === true,
          });
          if (r.error) return json(res, 400, { error: r.error });
          return json(res, 200, { ok: true, id: r.id });
        }
        if (action === 'chain') {
          const qs = Array.isArray(body.questions) ? body.questions.map(String).filter((q) => q.trim()) : [];
          if (qs.length < 2) return json(res, 400, { error: '链式需要至少两个任务' });
          const r = chainSchedules(home, qs, { permission: body.permission || null, model: body.model || null });
          if (r.error) return json(res, 400, { error: r.error });
          return json(res, 200, { ok: true, ids: r.ids });
        }
        const id = String(body.id || '');
        if (!id) return json(res, 400, { error: '缺少 id' });
        if (action === 'remove') return json(res, 200, { ok: removeSchedule(home, id) });
        if (action === 'pause') return json(res, 200, { ok: pauseSchedule(home, id) });
        if (action === 'resume') return json(res, 200, { ok: resumeSchedule(home, id) });
        return json(res, 400, { error: '未知操作：add|chain|remove|pause|resume' });
      } catch (err) {
        return json(res, 500, { error: String(err?.message || err) });
      }
    }
    if (req.method === 'GET' && p === '/api/workspaces') {
      json(res, 200, { ok: true, workspaces: listWorkspaces(), current: currentWorkspace(state.workingDir)?.name || null, cwd: state.workingDir });
      return;
    }
    if (req.method === 'POST' && p === '/api/workspaces') {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      if (body.action === 'add') {
        if (!name) return json(res, 400, { error: '名称不能为空' });
        // 目录为空/不存在时自动新建（默认开，create:false 关闭）
        const target = path.resolve(body.dir || state.workingDir);
        if (body.create !== false) {
          try {
            fs.mkdirSync(target, { recursive: true });
          } catch (e) {
            return json(res, 400, { error: `无法创建目录：${target}（${e.message}）` });
          }
        }
        const r = addWorkspace(name, target);
        if (r.error) return json(res, 400, { error: r.error });
        return json(res, 200, { ok: true, name: r.name, dir: r.dir, created: body.create !== false });
      }
      if (body.action === 'rename') {
        const r = renameWorkspace(name, body.newName);
        if (r.error) return json(res, 400, { error: r.error });
        return json(res, 200, { ok: true, name: r.name });
      }
      if (body.action === 'set') {
        // 切换全局工作空间（新会话默认目录；可带 dir 修改目录）；目录缺失自动重建。
        // 携带 file 时同时把当前会话的工作空间切过去（P3-4：会话跟随显式切换）。
        if (body.dir) {
          const r = setWorkspaceDir(name, body.dir);
          if (r.error) return json(res, 400, { error: r.error });
        }
        const dir = workspacePath(name);
        if (!dir) return json(res, 400, { error: `工作空间 ${name} 不存在` });
        try {
          fs.mkdirSync(dir, { recursive: true });
        } catch (e) {
          return json(res, 400, { error: `无法创建目录：${dir}（${e.message}）` });
        }
        touchWorkspace(name);
        state.workingDir = dir;
        // 不再 process.chdir：运行中任务的 cwd 在创建时已固定，全局切换只影响新会话
        if (body.file) setSessionWorkspace(String(body.file), dir, name);
        return json(res, 200, { ok: true, name, dir, current: name });
      }
      if (body.action === 'remove') {
        if (!name) return json(res, 400, { error: '缺少名称' });
        return json(res, 200, { ok: removeWorkspace(name) });
      }
      return json(res, 400, { error: '未知操作：add|rename|set|remove' });
    }
    // 目录浏览器（「新建工作空间」选择电脑磁盘目录用）：本机运行时即用户电脑的目录树；
    // 只列子目录（不含隐藏目录），供前端逐级导航选择
    if (req.method === 'GET' && p === '/api/fs-browse') {
      let dir = String(url.searchParams.get('dir') || '').trim();
      if (!path.isAbsolute(dir)) return json(res, 400, { error: '需要绝对路径' });
      try {
        const st = fs.statSync(dir);
        if (!st.isDirectory()) return json(res, 400, { error: '不是目录' });
        const entries = fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
          .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
          .slice(0, 300);
        const parent = path.dirname(dir);
        json(res, 200, { ok: true, path: dir, parent: parent === dir ? null : parent, entries });
      } catch (err) {
        json(res, 400, { error: String(err?.message || err) });
      }
      return;
    }
    if (req.method === 'GET' && p === '/api/memory') {
      json(res, 200, { ok: true, content: loadMemory() });
      return;
    }
    if (req.method === 'POST' && p === '/api/memory') {
      const body = await readBody(req);
      if (body.action === 'dedupe') {
        const removed = dedupeMemory();
        return json(res, 200, { ok: true, removed });
      }
      if (body.content !== undefined) {
        writeMemory(body.content);
        return json(res, 200, { ok: true });
      }
      return json(res, 400, { error: '缺少 content 或 action=dedupe' });
    }
    if (req.method === 'GET' && p === '/api/cache-stats') {
      const entries = listCacheStats();
      json(res, 200, {
        ok: true,
        summary: summarizeCacheStats(entries),
        breakdown: costBreakdown(),
        guard: costGuardStatus(),
        recent: entries.slice(-10).reverse(),
      });
      return;
    }
    if (req.method === 'GET' && p === '/api/mcp-presets') {
      json(res, 200, { ok: true, presets: presetList() });
      return;
    }
    if (req.method === 'POST' && p === '/api/mcp-presets') {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      const r = buildPreset(name, body.arg, state.workingDir);
      if (r.error) return json(res, 400, { error: r.error });
      cfg.mcpServers = cfg.mcpServers || {};
      cfg.mcpServers[name] = r.config;
      saveConfig(cfg);
      json(res, 200, { ok: true, name, note: '重启 mingdao web 后生效（/mcp 查看状态）' });
      return;
    }
    if (req.method === 'GET' && p === '/api/skill-library') {
      const u = new URL(req.url, 'http://x');
      const q = u.searchParams.get('q') || '';
      const force = u.searchParams.get('refresh') === '1';
      const local = q
        ? libraryList().filter((s) => s.name.includes(q) || (s.description || '').includes(q))
        : libraryList();
      const { searchRegistry } = await import('../../skill-registry.js');
      const remote = await searchRegistry(q || '', { force, allowNetwork: force });
      const localNames = new Set(local.map((s) => s.name));
      const registryEntries = remote.skills
        ? remote.skills.filter((s) => !localNames.has(s.name)).map((s) => ({ ...s, dir: null }))
        : [];
      json(res, 200, {
        ok: true,
        library: local.map((s) => ({ name: s.name, description: s.description, source: 'builtin-lib', installed: s.installed })).concat(
          registryEntries.map((s) => ({ name: s.name, description: s.description, source: 'registry', installed: s.installed }))
        ),
        installed: [...installedUserSkillNames()],
        registry: remote.error ? { error: remote.error } : { host: remote.host, updatedAt: remote.updatedAt, stale: remote.stale || false },
      });
      return;
    }
    if (req.method === 'POST' && p === '/api/skills') {
      const body = await readBody(req);
      if (body.action === 'install') {
        const r = await installSkill(body.arg || body.name || '');
        if (r.error) return json(res, 400, { error: r.error });
        return json(res, 200, { ok: true, name: r.name, names: r.names });
      }
      if (body.action === 'uninstall') {
        const r = uninstallSkill(body.name);
        if (r.error) return json(res, 400, { error: r.error });
        return json(res, 200, { ok: true, name: r.name });
      }
      return json(res, 400, { error: '未知操作：install|uninstall' });
    }
    if (req.method === 'GET' && p === '/api/sync') {
      const st = syncStatus();
      let remote = null;
      if (st.loggedIn) {
        const r = await syncRemoteList();
        remote = r.ok ? { sessions: r.sessions.slice(0, 50) } : { error: r.error };
      }
      json(res, 200, { ok: true, ...st, remote });
      return;
    }
    if (req.method === 'POST' && p === '/api/sync') {
      const body = await readBody(req);
      if (body.action === 'login') {
        const vurl = validateRemoteUrl(body.url); // 质检 S1：SSRF 防护（同步端点同样只允许公网）
        if (vurl.error) return json(res, 400, { error: vurl.error });
        const r = await syncLogin({ url: body.url, username: body.username, password: body.password, deviceName: body.deviceName });
        if (r.error) return json(res, 400, { error: r.error });
        return json(res, 200, { ok: true, ...r });
      }
      if (body.action === 'logout') {
        syncLogout();
        return json(res, 200, { ok: true });
      }
      if (body.action === 'push') {
        const r = await syncPush(body.name);
        if (r.error) return json(res, 400, { error: r.error });
        return json(res, 200, { ok: true, pushed: r.pushed.length, conflicts: r.conflicts });
      }
      if (body.action === 'pull') {
        const r = await syncPull(body.name);
        if (r.error) return json(res, 400, { error: r.error });
        return json(res, 200, { ok: true, pulled: r.pulled.length, conflicts: r.conflicts });
      }
      if (body.action === 'passwd') {
        const r = await syncChangePassword({ oldPassword: body.oldPassword, newPassword: body.newPassword });
        if (r.error) return json(res, 400, { error: r.error });
        return json(res, 200, { ok: true });
      }
      if (body.action === 'share') {
        const r = await syncShareCreate(body.name);
        if (r.error) return json(res, 400, { error: r.error });
        return json(res, 200, { ok: true, shareId: r.shareId, name: r.name });
      }
      if (body.action === 'shares') {
        const r = await syncShareList();
        if (r.error) return json(res, 400, { error: r.error });
        return json(res, 200, { ok: true, mine: r.mine, accepted: r.accepted });
      }
      if (body.action === 'accept') {
        const r = await syncShareAccept(body.shareId);
        if (r.error) return json(res, 400, { error: r.error });
        return json(res, 200, { ok: true, ...r });
      }
      if (body.action === 'unshare') {
        const r = await syncShareRevoke(body.shareId);
        if (r.error) return json(res, 400, { error: r.error });
        return json(res, 200, { ok: true });
      }
      if (body.action === 'resolveConflict') {
        const r = resolveSyncConflict(body.base, body.choice);
        if (r.error) return json(res, 400, { error: r.error });
        return json(res, 200, { ok: true, ...r });
      }
      return json(res, 400, { error: '未知操作：login|logout|push|pull|passwd|share|shares|accept|unshare|resolveConflict' });
    }
    if (req.method === 'GET' && p === '/api/sync-conflicts') {
      json(res, 200, { ok: true, conflicts: listSyncConflicts() });
      return;
    }
    // PWA 资源
    if (req.method === 'GET' && p === '/manifest.webmanifest') {
      res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8' });
      res.end(
        JSON.stringify({
          name: 'MingDao Harness',
          short_name: 'MingDao',
          description: 'MingDao-Harness 智能体框架 WebUI',
          start_url: '/',
          display: 'standalone',
          background_color: '#0f1115',
          theme_color: '#0f1115',
          icons: [
            { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
          ],
        })
      );
      return;
    }
    if (req.method === 'GET' && p === '/icon.svg') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' });
      res.end(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0f1115"/><path d="M18 20h6v24h-6zM29 20h6v24h-6zM40 20h6v24h-6z" fill="#3ddc97"/><circle cx="43" cy="18" r="5" fill="#22b8cf"/></svg>`
      );
      return;
    }
    if (req.method === 'GET' && p === '/sw.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      // 缓存键去掉 query（?token= 不落缓存）；mingdao-v4：随 token 认证版本升版本号，强制替换旧 SW 缓存
      res.end(`self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!=='mingdao-v4').map(k=>caches.delete(k)))).then(()=>clients.claim())));self.addEventListener('fetch',e=>{if(e.request.method==='GET'&&new URL(e.request.url).origin===location.origin&&!e.request.url.includes('/api/')){const u=new URL(e.request.url);u.search='';e.respondWith(fetch(e.request).then(r=>{const c=r.clone();caches.open('mingdao-v4').then(cache=>cache.put(u.toString(),c));return r;}).catch(()=>caches.match(u.toString()).then(m=>m||caches.match('/'))));}});`);
      return;
    }
    json(res, 404, { error: 'Not found' });
  };

  // 全局异常兜底：readBody 超限（413）等错误不再让连接挂起

  return dispatch;
}
