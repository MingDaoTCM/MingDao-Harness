// 模型发现并发 + 短期负缓存套件（v0.7.1 H-6）。
//
// 运行：node test/model-discovery-parallel.js（失败非 0；不依赖真实外网——本地 stub /v1/models）。
//
// 覆盖：
//   ① 并发探测：`probeProviderModels` 用 Promise.all，多服务商总耗时≈单次而非串行累加；
//   ② single-flight：同一服务商并发两次调用合并为一次出网（inflight 去重不因并发而破坏）；
//   ③ 短期负缓存：首次失败 → 第二次同 Key 不再出网；TTL 过期失效；成功即清除；force 绕过；
//   ④ AbortController 死代码移除（fetchProviderModels 内不得再有「创建了却不传给 safeFetchText」的死控制器）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-modeldisc-par-'));
process.env.MINGDAO_HOME = home;
// 隔离外部环境：清掉所有服务商 env key，只靠凭证库写入的测试 Key。
for (const k of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'DASHSCOPE_API_KEY', 'ZHIPUAI_API_KEY', 'MOONSHOT_API_KEY', 'VLLM_API_KEY', 'OLLAMA_API_KEY', 'ONEAPI_API_KEY', 'MINGDAO_API_KEY']) {
  delete process.env[k];
}

let passed = 0;
let failed = 0;
/**
 * @param {string} name
 * @param {() => any} fn
 */
async function t(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ model-discovery-parallel：${name}`);
  } catch (/** @type {any} */ e) {
    failed += 1;
    console.error(`  ✗ model-discovery-parallel：${name} —— ${String(e?.message || e)}`);
  }
}

// ---------- 本地 stub：可切换 ok/fail，记录 /v1/models 命中次数 ----------
let mode = 'ok';
let hits = 0;
const server = http.createServer((req, res) => {
  if (String(req.url) === '/v1/models') {
    hits += 1;
    if (mode === 'fail') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'stub down' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'stub-model-a' }, { id: 'stub-model-b' }] }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}/v1`;

const { fetchProviderModels, probeProviderModels, negativeCacheHit, NEGATIVE_TTL_MS } = await import(
  pathToFileURL(path.join(srcDir, 'model-discovery.js')).href
);
const { setStoredKey } = await import(pathToFileURL(path.join(srcDir, 'credentials.js')).href);

// 每个行为测试用不同服务商名，避免模块级负缓存/inflight/正缓存互相串味。
for (const pname of ['deepseek', 'openai', 'qwen', 'glm']) setStoredKey(pname, 'sk-test');
const cfgFor = (/** @type {string} */ pname) => ({ provider: pname, baseUrl: base });
const delay = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const modelCachePath = path.join(home, 'model-cache.json');

console.log('\n[model-discovery-parallel · 并发探测]');

await t('① 并发：3 个服务商总耗时≈单次而非串行累加', async () => {
  /** @type {number[]} */
  const starts = [];
  /** @type {string[]} */
  const calls = [];
  const stub = async (/** @type {any} */ _cfg, /** @type {string} */ name) => {
    starts.push(Date.now());
    calls.push(name);
    await delay(200);
    return { models: [`${name}-model`], fromCache: false, fetchedAt: Date.now() };
  };
  const t0 = Date.now();
  const res = await probeProviderModels({}, [['a', { label: 'A' }], ['b', { label: 'B' }], ['c', { label: 'C' }]], stub);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 340, `并发探测必须同时出网（总耗时 ${elapsed}ms 应接近单次 200ms，而非串行 600ms）`);
  assert.equal(res.length, 3, '并发探测必须返回全部 3 个服务商的结果');
});

await t('② 并发：三个请求启动重叠（非背靠背）', async () => {
  /** @type {number[]} */
  const starts = [];
  const stub = async (/** @type {any} */ _cfg, /** @type {string} */ name) => {
    starts.push(Date.now());
    await delay(200);
    return { models: [name] };
  };
  await probeProviderModels({}, [['a', {}], ['b', {}], ['c', {}]], stub);
  const spread = Math.max(...starts) - Math.min(...starts);
  assert.ok(spread < 60, `并发探测启动必须重叠（实测窗口 ${spread}ms，串行会 ≥400ms）`);
});

await t('③ 并发：每个服务商只调用一次，且 pname/pp/dynamic 完整', async () => {
  /** @type {string[]} */
  const calls = [];
  const stub = async (/** @type {any} */ _cfg, /** @type {string} */ name) => {
    calls.push(name);
    return { models: [`${name}-model`] };
  };
  const res = await probeProviderModels({}, [['x', { label: 'X' }], ['y', { label: 'Y' }]], stub);
  assert.deepEqual(calls, ['x', 'y'], '并发探测每个服务商只能调用一次');
  assert.deepEqual(res.map((/** @type {any} */ r) => r.pname), ['x', 'y'], '结果必须按输入顺序带回 pname');
  assert.equal(res[0].pp.label, 'X', '结果必须保留 pp（provider 元数据）');
  assert.deepEqual(res[1].dynamic.models, ['y-model'], '结果必须带回 dynamic（该服务商拉取结果）');
});

