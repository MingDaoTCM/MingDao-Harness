// 批三十四（v0.6.17 §3.64：`run.start.permissionSource`）的变异验证。
//
// 先复现（桩 provider 跑一次 WebUI chat，`run.start` 只有 permission:"auto"、没有来源）：
// 事后单看账本分不清"用户显式选的 auto / 预设压的 / config 默认"——「界面选了自动却按只读跑」
// 之所以难自查，一部分原因就在这里。本批把来源链路的每一处修复逐个改回缺陷，
// `test/ledger-source.js` 的断言必须当场红（expect 是断言原文关键词，对不上算逃逸）。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SUITE = () => M.suite('test/ledger-source.js');

// ① 账本落盘时把来源写死成 config（"来源永远有值"的假象：显式选择被冒充）
M.mutate({
  name: '① 账本把 permissionSource 写死成 config',
  file: 'src/ledger.js',
  from: '        permissionSource: PERMISSION_SOURCES.includes(String(f.permissionSource)) ? String(f.permissionSource) : null,',
  to: "        permissionSource: 'config',",
  expect: ['显式选择必须记为 explicit'],
  run: SUITE,
});

// ② WebUI 把「显式选择」翻译成 preset（枚举翻译点写错：来源从此永远指向预设）
M.mutate({
  name: '② WebUI 把 explicit 映射成 preset',
  file: 'src/web/server.js',
  from: "const LEDGER_PERMISSION_SOURCE = /** @type {Record<string, string>} */ ({ webui: 'explicit', preset: 'preset', config: 'config' });",
  to: "const LEDGER_PERMISSION_SOURCE = /** @type {Record<string, string>} */ ({ webui: 'preset', preset: 'preset', config: 'config' });",
  expect: ['显式选择必须记为 explicit'],
  run: SUITE,
});

// ③ WebUI 干脆不把来源交给 agent（字段缺失 = 又回到"只有生效值"的现状）
M.mutate({
  name: '③ WebUI 不再把来源传给 agent（字段缺失）',
  file: 'src/web/server.js',
  from: '    chatCfg.permissionSource = LEDGER_PERMISSION_SOURCE[turnPerm.source] ?? null;',
  to: '',
  expect: ['显式选择必须记为 explicit'],
  run: SUITE,
});

// ④ agent 不把 cfg.permissionSource 透传给账本（入口算对了，半路丢掉）
M.mutate({
  name: '④ agent 不把来源透传给账本',
  file: 'src/agent.js',
  from: '      permissionSource: cfg.permissionSource ?? null,',
  to: '      permissionSource: null,',
  expect: ['显式选择必须记为 explicit'],
  run: SUITE,
});

// ⑤ 账本不写 permissionSource 字段（"删字段"：旧读者兼容，但新账本失去来源）
M.mutate({
  name: '⑤ 账本删掉 permissionSource 字段',
  file: 'src/ledger.js',
  from: '        permissionSource: PERMISSION_SOURCES.includes(String(f.permissionSource)) ? String(f.permissionSource) : null,\n',
  to: '',
  expect: ['显式选择必须记为 explicit'],
  run: SUITE,
});

// ⑥ CLI 入口不传来源（config/default 退化：CLI 账本又只剩生效值）
M.mutate({
  name: '⑥ CLI 入口不再计算/传递权限来源',
  file: 'src/cli.js',
  from: "  const permissionSource = Object.prototype.hasOwnProperty.call(presetOverlay, 'permission')\n    ? 'preset'\n    : cfg.permission !== undefined && cfg.permission !== null\n      ? 'config'\n      : 'default';\n  const agentCfg = { ...agentCfgBase, permissionSource };",
  to: '  const agentCfg = { ...agentCfgBase };',
  expect: ['CLI 无 permission 字段时必须记 default'],
  run: SUITE,
});

// ⑦ 验证器要求新字段：旧账本（无 permissionSource）被判失败——向后兼容红线
M.mutate({
  name: '⑦ verify 把旧账本（无 permissionSource）判成失败',
  file: 'src/ledger.js',
  from: "    const prov = provenanceOf(seal, declaredKeyIds, keyPath);\n    return { ok: true, error: null, badSeq: null, total: lines.length, sealed: true, warning: null, ...prov, trusted: prov.provenance === 'valid' || prov.provenance === 'none' };",
  to: "    const prov = provenanceOf(seal, declaredKeyIds, keyPath);\n    if (!lines.some((l) => l.includes('\"permissionSource\"'))) return { ok: false, error: '变异：旧账本缺少 permissionSource', badSeq: 1, total: lines.length, sealed: true, warning: null, ...NO_PROVENANCE };\n    return { ok: true, error: null, badSeq: null, total: lines.length, sealed: true, warning: null, ...prov, trusted: prov.provenance === 'valid' || prov.provenance === 'none' };",
  expect: ['旧账本（无 permissionSource）必须仍能 verify 通过'],
  run: SUITE,
});

if (!M.report()) process.exit(1);
