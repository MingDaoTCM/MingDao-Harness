// 工具编排的**两端**（v0.6.11，审计 P1-1 拆分第三刀：从 `agent.js` 的 `runTurn` 里抽出）。
//
// 这一刀切的是「工具编排」的头尾两处**纯判据**——它们此前埋在约 1500 行的 `runTurn` 里、
// 依赖闭包外的若干变量，只能靠端到端（造真实回合）间接验证：
//
//   ① `visibleToolsFor()` / `READONLY_TIER_SET` —— 本轮**发给模型哪些工具**
//      （只读档 × 预设白名单 × 本会话已用工具快照 × MCP 只读标注）；
//   ② `serializeToolResult()` / `toolResultMessage()` —— 工具结果**怎么回填给模型**
//      （字符串原样 / 对象紧凑 JSON × 复用前缀 × 领域约束拒绝 × 按窗口截断）。
//
// 两端都只是"判据"：打印、审计、账本、`messages.push` 等副作用仍留在 `agent.js`，
// 所以这里可以是纯函数，边界也因此能被逐条钉死（见 `test/smoke.js` §136）。
//
// **零行为变化**：本文件里每个分支都与抽取前的 `agent.js` **逐字同源**（同样的条件、同样的文案、
// 同样的顺序）。抽取时发现的可疑之处**只登记、不顺手改**（否则"重构"就混进了行为变更）。
//
// 回填之所以拆成"序列化 → 正文"两个函数，而不是合成一个大函数，正是为了**保持原来的求值顺序**：
// 原来 `JSON.stringify(result)` 发生在 `checkPostTool()` **之前**（约束检查抛错/慢的差异都被保留），
// agent.js 里 `const text = serializeToolResult(result);` 就是原来那一行，位置一字未动。

import { clampText } from './context.js';

// 只读档工具集（省钱 B1 的「只读阶段」）——模块级单一来源。
// v0.4.6：此前 test/bench 各自维护一份副本，已经漂移（漏了 v0.4.4 加入的 task），
// 导致基准测的不是真实只读档。导出后基准与实现共用同一集合。
//
// v0.6.11（P1-1 第三刀）：定义从 `agent.js` 移到本模块——它与 `visibleToolsFor()` 是**同一条判据**
// （"只读阶段给哪些工具"），放在一起才能保证"改一处就够"。`agent.js` 仍原样再导出该常量，
// bench/smoke 既有的 `from './agent.js'` 导入面不变。
export const READONLY_TIER_SET = new Set(['read', 'ls', 'glob', 'grep', 'skill', 'todo', 'git', 'fetch', 'task']);

/**
 * 本轮**可见**的工具 schema。
 *
 * 抽取前是 `agent.js` 里的闭包 `toolsFor(readOnlyPhase, strippedSet)`，从 `buildToolSchemas()` 的
 * 产物出发做两道过滤。**行为清单**（输入 → 输出，逐条与抽取前一致）：
 *
 * 一、预设白名单（`presetToolSet` 非空时**先**做一次，`cfg.presetTools`）——预设只减不增：
 *   1. 条目取不到工具名（`t?.function?.name` 为假值：`t` 缺失 / `function` 缺失 / `name` 为空串）
 *      → **保留**（判断不了就不误删，自定义条目照旧）；
 *   2. 否则保留当且仅当 `presetToolSet.has(n)`，**或** `n` 以 `mcp__` 开头且
 *      `presetToolSet.has(n.slice(5))`（预设里写 `server__tool` 也能匹配 `mcp__server__tool`）；
 *   3. 白名单过滤在**两个阶段都生效**（全量档同样只能看见白名单内的工具）。
 *
 * 二、只读阶段（`readOnlyPhase === false`，即注入全量工具的回合）——到此为止，
 *   **写类工具（write/edit/bash/自定义/Pack 工具）照常可见**。
 *
 * 三、只读阶段（`readOnlyPhase === true`）——再过滤一次：
 *   4. 无名条目 → 保留（同 1）；
 *   5. `READONLY_TIER_SET.has(n)` → 保留（read/ls/glob/grep/skill/todo/git/fetch/task）；
 *   6. **或** `usedNames.has(n)`（本会话已调用过）→ 保留：这些工具的 schema 描述已被剥掉、
 *      模型在消息历史里见过用途；若只因"这一轮是提问"就把它藏起来，"上一轮用过 write、
 *      这一轮只读提问"会突然不可见；
 *   7. `n` 以 `mcp__` 开头 → 当且仅当给了 `isMcpReadonly` 且 `isMcpReadonly(n)` 为真才保留；
 *      **没有 MCP 客户端（`isMcpReadonly` 为 null）时一律丢掉**——不是"默认放行"
 *      （未授信服务器可谎称只读，判定在 `src/mcp.js` 里）；
 *   8. 其余一律丢掉。
 *
 * 四、纯函数：不读全局、不改入参（`filter` 返回新数组），输出保持输入相对顺序。
 *
 * @param {any[]} schemas `buildToolSchemas(...)` 的产物（本函数原样接收，便于单测直接喂桩）
 * @param {{ readOnlyPhase?: boolean, usedNames?: Set<string>, presetToolSet?: Set<string>|null,
 *   isMcpReadonly?: ((name: string) => boolean)|null }} [opts]
 *   `usedNames` 缺省视为空集合（= 本会话还没用过任何工具）；`presetToolSet` 缺省视为不过滤
 * @returns {any[]} 可见工具 schema（顺序与输入一致）
 */
