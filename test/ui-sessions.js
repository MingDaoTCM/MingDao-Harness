// 会话列表分组 + 消息时间戳（v0.6.22 §3.84）。
//
// 覆盖五件事（任务书 ①~⑤）：
//   ① 分组纯函数：固定「现在」下 今天/昨天/本周/更早 分组正确（含午夜/周一/周日前夜边界）；
//   ② /api/sessions 每项含 updatedAt / messageCount / title，且**旧会话（消息无 ts）不导致接口报错**；
//      /api/session 对缺失 ts 返回 null（不改既有字段）；
//   ③ 前端渲染：ts 存在 → 小号时间（同日 14:32 / 跨天 10-19 14:32）；缺失 → 不渲染且不出现
//      Invalid Date / undefined；
//   ④ 分组标题文案与顺序：今天 → 昨天 → 本周 → 更早；
//   ⑤ 结构断言：分组只在 refreshSessions 里算一次，新代码不得引入 setInterval 轮询。
//
// 运行：node test/ui-sessions.js（离线；keyless WebUI + 临时 home）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-ui-sessions-'));
process.env.MINGDAO_HOME = home;

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`  ✓ ${name}`);
};

// —— 固定夹具：今天 / 昨天（旧会话，无 ts）/ 本周 / 更早（含坏行） ——
const now = new Date();
const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0);
const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 9, 0, 0);
const dow = (now.getDay() + 6) % 7; // 周一 = 0
const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow, 9, 0, 0);
const earlier = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow - 7, 9, 0, 0);
const sessionsDir = path.join(home, 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });

/** @param {string} name @param {string} body @param {Date} mtime */
function writeSession(name, body, mtime) {
  const file = path.join(sessionsDir, name);
  fs.writeFileSync(file, body, { mode: 0o600 });
  fs.utimesSync(file, mtime, mtime);
  return file;
}

const tsToday = today.toISOString();
writeSession(
  'today.jsonl',
  [
    { role: 'user', content: '今天的会话', ts: tsToday },
    { role: 'assistant', content: '今天的回答', ts: new Date(today.getTime() + 60000).toISOString() },
  ].map((m) => JSON.stringify(m)).join('\n') + '\n',
  today
);
// 旧会话：完全没有 ts 字段（v0.6.21 之前写下的文件）。
writeSession(
  'yesterday.jsonl',
  [
    { role: 'user', content: '旧会话的问题' },
    { role: 'assistant', content: '旧会话的回答' },
  ].map((m) => JSON.stringify(m)).join('\n') + '\n',
  yesterday
);
writeSession('week.jsonl', JSON.stringify({ role: 'user', content: '本周会话' }) + '\n', monday);
// 更早 + 最后一行是半截 JSON（进程被 kill 的历史遗留）：列表/载入都不得 500。
writeSession(
  'earlier.jsonl',
  JSON.stringify({ role: 'user', content: '更早的会话' }) + '\n' + '{"role":"assistant","content":"半截\n',
  earlier
);

const { runWebServer } = await import(pathToFileURL(path.join(srcDir, 'web', 'server.js')).href);
const { saveConfig } = await import(pathToFileURL(path.join(srcDir, 'config.js')).href);
saveConfig({ provider: 'deepseek', model: 'deepseek-v4-flash', permission: 'ask', sandbox: 'off', contextBudget: 128000 });
const srv = await runWebServer({ host: '127.0.0.1', port: 0, authToken: null });
const base = `http://127.0.0.1:${srv.address().port}`;
const get = async (p) => {
  const res = await fetch(base + p, { cache: 'no-store' });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, j };
};

const appSrc = fs.readFileSync(path.join(srcDir, 'web', 'app.js'), 'utf8');
const blockStart = appSrc.indexOf('// ==== v0.6.22 §3.84');
const blockEnd = appSrc.indexOf('// ==== /v0.6.22 §3.84');
assert.ok(blockStart >= 0 && blockEnd > blockStart, 'app.js 必须保留 §3.84 纯函数块（分组 + 消息时间）');
const block = appSrc.slice(blockStart, blockEnd);
const pure = new Function(
  block + '\nreturn { SESSION_GROUP_ORDER, SESSION_GROUP_TITLES, sessionGroupKey, groupSessionsByUpdatedAt, msgTimeText };'
)();

