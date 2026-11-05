// 文案 / 预测层（src/messages.js）的独立回归套件（v0.7.0 §1.5 第一步）。
//
// 这一层从 src/agent.js **逐字**切出（逻辑零变化）：TTFT 提示判定、无进展看门狗阈值与文案、
// 内存降级两级压缩、端点学习值预告、prefill 外推与规模预告、上游错误解读、回合进度行、只读档判定。
// 切出来的意义就在这里——它们可以脱离 2700 行的 Agent 循环单独断言，改文案/改判据能立刻红。
//
// 约定：**文案类只断关键词**（"显存不足"/"不可达"/"秒"…），不断整句——否则以后改一句措辞就红一片，
// 守卫会退化成"改文案要顺手改测试"，最后没人看。判据类（阈值/预算/布尔）才做等值断言。
// 边界值单独列（0 / 负数 / NaN / null / 超窗口 / 超重试级数），因为这些正是踩过的坑。
//
// 运行：node test/messages.js
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const M = await import(pathToFileURL(path.join(root, 'src', 'messages.js')).href);
// 导出面守卫用：agent.js 必须把同一批名字再导出（调用点一行都不用改）。
const A = await import(pathToFileURL(path.join(root, 'src', 'agent.js')).href);

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };
const has = (text, re, label) => assert.ok(re.test(String(text)), `${label}（实际：${String(text).slice(0, 160)}）`);

// ---------- 0. 导出面：messages.js 是唯一实现，agent.js 只做再导出 ----------
{
  const NAMES = [
    'shouldPrintTtftNotice', 'ttftNoticeStateFor', 'DEFAULT_NO_PROGRESS_TIMEOUT_MS', 'SUBAGENT_WAIT_GRACE_MS',
    'MEMORY_RECOVERY_LEVELS', 'MAX_MEMORY_RETRIES', 'memoryRecoveryTarget', 'endpointLearnedNotice',
    'resolveNoProgressTimeoutMs', 'PREFILL_WARN_RATIO', 'PREFILL_WARN_TOKENS', 'PREFILL_SLOW_WARN_MS',
    'PREFILL_LONGCTX_EVIDENCE', 'prefillEstimateMs', 'prefillForecast', 'noProgressNotice',
    'inheritedStopNotice', 'zeroToolCallNotice', 'describeUpstreamError', 'formatTurnProgress',
    'startsInReadOnlyPhase',
  ];
  const missing = NAMES.filter((n) => !(n in M));
  assert.deepEqual(missing, [], `messages.js 必须导出这 21 个名字，缺：${missing.join(',')}`);
  ok(`① messages.js 导出 21 个名字（${NAMES.length} 个逐个点名）`);

  // 同一个实现对象（不是复制一份重写）——否则"改一处就够"立刻失效
  const copied = NAMES.filter((n) => A[n] !== M[n]);
  assert.deepEqual(copied, [], `agent.js 的再导出必须指向 messages.js 的同一实现，身份不同的是：${copied.join(',')}`);
  ok('② agent.js 的再导出与 messages.js 是**同一函数/常量**（不是第二份实现）');

  // agent.js 里不该再有这些实现（搬走就是搬走了，否则两份迟早漂移）
  assert.equal('fmtDur' in A, false, 'messages.js 的内部格式化函数不应漏进 agent.js 导出面');
  ok('③ 内部辅助（fmtDur/fmtRefDur/fmtLearnedDate）没有被顺手导出到 agent.js');
}

// ---------- 1. shouldPrintTtftNotice：首帧提示节流 ----------
{
  const f = M.shouldPrintTtftNotice;
  const table = [
    [{ llmCalls: 1, ttftMs: 9000, now: 1000 }, true, '首次（无历史）必须打印'],
    [{ llmCalls: 2, ttftMs: 9000, now: 1000 }, false, '同回合第 2 次请求不得打印'],
    [{ llmCalls: 1, ttftMs: 9000, lastMs: 9000, lastAt: 1000, now: 2000, quietMs: 600000 }, false, '静默期内不重复'],
    [{ llmCalls: 1, ttftMs: 9000, lastMs: 9000, lastAt: 1000, now: 601000, quietMs: 600000 }, true, '静默期已过 → 再报一次'],
    [{ llmCalls: 1, ttftMs: 30000, lastMs: 9000, lastAt: 1000, now: 2000, quietMs: 600000 }, true, '明显变慢（≥2×）例外'],
    [{ llmCalls: 1, ttftMs: 12000, lastMs: 9000, lastAt: 1000, now: 2000, quietMs: 600000 }, false, '略慢（<2×）仍受节流'],
    [{ llmCalls: 1, ttftMs: NaN, now: 1000 }, false, '非有限值不打印（也不崩）'],
    [{ llmCalls: 1, ttftMs: 0, now: 1000 }, true, '0ms 是有限值（边界：照常判定，不当成缺失）'],
  ];
  for (const [input, want, name] of table) {
    const got = f(input);
    assert.equal(got.print, want, `${name}：期望 print=${want}，实际 ${JSON.stringify(got)}`);
  }
  ok('① 判定表 8 组（首次/同回合/静默期/静默期到点/劣化例外/略慢/NaN/0ms）');

  assert.equal(f({ llmCalls: 1, ttftMs: 30000, lastMs: 9000, lastAt: 1, now: 2 }).slowdown, true, '劣化时必须标 slowdown');
  assert.equal(f({ llmCalls: 1, ttftMs: 9000, lastMs: 9000, lastAt: 1, now: 2 }).slowdown, false, '非劣化不得标 slowdown');
  ok('② slowdown 标记只在"明显变慢"时为 true（前端据此用告警色）');

  // quietMs / slowdownRatio 可配置：边界 = 恰好等于阈值（>= 成立）
  assert.equal(f({ llmCalls: 1, ttftMs: 9000, lastMs: 9000, lastAt: 0, now: 1, quietMs: 0 }).print, true, 'quietMs=0 等价于不节流');
  assert.equal(f({ llmCalls: 1, ttftMs: 18000, lastMs: 9000, lastAt: 1, now: 2, slowdownRatio: 2 }).slowdown, true, '恰好 2× 必须算劣化（>= 边界）');
  assert.equal(f({ llmCalls: 1, ttftMs: 17999, lastMs: 9000, lastAt: 1, now: 2, slowdownRatio: 2 }).slowdown, false, '差 1ms 不算劣化');
  ok('③ 阈值边界：quietMs=0 / 恰好 2×（>= 含等号）/ 差 1ms');
}

