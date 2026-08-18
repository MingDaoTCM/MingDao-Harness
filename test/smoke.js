// MingDao-Harness 冒烟测试：不依赖网络，用 Stub Provider 走完整 Agent 循环。
// 运行：node test/smoke.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

const { createAgent } = await import(path.join(srcDir, 'agent.js'));
const { parseStream } = await import(path.join(srcDir, 'providers/openai-compatible.js'));
const { approxTokens, trimMessages, clampText } = await import(path.join(srcDir, 'context.js'));
const { dispatch } = await import(path.join(srcDir, 'tools/index.js'));
const { saveConfig, loadConfig } = await import(path.join(srcDir, 'config.js'));
const { createIO } = await import(path.join(srcDir, 'ui.js'));

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ---------- 1. token 估算与上下文裁剪 ----------
{
  const en = approxTokens('hello world hello world');
  const zh = approxTokens('你好世界');
  assert.ok(zh >= 4 && en < zh + 4, 'CJK 估算应显著高于等长英文');
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
  assert.ok(trimmed.some((m) => m.content?.includes('上下文管理')), '应插入裁剪说明');
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
  ok('tools：bash 输出与退出码（跨平台）');
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

// ---------- 6. 权限引擎 ----------
{
  const io = createIO({ quiet: true });
  const { createPermission } = await import(path.join(srcDir, 'permissions.js'));
  const auto = createPermission('auto', io);
  assert.equal(await auto.check('bash', { command: 'rm -rf /' }), true);
  const readonly = createPermission('readonly', io);
  assert.equal(await readonly.check('read', {}), true);
  assert.equal(await readonly.check('write', {}), false);
  const obj = createPermission({ mode: 'ask', allow: ['bash'], deny: ['write'] }, io);
  assert.equal(await obj.check('bash', {}), true);
  assert.equal(await obj.check('write', {}), false);
  assert.equal(await obj.check('grep', {}), true);
  ok('permissions：auto / readonly / 规则对象');
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
  delete process.env.MINGDAO_HOME;
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
  delete process.env.MINGDAO_HOME;
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
  const io12 = createIO({ quiet: true });
  const p = createPermission({ mode: 'ask', allow: ['bash:git *'], deny: ['bash:rm *', 'write'] }, io12);
  assert.equal(await p.check('bash', { command: 'git status --short' }), true, 'allow 前缀匹配');
  assert.equal(await p.check('bash', { command: 'rm -rf /tmp/x' }), false, 'deny 前缀匹配');
  assert.equal(await p.check('write', {}), false, 'deny 精确匹配');
  assert.equal(await p.check('grep', {}), true, '只读默认放行');
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

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n全部通过：${passed} 组断言 ✓`);
