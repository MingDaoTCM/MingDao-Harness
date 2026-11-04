// 批六十八（v0.7.0 任务 1）：覆盖率口径的变异验证。
//
// 「尺子」本身必须有可信度：每条变异把新算法的一个关键点改回缺陷（或改坏），
// `test/coverage-metric.js` 必须当场红，且失败输出里出现该条 `expect` 关键词
// （关键词 = 断言原文，防止"红是红了，但不是因为你改坏的那条"）。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const RUN = () => M.suite('test/coverage-metric.js');

M.mutate({
  name: '① 退回"父区间并集"：取栈底（最外层）而不是最内层区间',
  file: 'scripts/coverage-report.mjs',
  from: '      const inner = stack.length ? stack[stack.length - 1] : null;',
  to: '      const inner = stack.length ? stack[0] : null;',
  expect: ['父区间不得把未执行的子行算成已覆盖'],
  run: RUN,
});

M.mutate({
  name: '② 把 code-lines 当 all-lines：all-lines 的分母也用代码行',
  file: 'scripts/coverage-report.mjs',
  from: "    totals['all-lines'].covered += allM.covered;\n    totals['all-lines'].total += allM.total;",
  to: "    totals['all-lines'].covered += codeM.covered;\n    totals['all-lines'].total += codeM.total;",
  expect: ['all-lines 分母必须包含空行与注释行'],
  run: RUN,
});

M.mutate({
  name: '③ 函数级忽略未执行：`count > 0` 放宽成 `count >= 0`（全部算已覆盖）',
  file: 'scripts/coverage-report.mjs',
  from: '    if (first.count > 0) covered += 1;',
  to: '    if (first.count >= 0) covered += 1;',
  expect: ['未执行的函数不得计入已覆盖'],
  run: RUN,
});

M.mutate({
  name: '④ ratchet 不生效：低于基线也判 ok',
  file: 'scripts/coverage-report.mjs',
  from: '    out.push({ metric, current: curPct, baseline: basePct, delta, ok: curPct + 1e-9 >= basePct - RATCHET_TOLERANCE_PP });',
  to: '    out.push({ metric, current: curPct, baseline: basePct, delta, ok: true });',
  expect: ['低于基线必须判失败'],
  run: RUN,
});

M.mutate({
  name: '⑤ 空文件崩：空源码直接抛错（分母 0 的正确处理被拿掉）',
  file: 'scripts/coverage-report.mjs',
  from: "  const src = String(source ?? '');",
  to: "  const src = String(source ?? '');\n  if (src.length === 0) throw new Error('空文件不受支持');",
  expect: ['空文件不得抛错'],
  run: RUN,
});

M.mutate({
  name: '⑥ 分母为 0 时返回 NaN（纯注释/空文件把百分比算崩）',
  file: 'scripts/coverage-report.mjs',
  from: '  return total ? Math.round((covered / total) * 1000) / 10 : 0;',
  to: '  return Math.round((covered / total) * 1000) / 10;',
  expect: ['纯注释文件 code-lines 必须为 0'],
  run: RUN,
});

M.mutate({
  name: '⑦ 多进程区间不取最大值（先到的 count=0 覆盖后到的 count=3）',
  file: 'scripts/coverage-report.mjs',
  from: '    if (!prev || r.count > prev.count) bySpan.set(key, { startOffset: r.startOffset, endOffset: r.endOffset, count: r.count });',
  to: '    if (!prev) bySpan.set(key, { startOffset: r.startOffset, endOffset: r.endOffset, count: r.count });',
  expect: ['取最大值'],
  run: RUN,
});

process.exit(M.report() ? 0 : 1);
