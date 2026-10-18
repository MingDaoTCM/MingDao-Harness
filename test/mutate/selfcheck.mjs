// 变异 fail-safe 的自验（v0.6.17；v0.6.18 增加跨 worktree 全局锁 6 场景）：**用临时目录模拟整棵树**，
// 不碰真实工作树。
//
//   node test/mutate/selfcheck.mjs
//
// 场景（前三个是验收要求的三场景）：
//   ① 干净启动               → check 退出 0，无标记、无锁残留；
//   ② 模拟残留（标记 + 文件被改成 to） → check **自动还原成 from**，打印「已自愈 1 处残留变异」；
//   ③ 模拟冲突（文件被改成第三方内容） → check **拒绝**并打印清单，标记保留等人工；
//   ④ 在飞不被误治（pid 还活着）      → check 拒绝，文件/标记一个都不碰（事故①的回归）；
//   ⑤ 并发互斥（活锁）                → 第二个 mutator 被拒：「已有 mutator 在跑（pid N）」；
//   ⑥ 脏工作树                        → 默认拒绝并给清单；`--allow-dirty` 放行；
//   ⑦ SIGTERM（可捕获信号）           → 在途补丁被还原、标记与锁都清掉；
//   ⑧ SIGKILL（捕获不到）             → 标记 + 锁留下（这就是"残留"），下一次 check **自愈并清陈旧锁**。
//
// v0.6.18 新增（跨 worktree 全局锁，锁在 `os.tmpdir()/mingdao-mutate.lock/`）：
//   ⑨ 同进程重复获取 → 幂等（不报错、不丢锁；引用计数归零才真正释放）；
//   ⑩ 另一进程持锁（sleep 子进程 + 锁） → 第二个 **run.mjs** 被拒，提示含 pid 与 cwd；
//   ⑪ 陈旧锁（不存在的 pid + mtime 20 分钟前） → **接管并清理**；
//   ⑫ "锁很新、pid 已死" → **不接管**（mkdir→node 空窗的回归，今天踩过的坑）；
//   ⑬ SIGTERM 打在 run.mjs 上 → 锁被释放；
//   ⑭ 两个 worktree 目录同时跑 run.mjs → **只有一个进入**，另一个被拒并指出胜者的 cwd。
//
// 临时树的形状与真实仓库一致：`<tmp>/test/mutate/{lib,check,run}.mjs` + `<tmp>/src/demo.js`。
// 被复制过去的 lib.mjs 会把 `<tmp>` 当仓库根，所以这里跑的是**同一份代码**，不是替身。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  writePendingMarker,
  pendingDir,
  journalPath,
  normalizeEol,
  acquireLock,
  readLockOwner,
  lockOwnerPath,
  globalLockDir,
} from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const LIB_SRC = path.join(here, 'lib.mjs');
const CHECK_SRC = path.join(here, 'check.mjs');
const RUN_SRC = path.join(here, 'run.mjs');

// 自验用独立锁目录：全局锁是跨 worktree 的，若直接复用真锁，跑 selfcheck 会跟本机正在跑的
// 变异互相干扰（甚至把别人拒掉）。被测进程通过环境变量继承同一个临时目录。
const TEST_LOCK_DIR = path.join(os.tmpdir(), `mingdao-mutate-selfcheck-${process.pid}.lock`);
process.env.MINGDAO_MUTATE_LOCK_DIR = TEST_LOCK_DIR;

const FROM = 'const MODE = "ORIGINAL";';
const TO = 'const MODE = "MUTATED";';
// 原始文件故意用 CRLF：自愈必须**字节级**还原（Windows 工作树就是 CRLF），不能统一写成 LF。
const ORIGINAL = 'const MODE = "ORIGINAL";\r\nconst TAIL = 1;\r\n';
const PATCHED = normalizeEol(ORIGINAL).replace(FROM, TO);
const THIRD_PARTY = 'const MODE = "THIRD-PARTY";\nconst TAIL = 1;\n';

