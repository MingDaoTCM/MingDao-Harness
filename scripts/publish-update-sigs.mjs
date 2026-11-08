// 把一版的更新来源签名（`<安装包>.sig`）发布到官网 `/updates/`，客户端据此验签。
//
// 为什么需要单独脚本：签名在 CI 里签完只进 **GitHub Release**（阶段一）。
// 客户端取签名的地方是 `https://harness.mingdao.ai/updates/<安装包名>.sig`（`desktop/update-verify.js`
// 的 `UPDATE_FEED_BASE`），**不是** Release——所以"签了名"和"客户端能验"是两件事。
// 阶段二 = 把 Release 里的 `.sig` 搬到 `/updates/`。
//
// 回滚：`ssh <host> 'rm -f /opt/1panel/www/sites/mingdao-site/updates/*.sig'`
//       → 客户端回到"无签名 → 提示后照常安装"（warn-and-install）。
//
// 用法：
//   MINGDAO_GITHUB_TOKEN=... MDH_SITE_HOST=mingdao-server node scripts/publish-update-sigs.mjs 0.6.44
//   ... --dry-run          只列计划，不上传
//   ... --dir <本地目录>    从本地目录取 .sig（离线/已下载时）
// 退出码：0 = 全部就位；1 = 有失败。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = 'MingDaoTCM/MingDao-Harness';
/** 官网站点 `/updates` 在源机上的绝对路径（与 nginx 配置同源）。 */
export const SITE_UPDATES_DIR = '/opt/1panel/www/sites/mingdao-site/updates';

/**
 * 从 Release 资产列表里挑出"该版本的签名"，并给出发布计划（纯函数，可单测）。
 *
 * 只发布**安装包**的签名：`latest*.yml.sig` 之类清单签名不进 `/updates/`——
 * 客户端只对下载到的安装包验签；把清单签名放上去只会让 `rm *.sig` 的回滚语义变模糊。
 * @param {Array<{name:string}>} assets Release 资产
 * @param {string} version 版本号（如 `0.6.44`）
 * @returns {{publish:Array<{sig:string, artifact:string}>, skipped:string[]}}
 */
export function planSignaturePublish(assets, version) {
  const list = Array.isArray(assets) ? assets : [];
  const sigs = list.map((a) => String(a?.name || '')).filter((n) => n.endsWith('.sig') && n.includes(version));
  const publish = [];
  const skipped = [];
  for (const sig of sigs) {
    const artifact = sig.slice(0, -4);
    if (/^latest.*\.yml$/i.test(artifact)) { skipped.push(sig); continue; }
    publish.push({ sig, artifact });
  }
  publish.sort((a, b) => a.sig.localeCompare(b.sig));
  return { publish, skipped };
}

/** 下载 Release 里该版本的 `.sig` 到本地目录，返回文件名列表。 */
export async function downloadSigs({ version, dir, token, tag, fetchImpl = globalThis.fetch }) {
  const url = `https://api.github.com/repos/${REPO}/releases/tags/${tag || 'v' + version}`;
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`取 Release 失败：HTTP ${res.status}`);
  const data = await res.json();
  const { publish, skipped } = planSignaturePublish(data.assets || [], version);
  if (!publish.length) throw new Error(`Release ${tag || 'v' + version} 里没有该版本的 .sig`);
  fs.mkdirSync(dir, { recursive: true });
  const names = [];
  for (const { sig } of publish) {
    const asset = (data.assets || []).find((a) => a.name === sig);
    const r = await fetchImpl(asset.url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/octet-stream' }, redirect: 'follow' });
    if (!r.ok) throw new Error(`下载 ${sig} 失败：HTTP ${r.status}`);
    fs.writeFileSync(path.join(dir, sig), Buffer.from(await r.arrayBuffer()));
    names.push(sig);
  }
  return { names, skipped };
}

// 主入口守卫：比较 **realpath**（字符串比较在符号链接路径与 Windows 盘符下会静默不执行——
// 0.6.43 为此专门修过三个脚本，别再用 `file://${argv[1]}`）。
function isMainModule() {
  try {
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    const argv = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
    return Boolean(argv) && self === argv;
  } catch { return false; }
}

if (isMainModule()) {
  const argv = process.argv.slice(2);
  const version = argv.find((a) => /^\d+\.\d+\.\d+$/.test(a));
  const dryRun = argv.includes('--dry-run');
  const dirIdx = argv.indexOf('--dir');
  const dir = dirIdx >= 0 ? argv[dirIdx + 1] : fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-sigs-'));
  const host = process.env.MDH_SITE_HOST || 'mingdao-server';
  if (!version) { console.error('用法: publish-update-sigs.mjs <版本> [--dry-run] [--dir <目录>]'); process.exit(2); }
  let names;
  if (dirIdx >= 0) {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.sig') && n.includes(version));
    if (!names.length) { console.error(`✗ ${dir} 里没有 ${version} 的 .sig`); process.exit(1); }
  } else {
    const token = process.env.MINGDAO_GITHUB_TOKEN;
    if (!token) { console.error('✗ 需要 MINGDAO_GITHUB_TOKEN（或改用 --dir）'); process.exit(2); }
    names = (await downloadSigs({ version, dir, token })).names;
  }
  console.log(`发布 ${version} 的 ${names.length} 个签名 → ${host}:${SITE_UPDATES_DIR}`);
  for (const n of names) console.log('  ·', n);
  if (dryRun) { console.log('（--dry-run：未上传）'); process.exit(0); }
  try {
    execFileSync('scp', ['-q', ...names.map((n) => path.join(dir, n)), `${host}:${SITE_UPDATES_DIR}/`], { stdio: 'inherit' });
    execFileSync('ssh', [host, `chmod 644 ${SITE_UPDATES_DIR}/*.sig`], { stdio: 'inherit' });
    console.log('✓ 上传完成');
  } catch (err) {
    console.error('✗ 上传失败：', err.message);
    process.exit(1);
  }
}
