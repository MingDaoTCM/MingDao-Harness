// 阿里云 OSS 的最小客户端 + 同步工具（零依赖，只用 OSS REST API 的 V1 签名）。
//
// 为什么自己写而不是装 SDK：本仓零运行时依赖（`npm ls` 只有 devDeps），为了上传几个安装包
// 引入 @alicloud/oss-util 会打破这条底线；OSS 的 V1 签名只有十几行 HMAC-SHA1，可控且可测。
//
// 用法：
//   node scripts/oss-sync.mjs put <本地目录> <OSS 前缀> [--dry-run]
//   node scripts/oss-sync.mjs ls <OSS 前缀>
//   node scripts/oss-sync.mjs get <OSS 键> <本地文件>
//
// 凭据（**不进仓**）：环境变量 OSS_BUCKET / OSS_ENDPOINT / OSS_AK / OSS_SK，
// 或 `OSS_ENV_FILE=~/.mingdao/oss.env`（KEY=VALUE 形式，权限应为 0600）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.exe': 'application/octet-stream',
  '.dmg': 'application/octet-stream',
  '.zip': 'application/zip',
  '.AppImage': 'application/octet-stream',
  '.deb': 'application/vnd.debian.binary-package',
  '.blockmap': 'application/octet-stream',
  '.yml': 'text/yaml; charset=utf-8',
};

/** 读取凭据：env 优先，其次 OSS_ENV_FILE。缺项直接报错（不要静默用空串去签名）。 */
export function loadOssConfig(env = process.env) {
  let merged = { ...env };
  const file = env.OSS_ENV_FILE || '';
  if (file && fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in merged && merged[m[1]])) merged[m[1]] = m[2];
    }
  }
  const cfg = {
    bucket: merged.OSS_BUCKET || '',
    endpoint: (merged.OSS_ENDPOINT || '').replace(/\/+$/, ''),
    ak: merged.OSS_AK || '',
    sk: merged.OSS_SK || '',
  };
  const missing = Object.entries(cfg).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) return { ok: false, error: `缺少 OSS 配置：${missing.join(', ')}（设环境变量或 OSS_ENV_FILE）` };
  return { ok: true, cfg };
}

/** RFC1123 日期（OSS 要求 GMT）。 */
export function ossDate(d = new Date()) {
  return d.toUTCString();
}

/**
 * OSS V1 签名。
 * StringToSign = VERB\nContent-MD5\nContent-Type\nDate\nCanonicalizedOSSHeaders + CanonicalizedResource
 * 这里不设任何 x-oss-* 头，所以 CanonicalizedOSSHeaders 为空。
 * @param {{method: string, contentType?: string, md5?: string, date: string, resource: string, sk: string}} p
 */
export function signOss({ method, contentType = '', md5 = '', date, resource, sk }) {
  const stringToSign = `${method}\n${md5}\n${contentType}\n${date}\n${resource}`;
  return crypto.createHmac('sha1', sk).update(stringToSign, 'utf8').digest('base64');
}

