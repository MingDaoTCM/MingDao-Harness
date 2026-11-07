// 预检自身的回归（v0.6.41）——**守卫必须有测试**，否则它可能"永远通过"。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/preflight.mjs');
let passed = 0;
const ok = (n) => { passed += 1; console.log(`  ✓ ${n}`); };

/** 造一个最小仓库骨架：src/ + test/mutate/ + README。 */
function fixture({ batches, readmeCount, srcFiles = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-'));
  fs.mkdirSync(path.join(dir, 'test/mutate'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  for (const [name, body] of Object.entries(batches)) fs.writeFileSync(path.join(dir, 'test/mutate', name), body);
  fs.writeFileSync(path.join(dir, 'test/mutate/README.md'), `变异总数：${readmeCount}\n`);
  for (const [name, body] of Object.entries(srcFiles)) fs.writeFileSync(path.join(dir, 'src', name), body);
  return dir;
}
const GOOD = "import { makeMutator } from './lib.mjs';\nconst M = makeMutator();\nM.mutate({\n  name: '① x',\n  file: 'src/a.js',\n  from: 'a',\n  to: 'b',\n  expect: ['x'],\n  run: () => {},\n});\nconst ok = M.report();\nprocess.exit(ok ? 0 : 1);\n";
const run = (dir) => spawnSync(process.execPath, [script, '--root', dir, '--quiet'], { encoding: 'utf8' });

{
  const r = run(root);
  assert.equal(r.status, 0, `本仓库应通过预检：${r.stderr}`);
  ok('① 本仓库通过（批次结构 / 残留 / 计数）');
}
{
  const dir = fixture({ batches: { 'batch1-a.mjs': GOOD }, readmeCount: 1 });
  const r = run(dir);
  assert.equal(r.status, 0, `合法批次应通过：${r.stderr}`);
  ok('② 合法批次通过');
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  const bad = GOOD.replace('const ok = M.report();\nprocess.exit(ok ? 0 : 1);\n', '');
  const dir = fixture({ batches: { 'batch1-a.mjs': bad }, readmeCount: 1 });
  const r = run(dir);
  assert.equal(r.status, 1, '缺 report/exit 必须失败');
  assert.match(r.stderr, /缺 M\.report|缺 process\.exit/, '必须点名缺什么');
  ok('③ 缺 report/exit → 失败并点名');
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  const dir = fixture({ batches: { 'batch1-a.mjs': GOOD }, readmeCount: 1, srcFiles: { 'a.js': 'const x = 1; // 变异：残留\n' } });
  const r = run(dir);
  assert.equal(r.status, 1, '残留变异标记必须失败');
  assert.ok(r.stderr.includes('残留'), '必须指出残留文件');
  ok('④ src 残留 "// 变异：" → 失败');
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  const dir = fixture({ batches: { 'batch1-a.mjs': GOOD }, readmeCount: 2 });
  const r = run(dir);
  assert.equal(r.status, 1, '计数不一致必须失败');
  assert.match(r.stderr, /变异总数不一致：README 写 2，实际 1/, '必须给出两个数');
  ok('⑤ 计数不一致 → 失败并给出两数');
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  const empty = "import { makeMutator } from './lib.mjs';\nconst M = makeMutator();\nconst ok = M.report();\nprocess.exit(ok ? 0 : 1);\n";
  const dir = fixture({ batches: { 'batch1-a.mjs': empty }, readmeCount: 0 });
  const r = run(dir);
  assert.equal(r.status, 1, '没有 mutate 调用必须失败');
  assert.match(r.stderr, /没有任何 M\.mutate/, '必须指出没有 mutate');
  ok('⑥ 批次里没有 M.mutate → 失败');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\npreflight：${passed} 项通过`);
