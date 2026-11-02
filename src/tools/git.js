// git 只读工具（v0.3.1）：只允许**只读**子命令与**已登记**的只读参数，经 execFile 无 shell 执行（防注入），
// 运行于 ctx.workingDir，输出与退出码结构化返回。
//
// v0.6.30（C2，报告三 C-06）：**白名单化 + 写形态出清**。此前两处失守：
//   ① `blame` 在只读白名单内，而参数黑名单不含 `--contents`——`git blame --contents /etc/passwd` 能
//      把**仓库外**任意文件的内容读出来（实测读出 /tmp 下的密钥文件）；
//   ② `branch <名>` / `tag <名>` 是**写操作**（创建 ref），却因为没有参数就免询问直接执行。
// 根因与 `--no-index` 同类：**参数黑名单永远追不上 git 的参数空间**。现在反过来：
//   · 子命令：显式白名单（写类子命令 add/commit/push/stash/remote… 一律不在此列）；
//   · 参数：**每个子命令一张允许表**（长选项精确名 + 短选项字母，含取值规则）；未登记者一律拒绝；
//   · 黑名单只作为**兜底**保留（`--contents` / `--output` / `--no-index` / `--ext-diff` / `--textconv`
//     等等越界读、写文件、执行外部程序的选项），并按 git 的唯一前缀缩写双向匹配；
//   · `branch` / `tag` 只保留**列出现有 ref** 的形态（无操作数或 `--list` 等过滤），
//     任何会创建/移动/删除 ref 的形态直接拒绝并说明原因；
//   · 所有被拒调用都返回**可见原因**（哪个子命令/哪个参数、为什么、该改用 bash 并显式授权）。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// P1 修复（v0.4.6）：execFile 是回调式 API、返回 ChildProcess（不是 thenable）——直接 await 得到的
// 是 ChildProcess 对象，解构出的 stdout/stderr 其实是两个可读流，于是工具恒返回
// `ok:true exitCode:0 output:"[object Object][object Object]"`：不等待、不报错，退出码 / ENOENT /
// maxBuffer / timeout 全部被吞。git 属 READONLY_TOOLS（免权限确认）且 schema 反复推荐给模型，
// 等于该工具 100% 失效，还让模型把「不是 git 仓库 / 版本号不存在 / 仓库损坏」都当成成功。
const execFileAsync = promisify(execFile);

/**
 * 允许的只读子命令。写类子命令（add/commit/push/pull/fetch/merge/rebase/reset/checkout/switch/
 * restore/clean/stash/remote/worktree/submodule/gc/update-ref…）**不在**这里：
 * 它们会改动仓库状态，必须走 bash 并逐次授权。
 *
 * `branch` / `tag` 留在集合里但只允许「列出」形态（见 readOnlyRefFormError）——
 * `git branch` / `git tag` 本身是查看 ref 的常用只读查询，而创建/移动/删除 ref 的形态被拦下。
 */
const GIT_READONLY = new Set(['status', 'log', 'diff', 'show', 'blame', 'rev-parse', 'ls-files', 'shortlog', 'branch', 'tag']);

// 兜底黑名单（白名单之外的第二道，只用来在文案里点名"这个参数的危害"）。
// P1-8（v0.4.5）：`--no-index` 越界读、`--output` 写文件、`-D/-d/-f/-m` 破坏元数据。
// v0.6.2（自评报告 P2-3）：长选项必须按**前缀**判定（git 接受唯一前缀缩写：`--no-inde` == `--no-index`）。
// v0.6.30（C2）：补 `contents`（blame 读仓库外文件）、`ext-diff`/`textconv`（会执行外部程序）、
// `ignore-revs-file`（读仓库外文件）。
const BANNED_LONG = ['no-index', 'output', 'delete', 'force', 'move', 'rename', 'contents', 'ext-diff', 'textconv', 'ignore-revs-file'];

/** 每个子命令允许的长选项（精确名，不接受缩写——缩写是安全边界上的歧义来源）。
 * @type {Record<string, string[]>} */
