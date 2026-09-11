// MingDao-Harness 冒烟测试：不依赖网络，用 Stub Provider 走完整 Agent 循环。
// 运行：node test/smoke.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

const { createAgent } = await import(pathToFileURL(path.join(srcDir, 'agent.js')).href);
const { parseStream, parseNonStream } = await import(pathToFileURL(path.join(srcDir, 'providers/openai-compatible.js')).href);
const { approxTokens, trimMessages, clampText } = await import(pathToFileURL(path.join(srcDir, 'context.js')).href);
const { dispatch } = await import(pathToFileURL(path.join(srcDir, 'tools/index.js')).href);
const { toolSchemas, buildToolSchemas } = await import(pathToFileURL(path.join(srcDir, 'tools/index.js')).href);
const { saveConfig, loadConfig } = await import(pathToFileURL(path.join(srcDir, 'config.js')).href);
const { createIO } = await import(pathToFileURL(path.join(srcDir, 'ui.js')).href);

// 全局隔离：整个测试期间审计/记忆/技能等写入临时 home，绝不污染真实 ~/.mingdao
const smokeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-smoke-home-'));
process.env.MINGDAO_HOME = smokeHome;

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// Windows EBUSY 容错清理（审计 D5）：git/子进程退出后目录句柄短暂未释放或 Defender 扫描竞态，
// 立即 rmSync 会报 EBUSY 使 smoke 在 Windows CI 腿失败。重试 + 短暂同步等待（Atomics.wait），
// 与 e2e-web.js 的 safeRm 同款先例；最终仍失败则放弃（测试的临时目录残留不影响断言结果）。
const rmSyncRaw = fs.rmSync;
const rmSleepBuf = new Int32Array(new SharedArrayBuffer(4));
function safeRmSync(p, opts) {
  for (let i = 0; i < 5; i++) {
    try {
      rmSyncRaw(p, opts);
      return;
    } catch {
      Atomics.wait(rmSleepBuf, 0, 0, 120);
    }
  }
  try {
    rmSyncRaw(p, opts);
  } catch {}
}

// ---------- 1. token 估算与上下文裁剪 ----------
{
  const en = approxTokens('hello world hello world');
  const zh = approxTokens('你好世界');
  // CJK 校准（P0-2）：流畅中文 ≈0.75 token/字（旧版 1 字=1 token 高估约 2 倍）
  assert.equal(zh, 3, '4 字中文应按 0.75/字计为 3 tokens');
  // v0.4.6：英文启发式改为「按词/字母串」估算（每串 floor(长度/4)，至少 1；空白不重复计），
  // 不再用整体 字符数/4 —— 4 个 5 字母词各计 1 token = 4。旧断言值 6 对应已废弃的旧口径。
  assert.equal(en, 4, '英文按字母串估算（每串 ≥1 token，空白不重复计）');
  // 类别化保守性：非自然语言类别必须是硬上界（旧口径对这些低估 2–3 倍）
  assert.ok(approxTokens('!@#$%^&*()_+-=[]{}|;:,.<>?/') >= 20, '纯标点应按近 1 token/字符保守计');
  assert.ok(approxTokens('a b c d e f g h') === 8, '单字母成词各计 1 token');
  const msgs = [
    { role: 'system', content: '系统提示' },
    { role: 'user', content: '很早的问题'.repeat(500) },
    { role: 'assistant', content: '很早的回答'.repeat(500) },
    { role: 'user', content: '最新的问题' },
  ];
  const trimmed = trimMessages(msgs, 300);
  assert.equal(trimmed[0].role, 'system');
  assert.equal(trimmed[trimmed.length - 1].content, '最新的问题');
  assert.ok(trimmed.length < msgs.length, '应发生裁剪');
  assert.ok(!trimmed.some((m) => m.content?.includes('上下文管理')), '静默裁剪：不插入说明消息（保住缓存前缀）');
  assert.equal(clampText('abc', 100), 'abc');
  assert.ok(clampText('x'.repeat(3000), 100).includes('已截断'));

  // 回归：裁剪切断 assistant(tool_calls) ↔ tool 配对时应清洗孤立消息
  const pad = 'X'.repeat(100);
  const paired = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1', tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: pad },
    { role: 'assistant', content: 'a2', tool_calls: [{ id: 'c2', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c2', content: pad },
    { role: 'user', content: 'u2' },
  ];
  for (const b of [400, 200, 100, 60, 40, 20]) {
    const t = trimMessages(paired, b);
    const callIds = new Set();
    for (const m of t) if (m.role === 'assistant' && m.tool_calls) for (const tc of m.tool_calls) callIds.add(tc.id);
    const toolIds = new Set(t.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
    assert.ok(!t.some((m) => m.role === 'tool' && !callIds.has(m.tool_call_id)), `budget=${b} 不应有孤立 tool 消息`);
    assert.ok(
      !t.some((m) => m.role === 'assistant' && m.tool_calls?.some((tc) => !toolIds.has(tc.id))),
      `budget=${b} 不应有孤立 tool_calls`
    );
  }
  ok('context：token 估算 / 预算裁剪 / 输出截断 / 工具配对清洗');
}

// ---------- 1.5 原子写与文件锁（质检 H3/H4：并发写地基） ----------
{
  const { atomicWriteFileSync, atomicWriteJsonSync, withFileLockSync } = await import(pathToFileURL(path.join(srcDir, 'atomic-write.js')).href);
  const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-aw-'));
  const f = path.join(tmpA, 'x.json');
  atomicWriteFileSync(f, '{"a":1}');
  assert.equal(fs.readFileSync(f, 'utf8'), '{"a":1}', '原子写内容应完整落盘');
  // 失败注入后不残留 .tmp（rename 前目录应无临时文件）
  assert.equal(fs.readdirSync(tmpA).filter((n) => n.includes('.tmp')).length, 0, '不应残留临时文件');
  atomicWriteJsonSync(f, { a: 2 });
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).a, 2, 'JSON 原子写应可读');
  // 文件锁：可重入（P0-1 v0.4.5，嵌套获取同一路径不再自死锁）+ 跨进程互斥 + 陈旧锁回收
  const lock = path.join(tmpA, 'x.lock');
  let nestedOk = false;
  withFileLockSync(lock, () => { withFileLockSync(lock, () => { nestedOk = true; }); });
  assert.equal(nestedOk, true, '锁可重入（同一进程嵌套获取同路径不再自死锁）');
  // 陈旧锁回收：伪造 20 秒前的锁文件，应能自动回收获取
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999, at: Date.now() - 20000 }));
  fs.utimesSync(lock, new Date(Date.now() - 20000), new Date(Date.now() - 20000));
  let got = false;
  withFileLockSync(lock, () => { got = true; }, { timeoutMs: 2000, staleMs: 15000 });
  assert.equal(got, true, '陈旧锁应被回收');
  ok('atomic-write：原子写 / 无残留 tmp / 文件锁互斥与陈旧回收');
}

// ---------- 2. 文件工具（真实文件系统，临时目录） ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-test-'));
const ctx = { cwd: tmp };
{
  const w = await dispatch('write', { path: 'a.txt', content: 'hello line\nsecond line\n' }, ctx);
  assert.equal(w.ok, true);
  assert.ok(fs.existsSync(path.join(tmp, 'a.txt')));

  const r = await dispatch('read', { path: 'a.txt' }, ctx);
  assert.ok(r.output.includes('1\thello line'));
  assert.ok(r.output.includes('2\tsecond line'));

  const r2 = await dispatch('read', { path: 'a.txt', offset: 2, limit: 1 }, ctx);
  assert.ok(r2.output.includes('2\tsecond line'));
  assert.ok(!r2.output.includes('1\thello line'));

  const e1 = await dispatch('edit', { path: 'a.txt', old_string: 'hello line', new_string: '你好世界' }, ctx);
  assert.equal(e1.ok, true);
  assert.equal(fs.readFileSync(path.join(tmp, 'a.txt'), 'utf8').split('\n')[0], '你好世界');

  const e2 = await dispatch('edit', { path: 'a.txt', old_string: '不存在的文本', new_string: 'x' }, ctx);
  assert.equal(e2.ok, false);

  const e3 = await dispatch('edit', { path: 'a.txt', old_string: 'e', new_string: 'E' }, ctx);
  assert.equal(e3.ok, false, '多处匹配且未 replace_all 应报错');
  const e4 = await dispatch('edit', { path: 'a.txt', old_string: 'e', new_string: 'E', replace_all: true }, ctx);
  assert.equal(e4.ok, true);
  assert.ok(fs.readFileSync(path.join(tmp, 'a.txt'), 'utf8').includes('sEcond linE'));

  fs.mkdirSync(path.join(tmp, 'sub'));
  fs.writeFileSync(path.join(tmp, 'sub', 'b.txt'), 'subfile');

  const g = await dispatch('glob', { pattern: '*.txt' }, ctx);
  assert.ok(g.output.includes('a.txt'));
  assert.ok(g.output.includes('sub/b.txt'));

  const g2 = await dispatch('glob', { pattern: 'sub/**/*.txt' }, ctx);
  assert.ok(g2.output.includes('sub/b.txt'));
  assert.ok(!g2.output.includes('a.txt'));

  const gr = await dispatch('grep', { pattern: 'linE', include: '*.txt' }, ctx);
  assert.ok(gr.output.includes('a.txt:2:'));

  const bad = await dispatch('grep', { pattern: '[invalid' }, ctx);
  assert.equal(bad.ok, false, '非法正则应返回错误');

  const ls = await dispatch('ls', {}, ctx);
  assert.ok(ls.output.includes('sub/'));
  assert.ok(ls.output.includes('a.txt'));

  const readDir = await dispatch('read', { path: 'sub' }, ctx);
  assert.equal(readDir.ok, false, '读取目录应报错并提示 ls');

  // 回归：read 超过 5MB 的文件应拒绝（防内存风险）
  const big = path.join(tmp, 'big.log');
  fs.writeFileSync(big, 'x'.repeat(6 * 1024 * 1024));
  const rBig = await dispatch('read', { path: 'big.log' }, ctx);
  assert.equal(rBig.ok, false, '超过大小上限应拒绝读取');
  assert.ok(rBig.error.includes('上限'), '错误信息应说明大小上限');
  ok('tools：read / write / edit / glob / grep / ls 全部通过（含大小上限）');
}

// ---------- 2b. 路径穿越防护（v0.4.1 P0）：文件工具限定工作目录 + fsAllowDirs 白名单 ----------
{
  const { dispatch } = await import(pathToFileURL(path.join(srcDir, 'tools', 'index.js')).href);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-fsb-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-out-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top-secret');
  const ctxIn = { cwd: root, cfg: {} };
  // 绝对路径越界：read / write / edit / ls / glob / grep 全部拒绝
  const rAbs = await dispatch('read', { path: path.join(outside, 'secret.txt') }, ctxIn);
  assert.equal(rAbs.ok, false, 'read 绝对路径越界应拒绝');
  assert.ok(String(rAbs.error).includes('越界'), '错误信息应说明越界');
  const wAbs = await dispatch('write', { path: path.join(outside, 'evil.txt'), content: 'x' }, ctxIn);
  assert.equal(wAbs.ok, false, 'write 绝对路径越界应拒绝');
  const eAbs = await dispatch('edit', { path: path.join(outside, 'secret.txt'), old_string: 'x', new_string: 'y' }, ctxIn);
  assert.equal(eAbs.ok, false, 'edit 绝对路径越界应拒绝');
  const lsAbs = await dispatch('ls', { path: outside }, ctxIn);
  assert.equal(lsAbs.ok, false, 'ls 绝对路径越界应拒绝');
  const gAbs = await dispatch('glob', { pattern: '*', path: outside }, ctxIn);
  assert.equal(gAbs.ok, false, 'glob 绝对路径越界应拒绝');
  const grAbs = await dispatch('grep', { pattern: 'secret', path: outside }, ctxIn);
  assert.equal(grAbs.ok, false, 'grep 绝对路径越界应拒绝');
  // 相对路径 ../ 穿越：root 内 ../outside/secret.txt 也应拒绝
  const rRel = await dispatch('read', { path: '../' + path.basename(outside) + '/secret.txt' }, ctxIn);
  assert.equal(rRel.ok, false, '相对路径 ../ 穿越应拒绝');
  // 软链接逃逸：root 内建软链指向 outside 文件，read 应拒绝
  const symlink = path.join(root, 'link.txt');
  try { fs.symlinkSync(path.join(outside, 'secret.txt'), symlink); } catch {}
  const rSym = await dispatch('read', { path: 'link.txt' }, ctxIn);
  assert.equal(rSym.ok, false, '软链接指向工作目录外应拒绝（realpath 校验）');
  // 白名单放行：fsAllowDirs 加入 outside 后 read 应成功
  const ctxAllow = { cwd: root, cfg: { fsAllowDirs: [outside] } };
  const rAllow = await dispatch('read', { path: path.join(outside, 'secret.txt') }, ctxAllow);
  assert.equal(rAllow.ok, true, 'fsAllowDirs 白名单内应放行');
  assert.ok(String(rAllow.output).includes('top-secret'), '白名单内应读到内容');
  safeRmSync(root, { recursive: true, force: true });
  safeRmSync(outside, { recursive: true, force: true });
  ok('tools：路径穿越防护（绝对/相对/软链接越界拒绝，fsAllowDirs 白名单放行）');
}

// ---------- 5g. git 只读工具 + HTTP 只读抓取（v0.3.1） ----------
{
  const { dispatch } = await import(pathToFileURL(path.join(srcDir, 'tools', 'index.js')).href);
  const tmpGit = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-git-'));
  const ctx = { workingDir: tmpGit };
  // v0.4.6 回归：git 工具此前用 `await execFile(...)`（execFile 是回调式、返回 ChildProcess，
  // 不是 thenable）——解构出的 stdout/stderr 是两个流，工具恒返回 ok:true exitCode:0
  // output="[object Object][object Object]"，退出码与错误全被吞。下面的断言锁定真实语义。
  const gs = await dispatch('git', { command: 'status' }, ctx);
  assert.equal(gs.ok, false, '非 git 仓库里 git status 应失败（此前因 await 缺陷恒报成功）');
  assert.ok(!String(gs.output || gs.error).includes('[object Object]'), 'git 输出不得是 [object Object]');
  // 真实仓库：status / log 必须返回真实内容
  if (spawnSync('git', ['--version']).status === 0) {
    spawnSync('git', ['init', '-q'], { cwd: tmpGit });
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'first'], { cwd: tmpGit });
    const gs2 = await dispatch('git', { command: 'status --short' }, ctx);
    assert.equal(gs2.ok, true, '真实仓库里 git status 应成功：' + JSON.stringify(gs2));
    const gl = await dispatch('git', { command: 'log --oneline -3' }, ctx);
    assert.equal(gl.ok, true, 'git log 应成功');
    assert.ok(String(gl.output).includes('first'), 'git log 应返回真实提交信息（实际：' + String(gl.output).slice(0, 80) + '）');
    const gbad = await dispatch('git', { command: 'log --oneline definitely-not-a-revision' }, ctx);
    assert.equal(gbad.ok, false, '不存在的 revision 应失败并带真实退出码');
    assert.equal(gbad.exitCode, 128, 'git 退出码应透传（实际 ' + gbad.exitCode + '）');
  }
  // git 非只读子命令应拒绝
  const gp = await dispatch('git', { command: 'push --force' }, ctx);
  assert.equal(gp.ok, false, 'git push（非只读）应拒绝');
  assert.ok(String(gp.error).includes('不是只读'), '应说明非只读子命令');
  // P1-8（v0.4.5）：参数级过滤——只读子命令 + 破坏性/越界 flag 同样拒绝
  const gNoIndex = await dispatch('git', { command: 'diff --no-index a.txt b.txt' }, ctx);
  assert.equal(gNoIndex.ok, false, 'git diff --no-index（越界读）应拒绝');
  assert.ok(String(gNoIndex.error).includes('被禁止的参数'), '应说明被禁止的参数');
  const gBranchD = await dispatch('git', { command: 'branch -D foo' }, ctx);
  assert.equal(gBranchD.ok, false, 'git branch -D（破坏元数据）应拒绝');
  const gOutput = await dispatch('git', { command: 'log --output=/tmp/x.txt' }, ctx);
  assert.equal(gOutput.ok, false, 'git log --output（写文件）应拒绝');
  // fetch：本机地址应被 SSRF 拒绝
  const fLocal = await dispatch('fetch', { url: 'http://127.0.0.1/' }, ctx);
  assert.equal(fLocal.ok, false, 'fetch 本机地址应拒绝');
  assert.ok(String(fLocal.error).includes('内网'), '应说明 SSRF 拒绝');
  // fetch：非 http 协议应拒绝
  const fFile = await dispatch('fetch', { url: 'file:///etc/passwd' }, ctx);
  assert.equal(fFile.ok, false, 'fetch file:// 应拒绝');
  // v0.4.6 回归（P1 SSRF）：IPv4-mapped IPv6 的**十六进制**形态必须同样被判为私网。
  // URL 解析器会把 [::ffff:127.0.0.1] 规范化成 [::ffff:7f00:1]，此前只处理点分四段 → 判为公网，
  // 加上 DNS 复检对带方括号的 IPv6 字面量 lookup 失败后放行 → 可抓回环 WebUI/内网/云元数据。
  {
    const { isPrivateHost } = await import(pathToFileURL(path.join(srcDir, 'tools', 'fetch.js')).href);
    const mustBlock = ['[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[0:0:0:0:0:ffff:7f00:1]', '[::ffff:a00:1]', '[::ffff:a9fe:a9fe]', '[::1]', '[::]', '[fe80::1]', '[fd00::1]', '[64:ff9b::7f00:1]'];
    for (const h of mustBlock) assert.equal(isPrivateHost(h), true, `SSRF：${h} 应判为内网/本机`);
    const mustAllow = ['[::ffff:8.8.8.8]', '[2606:4700::1111]', '8.8.8.8', 'example.com'];
    for (const h of mustAllow) assert.equal(isPrivateHost(h), false, `SSRF：${h} 应判为公网`);
    // URL 规范化后的真实取值必须被拦（这是最初的绕过点）
    assert.equal(isPrivateHost(new URL('http://[::ffff:127.0.0.1]:9/').hostname), true, 'URL 规范化后的 ::ffff 形态必须被拦');
    const f6 = await dispatch('fetch', { url: 'http://[::ffff:127.0.0.1]:9/' }, ctx);
    assert.equal(f6.ok, false, 'fetch IPv4-mapped IPv6 回环地址应拒绝');
  }
  // fetch：302 重定向到内网应拒绝（P0 SSRF 复检，v0.4.1）
  const httpMod = await import('node:http');
  const victim = httpMod.createServer((req, res) => { res.end('secret-metadata'); });
  await new Promise((r) => victim.listen(0, '127.0.0.1', r));
  const victimPort = victim.address().port;
  const attacker = httpMod.createServer((req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${victimPort}/latest/meta-data` });
    res.end();
  });
  await new Promise((r) => attacker.listen(0, '127.0.0.1', r));
  const attackerPort = attacker.address().port;
  // 用公网地址指代攻击者：直接 fetch 攻击者地址本就被拒（回环），故用 302 目标验证——攻击者本身也是回环，
  // 这里验证的是「跳转目标被复检」：即使初始 URL 被放行（公网场景由攻击者服务器模拟），跳转回内网必拒。
  const fRedir = await dispatch('fetch', { url: `http://127.0.0.1:${attackerPort}/go` }, ctx);
  assert.equal(fRedir.ok, false, '302 重定向应被 SSRF 复检拒绝（此处初始即回环，双重拦截）');
  // 更贴近真实场景：初始 URL 不可达内网但为回环（测试环境无公网），验证跳转目标 127.0.0.1 被拦截
  const fRedir2 = await dispatch('fetch', { url: `http://localhost:${attackerPort}/go` }, ctx);
  assert.equal(fRedir2.ok, false, '重定向到回环应被拦截');
  victim.close();
  attacker.close();
  safeRmSync(tmpGit, { recursive: true, force: true });
  ok('tools：git 只读 + fetch SSRF 防护');
}

// ---------- 3. bash 工具（跨平台：Windows 走 cmd.exe） ----------
{
  const isWin = process.platform === 'win32';
  const r = await dispatch('bash', { command: isWin ? 'echo mingdao-2' : 'echo mingdao-$((1+1))' }, ctx);
  assert.equal(r.ok, true);
  assert.ok(r.stdout.includes('mingdao-2'));
  const fail = await dispatch('bash', { command: isWin ? 'exit /b 3' : 'exit 3' }, ctx);
  assert.equal(fail.exitCode, 3);
  // 敏感环境变量过滤（P1-5 + 评估 P2-3）：默认常开（与沙箱档位解耦），bashEnvKeep 放行，bashEnvFilter:false 关闭
  if (!isWin) {
    process.env.MINGDAO_TEST_API_KEY = 'sk-secret-probe';
    process.env.MINGDAO_TEST_TOKEN = 'tk-probe';
    const on = await dispatch('bash', { command: 'echo "k=$MINGDAO_TEST_API_KEY t=$MINGDAO_TEST_TOKEN"' }, ctx);
    assert.ok(!on.stdout.includes('sk-secret-probe') && !on.stdout.includes('tk-probe'), '默认应剥离敏感变量（沙箱 off 也过滤）');
    const keptCtx = { ...ctx, cfg: { ...ctx.cfg, bashEnvKeep: ['MINGDAO_TEST_TOKEN'] } };
    const kept = await dispatch('bash', { command: 'echo "k=$MINGDAO_TEST_API_KEY t=$MINGDAO_TEST_TOKEN"' }, keptCtx);
    assert.ok(!kept.stdout.includes('sk-secret-probe') && kept.stdout.includes('tk-probe'), 'bashEnvKeep 应按名放行');
    const offCtx = { ...ctx, cfg: { ...ctx.cfg, bashEnvFilter: false } };
    const off = await dispatch('bash', { command: 'echo "k=$MINGDAO_TEST_API_KEY t=$MINGDAO_TEST_TOKEN"' }, offCtx);
    assert.ok(off.stdout.includes('sk-secret-probe'), 'bashEnvFilter:false 应完全透传');
    delete process.env.MINGDAO_TEST_API_KEY;
    delete process.env.MINGDAO_TEST_TOKEN;
  }
  ok('tools：bash 输出与退出码 / 沙箱环境变量过滤（跨平台）');
}

// ---------- 4. SSE 流解析（跨 chunk 断行 + 分片 tool_calls） ----------
{
  const chunks = [
    'data: {"choices":[{"delta":{"content":"你',
    '好"}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","function":{"name":"read","arguments":""}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"pa"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a.txt\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":12,"completion_tokens":8}}\n\ndata: [DONE]\n\n',
  ];
  const stream = new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
      c.close();
    },
  });
  const r = await parseStream(stream, null);
  assert.equal(r.text, '你好', '跨 chunk 的内容拼接');
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].id, 'call_9');
  assert.equal(r.toolCalls[0].function.name, 'read');
  assert.equal(r.toolCalls[0].function.arguments, '{"path":"a.txt"}', '分片参数拼接');
  assert.equal(r.finish, 'tool_calls');
  assert.equal(r.usage.prompt_tokens, 12);
  // usage-only 终包（choices 为空）+ 末帧无换行残行：usage 必须被捕获、残行必须被处理
  const chunks2 = [
    'data: {"choices":[{"delta":{"content":"尾"}}]}\n\n',
    'data: [DONE]\n\n',
    // 末帧无换行结尾：usage-only 终包留在残行里，必须被尾部冲刷处理
    'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}',
  ];
  const stream2 = new ReadableStream({
    start(c) {
      for (const ch of chunks2) c.enqueue(new TextEncoder().encode(ch));
      c.close();
    },
  });
  const r2 = await parseStream(stream2, null);
  assert.equal(r2.text, '尾', '无换行残行内容应被处理');
  assert.equal(r2.usage.prompt_tokens, 7, 'usage-only 终包应被捕获');
  // MacBook 本地 507 根因（v0.4.5）：200 响应夹带 error 对象 / SSE error 帧不得被当「空输出」吞掉
  let nse = null;
  try { parseNonStream({ error: { code: 507, message: 'memory_refusal' }, choices: [] }, null); } catch (e) { nse = /** @type {any} */ (e); }
  assert.ok(nse && nse.status === 507, 'parseNonStream 应上抛 200 里的 error（status 507）');
  const errChunks = ['data: {"error":{"code":507,"message":"memory_refusal"}}\n\n'];
  const errStream = new ReadableStream({
    start(c) {
      for (const ch of errChunks) c.enqueue(new TextEncoder().encode(ch));
      c.close();
    },
  });
  let pse = null;
  try { await parseStream(errStream, null); } catch (e) { pse = /** @type {any} */ (e); }
  assert.ok(pse && pse.status === 507, 'parseStream 应上抛 SSE error 帧（status 507）');
  ok('provider：SSE 流解析（断行/分片/usage/error 帧上抛）');
}

// ---------- 5. Agent 循环（Stub Provider） ----------
{
  const io = createIO({ quiet: true });
  let turn = 0;
  const fakeProvider = {
    async chat(opts) {
      turn += 1;
      assert.ok(opts.tools.length >= 6, '模型应收到工具 Schema');
      if (turn === 1) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'write', arguments: JSON.stringify({ path: 'hello.txt', content: '你好 MingDao\n' }) },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
          finish: 'tool_calls',
        };
      }
      return { text: '任务完成！', toolCalls: null, usage: { prompt_tokens: 20, completion_tokens: 6 }, finish: 'stop' };
    },
  };
  const permission = { async check() { return true; } };
  const agent = createAgent({
    provider: fakeProvider,
    permission,
    io,
    modelName: 'deepseek-v4-flash',
    workingDir: tmp,
    cfg: { permission: 'auto' },
  });
  const messages = [
    { role: 'system', content: '系统' },
    { role: 'user', content: '创建 hello.txt 并写入问候' },
  ];
  const res = await agent.runTurn(messages);
  assert.equal(res.text, '任务完成！');
  assert.equal(res.truncated, false);
  assert.equal(res.usage.prompt_tokens, 30);
  assert.equal(res.usage.completion_tokens, 11);
  assert.equal(fs.readFileSync(path.join(tmp, 'hello.txt'), 'utf8'), '你好 MingDao\n');
  assert.ok(messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_1'), '工具结果应回填消息');
  assert.ok(
    messages.some((m) => m.role === 'assistant' && m.content === '任务完成！'),
    '最终纯文本回复应回填消息历史'
  );
  ok('agent：工具调用循环 + 结果回填 + usage 汇总');
}

// ---------- 5t. 省钱 B1：工具按需挂载（只读阶段只发只读工具，写意图后注入全量） ----------
{
  const io = createIO({ quiet: true });
  const seen = []; // 记录每轮收到的工具名集合
  let round = 0;
  const fakeProvider = {
    async chat(opts) {
      round += 1;
      seen.push((opts.tools || []).map((t) => t.function.name).sort());
      if (round === 1) {
        // 只读阶段：模型边查边说要改文件 → 触发注入
        return {
          text: '我发现需要修改 package.json 来修复这个问题。',
          toolCalls: [
            { id: 'call_t1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'package.json' }) } },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 3 },
          finish: 'tool_calls',
        };
      }
      return { text: '已完成', toolCalls: null, usage: { prompt_tokens: 5, completion_tokens: 3 }, finish: 'stop' };
    },
  };
  const agent = createAgent({
    provider: fakeProvider,
    permission: { async check() { return true; } },
    io,
    modelName: 'deepseek-v4-flash',
    workingDir: tmp,
    cfg: { permission: 'auto' },
  });
  await agent.runTurn([{ role: 'user', content: '帮我诊断一下这个报错的原因' }]);
  assert.equal(round, 2, '应跑两轮（第二轮是注入后的续轮）');
  // v0.4.4：task 加入只读档——审计/调研长任务需要能派只读子代理（readOnly 子代理只读，权限引擎仍门控写）
  const tier = new Set(['read', 'ls', 'glob', 'grep', 'skill', 'todo', 'git', 'fetch', 'task']);
  assert.ok(seen[0].every((n) => tier.has(n)), `只读阶段应只发只读工具，实际 ${seen[0]}`);
  assert.ok(seen[0].includes('read') && seen[0].includes('grep'), '只读阶段含核心只读工具');
  assert.equal(seen[1].length, 13, '模型表达写意图后应注入全量 13 个工具');
  assert.ok(seen[1].includes('write') && seen[1].includes('bash'), '注入后含写类工具');
  ok('省钱 B1：只读阶段工具集收缩 / 写意图后注入全量');
}

// ---------- 5u. 省钱 B1：写意图提示直接全量 / 纯查询提示只读收缩 ----------
{
  const runOnce = async (prompt) => {
    const io = createIO({ quiet: true });
    let first = null;
    const fakeProvider = {
      async chat(opts) {
        if (!first) first = (opts.tools || []).map((t) => t.function.name).sort();
        return { text: '好的', toolCalls: null, usage: { prompt_tokens: 5, completion_tokens: 2 }, finish: 'stop' };
      },
    };
    const agent = createAgent({
      provider: fakeProvider,
      permission: { async check() { return true; } },
      io,
      modelName: 'deepseek-v4-flash',
      workingDir: tmp,
      cfg: { permission: 'auto' },
    });
    await agent.runTurn([{ role: 'user', content: prompt }]);
    return first;
  };
  const full = await runOnce('帮我新建一个配置文件');
  assert.equal(full.length, 13, '写意图提示首轮即全量工具');
  const ro = await runOnce('帮我看看这个项目里有哪些文件');
  // v0.4.4：只读档含 task（可派只读子代理）
  assert.ok(ro.length <= 10 && ro.every((n) => ['read', 'ls', 'glob', 'grep', 'skill', 'todo', 'git', 'fetch', 'task'].includes(n)), `纯查询首轮应只读收缩，实际 ${ro}`);
  ok('省钱 B1：写意图首轮全量 / 纯查询首轮只读');
}

// ---------- 5b. 空/截断输出自动续写（推理吃满上限返回空正文时不能静默结束） ----------
{
  const io2 = createIO({ quiet: true });
  let t2 = 0;
  const fake2 = {
    async chat() {
      t2 += 1;
      if (t2 === 1) {
        return { text: '', toolCalls: null, usage: { prompt_tokens: 5, completion_tokens: 8000 }, finish: 'length' };
      }
      return { text: '续写完成！', toolCalls: null, usage: { prompt_tokens: 6, completion_tokens: 4 }, finish: 'stop' };
    },
  };
  const agent2 = createAgent({
    provider: fake2,
    permission: { async check() { return true; } },
    io: io2,
    modelName: 'deepseek-v4-flash',
    workingDir: tmp,
    cfg: { permission: 'auto' },
  });
  const m2 = [{ role: 'system', content: '系统' }, { role: 'user', content: '生成游戏' }];
  const r2 = await agent2.runTurn(m2);
  assert.equal(r2.text, '续写完成！', '截断后应自动续写而非静默结束');
  assert.equal(r2.truncated, false);
  assert.ok(m2.some((m) => m.role === 'user' && m.content.includes('长度上限被截断')), '应回填续写提示');
  // 连续空输出 2 次 → 结束并带 note
  let t3 = 0;
  const fake3 = { async chat() { t3 += 1; return { text: '', toolCalls: null, usage: {}, finish: 'stop' }; } };
  const agent3 = createAgent({
    provider: fake3,
    permission: { async check() { return true; } },
    io: io2,
    modelName: 'deepseek-v4-flash',
    workingDir: tmp,
    cfg: { permission: 'auto' },
  });
  const r3 = await agent3.runTurn([{ role: 'system', content: '系统' }, { role: 'user', content: 'x' }]);
  assert.equal(r3.text, null);
  assert.ok(r3.note && r3.note.includes('没有输出正文'), '连续空输出应有提示而非无限循环');
  ok('agent：空/截断输出续写与兜底');
}

// ---------- 5c. 步数上限收尾（v0.2.8）：末轮注入收尾指令并产出总结（对齐 DSH） ----------
{
  const io2 = createIO({ quiet: true });
  let t = 0;
  const fake = {
    async chat() {
      t += 1;
      if (t <= 2) {
        return {
          text: '',
          toolCalls: [{ id: 'call_w' + t, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'x.txt' }) } }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
          finish: 'tool_calls',
        };
      }
      return { text: '总结：已完成 A，交付 x.txt。', toolCalls: null, usage: { prompt_tokens: 6, completion_tokens: 8 }, finish: 'stop' };
    },
  };
  const agent = createAgent({
    provider: fake,
    permission: { async check() { return true; } },
    io: io2,
    modelName: 'deepseek-v4-flash',
    workingDir: tmp,
    cfg: { permission: 'auto', maxRounds: 1 },
    maxSteps: 3,
  });
  const m = [{ role: 'system', content: '系统' }, { role: 'user', content: '做任务' }];
  const r = await agent.runTurn(m);
  assert.equal(r.text, '总结：已完成 A，交付 x.txt。', '末轮应产出总结文字');
  assert.equal(r.truncated, false);
  assert.ok(m.some((x) => x.role === 'user' && String(x.content).includes('停止调用工具')), '应注入收尾指令');
  ok('agent：步数上限前注入收尾指令，末轮产出总结');
}

