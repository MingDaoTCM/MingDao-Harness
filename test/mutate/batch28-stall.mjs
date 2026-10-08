// 批二十八（v0.6.13 A/B/C：本地模型"零信号长回合" + 端点预检 + 预设按语义拆分）的变异验证
//
// 三件事的修复形状都是"一条纪律 + 一处透出 + 一条判据"，所以变异逐条打在这些点上：
//
// A（真机：本地 35B 的审计回合跑了 4+ 小时、界面 0 步、web-server.log 零行；audit.jsonl 里
//    610 次工具调用大多是**逐字重复**的失败调用）：
//   · 看门狗整个去掉                     → §139 必须红（永不发帧的上游会挂死）；
//   · 阈值放成 0 / 无穷 / 拿配置关掉它    → §139 必须红（一次慢 prefill 就被误判或永远不响）；
//   · 把"轮次返回"当进展（真机现场：每十几分钟回一次同样的失败调用） → §139 必须红；
//   · 重复/失败的工具调用也算进展          → §139 必须红；
//   · 上游错误原文被吞掉 / 可操作解读被删  → §139 必须红；
//   · "0 次工具调用"收尾提示被删           → §139 必须红；
//   · 发送前规模预告 / TTFT / 进度日志被删 → §139 必须红（"在跑"与"卡死"又变得无法区分）。
//
// A 追加（端点预检）：
//   · 探针把一次结果当结论（不重复 N 次）  → §139 必须红（负责人实测同一端点两次结果相反）；
//   · 被 max_tokens 截断的样本当成"不支持" → §139 必须红（思考型模型会先输出思考）；
//   · 预检结果被忽略（不喂给自适应/界面）  → §139 必须红（预检变成装饰）；
//   · 自适应把首帧上限压到既有默认之下     → §139 必须红（比现状更激进 = 明确禁止）。
//
// B（下拉里看不出"来自哪个端点"）：
//   · 自定义条目退回 providerLabel='自定义' → §139 必须红（来源标注丢了）；
//   · 服务商线上名单与自定义端点混为一谈    → §139 必须红；
//   · 能力覆盖（只写 contextWindow）被当成端点 → §139 必须红（会让人以为换了请求去向）。
//
// C（预设名与内容不符）：
//   · local-model 把审计人格/工具白名单/权限字段写回来 → api-contracts 必须红；
//   · 老名字 local-audit 的别名被删（静默消失）        → api-contracts 必须红；
//   · 别名命中后不再提示"已更名"                      → §139 必须红。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SEC = () => M.section('139');
const CONTRACTS = () => M.suite('test/api-contracts.js');

// —— A：无进展看门狗 ——
M.mutate({
  name: '① 看门狗整个去掉（回到"挂到天亮"）',
  file: 'src/agent.js',
  from: '      noProgressTimer = setTimeout(fireNoProgress, left);',
  to: '      noProgressTimer = setTimeout(() => {}, left);',
  expect: ['看门狗没生效'],
  run: SEC,
});

M.mutate({
  name: '② 阈值默认值改成 0（配置里不写就等于关掉看门狗）',
  file: 'src/agent.js',
  from: 'export const DEFAULT_NO_PROGRESS_TIMEOUT_MS = 3600000;',
  to: 'export const DEFAULT_NO_PROGRESS_TIMEOUT_MS = 0;',
  expect: ['默认阈值'],
  run: SEC,
});

M.mutate({
  name: '③ 阈值可以配成无穷（= 永远不响，退化回"零信号"）',
  file: 'src/agent.js',
  from: '  const v = Number(cfg?.noProgressTimeoutMs);\n  return Number.isFinite(v) && v > 0 ? v : DEFAULT_NO_PROGRESS_TIMEOUT_MS;',
  to: '  const v = Number(cfg?.noProgressTimeoutMs);\n  return v > 0 ? v : DEFAULT_NO_PROGRESS_TIMEOUT_MS;',
  expect: ['noProgressTimeoutMs=Infinity 必须回落默认'],
  run: SEC,
});

M.mutate({
  name: '④ 把"模型轮次返回"当进展（真机现场：每十几分钟回一次同样的失败调用 → 看门狗永不响）',
  file: 'src/agent.js',
  from: "        if (res.text || res.reasoning) markProgress('模型轮次返回（有正文/推理）');",
  to: "        markProgress('模型轮次返回');",
  expect: ['重复/失败的工具调用不算进展', '重复失败的工具循环必须被看门狗收口'],
  run: SEC,
});

