// Provider 注册表与工厂。
//
// 接入模型的三条路：
// 1. 内置 OpenAI 兼容端点 —— 在 config 里配 baseUrl/apiKey 即可（覆盖绝大多数模型）；
// 2. 内置服务商预设 —— deepseek / openai / qwen / glm / moonshot / custom；
// 3. 自定义 Provider 模块 —— 在 <mingdao-home>/providers/<name>.mjs 中
//    export async function createProvider(cfg)，返回 { chat(opts) }。
//    适合 Anthropic 原生协议、本地推理框架等非 OpenAI 兼容场景。
// 详见 docs/PROVIDERS.md。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chat as openaiChat, isMemoryPressureError } from './openai-compatible.js';
// 供 agent/model-discovery 与回归套件复用同一条「内存压力」判据（单一来源，避免各层各写一份正则）。
export { isMemoryPressureError };
import { modelPreset, providerPreset } from '../models.js';
import { mingdaoHome } from '../config.js';
import { resolveApiKey, getStoredKey } from '../credentials.js';
import { isLocalBaseUrl } from '../model-caps.js';
import { atomicWriteJsonSync } from '../atomic-write.js';

// ---------------------------------------------------------------------------
// 本地端点并发闸门（v0.6.15，登记 §3.59 四条待办之首）
//
// 真机证据（v0.6.14，macOS，`mtplx-qwen38-27b-optimized-quality` @ 8081）：
//   长任务中途被引擎拒绝——
//     insufficient memory: the request exceeded available GPU memory
//     (sustained critical memory pressure during prefill; aborted before the allocator wall).
//     The engine shed its caches and stays up; this request failed.
//   同一错误此前在 60091 的 35B 上也出现过 → **不是模型问题，是本机内存压力**；
//   观测到该回合此前有子代理在跑（13 轮 / 17 次调用）→ 父回合 + 子代理同时向**同一本地引擎**
//   发请求是内存压力的主要来源（两个大 prefill 各自要一份 KV cache）。
//
// 修法：对**同一 baseUrl** 的本地端点在途请求做**串行化/限量**，默认 1 并发。
// 覆盖三类来源（都必须过同一道闸门，否则等于没修）：
//   ① 父回合的 provider.chat；
//   ② 子代理（同一 provider 实例/同一 baseUrl，天然共享本模块的进程级队列）；
//   ③ 端点预检（model-discovery.js 的探针也打同一个 /chat/completions，抢的是同一份内存）。
// 云端端点**不受影响**：`isLocalBaseUrl` 为假时直接放行（不排队、不记日志、不加延迟）。
//
// 三条硬约束：
//   · **不许忙等**：Promise 队列 + 释放即移交名额；
//   · **排队也有上限**：`config.localQueueTimeoutMs`（默认 30 分钟），超时给**可见错误**，
//     不会让第二个回合永远挂着（真机最怕的正是"看起来在跑、其实永远排不到"）；
//   · **日志留痕**：入队时记一行「本地端点串行化：等待 N 个在途请求」，并回调 onWait
//     让 agent/WebUI 把「已串行化（防内存压力）」摆到进度行上。

/** 默认并发上限：本地引擎通常是单进程/单 slot，1 是最安全的默认值。 */
export const DEFAULT_LOCAL_CONCURRENCY = 1;
/** 默认排队等待上限：与本地 `timeout.totalMs`（30 分钟）同量级，避免死等。 */
export const DEFAULT_LOCAL_QUEUE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * 归一化 baseUrl（去掉尾部斜杠）：同一端点的不同写法必须命中同一条队列。
 * @param {any} baseUrl
 */
