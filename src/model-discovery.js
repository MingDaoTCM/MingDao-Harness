// 模型动态发现：设置 API Key 后从服务商 /models 接口拉取真实可用模型，
// 模型名称以线上为准（不硬编码），预设仅作为无网络时的回退与价格/参数的补充。
//  - 缓存 <home>/model-cache.json，TTL 1 小时，避免每次打开都请求
//  - availableModels：只列出已设置 Key 的服务商（凭证库或环境变量），
//    动态名单优先，预设名单回退；自定义模型（config.customModels）恒列出
//  - 未收录预设的线上模型走通用默认（Agent 有兜底参数），计价显示 n/a

import fs from 'node:fs';
import { safeFetchText } from './safe-fetch.js';
import path from 'node:path';
import { mingdaoHome, ensureHome } from './config.js';
import { PROVIDERS, MODELS } from './models.js';
import { getStoredKey } from './credentials.js';
import { isLocalBaseUrl, resolveModelCaps } from './model-caps.js';
import { resolveProviderConfig } from './providers/index.js';

const TTL_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// v0.6.13（A/B）：自定义端点的**来源标注**（B）与**能力/延迟预检**（A 追加）
//
// B（负责人实测：模型下拉里出现下游环境的东西，看不出是不是官方模型）：
//   下拉数据来源核实（本函数即唯一来源）：GET /api/state → availableModels() →
//     · 内置服务商：PROVIDERS 名单 + 该服务商 /models 的线上名单（缓存在 model-cache.json，TTL 1h）；
//     · 自定义：**只来自 config.customModels** —— fetchProviderModels 显式跳过 'custom'，
//       自定义端点的 /models 从不写进 model-cache.json，因此**不存在跨环境运行时串数据**。
//   也就是说：下拉里那些条目是"配置驱动"的（谁往 config.customModels 里写了什么，就列什么），
//   但此前它们只标了 providerLabel='自定义'、**看不出来自哪个端点**，于是容易被当成官方模型。
//   现在每条自定义条目都带 source/sourceLabel/endpoint，并把 providerLabel 直接写成
//   「自定义端点 · host」——下拉按 providerLabel 分组，分组名本身就是来源。
//
// A（负责人本机 35B 卡住 4 小时、日志零行）：光有超时不够，"这个端点到底行不行"必须在
//   长任务开始前几秒内就有答案。probeEndpoint() 打一次**极小**请求（1 条 user + 1 个工具声明 +
//   max_tokens 16，流式取首帧），给出三态判定 + 实测 TTFT + 引擎实际加载的模型名。
// ---------------------------------------------------------------------------

/** 预检结果缓存 TTL（10 分钟）：端点能力/延迟变化不快，但也不能一辈子不重测。 */
export const PROBE_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// v0.6.13（探针误报修复）：预检的**超时/重试/退避**与**失败原因分类**
//
// 真机证据（web-server.log:799，2026-10-09T10:13:58.900）：
//   `chat 预检 tf91d8ab0ddfec0bd unreachable ❌ 不可达：fetch failed（本地引擎没起来？先确认端口/进程）`
//   ——同一回合随后完全可用（web-server.log:800 预告、:803 首帧 8.7s、:844 已跑 21m）。用户照这句话
//   去重启了引擎。三种形态都必须**分开判、分开说**（桩服务复现见 test/smoke.js §141）：
//     ① 端口没人监听        → 连接被拒（ECONNREFUSED）：确实是"引擎没起来"
//     ② 只实现 chat 的网关  → 可用（探针只打 POST {base}/chat/completions，**一个 GET 都不多发**）
//     ③ 首帧很慢（prefill/启动中）→ 超时：端口是通的，不能说"引擎没起来"
//     ④ HTTP 404/405        → 端点没实现这条探针请求（探针被拒绝，不是"不可达"）
//
// 三条硬约束（都是真机踩出来的）：
//   · **单次尝试必须短**（1.5s）：本地 35B 的"极小请求"实测 0.2~3.0s，1.5s 足够"活着"的引擎答出来；
//     此前单次 15s、最坏 3 次 + 参考 prefill ≈ 35s，而它在**回合发起之前**被 await（server.js:840），
//     等于把回合发起拖住（更糟：被 abort 的请求还占着引擎 slot）。
//   · **超时必须覆盖到"首帧"**：此前 `once()` 在响应头到达时就 clearTimeout，而探针是 stream:true ——
//     引擎"回了头、卡在 prefill"时探针**没有任何超时**（实测 ③b：给了 1.5s 超时，6s 后仍在跑），
//     把回合发起无限期拖住。现在计时一直盖到首帧/响应结束。
//   · **必须退避重试**：此前 3 次尝试背靠背，全部在同一个瞬间撞上"端口还没 bind"的引擎
//     （实测 ④：端口 800ms 后才监听 → 1ms 内连撞 3 次 → 判"不可达"）。退避 300/700ms 后同一现场能测通。
// ---------------------------------------------------------------------------

/** 单次探针请求的超时（秒级：短，避免与首帧抢资源）。 */
export const PROBE_ATTEMPT_MS = 1500;
/** 工具探针的样本数（N/3 三态：稳定/不稳定/不支持——这是既有判据，不得为了"更快"减样本）。 */
export const PROBE_ATTEMPTS = 3;
/** 尝试之间的退避（第 i 次失败后用 BACKOFF[i-1]，最后一项复用）：给"正在启动"的引擎留出 bind 时间。 */
export const PROBE_BACKOFF_MS = [300, 700];
/** 参考 prefill 的单独超时：本地 35B 实测 6.6~7.8s/2000 tokens，用 1.5s 会永远测不到
 *  （§140 的"预告由预检实测推导"就会失去依据）。它只有成功连通后才发一次。 */
const PREFILL_ATTEMPT_MS = 20000;
/** **失败**结论的保鲜期：失败可能是"引擎正在启动"的瞬时态，绝不能长期复用。 */
export const PROBE_FAIL_TTL_MS = 60 * 1000;

/** 这条预检结论是不是"失败结论"（纯函数）：失败结论不得长期缓存/备忘（见 PROBE_FAIL_TTL_MS）。
 *  **只**把"没打通/没结论"算失败；`ok-textonly`、`unstable-tools` 是**结论**（端点答了，只是不/不稳定
 *  支持工具调用），按完整 TTL 缓存——否则每个回合都要再往慢引擎上打 4 个探针请求，正好是反效果。
 *  @param {any} v */
export function probeVerdictFailed(/** @type {any} */ v) {
  if (!v) return true; // 压根没拿到结论（抛错/无端点）——同样不能长期当"可用"
  return v.state === 'unreachable';
}

/** 服务端"进程内预检备忘"是否还能用（纯函数，便于断言/变异）。
 *
 *  真机误报的**主因**就在这里：v0.6.13 的备忘**没有任何 TTL**——
 *  进程启动时引擎还没起来，留下一条 `❌ 不可达：fetch failed（本地引擎没起来？…）`，
 *  之后**每一个新回合**都把它原样重放（web-server.log:413 07:03:02 的真实探测 → :416 07:08:13、
 *  :799 10:13:58 两次重放，间隔 7 小时 10 分钟），而同一回合其实完全可用（首帧 8.7s）。
 *  所以：成功结论按 PROBE_TTL_MS 复用，**失败结论只按 PROBE_FAIL_TTL_MS（60s）**复用。
 *  @param {{ at?: number, value?: any }|null} memo @param {number} [now] */
export function probeMemoUsable(/** @type {any} */ memo, /** @type {number} */ now = Date.now()) {
  if (!memo || !Number.isFinite(Number(memo.at))) return false;
  const ttl = probeVerdictFailed(memo.value) ? PROBE_FAIL_TTL_MS : PROBE_TTL_MS;
  return now - Number(memo.at) < ttl;
}

/** 探针失败的分类（纯函数，便于断言/变异）——**不许**把超时、拒连、HTTP 4xx 混成一句"fetch failed"。
 * @param {any} err
 * @returns {{ kind: 'refused'|'reset'|'timeout'|'other', detail: string, label: string, hint: string }}
 */
