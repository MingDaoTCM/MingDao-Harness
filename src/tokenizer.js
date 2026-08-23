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

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let data = null;
let loadError = null;

function loadData() {
  if (data || loadError) return data;
  try {
    const file = fileURLToPath(new URL('../assets/tokenizer-data.json.gz', import.meta.url));
    const raw = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
    const parsed = JSON.parse(raw);
    const mergeRank = new Map();
    for (let i = 0; i < parsed.merges.length; i++) {
      const [a, b] = parsed.merges[i];
      mergeRank.set(a + '\u0001' + b, i);
    }
    const added = (parsed.added || []).filter(Boolean).sort((a, b) => b.length - a.length);
    // 全部 added token 合并成单个正则（按长度降序排列 → 左起最长优先，与逐 token startsWith 语义一致），
    // 一次 matchAll 定位所有特殊 token，把 O(文本长 × 818 个 indexOf) 降到 O(n)
    const addedRe = added.length ? new RegExp(added.map(escapeRe).join('|'), 'gu') : null;
    data = { mergeRank, added, addedRe };
  } catch (err) {
    loadError = err;
  }
  return data;
}

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
const isCjk = (code) => CJK_RANGES.some(([lo, hi]) => code >= lo && code <= hi);

export function heuristicTokens(text) {
  if (!text) return 0;
  let ascii = 0;
  let cjk = 0;
  let other = 0;
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (code < 128) ascii += 1;
    else if (isCjk(code)) cjk += 1;
    else other += code > 0xffff ? 2 : 1; // 审计 B5：增补平面 emoji 按 2 token 保守计
  }
  // 审计 B5：非 CJK 非 ASCII（emoji 等）按码点计但每个 2 个 UTF-16 单元的 emoji 计 2，
  // 避免对预算的过度乐观（ZWJ 序列仍可能低估，但方向已保守）
  return Math.ceil(ascii / 4 + cjk * 0.75 + other);
}

// 单个预分词片段的 BPE 计数（tiktoken 语义：优先合并 rank 最小的对，同 rank 取最左）。
// 惰性最小堆实现（O(n log n)）：大文本（中文长文/工具输出）不再 O(n²) 全表扫描。
function countPiece(piece, d) {
  const bytes = Buffer.from(piece, 'utf8');
  const syms = [];
  for (const b of bytes) syms.push(BYTE_TO_UNICODE[b]); // 与词表同表示（GPT-2 字节映射）
  if (syms.length <= 1) return syms.length;

  const alive = new Uint8Array(syms.length).fill(1);
  const leftOf = (i) => {
    for (let j = i - 1; j >= 0; j--) if (alive[j]) return j;
    return -1;
  };
  const rightOf = (i) => {
    for (let j = i + 1; j < syms.length; j++) if (alive[j]) return j;
    return -1;
  };

  // 最小堆（rank, leftIndex）；过期条目惰性丢弃/重推
  const heap = [];
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

function countGap(piece, d) {
  let total = 0;
  for (const m of pretokenize(piece)) total += countPiece(m, d);
  return total;
}

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
  if (byModel.size >= TOKEN_CACHE_MAX_ENTRIES) byModel.clear();
  byModel.set(s, n);
  return n;
}

// 供上下文预算使用的计数器工厂
export function makeTokenCounter(modelName) {
  if (isTokenizable(modelName)) {
    return (text) => countTokens(text, modelName);
  }
  return (text) => heuristicTokens(text);
}
