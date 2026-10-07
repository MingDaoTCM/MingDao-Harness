// 执行账本（v0.6.0 阶段 C1）：一次回合 = 一个文件，事件流可导出、可校验、可回放的基础。
//
// 为什么新建账本而不改造 audit.jsonl：
//   ① audit.jsonl 有 20000 行截断（低频读盘裁剪），回放会缺段——**被静默截断的合规账本比不记账更糟**，
//      看起来有、实际缺；② audit 只记工具调用，没有模型轮次/约束触发/权限决策/费用，粒度不足以
//      回答「这个结论是怎么来的」。因此账本独立成目录，audit.jsonl 的既有语义保持不变（`mingdao audit` 不变）。
//
// 三条不可让步的纪律：
//   ① **写入即脱敏**：明细先过 redactSecrets 再落盘（不留「先存明文、靠导出兜底」的口子）；
//      导出时再过一遍 redactSensitive（叠加私网 IP + 家目录），因为导出物是对外的。
//   ② **摘要替代原文**：`*Digest` = sha256(原文) 前 16 位，用于「证明两次执行的这一步完全相同」
//      与校验账本未被篡改，而不泄露原文。
//   ③ **约束事件不回显命中短语**：否则账本自身变成泄露渠道（沿用 v0.4.7 blockedOutputText 的做法）。
//   ④ **降级必须可见**（v0.6.2，第三方报告 B-WS-1/2 + A-LG-1）：账本写失败不再静默 no-op，
//      而是记下原因并由调用方提示用户；run.end 额外写一份**封条**侧车文件，
//      使「删掉尾部若干行（含 run.end）」这种**链内自洽的截断**第一次变得可检出。
//   ⑤ **来源必须可证**（v0.6.11，登记 §3.45）：哈希链 + 封条只能证明「文件内部自洽」，
//      它们的全部输入都来自账本自身、算法是公开的——所以只能回答「自写入后有没有被随手改过」，
//      回答不了「**是谁写的**」。新增 ed25519 来源签名后，verify 才能回答后者（详见下方签名区）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWriteFileSync, atomicWritePrivateSync, appendFilePrivateSync } from './atomic-write.js';
import { mingdaoHome, ensureHome } from './config.js';
import { redactSecrets, redactSensitive } from './redact.js';

/**
 * v1：字段只增不改（变更需在 docs/internal/CHANGELOG-PACK.md 同款变更日志里记录）。
 *
 * v0.6.11 的来源签名**刻意不动这个版本号**：`v` 描述的是「事件信封」的语义
 *（`{v, runId, seq, at, type, prev, …}`），而本项只往封条与 run.end 里**加了可选字段**
 *（`sig` / `sigKey`），旧读者按原样忽略它们、新读者遇到缺失就退化成「无签名」——两侧都不需要分支。
 * 反过来，一旦把 v 改成 2，所有按 `v === 1` 过滤历史账本的第三方脚本（导出物里就带着这个字段）
 * 会**集体漏掉新账本**，而它们本来完全读得懂。真要改版本号的标准是「旧读者会读错」，
 * 不是「新读者多了字段」。
 */
export const LEDGER_VERSION = 1;
/** 默认保留最近多少次运行（超出按 mtime 删最旧） */
const DEFAULT_MAX_RUNS = 200;
const GENESIS = '0'.repeat(16);
const MAX_TEXT = 2000; // 单字段上限（与 audit 的 args 截断一致）

export function ledgerDir() {
  return path.join(mingdaoHome(), 'ledger');
}

/** 运行 id：时间前缀（可排序）+ 随机后缀（同毫秒不撞） */
export function newRunId() {
  return Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}

/** 内容摘要：用于比对「是否同一步」，而不是用来还原内容 */
export function digestOf(/** @type {any} */ value) {
  const s = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return crypto.createHash('sha256').update(String(s ?? '')).digest('hex').slice(0, 16);
}

/**
 * 递归脱敏（有界深度 + 有界长度），返回**新对象**，绝不改动调用方数据。
 * 数组按元素递归；非字符串标量原样保留（数字/布尔不需要脱敏）。
 *
 * `fn` 必须可传：写入时用 redactSecrets（只掩码密钥），**导出时用 redactSensitive**
 * （叠加私网 IP + 家目录）。此前这里把 fn 写死成 redactSecrets，导致导出时
 * 「顶层字符串字段过了 redactSensitive、而嵌在 args 里的私网 IP 原样输出」——
 * 同一份导出物上两级脱敏规则不一致，是最容易被忽略的泄露路径。
 * @param {any} value
 * @param {number} [depth]
 * @param {(s: string) => string} [fn]
 * @returns {any}
 */
export function redactDeep(value, depth = 0, fn = redactSecrets) {
  if (depth > 4) return '[过深已截断]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return fn(value).slice(0, MAX_TEXT);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redactDeep(v, depth + 1, fn));
  /** @type {any} */
  const out = {};
  // v0.6.7（报告二 P3-7）：对象此前**全量遍历、键数无上限**——工具结果里带一个 10 万键的对象，
  // 每次写账本都要整份递归（数组早有 slice(0,100)、字符串有 MAX_TEXT、深度有 4 层上限，只有对象漏了）。
  // 与数组同例：保留前 100 个键，并**显式标记**被截断（静默丢键会让账本看起来"就是这些字段"）。
  const entries = Object.entries(value);
  for (const [k, v] of entries.slice(0, 100)) out[k] = redactDeep(v, depth + 1, fn);
  if (entries.length > 100) out['…'] = `[更多键已截断：共 ${entries.length} 个键]`;
  return out;
}

function runFile(/** @type {any} */ runId) {
  return path.join(ledgerDir(), String(runId) + '.jsonl');
}

/** 封条侧车文件：与账本同目录、同名不同后缀（轮转时随之删除） */
export function sealFile(/** @type {any} */ runId) {
  return path.join(ledgerDir(), String(runId) + '.seal.json');
}

/**
 * 读封条。返回 null = 没有封条（或读不出/格式不对）——**不要**把「读失败」当成「没被截断」，
 * 调用方据此只能得出「无法判断」，这正是 verifyRun 的 warning 所要表达的。
 * @param {any} runId
 */
