// 精确 tokenizer（零运行时依赖）：
//  - 内置 DeepSeek 官方词表（assets/tokenizer-data.json.gz，源自 DeepSeek-V3 tokenizer.json）
//  - 字节级 BPE 计数：added_tokens 合并正则一次扫描（O(n)，替代逐 token indexOf）+ 官方 Split 预分词 + 按 rank 合并
//  - 非 DeepSeek 模型回退启发式估算（英文≈4字符/token，CJK≈0.75 token/字，其余非 ASCII≈1）
//  - 内容级计数缓存：同一文本（如多轮不变的会话消息）只做一次 BPE，重复调用 O(1) 命中
// 仅用于上下文预算计数，不输出 token id。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { mingdaoHome } from './config.js';

// DeepSeek 官方预分词（tokenizer.json 的 Split 序列，与 HF tokenizers 语义一致）：
//   1. \p{N}{1,3}               数字按 1–3 位切成独立段
//   2. [一-龥぀-ゟ゠-ヿ]+        中日韩表意文字/假名连续段
//   3. 标点引导的词｜字母段（可带一个前导非字母）｜标点串｜换行｜空白
// 每级 Split(Isolated) 对上一级全部片段再切分，匹配段与间隔段都保留为独立预分词。
const SPLIT_RES = [
  /\p{N}{1,3}/gu,
  /[一-龥぀-ゟ゠-ヿ]+/gu,
  /[!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~][A-Za-z]+|[^\r\n\p{L}\p{P}\p{S}]?[\p{L}\p{M}]+| ?[\p{P}\p{S}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu,
];

/** @param {string} text */
function pretokenize(text) {
  let pieces = [text];
  for (const re of SPLIT_RES) {
    const next = [];
    for (const p of pieces) {
      let last = 0;
      for (const m of p.matchAll(re)) {
        if (m.index > last) next.push(p.slice(last, m.index));
        if (m[0]) next.push(m[0]);
        last = m.index + m[0].length;
      }
      if (last < p.length) next.push(p.slice(last));
    }
    pieces = next;
  }
  return pieces;
}

// GPT-2 字节到 Unicode 的映射表（byte_to_unicode）。
// HF tokenizer.json 的 merges/vocab 使用映射后的可打印字符表示：
// 可打印区间（0x21-0x7E、0xA1-0xAC、0xAE-0xFF）映射为自身，
// 其余字节（控制符、空格、0x7F-0xA0、0xAD）依次映射到 U+0100+n。
// 运行时符号必须与词表同表示，否则 73% 的 merge 对（含映射字符）永远匹配不到，
// 汉字会退化为逐字节计数（如「的」被计为 3 tokens 而非 1）。
const BYTE_TO_UNICODE = (() => {
  const m = new Array(256);
  /** @param {number} b */
  const self = (b) => (b >= 0x21 && b <= 0x7e) || (b >= 0xa1 && b <= 0xac) || (b >= 0xae);
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (self(b)) m[b] = String.fromCharCode(b);
    else {
      m[b] = String.fromCharCode(256 + n);
      n += 1;
    }
  }
  return m;
})();

/** @param {string} s */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// v0.6.2（第三方报告 B-TOK-1「词表永不重试」）：**实测确认**原实现是
//   if (data || loadError) return data;
// 于是**一次读失败就终生锁死**：之后每次计数都走启发式估算（本文件自己写明误差可达 ±2 倍），
// 而用户**完全看不到**——预算裁剪、上下文压缩、费用估算全都悄悄偏了。
// 同一个文件里 customTokenizerNames() 的注释明确写着「下次重试」，这条路径却违反了它。
//
// 现在按错误性质区分：
//   · 词表文件**不存在**（ENOENT）：一次读不到就别每步都去 stat，latch 住不再重试；
//   · 其余（EBUSY/EAGAIN/EMFILE/权限/瞬时 IO）：**允许重试**，并带一个冷却窗口避免每步重试；
//   · 无论哪种，降级都**说出来一次**（含后果与修法），不再无声。
/** @type {any} */
let data = null;
/** @type {any} */
let loadError = null;
let loadErrorCode = /** @type {string|null} */ (null);
let lastAttemptAt = 0;
let degradedWarned = false;
/** 重试冷却（毫秒）：避免"每步都重试一次失败读盘"。
 *  可用 MINGDAO_TOKENIZER_RETRY_MS 覆盖——诊断时可调小以便"修好后立刻自愈"，
 *  也让测试能在秒级内验证「冷却过后**自动**重试」（60 秒的默认值没法测）。 */
const RETRY_COOLDOWN_MS = (() => {
  const v = Number(process.env.MINGDAO_TOKENIZER_RETRY_MS);
  return Number.isFinite(v) && v >= 0 ? v : 60_000;
})();