// ---------- 2. ttftNoticeStateFor：进程级节流状态表 ----------
{
  const key = `messages-suite-${process.pid}`;
  const a = M.ttftNoticeStateFor(key);
  assert.deepEqual(a, { ms: null, at: 0 }, '新键的初值是"没有历史"');
  a.ms = 1234; a.at = 5678;
  const b = M.ttftNoticeStateFor(key);
  assert.equal(b, a, '同一个键必须返回**同一个对象**（节流状态跨回合共享，不能每次新建）');
  assert.equal(b.ms, 1234, '写进去的值必须留得住');
  ok('① 同一个键返回同一对象、值可持久（跨回合节流的前提）');

  assert.equal(M.ttftNoticeStateFor('').at, 0, '空键回落 default');
  assert.equal(M.ttftNoticeStateFor(null), M.ttftNoticeStateFor('default'), 'null 与 \'\' 都归一化成同一个 default 键');
  ok('② 空/异常键归一化到 default（不会为每个空键新建一张表）');

  // 上限 200 个键：写满后加新键 → 淘汰最老的，size 不增长（防长跑进程泄漏）
  for (let i = 0; i < 260; i += 1) M.ttftNoticeStateFor(`messages-cap-${i}`);
  const probe = M.ttftNoticeStateFor('messages-cap-probe');
  assert.equal(probe.at, 0, '新键仍能正常创建');
  // 最老的键已被挤掉：再取一次拿到的是**新的**空对象
  assert.notEqual(M.ttftNoticeStateFor('messages-cap-0').at, -1, '被淘汰的键再取会重新建（不抛错）');
  assert.equal(M.ttftNoticeStateFor('messages-cap-259'), M.ttftNoticeStateFor('messages-cap-259'), '最近的键仍在表里');
  ok('③ 键数上限 200：写满后不无限增长，老键被淘汰、新键照常可用');
}

// ---------- 3. 常量：默认阈值 / 宽限 / 两级压缩 / 预告线 ----------
{
  assert.equal(M.DEFAULT_NO_PROGRESS_TIMEOUT_MS, 3600000, '无进展阈值 = 2 × 本地单请求总量上限（1800s）');
  assert.ok(M.DEFAULT_NO_PROGRESS_TIMEOUT_MS >= 1800000, '不得比单请求总量超时更激进（否则慢 prefill 被误判卡死）');
  ok('① DEFAULT_NO_PROGRESS_TIMEOUT_MS = 3600000（60 分钟，且不激进于单请求上限）');

  assert.equal(M.SUBAGENT_WAIT_GRACE_MS, 15000, '子代理宽限 15s（让子代理先于父回合响）');
  assert.ok(M.SUBAGENT_WAIT_GRACE_MS > 0 && M.SUBAGENT_WAIT_GRACE_MS <= 60000, '宽限必须 >0 且不至于掩盖卡死');
  ok('② SUBAGENT_WAIT_GRACE_MS = 15000 且落在 (0, 60s] 内');

  assert.equal(M.MEMORY_RECOVERY_LEVELS.length, 2, '内存降级是**两级**（真机证明一级不够）');
  assert.equal(M.MAX_MEMORY_RETRIES, 2, '重试硬上限 = 压缩级数（绝不无限重试）');
  const [l1, l2] = M.MEMORY_RECOVERY_LEVELS;
  assert.deepEqual({ ...l1 }, { budgetRatio: 0.6, maxOutputRatio: 0.5, minBudget: 4096, minMaxOutput: 512 }, '第 1 级参数');
  assert.deepEqual({ ...l2 }, { budgetRatio: 0.35, maxOutputRatio: 0.25, minBudget: 4096, minMaxOutput: 512 }, '第 2 级参数');
  assert.ok(Object.isFrozen(M.MEMORY_RECOVERY_LEVELS) && Object.isFrozen(l1) && Object.isFrozen(l2), '级别表必须冻结（不被运行时改掉）');
  ok('③ 两级压缩参数与硬上限（0.6/0.5 → 0.35/0.25，下限 4096/512，表已冻结）');

  assert.ok(M.PREFILL_WARN_RATIO > 0 && M.PREFILL_WARN_RATIO < 1, '窗口占比告警线必须在 (0,1)');
  assert.equal(M.PREFILL_WARN_RATIO, 0.8, '窗口占比告警线 = 80%');
  assert.equal(M.PREFILL_WARN_TOKENS, 60000, '无预检时的本地规模兜底线 = 60k tokens');
  assert.equal(M.PREFILL_SLOW_WARN_MS, 60000, '外推 prefill 告警线 = 60s');
  has(M.PREFILL_LONGCTX_EVIDENCE, /16k/, '长上下文证据必须写清实测规模');
  has(M.PREFILL_LONGCTX_EVIDENCE, /53\.7s/, '长上下文证据必须给出真机首帧实测值');
  has(M.PREFILL_LONGCTX_EVIDENCE, /90 倍/, '必须说出"外推低估约 90 倍"这条差值');
  ok('④ PREFILL_* 四条：80% / 60k / 60s + 证据文案含 16k、53.7s、90 倍（不断整句）');
}

