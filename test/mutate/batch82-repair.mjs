// 批八十二（v0.6.40）：审批/工具/回合「悬空事件」闭合的变异验证。
//
// 目标：修补器的价值全在「能发现悬空 + 合成事件可识别 + 只追加不改历史 + 可重复」。
// 每条把其中一处改回缺陷，`test/session-repair.js` 必须当场红，且失败输出里出现该条
// `expect` 关键词（关键词 = 断言原文，防止"红是红了，但不是因为你改坏的那条"）。
//
// 覆盖：不检测悬空 / 漏掉 approval / 漏掉 tool / 合成不带 synthetic / 破坏幂等（每次都追加）/
//       损坏日志仍写入 / reason 丢失 / 事件顺序错（先 turn.end 再 tool.end）。
// 用法：node test/mutate/batch82-repair.mjs
import { makeMutator } from './lib.mjs';

const M = makeMutator();
const REPAIR = () => M.suite('test/session-repair.js');

// ① 不检测悬空：findDangling 直接返回空 → 修补器永远认为日志是干净的
M.mutate({
  name: '① 不检测悬空（findDangling 直接返回空）',
  file: 'src/session-events.js',
  from: [
    'export function findDangling(events) {',
    '  /** @type {Map<string, any>} */',
  ].join('\n'),
  to: [
    'export function findDangling(events) {',
    '  return { asks: [], tools: [], turns: [] }; // 变异：不检测悬空',
    '  /** @type {Map<string, any>} */',
  ].join('\n'),
  expect: ['单条悬空 ask 必须被识别'],
  run: REPAIR,
});

// ② 漏掉 approval：ask 永远进不了待闭合集合（"永远在等审批"仍然悬空）
M.mutate({
  name: '② 漏掉 approval（approval.asked 不进入悬空集合）',
  file: 'src/session-events.js',
  from: "    if (ev.type === 'approval.asked') {",
  to: "    if (ev.type === 'approval.asked.disabled') { // 变异：漏掉 approval",
  expect: ['单条悬空 ask 必须被识别'],
  run: REPAIR,
});

// ③ 漏掉 tool：tool.start 永远进不了待闭合集合（"工具永远在跑"仍然悬空）
M.mutate({
  name: '③ 漏掉 tool（tool.start 不进入悬空集合）',
  file: 'src/session-events.js',
  from: "    } else if (ev.type === 'tool.start') {",
  to: "    } else if (ev.type === 'tool.start.disabled') { // 变异：漏掉 tool",
  expect: ['悬空 tool.start 必须被识别'],
  run: REPAIR,
});

// ④ 合成事件不带 synthetic：重放/审计无法区分"真实结束"与"修补出来的事实"
M.mutate({
  name: '④ 合成事件不带 synthetic（修补事实不可识别）',
  file: 'src/session-events.js',
  from: "    const data = { decision: 'aborted', synthetic: true, reason: why };",
  to: "    const data = { decision: 'aborted', reason: why }; // 变异：合成事件不带 synthetic",
  expect: ['每条合成事件必须带 synthetic 字段'],
  run: REPAIR,
});

// ⑤ 破坏幂等：没有悬空也追加一条 turn.end → 每次启动都往日志里堆垃圾
M.mutate({
  name: '⑤ 破坏幂等（没有悬空也追加，每次跑都写）',
  file: 'src/session-events.js',
  from: '    if (!closers.length) return { ok: true, error: null, repaired: 0, dangling };',
  to: "    if (!closers.length) closers.push({ type: 'turn.end', time: Date.now(), data: { status: 'aborted', synthetic: true, reason: '变异：每次都追加' } }); // 变异：破坏幂等",
  expect: ['幂等：第二次必须 repaired:0'],
  run: REPAIR,
});

// ⑥ 损坏日志仍写入：半行日志上继续追加，把损坏固化进事实源
M.mutate({
  name: '⑥ 损坏日志仍写入（去掉 skipped > 0 拒绝）',
  file: 'src/session-events.js',
  from: [
    '    if (read.skipped > 0) {',
    '      return { ok: false, error: `事件日志损坏（跳过 ${read.skipped} 行），拒绝修补`, repaired: 0, dangling: empty };',
    '    }',
  ].join('\n'),
  to: '    // 变异：损坏日志时仍写入',
  expect: ['损坏（半行）日志必须返回 ok:false'],
  run: REPAIR,
});

// ⑦ reason 丢失：合成事件没有原因，事后无法解释"为什么被闭合"
M.mutate({
  name: '⑦ reason 丢失（合成事件不带原因）',
  file: 'src/session-events.js',
  from: "    const data = { decision: 'aborted', synthetic: true, reason: why };",
  to: "    const data = { decision: 'aborted', synthetic: true }; // 变异：reason 丢失",
  expect: ['每条合成事件必须带 reason 字段'],
  run: REPAIR,
});

// ⑧ 事件顺序错：先补 turn.end 再补 tool.end，日志时间线自相矛盾（回合已结束、工具还在跑）
M.mutate({
  name: '⑧ 事件顺序错（先 turn.end 再 tool.end）',
  file: 'src/session-events.js',
  from: [
    '  for (const tool of tools) {',
    '    /** @type {any} */',
    '    const data = { ok: false, error: SYNTHETIC_TOOL_ERROR, synthetic: true, reason: why };',
    '    if (tool?.data?.name !== undefined) data.name = String(tool.data.name);',
    '    const key = keyOf(tool, TOOL_ID_FIELDS);',
    '    if (key) data[key.field] = key.value;',
    "    closers.push({ type: 'tool.end', time, data });",
    '  }',
    '  for (let i = 0; i < turns.length; i += 1) {',
    '    // 每条悬空 turn 各补一条；事件形状不需要 turn 的任何字段。',
    "    closers.push({ type: 'turn.end', time, data: { status: 'aborted', synthetic: true, reason: why } });",
    '  }',
  ].join('\n'),
  to: [
    '  for (let i = 0; i < turns.length; i += 1) {',
    '    // 变异：事件顺序错——先 turn.end 再 tool.end',
    "    closers.push({ type: 'turn.end', time, data: { status: 'aborted', synthetic: true, reason: why } });",
    '  }',
    '  for (const tool of tools) {',
    '    /** @type {any} */',
    '    const data = { ok: false, error: SYNTHETIC_TOOL_ERROR, synthetic: true, reason: why };',
    '    if (tool?.data?.name !== undefined) data.name = String(tool.data.name);',
    '    const key = keyOf(tool, TOOL_ID_FIELDS);',
    '    if (key) data[key.field] = key.value;',
    "    closers.push({ type: 'tool.end', time, data });",
    '  }',
  ].join('\n'),
  expect: ['合成顺序必须是 approval.decided → tool.end → turn.end'],
  run: REPAIR,
});

const ok = M.report();
process.exit(ok ? 0 : 1);