M.mutate({
  name: '⑤ 重复/失败的工具结果也算进展（"工具在跑、什么都没做成"又抓不住了）',
  file: 'src/agent.js',
  from: '          if (toolOk && repeatedBefore === 0) markProgress(`工具 ${prep.name} 返回`);',
  to: '          if (true) markProgress(`工具 ${prep.name} 返回`);',
  expect: ['重复/失败的工具调用不算进展', '重复失败的工具循环必须被看门狗收口'],
  run: SEC,
});

M.mutate({
  name: '⑥ 子代理不再继承父回合的截止时刻（24 个并行子代理各自跑满，父回合看起来就是挂死）',
  file: 'src/agent.js',
  from: '        ...(currentTurnProgress\n          ? { turnProgressDeadlineAt: currentTurnProgress.lastProgressAt + currentTurnProgress.noProgressMs }\n          : {}),',
  to: '        ...({}),',
  expect: ['spawnTask 必须把父回合的截止时刻传给子代理'],
  run: SEC,
});

// —— A：上游错误透出 / 0 次工具调用 / 可观测性 ——
M.mutate({
  name: '⑦ 上游错误只原样抛出（丢掉"这是什么 + 该怎么办"）',
  file: 'src/agent.js',
  from: '          const d = describeUpstreamError(e);\n          if (d.hint) {',
  to: '          const d = describeUpstreamError(e);\n          if (false) {',
  expect: ['错误消息必须带上可操作解读'],
  run: SEC,
});

M.mutate({
  name: '⑧ 模板类错误不再给出"该端点不做工具调用/模板不匹配"的判断',
  file: 'src/agent.js',
  from: '  if (/jinja|template|no user query|parser for this template/.test(t)) {',
  to: '  if (false) {',
  expect: ['模板类错误必须给出可操作判断'],
  run: SEC,
});

M.mutate({
  name: '⑨ 回合收尾不再说"0 次工具调用"（端点不返回 tool_calls 时又变成"看起来一切正常"）',
  file: 'src/agent.js',
  from: "  if (!(Number(modelRounds) > 1) && !taskLike) return '';",
  to: "  return '';",
  expect: ['0 次工具调用'],
  run: SEC,
});

M.mutate({
  name: '⑩ 发送前的规模预告不再打印（本地 prefill 又只能靠猜）',
  file: 'src/agent.js',
  from: '          if (turnProgress.llmCalls === 0 || f.warn) io.print(style(f.text, f.warn ? C.yellow : C.dim));',
  to: '          if (false) io.print(style(f.text, f.warn ? C.yellow : C.dim));',
  expect: ['发送前必须打出一条上下文规模预告'],
  run: SEC,
});

M.mutate({
  name: '⑪ 首帧时延（TTFT）不再统计/透出（本地模型最关键的指标没了）',
  file: 'src/agent.js',
  from: '            if (turnProgress.ttftMs == null) turnProgress.ttftMs = ttft;',
  to: '            if (false) turnProgress.ttftMs = ttft;',
  expect: ['TTFT 必须是数字'],
  run: SEC,
});

M.mutate({
  name: '⑫ web-server.log 不再定期落进度行（"在跑"与"卡死"事后又无法区分）',
  file: 'src/web/server.js',
  from: '        `chat 进度 ${taskId} ` +',
  to: '        `` +',
  expect: ['服务端必须定期往 web-server.log 落"chat 进度"行'],
  run: SEC,
});

// —— A 追加：端点预检 ——
M.mutate({
  name: '⑬ 工具探针只跑一次就当结论（负责人实测同一端点两次结果相反：2.7s 有 / 23.9s 无）',
  file: 'src/model-discovery.js',
  from: '    repeats = 3,',
  to: '    repeats = 1,',
  expect: ['必须重复 3 次并如实记命中次数'],
  run: SEC,
});

M.mutate({
  name: '⑭ 被 max_tokens 截断的样本（finish_reason=length）当成"不支持工具调用"',
  file: 'src/model-discovery.js',
  from: "        const conclusive = r.toolCalls || finish === 'tool_calls' || finish === 'stop';",
  to: '        const conclusive = true;',
  expect: ['不可判定'],
  run: SEC,
});

M.mutate({
  name: '⑮ 预检结果被忽略（不喂给发送前预告 / 不做自适应）',
  file: 'src/web/server.js',
  from: '          chatCfg = { ...chatCfg, endpointProbe: probe };',
  to: '          chatCfg = { ...chatCfg };',
  expect: ['发送前的规模预告里必须带上端点预检结论', '服务端必须把端点预检结论交给本回合'],
  run: SEC,
});

