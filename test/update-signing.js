// 更新来源签名：密钥环 / 签名脚本 / 弹窗文案分层的独立回归套件（v0.6.36）。
//
// 背景：用户把"更新未验证来源签名"读成"没签名/没公证"。实际是两层：
//   ① Apple 公证（Developer ID + notarize + staple）——管 .app 能不能运行；
//   ② 更新来源签名（ed25519）——管"更新包是不是我们私钥签的"，防 feed 投毒换源。
// 本套件钉住：密钥环能验多把钥、坏签名必拒、签名脚本产物可被环验、文案必须把两层说清。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const U = await import(pathToFileURL(path.join(root, 'desktop', 'update-verify.js')).href);
const S = await import(pathToFileURL(path.join(root, 'scripts', 'sign-release-assets.mjs')).href);

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

// ---------- ① 密钥环：多把钥都能验、坏签名必拒 ----------
{
  const mk = () => crypto.generateKeyPairSync('ed25519');
  const a = mk();
  const b = mk();
  const data = Buffer.from('update-artifact-bytes');
  const keys = [
    { id: 'old', pem: a.publicKey.export({ type: 'spki', format: 'pem' }) },
    { id: 'new', pem: b.publicKey.export({ type: 'spki', format: 'pem' }) },
  ];
  const sigA = crypto.sign(null, data, a.privateKey).toString('base64');
  const sigB = crypto.sign(null, data, b.privateKey).toString('base64');

  const ra = U.verifyArtifactSignatureWithKeyring({ bytes: data, signatureB64: sigA, keys });
  assert.equal(ra.ok, true, '旧钥签的包必须仍能验过（向后兼容）');
  assert.equal(ra.keyId, U.keyIdOf(a.publicKey.export({ type: 'spki', format: 'pem' })), 'keyId 必须是命中那把钥的指纹');
  ok('① 密钥环：旧钥签名可验（keyId = 命中钥指纹）');

  const rb = U.verifyArtifactSignatureWithKeyring({ bytes: data, signatureB64: sigB, keys });
  assert.equal(rb.ok, true, '新钥签名也必须验过');
  ok('② 密钥环：新钥签名可验（两把并存）');

  const tampered = Buffer.from('update-artifact-bytez');
  assert.equal(U.verifyArtifactSignatureWithKeyring({ bytes: tampered, signatureB64: sigB, keys }).ok, false, '改一个字节必须失败');
  assert.equal(U.verifyArtifactSignatureWithKeyring({ bytes: data, signatureB64: 'AAAA', keys }).ok, false, '非 64 字节签名必须失败');
  const wrong = crypto.sign(null, data, mk().privateKey).toString('base64');
  assert.equal(U.verifyArtifactSignatureWithKeyring({ bytes: data, signatureB64: wrong, keys }).ok, false, '环外密钥签名必须失败');
  ok('③ 密钥环：篡改 / 坏签名 / 环外密钥 全部拒绝');

  // 内置密钥环：至少两把（旧 legacy + 新 current），且都必须是 ed25519 公钥
  assert.ok(Array.isArray(U.UPDATE_PUBLIC_KEYS) && U.UPDATE_PUBLIC_KEYS.length >= 2, '内置密钥环必须≥2 把（旧+新，否则升级会断）');
  for (const k of U.UPDATE_PUBLIC_KEYS) {
    const key = crypto.createPublicKey(k.pem);
    assert.equal(key.asymmetricKeyType, 'ed25519', `内置公钥 ${k.id} 必须是 ed25519`);
  }
  ok('④ 内置密钥环：≥2 把且都是 ed25519');
}

