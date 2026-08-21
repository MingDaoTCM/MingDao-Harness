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

// ---------- 14. 精确 tokenizer ----------
{
  const { countTokens, heuristicTokens } = await import(path.join(srcDir, 'tokenizer.js'));
  const en = countTokens('Hello world', 'deepseek-v4-flash');
  assert.ok(en >= 1 && en <= 4, `英文短句 token 数应在合理范围（得到 ${en}）`);
  const zh = countTokens('你好世界', 'deepseek-v4-flash');
  assert.ok(zh >= 2 && zh <= 10, `中文短词 token 数应在合理范围（得到 ${zh}）`);
  // 混合长文本：与真实 API 口径一致（真实系统提示实测 1344 字符 ≈ 2052 token，比率 < 1.7）
  const long = '人工智能正在改变世界，MingDao 让每个人都拥有自己的智能体。MCP 连接外部工具，tokenizer 精确计量，WebUI 开箱即用。'.repeat(150);
  const lt = countTokens(long, 'deepseek-v4-pro');
  assert.ok(lt > long.length * 0.5 && lt < long.length * 2.0, `长文本计数应在真实口径区间（${lt}/${long.length}）`);
  // 非 deepseek 模型回退启发式
  assert.equal(countTokens('hello', 'gpt-4o'), heuristicTokens('hello'));
  // 特殊 token 记 1
  assert.equal(countTokens('<｜begin▁of▁sentence｜>', 'deepseek-v4-flash'), 1);
  ok('tokenizer：词表计数 / 回退启发式 / 特殊 token');
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
  delete process.env.MINGDAO_HOME;
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
  delete process.env.MINGDAO_HOME;
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
  delete process.env.MINGDAO_HOME;
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
  delete process.env.MINGDAO_HOME;
  fs.rmSync(homeRg, { recursive: true, force: true });
  fs.rmSync(regRoot, { recursive: true, force: true });
  ok('skill-registry：远端搜索 / 安装 / 缓存与强制刷新 / 未知技能');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n全部通过：${passed} 组断言 ✓`);
