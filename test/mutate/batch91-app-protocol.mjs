// 批九十一（v0.8.2）：DeepSeek「应用全家桶」的**本地协议预算器 + 流终态机 + 拒答落盘**变异验证。
//
// 目标：把 v0.8.2 新增/重写的安全关键逻辑逐条改回缺陷，`test/deepseek-app-contract.js`（T07 契约套件）
// 必须当场红，且失败输出里出现该条 `expect` 关键词（关键词 = 断言原文/断言值，防止"红是红了，
// 但不是你改坏的那条"）。
//
// 为什么需要这一批：v0.8.2 之前 `scripts/mutation-coverage.mjs` 实测
//   · src/app-protocol.js（217 代码行）0 条 —— 附件/语音预算与拒答文案的**唯一一份**规则；
//   · src/commands/app.js（680 代码行）0 条 —— 本地预算校验的接线处（100 MiB/32 MiB/20 个/8 MiB/120s/10000 字符）。
// 新增修复没有守卫 = 下一版可以悄悄改回去。本批把「改坏必须当场红」变成可回归的脚本。
//
// 覆盖（15 条）：
//   预算器（src/app-protocol.js）：单文件 100 MiB / 合计 32 MiB / 数量 20（差一）/ ASR 8 MiB /
//     ASR 120 秒 / TTS 10000 字符 / TTS 请求体 64 KiB / ASR 扩展名白名单放行 .mp3；
//   文件引用（src/commands/app.js）：图片退回 `image` 块（v0.8.1 的 400 缺陷）；
//   流终态机（src/deepseek-app.js）：缺 `message_stop` 当成功 / `event:error` 只按 payload.type 识别 /
//     配对键读外层 ev.tool_use_id / 未知 ID 回落"最后一次 search" / 能力门恢复子串匹配；
//   拒答不落盘（src/web/app-mode-run.js）：refused 仍走 appendMessages + done.ok:true。
//
// 用法：node test/mutate/batch91-app-protocol.mjs
import { makeMutator } from './lib.mjs';

const M = makeMutator();
const CONTRACT = () => M.suite('test/deepseek-app-contract.js');
const PROTOCOL = 'src/app-protocol.js';
const CMD = 'src/commands/app.js';
const APP = 'src/deepseek-app.js';
const RUN = 'src/web/app-mode-run.js';

// ① 单文件上限 100 MiB 改大：100 MiB + 1 字节的超限文件不再被本地拒绝（开始读/上传）。
M.mutate({
  name: '① 单文件 100 MiB 上限改大',
  file: PROTOCOL,
  from: 'export const DOC_MAX_BYTES = 100 * 1024 * 1024;',
  to: 'export const DOC_MAX_BYTES = 200 * 1024 * 1024; // 变异：单文件上限改大',
  expect: ['单文件上限'],
  run: CONTRACT,
});

// ② 请求内文档合计 32 MiB 改大：17×2 MiB（每个都未超 100 MiB）不再被拒，合计预算形同虚设。
M.mutate({
  name: '② 请求内文档合计 32 MiB 上限改大',
  file: PROTOCOL,
  from: '  if (totalBytes > DOCS_TOTAL_MAX_BYTES) {',
  to: '  if (totalBytes > DOCS_TOTAL_MAX_BYTES * 2) { // 变异：合计上限改大',
  expect: ['合计超 32 MiB 不得上传'],
  run: CONTRACT,
});

// ③ 最多 20 个文档：`>` 改 `>=`（差一）——恰好 20 个被误拒，官方允许的边界变成不可用。
M.mutate({
  name: '③ 文档数量 20 的边界差一（> 改 >=）',
  file: PROTOCOL,
  from: '  if (list.length > DOC_MAX_FILES) {',
  to: '  if (list.length >= DOC_MAX_FILES) { // 变异：差一，恰好 20 个被误拒',
  expect: ['恰好 20 个文件必须放行'],
  run: CONTRACT,
});

