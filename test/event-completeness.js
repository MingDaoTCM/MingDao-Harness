// 事件日志「完整记录消息」的独立回归套件（v0.7.0 B2-a）。
//
// 为什么单独一套：B2 要把「谁是真源」从消息数组换成事件日志。切换的前提是**任何一条写盘路径
// 都能被事件流等价重放**——而 v0.7.0 B2-a 之前，`rewriteSession()`（自动压缩 / `--resume` /
// `/clear` / CLI 全量重写）完全不写事件：`compact` 事件有，压缩后的整份消息却没有落成事件，
// 重放只能得到「首条 user + 旧基线」。这不是 replay 的 bug，是双写覆盖不全。
//
// 本套件钉死五件事：
//   ① 新增 `messages.replace`：`{messages, reason}` = 把当前派生窗口整体替换为 data.messages；
//   ② 写入侧：rewriteSession **在写盘成功之后**追加该事件，append-only、不删旧行；
//   ③ 重放侧：与 `compact` 同义，按 seq 顺序生效（replace 之前的 append 被覆盖，之后接上）；
//   ④ 旁路纪律：`eventLog=false` 完全不写；事件写失败（EACCES/EISDIR）只 warn，rewrite 照常成功；
//   ⑤ 兼容：旧日志（没有该类型）照常可读，未知 type 的跳过策略不变。
//
// 约定：`expect` 关键词就是断言原文——变异批次（batch85）靠它确认「红的是不是这条」。
//
// 运行：node test/event-completeness.js（不依赖网络）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
const E = await import(pathToFileURL(path.join(srcDir, 'session-events.js')).href);
const S = await import(pathToFileURL(path.join(srcDir, 'session.js')).href);

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-event-completeness-'));
process.env.MINGDAO_HOME = path.join(base, 'home');
fs.mkdirSync(path.join(process.env.MINGDAO_HOME, 'sessions'), { recursive: true });
delete process.env.MINGDAO_EVENT_LOG;
E.setEventLogEnabled(true);

let passed = 0;
/** @param {string} name */
const ok = (name) => {
  passed += 1;
  console.log(`  ✓ ${name}`);
};

let caseNo = 0;
/** 每个用例独立目录/文件：warn 去重与进程级修补去重都按文件路径记，不能互相干扰。 */
function newCase() {
  caseNo += 1;
  const dir = path.join(base, `case-${caseNo}`);
  fs.mkdirSync(dir, { recursive: true });
  const sessionFile = path.join(dir, 'session.jsonl');
  return { dir, sessionFile, eventFile: E.eventFileFor(sessionFile) };
}

/** @param {string} file */
function readAll(file) {
  return fs.readFileSync(file, 'utf8');
}

/** @param {string} eventFile */
function eventsOf(eventFile) {
  const read = E.readEvents(eventFile);
  assert.equal(read.ok, true, '夹具前提：事件文件必须可读');
  assert.equal(read.skipped, 0, '夹具前提：事件文件不得有坏行');
  return read.events;
}

/**
 * 核心不变量：`replayToMessages(events)` 必须与 `loadSession().messages` deepEqual。
 * @param {string} sessionFile
 * @param {string} [why]
 */
function assertReplayEqualsFile(sessionFile, why = '') {
  const loaded = S.loadSession(sessionFile).messages;
  const replay = E.replayToMessages(eventsOf(E.eventFileFor(sessionFile)));
  assert.deepEqual(replay, loaded, `重放必须与消息数组等价${why ? `（${why}）` : ''}`);
  return { loaded, replay };
}

/** @param {string} eventFile */
function lastReplace(eventFile) {
  const replaces = eventsOf(eventFile).filter((ev) => ev.type === 'messages.replace');
  return replaces.length ? replaces[replaces.length - 1] : null;
}

const sys = { role: 'system', content: 'SYS' };
const user = (/** @type {string} */ t) => ({ role: 'user', content: t });
const assistant = (/** @type {string} */ t) => ({ role: 'assistant', content: t });

