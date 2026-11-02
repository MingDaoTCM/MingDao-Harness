// 批六十四（v0.6.29 报告三 §5.1/5.2/5.6/5.7）Agent 与上下文正确性回归。
//
// 覆盖五个会直接导致「会话永久 400」或「预算失真」的缺陷：
//   D1（严重）中断只清最后一条消息 → 孤儿 tool_calls 让会话永久 400；
//   D2（严重）多模态 content 数组被 String() 成 "[object Object]" → 200KB 图片只计 13 token；
//   D3（高）  trimMessages 尾部贪心遇超预算即 break → 最新用户消息被整条丢弃，只剩 system；
//   D4（严重）SSE 兜底 tool_call_id 只用工具名 → 同名并行调用 id 重复，下一轮 400；
//   D5（高）  拒绝项就地 push、成功项执行完才 push → tool 消息顺序与 tool_calls 不一致。
//
// 判定口径：D1 用「模拟严格网关」逐条校验 assistant.tool_calls 与 tool 消息必须
// **等量、同序、一一对应**（OpenAI 兼容端点的真实约束），而不是只看"有没有 tool 消息"。
//
// 运行：node test/agent-context-hardening.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-ac-hardening-'));
process.env.MINGDAO_HOME = home;

const { createAgent } = await import(pathToFileURL(path.join(srcDir, 'agent.js')).href);
const { createIO } = await import(pathToFileURL(path.join(srcDir, 'ui.js')).href);
const { messageTokens, trimMessages, approxTokens } = await import(pathToFileURL(path.join(srcDir, 'context.js')).href);
const { parseStream } = await import(pathToFileURL(path.join(srcDir, 'providers', 'openai-compatible.js')).href);

let passed = 0;
function ok(/** @type {string} */ name) {
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** 严格网关校验（D1 的判定核心）：assistant.tool_calls 后必须紧跟等量、同序的 tool 响应。 */
function strictGatewayValidate(/** @type {any[]} */ messages) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls) || !m.tool_calls.length) continue;
    const ids = m.tool_calls.map((/** @type {any} */ tc) => String(tc?.id));
    assert.equal(new Set(ids).size, ids.length, `assistant.tool_calls 的 id 必须唯一，实际：${JSON.stringify(ids)}`);
    const answered = [];
    let j = i + 1;
    while (j < messages.length && messages[j].role === 'tool') {
      answered.push(String(messages[j].tool_call_id));
      j += 1;
    }
    assert.deepEqual(
      answered,
      ids,
      `tool 响应必须紧跟 assistant 且与 tool_calls 等量同序：期望 ${JSON.stringify(ids)}，实际 ${JSON.stringify(answered)}`
    );
  }
  for (const m of messages) {
    if (m.role !== 'tool') continue;
    assert.ok(
      messages.some((/** @type {any} */ a) => a.role === 'assistant' && (a.tool_calls || []).some((/** @type {any} */ tc) => String(tc?.id) === String(m.tool_call_id))),
      `tool 消息 ${m.tool_call_id} 必须有对应的 assistant.tool_call（不得是孤儿响应）`
    );
  }
}

const toolCall = (/** @type {string} */ id, /** @type {string} */ name, /** @type {any} */ args) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

/** 可捕获 SIGINT 处理器的 io（与 smoke.js 的 io.onSigint 包装同一手法）。 */
function interruptibleIO() {
  const io = createIO({ quiet: true });
  let handler = /** @type {any} */ (null);
  const real = io.onSigint.bind(io);
  io.onSigint = (/** @type {any} */ fn) => {
    handler = fn;
    return real(fn);
  };
  return { io, fire: () => handler?.() };
}

function tempWorkdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-ac-wd-'));
}

