// 开发脚本：发版联动。
//
// 两件事：
//   ① 把根 package.json 的版本同步到 desktop/package.json（审计 Kimi 6.4）；
//   ② **把官方 Pack 的引擎窗口上界推到覆盖当前版本**——v0.7.0 与 v0.10.0 各因此翻车一次：
//      `packs/example-hello/pack.json` 写 `>=0.4.6 <0.10`，版本 bump 到 0.10.0 后
//      **官方示例 Pack 自身校验失败**（`test/pack-window.js` 只会在 bump 之后红，所以每次 bump 都要人肉兜一次）。
//      现在由本脚本在 bump 时自动放宽上界（`<0.10` → `<0.11`），把"记得改"变成"改不了忘"。
//
// 用法：node scripts/sync-versions.mjs [--dry-run]
// （CI 桌面构建前自动执行；本地 npm run desktop:dist 前亦执行）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * 由版本号推出"下一个 minor"的上界标记：`0.10.3` → `<0.11`；`1.2.0` → `<1.3`。
 * 只放宽 minor，不动 patch（窗口一直是 minor 粒度）。
 * @param {string} version
 * @returns {string|null}
 */
export function nextWindowUpper(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version || '').trim());
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return `<${major}.${minor + 1}`;
}

/**
 * 判断 semver 是否落在 `>=A <B` 这种由本仓库使用的窗口里（只处理这一种形状，其余原样返回 null）。
 * @param {string} version
 * @param {string} range
 * @returns {boolean|null}
 */
export function coversVersion(version, range) {
  const m = /^\s*>=\s*(\d+\.\d+\.\d+)\s*<\s*(\d+(?:\.\d+)*)\s*$/.exec(String(range || ''));
  if (!m) return null;
  const norm = (/** @type {string} */ s) => {
    const parts = s.split('.').map(Number);
    while (parts.length < 3) parts.push(0);
    return parts;
  };
  const cmp = (/** @type {number[]} */ a, /** @type {number[]} */ b) => {
    for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
  };
  const v = norm(version);
  return cmp(v, norm(m[1])) >= 0 && cmp(v, norm(m[2])) < 0;
}

/**
 * 需要时把窗口上界放宽到覆盖 `version`；不需要时原样返回。
 * 只替换 `<…` 那一段，保留前导 `>=…`（不重排、不加空格），保证除上界外逐字不变。
 * @param {string} range
 * @param {string} version
 * @returns {string|null} 新 range；`null` 表示不需要改/看不懂形状
 */
export function widenRange(range, version) {
  const covered = coversVersion(version, range);
  if (covered === null || covered === true) return null;
  const upper = nextWindowUpper(version);
  if (!upper) return null;
  const next = String(range).replace(/<\s*\d+(?:\.\d+)*/, upper);
  return next === range ? null : next;
}

/**
 * 扫描 `packs/*\/pack.json`，把不覆盖当前版本的上界放宽；返回改动清单。
 * @param {{root: string, dryRun?: boolean}} opts
 * @returns {Array<{file: string, from: string, to: string}>}
 */
export function syncPackWindows({ root, dryRun = false }) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const packsDir = path.join(root, 'packs');
  /** @type {Array<{file: string, from: string, to: string}>} */
  const changed = [];
  if (!fs.existsSync(packsDir)) return changed;
  for (const d of fs.readdirSync(packsDir)) {
    const file = path.join(packsDir, d, 'pack.json');
    if (!fs.existsSync(file)) continue;
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const range = manifest?.engines?.mingdao;
    const next = widenRange(range, version);
    if (!next) continue;
    manifest.engines.mingdao = next;
    if (!dryRun) fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
    changed.push({ file: path.relative(root, file), from: String(range), to: next });
  }
  return changed;
}

/** @param {string[]} argv */
export function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run');
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

  const dp = path.join(root, 'desktop', 'package.json');
  const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const deskPkg = JSON.parse(fs.readFileSync(dp, 'utf8'));
  if (deskPkg.version === rootPkg.version) {
    console.log(`desktop 版本已同步：${rootPkg.version}`);
  } else if (dryRun) {
    console.log(`[dry-run] desktop/package.json ${deskPkg.version} → ${rootPkg.version}`);
  } else {
    deskPkg.version = rootPkg.version;
    fs.writeFileSync(dp, JSON.stringify(deskPkg, null, 2) + '\n');
    console.log(`desktop/package.json 版本已同步为 ${rootPkg.version}`);
  }

  const changed = syncPackWindows({ root, dryRun });
  for (const c of changed) {
    console.log(`${dryRun ? '[dry-run] ' : ''}Pack 窗口放宽：${c.file}  ${c.from} → ${c.to}`);
  }
  if (!changed.length) console.log(`Pack 窗口已覆盖当前版本：${rootPkg.version}`);
  return changed.length;
}

// 仅在直接执行时跑（被测试 import 时不得产生副作用）。
const self = fileURLToPath(import.meta.url);
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === pathToFileURL(self).href) {
  main();
}