export function readSeal(/** @type {any} */ runId) {
  if (!isValidRunId(runId)) return null;
  try {
    const s = JSON.parse(fs.readFileSync(sealFile(runId), 'utf8'));
    return s && typeof s === 'object' && typeof s.head === 'string' ? s : null;
  } catch {
    return null;
  }
}

/** 合法的 run id（防路径穿越：id 直接拼进文件路径） */
export function isValidRunId(/** @type {any} */ id) {
  return typeof id === 'string' && /^[a-z0-9]+-[a-f0-9]{6}$/.test(id);
}

// ---------------------------------------------------------------------------
// 来源签名（v0.6.11，登记 §3.45）：把「账本没被改过」升级为「账本是不是持有本机那把密钥的一方写的」
//
// 为什么必须做（探针实测，/tmp/probe-ledger-sign.mjs，未入库）：
//   把一条 `tool.result` 的 ok:false 改成 ok:true、逐行重算 prev、再按新末行改写封条的
//   total/head —— **全程不用任何密钥**（sha256 是公开算法），旧 verifyRun 三项
//   （链内一致 / 条数 / 链头）逐项吻合，照样报「✅ 校验通过」。也就是：旧 verify 只能回答
//   「这份账本自写入后没被随手改过」，回答不了「是谁写的」——而合规场景要的恰恰是后者。
//
// 为什么选 ed25519 而不是同样零依赖的 HMAC-SHA256：
//   HMAC 的验证密钥**就是**签名密钥：任何能验的人都能伪造，第三方审计必须拿到「能写账本的那把
//   秘密」才能复核，等于把伪造能力交出去——与「来源可信」的目的正好相反。ed25519 是非对称的：
//   本机只留私钥，公钥（keyId + SPKI）可以交给审计方，对方能验证「这条链由那把密钥签发且未被改动」，
//   但**不能**凭空补签一份新账本。Node ≥18.17 原生支持、零新增依赖，所以没有理由退而求其次。
//
// 诚实边界（不写清楚就等于暗示）：
//   · 私钥与账本同机同权限，能改账本的对手通常也能读私钥——本层对**同权限的本机对手**不设防，
//     它防的是「换一台机器/换一把密钥伪造一份来源」以及「事后整体重写并声称是原机写的」；
//   · 把整条链连同封条一起重写、**并删掉所有签名痕迹**之后，只能退化成「无签名」这一态
//     （与历史账本无法区分）——所以 verify 对「账本自述被签过、而签名不在」这一形状单独判失败；
//   · 私钥一旦丢失，历史账本只能报「由另一把密钥签发」——这不是篡改，但也**不能**算通过。
// ---------------------------------------------------------------------------

/** 签名算法：ed25519（理由见上）。写进封条，给未来的算法轮换留出判据 */
export const LEDGER_SIG_ALG = 'ed25519';
/** 规范载荷的域分隔前缀：把「账本封条签名」与任何别的签名场景隔开（防跨协议重放） */
const SIG_DOMAIN = 'mingdao-ledger-seal-v1';

/**
 * 签名密钥文件：<home>/ledger-key.json（600、原子写）。
 * 为什么不并进 credentials.json：那是**模型 API Key** 的库，删除/导入/云同步的口子都在那边
 * （`key remove`/`key import` 会全量重写它）。签名密钥一旦被顺手清掉，历史账本会集体变成
 * 「另一把密钥签发」——把两种生命周期完全不同的秘密放同一个文件，迟早被一次 `key remove` 连坐。
 */
export function ledgerKeyPath() {
  return path.join(mingdaoHome(), 'ledger-key.json');
}

/**
 * 公钥指纹：SPKI DER 的 sha256 前 16 位。
 * 它是**公开**信息（可以进 verify 输出、进封条、进工单），用来回答「这条账本是不是这把密钥签的」，
 * 而不必交出私钥——这正是选非对称算法的收益。
 * @param {import('node:crypto').KeyObject} publicKey
 */
export function keyIdOf(publicKey) {
  return crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
}

/**
 * 待签名/待验证的**规范载荷**。
 *
 * 为什么签「字段拼出来的规范串」而不是封条文件的字节：封条是 JSON，缩进、键序、末尾换行
 * 任何一处变化都会让「字节签名」失效，可那是**格式化**不是篡改——把格式化误判成篡改，
 * 用户下次只能学会忽略这个告警。签名必须钉在语义字段上，而 runId/版本/条数/链头/时刻
 * 恰好完整描述「这是哪一次运行、有多少条事件、最后一条是什么」。
 *
 * 导出给第三方验签者：没有它，ed25519 的非对称价值（别人只拿公钥也能复核）就落不了地。
 * @param {any} rec 封条记录（sig 字段本身不参与签名）
 */
export function sealSignaturePayload(rec) {
  return [SIG_DOMAIN, String(rec?.runId ?? ''), String(rec?.v ?? ''), String(rec?.total ?? ''), String(rec?.head ?? ''), String(rec?.at ?? '')].join('\n');
}

/** @param {any} rec @param {import('node:crypto').KeyObject} privateKey */
export function signSealRecord(rec, privateKey) {
  return crypto.sign(null, Buffer.from(sealSignaturePayload(rec), 'utf8'), privateKey).toString('base64');
}

/**
 * 验签。返回 false 覆盖两种情形：签名解不出（base64/长度不合法）与验签不通过——
 * 调用方只会把它们归到同一结论（「这份账本不是持有该密钥的一方写的」），
 * 分开报只会给用户多一个无从处置的细节。
 * @param {any} rec @param {import('node:crypto').KeyObject} publicKey
 */
export function verifySealRecord(rec, publicKey) {
  const sig = rec?.sig;
  if (!sig || typeof sig.value !== 'string') return false;
  try {
    return crypto.verify(null, Buffer.from(sealSignaturePayload(rec), 'utf8'), publicKey, Buffer.from(sig.value, 'base64'));
  } catch {
    return false;
  }
}

/**
 * 签名密钥（私钥 + 由它导出的公钥）。`privateKey` 为 null = 只有公钥的**验证用**文件。
 * @typedef {{keyId: string, publicKey: import('node:crypto').KeyObject, privateKey: import('node:crypto').KeyObject|null, createdAt: number|null}} LedgerSigningKey
 */

