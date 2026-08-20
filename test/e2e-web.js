// WebUI 端到端测试：mock Provider + 真实 HTTP 服务器 + SSE 事件流。
// 覆盖：页面加载、state、聊天流（text/tool/done）、ask 权限模态（允许/拒绝）、会话列表。
// 运行：node test/e2e-web.js

import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ✓ web：${name}`);
}

// ---------- mock Provider ----------
let requestCount = 0;
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const parsed = JSON.parse(body);
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

// 启动 web 服务器（可反复调用；返回 {child, base}）
let webChild = null;
async function startWeb(workDir) {
  if (webChild) {
    webChild.kill('SIGTERM');
    await new Promise((r) => webChild.once('close', r));
  }
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
  for (let i = 0; i < 60 && !base; i++) {
    const m = log.match(/地址: http:\/\/127\.0\.0\.1:(\d+)/);
    if (m) base = `http://127.0.0.1:${m[1]}`;
    else await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(base, 'web 服务器应在 12s 内就绪：' + log.slice(-300));
  return base;
}

// 读取一条聊天 SSE 流；遇到 ask 事件时调用 answerFn(id)（返回答案）
async function chatOnce(base, message, answerFn) {
  const resp = await fetch(base + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
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

// ---------- 2. 聊天流：text + tool + done（auto 权限） ----------
{
  requestCount = 0;
  const events = await chatOnce(base, '创建 web.txt');
  const types = events.map((e) => e.type);
  assert.ok(types.includes('text'), '应有文本事件');
  assert.ok(types.includes('tool'), '应有工具事件');
  assert.ok(types.includes('usage'), '应有用量事件');
  assert.ok(types.includes('done'), '应有 done 事件');
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

webChild.kill('SIGTERM');
await new Promise((r) => webChild.once('close', r));
mock.close();
for (const d of [work1]) fs.rmSync(d, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
console.log(`\nWebUI 端到端测试全部通过：${passed} 项 ✓`);
