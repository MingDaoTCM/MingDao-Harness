// 覆盖率口径（v0.7.0 任务 1）的独立回归套件：**不拿真实仓库当唯一证据**。
//
// 背景：旧实现（v0.6.31 的 scripts/coverage-report.mjs:76-83）把文件里所有 `count>0` 的区间
// **取并集**判行覆盖。V8 区间是嵌套的，模块外壳（顶层函数体）区间横跨全文，于是"文件被 import 过"
// 就几乎整份文件算已覆盖：仓库自报 88.7%，真实 code-lines 只有 63.9%，"最低的 8 个文件"全显示
// 95–99%。这是把"检测到局部事实"当成"全局结论"的尺子坏了——修法必须**用构造的 V8 片段**
// 把算法本身钉住，而不是再信一次真实仓库的汇总数字。
//
// 本套件用手写 fixtures 断言三种口径（all-lines / code-lines / functions）：
//   ① 嵌套：父区间不得把未执行的子行算成已覆盖；
//   ② 兄弟：只按"最内层"判定，覆盖的兄弟算、未执行的兄弟不算；
//   ③ 整文件函数（模块外壳）与"未加载文件"；
//   ④ 未执行的函数不计入 functions；模块外壳不算函数；
//   ⑤ 纯注释文件 code-lines = 0，空文件给 0 且不崩；
//   ⑥ 三口径关系（分母不同、code ≥ all、functions 独立）；
//   ⑦ 多进程同一区间计数取最大值；
//   ⑧ ratchet：低于基线必须失败（相等/更高通过）。
//
// 运行：node test/coverage-metric.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildSourceModel,
  buildBaseline,
  computeFunctionCoverage,
  computeLineCoverage,
  evaluateRatchet,
  loadBaseline,
  metricOf,
  normalizeRanges,
  pctOf,
  summarizeCoverage,
} from '../scripts/coverage-report.mjs';

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`  ✓ ${name}`);
};

/** 在源码里定位一个唯一片段，返回它的起始偏移（fixtures 用可读的锚点，不手算数字）。 */
const at = (src, needle) => {
  const i = src.indexOf(needle);
  assert.ok(i >= 0, `fixture 锚点不存在：${JSON.stringify(needle)}`);
  assert.equal(src.indexOf(needle, i + 1), -1, `fixture 锚点必须唯一：${JSON.stringify(needle)}`);
  return i;
};

// ---------------------------------------------------------------------------
// ① 嵌套区间：父区间不覆盖子行
// ---------------------------------------------------------------------------
{
  const src = ['function outer() {', '  const a = 1;', '  if (false) {', '    const b = 2;', '  }', '  return a;', '}'].join('\n');
  const outerStart = at(src, 'function outer');
  const bStart = at(src, 'const b = 2;');
  const ifBody = { startOffset: bStart, endOffset: bStart + 'const b = 2;'.length, count: 0 };
  // outer 的计数 1 覆盖全文（正是旧并集算法"整份文件已覆盖"的来源）
  const ranges = [{ startOffset: outerStart, endOffset: src.length, count: 1 }, ifBody];

  const cov = computeLineCoverage(src, ranges);
  const bLine = cov.lines.find((l) => l.codeOffset === bStart);
  assert.equal(bLine.covered, false, '嵌套区间：父区间不得把未执行的子行算成已覆盖');
  assert.equal(bLine.count, 0, '嵌套区间：子行应取最内层（叶子）区间的计数 0，而不是父区间的 1');
  assert.equal(cov.code.covered, 6, '嵌套区间：7 行代码里只有 const b 这一行未执行（旧并集算法会给 7）');
  assert.equal(cov.code.total, 7, '嵌套区间：代码行数为 7');
  assert.equal(cov.all.covered, 6, '嵌套区间：all-lines 的分子同样只算有执行的代码行');
  ok('嵌套区间：父区间不覆盖未执行的子行（叶子计数）');
}

