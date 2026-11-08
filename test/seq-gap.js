// SSE 序号跳号 → 整窗重取（v0.6.41 §1.1 切片 B1 的客户端一半）的回归。
//
// 运行：node test/seq-gap.js
//
// 为什么单独一套：
//   · `seqContinuity` / `resyncPlan` / `seqBanner` 的细测在 `test/viewmodel.js`（那里还有搬家对拍）；
//   · 本套件补它测不到的两件事：
//       ① **接线约定**：app.js 必须"每帧先判连续性 → accept 回填 streamSeq → ignore 只跳过有 seq 的重复帧
//          → 跳号按 resyncPlan 重取 → 失败/无处可重取必须可见 → 成功插 seqBanner"；
//       ② 用一个独立的小型分派模型按真实调用顺序跑一遍，钉死"跳号不逐帧续接"的行为语义。
//
// 两个编号域（B1 的关键约束）：
//   · `streamSeq`：每个 task（每轮 SSE 流）从 1 起，只判"这一轮流有没有丢帧"；
//   · `/api/session.lastEventSeq`：会话事件日志游标，跨轮单调，**只用于 B2 与测试**，不参与流游标。
//   混用会让同一会话第二轮首帧 seq=1 被判成旧帧、整轮不渲染——本套件专门钉住这条。
//
// 约束：不启动浏览器、不读 DOM；app.js 依赖 document，node 不能直接 import，所以接线用源码断言，
// 行为用纯函数 + 同序分派模型验证。**不修改 test/e2e-web.js**（那套只跑旧服务端无 seq 的兼容路径）。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seqContinuity, resyncPlan, seqBanner } from '../src/web/viewmodel.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(root, 'src/web/app.js'), 'utf8');

let passed = 0;
/** @param {boolean} cond @param {string} msg */
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed += 1;
  console.log(`  ✓ ${msg}`);
}
/** @param {any} a @param {any} b @param {string} msg */
function eq(a, b, msg) {
  assert.deepEqual(a, b, msg);
  passed += 1;
  console.log(`  ✓ ${msg}`);
}

// ---------------------------------------------------------------------------
// ① 判定表：跳号不 accept、重复不重放、无 seq 不误判
// ---------------------------------------------------------------------------
{
  eq(seqContinuity({ lastSeq: 0, incomingSeq: 1 }).action, 'accept', '首帧 1 → accept');
  eq(seqContinuity({ lastSeq: 0, incomingSeq: 5 }).action, 'resync', '首帧必须是 1，否则要 resync');
  eq(seqContinuity({ lastSeq: 4, incomingSeq: 5 }).action, 'accept', 'streamSeq+1 → accept（连续）');

  eq(seqContinuity({ lastSeq: 4, incomingSeq: 4 }).action, 'ignore', '重复帧必须 ignore（否则正文双写）');
  eq(seqContinuity({ lastSeq: 4, incomingSeq: 2 }).action, 'ignore', '乱序旧帧必须 ignore');

  eq(seqContinuity({ lastSeq: 4, incomingSeq: 6 }).action, 'resync', '跳号必须 resync（不能当连续帧渲染）');
  eq(seqContinuity({ lastSeq: 4, incomingSeq: 6 }).gap, 1, 'gap 必须等于缺多少（漏 1 条时是 1）');
  eq(seqContinuity({ lastSeq: 3, incomingSeq: 7 }).gap, 3, 'gap 必须等于缺多少（7-3-1=3）');

  eq(seqContinuity({ lastSeq: 9, incomingSeq: null }), { ok: true, gap: 0, action: 'ignore' }, 'null 帧必须 ignore（旧服务端兼容）');
  eq(seqContinuity({ lastSeq: 9, incomingSeq: undefined }).action, 'ignore', 'undefined 帧必须 ignore');
}