export function classifyProbeError(/** @type {any} */ err) {
  const code = String(err?.cause?.code || err?.code || '');
  const msg = String(err?.message || err || '');
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/i.test(msg)) {
    return { kind: 'refused', detail: 'ECONNREFUSED', label: '连接被拒（端口没人监听）', hint: '本地引擎没起来/端口不对：先确认端口与进程。' };
  }
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || /socket hang up|other side closed|terminated/i.test(msg)) {
    return { kind: 'reset', detail: code || msg.slice(0, 80), label: '连接被对端断开', hint: '引擎可能刚崩/正在重启（连接是通的，只是被断开）。' };
  }
  if (err?.probeTimeout === true || err?.name === 'AbortError' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT' || /超时|timed?\s?out|aborted/i.test(msg)) {
    return { kind: 'timeout', detail: code || 'timeout', label: '超时', hint: '端口是通的，但没在探针上限内等到首帧：引擎在 prefill，或**正在启动**——不代表主请求会失败。' };
  }
  return { kind: 'other', detail: code || msg.slice(0, 120) || '未知错误', label: '其它错误', hint: '不是"引擎没起来"的形态，按这个错误码排查（探针只打 POST {base}/chat/completions）。' };
}

/** 探针拿到 HTTP 响应但不是 2xx 时的分类（纯函数）。 */
export function classifyProbeHttp(/** @type {any} */ status) {
  const s = Number(status) || 0;
  if (s === 404 || s === 405 || s === 501) {
    return { kind: 'http-unimplemented', detail: `HTTP ${s}`, label: `HTTP ${s}（端点未实现该探针请求）`, hint: `该端点没有实现 POST {base}/chat/completions（探针打的与主请求是同一个 URL）。` };
  }
  if (s === 401 || s === 403) {
    return { kind: 'http-auth', detail: `HTTP ${s}`, label: `HTTP ${s}（鉴权被拒）`, hint: '端口与端点都在，是 API Key/鉴权的问题（检查 ⚙ 设置里的密钥）。' };
  }
  return { kind: 'http', detail: `HTTP ${s || '（无响应）'}`, label: `HTTP ${s || '（无响应）'}（探针请求被拒绝）`, hint: '端口是通的，但这条请求被端点拒绝：按返回值排查。' };
}

/** 失败结论的**一行文案**（纯函数）：判据（kind）先定，文案跟着判据走。
 *  既要说清"是什么"，也要说清"下一步怎么办"，并且**永远**写明"预检失败不阻断本回合"。
 * @param {{ kind: string, detail?: string, label?: string, hint?: string }} failure
 * @param {{ attemptMs?: number, tries?: number }} [ctx]
 */
export function probeFailureNote(/** @type {any} */ failure, /** @type {any} */ ctx = {}) {
  const kind = String(failure?.kind || 'other');
  const detail = failure?.detail ? `（${failure.detail}）` : '';
  const label = failure?.label || kind;
  const hint = failure?.hint || '按上面的原因排查。';
  const attemptSec = Number(ctx.attemptMs) > 0 ? (Number(ctx.attemptMs) / 1000).toFixed(1) : '1.5';
  const tries = Number(ctx.tries) > 0 ? Number(ctx.tries) : PROBE_ATTEMPTS;
  // 前缀本身就要分开：只有"连接被拒/被断开"才配说"不可达"；超时是"端口通、没等到首帧"，
  // HTTP 4xx 是"端点拒绝了这条探针请求"——三者混为一谈正是真机误报的文案根源。
  const head =
    kind === 'refused' ? `❌ 不可达：${label}${detail}` :
    kind === 'reset' ? `❌ 连接被断开：${label}${detail}` :
    kind === 'timeout' ? `⏱ 探针超时：${attemptSec}s 内没有首帧${detail ? `（${failure.detail}）` : ''}` :
    kind.startsWith('http') ? `❌ 探针被拒绝：${label}${detail ? '' : ''}` :
    `❌ 探针失败：${label}${detail}`;
  return `${head}——${hint}（探针：${tries} 次尝试 × ${attemptSec}s、含退避；**预检是尽力而为，失败只降级、不阻断本回合**）`;
}
/** 无进展看门狗的自适应下限/上限（见 adaptiveTimeouts）。
 *  上限与 agent.js 的 DEFAULT_NO_PROGRESS_TIMEOUT_MS 相同——由冒烟断言钉住两者一致（单源守卫）。 */
export const PROGRESS_MIN_MS = 600000;
export const PROGRESS_MAX_MS = 3600000;

/**
 * 从 baseUrl 取一个给人看的端点标识（host + 路径前缀）。
 * @param {any} baseUrl
 */
export function endpointLabel(/** @type {any} */ baseUrl) {
  try {
    const u = new URL(String(baseUrl || ''));
    if (!u.hostname) return '';
    const p = u.pathname && u.pathname !== '/' ? u.pathname.replace(/\/+$/, '') : '';
    return `${u.host}${p}`;
  } catch {
    return '';
  }
}

/**
 * 自定义条目的来源描述（纯函数，**B 的核心**）。
 * 判据走 resolveProviderConfig（`custom:<名>` = 声明了传输字段的端点；否则只是能力覆盖）——
 * 不在本文件再抄一份"哪些字段算端点声明"的键表（那正是本项目反复栽过的"同一规则多份实现"）。
 * @param {any} cfg @param {string} cmName
 * @returns {{ source: 'custom-endpoint'|'custom-capability', sourceLabel: string, endpoint: string,
 *            providerLabel: string, isLocalEndpoint: boolean, note: string }}
 */
export function customSourceOf(/** @type {any} */ cfg, /** @type {string} */ cmName) {
  const cm = (cfg?.customModels || {})[cmName] || {};
  let pc = /** @type {any} */ (null);
  try {
    pc = resolveProviderConfig(cfg, cmName);
  } catch {}
  const endpoint = endpointLabel(pc?.baseUrl || cm.baseUrl || '');
  // `custom:<名>` 是 providers/index.js 对"声明式端点"的命名；`custom:`/`custom/` 前缀的名字同理。
  const isEndpoint = Boolean(pc && /^custom[:/]/.test(String(pc.name || ''))) || /^custom[:/]/i.test(String(cmName));
  const local = isLocalBaseUrl(pc?.baseUrl || cm.baseUrl || '');
  if (isEndpoint) {
    const where = endpoint || '（未写明 baseUrl）';
    const sourceLabel = `自定义端点 · ${where}`;
    return {
      source: 'custom-endpoint',
      sourceLabel,
      endpoint,
      providerLabel: sourceLabel,
      isLocalEndpoint: local,
      note: `该条目来自 config.customModels，是**你自己配置的端点**（${where}）${local ? '（本机/内网地址）' : ''}——不是内置官方模型，也不随内核发版变化。`,
    };
  }
  const via = String(cm.provider || pc?.name || '').trim();
  const sourceLabel = `自定义（能力覆盖${via ? ` · 沿用 ${via} 端点` : ''}）`;
  return {
    source: 'custom-capability',
    sourceLabel,
    endpoint,
    providerLabel: sourceLabel,
    isLocalEndpoint: local,
    note:
      `该条目只声明能力（contextWindow/maxOutputTokens/vision 等），**不改变请求去向**` +
      `${via ? `——请求仍走 ${via}` : ''}；它来自 config.customModels，不是内置官方模型。`,
  };
}

/** @type {Map<string, {at: number, value: any}>} */
const probeCache = new Map();
/** @type {Map<string, Promise<any>>} */
const probeInflight = new Map();

/** 引擎加载的模型名与配置项名是否"对不上"（纯函数，便于断言）。
 *  归一化：小写 + 取 basename + 去掉 .gguf 后缀；一边包含另一边即视为同一个（引擎常带路径/量化后缀）。 */
export function modelNameMismatch(/** @type {any} */ configured, /** @type {any} */ loaded) {
  const norm = (/** @type {any} */ s) =>
    String(s || '')
      .trim()
      .toLowerCase()
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.gguf$/i, '')
      .replace(/[^a-z0-9._-]+/g, '');
  const c = norm(configured);
  const list = /** @type {string[]} */ ((Array.isArray(loaded) ? loaded : [loaded]).map(norm).filter(Boolean));
  if (!c || !list.length) return false; // 无从比较时不误报
  return !list.some((/** @type {string} */ l) => l.includes(c) || c.includes(l));
}

