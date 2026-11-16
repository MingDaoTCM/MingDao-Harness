// deb 安装形态自动更新的独立回归套件（v0.8.3）。
//
// 背景：Linux 上的 deb 安装（`/opt/MingDao Harness/`，无 `$APPIMAGE`）此前**不支持**自更新，
// 只弹"请到官网下载"。v0.8.3 给它接了一条独立通道：
//   feed（latest-linux-deb.yml）→ 语义化版本比较 → 下载 → sha512 **且** ed25519 来源签名
//   → `pkexec dpkg -i` → 重启。
//
// 本套件固定住的是**纯函数边界 + 源码接线**（零网络、零 electron、零 root）：
//   ① feed URL / 极简 YAML 解析（正常 / 缺字段 / 脏行 / 非法版本）；
//   ② 语义化版本比较（升级 / 相同 / 回退 / 预发布小于同号正式版 / 非法串）；
//   ③ sha512（正确 / 篡改 / 空期望值）；
//   ④ `.sig` 文本两种格式（`ed25519:` 前缀 / 纯 base64）与坏输入；
//   ⑤ 安装计划形状（pkexec dpkg -i，不用 apt）；
//   ⑥ main.js 接线绊线：deb 分支必须引用新清单、密钥环验签、pkexec、双校验失败删除；
//      同时 AppImage 的 electron-updater 路径必须原样还在（"只改 deb 分支"的证据）。
//
// 诚实边界：真实 `dpkg -i` 需要 root + polkit + 真实 .deb，CI 里无法验证（也不该验证）；
// 本套件只覆盖"决定装不装"的全部纯逻辑，安装动作本身留待发行侧人工验收（见 CHANGELOG）。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const D = await import(pathToFileURL(path.join(root, 'desktop', 'deb-update.js')).href);
const mainSrc = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8');
const debSrc = fs.readFileSync(path.join(root, 'desktop', 'deb-update.js'), 'utf8');

let passed = 0;
const ok = (/** @type {string} */ name) => { passed += 1; console.log(`  ✓ ${name}`); };

const FEED_OK = [
  'version: 0.8.2',
  'path: mingdao-0.8.2-amd64.deb',
  'sha512: 3q2+7w==',
  'size: 76024290',
  'releaseDate: "2026-11-15T04:38:14.000Z"',
  '',
].join('\n');

// ---------- ① feed URL ----------
{
  assert.equal(D.debFeedUrl(), 'https://harness.mingdao.ai/updates/latest-linux-deb.yml', '默认 base 必须拼出官网清单地址');
  assert.equal(D.debFeedUrl('https://mirror.example/updates/'), 'https://mirror.example/updates/latest-linux-deb.yml', '带尾斜杠的 base 原样拼');
  assert.equal(D.debFeedUrl('https://mirror.example/updates'), 'https://mirror.example/updates/latest-linux-deb.yml', '缺尾斜杠的 base 必须补上');
  assert.equal(D.debFeedUrl(''), 'https://harness.mingdao.ai/updates/latest-linux-deb.yml', '空 base 回落默认（不拼出相对路径）');
  ok('① debFeedUrl：默认 / 带斜杠 / 缺斜杠 / 空值四种 base');
}

// ---------- ② feed 解析：正常 ----------
{
  const feed = D.parseDebFeed(FEED_OK);
  assert.ok(feed, '正常清单必须解析成功');
  assert.equal(feed.version, '0.8.2');
  assert.equal(feed.path, 'mingdao-0.8.2-amd64.deb', 'path 必须是清单里的文件名');
  assert.equal(feed.url, 'https://harness.mingdao.ai/downloads/mingdao-0.8.2-amd64.deb', 'url 必须由 downloads/<path> 拼出');
  assert.equal(feed.sha512, '3q2+7w==');
  assert.equal(feed.size, 76024290, 'size 必须是数字');
  ok('② parseDebFeed：正常清单（version/path/url/sha512/size 全字段）');
}

