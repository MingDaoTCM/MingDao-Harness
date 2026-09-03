// API 域契约测试（Phase C C1）：按域验证路由契约——路径/方法/状态码/关键字段。
// 离线可跑：keyless 启动 + 空临时 home；网络相关域（skill-library 注册表、sync 远端）验证
// 其错误路径与结构契约，不依赖真实外网。
// 运行：node test/api-contracts.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-contract-'));
process.env.MINGDAO_HOME = home;

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`  ✓ 契约[${name}]`);
};

const { runWebServer } = await import(pathToFileURL(path.join(srcDir, 'web', 'server.js')).href);
const { saveConfig } = await import(pathToFileURL(path.join(srcDir, 'config.js')).href);
saveConfig({ provider: 'deepseek', model: 'deepseek-v4-flash', permission: 'ask', sandbox: 'off', contextBudget: 128000 });
const srv = await runWebServer({ host: '127.0.0.1', port: 45980, authToken: null });
// runWebServer 已 await listen 成功才 resolve；仅防御性等待（早期版本语义）
if (!srv.listening) await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const get = async (p, opts) => {
  const res = await fetch(base + p, opts);
  const j = await res.json().catch(() => ({}));
  return { status: res.status, j };
};
const post = async (p, body, opts) => {
  const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...opts });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, j };
};

// —— 静态壳域（orchestrator 内嵌） ——
{
  const html = await (await fetch(base + '/')).text();
  assert.ok(html.includes('MingDao'), '首页 HTML 应可加载');
  const appjs = await (await fetch(base + '/app.js')).text();
  assert.ok(appjs.includes('refreshCache') && appjs.includes('pkList'), 'SPA JS 应完整');
  // v0.2.8 C2：ES Modules 拆分后，工具/常量模块应可独立加载
  const utiljs = await (await fetch(base + '/util.js')).text();
  assert.ok(utiljs.includes('renderMarkdown') && utiljs.includes('esc'), 'util.js 应伺服 Markdown/转义工具');
  const constjs = await (await fetch(base + '/constants.js')).text();
  assert.ok(constjs.includes('MAX_IMAGE_BYTES') && constjs.includes('MAX_CONCURRENT'), 'constants.js 应伺服共享常量');
  const mf = await (await fetch(base + '/manifest.webmanifest')).json();
  assert.equal(mf.name, 'MingDao Harness', 'PWA manifest 正确');
  const sw = await (await fetch(base + '/sw.js')).text();
  assert.ok(sw.includes('mingdao-v5'), 'ServiceWorker 缓存版本正确');
  const icon = await fetch(base + '/icon-192.png');
  assert.equal(icon.status, 200, '图标应 200');
  const notfound = await get('/api/nope');
  assert.equal(notfound.status, 404, '未知 API 应 404');
  ok('static：壳资源 + 404 兜底');
}

// —— config 域 ——
{
  const st = await get('/api/state');
  assert.equal(st.status, 200);
  assert.ok(st.j.ok === true && Array.isArray(st.j.models) && Array.isArray(st.j.sessions), '/api/state 结构');
  assert.equal(st.j.keyReady, false, '无 Key 时 keyReady=false');
  assert.ok(Array.isArray(st.j.permissions) && ['ask', 'auto', 'readonly'].every((x) => st.j.permissions.includes(x)), '权限模式枚举');
  assert.ok(st.j.reasoning && typeof st.j.reasoning.supported === 'boolean' && Array.isArray(st.j.reasoning.options) && typeof st.j.reasoning.effort === 'string', '/api/state reasoning 字段');
  const badReasoning = await post('/api/config', { reasoningEffort: 'nope' });
  assert.equal(badReasoning.status, 400, '非法思考强度应 400');
  const mc = await get('/api/models-config');
  assert.ok(Array.isArray(mc.j.providers) && mc.j.providers.length >= 2 && Array.isArray(mc.j.customModels), '/api/models-config 结构');
  assert.ok(mc.j.providers.every((p) => p.name && p.label && p.keyState), '服务商条目字段完整');
  const badModel = await post('/api/config', { model: 'no-such-model-xyz' });
  assert.equal(badModel.status, 400, '无 Key 模型切换应 400');
  const badPerm = await post('/api/config', { permission: 'nope' });
  assert.equal(badPerm.status, 400, '非法权限模式应 400');
  const badCustom = await post('/api/models-config', { action: 'addCustom', name: 'bad name!', baseUrl: 'http://x' });
  assert.equal(badCustom.status, 400, '非法自定义模型名应 400');
  const badAction = await post('/api/models-config', { action: 'nope' });
  assert.equal(badAction.status, 400, '未知操作应 400');
  ok('config：state/config/models-config 契约');
}

