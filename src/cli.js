#!/usr/bin/env node
// MingDao Harness CLI 入口：初始化向导、凭证管理、单次提问、交互式 TUI 会话。
// 会话能力：/plan 计划模式、/compact 上下文压缩、/init、/memory、/skills、
// /mode 模型快捷切换、/verbose 思考开关、/status、/cost、会话选择恢复。

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { loadConfig, saveConfig, runWizard, ensureHome, mingdaoHome } from './config.js';
import { modelPreset, PROVIDERS } from './models.js';
import { maskKey, getStoredKey } from './credentials.js';
import { createProvider, resolveProviderConfig, helperProvider } from './providers/index.js';
import { compactConversation } from './compact.js';
import { makeTokenCounter } from './tokenizer.js';
import { messageTokens } from './context.js';
import { startMcpServers } from './mcp.js';
import { startTask, listTasks, patchTask, killTask, formatTaskRow } from './tasks.js';
import { enableAutostart, disableAutostart, autostartStatus, autostartPath } from './autostart.js';
import { notifyTaskDone } from './notify.js';
import { addWorkspace, removeWorkspace, workspacePath, touchWorkspace, listWorkspaces, currentWorkspace } from './workspace.js';
import { finalizeSession, extractMemory, loadMemory, appendMemory, recentJournal, dedupeMemory, removeMemoryLines } from './memory.js';
import { recordUsage, listCacheStats, summarizeCacheStats, formatCacheSummary, costBreakdown } from './cachestats.js';
import { presetList, buildPreset } from './mcp-presets.js';
import {
  addSchedule,
  listSchedules,
  readSchedule,
  removeSchedule,
  pauseSchedule,
  resumeSchedule,
  chainSchedules,
  reconcileSchedules,
  runSleeper,
  formatScheduleRow,
} from './schedule.js';
import { createAgent } from './agent.js';
import { createPermission } from './permissions.js';
import { buildSystemPrompt } from './prompts.js';
import { listSkills, tamperedSkillNames } from './skills.js';
import { costGuardStatus } from './cost-guard.js';
import { libraryList, searchLibrary, installSkill, uninstallSkill, reinstallSkill, trustSkill } from './skill-lib.js';
import { syncLogin, syncLogout, syncPush, syncPull, syncStatus, syncRemoteList, maybeAutoSync, syncChangePassword, syncShareCreate, syncShareList, syncShareAccept, syncShareRevoke, listSyncConflicts, resolveSyncConflict } from './sync.js';
import { runWebServer } from './web/server.js';
import { routeTask, routingConfig } from './routing.js';
import { detectSandbox } from './tools/bash.js';
import { generateTitle, renameSessionFile, titleModel } from './titles.js';
import { estimateCost, isPeakHour, deferToOffpeak } from './pricing.js';
import { createIO, style, C } from './ui.js';
import {
  createSession,
  latestSession,
  appendMessages,
  rewriteSession,
  loadSession,
  listSessions,
  sessionPreview,
  relativeTime,
  searchSessions,
} from './session.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP_LINES = [
  [`MingDao Harness · AI 智能体框架 v${pkg.version}（命令：mingdao，简写 mdh）`, C.bold + C.cyan],
  ['', null],
  ['用法', C.bold + C.yellow],
  ['  mingdao                    交互式对话（TUI）', null],
  ['  mingdao "你的问题"         单次提问（适合脚本与管道）', null],
  ['  mingdao --format json "…"  单次提问，输出结构化 JSON', null],
  ['  mingdao web [端口]        启动 WebUI（默认 http://127.0.0.1:3820）', null],
  ['  mingdao sessions search <词> 全文检索历史会话', null],
  ['  mingdao run "<任务>"     后台启动任务（tasks 面板管理）', null],
  ['  mingdao tasks [watch|kill <id>] 查看/实时刷新/停止后台任务', null],
  ['  mingdao schedule add/list/remove/pause/resume/chain 定时任务与依赖编排', null],
  ['  mingdao autostart on|off    开机自启（登录后自动启动服务器）', null],
  ['  mingdao workspace add/list/use/path/remove 工作空间（项目目录登记与快速切换）', null],
  ['  mingdao --continue         继续最近一次会话', null],
  ['  mingdao --journal          新会话带上最近会话日志（默认不注入，新会话全新开始）', null],
  ['  mingdao --resume           从会话列表选择恢复', null],
  ['  mingdao --model <模型名>   指定模型，例如 deepseek-v4-pro', null],
  ['  mingdao init               初始化配置向导', null],
  ['  mingdao update [--check]   一键自更新（git 安装形态；--check 只对比版本）', null],
  ['  mingdao rollback           回滚到上次 update 之前的提交', null],
  ['  mingdao audit [数量]       查看工具调用审计日志（默认最近 20 条）', null],
  ['  mingdao desktop            启动桌面版（Electron，任意目录可用，托盘常驻）', null],
  ['  mingdao --help / --version 帮助 / 版本', null],
  ['', null],
  ['凭证管理（API Key 独立存储，绝不写入 config.json / 仓库）', C.bold + C.yellow],
  ['  mingdao key                查看凭证状态（脱敏显示）', null],
  ['  mingdao key set <服务商>   交互式保存 API Key（隐藏输入）', null],
  ['  mingdao key remove <服务商> 删除凭证', null],
  ['  mingdao key import         从环境变量导入所有可用 Key', null],
  ['', null],
  ['云同步与技能库（跨设备会话同步 / 技能安装）', C.bold + C.yellow],
  ['  mingdao sync login <用户名> [密码] <服务器地址> 登录云同步（自动注册）', null],
  ['  mingdao sync push|pull|status|logout  推送 / 拉取 / 状态 / 退出', null],
  ['  mingdao sync-server [端口] 自建云同步服务器（数据目录 /var/lib/mingdao-sync）', null],
  ['  mingdao skill search|install|uninstall|update <名称> 技能库（内置 + 线上 registry）', null],
  ['', null],
  ['会话内命令', C.bold + C.yellow],
  ['  /help        显示帮助          /clear   清空上下文', null],
  ['  /model <名>  切换模型          /mode    pro/flash 快捷切换', null],
  ['  /compact     压缩上下文        /plan    计划模式（先计划后执行）', null],
  ['  /init        生成 AGENTS.md    /memory add <内容> 追加用户记忆', null],
  ['  /skills      列出技能          /status  会话状态 · /cost 累计费用', null],
  ['  /sessions    历史会话/检索    /route on|off 自动路由开关', null],
  ['  /mcp         MCP 服务器状态  /verbose 思考开关 · /title <别名> 会话命名', null],
  ['  /usage       上轮用量          /exit    退出 · /save 会话文件', null],
  ['  /exit        退出              Tab 补全命令 · Ctrl+C 中断生成', null],
  ['', null],
  [`配置目录: ${mingdaoHome()}`, C.dim],
];

