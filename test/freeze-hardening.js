// 事件循环冻结加固回归（v0.6.30，第三方代码审计 C-1 / H-13 + 核验报告 C-1 / H-1）。
//
// 两条缺陷的共性：**同步** 工作落在事件循环主线程上，而输入来自不可信文本（模型给的 grep
// pattern / 20KB 单行文件 / 2 万条费用记录）——一旦触发，HTTP、SSE 心跳、权限弹窗、watchdog
// 全部一起冻死，连 setTimeout 都不触发。所以本套件的断言不是"函数返回了什么"，而是
// **"它有没有在预算内返回"**：
//
//   A1 ReDoS：12 个恶意 pattern 必须被 grep **在装载时拒绝并给出可见原因**（<1s）；
//             `a{1,3}a{1,3}`、`(abc)+` 等正常 pattern 不得误伤；20KB 单行正常 grep ≤2s；
//             5s 预算必须**下推到行级**（假时钟证明 testLine 前后都在查预算）。
//   A2 计时：2 万次 beijingParts <500ms；2 万条 costBreakdown <500ms；
//             byDay 与**旧逐条格式化算法**对拍逐条一致（含 12:00/18:00/23:59:59/00:00:01、
//             跨月/跨年边界、未来日记录）；formatter 构造/格式化次数不随记录数增长。
//
// 为什么单独成一套（而不是塞进 smoke.js）：本文件是 test/mutate/batch61-freeze-hardening.mjs
// 的判定入口，且 smoke.js 本轮禁止改动。运行：node test/freeze-hardening.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-freeze-'));
process.env.MINGDAO_HOME = home;

let passed = 0;
/** @param {string} name */
function ok(name) {
  passed += 1;
  console.log(`  ✓ ${name}`);
}
/** @param {string} rel */
const load = (rel) => import(pathToFileURL(path.join(srcDir, rel)).href);
const pad2 = (/** @type {number} */ n) => String(n).padStart(2, '0');
const dayKey = (/** @type {any} */ p) => `${pad2(p.month)}-${pad2(p.day)}`;

// ─────────────────────────────────────────────────────────────────────────────
// A1：ReDoS —— 12 个恶意 pattern（含交替型、相邻无界量词、语义等价写法）
// ─────────────────────────────────────────────────────────────────────────────
const MALICIOUS = [
  'a*a*a*a*a*a*a*a*b', // 相邻无界量词 ×8：20KB 单行实测 >45s，watchdog 不触发
  'a*a*', // 相邻无界量词（最小形）
  '\\d+\\d*', // 相邻无界量词：同一字符类
  '.*.*', // 相邻无界量词：任意字符
  '^(\\d|[\\d])+$', // 交替型 + 语义等价写法（审计 H-13，改前 29 字符 9.6~19s）
  '(a|aa)+', // 交替型：分支前缀退化
  '(x|xx)+', // 交替型：分支前缀退化（x 是 xx 的前缀）
  '(x|xx)*', // 交替型：同上，量词为 *
  '(a|a?)+', // 交替型：分支可空
  '(a|)+', // 交替型：空分支（只有「可空分支」判据能抓住）
  '((a|ab)x)+', // 交替型：嵌套组内的歧义分支
  '(a+)+', // 嵌套量词
  '(\\d+)*', // 嵌套量词
  '(?:ab|abc)+', // 交替型：多字符分支前缀退化
];
const SAFE = [
  'a{1,3}a{1,3}', // 有界量词相邻：不构成组合爆炸
  '(abc)+', // 单分支重复
  '(a|b)+', // 无重叠分支
  '(abc|abd)+', // 定长互斥分支：既非前缀也不共串 → 回溯线性（v0.6.31 收紧假阳性）
  '(?:ab|ac)+', // 同上：第二个字符互斥
  '(ab|b)+', // b 是 ab 的后缀但非前缀：重复边界唯一 → 放行
  '.*\\d+', // 单侧通配相邻：实测 20KB 约 160ms，线性可接受；靠行级预算兜底
  '\\w+\\s+\\d+', // 字符集互斥的相邻无界量词
  '[a-z]+@[a-z]+', // 字面量 @ 隔开
  '\\d{3}-\\d{4}',
  '^[a-z]+$',
  'a*b*', // 相邻无界但字符集互斥
  '\\s*\\w+', // 相邻无界但空白与 \w 不重叠
  '\\d+\\.\\d+', // 字面量分隔
  '.*error.*', // 字面量分隔的 .*
];

