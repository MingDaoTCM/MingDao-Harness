// OSS 自定义域名证书绑定的 XML 语义（v0.6.39）。
//
// 为什么值得单独测：这两个点是**静默失败**的——错了不会报错，只会"证书绑不上、90 天后 HTTPS 悄悄失效"。
//   ① 证书必须在 <CertificateConfiguration> 容器里；直接放 <Cname> 下返回 200 但不生效（我们踩过）；
//   ② 不传 <CertId> 时必须 <Force>true</Force>，否则 OSS 不覆盖现有证书。
import assert from 'node:assert/strict';
import { buildCnameCertXml } from '../scripts/oss-cname-cert.mjs';

let passed = 0;
const ok = (n) => { passed += 1; console.log(`  ✓ ${n}`); };

const CERT = '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----';
const KEY = '-----BEGIN PRIVATE KEY-----\nBBB\n-----END PRIVATE KEY-----';

{
  const xml = buildCnameCertXml({ domain: 'dl.example.com', cert: CERT, key: KEY });
  assert.match(xml, /<Domain>dl\.example\.com<\/Domain>/, '必须写入域名');
  assert.match(xml, /<CertificateConfiguration>/, '证书必须包在 CertificateConfiguration 里（放错位置会被静默忽略）');
  assert.ok(xml.indexOf('<CertificateConfiguration>') < xml.indexOf('<Certificate>'), 'Certificate 必须在容器内');
  assert.match(xml, /<Certificate>[\s\S]*BEGIN CERTIFICATE[\s\S]*<\/Certificate>/, '证书 PEM 原样写入');
  assert.match(xml, /<PrivateKey>[\s\S]*BEGIN PRIVATE KEY[\s\S]*<\/PrivateKey>/, '私钥 PEM 原样写入');
  ok('① 基本结构：域名 + CertificateConfiguration + PEM');
}

{
  const withId = buildCnameCertXml({ domain: 'd.example.com', cert: CERT, key: KEY, certId: '493***-cn-hongkong' });
  assert.match(withId, /<CertId>493\*\*\*-cn-hongkong<\/CertId>/, '给了 CertId 必须写入');
  assert.doesNotMatch(withId, /<Force>/, '有 CertId 时不应再加 Force（会覆盖别的证书）');
  ok('② 指定 CertId：写入 CertId 且不带 Force');
}

{
  const forced = buildCnameCertXml({ domain: 'd.example.com', cert: CERT, key: KEY });
  assert.match(forced, /<Force>true<\/Force>/, '未给 CertId 时必须 Force=true，否则不覆盖');
  const notForced = buildCnameCertXml({ domain: 'd.example.com', cert: CERT, key: KEY, force: false });
  assert.match(notForced, /<Force>false<\/Force>/, 'force:false 时如实写 false');
  ok('③ Force 规则：无 CertId 默认 true、可显式关掉');
}

{
  const xml = buildCnameCertXml({ domain: 'd.example.com', cert: CERT, key: KEY });
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), '必须是合法 XML 声明开头');
  assert.match(xml, /<BucketCnameConfiguration>[\s\S]*<Cname>[\s\S]*<\/Cname>[\s\S]*<\/BucketCnameConfiguration>/, '根节点与 Cname 容器完整');
  ok('④ XML 骨架完整（根节点 / Cname / 闭合）');
}

console.log(`\noss-cname-cert：${passed} 项通过`);
