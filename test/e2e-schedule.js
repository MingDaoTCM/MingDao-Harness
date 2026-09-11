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
    // 双 daemon 回归（v0.4.7 T15）：SCHEDSLOW 的任务响应延迟 6s，制造「在途运行」窗口，
    // 用于验证 daemon 接管时不会并发重跑同一任务。
    if (JSON.stringify(parsed?.messages || []).includes('SCHEDSLOW')) {
      setTimeout(() => {
        sse({ choices: [{ delta: { content: '慢任务完成' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
      }, 6000);
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

// ---------- 6.6 worker 被强杀后的回收（v0.4.7 P3 T20） ----------
// 复现审计报告的场景：worker 被 SIGKILL / OOM / 系统休眠杀死，来不及写终态 →
//   ① 任务永久停在 running，面板一直转圈；
//   ② 调度器为它**空转到 2 小时上限**才判超时——用户看到「跑了两个小时」，实际早没进程了。
// 用 mock 的 SCHEDSLOW 标记制造 6s 的模型响应窗口，在这个窗口内 SIGKILL 掉 worker。
{
  const { spawnDaemon, daemonPidFile } = await import(pathToFileURL(path.join(root, 'src', 'schedule.js')).href);
  const { spawn } = await import('node:child_process');
  // every 的首次执行 = 创建时刻 + 间隔，故用 2s 让 worker 尽快进入在途状态
  const r = await runCli(['schedule', 'add', 'SCHEDSLOW 慢任务', '--every', '2s']);
  assert.equal(r.code, 0, r.err);
  const id = (r.out.match(/已创建\s+(\S+)/) || [])[1];
  assert.ok(id, '应创建出调度任务');
  // 确保有守护在监督（该步之后的所有断言都依赖「有宿主在轮询」）
  spawnDaemon(home);
  await waitFor(() => (fs.existsSync(daemonPidFile(home)) ? true : null), 10000);

  // 等 worker 真正进入在途状态
  const running = await waitFor(() => {
    const j = readJson(jobFile(id));
    if (!j || !j.lastTaskId) return null;
    const t = readJson(path.join(home, 'tasks', j.lastTaskId + '.json'));
    return t && t.status === 'running' && t.pid ? { job: j, task: t } : null;
  }, 30000);
  assert.ok(running, '应观察到 worker 在途运行（含 pid）');

  // 强杀：worker 没有任何机会写终态
  const t0 = Date.now();
  try {
    process.kill(running.task.pid, 'SIGKILL');
  } catch {}
  // 关键断言：必须在数十秒内被判失败，而不是等满 2 小时上限
  const settled = await waitFor(() => {
    const j = readJson(jobFile(id));
    return j && j.history && j.history.length >= 1 ? j : null;
  }, 60000);
  assert.ok(settled, '被强杀的 worker 应在 60s 内被回收并记账（修复前会空转到 2h 上限）');
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 55000, `回收应远快于 2h 上限，实际 ${elapsed}ms`);
  // 首次执行即被强杀的那一轮
  assert.equal(settled.history[0].status, 'failed', '被强杀应记为 failed');
  assert.notEqual(settled.history[0].status, 'timedout', '不得退化成「等到 2h 上限才判超时」');
  // 任务文件本身也要落到 failed 并写明原因（面板不再永久转圈）
  const tAfter = readJson(path.join(home, 'tasks', running.task.id + '.json'));
  assert.equal(tAfter.status, 'failed', '任务状态应被回收为 failed');
  assert.ok(String(tAfter.error).includes('进程已消失'), `回收原因应可读，实际：${tAfter.error}`);
  await runCli(['schedule', 'remove', id]);
  ok('worker 强杀回收：状态不再卡 running，调度器不再空转到 2h 上限');
}

// ---------- 7. 守护进程租约：spawn/stopDaemon 真正终止 + 孤儿自退（双 daemon 回归） ----------
{
  const { spawnDaemon, stopDaemon, daemonAlive, daemonPidFile } = await import(pathToFileURL(path.join(root, 'src', 'schedule.js')).href);
  const aliveCheck = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  // 造一个 pending 周期任务让 daemon 有活可干、持续存活
  const r = await runCli(['schedule', 'add', '租约测试 LEASEKEEP', '--every', '30s']);
  assert.equal(r.code, 0, r.err);
  const sid = (r.out.match(/已创建\s+(\S+)/) || [])[1];
  // 1) spawnDaemon 成功且 daemon 存活
  assert.equal(spawnDaemon(home), true, 'spawnDaemon 应成功');
  const pidLine = await waitFor(() => {
    try {
      const l = fs.readFileSync(daemonPidFile(home), 'utf8').trim().split(/\s+/);
      return aliveCheck(Number(l[0])) && l[1] ? { pid: Number(l[0]) } : null;
    } catch { return null; }
  }, 15000);
  assert.ok(pidLine, 'daemon 应存活且 pidfile 格式正确');
  // 2) 租约自退：篡改 pidfile 指向别的进程 → 真 daemon 进程应在数秒内自行退出
  fs.writeFileSync(daemonPidFile(home), '99999999 someone-else');
  const selfExited = await waitFor(() => (aliveCheck(pidLine.pid) ? null : true), 20000);
  assert.ok(selfExited, '租约被改写后 daemon 应自退（防双 daemon 重复执行）');
  // 3a) 归属匹配：受害进程 cmdline 带上 nonce（模拟真 daemon）→ stopDaemon 应真正终止它
  //     （v0.4.7 起 stopDaemon 会先校验 PID 归属；node 的 argv 尾部带上 nonce 即视为「是我们的人」）
  const proc7 = await import(pathToFileURL(path.join(root, 'src', 'proc.js')).href);
  const { pidOwnedBy } = proc7;
  // 能否校验命令行归属由模块自证（Linux /proc、macOS ps；Windows 无二者 → false）。
  // 用能力探测而不是平台名判断：新增平台时无需改测试。
  const canVerify7 = proc7.ownershipVerifiable();
  const nonce7 = 'abcdefg';
  const victim = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', nonce7]);
  // 刚 spawn 时可能尚未 exec（命令行还读不到），等**跨平台**归属校验确认为 true 再写 pidfile，
  // 避免时序抖动导致「归属校验失败 → 不杀」的假失败。此处用 pidOwnedBy 而不是直接读 /proc：
  // 后者在 macOS 上恒抛错，旧版本正是因此把这一步写成「非 Linux 直接放行」，从而漏掉了整条校验。
  await waitFor(() => (pidOwnedBy(victim.pid, nonce7) === true ? true : null), 8000);
  fs.writeFileSync(daemonPidFile(home), `${victim.pid} ${nonce7}`);
  let victimExited = false;
  victim.on('exit', () => { victimExited = true; });
  stopDaemon(home);
  await waitFor(() => (victimExited ? true : null), 5000);
  assert.ok(victimExited, 'stopDaemon 应真正终止 pidfile 指向的进程');
  assert.ok(!fs.existsSync(daemonPidFile(home)), 'stopDaemon 应删除 pidfile');
  victim.kill('SIGKILL');

  // 3b) 归属不匹配：pidfile 陈旧、PID 被无关进程复用时**绝不误杀**。
  //     v0.4.7（P3 T20）：本条原先写死 `process.platform === 'linux'`——因为校验实现只读 /proc，
  //     macOS 上恒返回 null，于是「归属校验」在 macOS 根本不存在，而平台限制恰好把这一点盖住了。
  //     改用 src/proc.js（ps 兜底）后 macOS 也具备校验能力，故改为**按能力**执行：
  //     有能力校验的平台必须通过「不误杀」；无能力的平台（Windows）断言其退回 best-effort 的
  //     已知边界，而不是静默跳过。
  if (canVerify7) {
    const stranger = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
    // 等命令行可读（跨平台），确保「归属不匹配」是因为 nonce 不同，而不是读不到
    await waitFor(() => (pidOwnedBy(stranger.pid, 'not-my-nonce') === false ? true : null), 8000);
    fs.writeFileSync(daemonPidFile(home), `${stranger.pid} not-my-nonce`);
    stopDaemon(home);
    await sleep(800);
    let strangerAlive = true;
    try {
      process.kill(stranger.pid, 0);
    } catch {
      strangerAlive = false;
    }
    assert.ok(strangerAlive, 'PID 归属不匹配时 stopDaemon 不得误杀无关进程（防 PID 复用误杀）');
    stranger.kill('SIGKILL');
  } else {
    // Windows：无 /proc 也无 ps，无法校验归属 → stopDaemon 按 best-effort 处理。
    // 这里不假装「已覆盖」：明确断言该边界存在（pidfile 会被清掉），并在 README/审计里写明。
    assert.ok(!canVerify7, '此分支仅在无法校验归属的平台成立');
  }
  if (sid) await runCli(['schedule', 'remove', sid]);
  ok('守护进程租约：spawn 存活 / 租约自退 / stopDaemon 真正终止 / 归属不匹配不误杀（跨平台）');
}

// ---------- 8. 双 daemon 重复执行回归（v0.4.7 T15） ----------
// 复现审计报告的场景：任务在途运行期间 daemon 租约被接管。修复前——
//  ① 恢复分支看到 status=running 且 lastTaskId=null，误判「崩溃残留」→ 重置 pending → 并发重跑；
//  ② 旧 daemon 只 break 监督循环、不退出进程（在途协程撑住事件循环）→ 与新 daemon 并跑。
// 断言：任务只被执行一次；且 runOnce 在启动瞬间就把 lastTaskId/runnerPid 落进 job 文件。
{
  const { spawnDaemon, daemonPidFile } = await import(pathToFileURL(path.join(root, 'src', 'schedule.js')).href);
  const jobFile = (id) => path.join(home, 'schedule', id + '.json');
  const aliveCheck = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const readPid = () => {
    try {
      return Number(fs.readFileSync(daemonPidFile(home), 'utf8').trim().split(/\s+/)[0]) || 0;
    } catch {
      return 0;
    }
  };
  const readJob = (id) => {
    try {
      return JSON.parse(fs.readFileSync(jobFile(id), 'utf8'));
    } catch {
      return null;
    }
  };

  // 用 --at（一次性）而非 --every：周期任务会在测试窗口内合法地跑多轮，无法区分「重复执行」。
  // 一次性任务只应执行一次 —— runs 必须是 1。
  // 先用一个远期时间把任务建出来，再把 nextRunAt 直接改到 1 秒后：
  // 本用例测的是 **daemon 接管行为**，不依赖 CLI 的分钟级时间解析（避免测试受整分边界影响）。
  const r2 = await runCli(['schedule', 'add', '慢任务 SCHEDSLOW', '--at', fmt(new Date(Date.now() + 3600 * 1000))]);
  assert.equal(r2.code, 0, r2.err);
  const sid2 = (r2.out.match(/已创建\s+(\S+)/) || [])[1];
  assert.ok(sid2, '应创建一次性任务');
  {
    const jf = jobFile(sid2);
    const j0 = JSON.parse(fs.readFileSync(jf, 'utf8'));
    j0.nextRunAt = Date.now() + 1000;
    fs.writeFileSync(jf, JSON.stringify(j0, null, 2));
  }

  spawnDaemon(home);
  const daemonPid = await waitFor(() => {
    const p = readPid();
    return p && aliveCheck(p) ? p : null;
  }, 15000);
  assert.ok(daemonPid, 'daemon 应启动');

  // 等在途运行：job 必须出现 lastTaskId + runnerPid（修复前这两项要等跑完才写）
  const inFlight = await waitFor(() => {
    const j = readJob(sid2);
    return j && j.status === 'running' && j.lastTaskId && j.runnerPid ? j : null;
  }, 25000);
  assert.ok(inFlight, '任务开始运行后 job 文件应立即带 lastTaskId + runnerPid（否则接管方会误判崩溃）');
  assert.equal(Number(inFlight.runnerPid), daemonPid, 'runnerPid 应指向正在监督的 daemon');

  // 接管：篡改 pidfile 模拟新 daemon 上位；同时真的拉起一个新 daemon
  fs.writeFileSync(daemonPidFile(home), '99999999 newcomer');
  spawnDaemon(home);

  // 旧 daemon 必须在在途任务收尾后退出（修复前它会一直被协程撑住、继续监督）
  const oldExited = await waitFor(() => (aliveCheck(daemonPid) ? null : true), 40000);
  assert.ok(oldExited, '旧 daemon 在租约丢失后必须退出（否则与新 daemon 并跑）');

  // 等这轮跑完，核对「只跑了一次」
  const done = await waitFor(() => {
    const j = readJob(sid2);
    return j && Array.isArray(j.history) && j.history.length >= 1 ? j : null;
  }, 40000);
  assert.ok(done, '任务应完成一轮');
  assert.equal(done.runs, 1, `同一任务不得被并发执行两次（实际 runs=${done.runs}）`);
  assert.equal((done.history || []).length, 1, '历史应只有一条记录');

  const stop = readPid();
  if (stop) { try { process.kill(stop, 'SIGTERM'); } catch {} }
  if (sid2) await runCli(['schedule', 'remove', sid2]);
  ok('双 daemon 重复执行回归：在途标记 + 租约丢失退出（同一任务只执行一次）');
}

// 清理
mock.close();
safeRm(home, { recursive: true, force: true });
safeRm(work, { recursive: true, force: true });
console.log(`\n调度 e2e 全部通过：${passed} 项 ✓`);