export function normalizeLocalBaseUrl(/** @type {any} */ baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

/**
 * 本地端点并发上限（纯函数，便于断言/变异）：`config.localConcurrency`。
 *   · 未配置 / 非法 / 负数 → 默认 1（fail-safe：宁可串行化，也不要再撞内存墙）；
 *   · **0 → 不限**（显式退出串行化，用户明确知道自己在意延迟而不是内存）；
 *   · 正整数 → 该值（上限 16，防手滑写成 999 等于没限制）。
 * @param {any} cfg
 */
export function localConcurrencyLimit(/** @type {any} */ cfg) {
  const raw = cfg?.localConcurrency;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_LOCAL_CONCURRENCY;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_LOCAL_CONCURRENCY;
  return Math.min(16, Math.floor(n));
}

/**
 * 排队等待上限（纯函数）：`config.localQueueTimeoutMs`，未配置/非法 → 30 分钟。
 * 0/负数不表示"无限等"，而是回落默认（死等是这轮要消灭的东西）。
 * @param {any} cfg
 */
export function localQueueTimeoutMs(/** @type {any} */ cfg) {
  const n = Number(cfg?.localQueueTimeoutMs);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LOCAL_QUEUE_TIMEOUT_MS;
  return Math.min(n, 24 * 60 * 60 * 1000);
}

/** 一条给人看的入队日志（纯函数，日志/UI 共用同一份口径）。 @param {any} ev */
export function localQueueEventText(/** @type {any} */ ev) {
  const endpoint = String(ev?.endpoint || ev?.baseUrl || '本地端点');
  const active = Number(ev?.active) || 0;
  const queued = Number(ev?.queued) || 0;
  const limit = Number(ev?.limit) || DEFAULT_LOCAL_CONCURRENCY;
  return (
    `本地端点串行化：等待 ${active} 个在途请求（${endpoint}，并发上限 ${limit}` +
    `${queued > 1 ? `，排在第 ${queued} 位` : ''}）——本地模型内存压力，避免父子回合同时 prefill`
  );
}

/** @type {((ev: any) => void)|null} */
let queueObserver = null;
/**
 * 注册串行化事件观察者（WebUI 启动时接到 srvlog；不注册则写 console.error）。
 * @param {((ev: any) => void)|null} fn
 */
export function setLocalQueueObserver(/** @type {any} */ fn) {
  queueObserver = typeof fn === 'function' ? fn : null;
}

function emit(/** @type {any} */ ev) {
  try {
    if (queueObserver) queueObserver(ev);
    else console.error(`[MingDao] ${ev.text}`);
  } catch {
    /* 日志失败不得影响请求 */
  }
}

/** @type {Map<string, { baseUrl: string, limit: number, active: number, waiters: any[] }>} */
const localGates = new Map();

/** @param {string} baseUrl @param {number} limit */
function localGateFor(baseUrl, limit) {
  let g = localGates.get(baseUrl);
  if (!g) {
    g = { baseUrl, limit, active: 0, waiters: [] };
    localGates.set(baseUrl, g);
  }
  g.limit = limit;
  return g;
}

/** 端点当前状态（纯快照，供预告/进度行/断言用；不参与调度）。 @param {any} baseUrl */
export function localGateSnapshot(/** @type {any} */ baseUrl) {
  const key = normalizeLocalBaseUrl(baseUrl);
  const g = localGates.get(key);
  if (!g) return { baseUrl: key, active: 0, queued: 0, limit: DEFAULT_LOCAL_CONCURRENCY, known: false };
  return { baseUrl: key, active: g.active, queued: g.waiters.length, limit: g.limit, known: true };
}

/** 该端点现在是否已有在途/排队请求（纯查询；云端恒 false）。 @param {any} baseUrl */
export function localGateBusy(/** @type {any} */ baseUrl) {
  const snap = localGateSnapshot(baseUrl);
  return Boolean(snap.known && (snap.active > 0 || snap.queued > 0));
}

/** 取得名额后的释放函数：把名额**直接移交**给下一个等待者（active 不变），否则 active--。 */
function makeLocalRelease(/** @type {any} */ g) {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const next = g.waiters.shift();
    if (next) {
      // 名额移交：active 不减，等待者的 grant 负责 resolve（不改变 active）
      next.grant();
      return;
    }
    g.active = Math.max(0, g.active - 1);
    if (g.active === 0 && g.waiters.length === 0 && localGates.get(g.baseUrl) === g) localGates.delete(g.baseUrl);
  };
}

/**
 * 取得一个本地端点执行名额（云端端点直接返回空释放函数）。
 *
 * 返回的 release **必须**在请求真正结束后调用（流读完、finally 里），否则后续请求会
 * 永远排队——这正是"不能用忙等、也不许忘记释放"的接口约束。
 *
 * @param {any} baseUrl
 * @param {{ cfg?: any, signal?: any, onWait?: (ev: any) => void, queueTimeoutMs?: number,
 *           endpoint?: string, label?: string }} [opts]
 * @returns {Promise<() => void>}
 */
export async function acquireLocalSlot(/** @type {any} */ baseUrl, opts = {}) {
  const key = normalizeLocalBaseUrl(baseUrl);
  // 云端端点不受影响：不排队、不记日志、不增加任何延迟（需求 1 的硬边界）。
  if (!isLocalBaseUrl(key)) return () => {};
  const limit = localConcurrencyLimit(opts.cfg);
  if (limit === 0) return () => {}; // 显式退出串行化
  const waitMs = Number(opts.queueTimeoutMs) > 0 ? Number(opts.queueTimeoutMs) : localQueueTimeoutMs(opts.cfg);
  const g = localGateFor(key, limit);

  if (g.active < g.limit) {
    g.active += 1;
    return makeLocalRelease(g);
  }

  // 需要排队：先留痕（日志/UI），再把自己挂到 Promise 队列上。
  const endpoint = String(opts.endpoint || key);
  const queued = g.waiters.length + 1;
  const ev = /** @type {any} */ ({ type: 'wait', baseUrl: key, endpoint, active: g.active, queued, limit: g.limit, label: opts.label || '' });
  ev.text = localQueueEventText(ev);
  emit(ev);
  try {
    opts.onWait?.(ev);
  } catch {}

  return await new Promise((resolve, reject) => {
    /** @type {any} */
    const waiter = { settled: false, grant: null, timer: null, onAbort: null, signal: opts.signal || null };
    const settle = (/** @type {boolean} */ ok, /** @type {any} */ value) => {
      if (waiter.settled) return;
      waiter.settled = true;
      if (waiter.timer) clearTimeout(waiter.timer);
      try {
        if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
      } catch {}
      const at = g.waiters.indexOf(waiter);
      if (at >= 0) g.waiters.splice(at, 1);
      if (ok) resolve(value);
      else reject(value);
    };
    waiter.grant = () => {
      if (waiter.settled) return;
      waiter.settled = true;
      if (waiter.timer) clearTimeout(waiter.timer);
      try {
        if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
      } catch {}
      // 名额已从上一个持有者移交过来：active 保持不变
      try {
        opts.onWait?.({ ...ev, waiting: false, active: g.active, queued: Math.max(0, g.waiters.length), limit: g.limit });
      } catch {}
      resolve(makeLocalRelease(g));
    };
    waiter.timer = setTimeout(() => {
      const err = /** @type {any} */ (
        new Error(
          `本地端点排队超时（等待 ${(waitMs / 1000).toFixed(1)}s，仍有 ${g.active} 个在途请求，并发上限 ${g.limit}）：` +
            `为避免内存压力已在本机端点串行化——可调大 config.localQueueTimeoutMs，或减少子代理/并行会话。`
        )
      );
      err.code = 'LOCAL_QUEUE_TIMEOUT';
      err.status = 0;
      err.localEndpoint = key;
      settle(false, err);
    }, waitMs);
    waiter.onAbort = () => settle(false, opts.signal?.reason ?? new Error('已中断（本地端点排队中）'));
    if (opts.signal) {
      if (opts.signal.aborted) {
        waiter.onAbort();
        return;
      }
      try {
        opts.signal.addEventListener('abort', waiter.onAbort, { once: true });
      } catch {}
    }
    g.waiters.push(waiter);
  });
}

