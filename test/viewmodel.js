// 前端纯视图模型的 node 直测（v0.7.0 §1.2）。
//
// 运行：node test/viewmodel.js
//
// 本文件做三件事：
//   ① 每个搬家函数至少 6 组输入，覆盖空数组 / 单条 / 超长文本 / 缺字段 / 非法值；
//   ② 对拍：REF_* 是搬家前 app.js 的原实现（逐字复制，只把依赖的函数一起带上），
//      与 viewmodel.js 的导出用同一批输入跑，deepEqual 断言输出一致——这是"搬家没改行为"的证据；
//   ③ 形状断言：前端渲染依赖的字段名逐个钉死（改名/少字段当场红）。
//
// 约束：这里不启动浏览器、不读 DOM；只 import viewmodel.js + util.js 的纯格式化函数。

import assert from 'node:assert/strict';
import { fmtTok } from '../src/web/util.js';
import {
  sideNavBreakpoint,
  sideNavLayout,
  errCardParts,
  normalizeRunPhase,
  fmtRunTtft,
  fmtRunTps,
  fmtRunTools,
  fmtRunCost,
  fmtRunCtx,
  runStripView,
  enqueueMessage,
  dequeueMessage,
  shouldDrainQueue,
  queueView,
  queueLabel,
  QUEUE_MAX,
  applyRunProgress,
  permissionSourceLabel,
  toolArgsSummary,
  toolResultSummary,
  toolOutputText,
  toolOutputStats,
  toolStepView,
  fmtToolDur,
  toolTimelineSummary,
  toolTimelineVisibility,
  fmtTraceDur,
  subagentRowView,
  traceRoundView,
  seqContinuity,
  resyncPlan,
  seqBanner,
  EXAMPLE_PROMPTS,
  pickExamples,
} from '../src/web/viewmodel.js';

let passed = 0;
/** @param {boolean} cond @param {string} msg */
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed += 1;
}
/** @param {any} a @param {any} b @param {string} msg */
function eq(a, b, msg) {
  assert.deepEqual(a, b, msg);
  passed += 1;
}

// ===========================================================================
// 参照实现：搬家前 src/web/app.js 的原函数（逐字复制；依赖也一并复制）
// ===========================================================================

// —— sideNavLayout（原 app.js:359-369） ——
function REF_sideNavBreakpoint(width) {
  const w = Number(width) || 0;
  if (w >= 1180) return 'wide';
  if (w >= 900) return 'mid';
  return 'drawer';
}
function REF_sideNavLayout(width, pref) {
  const mode = REF_sideNavBreakpoint(width);
  const collapsed = mode === 'mid' || (mode === 'wide' && !!pref);
  return { mode, collapsed, width: mode === 'drawer' ? 0 : (collapsed ? 48 : 240), drawer: mode === 'drawer' };
}

// —— errCardParts（原 app.js:558-568） ——
function REF_errCardParts(text) {
  const rawText = String(text || '').replace(/\r\n?/g, '\n');
  const lines = rawText.split('\n');
  let hintIdx = -1;
  for (let i = 0; i < lines.length; i++) { if (/^\s*(?:💡|提示[:：]|处置建议[:：])/.test(lines[i])) { hintIdx = i; break; } }
  const hint = hintIdx >= 0 ? lines[hintIdx].trim() : '';
  const raw = (hintIdx >= 0 ? lines.slice(0, hintIdx) : lines).join('\n').trim() || rawText.trim();
  const head = (lines[0] || '').trim();
  const tag = /上游|upstream/i.test(rawText) ? '上游' : /超时|timeout/i.test(rawText) ? '内核' : '错误';
  return { head, hint, raw, tag };
}

// —— runStripView 及其依赖（原 app.js:987-1040） ——
function REF_normalizeRunPhase(rawPhase, isGenerating, aborted) {
  if (aborted) return '已中止';
  if (!isGenerating) return '空闲';
  const p = String(rawPhase || '');
  if (/已中止|已停止|aborted|stalled/.test(p)) return '已中止';
  if (/解码/.test(p)) return '解码中';
  if (/执行工具|等待权限确认|待发请求|子\s?Agent|工具/.test(p)) return '执行工具';
  return '等首帧';
}
function REF_fmtRunTtft(ms) { return ms == null || !Number.isFinite(Number(ms)) ? '—' : (Number(ms) / 1000).toFixed(1) + 's'; }
function REF_fmtRunTps(v) { return v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(1); }
function REF_fmtRunTools(n) { const k = Math.max(0, Math.round(Number(n) || 0)); return k === 0 ? '0 次工具调用' : k + ' 次工具调用'; }
function REF_fmtRunCost(cost) { const m = String(cost || '').match(/≈¥[0-9.]+/); return m ? m[0] : ''; }
function REF_fmtRunCtx(st) {
  const total = Number(st.contextTotal) || 0;
  const used = Math.max(0, Math.round(Number(st.contextUsed) || 0));
  if (!total && !used) return '—';
  const approx = st.contextApprox !== false;
  return (approx ? '≈ ' : '') + fmtTok(used) + ' / ' + (total ? fmtTok(total) : '?') + ' tokens';
}
function REF_runStripView(st, isGenerating) {
  return {
    phase: REF_normalizeRunPhase(st.rawPhase, isGenerating !== false, st.aborted),
    ttft: REF_fmtRunTtft(st.ttftMs),
    tps: REF_fmtRunTps(st.tokensPerSec),
    ctx: REF_fmtRunCtx(st),
    tools: REF_fmtRunTools(st.toolCalls),
    cost: REF_fmtRunCost(st.cost) || '—',
  };
}

