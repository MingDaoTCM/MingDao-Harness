// 批四十八（v0.6.23 §3.87：消息 ts 统一到 session.appendMessages）的变异验证。
//
// 本批把「单一来源 / 幂等 / 旧会话不改写」的每一处修复逐个改回缺陷，test/smoke.js §157 必须当场红。
// 覆盖（任务书要求 ≥6 条，本批 10 条）：不补 ts、ts 不是 ISO、已有 ts 被覆盖、补在副本上导致
// 重复写入刷新、压缩重写刷新、Web 自建第二份实现、Web 绕过 appendMessages、读取路径回填 ts、
// 读取路径改写旧文件、非法 ts 读取崩溃。
//
// 为什么每条都必须在 §157 里被抓到：ts 缺失在界面上只是「不显示时间」，肉眼很难发现回归；
// 而旧会话一旦被读取路径回填/改写，历史时间就变成「打开会话的那一刻」，且不可逆。
import { makeMutator } from './lib.mjs';

const M = makeMutator();
const SEC = () => M.section('157');

// ① 不补 ts：session 层回到「谁写谁负责」，CLI/REPL/调度路径的消息再次没有时间
M.mutate({
  name: '① appendMessages 不补 ts（只剩 Web 自己有）',
  file: 'src/session.js',
  from: '  stampMessageTs(messages); // 单一来源：所有写入路径在这里补 ts（已有 ts 不覆盖）\n',
  to: '',
  expect: ['经 appendMessages 写入的消息必须带 ts'],
  run: SEC,
});

// ② 补的不是 ISO：写成毫秒数（前端 new Date(数字) 也「能跑」，但契约是 ISO 字符串）
M.mutate({
  name: '② ts 补成毫秒数而不是 ISO 字符串',
  file: 'src/session.js',
  from: '  const ts = now.toISOString();',
  to: '  const ts = now.getTime();',
  expect: ['经 appendMessages 写入的消息必须带 ts'],
  run: SEC,
});

// ③ 已有 ts 被覆盖：每次落盘都刷新时间（旧消息一重写就变成「现在」）
M.mutate({
  name: '③ 已有 ts 被覆盖（重复写入刷新时间）',
  file: 'src/session.js',
  from: '    if (!m || typeof m !== \'object\' || m.ts) continue;',
  to: '    if (!m || typeof m !== \'object\') continue;',
  expect: ['已有 ts 的消息经 appendMessages 后内存对象也不得被改写'],
  run: SEC,
});

// ④ 补在副本上：文件里有 ts，但内存对象没有；同一消息再次写入会拿到新时间
M.mutate({
  name: '④ 补在副本上不就地写回（重复写入刷新 ts）',
  file: 'src/session.js',
  from: [
    'export function appendMessages(file, messages) {',
    '  if (!messages?.length) return;',
    '  stampMessageTs(messages); // 单一来源：所有写入路径在这里补 ts（已有 ts 不覆盖）',
  ].join('\n'),
  to: [
    'export function appendMessages(file, messages) {',
    '  if (!messages?.length) return;',
    '  messages = stampMessageTs(messages.map((m) => ({ ...m }))); // 变异：补在副本上，原对象不带 ts',
  ].join('\n'),
  expect: ['appendMessages 必须把 ts 就地写回消息对象'],
  run: SEC,
});

// ⑤ 压缩整文件重写刷新时间：第一次自动压缩就把整套历史时间改成「现在」
M.mutate({
  name: '⑤ 压缩重写刷新已有 ts',
  file: 'src/session.js',
  from: ['export function rewriteSession(file, messages) {', '  const lines = messages.map'].join('\n'),
  to: [
    'export function rewriteSession(file, messages) {',
    '  messages = messages.map((m) => (m && typeof m === \'object\' ? { ...m, ts: new Date().toISOString() } : m)); // 变异：重写时刷新 ts',
    '  const lines = messages.map',
  ].join('\n'),
  expect: ['整文件压缩重写不得刷新/丢失已有 ts'],
  run: SEC,
});

