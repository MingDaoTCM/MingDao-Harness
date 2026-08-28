// 会话检索索引（P3-2）：词表倒排 + 增量同步，替代每次全量扫描全部会话文件。
// 索引文件 <mingdao-home>/sessions-index.json：
//   { files: { "<会话名>": { mtime, size, terms: {词: 次数} } } }
// 同步策略：查询前对每个会话文件做 mtime/size 对比——未变化直接用缓存词表（O(词表)），
// 变化/新增才重新分词（增量）；已删除文件自动清理；>8MB 超大文件跳过并移除条目。
// 分词：英文/数字/路径按词（小写），中文按 bigram + 单字，查询串同口径分词后按 AND 匹配。

import fs from 'node:fs';
import path from 'node:path';
import { mingdaoHome, ensureHome } from './config.js';
import { atomicWriteFileSync } from './atomic-write.js';

const INDEX_MAX_FILE = 8 * 1024 * 1024;

export function sessionIndexFile() {
  return path.join(mingdaoHome(), 'sessions-index.json');
}

export function loadSessionIndex() {
  try {
    const j = JSON.parse(fs.readFileSync(sessionIndexFile(), 'utf8'));
    return j && typeof j === 'object' && j.files && typeof j.files === 'object' ? j : { files: {} };
  } catch {
    return { files: {} };
  }
}

export function saveSessionIndex(idx) {
  try {
    ensureHome();
    const target = sessionIndexFile();
    atomicWriteFileSync(target, JSON.stringify(idx) + '\n'); // 质检 H4：索引原子写
  } catch {}
}

// 分词：ASCII 词（小写）+ 中文 bigram + 中文单字；返回 Map<词, 次数>
export function tokenize(text) {
  const terms = new Map();
  const add = (t) => {
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

// 增量同步索引（对比 mtime/size，只重算变化的文件；清理已删除条目）
export function syncSessionIndex(home, sessions) {
  const idx = loadSessionIndex();
  const dir = path.join(home, 'sessions');
  let changed = false;
  for (const s of sessions) {
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
  // 清理已删除的会话条目（防索引无限膨胀）
  for (const name of Object.keys(idx.files)) {
    if (!fs.existsSync(path.join(dir, name))) {
      delete idx.files[name];
      changed = true;
    }
  }
  if (changed) saveSessionIndex(idx);
  return idx;
}
