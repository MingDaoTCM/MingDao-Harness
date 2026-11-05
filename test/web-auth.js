// WebUI 访问控制纯函数套件（v0.7.0 §1.5：auth 从 server.js 切出后的行为契约）。
//
// 运行：node test/web-auth.js
//
// 覆盖：令牌来源三通道（?token= / X-MingDao-Token / Bearer）、来源优先级、空令牌、
// 回环/非回环、authEnabled=false、大小写与空白、拒绝无副作用、via 语义、Host 白名单。
// 本套件**不启动服务器**，只测 src/web/auth.js 的纯函数，因此可与其它套件并行跑。
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const {
  isLoopbackHost,
  resolveWebToken,
  extractRequestToken,
  tokenEquals,
  resolveAuthDecision,
  isTrustedHost,
  authStartupNotice,
} = await import(pathToFileURL(path.join(srcDir, 'web', 'auth.js')).href);

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
    console.log(`  ✓ web-auth：${name}`);
  } catch (/** @type {any} */ e) {
    failed += 1;
    console.error(`  ✗ web-auth：${name} —— ${String(e?.message || e)}`);
  }
}
const url = (/** @type {string} */ s) => new URL(s, 'http://localhost');
const decision = (/** @type {any} */ input) => resolveAuthDecision(input);

console.log('\n[web-auth · 令牌来源与通道]');

await t('A1 未配置令牌 + 回环绑定 → 放行（本机信任，via=loopback）', () => {
  const d = decision({ authToken: null, headers: {}, isLoopback: true });
  assert.equal(d.decision, 'ok', 'A1：回环 + 未配置令牌必须放行');
  assert.equal(d.via, 'loopback', 'A1：放行通道必须是 loopback');
});

await t('A2 未配置令牌 + 非回环 → 拒绝（fail-closed）', () => {
  const d = decision({ authToken: null, headers: {}, isLoopback: false });
  assert.equal(d.decision, 'deny', 'A2：非回环 + 无令牌必须拒绝（fail-closed）');
  assert.match(d.reason, /非回环/, 'A2：拒绝原因必须说明非回环');
});

await t('A3 已配置令牌 + 请求不带令牌 → 拒绝', () => {
  const d = decision({ authToken: 'tok-a', headers: {}, isLoopback: true });
  assert.equal(d.decision, 'deny', 'A3：启用令牌后无令牌必须拒绝（回环也不例外）');
  assert.match(d.reason, /缺少访问令牌/, 'A3：拒绝原因必须说明缺少令牌');
});

await t('A4 ?token= 正确 → 放行（via=exchange）', () => {
  const d = decision({ authToken: 'tok-a', url: url('/api/state?token=tok-a'), headers: {}, isLoopback: true });
  assert.equal(d.decision, 'ok', 'A4：?token= 必须通过 exchange 通道放行');
  assert.equal(d.via, 'exchange', 'A4：via 必须是 exchange');
});

await t('A5 ?token= 错误 → 拒绝', () => {
  const d = decision({ authToken: 'tok-a', url: url('/api/state?token=wrong'), headers: {}, isLoopback: true });
  assert.equal(d.decision, 'deny', 'A5：错误 ?token= 必须拒绝');
  assert.equal(d.via, 'none', 'A5：拒绝时 via 必须是 none');
});

await t('A6 X-MingDao-Token 正确 → 放行（via=token）', () => {
  const d = decision({ authToken: 'tok-a', headers: { 'x-mingdao-token': 'tok-a' }, isLoopback: true });
  assert.equal(d.decision, 'ok', 'A6：X-MingDao-Token 头必须放行');
  assert.equal(d.via, 'token', 'A6：via 必须是 token');
});

await t('A7 头名大小写不敏感（X-MINGDAO-TOKEN）→ 放行', () => {
  const d = decision({ authToken: 'tok-a', headers: { 'X-MingDao-Token': 'tok-a' }, isLoopback: true });
  assert.equal(d.decision, 'ok', 'A7：令牌头名大小写必须不敏感');
  assert.equal(d.via, 'token', 'A7：via 必须是 token');
});

await t('A8 Authorization: Bearer 正确 → 放行（via=bearer）', () => {
  const d = decision({ authToken: 'tok-a', headers: { authorization: 'Bearer tok-a' }, isLoopback: true });
  assert.equal(d.decision, 'ok', 'A8：Authorization Bearer 必须放行');
  assert.equal(d.via, 'bearer', 'A8：via 必须是 bearer');
});

