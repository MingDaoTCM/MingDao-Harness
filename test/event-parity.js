// 双读对拍工具的回归（v0.6.42 补）。
//
// 重点不是"能对拍"，而是**主入口守卫不会静默失效**：
// 0.6.42 实测发现 `import.meta.url === \`file://${argv[1]}\`` 在两种情况下永不相等——
// Windows 盘符，以及**通过符号链接路径调用**（Node 把模块解析成 realpath，argv[1] 仍是链接路径）。
// 失效时整段 CLI 不执行、exit 0、零输出：看起来"跑过了"，实际什么都没做。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/event-parity.mjs');
let passed = 0;
const ok = (n) => { passed += 1; console.log(`  ✓ ${n}`); };

/** 造一个 home：一个会话 + 可选的事件侧车。 */
function fixture({ withEvents = true, mismatch = false, format = 2 } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-'));
  const dir = path.join(home, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 's1.jsonl');
  fs.writeFileSync(f, [
    JSON.stringify({ role: 'user', content: 'hi' }),
    JSON.stringify({ role: 'assistant', content: 'hello' }),
  ].join('\n') + '\n');
  if (withEvents) {
    const ev = path.join(dir, 's1.events.ndjson');
    const second = mismatch ? { role: 'assistant', content: 'WRONG' } : { role: 'assistant', content: 'hello' };
    const lines = [];
    // 新格式日志带 session.start.format；旧格式（format=0）没有格式戳
    if (format) lines.push(JSON.stringify({ seq: 1, time: 0, type: 'session.start', data: { session: 's1.jsonl', format } }));
    const base = lines.length + 1;
    lines.push(JSON.stringify({ seq: base, time: 1, type: 'message.append', data: { message: { role: 'user', content: 'hi' } } }));
    lines.push(JSON.stringify({ seq: base + 1, time: 2, type: 'message.append', data: { message: second } }));
    fs.writeFileSync(ev, lines.join('\n') + '\n');
  }
  return home;
}
const run = (home, scriptPath = script) => spawnSync(process.execPath, [scriptPath, '--home', home], { encoding: 'utf8' });

{
  const home = fixture();
  const r = run(home);
  assert.equal(r.status, 0, `等价会话应 exit 0：${r.stderr}`);
  assert.match(r.stdout, /对拍结果：等价 1/, '必须打印汇总（证明主入口真的执行了）');
  ok('① 等价会话：exit 0 且有汇总输出');
  fs.rmSync(home, { recursive: true, force: true });
}
{
  // 核心回归：通过符号链接目录调用（Node 解析 realpath，argv[1] 是链接路径）
  const home = fixture();
  const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-link-'));
  const link = path.join(linkDir, 'repo');
  fs.symlinkSync(root, link);
  const r = run(home, path.join(link, 'scripts/event-parity.mjs'));
  assert.equal(r.status, 0, `符号链接调用应 exit 0：${r.stderr}`);
  assert.match(r.stdout, /对拍结果：/, '符号链接调用必须真的有输出（0.6.42 的静默 exit 0 回归）');
  ok('② 经符号链接路径调用：仍有输出（主入口守卫用 realpath）');
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(linkDir, { recursive: true, force: true });
}
{
  const home = fixture({ mismatch: true });
  const r = run(home);
  assert.equal(r.status, 1, '不一致必须 exit 1');
  assert.match(r.stdout, /不一致 1/, '汇总里要数出不一致');
  ok('③ 新格式日志 + 内容不一致：exit 1 且计数正确');
  fs.rmSync(home, { recursive: true, force: true });
}
{
  const home = fixture({ withEvents: false });
  const r = run(home);
  assert.equal(r.status, 0, '无事件侧车的旧会话应跳过而不是失败');
  assert.match(r.stdout, /跳过 1/, '汇总里要数出跳过');
  ok('④ 旧会话（无侧车）：跳过，不失败');
  fs.rmSync(home, { recursive: true, force: true });
}

{
  // 旧格式（无 session.start.format）+ 内容不一致 → 历史噪声，判 incomplete、不失败。
  // 这是"不能靠前缀猜、必须有格式戳"的直接理由：同一份数据，格式戳决定它算噪声还是回归。
  const home = fixture({ mismatch: true, format: 0 });
  const r = run(home);
  assert.equal(r.status, 0, '旧格式日志不一致不应 exit 1');
  assert.match(r.stdout, /不可回溯 1/, '应计入不可回溯');
  ok('⑤ 旧格式日志 + 不一致：判 incomplete（不失败）');
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(`\nevent-parity：${passed} 项通过`);
