// 批三十五（v0.6.19 §3.67：**模型名称以 API 实时返回的官方名为准**）的变异验证。
//
// 先复现：`MODELS` 把 deepseek 的版本写死成键、默认值写死成具体版本，于是官方升到
// `DeepSeek-V4.1-Flash 1017` 后，界面能拉到、默认值却还指着旧名。本批把每一处修复逐个
// 改回缺陷，`test/model-names.js` 的断言必须当场红（expect 是断言原文关键词，对不上算逃逸）。
//
// 覆盖的问题类型（任务书要求 ≥6 条，本批 9 条）：
//   家族匹配退化成精确匹配 / 新版本被当成已知 / 默认值写死具体版本 /
//   API 官方名被精确表拒绝 / 去掉离线兜底提示 / 列表标签丢掉官方名 /
//   新配置默认值写死 / 显式配置不再优先 / 路由默认值写死。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SUITE = () => M.suite('test/model-names.js');

// ① 家族匹配退化成精确匹配：`DeepSeek-V4.1-Flash 1017` 不再命中 flash 家族
M.mutate({
  name: '① flash 家族正则退化成精确匹配 deepseek-flash',
  file: 'src/models.js',
  from: '    match: /^deepseek(?:[\\s_-]*v?\\d+(?:[.\\s_-]*\\d+)?)?[\\s_-]*flash(?:[\\s_-]|$)/i,',
  to: '    match: /^deepseek-flash$/i,',
  expect: ['官方名 DeepSeek-V4.1-Flash 1017 必须能解析出能力'],
  run: SUITE,
});

// ② 新版本被当成已知：把 flash 家族的已核对规格上限抬到 9.9，V4.2 不再标「能力未知」
M.mutate({
  name: '② 把 flash 家族 verifiedThrough 改成 9.9（新版本不再标能力未知）',
  file: 'src/models.js',
  from: "    representative: 'deepseek-flash',\n    label: '极速响应 · 日常问答与轻量任务',\n    verifiedThrough: '4.1',",
  to: "    representative: 'deepseek-flash',\n    label: '极速响应 · 日常问答与轻量任务',\n    verifiedThrough: '9.9',",
  expect: ['能力未知（新版本）'],
  run: SUITE,
});

// ③ 默认值解析写死：不再从 API 名单挑，直接拿家族代表名充当"官方名"
M.mutate({
  name: '③ 默认模型解析不再读 API 名单（直接返回家族代表名）',
  file: 'src/model-discovery.js',
  from: '    const picked = pickFamilyModel(fetched.models, family);',
  to: '    const picked = familyRepresentative(family);',
  expect: ['默认 planner 必须从 API 列表解析出 pro 家族官方名'],
  run: SUITE,
});

// ④ API 官方名被精确表拒绝：已知模型校验退回 Object.keys(MODELS)（不含家族/线上新版本）
M.mutate({
  name: '④ 已知模型校验退回精确表（API 官方名/新版本被拒）',
  file: 'src/web/routes/domains/config.js',
  from: "        const known =\n          Object.prototype.hasOwnProperty.call(cfg.customModels || {}, target) ||\n          Object.prototype.hasOwnProperty.call(MODELS, target) ||\n          Boolean(modelPreset(target)) ||",
  to: "        const known =\n          Object.prototype.hasOwnProperty.call(cfg.customModels || {}, target) ||\n          Object.keys(MODELS).includes(target);",
  expect: ['选中 API 官方名必须成功'],
  run: SUITE,
});

// ⑤ 去掉离线兜底提示：常量被清空，界面/日志都不再说明"模型名可能不是最新的"
M.mutate({
  name: '⑤ 离线兜底提示被清空',
  file: 'src/model-discovery.js',
  from: "export const OFFLINE_MODEL_NOTE = '离线兜底：模型名可能不是最新的（API 不可达，已使用内置家族代表名）';",
  to: "export const OFFLINE_MODEL_NOTE = '';",
  expect: ['离线兜底'],
  run: SUITE,
});

// ⑥ 列表标签丢掉官方名：下拉只显示能力描述，用户看不出 API 返回的是哪个官方名
M.mutate({
  name: '⑥ 列表标签去掉 API 官方名（只留能力描述）',
  file: 'src/model-discovery.js',
  from: '        : preset\n          ? `${n} — ${preset.label}`',
  to: '        : preset\n          ? `${preset.label}`',
  expect: ['列表标签必须以前端官方名开头'],
  run: SUITE,
});

// ⑦ 新建配置的默认模型写死：ensureMinimalConfig 不再看 API 缓存
M.mutate({
  name: '⑦ ensureMinimalConfig 把默认模型写死回内置名',
  file: 'src/config.js',
  from: '  const model = officialFlash || (modelPreset(DEFAULT_MODEL) ? DEFAULT_MODEL : pp.models[0]);',
  to: '  const model = DEFAULT_MODEL;',
  expect: ['新配置默认模型必须用 API 官方名'],
  run: SUITE,
});

// ⑧ 显式配置不再优先：resolveDefaultModel 忽略 config.routing.planner，强行用 API 名单
M.mutate({
  name: '⑧ 显式 config.routing.planner 不再优先（被 API 名单覆盖）',
  file: 'src/model-discovery.js',
  from: "  const explicit = r === 'planner' ? cfg?.routing?.planner : r === 'executor' ? cfg?.routing?.executor : cfg?.model;\n  if (explicit) {",
  to: "  const explicit = r === 'planner' ? cfg?.routing?.planner : r === 'executor' ? cfg?.routing?.executor : cfg?.model;\n  if (false) {",
  expect: ['显式 config.routing.planner 必须优先于 API 名单'],
  run: SUITE,
});

// ⑨ 路由默认值写死：WebUI 开启自动路由时又把具体版本号塞回 config.routing.planner
M.mutate({
  name: '⑨ 路由默认 planner 写死回具体版本号',
  file: 'src/web/routes/domains/config.js',
  from: '          planner: cfg.routing?.planner || defaults.planner.model,',
  to: "          planner: cfg.routing?.planner || 'deepseek-v4-pro',",
  expect: ['路由默认 planner 必须是 API 官方名'],
  run: SUITE,
});

if (!M.report()) process.exit(1);