/**
 * 端点能力/延迟预检（三态：ok-tools / ok-textonly / unreachable）。
 * 结果按「端点 + 模型名」缓存 10 分钟，并发去重。
 * @param {any} cfg @param {string} modelName
 * @param {{ timeoutMs?: number, force?: boolean, fetchImpl?: any, credentialProbe?: boolean }} [opts]
 */
/**
 * 端点能力/延迟预检（A 追加；三态 × 三样本，**不允许一次结果当结论**）。
 *
 * 设计依据（负责人本机三端点实测）：
 *   · 60091 MLocalModel3.6.2（llama.cpp 35B Q4_K_M）：同一请求同一端点两次结果相反——
 *     第一次 2.7s 且 tool_calls=有，第二次 23.9s 且 tool_calls=无；引擎回的 model 是**完整文件路径**
 *     （/Users/…/mLocalModel3.6.2.gguf），与配置项名 MLocalModel3.6.2 不一致。
 *     → 所以：① 工具调用必须重复 N 次取"稳定/不稳定/不支持"三态，不能一次定论；
 *            ② TTFT 必须落账（2.7s→23.9s 这种跳变就是"引擎被占住/排队"的信号）；
 *            ③ 配置名与引擎名不一致要写出来（避免"配的是 A、跑的是 B"）。
 *   · 8081 mtplx-qwen38-27b-optimized-quality：小请求 2.9s、**不返回 tool_calls**；2009 tokens 长提示 5.5s。
 *   · 长提示实测 1.8-5.5s（2009 tokens）——"35B prefill 要几小时"**不成立**：慢/卡不是模型体量的问题，
 *     更像引擎 slot 被占/排队或请求形态让引擎进了异常态；因此预检除了 TTFT，还要测一次**参考 prefill**
 *     （固定 ~2000 tokens），并与**本机历史值**比对，显著变慢就提示"可能仍有旧请求占着，建议重启引擎"。
 *
 * 返回（关键字段）：
 *   state        'ok-tools' | 'unstable-tools' | 'ok-textonly' | 'unreachable'（粗三态，兼容旧调用）
 *   reason       失败原因（v0.6.13 修复新增）：'refused'（连接被拒）/ 'reset'（被断开）/
 *                'timeout'（超时）/ 'inconclusive'（样本不可判定）/ 'http-404' 等 / null（可用）
 *   toolState    'stable-tools' | 'unstable-tools' | 'no-tools' | 'unknown'（细三态，N/3）
 *   toolCallHits / toolCallRuns        命中次数 / 实际样本数
 *   ttftMs       三次小请求的首帧中位数（ms）
 *   prefillMs    参考 prefill（prefillTokens 个 token）的耗时（ms）
 *   baseline / slowdown                历史基线（持久化在 <home>/model-probe.json）与本次倍数
 *   nameMismatch / loadedModel         引擎实际加载的模型名与配置项名是否对不上
 *   note         一行给人看的结论（UI + web-server.log 直接用）——**文案跟着 reason 走**，
 *                不得把超时/HTTP 4xx/拒连一律写成"本地引擎没起来"
 *
 * 语义（v0.6.13 修复）：
 *   · `timeoutMs` 是**整个探针的时间预算**（默认 10s；server.js 传 15000），**不是**单次尝试超时；
 *     单次尝试超时 = `attemptMs`（默认 PROBE_ATTEMPT_MS = 1.5s），并且**覆盖到首帧**（不只是响应头）。
 *   · `repeats` 默认 3（工具调用三态需要 N/3，不得减）；尝试之间有退避（PROBE_BACKOFF_MS）。
 *   · 探针是**尽力而为**：任何失败都只降级为"没有预检数据"，绝不影响主请求/回合发起。
 *
 * @param {any} cfg @param {string} modelName
 * @param {{ timeoutMs?: number, force?: boolean, fetchImpl?: any, repeats?: number, attemptMs?: number,
 *           prefillTokens?: number, budgetMs?: number, persist?: boolean }} [opts]
 */
