// 长记忆与自主进化（借鉴 Hermes Agent）：
//  - 用户记忆：~/.mingdao/AGENTS.md（/memory add 手动 + 会话结束自动提取用户偏好，去重追加）
//  - 会话日志：~/.mingdao/journal.jsonl（跨会话连续性；默认不注入系统提示——新会话全新开始，
//    避免串到历史会话上下文；WebUI「带上文」勾选 / CLI --journal 时注入最近 3 条）
//  - 自动记忆提取用 executor 模型（约几十 token/会话），config.autoMemory 可关（默认开）

import fs from 'node:fs';
import path from 'node:path';
import { mingdaoHome, ensureHome } from './config.js';
import { beijingParts } from './pricing.js';
import { tokenize } from './session-index.js';

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

export function appendMemory(/** @type {any} */ lines) {
  const add = lines.map((/** @type {any} */ l) => l.trim()).filter(Boolean);
  if (!add.length) return 0;
  ensureHome();
  // 审计 B9 + 质检 M8：与费用统计同口径，用配置时区（默认北京时间）自然日做记忆日期戳
  const bp = beijingParts(new Date());
  const date = `${bp.year}-${String(bp.month).padStart(2, '0')}-${String(bp.day).padStart(2, '0')}`;
  fs.appendFileSync(memoryFile(), add.map((/** @type {any} */ l) => (l.startsWith('-') ? `- [${date}] ${l.slice(1).trim()}` : `- [${date}] ${l}`)).join('\n') + '\n');
  return add.length;
}

function backupMemory() {
  try {
    if (fs.existsSync(memoryFile())) fs.copyFileSync(memoryFile(), memoryFile() + '.bak');
  } catch {}
}

