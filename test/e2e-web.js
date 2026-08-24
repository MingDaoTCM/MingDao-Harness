// WebUI 端到端测试：mock Provider + 真实 HTTP 服务器 + SSE 事件流。
// 覆盖：页面加载、state、聊天流（text/tool/done）、ask 权限模态（允许/拒绝）、会话列表。
// 运行：node test/e2e-web.js

import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Windows：detached 后台任务/杀毒等短暂占用目录会让 rmSync 抛 EBUSY——清理容错重试（评估 D5）
const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
const sleepMs = (ms) => Atomics.wait(sleepBuf, 0, 0, ms);
function safeRm(target) {
  if (!target) return;
  for (let i = 0; i < 3; i++) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch {
      sleepMs(150);
    }
  }
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {}
}

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ✓ web：${name}`);
}

// ---------- mock Provider ----------
let requestCount = 0;
let lastPayload = null;
let payloadLog = [];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const parsed = JSON.parse(body);
    lastPayload = parsed;
    payloadLog.push(parsed);
    const sse = (payload) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      res.end('data: [DONE]\n\n');
    };
    if (!parsed.tools || !parsed.tools.length) {
      return sse({ choices: [{ delta: { content: '摘要' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
    }
    requestCount += 1;
    if (requestCount === 1) {
      return sse({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_w', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'web.txt', content: 'web 成功\n' }) } },
              ],
              finish_reason: 'tool_calls',
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      });
    }
    sse({ choices: [{ delta: { content: '网页回复完成！' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } });
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const mockPort = mock.address().port;

// ---------- 隔离环境 ----------
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-web-'));
function writeConfig(permission) {
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({
      provider: 'custom',
      model: 'test-model',
      baseUrl: `http://127.0.0.1:${mockPort}/v1`,
      permission,
      contextBudget: 32000,
    })
  );
}
writeConfig('auto');
fs.writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({ custom: 'sk-test-1234567890abcdef' }), { mode: 0o600 });

// 启动 web 服务器（可反复调用；返回 {child, base}）。
// Windows 随机端口可能命中 Hyper-V 保留段（如 50770–50869）抛 EACCES/EADDRINUSE——捕获后换端口重试（评估 P2-2）
let webChild = null;
async function startWeb(workDir) {
  if (webChild) {
    webChild.kill('SIGTERM');
    await new Promise((r) => webChild.once('close', r));
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = 40000 + Math.floor(Math.random() * 20000); // 随机端口，避免与常驻服务冲突
    const child = spawn(process.execPath, [path.join(root, 'src', 'cli.js'), 'web', String(port)], {
      cwd: workDir,
      env: { ...process.env, MINGDAO_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    webChild = child;
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    let base = null;
    let exitedEarly = false;
    child.on('exit', (code) => {
      if (code !== null && code !== 0) exitedEarly = true;
    });
    for (let i = 0; i < 60 && !base && !exitedEarly; i++) {
      const m = log.match(/地址: http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) base = `http://127.0.0.1:${m[1]}`;
      else await new Promise((r) => setTimeout(r, 200));
    }
    if (base) return base;
    // 端口被保留/占用：杀掉换端口重试
    try {
      child.kill('SIGTERM');
    } catch {}
    await new Promise((r) => child.once('close', r));
  }
  assert.ok(false, 'web 服务器三次尝试均未在 12s 内就绪（端口可能命中系统保留段）');
  return null;
}

// 读取一条聊天 SSE 流；遇到 ask 事件时调用 answerFn(id)（返回答案）
async function chatOnce(base, message, answerFn) {
  const payload = typeof message === 'string' ? { message } : message;
  const resp = await fetch(base + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(resp.status, 200, 'chat 应返回 200');
  const events = [];
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      let ev;
      try {
        ev = JSON.parse(line.slice(5));
      } catch {
        continue;
      }
      events.push(ev);
      if (ev.type === 'ask' && answerFn) {
        const answer = answerFn(ev);
        const pr = await fetch(base + '/api/permission', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: ev.id, answer, taskId: ev.taskId }),
        });
        assert.equal(pr.status, 200, '应答权限确认应返回 200');
      }
    }
  }
  return events;
}

const work1 = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-webwork-'));
let base = await startWeb(work1);

// ---------- 1. 页面与状态 ----------
{
  const html = await (await fetch(base + '/')).text();
  assert.ok(html.includes('MingDao'), '首页应包含标题');
  assert.ok(html.includes('/api/chat'), '前端应引用聊天接口');
  const st = await (await fetch(base + '/api/state')).json();
  assert.equal(st.ok, true);
  assert.equal(st.model, 'test-model');
  assert.ok(Array.isArray(st.sessions));
  ok('首页与 /api/state');
}

