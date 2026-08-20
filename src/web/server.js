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
import { ensureHome, loadConfig, mingdaoHome } from '../config.js';
import { createProvider, resolveProviderConfig } from '../providers/index.js';
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
} from '../session.js';
import { listSkills } from '../skills.js';

const INDEX_HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html');

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
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
  const modelName = cfg.model || 'deepseek-v4-flash';
  const pc = resolveProviderConfig(cfg, modelName);
  if (!pc.apiKey) {
    console.error(`[MingDao] 未找到 API Key：请运行 mingdao key set ${pc.name} 或 mingdao init`);
    process.exitCode = 1;
    return;
  }

  const workingDir = process.cwd();
  const provider = await createProvider(cfg, modelName);
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

  // 单轮状态：同一时刻只允许一个生成任务；权限确认挂起在 pendingAsk
  let busy = false;
  let currentAbort = null;
  let pendingAsk = null;

  async function handleChat(res, body) {
    const send = (obj) => {
      try {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      } catch {}
    };
    const userMessage = String(body.message ?? '').trim();
    if (!userMessage) {
      json(res, 400, { error: '消息不能为空' });
      return;
    }

    let session = null;
    if (body.file) {
      try {
        const loaded = loadSession(path.join(home, 'sessions', path.basename(body.file)));
        if (loaded.messages.length) session = loaded;
      } catch {}
    }
    if (!session) session = createSession(home);

    const systemPrompt = buildSystemPrompt({ modelName, workingDir });
    let messages =
      session.messages?.length && session.messages[0]?.role === 'system'
        ? session.messages
        : [{ role: 'system', content: systemPrompt }, ...(session.messages || [])];
    messages[0] = { role: 'system', content: systemPrompt }; // 总是刷新 system（记忆/技能/AGENTS.md 最新）
    messages.push({ role: 'user', content: userMessage });
    appendMessages(session.file, [messages[messages.length - 1]]);
    const persistedBefore = messages.length;

    // 权限/选择类交互：发 ask 事件，等待 POST /api/permission 应答
    const askHandler = ({ question, hidden, options, label, confirm }) =>
      new Promise((resolve) => {
        const id = Math.random().toString(36).slice(2);
        pendingAsk = { id, resolve };
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
        currentAbort = fn;
      },
    });
    const permission = createPermission(cfg.permission ?? 'ask', io);
    const agent = createAgent({
      provider,
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
      if (pendingAsk) {
        pendingAsk.resolve('');
        pendingAsk = null;
      }
    });

    try {
      const r = await agent.runTurn(messages);
      appendMessages(session.file, messages.slice(persistedBefore));
      io.printUsageLine({ modelName, usage: r.usage, durationMs: r.durationMs });
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
      send({ type: 'error', message: String(err?.message || err) });
    } finally {
      busy = false;
      currentAbort = null;
      pendingAsk = null;
      res.end();
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
      json(res, 200, {
        ok: true,
        model: modelName,
        permission: cfg.permission ?? 'ask',
        home,
        workingDir,
        mcp: mcpFacade.status(),
        sessions,
      });
      return;
    }
    if (req.method === 'GET' && p === '/api/sessions') {
      const sessions = listSessions(home)
        .slice(0, 30)
        .map((s) => ({ file: s.name, mtime: s.mtime, label: `${relativeTime(s.mtime)} · ${sessionPreview(s.file)}` }));
      json(res, 200, { ok: true, sessions });
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
    if (req.method === 'GET' && p === '/api/skills') {
      json(res, 200, { ok: true, skills: listSkills(workingDir) });
      return;
    }
    if (req.method === 'POST' && p === '/api/chat') {
      if (busy) return json(res, 409, { error: '已有任务进行中，请等待完成或中断' });
      busy = true;
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
      if (!pendingAsk) return json(res, 409, { error: '没有挂起的权限确认' });
      const pa = pendingAsk;
      pendingAsk = null;
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
      if (currentAbort) {
        try {
          currentAbort();
        } catch {}
      }
      json(res, 200, { ok: true });
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