// ---------- ②b 线路选择后的下载目录（v0.9.2） ----------
{
  const hk = D.parseDebFeed(FEED_OK, { downloadsBase: 'https://harness.mingdao.ai/downloads/' });
  const sz = D.parseDebFeed(FEED_OK, { downloadsBase: 'https://harness.southdns.com/downloads/' });
  const szNoSlash = D.parseDebFeed(FEED_OK, { downloadsBase: 'https://harness.southdns.com/downloads' });
  assert.equal(sz?.url, 'https://harness.southdns.com/downloads/mingdao-0.8.2-amd64.deb', '选中深圳时安装包 url 必须拼到深圳 /downloads/');
  assert.equal(szNoSlash?.url, sz?.url, 'downloadsBase 缺尾斜杠/带尾斜杠必须拼出同一个 url（不能双斜杠）');
  assert.equal(hk?.url, 'https://harness.mingdao.ai/downloads/mingdao-0.8.2-amd64.deb');
  assert.equal(D.parseDebFeed(FEED_OK, { downloadsBase: '' })?.url, 'https://harness.mingdao.ai/downloads/mingdao-0.8.2-amd64.deb', '空 downloadsBase 必须回落香港');
  assert.equal(D.parseDebFeed(FEED_OK)?.url, hk?.url, '不传 downloadsBase 时行为与历史一致（默认香港）');
  ok('②b parseDebFeed：downloadsBase 可切到深圳（尾斜杠归一、空值回落香港、不传保持默认）');
}

// ---------- ③ feed 解析：缺字段 ----------
{
  assert.equal(D.parseDebFeed('version: 0.8.2\npath: a.deb\n'), null, '缺 sha512 必须整份拒绝（不能拿"无校验"的包去装）');
  assert.equal(D.parseDebFeed('version: 0.8.2\nsha512: x=\n'), null, '缺 path 必须拒绝');
  assert.equal(D.parseDebFeed('path: a.deb\nsha512: x=\n'), null, '缺 version 必须拒绝');
  assert.equal(D.parseDebFeed(''), null, '空文本必须拒绝');
  assert.equal(D.parseDebFeed(/** @type {any} */ (null)), null, '非字符串输入必须拒绝');
  ok('③ parseDebFeed：缺 sha512 / path / version、空文本、非字符串 → null');
}

// ---------- ④ feed 解析：脏行 ----------
{
  const dirty = [
    '# 这是注释，不能被当成键',
    '',
    '   ',
    '---',
    'version: "0.8.3"',
    'unexpected: 忽略我',
    'files:',
    '  - url: https://evil.example/x.deb',
    '    sha512: 攻击者想覆盖的嵌套值',
    'path: mingdao-0.8.3-amd64.deb',
    'sha512: goodb64==',
    'size: 12',
    'releaseDate: "2026-11-15T04:38:14.000Z"',
  ].join('\r\n');
  const feed = D.parseDebFeed(dirty);
  assert.ok(feed, '带注释/空行/CRLF/未知键/缩进块的清单仍应解析出顶层四键');
  assert.equal(feed.version, '0.8.3', '引号必须去掉');
  assert.equal(feed.sha512, 'goodb64==', '缩进块里的 sha512 绝不能覆盖顶层 sha512');
  assert.equal(feed.path, 'mingdao-0.8.3-amd64.deb');
  assert.equal(feed.size, 12);
  ok('④ parseDebFeed：脏行（注释/CRLF/未知键/嵌套块/引号）不污染顶层键');
}

// ---------- ⑤ feed 解析：非法版本 / 路径 ----------
{
  assert.equal(D.parseDebFeed('version: latest\npath: a.deb\nsha512: x=\n'), null, '版本非法必须整份拒绝');
  const slash = D.parseDebFeed('version: 0.8.3\npath: /mingdao-0.8.3-amd64.deb\nsha512: x=\n');
  assert.ok(slash, '起首斜杠的 path 应被规范化而不是拒绝');
  assert.equal(slash.path, 'mingdao-0.8.3-amd64.deb', 'path 起首斜杠必须去掉（否则 url 拼出双斜杠）');
  assert.equal(slash.url, 'https://harness.mingdao.ai/downloads/mingdao-0.8.3-amd64.deb');
  ok('⑤ parseDebFeed：非法版本 → null；path 起首斜杠被规范化');
}