// —— traceRoundView 及其依赖（原 app.js:1073-1210 + 1351-1418） ——
const REF_TOOL_TL_DEFAULT_VISIBLE = 3;
const REF_TOOL_OUTPUT_PREVIEW = 900;
function REF_toolArgsSummary(name, args) {
  const a = args || {};
  if (name === 'bash') return String(a.command || '');
  if (name === 'task') return String(a.question || a.prompt || a.description || '');
  return String(a.path || a.pattern || a.name || a.query || a.url || a.file || '');
}
function REF_toolResultSummary(ev) {
  if (!ev || ev.result === undefined) return '执行中…';
  const r = ev.result || {};
  if (r.ok === false) return r.error ? String(r.error).split('\n')[0] : '失败';
  if (ev.name === 'bash') return r.timedOut ? '超时' : 'exit ' + (r.exitCode != null ? r.exitCode : 0);
  if (ev.name === 'skill') {
    const m = String(r.output || '').match(/^description:\s*(.+)$/m);
    return m ? m[1].slice(0, 100) : '已加载技能';
  }
  if (ev.name === 'write') return r.bytes != null ? r.bytes + ' 字节' : '已写入';
  if (ev.name === 'edit') return '已修改';
  if (ev.name === 'read') return r.lines != null ? r.lines + ' 行' : '读取完成';
  if (ev.name === 'todo') return '更新任务清单';
  const out = String(r.output || r.stdout || r.stderr || '');
  return out.split('\n')[0].slice(0, 120);
}
function REF_toolOutputText(ev) {
  const r = (ev && ev.result) || {};
  if (ev && ev.name === 'skill') return String(r.output || '');
  if (r.diff) {
    const before = String(r.diff.before || '').split('\n');
    const after = String(r.diff.after || '').split('\n');
    const n = Math.max(before.length, after.length);
    const out = [];
    for (let i = 0; i < n; i++) {
      if (before[i] === after[i]) out.push(' ' + (before[i] || ''));
      else {
        if (before[i] !== undefined) out.push('- ' + before[i]);
        if (after[i] !== undefined) out.push('+ ' + after[i]);
      }
    }
    return out.join('\n');
  }
  if (ev && ev.name === 'bash') return [r.stdout, r.stderr].filter(Boolean).join('\n') || ('exit ' + (r.exitCode != null ? r.exitCode : 0));
  if (r.output != null) return String(r.output);
  if (r.error != null) return String(r.error);
  return ev && ev.result !== undefined ? JSON.stringify(r, null, 2) : '';
}
function REF_toolOutputStats(text, limit) {
  const full = String(text == null ? '' : text);
  const max = Number(limit) || REF_TOOL_OUTPUT_PREVIEW;
  const lines = full === '' ? 0 : full.split('\n').length;
  let bytes = full.length;
  try { bytes = new TextEncoder().encode(full).length; } catch { bytes = full.length; }
  const truncated = full.length > max || lines > 40;
  const preview = !truncated ? full : (full.length > max ? full.slice(0, max) : full.split('\n').slice(0, 40).join('\n'));
  return { full, preview, lines, bytes, truncated };
}
function REF_fmtToolDur(ms) {
  const n = Number(ms) || 0;
  return n < 1000 ? n + 'ms' : (n / 1000).toFixed(1) + 's';
}
function REF_toolStepView(ev, done) {
  const isDone = done !== undefined ? Boolean(done) : ev.result !== undefined || ev.denied;
  const failed = Boolean(ev.denied) || (ev.result !== undefined && ev.result && ev.result.ok === false);
  const out = REF_toolOutputStats(REF_toolOutputText(ev));
  return {
    seq: ev.seq,
    name: String(ev.name || 'tool'),
    args: REF_toolArgsSummary(ev.name, ev.args),
    argsJson: JSON.stringify(ev.args || {}, null, 2),
    durationMs: ev.durationMs != null ? Number(ev.durationMs) : null,
    dur: ev.durationMs != null ? REF_fmtToolDur(ev.durationMs) : (isDone ? '—' : '执行中…'),
    done: isDone,
    failed,
    stIcon: !isDone ? '…' : failed ? '✖' : '✓',
    stCls: !isDone ? '' : failed ? 'bad' : 'ok',
    result: ev.denied ? String(ev.denied || '未授权') : REF_toolResultSummary(ev),
    output: out,
    liClass: 'tl-step' + (failed ? ' fail' : ''),
  };
}
function REF_fmtTraceDur(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (total < 60) return total + 's';
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return m + 'm' + (s ? s + 's' : '');
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return h + 'h' + (rm ? rm + 'm' : '');
}
function REF_subagentRowView(sub) {
  const s = sub || {};
  const toolCalls = s.toolCalls == null || !Number.isFinite(Number(s.toolCalls)) ? null : Math.max(0, Math.round(Number(s.toolCalls)));
  const modelRounds = s.modelRounds == null || !Number.isFinite(Number(s.modelRounds)) ? null : Math.max(0, Math.round(Number(s.modelRounds)));
  const ago = s.lastProgressAgoMs == null || !Number.isFinite(Number(s.lastProgressAgoMs)) ? null : Math.max(0, Math.round(Number(s.lastProgressAgoMs)));
  const running = Boolean(s.running);
  const failed = !running && (s.status === 'failed' || Boolean(s.result && s.result.ok === false));
  const status = running ? 'running' : failed ? 'failed' : 'done';
  const round = Math.max(0, Math.round(Number(s.round) || 0));
  return {
    key: 'sub:' + String(s.seq == null ? '?' : s.seq),
    seq: s.seq,
    round,
    roundText: round ? '第 ' + round + ' 轮' : '—',
    name: String(s.label || s.description || s.question || '子代理').slice(0, 80),
    question: String(s.question || ''),
    toolCalls,
    toolText: toolCalls == null ? '工具次数 —' : toolCalls + ' 次工具',
    modelRounds,
    roundsText: modelRounds == null ? '自身轮次 —' : modelRounds + ' 轮',
    progress: ago == null ? '最后进展 —' : '最后进展 ' + (ago < 1000 ? '<1s' : Math.round(ago / 1000) + 's') + ' 前',
    status,
    statusText: running ? '运行中' : failed ? '失败' : '完成',
    statusCls: running ? 'run' : failed ? 'bad' : 'ok',
    running,
    durationMs: s.durationMs == null ? null : Number(s.durationMs),
    result: s.result,
  };
}
function REF_traceRoundView(round) {
  const r = round || {};
  const now = Number(r.now) || Date.now();
  const tools = (r.tools || []).map((t) => REF_toolStepView(t, t.done));
  const subs = (r.subs || []).map(REF_subagentRowView);
  const started = Number(r.startedAt) || 0;
  const ended = r.endedAt != null ? Number(r.endedAt) : now;
  const durationMs = started ? Math.max(0, ended - started) : 0;
  const durationText = started ? REF_fmtTraceDur(durationMs) : '';
  const parts = ['本轮 ' + tools.length + ' 次工具调用'];
  if (subs.length) parts.push(subs.length + ' 个子代理');
  if (durationText) parts.push(durationText);
  return {
    round: Math.max(0, Math.round(Number(r.round) || 0)),
    tools,
    subs,
    toolCount: tools.length,
    subCount: subs.length,
    failed: tools.filter((t) => t.failed).length,
    durationMs,
    durationText,
    summary: parts.join(' · '),
  };
}