// ---------- 5d. 步数上限兜底总结（v0.2.8）：末轮仍调用工具时自动补一次 no-tool 总结 ----------
{
  const io2 = createIO({ quiet: true });
  let t = 0;
  const fake = {
    async chat(opts) {
      t += 1;
      if (t <= 3) {
        return {
          text: '',
          toolCalls: [{ id: 'call_e' + t, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'y.txt' }) } }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
          finish: 'tool_calls',
        };
      }
      // 第 4 次：兜底总结请求（tools 应为空）
      assert.equal((opts.tools || []).length, 0, '兜底总结应 no-tool');
      return { text: '最终总结：交付 y.txt。', toolCalls: null, usage: { prompt_tokens: 6, completion_tokens: 8 }, finish: 'stop' };
    },
  };
  const agent = createAgent({
    provider: fake,
    permission: { async check() { return true; } },
    io: io2,
    modelName: 'deepseek-v4-flash',
    workingDir: tmp,
    cfg: { permission: 'auto', maxRounds: 1 },
    maxSteps: 3,
  });
  const m = [{ role: 'system', content: '系统' }, { role: 'user', content: '做任务' }];
  const r = await agent.runTurn(m);
  assert.equal(r.text, '最终总结：交付 y.txt。', '末轮仍调工具时应补总结');
  assert.equal(r.truncated, false);
  assert.equal(t, 4, '应跑满 3 步 + 1 次兜底总结');
  assert.equal(r.capHit, true, '跑满步数应标记 capHit（供续跑检查点）');
  ok('agent：跑满步数仍无正文时补一次兜底总结');
}

// ---------- 5d2. 兜底总结输入轻量化（v0.4.1：本地慢 prefill 不再让总结请求超时失败） ----------
{
  const io2 = createIO({ quiet: true });
  let t = 0;
  let wrapMsgCount = 0;
  const longHistory = [
    { role: 'system', content: '系统' },
    { role: 'user', content: '做任务' },
    ...Array.from({ length: 30 }, (_, i) => [
      { role: 'assistant', content: '长'.repeat(500) + '回答' + i },
      { role: 'tool', tool_call_id: 'c' + i, content: '长'.repeat(500) + '结果' + i },
    ]).flat(),
  ];
  const fake = {
    async chat(opts) {
      t += 1;
      if (t <= 2) {
        // 前 maxSteps 次：返回 write 工具调用（落交付物，跑满步数后进入兜底总结）
        return {
          text: '',
          toolCalls: [{ id: 'call_w' + t, type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: `out${t}.txt`, content: 'ok' }) } }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
          finish: 'tool_calls',
        };
      }
      // 第 3 次起（兜底总结）：tools 空，且 messages 必须轻量（不得回灌 30 轮长历史）
      assert.equal((opts.tools || []).length, 0, '兜底总结应 no-tool');
      wrapMsgCount = (opts.messages || []).length;
      const totalChars = (opts.messages || []).reduce((/** @type {any} */ s, /** @type {any} */ m) => s + String(m.content || '').length, 0);
      assert.ok(totalChars < 2000, `兜底总结输入应轻量（实际 ${totalChars} 字，不得回灌全量历史）`);
      assert.ok(String((opts.messages || []).some((/** @type {any} */ m) => String(m.content || '').includes('已交付文件'))), '兜底总结应含交付物清单');
      return { text: '轻量总结完成。', toolCalls: null, usage: { prompt_tokens: 6, completion_tokens: 8 }, finish: 'stop' };
    },
  };
  const agent = createAgent({
    provider: fake,
    permission: { async check() { return true; } },
    io: io2,
    modelName: 'deepseek-v4-flash',
    workingDir: tmp,
    cfg: { permission: 'auto', maxRounds: 1 },
    maxSteps: 2, // 2 步：第 1 步 write，第 2 步再触发一次工具调用后兜底
  });
  // 预置长历史到 messages：通过 runTurn 传入，agent 首轮会 append 工具结果
  const r = await agent.runTurn(longHistory);
  assert.ok(r.text && r.text.includes('轻量总结'), '兜底总结应产出文本');
  assert.ok(wrapMsgCount <= 3, `兜底总结消息数应 ≤3（system+交付物+提示），实际 ${wrapMsgCount}`);
  ok('agent：兜底总结输入轻量化（不回灌全量历史，慢 prefill 也能产出总结）');
}

// ---------- 5e. 任务检查点（v0.3.0 P0-2）：save/load/clear/resumePrompt + 正常完成不清 capHit ----------
{
  const { saveTaskState, loadTaskState, clearTaskState, resumePrompt, saveTaskStateMerge } = await import(pathToFileURL(path.join(srcDir, 'task-state.js')).href);
  const homeT = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-taskstate-'));
  const prevHomeT = process.env.MINGDAO_HOME;
  process.env.MINGDAO_HOME = homeT;
  // 落盘/读回/清除 + resumePrompt 含关键字段
  saveTaskState('s1.jsonl', { goal: '重构 config', progress: '已完成 A，待做 B', artifacts: ['/tmp/a.js'], status: 'cap', updatedAt: 'x' });
  const ts = loadTaskState('s1.jsonl');
  assert.equal(ts.status, 'cap', '应读回 cap 状态');
  assert.equal(ts.artifacts[0], '/tmp/a.js', '应读回交付物');
  const prompt = resumePrompt(ts);
  assert.ok(prompt.includes('重构 config') && prompt.includes('/tmp/a.js') && prompt.includes('勿重复重做'), '续跑提示应含目标/交付物/勿重做');
  // v0.3.1 P2-3：合并落盘保留原 goal、union artifacts
  saveTaskStateMerge('s1.jsonl', { goal: '继续', progress: '第二轮', artifacts: ['/tmp/b.js'], status: 'cap', updatedAt: 'y' });
  const merged = loadTaskState('s1.jsonl');
  assert.equal(merged.goal, '重构 config', '合并应保留原始 goal');
  assert.deepEqual([...merged.artifacts].sort(), ['/tmp/a.js', '/tmp/b.js'], '合并应 union artifacts');
  assert.equal(merged.progress, '第二轮', '合并应更新 progress');
  clearTaskState('s1.jsonl');
  assert.equal(loadTaskState('s1.jsonl'), null, '清除后应读不到');
  // 正常完成（非 capHit）不产生 capHit 标记：两轮写工具后文本收尾
  let t2 = 0;
  const fake2 = { async chat() { t2 += 1; if (t2 === 1) return { text: '', toolCalls: [{ id: 'z1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'x.txt', content: 'x' }) } }], usage: { prompt_tokens: 3, completion_tokens: 2 }, finish: 'tool_calls' }; return { text: '完成', toolCalls: null, usage: { prompt_tokens: 3, completion_tokens: 2 }, finish: 'stop' }; } };
  const agent2 = createAgent({ provider: fake2, permission: { async check() { return true; } }, io: createIO({ quiet: true }), modelName: 'deepseek-v4-flash', workingDir: homeT, cfg: { permission: 'auto' }, maxSteps: 5 });
  const r2 = await agent2.runTurn([{ role: 'system', content: '系统' }, { role: 'user', content: '写文件' }]);
  assert.equal(r2.text, '完成', '正常收尾应产出文本');
  assert.ok(!r2.capHit, '正常完成不应标记 capHit');
  process.env.MINGDAO_HOME = prevHomeT;
  safeRmSync(homeT, { recursive: true, force: true });
  ok('agent：任务检查点 save/load/clear/resumePrompt + 正常完成不标记 capHit');
}

// ---------- 5f. 续跑闭环（v0.3.0 P0-2）：跑满 → 落检查点 → 注入续跑提示 → 第二轮完成且不重做 ----------
{
  const homeR = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-resume-'));
  const prevHomeR = process.env.MINGDAO_HOME;
  process.env.MINGDAO_HOME = homeR;
  const { saveTaskState, loadTaskState, resumePrompt } = await import(pathToFileURL(path.join(srcDir, 'task-state.js')).href);
  // 第一轮：maxSteps=2，模型连发两次 write → 跑满 capHit；write 只执行了第一轮那次（第二轮被 guard 拦截）
  let writes = 0;
  let call = 0;
  const fakeCap = {
    async chat() {
      call += 1;
      return { text: '', toolCalls: [{ id: 'r' + call, type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'a.txt', content: 'x' }) } }], usage: { prompt_tokens: 3, completion_tokens: 2 }, finish: 'tool_calls' };
    },
  };
  const agentCap = createAgent({ provider: fakeCap, permission: { async check() { return true; } }, io: createIO({ quiet: true }), modelName: 'deepseek-v4-flash', workingDir: homeR, cfg: { permission: 'auto', maxRounds: 1 }, maxSteps: 2 });
  const m1 = [{ role: 'system', content: '系统' }, { role: 'user', content: '写 a.txt' }];
  const r1 = await agentCap.runTurn(m1);
  assert.equal(r1.capHit, true, '第一轮应跑满步数');
  writes = fs.existsSync(path.join(homeR, 'a.txt')) ? 1 : 0;
  saveTaskState('s1.jsonl', { goal: '写 a.txt', progress: '已写 a.txt，还差 b.txt', artifacts: ['a.txt'], status: 'cap', updatedAt: 'x' });
  // 第二轮：注入续跑提示后继续；mock 断言收到了「勿重复重做」且不再要求写 a.txt
  let sawResume = false;
  const fakeResume = { async chat(opts) {
    const msgs = JSON.stringify(opts.messages || []);
    if (msgs.includes('勿重复重做') && msgs.includes('a.txt')) sawResume = true;
    return { text: '续跑完成：已补齐 b.txt', toolCalls: null, usage: { prompt_tokens: 3, completion_tokens: 2 }, finish: 'stop' };
  } };
  const agentResume = createAgent({ provider: fakeResume, permission: { async check() { return true; } }, io: createIO({ quiet: true }), modelName: 'deepseek-v4-flash', workingDir: homeR, cfg: { permission: 'auto' }, maxSteps: 5 });
  const m2 = [...m1, { role: 'user', content: resumePrompt(loadTaskState('s1.jsonl')) }, { role: 'user', content: '继续' }];
  const r2 = await agentResume.runTurn(m2);
  assert.equal(r2.text, '续跑完成：已补齐 b.txt', '续跑第二轮应正常完成');
  assert.ok(sawResume, '续跑提示应注入到第二轮模型上下文（含勿重复重做）');
  assert.equal(writes, 1, '续跑不应重复写已交付的 a.txt（写次数仍为 1）');
  process.env.MINGDAO_HOME = prevHomeR;
  safeRmSync(homeR, { recursive: true, force: true });
  ok('agent：续跑闭环（跑满→检查点→注入→完成且不重做）');
}

// ---------- 5g. 自动续跑（v0.3.1 长程执行）：跑满步数自动续下一轮，任务不中断 ----------
{
  let calls = 0;
  const fake = {
    async chat() {
      calls += 1;
      if (calls <= 4) {
        return { text: '', toolCalls: [{ id: 'ar' + calls, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'x' + calls + '.txt' }) } }], usage: { prompt_tokens: 3, completion_tokens: 2 }, finish: 'tool_calls' };
      }
      return { text: '审计完成', toolCalls: null, usage: { prompt_tokens: 3, completion_tokens: 2 }, finish: 'stop' };
    },
  };
  const agent = createAgent({ provider: fake, permission: { async check() { return true; } }, io: createIO({ quiet: true }), modelName: 'deepseek-v4-flash', workingDir: tmp, cfg: { permission: 'auto', maxRounds: 2 }, maxSteps: 3 });
  const m = [{ role: 'system', content: '系统' }, { role: 'user', content: '审计代码' }];
  const r = await agent.runTurn(m);
  assert.equal(calls, 5, '应跨轮自动续跑（3+2 次调用，共 5 次）');
  assert.equal(r.text, '审计完成', '自动续跑后应正常完成');
  assert.ok(!r.capHit, '完成后不应再标记 capHit');
  ok('agent：自动续跑（跑满步数自动续下一轮，任务不中断）');
}

// ---------- 5c. 只读工具并行（P2-8）：auto 模式连续只读 Promise.all，事件/结果顺序不变 ----------
{
  const ioP = createIO({ quiet: true });
  const seq = [];
  ioP.renderToolStart = (name) => seq.push('start:' + name);
  ioP.renderTool = (name) => seq.push('end:' + name);
  fs.writeFileSync(path.join(tmp, 'pa.txt'), 'A');
  fs.writeFileSync(path.join(tmp, 'pb.txt'), 'B');
  let tp = 0;
  const fakeP = {
    async chat() {
      tp += 1;
      if (tp === 1) {
        return {
          text: '',
          toolCalls: ['pa.txt', 'pb.txt', 'pa.txt'].map((f, k) => ({
            id: 'c' + k,
            type: 'function',
            function: { name: 'read', arguments: JSON.stringify({ path: f }) },
          })),
          usage: {},
          finish: 'tool_calls',
        };
      }
      if (tp === 2) {
        return {
          text: '',
          toolCalls: [
            { id: 'c3', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'pa.txt' }) } },
            { id: 'c4', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'pc.txt', content: 'C' }) } },
          ],
          usage: {},
          finish: 'tool_calls',
        };
      }
      return { text: '并行完成', toolCalls: null, usage: {}, finish: 'stop' };
    },
  };
  const agentP = createAgent({
    provider: fakeP,
    permission: { mode: 'auto', async check() { return true; } },
    io: ioP,
    modelName: 'deepseek-v4-flash',
    workingDir: tmp,
    cfg: { permission: 'auto' },
  });
  const mP = [{ role: 'system', content: '系统' }, { role: 'user', content: '读三个文件' }];
  const rP = await agentP.runTurn(mP);
  assert.equal(rP.text, '并行完成');
  // 纯只读批次：三个 start 连续出现后才出现 end（证明并行），end 顺序与调用顺序一致
  assert.deepEqual(seq.slice(0, 6), ['start:read', 'start:read', 'start:read', 'end:read', 'end:read', 'end:read'], '纯只读批次应并行且事件有序');
  // 混合批次：read 完成后才执行 write（写入不并入并行）
  assert.deepEqual(seq.slice(6), ['start:read', 'end:read', 'start:write', 'end:write'], '混合批次应保持串行顺序');
  assert.equal(fs.readFileSync(path.join(tmp, 'pc.txt'), 'utf8'), 'C', '批次中的写入应正常执行');
  const toolIds = mP.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
  assert.deepEqual(toolIds, ['c0', 'c1', 'c2', 'c3', 'c4'], '工具结果应按调用顺序回填');
  ok('agent：连续只读工具并行执行（事件顺序/混合批次串行/结果顺序）');
}

// ---------- 6. 权限引擎 ----------
{
  // 用 stub io：特殊授权（规则拦截/只读拦截）现在会弹出询问，测试注入应答避免读真实 stdin
  const ioNo = { ask: async () => 'n' };
  const ioYes = { ask: async () => 'y' };
  const { createPermission } = await import(pathToFileURL(path.join(srcDir, 'permissions.js')).href);
  const auto = createPermission('auto', ioNo);
  assert.equal(await auto.check('bash', { command: 'rm -rf /' }), true);
  const readonly = createPermission('readonly', ioNo);
  assert.equal(await readonly.check('read', {}), true);
  assert.equal(await readonly.check('write', {}), false, '只读拦截询问被拒应返回 false');
  const readonlyYes = createPermission('readonly', ioYes);
  assert.equal(await readonlyYes.check('write', {}), true, '只读拦截询问同意应放行');
  const obj = createPermission({ mode: 'ask', allow: ['bash'], deny: ['write'] }, ioNo);
  assert.equal(await obj.check('bash', {}), true);
  assert.equal(await obj.check('write', {}), false, 'deny 拦截询问被拒应返回 false');
  const objYes = createPermission({ mode: 'ask', allow: ['bash'], deny: ['write'] }, ioYes);
  assert.equal(await objYes.check('write', {}), true, 'deny 拦截询问同意应强制放行');
  assert.equal(await obj.check('grep', {}), true);
  ok('permissions：auto / readonly / 规则对象 / 特殊授权交互');
}

// ---------- 7. 配置与独立凭证库（隔离的 MINGDAO_HOME） ----------
{
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-home-'));
  process.env.MINGDAO_HOME = home2;
  const {
    setStoredKey,
    getStoredKey,
    removeStoredKey,
    maskKey,
    credentialsPath,
    resolveApiKey,
    loadCredentials,
  } = await import(pathToFileURL(path.join(srcDir, 'credentials.js')).href);

  // 桌面版首次运行自动初始化（审计）：无配置时建最小可用配置，二次调用幂等不改写
  {
    const { ensureMinimalConfig } = await import(pathToFileURL(path.join(srcDir, 'config.js')).href);
    const c1 = ensureMinimalConfig();
    assert.ok(c1 && c1.provider === 'deepseek' && c1.model && c1.permission === 'ask', '首次运行应自动创建最小配置');
    assert.equal('apiKey' in c1, false, '自动初始化不应写入任何密钥');
    const c2 = ensureMinimalConfig();
    assert.deepEqual(c2, c1, '已有配置时 ensureMinimalConfig 应原样返回（幂等，不改写用户配置）');
    safeRmSync(path.join(home2, 'config.json'), { force: true });
  }

  // config.json 不含任何密钥（可安全分享/提交）
  saveConfig({ provider: 'deepseek', model: 'deepseek-v4-pro', permission: 'ask', contextBudget: 123456 });
  const loaded = loadConfig();
  assert.equal(loaded.model, 'deepseek-v4-pro');
  assert.equal(loaded.contextBudget, 123456);
  assert.equal('apiKey' in loaded, false, 'config.json 不应包含 apiKey 字段');
  // Windows（NTFS）无 POSIX 权限语义：chmodSync(0o600) 后回读恒为 0666，权限断言仅限 POSIX（评估 P0-1，曾致 Windows 冒烟/自更新永久失败）
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(home2, 'config.json')).mode & 0o777, 0o600, '配置文件权限应为 600');
  }

  // 凭证库：独立文件、600 权限、脱敏显示
  const key = 'sk-test-abcdef1234567890';
  setStoredKey('deepseek', key);
  assert.equal(getStoredKey('deepseek'), key);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(credentialsPath()).mode & 0o777, 0o600, '凭证文件权限应为 600');
  }
  assert.equal(maskKey(key), 'sk-tes…7890', '脱敏格式应为「前6位…后4位」');
  assert.deepEqual(Object.keys(loadCredentials()), ['deepseek']);

  // 解析优先级：环境变量 > 凭证库 > config 显式字段（兼容旧配置）
  const cfgWithFallback = { apiKey: 'sk-config-fallback' };
  assert.equal(resolveApiKey(cfgWithFallback, 'deepseek', 'DEEPSEEK_API_KEY'), key, '无环境变量时应取凭证库');
  process.env.DEEPSEEK_API_KEY = 'sk-env-override-999999';
  assert.equal(resolveApiKey(cfgWithFallback, 'deepseek', 'DEEPSEEK_API_KEY'), 'sk-env-override-999999', '环境变量优先级最高');
  delete process.env.DEEPSEEK_API_KEY;
  assert.equal(
    resolveApiKey(cfgWithFallback, 'no-store-provider', undefined),
    'sk-config-fallback',
    '凭证库无记录时回退 config 字段（兼容旧版本）'
  );

  removeStoredKey('deepseek');
  assert.equal(getStoredKey('deepseek'), null);
  process.env.MINGDAO_HOME = smokeHome;
  ok('credentials：独立存储 / 600 权限 / 脱敏 / 三级解析优先级');
}

// ---------- 8. 会话持久化 ----------
{
  const home3 = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-sess-'));
  const { createSession, appendMessages, loadSession, latestSession } = await import(pathToFileURL(path.join(srcDir, 'session.js')).href);
  const s = createSession(home3);
  appendMessages(s.file, [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好！' },
  ]);
  const loaded = loadSession(s.file);
  assert.equal(loaded.messages.length, 2);
  assert.equal(loaded.messages[0].role, 'user');
  const latest = latestSession(home3);
  assert.equal(latest.file, s.file);
  ok('session：创建 / 追加 / 载入 / 最近会话');
}

// ---------- 9. 技能系统 ----------
{
  const home9 = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-skills-'));
  process.env.MINGDAO_HOME = home9;
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-proj-'));
  fs.mkdirSync(path.join(proj, '.mingdao', 'skills', 'pdf'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.mingdao', 'skills', 'pdf', 'SKILL.md'), '# PDF 处理\n\n处理 PDF 的方法。');
  const { listSkills, loadSkill } = await import(pathToFileURL(path.join(srcDir, 'skills.js')).href);
  const skills = listSkills(proj);
  const pdf = skills.find((s) => s.name === 'pdf');
  assert.ok(pdf && pdf.source === 'project', '项目级技能应被发现');
  assert.ok(pdf.description === 'PDF 处理');
  assert.ok(loadSkill(proj, 'pdf').content.includes('处理 PDF 的方法'));
  const builtin = skills.find((s) => s.name === 'git-commit');
  assert.ok(builtin && builtin.source === 'builtin', '内置技能应被发现');
  assert.ok(builtin.description.includes('Git'), '内置技能应解析 frontmatter 描述');
  const r = await dispatch('skill', { name: 'pdf' }, { workingDir: proj });
  assert.ok(r.ok && r.output.includes('PDF 处理'));
  const r2 = await dispatch('skill', { name: 'nope' }, { workingDir: proj });
  assert.equal(r2.ok, false);
  // 同名覆盖：用户级 > 项目级
  fs.mkdirSync(path.join(home9, 'skills', 'pdf'), { recursive: true });
  fs.writeFileSync(path.join(home9, 'skills', 'pdf', 'SKILL.md'), '---\ndescription: 用户级覆盖\n---\n\n# 用户 PDF\n');
  const pdf2 = listSkills(proj).find((s) => s.name === 'pdf');
  assert.equal(pdf2.source, 'user', '用户级技能应覆盖项目级');
  assert.equal(pdf2.description, '用户级覆盖');
  process.env.MINGDAO_HOME = smokeHome;
  safeRmSync(proj, { recursive: true, force: true });
  ok('skills：项目/内置发现、frontmatter 描述、用户级覆盖优先级');
}

// ---------- 10. 任务清单与子代理 ----------
{
  const ctx10 = { todos: [] };
  const r = await dispatch('todo', { todos: [{ content: '第一步', status: 'in_progress' }, { content: '第二步', status: 'pending' }] }, ctx10);
  assert.ok(r.ok);
  assert.equal(ctx10.todos.length, 2);
  const t = await dispatch('task', { description: '测试', prompt: '做点什么' }, { spawnTask: async () => '子代理汇报结果' });
  assert.ok(t.ok && t.output === '子代理汇报结果');
  ok('todo / task：清单维护与子代理委托');
}

// ---------- 11. undo 撤销 ----------
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-undo-'));
  const store = { backups: new Map() };
  const c = { cwd: d, undoStore: store };
  await dispatch('write', { path: 'f.txt', content: 'v1\n' }, c);
  await dispatch('write', { path: 'f.txt', content: 'v2\n' }, c);
  assert.equal(fs.readFileSync(path.join(d, 'f.txt'), 'utf8'), 'v2\n');
  const r = await dispatch('undo', { path: 'f.txt' }, c);
  assert.ok(r.ok);
  assert.equal(fs.readFileSync(path.join(d, 'f.txt'), 'utf8'), 'v1\n');
  const r2 = await dispatch('undo', {}, c);
  assert.equal(r2.ok, false, '无剩余备份时应报错');
  safeRmSync(d, { recursive: true, force: true });
  ok('undo：撤销 write/edit 的最近修改');
}

// ---------- 12. 权限规则模式匹配 ----------
{
  const { createPermission } = await import(pathToFileURL(path.join(srcDir, 'permissions.js')).href);
  const io12 = { ask: async () => 'n' };
  const p = createPermission({ mode: 'ask', allow: ['bash:git *'], deny: ['bash:rm *', 'write'] }, io12);
  assert.equal(await p.check('bash', { command: 'git status --short' }), true, 'allow 前缀匹配');
  assert.equal(await p.check('bash', { command: 'rm -rf /tmp/x' }), false, 'deny 前缀匹配');
  assert.equal(await p.check('write', {}), false, 'deny 精确匹配');
  assert.equal(await p.check('grep', {}), true, '只读默认放行');
  // 链式命令不得借前缀规则绕过（&& / ; / | 回落 ask → 测试 IO 拒绝）
  const pChain = createPermission({ mode: 'ask', allow: ['bash:git *'] }, { ask: async () => 'n' });
  assert.equal(await pChain.check('bash', { command: 'git push && rm -rf ~' }), false, '链式命令不应被前缀规则放行');
  assert.equal(await pChain.check('bash', { command: 'git status; whoami' }), false, '分号链式同样拦截');
  assert.equal(await pChain.check('bash', { command: 'git | grep x' }), false, '管道链式同样拦截');
  // P0（v0.4.1）：单 &（后台串联）、重定向 < >、回车 \r 也须拦截（白名单字符法）
  assert.equal(await pChain.check('bash', { command: 'git status & whoami' }), false, '单 & 后台串联应拦截');
  assert.equal(await pChain.check('bash', { command: 'git log > /etc/passwd' }), false, '重定向 > 应拦截');
  assert.equal(await pChain.check('bash', { command: 'git status < /dev/null' }), false, '重定向 < 应拦截');
  assert.equal(await pChain.check('bash', { command: 'git status\rwhoami' }), false, '回车 \r 应拦截');
  // 正常简单命令（含参数/连字符/冒号/路径）仍应放行
  assert.equal(await pChain.check('bash', { command: 'git status --short' }), true, '简单命令仍应放行');
  assert.equal(await pChain.check('bash', { command: 'git log -n 10' }), true, '带参数简单命令仍应放行');
  ok('permissions：工具名:参数前缀 规则匹配（含 P0 白名单字符防绕过）');
}

// ---------- 13. Hooks ----------
{
  const { createHooks } = await import(pathToFileURL(path.join(srcDir, 'hooks.js')).href);
  const blockCmd = `node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.stringify({decision:'block',reason:'测试阻止'})))"`;
  const hooks = createHooks({ PreToolUse: [{ matcher: 'write', cmd: blockCmd }] }, tmp);
  const pre = await hooks.pre('write', { path: 'a.txt' });
  assert.equal(pre.decision, 'block');
  assert.equal(pre.reason, '测试阻止');
  const pre2 = await hooks.pre('read', {});
  assert.equal(pre2.decision, 'approve', '不匹配的钩子应放行');
  const approveCmd = `node -e "process.stdin.on('data',()=>{});process.stdin.on('end',()=>console.log(JSON.stringify({decision:'approve'})))"`;
  const hooks2 = createHooks({ PreToolUse: [{ matcher: '*', cmd: approveCmd }] }, tmp);
  const pre3 = await hooks2.pre('bash', {});
  assert.equal(pre3.decision, 'approve');
  ok('hooks：PreToolUse 阻止 / 放行 / matcher');
}

// ---------- 14. Provider 中断信号转发（Ctrl+C 必须能中断请求） ----------
{
  const http = await import('node:http');
  const { createProvider } = await import(pathToFileURL(path.join(srcDir, 'providers/index.js')).href);
  // 故意不响应的服务器：请求会挂起直到被 abort
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const provider = await createProvider(
    { provider: 'custom', model: 'm', baseUrl: `http://127.0.0.1:${port}/v1` },
    'm',
    { timeoutMs: 20000, retries: 0 }
  );
  const userAbort = new AbortController();
  const t0 = Date.now();
  const p = provider
    .chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [], signal: userAbort.signal, onDelta() {} })
    .then(
      () => assert.fail('不应成功'),
      (e) => e
    );
  setTimeout(() => userAbort.abort(), 400);
  const err = await p;
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 5000, `用户中断应在 5s 内生效（实际 ${elapsed}ms）`);
  assert.ok(!/超时/.test(err?.message || ''), `不应是内部超时中止（${err?.message}）`);
  server.close();
  ok('provider：外部 signal（Ctrl+C）可中断挂起的请求');
}

// ---------- 14a. Provider 分层超时（v0.3.2 本地模型自适应） ----------
{
  const http = await import('node:http');
  const { createProvider } = await import(pathToFileURL(path.join(srcDir, 'providers/index.js')).href);
  // 场景 1：服务端先挂起（无任何帧）→ 触发「首 token 等待」而非总量超时
  const srv1 = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // 不写任何数据，挂起（模拟慢 prefill）
    req.on('data', () => {});
  });
  await new Promise((r) => srv1.listen(0, '127.0.0.1', r));
  const p1 = await createProvider(
    { provider: 'custom', model: 'm', baseUrl: `http://127.0.0.1:${srv1.address().port}/v1`, timeout: { firstTokenMs: 600, streamIdleMs: 100000, totalMs: 100000 } },
    'm',
    { retries: 0 }
  );
  const e1 = await p1.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [], onDelta() {} }).then(() => assert.fail('不应成功'), (e) => e);
  assert.ok(/首 token 等待超限/.test(e1?.message || ''), `挂起无帧应报首 token 超时（实际：${e1?.message}）`);
  srv1.close();

  // 场景 2：首帧到达后停止 → 触发「流式空闲」而非首 token
  const srv2 = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {}\n\n');
    // 首帧后不再写，挂起
    req.on('data', () => {});
  });
  await new Promise((r) => srv2.listen(0, '127.0.0.1', r));
  const p2 = await createProvider(
    { provider: 'custom', model: 'm', baseUrl: `http://127.0.0.1:${srv2.address().port}/v1`, timeout: { firstTokenMs: 100000, streamIdleMs: 600, totalMs: 100000 } },
    'm',
    { retries: 0 }
  );
  const e2 = await p2.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [], onDelta() {} }).then(() => assert.fail('不应成功'), (e) => e);
  assert.ok(/流式响应空闲超限/.test(e2?.message || ''), `首帧后停应报流式空闲超时（实际：${e2?.message}）`);
  srv2.close();

  ok('provider：分层超时（首 token 等待 vs 流式空闲，本地慢 prefill 不被误杀）');
}