/** 仅供测试：清空全部队列（不影响已取得名额的释放函数）。 */
export function __resetLocalGates() {
  localGates.clear();
}

// ---------------------------------------------------------------------------
// 端点级「内存安全预算」学习（v0.6.26 §3.91）
//
// 真机证据（~/.mingdao/logs/web-server.log，三次同一形态：10-18 / 10-19 / 10-26）：
//   08:59:14 chat 进度 … 子代理「审计网络与安全防线」已跑 31 轮 / 50 次工具调用
//   09:00:22 chat 错误 … insufficient memory … aborted before the allocator wall
//   ↩ 已压缩上下文（32,768 → ~19,660）、输出上限 4,096 → 2,048，并重试 1 次，仍失败
//            建议：把 config.contextBudget 调到 13,762 左右…
// 问题不在"没有压缩"，而在**每一回合都从同一个注定失败的预算重新撞一次**：用户看到了建议，
// 但内核自己不记住；下一次开新会话（或同一端点的另一个模型）又按 32,768 发。
//
// 这里把「该 baseUrl 的内存安全预算」持久化到 <mingdao-home>/endpoint-limits.json：
//   · 键 = 归一化后的 baseUrl（同一个端点的不同写法命中同一条记录）；
//   · 值 = { safeContextBudget, learnedAt, source: 'memory-failure', … }；
//   · **两级压缩后仍失败**才写入（调用方保证），后续回合直接以 safeContextBudget 起手；
//   · 之后连续 3 个"干净成功"的回合把学习值 +25%（上限 = 用户配置的预算），
//     如果上调后又撞内存墙，两级压缩仍失败会把它重新学下来——降级/恢复都基于证据。
//   · 文件读/写失败**绝不阻断会话**：所有函数都返回 {ok, error}，由调用方降级为"无学习值"并打 warn。
// ---------------------------------------------------------------------------

/** 学习文件名（放在 <mingdao-home> 下，与 config.json 同级）。 */
export const ENDPOINT_LIMITS_FILE = 'endpoint-limits.json';
/** 文件格式版本（未来字段演进时用于识别旧文件）。 */
export const ENDPOINT_LIMITS_VERSION = 1;
/** 学习值上调策略：连续这么多次干净成功，才允许 +25%。 */
export const ENDPOINT_UPGRADE_SUCCESS_STREAK = 3;
/** 每次上调的比例（只作用于学习值本身，且不超过用户配置预算）。 */
export const ENDPOINT_UPGRADE_RATIO = 1.25;
/** 学习值下限：低于它连系统提示 + 一轮工具结果都放不下，学习就没有意义。 */
export const ENDPOINT_MIN_SAFE_BUDGET = 1024;

/** 学习文件路径（测试可换 MINGDAO_HOME 隔离）。 */
export function endpointLimitsFile() {
  return path.join(mingdaoHome(), ENDPOINT_LIMITS_FILE);
}

/** 端点键：归一化 baseUrl（去尾部斜杠），与本地并发闸门同一口径。 */
export function endpointKeyOf(/** @type {any} */ baseUrl) {
  return normalizeLocalBaseUrl(baseUrl);
}

/**
 * 读取端点学习表。**任何读失败都降级为空表 + error**，绝不抛：
 *   · 不存在（ENOENT）→ ok:true、空表（首次运行，不是错误）；
 *   · 不可读 / 解析失败 / 结构不对 → ok:false、空表、error 带文件路径与原因。
 * 调用方拿到 ok:false 时必须按"无学习值"继续，只打一条 warn。
 * @returns {{ ok: boolean, exists: boolean, file: string, version: number, endpoints: Record<string, any>, error: string|null }}
 */
export function readEndpointLimits() {
  const file = endpointLimitsFile();
  /** @type {{ ok: boolean, exists: boolean, file: string, version: number, endpoints: Record<string, any>, error: string|null }} */
  const base = { ok: true, exists: false, file, version: ENDPOINT_LIMITS_VERSION, endpoints: {}, error: null };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (/** @type {any} */ (err)?.code === 'ENOENT') return base;
    return {
      ...base,
      ok: false,
      error: `端点学习文件读取失败（${file}）：${(/** @type {any} */ (err))?.message || err}——本轮按无学习值继续`,
    };
  }
  // BOM：合法 JSON + 文件头 BOM = JSON.parse 直接抛（与 config.json 同一处理）
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return {
      ...base,
      exists: true,
      ok: false,
      error: `端点学习文件不能解析（${file}）：${(/** @type {any} */ (err))?.message || err}——本轮按无学习值继续（文件保持原样，避免覆盖可人工修复的数据）`,
    };
  }
  const eps = data?.endpoints;
  if (!eps || typeof eps !== 'object' || Array.isArray(eps)) {
    return {
      ...base,
      exists: true,
      ok: false,
      error: `端点学习文件缺少 endpoints 对象（${file}）——本轮按无学习值继续（文件保持原样）`,
    };
  }
  /** @type {Record<string, any>} */
  const endpoints = {};
  for (const [key, value] of Object.entries(eps)) {
    const n = Number(/** @type {any} */ (value)?.safeContextBudget);
    if (!(n > 0)) continue; // 单条记录坏了只跳过它，不拖垮整张表
    endpoints[endpointKeyOf(key)] = {
      .../** @type {any} */ (value),
      safeContextBudget: Math.max(ENDPOINT_MIN_SAFE_BUDGET, Math.floor(n)),
    };
  }
  return { ...base, exists: true, version: Number(data?.version) || ENDPOINT_LIMITS_VERSION, endpoints };
}