const ALLOWED_LONG = {
  status: ['short', 'porcelain', 'branch', 'verbose', 'long', 'ignored', 'untracked-files', 'no-renames', 'renames', 'show-stash', 'column', 'no-column', 'ahead-behind', 'no-ahead-behind', 'null'],
  log: ['oneline', 'graph', 'decorate', 'no-decorate', 'all', 'branches', 'tags', 'remotes', 'stat', 'shortstat', 'numstat', 'name-only', 'name-status', 'format', 'pretty', 'abbrev-commit', 'no-abbrev-commit', 'abbrev', 'date', 'author', 'committer', 'grep', 'since', 'until', 'before', 'after', 'max-count', 'skip', 'patch', 'no-patch', 'merges', 'no-merges', 'first-parent', 'follow', 'reverse', 'topo-order', 'date-order', 'author-date-order', 'relative-date', 'raw', 'compact-summary', 'summary', 'encoding', 'notes', 'no-notes', 'left-right', 'cherry-pick', 'boundary', 'find-renames', 'find-copies', 'find-copies-harder', 'diff-filter', 'ignore-space-change', 'ignore-all-space', 'ignore-blank-lines', 'ignore-cr-at-eol', 'ignore-space-at-eol', 'word-diff', 'word-diff-regex', 'unified', 'src-prefix', 'dst-prefix', 'no-prefix', 'text', 'binary', 'no-renames', 'full-history', 'simplify-merges', 'ancestry-path', 'source', 'use-mailmap', 'mailmap', 'no-mailmap', 'show-signature', 'decorate-refs', 'decorate-refs-exclude', 'default', 'no-walk', 'walk-reflogs'],
  diff: ['stat', 'numstat', 'shortstat', 'name-only', 'name-status', 'cached', 'staged', 'patch', 'no-patch', 'unified', 'word-diff', 'word-diff-regex', 'color', 'no-color', 'exit-code', 'quiet', 'raw', 'compact-summary', 'summary', 'diff-filter', 'find-renames', 'find-copies', 'find-copies-harder', 'ignore-space-change', 'ignore-all-space', 'ignore-blank-lines', 'ignore-cr-at-eol', 'ignore-space-at-eol', 'relative', 'src-prefix', 'dst-prefix', 'no-prefix', 'text', 'binary', 'abbrev', 'no-renames', 'check', 'no-ext-diff', 'no-textconv', 'submodule', 'ignore-submodules', 'ita-invisible-in-index'],
  show: ['oneline', 'stat', 'shortstat', 'numstat', 'name-only', 'name-status', 'format', 'pretty', 'abbrev-commit', 'no-abbrev-commit', 'abbrev', 'date', 'patch', 'no-patch', 'notes', 'no-notes', 'diff-filter', 'find-renames', 'find-copies', 'unified', 'word-diff', 'src-prefix', 'dst-prefix', 'no-prefix', 'text', 'binary', 'raw', 'compact-summary', 'summary', 'encoding', 'decorate', 'no-decorate', 'reflog', 'show-signature', 'first-parent', 'no-ext-diff', 'no-textconv'],
  blame: ['porcelain', 'line-porcelain', 'incremental', 'show-name', 'show-number', 'show-email', 'root', 'date', 'abbrev', 'encoding', 'ignore-rev', 'reverse', 'first-parent', 'color-lines', 'color-by-age', 'no-color'],
  'rev-parse': ['verify', 'short', 'abbrev-ref', 'symbolic', 'symbolic-full-name', 'git-dir', 'absolute-git-dir', 'show-toplevel', 'show-prefix', 'show-cdup', 'is-inside-work-tree', 'is-inside-git-dir', 'is-bare-repository', 'is-shallow-repository', 'all', 'branches', 'tags', 'remotes', 'not', 'default', 'sq-quote', 'revs-only', 'no-revs', 'flags', 'no-flags', 'path-format', 'show-superproject-working-tree', 'show-object-format', 'resolve-git-dir', 'local-env-vars', 'shared-index-path', 'git-path'],
  'ls-files': ['stage', 'cached', 'deleted', 'modified', 'others', 'ignored', 'exclude-standard', 'exclude', 'directory', 'no-empty-directory', 'error-unmatch', 'full-name', 'recurse-submodules', 'with-tree', 'eol', 'format', 'deduplicate', 'unmerged', 'killed', 'sparse'],
  shortlog: ['summary', 'numbered', 'email', 'format', 'group', 'no-group', 'wrap', 'since', 'until', 'committer', 'author', 'all', 'no-merges', 'merges', 'reverse'],
  branch: ['list', 'all', 'remotes', 'verbose', 'show-current', 'contains', 'no-contains', 'merged', 'no-merged', 'points-at', 'sort', 'format', 'column', 'no-column', 'color', 'no-color', 'omit-empty', 'no-abbrev', 'abbrev'],
  tag: ['list', 'contains', 'no-contains', 'merged', 'no-merged', 'points-at', 'sort', 'format', 'column', 'no-column', 'color', 'no-color', 'omit-empty', 'ignore-case', 'verify', 'no-column'],
};

