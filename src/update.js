// 自更新模块（零运行时依赖：仅 node:child_process 调用 git）。
// 安装形态：仓库 + 全局符号链接（mingdao 命令即指向 repo/src/cli.js，仓库更新 = 命令更新）。
//   mingdao update          拉取最新远端 main → 跑冒烟测试 → 失败自动回滚
//   mingdao update --check  只 fetch 对比版本，不改动工作区
//   mingdao rollback        回滚到上次成功 update 之前的提交（~/.mingdao/update-state.json 记录）
// npm 安装形态（无 .git）给出对应提示。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mingdaoHome, ensureHome } from './config.js';
import { atomicWriteFileSync } from './atomic-write.js';
import { decideEgress, currentPolicy } from './net-guard.js';

/**
 * 对「内核发起的 git 联网操作」做一次出网判定（v0.6.0 C3 补漏）。
 * 解析出真正要联系的远端 URL（显式远端名 → 该远端 URL；未指明 → 全部远端），
 * 逐个过闸门；block 模式下若**全部**远端都不在白名单内则拒绝执行。
 * 之所以是「全部都不在白名单才拒」：多镜像部署（github/gitee/gitcode）里只要有一个可达即可，
 * 拒绝整个操作会因为一个未列入的镜像而挡住本可成功的升级。
 * 返回类型必须写实（不能用 any）：否则 git() 的推断类型会被 any 吞掉，
 * 导致 `st.out.split('\n').map((l) => …)` 这类回调参数变成隐式 any（noImplicitAny 报错）。
 * @returns {{ok: boolean, out: string, err: string, error: undefined, egressBlocked: boolean} | null} 被拒绝时返回与 git() 同形的结果；放行返回 null
 */
function egressCheckGitRemote(/** @type {any} */ cwd, /** @type {any} */ args) {
  if (!currentPolicy()?.enabled) return null;
  try {
    const named = args.find((/** @type {any} */ a, /** @type {number} */ i) => i > 0 && !String(a).startsWith('-') && /^[A-Za-z0-9._-]+$/.test(String(a)) && !['FETCH_HEAD', 'HEAD'].includes(String(a)));
    const remotes = named ? [named] : listRemotes(cwd);
    if (!remotes.length) return null;
    const urls = [];
    for (const r of remotes) {
      const u = gitRaw(['remote', 'get-url', r], cwd);
      if (u) urls.push(u);
    }
    if (!urls.length) return null;
    const verdicts = urls.map((u) => ({ url: u, d: decideEgress(u) }));
    if (verdicts.some((v) => v.d.allowed)) return null; // 至少一个远端在白名单内 → 放行
    return {
      ok: false,
      out: '',
      err: `出网被拦截：自更新要联系的远端（${verdicts.map((v) => v.d.host).join(', ')}）都不在 config.net.allow 白名单内（mode=block）`,
      error: undefined,
      egressBlocked: true,
    };
  } catch {
    return null; // 判定过程出错时不阻断升级（与其它调用点同款容错）
  }
}

/** 不经过闸门判定的原始 git 调用（仅用于读取远端 URL 这类本地元数据操作） */
function gitRaw(/** @type {any} */ args, /** @type {any} */ cwd) {
  try {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 });
    return r.status === 0 && !r.error ? String(r.stdout || '').trim() : '';
  } catch {
    return '';
  }
}

function git(/** @type {any} */ args, /** @type {any} */ cwd) {
  // v0.6.0 C3 自查：`git fetch/pull` 是**内核发起**的出网（内核决定去联系远端），
  // 但它走子进程网络栈，**绕过** globalThis.fetch 闸门。此前文档只提到「bash 里用户自己敲的
  // curl 不走闸门」，却漏了这条内核自己的路径——对「数据不出门」的自证来说，这是过度声明。
  // 这里把远端 URL 先过一遍闸门：策略为 block 且远端不在白名单时直接拒绝联网。
  if (args[0] === 'fetch' || args[0] === 'pull' || args[0] === 'ls-remote' || args[0] === 'clone') {
    const v = egressCheckGitRemote(cwd, args);
    if (v) return v;
  }
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120000 });
  return {
    ok: r.status === 0 && !r.error,
    out: String(r.stdout || '').trim(),
    err: String(r.stderr || '').trim(),
    egressBlocked: undefined,
    error: r.error,
  };
}

