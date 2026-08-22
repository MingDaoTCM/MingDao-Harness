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

// 全文检索历史会话：大小写不敏感子串匹配（按消息内容解析），返回命中会话与干净片段
export function searchSessions(home, keyword, { limit = 20 } = {}) {
  const kw = String(keyword ?? '').trim();
  if (!kw) return listSessions(home).slice(0, limit);
  const lower = kw.toLowerCase();
  const out = [];
  for (const s of listSessions(home)) {
    if (out.length >= limit) break;
    let lines;
    try {
      const st = fs.statSync(s.file);
      if (st.size > 8 * 1024 * 1024) continue; // 超大文件跳过
      lines = fs.readFileSync(s.file, 'utf8').split('\n');
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof m.content !== 'string') continue;
      const idx = m.content.toLowerCase().indexOf(lower);
      if (idx === -1) continue;
      const start = Math.max(0, idx - 30);
      const snippet = m.content
        .slice(start, idx + lower.length + 50)
        .replace(/\s+/g, ' ')
        .trim();
      out.push({ ...s, snippet: `…${snippet}…` });
      break; // 每个会话只取第一条命中
    }
  }
  return out;
}