// ---------------------------------------------------------------------------
// ② 救援只有两态：有会话 → snapshot；没有会话 → none（B1 不做事件重放）
// ---------------------------------------------------------------------------
{
  eq(resyncPlan({ gap: 2, hasSession: true, hasTask: true }).mode, 'snapshot', '有会话必须选 snapshot（整窗重取优先）');
  eq(resyncPlan({ gap: 2, hasSession: false, hasTask: true }).mode, 'none', '没有会话必须选 none（新会话首轮不重建空窗口）');
  eq(resyncPlan({ gap: 2, hasSession: false, hasTask: false }).mode, 'none', '都没有 → none');
  eq(resyncPlan({ gap: 2, hasSession: false }).mode === 'events', false, 'B1 不得再有 events 模式（投影属 B2）');
  ok(resyncPlan({ gap: 2 }).reason.length > 0, 'resyncPlan 必须给出可读 reason');
  eq(seqBanner({ gap: 2 }), '已跳过 2 条事件，正在重新同步…', 'seqBanner 文案带真实 gap');
  eq(seqBanner({ gap: 0 }), '', 'gap<=0 不插提示');
}

// ---------------------------------------------------------------------------
// ③ 同序分派模型：按 app.js 的约定跑一遍，验证"跳号 → 暂停 → 快照 → 从 atSeq 继续"
//    （模型只做闸门与重取计划，不复制业务渲染；业务分派的接线由 ④ 的源码断言钉住）
// ---------------------------------------------------------------------------
/**
 * @param {Array<{streamSeq?:number|null, type:string}>} frames
 * @param {{hasSession?:boolean}} [opts]
 */
function runStream(frames, opts = {}) {
  const hasSession = opts.hasSession !== false;
  let streamSeq = 0;
  /** @type {string[]} */
  const rendered = [];
  /** @type {Array<{gap:number, mode:string}>} */
  const resyncs = [];
  for (const ev of frames) {
    const gate = seqContinuity({ lastSeq: streamSeq, incomingSeq: ev.streamSeq });
    if (gate.action === 'accept') {
      streamSeq = Number(ev.streamSeq);
      rendered.push(ev.type);
    } else if (gate.action === 'resync') {
      const plan = resyncPlan({ gap: gate.gap, hasSession });
      resyncs.push({ gap: gate.gap, mode: plan.mode });
      // snapshot：快照代表到 atSeq 为止；none/失败：警告后也不丢后续帧。
      // 两种情况都把游标推进到 atSeq，让 atSeq+1 起继续渲染。
      streamSeq = Math.max(streamSeq, Number(ev.streamSeq));
    } else if (ev.streamSeq != null) {
      continue; // 重复/乱序：只跳过这一帧
    } else {
      rendered.push(ev.type); // 无 seq 帧：业务照常（旧服务端兼容）
    }
  }
  return { streamSeq, rendered, resyncs };
}

{
  const normal = runStream([
    { streamSeq: 1, type: 'a' },
    { streamSeq: 2, type: 'b' },
    { streamSeq: 3, type: 'c' },
  ]);
  eq(normal.rendered, ['a', 'b', 'c'], '连续流：三帧全部按序渲染');
  eq(normal.resyncs, [], '连续流：一次重取都不触发');

  const gapped = runStream([
    { streamSeq: 1, type: 'a' },
    { streamSeq: 4, type: 'd' },
    { streamSeq: 5, type: 'e' },
  ]);
  eq(gapped.rendered, ['a', 'e'], '跳号：缺口帧不渲染；快照后从 atSeq+1 继续（不逐帧续接也不要卡死）');
  eq(gapped.resyncs, [{ gap: 2, mode: 'snapshot' }], '跳号：gap=2，有会话时走 snapshot');
  eq(gapped.streamSeq, 5, '快照后流游标推进到 atSeq，再随新帧前进');

  const noSeq = runStream([
    { streamSeq: null, type: 'a' },
    { type: 'b' },
    { streamSeq: undefined, type: 'c' },
  ]);
  eq(noSeq.rendered, ['a', 'b', 'c'], '旧服务端：无 seq 帧全部照常渲染');
  eq(noSeq.resyncs, [], '旧服务端：无 seq 不触发重取');

  const dup = runStream([
    { streamSeq: 1, type: 'a' },
    { streamSeq: 1, type: 'a' },
    { streamSeq: 2, type: 'b' },
  ]);
  eq(dup.rendered, ['a', 'b'], '重复帧：只渲染一次');

  const noSession = runStream(
    [
      { streamSeq: 1, type: 'a' },
      { streamSeq: 9, type: 'z' },
      { streamSeq: 10, type: 'j' },
    ],
    { hasSession: false }
  );
  eq(noSession.resyncs, [{ gap: 7, mode: 'none' }], '没有会话：计划为 none（不重建空窗口）');
  eq(noSession.rendered, ['a', 'j'], 'none 后仍从 atSeq+1 继续渲染（警告不等于丢光后续帧）');
}