const roots = [];
const failed = [];

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mutate-selfcheck-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'test', 'mutate'), { recursive: true });
  fs.copyFileSync(LIB_SRC, path.join(root, 'test', 'mutate', 'lib.mjs'));
  fs.copyFileSync(CHECK_SRC, path.join(root, 'test', 'mutate', 'check.mjs'));
  fs.copyFileSync(RUN_SRC, path.join(root, 'test', 'mutate', 'run.mjs'));
  fs.writeFileSync(path.join(root, 'src', 'demo.js'), ORIGINAL);
  roots.push(root);
  return root;
}

const checkPath = (root) => path.join(root, 'test', 'mutate', 'check.mjs');
const runPath = (root) => path.join(root, 'test', 'mutate', 'run.mjs');
const demoPath = (root) => path.join(root, 'src', 'demo.js');
const read = (root) => fs.readFileSync(demoPath(root), 'utf8');
const markers = (root) => {
  try {
    return fs.readdirSync(pendingDir(root)).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
};
const runCheck = (root, args = []) =>
  spawnSync(process.execPath, [checkPath(root), ...args], { cwd: root, encoding: 'utf8' });
const runMutator = (root, args = []) =>
  spawnSync(process.execPath, [runPath(root), ...args], { cwd: root, encoding: 'utf8' });

// ---------------------------------------------------------------------------
// 全局锁的测试辅助（路径来自被测的同一份 lib.mjs，不是另写一套判据）。
// ---------------------------------------------------------------------------
const lockDir = globalLockDir();
const lockExists = () => fs.existsSync(lockDir);
const lockOwner = () => readLockOwner(lockDir);
const clearLock = () => {
  fs.rmSync(lockDir, { recursive: true, force: true });
  const base = path.basename(lockDir);
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (name.startsWith(`${base}.stale-`) || name.startsWith(`${base}.takeover`)) {
        fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
      }
    }
  } catch {
    /* 清理尽力而为 */
  }
};

/**
 * 手工造一把锁：`pid` 可以是活进程、已死进程；`ageMs` 同时把锁目录 mtime 往前拨。
 * 这是**直接写锁**（模拟"别的进程/上次崩溃留下的锁"），不经过 acquireLock。
 */
function writeLock({ pid, cwd = roots[0], startedAt = new Date().toISOString(), ageMs = 0 }) {
  clearLock();
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(
    lockOwnerPath(lockDir),
    JSON.stringify({ v: 2, pid, startedAt, cwd, argv: ['simulated-mutator'], host: os.hostname() }, null, 2)
  );
  if (ageMs > 0) {
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(lockDir, t, t);
  }
}

function writeBatch(root, ms = 1200) {
  // run.mjs 按文件名里的 "hold" 过滤出这一批；批次本身只负责占住时间，让另一个 worktree 撞锁。
  fs.writeFileSync(
    path.join(root, 'test', 'mutate', 'batch-hold.mjs'),
    `console.log('batch-hold 进入');
const keepAlive = setInterval(() => {}, 1000);
setTimeout(() => clearInterval(keepAlive), ${ms});
`
  );
}

/** 拿一个**确定已死**的 pid（进程刚退出，标记里的 pid 存活判断必须返回 false）。 */
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  assert.ok(Number.isInteger(r.pid) && r.pid > 0, '拿不到已退出子进程的 pid');
  return r.pid;
}

function writeMarker(root, pid) {
  return writePendingMarker({
    root,
    file: 'src/demo.js',
    from: FROM,
    to: TO,
    originalRaw: ORIGINAL,
    patched: PATCHED,
    pid,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
  });
}