// ---------- 1.5 界面配置：模型与权限切换 ----------
{
  const cfg1 = await (await fetch(base + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ permission: 'readonly' }) })).json();
  assert.equal(cfg1.ok, true, '权限切换应成功');
  assert.equal(cfg1.permission, 'readonly');
  const st1 = await (await fetch(base + '/api/state')).json();
  assert.equal(st1.permission, 'readonly');
  // 模型列表按「已设 Key 的服务商」过滤：e2e 只配了 custom，故仅当前模型兜底条目
  assert.ok(Array.isArray(st1.models) && st1.models.length >= 1, '应返回可选模型列表');
  assert.ok(st1.models.some((m) => m.name === 'test-model'), '当前模型应兜底列出');
  assert.ok(st1.models.every((m) => m.providerLabel), '模型应带服务商分组标签');
  assert.ok(Array.isArray(st1.permissions) && st1.permissions.length === 3);
  assert.ok(typeof st1.contextBudget === 'number');
  const set2 = await (await fetch(base + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sandbox: 'safe', routing: true, contextBudget: 50000 }) })).json();
  assert.equal(set2.ok, true);
  assert.equal(set2.sandbox, 'safe');
  assert.equal(set2.routing, true);
  assert.equal(set2.contextBudget, 50000);
  const badBudget = await fetch(base + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contextBudget: 100 }) });
  assert.equal(badBudget.status, 400, '预算过小应拒绝');
  const bad = await fetch(base + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'qwen3.7-max' }) });
  const badJ = await bad.json();
  assert.equal(bad.status, 400, '无 Key 的模型应拒绝');
  assert.ok(String(badJ.error).includes('API Key'));
  const back = await (await fetch(base + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'test-model', permission: 'auto' }) })).json();
  assert.equal(back.ok, true);
  ok('界面配置：权限切换 / 模型列表 / 无 Key 拒绝');
}

// ---------- 2. 聊天流：text + tool + done（auto 权限） ----------
{
  requestCount = 0;
  const events = await chatOnce(base, '创建 web.txt');
  const types = events.map((e) => e.type);
  assert.ok(types.includes('text'), '应有文本事件');
  assert.ok(types.includes('toolStart'), '应有工具开始事件（执行中卡片）');
  assert.ok(types.includes('turnStart'), '应有回合开始事件（持续思考指示）');
  assert.ok(types.includes('tool'), '应有工具事件');
  assert.ok(types.includes('usage'), '应有用量事件');
  assert.ok(types.includes('done'), '应有 done 事件');
  const startIdx = events.findIndex((e) => e.type === 'toolStart');
  const toolIdx = events.findIndex((e) => e.type === 'tool');
  assert.ok(startIdx > -1 && toolIdx > startIdx, '工具开始事件应在完成事件之前');
  assert.equal(events[toolIdx].seq, events[startIdx].seq, '开始与完成事件应同 seq 配对');
  const doneEv = events.find((e) => e.type === 'done');
  assert.ok(doneEv.stats && doneEv.stats.deliverables.includes('web.txt'), 'done 应带交付物统计（web.txt）');
  assert.ok(doneEv.stats.toolCount >= 1, 'done 应带工具步数统计');
  const tool = events.find((e) => e.type === 'tool');
  assert.equal(tool.name, 'write');
  assert.equal(tool.result.ok, true);
  assert.ok(events.some((e) => e.type === 'text' && e.delta.includes('网页回复完成')), '应有流式最终文本');
  assert.equal(fs.readFileSync(path.join(work1, 'web.txt'), 'utf8'), 'web 成功\n');
  ok('聊天流：text/tool/done + 文件落盘');
}

// ---------- 3. ask 权限模态：拒绝 → 不执行 ----------
{
  writeConfig('ask');
  const work2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-webwork2-'));
  base = await startWeb(work2);
  requestCount = 0;
  const events = await chatOnce(base, '创建 web.txt', () => 'n');
  assert.ok(events.some((e) => e.type === 'ask'), '应收到权限确认事件');
  assert.ok(!fs.existsSync(path.join(work2, 'web.txt')), '拒绝后文件不应创建');
  assert.ok(events.some((e) => e.type === 'toolDenied'), '应有拒绝标记');
  ok('ask 权限模态：拒绝 → 工具不执行');
}

// ---------- 4. ask 权限模态：允许 → 执行 ----------
{
  const work3 = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-webwork3-'));
  base = await startWeb(work3);
  requestCount = 0;
  const events = await chatOnce(base, '创建 web.txt', () => 'y');
  assert.ok(events.some((e) => e.type === 'tool' && e.result.ok), '允许后工具应执行');
  assert.equal(fs.readFileSync(path.join(work3, 'web.txt'), 'utf8'), 'web 成功\n');
  assert.ok(events.some((e) => e.type === 'done'));
  ok('ask 权限模态：允许 → 工具执行');
}

