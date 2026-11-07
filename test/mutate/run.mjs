// 变异验证总入口：按批次顺序跑 test/mutate/batch*.mjs。
//   node test/mutate/run.mjs                全部
//   node test/mutate/run.mjs batch12        只跑匹配的批次
//   node test/mutate/run.mjs --allow-dirty  允许在脏工作树（src/**、test/**）上跑
//
// v0.6.17 fail-safe（两次事故的落地，详见 test/mutate/FAILSAFE.md）：
//   - 启动先跑开跑前自检（check.mjs 的 preflight）：pid 已死的残留**自动还原**；
//     文件被第三方改过 / pid 还活着的"在飞"标记 → **拒绝运行**并列出清单；
//   - 脏工作树（src/**、test/** 未提交改动）默认拒绝，`--allow-dirty` 显式放行；
//   - 全程持**全局**锁（`os.tmpdir()/mingdao-mutate.lock/`，v0.6.18 起不再放 `.generated/`）：
//     第二个 mutator（**包括另一个 worktree 里的**）会被告知"已有 mutator 在跑（pid N，cwd X，已运行 Ys）"；
//     只有"pid 已不在"且"锁 mtime 超过 15 分钟"同时成立才判陈旧——只看 pid 会在
//     mkdir→node 的空窗里误删活锁（今天两次事故的根因）；
//   - 每批之间再扫一次：若某个批次子进程被强杀，残留会在下一批开跑前被自愈，而不是带病跑下去。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeEol, acquireLock, installCleanup, scanResidue } from './lib.mjs';
import { preflight } from './check.mjs';