/** 写整张学习表（原子写 + 0600）。失败返回 {ok:false,error}，绝不抛。 */
function writeEndpointLimits(/** @type {Record<string, any>} */ endpoints) {
  const file = endpointLimitsFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    atomicWriteJsonSync(file, { version: ENDPOINT_LIMITS_VERSION, endpoints });
    return { ok: true, error: null, file };
  } catch (err) {
    return {
      ok: false,
      error: `端点学习文件写入失败（${file}）：${(/** @type {any} */ (err))?.message || err}——本轮按无学习值继续`,
      file,
    };
  }
}

/**
 * 查该端点的学习值（纯读，不写入）。
 * @param {any} baseUrl
 * @returns {{ key: string, record: any|null, ok: boolean, error: string|null, file: string }}
 */
export function endpointLimitFor(/** @type {any} */ baseUrl) {
  const key = endpointKeyOf(baseUrl);
  const file = endpointLimitsFile();
  if (!key) {
    // 没有 baseUrl（例如自定义 Provider 模块）：不是错误，只是没有可学习的键。
    return { key: '', record: null, ok: true, error: null, file };
  }
  const r = readEndpointLimits();
  return { key, record: r.endpoints[key] || null, ok: r.ok, error: r.error, file: r.file };
}

/**
 * 记录一次「多级压缩后仍失败」：把**最后尝试的预算**写成该端点的 safeContextBudget。
 *
 * 为什么记最后尝试的值而不是原配置：下一次回合的起手预算必须来自"已经压到的最低一级"，
 * 否则同一个注定失败的预算会每回合重撞一次（真机三次同形态失败的根因）。
 * 学习值是**起手上限**，不是"保证成功"——若它仍失败，下一回合会在它基础上继续按级压缩；
 * 若连续失败，值会逐回合向下棘轮，直到某一回合成功为止。
 * @param {any} baseUrl
 * @param {{ budget: number, maxOutput?: number|null, attempts?: number, at?: number, source?: string }} [opts]
 * @returns {{ ok: boolean, key: string, record: any|null, previous: any|null, error: string|null, file: string }}
 */
export function learnEndpointMemoryFailure(/** @type {any} */ baseUrl, { budget, maxOutput = null, attempts = 2, at = Date.now(), source = 'memory-failure' } = /** @type {any} */ ({})) {
  const key = endpointKeyOf(baseUrl);
  const file = endpointLimitsFile();
  const empty = { ok: false, key, record: null, previous: null, error: null, file };
  if (!key) return { ...empty, ok: true, error: null };
  const rawBudget = Number(budget);
  if (!(rawBudget > 0)) {
    return { ...empty, error: `端点学习值未写入：预算无效（${String(budget)}）——本轮按无学习值继续` };
  }
  const r = readEndpointLimits();
  if (!r.ok) {
    // 文件坏了/读不出：**不覆盖**（可能还能人工救回来），只降级为无学习值。
    return { ...empty, error: `${r.error}；本次不写入，避免覆盖可能需要人工修复的文件` };
  }
  const previous = r.endpoints[key] || null;
  const nowIso = new Date(Number(at) || Date.now()).toISOString();
  const record = {
    safeContextBudget: Math.max(ENDPOINT_MIN_SAFE_BUDGET, Math.floor(rawBudget)),
    learnedAt: nowIso,
    source,
    attempts: Math.max(1, Math.floor(Number(attempts) || 1)),
    ...(Number(maxOutput) > 0 ? { maxOutputTokens: Math.floor(Number(maxOutput)) } : {}),
    failures: (Number(previous?.failures) || 0) + 1,
    successStreak: 0,
    lastFailedAt: nowIso,
  };
  const w = writeEndpointLimits({ ...r.endpoints, [key]: record });
  return { ok: w.ok, key, record: w.ok ? record : null, previous, error: w.error, file };
}

/**
 * 记录一次**干净成功**（本回合既没有内存压缩、也没有中断/无进展）：连续
 * ENDPOINT_UPGRADE_SUCCESS_STREAK 次后把学习值上调 ENDPOINT_UPGRADE_RATIO（+25%）。
 *
 * 上调的上限是 `ceiling`（调用方传**用户配置的预算**，即"用户本来想要多大"），
 * 所以学习值只会朝用户明确要过的方向恢复，不会一路涨到窗口上限。
 * 这不是"猜一个更大的值去冒险"：上调后若再次撞内存墙，两级压缩仍失败会把它重新学下来
 * （见 learnEndpointMemoryFailure）——降级有证据、恢复也有证据，形成闭环。
 *
 * 没有学习值的端点不写文件（不为"成功"凭空造学习值）。
 * @param {any} baseUrl
 * @param {{ budget: number, ceiling?: number, at?: number }} [opts]
 * @returns {{ ok: boolean, key: string, record: any|null, previous: any|null, raised: boolean, streak: number, error: string|null, file: string }}
 */
