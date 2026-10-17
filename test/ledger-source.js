// 账本来源回归（v0.6.17 §3.64）：`run.start.permissionSource` 必须区分
// 「用户显式选的 / 预设压的 / config 默认 / CLI 参数 / 内置缺省」。
//
// 为什么单开一套而不是塞进 smoke：本项横跨三条入口（WebUI / CLI / 旧账本兼容），
// 需要真 HTTP + 真 CLI 子进程；独立套件可以单独 `node test/ledger-source.js` 跑，
// 也能在 `test/run-all.mjs` / CI 的 Linux 腿里按同一份断言执行。
//
// 覆盖：
//   ① 显式 auto + 只读预设 → permission=auto, permissionSource=explicit
//   ② 只发预设 → permission=readonly, permissionSource=preset
//   ③ 都不发 → web 记 config（resolveTurnPermission 的 config 分支，含内置缺省 ask）；CLI 无 permission 字段记 default
//   ④ 旧账本（run.start 无 permissionSource）仍能 verify 通过（向后兼容红线）
//
// 运行：node test/ledger-source.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
const cliPath = path.join(srcDir, 'cli.js');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-ledger-source-'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-ledger-source-work-'));
process.env.MINGDAO_HOME = home;
// Web 服务器的 workingDir 取 process.cwd()：把「项目级预设」放进临时工作目录，
// 不依赖仓库里是否存在 .mingdao/presets（也不往仓库里写测试夹具）。
process.chdir(work);
fs.mkdirSync(path.join(work, '.mingdao', 'presets'), { recursive: true });
fs.writeFileSync(path.join(work, '.mingdao', 'presets', 'ro.json'), JSON.stringify({ name: 'ro', label: '只读预设', permission: 'readonly' }));

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`  ✓ 账本来源[${name}]`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 桩 provider（离线；只回文本，不触发工具循环） ----------
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '桩回复' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const mockPort = mock.address().port;
const baseUrl = `http://127.0.0.1:${mockPort}/v1`;

// ---------- WebUI（真 HTTP + 真账本） ----------
const { runWebServer } = await import(pathToFileURL(path.join(srcDir, 'web', 'server.js')).href);
const { saveConfig } = await import(pathToFileURL(path.join(srcDir, 'config.js')).href);
const { readRun, verifyRun, digestOf, sealFile, ledgerDir } = await import(pathToFileURL(path.join(srcDir, 'ledger.js')).href);
// 显式写 config 权限 ask：③ 要证明「都不发」时来源是 config（WebUI 分支），与预设/显式区分开。
saveConfig({ provider: 'custom', model: 'test-model', baseUrl, permission: 'ask', contextBudget: 32000, ledger: true });
fs.writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({ custom: 'sk-test-' + 'x'.repeat(20) }), { mode: 0o600 });
const srv = await runWebServer({ host: '127.0.0.1', port: 0, authToken: null });
const base = `http://127.0.0.1:${srv.address().port}`;

/** 当前账本目录里的 runId 集合（用于找出本轮新写的那一份） */
function ledgerIds() {
  try {
    return new Set(fs.readdirSync(ledgerDir()).filter((f) => f.endsWith('.jsonl')).map((f) => f.replace(/\.jsonl$/, '')));
  } catch {
    return new Set();
  }
}
/** 发一次 chat → 等账本落盘 → 返回该次 run.start */
async function chatRunStart(payload, label) {
  const before = ledgerIds();
  const res = await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal(res.status, 200, `${label}：chat 应返回 200`);
  await res.text(); // 读完 SSE，保证 runTurn 已收尾
  let newId = null;
  const deadline = Date.now() + 15000;
  while (!newId && Date.now() < deadline) {
    newId = [...ledgerIds()].find((id) => !before.has(id)) ?? null;
    if (!newId) await sleep(100);
  }
  assert.ok(newId, `${label}：应生成一份新账本`);
  const start = readRun(newId).find((e) => e.type === 'run.start');
  assert.ok(start, `${label}：账本里应有 run.start`);
  return start;
}

// ① 显式 auto 压过只读预设：来源必须是 explicit（这正是「界面选了自动却按只读跑」的反面）
{
  const s = await chatRunStart({ message: '显式选择与只读预设', permission: 'auto', preset: 'ro' }, '①');
  assert.equal(s.permission, 'auto', '① 显式 auto 必须是生效值（预设 readonly 不得压过它）');
  assert.equal(s.permissionSource, 'explicit', '① 显式选择必须记为 explicit（不能被预设或 config 冒充）');
  ok('① 显式 auto + 只读预设 → auto / explicit');
}

// ② 只发预设：预设 readonly 生效，来源 preset
{
  const s = await chatRunStart({ message: '只发只读预设', preset: 'ro' }, '②');
  assert.equal(s.permission, 'readonly', '② 预设 readonly 应成为生效值');
  assert.equal(s.permissionSource, 'preset', '② 预设生效必须记为 preset');
  ok('② 只发预设 → readonly / preset');
}

// ③ 都不发：WebUI 走 resolveTurnPermission 的 config 分支（即使 config 缺 permission，内置缺省也归 config）
{
  const s = await chatRunStart({ message: '都不发' }, '③');
  assert.equal(s.permission, 'ask', '③ 都不发时应落到 config（这里是 ask）');
  assert.equal(s.permissionSource, 'config', '③ 都不发时 WebUI 记为 config（resolveTurnPermission 的既有语义）');
  ok('③ 都不发（WebUI）→ ask / config');
}

// ---------- CLI（真子进程） ----------
/** 用独立 home 跑一次 CLI 单次提问，返回本次 run.start（配置由调用方写）。
 *  必须用**异步** spawn：桩 provider 就活在本进程里，spawnSync 会堵死事件循环，
 *  子进程的模型请求永远等不到响应（本套件第一版就是这么挂到 90s 超时的）。 */