// ---------- 4. memoryRecoveryTarget：两级压缩的预算/输出取值与下限 ----------
{
  const base = { budget: 32768, maxOutput: 8192 };
  const r1 = M.memoryRecoveryTarget({ ...base, retry: 1 });
  assert.equal(r1.level, 1, 'retry=1 → 第 1 级');
  assert.equal(r1.budget, 19660, '32,768 × 0.6 = 19,660');
  assert.equal(r1.maxOutput, 4096, '8,192 × 0.5 = 4,096');
  ok('① 第 1 级：预算 ×0.6 / 输出 ×0.5（32,768 → 19,660；8,192 → 4,096）');

  const r2 = M.memoryRecoveryTarget({ ...base, retry: 2 });
  assert.equal(r2.level, 2, 'retry=2 → 第 2 级');
  assert.equal(r2.budget, 11468, '32,768 × 0.35 = 11,468（相对起手预算，不是连乘）');
  assert.equal(r2.maxOutput, 2048, '8,192 × 0.25 = 2,048');
  ok('② 第 2 级：预算 ×0.35 / 输出 ×0.25，且按**起手预算**算（11,468 / 2,048，不是 19,660×0.35）');

  assert.equal(M.memoryRecoveryTarget({ ...base, retry: 9 }).level, 2, 'retry 超过级数 → 夹到第 2 级（不越界）');
  assert.equal(M.memoryRecoveryTarget({ ...base, retry: 0 }).level, 1, 'retry=0 → 当作第 1 级（不越界）');
  assert.equal(M.memoryRecoveryTarget({ ...base, retry: -3 }).level, 1, 'retry 负数 → 第 1 级（不越界）');
  assert.equal(M.memoryRecoveryTarget({ ...base, retry: '2' }).level, 2, 'retry 是数字字符串也认');
  ok('③ 重试级数边界：9 → 第 2 级、0/-3 → 第 1 级、字符串 "2" 也认');

  const tiny = M.memoryRecoveryTarget({ budget: 1000, maxOutput: 100, retry: 2 });
  assert.equal(tiny.budget, 4096, '预算下限 4,096（再低连系统提示 + 一轮工具结果都放不下）');
  assert.equal(tiny.maxOutput, 512, '输出下限 512');
  const junk = M.memoryRecoveryTarget({ budget: NaN, maxOutput: undefined, retry: 1 });
  assert.equal(junk.budget, 4096, '预算是 NaN → 落到下限而不是 NaN');
  assert.equal(junk.maxOutput, 512, '输出缺失 → 落到下限而不是 NaN');
  ok('④ 下限：预算 4,096 / 输出 512；NaN 与 undefined 也落到下限（不会把 NaN 传给引擎）');
}

// ---------- 5. endpointLearnedNotice：学习值预告 ----------
{
  const rec = { safeContextBudget: 13762, learnedAt: '2026-10-26T09:00:00.000Z', source: 'fail' };
  const n = M.endpointLearnedNotice({ budget: 13762, record: rec });
  has(n, /内存不足/, '必须说清为什么降级（内存不足）');
  has(n, /13,762/, '必须报本轮预算（带千分位）');
  has(n, /2026-10-26/, '必须给出学习日期（用户才能判断该不该信）');
  has(n, /失败学习/, '失败学习要如实标注来源');
  ok('① 失败学习：含"内存不足"+"13,762"+日期+"失败学习"（不断整句）');

  const up = M.endpointLearnedNotice({ budget: 20000, record: { safeContextBudget: 20000, source: 'success-upgrade', learnedAt: '2026-11-01T00:00:00.000Z' } });
  has(up, /成功上调/, '连续成功后的上调必须与"失败学习"区分开');
  ok('② 成功上调：来源写成"成功上调"（不是失败学习）');

  assert.equal(M.endpointLearnedNotice({ budget: 1000, record: null }), '', '没有学习值 → 空串（不打扰）');
  assert.equal(M.endpointLearnedNotice({ budget: 1000, record: { safeContextBudget: 0 } }), '', '学习值 0 → 空串');
  assert.equal(M.endpointLearnedNotice({ budget: 0, record: { safeContextBudget: 13762 } }), '', '预算缺失 → 空串（说不出预算就别报）');
  assert.equal(M.endpointLearnedNotice(), '', '无参调用 → 空串（不崩）');
  ok('③ 空输入：无学习值 / 学习值 0 / 预算 0 / 无参 → 一律空串');

  const broken = M.endpointLearnedNotice({ budget: 8000, record: { safeContextBudget: 8000, learnedAt: '不是日期' } });
  has(broken, /未知日期/, '日期坏了要写"未知日期"，不能抛错也不能写 Invalid Date');
  ok('④ 坏日期：降级成"未知日期"（不抛错、不出现 Invalid Date）');
}

// ---------- 6. resolveNoProgressTimeoutMs：配置解析的 fail-safe ----------
{
  assert.equal(M.resolveNoProgressTimeoutMs({}), M.DEFAULT_NO_PROGRESS_TIMEOUT_MS, '未配置 → 默认');
  assert.equal(M.resolveNoProgressTimeoutMs(undefined), M.DEFAULT_NO_PROGRESS_TIMEOUT_MS, 'cfg 缺失 → 默认（不崩）');
  assert.equal(M.resolveNoProgressTimeoutMs({ noProgressTimeoutMs: 1234 }), 1234, '显式配置必须生效');
  for (const bad of [0, -1, NaN, Infinity, -Infinity, null, '']) {
    assert.equal(M.resolveNoProgressTimeoutMs({ noProgressTimeoutMs: bad }), M.DEFAULT_NO_PROGRESS_TIMEOUT_MS,
      `非法值 ${String(bad)} 必须回落默认（不能用来关掉看门狗）`);
  }
  assert.equal(M.resolveNoProgressTimeoutMs({ noProgressTimeoutMs: '60000' }), 60000, '数字字符串按数字处理');
  ok('① 未配置/非法值（0、负数、NaN、±Infinity、null、\'\'）一律回落默认，数字字符串生效');
}

