// MingDao WebUI 服务器：零依赖 node:http + SSE。
// 复用 Agent 核心：createAgent + createPermission + createWebIO（io 适配层）。
// 路由：
//   GET  /                 前端单页（src/web/index.html）
//   GET  /api/state        模型/权限/会话列表
//   GET  /api/sessions     会话列表（含预览与相对时间）
//   GET  /api/session?file= 载入会话消息
//   GET  /api/skills       技能列表
//   POST /api/chat         {message, file?} → 运行一轮，SSE 事件流
//   POST /api/permission   {id, answer} → 应答权限确认
//   POST /api/abort        中断当前生成
// SSE 事件：banner/text/reasoning/code/tool/toolDenied/todo/usage/ask/error/done

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureHome, loadConfig, saveConfig, mingdaoHome } from '../config.js';
import { setStoredKey, removeStoredKey, getStoredKey, maskKey } from '../credentials.js';
import { createProvider, resolveProviderConfig } from '../providers/index.js';
import { MODELS, modelPreset, PROVIDERS } from '../models.js';
import { createAgent } from '../agent.js';
import { createPermission } from '../permissions.js';
import { buildSystemPrompt } from '../prompts.js';
import { createWebIO } from './web-io.js';
import { startMcpServers } from '../mcp.js';
import {
  createSession,
  listSessions,
  loadSession,
  appendMessages,
  sessionPreview,
  relativeTime,
  searchSessions,
} from '../session.js';
import { listSkills } from '../skills.js';
import { libraryList, installSkill, uninstallSkill, installedUserSkillNames } from '../skill-lib.js';
import { detectSandbox } from '../tools/bash.js';
import { generateTitle, renameSessionFile, titleModel, sanitizeTitle } from '../titles.js';
import {
  addSchedule,
  listSchedules,
  removeSchedule,
  pauseSchedule,
  resumeSchedule,
  chainSchedules,
  reconcileSchedules,
} from '../schedule.js';
import { enableAutostart, disableAutostart, autostartStatus } from '../autostart.js';
import { currentWorkspace, listWorkspaces, addWorkspace, removeWorkspace, renameWorkspace, setWorkspaceDir } from '../workspace.js';
import { loadMemory, writeMemory, dedupeMemory } from '../memory.js';
import { recordUsage, listCacheStats, summarizeCacheStats } from '../cachestats.js';
import { presetList, buildPreset } from '../mcp-presets.js';
import { syncStatus, syncLogin, syncLogout, syncPush, syncPull, syncRemoteList, maybeAutoSync } from '../sync.js';

const INDEX_HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html');

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

