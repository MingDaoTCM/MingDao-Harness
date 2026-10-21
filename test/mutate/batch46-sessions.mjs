// 批四十六（v0.6.22 §3.84：会话列表分组 + 消息时间戳）的变异验证。
//
// 本批把「只增展示」的每一处修复逐个改回缺陷，test/ui-sessions.js 必须当场红——
// 否则分组/时间戳只是截图里"看起来有"，没有任何回归护栏。
//
// 覆盖（任务书要求 ≥6 条，本批 10 条）：分组边界错、旧会话报错、显示 undefined、
// 分组顺序错、渲染路径重复计算、分组标题文案错、跨天格式错、API 字段缺失、
// title 未复用、旧会话 ts 不是 null、messageCount 口径错、引入 setInterval 轮询。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SEC = () => M.suite('test/ui-sessions.js');

// ① 分组边界错：今天 00:00 被划进"昨天"（t >= 今天 改成 t > 今天）
M.mutate({
  name: '① 今天/昨天边界错（00:00 整点被划进昨天）',
  file: 'src/web/app.js',
  from: "  if (t >= today) return 'today';",
  to: "  if (t > today) return 'today';",
  expect: ['今天/昨天边界：今天 00:00 必须算今天'],
  run: SEC,
});

// ② 旧会话报错：缺 ts 时直接 .trim() —— 旧会话载入变 404/500
M.mutate({
  name: '② 旧会话（无 ts）载入报错（ts 缺失时直接 .trim()）',
  file: 'src/web/routes/domains/sessions.js',
  from: "          .map((m) => ({ role: m.role, content: m.content ?? '', ts: typeof m.ts === 'string' && m.ts ? m.ts : null })),",
  to: "          .map((m) => ({ role: m.role, content: m.content ?? '', ts: m.ts.trim() })),",
  expect: ['旧会话（无 ts）必须 200，不得报错'],
  run: SEC,
});

// ③ 显示 undefined：addUser 不管有没有 ts 都渲染时间节点（String(null/undefined)）
M.mutate({
  name: '③ 缺 ts 时仍渲染时间节点（页面出现 undefined）',
  file: 'src/web/app.js',
  from: "const t=msgTimeText(ts); el.innerHTML='<div class=\"bubble\">'+esc(text)+(t?'<span class=\"msg-time\">'+esc(t)+'</span>':'')+'</div>';",
  to: "const t=msgTimeText(ts); el.innerHTML='<div class=\"bubble\">'+esc(text)+'<span class=\"msg-time\">'+esc(String(t||undefined))+'</span></div>';",
  expect: ['旧消息缺失 ts 时不得渲染 msg-time 节点'],
  run: SEC,
});

// ④ 分组顺序错：本周跑到昨天前面
M.mutate({
  name: '④ 分组顺序错（本周排在昨天前面）',
  file: 'src/web/app.js',
  from: "const SESSION_GROUP_ORDER = ['today', 'yesterday', 'week', 'earlier'];",
  to: "const SESSION_GROUP_ORDER = ['today', 'week', 'yesterday', 'earlier'];",
  expect: ['分组标题/顺序必须是 今天→昨天→本周→更早'],
  run: SEC,
});

// ⑤ 每次渲染重算：打开会话管理面板时又算一遍分组（缓存形同虚设）
M.mutate({
  name: '⑤ 打开会话管理时重算分组（渲染路径重复计算）',
  file: 'src/web/app.js',
  from: "  await refreshSessions(); // 复用同一次分组缓存：打开管理面板不再单独算一遍",
  to: "  await refreshSessions(); sessionsGroupedCache = groupSessionsByUpdatedAt(sessionsCache);",
  expect: ['分组只允许在数据刷新时计算一次（不得每次渲染重算）'],
  run: SEC,
});

// ⑥ 分组标题文案错：本周写成"这周"
M.mutate({
  name: '⑥ 分组标题文案错（本周 → 这周）',
  file: 'src/web/app.js',
  from: "const SESSION_GROUP_TITLES = { today: '今天', yesterday: '昨天', week: '本周', earlier: '更早' };",
  to: "const SESSION_GROUP_TITLES = { today: '今天', yesterday: '昨天', week: '这周', earlier: '更早' };",
  expect: ['分组标题/顺序必须是 今天→昨天→本周→更早'],
  run: SEC,
});

// ⑦ 跨天格式错：跨天也只显示 HH:mm，看不出是哪天
M.mutate({
  name: '⑦ 跨天消息时间丢日期（只显示 HH:mm）',
  file: 'src/web/app.js',
  from: '  if (sameDay) return hm;\n  return String(d.getMonth() + 1).padStart(2, \'0\')',
  to: '  return hm;\n  return String(d.getMonth() + 1).padStart(2, \'0\')',
  expect: ['跨天消息时间必须是 MM-DD HH:mm'],
  run: SEC,
});

// ⑧ API 字段缺失：/api/sessions 不再返回 updatedAt
M.mutate({
  name: '⑧ /api/sessions 缺 updatedAt 字段',
  file: 'src/web/routes/domains/sessions.js',
  from: "        updatedAt: new Date(s.mtime).toISOString(),\n",
  to: '',
  expect: ['会话项必须含 updatedAt（ISO 字符串）'],
  run: SEC,
});

// ⑨ title 未复用：返回空字符串（前端拿不到既有标题）
M.mutate({
  name: '⑨ title 未复用既有文件名标题（返回空串）',
  file: 'src/web/routes/domains/sessions.js',
  from: "      title: meta.title,",
  to: "      title: '',",
  expect: ['title 应复用既有文件名标题'],
  run: SEC,
});

// ⑩ 旧会话 ts 不是 null：缺 ts 时返回空串（前端可能把它当"有值"）
M.mutate({
  name: '⑩ 缺失 ts 返回空串而不是 null',
  file: 'src/web/routes/domains/sessions.js',
  from: "ts: typeof m.ts === 'string' && m.ts ? m.ts : null",
  to: "ts: typeof m.ts === 'string' && m.ts ? m.ts : ''",
  expect: ['缺失 ts 必须返回 null'],
  run: SEC,
});

// ⑪ messageCount 口径错：只数 user（assistant 不算消息）
M.mutate({
  name: '⑪ messageCount 口径错（assistant 不计入）',
  file: 'src/web/routes/domains/sessions.js',
  from: "['system', 'user', 'assistant', 'tool'].includes(m.role)",
  to: "['system', 'user'].includes(m.role)",
  expect: ['messageCount 必须等于该会话消息条数'],
  run: SEC,
});

// ⑫ 引入轮询：分组/时间代码里塞 setInterval
M.mutate({
  name: '⑫ 引入轮询（setInterval 反复刷新分组）',
  file: 'src/web/app.js',
  from: '// ==== /v0.6.22 §3.84 ====',
  to: "setInterval(()=>{ sessionsGroupedCache = groupSessionsByUpdatedAt(sessionsCache); }, 5000);\n// ==== /v0.6.22 §3.84 ====",
  expect: ['会话分组/消息时间新代码不得出现 setInterval（禁止轮询）'],
  run: SEC,
});

process.exit(M.report() ? 0 : 1);