// —— ① 分组函数：注入固定「现在」，避免跨午夜抖动 ——
{
  const NOW = new Date(2026, 9, 21, 12, 0, 0); // 2026-10-21（周三）本地 12:00
  const day = NOW.getDate();
  const mondayDay = day - ((NOW.getDay() + 6) % 7);
  const at = (d, h = 10) => new Date(2026, 9, d, h, 0, 0).toISOString();
  const list = [
    { file: 'today', updatedAt: at(day, 9) },
    { file: 'yesterday', updatedAt: at(day - 1, 9) },
    { file: 'week', updatedAt: at(mondayDay, 8) },
    { file: 'earlier', updatedAt: at(mondayDay - 1, 23) },
  ];
  const groups = pure.groupSessionsByUpdatedAt(list, NOW);
  assert.deepEqual(groups.map((g) => g.title), ['今天', '昨天', '本周', '更早'], '分组标题/顺序必须是 今天→昨天→本周→更早');
  assert.deepEqual(groups.map((g) => g.items.map((s) => s.file)), [['today'], ['yesterday'], ['week'], ['earlier']], '固定时间戳必须落到正确分组');
  // 边界：今天 00:00 = 今天；昨天 00:00 = 昨天；周一 00:00 = 本周；周日前夜 = 更早。
  assert.equal(pure.sessionGroupKey(new Date(2026, 9, day, 0, 0, 0).toISOString(), NOW), 'today', '今天/昨天边界：今天 00:00 必须算今天');
  assert.equal(pure.sessionGroupKey(new Date(2026, 9, day - 1, 0, 0, 0).toISOString(), NOW), 'yesterday', '今天/昨天边界：昨天 00:00 必须算昨天');
  assert.equal(pure.sessionGroupKey(new Date(2026, 9, mondayDay, 0, 0, 0).toISOString(), NOW), 'week', '本周/更早边界：周一 00:00 必须算本周');
  assert.equal(pure.sessionGroupKey(new Date(2026, 9, mondayDay - 1, 23, 59, 59).toISOString(), NOW), 'earlier', '本周/更早边界：周日前夜必须算更早');
  // mtime（旧接口字段，毫秒）也能分组，避免只为新字段服务。
  assert.deepEqual(pure.groupSessionsByUpdatedAt([{ file: 'legacy', mtime: new Date(2026, 9, day, 10).getTime() }], NOW).map((g) => g.items[0].file), ['legacy'], '旧 mtime 也必须可分组');
  ok('① 分组函数：今天/昨天/本周/更早（固定 now + 边界）');
}

// —— ② API：新增字段 + 旧会话（无 ts / 坏行）不报错 ——
{
  const ls = await get('/api/sessions');
  assert.equal(ls.status, 200, 'GET /api/sessions 必须 200（旧会话不得让列表报错）');
  assert.ok(ls.j.ok && Array.isArray(ls.j.sessions), '/api/sessions 结构');
  const byFile = Object.fromEntries(ls.j.sessions.map((s) => [s.file, s]));
  const todayItem = byFile['today.jsonl'];
  assert.ok(todayItem, '列表必须包含 today.jsonl');
  assert.equal(typeof todayItem.updatedAt, 'string', '会话项必须含 updatedAt（ISO 字符串）');
  assert.ok(!Number.isNaN(Date.parse(todayItem.updatedAt)), 'updatedAt 必须可解析为时间');
  assert.equal(todayItem.messageCount, 2, 'messageCount 必须等于该会话消息条数');
  assert.equal(typeof todayItem.title, 'string', '会话项必须含 title');
  assert.ok(todayItem.title.startsWith('today'), 'title 应复用既有文件名标题');
  assert.equal(byFile['earlier.jsonl'].messageCount, 1, '坏行只跳过该行，不得影响计数/接口');
  // 旧会话（无 ts）载入：200 + ts 为 null，content 等既有字段不变。
  const oldOne = await get('/api/session?file=yesterday.jsonl');
  assert.equal(oldOne.status, 200, '旧会话（无 ts）必须 200，不得报错');
  assert.equal(oldOne.j.messages.length, 2, '旧会话消息数不变');
  assert.equal(oldOne.j.messages[0].content, '旧会话的问题', '既有 content 字段语义不变');
  assert.equal(oldOne.j.messages[0].ts, null, '缺失 ts 必须返回 null');
  // 新会话：ts 原样返回。
  const newOne = await get('/api/session?file=today.jsonl');
  assert.equal(newOne.j.messages[0].ts, tsToday, '已有 ts 必须原样返回');
  ok('② API：updatedAt/messageCount/title + 旧会话 ts=null 不报错');
}