// ---------------------------------------------------------------------------
// ① 类型清单：messages.replace 是公开事件类型
// ---------------------------------------------------------------------------
{
  assert.ok(E.EVENT_TYPES.includes('messages.replace'), 'EVENT_TYPES 必须包含 messages.replace');
  assert.equal(E.EVENT_TYPES.length, 13, '新增 messages.replace 后公开事件类型应为 13 类');
  ok('① 事件类型清单包含 messages.replace（13 类）');
}

// ---------------------------------------------------------------------------
// ② rewriteSession 之后事件里出现 messages.replace，data.messages 与写盘一致
// ---------------------------------------------------------------------------
{
  const { sessionFile, eventFile } = newCase();
  const first = [sys, user('u1'), assistant('a1')];
  S.appendMessages(sessionFile, first);
  const compacted = [sys, user('（以下为本会话早期内容的自动压缩摘要）')];
  S.rewriteSession(sessionFile, compacted, 'compact');

  const replace = lastReplace(eventFile);
  assert.ok(replace, 'rewriteSession 之后必须出现 messages.replace 事件');
  assert.equal(replace.type, 'messages.replace', '事件类型必须是 messages.replace');
  assert.equal(replace.data.reason, 'compact', 'reason 必须原样保留（compact）');
  const written = S.loadSession(sessionFile).messages;
  assert.deepEqual(replace.data.messages, written, 'data.messages 必须与写盘内容逐条一致');
  assert.deepEqual(written.map((m) => m.content), ['SYS', '（以下为本会话早期内容的自动压缩摘要）'], '会话文件必须已被整体替换');
  ok('② rewrite 后出现 messages.replace，data.messages 与写盘内容一致');
}

// ---------------------------------------------------------------------------
// ③ append-only：rewrite 不删/不改既有事件行
// ---------------------------------------------------------------------------
{
  const { sessionFile, eventFile } = newCase();
  S.appendMessages(sessionFile, [sys, user('u1')]);
  const before = eventsOf(eventFile);
  S.rewriteSession(sessionFile, [sys, user('压缩后')], 'compact');
  const after = eventsOf(eventFile);
  assert.ok(after.length > before.length, 'rewrite 只能追加事件，不能删行');
  assert.deepEqual(after.slice(0, before.length), before, '既有事件行必须逐字节保持不变（append-only）');
  const prevSeqs = after.slice(0, before.length).map((ev) => ev.seq);
  assert.deepEqual(prevSeqs, before.map((ev) => ev.seq), '既有事件的 seq 不得被重排/重编');
  assert.equal(after[after.length - 1].type, 'messages.replace', '新事件必须接在末尾');
  ok('③ rewrite 只追加 messages.replace，既有事件行与 seq 不变');
}

// ---------------------------------------------------------------------------
// ④ reason：compact / resume / rewrite，缺省与非法值统一回退 rewrite
// ---------------------------------------------------------------------------
{
  const { sessionFile, eventFile } = newCase();
  S.rewriteSession(sessionFile, [sys], 'compact');
  S.rewriteSession(sessionFile, [sys, user('r')], 'resume');
  S.rewriteSession(sessionFile, [sys, user('w')], 'rewrite');
  S.rewriteSession(sessionFile, [sys, user('d')]);
  S.rewriteSession(sessionFile, [sys, user('x')], 'not-a-reason');
  const reasons = eventsOf(eventFile).filter((ev) => ev.type === 'messages.replace').map((ev) => ev.data.reason);
  assert.deepEqual(reasons, ['compact', 'resume', 'rewrite', 'rewrite', 'rewrite'], 'reason 必须区分 compact/resume/rewrite，缺省或非法一律 rewrite');
  ok('④ reason 区分 compact / resume / rewrite，缺省与非法值回退 rewrite');
}

