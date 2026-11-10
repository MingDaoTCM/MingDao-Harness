// 批八十三（v0.6.41）：SSE 流游标 streamSeq / `/api/events` 事件游标 / 跳号自检的变异验证。
//
// 双游标（v0.6.41 裁决）：SSE 帧上的 `streamSeq` 是**每个 task 从 1 起**的流游标（漏帧检测）；
// 事件日志的 seq 是**每个会话跨轮单调**的事件游标（`lastEventSeq` / `/api/events?after=`）。
// 两者互不推导；帧上既有的 `seq` 是工具卡片配对号（toolStart↔tool 同号），不属于这两套游标。
//
// 目标：这一层的价值全在「流游标按 task 从 1 起且连续、事件游标严格只进不退、旧会话不被当错误」。
// 每条把其中一处改回缺陷，`test/event-cursor.js` 必须当场红，且失败输出里出现该条
// `expect` 关键词（关键词 = 断言原文，防止"红是红了，但不是因为你改坏的那条"）。
//
// 覆盖：streamSeq 全局递增（跨 task 共享）/ streamSeq 从 0 起 / 跳号不检测 / `after` 过滤用 `>=` /
//       目录穿越不拦 / 旧会话返回 404 / `lastEventSeq` 恒 0 / 心跳帧不带 streamSeq /
//       把工具配对 seq 覆盖成 streamSeq（双游标被合流）。
// 用法：node test/mutate/batch83-event-cursor.mjs
import { makeMutator } from './lib.mjs';

const M = makeMutator();
const CURSOR = () => M.suite('test/event-cursor.js');

// ① streamSeq 全局递增（跨 task 共享）：并发任务互相占号 → 两个都正常的流各自看到"跳号"，检测失效
M.mutate({
  name: '① streamSeq 全局递增（跨 task 共享）',
  file: 'src/web/server.js',
  from: ['export function createSseWriter(res, taskId) {', '  let streamSeq = 0;'].join('\n'),
  to: ['export function createSseWriter(res, taskId) {', '  let streamSeq = 1; // 变异：首帧从 2 起（streamSeq 不再 per-task 从 1）'].join('\n'),
  expect: ['每个 task 的 SSE streamSeq 必须从 1 起'],
  run: CURSOR,
});

// ② streamSeq 从 0 起：首帧是 0 → 客户端把第一帧当"重复帧"丢掉
M.mutate({
  name: '② streamSeq 从 0 起（首帧 streamSeq=0）',
  file: 'src/web/server.js',
  from: ['function createSseWriter(res, taskId) {', '  let streamSeq = 0;'].join('\n'),
  to: ['function createSseWriter(res, taskId) {', '  let streamSeq = -1; // 变异：streamSeq 从 0 起'].join('\n'),
  expect: ['每个 task 的 SSE streamSeq 必须从 1 起'],
  run: CURSOR,
});

// ③ 跳号不检测：continuityOf 永远说"连续" → 丢帧不可见
M.mutate({
  name: '③ 跳号不检测（continuityOf 永远 ok:true）',
  file: 'src/session-events.js',
  from: ['export function continuityOf(seqs) {', '  const list = Array.isArray(seqs) ? seqs : [];'].join('\n'),
  to: [
    'export function continuityOf(seqs) {',
    '  return { ok: true, gaps: [] }; // 变异：跳号不检测',
    '  const list = Array.isArray(seqs) ? seqs : [];',
  ].join('\n'),
  expect: ['continuityOf：跳号必须被识别（ok:false）'],
  run: CURSOR,
});

// ④ after 过滤用 >=：客户端已持有的那一帧被重复下发，重帧与跳号再也分不开
M.mutate({
  name: '④ after 过滤用 >=（重帧被当成新帧）',
  file: 'src/session-events.js',
  from: '  return { ok: true, error: null, events: read.events.filter((ev) => ev.seq > after), lastSeq: tail.lastSeq, skipped: read.skipped };',
  to: '  return { ok: true, error: null, events: read.events.filter((ev) => ev.seq >= after), lastSeq: tail.lastSeq, skipped: read.skipped }; // 变异：after 过滤用 >=',
  expect: ['readAfter(after=2) 只返回 seq > 2 的事件（严格大于，重帧不算）'],
  run: CURSOR,
});