function waitFor(pred, ms, label) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let ok = false;
      try {
        ok = pred();
      } catch {
        ok = false;
      }
      if (ok) return resolve();
      if (Date.now() - started > ms) return reject(new Error(`等待超时：${label}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

function waitExit(child, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待子进程退出超时')), ms);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

/** 起一个"真的在跑 mutate"的子进程：run 里阻塞 1.2s，给我们时间发信号。 */
function startFlight(root) {
  const script = path.join(root, 'kill-child.mjs');
  fs.writeFileSync(
    script,
    `import { spawnSync } from 'node:child_process';
import { makeMutator } from './test/mutate/lib.mjs';
// 事件循环保活：Node 只在有活动句柄时才会派发排队的信号回调（否则脚本结束后直接退出 0）。
// 真实批次脚本也靠 process.on('exit') 兜底；这里保活是为了**确定性地**验证 SIGTERM 处理器。
const keepAlive = setInterval(() => {}, 1000);
const M = makeMutator({ quiet: true });
M.mutate({
  name: 'kill-sim',
  file: 'src/demo.js',
  from: ${JSON.stringify(FROM)},
  to: ${JSON.stringify(TO)},
  expect: ['never-caught'],
  run: () => spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 1200)'], { stdio: 'ignore' }),
});
// 保持事件循环存活直到收到信号（不能 clearInterval：一清掉句柄，排队的信号回调就会被丢弃，
// Node 会直接以 0 退出——那样测到的就不是 process.once 处理器了）。
`
  );
  const child = spawn(process.execPath, [script], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => {
    out += d;
  });
  child.stderr.on('data', (d) => {
    out += d;
  });
  return { child, out: () => out };
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function scenario(name, fn) {
  clearLock();
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    failed.push(name);
    console.log(`✗ ${name}\n    ${(e && e.message) || e}`);
  } finally {
    clearLock();
  }
}

// ---------------------------------------------------------------------------

await scenario('① 干净启动：无标记、无锁，check 通过', () => {
  const root = makeTree();
  const r = runCheck(root);
  assert.equal(r.status, 0, `check 应退出 0，实际 ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /自检通过/);
  assert.equal(markers(root).length, 0);
  assert.equal(lockExists(), false, 'check 结束后全局锁必须清掉');
});

await scenario('② 模拟残留：文件等于 to → 自动还原成 from（字节级）', () => {
  const root = makeTree();
  const pid = deadPid();
  writeMarker(root, pid);
  fs.writeFileSync(demoPath(root), PATCHED);
  assert.equal(markers(root).length, 1);

  const r = runCheck(root);
  assert.equal(r.status, 0, `应自愈后通过，实际 ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /已自愈 1 处残留变异/);
  assert.match(r.stdout, /src\/demo\.js/);
  assert.equal(read(root), ORIGINAL, '写回必须是原始字节（含 CRLF）');
  assert.equal(markers(root).length, 0, '自愈后标记必须删除');
  assert.equal(lockExists(), false);
  assert.match(fs.readFileSync(journalPath(root), 'utf8'), /"event":"heal"/);
});

await scenario('③ 模拟冲突：文件被改成第三方内容 → 拒绝并列出清单', () => {
  const root = makeTree();
  writeMarker(root, deadPid());
  fs.writeFileSync(demoPath(root), THIRD_PARTY);

  const r = runCheck(root);
  assert.equal(r.status, 1, `冲突必须非 0，实际 ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /拒绝运行/);
  assert.match(r.stdout, /src\/demo\.js/);
  assert.match(r.stdout, /第三方/);
  assert.equal(read(root), THIRD_PARTY, '冲突文件绝不能被改写');
  assert.equal(markers(root).length, 1, '冲突标记必须保留，等人工判断');
});

await scenario('④ 在飞标记（pid 存活）不被误当残留', () => {
  const root = makeTree();
  writeMarker(root, process.pid); // 本进程还活着 = 模拟"另一个 mutator 正在跑"
  fs.writeFileSync(demoPath(root), PATCHED);

  const r = runCheck(root);
  assert.equal(r.status, 1, `在飞必须拒绝，实际 ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /仍在飞/);
  assert.equal(read(root), PATCHED, '在飞文件不能被自愈写回（事故①）');
  assert.equal(markers(root).length, 1, '在飞标记不能被删');
});

await scenario('⑤ 并发互斥：活锁拒绝第二个 mutator', () => {
  const root = makeTree();
  writeLock({ pid: process.pid, cwd: root });

  const r = runCheck(root);
  assert.equal(r.status, 1, `活锁必须拒绝，实际 ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, new RegExp(`已有 mutator 在跑（pid ${process.pid}`));
  assert.equal(lockExists(), true, '活锁不能被第二个进程删掉');
  assert.equal(lockOwner().pid, process.pid);
});

