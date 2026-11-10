// 回合结局与工具成败判定回归（v0.7.1 正确性止血，审计报告1 S-1/S-2/H-2 + 报告A H-1）。
//
// 覆盖四类「结局/成败口径分裂」缺陷：
//   ① runTool 渲染/去重键在 try 外抛错 → Promise 拒绝；Promise.all 下其余并行工具结果被丢弃；
//   ② Promise.all 非 allSettled —— 一个兄弟工具拒绝，整体拒绝；
//   ③ 截断续写（finish==='length' 且空轮超限）只 finishTurn 不 markOutcome → 账本记 done/truncated=false；
//   ④ 异常出口只 flush+finishTurn+throw 不 markOutcome('error') → 崩溃回合被账本记「正常完成」；
//   ⑤ toolOk 用 `!result.includes('"ok": false')` —— 正文出现该串即误判失败，应改用顶层 ok 解析。
//
// 判定口径：账本 run.end 的 status/truncated/capHit/aborted 必须与返回值**同一个来源**（outcome）；
// tool.end 事件与并行批次的结果回填必须「等量、同序、不丢兄弟」。行为不可区分处（allSettled /
// 渲染在 try 内 / 顶层解析）用**结构守卫**钉死（与 smoke §127 同款文本绊线）。
//
// 运行：node test/turn-outcome.js（不依赖网络）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
const baseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-turn-outcome-'));
process.env.MINGDAO_HOME = baseHome;

const { createAgent } = await import(pathToFileURL(path.join(srcDir, 'agent.js')).href);
const { createIO } = await import(pathToFileURL(path.join(srcDir, 'ui.js')).href);
const { createSession } = await import(pathToFileURL(path.join(srcDir, 'session.js')).href);
const { readRun } = await import(pathToFileURL(path.join(srcDir, 'ledger.js')).href);
const { readEvents, eventFileFor } = await import(pathToFileURL(path.join(srcDir, 'session-events.js')).href);
const { registerTool } = await import(pathToFileURL(path.join(srcDir, 'tools', 'index.js')).href);

