// 「以事件为源」（v0.7.0 B2-b）的独立回归套件。
//
// 本版**已翻默认**：`loadSession(file)` 默认 `events`，但必须满足三条硬性质：
//   ① 对拍一致才采用：派生结果与 `.jsonl` 消息数组逐条等价才返回派生值；
//   ② 对拍不一致必须回退：warn 一行（带文件 + 首个差异位置）后返回消息数组，绝不采用派生；
//   ③ 不可回溯/读失败静默回退：无侧车 / 格式戳缺失或过旧 / 事件日志读失败，一律不 warn
//      （旧会话是常态，刷 warn 会把真正的对拍回归淹掉）。
//
// 优先级（v0.7.0 默认翻转 + 运维回退）：
//   `MINGDAO_EVENT_SOURCE`（环境变量） > `config.eventSource`（配置文件/直接传 cfg） > 默认 `events`。
//   · 环境变量只认精确的 `messages` / `events`；非法值**不**回落 messages，视为「未设」继续走配置/默认。
//   · 环境变量只在读取时生效，不落盘：撤销变量即恢复配置文件里的值。
//
// 约定：`expect` 关键词就是断言原文——变异批次（batch86）靠它确认「红的是不是这条」。
//
// 运行：node test/event-source.js（不依赖网络）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-event-source-'));
process.env.MINGDAO_HOME = path.join(base, 'home');
fs.mkdirSync(path.join(process.env.MINGDAO_HOME, 'sessions'), { recursive: true });
delete process.env.MINGDAO_EVENT_LOG;
delete process.env.MINGDAO_EVENT_SOURCE;

const E = await import(pathToFileURL(path.join(root, 'src/session-events.js')).href);
const S = await import(pathToFileURL(path.join(root, 'src/session.js')).href);
const C = await import(pathToFileURL(path.join(root, 'src/config.js')).href);
E.setEventLogEnabled(true);

let passed = 0;
/** @param {string} name */
const ok = (name) => {
  passed += 1;
  console.log(`  ✓ ${name}`);
};