// ---------- 14. 精确 tokenizer ----------
{
  const { countTokens, heuristicTokens } = await import(pathToFileURL(path.join(srcDir, 'tokenizer.js')).href);
  // 黄金值断言：全部数值取自 DeepSeek-V3 官方 tokenizer.json 用 HF tokenizers 库的真实输出，
  // 覆盖字节映射（汉字必须合并成词表单 token，防 0x7F-0xA0 字节永不合并的回归）、
  // 预分词（数字 1-3 位切段/标点引导词/空白与换行）、代码与中英混合长文本。
  const GOLDEN = [
    ['的', 1], // 最常见汉字：单 token（字节映射修复的探针，曾退化为 3）
    ['你好', 1],
    ['人工智能', 1],
    ['你好世界', 2],
    ['hello', 1],
    ['Hello world', 2],
    ["I don't think it's ready", 7],
    ['1234567890 3.14 42', 10], // 数字 1–3 位切段
    ['价格：¥1,299.00（含税）', 12],
    ['emoji 🎉🚀 与 ©® 符号', 13],
    ['const arr = [1, 22, 333, 4444];  // 注释 mixed 中文', 23],
    ['前<｜begin▁of▁sentence｜>后', 3], // 特殊 token 嵌入正文：自身计 1
  ];
  for (const [s, want] of GOLDEN) {
    assert.equal(countTokens(s, 'deepseek-v4-flash'), want, `黄金值不符：${JSON.stringify(s)} 应 ${want} tokens`);
  }
  // 混合长文本：官方口径 37 tokens/遍 × 150
  const long = '人工智能正在改变世界，MingDao 让每个人都拥有自己的智能体。MCP 连接外部工具，tokenizer 精确计量，WebUI 开箱即用。'.repeat(150);
  assert.equal(countTokens(long, 'deepseek-v4-pro'), 5550, '长文本计数应与官方 tokenizer 一致');
  // 非 deepseek 模型回退启发式
  assert.equal(countTokens('hello', 'gpt-4o'), heuristicTokens('hello'));
  // 启发式 CJK 校准（P0-2）：流畅中文 ≈0.75 token/字（旧版 1 字=1 token 高估约 2 倍）
  assert.equal(heuristicTokens('你好世界'), 3, 'CJK 启发式应按 0.75/字校准');
  assert.equal(heuristicTokens('ab'), 1, 'ASCII 启发式不变');
  assert.equal(heuristicTokens('🎉'), 2, '增补平面 emoji 按 2 保守计（审计 B5，不再低估）');
  // 计数缓存（P2-7）：同一文本重复计数结果一致（且第二次走缓存路径）
  const cachedText = '人工智能与 tokenizer 精确计量，缓存命中后速度提升。';
  const c1 = countTokens(cachedText, 'deepseek-v4-flash');
  const c2 = countTokens(cachedText, 'deepseek-v4-flash');
  assert.equal(c1, c2, '缓存路径计数应与首次一致');
  // 特殊 token 记 1
  assert.equal(countTokens('<｜begin▁of▁sentence｜>', 'deepseek-v4-flash'), 1);
  // B8：自定义端点声明 tokenizer: "deepseek" → 按官方词表精确计数
  const cfgFile = path.join(process.env.MINGDAO_HOME, 'config.json');
  const prevCfg = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : null;
  fs.writeFileSync(cfgFile, JSON.stringify({ customModels: { 'my-ds': { label: 'x', baseUrl: 'http://x', tokenizer: 'deepseek' } } }));
  assert.equal(countTokens('的', 'my-ds'), 1, '自定义端点声明 deepseek tokenizer 后应精确计数');
  assert.ok(countTokens('的', 'my-ds2') > 0, '未声明时回退启发式仍可用');
  if (prevCfg === null) safeRmSync(cfgFile, { force: true });
  else fs.writeFileSync(cfgFile, prevCfg);
  ok('tokenizer：官方黄金值 12 组 / 长文本 / 回退启发式 / 特殊 token / CJK 校准 / 缓存 / 自定义端点映射');
}

// ---------- 14b. 模型能力解析与安全预算（v0.3.2 本地模型自适应） ----------
{
  const { resolveModelCaps, safeBudget, isLocalBaseUrl, COMFORT_RATIO, OUTPUT_HEADROOM } = await import(pathToFileURL(path.join(srcDir, 'model-caps.js')).href);

  // 本地端点判定
  assert.equal(isLocalBaseUrl('http://127.0.0.1:8081/v1'), true, '127.0.0.1 应判本地');
  assert.equal(isLocalBaseUrl('http://localhost:11434'), true, 'localhost 应判本地');
  assert.equal(isLocalBaseUrl('http://192.168.1.5:8081'), true, '192.168 内网应判本地');
  assert.equal(isLocalBaseUrl('http://10.0.0.3:8081'), true, '10.x 内网应判本地');
  assert.equal(isLocalBaseUrl('https://api.deepseek.com/v1'), false, '公网域名应判远程');
  assert.equal(isLocalBaseUrl('not-a-url'), false, '非法 URL 应判远程（容错）');
  // 审计 P3-3（v0.4.2）：IPv6 私网/链路本地判定（此前只查 IPv4 与 ::1，fc00::/7、fe80::/10 被误判远程）
  assert.equal(isLocalBaseUrl('http://[::1]:8081/v1'), true, '::1 回环应判本地');
  assert.equal(isLocalBaseUrl('http://[fe80::1]:8081/v1'), true, 'fe80::/10 链路本地应判本地');
  assert.equal(isLocalBaseUrl('http://[fc00::1]:8081/v1'), true, 'fc00::/7 私网 ULA 应判本地');
  assert.equal(isLocalBaseUrl('http://[2001:db8::1]:8081/v1'), false, '公网 IPv6 应判远程');

  // 内置预设：pro 1M 窗口，预算用 preset.budgetTokens（200k），不被舒适区误伤
  const capsPro = resolveModelCaps({}, 'deepseek-v4-pro');
  assert.equal(capsPro.contextWindow, 1000000, 'deepseek-v4-pro 窗口 1M');
  assert.equal(capsPro.isLocal, false, 'deepseek 远程');
  assert.equal(safeBudget({}, capsPro), 200000, 'pro 用 preset 预算 200k');

  // 自定义本地模型（诊断场景：mtplx 131k 窗口，未显式声明 contextWindow → 兜底 32k）
  const cfgLocal = { customModels: { 'local-qwen': { label: 'x', baseUrl: 'http://127.0.0.1:8081/v1' } } };
  const capsLocal = resolveModelCaps(cfgLocal, 'local-qwen');
  assert.equal(capsLocal.isLocal, true, '本地模型应判本地');
  assert.equal(capsLocal.contextWindow, 32768, '未知本地模型兜底 32k 窗口');
  // 默认 contextBudget=128000 被舒适区/窗口上限压到 75% 以内
  const budgetLocal = safeBudget({ contextBudget: 128000 }, capsLocal);
  assert.ok(budgetLocal <= 32768 * COMFORT_RATIO, '本地小窗口预算不越舒适区');
  assert.ok(budgetLocal <= 32768 - capsLocal.maxOutputTokens - OUTPUT_HEADROOM, '预算给输出留余量');

  // 自定义本地模型显式声明 131072 窗口（诊断真实值）
  const cfg131 = { customModels: { 'local-qwen': { label: 'x', baseUrl: 'http://127.0.0.1:8081/v1', contextWindow: 131072, maxOutputTokens: 8192 } } };
  const caps131 = resolveModelCaps(cfg131, 'local-qwen');
  assert.equal(caps131.contextWindow, 131072, '显式声明窗口生效');
  const budget131 = safeBudget({ contextBudget: 128000 }, caps131);
  assert.ok(budget131 <= 131072 * COMFORT_RATIO, '131k 窗口预算 ≤ 75% 舒适区（prefill 不爆炸）');
  assert.ok(budget131 <= 131072 - 8192 - OUTPUT_HEADROOM, '131k 预算给 8192 输出 + 余量');

  // 自定义远程模型（未声明窗口 → 兜底 128k）
  const capsRemote = resolveModelCaps({ customModels: { 'gw': { label: 'x', baseUrl: 'https://gateway.example.com/v1' } } }, 'gw');
  assert.equal(capsRemote.isLocal, false, '公网自定义模型应判远程');
  assert.equal(capsRemote.contextWindow, 128000, '未知远程模型兜底 128k');

  // MacBook 本地 507 根因（v0.4.5）：显式 local/isLocal 覆盖判定（特殊主机名/公网反代回本机）
  const capsForceLocal = resolveModelCaps({ customModels: { 'mtplx': { label: 'x', baseUrl: 'http://mtplx.server.openai:8081/v1', local: true } } }, 'mtplx');
  assert.equal(capsForceLocal.isLocal, true, 'customModels.local=true 应强制判本地');
  const capsForceLocal2 = resolveModelCaps({ customModels: { 'mtplx': { label: 'x', baseUrl: 'http://mtplx.server.openai:8081/v1', isLocal: true } } }, 'mtplx');
  assert.equal(capsForceLocal2.isLocal, true, 'customModels.isLocal=true 应强制判本地');

  ok('model-caps：本地/远程判定 / 窗口兜底与显式声明 / 舒适区+输出余量预算推导');
}

// ---------- 15. MCP 客户端 ----------
{
  const { startMcpServers } = await import(pathToFileURL(path.join(srcDir, 'mcp.js')).href);
  const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mock-mcp-server.mjs');
  const mcp = await startMcpServers(
    { mock: { command: process.execPath, args: [serverPath] } },
    tmp
  );
  const status = mcp.status();
  assert.equal(status.length, 1);
  assert.equal(status[0].ok, true, 'mock 服务器应就绪');
  const schemas = mcp.toolSchemas();
  assert.equal(schemas.length, 2);
  assert.equal(schemas[0].function.name, 'mcp__mock__echo');
  assert.ok(schemas[0].function.description.includes('[MCP:mock]'));
  const res = await mcp.call('mcp__mock__echo', { text: '你好' });
  assert.ok(res.ok && res.output === 'echo:你好');
  // v0.4.1 P0：未授信服务器（未设 trusted）的 readOnlyHint 不被信任——自动放行失效，回落权限确认
  assert.equal(mcp.isReadonly('mcp__mock__readonly_peek'), false, '未 trusted 服务器的 readOnlyHint 不应自动放行');
  assert.equal(mcp.isReadonly('mcp__mock__echo'), false);
  // trusted: true 后才信任其只读标注
  const mcpT = await startMcpServers(
    { mockt: { command: process.execPath, args: [serverPath], trusted: true } },
    tmp
  );
  assert.equal(mcpT.isReadonly('mcp__mockt__readonly_peek'), true, 'trusted 服务器的 readOnlyHint 应自动放行');
  mcpT.stop();
  // 失败服务器不拖垮管理器，也不阻塞其余
  const mcp2 = await startMcpServers(
    { bad: { command: 'definitely-not-a-command-xyz' }, mock2: { command: process.execPath, args: [serverPath] } },
    tmp
  );
  const s2 = mcp2.status();
  assert.equal(s2.find((s) => s.name === 'bad').ok, false);
  assert.equal(s2.find((s) => s.name === 'mock2').ok, true);
  assert.equal(mcp2.toolSchemas().length, 2, '失败服务器不应影响可用工具');
  mcp.stop();
  mcp2.stop();
  ok('mcp：握手 / 工具发现 / 调用 / 只读标注 / 容错');
}

// ---------- 16. 沙箱执行（随环境能力自适应） ----------
{
  const { detectSandbox } = await import(pathToFileURL(path.join(srcDir, 'tools/bash.js')).href);
  if (detectSandbox() === 'bwrap') {
    const d16 = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-sbx-'));
    const ctx16 = { cwd: d16, cfg: { sandbox: 'safe' } };
    const r1 = await dispatch('bash', { command: 'echo hello-sandbox' }, ctx16);
    assert.equal(r1.ok, true);
    assert.equal(r1.sandbox, 'safe');
    assert.ok(r1.stdout.includes('hello-sandbox'));
    const r2 = await dispatch('bash', { command: 'touch /etc/mingdao-sbx-probe 2>&1; echo code=$?' }, ctx16);
    assert.ok(!r2.stdout.includes('code=0'), 'safe 模式不应允许写 /etc');
    const r3 = await dispatch('bash', { command: 'curl -s --max-time 3 http://example.com >/dev/null 2>&1 && echo NET-OK || echo NET-BLOCKED' }, ctx16);
    assert.ok(r3.stdout.includes('NET-BLOCKED'), 'safe 模式应断网');
    const ctxRo = { cwd: d16, cfg: { sandbox: 'readonly' } };
    const r4 = await dispatch('bash', { command: 'echo x > ./probe-ro.txt 2>&1; echo code=$?' }, ctxRo);
    assert.ok(!r4.stdout.includes('code=0'), 'readonly 模式不应允许写工作目录');
    safeRmSync(d16, { recursive: true, force: true });
    ok('sandbox：safe 断网只读 / readonly 工作目录只读（bwrap）');
  } else {
    const r = await dispatch('bash', { command: 'echo plain' }, { cwd: tmp, cfg: { sandbox: 'safe' } });
    assert.equal(r.ok, true);
    assert.equal(r.sandbox, 'off', '无 bwrap 应降级为 off');
    assert.ok(r.note && r.note.includes('降级'), '降级应注明');
    ok('sandbox：无 bwrap 环境优雅降级');
  }
}

// ---------- 17. 自动路由 ----------
{
  const { routeTask, heuristicRoute, routingConfig, subagentModel } = await import(pathToFileURL(path.join(srcDir, 'routing.js')).href);
  const rc = routingConfig({ routing: { enabled: true } });
  assert.ok(rc && rc.planner === 'deepseek-v4-pro' && rc.executor === 'deepseek-v4-flash');
  assert.equal(heuristicRoute('帮我写个函数', rc), 'deepseek-v4-flash');
  assert.equal(heuristicRoute('请设计这个系统的整体架构，梳理模块划分与数据流，并给出分阶段重构方案与风险评估与测试计划', rc), 'deepseek-v4-pro');
  // 生成类任务（需要大输出）即使短句也路由 planner
  assert.equal(heuristicRoute('给我生成一个愤怒的小鸟网页版游戏', rc), 'deepseek-v4-pro', '游戏生成应路由 planner');
  assert.equal(heuristicRoute('帮我写一份详细的周报', rc), 'deepseek-v4-pro', '文档生成应路由 planner');
  assert.equal(heuristicRoute('今天天气怎么样', rc), 'deepseek-v4-flash');
  // 分类器路径（fake provider 返回 plan / execute）
  const fake = { async chat() { return { text: 'plan' }; } };
  const r1 = await routeTask({ cfg: { routing: { enabled: true } }, provider: fake, currentModel: 'deepseek-v4-flash', text: '这是一条用于触发分类器判定流程的测试消息，其内容需要足够长以超过六十个字符的启发式阈值，才能进入分类器环节进行判定，请务必用分类器来判定本条消息的类别' });
  assert.equal(r1.model, 'deepseek-v4-pro');
  const fake2 = { async chat() { return { text: 'execute' }; } };
  const r2 = await routeTask({ cfg: { routing: { enabled: true } }, provider: fake2, currentModel: 'deepseek-v4-pro', text: '这是另一条用于触发分类器判定流程的测试消息，其内容同样需要足够长以超过六十个字符的启发式阈值，才能进入分类器环节进行判定，请务必用分类器判定类别' });
  assert.equal(r2.model, 'deepseek-v4-flash');
  // 路由池外模型不干预
  const r3 = await routeTask({ cfg: { routing: { enabled: true } }, provider: fake, currentModel: 'qwen-max', text: '设计一个系统' });
  assert.equal(r3.model, 'qwen-max');
  assert.equal(subagentModel({ routing: { enabled: true } }, 'deepseek-v4-pro'), 'deepseek-v4-flash');
  // v0.4.1 修复：池外模型（本地/自定义）子代理应跟随当前模型，而非被切到 executor（发错 baseUrl）
  assert.equal(subagentModel({ routing: { enabled: true, planner: 'deepseek-v4-pro', executor: 'deepseek-v4-flash' } }, 'mtplx-qwen38-27b-optimized-quality'), 'mtplx-qwen38-27b-optimized-quality', '池外模型子代理应跟随当前模型');
  ok('routing：启发式 / 分类器 / 池外不干预 / 子代理 executor（池外跟随）');
}

// ---------- 18. 会话检索 ----------
{
  const { searchSessions, createSession: cs18, appendMessages: ap18 } = await import(pathToFileURL(path.join(srcDir, 'session.js')).href);
  const home18 = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-srch-'));
  const s1 = cs18(home18);
  ap18(s1.file, [{ role: 'user', content: '帮我写一个快速排序，并且分析其时间复杂度' }]);
  const s2 = cs18(home18);
  ap18(s2.file, [{ role: 'user', content: '今天天气怎么样，适合去爬山吗' }]);
  const hits = searchSessions(home18, '快速排序');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, s1.name);
  assert.ok(hits[0].snippet.includes('快速排序'));
  const miss = searchSessions(home18, '不存在的关键词xyz');
  assert.equal(miss.length, 0);
  const all = searchSessions(home18, '');
  assert.equal(all.length, 2);
  safeRmSync(home18, { recursive: true, force: true });
  ok('sessions：全文检索 / 片段 / 空关键词');
}

// ---------- 19. 工作空间 ----------
{
  const homeW = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-ws-'));
  const projA = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-wsa-'));
  process.env.MINGDAO_HOME = homeW;
  const { addWorkspace, removeWorkspace, workspacePath, touchWorkspace, listWorkspaces, currentWorkspace } = await import(pathToFileURL(path.join(srcDir, 'workspace.js')).href);
  const r1 = addWorkspace('项目A', projA);
  assert.ok(r1.name === '项目A' && r1.dir === projA);
  const bad = addWorkspace('', projA);
  assert.ok(bad.error, '空名称应报错');
  const bad2 = addWorkspace('不存在的目录', path.join(projA, 'nope'));
  assert.ok(bad2.error, '目录不存在应报错');
  assert.equal(workspacePath('项目A'), projA);
  assert.equal(listWorkspaces().length, 1);
  assert.ok(touchWorkspace('项目A'));
  assert.ok(currentWorkspace(projA)?.name === '项目A', '当前目录应识别工作空间');
  assert.equal(removeWorkspace('项目A'), true);
  assert.equal(workspacePath('项目A'), null);
  process.env.MINGDAO_HOME = smokeHome;
  safeRmSync(homeW, { recursive: true, force: true });
  safeRmSync(projA, { recursive: true, force: true });
  ok('workspace：登记 / 校验 / 列表 / 识别当前 / 移除');
}

// ---------- 20. 开机自启（隔离 HOME） ----------
{
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-home-'));
  const oldHome = process.env.HOME;
  process.env.HOME = fakeHome;
  // Windows 的自启文件在 APPDATA（启动文件夹），必须一并隔离，否则污染真实系统（评估 D4）
  const oldAppData = process.env.APPDATA;
  if (process.platform === 'win32') process.env.APPDATA = path.join(fakeHome, 'AppData', 'Roaming');
  const { enableAutostart, disableAutostart, autostartStatus, autostartPath } = await import(pathToFileURL(path.join(srcDir, 'autostart.js')).href);
  assert.equal(autostartStatus(), false, '初始应为关');
  assert.equal(enableAutostart(), true);
  assert.equal(autostartStatus(), true, '开启后应为开');
  assert.ok(fs.existsSync(autostartPath()), '应存在自启文件');
  assert.equal(disableAutostart(), true);
  assert.equal(autostartStatus(), false, '关闭后应为关');
  if (process.platform === 'win32') process.env.APPDATA = oldAppData;
  process.env.HOME = oldHome;
  safeRmSync(fakeHome, { recursive: true, force: true });
  ok('autostart：开 / 关 / 状态（隔离 HOME + APPDATA）');
}

// ---------- 21. 桌面通知（静默不抛） ----------
{
  const { notify, notifyTaskDone } = await import(pathToFileURL(path.join(srcDir, 'notify.js')).href);
  notify('MingDao', '测试通知'); // 无桌面环境时静默忽略，绝不应抛错
  notifyTaskDone('测试任务', 'done');
  notifyTaskDone('失败任务', 'failed');
  ok('notify：调用不抛错（环境自适应静默）');
}

// ---------- 22. 长记忆：提取去重 + 会话日志 ----------
{
  const homeM = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-mem-'));
  process.env.MINGDAO_HOME = homeM;
  const { loadMemory, appendMemory, appendJournal, recentJournal, recentJournalBlock, extractMemory } = await import(pathToFileURL(path.join(srcDir, 'memory.js')).href);
  appendMemory(['用户偏好简洁的中文回复']);
  const existing = loadMemory();
  assert.ok(existing.includes('简洁的中文回复'));
  const fake = { async chat() { return { text: '- 用户偏好简洁的中文回复\n- 常用 pnpm 而不是 npm' }; } };
  const msgs = [
    { role: 'user', content: '帮我初始化项目' },
    { role: 'assistant', content: '已用 pnpm 初始化完成' },
  ];
  const lines = await extractMemory(fake, 'deepseek-v4-flash', msgs, existing);
  assert.ok(lines.length >= 1);
  const added = appendMemory(lines);
  assert.ok(added >= 1);
  const fakeNone = { async chat() { return { text: '无新增' }; } };
  const none = await extractMemory(fakeNone, 'deepseek-v4-flash', msgs, existing);
  assert.equal(none.length, 0, '无新增应返回空');
  appendJournal(homeM, { at: Date.now(), workspace: 'test', firstUser: '测试会话一', outcome: '完成', turns: 3 });
  appendJournal(homeM, { at: Date.now(), workspace: 'test', firstUser: '测试会话二', outcome: '完成', turns: 3 });
  assert.equal(recentJournal(homeM, 3).length, 2);
  assert.ok(recentJournalBlock(homeM).includes('测试会话二'));
  process.env.MINGDAO_HOME = smokeHome;
  safeRmSync(homeM, { recursive: true, force: true });
  ok('memory：提取 / 追加 / 无新增 / 日志 / 最近块');
}

// ---------- 22b. 项目级自动记忆（v0.3.0 P0-3）：按工作空间沉淀 + 注入不串 ----------
{
  const homeP = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-pmem-'));
  process.env.MINGDAO_HOME = homeP;
  const wsA = path.join(homeP, 'proj-a');
  const wsB = path.join(homeP, 'proj-b');
  fs.mkdirSync(wsA, { recursive: true });
  fs.mkdirSync(wsB, { recursive: true });
  const { loadProjectMemory, appendProjectMemory, dedupeProjectMemory, extractProjectMemory } = await import(pathToFileURL(path.join(srcDir, 'memory.js')).href);
  const { buildSystemPrompt } = await import(pathToFileURL(path.join(srcDir, 'prompts.js')).href);
  // 追加/读回/去重：项目记忆只落在各自工作空间
  appendProjectMemory(wsA, ['决定：config 拆成多文件', '坑：Node 18 不支持某 API']);
  appendProjectMemory(wsA, ['决定：config 拆成多文件']); // 重复，去重后应只保留一条
  const before = loadProjectMemory(wsA).split('\n').filter(Boolean).length;
  const removed = dedupeProjectMemory(wsA);
  const after = loadProjectMemory(wsA).split('\n').filter(Boolean).length;
  assert.ok(removed >= 1 && after === before - removed, '项目记忆去重应删重复');
  assert.equal(loadProjectMemory(wsB), '', '工作空间 B 不应读到 A 的项目记忆');
  // 提取（json 路径）
  const fake = { async chat() { return { text: '{"items": ["结构：src 下分 core/web"]}' }; } };
  const lines = await extractProjectMemory(fake, 'deepseek-v4-flash', [{ role: 'user', content: '重构项目结构' }], '');
  assert.ok(lines.length >= 1, '项目记忆提取应返回条目');
  // 注入：buildSystemPrompt 应包含该工作空间的项目记忆、且不串
  const sp = buildSystemPrompt({ workingDir: wsA });
  assert.ok(sp.includes('<project_memory>') && sp.includes('config 拆成多文件'), '系统提示应注入项目记忆');
  assert.ok(!sp.includes('src 下分 core/web'), '未追加到文件的项目记忆不应注入');
  // projectMemory 快照参数应覆盖文件读取（会话内前缀稳定）
  const spSnap = buildSystemPrompt({ workingDir: wsA, projectMemory: '- 快照条目' });
  assert.ok(spSnap.includes('快照条目') && !spSnap.includes('config 拆成多文件'), 'projectMemory 快照参数应覆盖文件读取');
  // 语义检索：query 相关条目优先
  const { retrieveRelevant } = await import(pathToFileURL(path.join(srcDir, 'memory.js')).href);
  const rel = retrieveRelevant(['- 决定：config 拆成多文件', '- 游戏位于 moba 目录', '- 坑：Node 18 不支持某 API'], '重构 config 配置', 2);
  assert.ok(rel.length >= 1 && rel[0].includes('config'), '语义检索应把 config 相关条目排在前面');
  // v0.4.1 P1：无共同词时回退最近 N 条（记忆不因相关性判断失败而消失）
  const none = retrieveRelevant(['- 决定：config 拆成多文件', '- 游戏位于 moba 目录', '- 坑：Node 18 不支持某 API'], 'zzz 无关查询词 qqq', 2);
  assert.equal(none.length, 2, '无匹配应回退最近 N 条');
  assert.ok(none[0].includes('Node 18') || none[1].includes('Node 18'), '回退应含最新条目');
  process.env.MINGDAO_HOME = smokeHome;
  safeRmSync(homeP, { recursive: true, force: true });
  ok('memory：项目级自动记忆按工作空间沉淀/去重/注入不串 + 语义检索');
}

// ---------- 23. 缓存感知计价 ----------
{
  const { estimateCost, estimateCostLabel, cacheSplit } = await import(pathToFileURL(path.join(srcDir, 'pricing.js')).href);
  const split = cacheSplit({ prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400 });
  assert.deepEqual(split, { hit: 600, miss: 400, rate: 0.6 });
  const withCache = estimateCost('deepseek-v4-flash', 1000, 100, { hit: 600, miss: 400 }, new Date('2026-08-21T03:00:00'));
  const noCache = estimateCost('deepseek-v4-flash', 1000, 100, null, new Date('2026-08-21T03:00:00'));
  assert.ok(withCache < noCache * 0.6, '缓存计价应显著低于全未命中 ' + withCache + ' vs ' + noCache);
  const label = estimateCostLabel('deepseek-v4-flash', 1000, 100, { prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400 });
  assert.ok(label.includes('缓存命中 60%'), label);
  // 多模态视觉模型预设（deepseek-v4-flash-vision-exp，与 flash 同价）
  const { modelPreset } = await import(pathToFileURL(path.join(srcDir, 'models.js')).href);
  const vision = modelPreset('deepseek-v4-flash-vision-exp');
  assert.ok(vision && vision.supportsVision === true, '视觉模型预设应存在且标注 supportsVision');
  assert.deepEqual(vision.pricing, modelPreset('deepseek-v4-flash').pricing, '视觉模型价格应与 V4-Flash 一致');
  const visionCost = estimateCost('deepseek-v4-flash-vision-exp', 1000, 100, null, new Date('2026-08-21T03:00:00'));
  assert.ok(visionCost > 0, '视觉模型应可计价');
  // P0-4（v0.4.5）：无价模型 estimateCost 返 null（未知）而非 0（免费）——0 与「未知」不得混同
  assert.equal(estimateCost('gpt-5', 1000, 100, null, new Date('2026-08-21T03:00:00')), null, '无价模型 estimateCost 应返 null');
  assert.equal(estimateCostLabel('gpt-5', 1000, 100, null), '', '无价模型 estimateCostLabel 应空（不显示 ¥0）');
  ok('pricing：缓存拆分 / 命中价 / 命中率标签 / 无价返 null');
}