// ===========================================================================
// ① sideNavLayout —— 6+ 组（边界/非法值） + 对拍 + 形状
// ===========================================================================
{
  const cases = [
    [0, false], [899, false], [900, false], [1000, false], [1000, true],
    [1179, false], [1180, false], [1440, false], [1440, true],
    ['abc', false], [null, true], [Number.NaN, 'x'],
  ];
  for (const [w, pref] of cases) {
    eq(sideNavLayout(w, pref), REF_sideNavLayout(w, pref), `sideNavLayout(${String(w)}, ${String(pref)}) 必须与搬家前逐字段一致`);
  }
  // 边界语义逐条钉死（不是只对拍，防止两边一起错）
  eq(sideNavLayout(1440, false), { mode: 'wide', collapsed: false, width: 240, drawer: false }, '1440 展开 240');
  eq(sideNavLayout(1440, true), { mode: 'wide', collapsed: true, width: 48, drawer: false }, '1440 用户折叠 48');
  eq(sideNavLayout(1000, false), { mode: 'mid', collapsed: true, width: 48, drawer: false }, '1000 自动折叠 48');
  eq(sideNavLayout(880, false), { mode: 'drawer', collapsed: false, width: 0, drawer: true }, '880 抽屉不占宽');
  eq(sideNavLayout(900, false).mode, 'mid', '900 边界含在 mid');
  eq(sideNavLayout(899, false).mode, 'drawer', '899 落抽屉');
  eq(sideNavLayout('', false).mode, 'drawer', '空宽度按 0 处理');
  eq(sideNavBreakpoint(1180), 'wide', 'sideNavBreakpoint 1180=wide');
  eq(Object.keys(sideNavLayout(1440, false)).sort(), ['collapsed', 'drawer', 'mode', 'width'], '布局对象字段名不得变');
}

