// bash 工具：在子进程中执行 shell 命令，超时强杀，输出截断。

import { spawn } from 'node:child_process';

const MAX_OUTPUT = 20000;
const MAX_TIMEOUT_SECONDS = 600;

function tail(s, n) {
  return s.length > n ? `…[输出过长，已截断头部]\n${s.slice(-n)}` : s;
}

export function runBash(args, ctx) {
  const command = String(args.command ?? '');
  if (!command.trim()) return { ok: false, error: 'command 参数为空。' };
  const timeoutSec = Math.min(Number(args.timeout) || 120, MAX_TIMEOUT_SECONDS);
  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';
  const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command];

  return new Promise((resolve) => {
    const child = spawn(shell, shellArgs, {
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
      resolve({ ok: false, error: `无法启动进程：${e.message}` });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        ok: true,
        exitCode: code,
        timedOut,
        stdout: tail(out, MAX_OUTPUT),
        stderr: tail(err, MAX_OUTPUT),
      });
    });
  });
}