// ---------- 7. prefillEstimateMs：只认预检实测的线性外推 ----------
{
  const probe = { prefillMs: 80, prefillTokens: 2000 };
  const e = M.prefillEstimateMs({ promptTokens: 16000, probe });
  assert.deepEqual(e, { ms: 640, refTokens: 2000, refMs: 80, tokens: 16000 }, '80ms/2000 × 16000 = 640ms');
  ok('① 有预检：80ms / 2,000 tokens × 16,000 → 640ms');

  assert.equal(M.prefillEstimateMs({ promptTokens: 16000 }), null, '没有 probe → null（调用方退回保守文案）');
  assert.equal(M.prefillEstimateMs({ promptTokens: 16000, probe: {} }), null, 'probe 没有 prefillMs → null');
  assert.equal(M.prefillEstimateMs({ promptTokens: 16000, probe: { prefillMs: 0 } }), null, 'prefillMs=0 不是有效实测 → null');
  assert.equal(M.prefillEstimateMs({ promptTokens: 16000, probe: { prefillMs: -5 } }), null, '负的实测值 → null（不当成"很快"）');
  ok('② 无预检 / 空 probe / prefillMs=0 / 负值 → 一律 null（绝不硬编一个外推值）');

  const dflt = M.prefillEstimateMs({ promptTokens: 2000, probe: { prefillMs: 80 } });
  assert.equal(dflt.refTokens, 2000, '缺 prefillTokens 时按 2,000 参考 tokens 兜底');
  assert.equal(dflt.ms, 80, '本轮 tokens 恰好等于参考 tokens 时外推值 = 参考耗时');
  ok('③ 缺 prefillTokens → 参考 2,000 tokens；本轮 = 参考时外推值等于实测值');

  for (const p of [0, -1, NaN, undefined, null]) {
    assert.equal(M.prefillEstimateMs({ promptTokens: p, probe }), null, `promptTokens=${String(p)} → null（无可外推）`);
  }
  assert.equal(M.prefillEstimateMs({ promptTokens: 16000.7, probe }).tokens, 16001, 'tokens 四舍五入成整数');
  ok('④ 边界：0 / 负数 / NaN / 缺失 → null；小数 tokens 取整');
}