async function suiteA1(/** @type {any} */ R, /** @type {any} */ C) {
  // ① 每个恶意 pattern 单独断言 + 计时（12 条 ok）
  for (const p of MALICIOUS) {
    const t0 = Date.now();
    const why = R.patternRejectionReason(p);
    const ms = Date.now() - t0;
    assert.ok(why, `恶意 pattern 必须被拒：${p}`);
    assert.ok(/嵌套量词|歧义分支|相邻无界量词/.test(why), `拒绝原因必须写清形态：${p} → ${why}`);
    assert.ok(ms < 1000, `装载判定本身必须 <1s：${p} 用了 ${ms}ms`);
    ok(`A1 拒绝 ${p}（${ms}ms，原因=${why.slice(0, 18)}…）`);
  }
  // ② 正常 pattern 不得误伤（2 条 ok）
  for (const p of SAFE) {
    assert.equal(R.patternRejectionReason(p), null, `正常 pattern 不得被误拒：${p}`);
    ok(`A1 放行 ${p}`);
  }
  // ③ 相邻无界量词：专门判据必须命中；字符集互斥的相邻量词不得命中
  for (const p of ['a*a*', '\\d+\\d*', '.*.*', 'a*a*a*a*a*a*a*a*b', '(?:ab|aa)+b*']) {
    assert.equal(R.hasAdjacentUnboundedQuantifiers(p), true, `必须判为相邻无界量词：${p}`);
  }
  for (const p of ['a*b*', '\\s*\\w+', 'a{1,3}a{1,3}', '.*\\d+', '\\w+.*', 'a+.*', '\\w+\\s+\\d+']) {
    assert.equal(R.hasAdjacentUnboundedQuantifiers(p), false, `不得把字符集互斥/有界/单侧通配的相邻量词判成危险：${p}`);
  }
  // ④ 交替型：分支前缀/后缀退化与语义等价写法都必须被归一化判定抓住
  for (const p of ['(x|xx)+', '(a|aa)+', '^(\\d|[\\d])+$', '((a|ab)x)+', '(a|a?)+']) {
    assert.equal(R.hasAmbiguousAlternation(p), true, `必须判为交替重复歧义：${p}`);
  }
  assert.equal(R.hasAmbiguousAlternation('(a|b)+'), false, '(a|b)+ 分支首字符互斥，不得误伤');
  assert.equal(R.hasAmbiguousAlternation('(abc|abd)+'), false, '(abc|abd)+ 定长互斥，不得误伤');
  assert.equal(R.hasAmbiguousAlternation('(?:ab|ac)+'), false, '(?:ab|ac)+ 第二字符互斥，不得误伤');
  assert.equal(R.hasAmbiguousAlternation('(ab|b)+'), false, '(ab|b)+ 只有后缀关系、重复边界唯一，不得误伤');
  ok('A1 交替型（x|xx、a|aa、\\d|[\\d]）与相邻无界量词判定均命中，互斥分支不误伤');

  // ⑤ 端到端：12 个恶意 pattern 走 grep 工具，必须 <1s 被拒且原因可见。
  // 用子进程 + 硬超时：若判据被改回旧版（放行），子进程会在第一条 pattern 上同步冻死，
  // 由父进程 kill 并让本断言当场变红——测试自己绝不会被 ReDoS 拖住。
  const probe = /* js */ `
    import path from 'node:path';
    import { pathToFileURL } from 'node:url';
    // Windows 腿（v0.6.30）：动态 import 的 specifier **必须是 URL**。裸绝对路径在 POSIX 上
    // 恰好被当成文件路径接受，但在 Windows 上 'D:\\...' 会被解析成 scheme 'd:' →
    // ERR_UNSUPPORTED_ESM_URL_SCHEME，子进程直接崩，整批变异被误判成「逃逸」。
    // 父进程与子进程都在这里统一走 pathToFileURL。
    const { dispatch } = await import(pathToFileURL(path.join(process.env.PROBE_SRC, 'tools', 'index.js')).href);
    const patterns = JSON.parse(process.env.PROBE_PATTERNS);
    for (const pattern of patterns) {
      const t0 = Date.now();
      const res = await dispatch('grep', { pattern, path: process.env.PROBE_DIR }, { cwd: process.env.PROBE_DIR, cfg: {} });
      console.log(JSON.stringify({ pattern, ms: Date.now() - t0, rejected: res.ok === false, error: String(res.error || '') }));
    }
  `;
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-freeze-probe-'));
  fs.writeFileSync(path.join(probeDir, 'big.txt'), 'a'.repeat(20000) + '\n');
  fs.writeFileSync(path.join(probeDir, 'digits.txt'), '1'.repeat(20000) + '\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: root,
    encoding: 'utf8',
    timeout: 8000,
    env: { ...process.env, PROBE_SRC: srcDir, PROBE_DIR: probeDir, PROBE_PATTERNS: JSON.stringify(MALICIOUS) },
  });
  fs.rmSync(probeDir, { recursive: true, force: true });
  assert.equal(child.status, 0, `${MALICIOUS.length} 个恶意 pattern 必须在 <1s 内被拒/返回；子进程未正常退出（status=${child.status}，signal=${child.signal}，stderr=${String(child.stderr).slice(0, 200)}）`);
  const rows = String(child.stdout)
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l));
  assert.equal(rows.length, MALICIOUS.length, `${MALICIOUS.length} 个恶意 pattern 都必须有结果（实际 ${rows.length}）`);
  for (const row of rows) {
    assert.equal(row.rejected, true, `grep 必须拒绝恶意 pattern：${row.pattern}`);
    assert.ok(/正则被拒/.test(row.error), `grep 拒绝时必须给出可见原因（含「正则被拒」）：${row.pattern} → ${row.error}`);
    assert.ok(row.ms < 1000, `grep 必须在 <1s 内拒绝：${row.pattern} 用了 ${row.ms}ms`);
  }
  ok(`A1 grep 端到端：${MALICIOUS.length} 个恶意 pattern 全部 <1s 被拒，且原因可见（子进程硬超时兜底）`);

  // ⑥ 行级预算：用假时钟证明 testLine **前后都查**预算、行循环立即停扫。
  // 旧实现只在「文件开始前」查预算 → 不会在扫描该文件时命中，匹配会照常返回。
  const budgetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-freeze-budget-'));
  const budgetFile = path.join(budgetDir, 'x.txt');
  fs.writeFileSync(budgetFile, 'needle here\nneedle again\n');
  const realStat = fs.statSync;
  const realNow = Date.now;
  let armed = false;
  // 文件被 stat 之后（即文件级预算检查已通过）把时钟拨快 6s
  fs.statSync = /** @type {any} */ ((p, ...a) => {
    const r = realStat(p, ...a);
    if (String(p) === budgetFile) armed = true;
    return r;
  });
  Date.now = () => (armed ? realNow() + 6000 : realNow());
  let budgetRes;
  try {
    budgetRes = await import(pathToFileURL(path.join(srcDir, 'tools', 'fs-tools.js')).href).then((m) =>
      m.grep({ pattern: 'needle', path: budgetDir }, { cwd: budgetDir, cfg: {} })
    );
  } finally {
    fs.statSync = realStat;
    Date.now = realNow;
    fs.rmSync(budgetDir, { recursive: true, force: true });
  }
  assert.equal(budgetRes.ok, true, '行级预算命中时 grep 仍应正常返回（带提示），不是报错');
  assert.match(budgetRes.output, /已用满 5s 时间预算（行级检查）/, '预算用尽必须可见，且应标明是行级检查');
  assert.match(budgetRes.output, /\(无匹配\)/, '预算在第一条 line 即命中：不得再返回匹配（旧实现会返回 needle）');
  ok('A1 5s 预算已下推到行级（testLine 前后检查，行循环立即停扫）');

  // ⑦ 正常 grep 在 20KB 单行文件上必须在 2s 内完成（含一个确实需要扫描整行的 pattern）
  const okDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-freeze-okgrep-'));
  fs.writeFileSync(path.join(okDir, 'big.txt'), 'a'.repeat(20000) + 'needle\n');
  fs.writeFileSync(path.join(okDir, 'many.txt'), Array.from({ length: 200 }, (_, i) => `line-${i} needle-${i}`).join('\n') + '\n');
  const { grep } = await load('tools/fs-tools.js');
  const t0 = Date.now();
  const normal = grep({ pattern: 'a+b', path: okDir }, { cwd: okDir, cfg: {} });
  const normalMs = Date.now() - t0;
  assert.equal(normal.ok, true, '正常 pattern 不得被判危险');
  assert.ok(normalMs < 2000, `20KB 单行正常 grep 必须 ≤2s（实际 ${normalMs}ms）`);
  const multi = grep({ pattern: 'needle-\\d+', path: okDir }, { cwd: okDir, cfg: {} });
  assert.equal(multi.ok, true);
  assert.match(multi.output, /many\.txt:1:/, '多行文件正常匹配不得丢');
  fs.rmSync(okDir, { recursive: true, force: true });
  ok(`A1 20KB 单行正常 grep ${normalMs}ms（≤2s），多行匹配正常`);

  // ⑦b 曾经被旧「首字符重叠」判据误伤的四个真实 pattern：必须放行，且 20KB 单行 grep 在预算内
  const fpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-freeze-fp-'));
  fs.writeFileSync(path.join(fpDir, 'a.txt'), 'a'.repeat(20000) + '\n');
  fs.writeFileSync(path.join(fpDir, 'abc.txt'), 'abcabd'.repeat(3300) + 'x\n');
  for (const p of ['(abc|abd)+', '.*\\d+', '\\w+\\s+\\d+', '[a-z]+@[a-z]+']) {
    assert.equal(R.patternRejectionReason(p), null, `用户真会用的 pattern 不得误拒：${p}`);
    const t = Date.now();
    const r = grep({ pattern: p, path: fpDir }, { cwd: fpDir, cfg: {} });
    const ms = Date.now() - t;
    assert.equal(r.ok, true, `放行的 pattern 必须能真正执行：${p}（${r.error || ''}）`);
    assert.ok(ms < 2000, `20KB 单行 grep 必须在预算内返回：${p} 用了 ${ms}ms`);
  }
  fs.rmSync(fpDir, { recursive: true, force: true });
  ok('A1 收紧假阳性：(abc|abd)+、.*\\d+、\\w+\\s+\\d+、[a-z]+@[a-z]+ 均放行且 20KB 单行 ≤2s');

  // ⑧ 单一来源：grep 只复用 patternRejectionReason，不再维护第二份判据
  const ftSrc = fs.readFileSync(path.join(srcDir, 'tools', 'fs-tools.js'), 'utf8');
  assert.match(ftSrc, /import \{ patternRejectionReason \} from '\.\.\/regex-safety\.js'/, 'grep 必须复用 regex-safety.patternRejectionReason');
  assert.ok(!/function hasAmbiguousAlternation/.test(ftSrc), 'grep 不得再维护第二份歧义分支判定');
  assert.match(ftSrc, /const overBudget = \(\) => Date\.now\(\) - grepStart > GREP_BUDGET_MS/, '必须有行级预算判据');
  assert.match(ftSrc, /if \(budgetHit\) return false; \/\/ 行级预算用尽/, '行循环必须在预算命中后立即停扫');
  assert.match(ftSrc, /正则被拒：/, '拒绝原因必须可见（「正则被拒：」前缀）');
  ok('A1 grep 判据单一来源（patternRejectionReason），拒绝原因可见');

  // ⑨ Pack / 约束引擎同口径（output-forbid、result-forbid 不得再被语义等价写法绕过）
  for (const p of ['a*a*a*a*a*a*a*a*b', '^(\\d|[\\d])+$', '(x|xx)+', '(x|xx)*']) {
    assert.equal(C.isValidPattern(p), false, `约束引擎也必须拒：${p}`);
  }
  for (const p of ['(abc|abd)+', '.*\\d+', '\\w+\\s+\\d+', '[a-z]+@[a-z]+']) {
    assert.equal(C.isValidPattern(p), true, `约束引擎也不得误拒：${p}`);
  }
  const compiled = C.compileConstraints([
    { id: 'redos-out', kind: 'output-forbid', pattern: 'a*a*a*a*a*a*a*a*b', action: 'block' },
    { id: 'redos-res', kind: 'result-forbid', tool: 'read', pattern: '^(\\d|[\\d])+$' },
  ]);
  assert.ok(compiled.invalid.some((/** @type {any} */ x) => String(x).includes('redos-out')), 'Pack 的 output-forbid 危险正则必须在装载时进 invalid（可见）');
  assert.ok(compiled.broken.some((/** @type {any} */ c) => c.id === 'redos-res'), 'Pack 的 result-forbid 危险正则必须 fail-closed 保留并标记 broken');
  ok('A1 Pack / 约束引擎（output-forbid、result-forbid）同口径拒绝，不再漏语义等价写法');
}