// ---------- ② 签名脚本：产物可被密钥环验证 ----------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-assets-'));
  try {
    const pair = crypto.generateKeyPairSync('ed25519');
    const artifact = path.join(dir, 'mingdao-test-1.2.3-x64.exe');
    fs.writeFileSync(artifact, 'fake-installer-bytes');
    fs.writeFileSync(path.join(dir, 'latest.yml'), 'version: 1.2.3\n');
    fs.writeFileSync(path.join(dir, 'README.txt'), 'should be ignored\n');

    const res = S.signReleaseAssets({ dir, privateKey: pair.privateKey });
    assert.deepEqual(res.signed.sort(), ['latest.yml', 'mingdao-test-1.2.3-x64.exe'], '只签安装包与 latest*.yml（其它文件忽略）');
    assert.equal(res.skipped.length, 0, `不应有失败：${JSON.stringify(res.skipped)}`);
    assert.equal(fs.existsSync(path.join(dir, 'README.txt.sig')), false, '非产物文件不得产出 .sig');

    const sig = fs.readFileSync(artifact + '.sig', 'utf8');
    assert.ok(sig.startsWith('ed25519:'), '.sig 必须以 ed25519: 前缀（与服务端解析对齐）');
    const keys = [{ id: 'test', pem: pair.publicKey.export({ type: 'spki', format: 'pem' }) }];
    const v = U.verifyArtifactSignatureWithKeyring({ filePath: artifact, signatureB64: sig, keys });
    assert.equal(v.ok, true, '签名脚本的产物必须能被密钥环验证（同一套字节约定）');
    ok('⑤ 签名脚本：只签产物、.sig 前缀正确、可被密钥环验证');

    fs.writeFileSync(artifact, 'fake-installer-bytez');
    const bad = U.verifyArtifactSignatureWithKeyring({ filePath: artifact, signatureB64: sig, keys });
    assert.equal(bad.ok, false, '签名后改动安装包必须验签失败');
    ok('⑥ 签名脚本：安装包被改后签名失效（不是"签了就一直算数"）');

    // CLI 形态也要失败（`process.exit(0)` 的静默跳过是真实风险：CI 会以为"签过了"）
    const { spawnSync } = await import('node:child_process');
    const cli = spawnSync(process.execPath, [path.join(root, 'scripts', 'sign-release-assets.mjs'), dir], {
      env: { ...process.env, UPDATE_SIGNING_KEY: '', UPDATE_SIGNING_KEY_FILE: '' },
      encoding: 'utf8',
    });
    assert.notEqual(cli.status, 0, `CLI 无密钥必须非零退出（实际 ${cli.status}）；stdout=${cli.stdout}`);
    assert.match(String(cli.stderr), /签名私钥/, 'CLI 必须说明缺私钥');
    ok('⑦b 签名 CLI：无密钥时非零退出且说明原因（不静默）');

    // 私钥缺省时必须**显式失败**（不能静默产出无签名发布）
    const r = S.loadSigningKey({ keyPem: '' });
    assert.equal(r.ok, false, '没有私钥时必须 ok:false');
    assert.match(String(r.error), /私钥/, '错误必须说明缺私钥');
    ok('⑦ 无签名私钥：显式失败（不静默）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- ③ 弹窗文案：必须把"公证"与"来源签名"分开 ----------
{
  const warn = U.buildUpdateNotice({ decision: 'warn-and-install', version: '9.9.9' });
  assert.ok(warn.title.includes('未验证来源签名'), '标题仍须如实写明"未验证来源签名"');
  assert.ok(warn.detail.split('\n').length <= 2, '弹窗正文最多两行（v0.6.21 的约定）');
  assert.match(warn.detail, /公证|系统级代码签名/, '必须提到系统级签名/公证，避免被读成"没公证"');
  assert.match(warn.detail, /不受影响/, '必须明确"系统级签名不受影响"');
  assert.match(warn.detail, /MINGDAO_REQUIRE_UPDATE_SIGNATURE=1/, '必须给出收紧开关');
  ok('⑧ 文案：两行内说清「公证不受影响 / 来源签名未接入」并给出开关');

  const good = U.buildUpdateNotice({ decision: 'install', version: '9.9.9', keyId: 'abc123' });
  assert.ok(good.detail.includes('校验通过') && good.detail.includes('abc123'), '验签通过时必须写明 keyId');
  const rejected = U.buildUpdateNotice({ decision: 'reject', version: '9.9.9', reason: '签名与更新包字节不匹配' });
  assert.equal(rejected.allowInstall, false, '拒绝档不得允许安装');
  assert.ok(rejected.detail.includes('签名与更新包字节不匹配'), '拒绝必须给出原因');
  ok('⑨ 文案：install 写明 keyId / reject 写明原因且不允许安装');
}

console.log(`\n更新来源签名：${passed} 项通过`);