export function noteEndpointSuccess(/** @type {any} */ baseUrl, { budget, ceiling = 0, at = Date.now() } = /** @type {any} */ ({})) {
  const key = endpointKeyOf(baseUrl);
  const file = endpointLimitsFile();
  const empty = { ok: true, key, record: null, previous: null, raised: false, streak: 0, error: null, file };
  if (!key) return empty;
  const r = readEndpointLimits();
  if (!r.ok) return { ...empty, ok: false, error: r.error };
  const previous = r.endpoints[key] || null;
  if (!previous) return empty; // 没学过就没有可上调的值（不为"成功"凭空造学习值）
  const used = Math.floor(Number(budget) || 0);
  const cap = Math.max(Math.floor(Number(ceiling) || 0), used, Number(previous.safeContextBudget) || 0);
  const nowIso = new Date(Number(at) || Date.now()).toISOString();
  const streak = (Number(previous.successStreak) || 0) + 1;
  /** @type {any} */
  let next = { ...previous, successStreak: streak, lastSuccessAt: nowIso, lastSuccessBudget: used };
  let raised = false;
  if (streak >= ENDPOINT_UPGRADE_SUCCESS_STREAK) {
    const target = Math.min(Math.floor(Number(previous.safeContextBudget) * ENDPOINT_UPGRADE_RATIO), cap);
    if (target > Number(previous.safeContextBudget)) {
      next = { ...next, safeContextBudget: target, learnedAt: nowIso, source: 'success-upgrade', successStreak: 0 };
      raised = true;
    } else {
      next = { ...next, successStreak: 0 };
    }
  }
  const w = writeEndpointLimits({ ...r.endpoints, [key]: next });
  return { ok: w.ok, key, record: w.ok ? next : null, previous, raised: w.ok && raised, streak, error: w.error, file };
}

// v0.6.3（下游 Dify 工作流反馈）：`customModels` 的条目其实是**两种东西**，此前混为一谈——
//   · **声明式端点**：写了 baseUrl / envKey / apiKey / headers 等传输字段 → 确实是"自定义
//     OpenAI 兼容端点"，优先于内置预设（原行为，不变）；
//   · **纯能力覆盖**：只写 vision / tokenizer / contextWindow / maxOutputTokens / local，
//     或只给一个 provider 路由提示 → 它只是给**已有模型**补能力声明，
//     **不该劫持 transport**。
// 为什么必须区分：下游为了让图片能发出去，只能往 customModels 里加一条 `vision: true`；
// 而原实现只要 cm 存在就返回 `custom:{name}` + openai-compatible，
// 于是把他们的**自定义 Provider 模块整个绕开**（请求发到 baseUrl 而不是他们的 Dify 适配器）。
// 换句话说：「打开一个能力开关」不该改变「请求发给谁」。
const CM_TRANSPORT_KEYS = ['baseUrl', 'apiKey', 'envKey', 'headers', 'path', 'kind'];
/** @param {any} cm */
function isEndpointDeclaration(cm) {
  if (!cm || typeof cm !== 'object') return false;
  return CM_TRANSPORT_KEYS.some((k) => {
    const v = cm[k];
    return v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '');
  });
}

export function resolveProviderConfig(/** @type {any} */ cfg, /** @type {any} */ modelName) {
  // 自定义模型（config.customModels，WebUI 可增删改）：优先于内置预设
  const cm = cfg?.customModels?.[modelName];
  if (cm && isEndpointDeclaration(cm)) {
    // P1 修复（v0.4.6）：自定义模型的密钥解析不得成为「任意环境变量外泄」通道。
    // 此前 envKeys = [cm.envKey, 'MINGDAO_API_KEY']，而 envKey 与 baseUrl 都完全由调用方指定
    // （WebUI 的 addCustom 接受任意输入）——于是任何能加一个自定义模型的人，都能把宿主环境里的
    // 任意变量（AWS_SECRET_ACCESS_KEY / GITHUB_TOKEN / …）当作 Bearer 发到自己的端点；
    // 即使不填 envKey 也会回落 MINGDAO_API_KEY，把用户的主密钥送出去。两条路一起封：
    //   ① envKey 必须是「像模型密钥」的名字（大写、以 _API_KEY/_KEY 结尾、不含 SECRET/TOKEN/…）；
    //   ② 未声明（或被拒）时不读任何环境变量，只认凭证库——环境变量必须被显式点名才可用。
    const rawEnvKey = String(cm.envKey || '').trim();
    const safeEnvKey =
      /^[A-Z][A-Z0-9_]{2,63}$/.test(rawEnvKey) &&
      /(_API_KEY|_KEY)$/.test(rawEnvKey) &&
      !/(SECRET|TOKEN|PASSWORD|CREDENTIAL|PRIVATE|PASSWD)/.test(rawEnvKey)
        ? rawEnvKey
        : '';
    if (rawEnvKey && !safeEnvKey) {
      console.warn(
        `[MingDao] 自定义模型 ${modelName} 的 envKey「${rawEnvKey}」不是合法的模型密钥变量名，已忽略。` +
          `如需用环境变量提供密钥，请用形如 MY_GATEWAY_API_KEY 的名字；否则请用 mingdao key set custom:${modelName} 存入凭证库。`
      );
    }
    const envVal = safeEnvKey ? process.env[safeEnvKey] || '' : '';
    const storedKey = getStoredKey(`custom:${modelName}`) || getStoredKey('custom') || '';
    const apiKey = envVal || storedKey || '';
    return {
      name: `custom:${modelName}`,
      kind: 'openai-compatible',
      baseUrl: cm.baseUrl || cfg?.baseUrl || '',
      apiKey,
      envHint: safeEnvKey || `custom:${modelName}`,
      isCustom: true,
      modelName,
    };
  }
  const preset = modelPreset(modelName);
  // 纯能力覆盖里可以给一个**路由提示**：customModels.<name>.provider = 'dify'
  // → 走那个 provider（自定义模块会在 createProvider 里被加载），而不是退到默认 provider。
  const name = (cm && typeof cm.provider === 'string' && cm.provider.trim()) || preset?.provider || cfg?.provider || 'deepseek';
  const pp = providerPreset(name) || { kind: 'openai-compatible' };
  const baseUrl = cfg?.baseUrl || pp.baseUrl || '';
  const apiKey = resolveApiKey(cfg, name, pp.envKey);
  return {
    name,
    kind: pp.kind || 'openai-compatible',
    baseUrl,
    apiKey,
    envHint: pp.envKey || 'MINGDAO_API_KEY',
    isCustom: !providerPreset(name),
  };
}

