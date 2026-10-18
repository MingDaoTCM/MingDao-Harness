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
const filter = argv.find((a) => !a.startsWith('-')) || '';

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
for (const f of files) {
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
console.log(`\n批次：${files.length - failed}/${files.length} 全中`);
process.exit(failed ? 1 : 0);