/**
 * 严格读签名密钥：**必须区分「文件不存在」与「内容损坏」**（credentials.js 的 H-8 是同一个教训）。
 * 损坏时绝不自动重建：重建会让全部已签账本从「本机密钥签发」一夜之间变成「另一把密钥签发」，
 * 而那正是 verify 要报「签名无效」的形状——一次自作聪明的自愈，把历史账本全判成坏账。
 * @returns {{ok: boolean, missing: boolean, key: LedgerSigningKey|null, error: string|null}}
 */
export function readLedgerKeyStrict() {
  const p = ledgerKeyPath();
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    if (/** @type {any} */ (err)?.code === 'ENOENT') return { ok: true, missing: true, key: null, error: null };
    return { ok: false, missing: false, key: null, error: `无法读取 ${p}：${String(/** @type {any} */ (err)?.message ?? err)}` };
  }
  /** @type {any} */
  let data;
  try {
    // 容错 BOM：Windows 上 PowerShell 另存为会写出 BOM，那是**可解析**的内容（同 credentials.js）
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('顶层不是 JSON 对象');
  } catch (err) {
    return { ok: false, missing: false, key: null, error: `${p} 解析失败：${String(/** @type {any} */ (err)?.message ?? err)}（已拒绝使用；修好之前不要把签名密钥当不存在——重建会让历史账本全部变成「另一把密钥签发」）` };
  }
  if (String(data.alg ?? '') !== LEDGER_SIG_ALG) {
    return { ok: false, missing: false, key: null, error: `${p} 的 alg 是 ${String(data.alg ?? '(缺失)')}，本版只认 ${LEDGER_SIG_ALG}` };
  }
  try {
    const pub = typeof data.publicKey === 'string' && data.publicKey ? crypto.createPublicKey({ key: Buffer.from(data.publicKey, 'base64'), format: 'der', type: 'spki' }) : null;
    const priv = typeof data.privateKey === 'string' && data.privateKey ? crypto.createPrivateKey({ key: Buffer.from(data.privateKey, 'base64'), format: 'der', type: 'pkcs8' }) : null;
    const publicKey = pub ?? (priv ? crypto.createPublicKey(priv) : null);
    if (!publicKey) throw new Error('既没有 publicKey 也没有 privateKey');
    const keyId = keyIdOf(publicKey);
    // 文件里记的 keyId 与公钥对不上 = 手改过、或两个文件的字段被混在一起。
    // 此时**不能**以文件里的 keyId 为准：那等于让 A 密钥冒充 B 的身份（verify 会认这个身份）。
    if (data.keyId && String(data.keyId) !== keyId) {
      throw new Error(`记录的公钥指纹 ${data.keyId} 与实际公钥 ${keyId} 不一致（文件被改过，或两个文件的字段被混在一起）`);
    }
    return { ok: true, missing: false, key: { keyId, publicKey, privateKey: priv, createdAt: Number(data.createdAt) || null }, error: null };
  } catch (err) {
    return { ok: false, missing: false, key: null, error: `${p} 里的密钥不可用：${String(/** @type {any} */ (err)?.message ?? err)}` };
  }
}

/**
 * 生成并落盘一把本机签名密钥（600、原子写、绝不打印私钥）。
 * `force=false` 时**拒绝覆盖已存在的密钥**：换密钥会让此前所有已签账本被判「另一把密钥签发」，
 * 这必须是一次显式决定，而不是顺手加个 --generate 的副作用。
 * @param {{force?: boolean}} [opts]
 * @returns {{ok: boolean, keyId: string|null, path: string, error: string|null}}
 */
export function generateLedgerKey({ force = false } = {}) {
  const p = ledgerKeyPath();
  const cur = readLedgerKeyStrict();
  if (!force) {
    if (cur.ok && cur.key) {
      return { ok: false, keyId: cur.key.keyId, path: p, error: `已存在签名密钥（keyId=${cur.key.keyId}）：覆盖它会让此前所有已签账本变成「另一把密钥签发」。确认要换请加 --force，并先备份旧文件（否则旧账本再也无法验签通过）。` };
    }
    if (!cur.ok) return { ok: false, keyId: null, path: p, error: `现有密钥文件读不出来，已拒绝覆盖：${cur.error}` };
  }
  try {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const rec = {
      v: 1,
      alg: LEDGER_SIG_ALG,
      // keyId 一并落盘只为「一眼看出这是哪把密钥」；读的时候**以实际公钥重算为准**（见 readLedgerKeyStrict）
      keyId: keyIdOf(publicKey),
      publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
      createdAt: Date.now(),
    };
    ensureHome();
    atomicWritePrivateSync(p, JSON.stringify(rec, null, 2) + '\n');
    return { ok: true, keyId: rec.keyId, path: p, error: null };
  } catch (err) {
    return { ok: false, keyId: null, path: p, error: `写入 ${p} 失败：${String(/** @type {any} */ (err)?.message ?? err)}` };
  }
}

/**
 * 取本机签名密钥，**不存在则自动生成**。
 *
 * 为什么默认生成，而不是「没密钥就不签」：可选签名在合规上等于没有签名——没人会先跑一条
 * 生成命令再开始干活，于是「来源可信」永远停在计划里（本项在发布说明里挂了三轮就是这个下场）。
 * 代价是第一次记账会多出一个 <home>/ledger-key.json（600），可随时用 `mingdao ledger --sign-key` 查到。
 * @returns {{ok: boolean, key: LedgerSigningKey|null, created: boolean, error: string|null}}
 */
export function ensureLedgerKey() {
  const r = readLedgerKeyStrict();
  if (r.ok && r.key) return { ok: true, key: r.key, created: false, error: null };
  if (r.ok && r.missing) {
    const g = generateLedgerKey();
    if (!g.ok) return { ok: false, key: null, created: false, error: g.error };
    const again = readLedgerKeyStrict();
    return { ok: Boolean(again.ok && again.key), key: again.key, created: true, error: again.error };
  }
  return { ok: false, key: null, created: false, error: r.error };
}

/**
 * 取用于**校验**的公钥：`--key <文件>` 指定的文件，否则本机 <home>/ledger-key.json。
 * 接受两种形态：① 本模块的密钥文件（只要有 publicKey 字段即可，私钥可缺）；
 * ② PEM/SPKI 公钥文件——第三方审计手上只有公钥是常态，不该逼对方伪造一份带私钥的文件。
 * @param {string|null} [keyPath]
 * @returns {{ok: boolean, keyId: string|null, publicKey: import('node:crypto').KeyObject|null, source: string, error: string|null}}
 */
