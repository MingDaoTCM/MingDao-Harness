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
const PROBE_TTL_MS = 10 * 60 * 1000;
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
 *   toolState    'stable-tools' | 'unstable-tools' | 'no-tools' | 'unknown'（细三态，N/3）
 *   toolCallHits / toolCallRuns        命中次数 / 实际样本数
 *   ttftMs       三次小请求的首帧中位数（ms）
 *   prefillMs    参考 prefill（prefillTokens 个 token）的耗时（ms）
 *   baseline / slowdown                历史基线（持久化在 <home>/model-probe.json）与本次倍数
 *   nameMismatch / loadedModel         引擎实际加载的模型名与配置项名是否对不上
 *   note         一行给人看的结论（UI + web-server.log 直接用）
 *
 * @param {any} cfg @param {string} modelName
 * @param {{ timeoutMs?: number, force?: boolean, fetchImpl?: any, repeats?: number,
 *           prefillTokens?: number, budgetMs?: number, persist?: boolean }} [opts]
 */
export async function probeEndpoint(/** @type {any} */ cfg, /** @type {string} */ modelName, opts = {}) {
  const {
    timeoutMs = 10000,
    force = false,
    fetchImpl = null,
    repeats = 3,
    prefillTokens = 2000,
    budgetMs = 35000,
    persist = true,
  } = opts;
  const pc = /** @type {any} */ (resolveProviderConfig(cfg, modelName) || {});
  const base = String(pc.baseUrl || '').replace(/\/+$/, '');
  const key = `${base}|${modelName}`;
  const hit = probeCache.get(key);
  if (!force && hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.value;
  if (!force && probeInflight.has(key)) return probeInflight.get(key);
  const doFetch = fetchImpl || globalThis.fetch;
  const run = (async () => {
    const startedAt = Date.now();
    const left = () => Math.max(1500, Math.min(timeoutMs, budgetMs - (Date.now() - startedAt)));
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
      error: /** @type {string|null} */ (null),
      note: '',
      partial: false,
    });
    if (!base) {
      return { ...info, error: '该模型没有可用的 baseUrl（未配置端点）', note: '端点未配置：请先在 ⚙ 设置里填 baseUrl/API Key。' };
    }
    const headers = { 'Content-Type': 'application/json', ...(pc.apiKey ? { Authorization: `Bearer ${pc.apiKey}` } : {}) };
    /** 单次 HTTP（带超时）；返回 { ok, status, text } 或抛错 */
    const once = async (/** @type {any} */ url, /** @type {any} */ init, /** @type {any} */ ms) => {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(new Error(`预检超时（${Math.round(ms / 1000)}s）`)), ms);
      try {
        return await fetchImplOr(doFetch, url, { ...init, signal: ac.signal });
      } finally {
        clearTimeout(t);
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
    let lastError = /** @type {string|null} */ (null);
    let connected = false;
    for (let i = 0; i < Math.max(1, repeats); i++) {
      if (Date.now() - startedAt > budgetMs) { info.partial = true; break; }
      const t0 = Date.now();
      try {
        const res = await once(
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
          left()
        );
        connected = true;
        if (!res || !res.ok) {
          const status = Number(res?.status) || 0;
          let detail = '';
          try { detail = String(await res.text()).slice(0, 300); } catch {}
          lastError = `HTTP ${status || '（无响应）'}${detail ? `：${detail}` : ''}`;
          info.toolCallFinishes.push(`http-${status}`);
          continue;
        }
        const r = await readProbeStream(res, { hasTool: chunkHasTool, t0 });
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
        lastError = String(e?.name === 'AbortError' || /aborted/i.test(String(e?.message)) ? `预检超时（${Math.round(left() / 1000)}s 内没有任何响应）` : e?.message || e);
        info.toolCallFinishes.push('error');
      }
    }
    if (!connected) {
      info.state = 'unreachable';
      info.error = lastError || '连接失败';
      info.note = `❌ 不可达：${info.error}${info.isLocal ? '（本地引擎没起来？先确认端口/进程）' : ''}`;
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
          const res = await once(u, { method: 'GET', headers }, Math.min(5000, left()));
          if (!res || !res.ok) continue;
          const raw = String(await res.text()).slice(0, 65536);
          const ctx = engineContextFromProps(JSON.parse(raw));
          if (ctx != null) {
            info.engineCtx = ctx;
            info.engineCtxSource = u;
            break;
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
    // ③ 参考 prefill：固定 ~2000 tokens 的**每次不同**前缀（防引擎前缀缓存把耗时抹平）
    {
      const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const filler = Array.from({ length: Math.max(8, Math.round(prefillTokens / 4)) }, (_, i) => `第${i}段：${nonce}`).join('；');
      const t0 = Date.now();
      try {
        const res = await once(
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
          Math.min(20000, left())
        );
        if (res && res.ok) {
          const r = await readProbeStream(res, { hasTool: chunkHasTool, t0 });
          if (r.model && !info.loadedModel) {
            info.loadedModel = String(r.model);
            info.loadedModels = [String(r.model)];
            info.nameMismatch = modelNameMismatch(modelName, [String(r.model)]);
          }
          info.prefillMs = r.ttftMs ?? Date.now() - t0;
        } else {
          info.prefillMs = null;
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
              `——多为"被 max_tokens 截断"（思考型模型先输出思考）或请求异常${lastError ? `：${lastError}` : ''}；` +
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
    info.note = `${toolNote} · ${ttftNote} · ${prefillNote}${info.partial ? ' ·（预检超过时间预算，样本未跑满）' : ''} · ${nameNote} · ${engineNote}${slowNote}`;
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
 *  会把"引擎排队 + prefill"整段抹掉（实测过：真值 120ms 会被量成 0ms）。 */
async function readProbeStream(/** @type {any} */ res, /** @type {{ hasTool: (s: string) => boolean, t0: number }} */ { hasTool, t0 }) {
  let ttftMs = /** @type {number|null} */ (null);
  let toolCalls = false;
  let finish = /** @type {string|null} */ (null);
  let model = /** @type {string|null} */ (null);
  const reader = res?.body?.getReader?.();
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
  } catch {
    /* 读失败按"没拿到结论"处理（上层按 unreachable/unknown 归类） */
  }
  try { reader.cancel(); } catch {}
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
