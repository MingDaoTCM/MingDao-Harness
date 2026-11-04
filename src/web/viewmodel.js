// 前端纯视图模型（v0.7.0 §1.2）：从 app.js 搬出的可直测计算层。
//
// 设计约束（与 smoke §148/§149/§151/§158 的行为断言一致）：
//   · 不读 DOM、不读窗口尺寸、不读 localStorage、不读写任何模块级可变状态；
//   · 只依赖入参（以及 util.js 的纯格式化函数），同样的输入永远得到同样的输出；
//   · 输出字段名就是 app.js 渲染层消费的字段名——改名会当场打破 smoke 的形状断言。
//
// 本文件只做"纯计算"，DOM 接线仍在 app.js。test/viewmodel.js 用 node 直跑，
// 并把搬家前的原实现当作"参照实现"逐组对拍，证明这次搬家没有改变行为。

// 本模块刻意不 import util.js：util.js 依赖 document，属于浏览器层；tsconfig.full 的
// exclude 不阻断"被 import 的文件"进入类型检查。这里只复制一个纯格式化函数并逐值对拍。
/**
 * tokens 数量缩写（与 util.js 的 fmtTok 逐字节一致；test/viewmodel.js 对数）。
 *
 * @param {number} n
 * @returns {string}
 */
function fmtTok(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(0) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

/**
 * 左栏三档断点：≥1180 展开(240) / 900–1180 自动折叠(48) / <900 抽屉。
 * 右栏收起点见 app.js 的 layoutClassesFor（<1100）。
 *
 * @param {number|string} width 视口宽度；非数字/缺省按 0 处理
 * @returns {'wide'|'mid'|'drawer'}
 */
export function sideNavBreakpoint(width) {
  const w = Number(width) || 0;
  if (w >= 1180) return 'wide';
  if (w >= 900) return 'mid';
  return 'drawer';
}

/**
 * 左栏布局：把断点与用户折叠偏好收敛成渲染层直接消费的对象。
 *
 * @param {number|string} width 视口宽度
 * @param {boolean} pref 用户是否手动折叠（只对 wide 档生效）
 * @returns {{mode: 'wide'|'mid'|'drawer', collapsed: boolean, width: number, drawer: boolean}}
 */
export function sideNavLayout(width, pref) {
  const mode = sideNavBreakpoint(width);
  const collapsed = mode === 'mid' || (mode === 'wide' && !!pref);
  return { mode, collapsed, width: mode === 'drawer' ? 0 : (collapsed ? 48 : 240), drawer: mode === 'drawer' };
}

/**
 * 错误卡三段式的纯计算：原文 / 处置建议 / 归属标签 / 首行摘要。
 * 换行统一为 \n；处置建议行（💡 / 提示：/ 处置建议：）从原文中剥离；
 * 原文为空时退回整段 trim 后的文本，head 始终取第一行。
 *
 * @param {unknown} text 上游错误原文
 * @returns {{head: string, hint: string, raw: string, tag: '上游'|'内核'|'错误'}}
 */
export function errCardParts(text) {
  const rawText = String(text || '').replace(/\r\n?/g, '\n');
  const lines = rawText.split('\n');
  let hintIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(?:💡|提示[:：]|处置建议[:：])/.test(lines[i])) { hintIdx = i; break; }
  }
  const hint = hintIdx >= 0 ? lines[hintIdx].trim() : '';
  const raw = (hintIdx >= 0 ? lines.slice(0, hintIdx) : lines).join('\n').trim() || rawText.trim();
  const head = (lines[0] || '').trim();
  const tag = /上游|upstream/i.test(rawText) ? '上游' : /超时|timeout/i.test(rawText) ? '内核' : '错误';
  return { head, hint, raw, tag };
}