// 整体覆写（编辑面板保存用，自动备份）
export function writeMemory(/** @type {any} */ content) {
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
export function removeMemoryLines(/** @type {any} */ keyword) {
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

let journalCount = 0; // 内存计数（评估 P3-2）：避免每次写入都整文件读一遍只为查行数

export function appendJournal(/** @type {any} */ home, /** @type {any} */ entry) {
  try {
    // journalFile() 已含 mingdaoHome()（home 参数仅为兼容旧签名保留）。
    // 不能 path.join(home, dirname(journalFile()))：journalFile() 是绝对路径，join 会拼出
    // 「D:\a\D:\b」式非法路径——Windows 上 mkdir 抛错被静默吞掉，journal 整体失效（评估 D1）。
    fs.mkdirSync(path.dirname(journalFile()), { recursive: true });
    // 纯追加：并发会话收尾互不覆盖；崩溃最多丢最后一行
    fs.appendFileSync(journalFile(), JSON.stringify(entry) + '\n');
    journalCount += 1;
  } catch (err) {
    // 静默吞错面收窄（评估建议 3）：调试开关可见原因，正常使用仍零打扰
    if (process.env.MINGDAO_DEBUG) console.warn('[MingDao] journal 写入失败：' + ((/** @type {any} */ (err))?.message || err));
  }
  // 低频截断：超过 600 行时重写保留最近 500 行（跨过上限后每 200 条检查一次）
  if (journalCount > 600 && journalCount % 200 === 0) {
    try {
      const raw = fs.readFileSync(journalFile(), 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      if (lines.length > 600) {
        fs.writeFileSync(journalFile(), lines.slice(-500).join('\n') + '\n');
        journalCount = 500;
      }
    } catch {}
  }
}

export function recentJournal(/** @type {any} */ home, n = 3) {
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

export function recentJournalBlock(/** @type {any} */ home) {
  const entries = recentJournal(home, 3);
  if (!entries.length) return '';
  return (
    '\n\n<recent_sessions>\n' +
    entries
      .map((e) => {
        const bp = beijingParts(new Date(e.at)); // 质检 M8：UTC 日期 → 配置时区日期（与全系统口径一致）
        const d = `${bp.year}-${String(bp.month).padStart(2, '0')}-${String(bp.day).padStart(2, '0')}`;
        return `- ${d} ${(e.workspace || '').replace(/[<>]/g, '')}：${(e.firstUser?.slice(0, 40) ?? '').replace(/[<>]/g, '')} → ${(e.outcome?.slice(0, 40) ?? '').replace(/[<>]/g, '')}`;
      })
      .join('\n') +
    '\n</recent_sessions>'
  );
}

// 自动记忆提取：从对话提炼值得长期记住的用户偏好/事实（去重：已有记忆会先提供给模型）
export async function extractMemory(/** @type {any} */ provider, /** @type {any} */ model, /** @type {any} */ messages, /** @type {any} */ existingMemory) {
  try {
    const convo = messages
      .filter((/** @type {any} */ m) => m.role === 'user' || m.role === 'assistant')
      .slice(-20)
      .map((/** @type {any} */ m) => `${m.role === 'user' ? '用户' : 'MingDao'}：${String(m.content || '').slice(0, 500)}`)
      .join('\n');
    const msgs = [
      {
        role: 'system',
        content:
          '你是 MingDao Harness 的记忆提取器。从对话中提取值得长期记住的用户偏好与事实（工具链、代码风格、项目背景、个人约定、常用指令等）。每条 ≤30 字，只输出新条目（与「已有记忆」重复或对话中未提及的不要输出）。只输出 JSON：{"items": ["条目1", "条目2"]}；没有新增时输出 {"items": []}。\n已有记忆：\n' +
          (existingMemory || '（空）'),
      },
      { role: 'user', content: convo.slice(0, 8000) },
    ];
    // 结构化输出（评估 4.2-4）：json_object，maxTokens 300→200，解析零失败；网关不支持时回退纯文本
    try {
      const res = await provider.chat({ model, messages: msgs, tools: [], temperature: 0.2, maxTokens: 200, reasoningEffort: 'low', responseFormat: { type: 'json_object' } });
      const j = JSON.parse(String(res.text || '').trim());
      const items = Array.isArray(j?.items) ? j.items : [];
      const clean = items
        .map((/** @type {any} */ l) => String(l).trim())
        .filter(Boolean)
        .map((/** @type {any} */ l) => (/^[·•]/.test(l) ? '- ' + l.replace(/^[·•]\s*/, '') : l.startsWith('-') ? l : '- ' + l)) // 审计 Q4：非前缀条目规整为 "- "，不再二次回退调用
        .slice(0, 10);
      if (clean.length || items.length === 0) return clean; // 空数组 = 无新增；有内容即返回
    } catch {}
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

// —— 项目级自动记忆（v0.3.0 P0-3）——
// 与用户记忆（偏好/约定）区分：项目记忆沉淀「关键决定/事实/结构/教训」，随工作空间走，
// 换会话/换项目不串。存储：<工作空间>/.mingdao/memory.md（git 可忽略，属本机智能体的项目笔记）。
export function projectMemoryFile(/** @type {any} */ workingDir) {
  return path.join(String(workingDir || ''), '.mingdao', 'memory.md');
}

export function loadProjectMemory(/** @type {any} */ workingDir) {
  try {
    return fs.readFileSync(projectMemoryFile(workingDir), 'utf8');
  } catch {
    return '';
  }
}

// 项目记忆按条目读取（供语义检索）
export function loadProjectMemoryEntries(/** @type {any} */ workingDir) {
  return loadProjectMemory(workingDir)
    .split('\n')
    .map((/** @type {any} */ l) => l.trim())
    .filter(Boolean);
}

// 零依赖语义检索：与 query 分词（ASCII 词 + 中文 bigram）的 Jaccard 相似度取 TopN 相关条目。
// 用于「记忆/日志从最近 N 条 → 相关 N 条」（v0.3.1），换会话/换任务只注入相关记忆、省 token。
export function retrieveRelevant(/** @type {any[]} */ entries, /** @type {any} */ query, /** @type {number} */ topN = 5) {
  const qTerms = new Set([...tokenize(String(query || '')).keys()]);
  if (!qTerms.size) return entries.slice(0, topN);
  const scored = entries.map((/** @type {any} */ e) => {
    const text = typeof e === 'string' ? e : String(e.text || e.outcome || e.firstUser || e.content || '');
    const terms = tokenize(text);
    if (!terms.size) return { e, score: 0 };
    let overlap = 0;
    for (const t of terms.keys()) if (qTerms.has(t)) overlap += 1;
    const union = new Set([...qTerms, ...terms.keys()]).size || 1;
    return { e, score: overlap / union };
  });
  scored.sort((/** @type {any} */ a, /** @type {any} */ b) => b.score - a.score);
  return scored.filter((/** @type {any} */ s) => s.score > 0).slice(0, topN).map((/** @type {any} */ s) => s.e);
}

export function appendProjectMemory(/** @type {any} */ workingDir, /** @type {any} */ lines) {
  const add = lines.map((/** @type {any} */ l) => l.trim()).filter(Boolean);
  if (!add.length || !workingDir) return 0;
  try {
    fs.mkdirSync(path.dirname(projectMemoryFile(workingDir)), { recursive: true, mode: 0o700 });
    const bp = beijingParts(new Date());
    const date = `${bp.year}-${String(bp.month).padStart(2, '0')}-${String(bp.day).padStart(2, '0')}`;
    fs.appendFileSync(
      projectMemoryFile(workingDir),
      add.map((/** @type {any} */ l) => (l.startsWith('-') ? `- [${date}] ${l.slice(1).trim()}` : `- [${date}] ${l}`)).join('\n') + '\n'
    );
    return add.length;
  } catch {
    return 0;
  }
}

export function dedupeProjectMemory(/** @type {any} */ workingDir) {
  const raw = loadProjectMemory(workingDir);
  if (!raw.trim()) return 0;
  const seen = new Set();
  const kept = [];
  let removed = 0;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const norm = t.replace(/^-\s*\[\d{4}-\d{2}-\d{2}\]\s*/, '').trim().toLowerCase();
    if (seen.has(norm)) { removed += 1; continue; }
    seen.add(norm);
    kept.push(t);
  }
  if (removed > 0) {
    try { fs.writeFileSync(projectMemoryFile(workingDir), kept.join('\n') + '\n'); } catch {}
  }
  return removed;
}

// 项目记忆提取：关键决定及其原因、文件/目录结构、依赖与约定、踩过的坑与教训、未完成事项
export async function extractProjectMemory(/** @type {any} */ provider, /** @type {any} */ model, /** @type {any} */ messages, /** @type {any} */ existing) {
  try {
    const convo = messages
      .filter((/** @type {any} */ m) => m.role === 'user' || m.role === 'assistant')
      .slice(-20)
      .map((/** @type {any} */ m) => `${m.role === 'user' ? '用户' : 'MingDao'}：${String(m.content || '').slice(0, 500)}`)
      .join('\n');
    const msgs = [
      {
        role: 'system',
        content:
          '你是 MingDao Harness 的项目记忆提取器。从对话中提取值得长期记住的「项目级事实」：关键决定及其原因、文件/目录结构、依赖与约定、踩过的坑与教训、未完成事项。每条 ≤50 字，只输出新条目（与「已有记忆」重复或对话中未提及的不要输出）。只输出 JSON：{"items": ["条目1", "条目2"]}；没有新增时输出 {"items": []}。\n已有记忆：\n' +
          (existing || '（空）'),
      },
      { role: 'user', content: convo.slice(0, 8000) },
    ];
    try {
      const res = await provider.chat({ model, messages: msgs, tools: [], temperature: 0.2, maxTokens: 250, reasoningEffort: 'low', responseFormat: { type: 'json_object' } });
      const j = JSON.parse(String(res.text || '').trim());
      const items = Array.isArray(j?.items) ? j.items : [];
      const clean = items
        .map((/** @type {any} */ l) => String(l).trim())
        .filter(Boolean)
        .map((/** @type {any} */ l) => (/^[·•]/.test(l) ? '- ' + l.replace(/^[·•]\s*/, '') : l.startsWith('-') ? l : '- ' + l))
        .slice(0, 10);
      if (clean.length || items.length === 0) return clean;
    } catch {}
    const res = await provider.chat({
      model,
      messages: [
        {
          role: 'system',
          content:
            '你是 MingDao Harness 的项目记忆提取器。从对话中提取值得长期记住的项目级事实（关键决定及原因、结构、依赖约定、教训、未完成事项）。每条一行，以 - 开头，≤50 字，只输出新条目（与「已有记忆」重复或未提及的不要输出）；没有新增就只输出「无新增」。\n已有记忆：\n' +
            (existing || '（空）'),
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
      .map((/** @type {any} */ l) => l.trim())
      .filter((/** @type {any} */ l) => l.startsWith('-') || /^[·•]/.test(l))
      .map((/** @type {any} */ l) => l.replace(/^[·•]\s*/, '- '))
      .slice(0, 10);
  } catch {
    return [];
  }
}

// 项目记忆提取 + 追加（CLI finalizeSession 与 WebUI 收尾共用；配置 autoProjectMemory 默认开）
export async function extractAndAppendProjectMemory(/** @type {any} */ { cfg, provider, model, messages, workingDir }) {
  if (!workingDir || cfg?.autoProjectMemory === false) return;
  try {
    const existing = loadProjectMemory(workingDir);
    const { helperProvider } = await import('./providers/index.js');
    const memProvider = await helperProvider(cfg, model, provider);
    const lines = await extractProjectMemory(memProvider, model, messages, existing);
    if (lines.length) appendProjectMemory(workingDir, lines);
  } catch {}
}

// 会话收尾：写日志 + 自动记忆（turns 太少的一次性会话只记日志不提取）
export async function finalizeSession(/** @type {any} */ { cfg, provider, model, home, workingDir, messages, turns, lastText }) {
  const firstUser = messages.find((/** @type {any} */ m) => m.role === 'user')?.content || '';
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
      // 辅助模型与当前模型分属不同服务商时按模型解析 provider（评估 P2-2）
      const { helperProvider } = await import('./providers/index.js');
      const memProvider = await helperProvider(cfg, model, provider);
      const lines = await extractMemory(memProvider, model, messages, existing);
      if (lines.length) appendMemory(lines);
    } catch {}
  }
  // v0.3.0 P0-3：项目级自动记忆（有实际工具工作才提取，避免空话污染项目记忆；
  // 单轮重型任务也会执行工具，故按「是否有 tool 消息」判定而非 turn 数）
  const hadToolWork = messages.some((/** @type {any} */ m) => m.role === 'tool');
  if (workingDir && (hadToolWork || turns >= 2)) {
    await extractAndAppendProjectMemory({ cfg, provider, model, messages, workingDir });
  }
}