// ---------------------------------------------------------------------------
// D1（严重-1 / C-01）：中断产生孤儿 tool_calls → 会话永久 400
// ---------------------------------------------------------------------------
{
  // ① 中断发生在「assistant 带 2 个 tool_calls、只回了 1 个 tool」：
  //    权限检查是工具执行路径上的确定性中断点；首个工具执行完、第二批开始前检测到中断。
  const wd = tempWorkdir();
  const { io, fire } = interruptibleIO();
  let chats = 0;
  let fired = false;
  const provider = {
    async chat() {
      chats += 1;
      if (chats > 1) return { text: '第二次请求成功', reasoning: '', toolCalls: null, usage: { prompt_tokens: 5, completion_tokens: 3 }, finish: 'stop' };
      return {
        text: '',
        reasoning: '',
        toolCalls: [toolCall('call_a', 'bash', { command: 'echo a' }), toolCall('call_b', 'bash', { command: 'echo b' })],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
        finish: 'tool_calls',
      };
    },
  };
  const agent = createAgent({
    provider,
    permission: {
      mode: 'ask',
      async check() {
        if (!fired) {
          fired = true;
          fire();
        }
        return true;
      },
    },
    io,
    modelName: 'deepseek-v4-flash',
    workingDir: wd,
    cfg: { permission: 'ask', autoCompact: false },
  });
  const messages = [{ role: 'user', content: '跑两条 echo' }];
  const res = await agent.runTurn(messages);

  assert.equal(fired, true, '前置：中断必须在工具执行路径上被触发');
  assert.equal(chats, 1, `中断后不得再发下一次请求，实际 ${chats} 次`);
  assert.equal(res.aborted, true, '中断必须如实回报 aborted');
  const assistant = messages.find((/** @type {any} */ m) => m.role === 'assistant');
  assert.ok(assistant && Array.isArray(assistant.tool_calls) && assistant.tool_calls.length === 2, '不得删除 assistant.tool_calls（删掉会让已执行的 tool 结果失去配对）');
  const toolMsgs = messages.filter((/** @type {any} */ m) => m.role === 'tool');
  assert.deepEqual(toolMsgs.map((/** @type {any} */ m) => m.tool_call_id), ['call_a', 'call_b'], '缺失的第 2 个调用必须被补齐（按 tool_calls 原序）');
  assert.match(String(toolMsgs[0].content), /exitCode|ok/, '第 1 条 tool 消息必须是真实执行结果，不能被"未执行"占位覆盖');
  assert.equal(toolMsgs[1].content, '（已中断，未执行）', '补齐项必须带可见的"已中断，未执行"标注');
  strictGatewayValidate(messages);
  ok('D1① 中断（只回填 1/2 个工具）后按 id 集合补齐缺失项，严格网关校验通过');

  // ② 末条为 tool 消息时中断同样补齐
  //    直接用「历史里已有 assistant(2 calls) + 1 条 tool」再触发中断：旧实现对此静默失效。
  {
    const wd2 = tempWorkdir();
    const { io: io2, fire: fire2 } = interruptibleIO();
    let fired2 = false;
    const seeded = [
      { role: 'user', content: '读两个文件' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [toolCall('old_1', 'read', { path: 'a' }), toolCall('old_2', 'read', { path: 'b' })],
      },
      { role: 'tool', tool_call_id: 'old_1', content: '旧结果' },
    ];
    const provider2 = {
      async chat() {
        if (!fired2) {
          fired2 = true;
          fire2();
        }
        return { text: '继续', reasoning: '', toolCalls: null, usage: { prompt_tokens: 5, completion_tokens: 3 }, finish: 'stop' };
      },
    };
    const agent2 = createAgent({
      provider: provider2,
      permission: { mode: 'ask', async check() { return true; } },
      io: io2,
      modelName: 'deepseek-v4-flash',
      workingDir: wd2,
      cfg: { permission: 'ask', autoCompact: false },
    });
    await agent2.runTurn(seeded);
    assert.equal(fired2, true, '前置：中断已触发');
    const tool2 = seeded.filter((/** @type {any} */ m) => m.role === 'tool');
    assert.deepEqual(tool2.map((/** @type {any} */ m) => m.tool_call_id), ['old_1', 'old_2'], '入场时末条就是 tool 消息，也必须补齐缺失调用');
    assert.equal(tool2[1].content, '（已中断，未执行）', '补齐内容必须是可见占位');
    // 先验顺序：占位必须插在 assistant 的 tool 块内（追加到历史末尾会让下一条 assistant 把配对隔开）
    strictGatewayValidate(seeded);
    assert.equal(seeded[seeded.length - 1].role, 'assistant', '正常收尾仍应追加本回合的 assistant 文本');
    ok('D1② 末条为 tool 消息时中断同样补齐（旧 stripOrphanCalls 静默失效的形态）');
  }

  // ③ 补齐后的历史能继续下一轮（模拟严格网关在**请求入口**校验）
  {
    let validated = false;
    const provider3 = {
      async chat({ messages: reqMessages }) {
        strictGatewayValidate(reqMessages);
        validated = true;
        return { text: '第二轮正常', reasoning: '', toolCalls: null, usage: { prompt_tokens: 5, completion_tokens: 3 }, finish: 'stop' };
      },
    };
    const agent3 = createAgent({
      provider: provider3,
      permission: { mode: 'ask', async check() { return true; } },
      io: createIO({ quiet: true }),
      modelName: 'deepseek-v4-flash',
      workingDir: wd,
      cfg: { permission: 'ask', autoCompact: false },
    });
    const res3 = await agent3.runTurn(messages);
    assert.equal(validated, true, '第二轮的请求体必须真的经过严格校验');
    assert.equal(res3.text, '第二轮正常', '修复后同一会话必须还能继续，而不是永久 400');
    const toolCount = messages.filter((/** @type {any} */ m) => m.role === 'tool').length;
    assert.equal(toolCount, 2, `补齐必须幂等：第二轮不得重复追加占位（实际 ${toolCount} 条 tool 消息）`);
    strictGatewayValidate(messages);
    ok('D1③ 补齐后下一轮请求体通过严格网关校验，且补齐幂等（不重复追加）');
  }
}