// ─────────────────────────────────────────────────────────────────────────────
// A2：beijingParts / costBreakdown —— formatter 缓存 + 预计算日界分桶
// ─────────────────────────────────────────────────────────────────────────────
function withPatchedIntl(/** @type {() => any} */ fn) {
  const Orig = Intl.DateTimeFormat;
  let constructs = 0;
  // 统计 formatter 构造次数：缓存失效时 2 万次调用 = 2 万次构造
  // @ts-ignore 测试内替换内建构造器
  Intl.DateTimeFormat = class extends Orig {
    constructor(/** @type {any[]} */ ...args) {
      // @ts-ignore 透传给原构造器
      super(...args);
      constructs += 1;
    }
  };
  try {
    const out = fn();
    return { out, constructs };
  } finally {
    Intl.DateTimeFormat = Orig;
  }
}

function countFormatCalls(/** @type {() => any} */ fn) {
  const proto = Intl.DateTimeFormat.prototype;
  const orig = proto.formatToParts;
  let calls = 0;
  proto.formatToParts = /** @type {any} */ (function (/** @type {any[]} */ ...args) {
    calls += 1;
    return orig.apply(this, args);
  });
  try {
    const out = fn();
    return { out, calls };
  } finally {
    proto.formatToParts = orig;
  }
}

