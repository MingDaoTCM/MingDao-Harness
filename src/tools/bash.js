// bash 工具：在子进程中执行 shell 命令，超时强杀，输出截断。
// 沙箱模式（Linux + bubblewrap）：
//   off      直接执行（默认，兼容原有行为）
//   readonly 全盘只读 + /tmp 可写（tmpfs），网络可用
//   safe     只读文件系统 + 断网（unshare-net），工作目录可写 + /tmp 可写
// 非 Linux 或未安装 bwrap 时自动降级为 off，并在结果中注明（不静默假装沙箱）。

import { spawn, spawnSync } from 'node:child_process';
import { spawnOpts } from '../proc.js';

const MAX_OUTPUT = 20000;
const MAX_TIMEOUT_SECONDS = 600;

// 敏感环境变量过滤（P1-5 + 评估 P2-3）：默认常开——模型驱动的命令不应直接读到 API Key/凭证
// （一条 env 即可泄露），与沙箱档位解耦；config.bashEnvKeep 按名放行，config.bashEnvFilter=false
// 整体关闭（回到完全透传）。
const SENSITIVE_ENV_PAIR = /(api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key)/i;
const SENSITIVE_ENV_SEGMENT = /(^|_)(token|secret|password|passwd|credential|authorization|auth)(_|$)/i;
// 审计 P3-6（v0.4.2）：导出供 hooks.js 复用——hook 子进程 env 与 bash 工具同口径过滤敏感变量。
// P3 修复（v0.4.6）：SSH_AUTH_SOCK 会被 `(^|_)auth(_|$)` 段规则误判为敏感变量而剥离，导致
// bash 工具里 git-over-SSH / ssh-agent 全部失效（macOS 常态：push/pull 走 SSH 时必用）。
// 它是**连接句柄**而非凭据，显式放行；其余变量的过滤语义不变。
const ENV_ALWAYS_KEEP = new Set(['SSH_AUTH_SOCK']);
export const isSensitiveEnv = (/** @type {any} */ k) =>
  !ENV_ALWAYS_KEEP.has(String(k)) && (SENSITIVE_ENV_PAIR.test(k) || SENSITIVE_ENV_SEGMENT.test(k));

