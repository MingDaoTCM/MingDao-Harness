// 全量 strict 棘轮（质检 Phase 3）：运行 tsc -p tsconfig.full.json 统计错误数，
// 只允许下降不允许上升——逐步消除 1584 条基线错误（TS7006 隐式 any 为主）。
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselineFile = path.join(root, 'scripts', 'strict-baseline.json');
const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8')).count;

let out = '';
try {
  execSync('npx tsc -p tsconfig.full.json', { cwd: root, stdio: 'pipe' });
  out = '';
} catch (e) {
  out = String(e.stdout || '');
}
const count = (out.match(/error TS/g) || []).length;
console.log(`strict 棘轮：当前 ${count} 条 / 基线 ${baseline} 条（${count <= baseline ? '✅ 未恶化' : '⛔ 超基线'}` + (count < baseline ? `，较基线少 ${baseline - count} 条` : '') + '）');
if (count > baseline) process.exit(1);
