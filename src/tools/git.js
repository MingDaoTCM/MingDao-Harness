// git 只读工具（v0.3.1）：只允许只读子命令（status/log/diff/show/blame/rev-parse/branch/tag/ls-files/shortlog），
// 经 execFile 无 shell 执行（防注入），运行于 ctx.workingDir，输出与退出码结构化返回。
import { execFile } from 'node:child_process';

const GIT_READONLY = new Set(['status', 'log', 'diff', 'show', 'blame', 'rev-parse', 'branch', 'tag', 'ls-files', 'shortlog']);
// P1-8（v0.4.5）：参数级过滤——此前只校验子命令首词，`diff --no-index` 可越界读任意文件（git∈
// READONLY_TOOLS 免权限确认）、`branch -D`/`tag -f/-d` 破坏元数据、`--output` 写文件全部放行。
const BANNED_FLAGS = new Set(['--no-index', '--output', '-o', '--delete', '-D', '-d', '--force', '-f', '-m', '--move', '-M', '--rename']);

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
  // P1-8（v0.4.5）：拒绝破坏性/越界 flag——`--no-index` 越界读、`--output` 写、`-D/-d/-f/-m` 破坏元数据
  const banned = argv.find((/** @type {string} */ a) => BANNED_FLAGS.has(a) || a.startsWith('--output='));
  if (banned) {
    return { ok: false, error: `git ${sub} 含被禁止的参数 ${banned}——只读工具不允许写文件/越界读/破坏元数据（写操作请用 bash）。` };
  }
  // 追加默认防超大输出：log/diff 限量（除非模型显式给了 -n/--max-count）——
  // v0.4.1 P2 修复：此前注释声明限量但无实现，git log -p 在大型仓库会撞 maxBuffer 4MB 报 ENOBUFS。
  let effectiveArgv = argv;
  if ((sub === 'log' || sub === 'shortlog') && !argv.some((/** @type {string} */ a) => /^-(n|\d+)$/.test(a) || a === '--max-count')) {
    effectiveArgv = [...argv, '-n', '50'];
  } else if (sub === 'diff' && !argv.some((/** @type {string} */ a) => a === '--stat')) {
    // diff 全量可能极巨：默认 --stat 概览，模型需要全文再显式加 --no-stat 或指定文件
    effectiveArgv = [...argv, '--stat'];
  }
  const cwd = ctx.workingDir || process.cwd();
  try {
    const { stdout, stderr } = await execFile('git', effectiveArgv, {
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