// 审计修复（v0.4.6）：导出供 config.tools 子进程复用——此前它是唯一不筛敏感变量的子进程入口
// （bash / hooks / MCP 都筛），与全项目「默认剥离 *_API_KEY/*_TOKEN/*_SECRET」口径不一致。
export function buildChildEnv(/** @type {any} */ ctx, /** @type {any} */ filterSensitive) {
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
      // v0.4.1 P1 修复：实际能力探测而非仅 --version——bwrap 存在但 /proc 挂载受限（Docker/devcontainer/
      // CI 流水线等容器环境）时 --version 能跑、真正建沙箱却失败。用最小真实沙箱命令验证：
      // --ro-bind / / --tmpfs /tmp true 能成功退出 0 才算可用，否则降级 none（runBash 会注明降级）。
      const v = spawnSync('bwrap', ['--version'], { stdio: 'ignore', timeout: 3000 });
      if (v.error) {
        sandboxSupport = 'none';
      } else {
        const probe = spawnSync('bwrap', ['--die-with-parent', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', 'true'], { stdio: 'ignore', timeout: 5000 });
        sandboxSupport = probe.error || probe.status !== 0 ? 'none' : 'bwrap';
      }
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
/**
 * 子进程输出解码：**一次**解整段字节，而不是逐块 `toString()`。
 *
 * 两处乱码根因（v0.6.3，桌面版实测）：
 *   ① 逐块解码：中文 3 字节被管道切成两半 → 两半各自解出 U+FFFD；
 *   ② Windows 上本工具走 `cmd.exe /d /s /c`，输出是 OEM 代码页（中文 = GBK/CP936），
 *      按 UTF-8 解就是花屏。故严格 UTF-8 失败时用 GBK 再解一次。
 * 导出的目的是让这两类乱码能被**确定性**测到——②只在 Windows 出现，CI 上跑不出真环境。
 * @param {Buffer} buf
 */
export function decodeProcessOutput(buf) {
  if (!buf || !buf.length) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      return buf.toString('utf8');
    }
  }
}

/**
 * 子进程输出采集器（**导出以便确定性测试**）。
 *
 * 为什么单独成一个原语：乱码的两个根因都藏在这里，而"端到端跑一个大输出"根本测不准——
 * 输出上限（约 60KB）比一个管道块（64KB）还小，保留的尾部常常落在**单块之内**，
 * 跨块解码的缺陷于是照样通过（第一版回归就是这么假绿的，靠变异验证才发现）。
 * 把 push/text 暴露出来，测试就能**人工把汉字切成两半**喂进去。
 *
 * @param {number} maxBytes 只保留尾部这么多字节（超出丢弃头部）
 */
export function createOutputCapture(maxBytes) {
  /** @type {{chunks: Buffer[], bytes: number}} */
  const st = { chunks: [], bytes: 0 };
  const snapBoundary = () => {
    // **对齐到字符边界**：按字节裁会把 UTF-8 从字符中间切断，于是"整段严格解码"必然失败
    // → 误触发 GBK 回退 → 反而解成花屏（本修复第一版的真实缺陷，被单测抓出来的）。
    // UTF-8 的续字节形如 10xxxxxx，丢掉它们即可让缓冲区从**前导字节**开始。
    while (st.chunks.length && st.chunks[0].length && (st.chunks[0][0] & 0xc0) === 0x80) {
      st.chunks[0] = st.chunks[0].subarray(1);
      st.bytes -= 1;
      if (!st.chunks[0].length) st.chunks.shift();
    }
  };
  return {
    /** @param {Buffer} d */
    push(d) {
      st.chunks.push(d);
      st.bytes += d.length;
      while (st.bytes > maxBytes && st.chunks.length) {
        const first = st.chunks[0];
        const drop = Math.min(first.length, st.bytes - maxBytes);
        if (drop >= first.length) {
          st.chunks.shift();
          st.bytes -= first.length;
        } else {
          st.chunks[0] = first.subarray(drop);
          st.bytes -= drop;
        }
      }
      snapBoundary();
    },
    /** 结束时**一次**解码整段字节（绝不能逐块 toString：会把汉字劈成 U+FFFD） */
    text() {
      return st.chunks.length ? decodeProcessOutput(Buffer.concat(st.chunks)) : '';
    },
    get bytes() {
      return st.bytes;
    },
  };
}

function tail(/** @type {any} */ s, /** @type {any} */ n) {
  const folded = foldRepeats(stripAnsi(s));
  if (folded.length <= n) return folded;
  let t = folded.slice(-n);
  // 不要把**代理对**劈成两半：BMP 以外的字符（emoji 等）被切一半会渲染成 U+FFFD。
  // 与 context.js 的同类问题同源（登记簿 BUG-079）。
  const c0 = t.charCodeAt(0);
  if (c0 >= 0xdc00 && c0 <= 0xdfff) t = t.slice(1);
  return `…[输出过长，已截断头部]\n${t}`;
}

export function runBash(/** @type {any} */ args, /** @type {any} */ ctx) {
  const command = String(args.command ?? '');
  if (!command.trim()) return { ok: false, error: 'command 参数为空。' };
  const timeoutSec = Math.min(Number(args.timeout) || 120, MAX_TIMEOUT_SECONDS);
  // 配置优先：模型不能通过传 sandbox:'off' 自行降级（配置里选了 safe/readonly 就必须沙箱）
  // 审计 P3-9（v0.4.2）：cfg.sandbox=''（空串）时 ?? 不触发，mode 为空串落入 readonly 沙箱分支——
  // || 'off' 归一化空串回默认 off。
  const mode = String(ctx?.cfg?.sandbox ?? args.sandbox ?? 'off') || 'off';
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
      detached: true, // POSIX：自成进程组，超时/结束可整组清理，孙进程不成孤儿
      ...spawnOpts({ piped: true }), // Windows：不 detach + 隐藏控制台（否则每次命令弹一个终端）
    });
    // v0.6.3（桌面版 bash 输出乱码，两处根因）：
    //   ① **不能逐块 `toString()`**：中文 3 字节，被管道切成两半时两半各自解出 U+FFFD（乱码）。
    //      改为按 **Buffer** 累积、结束时**一次**解码。
    //   ② **Windows 上这里走的是 `cmd.exe /d /s /c`**，其输出是 OEM 代码页（中文 = GBK/CP936），
    //      按 UTF-8 解就是花屏（"回访"→"»Ø·Ã"）。故严格 UTF-8 解失败时用 GBK 再解一次。
    //      Node 官方构建带 full-icu，`new TextDecoder('gbk')` 可用；不支持时退回非严格 UTF-8。
    const MAX_BYTES = MAX_OUTPUT * 2; // 按字节预留（中文 1 字 ≈ 3 字节）
    const outCap = createOutputCapture(MAX_BYTES);
    const errCap = createOutputCapture(MAX_BYTES);
    let done = false;
    let timedOut = false;
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
        stdout: tail(outCap.text(), MAX_OUTPUT),
        stderr: tail(errCap.text(), MAX_OUTPUT),
      });
    }, timeoutSec * 1000 + 3000);

    child.stdout.on('data', (d) => outCap.push(d));
    child.stderr.on('data', (d) => errCap.push(d));
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
        stdout: tail(outCap.text(), MAX_OUTPUT),
        stderr: tail(errCap.text(), MAX_OUTPUT),
      });
    });
  });
}
