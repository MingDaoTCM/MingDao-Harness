// 端到端测试：本地 mock OpenAI 兼容服务器 + 完整 CLI 进程。
// 覆盖：真实 HTTP/SSE、工具闭环、REPL、会话持久化、ask 权限交互、
// /plan 计划模式、/compact 压缩、task 子代理真实往返、--format json。
// 运行：node test/e2e-local.js

import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------- 可编程 mock 服务器 ----------
// mockMode: 'write' 首请求返回 write 工具调用 | 'task' 首请求返回 task 工具调用 | 'plain' 无工具调用
// tools 为空的请求（generatePlan / compactContext）返回 mockSummary 文本
let requestCount = 0;
let sawToolCall = false;
let mockMode = 'write';
let mockSummary = '计划文本';
let lastPayload = null;

function sse(res, payload) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  res.end('data: [DONE]\n\n');
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const parsed = JSON.parse(body);
    lastPayload = parsed;

    // 计划/摘要类请求（无工具）
    if (!parsed.tools || parsed.tools.length === 0) {
      sse(res, {
        choices: [{ delta: { content: mockSummary }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      });
      return;
    }

    requestCount += 1;
    assert.ok(parsed.tools.length >= 6, '请求应携带工具 Schema');

    if (mockMode === 'plain') {
      sse(res, {
        choices: [{ delta: { content: '这是回答' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      });
      return;
    }

    if (requestCount === 1) {
      sawToolCall = true;
      const tc =
        mockMode === 'task'
          ? {
              index: 0,
              id: 'call_task',
              type: 'function',
              function: { name: 'task', arguments: JSON.stringify({ description: '测试子任务', prompt: '子任务内容' }) },
            }
          : {
              index: 0,
              id: 'call_e2e',
              type: 'function',
              function: { name: 'write', arguments: JSON.stringify({ path: 'result.txt', content: 'e2e 成功\n' }) },
            };
      sse(res, {
        choices: [{ delta: { tool_calls: [tc] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      });
      return;
    }

    // 后续请求（含子代理自己的请求）：最终文本
    sse(res, {
      choices: [{ delta: { content: '全部完成！' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    });
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// ---------- 隔离环境 ----------
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-e2e-'));
function writeConfig(permission) {
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({
      provider: 'custom',
      model: 'test-model',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      permission,
      contextBudget: 32000,
    })
  );
}
writeConfig('auto');
fs.writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({ custom: 'sk-test-1234567890abcdef' }), {
  mode: 0o600,
});

function newWorkDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-work-'));
}
const work = newWorkDir();

function runCli(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'src', 'cli.js'), ...args], {
      cwd: opts.cwd || work,
      env: { ...process.env, MINGDAO_HOME: home, ...(opts.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

function resetMock(mode, summary = '计划文本') {
  requestCount = 0;
  sawToolCall = false;
  mockMode = mode;
  mockSummary = summary;
}

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ✓ e2e：${name}`);
}

// ---------- 1. 单次提问：完整工具闭环 ----------
{
  resetMock('write');
  const r = await runCli(['创建 result.txt 并写入内容']);
  assert.equal(r.code, 0, 'stderr: ' + r.err);
  assert.equal(fs.readFileSync(path.join(work, 'result.txt'), 'utf8'), 'e2e 成功\n');
  assert.ok(r.out.includes('全部完成！'), '应输出最终文本');
  assert.ok(sawToolCall, '模型应发起工具调用');
  assert.ok(r.out.includes('result.txt'), '应显示工具调用目标');
  assert.equal(lastPayload.stream, true, '请求必须携带 stream:true（防回归）');
  ok('HTTP/SSE → 工具执行 → 结果回填 → 最终输出');
}

// ---------- 2. 交互式 REPL：启动、/help、/exit ----------
{
  const r = await runCli([], { stdin: '/help\n/exit\n' });
  assert.equal(r.code, 0, 'stderr: ' + r.err);
  assert.ok(r.out.includes('MingDao 明道'), '应显示横幅');
  assert.ok(r.out.includes('会话内命令'), '/help 应输出帮助');
  ok('REPL 启动 / /help / /exit');
}

// ---------- 3. 会话持久化与 --continue ----------
{
  const files = fs.readdirSync(path.join(home, 'sessions')).filter((f) => f.endsWith('.jsonl'));
  assert.ok(files.length >= 1, '应生成会话文件');
  const r = await runCli(['--continue'], { stdin: '/exit\n' });
  assert.equal(r.code, 0);
  assert.ok(r.out.includes('已载入会话'), '--continue 应载入历史会话');
  ok('会话持久化与 --continue');
}

// ---------- 4. 凭证管理命令：脱敏状态 ----------
{
  const r = await runCli(['key', 'status']);
  assert.equal(r.code, 0, 'stderr: ' + r.err);
  assert.ok(r.out.includes('custom: sk-tes…cdef'), 'key status 应脱敏显示凭证');
  assert.ok(!r.out.includes('sk-test-1234567890abcdef'), 'key status 不得泄露完整密钥');
  ok('mingdao key status 脱敏显示');
}

// ---------- 5. ask 权限模式交互闭环（拒绝 / 放行） ----------
{
  writeConfig('ask');
  const w5 = newWorkDir();
  resetMock('write');
  const deny = await runCli(['创建 result.txt 并写入内容'], { cwd: w5, stdin: 'n\n' });
  assert.equal(deny.code, 0, 'stderr: ' + deny.err);
  assert.ok(!fs.existsSync(path.join(w5, 'result.txt')), '拒绝后文件不应创建');
  assert.ok(deny.out.includes('未授权'), '应显示拒绝标记');

  resetMock('write');
  const w5b = newWorkDir();
  const allow = await runCli(['创建 result.txt 并写入内容'], { cwd: w5b, stdin: 'y\n' });
  assert.equal(allow.code, 0, 'stderr: ' + allow.err);
  assert.equal(fs.readFileSync(path.join(w5b, 'result.txt'), 'utf8'), 'e2e 成功\n', '放行后文件应创建');
  writeConfig('auto');
  fs.rmSync(w5, { recursive: true, force: true });
  fs.rmSync(w5b, { recursive: true, force: true });
  ok('ask 权限模式：拒绝 / 放行闭环');
}

// ---------- 6. /plan 计划模式（管道驱动） ----------
{
  resetMock('write', '第一步：列出文件。第二步：汇报。');
  const w6 = newWorkDir();
  const r = await runCli([], { cwd: w6, stdin: '/plan\n列出文件\ny\n/exit\n' });
  assert.equal(r.code, 0, 'stderr: ' + r.err);
  assert.ok(r.out.includes('── 执行计划 ──'), '应显示计划');
  assert.ok(r.out.includes('第一步：列出文件'), '计划内容应来自模型');
  assert.equal(fs.readFileSync(path.join(w6, 'result.txt'), 'utf8'), 'e2e 成功\n', '确认后应执行计划');
  fs.rmSync(w6, { recursive: true, force: true });
  ok('/plan 计划模式：计划 → 确认 → 执行');
}

// ---------- 7. /compact 上下文压缩 ----------
{
  resetMock('plain', '压缩摘要：前两轮讨论了测试话题。');
  const w7 = newWorkDir();
  const r = await runCli([], { cwd: w7, stdin: '问题一\n问题二\n问题三\n/compact\n/exit\n' });
  assert.equal(r.code, 0, 'stderr: ' + r.err);
  assert.ok(r.out.includes('已压缩上下文'), '应输出压缩成功标记');
  fs.rmSync(w7, { recursive: true, force: true });
  ok('/compact 上下文压缩');
}

// ---------- 8. task 子代理真实往返 ----------
{
  resetMock('task');
  const w8 = newWorkDir();
  const r = await runCli(['完成子任务'], { cwd: w8 });
  assert.equal(r.code, 0, 'stderr: ' + r.err);
  assert.ok(r.out.includes('子任务'), '应显示子代理进度标记');
  assert.ok(sawToolCall, '主代理应发起 task 调用');
  fs.rmSync(w8, { recursive: true, force: true });
  ok('task 子代理真实往返');
}

// ---------- 9. --format json 结构化输出 ----------
{
  resetMock('plain');
  const r = await runCli(['--format', 'json', '一个问题']);
  assert.equal(r.code, 0, 'stderr: ' + r.err);
  const j = JSON.parse(r.out.trim());
  assert.equal(j.ok, true);
  assert.equal(j.text, '这是回答');
  assert.equal(j.usage.prompt_tokens, 100);
  assert.equal(j.session.endsWith('.jsonl'), true);
  assert.ok(typeof j.durationMs === 'number');
  ok('--format json 结构化输出');
}

// ---------- 10. JSON 模式 + ask 权限 + stdin EOF：交互通道中断按「拒绝」降级，契约不崩 ----------
{
  writeConfig('ask');
  resetMock('write');
  const r = await runCli(['--format', 'json', '创建 eof-denied.txt'], { stdin: '' });
  // stdin EOF 时权限确认按拒绝处理：回合优雅完成（工具未执行），而非进程崩溃
  assert.equal(r.code, 0, 'stderr: ' + r.err);
  const j = JSON.parse(r.out.trim());
  assert.equal(j.ok, true);
  assert.ok(!fs.existsSync(path.join(work, 'eof-denied.txt')), '被拒的工具不应执行');
  writeConfig('auto');
  ok('JSON 模式 + ask + stdin EOF：单行 JSON 契约 + 拒绝降级不崩溃');
}

// ---------- 11. 后台任务：启动 → 完成 → 状态文件 → 任务面板列表 ----------
{
  writeConfig('auto');
  resetMock('write');
  const w9 = newWorkDir();
  const r = await runCli(['run', '创建后台任务文件', '--permission', 'auto'], { cwd: w9 });
  assert.equal(r.code, 0, 'stderr: ' + r.err);
  assert.ok(r.out.includes('后台任务已启动'), '应提示任务已启动');
  const id = (r.out.match(/已启动\s+(\S+)/) || [])[1];
  assert.ok(id, '应返回任务 id');
  const taskFile = path.join(home, 'tasks', id + '.json');
  let task = null;
  for (let i = 0; i < 40 && (!task || task.status === 'running'); i++) {
    await new Promise((res) => setTimeout(res, 300));
    try {
      task = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
    } catch {}
  }
  assert.equal(task.status, 'done', '任务应完成：' + JSON.stringify(task));
  assert.ok(String(task.text).includes('全部完成'), '任务文本应含最终回答');
  assert.ok(task.usage && task.usage.prompt_tokens > 0, '应记录用量');
  assert.ok(task.session && task.session.endsWith('.jsonl'), '应关联会话文件');
  assert.equal(fs.readFileSync(path.join(w9, 'result.txt'), 'utf8'), 'e2e 成功\n', '后台任务应写入文件');
  const list = await runCli(['tasks']);
  assert.equal(list.code, 0);
  assert.ok(list.out.includes('✓') && list.out.includes(id), '任务面板应列出已完成任务');
  fs.rmSync(w9, { recursive: true, force: true });
  ok('后台任务：启动/完成/状态文件/面板列表');
}

// ---------- 12. 后台任务：ask 权限降级只读 ----------
{
  writeConfig('ask');
  resetMock('write');
  const w10 = newWorkDir();
  const r = await runCli(['run', '创建不应被写入的文件'], { cwd: w10 });
  assert.equal(r.code, 0);
  const id = (r.out.match(/已启动\s+(\S+)/) || [])[1];
  const taskFile = path.join(home, 'tasks', id + '.json');
  let task = null;
  for (let i = 0; i < 40 && (!task || task.status === 'running'); i++) {
    await new Promise((res) => setTimeout(res, 300));
    try {
      task = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
    } catch {}
  }
  assert.equal(task.status, 'done');
  assert.ok(String(task.note).includes('只读'), 'ask 降级应注明');
  assert.ok(!fs.existsSync(path.join(w10, 'result.txt')), '只读降级下不应写入文件');
  writeConfig('auto');
  fs.rmSync(w10, { recursive: true, force: true });
  ok('后台任务：ask 权限降级只读');
}

// ---------- 13. 技能库 CLI：搜索 / 安装 / 列表 / 卸载 ----------
{
  const s1 = await runCli(['skill', 'search', '邮件']);
  assert.equal(s1.code, 0, s1.err);
  assert.ok(s1.out.includes('email'), '关键词搜索应命中 email 技能');
  const s2 = await runCli(['skill', 'install', 'email']);
  assert.equal(s2.code, 0, s2.err);
  assert.ok(s2.out.includes('✓ 已安装技能 email'), '安装应提示成功');
  const s3 = await runCli(['skill', 'list']);
  assert.equal(s3.code, 0, s3.err);
  assert.ok(s3.out.includes('email'), '列表应包含已安装技能');
  assert.ok(s3.out.includes('（用户级）'), '应标注用户级来源');
  assert.ok(s3.out.includes('技能库共'), '应提示技能库数量');
  const offlineHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-offline-'));
  const s4 = await runCli(['skill', 'install', 'no-such-skill'], { env: { MINGDAO_REGISTRY_URL: 'http://127.0.0.1:1', MINGDAO_HOME: offlineHome } });
  assert.equal(s4.code, 1);
  assert.ok(s4.out.includes('无法获取线上技能库'), '未知技能应回退线上 registry 并报告不可达');
  fs.rmSync(offlineHome, { recursive: true, force: true });
  const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-badskill-'));
  fs.writeFileSync(path.join(badDir, 'SKILL.md'), '# 缺 frontmatter');
  const s7 = await runCli(['skill', 'install', badDir], { env: { MINGDAO_REGISTRY_URL: 'http://127.0.0.1:1' } });
  assert.equal(s7.code, 1);
  assert.ok(s7.out.includes('frontmatter'), '坏格式技能应拒绝安装（dry-run 校验）');
  fs.rmSync(badDir, { recursive: true, force: true });
  const s5 = await runCli(['skill', 'uninstall', 'email']);
  assert.equal(s5.code, 0, s5.err);
  assert.ok(s5.out.includes('✓ 已卸载 email'), '卸载应提示成功');
  const s6 = await runCli(['skill', 'uninstall', 'email']);
  assert.equal(s6.code, 1);
  assert.ok(s6.out.includes('未安装'), '重复卸载应报错');
  ok('skill CLI：搜索 / 安装 / 列表 / 卸载闭环');
}

// ---------- 14. 云同步 CLI：登录 / 推送 / 拉取 / 状态 / 退出 ----------
{
  const { runSyncServer } = await import(path.join(root, 'src', 'sync-server.js'));
  const syncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-clisync-'));
  const srv = runSyncServer({ port: 0, host: '127.0.0.1', dataDir: syncDir });
  await new Promise((r) => srv.once('listening', r));
  const syncUrl = `http://127.0.0.1:${srv.address().port}`;
  const l1 = await runCli(['sync', 'login', 'cli-user', 'password123', syncUrl]);
  assert.equal(l1.code, 0, l1.err + l1.out);
  assert.ok(l1.out.includes('已登录'), '登录应成功');
  const p1 = await runCli(['sync', 'push']);
  assert.equal(p1.code, 0, p1.err + p1.out);
  assert.ok(p1.out.includes('已推送'), '推送应成功');
  const st1 = await runCli(['sync', 'status']);
  assert.equal(st1.code, 0);
  assert.ok(st1.out.includes('已登录') && st1.out.includes('远端会话'), '状态应显示已登录与远端会话');
  const p2 = await runCli(['sync', 'pull']);
  assert.equal(p2.code, 0, p2.err + p2.out);
  assert.ok(p2.out.includes('已拉取'), '拉取应成功');
  // 改密码（stdin 输旧密码）→ 服务端吊销全部设备 token，需用新密码重新登录
  const pw = await runCli(['sync', 'passwd', 'newpassword456'], { stdin: 'password123\n' });
  assert.equal(pw.code, 0, pw.err + pw.out);
  assert.ok(pw.out.includes('已修改'), '密码修改应成功');
  const relogin = await runCli(['sync', 'login', 'cli-user', 'newpassword456', syncUrl]);
  assert.equal(relogin.code, 0, relogin.err + relogin.out);
  assert.ok(relogin.out.includes('已登录'), '改密后应能用新密码重新登录');
  // 分享与撤销（用本地真实会话名）
  const sessFiles = fs.readdirSync(path.join(home, 'sessions')).filter((f) => f.endsWith('.jsonl') && !f.includes('.server-') && !f.includes('.remote-'));
  const sh = await runCli(['sync', 'share', sessFiles[0]]);
  assert.equal(sh.code, 0, sh.err + sh.out);
  const shareId = (sh.out.match(/分享码：(\S+)/) || [])[1];
  assert.ok(shareId, '应输出分享码');
  const un = await runCli(['sync', 'unshare', shareId]);
  assert.equal(un.code, 0);
  // 冲突三选一
  fs.writeFileSync(path.join(home, 'sessions', 'cli-cf.server-123.jsonl'), '{"role":"user","content":"远端"}\n');
  const cl = await runCli(['sync', 'conflicts']);
  assert.ok(cl.out.includes('cli-cf.jsonl'), '冲突列表应显示');
  const cr = await runCli(['sync', 'conflict-resolve', 'cli-cf.jsonl', 'both']);
  assert.equal(cr.code, 0, cr.err + cr.out);
  const cl2 = await runCli(['sync', 'conflicts']);
  assert.ok(cl2.out.includes('暂无冲突'), '解决后应无冲突');
  const o1 = await runCli(['sync', 'logout']);
  assert.ok(o1.out.includes('已退出'), '退出应成功');
  const bad1 = await runCli(['sync', 'login', 'cli-user', 'wrongpass', syncUrl]);
  assert.equal(bad1.code, 1);
  assert.ok(bad1.out.includes('密码'), '错误密码应提示');
  // 新密码在新设备登录
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-newpw-'));
  const ln = await runCli(['sync', 'login', 'cli-user', 'newpassword456', syncUrl], { env: { MINGDAO_HOME: tempHome } });
  assert.equal(ln.code, 0, ln.err + ln.out);
  assert.ok(ln.out.includes('已登录'), '新密码登录应成功');
  fs.rmSync(tempHome, { recursive: true, force: true });
  srv.close();
  fs.rmSync(syncDir, { recursive: true, force: true });
  ok('sync CLI：登录 / 推送 / 拉取 / 状态 / 退出 / 改密 / 分享 / 冲突');
}

server.close();
fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(work, { recursive: true, force: true });
console.log(`\n端到端测试全部通过：${passed} 项 ✓`);
