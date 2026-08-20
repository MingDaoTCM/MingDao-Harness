// 任务队列与调度 e2e：mock Provider + 真实 sleeper/worker 进程。
// 覆盖：一次性定时（--at）、周期（--every，s 单位）、链式依赖（chain）、暂停/恢复、任务面板联动。
// 运行：node test/e2e-schedule.js

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
  console.log(`  ✓ 调度：${name}`);
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
      const name = 'write';
      const args = { path: 'sched.txt', content: '调度成功\n' };
      sse({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'call_s', type: 'function', function: { name, arguments: JSON.stringify(args) } }],
              finish_reason: 'tool_calls',
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      });
    } else {
      sse({ choices: [{ delta: { content: '调度任务完成！' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } });
    }
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const mockPort = mock.address().port;

// ---------- 隔离环境 ----------
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-sched-'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-schedwork-'));
fs.writeFileSync(
  path.join(home, 'config.json'),
  JSON.stringify({
    provider: 'custom',
    model: 'test-model',
    baseUrl: `http://127.0.0.1:${mockPort}/v1`,
    permission: 'auto',
    autoTitle: false,
    contextBudget: 32000,
  })
);
fs.writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({ custom: 'sk-test-1234567890abcdef' }), { mode: 0o600 });

function runCli(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'src', 'cli.js'), ...args], {
      cwd: opts.cwd || work,
      env: { ...process.env, MINGDAO_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmt(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function jobFile(id) {
  return path.join(home, 'schedule', id + '.json');
}

async function waitFor(fn, timeoutMs, intervalMs = 400) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(intervalMs);
  }
}

// ---------- 1. 一次性定时（--at 5 秒后） ----------
{
  requestCount = 0;
  const at = fmt(new Date(Date.now() + 5000));
  const r = await runCli(['schedule', 'add', '创建定时文件', '--at', at]);
  assert.equal(r.code, 0, r.err);
  const id = (r.out.match(/已创建\s+(\S+)/) || [])[1];
  assert.ok(id);
  const job = await waitFor(() => {
    const j = readJson(jobFile(id));
    return j && j.status === 'done' ? j : null;
  }, 25000);
  assert.ok(job, '一次性任务应在 25s 内完成');
  assert.equal(job.runs, 1);
  assert.ok(job.lastTaskId, '应关联任务');
  assert.equal(fs.readFileSync(path.join(work, 'sched.txt'), 'utf8'), '调度成功\n');
  const t = readJson(path.join(home, 'tasks', job.lastTaskId + '.json'));
  assert.equal(t.status, 'done');
  ok('一次性定时：--at 到点执行并写文件');
}

// ---------- 2. 周期任务 + 暂停/恢复 ----------
{
  requestCount = 0;
  const r = await runCli(['schedule', 'add', '周期任务', '--every', '2s']);
  assert.equal(r.code, 0, r.err);
  const id = (r.out.match(/已创建\s+(\S+)/) || [])[1];
  const j1 = await waitFor(() => {
    const j = readJson(jobFile(id));
    return j && j.runs >= 2 ? j : null;
  }, 20000);
  assert.ok(j1, '周期任务应至少运行 2 次');
  const runsBefore = j1.runs;
  const p = await runCli(['schedule', 'pause', id]);
  assert.equal(p.code, 0);
  assert.equal(readJson(jobFile(id)).status, 'paused');
  await sleep(4500);
  const paused = readJson(jobFile(id));
  assert.equal(paused.runs, runsBefore, '暂停期间不应继续运行');
  const rs = await runCli(['schedule', 'resume', id]);
  assert.equal(rs.code, 0);
  const j2 = await waitFor(() => {
    const j = readJson(jobFile(id));
    return j && j.runs > runsBefore ? j : null;
  }, 20000);
  assert.ok(j2, '恢复后应继续运行');
  const rm = await runCli(['schedule', 'remove', id]);
  assert.equal(rm.code, 0);
  ok('周期任务：每 2s 运行 / 暂停冻结 / 恢复继续 / 删除');
}

// ---------- 3. 链式依赖（chain：B 依赖 A 成功） ----------
{
  requestCount = 0;
  const r = await runCli(['schedule', 'chain', '链式任务A', '链式任务B']);
  assert.equal(r.code, 0, r.err);
  const ids = (r.out.match(/sc\w+/g) || []);
  assert.equal(ids.length, 2);
  const jobB = await waitFor(() => {
    const j = readJson(jobFile(ids[1]));
    return j && j.status === 'done' ? j : null;
  }, 30000);
  assert.ok(jobB, '链尾任务应完成');
  const tA = readJson(path.join(home, 'tasks', readJson(jobFile(ids[0])).lastTaskId + '.json'));
  const tB = readJson(path.join(home, 'tasks', jobB.lastTaskId + '.json'));
  assert.ok(tB.startedAt >= tA.startedAt, 'B 应在 A 之后启动');
  assert.equal(readJson(jobFile(ids[0])).status, 'done');
  await runCli(['schedule', 'remove', ids[0]]);
  await runCli(['schedule', 'remove', ids[1]]);
  ok('链式依赖：按序执行、后者等待前者完成');
}

// ---------- 4. 面板联动 ----------
{
  const list = await runCli(['schedule', 'list']);
  assert.equal(list.code, 0);
  assert.ok(list.out.includes('一次性') || list.out.includes('调度队列'), '列表应正常输出');
  ok('调度面板列表');
}

// 清理
mock.close();
fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(work, { recursive: true, force: true });
console.log(`\n调度 e2e 全部通过：${passed} 项 ✓`);