// ---------- 8. prefillForecast：发送前的规模预告 ----------
{
  // ① 本地 + 有预检实测：必须报外推值，并如实说"线性外推、长上下文会低估"
  const local = M.prefillForecast({ promptTokens: 16000, contextWindow: 131072, isLocal: true, firstTokenMs: 600000, budget: 98304, probe: { prefillMs: 80, prefillTokens: 2000 } });
  has(local.text, /本地端点/, '本地端点必须点明');
  has(local.text, /外推/, '有实测就必须报外推值');
  has(local.text, /≈0\.6s/, '本轮外推值按秒保留一位（640ms → 0.6s）');
  has(local.text, /线性外推/, '必须如实标注"这只是线性外推"');
  has(local.text, /53\.7s/, '必须同时给出"长上下文会低估"的实测证据');
  has(local.text, /首帧等待上限 600s/, '必须给出首帧等待上限（配置口径）');
  assert.equal(local.estimateMs, 640, 'estimateMs 透出外推值（服务端日志要用）');
  assert.equal(local.warn, false, '16k/131k、640ms → 未触任何告警线');
  ok('① 本地 + 预检：报 0.64s 外推 + "线性外推/会低估"证据 + 首帧上限 600s，且不误告警');

  // ② 云端 + 有预检实测：同一套外推逻辑，但措辞是"远程端点"
  const cloud = M.prefillForecast({ promptTokens: 120000, contextWindow: 131072, isLocal: false, firstTokenMs: 300000, probe: { prefillMs: 80, prefillTokens: 2000 } });
  has(cloud.text, /远程端点/, '云端不能说成"本地端点"');
  assert.equal(cloud.warn, true, `占比 ≥${Math.round(M.PREFILL_WARN_RATIO * 100)}% 必须告警（与是否本地无关）`);
  has(cloud.text, /占窗口/, '告警原因要说清是"占窗口比例"');
  assert.ok(cloud.ratio > 0.9 && cloud.ratio < 1, `ratio 应 ≈0.916，实际 ${cloud.ratio}`);
  ok('② 云端 + 预检：措辞是"远程端点"；120k/131k → warn=true 且原因是"占窗口"');

  // ③ 本地 + 无预检：退回保守文案（不许硬编外推值）
  const noProbe = M.prefillForecast({ promptTokens: 5000, contextWindow: 131072, isLocal: true, firstTokenMs: 600000 });
  has(noProbe.text, /数分钟至数十分钟/, '无预检时退回保守文案（该端点不提供进度预告）');
  has(noProbe.text, /本地端点/, '仍要说明是本地端点');
  assert.equal(noProbe.estimateMs, null, '无预检 → estimateMs 为 null（不编数字）');
  assert.equal(noProbe.warn, false, '5k tokens 的本地小请求不该告警');
  ok('③ 本地 + 无预检：退回"数分钟至数十分钟"保守文案，estimateMs=null，不误告警');

  // ④ 本地 + 无预检 + 规模超过兜底线：这条兜底线**只在没有实测时**用
  const bigLocal = M.prefillForecast({ promptTokens: 70000, contextWindow: 131072, isLocal: true, firstTokenMs: 600000 });
  assert.equal(bigLocal.warn, true, `本地 + ≥${M.PREFILL_WARN_TOKENS} tokens 且无实测 → 必须告警`);
  has(bigLocal.text, /没有预检实测可外推|预检实测可外推/, '告警要说明"这次没有实测可外推"（不是规模猜测）');
  const bigLocalWithProbe = M.prefillForecast({ promptTokens: 70000, contextWindow: 131072, isLocal: true, firstTokenMs: 600000, probe: { prefillMs: 80, prefillTokens: 2000 } });
  has(bigLocalWithProbe.text, /外推/, '有实测时改报外推值——兜底线不该再抢话');
  ok('④ 无实测 + ≥60k tokens → 告警并说明"无实测可外推"；有实测时改报外推值');

  // ⑤ 外推很慢 → 走"端点明显慢"这条线
  const slow = M.prefillForecast({ promptTokens: 20000, contextWindow: 131072, isLocal: true, firstTokenMs: 600000, probe: { prefillMs: 20000, prefillTokens: 2000 } });
  assert.equal(slow.estimateMs, 200000, '20s/2000 × 20000 = 200,000ms');
  assert.equal(slow.warn, true, `外推 ≥${M.PREFILL_SLOW_WARN_MS}ms 必须告警`);
  has(slow.text, /告警线/, '必须说清是"外推值超了告警线"（不是规模猜的）');
  ok('⑤ 外推 200s ≥ 60s 告警线 → warn=true 且原因写"外推值超告警线"');

  // ⑥ 超过窗口：ratio > 1 也要如实报（不裁剪成 100%）
  const over = M.prefillForecast({ promptTokens: 200000, contextWindow: 131072, isLocal: false, firstTokenMs: 300000 });
  assert.ok(over.ratio > 1, `超窗口时 ratio 必须 >1（如实），实际 ${over.ratio}`);
  assert.equal(over.warn, true, '超窗口必须告警');
  has(over.text, /占窗口 153%|占窗口/, '必须报出超窗口的百分比');
  ok('⑥ 超窗口（200k / 131k）：ratio >1 如实透出、warn=true');

  // ⑦ 学到的预算：预算数字与"从哪来"都要出现在**发送前**
  const learned = M.prefillForecast({ promptTokens: 8000, contextWindow: 32768, isLocal: true, firstTokenMs: 600000, budget: 11468, probe: { prefillMs: 80, prefillTokens: 2000 }, learned: { safeContextBudget: 11468, learnedAt: '2026-10-26T09:00:00.000Z', source: 'fail' } });
  has(learned.text, /11,468/, '学到的预算必须报出来（用户才知道为什么比配置小）');
  has(learned.text, /失败学习/, '必须写明这个预算来自哪天的失败学习');
  has(learned.text, /2026-10-26/, '必须给出学习日期');
  ok('⑦ learned：预告里同时有"预算 11,468"+来源"失败学习"+日期（不必翻日志）');

  // ⑧ 本地已有在途请求 → 强警告（同形于"引擎卡住"的那条日志线）
  const busy = M.prefillForecast({ promptTokens: 8000, contextWindow: 131072, isLocal: true, firstTokenMs: 600000, localBusy: true, localActive: 2, localQueued: 1, localConcurrency: 1 });
  assert.equal(busy.warn, true, '本地已有在途请求 → warn=true（强警告，不只是提示）');
  has(busy.text, /并发会加剧内存压力/, '必须说清并发与内存压力的因果');
  has(busy.text, /2 个在途请求/, '在途请求数要如实');
  has(busy.text, /1 个在排队/, '排队数要如实');
  has(busy.text, /串行化/, '并发上限 1 时必须说明已串行化');
  const busyCloud = M.prefillForecast({ promptTokens: 8000, contextWindow: 131072, isLocal: false, firstTokenMs: 300000, localBusy: true, localActive: 2 });
  assert.equal(busyCloud.warn, false, '云端端点不该出现"本地串行化"告警（同形误报）');
  ok('⑧ localBusy：在途/排队/串行化三件套 + 并发→内存压力的因果；云端不误报');

  // ⑨ probe.note 与缺省参数
  const withNote = M.prefillForecast({ promptTokens: 8000, contextWindow: 131072, isLocal: true, firstTokenMs: 600000, probe: { note: '引擎自述上下文=32,768' } });
  has(withNote.text, /端点预检：引擎自述上下文=32,768/, '预检 note 必须并进同一条预告');
  const bare = M.prefillForecast({});
  assert.equal(bare.promptTokens, 0, '无参/空对象也要能跑（promptTokens=0）');
  assert.equal(bare.warn, false, '空输入不该告警');
  ok('⑨ probe.note 并入预告；空输入不崩且不告警');
}

