// 批六十七（v0.6.31）：TTFT 提示节流的变异验证。
// 每条变异把 `shouldPrintTtftNotice`/状态表的某个关键点改回缺陷，`test/ttft-notice.js` 必须当场红。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const RUN = () => M.suite('test/ttft-notice.js');

M.mutate({
  name: '① 去掉「同回合只考虑第 1 次请求」判定（每请求都打）',
  file: 'src/messages.js',
  from: "  if (Number(llmCalls) !== 1) return { print: false, slowdown: false };",
  to: "  if (false) return { print: false, slowdown: false };",
  expect: ['期望 print'],
  run: RUN,
});

M.mutate({
  name: '② 去掉会话级静默期（每个新回合都打 → 长审计刷屏的原缺陷）',
  file: 'src/messages.js',
  from: "  if (!Number(lastAt)) return { print: true, slowdown: false };\n  return { print: now - Number(lastAt) >= Number(quietMs), slowdown: false };",
  to: "  return { print: true, slowdown: false };",
  expect: ['期望 print'],
  run: RUN,
});

M.mutate({
  name: '③ 去掉「首帧明显变慢」例外（劣化被节流吃掉）',
  file: 'src/messages.js',
  from: "  if (slowdown) return { print: true, slowdown: true };",
  to: "  if (false) return { print: true, slowdown: true };",
  expect: ['期望 print'],
  run: RUN,
});

M.mutate({
  name: '④ 变慢阈值失效（slowdownRatio 默认改成无穷大）',
  file: 'src/messages.js',
  from: "quietMs = TTFT_NOTICE_DEFAULT_QUIET_MS, slowdownRatio = 2 }",
  to: "quietMs = TTFT_NOTICE_DEFAULT_QUIET_MS, slowdownRatio = Infinity }",
  expect: ['期望 print'],
  run: RUN,
});

M.mutate({
  name: '⑤ 状态表每次都新建（节流状态不跨回合保存）',
  file: 'src/messages.js',
  from: "  let v = ttftNoticeState.get(k);\n  if (!v) {",
  to: "  let v = null;\n  if (!v) {",
  expect: ['共享'],
  run: RUN,
});

M.mutate({
  name: '⑥ 非有限 ttft 也打印（NaN 直接进文案）',
  file: 'src/messages.js',
  from: "  if (!Number.isFinite(ms)) return { print: false, slowdown: false };",
  to: "  if (false) return { print: false, slowdown: false };",
  expect: ['非有限'],
  run: RUN,
});

const ok = M.report();
process.exit(ok ? 0 : 1);
