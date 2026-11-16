// deb 安装形态（`/opt/MingDao Harness/`，无 `$APPIMAGE`）的自动更新**纯函数**层（v0.8.3）。
//
// 为什么需要单独一层：
//   ① electron-updater 只认 AppImage / NSIS / dmg+zip——deb 安装形态此前在 main.js 里是
//      **明示不支持**（只弹"请到官网下载"）。本模块把"判断有没有新版 / 校验下载到的字节 /
//      怎么装"做成不 import electron 的纯函数，既能在主进程里用，也能在零网络的单测里逐条钉边界。
//   ② 更新包来源签名链（desktop/update-verify.js 的 `UPDATE_PUBLIC_KEYS` /
//      `verifyArtifactSignatureWithKeyring`）是既有能力，这里**不重复实现密码学**——只负责
//      sha512 完整性 + `.sig` 文本解析 + 安装计划，验签本身由 main.js 调既有模块完成。
//
// 诚实边界：本模块的 `parseDebFeed` 是**极简 YAML 解析**（只认 version/path/sha512/size 四个
// 顶层键，不认锚点/多文档/流式写法）——feed 由我方发布链路生成，形状固定；解析失败一律返回
// null（宁可报"清单不可用"，也不拿半份数据去下载/安装）。
//
// 零运行时依赖：只用 Node 内置 `node:crypto`。不 import electron / node:https——单测无需网络、
// 无需图形环境，`node test/deb-update.js` 在任何平台都能跑（含 CI 的 Windows 腿）。
import crypto from 'node:crypto';

/** 更新清单所在的官网 feed 目录（与 desktop/update-verify.js 的 UPDATE_FEED_BASE 同源）。 */
export const UPDATE_FEED_BASE = 'https://harness.mingdao.ai/updates/';

/** deb 安装包下载目录（官网 generic feed；清单里的 `path` 拼在它后面）。 */
export const DEB_DOWNLOAD_BASE = 'https://harness.mingdao.ai/downloads/';

/** 清单文件名（deb 形态专用；与 AppImage 的 latest-linux.yml 分开，互不影响）。 */
export const DEB_FEED_FILE = 'latest-linux-deb.yml';

const FEED_KEYS = new Set(['version', 'path', 'sha512', 'size']);

/**
 * 拼出 deb 更新清单 URL。
 * @param {string} [base] feed 目录（默认官网 `/updates/`）
 * @returns {string}
 */
export function debFeedUrl(base = UPDATE_FEED_BASE) {
  const b = (typeof base === 'string' && base.trim() ? base.trim() : UPDATE_FEED_BASE);
  return (b.endsWith('/') ? b : b + '/') + DEB_FEED_FILE;
}

/**
 * 解析 deb 更新清单（极简 YAML：只认 version / path / sha512 / size 四个顶层键）。
 *
 * 形状：
 * ```yaml
 * version: 0.8.2
 * path: mingdao-0.8.2-amd64.deb
 * sha512: <base64>
 * size: 76024290
 * releaseDate: "2026-11-15T04:38:14.000Z"
 * ```
 * 规则：只认**行首无缩进**的 top-level 键（缩进行 = 嵌套块，忽略，避免 `files:` 里的
 * url/sha512 覆盖顶层值）；`#` 注释、空行、`---` 文档分隔符跳过；未知键忽略；
 * 值两侧的成对引号去掉。缺少 version/path/sha512 任一、或 version 不是合法语义化版本 → null。
 *
 * v0.9.2：`downloadsBase` 可覆盖安装包下载目录——线路选择（香港/深圳）后同一个清单里的
 * `path` 要拼到**选中线路**的 `/downloads/` 上，而不是写死的香港。
 * @param {string} text
 * @param {{downloadsBase?: string}} [opts]
 * @returns {{version: string, path: string, url: string, sha512: string, size: number} | null}
 */
