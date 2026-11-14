// 批九十（v0.8.0）：DeepSeek「应用全家桶」API 客户端的变异验证。
//
// 目标：把 src/deepseek-app.js 里逐条协议形状改回缺陷，test/deepseek-app.js 必须当场红，
// 且失败输出里出现该条 `expect` 关键词（关键词 = 断言原文/断言值，防止"红是红了，但不是你改坏的那条"）。
//
// 覆盖：服务端工具丢声明 / safety_check 恒不下发 / title 恒不下发 / purpose 排到 file 之后 /
//       文件请求丢 beta 头 / TTS 用 x-api-key / 搜索结果不挂回 search / read_link 丢 signature /
//       citations 不累积 / 错误体只报状态码 / latest_reminder 少一项 / 流内 error 当成功。
//
// 用法：node test/mutate/batch90-app-api.mjs
import { makeMutator } from './lib.mjs';

const M = makeMutator();
const APP = () => M.suite('test/deepseek-app.js');
const F = 'src/deepseek-app.js';

// ① buildAppRequest 丢掉 tools：服务端搜索/阅读全部失效，但请求仍然 200。
M.mutate({
  name: '① 服务端工具丢声明（tools 恒不下发）',
  file: F,
  from: '  if (tools.length) body.tools = tools;',
  to: '  if (false) body.tools = tools; // 变异：服务端工具永不下发',
  expect: ['阅读链接在前、搜索在后'],
  run: APP,
});

// ② safety_check 恒不下发：对外服务失去基础风控（合规问题），请求照常成功。
// 注：命中 ① 之后的 next 断言（断言本身无文案），关键词取失败值 "level: 'high'"。
M.mutate({
  name: '② safety_check 恒不下发',
  file: F,
  from: "  if (safetyLevel && safetyLevel !== 'off') body.safety_check = { level: safetyLevel };",
  to: '  if (false) body.safety_check = { level: safetyLevel }; // 变异：安全校验恒不下发',
  expect: ["level: 'high'"],
  run: APP,
});

// ③ title 恒不下发：服务端标题白拿不到，退回「每会话多调一次模型」。
M.mutate({
  name: '③ title 恒不下发（服务端标题失效）',
  file: F,
  from: '  if (title) body.title = { enabled: true };',
  to: '  if (false) body.title = { enabled: true }; // 变异：服务端标题恒不下发',
  expect: ['enabled: true'],
  run: APP,
});

// ④ purpose 排到 file 之后：官方明确 400（整条文件链路当场不可用）。
M.mutate({
  name: '④ purpose 排到 file 之后（官方 400）',
  file: F,
  from: "  form.append('purpose', purpose);\n  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;\n  const blob = new Blob([/** @type {any} */ (bytes)], { type: mime });\n  form.append('file', blob, filename);",
  to: "  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;\n  const blob = new Blob([/** @type {any} */ (bytes)], { type: mime });\n  form.append('file', blob, filename);\n  form.append('purpose', purpose); // 变异：purpose 排到 file 之后",
  expect: ['purpose 必须排在 file 之前'],
  run: APP,
});

// ⑤ 文件上传请求不带 anthropic-beta：引用 file_id 时上游 400。
M.mutate({
  name: '⑤ 文件请求不带 anthropic-beta',
  file: F,
  from: "    const headers = { 'anthropic-beta': FILES_BETA };",
  to: '    const headers = {}; // 变异：文件请求不带 beta 头',
  expect: ['文件请求必须带 beta 头'],
  run: APP,
});

// ⑥ 语音合成用 x-api-key 而非 Bearer：语音端点鉴权方式不对（官方是 Bearer）。
// 注：ASR 的 Bearer 头目前没有独立断言（改坏 ASR 单独逃逸），见批次末尾的边界说明。
M.mutate({
  name: '⑥ TTS 用 x-api-key 而非 Bearer',
  file: F,
  from: "  const headers = { 'Content-Type': 'application/json' };\n  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;\n  const ctrl = new AbortController();\n  const timer = setTimeout(() => ctrl.abort(new Error('TTS 超时')), timeoutMs);",
  to: "  const headers = { 'Content-Type': 'application/json' };\n  if (apiKey) headers['x-api-key'] = String(apiKey); // 变异：语音端点改用 x-api-key\n  const ctrl = new AbortController();\n  const timer = setTimeout(() => ctrl.abort(new Error('TTS 超时')), timeoutMs);",
  expect: ['语音接口用 Bearer 而非 x-api-key'],
  run: APP,
});

