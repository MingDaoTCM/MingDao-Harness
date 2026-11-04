// 批七十三（v0.7.0 §1.2「变异补盲」）：`src/packs.js` 的契约校验与信任门变异。
//
// 这一批专挑"校验写少一层就静默失效"的地方：
//   · 保留名 / apiVersion 一致性 / engines 版本窗口 / 缺 pack.mjs
//   · caret 的 0.x 锁 minor 语义（写成 >= 会让 0.7 冒充 0.6 的兼容性）
//   · 能力声明与实际使用不一致时的告警（permissions 不强制，告警就是唯一真相）
//   · 约束 kind/pattern 的装载期校验（坏正则留到运行时 = 红线永不命中）
//   · 未信任项目级 Pack 不挂载 + 不参与遮蔽（M-5）
//   · 非法工具名跳过而不是注册失败
//
// 每条都在 `test/packs-capabilities.js` 上真跑，必须红且失败输出含对应 `P<n>：` 关键词。
// 用法：node test/mutate/batch73-packs.mjs
import { makeMutator } from './lib.mjs';

const M = makeMutator();
const RUN = () => M.suite('test/packs-capabilities.js');

// ① 不查保留名：core/mcp/mingdao 可被 Pack 占用
M.mutate({
  name: '① manifest 不再拒绝保留名',
  file: 'src/packs.js',
  from: '  } else if (RESERVED_PACK_NAMES.has(m.name)) {',
  to: '  } else if (false) { // 变异：不查保留名',
  expect: ['P4：保留名必须报错'],
  run: RUN,
});

// ② 不校验 engines 兼容窗口：声明了不兼容的内核版本也照装
M.mutate({
  name: '② 不校验 engines 兼容窗口',
  file: 'src/packs.js',
  from: '  } else if (!satisfiesRange(coreVersion, eng)) {',
  to: '  } else if (false) { // 变异：不校验兼容窗口',
  expect: ['P6：engines 不匹配必须报错'],
  run: RUN,
});

// ③ caret 退化成 ">="：^0.6.0 会接受 0.7.0（0.x 必须锁 minor）
M.mutate({
  name: '③ caret 0.x 锁 minor 语义失效',
  file: 'src/packs.js',
  from: '      if (target[0] !== 0) return v[0] === target[0];',
  to: '      if (target[0] !== 0) return true; // 变异：caret 退化成 >=',
  expect: ['P8：^1.2.3 必须拒绝 2.0.0'],
  run: RUN,
});

// ④ 能力声明不一致的告警被删：声明 fs/net 从此只是装饰
M.mutate({
  name: '④ 删除"未声明能力"告警',
  file: 'src/packs.js',
  from: '      if (used.length && undeclared.length) {',
  to: '      if (false && used.length && undeclared.length) { // 变异：不再对照能力声明',
  expect: ['P13：源码用了未声明的能力必须告警'],
  run: RUN,
});

// ⑤ 静态校验不再要求 pack.mjs：下游 CI 会放过多声明了代码贡献的 Pack
M.mutate({
  name: '⑤ 静态校验放过"声明代码贡献但缺 pack.mjs"',
  file: 'src/packs.js',
  from: "  if (hasCode && !fs.existsSync(path.join(dir, 'pack.mjs'))) {",
  to: '  if (false) { // 变异：不再要求 pack.mjs 存在',
  expect: ['P10：声明代码贡献却缺 pack.mjs 必须拒绝'],
  run: RUN,
});

// ⑥ 不比对 pack.mjs 与 pack.json 的 apiVersion：契约版本漂移无人发现
M.mutate({
  name: '⑥ 不比对 pack.mjs / pack.json 的 apiVersion',
  file: 'src/packs.js',
  from: '    if (mod.apiVersion !== undefined && mod.apiVersion !== manifest.apiVersion) {',
  to: '    if (false) { // 变异：不比对 apiVersion',
  expect: ['P11：pack.mjs 与 pack.json 的 apiVersion 不一致必须拒绝'],
  run: RUN,
});

// ⑦ 未信任的项目级版本参与遮蔽：内置/用户版本被顶掉，两边都不生效（M-5）
M.mutate({
  name: '⑦ 未信任项目版本参与同名遮蔽（M-5 回归）',
  file: 'src/packs.js',
  from: '      if (tier.gate && prev) {',
  to: '      if (false && tier.gate && prev) { // 变异：未信任版本也参与遮蔽',
  expect: ['P14：未信任项目版本不得遮蔽'],
  run: RUN,
});

// ⑧ 装载期不校验约束：坏 kind / 坏正则留到运行时静默失效
M.mutate({
  name: '⑧ 装载期不再校验约束（坏正则留到运行时）',
  file: 'src/packs.js',
  from: ['  constraints.forEach((/** @type {any} */ c, /** @type {number} */ i) => {', '    const e = validateConstraint(c, i);', '    if (e) errors.push(e);', '  });'].join('\n'),
  to: '  // 变异：不再校验约束',
  expect: ['P12：坏约束必须让整个 Pack 装载失败'],
  run: RUN,
});

// ⑨ 挂载时不再拦未信任项目级 Pack：git clone 即执行任意代码（P1-1 回归）
M.mutate({
  name: '⑨ 挂载时不再拦未信任项目级 Pack',
  file: 'src/packs.js',
  from: '    if (info.gate) {',
  to: '    if (false && info.gate) { // 变异：未信任也照挂',
  expect: ['P15：未信任项目级 Pack 不得挂载'],
  run: RUN,
});

// ⑩ 不校验工具名：非法名直接进注册表（注册失败/覆盖别人由运气决定）
M.mutate({
  name: '⑩ 不校验 Pack 工具名',
  file: 'src/packs.js',
  from: '      if (!TOOL_NAME_RE.test(bare)) {',
  to: '      if (false) { // 变异：不校验工具名',
  expect: ['P16：非法工具名必须被 Pack 层主动告警并跳过'],
  run: RUN,
});

const ok = M.report();
process.exit(ok ? 0 : 1);
