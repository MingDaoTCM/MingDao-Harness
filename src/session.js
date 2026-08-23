// 会话持久化：JSONL 格式存放在 <mingdao-home>/sessions/。
// 每轮自动追加；mingdao --continue 载入最近一次会话。

import fs from 'node:fs';
import path from 'node:path';

export function listSessions(home) {
  const dir = path.join(home, 'sessions');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const file = path.join(dir, f);
        return { file, name: f, mtime: fs.statSync(file).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

export function latestSession(home) {
  return listSessions(home)[0] || null;
}

export function createSession(home) {
  const dir = path.join(home, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const rand = Math.random().toString(36).slice(2, 6);
  const file = path.join(dir, `${stamp}-${rand}.jsonl`);
  return { file, name: path.basename(file) };
}

export function appendMessages(file, messages) {
  if (!messages?.length) return;
  const lines = messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
  fs.appendFileSync(file, lines);
}

// 整文件原子重写：自动压缩后把会话文件同步为压缩形态（否则每次加载历史都会重新触发压缩）
export function rewriteSession(file, messages) {
  const lines = messages.map((m) => JSON.stringify(m)).join('\n');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, lines + (lines ? '\n' : ''), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function loadSession(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const messages = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (m && typeof m === 'object' && ['system', 'user', 'assistant', 'tool'].includes(m.role)) {
        messages.push(m);
      }
    } catch {}
  }
  return { file, messages };
}

// 会话预览：第一条用户消息（用于会话选择器）
export function sessionPreview(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (!m || typeof m !== 'object') continue; // 审计 B4：null/非对象行跳过而非中断预览
      if (m.role === 'user') {
        const s = String(m.content).split('\n')[0].trim().slice(0, 60);
        return s || '(空消息)';
      }
    }
    return '(无内容)';
  } catch {
    return '(无法读取)';
  }
}

export function relativeTime(mtime) {
  const diff = Date.now() - mtime;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}

// 全文检索历史会话（P3-2 索引化）：增量词表倒排 + AND 匹配（中文 bigram），
// 只对命中的少数文件读原文生成片段；未命中/无关键词时回退列表。
import { syncSessionIndex, tokenize, extractSessionText } from './session-index.js';

export function searchSessions(home, keyword, { limit = 20 } = {}) {
  const kw = String(keyword ?? '').trim();
  if (!kw) return listSessions(home).slice(0, limit);
  const sessions = listSessions(home);
  const idx = syncSessionIndex(home, sessions);
  const qTerms = [...tokenize(kw).keys()];
  if (!qTerms.length) return [];
  const lower = kw.toLowerCase();
  const out = [];
  for (const s of sessions) {
    if (out.length >= limit) break;
    const e = idx.files[s.name];
    if (!e?.terms) continue;
    let hit = true;
    for (const t of qTerms) {
      if (!e.terms[t]) {
        hit = false;
        break;
      }
    }
    if (!hit) continue;
    // 命中（数量受 limit 约束）：读原文生成干净片段
    let snippet = '';
    try {
      const text = extractSessionText(s.file);
      const at = text.toLowerCase().indexOf(lower);
      if (at !== -1) {
        snippet = `…${text.slice(Math.max(0, at - 30), at + kw.length + 50).replace(/\s+/g, ' ').trim()}…`;
      } else {
        snippet = `…${text.slice(0, 80).replace(/\s+/g, ' ').trim()}…`;
      }
    } catch {}
    out.push({ ...s, snippet });
  }
  return out;
}