export function parseDebFeed(text, { downloadsBase } = {}) {
  const src = typeof text === 'string' ? text : '';
  /** @type {Record<string, string>} */
  const values = {};
  for (const rawLine of src.split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, ' ').trimEnd();
    if (!line) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '---' || trimmed === '...') continue;
    // 缩进行 = 嵌套结构（如 electron-builder 清单里的 files: 列表），不当顶层键
    if (/^\s/.test(rawLine)) continue;
    const m = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(trimmed);
    if (!m) continue;
    if (!FEED_KEYS.has(m[1])) continue;
    let value = m[2].trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) value = value.slice(1, -1).trim();
    }
    if (value) values[m[1]] = value;
  }
  const version = String(values.version || '').trim();
  const pathName = String(values.path || '').trim().replace(/^\/+/, '');
  const sha512 = String(values.sha512 || '').trim();
  if (!version || !pathName || !sha512) return null;
  if (!parseVersion(version)) return null;
  const sizeNum = Number(values.size);
  const size = Number.isFinite(sizeNum) && sizeNum >= 0 ? Math.floor(sizeNum) : 0;
  const base = typeof downloadsBase === 'string' && downloadsBase.trim() ? downloadsBase.trim() : DEB_DOWNLOAD_BASE;
  const withSlash = base.endsWith('/') ? base : base + '/';
  return { version, path: pathName, url: withSlash + pathName, sha512, size };
}

/**
 * 语义化版本比较的单一解析器：`X.Y.Z[-prerelease][+build]`（允许 `v` 前缀）。
 * 格式非法返回 null——调用方据此**不做**"更新"决定（格式不认识不等于有新版）。
 * @param {string} value
 * @returns {{nums: number[], pre: string[]} | null}
 */
function parseVersion(value) {
  const text = String(value ?? '').trim();
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text);
  if (!m) return null;
  const nums = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!nums.every((n) => Number.isSafeInteger(n))) return null;
  return { nums, pre: m[4] ? m[4].split('.') : [] };
}

/**
 * 比较两个语义化版本：a>b → 1，a<b → -1，相等 → 0，任一格式非法 → null。
 * 预发布规则按 semver：`0.8.2-beta.1 < 0.8.2`；两个预发布之间逐段比
 * （纯数字段按数值比、数字段 < 非数字段、其余按 ASCII）。
 * @param {string} a
 * @param {string} b
 * @returns {number | null}
 */
function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return null;
  for (let i = 0; i < 3; i += 1) {
    if (va.nums[i] !== vb.nums[i]) return va.nums[i] > vb.nums[i] ? 1 : -1;
  }
  if (!va.pre.length && !vb.pre.length) return 0;
  if (!va.pre.length) return 1; // 正式版 > 同号预发布
  if (!vb.pre.length) return -1;
  const len = Math.max(va.pre.length, vb.pre.length);
  for (let i = 0; i < len; i += 1) {
    const pa = va.pre[i];
    const pb = vb.pre[i];
    if (pa === undefined) return -1;
    if (pb === undefined) return 1;
    if (pa === pb) continue;
    const na = /^\d+$/.test(pa);
    const nb = /^\d+$/.test(pb);
    if (na && nb) return Number(pa) > Number(pb) ? 1 : -1;
    if (na) return -1; // 纯数字标识 < 非数字标识（semver 10.4）
    if (nb) return 1;
    return pa > pb ? 1 : -1;
  }
  return 0;
}

/**
 * feed 里的版本是否**比当前版本新**（语义化比较）。
 * 任一格式非法 → false（"认不出版本"绝不等于"有新版"，否则可能把未知串当成新版本去装）。
 * @param {string} candidate feed/清单里的版本
 * @param {string} current 本机当前版本（`app.getVersion()`）
 * @returns {boolean}
 */
export function isNewer(candidate, current) {
  const c = compareVersions(candidate, current);
  return c !== null && c > 0;
}

/**
 * 校验安装包字节的 sha512（清单里 `sha512:` 的 base64）。
 *
 * 注意：sha512 只防**传输损坏**；清单与包同源时，控制 feed 的一方可以同时改两者
 * （见 test/update-signing.js 的探针记录）。来源信任由调用方再叠 ed25519 验签——两者是
 * **与**关系：任一失败都不许安装。
 * @param {Buffer | Uint8Array | string | null | undefined} bytes 安装包原始字节
 * @param {string} expectedBase64 清单声明的 sha512（base64）
 * @returns {boolean}
 */
