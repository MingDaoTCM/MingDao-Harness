// 会话标题自动生成：新会话首轮完成后，用 executor 模型生成简短中文标题并重命名会话文件。
// 成本约几十 token；可配置 "autoTitle": false 关闭。

import { modelPreset } from './models.js';
import { routingConfig } from './routing.js';

export function titleModel(cfg, currentModel) {
  const rc = routingConfig(cfg);
  if (rc) return rc.executor;
  // 路由关闭：辅助调用用当前模型（评估 P2-2：硬编码 flash 会在自定义网关 404 静默失败）
  return currentModel;
}

function cleanTitle(s) {
  return String(s ?? '')
    .trim()
    .replace(/["「」『』"'`*#\n\r]/g, '')
    .slice(0, 20);
}

export async function generateTitle(provider, model, firstUserText, { timeoutMs = 10000 } = {}) {
  // 硬超时护栏（审计：「第二问无反应」根因）：标题生成发生在回合收尾阶段，若网关/网络层
  // 挂起（不抛错），回合永远无法 complete——前端停在生成态、后续发送全部静默。20s 兜底：
  // 超时放弃标题（会话仍以时间戳命名），绝不阻塞下一问。
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('标题生成超时')), timeoutMs);
  const user = { role: 'user', content: String(firstUserText).slice(0, 300) };
  try {
    // 结构化输出（评估 4.2-4）：json_object，maxTokens 120→50，解析零失败；网关不支持时回退纯文本
    try {
      const res = await provider.chat({
        model,
        messages: [
          { role: 'system', content: '为下面的对话开头生成一个简短标题（≤12 字，中文，不要引号、句号、markdown 符号）。只输出 JSON：{"title":"标题"}。' },
          user,
        ],
        tools: [],
        temperature: 0.3,
        maxTokens: 50,
        reasoningEffort: 'low',
        responseFormat: { type: 'json_object' },
        signal: ctrl.signal,
      });
      const j = JSON.parse(String(res.text || '').trim());
      const t = cleanTitle(j?.title);
      if (t) return t;
    } catch {}
    try {
      const res = await provider.chat({
        model,
        messages: [{ role: 'system', content: '为下面的对话开头生成一个简短标题（≤12 字，中文，不要引号、句号、markdown 符号，直接输出标题本身）。' }, user],
        tools: [],
        temperature: 0.3,
        maxTokens: 120,
        reasoningEffort: 'low',
        signal: ctrl.signal,
      });
      const t = cleanTitle(res.text);
      return t || null;
    } catch {
      return null;
    }
  } finally {
    clearTimeout(timer);
  }
}

export function sanitizeTitle(s) {
  const clean = String(s).replace(/[^\w\u4e00-\u9fa5 .-]/g, '_').slice(0, 40).trim();
  return clean || '会话';
}

// 重命名会话文件（与 /title 一致：确保存在、同名加随机后缀）
export function renameSessionFile(fs, pathMod, home, session, title) {
  const safe = sanitizeTitle(title);
  let newFile = pathMod.join(home, 'sessions', safe + '.jsonl');
  try {
    fs.appendFileSync(session.file, '');
    if (fs.existsSync(newFile)) {
      newFile = pathMod.join(home, 'sessions', safe + '-' + Math.random().toString(36).slice(2, 6) + '.jsonl');
    }
    fs.renameSync(session.file, newFile);
    session.file = newFile;
    return newFile;
  } catch {
    return null;
  }
}