let caseNo = 0;
/** 每个用例独立目录/文件：repairSessionEvents 的进程内去重按文件路径记，不能互相干扰。 */
function fixture(messages, events = null, { eventAsDir = false } = {}) {
  caseNo += 1;
  const dir = path.join(base, `case-${caseNo}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, messages.map((m) => JSON.stringify(m)).join('\n') + (messages.length ? '\n' : ''));
  const eventFile = E.eventFileFor(file);
  if (eventAsDir) fs.mkdirSync(eventFile, { recursive: true });
  else if (events) fs.writeFileSync(eventFile, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { file, eventFile, messages };
}

/** 捕获一次调用里的 console.warn（同时返回结果）。 */
function withWarns(fn) {
  const warns = [];
  const orig = console.warn;
  console.warn = (...args) => { warns.push(args.map((a) => String(a)).join(' ')); };
  try {
    const result = fn();
    return { result, warns };
  } finally {
    console.warn = orig;
  }
}

/** 临时设置 `MINGDAO_EVENT_SOURCE`（`undefined` = 删除），结束后原样恢复。 */
function withEnv(value, fn) {
  const prev = process.env.MINGDAO_EVENT_SOURCE;
  if (value === undefined) delete process.env.MINGDAO_EVENT_SOURCE;
  else process.env.MINGDAO_EVENT_SOURCE = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.MINGDAO_EVENT_SOURCE;
    else process.env.MINGDAO_EVENT_SOURCE = prev;
  }
}

const START = (format = 2) => ({ seq: 1, time: 1, type: 'session.start', data: { session: 's.jsonl', ...(format == null ? {} : { format }) } });
const APPEND = (seq, message) => ({ seq, time: seq, type: 'message.append', data: { message } });
const HI = { role: 'user', content: 'hi' };
const HELLO = { role: 'assistant', content: 'hello' };
const WRONG = { role: 'assistant', content: 'WRONG' };

// ① 默认（不传 cfg、不设环境变量）= events：新格式且对拍一致 → 采用事件派生的新数组。
{
  const { file } = fixture([HI, HELLO], [START(), APPEND(2, HI), APPEND(3, HELLO)]);
  const { result, warns } = withWarns(() => S.loadSession(file));
  assert.equal(Object.keys(result).join(','), 'file,messages', '默认返回形状必须仍是 {file, messages}（不得新增字段）');
  assert.equal(warns.length, 0, '默认（不传 cfg）events 模式对拍一致时不得 warn');
  assert.deepEqual(result.messages, [HI, HELLO], '默认（不传 cfg）新格式会话必须采用事件派生结果');
  assert.equal(JSON.stringify(result), JSON.stringify({ file, messages: [HI, HELLO] }), '默认返回值与消息数组逐字节一致');
  ok('① 默认（不传 cfg）= events：新格式采用派生结果、形状不变');
}

// ② 默认遇到「新格式但不一致」的事件日志：warn（含回退与差异位置）后回退消息数组。
{
  const { file } = fixture([HI, HELLO], [START(), APPEND(2, HI), APPEND(3, WRONG)]);
  const { result, warns } = withWarns(() => S.loadSession(file));
  assert.deepEqual(result.messages, [HI, HELLO], '默认 events 模式下对拍不一致必须回退到消息数组（不得采用派生结果）');
  assert.equal(warns.length, 1, '默认 events 模式下对拍不一致必须 warn 一条');
  assert.ok(warns[0].includes(file), '默认回退 warn 必须带会话文件路径');
  assert.match(warns[0], /回退/, '默认回退 warn 必须写明「回退」');
  assert.match(warns[0], /差异位置：第 2 条/, '默认回退 warn 必须带文件与首个差异位置');
  ok('② 默认 events + 不一致：回退消息数组并 warn（含差异位置）');
}

// ③ 默认 + 旧格式（format=1）：必须静默回退——旧日志没有 rewrite 记录，永远不能拿来派生。
{
  const { file } = fixture([HI, HELLO], [START(1), APPEND(2, HI)]);
  const { result, warns } = withWarns(() => S.loadSession(file));
  assert.deepEqual(result.messages, [HI, HELLO], '默认 events 模式下旧格式（format=1）必须静默回退到消息数组');
  assert.equal(warns.length, 0, '默认 events 模式下旧格式（format=1）必须静默回退，不得 warn');
  ok('③ 默认 events + 旧格式（format=1）：静默回退、零 warn');
}

// ④ 默认 + 无事件侧车：静默回退（旧会话的常态）。
{
  const { file } = fixture([HI, HELLO]);
  const { result, warns } = withWarns(() => S.loadSession(file));
  assert.deepEqual(result.messages, [HI, HELLO], '默认 events 模式下无事件侧车必须静默回退');
  assert.equal(warns.length, 0, '默认 events 模式下无事件侧车必须静默回退');
  ok('④ 默认 events + 无事件侧车：静默回退、零 warn');
}

// ⑤ 显式 messages：与 0.6.x 逐字节一致；事件日志存在且不一致也不读、不 warn。
{
  const { file } = fixture([HI, HELLO], [START(), APPEND(2, HI), APPEND(3, WRONG)]);
  const { result, warns } = withWarns(() => S.loadSession(file, { eventSource: 'messages' }));
  assert.equal(JSON.stringify(result), JSON.stringify({ file, messages: [HI, HELLO] }), 'eventSource=messages 必须与 0.6.x 逐字节一致');
  assert.equal(warns.length, 0, 'eventSource=messages 不得读事件源、不得 warn');
  ok('⑤ 显式 messages：逐字节一致、零 warn（事件不一致也不读）');
}

// ⑥ events + 对拍一致：返回派生结果（与消息数组 deepEqual）。
{
  const { file } = fixture([HI, HELLO], [START(), APPEND(2, HI), APPEND(3, HELLO)]);
  const { result, warns } = withWarns(() => S.loadSession(file, { eventSource: 'events' }));
  assert.equal(warns.length, 0, '对拍一致时不得 warn');
  assert.deepEqual(result.messages, [HI, HELLO], 'eventSource=events 且对拍一致时必须采用派生结果');
  assert.deepEqual(result, { file, messages: [HI, HELLO] }, 'events 模式返回形状必须仍是 {file, messages}');
  ok('⑥ events + 对拍一致：采用派生结果');
}

// ⑦ events + 内容不一致：返回消息数组；warn 必须带「回退」与差异位置（第 2 条）。
{
  const { file } = fixture([HI, HELLO], [START(), APPEND(2, HI), APPEND(3, WRONG)]);
  const { result, warns } = withWarns(() => S.loadSession(file, { eventSource: 'events' }));
  assert.deepEqual(result.messages, [HI, HELLO], '对拍不一致必须回退到消息数组（不得采用派生结果）');
  assert.equal(warns.length, 1, '对拍不一致必须 warn 一条（含回退与差异位置）');
  assert.ok(warns[0].includes(file), '回退 warn 必须带会话文件路径');
  assert.match(warns[0], /回退/, '回退 warn 必须写明「回退」');
  assert.match(warns[0], /差异位置：第 2 条/, '回退 warn 必须带文件与首个差异位置');
  ok('⑦ events + 内容不一致：回退消息数组并 warn（含差异位置）');
}

// ⑧ events + 条数不同：同样回退，差异位置指向首个缺失/多余条。
{
  const { file } = fixture([HI, HELLO], [START(), APPEND(2, HI)]);
  const { result, warns } = withWarns(() => S.loadSession(file, { eventSource: 'events' }));
  assert.deepEqual(result.messages, [HI, HELLO], '条数不同也必须回退到消息数组（不得采用派生结果）');
  assert.equal(warns.length, 1, '条数不同必须 warn 一条');
  assert.match(warns[0], /差异位置：第 2 条/, '条数不同也必须回退且差异位置指向首个缺失/多余条');
  ok('⑧ events + 条数不同：回退并报首个差异位置');
}

// ⑨ 格式戳缺失（旧日志 / 只写了 message.append）：静默回退，不 warn。
//    故意让事件内容与文件不一致：若误把「无格式戳」当可回溯，就会先派生再 warn。
{
  const { file } = fixture([HI, HELLO], [APPEND(1, HI)]);
  const { result, warns } = withWarns(() => S.loadSession(file, { eventSource: 'events' }));
  assert.deepEqual(result.messages, [HI, HELLO], '格式戳缺失必须静默回退到消息数组（不得采用派生）');
  assert.equal(warns.length, 0, '格式戳缺失必须静默回退到消息数组（不得采用派生）');
  ok('⑨ 格式戳缺失：静默回退、零 warn');
}

// ⑩ 旧格式（format=1）：同样静默回退（历史噪声，不刷 warn）。
{
  const { file } = fixture([HI, HELLO], [START(1), APPEND(2, HI)]);
  const { result, warns } = withWarns(() => S.loadSession(file, { eventSource: 'events' }));
  assert.deepEqual(result.messages, [HI, HELLO], '旧格式必须静默回退到消息数组（不得采用派生）');
  assert.equal(warns.length, 0, '旧格式（format=1）必须静默回退，不得 warn');
  ok('⑩ 旧格式（format=1）：静默回退、零 warn');
}

// ⑪ 无事件侧车：静默回退（旧会话的常态）。
{
  const { file } = fixture([HI, HELLO]);
  const { result, warns } = withWarns(() => S.loadSession(file, { eventSource: 'events' }));
  assert.deepEqual(result.messages, [HI, HELLO], '无事件侧车必须静默回退');
  assert.equal(warns.length, 0, '无事件侧车必须静默回退');
  ok('⑪ 无事件侧车：静默回退、零 warn');
}

// ⑫ 事件文件半行损坏（torn）：回退且不崩；对拍 warn 里仍要有「回退」。
{
  const dir = path.join(base, `case-${++caseNo}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 's.jsonl');
  const eventFile = E.eventFileFor(file);
  fs.writeFileSync(file, [HI, HELLO].map((m) => JSON.stringify(m)).join('\n') + '\n');
  const lines = [START(), APPEND(2, HI), '{"seq":3,"time":3,"type":"message.append","data":{"message"'];
  fs.writeFileSync(eventFile, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  let result;
  let err = null;
  const warns = [];
  const orig = console.warn;
  console.warn = (...args) => { warns.push(args.map((a) => String(a)).join(' ')); };
  try {
    result = S.loadSession(file, { eventSource: 'events' });
  } catch (e) {
    err = e;
  } finally {
    console.warn = orig;
  }
  assert.equal(err, null, '事件文件半行损坏必须回退且不崩');
  assert.deepEqual(result.messages, [HI, HELLO], '事件文件半行损坏必须回退且不崩');
  assert.ok(warns.some((w) => w.includes('回退')), '事件文件半行损坏必须回退且不崩（warn 含「回退」）');
  ok('⑫ 事件文件半行损坏（torn）：回退、不崩');
}

// ⑬ 事件日志读失败（侧车是目录）：静默回退、不抛异常。
//    用 eventLog:false 让 repairSessionEvents 也跳过，隔离出「读取本身不 warn」。
{
  const { file } = fixture([HI, HELLO], null, { eventAsDir: true });
  let result;
  let err = null;
  let warns = [];
  try {
    const cap = withWarns(() => S.loadSession(file, { eventSource: 'events', eventLog: false }));
    result = cap.result;
    warns = cap.warns;
  } catch (e) {
    err = e;
  }
  assert.equal(err, null, '事件日志读失败必须静默回退，不得抛异常');
  assert.deepEqual(result.messages, [HI, HELLO], '事件日志读失败必须静默回退');
  assert.equal(warns.length, 0, '事件日志读失败必须静默回退');
  ok('⑬ 事件日志读失败（EISDIR）：静默回退、不抛');
}

// ⑭ messages.replace 之后的 append：派生按事件顺序包含新消息，且与消息文件一致。
{
  const messages = [{ role: 'system', content: 'S' }, HI, { role: 'assistant', content: 'new' }];
  const events = [
    START(),
    APPEND(2, HI),
    { seq: 3, time: 3, type: 'messages.replace', data: { messages: [{ role: 'system', content: 'S' }, HI], reason: 'compact' } },
    APPEND(4, { role: 'assistant', content: 'new' }),
  ];
  const { file } = fixture(messages, events);
  const { result, warns } = withWarns(() => S.loadSession(file, { eventSource: 'events' }));
  assert.equal(warns.length, 0, 'messages.replace 之后 append 必须对拍一致、零 warn');
  assert.deepEqual(result.messages, messages, 'messages.replace 之后的 append 必须按事件顺序进入派生结果');
  ok('⑭ messages.replace 后 append：派生包含新消息');
}

// ⑮ cfg 非法值（拼错 / 大小写不符）：按默认 events 处理（不是回落 messages），进入对拍分支。
{
  const { file } = fixture([HI, HELLO], [START(), APPEND(2, HI), APPEND(3, WRONG)]);
  assert.equal(C.normalizeEventSource('bogus'), 'events', 'cfg 非法（eventSource=bogus）必须按默认 events 归一化');
  const bogus = withWarns(() => S.loadSession(file, { eventSource: 'bogus' }));
  assert.deepEqual(bogus.result.messages, [HI, HELLO], 'cfg 非法（eventSource=bogus）必须按默认 events 回退到消息数组');
  assert.equal(bogus.warns.length, 1, 'cfg 非法（eventSource=bogus）必须按默认 events 进入对拍分支并 warn');
  const upper = withWarns(() => S.loadSession(file, { eventSource: 'EVENTS' }));
  assert.deepEqual(upper.result.messages, [HI, HELLO], '大小写不符的 eventSource 必须按默认 events 回退到消息数组');
  assert.equal(upper.warns.length, 1, '大小写不符的 eventSource 必须按默认 events 进入对拍分支并 warn');
  ok('⑮ cfg 非法值：按默认 events 处理（不回落 messages）');
}

// ⑯ 返回值形状与 repairSessionEvents 的副作用不变：events 模式下仍修补悬空 tool.start。
{
  const assistant = { role: 'assistant', content: 'calling', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'x', arguments: '{}' } }] };
  const { file, eventFile } = fixture([assistant], [START(), APPEND(2, assistant), { seq: 3, time: 3, type: 'tool.start', data: { callId: 'tc1', name: 'x' } }]);
  const before = E.readEvents(eventFile).events.length;
  const r = S.loadSession(file, { eventSource: 'events' });
  const after = E.readEvents(eventFile).events.length;
  assert.equal(Object.keys(r).join(','), 'file,messages', '返回值形状与 repairSessionEvents 副作用不变（形状仍是 file/messages）');
  assert.equal(after, before + 1, '返回值形状与 repairSessionEvents 副作用不变（悬空 tool.start 必须被补一条 tool.end）');
  ok('⑯ 返回值形状不变 + repair 副作用仍在');
}

