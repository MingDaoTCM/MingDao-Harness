// 插话（steer / next-step 车道）的独立回归套件（v0.6.40）。
//
// 语义（对齐 DSH / Octop）：
//   · 两条车道：next-turn（Enter，排队到本轮结束后）与 next-step（Cmd/Ctrl+Enter，插入当前轮）；
//   · next-step 在**每个 step 边界全量取走**（不是每轮一条）；
//   · 模型本次没有工具调用、本来要收尾时，只要插话非空就**继续下一步**（本轮不结束）；
//   · 上限：队列 ≤8 条、单条 ≤200KB（UTF-8 字节），超限各给可读错误（413/429）。
//
// 覆盖三层：
//   ① viewmodel 纯函数（入队/上限/超长/全量取走/幂等/渲染/是否继续）；
//   ② agent 桩 provider（插话被注入为 user 消息 + 本轮不结束 + 无插话时正常收尾）；
//   ③ 真实 HTTP server（/api/steer 的 404/413/429/400、SSE 的 queued/injected 事件、
//      第二次模型请求里真的带上了 8 条插话、任务结束后缓冲不可再用）。
//
// 运行：node test/steering.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-steer-'));
process.env.MINGDAO_HOME = home;

const V = await import(pathToFileURL(path.join(srcDir, 'web', 'viewmodel.js')).href);
const { createAgent } = await import(pathToFileURL(path.join(srcDir, 'agent.js')).href);
const { createIO } = await import(pathToFileURL(path.join(srcDir, 'ui.js')).href);
const { saveConfig } = await import(pathToFileURL(path.join(srcDir, 'config.js')).href);
const { runWebServer } = await import(pathToFileURL(path.join(srcDir, 'web', 'server.js')).href);

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`  ✓ 插话[${name}]`);
};
const eq = (a, b, msg) => assert.deepEqual(a, b, msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===========================================================================
// ① viewmodel：纯语义（入队 / 上限 / 超长 / 全量取走 / 幂等 / 渲染 / 继续判据）
// ===========================================================================
{
  const empty = V.enqueueSteer([], '   ', 'a');
  eq([empty.ok, empty.reason, empty.steer.length], [false, 'empty', 0], '空/空白插话不入队');

  ok('空/空白文本不入队');
  const e1 = V.enqueueSteer([], '插一句：先看日志再改', 's1', 111);
  eq([e1.ok, e1.steer.length, e1.steer[0].text, e1.steer[0].at], [true, 1, '插一句：先看日志再改', 111], '非空插话入队且保留 at');
  const e2 = V.enqueueSteer(e1.steer, '第二条', 's2', 222);
  eq(e2.steer.map((x) => x.id), ['s1', 's2'], '插话先进先出，id 顺序稳定');
  eq(V.enqueueSteer(null, 'x', 's3').ok, true, '非数组输入不崩');

  ok('非空入队 / 先进先出 / 非数组不崩');
  const full = Array.from({ length: V.STEER_MAX }, (_, i) => ({ id: String(i), text: 'x' + i }));
  eq(V.enqueueSteer(full, 'y', 'z').reason, 'full', `插话队列上限 ${V.STEER_MAX} 条：满员必须拒绝`);
  eq(V.enqueueSteer(full, 'y', 'z').steer.length, V.STEER_MAX, '满员时队列不变');

  ok(`队列上限 ${V.STEER_MAX} 条：满员拒绝且队列不变`);
  eq(V.STEER_TEXT_MAX, 200 * 1024, '单条插话上限必须是 200KB');
  const huge = 'a'.repeat(V.STEER_TEXT_MAX + 1);
  eq(V.enqueueSteer([], huge, 'h').reason, 'too-long', '超长插话（>200KB）必须拒绝');
  const exact = 'b'.repeat(V.STEER_TEXT_MAX);
  eq(V.enqueueSteer([], exact, 'e').ok, true, '恰好 200KB 的插话应放行（边界）');
  eq(V.steerBytes('中文'), 6, '字节口径按 UTF-8（中文 1 字 3 字节），不是字符数');
  // 超长优先于满员：否则"又满又长"会得到误导性的 429
  eq(V.enqueueSteer(full, huge, 'z').reason, 'too-long', '超长必须先于满员判定（413 不被 429 掩盖）');

  ok('超长 200KB 拒绝（边界放行）+ UTF-8 字节口径 + 超长优先于满员');
  const drain = V.drainSteer(e2.steer);
  eq(drain.taken.map((x) => x.text), ['插一句：先看日志再改', '第二条'], 'drainSteer 必须全量取走（不是只取一条）');
  eq(drain.steer.length, 0, '取走后队列为空');
  const again = V.drainSteer(drain.steer);
  eq(again.taken, [], 'drainSteer 对空队列幂等（返回空 taken，不抛）');
  eq(V.drainSteer(null).taken, [], 'drainSteer 非数组输入不崩');

  ok('drainSteer 全量取走且幂等 / 空输入安全');
  const view = V.steerView([{ id: 's1', text: '第一行\n第二行' }, { id: 's2', text: 'x'.repeat(100) }]);
  eq(view[0].kind, 'steer', '插话 chip 带 kind=steer（UI 据此换配色）');
  eq(view[0].icon, '⚡', '插话 chip 带 ⚡ 图标');
  eq(view[0].label.includes('\n'), false, '插话 chip 单行显示（换行压平）');
  eq(view[1].label.length <= 42, true, '插话 chip 超长截断');
  eq(V.steerView(null), [], 'steerView 非数组返回空数组');

  ok('steerView：kind=steer / ⚡ / 单行截断');
  eq(V.shouldContinueAfterModel({ steer: [{ text: 'a' }] }), true, '有插话 → 继续下一步（本轮不结束）');
  eq(V.shouldContinueAfterModel({ steer: [] }), false, '无插话 → 正常收尾');
  eq(V.shouldContinueAfterModel({}), false, '缺字段不崩');
  eq(V.shouldContinueAfterModel({ steer: [{ text: 'a' }], aborted: true }), false, '用户中止优先：有插话也不继续');
  eq(V.shouldContinueAfterModel({ steer: [{ text: 'a' }], stalled: true }), false, '无进展看门狗优先：有插话也不继续');
  ok('shouldContinueAfterModel：有→继续 / 无→收尾 / 中止与 stalled 优先');
}

// ===========================================================================
// ② agent 桩 provider：插话注入为 user 消息 + 本轮不结束
// ===========================================================================
const quietIO = (steerEvents) => {
  const io = createIO({ quiet: true });
  io.steer = (/** @type {any} */ text) => steerEvents.push(String(text));
  return io;
};
const reply = (/** @type {string} */ text) => ({
  text,
  reasoning: '',
  toolCalls: null,
  usage: { prompt_tokens: 10, completion_tokens: 5 },
  finish: 'stop',
});
const AGENT_CFG = { permission: 'auto', autoCompact: false, maxRounds: 1 };
function makeAgent(/** @type {any} */ provider, /** @type {any} */ steeringState, /** @type {any[]} */ steerEvents) {
  const io = quietIO(steerEvents);
  const agent = createAgent({
    provider,
    permission: { async check() { return true; } },
    io,
    modelName: 'deepseek-v4-flash',
    workingDir: home,
    cfg: AGENT_CFG,
    maxSteps: 4,
    steering: {
      drain: () => {
        const r = V.drainSteer(steeringState.list);
        steeringState.list = r.steer;
        return r.taken;
      },
    },
  });
  return { agent, io };
}

// ②-1 每步边界注入：第 1 次 drain 就取到插话 → 第一条请求里就有它
{
  const steerEvents = [];
  const payloads = [];
  const steeringState = { list: [{ id: 's1', text: '插话：先看日志' }] };
  const provider = {
    async chat(/** @type {any} */ req) {
      payloads.push(req);
      return reply('完成');
    },
  };
  const { agent } = makeAgent(provider, steeringState, steerEvents);
  const r = await agent.runTurn([{ role: 'user', content: '开始' }]);
  eq(payloads.length, 1, '插话不应该额外多一轮请求（第一步就注入）');
  const msgs = payloads[0].messages;
  eq(msgs[msgs.length - 1], { role: 'user', content: '插话：先看日志' }, '每步边界注入：插话作为新的 user 消息出现在请求末尾');
  eq(steerEvents, ['插话：先看日志'], 'agent 必须通过 io.steer 发 {type:steer}（前端据此写"已插入本轮"）');
  eq(steeringState.list.length, 0, '插话被全量取走（不会重复注入）');
  eq(r.text, '完成', '回合正常返回');
  ok('agent：每步边界把插话注入为 user 消息（一次请求即生效）');
}

// ②-2 收尾前再 drain：模型无工具调用时，插话让本轮不结束（继续下一步）
{
  const steerEvents = [];
  const payloads = [];
  const steeringState = { list: [] };
  let drainCalls = 0;
  const provider = {
    async chat(/** @type {any} */ req) {
      payloads.push(req);
      return reply(payloads.length === 1 ? '第一段（本来要收尾）' : '第二段（插话后继续）');
    },
  };
  const io = quietIO(steerEvents);
  const agent = createAgent({
    provider,
    permission: { async check() { return true; } },
    io,
    modelName: 'deepseek-v4-flash',
    workingDir: home,
    cfg: AGENT_CFG,
    maxSteps: 4,
    steering: {
      drain: () => {
        drainCalls += 1;
        if (drainCalls === 2) return [{ id: 'late', text: '插话：模型返回时才按的 Cmd+Enter' }];
        return [];
      },
    },
  });
  const r = await agent.runTurn([{ role: 'user', content: '开始' }]);
  eq(payloads.length, 2, '本轮不结束：模型无工具调用但插话非空 → 必须继续下一步（不是 return）');
  eq(drainCalls >= 2, true, '收尾分支必须再 drain 一次（覆盖模型返回窗口内到达的插话）');
  eq(payloads[1].messages[payloads[1].messages.length - 1], { role: 'user', content: '插话：模型返回时才按的 Cmd+Enter' }, '插话在第二步请求里作为 user 消息喂给模型');
  eq(payloads[1].messages.some((m) => m.role === 'assistant' && m.content === '第一段（本来要收尾）'), true, '收尾的 assistant 文本仍留在历史里');
  eq(steerEvents, ['插话：模型返回时才按的 Cmd+Enter'], '注入时发一次 steer 事件');
  eq(r.text, '第二段（插话后继续）', '返回值来自插话后的下一步');
  ok('agent：模型无工具调用时插话让本轮不结束（continue 而非 return）');
}

// ②-3 对照：无插话时一次请求就收尾（不能因为新逻辑永不结束）
{
  const steerEvents = [];
  const payloads = [];
  const provider = {
    async chat(/** @type {any} */ req) {
      payloads.push(req);
      return reply('正常收尾');
    },
  };
  const { agent } = makeAgent(provider, { list: [] }, steerEvents);
  const r = await agent.runTurn([{ role: 'user', content: '开始' }]);
  eq(payloads.length, 1, '无插话 → 一次请求正常收尾（对照）');
  eq(steerEvents, [], '无插话不发 steer 事件');
  eq(r.text, '正常收尾', '返回值不变');
  ok('agent 对照：无插话时一次请求正常收尾');
}

// ===========================================================================
// ③ 真实 HTTP server：/api/steer 状态码 + SSE 事件 + 第二次请求确实带插话
// ===========================================================================
{
  /** 记录 mock 上游收到的请求（断言"插话真的进了模型请求"）。 */
  const payloadLog = [];
  let chatRequests = 0;
  const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch {}
      payloadLog.push(parsed);
      const isSteerChat = JSON.stringify(parsed?.messages || []).includes('STEER-TEST');
      if (isSteerChat) chatRequests += 1;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const sse = (/** @type {any} */ p) => res.write(`data: ${JSON.stringify(p)}\n\n`);
      sse({ choices: [{ delta: { content: isSteerChat ? '处理中' : '' }, finish_reason: null }] });
      // 第一次真实 chat 故意慢 1.8s：给测试留出"模型还在返回时连续 POST 8 条"的窗口。
      const delay = isSteerChat && chatRequests === 1 ? 1800 : 120;
      setTimeout(() => {
        sse({ choices: [{ delta: { content: '完成' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
        res.end('data: [DONE]\n\n');
      }, delay);
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mockPort = mock.address().port;

  saveConfig({ provider: 'custom', model: 'test-model', baseUrl: `http://127.0.0.1:${mockPort}/v1`, permission: 'auto', contextBudget: 32000 });
  fs.writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({ custom: 'sk-test-steering-000000' }), { mode: 0o600 });

  const srv = await runWebServer({ host: '127.0.0.1', port: 0, authToken: null });
  if (!srv.listening) await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = async (/** @type {string} */ p, /** @type {any} */ body) => {
    const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    return { status: res.status, j };
  };

  /** 开一轮 chat 并在后台读 SSE；返回实时 taskId。 */
  const openChat = async (message) => {
    const resp = await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) });
    assert.equal(resp.status, 200, 'chat 应返回 200');
    const events = [];
    let taskId = null;
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const done = (async () => {
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          let ev;
          try { ev = JSON.parse(line.slice(5)); } catch { continue; }
          events.push(ev);
          if (ev.taskId) taskId = ev.taskId;
        }
      }
    })();
    const deadline = Date.now() + 8000;
    while (!taskId && Date.now() < deadline) await sleep(20);
    assert.ok(taskId, '必须在 8s 内拿到 taskId');
    return { events, done, get taskId() { return taskId; } };
  };

  try {
    const chat = await openChat('STEER-TEST 主任务');
    const steerTexts = Array.from({ length: V.STEER_MAX }, (_, i) => `插话-${i + 1}`);

    // 连续 8 条：都应在模型请求仍在途时入队成功
    const statuses = [];
    for (const t of steerTexts) statuses.push((await post('/api/steer', { taskId: chat.taskId, message: t })).status);
    eq(statuses, Array.from({ length: V.STEER_MAX }, () => 200), `插话入队 8 条全部 200（实际上限 ${V.STEER_MAX}）`);

    const over = await post('/api/steer', { taskId: chat.taskId, message: '第 9 条' });
    ok('server：8 条入队全部 200');
    eq(over.status, 429, '插话队列超上限必须 429（可读错误）');
    assert.ok(/上限 8/.test(String(over.j.error || '')), '429 必须说清上限是 8 条');

    const tooLong = await post('/api/steer', { taskId: chat.taskId, message: 'x'.repeat(V.STEER_TEXT_MAX + 1) });
    ok('server：第 9 条 → 429（队列上限）');
    eq(tooLong.status, 413, '超长插话必须 413（即使队列已满也要先报超长）');
    assert.ok(/200KB/.test(String(tooLong.j.error || '')), '413 必须说清 200KB 上限');

    const unknown = await post('/api/steer', { taskId: 't-does-not-exist', message: '喂' });
    eq(unknown.status, 404, '未知 taskId 必须 404（未知 taskId 不报错 = 静默丢弃）');

    ok('server：超长 → 413（200KB 文案）');
    const empty = await post('/api/steer', { taskId: chat.taskId, message: '   ' });
    eq(empty.status, 400, '空插话必须 400');
    ok('server：未知 taskId → 404 / 空文本 → 400');

    await chat.done;

    const queuedEvents = chat.events.filter((e) => e.type === 'steer' && e.queued === true);
    const injectedEvents = chat.events.filter((e) => e.type === 'steer' && e.injected === true);
    eq(queuedEvents.length, V.STEER_MAX, 'SSE 必须即时推送 8 条 queued steer 事件（入队可见）');
    eq(injectedEvents.length, V.STEER_MAX, 'agent 真正注入时必须再推 8 条 injected steer 事件（"已插入本轮"）');
    eq(injectedEvents.map((e) => e.text), steerTexts, 'injected 事件文本与入队顺序一致');
    ok('server：SSE 推 8 条 queued + 8 条 injected（顺序一致）');

    // 第二次模型请求里必须**原样带 8 条插话**（不是排到下一轮）
    const chatPayloads = payloadLog.filter((p) => JSON.stringify(p?.messages || []).includes('STEER-TEST'));
    const firstChat = chatPayloads[0];
    const secondChat = chatPayloads[1];
    assert.ok(firstChat && secondChat, '应至少发生两次真实模型请求（插话让本轮继续）');
    const firstUserTexts = (firstChat.messages || []).filter((m) => m.role === 'user').map((m) => String(m.content));
    eq(firstUserTexts.some((t) => t.startsWith('插话-')), false, '第一次请求时插话还没到（时序断言：8 条是模型返回后才入队的）');
    const secondUserTexts = (secondChat.messages || []).filter((m) => m.role === 'user').map((m) => String(m.content));
    eq(secondUserTexts.slice(-V.STEER_MAX), steerTexts, '第二次模型请求必须按序带上全部 8 条插话（全量取走，不是一条一步）');
    ok('server：第二次请求带全部 8 条插话（本轮未结束）');

    const doneEv = chat.events.find((e) => e.type === 'done');
    assert.ok(doneEv, '必须有 done 事件');
    eq(doneEv.ok, true, 'done.ok=true（插话不改变正常完成语义）');

    // 任务结束后：缓冲已清理 / 状态非 running → 同一 taskId 再插必须 404（而不是假成功）
    const after = await post('/api/steer', { taskId: chat.taskId, message: '任务结束后再插' });
    eq(after.status, 404, '任务结束后插话必须 404（不留下永远没人消费的缓冲）');
    ok('server：任务结束后同一 taskId → 404（缓冲已清理）');
  } finally {
    await new Promise((r) => srv.close(r));
    await new Promise((r) => mock.close(r));
  }
}

