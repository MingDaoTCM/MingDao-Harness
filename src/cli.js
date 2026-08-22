#!/usr/bin/env node
// MingDao（明道）CLI 入口：初始化向导、凭证管理、单次提问、交互式 TUI 会话。
// 会话能力：/plan 计划模式、/compact 上下文压缩、/init、/memory、/skills、
// /mode 模型快捷切换、/verbose 思考开关、/status、/cost、会话选择恢复。

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { loadConfig, saveConfig, runWizard, ensureHome, mingdaoHome } from './config.js';
import { modelPreset, PROVIDERS } from './models.js';
import {
  loadCredentials,
  setStoredKey,
  removeStoredKey,
  maskKey,
  credentialsPath,
  getStoredKey,
} from './credentials.js';
import { createProvider, resolveProviderConfig } from './providers/index.js';
import { startMcpServers } from './mcp.js';
import { startTask, listTasks, patchTask, killTask, formatTaskRow } from './tasks.js';
import { enableAutostart, disableAutostart, autostartStatus, autostartPath } from './autostart.js';
import { notifyTaskDone } from './notify.js';
import { addWorkspace, removeWorkspace, workspacePath, touchWorkspace, listWorkspaces, currentWorkspace } from './workspace.js';
import { finalizeSession, extractMemory, loadMemory, appendMemory, recentJournal, dedupeMemory, removeMemoryLines } from './memory.js';
import { recordUsage, listCacheStats, summarizeCacheStats, formatCacheSummary } from './cachestats.js';
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
import { listSkills } from './skills.js';
import { libraryList, searchLibrary, installSkill, uninstallSkill, reinstallSkill } from './skill-lib.js';
import { syncLogin, syncLogout, syncPush, syncPull, syncStatus, syncRemoteList, maybeAutoSync, syncChangePassword, syncShareCreate, syncShareList, syncShareAccept, syncShareRevoke, listSyncConflicts, resolveSyncConflict } from './sync.js';
import { runWebServer } from './web/server.js';
import { routeTask, routingConfig } from './routing.js';
import { detectSandbox } from './tools/bash.js';
import { generateTitle, renameSessionFile, titleModel } from './titles.js';
import { estimateCost } from './pricing.js';
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
  [`MingDao 明道 · AI 智能体框架 v${pkg.version}（命令：mingdao，简写 mdh）`, C.bold + C.cyan],
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

async function compactContext(provider, modelName, messages) {
  const mid = messages.slice(1, -2);
  const res = await provider.chat({
    model: modelName,
    messages: [
      {
        role: 'system',
        content:
          '你是上下文压缩器。把以下对话历史压缩成要点摘要（中文 ≤600 字）：保留未完成任务、关键决策、文件改动、用户偏好；省略已完成的中间过程。',
      },
      {
        role: 'user',
        content: mid
          .map((m) => `${m.role}: ${m.content ?? JSON.stringify(m.tool_calls ?? '')}`)
          .join('\n'),
      },
    ],
    tools: [],
    temperature: 0.2,
    maxTokens: 2048,
  });
  return res.text || '';
}

// mingdao key [status|set <服务商> [key]|remove <服务商>|import]
async function handleKeyCommand(args) {
  const io = createIO();
  try {
    const sub = args[0] || 'status';
    const target = args[1];
    if (sub === 'status') {
      ensureHome();
      io.print(style(`本地凭证库：${credentialsPath()}`, C.bold));
      const creds = loadCredentials();
      const names = Object.keys(creds);
      if (!names.length) io.print('  (空)');
      for (const n of names) {
        io.print(style(`  ${n}: ${maskKey(creds[n])}`, C.dim));
      }
      for (const [k, pp] of Object.entries(PROVIDERS)) {
        if (pp.envKey && process.env[pp.envKey]) {
          io.print(style(`  环境变量 ${pp.envKey}: 已设置（未读取内容）`, C.dim));
        }
      }
      if (process.env.MINGDAO_API_KEY) {
        io.print(style('  环境变量 MINGDAO_API_KEY: 已设置（未读取内容）', C.dim));
      }
      io.print('提示：密钥只存本机凭证库，config.json 可安全分享/提交仓库。');
    } else if (sub === 'set') {
      if (!target) {
        io.print('用法：mingdao key set <服务商名> [key]');
        return;
      }
      let key = args[2] || '';
      if (!key) {
        if (!io.isTTY) {
          io.print('非交互环境请直接传参：mingdao key set <服务商名> <key>');
          return;
        }
        key = await io.ask(`输入 ${target} 的 API Key（隐藏输入）：`, { hidden: true });
      }
      if (!key) {
        io.print('未输入，已取消。');
        return;
      }
      setStoredKey(target, key);
      io.print(`已保存 ${target} → ${maskKey(key)}（${credentialsPath()}，权限 600）。`);
      io.print('注意：密钥不会写入 config.json，也不会进入项目仓库。');
    } else if (sub === 'remove') {
      if (!target) {
        io.print('用法：mingdao key remove <服务商名>');
        return;
      }
      removeStoredKey(target);
      io.print(`已移除 ${target} 的本地凭证。`);
    } else if (sub === 'import') {
      ensureHome();
      let count = 0;
      for (const [k, pp] of Object.entries(PROVIDERS)) {
        if (pp.envKey && process.env[pp.envKey]) {
          setStoredKey(k, process.env[pp.envKey]);
          io.print(`已导入 ${k}（来自环境变量 ${pp.envKey}）。`);
          count += 1;
        }
      }
      if (!count) io.print('没有可导入的环境变量（如 DEEPSEEK_API_KEY）。');
    } else {
      io.print('用法：mingdao key [status|set <服务商> [key]|remove <服务商>|import]');
    }
  } finally {
    io.close();
  }
}

