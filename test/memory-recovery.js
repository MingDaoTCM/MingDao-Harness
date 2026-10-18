// 本地引擎「显存/内存不足」自动降级重试（§3.74）——独立回归套件。
//
// 真机证据（v0.6.17，本机 8081 qwen）：
//   `insufficient memory: the request exceeded available GPU memory
//    (sustained critical memory pressure during prefill; aborted before the allocator wall).
//    The engine shed its caches and stays up; this request failed.`
// 当时上下文只有 ≈2,773 tokens、预算 32,768——**压小上下文/降低输出上限后极可能成功**，
// 但整回合直接失败。本套件钉住四件事：
//   ① 本地端点命中内存类错误 → 压缩上下文 + 输出上限减半 + 强制串行，**只重试一次**；
//   ② 第二次仍失败 → 回合失败，错误文案必须带压缩前后数值与具体建议；
//   ③ 云端端点遇到 507 → **不重试**（不对云 API 做压缩重试）；
//   ④ 预检读到引擎 n_ctx 且配置预算超过 n_ctx×0.8 → 发请求前 clamp 并提示；
//   ⑤ 非内存类错误（400/401/429）→ 行为不变，不触发该恢复。
//
// 运行：node test/memory-recovery.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-memrecovery-'));
process.env.MINGDAO_HOME = home;

const { createAgent, describeUpstreamError, MAX_MEMORY_RETRIES } = await import(pathToFileURL(path.join(srcDir, 'agent.js')).href);
const { isMemoryPressureError } = await import(pathToFileURL(path.join(srcDir, 'providers', 'index.js')).href);
const { createIO } = await import(pathToFileURL(path.join(srcDir, 'ui.js')).href);
const { clampContextBudgetToEngine } = await import(pathToFileURL(path.join(srcDir, 'model-discovery.js')).href);

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`  ✓ 内存恢复[${name}]`);
};

const LOCAL_URL = 'http://127.0.0.1:18081/v1';
const LOCAL_MODEL = 'local-memrecovery';
const LOCAL_ERROR =
  'insufficient memory: the request exceeded available GPU memory ' +
  '(sustained critical memory pressure during prefill; aborted before the allocator wall). ' +
  'The engine shed its caches and stays up; this request failed.';

/** 本地模型配置：窗口 131072（budget 不会被 safeBudget 提前压掉），显式 contextBudget 32768。 */
function localCfg(extra = {}) {
  return {
    permission: 'auto',
    autoCompact: false,
    baseUrl: LOCAL_URL,
    contextBudget: 32768,
    customModels: {
      [LOCAL_MODEL]: { baseUrl: LOCAL_URL, local: true, contextWindow: 131072, maxOutputTokens: 8192 },
    },
    ...extra,
  };
}

/** 造一个 agent + 可捕获的 io.print 日志。 */
function makeAgent(provider, cfg, modelName = LOCAL_MODEL) {
  const io = createIO({ quiet: true });
  const logs = [];
  io.print = (/** @type {any} */ text = '') => logs.push(String(text));
  const agent = createAgent({
    provider,
    permission: { async check() { return true; } },
    io,
    modelName,
    workingDir: home,
    cfg,
  });
  return { agent, logs, io };
}

const memoryError = () => {
  const e = /** @type {any} */ (new Error(LOCAL_ERROR));
  e.status = 507;
  return e;
};

const okReply = (text = '重试成功') => ({
  text,
  reasoning: '',
  toolCalls: null,
  usage: { prompt_tokens: 100, completion_tokens: 10 },
  finish: 'stop',
});

