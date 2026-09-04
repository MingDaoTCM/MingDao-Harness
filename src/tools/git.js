// git 只读工具（v0.3.1）：只允许只读子命令（status/log/diff/show/blame/rev-parse/branch/tag/ls-files/shortlog），
// 经 execFile 无 shell 执行（防注入），运行于 ctx.workingDir，输出与退出码结构化返回。
import { execFile } from 'node:child_process';

const GIT_READONLY = new Set(['status', 'log', 'diff', 'show', 'blame', 'rev-parse', 'branch', 'tag', 'ls-files', 'shortlog']);

export async function runGit(/** @type {any} */ args, /** @type {any} */ ctx) {
  const command = String(args.command ?? '').trim();
  if (!command) {
    return { ok: false, error: `缺少 command 参数。只读子命令：${[...GIT_READONLY].join(' / ')}` };
  }
  const argv = command.split(/\s+/).filter(Boolean);
  const sub = argv[0];
  if (!GIT_READONLY.has(sub)) {
    return { ok: false, error: `git ${sub} 不是只读子命令（仅支持 ${[...GIT_READONLY].join(' / ')}）。写操作请用 bash 并注意授权。` };
  }
  // 追加默认防超大输出：log/diff 限量（除非模型显式给了 -n/--max-count）
  const cwd = ctx.workingDir || process.cwd();
  try {
    const { stdout, stderr } = await execFile('git', argv, {
      cwd,
      timeout: 15000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const out = String(stdout || '') + String(stderr || '');
    return { ok: true, exitCode: 0, output: out.trim() || '（无输出）' };
  } catch (/** @type {any} */ err) {
    const e = /** @type {any} */ (err);
    return { ok: false, error: String(e.stderr || e.message || err).trim(), exitCode: e.code };
  }
}