await t('A9 查询与头部同时给且都正确 → 查询优先（via=exchange）', () => {
  const d = decision({ authToken: 'tok-a', url: url('/?token=tok-a'), headers: { 'x-mingdao-token': 'tok-a' }, isLoopback: true });
  assert.equal(d.decision, 'ok', 'A9：两种来源都正确时必须放行');
  assert.equal(d.via, 'exchange', 'A9：?token= 优先于请求头（via=exchange）');
});

await t('A10 ?token= 为空 → 回退到 X-MingDao-Token（旧语义）', () => {
  const d = decision({ authToken: 'tok-a', url: url('/?token='), headers: { 'x-mingdao-token': 'tok-a' }, isLoopback: true });
  assert.equal(d.decision, 'ok', 'A10：?token= 为空时必须回退到 X-MingDao-Token');
  assert.equal(d.via, 'token', 'A10：回退后 via 必须是 token');
});

await t('A11 查询错误 + 头部正确 → 拒绝（查询命中后不回退）', () => {
  const d = decision({ authToken: 'tok-a', url: url('/?token=wrong'), headers: { 'x-mingdao-token': 'tok-a' }, isLoopback: true });
  assert.equal(d.decision, 'deny', 'A11：查询串给错后不得回退到头部（与旧 requestToken 短路顺序一致）');
});

await t('A12 空 authToken + 回环 → 视为未启用（loopback）', () => {
  const d = decision({ authToken: '   ', headers: {}, isLoopback: true });
  assert.equal(d.decision, 'ok', 'A12：空/纯空白 authToken 必须视为未启用');
  assert.equal(d.via, 'loopback', 'A12：via 必须是 loopback');
  const r = resolveWebToken({ authToken: '', configToken: '', host: '127.0.0.1' });
  assert.equal(r.authEnabled, false, 'A12：authEnabled 必须是 false');
  assert.equal(r.token, null, 'A12：令牌必须是 null');
  assert.equal(r.generated, false, 'A12：回环下不得随机生成令牌');
});

await t('A13 authEnabled=false → tokenEquals 对任意候选都放行', () => {
  assert.equal(tokenEquals(null, 'anything'), true, 'A13：未启用令牌时 tokenEquals 必须放行');
  assert.equal(tokenEquals('', null), true, 'A13：未启用令牌时 even 空候选也放行（= 旧 tokenMatches）');
});

await t('A14 令牌大小写敏感（Tok-A ≠ tok-a）', () => {
  assert.equal(tokenEquals('Tok-A', 'tok-a'), false, 'A14：令牌比对必须大小写敏感');
  const d = decision({ authToken: 'Tok-A', headers: { 'x-mingdao-token': 'tok-a' }, isLoopback: true });
  assert.equal(d.decision, 'deny', 'A14：大小写不同必须拒绝');
});

await t('A15 配置令牌两端空白被 trim，候选令牌空白不 trim', () => {
  const r = resolveWebToken({ authToken: '  tok-a  ', host: '127.0.0.1' });
  assert.equal(r.token, 'tok-a', 'A15：配置令牌必须 trim');
  const d = decision({ authToken: 'tok-a', url: url('/?token=%20tok-a%20'), headers: {}, isLoopback: true });
  assert.equal(d.decision, 'deny', 'A15：候选令牌不得 trim（带空格的 ?token= 必须拒绝）');
  assert.equal(tokenEquals('tok-a', 'tok-a '), false, 'A15：候选令牌尾随空格必须不匹配');
  assert.equal(tokenEquals('abc', 'abcdef'), false, 'A15：长度不同的候选必须直接 false（timingSafeEqual 不得抛）');
});

console.log('\n[web-auth · 纯度 / via / Host 白名单]');

await t('A16 拒绝时不写 res、不改输入（纯函数）', () => {
  const headers = { 'x-mingdao-token': 'wrong' };
  const u = url('/api/state?token=wrong');
  const before = { url: u.href, header: headers['x-mingdao-token'] };
  /** @type {string[]} */
  const headerWrites = [];
  const fakeRes = { setHeader: (/** @type {string} */ k) => headerWrites.push(k), end: () => headerWrites.push('end') };
  const d = decision({ authToken: 'tok-a', url: u, headers, isLoopback: true, res: fakeRes });
  assert.equal(d.decision, 'deny', 'A16：错误令牌必须拒绝');
  assert.equal(headerWrites.length, 0, 'A16：判定函数不得写 res（setHeader/end 必须零调用）');
  assert.equal(u.href, before.url, 'A16：判定函数不得修改 url');
  assert.equal(headers['x-mingdao-token'], before.header, 'A16：判定函数不得修改 headers');
  assert.ok(!('res' in d), 'A16：结果对象里不得夹带 res');
});