// ---------------------------------------------------------------------------
// ② 兄弟区间：并集只按最内层逐个判定
// ---------------------------------------------------------------------------
{
  const src = ['function pick(x) {', '  if (x) {', '    return 1;', '  }', '  return 2;', '}'].join('\n');
  const fnStart = at(src, 'function pick');
  const r1 = at(src, 'return 1;');
  const r2 = at(src, 'return 2;');
  const ranges = [
    { startOffset: fnStart, endOffset: src.length, count: 2 },
    { startOffset: r1, endOffset: r1 + 'return 1;'.length, count: 2 }, // 执行过的兄弟
    { startOffset: r2, endOffset: r2 + 'return 2;'.length, count: 0 }, // 没执行过的兄弟
  ];
  const cov = computeLineCoverage(src, ranges);
  const line1 = cov.lines.find((l) => l.codeOffset === r1);
  const line2 = cov.lines.find((l) => l.codeOffset === r2);
  assert.equal(line1.covered, true, '兄弟区间：执行过的兄弟行必须算已覆盖');
  assert.equal(line1.count, 2, '兄弟区间：执行过的兄弟行计数应为 2');
  assert.equal(line2.covered, false, '兄弟区间：未执行的兄弟行不得被另一个兄弟（或父区间）算成已覆盖');
  assert.equal(line2.count, 0, '兄弟区间：未执行兄弟行计数应为 0');
  assert.equal(cov.code.covered, 5, '兄弟区间：6 行代码里只有 return 2 未执行（旧并集算法会给 6）');
  ok('兄弟区间：覆盖的兄弟算、未执行的兄弟不算');
}

// ---------------------------------------------------------------------------
// ③ 整文件函数（模块外壳）与未加载文件
// ---------------------------------------------------------------------------
{
  const src = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
  const wrapper = { functionName: '', ranges: [{ startOffset: 0, endOffset: src.length, count: 1 }] };
  const cov = computeLineCoverage(src, wrapper.ranges);
  assert.equal(cov.all.total, 4, '整文件函数：源码 4 行（含结尾空行）');
  assert.equal(cov.code.total, 3, '整文件函数：3 行代码');
  assert.equal(cov.all.covered, 3, '整文件函数：外壳计数 1 → 3 行代码全部已覆盖');
  assert.equal(pctOf(cov.code.covered, cov.code.total), 100, '整文件函数：覆盖率 100%');

  const fnCov = computeFunctionCoverage([wrapper], src.length);
  assert.equal(fnCov.total, 0, '整文件函数：模块外壳不计入 functions 口径（它不是业务函数）');
  assert.equal(fnCov.wrappers, 1, '整文件函数：模块外壳被识别并排除');

  // 未加载文件：V8 数据里根本没有它 → 区间为空，必须按"全部未覆盖"计入分母，且不崩
  const missing = computeLineCoverage(src, []);
  assert.equal(missing.code.covered, 0, '未加载文件：无区间时全部按未覆盖计');
  assert.equal(missing.code.total, 3, '未加载文件：分母仍是文件真实代码行数');
  assert.equal(pctOf(missing.code.covered, missing.code.total), 0, '未加载文件：覆盖率 0% 而不是被静默剔除');
  ok('整文件函数 / 未加载文件：外壳判据与 0 覆盖分母');
}

