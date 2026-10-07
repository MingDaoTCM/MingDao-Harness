// 更新包**来源签名**校验（审计 K-8 完整版 / 报告 §5.2 主线 B 第 2 条）。
//
// 为什么需要它（先把话说准）：
//   electron-updater 自带的 sha512 **不是**来源信任——它校验的是「下载到的字节」与
//   「**同一份 feed 提供的** latest*.yml 里的 sha512」是否一致。清单与包同源，同源即同谋：
//   谁控制了 feed（DNS / 主机 / CDN / 证书任一），谁就能同时换掉包与清单里的 sha512，
//   校验照样通过。探针 /tmp/probe-update-feed.mjs（未入库）跑过真实 desktop/main.js：
//     ① 投毒 feed + 攻击者自己算的 sha512 → 下载 → 校验 MATCH → quitAndInstall 被调用；
//     ② 只改字节不改清单（传输损坏）→ sha512 mismatch → 不安装。
//   即：sha512 只防传输损坏，**不防换了发布源**。本模块补的是后者：**来源**。
//
// 为什么是 ed25519（与 src/ledger.js 的账本来源签名同一取舍、同一套 crypto 约定）：
//   HMAC-SHA256 同样零依赖，但它的**验证密钥就是签名密钥**——任何能验签的人都获得了伪造能力，
//   与「把验证权交出去而不交出伪造能力」正好相反。ed25519 非对称：私钥只在离线机 / CI secret，
//   公钥可以公开（内置进客户端、也可以交给第三方复核）。签名对象是**安装包的原始字节**
//   （`crypto.sign(null, bytes, key)`，与 ledger 的封条签名同一写法）。
//
// 三态决策（decideUpdatePolicy，纯函数，便于逐条钉边界）：
//   · 有签名 + 验签通过            → 'install'           （可以装）
//   · 无签名 + 默认                → 'warn-and-install'  （**如实**告诉用户"本次更新未验证来源签名"）
//   · 无签名 + MINGDAO_REQUIRE_UPDATE_SIGNATURE=1 → 'reject'
//   · 有签名 + 验签失败 / 拿不到证据 → 'reject'           （一律拒绝，没有"忽略"选项）
//
// 默认为什么是 warn-and-install 而不是 reject（诚实边界，也是本轮的取舍）：
//   当前发布链路（desktop/gen-update-yml.mjs + 服务器脚本）**还没有签名步骤**（见
//   docs/CODE-SIGNING.md §五）。若默认 reject，等于一夜之间掐死所有存量用户的自动更新——
//   而威胁模型里"官网 feed 被投毒"是**低概率高影响**，"更新永远装不上"是**必然发生**。
//   所以默认放行但把话说清楚（UI + 日志都写"未验证来源签名"），把 fail-closed 开关交给
//   发行方/高安全用户（MINGDAO_REQUIRE_UPDATE_SIGNATURE=1）。发布链路接入签名后，默认值
//   是否改成 reject 由发行方决定——代码已就位、开关已存在，改一个默认值即可。
//
// **同一处诚实**：feed 被攻击者控制时，他可以**删掉签名**把这次更新降级成"无签名"（本模块
// 无法区分"本来没签"与"签名被剥离"）——默认档下这仍然会走到 warn-and-install。要真正关闭它，
// 必须让发布链路**每次都签**并且客户端 REQUIRE=1（或把默认值改成 reject）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const UPDATE_SIG_ALG = 'ed25519';

/** feed 目录（与 desktop/electron-builder.yml 的 publish.url 同源，只用于取 `<包名>.sig`） */
export const UPDATE_FEED_BASE = 'https://harness.mingdao.ai/updates/';

/**
 * **内置**更新签名公钥（pin 在源码里，运行期绝不从网络取——从网络取公钥等于没 pin）。
 *
 * 替换方式（发行方启用签名时）：`node scripts/update-sign.mjs --keygen --out <离线目录>`，
 * 把打印出来的公钥 PEM 原样贴到这里；私钥按 docs/CODE-SIGNING.md §五 离线保管。
 *
 * 诚实标注：这把公钥对应的私钥在本轮**未保留**（生成后即弃，从未写盘、从未打印）——
 * 也就是说"有签名且验签通过"这条路径在**当前发布链路**下永远不会被走到；本轮先到位的是
 * **机制 + fail-closed 判据**。它同时保证：任何**别人**签的包（含攻击者）一律验不过 → reject。
 */