let passed = 0;
function ok(/** @type {string} */ name) {
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** 每个场景独立 home，避免账本/事件/会话文件跨场景串。 */
function freshHome(/** @type {string} */ name) {
  const dir = path.join(baseHome, name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  process.env.MINGDAO_HOME = dir;
  return dir;
}

/** 读**最近一次**回合账本（同一 home 下会有多份 run，按 mtime 取最新）。 */
function lastRunEvents(/** @type {string} */ home) {
  const dir = path.join(home, 'ledger');
  let files = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.jsonl'))
      .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
  } catch {
    return [];
  }
  if (!files.length) return [];
  return readRun(files[0].n.replace(/\.jsonl$/, ''));
}

// ===========================================================================
// ① runTool：渲染抛错不丢兄弟结果，抛错工具被记录为失败（不整体拒绝）
// ===========================================================================
{
  const home = freshHome('render-throw');
  fs.writeFileSync(path.join(home, 'a.txt'), 'A');
  fs.writeFileSync(path.join(home, 'b.txt'), 'B');
  fs.writeFileSync(path.join(home, 'c.txt'), 'C');
  const io = createIO({ quiet: true });
  io.renderToolStart = (/** @type {any} */ name, /** @type {any} */ args) => {
    if (args?.path === 'b.txt') throw new Error('render boom');
  };
  let t = 0;
  const fake = {
    async chat() {
      t += 1;
      if (t === 1) {
        return {
          text: '',
          toolCalls: ['a.txt', 'b.txt', 'c.txt'].map((f, k) => ({
            id: 'c' + k,
            type: 'function',
            function: { name: 'read', arguments: JSON.stringify({ path: f }) },
          })),
          usage: {},
          finish: 'tool_calls',
        };
      }
      return { text: '并行完成', toolCalls: null, usage: {}, finish: 'stop' };
    },
  };
  const agent = createAgent({
    provider: fake,
    permission: { mode: 'auto', async check() { return true; } },
    io,
    modelName: 'deepseek-v4-flash',
    workingDir: home,
    cfg: { permission: 'auto', maxRounds: 1 },
  });
  const messages = [{ role: 'system', content: '系统' }, { role: 'user', content: '读三个文件' }];
  const r = await agent.runTurn(messages);
  assert.equal(r.text, '并行完成', '渲染抛错不得让整回合拒绝');
  const toolMsgs = messages.filter((/** @type {any} */ m) => m.role === 'tool');
  assert.equal(toolMsgs.length, 3, '3 个工具调用必须回填 3 条 tool 消息');
  assert.ok(String(toolMsgs[0].content).includes('A'), '兄弟 a.txt 结果不得被丢弃');
  assert.ok(String(toolMsgs[1].content).includes('render boom'), 'b.txt 的渲染错误必须被记录');
  assert.ok(String(toolMsgs[2].content).includes('C'), '兄弟 c.txt 结果不得被丢弃');
  ok('runTool：渲染抛错不丢兄弟结果 + 抛错工具被记录为失败');
}

// ===========================================================================
// ②–④ 结构守卫：allSettled / 渲染与去重键在 try 内 / toolOk 顶层解析
// ===========================================================================
{
  const agentSrc = fs.readFileSync(path.join(srcDir, 'agent.js'), 'utf8');

  // v0.7.1：allSettled 抽成模块级 runToolBatch helper 后，正文只剩 1 处 Promise.allSettled，
  // 但两处并行批都必须调用 helper——所以同时钉「helper 内用 allSettled」与「两处调用 helper」。
  const allSettledCount = (agentSrc.match(/Promise\.allSettled\(/g) || []).length;
  const runToolBatchCalls = (agentSrc.match(/runToolBatch\(/g) || []).length;
  assert.ok(allSettledCount >= 1, `并行批次必须用 Promise.allSettled（退回 all 会整体丢弃兄弟结果），实际 ${allSettledCount} 处`);
  assert.ok(runToolBatchCalls >= 2, `两处并行批次（纯只读 + 前导子批）都必须调用 runToolBatch helper，实际 ${runToolBatchCalls} 处`);
  ok('结构守卫：并行批次使用 Promise.allSettled（经 runToolBatch helper）');

  // 用带括号的形式避免前缀匹配到 `runToolBatch`（否则 try 会去 helper 里找，守卫失效）。
  const runToolSrc = agentSrc.slice(agentSrc.indexOf('async function runTool('), agentSrc.indexOf('async function finishTool('));
  const tryAt = runToolSrc.indexOf('try {');
  assert.ok(tryAt !== -1 && tryAt < runToolSrc.indexOf('io.renderToolStart'), 'io.renderToolStart 必须在 try 内（渲染抛错才不拒绝整批）');
  ok('结构守卫：io.renderToolStart 在 try 内');

  assert.ok(runToolSrc.indexOf('usedToolNames.add') > tryAt && runToolSrc.indexOf('JSON.stringify(prep.args') > tryAt, '去重键（usedToolNames.add / JSON.stringify(prep.args)）必须在 try 内');
  ok('结构守卫：去重键在 try 内');

  const toolOkBlock = agentSrc.slice(agentSrc.indexOf('let toolOk = true'), agentSrc.indexOf('if (toolOk && repeatedBefore === 0)'));
  assert.ok(toolOkBlock.includes('JSON.parse(result)'), 'toolOk 必须用顶层 ok 解析（JSON.parse），不得退回字符串包含');
  ok('结构守卫：toolOk 用顶层 ok 解析');
}

// ===========================================================================
// ⑤ toolOk 行为：对象结果 ok:false / ok:true 都如实写入 tool.end 事件
// ===========================================================================
{
  const home = freshHome('toolok-behavior');
  const s = createSession(home);
  const io = createIO({ quiet: true });
  let t = 0;
  const fake = {
    async chat() {
      t += 1;
      if (t === 1) {
        return {
          text: '',
          toolCalls: [
            { id: 'tb', type: 'function', function: { name: 'outcome_bad', arguments: '{}' } },
            { id: 'tg', type: 'function', function: { name: 'outcome_good', arguments: '{}' } },
          ],
          usage: {},
          finish: 'tool_calls',
        };
      }
      return { text: 'ok', toolCalls: null, usage: {}, finish: 'stop' };
    },
  };
  registerTool({ name: 'outcome_bad', description: '返回 ok:false', run: async () => ({ ok: false, error: 'bad tool' }) });
  registerTool({ name: 'outcome_good', description: '返回 ok:true', run: async () => ({ ok: true, output: 'good tool' }) });
  const agent = createAgent({
    provider: fake,
    permission: { mode: 'auto', async check() { return true; } },
    io,
    modelName: 'deepseek-v4-flash',
    workingDir: home,
    sessionRef: { file: s.file, name: s.name },
    cfg: { permission: 'auto', maxRounds: 1 },
  });
  await agent.runTurn([{ role: 'system', content: '系统' }, { role: 'user', content: '跑两个工具' }]);
  const read = readEvents(eventFileFor(s.file));
  assert.equal(read.ok, true, `事件侧车必须可读：${read.error || ''}`);
  const toolEnds = read.events.filter((/** @type {any} */ e) => e.type === 'tool.end');
  const badEnd = toolEnds.find((/** @type {any} */ e) => e.data?.name === 'outcome_bad');
  const goodEnd = toolEnds.find((/** @type {any} */ e) => e.data?.name === 'outcome_good');
  assert.ok(badEnd && badEnd.data.ok === false, '对象结果 ok:false 必须如实记为失败');
  assert.ok(goodEnd && goodEnd.data.ok === true, '对象结果 ok:true 必须如实记为成功');
  ok('toolOk 行为：对象结果 ok:false / ok:true 如实写 tool.end');
}

// ===========================================================================
// ⑥ 截断续写：finish==='length' 空轮超限 → 账本 status=capped + truncated=true
// ===========================================================================
{
  const home = freshHome('truncation-outcome');
  const fake = {
    async chat() {
      return { text: '', toolCalls: null, usage: {}, finish: 'length' };
    },
  };
  const agent = createAgent({
    provider: fake,
    permission: { async check() { return true; } },
    io: createIO({ quiet: true }),
    modelName: 'deepseek-v4-flash',
    workingDir: home,
    cfg: { permission: 'auto', maxRounds: 1, maxEmptyRounds: 1 },
  });
  const r = await agent.runTurn([{ role: 'system', content: '系统' }, { role: 'user', content: '写长文' }]);
  assert.equal(r.truncated, true, '截断续写必须返回 truncated=true');
  const runEnd = lastRunEvents(home).find((/** @type {any} */ e) => e.type === 'run.end');
  assert.ok(runEnd, '账本必须有 run.end');
  assert.equal(runEnd.status, 'capped', `截断续写必须 markOutcome('capped')，账本不得记 done（实际 ${runEnd.status}）`);
  assert.equal(runEnd.truncated, true, '截断续写必须 markOutcome({truncated:true})，账本 truncated 不得为 false');
  ok('截断续写：markOutcome("capped",{truncated:true}) 三口径一致');
}

// ===========================================================================
// ⑦ 异常出口：工具收尾抛错 → 账本 status=error（不是 done）
// ===========================================================================
{
  const home = freshHome('exception-outcome');
  fs.writeFileSync(path.join(home, 'x.txt'), 'X');
  const io = createIO({ quiet: true });
  io.renderTool = () => {
    throw new Error('render tool boom');
  };
  let t = 0;
  const fake = {
    async chat() {
      t += 1;
      if (t === 1) {
        return {
          text: '',
          toolCalls: [{ id: 'c0', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'x.txt' }) } }],
          usage: {},
          finish: 'tool_calls',
        };
      }
      return { text: 'done', toolCalls: null, usage: {}, finish: 'stop' };
    },
  };
  const agent = createAgent({
    provider: fake,
    permission: { mode: 'auto', async check() { return true; } },
    io,
    modelName: 'deepseek-v4-flash',
    workingDir: home,
    cfg: { permission: 'auto', maxRounds: 1 },
  });
  const messages = [{ role: 'system', content: '系统' }, { role: 'user', content: '读文件' }];
  let threw = false;
  try {
    await agent.runTurn(messages);
  } catch (/** @type {any} */ e) {
    threw = true;
    assert.match(String(e?.message || e), /render tool boom/, '异常必须原样透出');
  }
  assert.ok(threw, '工具收尾抛错必须让回合异常退出');
  const runEnd = lastRunEvents(home).find((/** @type {any} */ e) => e.type === 'run.end');
  assert.ok(runEnd, '异常回合必须有 run.end');
  assert.equal(runEnd.status, 'error', `异常出口必须 markOutcome('error')，账本不得记 done（实际 ${runEnd.status}）`);
  ok('异常出口：markOutcome("error") 落账');
}

