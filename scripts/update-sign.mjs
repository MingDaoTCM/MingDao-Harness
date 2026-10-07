#!/usr/bin/env node
// 更新包**来源签名**的发布侧工具（审计 K-8 / 报告 §5.2 主线 B 第 2 条）。
//
//   node scripts/update-sign.mjs --keygen [--out <目录>] [--allow-repo]
//   node scripts/update-sign.mjs --sign <安装包> [--key <私钥文件>]
//   node scripts/update-sign.mjs --verify <安装包> --pub <公钥 PEM>
//
// 三条纪律（与 desktop/update-verify.js 的文件头、docs/CODE-SIGNING.md §五 同一口径）：
//   ① **私钥永不打印、永不入库**：--keygen 只打印**公钥**；默认写到仓库之外
//      （`~/.mingdao/update-signing/`），且**拒绝**写进仓库——除非显式 `--allow-repo`。
//      私钥一旦进了公开仓库，等于把"伪造官方更新包"的能力交给所有人。
//   ② 私钥文件 600（Windows 无 POSIX 权限位，脚本会如实说明改用目录权限隔离）。
//   ③ 签名对象是**安装包的原始字节**（`crypto.sign(null, bytes, key)`），与
//      src/ledger.js 的账本来源签名同一套 ed25519 约定；公钥指纹 keyId 也是同一算法
//      （SPKI DER 的 sha256 前 16 位），所以两处的 keyId 可以直接互相认。
//
// 关于签名载体：`--sign` 产出 `<安装包>.sig`（旁车文件），而不是改写 latest*.yml 的字段——
// 理由是 `desktop/gen-update-yml.mjs` 每次打包都会把 latest*.yml **整份重写**，写进去的字段
// 下一次构建就没了；旁车文件与包同目录同名，发布时一起上传，客户端（desktop/main.js）
// 按 `<包名>.sig` 取。脚本仍会打印可直接粘进 yml 的 `signature:` 字段行，供未来的发布流程使用。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyIdOf, parseSignatureText, verifyArtifactSignature } from '../desktop/update-verify.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (/** @type {string} */ f) => argv.includes(f);
const optOf = (/** @type {string} */ f) => (argv.indexOf(f) >= 0 ? argv[argv.indexOf(f) + 1] : null);
const errMessage = (/** @type {unknown} */ e) => String((/** @type {any} */ (e)?.message ?? e));
const die = (/** @type {string} */ msg, /** @type {number} */ code = 1) => {
  console.error('✗ ' + msg);
  process.exit(code);
};

/** 密钥文件格式与 src/ledger.js 的 ledger-key.json 同款（base64 DER：SPKI 公钥 + PKCS8 私钥） */
function defaultKeyFile() {
  const dir = process.env.MINGDAO_UPDATE_KEY_DIR || path.join(os.homedir(), '.mingdao', 'update-signing');
  return path.join(dir, 'update-signing-key.json');
}

function readKeyFile(/** @type {string} */ file) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    die(`读不到签名密钥 ${file}：${errMessage(e)}（先跑 --keygen，或用 --key 指定）`);
  }
  try {
    const pub = typeof data.publicKey === 'string' && data.publicKey
      ? crypto.createPublicKey({ key: Buffer.from(data.publicKey, 'base64'), format: 'der', type: 'spki' })
      : null;
    const priv = typeof data.privateKey === 'string' && data.privateKey
      ? crypto.createPrivateKey({ key: Buffer.from(data.privateKey, 'base64'), format: 'der', type: 'pkcs8' })
      : null;
    if (!priv) die(`${file} 里没有 privateKey——签名需要私钥（公钥只能验签）`);
    const publicKey = pub || crypto.createPublicKey(/** @type {any} */ (priv));
    return { publicKey, privateKey: /** @type {import('node:crypto').KeyObject} */ (priv), keyId: keyIdOf(publicKey) };
  } catch (e) {
    die(`${file} 不是可用的 ed25519 密钥文件：${errMessage(e)}`);
  }
}