// ---------- 9. noProgressNotice：整轮零进展的中止文案 ----------
{
  const secs = M.noProgressNotice({ waitedMs: 600, toolCalls: 0, modelRounds: 1 });
  has(secs, /1 秒/, '不足 1 分钟必须按**秒**说（600ms → 1 秒）');
  assert.equal(/1 分钟/.test(secs), false, '600ms 不得谎报"1 分钟"（真机就这么谎报过）');
  has(secs, /整轮零进展/, '必须点明是整轮零进展');
  has(secs, /capped/, '必须与 capped 区分');
  has(secs, /aborted/, '必须与用户点的停止 aborted 区分');
  has(secs, /60 分钟/, '要写出默认阈值（60 分钟，可配置）');
  ok('① 600ms：按"秒"说、不谎报 1 分钟，且与 capped/aborted 明确区分');

  const mins = M.noProgressNotice({ waitedMs: 90_000, toolCalls: 3, modelRounds: 5, unproductive: 2 });
  has(mins, /2 分钟/, '90s → 2 分钟（四舍五入）');
  has(mins, /工具调用 3 次/, '工具调用次数要如实');
  has(mins, /模型请求 5 轮/, '模型轮次要如实');
  has(mins, /2 次工具调用是\*\*重复调用或失败\*\*/, 'unproductive 要单列出来（"在跑但什么都没做成"）');
  ok('② 90s + 3 次调用：报"2 分钟"、次数/轮次如实、重复失败单列');

  const waiting = M.noProgressNotice({ waitedMs: 60_000, toolCalls: 1, modelRounds: 1, pendingTool: { name: 'task', ms: 300_000 } });
  has(waiting, /正在等待工具 task/, '必须说清在等哪个工具');
  has(waiting, /已 300s/, '必须说清等了多久');
  ok('③ pendingTool：点名工具 + 等待秒数（用户才知道该调什么）');

  const sub = M.noProgressNotice({ waitedMs: 60_000, pendingTool: { name: 'task', ms: 120_000 }, subagent: { label: '审计', modelRounds: 12, toolCalls: 30, at: Date.now() - 5000 } });
  has(sub, /第 12 轮/, '子代理跑到第几轮要如实');
  has(sub, /30 次工具调用/, '子代理的工具调用数要如实');
  has(sub, /子代理也没有新进展/, '必须说明"连子代理都没进展"（否则看起来像子代理在干活）');
  ok('④ pendingTool + subagent：给出子代理轮次/调用数与"连子代理也没新进展"');

  assert.equal(/正在等待工具/.test(M.noProgressNotice({ waitedMs: 60_000 })), false, '没有 pendingTool 时不得凭空写"正在等待工具"');
  ok('⑤ 无 pendingTool 时不编造"在等谁"');
}

// ---------- 10. inheritedStopNotice：父回合收口（不是子代理卡住） ----------
{
  const s = M.inheritedStopNotice({ waitedMs: 30_000, toolCalls: 18, modelRounds: 15 });
  has(s, /30 秒/, '不足 1 分钟按秒说');
  has(s, /父回合/, '必须点明是父回合判定的');
  has(s, /整轮无进展/, '收口原因必须是"父回合整轮无进展"');
  has(s, /不是子代理卡住/, '必须明确否认"子代理卡住"（真机就谎报过）');
  has(s, /模型请求 15 轮/, '子代理自己的轮次照实写（证明它一直在干活）');
  ok('① 30s：按秒说 + 父回合整轮无进展 + 明确否认"子代理卡住"');

  const m = M.inheritedStopNotice({ waitedMs: 300_000, toolCalls: 2, modelRounds: 3 });
  has(m, /5 分钟/, '300s → 5 分钟');
  has(m, /60 分钟/, '要写出阈值口径（默认 60 分钟）');
  const neg = M.inheritedStopNotice({ waitedMs: -1000 });
  has(neg, /0 秒/, '负等待夹到 0 秒（不出现 -1 秒）');
  ok('② 5 分钟口径 + 默认阈值；负等待夹到 0 秒');

  const empty = M.inheritedStopNotice({});
  has(empty, /0 秒/, '空对象按 0 秒（三个参数都有默认值）');
  has(empty, /模型请求 0 轮/, '空对象按 0 轮');
  ok('③ 空对象：全部回落 0（0 秒 / 0 轮 / 0 次）——注意它要求传对象，与原实现一致');
}

// ---------- 11. zeroToolCallNotice：0 次工具调用的提示 ----------
{
  assert.equal(M.zeroToolCallNotice({ modelRounds: 1, steps: 1 }), '', '单轮纯问答本来就不该有工具调用 → 不打扰');
  assert.equal(M.zeroToolCallNotice({ modelRounds: 1, steps: 1, taskLike: false }), '', '非任务态单轮 → 空串');
  ok('① 单轮纯问答不打扰（空串）');

  const multi = M.zeroToolCallNotice({ modelRounds: 3, steps: 3 });
  has(multi, /0 次工具调用/, '多轮却零调用必须报出来');
  has(multi, /3 轮模型请求/, '模型轮次如实');
  has(multi, /3 步/, '步数如实');
  has(multi, /tool_calls/, '要指出端点大概不返回 tool_calls（可操作的判断）');
  has(multi, /function calling/, '要给"换支持 function calling 的模型"这条建议');
  ok('② 3 轮 0 调用：报次数 + 指向"端点不返回 tool_calls" + 建议');

  const taskLike = M.zeroToolCallNotice({ modelRounds: 1, steps: 0, taskLike: true });
  has(taskLike, /0 次工具调用/, '任务态即使只有一轮也必须说（写/执行意图却没有工具）');
  has(taskLike, /0 步/, 'steps 缺省 0 要如实');
  ok('③ taskLike 单轮也要说；steps 缺省按 0');
}