// ===========================================================================
// ② errCardParts —— 6+ 组 + 对拍 + 形状
// ===========================================================================
{
  const long = '⚠ 上游错误：' + 'x'.repeat(500);
  const cases = [
    '',
    null,
    '普通错误',
    '⚠ 上游错误：{"error":"boom"}\n   💡 换 chat 端点。',
    '提示：这是一个提示行\n第一行正文\n第二行',
    '⚠ 超时 timeout after 30s\n处置建议：稍后重试',
    'a\r\nb\rc\n💡 用 \\n 统一换行',
    long,
    undefined,
    12345,
  ];
  for (const input of cases) {
    eq(errCardParts(input), REF_errCardParts(input), `errCardParts(${JSON.stringify(String(input)).slice(0, 40)}…) 必须与搬家前一致`);
  }
  eq(errCardParts(''), { head: '', hint: '', raw: '', tag: '错误' }, '空输入：四字段齐全且为空');
  eq(errCardParts('a\r\nb').raw, 'a\nb', 'CRLF 统一成 LF');
  eq(errCardParts('a\rb').raw, 'a\nb', 'CR 统一成 LF');
  eq(errCardParts('上游 x\n💡 建议').raw, '上游 x', '处置建议从原文剥离');
  eq(errCardParts('上游 x\n💡 建议').hint, '💡 建议', '处置建议 trim 后独立');
  eq(errCardParts('上游 timeout').tag, '上游', '上游优先于超时');
  eq(errCardParts('timeout').tag, '内核', '超时归内核');
  eq(errCardParts('unknown').tag, '错误', '其余归错误');
  eq(errCardParts(long).head.length, long.length, 'head 取第一行，不截断（截断在 errCardHtml）');
  eq(Object.keys(errCardParts('x')).sort(), ['head', 'hint', 'raw', 'tag'], '错误卡字段名不得变');
}

// ===========================================================================
// ③ runStripView —— 6+ 组 + 对拍 + 形状（含 applyRunProgress 的桩 SSE 路径）
// ===========================================================================
{
  const cases = [
    [{ rawPhase: '', aborted: false, ttftMs: null, tokensPerSec: null, toolCalls: 0, contextTotal: 128000, contextUsed: 0, contextApprox: true, cost: '' }, true],
    [{ rawPhase: '发请求（等首帧）', aborted: false, ttftMs: 2400, tokensPerSec: 18.6, toolCalls: 0, contextTotal: 128000, contextUsed: 100, contextApprox: true, cost: '' }, true],
    [{ rawPhase: '执行工具 bash', aborted: false, ttftMs: 2400, tokensPerSec: null, toolCalls: 3, contextTotal: 128000, contextUsed: 790, contextApprox: true, cost: ' ≈¥0.0132（高峰 · 缓存命中 50%）' }, true],
    [{ rawPhase: '解码中（收到增量）', aborted: false, ttftMs: 0, tokensPerSec: 0, toolCalls: 7, contextTotal: 0, contextUsed: 0, contextApprox: false, cost: null }, true],
    [{ rawPhase: '已停止', aborted: true, ttftMs: 1000, tokensPerSec: 2, toolCalls: 1, contextTotal: 128000, contextUsed: 79000, contextApprox: false, cost: '≈¥1.5' }, false],
    [{ rawPhase: '解码中', aborted: false, ttftMs: 1000, tokensPerSec: 2, toolCalls: 1, contextTotal: 128000, contextUsed: 79000, contextApprox: false, cost: '≈¥1.5' }, false],
    [{}, true],
    [{ rawPhase: null, aborted: false, ttftMs: 'abc', tokensPerSec: 'abc', toolCalls: -5, contextTotal: null, contextUsed: -1, contextApprox: true, cost: 42 }, true],
    [{ rawPhase: '排队等待本地端点', aborted: false, ttftMs: Number.NaN, tokensPerSec: Number.POSITIVE_INFINITY, toolCalls: 2.4, contextTotal: '128000', contextUsed: '1.6', contextApprox: true, cost: '无' }, true],
  ];
  for (const [st, gen] of cases) {
    eq(runStripView(st, gen), REF_runStripView(st, gen), `runStripView(${JSON.stringify(st).slice(0, 50)}…) 必须与搬家前一致`);
  }
  eq(Object.keys(runStripView({}, true)).sort(), ['cost', 'ctx', 'phase', 'tools', 'tps', 'ttft'], '状态条六字段名不得变');
  eq(runStripView({ rawPhase: '', aborted: false, toolCalls: 0 }, true).tools, '0 次工具调用', '0 必须显式显示');
  eq(runStripView({ rawPhase: '', aborted: true }, true).phase, '已中止', 'aborted 优先');
  eq(runStripView({ rawPhase: '', aborted: false }, false).phase, '空闲', '非生成=空闲');
  eq(runStripView({ rawPhase: 'stalled' }, true).phase, '已中止', 'stalled 归已中止');
  eq(runStripView({ rawPhase: '子 Agent 执行中' }, true).phase, '执行工具', '子 Agent 归执行工具');
  eq(runStripView({ rawPhase: '未知阶段' }, true).phase, '等首帧', '未知阶段落等首帧');
  eq(runStripView({ ttftMs: 2400 }, true).ttft, '2.4s', '首帧 2.4s');
  eq(runStripView({ tokensPerSec: 18.6 }, true).tps, '18.6', '吞吐一位小数');
  eq(runStripView({ contextTotal: 128000, contextUsed: 79000, contextApprox: false }, true).ctx, '79.0K / 128.0K tokens', '精确 budget 不带 ≈');
  eq(runStripView({ contextUsed: 100, contextTotal: 128000 }, true).ctx, '≈ 100 / 128.0K tokens', '估算 budget 带 ≈');
  eq(runStripView({ cost: ' ≈¥0.0132（高峰 · 缓存命中 50%）' }, true).cost, '≈¥0.0132', '费用只取金额');
  eq(runStripView({}, true).cost, '—', '无费用显示 —');

  // 桩 SSE：progress 事件 → applyRunProgress → runStripView（与 §148 原路径同形）
  const st = { rawPhase: '', aborted: false, ttftMs: null, tokensPerSec: null, toolCalls: 0, contentChars: 0, contextUsed: 0, contextTotal: 128000, contextApprox: true, cost: '' };
  applyRunProgress(st, { type: 'progress', phase: '发请求（等首帧）', ttftMs: 2400, tokensPerSec: 18.6, toolCalls: 0, contentChars: 0 }, 0);
  eq(runStripView(st, true), { phase: '等首帧', ttft: '2.4s', tps: '18.6', ctx: '≈ 0 / 128.0K tokens', tools: '0 次工具调用', cost: '—' }, '桩 progress 后六字段逐字一致');
  applyRunProgress(st, { phase: '执行工具 bash', ttftMs: 2400, tokensPerSec: null, toolCalls: 3, contentChars: 120 }, 0);
  eq(runStripView(st, true), { phase: '执行工具', ttft: '2.4s', tps: '—', ctx: '≈ 80 / 128.0K tokens', tools: '3 次工具调用', cost: '—' }, 'progress 合并后工具数/估算上下文正确');
  st.aborted = true;
  eq(runStripView(st, false).phase, '已中止', '中止后立刻显示已中止');
  // 辅助格式化（同属搬家范围）
  eq([fmtRunTtft(null), fmtRunTtft('abc'), fmtRunTtft(0), fmtRunTtft(1234)], ['—', '—', '0.0s', '1.2s'], 'fmtRunTtft 边界');
  eq([fmtRunTps(null), fmtRunTps('x'), fmtRunTps(0), fmtRunTps(1.25)], ['—', '—', '0.0', '1.3'], 'fmtRunTps 边界');
  eq([fmtRunTools(null), fmtRunTools(-1), fmtRunTools(2.6)], ['0 次工具调用', '0 次工具调用', '3 次工具调用'], 'fmtRunTools 归一化');
  eq([fmtRunCost(''), fmtRunCost('≈¥12'), fmtRunCost('无')], ['', '≈¥12', ''], 'fmtRunCost 只取金额');
  eq([normalizeRunPhase('解码中', true, false), normalizeRunPhase('x', true, true)], ['解码中', '已中止'], 'normalizeRunPhase 直测');
  eq([permissionSourceLabel('explicit'), permissionSourceLabel('preset'), permissionSourceLabel('config'), permissionSourceLabel('cli'), permissionSourceLabel('default'), permissionSourceLabel('zzz')],
    ['显式选择', '预设', 'config 默认', '命令行', '内置默认', '未知'], '权限来源标签');
}