// ⑰ 派生结果必须深拷贝：修改返回值不得污染事件数据（否则同进程缓存/复用会串）。
{
  const events = [APPEND(1, { role: 'user', content: 'hi' })];
  const replay = E.replayToMessages(events);
  replay[0].content = 'polluted';
  assert.equal(events[0].data.message.content, 'hi', '派生结果必须深拷贝，修改它不得污染事件数据');
  ok('⑰ 派生结果深拷贝：不污染事件数据');
}

// ⑱ 配置归一化（不设环境变量）：合法值原样；非法/缺省回落默认 events。
{
  withEnv(undefined, () => {
    assert.equal(C.normalizeEventSource('events'), 'events', '配置归一化：合法 events 原样返回');
    assert.equal(C.normalizeEventSource('messages'), 'messages', '配置归一化：合法 messages 原样返回（配置优先于默认）');
    assert.equal(C.normalizeEventSource('bogus'), 'events', '配置归一化：非法值回落默认 events');
    assert.equal(C.normalizeEventSource(undefined), 'events', '配置归一化：缺省回落默认 events');
    assert.equal(C.DEFAULT_EVENT_SOURCE, 'events', '默认真源必须是 events（证据见 docs/EVENT-SOURCE-EVIDENCE.md）');
  });
  ok('⑱ 配置归一化与默认值（默认 events）');
}