await scenario('⑥ 脏工作树：默认拒绝，--allow-dirty 放行', () => {
  const root = makeTree();
  const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  const probe = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    console.log('    （本机没有 git，跳过脏工作树场景）');
    return;
  }
  assert.equal(git(['init', '-q']).status, 0);
  assert.equal(git(['add', 'src/demo.js']).status, 0);
  const commit = git(['-c', 'user.name=selfcheck', '-c', 'user.email=selfcheck@example.invalid', 'commit', '-qm', 'init']);
  assert.equal(commit.status, 0, `git commit 失败：${commit.stderr}`);
  fs.appendFileSync(demoPath(root), '// local edit\n');

  const denied = runCheck(root);
  assert.equal(denied.status, 1, `脏工作树必须默认拒绝，实际 ${denied.status}\n${denied.stdout}${denied.stderr}`);
  assert.match(denied.stdout, /--allow-dirty/);
  assert.match(denied.stdout, /src\/demo\.js/);

  const allowed = runCheck(root, ['--allow-dirty']);
  assert.equal(allowed.status, 0, `--allow-dirty 应放行，实际 ${allowed.status}\n${allowed.stdout}${allowed.stderr}`);
  assert.match(allowed.stdout, /已按 --allow-dirty 继续/);
});

await scenario('⑦ SIGTERM：在途补丁还原、标记与锁清掉', async () => {
  const root = makeTree();
  const { child, out } = startFlight(root);
  await waitFor(() => out().includes('变异进行中') && read(root) === PATCHED, 8000, '变异进入在途状态');
  assert.equal(markers(root).length, 1, '在途时必须有标记（强杀后靠它）');

  child.kill('SIGTERM');
  const { code } = await waitExit(child, 15000);
  assert.equal(code, 143, `SIGTERM 应走清理后退出 143，实际 ${code}`);
  assert.equal(read(root), ORIGINAL, 'SIGTERM 后工作树必须还原');
  assert.equal(markers(root).length, 0, 'SIGTERM 后标记必须清掉');
  assert.equal(lockExists(), false, 'SIGTERM 后锁必须清掉');
});