// ===========================================================================
// ④ 接线绊线：前端/服务端/agent 的关键路径（变异用；文本检查不是行为证明，行为在 ①②③）
// ===========================================================================
{
  const appSrc = fs.readFileSync(path.join(srcDir, 'web', 'app.js'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(srcDir, 'web', 'index.html'), 'utf8');
  const serverSrc = fs.readFileSync(path.join(srcDir, 'web', 'server.js'), 'utf8');
  const agentSrc = fs.readFileSync(path.join(srcDir, 'agent.js'), 'utf8');
  const webIoSrc = fs.readFileSync(path.join(srcDir, 'web', 'web-io.js'), 'utf8');

  assert.ok(/\/api\/steer/.test(appSrc), '前端必须调用 POST /api/steer（Cmd/Ctrl+Enter 插话的入口）');
  assert.ok(/fallbackSteer\(text/.test(appSrc), '插话失败必须回落到排队（失败回落到排队）');
  assert.ok(/if\(!enqueueInput\(text\)\) return;/.test(appSrc), 'fallbackSteer 必须真的把文本放进 next-turn 队列');
  assert.ok(/msg-sys/.test(appSrc) && /已插入本轮/.test(appSrc), '收到 steer 事件必须写 msg-sys「已插入本轮」');
  assert.ok(/metaKey\|\|e\.ctrlKey/.test(appSrc), '生成中的 ⌘/Ctrl+Enter 必须被识别为插话');
  assert.ok(/id="steerStrip"/.test(htmlSrc), '插话 chips 需要独立的 steerStrip');
  assert.ok(/\.schip/.test(htmlSrc) && /⚡/.test(htmlSrc), '插话 chips 必须有独立配色/⚡（与排队 chips 区分）');
  assert.ok(/handleSteer/.test(serverSrc), 'server 必须提供 /api/steer 实现');
  assert.ok(/steering\.clear\(taskId\)/.test(serverSrc), '任务结束时必须清理插话缓冲（防泄漏）');
  assert.ok(/type: 'steer'/.test(webIoSrc), 'web-io 必须把注入事件翻成 SSE type=steer');
  const calls = agentSrc.match(/drainSteeringInto\(steering, messages, io\)/g) || [];
  assert.ok(calls.length >= 3, 'agent 必须有"每步边界 + 收尾分支"两处 drain（含定义共 ≥3 处引用）');
  ok('接线绊线：前端 /api/steer + 回落排队 + steerStrip / server 清理 / agent 两处 drain');
}

console.log(`✅ test/steering.js：${passed} 项通过（viewmodel 纯语义 + agent 桩注入/不结束 + 真实 HTTP 状态码与 SSE + 接线绊线）`);
process.exit(0);
