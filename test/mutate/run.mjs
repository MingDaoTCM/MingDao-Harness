// 变异验证总入口：按批次顺序跑 test/mutate/batch*.mjs。
//   node test/mutate/run.mjs            全部
//   node test/mutate/run.mjs batch12    只跑匹配的批次
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeEol } from './lib.mjs';

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
const filter = process.argv[2] || '';
const files = fs
  .readdirSync(dir)
  .filter((f) => /^batch.*\.mjs$/.test(f))
  .filter((f) => f.includes(filter))
  .sort();
if (!files.length) {
  console.log(`没有匹配的批次脚本（filter=${JSON.stringify(filter)}）`);
  process.exit(1);
}
let failed = 0;
for (const f of files) {
  console.log(`\n=== ${f} ===`);
  const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: 'inherit' });
  if (r.status !== 0) failed += 1;
}
console.log(`\n批次：${files.length - failed}/${files.length} 全中`);
process.exit(failed ? 1 : 0);