/** 词表是否已降级为启发式估算（true 时预算/费用口径不精确）。 */
export function tokenizerDegraded() {
  return data === null;
}
/** 词表读取失败的原因（无则 null）。 */
export function tokenizerLoadError() {
  return loadError ? String(/** @type {any} */ (loadError)?.message ?? loadError) : null;
}
/**
 * 强制重新从磁盘加载词表（清掉已加载数据、失败状态与冷却窗口）。
 * 给「修好之后主动重试」用（`mingdao doctor` 之类）；也让测试能复现"加载失败→修复→恢复"整条链
 * ——只清 error 不清 data 的话，一旦加载成功就再也触发不了失败路径。
 */
export function resetTokenizerState() {
  data = null;
  loadError = null;
  loadErrorCode = null;
  lastAttemptAt = 0;
}

function loadData() {
  if (data) return data;
  // 已判定"文件不存在"：不再重试（也没必要每步 stat 一次）
  if (loadError && loadErrorCode === 'ENOENT') return data;
  // 其它错误：冷却窗口内不重试，过了就再试一次
  if (loadError && Date.now() - lastAttemptAt < RETRY_COOLDOWN_MS) return data;
  lastAttemptAt = Date.now();
  try {
    const file = fileURLToPath(new URL('../assets/tokenizer-data.json.gz', import.meta.url));
    const raw = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
    const parsed = JSON.parse(raw);
    const mergeRank = new Map();
    for (let i = 0; i < parsed.merges.length; i++) {
      const [a, b] = parsed.merges[i];
      mergeRank.set(a + '\u0001' + b, i);
    }
    const added = (parsed.added || []).filter(Boolean).sort((/** @type {any} */ a, /** @type {any} */ b) => b.length - a.length);
    // 全部 added token 合并成单个正则（按长度降序排列 → 左起最长优先，与逐 token startsWith 语义一致），
    // 一次 matchAll 定位所有特殊 token，把 O(文本长 × 818 个 indexOf) 降到 O(n)
    const addedRe = added.length ? new RegExp(added.map(escapeRe).join('|'), 'gu') : null;
    data = { mergeRank, added, addedRe };
    loadError = null;
    loadErrorCode = null;
  } catch (err) {
    loadError = err;
    loadErrorCode = String(/** @type {any} */ (err)?.code ?? '') || null;
    // 一次说清后果与修法；不刷新（冷却窗口内的重试失败不再重复打印）
    if (!degradedWarned) {
      degradedWarned = true;
      console.warn(
        `[MingDao] ⚠ 官方词表加载失败：${String(/** @type {any} */ (err)?.message ?? err)}\n` +
          `  token 计数已回退为**启发式估算**（本文件校准值误差可达 ±2 倍）——上下文预算、自动压缩与费用估算都会偏。\n` +
          `  修法：确认 assets/tokenizer-data.json.gz 存在且可读（重装或 npm i mingdao-harness 可修复）。`
      );
    }
  }
  return data;
}

/** @param {any} modelName */
export function isTokenizable(modelName) {
  if (typeof modelName !== 'string') return false;
  if (modelName.startsWith('deepseek')) return true;
  // B8（评估建议）：自定义端点跑 DeepSeek 系模型时，config.customModels.<name>.tokenizer = "deepseek"
  // 即可按官方词表精确计数（否则回退启发式，预算误差可达 ±2 倍）
  return customTokenizerNames().has(modelName);
}

// 配置按 mtime 缓存：避免每次计数都读盘解析 config.json
let customTokCache = { mtime: 0, names: new Set() };
function customTokenizerNames() {
  try {
    const file = path.join(mingdaoHome(), 'config.json');
    const st = fs.statSync(file);
    if (st.mtimeMs === customTokCache.mtime) return customTokCache.names;
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const names = new Set();
    for (const [n, c] of Object.entries(cfg?.customModels || {})) {
      if (c && c.tokenizer === 'deepseek') names.add(n);
    }
    customTokCache = { mtime: st.mtimeMs, names };
  } catch {
    // 无配置/解析失败 → 保持空集合（下次重试）
  }
  return customTokCache.names;
}

// 启发式估算（无词表模型的回退路径）。
// CJK 校准：主流模型流畅中文实测 ≈0.5–0.75 token/字（词表含多字词），
// 旧版「1 字 = 1 token」会高估约 2 倍、过早触发预算裁剪；取 0.75 保守上界。
// 其余非 ASCII（emoji/符号）保持 1（多数词表下单个 emoji 常为 2–3 token，不低估）。
const CJK_RANGES = [
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff], // CJK 扩展/基本区/兼容
  [0x3040, 0x30ff], [0xac00, 0xd7af], // 假名 / 谚文
];
/** @param {number} code */
const isCjk = (code) => CJK_RANGES.some(([lo, hi]) => code >= lo && code <= hi);

