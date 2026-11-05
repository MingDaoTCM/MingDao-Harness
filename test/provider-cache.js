// Provider 缓存/预检运行时套件（v0.7.0 §1.5：provider-cache 从 server.js 切出后的行为契约）。
//
// 运行：node test/provider-cache.js
//
// 全依赖注入（不读 config.json、不发网络请求），只测 src/web/provider-cache.js：
// 缓存键/指纹/代际、并发期间变更不写回、探测备忘的同代际命中与跨代际失效、预检失败不阻断。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const { createProviderCache } = await import(pathToFileURL(path.join(srcDir, 'web', 'provider-cache.js')).href);
const { probeMemoUsable } = await import(pathToFileURL(path.join(srcDir, 'model-discovery.js')).href);

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
    console.log(`  ✓ provider-cache：${name}`);
  } catch (/** @type {any} */ e) {
    failed += 1;
    console.error(`  ✗ provider-cache：${name} —— ${String(e?.message || e)}`);
  }
}

/**
 * 默认假依赖：一个可变的"当前出网配置"，createProvider 记录收到的 cfg。
 * @param {any} [overrides]
 */
function makeRuntime(overrides = {}) {
  const state = { cfg: { timeout: { firstTokenMs: 60000, totalMs: 120000 }, customModels: {} } };
  /** @type {{createCfg: any[], probeOpts: any[], log: string[], warn: string[]}} */
  const seen = { createCfg: [], probeOpts: [], log: [], warn: [] };
  let n = 0;
  const runtime = createProviderCache({
    cfg: state.cfg,
    log: (/** @type {string} */ line) => seen.log.push(line),
    warn: (/** @type {string} */ line) => seen.warn.push(line),
    resolveProviderConfig: (/** @type {any} */ c, /** @type {string} */ m) => {
      if (overrides.resolveProviderConfig) return overrides.resolveProviderConfig(c, m);
      return overrides.providerConfig || { baseUrl: 'http://endpoint-a/v1', apiKey: 'sk-abc' };
    },
    createProvider: async (/** @type {any} */ c, /** @type {string} */ m) => {
      n += 1;
      seen.createCfg.push(c);
      if (overrides.createProvider) return overrides.createProvider(c, m, n);
      return { id: n, model: m };
    },
    probeEndpoint: async (/** @type {any} */ c, /** @type {string} */ m, /** @type {any} */ opts) => {
      seen.probeOpts.push(opts);
      if (overrides.probeEndpoint) return overrides.probeEndpoint(c, m, opts);
      return { state: 'ok', ttftMs: 100, prefillMs: 50, endpoint: 'http://endpoint-a/v1', toolState: 'stable-tools', toolCallHits: 3, toolCallRuns: 3 };
    },
    probeMemoUsable: overrides.probeMemoUsable || ((/** @type {any} */ memo) => Boolean(memo)),
    adaptiveTimeouts: overrides.adaptiveTimeouts || (() => ({ firstTokenMs: 600000, basis: '测试夹具' })),
    isLocalBaseUrl: overrides.isLocalBaseUrl || (() => true),
    setLocalQueueObserver: overrides.setLocalQueueObserver || null,
  });
  return { runtime, state, seen };
}

console.log('\n[provider-cache · 缓存键与指纹]');

await t('P1 同模型同配置复用同一实例（只建一次）', async () => {
  const { runtime, seen } = makeRuntime();
  const a = await runtime.getProviderFor('m1');
  const b = await runtime.getProviderFor('m1');
  assert.equal(a, b, 'P1：同模型同指纹必须复用同一 provider 实例');
  assert.equal(seen.createCfg.length, 1, 'P1：createProvider 只能调用一次');
  assert.equal(runtime.stats().instances, 1, 'P1：缓存里只能有一个实例');
});

await t('P2 同模型不同 baseUrl 不得复用（H-04）', async () => {
  let cfgNow = { baseUrl: 'http://endpoint-a/v1', apiKey: 'sk-abc' };
  const { runtime } = makeRuntime({ resolveProviderConfig: () => cfgNow });
  const a = await runtime.getProviderFor('m1');
  cfgNow = { baseUrl: 'http://endpoint-b/v1', apiKey: 'sk-abc' };
  const b = await runtime.getProviderFor('m1');
  assert.notEqual(a, b, 'P2：同模型不同 baseUrl 不得复用实例（否则正文/Key 仍发给旧端点）');
  assert.equal(runtime.stats().instances, 2, 'P2：两个出网配置应各占一个缓存键');
});

await t('P3 指纹含 baseUrl', () => {
  let cfgNow = { baseUrl: 'http://endpoint-a/v1', apiKey: 'sk-abc' };
  const { runtime } = makeRuntime({ resolveProviderConfig: () => cfgNow });
  const f1 = runtime.providerFingerprint('m1');
  cfgNow = { baseUrl: 'http://endpoint-b/v1', apiKey: 'sk-abc' };
  const f2 = runtime.providerFingerprint('m1');
  assert.notEqual(f1, f2, 'P3：baseUrl 必须进入出网指纹');
  assert.ok(f1.includes('http://endpoint-a/v1'), 'P3：指纹里必须能看出 baseUrl');
});