// ---------- ⑥ isNewer：升级 / 相同 / 回退 ----------
{
  assert.equal(D.isNewer('0.8.3', '0.8.2'), true, '0.8.3 必须大于 0.8.2');
  assert.equal(D.isNewer('0.8.2', '0.8.2'), false, '同版本不是"有新版"');
  assert.equal(D.isNewer('0.8.1', '0.8.2'), false, '回退版本不是"有新版"');
  assert.equal(D.isNewer('0.9.0', '0.10.0'), false, '按数值比较而不是字符串比较（0.9.0 < 0.10.0）');
  ok('⑥ isNewer：升级 / 相同 / 回退 / 数值比较（0.9.0 < 0.10.0）');
}

// ---------- ⑦ isNewer：预发布 ----------
{
  assert.equal(D.isNewer('0.8.2-beta.1', '0.8.2'), false, '同号预发布必须小于正式版');
  assert.equal(D.isNewer('0.8.2', '0.8.2-beta.1'), true, '正式版必须大于同号预发布');
  assert.equal(D.isNewer('0.8.2-beta.2', '0.8.2-beta.1'), true, '预发布段按数值递增比较');
  assert.equal(D.isNewer('0.8.2-beta.1', '0.8.2-beta.2'), false, '预发布回退不是"有新版"');
  assert.equal(D.isNewer('0.8.3-beta.1', '0.8.2'), true, '核心版本更大时，预发布仍然是新版');
  ok('⑦ isNewer：-beta 小于同号正式版 / 预发布之间按段比较 / 大核版本仍升级');
}

// ---------- ⑧ isNewer：非法串 ----------
{
  for (const bad of ['', 'abc', '0.8', '0.8.2.1', 'v', '0.8.x', '01.8.2-beta_bad']) {
    assert.equal(D.isNewer(bad, '0.8.2'), false, `候选版本非法（${JSON.stringify(bad)}）必须返回 false，不能当成新版`);
    assert.equal(D.isNewer('0.8.2', bad), false, `当前版本非法（${JSON.stringify(bad)}）必须返回 false`);
  }
  ok('⑧ isNewer：非法版本串（空/少段/多段/字母）一律 false');
}

// ---------- ⑨ sha512 ----------
{
  const bytes = Buffer.from('mingdao-deb-fixture-bytes');
  const good = crypto.createHash('sha512').update(bytes).digest('base64');
  assert.equal(D.verifySha512Base64(bytes, good), true, '正确的 sha512 必须通过');
  assert.equal(D.verifySha512Base64(bytes, '  ' + good + '\n'), true, '期望值两侧空白应被容忍');
  assert.equal(D.verifySha512Base64(Buffer.from('mingdao-deb-fixture-bytez'), good), false, '改一个字节必须失败');
  assert.equal(D.verifySha512Base64(bytes, ''), false, '空期望值必须失败（不能把"清单没写校验"当成通过）');
  assert.equal(D.verifySha512Base64(/** @type {any} */ (null), good), false, '没有字节必须失败');
  assert.equal(D.verifySha512Base64(bytes, crypto.createHash('sha256').update(bytes).digest('base64')), false, '算法用错（sha256）必须失败');
  ok('⑨ verifySha512Base64：正确 / 空白容忍 / 篡改 / 空期望 / 无字节 / 错算法');
}