// ⑲ 空事件文件（0 字节）：无格式戳，静默回退。
{
  const { file } = fixture([HI, HELLO], []);
  const { result, warns } = withWarns(() => S.loadSession(file, { eventSource: 'events' }));
  assert.deepEqual(result.messages, [HI, HELLO], '空事件文件（无格式戳）必须静默回退');
  assert.equal(warns.length, 0, '空事件文件（无格式戳）必须静默回退');
  ok('⑲ 空事件文件：静默回退、零 warn');
}

// ⑳ events 模式对拍一致时，返回值与文件消息数组等价（派生路径不改变可观察内容）。
{
  const messages = [HI, HELLO];
  const { file } = fixture(messages, [START(), APPEND(2, HI), APPEND(3, HELLO)]);
  const r = S.loadSession(file, { eventSource: 'events' });
  assert.deepEqual(r.messages, messages, 'events 模式返回的派生数组必须与消息数组等价');
  ok('⑳ events 模式返回消息数组（与文件消息值等价）');
}

// ㉑ 配置读取/写回路径也归一化：默认翻转后，非法 eventSource 落盘值必须是默认 events。
{
  const cfgFile = path.join(process.env.MINGDAO_HOME, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ provider: 'deepseek', eventSource: 'bogus' }));
  const loaded = C.loadConfig();
  assert.equal(loaded.eventSource, 'events', '配置读取路径必须把非法 eventSource 归一化为默认 events');
  const saved = C.saveConfig({ provider: 'deepseek', eventSource: 'bogus' });
  assert.equal(saved.ok, true, '配置写回路径必须成功');
  const onDisk = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  assert.equal(onDisk.eventSource, 'events', '配置写回路径不得把非法 eventSource 落盘（必须是默认 events）');
  ok('㉑ 配置读取/写回路径归一化为默认 events');
}