// ===========================================================================
// ⑧ 会话写锁结构守卫：appendMessages / rewriteSession 共用同一把 <session>.lock
// ===========================================================================
{
  const sessionSrc = fs.readFileSync(path.join(srcDir, 'session.js'), 'utf8');
  const appendSrc = sessionSrc.slice(sessionSrc.indexOf('export function appendMessages'), sessionSrc.indexOf('export function rewriteSession'));
  const rewriteSrc = sessionSrc.slice(sessionSrc.indexOf('export function rewriteSession'), sessionSrc.indexOf('export function repairSessionEvents'));
  assert.ok(appendSrc.includes('withFileLockSync(sessionLockFile(file)'), 'appendMessages 必须持 <session>.lock');
  ok('结构守卫：appendMessages 持会话锁');

  assert.ok(rewriteSrc.includes('withFileLockSync(sessionLockFile(file)'), 'rewriteSession 必须与 appendMessages 共用同一把 <session>.lock');
  ok('结构守卫：rewriteSession 与 appendMessages 同锁');

  assert.ok(sessionSrc.includes('return `${String(file)}.lock`;'), '会话锁键必须是 `<session file>.lock`');
  ok('结构守卫：会话锁键 = <session file>.lock');
}

console.log(`\nturn-outcome：${passed} 项全部通过`);
process.env.MINGDAO_HOME = baseHome;