// ===========================================================================
// ④ traceRoundView —— 6+ 组 + 对拍 + 形状（含空数组/单条/超长文本/缺字段/非法值）
// ===========================================================================
{
  const longOut = Array.from({ length: 100 }, (_, i) => 'line ' + i).join('\n');
  const tool = (seq, name, args, result, durationMs, done) => ({ kind: 'tool', seq, name, args, result, durationMs, done });
  const cases = [
    {},
    { now: 200000 },
    { round: 0, startedAt: 0, now: 1, tools: [], subs: [] },
    { round: 2, startedAt: 1000, endedAt: 103000, now: 200000, tools: [tool(1, 'read', { path: 'a' }, { ok: true, lines: 3 }, 100, true)] },
    { round: 3, startedAt: 0, now: 1, tools: [tool(9, 'bash', { command: 'npm test' }, { ok: false, error: 'boom' }, 30, true)], subs: [{ seq: 8, label: '调研', round: 3, toolCalls: 4, modelRounds: 2, lastProgressAgoMs: 1200, status: 'failed', result: { ok: false } }] },
    { round: 'x', startedAt: 'abc', endedAt: 'def', now: 5000, tools: [tool(2, 'grep', { pattern: 'x' }, { ok: true, output: longOut }, 4000, true)] },
    { round: 4, startedAt: 0, now: 1000, tools: [], subs: [{ seq: 1, running: true }, { seq: 2, label: 'done', status: 'done', result: { ok: true } }] },
    { round: 5, startedAt: 0, endedAt: 7200000, now: 7200000, tools: [tool(1, 'write', { path: 'f' }, { ok: true, bytes: 12 }, 1000, true)] },
    { round: -3, startedAt: -100, endedAt: -50, now: 0, tools: [], subs: [] },
    { round: 6, startedAt: 1000, now: 1001, tools: [{ kind: 'tool', seq: 1, name: 'bash', args: {}, denied: '未授权', durationMs: null, done: false }], subs: [] },
  ];
  for (const round of cases) {
    eq(traceRoundView(round), REF_traceRoundView(round), `traceRoundView(round=${JSON.stringify(round.round)}) 必须与搬家前一致`);
  }
  eq(Object.keys(traceRoundView({ now: 1 })).sort(),
    ['durationMs', 'durationText', 'failed', 'round', 'subCount', 'subs', 'summary', 'toolCount', 'tools'],
    '轮视图字段名不得变');
  eq(traceRoundView({ now: 1 }).summary, '本轮 0 次工具调用', '空轮摘要');
  eq(traceRoundView({ now: 1, subs: [{ seq: 1 }] }).summary, '本轮 0 次工具调用 · 1 个子代理', '仅子代理摘要');
  eq(traceRoundView({ now: 200000, startedAt: 1000, endedAt: 103000, tools: [] }).durationText, '1m42s', '102s → 1m42s');
  eq(traceRoundView({ now: 200000, startedAt: 1000, endedAt: 103000, tools: [] }).summary, '本轮 0 次工具调用 · 1m42s', '耗时进摘要');
  eq(traceRoundView({ now: 1, tools: [{ kind: 'tool', seq: 1, name: 'bash', args: { command: 'x' }, result: { ok: false, error: 'e' }, durationMs: 30, done: true }] }).failed, 1, '失败工具计数');
  eq(traceRoundView({ now: 1, tools: [{ kind: 'tool', seq: 1, name: 'read', args: { path: 'a' }, result: { ok: true, lines: 2 }, durationMs: 9, done: true }] }).tools[0].liClass, 'tl-step', '成功步无 fail 类');
  eq(Object.keys(traceRoundView({ now: 1, tools: [tool(1, 'read', {}, { ok: true }, 1, true)] }).tools[0]).sort(),
    ['args', 'argsJson', 'done', 'dur', 'durationMs', 'failed', 'liClass', 'name', 'output', 'result', 'seq', 'stCls', 'stIcon'],
    '工具步字段名不得变');
  // 依赖树直测（它们跟 traceRoundView 一起搬家）
  eq(fmtTraceDur(102000), '1m42s', 'fmtTraceDur 102s');
  eq([fmtTraceDur(0), fmtTraceDur(59000), fmtTraceDur(3600000), fmtTraceDur(3661000)], ['0s', '59s', '1h', '1h1m'], 'fmtTraceDur 边界');
  const sub = subagentRowView({ seq: 7, label: '调研 A', round: 3, toolCalls: 4, modelRounds: 2, lastProgressAgoMs: 1200, running: true });
  eq(sub.toolText, '4 次工具', '子代理工具数文案');
  eq(sub.roundText, '第 3 轮', '子代理轮次文案');
  eq(sub.progress, '最后进展 1s 前', '子代理最后进展文案');
  eq(sub.statusText, '运行中', '子代理运行中文案');
  eq(Object.keys(sub).sort(), ['durationMs', 'key', 'modelRounds', 'name', 'progress', 'question', 'result', 'round', 'roundText', 'roundsText', 'running', 'seq', 'status', 'statusCls', 'statusText', 'toolCalls', 'toolText'], '子代理字段名不得变');
  eq(subagentRowView({}).name, '子代理', '缺字段回退默认名');
  const out = toolOutputStats(longOut);
  eq([out.truncated, out.lines], [true, 100], '长输出折叠并给真实行数');
  eq(toolOutputStats('').truncated, false, '空输出不折叠');
  eq(toolOutputText({ name: 'bash', result: { stdout: 'a', stderr: 'b' } }), 'a\nb', 'bash 输出合并 stdout/stderr');
  eq(toolResultSummary({ name: 'read', result: { ok: true, lines: 3 } }), '3 行', 'read 结果摘要');
  eq(toolArgsSummary('bash', { command: 'npm test' }), 'npm test', 'bash 参数摘要');
  eq(fmtToolDur(999), '999ms', '耗时 ms');
  eq(fmtToolDur(1200), '1.2s', '耗时 s');
  const tl = toolTimelineSummary([{ failed: false, durationMs: 12 }, { failed: true, durationMs: 1200 }, { failed: false, durationMs: 800 }]);
  eq(tl, { count: 3, failed: 1, totalMs: 2012, countText: '3 步 · 1 个失败', sumText: '2.0s' }, '时间线汇总');
  eq(toolTimelineVisibility([{ failed: false }, { failed: false }, { failed: false }, { failed: false }, { failed: true }], false), [0, 1, 2, 4], '默认可见=前 3 + 失败');
  eq(toolTimelineVisibility([], true), [], '空时间线');
  eq(toolStepView({ seq: 1, name: 'read', args: { path: 'a' }, result: { ok: true, lines: 1 }, durationMs: 10 }, true).stIcon, '✓', '工具步成功图标');
  eq(toolStepView({ seq: 2, name: 'bash', args: {}, result: { ok: false, error: 'x' }, durationMs: 10 }, true).stCls, 'bad', '工具步失败类');
}

