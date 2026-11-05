// v0.7.0 §1.5：文案 / 预测层（零 I/O、无状态的纯函数与常量）。
//
// 本文件从 src/agent.js **逐字**切出（v0.7.0 §1.5 第一步，逻辑零变化）：TTFT 提示判定与进程级节流状态、
// 无进展看门狗阈值与中止文案、内存降级的两级压缩、端点学习值预告、prefill 外推与规模预告、
// 上游错误解读、回合进度行、只读档判定。
//
// 切出来的理由：这些"文案与预测"是**可单独断言、可单独变异**的那一层，留在 2700 行的循环文件里
// 只能靠整份 agent.js 才能测；而循环/编排那一层（createAgent、runTurn、子代理、账本）一行都没动。
//
// 依赖约定：
//   · **不 import agent.js**（避免成环）——依赖方向只有 agent.js → messages.js；
//   · 除下面这一条外不 import 任何模块（纯函数层不碰 fs / 网络 / 配置）：
//     isMemoryPressureError 的**单一来源**在协议层（providers/openai-compatible.js，agent.js 原本经
//     providers/index.js 转出用它做「是不是内存压力」判据）。这里直接取实现模块，避免为了一个纯判据
//     把整张 provider 注册表拉进本层。

import { isMemoryPressureError } from './providers/openai-compatible.js';

// ---------------------------------------------------------------------------
// v0.6.13（A / 真机实测：本地 35B 的审计回合跑了 4+ 小时、界面 0 步、日志零行）
//
// 现有三个超时（src/providers/index.js）**全是单请求级**：
//   · 首帧等待 firstTokenMs：本地 600s / 远程 300s（第一帧到达即解除）
//   · 流式空闲 streamIdleMs：120s（每收到一帧就重置）
//   · 单请求总量 totalMs   ：本地 1800s / 远程 600s
// 而一个回合的最坏规模是 `maxRounds × stepLimit` 次请求（默认 3 × 24 = 72），每次都能耗到
// totalMs；`task` 子代理**各自**又有同样一整套预算且可递归派生。于是"每十几分钟返回一次、
// 什么都没做成"的回合能跑掉几小时——单请求超时一次都不会响，日志里一行都不会留。
//
// 这里补两件**回合级**的事（与单请求超时互补，不替代）：
//   ① 无进展看门狗：连续 noProgressTimeoutMs 既没有工具结果返回、也没有新正文/推理增量
//      → 主动中止并如实报告（默认值依据见下）；
//   ② 进度可见性：首帧时延（TTFT）/ 帧数 / 字符数 / 模型轮次 / 工具调用数 / 正在等待的工具
//      挂在 io.turnProgress 上，由 WebUI 服务端（src/web/server.js）定期写 web-server.log
//      并随状态条下发——"在跑"与"卡死"必须能一眼区分。
// ---------------------------------------------------------------------------

/** 无进展看门狗默认阈值（ms）= 2 × 现有**单请求总量**上限（本地 1800s，见 providers/index.js）。
 *
 *  依据（不拍脑袋，逐条对齐现有超时）：
 *   · 首帧 600s / 空闲 120s / 总量 1800s 都是**单请求**级；回合级阈值若小于单请求上限，
 *     一次慢 prefill 就会被误判成"卡死"——那比现有超时更激进，明确不做；
 *   · 取 2×（60 分钟）而不是 1×：一次请求跑满 1800s 时，报错该由**更具体**的请求级超时给出
 *     （首帧/空闲/总量各有各的文案、各有各的处置建议），看门狗不抢答；2× 又足以兜住
 *     "请求都按时返回、整回合零产出"的空转（本次真机就是这一形态：610 次工具调用、
 *     相邻两次最长只隔 7.1 分钟，却 4+ 小时没有任何交付）；
 *   · 真干活的回合每隔几秒就有工具结果或正文增量，60 分钟零增量在任何正常回合都不可能。
 *
 *  可配置：config.noProgressTimeoutMs（0/负数/NaN/Infinity 一律回落默认——**不能**用它关掉看门狗）。 */
// v0.6.31（负责人实测）：TTFT 提示"每个回合各打一次"在长审计里刷屏。
//
// 现象：本地模型跑长审计时，聊天区反复出现「⏱ 首帧 10.9s（第 1 次模型请求…）」十几次，
// 而且**每次都写"第 1 次"**——因为每个「回合」都是新 turnProgress（用户点「继续」/自动续跑
// 都算新回合），`llmCalls===1` 这个条件对每个回合都成立。
//
// 判定抽成**纯函数**（可单测、可变异），状态放**进程级**（WebUI 每请求新建 agent，只有进程级
// 才能跨回合节流；键用会话名/工作目录）。
// v0.7.0 §1.5：agent.js 的循环要拿它当 config.ttftNoticeQuietMs 的默认值，故导出（其余常量仍是本层私有）。
export const TTFT_NOTICE_DEFAULT_QUIET_MS = 10 * 60 * 1000;
/** @type {Map<string, {ms: number|null, at: number}>} */
const ttftNoticeState = new Map();

