// v0.8.1：WebUI「应用模式」的纯函数层（联网搜索 / 深度思考 / 阅读链接）。
//
// 为什么单独一层：`src/deepseek-app.js` 的 `streamAppChat` 是 CLI / WebUI 共用的传输层，
// 它产出的是「应用接口的 delta 事件」；WebUI 需要的是「既有 SSE 帧」。两者的映射、历史裁剪、
// 配置判定都是无 IO 的纯逻辑，放在这里才能逐条钉住边界（test/app-mode.js），
// 而 server.js 只负责生命周期（SSE 写入 / 会话落盘 / 收尾）。
//
// 与 Agent 路径的关系：应用接口的服务端工具（`deepseek_web_search` / `deepseek_read_url`）与
// 客户端工具**不能同时声明**，所以这条路径不经过 `src/agent.js` 的工具循环（该文件一行未改）。
// 帧类型沿用了既有词汇：思考仍是 `reasoning`、正文仍是 `text`——前端既有渲染器直接复用。
//
// 零运行时依赖。

import { APP_DEFAULT_MODEL } from '../deepseek-app.js';

/**
 * 应用模式缺 Key 时的用户可见文案（server 与测试共用同一份，避免两处文案漂移）。
 * @type {string}
 */
export const APP_NO_KEY_MESSAGE = '应用模式需要 DeepSeek API Key：请到设置里填 Key 或运行 mingdao key set deepseek';

/**
 * 把 `streamAppChat` 的 `onDelta` 事件映射成 WebUI 的 SSE 帧。
 *
 * 映射表（六种有输出的 delta；其余一律不产生帧，例如 `usage` / `stop`）：
 *   thinking → `{type:'reasoning', text}`
 *   text     → `{type:'text', text}`
 *   search   → `{type:'appSearch', queries, kind, results:[{title,url,snippet,site_name}]}`
 *   fetch    → `{type:'appFetch', action, url, title}`
 *   citation → `{type:'appCitation', url, title}`
 *   title    → `{type:'appTitle', title}`
 *
 * 注意：`text` / `reasoning` 帧沿用既有帧类型，但**字段名是 `text`**（Agent 路径的历史帧用
 * `delta`）。前端分派器在入口做一次兼容（`ev.delta ?? ev.text`），不复制一套渲染分支。
 *
 * @param {any} delta `streamAppChat` 的 onDelta 事件
 * @param {any} [state] 预留：将来若需要跨帧去重/节流，用这里携带；当前无状态映射
 * @returns {any|null} SSE 帧对象（不含 taskId/streamSeq——那两枚由 server 的 send() 封装统一补），
 *   或 null 表示该事件不产生帧
 */
export function appFrameOf(delta, state) {
  const d = /** @type {any} */ (delta) || {};
  switch (String(d.type || '')) {
    case 'thinking':
      return { type: 'reasoning', text: String(d.text ?? '') };
    case 'text':
      return { type: 'text', text: String(d.text ?? '') };
    case 'search': {
      const queries = Array.isArray(d.queries) ? d.queries.map((/** @type {any} */ q) => String(q)) : [];
      const results = Array.isArray(d.results)
        ? d.results.map((/** @type {any} */ r) => ({
            title: String(r?.title ?? ''),
            url: String(r?.url ?? ''),
            snippet: String(r?.snippet ?? ''),
            site_name: String(r?.site_name ?? ''),
          }))
        : [];
      return { type: 'appSearch', queries, kind: String(d.kind ?? ''), results };
    }
    case 'fetch':
      return { type: 'appFetch', action: String(d.action ?? ''), url: String(d.url ?? ''), title: String(d.title ?? '') };
    case 'citation':
      return { type: 'appCitation', url: String(d.url ?? ''), title: String(d.title ?? '') };
    case 'title':
      return { type: 'appTitle', title: String(d.title ?? '') };
    default:
      // usage / stop / 未知事件：WebUI 没有对应渲染（用量与结局由 done 帧承担）。
      return null;
  }
}

/**
 * 由 WebUI 会话历史构造应用接口的 `messages`。
 *
 * 规则（与 `streamAppChat` 的协议要求一致：Messages API 只认 `{role, content}` 的文本消息）：
 *   · 只保留 `role` 为 `user` / `assistant` 且 `content` 为**字符串**的消息；
 *   · `tool` / `system` 消息、带数组内容（多模态附件）的消息、`tool_calls` 等 `_` 开头字段一律丢弃
 *     （重建对象，不透传原消息上的任何附加字段）；
 *   · 只取**最后** `maxTurns * 2` 条（默认 8 轮 = 16 条），控制重发体积（应用模式的价值就在少重发）；
 *   · 末尾追加当前这一轮的 user 文本。
 *
 * @param {any[]|null|undefined} history 会话历史（`session.messages`；含 system/tool 也没关系）
 * @param {string} text 本轮 user 文本
 * @param {{maxTurns?: number}} [opts]
 * @returns {Array<{role: 'user'|'assistant', content: string}>}
 */
export function buildAppMessages(history, text, { maxTurns = 8 } = {}) {
  const n = Number(maxTurns);
  const limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : 8;
  /** @type {Array<{role: 'user'|'assistant', content: string}>} */
  const kept = [];
  const src = Array.isArray(history) ? history : [];
  for (const m of src) {
    if (!m || typeof m !== 'object') continue;
    const raw = /** @type {{role?: any, content?: any}} */ (m);
    if (raw.role !== 'user' && raw.role !== 'assistant') continue;
    if (typeof raw.content !== 'string') continue;
    kept.push({ role: /** @type {'user'|'assistant'} */ (raw.role), content: raw.content });
  }
  const out = kept.slice(-(limit * 2));
  out.push({ role: 'user', content: typeof text === 'string' ? text : String(text ?? '') });
  return out;
}

/**
 * 应用模式是否在配置里启用（默认关闭：只有字面量 `true` 才开）。
 * @param {any} cfg
 * @returns {boolean}
 */
export function appModeEnabled(cfg) {
  return cfg?.appApi?.enabled === true;
}

/**
 * 应用模式使用的模型：`cfg.appApi.model` 优先，缺省回落官方应用模型 `deepseek-flash`。
 * @param {any} cfg
 * @returns {string}
 */
export function appModelOf(cfg) {
  const model = cfg?.appApi?.model;
  return typeof model === 'string' && model.trim() ? model.trim() : APP_DEFAULT_MODEL;
}
