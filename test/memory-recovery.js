// 本地引擎「显存/内存不足」自动降级重试（§3.74 → §3.91 v2）——独立回归套件。
//
// 真机证据（v0.6.17，本机 8081 qwen）：
//   `insufficient memory: the request exceeded available GPU memory
//    (sustained critical memory pressure during prefill; aborted before the allocator wall).
//    The engine shed its caches and stays up; this request failed.`
// v0.6.18 只做了一级压缩 + 一次重试；真机三次同形态失败（10-18 / 10-19 / 10-26）证明不够：
// 日志里 32,768 → 19,660 之后仍被拒绝，整回合直接失败，而更狠的一级（0.35）没人试过；
// 更关键的是**内核自己不记住**——下一回合又按 32,768 撞同一堵墙。
//
// 本套件钉住 v2 的十一件事：
//   ① 第 1 次失败 → 预算 ×0.6、输出 ×0.5 → 成功（且只压缩一次、不写学习值）；
//   ② 第 1 次失败 → ×0.6 仍失败 → 第 2 次 ×0.35/×0.25 → 成功（断言两次重试与两次日志）；
//   ③ 两级都失败 → 写 endpoint-limits.json（最后尝试的预算），**下一回合起手就用学习值**；
//   ④ 父回合压缩后，子代理请求必须使用压缩后的预算（桩断言请求里的 budget）；
//   ⑤ 子代理自己也走同一套多级压缩（父回合没压缩时，子代理自己压两级仍能救回来）；
//   ⑥ 连续 3 个干净成功 → 学习值 +25%（上限 = 用户配置预算）；
//   ⑦ 学习文件损坏 → 不覆盖、不阻断，退化为"无学习值"且有 warn；
//   ⑧ 学习文件写入失败（fs 门面注入 EACCES，不依赖 chmod）→ 不阻断，仍给出正常内存失败文案且有 warn；
//   ⑨ 云端端点 507 → 不重试（不对云 API 做压缩重试）；
//   ⑩ 预检 n_ctx×0.8 clamp 行为不变；⑪ 非内存错误（400/401/429）行为不变。
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
const limitsFile = path.join(home, 'endpoint-limits.json');

const {
  createAgent,
  describeUpstreamError,
  MAX_MEMORY_RETRIES,
  MEMORY_RECOVERY_LEVELS,
  memoryRecoveryTarget,
} = await import(pathToFileURL(path.join(srcDir, 'agent.js')).href);
const { isMemoryPressureError, endpointLimitFor, readEndpointLimits, learnEndpointMemoryFailure } = await import(
  pathToFileURL(path.join(srcDir, 'providers', 'index.js')).href
);
const { createIO } = await import(pathToFileURL(path.join(srcDir, 'ui.js')).href);
const { clampContextBudgetToEngine } = await import(pathToFileURL(path.join(srcDir, 'model-discovery.js')).href);

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`  ✓ 内存恢复[${name}]`);
};

const LOCAL_MODEL = 'local-memrecovery';
// 每个用例一个**独立 baseUrl**：端点学习值按 baseUrl 落盘，复用 URL 会让用例互相污染。
let urlSeq = 0;
const newUrl = () => `http://127.0.0.1:${18080 + (urlSeq += 1)}/v1`;
const LOCAL_ERROR =
  'insufficient memory: the request exceeded available GPU memory ' +
  '(sustained critical memory pressure during prefill; aborted before the allocator wall). ' +
  'The engine shed its caches and stays up; this request failed.';

