// 批二十（v0.6.11：账本**来源签名** `ledger --sign-key`）的变异验证。
//
// 先复现（探针 /tmp/probe-ledger-sign.mjs）：哈希链 + 封条的全部输入都来自账本自身、算法公开，
// 改内容 + 逐行重算 prev + 改写封条 total/head 之后，旧 verify 三项逐项吻合仍报 ok:true——
// 它能证明「没被随手改过」，证明不了「是谁写的」。本批把 §133 的每条断言反着验一遍：
// 逐个把修复改回缺陷，看它们是否**当场红**（红不了一定是关键词对不上，而不是"断言太强"）。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SEC = () => M.section('133');

// ① 封条不再带签名（写了 sigKey 却不签）→ 「新账本签名有效」当场红
// 注：这条会被两处断言先后抓到——先是「封条的 sig.alg」（最早发现"没签"），
// 再是「来源签名必须有效」。expect 同时列出两者，免得哪天有人把前一条挪走就误判成逃逸。
M.mutate({
  name: '① 封条不再签名（新账本退化成"自述被签过却没有签名"）',
  file: 'src/ledger.js',
  from: '      if (key?.privateKey) rec.sig = { alg: LEDGER_SIG_ALG, keyId: key.keyId, value: signSealRecord(rec, key.privateKey) };',
  to: '      if (false) rec.sig = { alg: LEDGER_SIG_ALG, keyId: key.keyId, value: signSealRecord(rec, key.privateKey) };',
  expect: ['封条必须带 ed25519 签名', '新账本来源签名必须有效'],
  run: SEC,
});

// ② 验签不通过也放过（"有签名就算有效"）→ 篡改后重算链必须被这条抓到
M.mutate({
  name: '② 验签失败也放过（改内容+重算链后签名仍判有效）',
  file: 'src/ledger.js',
  from: '  if (!verifySealRecord(seal, k.publicKey)) {',
  to: '  if (false) {',
  expect: ['签名必须失效'],
  run: SEC,
});

// ③ 换密钥不比对公钥指纹（另一把密钥写的账本被当成本机写的）——本项的核心价值
M.mutate({
  name: '③ 换密钥不比对指纹（另一把密钥签发的账本被判有效）',
  file: 'src/ledger.js',
  from: '  if (signerKeyId && k.keyId !== signerKeyId) {',
  to: '  if (false) {',
  expect: ['应指出实际签发密钥指纹'],
  run: SEC,
});

// ④ 无签名账本被判「签名无效」——升级把历史账本变成坏账本（向后兼容红线）
M.mutate({
  name: '④ 无签名老账本被判「签名无效」（升级即坏账）',
  file: 'src/ledger.js',
  from: "    return { signed: false, provenance: 'none', signerKeyId: null, verifyKeyId: null, provenanceError: null };",
  to: "    return { signed: false, provenance: 'invalid', signerKeyId: null, verifyKeyId: null, provenanceError: '变异：把无签名当成无效' };",
  expect: ['老账本必须报「无签名」'],
  run: SEC,
});

// ⑤ 密钥并进凭证库（key remove/import 会全量重写它 → 一次顺手操作让历史账本全变"另一把密钥签发"）
M.mutate({
  name: '⑤ 签名密钥并进凭证库（不再独立成 ledger-key.json）',
  file: 'src/ledger.js',
  from: "  return path.join(mingdaoHome(), 'ledger-key.json');",
  to: "  return path.join(mingdaoHome(), 'credentials.json');",
  expect: ['密钥必须落到 <home>/ledger-key.json'],
  run: SEC,
});

// ⑥ --generate 静默覆盖已有密钥（"换密钥"必须是显式决定，否则旧账本一夜之间全失效）
M.mutate({
  name: '⑥ --generate 静默覆盖已有密钥',
  file: 'src/ledger.js',
  from: '  if (!force) {\n    if (cur.ok && cur.key) {',
  to: '  if (false) {\n    if (cur.ok && cur.key) {',
  expect: ['必须拒绝覆盖'],
  run: SEC,
});

// ⑦ CLI 把「签名无效」当通过（退出码语义静默失效：CI 拿它当门禁即假通过）
M.mutate({
  name: '⑦ CLI 对「签名无效」不再给非 0 退出码',
  file: 'src/commands/ledger.js',
  from: '      io.print(style(`   （哈希链与封条本身吻合：${v.total} 条事件未被改动、尾部未被截断——问题出在「是谁写的」。）`, C.dim));\n      process.exitCode = 1;',
  to: '      io.print(style(`   （哈希链与封条本身吻合：${v.total} 条事件未被改动、尾部未被截断——问题出在「是谁写的」。）`, C.dim));',
  expect: ['签名无效必须退非 0'],
  run: SEC,
});

if (!M.report()) process.exit(1);
