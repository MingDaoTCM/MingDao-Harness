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

// ---------------------------------------------------------------------------
// 输入队列（v0.6.39）：生成中继续输入 → 排队，本轮结束后自动发出
//
// 为什么放在这里而不是直接写在 app.js：队列的**语义**（去重、上限、截断、何时排空）是纯逻辑，
// 必须能被单测钉住；DOM 渲染只是把它画出来。DSH 等 harness 的做法也是"输入先入队、在回合边界消费"。
// ---------------------------------------------------------------------------

/** 队列上限：防止用户连点把内存撑爆（也避免"一次发 50 条"把模型打爆）。 */
export const QUEUE_MAX = 20;
/** chip 上显示的最大字符数。 */
export const QUEUE_LABEL_MAX = 42;

/**
 * 把一条输入加入队列。
 * 空文本直接拒绝（不要让空 chip 出现在界面上）；满员拒绝并给出可读原因。
 * @param {Array<{id:string,text:string}>} queue
 * @param {string} text
 * @param {string} id
 * @returns {{ok:boolean, queue:Array<{id:string,text:string}>, reason?:string}}
 */
export function enqueueMessage(queue, text, id) {
  const list = Array.isArray(queue) ? queue : [];
  const t = String(text == null ? '' : text);
  if (!t.trim()) return { ok: false, queue: list, reason: 'empty' };
  if (list.length >= QUEUE_MAX) return { ok: false, queue: list, reason: 'full' };
  return { ok: true, queue: [...list, { id: String(id || ''), text: t }] };
}

/**
 * 从队列里移除指定 id。
 * @param {Array<{id:string,text:string}>} queue
 * @param {string} id
 * @returns {{queue:Array<{id:string,text:string}>, removed:({id:string,text:string}|null)}}
 */
export function dequeueMessage(queue, id) {
  const list = Array.isArray(queue) ? queue : [];
  const idx = list.findIndex((q) => String(q?.id) === String(id));
  if (idx < 0) return { queue: list, removed: null };
  return { queue: [...list.slice(0, idx), ...list.slice(idx + 1)], removed: list[idx] };
}

/**
 * chip 上的单行显示文本（换行压成空格，超长截断加省略号）。
 * @param {{text?:string}} item
 * @returns {string}
 */