// ⑦ applyAppEvent 不把搜索结果挂回发起它的 search：结果块变成孤儿，UI 只看到 query。
M.mutate({
  name: '⑦ 搜索结果不挂回发起它的 search',
  file: F,
  from: '      const last = out.searches[out.searches.length - 1];\n      if (last) last.results = results;',
  to: '      const last = out.searches[out.searches.length - 1]; // 变异：搜索结果不挂回 search',
  expect: ['搜索结果必须挂回发起它的那次 search'],
  run: APP,
});

// ⑧ read_link 的 signature 不保留：多轮无法还原页面（不报错、静默丢内容）。
M.mutate({
  name: '⑧ read_link 的 signature 不保留',
  file: F,
  from: "signature: block.signature || '' };",
  to: "signature: '' }; // 变异：signature 不保留",
  expect: ['read_link 的 signature 必须保留'],
  run: APP,
});

// ⑨ citations_delta 不累积：正文有角标数据源、但客户端 citations 恒空。
M.mutate({
  name: '⑨ citations_delta 不累积',
  file: F,
  from: "      const c = { url: delta.citation.url || '', title: delta.citation.title || '', cited: delta.citation.cited_text || '' };\n      out.citations.push(c);\n      onDelta?.({ type: 'citation', ...c });",
  to: "      const c = { url: delta.citation.url || '', title: delta.citation.title || '', cited: delta.citation.cited_text || '' };\n      // 变异：引用不累积\n      onDelta?.({ type: 'citation', ...c });",
  expect: ['0 !== 1'],
  run: APP,
});

// ⑩ 错误体只报 HTTP <code>：用户看不到 error.message（内容风控等可读原因被吃掉）。
M.mutate({
  name: '⑩ 错误体只报状态码（不取 error.message）',
  file: F,
  from: "export function appErrorMessage(raw) {\n  const text = String(raw || '').trim();",
  to: "export function appErrorMessage(raw) {\n  return ''; // 变异：错误体只报 HTTP <code>\n  const text = String(raw || '').trim();",
  expect: ['错误消息要透出'],
  run: APP,
});

// ⑪ latest_reminder 少一项：官方约定五项，少一项模型拿不到地点/渠道。
M.mutate({
  name: '⑪ latest_reminder 少一项',
  file: F,
  from: "  return [date, wd, location, channel, language].join(',');",
  to: "  return [date, wd, channel, language].join(','); // 变异：少一项（location 丢失）",
  expect: ['2026-11-14,Saturday,Web,中文'],
  run: APP,
});

// ⑫ 流内 error 当成功：HTTP 200 + error 事件被忽略，半截回答被当成完整答案。
M.mutate({
  name: '⑫ 流内 error 不判失败（半截回答当成功）',
  file: F,
  from: "          if (payload && payload.type === 'error') {\n            streamError = String(payload?.error?.message || payload?.error?.type || '生成中途失败');",
  to: "          if (false) {\n            streamError = String(payload?.error?.message || payload?.error?.type || '生成中途失败'); // 变异：流内 error 被忽略",
  expect: ['流内 error 必须判失败'],
  run: APP,
});

// 已知边界（不写成变异，因为当前测试钉不住，写出来避免误导）：
//   · ASR 的 Authorization: Bearer 头没有断言——单独把 transcribeAudio 改成 x-api-key 会逃逸；
//   · buildLatestReminder 的「UTC 日期」方向在 UTC 时区的 CI 上不可判定（本地/UTC 同一天），
//     所以只钉「少一项」这条确定性缺陷。

const ok = M.report();
process.exit(ok ? 0 : 1);