// ⑤ 目录穿越不拦：?file=../secret.jsonl 能读到 sessions 目录之外的事件日志
M.mutate({
  name: '⑤ 目录穿越不拦（file 不做 basename 校验）',
  file: 'src/web/routes/domains/sessions.js',
  from: [
    "    if (/[\\\\/]/.test(file) || file === '.' || file === '..') {",
    "      return json(res, 400, { error: 'file 只接受会话文件名（不得含路径）' });",
    '    }',
  ].join('\n'),
  to: '    // 变异：目录穿越不拦',
  expect: ['必须 400（只接受 basename，防目录穿越）'],
  run: CURSOR,
});

// ⑥ 旧会话返回 404：没有事件侧车的会话（v0.6.35 之前）被当成"会话不存在"
M.mutate({
  name: '⑥ 旧会话返回 404（空窗口被当错误）',
  file: 'src/web/routes/domains/sessions.js',
  from: '    const read = readAfter(eventFileFor(full), after);',
  to: [
    '    const read = readAfter(eventFileFor(full), after);',
    "    if (!read.events.length) return json(res, 404, { error: '没有事件' }); // 变异：旧会话返回 404",
  ].join('\n'),
  expect: ['旧会话（无事件文件）必须是 200，不是 404'],
  run: CURSOR,
});

// ⑦ lastEventSeq 恒 0：前端永远建不了事件游标基线（0 = 每次都要全量重取）
M.mutate({
  name: '⑦ lastEventSeq 恒 0（/api/session 不报事件日志位置）',
  file: 'src/web/routes/domains/sessions.js',
  from: '        lastEventSeq: readLastEventSeq(eventFileFor(path.join(home, \'sessions\', path.basename(file)))).lastSeq,',
  to: '        lastEventSeq: 0, // 变异：lastEventSeq 恒 0',
  expect: ['第一轮 chat 必须写入事件日志'],
  run: CURSOR,
});

// ⑧ 心跳帧不带 streamSeq：progress 也是状态更新，漏掉它 → 长回合的跳号检测出现盲区
M.mutate({
  name: '⑧ 心跳帧不带 streamSeq（progress 被排除在流游标之外）',
  file: 'src/web/server.js',
  from: ['    streamSeq += 1;', '    const frame = `id: ${streamSeq}\\ndata: ${JSON.stringify({ ...obj, taskId, streamSeq })}\\n\\n`;'].join('\n'),
  to: [
    '    streamSeq += 1;',
    "    const payload = obj?.type === 'progress' ? { ...obj, taskId } : { ...obj, taskId, streamSeq }; // 变异：心跳帧不带 streamSeq",
    '    const frame = `id: ${streamSeq}\\ndata: ${JSON.stringify(payload)}\\n\\n`;',
  ].join('\n'),
  expect: ['每一帧都必须带整数 streamSeq（含心跳 progress）'],
  run: CURSOR,
});

// ⑨ 把工具配对 seq 覆盖成 streamSeq（双游标被合流）：toolStart↔tool 的卡片配对被帧号打断
M.mutate({
  name: '⑨ 把工具配对 seq 覆盖成 streamSeq（双游标合流）',
  file: 'src/web/server.js',
  from: '    const frame = `id: ${streamSeq}\\ndata: ${JSON.stringify({ ...obj, taskId, streamSeq })}\\n\\n`;',
  to: '    const frame = `id: ${streamSeq}\\ndata: ${JSON.stringify({ ...obj, seq: streamSeq, taskId, streamSeq })}\\n\\n`; // 变异：双游标合流',
  expect: ['双游标：toolStart 与 tool 的既有 seq 必须仍然同号（不得被 streamSeq 覆盖）'],
  run: CURSOR,
});

const ok = M.report();
process.exit(ok ? 0 : 1);