/**
 * 运行阶段收敛成五档（等首帧 / 解码中 / 执行工具 / 已中止 / 空闲）。
 *
 * @param {unknown} rawPhase 服务端 phase 文案
 * @param {boolean} isGenerating 是否生成中
 * @param {boolean|undefined} aborted 是否已中止
 * @returns {'等首帧'|'解码中'|'执行工具'|'已中止'|'空闲'}
 */
export function normalizeRunPhase(rawPhase, isGenerating, aborted) {
  if (aborted) return '已中止';
  if (!isGenerating) return '空闲';
  const p = String(rawPhase || '');
  if (/已中止|已停止|aborted|stalled/.test(p)) return '已中止';
  if (/解码/.test(p)) return '解码中';
  if (/执行工具|等待权限确认|待发请求|子\s?Agent|工具/.test(p)) return '执行工具';
  return '等首帧';
}

/**
 * 首帧耗时文案：非法/缺省显示 —。
 *
 * @param {unknown} ms 毫秒
 * @returns {string}
 */
export function fmtRunTtft(ms) {
  return ms == null || !Number.isFinite(Number(ms)) ? '—' : (Number(ms) / 1000).toFixed(1) + 's';
}

/**
 * 吞吐文案：非法/缺省显示 —。
 *
 * @param {unknown} v tokens/s
 * @returns {string}
 */
export function fmtRunTps(v) {
  return v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(1);
}

/**
 * 工具调用次数文案：0 也必须显式写出来。
 *
 * @param {unknown} n
 * @returns {string}
 */
export function fmtRunTools(n) {
  const k = Math.max(0, Math.round(Number(n) || 0));
  return k === 0 ? '0 次工具调用' : k + ' 次工具调用';
}

/**
 * 费用只取 ≈¥ 金额部分（缓存命中/价格表提示不进一行状态条）。
 *
 * @param {unknown} cost
 * @returns {string} 无金额时返回空串
 */
export function fmtRunCost(cost) {
  const m = String(cost || '').match(/≈¥[0-9.]+/);
  return m ? m[0] : '';
}

/**
 * 上下文占用文案：无数据 —；生成中用 ≈ 标明估算；done 带回精确 budget 时不带 ≈。
 *
 * @param {{contextTotal?: unknown, contextUsed?: unknown, contextApprox?: boolean}} st
 * @returns {string}
 */
export function fmtRunCtx(st) {
  const total = Number(st.contextTotal) || 0;
  const used = Math.max(0, Math.round(Number(st.contextUsed) || 0));
  if (!total && !used) return '—';
  const approx = st.contextApprox !== false;
  return (approx ? '≈ ' : '') + fmtTok(used) + ' / ' + (total ? fmtTok(total) : '?') + ' tokens';
}

/**
 * 常驻运行状态条的六字段视图（状态条与右栏「本轮运行」同源）。
 *
 * @param {{rawPhase?: unknown, aborted?: boolean, ttftMs?: unknown, tokensPerSec?: unknown,
 *          toolCalls?: unknown, contextTotal?: unknown, contextUsed?: unknown,
 *          contextApprox?: boolean, cost?: unknown}} st
 * @param {boolean} [isGenerating]
 * @returns {{phase: string, ttft: string, tps: string, ctx: string, tools: string, cost: string}}
 */
export function runStripView(st, isGenerating) {
  return {
    phase: normalizeRunPhase(st.rawPhase, isGenerating !== false, st.aborted),
    ttft: fmtRunTtft(st.ttftMs),
    tps: fmtRunTps(st.tokensPerSec),
    ctx: fmtRunCtx(st),
    tools: fmtRunTools(st.toolCalls),
    cost: fmtRunCost(st.cost) || '—',
  };
}

/**
 * 把一条 progress 事件并进运行状态（桩 SSE 与真实 SSE 走同一条路径）。
 * 只改传入的 st（调用方持有的状态对象），不读 DOM/全局。
 *
 * @param {Record<string, any>} st
 * @param {{phase?: unknown, ttftMs?: unknown, tokensPerSec?: unknown, toolCalls?: unknown, contentChars?: unknown}} ev
 * @param {unknown} baseUsed 上一轮已知 used tokens
 * @returns {Record<string, any>} 同一个 st
 */
