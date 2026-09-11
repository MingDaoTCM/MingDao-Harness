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
let raw = '';
try {
  execSync('npx tsc -p tsconfig.full.json', { cwd: root, stdio: 'pipe' });
  out = '';
} catch (e) {
  out = String(e.stdout || '');
  raw = String(e.stdout || '') + String(e.stderr || '');
}
// 审计修复（v0.4.6）：tsc 不可用时必须**显式失败**，不能算出「0 条错误」并报 ✅。
// 此前 CI 把 npm ci 排在棘轮之后，npx 找不到本地 typescript 会去拉已废弃的 tsc 存根
// （退出 1、无 error 行）→ count=0 → 打印「未恶化」通过，棘轮实际空转。
if (/Cannot find|not the tsc command|command not found|ERR_MODULE_NOT_FOUND|npm error/i.test(raw)) {
  console.error('strict 棘轮：无法运行 tsc（typescript 未安装？请先 npm ci）。工具缺失不等于 0 错误，按失败处理。');
  console.error(raw.split('\n').slice(0, 5).join('\n'));
  process.exit(2);
}
const count = (out.match(/error TS/g) || []).length;
console.log(`strict 棘轮：当前 ${count} 条 / 基线 ${baseline} 条（${count <= baseline ? '✅ 未恶化' : '⛔ 超基线'}` + (count < baseline ? `，较基线少 ${baseline - count} 条` : '') + '）');
if (count > baseline) process.exit(1);
