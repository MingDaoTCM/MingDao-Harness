// 模型名称以 API 实时返回的官方名为准（v0.6.19 §3.67）。
//
// 背景：负责人原话——「DeepSeek 官方已推出 DeepSeek-V4.1-Flash 1017，API 拉取到的也是该版本，
// 所以模型名称应该相应改为官方名称，或者一步到位，以后版本一律以 API 实时拉取到的官方名称为准，
// 不必在版本升级时再修改。」
//
// 本套件钉住五件事（与任务书 ①–⑤ 一一对应）：
//   ① API 返回 `DeepSeek-V4.1-Flash 1017` → 列表 / 选中 / 显示全部用该官方名；
//   ② 未知新版本（`DeepSeek-V4.2-Flash 1101`）→ 可选中、标「能力未知（新版本）」、不报错；
//   ③ API 只有 V4.1 时，默认 planner / executor 能按家族解析到官方名；
//   ④ 旧名 `deepseek-v4-flash` 作为兼容别名仍可用（能力/路由归一）；
//   ⑤ API 不可达 → 走内置家族代表名兜底，并明确提示「离线兜底：模型名可能不是最新的」。
//
// 运行：node test/model-names.js（失败非 0；不依赖真实外网——本地 stub /v1/models）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-modelnames-'));
process.env.MINGDAO_HOME = home;
// 隔离外部环境：只让 deepseek 有 Key（测试用假 Key，请求只发往本地 stub）。
for (const k of ['OPENAI_API_KEY', 'DASHSCOPE_API_KEY', 'ZHIPUAI_API_KEY', 'MOONSHOT_API_KEY', 'VLLM_API_KEY', 'OLLAMA_API_KEY', 'ONEAPI_API_KEY', 'MINGDAO_API_KEY']) {
  delete process.env[k];
}
process.env.DEEPSEEK_API_KEY = 'sk-test-modelnames';

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`  ✓ 断言[${name}]`);
};

// ---------- 本地 stub：模拟 DeepSeek 官方 GET /v1/models ----------
/** @type {string[]} */
let upstreamModels = [];
let upstreamModelsHits = 0;
let upstreamDown = false;
const upstream = http.createServer((req, res) => {
  const u = String(req.url || '');
  if (upstreamDown) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'stub down' }));
    return;
  }
  if (u === '/v1/models') {
    upstreamModelsHits += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: upstreamModels.map((id) => ({ id, object: 'model' })) }));
    return;
  }
  // 预检/聊天等其余路径：明确 404（probe 会把它当作"不可用"并继续，不影响断言）
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found in stub' }));
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upstreamBase = `http://127.0.0.1:${/** @type {any} */ (upstream.address()).port}/v1`;

/** @param {any} [extra] */
const makeCfg = (extra = {}) => ({ provider: 'deepseek', baseUrl: upstreamBase, permission: 'ask', sandbox: 'off', contextBudget: 128000, ...extra });

const { modelPreset, canonicalModel, familyRepresentative, pickFamilyModel, DEFAULT_MODEL, DEFAULT_PLANNER_MODEL, modelCapabilityUnknown } = await import(pathToFileURL(path.join(srcDir, 'models.js')).href);
const discovery = await import(pathToFileURL(path.join(srcDir, 'model-discovery.js')).href);
const { fetchProviderModels, availableModels, resolveDefaultModel, resolveRoutingDefaults, modelsCatalogNote, OFFLINE_MODEL_NOTE } = discovery;
const { saveConfig, ensureMinimalConfig } = await import(pathToFileURL(path.join(srcDir, 'config.js')).href);
const { runWebServer } = await import(pathToFileURL(path.join(srcDir, 'web', 'server.js')).href);

const OFFICIAL_FLASH = 'DeepSeek-V4.1-Flash 1017';
const OFFICIAL_PRO = 'DeepSeek-V4.1-Pro 1017';
const OFFICIAL_VISION = 'DeepSeek-V4.1-Flash-Vision 1017';
const NEWER_FLASH = 'DeepSeek-V4.2-Flash 1101';

/** 让 stub 返回指定名单并强制刷新到本地缓存。 */
async function prime(models) {
  upstreamModels = models;
  upstreamDown = false;
  const r = await fetchProviderModels(makeCfg(), 'deepseek', { force: true });
  assert.ok(Array.isArray(r.models) && r.models.length > 0, `stub /v1/models 应返回模型（实际：${JSON.stringify(r)}）`);
  return r;
}