/**
 * 本次是否该打印 TTFT 提示。
 * 规则：① 每回合只在第 1 次请求时考虑；② 同一会话 quietMs 内不重复；
 *      ③ 首帧比上次打印时**明显变慢**（≥ slowdownRatio 倍）则例外——劣化信号不能被节流吃掉。
 * @param {{llmCalls:number, ttftMs:number, lastMs?:number|null, lastAt?:number, now:number,
 *          quietMs?:number, slowdownRatio?:number}} a
 * @returns {{print: boolean, slowdown: boolean}}
 */
export function shouldPrintTtftNotice({ llmCalls, ttftMs, lastMs = null, lastAt = 0, now, quietMs = TTFT_NOTICE_DEFAULT_QUIET_MS, slowdownRatio = 2 }) {
  if (Number(llmCalls) !== 1) return { print: false, slowdown: false };
  const ms = Number(ttftMs);
  if (!Number.isFinite(ms)) return { print: false, slowdown: false };
  const slowdown = Number(lastMs) > 0 && ms >= Number(lastMs) * Number(slowdownRatio);
  if (slowdown) return { print: true, slowdown: true };
  if (!Number(lastAt)) return { print: true, slowdown: false };
  return { print: now - Number(lastAt) >= Number(quietMs), slowdown: false };
}

/**
 * 读/写某会话的 TTFT 提示节流状态（进程级，上限 200 个键防泄漏）。
 * @param {string} key
 * @returns {{ms: number|null, at: number}}
 */
export function ttftNoticeStateFor(key) {
  const k = String(key || 'default');
  let v = ttftNoticeState.get(k);
  if (!v) {
    v = { ms: null, at: 0 };
    if (ttftNoticeState.size >= 200) {
      // TS7 下 `MapIterator#value` 是 `string | undefined`：先收窄再删（与原来等价，size>=200 时必有键）。
      const oldest = ttftNoticeState.keys().next().value;
      if (oldest !== undefined) ttftNoticeState.delete(oldest);
    }
    ttftNoticeState.set(k, v);
  }
  return v;
}

export const DEFAULT_NO_PROGRESS_TIMEOUT_MS = 3600000;

/** 父回合在等待 `task` 子代理时额外给的一点点宽限（ms）。
 *
 *  v0.6.13（问题 3）：子代理的看门狗与父回合是**同一个阈值**，两者会在同一刻到点；
 *  必须让**子代理先响**——否则父回合先掐断，`task` 的工具结果里只剩"父回合中止"，
 *  用户看不出子代理自己卡在哪一步、跑到了第几轮（真机现场正是这种形态）。
 *  这不是"把阈值调大掩盖问题"：判据没动、默认值没动，只是在"父回合正等子代理"这一种
 *  形态下多等 15s（相对默认 60 分钟是 0.4%），换"子代理自己的结论能回传父回合"。 */
export const SUBAGENT_WAIT_GRACE_MS = 15000;

/** 本地引擎内存不足时的**多级压缩**策略（v0.6.26 §3.91）。
 *
 *  真机三次同形态失败（10-18 / 10-19 / 10-26）证明"只压一级、只重试一次"不够：
 *  32,768 → 19,660 之后仍被引擎拒绝，整回合直接失败，而更狠的一级（0.35）没人试过。
 *  两级都相对**本回合起手预算**计算（不是逐级连乘），这样日志/文档里的数值一一对应，
 *  不会被"0.6×0.35"这种连乘悄悄压到系统提示都放不下：
 *    第 1 级：预算 ×0.6（32,768 → 19,660）、输出 ×0.5（8,192 → 4,096）；
 *    第 2 级：预算 ×0.35（32,768 → 11,468）、输出 ×0.25（8,192 → 2,048）。
 *  下限：预算 4,096（再低连系统提示 + 一轮工具结果都放不下）、输出 512。
 *  抽成常量是为了让"最多 2 次 / 每级参数"可被断言与变异钉住。 */
export const MEMORY_RECOVERY_LEVELS = Object.freeze([
  Object.freeze({ budgetRatio: 0.6, maxOutputRatio: 0.5, minBudget: 4096, minMaxOutput: 512 }),
  Object.freeze({ budgetRatio: 0.35, maxOutputRatio: 0.25, minBudget: 4096, minMaxOutput: 512 }),
]);

/** 内存降级重试的**硬性上限** = 压缩级数（2）。绝不允许无限重试。 */
export const MAX_MEMORY_RETRIES = MEMORY_RECOVERY_LEVELS.length;

/**
 * 第 retry 级压缩后的预算/输出上限（纯函数，便于断言/变异）。
 * @param {{ budget: number, maxOutput: number, retry: number }} input
 * @returns {{ level: number, budget: number, maxOutput: number }}
 */
export function memoryRecoveryTarget({ budget, maxOutput, retry }) {
  const want = Math.max(1, Math.floor(Number(retry) || 1));
  const idx = Math.min(MEMORY_RECOVERY_LEVELS.length, want) - 1;
  const level = MEMORY_RECOVERY_LEVELS[idx];
  return {
    level: idx + 1,
    budget: Math.max(level.minBudget, Math.floor((Number(budget) || 0) * level.budgetRatio)),
    maxOutput: Math.max(level.minMaxOutput, Math.floor((Number(maxOutput) || 0) * level.maxOutputRatio)),
  };
}

/** 学习值日期：ISO → YYYY-MM-DD（给"来自 YYYY-MM-DD 的失败学习"用，时区固定 UTC，避免跨时区漂一天）。 */
function fmtLearnedDate(/** @type {any} */ value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '未知日期' : d.toISOString().slice(0, 10);
}

