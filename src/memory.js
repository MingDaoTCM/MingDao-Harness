// 长记忆与自主进化（借鉴 Hermes Agent）：
//  - 用户记忆：~/.mingdao/AGENTS.md（/memory add 手动 + 会话结束自动提取用户偏好，去重追加）
//  - 会话日志：~/.mingdao/journal.jsonl（跨会话连续性；默认不注入系统提示——新会话全新开始，
//    避免串到历史会话上下文；WebUI「带上文」勾选 / CLI --journal 时注入最近 3 条）
//  - 自动记忆提取用 executor 模型（约几十 token/会话），config.autoMemory 可关（默认开）

import fs from 'node:fs';
import path from 'node:path';
import { mingdaoHome, ensureHome } from './config.js';

export function memoryFile() {
  return path.join(mingdaoHome(), 'AGENTS.md');
}

export function journalFile() {
  return path.join(mingdaoHome(), 'journal.jsonl');
}

export function loadMemory() {
  try {
    return fs.readFileSync(memoryFile(), 'utf8');
  } catch {
    return '';
  }
}

export function appendMemory(lines) {
  const add = lines.map((l) => l.trim()).filter(Boolean);
  if (!add.length) return 0;
  ensureHome();
  const date = new Date().toISOString().slice(0, 10);
  fs.appendFileSync(memoryFile(), add.map((l) => (l.startsWith('-') ? `- [${date}] ${l.slice(1).trim()}` : `- [${date}] ${l}`)).join('\n') + '\n');
  return add.length;
}

function backupMemory() {
  try {
    if (fs.existsSync(memoryFile())) fs.copyFileSync(memoryFile(), memoryFile() + '.bak');
  } catch {}
}

// 整体覆写（编辑面板保存用，自动备份）
export function writeMemory(content) {
  backupMemory();
  ensureHome();
  fs.writeFileSync(memoryFile(), String(content ?? ''));
}

// 去重：忽略日期前缀后内容相同的条目只保留第一条
export function dedupeMemory() {
  const raw = loadMemory();
  if (!raw.trim()) return 0;
  const seen = new Set();
  const kept = [];
  let removed = 0;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const norm = t.replace(/^-\s*\[\d{4}-\d{2}-\d{2}\]\s*/, '').trim().toLowerCase();
    if (seen.has(norm)) {
      removed += 1;
      continue;
    }
    seen.add(norm);
    kept.push(t);
  }
  if (removed > 0) {
    backupMemory();
    fs.writeFileSync(memoryFile(), kept.join('\n') + '\n');
  }
  return removed;
}

// 删除包含关键词的条目
export function removeMemoryLines(keyword) {
  const raw = loadMemory();
  const kw = String(keyword).trim().toLowerCase();
  if (!raw.trim() || !kw) return 0;
  const kept = [];
  let removed = 0;
  for (const line of raw.split('\n')) {
    if (line.trim() && line.toLowerCase().includes(kw)) {
      removed += 1;
      continue;
    }
    kept.push(line);
  }
  if (removed > 0) {
    backupMemory();
    fs.writeFileSync(memoryFile(), kept.join('\n'));
  }
  return removed;
}

export function appendJournal(home, entry) {
  try {
    // journalFile() 已含 mingdaoHome()（home 参数仅为兼容旧签名保留）。
    // 不能 path.join(home, dirname(journalFile()))：journalFile() 是绝对路径，join 会拼出
    // 「D:\a\D:\b」式非法路径——Windows 上 mkdir 抛错被静默吞掉，journal 整体失效（评估 D1）。
    fs.mkdirSync(path.dirname(journalFile()), { recursive: true });
    // 纯追加：并发会话收尾互不覆盖；崩溃最多丢最后一行
    fs.appendFileSync(journalFile(), JSON.stringify(entry) + '\n');
    // 低频截断：超过 600 行时重写保留最近 500 行
    try {
      const raw = fs.readFileSync(journalFile(), 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      if (lines.length > 600) fs.writeFileSync(journalFile(), lines.slice(-500).join('\n') + '\n');
    } catch {}
  } catch (err) {
    // 静默吞错面收窄（评估建议 3）：调试开关可见原因，正常使用仍零打扰
    if (process.env.MINGDAO_DEBUG) console.warn('[MingDao] journal 写入失败：' + (err?.message || err));
  }
}

export function recentJournal(home, n = 3) {
  try {
    const raw = fs.readFileSync(journalFile(), 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .slice(-n);
  } catch {
    return [];
  }
}

export function recentJournalBlock(home) {
  const entries = recentJournal(home, 3);
  if (!entries.length) return '';
  return (
    '\n\n<recent_sessions>\n' +
    entries
      .map((e) => `- ${new Date(e.at).toISOString().slice(0, 10)} ${(e.workspace || '').replace(/[<>]/g, '')}：${(e.firstUser?.slice(0, 40) ?? '').replace(/[<>]/g, '')} → ${(e.outcome?.slice(0, 40) ?? '').replace(/[<>]/g, '')}`)
      .join('\n') +
    '\n</recent_sessions>'
  );
}

// 自动记忆提取：从对话提炼值得长期记住的用户偏好/事实（去重：已有记忆会先提供给模型）
export async function extractMemory(provider, model, messages, existingMemory) {
  try {
    const convo = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-20)
      .map((m) => `${m.role === 'user' ? '用户' : 'MingDao'}：${String(m.content || '').slice(0, 500)}`)
      .join('\n');
    const res = await provider.chat({
      model,
      messages: [
        {
          role: 'system',
          content:
            '你是 MingDao 的记忆提取器。从对话中提取值得长期记住的用户偏好与事实（工具链、代码风格、项目背景、个人约定、常用指令等）。每条一行，以 - 开头，≤30 字，只输出新条目（与「已有记忆」重复或对话中未提及的不要输出）；没有新增就只输出「无新增」。\n已有记忆：\n' +
            (existingMemory || '（空）'),
        },
        { role: 'user', content: convo.slice(0, 8000) },
      ],
      tools: [],
      temperature: 0.2,
      maxTokens: 300,
    });
    const text = String(res.text || '').trim();
    if (!text || text.includes('无新增')) return [];
    return text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('-') || /^[·•]/.test(l))
      .map((l) => l.replace(/^[·•]\s*/, '- '))
      .slice(0, 10);
  } catch {
    return [];
  }
}

// 会话收尾：写日志 + 自动记忆（turns 太少的一次性会话只记日志不提取）
export async function finalizeSession({ cfg, provider, model, home, workingDir, messages, turns, lastText }) {
  const firstUser = messages.find((m) => m.role === 'user')?.content || '';
  try {
    const wsName = null; // 由调用方通过 currentWorkspace 提供会更好，这里保持轻量
    appendJournal(home, {
      at: Date.now(),
      workspace: wsName,
      firstUser: firstUser.slice(0, 80),
      outcome: lastText?.slice(0, 80) || '',
      turns,
    });
  } catch {}
  if (cfg?.autoMemory !== false && turns >= 3) {
    try {
      const existing = loadMemory();
      const lines = await extractMemory(provider, model, messages, existing);
      if (lines.length) appendMemory(lines);
    } catch {}
  }
}
