// 批六十二（v0.6.29 安全批 B1/B2/B3：凭据外泄加固）的变异验证。
//
// 三条修复的关键点逐个改回缺陷，`test/credential-hardening.js` 必须当场红：
//   B1 重定向：safe-fetch 退回自己的跟随逻辑（不剥头）/ allowPrivate 沿链路透传 /
//              跳数上限回退 / 删掉协议降级与逐跳日志 / 判定忽略端口与协议 / 剥头白名单失效；
//   B2 单一来源：从 env 名单删 PGPASSWORD / 从脱敏词表删 pgpassword+cred /
//              大写 SK- 正则回退大小写敏感 / 赋值式不再看 env 名单 / bash 重新自建判定；
//   B3 账本：去掉对象层预脱敏（退回逐叶子值）/ 键名归一去掉小写化。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const RUN = () => M.suite('test/credential-hardening.js');

// ① B1：safe-fetch 不再复用 net-guard 的判定，退回"自己跟随、不剥头"
M.mutate({
  name: '① B1 safe-fetch 退回自己的跟随逻辑（不剥凭据头）',
  file: 'src/safe-fetch.js',
  from: '        const prep = prepareRedirectHeaders(outboundHeaders, cur.href, next.href);',
  to: "        const prep = { strip: false, reason: 'same-origin', headers: outboundHeaders }; // mutated",
  expect: ['必须调用 net-guard.prepareRedirectHeaders'],
  run: RUN,
});

// ② B1：allowPrivate 沿重定向链透传（model-discovery 的本地端点变成"任意内网"）
M.mutate({
  name: '② B1 allowPrivate 沿重定向链透传',
  file: 'src/safe-fetch.js',
  from: '      const privateAllowed = allowPrivate && (hop === 0 || cur.origin === firstOrigin);',
  to: '      const privateAllowed = allowPrivate; // mutated',
  expect: ['指向回环的重定向必须被拒', '重定向目标不得收到任何请求'],
  run: RUN,
});

// ③ B1：跳数上限退回 5（与断言的 10 跳口径不符）
M.mutate({
  name: '③ B1 重定向上限退回 5 跳',
  file: 'src/safe-fetch.js',
  from: 'maxHops = 10',
  to: 'maxHops = 5',
  expect: ['必须命中 10 跳上限', '跳转链长度必须打到可见日志'],
  run: RUN,
});

// ④ B1：https→http 降级不再可见（静默降级）
M.mutate({
  name: '④ B1 删除协议降级日志',
  file: 'src/safe-fetch.js',
  from: '          logRedirect(`⚠ 协议降级 https→http（第 ${redirects} 跳）：${cur.href} → ${next.href}`);',
  to: '          // mutated: 协议降级日志被删除',
  expect: ['协议降级必须写可见日志'],
  run: RUN,
});

// ⑤ B1：不再逐跳记录跳数（链长不可见）
M.mutate({
  name: '⑤ B1 删除逐跳跳数与链长日志',
  file: 'src/safe-fetch.js',
  from: '        logRedirect(`重定向 ${redirects}/${maxHops}：${cur.href} → ${next.href}`);',
  to: '        // mutated: 跳数日志被删除',
  expect: ['跳转链长度必须打到可见日志'],
  run: RUN,
});

// ⑥ B1：判定只看主机名，忽略协议降级与端口变化
M.mutate({
  name: '⑥ B1 重定向判定忽略端口与协议（只看主机名）',
  file: 'src/net-guard.js',
  from: `  if (a.protocol !== b.protocol) {
    return { strip: true, reason: a.protocol === 'https:' && b.protocol === 'http:' ? 'protocol-downgrade' : 'protocol-change' };
  }
  if (effectivePort(a) !== effectivePort(b)) return { strip: true, reason: 'port-change' };`,
  to: '  // mutated: 端口与协议差异不再算跨源',
  expect: ['端口变化也算跨源'],
  run: RUN,
});

