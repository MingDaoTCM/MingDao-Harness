// 提交前 2 秒预检：在"25 分钟后才发现"之前，把**结构性**错误挡住。
//
// 为什么需要：变异批次漏写 `const ok = M.report(); process.exit(...)` 时，批次永远 exit 0，
// 门禁看起来全绿；而 `run.mjs` 的预检只在**跑全量时才**发现——那已经是 20 分钟后。
// 这件事在 0.6.40 里连犯两次（batch78、batch79），所以必须有个秒级入口。
//
// 用法：
//   node scripts/preflight.mjs        # 全量检查（默认）
//   node scripts/preflight.mjs --quiet
// 退出码：0 = 通过；1 = 有问题（打印到 stderr）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// --root：给测试用（在临时仓库里跑，验证"坏批次真的会被抓到"）。
const rootArgIdx = process.argv.indexOf('--root');
const root = rootArgIdx >= 0 && process.argv[rootArgIdx + 1]
  ? path.resolve(process.argv[rootArgIdx + 1])
  : path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!fs.existsSync(path.join(root, 'test/mutate'))) {
  console.error(`✗ 目录不像本仓库根（缺 test/mutate）：${root}`);
  process.exit(2);
}
const quiet = process.argv.includes('--quiet');
const problems = [];

/** ① 每个变异批次都必须"会红"：有 report + process.exit。 */
{
  const dir = path.join(root, 'test/mutate');
  for (const f of fs.readdirSync(dir).filter((x) => /^batch.*\.mjs$/.test(x))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    if (!/\bM\.report\s*\(/.test(src)) problems.push(`${f}：缺 M.report()（批次永远不会红）`);
    else if (!/process\.exit\s*\(/.test(src)) problems.push(`${f}：缺 process.exit(…)（汇总不会变成退出码）`);
    if (!/\bmutate\s*\(\s*\{/.test(src)) problems.push(`${f}：没有任何 M.mutate({...})`);
  }
}

/** ② 源码里不得残留变异补丁标记。 */
{
  const bad = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.js')) continue;
      if (fs.readFileSync(full, 'utf8').includes('// 变异：')) bad.push(path.relative(root, full));
    }
  };
  walk(path.join(root, 'src'));
  for (const f of bad) problems.push(`${f}：残留 "// 变异：" 标记（变异没还原）`);
}

/** ③ 变异总数与 README 一致（doc-lint 也查，这里提前到秒级）。 */
{
  const dir = path.join(root, 'test/mutate');
  let actual = 0;
  for (const f of fs.readdirSync(dir).filter((x) => /^batch.*\.mjs$/.test(x))) {
    actual += [...fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/^\s{2}name:\s*'/gm)].length;
  }
  const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
  const m = readme.match(/变异总数：(\d+)/);
  if (m && Number(m[1]) !== actual) problems.push(`变异总数不一致：README 写 ${m[1]}，实际 ${actual}`);
}

if (problems.length) {
  console.error(`✗ 预检发现 ${problems.length} 个问题：`);
  for (const p of problems) console.error('  · ' + p);
  process.exit(1);
}
if (!quiet) console.log('✓ 预检通过（批次结构 / 变异残留 / 计数一致）');
