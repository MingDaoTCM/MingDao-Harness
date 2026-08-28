// 多会话后台任务面板：mingdao run 启动独立 worker 子进程，状态落盘 <mingdao-home>/tasks/<id>.json。
// 命令族：mingdao run "<任务>" · mingdao tasks · tasks watch · tasks kill <id>
// worker 复用 Agent 核心（权限/模型/MCP/自动标题/会话持久化全部生效）。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { relativeTime } from './session.js';
import { atomicWriteFileSync, withFileLockSync } from './atomic-write.js';

const CLI_PATH = fileURLToPath(new URL('./cli.js', import.meta.url));

export function tasksDir(home) {
  return path.join(home, 'tasks');
}

export function listTasks(home) {
  const dir = tasksDir(home);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (t && t.id) out.push(t);
    } catch {}
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

export function readTask(home, id) {
  if (!isValidTaskId(id)) return null; // 防 id 路径穿越（id 直接拼进文件路径）
  try {
    return JSON.parse(fs.readFileSync(path.join(tasksDir(home), id + '.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function writeTask(home, task) {
  fs.mkdirSync(tasksDir(home), { recursive: true });
  // 原子写：先临时文件再改名，避免崩溃留下半截 JSON
  const target = path.join(tasksDir(home), task.id + '.json');
  atomicWriteFileSync(target, JSON.stringify(task, null, 2) + '\n'); // 质检 H4：tmp 名含 pid+随机
}

export function isValidTaskId(id) {
  return typeof id === 'string' && /^[a-z0-9]+$/.test(id) && id.length >= 4 && id.length <= 40;
}

export function startTask(home, question, { permission, model, cwd, offpeak, quietNotify } = /** @type {any} */ ({})) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + process.pid.toString(36);
  const task = {
    id,
    status: 'running',
    question: String(question).slice(0, 80),
    startedAt: Date.now(),
    pid: null,
    session: null,
    text: '',
    usage: null,
    durationMs: null,
    error: '',
    note: offpeak ? '避峰：高峰时段顺延到最近闲时（12:00 / 18:00）执行（省 50%）' : '',
  };
  writeTask(home, task);
  const args = [CLI_PATH, 'run-worker', id, '--question', String(question)];
  if (permission) args.push('--permission', permission);
  if (model) args.push('--model', model);
  if (offpeak) args.push('--offpeak');
  const child = spawn(process.execPath, args, {
    cwd: cwd || process.cwd(),
    detached: true,
    stdio: 'ignore',
    // 连续失败的重试轮次静默：只保留首次失败的系统通知，避免右下角刷屏（审计）
    env: { ...process.env, MINGDAO_HOME: home, ...(quietNotify ? { MINGDAO_TASK_QUIET_NOTIFY: '1' } : {}) },
  });
  // 质检 M12：spawn 失败（ENOENT/ARG_MAX）必须有 error 监听，否则未捕获事件直接崩进程
  child.on('error', (err) => {
    try {
      patchTask(home, id, { status: 'failed', error: `worker 启动失败：${err?.message || err}`, durationMs: Date.now() - task.startedAt });
    } catch {}
  });
  task.pid = child.pid;
  writeTask(home, task);
  child.unref();
  return task;
}

export function patchTask(home, id, patch) {
  // 质检 H3：读-改-写加锁（worker finish 与 CLI kill 互斥，防 killed/done 互相覆盖）
  return withFileLockSync(path.join(tasksDir(home), '.lock'), () => {
    const t = readTask(home, id);
    if (!t) return;
    writeTask(home, { ...t, ...patch });
  });
}

export function killTask(home, id) {
  if (!isValidTaskId(id)) return false;
  // 质检 H3：读-改-写加锁（与 worker 自身的状态写互斥）
  return withFileLockSync(path.join(tasksDir(home), '.lock'), () => killTaskInner(home, id));
}
function killTaskInner(home, id) {
  const t = readTask(home, id);
  if (!t) return false;
  if (t.status === 'running' && t.pid) {
    // 质检 M11：cmdline 含任务 id 才 kill（防 PID 复用误杀无关进程）
    let owned = null;
    try {
      owned = fs.readFileSync(`/proc/${t.pid}/cmdline`, 'utf8').includes(id);
    } catch {}
    if (owned !== false) {
      try {
        // worker 是 detached 进程（自成进程组）：优先杀整组，避免工具子进程成孤儿
        process.kill(-t.pid, 'SIGTERM');
      } catch {
        try {
          process.kill(t.pid, 'SIGTERM');
        } catch {}
      }
    }
  }
  patchTask(home, id, { status: 'killed', durationMs: t.durationMs ?? Date.now() - t.startedAt });
  return true;
}

const MARK = { running: '▶', done: '✓', failed: '✖', killed: '■' };

export function formatTaskRow(t) {
  const mark = MARK[t.status] || '?';
  const elapsed =
    t.status === 'running'
      ? relativeTime(t.startedAt).replace('前', '')
      : t.durationMs != null
        ? `${(t.durationMs / 1000).toFixed(1)}s`
        : '';
  const session = t.session ? path.basename(t.session) : '';
  const note = t.note ? `（${t.note}）` : '';
  return `${mark} ${t.id}  ${elapsed.padEnd(6)}  ${session.padEnd(24)}  ${t.question}${note}`;
}