// ⑦ B1：跨源裁剪白名单失效（所有头原样带走）
M.mutate({
  name: '⑦ B1 跨源剥头退回"原样带走"',
  file: 'src/net-guard.js',
  from: `export function stripHeadersForCrossOrigin(headers) {
  const src = new Headers(headers || {});
  /** @type {[string,string][]} */
  const keep = [];
  src.forEach((v, k) => {
    if (CROSS_ORIGIN_KEEP_HEADERS.has(String(k).toLowerCase())) keep.push([k, v]);
  });
  return new Headers(keep);
}`,
  to: `export function stripHeadersForCrossOrigin(headers) {
  return new Headers(headers || {}); // mutated: 全部头原样保留
}`,
  expect: ['跨源后不得携带 authorization'],
  run: RUN,
});

// ⑧ B1：prepare 判定说剥、实际不剥（第二套口径的另一种形态）
M.mutate({
  name: '⑧ B1 prepare 判定与裁剪脱节（永不剥头）',
  file: 'src/net-guard.js',
  from: '  return { ...decision, headers: decision.strip ? stripHeadersForCrossOrigin(headers) : headers };',
  to: '  return { ...decision, headers }; // mutated',
  expect: ['跨源后不得携带 authorization'],
  run: RUN,
});

// ⑨ B2：从 env 名单删掉 PGPASSWORD（只删单侧，行为仍被另一条规则兜住 → 由名单断言抓）
M.mutate({
  name: '⑨ B2 env 名单删除 PGPASSWORD',
  file: 'src/redact.js',
  from: "  'PGPASSWORD',\n",
  to: '',
  expect: ['PGPASSWORD 必须在环境名单里'],
  run: RUN,
});

// ⑩ B2：脱敏词表删掉 v0.6.29 新增段（pgpassword/cred/sso/privatekey）
M.mutate({
  name: '⑩ B2 脱敏词表删除 pgpassword/cred 段',
  file: 'src/redact.js',
  from: "  'pgpassword', 'cred', 'sso', 'privatekey',\n",
  to: '',
  expect: ['的值必须被掩码', 'PGPASSWORD 必须在脱敏词表里'],
  run: RUN,
});

// ⑪ B2：大写 SK- 前缀再次漏出（正则回退大小写敏感）
M.mutate({
  name: '⑪ B2 SK- 前缀正则回退大小写敏感',
  file: 'src/redact.js',
  from: '/sk-[A-Za-z0-9_-]{6,}/gi',
  to: '/sk-[A-Za-z0-9_-]{6,}/g',
  expect: ['大写 SK- 前缀'],
  run: RUN,
});

// ⑫ B2：赋值式规则不再看 env 名单（DATABASE_URL=… 日志行重新明文）
M.mutate({
  name: '⑫ B2 赋值式脱敏不再复用 env 名单',
  file: 'src/redact.js',
  from: '      if (!segs.some((x) => SECRET_NAME_SEGMENTS.has(x)) && !isSensitiveEnvName(name)) return m;',
  to: '      if (!segs.some((x) => SECRET_NAME_SEGMENTS.has(x))) return m; // mutated',
  expect: ['掩码形态应为'],
  run: RUN,
});

// ⑬ B2：bash 重新自建判定（不再与脱敏器同一函数对象）
M.mutate({
  name: '⑬ B2 bash 重新自建 env 判定',
  file: 'src/tools/bash.js',
  from: 'export const isSensitiveEnv = isSensitiveEnvName;',
  to: "export const isSensitiveEnv = (k) => /TOKEN|KEY/.test(String(k)); // mutated",
  expect: ['同一函数对象'],
  run: RUN,
});

// ⑭ B3：账本退回逐叶子值脱敏（审计 H-14 原缺陷）
M.mutate({
  name: '⑭ B3 账本退回逐叶子值脱敏（无对象层）',
  file: 'src/ledger.js',
  from: '  if (depth === 0) value = maskSecretObjectValues(value);',
  to: '  // mutated: 对象层预脱敏被删除',
  expect: ['键名命中必须整值掩码'],
  run: RUN,
});

// ⑮ B3：键名归一去掉小写化（API-KEY / apiKey 重新漏网）
M.mutate({
  name: '⑮ B3 键名归一去掉小写化',
  file: 'src/redact.js',
  from: "  return String(key ?? '').trim().toLowerCase().replace(/-/g, '_');",
  to: "  return String(key ?? '').trim().replace(/-/g, '_'); // mutated",
  expect: ['键名归一后'],
  run: RUN,
});

if (!M.report()) process.exit(1);