// ---------------------------------------------------------------------------
// ④ 接线约定（app.js 源码）：每一处缺失都意味着"跳号被当成正常"或"失败被静默"
// ---------------------------------------------------------------------------
{
  ok(app.includes("import { seqContinuity, resyncPlan, seqBanner } from './viewmodel.js';"), 'app.js 引入三个纯函数');
  ok(app.includes('let streamSeq = 0;'), '每轮 send() 从 0 起算**流游标** streamSeq');
  ok(!/lastEventSeq\s*=/.test(app), '不拿 /api/session.lastEventSeq 当流游标（两套编号域）');
  ok(
    !/streamSeq\s*=\s*[^;\n]*lastEventSeq/.test(app),
    'streamSeq 不得由事件日志游标初始化'
  );
  ok(app.includes('const gate = seqContinuity({ lastSeq: streamSeq, incomingSeq: ev?.streamSeq });'), '每帧先调 seqContinuity 做判定');
  ok(
    app.indexOf('const gate = seqContinuity(') > 0 &&
      app.indexOf('const gate = seqContinuity(') < app.indexOf("if(ev.type==='progress')") &&
      app.indexOf('const gate = seqContinuity(') < app.indexOf("if(ev.type==='text')"),
    '序号判定先于业务分派（progress/text 之前）'
  );
  ok(app.includes("if (gate.action === 'accept') streamSeq = Number(ev.streamSeq);"), 'accept 后必须回填 streamSeq');
  ok(app.includes('else if (ev?.streamSeq != null) return;'), 'ignore 只跳过有 streamSeq 的重复帧（无 streamSeq 帧业务照常）');
  ok(app.includes("msg._traj.push({kind:'tool', seq:ev.seq") && app.includes('runningTools.delete(ev.seq)'), '工具配对仍用既有 seq（不得被 streamSeq 顶替）');
  ok(app.includes("else if (gate.action === 'resync') { beginResync(gate.gap, ev.streamSeq); return; }"), 'resync 走 beginResync(gap, atSeq)，不继续渲染当前帧');
  ok(app.includes('resyncPlan({ gap, hasSession: !!currentSession })'), '按 resyncPlan 决定救援方式');
  ok(
    /plan\.mode === 'snapshot'[\s\S]{0,200}await loadSession\(currentSession\)/.test(app),
    'snapshot 复用 loadSession 整窗重渲染'
  );
  ok(!app.includes("fetch('/api/events?file='"), 'B1 客户端不消费 /api/events（会话事件→UI 投影属 B2）');
  ok(
    /事件流中断且重取失败，请刷新页面[\s\S]{0,160}chatEl\.appendChild\(d\)/.test(app),
    '重取失败必须在对话流里可见（不许静默）'
  );
  ok(app.includes('const banner = seqBanner({ gap });') && /seqBanner\(\{ gap \}\)[\s\S]{0,200}msg-sys/.test(app), '重取成功用 seqBanner 文案插 msg-sys');
  ok(app.includes('streamSeq = Math.max(streamSeq, Number(atSeq) || streamSeq);'), 'snapshot 后把流游标推进到 atSeq（后续帧从 atSeq+1 开始）');
  ok(app.includes('await handleEvents(resp.body, onEvent);'), '分派器走同一条 onEvent（重取后可重放暂存帧）');
}

console.log(`\n✅ test/seq-gap.js：${passed} 项通过（判定表 + 两态救援 + 同序分派模型 + app.js 接线约定）`);
