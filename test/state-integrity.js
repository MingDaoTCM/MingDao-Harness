// 并发写 / 状态残留类缺陷的独立回归套件（v0.6.28，minimax 报告 M-10 / M-11 / M-12 / M-17 / L-13）。
//
// 这批缺陷的共同形态：**状态的生命周期写错了**——
//   · M-10 `emptyRounds` 只增不减："连续 3 轮空输出"的护栏实际按"回合内累计 3 次"执行；
//   · L-13 `finish` 是函数级变量、每步 `?? finish`：上一轮的 length 残留到正常轮 → 误判 capped/truncated；
//   · M-17 检查点有「无锁整份写」与「加锁合并写」两条路：裸写可插进 merge 的读-改-写中间；
//   · M-11 会话索引分片整片「读-改-写」无锁：并发同步时后写者用陈旧快照覆盖前者刚写的条目；
//   · M-12 AGENTS.md 去重/删除整份「读-改-写」无锁：与自动记忆追加并发时把新条目静默抹掉。
//
// 运行：node test/state-integrity.js（不依赖网络；并发场景用真子进程，不用"同进程顺序调用"假装并发）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
const baseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-state-integrity-'));
process.env.MINGDAO_HOME = baseHome;

const { createAgent } = await import(pathToFileURL(path.join(srcDir, 'agent.js')).href);
const { createIO } = await import(pathToFileURL(path.join(srcDir, 'ui.js')).href);
const TS = await import(pathToFileURL(path.join(srcDir, 'task-state.js')).href);
const SI = await import(pathToFileURL(path.join(srcDir, 'session-index.js')).href);
const MEM = await import(pathToFileURL(path.join(srcDir, 'memory.js')).href);

const agentUrl = JSON.stringify(pathToFileURL(path.join(srcDir, 'agent.js')).href);
const atomicUrl = JSON.stringify(pathToFileURL(path.join(srcDir, 'atomic-write.js')).href);
const indexUrl = JSON.stringify(pathToFileURL(path.join(srcDir, 'session-index.js')).href);
const memoryUrl = JSON.stringify(pathToFileURL(path.join(srcDir, 'memory.js')).href);
const taskStateUrl = JSON.stringify(pathToFileURL(path.join(srcDir, 'task-state.js')).href);

let passed = 0;
const ok = (/** @type {string} */ name) => {
  passed += 1;
  console.log(`  ✓ ${name}`);
};

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/** Windows 上子进程句柄/杀软扫描可能让 rmSync 瞬时 EBUSY：重试几次，最终失败也不影响断言。 */
function safeRm(/** @type {string} */ p) {
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
    }
  }
}

/** 造一个 agent：静默 io、无账本/审计（只测循环状态，不碰无关写盘）。 */
function makeAgent(/** @type {any} */ provider, /** @type {any} */ cfg = {}, maxSteps = 10) {
  return createAgent({
    provider,
    permission: { async check() { return true; } },
    io: createIO({ quiet: true }),
    modelName: 'deepseek-v4-flash',
    workingDir: baseHome,
    cfg: { permission: 'auto', autoCompact: false, ledger: false, audit: false, ...cfg },
    maxSteps,
  });
}

/** 子进程封装：READY 屏障 → 父进程发令（GO）→ 同时开跑，不靠进程启动先后碰运气。 */
function startChild(/** @type {string} */ body) {
  const p = spawn(process.execPath, ['--input-type=module', '-e', body], { stdio: ['pipe', 'pipe', 'pipe'] });
  p.stdin.on('error', () => {});
  p.stdout.setEncoding('utf8');
  p.stderr.setEncoding('utf8');
  let out = '';
  let err = '';
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  p.stdout.on('data', (/** @type {string} */ c) => {
    out += c;
    if (out.includes('READY\n')) readyResolve();
  });
  p.stderr.on('data', (/** @type {string} */ c) => (err += c));
  const done = new Promise((resolve) => p.on('close', (code, signal) => resolve({ code, signal, out, err })));
  const timer = setTimeout(() => readyReject(new Error(`子进程 READY 超时\n${err}`)), 20000);
  timer.unref();
  return {
    p,
    ready: ready.then(() => clearTimeout(timer)),
    done,
    go() {
      try {
        p.stdin.write('GO\n');
      } catch {}
    },
    out: () => out,
  };
}

