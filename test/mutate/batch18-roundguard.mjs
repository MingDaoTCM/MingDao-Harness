// 批十九（v0.6.11：每轮护栏动作决策抽成纯函数）的变异验证
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SEC = () => M.section('132');

M.mutate({
  name: '① BUG-023/035 回归：已降过级时不再拦（静默继续计费）',
  file: 'src/cost-guard.js',
  from: '  if (downgraded || guard.downgradeModel === activeModel) {',
  to: '  if (false) {',
  expect: ['本回合降过一次后必须拦', '已在最便宜档必须拦'],
  run: SEC,
});

M.mutate({
  name: '② 在途触发被去掉（贵模型会一直用到回合结束）',
  file: 'src/cost-guard.js',
  from: '      if (usedWithInflight != null && usedWithInflight >= Number(g0.dailyLimitYuan)) {',
  to: '      if (false) {',
  expect: ['必须触发降级'],
  run: SEC,
});

M.mutate({
  name: '③ 在途触发不看"是否已降过"（每轮反复降级）',
  file: 'src/cost-guard.js',
  from: '  if (!guard && !downgraded) {',
  to: '  if (!guard) {',
  expect: ['不得反复触发在途降级'],
  run: SEC,
});

M.mutate({
  name: '④ 非降级档也在途触发（block 档被绕过判据）',
  file: 'src/cost-guard.js',
  from: "    if (g0 && String(g0.action) === 'downgrade' && Number(g0.dailyLimitYuan) > 0) {",
  to: '    if (g0 && Number(g0.dailyLimitYuan) > 0) {',
  expect: ['只属于降级档'],
  run: SEC,
});

M.mutate({
  name: '⑤ 文案丢掉"在途"说明（用户看不出是含在途触发的）',
  file: 'src/cost-guard.js',
  from: '          message: `⚠ 费用护栏：今日已用（含本回合在途）≈¥${usedWithInflight.toFixed(4)} 已达上限 ¥${Number(g0.dailyLimitYuan).toFixed(2)}——已自动降级到便宜模型继续执行。`,',
  to: '          message: `⚠ 费用护栏：已达上限——已自动降级。`,',
  expect: ['文案要说明是'],
  run: SEC,
});

M.mutate({
  name: '⑥ runTurn 里又抄回内联分支（单源被破坏）',
  file: 'src/agent.js',
  from: '        const d = roundGuardAction(',
  to: "        const guard = checkCostGuard(activeModel);\n        if (guard && guard.blocked) { stripOrphanCalls(); return { text: null, reasoning: '', usage, steps, finish, truncated: false, aborted: false, note: guard.message, durationMs: Date.now() - startedAt, perf: perf() }; }\n        const d = roundGuardAction(",
  expect: ['护栏对象的内部字段不得出现在'],
  run: SEC,
});

if (!M.report()) process.exit(1);