export function loadVerifyKey(keyPath = null) {
  const src = keyPath || ledgerKeyPath();
  if (!keyPath) {
    const r = readLedgerKeyStrict();
    if (r.ok && r.key) return { ok: true, keyId: r.key.keyId, publicKey: r.key.publicKey, source: src, error: null };
    if (r.ok && r.missing) {
      return { ok: false, keyId: null, publicKey: null, source: src, error: `本机没有签名密钥（${src}）——无法判断这条账本的来源；要用别的公钥校验请加 --key <文件>` };
    }
    return { ok: false, keyId: null, publicKey: null, source: src, error: r.error };
  }
  let raw;
  try {
    raw = fs.readFileSync(keyPath, 'utf8');
  } catch (err) {
    return { ok: false, keyId: null, publicKey: null, source: src, error: `无法读取校验密钥 ${keyPath}：${String(/** @type {any} */ (err)?.message ?? err)}` };
  }
  try {
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    /** @type {import('node:crypto').KeyObject} */
    let pub;
    if (/-----BEGIN/.test(text)) {
      pub = crypto.createPublicKey(text); // PEM：第三方交出的公钥（私钥 PEM 也能导出对应公钥）
    } else {
      const data = JSON.parse(text);
      if (typeof data?.publicKey === 'string' && data.publicKey) pub = crypto.createPublicKey({ key: Buffer.from(data.publicKey, 'base64'), format: 'der', type: 'spki' });
      else if (typeof data?.privateKey === 'string' && data.privateKey) pub = crypto.createPublicKey(crypto.createPrivateKey({ key: Buffer.from(data.privateKey, 'base64'), format: 'der', type: 'pkcs8' }));
      else throw new Error('既没有 publicKey 也没有 privateKey');
    }
    return { ok: true, keyId: keyIdOf(pub), publicKey: pub, source: src, error: null };
  } catch (err) {
    return { ok: false, keyId: null, publicKey: null, source: src, error: `${keyPath} 不是可用的校验密钥：${String(/** @type {any} */ (err)?.message ?? err)}` };
  }
}

/**
 * @typedef {{signed: boolean, provenance: 'valid'|'none'|'invalid'|'unverifiable', signerKeyId: string|null, verifyKeyId: string|null, provenanceError: string|null}} Provenance
 */

/**
 * 来源签名判定：三态 + 「无法校验」这一态（本机没有对应公钥时）。
 *
 * 判据顺序不可换：**先看有没有签名，再看签名对不对**。反过来会把「本来就没签名」的历史账本
 * 一律报成「签名无效」——升级当天全部历史账本变成坏账本，正是向后兼容要求的红线。
 * @param {any} seal @param {Set<string>} declaredKeyIds @param {string|null} keyPath
 * @returns {Provenance}
 */
function provenanceOf(seal, declaredKeyIds, keyPath) {
  const declared = declaredKeyIds.size ? [...declaredKeyIds][0] : null;
  const sig = seal && typeof seal === 'object' ? seal.sig : null;
  if (!sig || typeof sig.value !== 'string') {
    // 账本自己声明「我被 X 签过」，而封条里没有签名 → 这不是"老账本"，是签名证据被剥离
    if (declared) {
      return {
        signed: false,
        provenance: 'invalid',
        signerKeyId: declared,
        verifyKeyId: null,
        provenanceError: `账本自身声明由密钥 ${declared} 签发，但封条里没有签名记录——签名证据被剥离或封条被替换（这与「历史账本本来就没有签名」不是一回事）`,
      };
    }
    return { signed: false, provenance: 'none', signerKeyId: null, verifyKeyId: null, provenanceError: null };
  }
  const signerKeyId = typeof sig.keyId === 'string' && sig.keyId ? sig.keyId : null;
  if (String(sig.alg ?? '') !== LEDGER_SIG_ALG) {
    return { signed: true, provenance: 'unverifiable', signerKeyId, verifyKeyId: null, provenanceError: `签名算法 ${String(sig.alg ?? '(缺失)')} 本版不支持（只认 ${LEDGER_SIG_ALG}）` };
  }
  const k = loadVerifyKey(keyPath);
  if (!k.ok || !k.publicKey) {
    return { signed: true, provenance: 'unverifiable', signerKeyId, verifyKeyId: null, provenanceError: k.error };
  }
  if (signerKeyId && k.keyId !== signerKeyId) {
    return {
      signed: true,
      provenance: 'invalid',
      signerKeyId,
      verifyKeyId: k.keyId,
      provenanceError: `该账本由 keyId=${signerKeyId} 签发，而用于校验的密钥是 keyId=${k.keyId}——换了一把密钥（或这份账本来自另一台机器）；要用原密钥校验请加 --key <文件>`,
    };
  }
  if (!verifySealRecord(seal, k.publicKey)) {
    return {
      signed: true,
      provenance: 'invalid',
      signerKeyId,
      verifyKeyId: k.keyId,
      provenanceError: '签名与内容不匹配：内容（或封条的条数/链头/时刻）被改写后重算过哈希链——链是自洽的，但**不是**持有该密钥的那一方写的',
    };
  }
  return { signed: true, provenance: 'valid', signerKeyId, verifyKeyId: k.keyId, provenanceError: null };
}

/** 无签名结论的默认字段（错误路径上复用，保证返回形状恒定：原有字段一个不改，新字段永远在） */
const NO_PROVENANCE = { signed: false, provenance: 'none', signerKeyId: null, verifyKeyId: null, provenanceError: null, trusted: false };

/**
 * 来源结论的**单源文案**：CLI 与导出物共用一份。
 * 为什么不让两边各写一句：本仓已经吃过"同一结论两处措辞"的亏（`ledger verify` 说 ✅ 而导出物说
 * 「无法确认」），用户看到哪一份取决于他用了哪条路径——合规物上这是致命的。
 * @param {{provenance?: string, signerKeyId?: string|null, verifyKeyId?: string|null, provenanceError?: string|null}} v
 */