await t('A17 via 语义覆盖 exchange/token/bearer/loopback/none', () => {
  const ok = (/** @type {any} */ input) => decision(input).via;
  assert.equal(ok({ authToken: 't', url: url('/?token=t') }), 'exchange', 'A17：?token= → exchange');
  assert.equal(ok({ authToken: 't', headers: { 'x-mingdao-token': 't' } }), 'token', 'A17：头 → token');
  assert.equal(ok({ authToken: 't', headers: { authorization: 'Bearer t' } }), 'bearer', 'A17：Bearer → bearer');
  assert.equal(ok({ authToken: null, isLoopback: true }), 'loopback', 'A17：回环本机信任 → loopback');
  assert.equal(ok({ authToken: 't', isExempt: true }), 'none', 'A17：静态壳免令牌 → none');
  assert.equal(ok({ authToken: 't' }), 'none', 'A17：拒绝 → none');
});

await t('A18 Host 白名单：回环/绑定地址放行，伪造 Host 拒绝', () => {
  assert.equal(isTrustedHost({ hostHeader: '127.0.0.1:3820', bindHost: '127.0.0.1', boundPort: 3820 }), true, 'A18：127.0.0.1:port 必须放行');
  assert.equal(isTrustedHost({ hostHeader: 'localhost:3820', bindHost: '127.0.0.1', boundPort: 3820 }), true, 'A18：localhost:port 必须放行');
  assert.equal(isTrustedHost({ hostHeader: '[::1]:3820', bindHost: '127.0.0.1', boundPort: 3820 }), true, 'A18：IPv6 回环必须放行');
  assert.equal(isTrustedHost({ hostHeader: 'evil.example:3820', bindHost: '127.0.0.1', boundPort: 3820 }), false, 'A18：伪造 Host 必须拒绝（DNS rebinding 防护）');
  assert.equal(isTrustedHost({ hostHeader: '127.0.0.1:9999', bindHost: '127.0.0.1', boundPort: 3820 }), false, 'A18：端口不符必须拒绝');
  assert.equal(isTrustedHost({ hostHeader: 'anything:3820', bindHost: '0.0.0.0', boundPort: 3820, authEnabled: true }), true, 'A18：0.0.0.0 + 令牌时放行任意 Host（令牌是边界）');
  assert.equal(isTrustedHost({ hostHeader: 'anything:3820', bindHost: '0.0.0.0', boundPort: 3820, authEnabled: false }), false, 'A18：0.0.0.0 + 无令牌必须拒绝任意 Host');
});

await t('A19 回环判定 + 非回环启动必然生成令牌', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true, 'A19：127.0.0.1 是回环');
  assert.equal(isLoopbackHost('localhost'), true, 'A19：localhost 是回环');
  assert.equal(isLoopbackHost('::1'), true, 'A19：::1 是回环');
  assert.equal(isLoopbackHost('0.0.0.0'), false, 'A19：0.0.0.0 不是回环');
  const r = resolveWebToken({ authToken: null, configToken: null, host: '0.0.0.0' });
  assert.equal(r.authEnabled, true, 'A19：非回环绑定必须启用令牌');
  assert.equal(r.generated, true, 'A19：非回环且未配置时必须本次随机生成');
  assert.match(r.token, /^[0-9a-f]{32}$/, 'A19：随机令牌必须是 32 位十六进制（16 字节）');
  assert.equal(extractRequestToken({ url: url('/?token='), headers: {} }).token, null, 'A19：空 ?token= 不得被当成候选');
});

await t('A20 启动文案与判定同源（令牌/本机信任）', () => {
  const lines = authStartupNotice({ authEnabled: true, token: 'tok-a', generated: false, host: '127.0.0.1', displayHost: '127.0.0.1', port: 3820 });
  assert.ok(lines.some((l) => l.text.includes('?token=tok-a')), 'A20：启用令牌时必须打印带 token 的地址');
  assert.ok(lines.some((l) => /已启用访问令牌/.test(l.text)), 'A20：回环 + 显式令牌时给出"需带 ?token="提示');
  const trust = authStartupNotice({ authEnabled: false, host: '127.0.0.1', port: 3820 });
  assert.ok(trust.some((l) => /本机信任模式/.test(l.text)), 'A20：回环 + 无令牌时必须明说本机信任模式');
  assert.equal(trust.some((l) => l.warn), false, 'A20：回环本机信任不是警告');
  const remote = authStartupNotice({ authEnabled: false, host: '0.0.0.0', port: 3820 });
  assert.ok(remote.some((l) => l.warn), 'A20：非回环 + 无令牌必须是警告');
});

console.log(`\nweb-auth：${passed} 项通过，${failed} 项失败`);
process.exit(failed ? 1 : 0);
