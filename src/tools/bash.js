// bash 工具：在子进程中执行 shell 命令，超时强杀，输出截断。
// 沙箱模式（Linux + bubblewrap）：
//   off      直接执行（默认，兼容原有行为）
//   readonly 全盘只读 + /tmp 可写（tmpfs），网络可用
//   safe     只读文件系统 + 断网（unshare-net），工作目录可写 + /tmp 可写
// 非 Linux 或未安装 bwrap 时自动降级为 off，并在结果中注明（不静默假装沙箱）。

import { spawn, spawnSync } from 'node:child_process';

const MAX_OUTPUT = 20000;
const MAX_TIMEOUT_SECONDS = 600;

// 敏感环境变量过滤（P1-5 + 评估 P2-3）：默认常开——模型驱动的命令不应直接读到 API Key/凭证
// （一条 env 即可泄露），与沙箱档位解耦；config.bashEnvKeep 按名放行，config.bashEnvFilter=false
// 整体关闭（回到完全透传）。
const SENSITIVE_ENV_PAIR = /(api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key)/i;
const SENSITIVE_ENV_SEGMENT = /(^|_)(token|secret|password|passwd|credential|authorization|auth)(_|$)/i;
const isSensitiveEnv = (/** @type {any} */ k) => SENSITIVE_ENV_PAIR.test(k) || SENSITIVE_ENV_SEGMENT.test(k);

function buildChildEnv(/** @type {any} */ ctx, /** @type {any} */ filterSensitive) {
  if (!filterSensitive) return process.env;
  const keep = new Set((ctx?.cfg?.bashEnvKeep || []).map(String));
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!isSensitiveEnv(k) || keep.has(k)) (/** @type {any} */ (env))[k] = v;
  }
  return env;
}

let /** @type {any} */ sandboxSupport = null;

export function detectSandbox() {
  if (/** @type {any} */ sandboxSupport !== null) return /** @type {any} */ sandboxSupport;
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

// 输出折叠（审计 MiniMax §3.3-E / v0.1.48 P1-G）：模型回填的 bash 输出先折叠再截断——
// 1) 剥离 ANSI 转义序列（CSI/OSC）；2) 连续重复行（>3 行相同）折叠为「首行 + 重复标记」。
// npm install 类输出通常 30-50KB → 折叠后 5-10KB，单次工具回填省 60-70% prompt token。
function stripAnsi(/** @type {any} */ s) {
  return s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
}
function foldRepeats(/** @type {any} */ s) {
  const lines = s.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    let j = i;
    while (j + 1 < lines.length && lines[j + 1] === lines[i]) j += 1;
    const run = j - i + 1;
    if (run > 3) {
      out.push(lines[i], `…（以上重复 ${run} 行，已折叠）`);
      i = j + 1;
    } else {
      out.push(lines[i]);
      i += 1;
    }
  }
  return out.join('\n');
}
function tail(/** @type {any} */ s, /** @type {any} */ n) {
  const folded = foldRepeats(stripAnsi(s));
  return folded.length > n ? `…[输出过长，已截断头部]\n${folded.slice(-n)}` : folded;
}

export function runBash(/** @type {any} */ args, /** @type {any} */ ctx) {
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
      env: buildChildEnv(ctx, ctx?.cfg?.bashEnvFilter !== false), // 默认过滤敏感变量（评估 P2-3，与沙箱档位解耦）
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // 自成进程组：超时/结束可整组清理，孙进程不成孤儿
    });
    let out = '';
    let err = '';
    let done = false;
    let timedOut = false;
    // 输出增量截断：超长输出只保留尾部，避免内存无限累积
    const cap = (/** @type {any} */ s, /** @type {any} */ d) => {
      const t = s + d;
      return t.length > MAX_OUTPUT * 2 ? t.slice(-MAX_OUTPUT * 2) : t;
    };
    const killGroup = (/** @type {any} */ sig) => {
      try {
        process.kill(-(/** @type {any} */ (child)).pid, sig);
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
    // 兜底：close 可能因孙进程持有管道而延迟——先杀整组再收尾；
    // 只有真正超时（timer 已触发）才标 timedOut，正常完成绝不误标（审计 P1-2）
    const forceTimer = setTimeout(() => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      killGroup('SIGKILL');
      resolve({
        ok: true,
        exitCode: timedOut ? 124 : 0,
        timedOut,
        sandbox,
        note: timedOut ? '命令超时，已强杀进程组' : '输出管道未释放，已清理子进程组',
        stdout: tail(out, MAX_OUTPUT),
        stderr: tail(err, MAX_OUTPUT),
      });
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