export function verifySha512Base64(bytes, expectedBase64) {
  const expected = String(expectedBase64 ?? '').trim();
  if (!expected) return false;
  /** @type {Buffer} */
  let data;
  if (Buffer.isBuffer(bytes)) data = bytes;
  else if (bytes instanceof Uint8Array) data = Buffer.from(bytes);
  else if (typeof bytes === 'string') data = Buffer.from(bytes, 'utf8');
  else return false;
  return crypto.createHash('sha512').update(data).digest('base64') === expected;
}

/**
 * 安装计划（纯数据，便于单测与日志；main.js 只负责 spawn）。
 *
 * 为什么是 `pkexec dpkg -i` 而不是 `apt`：
 *   · `pkexec` 是 polkit 的图形化提权入口，桌面会话里会弹系统密码框（用户预期内）；
 *   · `dpkg -i` 只装**本地** .deb，不联网；`apt install ./x.deb` 会解析依赖并拉网络，
 *     在刚校验完字节之后引入新的下载源，等于把"可信安装"变成"再信一次网络"。
 *   · Debian/Ubuntu/deepin 都自带 dpkg；pkexec 由 polkit 提供（未装 polkit 时退出码 127，
 *     调用方回落到 `sudo dpkg -i` 的可复制命令）。
 *
 * v0.9.2（用户实测：精简发行版没有 pkexec 时"卡在 spawn 错误里"）：`pkexecAvailable` 允许
 * 调用方**先探测**（`which pkexec`）再决定——没有 pkexec 时返回 `manual: true`，main.js
 * 直接弹"手动安装"对话框（路径 + `sudo dpkg -i` + 官网链接），不再 spawn 一个必然 ENOENT 的命令。
 * @param {{filePath?: string, pkexecAvailable?: boolean}} input
 * @returns {{cmd: 'pkexec', args: string[], fallbackHint: string, manual: boolean}}
 */
export function installPlan({ filePath, pkexecAvailable = true } = {}) {
  const p = typeof filePath === 'string' ? filePath.trim() : '';
  if (!p) throw new TypeError('installPlan 需要 filePath（已下载并通过校验的 .deb 路径）');
  return { cmd: 'pkexec', args: ['dpkg', '-i', p], fallbackHint: 'sudo dpkg -i ' + p, manual: pkexecAvailable === false };
}

/**
 * `.sig` 旁车文件的候选 URL（按顺序尝试）：feed 目录优先，安装包同目录兜底。
 * 线路选择后 base 跟着变（深圳镜像缺文件时由 main.js 再回退香港重试）。
 * @param {{sigName?: string, feedUrl?: string, updatesBase?: string}} input
 * @returns {string[]}
 */
export function sigUrlCandidates({ sigName = '', feedUrl = '', updatesBase = UPDATE_FEED_BASE } = {}) {
  const name = String(sigName ?? '').trim();
  /** @type {string[]} */
  const out = [];
  if (name) {
    const base = typeof updatesBase === 'string' && updatesBase.trim() ? updatesBase.trim() : UPDATE_FEED_BASE;
    out.push((base.endsWith('/') ? base : base + '/') + encodeURIComponent(name) + '.sig');
  }
  const url = String(feedUrl ?? '').trim();
  if (url) out.push(url + '.sig');
  return [...new Set(out)];
}

/**
 * 解析签名旁车文件（`.sig`）文本：取第一行非注释内容，去掉 `ed25519:` 前缀与所有空白。
 *
 * 我方 `.sig` 的两种既有写法都认（见 scripts/publish-update-sigs.mjs 与 update-verify.js）：
 *   `ed25519:<base64>` 或纯 `<base64>`。
 * 结果必须是解码后 **64 字节**（ed25519 签名恒为 64 字节）——长度不对视为不可用，返回 null。
 * @param {string} text
 * @returns {string | null} 规范化后的 base64；不可用返回 null
 */
export function parseSigFile(text) {
  if (typeof text !== 'string') return null;
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'));
  if (!line) return null;
  const value = line.replace(/^ed25519:/i, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const buf = Buffer.from(value, 'base64');
  if (buf.length !== 64) return null;
  return buf.toString('base64');
}
