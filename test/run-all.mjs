// 测试汇总运行器（质检 Phase 3）：顺序执行全部套件，任何一套失败都继续跑完，
// 最后输出通过/失败汇总表并以非零码退出——替代「失败即中止、拿不到完整坏点清单」。
// 用法：node test/run-all.mjs [--coverage] [--suite name]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUITES = [
  ['smoke', 'node', ['test/smoke.js']],
  ['e2e-local', 'node', ['test/e2e-local.js']],
  ['e2e-web', 'node', ['test/e2e-web.js']],
  ['e2e-schedule', 'node', ['test/e2e-schedule.js']],
  ['api-contracts', 'node', ['test/api-contracts.js']],
  // Windows 上 npm 需以 npm.cmd 调用（workbuddy 报告：spawn('npm') 无 shell 在 Windows 必 ENOENT）
  ['bench', process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'bench']],
];

const args = process.argv.slice(2);
const coverage = args.includes('--coverage');
const only = args.find((a) => a.startsWith('--suite='))?.split('=')[1];

function run(cmd, cmdArgs, suite) {
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, {
      cwd: root,
      stdio: 'pipe',
      env: coverage ? { ...process.env, NODE_V8_COVERAGE: path.join(root, '.coverage') } : process.env,
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    // spawn 错误监听（workbuddy 报告）：npm 缺失等 ENOENT 不再让汇总器整体崩溃
    child.on('error', (/** @type {any} */ err) => {
      console.log(`❌ ${suite}（进程启动失败：${err?.message || err}）`);
      resolve({ suite, ok: false, out: out + String(err?.message || err) });
    });
    child.on('close', (code) => {
      const ok = code === 0;
      console.log(`${ok ? '✅' : '❌'} ${suite}${ok ? '' : '（详见末尾失败输出）'}`);
      resolve({ suite, ok, out });
    });
  });
}

const results = [];
for (const [suite, cmd, cmdArgs] of SUITES) {
  if (only && suite !== only) continue;
  results.push(await run(cmd, cmdArgs, suite));
}

console.log('\n—— 测试汇总 ——');
let failed = 0;
for (const r of results) {
  if (!r.ok) {
    failed += 1;
    console.log(`\n❌ ${r.suite} 失败输出（尾部 1200 字符）：`);
    console.log(r.out.slice(-1200));
  }
}
console.log(`\n共 ${results.length} 套：${results.length - failed} 通过 / ${failed} 失败`);
if (coverage && fs.existsSync(path.join(root, '.coverage'))) {
  console.log('V8 覆盖率原始数据已写入 .coverage/（用 npm run coverage:report 汇总）');
}
process.exit(failed ? 1 : 0);
