// bash 工具：在子进程中执行 shell 命令，超时强杀，输出截断。
// 沙箱模式（Linux + bubblewrap）：
//   off      直接执行（默认，兼容原有行为）
//   readonly 全盘只读 + /tmp 可写（tmpfs），网络可用
//   safe     只读文件系统 + 断网（unshare-net），工作目录可写 + /tmp 可写
// 非 Linux 或未安装 bwrap 时自动降级为 off，并在结果中注明（不静默假装沙箱）。

import { spawn, spawnSync } from 'node:child_process';

const MAX_OUTPUT = 20000;
const MAX_TIMEOUT_SECONDS = 600;

let sandboxSupport = null;

export function detectSandbox() {
  if (sandboxSupport !== null) return sandboxSupport;
  sandboxSupport = 'none';
  if (process.platform === 'linux') {
    try {
      const r = spawnSync('bwrap', ['--version'], { stdio: 'ignore', timeout: 3000 });
      sandboxSupport = r.error ? 'none' : 'bwrap';
    } catch {
      sandboxSupport = 'none';
    }
  }
  return sandboxSupport;
}

function tail(s, n) {
  return s.length > n ? `…[输出过长，已截断头部]\n${s.slice(-n)}` : s;
}

export function runBash(args, ctx) {
  const command = String(args.command ?? '');
  if (!command.trim()) return { ok: false, error: 'command 参数为空。' };
  const timeoutSec = Math.min(Number(args.timeout) || 120, MAX_TIMEOUT_SECONDS);
  // 配置优先：模型不能通过传 sandbox:'off' 自行降级（配置里选了 safe/readonly 就必须沙箱）
  const mode = String(ctx?.cfg?.sandbox ?? args.sandbox ?? 'off');
  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';
  const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command];

  let spawnCmd = shell;
  let spawnArgs = shellArgs;
  let sandbox = 'off';
  let note = '';

  if (mode !== 'off' && process.platform === 'linux' && detectSandbox() === 'bwrap') {
    const base = [
      '--die-with-parent',
      '--new-session',
      '--ro-bind', '/', '/',
      '--dev', '/dev',
      '--proc', '/proc',
      '--tmpfs', '/tmp',
    ];
    if (mode === 'safe') {
      // 工作目录可写 + /tmp 可写 + 断网
      base.push('--bind', ctx.cwd, ctx.cwd, '--unshare-net');
    } else {
      // readonly：工作目录也只读
      base.push('--ro-bind', ctx.cwd, ctx.cwd);
    }
    base.push('--chdir', ctx.cwd, '--', '/bin/bash', '-lc', command);
    spawnCmd = 'bwrap';
    spawnArgs = base;
    sandbox = mode;
  } else if (mode !== 'off') {
    note = `沙箱模式 "${mode}" 不可用（需要 Linux + bubblewrap），已降级为直接执行。`;
    sandbox = 'off';
  }

  return new Promise((resolve) => {
    const child = spawn(spawnCmd, spawnArgs, {
      cwd: ctx.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // 自成进程组：超时/结束可整组清理，孙进程不成孤儿
    });
    let out = '';
    let err = '';
    let done = false;
    let timedOut = false;
    // 输出增量截断：超长输出只保留尾部，避免内存无限累积
    const cap = (s, d) => {
      const t = s + d;
      return t.length > MAX_OUTPUT * 2 ? t.slice(-MAX_OUTPUT * 2) : t;
    };
    const killGroup = (sig) => {
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {}
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGKILL');
    }, timeoutSec * 1000);
    // 兜底：某些平台 close 可能因孙进程持有管道而延迟，exit 后强制收尾
    const forceTimer = setTimeout(() => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: true, exitCode: 124, timedOut: true, sandbox, note: '进程已强杀（超时或管道未释放）', stdout: tail(out, MAX_OUTPUT), stderr: tail(err, MAX_OUTPUT) });
    }, timeoutSec * 1000 + 3000);

    child.stdout.on('data', (d) => {
      out = cap(out, d);
    });
    child.stderr.on('data', (d) => {
      err = cap(err, d);
    });
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      resolve({ ok: false, error: `无法启动进程：${e.message}`, sandbox });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      resolve({
        ok: true,
        exitCode: code,
        timedOut,
        sandbox,
        note: note || undefined,
        stdout: tail(out, MAX_OUTPUT),
        stderr: tail(err, MAX_OUTPUT),
      });
    });
  });
}