// —— 后台任务 worker：独立进程执行一轮任务并写状态文件 ——
async function runWorkerTask(id, question, { permission, model }) {
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
    const agent = createAgent({
      provider,
      permission: permissionObj,
      io,
      modelName,
      workingDir,
      cfg,
      mcp: mcpFacade || undefined,
      onCompact: (msgs) => {
        rewriteSession(session.file, msgs);
        persistedCount = msgs.length;
      },
    });
    const session = createSession(home);
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
        const title = await generateTitle(provider, titleModel(cfg, modelName), question);
        if (title) renameSessionFile(fs, path, home, session, title);
      } catch {}
    }
    const finalStatus = res.truncated ? 'failed' : res.aborted ? 'killed' : 'done';
    recordUsage(modelName, res.usage);
    finish({
      status: finalStatus,
      text: (res.text || '').slice(0, 2000),
      usage: res.usage,
      durationMs: Date.now() - t0,
      session: path.basename(session.file),
      note,
    });
    if (cfg.notify !== false) notifyTaskDone(question, finalStatus === 'killed' ? 'failed' : finalStatus);
    try {
      await maybeAutoSync();
    } catch {}
    process.exitCode = res.truncated ? 1 : 0;
  } catch (err) {
    finish({ status: 'failed', error: String(err?.message || err) });
    if (cfg?.notify !== false) notifyTaskDone(question, 'failed');
    process.exitCode = 2;
  } finally {
    if (mcpFacade) mcpFacade.stop();
  }
}

function printTasks(home) {
  const tasks = listTasks(home);
  if (!tasks.length) {
    console.log('暂无任务。启动：mingdao run "<任务>"');
    return;
  }
  console.log(`任务面板（共 ${tasks.length} 个，新→旧）`);
  for (const t of tasks.slice(0, 20)) console.log('  ' + formatTaskRow(t));
  const running = tasks.filter((t) => t.status === 'running').length;
  console.log(running ? `\n${running} 个运行中 · mingdao tasks watch 实时刷新 · kill <id> 停止` : '\n无运行中任务');
}