// ---------------------------------------------------------------------------
// ④ 函数级：未执行的函数不计，外壳也不算
// ---------------------------------------------------------------------------
{
  const src = 'function called() {\n  return 1;\n}\nfunction neverCalled() {\n  return 2;\n}\n';
  const wrapper = { functionName: '', ranges: [{ startOffset: 0, endOffset: src.length, count: 1 }] };
  const called = { functionName: 'called', ranges: [{ startOffset: at(src, 'function called'), endOffset: at(src, 'function neverCalled'), count: 3 }] };
  const never = { functionName: 'neverCalled', ranges: [{ startOffset: at(src, 'function neverCalled'), endOffset: src.length, count: 0 }] };
  const fnCov = computeFunctionCoverage([wrapper, called, never], src.length);
  assert.equal(fnCov.total, 2, '函数级：模块外壳除外，共 2 个业务函数');
  assert.equal(fnCov.covered, 1, '函数级：只有 called 被调用过（未执行的函数不得计入已覆盖）');
  assert.equal(fnCov.wrappers, 1, '函数级：外壳被排除');
  assert.equal(pctOf(fnCov.covered, fnCov.total), 50, '函数级：未执行的函数不得计入已覆盖（1/2 = 50%）');
  assert.equal(metricOf(fnCov.covered, fnCov.total).pct, 50, '函数级：metricOf 与 pctOf 一致');
  ok('函数级：未执行的函数不计入已覆盖');
}

// ---------------------------------------------------------------------------
// ⑤ 纯注释文件 = 0，空文件不崩（分母 0 不是 NaN）
// ---------------------------------------------------------------------------
{
  const comments = '// 只有注释\n/* 块注释\n   还在注释里 */\n';
  const cov = computeLineCoverage(comments, []);
  assert.equal(cov.code.total, 0, '纯注释文件：code-lines 分母必须为 0（排除空行与纯注释行）');
  assert.equal(cov.all.total, 4, '纯注释文件：all-lines 仍计入 4 行');
  assert.equal(cov.all.covered, 0, '纯注释文件：没有可执行的代码行，不可能有已覆盖行');
  assert.equal(pctOf(cov.code.covered, cov.code.total), 0, '纯注释文件 code-lines 必须为 0（分母 0 时不得是 NaN）');
  assert.equal(pctOf(cov.all.covered, cov.all.total), 0, '纯注释文件：all-lines 也是 0%');

  assert.doesNotThrow(() => computeLineCoverage('', []), '空文件不得抛错（空源码是合法输入）');
  const empty = computeLineCoverage('', []);
  assert.equal(empty.code.total, 0, '空文件：code-lines 分母 0');
  assert.equal(empty.all.total, 1, '空文件：all-lines 1 行（split(\'\\n\') 语义，含唯一空行）');
  assert.equal(pctOf(empty.all.covered, empty.all.total), 0, '空文件：0% 而不是 NaN');

  const blankModel = buildSourceModel('\n\n');
  assert.equal(blankModel.lines.length, 3, '行模型：两个换行 = 3 个空行（与 split 一致）');
  assert.deepEqual(blankModel.lines.map((l) => l.kind), ['blank', 'blank', 'blank'], '行模型：纯空白行都是 blank');
  const kindModel = buildSourceModel('// 行注释\n/* 块注释 */\nconst a = 1; // 尾注释\n');
  assert.deepEqual(kindModel.lines.map((l) => l.kind), ['comment', 'comment', 'code', 'blank'], '行模型：// 与 /* */ 注释行必须归为 comment（不能算 blank）');
  ok('纯注释文件 code-lines = 0、空文件不崩、空行分类正确');
}