// ㉒ MINGDAO_EVENT_SOURCE=messages：回到旧行为——不读事件源、返回文件消息数组（字节级一致）。
{
  const { file } = fixture([HI, HELLO], [START(), APPEND(2, HI), APPEND(3, WRONG)]);
  const { result, warns } = withEnv('messages', () => withWarns(() => S.loadSession(file)));
  assert.equal(warns.length, 0, 'MINGDAO_EVENT_SOURCE=messages 必须退回旧行为（不得读事件源、不得 warn）');
  assert.equal(JSON.stringify(result), JSON.stringify({ file, messages: [HI, HELLO] }), 'MINGDAO_EVENT_SOURCE=messages 必须退回旧行为（字节级一致）');
  ok('㉒ MINGDAO_EVENT_SOURCE=messages：退回旧行为、零 warn');
}

// ㉓ 环境变量 > 配置文件（组合一）：env=messages 压过 config=events。
{
  const { file } = fixture([HI, HELLO], [START(), APPEND(2, HI), APPEND(3, WRONG)]);
  const { result, warns } = withEnv('messages', () => withWarns(() => S.loadSession(file, { eventSource: 'events' })));
  assert.equal(warns.length, 0, 'MINGDAO_EVENT_SOURCE=messages 必须优先于配置文件 eventSource=events（不得 warn）');
  assert.deepEqual(result.messages, [HI, HELLO], 'MINGDAO_EVENT_SOURCE=messages 必须优先于配置文件 eventSource=events');
  assert.equal(withEnv('messages', () => C.normalizeEventSource('events')), 'messages', '归一化：环境变量必须优先于配置文件');
  ok('㉓ 环境变量优先于配置文件：env=messages / config=events → messages');
}