// ④ ASR 8 MiB 改大：8 MiB + 1 字节的音频不再本地失败（会继续读文件/解析头）。
M.mutate({
  name: '④ ASR 8 MiB 上限改大',
  file: PROTOCOL,
  from: 'export const ASR_MAX_BYTES = 8 * 1024 * 1024;',
  to: 'export const ASR_MAX_BYTES = 16 * 1024 * 1024; // 变异：ASR 体积上限改大',
  expect: ['8\\s*MiB|8\\s*MB|大小|超过'],
  run: CONTRACT,
});

// ⑤ ASR 120 秒改大：121 秒的 WAV 不再本地失败（转写请求照发，白烧费用/超限 400）。
M.mutate({
  name: '⑤ ASR 120 秒上限改大',
  file: PROTOCOL,
  from: 'export const ASR_MAX_SECONDS = 120;',
  to: 'export const ASR_MAX_SECONDS = 240; // 变异：ASR 时长上限改大',
  expect: ['121 秒必须本地失败'],
  run: CONTRACT,
});

// ⑥ TTS 10000 字符改大：10001 字符不再本地失败（合成请求照发）。
M.mutate({
  name: '⑥ TTS 10000 字符上限改大',
  file: PROTOCOL,
  from: 'export const TTS_MAX_CHARS = 10000;',
  to: 'export const TTS_MAX_CHARS = 20000; // 变异：TTS 字符上限改大',
  expect: ['超过 10000 字符必须本地失败'],
  run: CONTRACT,
});

// ⑦ TTS 请求体 64 KiB 改大：字符数合法但请求体超 64 KiB 的输入不再被拒。
M.mutate({
  name: '⑦ TTS 请求体 64 KiB 上限改大',
  file: PROTOCOL,
  from: 'export const TTS_MAX_BODY_BYTES = 64 * 1024;',
  to: 'export const TTS_MAX_BODY_BYTES = 128 * 1024; // 变异：TTS 请求体上限改大',
  expect: ['请求体超 64 KiB'],
  run: CONTRACT,
});

// ⑧ 图片退回 `image` 引用块：Files API 只接受 document 引用，图片 400/静默失效（v0.8.1 缺陷回归）。
M.mutate({
  name: '⑧ 图片引用块退回 image（v0.8.1 的 400 缺陷）',
  file: CMD,
  from: "export function blockTypeForFile(filename) {\n  // 保留 filename 参数（调用方/回归套件按此签名调用；判定不再依赖扩展名）。\n  void filename;\n  return 'document';\n}",
  to: "export function blockTypeForFile(filename) {\n  const ext = String(filename || '').toLowerCase().split('.').pop();\n  return ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tiff'].includes(ext) ? 'image' : 'document'; // 变异：图片退回 image 块（v0.8.1 的 400）\n}",
  expect: ['图片必须按 document 引用'],
  run: CONTRACT,
});

// ⑨ ASR 扩展名白名单放行 .mp3：不支持的格式不再在读文件/上传前本地失败（会白传一次）。
M.mutate({
  name: '⑨ ASR 扩展名白名单放行 .mp3',
  file: PROTOCOL,
  from: "  if (ext === 'wav') return 'wav';",
  to: "  if (ext === 'wav' || ext === 'mp3') return 'wav'; // 变异：放行 .mp3",
  expect: ['不支持的格式不得读取文件'],
  run: CONTRACT,
});

// ⑩ 缺 `message_stop` 也判成功：连接提前 EOF 的半截正文变成 ok:true（T01 回归）。
M.mutate({
  name: '⑩ 缺 message_stop 也判成功（截断当成功）',
  file: APP,
  from: '  if (!sawMessageStop) {',
  to: '  if (false && !sawMessageStop) { // 变异：截断也当成功',
  expect: ['提前 EOF 不是完整答案'],
  run: CONTRACT,
});

// ⑪ `event:error` 只按 payload.type 识别：无顶层 type 的官方错误帧不再给出可读原因（DS-06 回归）。
M.mutate({
  name: '⑪ event:error 只按 payload.type 识别（DS-06 回归）',
  file: APP,
  from: "      if (evt.event === 'error' || type === 'error' || (!type && payload.error)) {",
  to: "      if (type === 'error') { // 变异：只按 payload.type 识别流内错误",
  expect: ['generation start timeout'],
  run: CONTRACT,
});