// ---------- ⑩ .sig 文本解析 ----------
{
  const sig = crypto.sign(null, Buffer.from('deb-bytes'), crypto.generateKeyPairSync('ed25519').privateKey);
  const b64 = sig.toString('base64');
  assert.equal(D.parseSigFile('ed25519:' + b64), b64, '`ed25519:` 前缀必须剥掉');
  assert.equal(D.parseSigFile(b64), b64, '纯 base64 必须原样通过');
  assert.equal(D.parseSigFile('ed25519: ' + b64.toUpperCase()), D.parseSigFile(b64.toUpperCase()), '大写 base64 也必须能解析');
  assert.equal(D.parseSigFile(`# generated by publish-update-sigs.mjs\ned25519:${b64}\n`), b64, '注释行必须跳过，只取首个非注释行');
  assert.equal(D.parseSigFile(''), null, '空文本不可用');
  assert.equal(D.parseSigFile('not base64 !!'), null, '非 base64 不可用');
  assert.equal(D.parseSigFile('AAAA'), null, '解码后不是 64 字节（ed25519 恒 64）必须不可用');
  assert.equal(D.parseSigFile(/** @type {any} */ (null)), null, '非字符串输入不可用');
  ok('⑩ parseSigFile：ed25519 前缀 / 纯 base64 / 注释 / 坏输入 / 短签名');
}

// ---------- ⑪ 安装计划 ----------
{
  const plan = D.installPlan({ filePath: '/tmp/mingdao-update-0.8.3.deb' });
  assert.equal(plan.cmd, 'pkexec', '必须走 pkexec（图形会话里弹系统密码框）');
  assert.deepEqual(plan.args, ['dpkg', '-i', '/tmp/mingdao-update-0.8.3.deb'], '必须 dpkg -i 本地文件，不得用 apt（会拉网络）');
  assert.equal(plan.fallbackHint, 'sudo dpkg -i /tmp/mingdao-update-0.8.3.deb', '回落提示必须带真实路径，用户可直接复制执行');
  assert.equal(plan.args.includes('apt'), false, '安装计划不得出现 apt');
  assert.equal(plan.manual, false, '默认（有 pkexec）必须是自动安装，不能误判成手动');
  assert.throws(() => D.installPlan({}), /filePath/, '缺路径必须抛错（不能生成一条装空路径的命令）');
  assert.throws(() => D.installPlan({ filePath: '   ' }), /filePath/, '空白路径必须抛错');
  ok('⑪ installPlan：pkexec dpkg -i 形状 / fallbackHint 带路径 / 拒绝空路径 / 默认非手动');
}

// ---------- ⑪b 没有 pkexec 的精简发行版（v0.9.2） ----------
{
  const manual = D.installPlan({ filePath: '/tmp/mingdao-update-0.9.2.deb', pkexecAvailable: false });
  assert.equal(manual.manual, true, '探测不到 pkexec 时必须标记手动安装（main.js 据此弹"手动安装"对话框，不 spawn 必然 ENOENT 的命令）');
  assert.equal(manual.cmd, 'pkexec', '计划形状保持不变（诊断信息仍要能说明本该用什么命令）');
  assert.equal(manual.fallbackHint, 'sudo dpkg -i /tmp/mingdao-update-0.9.2.deb', '手动安装必须给出可直接复制的 sudo dpkg -i');
  assert.equal(D.installPlan({ filePath: '/tmp/x.deb', pkexecAvailable: true }).manual, false, '探测到 pkexec → 自动安装');
  ok('⑪b installPlan：pkexecAvailable=false → manual=true + 可复制的 sudo dpkg -i；true → 自动');
}

// ---------- ⑪c `.sig` 候选 URL（v0.9.2：跟随选中线路） ----------
{
  const candidates = D.sigUrlCandidates({
    sigName: 'mingdao-0.9.2-amd64.deb',
    feedUrl: 'https://harness.southdns.com/downloads/mingdao-0.9.2-amd64.deb',
    updatesBase: 'https://harness.southdns.com/updates/',
  });
  assert.deepEqual(
    candidates,
    [
      'https://harness.southdns.com/updates/mingdao-0.9.2-amd64.deb.sig',
      'https://harness.southdns.com/downloads/mingdao-0.9.2-amd64.deb.sig',
    ],
    '签名候选必须是「feed 目录优先 + 安装包同目录兜底」，且都跟随选中线路'
  );
  assert.deepEqual(
    D.sigUrlCandidates({ sigName: 'a.deb', feedUrl: 'https://x/downloads/a.deb', updatesBase: 'https://x/updates' }),
    ['https://x/updates/a.deb.sig', 'https://x/downloads/a.deb.sig'],
    'updatesBase 缺尾斜杠必须补齐'
  );
  assert.deepEqual(
    D.sigUrlCandidates({ sigName: 'a.deb' }),
    ['https://harness.mingdao.ai/updates/a.deb.sig'],
    '不传 updatesBase 时回落默认官网 feed（历史行为）'
  );
  assert.deepEqual(
    D.sigUrlCandidates({ sigName: 'a.deb', feedUrl: 'https://x/downloads/a.deb', updatesBase: 'https://x/downloads/' }),
    ['https://x/downloads/a.deb.sig'],
    '同一 URL 的候选必须去重（不能重复请求同一个 404）'
  );
  assert.deepEqual(D.sigUrlCandidates({}), [], '空输入 → 无候选（调用方按"没有签名"处理）');
  ok('⑪c sigUrlCandidates：feed 目录优先 + 同目录兜底、补尾斜杠、空输入空数组');
}