/**
 * 端点学习值的「chat 预告」文案（纯函数）：必须同时说清**本轮预算是多少**与**这个数字从哪来**。
 * 只报"预算已降级"而不给出处，用户无法判断该不该相信它（也无法判断要不要手动调回去）。
 * @param {{ budget?: number, record?: any }} input
 * @returns {string}
 */
export function endpointLearnedNotice({ budget, record } = {}) {
  const safe = Math.floor(Number(record?.safeContextBudget) || 0);
  const used = Math.floor(Number(budget) || 0);
  if (!(safe > 0) || !(used > 0)) return '';
  const how = record?.source === 'success-upgrade' ? '成功上调' : '失败学习';
  return (
    `📉 该端点曾因内存不足降级，本轮预算 ${fmtTok(used)}` +
    `（来自 ${fmtLearnedDate(record?.learnedAt)} 的${how}；端点安全预算 ${fmtTok(safe)}）`
  );
}


/** 解析无进展阈值：非正/非有限一律回落默认（fail-safe，防"配置写 0 就静默失去看门狗"）。 */
export function resolveNoProgressTimeoutMs(/** @type {any} */ cfg) {
  const v = Number(cfg?.noProgressTimeoutMs);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_NO_PROGRESS_TIMEOUT_MS;
}

/** 上下文占窗口比例的告警线（≥ 此值 → 显式警告"缩小任务/或调大 firstTokenMs"）。 */
export const PREFILL_WARN_RATIO = 0.8;
/** 本地端点的 prompt 规模告警线（tokens）：**只在没有预检数据时**用它兜底（有实测就不用规模猜）。 */
export const PREFILL_WARN_TOKENS = 60000;
/** 由预检外推的 prefill 超过它就显式告警（ms）。依据见下面 prefillForecast 的注释。 */
export const PREFILL_SLOW_WARN_MS = 60000;
/** "线性外推会低估"的**实测证据**（写进文案，让用户知道外推值不是承诺）。
 *
 *  真机（负责人 2026-10-09，同一个 taskId t424aaab2aecab8a3）：
 *    04:13:27 预告 本轮上下文 ≈ 15,983 tokens；预检「参考 prefill 2000 tokens 0.08s」
 *    04:14:17 chat 首帧 t424aaab2aecab8a3 **53.7s**
 *  线性外推 = 0.08s × 15983/2000 ≈ 0.6s，实测 53.7s —— **差约 90 倍**。
 *  原因：2000 tokens 的参考样本落在引擎的短上下文快路径上；真实任务把 KV cache 占满后，
 *  dequant/内存压力会让 prefill 显著变慢（真机现场还有 `insufficient memory … during prefill`）。
 *  所以文案**只报外推值是不够的**，必须同时说出这条实测差值。 */
export const PREFILL_LONGCTX_EVIDENCE = '本机实测 16k tokens 首帧 53.7s，而按同一份预检外推只有 0.6s（约 90 倍）';