function oldByDay(/** @type {any} */ P, /** @type {any[]} */ entries) {
  // 旧实现：每条记录 new Date + beijingParts 再取 MM-DD key；日界标签同样逐日格式化。
  const start = P.beijingDayStart(new Date()).getTime();
  const map = new Map();
  for (const e of entries) {
    if (!e.at) continue;
    const p = P.beijingParts(new Date(e.at));
    const key = dayKey(p);
    map.set(key, (map.get(key) || 0) + (e.cost || 0));
  }
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const p = P.beijingParts(new Date(start - i * 86400000));
    const key = dayKey(p);
    days.push({ day: key, cost: map.get(key) || 0 });
  }
  return days;
}

async function suiteA2(/** @type {any} */ P, /** @type {any} */ C) {
  const N = 20000;
  const base = Date.UTC(2026, 9, 20, 4, 0, 0); // 2026-10-20 12:00 北京
  const stamps = Array.from({ length: N }, (_, i) => new Date(base + i * 60000));

  // ① 2 万次 beijingParts <500ms（改前 0.042~0.408 ms/op → 0.85~8.16s）
  const t0 = Date.now();
  let acc = 0;
  for (const d of stamps) acc += P.beijingParts(d).day;
  const bpMs = Date.now() - t0;
  assert.ok(bpMs < 500, `2 万次 beijingParts 必须 <500ms（实际 ${bpMs}ms）`);
  assert.ok(acc > 0);
  ok(`A2 2 万次 beijingParts ${bpMs}ms（<500ms）`);

  // ② formatter 缓存：再跑 2 万次，构造次数不得随调用次数增长
  const warm = withPatchedIntl(() => {
    let s = 0;
    for (const d of stamps) s += P.beijingParts(d).hour;
    return s;
  });
  assert.ok(warm.constructs <= 4, `beijingParts 不得每次新建 Intl.DateTimeFormat（2 万次构造 ${warm.constructs} 次）`);
  ok(`A2 formatter 按 tz 缓存（2 万次调用仅构造 ${warm.constructs} 个）`);

  // ③ 缓存结果与「每次新建 formatter」逐字段一致（含 12:00/18:00/23:59:59/00:00:01）
  const moments = ['2026-11-02T12:00:00+08:00', '2026-11-02T18:00:00+08:00', '2026-11-02T23:59:59+08:00', '2026-11-03T00:00:01+08:00'];
  for (const iso of moments) {
    const d = new Date(iso);
    const got = P.beijingParts(d);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(d);
    const g = (/** @type {string} */ t) => Number(parts.find((p) => p.type === t)?.value);
    assert.deepEqual(got, { year: g('year'), month: g('month'), day: g('day'), hour: g('hour'), minute: g('minute'), second: g('second') }, `缓存后的 beijingParts 必须与新建 formatter 一致：${iso}`);
  }
  ok('A2 边界时刻（12:00/18:00/23:59:59/00:00:01）缓存结果与新建 formatter 逐字段一致');

  // ④ 跨月/跨年边界的墙钟与 Date 互转
  const crossChecks = [
    { p: { year: 2025, month: 12, day: 31, hour: 23, minute: 59, second: 59 }, label: '跨年 2025-12-31 23:59:59' },
    { p: { year: 2026, month: 1, day: 1, hour: 0, minute: 0, second: 1 }, label: '跨年 2026-01-01 00:00:01' },
    { p: { year: 2026, month: 10, day: 31, hour: 23, minute: 59, second: 59 }, label: '跨月 10-31 23:59:59' },
    { p: { year: 2026, month: 11, day: 1, hour: 0, minute: 0, second: 1 }, label: '跨月 11-01 00:00:01' },
  ];
  for (const { p, label } of crossChecks) {
    const back = P.beijingParts(P.beijingToDate(p));
    assert.deepEqual(back, p, `墙钟 ↔ Date 必须可逆：${label}`);
  }
  ok('A2 跨月/跨年边界墙钟 ↔ Date 可逆（4 个边界时刻）');

  // ⑤ byDay 对拍：2 万条记录（含 00:00:01/12:00/18:00/23:59:59、未来日、窗口外旧记录）逐条一致
  const now = Date.now();
  const dayStart = P.beijingDayStart(new Date(now)).getTime();
  const ats = [];
  for (let d = 19; d >= 0; d--) {
    for (const [h, m, s] of [[0, 0, 1], [12, 0, 0], [18, 0, 0], [23, 59, 59]]) {
      ats.push(dayStart - d * 86400000 + ((h * 60 + m) * 60 + s) * 1000);
    }
  }
  ats.push(dayStart + 86400000 + 3600000, dayStart + 3 * 86400000, now + 7200000); // 未来日
  while (ats.length < N) ats.push(now - ats.length * 60000);
  const entries = ats.slice(0, N).map((at, i) => ({
    at,
    model: 'deepseek-flash',
    prompt: 100,
    completion: 20,
    hit: 10,
    miss: 90,
    cost: 0.001 * (i % 7),
    saved: 0.0001,
  }));
  fs.writeFileSync(path.join(home, 'cache-stats.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');

  const bd = C.costBreakdown();
  const refDays = oldByDay(P, entries);
  assert.deepEqual(bd.byDay, refDays, 'costBreakdown 的 byDay 必须与旧逐条格式化算法逐条一致（含边界与未来日记录）');
  const refToday = entries.filter((e) => e.at >= dayStart).reduce((a, e) => a + e.cost, 0);
  assert.ok(Math.abs(bd.today - refToday) < 1e-9, `today 汇总必须一致（实际 ${bd.today} vs ${refToday}）`);
  ok(`A2 byDay 对拍 2 万条逐条一致（14 天窗口 + 未来日 + 00:00:01/23:59:59 边界）`);

  // ⑥ 2 万条 costBreakdown <500ms，且格式化次数与记录条数**无关**（预计算日界，不是逐条格式化）
  const t1 = Date.now();
  C.costBreakdown(); // 已解析过文件，避开 JSON 解析噪声
  const bdMs = Date.now() - t1;
  assert.ok(bdMs < 500, `2 万条 costBreakdown 必须 <500ms（实际 ${bdMs}ms）`);
  const counted = countFormatCalls(() => C.costBreakdown());
  assert.ok(counted.calls < 200, `costBreakdown 的 ICU 格式化次数必须与记录数无关（2 万条实际 ${counted.calls} 次）`);
  ok(`A2 2 万条 costBreakdown ${bdMs}ms（<500ms），格式化 ${counted.calls} 次（与条数无关）`);

  // ⑦ 分桶边界：00:00:01 属于当天、23:59:59 属于当天（不是相邻日）
  const last = bd.byDay[bd.byDay.length - 1];
  const prev = bd.byDay[bd.byDay.length - 2];
  assert.equal(last.day, dayKey(P.beijingParts(new Date(dayStart + 1000))), '今天 00:00:01 必须落在今天的桶');
  assert.equal(prev.day, dayKey(P.beijingParts(new Date(dayStart - 1000))), '昨天 23:59:59 必须落在昨天的桶');
  ok('A2 日界分桶：00:00:01 归当天、23:59:59 归当天（跨日不串桶）');
}

// ─────────────────────────────────────────────────────────────────────────────
try {
  const R = await load('regex-safety.js');
  const C = await load('constraints.js');
  await suiteA1(R, C);
  const P = await load('pricing.js');
  const CS = await load('cachestats.js');
  await suiteA2(P, CS);
  console.log(`\n✅ freeze-hardening：${passed} 条断言通过`);
  fs.rmSync(home, { recursive: true, force: true });
} catch (err) {
  fs.rmSync(home, { recursive: true, force: true });
  console.error('\n❌ freeze-hardening 失败：', err);
  process.exit(1);
}
