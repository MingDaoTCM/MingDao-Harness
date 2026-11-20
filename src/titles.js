// 会话标题自动生成：新会话首轮完成后，用 executor 模型生成简短中文标题并重命名会话文件。
// 成本约几十 token；可配置 "autoTitle": false 关闭。

import { modelPreset } from './models.js';
import { recordAuxUsageAsync } from './cachestats.js';
import { routingConfig } from './routing.js';
import { moveSessionFamily, sessionFamilyExists } from './session-files.js';

export function titleModel(/** @type {any} */ cfg, /** @type {any} */ currentModel) {
  const rc = routingConfig(cfg);
  if (rc) return rc.executor;
  // 路由关闭：辅助调用用当前模型（评估 P2-2：硬编码 flash 会在自定义网关 404 静默失败）
  return currentModel;
}

function cleanTitle(/** @type {any} */ s) {
  return String(s ?? '')
    .trim()
    .replace(/["「」『』"'`*#\n\r]/g, '')
    .slice(0, 20);
}

export async function generateTitle(/** @type {any} */ provider, /** @type {any} */ model, /** @type {any} */ firstUserText, { timeoutMs = 10000 } = {}) {
  // 硬超时护栏（审计：「第二问无反应」根因）：标题生成发生在回合收尾阶段，若网关/网络层
  // 挂起（不抛错），回合永远无法 complete——前端停在生成态、后续发送全部静默。20s 兜底：
  // 超时放弃标题（会话仍以时间戳命名），绝不阻塞下一问。
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('标题生成超时')), timeoutMs);
  const user = { role: 'user', content: String(firstUserText).slice(0, 300) };
  // 审计 BUG-048：峰谷价锚点 = **请求发起时刻**（与 recordUsage 同口径），不是落账时刻
  const titleStartAt = Date.now();
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
      await recordAuxUsageAsync(model, res?.usage, 'auto-title', { requestStartAt: titleStartAt }); // v0.4.7：标题生成消耗入账
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
      await recordAuxUsageAsync(model, res?.usage, 'auto-title-fallback', { requestStartAt: titleStartAt }); // v0.4.7
      const t = cleanTitle(res.text);
      return t || null;
    } catch {
      return null;
    }
  } finally {
    clearTimeout(timer);
  }
}

export function sanitizeTitle(/** @type {any} */ s) {
  const clean = String(s).replace(/[^\w\u4e00-\u9fa5 .-]/g, '_').slice(0, 40).trim();
  return clean || '会话';
}

// 重命名会话文件（与 /title 一致：确保存在、同名加随机后缀）
//
// v0.10.1（v0.8.1 审计报告2 M-06）：改名必须把**同一 basename 的全部侧车**一起搬走
// （事件侧车 + 两把锁 + 任务检查点），否则旧会话留下孤儿 `.events.ndjson`，新会话则
// 从「有侧车、没主文件」的幽灵状态开始（重复改名时 seq 还会继承旧日志）。
// 搬迁本身是原子的：`moveSessionFamily()` 中途失败会逆序还原，本函数返回 null（既有契约）。
export function renameSessionFile(/** @type {any} */ fs, /** @type {any} */ pathMod, /** @type {any} */ home, /** @type {any} */ session, /** @type {any} */ title) {
  const safe = sanitizeTitle(title);
  try {
    fs.appendFileSync(session.file, '');
  } catch {
    return null;
  }
  // 目标 basename 被任何一族文件占用（主文件或任一侧车）都换随机后缀，绝不覆盖别人的侧车。
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const name = attempt === 0 ? safe : `${safe}-${Math.random().toString(36).slice(2, 6)}`;
    const newFile = pathMod.join(home, 'sessions', name + '.jsonl');
    if (sessionFamilyExists(newFile, fs)) continue;
    const moved = moveSessionFamily(session.file, newFile, { io: fs });
    if (moved.ok) {
      session.file = newFile;
      return newFile;
    }
    return null; // 真失败（权限/磁盘/目录被占）：不重试，保持原状
  }
  return null;
}