export const UPDATE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAH3hTAqAm8Lju/y49sIDxs8/QFZAxbMgo+0Q1en5GEyc=
-----END PUBLIC KEY-----
`;

/**
 * 取本次校验用的公钥：默认**只**用内置常量。
 * `MINGDAO_UPDATE_PUBKEY_PEM` + `MINGDAO_UPDATE_ALLOW_PUBKEY_OVERRIDE=1` 是**显式**的开发/测试
 * 开关（两个都要给才生效；发布构建不得设置，见 CODE-SIGNING.md §五）。
 * @param {Record<string, string | undefined>} [env]
 * @returns {{pem: string, source: 'pinned'|'env-override'}}
 */
export function resolveUpdatePublicKeyPem(env = process.env) {
  const override = typeof env.MINGDAO_UPDATE_PUBKEY_PEM === 'string' ? env.MINGDAO_UPDATE_PUBKEY_PEM.trim() : '';
  if (override && env.MINGDAO_UPDATE_ALLOW_PUBKEY_OVERRIDE === '1') return { pem: override, source: 'env-override' };
  return { pem: UPDATE_PUBLIC_KEY_PEM, source: 'pinned' };
}

/** 是否要求"必须验签"（发行方/高安全用户开关；默认关，理由见文件头） */
export function requireSignatureFromEnv(env = process.env) {
  return String(env.MINGDAO_REQUIRE_UPDATE_SIGNATURE || '') === '1';
}

/**
 * 公钥指纹：SPKI DER 的 sha256 前 16 位（与 src/ledger.js 的 keyIdOf 同一约定）。
 * 它只用于**认人**（日志、比对"是不是换了一把密钥"），不是秘密。
 * @param {string | import('node:crypto').KeyObject} keyOrPem
 * @returns {string | null}
 */
export function keyIdOf(keyOrPem) {
  try {
    const key = keyOrPem && typeof keyOrPem === 'object' && typeof (/** @type {any} */ (keyOrPem).export) === 'function'
      ? /** @type {import('node:crypto').KeyObject} */ (keyOrPem)
      : crypto.createPublicKey(String(keyOrPem || ''));
    return crypto.createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

/**
 * 解析签名文本（`.sig` 文件内容 / yml 的签名字段）：取第一行非注释内容，允许 `ed25519:` 前缀。
 * ed25519 签名恒为 **64 字节**——长度不对就不是签名，早失败早拒绝。
 * @param {string} text
 * @returns {{ok: true, signatureB64: string} | {ok: false, reason: string}}
 */
export function parseSignatureText(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, reason: '签名字段为空' };
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (!lines.length) return { ok: false, reason: '签名字段为空（只有注释行）' };
  const value = lines[0].replace(/^ed25519:/i, '').trim().replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]+=*$/.test(value)) return { ok: false, reason: '签名字段不是合法的 base64' };
  const buf = Buffer.from(value, 'base64');
  if (buf.length !== 64) return { ok: false, reason: `签名长度不是 64 字节（ed25519 恒为 64，实际 ${buf.length}）` };
  return { ok: true, signatureB64: buf.toString('base64') };
}

/** 签名的旁车文件路径：与安装包同目录同名 + `.sig`（发布侧 `scripts/update-sign.mjs --sign` 产出） */
export function signatureSidecarPath(filePath) {
  return String(filePath || '') + '.sig';
}

/**
 * 读本机旁车签名（离线包 / 自签发布包 / 测试用）。
 * @param {string} filePath
 * @returns {{ok: true, signatureB64: string, source: string} | {ok: false, reason: string}}
 */
export function readSignatureFile(filePath) {
  if (!filePath) return { ok: false, reason: '没有更新包路径，读不到 .sig' };
  const p = signatureSidecarPath(filePath);
  let text;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch {
    return { ok: false, reason: `本机没有签名文件 ${path.basename(p)}` };
  }
  const parsed = parseSignatureText(text);
  if (!parsed.ok) return { ok: false, reason: `签名文件 ${path.basename(p)} 不可用：${parsed.reason}` };
  return { ok: true, signatureB64: parsed.signatureB64, source: path.basename(p) };
}

/**
 * 校验安装包字节的 ed25519 来源签名。
 * @param {{filePath?: string, bytes?: Buffer | Uint8Array | string, signatureB64?: string, publicKeyPem?: string | import('node:crypto').KeyObject}} [input]
 * @returns {{ok: true, keyId: string | null, bytes: number} | {ok: false, reason: string}}
 */
export function verifyArtifactSignature({ filePath, bytes, signatureB64, publicKeyPem } = {}) {
  /** @type {Buffer} */
  let data;
  if (bytes !== undefined && bytes !== null) {
    data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  } else if (filePath) {
    try {
      data = fs.readFileSync(filePath);
    } catch (err) {
      return { ok: false, reason: `读不到更新包文件（${filePath}）：${errMessage(err)}` };
    }
  } else {
    return { ok: false, reason: '没有给出更新包：filePath 与 bytes 至少要有一个' };
  }
  const parsed = parseSignatureText(signatureB64 ?? '');
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  /** @type {import('node:crypto').KeyObject} */
  let key;
  try {
    key =
      publicKeyPem && typeof publicKeyPem === 'object' && typeof (/** @type {any} */ (publicKeyPem).export) === 'function'
        ? /** @type {import('node:crypto').KeyObject} */ (publicKeyPem)
        : crypto.createPublicKey(String(publicKeyPem || ''));
  } catch (err) {
    return { ok: false, reason: `公钥无法解析（${errMessage(err)}）——有签名但没有可用的可信公钥` };
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    return { ok: false, reason: `公钥类型是 ${key.asymmetricKeyType ?? '未知'}，本版只认 ${UPDATE_SIG_ALG}` };
  }
  let ok = false;
  try {
    ok = crypto.verify(null, data, key, Buffer.from(parsed.signatureB64, 'base64'));
  } catch (err) {
    return { ok: false, reason: `验签过程出错：${errMessage(err)}` };
  }
  if (!ok) return { ok: false, reason: '签名与更新包字节不匹配（包被改过，或由另一把密钥签发）' };
  return { ok: true, keyId: keyIdOf(key), bytes: data.length };
}

/**
 * 三态决策（**纯函数**：只有这三个入参，便于逐条钉边界，见 test/smoke.js §135）。
 * 注意"有签名但拿不到 verifyResult"也归 reject——"无法确认来源"不等于通过。
 * @param {{hasSignature?: boolean, verifyResult?: {ok: boolean, reason?: string} | null, requireSignature?: boolean}} [input]
 * @returns {'install' | 'warn-and-install' | 'reject'}
 */
export function decideUpdatePolicy({ hasSignature, verifyResult, requireSignature } = {}) {
  const signed = hasSignature === true;
  const required = requireSignature === true;
  if (!signed) return required ? 'reject' : 'warn-and-install';
  if (verifyResult && verifyResult.ok === true) return 'install';
  return 'reject';
}

/**
 * 取签名载体，三个来源按优先级：① 清单内嵌（feed 把 signature 写进 latest*.yml）；
 * ② 本机旁车 `<包>.sig`；③ feed 目录同名 `<包>.sig`（发布侧正式载体，HTTPS 取公开数据）。
 *
 * **不要**把这里当成信任来源：攻击者控制的 feed 可以返回他自己的 .sig，也可以直接 404 把这次
 * 更新降级成"无签名"——降级后能不能装，由 decideUpdatePolicy 的默认档/开关决定（文件头已说明）。
 * @param {{filePath?: string, inlineSignature?: string, declaredSignature?: boolean, feedBase?: string, timeoutMs?: number, fetchImpl?: typeof fetch}} [input]
 * @returns {Promise<{hasSignature: boolean, declared: boolean, signatureB64: string, source: string, reason: string}>}
 */
export async function collectUpdateSignature({
  filePath,
  inlineSignature,
  declaredSignature,
  feedBase = UPDATE_FEED_BASE,
  timeoutMs = 8000,
  fetchImpl = globalThis.fetch,
} = {}) {
  const declared = declaredSignature === true;
  if (typeof inlineSignature === 'string' && inlineSignature.trim() !== '') {
    return { hasSignature: true, declared: true, signatureB64: inlineSignature.trim(), source: '更新清单内嵌', reason: '' };
  }
  const side = readSignatureFile(String(filePath || ''));
  if (side.ok) return { hasSignature: true, declared, signatureB64: side.signatureB64, source: side.source, reason: '' };
  if (filePath && typeof fetchImpl === 'function') {
    const url = new URL(encodeURIComponent(path.basename(String(filePath))) + '.sig', feedBase).href;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let text = '';
      try {
        const res = await fetchImpl(url, { signal: ctrl.signal, redirect: 'follow' });
        if (res && res.ok) text = await res.text();
      } finally {
        clearTimeout(timer);
      }
      const parsed = parseSignatureText(text);
      if (parsed.ok) return { hasSignature: true, declared, signatureB64: parsed.signatureB64, source: 'feed 目录 ' + path.basename(url), reason: '' };
      return { hasSignature: declared, declared, signatureB64: '', source: '无', reason: `feed 未提供可用的 ${path.basename(url)}` };
    } catch (err) {
      return { hasSignature: declared, declared, signatureB64: '', source: '无', reason: `取 ${path.basename(url)} 失败：${errMessage(err)}` };
    }
  }
  return { hasSignature: declared, declared, signatureB64: '', source: '无', reason: side.reason };
}

/**
 * 决策 + 文案的**单源**（main.js 只负责把它交给 dialog，避免"同一结论两处措辞"）。
 * @param {{decision: 'install'|'warn-and-install'|'reject', version?: string, keyId?: string | null, reason?: string}} input
 * @returns {{allowInstall: boolean, type: 'info'|'warning', title: string, message: string, detail: string, buttons: string[], defaultId: number, cancelId: number, noLink: boolean}}
 */
export function buildUpdateNotice({ decision, version, keyId, reason }) {
  const v = String(version || '');
  const manual = '请从官网手动下载最新版本：https://harness.mingdao.ai/#downloads';
  if (decision === 'reject') {
    return {
      allowInstall: false,
      type: 'warning',
      title: '已拒绝安装此更新',
      message: '更新包来源不可信，已拒绝安装',
      detail: `${reason || '来源签名校验未通过'}\n\n${manual}\n（若你确认当前网络/代理被劫持，可换网络后重试。）`,
      buttons: ['知道了'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
  }
  if (decision === 'install') {
    return {
      allowInstall: true,
      type: 'info',
      title: '更新已就绪',
      message: `MingDao Harness v${v} 下载完成，重启应用即可完成更新`,
      detail: `更新包来源签名校验通过（${UPDATE_SIG_ALG} · keyId=${keyId ?? '?'}）。更新不会改动你的配置与会话。更新内容见官网：https://harness.mingdao.ai`,
      buttons: ['立即重启安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    };
  }
  return {
    allowInstall: true,
    type: 'warning',
    title: '更新已就绪（未验证来源签名）',
    message: `MingDao Harness v${v} 下载完成，重启应用即可完成更新`,
    detail:
      `⚠ 本次更新未验证来源签名：${reason || 'feed 未提供签名'}。\n` +
      '当前发布链路还没有签名步骤，因此无法用密码学证明这个安装包确实来自官网；更新源被投毒时，它与官方包无法区分。\n' +
      '高安全场景可设 MINGDAO_REQUIRE_UPDATE_SIGNATURE=1：没有签名就拒绝安装。\n' +
      '更新不会改动你的配置与会话。更新内容见官网：https://harness.mingdao.ai',
    buttons: ['立即重启安装', '稍后'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
}

/**
 * 「下载完成 → 安装」之间那一道关：校验 + 决策 + 文案（main.js 调用它，smoke §135 直接测它）。
 * @param {{filePath?: string, bytes?: Buffer | Uint8Array | string, signatureB64?: string, declaredSignature?: boolean, publicKeyPem?: string | import('node:crypto').KeyObject, requireSignature?: boolean, source?: string, version?: string}} [input]
 * @returns {{decision: 'install'|'warn-and-install'|'reject', hasSignature: boolean, verifyResult: {ok: boolean, reason?: string, keyId?: string | null} | null, keyId: string | null, reason: string | null, allowInstall: boolean, logLine: string, notice: ReturnType<typeof buildUpdateNotice>}}
 */
export function evaluateUpdate({
  filePath,
  bytes,
  signatureB64,
  declaredSignature,
  publicKeyPem,
  requireSignature,
  source,
  version,
} = {}) {
  const declared = declaredSignature === true;
  const value = typeof signatureB64 === 'string' ? signatureB64.trim() : '';
  const hasSignature = declared || value !== '';
  /** @type {{ok: boolean, reason?: string, keyId?: string | null} | null} */
  let verifyResult = null;
  if (hasSignature) {
    verifyResult = value
      ? verifyArtifactSignature({ filePath, bytes, signatureB64: value, publicKeyPem })
      : { ok: false, reason: '更新清单声明了签名，但签名字段为空——"拿不到证据"不等于"没问题"' };
  }
  const decision = decideUpdatePolicy({ hasSignature, verifyResult, requireSignature: requireSignature === true });
  const keyId = verifyResult && verifyResult.ok === true ? verifyResult.keyId ?? null : keyIdOf(publicKeyPem);
  let reason = null;
  if (decision === 'reject') {
    reason = verifyResult && verifyResult.reason
      ? verifyResult.reason
      : '本次更新没有来源签名，而本机要求必须验签（MINGDAO_REQUIRE_UPDATE_SIGNATURE=1）';
  } else if (decision === 'warn-and-install') {
    reason = 'feed 未提供来源签名（或签名不可得）';
  }
  const where = source ? `，签名来源=${source}` : '';
  const logLine =
    decision === 'install'
      ? `更新来源校验：签名有效（${UPDATE_SIG_ALG}，keyId=${keyId ?? '?'}${where}）→ 允许安装`
      : decision === 'warn-and-install'
        ? `更新来源校验：**本次更新未验证来源签名**（${reason}${where}）→ 按默认档放行（可设 MINGDAO_REQUIRE_UPDATE_SIGNATURE=1 改为拒绝）`
        : `更新来源校验：拒绝安装（${reason}${where}）`;
  return {
    decision,
    hasSignature,
    verifyResult,
    keyId,
    reason,
    allowInstall: decision !== 'reject',
    logLine,
    notice: buildUpdateNotice({ decision, version, keyId, reason }),
  };
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function errMessage(err) {
  return String((/** @type {any} */ (err)?.message ?? err));
}
