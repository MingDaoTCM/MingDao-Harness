// 变异 fail-safe 的「开跑前自检」入口（v0.6.17）：
//
//   node test/mutate/check.mjs                 # 扫描残留：能自愈的自愈，冲突/在飞则拒绝
//   node test/mutate/check.mjs --allow-dirty   # 允许在脏工作树（src/**、test/**）上跑
//
// 三种结论：
//   ① 干净（或陈旧标记已清）            → 退出 0，可以开跑；
//   ② 文件仍等于我们写下的补丁（to）    → **自动还原成原文**，打印「已自愈 N 处残留变异」，退出 0；
//   ③ 文件既不是 to 也不是原文 / 标记损坏 / pid 还活着的"在飞" → **拒绝运行**并列出清单，退出 1。
//
// 事故背景（两次）：① 变异在飞时被扫描误报成"残留"（所以 pid 存活的标记**绝不碰**）；
// ② 进程被强杀后补丁留在工作树里、看起来像"有意改动"（所以补丁与原文都存进标记，用内容判据自愈）。
// 本文件同时给 `run.mjs` 复用：preflight() 是纯函数（假定调用方已持锁），CLI 会自己抢锁。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { repoRoot, scanResidue, acquireLock, installCleanup } from './lib.mjs';

/**
 * `src/**`、`test/**` 里未提交的改动（排除本工具目录 `test/mutate/`，它自己就是被开发的对象）。
 * 返回 null 表示这里不是 git 工作树 / 没有 git（跳过检查，不当成错误）。
 */
export function dirtyChanges(root = repoRoot) {
  const r = spawnSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'src', 'test'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (r.error || r.status !== 0) return null;
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => ({ code: line.slice(0, 2), file: line.slice(3).replace(/^"|"$/g, '') }))
    .filter((e) => e.file && !e.file.startsWith('test/mutate/'));
}

/**
 * 开跑前自检（**不抢锁**：调用方必须已经持锁，避免"两个 check 同时自愈"）。
 * @returns {{ok: boolean, healed: string[], stale: string[], conflicts: any[], inflight: any[], dirty: {code: string, file: string}[]}}
 */
export function preflight({ root = repoRoot, allowDirty = false } = {}) {
  const scan = scanResidue({ root, mode: 'check' });
  const { healed, stale, conflicts, inflight } = scan;
  if (stale.length) console.log(`[mutate] 清理了 ${stale.length} 个已还原的陈旧标记：${stale.join('、')}`);
  for (const c of conflicts) {
    console.log(`✗ 残留标记与工作树冲突：${c.file}`);
    console.log(`    原因：${c.reason}`);
    if (c.currentSha) console.log(`    指纹：当前 ${c.currentSha} / 补丁 ${c.patchedSha} / 原文 ${c.originalSha}`);
    console.log(`    标记：${c.markerPath}`);
  }
  for (const i of inflight) {
    console.log(`✗ 有变异仍在飞（pid ${i.pid}，启动于 ${i.startedAt || '未知'}）：${i.file}`);
    console.log(`    它可能正在跑；先确认该进程，再处理标记 ${i.markerPath}`);
  }
  if (conflicts.length || inflight.length) {
    console.log(
      `\n[mutation] 拒绝运行：${conflicts.length} 处冲突、${inflight.length} 处仍在飞。` +
        '\n          请人工处理上述文件/标记后重试（先看文件内容再决定删不删标记，别让"有意改动"混进补丁）。'
    );
    return { ok: false, healed, stale, conflicts, inflight, dirty: [] };
  }

  const dirty = dirtyChanges(root);
  if (dirty === null) {
    console.log('[mutate] 脏工作树检查跳过（这里不是 git 工作树，或没有 git）');
  } else if (dirty.length) {
    console.log(`\n[mutate] 工作树有 ${dirty.length} 处未提交改动（src/**、test/**；已排除 test/mutate/）：`);
    for (const d of dirty) console.log(`  ${d.code} ${d.file}`);
    if (!allowDirty) {
      console.log(
        '[mutate] 拒绝在脏工作树上跑变异：变异会把文件改写成补丁再写回，脏改动一旦被碰过就无法区分' +
          '\n          "用户的有意改动"与"残留变异"（这正是事故②差点发版的原因）。确认无碍后加 --allow-dirty 再跑。'
      );
      return { ok: false, healed, stale, conflicts, inflight, dirty };
    }
    console.log('[mutate] 已按 --allow-dirty 继续（上面的改动不会被本工具回滚）。');
  } else {
    console.log('[mutate] 工作树干净（src/**、test/**）');
  }
  return { ok: true, healed, stale, conflicts, inflight, dirty: dirty || [] };
}

const USAGE = `用法：
  node test/mutate/check.mjs                 扫描并自愈残留标记；冲突/在飞则拒绝
  node test/mutate/check.mjs --allow-dirty   允许在脏工作树（src/**、test/**）上跑
退出码：0 = 可开跑（含"已自愈"），1 = 拒绝运行，2 = 参数错误`;

export function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const unknown = argv.filter((a) => a.startsWith('-') && a !== '--allow-dirty');
  if (unknown.length) {
    console.log(`✗ 未知参数：${unknown.join(' ')}\n\n${USAGE}`);
    return 2;
  }
  const allowDirty = argv.includes('--allow-dirty');
  let lock;
  try {
    // check 是**显式自愈入口**：owner 记录的 pid 已死时允许立即接管（否则 SIGKILL 后要等
    // 15 分钟才能清残留）。它仍不碰 pid 存活、或 owner 读不到（mkdir→node 空窗）的锁；
    // run.mjs 走严格两条件（见 lib.mjs 的 acquireLock）。
    lock = acquireLock({ root: repoRoot, reclaimDeadOwner: true });
  } catch (e) {
    console.log(`✗ ${e.message}`);
    return 1;
  }
  installCleanup({ root: repoRoot, lock });
  try {
    const res = preflight({ root: repoRoot, allowDirty });
    if (!res.ok) return 1;
    console.log('[mutate] 自检通过。');
    return 0;
  } finally {
    lock.release();
  }
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    // macOS 的 /var → /private/var 是符号链接：argv[1] 与 import.meta.url 可能一个带 /var、
    // 一个带 /private/var（selfcheck 在 /tmp 下跑，正好踩到）。必须比 realpath，不能比字面量。
    return fs.realpathSync(path.resolve(entry)) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) process.exit(main());
