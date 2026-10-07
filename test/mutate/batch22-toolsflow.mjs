// 批二十二（v0.6.11：工具编排两端的判据抽成纯函数，审计 P1-1 第三刀）的变异验证
//
// 覆盖三类变异：
//   · `visibleToolsFor()` 的五处边界（已用工具保留 / 全量档 / 白名单短名 / 白名单作用域 / MCP 放行）；
//   · `serializeToolResult()` 与 `toolResultMessage()` 的四条回填规则（序列化 / 前缀 / 约束拒绝 / 截断口径）；
//   · `agent.js` 里**又抄回内联实现**（两种写法 + 序列化 + 回填正文各一条）——由 §136 的单源结构守卫抓。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SEC = () => M.section('136');

M.mutate({
  name: '① 只读档丢掉"本会话已用过的工具"（上一轮用过 write，这一轮只读提问就突然不可见）',
  file: 'src/tools-flow.js',
  from: '    if (READONLY_TIER_SET.has(n) || usedNames.has(n)) return true;',
  to: '    if (READONLY_TIER_SET.has(n)) return true;',
  expect: ['本会话已用过的工具在只读档必须保持可见'],
  run: SEC,
});

M.mutate({
  name: '② 全量档也走只读过滤（任务回合里写类工具不可见 → 任务做不了且用户看不出原因）',
  file: 'src/tools-flow.js',
  from: '  if (!readOnlyPhase) return list;',
  to: '  if (false) return list;',
  expect: ['全量档（readOnlyPhase=false）必须原样放出全部工具'],
  run: SEC,
});

M.mutate({
  name: '③ 预设白名单只在只读档生效（全量档能拿到白名单外的工具 → 预设形同虚设）',
  file: 'src/tools-flow.js',
  from: '  if (presetToolSet) {',
  to: '  if (readOnlyPhase && presetToolSet) {',
  expect: ['预设只减不增'],
  run: SEC,
});

M.mutate({
  name: '④ 预设里的 MCP 短名（srv__read）不再换算 → 白名单点名的 MCP 工具被误杀',
  file: 'src/tools-flow.js',
  from: '      return presetToolSet.has(n) || (n.startsWith(\'mcp__\') && presetToolSet.has(n.slice(5)));',
  to: '      return presetToolSet.has(n);',
  expect: ['短名'],
  run: SEC,
});

M.mutate({
  name: '⑤ 只读档对 MCP 工具默认放行（未授信服务器谎称只读即可绕过权限确认）',
  file: 'src/tools-flow.js',
  from: '    if (n.startsWith(\'mcp__\')) return isMcpReadonly ? isMcpReadonly(n) : false;',
  to: '    if (n.startsWith(\'mcp__\')) return true;',
  expect: ['只读档只发只读档工具'],
  run: SEC,
});

M.mutate({
  name: '⑥ 字符串结果也被 JSON 序列化（回填正文被包一层引号/转义，模型看到的是 JSON 字符串）',
  file: 'src/tools-flow.js',
  from: "  return typeof result === 'string' ? result : JSON.stringify(result);",
  to: '  return JSON.stringify(result);',
  expect: ['字符串结果必须原样回填'],
  run: SEC,
});

M.mutate({
  name: '⑦ `undefined` 结果被兜底成 "null"（把既有口径悄悄改掉）',
  file: 'src/tools-flow.js',
  from: "  return typeof result === 'string' ? result : JSON.stringify(result);",
  to: "  return typeof result === 'string' ? result : (JSON.stringify(result) ?? 'null');",
  expect: ['undefined'],
  run: SEC,
});

M.mutate({
  name: '⑧ 复用前缀丢掉（模型不知道这是同回合相同调用的复用结果）',
  file: 'src/tools-flow.js',
  from: "  const prefix = cached ? '（与同回合相同调用结果一致，已复用）\\n' : '';",
  to: "  const prefix = '';",
  expect: ['复用前缀必须逐字出现'],
  run: SEC,
});

M.mutate({
  name: '⑨ 领域约束拒绝不再改写正文（缺项结果照旧回填 →「缺项绝不编造」失效）',
  file: 'src/tools-flow.js',
  from: '  const body = post?.rejected ? `【领域约束】${post.reason}` : text;',
  to: '  const body = text;',
  expect: ['领域约束拒绝必须整段替换原文'],
  run: SEC,
});