export function provenanceText(v) {
  // 三态用**需求原话**写死（「链完整 + 签名有效 / 链完整但无签名 / 链完整但签名无效」）：
  // 合规复核是拿人眼与脚本一起 grep 这几句话的，措辞漂移一次就得重新对账。
  switch (v?.provenance) {
    case 'valid':
      return `✅ 有效——链完整 + 签名有效（ed25519 · keyId=${v.signerKeyId ?? '?'}）：由持有该密钥的一方写入，内容与封条自签名后未被改动`;
    case 'none':
      return '⚠️ 无签名——链完整但无签名（仅哈希链完整）：该账本写于启用来源签名之前，或签名证据已被整体抹除（本项无法区分两者），不能据此认定来源';
    case 'invalid':
      return `❌ 无效——链完整但签名无效：${v.provenanceError ?? '签名与内容不符'}`;
    case 'unverifiable':
      return `⚠️ 无法校验——链完整但无法验签：${v.provenanceError ?? '没有可用的公钥'}`;
    default:
      return '⚠️ 未知（校验结果里没有来源结论）';
  }
}

/**
 * 创建一次运行的账本写入器。所有方法在账本不可用时**静默降级**（no-op），
 * 绝不让「记账失败」影响正常执行——与 writeAudit 同款容错。
 * @param {string} runId
 * @param {{enabled?: boolean, maxRuns?: number, now?: () => number}} [opts]
 */