// ---------------------------------------------------------------------------
// 输入队列（v0.6.39）：生成中继续输入 → 排队，本轮结束后自动发出
// ---------------------------------------------------------------------------
{
  let q = [];
  eq(enqueueMessage(q, '   ', 'a'), { ok: false, queue: [], reason: 'empty' }, '空/空白文本不入队');
  const e1 = enqueueMessage(q, '第二个问题', 'a');
  eq(e1.ok, true, '非空文本入队成功');
  eq(e1.queue.length, 1, '入队后长度 +1');
  eq(e1.queue[0].text, '第二个问题', '原文保留（不 trim，避免吃掉用户的前导空格/代码缩进）');
  const e2 = enqueueMessage(e1.queue, '第三个', 'b');
  eq(e2.queue.map((x) => x.id), ['a', 'b'], '先进先出，id 顺序稳定');
  eq(enqueueMessage([], 'x', 'c').queue[0].id, 'c', 'id 原样保存');

  const full = Array.from({ length: QUEUE_MAX }, (_, i) => ({ id: String(i), text: 'x' }));
  eq(enqueueMessage(full, 'y', 'z').reason, 'full', '满员拒绝（上限 ' + QUEUE_MAX + '）');
  eq(enqueueMessage(full, 'y', 'z').queue.length, QUEUE_MAX, '满员时队列不变');

  const d = dequeueMessage(e2.queue, 'a');
  eq(d.queue.map((x) => x.id), ['b'], '按 id 移除');
  eq(d.removed.text, '第二个问题', '返回被移除项（供"回填输入框"用）');
  eq(dequeueMessage(d.queue, '不存在').queue.map((x) => x.id), ['b'], '移除不存在的 id 不改变队列');
  eq(dequeueMessage(null, 'a').removed, null, '非数组输入不崩');

  // 排空判据：**中止时不排空**（中止的语义是"停下"，接着发下一条会违背意图）
  eq(shouldDrainQueue({ queue: [{ id: '1', text: 'a' }], generating: false, aborted: false }), true, '本轮正常结束 → 排空');
  eq(shouldDrainQueue({ queue: [{ id: '1', text: 'a' }], generating: true, aborted: false }), false, '生成中不排空');
  eq(shouldDrainQueue({ queue: [{ id: '1', text: 'a' }], generating: false, aborted: true }), false, '用户中止 → 不排空（保留队列）');
  eq(shouldDrainQueue({ queue: [], generating: false, aborted: false }), false, '空队列不排空');
  eq(shouldDrainQueue({}), false, '入参缺失不崩');

  // 渲染模型：序号从 1 开始、换行压平、超长截断
  const v = queueView([{ id: 'a', text: '第一行\n第二行' }, { id: 'b', text: 'x'.repeat(100) }]);
  eq(v[0].index, 1, 'chip 序号从 1 开始');
  eq(v[0].label.includes('\n'), false, '换行压成空格（chip 单行显示）');
  eq(v[0].text.includes('\n'), true, '原文（title/回填用）不被改写');
  eq(v[1].label.length <= 42, true, '超长文本截断到上限内');
  eq(v[1].label.endsWith('…'), true, '截断用省略号标示');
  eq(queueLabel({ text: '' }), '', '空文本 label 为空串');
  eq(queueView(null), [], '非数组返回空数组');
}

