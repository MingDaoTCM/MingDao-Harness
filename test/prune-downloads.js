// 安装包目录裁剪的纯逻辑回归（v0.6.39）。
//
// 背景：源站 downloads/ 实测累计 8.9GB / 15 个版本，而"保留最近 4 版"的策略一直没人执行——
// 因为策略没有可执行的落点。本套件钉住裁剪计划的**语义**（哪些留、哪些删、什么不碰）。
import assert from 'node:assert/strict';
import { planPrune, versionOf, compareVersion } from '../scripts/prune-downloads.mjs';

let passed = 0;
const ok = (n) => { passed += 1; console.log(`  ✓ ${n}`); };

{
  assert.equal(versionOf('mingdao-0.6.39-arm64.dmg'), '0.6.39', '从文件名取版本');
  assert.equal(versionOf('MingDao Harness-0.6.39-mac.zip'), '0.6.39', '带空格的文件名也能取');
  assert.equal(versionOf('latest.yml'), null, '清单没有版本号');
  assert.equal(versionOf('readme.txt'), null, '无关文件没有版本号');
  ok('① versionOf：dmg/zip/清单/无关文件');

  assert.ok(compareVersion('0.6.10', '0.6.9') > 0, '0.6.10 > 0.6.9（不能按字符串比）');
  assert.ok(compareVersion('0.6.9', '0.6.10') < 0, '反向也成立');
  assert.equal(compareVersion('0.6.9', '0.6.9'), 0, '同版本相等');
  assert.ok(compareVersion('0.7.0', '0.6.99') > 0, '跨 minor 正确');
  ok('② compareVersion：数值逐段比较（0.6.10 > 0.6.9）');
}

{
  const files = [
    'mingdao-0.6.9-arm64.dmg', 'mingdao-0.6.10-arm64.dmg', 'mingdao-0.6.11-arm64.dmg',
    'latest.yml', 'latest-linux.yml', 'stats.json',
  ];
  const p = planPrune(files, { keep: 2 });
  assert.deepEqual(p.versions, ['0.6.11', '0.6.10', '0.6.9'], '版本按新→旧排序');
  assert.deepEqual(p.keep, ['mingdao-0.6.10-arm64.dmg', 'mingdao-0.6.11-arm64.dmg'], '保留最新 2 个版本');
  assert.deepEqual(p.drop, ['mingdao-0.6.9-arm64.dmg'], '最旧的被裁掉');
  assert.deepEqual(p.unknown, ['latest-linux.yml', 'latest.yml', 'stats.json'], '无版本号的文件一律不碰');
  ok('③ planPrune：保留最新 N 版、未知文件不碰');
}

{
  const files = ['a-1.0.0.exe', 'a-1.0.1.exe', 'a-1.0.2.exe'];
  assert.deepEqual(planPrune(files, { keep: 99 }).drop, [], 'keep 大于版本数 → 不删任何东西');
  assert.deepEqual(planPrune(files, { keep: 1 }).keep, ['a-1.0.2.exe'], 'keep=1 只留最新');
  assert.deepEqual(planPrune([], { keep: 2 }).versions, [], '空目录不崩');
  assert.deepEqual(planPrune(['x-2.0.0.bin'], { keep: 0 }).keep.length, 1, 'keep 非法（0）时按默认 4 处理');
  ok('④ planPrune：边界（keep 过大/为 1/空目录/非法值）');
}

{
  // 每版 7 个包 + 5 个 blockmap：整版要么全留、要么全删——不能"删了 dmg 留了 zip"
  const names = ['mingdao-setup-V-x64.exe', 'mingdao-V-arm64.dmg', 'mingdao-V-x64.dmg',
    'MingDao Harness-V-mac.zip', 'MingDao Harness-V-arm64-mac.zip', 'mingdao-V-x86_64.AppImage',
    'mingdao-V-amd64.deb', 'mingdao-V-arm64.dmg.blockmap'];
  const files = [];
  for (const v of ['0.6.38', '0.6.39']) for (const n of names) files.push(n.replace('V', v));
  const p = planPrune(files, { keep: 1 });
  assert.equal(p.keep.length, names.length, '最新版的所有文件都保留');
  assert.equal(p.drop.length, names.length, '旧版本的所有文件都裁掉（不会只删一部分）');
  assert.ok(p.drop.every((f) => f.includes('0.6.38')), '裁掉的一定是旧版本');
  ok('⑤ planPrune：按版本整组取舍（不会删一半留下半）');
}

console.log(`\nprune-downloads：${passed} 项通过`);