await t('P4 指纹含 apiKey 的 sha256 摘要（且不含明文）', () => {
  const { runtime } = makeRuntime({ resolveProviderConfig: () => ({ baseUrl: 'http://a/v1', apiKey: 'sk-very-secret' }) });
  const f = runtime.providerFingerprint('m1');
  const digest = crypto.createHash('sha256').update('sk-very-secret').digest('hex').slice(0, 16);
  assert.ok(f.includes(digest), 'P4：指纹必须包含 apiKey 的 sha256 摘要（前 16 位）');
  assert.equal(f.includes('sk-very-secret'), false, 'P4：指纹里不得出现 apiKey 明文');
});

await t('P5 指纹含 timeout 配置', () => {
  const { runtime, state } = makeRuntime({ resolveProviderConfig: () => ({ baseUrl: 'http://a/v1', apiKey: 'k' }) });
  const f1 = runtime.providerFingerprint('m1');
  state.cfg.timeout = { totalMs: 999999 };
  const f2 = runtime.providerFingerprint('m1');
  assert.notEqual(f1, f2, 'P5：timeout 配置必须进入出网指纹');
  assert.ok(f1.includes('120000'), 'P5：指纹里必须带 timeout 的 JSON');
});

console.log('\n[provider-cache · 代际与失效]');

await t('P6 invalidate 后代际 +1，旧实例不再复用', async () => {
  const { runtime, seen } = makeRuntime();
  await runtime.getProviderFor('m1');
  runtime.invalidateProviderCache('测试换代');
  assert.equal(runtime.stats().generation, 1, 'P6：invalidate 必须把代际加一');
  const b = await runtime.getProviderFor('m1');
  assert.equal(seen.createCfg.length, 2, 'P6：换代后必须重新创建实例（不得复用旧代际）');
  assert.equal(b.id, 2, 'P6：拿到的是新一代实例');
});

await t('P7 invalidate 同时清空实例缓存与探测备忘', async () => {
  const { runtime } = makeRuntime();
  await runtime.getProviderFor('m1');
  await runtime.ensureProbe('m2');
  const before = runtime.stats();
  assert.equal(before.instances, 1, 'P7：夹具应已有一个实例');
  assert.equal(before.probes, 2, 'P7：夹具应已有两条探测备忘（m1 建 provider 时预检过一次 + m2）');
  runtime.invalidateProviderCache('测试清空');
  const after = runtime.stats();
  assert.equal(after.instances, 0, 'P7：invalidate 必须清空 provider 实例缓存');
  assert.equal(after.probes, 0, 'P7：invalidate 必须同时清空探测备忘（旧端点结论不得套到新端点）');
});

await t('P8 创建期间配置变更 → 旧实例不写回缓存', async () => {
  /** @type {() => void} */
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  let n = 0;
  const { runtime, seen } = makeRuntime({
    createProvider: async (/** @type {any} */ c, /** @type {string} */ m) => {
      n += 1;
      const id = n;
      await gate;
      return { id };
    },
  });
  const p1 = runtime.getProviderFor('m1');
  await new Promise((r) => setImmediate(r)); // 让 createProvider 真正开始
  runtime.invalidateProviderCache('创建期间变更');
  release();
  const oldInstance = await p1;
  assert.equal(oldInstance.id, 1, 'P8：发起创建的任务仍应拿到它自己的实例');
  const fresh = await runtime.getProviderFor('m1');
  assert.equal(seen.createCfg.length, 2, 'P8：换代后新任务必须重新创建（不得命中旧实例）');
  assert.notEqual(fresh, oldInstance, 'P8：新任务不得拿到创建期间被换代的那份实例');
  assert.equal(runtime.stats().instances, 1, 'P8：旧代际实例不得写回缓存（缓存里只留新一代）');
});

await t('P9 探测备忘同代际命中（只探测一次）', async () => {
  const { runtime, seen } = makeRuntime();
  const a = await runtime.ensureProbe('m1');
  const b = await runtime.ensureProbe('m1');
  assert.equal(a, b, 'P9：同代际必须命中同一份探测备忘');
  assert.equal(seen.probeOpts.length, 1, 'P9：同代际内 probeEndpoint 只能调用一次');
  assert.equal(seen.probeOpts[0].timeoutMs, 15000, 'P9：单次探测上限必须是 15s');
});

await t('P10 换代后探测备忘失效（重新探测）', async () => {
  const { runtime, seen } = makeRuntime();
  await runtime.ensureProbe('m1');
  runtime.invalidateProviderCache('换代');
  await runtime.ensureProbe('m1');
  assert.equal(seen.probeOpts.length, 2, 'P10：换代后探测备忘必须失效并重新探测');
});

