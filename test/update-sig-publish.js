// 签名发布计划的纯逻辑（v0.6.45）。
//
// 重点不是"能上传"，而是**只发布该版本、且只发布安装包的签名**：
//   · 混进别的版本的 .sig → 用户在旧 feed 上验签会莫名其妙失败；
//   · 把 `latest*.yml.sig` 放进 /updates/ → 回滚语义（`rm *.sig` = 关闭验签）变模糊。
import assert from 'node:assert/strict';
import { planSignaturePublish, SITE_UPDATES_DIR } from '../scripts/publish-update-sigs.mjs';

let passed = 0;
const ok = (n) => { passed += 1; console.log(`  ✓ ${n}`); };

{
  const r = planSignaturePublish([
    { name: 'mingdao-setup-0.6.44-x64.exe.sig' },
    { name: 'mingdao-0.6.44-arm64.dmg.sig' },
    { name: 'mingdao-setup-0.6.43-x64.exe.sig' }, // 别的版本
    { name: 'latest.yml.sig' },                    // 清单签名
    { name: 'mingdao-setup-0.6.44-x64.exe' },      // 安装包本体
  ], '0.6.44');
  assert.deepEqual(r.publish.map((x) => x.sig), ['mingdao-0.6.44-arm64.dmg.sig', 'mingdao-setup-0.6.44-x64.exe.sig']);
  ok('① 只挑本版本、只挑 .sig，且排序稳定');
}
{
  const r = planSignaturePublish([{ name: 'latest-mac.yml.sig' }, { name: 'latest.yml.sig' }], '0.6.44');
  assert.equal(r.publish.length, 0);
  ok('② 清单签名不进 /updates（不会误发布）');
}
{
  const r = planSignaturePublish([{ name: 'mingdao-setup-0.6.44-x64.exe.sig' }], '0.6.44');
  assert.equal(r.publish[0].artifact, 'mingdao-setup-0.6.44-x64.exe', '必须能还原出被测安装包名');
  ok('③ 由 sig 名还原安装包名（客户端按这个名字取 sig）');
}
{
  assert.equal(planSignaturePublish([], '0.6.44').publish.length, 0);
  assert.equal(planSignaturePublish(null, '0.6.44').publish.length, 0);
  ok('④ 空/非法输入不抛');
}
{
  assert.equal(SITE_UPDATES_DIR, '/opt/1panel/www/sites/mingdao-site/updates');
  ok('⑤ 目标目录常量与 nginx 站点一致');
}

console.log(`\nupdate-sig-publish：${passed} 项通过`);
