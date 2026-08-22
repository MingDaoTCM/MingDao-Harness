// MingDao-Harness 冒烟测试：不依赖网络，用 Stub Provider 走完整 Agent 循环。
// 运行：node test/smoke.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

const { createAgent } = await import(path.join(srcDir, 'agent.js'));
const { parseStream } = await import(path.join(srcDir, 'providers/openai-compatible.js'));
const { approxTokens, trimMessages, clampText } = await import(path.join(srcDir, 'context.js'));
const { dispatch } = await import(path.join(srcDir, 'tools/index.js'));
const { saveConfig, loadConfig } = await import(path.join(srcDir, 'config.js'));
const { createIO } = await import(path.join(srcDir, 'ui.js'));

// 全局隔离：整个测试期间审计/记忆/技能等写入临时 home，绝不污染真实 ~/.mingdao
const smokeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-smoke-home-'));
process.env.MINGDAO_HOME = smokeHome;

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ---------- 1. token 估算与上下文裁剪 ----------
{
  const en = approxTokens('hello world hello world');
  const zh = approxTokens('你好世界');
  // CJK 校准（P0-2）：流畅中文 ≈0.75 token/字（旧版 1 字=1 token 高估约 2 倍）
  assert.equal(zh, 3, '4 字中文应按 0.75/字计为 3 tokens');
  assert.equal(en, 6, '英文按 4 字符/token 估算');
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

// ---------- 3. bash 工具（跨平台：Windows 走 cmd.exe） ----------
{
  const isWin = process.platform === 'win32';
  const r = await dispatch('bash', { command: isWin ? 'echo mingdao-2' : 'echo mingdao-$((1+1))' }, ctx);
  assert.equal(r.ok, true);
  assert.ok(r.stdout.includes('mingdao-2'));
  const fail = await dispatch('bash', { command: isWin ? 'exit /b 3' : 'exit 3' }, ctx);
  assert.equal(fail.exitCode, 3);
  // 沙箱敏感环境变量过滤（P1-5）：沙箱开启时 API Key/Token/Secret 一律不可见，off 时保持原样
  if (!isWin) {
    process.env.MINGDAO_TEST_API_KEY = 'sk-secret-probe';
    process.env.MINGDAO_TEST_TOKEN = 'tk-probe';
    const sandboxCtx = { ...ctx, cfg: { ...ctx.cfg, sandbox: 'readonly' } };
    const on = await dispatch('bash', { command: 'echo "k=$MINGDAO_TEST_API_KEY t=$MINGDAO_TEST_TOKEN"' }, ctx);
    assert.ok(on.stdout.includes('k=sk-secret-probe'), 'sandbox off 应保留环境变量');
    const off = await dispatch('bash', { command: 'echo "k=$MINGDAO_TEST_API_KEY t=$MINGDAO_TEST_TOKEN"' }, sandboxCtx);
    assert.ok(!off.stdout.includes('sk-secret-probe') && !off.stdout.includes('tk-probe'), '沙箱模式应剥离敏感变量');
    const keptCtx = { ...ctx, cfg: { ...ctx.cfg, sandbox: 'readonly', bashEnvKeep: ['MINGDAO_TEST_TOKEN'] } };
    const kept = await dispatch('bash', { command: 'echo "k=$MINGDAO_TEST_API_KEY t=$MINGDAO_TEST_TOKEN"' }, keptCtx);
    assert.ok(!kept.stdout.includes('sk-secret-probe') && kept.stdout.includes('tk-probe'), 'bashEnvKeep 应按名放行');
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
  ok('provider：SSE 流解析（断行/分片/usage）');
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
  const { createPermission } = await import(path.join(srcDir, 'permissions.js'));
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
  } = await import(path.join(srcDir, 'credentials.js'));

  // config.json 不含任何密钥（可安全分享/提交）
  saveConfig({ provider: 'deepseek', model: 'deepseek-v4-pro', permission: 'ask', contextBudget: 123456 });
  const loaded = loadConfig();
  assert.equal(loaded.model, 'deepseek-v4-pro');
  assert.equal(loaded.contextBudget, 123456);
  assert.equal('apiKey' in loaded, false, 'config.json 不应包含 apiKey 字段');
  assert.equal(fs.statSync(path.join(home2, 'config.json')).mode & 0o777, 0o600, '配置文件权限应为 600');

  // 凭证库：独立文件、600 权限、脱敏显示
  const key = 'sk-test-abcdef1234567890';
  setStoredKey('deepseek', key);
  assert.equal(getStoredKey('deepseek'), key);
  assert.equal(fs.statSync(credentialsPath()).mode & 0o777, 0o600, '凭证文件权限应为 600');
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
  const { createSession, appendMessages, loadSession, latestSession } = await import(path.join(srcDir, 'session.js'));
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
  const { listSkills, loadSkill } = await import(path.join(srcDir, 'skills.js'));
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
  fs.rmSync(proj, { recursive: true, force: true });
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
  fs.rmSync(d, { recursive: true, force: true });
  ok('undo：撤销 write/edit 的最近修改');
}

// ---------- 12. 权限规则模式匹配 ----------
{
  const { createPermission } = await import(path.join(srcDir, 'permissions.js'));
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
  ok('permissions：工具名:参数前缀 规则匹配');
}

// ---------- 13. Hooks ----------
{
  const { createHooks } = await import(path.join(srcDir, 'hooks.js'));
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
  const { createProvider } = await import(path.join(srcDir, 'providers/index.js'));
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

// ---------- 14. 精确 tokenizer ----------
{
  const { countTokens, heuristicTokens } = await import(path.join(srcDir, 'tokenizer.js'));
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
  assert.equal(heuristicTokens('🎉'), 1, 'emoji 保持 1（不低估）');
  // 计数缓存（P2-7）：同一文本重复计数结果一致（且第二次走缓存路径）
  const cachedText = '人工智能与 tokenizer 精确计量，缓存命中后速度提升。';
  const c1 = countTokens(cachedText, 'deepseek-v4-flash');
  const c2 = countTokens(cachedText, 'deepseek-v4-flash');
  assert.equal(c1, c2, '缓存路径计数应与首次一致');
  // 特殊 token 记 1
  assert.equal(countTokens('<｜begin▁of▁sentence｜>', 'deepseek-v4-flash'), 1);
  ok('tokenizer：官方黄金值 12 组 / 长文本 / 回退启发式 / 特殊 token / CJK 校准 / 缓存');
}

// ---------- 15. MCP 客户端 ----------
{
  const { startMcpServers } = await import(path.join(srcDir, 'mcp.js'));
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
  assert.equal(mcp.isReadonly('mcp__mock__readonly_peek'), true);
  assert.equal(mcp.isReadonly('mcp__mock__echo'), false);
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
  const { detectSandbox } = await import(path.join(srcDir, 'tools/bash.js'));
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
    fs.rmSync(d16, { recursive: true, force: true });
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
  const { routeTask, heuristicRoute, routingConfig, subagentModel } = await import(path.join(srcDir, 'routing.js'));
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
  ok('routing：启发式 / 分类器 / 池外不干预 / 子代理 executor');
}

// ---------- 18. 会话检索 ----------
{
  const { searchSessions, createSession: cs18, appendMessages: ap18 } = await import(path.join(srcDir, 'session.js'));
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
  fs.rmSync(home18, { recursive: true, force: true });
  ok('sessions：全文检索 / 片段 / 空关键词');
}

// ---------- 19. 工作空间 ----------
{
  const homeW = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-ws-'));
  const projA = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-wsa-'));
  process.env.MINGDAO_HOME = homeW;
  const { addWorkspace, removeWorkspace, workspacePath, touchWorkspace, listWorkspaces, currentWorkspace } = await import(path.join(srcDir, 'workspace.js'));
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
  fs.rmSync(homeW, { recursive: true, force: true });
  fs.rmSync(projA, { recursive: true, force: true });
  ok('workspace：登记 / 校验 / 列表 / 识别当前 / 移除');
}

// ---------- 20. 开机自启（隔离 HOME） ----------
{
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-home-'));
  const oldHome = process.env.HOME;
  process.env.HOME = fakeHome;
  const { enableAutostart, disableAutostart, autostartStatus, autostartPath } = await import(path.join(srcDir, 'autostart.js'));
  assert.equal(autostartStatus(), false, '初始应为关');
  assert.equal(enableAutostart(), true);
  assert.equal(autostartStatus(), true, '开启后应为开');
  assert.ok(fs.existsSync(autostartPath()), '应存在自启文件');
  assert.equal(disableAutostart(), true);
  assert.equal(autostartStatus(), false, '关闭后应为关');
  process.env.HOME = oldHome;
  fs.rmSync(fakeHome, { recursive: true, force: true });
  ok('autostart：开 / 关 / 状态（隔离 HOME）');
}

// ---------- 21. 桌面通知（静默不抛） ----------
{
  const { notify, notifyTaskDone } = await import(path.join(srcDir, 'notify.js'));
  notify('MingDao', '测试通知'); // 无桌面环境时静默忽略，绝不应抛错
  notifyTaskDone('测试任务', 'done');
  notifyTaskDone('失败任务', 'failed');
  ok('notify：调用不抛错（环境自适应静默）');
}

// ---------- 22. 长记忆：提取去重 + 会话日志 ----------
{
  const homeM = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-mem-'));
  process.env.MINGDAO_HOME = homeM;
  const { loadMemory, appendMemory, appendJournal, recentJournal, recentJournalBlock, extractMemory } = await import(path.join(srcDir, 'memory.js'));
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
  fs.rmSync(homeM, { recursive: true, force: true });
  ok('memory：提取 / 追加 / 无新增 / 日志 / 最近块');
}

// ---------- 23. 缓存感知计价 ----------
{
  const { estimateCost, estimateCostLabel, cacheSplit } = await import(path.join(srcDir, 'pricing.js'));
  const split = cacheSplit({ prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400 });
  assert.deepEqual(split, { hit: 600, miss: 400, rate: 0.6 });
  const withCache = estimateCost('deepseek-v4-flash', 1000, 100, { hit: 600, miss: 400 }, new Date('2026-08-21T03:00:00'));
  const noCache = estimateCost('deepseek-v4-flash', 1000, 100, null, new Date('2026-08-21T03:00:00'));
  assert.ok(withCache < noCache * 0.6, '缓存计价应显著低于全未命中 ' + withCache + ' vs ' + noCache);
  const label = estimateCostLabel('deepseek-v4-flash', 1000, 100, { prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400 });
  assert.ok(label.includes('缓存命中 60%'), label);
  // 多模态视觉模型预设（deepseek-v4-flash-vision-exp，与 flash 同价）
  const { modelPreset } = await import(path.join(srcDir, 'models.js'));
  const vision = modelPreset('deepseek-v4-flash-vision-exp');
  assert.ok(vision && vision.supportsVision === true, '视觉模型预设应存在且标注 supportsVision');
  assert.deepEqual(vision.pricing, modelPreset('deepseek-v4-flash').pricing, '视觉模型价格应与 V4-Flash 一致');
  const visionCost = estimateCost('deepseek-v4-flash-vision-exp', 1000, 100, null, new Date('2026-08-21T03:00:00'));
  assert.ok(visionCost > 0, '视觉模型应可计价');
  ok('pricing：缓存拆分 / 命中价 / 命中率标签');
}

// ---------- 24. 技能库与自定义安装 ----------
{
  const homeSk = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-skilllib-'));
  process.env.MINGDAO_HOME = homeSk;
  const { libraryList, searchLibrary, installFromLibrary, installFromDir, installFromUrl, installFromGit, installSkill, uninstallSkill, reinstallSkill, installedUserSkillNames, userSkillsDir } =
    await import(path.join(srcDir, 'skill-lib.js'));
  const { listSkills } = await import(path.join(srcDir, 'skills.js'));

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
  fs.rmSync(dirSrc, { recursive: true, force: true });

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
  const r3 = await installFromUrl(`http://127.0.0.1:${urlPort}/SKILL.md`);
  assert.ok(r3.name === 'remote-skill', 'URL 安装应成功');
  const badUrl = await installFromUrl(`http://127.0.0.1:${urlPort}/nope.md`);
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
  fs.rmSync(badDir, { recursive: true, force: true });

  // git 安装：无 git 环境优雅报错，不抛异常
  const gitR = installFromGit('https://example.com/x.git');
  assert.ok(gitR.names || gitR.error, 'git 安装应返回结果或错误而非抛出');

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
  fs.rmSync(homeSk, { recursive: true, force: true });
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
  const { searchRegistry, installFromRegistry, fetchRegistryIndex } = await import(path.join(srcDir, 'skill-registry.js'));
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
  fs.rmSync(homeRg, { recursive: true, force: true });
  fs.rmSync(regRoot, { recursive: true, force: true });
  ok('skill-registry：远端搜索 / 安装 / 缓存与强制刷新 / 未知技能');
}

// ---------- 26. 云同步（服务端 + 客户端闭环） ----------
{
  const homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-sync-a-'));
  const homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-sync-b-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-sync-data-'));
  const { runSyncServer } = await import(path.join(srcDir, 'sync-server.js'));
  const srv = runSyncServer({ port: 0, host: '127.0.0.1', dataDir });
  await new Promise((r) => srv.once('listening', r));
  const syncPort = srv.address().port;
  const { syncLogin, syncPush, syncPull, syncRemoteList, syncStatus, syncLogout } = await import(path.join(srcDir, 'sync.js'));

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
  assert.ok(pullA2.conflicts.includes('sync-smoke.jsonl'), '本地有未推送改动时 pull 应报冲突');
  assert.ok(fs.readdirSync(path.join(homeA, 'sessions')).some((f) => f.includes('.remote-')), '应生成 .remote- 副本');

  // 错误路径与状态
  const badPass = await syncLogin({ url: `http://127.0.0.1:${syncPort}`, username: 'smoketest', password: 'wrong-password', deviceName: 'x' });
  assert.ok(badPass.error && badPass.error.includes('密码'), '错误密码应友好提示');
  assert.ok(syncStatus().loggedIn, '状态应显示已登录');
  const out = syncLogout();
  assert.equal(out.ok, true);
  assert.ok(!syncStatus().loggedIn, '退出后应未登录');

  srv.close();
  process.env.MINGDAO_HOME = smokeHome;
  fs.rmSync(homeA, { recursive: true, force: true });
  fs.rmSync(homeB, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
  ok('sync：注册登录 / 推送拉取 / 双端冲突备份 / 退出 / 错误路径');
}

// ---------- 26b. 同步服务端注册开关（invite 邀请码 / closed，P3-10） ----------
{
  const regDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-sync-reg-'));
  async function startRegServer(envExtra) {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', `import { runSyncServer } from ${JSON.stringify(path.join(srcDir, 'sync-server.js'))}; const srv = runSyncServer({ port: 0, host: '127.0.0.1', dataDir: ${JSON.stringify(regDir)} }); srv.on('listening', () => console.log('PORT ' + srv.address().port));`],
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
  fs.rmSync(regDir, { recursive: true, force: true });
  ok('sync-server：注册开关 invite（邀请码）/ closed');
}

// ---------- 27. 云协作 M2：密码修改 / 会话分享 / 冲突解决 ----------
{
  const homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-col-a-'));
  const homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-col-b-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-col-data-'));
  const { runSyncServer } = await import(path.join(srcDir, 'sync-server.js'));
  const srv = runSyncServer({ port: 0, host: '127.0.0.1', dataDir });
  await new Promise((r) => srv.once('listening', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const { syncLogin, syncPush, syncPull, syncChangePassword, syncShareCreate, syncShareList, syncShareAccept, syncShareRevoke, listSyncConflicts, resolveSyncConflict } =
    await import(path.join(srcDir, 'sync.js'));

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
  fs.rmSync(homeA, { recursive: true, force: true });
  fs.rmSync(homeB, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
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
  const { setStoredKey } = await import(path.join(srcDir, 'credentials.js'));
  const { fetchProviderModels, availableModels, providerHasKey } = await import(path.join(srcDir, 'model-discovery.js'));
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
  fs.rmSync(homeM, { recursive: true, force: true });
  ok('model-discovery：只列有 Key 服务商 / 线上名单优先 / 缓存与强制刷新 / 回退预设');
}

// ---------- 29. 聊天附件构造（图片 / 文本文件） ----------
{
  const { buildUserContent } = await import(path.join(srcDir, 'web', 'attachments.js'));
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
  const { buildSystemPrompt } = await import(path.join(srcDir, 'prompts.js'));
  const fresh = buildSystemPrompt({ modelName: 'deepseek-v4-flash', workingDir: tmp });
  assert.ok(!fresh.includes('recent_sessions') && !fresh.includes('愤怒的小鸟'), '新会话默认不应注入最近会话日志');
  const withJ = buildSystemPrompt({ modelName: 'deepseek-v4-flash', workingDir: tmp, withJournal: true });
  assert.ok(withJ.includes('recent_sessions') && withJ.includes('愤怒的小鸟'), 'withJournal 开启时应注入最近会话日志');
  process.env.MINGDAO_HOME = smokeHome;
  fs.rmSync(jhome, { recursive: true, force: true });
  ok('prompts：最近会话日志默认不注入（--journal / WebUI「带上文」显式开启）');
}

// ---------- 31. 自更新模块（临时 git 仓库演练，P3-9 落实） ----------
{
  const { updateCheck, mingdaoUpdate, mingdaoRollback } = await import(path.join(srcDir, 'update.js'));
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
  fs.rmSync(base, { recursive: true, force: true });
  ok('update：版本对比 / 脏工作区拒绝 / 升级+冒烟 / 回滚');
}

// ---------- 32. 上下文自动压缩模块（P3-1） ----------
{
  const { compactConversation } = await import(path.join(srcDir, 'compact.js'));
  const { approxTokens } = await import(path.join(srcDir, 'context.js'));
  let summaryCalls = 0;
  const summaryProvider = {
    async chat() {
      summaryCalls += 1;
      return {
        text: '压缩摘要：用户要做一个计算器，已完成加法，未完成减法；创建了 calc.js。',
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
  ok('compact：触发条件 / 摘要注入 / 配对清洗 / 用量带回 / 失败回退');
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
  const { installFromRegistry } = await import(path.join(srcDir, 'skill-registry.js'));
  const { listSkills, tamperedSkillNames } = await import(path.join(srcDir, 'skills.js'));
  const { trustSkill, skillDirHash } = await import(path.join(srcDir, 'skill-lib.js'));
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
  fs.rmSync(path.join(homeS, 'skill-registry-cache.json'), { force: true });
  const bad = await installFromRegistry('demo-bad');
  assert.ok(bad.error && bad.error.includes('完整性校验失败'), '哈希不符应拒绝安装');
  // 5) 目录哈希稳定（排除元数据文件）
  assert.equal(skillDirHash(path.join(homeS, 'skills', 'demo-int')), skillDirHash(path.join(homeS, 'skills', 'demo-int')), '哈希应稳定');
  regServer.close();
  delete process.env.MINGDAO_REGISTRY_URL;
  process.env.MINGDAO_HOME = smokeHome;
  fs.rmSync(homeS, { recursive: true, force: true });
  ok('skill 完整性：registry sha256 校验 / 篡改拒绝加载 / trust / 哈希稳定');
}

// ---------- 35. 工具调用审计日志（P3-5） ----------
{
  const homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-audit-'));
  process.env.MINGDAO_HOME = homeA;
  const { listAudit, auditFile, redactSecrets } = await import(path.join(srcDir, 'audit.js'));
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
  fs.rmSync(homeA, { recursive: true, force: true });
  ok('audit：执行/拒绝记录 / 会话归因 / 参数与原因 / sk- 脱敏 / audit:false 关闭');
}

fs.rmSync(tmp, { recursive: true, force: true });
delete process.env.MINGDAO_HOME;
fs.rmSync(smokeHome, { recursive: true, force: true });
console.log(`\n全部通过：${passed} 组断言 ✓`);
