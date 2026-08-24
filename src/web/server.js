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
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ensureHome, loadConfig, saveConfig, mingdaoHome } from '../config.js';
import { setStoredKey, removeStoredKey, getStoredKey, maskKey } from '../credentials.js';
import { availableModels, fetchProviderModels, providerHasKey } from '../model-discovery.js';
import { createProvider, resolveProviderConfig, helperProvider } from '../providers/index.js';
import { MODELS, modelPreset, PROVIDERS } from '../models.js';
import { routeTask, routingConfig } from '../routing.js';
import { buildUserContent } from './attachments.js';
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
  rewriteSession,
  sessionPreview,
  relativeTime,
  searchSessions,
} from '../session.js';
import { listSkills, tamperedSkillNames } from '../skills.js';
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
import { currentWorkspace, workspaceForDir, listWorkspaces, addWorkspace, removeWorkspace, renameWorkspace, setWorkspaceDir, workspacePath, touchWorkspace, getSessionWorkspace, setSessionWorkspace, removeSessionWorkspace, moveSessionWorkspace } from '../workspace.js';
import { loadMemory, writeMemory, dedupeMemory } from '../memory.js';
import { recordUsage, listCacheStats, summarizeCacheStats, costBreakdown } from '../cachestats.js';
import { PRICE_DATA_AS_OF } from '../pricing.js';
import { costGuardStatus } from '../cost-guard.js';
import { presetList, buildPreset } from '../mcp-presets.js';
import { syncStatus, syncLogin, syncLogout, syncPush, syncPull, syncRemoteList, maybeAutoSync, syncChangePassword, syncShareCreate, syncShareList, syncShareAccept, syncShareRevoke, listSyncConflicts, resolveSyncConflict } from '../sync.js';

