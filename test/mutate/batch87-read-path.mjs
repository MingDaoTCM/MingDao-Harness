// 批八十七（v0.7.1 性能）：事件真源读放大 + 会话列表 N×2 全文件读的变异验证。
//
// 目标：v0.7.0「事件真源翻转」引入的读放大回退——`readAfter` 游标装饰性整份解析、
// 路由为取 lastEventSeq 整份解析、`loadSession` 一次解析三次、`diffMessages` 整段 stringify、
// 会话列表每个会话同步读全文件两次。把每一处价值改回缺陷，`test/session-read-path.js`
// 必须当场红，且失败输出里出现该条 `expect` 关键词。
//
// 覆盖：readLastEventSeq 去掉 export / 路由回退 readAfter / diffMessages 整段 stringify /
//       readAfter 无视 after 仍全量 / sessionPreview 又全文件读 / loadSession 解析多次 /
//       计数缓存 key 不含 size / 尾窗读成全量。
// 用法：node test/mutate/batch87-read-path.mjs
import { makeMutator } from './lib.mjs';

const M = makeMutator();
const RP = () => M.suite('test/session-read-path.js');

// ① readLastEventSeq 去掉 export：路由取 lastEventSeq 的尾窗入口消失，只能退回整份解析
M.mutate({
  name: '① readLastEventSeq 被去掉 export（路由尾窗入口消失）',
  file: 'src/session-events.js',
  from: 'export function readLastEventSeq(file) {',
  to: 'function readLastEventSeq(file) { // 变异：readLastEventSeq 去掉 export',
  expect: ['readLastEventSeq 必须导出'],
  run: RP,
});

// ② 路由 lastEventSeq 回退 readAfter：/api/session 为取一个整数又整份解析事件日志（读放大回归）
M.mutate({
  name: '② sessions 路由 lastEventSeq 回退 readAfter 全量解析',
  file: 'src/web/routes/domains/sessions.js',
  from: "        lastEventSeq: readLastEventSeq(eventFileFor(path.join(home, 'sessions', path.basename(file)))).lastSeq,",
  to: "        lastEventSeq: readAfter(eventFileFor(path.join(home, 'sessions', path.basename(file))), 0).lastSeq, // 变异：回退 readAfter 全量",
  expect: ['路由 lastEventSeq 必须复用 readLastEventSeq'],
  run: RP,
});

// ③ diffMessages 退回整段 stringify：20k 条两侧数组 4 万次序列化（读放大/CPU 回归）
M.mutate({
  name: '③ diffMessages 退回整条 JSON.stringify',
  file: 'src/session-events.js',
  from: "  if (String(a?.role ?? '') !== String(b?.role ?? '')) return false;",
  to: [
    "  const norm = (m) => { const out = { role: String(m?.role ?? ''), content: m?.content ?? '' }; if (Array.isArray(m?.tool_calls)) out.tool_calls = m.tool_calls.map((t) => String(t?.id ?? '')).sort(); if (m?.tool_call_id != null) out.tool_call_id = String(m.tool_call_id); return JSON.stringify(out); }; if (norm(a) !== norm(b)) return false; // 变异：整段 stringify",
    "  if (String(a?.role ?? '') !== String(b?.role ?? '')) return false;",
  ].join('\n'),
  expect: ['diffMessages 结构化比较不得逐条整段 stringify'],
  run: RP,
});

// ④ readAfter 无视 after 仍全量：游标退回装饰性，追平/超尾也整份解析（报告实测的 13.9ms 根因）
M.mutate({
  name: '④ readAfter 无视 after 仍整份解析',
  file: 'src/session-events.js',
  from: '  if (tail.lastSeq === 0 || after >= tail.lastSeq) {',
  to: '  if (false && (tail.lastSeq === 0 || after >= tail.lastSeq)) { // 变异：无视 after 仍全量',
  expect: ['readAfter(after=lastSeq) 必须只读尾窗', '读取字节'],
  run: RP,
});

// ⑤ sessionPreview 又全文件读：会话列表每个会话为取首条 user 消息整份读文件（N×2 的一半）
M.mutate({
  name: '⑤ sessionPreview 又全文件读（不再只读文件头 8KB）',
  file: 'src/session.js',
  from: '    const found = previewFromText(readPreviewHead(file));',
  to: "    const found = previewFromText(fs.readFileSync(file, 'utf8')); // 变异：sessionPreview 又全文件读",
  expect: ['sessionPreview 只读头部'],
  run: RP,
});

// ⑥ loadSession 解析多次：派生与修补各自再读事件日志（一次 /api/session 的事件解析放大）
M.mutate({
  name: '⑥ loadSession 解析多次（不共享单次解析）',
  file: 'src/session.js',
  from: '  const parsed = wantEvents && eventFile && fs.existsSync(eventFile) ? readEvents(eventFile) : null;',
  to: '  const parsed = null; // 变异：不共享单次解析，派生与修补各自再读（loadSession 解析多次）',
  expect: ['loadSession 只 readEvents 一次'],
  run: RP,
});

// ⑦ 计数缓存 key 不含 size：同秒追加（mtime 不变、size 变）时缓存命中旧计数，列表消息数失真
M.mutate({
  name: '⑦ 计数缓存 key 不含 size（mtime 不变、size 变时命中旧计数）',
  file: 'src/web/routes/domains/sessions.js',
  from: '    if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.messageCount;',
  to: '    if (hit && hit.mtimeMs === mtimeMs) return hit.messageCount; // 变异：缓存 key 不含 size',
  expect: ['计数缓存必须按 mtime+size 判失效'],
  run: RP,
});

// ⑧ 尾窗读成全量：readLastEventSeq/readAfter 的 64KB 尾窗消失，追平读取退回全文件读
M.mutate({
  name: '⑧ 尾窗读成全量（readTail 不再 64KB 尾窗）',
  file: 'src/session-events.js',
  from: '    const len = Math.min(size, TAIL_BYTES);',
  to: '    const len = size; // 变异：尾窗读成全量',
  expect: ['读取字节'],
  run: RP,
});

const ok = M.report();
process.exit(ok ? 0 : 1);
