// 批十八（v0.6.11：护栏前置判据抽成纯函数）的变异验证
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SEC = () => M.section('131');

M.mutate({
  name: '① 判据边界退回 `>`（恰好等于上限不再拦）',
  file: 'src/cost-guard.js',
  from: '  if (used + worst < limit) return null;',
  to: '  if (used + worst <= limit) return null;',
  expect: ['恰好等于上限必须拦'],
  run: SEC,
});

M.mutate({
  name: '② 无法判断时改为拦截（统计不可读就拦 → 误伤）',
  file: 'src/cost-guard.js',
  from: '  if (used == null || worst == null) return null; // 无法判断：不误拦，也不静默放行（主检查会告警）',
  to: '  if (used == null || worst == null) return "⛔ 护栏前置拦截（无法判断）";',
  expect: ['不得据此拦截'],
  run: SEC,
});

M.mutate({
  name: '③ 上限未配置/非法时也拦（护栏关闭后仍有前置行为）',
  file: 'src/cost-guard.js',
  from: '  if (!Number.isFinite(limit) || limit <= 0) return null;',
  to: '  if (false) return null;',
  expect: ['不得拦截'],
  run: SEC,
});

M.mutate({
  name: '④ 文案丢掉数字（排查时要回去翻配置）',
  file: 'src/cost-guard.js',
  from: '  return `⛔ 护栏前置拦截：本轮最坏成本 ≈¥${worst.toFixed(4)}，今日已用 ≈¥${used.toFixed(4)}，合计将超过上限 ¥${limit.toFixed(2)}——请求未发出。可调高 config.costGuard.dailyLimitYuan 或改用更小模型。`;',
  to: '  return "⛔ 护栏前置拦截：请求未发出。";',
  expect: ['文案必须含最坏/已用/上限三个数字'],
  run: SEC,
});

M.mutate({
  name: '⑤ runTurn 里又抄回一份内联比较（单源被破坏）',
  file: 'src/agent.js',
  from: '          const msg = preflightBlockMessage(g.dailyLimitYuan, usedTodayWithInflight(), worst);',
  to: '          const used2 = usedTodayWithInflight();\n          const msg = used2 != null && (used2 + worst >= Number(g.dailyLimitYuan)) ? "内联版" : null;',
  expect: ['不得再内联最坏成本比较', '必须调用抽出来的判据'],
  run: SEC,
});

if (!M.report()) process.exit(1);
