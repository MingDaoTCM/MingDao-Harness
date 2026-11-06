// 批七十七（v0.6.36）：更新来源签名的密钥环 / 签名脚本 / 文案分层。
// 每条把关键点改回缺陷，`test/update-signing.js` 必须当场红。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const RUN = () => M.suite('test/update-signing.js');

M.mutate({
  name: '① 密钥环只试第一把（旧钥）——新钥签发的包全被拒',
  file: 'desktop/update-verify.js',
  from: '  for (const k of ring) {',
  to: '  for (const k of ring.slice(0, 1)) { // 变异：只试第一把',
  expect: ['新钥签名也必须验过'],
  run: RUN,
});

M.mutate({
  name: '② 密钥环验签失败也返回 ok（等于没有验签）',
  file: 'desktop/update-verify.js',
  from: "    if (r.ok) return { ...r, keyId: r.keyId || k.id };",
  to: "    if (true) return { ...r, keyId: r.keyId || k.id }; // 变异：第一个就返回，不论成败",
  expect: ['新钥签名也必须验过'],
  run: RUN,
});

M.mutate({
  name: '③ 内置密钥环只剩一把（升级会断）',
  file: 'desktop/update-verify.js',
  from: "  { id: 'legacy-2025', pem: UPDATE_PUBLIC_KEY_PEM, role: 'legacy' },",
  to: "  // 变异：删掉旧钥（存量客户端升级会断）",
  expect: ['密钥环必须≥2 把'],
  run: RUN,
});

M.mutate({
  name: '④ 签名脚本连非产物文件也签（.sig 会覆盖无关文件）',
  file: 'scripts/sign-release-assets.mjs',
  // v0.6.39：listSignableFiles 改成递归 walk 后，锚点跟随（out.push(dir/name) → out.push(full)）。
  from: "      const wanted = ARTIFACT_EXT.test(entry.name) || (includeManifests && MANIFEST_RE.test(entry.name));",
  to: "      const wanted = true; // 变异：所有文件都签",
  expect: ['只签安装包'],
  run: RUN,
});

M.mutate({
  name: '⑤ .sig 不带 ed25519: 前缀（服务端解析会对不上）',
  file: 'scripts/sign-release-assets.mjs',
  from: "  return `ed25519:${sig.toString('base64')}`;",
  to: "  return `${sig.toString('base64')}`; // 变异：丢前缀",
  expect: ['ed25519: 前缀'],
  run: RUN,
});

M.mutate({
  name: '⑥ 没有私钥也照样退出 0（静默发出无签名版本）',
  file: 'scripts/sign-release-assets.mjs',
  from: "    if (allowMissing) { console.log(`⚠ 跳过签名：${k.error}`); process.exit(0); }\n    console.error(`✗ ${k.error}（如确实不签，加 --allow-missing-key）`); process.exit(1);",
  to: "    console.log(`⚠ 跳过签名：${k.error}`); process.exit(0); // 变异：缺钥也成功",
  expect: ['CLI 无密钥必须非零退出'],
  run: RUN,
});

M.mutate({
  name: '⑦ 弹窗文案不再区分「公证」与「来源签名」',
  file: 'desktop/update-verify.js',
  from: "      '本次更新未验证来源签名（发布链路下一版接入）——已按默认策略安装；' + platformHint + '。\\n' +",
  to: "      '本次更新未验证来源签名（发布链路尚未接入签名）——已按默认策略安装。\\n' +",
  expect: ['必须提到系统级签名'],
  run: RUN,
});

M.mutate({
  name: '⑧ 弹窗正文超过两行（回退成说明书）',
  file: 'desktop/update-verify.js',
  from: "      '它防的是\"更新源被投毒\"；高安全场景可设 MINGDAO_REQUIRE_UPDATE_SIGNATURE=1 拒绝；详情见日志与官网。',",
  to: "      '它防的是\"更新源被投毒\"；\\n高安全场景可设 MINGDAO_REQUIRE_UPDATE_SIGNATURE=1 拒绝无签名更新。\\n详情见日志与官网。',",
  expect: ['最多两行'],
  run: RUN,
});

M.mutate({
  name: '⑨ 签名只扫单层目录（download-artifact 的子目录产物全部漏签）',
  file: 'scripts/sign-release-assets.mjs',
  from: '        if (recursive) walk(full);',
  to: '        if (false) walk(full); // 变异：不递归',
  expect: ['子目录里的'],
  run: RUN,
});

M.mutate({
  name: '⑩ 清单也签（两个 latest-mac.yml → 同名 .sig → Release 上传 422）',
  file: 'scripts/sign-release-assets.mjs',
  from: '      const wanted = ARTIFACT_EXT.test(entry.name) || (includeManifests && MANIFEST_RE.test(entry.name));',
  to: '      const wanted = ARTIFACT_EXT.test(entry.name) || MANIFEST_RE.test(entry.name);',
  expect: ['默认只签安装包'],
  run: RUN,
});

const ok = M.report();
process.exit(ok ? 0 : 1);
