// 批六十一（v0.6.31，第三方代码审计 C-1 / H-13 + 核验报告 C-1 / H-1）的变异验证。
//
// 两条缺陷都是「**同步** 工作落在事件循环上，输入却来自不可信文本」：
//   A1 ReDoS：grep 的 pattern 来自模型，单行 20KB 即可让 `re.test` 同步回溯 45s+；
//             旧判据按源码首字符比较，`^(\d|[\d])+$` 与 `(a|aa)+` 语义等价却放行。
//   A2 Intl：`beijingParts` 每次新建 2 个 Intl.DateTimeFormat，2 万条费用记录 → 单请求阻塞 0.85~8.16s。
//
// 本批把每处修复逐个改回缺陷，`test/freeze-hardening.js` 必须当场红（14 条，要求 ≥10）。
// 覆盖：
//   相邻无界量词判据（①⑨）、嵌套组重复（②）、交替退化/首字符回退（⑩）、Pack 同口径（③）、嵌套量词（④）；
//   grep 单一口径 / 可见原因 / 行级预算 / 预算本身失效（⑤⑥⑦⑧）；
//   formatter 缓存 / beijingParts 绕过缓存（⑪⑫）；日界预分桶 / 未来日边界（⑬⑭）。
import { makeMutator } from './lib.mjs';

const M = makeMutator();
const SUITE = () => M.suite('test/freeze-hardening.js');

// ① 相邻无界量词不再拒绝 → `a*a*`、`\d+\d*`、`.*.*` 全部放行（PoC 重新冻结）
M.mutate({
  name: '① 相邻无界量词判据被摘掉（a*a*、\\d+\\d* 重新放行）',
  file: 'src/regex-safety.js',
  from: '  if (adjacentUnbounded(ctx.sequences)) {',
  to: '  if (false) { // 变异：相邻无界量词不再拒绝',
  expect: ['恶意 pattern 必须被拒'],
  run: SUITE,
});

// ② 嵌套组内的歧义分支不再检查（只看组自身量词，不看祖先是否被重复）→ `((a|ab)x)+` 重新放行
M.mutate({
  name: '② 嵌套组重复不再上溯祖先（((a|ab)x)+ 重新放行）',
  file: 'src/regex-safety.js',
  from: [
    '  if (repeats(group.quant)) return true;',
    '  for (let p = group.parent; p; p = p.parent) if (repeats(p.quant)) return true;',
  ].join('\n'),
  to: ['  if (repeats(group.quant)) return true;', '  // 变异：不再检查祖先组是否被重复'].join('\n'),
  expect: ['恶意 pattern 必须被拒'],
  run: SUITE,
});

// ③ 相邻无界量词不再并入 hasAmbiguousAlternation → 约束引擎 / Pack 的 output-forbid 漏
M.mutate({
  name: '③ hasAmbiguousAlternation 丢掉相邻无界量词（Pack 约束漏判）',
  file: 'src/regex-safety.js',
  from: '  return alternationAmbiguous(ctx.groups) || adjacentUnbounded(ctx.sequences);',
  to: '  return alternationAmbiguous(ctx.groups); // 变异：相邻无界量词不再并入',
  expect: ['约束引擎也必须拒'],
  run: SUITE,
});

// ④ 嵌套量词不再拒绝 → `(a+)+`、`(\d+)*` 重新放行
M.mutate({
  name: '④ 嵌套量词判据被摘掉（(a+)+、(\\d+)* 重新放行）',
  file: 'src/regex-safety.js',
  from: '  if (hasNestedQuantifier(pattern)) {',
  to: '  if (false) { // 变异：嵌套量词不再拒绝',
  expect: ['恶意 pattern 必须被拒'],
  run: SUITE,
});

// ⑤ grep 换回旧的弱判据（不做任何 ReDoS 静态检查）→ 12 个恶意 pattern 直接进 re.test，子进程冻死
M.mutate({
  name: '⑤ grep 判据换回旧的弱版本（恶意 pattern 直接进 re.test）',
  file: 'src/tools/fs-tools.js',
  from: [
    '    const unsafe = patternRejectionReason(pattern);',
    '    if (unsafe) return { ok: false, error: `正则被拒：${unsafe}` };',
  ].join('\n'),
  to: '    const unsafe = null; // 变异：判据换回旧的（不做 ReDoS 检查）',
  expect: ['子进程未正常退出', '必须在 <1s 内被拒/返回'],
  run: SUITE,
});

// ⑥ 拒绝原因不再带可见前缀 → 模型只看到一句没头没尾的话（静默拒绝）
M.mutate({
  name: '⑥ 拒绝原因丢掉「正则被拒：」可见前缀',
  file: 'src/tools/fs-tools.js',
  from: '    if (unsafe) return { ok: false, error: `正则被拒：${unsafe}` };',
  to: '    if (unsafe) return { ok: false, error: String(unsafe) };',
  expect: ['拒绝时必须给出可见原因'],
  run: SUITE,
});

// ⑦ 预算只在文件之间检查（旧实现）→ 单行内的 testLine 无检查点，假时钟证明行级预算失效
M.mutate({
  name: '⑦ 5s 预算退回「只在文件之间检查」（testLine 内无检查点）',
  file: 'src/tools/fs-tools.js',
  from: [
    '    /** @type {(line: any) => any} */',
    '    const testLine = (line) => {',
    '      if (overBudget()) { budgetHit = true; return false; }',
    '      const target = line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line;',
    '      const hit = re.test(target);',
    '      if (overBudget()) budgetHit = true;',
    '      return hit;',
    '    };',
  ].join('\n'),
  to: [
    '    /** @type {(line: any) => any} */',
    '    const testLine = (line) => (line.length > MAX_LINE ? re.test(line.slice(0, MAX_LINE)) : re.test(line)); // 变异：无行级预算',
  ].join('\n'),
  expect: ['预算用尽必须可见'],
  run: SUITE,
});

