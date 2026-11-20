// 官方 Pack 的版本窗口必须覆盖当前内核版本（v0.7.0 事故的守卫）。
//
// 事故：0.7.0 首次打 tag 时 CI smoke 全红——`packs/example-hello/pack.json` 的 `engines.mingdao`
// 是 `>=0.4.6 <0.7`，版本翻到 0.7.0 后**官方示例 Pack 自身校验失败**。
// 本地门禁跑在 0.6.45 上（版本没 bump），所以全绿；只有 tag 的 CI 才暴露。
//
// 教训：**版本号 bump 本身就是一次代码变更**。它能改变"版本窗口"这类语义，而本地门禁跑的是旧号。
// 这个测试把"窗口必须覆盖当前版本"钉在本地门禁里，下次 bump 到 0.8.0 会当场红。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { satisfiesRange } from '../src/packs.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const packsDir = path.join(root, 'packs');
let passed = 0;
const ok = (n) => { passed += 1; console.log(`  ✓ ${n}`); };

const dirs = fs.readdirSync(packsDir).filter((d) => fs.existsSync(path.join(packsDir, d, 'pack.json')));
assert.ok(dirs.length > 0, '仓库里应至少有一个官方 Pack');

for (const d of dirs) {
  const manifest = JSON.parse(fs.readFileSync(path.join(packsDir, d, 'pack.json'), 'utf8'));
  const range = manifest?.engines?.mingdao;
  assert.ok(typeof range === 'string' && range.trim(), `${d}：必须声明 engines.mingdao`);
  assert.ok(
    satisfiesRange(pkgVersion, range),
    `${d}：engines.mingdao "${range}" 不覆盖当前内核 ${pkgVersion}` +
      `——版本 bump 后官方示例 Pack 会加载失败。请放宽窗口（如 <${pkgVersion.split('.')[0]}.${Number(pkgVersion.split('.')[1]) + 1}）。`
  );
  ok(`${d}：窗口 ${range} 覆盖当前版本 ${pkgVersion}`);
}

// ── v0.10.1：把"记得改窗口"变成"改不了忘"——sync-versions 在 bump 时自动放宽上界 ──
// v0.7.0 与 v0.10.0 各因窗口未覆盖自己而重新打 tag；光有"窗口必须覆盖当前版本"的断言不够，
// 因为它在 bump **之后**才红（本地跑的是旧号）。所以这里直接断言**自动放宽函数**的行为。
const sync = await import(pathToFileURL(path.join(root, 'scripts', 'sync-versions.mjs')).href);

const widenCases = [
  ['>=0.4.6 <0.10', '0.10.0', '>=0.4.6 <0.11', '窗口上界差一个 minor → 放宽'],
  ['>=0.4.6 <0.11', '0.10.0', null, '已覆盖 → 不动（幂等）'],
  ['>=0.4.6 <0.7', '0.10.3', '>=0.4.6 <0.11', '落后多个 minor → 一次推到下一个 minor'],
  ['>=1.0.0 <1.2', '1.2.0', '>=1.0.0 <1.3', '大版本同样适用'],
  ['^0.5.0', '0.10.0', null, '非 >=… <… 形状 → 不猜，原样返回 null'],
];
for (const [range, version, expected, label] of widenCases) {
  const got = sync.widenRange(range, version);
  assert.equal(got, expected, `widenRange("${range}", "${version}") 应为 ${JSON.stringify(expected)}，实得 ${JSON.stringify(got)}（${label}）`);
  ok(`sync-versions：${label}`);
}

assert.equal(sync.nextWindowUpper('0.10.3'), '<0.11', 'nextWindowUpper 取下一个 minor');
assert.equal(sync.nextWindowUpper('bad'), null, '非法版本返回 null（不猜）');
ok('sync-versions：nextWindowUpper 边界');

// 幂等性：对"已覆盖"的仓库跑一遍 dry-run，不应报告任何改动（现在仓库就是这个状态）。
const changed = sync.syncPackWindows({ root, dryRun: true });
assert.equal(changed.length, 0, `仓库当前 Pack 窗口应已覆盖 ${pkgVersion}，dry-run 不应有改动，实得 ${JSON.stringify(changed)}`);
ok('sync-versions：当前仓库 dry-run 零改动（幂等）');

// 只换 `<…` 段，前导 `>=…` 逐字保留（除上界外一个字节都不动）。
assert.equal(sync.widenRange('>=0.4.6 <0.10', '0.10.0'), '>=0.4.6 <0.11', '只替换上界段，保留下界原文');
ok('sync-versions：只改上界、不重排区间');

console.log(`\npack-window：${passed} 项通过`);
