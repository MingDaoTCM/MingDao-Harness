// 批六十六（v0.6.30 第三方核验 N-10 / N-15 / N-16 / N-17 / N-3 / H-11 的变异验证）。
//
// 判定入口：test/sync-registration-hardening.js（F1≥10 / F2≥8 / F3≥4 / F4≥4）。
// 每条都把修复改回缺陷，套件必须当场红；`expect` 是失败断言原文里的关键词。
import { makeMutator } from './lib.mjs';

const M = makeMutator();
const SUITE = () => M.suite('test/sync-registration-hardening.js');

// ---------------------------------------------------------------------------
// F1（N-10）：默认 closed 不得从请求推断「本机来源」
// ---------------------------------------------------------------------------
M.mutate({
  name: '① F1 默认退回 open（回环豁免不再要求显式开关）',
  file: 'src/sync-server.js',
  from: `  if (REGISTRATION_AUTO && ALLOW_LOOPBACK_REGISTRATION && isDirectLoopback(req)) return 'open';`,
  to: `  if (REGISTRATION_AUTO) return 'open';`,
  expect: ['伪造 XFF=127.0.0.1 必须被拒'],
  run: SUITE,
});

M.mutate({
  name: '② F1 「直连」判定忽略转发头（带 XFF 也算本机直连）',
  file: 'src/sync-server.js',
  from: `  if (PROXY_TRUSTED || hasProxyHeaders(req)) return false;`,
  to: `  if (PROXY_TRUSTED) return false; // mutated：只看代理配置，不看请求头`,
  expect: ['带任何转发头都不算直连'],
  run: SUITE,
});

M.mutate({
  name: '③ F1 未设 TRUST_PROXY 时仍然采信 XFF（轮换即可重置来源桶）',
  file: 'src/sync-server.js',
  from: `  if (!PROXY_TRUSTED) return direct;`,
  to: `  if (false) return direct; // mutated：无代理配置也读 XFF`,
  expect: ['未设 TRUST_PROXY 时 XFF 必须被忽略'],
  run: SUITE,
});

M.mutate({
  name: '④ F1 XFF 退回取左起第一段（客户端自填段）',
  file: 'src/sync-server.js',
  from: `  const idx = TRUST_PROXY_HOPS > 0 ? chain.length - TRUST_PROXY_HOPS : chain.length - 1;`,
  to: `  const idx = 0; // mutated：取左起第一段`,
  expect: ['按右起取来源时左起固定不应触发限流'],
  run: SUITE,
});

M.mutate({
  name: '⑤ F1 删掉显式开关要求（只要直连就自动放行）',
  file: 'src/sync-server.js',
  from: `  if (REGISTRATION_AUTO && ALLOW_LOOPBACK_REGISTRATION && isDirectLoopback(req)) return 'open';`,
  to: `  if (REGISTRATION_AUTO && isDirectLoopback(req)) return 'open'; // mutated：不再要求显式声明`,
  expect: ['未显式开启豁免时本机直连也必须 403'],
  run: SUITE,
});

// ---------------------------------------------------------------------------
// F2（N-15 / N-16 / N-17）：锁纪律与账号桶
// ---------------------------------------------------------------------------
M.mutate({
  name: '⑥ N-15 把 scrypt 移回写锁内（锁内 await CPU 等待）',
  file: 'src/sync-server.js',
  from: `  const salt = crypto.randomBytes(12).toString('hex');
  const hash = await hashPassword(password, salt);
  return withWriteLock(() => {
    const users = readUsers();`,
  to: `  const salt = crypto.randomBytes(12).toString('hex');
  return withWriteLock(async () => {
    const hash = await hashPassword(password, salt); // mutated：锁内 await
    const users = readUsers();`,
  expect: ['锁内 await hash 会拖住并发写'],
  run: SUITE,
});

M.mutate({
  name: '⑦ N-16 重新引入第二把 registerLock',
  file: 'src/sync-server.js',
  from: `/** @param {any} body */
async function doRegister(body) {`,
  to: `let registerLock = null; // mutated：users.json 上重新出现第二把互斥锁
/** @param {any} body */
async function doRegister(body) {`,
  expect: ['源码不得再出现 registerLock'],
  run: SUITE,
});

M.mutate({
  name: '⑧ N-17③ 不存在的用户名也计入账号桶（跨 IP 锁死任意用户名）',
  file: 'src/sync-server.js',
  from: `      // N-17①③：账号桶只对**已存在**账号的失败认证计数。用户不存在仅由来源桶限流——
      // 否则攻击者拿任意用户名打失败也能把（不存在/他人的）账号推进退避。
      else if (r.unauthorized) noteAccountFailure('/api/pair', acct);`,
  to: `      else if (r.notFound || r.unauthorized) noteAccountFailure('/api/pair', acct); // mutated：notFound 也记账`,
  expect: ['不存在的账号不得进入账号桶'],
  run: SUITE,
});

M.mutate({
  name: '⑨ N-17② 账号退避上限退回 5min（可被持续失败永久锁死）',
  file: 'src/sync-server.js',
  from: `const ACCOUNT_BACKOFF_MAX_MS = 60 * 1000;`,
  to: `const ACCOUNT_BACKOFF_MAX_MS = 5 * 60 * 1000; // mutated：退回旧上限`,
  expect: ['账号锁定退避上限必须是 60s'],
  run: SUITE,
});

// ---------------------------------------------------------------------------
// F3（N-3）：数据面配额
// ---------------------------------------------------------------------------
M.mutate({
  name: '⑩ F3 push 的每账号每分钟请求上限被短路',
  file: 'src/sync-server.js',
  from: `    if (req.method === 'POST' && p === '/api/sessions/push') {
      // N-3（M-07）：数据面配额——每账号每分钟请求数 + 每日字节。超限必须 429 且说明可见。
      const reqGate = accountRequestLimited(dev.username);`,
  to: `    if (req.method === 'POST' && p === '/api/sessions/push') {
      const reqGate = null; // mutated：不限制请求频率`,
  expect: ['第 6 次必须 429'],
  run: SUITE,
});

M.mutate({
  name: '⑪ F3 每日字节配额被整体关闭（quotaExceeded 恒放行）',
  file: 'src/sync-server.js',
  from: `  if (DAILY_QUOTA_BYTES <= 0) return null; // 显式 0 = 关闭每日配额`,
  to: `  return null; // mutated：每日配额永不生效`,
  expect: ['超出每日 1MB 配额必须 429'],
  run: SUITE,
});

// ---------------------------------------------------------------------------
// F4（H-11）：无令牌 WebUI 不得改成 auto
// ---------------------------------------------------------------------------
M.mutate({
  name: '⑫ F4 无令牌也允许 permission=auto（移除服务端门）',
  file: 'src/web/routes/domains/config.js',
  from: `      if (perm === 'auto' && !tokenAuthEnabled) {`,
  to: `      if (false) { // mutated：无令牌也可改 auto`,
  expect: ['无令牌时 auto 必须被拒'],
  run: SUITE,
});

M.mutate({
  name: '⑬ F4 /api/state 不再暴露 auto 限制（界面不可见）',
  file: 'src/web/routes/domains/config.js',
  from: `      permissionAutoAllowed: tokenAuthEnabled,`,
  to: `      permissionAutoAllowed: true, // mutated：限制不在界面可见`,
  expect: ['state.permissionAutoAllowed 必须是 false'],
  run: SUITE,
});

if (!M.report()) process.exit(1);