// ---------------------------------------------------------------------------
// D2（严重-2 / C-02）：多模态消息被计成 13 token
// ---------------------------------------------------------------------------
{
  const text = 'x'.repeat(4000);
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(200 * 1024) } };
  const multi = { role: 'user', content: [{ type: 'text', text }, image] };
  const tokens = messageTokens(multi, approxTokens);
  assert.ok(tokens >= 3000, `204KB 图文消息必须按 parts 计数（≥3000，旧实现为 13），实际 ${tokens}`);
  assert.notEqual(tokens, 13, '不得再出现 String(array) → "[object Object]" 的 13 token');
  ok(`D2① 204KB 图文消息计数 ≥3000（实际 ${tokens}，旧实现 13）`);

  // 纯文本数组与字符串结果一致（text part 走同一个计数器）
  {
    const s = 'hello world 你好，世界';
    const asArray = messageTokens({ role: 'user', content: [{ type: 'text', text: s }] }, approxTokens);
    const asString = messageTokens({ role: 'user', content: s }, approxTokens);
    assert.equal(asArray, asString, `纯文本数组与字符串必须同口径，实际 ${asArray} vs ${asString}`);
    ok('D2② 纯文本 parts 数组与字符串计数一致');
  }

  // 图片按固定保守估值计（不依赖 base64 长度，不随 URL 前缀变化）
  {
    const small = messageTokens({ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }, approxTokens);
    const large = messageTokens({ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(100 * 1024) } }] }, approxTokens);
    assert.equal(small, large, '同一 image part 的估值应固定（视觉开销不按 base64 长度线性增长）');
    assert.ok(small >= 2048, `单张图片至少按 2048 token 保守计，实际 ${small}`);
    ok('D2③ image part 按固定保守估值计（≥2048）');
  }

  // 未知 part：不崩、且不给"免费"值
  {
    const weird = { role: 'user', content: [{ type: 'mystery_part', blob: 'B'.repeat(50000) }, { type: 'text', text: 'hi' }] };
    const t = messageTokens(weird, approxTokens);
    assert.ok(Number.isFinite(t) && t >= 2048, `未知 part 必须给保守值（≥2048），实际 ${t}`);
    const circular = { type: 'mystery_part' };
    circular.self = circular; // JSON.stringify 会抛——不能因此崩溃
    const t2 = messageTokens({ role: 'user', content: [circular] }, approxTokens);
    assert.ok(Number.isFinite(t2) && t2 >= 2048, `循环未知 part 也不能崩，实际 ${t2}`);
    ok('D2④ 未知 part（含循环引用）不崩且给保守估值');
  }

  // 音频固定估值；空/null content 不崩
  {
    const audio = messageTokens({ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'A'.repeat(1000) } }] }, approxTokens);
    assert.ok(audio >= 1024, `音频 part 至少按 1024 计，实际 ${audio}`);
    assert.ok(Number.isFinite(messageTokens({ role: 'assistant', content: null }, approxTokens)), 'null content 不得崩溃');
    assert.ok(Number.isFinite(messageTokens({ role: 'user', content: { nested: '对象形态' } }, approxTokens)), '对象形态 content 不得崩溃');
    ok('D2⑤ 音频固定估值 + null/对象 content 不崩');
  }
}