// ---------------------------------------------------------------------------
// ⑤-⑧ 混合序列（append → rewrite → append）4 组场景与 loadSession deepEqual
// ---------------------------------------------------------------------------
{
  // ⑤ 压缩：旧基线 + 新增消息被压缩后的窗口整体替换，再追加新消息
  const { sessionFile, eventFile } = newCase();
  S.appendMessages(sessionFile, [sys, user('早1'), assistant('早2')]);
  const compacted = [sys, user('（压缩摘要）')];
  S.rewriteSession(sessionFile, compacted, 'compact');
  S.appendMessages(sessionFile, [user('压缩后新问'), assistant('压缩后新答')]);
  const { loaded } = assertReplayEqualsFile(sessionFile, '压缩');
  assert.deepEqual(loaded.map((m) => m.content), ['SYS', '（压缩摘要）', '压缩后新问', '压缩后新答'], '压缩后的窗口必须是「新基线 + 后续增量」');
  const types = eventsOf(eventFile).map((ev) => ev.type);
  assert.ok(types.indexOf('messages.replace') > 0 && types.lastIndexOf('message.append') > types.indexOf('messages.replace'), 'replace 必须落在旧 append 之后、新 append 之前（按 seq）');
  ok('⑤ 混合序列·压缩：append → replace(compact) → append 与 loadSession deepEqual');
}
{
  // ⑥ resume：载入的历史文件被重写后继续追加
  const { sessionFile } = newCase();
  const loadedHistory = [sys, user('历史1'), assistant('历史2'), user('历史3')];
  S.rewriteSession(sessionFile, loadedHistory, 'resume');
  S.appendMessages(sessionFile, [assistant('恢复后的新回答')]);
  const { loaded } = assertReplayEqualsFile(sessionFile, 'resume');
  assert.deepEqual(loaded.map((m) => m.content), ['SYS', '历史1', '历史2', '历史3', '恢复后的新回答'], 'resume 重写必须保留完整历史并在其后追加');
  ok('⑥ 混合序列·resume：replace(resume) → append 与 loadSession deepEqual');
}
{
  // ⑦ 空会话 rewrite：replace 空数组 = 清空窗口，随后 append 从零开始
  const { sessionFile, eventFile } = newCase();
  S.appendMessages(sessionFile, [sys, user('将被清空')]);
  S.rewriteSession(sessionFile, [], 'rewrite');
  assert.deepEqual(S.loadSession(sessionFile).messages, [], '空会话 rewrite 必须把文件清空');
  assert.deepEqual(E.replayToMessages(eventsOf(eventFile)), [], '空数组的 messages.replace 必须把派生窗口清空');
  S.appendMessages(sessionFile, [user('清空后的第一条')]);
  assertReplayEqualsFile(sessionFile, '空会话 + 追加');
  ok('⑦ 混合序列·空会话 rewrite：replace([]) 清空窗口，后续 append 从零开始（deepEqual）');
}
{
  // ⑧ 带 tool_calls 的消息：结构字段（tool_calls / tool_call_id）必须原样进事件并重放
  const { sessionFile } = newCase();
  const toolCall = { id: 'call_c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } };
  const history = [
    sys,
    user('读文件'),
    { role: 'assistant', content: null, tool_calls: [toolCall] },
    { role: 'tool', tool_call_id: 'call_c1', content: '{"ok":true}' },
  ];
  S.rewriteSession(sessionFile, history, 'rewrite');
  S.appendMessages(sessionFile, [assistant('读完了')]);
  const { loaded, replay } = assertReplayEqualsFile(sessionFile, 'tool_calls');
  assert.deepEqual(replay[2].tool_calls, [toolCall], 'tool_calls 必须原样保留（id/name/arguments）');
  assert.equal(replay[3].tool_call_id, 'call_c1', 'tool_call_id 必须原样保留');
  assert.equal(loaded.length, 5, '带工具调用的窗口必须完整重放（5 条）');
  ok('⑧ 混合序列·tool_calls：assistant.tool_calls + tool 消息原样重放（deepEqual）');
}

// ---------------------------------------------------------------------------
// ⑨-⑩ 顺序：replace 出现在 append 之前 / 之后都能正确重放
// ---------------------------------------------------------------------------
{
  // append → replace：replace 必须**覆盖**此前的窗口，而不是当作追加
  const { sessionFile, eventFile } = newCase();
  S.appendMessages(sessionFile, [sys, user('旧窗口'), assistant('旧回答')]);
  S.rewriteSession(sessionFile, [sys, user('新窗口')], 'compact');
  const replay = E.replayToMessages(eventsOf(eventFile));
  assert.deepEqual(replay.map((m) => m.content), ['SYS', '新窗口'], 'replace 之前的 append 必须被整体替换（不得当作追加）');
  assertReplayEqualsFile(sessionFile, 'append → replace');
  ok('⑨ 顺序·append → replace：替换此前窗口（不当作追加）');
}
{
  // replace → append：replace 建立基线，之后的 append 接在它后面
  const { sessionFile, eventFile } = newCase();
  S.rewriteSession(sessionFile, [sys, user('基线')], 'resume');
  S.appendMessages(sessionFile, [assistant('增量')]);
  const replay = E.replayToMessages(eventsOf(eventFile));
  assert.deepEqual(replay.map((m) => m.content), ['SYS', '基线', '增量'], 'replace 之后到达的 append 必须接在新基线后面');
  assertReplayEqualsFile(sessionFile, 'replace → append');
  ok('⑩ 顺序·replace → append：新基线 + 后续增量');
}

// ---------------------------------------------------------------------------
// ⑪ eventLog=false：完全不写事件，但会话写入照常
// ---------------------------------------------------------------------------
{
  const { sessionFile, eventFile } = newCase();
  E.setEventLogEnabled(false);
  try {
    S.appendMessages(sessionFile, [sys, user('关闭时写入')]);
    S.rewriteSession(sessionFile, [sys, user('关闭时重写')], 'compact');
  } finally {
    E.setEventLogEnabled(true);
  }
  assert.equal(fs.existsSync(eventFile), false, 'eventLog=false 时不得创建事件侧车');
  assert.deepEqual(S.loadSession(sessionFile).messages.map((m) => m.content), ['SYS', '关闭时重写'], 'eventLog=false 不得影响会话写入');
  ok('⑪ eventLog=false：不写事件侧车，会话写入照常完成');
}

// ---------------------------------------------------------------------------
// ⑫ 事件写失败（不可写路径 / EACCES-EISDIR）：rewrite 仍成功，只 warn
// ---------------------------------------------------------------------------
{
  const { sessionFile, eventFile } = newCase();
  fs.mkdirSync(eventFile, { recursive: true }); // 事件路径被目录占住 → append 必失败（EISDIR/EPERM，等价 EACCES）
  const msgs = [sys, user('事件写不进去也要写会话')];
  /** @type {string[]} */
  const warns = [];
  const origWarn = console.warn;
  console.warn = (/** @type {any[]} */ ...args) => warns.push(args.map(String).join(' '));
  let threw = null;
  try {
    S.rewriteSession(sessionFile, msgs, 'compact');
  } catch (err) {
    threw = err;
  } finally {
    console.warn = origWarn;
  }
  assert.equal(threw, null, `事件写失败不得让 rewrite 抛异常（实际：${threw}）`);
  assert.deepEqual(S.loadSession(sessionFile).messages.map((m) => m.content), ['SYS', '事件写不进去也要写会话'], 'rewrite 必须照常成功（会话文件已落盘）');
  assert.ok(warns.some((w) => w.includes('会话事件日志写入失败')), '事件写失败必须打可见 warn（不能静默）');
  assert.equal(fs.statSync(eventFile).isDirectory(), true, '测试前提：事件路径仍是被占住的目录');
  ok('⑫ 事件写失败（EACCES/EISDIR）：rewrite 仍成功、只 warn、不抛');
}

// ---------------------------------------------------------------------------
// ⑬ 大消息不截断：整份窗口必须原样进事件
// ---------------------------------------------------------------------------
{
  const { sessionFile, eventFile } = newCase();
  const huge = `BEGIN-${'x'.repeat(200000)}-END`;
  /** @type {string[]} */
  const warns = [];
  const origWarn = console.warn;
  console.warn = (/** @type {any[]} */ ...args) => warns.push(args.map(String).join(' '));
  try {
    S.rewriteSession(sessionFile, [sys, user(huge)], 'compact');
  } finally {
    console.warn = origWarn;
  }
  assert.deepEqual(warns, [], '超过尾窗（64KB）的 messages.replace 不得被误报为写入失败');
  const replace = lastReplace(eventFile);
  assert.ok(replace, '大消息 rewrite 必须写 messages.replace');
  const stored = String(replace.data.messages[1].content);
  assert.equal(stored.length, huge.length, 'data.messages 不得被截断（长度必须一致）');
  assert.ok(stored.startsWith('BEGIN-') && stored.endsWith('-END'), '大消息的首尾都必须保留');
  assert.deepEqual(replace.data.messages, S.loadSession(sessionFile).messages, '大消息的 data.messages 必须与写盘一致');
  ok('⑬ 大消息（200KB）不截断，与写盘内容一致');
}

// ---------------------------------------------------------------------------
// ⑭ 旧日志（没有 messages.replace）仍能读：只靠 message.append 重放
// ---------------------------------------------------------------------------
{
  const { sessionFile, eventFile } = newCase();
  S.appendMessages(sessionFile, [sys, user('旧日志1'), assistant('旧日志2')]);
  assert.equal(lastReplace(eventFile), null, '测试前提：这份日志没有 messages.replace（模拟本版之前）');
  const { loaded, replay } = assertReplayEqualsFile(sessionFile, '旧日志');
  assert.deepEqual(replay.map((m) => m.content), ['SYS', '旧日志1', '旧日志2'], '没有 messages.replace 的旧日志必须继续按 message.append 重放');
  assert.equal(loaded.length, 3, '旧日志的会话读取不得受影响');
  ok('⑭ 旧日志（无 messages.replace）仍可读，按 message.append 重放');
}

// ---------------------------------------------------------------------------
// ⑮ 未知 type 的跳过策略不变：不计入事件、计入 skipped
// ---------------------------------------------------------------------------
{
  const { sessionFile, eventFile } = newCase();
  S.appendMessages(sessionFile, [sys, user('未知类型前的消息')]);
  const before = eventsOf(eventFile);
  fs.appendFileSync(eventFile, `${JSON.stringify({ seq: 999, time: Date.now(), type: 'future.unknown', data: { x: 1 } })}\n`);
  const read = E.readEvents(eventFile);
  assert.equal(read.ok, true, '未知 type 不得让读取失败');
  assert.equal(read.skipped, 1, '未知 type 必须计入 skipped（可见，不静默丢）');
  assert.deepEqual(read.events, before, '未知 type 不得进入事件流');
  const loaded = fs.readFileSync(sessionFile, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  assert.deepEqual(E.replayToMessages(read.events), loaded, '未知 type 行存在时，重放仍必须与消息数组等价');
  ok('⑮ 未知 type 仍按旧策略跳过并计入 skipped（兼容不回退）');
}

// ---------------------------------------------------------------------------
// ⑯ 顺序保证：会话文件写失败时连事件都不写（不是「事件先行」）
// ---------------------------------------------------------------------------
{
  const { sessionFile, eventFile } = newCase();
  fs.mkdirSync(sessionFile, { recursive: true }); // 会话路径被目录占住 → 原子重写必然失败；事件侧车路径仍可写
  let threw = false;
  try {
    S.rewriteSession(sessionFile, [sys], 'compact');
  } catch {
    threw = true;
  }
  assert.equal(threw, true, '会话文件不可写时会话写盘必须失败（测试前提）');
  assert.equal(fs.existsSync(eventFile), false, '会话写盘失败时不得留下 messages.replace（事件必须在写盘成功之后）');
  ok('⑯ 会话写盘失败时完全不写事件（双写在写盘成功之后）');
}

// ---------------------------------------------------------------------------
// ⑰ 重放是纯函数：不修改事件入参
// ---------------------------------------------------------------------------
{
  const { sessionFile, eventFile } = newCase();
  S.appendMessages(sessionFile, [sys, user('u')]);
  S.rewriteSession(sessionFile, [sys, user('v')], 'compact');
  const events = eventsOf(eventFile);
  const snapshot = JSON.stringify(events);
  const replay = E.replayToMessages(events);
  assert.equal(JSON.stringify(events), snapshot, 'replayToMessages 不得修改事件入参');
  replay.push(user('外部修改'));
  assert.equal(JSON.stringify(events), snapshot, '重放结果必须是副本，改它不得反向污染事件');
  ok('⑰ replayToMessages 是纯函数（不改事件入参，返回副本）');
}

console.log(`\n事件完整性：${passed} 项全部通过`);
process.exit(0);
