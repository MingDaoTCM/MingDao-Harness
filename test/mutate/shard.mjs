// 变异分片并行：把 70 批分到 N 个独立 worktree 里同时跑，把 25 分钟压到 ~7 分钟。
//
// 为什么能并行：每条变异是"改一个文件 → 跑一个套件 → 还原"，**互不共享状态**；
// 真正阻碍并行的是两件事，都已经有解法：
//   ① 全局锁：`MINGDAO_MUTATE_LOCK_DIR` 可指向独立锁目录（v0.6.18 起）；
//   ② 同一工作树里改文件会互相踩：每个分片用**自己的 `git worktree`**。
//
// 用法：
//   node test/mutate/shard.mjs            # 默认 4 片
//   node test/mutate/shard.mjs --shards 6
//   node test/mutate/shard.mjs --shards 2 --only batch78-queue.mjs,batch81-steering.mjs
//
// 退出码：0 = 所有分片都全中；1 = 有分片报逃逸/失败（并把失败分片的日志尾部打出来）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dir, '..', '..');
const argv = process.argv.slice(2);
const shardsIdx = argv.indexOf('--shards');
const SHARDS = Math.max(1, Math.min(12, Number(argv[shardsIdx + 1] || 4)));
const onlyIdx = argv.indexOf('--only');
const only = onlyIdx >= 0 && argv[onlyIdx + 1] ? argv[onlyIdx + 1].split(',').map((s) => s.trim()).filter(Boolean) : null;

const all = fs.readdirSync(dir).filter((f) => /^batch.*\.mjs$/.test(f)).filter((f) => (only ? only.includes(f) : true)).sort();
if (!all.length) { console.error('没有匹配的批次'); process.exit(1); }

// 按"文件体积"做 LPT 贪心分配（批次的耗时大致与体积正相关），比轮询更均衡
const sized = all.map((f) => ({ f, w: fs.statSync(path.join(dir, f)).size })).sort((a, b) => b.w - a.w);
const buckets = Array.from({ length: SHARDS }, () => ({ files: [], w: 0 }));
for (const it of sized) {
  const b = buckets.reduce((m, x) => (x.w < m.w ? x : m), buckets[0]);
  b.files.push(it.f); b.w += it.w;
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-shard-'));
// 每个分片要有自己的 TMPDIR（套件会往里写临时 home）与锁目录，否则 mkdtemp 会失败
const runs = [];
console.log(`分片：${SHARDS} 片 / ${all.length} 批 · 工作目录 ${base}`);
buckets.forEach((b, i) => {
  if (!b.files.length) return;
  const wt = path.join(base, `wt${i}`);
  const add = spawnSync('git', ['worktree', 'add', '--detach', wt, 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (add.status !== 0) { console.error(`✗ 创建 worktree 失败：${(add.stderr || '').slice(0, 200)}`); process.exit(1); }
  try { fs.symlinkSync(path.join(root, 'node_modules'), path.join(wt, 'node_modules')); } catch { /* 已存在或无 node_modules */ }
  fs.mkdirSync(path.join(base, `tmp${i}`), { recursive: true });
  // 注意：**不要**预建锁目录——acquireLock 用"目录是否存在"表示持锁，预建等于自己先占锁。
  // 关键：worktree 检出的是 **HEAD**，未提交的改动不在里面。
  // 分片跑的是"已提交的代码"——这正是我们要的语义（门禁只对提交负责）。
  // 若想跑未提交改动，请先提交，或设 SHARD_ALLOW_DIRTY=1（会用 git diff 打补丁过去）。
  if (process.env.SHARD_ALLOW_DIRTY === '1') {
    const diff = spawnSync('git', ['diff', 'HEAD'], { cwd: root, encoding: 'buffer' });
    if (diff.status === 0 && diff.stdout.length) spawnSync('git', ['apply', '-'], { cwd: wt, input: diff.stdout });
  }
  const logPath = path.join(base, `shard${i}.log`);
  console.log(`  shard${i}: ${b.files.length} 批 → ${b.files.join(' ')}`);
  const child = spawn(process.execPath, [path.join(wt, 'test/mutate/run.mjs'), '--only', b.files.join(',')], {
    cwd: wt,
    env: { ...process.env, MINGDAO_MUTATE_LOCK_DIR: path.join(base, `lock${i}`), TMPDIR: path.join(base, `tmp${i}`) },
    stdio: ['ignore', fs.openSync(logPath, 'w'), fs.openSync(logPath, 'a')],
  });
  runs.push({ i, child, logPath, files: b.files });
});

let bad = 0;
await Promise.all(runs.map((r) => new Promise((resolve) => {
  r.child.on('exit', (code) => { r.code = code; if (code !== 0) bad += 1; resolve(); });
})));

for (const r of runs) {
  const tail = fs.readFileSync(r.logPath, 'utf8').trim().split('\n').slice(-4).join('\n');
  console.log(`\n--- shard${r.i} exit=${r.code}（${r.files.length} 批）\n${tail}`);
}
// 清理 worktree（保留日志目录供排障）
for (let i = 0; i < SHARDS; i += 1) {
  spawnSync('git', ['worktree', 'remove', '--force', path.join(base, `wt${i}`)], { cwd: root });
}
console.log(`\n分片结果：${runs.length - bad}/${runs.length} 片全中${bad ? ' —— 有分片失败，见上面日志' : ''}`);
process.exit(bad ? 1 : 0);
