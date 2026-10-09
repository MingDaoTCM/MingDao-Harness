// 批二十七（内置预设携带权限字段，静默覆盖用户的显式权限选择 / 替用户表达权限偏好）的变异验证
//
// 负责人实测：WebUI「权限模式」选「自动」，勾上当时的内置 local-audit 后仍按 readonly 跑——每调用一次
// 非只读工具（task/todo）都弹「只读模式将拦截 …，是否本次放行？」。上一轮（§137 / batch25）修的是
// 「显式选择 > 预设」这条优先级链；本轮修的是**源头**：内置预设根本不该携带**权限字段**——
// `permission` 是覆盖语义，`recommendedPermission` 是权限偏好暗示。只读的硬约束交给 tools 白名单
// （没有 write/edit），或由用户显式选权限档。
//
// 修复的形状是「一条字段纪律 + 一处透出 + 反提权语义不放松」，所以变异逐条打在这三件事上：
//   · 内置预设把 permission 写回来              → 契约必须红（沉默覆盖用户选择的老毛病回来了）；
//   · 内置预设把 recommendedPermission 写回来    → 契约必须红（参数预设替用户表达权限偏好）；
//   · listPresets 给内置预设合成权限偏好字段     → 契约必须红（字段纪律在代码里被抹掉）；
//   · 字段白名单不再认 recommendedPermission     → 契约必须红（第三方预设的字段支持被误删）；
//   · presetPermissionOverride 放松反提权        → §137 必须红（第三方/老预设又能提权）。
//
// v0.6.15（C）：内置预设按语义拆成 local-model（只放参数）+ readonly-audit（审计人格 + 只读白名单）。
// v0.6.16（负责人产品决策）：**删除 readonly-audit**——代码审计只是负责人拿 MDH 做的一次较长任务的
//   **测试**，发行版面向**普通大众**、不做任务定制（用户可能做别的任务、不一定用本地模型、也不一定
//   审计代码）。内置预设只留 `presets/local-model.json`，定位收窄为「**只提供参数类默认值，不携带
//   人格、不限制工具、不涉及权限**」。因此本批的承载文件锚点一律改指 `presets/local-model.json`，
//   断言关键词改指 `test/api-contracts.js` 里**新契约的断言原文**（"内置预设不得带 permission 字段"
//   / "内置预设不得带 recommendedPermission 字段" / "内置预设只应有 local-model"）——语义不变
//   （内置预设不得携带权限字段；删除就是删除，不得悄悄换个名字回来），只是锚点与新契约对齐。
//
// 逐条要求 `test/api-contracts.js` 或 `test/smoke.js` 第 137 节当场变红（`expect` 用断言原文里的关键词）。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SEC = () => M.section('137');
const CONTRACTS = () => M.suite('test/api-contracts.js');

M.mutate({
  name: '① 内置预设把 permission:"readonly" 写回来（回到"沉默覆盖用户选择"的老毛病）',
  file: 'presets/local-model.json',
  from: '  "contextBudget": 65536,',
  to: '  "permission": "readonly",\n  "contextBudget": 65536,',
  expect: ['内置预设不得带 permission 字段'],
  run: CONTRACTS,
});

M.mutate({
  name: '② 内置预设把 recommendedPermission:"readonly" 写回来（参数预设替用户表达权限偏好）',
  file: 'presets/local-model.json',
  from: '  "contextBudget": 65536,',
  to: '  "recommendedPermission": "readonly",\n  "contextBudget": 65536,',
  expect: ['内置预设不得带 recommendedPermission 字段'],
  run: CONTRACTS,
});

M.mutate({
  name: '③ 内置预设改回删掉的名字 readonly-audit（删除只是改了个名，悄悄回来）',
  file: 'presets/local-model.json',
  from: '  "name": "local-model",',
  to: '  "name": "readonly-audit",',
  expect: ['内置预设只应有 local-model'],
  run: CONTRACTS,
});

M.mutate({
  name: '④ listPresets() 给每个预设合成 recommendedPermission（字段纪律在代码里被抹掉）',
  file: 'src/presets.js',
  from: '    ...(obj.model ? { model: String(obj.model) } : {}),',
  to: '    ...(obj.recommendedPermission || true ? { recommendedPermission: String(obj.recommendedPermission || \'readonly\') } : {}),\n    ...(obj.model ? { model: String(obj.model) } : {}),',
  expect: ['内置预设不得带 recommendedPermission 字段'],
  run: CONTRACTS,
});

M.mutate({
  name: '⑤ 字段白名单不再认 recommendedPermission（第三方预设的字段支持被误删）',
  file: 'src/presets.js',
  from: "  'permission', 'recommendedPermission', 'model', 'temperature', 'maxOutputTokens', 'maxRounds', 'contextBudget',",
  to: "  'permission', 'model', 'temperature', 'maxOutputTokens', 'maxRounds', 'contextBudget',",
  expect: ['第三方预设声明 recommendedPermission 仍应被接受'],
  run: CONTRACTS,
});

M.mutate({
  name: '⑥ presetPermissionOverride 放松反提权（预设又能把 readonly/ask 提成 auto）',
  file: 'src/presets.js',
  from: '  if (PERM_RANK[want] > PERM_RANK[cur]) {',
  to: '  if (false) {',
  expect: ['无显式选择时，预设 auto 不得把 readonly 放宽', '无显式选择时，预设 auto 也不得把 ask 放宽成 auto'],
  run: SEC,
});

if (!M.report()) process.exit(1);