export async function runWebServer({ host = '127.0.0.1', port = 3820 } = {}) {
  const home = ensureHome();
  const cfg = loadConfig();
  if (!cfg) {
    console.error('[MingDao] 未初始化配置：请先运行 mingdao init');
    process.exitCode = 1;
    return;
  }
  let modelName = cfg.model || 'deepseek-v4-flash';
  const pc = resolveProviderConfig(cfg, modelName);
  if (!pc.apiKey) {
    console.error(`[MingDao] 未找到 API Key：请运行 mingdao key set ${pc.name} 或 mingdao init`);
    process.exitCode = 1;
    return;
  }

  const workingDir = process.cwd();
  // Provider 按模型懒加载缓存：界面切换模型后即时生效
  const providerCache = new Map();
  async function getProviderFor(m) {
    if (!providerCache.has(m)) {
      providerCache.set(m, await createProvider(cfg, m));
    }
    return providerCache.get(m);
  }
  const provider = await getProviderFor(modelName);
  const undoStore = { backups: new Map() };

  // MCP：后台启动，就绪后工具并入后续轮次
  let mcpManager = null;
  if (cfg.mcpServers && Object.keys(cfg.mcpServers).length) {
    startMcpServers(cfg.mcpServers, workingDir)
      .then((m) => {
        mcpManager = m;
      })
      .catch(() => {});
  }
  const mcpFacade = {
    toolSchemas: () => (mcpManager ? mcpManager.toolSchemas() : []),
    call: (n, a) => (mcpManager ? mcpManager.call(n, a) : Promise.reject(new Error('MCP 未就绪'))),
    isReadonly: (n) => (mcpManager ? mcpManager.isReadonly(n) : false),
    status: () => (mcpManager ? mcpManager.status() : []),
    stop: () => {
      if (mcpManager) mcpManager.stop();
    },
  };

  // 任务注册表：支持多会话并行——每个任务独立的 SSE 流、权限确认、中断控制
  const MAX_CONCURRENT = 8;
  const tasks = new Map(); // taskId -> { res, send, abortHandler, pendingAsk, session, startedAt, status, message, durationMs }
  let taskSeq = 0;
  let draftText = ''; // 外部注入的草稿（VS Code 插件选中代码发送）

  function pruneTasks() {
    if (tasks.size <= 100) return;
    for (const [id, t] of tasks) {
      if (t.status !== 'running') tasks.delete(id);
      if (tasks.size <= 60) break;
    }
  }

  async function handleChat(res, body) {
    const taskId = body.taskId || `t${++taskSeq}`;
    const entry = { res, send: null, abortHandler: null, pendingAsk: null, session: null, startedAt: Date.now(), status: 'running', message: '', durationMs: 0 };
    tasks.set(taskId, entry);
    const send = (obj) => {
      try {
        res.write(`data: ${JSON.stringify({ ...obj, taskId })}\n\n`);
      } catch {}
    };
    entry.send = send;
    const userMessage = String(body.message ?? '').trim();
    entry.message = userMessage.slice(0, 40);
    if (!userMessage) {
      entry.status = 'failed';
      send({ type: 'error', message: '消息不能为空' });
      res.end();
      return;
    }

    let session = null;
    const isNew = !body.file;
    if (body.file) {
      try {
        const loaded = loadSession(path.join(home, 'sessions', path.basename(body.file)));
        if (loaded.messages.length) session = loaded;
      } catch {}
    }
    if (!session) session = createSession(home);
    entry.session = session;

    const systemPrompt = buildSystemPrompt({ modelName, workingDir });
    let messages =
      session.messages?.length && session.messages[0]?.role === 'system'
        ? session.messages
        : [{ role: 'system', content: systemPrompt }, ...(session.messages || [])];
    messages[0] = { role: 'system', content: systemPrompt }; // 总是刷新 system（记忆/技能/AGENTS.md 最新）
    messages.push({ role: 'user', content: userMessage });
    appendMessages(session.file, [messages[messages.length - 1]]);
    const persistedBefore = messages.length;

    // 权限/选择类交互：发 ask 事件（带 taskId），等待 POST /api/permission 应答
    const askHandler = ({ question, hidden, options, label, confirm }) =>
      new Promise((resolve) => {
        const id = Math.random().toString(36).slice(2);
        entry.pendingAsk = { id, resolve };
        send({
          type: 'ask',
          id,
          question: question ?? label ?? '',
          options: options ? options.map((o) => ({ value: o.value, label: o.label })) : null,
          confirm: Boolean(confirm ?? !options),
          hidden: Boolean(hidden),
        });
      });

    const io = createWebIO({
      send,
      askHandler,
      setAbortHandler: (fn) => {
        entry.abortHandler = fn;
      },
    });
    const permission = createPermission(cfg.permission ?? 'ask', io);
    const providerNow = await getProviderFor(modelName);
    const agent = createAgent({
      provider: providerNow,
      permission,
      io,
      modelName,
      workingDir,
      cfg,
      undoStore,
      mcp: mcpFacade,
    });

    res.on('close', () => {
      // 浏览器断开：挂起的权限确认按拒绝处理
      if (entry.pendingAsk) {
        entry.pendingAsk.resolve('');
        entry.pendingAsk = null;
      }
      if (entry.status === 'running') {
        entry.status = 'failed';
        entry.durationMs = Date.now() - entry.startedAt;
        pruneTasks();
      }
    });

    try {
      const r = await agent.runTurn(messages);
      appendMessages(session.file, messages.slice(persistedBefore));
      io.printUsageLine({ modelName, usage: r.usage, durationMs: r.durationMs });
      recordUsage(modelName, r.usage);
      maybeAutoSync().catch(() => {});
      // 新会话自动标题（可配置关闭）
      if (isNew && cfg.autoTitle !== false && r.text) {
        try {
          const title = await generateTitle(providerNow, titleModel(cfg, modelName), userMessage);
          if (title) renameSessionFile(fs, path, home, session, title);
        } catch {}
      }
      entry.status = r.aborted ? 'aborted' : 'done';
      entry.durationMs = Date.now() - entry.startedAt;
      send({
        type: 'done',
        ok: true,
        text: r.text,
        usage: r.usage,
        durationMs: r.durationMs,
        truncated: r.truncated,
        aborted: r.aborted,
        session: path.basename(session.file),
      });
    } catch (err) {
      entry.status = 'failed';
      entry.durationMs = Date.now() - entry.startedAt;
      send({ type: 'error', message: String(err?.message || err) });
    } finally {
      entry.abortHandler = null;
      entry.pendingAsk = null;
      entry.send = null;
      res.end();
      pruneTasks();
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

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
    if (req.method === 'GET' && p === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'GET' && p === '/api/state') {
      const sessions = listSessions(home)
        .slice(0, 30)
        .map((s) => ({ file: s.name, mtime: s.mtime, label: `${relativeTime(s.mtime)} · ${sessionPreview(s.file)}` }));
      const models = Object.keys(MODELS).map((name) => ({
        name,
        label: `${name} — ${MODELS[name].label || ''}`,
        provider: MODELS[name].provider || 'custom',
        providerLabel: PROVIDERS[MODELS[name].provider]?.label || '自定义',
      }));
      for (const [cmName, cm] of Object.entries(cfg.customModels || {})) {
        models.push({
          name: cmName,
          label: `${cmName} — ${cm.label || '自定义模型'}`,
          provider: 'custom',
          providerLabel: '自定义',
          custom: true,
        });
      }
      if (!models.some((m) => m.name === modelName)) {
        models.unshift({ name: modelName, label: `${modelName}（当前配置）`, provider: 'custom', providerLabel: '自定义' });
      }
      json(res, 200, {
        ok: true,
        model: modelName,
        models,
        permissions: ['ask', 'auto', 'readonly'],
        permission: cfg.permission ?? 'ask',
        sandbox: cfg.sandbox || 'off',
        sandboxSupported: detectSandbox() !== 'none',
        routing: cfg.routing?.enabled ? cfg.routing : null,
        contextBudget: cfg.contextBudget || 128000,
        autostart: autostartStatus(),
        notify: cfg.notify !== false,
        workspace: currentWorkspace(workingDir)?.name || null,
        home,
        workingDir,
        mcp: mcpFacade.status(),
        sessions,
      });
      return;
    }
    if (req.method === 'POST' && p === '/api/config') {
      const body = await readBody(req);
      const next = { model: modelName, permission: cfg.permission ?? 'ask' };
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
      modelName = next.model;
      cfg.model = next.model;
      cfg.permission = next.permission;
      saveConfig(cfg);
      json(res, 200, { ok: true, model: modelName, permission: cfg.permission, sandbox: cfg.sandbox, routing: cfg.routing?.enabled, contextBudget: cfg.contextBudget, autostart: autostartChanged ? autostartStatus() : undefined, notify: cfg.notify !== false });
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
          keyState: stored ? 'stored' : 'none',
          keyMasked: stored ? maskKey(stored) : null,
        };
      });
      json(res, 200, {
        ok: true,
        providers,
        customModels,
        model: modelName,
        provider: resolveProviderConfig(cfg, modelName).name,
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
        return json(res, 200, { ok: true, provider, keyMasked: maskKey(key) });
      }
      if (action === 'removeProviderKey') {
        const provider = String(body.provider || '').trim();
        if (!PROVIDERS[provider]) return json(res, 400, { error: `未知服务商 ${provider}` });
        removeStoredKey(provider);
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
        try {
          const u = new URL(baseUrl);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
        } catch {
          return json(res, 400, { error: 'API 地址必须是合法的 http(s) URL' });
        }
        if (action === 'addCustom' && (cfg.customModels || {})[name]) {
          return json(res, 400, { error: `自定义模型 ${name} 已存在（可修改）` });
        }
        cfg.customModels = cfg.customModels || {};
        cfg.customModels[name] = { label, baseUrl, envKey: String(body.envKey || '').trim() || undefined };
        if (String(body.key || '').trim()) setStoredKey(`custom:${name}`, String(body.key).trim());
        saveConfig(cfg);
        return json(res, 200, { ok: true, name });
      }
      if (action === 'removeCustom') {
        const name = String(body.name || '').trim();
        if (!(cfg.customModels || {})[name]) return json(res, 400, { error: `自定义模型 ${name} 不存在` });
        delete cfg.customModels[name];
        removeStoredKey(`custom:${name}`);
        if (modelName === name) {
          modelName = 'deepseek-v4-flash';
          cfg.model = modelName;
        }
        saveConfig(cfg);
        return json(res, 200, { ok: true, name, model: modelName });
      }
      if (action === 'setCustomKey') {
        const name = String(body.name || '').trim();
        if (!(cfg.customModels || {})[name]) return json(res, 400, { error: `自定义模型 ${name} 不存在` });
        const key = String(body.key || '').trim();
        if (!key) return json(res, 400, { error: 'Key 不能为空' });
        setStoredKey(`custom:${name}`, key);
        return json(res, 200, { ok: true, name, keyMasked: maskKey(key) });
      }
      // —— 当前服务商 API 地址覆盖 ——
      if (action === 'setBaseUrl') {
        const baseUrl = String(body.baseUrl || '').trim();
        if (baseUrl) {
          try {
            const u = new URL(baseUrl);
            if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
          } catch {
            return json(res, 400, { error: 'API 地址必须是合法的 http(s) URL' });
          }
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
        json(res, 200, {
          ok: true,
          messages: loaded.messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ role: m.role, content: m.content ?? '' })),
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
        return json(res, 200, { ok: true, file: path.basename(renamed) });
      }
      if (body.action === 'delete') {
        try {
          fs.unlinkSync(full);
          return json(res, 200, { ok: true });
        } catch (err) {
          return json(res, 500, { error: String(err?.message || err) });
        }
      }
      return json(res, 400, { error: '未知操作：rename|delete' });
    }
    if (req.method === 'GET' && p === '/api/skills') {
      json(res, 200, { ok: true, skills: listSkills(workingDir) });
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
      const running = [...tasks.values()].filter((t) => t.status === 'running').length;
      if (running >= MAX_CONCURRENT) {
        return json(res, 429, { error: `并发任务已达上限（${MAX_CONCURRENT}），请等待任务完成或中断` });
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const body = await readBody(req);
      await handleChat(res, body);
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
      const text = draftText;
      draftText = ''; // 读取即清除
      json(res, 200, { ok: true, text });
      return;
    }
    if (req.method === 'POST' && p === '/api/draft') {
      const body = await readBody(req);
      draftText = String(body.text ?? '').slice(0, 200000);
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
            cwd: workingDir,
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
      json(res, 200, { ok: true, workspaces: listWorkspaces(), current: currentWorkspace(workingDir)?.name || null });
      return;
    }
    if (req.method === 'POST' && p === '/api/workspaces') {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      if (body.action === 'add') {
        if (!name) return json(res, 400, { error: '名称不能为空' });
        const r = addWorkspace(name, body.dir || workingDir);
        if (r.error) return json(res, 400, { error: r.error });
        return json(res, 200, { ok: true, name: r.name, dir: r.dir });
      }
      if (body.action === 'rename') {
        const r = renameWorkspace(name, body.newName);
        if (r.error) return json(res, 400, { error: r.error });
        return json(res, 200, { ok: true, name: r.name });
      }
      if (body.action === 'set') {
        const r = setWorkspaceDir(name, body.dir || workingDir);
        if (r.error) return json(res, 400, { error: r.error });
        return json(res, 200, { ok: true, name: r.name, dir: r.dir });
      }
      if (body.action === 'remove') {
        if (!name) return json(res, 400, { error: '缺少名称' });
        return json(res, 200, { ok: removeWorkspace(name) });
      }
      return json(res, 400, { error: '未知操作：add|rename|set|remove' });
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
      json(res, 200, { ok: true, summary: summarizeCacheStats(entries), recent: entries.slice(-10).reverse() });
      return;
    }
    if (req.method === 'GET' && p === '/api/mcp-presets') {
      json(res, 200, { ok: true, presets: presetList() });
      return;
    }
    if (req.method === 'POST' && p === '/api/mcp-presets') {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      const r = buildPreset(name, body.arg, workingDir);
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
      const { searchRegistry } = await import('../skill-registry.js');
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
      return json(res, 400, { error: '未知操作：login|logout|push|pull' });
    }
    // PWA 资源
    if (req.method === 'GET' && p === '/manifest.webmanifest') {
      res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8' });
      res.end(
        JSON.stringify({
          name: 'MingDao 明道',
          short_name: 'MingDao',
          description: 'MingDao-Harness 智能体框架 WebUI',
          start_url: '/',
          display: 'standalone',
          background_color: '#0f1115',
          theme_color: '#0f1115',
          icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
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
      res.end(`self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(clients.claim()));self.addEventListener('fetch',e=>{if(e.request.method==='GET'&&new URL(e.request.url).origin===location.origin&&!e.request.url.includes('/api/')){e.respondWith(fetch(e.request).then(r=>{const c=r.clone();caches.open('mingdao-v1').then(cache=>cache.put(e.request,c));return r;}).catch(()=>caches.match(e.request).then(m=>m||caches.match('/'))));}});`);
      return;
    }
    json(res, 404, { error: 'Not found' });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[MingDao] 端口 ${port} 已被占用，请换一个端口：mingdao web <端口号>`);
    } else {
      console.error('[MingDao] 服务器错误：' + err.message);
    }
    process.exitCode = 1;
  });

  server.listen(port, host, () => {
    const actual = server.address().port;
    console.log('');
    console.log(`  MingDao WebUI 已启动`);
    console.log(`  地址: http://${host}:${actual}`);
    console.log(`  模型: ${modelName} · 权限: ${cfg.permission ?? 'ask'} · 工作目录: ${workingDir}`);
    if (cfg.mcpServers && Object.keys(cfg.mcpServers).length) console.log('  MCP:  后台连接中，/api/state 可查看状态');
    console.log(`  退出: Ctrl+C`);
    console.log('');
  });

  const shutdown = () => {
    mcpFacade.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}