// ---------------------------------------------------------------------------
// SSE 序号连续性（v0.6.41 §1.1 B1）：跳号 → 整窗重取，而不是逐帧续接
// ---------------------------------------------------------------------------
{
  // 首帧：必须从 1 开始（0 是"还没有游标"的哨兵，不是合法序号）
  eq(seqContinuity({ lastSeq: 0, incomingSeq: 1 }), { ok: true, gap: 0, action: 'accept' }, '首帧 seq=1 → accept');
  eq(seqContinuity({ lastSeq: 0, incomingSeq: 2 }), { ok: false, gap: 1, action: 'resync' }, '首帧 seq≠1 → resync（开头就缺）');
  eq(seqContinuity({ lastSeq: 0, incomingSeq: 5 }).gap, 4, '首帧缺 4 条时 gap=4');

  // 连续
  eq(seqContinuity({ lastSeq: 5, incomingSeq: 6 }), { ok: true, gap: 0, action: 'accept' }, 'lastSeq+1 → accept');

  // 重复 / 乱序旧帧：忽略但不算"连续性坏了"（ok 仍为 true）
  eq(seqContinuity({ lastSeq: 5, incomingSeq: 5 }), { ok: true, gap: 0, action: 'ignore' }, '重复帧 → ignore（不重复渲染）');
  eq(seqContinuity({ lastSeq: 5, incomingSeq: 4 }), { ok: true, gap: 0, action: 'ignore' }, '乱序旧帧 → ignore');
  eq(seqContinuity({ lastSeq: 99, incomingSeq: 1 }).action, 'ignore', '远旧帧 → ignore');

  // 跳号：gap 是**缺多少条**，不是差值
  eq(seqContinuity({ lastSeq: 5, incomingSeq: 7 }), { ok: false, gap: 1, action: 'resync' }, '只差 1（漏 1 帧）→ resync，gap=1');
  eq(seqContinuity({ lastSeq: 5, incomingSeq: 12 }), { ok: false, gap: 6, action: 'resync' }, '跳很多 → resync，gap=6');
  eq(seqContinuity({ lastSeq: 3, incomingSeq: 7 }).gap, 3, 'gap 必须等于缺多少（7-3-1）');

  // 旧服务端 / 无序号帧：不参与连续性，业务照常（由 app.js 的另一条分支保证）
  eq(seqContinuity({ lastSeq: 0, incomingSeq: null }), { ok: true, gap: 0, action: 'ignore' }, 'null 帧 → ignore（旧服务端兼容）');
  eq(seqContinuity({ lastSeq: 9, incomingSeq: undefined }).action, 'ignore', 'undefined 帧 → ignore');
  eq(seqContinuity({}).action, 'ignore', '空入参不崩');
  eq(seqContinuity({ lastSeq: 9, incomingSeq: '10' }).action, 'accept', '数字串按数字处理');

  // B1 的救援只有两态：有会话文件 → snapshot；没有会话（新会话首轮）→ none
  eq(resyncPlan({ gap: 3, hasSession: true, hasTask: true }).mode, 'snapshot', '有会话 → snapshot（任务在跑也一样）');
  eq(resyncPlan({ gap: 3, hasSession: true, hasTask: false }).mode, 'snapshot', '有会话 → snapshot（不看 hasTask）');
  eq(resyncPlan({ gap: 3, hasSession: false, hasTask: true }).mode, 'none', '没有会话必须选 none（B1 不重建空窗口）');
  eq(resyncPlan({ gap: 3, hasSession: false, hasTask: false }).mode, 'none', '都没有 → none');
  eq(resyncPlan({ gap: 3, hasSession: true }).reason.length > 0, true, 'reason 必须可读（不能空）');
  eq(resyncPlan({ gap: 3, hasSession: true }).reason.includes('3'), true, 'reason 带上 gap，便于日志取证');
  eq(resyncPlan({}).mode, 'none', '缺参不崩');
  eq(resyncPlan({ gap: 1, hasSession: false }).mode === 'events', false, 'B1 不得再有 events 模式（投影属 B2）');

  // 文案：低调、单行；gap<=0 不插
  eq(seqBanner({ gap: 3 }), '已跳过 3 条事件，正在重新同步…', 'gap=3 的文案');
  eq(seqBanner({ gap: 1 }).includes('\n'), false, '文案必须单行（msg-sys 一行）');
  eq(seqBanner({ gap: 0 }), '', 'gap=0 不插提示');
  eq(seqBanner({ gap: -2 }), '', 'gap<0 不插提示');
  eq(seqBanner({}), '', '缺参不插提示');
}