M.mutate({
  name: '⑩ 截断把复用前缀也算进上限（恰好等于上限的结果被误截断）',
  file: 'src/tools-flow.js',
  from: '  return prefix + clampText(body, cap);',
  to: '  return clampText(prefix + body, cap);',
  expect: ['复用前缀不计入截断上限'],
  run: SEC,
});

// —— 以下四条改的是 agent.js：单源被破坏（"抽出去了又抄一份回来"）——
M.mutate({
  name: '⑪ agent.js 又抄回只读档过滤（READONLY_TIER_SET.has(...) 内联版）',
  file: 'src/agent.js',
  from: `  const toolsFor = (/** @type {boolean} */ readOnlyPhase, /** @type {Set<string>} */ usedNames) =>
    visibleToolsFor(buildToolSchemas(usedNames, mcpSchemas()), {
      readOnlyPhase,
      usedNames,
      presetToolSet,
      // MCP 的只读标注按名查询；\`isReadonly\` 是 mcp 对象上的方法（内部用 this），必须包一层
      isMcpReadonly: mcp ? (/** @type {string} */ n) => mcp.isReadonly(n) : null,
    });`,
  to: `  const toolsFor = (/** @type {boolean} */ readOnlyPhase, /** @type {Set<string>} */ usedNames) => {
    const schemas = buildToolSchemas(usedNames, mcpSchemas());
    if (!readOnlyPhase) return schemas;
    return schemas.filter((/** @type {any} */ t) => {
      const n = t?.function?.name;
      if (!n) return true;
      if (READONLY_TIER_SET.has(n) || usedNames.has(n)) return true;
      if (n.startsWith('mcp__')) return mcp ? mcp.isReadonly(n) : false;
      return false;
    });
  };`,
  expect: ['不得再内联只读档可见性判据'],
  run: SEC,
});

M.mutate({
  name: '⑪b agent.js 又抄回只读档过滤（**换一种写法**：只读档集合写成字面量、快照改叫 strippedSet）',
  file: 'src/agent.js',
  from: `  const toolsFor = (/** @type {boolean} */ readOnlyPhase, /** @type {Set<string>} */ usedNames) =>
    visibleToolsFor(buildToolSchemas(usedNames, mcpSchemas()), {
      readOnlyPhase,
      usedNames,
      presetToolSet,
      // MCP 的只读标注按名查询；\`isReadonly\` 是 mcp 对象上的方法（内部用 this），必须包一层
      isMcpReadonly: mcp ? (/** @type {string} */ n) => mcp.isReadonly(n) : null,
    });`,
  to: `  const toolsFor = (/** @type {boolean} */ readOnlyPhase, /** @type {Set<string>} */ strippedSet) => {
    const schemas = buildToolSchemas(strippedSet, mcpSchemas());
    if (!readOnlyPhase) return schemas;
    const tier = new Set(['read', 'ls', 'glob', 'grep', 'skill', 'todo', 'git', 'fetch', 'task']);
    return schemas.filter((/** @type {any} */ t) => {
      const nm = t?.function?.name;
      if (!nm) return true;
      return tier.has(nm) || strippedSet.has(nm) || nm.startsWith('mcp__');
    });
  };`,
  expect: ['不得再内联只读档可见性判据'],
  run: SEC,
});

M.mutate({
  name: '⑫ agent.js 又抄回结果序列化（typeof result === \'string\' ? result : JSON.stringify(result)）',
  file: 'src/agent.js',
  from: '          const text = serializeToolResult(result); // 紧凑 JSON（评估 B3）：嵌套结果省 10-20% 回填 token，且下轮按 prompt 重复计费',
  to: "          const text = typeof result === 'string' ? result : JSON.stringify(result); // 紧凑 JSON（评估 B3）：嵌套结果省 10-20% 回填 token，且下轮按 prompt 重复计费",
  expect: ['不得再内联工具结果回填的判据'],
  run: SEC,
});

M.mutate({
  name: '⑬ agent.js 又抄回回填正文（复用前缀 + 约束拒绝 + clampText 三件套内联版）',
  file: 'src/agent.js',
  from: '            content: toolResultMessage(text, { cached: prep.cached, cap: toolResultCap, post: pv }),',
  to: "            content: (prep.cached ? '（与同回合相同调用结果一致，已复用）\\n' : '') + clampText(pv?.rejected ? `【领域约束】${pv.reason}` : text, toolResultCap),",
  expect: ['不得再内联工具结果回填的判据'],
  run: SEC,
});

if (!M.report()) process.exit(1);