// —— ③ 前端渲染：有 ts 显示时间；缺失不显示、不出现 Invalid Date/undefined ——
{
  // 抽出 addUser / newAiMsg 的真实实现（与页面共用同一份源码，不是测试里重写）。
  const domStart = appSrc.indexOf('function newAiMsg(');
  const domEnd = appSrc.indexOf('const runningTools', domStart);
  assert.ok(domStart >= 0 && domEnd > domStart, 'app.js 必须保留 newAiMsg/addUser 渲染函数');
  const domSrc = appSrc.slice(domStart, domEnd);
  /** @type {any[]} */
  const created = [];
  const document = {
    createElement() {
      const el = {
        className: '',
        innerHTML: '',
        textContent: '',
        children: [],
        appendChild(c) {
          this.children.push(c);
          if (c && c.textContent) this.innerHTML += String(c.textContent);
        },
        querySelector() {
          return null;
        },
      };
      created.push(el);
      return el;
    },
  };
  const chatEl = { children: [], appendChild(el) { this.children.push(el); } };
  const render = new Function(
    'document',
    'chatEl',
    'esc',
    'renderEmptyState',
    'scrollBottom',
    block + '\n' + domSrc + '\nreturn { addUser, newAiMsg };'
  )(document, chatEl, (s) => String(s), () => {}, () => {});

  // 时间夹具必须相对「今天」：写死 2026-10-21 会在跨过那天后必然失败（日历炸弹）。
  const sameDay = new Date();
  sameDay.setHours(14, 32, 0, 0);
  const NOW = new Date();
  NOW.setHours(18, 0, 0, 0);
  const crossDay = new Date(NOW);
  crossDay.setDate(crossDay.getDate() - 2);
  crossDay.setHours(14, 32, 0, 0);
  const crossText = String(crossDay.getMonth() + 1).padStart(2, '0') + '-' + String(crossDay.getDate()).padStart(2, '0') + ' 14:32';
  assert.equal(pure.msgTimeText(sameDay.toISOString(), NOW), '14:32', '同一天消息时间必须是 HH:mm');
  assert.equal(pure.msgTimeText(crossDay.toISOString(), NOW), crossText, '跨天消息时间必须是 MM-DD HH:mm');
  for (const bad of [null, undefined, '', 'not-a-date']) {
    assert.equal(pure.msgTimeText(bad, NOW), '', `ts=${String(bad)} 必须返回空串（不显示）`);
    assert.ok(!/Invalid Date|undefined/.test(pure.msgTimeText(bad, NOW)), `ts=${String(bad)} 不得显示 Invalid Date/undefined`);
  }
  // 用真实 addUser/newAiMsg 渲染：有 ts → 出现小号时间节点；无 ts → 不出现节点、也不出现坏字符串。
  render.addUser('旧消息', null);
  const oldUser = chatEl.children.at(-1);
  assert.ok(!/msg-time/.test(String(oldUser.innerHTML)), '旧消息缺失 ts 时不得渲染 msg-time 节点');
  assert.ok(!/Invalid Date|undefined/.test(String(oldUser.innerHTML)), '旧消息不得出现 Invalid Date/undefined');
  render.addUser('新消息', sameDay.toISOString());
  const newUser = chatEl.children.at(-1);
  assert.ok(/class="msg-time">14:32</.test(String(newUser.innerHTML)), '有 ts 的用户消息必须显示 14:32');
  render.newAiMsg(null);
  const oldAi = chatEl.children.at(-1);
  assert.equal(oldAi.children.length, 0, 'AI 消息缺失 ts 时不得渲染时间节点');
  render.newAiMsg(sameDay.toISOString());
  const newAi = chatEl.children.at(-1);
  assert.ok(newAi.children.some((c) => c.className === 'msg-time' && c.textContent === '14:32'), '有 ts 的 AI 消息必须显示 14:32');
  // loadSession 必须把接口的 ts 传进渲染函数（接线断言，防止只写函数不接线）。
  const loadStart = appSrc.indexOf('async function loadSession(file){');
  const loadEnd = appSrc.indexOf('\n\n// §138', loadStart);
  const loadSrc = appSrc.slice(loadStart, loadEnd);
  assert.ok(/addUser\(m\.content,\s*m\.ts\)/.test(loadSrc), 'loadSession 必须把 m.ts 传给 addUser');
  assert.ok(/newAiMsg\(m\.ts\)/.test(loadSrc), 'loadSession 必须把 m.ts 传给 newAiMsg');
  ok('③ 前端渲染：ts 存在显示 / 缺失不显示且无 Invalid Date/undefined');
}