async function cliRunStart({ permission, preset }) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-ledger-source-cli-'));
  /** @type {any} */
  const cfg = { provider: 'custom', model: 'test-model', baseUrl, contextBudget: 32000, ledger: true };
  if (permission !== undefined) cfg.permission = permission;
  fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify(cfg), { mode: 0o600 });
  fs.writeFileSync(path.join(h, 'credentials.json'), JSON.stringify({ custom: 'sk-test-' + 'x'.repeat(20) }), { mode: 0o600 });
  const args = [cliPath, '-f', 'json'];
  if (preset) args.push('-p', preset);
  args.push('你好');
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: work, env: { ...process.env, MINGDAO_HOME: h }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
  assert.equal(r.status, 0, `CLI 应退出 0（stderr: ${String(r.stderr || '').slice(-500)}）`);
  const dir = path.join(h, 'ledger');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : [];
  assert.equal(files.length, 1, `CLI 应只生成一份账本，实际 ${files.length}`);
  // 这里不能调 readRun()：它按**本进程**的 MINGDAO_HOME 找文件，而 CLI 用的是独立 home。
  const events = fs.readFileSync(path.join(dir, files[0]), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const start = events.find((e) => e.type === 'run.start');
  assert.ok(start, 'CLI 账本里应有 run.start');
  return start;
}

// ③(CLI) config 里没有 permission → 内置缺省，来源 default（与 WebUI 的 config 分支写清区别）
{
  const s = await cliRunStart({});
  assert.equal(s.permission, 'ask', 'CLI 无 permission 字段时生效值应为内置缺省 ask');
  assert.equal(s.permissionSource, 'default', 'CLI 无 permission 字段时必须记 default（不能冒充 config）');
  ok('③ CLI 无 permission → ask / default');
}

// ④ CLI 显式 --permission 不在前台路径；预设是 CLI/REPL 的显式覆盖来源
{
  const s = await cliRunStart({ preset: 'ro' });
  assert.equal(s.permission, 'readonly', 'CLI 预设 readonly 应生效');
  assert.equal(s.permissionSource, 'preset', 'CLI 预设生效必须记为 preset');
  ok('④ CLI 预设 → readonly / preset');
}

// ⑤ config.permission 存在 → config
{
  const s = await cliRunStart({ permission: 'auto' });
  assert.equal(s.permission, 'auto', 'CLI 应读取 config.permission');
  assert.equal(s.permissionSource, 'config', 'CLI 配置里的 permission 必须记为 config');
  ok('⑤ CLI config.permission → auto / config');
}

// ---------- 旧账本兼容（无 permissionSource） ----------
{
  const oldId = 'oldrun-abcdef';
  const dir = ledgerDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const genesis = '0'.repeat(16);
  const ev1 = { v: 1, runId: oldId, seq: 1, at: Date.now() - 1000, type: 'run.start', prev: genesis, model: 'old-model', provider: 'deepseek', session: 'old.jsonl', cwd: '/tmp', permission: 'readonly', preset: null, packs: [] };
  const line1 = JSON.stringify(ev1);
  const ev2 = { v: 1, runId: oldId, seq: 2, at: Date.now(), type: 'run.end', prev: digestOf(line1), ms: 12, status: 'done', steps: 1, rounds: 1, yuanTotal: 0, priced: false };
  const line2 = JSON.stringify(ev2);
  fs.writeFileSync(path.join(dir, oldId + '.jsonl'), line1 + '\n' + line2 + '\n', { mode: 0o600 });
  fs.writeFileSync(sealFile(oldId), JSON.stringify({ v: 1, runId: oldId, total: 2, head: digestOf(line2), at: Date.now() }) + '\n', { mode: 0o600 });
  // 先证明夹具真的是「旧账本」：字段不存在
  assert.ok(!('permissionSource' in readRun(oldId)[0]), '旧账本夹具不得含 permissionSource');
  const v = verifyRun(oldId);
  assert.equal(v.ok, true, '旧账本（无 permissionSource）必须仍能 verify 通过');
  assert.equal(v.sealed, true, '旧账本封条比对应通过');
  const r = spawnSync(process.execPath, [cliPath, 'ledger', 'verify', oldId], { env: { ...process.env, MINGDAO_HOME: home }, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, `旧账本 ledger verify 应退 0（stdout: ${String(r.stdout || '').slice(-400)}）`);
  assert.ok(String(r.stdout || '').includes('校验通过'), '旧账本 ledger verify 应打印「校验通过」');
  // show 的契约：旧账本不出现「权限来源」这一可选行（新账本才显示），既有「权限：」行原样。
  const show = spawnSync(process.execPath, [cliPath, 'ledger', 'show', oldId], { env: { ...process.env, MINGDAO_HOME: home }, encoding: 'utf8', timeout: 30000 });
  assert.equal(show.status, 0, '旧账本 ledger show 应退 0');
  assert.ok(String(show.stdout || '').includes('权限：readonly'), 'show 的既有「权限：」行必须保持原样');
  assert.ok(!String(show.stdout || '').includes('权限来源'), '旧账本 show 不得凭空显示来源（可选字段缺失即整行不出现）');
  ok('⑤ 旧账本（无 permissionSource）仍 verify 通过 + show 契约不变');
}

await new Promise((r) => srv.close(r));
mock.close();
process.chdir(os.tmpdir()); // 清理前先离开临时工作目录（否则部分平台删不掉 cwd）
delete process.env.MINGDAO_HOME;
fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(work, { recursive: true, force: true });
console.log(`\n账本来源回归全部通过：${passed} 组 ✓`);
