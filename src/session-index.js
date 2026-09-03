// 会话检索索引（P3-2）：词表倒排 + 增量同步，替代每次全量扫描全部会话文件。
// 索引分片存储（v0.2.8 B1）：<mingdao-home>/sessions-index/<2位sha1前缀>.json ——
//   每片 { files: { "<会话名>": { mtime, size, terms: {词: 次数} } } }
// 分片收益：>1000 会话时不再单次 JSON.parse/stringify 一个巨型索引文件；
//   同步只重写「变脏」的分片，读/写放大与内存峰值都大幅下降（256 片，每片 ~4 个会话）。
// 同步策略：查询前对每个会话文件做 mtime/size 对比——未变化直接用缓存词表（O(词表)），
// 变化/新增才重新分词（增量）；已删除文件自动清理；>8MB 超大文件跳过并移除条目。
// 分词：英文/数字/路径按词（小写），中文按 bigram + 单字，查询串同口径分词后按 AND 匹配。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { mingdaoHome, ensureHome } from './config.js';
import { atomicWriteFileSync } from './atomic-write.js';

const INDEX_MAX_FILE = 8 * 1024 * 1024;
const SHARD_HEX = 2; // sha1 前 2 个十六进制位 → 256 片

/** 分片目录（索引分片统一存放于此） */
export function shardDir() {
  return path.join(mingdaoHome(), 'sessions-index');
}

/** 会话名 → 分片名（sha1 前 2 位，稳定且均匀） */
/** @param {any} name */
export function shardOf(name) {
  return crypto.createHash('sha1').update(String(name)).digest('hex').slice(0, SHARD_HEX);
}

/** @param {any} shard */
function shardFile(shard) {
  return path.join(shardDir(), `${shard}.json`);
}

/** @param {any} shard */
function loadShard(shard) {
  try {
    const j = JSON.parse(fs.readFileSync(shardFile(shard), 'utf8'));
    return j && typeof j === 'object' && j.files && typeof j.files === 'object' ? j : { files: {} };
  } catch {
    return { files: {} };
  }
}

/** @param {any} shard @param {any} idx */
function saveShard(shard, idx) {
  try {
    ensureHome();
    const dir = shardDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    atomicWriteFileSync(shardFile(shard), JSON.stringify(idx) + '\n'); // 质检 H4：索引原子写
  } catch {}
}

// 一次性迁移：旧版单文件 sessions-index.json → 分片目录（迁移后删除旧文件）
function migrateLegacyIndex() {
  const legacy = path.join(mingdaoHome(), 'sessions-index.json');
  if (!fs.existsSync(legacy)) return;
  try {
    const j = JSON.parse(fs.readFileSync(legacy, 'utf8'));
    const files = j && typeof j === 'object' && j.files && typeof j.files === 'object' ? j.files : {};
    for (const [name, entry] of Object.entries(files)) {
      const shard = shardOf(name);
      const idx = loadShard(shard);
      idx.files[name] = entry;
      saveShard(shard, idx);
    }
    fs.unlinkSync(legacy);
  } catch {}
}

// 分词：ASCII 词（小写）+ 中文 bigram + 中文单字；返回 Map<词, 次数>
/** @param {any} text */
export function tokenize(text) {
  const terms = new Map();
  const add = (/** @type {any} */ t) => {
    if (t) terms.set(t, (terms.get(t) || 0) + 1);
  };
  const s = String(text ?? '');
  for (const m of s.matchAll(/[A-Za-z0-9_./-]{2,}/g)) {
    add(m[0].toLowerCase());
    // 审计 B6：'.'/'/' 分隔的子段也成词（"abc.def" 同时可被 "def" 命中）
    for (const sub of m[0].split(/[./]/)) {
      if (sub.length >= 2) add(sub.toLowerCase());
    }
  }
  const cjk = s.replace(/[^\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ' ');
  for (const run of cjk.split(/\s+/)) {
    if (!run) continue;
    if (run.length === 1) {
      add(run);
      continue;
    }
    for (let i = 0; i + 1 < run.length; i++) add(run.slice(i, i + 2));
    for (const ch of run) add(ch);
  }
  return terms;
}

// 从会话文件提取可检索文本（user/assistant 内容拼接）
/** @param {any} file */
export function extractSessionText(file) {
  const parts = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if ((m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content) {
      parts.push(m.content);
    }
  }
  return parts.join('\n');
}

// 增量同步索引（对比 mtime/size，只重算变化的文件；清理已删除条目）。
// 返回合并后的 { files: {名称: 词表条目} } 供检索匹配（仍只持有所需词表，不再单次解析巨型文件）。
/** @param {any} home @param {any} sessions
 * @returns {{ files: Record<string, any> }} */
export function syncSessionIndex(home, sessions) {
  migrateLegacyIndex();
  const dir = path.join(home, 'sessions');
  /** @type {{ files: Record<string, any> }} */
  const combined = { files: {} };
  const liveShards = new Set();

  // 按分片聚合存活会话：每片只 load 一次，命中/变化只写回该片
  const byShard = new Map();
  for (const s of sessions) {
    const k = shardOf(s.name);
    if (!byShard.has(k)) byShard.set(k, []);
    byShard.get(k).push(s);
  }

  for (const [k, group] of byShard) {
    liveShards.add(k);
    const idx = loadShard(k);
    let changed = false;
    for (const s of group) {
      let st;
      try {
        st = fs.statSync(s.file);
      } catch {
        delete idx.files[s.name];
        changed = true;
        continue;
      }
      const cached = idx.files[s.name];
      if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) continue; // 未变化：直接用缓存
      changed = true;
      if (st.size > INDEX_MAX_FILE) {
        delete idx.files[s.name]; // 超大文件不索引
        continue;
      }
      try {
        idx.files[s.name] = {
          mtime: st.mtimeMs,
          size: st.size,
          terms: Object.fromEntries(tokenize(extractSessionText(s.file))),
        };
      } catch {
        delete idx.files[s.name];
      }
    }
    // 清理本片内已删除的会话条目（防索引膨胀）
    for (const name of Object.keys(idx.files)) {
      if (!fs.existsSync(path.join(dir, name))) {
        delete idx.files[name];
        changed = true;
      }
    }
    if (changed) saveShard(k, idx);
    // 合并本片存活条目供检索
    for (const s of group) {
      const e = idx.files[s.name];
      if (e) combined.files[s.name] = e;
    }
  }

  // 清理「无存活会话」分片里的陈旧条目（这些片的会话全被删了）：目录扫描逐片检查，
  // 每片都很小；空片直接删除文件，避免残留索引膨胀
  let entries = [];
  try {
    entries = fs.readdirSync(shardDir());
  } catch {
    return combined;
  }
  for (const f of entries) {
    if (!f.endsWith('.json')) continue;
    const k = f.slice(0, -5);
    if (liveShards.has(k)) continue;
    const idx = loadShard(k);
    let changed = false;
    for (const name of Object.keys(idx.files)) {
      if (!fs.existsSync(path.join(dir, name))) {
        delete idx.files[name];
        changed = true;
      }
    }
    if (changed) {
      if (Object.keys(idx.files).length) saveShard(k, idx);
      else {
        try {
          fs.unlinkSync(path.join(shardDir(), f));
        } catch {}
      }
    }
  }

  return combined;
}
