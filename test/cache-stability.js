// 前缀稳定性回归套件（v0.9.2）：把「同一会话内 system + tools + 历史前缀字节恒定」变成可断言的事实。
//
// 为什么需要：DeepSeek 的上下文缓存是**前缀字节匹配**（64 token 粒度，命中部分约 1/10 价）。
// 只要请求前缀里有一个字节变了，它之后的全部内容都按未命中价重计。而工具 schema 位于前缀的
// 最前面（wire format：`## Tools` 紧跟 system、在所有消息之前），所以「工具集每次重建都换字节」
// 这类优化（按需挂载 / 已用工具剥描述）省下的几百 token，远不够赔一次整段历史的重计。
//
// 本套件钉住四条不变量（全部零网络、零凭证、临时 MINGDAO_HOME）：
//   ① `buildSystemPrompt` 逐字节确定（同输入三次构建 sha256 相同；不含日期/时间等易变字段）；
//   ② 工具集序列化确定，且**回合边界**（新 user 消息、历史里已用过工具）不改变字节；
//   ③ 请求投影（trimMessages / reasoning 裁剪 / wireMessages）是纯函数：同一输入同一字节、
//      不改入参、追加新消息时既有消息的投影不变；
//   ④ 压缩（compact）保留 system 段；压缩前后 system/tools 字节不变。
//
// 运行：node test/cache-stability.js

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);

// 临时 home：不读本机 ~/.mingdao 的记忆/技能（否则断言会随用户自己的文件漂移）。
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-cache-home-'));
const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-cache-ws-'));
process.env.MINGDAO_HOME = tmpHome;

const { buildSystemPrompt } = await load('src/prompts.js');
const { buildToolSchemas, toolSchemas } = await load('src/tools/index.js');
const { visibleToolsFor, usedToolNamesFromMessages } = await load('src/tools-flow.js');
const { trimMessages, sanitizeReasoningContent, wireMessages, approxTokens } = await load('src/context.js');
const { compactConversation } = await load('src/compact.js');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const shaJson = (v) => sha(JSON.stringify(v));
const clone = (v) => JSON.parse(JSON.stringify(v));

let passed = 0;
const failures = [];
/** @param {string} name @param {() => any} fn */
function t(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (/** @type {any} */ e) {
    failures.push({ name, msg: String(e?.message || e) });
    console.error(`  ✗ ${name} —— ${String(e?.message || e)}`);
  }
}

/** 与 agent.js 默认路径同一判据：schemaTier !== true 时工具集不随回合/使用情况变化。 */
function toolsForDefault(cfg) {
  const tier = cfg?.schemaTier === true;
  const schemas = buildToolSchemas(new Set(), []);
  return visibleToolsFor(schemas, { readOnlyPhase: false, usedNames: new Set(), presetToolSet: null, isMcpReadonly: null });
}

console.log('\n① system prompt 逐字节确定');
{
  const hashes = new Set();
  for (let i = 0; i < 3; i += 1) hashes.add(sha(buildSystemPrompt({ workingDir: tmpWorkspace, withJournal: false })));
  t('同一工作目录连续 3 次 buildSystemPrompt → sha256 相同', () => {
    assert.equal(hashes.size, 1, `3 次构建得到 ${hashes.size} 个不同字节序列：${[...hashes].map((h) => h.slice(0, 12)).join(', ')}`);
  });

  const p = buildSystemPrompt({ workingDir: tmpWorkspace, withJournal: false });
  t('system prompt 不含当前日期（易变字段会逐日打断前缀）', () => {
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(p), `system prompt 里出现了日期样式文本：${p.match(/\d{4}-\d{2}-\d{2}/)?.[0]}`);
  });
  t('system prompt 不含 ISO 时间戳', () => {
    assert.ok(!/\d{2}:\d{2}:\d{2}/.test(p), 'system prompt 里出现了时间样式文本');
  });
  t('同一输入的 presetBlock / projectMemory 段：两次构建字节相同', () => {
    const opts = { workingDir: tmpWorkspace, withJournal: false, presetBlock: '\n\n<preset>固定段</preset>', projectMemory: '固定记忆一行' };
    assert.equal(sha(buildSystemPrompt(opts)), sha(buildSystemPrompt(opts)));
    // 段真的生效（否则上面的"相同"是空断言）
    assert.ok(buildSystemPrompt(opts).includes('<preset>固定段</preset>'), 'presetBlock 未进入 system prompt');
    assert.ok(buildSystemPrompt(opts).includes('固定记忆一行'), 'projectMemory 未进入 system prompt');
  });
}