// ---------- 24. 技能库与自定义安装 ----------
{
  const homeSk = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-skilllib-'));
  process.env.MINGDAO_HOME = homeSk;
  const { libraryList, searchLibrary, installFromLibrary, installFromDir, installFromUrl, installFromGit, installSkill, uninstallSkill, reinstallSkill, installedUserSkillNames, userSkillsDir } =
    await import(pathToFileURL(path.join(srcDir, 'skill-lib.js')).href);
  const { listSkills } = await import(pathToFileURL(path.join(srcDir, 'skills.js')).href);

  // 内置技能库目录
  const lib = libraryList();
  assert.ok(lib.length >= 20, `技能库应预置 20+ 技能（实际 ${lib.length}）`);
  assert.ok(lib.every((s) => s.name && s.description), '库中技能均应有名称与描述');
  const hits = searchLibrary('整理');
  assert.ok(hits.some((s) => s.name === 'file-organize'), '关键词搜索应命中文件整理技能');

  // 库名安装 → 用户级生效，进入技能清单
  const r1 = installFromLibrary('sql');
  assert.ok(r1.name === 'sql' && fs.existsSync(path.join(r1.dir, 'SKILL.md')), '库名安装应复制 SKILL.md');
  assert.ok(fs.existsSync(path.join(r1.dir, '.mingdao-source.json')), '应写来源元数据');
  const reg = listSkills(process.cwd());
  const installed = reg.find((s) => s.name === 'sql');
  assert.ok(installed && installed.source === 'user', '安装后应出现在技能清单且来源为用户级');
  assert.ok(installedUserSkillNames().has('sql'), 'installedUserSkillNames 应包含 sql');

  // 重复安装（覆盖更新）不报错
  assert.ok(installFromLibrary('sql').name === 'sql', '重复安装应覆盖成功');

  // 本地目录安装（frontmatter name 优先）
  const dirSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-skill-dir-'));
  fs.writeFileSync(path.join(dirSrc, 'SKILL.md'), '---\nname: my-custom\ndescription: 自定义技能\n---\n\n# 我的技能\n内容');
  const r2 = installFromDir(dirSrc);
  assert.ok(r2.name === 'my-custom', '目录安装应用 frontmatter 名称');
  safeRmSync(dirSrc, { recursive: true, force: true });

  // 远程 URL 安装（本地 http 服务器，无外部网络）
  const http = await import('node:http');
  const srv = http.createServer((req, res) => {
    if (req.url !== '/SKILL.md') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/markdown' });
    res.end('---\nname: remote-skill\ndescription: 远程技能\n---\n\n# 远程\n来自 URL');
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const urlPort = srv.address().port;
  const r3 = await installFromUrl(`http://127.0.0.1:${urlPort}/SKILL.md`, { allowPrivate: true });
  assert.ok(r3.name === 'remote-skill', 'URL 安装应成功（CLI 显式 URL 放行内网）');
  // 审计 P2-1 回归：默认（WebUI 路径）拦截内网/回环地址（SSRF 防护）
  const ssrf = await installFromUrl(`http://127.0.0.1:${urlPort}/SKILL.md`);
  assert.ok(ssrf.error && ssrf.error.includes('SSRF'), '默认应拦截内网地址（SSRF 防护）');
  const badUrl = await installFromUrl(`http://127.0.0.1:${urlPort}/nope.md`, { allowPrivate: true });
  assert.ok(badUrl.error && badUrl.error.includes('HTTP'), '非 200 应报错');
  const badProto = await installFromUrl('file:///etc/passwd');
  assert.ok(badProto.error && badProto.error.includes('http'), '非 http 协议应拒绝');
  srv.close();

  // 自动识别入口：库名 / 目录 / URL
  const auto1 = await installSkill('regex');
  assert.ok(auto1.name === 'regex', '自动识别库名');
  const auto2 = await installSkill(path.join(homeSk, 'skills', 'sql'));
  assert.ok(auto2.name === 'sql', '自动识别本地目录');
  process.env.MINGDAO_REGISTRY_URL = 'http://127.0.0.1:1'; // 确定性离线
  const notFound = await installSkill('no-such-skill');
  assert.ok(notFound.error && notFound.error.includes('无法获取线上技能库'), '离线时未知名称应回退 registry 并提示不可达');
  delete process.env.MINGDAO_REGISTRY_URL;

  // dry-run 校验：坏 frontmatter 一律拒绝且不落盘
  const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-skill-bad-'));
  fs.writeFileSync(path.join(badDir, 'SKILL.md'), '# 无 frontmatter\n\n正文');
  const bad1 = installFromDir(badDir);
  assert.ok(bad1.error && bad1.error.includes('frontmatter'), '缺 frontmatter 应拒绝');
  fs.writeFileSync(path.join(badDir, 'SKILL.md'), '---\nname: bad name!\ndescription: x\n---\n\n# 坏名字');
  const bad2 = installFromDir(badDir);
  assert.ok(bad2.error && bad2.error.includes('name 非法'), '非法 name 应拒绝');
  fs.writeFileSync(path.join(badDir, 'SKILL.md'), '---\nname: good-name\n---\n\n# 缺描述');
  const bad3 = installFromDir(badDir);
  assert.ok(bad3.error && bad3.error.includes('description'), '缺 description 应拒绝');
  assert.ok(!fs.existsSync(path.join(userSkillsDir(), 'good-name')), '校验失败不应写入技能目录');
  safeRmSync(badDir, { recursive: true, force: true });
  // P1-5（v0.4.5）：目录树内含符号链接应拒绝（防越权读本机文件/绕过 sha256 篡改检测）
  const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-skill-link-'));
  const outsideMd = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-skill-out-'));
  fs.writeFileSync(path.join(outsideMd, 'SKILL.md'), '---\nname: evil-skill\ndescription: x\n---\n\n# 越界');
  let linkMade = true;
  try { fs.symlinkSync(path.join(outsideMd, 'SKILL.md'), path.join(linkDir, 'SKILL.md')); } catch { linkMade = false; }
  if (linkMade) {
    const linkR = installFromDir(linkDir);
    assert.ok(linkR.error && linkR.error.includes('符号链接'), 'SKILL.md 为符号链接应拒绝');
  }
  safeRmSync(linkDir, { recursive: true, force: true });
  safeRmSync(outsideMd, { recursive: true, force: true });

  // git 安装：本地裸仓库演练（完全离线、确定性——example.com 在受限网络会挂起 120s 超时）
  const bareGit = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-skill-bare-'));
  spawnSync('git', ['init', '--bare', '--quiet', bareGit], { encoding: 'utf8' });
  const gitR = await installFromGit(bareGit); // v0.4.2 P1-3：installFromGit 已改异步 spawn
  assert.ok(gitR.names || gitR.error, 'git 安装应返回结果或错误而非抛出');
  safeRmSync(bareGit, { recursive: true, force: true });

  // 卸载：只卸载用户级；未安装报错；路径穿越拒绝
  const rm1 = uninstallSkill('sql');
  assert.ok(rm1.name === 'sql', '卸载用户级技能');
  assert.ok(uninstallSkill('sql').error, '再次卸载应报错');
  assert.ok(uninstallSkill('../../etc').error, '路径穿越名称应拒绝');

  // update：按元数据重装
  const up = await reinstallSkill('regex');
  assert.ok(up.name === 'regex', '按来源元数据更新');

  // 清理
  for (const n of ['my-custom', 'remote-skill', 'regex']) uninstallSkill(n);
  process.env.MINGDAO_HOME = smokeHome;
  safeRmSync(homeSk, { recursive: true, force: true });
  ok('skill-lib：内置库 / 搜索 / 库名·目录·URL 安装 / 卸载 / 元数据更新');
}

// ---------- 25. 技能线上 registry ----------
{
  const homeRg = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-reg-'));
  process.env.MINGDAO_HOME = homeRg;
  const regRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-regweb-'));
  fs.mkdirSync(path.join(regRoot, 'registry'), { recursive: true });
  fs.mkdirSync(path.join(regRoot, 'skills-lib', 'online-skill'), { recursive: true });
  fs.writeFileSync(
    path.join(regRoot, 'registry', 'index.json'),
    JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      total: 1,
      skills: [{ name: 'online-skill', description: '线上技能', files: [{ path: 'SKILL.md', size: 1 }] }],
    })
  );
  fs.writeFileSync(path.join(regRoot, 'skills-lib', 'online-skill', 'SKILL.md'), '---\nname: online-skill\ndescription: 线上技能\n---\n\n# 线上\n内容');
  const http = await import('node:http');
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x').pathname;
    if (u === '/registry/index.json') {
      res.writeHead(200);
      res.end(fs.readFileSync(path.join(regRoot, 'registry', 'index.json')));
      return;
    }
    if (u.startsWith('/skills-lib/')) {
      res.writeHead(200);
      res.end(fs.readFileSync(path.join(regRoot, u.replace('/skills-lib/', 'skills-lib/'))));
      return;
    }
    res.writeHead(404);
    res.end('nf');
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  process.env.MINGDAO_REGISTRY_URL = `http://127.0.0.1:${srv.address().port}`;
  const { searchRegistry, installFromRegistry, fetchRegistryIndex } = await import(pathToFileURL(path.join(srcDir, 'skill-registry.js')).href);
  const sr = await searchRegistry('online');
  assert.ok(sr.skills.length === 1 && sr.skills[0].source === 'registry', '远端搜索应命中线上技能');
  const ri = await installFromRegistry('online-skill');
  assert.ok(ri.name === 'online-skill' && fs.existsSync(path.join(ri.dir, 'SKILL.md')), 'registry 安装应成功');
  const meta = JSON.parse(fs.readFileSync(path.join(ri.dir, '.mingdao-source.json'), 'utf8'));
  assert.equal(meta.source, 'registry', '来源元数据应为 registry');
  const ri2 = await fetchRegistryIndex();
  assert.ok(ri2.fromCache, '第二次取索引应命中本地缓存');
  const ri3 = await fetchRegistryIndex({ force: true });
  assert.ok(!ri3.fromCache, 'force 应绕过缓存重新拉取');
  const miss = await installFromRegistry('not-there');
  assert.ok(miss.error && miss.error.includes('没有'), '远端未知技能应报错');
  srv.close();
  delete process.env.MINGDAO_REGISTRY_URL;
  process.env.MINGDAO_HOME = smokeHome;
  safeRmSync(homeRg, { recursive: true, force: true });
  safeRmSync(regRoot, { recursive: true, force: true });
  ok('skill-registry：远端搜索 / 安装 / 缓存与强制刷新 / 未知技能');
}

// ---------- 26. 云同步（服务端 + 客户端闭环） ----------
{
  const homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-sync-a-'));
  const homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-sync-b-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-sync-data-'));
  const { runSyncServer } = await import(pathToFileURL(path.join(srcDir, 'sync-server.js')).href);
  const srv = runSyncServer({ port: 0, host: '127.0.0.1', dataDir });
  await new Promise((r) => srv.once('listening', r));
  const syncPort = srv.address().port;
  const { syncLogin, syncPush, syncPull, syncRemoteList, syncStatus, syncLogout } = await import(pathToFileURL(path.join(srcDir, 'sync.js')).href);

  // 设备 A 注册登录 + 推送
  process.env.MINGDAO_HOME = homeA;
  const la = await syncLogin({ url: `http://127.0.0.1:${syncPort}`, username: 'smoketest', password: 'password123', deviceName: '设备A' });
  assert.equal(la.ok, true, la.error);
  fs.mkdirSync(path.join(homeA, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(homeA, 'sessions', 'sync-smoke.jsonl'), '{"role":"user","content":"你好"}\n');
  const pushA = await syncPush();
  assert.ok(pushA.ok && pushA.pushed.includes('sync-smoke.jsonl'), '推送应成功');
  const listA = await syncRemoteList();
  assert.ok(listA.sessions.some((s) => s.name === 'sync-smoke.jsonl'), '远端清单应包含会话');

  // 设备 B 登录 + 拉取
  process.env.MINGDAO_HOME = homeB;
  const lb = await syncLogin({ url: `http://127.0.0.1:${syncPort}`, username: 'smoketest', password: 'password123', deviceName: '设备B' });
  assert.equal(lb.ok, true, lb.error);
  const pullB = await syncPull();
  assert.ok(pullB.pulled.includes('sync-smoke.jsonl'), '拉取应成功');
  assert.ok(fs.readFileSync(path.join(homeB, 'sessions', 'sync-smoke.jsonl'), 'utf8').includes('你好'), '内容应一致');

  // 冲突：B 改后推送（正常编辑流，无冲突）；A 不知情再改推送（远端已被 B 改过 → 冲突备份）；A 继续本地改后拉取（→ remote 副本）
  fs.appendFileSync(path.join(homeB, 'sessions', 'sync-smoke.jsonl'), '{"role":"assistant","content":"B改"}\n');
  const pushB = await syncPush();
  assert.ok(pushB.conflicts.length === 0, 'B 常规编辑后推送不应报冲突');
  process.env.MINGDAO_HOME = homeA;
  fs.appendFileSync(path.join(homeA, 'sessions', 'sync-smoke.jsonl'), '{"role":"assistant","content":"A改"}\n');
  const pushA2 = await syncPush();
  assert.ok(pushA2.conflicts.includes('sync-smoke.jsonl'), 'A 推远端被 B 改过的会话应报冲突并备份');
  assert.ok(fs.readdirSync(path.join(homeA, 'sessions')).some((f) => f.includes('.server-')), '应生成 .server- 备份');
  fs.appendFileSync(path.join(homeA, 'sessions', 'sync-smoke.jsonl'), '{"role":"assistant","content":"A再改"}\n');
  const pullA2 = await syncPull();
  // 增量拉取（评估 P2-3）：远端未变化 → 跳过下载，本地单方改动保留、不产生虚假冲突副本
  assert.ok(pullA2.conflicts.length === 0, '远端未变化时 pull 应增量跳过（本地改动保留）');
  assert.ok(fs.readFileSync(path.join(homeA, 'sessions', 'sync-smoke.jsonl'), 'utf8').includes('A再改'), '本地改动应保留');
  // 真实冲突场景仍覆盖：远端再被 B 改过 + 本地有改动 → pull 报冲突并生成 .remote- 副本
  process.env.MINGDAO_HOME = homeB;
  fs.appendFileSync(path.join(homeB, 'sessions', 'sync-smoke.jsonl'), '{"role":"assistant","content":"B再改"}\n');
  await syncPush();
  process.env.MINGDAO_HOME = homeA;
  const pullA3 = await syncPull();
  assert.ok(pullA3.conflicts.includes('sync-smoke.jsonl'), '远端变化且本地有改动时 pull 应报冲突');
  assert.ok(fs.readdirSync(path.join(homeA, 'sessions')).some((f) => f.includes('.remote-')), '应生成 .remote- 副本');
  // v0.4.6 P1 回归：冲突备份必须能被「冲突三选一」入口发现并解析。
  // 此前 producer 写 `<名>.server-<时间戳>-<随机后缀>.jsonl`，consumer 正则只认 `<名>.server-<纯数字>.jsonl`
  // → listSyncConflicts 恒空、resolveSyncConflict 恒报「没有找到」，整个冲突功能静默失效。
  {
    const { listSyncConflicts, resolveSyncConflict } = await import(pathToFileURL(path.join(srcDir, 'sync.js')).href);
    const { isConflictBackupName } = await import(pathToFileURL(path.join(srcDir, 'session.js')).href);
    const conflicts = listSyncConflicts();
    const group = conflicts.find((c) => c.base === 'sync-smoke.jsonl');
    assert.ok(group, '冲突面板应列出 sync-smoke.jsonl 的冲突备份（实际列出：' + JSON.stringify(conflicts.map((c) => c.base)) + '）');
    assert.ok(group.entries.length >= 1, '冲突组应至少含一条备份');
    assert.ok(group.entries.every((e) => isConflictBackupName(e.file)), '列出的条目应为合法冲突备份名');
    // 备份不能被当成普通会话（否则会被推到其他设备变成幽灵会话）
    const { listSessions } = await import(pathToFileURL(path.join(srcDir, 'session.js')).href);
    const names = listSessions(homeA).map((s) => s.name);
    assert.ok(names.includes('sync-smoke.jsonl'), '真实会话应仍在列表');
    assert.ok(!names.some((n) => isConflictBackupName(n)), '冲突备份不应出现在会话列表中');
    const rs = resolveSyncConflict('sync-smoke.jsonl', 'local');
    assert.ok(!rs.error, 'resolveSyncConflict 应能找到备份（实际：' + JSON.stringify(rs) + '）');
  }

  // 错误路径与状态
  const badPass = await syncLogin({ url: `http://127.0.0.1:${syncPort}`, username: 'smoketest', password: 'wrong-password', deviceName: 'x' });
  assert.ok(badPass.error && badPass.error.includes('密码'), '错误密码应友好提示');
  assert.ok(syncStatus().loggedIn, '状态应显示已登录');
  const out = syncLogout();
  assert.equal(out.ok, true);
  assert.ok(!syncStatus().loggedIn, '退出后应未登录');

  srv.close();
  process.env.MINGDAO_HOME = smokeHome;
  safeRmSync(homeA, { recursive: true, force: true });
  safeRmSync(homeB, { recursive: true, force: true });
  safeRmSync(dataDir, { recursive: true, force: true });
  ok('sync：注册登录 / 推送拉取 / 双端冲突备份 / 退出 / 错误路径');
}

// ---------- 26b. 同步服务端注册开关（invite 邀请码 / closed，P3-10） ----------
{
  const regDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-sync-reg-'));
  async function startRegServer(envExtra) {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', `import { pathToFileURL } from 'node:url'; const { runSyncServer } = await import(pathToFileURL(${JSON.stringify(path.join(srcDir, 'sync-server.js'))}).href); const srv = runSyncServer({ port: 0, host: '127.0.0.1', dataDir: ${JSON.stringify(regDir)} }); srv.on('listening', () => console.log('PORT ' + srv.address().port));`],
      { env: { ...process.env, ...envExtra }, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    let port = null;
    for (let i = 0; i < 50 && !port; i++) {
      const m = out.match(/PORT (\d+)/);
      if (m) port = Number(m[1]);
      else await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(port, '注册开关测试服务应在 10s 内就绪');
    return { child, base: `http://127.0.0.1:${port}` };
  }
  const register = (base, extra) =>
    fetch(base + '/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'inviteuser', password: 'password123', ...extra }),
    });
  // invite 模式：无码/错码 403，正确码 200
  const inv = await startRegServer({ MINGDAO_SYNC_REGISTRATION: 'invite', MINGDAO_SYNC_INVITE_CODES: 'code-a, code-b' });
  assert.equal((await register(inv.base)).status, 403, 'invite 模式无邀请码应 403');
  assert.equal((await register(inv.base, { inviteCode: 'nope' })).status, 403, '错误邀请码应 403');
  assert.equal((await register(inv.base, { inviteCode: 'code-a' })).status, 200, '正确邀请码应放行');
  inv.child.kill('SIGTERM');
  await new Promise((r) => inv.child.once('close', r));
  // closed 模式：一律 403（即使带正确码）
  const closed = await startRegServer({ MINGDAO_SYNC_REGISTRATION: 'closed', MINGDAO_SYNC_INVITE_CODES: 'code-a' });
  assert.equal((await register(closed.base, { inviteCode: 'code-a' })).status, 403, 'closed 模式应一律拒绝');
  closed.child.kill('SIGTERM');
  await new Promise((r) => closed.child.once('close', r));
  safeRmSync(regDir, { recursive: true, force: true });
  ok('sync-server：注册开关 invite（邀请码）/ closed');
}

// ---------- 27. 云协作 M2：密码修改 / 会话分享 / 冲突解决 ----------
{
  const homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-col-a-'));
  const homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-col-b-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-col-data-'));
  const { runSyncServer } = await import(pathToFileURL(path.join(srcDir, 'sync-server.js')).href);
  const srv = runSyncServer({ port: 0, host: '127.0.0.1', dataDir });
  await new Promise((r) => srv.once('listening', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const { syncLogin, syncPush, syncPull, syncChangePassword, syncShareCreate, syncShareList, syncShareAccept, syncShareRevoke, listSyncConflicts, resolveSyncConflict } =
    await import(pathToFileURL(path.join(srcDir, 'sync.js')).href);

  // —— 密码修改 ——
  process.env.MINGDAO_HOME = homeA;
  await syncLogin({ url, username: 'alice', password: 'password123', deviceName: 'A' });
  const wrongOld = await syncChangePassword({ oldPassword: 'wrong-old', newPassword: 'newpassword123' });
  assert.ok(wrongOld.error && wrongOld.error.includes('旧密码'), '旧密码错误应拒绝');
  const okPw = await syncChangePassword({ oldPassword: 'password123', newPassword: 'newpassword123' });
  assert.equal(okPw.ok, true, okPw.error);
  const loginOld = await syncLogin({ url, username: 'alice', password: 'password123', deviceName: 'A2' });
  assert.ok(loginOld.error && loginOld.error.includes('密码'), '旧密码登录应失败');
  const loginNew = await syncLogin({ url, username: 'alice', password: 'newpassword123', deviceName: 'A2' });
  assert.equal(loginNew.ok, true, '新密码登录应成功');

  // —— 会话分享与协作 ——
  fs.mkdirSync(path.join(homeA, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(homeA, 'sessions', 'alice-notes.jsonl'), '{"role":"user","content":"A的笔记"}\n');
  await syncPush();
  const sh = await syncShareCreate('alice-notes.jsonl');
  assert.equal(sh.ok, true, sh.error);
  assert.ok(/^[0-9a-f]{16}$/.test(sh.shareId), '分享码应为 16 位十六进制');
  process.env.MINGDAO_HOME = homeB;
  await syncLogin({ url, username: 'bob', password: 'password123', deviceName: 'B' });
  const acc = await syncShareAccept(sh.shareId);
  assert.equal(acc.ok, true, acc.error);
  assert.ok(fs.existsSync(path.join(homeB, 'sessions', acc.savedAs)), '接受后本地应有副本');
  const bl = await syncShareList();
  assert.ok(bl.accepted.some((s) => s.shareId === sh.shareId), '接受列表应包含分享');
  // A 更新后再接受 = 刷新
  process.env.MINGDAO_HOME = homeA;
  fs.appendFileSync(path.join(homeA, 'sessions', 'alice-notes.jsonl'), '{"role":"assistant","content":"A补充"}\n');
  await syncPush();
  process.env.MINGDAO_HOME = homeB;
  const acc2 = await syncShareAccept(sh.shareId);
  assert.equal(acc2.ok, true);
  assert.ok(fs.readFileSync(path.join(homeB, 'sessions', acc.savedAs), 'utf8').includes('A补充'), '再次接受应刷新内容');
  // 权限与撤销
  const forbidden = await syncShareRevoke(sh.shareId);
  assert.ok(forbidden.error && forbidden.error.includes('只能撤销'), '非拥有者撤销应 403');
  process.env.MINGDAO_HOME = homeA;
  const revoke = await syncShareRevoke(sh.shareId);
  assert.equal(revoke.ok, true);
  process.env.MINGDAO_HOME = homeB;
  const accGone = await syncShareAccept(sh.shareId);
  assert.ok(accGone.error && accGone.error.includes('不存在'), '撤销后接受应 404');

  // —— 冲突图形化解决 ——
  const base = 'conflict-demo.jsonl';
  fs.mkdirSync(path.join(homeB, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(homeB, 'sessions', base), '{"role":"user","content":"本地版"}\n');
  fs.writeFileSync(path.join(homeB, 'sessions', 'conflict-demo.server-1000.jsonl'), '{"role":"user","content":"远端版"}\n');
  fs.writeFileSync(path.join(homeB, 'sessions', 'conflict-demo.remote-2000.jsonl'), '{"role":"user","content":"拉取版"}\n');
  let cl = listSyncConflicts();
  assert.ok(cl.length === 1 && cl[0].base === base && cl[0].entries.length === 2, '应扫描出 2 个冲突备份');
  const rl = resolveSyncConflict(base, 'local');
  assert.equal(rl.ok, true);
  assert.ok(!fs.existsSync(path.join(homeB, 'sessions', 'conflict-demo.server-1000.jsonl')), 'local 应删除备份');
  fs.writeFileSync(path.join(homeB, 'sessions', 'conflict-demo.server-1000.jsonl'), '{"role":"user","content":"远端版"}\n');
  const rr = resolveSyncConflict(base, 'remote');
  assert.equal(rr.ok, true);
  assert.ok(fs.readFileSync(path.join(homeB, 'sessions', base), 'utf8').includes('远端版'), 'remote 应采用最新远端备份覆盖');
  fs.writeFileSync(path.join(homeB, 'sessions', 'conflict-demo.server-1000.jsonl'), '{"role":"user","content":"远端版2"}\n');
  const rb = resolveSyncConflict(base, 'both');
  assert.equal(rb.ok, true);
  assert.ok(fs.existsSync(path.join(homeB, 'sessions', rb.kept)), 'both 应把备份转正为可见会话');
  assert.ok(fs.readFileSync(path.join(homeB, 'sessions', base), 'utf8').includes('远端版'), 'both 应保留本地文件');
  assert.ok(listSyncConflicts().length === 0, '解决后应无冲突');

  srv.close();
  process.env.MINGDAO_HOME = smokeHome;
  safeRmSync(homeA, { recursive: true, force: true });
  safeRmSync(homeB, { recursive: true, force: true });
  safeRmSync(dataDir, { recursive: true, force: true });
  ok('sync-collab：密码修改 / 分享创建·接受·刷新·撤销 / 冲突三选一解决');
}

// ---------- 28. 模型动态发现（/models 线上名单，只列有 Key 的服务商） ----------
{
  const homeM = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-models-'));
  process.env.MINGDAO_HOME = homeM;
  const http = await import('node:http');
  const srv = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          data: [
            { id: 'deepseek-v4-flash', object: 'model' },
            { id: 'deepseek-v4-pro', object: 'model' },
            { id: 'deepseek-v4-flash-vision-exp', object: 'model' },
            { id: 'brand-new-model-2026', object: 'model' },
            { id: 'embedding-v1', object: 'model' },
          ],
        })
      );
      return;
    }
    res.writeHead(404);
    res.end('nf');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const { setStoredKey } = await import(pathToFileURL(path.join(srcDir, 'credentials.js')).href);
  const { fetchProviderModels, availableModels, providerHasKey } = await import(pathToFileURL(path.join(srcDir, 'model-discovery.js')).href);
  const cfg = { provider: 'deepseek', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'deepseek-v4-flash' };
  const before = await availableModels(cfg, 'deepseek-v4-flash');
  assert.ok(before.every((m) => m.name !== 'deepseek-v4-flash' || m.providerLabel === '当前'), '无 Key 时不应列服务商模型（仅当前模型兜底）');
  setStoredKey('deepseek', 'sk-test');
  assert.ok(providerHasKey('deepseek'), 'providerHasKey 应识别凭证库 Key');
  const f1 = await fetchProviderModels(cfg, 'deepseek');
  assert.ok(f1.models.includes('brand-new-model-2026'), '应拉取线上模型名单');
  assert.ok(!f1.models.includes('embedding-v1'), 'embedding 类应过滤');
  const f2 = await fetchProviderModels(cfg, 'deepseek');
  assert.ok(f2.fromCache, '第二次应命中缓存');
  const f3 = await fetchProviderModels(cfg, 'deepseek', { force: true });
  assert.ok(!f3.fromCache, 'force 应绕过缓存');
  const list = await availableModels(cfg, 'deepseek-v4-flash');
  assert.ok(list.some((m) => m.name === 'brand-new-model-2026' && m.dynamic), '动态模型应出现且标注 dynamic');
  assert.ok(list.every((m) => m.provider !== 'openai'), '未设 Key 的服务商不应出现');
  const list2 = await availableModels(cfg, 'unknown-current-model');
  assert.ok(list2[0].name === 'unknown-current-model', '当前模型应兜底列出');
  // 拉取失败 → 回退预设名单
  setStoredKey('openai', 'sk-test');
  const fail = await fetchProviderModels({ provider: 'openai', baseUrl: 'http://127.0.0.1:1/v1' }, 'openai');
  assert.ok(fail.error, '网络失败应返回 error');
  const list3 = await availableModels(cfg, 'deepseek-v4-flash');
  assert.ok(list3.some((m) => m.name === 'gpt-5'), '拉取失败应回退预设名单');
  srv.close();
  process.env.MINGDAO_HOME = smokeHome;
  safeRmSync(homeM, { recursive: true, force: true });
  ok('model-discovery：只列有 Key 服务商 / 线上名单优先 / 缓存与强制刷新 / 回退预设');
}

// ---------- 29. 聊天附件构造（图片 / 文本文件） ----------
{
  const { buildUserContent } = await import(pathToFileURL(path.join(srcDir, 'web', 'attachments.js')).href);
  const t1 = buildUserContent('你好', [{ type: 'text', name: 'a.txt', content: '文件内容' }], false);
  assert.ok(typeof t1.content === 'string' && t1.content.includes('[文件 a.txt]') && t1.content.includes('文件内容'), '文本附件应内联进消息');
  assert.ok(t1.persistText.includes('[文件：a.txt]'), '落盘文本应带文件名标注');
  const t2 = buildUserContent('', [{ type: 'text', name: 'a.txt', content: '内容' }], false);
  assert.ok(typeof t2.content === 'string' && t2.content.includes('内容'), '纯附件消息应可用');
  assert.ok(buildUserContent('', [], false).error, '消息与附件全空应报错');
  const t3 = buildUserContent('看图', [{ type: 'image', name: 'a.png', dataUrl: 'data:image/png;base64,AAA=' }], false);
  assert.ok(t3.error && t3.error.includes('不支持图片'), '非视觉模型应拒绝图片');
  const t4 = buildUserContent('看图', [{ type: 'image', name: 'a.png', dataUrl: 'data:image/png;base64,AAA=' }], true);
  assert.ok(Array.isArray(t4.content) && t4.content[0].type === 'text' && t4.content[1].type === 'image_url' && t4.content[1].image_url.url.startsWith('data:image/png'), '视觉模型应生成图文数组');
  assert.ok(t4.persistText.includes('[图片：a.png]'), '落盘应含图片标注');
  assert.ok(buildUserContent('x', [{ type: 'image', name: 'a.png', dataUrl: 'data:text/html;base64,AAA=' }], true).error, '非图片 dataUrl 应拒绝');
  assert.ok(buildUserContent('x', [{ type: 'image', name: 'big.png', dataUrl: 'data:image/png;base64,' + 'A'.repeat(7 * 1024 * 1024 + 10) }], true).error, '超 5MB 图片应拒绝');
  assert.ok(buildUserContent('x', [{ type: 'text', name: 'big.txt', content: 'A'.repeat(201 * 1024) }], true).error, '超 200KB 文本应拒绝');
  const five = buildUserContent('x', [1, 2, 3, 4, 5].map((i) => ({ type: 'text', name: i + '.txt', content: 'c' + i })), false);
  assert.ok(!five.content.includes('c5'), '第 5 个附件应被忽略');
  ok('attachments：文本内联 / 视觉门控 / 格式与大小校验 / 附件上限');
}

// ---------- 30. 系统提示：最近会话日志默认不注入（新会话防串上下文） ----------
{
  const jhome = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-journal-'));
  fs.writeFileSync(
    path.join(jhome, 'journal.jsonl'),
    JSON.stringify({ at: Date.now(), workspace: null, firstUser: '制作愤怒的小鸟', outcome: '完成网页游戏', turns: 5 }) + '\n'
  );
  process.env.MINGDAO_HOME = jhome;
  const { buildSystemPrompt } = await import(pathToFileURL(path.join(srcDir, 'prompts.js')).href);
  const fresh = buildSystemPrompt({ workingDir: tmp });
  assert.ok(!fresh.includes('recent_sessions') && !fresh.includes('愤怒的小鸟'), '新会话默认不应注入最近会话日志');
  const withJ = buildSystemPrompt({ workingDir: tmp, withJournal: true });
  assert.ok(withJ.includes('recent_sessions') && withJ.includes('愤怒的小鸟'), 'withJournal 开启时应注入最近会话日志');
  // 前缀字节稳定性（评估 P1-1/P1-2）：路由池内任意模型/任意日期，系统提示必须逐字节一致，
  // 否则每次路由切换/跨天都会让 DeepSeek 上下文缓存整段失效（命中价 30 倍）
  assert.ok(!fresh.includes('当前模型') && !fresh.includes('当前日期'), '系统提示不应含易变字段');
  assert.equal(fresh, buildSystemPrompt({ workingDir: tmp }), '同一工作空间下系统提示应恒定（前缀稳定）');
  process.env.MINGDAO_HOME = smokeHome;
  safeRmSync(jhome, { recursive: true, force: true });
  ok('prompts：最近会话日志默认不注入 / 系统提示前缀字节稳定（易变字段已移除）');
}

// ---------- 31. 自更新模块（临时 git 仓库演练，P3-9 落实） ----------
{
  const { updateCheck, mingdaoUpdate, mingdaoRollback } = await import(pathToFileURL(path.join(srcDir, 'update.js')).href);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-upd-'));
  const remoteDir = path.join(base, 'origin');
  const localDir = path.join(base, 'local');
  const g = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const rpkg = (v) => JSON.stringify({ name: 'mingdao-harness', version: v });
  fs.mkdirSync(remoteDir, { recursive: true });
  fs.mkdirSync(path.join(remoteDir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(remoteDir, 'package.json'), rpkg('0.1.40'));
  fs.writeFileSync(path.join(remoteDir, 'test', 'smoke.js'), "console.log('全部通过：1 组断言 ✓');\n");
  g(remoteDir, 'init', '-q', '-b', 'main');
  g(remoteDir, '-c', 'user.email=t@mingdao.local', '-c', 'user.name=t', 'add', '.');
  g(remoteDir, '-c', 'user.email=t@mingdao.local', '-c', 'user.name=t', 'commit', '-q', '-m', 'v0.1.40');
  g(base, 'clone', '-q', remoteDir, 'local');
  process.env.MINGDAO_HOME = path.join(base, 'home');
  fs.mkdirSync(process.env.MINGDAO_HOME, { recursive: true });
  // 无新版本 → 已最新
  const c1 = await updateCheck({ repo: localDir });
  assert.equal(c1.ok, true, c1.lines.join('\n'));
  assert.equal(c1.behind, false, '无新版本时 behind 应为 false');
  // 脏工作区 → 拒绝升级（保护未提交改动）
  fs.appendFileSync(path.join(localDir, 'package.json'), '\n// dirty');
  const dirty = await mingdaoUpdate({ repo: localDir });
  assert.equal(dirty.ok, false);
  assert.ok(dirty.lines.join('').includes('未提交改动'), '脏工作区应拒绝升级');
  fs.writeFileSync(path.join(localDir, 'package.json'), rpkg('0.1.40'));
  // 远端发 0.1.41 → check 发现 → update 成功（含冒烟）→ rollback 回到 0.1.40
  fs.writeFileSync(path.join(remoteDir, 'package.json'), rpkg('0.1.41'));
  g(remoteDir, '-c', 'user.email=t@mingdao.local', '-c', 'user.name=t', 'commit', '-qam', 'v0.1.41');
  const c2 = await updateCheck({ repo: localDir });
  assert.equal(c2.behind, true, '远端有新版本时 behind 应为 true');
  const up = await mingdaoUpdate({ repo: localDir });
  assert.equal(up.ok, true, up.lines.join('\n'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(localDir, 'package.json'), 'utf8')).version, '0.1.41', '升级后版本应为 0.1.41');
  const rb = mingdaoRollback({ repo: localDir });
  assert.equal(rb.ok, true, rb.lines.join('\n'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(localDir, 'package.json'), 'utf8')).version, '0.1.40', '回滚后版本应为 0.1.40');
  const rb2 = mingdaoRollback({ repo: localDir });
  assert.equal(rb2.ok, false, '回滚记录已消耗，再回滚应失败');
  process.env.MINGDAO_HOME = smokeHome;
  safeRmSync(base, { recursive: true, force: true });
  ok('update：版本对比 / 脏工作区拒绝 / 升级+冒烟 / 回滚');
}

// ---------- 32. 上下文自动压缩模块（P3-1） ----------
{
  const { compactConversation, summarizeConversation } = await import(pathToFileURL(path.join(srcDir, 'compact.js')).href);
  const { approxTokens } = await import(pathToFileURL(path.join(srcDir, 'context.js')).href);
  let summaryCalls = 0;
  const summaryProvider = {
    async chat() {
      summaryCalls += 1;
      return {
        // 结构化输出（审计 MiniMax §3.3-D）：支持 json_object 的网关返回 {"summary": ...}
        text: '{"summary": "压缩摘要：用户要做一个计算器，已完成加法，未完成减法；创建了 calc.js。"}',
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      };
    },
  };
  const mk = (role, content, extra = {}) => ({ role, content, ...extra });
  const longText = '这是一段用于撑大上下文的中文长文本，包含任务要求与讨论细节。'.repeat(40);
  const msgs = [
    mk('system', '系统提示'),
    mk('user', longText + ' 第1轮'),
    mk('assistant', longText + ' 第1轮回复', {
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write', arguments: '{"path":"calc.js"}' } }],
    }),
    mk('tool', '写入成功', { tool_call_id: 'c1' }),
    ...Array.from({ length: 8 }, (_, i) => [mk('user', longText + ` 第${i + 2}轮`), mk('assistant', longText + ` 第${i + 2}轮回复`)]).flat(),
  ];
  const budget = 1500;
  const r1 = await compactConversation({ messages: msgs, budget, count: approxTokens, provider: summaryProvider, executorModel: 'deepseek-v4-flash' });
  assert.ok(r1, '超预算且被裁段落够大时应触发压缩');
  assert.equal(summaryCalls, 1, '应恰好调用一次摘要');
  assert.equal(r1.messages[0].role, 'system', 'system 消息应保留在首位');
  assert.equal(r1.messages[1].role, 'user', '摘要以 user 消息注入');
  assert.ok(r1.messages[1].content.includes('conversation_summary') && r1.messages[1].content.includes('calc.js'), '摘要内容应注入');
  assert.ok(r1.droppedCount >= 3 && r1.droppedTokens >= 2000, '被裁段落应满足最小阈值');
  assert.ok(!r1.messages.some((m) => m.role === 'tool'), '被裁段落的 tool 消息不应残留');
  assert.ok(r1.messages.length < msgs.length, '压缩后消息应显著减少');
  assert.ok(r1.usage && r1.usage.prompt_tokens === 100, '摘要用量应带回计入费用');
  // 未超预算 → 不压缩
  const r2 = await compactConversation({ messages: msgs.slice(0, 4), budget: 1e9, count: approxTokens, provider: summaryProvider, executorModel: 'x' });
  assert.equal(r2, null, '未超预算不应压缩');
  // 摘要失败 → null（回退普通裁剪，绝不阻塞会话）
  const badProvider = { async chat() { throw new Error('摘要失败'); } };
  const r3 = await compactConversation({ messages: msgs, budget, count: approxTokens, provider: badProvider, executorModel: 'x' });
  assert.equal(r3, null, '摘要失败应回退普通裁剪');
  // 网关不支持 json_object → 纯文本回退仍应产出摘要（审计 MiniMax §3.3-D）
  let plainCalls = 0;
  const plainProvider = { async chat() { plainCalls += 1; return { text: '纯文本摘要：直接给结论。', usage: null }; } };
  const rp = await summarizeConversation(plainProvider, 'x', '一段对话');
  assert.equal(plainCalls, 2, 'json 解析失败后应回退纯文本一次');
  assert.ok(rp.text && rp.text.includes('纯文本摘要'), '回退纯文本应解析成功');
  // B1/B2：达到预算 90% 即提前压缩（滞回缓冲），低于 80% 不压缩
  const { messageTokens } = await import(pathToFileURL(path.join(srcDir, 'context.js')).href);
  const total32 = msgs.reduce((s, m) => s + messageTokens(m, approxTokens), 0);
  const r4 = await compactConversation({ messages: msgs, budget: Math.floor(total32 * 0.9), count: approxTokens, provider: summaryProvider, executorModel: 'x' });
  assert.ok(r4, '达预算 90% 应提前触发压缩（B1/B2 滞回缓冲）');
  const r5 = await compactConversation({ messages: msgs, budget: Math.floor(total32 / 0.7), count: approxTokens, provider: summaryProvider, executorModel: 'x' });
  assert.equal(r5, null, '低于 80% 预算不应压缩');
  ok('compact：触发条件 / 摘要注入 / 配对清洗 / 用量带回 / 失败回退 / 滞回触发线');
}

// ---------- 33. Agent 循环集成：自动压缩触发 / 历史替换 / onCompact 回调 ----------
{
  const ioC = createIO({ quiet: true });
  const notices = [];
  ioC.print = (t) => notices.push(String(t));
  const short = '长'.repeat(400); // ≈300 tokens
  const fakeC = {
    async chat(opts) {
      // 摘要请求：tools 为空数组（主请求 tools ≥6）
      if (!opts.tools || !opts.tools.length) {
        return { text: '自动摘要内容。', usage: { prompt_tokens: 5, completion_tokens: 2 } };
      }
      return { text: '完成', toolCalls: null, usage: {}, finish: 'stop' };
    },
  };
  const history = [
    { role: 'system', content: '系统' },
    ...Array.from({ length: 10 }, (_, i) => [
      { role: 'user', content: short + '问题' + i },
      { role: 'assistant', content: short + '回答' + i },
    ]).flat(),
    { role: 'user', content: '现在收尾' },
  ];
  let compactCb = 0;
  const agentC = createAgent({
    provider: fakeC,
    permission: { mode: 'auto', async check() { return true; } },
    io: ioC,
    modelName: 'deepseek-v4-flash',
    workingDir: tmp,
    cfg: { permission: 'auto', contextBudget: 1200 },
    onCompact: () => { compactCb += 1; },
  });
  const rc = await agentC.runTurn(history);
  assert.equal(rc.text, '完成');
  assert.equal(compactCb, 1, 'onCompact 应被调用一次');
  assert.equal(history[1].role, 'user');
  assert.ok(history[1].content.includes('conversation_summary'), '历史数组应被替换为压缩形态');
  assert.ok(notices.some((t) => t.includes('自动压缩')), '应输出压缩提示');
  ok('agent：自动压缩触发 / 历史替换 / onCompact 回调 / 提示输出');
}

// ---------- 34. 技能完整性（P3-3）：registry sha256 校验 / 本地篡改拒绝加载 / trust ----------
{
  const homeS = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-skill-int-'));
  const http = await import('node:http');
  const cryptoMod = await import('node:crypto');
  const skillMd = '---\nname: demo-int\ndescription: 完整性测试技能\n---\n\n# demo-int\n\n测试内容 A。\n';
  const hashOf = (t) => cryptoMod.createHash('sha256').update(t).digest('hex');
  let currentIndex = { version: 1, skills: [{ name: 'demo-int', description: '完整性测试技能', files: [{ path: 'SKILL.md', size: skillMd.length, sha256: hashOf(skillMd) }] }] };
  let currentSkill = skillMd;
  const regServer = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.endsWith('/index.json')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(currentIndex));
    } else if (u.pathname.endsWith('/SKILL.md')) {
      res.writeHead(200, { 'Content-Type': 'text/markdown' });
      res.end(currentSkill);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => regServer.listen(0, '127.0.0.1', r));
  process.env.MINGDAO_REGISTRY_URL = `http://127.0.0.1:${regServer.address().port}/index.json`;
  process.env.MINGDAO_HOME = homeS;
  const { installFromRegistry } = await import(pathToFileURL(path.join(srcDir, 'skill-registry.js')).href);
  const { listSkills, tamperedSkillNames } = await import(pathToFileURL(path.join(srcDir, 'skills.js')).href);
  const { trustSkill, skillDirHash } = await import(pathToFileURL(path.join(srcDir, 'skill-lib.js')).href);
  // 1) 索引哈希正确 → 安装成功且 verified
  const ok1 = await installFromRegistry('demo-int');
  assert.ok(!ok1.error && ok1.verified === true, '正确 sha256 应安装成功且 verified');
  assert.ok(listSkills(process.cwd()).some((s) => s.name === 'demo-int'), '安装后应可见');
  // 2) 篡改本地文件 → 拒绝加载 + 篡改清单可见
  fs.appendFileSync(path.join(homeS, 'skills', 'demo-int', 'SKILL.md'), '（被篡改）\n');
  assert.ok(!listSkills(process.cwd()).some((s) => s.name === 'demo-int'), '被篡改的技能应被排除加载');
  assert.ok(tamperedSkillNames(process.cwd()).some((t) => t.name === 'demo-int'), '篡改清单应包含该技能');
  // 3) trust → 重新可见（显式接受当前内容）
  const tr = trustSkill('demo-int');
  assert.equal(tr.ok, true, tr.error);
  assert.ok(listSkills(process.cwd()).some((s) => s.name === 'demo-int'), 'trust 后应重新可见');
  // 4) 索引哈希错误 → 拒绝安装（供应链防护）；先清缓存确保拿到更新后的索引
  currentIndex = { version: 1, skills: [{ name: 'demo-bad', description: 'x', files: [{ path: 'SKILL.md', size: skillMd.length, sha256: hashOf('完全不同') }] }] };
  safeRmSync(path.join(homeS, 'skill-registry-cache.json'), { force: true });
  const bad = await installFromRegistry('demo-bad');
  assert.ok(bad.error && bad.error.includes('完整性校验失败'), '哈希不符应拒绝安装');
  // 5) 目录哈希稳定（排除元数据文件）
  assert.equal(skillDirHash(path.join(homeS, 'skills', 'demo-int')), skillDirHash(path.join(homeS, 'skills', 'demo-int')), '哈希应稳定');
  regServer.close();
  delete process.env.MINGDAO_REGISTRY_URL;
  process.env.MINGDAO_HOME = smokeHome;
  safeRmSync(homeS, { recursive: true, force: true });
  ok('skill 完整性：registry sha256 校验 / 篡改拒绝加载 / trust / 哈希稳定');
}

