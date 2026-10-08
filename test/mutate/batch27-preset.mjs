// 批二十七（内置预设「本地模型审计」写死 permission=readonly，静默覆盖用户的显式权限选择）的变异验证
//
// 负责人实测：WebUI「权限模式」选「自动」，勾上内置 local-audit 后仍按 readonly 跑——每调用一次
// 非只读工具（task/todo）都弹「只读模式将拦截 …，是否本次放行？」。上一轮（§137 / batch25）修的是
// 「显式选择 > 预设」这条优先级链；本轮修的是**源头**：内置预设根本不该声明 `permission`
// （覆盖语义），要表达"建议只读"用 `recommendedPermission`（只透出、不参与判定），
// 只读的硬约束交给 tools 白名单（没有 write/edit）。
//
// 修复的形状是「一条字段纪律 + 一处透出 + 反提权语义不放松」，所以变异逐条打在这三件事上：
//   · 内置预设把 permission 写回来            → 契约必须红（沉默覆盖用户选择的老毛病回来了）；
//   · 删掉 recommendedPermission              → 契约必须红（"建议"没了，只剩覆盖或什么都没有）；
//   · listPresets 不再透出 recommendedPermission → 契约必须红（字段纪律在代码里被抹掉）；
//
// v0.6.15（C）：内置预设按语义拆成 local-model（只放参数）+ readonly-audit（审计人格 + 只读白名单
//   + recommendedPermission）。本批 ①② 的承载文件随之从 presets/local-audit.json 改指
//   presets/readonly-audit.json（"建议只读"这条表达现在只该出现在这里），⑤ 的关键词改成新契约的
//   断言原文——语义不变，锚点与新文件对齐。
//   · 把 recommendedPermission 冒充 permission 透出 → 契约必须红（"建议"被偷偷变成"覆盖"）；
//   · 字段白名单不再认 recommendedPermission  → 契约必须红（内置预设直接被跳过，列表里都没有了）；
//   · presetPermissionOverride 放松反提权     → §137 必须红（第三方/老预设又能提权）。
//
// 逐条要求 `test/api-contracts.js` 或 `test/smoke.js` 第 137 节当场变红（`expect` 用断言原文里的关键词）。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SEC = () => M.section('137');
const CONTRACTS = () => M.suite('test/api-contracts.js');

M.mutate({
  name: '① 内置预设把 permission:"readonly" 写回来（回到"沉默覆盖用户选择"的老毛病）',
  file: 'presets/readonly-audit.json',
  from: '  "recommendedPermission": "readonly",',
  to: '  "recommendedPermission": "readonly",\n  "permission": "readonly",',
  expect: ['内置预设不得带 permission 字段'],
  run: CONTRACTS,
});

M.mutate({
  name: '② 内置预设删掉 recommendedPermission（"建议只读"这个表达没了）',
  file: 'presets/readonly-audit.json',
  from: '  "recommendedPermission": "readonly",\n',
  to: '',
  expect: ['必须透出 recommendedPermission=readonly'],
  run: CONTRACTS,
});

M.mutate({
  name: '③ listPresets() 不再透出 recommendedPermission（字段纪律在代码里被抹掉）',
  file: 'src/presets.js',
  from: '    ...(obj.recommendedPermission ? { recommendedPermission: String(obj.recommendedPermission) } : {}),',
  to: '    ...(false ? { recommendedPermission: String(obj.recommendedPermission) } : {}),',
  expect: ['必须透出 recommendedPermission=readonly'],
  run: CONTRACTS,
});

M.mutate({
  name: '④ listPresets() 把"建议"冒充成"覆盖"透出（recommendedPermission → permission）',
  file: 'src/presets.js',
  from: '    ...(obj.recommendedPermission ? { recommendedPermission: String(obj.recommendedPermission) } : {}),',
  to: '    ...(obj.recommendedPermission ? { permission: String(obj.recommendedPermission) } : {}),',
  expect: ['内置预设不得带 permission 字段'],
  run: CONTRACTS,
});

M.mutate({
  name: '⑤ 字段白名单不再认 recommendedPermission（内置预设被 validatePreset 拒掉、列表里直接消失）',
  file: 'src/presets.js',
  from: "  'permission', 'recommendedPermission', 'model', 'temperature', 'maxOutputTokens', 'maxRounds', 'contextBudget',",
  to: "  'permission', 'model', 'temperature', 'maxOutputTokens', 'maxRounds', 'contextBudget',",
  expect: ['内置 local-model 应列出', '内置 readonly-audit 应列出'],
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