console.log('\n[model-discovery-parallel · single-flight]');

await t('④ single-flight：同一服务商并发两次调用只出网一次', async () => {
  hits = 0;
  mode = 'ok';
  const cfg = cfgFor('deepseek');
  const [a, b] = await Promise.all([fetchProviderModels(cfg, 'deepseek'), fetchProviderModels(cfg, 'deepseek')]);
  assert.equal(hits, 1, 'single-flight 必须合并并发请求（出网一次而非两次）');
  assert.deepEqual(a, b, '并发两次调用必须拿到同一结果（inflight 合并）');
  assert.deepEqual(a.models, ['stub-model-a', 'stub-model-b'], 'single-flight 不破坏正常返回');
});

console.log('\n[model-discovery-parallel · 短期负缓存]');

await t('⑤ 负缓存：首次失败 → 第二次同 Key 不再出网', async () => {
  hits = 0;
  mode = 'fail';
  const cfg = cfgFor('openai');
  const r1 = await fetchProviderModels(cfg, 'openai');
  assert.ok(r1.error, '首次探测失败必须返回 error');
  assert.equal(hits, 1, '首次探测必须出网一次');
  const r2 = await fetchProviderModels(cfg, 'openai');
  assert.ok(String(r2.error || '').includes('负缓存'), '负缓存命中必须直接返回错误提示');
  assert.equal(hits, 1, '负缓存命中必须不再出网（hits 不增）');
});

await t('⑥ 成功探测必须清除负缓存', async () => {
  hits = 0;
  mode = 'fail';
  const cfg = cfgFor('qwen');
  await fetchProviderModels(cfg, 'qwen'); // 失败 → 负缓存
  assert.equal(hits, 1, '第一步失败应出网一次');
  mode = 'ok';
  const okRes = await fetchProviderModels(cfg, 'qwen', { force: true }); // force 重试成功 → 清负缓存
  assert.deepEqual(okRes.models, ['stub-model-a', 'stub-model-b'], 'force 重试应成功');
  assert.equal(hits, 2, 'force 重试应出网一次');
  // 删掉成功写入的正缓存，逼下一次非 force 走「负缓存已清 → 出网」路径
  fs.rmSync(modelCachePath, { force: true });
  const r3 = await fetchProviderModels(cfg, 'qwen');
  assert.deepEqual(r3.models, ['stub-model-a', 'stub-model-b'], '成功探测必须清除负缓存（后续非 force 应再次出网成功）');
  assert.equal(hits, 3, '成功清除负缓存后，非 force 必须再次出网（hits 3）');
});

await t('⑦ 负缓存 TTL 过期必须失效（纯函数）', () => {
  const now = 1_700_000_000_000;
  assert.equal(negativeCacheHit({ failUntil: now + 1000 }, now), true, '未过期必须命中');
  assert.equal(negativeCacheHit({ failUntil: now - 1 }, now), false, '负缓存 TTL 过期必须失效（过期条目不得再命中）');
  assert.equal(negativeCacheHit({ failUntil: now }, now), false, 'failUntil === now 视为已过期');
  assert.equal(negativeCacheHit({ failUntil: '1700000000000' }, now), false, 'failUntil 非数字不得命中');
  assert.equal(negativeCacheHit(undefined, now), false, '无条目不得命中');
  assert.ok(NEGATIVE_TTL_MS >= 30 * 1000 && NEGATIVE_TTL_MS <= 60 * 1000, '负缓存 TTL 必须落在 30~60s 区间');
});

await t('⑧ force 绕过负缓存（重试不因负缓存被跳过）', async () => {
  hits = 0;
  mode = 'fail';
  const cfg = cfgFor('glm');
  await fetchProviderModels(cfg, 'glm'); // 失败 → 负缓存
  assert.equal(hits, 1, '第一步失败应出网一次');
  mode = 'ok';
  const r2 = await fetchProviderModels(cfg, 'glm', { force: true });
  assert.deepEqual(r2.models, ['stub-model-a', 'stub-model-b'], 'force 必须绕过负缓存直接重试并成功');
  assert.equal(hits, 2, 'force 绕过负缓存必须出网');
});

console.log('\n[model-discovery-parallel · 死代码]');

await t('⑨ AbortController 死代码必须移除', () => {
  const src = fs.readFileSync(path.join(srcDir, 'model-discovery.js'), 'utf8');
  assert.equal(src.includes('const ctrl = new AbortController()'), false, 'AbortController 死代码必须移除（fetchProviderModels 内不得创建从不传入 safeFetchText 的控制器）');
  assert.ok(/timeoutMs:\s*8000/.test(src), '超时必须由 safeFetchText 的 timeoutMs 接管（而非旁路 setTimeout）');
});

server.close();
console.log(`\nmodel-discovery-parallel：${passed} 项通过，${failed} 项失败`);
process.exit(failed ? 1 : 0);
