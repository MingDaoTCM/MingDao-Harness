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
  const mode = String(args.sandbox || ctx?.cfg?.sandbox || 'off');
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
    });
    let out = '';
    let err = '';
    let done = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutSec * 1000);

    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, error: `无法启动进程：${e.message}`, sandbox });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
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