// ---------------------------------------------------------------------------
// 空态示例任务池（v0.8.1）：办公/生活/编程三类齐全、随机但可复现、同批不重复
// ---------------------------------------------------------------------------
{
  const cats = [...new Set(EXAMPLE_PROMPTS.map((p) => p.category))].sort();
  eq(cats, ['code', 'life', 'office'], '示例池必须覆盖办公/生活/编程三类');
  ok(['office', 'life', 'code'].every((c) => EXAMPLE_PROMPTS.filter((p) => p.category === c).length >= 4), '每类至少 4 条示例（够随机抽还不重复）');
  ok(EXAMPLE_PROMPTS.every((p) => [...p.text].length <= 26), '每条示例 ≤26 字（超长会让 chip 换行、顶高空态布局）');
  ok(EXAMPLE_PROMPTS.every((p) => p.category !== 'code' || [...p.text].length > 0), '示例文案非空');
  const repoCode = EXAMPLE_PROMPTS.filter((p) => p.category === 'code' && /src\/agent\.js/.test(p.text));
  eq(repoCode.length, 1, '编程类只保留 1 条与本仓库相关的示例（其余为通用编程任务）');
  eq(EXAMPLE_PROMPTS.filter((p) => /README|仓库/.test(p.text)).length, 0, '不得再有「给这个仓库写 README」这类只对开发者有意义的示例');

  const picked = pickExamples();
  eq(picked.length, 3, '默认抽 3 条（对应空态三个示例按钮）');
  eq([...new Set(picked.map((p) => p.category))].sort(), ['code', 'life', 'office'], '默认抽签必须三类各 1 条（不能纯随机碰运气）');
  ok(picked.every((p) => typeof p.text === 'string' && typeof p.category === 'string'), '返回形状必须是 {text, category}');
  ok(new Set(picked.map((p) => p.text)).size === picked.length, '同一批内不得重复');

  // 注入固定 rng：同一随机源两次抽签必须完全一致（可复现，便于回归/截图）
  const seeded = () => 0.42;
  eq(pickExamples({ rng: seeded }), pickExamples({ rng: seeded }), '注入固定 rng → 两次结果完全一致（可复现）');
  // 不同 rng 抽出的组合不应永远相同（池子每类 ≥4，默认随机必须真的在随机）
  const variants = new Set();
  for (let i = 0; i < 24; i += 1) variants.add(pickExamples().map((p) => p.text).join('|'));
  ok(variants.size >= 3, '连续 24 次随机抽签至少出现 3 种组合（示例不能一成不变）');

  const five = pickExamples({ count: 5, rng: seeded });
  eq(five.length, 5, 'count=5 抽 5 条');
  ok(new Set(five.map((p) => p.text)).size === 5, 'count=5 时同批仍不重复');
  eq([...new Set(five.map((p) => p.category))].length, 3, 'count>3 时仍覆盖三类（先每类 1 条再补）');
  eq(pickExamples({ count: 0 }).length, 3, '非法 count 回落默认 3（不返回空）');
  eq(pickExamples({ count: 99 }).length, EXAMPLE_PROMPTS.length, 'count 超过池子大小时抽干为止、不重复不崩');
}

console.log(`✅ test/viewmodel.js：${passed} 条断言通过（搬家函数与搬家前实现 deepEqual 对拍 + 输出形状 + 队列/插话 + SSE 序号连续性/两态救援）`);