// ── --keygen：生成 ed25519 密钥对（私钥 600、绝不打印） ──────────────────────────
if (has('--keygen')) {
  const outDir = optOf('--out') ? path.resolve(/** @type {string} */ (optOf('--out'))) : path.dirname(defaultKeyFile());
  const outFile = outDir.endsWith('.json') ? outDir : path.join(outDir, 'update-signing-key.json');
  const inRepo = path.relative(repoRoot, outFile);
  if (!inRepo.startsWith('..') && !path.isAbsolute(inRepo) && !has('--allow-repo')) {
    die(
      `拒绝把私钥写进仓库：${outFile}\n` +
        '  私钥入库 = 任何拿到仓库的人都能伪造"官方更新包"。请写离线机 / CI secret：\n' +
        '    node scripts/update-sign.mjs --keygen --out ~/.mingdao/update-signing\n' +
        '  确需在仓库内做一次性演练，请显式加 --allow-repo（并当场删掉文件）。'
    );
  }
  if (fs.existsSync(outFile)) die(`密钥文件已存在，不覆盖：${outFile}\n  （换密钥意味着所有旧签名失效；确要重生成请先手工移走该文件）`);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const record = {
    alg: 'ed25519',
    keyId: keyIdOf(publicKey),
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    createdAt: Date.now(),
    note: '更新包来源签名私钥（MingDao Harness）。600 + 离线保管；绝不入库、绝不进日志/聊天/截图。',
  };
  fs.mkdirSync(path.dirname(outFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(outFile, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(outFile, 0o600);
  } catch {}
  const mode = (() => {
    try {
      return fs.statSync(outFile).mode & 0o777;
    } catch {
      return 0;
    }
  })();
  console.log('✓ 已生成 ed25519 更新签名密钥对');
  console.log('  keyId      : ' + record.keyId);
  console.log('  私钥文件   : ' + outFile + (process.platform === 'win32' ? '（Windows 无 POSIX 权限位，请用目录权限隔离）' : `（${mode.toString(8)}）`));
  console.log('  ⚠ 私钥绝不打印、绝不入库，也不该被复制到任何消息/工单/截图里；请备份到离线机或 CI secret。');
  console.log('');
  console.log('下一步：把下面这把**公钥**（可以公开）贴进 desktop/update-verify.js 的 UPDATE_PUBLIC_KEY_PEM：');
  console.log('');
  console.log(publicKey.export({ type: 'spki', format: 'pem' }).toString().trim());
  if (has('--allow-repo')) console.log('\n⚠ 你用了 --allow-repo：私钥现在在仓库里，提交前务必删除并轮换密钥。');
  process.exit(0);
}

// ── --sign：签安装包，产出 <包>.sig ────────────────────────────────────────────
if (has('--sign')) {
  const file = /** @type {string} */ (optOf('--sign'));
  if (!file) die('--sign 需要一个文件参数：--sign <安装包>');
  if (!fs.existsSync(file)) die(`文件不存在：${file}`);
  const keyFile = /** @type {string} */ (optOf('--key') || process.env.MINGDAO_UPDATE_SIGN_KEY || defaultKeyFile());
  const { privateKey, keyId } = readKeyFile(keyFile);
  const bytes = fs.readFileSync(file);
  const signature = crypto.sign(null, bytes, privateKey).toString('base64');
  const sigFile = file + '.sig';
  fs.writeFileSync(sigFile, signature + '\n');
  const sha512 = crypto.createHash('sha512').update(bytes).digest('base64');
  console.log('✓ 已签名 ' + path.basename(file) + '（' + bytes.length + ' 字节）');
  console.log('  keyId  : ' + keyId);
  console.log('  签名   : ' + sigFile + '（与安装包**同目录**上传到 feed 目录）');
  console.log('  sha512 : ' + sha512 + '（应与 latest*.yml 里的 sha512 逐字一致）');
  console.log('  yml 字段（可粘进 latest*.yml 顶层，供未来流程使用）：signature: "' + signature + '"');
  process.exit(0);
}

// ── --verify：发布侧自检（与客户端**同一实现**，避免"发布侧说通过、客户端说无效"） ──
if (has('--verify')) {
  const file = /** @type {string} */ (optOf('--verify'));
  if (!file) die('--verify 需要一个文件参数：--verify <安装包>');
  const pubArg = optOf('--pub');
  const keyFile = /** @type {string} */ (optOf('--key') || process.env.MINGDAO_UPDATE_SIGN_KEY || defaultKeyFile());
  let publicKeyPem = '';
  if (pubArg) {
    try {
      publicKeyPem = fs.readFileSync(pubArg, 'utf8');
    } catch (e) {
      die(`读不到公钥文件 ${pubArg}：${errMessage(e)}`);
    }
  } else {
    publicKeyPem = readKeyFile(keyFile).publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }
  const sigFile = file + '.sig';
  let signatureB64 = '';
  try {
    signatureB64 = fs.readFileSync(sigFile, 'utf8');
  } catch (e) {
    die(`读不到签名文件 ${sigFile}：${errMessage(e)}`);
  }
  const parsed = parseSignatureText(signatureB64);
  if (!parsed.ok) die(`签名文件不可用：${parsed.reason}`);
  const r = verifyArtifactSignature({ filePath: file, signatureB64: parsed.signatureB64, publicKeyPem });
  if (!r.ok) die(`验签失败：${r.reason}`);
  console.log(`✓ 验签通过：${path.basename(file)} · ed25519 · keyId=${r.keyId} · ${r.bytes} 字节`);
  process.exit(0);
}

console.log(`用法：
  node scripts/update-sign.mjs --keygen [--out <目录>] [--allow-repo]
  node scripts/update-sign.mjs --sign <安装包> [--key <私钥文件>]
  node scripts/update-sign.mjs --verify <安装包> [--pub <公钥PEM> | --key <私钥文件>]

密钥默认位置：${defaultKeyFile()}
托管与发布步骤：docs/CODE-SIGNING.md §五。私钥绝不打印、绝不入库。`);
process.exit(has('--help') || !argv.length ? 0 : 1);
