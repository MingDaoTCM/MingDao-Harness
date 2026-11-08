// 造 0.7.0「事件为真源」翻默认所需的**真实会话样本**，并当场对拍 + 双读交叉验证。
//
// 为什么需要：`config.eventSource` 从 messages 翻到 events（v0.7.0 B2-b），必须证明「事件重放 ==
// 消息数组」在**工具调用 / 自动压缩 / 手动 /compact / resume 继续**这四类真实写入路径上都成立。
// 手上只有 1 个 format=2 的真实会话，样本太薄。本脚本用仓库既有的「桩 provider」手法
// （HTTP SSE mock，见 test/e2e-web.js）驱动**真实 CLI/REPL**，让真实会话落盘——不是手写
// .jsonl 冒充。
//
// 用法：
//   node scripts/make-event-fixtures.mjs          # 造样本 → 对拍 → 双读交叉验证（保留临时目录）
//   node scripts/make-event-fixtures.mjs --rm     # 成功后删除临时目录
// 退出码：0 = 四类样本全部 pass 且两种 eventSource 读取 deepEqual；1 = 有回归/覆盖缺失。
//
// 纪律：MINGDAO_HOME 一律指向 os.tmpdir() 下的临时目录，**绝不触碰 ~/.mingdao**。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'src', 'cli.js');
const parityScript = path.join(root, 'scripts', 'event-parity.mjs');
const keepHome = !process.argv.includes('--rm');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-event-fixtures-'));
const workdir = path.join(home, 'work');
fs.mkdirSync(workdir, { recursive: true });
fs.writeFileSync(path.join(workdir, 'hello.txt'), '你好，事件真源。\nhello event source.\n');

// ---------------------------------------------------------------------------
// 桩 provider：真实 HTTP + SSE。mode 由当前阶段的 fixture 决定（脚本串行执行）。
//   · 摘要请求（tools=[]）→ 返回 {"summary": ...}（compactConversation 的 JSON 口径）
//   · tool 模式第一枪 → read 工具调用；看到 tool 消息后 → 普通文本收尾
//   · 其它 → 普通文本（auto 模式故意很长，用来逼出自动压缩）
// ---------------------------------------------------------------------------
let mode = 'tool';
let requests = 0;
const longReply = (/** @type {number} */ i) =>
  `第 ${i} 轮长回复：\n` + '这是一段用于累积上下文的填充内容，包含步骤、结论与文件说明。'.repeat(400);