// ⑧ 预算本身失效（Infinity）→ 行级检查即使存在也永不触发
M.mutate({
  name: '⑧ 预算改成 Infinity（行级检查永不触发）',
  file: 'src/tools/fs-tools.js',
  from: '    const GREP_BUDGET_MS = 5000;',
  to: '    const GREP_BUDGET_MS = Infinity; // 变异：预算永不触发',
  expect: ['预算用尽必须可见'],
  run: SUITE,
});

// ⑨ 相邻量词把「有界」也当「无界」→ `a{1,3}a{1,3}` 被误伤（过严同样是缺陷）
M.mutate({
  name: '⑨ 相邻量词把有界量词也当无界（a{1,3}a{1,3} 被误拒）',
  file: 'src/regex-safety.js',
  from: [
    '      if (!a.quant || a.quant.max !== Infinity) continue;',
    '      if (!b.quant || b.quant.max !== Infinity) continue;',
  ].join('\n'),
  to: ['      if (!a.quant) continue; // 变异：有界也算无界', '      if (!b.quant) continue;'].join('\n'),
  expect: ['正常 pattern 不得被误拒'],
  run: SUITE,
});

// ⑩ 交替判据退回「首字符重叠就去重」→ `(abc|abd)+` 这类定长互斥分支被误拒（可用性回归）
M.mutate({
  name: '⑩ 交替判据退回首字符重叠（(abc|abd)+ 被误拒）',
  file: 'src/regex-safety.js',
  from: '      if (prefixComparable(nfaA, nfaB) || prefixComparable(nfaB, nfaA)) return true;',
  to: '      if (overlap(A.first, B.first)) return true; // 变异：退回按首字符判',
  expect: ['正常 pattern 不得被误拒'],
  run: SUITE,
});

// ⑪ formatter 缓存被摘掉 → 每次 beijingParts 都新建 Intl.DateTimeFormat
M.mutate({
  name: '⑪ formatter 缓存被摘掉（每次调用都新建 Intl.DateTimeFormat）',
  file: 'src/pricing.js',
  from: ['  let f = formatterCache.get(key);', '  if (f) return f;'].join('\n'),
  to: '  let f; // 变异：formatter 不再缓存',
  expect: ['2 万次 beijingParts 必须 <500ms', '不得每次新建 Intl.DateTimeFormat'],
  run: SUITE,
});

// ⑫ beijingParts 绕过缓存直接 new（回到 H-1 的原始写法）
M.mutate({
  name: '⑫ beijingParts 绕过缓存直接 new Intl.DateTimeFormat',
  file: 'src/pricing.js',
  from: [
    'export function beijingParts(date = new Date()) {',
    '  const tz = activeTimezone();',
    '  // H-1：formatter 按 tz 缓存（此前每次调用都新建 2 个 Intl.DateTimeFormat）',
    '  const parts = partsObject(formatterFor(tz, \'wall\').formatToParts(date));',
  ].join('\n'),
  to: [
    'export function beijingParts(date = new Date()) {',
    '  const tz = activeTimezone();',
    '  // 变异：绕过缓存直接 new',
    '  const parts = partsObject(new Intl.DateTimeFormat(\'en-US\', { timeZone: tz, year: \'numeric\', month: \'2-digit\', day: \'2-digit\', hour: \'2-digit\', minute: \'2-digit\', second: \'2-digit\', hourCycle: \'h23\' }).formatToParts(date));',
  ].join('\n'),
  expect: ['2 万次 beijingParts 必须 <500ms', '不得每次新建 Intl.DateTimeFormat'],
  run: SUITE,
});

// ⑬ byDay 退回「每条记录都 beijingParts」→ 格式化次数随记录数增长（H-1 的分桶部分回退）
M.mutate({
  name: '⑬ byDay 退回逐条 beijingParts（预计算日界分桶被拆掉）',
  file: 'src/cachestats.js',
  from: [
    '    if (e.at && e.at >= dayBounds[0] && e.at < tomorrowStart) {',
    '      let idx = DAYS - 1;',
    '      while (idx > 0 && e.at < dayBounds[idx]) idx -= 1;',
    '      const key = dayKeys[idx];',
    '      byDay.set(key, (byDay.get(key) || 0) + (e.cost || 0));',
    '    }',
  ].join('\n'),
  to: [
    '    if (e.at) {',
    '      const p = beijingParts(new Date(e.at));',
    '      const key = `${String(p.month).padStart(2, \'0\')}-${String(p.day).padStart(2, \'0\')}`;',
    '      byDay.set(key, (byDay.get(key) || 0) + (e.cost || 0));',
    '    }',
  ].join('\n'),
  expect: ['ICU 格式化次数必须与记录数无关'],
  run: SUITE,
});

// ⑭ 去掉「明日日界」保护 → 未来日记录被并进今天（静默多算今天的费用）
M.mutate({
  name: '⑭ 去掉未来日边界（未来日记录被并进今天的桶）',
  file: 'src/cachestats.js',
  from: '    if (e.at && e.at >= dayBounds[0] && e.at < tomorrowStart) {',
  to: '    if (e.at && e.at >= dayBounds[0]) { // 变异：未来日不再排除',
  expect: ['byDay 必须与旧逐条格式化算法逐条一致'],
  run: SUITE,
});

process.exit(M.report() ? 0 : 1);
