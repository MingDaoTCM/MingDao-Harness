// 批三十二（v0.6.17 开发线：P1-1 第四刀——工具参数"前置门"最前端的纯判据 `parseToolArgs` +
// 顶层空值回填修复）。每条变异都必须让 §143 当场红，关键词取断言原文：
//
// A. `parseToolArgs()` 的边界（六条）：
//   ① `!args` 分支被拿掉（JSON `null` 保持 null 交给工具）           → §143 必须红；
//   ② `Array.isArray` 分支被拿掉（JSON 数组直接当工具参数）           → §143 必须红；
//   ③ 拒绝文案被改短（模型/用户看不到"输出超限被截断？建议分块"）     → §143 必须红；
//   ④ 回填文案丢掉 6000 字符分块指引（模型不知道该怎么重试）           → §143 必须红；
//   ⑤ 加上"从文本里抠 JSON"的宽容（代码围栏/尾巴被容忍）             → §143 必须红；
//   ⑥ 解析器里加 6000 字符闸门（合法超长参数被误杀）                   → §143 必须红。
//
// B. 单源被破坏（两条，改的是 agent.js）：
//   ⑦ 又把 `JSON.parse(arguments) + 容错 + 三段文案` 抄回 agent.js    → §143 结构守卫必须红；
//   ⑧ 又把"非对象归一化"抄回 agent.js（行为不变，但单源被破坏）        → §143 结构守卫必须红。
//
// C. 任务 B 的回填修复（两条）：
//   ⑨ 丢掉 `undefined` 分支（回填又变成字面量 "undefined"）           → §143 必须红；
//   ⑩ 丢掉 `null` 分支（回填又变成字面量 "null"）                     → §143 必须红。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SEC = () => M.section('143');

// —— A. parseToolArgs 的边界 ——
M.mutate({
  name: '① `!args` 分支被拿掉（JSON 字面量 null 保持 null 交给工具）',
  file: 'src/tools-flow.js',
  from: '  if (!args || typeof args !== \'object\' || Array.isArray(args)) args = {};',
  to: '  if (typeof args !== \'object\' || Array.isArray(args)) args = {};',
  expect: ['parseToolArgs 的归一化必须与抽取前一致：input=null'],
  run: SEC,
});

M.mutate({
  name: '② `Array.isArray` 分支被拿掉（JSON 数组直接当工具参数）',
  file: 'src/tools-flow.js',
  from: '  if (!args || typeof args !== \'object\' || Array.isArray(args)) args = {};',
  to: '  if (!args || typeof args !== \'object\') args = {};',
  expect: ['parseToolArgs 的归一化必须与抽取前一致：input=[]'],
  run: SEC,
});

M.mutate({
  name: '③ 拒绝文案被改短（"输出超限被截断？建议分块"不再可见）',
  file: 'src/tools-flow.js',
  from: "const TOOL_ARGS_PARSE_DENIED = '参数解析失败（输出超限被截断？建议分块）';",
  to: "const TOOL_ARGS_PARSE_DENIED = '参数解析失败'; /* 变异：丢掉分块提示 */",
  expect: ['三段文案逐字一致'],
  run: SEC,
});

M.mutate({
  name: '④ 回填文案丢掉 6000 字符分块指引（模型不知道该怎么重试）',
  file: 'src/tools-flow.js',
  from: "  '工具参数 JSON 解析失败（大概率是输出超过模型单次上限被截断）。请把内容拆分成多个较小文件或多次调用逐步写入：单个 write 的参数总长控制在 6000 字符以内；先写核心骨架，再逐文件补充。';",
  to: "  '工具参数 JSON 解析失败。'; /* 变异：丢弃分块指引 */",
  expect: ['三段文案逐字一致'],
  run: SEC,
});

M.mutate({
  name: '⑤ 加上"从文本里抠 JSON"的宽容（代码围栏 / 多余尾巴被容忍）',
  file: 'src/tools-flow.js',
  from: '    args = JSON.parse(raw || \'{}\');',
  to: "    const s143 = String(raw || '{}'); args = JSON.parse(s143.slice(s143.indexOf('{'), s143.lastIndexOf('}') + 1) || '{}'); /* 变异：宽容抠取 */",
  expect: ['parseToolArgs 的成败判定必须与抽取前一致'],
  run: SEC,
});

M.mutate({
  name: '⑥ 解析器里加 6000 字符闸门（合法的超长参数被误杀）',
  file: 'src/tools-flow.js',
  from: '    args = JSON.parse(raw || \'{}\');',
  to: "    if (typeof raw === 'string' && raw.length > 6000) throw new Error('参数过长');\n    args = JSON.parse(raw || '{}'); /* 变异：加长度闸门 */",
  expect: ['parseToolArgs 的成败判定必须与抽取前一致'],
  run: SEC,
});

// —— B. 单源被破坏（agent.js 又抄回内联实现） ——
M.mutate({
  name: '⑦ agent.js 又抄回 `JSON.parse(arguments) + 容错 + 三段文案`（行为相同，单源被破坏）',
  file: 'src/agent.js',
  from: `          const parsedArgs = parseToolArgs(tc.function?.arguments);
          if (!parsedArgs.ok) {`,
  to: `          let parsedArgs;
          try {
            parsedArgs = { ok: true, args: JSON.parse(tc.function?.arguments || '{}') };
            if (!parsedArgs.args || typeof parsedArgs.args !== 'object' || Array.isArray(parsedArgs.args)) parsedArgs.args = {};
          } catch {
            parsedArgs = {
              ok: false,
              deniedReason: '参数解析失败（输出超限被截断？建议分块）',
              auditReason: '参数解析失败',
              message: '工具参数 JSON 解析失败（大概率是输出超过模型单次上限被截断）。请把内容拆分成多个较小文件或多次调用逐步写入：单个 write 的参数总长控制在 6000 字符以内；先写核心骨架，再逐文件补充。',
            };
          }
          if (!parsedArgs.ok) {`,
  expect: ['不得再内联工具参数解析判据'],
  run: SEC,
});

M.mutate({
  name: '⑧ agent.js 又抄回"非对象归一化"（行为不变，但判据出现第二份）',
  file: 'src/agent.js',
  from: '          args = parsedArgs.args;',
  to: '          args = parsedArgs.args;\n          if (!args || typeof args !== \'object\' || Array.isArray(args)) args = {}; /* 变异：抄回归一化 */',
  expect: ['非对象归一化'],
  run: SEC,
});

// —— C. 任务 B：顶层空值回填 ——
M.mutate({
  name: '⑨ 丢掉 `undefined` 分支（回填又变成字面量 "undefined"）',
  file: 'src/tools-flow.js',
  from: "  return text === undefined || text === 'null' ? '' : text;",
  to: "  return text === 'null' ? '' : text; /* 变异：丢掉 undefined */",
  expect: ['undefined 结果必须序列化为空串'],
  run: SEC,
});

M.mutate({
  name: '⑩ 丢掉 `null` 分支（回填又变成字面量 "null"）',
  file: 'src/tools-flow.js',
  from: "  return text === undefined || text === 'null' ? '' : text;",
  to: "  return text === undefined ? '' : text; /* 变异：丢掉 null */",
  expect: ['null 结果必须序列化为空串'],
  run: SEC,
});

if (!M.report()) process.exit(1);