export async function probeEndpoint(/** @type {any} */ cfg, /** @type {string} */ modelName, opts = {}) {
  const {
    timeoutMs = 10000,
    force = false,
    fetchImpl = null,
    repeats = PROBE_ATTEMPTS,
    attemptMs = PROBE_ATTEMPT_MS,
    prefillTokens = 2000,
    budgetMs = 35000,
    persist = true,
  } = opts;
  const pc = /** @type {any} */ (resolveProviderConfig(cfg, modelName) || {});
  const base = String(pc.baseUrl || '').replace(/\/+$/, '');
  const key = `${base}|${modelName}`;
  const hit = probeCache.get(key);
  // v0.6.13 修复：**失败**结论的保鲜期只有 60s——失败可能是"引擎正在启动"的瞬时态，
  // 用 10 分钟 TTL 复用会把"当时打不通"当成"现在也不行"（真机 07:03 的失败结论被 10:13 的
  // 新回合原样重放，见 web-server.log:413 → :799）。成功结论仍按 10 分钟。
  if (!force && hit && Date.now() - hit.at < (probeVerdictFailed(hit.value) ? PROBE_FAIL_TTL_MS : PROBE_TTL_MS)) return hit.value;
  if (!force && probeInflight.has(key)) return probeInflight.get(key);
  const doFetch = fetchImpl || globalThis.fetch;
  const run = (async () => {
    const startedAt = Date.now();
    // v0.6.13 修复：`timeoutMs` 是**整个探针的时间预算**（不是单次尝试的超时——此前语义正是单次，
    // 于是"3 次 × 15s + prefill"最坏 35s 都堆在回合发起之前）。单次尝试用 attemptMs（1.5s）。
    const budget = Math.min(Number(timeoutMs) > 0 ? Number(timeoutMs) : 10000, Number(budgetMs) > 0 ? Number(budgetMs) : Infinity);
    const deadline = startedAt + budget;
    const left = () => Math.max(0, deadline - Date.now());
    const info = /** @type {any} */ ({
      at: Date.now(),
      endpoint: endpointLabel(base),
      isLocal: isLocalBaseUrl(base),
      provider: String(pc.name || ''),
      configuredModel: modelName,
      loadedModels: [],
      loadedModel: null,
      nameMismatch: false,
      ttftSamples: [],
      ttftMs: null,
      prefillTokens,
      prefillMs: null,
      toolCallHits: 0,
      toolCallRuns: 0,
      toolCallInconclusive: 0,
      toolCallFinishes: [],
      toolState: 'unknown',
      ttftBaselineMs: null,
      prefillBaselineMs: null,
      slowdown: null,
      // v0.6.13（问题 2）：引擎自述上下文（本地端点读 GET /props）——读不到就是 null，**不猜**
      engineCtx: null,
      engineCtxSource: null,
      engineProbed: false,
      configuredWindow: (() => {
        try {
          return resolveModelCaps(cfg, modelName).contextWindow;
        } catch {
          return null;
        }
      })(),
      state: /** @type {string} */ ('unreachable'),
      // v0.6.13 修复：失败**原因**（判据）与文案分开记——日志/界面都能看出"是哪一种失败"
      reason: /** @type {string|null} */ (null),
      attemptMs,
      error: /** @type {string|null} */ (null),
      note: '',
      partial: false,
    });
    if (!base) {
      return { ...info, reason: 'no-base-url', error: '该模型没有可用的 baseUrl（未配置端点）', note: '端点未配置：请先在 ⚙ 设置里填 baseUrl/API Key。' };
    }
    const headers = { 'Content-Type': 'application/json', ...(pc.apiKey ? { Authorization: `Bearer ${pc.apiKey}` } : {}) };
    /**
     * 单次 HTTP：返回 `{ res, cleanup, timeoutErr }`——**计时不在这里清**，由调用方"读完首帧"之后清。
     * 为什么（v0.6.13 修复）：探针是 `stream: true`，`fetch` 在**响应头**到达时就 resolve；此前
     * clearTimeout 就在那时执行，于是"引擎回了头、卡在 prefill"这种情况**没有任何超时**
     * （桩复现：给 1.5s 超时，6s 后探针仍在跑），而它在回合发起之前被 await —— 把回合发起拖死。
     */
    const open = async (/** @type {any} */ url, /** @type {any} */ init, /** @type {any} */ ms) => {
      const ac = new AbortController();
      const terr = /** @type {any} */ (new Error(`预检超时（${(ms / 1000).toFixed(1)}s）`));
      terr.probeTimeout = true;
      terr.probeTimeoutMs = ms;
      const t = setTimeout(() => ac.abort(terr), ms);
      const cleanup = () => clearTimeout(t);
      try {
        const res = await fetchImplOr(doFetch, url, { ...init, signal: ac.signal });
        return { res, cleanup, timeoutErr: terr };
      } catch (e) {
        cleanup(); // 失败路径立刻清计时器（成功路径由调用方读完后清）
        throw e;
      }
    };
    // ① 引擎"实际加载的是什么"——**从 chat 响应的 `model` 字段读**，不额外打 `GET /models`。
    // 为什么不打 /models（v0.6.13 实测取舍）：
    //   · 有的端点根本没实现它（chatflow 网关常见 404）；
    //   · 更要紧的是"只实现了 chat 的端点"不该因为一次探测请求而报错——预检必须无可侵入；
    //   · 流式响应里就带着引擎真正的模型名：llama.cpp 直接回**完整文件路径**
    //     （/Users/…/mLocalModel3.6.2.gguf，负责人实测），语义与 /models 等价；
    //   · 少一次请求、少一个超时点。
    // 名字对不上（配置项名 ≠ 引擎回的模型名）时把两者都写进结论——避免"配的是 A、跑的是 B"。

    // ② 工具调用探针（重复 N 次取三态）：提示词**明确要求调用工具**，同时看 tool_calls 与 finish_reason
    const probeTool = {
      type: 'function',
      function: {
        name: 'mingdao_probe',
        description: '预检探针：确认该端点是否支持 function calling',
        parameters: { type: 'object', properties: { v: { type: 'integer', description: '任意整数' } }, required: ['v'] },
      },
    };
    const chunkHasTool = (/** @type {string} */ s) => /"tool_calls"\s*:/.test(s);
    /** @type {any[]} 每次尝试的失败（已分类）——用来判"是哪一种失败" */
    const failures = [];
    let connected = false;
    let attemptsMade = 0;
    for (let i = 0; i < Math.max(1, repeats); i++) {
      // 退避：引擎"正在启动"（端口还没 bind）时立刻重试 = 3 次全撞在同一个瞬间 → 误判"不可达"。
      // 桩复现（test/smoke.js §141 ④）：端口 800ms 后才监听，无退避时 1ms 内连撞 3 次判不可达。
      if (i > 0) {
        const backoff = PROBE_BACKOFF_MS[Math.min(i - 1, PROBE_BACKOFF_MS.length - 1)];
        if (left() > backoff) await new Promise((r) => setTimeout(r, backoff));
      }
      const slice = Math.min(attemptMs, left());
      if (slice <= 0) { info.partial = true; break; }
      attemptsMade += 1;
      const t0 = Date.now();
      let opened = /** @type {any} */ (null);
      try {
        opened = await open(
          `${base}/chat/completions`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              model: modelName,
              // 提示词必须**明确要求工具**：否则"模型恰好直接回答"会被误判成不支持工具调用
              messages: [{ role: 'user', content: `请调用 mingdao_probe 工具，参数 v=${i + 1}。只调用工具，不要输出任何解释文字。` }],
              tools: [probeTool],
              tool_choice: 'auto',
              // 256 而不是 16：思考型模型（本机 MLocalModel3.6.2 就是）会先输出思考内容，
              // 16 个 token 必然被 finish_reason=length 截断 —— 那样探针会把"没测出来"误报成"不支持工具调用"。
              max_tokens: 256,
              stream: true,
            }),
          },
          slice
        );
        connected = true;
        const res = opened.res;
        if (!res || !res.ok) {
          const f = classifyProbeHttp(Number(res?.status) || 0);
          failures.push(f);
          let detail = '';
          try { detail = String(await res.text()).slice(0, 300); } catch {}
          info.error = `${f.detail}${detail ? `：${detail}` : ''}`;
          info.toolCallFinishes.push(`http-${Number(res?.status) || 0}`);
          continue;
        }
        const r = await readProbeStream(res, { hasTool: chunkHasTool, t0, timeoutErr: opened.timeoutErr });
        if (r.model && !info.loadedModel) {
          info.loadedModel = String(r.model);
          info.loadedModels = [String(r.model)];
          info.nameMismatch = modelNameMismatch(modelName, [String(r.model)]);
        }
        if (r.ttftMs != null) info.ttftSamples.push(r.ttftMs);
        const finish = String(r.finish || (r.toolCalls ? 'tool_calls' : 'stop'));
        info.toolCallFinishes.push(finish);
        // 样本必须**有结论**才算数：`length`（被 max_tokens 截断，思考型模型常见）既不是命中也不是未命中
        const conclusive = r.toolCalls || finish === 'tool_calls' || finish === 'stop';
        if (conclusive) {
          info.toolCallRuns += 1;
          if (r.toolCalls || finish === 'tool_calls') info.toolCallHits += 1;
        } else {
          info.toolCallInconclusive = (info.toolCallInconclusive || 0) + 1;
        }
      } catch (/** @type {any} */ e) {
        const f = classifyProbeError(e);
        failures.push(f);
        // "超时上限"必须写**实际**等的时间（此前在 catch 里用当时的 left() 反推，会印出错的秒数）
        info.error = f.kind === 'timeout' ? `预检超时（${(slice / 1000).toFixed(1)}s 内没有${connected ? '首帧' : '任何响应'}）` : `${f.label}（${f.detail}）`;
        info.toolCallFinishes.push(f.kind === 'timeout' ? 'timeout' : 'error');
      } finally {
        // 计时器等"读完首帧"再清；失败路径 open() 已清（重复 clear 无害）
        try { opened?.cleanup?.(); } catch {}
      }
    }
    /** 多数票：同因 ≥2 次取它，否则取最后一次；混合失败也如实写进 error */
    const tally = () => {
      const by = new Map();
      for (const f of failures) by.set(f.kind, (by.get(f.kind) || 0) + 1);
      let best = /** @type {any} */ (failures[failures.length - 1] || null);
      for (const f of failures) if ((by.get(f.kind) || 0) > (by.get(best.kind) || 0)) best = f;
      return { best, by: Object.fromEntries(by) };
    };
    if (!connected) {
      // v0.6.13 修复：**不connected 不等于"引擎没起来"**——超时（端口通、没等到首帧）、被断开、
      // 未知错误都必须各自成句。判据（reason）与文案都由分类函数给出，这里只负责落账。
      const { best, by } = tally();
      const f = best || classifyProbeError(null);
      const kinds = Object.entries(by);
      info.state = 'unreachable';
      info.reason = f.kind;
      info.error = info.error || `${f.label}（${f.detail}）`;
      // 混合原因（例如"拒连 1 次 + 超时 2 次"）必须如实写出来，否则用户没法判断该做什么
      const mix = kinds.length > 1 ? `（${failures.length} 次尝试的失败构成：${kinds.map(([k, v]) => `${k}×${v}`).join('、')}）` : '';
      info.note = probeFailureNote(f, { attemptMs, tries: failures.length }) + mix;
      return info;
    }
    // ⑤ 引擎自述上下文（v0.6.13 问题 2）：**本地端点**额外读一次 `GET /props`。
    //    · 放在 chat 探测之后、结论拼装之前：chat 通不通与"引擎装得下多少"是两件事；
    //    · 只打一次、只读不改（GET），失败/非 JSON/没有 n_ctx 一律视为"未读到"，绝不编造；
    //    · llama.cpp 的 /props 挂在**根**上（`http://host:port/props`），而 baseUrl 通常带 `/v1`，
    //      所以先试剥掉 `/v\d+` 的根路径，再退回 baseUrl 原样（兼容把 /props 挂在前缀下的网关）。
    //    · **门槛**：只有引擎**自报了模型名**（`info.loadedModel`）才多打这一个请求。理由有两条：
    //      ① llama.cpp 家族（含 llama-cpp-python/koboldcpp/LM Studio）总会在响应里回模型名/文件路径，
    //         回不了名的多半是"只实现了 /v1/chat/completions"的网关或测试桩——它们不认识 /props；
    //      ② 实测教训：`test/e2e-web.js` 的 mock 只按 POST+JSON body 解析（收到空 body 的 GET 会抛
    //         `JSON.parse('')`），多打一个 GET 会把整条 e2e 打断——不认识 /props 的端点**一个字节都不该多发**。
    //      跳过时结论里会写"跳过"（`engineContextNotice` 的 skipReason），不会假装核对过。
    if (info.isLocal && info.loadedModel) {
      info.engineProbed = true;
      const strippedBase = base.replace(/\/v\d+$/, '');
      const propsUrls = strippedBase !== base ? [`${strippedBase}/props`, `${base}/props`] : [`${base}/props`];
      for (const u of propsUrls) {
        try {
          const got = await open(u, { method: 'GET', headers }, Math.min(5000, Math.max(1, left())));
          try {
            if (!got.res || !got.res.ok) continue;
            const raw = String(await got.res.text()).slice(0, 65536);
            const ctx = engineContextFromProps(JSON.parse(raw));
            if (ctx != null) {
              info.engineCtx = ctx;
              info.engineCtxSource = u;
              break;
            }
          } finally {
            got.cleanup();
          }
        } catch {
          /* 读不到就跳过（端点没实现 /props、返回非 JSON、超时）——结论里会如实写"未读到" */
        }
      }
    }
    info.ttftMs = median(info.ttftSamples);
    const n = info.toolCallRuns;
    info.toolState = n === 0 ? 'unknown' : info.toolCallHits === n ? 'stable-tools' : info.toolCallHits === 0 ? 'no-tools' : 'unstable-tools';
    info.state = info.toolState === 'stable-tools' ? 'ok-tools' : info.toolState === 'unstable-tools' ? 'unstable-tools' : info.toolState === 'unknown' ? 'unreachable' : 'ok-textonly';
    // v0.6.13 修复：**连上了、但一个有效样本都没拿到**时必须分清是哪一种——
    //   · 每一次尝试都以失败告终（HTTP 4xx 拒掉 / 首帧超时 / 连接被拒）→ 用**分类后的失败原因**出结论
    //     （404 → "探针被拒绝：HTTP 404（端点未实现该探针请求）"；首帧超时 → "探针超时：1.5s 内没有首帧"），
    //     **不许**再说成"工具调用未能判定（多为被 max_tokens 截断）"，更不许一律说"引擎没起来"；
    //   · 拿到过响应但样本"不可判定"（被 max_tokens 截断等）→ reason=inconclusive，保留既有文案。
    const failedAll = n === 0 && failures.length > 0 && (info.toolCallInconclusive || 0) === 0 && failures.length >= attemptsMade;
    if (failedAll) {
      const { best, by } = tally();
      const f = best || failures[failures.length - 1];
      info.reason = f.kind;
      const kinds = Object.entries(by);
      const mix = kinds.length > 1 ? `（${failures.length} 次尝试：${kinds.map(([k, v]) => `${k}×${v}`).join('、')}）` : '';
      info.note = probeFailureNote(f, { attemptMs, tries: failures.length }) + mix;
      return info;
    }
    if (n === 0) info.reason = 'inconclusive';
    // ③ 参考 prefill：固定 ~2000 tokens 的**每次不同**前缀（防引擎前缀缓存把耗时抹平）
    {
      const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const filler = Array.from({ length: Math.max(8, Math.round(prefillTokens / 4)) }, (_, i) => `第${i}段：${nonce}`).join('；');
      const t0 = Date.now();
      try {
        // 参考 prefill 单独放宽（PREFILL_ATTEMPT_MS）：本地 35B 实测 6.6~7.8s/2000 tokens，
        // 用 1.5s 会永远测不到 → §140 的"预告由预检实测推导"就失去依据。它只在连通后发一次。
        const got = await open(
          `${base}/chat/completions`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              model: modelName,
              messages: [{ role: 'user', content: `${filler}\n以上编号只用于占位，请只回复"ok"。` }],
              max_tokens: 8,
              stream: true,
            }),
          },
          Math.min(PREFILL_ATTEMPT_MS, Math.max(1, left()))
        );
        try {
          if (got.res && got.res.ok) {
            const r = await readProbeStream(got.res, { hasTool: chunkHasTool, t0, timeoutErr: got.timeoutErr });
            if (r.model && !info.loadedModel) {
              info.loadedModel = String(r.model);
              info.loadedModels = [String(r.model)];
              info.nameMismatch = modelNameMismatch(modelName, [String(r.model)]);
            }
            info.prefillMs = r.ttftMs ?? Date.now() - t0;
          } else {
            info.prefillMs = null;
          }
        } finally {
          got.cleanup();
        }
      } catch {
        info.prefillMs = null;
      }
    }
    // ④ 与本机历史值比对：显著变慢 = "引擎可能还被上一个请求占着"（负责人实测 2.7s → 23.9s）
    {
      const hist = persist ? loadProbeBaseline() : {};
      const prev = hist[key] || null;
      info.ttftBaselineMs = prev?.ttftMs ?? null;
      info.prefillBaselineMs = prev?.prefillMs ?? null;
      const ratio = (/** @type {any} */ cur, /** @type {any} */ base0) =>
        Number(cur) > 0 && Number(base0) > 0 ? Number(cur) / Number(base0) : null;
      const ttftRatio = ratio(info.ttftMs, prev?.ttftMs);
      const prefillRatio = ratio(info.prefillMs, prev?.prefillMs);
      info.slowdown = { ttftRatio, prefillRatio };
      if (persist && info.ttftMs != null) {
        hist[key] = { at: Date.now(), ttftMs: info.ttftMs, prefillMs: info.prefillMs ?? prev?.prefillMs ?? null };
        saveProbeBaseline(hist);
      }
    }
    const nameNote = info.nameMismatch
      ? `⚠ 引擎实际加载的是 ${info.loadedModel}，与配置项名 ${modelName} **不一致**（配的是 A、跑的可能不是 A）`
      : info.loadedModel
        ? `引擎加载 ${info.loadedModel}`
        : '（引擎未回报名）';
    const toolNote =
      info.toolState === 'stable-tools'
        ? `✅ 稳定支持工具调用（${info.toolCallHits}/${n}）`
        : info.toolState === 'unstable-tools'
          ? `⚠ 工具调用**不稳定**（${info.toolCallHits}/${n} 次返回 tool_calls，finish_reason=${info.toolCallFinishes.join('/')}）——agent 任务可能步数为 0，建议换端点或重试预检`
          : info.toolState === 'no-tools'
            ? `❌ 未返回 tool_calls（0/${n}，finish_reason=${info.toolCallFinishes.join('/')}）——该端点很可能不做 function calling`
            : `⚠ 工具调用**未能判定**（${info.toolCallInconclusive || 0} 次样本不可判定：finish_reason=${info.toolCallFinishes.join('/')}）` +
              `——多为"被 max_tokens 截断"（思考型模型先输出思考）或请求异常${info.error ? `：${info.error}` : ''}；` +
              `agent 任务可能步数为 0，**不要**据此判定"不支持工具调用"`;
    const ttftNote = info.ttftMs != null ? `首帧 ${(info.ttftMs / 1000).toFixed(2)}s` : '首帧未测到';
    const prefillNote = info.prefillMs != null ? `参考 prefill ${prefillTokens} tokens ${(info.prefillMs / 1000).toFixed(2)}s` : `参考 prefill 未测到`;
    // v0.6.13（问题 2）：引擎自述上下文 vs 配置——**必须在结论里**（界面 banner 与 web-server.log 都用这条 note）
    const engineNote = engineContextNotice({
      engineCtx: info.engineCtx,
      configuredWindow: info.configuredWindow,
      source: info.engineCtxSource,
      probed: info.engineProbed,
      isLocal: info.isLocal,
      // 跳过的**具体**原因要写出来（否则"跳过"与"没读"分不清，等于没说）
      skipReason: info.isLocal ? (info.loadedModel ? null : '该端点未自报模型名，不确认它实现 /props') : '非本地端点不预检 /props',
    });
    const slowNote =
      (info.slowdown?.ttftRatio != null && info.slowdown.ttftRatio >= 3) || (info.slowdown?.prefillRatio != null && info.slowdown.prefillRatio >= 3)
        ? `\n   ⚠ 与上次预检相比明显变慢（首帧 ${info.ttftBaselineMs != null ? (info.ttftBaselineMs / 1000).toFixed(2) + 's → ' : '？'}${info.ttftMs != null ? (info.ttftMs / 1000).toFixed(2) + 's' : '？'}）：该端点**可能仍在处理上一个请求**（引擎 slot 被占/排队），建议重启引擎后再跑长任务。`
        : '';
    // v0.6.13 修复：三态是"N/3"判据，样本没跑满就必须写明（真机现场：引擎正在启动，
    // 前两次尝试被拒、只有第 3 次拿到样本 → 结论会是"（1/1）"，看着像"测全了"）。
    const wantSamples = Math.max(1, repeats);
    const fewSamples = n > 0 && n < wantSamples;
    if (fewSamples) info.partial = true;
    info.note =
      `${toolNote} · ${ttftNote} · ${prefillNote}` +
      (fewSamples ? ` ·（工具样本只跑满 ${n}/${wantSamples}：前面的尝试失败过——三态按现有样本计，可复跑预检复核）` : '') +
      `${info.partial && !fewSamples ? ' ·（预检超过时间预算，样本未跑满）' : ''} · ${nameNote} · ${engineNote}${slowNote}`;
    return info;
  })();
  probeInflight.set(key, run);
  try {
    const value = await run;
    probeCache.set(key, { at: Date.now(), value });
    return value;
  } finally {
    if (probeInflight.get(key) === run) probeInflight.delete(key);
  }
}