M.mutate({
  name: '⑯ 自适应把首帧上限压到既有默认之下（比现状更激进 → 慢 prefill 被误杀）',
  file: 'src/model-discovery.js',
  from: '    explicitFirst ?? (measured || prefill ? Math.min(1800000, Math.max(floorFirst, Math.round(Math.max(measured ? measured * 20 : 0, prefill ? prefill * 5 : 0)))) : floorFirst);',
  to: '    explicitFirst ?? (measured ? Math.max(1000, Math.round(measured)) : floorFirst);',
  expect: ['首帧上限仍是既有默认 600s'],
  run: SEC,
});

// —— B：下拉来源标注 ——
M.mutate({
  name: '⑰ 自定义条目退回 providerLabel="自定义"（下拉里又看不出"来自哪个端点"）',
  file: 'src/model-discovery.js',
  from: '      providerLabel: src.providerLabel,',
  to: "      providerLabel: '自定义',",
  expect: ['下拉分组名必须带端点'],
  run: SEC,
});

M.mutate({
  name: '⑱ 自定义端点不再显式标"自定义端点"（chatflow 应用名又被当成官方模型）',
  file: 'src/model-discovery.js',
  from: "    const sourceLabel = `自定义端点 · ${where}`;",
  to: "    const sourceLabel = `自定义 · ${where}`;",
  expect: ['自定义条目必须标出"自定义端点"'],
  run: SEC,
});

M.mutate({
  name: '⑲ 服务商线上名单与自定义端点混为一谈（来源标注失去区分度）',
  file: 'src/model-discovery.js',
  from: "        source: preset ? 'preset' : 'discovered',",
  to: "        source: 'custom-endpoint',",
  expect: ['内置预设条目必须标为官方预设'],
  run: SEC,
});

M.mutate({
  name: '⑳ 能力覆盖（只写 contextWindow）被当成端点声明（让人以为改了请求去向）',
  file: 'src/model-discovery.js',
  from: '  const isEndpoint = Boolean(pc && /^custom[:/]/.test(String(pc.name || \'\'))) || /^custom[:/]/i.test(String(cmName));',
  to: '  const isEndpoint = true;',
  expect: ['只写能力字段的条目不得被当成端点'],
  run: SEC,
});

// —— C：预设按语义拆分 ——
M.mutate({
  name: '㉑ 本地模型预设把审计人格写回来（负责人原话：本地模型不是审计专用）',
  file: 'presets/local-model.json',
  from: '  "contextBudget": 65536,',
  to: '  "systemPrompt": "你是一名代码审计员。",\n  "contextBudget": 65536,',
  expect: ['本地模型预设不得携带审计人格'],
  run: CONTRACTS,
});

M.mutate({
  name: '㉒ 本地模型预设把只读工具白名单写回来（本地模型"功能不一致"）',
  file: 'presets/local-model.json',
  from: '  "contextBudget": 65536,',
  to: '  "tools": ["read", "ls", "glob", "grep"],\n  "contextBudget": 65536,',
  expect: ['本地模型预设不得限制工具白名单'],
  run: CONTRACTS,
});

M.mutate({
  name: '㉓ 本地模型预设带上 recommendedPermission（参数预设替用户表达权限偏好）',
  file: 'presets/local-model.json',
  from: '  "contextBudget": 65536,',
  to: '  "recommendedPermission": "readonly",\n  "contextBudget": 65536,',
  expect: ['本地模型预设不得携带权限建议'],
  run: CONTRACTS,
});

M.mutate({
  name: '㉔ 老名字 local-audit 的别名被删（下游按名引用的配置静默失效）',
  file: 'src/presets.js',
  from: "const PRESET_ALIASES = /** @type {Record<string, string>} */ ({ 'local-audit': 'local-model' });",
  to: 'const PRESET_ALIASES = /** @type {Record<string, string>} */ ({});',
  expect: ['老名字 local-audit 必须以**别名**形式写在新预设上'],
  run: CONTRACTS,
});

M.mutate({
  name: '㉕ 别名命中后不再标注"从哪个老名字来"（WebUI 无从提示已更名）',
  file: 'src/presets.js',
  from: '    return alias && hit.name === alias.to ? { ...obj, aliasedFrom: alias.from } : obj;',
  to: '    return obj;',
  expect: ['别名调用必须留下"从哪个老名字来的"标记'],
  run: SEC,
});

M.mutate({
  name: '㉖ 只读审计预设不再透出 recommendedPermission（"建议"没了）',
  file: 'presets/readonly-audit.json',
  from: '  "recommendedPermission": "readonly",\n',
  to: '',
  expect: ['必须透出 recommendedPermission=readonly'],
  run: CONTRACTS,
});

if (!M.report()) process.exit(1);