await scenario('⑧ SIGKILL：标记/锁留下 → check 自愈并清陈旧锁', async () => {
  const root = makeTree();
  const { child, out } = startFlight(root);
  await waitFor(() => out().includes('变异进行中') && read(root) === PATCHED, 8000, '变异进入在途状态');

  child.kill('SIGKILL');
  const { signal } = await waitExit(child, 15000);
  assert.equal(signal, 'SIGKILL', `应被 SIGKILL 杀死，实际 ${signal}`);
  assert.equal(read(root), PATCHED, 'SIGKILL 后补丁必然留在工作树（finally 不执行）');
  assert.equal(markers(root).length, 1, 'SIGKILL 后标记必须留下——这是残留的唯一凭据');
  assert.equal(lockExists(), true, 'SIGKILL 后锁是陈旧的（pid 已死）');

  // check 是显式自愈入口：owner 里记录的 pid 已死即可接管（否则要等 15 分钟）。
  const r = runCheck(root);
  assert.equal(r.status, 0, `check 应自愈后通过，实际 ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /已自愈 1 处残留变异/);
  assert.match(r.stdout, /清理陈旧锁/);
  assert.equal(read(root), ORIGINAL, '自愈必须还原原始字节');
  assert.equal(markers(root).length, 0);
  assert.equal(lockExists(), false);
});

// ---------------------------------------------------------------------------
// v0.6.18：跨 worktree 全局锁的 6 个场景。
// ---------------------------------------------------------------------------

await scenario('⑨ 同进程重复获取：幂等，引用计数归零才释放', () => {
  const root = makeTree();
  const h1 = acquireLock({ root });
  const h2 = acquireLock({ root }); // 同 pid：不能报「已有 mutator 在跑」
  assert.ok(h1 && h2, '同进程第二次获取必须放行');
  assert.equal(lockOwner().pid, process.pid);
  assert.equal(fs.realpathSync(lockOwner().cwd), fs.realpathSync(root), '锁里 cwd 必须是 worktree 根');

  assert.equal(h1.release(), false, '还有第二个句柄时不能真正释放');
  assert.equal(lockExists(), true, '引用计数未归零，锁必须还在');
  h2.release();
  assert.equal(lockExists(), false, '最后一个句柄释放后锁必须清掉');
  assert.equal(readLockOwner(lockDir), null);
});

await scenario('⑩ 另一进程持锁：第二个 run.mjs 被拒，提示含 pid 与 cwd', async () => {
  const holderRoot = makeTree();
  const contenderRoot = makeTree();
  const sleep = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    await waitFor(() => Number.isInteger(sleep.pid) && sleep.pid > 0, 5000, 'sleep 子进程启动');
    writeLock({ pid: sleep.pid, cwd: holderRoot });

    const r = runMutator(contenderRoot, []);
    assert.equal(r.status, 1, `第二个 run.mjs 必须被拒，实际 ${r.status}\n${r.stdout}${r.stderr}`);
    assert.match(
      r.stdout,
      new RegExp(`已有 mutator 在跑（pid ${sleep.pid}，cwd ${escapeRe(holderRoot)}，已运行 \\d+s）`),
      `提示必须含 pid 与 cwd，实际：\n${r.stdout}`
    );
    assert.equal(lockExists(), true, '活锁不能被第二个 run.mjs 删掉');
    assert.equal(lockOwner().pid, sleep.pid, '锁的 owner 不能被改写');
  } finally {
    sleep.kill('SIGKILL');
    await waitExit(sleep, 5000).catch(() => {});
  }
});

await scenario('⑪ 陈旧锁（死 pid + mtime 20 分钟前）：接管并清理', () => {
  const root = makeTree();
  const pid = deadPid();
  writeLock({ pid, cwd: root, startedAt: new Date(Date.now() - 20 * 60_000).toISOString(), ageMs: 20 * 60_000 });

  // 本树没有 batch 文件：run.mjs 抢到锁后打印「没有匹配的批次脚本」并以 1 退出——这里只验抢锁段。
  const r = runMutator(root, []);
  assert.equal(r.status, 1, `无批次应退出 1，实际 ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /清理陈旧锁并接管/, `两条件都满足时必须接管，实际：\n${r.stdout}`);
  assert.doesNotMatch(r.stdout, /已有 mutator 在跑/, '陈旧锁不能被当成活锁');
  assert.equal(lockExists(), false, 'run.mjs 退出后必须释放并清掉包装后的锁');
  assert.equal(
    fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(`${path.basename(lockDir)}.stale-`)).length,
    0,
    'tombstone 不能残留'
  );
});

