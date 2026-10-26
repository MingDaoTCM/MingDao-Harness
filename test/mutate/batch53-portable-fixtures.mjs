// 批五十三（v0.6.27 §3.93：Windows CI 红——memory-recovery 的「不可写目录」夹具改为可移植的 fs 门面注入）
//
// 起因（v0.6.26 windows-latest Step 19「变异验证」）：
//   test/memory-recovery.js ⑧ 用 fs.chmodSync(home, 0o500) 造"目录不可写"，断言"写入失败必须有 warn"。
//   Windows（尤其 admin runner）上 chmod 只改只读位、**不阻止**目录内创建/重命名 → 写其实成功
//   → 没有 warn → 断言失败；套件崩在 ⑧，batch40 的 ⑦–⑩ 因根本没跑到而连带被判"逃逸"。
//   产品代码没有回归，错的是夹具的平台假设。
// 修法：给 endpoint-limits.json 的原子写临时文件注入 fs 门面，第一次写就抛 EACCES（所有平台同一行为），
//   并新增 smoke §161 结构守卫：不得 chmod / 不得平台跳过 / warn 断言与 finally 还原必须保留。
//
// 本批把这些判据逐条改回缺陷（结构类跑 §161，行为类跑整个 memory-recovery 套件）：
//   ① 把 chmod 加回去（退回"用权限位造不可写"）                       → §161 必须红；
//   ② 删掉日志 warn 断言（守卫静音，Windows 腿就再没人看 warn）       → §161 必须红；
//   ③ 注入改成平台跳过（if win32 不注入）                             → §161 必须红；
//   ④ 注入后不还原 fs 门面（污染后续用例）                           → §161 必须红；
//   ⑤ 注入不抛错（假装写成功，warn 永不出现）                         → 套件必须红；
//   ⑥ 第一次写放行、第二次才抛（不再是"第一次写就 EACCES"）           → 套件必须红。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SUITE = () => M.suite('test/memory-recovery.js');
// 结构类变异只用 §161 就能确定性抓到，且不依赖平台权限语义（Windows 腿同样成立）。
const GUARD = () => M.section('161');

M.mutate({
  name: '① 把 chmod 加回去（退回「用目录权限造不可写」）',
  file: 'test/memory-recovery.js',
  from: `  const realWriteFileSync = fs.writeFileSync;`,
  to: `  fs.chmodSync(home, 0o500); /* 变异：退回「目录不可写」夹具 */\n  const realWriteFileSync = fs.writeFileSync;`,
  expect: ['不得使用 chmod'],
  run: GUARD,
});

M.mutate({
  name: '② 删掉日志 warn 断言（把「写入失败 → warn」守卫静音）',
  file: 'test/memory-recovery.js',
  from: `    assert.ok(logs.join('\\n').includes('端点学习文件写入失败'), '写入失败时日志必须有 warn（写入失败）');\n`,
  to: `    /* 变异：删掉日志 warn 断言 */\n`,
  expect: ['两条 warn 断言'],
  run: GUARD,
});

M.mutate({
  name: '③ 注入改成平台跳过（Windows 上不注入，直接认为写失败）',
  file: 'test/memory-recovery.js',
  from: `  const realWriteFileSync = fs.writeFileSync;`,
  to: `  if (process.platform === 'win32') { /* 变异：平台跳过——Windows 上不注入 */ }\n  const realWriteFileSync = fs.writeFileSync;`,
  expect: ['process.platform'],
  run: GUARD,
});

M.mutate({
  name: '④ 注入后不还原 fs 门面（污染后续用例与清理写入）',
  file: 'test/memory-recovery.js',
  from: `    fs.writeFileSync = realWriteFileSync; // 先还原门面，再用真实 fs 收拾现场（否则清理写也会被拦）`,
  to: `    /* 变异：不还原门面，污染后续用例 */`,
  expect: ['finally 还原'],
  run: GUARD,
});

M.mutate({
  name: '⑤ 注入不抛错（假装写成功，warn 永不出现）',
  file: 'test/memory-recovery.js',
  from: `      err.path = String(p);\n      throw err;`,
  to: `      err.path = String(p);\n      return realWriteFileSync.call(fs, p, data, opts); /* 变异：不抛错，假装写成功 */`,
  expect: ['写入失败'],
  run: SUITE,
});

M.mutate({
  name: '⑥ 第一次写放行、第二次才抛（不再是「第一次写就 EACCES」）',
  file: 'test/memory-recovery.js',
  from: `      injectedFailures += 1;\n      const err = /** @type {any} */ (new Error(`,
  to: `      injectedFailures += 1;\n      if (injectedFailures === 1) return realWriteFileSync.call(fs, p, data, opts); /* 变异：第一次写放行 */\n      const err = /** @type {any} */ (new Error(`,
  expect: ['写入失败'],
  run: SUITE,
});

if (!M.report()) process.exit(1);