// 启发式估算（无精确词表的模型：非 DeepSeek 端点）——用于上下文预算/裁剪/批量超窗口预检。
//
// P1 修复（v0.4.6）：原实现只按「ASCII 字符数 / 4」算，对**非自然语言**的 ASCII 严重低估——
// 实测纯标点 0.34×、单字母词 0.50×、随机字母数字 0.50×、纯数字 0.75×（10 类样本 6 类偏低）。
// 而 docs/SAVINGS-BENCHMARK 与 bench-savings 一直声称它是「保守上界」，属虚假保证：
// 非 DeepSeek 模型的预算/压缩/批量预检会系统性偏小，长上下文可能顶穿模型窗口。
// 现改为按「字符类别 + 连续串」估算，并把标点与数字两类单独收紧（这两类是最大缺口）。
// 诚实边界：BPE 词表会合并常用英文词（"hello" = 1 token），而随机字母串约 1.7 字符/token——
// 任何字符级启发式都无法同时满足两者，因此**随机字母串仍可能被低估**。真正的兜底是 agent 的
// 「边缘检测」：用服务端回传的真实 prompt_tokens 判断逼近窗口并强制压缩（EDGE_RATIO）。
/** @param {any} text */
export function heuristicTokens(text) {
  if (!text) return 0;
  const s = String(text);
  const n = s.length;
  let tokens = 0;
  let i = 0;
  while (i < n) {
    const code = /** @type {number} */ (s.codePointAt(i));
    if (code < 128) {
      const ch = s[i];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        let j = i;
        while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\r')) j += 1;
        tokens += Math.floor((j - i) / 8); // 空白多与相邻词合并且成串极便宜（单个空格按 0 计，不重复计词）
        i = j;
        continue;
      }
      if (ch >= '0' && ch <= '9') {
        let j = i;
        while (j < n && s[j] >= '0' && s[j] <= '9') j += 1;
        tokens += Math.ceil((j - i) / 2); // 实测纯数字约 0.34 token/字符，1/2 留余量
        i = j;
        continue;
      }
      if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')) {
        let j = i;
        while (j < n && /[A-Za-z]/.test(s[j])) j += 1;
        tokens += Math.max(1, Math.floor((j - i) / 4)); // 至少 1：单字母成词也是 1 token
        i = j;
        continue;
      }
      tokens += 1; // 标点/符号：词表合并极少（实测纯标点约 0.71 token/字符），按 1:1 保守计
      i += 1;
      continue;
    }
    const step = String.fromCodePoint(code).length;
    if (isCjk(code)) tokens += 0.75;
    else tokens += code > 0xffff ? 2 : 1; // 审计 B5：增补平面 emoji 按 2 token 保守计
    i += step;
  }
  return Math.ceil(tokens);
}

// 单个预分词片段的 BPE 计数（tiktoken 语义：优先合并 rank 最小的对，同 rank 取最左）。
// 惰性最小堆实现（O(n log n)）：大文本（中文长文/工具输出）不再 O(n²) 全表扫描。
/** @param {any} piece @param {any} d */
function countPiece(piece, d) {
  const bytes = Buffer.from(piece, 'utf8');
  const syms = [];
  for (const b of bytes) syms.push(BYTE_TO_UNICODE[b]); // 与词表同表示（GPT-2 字节映射）
  if (syms.length <= 1) return syms.length;

  const alive = new Uint8Array(syms.length).fill(1);
  /** @param {number} i */
  const leftOf = (i) => {
    for (let j = i - 1; j >= 0; j--) if (alive[j]) return j;
    return -1;
  };
  /** @param {number} i */
  const rightOf = (i) => {
    for (let j = i + 1; j < syms.length; j++) if (alive[j]) return j;
    return -1;
  };

  // 最小堆（rank, leftIndex）；过期条目惰性丢弃/重推
  /** @type {any[]} */
  const heap = [];
  /** @param {number} rank @param {number} idx */
  const push = (rank, idx) => {
    heap.push([rank, idx]);
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (heap[p][0] < heap[c][0] || (heap[p][0] === heap[c][0] && heap[p][1] <= heap[c][1])) break;
      [heap[p], heap[c]] = [heap[c], heap[p]];
      c = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let c = 0;
      for (;;) {
        const l = c * 2 + 1;
        const r = l + 1;
        let m = c;
        /** @param {number} x */
        const better = (x) => heap[x][0] < heap[m][0] || (heap[x][0] === heap[m][0] && heap[x][1] < heap[m][1]);
        if (l < heap.length && better(l)) m = l;
        if (r < heap.length && better(r)) m = r;
        if (m === c) break;
        [heap[m], heap[c]] = [heap[c], heap[m]];
        c = m;
      }
    }
    return top;
  };

  for (let i = 0; i < syms.length - 1; i++) {
    const r = d.mergeRank.get(syms[i] + '\u0001' + syms[i + 1]);
    if (r !== undefined) push(r, i);
  }

  for (;;) {
    let pair = null;
    while (heap.length) {
      const [rank, idx] = pop();
      if (!alive[idx]) continue;
      const right = rightOf(idx);
      if (right === -1) continue;
      const r = d.mergeRank.get(syms[idx] + '\u0001' + syms[right]);
      if (r === undefined) continue;
      if (r === rank) {
        pair = [idx, right];
        break;
      }
      push(r, idx); // rank 过期（邻居变化）：重推
    }
    if (!pair) break;
    const [li, ri] = pair;
    syms[li] = syms[li] + syms[ri];
    alive[ri] = 0;
    const left = leftOf(li);
    if (left !== -1) {
      const r = d.mergeRank.get(syms[left] + '\u0001' + syms[li]);
      if (r !== undefined) push(r, left);
    }
    const right = rightOf(li);
    if (right !== -1) {
      const r = d.mergeRank.get(syms[li] + '\u0001' + syms[right]);
      if (r !== undefined) push(r, li);
    }
  }
  return alive.reduce((s, v) => s + v, 0);
}