/** 读一次探针的流式响应：取首帧时延 + 是否出现 tool_calls + finish_reason；拿到结论就主动关流（省 token）。
 *  t0 必须由调用方传入（= **请求发起**时刻）：TTFT 的定义是"发出→第一帧"，在这里取 Date.now()
 *  会把"引擎排队 + prefill"整段抹掉（实测过：真值 120ms 会被量成 0ms）。
 *
 *  v0.6.13 修复两点：
 *   · `timeoutErr` 是本次请求的首帧超时错误——**在 body 读取阶段触发时必须抛出去**
 *     （此前一律吞掉，于是"引擎回了头、卡在 prefill"会退化成"样本不可判定"，
 *      最终被归成"不可达"，也就是把"引擎在启动/prefill"说成"引擎没起来"）；
 *   · 关流必须 `.catch()`——`reader.cancel()` 的 rejection 此前无人接
 *     （桩复现：把引擎在探针读流中途杀掉 → 泄漏一个 `TypeError: terminated` unhandledRejection，
 *      长驻的 web 进程会因此被判为未处理异常）。
 * @param {any} res @param {{ hasTool: (s: string) => boolean, t0: number, timeoutErr?: any }} opts */
async function readProbeStream(/** @type {any} */ res, /** @type {{ hasTool: (s: string) => boolean, t0: number, timeoutErr?: any }} */ { hasTool, t0, timeoutErr = null }) {
  let ttftMs = /** @type {number|null} */ (null);
  let toolCalls = false;
  let finish = /** @type {string|null} */ (null);
  let model = /** @type {string|null} */ (null);
  const reader = res?.body?.getReader?.();
  const close = () => { try { const p = reader?.cancel?.(); if (p && typeof p.catch === 'function') p.catch(() => {}); } catch {} };
  if (!reader) return { ttftMs: null, toolCalls: false, finish: null };
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (ttftMs == null && value && value.length) ttftMs = Date.now() - t0;
      buf += dec.decode(value, { stream: true });
      if (hasTool(buf)) toolCalls = true;
      const fm = /"finish_reason"\s*:\s*"([a-z_]+)"/.exec(buf);
      if (fm) finish = fm[1];
      if (!model) {
        const mm = /"model"\s*:\s*"([^"]+)"/.exec(buf);
        if (mm) model = mm[1];
      }
      if (toolCalls || finish) break; // 已能判定：立刻收手
      if (buf.length > 65536) buf = buf.slice(-4096); // 防无界增长（异常端点狂吐）
    }
  } catch (/** @type {any} */ e) {
    close();
    // 首帧超时（我们自己的 abort）必须上报：它是"超时"判据，不是"样本不可判定"
    if (timeoutErr && (e === timeoutErr || e?.probeTimeout === true)) throw timeoutErr;
    /* 其它读失败按"没拿到结论"处理（上层按 unreachable/unknown 归类） */
  }
  close();
  return { ttftMs, toolCalls, finish, model };
}