// ⑫ 配对键改回外层 `ev.tool_use_id`：官方协议字段在 content_block 里，读外层 → 结果全成孤儿（DS-13/14 回归）。
M.mutate({
  name: '⑫ 配对键改回外层 ev.tool_use_id（DS-13 回归）',
  file: APP,
  from: "      const id = String(block.tool_use_id || '');\n      const pair = id ? pairingOf(out).get(id) : undefined;\n      const paired = Boolean(pair && pair.kind === 'search');",
  to: "      const id = String(ev.tool_use_id || '');\n      const pair = id ? pairingOf(out).get(id) : undefined;\n      const paired = Boolean(pair && pair.kind === 'search'); // 变异：配对键读外层 ev.tool_use_id",
  expect: ['并发结果必须按 tool_use_id 各归各的'],
  run: CONTRACT,
});

// ⑬ 未知 tool_use_id 回落"最后一次 search"：并发时 A 的结果静默挂到 B（DS-14 回归）。
M.mutate({
  name: '⑬ 未知 tool_use_id 回落最后一次 search（DS-14 回归）',
  file: APP,
  from: "      const id = String(block.tool_use_id || '');\n      const pair = id ? pairingOf(out).get(id) : undefined;\n      const paired = Boolean(pair && pair.kind === 'search');",
  to: "      const id = String(block.tool_use_id || '');\n      const pair = out.searches.length ? { kind: 'search', item: out.searches[out.searches.length - 1] } : undefined; // 变异：未知 ID 回落最后一次 search\n      const paired = Boolean(pair && pair.kind === 'search');",
  expect: ['未知结果不能污染已知搜索'],
  run: CONTRACT,
});

// ⑭ 能力门恢复子串匹配：`custom-deepseek-flash-*` / `notdeepseek-flash` 也能开应用工具 → 上游 400（DS-23 回归）。
M.mutate({
  name: '⑭ 能力门恢复 deepseek-flash 子串匹配（DS-23 回归）',
  file: APP,
  from: '  return Boolean(id) && APP_TOOL_MODEL_IDS.includes(id);',
  to: '  return Boolean(id) && /deepseek-flash/.test(id); // 变异：恢复子串匹配',
  expect: ['伪冒后缀不得通过能力门'],
  run: CONTRACT,
});

// ⑮ 拒答仍走 appendMessages + done.ok:true：被撤回的正文落盘、界面收到成功（DS-12 回归）。
M.mutate({
  name: '⑮ 拒答仍走成功/落盘路径（DS-12 回归）',
  file: RUN,
  from: "    if (refused) {\n      if (!refusalSent) send({ type: 'appRefusal', message: APP_REFUSAL_MESSAGE });\n      // 拒答也是一次真实上游调用：保留 usage 入账（审计需要），但**不落正文**。\n      await recordAppUsage(r.usage);\n      entry.status = 'failed';\n      entry.durationMs = Date.now() - entry.startedAt;\n      srvlog(`chat 应用模式拒答 ${taskId} 已撤回已流出正文，未写入会话 ${entry.durationMs}ms`);\n      finishChat(chatFailure(APP_REFUSAL_MESSAGE, ''));\n      return;\n    }\n    if (r.ok) {",
  to: "    if (false) {\n      if (!refusalSent) send({ type: 'appRefusal', message: APP_REFUSAL_MESSAGE });\n      await recordAppUsage(r.usage);\n      entry.status = 'failed';\n      entry.durationMs = Date.now() - entry.startedAt;\n      srvlog(`chat 应用模式拒答 ${taskId} 已撤回已流出正文，未写入会话 ${entry.durationMs}ms`);\n      finishChat(chatFailure(APP_REFUSAL_MESSAGE, ''));\n      return;\n    }\n    if (r.ok || refused) { // 变异：拒答仍走成功/落盘路径",
  expect: ['拒答不得调用正常消息落盘'],
  run: CONTRACT,
});

const ok = M.report();
process.exit(ok ? 0 : 1);