/** 每个子命令允许的短选项字母；值 `true` 表示该字母**接收值**（`-n5` 或 `-n 5` 都合法）。
 * @type {Record<string, Record<string, boolean>>} */
const ALLOWED_SHORT = {
  status: { s: false, b: false, v: false, u: false, z: false },
  log: { n: true, p: false, s: false, u: true, U: true, M: false, C: false, z: false, m: false, e: false },
  diff: { p: false, s: false, u: true, U: true, M: false, C: false, R: false, z: false, a: false, b: false, w: false },
  show: { s: false, p: false, u: true, U: true, M: false, C: false, z: false },
  blame: { L: true, l: false, n: false, s: false, e: false, w: false, f: false, t: false, M: false, C: false },
  'rev-parse': { q: false },
  'ls-files': { s: false, c: false, d: false, m: false, o: false, i: false, x: true, z: false, t: false },
  shortlog: { s: false, n: false, e: false, w: true, c: false },
  branch: { a: false, r: false, v: false, l: false },
  tag: { l: false, n: true, v: false, i: false },
};

/** 所有子命令都允许的「加严/只读」长选项（关掉外部程序、颜色等，不改变读语义）。 */
const COMMON_ALLOWED_LONG = ['no-ext-diff', 'no-textconv'];

/** `branch` / `tag` 中「带值即说明操作数是被查询的 rev/模式，而不是要新建的 ref 名」的选项。 */
const REF_QUERY_VALUE_FLAGS = new Set(['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format', '--column', '--decorate-refs']);

/**
 * 该参数是否命中兜底黑名单（长选项双向**前缀**匹配，兼容 git 的唯一前缀缩写）。
 * 极短缩写（如 `--n`）会被一并拦下：只读工具里这类写法本就不该出现，方向 fail-closed。
 * @param {any} a
 */
function isBannedFlag(/** @type {any} */ a) {
  const s = String(a ?? '');
  if (!s.startsWith('--') || s === '--') return false;
  const name = s.slice(2).split('=')[0];
  // v0.6.30（C2）：`--no-ext-diff` / `--no-textconv` 是**关闭**外部程序的只读选项，必须先放行，
  // 否则「以 no- 开头的都像 ext-diff」会把它们误拦（方向反了：这是加严选项）。
  if (name === 'no-ext-diff' || name === 'no-textconv') return false;
  if (!name) return false;
  return BANNED_LONG.some((b) => b.startsWith(name) || name.startsWith(b));
}

/**
 * 单个 token 是否属于该子命令的**已登记**只读参数。
 * 长选项要求精确名（可带 `=value`）；短选项可捆绑，取值型字母后面的部分算值。
 * @param {string} sub @param {string} tok
 */
function isAllowedOption(/** @type {string} */ sub, /** @type {string} */ tok) {
  if (tok === '--') return true;
  if (tok.startsWith('--')) {
    const name = tok.slice(2).split('=')[0];
    return COMMON_ALLOWED_LONG.includes(name) || (ALLOWED_LONG[sub] || []).includes(name);
  }
  if (!tok.startsWith('-') || tok === '-') return false;
  // v0.6.30：`git log -3` / `git shortlog -10` 是 `-n <数字>` 的常用简写，按白名单放行。
  if (/^-\d+$/.test(tok)) return sub === 'log' || sub === 'shortlog';
  const chars = tok.slice(1);
  const spec = ALLOWED_SHORT[sub] || {};
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (!Object.prototype.hasOwnProperty.call(spec, c)) return false;
    if (spec[c]) return true; // 取值型：后面的字符/下一个参数是值
  }
  return true;
}