export function applyRunProgress(st, ev, baseUsed) {
  st.rawPhase = String(ev.phase || '');
  st.phase = normalizeRunPhase(st.rawPhase, true, false);
  if (ev.ttftMs != null) st.ttftMs = Number(ev.ttftMs) || 0;
  st.tokensPerSec = ev.tokensPerSec != null ? Number(ev.tokensPerSec) : null;
  st.toolCalls = Number(ev.toolCalls) || 0;
  st.contentChars = Number(ev.contentChars) || 0;
  st.contextApprox = true;
  st.contextUsed = Math.max(0, Number(baseUsed) || 0) + Math.round(st.contentChars / 1.5);
  return st;
}

/**
 * 权限来源的人读标签。
 *
 * @param {unknown} source explicit / preset / config / cli / default
 * @returns {string}
 */
export function permissionSourceLabel(source) {
  return ({ explicit: '显式选择', preset: '预设', config: 'config 默认', cli: '命令行', default: '内置默认' })[String(source || '')] || '未知';
}

// —— 工具时间线：同一轮多个调用聚合成一张卡（默认前 3 步 + 失败步，整卡可折叠） ——
const TOOL_TL_DEFAULT_VISIBLE = 3;
const TOOL_OUTPUT_PREVIEW = 900;

/**
 * 工具参数的一行摘要（完整参数在展开区里用 JSON 显示）。
 *
 * @param {unknown} name 工具名
 * @param {Record<string, any>} [args]
 * @returns {string}
 */
export function toolArgsSummary(name, args) {
  const a = args || {};
  if (name === 'bash') return String(a.command || '');
  if (name === 'task') return String(a.question || a.prompt || a.description || '');
  return String(a.path || a.pattern || a.name || a.query || a.url || a.file || '');
}

/**
 * 工具结果的一行摘要（不是正文；正文在展开区）。
 *
 * @param {any} ev 工具事件
 * @returns {string}
 */