export function visibleToolsFor(schemas, { readOnlyPhase = false, usedNames = new Set(), presetToolSet = null, isMcpReadonly = null } = {}) {
  let list = schemas;
  if (presetToolSet) {
    list = list.filter((/** @type {any} */ t) => {
      const n = t?.function?.name;
      if (!n) return true;
      return presetToolSet.has(n) || (n.startsWith('mcp__') && presetToolSet.has(n.slice(5)));
    });
  }
  if (!readOnlyPhase) return list;
  return list.filter((/** @type {any} */ t) => {
    const n = t?.function?.name;
    if (!n) return true;
    if (READONLY_TIER_SET.has(n) || usedNames.has(n)) return true;
    if (n.startsWith('mcp__')) return isMcpReadonly ? isMcpReadonly(n) : false;
    return false;
  });
}

/**
 * 工具结果 → 回填文本（**序列化那一步**，与下一步的"消息正文"分开是为了保持原来的求值顺序）。
 *
 * 抽取前是 `agent.js` 里的一行：
 * `let text = typeof result === 'string' ? result : JSON.stringify(result);`
 *
 * 行为清单：
 *   1. `result` 是字符串 → **原样**使用（工具已经返回了给模型看的文本，不再包一层 JSON 引号）；
 *   2. 否则 → `JSON.stringify(result)` 紧凑 JSON（评估 B3：嵌套结果省 10~20% 回填 token，
 *      且这些 token 下一轮按 prompt 重复计费）；
 *   3. 不做任何兜底/异常处理：`JSON.stringify` 抛错（循环引用）照旧上抛，
 *      `undefined`/函数仍返回 `undefined`（见 `toolResultMessage` 的第 1 条边界）。
 *
 * @param {any} result `dispatch()` / `mcp.call()` 的返回（多数是 `{ok, output|error}` 对象或 JSON 字符串）
 * @returns {string} 待回填文本（运行时可能是 `undefined`，与抽取前一致）
 */
export function serializeToolResult(result) {
  return typeof result === 'string' ? result : JSON.stringify(result);
}

/**
 * 工具结果回填给模型的**消息正文**（`messages.push({role:'tool', content})` 的那个 content）。
 *
 * 抽取前是 `finishTool()` 结尾的三行：复用前缀、领域约束拒绝文案、按窗口截断。
 * **行为清单**：
 *   1. 截断：`clampText(text, cap)`——`cap` 是 `toolResultCap`（按模型窗口 1/16，2000~20000 字）；
 *      超长时尾部附 `…[输出过长已截断，原文共 N 字符]`。传 `undefined` 时用 `clampText` 自己的默认值。
 *      边界（与抽取前一致，本节只负责钉住、不负责改）：`text` 为 `undefined` 时 `clampText` 内部
 *      `String()` 得到字符串 `'undefined'`；
 *   2. 复用前缀：`cached` 为真（同回合相同参数的回调命中只读去重缓存）→ 正文前缀
 *      `（与同回合相同调用结果一致，已复用）\n`，**且该前缀不计入 `cap`**（先截断、后加前缀）；
 *   3. 领域约束（PostToolUse，v0.5.0 A3②）：`post.rejected` 为真 → 正文**整段替换**为
 *      `【领域约束】${post.reason}`（原始结果不再回填，模型必须继续采集，
 *      「缺项绝不编造」从提示词升级为内核强制）；替换后的文本同样过截断、同样带复用前缀；
 *   4. 纯函数：不打印、不写审计、不改入参——`auditConstraint` 等副作用仍由调用方负责（顺序不变）。
 *
 * @param {string} text `serializeToolResult()` 的产物
 * @param {{ cached?: boolean, cap?: number, post?: any }} [opts]
 *   `post` 是 `checkPostTool()` 的返回值（null/undefined = 无约束或未命中）
 * @returns {string} 回填正文
 */
export function toolResultMessage(text, { cached = false, cap = undefined, post = null } = {}) {
  const prefix = cached ? '（与同回合相同调用结果一致，已复用）\n' : '';
  const body = post?.rejected ? `【领域约束】${post.reason}` : text;
  return prefix + clampText(body, cap);
}