// ---------- 5. 多会话并行 + 任务面板 + 中断路由 ----------
{
  writeConfig('auto');
  const workP = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-webpar-'));
  base = await startWeb(workP);
  requestCount = 0;
  const [e1, e2] = await Promise.all([chatOnce(base, '并行任务一'), chatOnce(base, '并行任务二')]);
  assert.ok(e1.some((e) => e.type === 'done') && e2.some((e) => e.type === 'done'), '两个任务都应完成');
  assert.ok(e1[0].taskId && e2[0].taskId && e1[0].taskId !== e2[0].taskId, '任务应有独立 taskId');
  const tp = await (await fetch(base + '/api/tasks')).json();
  assert.ok(tp.tasks.length >= 2, '任务面板应列出任务');
  const abortResp = await fetch(base + '/api/abort', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(abortResp.status, 200, '中断路由应可用');
  ok('多会话并行：并发完成 + taskId 独立 + 任务面板 + 中断路由');
}

// ---------- 6. 会话列表路由 ----------
{
  const st = await (await fetch(base + '/api/sessions')).json();
  assert.equal(st.ok, true);
  assert.ok(st.sessions.length >= 2, '应列出多个会话（含预览）');
  assert.ok(st.sessions.some((s) => s.label.includes('创建 web.txt')), '应能找到工具测试会话');
  assert.ok(st.sessions.some((s) => s.file.startsWith('摘要')), '自动标题应将会话重命名为「摘要」');
  ok('会话列表与预览 + 自动标题');
}

// ---------- 7. 草稿通道（VS Code 选中代码发送） ----------
{
  const post = await fetch(base + '/api/draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '来自 VS Code 的代码片段' }) });
  assert.equal(post.status, 200);
  const g1 = await (await fetch(base + '/api/draft')).json();
  assert.equal(g1.text, '来自 VS Code 的代码片段', '第一次读取应返回草稿');
  const g2 = await (await fetch(base + '/api/draft')).json();
  assert.equal(g2.text, '', '读取后应清除');
  ok('草稿通道：写入 / 一次读取 / 自动清除');
}

// ---------- 8. 调度 API（面板可视化后端） ----------
{
  const empty = await (await fetch(base + '/api/schedule')).json();
  assert.equal(empty.ok, true);
  assert.ok(Array.isArray(empty.jobs));
  const bad = await fetch(base + '/api/schedule', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'add', question: '' }) });
  assert.equal(bad.status, 400, '空任务应拒绝');
  const add = await (await fetch(base + '/api/schedule', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'add', question: '面板定时任务', every: '2s' }) })).json();
  assert.equal(add.ok, true);
  assert.ok(add.id);
  const listed = await (await fetch(base + '/api/schedule')).json();
  assert.ok(listed.jobs.some((j) => j.id === add.id));
  const pause = await (await fetch(base + '/api/schedule', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'pause', id: add.id }) })).json();
  assert.equal(pause.ok, true);
  const rm = await (await fetch(base + '/api/schedule', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'remove', id: add.id }) })).json();
  assert.equal(rm.ok, true);
  const after = await (await fetch(base + '/api/schedule')).json();
  assert.ok(!after.jobs.some((j) => j.id === add.id), '删除后应消失');
  ok('调度 API：列表 / 添加 / 暂停 / 删除');
}