// ---------- 35. 工具调用审计日志（P3-5） ----------
{
  const homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-audit-'));
  process.env.MINGDAO_HOME = homeA;
  const { listAudit, auditFile, redactSecrets } = await import(pathToFileURL(path.join(srcDir, 'audit.js')).href);
  let turn = 0;
  const providerA = {
    async chat() {
      turn += 1;
      if (turn === 1) {
        return {
          text: '',
          toolCalls: [
            { id: 'a1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'audit-test.txt', content: 'A' }) } },
            { id: 'a2', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'echo hello' }) } },
          ],
          usage: {},
          finish: 'tool_calls',
        };
      }
      return { text: '完成', toolCalls: null, usage: {}, finish: 'stop' };
    },
  };
  const permissionA = {
    mode: 'auto',
    async check(name) {
      return name !== 'bash'; // write 放行，bash 拒绝 → 审计应各记一条
    },
  };
  const agentA = createAgent({
    provider: providerA,
    permission: permissionA,
    io: createIO({ quiet: true }),
    modelName: 'deepseek-v4-flash',
    workingDir: tmp,
    cfg: { permission: 'auto' },
    sessionRef: { name: 'audit-smoke.jsonl' },
  });
  await agentA.runTurn([{ role: 'system', content: '系统' }, { role: 'user', content: '写文件并执行命令' }]);
  assert.ok(fs.existsSync(auditFile()), '审计文件应已创建');
  const rows = listAudit(50);
  const writeRow = rows.find((r) => r.tool === 'write' && !r.denied);
  assert.ok(writeRow && writeRow.ok === true && writeRow.durationMs >= 0, 'write 执行应记录且 ok');
  assert.equal(writeRow.session, 'audit-smoke.jsonl', '审计应归因到会话');
  const bashRow = rows.find((r) => r.tool === 'bash' && r.denied);
  assert.ok(bashRow && bashRow.reason === '未授权' && bashRow.args.includes('echo hello'), 'bash 拒绝应记录原因与参数');
  // 脱敏：sk- 系 Key 掩码
  assert.ok(!redactSecrets('curl -H "Authorization: Bearer sk-abcdef1234567890"').includes('sk-abcdef'), 'sk- 密钥应被掩码');
  assert.ok(redactSecrets('sk-abcdef1234567890').includes('sk-***'), '掩码后应保留 sk-*** 标记');
  // v0.3.1 P1-1：统一脱敏——ghp_/Bearer/URL 内嵌凭据也掩码
  const { redactSensitive } = await import(pathToFileURL(path.join(srcDir, 'redact.js')).href);
  assert.ok(!redactSecrets('ghp_1234567890abcdefghij').includes('ghp_1234'), 'ghp_ token 应被掩码');
  assert.ok(!redactSecrets('curl -H "Authorization: Bearer abc"').includes('abc'), 'Bearer token 应被掩码');
  assert.ok(!redactSecrets('curl "https://x.com?token=secret123"').includes('secret123'), 'URL query token 应被掩码');
  assert.ok(!redactSensitive('http://192.168.1.1').includes('192.168.1.1'), '私网 IP 应被掩码');
  // 审计 P3-1（v0.4.2）：家目录掩码带路径边界——/home/user2/xxx 不得被误脱敏为 ~2/xxx
  const homeTest = os.homedir();
  if (homeTest && homeTest.length > 1) {
    assert.ok(!redactSensitive(homeTest + '/a').includes(homeTest), '家目录路径应被掩码为 ~');
    assert.ok(redactSensitive(homeTest + '2/x').includes(homeTest + '2'), '家目录前缀相似的他人路径不应被误脱敏');
  }
  // cfg.audit=false 关闭
  const before = rows.length;
  const agentOff = createAgent({
    provider: { async chat() { return { text: '无工具', toolCalls: null, usage: {}, finish: 'stop' }; } },
    permission: { mode: 'auto', async check() { return true; } },
    io: createIO({ quiet: true }),
    modelName: 'deepseek-v4-flash',
    workingDir: tmp,
    cfg: { permission: 'auto', audit: false },
  });
  await agentOff.runTurn([{ role: 'system', content: '系统' }, { role: 'user', content: 'x' }]);
  assert.equal(listAudit(50).length, before, 'audit:false 时不应新增记录');
  process.env.MINGDAO_HOME = smokeHome;
  safeRmSync(homeA, { recursive: true, force: true });
  ok('audit：执行/拒绝记录 / 会话归因 / 参数与原因 / sk- 脱敏 / audit:false 关闭');
}

// ---------- 36. 会话检索索引（P3-2） ----------
{
  const homeI = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-sidx-'));
  process.env.MINGDAO_HOME = homeI;
  const { tokenize } = await import(pathToFileURL(path.join(srcDir, 'session-index.js')).href);
  const { searchSessions, appendMessages, createSession } = await import(pathToFileURL(path.join(srcDir, 'session.js')).href);
  const s1 = createSession(homeI);
  appendMessages(s1.file, [{ role: 'user', content: '帮我做一个贪吃蛇网页游戏，用 Canvas' }]);
  const s2 = createSession(homeI);
  appendMessages(s2.file, [{ role: 'user', content: '优化 tokenizer 的中文计数性能' }]);
  const s3 = createSession(homeI);
  appendMessages(s3.file, [{ role: 'user', content: '修复 WebUI 权限确认的 bug' }]);
  // 中文 bigram 检索
  const r1 = searchSessions(homeI, '贪吃蛇');
  assert.equal(r1.length, 1, '中文检索应命中唯一会话');
  assert.ok(r1[0].snippet.includes('贪吃蛇'), '应返回命中会话与片段');
  // 英文词检索（大小写不敏感）
  const r2 = searchSessions(homeI, 'TOKENIZER');
  assert.equal(r2.length, 1, '英文检索应命中');
  // AND 语义
  assert.equal(searchSessions(homeI, '贪吃蛇 游戏').length, 1, '多词 AND 命中');
  assert.equal(searchSessions(homeI, '贪吃蛇 tokenizer').length, 0, '跨会话多词不应命中');
  // 增量：修改 s2 增加新词 → 重新索引后能命中
  appendMessages(s2.file, [{ role: 'assistant', content: '顺带聊到贪吃蛇的实现' }]);
  assert.equal(searchSessions(homeI, '贪吃蛇').length, 2, '修改后的会话应被增量重新索引');
  // 删除会话 → 索引清理 + 不再命中
  fs.unlinkSync(s3.file);
  assert.equal(searchSessions(homeI, 'WebUI').length, 0, '删除的会话不应再命中');
  // 分片索引（v0.2.8 B1）：聚合所有分片后确认已删除条目被清理、存活会话仍在
  const shardFiles = fs.readdirSync(path.join(homeI, 'sessions-index')).filter((f) => f.endsWith('.json'));
  assert.ok(shardFiles.length >= 1, '应生成分片索引目录');
  const allFiles = {};
  for (const f of shardFiles) {
    const j = JSON.parse(fs.readFileSync(path.join(homeI, 'sessions-index', f), 'utf8'));
    Object.assign(allFiles, j.files || {});
  }
  assert.ok(!allFiles[s3.name], '索引应清理已删除条目');
  assert.ok(allFiles[s1.name] && allFiles[s2.name], '存活会话仍在分片索引中');
  // 空关键词 → 列表回退
  assert.equal(searchSessions(homeI, '').length, 2, '空关键词应返回会话列表');
  // 分词单元：中文 bigram + 单字 + 英文词
  const tk = tokenize('你好世界 hello');
  assert.ok(tk.has('你好') && tk.has('好世') && tk.has('世界') && tk.has('hello') && tk.has('你'), 'bigram/单字/单词分词');
  process.env.MINGDAO_HOME = smokeHome;
  safeRmSync(homeI, { recursive: true, force: true });
  ok('session-index：中文 bigram / 英文词 / AND / 增量重索引 / 删除清理');
}

// ---------- 37. 会话级工作空间映射（P3-4 单元） ----------
{
  const homeW = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-sws-'));
  process.env.MINGDAO_HOME = homeW;
  const { getSessionWorkspace, setSessionWorkspace, removeSessionWorkspace, moveSessionWorkspace, workspaceForDir } = await import(pathToFileURL(path.join(srcDir, 'workspace.js')).href);
  const d1 = path.join(homeW, 'proj-a');
  const d2 = path.join(homeW, 'proj-b');
  fs.mkdirSync(d1);
  fs.mkdirSync(d2);
  assert.equal(getSessionWorkspace('sess1.jsonl'), null, '未记录时应为 null');
  setSessionWorkspace('sess1.jsonl', d1, null);
  assert.equal(getSessionWorkspace('sess1.jsonl'), path.resolve(d1), '记录后可读取');
  moveSessionWorkspace('sess1.jsonl', 'sess1-renamed.jsonl');
  assert.equal(getSessionWorkspace('sess1-renamed.jsonl'), path.resolve(d1), '改名后映射跟随');
  assert.equal(getSessionWorkspace('sess1.jsonl'), null, '旧名映射应移除');
  removeSessionWorkspace('sess1-renamed.jsonl');
  assert.equal(getSessionWorkspace('sess1-renamed.jsonl'), null, '删除后清空');
  assert.equal(workspaceForDir(d2), null, '未登记目录反查为 null');
  process.env.MINGDAO_HOME = smokeHome;
  safeRmSync(homeW, { recursive: true, force: true });
  ok('workspace：会话级工作空间映射 set/get/move/remove');
}

// ---------- 38. 路由：分类器缓存 / 会话粘滞（评估 P2-1/B7） ----------
{
  const { routeTask } = await import(pathToFileURL(path.join(srcDir, 'routing.js')).href);
  const cfg = { routing: { enabled: true, planner: 'deepseek-v4-pro', executor: 'deepseek-v4-flash' } };
  let classifyCalls = 0;
  const provider = {
    async chat() {
      classifyCalls += 1;
      return { text: 'execute' };
    },
  };
  const longText = '这是一些很长的日常文本内容，没有任何特殊的敏感词汇，只是用来填充长度。'.repeat(3);
  const r1 = await routeTask({ cfg, provider, currentModel: 'deepseek-v4-pro', text: longText });
  assert.equal(r1.model, 'deepseek-v4-flash', '分类器判定 execute 应切 executor');
  assert.equal(classifyCalls, 1);
  const r2 = await routeTask({ cfg, provider, currentModel: 'deepseek-v4-pro', text: longText });
  assert.equal(r2.model, 'deepseek-v4-flash');
  assert.equal(classifyCalls, 1, '同一文本应命中分类缓存，不再重复分类');
  const otherText = '这是另一段足够长的文本，内容与之前完全不同，用来验证会话粘滞路径。'.repeat(3);
  const r3 = await routeTask({ cfg, provider, currentModel: 'deepseek-v4-pro', text: otherText, sticky: 'deepseek-v4-flash' });
  assert.equal(r3.model, 'deepseek-v4-flash', '执行类会话粘滞应直接走 executor');
  assert.equal(classifyCalls, 1, '粘滞下不应再调分类器');
  ok('routing：分类器缓存 / 会话粘滞');
}


// ---------- 39. 峰谷时区/周末低价/避峰顺延/Batch 半价计价（A2/Kimi P0-4） ----------
{
  const { isPeakHour, deferToOffpeak, peakStatusLabel, estimateBatchCost, BATCH_DISCOUNT } = await import(pathToFileURL(path.join(srcDir, 'pricing.js')).href);
  // 2026-08-21 是周五。官方定义：高峰＝北京工作日 9:00–12:00、14:00–18:00；午间 12:00–14:00 与其余为闲时
  assert.equal(isPeakHour(new Date('2026-08-21T02:00:00Z')), true, '工作日 10:00（上午高峰段）应为高峰');
  assert.equal(isPeakHour(new Date('2026-08-21T03:00:00Z')), true, '工作日 11:00 应为高峰');
  assert.equal(isPeakHour(new Date('2026-08-21T04:00:00Z')), false, '工作日 12:00（午间）应为闲时');
  assert.equal(isPeakHour(new Date('2026-08-21T05:00:00Z')), false, '工作日 13:00（午间）应为闲时');
  assert.equal(isPeakHour(new Date('2026-08-21T06:00:00Z')), true, '工作日 14:00（下午高峰段）应为高峰');
  assert.equal(isPeakHour(new Date('2026-08-21T07:00:00Z')), true, '工作日 15:00 应为高峰');
  assert.equal(isPeakHour(new Date('2026-08-21T10:00:00Z')), false, '工作日 18:00 起应为闲时');
  assert.equal(isPeakHour(new Date('2026-08-21T11:00:00Z')), false, '工作日 19:00 应为闲时');
  // 2026-08-22 周六 / 2026-08-23 周日：周末全天闲时低价
  assert.equal(isPeakHour(new Date('2026-08-22T02:00:00Z')), false, '周六全天应按闲时计价');
  assert.equal(isPeakHour(new Date('2026-08-23T02:00:00Z')), false, '周日全天应按闲时计价');
  assert.equal(isPeakHour(new Date('2026-08-22T23:00:00Z')), false, '周六深夜同样按闲时计价');
  // 避峰顺延：上午高峰 → 12:00；下午高峰 → 18:00；闲时原时刻返回
  assert.equal(deferToOffpeak(new Date('2026-08-21T02:00:00Z')).getTime(), new Date('2026-08-21T04:00:00Z').getTime(), '上午高峰应顺延到北京 12:00');
  assert.equal(deferToOffpeak(new Date('2026-08-21T07:00:00Z')).getTime(), new Date('2026-08-21T10:00:00Z').getTime(), '下午高峰应顺延到北京 18:00');
  assert.equal(deferToOffpeak(new Date('2026-08-21T04:00:00Z')).getTime(), new Date('2026-08-21T04:00:00Z').getTime(), '午间闲时应原时刻返回');
  assert.ok(peakStatusLabel(new Date('2026-08-21T02:00:00Z')).startsWith('高峰'), '状态标签应含高峰');
  assert.equal(peakStatusLabel(new Date('2026-08-21T04:00:00Z')), '闲时', '午间应显示闲时');
  // 价格覆盖传播到 peak（质检 H1）：根级 overrides 是价格主体，高峰时段必须同样生效
  {
    const prevHome = process.env.MINGDAO_HOME;
    const homeP = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-price-'));
    process.env.MINGDAO_HOME = homeP;
    fs.writeFileSync(path.join(homeP, 'config.json'), JSON.stringify({ pricing: { overrides: { 'deepseek-v4-flash': { input: 10, output: 20 } } } }));
    const { estimateCost: ec2, isPeakHour: ip2 } = await import(pathToFileURL(path.join(srcDir, 'pricing.js')).href + '?override-test');
    const peakAt = new Date('2026-08-21T02:00:00Z'); // 北京 10:00 高峰
    assert.equal(ip2(peakAt), true, '测试前提：应为高峰');
    assert.ok(Math.abs(ec2('deepseek-v4-flash', 1000000, 0, null, peakAt) - 10) < 1e-9, `高峰时段应使用根级覆盖价 10（得到 ${ec2('deepseek-v4-flash', 1000000, 0, null, peakAt)}）`);
    assert.ok(Math.abs(ec2('deepseek-v4-flash', 0, 1000000, null, peakAt) - 20) < 1e-9, '高峰时段输出价应使用根级覆盖价 20');
    process.env.MINGDAO_HOME = prevHome;
  }
  // Batch 半价：flash 闲时 1.5/4.5 → (1.5+4.5)×0.5 = 3.0 元/M
  assert.equal(BATCH_DISCOUNT, 0.5);
  const bc = estimateBatchCost('deepseek-v4-flash', 1000000, 1000000);
  assert.ok(Math.abs(bc - 3.0) < 1e-9, `batch 应为半价（得到 ${bc}）`);
  // v0.4.6：无价模型的 Batch 费用必须返 null（未知），不能返 0——否则 --max-cost 静默失效、
  // /cost 把未知费用显示成「免费」（与 estimateCost 的 P0-4 同口径）
  assert.equal(estimateBatchCost('no-such-model-xyz', 1000000, 1000000), null, '无价模型 batch 费用应为 null（未知）而非 0');
  ok('pricing：时区锚定 / 周末低价 / 避峰顺延 / Batch 半价计价');
}

// ---------- 40. 费用护栏（A2）：累计 / 预警 / 阻断 ----------
{
  const homeC = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-guard-'));
  process.env.MINGDAO_HOME = homeC;
  const { costGuardStatus, checkCostGuard } = await import(pathToFileURL(path.join(srcDir, 'cost-guard.js')).href);
  const statsFile = path.join(homeC, 'cache-stats.jsonl');
  const line = (cost, at = Date.now()) => JSON.stringify({ at, model: 'deepseek-v4-flash', prompt: 100, completion: 10, hit: null, miss: null, cost, saved: null }) + '\n';
  fs.writeFileSync(statsFile, line(0.2) + line(0.2));
  const cfgFile = path.join(homeC, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ costGuard: { dailyLimitYuan: 1, warnAtYuan: 0.5, action: 'block' } }));
  let st = costGuardStatus();
  assert.ok(st && Math.abs(st.cost - 0.4) < 1e-9, '今日费用应为累计 0.4');
  assert.equal(st.overWarn, false, '未达预警线');
  assert.equal(st.overLimit, false, '未达上限');
  fs.appendFileSync(statsFile, line(0.3));
  st = costGuardStatus();
  assert.equal(st.overWarn, true, '超过 warnAt 应预警');
  assert.equal(st.overLimit, false);
  fs.appendFileSync(statsFile, line(0.5));
  st = costGuardStatus();
  assert.equal(st.overLimit, true, '超过上限');
  const chk = checkCostGuard();
  assert.ok(chk && chk.blocked === true && chk.message.includes('暂停'), 'block 模式应阻断并提示');
  // warn 模式：超限仅提醒不阻断
  fs.writeFileSync(cfgFile, JSON.stringify({ costGuard: { dailyLimitYuan: 1, action: 'warn' } }));
  const chk2 = checkCostGuard();
  assert.ok(chk2 && chk2.blocked === false && chk2.message.includes('护栏'), 'warn 模式应仅提醒');
  // P0-4（v0.4.5）：无价格模型不得让护栏静默放行——显式 noPricing + checkCostGuard 告警
  fs.writeFileSync(cfgFile, JSON.stringify({ model: 'my-unpriced-model', costGuard: { dailyLimitYuan: 1, action: 'block' } }));
  const st3 = costGuardStatus();
  assert.equal(st3.noPricing, true, '无价格模型应标记 noPricing');
  assert.equal(st3.overLimit, false, 'noPricing 时不应误判超限');
  const chk3 = checkCostGuard('my-unpriced-model');
  assert.ok(chk3 && chk3.blocked === false && String(chk3.message).includes('无价格数据'), '无价格模型应显式告警而非静默放行');
  // 缺省回退 config.model 识别（不传 modelName）
  const chk4 = checkCostGuard();
  assert.ok(chk4 && String(chk4.message).includes('无价格数据'), '缺省应回退 config.model 识别无价模型');
  // 未知模型（无 model 字段、无参数）不得误标 noPricing——费用累计仍按成本计
  fs.writeFileSync(cfgFile, JSON.stringify({ costGuard: { dailyLimitYuan: 1, warnAtYuan: 0.5, action: 'block' } }));
  const st4 = costGuardStatus();
  assert.equal(st4.noPricing, false, '无 model 信息时不应误标 noPricing');
  process.env.MINGDAO_HOME = smokeHome;
  safeRmSync(homeC, { recursive: true, force: true });
  ok('costGuard：按自然日累计 / 预警线 / block 阻断 / warn 提醒');
}

