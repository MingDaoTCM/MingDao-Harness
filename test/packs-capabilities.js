// 垂域 Pack 行为套件（v0.7.0 §1.2「变异补盲」）：`src/packs.js` 此前 0 条变异。
//
//   node test/packs-capabilities.js
//
// 覆盖的是"契约写了、代码却可能没做"的部分：
//   · manifest 静态校验（未知字段 / apiVersion / 保留名 / engines 版本窗口 / permissions / budget）
//   · 极简 semver（^ ~ 区间 精确）与坏 range 的 fail-closed
//   · 静态校验 vs 运行时加载：声明了代码贡献却缺 pack.mjs、apiVersion 不一致、createPack 抛错、
//     约束 kind/pattern 不合法——都必须在**装载时**失败且原因可操作
//   · 能力声明与实际使用不一致 → 告警（permissions 只是声明，内核不强制，必须把差距摆出来）
//   · 三级遮蔽与「未信任项目级 Pack 不挂载」——本仓唯一的 Pack 禁用开关就是信任门
//   · 幂等挂载与非法工具名跳过
//
// 断言带 `P<n>：` 前缀；变异批次 batch73 用这些关键词证明红的是对应变异。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const load = (/** @type {string} */ rel) => import(pathToFileURL(path.join(srcDir, rel)).href);

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-packs-home-'));
process.env.MINGDAO_HOME = home;
const packs = await load('packs.js');

const cleanups = [];
const tmp = (/** @type {string} */ tag) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `mingdao-packs-${tag}-`));
  cleanups.push(d);
  return d;
};
const ok = (/** @type {string} */ n) => console.log(`  ✓ ${n}`);
/** @param {any} cond @param {string} tag @param {string} detail */
function check(cond, tag, detail) {
  assert.ok(cond, `${tag}：${detail}`);
}
const hasError = (/** @type {any} */ res, /** @type {string} */ needle) => Array.isArray(res?.errors) && res.errors.some((e) => String(e).includes(needle));
const hasWarning = (/** @type {any} */ res, /** @type {string} */ needle) =>
  Array.isArray(res?.warnings) && res.warnings.some((w) => String(w).includes(needle));
const CORE = packs.coreVersionOf();
const good = (/** @type {string} */ name, /** @type {any} */ extra = {}) => ({
  apiVersion: 1,
  name,
  version: '1.0.0',
  engines: { mingdao: `>=0.1 <99.0.0` },
  ...extra,
});

/** @param {string} dir @param {any} manifest @param {string} [code] */
function makePackDir(dir, manifest, code) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify(manifest, null, 2));
  if (code !== undefined) fs.writeFileSync(path.join(dir, 'pack.mjs'), code);
  return dir;
}
const MIN_CODE = `export const apiVersion = 1;\nexport function createPack() { return {}; }\n`;