// ---------- ⑫ 源码接线绊线：deb 分支必须真的接上（不是只有纯函数） ----------
{
  assert.match(mainSrc, /latest-linux-deb\.yml/, 'main.js 必须引用 deb 清单（否则 deb 通道永远不生效）');
  assert.match(mainSrc, /from '\.\/deb-update\.js'/, 'main.js 必须 import 本模块');
  assert.match(mainSrc, /verifyArtifactSignatureWithKeyring/, 'main.js 必须用密钥环验签（不只是 sha512）');
  assert.match(mainSrc, /UPDATE_PUBLIC_KEYS/, '验签必须用内置密钥环');
  assert.match(mainSrc, /verifySha512Base64/, 'main.js 必须做 sha512 完整性校验');
  assert.match(mainSrc, /parseSigFile/, 'main.js 必须解析 .sig 文本');
  assert.match(mainSrc, /pkexec/, 'main.js 必须用 pkexec 提权安装');
  assert.match(mainSrc, /spawn\(/, 'main.js 必须 spawn 安装进程并等待退出码');
  ok('⑫ 源码绊线：main.js 的 deb 通道引用清单 / 密钥环验签 / sha512 / pkexec / spawn');
}

// ---------- ⑬ 源码绊线：双校验失败必须删除文件、绝不安装 ----------
{
  assert.match(mainSrc, /const shaOk = verifySha512Base64\([\s\S]{0,2500}verifyArtifactSignatureWithKeyring/, 'sha512 与验签必须成对出现在同一段校验逻辑里');
  assert.match(mainSrc, /unlinkSync/, '校验失败必须删除下载文件');
  // 删除必须发生在"安装确认"之前：unlink 的源码位置要早于 pkexec 的 spawn 位置
  const unlinkAt = mainSrc.indexOf('unlinkSync');
  const installAt = mainSrc.indexOf("installPlan(");
  assert.ok(unlinkAt > 0 && installAt > 0 && unlinkAt < installAt, '删除坏文件必须发生在安装之前（先校验后安装）');
  assert.match(mainSrc, /400 \* 1024 \* 1024/, '下载必须有 400 MiB 上限');
  assert.match(mainSrc, /setProgressBar/, '下载必须有窗口进度（无窗口时忽略）');
  ok('⑬ 源码绊线：双校验 → 失败 unlink → 再谈安装；400 MiB 上限 + 进度条');
}

// ---------- ⑭ 源码绊线：deb 分支的用户可见流程与回落文案 ----------
{
  for (const text of ['下载并安装', '稍后', '已校验通过', '立即安装', '立即重启']) {
    assert.ok(mainSrc.includes(text), `deb 分支缺少用户可见文案「${text}」`);
  }
  // v0.9.2：官网/下载链接不再写死（线路选择后要跟着变）——单源是 endpoint.js 的 downloadPageUrl()，
  // 其默认值就是官方 http://harness.mingdao.ai/#downloads（套件 ②/③ 已钉住 URL 拼接）。
  assert.ok(mainSrc.includes('updateDownloadPage()'), 'deb 分支的「去官网下载」必须走 downloadPageUrl（跟随选中线路），不得再写死 URL');
  assert.ok(debSrc.includes('https://harness.mingdao.ai/updates/'), 'deb-update.js 必须保留官方 feed 默认值（回退香港与历史行为）');
  assert.ok(mainSrc.includes('plan.fallbackHint'), '安装失败弹窗必须展示可复制的回落命令（fallbackHint）');
  assert.ok(debSrc.includes("fallbackHint: 'sudo dpkg -i '"), 'fallbackHint 必须是可复制执行的 sudo dpkg -i 命令');
  assert.doesNotMatch(mainSrc, /deb 安装不支持自动更新/, 'v0.8.3 起 main.js 不得再宣称"deb 安装不支持自动更新"');
  assert.ok(mainSrc.includes('app.relaunch()'), '安装成功后必须能立即重启（app.relaunch + app.exit）');
  assert.match(mainSrc, /退出码/, '安装退出码必须落日志（便于售后定位 126/127）');
  ok('⑭ 源码绊线：确认 → 校验通过 → 立即安装 → 立即重启；失败回落 sudo 命令 + 下载页（跟随线路）');
}

// ---------- ⑭b 源码绊线：deb 流程的可观测性与卡死修复（v0.9.2） ----------
{
  assert.match(mainSrc, /DEB_IDLE_TIMEOUT_MS/, 'deb 下载必须传空闲超时（跨海链路卡住不能干等 5 分钟）');
  assert.match(mainSrc, /idleTimeoutMs: DEB_IDLE_TIMEOUT_MS/, '空闲超时参数必须真的接到下载调用上');
  assert.match(mainSrc, /getUpdateResource\('\/updates\/' \+ DEB_FEED_FILE/, 'deb 清单必须走带镜像回退的取资源函数');
  assert.match(mainSrc, /showUpdateFailure\(/, '失败必须走统一失败弹窗（带「打开日志」）');
  assert.match(mainSrc, /打开日志/, 'deb 失败弹窗必须有「打开日志」按钮');
  for (const st of ['stage=feed', 'stage=confirm', 'stage=download', 'stage=save', 'stage=verify', 'stage=sig', 'stage=install']) {
    assert.ok(mainSrc.includes(st), `deb 流程缺少可定位日志 ${st}`);
  }
  assert.match(mainSrc, /which pkexec/, '安装前必须探测 which pkexec（精简发行版没有 polkit）');
  ok('⑭b 源码绊线：空闲超时 / 镜像回退取资源 / 统一失败弹窗+打开日志 / 七段 stage 日志 / pkexec 探测');
}

// ---------- ⑮ 源码绊线：AppImage 路径一行未动 ----------
{
  assert.match(mainSrc, /import\('electron-updater'\)/, 'AppImage 路径必须仍走 electron-updater');
  assert.match(mainSrc, /process\.env\.APPIMAGE/, 'AppImage 路径的环境判定必须仍在');
  assert.match(mainSrc, /quitAndInstall\(\)/, 'AppImage 路径的安装动作必须仍在');
  assert.match(mainSrc, /autoUpdater\.on\('update-downloaded'/, 'AppImage 的下载完成事件必须仍在');
  ok('⑮ 源码绊线：AppImage 的 electron-updater 分支原样保留（只新增 deb 通道）');
}

// ---------- ⑯ 纯函数层不碰 electron / 不联网 ----------
{
  assert.doesNotMatch(debSrc, /from\s+['"]electron['"]/, 'deb-update.js 不得 import electron（否则单测需要图形环境）');
  assert.doesNotMatch(debSrc, /from\s+['"]node:https?['"]/, 'deb-update.js 不得直接联网（feed 拉取在 main.js）');
  assert.doesNotMatch(debSrc, /from\s+['"]node:child_process['"]/, 'deb-update.js 不得自己 spawn（安装动作在 main.js）');
  assert.match(debSrc, /from ['"]node:crypto['"]/, '只允许 node:crypto');
  ok('⑯ 纯函数层：零 electron / 零网络 / 零子进程，只有 node:crypto');
}

console.log(`\ndeb 安装形态自动更新：${passed} 项通过`);
