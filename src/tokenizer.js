// 精确 tokenizer（零运行时依赖）：
//  - 内置 DeepSeek 官方词表（assets/tokenizer-data.json.gz，源自 DeepSeek-V3 tokenizer.json）
//  - 字节级 BPE 计数：added_tokens 最长优先匹配 + GPT-4 风格预分词 + 按 rank 合并（tiktoken 语义）
//  - 非 DeepSeek 模型回退启发式估算（英文≈4字符/token，CJK≈1字符/token）
// 仅用于上下文预算计数，不输出 token id。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

// GPT-4 家族字节级 BPE 的预分词正则（DeepSeek tokenizer 同源）
const PRETOK = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

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
    data = {
      mergeRank,
      added: (parsed.added || []).sort((a, b) => b.length - a.length),
    };
  } catch (err) {
    loadError = err;
  }
  return data;
}

export function isTokenizable(modelName) {
  return typeof modelName === 'string' && modelName.startsWith('deepseek');
}

// 启发式估算（无词表模型的回退路径）
export function heuristicTokens(text) {
  if (!text) return 0;
  let ascii = 0;
  let cjk = 0;
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (code < 128) ascii += 1;
    else cjk += 1;
  }
  return Math.ceil(ascii / 4) + cjk;
}

// 单个预分词片段的 BPE 计数（tiktoken 语义：优先合并 rank 最小的对）
function countPiece(piece, d) {
  const bytes = Buffer.from(piece, 'utf8');
  const syms = [];
  for (const b of bytes) syms.push(String.fromCharCode(b));
  for (;;) {
    let bestIdx = -1;
    let bestRank = Infinity;
    for (let i = 0; i < syms.length - 1; i++) {
      const r = d.mergeRank.get(syms[i] + '\u0001' + syms[i + 1]);
      if (r !== undefined && r < bestRank) {
        bestRank = r;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break;
    syms.splice(bestIdx, 2, syms[bestIdx] + syms[bestIdx + 1]);
  }
  return syms.length;
}

export function countTokens(text, modelName) {
  if (!text) return 0;
  const s = String(text);
  if (!isTokenizable(modelName)) return heuristicTokens(s);
  const d = loadData();
  if (!d) return heuristicTokens(s); // 词表缺失时优雅回退

  let total = 0;
  let pos = 0;
  while (pos < s.length) {
    // added_tokens 最长优先匹配
    let matched = null;
    for (const a of d.added) {
      if (a && s.startsWith(a, pos)) {
        matched = a;
        break;
      }
    }
    if (matched) {
      total += 1;
      pos += matched.length;
      continue;
    }
    // 原始片段：截到下一个 added token 出现处（或结尾）
    let next = s.length;
    for (const a of d.added) {
      if (!a) continue;
      const i = s.indexOf(a, pos + 1);
      if (i !== -1 && i < next) next = i;
    }
    const piece = s.slice(pos, next);
    const matches = piece.match(PRETOK);
    if (matches) {
      for (const m of matches) total += countPiece(m, d);
    } else {
      total += countPiece(piece, d);
    }
    pos = next;
  }
  return total;
}

// 供上下文预算使用的计数器工厂
export function makeTokenCounter(modelName) {
  if (isTokenizable(modelName)) {
    return (text) => countTokens(text, modelName);
  }
  return (text) => heuristicTokens(text);
}