export function toolResultSummary(ev) {
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

/**
 * 工具输出的完整文本（展开区用）。
 *
 * @param {any} ev 工具事件
 * @returns {string}
 */
export function toolOutputText(ev) {
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

/**
 * 长输出折叠判据：给出完整文本、预览、行数与字节数（用户要知道被折了多少）。
 *
 * @param {unknown} text
 * @param {unknown} [limit]
 * @returns {{full: string, preview: string, lines: number, bytes: number, truncated: boolean}}
 */
export function toolOutputStats(text, limit) {
  const full = String(text == null ? '' : text);
  const max = Number(limit) || TOOL_OUTPUT_PREVIEW;
  const lines = full === '' ? 0 : full.split('\n').length;
  let bytes = full.length;
  try { bytes = new TextEncoder().encode(full).length; } catch { bytes = full.length; }
  const truncated = full.length > max || lines > 40;
  const preview = !truncated ? full : (full.length > max ? full.slice(0, max) : full.split('\n').slice(0, 40).join('\n'));
  return { full, preview, lines, bytes, truncated };
}

/**
 * 单步视图（失败高亮类名 / 状态图标 / 一行摘要 / 完整参数与输出）。
 *
 * @param {any} ev 工具事件
 * @param {boolean} [done] 覆盖完成判据
 * @returns {Record<string, any>}
 */
export function toolStepView(ev, done) {
  const isDone = done !== undefined ? Boolean(done) : ev.result !== undefined || ev.denied;
  const failed = Boolean(ev.denied) || (ev.result !== undefined && ev.result && ev.result.ok === false);
  const out = toolOutputStats(toolOutputText(ev));
  return {
    seq: ev.seq,
    name: String(ev.name || 'tool'),
    args: toolArgsSummary(ev.name, ev.args),
    argsJson: JSON.stringify(ev.args || {}, null, 2),
    durationMs: ev.durationMs != null ? Number(ev.durationMs) : null,
    dur: ev.durationMs != null ? fmtToolDur(ev.durationMs) : (isDone ? '—' : '执行中…'),
    done: isDone,
    failed,
    stIcon: !isDone ? '…' : failed ? '✖' : '✓',
    stCls: !isDone ? '' : failed ? 'bad' : 'ok',
    result: ev.denied ? String(ev.denied || '未授权') : toolResultSummary(ev),
    output: out,
    liClass: 'tl-step' + (failed ? ' fail' : ''),
  };
}

/**
 * 工具耗时文案：<1s 用 ms，其余保留一位小数秒。
 *
 * @param {unknown} ms
 * @returns {string}
 */
export function fmtToolDur(ms) {
  const n = Number(ms) || 0;
  return n < 1000 ? n + 'ms' : (n / 1000).toFixed(1) + 's';
}

/**
 * 时间线汇总：步数 / 失败数 / 总耗时 / 头行文案。
 *
 * @param {Array<{failed?: boolean, durationMs?: unknown}>} [items]
 * @returns {{count: number, failed: number, totalMs: number, countText: string, sumText: string}}
 */
export function toolTimelineSummary(items) {
  const list = items || [];
  const failed = list.filter((s) => s.failed).length;
  const totalMs = list.reduce((a, s) => a + (Number(s.durationMs) || 0), 0);
  const detail = list.length + ' 步' + (failed ? ' · ' + failed + ' 个失败' : '');
  return {
    count: list.length,
    failed,
    totalMs,
    countText: detail,
    sumText: totalMs ? fmtToolDur(totalMs) : '',
  };
}

/**
 * 默认可见步：前 3 步 + 所有失败步（失败步免展开可见）。
 *
 * @param {Array<{failed?: boolean}>} [items]
 * @param {boolean} [expanded]
 * @returns {number[]}
 */
export function toolTimelineVisibility(items, expanded) {
  const list = items || [];
  if (expanded) return list.map((_, i) => i);
  const keep = new Set();
  for (let i = 0; i < Math.min(TOOL_TL_DEFAULT_VISIBLE, list.length); i++) keep.add(i);
  list.forEach((s, i) => { if (s.failed) keep.add(i); });
  return [...keep].sort((a, b) => a - b);
}

/**
 * 轨迹耗时文案：<60s 用秒；<60m 用 m/s；否则 h/m。
 *
 * @param {unknown} ms
 * @returns {string}
 */
export function fmtTraceDur(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (total < 60) return total + 's';
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return m + 'm' + (s ? s + 's' : '');
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return h + 'h' + (rm ? rm + 'm' : '');
}

/**
 * 子代理一行的视图：名称 · 轮次 · 工具次数 · 最后进展 · 状态（缺失字段如实显示 —，不编造）。
 *
 * @param {any} sub 子代理快照
 * @returns {Record<string, any>}
 */
export function subagentRowView(sub) {
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

/**
 * 一轮的完整视图（工具步 + 子代理 + 摘要文案）；对话流与右栏消费同一个对象。
 *
 * @param {{now?: unknown, round?: unknown, startedAt?: unknown, endedAt?: unknown,
 *          tools?: any[], subs?: any[]}} [round]
 * @returns {{round: number, tools: any[], subs: any[], toolCount: number, subCount: number,
 *           failed: number, durationMs: number, durationText: string, summary: string}}
 */
export function traceRoundView(round) {
  const r = round || {};
  const now = Number(r.now) || Date.now();
  const tools = (r.tools || []).map((t) => toolStepView(t, t.done));
  const subs = (r.subs || []).map(subagentRowView);
  const started = Number(r.startedAt) || 0;
  const ended = r.endedAt != null ? Number(r.endedAt) : now;
  const durationMs = started ? Math.max(0, ended - started) : 0;
  const durationText = started ? fmtTraceDur(durationMs) : '';
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