/** 中位数（偶数量取中间两个的平均；空数组回 null）。 */
function median(/** @type {number[]} */ arr) {
  const a = (Array.isArray(arr) ? arr : []).filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
}

/** 本机历史基线：用于识别"同端点突然变慢 = 可能被旧请求占着"（负责人实测 2.7s → 23.9s）。
 *  存放位置复用既有的 <home>/model-cache.json 里的**保留键** `__probeBaseline`
 *  ——不新开文件、不新增加一处"静默吞写"（写路径复用已审阅的 saveCache）。 */
export const PROBE_BASELINE_KEY = '__probeBaseline';
function loadProbeBaseline() {
  const b = loadCache()?.[PROBE_BASELINE_KEY];
  return b && typeof b === 'object' ? b : {};
}
function saveProbeBaseline(/** @type {any} */ data) {
  const cache = loadCache();
  cache[PROBE_BASELINE_KEY] = data;
  saveCache(cache);
}

function fetchImplOr(/** @type {any} */ f, /** @type {any} */ url, /** @type {any} */ init) {
  return f(url, init);
}

/**
 * 按预检结果**自适应**超时（纯函数，取舍写在下面）。
 *
 * 事实依据：现状是"一刀切 600s 首帧 + 60 分钟无进展看门狗"。实测 2.7s 就能出首帧的端点，
 * 卡 10 分钟已经异常；而实测首帧 30s 的端点，600s 上限是合理的。于是：
 *   · 首帧上限 = clamp(max(实测 TTFT × 20, 参考 prefill × 5), 既有默认(本地 600s/远程 300s), 1800s)
 *     —— ×20 是"给长上下文 prefill 留 20 倍余量"（实测 TTFT 是极小请求，真实任务上下文大得多）；
 *     地板取既有默认（**不比现状更激进**）；天花板取既有单请求总量上限 1800s（首帧不可能超过它）。
 *     用户显式配了 config.timeout.firstTokenMs 时**一律以用户为准**（显式 > 自适应）。
 *   · 无进展看门狗 = clamp(max(实测 TTFT × 100, 参考 prefill × 20), 10 分钟, 60 分钟)
 *     —— ×100 让"慢端点"（TTFT 30s → 50 分钟）不至于被误杀，"快端点"（2.7s → 4.5 分钟→取 10 分钟）
 *     能更早被判为异常并报错。下限 10 分钟保证不误杀一次正常的工具执行/一次长回复。
 *     同样：用户显式配了 config.noProgressTimeoutMs 就听用户的。
 * @param {{ probeTtftMs?: number|null, probePrefillMs?: number|null, isLocal?: boolean, timeoutCfg?: any, noProgressCfg?: any }} input
 */