// ---------- 12. describeUpstreamError：上游/引擎错误的可操作解读 ----------
{
  const mem = M.describeUpstreamError({ status: 507, message: 'insufficient memory: this prompt projects 49.7 GiB' });
  has(mem.hint, /内存|显存/, '内存类错误必须分类到内存/显存');
  has(mem.hint, /压缩上下文/, '必须给"压缩上下文"这条处置');
  assert.equal(mem.status, 507, '状态码原样透出');
  has(mem.message, /insufficient memory/, '原文必须原样保留（不改写上游错误）');
  has(mem.hint, /^💡 /, '解读必须带 💡 前缀（与上游原文区分开）');
  ok('① 内存：分类到内存/显存 + 处置"压缩上下文" + 原文原样 + 💡 前缀');

  const timeout = M.describeUpstreamError({ message: '首 token 等待超限（600s，本地模型长上下文 prefill 可能很慢）' });
  has(timeout.hint, /内核自己的超时/, '必须说清是内核超时、不是上游报错');
  has(timeout.hint, /config\.timeout\.firstTokenMs/, '必须给出可调的配置项');
  const idle = M.describeUpstreamError({ message: '流式响应空闲超限（120s 无新数据）' });
  has(idle.hint, /内核自己的超时/, '流式空闲超时同样要解读');
  ok('② 超时：区分"内核超时"与上游报错 + 给出可调配置项（首帧/空闲两种）');

  const auth = M.describeUpstreamError({ status: 401, message: 'Unauthorized' });
  has(auth.hint, /鉴权|API Key/, '401 必须分类到鉴权');
  has(auth.hint, /检查/, '必须给"检查 Key"这条建议');
  const forbidden = M.describeUpstreamError({ status: 403, message: 'forbidden' });
  has(forbidden.hint, /鉴权|API Key/, '403 同样归鉴权');
  ok('③ 401/403：分类到鉴权 + 要求检查 API Key');

  const rate = M.describeUpstreamError({ status: 429, message: 'rate limited' });
  has(rate.hint, /限流/, '429 必须分类到限流');
  has(rate.hint, /稍后重试|降低并发/, '必须给重试/降并发这条建议');
  const five = M.describeUpstreamError({ status: 502, message: 'Bad Gateway' });
  has(five.hint, /5xx/, '5xx 要说明已按瞬态错误重试过');
  ok('④ 429 分类限流 + 建议；502 说明已重试（且提醒确定性错误重试无用）');

  const jinja = M.describeUpstreamError({ status: 400, message: 'Unable to generate parser for this template. Jinja Exception: No user query found' });
  has(jinja.hint, /模板/, '模板/Jinja 类错误必须分类到"上游模板"');
  has(jinja.hint, /tool_calls/, '必须指出这类端点通常不返回 tool_calls');
  ok('⑤ 模板类（Jinja）：分类到"上游模板不接受多轮 messages"，并指向 function calling');

  const net = M.describeUpstreamError({ message: 'fetch failed: connect ECONNREFUSED 127.0.0.1:8081' });
  assert.equal(net.hint, null, '网络不通**不编造**解读（连接层错误不该被说成"端点模板问题"）');
  assert.equal(net.message, 'fetch failed: connect ECONNREFUSED 127.0.0.1:8081', '识别不出时原文必须逐字返回');
  ok('⑥ 网络（ECONNREFUSED）：hint 为 null（不编造）、原文逐字返回');

  const unknown = M.describeUpstreamError({ message: 'something utterly unknown' });
  assert.equal(unknown.hint, null, '未知错误 → hint null（不得编造）');
  assert.equal(unknown.message, 'something utterly unknown', '未知错误原文必须原样');
  assert.equal(unknown.status, null, '没有状态码时 status 为 null（不是 0）');
  assert.equal(M.describeUpstreamError('裸字符串错误').message, '裸字符串错误', 'err 传字符串也要能读');
  ok('⑦ 未知错误与裸字符串：hint=null、原文不变、status=null');

  const localMem = M.describeUpstreamError({ status: 507, message: 'memory_refusal' }, { isLocal: true });
  assert.equal(localMem.recoverableByShrinking, true, '本地内存类 → 可压缩恢复');
  const cloudMem = M.describeUpstreamError({ status: 507, message: 'memory_refusal' }, { isLocal: false });
  assert.equal(cloudMem.recoverableByShrinking, false, '云端 507 → 不压缩重试（云的容量不是本地上下文能改的）');
  const localAuth = M.describeUpstreamError({ status: 401, message: 'Unauthorized' }, { isLocal: true });
  assert.equal(localAuth.recoverableByShrinking, false, '本地 401 也不该压缩重试');
  ok('⑧ recoverableByShrinking：只对本地内存类为真（云端 507 / 本地 401 均为假）');

  const learned = M.describeUpstreamError({ status: 507, message: 'memory_refusal' }, { isLocal: true, learned: { safeContextBudget: 11468, learnedAt: '2026-10-26T00:00:00.000Z' } });
  has(learned.hint, /11,468/, '有学习值时建议里必须给**与学习值一致**的数字');
  has(learned.hint, /下轮起手自动使用/, '必须说明下轮会自动用（否则用户会以为要手调）');
  ok('⑨ learned：建议文案与学习值一致（不是再抛一个临时数字）');

  const long = M.describeUpstreamError({ status: 500, message: `${'x'.repeat(400)}…` });
  has(long.hint, /截断/, '原文可能被截断时必须如实标注');
  ok('⑩ 长原文：标注"上游原文可能被截断"（避免用户以为这就是全部）');
}