/**
 * `branch` / `tag` 的**写形态**判定：返回错误文案（非空 = 拒绝），或 null（允许）。
 *
 * 允许的只有「列出/查询现有 ref」：没有操作数，或带 `--list` 一类过滤选项，
 * 或带需要 rev/模式的查询选项（`--contains HEAD`、`--sort=-creatordate`）。
 * 其它有操作数的形态（`branch <名>` / `tag <名>`）就是**创建 ref**——写操作，必须走 bash 授权。
 * @param {string[]} argv 已含子命令的完整 argv
 */
function readOnlyRefFormError(/** @type {string[]} */ argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  /** @type {string[]} */
  const operands = [];
  let listMode = false;
  let queryValue = false;
  let sawSeparator = false;
  for (const tok of rest) {
    if (tok === '--') {
      sawSeparator = true;
      continue;
    }
    if (!sawSeparator && tok.startsWith('-') && tok !== '-') {
      if (tok === '-l' || tok === '--list') listMode = true;
      if (REF_QUERY_VALUE_FLAGS.has(tok.split('=')[0])) queryValue = true;
      continue;
    }
    operands.push(tok);
  }
  if (!operands.length || listMode || queryValue) return null;
  return (
    `git ${sub} ${operands.join(' ')} 属于**写操作**（创建/修改 ref），已**被禁止**：` +
    `只读工具只允许列出现有 ref（例如 git ${sub} -a / git ${sub} --list）。` +
    `确需创建请用 bash 并显式授权（会弹确认）。`
  );
}

export async function runGit(/** @type {any} */ args, /** @type {any} */ ctx) {
  const command = String(args.command ?? '').trim();
  if (!command) {
    return { ok: false, error: `缺少 command 参数。只读子命令：${[...GIT_READONLY].join(' / ')}` };
  }
  const argv = command.split(/\s+/).filter(Boolean);
  const sub = argv[0];
  if (!GIT_READONLY.has(sub)) {
    return {
      ok: false,
      error:
        `git ${sub} 不是只读子命令（仅支持 ${[...GIT_READONLY].join(' / ')}）。` +
        `写操作（add/commit/push/stash/remote…）会改仓库状态，请用 bash 并注意授权。`,
    };
  }
  // ① 兜底黑名单：越界读 / 写文件 / 执行外部程序的高危参数（含前缀缩写）
  if (sub === 'blame' && argv.some((a) => /^--contents(=|$)/.test(a))) {
    return {
      ok: false,
      error:
        `git blame --contents 会读取**仓库外的任意文件**（越界读），只读工具已拒绝该参数；` +
        `如确需读取该文件，请用 read 工具或 bash（需显式授权）。`,
    };
  }
  const banned = argv.find(isBannedFlag);
  if (banned) {
    return {
      ok: false,
      error:
        `git ${sub} 含被禁止的参数 ${banned}——只读工具不允许写文件/越界读/执行外部程序/破坏元数据` +
        `（写操作请用 bash 并显式授权）。`,
    };
  }
  // ② 参数白名单：未登记的**选项**一律拒绝（不再靠黑名单兜底）。
  // 操作数（rev / 路径 / pathspec / 选项的取值）不参与白名单——它们不是选项，
  // 由 git 自己解析；越界读写由 ① 的黑名单与子命令白名单负责。
  for (const tok of argv.slice(1)) {
    if (!tok.startsWith('-') || tok === '-') continue;
    if (!isAllowedOption(sub, tok)) {
      return {
        ok: false,
        error:
          `git ${sub} 的参数 ${tok} 不在只读白名单内（被禁止）：只读工具只接受已登记的只读参数，` +
          `写/越界/未登记的参数请用 bash 并显式授权。`,
      };
    }
  }
  // ③ branch / tag：只允许「列出现有 ref」
  if (sub === 'branch' || sub === 'tag') {
    const bad = readOnlyRefFormError(argv);
    if (bad) return { ok: false, error: bad };
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
    const { stdout, stderr } = await execFileAsync('git', effectiveArgv, {
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