export function adaptiveTimeouts({ probeTtftMs = null, probePrefillMs = null, isLocal = false, timeoutCfg = null, noProgressCfg = null } = {}) {
  const explicitFirst = Number(timeoutCfg?.firstTokenMs) > 0 ? Number(timeoutCfg.firstTokenMs) : null;
  const explicitNoProgress = Number(noProgressCfg) > 0 ? Number(noProgressCfg) : null;
  const measured = Number(probeTtftMs) > 0 ? Number(probeTtftMs) : null;
  const prefill = Number(probePrefillMs) > 0 ? Number(probePrefillMs) : null;
  const floorFirst = isLocal ? 600000 : 300000;
  // 两个实测量一起用：小请求首帧（×20）+ 参考 prefill（×5，2000 tokens 的实测值越慢、真实任务越危险）
  const firstTokenMs =
    explicitFirst ?? (measured || prefill ? Math.min(1800000, Math.max(floorFirst, Math.round(Math.max(measured ? measured * 20 : 0, prefill ? prefill * 5 : 0)))) : floorFirst);
  const noProgressTimeoutMs =
    explicitNoProgress ??
    (measured || prefill
      ? Math.min(PROGRESS_MAX_MS, Math.max(PROGRESS_MIN_MS, Math.round(Math.max(measured ? measured * 100 : 0, prefill ? prefill * 20 : 0))))
      : PROGRESS_MAX_MS);
  const bits = [];
  if (measured) bits.push(`首帧 ${Math.round(measured)}ms`);
  if (prefill) bits.push(`参考 prefill ${prefillTokensLabel()} ${Math.round(prefill)}ms`);
  return {
    firstTokenMs,
    noProgressTimeoutMs,
    adapted: (measured != null || prefill != null) && explicitFirst == null,
    basis: bits.length ? `预检实测 ${bits.join(' + ')}` : '无预检数据：用既有默认（本地 600s / 远程 300s）',
  };
}
/** 参考 prefill 的样本规模（文案用；与 probeEndpoint 的 prefillTokens 默认一致）。 */
function prefillTokensLabel() {
  return '2000 tokens';
}

// ---------------------------------------------------------------------------
// v0.6.13（问题 2）：**引擎自述上下文** vs **配置上下文**
//
// 真机证据（~/.mingdao/logs/web-server.log:229，2026-10-09T02:41:48）：
//   chat 错误 t820945ac81c9ce5f [流式响应错误] insufficient memory: the request exceeded
//   available GPU memory (sustained critical memory pressure during prefill … Reduce
//   --context-window, close other apps, or try q8 KV quantization.
// 而 ~/.mingdao/config.json 里 customModels.MLocalModel3.6.2.contextWindow = 131072，
// 引擎（llama.cpp，127.0.0.1:60091）自述 n_ctx = 32768 —— 配置是引擎能力的 **4 倍**。
// 后果：内核按 131072 推导预算（98,304），把 15,983 tokens 的 prompt 发给一个只装了 32k 的
// 引擎，长上下文**在 prefill 阶段就被引擎直接拒绝**——此时换预设、调 contextBudget、
// 调 timeout.firstTokenMs 全都无济于事（那些都改不了引擎的 n_ctx）。这正是负责人"换预设也没用"
// 的根因，所以它必须在预检阶段就被读出来、并且**在日志与界面上各说一次**。
//
// 读法：llama.cpp 的 `GET /props` 返回 `default_generation_settings.n_ctx`（有的版本另有顶层
// `n_ctx` / `n_ctx_train`）；其他引擎（vLLM 风格 / Ollama 风格 / 自研网关）能读多少读多少，
// 读不到就**跳过并说明**（不猜、不编造、不把它当成"引擎不行"）。
// ---------------------------------------------------------------------------

/** 从引擎自述（/props 的 JSON）里抽"真实上下文窗口"（纯函数，便于断言/变异）。
 *
 *  候选字段按"越贴近引擎真实装载值越靠前"排序：
 *    · llama.cpp /props：`default_generation_settings.n_ctx`（服务端实际 n_ctx）、顶层 `n_ctx`、`n_ctx_train`；
 *    · vLLM 风格：顶层 `max_model_len`；
 *    · 通用/自研：`context_length`、`model_info.*.context_length`（Ollama /api/show 的形态）。
 *  一律要求**正整数**（0/负数/字符串/NaN 视为读不到）——绝不拿一个假值去和配置比。 */
export function engineContextFromProps(/** @type {any} */ json) {
  if (!json || typeof json !== 'object') return null;
  const dgs = json.default_generation_settings || {};
  const candidates = [
    dgs.n_ctx,
    json.n_ctx,
    dgs.params?.n_ctx,
    json.n_ctx_train,
    json.max_model_len,
    json.context_length,
    json.model_info?.context_length,
    ...Object.values(json.model_info || {}).map((/** @type {any} */ v) => v?.context_length),
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return null;
}

/**
 * 「引擎自述上下文 vs 配置」的**用户可见结论**（纯函数，日志/界面 banner/规模预告共用同一份文案）。
 *
 * 三态（不合并、不省略）：
 *   · 读到了且配置 ≤ 引擎 → 明确说"一致"（用户才知道这条核对**做过**了）；
 *   · 读到了且配置 > 引擎 → **警告**："配置超出引擎能力，长上下文将直接被引擎拒绝"，
 *     并点明"换预设/调 contextBudget 都改不了引擎上限"（负责人现场正是卡在这里）；
 *   · 没读到（端点不提供 /props、字段缺失、非本地端点或不确认实现 /props 而跳过）→ 如实说"未读到/跳过"，
 *     **不**据此判定端点不行，也不假装核对过。
 * @param {{ engineCtx?: number|null, configuredWindow?: number|null, source?: string|null, probed?: boolean, isLocal?: boolean, skipReason?: string|null }} input
 */
export function engineContextNotice({ engineCtx = null, configuredWindow = null, source = null, probed = false, isLocal = false, skipReason = null } = {}) {
  const eng = Number(engineCtx) > 0 ? Math.round(Number(engineCtx)) : null;
  const conf = Number(configuredWindow) > 0 ? Math.round(Number(configuredWindow)) : null;
  const where = source ? `（读自 ${source}）` : '';
  if (eng == null) {
    if (!probed) {
      return `引擎自述上下文：跳过（${skipReason || (isLocal ? '该端点未自报模型名，不确认它实现 /props' : '非本地端点不预检 /props')}）——无法核对配置的 ${conf ?? '？'} 是否超出引擎能力`;
    }
    return `引擎自述上下文：**未读到**（该端点不提供 /props 或其中没有 n_ctx/default_generation_settings.n_ctx 字段）——无法核对配置的 ${conf ?? '？'} 是否超出引擎能力`;
  }
  if (conf != null && conf > eng) {
    return `⚠ 引擎自述上下文 ${eng} vs 配置 ${conf} —— 配置超出引擎能力，长上下文将直接被引擎拒绝${where}。换预设/调小 config.contextBudget 都**改不了引擎上限**：要么在引擎侧把上下文窗口调大（llama.cpp 的 --ctx-size / --context-window），要么把配置改成 ≤ ${eng}。`;
  }
  return `引擎自述上下文 ${eng} vs 配置 ${conf ?? '（未声明）'} —— 配置未超出引擎能力${where}`;
}

export function modelCacheFile() {
  return path.join(mingdaoHome(), 'model-cache.json');
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(modelCacheFile(), 'utf8'));
  } catch {
    return {};
  }
}