// ---------- 9. 会话管理：重命名 / 删除 ----------
{
  requestCount = 0;
  await chatOnce(base, '会话管理测试消息');
  const st = await (await fetch(base + '/api/sessions')).json();
  const target = st.sessions.find((s) => s.label.includes('会话管理测试消息'));
  assert.ok(target, '应存在测试会话');
  const rename = await (await fetch(base + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'rename', file: target.file, title: '改名后的会话' }) })).json();
  assert.equal(rename.ok, true);
  assert.ok(rename.file.includes('改名后的会话'));
  const del = await (await fetch(base + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete', file: rename.file }) })).json();
  assert.equal(del.ok, true);
  const gone = await fetch(base + '/api/session?file=' + encodeURIComponent(rename.file));
  assert.equal(gone.status, 404, '删除后应不可载入');
  const badDel = await fetch(base + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete', file: '../credentials.json' }) });
  assert.equal(badDel.status, 404, '路径穿越应被 basename 防护拒绝');
  ok('会话管理：重命名 / 删除 / 路径防护');
}

// ---------- 10. 模型与 API Key 管理 ----------
{
  const mc = await (await fetch(base + '/api/models-config')).json();
  assert.equal(mc.ok, true);
  assert.ok(Array.isArray(mc.providers) && mc.providers.some((p) => p.name === 'deepseek'), '应列出内置服务商');
  assert.ok(mc.providers.find((p) => p.name === 'custom').keyState === 'stored', 'custom 的 Key 应来自凭证库');
  assert.ok(mc.providers.find((p) => p.name === 'custom').keyMasked.includes('…'), 'Key 应脱敏显示');
  const add = await (await fetch(base + '/api/models-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'addCustom', name: 'web-custom', label: '网页自定义', baseUrl: `http://127.0.0.1:${mockPort}/v1`, key: 'sk-web-custom' }) })).json();
  assert.equal(add.ok, true, add.error);
  const badAdd = await fetch(base + '/api/models-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'addCustom', name: 'Bad Name!', label: 'x', baseUrl: 'https://x/v1' }) });
  assert.equal(badAdd.status, 400, '非法模型名应 400');
  const badUrl = await fetch(base + '/api/models-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'addCustom', name: 'ok-name', label: 'x', baseUrl: 'ftp://x' }) });
  assert.equal(badUrl.status, 400, '非法 baseUrl 应 400');
  const dup = await fetch(base + '/api/models-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'addCustom', name: 'web-custom', label: 'x', baseUrl: 'https://x/v1' }) });
  assert.equal(dup.status, 400, '重复添加应 400');
  const st = await (await fetch(base + '/api/state')).json();
  assert.ok(st.models.some((m) => m.name === 'web-custom' && m.custom), '模型下拉应包含自定义模型');
  const sw = await (await fetch(base + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'web-custom' }) })).json();
  assert.equal(sw.ok, true, sw.error);
  const up = await (await fetch(base + '/api/models-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'updateCustom', name: 'web-custom', label: '改标签', baseUrl: `http://127.0.0.1:${mockPort}/v1` }) })).json();
  assert.equal(up.ok, true, up.error);
  const sk = await (await fetch(base + '/api/models-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'setCustomKey', name: 'web-custom', key: 'sk-new-key-1234567890' }) })).json();
  assert.ok(sk.ok && sk.keyMasked.includes('…'), '应支持自定义模型设 Key');
  const pk = await (await fetch(base + '/api/models-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'setProviderKey', provider: 'deepseek', key: 'sk-ds-test-1234567890' }) })).json();
  assert.ok(pk.ok && pk.keyMasked.includes('…'), '应支持服务商设 Key');
  const rk = await (await fetch(base + '/api/models-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'removeProviderKey', provider: 'deepseek' }) })).json();
  assert.equal(rk.ok, true);
  const rm = await (await fetch(base + '/api/models-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'removeCustom', name: 'web-custom' }) })).json();
  assert.equal(rm.ok, true, rm.error);
  assert.equal(rm.model, 'deepseek-v4-flash', '删除当前自定义模型应回退默认');
  const back = await (await fetch(base + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'test-model' }) })).json();
  assert.equal(back.ok, true, back.error);
  const b1 = await (await fetch(base + '/api/models-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'setBaseUrl', baseUrl: `http://127.0.0.1:${mockPort}/v1` }) })).json();
  assert.equal(b1.ok, true);
  const html = await (await fetch(base + '/')).text();
  assert.ok(html.includes('pkList') && html.includes('cmAdd'), '前端应包含模型与 Key 管理面板');
  ok('模型与 API Key：添加/修改/删除自定义模型 + 服务商 Key 管理');
}

// ---------- 10. 技能库 API：列表 / 安装 / 卸载 ----------
{
  const lib = await (await fetch(base + '/api/skill-library')).json();
  assert.equal(lib.ok, true);
  assert.ok(Array.isArray(lib.library) && lib.library.length >= 20, '技能库应返回 20+ 技能');
  assert.ok(lib.library.every((s) => s.name && s.description), '技能应含名称与描述');
  assert.ok(Array.isArray(lib.installed), '应返回已安装列表');
  const q = await (await fetch(base + '/api/skill-library?q=简历')).json();
  assert.ok(q.library.some((s) => s.name === 'resume'), '关键词查询应命中 resume');
  const ins = await (await fetch(base + '/api/skills', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'install', name: 'resume' }) })).json();
  assert.equal(ins.ok, true, ins.error);
  const lib2 = await (await fetch(base + '/api/skill-library')).json();
  assert.ok(lib2.library.find((s) => s.name === 'resume').installed, '安装后应标记已安装');
  const bad = await fetch(base + '/api/skills', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'install', name: 'nope' }) });
  assert.equal(bad.status, 400, '未知技能应 400');
  const un = await (await fetch(base + '/api/skills', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'uninstall', name: 'resume' }) })).json();
  assert.equal(un.ok, true, un.error);
  const lib3 = await (await fetch(base + '/api/skill-library')).json();
  assert.ok(!lib3.library.find((s) => s.name === 'resume').installed, '卸载后应标记未安装');
  const html = await (await fetch(base + '/')).text();
  assert.ok(html.includes('skillLibList'), '前端应包含技能库面板');
  ok('技能库 API：列表 / 搜索 / 安装 / 卸载');
}

// ---------- 11. 云同步 API：登录 / 状态 / 推送 / 退出 ----------
{
  const { runSyncServer } = await import(pathToFileURL(path.join(root, 'src', 'sync-server.js')).href);
  const syncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-websync-'));
  const srv = runSyncServer({ port: 0, host: '127.0.0.1', dataDir: syncDir });
  await new Promise((r) => srv.once('listening', r));
  const syncUrl = `http://127.0.0.1:${srv.address().port}`;
  const login = await (await fetch(base + '/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'login', url: syncUrl, username: 'webuser', password: 'password123', deviceName: 'e2e-web' }) })).json();
  assert.equal(login.ok, true, login.error);
  const st = await (await fetch(base + '/api/sync')).json();
  assert.ok(st.loggedIn && st.username === 'webuser' && st.url === syncUrl, '状态应显示已登录');
  const push = await (await fetch(base + '/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'push' }) })).json();
  assert.equal(push.ok, true, push.error);
  assert.ok(typeof push.pushed === 'number', '应返回推送数量');
  const bad = await fetch(base + '/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'login', url: syncUrl, username: 'webuser', password: 'short' }) });
  assert.equal(bad.status, 400, '弱密码应 400');
  // 分享：webuser 创建 → bob 接受（用本机真实存在的会话名）
  const localSessions = fs.readdirSync(path.join(home, 'sessions')).filter((f) => f.endsWith('.jsonl') && !f.includes('.server-') && !f.includes('.remote-'));
  assert.ok(localSessions.length > 0, '应有可分享的本地会话');
  const shareName = localSessions[0];
  const sh = await (await fetch(base + '/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'share', name: shareName }) })).json();
  assert.equal(sh.ok, true, sh.error);
  assert.ok(/^[0-9a-f]{16}$/.test(sh.shareId), '分享码格式');
  const shares = await (await fetch(base + '/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'shares' }) })).json();
  assert.ok(shares.mine.some((s) => s.shareId === sh.shareId), '我的分享列表');
  // 改密码（旧密码错 → 400；正确 → ok）
  const pwBad = await fetch(base + '/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'passwd', oldPassword: 'wrong', newPassword: 'newpassword456' }) });
  assert.equal(pwBad.status, 400, '旧密码错误应 400');
  const pwOk = await (await fetch(base + '/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'passwd', oldPassword: 'password123', newPassword: 'newpassword456' }) })).json();
  assert.equal(pwOk.ok, true, pwOk.error);
  // bob 登录接受
  await fetch(base + '/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'logout' }) });
  const lb = await (await fetch(base + '/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'login', url: syncUrl, username: 'bobuser', password: 'password123', deviceName: 'bob-pc' }) })).json();
  assert.equal(lb.ok, true, lb.error);
  const acc = await (await fetch(base + '/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'accept', shareId: sh.shareId }) })).json();
  assert.equal(acc.ok, true, acc.error);
  assert.ok(fs.existsSync(path.join(home, 'sessions', acc.savedAs)), '接受后本地应有会话文件');
  // 换回 webuser（新密码）
  await fetch(base + '/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'logout' }) });
  const lw = await (await fetch(base + '/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'login', url: syncUrl, username: 'webuser', password: 'newpassword456', deviceName: 'e2e-web' }) })).json();
  assert.equal(lw.ok, true, '新密码登录应成功');
  // 冲突面板：构造备份 → 列表 → 三选一解决
  fs.writeFileSync(path.join(home, 'sessions', 'cf-demo.server-1000.jsonl'), '{"role":"user","content":"远端"}\n');
  fs.writeFileSync(path.join(home, 'sessions', 'cf-demo.remote-2000.jsonl'), '{"role":"user","content":"拉取"}\n');
  const cf = await (await fetch(base + '/api/sync-conflicts')).json();
  assert.ok(cf.conflicts.some((c) => c.base === 'cf-demo.jsonl' && c.entries.length === 2), '冲突列表');
  const rv = await (await fetch(base + '/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'resolveConflict', base: 'cf-demo.jsonl', choice: 'both' }) })).json();
  assert.equal(rv.ok, true, rv.error);
  const cf2 = await (await fetch(base + '/api/sync-conflicts')).json();
  assert.ok(!cf2.conflicts.some((c) => c.base === 'cf-demo.jsonl'), '解决后应消失');
  const out = await (await fetch(base + '/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'logout' }) })).json();
  assert.equal(out.ok, true);
  const html = await (await fetch(base + '/')).text();
  assert.ok(html.includes('syncLogin') && html.includes('syncAutoChk'), '前端应包含云同步面板');
  srv.close();
  safeRm(syncDir, { recursive: true, force: true });
  ok('云同步 API：登录 / 状态 / 推送 / 退出');
}

// ---------- 12. 附件：文本内联 / 视觉门控 / 视觉模型图文数组 ----------
{
  requestCount = 0;
  const ev1 = await chatOnce(base, { message: '总结这份文件', attachments: [{ type: 'text', name: 'notes.txt', content: '要点一\n要点二' }] });
  assert.ok(ev1.some((e) => e.type === 'done'), '文本附件聊天应完成');
  const lu1 = lastPayload.messages.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('[文件 notes.txt]'));
  assert.ok(lu1 && lu1.content.includes('要点一'), '文本附件应内联进模型消息');
  // 非视觉模型 + 图片 → error 事件（test-model 无视觉能力）
  const ev2 = await chatOnce(base, { message: '看图', attachments: [{ type: 'image', name: 'a.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }] });
  assert.ok(ev2.some((e) => e.type === 'error' && String(e.message).includes('不支持图片')), '非视觉模型应拒绝图片');
  // 视觉自定义模型（vision:true）→ 图文数组透传
  const addV = await (await fetch(base + '/api/models-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'addCustom', name: 'web-vision', label: '视觉', baseUrl: `http://127.0.0.1:${mockPort}/v1`, key: 'sk-web-vision-1234567890', vision: true }) })).json();
  assert.equal(addV.ok, true, addV.error);
  const swV = await (await fetch(base + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'web-vision' }) })).json();
  assert.equal(swV.ok, true, swV.error);
  requestCount = 0;
  const ev3 = await chatOnce(base, { message: '描述这张图', attachments: [{ type: 'image', name: 'a.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }] });
  assert.ok(ev3.some((e) => e.type === 'done'), '视觉模型聊天应完成');
  const lu3 = payloadLog.find((pl) => pl.messages && pl.messages.some((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')));
  assert.ok(lu3, '视觉模型应收到图文数组（在请求日志中）');
  const backM = await (await fetch(base + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'test-model' }) })).json();
  assert.equal(backM.ok, true, backM.error);
  await fetch(base + '/api/models-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'removeCustom', name: 'web-vision' }) });
  const html = await (await fetch(base + '/')).text();
  assert.ok(html.includes('attachBtn') && html.includes('fileInput'), '前端应包含上传入口');
  ok('附件：文本内联 / 视觉门控 / 视觉模型图文数组');
}

// ---------- 13. 工作空间头部下拉：新建（目录自动创建）/ 切换（服务端 cwd 跟随） ----------
{
  const newDir = path.join(os.tmpdir(), 'mingdao-ws-' + Date.now());
  const add0 = await (await fetch(base + '/api/workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'add', name: '原空间', dir: work1 }) })).json();
  assert.equal(add0.ok, true, add0.error);
  const add = await (await fetch(base + '/api/workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'add', name: '自动创建测试', dir: newDir }) })).json();
  assert.equal(add.ok, true, add.error);
  assert.ok(fs.existsSync(newDir), '不存在的目录应自动创建');
  const set = await (await fetch(base + '/api/workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'set', name: '自动创建测试' }) })).json();
  assert.equal(set.ok, true, set.error);
  assert.equal(set.dir, newDir);
  const st = await (await fetch(base + '/api/state')).json();
  assert.equal(st.workspace, '自动创建测试', 'state 应显示当前工作空间');
  assert.equal(st.workingDir, newDir, '服务端 workingDir 应跟随切换');
  const back = await (await fetch(base + '/api/workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'set', name: '原空间' }) })).json();
  assert.equal(back.ok, true, back.error);
  const st2 = await (await fetch(base + '/api/state')).json();
  assert.equal(st2.workingDir, work1, '应能切回原目录');
  const html = await (await fetch(base + '/')).text();
  assert.ok(html.includes('wsSel'), '前端应包含工作空间下拉');
  safeRm(newDir, { recursive: true, force: true });
  ok('工作空间：头部下拉 / 目录自动创建 / 服务端切换');
}

// ---------- 14. WebUI 访问令牌与 Host 校验（P1-3/P1-4） ----------
{
  const authPort = 40000 + Math.floor(Math.random() * 20000);
  const child = spawn(
    process.execPath,
    [path.join(root, 'src', 'cli.js'), 'web', String(authPort), '--auth-token', 'tok-test-123'],
    { cwd: work1, env: { ...process.env, MINGDAO_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  let tbase = null;
  for (let i = 0; i < 60 && !tbase; i++) {
    const m = log.match(/地址: http:\/\/127\.0\.0\.1:(\d+)/);
    if (m) tbase = `http://127.0.0.1:${m[1]}`;
    else await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(tbase, '带令牌的 web 服务器应在 12s 内就绪：' + log.slice(-300));
  // 壳页面公开（不含数据，SPA 需先加载才能读取 ?token=）
  const shell = await fetch(tbase + '/');
  assert.equal(shell.status, 200, '壳页面应无需令牌即可加载');
  // 数据接口：无令牌 401；query / header 两种携带方式均放行；错误令牌 401
  const noTok = await fetch(tbase + '/api/state');
  assert.equal(noTok.status, 401, '无令牌访问数据接口应 401');
  const byQuery = await fetch(tbase + '/api/state?token=tok-test-123');
  assert.equal(byQuery.status, 200, '?token= 应放行');
  const byHeader = await fetch(tbase + '/api/state', { headers: { 'X-MingDao-Token': 'tok-test-123' } });
  assert.equal(byHeader.status, 200, 'X-MingDao-Token 头应放行');
  const badTok = await fetch(tbase + '/api/state?token=wrong');
  assert.equal(badTok.status, 401, '错误令牌应 401');
  // 权限应答接口同样受令牌保护（taskId 不可枚举）
  const permNoTok = await fetch(tbase + '/api/permission', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'x', answer: 'y', taskId: 't1' }),
  });
  assert.equal(permNoTok.status, 401, '/api/permission 无令牌应 401');
  // Host 白名单（DNS rebinding）：伪造 Host 即使带对令牌也应 403（用原生 http 精确控制 Host 头）
  const badHostStatus = await new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: authPort, path: '/api/state', headers: { Host: `evil.example:${authPort}`, 'X-MingDao-Token': 'tok-test-123' } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      }
    );
    req.on('error', () => resolve(0));
    req.end();
  });
  assert.equal(badHostStatus, 403, '伪造 Host 应 403');
  child.kill('SIGTERM');
  await new Promise((r) => child.once('close', r));
  ok('访问控制：token 认证（query/header/401）+ Host 白名单（DNS rebinding 403）');
}

// ---------- 15. 带上文开关：最近会话日志默认不注入，withJournal 显式注入 ----------
{
  fs.writeFileSync(
    path.join(home, 'journal.jsonl'),
    JSON.stringify({ at: Date.now(), workspace: null, firstUser: '上次做了游戏', outcome: '完成网页游戏', turns: 3 }) + '\n'
  );
  // 注意：会话结束后的自动标题请求也会打到 mock（tools 为空），需在 payloadLog 切片里找聊天请求的 system 消息
  requestCount = 0;
  const mark1 = payloadLog.length;
  await chatOnce(base, '检查系统提示');
  const sys1 = payloadLog.slice(mark1).find((pl) => String(pl.messages?.[0]?.content).includes('工作准则'));
  assert.ok(sys1 && !String(sys1.messages[0].content).includes('recent_sessions'), '默认系统提示不应注入最近会话日志');
  requestCount = 0;
  const mark2 = payloadLog.length;
  await chatOnce(base, { message: '检查系统提示', withJournal: true });
  const sys2 = payloadLog.slice(mark2).find((pl) => String(pl.messages?.[0]?.content).includes('工作准则'));
  assert.ok(sys2 && String(sys2.messages[0].content).includes('recent_sessions') && String(sys2.messages[0].content).includes('上次做了游戏'), 'withJournal 应注入最近会话日志');
  ok('带上文开关：默认全新上下文 / withJournal 显式注入');
}

// ---------- 16. 自动压缩端到端（P3-1）：超预算会话 → 摘要注入 + 会话文件重写 ----------
{
  requestCount = 0;
  let sessFile = null;
  const longMsg = '这是一段用于撑大上下文的中文长文本。'.repeat(600); // ≈ 1 万字 ≈ 7.5K tokens/条
  for (let i = 0; i < 6; i++) {
    requestCount = 0;
    const payload = sessFile ? { message: `第${i}轮：${longMsg}`, file: sessFile } : { message: `第${i}轮：${longMsg}` };
    const evs = await chatOnce(base, payload);
    const done = evs.find((e) => e.type === 'done');
    assert.ok(done, `第${i}轮应完成`);
    sessFile = done.session;
  }
  const raw = fs.readFileSync(path.join(home, 'sessions', sessFile), 'utf8');
  assert.ok(raw.includes('conversation_summary'), '压缩后会话文件应含摘要消息');
  assert.ok(!raw.includes('第0轮：'), '最早消息应已被摘要替代（会话文件重写生效）');
  ok('自动压缩端到端：超预算触发 / 摘要注入 / 会话文件重写');
}

// ---------- 17. 会话级工作空间（P3-4）：并行任务互不串目录 ----------
{
  const wsA = path.join(os.tmpdir(), 'mingdao-wsa-' + Date.now());
  const wsB = path.join(os.tmpdir(), 'mingdao-wsb-' + Date.now());
  fs.mkdirSync(wsA, { recursive: true });
  fs.mkdirSync(wsB, { recursive: true });
  const addA = await (await fetch(base + '/api/workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'add', name: '空间A', dir: wsA }) })).json();
  const addB = await (await fetch(base + '/api/workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'add', name: '空间B', dir: wsB }) })).json();
  assert.equal(addA.ok && addB.ok, true, '两个工作空间应登记成功');
  await fetch(base + '/api/workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'set', name: '空间A' }) });
  // 新会话在 A 中执行（mock 首请求 write web.txt → 写入会话工作空间）
  requestCount = 0;
  const evs1 = await chatOnce(base, '在 A 工作空间干活');
  const sess = evs1.find((e) => e.type === 'done').session;
  assert.ok(fs.existsSync(path.join(wsA, 'web.txt')), '新会话应写入创建时的工作空间 A');
  // 全局切到 B（不带 file）→ 继续同一会话：任务仍应写 A，而不是 B
  await fetch(base + '/api/workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'set', name: '空间B' }) });
  safeRm(path.join(wsA, 'web.txt'), { force: true });
  requestCount = 0;
  const evs2 = await chatOnce(base, { message: '继续上次的会话', file: sess });
  assert.equal(evs2.find((e) => e.type === 'done').session, sess, '应继续同一会话');
  assert.ok(fs.existsSync(path.join(wsA, 'web.txt')), '继续会话仍写入其记录的工作空间 A');
  assert.ok(!fs.existsSync(path.join(wsB, 'web.txt')), '全局切换 B 不应影响已有会话');
  // 载入接口返回会话工作空间名
  const sj = await (await fetch(base + '/api/session?file=' + encodeURIComponent(sess))).json();
  assert.equal(sj.workspace, '空间A', '载入接口应返回会话工作空间名');
  // 显式切换（带 file）→ 会话工作空间跟随
  const setWithFile = await (await fetch(base + '/api/workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'set', name: '空间B', file: sess }) })).json();
  assert.equal(setWithFile.ok, true, setWithFile.error);
  const sj2 = await (await fetch(base + '/api/session?file=' + encodeURIComponent(sess))).json();
  assert.equal(sj2.workspace, '空间B', '显式切换后会话工作空间应跟随');
  safeRm(wsA, { recursive: true, force: true });
  safeRm(wsB, { recursive: true, force: true });
  ok('会话级工作空间：新会话记录 / 继续不串目录 / 载入返回 / 显式切换跟随');
}

// ---------- 18. 目录浏览器 /api/fs-browse（工作空间目录选择器） ----------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-browse-'));
  fs.mkdirSync(path.join(dir, '子目录甲'));
  fs.mkdirSync(path.join(dir, '.hidden-dir'));
  const r = await (await fetch(base + '/api/fs-browse?dir=' + encodeURIComponent(dir))).json();
  assert.equal(r.ok, true, '应能浏览目录');
  assert.equal(r.path, dir, '应返回当前路径');
  assert.ok(Array.isArray(r.entries), '应返回条目列表');
  assert.ok(r.entries.some((e) => e.name === '子目录甲' && e.path === path.join(dir, '子目录甲')), '应包含普通子目录');
  assert.ok(!r.entries.some((e) => e.name.startsWith('.')), '应过滤隐藏目录');
  assert.equal(r.parent, path.dirname(dir), '应返回上级目录');
  const bad = await (await fetch(base + '/api/fs-browse?dir=relative%2Fpath')).json();
  assert.ok(bad.error, '相对路径应被拒绝');
  const notDir = await (await fetch(base + '/api/fs-browse?dir=' + encodeURIComponent(path.join(dir, '子目录甲')) + '%2Fnope')).json();
  assert.ok(notDir.error, '不存在目录应报错');
  safeRm(dir, { recursive: true, force: true });
  ok('fs-browse：目录树浏览 / 隐藏目录过滤 / 相对路径与非法路径拒绝');
}

webChild.kill('SIGTERM');
await new Promise((r) => webChild.once('close', r));
mock.close();
for (const d of [work1]) safeRm(d, { recursive: true, force: true });
safeRm(home, { recursive: true, force: true });
console.log(`\nWebUI 端到端测试全部通过：${passed} 项 ✓`);
