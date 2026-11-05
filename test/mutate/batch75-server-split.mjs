// 批七十五（v0.7.0 §1.5 第二步）：server.js 两刀（auth / provider-cache）切出后的变异验证。
//
// 目标：证明抽出去的不是"搬到新文件里继续写错"——每条都把修复退回缺陷，断言必须当场红。
//   · auth：?token= / 请求头两条通道、非回环 fail-closed、大小写敏感、候选不 trim、Host 白名单；
//   · provider-cache：缓存键含 baseUrl/凭证摘要/超时、invalidate 双清、并发换代不写回、
//     探测备忘同代际命中/跨代际失效/TTL 过期、远程不探测。
//
// 每条都在 `test/web-auth.js` 或 `test/provider-cache.js` 上真跑，`expect` 是断言原文里的关键词。
// 用法：node test/mutate/batch75-server-split.mjs
import { makeMutator } from './lib.mjs';

const M = makeMutator();
const AUTH = () => M.suite('test/web-auth.js');
const CACHE = () => M.suite('test/provider-cache.js');

// ── auth ①：?token= 交换通道被删，只剩请求头 ──
M.mutate({
  name: '① auth 退回只看头部（?token= 交换通道丢失）',
  file: 'src/web/auth.js',
  from: [
    '  const q = url && typeof url.searchParams?.get === \'function\' ? url.searchParams.get(\'token\') : null;',
    '  if (q) return { token: String(q), via: \'exchange\' };',
  ].join('\n'),
  to: '  // 变异：?token= 通道被删，只剩请求头',
  expect: ['A4：?token= 必须通过 exchange 通道放行'],
  run: AUTH,
});

// ── auth ②：X-MingDao-Token 头不再被读取 ──
M.mutate({
  name: '② auth 丢掉 X-MingDao-Token 头（浏览器会话令牌失效）',
  file: 'src/web/auth.js',
  from: [
    '  const h = headerValue(headers, \'x-mingdao-token\');',
    '  if (h) return { token: h, via: \'token\' };',
  ].join('\n'),
  to: '  const h = \'\'; // 变异：不读 X-MingDao-Token',
  expect: ['A6：X-MingDao-Token 头必须放行'],
  run: AUTH,
});

// ── auth ③：非回环 + 无令牌 fail-open ──
M.mutate({
  name: '③ 非回环 + 未配置令牌时 fail-open（把"必须拒绝"改成放行）',
  file: 'src/web/auth.js',
  from: '      : { decision: \'deny\', via: \'none\', reason: \'未启用访问令牌且非回环绑定\' };',
  to: '      : { decision: \'ok\', via: \'loopback\', reason: \'变异：非回环也放行\' };',
  expect: ['A2：非回环 + 无令牌必须拒绝'],
  run: AUTH,
});

// ── auth ④：令牌比对变成大小写不敏感 ──
M.mutate({
  name: '④ 令牌比对大小写不敏感（Tok-A 与 tok-a 等价）',
  file: 'src/web/auth.js',
  from: '  return a.length === b.length && crypto.timingSafeEqual(a, b);',
  to: "  return a.length === b.length && a.toString('utf8').toLowerCase() === b.toString('utf8').toLowerCase(); // 变异：大小写不敏感",
  expect: ['A14：令牌比对必须大小写敏感'],
  run: AUTH,
});

// ── auth ⑤：候选令牌被 trim（带空格的错误令牌被放行）──
M.mutate({
  name: '⑤ 候选令牌被 trim（带空白的令牌被当成正确令牌）',
  file: 'src/web/auth.js',
  from: '  if (q) return { token: String(q), via: \'exchange\' };',
  to: '  if (q) return { token: String(q).trim(), via: \'exchange\' }; // 变异：候选令牌被 trim',
  expect: ['A15：候选令牌不得 trim'],
  run: AUTH,
});

// ── auth ⑥：Host 白名单恒真（DNS rebinding 防护失效）──
M.mutate({
  name: '⑥ Host 白名单恒真（伪造 Host 也放行）',
  file: 'src/web/auth.js',
  from: '  return bindHost === \'0.0.0.0\' && authEnabled;',
  to: '  return true; // 变异：Host 白名单恒真',
  expect: ['A18：伪造 Host 必须拒绝'],
  run: AUTH,
});

// ── auth ⑦：空的 ?token= 不再回退到请求头 ──
M.mutate({
  name: '⑦ 空 ?token= 不再回退到 X-MingDao-Token',
  file: 'src/web/auth.js',
  from: '  if (q) return { token: String(q), via: \'exchange\' };',
  to: '  if (q !== null) return { token: q ? String(q) : null, via: \'exchange\' }; // 变异：空 token 不回退',
  expect: ['A10：?token= 为空时必须回退到 X-MingDao-Token'],
  run: AUTH,
});