// ---------------------------------------------------------------------------
// 自定义 Provider 名 → 模块路径（v0.6.3 / R4：名字必须过白名单，且结果必须落在 providers/ 内）
//
// 原实现直接 `path.join(mingdaoHome(), 'providers', pc.name + '.mjs')` 再 import —— 而
// `pc.name` 来自 `customModels.<模型名>.provider`（config.json，**并且可经 WebUI 的
// /api/models-config addCustom 写入**）。于是 `provider: '../../../../tmp/evil'` 会 import 出
// 目录之外的 .mjs：与本仓 v0.4.6 修掉的"环境变量外泄"是同一类孪生通道（读+执行任意本地模块）。
//
// 两层防护（白名单 + 包含性检查）：白名单挡住绝大多数形态，包含性检查兜住"以后有人改了拼接方式"。
const PROVIDER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** @param {any} name */
export function isSafeProviderName(name) {
  const n = String(name || '');
  if (!PROVIDER_NAME_RE.test(n)) return false;
  if (n === '.' || n === '..' || n.includes('..')) return false;
  return true;
}
/**
 * 解析自定义 Provider 模块路径；名不合法或路径越界时返回 null（调用方按"没有自定义模块"处理）。
 * @param {any} name
 */
export function customProviderFile(name) {
  if (!isSafeProviderName(name)) return null;
  const dir = path.join(mingdaoHome(), 'providers');
  const file = path.join(dir, `${String(name)}.mjs`);
  const rel = path.relative(dir, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return file;
}

// ---------------------------------------------------------------------------
// 视觉能力解析（v0.6.3，下游 Dify 工作流反馈）
//
// 原门控只看「内置预设 supportsVision」或「customModels.<name>.vision」，
// 于是**自定义 Provider**（自己的 Dify/网关适配器）永远被判为不支持图片——
// 而那些 Provider 明明支持视觉。现在把自定义 Provider 模块的**静态声明**也算进来。
//
// 声明方式（任选其一，写在 ~/.mingdao/providers/<name>.mjs 里）：
//     export const supportsVision = true;
//     export const capabilities = { vision: true };
// 只读**静态导出**，不调用 createProvider()——后者可能有副作用（起进程/建连接）。
// 结果按文件 mtime 缓存，避免每轮都 import。
// ---------------------------------------------------------------------------
/** @type {Map<string, {mtimeMs: number, vision: boolean}>} */
const visionProbeCache = new Map();

/**
 * 该模型是否支持图片输入。顺序：显式声明 > 内置预设 > 自定义 Provider 的静态声明。
 * @param {any} cfg @param {any} modelName
 * @returns {Promise<boolean>}
 */
export async function resolveVisionSupport(cfg, modelName) {
  const cm = cfg?.customModels?.[modelName];
  // ① 显式声明优先（true/false 都算数——写 false 就是明确关闭）
  if (cm && typeof cm.vision === 'boolean') return cm.vision;
  // ② 内置预设
  if (modelPreset(modelName)?.supportsVision === true) return true;
  // ③ 自定义 Provider 模块的静态声明
  try {
    const pc = resolveProviderConfig(cfg, modelName);
    if (!pc.isCustom || pc.name.includes(':')) return false;
    const file = customProviderFile(pc.name); // R4：名字不合法/越界 → null（当作没有自定义模块）
    if (!file || !fs.existsSync(file)) return false;
    const mtimeMs = fs.statSync(file).mtimeMs;
    const hit = visionProbeCache.get(pc.name);
    if (hit && hit.mtimeMs === mtimeMs) return hit.vision;
    const mod = await import(pathToFileURL(file).href + `?v=${mtimeMs}`);
    const vision = mod?.supportsVision === true || mod?.capabilities?.vision === true;
    visionProbeCache.set(pc.name, { mtimeMs, vision });
    return vision;
  } catch {
    // 探不动就当不支持（门控是"能不能发图"，宁可保守）；但**不抛**——不能因为探测失败让整轮崩
    return false;
  }
}

const sleep = (/** @type {any} */ ms, /** @type {any} */ signal) =>
  // v0.6.3（BUG-030）：退避等待必须可被用户 Ctrl+C 打断（此前最长要干等 30s）
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('已中断'));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve(undefined);
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error('已中断'));
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });

function isTransient(/** @type {any} */ err) {
  // v0.6.18 §3.74：内存/显存不足**不是瞬态网络抖动**——原样重发同一份大 prompt 只会再撞一次
  // 内存墙（真机 8081：父回合 + 子代理并发 prefill）。这类错误交给 agent 做「压缩上下文 +
  // 输出减半 + 强制串行」的一次性恢复；这里必须**不重试**，否则同回合会白烧 2 次请求
  // （且 500+insufficient memory 会被 `status >= 500` 误判成瞬态）。
  if (isMemoryPressureError(err)) return false;
  const status = err?.status;
  if (status === 429 || (status >= 500 && status <= 504)) return true;
  // 注意：不含 abort —— 用户 Ctrl+C 主动中断不应触发重试
  return /timeout|超时|ECONNRESET|fetch failed/i.test(String(err?.message || ''));
}