await scenario('⑫ 锁很新但 pid 已死：不接管（mkdir→node 空窗回归）', () => {
  const root = makeTree();
  const pid = deadPid();
  writeLock({ pid, cwd: root, startedAt: new Date(Date.now() - 2_000).toISOString(), ageMs: 0 });
  const before = fs.readFileSync(lockOwnerPath(lockDir), 'utf8');

  const r = runMutator(root, []);
  assert.equal(r.status, 1, `必须拒绝，实际 ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, new RegExp(`已有 mutator 在跑（pid ${pid}`), `提示必须含 pid，实际：\n${r.stdout}`);
  assert.match(r.stdout, /未超过 15 分钟/, '必须说明"锁很新"是不接管的原因');
  assert.equal(lockExists(), true, '条件②不满足时绝不能接管/删除锁');
  assert.equal(fs.readFileSync(lockOwnerPath(lockDir), 'utf8'), before, '锁内容必须原封不动');
});

await scenario('⑬ SIGTERM 打在 run.mjs 上：锁被释放', async () => {
  const root = makeTree();
  writeBatch(root, 1500);
  const child = spawn(process.execPath, [runPath(root), 'hold'], { cwd: root, stdio: 'ignore' });
  try {
    await waitFor(() => {
      const owner = lockOwner();
      return owner && owner.pid === child.pid;
    }, 10000, 'run.mjs 拿到锁并进入批次');
    child.kill('SIGTERM');
    const { code } = await waitExit(child, 20000);
    assert.equal(code, 143, `SIGTERM 应走清理后退出 143，实际 ${code}`);
    assert.equal(lockExists(), false, 'SIGTERM 后全局锁必须释放');
  } finally {
    try {
      child.kill('SIGKILL');
    } catch {
      /* 已退出 */
    }
  }
});

await scenario('⑭ 两个 worktree 同时跑：只有一个进入，另一个指出胜者 cwd', async () => {
  const a = makeTree();
  const b = makeTree();
  writeBatch(a, 1200);
  writeBatch(b, 1200);
  const start = (root) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [runPath(root), 'hold'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => {
        out += d;
      });
      child.stderr.on('data', (d) => {
        out += d;
      });
      child.once('exit', (code, signal) => resolve({ root, code, signal, out }));
    });
  const [ra, rb] = await Promise.all([start(a), start(b)]);
  const results = [ra, rb];
  const winners = results.filter((r) => r.code === 0 && r.out.includes('批次：1/1 全中'));
  const losers = results.filter((r) => r.code !== 0 && r.out.includes('已有 mutator 在跑'));
  assert.equal(winners.length, 1, `必须恰好一个进入，实际 ${winners.length}\nA:\n${ra.out}\nB:\n${rb.out}`);
  assert.equal(losers.length, 1, `另一个必须被拒，实际 ${losers.length}\nA:\n${ra.out}\nB:\n${rb.out}`);
  // 同时起跑时，被拒的一方可能撞上"mkdir 成功、owner 还没落盘"的极短空窗——那也必须拒绝
  // （且拒绝理由要说明"锁内容读不到"）。owner 已落盘时则必须指出胜者 cwd。
  if (losers[0].out.includes('cwd 未知')) {
    assert.match(losers[0].out, /锁内容还读不到/, `空窗拒绝必须说明原因：\n${losers[0].out}`);
  } else {
    // macOS 的 /var → /private/var：子进程把入口 realpath 后写进锁，比较时必须比真实路径。
    assert.match(
      losers[0].out,
      new RegExp(`cwd ${escapeRe(fs.realpathSync(winners[0].root))}`),
      `被拒的一方必须指出胜者 cwd\n胜者 root：${winners[0].root}\n被拒输出：\n${losers[0].out}\n胜者输出：\n${winners[0].out}`
    );
  }
  assert.equal(lockExists(), false, '两边都退出后锁必须清掉');
});

// ---------------------------------------------------------------------------
const cleanup = process.env.MUTATE_SELFCHECK_KEEP !== '1' && failed.length === 0;
if (cleanup) {
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* 临时目录清不掉不影响结论 */
    }
  }
  clearLock();
} else if (roots.length) {
  console.log(`\n（临时目录保留：${roots.join('、')}；设 MUTATE_SELFCHECK_KEEP=1 可强制保留）`);
}

if (failed.length) {
  console.log(`\n自验：${failed.length} 个场景失败（${failed.join('、')}）`);
  process.exit(1);
}
console.log('\n自验：14/14 场景通过（含三场景 ①②③、强杀模拟 ⑦⑧、跨 worktree 全局锁 ⑨–⑭）');
process.exit(0);
