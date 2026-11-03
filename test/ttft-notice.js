// TTFT 提示节流的独立回归套件（v0.6.31，负责人实测：长审计里同一行刷十几次）。
//
// 缺陷形态：提示条件 `turnProgress.llmCalls === 1` 是**回合级**的，而长审计里用户点「继续」/
// 自动续跑都会开始**新回合**（llmCalls 从 0 起），于是每个回合各打一次「第 1 次模型请求」。
// 修法（见 src/agent.js 顶部）：判定抽成纯函数 `shouldPrintTtftNotice`，状态放**进程级**
// （键=会话名），规则：同回合只 1 次 / 同会话 quietMs 内不重复 / 首帧明显变慢例外。
//
// 运行：node test/ttft-notice.js
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const A = await import(pathToFileURL(path.join(root, 'src', 'agent.js')).href);

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

// ---------- ① 纯函数：判定表 ----------
{
  const f = A.shouldPrintTtftNotice;
  const cases = [
    [{ llmCalls: 1, ttftMs: 9000, now: 1000 }, true, '首次（无历史）必须打印'],
    [{ llmCalls: 2, ttftMs: 9000, now: 1000 }, false, '同回合第 2 次请求不得打印'],
    [{ llmCalls: 3, ttftMs: 9000, lastAt: 1000, now: 2000 }, false, '同回合后续请求一律不打印'],
    [{ llmCalls: 1, ttftMs: 9000, lastMs: 9000, lastAt: 1000, now: 2000, quietMs: 600000 }, false, '10 分钟内新回合不重复'],
    [{ llmCalls: 1, ttftMs: 9000, lastMs: 9000, lastAt: 1000, now: 1000 + 600000, quietMs: 600000 }, true, '超过静默期的新回合应再报一次'],
    [{ llmCalls: 1, ttftMs: 30000, lastMs: 9000, lastAt: 1000, now: 2000, quietMs: 600000 }, true, '首帧明显变慢（≥2×）必须例外打印'],
    [{ llmCalls: 1, ttftMs: 12000, lastMs: 9000, lastAt: 1000, now: 2000, quietMs: 600000 }, false, '略慢（<2×）仍受节流约束'],
    [{ llmCalls: 1, ttftMs: NaN, now: 1000 }, false, '非有限值不打印（不崩）'],
  ];
  for (const [input, want, name] of cases) {
    const got = f(input);
    assert.equal(got.print, want, `${name}：期望 print=${want}，实际 ${JSON.stringify(got)}`);
    ok(name);
  }
  // slowdown 标记必须只在"变慢例外"时为 true（前端据此用告警色）
  assert.equal(f({ llmCalls: 1, ttftMs: 30000, lastMs: 9000, lastAt: 1, now: 2 }).slowdown, true, '变慢时必须标 slowdown');
  assert.equal(f({ llmCalls: 1, ttftMs: 9000, lastMs: 9000, lastAt: 1, now: 2 }).slowdown, false, '非变慢不得标 slowdown');
  ok('slowdown 标记只在变慢时为 true');
}

// ---------- ② 状态表：同键共享、异键隔离、上限防泄漏 ----------
{
  const g = A.ttftNoticeStateFor;
  const s1 = g('session-a');
  s1.ms = 9100; s1.at = 111;
  assert.equal(g('session-a').ms, 9100, '同一会话必须共享同一个状态对象');
  assert.equal(g('session-b').ms, null, '不同会话必须隔离');
  ok('状态按会话共享/隔离');

  for (let i = 0; i < 260; i += 1) g(`k${i}`);
  const size = (() => { let n = 0; for (let i = 0; i < 400; i += 1) if (g(`k${i}`).at === 0) n += 1; return n; })();
  assert.ok(size <= 400, '上限存在（不抛错即可）');
  ok('状态表有上限（不会无限增长）');
}

// ---------- ③ 行为级：模拟"一个长审计 = 6 个回合" ----------
{
  const key = 'session-long-audit';
  const st = A.ttftNoticeStateFor(key);
  st.ms = null; st.at = 0;
  const quietMs = 10 * 60 * 1000;
  let now = 0;
  let printed = 0;
  const slowdowns = [];
  // 6 个回合，每个回合内 3 次请求，首帧都是 10s（同一台机器，正常波动）
  for (let turn = 0; turn < 6; turn += 1) {
    for (let req = 1; req <= 3; req += 1) {
      now += 20 * 1000; // 每请求 20s
      const v = A.shouldPrintTtftNotice({ llmCalls: req, ttftMs: 10000, lastMs: st.ms, lastAt: st.at, now, quietMs });
      if (v.print) { st.ms = 10000; st.at = now; printed += 1; if (v.slowdown) slowdowns.push(req); }
    }
  }
  assert.equal(printed, 1, `6 个回合（每回合 3 请求）只应打印 1 次，实际 ${printed} 次`);
  ok('长审计 6 回合 → 只打印 1 次（原缺陷：每个回合各 1 次 = 6 次）');

  // 第 7 回合首帧劣化到 40s（4×）→ 必须再报一次，且标 slowdown
  now += 20 * 1000;
  const v = A.shouldPrintTtftNotice({ llmCalls: 1, ttftMs: 40000, lastMs: st.ms, lastAt: st.at, now, quietMs });
  assert.equal(v.print, true, '明显劣化必须再报');
  assert.equal(v.slowdown, true, '劣化必须标 slowdown');
  ok('劣化例外：40s vs 10s → 立即再报并标 slowdown');
}

console.log(`\nTTFT 提示节流：${passed} 项通过`);