/** 本地模型配置：窗口 131072（预算不会被 safeBudget 提前压掉），显式 contextBudget 32768。 */
function localCfg(baseUrl = newUrl(), extra = {}) {
  return {
    permission: 'auto',
    autoCompact: false,
    baseUrl,
    contextBudget: 32768,
    customModels: {
      [LOCAL_MODEL]: { baseUrl, local: true, contextWindow: 131072, maxOutputTokens: 8192 },
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

const taskCall = (id = 't1', prompt = '只读审计网络与安全防线', description = '审计') => ({
  text: '',
  reasoning: '',
  usage: { prompt_tokens: 50, completion_tokens: 5 },
  finish: 'tool_calls',
  toolCalls: [
    { id, type: 'function', function: { name: 'task', arguments: JSON.stringify({ prompt, description, readOnly: true }) } },
  ],
});

// ---------------------------------------------------------------------------
// ① 第 1 次失败 → ×0.6/×0.5 → 成功；只压缩一次、不写学习值
// ---------------------------------------------------------------------------
{
  const url = newUrl();
  const calls = [];
  const provider = {
    async chat(/** @type {any} */ opts) {
      calls.push(opts);
      if (calls.length === 1) throw memoryError();
      return okReply();
    },
  };
  const { agent, logs } = makeAgent(provider, localCfg(url));
  const res = await agent.runTurn([{ role: 'user', content: '请创建 a.txt 并写入内容（任务）' }]);
  assert.equal(MAX_MEMORY_RETRIES, 2, '内存降级重试的硬性上限必须是 2（不允许无限）');
  assert.equal(MEMORY_RECOVERY_LEVELS.length, 2, '多级压缩必须恰好两级');
  assert.equal(calls.length, 2, '第 1 级压缩后成功：总请求数必须是 2');
  assert.equal(calls[0].budget, 32768, '首次请求用完整上下文预算');
  assert.equal(calls[0].maxTokens, 8192, '首次请求用完整输出上限');
  assert.equal(calls[1].budget, 19660, '第 1 级压缩必须把预算压到 ×0.6（19,660）');
  assert.equal(calls[1].maxTokens, 4096, '第 1 级压缩必须把输出上限 ×0.5（4,096）');
  assert.equal(calls[1].localConcurrency, 1, '重试期间必须强制串行（并发上限 1）');
  const note = String(res.note || '');
  assert.ok(note.includes('已压缩上下文'), `done.note 必须写明已压缩上下文，实际：${note}`);
  assert.ok(note.includes('32,768 → 19,660'), `done.note 必须带压缩前后数值，实际：${note}`);
  assert.ok(note.includes('1 次，最多 2 次'), `done.note 必须写明重试次数上限，实际：${note}`);
  const all = logs.join('\n');
  assert.ok(all.includes('第 1/2 次'), `日志必须写明这是第几次压缩，实际：${all}`);
  assert.ok(all.includes('19,660'), `日志必须带压缩后的数值，实际：${all}`);
  assert.equal(endpointLimitFor(url).record, null, '只压缩一次就成功时不得写端点学习值（只有两级都失败才学习）');
  ok('① 第 1 级压缩（×0.6/×0.5）→ 成功，且不写学习值');
}

// ---------------------------------------------------------------------------
// ② 第 1 级仍失败 → 第 2 级（×0.35/×0.25）→ 成功；断言两次重试与两次日志数值
// ---------------------------------------------------------------------------
{
  const url = newUrl();
  const calls = [];
  const provider = {
    async chat(/** @type {any} */ opts) {
      calls.push(opts);
      if (calls.length <= 2) throw memoryError();
      return okReply('第二级成功');
    },
  };
  const { agent, logs } = makeAgent(provider, localCfg(url));
  let res = /** @type {any} */ (null);
  try {
    res = await agent.runTurn([{ role: 'user', content: '请创建 a.txt 并写入内容（任务）' }]);
  } catch (e) {
    assert.fail(`两级压缩各重试一次后应成功，不得提前失败/学习：${String((/** @type {any} */ (e))?.message || e)}`);
  }
  assert.equal(calls.length, 3, '两级压缩各重试一次：总请求数必须是 3');
  assert.equal(calls[1].budget, 19660, '第 1 次重试预算 = 起手值 ×0.6');
  assert.equal(calls[1].maxTokens, 4096, '第 1 次重试输出上限 = 起手值 ×0.5');
  assert.equal(calls[2].budget, 11468, '第 2 级压缩必须把预算压到 ×0.35（11,468，相对起手值）');
  assert.equal(calls[2].maxTokens, 2048, '第 2 级压缩必须把输出上限压到 ×0.25（2,048）');
  const all = logs.join('\n');
  assert.ok(all.includes('第 1/2 次') && all.includes('第 2/2 次'), `两次重试都必须写日志（第几次），实际：${all}`);
  assert.ok(all.includes('19,660') && all.includes('11,468'), `两次压缩前后的数值都必须进日志，实际：${all}`);
  const note = String(res.note || '');
  assert.ok(note.includes('32,768 → 19,660 → 11,468'), `done.note 必须带两级压缩链路，实际：${note}`);
  // 纯函数边界：比例相对起手值；下限 4096 / 512
  assert.deepEqual(memoryRecoveryTarget({ budget: 32768, maxOutput: 8192, retry: 1 }), { level: 1, budget: 19660, maxOutput: 4096 });
  assert.deepEqual(memoryRecoveryTarget({ budget: 32768, maxOutput: 8192, retry: 2 }), { level: 2, budget: 11468, maxOutput: 2048 });
  assert.deepEqual(memoryRecoveryTarget({ budget: 1000, maxOutput: 100, retry: 2 }), { level: 2, budget: 4096, maxOutput: 512 });
  ok('② 第 2 级压缩（×0.35/×0.25）→ 成功，两次压缩数值都进日志');
}

// ---------------------------------------------------------------------------
// ③ 两级都失败 → 写 endpoint-limits.json；下一回合起手直接用学习值
// ---------------------------------------------------------------------------
{
  const url = newUrl();
  const calls = [];
  const provider = {
    async chat(/** @type {any} */ opts) {
      calls.push(opts);
      throw memoryError();
    },
  };
  const { agent, logs } = makeAgent(provider, localCfg(url));
  let thrown = /** @type {any} */ (null);
  try {
    await agent.runTurn([{ role: 'user', content: '请创建 a.txt 并写入内容（任务）' }]);
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, '两级压缩仍失败时回合必须失败（不能伪装成 done）');
  assert.equal(calls.length, 3, '两级都失败时总请求数必须是 3（首次 + 硬性上限 2 次重试）');
  assert.ok(!logs.join('\n').includes('第 3/'), '不得出现第 3 次压缩（硬性上限 2）');
  const msg = String(thrown?.message || '');
  assert.ok(msg.includes('32,768 → 19,660 → 11,468'), `错误文案必须带两级压缩链路，实际：${msg}`);
  assert.ok(msg.includes('重试 2 次（硬性上限 2）'), `错误文案必须如实说明重试次数，实际：${msg}`);
  assert.ok(msg.includes('已把该端点内存安全预算记为 11,468'), `错误文案必须给出与学习值一致的数字，实际：${msg}`);
  assert.ok(msg.includes('endpoint-limits.json'), `错误文案必须点名学习文件，实际：${msg}`);
  assert.ok(msg.includes('config.contextBudget'), `错误文案必须给可操作建议（调 contextBudget），实际：${msg}`);
  assert.ok(msg.includes('--ctx-size'), `错误文案必须给引擎侧建议（--ctx-size），实际：${msg}`);
  // 文件：键 = baseUrl，值 = {safeContextBudget, learnedAt, source:'memory-failure'}
  const read = readEndpointLimits();
  const rec = read.endpoints[url];
  assert.ok(rec, '两级压缩仍失败必须写入 endpoint-limits.json');
  assert.equal(rec.safeContextBudget, 11468, '学习值必须是最后尝试的预算（11,468）');
  assert.equal(rec.source, 'memory-failure', '学习记录来源必须是 memory-failure');
  assert.ok(!Number.isNaN(new Date(rec.learnedAt).getTime()), 'learnedAt 必须是可解析的时间');
  const rawFile = JSON.parse(fs.readFileSync(limitsFile, 'utf8'));
  assert.ok(rawFile.endpoints && rawFile.endpoints[url], '学习文件必须是 {version, endpoints:{<baseUrl>:…}} 结构');
  assert.equal(rawFile.endpoints[url].source, 'memory-failure');
  // 建议文案与学习值一致
  const hinted = describeUpstreamError(memoryError(), { isLocal: true, learned: rec });
  assert.ok(String(hinted.hint || '').includes('11,468'), `describeUpstreamError 的建议必须与学习值一致（11,468），实际：${hinted.hint}`);
  assert.ok(String(hinted.hint || '').includes('下轮起手自动使用'), '建议必须说明下轮自动使用学习值');
  // 下一回合：新 agent 起手就用 11,468（桩断言请求里的 budget）
  const calls2 = [];
  const provider2 = {
    async chat(/** @type {any} */ opts) {
      calls2.push(opts);
      return okReply('学习值起手成功');
    },
  };
  const second = makeAgent(provider2, localCfg(url));
  assert.equal(second.agent.budget, 11468, '新 agent 的预算必须直接取学习值 11,468');
  const res2 = await second.agent.runTurn([{ role: 'user', content: '请继续' }]);
  assert.equal(calls2.length, 1, '学习值足够大时不应再触发压缩重试');
  assert.equal(calls2[0].budget, 11468, '下一回合的请求必须直接以学习值起手');
  assert.equal(res2.text, '学习值起手成功');
  const all2 = second.logs.join('\n');
  assert.ok(all2.includes('该端点曾因内存不足降级，本轮预算 11,468'), `chat 预告必须说明预算来自学习值，实际：${all2}`);
  assert.ok(all2.includes('的失败学习'), `chat 预告必须说明学习来源日期，实际：${all2}`);
  ok('③ 两级失败 → 写学习文件；下一回合直接以学习值起手（预告说明来源）');
}

// ---------------------------------------------------------------------------
// ④ 子代理继承：父回合压缩后，子代理请求也必须用压缩后的预算
// ---------------------------------------------------------------------------
{
  const url = newUrl();
  const calls = [];
  const provider = {
    async chat(/** @type {any} */ opts) {
      calls.push(opts);
      if (calls.length === 1) throw memoryError();
      if (calls.length === 2) return taskCall();
      return okReply(calls.length === 3 ? '子代理结论：一切正常' : '父回合收尾完成');
    },
  };
  const { agent } = makeAgent(provider, localCfg(url));
  const res = await agent.runTurn([{ role: 'user', content: '请派一个只读子代理审计网络与安全防线' }]);
  assert.equal(calls.length, 4, '父回合失败 → 压缩后派子代理 → 收尾：共 4 次请求');
  assert.equal(calls[1].budget, 19660, '父回合第 1 级压缩后的预算');
  assert.equal(calls[2].budget, 19660, '子代理请求必须使用父回合压缩后的预算（不得回退到 32,768）');
  assert.equal(calls[2].maxTokens, 4096, '子代理请求的输出上限也必须继承压缩后的值');
  assert.ok(String(res.text || '').includes('父回合收尾完成'), '父回合应在子代理返回后正常收尾');
  ok('④ 子代理继承父回合压缩后的预算/输出上限');
}

// ---------------------------------------------------------------------------
// ⑤ 子代理自己也走多级压缩（父回合未压缩时，子代理独立完成两级压缩并成功）
// ---------------------------------------------------------------------------
{
  const url = newUrl();
  const calls = [];
  const provider = {
    async chat(/** @type {any} */ opts) {
      calls.push(opts);
      if (calls.length === 1) return taskCall('t2', '只读审计依赖清单', '依赖审计');
      // 子代理的前两次请求都撞内存墙，第三次（第 2 级压缩后）成功
      if (calls.length === 2 || calls.length === 3) throw memoryError();
      return okReply(calls.length === 4 ? '子代理自己压缩后成功' : '父回合完成');
    },
  };
  const { agent } = makeAgent(provider, localCfg(url));
  const res = await agent.runTurn([{ role: 'user', content: '请派一个只读子代理审计依赖' }]);
  assert.equal(calls.length, 5, '父回合 + 子代理 3 次请求 + 父回合收尾：共 5 次');
  assert.equal(calls[1].budget, 32768, '子代理第 1 次请求继承父回合原预算');
  assert.equal(calls[2].budget, 19660, '子代理自己的第 1 级压缩：×0.6');
  assert.equal(calls[3].budget, 11468, '子代理自己的第 2 级压缩：×0.35');
  assert.equal(calls[3].maxTokens, 2048, '子代理第 2 级压缩的输出上限：×0.25');
  assert.ok(String(res.text || '').includes('父回合完成'), '子代理自己的压缩成功后父回合应正常收尾');
  ok('⑤ 子代理自己也能做两级压缩（不依赖父回合）');
}

// ---------------------------------------------------------------------------
// ⑥ 学习值上调策略：连续 3 个干净成功 → +25%（上限 = 用户配置预算）
// ---------------------------------------------------------------------------
{
  const url = newUrl();
  learnEndpointMemoryFailure(url, { budget: 8192, maxOutput: 2048, attempts: 2 });
  const provider = { async chat() { return okReply('好'); } };
  const { agent, logs } = makeAgent(provider, localCfg(url)); // 用户配置仍是 32768
  assert.equal(agent.budget, 8192, '本轮起手取学习值 8,192（小于配置 32,768）');
  await agent.runTurn([{ role: 'user', content: '第一回合' }]);
  assert.equal(readEndpointLimits().endpoints[url].safeContextBudget, 8192, '成功 1 次不得上调（策略：连续 3 次）');
  await agent.runTurn([{ role: 'user', content: '第二回合' }]);
  assert.equal(readEndpointLimits().endpoints[url].safeContextBudget, 8192, '成功 2 次不得上调（策略：连续 3 次）');
  await agent.runTurn([{ role: 'user', content: '第三回合' }]);
  const rec = readEndpointLimits().endpoints[url];
  assert.equal(rec.safeContextBudget, 10240, '连续 3 次干净成功 → +25%（8,192 → 10,240）');
  assert.equal(rec.source, 'success-upgrade', '上调后的来源必须是 success-upgrade');
  assert.ok(logs.join('\n').includes('上调 8,192 → 10,240'), '上调必须写日志（含前后数值）');
  ok('⑥ 连续 3 次干净成功 → 学习值 +25%（8,192 → 10,240）');
}

// ---------------------------------------------------------------------------
// ⑦ 学习文件损坏 → 不覆盖、不阻断，退化为无学习值且有 warn
// ---------------------------------------------------------------------------
{
  const url = newUrl();
  const backup = fs.existsSync(limitsFile) ? fs.readFileSync(limitsFile, 'utf8') : null;
  const corrupt = '{ 这不是 JSON（模拟磁盘写了一半）';
  fs.writeFileSync(limitsFile, corrupt, 'utf8');
  const calls = [];
  const provider = { async chat(/** @type {any} */ opts) { calls.push(opts); throw memoryError(); } };
  const { agent, logs } = makeAgent(provider, localCfg(url));
  let thrown = /** @type {any} */ (null);
  try {
    await agent.runTurn([{ role: 'user', content: '请创建 a.txt 并写入内容（任务）' }]);
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, '学习文件损坏不得阻断会话：仍按正常内存失败路径报错');
  assert.equal(calls.length, 3, '学习文件损坏时两级压缩仍照常执行（3 次请求）');
  assert.ok(String(thrown?.message || '').includes('重试 2 次'), '损坏时仍应如实报出两级压缩后的失败');
  assert.ok(logs.join('\n').includes('端点学习文件不能解析'), '学习文件损坏必须有 warn（指出不能解析）');
  assert.equal(fs.readFileSync(limitsFile, 'utf8'), corrupt, '损坏的学习文件必须保持原样（不覆盖，留待人工修复）');
  // 下一回合退化为无学习值：仍按配置预算起手
  const provider2 = { async chat() { return okReply('好'); } };
  const second = makeAgent(provider2, localCfg(url));
  assert.equal(second.agent.budget, 32768, '学习文件损坏时下一回合必须退化为无学习值（按配置预算起手）');
  if (backup == null) fs.rmSync(limitsFile, { force: true });
  else fs.writeFileSync(limitsFile, backup, 'utf8');
  ok('⑦ 学习文件损坏 → 不覆盖/不阻断，退化为无学习值且有 warn');
}

// ---------------------------------------------------------------------------
// ⑧ 学习文件写入失败 → 不阻断，仍给出正常内存失败文案且有 warn
//
// v0.6.27 §3.93（windows-latest 红）：这里**不能**再用 `fs.chmodSync(home, 0o500)` 造"目录不可写"。
// Windows（尤其 admin runner）上 chmod 只改只读位，**不阻止**目录内创建/重命名 —— 写其实成功、
// 没有 warn，断言在 Windows 腿必红；套件还会崩在 ⑧，把 batch40 的 ⑦–⑩ 一起拖成"逃逸"。
// 产品代码没有回归，错的是夹具的平台假设。改成给 endpoint-limits.json 的**原子写临时文件**
// 注入一个 fs 门面：第一次写就抛 EACCES，所有平台确定性地走"写入失败 → warn"路径。
// ---------------------------------------------------------------------------
{
  const url = newUrl();
  const backup = fs.existsSync(limitsFile) ? fs.readFileSync(limitsFile, 'utf8') : null;
  fs.writeFileSync(limitsFile, JSON.stringify({ version: 1, endpoints: {} }) + '\n', 'utf8');
  const realWriteFileSync = fs.writeFileSync;
  const limitsDir = path.dirname(limitsFile);
  const limitsBase = path.basename(limitsFile);
  let injectedFailures = 0;
  // 门面只拦学习文件的原子写临时文件（.<basename>.<pid>.<hex>.tmp），不碰进程里其它写。
  // 第一次写就抛 EACCES；EACCES 是原子写的"瞬时拒绝"，它会重试到 2s 预算耗尽后原样抛出。
  fs.writeFileSync = function (/** @type {any} */ p, /** @type {any} */ data, /** @type {any} */ opts) {
    const name = path.basename(String(p));
    if (path.dirname(String(p)) === limitsDir && name.startsWith(`.${limitsBase}.`) && name.endsWith('.tmp')) {
      injectedFailures += 1;
      const err = /** @type {any} */ (new Error(`EACCES: permission denied, open '${String(p)}'（测试注入：学习文件写入失败）`));
      err.code = 'EACCES';
      err.errno = -13;
      err.syscall = 'open';
      err.path = String(p);
      throw err;
    }
    return realWriteFileSync.call(fs, p, data, opts);
  };
  let thrown = /** @type {any} */ (null);
  let logs = /** @type {string[]} */ ([]);
  try {
    const provider = { async chat() { throw memoryError(); } };
    const made = makeAgent(provider, localCfg(url));
    logs = made.logs;
    try {
      await made.agent.runTurn([{ role: 'user', content: '请创建 a.txt 并写入内容（任务）' }]);
    } catch (e) {
      thrown = e;
    }
    assert.ok(injectedFailures > 0, '注入的 fs 门面必须被真实调用（证明确实走到 endpoint-limits.json 的写入路径，而不是靠平台权限碰运气）');
    assert.ok(thrown, '学习文件写入失败不得阻断会话：仍按正常内存失败路径报错');
    assert.ok(String(thrown?.message || '').includes('重试 2 次'), '写入失败时仍应如实报出两级压缩后的失败');
    assert.ok(String(thrown?.message || '').includes('端点学习文件写入失败'), '写入失败时错误文案必须有 warn（写入失败）');
    assert.ok(logs.join('\n').includes('端点学习文件写入失败'), '写入失败时日志必须有 warn（写入失败）');
    assert.ok(String(thrown?.message || '').includes('不阻断会话'), '写入失败必须明说"不阻断会话"（降级为无学习值继续）');
  } finally {
    fs.writeFileSync = realWriteFileSync; // 先还原门面，再用真实 fs 收拾现场（否则清理写也会被拦）
    if (backup == null) fs.rmSync(limitsFile, { force: true });
    else fs.writeFileSync(limitsFile, backup, 'utf8');
  }
  // 退化为无学习值：下一回合仍按配置预算起手
  const provider2 = { async chat() { return okReply('好'); } };
  const second = makeAgent(provider2, localCfg(url));
  assert.equal(second.agent.budget, 32768, '学习文件写入失败时下一回合必须退化为无学习值（按配置预算起手）');
  ok('⑧ 学习文件写入失败（fs 门面 EACCES）→ 不阻断/退化为无学习值且有 warn');
}

// ---------------------------------------------------------------------------
// ⑨ 云端端点 507 → 不重试（不对云 API 做压缩重试）
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
  ok('⑨ 云端 507 → 不重试');
}

// ---------------------------------------------------------------------------
// ⑩ 预检 n_ctx×0.8 clamp：发请求前 clamp 并提示（行为不变）
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
  const url = newUrl();
  const cfg = localCfg(url, { contextBudget: 131072, endpointProbe: { engineCtx: 32768 } });
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
  assert.equal(clampContextBudgetToEngine({ contextBudget: 20000, engineCtx: 32768 }).clamped, false, '未超 n_ctx×0.8 不得 clamp');
  assert.equal(clampContextBudgetToEngine({ contextBudget: 20000, engineCtx: null }).clamped, false, '没有引擎自述 n_ctx 不得 clamp');
  ok('⑩ 引擎 n_ctx×0.8 clamp + 发请求前提示');
}

// ---------------------------------------------------------------------------
// ⑪ 非内存类错误（400/401/429）行为不变；可重试标志只对本地内存类错误为真
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
  ok('⑪ 400/401/429 行为不变；可重试标志只对本地内存类错误为真');
}

delete process.env.MINGDAO_HOME;
fs.rmSync(home, { recursive: true, force: true });
console.log(`\n本地内存不足多级压缩 / 端点学习 / 子代理继承测试全部通过：${passed} 项 ✓`);