/** 对象键 → 请求资源（`/bucket/key`，逐段 URL 编码）。 */
export function ossResource(bucket, key) {
  return `/${bucket}/${String(key).split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * 上传一个本地文件。
 * @param {{cfg:any, key:string, filePath:string, fetchImpl?: typeof fetch, date?: string}} p
 */
export async function putObject({ cfg, key, filePath, fetchImpl = globalThis.fetch, date }) {
  const body = fs.readFileSync(filePath);
  const contentType = MIME[path.extname(filePath)] || 'application/octet-stream';
  const d = date || ossDate();
  const resource = ossResource(cfg.bucket, key);
  const signature = signOss({ method: 'PUT', contentType, date: d, resource, sk: cfg.sk });
  // 虚拟主机风格：bucket 在域名里，路径**只**放 key（签名里的 resource 仍含 bucket）
  const res = await fetchImpl(`${cfg.endpoint}/${String(key).split('/').map(encodeURIComponent).join('/')}`, {
    method: 'PUT',
    headers: {
      Date: d,
      'Content-Type': contentType,
      'Content-Length': String(body.length),
      Authorization: `OSS ${cfg.ak}:${signature}`,
    },
    body,
  });
  return { ok: res.ok, status: res.status, size: body.length, key };
}

/**
 * 下载一个对象到本地文件（签名 GET）。
 * 用途：跨机器搬运——本机/CI 上传到 OSS，服务器再从 OSS **内网**拉取，
 * 避开"公网入向只有 0.1MB/s"的瓶颈（实测本机→OSS 2.4MB/s、OSS→同区域 ECS 秒级）。
 * @param {{cfg:any, key:string, filePath:string, fetchImpl?: typeof fetch}} p
 */
export async function getObject({ cfg, key, filePath, fetchImpl = globalThis.fetch }) {
  const d = ossDate();
  const resource = ossResource(cfg.bucket, key);
  const signature = signOss({ method: 'GET', date: d, resource, sk: cfg.sk });
  const res = await fetchImpl(`${cfg.endpoint}/${String(key).split('/').map(encodeURIComponent).join('/')}`, {
    method: 'GET',
    headers: { Date: d, Authorization: `OSS ${cfg.ak}:${signature}` },
  });
  if (!res.ok) return { ok: false, status: res.status, error: (await res.text()).slice(0, 200) };
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buf);
  return { ok: true, status: res.status, size: buf.length, key, filePath };
}

/** 列出前缀下的对象（最多 1000 个，够用）。 */
export async function listObjects({ cfg, prefix = '', fetchImpl = globalThis.fetch, date }) {
  const d = date || ossDate();
  const resource = ossResource(cfg.bucket, '');
  const qs = `prefix=${encodeURIComponent(prefix)}&max-keys=1000`;
  const signature = signOss({ method: 'GET', date: d, resource, sk: cfg.sk });
  const res = await fetchImpl(`${cfg.endpoint}/?${qs}`, {
    method: 'GET',
    headers: { Date: d, Authorization: `OSS ${cfg.ak}:${signature}` },
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 300) };
  const keys = [...text.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => m[1]);
  const sizes = [...text.matchAll(/<Size>(\d+)<\/Size>/g)].map((m) => Number(m[1]));
  return { ok: true, status: res.status, objects: keys.map((k, i) => ({ key: k, size: sizes[i] ?? null })) };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, a, b] = process.argv.slice(2);
  const loaded = loadOssConfig();
  if (!loaded.ok) { console.error(`✗ ${loaded.error}`); process.exit(2); }
  const { cfg } = loaded;
  if (cmd === 'put') {
    if (!a || !b) { console.error('用法: oss-sync.mjs put <本地目录> <OSS 前缀>'); process.exit(2); }
    const files = fs.readdirSync(a).filter((f) => fs.statSync(path.join(a, f)).isFile());
    let ok = 0; const bad = [];
    for (const f of files) {
      const r = await putObject({ cfg, key: `${b.replace(/\/+$/, '')}/${f}`, filePath: path.join(a, f) });
      if (r.ok) { ok += 1; console.log(`  ✓ ${f}  ${(r.size / 1048576).toFixed(1)}MB`); }
      else { bad.push(`${f}: HTTP ${r.status}`); console.error(`  ✗ ${f}  HTTP ${r.status}`); }
    }
    console.log(`\n上传完成：${ok} 个${bad.length ? `，失败 ${bad.length} 个` : ''}`);
    process.exit(bad.length ? 1 : 0);
  }
  if (cmd === 'get') {
    if (!a || !b) { console.error('用法: oss-sync.mjs get <OSS 键> <本地文件>'); process.exit(2); }
    const r = await getObject({ cfg, key: a, filePath: b });
    if (!r.ok) { console.error(`✗ HTTP ${r.status} ${r.error || ''}`); process.exit(1); }
    console.log(`  ✓ ${a} → ${b}（${(r.size / 1048576).toFixed(1)}MB）`);
    process.exit(0);
  }
  if (cmd === 'ls') {
    const r = await listObjects({ cfg, prefix: a || '' });
    if (!r.ok) { console.error(`✗ HTTP ${r.status} ${r.error}`); process.exit(1); }
    for (const o of r.objects) console.log(`  ${String(o.size ?? '?').padStart(10)}  ${o.key}`);
    console.log(`\n共 ${r.objects.length} 个对象`);
    process.exit(0);
  }
  console.error('用法: oss-sync.mjs put|ls ...');
  process.exit(2);
}
