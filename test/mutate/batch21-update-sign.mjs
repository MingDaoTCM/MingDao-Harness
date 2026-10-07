// 批二十一（v0.6.11：Electron 更新包**来源签名**，审计 K-8 完整版）的变异验证。
//
// 先复现（探针 /tmp/probe-update-feed.mjs，未入库：本机 HTTP 投毒 feed + 桩 electron-updater，
// 被测对象是**真实的** desktop/main.js，feed 地址取自 electron-builder.yml 的真实 publish.url）：
//   ① 投毒 feed + 攻击者自己算的 sha512 → 下载 → sha512 MATCH → `quitAndInstall()` 被调用
//      ⇒ electron-updater 的 sha512 与包**同源**，只防传输损坏、不防换源；
//   ② 只改字节不改清单 → sha512 mismatch → 不安装（这一层确实在工作，但只覆盖这一种威胁）；
//   修后：③ 无签名默认 → warn-and-install（UI/日志写明"未验证来源签名"）；
//        ④ 无签名 + REQUIRE=1 → reject 且关掉 autoInstallOnAppQuit；
//        ⑤ 攻击者密钥签的包 → reject；⑥ 信任公钥签的包 → install；
//        ⑦ 清单声明了签名但内容为空 → reject（第四态）。
// 本批把 §135 的每条断言反着验一遍：把修复逐个改回缺陷，看它们是否**当场红**
// （红不了一定是关键词对不上，而不是"断言太强"）。修法分布在三个文件：
// desktop/update-verify.js（纯判据 + 文案）、desktop/main.js（门禁接线）、scripts/update-sign.mjs（发布侧工具）。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SEC = () => M.section('135');

// ① 验签失败也放过：篡改一个字节的包会照装（"有签名"变成走过场）
M.mutate({
  name: '① decideUpdatePolicy：有签名但验不过也返回 install（篡改包照装）',
  file: 'desktop/update-verify.js',
  from: "  if (verifyResult && verifyResult.ok === true) return 'install';\n  return 'reject';",
  to: "  if (verifyResult && verifyResult.ok === true) return 'install';\n  return 'install';",
  expect: ['签名无效必须拒绝'],
  run: SEC,
});

// ② 无签名 + REQUIRE=1 仍放行：fail-closed 开关变成摆设（发行方/高安全用户唯一的那道闸门没了）
M.mutate({
  name: '② decideUpdatePolicy：MINGDAO_REQUIRE_UPDATE_SIGNATURE=1 时无签名照样放行',
  file: 'desktop/update-verify.js',
  from: "  if (!signed) return required ? 'reject' : 'warn-and-install';",
  to: "  if (!signed) return 'warn-and-install';",
  expect: ['无签名必须拒绝'],
  run: SEC,
});

// ③ 默认档退回 install：UI/日志里"未验证来源签名"的明示随之消失（不是拒绝，是**不告诉用户**）
M.mutate({
  name: '③ decideUpdatePolicy：无签名 + 默认档改成 install（丢掉"警告后安装"的明示语义）',
  file: 'desktop/update-verify.js',
  from: "  if (!signed) return required ? 'reject' : 'warn-and-install';",
  to: "  if (!signed) return required ? 'reject' : 'install';",
  expect: ['无签名 + 默认档'],
  run: SEC,
});

// ④ 验签结果不看了：ed25519 的密码学结论被丢掉（"看到签名就算过"——攻击者自己签一个即可）
M.mutate({
  name: '④ verifyArtifactSignature：crypto.verify 返回 false 也不返回失败',
  file: 'desktop/update-verify.js',
  from: "  if (!ok) return { ok: false, reason: '签名与更新包字节不匹配（包被改过，或由另一把密钥签发）' };",
  to: '  if (!ok) { /* 变异：验签失败也放过 */ }',
  expect: ['改一个字节必须验不过'],
  run: SEC,
});

// ⑤ 签名覆盖的不是文件字节（改验空 buffer）：签名与包脱钩，任何"签名"都能被复用
M.mutate({
  name: '⑤ verifyArtifactSignature：签名不再覆盖文件字节（改验空 buffer）',
  file: 'desktop/update-verify.js',
  from: '    ok = crypto.verify(null, data, key, Buffer.from(parsed.signatureB64, \'base64\'));',
  to: "    ok = crypto.verify(null, Buffer.alloc(0), key, Buffer.from(parsed.signatureB64, 'base64'));",
  expect: ['有效签名必须验过'],
  run: SEC,
});

// ⑥ 丢掉 64 字节长度检查：63 字节的"签名"被当成签名送进 crypto.verify（早失败判据消失）
M.mutate({
  name: '⑥ parseSignatureText：不再校验 ed25519 签名的 64 字节长度',
  file: 'desktop/update-verify.js',
  from: '  if (buf.length !== 64) return { ok: false, reason: `签名长度不是 64 字节（ed25519 恒为 64，实际 ${buf.length}）` };',
  to: '  if (false) return { ok: false, reason: `签名长度不是 64 字节（ed25519 恒为 64，实际 ${buf.length}）` };',
  expect: ['失败原因必须点明 ed25519 签名长度'],
  run: SEC,
});