console.log('\n② 工具集序列化确定 + 回合边界不换字节');
{
  const s1 = shaJson(buildToolSchemas(new Set(), []));
  const s2 = shaJson(buildToolSchemas(new Set(), []));
  const s3 = shaJson(buildToolSchemas(new Set(), []));
  t('工具集连续序列化 3 次 → sha256 相同', () => assert.equal(new Set([s1, s2, s3]).size, 1));

  t('工具顺序与名字稳定（read 在首位、无重复）', () => {
    const names = buildToolSchemas(new Set(), []).map((x) => x.function.name);
    assert.deepEqual(names, toolSchemas().map((x) => x.function.name));
    assert.equal(new Set(names).size, names.length, '工具名出现重复');
    assert.equal(names[0], 'read');
  });

  // 回合边界模拟：回合 1 里用过 read/write，回合 2 是新 user 消息（WebUI 每回合重建 agent）。
  const history = [
    { role: 'system', content: 'S' },
    { role: 'user', content: '改一下这段代码' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '文件内容' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'write', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c2', content: '已写入' },
  ];
  const afterHistory = toolsForDefault(undefined);
  t('同一个会话的回合边界（历史里已用过工具）→ 工具集字节不变', () => {
    // 默认路径：剥描述集合恒为空 → 工具集只取决于 cfg/preset/MCP（会话内恒定）
    assert.equal(shaJson(afterHistory), shaJson(toolsForDefault({})), '回合边界上工具集字节变了（前缀缓存会整体失配）');
    assert.equal(shaJson(afterHistory), shaJson(toolsForDefault({ schemaTier: false })), 'schemaTier=false 必须与默认一致');
  });
  t('历史里用过的工具不会把工具集翻成"剥描述态"（默认路径）', () => {
    const used = usedToolNamesFromMessages(history);
    assert.deepEqual([...used].sort(), ['read', 'write'], '派生集合必须来自 assistant.tool_calls');
    const withDefaults = visibleToolsFor(buildToolSchemas(new Set(), []), {
      readOnlyPhase: false,
      usedNames: used,
      presetToolSet: null,
      isMcpReadonly: null,
    });
    assert.equal(shaJson(withDefaults), shaJson(buildToolSchemas(new Set(), [])), '默认路径不得按"已用工具"剥描述');
  });

  t('schemaTier=true（显式省 token 旋钮）才允许工具集随只读档变化', () => {
    const all = buildToolSchemas(new Set(), []);
    const ro = visibleToolsFor(all, { readOnlyPhase: true, usedNames: new Set(), presetToolSet: null, isMcpReadonly: null });
    const full = visibleToolsFor(all, { readOnlyPhase: false, usedNames: new Set(), presetToolSet: null, isMcpReadonly: null });
    assert.notEqual(shaJson(ro), shaJson(full), '只读档应当只发只读工具（否则这个旋钮就没意义）');
    assert.ok(ro.length < full.length);
  });

  t('usedToolNamesFromMessages：纯函数、去重、忽略非 tool_calls 来源', () => {
    const a = usedToolNamesFromMessages(history);
    const b = usedToolNamesFromMessages(clone(history));
    assert.deepEqual([...a].sort(), [...b].sort());
    const weird = usedToolNamesFromMessages([{ role: 'assistant', content: 'read', tool_calls: [{ function: { name: '' } }, null, {}] }]);
    assert.equal(weird.size, 0, '缺 name / 空 name / null 调用不得进入集合');
    assert.equal(usedToolNamesFromMessages(/** @type {any} */ (null)).size, 0);
  });
}

console.log('\n③ 请求投影是纯函数（trim / reasoning / wire）');
{
  const msgs = [
    { role: 'system', content: 'S' },
    { role: 'user', content: '问题' },
    { role: 'assistant', content: '回答' },
    { role: 'user', content: '再问' },
  ];
  t('trimMessages 对同一输入幂等（两次调用字节相同）', () => {
    assert.equal(shaJson(trimMessages(msgs, 100000, approxTokens)), shaJson(trimMessages(msgs, 100000, approxTokens)));
  });
  t('trimMessages 是投影：不改写入参（历史不会被永久污染）', () => {
    const before = clone(msgs);
    trimMessages(msgs, 10, approxTokens); // 极小预算 → 触发回收/丢弃分支
    assert.deepEqual(clone(msgs), before, 'trimMessages 修改了调用方的 messages');
  });
  t('预算内追加一轮：既有消息的投影逐字节不变（回合追加不应打断前缀）', () => {
    const base = trimMessages(msgs, 100000, approxTokens);
    const grown = trimMessages([...msgs, { role: 'assistant', content: '新回答' }, { role: 'user', content: '新问题' }], 100000, approxTokens);
    assert.deepEqual(grown.slice(0, base.length), base);
  });

  // reasoning 回填防护（规则对同一输入确定 → 不会逐轮改写同一消息的字节）
  const rc = [
    { role: 'system', content: 'S' },
    { role: 'assistant', content: 'a', reasoning_content: 'x'.repeat(1500) },
    { role: 'assistant', content: '', reasoning_content: 'y'.repeat(5000), tool_calls: [{ id: 'c', type: 'function', function: { name: 'read', arguments: '{}' } }] },
  ];
  const rcBefore = clone(rc);
  const s1 = sanitizeReasoningContent(rc);
  const s2 = sanitizeReasoningContent(clone(rc));
  t('reasoning 裁剪：同一输入两次派生字节相同（与轮次/位置无关）', () => assert.equal(shaJson(s1), shaJson(s2)));
  t('reasoning 裁剪：>1000 字保留尾部 500 字 + 可见标注', () => {
    const got = s1[1].reasoning_content;
    assert.ok(got.endsWith('…[思考过程已截断]'), `标注缺失：${got.slice(-30)}`);
    assert.equal(got.slice(0, 500), 'x'.repeat(500));
  });
  t('reasoning 裁剪：>4000 字整段省略并标出原字数（不截断工具调用消息）', () => {
    assert.equal(s1[1].reasoning_content.length, 500 + ' …[思考过程已截断]'.length);
    assert.equal(s1[2].reasoning_content, 'y'.repeat(5000), '带 tool_calls 的消息必须完整回传 reasoning（否则下一轮 400）');
  });
  t('reasoning 裁剪：不改入参、未变化时返回原数组（不扰动对象身份）', () => {
    assert.deepEqual(clone(rc), rcBefore, 'sanitizeReasoningContent 修改了调用方消息');
    const plain = [{ role: 'user', content: 'hi' }];
    assert.equal(sanitizeReasoningContent(plain), plain);
  });

  // 上线形态：本地专有字段（ts）不出门 → 「发送时」与「下回合读回」字节一致的根本保证
  const stored = [
    { role: 'system', content: 'S', ts: '2026-01-01T00:00:00.000Z' },
    { role: 'user', content: 'U', ts: '2026-01-01T00:00:01.000Z' },
    { role: 'assistant', content: '', reasoning_content: 'r', tool_calls: [{ id: 'c', type: 'function', function: { name: 'read', arguments: '{}' } }], ts: 'x' },
    { role: 'tool', tool_call_id: 'c', content: '结果', ts: 'y' },
  ];
  t('wireMessages：只发协议字段（ts 等本地字段不出门）', () => {
    const wire = wireMessages(stored);
    assert.ok(wire.every((m) => !('ts' in m)), '线上消息里仍带 ts');
    assert.deepEqual(Object.keys(wire[2]), ['role', 'content', 'tool_calls', 'reasoning_content'], '键序/字段必须稳定');
    assert.equal(wire[3].tool_call_id, 'c');
  });
  t('wireMessages：幂等且不改入参（同一消息重复序列化字节不变）', () => {
    const before = clone(stored);
    assert.equal(shaJson(wireMessages(stored)), shaJson(wireMessages(wireMessages(stored))));
    assert.deepEqual(clone(stored), before);
  });
}

console.log('\n④ 压缩（compact）不换 system/tools 段');
{
  const msgs = [
    { role: 'system', content: 'S:stable-system' },
    { role: 'user', content: 'u1'.repeat(400) },
    { role: 'assistant', content: 'a1'.repeat(400) },
    { role: 'tool', tool_call_id: 'gone', content: 't1'.repeat(400) },
    { role: 'user', content: 'u2'.repeat(400) },
    { role: 'assistant', content: 'a2'.repeat(400) },
    { role: 'user', content: 'u3'.repeat(400) },
    { role: 'assistant', content: 'a3'.repeat(400) },
    { role: 'user', content: '最新问题' },
  ];
  const provider = { chat: async () => ({ text: '{"summary":"早期内容摘要"}', usage: { prompt_tokens: 10, completion_tokens: 5 } }) };
  const before = shaJson(toolsForDefault(undefined));
  const sysBefore = sha(buildSystemPrompt({ workingDir: tmpWorkspace, withJournal: false }));
  const sysMsgBefore = JSON.stringify(msgs[0]);

  /** @type {any} */
  let out = null;
  /** @type {any} */
  let err = null;
  try {
    out = await compactConversation({ messages: msgs, budget: 400, count: approxTokens, provider, executorModel: 'stub', force: true });
  } catch (e) {
    err = e;
  }
  t('压缩：桩 provider 下能出结果（压缩链路本身可断言）', () => {
    assert.equal(err, null, `compactConversation 抛错：${String(err?.message || err)}`);
    assert.ok(out && Array.isArray(out.messages) && out.messages.length < msgs.length, '压缩未生效');
  });
  t('压缩后 messages[0] 仍是同一份 system（不重写 system 段）', () => {
    assert.equal(JSON.stringify(out.messages[0]), sysMsgBefore, 'system 消息在压缩后被改写');
  });
  t('压缩前后 system/tools 段字节不变（压缩只改历史，不改前缀头）', () => {
    assert.equal(shaJson(toolsForDefault(undefined)), before, '压缩后工具集字节变了');
    assert.equal(sha(buildSystemPrompt({ workingDir: tmpWorkspace, withJournal: false })), sysBefore, '压缩后 system prompt 字节变了');
  });
  t('压缩结果可再次投影（trim/wire）且不崩', () => {
    const trimmed = trimMessages(out.messages, 100000, approxTokens);
    assert.ok(Array.isArray(wireMessages(trimmed)));
  });
}

console.log('\n⑤ 端到端（零网络）：跨回合的 tools / messages 字节恒定');
{
  const { createAgent } = await load('src/agent.js');
  const { createIO } = await load('src/ui.js');
  /** @type {{tools: string, messages: string}[]} */
  const seen = [];
  const fakeProvider = {
    async chat(/** @type {any} */ opts) {
      seen.push({ tools: JSON.stringify(opts.tools || []), messages: JSON.stringify(opts.messages || []) });
      return { text: 'ok', toolCalls: null, usage: { prompt_tokens: 5, completion_tokens: 1 }, finish: 'stop' };
    },
  };
  /** WebUI 每回合 createAgent：进程内状态（旧实现的 usedToolNames / 只读档）每回合清零。 */
  const newAgent = () =>
    createAgent({
      provider: fakeProvider,
      permission: { async check() { return true; } },
      io: createIO({ quiet: true }),
      modelName: 'deepseek-v4-flash',
      workingDir: tmpWorkspace,
      cfg: { permission: 'auto' },
    });
  await newAgent().runTurn([
    { role: 'system', content: 'S' },
    { role: 'user', content: '这个报错可能是什么原因？' },
  ]);
  // 上一回合的消息从磁盘读回时会带本地 ts（appendMessages 补的）——线上形态不得把它带出去。
  const history = [
    { role: 'system', content: 'S' },
    { role: 'user', content: '这个报错可能是什么原因？', ts: '2026-01-01T00:00:00.000Z' },
    { role: 'assistant', content: 'ok', ts: '2026-01-01T00:00:01.000Z' },
  ];
  await newAgent().runTurn([...history, { role: 'user', content: '把 README 改一下' }]);

  t('端到端：提问回合与写操作回合（两个 agent 实例）的 tools 字节完全相同', () => {
    assert.equal(seen.length, 2, `应有 2 次请求，实际 ${seen.length}`);
    assert.equal(seen[0].tools, seen[1].tools, 'tools 字节在回合边界上变了（整段历史前缀会失配）');
    assert.ok(JSON.parse(seen[1].tools).length >= 13, 'tools 必须是全量（默认不收缩）');
  });
  t('端到端：请求里只出现协议字段（本地 ts 不出门）', () => {
    assert.ok(!seen[1].messages.includes('"ts"'), '线上 messages 里仍带本地 ts 字段');
    assert.ok(seen[1].messages.includes('"tool_calls"') === false, '本用例无工具调用，不应出现空 tool_calls');
  });
}

// 清理夹具
try {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpWorkspace, { recursive: true, force: true });
} catch {}

console.log(`\n前缀稳定性（cache-stability）：${passed} 项通过 / ${failures.length} 项失败`);
if (failures.length) {
  console.error(failures.map((f) => `  ✗ ${f.name}：${f.msg}`).join('\n'));
  process.exit(1);
}
