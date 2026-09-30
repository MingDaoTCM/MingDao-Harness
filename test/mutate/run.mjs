// 变异验证总入口：按批次顺序跑 test/mutate/batch*.mjs。
//   node test/mutate/run.mjs            全部
//   node test/mutate/run.mjs batch12    只跑匹配的批次
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