function printHelpLines(out) {
  for (const [text, code] of HELP_LINES) out(code ? style(text, code) : text);
}

function parseArgs(argv) {
  const opts = { prompt: [], model: null, continueSession: false, resume: false, format: 'text' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-v' || a === '--version') opts.version = true;
    else if (a === '-c' || a === '--continue') opts.continueSession = true;
    else if (a === '--journal') opts.journal = true;
    else if (a === '-r' || a === '--resume') opts.resume = true;
    else if (a === '--init' || a === 'init') opts.init = true;
    else if (a === '-m' || a === '--model') opts.model = argv[++i];
    else if (a.startsWith('--model=')) opts.model = a.slice(8);
    else if (a === '-f' || a === '--format') opts.format = argv[++i] || 'text';
    else if (a.startsWith('--format=')) opts.format = a.slice(9);
    else opts.prompt.push(a);
  }
  if (!['text', 'json'].includes(opts.format)) opts.format = 'text';
  return opts;
}

async function generatePlan(provider, modelName, task) {
  const res = await provider.chat({
    model: modelName,
    messages: [
      {
        role: 'system',
        content:
          '你是规划专家。为任务输出可执行计划：步骤列表（注明每步将使用的工具）、涉及的文件、风险点。不要执行任何工具、不要写代码。≤400 字，中文。',
      },
      { role: 'user', content: task },
    ],
    tools: [],
    temperature: 0.3,
    maxTokens: 2048,
  });
  return res.text || null;
}