// ---------------------------------------------------------------------------
// ⑥ 三口径关系：分母不同、code ≥ all、functions 独立（集成 summarizeCoverage）
// ---------------------------------------------------------------------------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-cov-metric-'));
  try {
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    const aSrc = ['// 文件头注释', 'const A = 1;', '', 'function never() {', '  return 42;', '}'].join('\n');
    const bSrc = 'const B = 2;\n';
    const aPath = path.join(tmp, 'src', 'a.js');
    const bPath = path.join(tmp, 'src', 'b.js');
    fs.writeFileSync(aPath, aSrc);
    fs.writeFileSync(bPath, bSrc);

    const covDir = path.join(tmp, 'cov');
    fs.mkdirSync(covDir);
    // a.js 被加载：外壳（1）+ 一个被调用的函数 + 一个从未调用的函数；
    // 从未调用的函数区间覆盖 `function never() { … }`（V8 语义下的 count=0 叶子）。
    const neverStart = at(aSrc, 'function never');
    const functions = [
      { functionName: '', ranges: [{ startOffset: 0, endOffset: aSrc.length, count: 1 }] },
      { functionName: 'never', ranges: [{ startOffset: neverStart, endOffset: aSrc.length, count: 0 }] },
    ];
    fs.writeFileSync(
      path.join(covDir, 'coverage-1.json'),
      JSON.stringify({ result: [{ url: pathToFileURL(aPath).href, functions }] })
    );

    const s = summarizeCoverage(covDir, { root: tmp, srcFiles: [aPath, bPath] });
    // a.js: 6 行（1 注释 / 4 代码 + 1 空行）; b.js 未加载: 2 行（1 代码 + 结尾空行）
    const aLines = aSrc.split('\n').length; // 6
    // 代码行 = 第 2、4、5、6 行（第 1 行纯注释、第 3 行空行；第 4-6 行属于 count=0 的函数叶子）
    const aCode = 4;
    assert.equal(s.metrics['all-lines'].total, aLines + bSrc.split('\n').length, 'all-lines 分母必须包含空行与注释行（不能拿 code-lines 顶替）');
    assert.equal(s.metrics['code-lines'].total, aCode + 1, 'code-lines 分母 = 排除空行/纯注释行后的代码行');
    assert.ok(s.metrics['all-lines'].total > s.metrics['code-lines'].total, 'all-lines 的分母必须严格大于 code-lines（本 fixture 有空行与注释）');
    assert.ok(s.metrics['code-lines'].pct >= s.metrics['all-lines'].pct, '三口径关系：code-lines 百分比不得低于 all-lines（分子相同、分母更小）');
    assert.equal(s.metrics['code-lines'].covered, s.metrics['all-lines'].covered, '三口径关系：all-lines 的分子就是有执行的代码行');
    assert.equal(s.unloaded.length, 1, '未加载文件仍进分母（b.js）');
    assert.equal(s.metrics.functions.covered, 0, '函数级：本次 fixture 里唯一业务函数从未调用 → 0 个已覆盖');
    assert.equal(s.metrics.functions.total, 1, '函数级：模块外壳不计入，业务函数共 1 个');
    assert.equal(s.metrics.functions.pct, 0, '函数级：独立于行口径（行有覆盖，函数可以是 0）');
    ok('三口径：分母不同、code ≥ all、functions 独立（含未加载文件）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// ⑦ 多进程合并：同一区间计数取最大值
// ---------------------------------------------------------------------------
{
  const src = 'function f() {\n  return 1;\n}\n';
  const span = { startOffset: 0, endOffset: src.length };
  const merged = normalizeRanges([
    { ...span, count: 0 }, // 先到的子进程：没执行
    { ...span, count: 3 }, // 后到的父进程：执行过 3 次
  ]);
  assert.equal(merged.length, 1, '区间合并：同一 [start,end) 只保留一条');
  assert.equal(merged[0].count, 3, '区间合并：同一区间在多个覆盖率文件里计数不同时必须取最大值（不能被 0 覆盖）');
  const cov = computeLineCoverage(src, [
    { ...span, count: 0 },
    { ...span, count: 3 },
  ]);
  assert.ok(cov.code.covered > 0, '区间合并：任一进程执行过，该行就算已覆盖（子进程的 0 不得覆盖父进程的 3）');
  ok('多进程合并：同一区间取最大计数');
}

// ---------------------------------------------------------------------------
// ⑧ 棘轮：低于基线失败，等于/高于通过；基线对象含时间与 node 版本
// ---------------------------------------------------------------------------
{
  const baseline = {
    metrics: {
      'code-lines': { covered: 6390, total: 10000, pct: 63.9 },
      'all-lines': { covered: 7050, total: 10000, pct: 70.5 },
      functions: { covered: 500, total: 1000, pct: 50 },
    },
  };
  const cur = (code, all, fn) => ({
    'code-lines': metricOf(code, 100),
    'all-lines': metricOf(all, 100),
    functions: metricOf(fn, 100),
  });
  const lower = evaluateRatchet(cur(62, 70, 49), baseline);
  const codeRow = lower.find((r) => r.metric === 'code-lines');
  assert.equal(codeRow.ok, false, '低于基线必须判失败（ratchet 生效）');
  assert.equal(codeRow.delta, -1.9, '棘轮：回归幅度 = 当前 - 基线（1 位小数）');
  assert.equal(lower.find((r) => r.metric === 'all-lines').ok, false, '棘轮：all-lines 低于基线同样失败');
  assert.equal(lower.find((r) => r.metric === 'functions').ok, false, '棘轮：functions 低于基线同样失败');

  const equal = evaluateRatchet(cur(63.9, 70.5, 50), baseline);
  assert.ok(equal.every((r) => r.ok), '棘轮：等于基线必须通过（只许升不许降）');

  const withinTolerance = evaluateRatchet(cur(63.8, 70.4, 49.9), baseline);
  assert.ok(withinTolerance.every((r) => r.ok), '棘轮：-0.2pp 容差内通过（只吸收四舍五入/同提交噪声）');
  const beyondTolerance = evaluateRatchet(cur(63.6, 70.5, 50), baseline);
  assert.equal(beyondTolerance.find((r) => r.metric === 'code-lines').ok, false, '棘轮：超出 -0.2pp 容差必须判失败（容差不是"允许慢慢降"）');

  const better = evaluateRatchet(cur(64.9, 70.5, 50), baseline);
  const betterRow = better.find((r) => r.metric === 'code-lines');
  assert.equal(betterRow.ok, true, '棘轮：高于基线通过');
  assert.equal(betterRow.delta, 1, '棘轮：+1pp 提升被记录（提醒可抬升基线）');

  const noBaseline = evaluateRatchet(cur(1, 1, 1), null);
  assert.ok(noBaseline.every((r) => r.ok && r.baseline === null), '棘轮：没有基线时不做比较，不能因此失败（但输出会提示建基线）');

  const built = buildBaseline({ 'code-lines': { covered: 1, total: 2 }, 'all-lines': { covered: 2, total: 4 }, functions: { covered: 3, total: 4 } }, { generatedAt: '2026-11-04T00:00:00Z', nodeVersion: 'v24.0.0', srcFiles: 2 });
  assert.equal(built.metrics['code-lines'].pct, 50, '基线对象：三口径都写入');
  assert.equal(built.metrics['all-lines'].pct, 50, '基线对象：all-lines 写入');
  assert.equal(built.metrics.functions.pct, 75, '基线对象：functions 写入');
  assert.equal(built.generatedAt, '2026-11-04T00:00:00Z', '基线对象：必须记录生成时间');
  assert.equal(built.node, 'v24.0.0', '基线对象：必须记录 node 版本');
  assert.equal(Object.hasOwn(built, 'note'), false, '基线对象：没有 note 时不写该字段');
  const noted = buildBaseline({ 'code-lines': { covered: 1, total: 2 }, 'all-lines': { covered: 2, total: 4 }, functions: { covered: 3, total: 4 } }, { note: '过渡基线；发布前重生成' });
  assert.equal(noted.note, '过渡基线；发布前重生成', '基线对象：note 必须保留（说明这是过渡基线）');

  assert.equal(loadBaseline(path.join(os.tmpdir(), 'definitely-missing-baseline.json')), null, '基线缺失时 loadBaseline 返回 null（不崩）');
  ok('棘轮：低于基线失败、相等/更高通过、基线含时间与 node 版本');
}

console.log(`\n覆盖率口径：${passed} 项通过`);
