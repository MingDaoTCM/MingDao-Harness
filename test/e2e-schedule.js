// 任务队列与调度 e2e：mock Provider + 真实 sleeper/worker 进程。
// 覆盖：一次性定时（--at）、周期（--every，s 单位）、链式依赖（chain）、暂停/恢复、任务面板联动。
// 运行：node test/e2e-schedule.js

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
    // 熔断测试标记：问题文本含 SCHEDFAIL 的任务一律 500（模拟持续性故障）
    if (JSON.stringify(parsed?.messages || []).includes('SCHEDFAIL')) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'mock 故障' } }));
      return;
    }
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
  assert.ok(Array.isArray(job.history) && job.history.length === 1, '应记录执行历史');
  assert.equal(job.history[0].taskId, job.lastTaskId);
  assert.equal(job.history[0].status, 'done');
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

// ---------- 5. 避峰调度（--offpeak）：任务携带避峰标记与说明 ----------
{
  const r = await runCli(['schedule', 'add', '避峰任务', '--every', '2s', '--offpeak']);
  assert.equal(r.code, 0, r.out);
  const m = r.out.match(/sc[0-9a-z]+/);
  assert.ok(m, '应返回调度 id');
  const job = readJson(jobFile(m[0]));
  assert.equal(job.offpeak, true, '任务应携带 offpeak 标记');
  assert.ok(String(job.note || '').includes('避峰'), '任务备注应说明避峰');
  await runCli(['schedule', 'remove', m[0]]);
  ok('避峰调度：--offpeak 标记 / 备注说明');
}

// ---------- 5.5 质检 H2：pause 失效确定性回归（postRunStatus 纯函数） ----------
{
  const { postRunStatus } = await import(pathToFileURL(path.join(root, 'src', 'schedule.js')).href + '?postrun-test');
  // 执行期间用户 pause → 状态保持 paused（绝不覆盖为 pending/failed）
  const paused = postRunStatus({ status: 'paused', consecutiveFailures: 0, anchor: null, interval: 1000 }, 'failed');
  assert.equal(paused, null, 'paused 状态不得被覆盖');
  // 文件已删（cur2=null）→ 无操作
  assert.equal(postRunStatus(null, 'done'), null, '已删除任务应无操作');
  // 失败 3 次熔断
  const fused = postRunStatus({ status: 'running', consecutiveFailures: 3, anchor: null, interval: 1000 }, 'failed');
  assert.equal(fused.status, 'failed', '连续失败应熔断');
  // 正常完成 → 排下一次
  const next = postRunStatus({ status: 'running', consecutiveFailures: 0, anchor: null, interval: 60000 }, 'done');
  assert.equal(next.status, 'pending', '完成应回 pending');
  assert.ok(next.nextRunAt > Date.now(), '应排下一次执行时间');
  // 锚点对齐
  const anchored = postRunStatus({ status: 'running', consecutiveFailures: 0, anchor: '09:00', interval: 86400000 }, 'done');
  assert.equal(anchored.status, 'pending', '锚点任务应回 pending');
  ok('质检 H2：pause 状态决策回归（postRunStatus 纯函数）');
}

// ---------- 6. 周期任务连续失败熔断（「失败：避峰任务」通知刷屏根因回归） ----------
{
  const r = await runCli(['schedule', 'add', '熔断任务 SCHEDFAIL', '--every', '2s']);
  assert.equal(r.code, 0, r.err);
  const id = (r.out.match(/已创建\s+(\S+)/) || [])[1];
  const j = await waitFor(() => {
    const jj = readJson(jobFile(id));
    return jj && jj.status === 'failed' ? jj : null;
  }, 30000);
  assert.ok(j, '连续失败后应熔断停止（status=failed）');
  assert.equal(j.runs, 3, '熔断前应恰好运行 3 次（第 3 次失败即停止）');
  assert.ok((j.consecutiveFailures || 0) >= 3, '应记录连续失败次数');
  assert.ok(String(j.note || '').includes('已停止'), '备注应说明已停止重试');
  await runCli(['schedule', 'remove', id]);
  ok('周期任务熔断：连续 3 次失败自动停止，不再无限重试/无限弹失败通知');
}

// 清理
mock.close();
safeRm(home, { recursive: true, force: true });
safeRm(work, { recursive: true, force: true });
console.log(`\n调度 e2e 全部通过：${passed} 项 ✓`);