/** 把毫秒格式化成给人看的时长（<60s 用秒、否则 m分s秒）。 */
const fmtDur = (/** @type {number} */ ms) => {
  const s = Number(ms) / 1000;
  if (!Number.isFinite(s) || s < 0) return '？';
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`;
};

/** 参考 prefill 的耗时格式化：保留两位（76ms → 0.08s），否则"0.1s/2000 tokens 外推"会把
 *  预检实测值四舍五入到看不出量级（真机预检正是 0.08s 这一档）。 */
const fmtRefDur = (/** @type {number} */ ms) => {
  const s = Number(ms) / 1000;
  if (!Number.isFinite(s) || s < 0) return '？';
  return s < 60 ? `${s.toFixed(2)}s` : fmtDur(ms);
};

/**
 * 由**预检实测**外推本轮 prefill 耗时（纯函数，便于断言/变异）。
 *
 * 为什么是线性外推而不是照搬老文案：老文案对任何本地端点都说"prefill 可能需数分钟至数十分钟"，
 * 而同一条预告的后半句又写着"参考 prefill 2000 tokens 0.08s"——**同一行自相矛盾**，
 * 结果就是用户学会忽略这条告警（本次真机 04:13:27 的现场）。
 *
 * 判据（只认实测，不认规模）：
 *   · 有 `probe.prefillMs`（预检测过固定参考 prefill）→ `prefillMs × 本轮tokens / 参考tokens`；
 *   · 没有 → 返回 null，调用方**退回**保守文案（不可达 / 不可判定 / 未预检）。
 * 外推的已知偏差（长上下文下引擎显著变慢）不由本函数掩盖——由调用方写进文案（见 PREFILL_LONGCTX_EVIDENCE）。
 * @param {{ promptTokens: number, probe?: any }} input
 * @returns {{ ms: number, refTokens: number, refMs: number, tokens: number }|null}
 */
export function prefillEstimateMs({ promptTokens, probe = null }) {
  const p = Math.max(0, Math.round(Number(promptTokens) || 0));
  const refMs = Number(probe?.prefillMs);
  if (!(refMs > 0) || p <= 0) return null;
  const refTokens = Number(probe?.prefillTokens) > 0 ? Number(probe.prefillTokens) : 2000;
  return { ms: Math.round((refMs * p) / refTokens), refTokens, refMs, tokens: p };
}

// v0.7.0 §1.5：本函数随文案层一起搬来；agent.js 的日志/提示行仍要用它，故导出（其余 fmt* 只在内部用）。
export const fmtTok = (/** @type {any} */ n) => Number(n || 0).toLocaleString('en-US');

/**
 * 发送前的规模预告（纯函数，便于断言/变异）：把"这次要 prefill 多少"在**请求发出前**说出来。
 * 本地端点尤其重要——它既不提供 prefill 进度，首帧又可能是几十分钟。
 *
 * v0.6.13（问题 1 修法）：**有预检实测就必须由它推导**，并在文案里如实标注
 * ①这是外推、②长上下文下外推会低估（附实测差值）；只有在**没有预检数据**时才退回保守文案。
 *
 * v0.6.15（§3.59 第 3 条）：本地端点**已有在途请求**（父回合/子代理/预检之一）时加一句强警告——
 * 真机 8081 的内存拒绝就是"父子回合同时 prefill"撞出来的；串行化已经兜住资源，但用户仍应
 * 知道"并发会加剧内存压力、应减少子代理"。
 *
 * v0.6.26 §3.91：`learned`（端点学习值）存在时，预告里必须写明"本轮预算 N 来自哪天的失败学习"——
 * 用户看到预算比自己配置的小，必须能一眼知道是内核学的、不是配置被改了。
 * @param {{ promptTokens: number, contextWindow?: number, isLocal?: boolean,
 *           firstTokenMs?: number, budget?: number, probe?: any,
 *           localBusy?: boolean, localActive?: number, localQueued?: number, localConcurrency?: number,
 *           learned?: any }} input
 * @returns {{ text: string, warn: boolean, promptTokens: number, ratio: number, estimateMs: number|null }}
 */
export function prefillForecast({ promptTokens, contextWindow, isLocal, firstTokenMs, budget, probe = null, localBusy = false, localActive = 0, localQueued = 0, localConcurrency = 1, learned = null }) {
  const p = Math.max(0, Math.round(Number(promptTokens) || 0));
  const win = Number(contextWindow) > 0 ? Number(contextWindow) : 0;
  const ratio = win > 0 ? p / win : 0;
  const pct = Math.round(ratio * 100);
  const secs = Number(firstTokenMs) > 0 ? Math.round(Number(firstTokenMs) / 1000) : 0;
  const head = `📏 本轮上下文 ≈ ${fmtTok(p)} tokens${win ? `（${fmtTok(win)} 窗口的 ${pct}%）` : ''}${Number(budget) > 0 ? `，预算 ${fmtTok(budget)}` : ''}`;
  const est = prefillEstimateMs({ promptTokens: p, probe });
  const estNote = est ? `按预检 ${fmtRefDur(est.refMs)}/${fmtTok(est.refTokens)} tokens 外推，本轮 ≈${fmtDur(est.ms)}` : '';
  // 三个分支（顺序即优先级）：
  //   ① 有预检实测 → 报外推值 + **如实**说明长上下文会低估（附真机差值）；
  //   ② 无预检数据（不可达/不可判定/未预检）→ 退回既有保守文案（真机 01:26 那次就是这一支）；
  //   ③ 远程端点 → 各自一句。
  const timing = est
    ? `${isLocal ? '本地端点' : '远程端点'}：${estNote}` +
      `（**线性外推**，只作量级参考——长上下文下引擎可能显著变慢：${PREFILL_LONGCTX_EVIDENCE}；` +
      `外推低估时以首帧等待为准）；首帧等待上限 ${secs}s（config.timeout.firstTokenMs）`
    : isLocal
      ? `本地端点：prefill 可能需数分钟至数十分钟（该端点不提供进度预告，只能等首帧）；首帧等待上限 ${secs}s（config.timeout.firstTokenMs）`
      : `远程端点：首帧通常在数十秒内；首帧等待上限 ${secs}s（config.timeout.firstTokenMs）`;
  // 三条告警线：
  //   · 占窗口 ≥80%：任何端点都危险（与 prefill 快慢无关，这是"上下文压力"）；
  //   · **外推** prefill ≥ PREFILL_SLOW_WARN_MS：端点实测明显慢，依据 = 预检实测 × 本轮 tokens；
  //   · 本地端点 + prompt ≥ PREFILL_WARN_TOKENS：**仅在拿不到预检数据时**兜底
  //     （有实测就不再用规模猜——那正是"0.08s 的端点被说成需要数十分钟"的来源）。
  const hitRatio = ratio >= PREFILL_WARN_RATIO;
  const hitSlow = est != null && est.ms >= PREFILL_SLOW_WARN_MS;
  const hitLocal = est == null && Boolean(isLocal) && p >= PREFILL_WARN_TOKENS;
  const warn = hitRatio || hitSlow || hitLocal;
  const why = hitRatio
    ? `上下文已占窗口 ${pct}%（≥${Math.round(PREFILL_WARN_RATIO * 100)}%）`
    : hitSlow
      ? `按预检外推本轮 prefill ≈${fmtDur(est ? est.ms : 0)}（${est ? fmtRefDur(est.refMs) : '？'}/${est ? fmtTok(est.refTokens) : '？'} tokens × ${fmtTok(p)} tokens，≥${Math.round(PREFILL_SLOW_WARN_MS / 1000)}s 告警线）`
      : `本地端点 + 上下文 ${fmtTok(p)} tokens（≥${fmtTok(PREFILL_WARN_TOKENS)}），且本次没有任何预检实测可外推`;
  const advice = warn
    ? `\n   ⚠ ${why}：` +
      `建议缩小任务（新建会话、只给必要文件、先 /compact）或调大 config.timeout.firstTokenMs——` +
      `但注意调大它只会让"失败"更晚被发现，不会让 prefill 变快。`
    : '';
  // v0.6.15（§3.59 第 3 条）：本地端点已有在途请求 → **强警告**（不是提示）。
  // 真机证据：父回合 + 子代理同时向同一台 8081 引擎发大 prefill，引擎在 prefill 阶段报
  // insufficient memory（"engine shed its caches and stays up"）；串行化解决资源冲突，
  // 但用户仍必须知道"并发会加剧内存压力"，否则会继续开并行子代理/多会话。
  const limit = Number(localConcurrency) >= 0 ? Math.floor(Number(localConcurrency)) : 1;
  const active = Math.max(0, Math.floor(Number(localActive) || 0));
  const queued = Math.max(0, Math.floor(Number(localQueued) || 0));
  const concurrencyNote = Boolean(isLocal) && Boolean(localBusy)
    ? `\n   ⚠ 本地端点当前已有 ${active} 个在途请求${queued > 0 ? `、${queued} 个在排队` : ''}（并发上限 ${limit}）：` +
      `**并发会加剧内存压力**（父子回合同时 prefill 会被引擎以 insufficient memory 拒绝）；` +
      `${limit <= 1 ? '已串行化，后来的请求会排队等待' : `已限制为 ${limit} 并发，仍可能叠加内存压力`}——建议减少子代理数量、避免多个长任务会话同时跑。`
    : '';
  // v0.6.13（A 追加）：把**端点预检**结果并进这条预告——"这个端点行不行"与"这次要 prefill 多少"
  // 必须一起出现在发送前，而不是等出事后翻日志（引擎实际加载的模型名与配置名不一致也在这里说）。
  const probeLine = probe && probe.note ? `\n   端点预检：${probe.note}` : '';
  // v0.6.26 §3.91：端点学习值必须出现在**发送前的预告**里（预算为什么比配置小、这个数字从哪来）。
  const learnedNote = endpointLearnedNotice({ budget, record: learned });
  return { text: `${head}\n   ${timing}${probeLine}${advice}${concurrencyNote}${learnedNote ? `\n   ${learnedNote}` : ''}`, warn: warn || Boolean(concurrencyNote), promptTokens: p, ratio, estimateMs: est ? est.ms : null };
}

/**
 * 无进展中止文案（纯函数）：必须同时说清「多久没进展」「发生了什么」「在等谁」「下一步怎么办」，
 * 并且**与 capped/aborted 区分开**（v0.6.13 问题 4：真机上用户只看到一句"回合收尾"，
 * 分不清"跑满了步数（可续跑）""我点了停止"和"再等下去也不会有新东西"）。
 * @param {{ waitedMs: number, toolCalls?: number, modelRounds?: number, unproductive?: number,
 *           pendingTool?: { name: string, ms: number }|null,
 *           subagent?: { label?: string, modelRounds?: number, toolCalls?: number, at?: number }|null }} input
 */
export function noProgressNotice({ waitedMs, toolCalls = 0, modelRounds = 0, unproductive = 0, pendingTool = null, subagent = null }) {
  // v0.6.13（问题 3 附带修）：不足 1 分钟必须按**秒**说。原实现 Math.max(1, round(ms/60000)) 会把
  // 600ms 说成"连续 1 分钟"——真机上子代理被掐时就谎报过"连续 1 分钟"（它其实一直在干活）。
  const min = Math.max(1, Math.round(Number(waitedMs) / 60000));
  const howLong = Number(waitedMs) >= 60000 ? `${min} 分钟` : `${Math.max(1, Math.round(Number(waitedMs) / 1000))} 秒`;
  const extra = Number(unproductive) > 0 ? `——其中 ${Number(unproductive)} 次工具调用是**重复调用或失败**（没有产生任何新信息）` : '';
  const waiting = pendingTool
    ? `\n   ⏳ 中止时**正在等待工具 ${pendingTool.name}**（已 ${Math.round(Number(pendingTool.ms) / 1000)}s）` +
      (subagent
        ? `；该子代理最后进展：第 ${Number(subagent.modelRounds) || 0} 轮 / ${Number(subagent.toolCalls) || 0} 次工具调用` +
          (Number(subagent.at) > 0 ? `（${Math.max(0, Math.round((Date.now() - Number(subagent.at)) / 1000))}s 前）` : '') +
          '。子代理自己的看门狗会先于父回合中止它并回传原因；这里先响说明**连子代理也没有新进展**。'
        : '。')
    : '';
  return (
    `⏹ 连续 ${howLong}没有任何工具调用、也没有新内容（模型请求 ${modelRounds} 轮、工具调用 ${toolCalls} 次${extra}），已中止。\n` +
    `   ⓘ 这是**整轮零进展**（不是步数上限 capped、也不是你点的停止 aborted）：capped 的回合可以接着续跑，本条是"再等下去也不会产出新东西"。` +
    waiting +
    `\n   常见原因：① 该端点/模型不做 function calling（tool_calls 恒为空）；② 本地引擎的 prefill 已停滞或内存吃紧；③ 上游连接还在但不再产出。\n` +
    `   下一步：把任务拆小（新建会话、只给必要文件）或换支持工具调用的端点；阈值可调 config.noProgressTimeoutMs（默认 ${Math.round(DEFAULT_NO_PROGRESS_TIMEOUT_MS / 60000)} 分钟）。`
  );
}

/**
 * 子代理因**父回合的截止时刻**收口时的文案（纯函数）。
 *
 * 为什么必须与 noProgressNotice 分开：真机现场（~/.mingdao/sessions/2026-10-09T02-42-31-qaaa.jsonl
 * 第 28/29 行）两条 `task` 结果都写「连续 1 分钟没有任何工具调用」，而同一句话里又写着
 * 「模型请求 15 轮、工具调用 18 次」——子代理**一直在干活**。原因是继承的截止时刻是
 * spawn 那一刻的**绝对快照**，到点即掐，触发时又拿"子代理自己的最后进展"当等待时长，于是谎报。
 * 修法：①截止时刻随父回合进展前移（不再掐正在干活的子代理）；②真到点时必须如实说
 * "是父回合判定整轮无进展、不是子代理卡住"。
 * @param {{ waitedMs?: number, toolCalls?: number, modelRounds?: number }} input
 */
export function inheritedStopNotice({ waitedMs = 0, toolCalls = 0, modelRounds = 0 }) {
  const secs = Math.max(0, Math.round(Number(waitedMs) / 1000));
  const ago = secs >= 60 ? `${Math.round(secs / 60)} 分钟` : `${secs} 秒`;
  return (
    `⏹ 父回合已判定**整轮无进展**，子代理随整棵子代理树一起收口，已中止。\n` +
    `   子代理自身最后一次真实进展在 ${ago}前（模型请求 ${modelRounds} 轮、工具调用 ${toolCalls} 次）——` +
    `即**不是子代理卡住**，而是父回合整体零进展（父回合没有把子代理的进展计为进展时就会走到这里）。\n` +
    `   下一步：把子任务拆小、减少并行子代理数，或调大 config.noProgressTimeoutMs（默认 ${Math.round(DEFAULT_NO_PROGRESS_TIMEOUT_MS / 60000)} 分钟）。`
  );
}

/**
 * 回合结束时的「0 次工具调用」提示（纯函数）。
 * 触发条件：**任务态**（用户消息含写/执行意图）或发了多轮请求，却一次工具调用都没有——
 * 单轮纯问答本来就不该有工具调用，不该被这条提示打扰。
 * @param {{ modelRounds: number, steps?: number, taskLike?: boolean }} input
 */
export function zeroToolCallNotice({ modelRounds, steps = 0, taskLike = false }) {
  if (!(Number(modelRounds) > 1) && !taskLike) return '';
  return (
    `⚠ 本回合 0 次工具调用（共 ${Number(modelRounds)} 轮模型请求 / ${Number(steps)} 步）：该端点看起来不返回 tool_calls。\n` +
    `   若任务需要读写文件、执行命令，请换支持 function calling 的模型或端点；纯问答可以忽略本条。`
  );
}

/**
 * 上游/引擎错误的可操作解读（纯函数）：把「HTTP 400 + 一段 Jinja/模板报错」这类原文
 * 变成「原文 + 这是什么 + 该怎么办」。识别不出时 hint 为 null（**绝不改原文**）。
 *
 * v0.6.18 §3.74：额外返回 `recoverableByShrinking`——**只有本地端点**的内存/显存不足
 * 才是"压缩上下文 + 降输出 + 串行重试一次"能救的；云端 API 的 507/内存报错不在此列
 * （云端的容量/配额不是本地上下文能改的，对云 API 做压缩重试只会多烧一次请求）。
 *
 * v0.6.26 §3.91：`learned`（该端点的学习值）存在时，建议里必须给出**与学习值一致**的数字
 * （"已把该端点预算记为 N，下轮自动使用"），而不是再抛一个"调到 N 左右"的临时建议——
 * 后者正是真机上"日志给了 13,762、下一回合仍按 32,768 撞墙"的原因。
 * @param {any} err
 * @param {{ isLocal?: boolean, learned?: any }} [opts]
 * @returns {{ message: string, hint: string|null, status: number|null, recoverableByShrinking: boolean }}
 */
export function describeUpstreamError(/** @type {any} */ err, opts = {}) {
  const raw = String(err?.message ?? err ?? '').trim();
  const status = Number(err?.status) > 0 ? Number(err.status) : null;
  const t = raw.toLowerCase();
  const memoryPressure = isMemoryPressureError(err);
  const recoverableByShrinking = Boolean(memoryPressure && opts?.isLocal === true);
  const learnedSafe = Math.floor(Number(opts?.learned?.safeContextBudget) || 0);
  const learnedHint =
    learnedSafe > 0
      ? `该端点的内存安全预算已记为 ${fmtTok(learnedSafe)}（来自 ${fmtLearnedDate(opts?.learned?.learnedAt)} 的失败学习），下轮起手自动使用。`
      : '';
  /** @type {string|null} */
  let hint = null;
  if (/jinja|template|no user query|parser for this template/.test(t)) {
    hint =
      '上游拒绝的是**它的 prompt 模板**（不是网络问题）：该端点的模板不接受当前 messages 形态（典型：按单轮 query 设计的 chatflow/模板，收到的是 OpenAI 多轮 messages）。' +
      '这类端点通常也**不返回 tool_calls**——请改用支持 function calling 的模型/端点，或让网关把 messages 映射成它要的单轮入参。';
  } else if (/engine shed its caches and stays up|allocator wall/.test(t)) {
    // v0.6.15（§3.59 第 2 条）：**引擎活着但丢了缓存**——与"引擎崩了/连接被拒"是两件事。
    // 真机原文（8081）：`insufficient memory: … aborted before the allocator wall.
    // The engine shed its caches and stays up; this request failed.` 引擎自己丢了 KV cache
    // 并继续服务，**没有崩溃**；此时建议"重启引擎"是错的（重启只会把模型重新加载一遍）。
    hint =
      '本地引擎**内存/显存不足**，但它**未崩溃**（原文：engine shed its caches and stays up——引擎自己丢弃缓存后仍在运行）。' +
      '**不要重启引擎**（重启不会增加显存，反而要重新加载模型）。处置：压缩上下文（减小 config.contextBudget 或 /compact）、' +
      '减少并发子任务/并行会话（同一本地端点已按 config.localConcurrency 串行化），然后可直接重试——引擎通常会自行恢复。' +
      learnedHint;
  } else if (/memory_refusal|insufficient memory|gib|内存不足|内存拒绝/.test(t)) {
    hint =
      '本地引擎**内存/显存不足**（在 prefill 前就拒绝了）。处置：压缩上下文（减小 config.contextBudget 或 /compact）、减少并发子任务，或重启模型服务释放内存后重试。' +
      learnedHint;
  } else if (/首 token 等待超限|流式响应空闲超限|请求总时长超限/.test(raw)) {
    hint =
      '这是**内核自己的超时**（不是上游报错）：端点连上了但迟迟不产出。本地大模型长上下文 prefill 很慢——可调大 config.timeout.firstTokenMs/streamIdleMs/totalMs，' +
      '或把任务拆小（新建会话、只给必要文件）；本地端点还有一种情形是引擎 prefill 停滞（内存吃紧），此时调大超时只会让失败更晚被发现。';
  } else if (status === 401 || status === 403 || /unauthorized|invalid.*api.?key|鉴权|密钥/.test(t)) {
    hint = '鉴权失败：请检查该服务商的 API Key（WebUI ⚙ 设置 →「模型与 API Key」，或 mingdao key set）。';
  } else if (status === 404) {
    hint = '端点不存在：请确认 baseUrl 指向 OpenAI 兼容入口（通常以 /v1 结尾），且模型名是端点认识的。';
  } else if (status === 429) {
    hint = '上游限流（429）：稍后重试，或降低并发/换端点。';
  } else if (status !== null && status >= 500 && status <= 504) {
    hint = '上游 5xx：内核已按瞬态错误自动重试过；若原文是确定性错误（模板/参数类），重试不会改变结果，请直接修端点配置。';
  }
  // 上游原文可能很长（内核只保留前 400 字）：如实标注它被截断过，避免用户以为这就是全部
  const truncated = /…|\.\.\.$/.test(raw) || raw.length >= 380;
  return { message: raw, hint: hint ? `💡 ${hint}${truncated ? '（上面的上游原文可能被截断）' : ''}` : null, status, recoverableByShrinking };
}

