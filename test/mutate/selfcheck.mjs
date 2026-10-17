// 变异 fail-safe 的自验（v0.6.17）：**用临时目录模拟整棵树**，不碰真实工作树。
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
// 临时树的形状与真实仓库一致：`<tmp>/test/mutate/{lib,check}.mjs` + `<tmp>/src/demo.js`。
// 被复制过去的 lib.mjs 会把 `<tmp>` 当仓库根，所以这里跑的是**同一份代码**，不是替身。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writePendingMarker, pendingDir, lockFilePath, journalPath, normalizeEol } from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const LIB_SRC = path.join(here, 'lib.mjs');
const CHECK_SRC = path.join(here, 'check.mjs');

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
  fs.writeFileSync(path.join(root, 'src', 'demo.js'), ORIGINAL);
  roots.push(root);
  return root;
}

const checkPath = (root) => path.join(root, 'test', 'mutate', 'check.mjs');
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

async function scenario(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    failed.push(name);
    console.log(`✗ ${name}\n    ${(e && e.message) || e}`);
  }
}

// ---------------------------------------------------------------------------

await scenario('① 干净启动：无标记、无锁，check 通过', () => {
  const root = makeTree();
  const r = runCheck(root);
  assert.equal(r.status, 0, `check 应退出 0，实际 ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /自检通过/);
  assert.equal(markers(root).length, 0);
  assert.equal(fs.existsSync(lockFilePath(root)), false, 'check 结束后锁必须清掉');
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
  assert.equal(fs.existsSync(lockFilePath(root)), false);
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
  fs.mkdirSync(path.dirname(lockFilePath(root)), { recursive: true });
  fs.writeFileSync(
    lockFilePath(root),
    JSON.stringify({ v: 1, pid: process.pid, startedAt: new Date().toISOString(), argv: [], cwd: root })
  );

  const r = runCheck(root);
  assert.equal(r.status, 1, `活锁必须拒绝，实际 ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, new RegExp(`已有 mutator 在跑（pid ${process.pid}`));
  assert.equal(fs.existsSync(lockFilePath(root)), true, '活锁不能被第二个进程删掉');
  fs.unlinkSync(lockFilePath(root));
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
  assert.equal(fs.existsSync(lockFilePath(root)), false, 'SIGTERM 后锁必须清掉');
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
  assert.equal(fs.existsSync(lockFilePath(root)), true, 'SIGKILL 后锁是陈旧的（pid 已死）');

  const r = runCheck(root);
  assert.equal(r.status, 0, `check 应自愈后通过，实际 ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /已自愈 1 处残留变异/);
  assert.match(r.stdout, /清理陈旧锁/);
  assert.equal(read(root), ORIGINAL, '自愈必须还原原始字节');
  assert.equal(markers(root).length, 0);
  assert.equal(fs.existsSync(lockFilePath(root)), false);
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
} else if (roots.length) {
  console.log(`\n（临时目录保留：${roots.join('、')}；设 MUTATE_SELFCHECK_KEEP=1 可强制保留）`);
}

if (failed.length) {
  console.log(`\n自验：${failed.length} 个场景失败（${failed.join('、')}）`);
  process.exit(1);
}
console.log('\n自验：8/8 场景通过（含三场景 ①②③ 与强杀模拟 ⑦⑧）');
process.exit(0);