// v0.6.8（Windows 腿回归护栏）：变异锚点一律按 LF 书写，而 windows-latest 的工作树是 CRLF
// （Git for Windows 的 core.autocrlf 默认为 true，本仓库又没有 .gitattributes）。少了行尾归一化，
// 批十二~十五里**所有多行锚点**都会"变异点未找到"，整批静默退化成 0/4 全中——那正是这一轮 CI
// 的 Windows 红。这里用一段与平台无关的小样本把 normalizeEol 钉死：谁把它去掉，所有平台当场红，
// 不必再等 Windows 腿来发现。
if (!normalizeEol('a\r\nb\r\nc\r').includes('a\nb\nc\n')) {
  console.log('✗ 行尾归一化自检失败：CRLF 工作树（Windows）下多行变异锚点会全部匹配不上');
  process.exit(1);
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const allowDirty = argv.includes('--allow-dirty');
// v0.6.41：`--changed [base]` 只跑"本次改动可能影响到的批次"。
//
// 为什么：全量 70 批 / 768 条要 **20+ 分钟**，而这其中绝大多数与本次改动无关。
// 日常提交只需要跑"锚点落在改动文件上"的批次；**全量只在发版前跑一次**。
// 规则保守：只要有 test/** 改动就退回全量——因为断言/expect 变了，可能影响任意批次。
const changedIdx = argv.indexOf('--changed');
const selectOnly = argv.includes('--select-only');
let changedBase = '';
if (changedIdx >= 0) {
  const next = argv[changedIdx + 1];
  changedBase = next && !next.startsWith('-') ? next : 'HEAD~1';
}
const filter = argv.find((a) => !a.startsWith('-') && a !== changedBase) || '';

// 锁：整轮跑都持有；批次子进程通过 MINGDAO_MUTATE_LOCK 继承，不再各自抢锁。
let lock;
try {
  lock = acquireLock({ root: path.join(dir, '..', '..') });
} catch (e) {
  console.log(`✗ ${e.message}`);
  process.exit(1);
}
installCleanup({ root: path.join(dir, '..', '..'), lock });

const files = fs
  .readdirSync(dir)
  .filter((f) => /^batch.*\.mjs$/.test(f))
  .filter((f) => f.includes(filter))
  .sort();
if (!files.length) {
  lock.release();
  console.log(`没有匹配的批次脚本（filter=${JSON.stringify(filter)}）`);
  process.exit(1);
}

// --changed：按"锚点文件"筛批次
let selected = files;
if (changedIdx >= 0) {
  const { spawnSync } = await import('node:child_process');
  const rootDir = path.join(dir, '..', '..');
  const diff = spawnSync('git', ['diff', '--name-only', changedBase], { cwd: rootDir, encoding: 'utf8' });
  if (diff.status !== 0) {
    lock.release();
    console.log(`✗ git diff 失败（base=${changedBase}）：${(diff.stderr || '').slice(0, 300)}`);
    process.exit(1);
  }
  const changed = new Set((diff.stdout || '').split('\n').map((x) => x.trim()).filter(Boolean));
  const testTouched = [...changed].some((f) => f.startsWith('test/'));
  if (testTouched) {
    console.log(`⚠ 本次改动了 test/**（断言/expect 可能影响任意批次）→ 退回全量 ${files.length} 批`);
  } else {
    selected = files.filter((f) => {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      const targets = [...src.matchAll(/^\s+file:\s*'([^']+)'/gm)].map((m) => m[1]);
      return targets.some((t) => changed.has(t));
    });
    const list = selected.map((f) => f.replace(/\.mjs$/, ''));
    console.log(`--changed ${changedBase}: 改动 ${changed.size} 个文件 → 选中 ${selected.length}/${files.length} 批`);
    if (list.length) console.log('   ' + list.join(' '));
    else console.log('   （没有锚点落在改动文件上的批次）');
  }
  if (selectOnly) { lock.release(); process.exit(0); }
  if (!selected.length) { lock.release(); console.log('没有需要跑的批次（--changed）'); process.exit(0); }
}

// v0.6.36（发布前被负责人抓到）：**批次必须自己会红**。
//
// 事故：`batch47/54/67/77` 四个批次文件末尾漏了 `const ok = M.report(); process.exit(ok ? 0 : 1);`，
// 于是无论里面有多少条逃逸、多少条"变异点未找到"，进程都正常退出 0，run.mjs 记为"全中"——
// 门禁看上去 66/66，实际有 4 个批次**永远不可能失败**。
// 这类缺陷不会自己暴露（越"绿"越可疑），必须在开跑前用结构判据挡住：
// ① 每个批次必须出现 `M.report()`（打印汇总并给出 ok）；
// ② 必须出现 `process.exit(`（把 ok 变成退出码）。
const BAD_BATCH = [];
for (const f of files) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  if (!/\bM\.report\s*\(/.test(src)) BAD_BATCH.push(`${f}：缺 M.report()`);
  else if (!/process\.exit\s*\(/.test(src)) BAD_BATCH.push(`${f}：缺 process.exit(…)，汇总不会变成退出码`);
}
if (BAD_BATCH.length) {
  lock.release();
  console.error('✗ 变异批次结构不合格（这些批次永远不会红，先修再加）：');
  for (const b of BAD_BATCH) console.error('  · ' + b);
  process.exit(1);
}

// 开跑前自检（自愈残留 / 拒绝冲突与在飞 / 脏工作树清单）。
const pre = preflight({ root: path.join(dir, '..', '..'), allowDirty });
if (!pre.ok) {
  lock.release();
  process.exit(1);
}

// 给事件循环一个回合：run.mjs 的主循环是同步 spawnSync，若不主动让出，SIGINT/SIGTERM 的
// `process.once` 回调要等整轮跑完才会执行（Ctrl-C 看起来"没反应"，与 §3.52 那类停止键失效同源）。
const yieldTick = () => new Promise((resolve) => setImmediate(resolve));

let failed = 0;
let aborted = false;
for (const f of selected) {
  console.log(`\n=== ${f} ===`);
  const r = spawnSync(process.execPath, [path.join(dir, f)], {
    stdio: 'inherit',
    env: { ...process.env, MINGDAO_MUTATE_LOCK: String(process.pid) },
  });
  if (r.status !== 0) failed += 1;
  // 批次之间再查一次：子进程若被强杀（SIGKILL）会留下"补丁 + 标记"，这里当场自愈；
  // 若文件被第三方改过则停下来，绝不在未知状态上继续变异。
  const after = scanResidue({ root: path.join(dir, '..', '..'), mode: 'check' });
  if (after.conflicts.length || after.inflight.length) {
    for (const c of after.conflicts) console.log(`✗ 批次后自检冲突：${c.file}（${c.reason}；标记 ${c.markerPath}）`);
    for (const i of after.inflight) console.log(`✗ 批次后自检：${i.file} 仍在飞（pid ${i.pid}）`);
    console.log('[mutate] 拒绝继续：先处理上述残留/在飞标记（node test/mutate/check.mjs）。');
    aborted = true;
    break;
  }
  await yieldTick();
}
lock.release();
if (aborted) process.exit(1);
console.log(`\n批次：${selected.length - failed}/${selected.length} 全中${selected.length !== files.length ? `（--changed 只跑了 ${selected.length}/${files.length}）` : ''}`);
process.exit(failed ? 1 : 0);