await t('P11 指纹变化（未显式 invalidate）也不得复用旧探测结论', async () => {
  let cfgNow = { baseUrl: 'http://a/v1', apiKey: 'key-1' };
  const { runtime, seen } = makeRuntime({ resolveProviderConfig: () => cfgNow });
  await runtime.ensureProbe('m1');
  cfgNow = { baseUrl: 'http://a/v1', apiKey: 'key-2' };
  await runtime.ensureProbe('m1');
  assert.equal(seen.probeOpts.length, 2, 'P11：指纹变化后探测备忘键必须不同（旧端点结论不能套新端点）');
});

await t('P12 预检 TTL 过期后重测', async () => {
  const { runtime, seen } = makeRuntime({ probeMemoUsable: (/** @type {any} */ memo) => probeMemoUsable(memo, Date.now() + 11 * 60 * 1000) });
  await runtime.ensureProbe('m1');
  await runtime.ensureProbe('m1');
  assert.equal(seen.probeOpts.length, 2, 'P12：备忘过期（模拟 11 分钟后）必须重测，不得原样重放旧结论');
});

await t('P13 预检失败只降级、不阻断 provider 创建', async () => {
  const { runtime } = makeRuntime({
    probeEndpoint: async () => {
      throw new Error('fetch failed（本地引擎没起来？）');
    },
  });
  const probe = await runtime.ensureProbe('m1');
  assert.equal(probe, null, 'P13：预检异常必须返回 null');
  const provider = await runtime.getProviderFor('m1');
  assert.ok(provider && provider.id, 'P13：预检失败不得阻断 provider 创建');
});

await t('P14 非本地模型不探测', async () => {
  const { runtime, seen } = makeRuntime({ isLocalBaseUrl: () => false, providerConfig: { baseUrl: 'https://api.example.com/v1', apiKey: 'k' } });
  const probe = await runtime.ensureProbe('remote');
  assert.equal(probe, null, 'P14：远程模型不预检');
  assert.equal(seen.probeOpts.length, 0, 'P14：远程模型不得触发 probeEndpoint');
});

await t('P15 预检自适应合入 createProvider 的 cfg（不改原 cfg）', async () => {
  const { runtime, state, seen } = makeRuntime({ adaptiveTimeouts: () => ({ firstTokenMs: 123456, basis: '测试' }) });
  await runtime.getProviderFor('m1');
  const got = seen.createCfg[0];
  assert.equal(got.timeout.firstTokenMs, 123456, 'P15：自适应首帧上限必须合入建实例用的 cfg');
  assert.notEqual(got, state.cfg, 'P15：不得原地修改共享 cfg（必须返回副本）');
  assert.equal(state.cfg.timeout.firstTokenMs, 60000, 'P15：共享 cfg 的 firstTokenMs 不得被改写');
});

console.log('\n[provider-cache · 容量与启动]');

await t('P16 provider 实例上限 32（淘汰最旧）', async () => {
  const { runtime } = makeRuntime();
  for (let i = 0; i < 40; i++) await runtime.getProviderFor(`model-${i}`);
  assert.ok(runtime.stats().instances <= 32, `P16：实例缓存必须封顶 32，实际 ${runtime.stats().instances}`);
});

await t('P17 探测备忘上限 50', async () => {
  const { runtime } = makeRuntime();
  for (let i = 0; i < 60; i++) await runtime.ensureProbe(`model-${i}`);
  assert.ok(runtime.stats().probes <= 50, `P17：探测备忘必须封顶 50，实际 ${runtime.stats().probes}`);
});

await t('P18 start() 预热：未配置 Key 告警 + 初始 provider + 日志观察者', async () => {
  let observer = null;
  const { runtime, seen } = makeRuntime({
    resolveProviderConfig: () => ({ baseUrl: 'http://a/v1', apiKey: '' }),
    setLocalQueueObserver: (/** @type {any} */ fn) => {
      observer = fn;
    },
  });
  const started = await runtime.start('m1');
  assert.ok(started.provider && started.provider.id, 'P18：start() 必须返回初始 provider');
  assert.equal(started.getProviderFor, runtime.getProviderFor, 'P18：start() 必须透出同一套缓存 API');
  assert.ok(seen.warn.some((l) => /未配置 m1 的 API Key/.test(l)), 'P18：缺 Key 必须告警（但不阻断启动）');
  assert.equal(typeof observer, 'function', 'P18：必须安装本地端点串行化观察者');
  observer({ text: '入队', label: 'm1' });
  assert.ok(seen.log.some((l) => l.includes('入队') && l.includes('（模型 m1）')), 'P18：观察者事件必须落到 log');
});

await t('P19 invalidate 的日志带代际与清空计数', async () => {
  const { runtime, seen } = makeRuntime();
  await runtime.getProviderFor('m1');
  await runtime.ensureProbe('m2');
  runtime.invalidateProviderCache('切 baseUrl');
  assert.ok(seen.log.some((l) => /provider 代际 1：切 baseUrl（清实例 1 \/ 预检备忘 \d+）/.test(l)), 'P19：换代日志必须写清原因与清空计数');
});

console.log(`\nprovider-cache：${passed} 项通过，${failed} 项失败`);
process.exit(failed ? 1 : 0);