export function createLedger(runId, { enabled = true, maxRuns = DEFAULT_MAX_RUNS, now = () => Date.now() } = {}) {
  let seq = 0;
  let prev = GENESIS;
  let alive = Boolean(enabled) && isValidRunId(runId);
  // v0.6.2（B-WS-1/2）：降级不再是无声的。此前 catch 只把 alive 置 false——
  // 用户拿到一段「正常」的总结，却不知道这次运行**没有任何账本**，
  // 而本文件开头就写着「被静默截断的合规账本比不记账更糟」。失败要留痕、要能说出口。
  let failure = /** @type {string|null} */ (null);
  let failures = 0;
  // 签名密钥按**写入器实例**缓存（不是模块级）：模块级缓存会在测试/多 home 场景下串味——
  // 换了 MINGDAO_HOME 却仍复用上一个 home 的密钥，签出来的账本"来源"是错的。
  /** @type {LedgerSigningKey|null|undefined} */
  let keyCache;
  /** 取/建签名密钥失败的原因（**与 failure 分开**：账本本身写得好好的，只是这一份没有来源签名） */
  let signError = /** @type {string|null} */ (null);

  /**
   * 本回合的签名密钥（惰性 + 记忆化）。
   * 为什么要惰性：一次回合要写几十条事件，取密钥只需一次；而**签名失败绝不能中断记账**
   *（「记账失败不影响执行」是本文件的既有纪律）——取不到就写无签名账本，并在 run.end 里
   * 如实**不声明** sigKey，让 verify 得到诚实的「无签名」而不是一个假的「已签」。
   */
  function signingKey() {
    if (keyCache !== undefined) return keyCache;
    // 账本整体停用（`cfg.ledger:false` / runId 非法 / 之前写失败）时**不生成密钥**：
    // 否则"关掉账本"的用户也会被凭空写一个密钥文件——一个纯粹为记账服务的副作用。
    if (!alive) return null;
    try {
      const r = ensureLedgerKey();
      keyCache = r.ok ? r.key : null;
      if (!r.ok) signError = r.error;
    } catch (err) {
      keyCache = null; // 只可能来自 ensureHome/写盘等意外抛出：降级为无签名，不影响记账
      signError = String(/** @type {any} */ (err)?.message ?? err);
    }
    return keyCache;
  }

  /** 事件落盘：一行一个 JSON，返回该行内容（供测试/调试） */
  function write(/** @type {string} */ type, /** @type {any} */ payload) {
    if (!alive) return null;
    try {
      ensureHome();
      fs.mkdirSync(ledgerDir(), { recursive: true, mode: 0o700 });
      const event = { v: LEDGER_VERSION, runId, seq: seq + 1, at: now(), type, prev, ...redactDeep(payload) };
      const line = JSON.stringify(event);
      appendFilePrivateSync(runFile(runId), line + '\n');
      try {
        fs.chmodSync(runFile(runId), 0o600);
      } catch {}
      // 哈希链：下一行的 prev = 本行内容的 hash（校验时逐行重算即可发现篡改/删行）
      prev = digestOf(line);
      seq += 1;
      return line;
    } catch (err) {
      alive = false; // 写失败即整体停用，避免每步都抛一次
      failures += 1;
      failure = String(/** @type {any} */ (err)?.message ?? err);
      return null;
    }
  }

  /**
   * 写封条：把「这一份账本应该有多少条事件、链头是什么」记在账本**之外**。
   * 为什么必须另存：删掉尾部若干行（含 run.end）后，链内每一行的 prev 依然自洽，
   * 单看文件查不出被截断——实测「只留前 3 行」原实现照样报 ok:true（A-LG-1 的真实盲区）。
   * 诚实边界：封条与账本同目录、同权限，能防**误删/漏写/随手改**，防不住同时改写两者的对手。
   *
   * v0.6.11：封条同时承担**来源签名**（签名覆盖 runId/版本/条数/链头/时刻，即整条链的承诺）。
   * 为什么签在封条上而不是每一行上：① 封条本来就是「这份账本的全部内容是什么」的承诺，
   * 签它等价于签整条链；② 逐行签名会让每条事件多 88 字节 base64 与一次 sign()，
   * 而收益只是「能定位到被改的那一行」——链内一致性检查已经能定位到行。
   */
  function seal(/** @type {string} */ lastLine) {
    try {
      /** @type {any} */
      const rec = { v: LEDGER_VERSION, runId, total: seq, head: digestOf(lastLine), at: now() };
      const key = signingKey();
      if (key?.privateKey) rec.sig = { alg: LEDGER_SIG_ALG, keyId: key.keyId, value: signSealRecord(rec, key.privateKey) };
      atomicWriteFileSync(sealFile(runId), JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 });
      return rec;
    } catch (err) {
      failures += 1;
      failure = String(/** @type {any} */ (err)?.message ?? err);
      return null;
    }
  }

  return {
    runId,
    get enabled() {
      return alive;
    },
    get seq() {
      return seq;
    },
    /** 本回合是否发生过记账降级（写账本或写封条失败） */
    get degraded() {
      return failures > 0;
    },
    /** 降级发生了几次 */
    get failures() {
      return failures;
    },
    /** 最近一次失败原因（无则 null）——给用户看到具体是什么坏了，而不是「记账失败」四个字 */
    get lastError() {
      return failure;
    },
    /** 这一份账本用于签名的密钥指纹（无签名则 null）——给命令面/测试看「是谁写的」 */
    get signingKeyId() {
      return signingKey()?.keyId ?? null;
    },
    /** 取/建签名密钥失败的原因（无则 null）。与 degraded 分开：账本写得好好的，只是没有来源签名 */
    get signingError() {
      signingKey();
      return signError;
    },
    /** 回合开始：模型/权限/预设/Pack 等「当时的规则环境」——复检时要靠它对齐上下文 */
    runStart(/** @type {any} */ f = {}) {
      rotateLedger(maxRuns);
      return write('run.start', {
        model: f.model ?? null,
        provider: f.provider ?? null,
        session: f.session ?? null,
        cwd: f.cwd ?? null,
        permission: f.permission ?? null,
        preset: f.preset ?? null,
        packs: Array.isArray(f.packs) ? f.packs : [],
      });
    },
    modelRound(/** @type {any} */ f = {}) {
      return write('model.round', {
        round: f.round ?? null,
        step: f.step ?? null,
        ms: f.ms ?? null,
        firstTokenMs: f.firstTokenMs ?? null,
        requestStartAt: f.requestStartAt ?? null,
        finish: f.finish ?? null,
        usage: f.usage ?? null,
      });
    },
    toolCall(/** @type {any} */ f = {}) {
      // 明细（脱敏后）与摘要（原文指纹）并存：前者给人看，后者用来比对与防篡改
      return write('tool.call', {
        callId: f.callId ?? null,
        name: f.name ?? null,
        pack: f.pack ?? null,
        argsDigest: digestOf(f.rawArgs ?? f.args ?? null),
        args: f.args ?? null,
        permission: f.permission ?? null,
        constraint: f.constraint ?? null,
        readOnly: f.readOnly ?? null,
      });
    },
    toolResult(/** @type {any} */ f = {}) {
      const raw = f.result === undefined ? null : f.result;
      return write('tool.result', {
        callId: f.callId ?? null,
        name: f.name ?? null,
        ok: f.ok ?? null,
        exitCode: f.exitCode ?? null,
        ms: f.ms ?? null,
        resultDigest: digestOf(raw),
        resultSize: raw === null ? 0 : String(typeof raw === 'string' ? raw : JSON.stringify(raw)).length,
        blocked: f.blocked ?? false,
        error: f.error ?? null,
      });
    },
    /** 约束触发：只记「哪条约束、什么时机、如何处理」，**不记命中的原文** */
    constraint(/** @type {any} */ f = {}) {
      return write('constraint', {
        kind: f.kind ?? null,
        id: f.id ?? null,
        stage: f.stage ?? null,
        tool: f.tool ?? null,
        action: f.action ?? null,
      });
    },
    permission(/** @type {any} */ f = {}) {
      return write('permission', {
        name: f.name ?? null,
        mode: f.mode ?? null,
        decision: f.decision ?? null,
        source: f.source ?? null,
        rule: f.rule ?? null,
      });
    },
    /** 费用：priced=false 必须显式存在——无价模型绝不写 ¥0.0000 冒充免费 */
    cost(/** @type {any} */ f = {}) {
      return write('cost', {
        model: f.model ?? null,
        usage: f.usage ?? null,
        pricing: f.pricing ?? null,
        yuan: f.yuan ?? null,
        priced: f.priced === true,
        // v0.6.7（报告一 H-4）：**用量未知**必须是一个显式事实，而不是"priced:false"里的一条注释——
        // 后端不回 usage 时 priced 与"无价模型"都是 false，事后稽核却要能区分这两件事。
        ...(f.usageUnknown === true ? { usageUnknown: true } : {}),
      });
    },
    netEgress(/** @type {any} */ f = {}) {
      return write('net.egress', {
        host: f.host ?? null,
        port: f.port ?? null,
        allowed: f.allowed ?? null,
        reason: f.reason ?? null,
      });
    },
    runEnd(/** @type {any} */ f = {}) {
      // v0.6.11（§3.45）：把「本回合由哪把密钥签发」写进**链内**（run.end 也是链的一部分）。
      // 为什么非写不可：签名本身在封条里，而封条是个可以被单独删掉的侧车文件——只删封条
      // 就能把一份已签账本伪装成「历史无签名账本」，从而骗过「无签名也退 0」的兼容路径。
      // 有了链内的这条声明，verify 才能区分「本来就是无签名老账本」与「签名证据被剥离」。
      // 必须在 write 之前取密钥：写完之后再取，run.end 的内容就与签名无关了。
      const signer = signingKey();
      const line = write('run.end', {
        ms: f.ms ?? null,
        status: f.status ?? null,
        steps: f.steps ?? null,
        rounds: f.rounds ?? null,
        yuanTotal: f.yuanTotal ?? null,
        priced: f.priced === true,
        capHit: f.capHit === true,
        truncated: f.truncated === true,
        aborted: f.aborted === true,
        // v0.6.7（报告二 P3-2）：上游提前关流此前只"置位"不落账（检测到了、传递断了）
        ...(f.upstreamTruncated === true ? { upstreamTruncated: true } : {}),
        // 只写 keyId（公钥指纹，公开信息），不写签名本身：签名在封条里，覆盖整条链
        ...(signer ? { sigKey: signer.keyId } : {}),
      });
      // 只有 run.end **真的落盘了**才封条：局部失败时封一条残缺账本会让校验谎报完整
      if (line) seal(line);
      return line;
    },
  };
}

/**
 * 读取一次运行的事件流。`strict` 模式下解析失败的行会被标记出来而不是静默丢弃
 * ——账本里出现坏行本身就是需要被看见的事实。
 * @param {any} runId
 */
export function readRun(/** @type {any} */ runId) {
  if (!isValidRunId(runId)) return [];
  try {
    return fs
      .readFileSync(runFile(runId), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { type: 'corrupt', raw: l.slice(0, 200) };
        }
      });
  } catch {
    return [];
  }
}