/** 在 deadline 内等 done（子进程卡住比失败更贵，Windows 腿能挂满超时）。 */
function withDeadline(/** @type {Promise<any>} */ pr, /** @type {string} */ what, ms = 30000) {
  return Promise.race([
    pr,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} 超时（${ms}ms）`)), ms).unref()),
  ]);
}

// ===========================================================================
// ① M-10：emptyRounds 必须是「连续」计数
// ===========================================================================
{
  // 1a. 连续空轮 → 恰好第 3 次中止（不是 4，也不是永不停止）
  let calls = 0;
  const alwaysEmpty = {
    async chat() {
      calls += 1;
      return { text: '', toolCalls: null, usage: { prompt_tokens: 1, completion_tokens: 1 }, finish: 'stop' };
    },
  };
  const r = await makeAgent(alwaysEmpty, { maxEmptyRounds: 3, maxRounds: 1 }, 10).runTurn([
    { role: 'system', content: '系统' },
    { role: 'user', content: '把任务做完' },
  ]);
  assert.equal(calls, 3, `连续 3 轮空输出必须在中止（不得累计到 4+ 也不得无限续写），实际 ${calls} 次`);
  assert.equal(r.text, null, '空轮中止不应产出正文');
  assert.ok(String(r.note || '').includes('没有输出正文'), `中止时必须如实说明原因，实际 note=${JSON.stringify(r.note)}`);
  ok('M-10a：连续 3 轮空输出 → 第 3 次中止（阈值不是累计）');
}
{
  // 1b. 空 → 有进展（工具成功且不重复）→ 空 → 空：**不得**中止（第 2 段只有 2 连空）
  fs.writeFileSync(path.join(baseHome, 'probe-10b.txt'), 'hello\n');
  let calls = 0;
  const provider = {
    async chat() {
      calls += 1;
      if (calls === 1) return { text: '', toolCalls: null, usage: {}, finish: 'stop' };
      if (calls === 2)
        return {
          text: '',
          toolCalls: [{ id: 'c10b', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'probe-10b.txt' }) } }],
          usage: {},
          finish: 'tool_calls',
        };
      if (calls === 3) return { text: '', toolCalls: null, usage: {}, finish: 'stop' };
      if (calls === 4) return { text: '', toolCalls: null, usage: {}, finish: 'stop' };
      return { text: '完成', toolCalls: null, usage: {}, finish: 'stop' };
    },
  };
  const r = await makeAgent(provider, { maxEmptyRounds: 3, maxRounds: 1 }, 10).runTurn([
    { role: 'system', content: '系统' },
    { role: 'user', content: '读取 probe-10b.txt 然后完成任务' },
  ]);
  assert.equal(calls, 5, `空-有进展-空-空 不应触发中止（应继续到第 5 次拿到正文），实际 ${calls} 次`);
  assert.equal(r.text, '完成', '有进展复位后，后续正常回答必须被采纳');
  assert.equal(r.truncated, false, '本例不应被判截断');
  ok('M-10b：空-有进展-空-空 → 不中止（工具进展复位计数）');
}
{
  // 1c. 空 → 有内容但工具失败 → 空 → 空 → 正文：内容复位（工具失败不算进展，不能靠它复位）
  let calls = 0;
  const provider = {
    async chat() {
      calls += 1;
      if (calls === 1) return { text: '', toolCalls: null, usage: {}, finish: 'stop' };
      if (calls === 2)
        return {
          text: '我继续检查一下。',
          toolCalls: [{ id: 'c10c', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'no-such-file-10c.txt' }) } }],
          usage: {},
          finish: 'tool_calls',
        };
      if (calls === 3) return { text: '', toolCalls: null, usage: {}, finish: 'stop' };
      if (calls === 4) return { text: '', toolCalls: null, usage: {}, finish: 'stop' };
      return { text: '完成', toolCalls: null, usage: {}, finish: 'stop' };
    },
  };
  const r = await makeAgent(provider, { maxEmptyRounds: 3, maxRounds: 1 }, 10).runTurn([
    { role: 'system', content: '系统' },
    { role: 'user', content: '把任务做完' },
  ]);
  assert.equal(calls, 5, `有内容的模型轮必须复位空轮计数（失败工具不算进展），实际 ${calls} 次`);
  assert.equal(r.text, '完成', '内容复位后应能正常收尾');
  ok('M-10c：有内容的模型轮复位计数（工具失败不冒充进展）');
}
{
  // 1d. 阈值边界：maxEmptyRounds=2 → 第 2 次就中止；maxEmptyRounds=4 → 3 连空仍继续
  let calls2 = 0;
  const empty2 = {
    async chat() {
      calls2 += 1;
      return { text: '', toolCalls: null, usage: {}, finish: 'stop' };
    },
  };
  const r2 = await makeAgent(empty2, { maxEmptyRounds: 2, maxRounds: 1 }, 10).runTurn([
    { role: 'system', content: '系统' },
    { role: 'user', content: '把任务做完' },
  ]);
  assert.equal(calls2, 2, `maxEmptyRounds=2 时应在第 2 次中止，实际 ${calls2} 次`);
  assert.equal(r2.text, null);

  let calls4 = 0;
  const provider4 = {
    async chat() {
      calls4 += 1;
      if (calls4 <= 3) return { text: '', toolCalls: null, usage: {}, finish: 'stop' };
      return { text: '完成', toolCalls: null, usage: {}, finish: 'stop' };
    },
  };
  const r4 = await makeAgent(provider4, { maxEmptyRounds: 4, maxRounds: 1 }, 10).runTurn([
    { role: 'system', content: '系统' },
    { role: 'user', content: '把任务做完' },
  ]);
  assert.equal(calls4, 4, `maxEmptyRounds=4 时 3 连空不得中止，实际 ${calls4} 次`);
  assert.equal(r4.text, '完成');
  ok('M-10d：阈值边界（2→第 2 次止 / 4→3 连空仍继续）');
}

// ===========================================================================
// ② L-13：finish 只由本轮写入（上轮 length 不得污染正常轮）
// ===========================================================================
{
  let calls = 0;
  const provider = {
    async chat() {
      calls += 1;
      if (calls === 1) {
        // 上一轮：被长度上限截断（正文非空，走续写分支而不是收尾）
        return { text: '半截正文', toolCalls: null, usage: { prompt_tokens: 2, completion_tokens: 2 }, finish: 'length' };
      }
      // 下一轮：正常纯文本，且**上游没给 finish_reason**（真实网关常见形态）
      return { text: '正常完成', toolCalls: null, usage: { prompt_tokens: 3, completion_tokens: 3 } };
    },
  };
  const r = await makeAgent(provider, { maxRounds: 1 }, 10).runTurn([
    { role: 'system', content: '系统' },
    { role: 'user', content: '写一段说明' },
  ]);
  assert.equal(calls, 2, '应为「截断续写 → 正常回答」两次调用');
  assert.equal(r.text, '正常完成', '正常轮的正文必须原样返回');
  assert.equal(r.truncated, false, `上一轮 finish='length' 不得残留到正常轮（truncated 必须 false），实际 ${r.truncated}`);
  assert.ok(!r.capHit, '正常收尾不得被判 capHit/capped');
  assert.notEqual(r.finish, 'length', `返回的 finish 不得是上一轮的 length，实际 ${JSON.stringify(r.finish)}`);
  ok('L-13：上轮 capped/length → 下轮正常，终态不得被误判 truncated/capped');
}

// ===========================================================================
// ③ M-17：saveTaskState（无锁）必须与 saveTaskStateMerge 走同一把锁
// ===========================================================================
{
  // 3a. 串行化证据：别进程持锁期间，裸写 saveTaskState 必须**等待**而不是插进临界区
  const session = 'm17a';
  const file = TS.taskStateFile(session);
  const lock = file + '.lock';
  const holder = startChild(`
import fs from 'node:fs';
const AW = await import(${atomicUrl});
AW.withFileLockSync(${JSON.stringify(lock)}, () => {
  fs.writeSync(1, 'READY\\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
});
`);
  await withDeadline(holder.ready, 'M-17 持锁子进程就绪');
  const t0 = Date.now();
  const rSave = TS.saveTaskState(session, { goal: 'g17', progress: 'p', artifacts: ['plain'], status: 'interrupted', updatedAt: 1 });
  const waited = Date.now() - t0;
  const hRes = await withDeadline(holder.done, 'M-17 持锁子进程退出');
  assert.equal(hRes.code, 0, `持锁子进程应正常退出：${hRes.err}`);
  assert.deepEqual(rSave, { ok: true, error: null }, `等待锁后应成功写入：${JSON.stringify(rSave)}`);
  assert.ok(waited >= 300, `saveTaskState 必须真的等过持锁者（否则它没走同一把锁），实际 ${waited}ms`);
  assert.ok(!fs.existsSync(lock), '写入结束后锁文件必须被释放');
  ok('M-17a：裸写 saveTaskState 与 merge 共用锁（持锁期间必须等待，实测 ' + waited + 'ms）');
}
{
  // 3a'. v0.6.30（审计：变异 ⑧ 时序逃逸）：**确定性**证明 merge 也走同一把锁——
  //      别进程持锁 500ms，期间 saveTaskStateMerge 必须等到锁释放才完成（≥300ms）。
  //      8 路并发（3b）依赖真实交错，某些机器上会自然串行 → 变异偶发逃逸；
  //      这条不依赖交错，撤销锁（变异 ⑧）必然立刻返回 → 确定性红。
  const session = 'm17c';
  const file = TS.taskStateFile(session);
  const lock = file + '.lock';
  const holder = startChild(`
import fs from 'node:fs';
const AW = await import(${atomicUrl});
AW.withFileLockSync(${JSON.stringify(lock)}, () => {
  fs.writeSync(1, 'READY\\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  fs.writeSync(1, 'DONE\\n');
});
`);
  await withDeadline(holder.ready, 'M-17c 持锁子进程就绪');
  const t0 = Date.now();
  const rMerge = TS.saveTaskStateMerge(session, { artifacts: ['merged-under-lock'], status: 'interrupted', updatedAt: 2 });
  const waited = Date.now() - t0;
  await withDeadline(holder.done, 'M-17c 持锁子进程退出');
  assert.deepEqual(rMerge, { ok: true, error: null }, `merge 应成功：${JSON.stringify(rMerge)}`);
  assert.ok(waited >= 300, `saveTaskStateMerge 必须等过持锁者（否则它绕过了锁），实际 ${waited}ms`);
  const arts = TS.loadTaskState(session)?.artifacts || [];
  assert.ok(arts.includes('merged-under-lock'), `merge 结果必须落盘：${JSON.stringify(arts)}`);
  ok('M-17c：merge 遇外部持锁必须串行（确定性，实测 ' + waited + 'ms）');
}
{
  // 3b. 并发合并：8 个子进程各 merge 一条 artifact，终态必须是 8+seed 的并集（不丢更新）
  const session = 'm17b';
  TS.saveTaskState(session, { goal: 'g17b', progress: 'p', artifacts: ['seed'], status: 'interrupted', updatedAt: 1 });
  const N = 8;
  const kids = [];
  for (let i = 0; i < N; i++) {
    const mine = `/tmp/m17b-${i}`;
    kids.push(
      startChild(`
import fs from 'node:fs';
process.env.MINGDAO_HOME = ${JSON.stringify(baseHome)};
const TS = await import(${taskStateUrl});
const readline = await import('node:readline');
const rl = readline.createInterface({ input: process.stdin });
fs.writeSync(1, 'READY\\n');
await new Promise((resolve) => rl.once('line', resolve));
rl.close();
const r = TS.saveTaskStateMerge(${JSON.stringify(session)}, { artifacts: [${JSON.stringify(mine)}], status: 'interrupted', updatedAt: Date.now() });
fs.writeSync(1, JSON.stringify({ ok: !!(r && r.ok), error: (r && r.error) || null, mine: ${JSON.stringify(mine)} }) + '\\n');
`)
    );
  }
  await withDeadline(Promise.all(kids.map((k) => k.ready)), 'M-17 并发子进程就绪');
  kids.forEach((k) => k.go());
  const dones = await withDeadline(Promise.all(kids.map((k) => k.done)), 'M-17 并发合并');
  const results = dones.map((d, i) => {
    assert.equal(d.code, 0, `子进程 ${i} 退出码非 0：${d.err}`);
    const line = d.out.split('\n').find((l) => l.trim().startsWith('{'));
    assert.ok(line, `子进程 ${i} 未交回结果：${d.out}${d.err}`);
    return JSON.parse(line);
  });
  for (const r of results) assert.equal(r.ok, true, `并发合并必须成功：${JSON.stringify(r)}`);
  const st = TS.loadTaskState(session);
  const arts = Array.isArray(st?.artifacts) ? st.artifacts : [];
  assert.equal(arts.length, N + 1, `并发合并不得丢更新（应 ${N + 1} 条，实际 ${arts.length}：${JSON.stringify(arts)}）`);
  for (const r of results) assert.ok(arts.includes(r.mine), `合并结果必须含 ${r.mine}：${JSON.stringify(arts)}`);
  ok(`M-17b：并发 saveTaskStateMerge ${N} 路 → artifacts 并集完整（${N + 1} 条）`);
}

// ===========================================================================
// ④ M-11：会话索引分片并发写不得丢条目
// ===========================================================================
{
  const idxHome = path.join(baseHome, 'sidx');
  const sessionsDir = path.join(idxHome, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const N = 60; // 每侧 60 个会话；同一分片
  const target = SI.shardOf('m11-seed.jsonl');
  const names = [];
  for (let i = 0; names.length < N * 2; i++) {
    const n = `m11-${i}.jsonl`;
    if (SI.shardOf(n) === target) names.push(n);
  }
  for (const n of names) {
    fs.writeFileSync(
      path.join(sessionsDir, n),
      JSON.stringify({ role: 'user', content: `并发索引夹具 ${n} ` + '内容'.repeat(1500) }) + '\n'
    );
  }
  const groups = [names.slice(0, N), names.slice(N)];
  const kids = groups.map(
    (group) => startChild(`
import fs from 'node:fs';
import path from 'node:path';
process.env.MINGDAO_HOME = ${JSON.stringify(idxHome)};
const SI = await import(${indexUrl});
const readline = await import('node:readline');
const sessions = ${JSON.stringify(group)}.map((name) => ({ name, file: path.join(${JSON.stringify(sessionsDir)}, name) }));
const rl = readline.createInterface({ input: process.stdin });
fs.writeSync(1, 'READY\\n');
await new Promise((resolve) => rl.once('line', resolve));
rl.close();
const out = SI.syncSessionIndex(${JSON.stringify(idxHome)}, sessions);
fs.writeSync(1, JSON.stringify({ own: Object.keys(out.files).length, names: ${JSON.stringify(group)} }) + '\\n');
`)
  );
  await withDeadline(Promise.all(kids.map((k) => k.ready)), 'M-11 并发子进程就绪');
  kids.forEach((k) => k.go());
  const dones = await withDeadline(Promise.all(kids.map((k) => k.done)), 'M-11 并发索引写');
  for (const d of dones) assert.equal(d.code, 0, `索引子进程退出码非 0：${d.err}`);
  const shardFile = path.join(idxHome, 'sessions-index', `${target}.json`);
  assert.ok(fs.existsSync(shardFile), '分片索引文件应存在');
  const idx = JSON.parse(fs.readFileSync(shardFile, 'utf8'));
  const stored = Object.keys(idx.files || {});
  assert.equal(stored.length, names.length, `并发写同一分片不得丢条目（应 ${names.length}，实际 ${stored.length}）`);
  for (const n of names) assert.ok(stored.includes(n), `分片索引必须含 ${n}`);
  safeRm(idxHome);
  ok(`M-11：并发写同一分片 → 条目 ${names.length}/${names.length} 全保留`);
}

// ===========================================================================
// ⑤a M-12（确定性判据，v0.6.38）：**外部持锁时去重必须等待**
//
// 为什么要有它：⑤ 的并发用例靠"同一刻放行"制造交错，在快机器上**可能不复现**——
// 0.6.37 的 macOS CI 就出现过 `batch60 ⑩`（去掉去重锁）exit=0 的 flaky 逃逸。
// 这里换一个**不靠运气**的判据：让子进程先持有记忆文件的锁，再调 dedupeMemory；
//   · 正常实现：必须等锁释放（实测 ≥ 持锁时长的一半）；
//   · 无锁变异：立刻返回（个位数毫秒）→ 当场红。
// 复现性由"持锁 600ms、断言等待 ≥250ms"保证，与机器快慢无关。
// ===========================================================================
{
  const memHome = path.join(baseHome, 'memhome-lock');
  fs.mkdirSync(memHome, { recursive: true });
  const prevHome = process.env.MINGDAO_HOME;
  process.env.MINGDAO_HOME = memHome;
  fs.writeFileSync(MEM.memoryFile(), '- [2026-01-01] 锁等待用例\n');
  const lockPath = MEM.memoryFile() + '.lock';
  // 子进程**先持锁再报 READY**——否则父进程可能在它拿到锁之前就开始计时（那正是要避免的运气）。
  const holder = startChild(`
import fs from 'node:fs';
import { withFileLockSync } from ${atomicUrl};
withFileLockSync(${JSON.stringify(lockPath)}, () => {
  fs.writeSync(1, 'READY\\n');          // 此刻锁已在自己手里
  const t0 = Date.now();
  while (Date.now() - t0 < 600) {}       // 纯忙等：不依赖 sleep 精度，确保真的持锁 600ms
});
`);
  await withDeadline(holder.ready, '⑤a 持锁子进程就绪（锁已在子进程手里）');
  const t0 = Date.now();
  const removed = MEM.dedupeMemory();
  const waited = Date.now() - t0;
  await withDeadline(holder.done, '⑤a 持锁子进程结束');
  assert.ok(
    waited >= 250,
    `外部持锁时 dedupeMemory 必须等待（实际 ${waited}ms）——无锁的变异会立刻返回`
  );
  assert.equal(removed, 0, '只有一条记忆时不应删掉任何内容');
  process.env.MINGDAO_HOME = prevHome;
  safeRm(memHome);
  ok(`M-12（确定性）：外部持锁 600ms → 去重等待 ${waited}ms（不靠并发运气）`);
}

// ===========================================================================
// ⑤ M-12：AGENTS.md 自动追加与去重并发不得丢条目
// ===========================================================================
{
  const memHome = path.join(baseHome, 'memhome');
  fs.mkdirSync(memHome, { recursive: true });
  process.env.MINGDAO_HOME = memHome;
  const unique = 30000;
  const dup = 10000;
  const seed = [];
  for (let i = 0; i < unique; i++) seed.push(`- [2026-01-01] seed-entry-${i}`);
  for (let i = 0; i < dup; i++) seed.push(`- [2026-01-01] seed-entry-${i}`); // 重复项：保证 dedupe 真的会整份重写
  fs.writeFileSync(MEM.memoryFile(), seed.join('\n') + '\n');

  const deduper = startChild(`
import fs from 'node:fs';
process.env.MINGDAO_HOME = ${JSON.stringify(memHome)};
const MEM = await import(${memoryUrl});
const readline = await import('node:readline');
const rl = readline.createInterface({ input: process.stdin });
fs.writeSync(1, 'READY\\n');
await new Promise((resolve) => rl.once('line', resolve));
rl.close();
const removed = MEM.dedupeMemory();
fs.writeSync(1, JSON.stringify({ removed }) + '\\n');
`);
  const APPENDERS = 4;
  const PER_CALL = 25;
  const CALLS = 10;
  const appenders = Array.from({ length: APPENDERS }, (_, id) =>
    startChild(`
import fs from 'node:fs';
process.env.MINGDAO_HOME = ${JSON.stringify(memHome)};
const MEM = await import(${memoryUrl});
const readline = await import('node:readline');
const rl = readline.createInterface({ input: process.stdin });
fs.writeSync(1, 'READY\\n');
await new Promise((resolve) => rl.once('line', resolve));
rl.close();
let added = 0;
const lines = [];
for (let k = 0; k < ${CALLS}; k++) {
  const batch = [];
  for (let j = 0; j < ${PER_CALL}; j++) batch.push('auto-mem-${id}-' + k + '-' + j);
  added += MEM.appendMemory(batch);
  lines.push(...batch);
}
fs.writeSync(1, JSON.stringify({ added, lines }) + '\\n');
`)
  );
  const all = [deduper, ...appenders];
  await withDeadline(Promise.all(all.map((k) => k.ready)), 'M-12 并发子进程就绪');
  all.forEach((k) => k.go()); // 同一刻放行：去重与追加必然重叠
  const dones = await withDeadline(Promise.all(all.map((k) => k.done)), 'M-12 追加/去重并发');
  for (const d of dones) assert.equal(d.code, 0, `记忆子进程退出码非 0：${d.err}`);

  const parse = (/** @type {any} */ d) => {
    const line = d.out.split('\n').find((l) => l.trim().startsWith('{'));
    assert.ok(line, `子进程未交回结果：${d.out}${d.err}`);
    return JSON.parse(line);
  };
  const dres = parse(dones[0]);
  assert.equal(dres.removed, dup, `去重应合并 ${dup} 条重复记忆，实际 ${dres.removed}`);
  const appended = dones.slice(1).map(parse);
  for (const r of appended) assert.equal(r.added, PER_CALL * CALLS, `每路追加条数应完整，实际 ${r.added}`);
  const expectLines = unique + APPENDERS * PER_CALL * CALLS;
  const lines = fs.readFileSync(MEM.memoryFile(), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, expectLines, `并发追加 + 去重不得丢条目（应 ${expectLines}，实际 ${lines.length}）`);
  for (const r of appended) {
    for (const l of r.lines) {
      assert.ok(
        lines.some((x) => x.includes(l)),
        `追加的条目 ${l} 不得被去重的整份写抹掉`
      );
    }
  }
  const uniq = new Set(lines);
  assert.equal(uniq.size, lines.length, '去重后不应再有重复行');
  delete process.env.MINGDAO_HOME;
  process.env.MINGDAO_HOME = baseHome;
  safeRm(memHome);
  ok(`M-12：追加 ${APPENDERS} 路 × ${PER_CALL * CALLS} 条 + 去重并发 → ${expectLines} 条（零丢失）`);
}

console.log(`\nstate-integrity：${passed} 项通过`);
process.exit(0);