const INDEX_HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html');

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  const MAX_BODY = 40 * 1024 * 1024; // 附件 base64 上限（4×5MB 图片 + 文本）留余量
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    // 审计 P2-6：慢速连接防护——60s 未传完请求体即断开，防占满 socket
    const slowTimer = setTimeout(() => {
      const err = /** @type {Error & { status?: number }} */ (new Error('请求体上传超时（60s）'));
      err.status = 408;
      req.destroy();
      reject(err);
    }, 60000);
    req.on('end', () => clearTimeout(slowTimer));
    req.on('close', () => clearTimeout(slowTimer));
    req.on('data', (d) => {
      size += d.length;
      if (size > MAX_BODY) {
        const err = /** @type {Error & { status?: number }} */ (new Error('请求体过大（>40MB）'));
        err.status = 413;
        req.destroy();
        reject(err);
        return;
      }
      chunks.push(d);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

/** @param {{ host?: string, port?: number, authToken?: string|null, [key: string]: any }} [opts] */
export async function runWebServer({ host = '127.0.0.1', port = 3820, authToken } = {}) {
  const home = ensureHome();
  const cfg = loadConfig();
  if (!cfg) {
    console.error('[MingDao] 未初始化配置：请先运行 mingdao init');
    process.exitCode = 1;
    return;
  }
  // 访问令牌（P1-3）：非回环绑定时强制——配置的 token / 启动参数 / 环境变量优先，
  // 都没有则本次随机生成并打印带 token 的访问地址。回环绑定且未配置时保持无认证（本机信任）。
  const isLoopbackHost = (h) => h === '127.0.0.1' || h === 'localhost' || h === '::1';
  let webToken = String(authToken || cfg?.web?.token || '').trim() || null;
  let tokenGenerated = false;
  if (!isLoopbackHost(host) && !webToken) {
    webToken = crypto.randomBytes(16).toString('hex');
    tokenGenerated = true;
  }
  const authEnabled = Boolean(webToken);
  const tokenMatches = (got) => {
    if (!webToken) return true;
    if (!got) return false;
    const a = Buffer.from(String(got));
    const b = Buffer.from(webToken);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const requestToken = (req, url) => {
    const q = url.searchParams.get('token');
    if (q) return q;
    const h = String(req.headers['x-mingdao-token'] || '');
    if (h) return h;
    const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    return m ? m[1] : null;
  };
  // Host 白名单（P1-4，防 DNS rebinding）：只接受回环名 + 绑定地址；
  // 绑定 0.0.0.0 且启用 token 时放行任意 Host（此时 token 才是访问边界，攻击者页面拿不到）。
  let boundPort = port;
  const trustedHost = (reqHost) => {
    const h = String(reqHost || '').toLowerCase();
    const names = new Set(['127.0.0.1', 'localhost', '::1']);
    if (host !== '0.0.0.0') names.add(host.toLowerCase());
    const candidates = new Set();
    for (const n of names) {
      candidates.add(`${n.includes(':') && !n.startsWith('[') ? `[${n}]` : n}:${boundPort}`);
      if (boundPort === 80) candidates.add(n);
    }
    if (candidates.has(h)) return true;
    return host === '0.0.0.0' && authEnabled;
  };
  let modelName = cfg.model || 'deepseek-v4-flash';
  const pc = resolveProviderConfig(cfg, modelName);
  if (!pc.apiKey) {
    // 首次运行/未配置密钥：界面照常启动（黑屏根因修复——此前这里直接 return，桌面版窗口
    // 加载不到任何服务 → 整窗黑屏且无提示）。⚙ 设置里填入 Key 后即可对话。
    console.error(`[MingDao] ⚠ 未配置 ${modelName} 的 API Key：界面可正常使用，对话前请在 ⚙ 设置 →「模型与 API Key」填入密钥。`);
  }

  let workingDir = process.cwd(); // 工作空间切换时随之更新（后续会话/工具都跟随新目录）
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
    const taskId = `t${++taskSeq}`; // 服务端生成：客户端自选 taskId 可能覆盖他人任务
    const entry = { res, send: null, abortHandler: null, pendingAsk: null, session: null, startedAt: Date.now(), status: 'running', message: '', durationMs: 0 };
    tasks.set(taskId, entry);
    const send = (obj) => {
      try {
        res.write(`data: ${JSON.stringify({ ...obj, taskId })}\n\n`);
      } catch {}
    };
    entry.send = send;
    const userMessage = String(body.message ?? '').trim();
    entry.message = (userMessage || '[附件]').slice(0, 40);
    const visionSupported = Boolean(modelPreset(modelName)?.supportsVision || cfg.customModels?.[modelName]?.vision);
    const built = buildUserContent(userMessage, body.attachments, visionSupported);
    if (built.error) {
      entry.status = 'failed';
      send({ type: 'error', message: built.error });
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

    // 自动路由（与 CLI 一致）：规划/生成类任务 → planner（大输出），执行类 → executor；
    // 会话粘滞 + 分类缓存（评估 P2-1），路由结果挂在会话对象上（进程内，不落盘）
    let runModel = modelName;
    let routeReason = null;
    if (routingConfig(cfg)) {
      try {
        const route = await routeTask({ cfg, provider, currentModel: modelName, text: built.persistText || userMessage, sticky: session.lastRoute || null });
        session.lastRoute = route.model;
        if (route.model !== modelName) {
          runModel = route.model;
          routeReason = route.reason;
        }
      } catch {}
    }
    if (routeReason) send({ type: 'banner', text: `⤷ 自动路由 → ${runModel}（${routeReason}）` });

    // 会话级工作空间（P3-4）：已记录工作空间的会话固定用自己目录——运行中的任务不受全局切换影响；
    // 新会话/首次继续的旧会话记录当前全局工作空间。全局 workingDir 只决定新会话的默认目录。
    const sessionName = path.basename(session.file);
    const sessionWsDir = getSessionWorkspace(sessionName);
    const taskDir = sessionWsDir || workingDir;
    if (!sessionWsDir) {
      setSessionWorkspace(sessionName, taskDir, currentWorkspace(workingDir)?.name || null);
    }
    const systemPrompt = buildSystemPrompt({ workingDir: taskDir, withJournal: body.withJournal === true });
    let messages =
      session.messages?.length && session.messages[0]?.role === 'system'
        ? session.messages
        : [{ role: 'system', content: systemPrompt }, ...(session.messages || [])];
    messages[0] = { role: 'system', content: systemPrompt }; // 总是刷新 system（记忆/技能/AGENTS.md 最新）
    messages.push({ role: 'user', content: built.content });
    // 落盘用文本版（图文数组只发给模型，会话文件保持字符串可渲染）
    appendMessages(session.file, [{ role: 'user', content: built.persistText }]);
    let persistedBefore = messages.length;

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
    let providerNow;
    try {
      // 首次使用引导：未配置密钥时给明确指引，而不是晦涩的 401 原始报错
      if (!(resolveProviderConfig(cfg, runModel) || {}).apiKey) {
        throw new Error(`模型 ${runModel} 尚未配置 API Key：请点击右上角 ⚙ 设置 →「模型与 API Key」填入密钥。`);
      }
      providerNow = await getProviderFor(runModel); // 审计 P1-1：失败时清理任务占位，避免僵尸 running 耗尽并发
    } catch (err) {
      entry.status = 'failed';
      entry.durationMs = Date.now() - entry.startedAt;
      send({ type: 'error', message: `模型 ${runModel} 不可用：${String(err?.message || err)}` });
      res.end();
      pruneTasks();
      return;
    }
    const agent = createAgent({
      provider: providerNow,
      permission,
      io,
      modelName: runModel,
      workingDir: taskDir,
      cfg,
      undoStore,
      mcp: mcpFacade,
      // 自动压缩后重写会话文件（否则每次加载历史都会重新触发压缩），并同步落盘游标
      onCompact: (msgs) => {
        rewriteSession(session.file, msgs);
        persistedBefore = msgs.length;
      },
      // 审计记录归入当前会话（P3-5）
      sessionRef: { name: path.basename(session.file) },
    });

    res.on('close', () => {
      // 浏览器断开：中止正在跑的生成（否则白白烧 token），挂起的权限确认按拒绝处理
      if (entry.pendingAsk) {
        entry.pendingAsk.resolve('');
        entry.pendingAsk = null;
      }
      if (entry.status === 'running') {
        try {
          entry.abortHandler?.();
        } catch {}
        entry.status = 'failed';
        entry.durationMs = Date.now() - entry.startedAt;
        pruneTasks();
      }
    });

    try {
      const r = await agent.runTurn(messages);
      appendMessages(session.file, messages.slice(persistedBefore));
      io.printUsageLine({ modelName: runModel, usage: r.usage, durationMs: r.durationMs });
      recordUsage(runModel, r.usage, r.perf);
      maybeAutoSync().catch(() => {});
      // 新会话自动标题（可配置关闭）
      if (isNew && cfg.autoTitle !== false && r.text) {
        try {
          const tModel = titleModel(cfg, runModel);
          const title = await generateTitle(await helperProvider(cfg, tModel, providerNow), tModel, built.persistText);
          if (title) {
            const oldName = path.basename(session.file);
            const renamed = renameSessionFile(fs, path, home, session, title);
            if (renamed) moveSessionWorkspace(oldName, path.basename(renamed)); // 会话改名 → 工作空间映射跟随
          }
        } catch {}
      }
      entry.status = r.aborted ? 'aborted' : 'done';
      entry.durationMs = Date.now() - entry.startedAt;
      // 预算可视化（评估 A5）：会话当前 token 占用 / 预算
      let budgetInfo = null;
      try {
        const { makeTokenCounter } = await import('../tokenizer.js');
        const { messageTokens } = await import('../context.js');
        const counter = makeTokenCounter(runModel);
        const used = messages.reduce((sum, m) => sum + messageTokens(m, counter), 0);
        budgetInfo = { used, total: cfg.contextBudget || modelPreset(runModel)?.budgetTokens || 128000 };
      } catch {}
      send({
        type: 'done',
        budget: budgetInfo,
        ok: true,
        text: r.text,
        usage: r.usage,
        durationMs: r.durationMs,
        truncated: r.truncated,
        aborted: r.aborted,
        note: r.note || (r.text ? '' : '（模型本轮没有输出正文）'),
        stats: io.stats(),
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

  const dispatch = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    // 访问控制（P1-3/P1-4）：token 校验覆盖数据与操作接口；壳页面与 PWA 静态资源公开
    // （壳不含任何数据，SPA 需要先加载才能读取 ?token=）；Host 白名单覆盖一切请求
    const isStaticAsset =
      p === '/' || p === '/index.html' || p === '/favicon.ico' || p === '/icon.svg' || p === '/icon-192.png' || p === '/icon-512.png' || p === '/manifest.webmanifest' || p === '/sw.js';
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
      const models = await availableModels(cfg, modelName);
      json(res, 200, {
        ok: true,
        model: modelName,
        models,
        // 首次使用引导：当前模型无可用 API Key 时前端显示「去 ⚙ 设置填 Key」横幅
        keyReady: Boolean((resolveProviderConfig(cfg, modelName) || {}).apiKey),
        permissions: ['ask', 'auto', 'readonly'],
        permission: cfg.permission ?? 'ask',
        sandbox: cfg.sandbox || 'off',
        sandboxSupported: detectSandbox() !== 'none',
        routing: cfg.routing?.enabled ? cfg.routing : null,
        contextBudget: cfg.contextBudget || 128000,
        pricingAsOf: PRICE_DATA_AS_OF,
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
      // 内存 cfg 可能比磁盘旧（如 CLI 改过同步地址）：先从磁盘刷新 sync，避免保存时回滚
      cfg.sync = loadConfig()?.sync || cfg.sync;
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
          vision: Boolean(cm.vision),
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
        // 载入会话时聚焦其工作空间（P3-4）：全局默认切到该会话的目录，前端下拉同步显示
        const wsDir = getSessionWorkspace(path.basename(file));
        const ws = workspaceForDir(wsDir);
        if (wsDir && path.resolve(wsDir) !== path.resolve(workingDir)) {
          workingDir = wsDir; // 审计 P2-5：仅在目录不同时才切换，减少全局状态抖动
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
      json(res, 200, { ok: true, skills: listSkills(workingDir), tampered: tamperedSkillNames(workingDir) });
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
      // 审计 P2-4：先占位再计数（单线程下 set 后统计即真实并发），消除检查-注册间隙
      const tmpId = 'resv' + (++taskSeq) + Math.random().toString(36).slice(2, 5);
      tasks.set(tmpId, { status: 'running' });
      const running = [...tasks.values()].filter((t) => t.status === 'running').length;
      tasks.delete(tmpId);
      if (running > MAX_CONCURRENT) {
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
        res.write(`data: ${JSON.stringify({ type: 'error', message: e.message })}\n\n`);
        res.end();
        return;
      }
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
      json(res, 200, { ok: true, workspaces: listWorkspaces(), current: currentWorkspace(workingDir)?.name || null, cwd: workingDir });
      return;
    }
    if (req.method === 'POST' && p === '/api/workspaces') {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      if (body.action === 'add') {
        if (!name) return json(res, 400, { error: '名称不能为空' });
        // 目录为空/不存在时自动新建（默认开，create:false 关闭）
        const target = path.resolve(body.dir || workingDir);
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
        workingDir = dir;
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
  const server = http.createServer((req, res) => {
    dispatch(req, res).catch((e) => {
      if (!res.headersSent) {
        json(res, e?.status || 500, { error: e?.message || '服务器内部错误' });
      } else {
        try {
          res.end();
        } catch {}
      }
    });
  });

  server.on('error', (/** @type {Error & { code?: string }} */ err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[MingDao] 端口 ${port} 已被占用，请换一个端口：mingdao web <端口号>`);
    } else {
      console.error('[MingDao] 服务器错误：' + err.message);
    }
    process.exitCode = 1;
  });

  server.listen(port, host, () => {
    const actual = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
    boundPort = actual;
    const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
    console.log('');
    console.log(`  MingDao WebUI 已启动`);
    console.log(`  地址: http://${displayHost}:${actual}`);
    if (authEnabled) {
      console.log(`  访问令牌: http://${displayHost}:${actual}/?token=${webToken}`);
      if (tokenGenerated) {
        console.log('  ⚠ 非回环绑定且未配置令牌：本次已随机生成（重启后更换）。');
        console.log('    固定令牌：mingdao web --auth-token <令牌>，或 config.json 的 web.token / 环境变量 MINGDAO_WEB_TOKEN。');
      } else if (isLoopbackHost(host)) {
        console.log('  ℹ 已启用访问令牌：地址需带 ?token=… 才能访问。');
      }
    } else if (!isLoopbackHost(host)) {
      console.warn('  ⚠ 警告：当前监听 ' + host + '（非本机回环）且未启用令牌，任何能到达端口的人都可访问。建议：mingdao web --auth-token <令牌>。');
    }
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