// 内容级计数缓存（modelName → 文本 → token 数）：多轮会话中历史消息内容不变，
// 每步 trimMessages 重复计数同一文本时直接命中。上限保护：超长文本不进缓存、
// 每模型 512 条封顶（溢出整体清空，简单 LRU 退化策略）。
const TOKEN_CACHE_MAX_ENTRIES = 512;
const TOKEN_CACHE_MAX_LEN = 50000;
const tokenCache = new Map();

/** @param {string} s */
function countDeepseek(s) {
  const d = loadData();
  if (!d) return heuristicTokens(s); // 词表缺失时优雅回退
  let total = 0;
  let pos = 0;
  if (d.addedRe) {
    for (const m of s.matchAll(d.addedRe)) {
      if (m.index > pos) total += countGap(s.slice(pos, m.index), d);
      total += 1; // added token 自身计 1
      pos = m.index + m[0].length;
    }
  }
  if (pos < s.length) total += countGap(s.slice(pos), d);
  return total;
}

/** @param {any} piece @param {any} d */
function countGap(piece, d) {
  let total = 0;
  for (const m of pretokenize(piece)) total += countPiece(m, d);
  return total;
}

/** @param {any} text @param {any} modelName */
export function countTokens(text, modelName) {
  if (!text) return 0;
  const s = String(text);
  if (!isTokenizable(modelName)) return heuristicTokens(s);
  if (s.length > TOKEN_CACHE_MAX_LEN) return countDeepseek(s);
  let byModel = tokenCache.get(modelName);
  if (!byModel) {
    byModel = new Map();
    tokenCache.set(modelName, byModel);
  }
  const hit = byModel.get(s);
  if (hit !== undefined) return hit;
  const n = countDeepseek(s);
  if (byModel.size >= TOKEN_CACHE_MAX_ENTRIES) byModel.delete(byModel.keys().next().value); // LRU：删最旧（Map 迭代序）
  byModel.set(s, n);
  return n;
}

// 供上下文预算使用的计数器工厂
/** @param {any} modelName */
// v0.6.2（第三方 audit-report 的 B-CT-1，实测后按其真实影响处理）：
// 该报告称 WeakMap 消息级 token 缓存「**永远** miss、每步全量 BPE」——**实测不成立**：
// 同一计数器下 200 次调用耗时 0.0ms（缓存命中），失效只发生在「计数器函数对象被重建」时。
// 但这里原来每次都 `return (text) => countTokens(...)`，**每次调用都产生新函数对象**，
// 于是 context.js 的缓存守卫 `hit.fn === count` 在跨实例/跨回合时必然失配、白算一遍。
// 按模型名缓存计数器即可让 identity 稳定（模型名数量有限，不会无界增长）。
/** @type {Map<string, (text: any) => number>} */
const tokenCounterCache = new Map();

export function makeTokenCounter(/** @type {any} */ modelName) {
  const key = String(modelName ?? '');
  const cached = tokenCounterCache.get(key);
  if (cached) return cached;
  const fn = isTokenizable(key)
    ? (/** @type {any} */ text) => countTokens(text, key)
    : (/** @type {any} */ text) => heuristicTokens(text);
  tokenCounterCache.set(key, fn);
  return fn;
}
