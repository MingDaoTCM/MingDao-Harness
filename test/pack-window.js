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
import { fileURLToPath } from 'node:url';
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

console.log(`\npack-window：${passed} 项通过`);