// ---------- 13. formatTurnProgress：回合进度行 ----------
{
  const full = M.formatTurnProgress({ phase: '解码中', elapsedMs: 125000, modelRounds: 2, toolCalls: 1, toolExecuted: 1, contentChars: 1200, ttftMs: 98000, tokensPerSec: 3.2 });
  has(full, /已跑 2m05s/, '已跑时长 m分s秒（125s → 2m05s）');
  has(full, /阶段=解码中/, '阶段字段');
  has(full, /模型轮次=2/, '模型轮次字段');
  has(full, /工具调用=1（已执行完 1）/, '工具调用字段（执行数）');
  has(full, /已收正文=1200 字/, '正文长度字段');
  has(full, /首帧=98\.0s/, '首帧字段（TTFT）');
  has(full, /≈3\.2 tok\/s/, '速率字段');
  assert.equal(full.split(' · ').length, 7, `七个字段用 " · " 连接，实际：${full}`);
  ok('① 七字段齐全（时长/阶段/轮次/工具/首帧/速率/正文），" · " 分隔');

  const bare = M.formatTurnProgress({ elapsedMs: 0 });
  has(bare, /阶段=未知/, 'phase 缺失 → "未知"（不是空串，也不是 undefined）');
  has(bare, /已跑 0m00s/, 'elapsedMs=0 → 0m00s');
  has(bare, /工具调用=0（0 次工具调用）/, '0 次调用要显式写出（不是省略）');
  assert.equal(/首帧=/.test(bare), false, '没有 ttftMs 时不写首帧字段（不写 null）');
  assert.equal(/tok\/s/.test(bare), false, '没有 tokensPerSec 时不写速率字段');
  assert.equal(/undefined|null|NaN/.test(bare), false, '缺值时不得漏出 undefined/null/NaN');
  ok('② 缺值：阶段→"未知"、时长→0m00s、0 次调用显式写、ttft/速率整段省略（不漏 undefined/NaN）');

  const waiting = M.formatTurnProgress({ phase: '执行工具 task', elapsedMs: 600000, modelRounds: 1, toolCalls: 1, contentChars: 0, pendingTool: { name: 'task', ms: 300000 } });
  has(waiting, /正在等待工具 task（已 300s）/, 'pendingTool 要写"在等谁 + 等了多久"');
  has(waiting, /工具调用=1/, '有在途调用时不能写"0 次工具调用"');
  has(waiting, /已跑 10m00s/, '600s → 10m00s');
  ok('③ pendingTool：点名 + 秒数（"等工具"与"卡死"不再同形）');

  const sub = M.formatTurnProgress({ phase: '等待子代理', elapsedMs: 620000, modelRounds: 1, toolCalls: 1, contentChars: 0, ttftMs: 1000, pendingTool: { name: 'task', ms: 620000 }, subagent: { label: '审计 tools', modelRounds: 12, toolCalls: 30, at: Date.now() - 3000 } });
  has(sub, /子代理「审计 tools」/, '子代理要带标签');
  has(sub, /已跑 12 轮 \/ 30 次工具调用/, '子代理的轮次/调用数如实');
  has(sub, /最后进展 \d+s 前/, '子代理最后进展的"多久以前"要有');
  const noLabel = M.formatTurnProgress({ elapsedMs: 1000, subagent: { modelRounds: 2, toolCalls: 0 } });
  has(noLabel, /子代理已跑 2 轮/, '没有 label 时不出空括号，仍要报进度');
  ok('④ subagent：标签 + 轮次/调用数 + "最后进展 Ns 前"；无标签不出空括号');

  const q = M.formatTurnProgress({ elapsedMs: 1000, localQueue: { active: 2, queued: 1, limit: 1 } });
  has(q, /本地端点已串行化/, '本地排队必须显式写出来（防内存压力）');
  has(q, /2 个在途请求/, '在途请求数如实');
  has(q, /1 个排队/, '排队数如实');
  has(q, /并发上限 1/, '并发上限如实');
  const q0 = M.formatTurnProgress({ elapsedMs: 1000, localQueue: { active: 0, queued: 0, limit: 2 } });
  assert.equal(/个排队/.test(q0), false, '排队数为 0 时不写"0 个排队"');
  has(q0, /并发上限 2/, '并发上限 2 如实');
  ok('⑤ localQueue：串行化/在途/排队/上限；排队 0 时不刷"0 个排队"');
}

// ---------- 14. startsInReadOnlyPhase：只读档判定（方向是反的） ----------
{
  assert.equal(M.startsInReadOnlyPhase({}, '什么是闭包？', false), true, '纯提问 → 只读档（省 schema token）');
  assert.equal(M.startsInReadOnlyPhase({}, 'what is a monad?', false), true, '英文纯提问同样进只读档');
  ok('① 纯提问（中/英）→ 只读档');

  assert.equal(M.startsInReadOnlyPhase({}, '帮我改一下这个文件', false), false, '含写意图 → 全量工具');
  assert.equal(M.startsInReadOnlyPhase({}, '请生成回访看板', false), false, '"生成"是写意图 → 全量');
  assert.equal(M.startsInReadOnlyPhase({}, '回访一下这些病人', false), false, '域内动词（不命中词表）也必须给全量——判定方向是反的');
  ok('② 写意图 / 域内动词 → 全量（"回访"这类开集提示词不再把工具锁死）');

  assert.equal(M.startsInReadOnlyPhase({}, '什么是闭包？', true), false, '域内 Pack 在场 → 不进只读档（任务能做优先）');
  assert.equal(M.startsInReadOnlyPhase({ schemaTier: false }, '什么是闭包？', false), false, 'config.schemaTier=false → 不进只读档');
  assert.equal(M.startsInReadOnlyPhase({}, '', false), false, '空消息 → 全量（默认从任务态出发）');
  assert.equal(M.startsInReadOnlyPhase({}, undefined, false), false, 'undefined 消息不崩且给全量');
  ok('③ Pack 在场 / schemaTier=false / 空消息 → 全量（最后一条决定"任务做不了"不会发生）');
}

// ---------- 15. 随只读档判定一起搬来的两个自愈判据 ----------
{
  assert.equal(M.hasWriteIntent('把 README 更新一下'), true, '写意图判据仍可用（agent.js 的 runTurn 自愈分支要复判）');
  assert.equal(M.hasWriteIntent('什么是闭包？'), false, '纯提问不应命中写意图');
  assert.equal(M.hasWriteIntent(''), false, '空串不崩且不命中');
  ok('① hasWriteIntent：写意图命中 / 纯提问不命中 / 空串安全');

  assert.equal(M.looksLikeUnmetIntent('我无法直接读取该文件，需要你先提供路径'), true, '自愈信号：模型透出"做不到/需要你"');
  assert.equal(M.looksLikeUnmetIntent('好的，已经改完了'), false, '正常完成不触发自愈');
  assert.equal(M.looksLikeUnmetIntent(undefined), false, 'undefined 不崩');
  ok('② looksLikeUnmetIntent：透出"做不到"时命中、正常完成不命中、undefined 安全');
}

console.log(`\n文案 / 预测层（src/messages.js）：${passed} 项通过`);
