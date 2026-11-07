// 把 Let's Encrypt 证书绑定到 OSS 自定义域名（并校验它真的生效）。
//
// 为什么需要单独一个脚本：certbot 续期只更新本机文件，**OSS 自定义域名用的是 OSS 里那份**，
// 不重新绑定的话，90 天后 HTTPS 会静默失效（浏览器报证书过期）。
//
// 官方文档的两个坑（v0.6.39 实测）：
//   ① 证书必须放在 `<CertificateConfiguration>` 容器里，直接放 `<Cname>` 下会被**静默忽略**（返回 200 但证书不生效）；
//   ② 没传 `<PreviousCertId>` 时必须 `<Force>true</Force>`，否则不覆盖。
// 权限：oss:PutCname + yundun-cert:CreateSSLCertificate/DescribeSSLCertificatePrivateKey/DescribeSSLCertificatePublicKeyDetail。
//
// 用法：
//   OSS_ENV_FILE=~/.mingdao/oss.env node scripts/oss-cname-cert.mjs <域名> <fullchain.pem> <privkey.pem> [--verify]
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadOssConfig, ossDate, ossResource, signOss } from './oss-sync.mjs';

/**
 * 构造绑定证书的 XML（纯函数，可单测）。
 * @param {{domain: string, cert: string, key: string, certId?: string, force?: boolean}} p
 */
export function buildCnameCertXml({ domain, cert, key, certId, force = true }) {
  const id = certId ? `<CertId>${certId}</CertId>` : '';
  // 没给 CertId（即"新证书"）时必须 Force，否则 OSS 会以"当前证书ID不匹配"拒绝
  const forceTag = certId ? '' : `<Force>${force ? 'true' : 'false'}</Force>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<BucketCnameConfiguration>
  <Cname>
    <Domain>${domain}</Domain>
    <CertificateConfiguration>${id}<Certificate>${cert}</Certificate><PrivateKey>${key}</PrivateKey>${forceTag}</CertificateConfiguration>
  </Cname>
</BucketCnameConfiguration>`;
}

/** 把证书绑定到域名（调用 OSS PutCname）。 */
export async function bindCertificate({ cfg, domain, cert, key, certId, fetchImpl = globalThis.fetch }) {
  const body = buildCnameCertXml({ domain, cert, key, certId });
  const d = ossDate();
  const resource = ossResource(cfg.bucket, '') + '?cname&comp=add';
  const sig = signOss({ method: 'POST', contentType: 'application/xml', date: d, resource, sk: cfg.sk });
  const res = await fetchImpl(`${cfg.endpoint}/?cname&comp=add`, {
    method: 'POST',
    headers: { Date: d, 'Content-Type': 'application/xml', Authorization: `OSS ${cfg.ak}:${sig}` },
    body,
  });
  const text = await res.text();
  const code = (text.match(/<Code>([^<]*)</) || [])[1] || '';
  return { ok: res.ok, status: res.status, code, error: text.slice(0, 400) };
}

// CLI
// 被 import 时 process.argv[1] 可能是 undefined（`node -e`），必须判空，否则 import 就抛
const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain) {
  const [domain, certFile, keyFile, flag] = process.argv.slice(2);
  if (!domain || !certFile || !keyFile) {
    console.error('用法: oss-cname-cert.mjs <域名> <fullchain.pem> <privkey.pem> [--verify]');
    process.exit(2);
  }
  const loaded = loadOssConfig();
  if (!loaded.ok) { console.error(`✗ ${loaded.error}`); process.exit(2); }
  const cert = fs.readFileSync(certFile, 'utf8').trim();
  const key = fs.readFileSync(keyFile, 'utf8').trim();

  // 先在本地确认证书与域名匹配，避免把错证书推上去
  const { execFileSync } = await import('node:child_process');
  let subject = '';
  try {
    subject = execFileSync('openssl', ['x509', '-in', certFile, '-noout', '-subject'], { encoding: 'utf8' });
  } catch { /* 没装 openssl 就跳过本地校验 */ }
  const san = (() => {
    try { return execFileSync('openssl', ['x509', '-in', certFile, '-noout', '-ext', 'subjectAltName'], { encoding: 'utf8' }); } catch { return ''; }
  })();
  if (subject && !(`${subject}${san}`.includes(domain))) {
    console.error(`✗ 证书与域名不匹配：${domain}\n${subject.trim()}`);
    process.exit(1);
  }

  const r = await bindCertificate({ cfg: loaded.cfg, domain, cert, key });
  console.log(`绑定 ${domain} → HTTP ${r.status}${r.code ? ` ${r.code}` : ''}`);
  if (!r.ok) { console.error(r.error); process.exit(1); }

  if (flag === '--verify') {
    // 绑定是最终一致的，最多等 90 秒；用 openssl 读真实下发的证书 CN/SAN
    const { spawnSync } = await import('node:child_process');
    for (let i = 0; i < 18; i += 1) {
      await new Promise((r2) => setTimeout(r2, 5000));
      const out = spawnSync('bash', ['-lc', `echo | openssl s_client -connect ${domain}:443 -servername ${domain} 2>/dev/null | openssl x509 -noout -subject 2>/dev/null`], { encoding: 'utf8' }).stdout || '';
      if (out.includes(domain)) { console.log(`✓ 已生效：${out.trim()}`); process.exit(0); }
    }
    console.error('✗ 90 秒内未生效（OSS 仍下发默认证书），请检查 OSS 证书绑定状态');
    process.exit(1);
  }
}
