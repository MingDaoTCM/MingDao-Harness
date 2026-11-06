// 给发布产物签「更新来源签名」（ed25519），产物 = 安装包 + 更新清单。
//
// 为什么需要它：electron-updater 校验的 sha512 与包**同源**（清单里就有），谁控制 feed 谁就能
// 同时换掉包和 sha512。`.sig` 是把"来源"从"同源"里拆出来的唯一办法：私钥只在发布侧，
// 客户端内置公钥（`desktop/update-verify.js` 的 UPDATE_PUBLIC_KEYS 密钥环）。
//
// 用法：
//   UPDATE_SIGNING_KEY_FILE=~/.mingdao/update-signing-key.pem \
//     node scripts/sign-release-assets.mjs <产物目录> [--out <目录>] [--allow-missing-key]
//
// 产物 `.sig` 内容：`ed25519:<base64>`（与 desktop/update-verify.js 的 parseSignatureText 对齐）。
// 发布侧把 `.sig` 放到 feed 目录（`/updates/<文件名>.sig`）——客户端按这个路径取。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** 需要签名的产物扩展名（安装包本体）。更新清单 latest*.yml 也签。 */
const ARTIFACT_EXT = /\.(exe|dmg|zip|AppImage|deb)$/i;
const MANIFEST_RE = /^latest(-linux|-mac)?\.yml$/i;

/** @param {string} dir @returns {string[]} */
export function listSignableFiles(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (ARTIFACT_EXT.test(entry.name) || MANIFEST_RE.test(entry.name)) out.push(path.join(dir, entry.name));
  }
  return out.sort();
}

/**
 * 用 ed25519 私钥签名一段字节，返回 `ed25519:<base64>`。
 * @param {Buffer|Uint8Array|string} bytes
 * @param {import('node:crypto').KeyObject} privateKey
 * @returns {string}
 */
export function signBytes(bytes, privateKey) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const sig = crypto.sign(null, buf, privateKey);
  if (sig.length !== 64) throw new Error(`ed25519 签名必须 64 字节，实际 ${sig.length}`);
  return `ed25519:${sig.toString('base64')}`;
}

/**
 * 给目录里所有可签文件产出 `<文件名>.sig`（覆盖写）。
 * @param {{dir: string, outDir?: string, privateKey: import('node:crypto').KeyObject}} opts
 * @returns {{signed: string[], skipped: string[]}}
 */
export function signReleaseAssets({ dir, outDir = dir, privateKey }) {
  const signed = [];
  /** @type {string[]} */
  const skipped = [];
  for (const file of listSignableFiles(dir)) {
    if (file.endsWith('.sig')) continue;
    try {
      const text = signBytes(fs.readFileSync(file), privateKey) + '\n';
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, path.basename(file) + '.sig'), text, { mode: 0o644 });
      signed.push(path.basename(file));
    } catch (err) {
      skipped.push(`${path.basename(file)}: ${String(/** @type {any} */ (err)?.message || err)}`);
    }
  }
  return { signed, skipped };
}

/** 从环境变量/文件读私钥（只接受 ed25519）。 */
export function loadSigningKey({ keyFile, keyPem } = /** @type {any} */ ({})) {
  const env = process.env;
  const pem = String(keyPem || env.UPDATE_SIGNING_KEY || '').trim()
    || (keyFile || env.UPDATE_SIGNING_KEY_FILE
      ? fs.readFileSync(String(keyFile || env.UPDATE_SIGNING_KEY_FILE), 'utf8')
      : '');
  if (!pem) return { ok: false, error: '没有签名私钥：设 UPDATE_SIGNING_KEY（PEM）或 UPDATE_SIGNING_KEY_FILE（路径）' };
  let key;
  try {
    key = crypto.createPrivateKey(pem);
  } catch (err) {
    return { ok: false, error: `私钥无法解析：${String(/** @type {any} */ (err)?.message || err)}` };
  }
  if (key.asymmetricKeyType !== 'ed25519') return { ok: false, error: `私钥类型是 ${key.asymmetricKeyType ?? '未知'}，只接受 ed25519` };
  return { ok: true, key };
}

// CLI
// v0.6.37：**不要**用 `file://${process.argv[1]}` 判"是不是被当脚本执行"——
// Windows 上 argv[1] 是 `D:\a\repo\...`，拼出来是 `file://D:\a\...`，而 import.meta.url 是
// `file:///D:/a/...`（多一个斜杠、反斜杠归一化）→ 永不相等 → CLI 整段不执行、静默 exit 0。
// 后果：Windows CI 上 `test/update-signing.js ⑦b`（CLI 无密钥必须非零退出）红、`batch77 ⑦` 逃逸。
// 正确做法是用 pathToFileURL() 做同一套归一化。
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--')) || 'dist';
  const outIdx = args.indexOf('--out');
  const outDir = outIdx >= 0 ? args[outIdx + 1] : dir;
  const allowMissing = args.includes('--allow-missing-key');
  if (!fs.existsSync(dir)) { console.error(`目录不存在：${dir}`); process.exit(2); }
  const k = loadSigningKey({});
  if (!k.ok) {
    if (allowMissing) { console.log(`⚠ 跳过签名：${k.error}`); process.exit(0); }
    console.error(`✗ ${k.error}（如确实不签，加 --allow-missing-key）`); process.exit(1);
  }
  const { signed, skipped } = signReleaseAssets({ dir, outDir, privateKey: k.key });
  for (const f of signed) console.log(`  ✓ ${f}.sig`);
  for (const f of skipped) console.error(`  ✗ ${f}`);
  console.log(`\n签名完成：${signed.length} 个${skipped.length ? `，失败 ${skipped.length} 个` : ''}`);
  process.exit(skipped.length ? 1 : 0);
}