function saveCache(/** @type {any} */ data) {
  try {
    ensureHome();
    fs.writeFileSync(modelCacheFile(), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  } catch {}
}

export function providerHasKey(/** @type {any} */ providerName) {
  const pp = /** @type {any} */ (PROVIDERS)[providerName];
  if (!pp) return false;
  if (getStoredKey(providerName)) return true;
  if (pp.envKey && process.env[pp.envKey]) return true;
  return false;
}

export function providerBaseUrl(/** @type {any} */ cfg, /** @type {any} */ providerName) {
  const pp = /** @type {any} */ (PROVIDERS)[providerName];
  if (!pp) return '';
  // 当前服务商的 baseUrl 覆盖优先
  if (providerName === cfg?.provider && cfg?.baseUrl) return cfg.baseUrl;
  return pp.baseUrl || '';
}

export function providerApiKey(/** @type {any} */ providerName) {
  const pp = /** @type {any} */ (PROVIDERS)[providerName];
  const stored = getStoredKey(providerName);
  if (stored) return stored;
  if (pp?.envKey && process.env[pp.envKey]) return process.env[pp.envKey];
  return '';
}

function isChatModel(/** @type {any} */ id) {
  return !/embedding|rerank|moderation/i.test(id);
}

// 拉取某服务商的真实模型名单（缓存优先；force 强制刷新）
// 返回 { models: [名称], fromCache, fetchedAt }；失败返回 { error }
const inflight = new Map(); // 同服务商并发去重：合并为同一请求

export async function fetchProviderModels(/** @type {any} */ cfg, /** @type {any} */ providerName, { force = false } = {}) {
  const base = providerBaseUrl(cfg, providerName).replace(/\/+$/, '');
  const key = providerApiKey(providerName);
  if (!base || !key) return { error: '该服务商未设置 API Key' };
  const cache = loadCache();
  const entry = cache[providerName];
  if (!force && entry && Date.now() - entry.fetchedAt < TTL_MS && Array.isArray(entry.models)) {
    return { models: entry.models, fromCache: true, fetchedAt: entry.fetchedAt };
  }
  if (!force && inflight.has(providerName)) return inflight.get(providerName);
  const p = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      // v0.6.2（代码审计 P2-7 的普查）：这里也是 `redirect: 'follow'`——自动跟随且不逐跳复检。
      // 迁到 safe-fetch 单一来源。allowPrivate: 服务商端点是**用户自己配置**的
      // （本地 vLLM / Ollama 就是内网地址，这是产品明确支持的场景），与 CLI 显式输入 URL 同口径；
      // 逐跳仍会做「非 http(s) 跳转拒绝 + 跳数上限 + 大小上限」这些与私网无关的防护。
      const _r = await safeFetchText(`${base}/models`, {
        timeoutMs: 8000,
        maxBytes: 2 * 1024 * 1024,
        allowPrivate: true,
        headers: { Authorization: `Bearer ${key}` },
      });
      if (_r.error) return { error: _r.error };
      let j = /** @type {any} */ (null);
      try {
        j = JSON.parse(String(_r.text ?? ''));
      } catch {}
      const list = (j?.data || [])
        .map((/** @type {any} */ m) => String(m?.id || '').trim())
        .filter((/** @type {any} */ id) => id && isChatModel(id))
        .slice(0, 200);
      if (!list.length) return { error: '接口未返回可用模型' };
      const cache2 = loadCache(); // 重新读取：避免与并发写入互相覆盖
      cache2[providerName] = { models: list, fetchedAt: Date.now() };
      saveCache(cache2);
      return { models: list, fromCache: false, fetchedAt: Date.now() };
    } catch (e) {
      const ee = /** @type {any} */ (e);
      return { error: ee.name === 'AbortError' ? '请求超时（8s）' : ee.message };
    } finally {
      clearTimeout(timer);
    }
  })();
  inflight.set(providerName, p);
  try {
    return await p;
  } finally {
    if (inflight.get(providerName) === p) inflight.delete(providerName);
  }
}

/**
 * 该模型名是否出现在**已动态拉取的**服务商名单里（v0.6.0 修复）。
 *
 * 为什么需要它：设置界面用 `availableModels()`（动态优先，未在静态表里的标「（线上最新）」），
 * 而切换模型的 `/api/config` 只认静态 `MODELS` 表——于是出现「应用自己列出来的模型却选不了」：
 * DeepSeek 官方把 `deepseek-v4-flash` 改名为 `deepseek-flash` 后，界面能拉到、一点就报
 * 「未知模型」并弹回旧模型。
 *
 * 判据用「服务商自己返回的名单」：它仍是有界集合（`/models` 结果、已按 isChatModel 过滤、
 * 上限 200），因此既不放过任意字符串（v0.4.7 加这条校验就是为了拦 `{model:12345}`），
 * 又能让**厂家改名/上新**这一类正常演进立刻可用，不必等内核发版。
 *
 * `providerName`（审计 BUG-026）：**只认该模型所属服务商自己的名单**。此前遍历缓存里的
 * **所有**服务商条目，于是 A 家拉到的名字能让 B 家的切换校验放行——校验面跨服务商泄漏
 * （实测：缓存里只有 openai 的 `gpt-5` 时，`cfg.provider=deepseek` 的校验也返回 true）。
 * 按审计原话「越权使用模型」是**夸大**：校验通过后 `resolveProviderConfig` 仍会把请求路由到
 * 该名字真正的服务商，不会「借」别家的模型跑；但校验面确实不该跨家。
 * 不传 `providerName` 时保持旧行为（兼容既有调用）。
 * @param {any} name @param {string} [providerName]
 */
export function isDiscoveredModel(/** @type {any} */ name, /** @type {string} */ providerName) {
  const target = String(name || '').trim();
  if (!target) return false;
  const cache = loadCache();
  if (providerName) {
    const models = /** @type {any} */ (cache || {})?.[providerName]?.models;
    return Array.isArray(models) && models.includes(target);
  }
  for (const entry of Object.values(cache || {})) {
    const models = /** @type {any} */ (entry)?.models;
    if (Array.isArray(models) && models.includes(target)) return true;
  }
  return false;
}

// 合并可用模型列表：只含已设置 Key 的服务商；动态名单优先、预设回退；自定义模型恒在。
//
// v0.6.13（B）：**每个条目都要能看出"来自哪个服务商/端点"**。此前自定义条目只有
// providerLabel='自定义'，而下拉是按 providerLabel 分组的——于是 config.customModels 里的
// chatflow 应用名/本地端点模型名与官方模型长得一样，容易被当成官方模型（负责人实测）。
// 现在：自定义端点条目带 source/sourceLabel/endpoint（providerLabel 直接写成「自定义端点 · host」），
// 官方/线上条目带 source/sourceLabel（providerLabel 仍是服务商名）。
export async function availableModels(/** @type {any} */ cfg, /** @type {any} */ currentModel) {
  const out = [];
  const seen = new Set();
  for (const [pname, pp] of Object.entries(PROVIDERS)) {
    if (pname === 'custom') continue;
    if (!providerHasKey(pname)) continue;
    const dynamic = await fetchProviderModels(cfg, pname);
    const names = dynamic.models?.length ? dynamic.models : pp.models || [];
    for (const n of names) {
      if (seen.has(n)) continue;
      seen.add(n);
      const preset = /** @type {any} */ (MODELS)[n];
      out.push({
        name: n,
        label: preset ? `${n} — ${preset.label}` : `${n}（线上最新）`,
        provider: pname,
        providerLabel: pp.label,
        dynamic: !(/** @type {any} */ (MODELS))[n],
        // 来源标注（B）：内置预设 vs 服务商线上名单——两者都是"该服务商自己的模型"
        official: Boolean(preset),
        source: preset ? 'preset' : 'discovered',
        sourceLabel: preset ? `内置预设 · ${pp.label}` : `线上名单 · ${pp.label}`,
      });
    }
  }
  for (const [cmName, cm] of Object.entries(cfg?.customModels || {})) {
    if (seen.has(cmName)) continue;
    seen.add(cmName);
    const src = customSourceOf(cfg, cmName);
    out.push({
      name: cmName,
      // 展示名里也带上来源（不只是 title/tooltip）：下拉标题行、设置面板、日志三处一致
      label: `${cmName} — ${cm.label || '自定义模型'}（${src.sourceLabel}）`,
      provider: 'custom',
      providerLabel: src.providerLabel,
      custom: true,
      // v0.6.13（B）：来源标注的结构化字段（前端/测试都读它，不靠解析 label 文本）
      official: false,
      source: src.source,
      sourceLabel: src.sourceLabel,
      endpoint: src.endpoint || null,
      isLocalEndpoint: src.isLocalEndpoint,
      note: src.note,
    });
  }
  if (currentModel && !out.some((m) => m.name === currentModel)) {
    out.unshift({
      name: currentModel,
      label: `${currentModel}（当前配置）`,
      provider: 'current',
      providerLabel: '当前',
      official: false,
      source: 'current',
      sourceLabel: '当前配置（不在任何已知名单里）',
      note: '该名称不在任何服务商名单/自定义条目里——只是 config.json 里当前写着的模型名。',
    });
  }
  return out;
}