// ⑦ 第四态被抹掉：清单**声明**了签名却拿不到内容时降级成"无签名"→ 默认档直接放行（"拿不到证据"被当成"没问题"）
M.mutate({
  name: '⑦ evaluateUpdate：丢掉"清单声明了签名但内容为空"这一态（降级成无签名）',
  file: 'desktop/update-verify.js',
  from: "  const hasSignature = declared || value !== '';",
  to: "  const hasSignature = value !== '';",
  expect: ['第四态'],
  run: SEC,
});

// ⑧ 清单内嵌的签名被忽略：签名载体少一条，发布侧按 yml 下发签名时客户端一律报"无签名"
M.mutate({
  name: '⑧ collectUpdateSignature：忽略清单内嵌的 signature 字段',
  file: 'desktop/update-verify.js',
  from: "  if (typeof inlineSignature === 'string' && inlineSignature.trim() !== '') {",
  to: '  if (false) {',
  expect: ['清单内嵌 signature 必须被采纳'],
  run: SEC,
});

// ⑨ UI 不再明示"未验证来源签名"：默认档放行的代价被藏起来（用户以为这个包验过来源）
M.mutate({
  name: '⑨ buildUpdateNotice：未验证来源签名的标题退回普通"更新已就绪"',
  file: 'desktop/update-verify.js',
  from: "    title: '更新已就绪（未验证来源签名）',",
  to: "    title: '更新已就绪',",
  expect: ['标题也要让用户看见'],
  run: SEC,
});

// ⑩ 门禁分支失效：main.js 不再拦"来源不可信"的包（校验白算了，直接走到安装）
M.mutate({
  name: '⑩ main.js：拒绝分支被改成 if (false)（校验结果不再拦安装）',
  file: 'desktop/main.js',
  from: '        if (gate.allowInstall === false) {',
  to: '        if (false) {',
  expect: ['拒绝 → 不安装'],
  run: SEC,
});

// ⑪ 公钥不再来自内置常量：pin 的那把信任根被换掉/掏空（"从网络取公钥"就是没有 pin）
M.mutate({
  name: '⑪ main.js：不再使用内置公钥常量（信任根被换掉）',
  file: 'desktop/main.js',
  from: '  const key = resolveUpdatePublicKeyPem(); // 内置常量（可用 --keygen 生成的公钥替换；不从网络取）',
  to: "  const key = { pem: '', source: 'pinned' }; // 变异：不再用内置常量",
  expect: ['门禁里必须用内置公钥常量'],
  run: SEC,
});

// ⑫ 拒绝时不关 autoInstallOnAppQuit：应用退出时 electron-updater 照样把被拒的包装上（拒绝不彻底）
M.mutate({
  name: '⑫ main.js：拒绝分支不再关闭 autoInstallOnAppQuit（退出时仍会安装）',
  file: 'desktop/main.js',
  from: '          autoUpdater.autoInstallOnAppQuit = false;',
  to: '          autoUpdater.autoInstallOnAppQuit = autoUpdater.autoInstallOnAppQuit;',
  expect: ['拒绝分支必须关掉 autoInstallOnAppQuit'],
  run: SEC,
});

// ⑬ 私钥被打进 stdout：CI 日志/工单/截图里就会出现签发密钥（本轮最重要的一条纪律）
M.mutate({
  name: '⑬ update-sign.mjs：--keygen 把私钥打进 stdout',
  file: 'scripts/update-sign.mjs',
  from: "  console.log('✓ 已生成 ed25519 更新签名密钥对');",
  to: "  console.log('✓ 已生成 ed25519 更新签名密钥对，privateKey=' + record.privateKey);",
  expect: ['私钥绝不能出现在 stdout'],
  run: SEC,
});

// ⑭ 不再拒绝把私钥写进仓库：一次 `git add` 就能让全世界拿到"伪造官方更新包"的能力
M.mutate({
  name: '⑭ update-sign.mjs：--keygen 不再拒绝把私钥写进仓库',
  file: 'scripts/update-sign.mjs',
  from: "  if (!inRepo.startsWith('..') && !path.isAbsolute(inRepo) && !has('--allow-repo')) {",
  to: '  if (false) {',
  expect: ['--keygen 必须拒绝把私钥写进仓库'],
  run: SEC,
});

// ⑮ --sign 签的不是文件字节：发布侧签了个寂寞，但自检（--verify）与客户端会同时说"不匹配"
M.mutate({
  name: '⑮ update-sign.mjs：--sign 签的不是安装包字节（改签空 buffer）',
  file: 'scripts/update-sign.mjs',
  from: '  const signature = crypto.sign(null, bytes, privateKey).toString(\'base64\');',
  to: "  const signature = crypto.sign(null, Buffer.alloc(0), privateKey).toString('base64');",
  expect: ['客户端实现必须能验过'],
  run: SEC,
});

process.exit(M.report() ? 0 : 1);
