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
import { createApiDispatch } from './routes/api.js';
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
  let inflight = 0; // 质检 S2：在途聊天请求计数（与请求生命周期绑定，防 readBody 期间并发超限）
  const tasks = new Map(); // taskId -> { res, send, abortHandler, pendingAsk, session, startedAt, status, message, durationMs }
  let taskSeq = 0;
  // 会话文件互斥（质检 C1/M3）：同一 session 文件的 append 与 compact 整文件重写必须串行
  const sessionLocks = new Map();
  function withSessionLock(file, fn) {
    const prev = sessionLocks.get(file) || Promise.resolve();
    const next = prev.then(fn, fn);
    sessionLocks.set(file, next.then(() => sessionLocks.delete(file), () => sessionLocks.delete(file)));
    return next;
  }
  let draftText = ''; // 外部注入的草稿（VS Code 插件选中代码发送）

  // —— 服务端诊断日志（第二问无反应排查 + 长期运维）：<mingdao-home>/logs/web-server.log ——
  // 记录每次对话的关键阶段与耗时；2MB 滚动。桌面版与 WebUI 共用同一日志。
  function srvlog(msg) {
    try {
      const dir = path.join(mingdaoHome(), 'logs');
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, 'web-server.log');
      let prev = '';
      try {
        prev = fs.readFileSync(f, 'utf8');
      } catch {}
      if (prev.length > 2 * 1024 * 1024) prev = prev.slice(-1024 * 1024);
      fs.writeFileSync(f, prev + new Date().toISOString() + ' ' + msg + '\n');
    } catch {}
  }

  // —— SSRF 防护（质检 S1）：远端地址校验 ——
  function isPrivateHost(hostname) {
    const h = String(hostname || '').toLowerCase();
    if (!h) return true;
    if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '::ffff:127.0.0.1') return true;
    const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return false; // 域名：交给 DNS 解析（无法静态判定）
    const a = Number(m[1]);
    const b = Number(m[2]);
    return a === 10 || a === 127 || a === 0 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  function validateRemoteUrl(raw) {
    let u;
    try {
      u = new URL(String(raw));
    } catch {
      return { error: '地址必须是合法的 http(s) URL' };
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: '仅支持 http/https 地址' };
    // 威胁模型：本机回环绑定时（默认/桌面版），本机模型服务（如 Ollama）属可信场景，放行；
    // 对外监听（0.0.0.0）时拒绝私网目标——除非显式 allowPrivateEndpoints
    const serverBoundLocal = isLoopbackHost(host);
    if (!cfg.web?.allowPrivateEndpoints && !serverBoundLocal && isPrivateHost(u.hostname)) {
      return { error: `拒绝访问内网/本机地址（${u.hostname}）——服务已对外监听，如确需连接可信内网服务，请在 config.json 设 web.allowPrivateEndpoints: true` };
    }
    return { ok: true };
  }

  function pruneTasks() {
    // 质检 L3：完成条目 10 分钟后或总量超 60 时清理（任务面板展示最近完成历史），
    // 持留的 res/闭包随条目一并释放；运行中任务不受影响
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [id, t] of tasks) {
      if (t.status !== 'running' && t.startedAt && Date.now() - (t.durationMs || 0) - t.startedAt > 0) {
        // startedAt+durationMs 为完成时刻
        if (t.startedAt + (t.durationMs || 0) < cutoff) tasks.delete(id);
      }
    }
    if (tasks.size > 60) {
      for (const [id, t] of tasks) {
        if (t.status !== 'running') tasks.delete(id);
        if (tasks.size <= 30) break;
      }
    }
  }

  async function handleChat(res, body) {
    const taskId = `t${++taskSeq}`; // 服务端生成：客户端自选 taskId 可能覆盖他人任务
    const entry = { res, send: null, abortHandler: null, pendingAsk: null, session: null, startedAt: Date.now(), status: 'running', message: '', durationMs: 0 };
    srvlog('chat 开始 ' + taskId + ' session=' + (body.file || '新会话') + ' 消息长度=' + String(body.message || '').length);
    tasks.set(taskId, entry);
    const send = (obj) => {
      try {
        res.write(`data: ${JSON.stringify({ ...obj, taskId })}\n\n`);
      } catch {}
    };
    entry.send = send;
    // 进度心跳（审计：长时间健康生成的可感知性——模型持续输出工具参数期间可能长时间
    // 无任何 SSE 事件，界面看似卡死；每 8 秒发一次 progress，前端实时显示已工作时长/步数，
    // 同时充当客户端无活动看门狗的活动源）
    const progressTimer = setInterval(() => {
      try {
        // 质检（静默深度优化）：progress 附带阶段语义与子代理数，客户端顶部常驻活动条据此实时播报
        const phase = entry.pendingAsk ? '等待权限确认' : io?._turnActive ? '模型推理中' : '执行工具中';
        send({
          type: 'progress',
          seconds: Math.round((Date.now() - entry.startedAt) / 1000),
          steps: io?.stats?.().toolCount || 0,
          tasks: io?.stats?.().taskCount || 0,
          phase,
        });
      } catch {}
    }, 5000);
    const userMessage = String(body.message ?? '').trim();
    entry.message = (userMessage || '[附件]').slice(0, 40);
    const visionSupported = Boolean(modelPreset(modelName)?.supportsVision || cfg.customModels?.[modelName]?.vision);
    const built = buildUserContent(userMessage, body.attachments, visionSupported);
    if (built.error) {
      entry.status = 'failed';
      send({ type: 'error', message: built.error });
      clearInterval(progressTimer);
      res.end();
      pruneTasks(); // 质检 L3：早退分支与主路径一致清理任务占位
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
        const route = await routeTask({
          cfg,
          provider,
          currentModel: modelName,
          text: built.persistText || userMessage,
          sticky: session.lastRoute || null,
          sessionStats: session.routeStats || null, // 会话级步数/截断统计（路由升级检测）
        });
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
    await withSessionLock(session.file, () => appendMessages(session.file, [{ role: 'user', content: built.persistText }]));
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
      clearInterval(progressTimer);
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
        withSessionLock(session.file, () => rewriteSession(session.file, msgs)).catch(() => {}); // onCompact 为同步回调：入队串行即可
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
      srvlog('chat 回合完成 ' + taskId + ' text=' + String(r.text || '').length + ' ' + (Date.now() - entry.startedAt) + 'ms');
      // 会话级路由统计（Hermes C2 升级检测）：累计工具步数与截断次数，粘滞 flash 会话复杂度上来后自动升 planner
      const st = session.routeStats || { steps: 0, truncated: 0 };
      session.routeStats = { steps: st.steps + (io.stats().toolCount || 0), truncated: st.truncated + (r.truncated ? 1 : 0) };
      await withSessionLock(session.file, () => appendMessages(session.file, messages.slice(persistedBefore)));
      io.printUsageLine({ modelName: runModel, usage: r.usage, durationMs: r.durationMs });
      recordUsage(runModel, r.usage, r.perf);
      maybeAutoSync().catch(() => {});
      // 新会话自动标题（可配置关闭）
      srvlog('chat 标题生成前 ' + taskId);
      if (isNew && cfg.autoTitle !== false && r.text) {
        try {
          const tModel = titleModel(cfg, runModel);
          const title = await generateTitle(await helperProvider(cfg, tModel, providerNow), tModel, built.persistText);
          srvlog('chat 标题完成 ' + taskId + ' ' + (title || '（无标题）'));
          if (title) {
            const oldName = path.basename(session.file);
            const renamed = renameSessionFile(fs, path, home, session, title);
            if (renamed) moveSessionWorkspace(oldName, path.basename(renamed)); // 会话改名 → 工作空间映射跟随
          }
        } catch {}
      }
      entry.status = r.aborted ? 'aborted' : 'done';
      entry.durationMs = Date.now() - entry.startedAt;
      srvlog('chat 发送 done ' + taskId + ' status=' + entry.status + ' 总耗时=' + entry.durationMs + 'ms');
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
        note: r.note || (r.text ? '' : `（本轮共执行 ${io.stats().toolCount} 步工具操作${io.stats().deliverables.length ? `、交付 ${io.stats().deliverables.length} 个文件` : ''}，但模型没有输出总结文字——可追问「总结一下刚才的工作」）`),
        stats: io.stats(),
        session: path.basename(session.file),
      });
    } catch (err) {
      entry.status = 'failed';
      entry.durationMs = Date.now() - entry.startedAt;
      srvlog('chat 错误 ' + taskId + ' ' + String(err?.message || err));
      send({ type: 'error', message: String(err?.message || err) });
    } finally {
      clearInterval(progressTimer);
      srvlog('chat 收尾 ' + taskId + ' res.end 前（客户端将收到流结束）');
      entry.abortHandler = null;
      entry.pendingAsk = null;
      entry.send = null;
      res.end();
      pruneTasks();
    }
  }

  const dispatch = createApiDispatch({
    json, srvlog, readBody, cfg, home,
    providerCache, getProviderFor, tasks,
    MAX_CONCURRENT, pruneTasks, handleChat,
    mcpFacade, provider, validateRemoteUrl, isPrivateHost,
    authEnabled, tokenMatches, requestToken, trustedHost, INDEX_HTML,
    state: { get modelName() { return modelName; }, set modelName(v) { modelName = v; },
             get workingDir() { return workingDir; }, set workingDir(v) { workingDir = v; },
             get draftText() { return draftText; }, set draftText(v) { draftText = v; } },
    refs: { get inflight() { return inflight; }, set inflight(v) { inflight = v; } },
  });
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

  await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
    server.once('error', (/** @type {Error & { code?: string }} */ err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[MingDao] 端口 ${port} 已被占用，请换一个端口：mingdao web <端口号>`);
      } else {
        console.error('[MingDao] 服务器错误：' + err.message);
      }
      reject(err); // 质检 C2/D1：绑定失败向上抛——CLI/桌面端可感知并重试，而非黑屏空转
    });
    server.listen(port, host, () => {
      server.removeAllListeners('error');
      server.on('error', (/** @type {Error & { code?: string }} */ err) => {
        console.error('[MingDao] 服务器运行期错误：' + (err?.message || err));
      });
      resolve();
    });
  }));
  {
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
      // 质检 L6：实际 trustedHost 白名单只放行回环 Host（远程浏览器带 LAN IP 的 Host 会 403），
      // 文案按真实行为修正——非浏览器客户端/伪造 Host 仍可达，务必启用令牌
      console.warn('  ⚠ 警告：当前监听 ' + host + '（非本机回环）且未启用令牌，浏览器直接访问会被拒绝（Host 白名单），但非浏览器客户端仍可直连。强烈建议：mingdao web --auth-token <令牌>。');
    }
    console.log(`  模型: ${modelName} · 权限: ${cfg.permission ?? 'ask'} · 工作目录: ${workingDir}`);
    if (cfg.mcpServers && Object.keys(cfg.mcpServers).length) console.log('  MCP:  后台连接中，/api/state 可查看状态');
    console.log(`  退出: Ctrl+C`);
    console.log('');
  }

  const shutdown = () => {
    mcpFacade.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}