// ⑥ Web 自建第二份实现（老病：同一规则两份实现，最弱的那份说了算）
M.mutate({
  name: '⑥ Web 端保留第二份 stampMessageTs 实现',
  file: 'src/web/server.js',
  from: "const INDEX_HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html');",
  to: [
    'function stampMessageTs(messages, now = new Date()) {',
    '  const ts = now.toISOString();',
    '  return messages.map((m) => (m && typeof m === \'object\' && !m.ts ? { ...m, ts } : m));',
    '}',
    '',
    "const INDEX_HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html');",
  ].join('\n'),
  expect: ['Web 端不得再自建 stampMessageTs'],
  run: SEC,
});

// ⑦ Web 绕过 appendMessages 直接写盘：CLI 有 ts、Web 没有（「同一条规则两处写入」）
M.mutate({
  name: '⑦ Web 落盘绕过 appendMessages（直接 append 文件）',
  file: 'src/web/server.js',
  from: [
    '      {',
    '        const tail = messages.slice(persistedBefore);',
    '        await withSessionLock(session.file, () => appendMessages(session.file, tail));',
    '      }',
  ].join('\n'),
  to: [
    '      {',
    '        const tail = messages.slice(persistedBefore);',
    "        for (const m of tail) fs.appendFileSync(session.file, JSON.stringify(m) + '\\n');",
    '      }',
  ].join('\n'),
  expect: ['Web 落盘必须走 appendMessages'],
  run: SEC,
});

// ⑧ 读取路径回填 ts：旧会话的接口从 null 变成「打开时刻」，历史时间被伪造
M.mutate({
  name: '⑧ 读取路径给旧消息回填 ts（接口不再返回 null）',
  file: 'src/session.js',
  from: [
    '      const m = JSON.parse(line);',
    "      if (m && typeof m === 'object' && ['system', 'user', 'assistant', 'tool'].includes(m.role)) {",
    '        messages.push(m);',
  ].join('\n'),
  to: [
    '      const m = JSON.parse(line);',
    "      if (m && typeof m === 'object' && ['system', 'user', 'assistant', 'tool'].includes(m.role)) {",
    '        if (!m.ts) m.ts = new Date().toISOString(); // 变异：读取路径回填 ts',
    '        messages.push(m);',
  ].join('\n'),
  expect: ['旧会话缺失 ts 必须返回 null'],
  run: SEC,
});

// ⑨ 读取路径改写旧文件：打开一次旧会话就把历史文件永久回填（不可逆）
M.mutate({
  name: '⑨ 读取路径改写旧会话文件（回填 ts 落盘）',
  file: 'src/session.js',
  from: ['  return { file, messages };', '}'].join('\n'),
  to: [
    '  if (messages.some((m) => !m.ts)) {',
    "    fs.writeFileSync(file, messages.map((m) => JSON.stringify({ ...m, ts: new Date().toISOString() })).join('\\n') + '\\n');",
    '  }',
    '  return { file, messages };',
    '}',
  ].join('\n'),
  expect: ['旧会话读取不得改写会话文件（不得回填 ts）'],
  run: SEC,
});

// ⑩ 非法 ts（"abc"）在读取路径被强转：new Date('abc').toISOString() 抛 RangeError → 整个会话 404
M.mutate({
  name: '⑩ 非法 ts 读取崩溃（强转 ISO）',
  file: 'src/web/routes/domains/sessions.js',
  from: "          .map((m) => ({ role: m.role, content: m.content ?? '', ts: typeof m.ts === 'string' && m.ts ? m.ts : null })),",
  to: "          .map((m) => ({ role: m.role, content: m.content ?? '', ts: m.ts ? new Date(m.ts).toISOString() : null })),",
  expect: ['读取 badts-157.jsonl 必须 200'],
  run: SEC,
});

process.exit(M.report() ? 0 : 1);
