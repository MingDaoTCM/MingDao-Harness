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

import * as deepseekApp from '../deepseek-app.js';
import { APP_DEFAULT_MODEL, supportsAppTools } from '../deepseek-app.js';

/**
 * 深拷贝一段只含 JSON 协议字段的内容（对象/数组/原始值）。
 *
 * 为什么不用 `structuredClone`：会话历史里可能混入 `instanceof` 未知的普通对象（旧会话/投影层），
 * 递归拷贝只保留可枚举自有字段，不会因运行时特性差异（代理、不可克隆值）整段抛错。
 * @param {any} value
 * @returns {any}
 */
function cloneProtocol(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneProtocol);
  /** @type {Record<string, any>} */
  const out = {};
  for (const key of Object.keys(value)) out[key] = cloneProtocol(value[key]);
  return out;
}

/**
 * 历史里一条 assistant 消息的 content 归一：
 *   · 字符串 → 原样保留（旧会话兼容）；
 *   · 数组   → **逐字段深拷贝**（`text` / `server_tool_use` / `web_search_tool_result` /
 *              `web_fetch_tool_result` 原始块，保留 id/tool_use_id/kind/signature 与未知合法字段）；
 *   · 其它   → null（丢弃）。
 * @param {any} content
 * @returns {string|any[]|null}
 */
function assistantContentOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return cloneProtocol(content);
  return null;
}

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
 *   refusal  → `{type:'appRefusal'}`（T02：撤回帧。**只带帧类型**——拒答原文/正文一个字段都不带）
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
    case 'refusal':
      // T02：拒答是**撤回**终态——前端据此清空本轮已渲染的正文缓冲并显示固定拒答文案。
      // 帧里只带类型：被撤下的原文/思考不得通过这一帧二次流出。
      return { type: 'appRefusal' };
    default:
      // usage / stop / 未知事件：WebUI 没有对应渲染（用量与结局由 done 帧承担）。
      return null;
  }
}

/**
 * 由 WebUI 会话历史构造应用接口的 `messages`。
 *
 * v0.8.2（T04）口径——**协议原始块是历史真源**：
 *   · `user` 只保留**字符串** content（应用模式下附件由服务端工具/文件引用承担，旧行为不变）；
 *   · `assistant` 的字符串 content 原样保留（旧会话兼容）；content 是**数组**时**逐字段深拷贝回传**
 *     （`text` / `server_tool_use` / `web_search_tool_result` / `web_fetch_tool_result` 的原始块，
 *      保留 `id`/`tool_use_id`/`kind`/`signature` 与未知但合法字段）——**绝不压成字符串或重组子集**；
 *   · 丢弃 `tool` / `system` 消息、非法项与 `_` 开头等非协议附加字段（重建为 `{role, content}`）；
 *   · 按**完整回合**（user + 其后全部 assistant）原子裁剪，只取**最后** `maxTurns` 个回合
 *     （默认 8）——不会留下没有 user 的孤立 assistant/结果块，裁剪后首条恒为 `user`；
 *   · 末尾追加当前这一轮的 user 文本。
 *
 * @param {any[]|null|undefined} history 会话历史（`session.messages`；含 system/tool 也没关系）
 * @param {string} text 本轮 user 文本
 * @param {{maxTurns?: number}} [opts]
 * @returns {Array<{role: 'user'|'assistant', content: string|any[]}>}
 */
export function buildAppMessages(history, text, { maxTurns = 8 } = {}) {
  const n = Number(maxTurns);
  const limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : 8;
  /** @type {Array<{user: {role: 'user', content: string}, assistants: Array<{role: 'assistant', content: string|any[]}>}>} */
  const turns = [];
  /** @type {{role: 'user', content: string, assistants: any[]}|null} */
  let current = null;
  const src = Array.isArray(history) ? history : [];
  for (const m of src) {
    if (!m || typeof m !== 'object') continue;
    const raw = /** @type {{role?: any, content?: any}} */ (m);
    if (raw.role === 'user') {
      if (typeof raw.content !== 'string') {
        // 非字符串 user 内容（带附件/多模态块）不进应用接口历史：与 v0.8.1 一致，避免协议错配。
        current = null;
        continue;
      }
      current = { role: 'user', content: raw.content, assistants: [] };
      turns.push({ user: { role: 'user', content: raw.content }, assistants: /** @type {any[]} */ (current.assistants) });
      continue;
    }
    if (raw.role === 'assistant') {
      const content = assistantContentOf(raw.content);
      if (content === null) continue;
      // 没有前置 user 的 assistant（含孤立的工具结果块）不保留：裁剪后首条必须是 user。
      if (current) current.assistants.push({ role: 'assistant', content });
    }
  }
  // 原子裁剪：以「回合」为单位取最后 maxTurns 个，user 与它的 assistant 永不拆散。
  const kept = turns.slice(-limit);
  /** @type {Array<{role: 'user'|'assistant', content: string|any[]}>} */
  const out = [];
  for (const turn of kept) {
    out.push(turn.user);
    for (const reply of turn.assistants) out.push(reply);
  }
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
 * 是否走应用模式（服务端闸门）。判据集中在这里，`server.js` 只需一行调用——
 * 也让 `handleChat`/`runWebServer` 的函数行数不因这条分支而上涨（结构守卫只许降不许升）。
 *
 * v0.8.1 口径：`cfg.appApi.enabled` 是「默认预开启」；UI 开关（`body.appMode===true`）是**显式同意**，
 * 与 CLI `mingdao app` 一致（那条命令也不看这个开关）。仍要求模型是 flash 家族——
 * 服务端工具（`deepseek_web_search`/`deepseek_read_url`）在别的模型上会 400。
 * @param {any} body
 * @param {any} cfg
 * @param {string} model
 * @returns {boolean}
 */
export function shouldRunAppMode(body, cfg, model) {
  if (!body || body.appMode !== true) return false;
  return appModeEnabled(cfg) || supportsAppTools(String(model || ''));
}

/**
 * 应用模式使用的模型：`cfg.appApi.model` 优先，缺省回落官方应用模型 `deepseek-flash`。
 *
 * v0.8.2（T06，**依赖 T01/T06 落地**）：单一能力解析由 `deepseek-app.js#resolveAppModel` 提供
 * （CLI / Web / 配置归一必须同一结论）；它尚未导出时，这里用共享能力判据 `supportsAppTools`
 * 归一——不复制第二份「支持模型表」。未支持应用工具的模型一律回落 `APP_DEFAULT_MODEL`
 * （此前 Web 会原样保留 `deepseek-v4-pro`，与 CLI 口径不一致：DS-24）。
 * @param {any} cfg
 * @returns {string}
 */
export function appModelOf(cfg) {
  const single = /** @type {any} */ (deepseekApp).resolveAppModel;
  if (typeof single === 'function') return String(single(cfg));
  const model = cfg?.appApi?.model;
  const raw = typeof model === 'string' && model.trim() ? model.trim() : APP_DEFAULT_MODEL;
  return supportsAppTools(raw) ? raw : APP_DEFAULT_MODEL;
}