// ㉔ 环境变量 > 配置文件（组合二）：env=events 压过 config=messages。
{
  const { file } = fixture([HI, HELLO], [START(), APPEND(2, HI), APPEND(3, WRONG)]);
  const { result, warns } = withEnv('events', () => withWarns(() => S.loadSession(file, { eventSource: 'messages' })));
  assert.equal(warns.length, 1, 'MINGDAO_EVENT_SOURCE=events 必须优先于配置文件 eventSource=messages（进入对拍分支并 warn）');
  assert.deepEqual(result.messages, [HI, HELLO], '环境变量强制 events 后对拍不一致仍必须回退消息数组');
  assert.equal(withEnv('events', () => C.normalizeEventSource('messages')), 'events', '归一化：环境变量必须优先于配置文件');
  ok('㉔ 环境变量优先于配置文件：env=events / config=messages → events');
}

// ㉕ MINGDAO_EVENT_SOURCE=bogus：当作「未设」，继续走默认 events——不是回落 messages。
{
  const { file } = fixture([HI, HELLO], [START(), APPEND(2, HI), APPEND(3, WRONG)]);
  const { result, warns } = withEnv('bogus', () => withWarns(() => S.loadSession(file)));
  assert.equal(warns.length, 1, 'MINGDAO_EVENT_SOURCE=bogus 必须按默认 events 处理（进入对拍分支并 warn）');
  assert.deepEqual(result.messages, [HI, HELLO], 'MINGDAO_EVENT_SOURCE=bogus 必须按默认 events 回退到消息数组');
  assert.equal(withEnv('bogus', () => C.normalizeEventSource(undefined)), 'events', 'MINGDAO_EVENT_SOURCE=bogus 必须按默认 events 处理（不是回落 messages）');
  ok('㉕ MINGDAO_EVENT_SOURCE=bogus：按默认 events（不回落 messages）');
}

// ㉖ 配置文件显式写 eventSource=messages（环境变量未设）：配置优先于默认，读消息数组。
{
  const { file } = fixture([HI, HELLO], [START(), APPEND(2, HI), APPEND(3, WRONG)]);
  const cfgFile = path.join(process.env.MINGDAO_HOME, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ provider: 'deepseek', eventSource: 'messages' }));
  const loaded = C.loadConfig();
  assert.equal(loaded.eventSource, 'messages', '配置文件 eventSource=messages 必须优先于默认 events');
  const { result, warns } = withWarns(() => S.loadSession(file, loaded));
  assert.equal(warns.length, 0, '配置文件 eventSource=messages 而未设环境变量时必须读消息数组（不得 warn）');
  assert.deepEqual(result.messages, [HI, HELLO], '配置文件 eventSource=messages 而未设环境变量时必须读消息数组');
  ok('㉖ 配置文件 eventSource=messages：配置优先于默认、零 warn');
}

// ㉗ 非法环境变量 = 未设：不剥夺配置优先级（config=messages 仍然生效）。
{
  const { file } = fixture([HI, HELLO], [START(), APPEND(2, HI), APPEND(3, WRONG)]);
  const loaded = withEnv('bogus', () => C.loadConfig());
  assert.equal(loaded.eventSource, 'messages', 'MINGDAO_EVENT_SOURCE 非法值时配置 eventSource=messages 仍然生效');
  const { result, warns } = withEnv('bogus', () => withWarns(() => S.loadSession(file, loaded)));
  assert.equal(warns.length, 0, 'MINGDAO_EVENT_SOURCE 非法值时配置 eventSource=messages 仍然生效（不得 warn）');
  assert.deepEqual(result.messages, [HI, HELLO], 'MINGDAO_EVENT_SOURCE 非法值时配置 eventSource=messages 仍然生效');
  ok('㉗ 非法环境变量视为未设：配置 eventSource=messages 仍生效');
}

console.log(`\nevent-source：${passed} 项通过`);