try {
  // ================= ① 家族模式：API 官方名 → 能力/定价（不写死版本号） =================
  {
    const flash = modelPreset(OFFICIAL_FLASH);
    assert.ok(flash, 'API 官方名 DeepSeek-V4.1-Flash 1017 必须能解析出能力（家族模式匹配）');
    assert.equal(flash.family, 'flash', '官方名必须归入 flash 家族');
    assert.equal(flash.provider, 'deepseek', '官方名的服务商必须解析为 deepseek（否则请求会发错端点）');
    assert.equal(flash.contextWindow, 1000000, '官方名必须拿到 flash 家族上下文窗口');
    assert.equal(flash.pricing.offpeak.input, 1.5, '官方名必须拿到 flash 家族定价');
    assert.equal(flash.capabilityUnknown, false, 'V4.1 是已核对规格，不得标成能力未知');
    assert.equal(modelPreset(OFFICIAL_PRO).family, 'pro', 'V4.1-Pro 必须归入 pro 家族');
    assert.equal(modelPreset(OFFICIAL_VISION).supportsVision, true, 'V4.1-Flash-Vision 必须是视觉家族（不能被 flash 抢先匹配）');
    assert.equal(modelCapabilityUnknown(OFFICIAL_FLASH), false, '已核对版本不算能力未知');
    ok('① 家族模式解析 API 官方名（flash/pro/vision + 上下文/定价）');
  }

  // ================= ② 未知新版本：可选用 + 标「能力未知（新版本）」 =================
  {
    const newer = modelPreset(NEWER_FLASH);
    assert.ok(newer, 'API 返回的新版本不能被当成未知模型丢弃（要可按家族保守估算）');
    assert.equal(newer.family, 'flash', '新版本仍应命中 flash 家族模式');
    assert.equal(newer.capabilityUnknown, true, '比已核对规格新的版本必须标「能力未知（新版本）」');
    assert.ok(String(newer.label).includes('能力未知'), '新版本标签必须写明「能力未知（新版本）」');
    assert.equal(newer.pricing.offpeak.input, 1.5, '新版本仍按家族定价估算（不能静默变成无法估算）');
    assert.equal(modelPreset('brand-new-model-2026'), null, '完全不属于任何家族的名字仍应识别为"不认识"');
    ok('② 未知新版本可解析、标能力未知、不拒绝');
  }

  // ================= ③ 默认值运行时解析：API 只有 V4.1 时解析到 V4.1 =================
  {
    await prime([OFFICIAL_PRO, OFFICIAL_FLASH, OFFICIAL_VISION]);
    const planner = await resolveDefaultModel(makeCfg(), 'planner');
    const executor = await resolveDefaultModel(makeCfg(), 'executor');
    assert.equal(planner.model, OFFICIAL_PRO, '默认 planner 必须从 API 列表解析出 pro 家族官方名');
    assert.equal(planner.source, 'api', '默认 planner 的来源必须是 API（不是写死的版本）');
    assert.equal(planner.fallback, false, 'API 有对应家族时不应走兜底');
    assert.equal(executor.model, OFFICIAL_FLASH, '默认 executor 必须从 API 列表解析出 flash 家族官方名（视觉变体不算）');
    assert.equal(executor.source, 'api', '默认 executor 的来源必须是 API（不是写死的版本）');
    assert.equal(executor.fallback, false, 'API 有对应家族时不应走兜底');
    assert.notEqual(planner.model, DEFAULT_PLANNER_MODEL, 'API 可解析时不得回退到内置代表名');

    const routing = await resolveRoutingDefaults(makeCfg());
    assert.equal(routing.planner.model, OFFICIAL_PRO, '路由默认 planner 必须用 API 官方名');
    assert.equal(routing.executor.model, OFFICIAL_FLASH, '路由默认 executor 必须用 API 官方名');

    // 显式配置优先：用户写下的 planner 不被 API 名单覆盖
    const explicit = await resolveDefaultModel(makeCfg({ routing: { enabled: true, planner: 'my-own-planner' } }), 'planner');
    assert.equal(explicit.model, 'my-own-planner', '显式 config.routing.planner 必须优先于 API 名单');
    assert.equal(explicit.source, 'config', '显式配置的来源应标为 config');

    // 新建配置（ensureMinimalConfig）也必须用缓存里的 API 官方名，而不是写死的版本
    fs.rmSync(path.join(home, 'config.json'), { force: true });
    const minimal = ensureMinimalConfig();
    assert.equal(minimal.model, OFFICIAL_FLASH, '新配置默认模型必须用 API 官方名（不能写死版本号）');
    fs.rmSync(path.join(home, 'config.json'), { force: true });

    // 多个版本并存时取 API 列表里的最高版本官方名（版本升级不需要改代码）
    await prime([OFFICIAL_FLASH, NEWER_FLASH]);
    const newest = await resolveDefaultModel(makeCfg(), 'executor');
    assert.equal(newest.model, NEWER_FLASH, 'API 同时返回 V4.1/V4.2 时应取最高版本的官方名');
    assert.equal(newest.family, 'flash', '最高版本仍按家族解析');
    await prime([OFFICIAL_PRO, OFFICIAL_FLASH, OFFICIAL_VISION]);
    ok('③ 默认 planner/executor 运行时从 API 官方名解析（显式配置优先 + 新配置生效）');
  }

  // ================= ④ 旧名别名仍可用 =================
  {
    const legacy = 'deepseek-v4-flash';
    const preset = modelPreset(legacy);
    assert.ok(preset, '旧名 deepseek-v4-flash 必须仍能解析（老配置/历史会话不能 404）');
    assert.equal(preset.family, 'flash', '旧名必须归入 flash 家族并沿用同一套能力/定价');
    assert.equal(canonicalModel(legacy), DEFAULT_MODEL, '旧名必须归一到家族代表名（否则自动路由会静默失效）');
    assert.equal(canonicalModel(OFFICIAL_FLASH), DEFAULT_MODEL, 'API 官方名也必须与旧名归一（路由池比较用）');
    const { resolveProviderConfig } = await import(pathToFileURL(path.join(srcDir, 'providers', 'index.js')).href);
    assert.equal(resolveProviderConfig(makeCfg({ model: legacy }), legacy).name, 'deepseek', '旧名的服务商仍必须解析为 deepseek');

    // 列表展示：API 名单里的官方名 + 旧名都能被"选中"（服务端校验放行）
    const list = await availableModels(makeCfg(), legacy);
    assert.ok(list.some((m) => m.name === OFFICIAL_FLASH), '列表必须用 API 官方名（旧名不能把官方名挤掉）');
    ok('④ 旧名 deepseek-v4-flash 作为别名仍可用（能力/路由/服务商归一）');
  }

  // ================= ⑤ WebUI：列表/选中/显示用官方名；未知新版本可选中 =================
  {
    await prime([OFFICIAL_PRO, OFFICIAL_FLASH, OFFICIAL_VISION]);
    saveConfig({ provider: 'deepseek', baseUrl: upstreamBase, model: OFFICIAL_FLASH, permission: 'ask', sandbox: 'off', contextBudget: 128000 });
    const srv = await runWebServer({ host: '127.0.0.1', port: 0, authToken: null });
    const base = `http://127.0.0.1:${/** @type {any} */ (srv.address()).port}`;
    const get = async (p) => {
      const r = await fetch(base + p);
      return { status: r.status, j: await r.json().catch(() => ({})) };
    };
    const post = async (p, body) => {
      const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, j: await r.json().catch(() => ({})) };
    };
    try {
      const models = await get('/api/models');
      assert.equal(models.status, 200, '/api/models 应 200');
      assert.ok(Array.isArray(models.j.models), '/api/models 必须返回模型列表');
      const entry = models.j.models.find((m) => m.name === OFFICIAL_FLASH);
      assert.ok(entry, '列表必须使用 API 返回的官方名（DeepSeek-V4.1-Flash 1017）');
      assert.ok(String(entry.label).startsWith(OFFICIAL_FLASH), '列表标签必须以前端官方名开头（id/显示名一致）');
      assert.equal(entry.capabilityUnknown, false, '已核对版本的列表条目不应标能力未知');
      assert.equal(entry.offlineFallback, false, 'API 可达时不得标离线兜底');
      assert.equal(models.j.defaultPlanner, OFFICIAL_PRO, '/api/models 的默认 planner 必须是 API 官方名');
      assert.equal(models.j.defaultExecutor, OFFICIAL_FLASH, '/api/models 的默认 executor 必须是 API 官方名');
      assert.equal(models.j.offlineFallback, false, 'API 可达时 offlineFallback 必须为 false');

      // 选中官方名 → 回读仍是官方名（不因为不在精确表里就拒绝/改名）
      const pickOfficial = await post('/api/config', { model: OFFICIAL_FLASH });
      assert.equal(pickOfficial.status, 200, '选中 API 官方名必须成功（不能报未知模型）');
      assert.equal(pickOfficial.j.model, OFFICIAL_FLASH, '选中后必须保持 API 官方名原样');

      // 未知新版本：先让它出现在 API 名单，再选中——必须 200 且标能力未知
      await prime([OFFICIAL_PRO, OFFICIAL_FLASH, OFFICIAL_VISION, NEWER_FLASH]);
      const pickNewer = await post('/api/config', { model: NEWER_FLASH });
      assert.equal(pickNewer.status, 200, 'API 返回的新版本必须能选中（不得报未知模型/拒绝）');
      assert.equal(pickNewer.j.model, NEWER_FLASH, '选中新版本后必须原样保存 API 官方名');
      const state = await get('/api/state');
      assert.equal(state.j.model, NEWER_FLASH, '新版本选中后 /api/state 必须回读该官方名');
      const newerEntry = state.j.models.find((m) => m.name === NEWER_FLASH);
      assert.ok(newerEntry, '新版本必须出现在模型列表里');
      assert.equal(newerEntry.capabilityUnknown, true, '新版本列表条目必须标「能力未知（新版本）」');
      assert.ok(String(state.j.modelsNote || '').includes('能力未知'), '新版本时界面提示必须说明能力未知');

      // 完全不属于任何家族的新模型（模式表不认识）：同样必须能选中，不能报错/拒绝
      const UNKNOWN_FAMILY = 'DeepSeek-V5-Ultra 1201';
      await prime([OFFICIAL_PRO, OFFICIAL_FLASH, OFFICIAL_VISION, NEWER_FLASH, UNKNOWN_FAMILY]);
      const pickUnknown = await post('/api/config', { model: UNKNOWN_FAMILY });
      assert.equal(pickUnknown.status, 200, '模式表不认识的新模型也必须能选中（API 名单里有就不得拒绝）');
      const stUnknown = await get('/api/state');
      const unknownEntry = stUnknown.j.models.find((m) => m.name === UNKNOWN_FAMILY);
      assert.ok(unknownEntry, '模式表不认识的新模型必须出现在列表里');
      assert.equal(unknownEntry.capabilityUnknown, true, '模式表不认识的新模型必须标「能力未知（新版本）」');
      assert.ok(String(unknownEntry.label).includes('能力未知'), '模式表不认识的新模型标签必须写明能力未知');

      // 旧名仍可选中
      const pickLegacy = await post('/api/config', { model: 'deepseek-v4-flash' });
      assert.equal(pickLegacy.status, 200, '旧名作为别名必须仍可选中（老配置兼容）');

      // 开启自动路由：默认 planner/executor 用 API 官方名
      const routing = await post('/api/config', { routing: true });
      assert.equal(routing.status, 200, '开启自动路由应成功');
      const stR = await get('/api/state');
      assert.equal(stR.j.routing?.planner, OFFICIAL_PRO, '路由默认 planner 必须是 API 官方名（不得写死版本）');
      // 此时 API 同时返回 V4.1/V4.2：默认取列表里的最高版本官方名（与 /api/models 的取值规则一致）
      assert.equal(stR.j.routing?.executor, NEWER_FLASH, '路由默认 executor 必须取 API 列表里的最高版本官方名（不得写死版本）');
      ok('⑤ WebUI 列表/选中/显示用官方名；未知新版本可选中并标能力未知');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  }

  // ================= ⑥ 自定义端点：不得主动探测 GET /models（只实现 chat 的网关很多） =================
  {
    // 回归来源（B 在干净 worktree 复现）：WebUI 打开自动路由/删除自定义模型时，默认值解析
    // 会对 provider='custom' 发 GET /models；很多自定义网关只实现 chat，收到空 body 请求
    // 直接 JSON.parse 崩（e2e-web 的 mock 就是这样）。既有策略是 custom 端点数**不**主动探测。
    const before = upstreamModelsHits;
    const customCfg = { provider: 'custom', baseUrl: upstreamBase, model: 'my-custom-app' };
    const defaults = await resolveRoutingDefaults(customCfg);
    assert.equal(upstreamModelsHits, before, '自定义端点收到 GET /models 的次数必须为 0（不得主动探测）');
    assert.equal(defaults.planner.model, familyRepresentative('pro'), '自定义端点的默认 planner 用家族代表名兜底（不发请求）');
    assert.equal(defaults.executor.model, familyRepresentative('flash'), '自定义端点的默认 executor 用家族代表名兜底（不发请求）');
    assert.ok(String(defaults.note || '').includes('不主动探测'), '自定义端点的兜底提示必须说明"不主动探测 /models"');
    // 显式配置仍优先：自定义端点自己的模型名不会被家族代表名覆盖
    const explicitCustom = await resolveDefaultModel({ ...customCfg, routing: { enabled: true, planner: 'custom-planner', executor: 'custom-executor' } }, 'planner');
    assert.equal(explicitCustom.model, 'custom-planner', '自定义端点显式 config.routing.planner 必须优先');
    assert.equal(upstreamModelsHits, before, '显式配置解析也不得触发任何 /models 探测');
    ok('⑥ 自定义端点 0 次 GET /models 探测（含显式配置优先）');
  }

  // ================= ⑦ 离线兜底：明确提示「模型名可能不是最新的」 =================
  {
    // 新 home：确保没有上一节的模型缓存；服务商 baseUrl 指向必然拒绝的端口。
    const offlineHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-modelnames-offline-'));
    process.env.MINGDAO_HOME = offlineHome;
    const offlineCfg = { provider: 'deepseek', baseUrl: 'http://127.0.0.1:1/v1', permission: 'ask', sandbox: 'off', contextBudget: 128000 };
    const failed = await fetchProviderModels(offlineCfg, 'deepseek', { force: true });
    assert.ok(failed.error, '离线场景：/v1/models 必须返回 error');

    const list = await availableModels(offlineCfg, null);
    assert.ok(list.length > 0, '离线时必须回退到内置家族代表名（不能空列表）');
    assert.ok(list.every((m) => m.offlineFallback === true), '离线回退的每个条目都必须标 offlineFallback');
    assert.ok(list.every((m) => String(m.label).includes('离线兜底')), '离线列表标签必须写明「离线兜底」');
    const note = modelsCatalogNote(list);
    assert.ok(note && note.includes('离线兜底'), '离线时必须给出「离线兜底」提示');
    assert.ok(note.includes('不是最新'), '离线提示必须说明「模型名可能不是最新的」');

    const d = await resolveDefaultModel(offlineCfg, 'executor', { force: true });
    assert.equal(d.fallback, true, '离线时默认模型必须标 fallback=true');
    assert.equal(d.offline, true, '离线时默认模型必须标 offline=true');
    assert.equal(d.model, familyRepresentative('flash'), '离线时退回家族代表名（不得凭空编造版本）');
    assert.ok(String(d.note).includes('离线兜底'), '离线默认值必须带「离线兜底」提示');
    assert.equal(d.note, OFFLINE_MODEL_NOTE, '离线提示必须是统一文案（不许各处各写一份）');

    // 界面入口也要能拿到提示（banner 可读字段）
    saveConfig({ provider: 'deepseek', baseUrl: 'http://127.0.0.1:1/v1', model: familyRepresentative('flash'), permission: 'ask', sandbox: 'off', contextBudget: 128000 });
    const srv2 = await runWebServer({ host: '127.0.0.1', port: 0, authToken: null });
    const base2 = `http://127.0.0.1:${/** @type {any} */ (srv2.address()).port}`;
    try {
      const r = await fetch(base2 + '/api/models');
      const j = await r.json();
      assert.equal(r.status, 200, '离线时 /api/models 仍应可访问');
      assert.equal(j.offlineFallback, true, '离线时 /api/models 必须标 offlineFallback=true');
      assert.ok(String(j.note).includes('离线兜底'), '离线时 /api/models 的 note 必须包含「离线兜底」提示');
      assert.ok(String(j.note).includes('不是最新'), '离线时 /api/models 的 note 必须说明模型名可能不是最新的');
    } finally {
      await new Promise((r) => srv2.close(r));
    }
    fs.rmSync(offlineHome, { recursive: true, force: true });
    process.env.MINGDAO_HOME = home;
    ok('⑦ 离线兜底走家族代表名并明确提示「模型名可能不是最新的」');
  }

  // 守卫：默认值必须是家族代表名派生，不能在 models.js 之外维护具体版本号
  assert.ok(DEFAULT_MODEL && DEFAULT_PLANNER_MODEL, '默认值常量仍必须存在（兼容既有调用点）');
  assert.equal(pickFamilyModel([OFFICIAL_FLASH, OFFICIAL_VISION], 'flash'), OFFICIAL_FLASH, 'flash 家族挑选必须排除视觉变体');

  console.log(`\n模型名称套件：${passed} 组断言全部通过`);
  upstream.close();
  process.exit(0);
} catch (/** @type {any} */ e) {
  console.error(`\n✗ 模型名称套件失败：${e?.stack || e}`);
  try {
    upstream.close();
  } catch {}
  process.exit(1);
}