// 定位仓库根：全局安装 = 符号链接到仓库，realpath 拿到真实路径后向上找 .git
export function findRepoRoot() {
  try {
    let dir = path.dirname(fs.realpathSync(process.argv[1] || fileURLToPath(import.meta.url)));
    for (let i = 0; i < 12; i++) {
      if (fs.existsSync(path.join(dir, '.git'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {}
  return null;
}

function resolveRepo(/** @type {any} */ override) {
  return override || findRepoRoot();
}

function versionAt(/** @type {any} */ repo, ref = 'HEAD') {
  const r = git(['show', `${ref}:package.json`], repo);
  if (!r.ok) return null;
  try {
    return JSON.parse(r.out).version || null;
  } catch {
    return null;
  }
}

function compareVersions(/** @type {any} */ a, /** @type {any} */ b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

function stateFile() {
  return path.join(mingdaoHome(), 'update-state.json');
}
function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return null;
  }
}
function writeState(/** @type {any} */ s) {
  ensureHome();
  atomicWriteFileSync(stateFile(), JSON.stringify(s, null, 2) + '\n', { mode: 0o600 }); // 质检 H4：更新状态原子写
}

// 直接向远端指定分支要版本（评估 D6）：fetch 到 FETCH_HEAD 再读 package.json，
// 不依赖本地 refs 落盘——部分 Windows git 环境存在「fetch 成功但 refs 不更新」的异常，
// 按本地 refs 判断会误报「已是最新」。ls-remote 思路的等价实现。
function remoteVersion(/** @type {any} */ repo, /** @type {any} */ remote, /** @type {any} */ branch) {
  const r = git(['fetch', '--quiet', remote, branch], repo);
  // 把「被出网闸门拦下」与「网络失败」区分开往上传：两者的用户动作完全不同
  // （前者去改 config.net.allow 或接受不升级；后者去查网络）。
  if (!r.ok) return { version: null, blocked: r.egressBlocked ? String(r.err) : null };
  return { version: versionAt(repo, 'FETCH_HEAD'), blocked: null };
}

function listRemotes(/** @type {any} */ repo) {
  const r = git(['remote'], repo);
  if (!r.ok) return [];
  return r.out.split('\n').filter(Boolean);
}

// 各远端（main/master 任一存在）中版本号最大的（多镜像部署：github/gitee/gitcode 谁新跟谁）
function newestRemote(/** @type {any} */ repo) {
  let latest = '';
  let ref = '';
  /** @type {any} */
  let egressBlocked = null;
  let attempts = 0;
  for (const remote of listRemotes(repo)) {
    for (const branch of ['main', 'master']) {
      attempts += 1;
      const r = remoteVersion(repo, remote, branch);
      if (r.blocked) egressBlocked = r.blocked;
      if (r.version && compareVersions(r.version, latest) > 0) {
        latest = r.version;
        ref = `${remote}/${branch}`;
      }
    }
  }
  // 只在「确实一次都没成功、且至少一次是被闸门拦下」时上报拦截，避免误导
  if (!latest && egressBlocked) return { version: latest, ref, egressBlocked, attempts };
  return { version: latest, ref, egressBlocked: null, attempts };
}

const NPM_HINT =
  '✖ 未找到 git 仓库（npm 或源码包安装形态）：npm 安装用 `npm update -g mingdao-harness`；' +
  '源码包安装请重新运行安装脚本（install.sh）；或从任意平台仓库克隆后 `npm link`：' +
  'https://gitee.com/MingDaoTCM/MingDao-harness · https://gitcode.com/MingDaoTCM/MingDao-Harness · https://github.com/MingDaoTCM/MingDao-Harness';

export async function updateCheck({ repo } = /** @type {any} */ ({})) {
  const lines = [];
  const root = resolveRepo(repo);
  if (!root) return { ok: false, lines: [NPM_HINT] };
  const local = versionAt(root) || '未知';
  const newest = newestRemote(root);
  if (!newest.version) {
    // 区分「网络不通」与「被出网白名单拦下」：后者不是故障而是策略生效，
    // 若混进「请检查网络」会让人去排查网络，而正确动作是改 config.net.allow（或就此接受不升级）。
    if (newest.egressBlocked) {
      return {
        ok: false,
        lines: [`当前版本 v${local}`, `✖ ${newest.egressBlocked}`, '（这是出网白名单在生效，不是网络故障；如需升级请把远端加入 config.net.allow）'],
      };
    }
    return { ok: false, lines: [`当前版本 v${local}`, '✖ 无法连接远端（git fetch 全部失败），请检查网络。'] };
  }
  if (compareVersions(newest.version, local) <= 0) {
    return { ok: true, behind: false, lines: [`当前已是最新版本 v${local} ✓`, '（如需升级：mingdao update）'] };
  }
  return {
    ok: true,
    behind: true,
    lines: [`当前版本 v${local}`, `发现新版本 v${newest.version}（${newest.ref}）`, '执行 mingdao update 一键升级（升级后自动跑冒烟测试，失败自动回滚）。'],
  };
}

export async function mingdaoUpdate({ repo } = /** @type {any} */ ({})) {
  const lines = [];
  const root = resolveRepo(repo);
  if (!root) return { ok: false, lines: [NPM_HINT] };
  const local = versionAt(root) || '未知';
  // 工作区必须干净：升级不动用户未提交的改动（--ff-only 也会因此拒绝）
  const st = git(['status', '--porcelain'], root);
  if (!st.ok) return { ok: false, lines: ['✖ git status 失败：' + (st.err || st.error?.message || '未知错误')] };
  if (st.out) {
    return {
      ok: false,
      lines: ['✖ 仓库有未提交改动，请先提交/暂存后再升级：', ...st.out.split('\n').slice(0, 5).map((l) => '  ' + l)],
    };
  }
  const prev = git(['rev-parse', 'HEAD'], root);
  if (!prev.ok) return { ok: false, lines: ['✖ 无法读取当前提交（git rev-parse HEAD）'] };
  const newest = newestRemote(root);
  if (!newest.version) return { ok: false, lines: ['✖ git fetch 失败：无法连接远端'] };
  if (compareVersions(newest.version, local) <= 0) {
    return { ok: true, lines: [`当前已是最新版本 v${local} ✓（远端最新 v${newest.version}）`] };
  }
  // 从版本号最新的远端快进拉取（远程名/分支：优先当前分支名，回落 main）
  const remoteName = newest.ref.split('/')[0];
  const curBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], root);
  const branch = ['main', 'master'].includes(curBranch.out) ? curBranch.out : 'main';
  const pull = git(['pull', '--ff-only', '--quiet', remoteName, branch], root);
  if (!pull.ok) {
    return {
      ok: false,
      lines: [`✖ 升级失败（git pull --ff-only ${remoteName} ${branch}）：${pull.err || '本地分支与远端分叉，请先手动处理'}`, '未改动任何文件。'],
    };
  }
  const newVer = versionAt(root) || '未知';
  // 升级后冒烟验证：失败自动回滚到升级前提交，绝不让坏版本常驻
  const smoke = spawnSync(process.execPath, [path.join(root, 'test', 'smoke.js')], { cwd: root, encoding: 'utf8', timeout: 300000 });
  // 审计 P2-9：spawn 失败（脚本缺失/进程崩溃）与测试非零区分——只有测试真实跑完且失败才回滚
  if (smoke.error) {
    return {
      ok: false,
      lines: [`✖ 升级已完成，但冒烟测试无法运行：${smoke.error?.message || smoke.error}`, `  已保持在 v${newVer}（未回滚，因为不是测试失败）。`],
    };
  }
  if (smoke.status !== 0) {
    git(['reset', '--hard', prev.out], root);
    const tail = String(smoke.stdout || smoke.stderr || '')
      .split('\n')
      .filter(Boolean)
      .slice(-3)
      .join(' | ');
    return {
      ok: false,
      lines: [
        `✖ 升级后冒烟测试失败，已自动回滚到 ${prev.out.slice(0, 8)}（v${local}）。`,
        '  失败信息：' + (tail || '（无输出）'),
        '  当前仍是升级前的可用版本；请反馈该问题。',
      ],
    };
  }
  writeState({ prevSha: prev.out, prevVersion: local, at: Date.now() });
  return {
    ok: true,
    lines: [`✓ 已从 v${local} 升级到 v${newVer}`, '✓ 冒烟测试通过；如遇问题可 mingdao rollback 回滚到升级前版本。'],
  };
}

export function mingdaoRollback({ repo } = /** @type {any} */ ({})) {
  const root = resolveRepo(repo);
  if (!root) return { ok: false, lines: [NPM_HINT] };
  const st = readState();
  if (!st?.prevSha) {
    return { ok: false, lines: ['✖ 没有可回滚的记录（只有成功 update 后才会写入回滚点）。'] };
  }
  const dirty = git(['status', '--porcelain'], root);
  if (!dirty.ok) return { ok: false, lines: ['✖ git status 失败'] };
  if (dirty.out) return { ok: false, lines: ['✖ 仓库有未提交改动，请先提交/暂存（回滚会覆盖工作区改动）。'] };
  const cur = git(['rev-parse', 'HEAD'], root);
  if (cur.ok && cur.out === st.prevSha) {
    return { ok: false, lines: ['当前已在回滚目标提交上，无需回滚。'] };
  }
  const r = git(['reset', '--hard', st.prevSha], root);
  if (!r.ok) return { ok: false, lines: ['✖ 回滚失败：' + (r.err || 'git reset --hard 出错')] };
  const v = versionAt(root) || '未知';
  try {
    fs.unlinkSync(stateFile());
  } catch {}
  return {
    ok: true,
    lines: [`✓ 已回滚到 v${v}（${st.prevSha.slice(0, 8)}，即 v${st.prevVersion || v} 升级前的提交）`],
  };
}
