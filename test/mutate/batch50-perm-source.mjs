// 批五十（v0.6.24 §3.89：`run.start.permissionSource` 补全 worker / REPL）的变异验证。
//
// 先复现：worker（`cli.js run-worker`）与 REPL 此前都没有把来源交给 agent，账本里
// `permission` 有值、`permissionSource` 恒为 null——事后分不清「任务规格显式定的 /
// config 来的」「REPL 启动的 / `/preset` 切的」。本批把这几处修复逐个改回缺陷，
// `test/ledger-source.js` 的断言必须当场红（expect 是断言原文关键词，对不上算逃逸）。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SUITE = () => M.suite('test/ledger-source.js');

// ① worker 不传来源（回到修复前的 null：后台账本又只剩生效值）
M.mutate({
  name: '① worker 不传 permissionSource（写 null）',
  file: 'src/tasks/worker.js',
  from: '    const agentCfg = { ...cfg, permission: perm, permissionSource };',
  to: '    const agentCfg = { ...cfg, permission: perm, permissionSource: null };',
  expect: ['worker 未显式指定权限时必须记 config（不能写 null）'],
  run: SUITE,
});

// ② 任务规格显式 permission 被写成 config（把新增的 job 枚举折回旧值）
M.mutate({
  name: '② 任务规格显式 permission 记成 config',
  file: 'src/tasks/worker.js',
  from: "    const permissionSource = permission ? 'job' : cfg.permission !== undefined && cfg.permission !== null ? 'config' : 'default';",
  to: "    const permissionSource = cfg.permission !== undefined && cfg.permission !== null ? 'config' : 'default';",
  expect: ['任务规格显式 permission 必须记为 job（新增枚举，不能写成 config/explicit）'],
  run: SUITE,
});

// ③ 来源对、但生效值仍取 config.permission（job 显式 auto 被 config 的 readonly 压过）
M.mutate({
  name: '③ worker 丢掉任务规格的生效权限（permission 仍取 config）',
  file: 'src/tasks/worker.js',
  from: '    const agentCfg = { ...cfg, permission: perm, permissionSource };',
  to: '    const agentCfg = { ...cfg, permissionSource };',
  expect: ['任务规格显式 auto 必须是生效值（config.permission 不得盖过它）'],
  run: SUITE,
});

// ④ REPL 启动时把来源清成 null（"来源未知"冒充"来源就是配置"）
M.mutate({
  name: '④ REPL 启动不传来源（写 null）',
  file: 'src/commands/repl.js',
  from: "  let agentCfg = ctx.agentCfg || { ...cfg };\n  if (!agentCfg.permissionSource) {\n    agentCfg.permissionSource = cfg.permission !== undefined && cfg.permission !== null ? 'config' : 'default';\n  }",
  to: "  let agentCfg = ctx.agentCfg || { ...cfg };\n  agentCfg.permissionSource = null;",
  expect: ['REPL 启动（config 有 permission）必须记 config（不能写 null）'],
  run: SUITE,
});

// ⑤ REPL `/preset` 切完不带来源（会话内切换又退回 null）
M.mutate({
  name: '⑤ REPL /preset 后不传来源',
  file: 'src/commands/repl.js',
  from: "          permissionSource: permissionFromPreset\n            ? 'preset'\n            : agentCfg.permissionSource ?? (cfg.permission !== undefined && cfg.permission !== null ? 'config' : 'default'),",
  to: '          permissionSource: null,',
  expect: ['REPL 内切换预设必须记为 preset（不能沿用 config）'],
  run: SUITE,
});

// ⑥ 枚举漏掉 job（入口记了 job，账本白名单把它判非法 → 落成 null）
M.mutate({
  name: '⑥ PERMISSION_SOURCES 漏掉 job 枚举',
  file: 'src/ledger.js',
  from: "export const PERMISSION_SOURCES = Object.freeze(['explicit', 'preset', 'config', 'cli', 'job', 'default']);",
  to: "export const PERMISSION_SOURCES = Object.freeze(['explicit', 'preset', 'config', 'cli', 'default']);",
  expect: ['任务规格显式 permission 必须记为 job（新增枚举，不能写成 config/explicit）'],
  run: SUITE,
});

// ⑦ 验证器要求新字段：旧账本（无 permissionSource）被判失败——向后兼容红线
M.mutate({
  name: '⑦ verify 把旧账本（无 permissionSource）判成失败',
  file: 'src/ledger.js',
  from: "    if (ev.type === 'run.end') sawEnd = true;",
  to: "    if (ev.type === 'run.end') sawEnd = true;\n    if (ev.type === 'run.start' && !('permissionSource' in ev)) return { ok: false, error: '变异：旧账本缺少 permissionSource', badSeq: i + 1, total: lines.length, sealed: false, warning: null, ...NO_PROVENANCE };",
  expect: ['旧账本（无 permissionSource）必须仍能 verify 通过'],
  run: SUITE,
});

if (!M.report()) process.exit(1);
