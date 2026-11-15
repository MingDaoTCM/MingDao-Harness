// 批九十二（v0.9.0）：Linux deb 安装形态自动更新（`desktop/deb-update.js`）的变异验证。
//
// 目标：把 v0.9.0 新增的**安全关键路径**逐条改回缺陷，`test/deb-update.js` 必须当场红，
// 且失败输出里出现该条 `expect` 关键词（关键词 = 断言原文，防止"红是红了，但不是你改坏的那条"）。
//
// 为什么需要这一批：desktop/deb-update.js 是版本比较 / sha512 / 签名解析 / 提权安装计划的**唯一一份**
// 实现（main.js 只做接线与 spawn），v0.9.0 落地时只有 16 项普通单测、**零变异覆盖**——
// 改坏一处可能仍然全绿（例如把 `c > 0` 写成 `c < 0`，旧版会被判成新版；把 sha512 校验改成
// `return true`，篡改过的包会被安装）。
//
// 覆盖（8 条）：
//   isNewer：比较符反转（旧版判成新版）/ 去掉"-beta 预发布小于同号正式版"；
//   verifySha512Base64：校验恒通过；
//   parseSigFile：不剥 `ed25519:` 前缀；
//   installPlan：`pkexec` 改成 `sh -c`（提权被绕过 / 命令形状错）；
//   parseDebFeed：`url` 不拼 `/downloads/`（下载 404）/ 缺 `sha512` 仍返回对象（没校验值也放行）；
//   debFeedUrl：清单文件名拼错（客户端拉不到 feed）。
//
// 用法：node test/mutate/batch92-deb-update.mjs
import { makeMutator } from './lib.mjs';

const M = makeMutator();
const DEB = 'desktop/deb-update.js';
const SUITE = () => M.suite('test/deb-update.js');

// ① isNewer 比较符反转：`0.8.1` 相对 `0.8.2` 也被判成"有新版"——旧版会被提示升级到更低版本。
M.mutate({
  name: '① isNewer 比较符反转（旧版被判成新版）',
  file: DEB,
  from: '  return c !== null && c > 0;',
  to: '  return c !== null && c < 0; // 变异：比较符反转（旧版被判成新版）',
  expect: ['0.8.3 必须大于 0.8.2', '回退版本不是'],
  run: SUITE,
});

// ② 去掉"-beta 预发布小于同号正式版"的判断：`0.8.2-beta.1` 与 `0.8.2` 按同版本处理，
// 预发布版本被当成正式版（要么错过升级，要么把 beta 当正式装给用户）。
M.mutate({
  name: '② 去掉 -beta 预发布小于同号正式版的判断',
  file: DEB,
  from: '  if (!va.pre.length && !vb.pre.length) return 0;\n  if (!va.pre.length) return 1; // 正式版 > 同号预发布\n  if (!vb.pre.length) return -1;',
  to: '  if (!va.pre.length && !vb.pre.length) return 0;\n  // 变异：去掉"正式版 > 同号预发布"的判断（-beta 被当成正式版）',
  expect: ['同号预发布必须小于正式版'],
  run: SUITE,
});

// ③ sha512 恒通过：清单写错一位（或下载被篡改）也能过完整性校验，直接进入安装。
M.mutate({
  name: '③ verifySha512Base64 校验恒通过',
  file: DEB,
  from: "  return crypto.createHash('sha512').update(data).digest('base64') === expected;",
  to: '  return true; // 变异：sha512 校验恒通过',
  expect: ['改一个字节必须失败'],
  run: SUITE,
});

// ④ 不剥 `ed25519:` 前缀：我方 .sig 的第一种既有写法直接解析失败 → 验签永远不通过（更新通道瘫痪）。
M.mutate({
  name: '④ parseSigFile 不剥 ed25519: 前缀',
  file: DEB,
  from: "  const value = line.replace(/^ed25519:/i, '').replace(/\\s+/g, '');",
  to: "  const value = line.replace(/\\s+/g, ''); // 变异：不剥 ed25519: 前缀",
  expect: ['前缀必须剥掉'],
  run: SUITE,
});

// ⑤ 提权入口改 `sh -c`：命令形状错（sh 收到的是 `-i` 之类参数会静默失败），
// 且绕开 polkit 的密码框——「装不装」的最后一道人工确认被跳过。
M.mutate({
  name: '⑤ installPlan 的 pkexec 改成 sh -c（提权被绕过）',
  file: DEB,
  from: "  return { cmd: 'pkexec', args: ['dpkg', '-i', p], fallbackHint: 'sudo dpkg -i ' + p };",
  to: "  return { cmd: 'sh', args: ['-c', 'dpkg -i ' + p], fallbackHint: 'sudo dpkg -i ' + p }; // 变异：pkexec 改 sh -c（提权被绕过）",
  expect: ['必须走 pkexec'],
  run: SUITE,
});

// ⑥ feed 里的 `url` 不拼 `/downloads/`：退化成相对路径，客户端按相对地址下载 → 404（更新永远装不上）。
M.mutate({
  name: '⑥ parseDebFeed 的 url 不拼 /downloads/',
  file: DEB,
  from: '  return { version, path: pathName, url: DEB_DOWNLOAD_BASE + pathName, sha512, size };',
  to: '  return { version, path: pathName, url: pathName, sha512, size }; // 变异：url 不拼 downloads/ 前缀',
  expect: ['url 必须由 downloads'],
  run: SUITE,
});

// ⑦ 清单文件名拼错：客户端拉不到 feed（更新检查永远"已是最新"，且不报错）。
M.mutate({
  name: '⑦ debFeedUrl 的清单文件名拼错',
  file: DEB,
  from: "export const DEB_FEED_FILE = 'latest-linux-deb.yml';",
  to: "export const DEB_FEED_FILE = 'latest-linux-deb.yaml'; // 变异：文件名拼错",
  expect: ['默认 base 必须拼出官网清单地址'],
  run: SUITE,
});

// ⑧ 缺 `sha512` 也返回对象：没有校验值的清单被放行，下载后的包**无完整性校验**就进入安装流程。
M.mutate({
  name: '⑧ parseDebFeed 缺 sha512 仍返回对象',
  file: DEB,
  from: '  if (!version || !pathName || !sha512) return null;',
  to: '  if (!version || !pathName) return null; // 变异：缺 sha512 也放行',
  expect: ['缺 sha512 必须整份拒绝'],
  run: SUITE,
});

const ok = M.report();
process.exit(ok ? 0 : 1);
