// 更新线路选择（香港 / 深圳）的独立回归套件（v0.9.2）。
//
// 背景（用户实测）：v0.9.1 及以前，deb feed / deb 安装包 / `.sig` / electron-updater 的 feed
// 全部固定走香港 `harness.mingdao.ai`——"会根据位置自动选择深圳还是香港"根本没实现。
// v0.9.2 新增 desktop/endpoint.js（纯函数 + **注入式**探测），main.js 只做真实 TTFB 探测与
// `endpoint.json` 读写；选中的 base 应用于每一条通道。
//
// 本套件固定住的是**纯逻辑边界 + 源码接线**（零网络、零 electron）：
//   ① 候选列表（hk/sz 的 base 必须与文档一致）；
//   ② normalizeBase / joinPath / updatesBase / downloadsBase / probeTarget / downloadPageUrl 的 URL 拼接；
//   ③ 探测排序（注入假 probe：按 TTFB 升序、平局按候选顺序、失败项被过滤）；
//   ④ 线路选择主入口：env 覆盖 → 24h 缓存 → 实时探测 → 全失败回退香港；
//   ⑤ 缓存读写/过期/坏数据；
//   ⑥ 镜像缺文件的香港回退链（isMirrorMiss / fallbackChain）；
//   ⑦ main.js 接线绊线：endpoint.json、MINGDAO_UPDATE_BASE、空闲超时、pkexec 探测、标题进度、
//      setFeedURL、desktop.log、stage=…；
//   ⑧ 纯函数层不联网 / 不 import electron（否则本套件不再"零网络"）。
//
// 诚实边界：真实 TTFB 与"哪条线路更快"只能真机测（macOS/CI 的网络位置不代表目标用户）；
// 本套件只证明**决策逻辑**与**接线**正确，真机验收清单见 desktop/README.md。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = await import(pathToFileURL(path.join(root, 'desktop', 'endpoint.js')).href);
const endpointSrc = fs.readFileSync(path.join(root, 'desktop', 'endpoint.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8');
const builderYml = fs.readFileSync(path.join(root, 'desktop', 'electron-builder.yml'), 'utf8');

let passed = 0;
const ok = (/** @type {string} */ name) => { passed += 1; console.log(`  ✓ ${name}`); };

const HK = 'https://harness.mingdao.ai';
const SZ = 'https://harness.southdns.com';
const NOW = 1_800_000_000_000; // 固定时间戳（避免测试依赖真实时钟）

// ---------- ① 候选列表 ----------
{
  assert.equal(E.ENDPOINT_CANDIDATES.length, 2, '候选线路必须正好两条（香港 / 深圳）');
  assert.deepEqual(
    E.ENDPOINT_CANDIDATES.map((c) => [c.id, c.base]),
    [['hk', HK], ['sz', SZ]],
    '候选 id/base 必须与文档一致（hk=harness.mingdao.ai、sz=harness.southdns.com）'
  );
  assert.equal(new Set(E.ENDPOINT_CANDIDATES.map((c) => c.base)).size, 2, '两条候选的 base 不得重复');
  assert.equal(E.DEFAULT_ENDPOINT.id, 'hk', '默认线路必须是香港（官方源站）');
  assert.equal(E.DEFAULT_ENDPOINT.base, HK);
  assert.equal(E.DEFAULT_ENDPOINT_ID, 'hk');
  assert.equal(E.PROBE_PATH, '/updates/latest.yml', '探测目标必须是两边都提供的静态小文件');
  assert.equal(E.PROBE_TIMEOUT_MS, 3000, '探测超时必须是 3s（跨海链路再慢也不该拖住启动）');
  assert.equal(E.CACHE_TTL_MS, 24 * 60 * 60 * 1000, '线路缓存必须 24h');
  assert.equal(E.CACHE_FILE, 'endpoint.json', '缓存文件名必须是 endpoint.json（main.js 拼 userData）');
  assert.equal(E.UPDATE_BASE_ENV, 'MINGDAO_UPDATE_BASE', 'env 覆盖变量名必须是 MINGDAO_UPDATE_BASE');
  assert.ok(Object.isFrozen(E.ENDPOINT_CANDIDATES), '候选列表必须冻结（不许运行期被改）');
  ok('① 候选列表：hk/sz 两条、base 精确、默认香港、探测 3s / 缓存 24h / env 名固定');
}

// ---------- ② normalizeBase：去尾斜杠与非法输入 ----------
{
  assert.equal(E.normalizeBase('https://harness.mingdao.ai/'), HK, '尾斜杠必须去掉');
  assert.equal(E.normalizeBase('https://harness.mingdao.ai///'), HK, '连写尾斜杠也必须去干净');
  assert.equal(E.normalizeBase('  https://harness.mingdao.ai  '), HK, '两侧空白必须去掉');
  assert.equal(E.normalizeBase(SZ + '/'), SZ);
  assert.equal(E.normalizeBase(SZ), SZ);
  assert.equal(E.normalizeBase('https://h.example/mirror/'), 'https://h.example/mirror', '路径前缀保留（不吞 /mirror）');
  for (const bad of ['', '   ', 'harness.southdns.com', '/updates/', 'javascript:alert(1)', 'ftp://h', 'https://h/?a=1', 'https://h/#x']) {
    assert.equal(E.normalizeBase(bad), '', `非法 base（${JSON.stringify(bad)}）必须返回空串，不能拼出相对 URL`);
  }
  assert.equal(E.normalizeBase(/** @type {any} */ (null)), '', 'null 必须返回空串');
  ok('② normalizeBase：去尾斜杠/空白、保留路径前缀、拒绝相对/非 http(s)/带 query 或 hash');
}

// ---------- ③ URL 拼接：base 去尾斜杠 ----------
{
  assert.equal(E.joinPath(HK, '/updates/latest.yml'), HK + '/updates/latest.yml', '带前导斜杠的路径不能拼出双斜杠');
  assert.equal(E.joinPath(HK + '/', 'updates/latest.yml'), HK + '/updates/latest.yml');
  assert.equal(E.joinPath(SZ, '/downloads/'), SZ + '/downloads/', '目录路径必须保留尾斜杠');
  assert.equal(E.joinPath('', '/updates/'), '', 'base 非法 → 空串（绝不拼出相对地址）');
  assert.equal(E.updatesBase(HK + '///'), HK + '/updates/', 'feed 目录：base 去尾斜杠后补 /updates/');
  assert.equal(E.downloadsBase(SZ), SZ + '/downloads/', '下载目录：跟随选中线路');
  assert.equal(E.probeTarget(SZ + '/'), SZ + '/updates/latest.yml', '探测 URL = base + 小文件');
  assert.equal(E.downloadPageUrl(SZ), SZ + '/#downloads', '「去官网下载」也要按选中线路');
  assert.equal(E.downloadPageUrl(''), HK + '/#downloads', 'base 非法时回退官方下载页（按钮永远可用）');
  ok('③ URL 拼接：joinPath/updatesBase/downloadsBase/probeTarget/downloadPageUrl（base 去尾斜杠）');
}

// ---------- ④ 探测：注入假 probe，逐条测量、失败不拖累其它条 ----------
{
  /** @type {string[]} */
  const seen = [];
  /** @type {Array<{timeoutMs: number}>} */
  const options = [];
  const fakeProbe = async (/** @type {string} */ url, /** @type {{timeoutMs: number}} */ opts) => {
    seen.push(url);
    options.push(opts);
    if (url.startsWith(SZ)) return { ms: 42, status: 200 };
    return { ms: 180, status: 200 };
  };
  const results = await E.probeCandidates({ probe: fakeProbe });
  assert.equal(results.length, 2, '每条候选都要有一条探测结果');
  assert.deepEqual(seen.sort(), [HK + '/updates/latest.yml', SZ + '/updates/latest.yml'].sort(), '探测必须打各候选的 /updates/latest.yml');
  assert.ok(options.every((o) => o.timeoutMs === E.PROBE_TIMEOUT_MS), '必须把 3s 超时传给 probe');
  const sz = results.find((r) => r.id === 'sz');
  const hk = results.find((r) => r.id === 'hk');
  assert.equal(sz?.ok, true);
  assert.equal(sz?.ms, 42);
  assert.equal(hk?.ok, true);
  assert.equal(hk?.ms, 180);

  const partial = await E.probeCandidates({
    probe: async (/** @type {string} */ url) => {
      if (url.startsWith(SZ)) throw Object.assign(new Error('HTTP 404'), { status: 404 });
      return { ms: 90, status: 200 };
    },
  });
  const szFail = partial.find((r) => r.id === 'sz');
  assert.equal(szFail?.ok, false, '单条探测失败必须标记 ok=false，而不是整体抛错');
  assert.match(String(szFail?.reason), /404/, '失败原因必须带上 HTTP 状态（排障要看）');
  assert.equal(partial.find((r) => r.id === 'hk')?.ok, true, '一条失败不能拖累另一条');
  await assert.rejects(() => E.probeCandidates(/** @type {any} */ ({})), /probe/, '没有注入 probe 必须显式报错（不静默跳过探测）');
  ok('④ probeCandidates：并发逐条探测、3s 超时传参、单条失败隔离、缺 probe 显式报错');
}

// ---------- ⑤ 排序：TTFB 升序 / 平局按候选顺序 / 过滤无效项 ----------
{
  const ranked = E.rankProbes([
    { id: 'hk', base: HK, ok: true, ms: 180 },
    { id: 'sz', base: SZ, ok: true, ms: 42 },
  ]);
  assert.deepEqual(ranked.map((r) => r.id), ['sz', 'hk'], '必须按 TTFB 升序（深圳 42ms 快于香港 180ms）');
  const tie = E.rankProbes([
    { id: 'sz', base: SZ, ok: true, ms: 100 },
    { id: 'hk', base: HK, ok: true, ms: 100 },
  ]);
  assert.deepEqual(tie.map((r) => r.id), ['hk', 'sz'], '耗时相同必须按候选声明顺序（稳定，不随机）');
  const filtered = E.rankProbes([
    { id: 'hk', base: HK, ok: false, ms: null },
    { id: 'sz', base: SZ, ok: true, ms: 50 },
    { id: 'hk', base: HK, ok: true, ms: -1 },
    { id: 'hk', base: HK, ok: true, ms: /** @type {any} */ ('abc') },
  ]);
  assert.deepEqual(filtered.map((r) => r.id), ['sz'], '失败/负数/非数字耗时必须被过滤（不能把坏数据当最快）');
  assert.deepEqual(E.rankProbes([]), [], '空结果 → 空（调用方据此回退香港）');
  ok('⑤ rankProbes：按 TTFB 升序、平局按候选顺序、过滤失败/非法耗时');
}

// ---------- ⑥ pickBase：最快一条 / 无可用返回 null ----------
{
  const picked = E.pickBase([
    { id: 'hk', base: HK, ok: true, ms: 210 },
    { id: 'sz', base: SZ, ok: true, ms: 60 },
  ]);
  assert.deepEqual(picked, { id: 'sz', base: SZ, ms: 60, source: 'probe' }, 'pickBase 必须返回最快线路并标注 source=probe');
  assert.equal(E.pickBase([{ id: 'hk', base: HK, ok: false, ms: null }]), null, '没有可用结果必须返回 null（由主入口回退香港）');
  assert.equal(E.pickBase([]), null);
  const byIdOnly = E.pickBase([{ id: 'sz', ok: true, ms: 15 }]);
  assert.equal(byIdOnly?.base, SZ, '结果里缺 base 时按候选表补齐（不能返回空 base）');
  ok('⑥ pickBase：最快线路 / 缺 base 时按候选表补齐 / 无可用返回 null');
}

// ---------- ⑦ 主入口：env 覆盖（不探测、不写缓存） ----------
{
  let probed = 0;
  const env = await E.selectEndpoint({
    envBase: ' https://harness.southdns.com/ ',
    cache: JSON.stringify(E.buildCacheRecord({ id: 'hk', base: HK, ms: 10, now: NOW })),
    now: NOW,
    probe: async () => { probed += 1; return { ms: 1, status: 200 }; },
  });
  assert.equal(env.source, 'env', 'env 覆盖必须优先于缓存与探测');
  assert.equal(env.id, 'sz', 'env 指向深圳时 id 必须识别为 sz（日志 endpoint=sz）');
  assert.equal(env.base, SZ, 'env 的 base 必须被规范化（去尾斜杠）');
  assert.equal(probed, 0, 'env 覆盖时必须**不探测**（排障场景不能多等一轮）');
  assert.equal(env.cacheRecord, null, 'env 覆盖不得污染 24h 缓存');
  const custom = await E.selectEndpoint({ envBase: 'https://update.example/mirror', now: NOW, probe: async () => ({ ms: 1 }) });
  assert.equal(custom.source, 'env');
  assert.equal(custom.id, 'env', '非候选的自定义 base 用 id=env 标注（日志仍可见）');
  assert.equal(custom.base, 'https://update.example/mirror');
  const ignored = await E.selectEndpoint({
    envBase: 'not a url',
    now: NOW,
    cache: JSON.stringify(E.buildCacheRecord({ id: 'sz', base: SZ, ms: 20, now: NOW })),
    probe: null,
  });
  assert.equal(ignored.source, 'cache', '非法 env 值必须被忽略（回落到缓存），不能拼出相对 URL');
  assert.equal(ignored.base, SZ);
  ok('⑦ selectEndpoint：env 覆盖优先 / 不探测 / 不写缓存；非法 env 被忽略；自定义 base 标 id=env');
}

// ---------- ⑧ 主入口：24h 缓存命中（不再探测） ----------
{
  let probed = 0;
  const cache = JSON.stringify(E.buildCacheRecord({ id: 'sz', base: SZ, ms: 33, now: NOW - 60 * 60 * 1000 }));
  const hit = await E.selectEndpoint({
    cache,
    now: NOW,
    probe: async () => { probed += 1; return { ms: 5, status: 200 }; },
  });
  assert.equal(hit.source, 'cache', '1 小时前的缓存必须命中（24h 内）');
  assert.equal(hit.id, 'sz');
  assert.equal(hit.base, SZ);
  assert.equal(hit.ms, 33, '缓存命中要带回上次的探测耗时');
  assert.equal(probed, 0, '缓存命中时**不得再探测**（每次启动多花 3s 是退化）');
  assert.equal(hit.cacheRecord, null, '缓存命中不需要重写缓存文件');
  ok('⑧ selectEndpoint：24h 缓存命中、带回耗时、不重复探测');
}

// ---------- ⑨ 主入口：缓存过期 → 重新探测并产出新缓存记录 ----------
{
  let probed = 0;
  const stale = JSON.stringify(E.buildCacheRecord({ id: 'hk', base: HK, ms: 300, now: NOW - 25 * 60 * 60 * 1000 }));
  const fresh = await E.selectEndpoint({
    cache: stale,
    now: NOW,
    probe: async (/** @type {string} */ url) => { probed += 1; return { ms: url.startsWith(SZ) ? 40 : 200, status: 200 }; },
  });
  assert.equal(probed, 2, '25 小时前的缓存必须过期并重新探测两条候选');
  assert.equal(fresh.source, 'probe');
  assert.equal(fresh.id, 'sz', '重新探测后必须选最快的深圳');
  assert.ok(fresh.cacheRecord, '实时探测成功必须产出可写盘的新缓存记录');
  assert.equal(fresh.cacheRecord?.id, 'sz');
  assert.equal(fresh.cacheRecord?.probedAt, NOW, '缓存时间戳必须是本次探测时间');
  assert.equal(fresh.cacheRecord?.v, E.CACHE_VERSION, '缓存结构必须带版本号（结构变更时作废旧缓存）');
  ok('⑨ selectEndpoint：缓存过期（>24h）→ 重新探测 → 产出新缓存记录（带版本/时间戳）');
}

// ---------- ⑩ 主入口：全部探测失败 → 回退香港、不写缓存 ----------
{
  const failed = await E.selectEndpoint({
    now: NOW,
    probe: async () => { throw new Error('ENOTFOUND'); },
  });
  assert.equal(failed.source, 'fallback', '两条都探测失败必须走 fallback');
  assert.equal(failed.id, 'hk', '回退线路必须是香港');
  assert.equal(failed.base, HK);
  assert.equal(failed.probes.length, 2, '失败也要保留两条探测明细（日志/排障要看）');
  assert.ok(failed.probes.every((/** @type {any} */ p) => p.ok === false), '失败明细必须如实标 ok=false');
  assert.equal(failed.cacheRecord, null, '全失败**不得**写缓存——否则把"没测出"缓存 24h，线路永远修不回来');
  const noProbe = await E.selectEndpoint({ now: NOW, probe: null, cache: '' });
  assert.equal(noProbe.source, 'fallback', '没有 probe 注入时也必须回退香港（不抛错）');
  assert.equal(noProbe.base, HK);
  ok('⑩ selectEndpoint：全失败回退香港（保留明细、不写缓存）；无 probe 也不抛错');
}

// ---------- ⑪ 缓存读写/解析/过期边界 ----------
{
  const rec = E.buildCacheRecord({ id: 'sz', base: SZ + '/', ms: 12.5, now: NOW });
  assert.deepEqual(rec, { v: E.CACHE_VERSION, id: 'sz', base: SZ, ms: 12.5, probedAt: NOW }, '缓存记录形状固定（base 规范化、ms 保留小数）');
  const roundTrip = E.parseEndpointCache(JSON.stringify(rec));
  assert.deepEqual(roundTrip, rec, 'JSON 往返必须无损');
  assert.equal(E.parseEndpointCache('{not json'), null, '坏 JSON → null（当作没缓存，重新探测）');
  assert.equal(E.parseEndpointCache(JSON.stringify({ ...rec, v: 99 })), null, '版本不符 → null');
  assert.equal(E.parseEndpointCache(JSON.stringify({ ...rec, base: 'file:///etc/passwd' })), null, '非 http(s) base → null');
  assert.equal(E.parseEndpointCache(JSON.stringify({ ...rec, base: 'https://retired.example' })), null, '已下线线路（不在候选表）→ null');
  assert.equal(E.parseEndpointCache(JSON.stringify({ ...rec, id: 'hk' })), null, 'id 与 base 不一致（缓存被改坏）→ null');
  assert.equal(E.parseEndpointCache(JSON.stringify({ ...rec, ms: -5 })), null, '负数耗时 → null');
  assert.equal(E.parseEndpointCache(JSON.stringify({ ...rec, probedAt: 0 })), null, '时间戳非法 → null');
  assert.equal(E.parseEndpointCache(/** @type {any} */ (null)), null);
  assert.throws(() => E.buildCacheRecord(/** @type {any} */ ({ id: '', base: '', ms: 1 })), /id|base/, '构造缓存记录缺字段必须抛错');
  assert.equal(E.isCacheFresh(rec, { now: NOW + 12 * 60 * 60 * 1000 }), true, '12h < 24h → 新鲜');
  assert.equal(E.isCacheFresh(rec, { now: NOW + 23.9 * 60 * 60 * 1000 }), true, '23.9h → 新鲜');
  assert.equal(E.isCacheFresh(rec, { now: NOW + 24 * 60 * 60 * 1000 }), false, '整 24h → 过期');
  assert.equal(E.isCacheFresh(rec, { now: NOW - 60_000 }), true, '时间戳在未来（时钟回拨）按新鲜处理，不能反复探测');
  assert.equal(E.isCacheFresh(null), false, '没有缓存 → 不新鲜');
  ok('⑪ 缓存：记录形状/JSON 往返/坏数据（坏 JSON、版本、线路、耗时、时间戳）→ null；24h 过期边界');
}

// ---------- ⑫ 镜像缺文件 → 香港回退链 ----------
{
  assert.deepEqual(E.fallbackChain(HK), [HK], '香港本身没有第二跳（不重复自己）');
  assert.deepEqual(E.fallbackChain(SZ + '/'), [SZ, HK], '深圳后面必须跟香港（去尾斜杠、去重）');
  assert.deepEqual(E.fallbackChain(SZ + '///'), [SZ, HK]);
  assert.deepEqual(E.fallbackChain(''), [HK], '未知 base → 直接香港');
  assert.equal(E.isMirrorMiss(Object.assign(new Error('HTTP 404'), { status: 404 })), true, '404 = 镜像缺文件 → 回退');
  assert.equal(E.isMirrorMiss(new Error('HTTP 403')), true, '403 同样按缺文件处理');
  assert.equal(E.isMirrorMiss(new Error('HTTP 410')), true, '410 同样按缺文件处理');
  assert.equal(E.isMirrorMiss(new Error('getaddrinfo ENOTFOUND harness.southdns.com')), true, '镜像域名解析失败 → 回退香港');
  assert.equal(E.isMirrorMiss(new Error('网络停滞：连续 30 秒没有收到任何数据，已中止下载')), false, '超时/停滞**不**回退（链路问题，回退救不了）');
  assert.equal(E.isMirrorMiss(Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' })), false, '连接重置不回退');
  assert.equal(E.isMirrorMiss(new Error('HTTP 500')), false, '500 是服务端错误，不按缺文件处理');
  ok('⑫ 回退链：深圳→香港（去重）；404/403/410/DNS 失败算镜像缺文件，超时/重置/500 不算');
}

// ---------- ⑬ 决策稳定性：同一输入重复调用结果一致 ----------
{
  const probes = [
    { id: 'hk', base: HK, ok: true, ms: 120 },
    { id: 'sz', base: SZ, ok: true, ms: 80 },
  ];
  const picks = Array.from({ length: 5 }, () => E.pickBase(probes));
  assert.ok(picks.every((p) => p?.id === 'sz' && p?.base === SZ), '同一批探测结果重复决策必须稳定（不随数组顺序/调用次数漂移）');
  const reordered = E.rankProbes([
    { id: 'sz', base: SZ, ok: true, ms: 80 },
    { id: 'hk', base: HK, ok: true, ms: 120 },
  ]);
  assert.deepEqual(reordered.map((r) => r.id), ['sz', 'hk'], '输入顺序不能影响排序结果（排序键是 TTFB）');
  ok('⑬ 决策稳定性：同一输入重复 pickBase/rankProbes 结果一致，与输入顺序无关');
}

// ---------- ⑭ 源码接线：main.js 真的用了这套线路选择 ----------
{
  assert.match(mainSrc, /from '\.\/endpoint\.js'/, 'main.js 必须 import endpoint.js（否则线路选择从未接上）');
  assert.match(mainSrc, /endpoint\.json|ENDPOINT_CACHE_FILE/, 'main.js 必须用 endpoint.json 做 24h 缓存');
  assert.match(mainSrc, /path\.join\(app\.getPath\('userData'\), ENDPOINT_CACHE_FILE\)/, '缓存文件必须落在 userData（不是仓库目录）');
  assert.match(mainSrc, /process\.env\[UPDATE_BASE_ENV\]/, 'main.js 必须支持 MINGDAO_UPDATE_BASE 强制覆盖');
  assert.match(mainSrc, /endpoint=/, '日志必须记录 endpoint=sz|hk（用户反馈时要能看见线路）');
  assert.match(mainSrc, /probe=/, '日志必须记录 probe=xxms');
  assert.match(mainSrc, /stage=endpoint/, '线路选择必须有自己的 stage 日志');
  assert.match(mainSrc, /function httpsProbeTtfb|httpsProbeTtfb =/, 'main.js 必须真的做 TTFB 探测（不是只调用纯函数）');
  assert.match(mainSrc, /selectEndpoint\(/, 'main.js 必须调用线路选择主入口');
  ok('⑭ 源码接线：import endpoint.js / endpoint.json 缓存 / MINGDAO_UPDATE_BASE / endpoint=sz|hk probe=xxms');
}

// ---------- ⑮ 源码接线：选中的 base 应用到每条通道 ----------
{
  assert.match(mainSrc, /updatesBase\(endpoint\.base\)/, 'electron-updater feed 必须用选中线路的 /updates/');
  assert.match(mainSrc, /setFeedURL\(\{ provider: 'generic', url: feedUrl \}\)/, '必须显式 setFeedURL（否则读打包内置的香港 feed，选线路落空）');
  assert.match(mainSrc, /downloadsBase\(updateBase\(\)\)/, 'deb 安装包/.sig 下载目录必须跟随选中线路');
  assert.match(mainSrc, /downloadPageUrl\(updateBase\(\)\)/, '「去官网下载」链接必须跟随选中线路');
  assert.match(mainSrc, /parseDebFeed\(feedText, \{ downloadsBase: updateDownloadsDir\(\) \}\)/, 'deb 清单里的 path 必须拼到**选中线路**的 /downloads/');
  assert.match(mainSrc, /getUpdateResource\('\/downloads\/' \+ feed\.path/, 'deb 安装包下载必须走带镜像回退的取资源函数');
  assert.match(mainSrc, /isMirrorMiss\(err\)/, '镜像缺文件时必须自动回退香港再试一次');
  assert.match(mainSrc, /fallbackChain\(updateBase\(\)\)/, '回退链必须由选中线路 + 香港组成');
  ok('⑮ 源码接线：feed / deb 包 / .sig / 官网链接 / setFeedURL 全部跟随选中线路，404 回退香港');
}

// ---------- ⑯ 源码接线：问题 1 的四处修复（父窗口 / 空闲超时 / 可见进度 / pkexec 探测） ----------
{
  // 负向绊线只查**代码**（注释里保留着旧 bug 的原文作为证据，不该被误判）
  const mainCode = mainSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(
    mainCode,
    /showMessageBox\(\s*mainWindow\s*\?\?\s*undefined/,
    '不得再写 `showMessageBox(mainWindow ?? undefined, opts)`——无窗口时 Electron 会把 undefined 当 options → 抛错被吞成"用户点了稍后"'
  );
  assert.match(mainSrc, /async function showBox\(opts\)/, '必须有统一的对话框调用（按有无窗口分别调用）');
  assert.match(mainSrc, /parent \? await dialog\.showMessageBox\(parent, opts\) : await dialog\.showMessageBox\(opts\)/, '有窗口传父窗口、无窗口只传 options');
  assert.match(mainSrc, /对话框显示失败/, '对话框异常必须记录日志并明确抛出（不得静默吞掉）');
  assert.match(mainSrc, /DEB_IDLE_TIMEOUT_MS = 30000/, '必须有空闲超时（30s 无数据即中止）');
  assert.match(mainSrc, /网络停滞/, '空闲超时失败文案必须点明"网络停滞"（用户能看懂该换网络）');
  assert.match(mainSrc, /res\.on\('aborted'/, '必须处理 res.on(\'aborted\')（对端中止立即失败）');
  assert.match(mainSrc, /res\.on\('close'/, '必须处理 res.on(\'close\')（半截包立即失败）');
  assert.match(mainSrc, /正在下载更新/, '下载期间必须把窗口标题改成可见进度（Linux 任务栏进度条不显示）');
  assert.match(mainSrc, /setTitle\(/, '标题进度必须真的调 setTitle');
  assert.match(mainSrc, /desktop\.log/, '更新日志必须落到 ~/.mingdao/logs/desktop.log');
  assert.match(mainSrc, /stage=download 进度/, '每整十百分比必须记一行日志');
  assert.match(mainSrc, /打开日志/, '失败对话框必须统一带「打开日志」按钮');
  assert.match(mainSrc, /shell\.openPath\(file\)/, '「打开日志」必须真的打开日志文件');
  assert.match(mainSrc, /whichPkexec\(\)/, '安装前必须探测 pkexec');
  assert.match(mainSrc, /attempt\('which', \['pkexec'\]/, '探测方式必须是 which pkexec');
  assert.match(mainSrc, /installPlan\(\{ filePath, pkexecAvailable: !!pkexecPath \}\)/, '没有 pkexec 时必须走手动安装分支（不 spawn 必然 ENOENT 的命令）');
  assert.match(mainSrc, /需要手动安装/, '没有 pkexec 时必须有"手动安装"对话框');
  assert.match(mainSrc, /stage=confirm 用户选择稍后/, '确认阶段必须记录用户选择（区分"稍后"与"静默无响应"）');
  for (const st of ['feed', 'confirm', 'download', 'save', 'verify', 'sig', 'install']) {
    assert.ok(mainSrc.includes('stage=' + st), `日志必须能定位 stage=${st}`);
  }
  ok('⑯ 源码接线：父窗口分调用/不吞异常/空闲超时 aborted+close/标题进度/desktop.log/打开日志/which pkexec/分阶段日志');
}

// ---------- ⑰ 纯函数层与打包配置 ----------
{
  assert.doesNotMatch(endpointSrc, /^\s*import\s/m, 'endpoint.js 必须零 import（单测零网络、零 electron）');
  assert.doesNotMatch(endpointSrc, /from ['"]node:https?['"]/, 'endpoint.js 不得自己联网（探测由调用方注入）');
  assert.doesNotMatch(endpointSrc, /from ['"]electron['"]/, 'endpoint.js 不得 import electron（否则单测需要图形环境）');
  assert.match(builderYml, /^\s*-\s+endpoint\.js\s*$/m, '打包配置 files 必须含 endpoint.js（main.js 静态 import，漏打包=起不来）');
  ok('⑰ 纯函数层零 import/零网络/零 electron；electron-builder files 含 endpoint.js');
}

console.log(`\n更新线路选择（香港/深圳）：${passed} 项通过`);