async function watchTasks(home) {
  if (!process.stdout.isTTY) {
    printTasks(home);
    return;
  }
  for (;;) {
    const tasks = listTasks(home);
    console.log('\n\x1b[2J\x1b[H' + `任务面板 ${new Date().toLocaleTimeString()}`);
    if (!tasks.length) console.log('  暂无任务。启动：mingdao run "<任务>"');
    for (const t of tasks.slice(0, 20)) console.log('  ' + formatTaskRow(t));
    const running = tasks.filter((t) => t.status === 'running');
    if (!running.length) {
      console.log('\n全部任务已结束');
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
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

  // 自更新与回滚（git 安装形态）
  if (opts.prompt[0] === 'update') {
    const { updateCheck, mingdaoUpdate } = await import('./update.js');
    const checkOnly = opts.prompt.includes('--check');
    const r = await (checkOnly ? updateCheck() : mingdaoUpdate());
    console.log(r.lines?.join('\n') || '');
    process.exitCode = r.ok ? 0 : 1;
    return;
  }
  if (opts.prompt[0] === 'rollback') {
    const { mingdaoRollback } = await import('./update.js');
    const r = mingdaoRollback();
    console.log(r.lines?.join('\n') || '');
    process.exitCode = r.ok ? 0 : 1;
    return;
  }

  // 凭证管理子命令（无需配置即可使用）
  if (opts.prompt[0] === 'key') {
    await handleKeyCommand(opts.prompt.slice(1));
    return;
  }

  // 后台任务 worker（内部入口，由 mingdao run 启动）
  if (opts.prompt[0] === 'run-worker') {
    const id = opts.prompt[1];
    let question = '';
    let permission = null;
    let model = null;
    for (let i = 2; i < opts.prompt.length; i++) {
      const a = opts.prompt[i];
      if (a === '--permission') permission = opts.prompt[++i];
      else if (a === '--model') model = opts.prompt[++i];
      else if (a === '--question') {
        // 收集到下一个已知 flag 为止（参数顺序：--question <任务> --permission … --model …）
        const parts = [];
        while (i + 1 < opts.prompt.length && !['--permission', '--model'].includes(opts.prompt[i + 1])) {
          parts.push(opts.prompt[++i]);
        }
        question = parts.join(' ');
      }
    }
    await runWorkerTask(id, question, { permission, model });
    return;
  }

  // 后台任务启动：mingdao run "<任务>" [--permission auto] [--model x]
  if (opts.prompt[0] === 'run') {
    const rest = opts.prompt.slice(1);
    let question = '';
    let permission = null;
    let model = null;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--permission') permission = rest[++i];
      else if (a === '--model') model = rest[++i];
      else if (question === '') question = a;
    }
    if (!question) {
      console.log('用法：mingdao run "<任务>" [--permission auto|readonly] [--model 模型名]');
      process.exitCode = 1;
      return;
    }
    const home0 = ensureHome();
    reconcileSchedules(home0);
    const task = startTask(home0, question, { permission, model, cwd: process.cwd() });
    console.log(`✓ 后台任务已启动 ${task.id}`);
    console.log(`  查看：mingdao tasks · 实时刷新：mingdao tasks watch · 停止：mingdao tasks kill ${task.id}`);
    return;
  }

  // 任务面板：mingdao tasks [watch|kill <id>]
  if (opts.prompt[0] === 'tasks') {
    const home0 = ensureHome();
    reconcileSchedules(home0);
    const sub = opts.prompt[1];
    if (sub === 'kill') {
      const id = opts.prompt[2];
      if (!id) {
        console.log('用法：mingdao tasks kill <id>');
        process.exitCode = 1;
        return;
      }
      console.log(killTask(home0, id) ? `已请求停止任务 ${id}` : '任务不存在');
      return;
    }
    if (sub === 'watch') {
      await watchTasks(home0);
      return;
    }
    printTasks(home0);
    return;
  }

  // 调度器 worker（内部入口，由 schedule 系统启动的 sleeper 进程）
  if (opts.prompt[0] === 'schedule-worker') {
    const home0 = ensureHome();
    await runSleeper(home0, opts.prompt[1]);
    return;
  }

  // 任务队列与调度：mingdao schedule add/list/remove/pause/resume/chain
  if (opts.prompt[0] === 'schedule') {
    const home0 = ensureHome();
    reconcileSchedules(home0);
    const sub = opts.prompt[1];
    const rest = opts.prompt.slice(2);
    if (sub === 'add') {
      let question = '';
      let at = null;
      let every = null;
      let anchor = null;
      let after = [];
      let permission = null;
      let model = null;
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === '--at') at = rest[++i];
        else if (a === '--every') every = rest[++i];
        else if (a === '--anchor') anchor = rest[++i];
        else if (a === '--after') after = String(rest[++i]).split(',').map((x) => x.trim()).filter(Boolean);
        else if (a === '--permission') permission = rest[++i];
        else if (a === '--model') model = rest[++i];
        else if (question === '') question = a;
      }
      if (!question) {
        console.log('用法：mingdao schedule add "<任务>" [--at "YYYY-MM-DD HH:MM" | --every 2h [--anchor 09:00]] [--after 任务ID,...] [--permission auto] [--model 名]');
        process.exitCode = 1;
        return;
      }
      const r = addSchedule(home0, question, { at, every, after, permission, model, cwd: process.cwd(), anchor });
      if (r.error) {
        console.log('[错误] ' + r.error);
        process.exitCode = 1;
        return;
      }
      console.log(`✓ 调度任务已创建 ${r.id}`);
      console.log(`  查看：mingdao schedule list · 删除：mingdao schedule remove ${r.id}`);
      return;
    }
    if (sub === 'list') {
      const jobs = listSchedules(home0);
      if (!jobs.length) {
        console.log('暂无调度任务。创建：mingdao schedule add "<任务>" --at "2026-08-21 09:00" 或 --every 2h');
        return;
      }
      console.log(`调度队列（共 ${jobs.length} 个，按下次运行排序）`);
      for (const j of jobs.slice(0, 30)) console.log('  ' + formatScheduleRow(j));
      return;
    }
    if (sub === 'remove') {
      const id = rest[0];
      if (!id) {
        console.log('用法：mingdao schedule remove <id>');
        process.exitCode = 1;
        return;
      }
      console.log(removeSchedule(home0, id) ? `已删除调度任务 ${id}` : '任务不存在');
      return;
    }
    if (sub === 'pause') {
      const id = rest[0];
      if (!id) {
        console.log('用法：mingdao schedule pause <id>');
        process.exitCode = 1;
        return;
      }
      console.log(pauseSchedule(home0, id) ? `已暂停 ${id}（mingdao schedule resume ${id} 恢复）` : '任务不存在或不可暂停');
      return;
    }
    if (sub === 'resume') {
      const id = rest[0];
      if (!id) {
        console.log('用法：mingdao schedule resume <id>');
        process.exitCode = 1;
        return;
      }
      console.log(resumeSchedule(home0, id) ? `已恢复 ${id}` : '任务不存在或未暂停');
      return;
    }
    if (sub === 'chain') {
      if (rest.length < 2) {
        console.log('用法：mingdao schedule chain "任务A" "任务B" "任务C"（按顺序执行，后者依赖前者成功）');
        process.exitCode = 1;
        return;
      }
      const r = chainSchedules(home0, rest);
      if (r.error) {
        console.log('[错误] ' + r.error);
        process.exitCode = 1;
        return;
      }
      console.log(`✓ 链式队列已创建：${r.ids.join(' → ')}`);
      return;
    }
    console.log('用法：mingdao schedule add|list|remove|pause|resume|chain');
    return;
  }

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
  if (opts.prompt[0] === 'workspace') {
    const sub = opts.prompt[1] || 'list';
    const name = opts.prompt[2];
    if (sub === 'add') {
      if (!name) {
        console.log('用法：mingdao workspace add <名称> [目录]');
        process.exitCode = 1;
        return;
      }
      const r = addWorkspace(name, opts.prompt[3]);
      if (r.error) {
        console.log('[错误] ' + r.error);
        process.exitCode = 1;
        return;
      }
      console.log(`✓ 已登记工作空间 ${r.name} → ${r.dir}`);
      return;
    }
    if (sub === 'remove') {
      if (!name) {
        console.log('用法：mingdao workspace remove <名称>');
        process.exitCode = 1;
        return;
      }
      console.log(removeWorkspace(name) ? `✓ 已移除 ${name}` : '未找到该工作空间');
      return;
    }
    if (sub === 'path') {
      if (!name) {
        console.log('用法：mingdao workspace path <名称>');
        process.exitCode = 1;
        return;
      }
      const p = workspacePath(name);
      if (p) console.log(p);
      else {
        console.error('未找到该工作空间（mingdao workspace list 查看）');
        process.exitCode = 1;
      }
      return;
    }
    if (sub === 'use') {
      if (!name) {
        console.log('用法：mingdao workspace use <名称>');
        process.exitCode = 1;
        return;
      }
      const p = workspacePath(name);
      if (!p) {
        console.log('未找到该工作空间（mingdao workspace list 查看）');
        process.exitCode = 1;
        return;
      }
      touchWorkspace(name);
      console.log(`✓ 工作空间 ${name}：${p}`);
      console.log(`  快速进入：cd "$(mingdao workspace path ${name})"（建议做成 shell 函数/别名，如 mdw() { cd "$(mingdao workspace path "$1")"; }）`);
      return;
    }
    const ws = listWorkspaces();
    if (!ws.length) {
      console.log('暂无工作空间。添加：mingdao workspace add <名称> [目录]');
    } else {
      console.log('工作空间（最近使用优先）');
      for (const w of ws) console.log(`  ${w.name.padEnd(16)} ${w.dir}`);
      console.log('\n  进入：cd "$(mingdao workspace path <名称>)"');
    }
    return;
  }

  // MCP 预设：mingdao mcp preset list|add <名称> [参数]
  if (opts.prompt[0] === 'mcp' && opts.prompt[1] === 'preset') {
    const home0 = ensureHome();
    if (opts.prompt[2] === 'add') {
      const name = opts.prompt[3];
      if (!name) {
        console.log('用法：mingdao mcp preset add <名称> [参数]（列表见 mingdao mcp preset list）');
        process.exitCode = 1;
        return;
      }
      const r = buildPreset(name, opts.prompt[4], process.cwd());
      if (r.error) {
        console.log('[错误] ' + r.error);
        process.exitCode = 1;
        return;
      }
      const cfg0 = loadConfig();
      if (!cfg0) {
        console.log('未初始化配置，请先运行 mingdao init');
        process.exitCode = 1;
        return;
      }
      cfg0.mcpServers = cfg0.mcpServers || {};
      cfg0.mcpServers[name] = r.config;
      saveConfig(cfg0);
      console.log(`✓ 已添加 MCP 服务器 ${name}（重启 mingdao web 后生效；会话内 /mcp 查看状态）`);
      return;
    }
    console.log('MCP 生态预设（mingdao mcp preset add <名称> 一键接入）：');
    for (const p of presetList()) {
      console.log(`  ${p.name.padEnd(20)} ${p.label}${p.argLabel ? `（参数：${p.argLabel}）` : ''}`);
    }
    return;
  }

  // 云同步：mingdao sync login|logout|push|pull|status · 自建服务端 mingdao sync-server [端口]
  if (opts.prompt[0] === 'sync-server') {
    const { runSyncServer } = await import('./sync-server.js');
    await runSyncServer({ port: Number(opts.prompt[1]) || undefined });
    return;
  }
  if (opts.prompt[0] === 'sync') {
    const sub = opts.prompt[1] || 'status';
    if (sub === 'login') {
      const username = opts.prompt[2];
      if (!username) {
        console.log('用法：mingdao sync login <用户名> [密码] [服务器地址]（地址默认取已配置项）');
        process.exitCode = 1;
        return;
      }
      const s0 = syncStatus();
      const url = opts.prompt[4] || s0.url;
      if (!url) {
        console.log('缺少服务器地址：mingdao sync login <用户名> [密码] <http(s)://地址>');
        process.exitCode = 1;
        return;
      }
      let password = opts.prompt[3];
      if (!password) {
        password = await new Promise((resolve) => {
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const orig = rl._writeToOutput;
          rl._writeToOutput = () => {};
          rl.question('密码（至少 8 位）：', (a) => {
            if (typeof orig === 'function') rl._writeToOutput = orig;
            rl.close();
            resolve(a.trim());
          });
        });
      }
      const insecureFlag = opts.prompt[5] === '--insecure' || opts.prompt[6] === '--insecure';
      const r = await syncLogin({ url, username, password, deviceName: opts.prompt[5] === '--insecure' ? undefined : opts.prompt[5], insecure: insecureFlag });
      if (r.error) {
        console.log('[错误] ' + r.error);
        process.exitCode = 1;
        return;
      }
      if (insecureFlag) {
        console.log('  已启用 insecure（跳过证书校验，正式证书就绪后请在 config.sync 删除 insecure 字段）');
      }
      console.log(`✓ 已登录 ${r.username}（设备 ${r.deviceName}）→ ${r.url}`);
      console.log('  推送：mingdao sync push · 拉取：mingdao sync pull · 会话结束自动同步（config.sync.auto）');
      return;
    }
    if (sub === 'logout') {
      syncLogout();
      console.log('✓ 已退出同步（配置保留，凭证已清除）');
      return;
    }
    if (sub === 'passwd') {
      const newPassword = opts.prompt[2];
      if (!newPassword) {
        console.log('用法：mingdao sync passwd <新密码>（将提示输入旧密码）');
        process.exitCode = 1;
        return;
      }
      const oldPassword = await new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const orig = rl._writeToOutput;
        rl._writeToOutput = () => {};
        rl.question('旧密码：', (a) => {
          if (typeof orig === 'function') rl._writeToOutput = orig;
          rl.close();
          resolve(a.trim());
        });
      });
      const r = await syncChangePassword({ oldPassword, newPassword });
      if (r.error) {
        console.log('[错误] ' + r.error);
        process.exitCode = 1;
        return;
      }
      console.log('✓ 密码已修改（其他设备下次登录用新密码）');
      return;
    }
    if (sub === 'share') {
      const name = opts.prompt[2];
      if (!name) {
        console.log('用法：mingdao sync share <会话文件名>（列出：mingdao sync shares）');
        process.exitCode = 1;
        return;
      }
      const r = await syncShareCreate(name);
      if (r.error) {
        console.log('[错误] ' + r.error);
        process.exitCode = 1;
        return;
      }
      console.log(`✓ 已创建分享（会话 ${r.name}）`);
      console.log(`  分享码：${r.shareId}`);
      console.log(`  对方接受：mingdao sync accept ${r.shareId}`);
      return;
    }
    if (sub === 'shares') {
      const r = await syncShareList();
      if (r.error) {
        console.log('[错误] ' + r.error);
        process.exitCode = 1;
        return;
      }
      console.log(`我分享的（${r.mine.length}）：`);
      for (const s of r.mine) console.log(`  ${s.shareId.padEnd(12)} ${s.name} · 被接受 ${s.pulls} 次`);
      console.log(`我接受的（${r.accepted.length}）：`);
      for (const s of r.accepted) console.log(`  ${s.shareId.padEnd(12)} ${s.owner} 的 ${s.name} → 本地 ${s.savedAs}`);
      if (!r.mine.length && !r.accepted.length) console.log('  暂无分享');
      return;
    }
    if (sub === 'accept') {
      const shareId = opts.prompt[2];
      if (!shareId) {
        console.log('用法：mingdao sync accept <分享码>');
        process.exitCode = 1;
        return;
      }
      const r = await syncShareAccept(shareId);
      if (r.error) {
        console.log('[错误] ' + r.error);
        process.exitCode = 1;
        return;
      }
      console.log(`✓ 已接受分享 → 本地会话 ${r.savedAs}${r.conflict ? '（与你已有的同名会话不同，已另存副本）' : ''}`);
      return;
    }
    if (sub === 'unshare') {
      const shareId = opts.prompt[2];
      if (!shareId) {
        console.log('用法：mingdao sync unshare <分享码>');
        process.exitCode = 1;
        return;
      }
      const r = await syncShareRevoke(shareId);
      if (r.error) {
        console.log('[错误] ' + r.error);
        process.exitCode = 1;
        return;
      }
      console.log(`✓ 已撤销分享 ${shareId}（已接受者保留副本）`);
      return;
    }
    if (sub === 'conflicts') {
      const list = listSyncConflicts();
      if (!list.length) {
        console.log('暂无冲突备份');
        return;
      }
      console.log(`冲突备份（${list.length} 个会话）· 解决：mingdao sync conflict-resolve <会话名> local|remote|both`);
      for (const c of list) {
        const localLabel = c.localExists ? '本地有' : '本地无';
        const newest = c.entries[0];
        console.log(`  ${c.base.padEnd(44)} ${localLabel} · 备份 ${c.entries.length} 个（最新 ${newest.side}-${newest.ts}）`);
      }
      return;
    }
    if (sub === 'conflict-resolve') {
      const base = opts.prompt[2];
      const choice = opts.prompt[3];
      if (!base || !['local', 'remote', 'both'].includes(choice)) {
        console.log('用法：mingdao sync conflict-resolve <会话文件名> local|remote|both');
        console.log('  local  保留本地，删除备份 · remote  采用远端版本覆盖本地 · both  两者都保留（备份转正）');
        process.exitCode = 1;
        return;
      }
      const r = resolveSyncConflict(base, choice);
      if (r.error) {
        console.log('[错误] ' + r.error);
        process.exitCode = 1;
        return;
      }
      console.log(`✓ 已解决：${r.base} → ${choice === 'local' ? '保留本地' : choice === 'remote' ? '采用 ' + r.applied : '保留两者（' + r.kept + '）'}`);
      return;
    }
    if (sub === 'push') {
      const r = await syncPush(opts.prompt[2]);
      if (r.error) {
        console.log('[错误] ' + r.error);
        process.exitCode = 1;
        return;
      }
      console.log(`✓ 已推送 ${r.pushed.length} 个会话${r.skipped?.length ? `（跳过 ${r.skipped.length} 个空会话）` : ''}${r.conflicts.length ? `，远端 ${r.conflicts.length} 个不同版本已备份为 .server-*（本地覆盖远端）` : ''}`);
      return;
    }
    if (sub === 'pull') {
      const r = await syncPull(opts.prompt[2]);
      if (r.error) {
        console.log('[错误] ' + r.error);
        process.exitCode = 1;
        return;
      }
      console.log(`✓ 已拉取 ${r.pulled.length} 个会话${r.conflicts.length ? `，${r.conflicts.length} 个与本地不同：远端内容已存为 .remote-*（本地保留）` : ''}`);
      return;
    }
    const st = syncStatus();
    if (!st.configured) {
      console.log('未配置云同步。登录：mingdao sync login <用户名> [密码] <http(s)://服务器地址>');
      return;
    }
    console.log(`同步服务器  ${st.url}`);
    console.log(`账号        ${st.username || '（未登录）'} · 设备 ${st.deviceName || '（未登录）'}`);
    console.log(`状态        ${st.loggedIn ? '✓ 已登录' : '✗ 未登录'} · 自动同步 ${st.auto ? '开' : '关'}`);
    if (st.loggedIn) {
      const remote = await syncRemoteList();
      if (remote.error) {
        console.log(`远端会话    ${remote.error}`);
      } else {
        console.log(`远端会话    ${remote.sessions.length} 个`);
        for (const s of remote.sessions.slice(0, 10)) {
          console.log(`  ${s.name.padEnd(42)} ${new Date(s.mtime).toLocaleString()} · ${(s.size / 1024).toFixed(1)}KB`);
        }
      }
    }
    return;
  }

  // 技能库：mingdao skill list|search|install|uninstall|update
  if (opts.prompt[0] === 'skill') {
    const sub = opts.prompt[1] || 'list';
    const arg = opts.prompt[2];
    if (sub === 'search') {
      const local = searchLibrary(arg || '');
      const { searchRegistry } = await import('./skill-registry.js');
      const remote = await searchRegistry(arg || '');
      const localNames = new Set(local.map((s) => s.name));
      const remoteOnly = remote.skills ? remote.skills.filter((s) => !localNames.has(s.name)) : [];
      console.log(
        `技能库匹配：内置 ${local.length}${remote.error ? '' : ` + 线上 ${remoteOnly.length}`} · 安装：mingdao skill install <名称>`
      );
      for (const s of local) console.log(`  ${s.name.padEnd(18)} ${s.description}${s.installed ? '（已安装）' : ''}  [内置]`);
      if (remote.error) {
        console.log(`  ✗ 线上 registry 不可达：${remote.error}`);
      } else {
        for (const s of remoteOnly) console.log(`  ${s.name.padEnd(18)} ${s.description}${s.installed ? '（已安装）' : ''}  [线上]`);
        if (remote.stale) console.log('  （线上索引来自本地缓存，已过期）');
      }
      return;
    }
    if (sub === 'install') {
      const r = await installSkill(arg);
      if (r.error) {
        console.log('[错误] ' + r.error);
        process.exitCode = 1;
        return;
      }
      if (r.names) {
        console.log(`✓ 已从 git 仓库安装 ${r.names.length} 个技能：${r.names.join(', ')}`);
      } else {
        const srcLabel = r.host ? '（线上 registry）' : '';
        console.log(`✓ 已安装技能 ${r.name}${srcLabel} → ~/.mingdao/skills/${r.name}/（可编辑/删除，下次会话生效）`);
      }
      return;
    }
    if (sub === 'uninstall') {
      if (!arg) {
        console.log('用法：mingdao skill uninstall <名称>');
        process.exitCode = 1;
        return;
      }
      const r = uninstallSkill(arg);
      if (r.error) {
        console.log('[错误] ' + r.error);
        process.exitCode = 1;
        return;
      }
      console.log(`✓ 已卸载 ${r.name}（内置同名技能如有会自动重新可见）`);
      return;
    }
    if (sub === 'update') {
      if (!arg) {
        console.log('用法：mingdao skill update <名称>');
        process.exitCode = 1;
        return;
      }
      const r = await reinstallSkill(arg);
      if (r.error) {
        console.log('[错误] ' + r.error);
        process.exitCode = 1;
        return;
      }
      console.log(`✓ 已更新技能 ${r.name}`);
      return;
    }
    const skills = listSkills(process.cwd());
    console.log(`已安装技能（${skills.length}）· 三级来源：用户级 > 项目级 > 内置`);
    for (const s of skills) {
      const label = s.source === 'user' ? '（用户级）' : s.source === 'project' ? '（项目级）' : '（内置）';
      console.log(`  ${s.name.padEnd(18)} ${s.description || ''}${label}`);
    }
    const lib = libraryList();
    console.log(`\n技能库共 ${lib.length} 个可安装技能：mingdao skill search [关键词] 搜索，mingdao skill install <名称> 安装`);
    return;
  }

  // WebUI：mingdao web [端口] [--auth-token <令牌>]
  if (opts.prompt[0] === 'web') {
    const cfg0 = loadConfig();
    const portArg = opts.prompt[1] !== undefined ? Number(opts.prompt[1]) : NaN;
    const port = Number.isFinite(portArg) && portArg > 0 ? portArg : cfg0?.web?.port || 3820;
    const host = cfg0?.web?.host || '127.0.0.1';
    // 访问令牌优先级：--auth-token 参数 > 环境变量 MINGDAO_WEB_TOKEN > config.json 的 web.token
    let authToken = process.env.MINGDAO_WEB_TOKEN || cfg0?.web?.token || undefined;
    const atIdx = opts.prompt.findIndex((a) => typeof a === 'string' && a.startsWith('--auth-token'));
    if (atIdx !== -1) {
      const raw = opts.prompt[atIdx];
      authToken = raw.includes('=') ? raw.slice(raw.indexOf('=') + 1) : opts.prompt[atIdx + 1];
      if (!authToken) {
        console.log('用法：mingdao web [端口] [--auth-token <令牌>]');
        process.exitCode = 1;
        return;
      }
    }
    await runWebServer({ host, port, authToken });
    return;
  }

  // 会话检索：mingdao sessions search <关键词>
  if (opts.prompt[0] === 'sessions' && opts.prompt[1] === 'search') {
    const kw = opts.prompt.slice(2).join(' ').trim();
    if (!kw) {
      console.log('用法：mingdao sessions search <关键词>');
      process.exitCode = 1;
      return;
    }
    const home0 = ensureHome();
    const hits = searchSessions(home0, kw);
    if (!hits.length) console.log(`未找到包含「${kw}」的会话。`);
    else {
      console.log(`找到 ${hits.length} 个会话：`);
      for (const h of hits) {
        console.log(`  ${h.name}（${relativeTime(h.mtime)}）\n    ${h.snippet}`);
      }
      console.log(`\n恢复：mingdao --resume（选择器中可见全部会话）`);
    }
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

  let modelName = opts.model || cfg.model || 'deepseek-v4-flash';
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
  let agent = createAgent({
    provider,
    permission,
    io,
    modelName,
    workingDir,
    cfg,
    undoStore: sessionUndoStore,
    mcp: mcpFacade,
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
    const turnAgent = createAgent({
      provider,
      permission,
      io: turnIo,
      modelName,
      workingDir,
      cfg,
      undoStore: sessionUndoStore,
      mcp: mcpFacade,
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
        const title = await generateTitle(provider, titleModel(cfg, modelName), question);
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
        recordUsage(modelName, res.usage);
        process.exitCode = res.truncated || res.aborted ? 1 : 0;
      } else {
        io.printUsageLine({ modelName, usage: res.usage, durationMs: res.durationMs });
        if (res.aborted) io.print(style('（已中断）', C.dim));
        recordUsage(modelName, res.usage);
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
  io.box(`MingDao 明道 v${pkg.version}`, [
    `模型  ${modelName}${preset?.label ? '（' + preset.label + '）' : ''}`,
    `权限  ${permission.mode} · 密钥  ${keySource}`,
    `沙箱  ${sandboxLabel}${routing ? ` · 路由  ${routing.planner}⇄${routing.executor}` : ''}`,
    wsNow ? `工作空间  ${wsNow.name}（${wsNow.dir}）` : '',
  ].filter(Boolean));
  io.print(style('输入问题开始对话 · /help 查看命令 · Tab 补全 · Ctrl+C 中断生成\n', C.dim));

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
  let autoTitled = Boolean(session.messages?.length);
  const stats = { turns: 0, promptTokens: 0, completionTokens: 0 };
  io.setHistory(messages.filter((m) => m.role === 'user').map((m) => m.content));

  async function switchToModel(target, { silent = false } = {}) {
    try {
      const npc = resolveProviderConfig(cfg, target);
      if (!npc.apiKey) {
        io.print(style('该模型没有可用的 API Key，请先运行 mingdao init 配置。', C.red));
        return false;
      }
      const newProvider = await createProvider(cfg, target);
      provider = newProvider;
      modelName = target;
      cfg.model = target;
      saveConfig(cfg);
      agent = createAgent({
        provider,
        permission,
        io,
        modelName,
        workingDir,
        cfg,
        undoStore: sessionUndoStore,
        mcp: mcpFacade,
        onCompact: (msgs) => {
          rewriteSession(session.file, msgs);
          persisted = msgs.length;
        },
      });
      messages[0] = { role: 'system', content: buildSystemPrompt({ modelName, workingDir, withJournal }) };
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
      if (cmd === '/exit' || cmd === '/quit') break;
      else if (cmd === '/help') printHelpLines(io.print);
      else if (cmd === '/clear') {
        messages = [{ role: 'system', content: systemPrompt }];
        persisted = 0;
        io.print('已清空上下文。');
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
        let summary = '';
        try {
          summary = await compactContext(provider, modelName, messages);
        } catch (err) {
          io.print(style('[压缩失败] ' + (err?.message || err), C.red));
        }
        io.stopSpinner();
        if (!summary) continue;
        messages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: '[此前对话摘要]\n' + summary }];
        appendMessages(session.file, [{ role: 'system', content: '── /compact 压缩点 ──' }, ...messages.slice(1)]);
        persisted = messages.length;
        io.print(style('✓ 已压缩上下文（完整历史保留在会话文件中）。', C.green));
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
        io.print(
          style(
            `累计费用估算：≈¥${estimateCost(modelName, stats.promptTokens, stats.completionTokens).toFixed(5)}（↑${stats.promptTokens} / ↓${stats.completionTokens} tokens · 按当前模型计价 · 未计缓存折扣）`,
            C.dim
          )
        );
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
    }

    // 自动路由：规划类任务切 planner，执行类走 executor
    if (routingEnabled) {
      const route = await routeTask({ cfg, provider, currentModel: modelName, text: input });
      if (route.model !== modelName) {
        const okSwitch = await switchToModel(route.model, { silent: true });
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
      recordUsage(modelName, res.usage);
      stats.promptTokens += res.usage.prompt_tokens || 0;
      stats.completionTokens += res.usage.completion_tokens || 0;
      const fresh = messages.slice(persisted);
      appendMessages(session.file, fresh);
      persisted = messages.length;
      if (!autoTitled && cfg.autoTitle !== false && res.text) {
        autoTitled = true;
        const title = await generateTitle(provider, titleModel(cfg, modelName), input);
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
  io.print('再见，明道与你同行。');
  io.close();
}

main().catch((err) => {
  console.error('[MingDao] ' + (err?.message || err));
  if (process.env.MINGDAO_DEBUG) console.error(err);
  process.exit(1);
});