try {
  // -------------------------------------------------------------------------
  // P1 有效 manifest：通过，且 errors 为空
  // -------------------------------------------------------------------------
  {
    const r = packs.validateManifest(good('tcm-demo'));
    check(r.ok === true && r.errors.length === 0, 'P1：有效 manifest 必须通过', JSON.stringify(r));
    ok(`P1 有效 manifest（内核 ${CORE}）`);
  }

  // -------------------------------------------------------------------------
  // P2 未知字段 / 非对象：拒绝而不是静默忽略（拼写错误必须能被发现）
  // -------------------------------------------------------------------------
  {
    const r1 = packs.validateManifest(good('tcm-demo', { typoField: 1 }));
    check(hasError(r1, '未知字段 "typoField"'), 'P2：未知顶层字段必须报错', JSON.stringify(r1));
    const r2 = packs.validateManifest([]);
    check(hasError(r2, 'manifest 必须是 JSON 对象'), 'P2：数组 manifest 必须报错', JSON.stringify(r2));
    ok('P2 manifest 形状：未知字段 / 非对象都被拒');
  }

  // -------------------------------------------------------------------------
  // P3 apiVersion：必须是受支持的整数
  // -------------------------------------------------------------------------
  {
    const r1 = packs.validateManifest(good('tcm-demo', { apiVersion: 2 }));
    check(hasError(r1, '不受支持'), 'P3：不支持的 apiVersion 必须报错', JSON.stringify(r1));
    const r2 = packs.validateManifest(good('tcm-demo', { apiVersion: '1' }));
    check(hasError(r2, 'apiVersion 必须是整数'), 'P3：字符串 apiVersion 必须报错', JSON.stringify(r2));
    ok('P3 apiVersion：版本窗口与类型都校验');
  }

  // -------------------------------------------------------------------------
  // P4 name：命名规约 + 保留名
  // -------------------------------------------------------------------------
  {
    const r1 = packs.validateManifest(good('Bad_Name'));
    check(hasError(r1, 'name 非法'), 'P4：非法 name 必须报错', JSON.stringify(r1));
    const r2 = packs.validateManifest(good('core'));
    check(hasError(r2, '保留名'), 'P4：保留名必须报错', JSON.stringify(r2));
    ok('P4 name：命名规约 + 保留名');
  }

  // -------------------------------------------------------------------------
  // P5 version / engines：版本号与兼容窗口都不能缺
  // -------------------------------------------------------------------------
  {
    const r1 = packs.validateManifest(good('tcm-demo', { version: 'abc' }));
    check(hasError(r1, 'version 必须是 x.y.z'), 'P5：非法 version 必须报错', JSON.stringify(r1));
    const r2 = packs.validateManifest(good('tcm-demo', { engines: undefined }));
    check(hasError(r2, 'engines.mingdao 必填'), 'P5：缺 engines.mingdao 必须报错', JSON.stringify(r2));
    ok('P5 version/engines：缺一不可');
  }

  // -------------------------------------------------------------------------
  // P6 兼容窗口不匹配：必须拒绝并说明"内核是哪个版本"
  // -------------------------------------------------------------------------
  {
    const r = packs.validateManifest(good('tcm-demo', { engines: { mingdao: '>=99.0.0 <100.0.0' } }));
    check(hasError(r, '不匹配当前内核'), 'P6：engines 不匹配必须报错', JSON.stringify(r));
    ok('P6 兼容窗口：不匹配即拒绝');
  }

  // -------------------------------------------------------------------------
  // P7 permissions / budget / contributes：未知能力与非法取值都必须拒绝
  // -------------------------------------------------------------------------
  {
    const r1 = packs.validateManifest(good('tcm-demo', { permissions: { gpu: [] } }));
    check(hasError(r1, 'permissions.gpu 不是可用能力'), 'P7：未知 permission 必须报错', JSON.stringify(r1));
    const r2 = packs.validateManifest(good('tcm-demo', { permissions: { net: 'example.com' } }));
    check(hasError(r2, 'permissions.net 必须是字符串数组'), 'P7：permission 值必须是数组', JSON.stringify(r2));
    const r3 = packs.validateManifest(good('tcm-demo', { budget: { dailyYuan: 0 } }));
    check(hasError(r3, 'budget.dailyYuan 必须是正数'), 'P7：非正预算必须报错', JSON.stringify(r3));
    const r4 = packs.validateManifest(good('tcm-demo', { budget: { action: 'ignore' } }));
    check(hasError(r4, "budget.action 只支持"), 'P7：非法 budget.action 必须报错', JSON.stringify(r4));
    const r5 = packs.validateManifest(good('tcm-demo', { contributes: { nope: true } }));
    check(hasError(r5, 'contributes.nope 不是可贡献项'), 'P7：未知贡献项必须报错', JSON.stringify(r5));
    ok('P7 permissions/budget/contributes：未知项与坏值都拒');
  }

  // -------------------------------------------------------------------------
  // P8 版本区间语义：^ 锁 major / 0.x 锁 minor、~ 锁 minor、空格分隔多条件
  // -------------------------------------------------------------------------
  {
    check(packs.satisfiesRange('1.2.3', '^1.2.3') === true, 'P8：^1.2.3 必须接受 1.2.3', '');
    check(packs.satisfiesRange('1.9.9', '^1.2.3') === true, 'P8：^1.2.3 必须接受同 major 的 1.9.9', '');
    check(packs.satisfiesRange('2.0.0', '^1.2.3') === false, 'P8：^1.2.3 必须拒绝 2.0.0', '');
    check(packs.satisfiesRange('0.6.32', '^0.6.0') === true, 'P8：^0.6.0 必须接受同 minor 的 0.6.32', '');
    check(packs.satisfiesRange('0.7.0', '^0.6.0') === false, 'P8：^0.6.0 必须拒绝 0.7.0（0.x 锁 minor）', '');
    check(packs.satisfiesRange('1.2.9', '~1.2.3') === true, 'P8：~1.2.3 必须接受同 minor 的 1.2.9', '');
    check(packs.satisfiesRange('1.3.0', '~1.2.3') === false, 'P8：~1.2.3 必须拒绝 1.3.0', '');
    check(packs.satisfiesRange('0.6.32', '>=0.5 <0.7') === true, 'P8：>=0.5 <0.7 必须接受 0.6.32', '');
    check(packs.satisfiesRange('0.7.0', '>=0.5 <0.7') === false, 'P8：>=0.5 <0.7 必须拒绝 0.7.0', '');
    check(packs.satisfiesRange('1.2.3', '1.2.3') === true, 'P8：精确版本相等必须接受', '');
    check(packs.satisfiesRange('1.2.4', '1.2.3') === false, 'P8：精确版本不等必须拒绝', '');
    check(packs.satisfiesRange('1.2.3', '*') === true, 'P8：* 接受任意合法版本', '');
    ok('P8 版本区间：^ / ~ / 多条件 / 精确');
  }

  // -------------------------------------------------------------------------
  // P9 坏 range / 非法版本：fail-closed（不得因为解析失败就放行）
  // -------------------------------------------------------------------------
  {
    check(packs.satisfiesRange('abc', '*') === false, 'P9：非法版本必须返回 false', '');
    check(packs.satisfiesRange('1.2.3', '~>1.2') === false, 'P9：不支持的 range 形态必须返回 false', '');
    check(packs.satisfiesRange('1.2.3', '>=1.0.0 || <2.0.0') === false, 'P9：OR 区间必须 fail-closed', '');
    ok('P9 坏 range：fail-closed');
  }

  // -------------------------------------------------------------------------
  // P10 静态校验：声明了代码贡献却缺 pack.mjs、声明的贡献路径不存在 → 拒绝
  // -------------------------------------------------------------------------
  {
    const d1 = tmp('static-nocode');
    makePackDir(d1, good('zz-static-nocode', { contributes: { tools: true } })); // 无 pack.mjs
    const r1 = packs.loadPackStatic(d1);
    check(r1.ok === false && hasError(r1, '缺少 pack.mjs'), 'P10：声明代码贡献却缺 pack.mjs 必须拒绝', JSON.stringify(r1));

    const d2 = tmp('static-missing');
    makePackDir(d2, good('zz-static-missing', { contributes: { presets: ['presets'] } }), MIN_CODE);
    const r2 = packs.loadPackStatic(d2);
    check(r2.ok === false && hasError(r2, '声明的路径不存在'), 'P10：声明的贡献路径不存在必须拒绝', JSON.stringify(r2));

    const d3 = tmp('static-ok');
    makePackDir(d3, good('zz-static-ok', { contributes: { tools: true } }), MIN_CODE);
    const r3 = packs.loadPackStatic(d3);
    check(r3.ok === true, 'P10：静态校验通过的最小 Pack 必须被接受', JSON.stringify(r3));
    ok('P10 静态校验：文件/路径/代码存在性');
  }

  // -------------------------------------------------------------------------
  // P11 运行时加载：apiVersion 不一致 / 缺 createPack / createPack 抛错
  // -------------------------------------------------------------------------
  {
    const d1 = tmp('runtime-version');
    makePackDir(d1, good('zz-runtime-version', { contributes: { tools: true } }), 'export const apiVersion = 2;\nexport function createPack() { return {}; }\n');
    const r1 = await packs.loadPack(d1);
    check(r1.ok === false && hasError(r1, '不一致'), 'P11：pack.mjs 与 pack.json 的 apiVersion 不一致必须拒绝', JSON.stringify(r1));

    const d2 = tmp('runtime-nofn');
    makePackDir(d2, good('zz-runtime-nofn', { contributes: { tools: true } }), 'export const apiVersion = 1;\n');
    const r2 = await packs.loadPack(d2);
    check(r2.ok === false && hasError(r2, '必须导出 createPack'), 'P11：缺 createPack 必须拒绝', JSON.stringify(r2));

    const d3 = tmp('runtime-throw');
    makePackDir(d3, good('zz-runtime-throw', { contributes: { tools: true } }), 'export const apiVersion = 1;\nexport function createPack() { throw new Error("boom-from-pack"); }\n');
    const r3 = await packs.loadPack(d3);
    check(r3.ok === false && hasError(r3, 'createPack() 抛错'), 'P11：createPack 抛错必须拒绝', JSON.stringify(r3));
    ok('P11 运行时加载：apiVersion / createPack 契约');
  }

  // -------------------------------------------------------------------------
  // P12 约束校验：坏 kind、坏 pattern、confirm 缺 tool 必须在装载时失败
  // -------------------------------------------------------------------------
  {
    const d = tmp('constraints');
    const code = `export const apiVersion = 1;
export function createPack() {
  return {
    constraints: [
      { id: 'bad-kind', kind: 'nope' },
      { id: 'bad-pattern', kind: 'output-forbid', pattern: '[' },
      { id: 'no-tool', kind: 'confirm' },
    ],
  };
}
`;
    makePackDir(d, good('zz-constraints', { contributes: { constraints: [] } }), code);
    const r = await packs.loadPack(d);
    check(r.ok === false, 'P12：坏约束必须让整个 Pack 装载失败', JSON.stringify(r));
    check(hasError(r, '约束[0].kind 非法'), 'P12：非法 kind 必须报错', JSON.stringify(r?.errors));
    check(hasError(r, 'pattern 不可用'), 'P12：坏正则必须在装载时被拒（不能留到运行时静默失效）', JSON.stringify(r?.errors));
    check(hasError(r, '（confirm）需要 tool 字段'), 'P12：confirm 缺 tool 必须报错', JSON.stringify(r?.errors));
    ok('P12 约束校验：kind / pattern / 必填字段');
  }

  // -------------------------------------------------------------------------
  // P13 能力声明 vs 实际使用：不一致时告警，声明后不再告警；用 ctx.llm 不误报
  // -------------------------------------------------------------------------
  {
    const codeFetch = `export const apiVersion = 1;
export function createPack() {
  if (false) fetch('https://api.example.com/x');
  return {};
}
`;
    const d1 = tmp('cap-undeclared');
    makePackDir(d1, good('zz-cap-undeclared', { contributes: { tools: true } }), codeFetch);
    const r1 = await packs.loadPack(d1);
    check(r1.ok === true, 'P13：未声明能力只是告警，不得阻止加载', JSON.stringify(r1));
    check(hasWarning(r1, '未声明'), 'P13：源码用了未声明的能力必须告警', JSON.stringify(r1?.warnings));
    check(hasWarning(r1, 'net'), 'P13：未声明能力告警必须点名 net', JSON.stringify(r1?.warnings));

    const d2 = tmp('cap-declared');
    makePackDir(d2, good('zz-cap-declared', { contributes: { tools: true }, permissions: { net: ['api.example.com'] } }), codeFetch);
    const r2 = await packs.loadPack(d2);
    check(r2.ok === true && !hasWarning(r2, '未声明'), 'P13：声明了 net 后不得再报未声明', JSON.stringify(r2?.warnings));

    const d3 = tmp('cap-llm');
    const codeLlm = `export const apiVersion = 1;
export function createPack(ctx) {
  if (false) { void ctx.llm; fetch('https://api.example.com/x'); }
  return {};
}
`;
    makePackDir(d3, good('zz-cap-llm', { contributes: { tools: true }, permissions: { net: ['api.example.com'] } }), codeLlm);
    const r3 = await packs.loadPack(d3);
    check(r3.ok === true && (r3.warnings || []).length === 0, 'P13：用了 ctx.llm 的 Pack 不得被误报为"自己 fetch 模型"', JSON.stringify(r3?.warnings));
    ok('P13 能力声明对照：未声明告警 / 声明后沉默 / ctx.llm 不误报');
  }

  // -------------------------------------------------------------------------
  // P14 三级遮蔽：config 版本遮蔽 user 版本；未信任项目版本**不得**遮蔽（M-5）
  // -------------------------------------------------------------------------
  {
    const userDir = path.join(home, 'packs', 'zz-shadow');
    makePackDir(userDir, good('zz-shadow', { version: '1.0.0', contributes: { tools: true } }), MIN_CODE);
    const cfgDir = path.join(tmp('shadow-cfg'), 'zz-shadow');
    makePackDir(cfgDir, good('zz-shadow', { version: '2.0.0', contributes: { tools: true } }), MIN_CODE);
    const found = packs.listPacks({ packs: [cfgDir] }, tmp('shadow-proj'));
    const hit = found.find((p) => p.name === 'zz-shadow');
    check(hit && hit.source === 'config', 'P14：config 显式声明的版本必须胜出', JSON.stringify(hit));
    check(hit?.shadowed && hit.shadowed.source === 'user', 'P14：被遮蔽的 user 版本必须可见（shadowed）', JSON.stringify(hit?.shadowed));

    // 未信任项目里放同名 Pack：绝不能把 user 版本顶掉
    const proj = tmp('shadow-proj-untrusted');
    const projDir = path.join(proj, '.mingdao', 'packs', 'zz-shadow');
    makePackDir(projDir, good('zz-shadow', { version: '3.0.0', contributes: { tools: true } }), MIN_CODE);
    const found2 = packs.listPacks({}, proj);
    const hit2 = found2.find((p) => p.name === 'zz-shadow');
    check(hit2 && hit2.source === 'user' && !hit2.gate, 'P14：未信任项目版本不得遮蔽已生效的 user 版本', JSON.stringify(hit2));
    check(Boolean(hit2?.warning && hit2.warning.includes('同名冲突')), 'P14：遮蔽冲突必须告警', JSON.stringify(hit2?.warning));
    ok('P14 三级遮蔽：高优先级胜出且可见；未信任版本不参与遮蔽');
  }

  // -------------------------------------------------------------------------
  // P15 禁用开关 = 信任门：未信任不挂载；trust 后挂载；内容一变自动失效
  // -------------------------------------------------------------------------
  {
    const proj = tmp('trust');
    const packsDir = path.join(proj, '.mingdao', 'packs');
    const dir = path.join(packsDir, 'zz-trust');
    const code = `export const apiVersion = 1;
export function createPack() { return { promptSections: [{ id: 'zz', content: 'trusted-pack-section' }] }; }
`;
    makePackDir(dir, good('zz-trust', { contributes: { promptSections: [] } }), code);
    // 目录内容存在但从未 trust：gate=untrusted
    check(packs.packTrustState(packsDir).reason === 'untrusted', 'P15：未 trust 的项目级 Pack 必须报 untrusted', JSON.stringify(packs.packTrustState(packsDir)));
    const listed = packs.listPacks({}, proj).find((p) => p.name === 'zz-trust');
    check(listed?.gate === 'untrusted', 'P15：未信任项目级 Pack 必须带 gate', JSON.stringify(listed));
    packs.resetPacksForTest();
    const m1 = await packs.mountPacks({}, { cwd: proj });
    check(!m1.mounted.some((p) => p.name === 'zz-trust'), 'P15：未信任项目级 Pack 不得挂载（默认禁用）', JSON.stringify(m1.mounted.map((p) => p.name)));
    check(m1.warnings.some((w) => w.includes('未挂载（未信任）') && w.includes('mingdao pack trust')), 'P15：未挂载必须告诉用户原因与怎么解', JSON.stringify(m1.warnings));
    check(!m1.promptSections.some((s) => s.pack === 'zz-trust'), 'P15：未信任 Pack 的提示词段不得注入', JSON.stringify(m1.promptSections.map((s) => s.pack)));

    // 显式 trust 后挂载
    const t = packs.trustPack(packsDir);
    check(t.ok === true, 'P15：trustPack 必须成功', JSON.stringify(t));
    packs.resetPacksForTest();
    const m2 = await packs.mountPacks({}, { cwd: proj });
    check(m2.mounted.some((p) => p.name === 'zz-trust'), 'P15：trust 之后必须挂载', JSON.stringify(m2.mounted.map((p) => p.name)));
    check(m2.promptSections.some((s) => s.pack === 'zz-trust' && s.content === 'trusted-pack-section'), 'P15：挂载后提示词段必须注入', JSON.stringify(m2.promptSections));

    // 内容变化 → 信任自动失效（禁用开关重新关上）
    fs.appendFileSync(path.join(dir, 'pack.mjs'), '\n// changed after trust\n');
    check(packs.packTrustState(packsDir).reason === 'changed', 'P15：信任后内容变化必须判 changed', JSON.stringify(packs.packTrustState(packsDir)));
    const m3 = await packs.mountPacks({}, { cwd: proj });
    check(!m3.mounted.some((p) => p.name === 'zz-trust'), 'P15：内容变化后必须重新禁用（不得继续挂载）', JSON.stringify(m3.mounted.map((p) => p.name)));
    check(m3.warnings.some((w) => w.includes('发生过变化')), 'P15：内容变化必须给出可操作告警', JSON.stringify(m3.warnings));
    ok('P15 信任门：未信任不挂载 / trust 后挂载 / 内容变化自动失效');
  }

  // -------------------------------------------------------------------------
  // P16 幂等挂载 + 非法工具名跳过（坏工具不能拖垮整个 Pack，但必须可见）
  // -------------------------------------------------------------------------
  {
    const cfgDir = tmp('tools');
    const dir = path.join(cfgDir, 'zz-tools');
    const longName = 'a'.repeat(55);
    const code = `export const apiVersion = 1;
export function createPack() {
  return { tools: [
    { name: 'bad name!', description: 'x', parameters: { type: 'object' }, run: async () => ({ ok: true }) },
    { name: '${longName}', description: 'x', parameters: { type: 'object' }, run: async () => ({ ok: true }) },
    { name: 'good_tool', description: 'x', parameters: { type: 'object' }, run: async () => ({ ok: true }) },
  ] };
}
`;
    makePackDir(dir, good('zz-tools', { contributes: { tools: true } }), code);
    packs.resetPacksForTest();
    const m1 = await packs.mountPacks({ packs: [dir] }, { cwd: tmp('tools-proj') });
    check(m1.mounted.some((p) => p.name === 'zz-tools'), 'P16：Pack 本身必须挂载成功', JSON.stringify(m1.mounted.map((p) => p.name)));
    check(m1.warnings.some((w) => w.includes('工具名非法（已跳过）')), 'P16：非法工具名必须被 Pack 层主动告警并跳过（不能只靠 registerTool 抛错兜底）', JSON.stringify(m1.warnings));
    check(m1.warnings.some((w) => w.includes('注册名过长')), 'P16：注册名超过 64 必须先告警而不是注册失败', JSON.stringify(m1.warnings));
    check(packs.loadedPackNames().includes('zz-tools'), 'P16：已加载列表必须包含该 Pack', JSON.stringify(packs.loadedPackNames()));

    const m2 = await packs.mountPacks({ packs: [dir] }, { cwd: tmp('tools-proj2') });
    check(m2.mounted.some((p) => p.name === 'zz-tools'), 'P16：第二次挂载必须仍然列出该 Pack（幂等，不能返回空）', JSON.stringify(m2.mounted.map((p) => p.name)));
    check(m2.toolCount === m1.toolCount, 'P16：幂等挂载不得重复注册工具（toolCount 不得翻倍）', `${m1.toolCount} → ${m2.toolCount}`);
    ok('P16 幂等挂载 + 非法工具名');
  }

  console.log('\npacks-capabilities：16 项全部通过');
} finally {
  for (const dir of cleanups) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结论 */
    }
  }
}