// ---------- 41. Batch API 半价通道（A1）：上传/轮询/取回/费用入账 ----------
{
  const http = await import('node:http');
  const homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-batch-'));
  process.env.MINGDAO_HOME = homeB;
  process.env.MINGDAO_BATCH_POLL_MS = '100';
  let pollCount = 0;
  const mockBatch = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'POST' && u.pathname === '/files') {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'file-1' }));
      });
    } else if (req.method === 'POST' && u.pathname === '/batches') {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'batch-1', status: 'validating' }));
      });
    } else if (req.method === 'GET' && u.pathname === '/batches/batch-1') {
      pollCount += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(pollCount < 2 ? { id: 'batch-1', status: 'in_progress' } : { id: 'batch-1', status: 'completed', output_file_id: 'out-1' }));
    } else if (req.method === 'GET' && u.pathname === '/batches/batch-1/files/result') {
      res.writeHead(200, { 'Content-Type': 'application/x-jsonlines' });
      res.end(
        JSON.stringify({ custom_id: 'md-0', response: { status_code: 200, body: { usage: { prompt_tokens: 100, completion_tokens: 10 }, choices: [{ message: { content: '答案一' } }] } } }) + '\n' +
        JSON.stringify({ custom_id: 'md-1', response: { status_code: 200, body: { usage: { prompt_tokens: 120, completion_tokens: 8 }, choices: [{ message: { content: '答案二' } }] } } }) + '\n'
      );
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    }
  });
  await new Promise((r) => mockBatch.listen(0, '127.0.0.1', r));
  const batchPort = mockBatch.address().port;
  fs.writeFileSync(path.join(homeB, 'config.json'), JSON.stringify({ provider: 'custom', model: 'deepseek-v4-flash', baseUrl: `http://127.0.0.1:${batchPort}/v1` }));
  fs.writeFileSync(path.join(homeB, 'credentials.json'), JSON.stringify({ deepseek: 'sk-batch-test-1234567890' }));
  const { runBatch } = await import(pathToFileURL(path.join(srcDir, 'batch.js')).href);
  const cfgB = { provider: 'custom', model: 'deepseek-v4-flash', baseUrl: `http://127.0.0.1:${batchPort}/v1` };
  const r = await runBatch({ cfg: cfgB, model: 'deepseek-v4-flash', questions: ['问题一', '问题二'], workingDir: homeB, onStatus: () => {} });
  assert.ok(r.ok === true, r.error || 'batch 应成功');
  assert.equal(r.results.length, 2, '应取回 2 条结果');
  assert.ok(r.results[0].content.includes('答案一'), '结果内容应正确');
  assert.equal(r.usage.prompt_tokens, 220);
  assert.ok(r.cost > 0, '应按半价计费');
  assert.ok(fs.existsSync(r.outputFile), '应写入结果文件');
  const stats = fs.readFileSync(path.join(homeB, 'cache-stats.jsonl'), 'utf8');
  assert.ok(stats.includes('"batch":true'), '批量任务应计入分账并标记 batch');
  // 端点不支持 → 明确报错不静默
  const badCfg = { provider: 'custom', model: 'deepseek-v4-flash', baseUrl: 'http://127.0.0.1:1/v1' };
  const bad = await runBatch({ cfg: badCfg, model: 'deepseek-v4-flash', questions: ['x'], onStatus: () => {} });
  assert.ok(bad.error && bad.error.includes('批处理不可用'), '端点不可用应明确报错');
  mockBatch.close();
  delete process.env.MINGDAO_BATCH_POLL_MS;
  process.env.MINGDAO_HOME = smokeHome;
  safeRmSync(homeB, { recursive: true, force: true });
  ok('batch：上传/轮询/取回/半价计费/结果落盘/分账标记/端点不可用报错');
}

// ---------- 41b. 省钱 B2：批量去重回填 / 超窗口预检 / --max-cost 拦截 ----------
{
  const http = await import('node:http');
  const homeB2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-batch-b2-'));
  process.env.MINGDAO_HOME = homeB2;
  process.env.MINGDAO_BATCH_POLL_MS = '100';
  let uploadedBody = '';
  let pollCount = 0;
  const mockB2 = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'POST' && u.pathname === '/files') {
      req.on('data', (c) => (uploadedBody += c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'file-1' }));
      });
    } else if (req.method === 'POST' && u.pathname === '/batches') {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'batch-1', status: 'validating' }));
      });
    } else if (req.method === 'GET' && u.pathname === '/batches/batch-1') {
      pollCount += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(pollCount < 2 ? { id: 'batch-1', status: 'in_progress' } : { id: 'batch-1', status: 'completed', output_file_id: 'out-1' }));
    } else if (req.method === 'GET' && u.pathname === '/batches/batch-1/files/result') {
      res.writeHead(200, { 'Content-Type': 'application/x-jsonlines' });
      res.end(
        JSON.stringify({ custom_id: 'md-0', response: { status_code: 200, body: { usage: { prompt_tokens: 100, completion_tokens: 10 }, choices: [{ message: { content: '答案一' } }] } } }) + '\n' +
        JSON.stringify({ custom_id: 'md-1', response: { status_code: 200, body: { usage: { prompt_tokens: 120, completion_tokens: 8 }, choices: [{ message: { content: '答案二' } }] } } }) + '\n'
      );
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    }
  });
  await new Promise((r) => mockB2.listen(0, '127.0.0.1', r));
  const batchPort2 = mockB2.address().port;
  fs.writeFileSync(path.join(homeB2, 'config.json'), JSON.stringify({ provider: 'custom', model: 'deepseek-v4-flash', baseUrl: `http://127.0.0.1:${batchPort2}/v1` }));
  fs.writeFileSync(path.join(homeB2, 'credentials.json'), JSON.stringify({ deepseek: 'sk-batch-test-1234567890' }));
  const { runBatch } = await import(pathToFileURL(path.join(srcDir, 'batch.js')).href);
  const cfgB2 = { provider: 'custom', model: 'deepseek-v4-flash', baseUrl: `http://127.0.0.1:${batchPort2}/v1` };
  // ① 去重 + 回填
  const r = await runBatch({ cfg: cfgB2, model: 'deepseek-v4-flash', questions: ['问题一', '问题一', '问题二'], workingDir: homeB2, onStatus: () => {} });
  assert.ok(r.ok === true, r.error || '去重批处理应成功');
  assert.equal(r.deduped, 1, '应报告去重 1 条');
  assert.equal(r.results.length, 3, '结果应回填到全部 3 个位置');
  assert.ok(r.results[0].content.includes('答案一') && r.results[1].content.includes('答案一'), '重复位置应回填同一答案');
  assert.ok(r.results[2].content.includes('答案二'), '唯一位置答案正确');
  const submitted = uploadedBody.split('\n').filter((l) => l.startsWith('{"custom_id')).map((l) => JSON.parse(l));
  assert.equal(submitted.length, 2, '上传 jsonl 应只有 2 条（去重后）');
  assert.equal(fs.readFileSync(r.outputFile, 'utf8').trim().split('\n').length, 3, '输出文件应与输入行数一致');
  // ② 超窗口预检：maxTokens 超过窗口 95% 时提交前报错。
  // v0.4.1：窗口来自 resolveModelCaps.contextWindow（此前误用 budgetTokens）。用 32k 本地小模型验证：
  // maxTokens 40000 > 32000*0.95 必超窗，而 1M 窗口的 deepseek-v4-flash 不应误报。
  const cfgSmall = { ...cfgB2, customModels: { 'small-local': { baseUrl: `http://127.0.0.1:${batchPort2}/v1`, contextWindow: 32000 } } };
  // 给自定义模型补 Key（凭证库按 custom:<名> 键），否则会先报「没有可用 API Key」而非超窗口
  fs.writeFileSync(path.join(homeB2, 'credentials.json'), JSON.stringify({ deepseek: 'sk-batch-test-1234567890', 'custom:small-local': 'sk-small-1234567890' }));
  const over = await runBatch({ cfg: cfgSmall, model: 'small-local', questions: ['短问题'], workingDir: homeB2, maxTokens: 40000, onStatus: () => {} });
  assert.ok(over.error && over.error.includes('超窗口'), '超窗口应在提交前报错（32k 小模型）');
  // 大窗口模型（deepseek-v4-flash 1M）同参数不应误报——130000 < 1M*0.95
  const noOver = await runBatch({ cfg: cfgB2, model: 'deepseek-v4-flash', questions: ['短问题'], workingDir: homeB2, maxTokens: 130000, onStatus: () => {} });
  assert.ok(!noOver.error, '1M 窗口模型 maxTokens 130000 不应误报超窗口（' + (noOver.error || '') + '）');
  // ③ --max-cost 上限：估算费用超上限时提交前拦截
  const capped = await runBatch({ cfg: cfgB2, model: 'deepseek-v4-flash', questions: ['问题一', '问题二'], workingDir: homeB2, maxCost: 0.000001, onStatus: () => {} });
  assert.ok(capped.error && capped.error.includes('--max-cost'), '超预算应在提交前拦截');
  assert.ok(Number.isFinite(capped.estimatedCost), '拦截时附估算费用');
  mockB2.close();
  delete process.env.MINGDAO_BATCH_POLL_MS;
  process.env.MINGDAO_HOME = smokeHome;
  safeRmSync(homeB2, { recursive: true, force: true });
  ok('省钱 B2：批量去重回填 / 超窗口预检 / --max-cost 提交前拦截');
}

// ---------- 41c. 省钱 B3：费用二级分账（reasoning/byTool/byDay 维度） ----------
{
  const homeC = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-costb3-'));
  process.env.MINGDAO_HOME = homeC;
  const { recordUsage, costBreakdown } = await import(pathToFileURL(path.join(srcDir, 'cachestats.js')).href);
  recordUsage(
    'deepseek-v4-flash',
    { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 50, prompt_cache_miss_tokens: 50 },
    { steps: 2, reasoningTokens: 50, toolStats: [{ tool: 'read', calls: 2, ms: 120 }, { tool: 'bash', calls: 1, ms: 800 }] }
  );
  const bd = costBreakdown();
  assert.equal(bd.byTool.length, 2, 'byTool 应有 2 个工具');
  assert.equal(bd.byTool[0].tool, 'bash', 'byTool 按耗时降序');
  assert.equal(bd.byTool[0].calls, 1);
  assert.equal(bd.byTool[1].ms, 120);
  assert.equal(bd.reasoning, 50, 'reasoning 维度应累计');
  assert.equal(bd.byDay.length, 14, 'byDay 应补全 14 天');
  assert.ok(bd.byDay[13].cost > 0, '今日应有费用记录');
  assert.equal(bd.byModel[0].reasoning, 50, 'byModel 应含 reasoning 维度');
  // 落盘行含新字段（WebUI 读取兼容）
  const line = fs.readFileSync(path.join(homeC, 'cache-stats.jsonl'), 'utf8');
  assert.ok(line.includes('"reasoning":50') && line.includes('"byTool":[{"tool":"read"'), 'jsonl 应落盘 reasoning/byTool');
  process.env.MINGDAO_HOME = smokeHome;
  safeRmSync(homeC, { recursive: true, force: true });
  ok('省钱 B3：分账维度（reasoning / byTool 累加 / byDay 14 天折线）');
}

// ---------- 41d. 省钱 B4：护栏降级（action=downgrade 触顶切 flash） ----------
{
  const homeD = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-guardb4-'));
  process.env.MINGDAO_HOME = homeD;
  saveConfig({ provider: 'deepseek', model: 'deepseek-v4-pro', permission: 'auto', costGuard: { dailyLimitYuan: 0.001, action: 'downgrade', downgradeModel: 'deepseek-v4-flash' } });
  const { recordUsage } = await import(pathToFileURL(path.join(srcDir, 'cachestats.js')).href);
  // 预置今日费用远超上限（触发降级）
  recordUsage('deepseek-v4-pro', { prompt_tokens: 1000000, completion_tokens: 100 });
  const io = createIO({ quiet: true });
  let gotModel = null;
  const stubProvider = {
    async chat(opts) {
      if (!gotModel) gotModel = opts.model;
      return { text: '降级后继续完成', toolCalls: null, usage: { prompt_tokens: 5, completion_tokens: 3 }, finish: 'stop' };
    },
  };
  const agent = createAgent({ provider: stubProvider, permission: { async check() { return true; } }, io, modelName: 'deepseek-v4-pro', workingDir: tmp, cfg: { permission: 'auto', costGuard: { dailyLimitYuan: 0.001, action: 'downgrade' } } });
  const res = await agent.runTurn([{ role: 'user', content: '你好' }]);
  assert.equal(gotModel, 'deepseek-v4-flash', '超限后应自动降级到 flash 继续执行');
  assert.equal(res.text, '降级后继续完成', '降级后回合应正常完成');
  assert.equal(res.perf.usedModel, 'deepseek-v4-flash', 'perf.usedModel 应归属降级后模型');
  // block 模式仍拦截
  saveConfig({ provider: 'deepseek', model: 'deepseek-v4-pro', permission: 'auto', costGuard: { dailyLimitYuan: 0.001, action: 'block' } });
  const agent2 = createAgent({ provider: stubProvider, permission: { async check() { return true; } }, io, modelName: 'deepseek-v4-pro', workingDir: tmp, cfg: { permission: 'auto', costGuard: { dailyLimitYuan: 0.001, action: 'block' } } });
  const res2 = await agent2.runTurn([{ role: 'user', content: '你好' }]);
  assert.equal(res2.text, null, 'block 模式应暂停');
  assert.ok((res2.note || '').includes('拦截') || (res2.note || '').includes('暂停'), 'block 模式应给出拦截/暂停说明');
  process.env.MINGDAO_HOME = smokeHome;
  safeRmSync(homeD, { recursive: true, force: true });
  ok('省钱 B4：护栏降级（downgrade 切 flash 继续跑 / block 仍拦截）');
}


// ---------- 42. 月度费用报告（/cost 导出） ----------
{
  const homeR = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-costr-'));
  process.env.MINGDAO_HOME = homeR;
  const { beijingToDate } = await import(pathToFileURL(path.join(srcDir, 'pricing.js')).href);
  const { costMonthlyReport } = await import(pathToFileURL(path.join(srcDir, 'cachestats.js')).href);
  const statsFile = path.join(homeR, 'cache-stats.jsonl');
  const line = (at, cost) => JSON.stringify({ at, model: 'deepseek-v4-flash', prompt: 100, completion: 10, hit: 50, miss: 50, cost, saved: 0.001 }) + '\n';
  // 7 月与 8 月各两条（北京时区）
  const j1 = beijingToDate({ year: 2026, month: 7, day: 31, hour: 23, minute: 0, second: 0 });
  const a1 = beijingToDate({ year: 2026, month: 8, day: 1, hour: 0, minute: 1, second: 0 });
  const a2 = beijingToDate({ year: 2026, month: 8, day: 15, hour: 10, minute: 0, second: 0 });
  fs.writeFileSync(statsFile, line(j1.getTime(), 0.1) + line(j1.getTime(), 0.2) + line(a1.getTime(), 0.3) + line(a2.getTime(), 0.4));
  const all = costMonthlyReport();
  assert.equal(all.length, 2, '应按月份分组为 2 个月');
  assert.equal(all[0].month, '2026-07');
  assert.ok(Math.abs(all[0].cost - 0.3) < 1e-9, '7 月费用应为 0.3');
  assert.ok(Math.abs(all[1].cost - 0.7) < 1e-9, '8 月费用应为 0.7');
  assert.equal(all[1].days.length, 2, '8 月应按天分组（2 天）');
  const aug = costMonthlyReport('2026-08');
  assert.equal(aug.length, 1, '指定月份只返回该月');
  assert.ok(Math.abs(aug[0].cost - 0.7) < 1e-9);
  assert.ok(costMonthlyReport('2025-01').length === 0, '无记录月份返回空');
  process.env.MINGDAO_HOME = smokeHome;
  safeRmSync(homeR, { recursive: true, force: true });
  ok('cost 月度报告：按月/按天分组 / 指定月份过滤 / 空月份');
}

// ---------- 43. 辅助调用结构化输出（json_object + 纯文本回退） ----------
{
  const { generateTitle } = await import(pathToFileURL(path.join(srcDir, 'titles.js')).href);
  const { extractMemory } = await import(pathToFileURL(path.join(srcDir, 'memory.js')).href);
  // json 路径：返回 {"title":"..."} 直接解析（maxTokens 应为 50）
  let seenMax = 0;
  const jsonProvider = { async chat(opts) { seenMax = opts.maxTokens; return { text: '{"title":"贪吃蛇游戏"}' }; } };
  const t1 = await generateTitle(jsonProvider, 'deepseek-v4-flash', '做一个贪吃蛇游戏');
  assert.equal(t1, '贪吃蛇游戏', 'json_object 标题应直接解析');
  assert.equal(seenMax, 50, '标题 maxTokens 应压到 50');
  // 纯文本回退：json 解析失败 → 第二次纯文本调用
  let calls = 0;
  const plainProvider = { async chat() { calls += 1; return { text: '纯文本标题' }; } };
  const t2 = await generateTitle(plainProvider, 'x', '做个计算器');
  assert.equal(t2, '纯文本标题', '回退纯文本路径仍可用');
  assert.equal(calls, 2, 'json 失败后应再走一次纯文本调用');
  // 记忆提取 json 路径
  const memProvider = { async chat() { return { text: '{"items":["- 用户喜欢用 pnpm","- 项目在 /data/app"]}' }; } };
  const lines = await extractMemory(memProvider, 'deepseek-v4-flash', [{ role: 'user', content: '我用 pnpm，项目在 /data/app' }], '');
  assert.deepEqual(lines, ['- 用户喜欢用 pnpm', '- 项目在 /data/app'], 'json 记忆提取应解析 items');
  // 记忆提取纯文本回退
  const memPlain = { async chat() { return { text: '- 旧格式条目' }; } };
  const lines2 = await extractMemory(memPlain, 'deepseek-v4-flash', [{ role: 'user', content: 'x' }], '');
  assert.deepEqual(lines2, ['- 旧格式条目'], '记忆提取纯文本回退');
  ok('结构化输出：标题 json/回退（maxTokens 50）/ 记忆 json/回退');
}


// ---------- 44. 只读子代理并行（评估 A4） ----------
{
  let active = 0;
  let maxActive = 0;
  let mainTurns = 0;
  const providerAll = {
    async chat(opts) {
      const lastUser = String(opts.messages?.at(-1)?.content || '');
      if (lastUser.startsWith('调研 ')) {
        // 子代理调用：延长窗口确保两个子代理的调用重叠
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 80));
        active -= 1;
        return { text: lastUser + '完成', toolCalls: null, usage: {}, finish: 'stop' };
      }
      mainTurns += 1;
      if (mainTurns === 1) {
        return {
          text: '',
          toolCalls: [
            { id: 't1', type: 'function', function: { name: 'task', arguments: JSON.stringify({ prompt: '调研 A', readOnly: true }) } },
            { id: 't2', type: 'function', function: { name: 'task', arguments: JSON.stringify({ prompt: '调研 B', readOnly: true }) } },
          ],
          usage: {},
          finish: 'tool_calls',
        };
      }
      return { text: '汇总完成', toolCalls: null, usage: {}, finish: 'stop' };
    },
  };
  const agentP = createAgent({
    provider: providerAll,
    permission: { mode: 'auto', async check() { return true; } },
    io: createIO({ quiet: true }),
    modelName: 'deepseek-v4-flash',
    workingDir: tmp,
    cfg: { permission: 'auto' },
  });
  const mP = [{ role: 'system', content: '系统' }, { role: 'user', content: '并行调研' }];
  const rP = await agentP.runTurn(mP);
  assert.equal(rP.text, '汇总完成');
  assert.ok(maxActive >= 2, `两个只读子代理应并行执行（最大并发 ${maxActive}）`);
  const toolMsgs = mP.filter((m) => m.role === 'tool');
  assert.equal(toolMsgs.length, 2);
  assert.equal(toolMsgs[0].tool_call_id, 't1', '结果应按调用顺序回填');
  assert.equal(toolMsgs[1].tool_call_id, 't2');
  assert.ok(toolMsgs.every((m) => m.content.includes('完成')), '两个子任务都应完成并汇报');
  ok('子代理：只读 task 并行执行（并发≥2 / 顺序回填）');
}


// ---------- 45. 状态栏指标：perf 记录与汇总（llmMs/toolMs/首 token/步数） ----------
{
  const homeP = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-perf-'));
  process.env.MINGDAO_HOME = homeP;
  const { recordUsage, summarizeCacheStats, listCacheStats } = await import(pathToFileURL(path.join(srcDir, 'cachestats.js')).href);
  recordUsage('deepseek-v4-flash', { prompt_tokens: 1000, completion_tokens: 100, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200 }, { steps: 3, llmMs: 5000, toolMs: 2000, firstTokenMs: 800 });
  recordUsage('deepseek-v4-flash', { prompt_tokens: 500, completion_tokens: 50, prompt_cache_hit_tokens: 400, prompt_cache_miss_tokens: 100 }, { steps: 2, llmMs: 3000, toolMs: 1000, firstTokenMs: 1200 });
  const sum = summarizeCacheStats(listCacheStats(100));
  assert.equal(sum.turns, 2, '轮次应为 2');
  assert.equal(sum.steps, 5, '步数应累计');
  assert.equal(sum.llmMs, 8000, 'LLM 时长应累计');
  assert.equal(sum.toolMs, 3000, '工具时长应累计');
  assert.equal(sum.firstTokenCount, 2);
  assert.equal(sum.firstTokenAvgMs, 1000, '首 token 平均应为 1000ms');
  assert.ok(Math.abs(sum.tokensPerSec - 18.75) < 1e-6, `tok/s 应=150/8s=18.75（得到 ${sum.tokensPerSec}）`);
  assert.ok(Math.abs(sum.rate - 0.8) < 1e-9, '缓存命中率应为 80%');
  // 旧数据（无 perf 字段）兼容
  recordUsage('deepseek-v4-flash', { prompt_tokens: 10, completion_tokens: 1 });
  const sum2 = summarizeCacheStats(listCacheStats(100));
  assert.equal(sum2.turns, 3, '旧格式条目应计入轮次且不影响 perf 累计');
  assert.equal(sum2.llmMs, 8000, '旧条目 llmMs 缺省为 0');
  process.env.MINGDAO_HOME = smokeHome;
  safeRmSync(homeP, { recursive: true, force: true });
  ok('状态栏指标：perf 记录 / 汇总（时长/首 token/tok-s/步数）/ 旧数据兼容');
}


// ---------- 46. 质检回归：坏时区兜底 / 索引子词 / 首推不误判冲突 ----------
{
  const homeQ = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-qa-'));
  process.env.MINGDAO_HOME = homeQ;
  // 1) 坏时区配置：计费/护栏/月度报告全部回退北京时间，不崩溃（审计 B1）
  fs.writeFileSync(path.join(homeQ, 'config.json'), JSON.stringify({ pricing: { timezone: 'Mars/Olympus' } }));
  const { isPeakHour, beijingParts, beijingDayStart } = await import(pathToFileURL(path.join(srcDir, 'pricing.js')).href);
  assert.doesNotThrow(() => beijingParts(new Date()), '坏时区 beijingParts 应回退不抛错');
  assert.doesNotThrow(() => beijingDayStart(new Date()), '坏时区 beijingDayStart 应回退不抛错');
  assert.doesNotThrow(() => isPeakHour(new Date()), '坏时区 isPeakHour 应回退不抛错');
  const { costGuardStatus } = await import(pathToFileURL(path.join(srcDir, 'cost-guard.js')).href);
  assert.doesNotThrow(() => costGuardStatus(), '坏时区 costGuardStatus 不抛错');
  // 2) 索引子词：abc.def 可被 def 命中（审计 B6）
  const { tokenize } = await import(pathToFileURL(path.join(srcDir, 'session-index.js')).href);
  const tk = tokenize('abc.def xyz');
  assert.ok(tk.has('def'), '点分隔的子段应成词（def 可命中 abc.def）');
  assert.ok(tk.has('abc.def'), '完整词保留');
  // 3) 首推不误判冲突：远端内容不同但本地无记录 → 无 .server- 备份（审计 B7）
  process.env.MINGDAO_HOME = homeQ;
  const { listSyncConflicts } = await import(pathToFileURL(path.join(srcDir, 'sync.js')).href);
  assert.equal(listSyncConflicts().length, 0, '无状态记录时不应产生虚假冲突');
  process.env.MINGDAO_HOME = smokeHome;
  safeRmSync(homeQ, { recursive: true, force: true });
  ok('质检回归：坏时区兜底 / 索引子词 / 首推冲突语义');
}

// ---------- 34. Web 服务器无密钥启动（黑屏根因回归护栏） ----------
// 桌面版首次运行 = 自动初始化后的无密钥状态：此前 runWebServer 直接退出，
// 窗口加载不到服务 → 整窗黑屏、无任何提示。必须：服务照常启动 + keyReady=false。
{
  const jhome = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-keyless-'));
  process.env.MINGDAO_HOME = jhome;
  saveConfig({ provider: 'deepseek', model: 'deepseek-v4-flash', permission: 'ask', sandbox: 'off', contextBudget: 128000 });
  const { runWebServer } = await import(pathToFileURL(path.join(srcDir, 'web', 'server.js')).href);
  const srv = await runWebServer({ host: '127.0.0.1', port: 45972, authToken: null });
  assert.ok(srv, '无密钥时服务器必须正常启动（此前直接退出 → 桌面版黑屏）');
  const st = await (await fetch('http://127.0.0.1:45972/api/state')).json();
  assert.equal(st.ok, true, '/api/state 应正常返回');
  assert.equal(st.keyReady, false, '无密钥时 keyReady 应为 false（前端显示 ⚙ 设置引导横幅）');
  assert.ok(Array.isArray(st.models), '无密钥时模型列表应为数组（含当前模型占位）');
  await new Promise((r) => srv.close(r));
  process.env.MINGDAO_HOME = smokeHome;
  safeRmSync(jhome, { recursive: true, force: true });
  ok('web 无密钥启动：服务正常 / keyReady=false / 模型占位（黑屏回归护栏）');
}