// —— 后台任务 worker：独立进程执行一轮任务并写状态文件 ——
async function runWorkerTask(id, question, { permission, model, offpeak }) {
  const home = ensureHome();
  const finish = (patch) => patchTask(home, id, patch);
  let mcpFacade = null;
  let cfg = null; // 提到 try 外：catch 分支也要读 cfg.notify
  try {
    cfg = loadConfig();
    if (!cfg) throw new Error('未初始化配置，请先运行 mingdao init');
    const modelName = model || cfg.model || 'deepseek-v4-flash';
    const pc = resolveProviderConfig(cfg, modelName);
    if (!pc.apiKey) throw new Error(`模型 ${modelName} 没有可用 API Key`);
    const workingDir = process.cwd();
    // 后台无交互：ask 权限降级为 readonly 并注明（需要写权限请 mingdao run --permission auto）
    let perm = permission || cfg.permission || 'ask';
    let note = '';
    if (perm === 'ask') {
      perm = 'readonly';
      note = 'ask 权限下后台任务按只读执行';
    }
    // 避峰（评估 A2/Kimi P-1）：高峰时段（北京工作日 9:00–12:00、14:00–18:00）
    // 自动顺延到最近闲时起点（12:00 / 18:00）执行，输入价省 50%
    if (offpeak && isPeakHour(new Date())) {
      const defer = deferToOffpeak(new Date());
      finish({ note: `避峰等待至北京时间 ${defer.toISOString().slice(11, 16)}（闲时起执行，输入价省 50%）` });
      await new Promise((r) => setTimeout(r, defer.getTime() - Date.now() + 2000));
      finish({ note: '' });
    }
    const provider = await createProvider(cfg, modelName);
    const io = createIO({ quiet: true });
    const permissionObj = createPermission(perm, io);
    let mcpManager = null;
    if (cfg.mcpServers && Object.keys(cfg.mcpServers).length) {
      mcpFacade = {
        toolSchemas: () => (mcpManager ? mcpManager.toolSchemas() : []),
        call: (n, a) => (mcpManager ? mcpManager.call(n, a) : Promise.reject(new Error('MCP 未就绪'))),
        isReadonly: (n) => (mcpManager ? mcpManager.isReadonly(n) : false),
        stop: () => {
          if (mcpManager) mcpManager.stop();
        },
      };
      startMcpServers(cfg.mcpServers, workingDir).then((m) => (mcpManager = m)).catch(() => {});
    }
    const sessionRef = { name: null };
    const agent = createAgent({
      provider,
      permission: permissionObj,
      io,
      modelName,
      workingDir,
      cfg,
      mcp: mcpFacade || undefined,
      sessionRef,
      onCompact: (msgs) => {
        rewriteSession(session.file, msgs);
        persistedCount = msgs.length;
      },
    });
    const session = createSession(home);
    sessionRef.name = path.basename(session.file);
    const messages = [
      { role: 'system', content: buildSystemPrompt({ modelName, workingDir }) },
      { role: 'user', content: question },
    ];
    appendMessages(session.file, messages);
    let persistedCount = messages.length;
    const t0 = Date.now();
    const res = await agent.runTurn(messages);
    appendMessages(session.file, messages.slice(persistedCount));
    if (cfg.autoTitle !== false && res.text) {
      try {
        const tModel = titleModel(cfg, modelName);
        const title = await generateTitle(await helperProvider(cfg, tModel, provider), tModel, question);
        if (title) renameSessionFile(fs, path, home, session, title);
      } catch {}
    }
    const finalStatus = res.truncated ? 'failed' : res.aborted ? 'killed' : 'done';
    recordUsage(modelName, res.usage, res.perf);
    finish({
      status: finalStatus,
      text: (res.text || '').slice(0, 2000),
      usage: res.usage,
      durationMs: Date.now() - t0,
      session: path.basename(session.file),
      note,
    });
    if (cfg.notify !== false && !process.env.MINGDAO_TASK_QUIET_NOTIFY) notifyTaskDone(question, finalStatus === 'killed' ? 'failed' : finalStatus);
    try {
      await maybeAutoSync();
    } catch {}
    process.exitCode = res.truncated ? 1 : 0;
  } catch (err) {
    finish({ status: 'failed', error: String(err?.message || err) });
    if (cfg?.notify !== false && !process.env.MINGDAO_TASK_QUIET_NOTIFY) notifyTaskDone(question, 'failed');
    process.exitCode = 2;
  } finally {
    if (mcpFacade) mcpFacade.stop();
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelpLines(console.log);
    return;
  }
  if (opts.version) {
    console.log('mingdao ' + pkg.version);
    return;
  }
  // 最近会话日志默认不注入（新会话全新开始）；--journal 显式带上
  const withJournal = Boolean(opts.journal);

  // —— 命令分发（已拆至 src/commands/，评估 P0-1 拆 cli.js）——
  // 各 handler 返回 true = 已处理；false = 按普通提问继续（保留词劫持防护）。
  // 质检 M3：显式命令映射（命令 → {module, handler}），模块与命令一一对应、handler 名显式可查
  {
    const dispatchTable = {
      update: { module: 'update', handler: 'handleUpdateFamily' },
      rollback: { module: 'update', handler: 'handleUpdateFamily' },
      batch: { module: 'update', handler: 'handleUpdateFamily' },
      cost: { module: 'update', handler: 'handleUpdateFamily' },
      audit: { module: 'update', handler: 'handleUpdateFamily' },
      tasks: { module: 'schedule', handler: 'handleTasks' },
      schedule: { module: 'schedule', handler: 'handleSchedule' },
      workspace: { module: 'workspace', handler: 'handleWorkspace' },
      mcp: { module: 'workspace', handler: 'handleMcp' },
      sync: { module: 'sync', handler: 'handleSync' },
      skill: { module: 'skill', handler: 'handleSkill' },
      web: { module: 'skill', handler: 'handleWeb' },
      sessions: { module: 'skill', handler: 'handleSessions' },
      key: { module: 'key', handler: 'handleKey' },
      desktop: { module: 'desktop', handler: 'handleDesktop' },
    };
    const hit = dispatchTable[opts.prompt[0]];
    if (hit) {
      const mod = await import(`./commands/${hit.module}.js`);
      const fn = mod[hit.handler];
      const handled = await fn(opts.prompt[0], opts.prompt.slice(1));
      if (handled) return;
    }
  }

  // 质检 A9：run/run-worker 共用同一参数解析（此前两份重复且语义微妙不同）
  const parseRunArgs = (argv, { questionFlag = false } = {}) => {
    const out = { question: '', permission: null, model: null, offpeak: false };
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--permission') out.permission = argv[++i];
      else if (a === '--model') out.model = argv[++i];
      else if (a === '--offpeak') out.offpeak = true;
      else if (a === '--question') {
        const parts = [];
        while (i + 1 < argv.length && !['--permission', '--model', '--offpeak'].includes(argv[i + 1])) {
          parts.push(argv[++i]);
        }
        out.question = parts.join(' ');
      } else if (!out.question) out.question = a;
    }
    return out;
  };

  // 后台任务 worker（内部入口，由 mingdao run 启动）
  if (opts.prompt[0] === 'run-worker') {
    const id = opts.prompt[1];
    const { question, permission, model, offpeak } = parseRunArgs(opts.prompt.slice(2));
    await runWorkerTask(id, question, { permission, model, offpeak });
    return;
  }

  // 后台任务启动：mingdao run "<任务>" [--permission auto] [--model x]
  if (opts.prompt[0] === 'run') {
    const { question, permission, model, offpeak } = parseRunArgs(opts.prompt.slice(1));
    if (!question) {
      console.log('用法：mingdao run "<任务>" [--permission auto|readonly] [--model 模型名] [--offpeak]');
      process.exitCode = 1;
      return;
    }
    const home0 = ensureHome();
    reconcileSchedules(home0);
    const task = startTask(home0, question, { permission, model, cwd: process.cwd(), offpeak });
    console.log(`✓ 后台任务已启动 ${task.id}`);
    console.log(`  查看：mingdao tasks · 实时刷新：mingdao tasks watch · 停止：mingdao tasks kill ${task.id}`);
    return;
  }

  // 任务面板：mingdao tasks [watch|kill <id>]
  // 调度器 worker（内部入口，由 schedule 系统启动的 sleeper 进程）
  if (opts.prompt[0] === 'schedule-worker') {
    const home0 = ensureHome();
    await runSleeper(home0, opts.prompt[1]);
    return;
  }

  // 单守护进程调度器（评估 P3-5）：一进程监督全部调度任务（协程复用 runSleeper），无任务自动退出
  if (opts.prompt[0] === 'schedule-daemon') {
    const home0 = ensureHome();
    const { listSchedules, runSleeper, sleeperAlive, daemonPidFile, writeSchedule } = await import('./schedule.js');
    const { readTask } = await import('./tasks.js');
    const handled = new Set();
    const supervising = new Set(); // 本 daemon 正在监督的任务（防崩溃恢复误判正在执行的任务）
    try {
      for (;;) {
        const jobs = listSchedules(home0);
        if (!jobs.some((j) => j.status === 'pending' || j.status === 'running')) break;
        for (const j of jobs) {
          // 崩溃恢复（审计）：'running' 但无人监督且 worker 已死 → 按任务结果定案或重新排队，
          // 避免任务永久卡在 running（此前 daemon 重启后既不重跑也不收尾）
          if (j.status === 'running' && !supervising.has(j.id) && !sleeperAlive(j.pid)) {
            const t = j.lastTaskId ? readTask(home0, j.lastTaskId) : null;
            if (!t) {
              await writeSchedule(home0, { ...j, status: 'pending' });
              continue;
            }
            if (t.status !== 'running') {
              const result = t.status === 'done' ? 'done' : t.status === 'timedout' ? 'timedout' : 'failed';
              await writeSchedule(home0, { ...j, status: result, lastRunAt: t.startedAt || j.lastRunAt, runs: (j.runs || 0) + 1 });
              continue;
            }
            continue; // worker 仍在跑：等它（外层 2s 轮询）
          }
          if (j.status !== 'pending' || handled.has(j.id)) continue;
          if (sleeperAlive(j.pid)) continue; // 旧式 sleeper 仍在：交回给它，避免双跑
          if (j.lastTaskId) {
            const t = readTask(home0, j.lastTaskId);
            if (t && t.status === 'running') continue; // worker 仍在跑（异常窗口），不重拉
          }
          handled.add(j.id);
          supervising.add(j.id);
          runSleeper(home0, j.id)
            .catch(() => {})
            .finally(() => {
              handled.delete(j.id);
              supervising.delete(j.id);
            });
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    } finally {
      try {
        fs.rmSync(daemonPidFile(home0), { force: true });
      } catch {}
    }
    return;
  }

  // 任务队列与调度：mingdao schedule add/list/remove/pause/resume/chain
  // 开机自启：mingdao autostart on|off|status
  if (opts.prompt[0] === 'autostart') {
    const sub = opts.prompt[1] || 'status';
    if (sub === 'on') {
      console.log(enableAutostart() ? '✓ 已开启开机自启（登录后自动启动 mingdao web）' : '[错误] 设置失败');
    } else if (sub === 'off') {
      console.log(disableAutostart() ? '✓ 已关闭开机自启' : '[错误] 关闭失败');
    } else {
      console.log(autostartStatus() ? `✓ 开机自启已开启（${autostartPath()}）` : '✗ 未开启（mingdao autostart on 开启）');
    }
    return;
  }

  // 工作空间：mingdao workspace add|list|use|path|remove
  // 云同步：mingdao sync login|logout|push|pull|status · 自建服务端 mingdao sync-server [端口]
  if (opts.prompt[0] === 'sync-server') {
    const { runSyncServer } = await import('./sync-server.js');
    await runSyncServer({ port: Number(opts.prompt[1]) || undefined });
    return;
  }
  const home = ensureHome();
  let cfg = loadConfig();
  if (!cfg || opts.init) {
    const wio = createIO();
    cfg = await runWizard(wio);
    wio.close();
    if (opts.init) return;
  }

  // 模型回退链（向导允许跳过模型选择 → cfg.model 可缺省）：参数 > config > 该服务商首个预设模型 > flash
  let modelName = opts.model || cfg.model || PROVIDERS[cfg.provider]?.models?.[0] || 'deepseek-v4-flash';
  const io = createIO();

  const pc0 = resolveProviderConfig(cfg, modelName);
  if (!pc0.apiKey) {
    io.print(
      style(
        `未找到 API Key。\n` +
          `  · 运行 ${C.bold}mingdao key set ${pc0.name}${C.reset} 保存密钥，或\n` +
          `  · 运行 ${C.bold}mingdao init${C.reset} 重新配置，或\n` +
          `  · 设置环境变量 ${C.bold}MINGDAO_API_KEY${C.reset}（或 ${pc0.envHint}）。`,
        C.red
      )
    );
    process.exitCode = 1;
    return;
  }

  let provider = await createProvider(cfg, modelName);
  const permission = createPermission(cfg.permission ?? 'ask', io);
  const workingDir = process.cwd();
  // 会话级 undo 备份仓：模型切换、子代理均共享，撤销记录不丢失
  const sessionUndoStore = { backups: new Map() };
  // MCP 服务器：后台启动（不阻塞交互），就绪后工具自动出现在后续轮次
  let mcpManager = null;
  const mcpFacade = {
    toolSchemas: () => (mcpManager ? mcpManager.toolSchemas() : []),
    call: (n, a) => (mcpManager ? mcpManager.call(n, a) : Promise.reject(new Error('MCP 未就绪'))),
    isReadonly: (n) => (mcpManager ? mcpManager.isReadonly(n) : false),
    status: () => (mcpManager ? mcpManager.status() : [{ name: '（连接中…）', ok: false, tools: 0, error: '' }]),
    stop: () => {
      if (mcpManager) mcpManager.stop();
    },
  };
  if (cfg.mcpServers && Object.keys(cfg.mcpServers).length) {
    startMcpServers(cfg.mcpServers, workingDir)
      .then((mgr) => {
        mcpManager = mgr;
        const ready = mgr.status().filter((s) => s.ok).length;
        if (io && !opts.prompt.length) {
          io.print(style(`✓ MCP 就绪：${ready}/${mgr.status().length} 个服务器，共 ${mgr.toolSchemas().length} 个工具`, C.dim));
        }
      })
      .catch(() => {});
  }
  const sessionRef = { name: null }; // 会话名在下方 REPL 初始化中回填（审计归因用）
  let agent = createAgent({
    provider,
    permission,
    io,
    modelName,
    workingDir,
    cfg,
    undoStore: sessionUndoStore,
    mcp: mcpFacade,
    sessionRef,
    // 自动压缩后重写会话文件 + 同步落盘游标（session/persisted 在下方 REPL 初始化中声明）
    onCompact: (msgs) => {
      rewriteSession(session.file, msgs);
      persisted = msgs.length;
    },
  });
  const preset = modelPreset(modelName);

  // —— 单次提问模式 ——
  if (opts.prompt.length > 0) {
    const jsonMode = opts.format === 'json';
    const question = opts.prompt.join(' ');
    // 自动路由：规划类任务切 planner，执行类走 executor（JSON 模式静默）
    const route = await routeTask({ cfg, provider, currentModel: modelName, text: question });
    if (route.model !== modelName) {
      if (!jsonMode) io.print(style(`⤷ 自动路由 → ${route.model}（${route.reason}）`, C.dim));
      // 审计 P1-2（第五轮复审实证）：先按新模型重建 provider、再改模型名——
      // 此前顺序颠倒（先赋值再判断），条件恒假，跨服务商路由池会把 executor 模型名
      // 发到 planner 的 baseUrl/key 上（401/404）。默认同服务商配置不受影响。
      provider = await createProvider(cfg, route.model);
      modelName = route.model;
    }
    // JSON 模式：关闭流式输出，结果以单行 JSON 输出（脚本/管道友好）
    const turnIo = jsonMode ? createIO({ quiet: true }) : io;
    const session = createSession(home);
    const messages = [
      { role: 'system', content: buildSystemPrompt({ modelName, workingDir, withJournal }) },
      { role: 'user', content: question },
    ];
    let oneShotPersisted = messages.length;
    const oneShotRef = { name: path.basename(session.file) };
    const turnAgent = createAgent({
      provider,
      permission,
      io: turnIo,
      modelName,
      workingDir,
      cfg,
      undoStore: sessionUndoStore,
      mcp: mcpFacade,
      sessionRef: oneShotRef,
      onCompact: (msgs) => {
        rewriteSession(session.file, msgs);
        oneShotPersisted = msgs.length;
      },
    });
    appendMessages(session.file, messages);
    try {
      const res = await turnAgent.runTurn(messages);
      appendMessages(session.file, messages.slice(oneShotPersisted));
      if (!jsonMode && cfg.autoTitle !== false && res.text) {
        const tModel = titleModel(cfg, modelName);
        const title = await generateTitle(await helperProvider(cfg, tModel, provider), tModel, question);
        if (title) {
          const renamed = renameSessionFile(fs, path, home, session, title);
          if (renamed) io.print(style(`✓ 会话标题：${path.basename(renamed)}`, C.dim));
        }
      }
      try {
        await finalizeSession({ cfg, provider, model: titleModel(cfg, modelName), home, workingDir, messages, turns: 1, lastText: res.text || '' });
      } catch {}
      try {
        await maybeAutoSync();
      } catch {}
      if (jsonMode) {
        console.log(
          JSON.stringify({
            ok: true,
            text: res.text,
            reasoning: res.reasoning || null,
            usage: res.usage,
            durationMs: res.durationMs,
            steps: res.steps,
            finish: res.finish,
            aborted: res.aborted,
            truncated: res.truncated,
            session: session.name,
          })
        );
        recordUsage(modelName, res.usage, res.perf);
        process.exitCode = res.truncated || res.aborted ? 1 : 0;
      } else {
        io.printUsageLine({ modelName, usage: res.usage, durationMs: res.durationMs });
        if (res.aborted) io.print(style('（已中断）', C.dim));
        recordUsage(modelName, res.usage, res.perf);
        process.exitCode = res.truncated ? 1 : 0;
      }
    } catch (err) {
      if (jsonMode) {
        console.log(JSON.stringify({ ok: false, error: String(err?.message || err) }));
      } else {
        io.print(style('\n[错误] ' + (err?.message || err), C.red));
      }
      process.exitCode = 2;
    }
    mcpFacade.stop();
    io.close();
    return;
  }

  // —— 交互式 TUI ——
  const storedKey = getStoredKey(pc0.name);
  const envKeyDetected = (pc0.envHint && process.env[pc0.envHint]) || process.env.MINGDAO_API_KEY;
  const keySource = envKeyDetected ? '环境变量' : storedKey ? `凭证库 ${maskKey(storedKey)}` : 'config 字段';
  const sandboxMode = cfg.sandbox || 'off';
  const sandboxLabel =
    sandboxMode === 'off' ? 'off' : detectSandbox() === 'bwrap' ? sandboxMode : `${sandboxMode}（bwrap 缺失，已降级）`;
  const routing = routingConfig(cfg);
  const wsNow = currentWorkspace(workingDir);
  io.print('');
  io.box(`MingDao Harness v${pkg.version}`, [
    `模型  ${modelName}${preset?.label ? '（' + preset.label + '）' : ''}`,
    `权限  ${permission.mode} · 密钥  ${keySource}`,
    `沙箱  ${sandboxLabel}${routing ? ` · 路由  ${routing.planner}⇄${routing.executor}` : ''}`,
    wsNow ? `工作空间  ${wsNow.name}（${wsNow.dir}）` : '',
  ].filter(Boolean));
  io.print(style('输入问题开始对话 · /help 查看命令 · Tab 补全 · Ctrl+C 中断生成\n', C.dim));

  // WebUI 自动启动（首次运行 mingdao web 时可选开启，存 config.web.autoStart）：
  // 独立后台进程拉起，退出 TUI 后 WebUI 继续可用；关闭：mingdao web --no-autostart
  if (cfg.web?.autoStart && !process.env.MINGDAO_NO_WEB_AUTOSTART) {
    try {
      const { spawn } = await import('node:child_process');
      const { fileURLToPath } = await import('node:url');
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'web'], {
        detached: true,
        stdio: 'ignore',
        env: process.env,
      });
      child.on('error', (err) => io.print(style(`[WebUI 自启失败] ${err?.message || err}（可手动运行 mingdao web ${cfg.web?.port || 3820}）`, C.red)));
      child.unref();
      io.print(style(`🌐 WebUI 后台启动中：http://127.0.0.1:${cfg.web?.port || 3820}（关闭自动启动：mingdao web --no-autostart）`, C.dim));
    } catch (err) {
      io.print(style(`[WebUI 自启失败] ${err?.message || err}`, C.red)); // 质检 L6：不再静默吞掉
    }
  }

  let session = null;
  if (opts.resume) {
    const list = listSessions(home).slice(0, 10);
    if (!list.length) {
      io.print(style('没有可恢复的历史会话，已新建。', C.dim));
    } else {
      const choice = await io.choose(
        '选择要恢复的会话：',
        list.map((s) => ({ value: s.file, label: `${relativeTime(s.mtime)} · ${sessionPreview(s.file)}` }))
      );
      const loaded = loadSession(choice);
      if (loaded.messages.length) {
        session = loaded;
        io.print(style(`✓ 已载入会话 ${path.basename(choice)}（${loaded.messages.length} 条消息）`, C.green));
      }
    }
  }
  if (!session && opts.continueSession) {
    const latest = latestSession(home);
    if (latest) {
      const loaded = loadSession(latest.file);
      if (loaded.messages.length) {
        session = loaded;
        io.print(style(`已载入会话 ${latest.name}（${loaded.messages.length} 条消息）`, C.dim));
      }
    }
    if (!session) io.print('没有可继续的历史会话，已新建。');
  }
  if (!session) session = createSession(home);
  sessionRef.name = path.basename(session.file);
  io.print(style(`会话  ${path.basename(session.file)}`, C.dim));

  const systemPrompt = buildSystemPrompt({ modelName, workingDir, withJournal });
  // 恢复会话时刷新 system prompt（用户记忆 / AGENTS.md / 技能清单 / 时间戳以当前为准），
  // 旧 system 消息保留在会话文件中，不影响追加历史。
  const loadedMsgs = session.messages || [];
  const hasOldSystem = loadedMsgs[0]?.role === 'system';
  let messages = hasOldSystem
    ? [{ role: 'system', content: systemPrompt }, ...loadedMsgs.slice(1)]
    : [{ role: 'system', content: systemPrompt }, ...loadedMsgs];
  let persisted = messages.length;
  let lastUsage = null;
  let lastText = '';
  let planMode = false;
  let routingEnabled = Boolean(routing);
  let lastRouteModel = null; // 会话级路由粘滞（评估 P2-1：执行类会话不再逐轮分类）
  let autoTitled = Boolean(session.messages?.length);
  const stats = { turns: 0, promptTokens: 0, completionTokens: 0 };
  io.setHistory(messages.filter((m) => m.role === 'user').map((m) => m.content));

  async function switchToModel(target, { silent = false, persist = true } = {}) {
    try {
      const npc = resolveProviderConfig(cfg, target);
      if (!npc.apiKey) {
        io.print(style('该模型没有可用的 API Key，请先运行 mingdao init 配置。', C.red));
        return false;
      }
      const newProvider = await createProvider(cfg, target);
      provider = newProvider;
      modelName = target;
      // 自动路由的切换只改会话内存态（评估 P3-6：不悄悄改写用户持久默认模型）；/model 显式切换才落盘
      if (persist) {
        cfg.model = target;
        saveConfig(cfg);
      }
      agent = createAgent({
        provider,
        permission,
        io,
        modelName,
        workingDir,
        cfg,
        undoStore: sessionUndoStore,
        mcp: mcpFacade,
        sessionRef,
        onCompact: (msgs) => {
          rewriteSession(session.file, msgs);
          persisted = msgs.length;
        },
      });
      messages[0] = { role: 'system', content: buildSystemPrompt({ workingDir, withJournal }) };
      if (!silent) {
        const p2 = modelPreset(modelName);
        io.print(style(`✓ 已切换到 ${C.bold}${modelName}${C.reset}${p2 ? `（${p2.label}）` : ''}`, C.green));
      }
      return true;
    } catch (err) {
      io.print(style('[错误] ' + (err?.message || err), C.red));
      return false;
    }
  }

  for (;;) {
    let input;
    try {
      input = await io.askMultiline(style('你> ', C.green));
    } catch {
      break;
    }
    if (input === '') continue;

    if (input.startsWith('/')) {
      const [cmd, ...rest] = input.split(/\s+/);
      const arg = rest.join(' ');
      // 审计（第五轮 P1-1 教训）：斜杠命令统一 try/catch——单条命令异常只提示不退出，
      // 绝不再因一条命令的错误杀死整个 REPL 会话（历史 P1-1 曾导致会话上下文全丢）
      try {
      if (cmd === '/exit' || cmd === '/quit') break;
      else if (cmd === '/help') printHelpLines(io.print);
      else if (cmd === '/clear') {
        messages = [{ role: 'system', content: systemPrompt }];
        // 评估 P2-1：会话文件同步原子重写为仅新 system——否则旧上下文残留会被 --continue 读回，
        // 且后续 appendMessages 会把 system+新消息重复追加到旧历史之后。
        try {
          rewriteSession(session.file, messages);
        } catch {}
        persisted = messages.length;
        io.print('已清空上下文（会话文件已同步重置）。');
      } else if (cmd === '/model') {
        if (!arg) {
          io.print(`当前模型：${modelName}`);
          continue;
        }
        await switchToModel(arg);
      } else if (cmd === '/mode') {
        const map = { pro: 'deepseek-v4-pro', flash: 'deepseek-v4-flash' };
        const target = map[arg] || arg;
        if (!target) {
          io.print('用法：/mode pro|flash|<模型名>（pro=deepseek-v4-pro，flash=deepseek-v4-flash）');
          continue;
        }
        await switchToModel(target);
      } else if (cmd === '/think') {
        const vals = ['low', 'high', 'max'];
        if (!arg) {
          io.print(`用法：/think low|high|max|off（当前：${cfg.reasoningEffort || '跟随模型默认 high'}）`);
          continue;
        }
        if (arg === 'off') cfg.reasoningEffort = undefined;
        else if (vals.includes(arg)) cfg.reasoningEffort = arg;
        else { io.print(style('无效取值：low|high|max|off', C.red)); continue; }
        agent = createAgent({
          provider, permission, io, modelName, workingDir, cfg,
          undoStore: sessionUndoStore, mcp: mcpFacade, sessionRef,
          onCompact: (msgs) => {
            rewriteSession(session.file, msgs);
            persisted = msgs.length;
          },
        });
        io.print(style(`✓ 思考强度：${cfg.reasoningEffort || 'off（模型默认）'}`, C.green));
      } else if (cmd === '/plan') {
        planMode = !planMode;
        io.print(style(`✓ 计划模式：${planMode ? '开' : '关'}${planMode ? '（先出计划，确认后执行）' : ''}`, C.green));
      } else if (cmd === '/route') {
        if (!routing) {
          io.print(style('未配置自动路由（config.json 的 routing 字段，如 {"enabled":true,"planner":"deepseek-v4-pro","executor":"deepseek-v4-flash"}）', C.dim));
          continue;
        }
        if (arg === 'on' || arg === 'off') routingEnabled = arg === 'on';
        else routingEnabled = !routingEnabled;
        io.print(style(`✓ 自动路由：${routingEnabled ? '开' : '关'}（规划类→${routing.planner}，执行类→${routing.executor}）`, C.green));
      } else if (cmd === '/verbose') {
        io.setShowReasoning(!io.showReasoning);
        io.print(style(`✓ 思考过程显示：${io.showReasoning ? '开' : '关'}`, C.green));
      } else if (cmd === '/compact') {
        if (messages.length <= 6) {
          io.print(style('消息较少（≤6 条），无需压缩。', C.dim));
          continue;
        }
        io.startSpinner('正在压缩上下文…');
        let compacted = null;
        try {
          const count = makeTokenCounter(modelName);
          let total = 0;
          for (const m of messages) total += messageTokens(m, count);
          const budget = Math.max(1000, Math.round(total * 0.5)); // 手动触发：保留约 30% 尾部
          compacted = await compactConversation({
            messages,
            budget,
            count,
            provider,
            executorModel: modelName,
            triggerRatio: 0,
            force: true, // 手动意图明确：跳过最小裁剪门槛
          });
        } catch (err) {
          io.print(style('[压缩失败] ' + (err?.message || err), C.red));
        }
        io.stopSpinner();
        if (!compacted?.messages) {
          io.print(style('未能压缩（被裁段落不足或摘要失败）。', C.dim));
          continue;
        }
        messages = compacted.messages;
        appendMessages(session.file, [{ role: 'system', content: '── /compact 压缩点 ──' }, ...messages.slice(1)]);
        persisted = messages.length;
        io.print(style(`✓ 已压缩上下文：${compacted.droppedCount} 条早期消息 → 摘要（回收约 ${compacted.droppedTokens} tokens）`, C.green));
      } else if (cmd === '/init') {
        const target = path.join(workingDir, 'AGENTS.md');
        if (fs.existsSync(target) && arg !== 'force') {
          io.print(style(`已存在 ${target}，如需覆盖：/init force`, C.yellow));
          continue;
        }
        const entries = fs.readdirSync(workingDir).slice(0, 20).join('、') || '（空目录）';
        const template =
          `# ${path.basename(workingDir)} 项目约定\n\n` +
          `## 项目概述\n\n（一句话说明项目用途）\n\n` +
          `## 常用命令\n\n（构建、测试、运行命令）\n\n` +
          `## 代码结构\n\n顶层内容：${entries}\n\n` +
          `## 约定与规范\n\n（团队约定、注意事项；MingDao 每次会话会自动读取本文件）\n`;
        fs.writeFileSync(target, template);
        io.print(style(`✓ 已生成 ${target}，将在后续会话自动注入。`, C.green));
      } else if (cmd === '/memory') {
        const memPath = path.join(mingdaoHome(), 'AGENTS.md');
        if (arg.startsWith('add ')) {
          const text = arg.slice(4).trim();
          if (!text) {
            io.print('用法：/memory add <内容>');
            continue;
          }
          fs.appendFileSync(memPath, `- ${text}\n`);
          io.print(style(`✓ 已追加到用户记忆 ${memPath}（后续会话自动生效）`, C.green));
        } else if (arg === 'extract') {
          io.startSpinner('正在从当前对话提炼记忆…');
          try {
            const existing = loadMemory();
            const lines = await extractMemory(provider, titleModel(cfg, modelName), messages, existing);
            io.stopSpinner();
            if (lines.length) {
              appendMemory(lines);
              io.print(style(`✓ 新增 ${lines.length} 条记忆：`, C.green));
              for (const l of lines) io.print(style('  ' + l, C.dim));
            } else {
              io.print(style('没有发现新的值得记住的内容。', C.dim));
            }
          } catch (err) {
            io.stopSpinner();
            io.print(style('[错误] ' + (err?.message || err), C.red));
          }
        } else if (arg === 'show') {
          const raw = loadMemory();
          if (!raw.trim()) {
            io.print('记忆库为空。');
          } else {
            io.print(style('记忆库（' + memPath + '）：', C.bold));
            raw.split('\n').forEach((l, i) => {
              if (l.trim()) io.print(style(`  ${String(i + 1).padStart(3)}  ${l}`, C.dim));
            });
          }
        } else if (arg.startsWith('remove ')) {
          const kw = arg.slice(7).trim();
          if (!kw) {
            io.print('用法：/memory remove <关键词>（删除包含该词的条目）');
            continue;
          }
          const removed = removeMemoryLines(kw);
          io.print(removed > 0 ? style(`✓ 已删除 ${removed} 条（原文件备份于 ${memPath}.bak）`, C.green) : style('没有匹配的条目。', C.dim));
        } else if (arg === 'dedupe') {
          const removed = dedupeMemory();
          io.print(removed > 0 ? style(`✓ 去重完成：合并 ${removed} 条重复记忆`, C.green) : style('没有重复条目。', C.dim));
        } else if (arg === 'edit') {
          const editor = process.env.EDITOR || process.env.VISUAL;
          if (!editor) {
            io.print(style('未设置 EDITOR 环境变量。可 export EDITOR=nano（或 vim/code）后用 /memory edit 打开记忆文件。', C.yellow));
            continue;
          }
          const { spawnSync } = await import('node:child_process');
          spawnSync(editor, [memPath], { stdio: 'inherit' });
          io.print(style('✓ 记忆文件已编辑（后续会话自动生效）。', C.green));
        } else {
          io.print(style(`用户记忆文件：${memPath}${fs.existsSync(memPath) ? '' : '（尚不存在）'}`, C.dim));
          if (fs.existsSync(memPath)) io.print(style(fs.readFileSync(memPath, 'utf8').slice(0, 2000), C.dim));
          const journal = recentJournal(home, 5);
          if (journal.length) {
            io.print(style('最近会话：', C.bold));
            for (const e of journal.reverse()) io.print(style(`  ${new Date(e.at).toISOString().slice(0, 10)} ${e.firstUser?.slice(0, 40)}`, C.dim));
          }
          io.print('用法：/memory add <内容> 追加 · extract 自动提炼 · show 查看 · remove <词> 删除 · dedupe 去重 · edit 编辑器修改');
        }
      } else if (cmd === '/skills') {
        const skills = listSkills(workingDir);
        if (!skills.length) {
          io.print(
            style(
              '未安装技能。目录：~/.mingdao/skills/（用户级）、<项目>/.mingdao/skills/（项目级）与内置技能库',
              C.dim
            )
          );
          continue;
        }
        const label = (s) => `${s.name}${s.source === 'user' ? '（用户级）' : s.source === 'builtin' ? '（内置）' : ''}`;
        io.box(
          `已安装技能（${skills.length}）`,
          skills.map((s) => `${label(s)}：${s.description || '（无描述）'}`)
        );
        io.print(style(`技能库安装：退出会话后运行 mingdao skill search [关键词] → mingdao skill install <名称>`, C.dim));
      } else if (cmd === '/title') {
        if (!arg) {
          io.print('用法：/title <别名>（给当前会话命名，便于 --resume 识别）');
          continue;
        }
        const safe = arg.replace(/[^\w\u4e00-\u9fa5.-]/g, '_').slice(0, 40);
        let newFile = path.join(home, 'sessions', safe + '.jsonl');
        try {
          fs.appendFileSync(session.file, ''); // 确保文件已创建（尚未写消息时也可能重命名）
          // 同名会话已存在时附加随机后缀，绝不静默覆盖
          if (fs.existsSync(newFile)) {
            newFile = path.join(home, 'sessions', safe + '-' + Math.random().toString(36).slice(2, 6) + '.jsonl');
          }
          fs.renameSync(session.file, newFile);
          session.file = newFile;
          io.print(style(`✓ 会话已命名为 ${path.basename(newFile)}`, C.green));
        } catch (err) {
          io.print(style('[错误] ' + (err?.message || err), C.red));
        }
      } else if (cmd === '/audit') {
        const n = Number(arg) || 10;
        const { listAudit } = await import('./audit.js');
        const rows = listAudit(n);
        if (!rows.length) {
          io.print(style('暂无审计记录（工具调用会自动记录）。', C.dim));
          continue;
        }
        io.print(style(`最近 ${rows.length} 条工具调用审计：`, C.bold));
        for (const r of rows) {
          const when = new Date(r.at).toISOString().slice(0, 19).replace('T', ' ');
          const status = r.denied ? `✖拒绝(${r.reason || ''})` : r.ok ? '✓' : '✖错误';
          io.print(`  ${when}  ${status}  ${r.tool}  ${String(r.args || '').slice(0, 60)}`);
        }
      } else if (cmd === '/mcp') {
        const status = mcpFacade.status();
        if (status.length === 1 && status[0].name === '（连接中…）' && !status[0].ok && !mcpManager) {
          if (!cfg.mcpServers || !Object.keys(cfg.mcpServers).length) {
            io.print(style('未配置 MCP 服务器（config.json 的 mcpServers 字段）。', C.dim));
          } else {
            io.print(style('MCP 服务器连接中…（npx 首次下载依赖可能较慢）', C.dim));
          }
          continue;
        }
        io.box(
          `MCP 服务器（${status.length}）`,
          status.map((s) => `${s.ok ? '✓' : '✖'} ${s.name}${s.ok ? ` · ${s.tools} 个工具` : `：${s.error}`}`)
        );
      } else if (cmd === '/sessions') {
        if (arg) {
          // 关键词全文检索历史会话
          const hits = searchSessions(home, arg);
          if (!hits.length) {
            io.print(style(`未找到包含「${arg}」的会话。`, C.dim));
          } else {
            io.box(`会话检索：${arg}（${hits.length} 个命中）`, hits.map((h) => `${h.name}（${relativeTime(h.mtime)}）`));
            for (const h of hits.slice(0, 5)) io.print(style(`  ${h.snippet}`, C.dim));
            io.print(style('恢复：mingdao --resume（或 mingdao sessions search 命令）', C.dim));
          }
        } else {
          const list = listSessions(home).slice(0, 10);
          if (!list.length) io.print('暂无历史会话。');
          else {
            io.box('历史会话（最近 10 个）', list.map((s) => `${relativeTime(s.mtime)} · ${sessionPreview(s.file)}`));
            io.print(style('检索：/sessions <关键词> · 恢复：mingdao --resume（文件：' + path.join(home, 'sessions') + '）', C.dim));
          }
        }
      } else if (cmd === '/save') {
        io.print(`当前会话自动保存于：${session.file}`);
      } else if (cmd === '/usage') {
        if (lastUsage) {
          io.print(
            style(
              `上轮用量：${lastUsage.prompt_tokens} prompt + ${lastUsage.completion_tokens} completion tokens`,
              C.dim
            )
          );
        } else io.print('尚无用量记录。');
      } else if (cmd === '/status') {
        io.box('会话状态', [
          `模型  ${modelName} · 权限 ${permission.mode}`,
          `沙箱  ${cfg.sandbox || 'off'}${routing ? ` · 自动路由  ${routingEnabled ? '开' : '关'}（${routing.planner}⇄${routing.executor}）` : ''}`,
          `会话  ${path.basename(session.file)}`,
          `轮次  ${stats.turns} · 消息 ${messages.length} 条`,
          `Tokens  ↑${stats.promptTokens} ↓${stats.completionTokens}`,
          `费用  ≈¥${estimateCost(modelName, stats.promptTokens, stats.completionTokens).toFixed(5)}（累计·按当前模型计价）`,
          `计划模式  ${planMode ? '开' : '关'} · 思考显示  ${io.showReasoning ? '开' : '关'} · 任务 ${agent.getTodos().length} 项`,
        ]);
      } else if (cmd === '/cost') {
        const bd = costBreakdown();
        io.box('费用分账（含缓存折扣与 Batch 半价的真实口径）', [
          `累计  ≈¥${bd.totalCost.toFixed(5)} · 今日 ≈¥${bd.today.toFixed(5)}` +
            `${bd.totalSaved > 0 ? ` · 相比全未命中已省 ≈¥${bd.totalSaved.toFixed(5)}` : ''}`,
          `缓存命中率  ${bd.rate != null ? (bd.rate * 100).toFixed(0) + '%' : '暂无缓存数据'}${bd.batchCost > 0 ? ` · Batch 半价任务 ≈¥${bd.batchCost.toFixed(5)}` : ''}`,
          ...bd.byModel.slice(0, 8).map((m) => `  ${m.model}：${m.turns} 轮（${m.batchTurns ? m.batchTurns + ' 批' : ''}）· ↑${m.prompt} ↓${m.completion} · ≈¥${m.cost.toFixed(5)}${m.saved > 0 ? ` · 省 ¥${m.saved.toFixed(5)}` : ''}`),
        ]);
        const guard = costGuardStatus();
        if (guard) {
          io.print(
            style(
              `费用护栏：今日 ¥${guard.cost.toFixed(4)} / 上限 ¥${guard.limit.toFixed(2)}${guard.overLimit ? '（已达上限' + (guard.action === 'block' ? '，执行已暂停' : '，仅提醒') + '）' : ''}`,
              guard.overLimit ? C.yellow : C.dim
            )
          );
        }
        io.print(style('会话内累计（本次）≈¥' + estimateCost(modelName, stats.promptTokens, stats.completionTokens).toFixed(5), C.dim));
      } else if (cmd === '/cache') {
        const entries = listCacheStats();
        if (!entries.length) {
          io.print(style('暂无缓存统计（对话若干轮后自动累积）。', C.dim));
          continue;
        }
        const sum = summarizeCacheStats(entries);
        io.box('缓存命中率仪表盘', formatCacheSummary(sum));
        io.print(style('近 10 次命中率趋势：', C.dim));
        const recent = entries.slice(-10);
        const maxBar = 24;
        for (const e of recent) {
          const rate = e.hit != null && e.hit + e.miss > 0 ? e.hit / (e.hit + e.miss) : null;
          const bar = rate == null ? '—'.repeat(maxBar) : '█'.repeat(Math.round(rate * maxBar));
          io.print(style(`  ${bar.padEnd(maxBar)} ${rate == null ? 'n/a' : (rate * 100).toFixed(0) + '%'}  ${e.model}`, C.dim));
        }
      } else {
        io.print(style('未知命令，输入 /help 查看可用命令。', C.yellow));
      }
      continue;
      } catch (err) {
        io.print(style('[错误] 命令执行失败：' + (err?.message || err), C.red));
        continue;
      }
    }

    // 自动路由：规划类任务切 planner，执行类走 executor（会话粘滞 + 分类缓存见 routing.js）
    if (routingEnabled) {
      const route = await routeTask({ cfg, provider, currentModel: modelName, text: input, sticky: lastRouteModel });
      lastRouteModel = route.model;
      if (route.model !== modelName) {
        const okSwitch = await switchToModel(route.model, { silent: true, persist: false });
        if (okSwitch) io.print(style(`⤷ 自动路由 → ${route.model}（${route.reason}）`, C.dim));
      }
    }

    // 计划模式：先出计划，确认后执行
    if (planMode) {
      io.startSpinner('正在生成计划…');
      let plan = null;
      try {
        plan = await generatePlan(provider, modelName, input);
      } catch (err) {
        io.print(style('[计划生成失败] ' + (err?.message || err), C.red));
      }
      io.stopSpinner();
      if (plan == null) continue;
      io.print(style('── 执行计划 ──', C.bold + C.cyan));
      io.print(plan);
      const okGo = await io.confirm(style('是否按此计划执行？[y/N]', C.yellow));
      if (!okGo) {
        io.print(style('已取消执行，可修改要求后重试。', C.dim));
        continue;
      }
      const planMsg = { role: 'assistant', content: '[执行计划]\n' + plan };
      messages.push(planMsg);
      appendMessages(session.file, [planMsg]);
      persisted += 1;
    }

    const userMsg = { role: 'user', content: input };
    messages.push(userMsg);
    appendMessages(session.file, [userMsg]);
    persisted += 1;

    try {
      const res = await agent.runTurn(messages);
      lastUsage = res.usage;
      lastText = res.text || lastText;
      stats.turns += 1;
      recordUsage(modelName, res.usage, res.perf);
      stats.promptTokens += res.usage.prompt_tokens || 0;
      stats.completionTokens += res.usage.completion_tokens || 0;
      const fresh = messages.slice(persisted);
      appendMessages(session.file, fresh);
      persisted = messages.length;
      if (!autoTitled && cfg.autoTitle !== false && res.text) {
        autoTitled = true;
        const tModel = titleModel(cfg, modelName);
        const title = await generateTitle(await helperProvider(cfg, tModel, provider), tModel, input);
        if (title) {
          const renamed = renameSessionFile(fs, path, home, session, title);
          if (renamed) io.print(style(`✓ 会话标题：${path.basename(renamed)}`, C.dim));
        }
      }
      if (res.aborted) {
        io.print(style('（已中断）', C.dim));
      }
      if (res.truncated) {
        io.print(style('[警告] 达到最大工具调用步数，任务可能未完成。', C.yellow));
      }
      if (res.finish === 'length') {
        io.print(style('[提示] 模型输出达到长度上限被截断。', C.yellow));
      }
      io.printUsageLine({ modelName, usage: res.usage, durationMs: res.durationMs });
    } catch (err) {
      io.print(style('[错误] ' + (err?.message || err), C.red));
      io.print(style('提示：可直接继续对话，或 /exit 退出。', C.dim));
    }
  }

  mcpFacade.stop();
  if (stats.turns > 0) {
    io.startSpinner('正在沉淀会话记忆…');
    try {
      await finalizeSession({
        cfg,
        provider,
        model: titleModel(cfg, modelName),
        home,
        workingDir,
        messages,
        turns: stats.turns,
        lastText,
      });
    } catch {}
    io.stopSpinner();
  }
  try {
    await maybeAutoSync();
  } catch {}
  io.print('再见，MingDao Harness 与你同行。');
  io.close();
}

main().catch((err) => {
  console.error('[MingDao] ' + (err?.message || err));
  if (process.env.MINGDAO_DEBUG) console.error(err);
  process.exit(1);
});
