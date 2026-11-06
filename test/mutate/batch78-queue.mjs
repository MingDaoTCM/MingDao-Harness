// 批七十八（v0.6.39）：输入队列的纯语义（入队/出队/排空判据/渲染模型）。
// 每条把关键点改回缺陷，test/viewmodel.js 必须当场红。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const RUN = () => M.suite('test/viewmodel.js');

M.mutate({
  name: '① 空文本也入队（界面出现空 chip、发送一条空消息）',
  file: 'src/web/viewmodel.js',
  from: "  if (!t.trim()) return { ok: false, queue: list, reason: 'empty' };",
  to: "  if (false) return { ok: false, queue: list, reason: 'empty' };",
  expect: ['空/空白文本不入队'],
  run: RUN,
});

M.mutate({
  name: '② 满员不拒绝（队列无限增长，内存与模型请求都可能被打爆）',
  file: 'src/web/viewmodel.js',
  from: '  if (list.length >= QUEUE_MAX) return { ok: false, queue: list, reason: \'full\' };',
  to: '  if (false) return { ok: false, queue: list, reason: \'full\' };',
  expect: ['满员拒绝'],
  run: RUN,
});

M.mutate({
  name: '③ 出队按索引而不是 id（并发删除时删错条目）',
  file: 'src/web/viewmodel.js',
  from: '  const idx = list.findIndex((q) => String(q?.id) === String(id));',
  to: '  const idx = 0;',
  // expect 要写**会最先失败的那条**断言：idx=0 时「移除 a」仍恰好得到 [b]（先过的断言抓不住），
  // 真正暴露的是「移除不存在的 id 不应改变队列」。
  expect: ['移除不存在的 id'],
  run: RUN,
});

M.mutate({
  name: '④ 生成中也排空（本轮还在跑就发下一条 → 并发两个回合）',
  file: 'src/web/viewmodel.js',
  from: '  return q.length > 0 && !st?.generating && !st?.aborted;',
  to: '  return q.length > 0 && !st?.aborted;',
  expect: ['生成中不排空'],
  run: RUN,
});

M.mutate({
  name: '⑤ 用户中止后仍排空（违背"停止"意图，输入会被继续执行）',
  file: 'src/web/viewmodel.js',
  from: '  return q.length > 0 && !st?.generating && !st?.aborted;',
  to: '  return q.length > 0 && !st?.generating;',
  expect: ['用户中止'],
  run: RUN,
});

M.mutate({
  name: '⑥ chip 不截断（超长输入把输入区撑破）',
  file: 'src/web/viewmodel.js',
  from: "  return t.length > QUEUE_LABEL_MAX ? t.slice(0, QUEUE_LABEL_MAX - 1) + '…' : t;",
  to: '  return t;',
  expect: ['超长文本截断'],
  run: RUN,
});

M.mutate({
  name: '⑦ chip 不压平换行（多行文本把队列条撑高）',
  file: 'src/web/viewmodel.js',
  from: "  const t = String(item?.text ?? '').replace(/\\s+/g, ' ').trim();",
  to: "  const t = String(item?.text ?? '').trim();",
  expect: ['换行压成空格'],
  run: RUN,
});

M.mutate({
  name: '⑧ 序号从 0 开始（与"第 N 条"文案不一致）',
  file: 'src/web/viewmodel.js',
  from: '  return list.map((q, i) => ({ id: String(q?.id || \'\'), index: i + 1, label: queueLabel(q), text: String(q?.text ?? \'\') }));',
  to: '  return list.map((q, i) => ({ id: String(q?.id || \'\'), index: i, label: queueLabel(q), text: String(q?.text ?? \'\') }));',
  expect: ['chip 序号从 1 开始'],
  run: RUN,
});

const ok = M.report();
process.exit(ok ? 0 : 1);