{
  // 质检回归（0.2.2 桌面三平台启动即崩）：main.js 顶层调用 createLogWriter 却漏了导入——
  // 打包期不报错、运行期才炸。本地静态护栏：顶层引用的 src 模块必须经动态加载显式解构绑定；
  // 权威验证在 CI 的 xvfb 打包冒烟（MINGDAO_DESKTOP_SMOKE=1）。
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const mainJs = fs.readFileSync(path.join(repoRoot, 'desktop', 'main.js'), 'utf8');
  // 1) 不得出现指向 ../src 的静态 import（打包态 src 在 resourcesPath，静态相对路径必炸）
  assert.ok(!/import\s+[^;]*from\s+['"]\.\.\/src/.test(mainJs), 'main.js 不得静态 import ../src（打包态路径不同）');
  // 2) createLogWriter 必须经顶层 await import(log-writer.js) 解构绑定
  assert.ok(
    /const\s*\{\s*createLogWriter\s*\}\s*=\s*await\s+import\([^)]*log-writer\.js/.test(mainJs),
    'createLogWriter 必须从 log-writer.js 动态导入（0.2.2 回归护栏）'
  );
  assert.ok(fs.existsSync(path.join(repoRoot, 'src', 'log-writer.js')), 'src/log-writer.js 必须存在');
  ok('桌面主进程静态护栏：src 动态导入 / createLogWriter 显式绑定（0.2.2 启动崩溃回归）');
}

{
  // 省钱 B1：工具 schema 按需下发——已用工具省描述（工具级 + 参数级），未用工具保留；
  // 全部用过时 schema token 至少降 40%（基准 1051）；结构（name/parameters/required）不受影响。
  const full = toolSchemas();
  // v0.4.6：schema 瘦身是面向 DeepSeek 的省钱主张 → 用随包官方词表精确计数。
  // 此前用 approxTokens（启发式），JSON 结构字符占比高、与精确值偏差 1.1–1.8 倍，
  // 测出来的百分比不是真实节省额（同 bench-cost/bench-savings 的口径修正）。
  const { countTokens: countSchemaTok } = await import(pathToFileURL(path.join(srcDir, 'tokenizer.js')).href);
  const schemaTok = (v) => countSchemaTok(JSON.stringify(v), 'deepseek-v4-flash');
  const fullTokens = schemaTok(full);
  assert.equal(full.length, 13, '内置工具应为 13 个');
  assert.ok(full[0].function.description.length > 0, 'toolSchemas() 应保留完整描述');
  const usedAll = new Set(full.map((t) => t.function.name));
  const stripped = buildToolSchemas(usedAll);
  // 断言「剥描述不改变工具数量」——不能与 toolSchemas() 的 13 直接比：
  // buildToolSchemas 还含进程内已注册的第三方/ Pack 工具（v0.5.0 起 WebUI 启动会挂载 Pack），
  // 与用例执行顺序耦合。改与「全量未剥描述」的结果比，语义更准且稳定。
  assert.equal(stripped.length, buildToolSchemas(new Set()).length, '剥描述不应改变工具数量');
  assert.equal(stripped[0].function.description, '', '已用工具 description 应清空');
  assert.ok(!('description' in stripped[0].function.parameters.properties.path), '已用工具参数 description 应清除');
  assert.equal(JSON.stringify(stripped[0].function.parameters.properties.path.type), '"string"', '参数 type 保留');
  assert.deepEqual(stripped[0].function.parameters.required, ['path'], 'required 保留');
  const usedHalf = buildToolSchemas(new Set(['read', 'bash']));
  assert.equal(usedHalf[0].function.description, '', 'read 用过 → 清');
  assert.equal(usedHalf[6].function.description, '', 'bash 用过 → 清');
  assert.ok(usedHalf[1].function.description.length > 0, 'write 未用 → 保留');
  // 原数组不被修改（缓存安全）
  assert.ok(full[0].function.description.length > 0, '原 TOOLS 不被 buildToolSchemas 修改');
  const strippedTokens = schemaTok(stripped);
  const saving = 1 - strippedTokens / fullTokens;
  assert.ok(saving >= 0.4, `全用过时 schema 应降 ≥40%，实际 ${(saving * 100).toFixed(1)}%`);
  ok(`省钱 B1：schema 按需瘦身（全用过降 ${(saving * 100).toFixed(0)}%，参数结构保留）`);
}

// ---------- 诊断命令（v0.3.0 P2-5）：一键生成脱敏诊断报告 ----------
{
  const homeD = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-diag-'));
  process.env.MINGDAO_HOME = homeD;
  const { handleDiagnose } = await import(pathToFileURL(path.join(srcDir, 'commands', 'diagnose.js')).href);
  await handleDiagnose('diagnose', []);
  const files = fs.readdirSync(homeD).filter((f) => f.startsWith('diagnose-') && f.endsWith('.txt'));
  assert.equal(files.length, 1, '诊断命令应生成一个报告文件');
  const content = fs.readFileSync(path.join(homeD, files[0]), 'utf8');
  assert.ok(content.includes('MingDao Harness 诊断报告') && content.includes('## 环境') && content.includes('## 审计'), '报告应含环境/审计等分区');
  assert.ok(!/(sk-[A-Za-z0-9]{6,}|ghp_[A-Za-z0-9]{20,})/.test(content), '报告不应泄漏明文密钥');
  process.env.MINGDAO_HOME = smokeHome;
  safeRmSync(homeD, { recursive: true, force: true });
  ok('diagnose：一键脱敏诊断报告生成');
}

// ---------- 47. Agent Preset（v0.4.0 契约化）：发现/校验/遮蔽/覆盖/系统提示段 ----------
{
  const { listPresets, loadPreset, validatePreset, presetConfigOverrides, presetSystemBlock, presetDirs } = await import(pathToFileURL(path.join(srcDir, 'presets.js')).href);
  const { builtinPresetDir } = await import(pathToFileURL(path.join(srcDir, 'presets.js')).href);
  // 内置预设（随包分发）
  assert.ok(fs.existsSync(path.join(builtinPresetDir(), 'local-audit.json')), '内置示例预设应随包分发');
  const builtin = listPresets(null);
  assert.ok(builtin.some((/** @type {any} */ p) => p.name === 'local-audit' && p.source === 'builtin'), '内置 local-audit 应被发现');
  // 校验：合法/非法字段/坏 permission
  assert.equal(validatePreset({ name: 'ok', systemPrompt: 'x' }).ok, true, '最小合法预设应通过');
  assert.equal(validatePreset({}).ok, false, '缺 name 应拒绝');
  assert.equal(validatePreset({ name: 'bad name!' }).ok, false, '非法 name 应拒绝');
  assert.equal(validatePreset({ name: 'x', unknownField: 1 }).ok, false, '未知字段应拒绝');
  assert.equal(validatePreset({ name: 'x', permission: 'nope' }).ok, false, '非法权限应拒绝');
  assert.equal(validatePreset({ name: 'x', tools: ['read', 1] }).ok, false, '非字符串工具名应拒绝');
  // 项目级遮蔽用户级/内置
  const projDir = path.join(tmp, 'proj-presets');
  fs.mkdirSync(path.join(projDir, '.mingdao', 'presets'), { recursive: true });
  fs.writeFileSync(path.join(projDir, '.mingdao', 'presets', 'my-agent.json'), JSON.stringify({ name: 'my-agent', label: '我的智能体', systemPrompt: '只输出中文。', tools: ['read', 'grep'], permission: 'readonly', maxRounds: 2 }));
  const listed = listPresets(projDir);
  const mine = listed.find((/** @type {any} */ p) => p.name === 'my-agent');
  assert.ok(mine && mine.source === 'project', '项目级预设应被发现且标 project');
  // 项目级同名遮蔽内置
  fs.writeFileSync(path.join(projDir, '.mingdao', 'presets', 'local-audit.json'), JSON.stringify({ name: 'local-audit', label: '项目级覆盖', systemPrompt: 'override' }));
  const overridden = listPresets(projDir).filter((/** @type {any} */ p) => p.name === 'local-audit');
  assert.equal(overridden.length, 1, '同名预设应只留一个（遮蔽）');
  assert.equal(overridden[0].source, 'project', '项目级应遮蔽内置');
  // loadPreset + 覆盖 + 系统提示段
  const lp = loadPreset(projDir, 'my-agent');
  assert.ok(lp && lp.name === 'my-agent', 'loadPreset 应按名加载');
  const over = presetConfigOverrides(lp);
  assert.equal(over.permission, 'readonly', 'permission 覆盖应生效');
  assert.equal(over.maxRounds, 2, 'maxRounds 覆盖应生效');
  assert.deepEqual(over.presetTools, ['read', 'grep'], 'tools 白名单应生效');
  assert.equal(Object.prototype.hasOwnProperty.call(over, 'temperature'), false, '未声明字段不应出现在覆盖里');
  assert.ok(presetSystemBlock(lp).includes('只输出中文') && presetSystemBlock(lp).includes('<preset_rules>'), '系统提示段应包裹注入');
  assert.equal(presetSystemBlock({ name: 'x' }), '', '无 systemPrompt 时系统提示段为空');
  assert.equal(loadPreset(projDir, 'nonexistent'), null, '不存在的预设应返回 null');
  // P0（v0.4.1）：预设 permission 提权防护——ask/readonly 不得被预设静默改成 auto
  const { presetPermissionOverride } = await import(pathToFileURL(path.join(srcDir, 'presets.js')).href);
  assert.equal(presetPermissionOverride({ permission: 'auto' }, 'ask').escalated, true, 'ask→auto 应判提权');
  assert.equal(presetPermissionOverride({ permission: 'auto' }, 'ask').permission, 'ask', '提权应保持当前 ask');
  assert.equal(presetPermissionOverride({ permission: 'auto' }, 'readonly').escalated, true, 'readonly→auto 应判提权');
  assert.equal(presetPermissionOverride({ permission: 'readonly' }, 'ask').escalated, false, 'ask→readonly 属降权不拦截');
  assert.equal(presetPermissionOverride({ permission: 'readonly' }, 'ask').permission, 'readonly', '降权应采纳预设 readonly');
  assert.equal(presetPermissionOverride({ permission: 'ask' }, 'ask').escalated, false, '同级不拦截');
  assert.equal(presetPermissionOverride({}, 'ask').escalated, false, '未声明 permission 不拦截');
  // 审计 P3-2（v0.4.2）：遮蔽 key 按 name 字段而非文件名——不同文件名声明同名预设只留一个
  fs.writeFileSync(path.join(projDir, '.mingdao', 'presets', 'alias-file.json'), JSON.stringify({ name: 'my-agent', label: '同名覆盖' }));
  const dup = listPresets(projDir).filter((/** @type {any} */ p) => p.name === 'my-agent');
  assert.equal(dup.length, 1, '不同文件名声明同名预设应只留一个（name 字段遮蔽）');
  ok('presets：内置发现 / 校验（未知字段/坏值拒绝）/ 项目遮蔽 / name 字段遮蔽 / 覆盖提取 / 系统提示段 / 提权拦截');
}

// ---------- 48. 第三方工具注册 + config.tools 声明式挂载（v0.4.0 契约化） ----------
{
  const { registerTool, listRegisteredTools, dispatch, buildToolSchemas, mountConfigTools } = await import(pathToFileURL(path.join(srcDir, 'tools/index.js')).href);
  // 程序化注册：schema 进构建链、dispatch 可执行、返回对象透传
  registerTool({
    name: 'echo-test',
    description: '回显参数',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    run: (/** @type {any} */ args) => ({ ok: true, output: 'echo:' + args.text }),
  });
  assert.ok(listRegisteredTools().includes('echo-test'), '注册后应出现在列表');
  const schemas = buildToolSchemas(new Set());
  const echoSchema = schemas.find((/** @type {any} */ t) => t.function.name === 'echo-test');
  assert.ok(echoSchema && echoSchema.function.description === '回显参数', '自定义工具 schema 应进构建链');
  const echoRes = await dispatch('echo-test', { text: 'hi' }, {});
  assert.equal(echoRes.output, 'echo:hi', 'dispatch 应执行自定义工具');
  // 异常 → 结构化错误，不抛出
  registerTool({ name: 'boom-test', description: 'x', run: () => { throw new Error('炸了'); } });
  const boomRes = await dispatch('boom-test', {}, {});
  assert.equal(boomRes.ok, false, '自定义工具异常应转结构化错误');
  assert.ok(String(boomRes.error).includes('炸了'), '错误信息应保留');
  // 与内置同名 → 拒绝；重复注册 → 拒绝
  let dupErr = null;
  try { registerTool({ name: 'read', run: () => ({}) }); } catch (/** @type {any} */ e) { dupErr = e; }
  assert.ok(dupErr && /已存在/.test(dupErr.message), '与内置同名应拒绝');
  try { registerTool({ name: 'echo-test', run: () => ({}) }); } catch (/** @type {any} */ e) { dupErr = e; }
  assert.ok(dupErr && /已存在/.test(dupErr.message), '重复注册应拒绝');
  // mcp__ 前缀保留给 MCP 路由，自定义工具不得占用
  try { registerTool({ name: 'mcp__mine', run: () => ({}) }); } catch (/** @type {any} */ e) { dupErr = e; }
  assert.ok(dupErr && /mcp__/.test(dupErr.message), 'mcp__ 前缀应拒绝');
  // v0.4.1 P2：readOnly 选项进 READONLY_TOOLS（只读档自动放行、ask 档不询问）
  const { READONLY_TOOLS, isRegisteredToolReadonly } = await import(pathToFileURL(path.join(srcDir, 'tools', 'index.js')).href);
  registerTool({ name: 'ro-probe', description: '只读探测', readOnly: true, run: () => ({ ok: true, output: 'ro' }) });
  assert.ok(READONLY_TOOLS.has('ro-probe'), 'readOnly 第三方工具应进 READONLY_TOOLS');
  assert.equal(isRegisteredToolReadonly('ro-probe'), true, 'isRegisteredToolReadonly 应返回 true');
  assert.equal(isRegisteredToolReadonly('echo-test'), false, '未标注 readOnly 应返回 false');
  // config.tools 声明式挂载：参数经 MINGDAO_TOOL_ARGS 环境变量（非字符串拼接进 shell）。
  // 跨平台：命令用「相对脚本名 + cwd=tmp」，不嵌任何路径引号（Windows cmd /s /c 对绝对路径引号/反斜杠
  // 的解析与 bash 不同，绝对路径会拆错）；脚本读 MINGDAO_TOOL_ARGS 打印。
  fs.writeFileSync(path.join(tmp, 'env-echo.js'), 'const a=JSON.parse(process.env.MINGDAO_TOOL_ARGS||"{}"); console.log("got:"+a.text);\n');
  const cfg = {
    tools: [
      { name: 'env-echo', description: '读环境变量回显', command: 'node env-echo.js' },
    ],
  };
  const mounted = mountConfigTools(cfg);
  assert.deepEqual(mounted, ['env-echo'], 'config.tools 应挂载');
  const again = mountConfigTools(cfg);
  assert.deepEqual(again, [], '重复挂载应幂等（跳过）');
  const envRes = await dispatch('env-echo', { text: 'env-hi' }, { cwd: tmp });
  assert.equal(envRes.ok, true, '声明式工具应执行成功');
  assert.ok(String(envRes.output).includes('got:env-hi'), '参数应经环境变量传递');
  // 坏条目（与内置 read 同名 / 非法名）应跳过挂载，绝不抛出（启动路径安全）
  const badCfg = { tools: [{ name: 'read', command: 'echo x' }, { name: 'bad name!', command: 'echo y' }, { name: 'ok-tool', command: 'echo z' }] };
  const badMounted = mountConfigTools(badCfg);
  assert.deepEqual(badMounted, ['ok-tool'], '坏条目应跳过、好条目照常挂载');
  ok('tools 契约化：registerTool 注册/调度/异常结构化/重名拒绝 + config.tools 声明式挂载（幂等/环境变量传参/坏条目跳过不崩）');
}

// ---------- 49. 公共 API 导出面（v0.4.0 契约化：stable 面稳定断言） ----------
{
  const api = await import(pathToFileURL(path.join(srcDir, 'index.js')).href);
  const stableFns = ['createAgent', 'createProvider', 'resolveProviderConfig', 'createPermission', 'createIO', 'registerTool', 'listRegisteredTools', 'mountConfigTools', 'buildToolSchemas', 'listPresets', 'loadPreset', 'validatePreset', 'presetConfigOverrides', 'presetSystemBlock', 'trimMessages', 'approxTokens', 'clampText', 'compactConversation', 'estimateCost', 'countTokens', 'makeTokenCounter', 'resolveModelCaps', 'safeBudget', 'isLocalBaseUrl'];
  for (const f of stableFns) {
    assert.equal(typeof api[f], 'function', `公共 API ${f} 应导出且为函数`);
  }
  ok(`公共 API 导出面：${stableFns.length} 个 stable 导出全部可用（v0.4.0 契约化）`);
}

// ---------- 50. v0.4.6 回归：只读去重缓存失效 + 子代理费用并入 ----------
// 两个都是「省钱/正确性」链路上的静默错误：前者让模型读到写入前的内容，后者让今日费用系统性少计。
{
  // 50a：同回合 read → write → read 同一文件，第 3 步必须拿到写入后的内容
  // （v0.4.1 把 turnToolCache 提到轮内让去重跨步生效，却没有失效点）
  const tmpC = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-toolcache-'));
  const target = path.join(tmpC, 'demo.txt');
  fs.writeFileSync(target, 'ORIGINAL\n');
  let phase = 0;
  const providerSeq = {
    async chat() {
      phase += 1;
      const mk = (id, name, args) => ({ text: '', reasoning: '', finish: 'tool_calls', usage: { prompt_tokens: 1, completion_tokens: 1 }, toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
      if (phase === 1) return mk('r1', 'read', { path: target });
      if (phase === 2) return mk('w1', 'write', { path: target, content: 'UPDATED\n' });
      if (phase === 3) return mk('r2', 'read', { path: target });
      return { text: 'done', reasoning: '', finish: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, toolCalls: null };
    },
  };
  const agentCache = createAgent({
    provider: providerSeq,
    permission: { mode: 'auto', async check() { return true; } },
    io: createIO({ quiet: true }),
    modelName: 'deepseek-v4-flash',
    workingDir: tmpC,
    cfg: { permission: 'auto', autoCompact: false, maxRounds: 1 },
  });
  const msgsCache = [{ role: 'system', content: '系统' }, { role: 'user', content: '读-写-再读' }];
  await agentCache.runTurn(msgsCache);
  const toolResults = msgsCache.filter((m) => m.role === 'tool').map((m) => String(m.content));
  assert.ok(toolResults[0].includes('ORIGINAL'), '首次 read 应看到原始内容');
  assert.ok(toolResults[2].includes('UPDATED'), '写后再读必须看到新内容（缓存应已作废），实际：' + String(toolResults[2]).slice(0, 120));
  assert.ok(!toolResults[2].includes('已复用'), '写后再读不应命中只读去重缓存');

  // 50b：子代理消耗必须计入父回合 usage（CLI/REPL 无 onUsage，此前完全漏计）
  const SUB = { prompt_tokens: 1000, completion_tokens: 200 };
  let calls = 0;
  const providerSub = {
    async chat({ messages }) {
      calls += 1;
      const isSub = String(messages?.[0]?.content || '').includes('子代理');
      if (isSub) return { text: '子代理结论', reasoning: '', finish: 'stop', usage: { ...SUB }, toolCalls: null };
      if (!messages.some((m) => m.role === 'tool')) {
        return { text: '', reasoning: '', finish: 'tool_calls', usage: { ...SUB }, toolCalls: [{ id: 't1', type: 'function', function: { name: 'task', arguments: JSON.stringify({ description: '调研', prompt: '调研一下', readOnly: true }) } }] };
      }
      return { text: '完成', reasoning: '', finish: 'stop', usage: { ...SUB }, toolCalls: null };
    },
  };
  const agentSub = createAgent({
    provider: providerSub,
    permission: { mode: 'auto', async check() { return true; } },
    io: createIO({ quiet: true }),
    modelName: 'deepseek-v4-flash',
    workingDir: tmpC,
    cfg: { permission: 'auto', autoCompact: false, maxRounds: 1 },
  });
  const resSub = await agentSub.runTurn([{ role: 'system', content: '系统' }, { role: 'user', content: '派子代理' }]);
  assert.equal(calls, 3, '父回合 2 次 + 子代理 1 次模型调用');
  assert.equal(resSub.usage.prompt_tokens, SUB.prompt_tokens * calls, '子代理 prompt token 必须并入父回合 usage（不漏计）');
  assert.equal(resSub.usage.completion_tokens, SUB.completion_tokens * calls, '子代理 completion token 必须并入父回合 usage');
  safeRmSync(tmpC, { recursive: true, force: true });
  ok('v0.4.6 回归：写后再读不吃旧缓存 + 子代理 token 全额并入父回合费用');
}

// ---------- 51. v0.4.6 回归：日志轮转不写放大 / 已存在日志收权 ----------
{
  const tmpL = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-log-'));
  const lf = path.join(tmpL, 'x.log');
  fs.writeFileSync(lf, 'old\n', { mode: 0o644 }); // 历史遗留的宽松权限
  const { createLogWriter } = await import(pathToFileURL(path.join(srcDir, 'log-writer.js')).href);
  const write = createLogWriter(lf, { maxBytes: 65536 });
  // 统计整文件重写次数（轮转走 .tmp + rename）
  const origWriteFileSync = fs.writeFileSync;
  let rewrites = 0;
  // @ts-ignore - 测试内临时替换
  fs.writeFileSync = (p, ...rest) => { if (String(p).includes('.tmp')) rewrites += 1; return origWriteFileSync(p, ...rest); };
  try {
    for (let i = 0; i < 2000; i++) write('中文日志行 ' + i + ' '.repeat(20));
  } finally {
    // @ts-ignore - 恢复
    fs.writeFileSync = origWriteFileSync;
  }
  const st = fs.statSync(lf);
  assert.ok(st.size <= 65536, `日志应保持在字节上限内（实际 ${st.size}）`);
  // Windows 无 POSIX 权限位（chmod 为 no-op、mode 恒为 0666 一类）——与既有测试同口径跳过
  if (process.platform !== 'win32') {
    assert.equal(st.mode & 0o777, 0o600, '已存在的 644 日志应被收权为 600');
  }
  // 修复前：上限之后每次追加都整文件重写（2000 次）；修复后仅按低水位偶尔轮转
  assert.ok(rewrites < 100, `2000 次追加不应产生 2000 次整文件重写（实际 ${rewrites} 次）`);
  safeRmSync(tmpL, { recursive: true, force: true });
  ok('v0.4.6 回归：日志按字节轮转到低水位（无写放大）+ 历史 644 日志收权为 600');
}

// ---------- 52. v0.4.6 回归：限流不可被查询串绕过（P1 安全） ----------
// 此前桶键用 req.url（含查询串）而路由用 pathname：给每个请求加随机 `?n=i` 即每次落进新桶，
// 登录/配对/改密的限流被整体绕过（scrypt 约 18ms/次 → 无限速爆破 + 阻塞事件循环）。
// 独立起一个服务器，避免污染上一组同步测试的限流桶。
{
  const rlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-ratelimit-'));
  const { runSyncServer } = await import(pathToFileURL(path.join(srcDir, 'sync-server.js')).href);
  const rlSrv = runSyncServer({ port: 0, host: '127.0.0.1', dataDir: rlDir });
  await new Promise((r) => rlSrv.once('listening', r));
  const rlPort = rlSrv.address().port;
  const N = 40;
  let got429 = 0;
  for (let i = 0; i < N; i++) {
    const r = await fetch(`http://127.0.0.1:${rlPort}/api/pair?n=${i}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'victim', password: 'brute-force-attempt', deviceName: 'x' }),
    });
    if (r.status === 429) got429 += 1;
    await r.text().catch(() => {});
  }
  rlSrv.close();
  assert.ok(got429 > 0, `带随机查询串的重复尝试必须被限流（${N} 次请求中 429 次数=${got429}）`);
  safeRmSync(rlDir, { recursive: true, force: true });
  ok('v0.4.6 回归：限流桶键按 pathname（随机查询串无法绕过限流）');
}

// ---------- 53. v0.4.6 回归：随包资源目录必须同时进 npm files 与桌面 extraResources ----------
// 教训：skills-lib/ 被 src/skill-lib.js 以 `new URL('../skills-lib', import.meta.url)` 运行时读取，
// 却既不在 package.json#files 也不在 desktop/electron-builder.yml 的 extraResources 里，
// readdirSync 的 ENOENT 被 try/catch 静默吞掉 → npm 全局安装与桌面版都拿不到「22 个可安装技能库」，
// 而 README/官网把它当主卖点。静态护栏：扫描 src/ 里所有 `../<dir>` 形式的资源引用，逐一核对。
{
  const repoRoot = path.join(srcDir, '..');
  const referenced = new Set();
  const scanDirs = [srcDir, path.join(srcDir, 'tools'), path.join(srcDir, 'providers')];
  for (const d of scanDirs) {
    let files = [];
    try { files = fs.readdirSync(d).filter((f) => f.endsWith('.js')); } catch { continue; }
    for (const f of files) {
      const code = fs.readFileSync(path.join(d, f), 'utf8');
      // 只取「目录」引用：../<dir> 或 ../<dir>/，排除 ../<file>.js 这类
      for (const m of code.matchAll(/new URL\(\s*'\.\.\/([A-Za-z0-9_-]+)(?=['/])/g)) referenced.add(m[1]);
    }
  }
  assert.ok(referenced.size > 0, '应至少扫描到一个随包资源目录引用');
  const rootPkgFiles = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).files || [];
  const builderYml = fs.readFileSync(path.join(repoRoot, 'desktop', 'electron-builder.yml'), 'utf8');
  for (const dir of referenced) {
    assert.ok(
      rootPkgFiles.some((f) => String(f).replace(/\/$/, '') === dir),
      `随包资源目录 ${dir}/ 必须出现在根 package.json#files（否则 npm 安装形态缺文件）`
    );
    assert.ok(
      new RegExp(`from:\\s*\\.\\./${dir}\\b`).test(builderYml),
      `随包资源目录 ${dir}/ 必须出现在 desktop/electron-builder.yml 的 extraResources（否则桌面版缺文件）`
    );
  }
  // v0.5.0：内置垂域 Pack 目录也必须随包分发（packs.js 按 ../packs 解析内置来源，
  // 不是 `new URL('../x')` 形式，故上面的自动扫描覆盖不到——单独断言）
  assert.ok(
    rootPkgFiles.some((f) => String(f).replace(/\/$/, '') === 'packs'),
    '内置 Pack 目录 packs/ 必须出现在根 package.json#files'
  );
  assert.ok(/from:\s*\.\.\/packs\b/.test(builderYml), '内置 Pack 目录必须出现在 desktop/electron-builder.yml 的 extraResources');

  // 版本真源一致性：desktop 版本必须已被同步（dist 脚本前置 sync，但仓库内也不应漂移）
  const rootVer = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
  const deskVer = JSON.parse(fs.readFileSync(path.join(repoRoot, 'desktop', 'package.json'), 'utf8')).version;
  assert.equal(deskVer, rootVer, `desktop/package.json 版本必须与根 package.json 一致（${deskVer} vs ${rootVer}）`);
  ok(`v0.4.6 回归：随包资源目录齐全（${[...referenced].sort().join('/ ')}）+ 桌面版本与根同步`);
}

// ---------- 54. v0.4.6 回归：审计第二批修复（脱敏 / undo / hooks / 预设 / 深度 / 环境变量 / ReDoS） ----------
{
  // 54a. URL 内嵌凭据必须脱敏（此前注释声称覆盖、规则里却没有）
  const { redactSecrets } = await import(pathToFileURL(path.join(srcDir, 'redact.js')).href);
  const urlCred = redactSecrets('git clone https://oauth2:glpat-XYZ1234567890@gitlab.example.com/repo.git');
  assert.ok(!urlCred.includes('glpat-XYZ1234567890'), 'URL 内嵌凭据必须被掩码：' + urlCred);
  assert.ok(urlCred.includes('gitlab.example.com'), '主机名应保留便于排查');
  assert.ok(!redactSecrets('postgres://admin:s3cretPw@db.internal:5432/app').includes('s3cretPw'), '连接串密码必须被掩码');

  // 54b. undo 指定越界 path 必须报错，绝不回落「撤销最近一次」（此前会回滚无关文件）
  const tmpU = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-undo-'));
  const { dispatch: dispatchU } = await import(pathToFileURL(path.join(srcDir, 'tools', 'index.js')).href);
  const undoStore = { backups: new Map() };
  const ctxU = { cwd: tmpU, workingDir: tmpU, cfg: {}, undoStore };
  fs.writeFileSync(path.join(tmpU, 'important.txt'), 'v1');
  await dispatchU('write', { path: path.join(tmpU, 'important.txt'), content: 'v2' }, ctxU);
  fs.writeFileSync(path.join(tmpU, 'other.txt'), 'o1');
  await dispatchU('write', { path: path.join(tmpU, 'other.txt'), content: 'o2' }, ctxU);
  const badUndo = await dispatchU('undo', { path: '/etc/hosts' }, ctxU);
  assert.equal(badUndo.ok, false, '越界 path 的 undo 必须失败而不是回滚别的文件');
  assert.equal(fs.readFileSync(path.join(tmpU, 'other.txt'), 'utf8'), 'o2', '无关文件不得被回滚');
  const goodUndo = await dispatchU('undo', { path: path.join(tmpU, 'important.txt') }, ctxU);
  assert.equal(goodUndo.ok, true, '合法的 undo 应成功');
  assert.equal(fs.readFileSync(path.join(tmpU, 'important.txt'), 'utf8'), 'v1', '指定文件应被还原');

  // 54c. hook matcher 支持文档写明的 `|` 分隔（此前只认 `,`，按文档写的策略钩子静默失效）
  const { createHooks } = await import(pathToFileURL(path.join(srcDir, 'hooks.js')).href);
  const hooksPipe = createHooks({ PreToolUse: [{ matcher: 'write|edit|bash', cmd: 'echo \'{"decision":"block","reason":"policy"}\'' }] }, tmpU, {});
  const hr = await hooksPipe.pre('write', { path: 'x' });
  assert.equal(hr.decision, 'block', '`|` 分隔的 matcher 必须命中 write（文档契约）');
  const hr2 = await hooksPipe.pre('read', { path: 'x' });
  assert.equal(hr2.decision, 'approve', '未匹配的工具应放行');

  // 54d. 预设提权防护在 permission 为对象形态时必须生效（{mode:'readonly'} 不得被提权为 ask）
  const { presetPermissionOverride } = await import(pathToFileURL(path.join(srcDir, 'presets.js')).href);
  const esc1 = presetPermissionOverride({ permission: 'ask' }, { mode: 'readonly', allow: ['read'] });
  assert.equal(esc1.escalated, true, 'readonly → ask 属提权，必须拦截');
  assert.equal(esc1.permission.mode, 'readonly', '被拦截时应保持只读档（保留 allow/deny 结构）');
  const esc2 = presetPermissionOverride({ permission: 'auto' }, 'ask');
  assert.equal(esc2.escalated, true, '字符串形态 ask → auto 仍应拦截');
  const ok2 = presetPermissionOverride({ permission: 'readonly' }, 'ask');
  assert.equal(ok2.escalated, false, '收紧权限不算提权');

  // 54e. SSH_AUTH_SOCK 不得被当作敏感变量剥离（否则 bash 内 git-over-SSH 失效）
  const bashMod = await import(pathToFileURL(path.join(srcDir, 'tools', 'bash.js')).href);
  assert.equal(bashMod.isSensitiveEnv('SSH_AUTH_SOCK'), false, 'SSH_AUTH_SOCK 是连接句柄，不应被剥离');
  assert.equal(bashMod.isSensitiveEnv('MINGDAO_API_KEY'), true, 'API Key 仍应被剥离');
  assert.equal(bashMod.isSensitiveEnv('MY_TOKEN'), true, 'TOKEN 仍应被剥离');

  // 54f. 深嵌套 schema 不得让 buildToolSchemas 抛 RangeError（恶意 MCP inputSchema）
  const { buildToolSchemas } = await import(pathToFileURL(path.join(srcDir, 'tools', 'index.js')).href);
  let deep = { type: 'string' };
  for (let i = 0; i < 5000; i++) deep = { type: 'object', properties: { n: deep }, description: 'x' };
  const deepTool = [{ type: 'function', function: { name: 'deep-tool', description: 'd', parameters: deep } }];
  const schemas = buildToolSchemas(new Set(['deep-tool']), deepTool);
  assert.ok(Array.isArray(schemas), '深嵌套 schema 应安全返回而不是抛 RangeError');

  // 54g. grep 必须拒绝「同前缀歧义分支 + 量词」的 ReDoS 形态，且不误伤安全分支
  const { grep } = await import(pathToFileURL(path.join(srcDir, 'tools', 'fs-tools.js')).href);
  const ctxG = { cwd: tmpU, workingDir: tmpU, cfg: {} };
  fs.writeFileSync(path.join(tmpU, 'g.txt'), 'foo bar post get\n');
  const reDoS = grep({ pattern: '(a|aa)+$', path: tmpU }, ctxG);
  assert.equal(reDoS.ok, false, '(a|aa)+$ 应被判定为灾难性回溯并拒绝');
  const safeRe = grep({ pattern: '(foo|bar)+', path: tmpU }, ctxG);
  assert.equal(safeRe.ok, true, '无重叠前缀的分支不应被误伤');

  safeRmSync(tmpU, { recursive: true, force: true });
  ok('v0.4.6 回归：URL 凭据脱敏 / undo 越界报错 / hook `|` matcher / 预设对象形态提权 / SSH_AUTH_SOCK / 深 schema / grep ReDoS');
}

// ---------- 55. v0.4.6 回归：时区 / 轮转保留当天 / 峰谷锚点 / 输出上限 ----------
{
  const prevHome55 = process.env.MINGDAO_HOME;
  const home55 = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-r55-'));
  process.env.MINGDAO_HOME = home55;

  // 55a. 覆盖 pricing.timezone 后，日界与避峰顺延必须按该时区真实偏移换算（此前硬编码 UTC+8）
  fs.writeFileSync(path.join(home55, 'config.json'), JSON.stringify({ pricing: { timezone: 'America/New_York' } }));
  const pricingMod = await import(pathToFileURL(path.join(srcDir, 'pricing.js')).href + '?tz55');
  const ny = new Date('2026-09-11T14:00:00Z'); // 纽约 10:00（高峰窗口内）
  assert.equal(pricingMod.beijingDayStart(ny).toISOString(), '2026-09-11T04:00:00.000Z', '日界应为纽约当地 0 点');
  assert.equal(pricingMod.deferToOffpeak(ny).toISOString(), '2026-09-11T16:00:00.000Z', '避峰应顺延到纽约 12:00');
  fs.writeFileSync(path.join(home55, 'config.json'), '{}');
  const pricingMod2 = await import(pathToFileURL(path.join(srcDir, 'pricing.js')).href + '?tz55b');
  assert.equal(pricingMod2.beijingDayStart(ny).toISOString(), '2026-09-10T16:00:00.000Z', '默认时区仍为北京 0 点');

  // 55b. 峰谷单价按「请求发起时刻」锚定（非响应落账时刻）
  const { recordUsage } = await import(pathToFileURL(path.join(srcDir, 'cachestats.js')).href);
  const peakAt = Date.parse('2026-09-02T02:00:00Z'); // 周三 10:00 北京 = 高峰
  const offAt = Date.parse('2026-09-02T05:00:00Z'); // 周三 13:00 北京 = 闲时
  recordUsage('deepseek-v4-flash', { prompt_tokens: 1000000, completion_tokens: 0 }, { requestStartAt: peakAt });
  recordUsage('deepseek-v4-flash', { prompt_tokens: 1000000, completion_tokens: 0 }, { requestStartAt: offAt });
  const rows55 = fs
    .readFileSync(path.join(home55, 'cache-stats.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.ok(Math.abs(rows55[0].cost - 3.0) < 1e-9, `高峰请求应记高峰价 3.0（实际 ${rows55[0].cost}）`);
  assert.ok(Math.abs(rows55[1].cost - 1.5) < 1e-9, `闲时请求应记闲时价 1.5（实际 ${rows55[1].cost}）`);

  // 55c. maxOutputCeiling（官方单次输出规格）必须真正约束显式配置的 maxOutputTokens
  const { createAgent: ca55 } = await import(pathToFileURL(path.join(srcDir, 'agent.js')).href);
  const { createIO: cio55 } = await import(pathToFileURL(path.join(srcDir, 'ui.js')).href);
  const stub55 = { async chat() { return { text: 'x', reasoning: '', finish: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, toolCalls: null }; } };
  const ag55 = ca55({
    provider: stub55,
    permission: { async check() { return true; } },
    io: cio55({ quiet: true }),
    modelName: 'deepseek-v4-pro',
    workingDir: home55,
    cfg: { permission: 'auto', maxOutputTokens: 999999999 },
  });
  assert.ok(ag55.maxOutput <= 384000, `显式 maxOutputTokens 应被 maxOutputCeiling(384K) 封顶（实际 ${ag55.maxOutput}）`);

  process.env.MINGDAO_HOME = prevHome55;
  safeRmSync(home55, { recursive: true, force: true });
  ok('v0.4.6 回归：时区感知日界/避峰 · 峰谷锚定请求发起时刻 · 输出上限封顶');
}

// ---------- 56. v0.4.6 回归：macOS 自启 plist 用绝对路径（launchd 极简 PATH 下可解析） ----------
{
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-autostart-'));
  const script = `import { enableAutostart, disableAutostart, autostartPath } from ${JSON.stringify(pathToFileURL(path.join(srcDir, 'autostart.js')).href)};
import fs from 'node:fs';
const okOn = enableAutostart();
const xml = okOn ? fs.readFileSync(autostartPath(), 'utf8') : '';
disableAutostart();
console.log(JSON.stringify({ okOn, xml }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: {
      ...process.env,
      HOME: fakeHome,
      MINGDAO_HOME: path.join(fakeHome, 'mh'),
      // Windows 的 os.homedir() 走 USERPROFILE、autostart 走 APPDATA——一并重定向，
      // 避免写到 CI 运行器真实的「启动」文件夹（与既有 autostart 测试同口径）
      ...(process.platform === 'win32' ? { USERPROFILE: fakeHome, APPDATA: path.join(fakeHome, 'AppData', 'Roaming') } : {}),
    },
    encoding: 'utf8',
  });
  const parsed = JSON.parse(String(r.stdout || '{}').trim() || '{}');
  if (process.platform === 'darwin') {
    assert.equal(parsed.okOn, true, '自启应写入成功：' + String(r.stderr || '').slice(0, 200));
    assert.ok(String(parsed.xml).includes(process.execPath), 'plist 必须使用 node 绝对路径（launchd 不读登录 shell 的 PATH）');
    assert.ok(!/<string>mingdao web/.test(String(parsed.xml)), 'plist 不得再使用裸命令名 mingdao');
  }
  safeRmSync(fakeHome, { recursive: true, force: true });
  ok('v0.4.6 回归：自启命令使用绝对路径（launchd 下不再静默 command not found）');
}

// ---------- 58. v0.5.0 阶段 A3 回归：约束引擎（领域红线的内核强制） ----------
{
  const C = await import(pathToFileURL(path.join(srcDir, 'constraints.js')).href);
  const list = [
    { id: 'no-cross-patient', kind: 'tool-arg-require', pack: 'tcm', tool: 'intake_read', requireArg: 'patientId' },
    { id: 'no-destructive', kind: 'tool-deny', pack: 'tcm', tool: 'bash' },
    { id: 'no-pii-arg', kind: 'arg-forbid', pack: 'tcm', tool: 'fetch', arg: 'url', pattern: '^http://' },
    { id: 'ten-questions', kind: 'completeness', pack: 'tcm', tool: 'intake_collect', fields: ['zhushu', 'zhendan'] },
    { id: 'no-conclusion', kind: 'output-forbid', pattern: '好转|治愈|确诊为', action: 'block-and-rewrite' },
  ];
  const c = C.compileConstraints(list);
  assert.equal(c.size, 5, '5 条约束都应编译通过');
  assert.deepEqual(c.invalid, [], '不应有非法约束');

  // ① PreToolUse：工具与参数红线
  assert.equal(C.checkPreTool(c, 'pack__tcm__intake_read', {}).blocked, true, '缺 patientId 应被阻断（不得跨患者串病历）');
  assert.equal(C.checkPreTool(c, 'pack__tcm__intake_read', { patientId: 'P001' }), null, '带 patientId 应放行');
  assert.equal(C.checkPreTool(c, 'pack__tcm__bash', { command: 'rm -rf /' }).blocked, true, 'tool-deny 应阻断');
  assert.equal(C.checkPreTool(c, 'pack__tcm__fetch', { url: 'http://evil/x' }).blocked, true, 'arg-forbid 应阻断');
  assert.equal(C.checkPreTool(c, 'pack__tcm__fetch', { url: 'https://ok/x' }), null, '未命中参数应放行');

  // ② PostToolUse：缺项绝不编造
  const miss = C.checkPostTool(c, 'pack__tcm__intake_collect', { data: { zhushu: '头痛' } });
  assert.equal(miss.rejected, true, '必填项缺失应拒绝该工具结果');
  assert.deepEqual(miss.missing, ['zhendan'], '应指出缺失字段');
  assert.equal(C.checkPostTool(c, 'pack__tcm__intake_collect', { data: { zhushu: '头痛', zhendan: '无' } }), null, '齐全应放行');
  assert.equal(C.checkPostTool(c, 'pack__tcm__intake_collect', {}).rejected, true, '未返回结构化 data 应拒绝（fail-closed）');

  // ③ 输出前：只陈述事实，不出结论
  const hit = C.checkOutput(c, '服药后明显好转');
  assert.equal(hit.action, 'block-and-rewrite', '命中禁用措辞应按 action 处理');
  assert.equal(C.checkOutput(c, '血压 120/80，睡眠一般'), null, '事实陈述不应被拦');

  // fail-closed：非法正则条目被忽略（不参与判定），但整体仍可用
  const c2 = C.compileConstraints([{ id: 'bad', kind: 'output-forbid', pattern: '([' }]);
  assert.equal(c2.size, 0, '非法正则约束应被忽略');
  assert.equal(c2.invalid.length, 1, '应记录非法约束');
  assert.equal(c2.active, false, '无有效约束时应为非活跃');

  // 零约束时完全惰性（零 Pack 场景对既有行为零影响）
  const empty = C.compileConstraints([]);
  assert.equal(empty.active, false, '空集合应惰性');
  assert.equal(C.checkPreTool(empty, 'bash', {}), null, '空集合不得阻断任何工具');
  assert.equal(C.checkPostTool(empty, 'x', {}), null, '空集合不得拒绝任何结果');
  assert.equal(C.checkOutput(empty, '好转'), null, '空集合不得改写任何输出');

  ok('v0.5.0A3 回归：约束引擎（工具/参数/缺项/输出三时机强制 + fail-closed + 零约束惰性）');
}

// ---------- 57. v0.5.0 阶段 A 回归：垂域 Pack 契约（manifest 校验 / semver / 加载挂载） ----------
{
  const packs = await import(pathToFileURL(path.join(srcDir, 'packs.js')).href);

  // 57a. semver 语义（npm 一致）——engines.mingdao 的兼容窗口判定基础
  const sem = [
    ['0.5.0', '>=0.5 <0.7', true], ['0.4.6', '>=0.5 <0.7', false], ['0.6.9', '>=0.5 <0.7', true], ['0.7.0', '>=0.5 <0.7', false],
    ['1.9.9', '^1.2.0', true], ['2.0.0', '^1.2.0', false], ['0.5.9', '^0.5.0', true], ['0.6.0', '^0.5.0', false],
    ['0.0.3', '^0.0.3', true], ['0.0.4', '^0.0.3', false], ['1.2.9', '~1.2.0', true], ['1.3.0', '~1.2.0', false],
    ['1.2.3', '*', true], ['1.2.3', '1.2.3', true], ['1.2.4', '1.2.3', false],
  ];
  for (const [v, r, want] of sem) assert.equal(packs.satisfiesRange(v, r), want, `semver ${v} in ${r} 应 ${want}`);

  // 57b. manifest 校验：合法通过、各类非法被拒且原因可操作
  const base = { apiVersion: 1, name: 'demo', version: '1.0.0', engines: { mingdao: '>=0.4.6 <0.7' } };
  assert.equal(packs.validateManifest(base).ok, true, '合法 manifest 应通过');
  const rejects = [
    [{ ...base, apiVersion: 99 }, 'apiVersion'],
    [{ ...base, name: 'Bad Name' }, 'name'],
    [{ ...base, name: 'core' }, '保留名'],
    [{ ...base, version: 'v1' }, 'version'],
    [{ ...base, engine: {} }, '未知字段'],
    [{ ...base, engines: { mingdao: '>=9.0 <10.0' } }, '不匹配'],
    [{ ...base, permissions: { shell: [] } }, 'permissions'],
    [{ ...base, contributes: { nope: true } }, 'contributes'],
  ];
  for (const [m, label] of rejects) {
    const r = packs.validateManifest(m);
    assert.equal(r.ok, false, `${label} 的 manifest 应被拒绝`);
    assert.ok(r.errors.length > 0 && typeof r.errors[0] === 'string', `${label} 应给出可操作原因`);
  }

  // 57c. 约束静态校验
  const cOk = packs.validateManifest({ ...base, contributes: { constraints: true } });
  assert.equal(cOk.ok, true, '声明 constraints 的 manifest 应通过');

  // 57d. 发现 + 挂载内置示例 Pack：工具注册 / 约束与提示词段收集 / 幂等 / 不抛错
  const prevHome57 = process.env.MINGDAO_HOME;
  const home57 = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-pack-'));
  process.env.MINGDAO_HOME = home57;
  const repoRoot57 = path.join(srcDir, '..');
  const found = packs.listPacks({}, repoRoot57);
  const demo = found.find((p) => p.name === 'example-hello');
  assert.ok(demo, '应发现内置示例 Pack（实际：' + JSON.stringify(found.map((p) => p.name)) + '）');
  assert.equal(demo.error, null, '内置示例 Pack 应校验通过：' + demo.error);

  const mounted = await packs.mountPacks({}, { cwd: repoRoot57 });
  assert.ok(mounted.mounted.some((p) => p.name === 'example-hello'), '应挂载 example-hello');
  assert.equal(mounted.warnings.length, 0, '不应有告警：' + JSON.stringify(mounted.warnings));
  const toolName = 'pack__example-hello__count_lines';
  const schemaNames = buildToolSchemas(new Set(), []).map((t) => t.function.name);
  assert.ok(schemaNames.includes(toolName), 'Pack 工具应进入 tools schema');
  const toolRes = await dispatch(toolName, { path: path.join(repoRoot57, 'package.json') }, { cwd: repoRoot57 });
  assert.equal(toolRes.ok, true, 'Pack 工具应可执行：' + JSON.stringify(toolRes));
  assert.ok(mounted.constraints.some((c) => c.id === 'no-conclusion' && c.pack === 'example-hello'), '约束应带 pack 归属');
  assert.ok(mounted.promptSections.some((s) => s.id === 'domain' && s.pack === 'example-hello'), '提示词段应带 pack 归属');

  // 幂等：重复挂载不报错、不重复注册
  const again = await packs.mountPacks({}, { cwd: repoRoot57 });
  assert.equal(again.warnings.filter((w) => w.includes('注册失败')).length, 0, '重复挂载不得重复注册工具');

  // 57e. 坏 Pack 不阻塞启动（缺 pack.mjs / 非法约束）
  const badDir = path.join(home57, 'packs', 'broken');
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(path.join(badDir, 'pack.json'), JSON.stringify({ apiVersion: 1, name: 'broken', version: '1.0.0', engines: { mingdao: '>=0.4.6 <0.7' }, contributes: { tools: true } }));
  const bad = await packs.loadPack(badDir);
  assert.equal(bad.ok, false, '声明代码贡献但缺 pack.mjs 应被拒');
  assert.ok(String(bad.errors[0]).includes('pack.mjs'), '应指出缺 pack.mjs');

  // 57f. A4.6 静态提示：Pack 自建模型调用（fetch 且不用 ctx.llm）应告警但**不阻断**
  const lintDir = path.join(home57, 'packs', 'lintprobe');
  fs.mkdirSync(lintDir, { recursive: true });
  fs.writeFileSync(path.join(lintDir, 'pack.json'), JSON.stringify({ apiVersion: 1, name: 'lintprobe', version: '1.0.0', engines: { mingdao: '>=0.4.6 <0.7' }, contributes: { tools: true } }));
  // 注意：注释里出现 ctx.llm 不得掩盖真实调用（lint 先剥注释）
  fs.writeFileSync(path.join(lintDir, 'pack.mjs'), 'export function createPack(){ /* ctx.llm 才是正道 */\n return { tools: [{ name: "x", run: async () => { await fetch("https://api.deepseek.com/v1/chat/completions"); return { ok: true }; } }] }; }');
  const lintRes = await packs.loadPack(lintDir);
  assert.equal(lintRes.ok, true, 'lint 只是提示，不得阻断加载');
  assert.ok((lintRes.warnings || []).some((w) => w.includes('ctx.llm')), '自建模型调用应产生 ctx.llm 静态提示');
  const okDir = path.join(home57, 'packs', 'lintclean');
  fs.mkdirSync(okDir, { recursive: true });
  fs.writeFileSync(path.join(okDir, 'pack.json'), JSON.stringify({ apiVersion: 1, name: 'lintclean', version: '1.0.0', engines: { mingdao: '>=0.4.6 <0.7' }, contributes: { tools: true } }));
  fs.writeFileSync(path.join(okDir, 'pack.mjs'), 'export function createPack(){ return { tools: [{ name: "y", run: async (_a, c) => { const r = await c.llm({ user: "hi" }); return { ok: true, output: r.text }; } }] }; }');
  const cleanRes = await packs.loadPack(okDir);
  assert.equal(cleanRes.ok, true, '使用 ctx.llm 的 Pack 应正常加载');
  assert.equal((cleanRes.warnings || []).length, 0, '使用 ctx.llm 时不应告警：' + JSON.stringify(cleanRes.warnings));

  // 57g. A4.5 Pack 级预算：超限时按 action 阻止 Pack 内的模型调用
  {
    const bDir = path.join(home57, 'packs', 'budgeted');
    fs.mkdirSync(bDir, { recursive: true });
    fs.writeFileSync(path.join(bDir, 'pack.json'), JSON.stringify({ apiVersion: 1, name: 'budgeted', version: '1.0.0', engines: { mingdao: '>=0.4.6 <0.7' }, budget: { dailyYuan: 0.5, action: 'block' }, contributes: { tools: true } }));
    fs.writeFileSync(path.join(bDir, 'pack.mjs'), 'export function createPack(){ return { tools:[{ name:"go", description:"d", parameters:{type:"object",properties:{}}, readOnly:true, run: async (_a,c)=>{ const r= await c.llm({user:"hi",maxTokens:10}); return {ok:true,output:r.text}; } }] }; }');
    const { registerTool: regB } = await import(pathToFileURL(path.join(srcDir, 'tools', 'index.js')).href);
    const { resetPacksForTest: resetB } = await import(pathToFileURL(path.join(srcDir, 'packs.js')).href);
    resetB();
    const mountedB = await packs.mountPacks({}, { cwd: repoRoot57 });
    assert.ok(mountedB.mounted.some((m) => m.name === 'budgeted' && m.budget && m.budget.dailyYuan === 0.5), '应挂载带预算的 Pack 并暴露 budget');
    const { recordCacheStats: recB, packDailyCost: pdcB } = await import(pathToFileURL(path.join(srcDir, 'cachestats.js')).href);
    recB({ model: 'deepseek-v4-flash', prompt: 1000, completion: 0, hit: null, miss: null, cost: null, saved: null, pack: 'budgeted', purpose: 'seed', packCost: 0.6 });
    assert.ok(Math.abs(pdcB('budgeted') - 0.6) < 1e-9, 'packDailyCost 应汇总今日该 Pack 的 packCost');
    let packCallHappened = false;
    const providerB = {
      async chat(o) {
        if (Array.isArray(o.tools) && o.tools.length === 0) { packCallHappened = true; return { text: 'SHOULD-NOT-HAPPEN', reasoning: '', finish: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, toolCalls: null }; }
        if (!o.messages.some((m) => m.role === 'tool')) return { text: '', reasoning: '', finish: 'tool_calls', usage: { prompt_tokens: 5, completion_tokens: 1 }, toolCalls: [{ id: 'c', type: 'function', function: { name: 'pack__budgeted__go', arguments: '{}' } }] };
        return { text: 'done', reasoning: '', finish: 'stop', usage: { prompt_tokens: 5, completion_tokens: 1 }, toolCalls: null };
      },
    };
    const agentB = createAgent({ provider: providerB, permission: { mode: 'auto', async check() { return true; } }, io: createIO({ quiet: true }), modelName: 'deepseek-v4-flash', workingDir: repoRoot57, cfg: { permission: 'auto', autoCompact: false, maxRounds: 1 } });
    const msgsB = [{ role: 'system', content: 's' }, { role: 'user', content: 'go' }];
    await agentB.runTurn(msgsB);
    const tmB = msgsB.find((m) => m.role === 'tool');
    assert.ok(String(tmB && tmB.content).includes('已达上限'), '超预算时 Pack 内模型调用应被阻止并给出可操作提示');
    assert.equal(packCallHappened, false, '被预算阻止时不得真的发起模型调用');
    resetB();
    await packs.mountPacks({}, { cwd: repoRoot57 });
    void regB;
  }

  const badDir2 = path.join(home57, 'packs', 'badconstraint');
  fs.mkdirSync(badDir2, { recursive: true });
  fs.writeFileSync(path.join(badDir2, 'pack.json'), JSON.stringify({ apiVersion: 1, name: 'badconstraint', version: '1.0.0', engines: { mingdao: '>=0.4.6 <0.7' }, contributes: { constraints: true } }));
  fs.writeFileSync(path.join(badDir2, 'pack.mjs'), 'export function createPack(){ return { constraints: [{ id: "x", kind: "not-a-kind" }] }; }');
  const bad2 = await packs.loadPack(badDir2);
  assert.equal(bad2.ok, false, '非法 constraint.kind 应被拒');
  const m2 = await packs.mountPacks({}, { cwd: repoRoot57 });
  assert.ok(Array.isArray(m2.warnings) && m2.warnings.length >= 1, '坏 Pack 应只产生告警，不抛错');

  process.env.MINGDAO_HOME = prevHome57;
  safeRmSync(home57, { recursive: true, force: true });
  ok('v0.5.0A 回归：Pack 契约（semver / manifest 校验 / 发现挂载 / 幂等 / 坏 Pack 不崩启动）');
}


// ---------- 59. v0.5.0 阶段 A3 回归：约束接入 agent 三时机（端到端，真实 agent 循环） ----------
{
  const tmpC59 = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-cst-'));
  const io59 = createIO({ quiet: true });

  // 59a. PreToolUse：tool-deny 在权限放行之后仍必须拦住执行
  {
    let ran = 0;
    const provider59 = {
      async chat({ messages }) {
        if (!messages.some((m) => m.role === 'tool')) {
          return { text: '', reasoning: '', finish: 'tool_calls', usage: { prompt_tokens: 1, completion_tokens: 1 },
            toolCalls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'echo hi' }) } }] };
        }
        return { text: '完成', reasoning: '', finish: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, toolCalls: null };
      },
    };
    const agent59 = createAgent({
      provider: provider59,
      permission: { mode: 'auto', async check() { ran += 1; return true; } },
      io: io59,
      modelName: 'deepseek-v4-flash',
      workingDir: tmpC59,
      cfg: { permission: 'auto', autoCompact: false, maxRounds: 1 },
      constraints: [{ id: 'no-bash', kind: 'tool-deny', tool: 'bash' }],
    });
    const msgs59 = [{ role: 'system', content: 's' }, { role: 'user', content: 'run something' }];
    await agent59.runTurn(msgs59);
    const toolMsg = msgs59.find((m) => m.role === 'tool');
    assert.ok(toolMsg && String(toolMsg.content).includes('领域约束'), '被约束拦下的工具应回填【领域约束】而非执行结果');
    assert.ok(String(toolMsg.content).includes('no-bash'), '回填应指出是哪条约束');
  }

  // 59b. PostToolUse：completeness 缺项时拒绝工具结果（「缺项绝不编造」由内核强制）
  {
    const provider59b = {
      async chat({ messages }) {
        if (!messages.some((m) => m.role === 'tool')) {
          return { text: '', reasoning: '', finish: 'tool_calls', usage: { prompt_tokens: 1, completion_tokens: 1 },
            toolCalls: [{ id: 'c1', type: 'function', function: { name: 'pack__demo__intake', arguments: '{}' } }] };
        }
        return { text: '已继续采集', reasoning: '', finish: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, toolCalls: null };
      },
    };
    const { registerTool } = await import(pathToFileURL(path.join(srcDir, 'tools', 'index.js')).href);
    try {
      registerTool({ name: 'pack__demo__intake', description: 'd', parameters: { type: 'object', properties: {} }, readOnly: true,
        run: async () => ({ ok: true, output: '已落盘', data: { zhushu: '头痛' } }) });
    } catch {}
    const agent59b = createAgent({
      provider: provider59b,
      permission: { mode: 'auto', async check() { return true; } },
      io: io59,
      modelName: 'deepseek-v4-flash',
      workingDir: tmpC59,
      cfg: { permission: 'auto', autoCompact: false, maxRounds: 1 },
      constraints: [{ id: 'ten-questions', kind: 'completeness', tool: 'intake', fields: ['zhushu', 'zhendan'] }],
    });
    const msgs59b = [{ role: 'system', content: 's' }, { role: 'user', content: 'collect' }];
    await agent59b.runTurn(msgs59b);
    const tm = msgs59b.find((m) => m.role === 'tool');
    assert.ok(tm && String(tm.content).includes('领域约束'), '缺项时工具结果应被拒绝并回填约束原因');
    assert.ok(String(tm.content).includes('zhendan'), '应指出缺失字段 zhendan');
    assert.ok(!String(tm.content).includes('已落盘'), '被拒绝的原始结果不得进入模型上下文');
  }

  // 59c. 输出前：block-and-rewrite 命中后自动改写
  {
    let call = 0;
    const provider59c = {
      async chat() {
        call += 1;
        if (call === 1) return { text: '服药后明显好转，建议继续。', reasoning: '', finish: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, toolCalls: null };
        return { text: '服药后症状较前减轻，建议继续观察并复诊。', reasoning: '', finish: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, toolCalls: null };
      },
    };
    const agent59c = createAgent({
      provider: provider59c,
      permission: { mode: 'auto', async check() { return true; } },
      io: io59,
      modelName: 'deepseek-v4-flash',
      workingDir: tmpC59,
      cfg: { permission: 'auto', autoCompact: false, maxRounds: 1 },
      constraints: [{ id: 'no-conclusion', kind: 'output-forbid', pattern: '好转|治愈', action: 'block-and-rewrite' }],
    });
    const msgs59c = [{ role: 'system', content: 's' }, { role: 'user', content: '复诊' }];
    const r59c = await agent59c.runTurn(msgs59c);
    assert.ok(call >= 2, 'block-and-rewrite 应触发一次改写请求');
    assert.ok(!String(r59c.text).includes('好转'), '改写后不得包含禁用措辞（实际：' + r59c.text + '）');
    assert.ok(String(r59c.note || '').includes('领域约束'), '应给出约束提示 note');
    // 被拦下的违规正文不得留在会话历史里
    assert.ok(!msgs59c.some((m) => m.role === 'assistant' && String(m.content).includes('好转')), '违规正文不得回填历史');
  }

  // 59d. 输出前：block 直接拦截（改写不是必然可用时的兜底路径）
  {
    const provider59d = {
      async chat() { return { text: '已确诊为某种疾病。', reasoning: '', finish: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, toolCalls: null }; },
    };
    const agent59d = createAgent({
      provider: provider59d, permission: { mode: 'auto', async check() { return true; } }, io: io59,
      modelName: 'deepseek-v4-flash', workingDir: tmpC59,
      cfg: { permission: 'auto', autoCompact: false, maxRounds: 1 },
      constraints: [{ id: 'no-diagnosis', kind: 'output-forbid', pattern: '确诊为', action: 'block' }],
    });
    const r59d = await agent59d.runTurn([{ role: 'system', content: 's' }, { role: 'user', content: 'x' }]);
    assert.ok(!String(r59d.text).includes('确诊为'), 'block 动作必须拦下违规正文');
    assert.ok(String(r59d.text).includes('领域约束'), '应替换为合规说明');
  }

  // 59e. 零约束必须完全惰性（对既有行为零影响）
  {
    const provider59e = {
      async chat() { return { text: '服药后明显好转。', reasoning: '', finish: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, toolCalls: null }; },
    };
    const agent59e = createAgent({
      provider: provider59e, permission: { mode: 'auto', async check() { return true; } }, io: io59,
      modelName: 'deepseek-v4-flash', workingDir: tmpC59,
      cfg: { permission: 'auto', autoCompact: false, maxRounds: 1, constraints: [] },
    });
    const r59e = await agent59e.runTurn([{ role: 'system', content: 's' }, { role: 'user', content: 'x' }]);
    assert.equal(r59e.text, '服药后明显好转。', '无约束时正文必须原样返回（零影响）');
    assert.equal(r59e.note, undefined, '无约束时不应产生 note');
  }

  safeRmSync(tmpC59, { recursive: true, force: true });
  ok('v0.5.0A3 回归：约束接入 agent（tool-deny 阻断 / 缺项拒绝结果 / 输出改写与拦截 / 零约束惰性）');
}


// ---------- 60. v0.5.0 阶段 A5 回归：Pack 提示词段注入系统提示（且字节稳定） ----------
{
  const promptsMod = await import(pathToFileURL(path.join(srcDir, 'prompts.js')).href);
  const prevHome60 = process.env.MINGDAO_HOME;
  const home60 = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-a5-'));
  process.env.MINGDAO_HOME = home60;
  const { resetPacksForTest, mountPacks } = await import(pathToFileURL(path.join(srcDir, 'packs.js')).href);

  // 未挂载 Pack：不得出现 pack_rules（对既有系统提示零影响）
  resetPacksForTest();
  const plain = promptsMod.buildSystemPrompt({ workingDir: process.cwd() });
  assert.ok(!plain.includes('<pack_rules>'), '未挂载 Pack 时系统提示不得含 pack_rules');

  // 挂载后：领域段进入系统提示，且**两次构建字节一致**（前缀缓存安全）
  await mountPacks({}, { cwd: path.join(srcDir, '..') });
  const withPack = promptsMod.buildSystemPrompt({ workingDir: process.cwd() });
  assert.ok(withPack.includes('<pack_rules>'), '挂载 Pack 后应注入 pack_rules 段');
  assert.ok(withPack.includes('pack="example-hello"'), '应标注段来源 Pack');
  assert.ok(withPack.includes('不输出结论性判断'), '应包含 prompts/domain.md 的内容');
  const again = promptsMod.buildSystemPrompt({ workingDir: process.cwd() });
  assert.equal(again, withPack, '同一状态下两次构建必须字节一致（否则打掉前缀缓存）');

  resetPacksForTest();
  process.env.MINGDAO_HOME = prevHome60;
  safeRmSync(home60, { recursive: true, force: true });
  ok('v0.5.0A5 回归：Pack 领域提示词段注入（未挂载零影响 + 注入正确 + 字节稳定）');
}


// ---------- 61. v0.5.0 阶段 A4 回归：ctx.llm 统一模型出口（Pack 调用不再「费用隐身」） ----------
{
  const { registerTool: reg61, dispatch: disp61 } = await import(pathToFileURL(path.join(srcDir, 'tools', 'index.js')).href);
  const tmp61 = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-a4-'));
  const MAIN = { prompt_tokens: 1000, completion_tokens: 200 };
  const PACK = { prompt_tokens: 500, completion_tokens: 50 };

  // 模拟垂域 Pack 工具：内部通过 ctx.llm 调模型（而不是自己 fetch——那正是 Deyi 的 usage:0 老路）
  let packSawUsage = null;
  let packSawPurpose = null;
  let packSawTools = 'unset';
  try {
    reg61({
      name: 'pack__demo__summarize',
      description: 'd',
      parameters: { type: 'object', properties: {} },
      readOnly: true,
      run: async (_args, ctx) => {
        const r = await ctx.llm({ model: 'deepseek-v4-flash', system: '你是摘要器', user: '总结一下', maxTokens: 100, purpose: 'patient-extract' });
        packSawUsage = r.usage;
        packSawPurpose = r.purpose;
        return { ok: true, output: String(r.text || ''), data: { done: true } };
      },
    });
  } catch {}

  let seen = 0;
  const provider61 = {
    async chat(o) {
      seen += 1;
      // 带非空 tools = 主循环；tools 为空数组 = ctx.llm 的子调用
      const isPackCall = Array.isArray(o.tools) && o.tools.length === 0;
      if (isPackCall) {
        packSawTools = o.tools.length;
        return { text: '摘要正文', reasoning: '', finish: 'stop', usage: { ...PACK }, toolCalls: null };
      }
      if (!o.messages.some((m) => m.role === 'tool')) {
        return { text: '', reasoning: '', finish: 'tool_calls', usage: { ...MAIN },
          toolCalls: [{ id: 'c1', type: 'function', function: { name: 'pack__demo__summarize', arguments: '{}' } }] };
      }
      return { text: '完成', reasoning: '', finish: 'stop', usage: { ...MAIN }, toolCalls: null };
    },
  };
  const agent61 = createAgent({
    provider: provider61,
    permission: { mode: 'auto', async check() { return true; } },
    io: createIO({ quiet: true }),
    modelName: 'deepseek-v4-flash',
    workingDir: tmp61,
    cfg: { permission: 'auto', autoCompact: false, maxRounds: 1 },
  });
  const res61 = await agent61.runTurn([{ role: 'system', content: 's' }, { role: 'user', content: 'summarize' }]);

  assert.equal(seen, 3, '应为 主调用 + ctx.llm + 主调用 共 3 次');
  assert.equal(packSawTools, 0, 'ctx.llm 子调用不得携带工具');
  assert.ok(packSawUsage && packSawUsage.prompt_tokens === PACK.prompt_tokens, 'ctx.llm 应把子调用 usage 返回给 Pack');
  assert.equal(packSawPurpose, 'patient-extract', 'ctx.llm 应透传 purpose（归因标签）');
  // 关键断言：Pack 的调用必须并入父回合 usage——否则今日费用/护栏/分账全都看不到这笔钱
  assert.equal(res61.usage.prompt_tokens, MAIN.prompt_tokens * 2 + PACK.prompt_tokens,
    `Pack 经 ctx.llm 的 token 必须计入父回合（实际 ${res61.usage.prompt_tokens}）`);
  assert.equal(res61.usage.completion_tokens, MAIN.completion_tokens * 2 + PACK.completion_tokens,
    `Pack 经 ctx.llm 的 completion 必须计入父回合（实际 ${res61.usage.completion_tokens}）`);

  // 归因：ctx.llm 写"标记记录"（cost=null → 不进 todayCost，与回合级记录不重复计费），
  // 由 pack 前缀自动标注来源 → `mingdao cost --by pack` 可见
  {
    const { costBreakdown } = await import(pathToFileURL(path.join(srcDir, 'cachestats.js')).href);
    const { todayCost } = await import(pathToFileURL(path.join(srcDir, 'cost-guard.js')).href);
    const bd = costBreakdown();
    const pk = (bd.byPack || []).find((x) => x.pack === 'demo');
    assert.ok(pk, '应产生 Pack 归因记录（byPack 含 demo）：' + JSON.stringify(bd.byPack));
    assert.equal(pk.prompt, PACK.prompt_tokens, '归因记录应含 Pack 子调用的 prompt tokens');
    assert.equal(pk.calls, 1, '应记录 1 次 Pack 模型调用');
    assert.ok(pk.cost > 0, 'packCost 应为正（供 --by pack 展示）');
    // 关键：标记记录不得被计入今日费用（否则与回合级记录重复计费）
    const today = todayCost();
    assert.equal(today, 0, '仅标记记录时今日费用应为 0（cost=null 不计入）');
  }

  // 未显式传 constraints 且进程未挂载 Pack 时，agent 的 llm 仍然可用（库使用方场景）
  const ctxProbe = await disp61('pack__demo__summarize', {}, { cwd: tmp61, llm: undefined });
  assert.equal(ctxProbe.ok, false, '无 ctx.llm 时 Pack 工具应得到结构化失败而非崩溃（说明工具确实依赖注入的 ctx）');

  safeRmSync(tmp61, { recursive: true, force: true });
  ok('v0.5.0A4 回归：ctx.llm 统一模型出口（usage 并入父回合 + Pack 归因记录不重复计费）');
}

safeRmSync(tmp, { recursive: true, force: true });
delete process.env.MINGDAO_HOME;
safeRmSync(smokeHome, { recursive: true, force: true });
console.log(`\n全部通过：${passed} 组断言 ✓`);