/**
 * 校验账本。两层：
 *   ① **链内一致性**：能发现「改了一行」与「删了一行」（两者都会让 prev 对不上）。
 *   ② **封条比对**（v0.6.2）：能发现「删掉尾部若干行（含 run.end）」——这一形状链内**完全自洽**，
 *      只靠 ① 永远查不出（A-LG-1）。没有封条时不得谎报「完整」，只能报 `sealed:false` + warning。
 * 诚实边界：**不含可信时间戳**，只能证明「自写入后未被改动」，不能证明生成时刻；
 * 封条与账本同权限同目录，防误删/漏写，不防同时改写两者的对手。
 *
 * v0.6.11（§3.45）新增第 ③ 层——**来源签名**：①② 的全部输入都来自账本自身、算法公开，
 * 对手改完内容重算一遍就能逐项吻合（探针实测）。③ 用 ed25519 回答「是不是持有某把密钥的一方
 * 写的」，并且**只增字段不改既有字段**：`ok` 的含义仍然是「链 + 封条自洽」，
 * 来源结论另放在 `provenance` / `trusted` 上——把新结论塞进 ok，会让所有旧调用点
 * （导出、Web、CI 门禁）在没读新字段的情况下改变行为。
 * @param {any} runId
 * @param {{keyPath?: string|null}} [opts] `keyPath` = 用哪份公钥验签（默认本机 <home>/ledger-key.json）
 */
export function verifyRun(/** @type {any} */ runId, { keyPath = null } = {}) {
  const raw = (() => {
    try {
      return fs.readFileSync(runFile(runId), 'utf8');
    } catch {
      return null;
    }
  })();
  if (raw === null) return { ok: false, error: '账本不存在', badSeq: null, total: 0, sealed: false, warning: null, ...NO_PROVENANCE };
  const lines = raw.split('\n').filter(Boolean);
  let prev = GENESIS;
  let sawEnd = false;
  /** 链内自述的签发密钥（run.end 的 sigKey）——用于识破「只删封条冒充老账本」 */
  const declaredKeyIds = new Set();
  for (let i = 0; i < lines.length; i++) {
    let ev;
    try {
      ev = JSON.parse(lines[i]);
    } catch {
      return { ok: false, error: `第 ${i + 1} 行不是合法 JSON`, badSeq: i + 1, total: lines.length, sealed: false, warning: null, ...NO_PROVENANCE };
    }
    if (ev.prev !== prev) {
      return { ok: false, error: `第 ${i + 1} 行的前序哈希不匹配（该行或其上一行被改动/删除）`, badSeq: ev.seq ?? i + 1, total: lines.length, sealed: false, warning: null, ...NO_PROVENANCE };
    }
    if (ev.type === 'run.end') sawEnd = true;
    if (typeof ev.sigKey === 'string' && ev.sigKey) declaredKeyIds.add(ev.sigKey);
    prev = digestOf(lines[i]);
  }
  // ② 封条比对：链内自洽之后，回答「尾部有没有被切掉」
  const seal = readSeal(runId);
  if (seal) {
    const total = Number(seal.total) || 0;
    if (lines.length < total) {
      return { ok: false, error: `账本被截断：封条记录应有 ${total} 条事件，实际只有 ${lines.length} 条（尾部 ${total - lines.length} 条被删除）`, badSeq: lines.length + 1, total: lines.length, sealed: true, warning: null, ...NO_PROVENANCE };
    }
    if (lines.length > total) {
      return { ok: false, error: `封条之后被追加了 ${lines.length - total} 条事件（封条 total=${total}，实际 ${lines.length}）`, badSeq: total + 1, total: lines.length, sealed: true, warning: null, ...NO_PROVENANCE };
    }
    const head = lines.length ? digestOf(lines[lines.length - 1]) : GENESIS;
    if (head !== seal.head) {
      return { ok: false, error: '末条事件与封条记录的链头不一致（尾部被改写）', badSeq: lines.length, total: lines.length, sealed: true, warning: null, ...NO_PROVENANCE };
    }
    const prov = provenanceOf(seal, declaredKeyIds, keyPath);
    return { ok: true, error: null, badSeq: null, total: lines.length, sealed: true, warning: null, ...prov, trusted: prov.provenance === 'valid' || prov.provenance === 'none' };
  }
  // 无封条：链内是自洽的，但**尾部是否完整无从判断**——必须说出来，不能报「完整」
  const warning = sawEnd
    ? '该账本含 run.end 事件却没有封条文件——封条可能被删除，无法判断尾部是否被截断'
    : '该账本尚未封条（回合未正常收尾），无法判断尾部是否被截断';
  // 封条没了 → 签名也没了（签名就写在封条里）。此时**不许**因为"没有签名"就报平安：
  // 若链内自述被某把密钥签过（run.end 的 sigKey），那是签名证据被剥离，必须报出来。
  const prov = provenanceOf(null, declaredKeyIds, keyPath);
  return { ok: true, error: null, badSeq: null, total: lines.length, sealed: false, warning, ...prov, trusted: false };
}

/**
 * 只列文件与 mtime（**不读内容**），供轮转使用。
 * 为什么要分开：轮转在**每个回合开始**都会跑一次，而 `listRuns()` 会把每个账本文件的每一行都
 * JSON.parse 一遍——200 次运行 × 60 条事件 = 每次回合白解析 1.2 万行，且纯粹是为了回答
 * 「要不要删文件」。轮转只需要「文件名 + mtime」，内容一行都不用读。
 * @returns {{runId: string, mtime: number}[]} 按 mtime 倒序
 */