// —— sessions 域 ——
{
  const ls = await get('/api/sessions');
  assert.ok(ls.j.ok && Array.isArray(ls.j.sessions), '/api/sessions 结构');
  const miss = await get('/api/session?file=no-such-session.json');
  assert.equal(miss.status, 404, '不存在会话应 404');
  const noFile = await get('/api/session');
  assert.equal(noFile.status, 400, '缺 file 应 400');
  const del = await post('/api/session', { action: 'delete', file: 'no-such.json' });
  assert.equal(del.status, 404, '删除不存在会话应 404');
  const badAct = await post('/api/session', { action: 'nope', file: 'x' });
  assert.equal(badAct.status, 404, '会话不存在先于操作校验');
  const draft = await post('/api/draft', { file: 's1', text: '草稿内容' });
  assert.equal(draft.status, 200);
  const dg = await get('/api/draft?file=s1');
  assert.equal(dg.j.text, '草稿内容', '草稿写入即读');
  const dg2 = await get('/api/draft?file=s1');
  assert.equal(dg2.j.text, '', '草稿读取即清除');
  ok('sessions：sessions/session/draft 契约');
}

// —— skills 域 ——
{
  const sk = await get('/api/skills');
  assert.ok(sk.j.ok && Array.isArray(sk.j.skills), '/api/skills 结构');
  const lib = await get('/api/skill-library');
  assert.ok(lib.j.ok && Array.isArray(lib.j.library) && lib.j.library.length >= 20, '技能库 20+');
  assert.ok(lib.j.library.every((s) => s.name && s.description), '技能条目字段');
  const badInstall = await post('/api/skills', { action: 'install', name: 'no-such-skill-xyz' });
  assert.equal(badInstall.status, 400, '未知技能安装应 400');
  const presets = await get('/api/mcp-presets');
  assert.ok(presets.j.ok && Array.isArray(presets.j.presets) && presets.j.presets.length > 0, 'MCP 预设非空');
  ok('skills：skills/skill-library/mcp-presets 契约');
}

// —— schedule 域 ——
{
  const sch = await get('/api/schedule');
  assert.ok(sch.j.ok && Array.isArray(sch.j.jobs), '/api/schedule 结构');
  const add = await post('/api/schedule', { action: 'add', question: '契约测试任务', every: '1h' });
  assert.equal(add.status, 200, add.j.error || '');
  assert.ok(add.j.id, 'add 应返回 id');
  const pause = await post('/api/schedule', { action: 'pause', id: add.j.id });
  assert.equal(pause.status, 200);
  const badAdd = await post('/api/schedule', { action: 'add', question: '' });
  assert.equal(badAdd.status, 400, '空任务应 400');
  const rm = await post('/api/schedule', { action: 'remove', id: add.j.id });
  assert.equal(rm.status, 200);
  const tasks = await get('/api/tasks');
  assert.ok(tasks.j.ok && Array.isArray(tasks.j.tasks) && Array.isArray(tasks.j.background) && typeof tasks.j.maxConcurrent === 'number', '/api/tasks 结构');
  ok('schedule：schedule/tasks 契约');
}

// —— sync 域 ——
{
  const st = await get('/api/sync');
  assert.ok(st.j.ok === true && st.j.loggedIn === false, '未登录状态结构');
  const badUrl = await post('/api/sync', { action: 'login', url: 'http://127.0.0.1:1', username: 'u', password: 'p' });
  assert.equal(badUrl.status, 400, '私网同步端点应被 SSRF 拦截');
  const badAct = await post('/api/sync', { action: 'nope' });
  assert.equal(badAct.status, 400, '未知操作应 400');
  const conflicts = await get('/api/sync-conflicts');
  assert.ok(conflicts.j.ok && Array.isArray(conflicts.j.conflicts), '/api/sync-conflicts 结构');
  ok('sync：sync 状态/SSRF/冲突契约');
}