export function queueLabel(item) {
  const t = String(item?.text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > QUEUE_LABEL_MAX ? t.slice(0, QUEUE_LABEL_MAX - 1) + '…' : t;
}

/**
 * 本轮是否可以排空队列。
 * 关键：**用户主动中止（aborted）时不排空**——中止的语义是"停下"，此时接着发下一条会违背用户意图；
 * 而"任务完成""出错"都应当继续把用户已经写好的下一条发出去（用户已经表达了意图）。
 * @param {{queue?:Array<any>, generating?:boolean, aborted?:boolean}} st
 * @returns {boolean}
 */
export function shouldDrainQueue(st) {
  const q = Array.isArray(st?.queue) ? st.queue : [];
  return q.length > 0 && !st?.generating && !st?.aborted;
}

/**
 * 队列的渲染模型（含序号、截断文本）。
 * @param {Array<{id:string,text:string}>} queue
 * @returns {Array<{id:string,index:number,label:string,text:string}>}
 */
export function queueView(queue) {
  const list = Array.isArray(queue) ? queue : [];
  return list.map((q, i) => ({ id: String(q?.id || ''), index: i + 1, label: queueLabel(q), text: String(q?.text ?? '') }));
}

// ---------------------------------------------------------------------------
// 插话（v0.6.40）：生成中 Cmd/Ctrl+Enter → **插入当前轮**，不是排到下一轮
//
// 与 next-turn 队列（上面的 enqueueMessage 一族）是**两条车道**：
//   · next-turn：本轮全部结束后，才按每轮 1 条依次发出（drainQueue）；
//   · next-step：每个 step 边界**全量取走**（drainSteer），作为新的 user 消息插进当前请求；
//     模型本次没有工具调用、本来要收尾时，只要 next-step 非空就继续下一步（shouldContinueAfterModel）。
// 纯逻辑仍放在这里：上限、字节口径、全量取走、是否继续，都必须被单测钉住。
// ---------------------------------------------------------------------------

/** 插话队列上限（Octop 的 STEER_DEPTH_CAP 同值）：一次最多积 8 条，多则拒绝。 */
export const STEER_MAX = 8;
/** 单条插话文本上限：200KB（UTF-8 字节，不是字符数——中文一字 3 字节）。 */
export const STEER_TEXT_MAX = 200 * 1024;

/**
 * 文本的 UTF-8 字节数（浏览器与 Node 同一口径；TextEncoder 不可用时退回字符数）。
 * @param {unknown} text
 * @returns {number}
 */
export function steerBytes(text) {
  const t = String(text == null ? '' : text);
  try {
    return new TextEncoder().encode(t).length;
  } catch {
    return t.length;
  }
}

/**
 * 把一条输入加入**插话**队列（下一步注入本轮）。
 * 空文本 / 超长（>200KB）/ 满员（≥8 条）都拒绝并给出可读 reason；超长先于满员判定，
 * 这样"又能插但太长"始终得到 413 而不是 429。
 * @param {Array<{id:string,text:string,at?:number}>} steer
 * @param {string} text
 * @param {string} id
 * @param {number} [at] 入队时刻（由调用方注入，保持本函数纯净；缺省 0）
 * @returns {{ok:boolean, steer:Array<{id:string,text:string,at?:number}>, reason?:string}}
 */
export function enqueueSteer(steer, text, id, at) {
  const list = Array.isArray(steer) ? steer : [];
  const t = String(text == null ? '' : text);
  if (!t.trim()) return { ok: false, steer: list, reason: 'empty' };
  if (steerBytes(t) > STEER_TEXT_MAX) return { ok: false, steer: list, reason: 'too-long' };
  if (list.length >= STEER_MAX) return { ok: false, steer: list, reason: 'full' };
  return { ok: true, steer: [...list, { id: String(id || ''), text: t, at: Number(at) || 0 }] };
}

/**
 * **全量取走**插话队列（每个 step 边界消费一次，不是每条一步）。
 * 取走后原队列变空；对空队列再调用返回空 taken（幂等，不抛）。
 * @param {Array<{id:string,text:string,at?:number}>} steer
 * @returns {{steer:Array<{id:string,text:string,at?:number}>, taken:Array<{id:string,text:string,at?:number}>}}
 */
export function drainSteer(steer) {
  const list = Array.isArray(steer) ? steer : [];
  return { steer: [], taken: [...list] };
}

/**
 * 插话 chip 的渲染模型（与 queueView 同形，另带 kind/icon 供 UI 用不同配色区分）。
 * @param {Array<{id:string,text:string,at?:number}>} steer
 * @returns {Array<{id:string,index:number,label:string,text:string,kind:'steer',icon:'⚡'}>}
 */
export function steerView(steer) {
  const list = Array.isArray(steer) ? steer : [];
  return list.map((s, i) => ({
    id: String(s?.id || ''),
    index: i + 1,
    label: queueLabel(s),
    text: String(s?.text ?? ''),
    kind: /** @type {'steer'} */ ('steer'),
    icon: /** @type {'⚡'} */ ('⚡'),
  }));
}

/**
 * 模型本次没有工具调用、本来要收尾时，是否应当**继续下一步**（而不是结束本轮）。
 * 有插话就继续；用户中止 / 无进展看门狗触发时不继续（"停下"优先于插话）。
 * @param {{steer?:Array<any>, aborted?:boolean, stalled?:boolean}} st
 * @returns {boolean}
 */
export function shouldContinueAfterModel(st) {
  const list = Array.isArray(st?.steer) ? st.steer : [];
  return list.length > 0 && !st?.aborted && !st?.stalled;
}

// ---------------------------------------------------------------------------
// SSE 序号连续性（v0.6.41 §1.1 切片 B1 的客户端一半）
//
// 服务端每帧带 `streamSeq`（**每个 task** 从 1 单调 +1）与 `id:` 行；客户端持流游标 lastSeq。
// 丢帧（跳号）时**不逐帧续接**，而是按 DSH 的 resync 语义整窗重取快照——
// 否则界面会停在"少了几段正文/几个工具结果"的错误状态且无人知晓。
// 三个函数都是纯函数：判定表、救援顺序、给用户的一行文案都必须被单测钉住。
// ---------------------------------------------------------------------------

/**
 * SSE 帧序号连续性判定（客户端游标 lastSeq，首帧前为 0）。
 *
 * 判定表：
 *   incomingSeq == null（旧服务端 / 无 streamSeq 帧） → `ignore`（**只跳过序号判定，业务照常处理**）
 *   lastSeq === 0 且 incomingSeq === 1          → `accept`（首帧基线）
 *   lastSeq === 0 且 incomingSeq !== 1          → `resync`（连开头都缺了，gap = incomingSeq-1）
 *   incomingSeq === lastSeq + 1                 → `accept`
 *   incomingSeq <= lastSeq                      → `ignore`（重复/乱序旧帧，不重复渲染）
 *   incomingSeq > lastSeq + 1                   → `resync`（gap = incomingSeq - lastSeq - 1）
 *
 * `ok` 只表示"连续性没坏"：`accept`/`ignore` 都是 true，只有 `resync` 是 false。
 * @param {{lastSeq?:number, incomingSeq?:number|null}} [frame]
 * @returns {{ok:boolean, gap:number, action:'accept'|'resync'|'ignore'}}
 */
export function seqContinuity({ lastSeq, incomingSeq } = {}) {
  const incoming = incomingSeq == null ? null : Number(incomingSeq);
  if (incoming === null || !Number.isInteger(incoming)) {
    // 旧服务端兼容：没有 streamSeq（或它不是整数）→ 不参与连续性判断，业务照常。
    return { ok: true, gap: 0, action: 'ignore' };
  }
  const rawLast = Number(lastSeq);
  const last = Number.isInteger(rawLast) && rawLast > 0 ? rawLast : 0;
  if (last === 0) {
    // 首帧必须是 1：否则说明客户端错过的不是"中间几帧"，而是流开头。
    return incoming === 1
      ? { ok: true, gap: 0, action: 'accept' }
      : { ok: false, gap: Math.max(0, incoming - 1), action: 'resync' };
  }
  if (incoming === last + 1) return { ok: true, gap: 0, action: 'accept' };
  if (incoming <= last) return { ok: true, gap: 0, action: 'ignore' };
  return { ok: false, gap: incoming - last - 1, action: 'resync' };
}

/**
 * 跳号后怎么救（v0.6.41 B1 只有两态）：
 *   · 有会话文件 → `snapshot`：复用「加载会话」整窗重取/重渲染（DSH `resync()` 语义）；
 *   · 没有会话文件（新会话首轮，服务端还没落盘）→ `none`：不重建空窗口，调用方插可见提示。
 *
 * 为什么没有 `events`：`GET /api/events` 返回的是**会话事件**（`message.append` / `tool.start`），
 * 不是 SSE 帧（`text` / `toolStart`），塞进现有 SSE 分派器渲染不出来——事件→UI 的投影留到 B2。
 * `hasTask` 只为调用方/B2 预留，B1 的判断不依赖它（没有会话快照就没有可重取的窗口）。
 * @param {{gap?:number, hasSession?:boolean, hasTask?:boolean}} [ctx]
 * @returns {{mode:'snapshot'|'none', reason:string}}
 */
export function resyncPlan({ gap, hasSession } = {}) {
  const g = Math.max(0, Math.floor(Number(gap) || 0));
  if (hasSession) return { mode: 'snapshot', reason: `会话文件可用：整窗重取快照（跳过 ${g} 条事件）` };
  return { mode: 'none', reason: `没有可重取的会话快照（新会话尚未落盘）：只提示、不重建窗口（跳过 ${g} 条事件）` };
}

/**
 * 重取成功后插进对话流的一行**低调**提示（不是 errline，不吓人）。
 * @param {{gap?:number}} [ctx]
 * @returns {string} gap<=0 / 非法值 → 空串（不插提示）
 */
export function seqBanner({ gap } = {}) {
  const g = Math.floor(Number(gap));
  if (!Number.isFinite(g) || g <= 0) return '';
  return `已跳过 ${g} 条事件，正在重新同步…`;
}