// —— ④ 文案与顺序（与 ① 同源，但单独成条，失败信息更直白） ——
{
  const NOW = new Date(2026, 9, 21, 12, 0, 0);
  const day = NOW.getDate();
  const groups = pure.groupSessionsByUpdatedAt(
    [
      { file: 'e', updatedAt: new Date(2026, 9, 1, 8).toISOString() },
      { file: 'w', updatedAt: new Date(2026, 9, day - 2, 8).toISOString() },
      { file: 'y', updatedAt: new Date(2026, 9, day - 1, 8).toISOString() },
      { file: 't', updatedAt: new Date(2026, 9, day, 8).toISOString() },
    ],
    NOW
  );
  assert.deepEqual(groups.map((g) => g.title), ['今天', '昨天', '本周', '更早'], '分组标题文案/顺序错误：必须 今天→昨天→本周→更早');
  assert.deepEqual(groups.map((g) => g.key), ['today', 'yesterday', 'week', 'earlier'], '分组 key 顺序错误');
  ok('④ 分组标题文案与顺序：今天→昨天→本周→更早');
}

// —— ⑤ 性能/轮询结构断言 ——
{
  assert.ok(!/setInterval\s*\(/.test(block), '会话分组/消息时间新代码不得出现 setInterval（禁止轮询）');
  const refreshStart = appSrc.indexOf('async function refreshSessions(q){');
  const refreshEnd = appSrc.indexOf('let searchTimer=null;', refreshStart);
  const refreshSrc = appSrc.slice(refreshStart, refreshEnd);
  assert.ok(/sessionsGroupedCache\s*=\s*groupSessionsByUpdatedAt\(sessionsCache\)/.test(refreshSrc), 'refreshSessions 必须一次性计算分组缓存');
  assert.ok(!/setInterval\s*\(/.test(refreshSrc), 'refreshSessions 不得引入 setInterval（禁止轮询）');
  const calls = (appSrc.match(/=\s*groupSessionsByUpdatedAt\(/g) || []).length;
  assert.equal(calls, 1, '分组只允许在数据刷新时计算一次（不得每次渲染重算）');
  ok('⑤ 分组只算一次 + 无 setInterval 轮询');
}

await new Promise((r) => srv.close(r));
delete process.env.MINGDAO_HOME;
fs.rmSync(home, { recursive: true, force: true });
console.log(`\n会话分组 + 消息时间测试全部通过：${passed} 项 ✓`);