export async function createProvider(/** @type {any} */ cfg, /** @type {any} */ modelName, /** @type {{ timeoutMs?: number, retries?: number }} */ { timeoutMs, retries = 2 } = {}) {
  const pc = resolveProviderConfig(cfg, modelName);

  // 自定义 Provider 模块优先（仅普通自定义端点；custom:<模型名> 走 OpenAI 兼容直连）
  const customFile = customProviderFile(pc.name); // R4：见上方说明（白名单 + 包含性检查）
  if (customFile && pc.isCustom && !pc.name.includes(':') && fs.existsSync(customFile)) {
    // v0.6.7（报告一 M-13）：此前是 `?v=${Date.now()}` ——**每次建 provider 都换一个 URL**，
    // 而 ESM 缓存按 URL 计：长驻 WebUI 里模块实例无限累积、顶层代码反复执行。
    // 改成按 **mtime** 作版本键（同文件里 visionProbeCache 已是这个方案）：文件没改就复用同一实例，
    // 改了才重新 import。
    let ver = '0';
    try {
      ver = String(Math.round(fs.statSync(customFile).mtimeMs));
    } catch {}
    const mod = await import(pathToFileURL(customFile).href + `?v=${ver}`);
    if (typeof mod.createProvider !== 'function') {
      throw new Error(`自定义 Provider 模块 ${customFile} 未导出 createProvider(cfg)。`);
    }
    const custom = await mod.createProvider(pc);
    return { ...custom, name: pc.name, config: pc };
  }

  if (!pc.baseUrl) {
    throw new Error(`服务商 "${pc.name}" 缺少 baseUrl，请运行 mingdao init 重新配置。`);
  }

  // v0.3.2 本地模型自适应：本地推理框架（CPU/GPU 有限）长上下文 prefill 极慢（诊断实测 127k 上下文
  // 首 token 需 196s+，q8 dequant 下 prefill 仅 ~165 tok/s）。默认超时按是否本地分层：
  //  - 首 token 等待：本地 600s / 远程 300s（覆盖慢 prefill，而非 189s 被掐断）
  //  - 流式空闲：有帧后 120s 无新帧即断（真正挂死才断，慢速吐字不误杀）
  //  - 总量：本地 30min / 远程 10min（长生成不误杀）
  // 均可用 cfg.timeout.firstTokenMs / streamIdleMs / totalMs 覆盖。
  const isLocal = isLocalBaseUrl(pc.baseUrl);
  const tCfg = cfg?.timeout || {};
  const firstTokenMs = Number(tCfg.firstTokenMs) > 0 ? Number(tCfg.firstTokenMs) : (isLocal ? 600000 : 300000);
  const streamIdleMs = Number(tCfg.streamIdleMs) > 0 ? Number(tCfg.streamIdleMs) : 120000;
  const totalMs = Number(tCfg.totalMs) > 0 ? Number(tCfg.totalMs) : (Number(timeoutMs) > 0 ? Number(timeoutMs) : (isLocal ? 1800000 : 600000));

  return {
    name: pc.name,
    config: pc,
    async chat(/** @type {any} */ opts) {
      let attempt = 0;
      // P1-7（v0.4.5）：总量护栏提到重试循环外层——此前每 attempt 重建 totalTimer，重试序列最坏
      // 放大 retries+1 倍（本地 3×30min=90min）。总时长覆盖整个重试序列，单次首 token/流式空闲仍按 attempt 计。
      let totalExpired = false;
      let currentAc = /** @type {AbortController | null} */ (null);
      const totalTimer = setTimeout(() => {
        totalExpired = true;
        try {
          currentAc?.abort(new Error(`请求总时长超限（${Math.round(totalMs / 1000)}s），已中断`));
        } catch {}
      }, totalMs);
      for (;;) {
        // v0.6.3（BUG-029）：**循环头**必须复查总量护栏。原实现只在 catch 里判 transient 时看
        // totalExpired，于是"总量计时器在退避 sleep 期间触发"这条路径会照常发起新 attempt
        // （重试序列最坏比声明的总时长更久，且用户按了中断也还可能再发一次）。
        if (totalExpired) {
          throw new Error(`请求总时长超限（${Math.round(totalMs / 1000)}s），已中断（不再重试）`);
        }
        const ac = new AbortController();
        currentAc = ac;
        // 转发外部信号（用户 Ctrl+C 中断），避免被内部超时信号覆盖。
        // 必须在**排队之前**挂上：否则用户中断时请求仍卡在本地端点队列里。
        const onUserAbort = () => ac.abort(opts.signal?.reason);
        if (opts.signal?.aborted) onUserAbort();
        else opts.signal?.addEventListener('abort', onUserAbort, { once: true });
        let timedOut = false; // 审计 P2-6：用标志而非 name/字符串匹配识别内部超时（首 token/流式空闲）
        let firstTokenTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
        let idleTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
        let leaving = true; // 本次 attempt 是否退出（成功/不再重试）；将重试则置 false，总量计时器保留覆盖下一 attempt
        // v0.6.3（BUG-028）：**收到过任何一帧就不再重试**。chat 是**非幂等**的 POST：
        // 上游一旦开始生成按量计费，重试等于再买一次（用户只看到一份回答、账本却计两次）。
        // 判据取"有没有帧到达"而不是"有没有正文"——usage-only/角色帧同样说明请求已被受理。
        // 代价如实说明：流式空闲超时（已开始输出）不再重试，失败以错误形式回到用户手里，而不是悄悄多花一份钱。
        let sawFrame = false;
        let releaseLocal = /** @type {null | (() => void)} */ (null);
        try {
          // v0.6.15（§3.59）：**本地端点并发闸门**——同一 baseUrl 的父回合 / 子代理 / 预检
          // 共用一条进程级 Promise 队列（默认 1 并发）。真机 8081：父子回合同时 prefill 时
          // 引擎报 "insufficient memory … engine shed its caches and stays up"。
          // 必须在**首 token 计时之前**排队：排队是内核自己的调度，不是"引擎迟迟不出首帧"。
          // 云端端点由 acquireLocalSlot 内部直接放行（不排队、不记日志、不加延迟）。
          releaseLocal = await acquireLocalSlot(pc.baseUrl, {
            // v0.6.18 §3.74：内存降级重试时 agent 传 localConcurrency=1，**临时把该端点压回单并发**
            // （即便用户把 config.localConcurrency 配成 0/2）——重试期间不允许父回合/子代理再同时 prefill。
            cfg: opts.localConcurrency != null ? { ...cfg, localConcurrency: opts.localConcurrency } : cfg,
            signal: ac.signal,
            onWait: opts.onQueueWait,
            endpoint: pc.name || pc.baseUrl,
            label: modelName,
          });
          // 排队期间总量计时器可能已经到点：它会 abort 本 attempt 的 ac（见 totalTimer），
          // 排队等待因此以「请求总时长超限」拒绝（acquireLocalSlot 透传 signal.reason）；
          // 这里**不再写一份重复的复查**——循环头那一处是 BUG-029 的单一判据（§119 钉住）。
          // 首 token 等待：prefill 阶段无任何帧到达即断（覆盖长上下文慢 prefill）
          firstTokenTimer = setTimeout(() => {
            timedOut = true;
            ac.abort(new Error(`首 token 等待超限（${Math.round(firstTokenMs / 1000)}s，本地模型长上下文 prefill 可能很慢）——可调大 config.timeout.firstTokenMs，或拆分任务/压缩上下文`));
          }, firstTokenMs);
          // 流式空闲：有帧后 120s 无新帧即断；每收到一帧重置
          const armIdle = () => {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
              timedOut = true;
              ac.abort(new Error(`流式响应空闲超限（${Math.round(streamIdleMs / 1000)}s 无新数据）`));
            }, streamIdleMs);
          };
          const onActivity = () => {
            sawFrame = true;
            if (firstTokenTimer) {
              clearTimeout(firstTokenTimer);
              firstTokenTimer = null;
            }
            armIdle();
          };
          return await openaiChat({
            ...opts,
            baseUrl: pc.baseUrl,
            apiKey: pc.apiKey,
            signal: ac.signal,
            includeUsage: cfg?.includeUsage !== false,
            onActivity,
          });
        } catch (err) {
          // 内部超时经 abort 抛出，用标志识别（审计 P2-6）；用户 Ctrl+C 的中断不算超时、不重试。
          // 总量超时（totalExpired）覆盖整个序列，超了直接抛不再重试。
          // 排队超时（LOCAL_QUEUE_TIMEOUT）**不得**重试：重试只会再排一次队、把等待翻倍。
          const queueTimeout = (/** @type {any} */ (err))?.code === 'LOCAL_QUEUE_TIMEOUT';
          const transient = !totalExpired && !queueTimeout && !sawFrame && ((timedOut && !opts.signal?.aborted) || isTransient(err));
          if (!transient || attempt >= retries) throw err;
          leaving = false; // 将重试：本次不退出，总量计时器继续覆盖下一 attempt
          attempt += 1;
          // 首 token 等待超时通常不是偶发网络抖动（是模型/上下文慢），重试价值低但保留一次机会；
          // 其余瞬态错误指数退避 + 尊重 Retry-After（评估 P3-1）：基础 1s/2s，封顶 30s
          let backoff = 1000 * attempt;
          const ra = Number((/** @type {any} */ (err))?.headers?.get?.('retry-after'));
          if (Number.isFinite(ra) && ra > 0) backoff = Math.max(backoff, ra * 1000);
          backoff = Math.min(backoff, 30000);
          await sleep(backoff, opts.signal); // BUG-030：可被 Ctrl+C 打断
        } finally {
          if (leaving) clearTimeout(totalTimer); // 成功/最终失败即清——避免悬挂 totalMs 计时器（每请求一个）
          if (firstTokenTimer) clearTimeout(firstTokenTimer);
          if (idleTimer) clearTimeout(idleTimer);
          opts.signal?.removeEventListener('abort', onUserAbort);
          // 名额必须在这里释放（成功/失败/超时/中断都走 finally），否则队列会永久卡住。
          try { releaseLocal?.(); } catch {}
        }
      }
    },
  };
}

// 辅助调用（标题生成/记忆提取等）的 provider 解析（评估 P2-2）：辅助模型与当前模型
// 分属不同服务商时单独创建 provider——避免拿 deepseek-v4-flash 模型名去自定义网关请求
// 而 404 被静默吞掉（标题缺失、记忆永不沉淀且零感知）。
export async function helperProvider(/** @type {any} */ cfg, /** @type {any} */ helperModel, /** @type {any} */ currentProvider) {
  try {
    const curName = String(currentProvider?.name || '');
    const helperName = String(resolveProviderConfig(cfg, helperModel)?.name || '');
    if (curName && curName === helperName) return currentProvider;
  } catch {}
  try {
    return await createProvider(cfg, helperModel);
  } catch {
    return currentProvider;
  }
}