// ── provider ⑧：缓存键退回只按模型名（H-04 原缺陷）──
M.mutate({
  name: '⑧ providerCache 退回只按模型名缓存（切 baseUrl 复用旧实例）',
  file: 'src/web/provider-cache.js',
  from: '  const providerCacheKey = (m) => `${m}\\u0000${providerFingerprint(m)}`;',
  to: '  const providerCacheKey = (m) => m; // 变异：只按模型名',
  expect: ['P2：同模型不同 baseUrl 不得复用实例'],
  run: CACHE,
});

// ── provider ⑨：指纹丢掉 apiKey 摘要（换 Key 仍复用旧实例）──
M.mutate({
  name: '⑨ 出网指纹丢掉 apiKey 摘要（换 Key 后仍用旧凭证实例）',
  file: 'src/web/provider-cache.js',
  from: '    const keyDigest = crypto.createHash(\'sha256\').update(String(pc.apiKey || \'\')).digest(\'hex\').slice(0, 16);',
  to: '    const keyDigest = \'\'; // 变异：指纹丢 apiKey 摘要',
  expect: ['P4：指纹必须包含 apiKey 的 sha256 摘要'],
  run: CACHE,
});

// ── provider ⑩：指纹丢掉 timeout（改超时配置仍复用旧实例）──
M.mutate({
  name: '⑩ 出网指纹丢掉 timeout（改超时后仍复用旧实例）',
  file: 'src/web/provider-cache.js',
  from: '      timeout = JSON.stringify(cfg?.timeout ?? null);',
  to: '      timeout = \'\'; // 变异：指纹丢 timeout',
  expect: ['P5：timeout 配置必须进入出网指纹', 'P5：指纹里必须带 timeout 的 JSON'],
  run: CACHE,
});

// ── provider ⑪：invalidate 不清探测备忘（旧端点结论套到新端点）──
M.mutate({
  name: '⑪ invalidate 不清探测备忘（旧端点的 TTFT/endpoint 结论跨代际复用）',
  file: 'src/web/provider-cache.js',
  from: ['    providerCache.clear();', '    probeByModel.clear();'].join('\n'),
  to: ['    providerCache.clear();', '    // 变异：探测备忘不清'].join('\n'),
  expect: ['P7：invalidate 必须同时清空探测备忘'],
  run: CACHE,
});

// ── provider ⑫：创建期间换代也把旧实例写回缓存（H-04 第二层保险被拆）──
M.mutate({
  name: '⑫ 并发创建期间换代仍把旧实例写回缓存',
  file: 'src/web/provider-cache.js',
  from: '      if (providerCacheKey(m) === cacheKey) {',
  to: '      if (true) { // 变异：旧代际实例也写回',
  expect: ['P8：旧代际实例不得写回缓存'],
  run: CACHE,
});

// ── provider ⑬：探测备忘键不随出网指纹换代（改 Key/baseUrl 后念旧结论）──
M.mutate({
  name: '⑬ 探测备忘只按模型名（指纹变了仍念旧结论）',
  file: 'src/web/provider-cache.js',
  from: '  const probeCacheKey = (m) => `${m}\\u0000${providerFingerprint(m)}`;',
  to: '  const probeCacheKey = (m) => m; // 变异：探测备忘不随指纹换代',
  expect: ['P11：指纹变化后探测备忘键必须不同'],
  run: CACHE,
});

// ── provider ⑭：探测备忘忽略 TTL（失败结论永久重放）──
M.mutate({
  name: '⑭ 探测备忘忽略 TTL（失败结论永久重放）',
  file: 'src/web/provider-cache.js',
  from: '    if (probeMemoUsable(memo)) return memo.value;',
  to: '    if (memo) return memo.value; // 变异：忽略 TTL',
  expect: ['P12：备忘过期'],
  run: CACHE,
});

// ── provider ⑮：远程模型也做预检（每轮多打一次请求）──
M.mutate({
  name: '⑮ 远程模型也做本地端点预检（每轮多打一次请求）',
  file: 'src/web/provider-cache.js',
  from: '    if (!isLocalModel(m)) return null;',
  to: '    // 变异：不判本地/远程，全部预检',
  expect: ['P14：远程模型不预检'],
  run: CACHE,
});

const ok = M.report();
process.exit(ok ? 0 : 1);