// ---------------------------------------------------------------------------
// D3（高-1 / H-01）：trimMessages 尾部贪心 → 只剩 system
// ---------------------------------------------------------------------------
{
  const system = { role: 'system', content: '你是助手，请如实回答。' };
  // ① 8000 字单条用户消息 + 小预算：必须保留（可能截断），且带可见标注
  {
    const user = { role: 'user', content: '字'.repeat(8000) };
    const out = trimMessages([system, user], 500, approxTokens);
    assert.ok(out.some((/** @type {any} */ m) => m.role === 'user'), `最新用户消息不得被丢弃，实际 roles=${JSON.stringify(out.map((m) => m.role))}`);
    const kept = out[out.length - 1];
    assert.match(String(kept.content), /已截断/, '超预算单条消息必须带可见截断标注');
    assert.ok(String(kept.content).length < 8000, '截断后正文必须真的变短');
    assert.deepEqual(out.map((m) => m.role), ['system', 'user'], '输出顺序必须是 system → user');
    ok(`D3① 8000 字用户消息 + 500 预算：保留并截断（${String(kept.content).length} 字，含标注）`);
  }

  // ② 多条时保留最近 N 条且顺序不变
  {
    const many = [system];
    for (let i = 0; i < 20; i++) many.push({ role: 'user', content: `第 ${i} 条：` + 'x'.repeat(400) });
    const out = trimMessages(many, 1500, approxTokens);
    const users = out.filter((/** @type {any} */ m) => m.role === 'user');
    assert.ok(users.length >= 1 && users.length < 20, `应只保留尾部若干条，实际保留 ${users.length}/20`);
    const keptTexts = users.map((/** @type {any} */ m) => m.content);
    const expectedTail = many.slice(many.length - users.length).map((/** @type {any} */ m) => m.content);
    assert.deepEqual(keptTexts, expectedTail, '保留的必须是原序的**连续尾部**，不能乱序或跳条');
    assert.equal(out[0], system, 'system 必须原样保留在首位');
    ok(`D3② 多条消息只保留原序尾部（${users.length}/20 条，顺序不变）`);
  }

  // ③ 最后一条必留的不变量在「system 本身很占预算」时也成立
  {
    const bigSystem = { role: 'system', content: 'S'.repeat(2000) };
    const last = { role: 'user', content: 'LAST-' + 'y'.repeat(6000) };
    const out = trimMessages([bigSystem, last], 100, approxTokens);
    assert.equal(out[0], bigSystem, 'system 保留');
    const kept = out[out.length - 1];
    assert.equal(kept.role, 'user', '预算已被 system 吃光时，最后一条消息仍必须保留');
    assert.match(String(kept.content), /已截断/, '极限预算下至少保留可见标注');
    ok('D3③ system 已吃光预算时最后一条仍必留（截断到可见标注）');
  }

  // ④ parts 数组形态的最后一条也能被截断且不破坏结构
  {
    const partsMsg = {
      role: 'user',
      content: [{ type: 'text', text: 'P'.repeat(9000) }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
    };
    const out = trimMessages([system, partsMsg], 600, approxTokens);
    const kept = out[out.length - 1];
    assert.equal(kept.role, 'user', 'parts 形态的最新消息也必须保留');
    assert.ok(Array.isArray(kept.content), 'parts 形态截断后仍应是数组');
    assert.equal(kept.content[kept.content.length - 1].type, 'text', '数组末尾必须补可见的 text 标注');
    assert.match(String(kept.content[kept.content.length - 1].text), /已截断/);
    ok('D3④ parts 数组形态的尾部消息截断后结构完整且带标注');
  }

  // ⑤ 预算充足时不得改动任何消息引用（裁剪是投影，不能污染原对象）
  {
    const a = { role: 'user', content: 'a'.repeat(100) };
    const b = { role: 'user', content: 'b'.repeat(100) };
    const out = trimMessages([system, a, b], 100000, approxTokens);
    assert.deepEqual(out, [system, a, b], '预算充足时必须原样返回（同一引用）');
    assert.equal(out[1], a, '不得复制/改写原始消息引用');
    ok('D3⑤ 预算充足时原样返回，不污染原始消息引用');
  }
}

// ---------------------------------------------------------------------------
// D4（严重-3 / C-04）：SSE 兜底 tool_call_id 只用工具名 → 同名并行调用重复
// ---------------------------------------------------------------------------
{
  const enc = new TextEncoder();
  const streamOf = (/** @type {string} */ text) =>
    new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(text));
        c.close();
      },
    });
  const framesToSse = (/** @type {any[]} */ frames) =>
    frames.map((f) => 'data: ' + JSON.stringify(f) + '\n\n').join('') + 'data: [DONE]\n\n';
  const deltaFrame = (/** @type {any} */ tc) => ({ choices: [{ delta: { tool_calls: [tc] } }] });

  // ① 一个响应含 2 个同名 tool_call 且都无 id → 生成的两个 id 必须不相等
  {
    const r = await parseStream(
      streamOf(
        framesToSse([
          deltaFrame({ index: 0, function: { name: 'read', arguments: '{"path":"a"}' } }),
          deltaFrame({ index: 1, function: { name: 'read', arguments: '{"path":"b"}' } }),
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ])
      ),
      null
    );
    assert.equal(r.toolCalls.length, 2, '两个同名 tool_call 都必须保留');
    const ids = r.toolCalls.map((/** @type {any} */ c) => c.id);
    assert.notEqual(ids[0], ids[1], `同名并行调用的兜底 id 必须唯一，实际：${JSON.stringify(ids)}`);
    assert.equal(new Set(ids).size, 2, '兜底 id 集合内不得重复');
    for (const id of ids) assert.ok(String(id).includes('read'), `兜底 id 应可追溯工具名，实际 ${id}`);
    ok(`D4① 两个同名无 id 的 tool_call 生成不同 id（${ids.join(' / ')}）`);
  }

  // ② 3 个同名调用（含分片续传）→ 全部唯一，且参数分片仍正确拼接
  {
    const r = await parseStream(
      streamOf(
        framesToSse([
          deltaFrame({ index: 0, function: { name: 'read', arguments: '{"path":' } }),
          deltaFrame({ index: 0, function: { arguments: '"a"}' } }),
          deltaFrame({ index: 1, function: { name: 'read', arguments: '{"path":"b"}' } }),
          deltaFrame({ index: 2, function: { name: 'read', arguments: '{"path":"c"}' } }),
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ])
      ),
      null
    );
    const ids = r.toolCalls.map((/** @type {any} */ c) => c.id);
    assert.equal(r.toolCalls.length, 3, '三个调用都必须保留');
    assert.equal(new Set(ids).size, 3, `三个同名调用的 id 必须两两不同，实际：${JSON.stringify(ids)}`);
    assert.equal(r.toolCalls[0].function.arguments, '{"path":"a"}', '同一 index 的参数分片仍必须拼接');
    ok('D4② 三个同名调用（含分片续传）id 两两不同');
  }

  // ③ 用兜底 id 构造严格请求体：每个 tool_call_id 恰有一条 tool 响应
  {
    const r = await parseStream(
      streamOf(
        framesToSse([
          deltaFrame({ index: 0, function: { name: 'read', arguments: '{"path":"a"}' } }),
          deltaFrame({ index: 1, function: { name: 'read', arguments: '{"path":"b"}' } }),
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ])
      ),
      null
    );
    const request = [
      { role: 'user', content: '读两个文件' },
      { role: 'assistant', content: null, tool_calls: r.toolCalls },
      ...r.toolCalls.map((/** @type {any} */ c) => ({ role: 'tool', tool_call_id: c.id, content: 'ok' })),
    ];
    strictGatewayValidate(request);
    ok('D4③ 用兜底 id 拼出的请求体通过严格网关校验（每个 id 恰一条响应）');
  }

  // ④ 显式 id 必须原样保留（不得被兜底规则改写）
  {
    const r = await parseStream(
      streamOf(
        framesToSse([
          deltaFrame({ index: 0, id: 'call_explicit_1', function: { name: 'read', arguments: '{}' } }),
          deltaFrame({ index: 1, function: { name: 'read', arguments: '{}' } }),
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ])
      ),
      null
    );
    assert.equal(r.toolCalls[0].id, 'call_explicit_1', '网关显式下发的 id 必须原样保留');
    assert.notEqual(r.toolCalls[1].id, 'call_explicit_1', '兜底 id 不得与显式 id 撞车');
    ok('D4④ 显式 id 原样保留，兜底 id 不与之冲突');
  }
}