// ---------------------------------------------------------------------------
// ① 第一次 507/insufficient memory → 第二次成功 → 回合 done，只重试一次
// ---------------------------------------------------------------------------
{
  const calls = [];
  const provider = {
    async chat(/** @type {any} */ opts) {
      calls.push(opts);
      if (calls.length === 1) throw memoryError();
      return okReply();
    },
  };
  const { agent, logs } = makeAgent(provider, localCfg());
  const res = await agent.runTurn([{ role: 'user', content: '请创建 a.txt 并写入内容（任务）' }]);
  assert.equal(calls.length, 2, '本地内存不足只允许重试一次（总请求数 = 2）');
  assert.equal(res.text, '重试成功', '重试成功后回合应完成（done 而不是整回合失败）');
  assert.equal(calls[0].maxTokens, 8192, '首次请求用完整输出上限');
  assert.equal(calls[1].maxTokens, 4096, '重试时输出上限必须 ×0.5');
  assert.equal(calls[1].localConcurrency, 1, '重试期间必须强制串行（并发上限 1，复用 acquireLocalSlot）');
  const note = String(res.note || '');
  assert.ok(note.includes('已压缩上下文'), `done.note 必须写明已压缩上下文，实际：${note}`);
  assert.ok(note.includes('重试一次'), `done.note 必须写明只重试一次，实际：${note}`);
  assert.ok(note.includes('32,768') && note.includes('19,660'), `done.note 必须带压缩前后数值（32,768 → ~19,660），实际：${note}`);
  assert.ok(logs.join('\n').includes('已压缩上下文'), '日志/界面必须打出压缩与重试说明');
  assert.ok(!logs.join('\n').includes('重试两次'), '不得出现无限重试的迹象');
  ok('① 本地内存不足 → 压缩 + 输出减半 + 串行，只重试一次且成功');
}

// ---------------------------------------------------------------------------
// ② 两次都失败 → 回合失败，错误文案含具体建议与压缩前后数值
// ---------------------------------------------------------------------------
{
  assert.equal(MAX_MEMORY_RETRIES, 1, '降级重试上限必须是 1（不允许无限重试）');
  const calls = [];
  const provider = {
    async chat(/** @type {any} */ opts) {
      calls.push(opts);
      throw memoryError();
    },
  };
  const { agent, logs } = makeAgent(provider, localCfg());
  let thrown = null;
  try {
    await agent.runTurn([{ role: 'user', content: '请创建 a.txt 并写入内容（任务）' }]);
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, '第二次仍失败时回合必须失败（不能伪装成 done）');
  const msg = String(thrown?.message || '');
  assert.equal(calls.length, 2, '失败路径也只能重试一次');
  assert.ok(msg.includes('32,768') && msg.includes('19,660'), `错误文案必须带压缩前后数值，实际：${msg}`);
  assert.ok(msg.includes('config.contextBudget'), `错误文案必须给可操作建议（调 contextBudget），实际：${msg}`);
  assert.ok(msg.includes('--ctx-size'), `错误文案必须给引擎侧建议（--ctx-size），实际：${msg}`);
  assert.ok(msg.includes('重试 1 次'), `错误文案必须如实说明重试次数，实际：${msg}`);
  assert.ok(logs.join('\n').includes('已压缩上下文'), '第一次失败时的压缩/重试提示必须已进日志');
  ok('② 两次都失败 → 回合失败，文案含具体建议与压缩前后数值');
}

// ---------------------------------------------------------------------------
// ③ 云端端点 507 → 不重试（不对云 API 做压缩重试）
// ---------------------------------------------------------------------------
{
  const calls = [];
  const provider = {
    async chat(/** @type {any} */ opts) {
      calls.push(opts);
      const e = /** @type {any} */ (new Error('insufficient memory: upstream refused this request'));
      e.status = 507;
      throw e;
    },
  };
  const { agent, logs } = makeAgent(provider, {
    permission: 'auto',
    autoCompact: false,
    baseUrl: 'https://api.deepseek.com',
    contextBudget: 32768,
  }, 'deepseek-v4-flash');
  let res = /** @type {any} */ (null);
  let thrown = /** @type {any} */ (null);
  try {
    res = await agent.runTurn([{ role: 'user', content: '你好' }]);
  } catch (e) {
    thrown = e; // 云端 507 可能沿既有错误路径上抛——只要**没有重试**就符合"行为不变"
  }
  assert.equal(calls.length, 1, '云端端点遇到 507 不得重试（云 API 不做压缩重试）');
  const cloudNote = String(res?.note || thrown?.message || '');
  assert.ok(!cloudNote.includes('已压缩上下文'), '云端 507 不得出现压缩重试说明');
  assert.ok(!logs.join('\n').includes('已压缩上下文'), '云端 507 不得打压缩重试日志');
  assert.ok(logs.join('\n').includes('502') === false, '云端 507 不得被误判成 5xx 瞬态重试');
  ok('③ 云端 507 → 不重试');
}

