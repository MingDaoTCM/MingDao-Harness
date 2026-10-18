// 批三十七（v0.6.20 §3.69：**模型显示别名 config.modelLabels**）的变异验证。
//
// 先复现（实测数据）：API 的 `GET /v1/models` 只返回 `deepseek-flash` / `deepseek-v4-pro`，
// 拿宣传名 `DeepSeek-V4.1-Flash 1017` 去 POST chat 会 400：
//   {"message":"The supported API model names are deepseek-flash, deepseek-v4-pro,
//               but you passed DeepSeek-V4.1-Flash 1017."}
// 所以「显示官方宣传名」只能做成**显示别名**：界面 label 来自 config.modelLabels，
// 出网请求的 model 永远是 API id。本批把每一处修复逐个改回缺陷，
// `test/model-names.js` 的断言必须当场红（expect 是断言原文关键词，对不上算逃逸）。
//
// 覆盖（任务书要求 ≥5 条，本批 10 条）：
//   把 label 写回 config.model（最危险的错误实现：请求体变成宣传名）/
//   忽略 modelLabels / 非法值不校验（超长、空值、空键）/ label 不回退 id /
//   labelSource 不标 / 非法项不 warn / 丢掉 id 字段 / 把显示名当成可选项 value。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SUITE = () => M.suite('test/model-names.js');

// ① 把显示别名写回 config.model —— 出网请求体直接变成宣传名（实测会被官方 400）
M.mutate({
  name: '① 把 label 写回 config.model（请求体的 model 变成宣传名）',
  file: 'src/config.js',
  from: '    cfg.modelLabels = normalizeModelLabels(cfg.modelLabels);',
  to: '    cfg.modelLabels = normalizeModelLabels(cfg.modelLabels);\n    cfg.model = cfg.modelLabels[cfg.model] || cfg.model;',
  expect: ['请求体 model 必须等于 API id'],
  run: SUITE,
});

// ② 完全忽略 modelLabels：界面永远只显示 API id，宣传名映射形同虚设
M.mutate({
  name: '② 忽略 config.modelLabels（label 永远等于 id）',
  file: 'src/model-discovery.js',
  from: '  const modelLabels = normalizeModelLabels(cfg?.modelLabels, { warn: false });',
  to: '  const modelLabels = normalizeModelLabels({}, { warn: false });',
  expect: ['label 必须优先取 config.modelLabels 的显示名'],
  run: SUITE,
});

// ③ 非法值不校验之一：超长显示名照样写进配置（下拉会被撑破）
M.mutate({
  name: '③ 去掉显示名长度上限校验（超长值照收）',
  file: 'src/models.js',
  from: '    if (value.length > maxLength) {',
  to: '    if (false) {',
  expect: ['超长显示名必须被忽略'],
  run: SUITE,
});

// ④ 非法值不校验之二：不 trim，纯空白显示名也能通过"非空"检查
M.mutate({
  name: '④ 空显示名不校验（去掉 trim 后纯空白被当成合法值）',
  file: 'src/models.js',
  from: '    const value = rawValue.trim();',
  to: '    const value = rawValue;',
  expect: ['空显示名必须被忽略（不写进配置）'],
  run: SUITE,
});

// ⑤ 非法值不校验之三：空键（含纯空白键）不被丢弃
M.mutate({
  name: '⑤ 空键不校验（trim 后为空仍写进映射）',
  file: 'src/models.js',
  from: '    if (!key) {',
  to: '    if (false) {',
  expect: ['空键必须被忽略'],
  run: SUITE,
});

// ⑥ label 不回退 id：没有映射的模型显示成空字符串（界面出现空白选项）
M.mutate({
  name: '⑥ 无映射时不回退 id（label 变成空串）',
  file: 'src/models.js',
  from: "  return Object.prototype.hasOwnProperty.call(clean, key) ? clean[key] : key;",
  to: "  return Object.prototype.hasOwnProperty.call(clean, key) ? clean[key] : '';",
  expect: ['无 modelLabels 时 label 必须回退到 id', '无映射时回退到 API id', '未配 modelLabels 时显示名必须回退到 API id'],
  run: SUITE,
});

// ⑦ labelSource 不标：label 与 id 不同时界面/调用方无从知道显示名来自配置
M.mutate({
  name: '⑦ label 与 id 不同时不标 labelSource=config',
  file: 'src/model-discovery.js',
  from: "        ...(displayLabel !== n ? { labelSource: 'config' } : {}),",
  to: '        ...({}),',
  expect: ['label 与 id 不同时必须标 labelSource=config'],
  run: SUITE,
});

// ⑧ 非法项不 warn：静默丢弃，用户不知道自己的映射写错了
M.mutate({
  name: '⑧ 非法 modelLabels 静默丢弃（不再 warn）',
  file: 'src/models.js',
  from: '  warnedModelLabels.add(detail);\n  console.warn(',
  to: '  warnedModelLabels.add(detail);\n  return;\n  console.warn(',
  expect: ['非法 modelLabels 必须 warn'],
  run: SUITE,
});

// ⑨ 丢掉 id 字段：前端只能看到 label（或 name），无法再显示「API id: <id>」
M.mutate({
  name: '⑨ 模型项丢掉 id 字段（只剩显示名）',
  file: 'src/model-discovery.js',
  from: '        name: n,\n        // v0.6.20（§3.69）：显式保留 API 实际 id（前端 title 用「API id: <id>」随时对上 API）\n        id: n,',
  to: '        name: n,',
  expect: ['模型条目必须带 id 字段', '列表条目必须带 API 实际 id（出网请求用它）'],
  run: SUITE,
});

// ⑩ 把显示名当成可选项 value：`o.value=m.name` 的选择逻辑没变，但 name 已是宣传名，
//    于是「选一下模型」就会把宣传名提交给 /api/config（并可能落进 config.model → 出网）。
M.mutate({
  name: '⑩ name 改成显示名（下拉的 value 变成宣传名，选择后即用作出网 model）',
  file: 'src/model-discovery.js',
  from: '        name: n,\n        // v0.6.20（§3.69）：显式保留 API 实际 id（前端 title 用「API id: <id>」随时对上 API）\n        id: n,',
  to: '        name: displayLabel,\n        // v0.6.20（§3.69）：显式保留 API 实际 id（前端 title 用「API id: <id>」随时对上 API）\n        id: n,',
  expect: ['name 必须仍是 API id'],
  run: SUITE,
});

if (!M.report()) process.exit(1);