// —— workspace 域 ——
{
  const ws = await get('/api/workspaces');
  assert.ok(ws.j.ok && Array.isArray(ws.j.workspaces) && ws.j.cwd, '/api/workspaces 结构');
  const add = await post('/api/workspaces', { action: 'add', name: '契约空间', dir: path.join(home, 'ws1') });
  assert.equal(add.status, 200, add.j.error || '');
  const dup = await post('/api/workspaces', { action: 'add', name: '契约空间', dir: path.join(home, 'ws2') });
  assert.equal(dup.status, 200, '重名登记 = 更新目录（200）');
  assert.equal(path.resolve(dup.j.dir), path.resolve(path.join(home, 'ws2')), '重名后目录应更新');
  const badName = await post('/api/workspaces', { action: 'add', name: 'a/b', dir: path.join(home, 'ws3') });
  assert.equal(badName.status, 400, '含路径分隔符的名称应 400');
  const rel = await get('/api/fs-browse?dir=relative/path');
  assert.equal(rel.status, 400, '相对路径应 400');
  const outside = await get('/api/fs-browse?dir=/etc');
  assert.equal(outside.status, 403, '越界目录应 403');
  // 浏览根各平台不同（Windows 收紧为 桌面/文档/下载，家目录本身不在根内）——
  // 用服务器工作目录（恒为合法根）做正向用例
  const wsRoot = (await get('/api/workspaces')).j.cwd;
  const browse = await get('/api/fs-browse?dir=' + encodeURIComponent(wsRoot));
  assert.ok(browse.j.ok === true && Array.isArray(browse.j.entries), '工作目录浏览结构');
  ok('workspace：workspaces/fs-browse 契约');
}

// —— misc 域 ——
{
  const mem = await get('/api/memory');
  assert.ok(mem.j.ok === true, '/api/memory GET 结构');
  await post('/api/memory', { content: '偏好一\n偏好一\n偏好二' });
  const dedupe = await post('/api/memory', { action: 'dedupe' });
  assert.equal(dedupe.status, 200);
  assert.equal(dedupe.j.removed, 1, '去重应移除 1 行');
  const cache = await get('/api/cache-stats');
  assert.ok(cache.j.ok && cache.j.summary && cache.j.breakdown && Array.isArray(cache.j.recent), '/api/cache-stats 结构');
  assert.ok(cache.j.breakdown.byModel && cache.j.breakdown.byTool && Array.isArray(cache.j.breakdown.byDay), '分账维度结构（B3）');
  const perm = await post('/api/permission', { taskId: 'no-such-task', answer: 'allow' });
  assert.equal(perm.status, 409, '无挂起确认应 409');
  const abort = await post('/api/abort', {});
  assert.equal(abort.status, 200, 'abort 全量中断应 200');
  // body 上限（质检 A4 回归：此前 readBody 忽略 limit 参数，1MB 限制形同虚设）——
  // 普通 JSON 接口超 1MB 必须 413；chat 保留 40MB 通道（附件 base64）
  const big = 'x'.repeat(1024 * 1024 + 10);
  const over = await fetch(base + '/api/memory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: big }) });
  assert.equal(over.status, 413, '普通接口 >1MB body 应 413（readBody limit 生效）');
  // chat 契约：POST 无 body 也应返回 SSE 错误事件而非挂起
  const chatRes = await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(chatRes.status, 200);
  assert.ok(String(chatRes.headers.get('content-type')).includes('text/event-stream'), 'chat 应返回 SSE');
  const chatBody = await chatRes.text();
  assert.ok(chatBody.includes('error') || chatBody.includes('data:'), 'SSE 事件流应有内容');
  ok('misc：memory/cache-stats/permission/abort/chat 契约');
}

await new Promise((r) => srv.close(r));
delete process.env.MINGDAO_HOME;
fs.rmSync(home, { recursive: true, force: true });
console.log(`\nAPI 域契约测试全部通过：${passed} 项 ✓`);