export function listRunFiles() {
  const dir = ledgerDir();
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    const runId = f.replace(/\.jsonl$/, '');
    let mtime = 0;
    try {
      mtime = fs.statSync(path.join(dir, f)).mtimeMs;
    } catch {}
    out.push({ runId, mtime });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** 列出账本（含解析后的事件统计，按修改时间倒序），供 `ledger list` 使用 */
export function listRuns() {
  const dir = ledgerDir();
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    const runId = f.replace(/\.jsonl$/, '');
    let mtime = 0;
    try {
      mtime = fs.statSync(path.join(dir, f)).mtimeMs;
    } catch {}
    const events = readRun(runId);
    const start = events.find((e) => e.type === 'run.start') || null;
    const end = events.find((e) => e.type === 'run.end') || null;
    out.push({
      runId,
      mtime,
      at: start?.at ?? null,
      model: start?.model ?? null,
      session: start?.session ?? null,
      events: events.length,
      status: end?.status ?? '未结束',
      yuanTotal: end?.yuanTotal ?? null,
      priced: end?.priced === true,
    });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** 配额轮转：只保留最近 maxRuns 次运行（按 mtime），返回被删除的 runId。
 *  走 listRunFiles（只 stat 不读内容）——这是每个回合都会调用的路径。 */
export function rotateLedger(/** @type {any} */ maxRuns = DEFAULT_MAX_RUNS) {
  const runs = listRunFiles();
  if (runs.length <= maxRuns) return [];
  const removed = [];
  for (const r of runs.slice(maxRuns)) {
    try {
      fs.rmSync(runFile(r.runId), { force: true });
      // 封条必须随之删除，否则每次轮转都会留下永不回收的孤儿封条文件
      fs.rmSync(sealFile(r.runId), { force: true });
      removed.push(r.runId);
    } catch {}
  }
  return removed;
}

/** @type {Record<string, string>} */
const MARK = { 'run.start': '▶', 'run.end': '■', 'model.round': '🧠', 'tool.call': '🔧', 'tool.result': '↳', constraint: '⛔', permission: '🔑', cost: '¥', 'net.egress': '🌐' };

/**
 * 导出一次运行。json = 事件数组；md = 人读报告。
 * 导出物是对外的，因此在 redactSecrets（写入时已做）之上再跑一遍 redactSensitive，
 * 叠加私网 IP 与家目录路径的掩码。
 * @param {any} runId
 * @param {{format?: 'json'|'md'}} [opts]
 */
export function exportRun(/** @type {any} */ runId, { format = 'json' } = {}) {
  const events = readRun(runId);
  if (!events.length) return { error: `没有找到账本 ${runId}` };
  const safe = events.map((e) => {
    /** @type {any} */
    const o = {};
    for (const [k, v] of Object.entries(e)) {
      // 统一走 redactSensitive：顶层字符串与嵌套结构必须适用同一套规则
      o[k] = typeof v === 'string' ? redactSensitive(v).slice(0, MAX_TEXT) : redactDeep(v, 0, redactSensitive);
    }
    return o;
  });
  const v = verifyRun(runId);
  if (format === 'json') {
    return { ok: true, text: JSON.stringify({ runId, integrity: v, events: safe }, null, 2) + '\n' };
  }
  const lines = [];
  const start = safe.find((e) => e.type === 'run.start');
  const end = safe.find((e) => e.type === 'run.end');
  lines.push(`# 执行账本 ${runId}`);
  lines.push('');
  lines.push(`- 模型：${start?.model ?? '—'} · 会话：${start?.session ?? '—'} · 权限：${start?.permission ?? '—'}`);
  lines.push(`- 开始：${start?.at ? new Date(start.at).toISOString() : '—'}`);
  lines.push(`- 结束：${end ? `${end.status}（${end.ms}ms，${end.steps} 步）` : '未结束'}`);
  lines.push(`- 费用：${end?.priced ? `¥${Number(end.yuanTotal ?? 0).toFixed(4)}` : '**无法估算**（模型无价，不是 0 元）'}`);
  lines.push(
    `- 完整性校验：${
      v.ok
        ? v.sealed
          ? '✅ 链内一致 + 封条吻合（尾部截断可检出）'
          : `⚠️ 链内一致，但${v.warning}`
        : `❌ ${v.error}`
    }`
  );
  // v0.6.11（§3.45）：导出物是对外交付的**合规物**，只写「链完整」会让收件人以为来源也可信。
  // 来源必须与完整性并列写出来——这正是本项存在的理由（旧导出物缺的从来不是链，而是这一行）。
  lines.push(`- 来源签名：${provenanceText(v)}`);
  lines.push('');
  lines.push('| # | 时刻 | 事件 | 摘要 |');
  lines.push('| --- | --- | --- | --- |');
  for (const e of safe) {
    const brief = (() => {
      switch (e.type) {
        case 'run.start':
          return `模型 ${e.model ?? '—'}`;
        case 'model.round':
          return `第 ${e.round} 轮 第 ${e.step} 步 · ${e.ms ?? '—'}ms · 完成原因 ${e.finish ?? '—'}`;
        case 'tool.call':
          return `${e.name}${e.pack ? ` (pack:${e.pack})` : ''} · 参数指纹 ${e.argsDigest} · 权限 ${e.permission?.decision ?? '—'}`;
        case 'tool.result':
          return `${e.name} · ${e.ok ? '成功' : '失败'}${e.blocked ? '（被约束拦截）' : ''} · ${e.ms ?? '—'}ms`;
        case 'constraint':
          return `${e.kind} [${e.stage}] ${e.id ?? ''} → ${e.action ?? '—'}`;
        case 'permission':
          return `${e.name} → ${e.decision}（${e.source ?? '—'}）`;
        case 'cost':
          return e.priced ? `¥${Number(e.yuan ?? 0).toFixed(4)}` : '无法估算（模型无价）';
        case 'net.egress':
          return `${e.host}:${e.port ?? ''} ${e.allowed ? '白名单内' : '越界'} ${e.reason ?? ''}`;
        case 'run.end':
          return `${e.status} · ${e.ms}ms`;
        default:
          return '';
      }
    })();
    lines.push(`| ${e.seq} | ${e.at ? new Date(e.at).toISOString().slice(11, 19) : '—'} | ${MARK[e.type] || ''} ${e.type} | ${brief} |`);
  }
  lines.push('');
  lines.push('> 脱敏说明：明细在**写入时**已按密钥规则掩码，导出时再叠加私网 IP 与家目录路径掩码。');
  lines.push('> 完整性说明：哈希链 + 封条只能证明「自写入后未被改动、尾部未被截断」，**不含可信时间戳**，不等同于审计级不可否认；封条与账本同权限，防误删与漏写，不防同时改写两者的对手。');
  return { ok: true, text: lines.join('\n') + '\n' };
}