const mediumReply = (/** @type {number} */ i) => `第 ${i} 轮回复：` + '简短结论。'.repeat(60);

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    requests += 1;
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch {}
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    const sse = (/** @type {any} */ payload) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      res.end('data: [DONE]\n\n');
    };
    const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
    // 压缩摘要请求：tools 为空（与 test/e2e-web.js 同一识别口径）
    if (!tools.length) {
      return sse({ choices: [{ delta: { content: JSON.stringify({ summary: `【${mode}】早期对话摘要：用户目标与已完成的步骤。` }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 20 } });
    }
    const hasToolMsg = messages.some((/** @type {any} */ m) => m?.role === 'tool');
    if (mode === 'tool' && !hasToolMsg) {
      return sse({
        choices: [{
          delta: {
            tool_calls: [{ index: 0, id: 'call_read_hello', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'hello.txt' }) } }],
            finish_reason: 'tool_calls',
          },
        }],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      });
    }
    const i = requests;
    const text = mode === 'autocompact' ? longReply(i) : mode === 'tool' ? '已读到 hello.txt：你好，事件真源。' : mediumReply(i);
    sse({ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}/v1`;

function writeConfig() {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    provider: 'custom',
    model: 'mock-model',
    baseUrl,
    permission: 'auto',
    sandbox: 'off',
    contextBudget: 12000,
    autoCompact: true,
    autoTitle: false,
    autoMemory: false,
    autoProjectMemory: false,
    customModels: {
      'mock-model': { baseUrl, local: true, contextWindow: 131072, maxOutputTokens: 8192 },
    },
  }, null, 2));
  fs.writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({ custom: 'sk-test-' + 'x'.repeat(20) }), { mode: 0o600 });
}
writeConfig();

const env = { ...process.env, MINGDAO_HOME: home, MINGDAO_NO_WEB_AUTOSTART: '1', NO_COLOR: '1' };
/** 运行真实 CLI/REPL。stdinLines 非 null = 交互式 REPL（管道喂命令）。 */
function runCli(/** @type {string[]} */ args, /** @type {string[]|null} */ stdinLines = null, /** @type {number} */ timeoutMs = 120000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: workdir, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    if (stdinLines) child.stdin.end(stdinLines.join('\n') + '\n');
    else child.stdin.end();
  });
}

function sessionFiles() {
  const dir = path.join(home, 'sessions');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl') && !f.includes('.events.')).sort().map((f) => path.join(dir, f)).sort();
}

const fixtures = /** @type {any[]} */ ([]);
function record(name, file, extra = {}) {
  fixtures.push({ name, file, ...extra });
  console.log(`  ✓ 样本 ${name}：${path.basename(file)}（${fs.readFileSync(file, 'utf8').trim().split('\n').length} 条消息）`);
}

// ① 工具调用：单次提问，真实 agent 执行 read 工具往返
{
  mode = 'tool';
  const before = new Set(sessionFiles());
  const r = await runCli(['请读取 hello.txt 并复述内容（只读，不要修改任何文件）']);
  const added = sessionFiles().filter((f) => !before.has(f));
  assert.equal(r.code, 0, `工具样本 CLI 失败：${r.stderr || r.stdout}`);
  assert.equal(added.length, 1, '工具样本必须恰好新建 1 个会话');
  const msgs = fs.readFileSync(added[0], 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(msgs.some((m) => m.role === 'tool'), '工具样本必须含真实 tool 消息');
  record('① 工具调用（read 往返）', added[0], { tool: true });
}

// ② 自动压缩：REPL 长对话 + 小 contextBudget，逼出 compact
{
  mode = 'autocompact';
  const before = new Set(sessionFiles());
  const r = await runCli([], [
    '第一轮：请记录长对话目标，并给出很长的细节回复。',
    '第二轮：请继续补充，保持很长的回复。',
    '第三轮：请收尾。',
    '/exit',
  ]);
  const added = sessionFiles().filter((f) => !before.has(f));
  assert.equal(r.code, 0, `自动压缩样本 REPL 失败：${r.stderr || r.stdout}`);
  assert.equal(added.length, 1, '自动压缩样本必须恰好新建 1 个会话');
  const raw = fs.readFileSync(added[0], 'utf8');
  assert.ok(raw.includes('<conversation_summary>'), '自动压缩样本必须真的压缩过（缺 <conversation_summary>）');
  assert.match(r.stdout, /自动压缩上下文/, '自动压缩日志缺失');
  record('② 自动压缩（autoCompact + contextBudget=12000）', added[0], { compact: true });
}

// ③ 手动 /compact：REPL 跑 3 轮（7 条消息 > 6）后输入 /compact
{
  mode = 'manual';
  const before = new Set(sessionFiles());
  const r = await runCli([], [
    '第三类样本第一轮：记住暗号 MANUAL-COMPACT。',
    '第三类样本第二轮：补充一个细节。',
    '第三类样本第三轮：再补充一个细节。',
    '/compact',
    '/exit',
  ]);
  const added = sessionFiles().filter((f) => !before.has(f));
  assert.equal(r.code, 0, `手动压缩样本 REPL 失败：${r.stderr || r.stdout}`);
  assert.equal(added.length, 1, '手动压缩样本必须恰好新建 1 个会话');
  assert.match(r.stdout, /已压缩上下文/, '手动 /compact 未生效');
  assert.ok(fs.readFileSync(added[0], 'utf8').includes('<conversation_summary>'), '手动压缩样本必须写入摘要基线');
  record('③ 手动 /compact（REPL 命令）', added[0], { compact: true, manual: true });
}

// ④ resume 后继续：先 REPL 跑一轮退出，再用 -c（--continue，resume 等价位）继续一轮
{
  mode = 'resume';
  const before = new Set(sessionFiles());
  const r1 = await runCli([], ['第四类样本第一轮：记住暗号 RESUME-42，然后退出。', '/exit']);
  const added = sessionFiles().filter((f) => !before.has(f));
  assert.equal(r1.code, 0, `resume 第一轮失败：${r1.stderr || r1.stdout}`);
  assert.equal(added.length, 1, 'resume 第一轮必须恰好新建 1 个会话');
  const r2 = await runCli(['-c'], ['第四类样本第二轮：继续，复述暗号 RESUME-42。', '/exit']);
  const after = sessionFiles().filter((f) => !before.has(f));
  assert.equal(r2.code, 0, `resume 第二轮失败：${r2.stderr || r2.stdout}`);
  assert.equal(after.length, 1, 'resume 第二轮不得新建会话（必须续写同一个）');
  const msgs = fs.readFileSync(after[0], 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(msgs.filter((m) => m.role === 'user').length >= 2, 'resume 样本必须含两轮用户消息');
  record('④ resume 后继续（-c）', after[0], { resume: true });
}

server.close();

// ---------------------------------------------------------------------------
// 证据 1：事件侧车格式戳（每类都必须是 format=2）
// ---------------------------------------------------------------------------
console.log('\n[1/3] 事件侧车格式戳');
const { eventFileFor, readEvents, EVENT_LOG_FORMAT } = await import(pathToFileURL(path.join(root, 'src', 'session-events.js')).href);
for (const f of fixtures) {
  const evFile = eventFileFor(f.file);
  assert.ok(evFile && fs.existsSync(evFile), `${f.name} 缺事件侧车`);
  const read = readEvents(evFile);
  assert.ok(read.ok, `${f.name} 事件日志读取失败`);
  const start = read.events.find((/** @type {any} */ e) => e.type === 'session.start');
  assert.equal(Number(start?.data?.format), EVENT_LOG_FORMAT, `${f.name} 的 session.start.format 必须是 ${EVENT_LOG_FORMAT}`);
  f.eventCount = read.events.length;
  console.log(`  ✓ ${f.name}：format=${EVENT_LOG_FORMAT} · 事件 ${read.events.length} 条`);
}

// ---------------------------------------------------------------------------
// 证据 2：官方对拍工具（子进程跑真实 CLI，输出原样展示）
// ---------------------------------------------------------------------------
console.log('\n[2/3] node scripts/event-parity.mjs --home <临时目录> --verbose');
const parity = spawnSync(process.execPath, [parityScript, '--home', home, '--verbose'], { encoding: 'utf8' });
process.stdout.write(parity.stdout);
if (parity.stderr) process.stderr.write(parity.stderr);
assert.equal(parity.status, 0, '对拍工具必须 exit 0（无 fail）');
assert.match(parity.stdout, /等价 4/, '必须 4 个 pass');
assert.match(parity.stdout, /不可回溯 0/, '必须 0 个 incomplete');
assert.match(parity.stdout, /不一致 0/, '必须 0 个 fail');

// ---------------------------------------------------------------------------
// 证据 3：eventSource 两模式 deepEqual（翻转开关后读出来的必须一模一样）
// ---------------------------------------------------------------------------
console.log('\n[3/3] loadSession 双读交叉验证（messages vs events）');
const { loadSession } = await import(pathToFileURL(path.join(root, 'src', 'session.js')).href);
let equalCount = 0;
for (const f of fixtures) {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  let byMessages;
  let byEvents;
  try {
    // 默认已翻成 events：这里显式锁 messages，双读才仍然比较「旧真源 vs 新真源」。
    byMessages = loadSession(f.file, { eventSource: 'messages' });
    byEvents = loadSession(f.file, { eventSource: 'events' });
  } finally {
    console.warn = origWarn;
  }
  assert.deepStrictEqual(byEvents.messages, byMessages.messages, `${f.name}：eventSource=events 与 messages 必须 deepEqual`);
  assert.equal(warnings.length, 0, `${f.name}：events 模式不得回退 warn（${warnings.join(' | ')}）`);
  equalCount += 1;
  console.log(`  ✓ ${f.name}：deepEqual 通过（${byMessages.messages.length} 条）`);
}

console.log(`\n结论：pass=4 / incomplete=0 / fail=0；双读 deepEqual ${equalCount}/4。`);
console.log(`临时 MINGDAO_HOME：${home}`);
if (keepHome) console.log('（默认保留临时目录供复查；加 --rm 可在成功后删除。）');
else {
  fs.rmSync(home, { recursive: true, force: true });
  console.log('（已按 --rm 删除临时目录。）');
}
