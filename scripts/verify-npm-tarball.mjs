#!/usr/bin/env node
// 发布后核对：npm 上**已发布**的 tarball 是否真的来自 tag 树。
//
// 为什么需要它（2026-11-15 v0.9.0 事故）：发布流程里 tag 被重打过两次（修 pack 引擎窗口、
// 补 `desktop/deb-update.js` 的打包白名单），而 `npm publish` 用的是**更早**的工作树快照。
// 结果 npm 上的 0.9.0 里 `packs/example-hello/pack.json` 的引擎窗口仍是 `>=0.4.6 <0.9`——
// 恰好**排除了 0.9.0 自己**，`mingdao pack install example-hello` 会拒绝加载。
// 全部现有门禁都没发现，因为它们检查的是**工作树**，不是"用户实际拿到的东西"。
//
// 用法：
//   node scripts/verify-npm-tarball.mjs <版本号> [--tag v<版本号>]
//   例：node scripts/verify-npm-tarball.mjs 0.9.0
//
// 判据：从 registry 拉 tarball → 对每个"必须与 tag 逐字一致"的文件比对 sha256。
// 任何一处不一致即 exit 1，并打印 diff 摘要（不打印文件正文，避免泄密/刷屏）。
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const VERSION = args.find((a) => /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(a));
const tagArg = args.indexOf('--tag');
const TAG = tagArg >= 0 ? String(args[tagArg + 1] || '').trim() : VERSION ? `v${VERSION}` : '';
if (!VERSION) {
  console.error('用法：node scripts/verify-npm-tarball.mjs <版本号> [--tag v<版本号>]');
  process.exit(2);
}

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');

/** 必须与 tag 逐字一致的文件（用户装到的东西里最容易"打包时漂移"的几类）。 */
const CRITICAL = [
  'package.json',
  'packs/example-hello/pack.json',
  'packs/example-hello/pack.mjs',
  'src/deepseek-app.js',
  'src/app-protocol.js',
  // 注意：`desktop/**` 不在 npm 包的 `files` 白名单里（桌面壳只随安装包分发），核对它必然"缺失"。
  // 这里只核对**会装进用户机器**的那部分；desktop 的校验归 desktop 打包与 update-signing 门禁。
];

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function tagFile(rel) {
  try {
    return execFileSync('git', ['-C', root, 'show', `${TAG}:${rel}`], { maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return null;
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-tarball-check-'));
try {
  const tgz = execFileSync('npm', ['pack', `mingdao-harness@${VERSION}`, '--silent'], {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  }).trim().split('\n').pop();
  const tgzPath = path.join(dir, tgz);
  if (!fs.existsSync(tgzPath)) throw new Error(`npm pack 未产出 tarball：${tgz}`);
  execFileSync('tar', ['xzf', tgzPath, '-C', dir]);
  const pkgDir = path.join(dir, 'package');

  /** @type {string[]} */
  const problems = [];
  for (const rel of CRITICAL) {
    const local = path.join(pkgDir, rel);
    if (!fs.existsSync(local)) {
      problems.push(`${rel}：tarball 里**缺失**`);
      continue;
    }
    const a = sha256(fs.readFileSync(local));
    const tagBuf = tagFile(rel);
    if (!tagBuf) {
      problems.push(`${rel}：tag ${TAG} 里没有该文件（tag 打错？）`);
      continue;
    }
    const b = sha256(tagBuf);
    if (a !== b) problems.push(`${rel}：tarball ${a.slice(0, 12)}… ≠ tag ${b.slice(0, 12)}…`);
  }

  // 版本号本身也必须一致（防止把旧 tarball 当成新版本发布）。
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    if (String(pj.version) !== VERSION) problems.push(`package.json version=${pj.version} ≠ 目标 ${VERSION}`);
  } catch (err) {
    problems.push(`package.json 无法解析：${String(/** @type {any} */ (err)?.message || err)}`);
  }

  const fileCount = (() => {
    try {
      return execFileSync('tar', ['tzf', tgzPath], { encoding: 'utf8' }).trim().split('\n').length;
    } catch {
      return 0;
    }
  })();

  if (problems.length) {
    console.error(`✗ npm ${VERSION} 的 tarball 与 tag ${TAG} 不一致（${problems.length} 处，共 ${fileCount} 个文件）：`);
    for (const p of problems) console.error(`   · ${p}`);
    console.error('   → 说明 publish 用的不是该 tag 的工作树；需要重新发布一个修正版本（不要改 tag）。');
    process.exitCode = 1;
  } else {
    console.log(`✓ npm ${VERSION} 的 tarball 与 tag ${TAG} 一致（核对 ${CRITICAL.length} 个关键文件，共 ${fileCount} 个文件）`);
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