// ---------------------------------------------------------------------------
// D5（高-2 / H-02）：工具消息回填顺序倒置
// ---------------------------------------------------------------------------
{
  const wd = tempWorkdir();
  fs.writeFileSync(path.join(wd, 'a.txt'), 'AAA\n');
  fs.writeFileSync(path.join(wd, 'b.txt'), 'BBB\n');
  fs.writeFileSync(path.join(wd, 'c.txt'), 'CCC\n');

  /** 跑一个「一批 read 调用，其中部分被拒」的回合，返回最终 messages。 */
  async function runWithDenials(/** @type {string[]} */ paths, /** @type {Set<string>} */ denied) {
    const counts = { chats: 0 };
    const provider = {
      async chat() {
        counts.chats += 1;
        if (counts.chats > 1) return { text: '完成', reasoning: '', toolCalls: null, usage: { prompt_tokens: 5, completion_tokens: 3 }, finish: 'stop' };
        return {
          text: '',
          reasoning: '',
          toolCalls: paths.map((p, i) => toolCall(`call_${i}`, 'read', { path: p })),
          usage: { prompt_tokens: 5, completion_tokens: 3 },
          finish: 'tool_calls',
        };
      },
    };
    const agent = createAgent({
      provider,
      permission: {
        mode: 'auto', // canBatch=true：多个只读调用会在同一批预检/执行
        async check(/** @type {string} */ _name, /** @type {any} */ args) {
          return !denied.has(String(args?.path || ''));
        },
      },
      io: createIO({ quiet: true }),
      modelName: 'deepseek-v4-flash',
      workingDir: wd,
      cfg: { permission: 'auto', autoCompact: false },
    });
    const messages = [{ role: 'user', content: '读文件' }];
    await agent.runTurn(messages);
    return messages;
  }

  // ① [成功 A, 被拒 B]：旧实现顺序是 B → A
  {
    const a = path.join(wd, 'a.txt');
    const b = path.join(wd, 'b.txt');
    const messages = await runWithDenials([a, b], new Set([b]));
    const tools = messages.filter((/** @type {any} */ m) => m.role === 'tool');
    assert.deepEqual(tools.map((/** @type {any} */ m) => m.tool_call_id), ['call_0', 'call_1'], 'tool 消息必须与 tool_calls 原序一致（A 成功在前、B 被拒在后）');
    assert.match(String(tools[0].content), /AAA|output/, '第 1 条必须是 A 的真实读取结果');
    assert.match(String(tools[1].content), /拒绝/, '第 2 条必须是被拒说明');
    strictGatewayValidate(messages);
    ok('D5① [成功 A, 被拒 B] 回填顺序为 A → B（旧实现 B → A）');
  }

  // ② [被拒 A, 成功 B]：顺序同样必须是 A → B
  {
    const a = path.join(wd, 'a.txt');
    const b = path.join(wd, 'b.txt');
    const messages = await runWithDenials([a, b], new Set([a]));
    const tools = messages.filter((/** @type {any} */ m) => m.role === 'tool');
    assert.deepEqual(tools.map((/** @type {any} */ m) => m.tool_call_id), ['call_0', 'call_1'], '被拒项在前时也必须严格按 tool_calls 原序回填');
    assert.match(String(tools[0].content), /拒绝/, '第 1 条必须是被拒说明');
    assert.match(String(tools[1].content), /BBB|output/, '第 2 条必须是 B 的真实读取结果');
    strictGatewayValidate(messages);
    ok('D5② [被拒 A, 成功 B] 回填顺序仍为 A → B');
  }

  // ③ 跨批次：[成功 A, 被拒 B, 成功 C] 顺序不得错位
  {
    const a = path.join(wd, 'a.txt');
    const b = path.join(wd, 'b.txt');
    const c = path.join(wd, 'c.txt');
    const messages = await runWithDenials([a, b, c], new Set([b]));
    const tools = messages.filter((/** @type {any} */ m) => m.role === 'tool');
    assert.deepEqual(tools.map((/** @type {any} */ m) => m.tool_call_id), ['call_0', 'call_1', 'call_2'], '跨批次的拒绝项也必须按原序归位');
    assert.match(String(tools[0].content), /AAA|output/);
    assert.match(String(tools[1].content), /拒绝/);
    assert.match(String(tools[2].content), /CCC|output/);
    strictGatewayValidate(messages);
    ok('D5③ 跨批次 [A 成功, B 被拒, C 成功] 顺序保持 A → B → C');
  }
}

console.log(`\nagent/context 加固套件：全部通过（${passed} 组断言）`);
process.exit(0);