// ---------------------------------------------------------------------------
// ④ 预检读到引擎 n_ctx 且预算 > n_ctx×0.8 → 发请求前 clamp 并提示
// ---------------------------------------------------------------------------
{
  const calls = [];
  const logs = [];
  const provider = {
    async chat(/** @type {any} */ opts) {
      calls.push(opts);
      logs.push('__chat__');
      return okReply('clamp 后成功');
    },
  };
  const cfg = localCfg({ contextBudget: 131072, endpointProbe: { engineCtx: 32768 } });
  const io = createIO({ quiet: true });
  io.print = (/** @type {any} */ text = '') => logs.push(String(text));
  const agent = createAgent({
    provider,
    permission: { async check() { return true; } },
    io,
    modelName: LOCAL_MODEL,
    workingDir: home,
    cfg,
  });
  assert.equal(agent.budget, 26214, '引擎 n_ctx=32768 → prompt 预算必须 clamp 到 32768×0.8=26214');
  const res = await agent.runTurn([{ role: 'user', content: '你好' }]);
  assert.equal(calls.length, 1, 'clamp 后正常发一次请求');
  const all = logs.join('\n');
  assert.ok(all.includes('引擎自述上下文'), `必须有引擎自述上下文提示，实际：${all}`);
  assert.ok(all.includes('clamp'), `必须明确说已 clamp，实际：${all}`);
  assert.ok(all.includes('26,214'), `必须给出 clamp 后的具体数值，实际：${all}`);
  const clampAt = logs.findIndex((x) => String(x).includes('clamp'));
  const chatAt = logs.indexOf('__chat__');
  assert.ok(clampAt >= 0 && chatAt >= 0 && clampAt < chatAt, 'clamp 提示必须发生在发请求之前');
  assert.ok(String(res.note || '').includes('clamp'), 'done.note 也必须带 clamp 说明');
  // 纯函数边界：未超线不 clamp；没有 n_ctx 不 clamp
  assert.equal(clampContextBudgetToEngine({ contextBudget: 20000, engineCtx: 32768 }).clamped, false, '未超 n_ctx×0.8 不得 clamp');
  assert.equal(clampContextBudgetToEngine({ contextBudget: 20000, engineCtx: null }).clamped, false, '没有引擎自述 n_ctx 不得 clamp');
  ok('④ 引擎 n_ctx×0.8 clamp + 发请求前提示');
}

// ---------------------------------------------------------------------------
// ⑤ 非内存类错误（400/401/429）→ 行为不变，不触发内存恢复
// ---------------------------------------------------------------------------
{
  const cases = [
    [400, 'Bad Request: invalid parameter'],
    [401, 'Unauthorized: invalid api key'],
    [429, 'rate limited'],
  ];
  for (const [status, text] of cases) {
    const calls = [];
    const provider = {
      async chat(/** @type {any} */ opts) {
        calls.push(opts);
        const e = /** @type {any} */ (new Error(text));
        e.status = status;
        throw e;
      },
    };
    const { agent, logs } = makeAgent(provider, localCfg());
    await assert.rejects(
      () => agent.runTurn([{ role: 'user', content: '你好' }]),
      (/** @type {any} */ e) => {
        assert.ok(String(e?.message || '').includes(text), `${status} 原始错误应保留`);
        return true;
      },
      `${status} 应正常失败（不触发内存恢复）`
    );
    assert.equal(calls.length, 1, `${status} 不得重试`);
    assert.ok(!logs.join('\n').includes('已压缩上下文'), `${status} 不得触发压缩重试`);
  }
  // 可重试标志只对本地内存类错误为真
  assert.equal(isMemoryPressureError(memoryError()), true, '507 + insufficient memory 必须识别为内存压力');
  assert.equal(describeUpstreamError(memoryError(), { isLocal: true }).recoverableByShrinking, true, '本地内存类错误必须标记可压缩恢复');
  assert.equal(describeUpstreamError(memoryError(), { isLocal: false }).recoverableByShrinking, false, '云端不得标记为可压缩恢复');
  assert.equal(describeUpstreamError({ status: 400, message: 'bad request' }, { isLocal: true }).recoverableByShrinking, false, '400 不得标记可压缩恢复');
  assert.equal(describeUpstreamError({ status: 401, message: 'Unauthorized' }, { isLocal: true }).recoverableByShrinking, false, '401 不得标记可压缩恢复');
  assert.equal(describeUpstreamError({ status: 429, message: 'rate limited' }, { isLocal: true }).recoverableByShrinking, false, '429 不得标记可压缩恢复');
  ok('⑤ 400/401/429 行为不变；可重试标志只对本地内存类错误为真');
}

delete process.env.MINGDAO_HOME;
fs.rmSync(home, { recursive: true, force: true });
console.log(`\n本地内存不足降级重试测试全部通过：${passed} 项 ✓`);
