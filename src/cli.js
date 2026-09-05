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
import { saveTaskStateMerge, clearTaskState } from './task-state.js';
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
  ['  mingdao --preset <名>      应用智能体预设（工具白名单/权限/参数，v0.4.0 契约化）', null],
  ['  mingdao init               初始化配置向导', null],
  ['  mingdao update [--check]   一键自更新（git 安装形态；--check 只对比版本）', null],
  ['  mingdao rollback           回滚到上次 update 之前的提交', null],
  ['  mingdao audit [数量]       查看工具调用审计日志（默认最近 20 条）', null],
  ['  mingdao diagnose           一键生成诊断报告（脱敏打包日志/审计/配置，便于反馈排查）', null],
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

function printHelpLines(/** @type {any} */ out) {
  for (const [text, code] of HELP_LINES) out(code ? style(text, code) : text);
}

function parseArgs(/** @type {any} */ argv) {
  const opts = /** @type {Record<string, any>} */ ({ prompt: [], model: null, continueSession: false, resume: false, format: 'text' });
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-v' || a === '--version') opts.version = true;
    else if (a === '-c' || a === '--continue') opts.continueSession = true;
    else if (a === '--journal') opts.journal = true;
    else if (a === '-p' || a === '--preset') opts.preset = argv[++i];
    else if (a.startsWith('--preset=')) opts.preset = a.slice(9);
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

async function generatePlan(/** @type {any} */ provider, /** @type {any} */ modelName, /** @type {any} */ task) {
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

// —— 后台任务 worker（Phase C C2）：已抽取至 src/tasks/worker.js，入口处动态导入 ——

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
    const dispatchTable = /** @type {Record<string, any>} */ ({
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
      diagnose: { module: 'diagnose', handler: 'handleDiagnose' },
    });
    const hit = dispatchTable[opts.prompt[0]];
    if (hit) {
      const mod = await import(`./commands/${hit.module}.js`);
      const fn = mod[hit.handler];
      const handled = await fn(opts.prompt[0], opts.prompt.slice(1));
      if (handled) return;
    }
  }

  // 质检 A9：run/run-worker 共用同一参数解析（此前两份重复且语义微妙不同）
  const parseRunArgs = (/** @type {any} */ argv, { questionFlag = false } = {}) => {
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

  // 后台任务 worker（内部入口，由 mingdao run 启动；逻辑在 tasks/worker.js，Phase C C2）
  if (opts.prompt[0] === 'run-worker') {
    const id = opts.prompt[1];
    const { question, permission, model, offpeak } = parseRunArgs(opts.prompt.slice(2));
    const { runWorkerTask } = await import('./tasks/worker.js');
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
    const nonce = String(opts.prompt[1] || '');
    try {
      for (;;) {
        // 守护进程租约自检（2026-09-03，防双 daemon）：pidfile 不再等于「我的 pid nonce」
        // 即视为已被 stop 或已被新 daemon 取代——立即退出，绝不与新 daemon 并跑重复执行任务
        try {
          if (fs.readFileSync(daemonPidFile(home0), 'utf8').trim() !== `${process.pid} ${nonce}`) break;
        } catch {
          break; // pidfile 被删 = 已被 stop
        }
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
      // 只删除「仍指向自己」的 pidfile：租约被改写/被新 daemon 取代而退出时，
      // 绝不误删新 daemon 的 pidfile（否则新 daemon 下一次租约检查会连锁退出，双守护全灭）
      try {
        if (fs.readFileSync(daemonPidFile(home0), 'utf8').trim() === `${process.pid} ${nonce}`) {
          fs.rmSync(daemonPidFile(home0), { force: true });
        }
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
  let modelName = opts.model || cfg.model || /** @type {any} */ (PROVIDERS)[cfg.provider]?.models?.[0] || 'deepseek-v4-flash';
  const io = createIO();
  const workingDir = process.cwd();

  // v0.4.0 Agent Preset：--preset <名> 应用声明式预设（工具白名单/权限/模型/参数 + 系统提示定制段）。
  // 预设覆盖优先级：CLI 显式参数 > 预设 > config.json。
  // 会话级 overlay：不改写 cfg（否则 REPL /model、/think 的 saveConfig 会把预设字段持久化进 config.json）。
  let activePreset = /** @type {any} */ (null);
  let presetBlock = '';
  let presetOverlay = /** @type {Record<string, any>} */ ({});
  if (opts.preset) {
    const { loadPreset, presetConfigOverrides, presetSystemBlock, listPresets } = await import('./presets.js');
    activePreset = loadPreset(workingDir, opts.preset);
    if (!activePreset) {
      const names = listPresets(workingDir).map((/** @type {any} */ p) => p.name).join(', ') || '（无可用预设）';
      io.print(style(`⚠ 预设 "${opts.preset}" 不存在。可用：${names}`, C.yellow));
    } else {
      presetOverlay = { ...presetConfigOverrides(activePreset), presetName: activePreset.name };
      if (!opts.model && presetOverlay.model) modelName = presetOverlay.model;
      presetBlock = presetSystemBlock(activePreset);
      io.print(style(`▣ 已应用智能体预设：${activePreset.name}${activePreset.label ? '（' + activePreset.label + '）' : ''}`, C.cyan));
    }
  }
  // agent 使用的配置 = cfg + 预设 overlay（presetTools/permission/参数按预设生效，cfg 本体保持干净）
  const agentCfg = Object.keys(presetOverlay).length ? { ...cfg, ...presetOverlay } : cfg;

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
  const permission = createPermission(agentCfg.permission ?? 'ask', io);
  // v0.4.0 契约化：挂载 config.tools 声明式第三方工具（幂等，重启生效）
  {
    const { mountConfigTools } = await import('./tools/index.js');
    const mounted = mountConfigTools(cfg);
    if (mounted.length) io.print(style(`🔧 已挂载声明式工具（config.tools）：${mounted.join(', ')}`, C.dim));
  }
  // 会话级 undo 备份仓：模型切换、子代理均共享，撤销记录不丢失
  const sessionUndoStore = { backups: new Map() };
  // MCP 服务器：后台启动（不阻塞交互），就绪后工具自动出现在后续轮次
  let mcpManager = /** @type {any} */ (null);
  const mcpFacade = {
    toolSchemas: () => (mcpManager ? mcpManager.toolSchemas() : []),
    call: (/** @type {any} */ n, /** @type {any} */ a) => (mcpManager ? mcpManager.call(n, a) : Promise.reject(new Error('MCP 未就绪'))),
    isReadonly: (/** @type {any} */ n) => (mcpManager ? mcpManager.isReadonly(n) : false),
    status: () => (mcpManager ? mcpManager.status() : [{ name: '（连接中…）', ok: false, tools: 0, error: '' }]),
    stop: () => {
      if (mcpManager) mcpManager.stop();
    },
  };
  if (cfg.mcpServers && Object.keys(cfg.mcpServers).length) {
    // A2：预热——await 连接（6s 超时）；超时本会话冻结工具集（不再中途注入，保护前缀缓存）。
    // 超时后输家 promise 仍在跑：迟到就绪的 manager 立即 stop，防 detached 子进程成孤儿（自查 #2）
    const mcpStartP = startMcpServers(cfg.mcpServers, workingDir).catch(() => null);
    mcpManager = await Promise.race([
      mcpStartP,
      new Promise((/** @type {any} */ r) => setTimeout(() => r(null), 6000)),
    ]);
    if (!mcpManager) mcpStartP.then((/** @type {any} */ m) => { if (m) m.stop(); });
    if (mcpManager) {
      const ready = mcpManager.status().filter((/** @type {any} */ s) => s.ok).length;
      if (io && !opts.prompt.length) {
        io.print(style(`✓ MCP 就绪：${ready}/${mcpManager.status().length} 个服务器，共 ${mcpManager.toolSchemas().length} 个工具`, C.dim));
      }
    } else if (io && !opts.prompt.length) {
      io.print(style('⚠ MCP 连接超时（6s）：本会话不注入 MCP 工具（重启 mingdao 可重试）', C.dim));
    }
  }
  const sessionRef = { name: null }; // 会话名在下方 REPL 初始化中回填（审计归因用）
  // 会话文件与落盘游标共享槽：REPL（commands/repl.js）创建会话/更新游标后回填，
  // TUI agent 的 onCompact 经此槽重写会话文件（Phase C C2 抽取后的正确连线，防 ReferenceError 静默吞掉压缩）
  const tuiState = /** @type {{session: any, persisted: number}} */ ({ session: null, persisted: 0 });
  let agent = createAgent({
    provider,
    permission,
    io,
    modelName,
    workingDir,
    cfg: agentCfg,
    undoStore: sessionUndoStore,
    mcp: mcpFacade,
    sessionRef,
    // 自动压缩后重写会话文件 + 同步落盘游标（经 tuiState 共享槽与 REPL 会话联动）
    onCompact: (/** @type {any} */ msgs) => {
      if (tuiState.session) rewriteSession(tuiState.session.file, msgs);
      tuiState.persisted = msgs.length;
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
      { role: 'system', content: buildSystemPrompt({ modelName, workingDir, withJournal, presetBlock }) },
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
      cfg: agentCfg,
      undoStore: sessionUndoStore,
      mcp: mcpFacade,
      sessionRef: oneShotRef,
      onCompact: (/** @type {any} */ msgs) => {
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
      // v0.3.0 P0-2：单次提问跑满步数/中断落检查点（--continue 可续跑），正常完成清除
      if (res.capHit || res.aborted) {
        saveTaskStateMerge(path.basename(session.file), {
          goal: question,
          progress: res.text || '',
          artifacts: res.perf?.deliverables || [],
          status: res.capHit ? 'cap' : 'interrupted',
          updatedAt: new Date().toISOString(),
        });
      } else {
        clearTaskState(path.basename(session.file));
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
        recordUsage(res.perf?.usedModel || modelName, res.usage, /** @type {any} */ (res.perf));
        process.exitCode = res.truncated || res.aborted ? 1 : 0;
      } else {
        io.printUsageLine({ modelName, usage: res.usage, durationMs: res.durationMs });
        if (res.aborted) io.print(style('（已中断）', C.dim));
        recordUsage(res.perf?.usedModel || modelName, res.usage, /** @type {any} */ (res.perf));
        process.exitCode = res.truncated ? 1 : 0;
      }
    } catch (/** @type {any} */ err) {
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

  // —— 交互式 TUI（Phase C C2：已抽取至 commands/repl.js） ——
  const { runRepl } = await import('./commands/repl.js');
  await runRepl({ io, cfg, agentCfg, home, pc0, opts, modelName, provider, permission, workingDir, sessionUndoStore, mcpFacade, mcpManager, sessionRef, agent, preset, withJournal, presetBlock, tuiState });
  return;

}

main().catch((err) => {
  console.error('[MingDao] ' + (err?.message || err));
  if (process.env.MINGDAO_DEBUG) console.error(err);
  process.exit(1);
});