/**
 * 进度行（纯函数）：web-server.log 与界面状态条**共用同一份文案**，口径不会漂移。
 * @param {{ phase?: string, elapsedMs: number, modelRounds?: number, toolCalls?: number,
 *           toolExecuted?: number, contentChars?: number, ttftMs?: number|null,
 *           pendingTool?: { name: string, ms: number }|null, tokensPerSec?: number|null,
 *           subagent?: { label?: string, modelRounds?: number, toolCalls?: number, at?: number }|null,
 *           localQueue?: { active?: number, queued?: number, limit?: number }|null }} p
 */
export function formatTurnProgress({ phase, elapsedMs, modelRounds = 0, toolCalls = 0, toolExecuted = 0, contentChars = 0, ttftMs = null, pendingTool = null, tokensPerSec = null, subagent = null, localQueue = null }) {
  const s = Math.max(0, Math.round(Number(elapsedMs) / 1000));
  const parts = [
    `已跑 ${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`,
    `阶段=${phase || '未知'}`,
    `模型轮次=${modelRounds}`,
    `工具调用=${toolCalls}${toolCalls === 0 ? '（0 次工具调用）' : `（已执行完 ${toolExecuted}）`}`,
  ];
  if (ttftMs != null) parts.push(`首帧=${(Number(ttftMs) / 1000).toFixed(1)}s`);
  if (tokensPerSec != null) parts.push(`≈${Number(tokensPerSec).toFixed(1)} tok/s`);
  parts.push(`已收正文=${contentChars} 字`);
  if (pendingTool) parts.push(`正在等待工具 ${pendingTool.name}（已 ${Math.round(Number(pendingTool.ms) / 1000)}s）`);
  // v0.6.15（§3.59）：本地端点因内存压力串行化时，进度行必须能看出来——
  // 否则"在排队"与"引擎卡住"在事后日志里完全同形（真机取证最缺的就是这一行）。
  if (localQueue) {
    parts.push(
      `本地端点已串行化（防内存压力）：等待 ${Math.max(0, Number(localQueue.active) || 0)} 个在途请求` +
        (Number(localQueue.queued) > 0 ? `、${Number(localQueue.queued)} 个排队` : '') +
        `，并发上限 ${Number(localQueue.limit) || 1}`
    );
  }
  // v0.6.13（问题 3）：等 `task` 子代理时必须能看出"这个子任务跑到哪一步"——
  // 否则"等子代理 620s"与"卡死 620s"在日志上完全同形（真机现场正是如此）。
  if (subagent) {
    const label = String(subagent.label || '').trim();
    const ago = Number(subagent.at) > 0 ? Math.max(0, Math.round((Date.now() - Number(subagent.at)) / 1000)) : null;
    parts.push(
      `子代理${label ? `「${label}」` : ''}已跑 ${Number(subagent.modelRounds) || 0} 轮 / ${Number(subagent.toolCalls) || 0} 次工具调用` +
        (ago != null ? `，最后进展 ${ago}s 前` : '')
    );
  }
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// 写意图 / 疑问句 / 未达成意图的判定（v0.6.3）
//
// 这几个判定决定「本回合暴露哪些工具」，因此**放到模块级并导出**：判定错一次，
// 用户看到的就是"模型说做不到"而完全不知道原因（下游 Deyi-TCM 随访的「回访」正是如此）。
// ---------------------------------------------------------------------------
const WRITE_INTENT_RE = /写|建|创|改|修|删|装|加|添|增|补|换|移|部署|执行|运行|实现|重构|生成|迁移|安装|更新|升级|发布|调整|优化|修复|提交|推送|打包|编译|测试|implement|fix|create|modify|update|delete|deploy|build|make|generate|install|write|refactor|migrate|test|run|commit|push|remove|add|change|patch/i;
// v0.7.0 §1.5：随只读档判定一起搬来。agent.js 的 runTurn 自愈分支要复判写意图，故导出。
export const hasWriteIntent = (/** @type {any} */ text) => WRITE_INTENT_RE.test(String(text || ''));
// v0.6.3（下游 Deyi-TCM 随访实测的上游缺口）：只读档的**判定方向必须反过来**。
//
// 原逻辑：命中写意图关键词 → 给全量工具；否则整回合只读（write/edit/bash 对模型**不可见**）。
// 但域内任务用的是**域内动词/名词**——「回访」「排班」「盘点」「对账」「随访」「归档」……
// 这是**开集**，永远枚举不完。下游实测：「请生成回访看板」命中"生成"→✅ 能用；
// 而「回访」不命中任何关键词 → 只读档 → 工具不可见 → ❌ 高频入口直接废掉。
//
// 现在改为：**只有"看起来是纯提问、且不含写意图"才进只读档**，其余一律给全量工具。
// 省 token 的初衷不变（真正的问答仍然是只读档），但默认从"任务态"出发——
// 少省一点 token 远好过"任务做不了且用户看不出原因"。
const QUESTION_RE = /[?？]|什么|怎么|怎样|如何|为何|为什么|是否|能否|可否|多少|几个|哪些|哪个|哪里|哪个|谁|何时|吗$|吗[。！!]|呢[。！!]?$/i;
const QUESTION_RE_EN = /\b(what|how|why|is|are|does|do|can|could|should|when|where|which|who)\b/i;
const looksLikeQuestion = (/** @type {any} */ text) => {
  const t = String(text || '').trim();
  if (!t) return false;
  return QUESTION_RE.test(t) || QUESTION_RE_EN.test(t);
};
// 自愈信号：只读档下模型"想做但做不了 / 要用户来做"时的典型措辞（中英）。
const UNMET_INTENT_RE = /无法|不能|没法|做不到|没有权限|未提供|需要你|需要先|请先|建议你|请确认|请提供|如需|无法直接|不能直接|请告知|需要我|我可以帮你|unable to|can'?t|cannot|need you|need to know|please confirm|please provide/i;
export const looksLikeUnmetIntent = (/** @type {any} */ text) => UNMET_INTENT_RE.test(String(text || ''));

/**
 * 本回合是否从「只读档」起步。
 *
 * **判定方向是故意反的**：原实现要命中写意图关键词才给全量工具，而域内任务用的是
 * **开集**动词/名词——「回访」「排班」「盘点」「对账」……永远枚举不完。下游实测：
 * 「请生成回访看板」命中"生成"→能用；「回访」不命中→只读档→write/edit/bash 不可见→废掉。
 * 现在只有"看起来是纯提问且不含写意图"才进只读档（真正的问答照样省 token），其余一律全量。
 *
 * 另外两条防线（都写在这里，保证判定只有一处）：
 *   · **域内 Pack 在场时不进只读档**：这类部署的价值在"任务能做"，不在省 schema token；
 *   · 只读档若以纯文本收尾且透出"做不到/需要…"，`runTurn` 会**自愈**放开一次（与词表无关）。
 *
 * @param {any} cfg @param {any} lastUserText @param {boolean} packActive
 * @returns {boolean}
 */
export function startsInReadOnlyPhase(cfg, lastUserText, packActive) {
  if (cfg?.schemaTier === false) return false;
  if (packActive) return false;
  const t = lastUserText;
  return !hasWriteIntent(t) && looksLikeQuestion(t);
}
