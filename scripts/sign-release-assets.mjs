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

/**
 * 列出可签名的文件（**默认递归**）。
 *
 * 为什么必须递归：`actions/download-artifact@v4` 会把每个 artifact 解到 `artifacts/<name>/` 下，
 * 于是所有安装包都在**子目录**里。v0.6.39 首版只扫单层，结果是「签名完成：0 个」并 exit 0——
 * 一个"看起来成功、其实什么都没签"的步骤，比失败更危险（随后 `gh release upload` 因空文件失败才暴露）。
 * 这里把"要不要递归"从调用方收回来：脚本自己保证"给一个目录就把里面能签的都签了"。
 *
 * @param {string} dir
 * @param {{recursive?: boolean}} [opts]
 * @returns {string[]} 绝对路径
 */
export function listSignableFiles(dir, { recursive = true, includeManifests = false } = {}) {
  /** @type {string[]} */
  const out = [];
  const walk = (/** @type {string} */ d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (recursive) walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      // **默认只签安装包，不签 latest*.yml**（v0.6.39 实测教训）：
      // 两个 mac 构建各自产出 `latest-mac.yml`，签完都叫 `latest-mac.yml.sig` →
      // `gh release upload` 直接 422（Release 附件名必须唯一），整个 publish job 变红。
      // 而且这些清单在站点上是**我们自己的 feed 生成器**产出的（不是从 artifacts 拷的），
      // 签 CI 里的那份对客户端没有任何作用；清单的完整性由 HTTPS + 安装包签名共同保证。
      // 需要审计清单时显式 `includeManifests: true`（调用方要自己保证文件名唯一）。
      const wanted = ARTIFACT_EXT.test(entry.name) || (includeManifests && MANIFEST_RE.test(entry.name));
      if (wanted) out.push(full);
    }
  };
  walk(dir);
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
export function signReleaseAssets({ dir, outDir = dir, privateKey, flat = false, includeManifests = false }) {
  const signed = [];
  /** @type {string[]} */
  const skipped = [];
  for (const file of listSignableFiles(dir, { includeManifests })) {
    if (file.endsWith('.sig')) continue;
    try {
      const text = signBytes(fs.readFileSync(file), privateKey) + '\n';
      // 默认**保持相对目录结构**（`artifacts/win-x64/xxx.exe` → `artifacts/win-x64/xxx.exe.sig`）：
      // 不同平台各有一份 `latest.yml`，扁平化会互相覆盖——那等于"签了但只剩一份"。
      // 需要扁平时显式 `flat: true`，重名会作为 skipped 报出来（不静默覆盖）。
      const rel = path.relative(dir, file);
      const target = flat ? path.join(outDir, path.basename(file) + '.sig') : path.join(outDir, rel + '.sig');
      if (flat && fs.existsSync(target)) {
        skipped.push(`${path.basename(file)}: 扁平化后与已有 .sig 重名，已跳过（请改用默认的保留目录结构）`);
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text, { mode: 0o644 });
      signed.push(rel);
    } catch (err) {
      skipped.push(`${path.relative(dir, file)}: ${String(/** @type {any} */ (err)?.message || err)}`);
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
