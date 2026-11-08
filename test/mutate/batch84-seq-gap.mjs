// 批八十四（v0.6.41）：SSE 序号跳号检测 + 整窗重取的变异验证。
//
// 目标：这一层的价值全在"跳号不被当连续、重复不被重放、无 seq 不被误杀、重取失败不静默"。
// 每条把其中一处改回缺陷，`test/seq-gap.js` 必须当场红，且失败输出里出现该条 `expect`
// 关键词（关键词 = 断言原文，防止"红是红了，但不是因为你改坏的那条"）。
//
// 覆盖：跳号也 accept / 重复帧当新帧 / null 帧判 resync（兼容性破坏）/ lastSeq 不回填 /
//       重取失败静默 / 首帧非 1 也 accept / gap 计算差 1 / resyncPlan 没有会话也选 snapshot。
// 用法：node test/mutate/batch84-seq-gap.mjs
import { makeMutator } from './lib.mjs';

const M = makeMutator();
const SEQ = () => M.suite('test/seq-gap.js');

// ① 跳号也 accept：漏掉的帧被当成连续帧，界面少几段正文却毫无提示
M.mutate({
  name: '① 跳号也 accept（incoming > last+1 被判连续）',
  file: 'src/web/viewmodel.js',
  from: '  if (incoming === last + 1) return { ok: true, gap: 0, action: \'accept\' };',
  to: '  if (incoming >= last + 1) return { ok: true, gap: 0, action: \'accept\' }; // 变异：跳号也 accept',
  expect: ['跳号必须 resync'],
  run: SEQ,
});

// ② 重复帧当新帧：同一 seq 被 accept，正文/工具结果会重复渲染
M.mutate({
  name: '② 重复帧当新帧（incoming === last 也 accept）',
  file: 'src/web/viewmodel.js',
  from: '  if (incoming === last + 1) return { ok: true, gap: 0, action: \'accept\' };',
  to: '  if (incoming >= last) return { ok: true, gap: 0, action: \'accept\' }; // 变异：重复帧当新帧',
  expect: ['重复帧必须 ignore'],
  run: SEQ,
});

// ③ null 帧判 resync：旧服务端（没有 seq）每一帧都触发重取，兼容性彻底破坏
M.mutate({
  name: '③ null 帧判 resync（旧服务端兼容被破坏）',
  file: 'src/web/viewmodel.js',
  from: [
    '    // 旧服务端兼容：没有 streamSeq（或它不是整数）→ 不参与连续性判断，业务照常。',
    "    return { ok: true, gap: 0, action: 'ignore' };",
  ].join('\n'),
  to: [
    '    // 变异：null 帧判 resync',
    "    return { ok: false, gap: 0, action: 'resync' };",
  ].join('\n'),
  expect: ['null 帧必须 ignore'],
  run: SEQ,
});

// ④ streamSeq 不回填：accept 后游标不动，下一帧永远"跳号"（或永远首帧），重取风暴
M.mutate({
  name: '④ streamSeq 不回填（accept 后流游标不动）',
  file: 'src/web/app.js',
  from: "      if (gate.action === 'accept') streamSeq = Number(ev.streamSeq);",
  to: "      if (gate.action === 'accept') { /* 变异：不回填游标 */ }",
  expect: ['accept 后必须回填 streamSeq'],
  run: SEQ,
});

// ⑤ 重取失败静默：两种重取都失败却什么都不说，用户以为只是"模型没说话"
M.mutate({
  name: '⑤ 重取失败静默（告警不插进对话流）',
  file: 'src/web/app.js',
  from: [
    "        d.textContent = '⚠ 事件流中断且重取失败，请刷新页面';",
    '        chatEl.appendChild(d);',
  ].join('\n'),
  to: "        d.textContent = '⚠ 事件流中断且重取失败，请刷新页面'; // 变异：静默失败",
  expect: ['重取失败必须在对话流里可见'],
  run: SEQ,
});

// ⑥ 首帧非 1 也 accept：开头就缺帧却按"首帧"收下，缺口永远补不回来
M.mutate({
  name: '⑥ 首帧非 1 也 accept（lastSeq===0 的基线失守）',
  file: 'src/web/viewmodel.js',
  from: '    return incoming === 1',
  to: '    return incoming >= 1 // 变异：首帧非 1 也 accept',
  expect: ['首帧必须是 1'],
  run: SEQ,
});

// ⑦ gap 计算差 1：文案说"已跳过 N 条"永远少一条（取证与用户认知都对不上）
M.mutate({
  name: '⑦ gap 计算差 1（缺多少算成差值）',
  file: 'src/web/viewmodel.js',
  from: "  return { ok: false, gap: incoming - last - 1, action: 'resync' };",
  to: "  return { ok: false, gap: incoming - last, action: 'resync' }; // 变异：gap 差 1",
  expect: ['gap 必须等于缺多少'],
  run: SEQ,
});

// ⑧ resyncPlan 没有会话也选 snapshot：新会话首轮无处可重取却去重建空窗口（B1 只允许 none）
M.mutate({
  name: '⑧ resyncPlan 没有会话也选 snapshot（重建空窗口）',
  file: 'src/web/viewmodel.js',
  from: "  if (hasSession) return { mode: 'snapshot', reason: `会话文件可用：整窗重取快照（跳过 ${g} 条事件）` };",
  to: "  if (hasSession || true) return { mode: 'snapshot', reason: `会话文件可用：整窗重取快照（跳过 ${g} 条事件）` }; // 变异：没有会话也 snapshot",
  expect: ['没有会话必须选 none'],
  run: SEQ,
});

const ok = M.report();
process.exit(ok ? 0 : 1);
