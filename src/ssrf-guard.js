// SSRF 判定 + DNS 钉扎的**单一来源**（v0.6.7，三份 v0.6.6 审计报告的共同结论）。
//
// 为什么单独成模块：三份报告都把「**同一规则多份实现**」指为本项目安全缺陷的唯一共性根因——
// fetch 工具与 safe-fetch 各写一份私网/DNS 判定，于是**最弱的那一份说了算**：
//   · fetch 工具的 catch 放行（fail-open）+ 不钉 IP（check/connect 两次解析 → DNS rebinding）
//     = 报告 1 的 C-1、报告 2 的 P2-2、报告 3 的 P1；
//   · 该判定还被 skill-lib / model-caps / web/server 复用，散落即漂移。
// 现在「这个主机能不能连」的判定只在这里：调用方只负责拿 `blocked` + `pinned` 去行动。
//
// 口径（三条都必须满足，任何一条不确定就 fail-closed）：
//   1) **字面量**私网/回环/元数据 → 拒（含 IPv6 全形态、IPv4-mapped、NAT64、URL 规范化后的十六进制形态）；
//   2) **域名**必须解析并逐个地址判定；解析失败 → 拒（不能把"这次解析失败"当安全判据）；
//   3) 校验通过的地址要**钉给连接层**（`pinned`），杜绝 check 与 connect 之间的二次解析。

/** IPv6 文本 → 8 组 16 位整数；无法解析返回 null（调用方按私有处理，fail-closed）。
 * @param {string} h @returns {number[]|null} */
export function ipv6ToGroups(h) {
  let s = String(h || '');
  // 尾部内嵌 IPv4（::ffff:127.0.0.1）先替换成两个十六进制组
  const m = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (m) {
    const nums = [m[2], m[3], m[4], m[5]].map(Number);
    if (nums.some((n) => n > 255)) return null;
    s = `${m[1]}${((nums[0] << 8) | nums[1]).toString(16)}:${((nums[2] << 8) | nums[3]).toString(16)}`;
  }
  const dbl = s.split('::');
  if (dbl.length > 2) return null;
  /** @param {string[]} arr */
  const hex = (arr) => arr.map((x) => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN));
  const left = hex(dbl.length === 2 ? dbl[0].split(':').filter(Boolean) : dbl[0].split(':'));
  const right = dbl.length === 2 ? hex(dbl[1].split(':').filter(Boolean)) : [];
  if (left.some(Number.isNaN) || right.some(Number.isNaN)) return null;
  if (dbl.length === 1) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...new Array(missing).fill(0), ...right];
}

/**
 * 私网 / 回环 / 保留 / 链路本地 判定（IPv4 + IPv6 全形态）。
 *
 * v0.6.7（报告 1 H-1、报告 2 硬化备注 H-1）：两处由 fail-open 改 **fail-closed**——
 *   ① 主机名含 `%`（IPv6 zone-id，如 `fe80::1%eth0`）：`dns.lookup` **接受**这种形态并原样返回，
 *      而我们的 `ipv6ToGroups` 解析不了它，此前落到「交给连接阶段报错」= 放行；
 *   ② 含 `:` 但解析不出 8 组：同上。
 * 两者都改为「按私有处理」。WHATWG URL 目前会直接拒绝 zone-id 形式（实测 `new URL('http://[fe80::1%25eth0]/')`
 * 抛 Invalid URL），所以这不是当前可利用的洞，而是**封死解析器行为变化**带来的缺口。
 * @param {string} hostname @returns {boolean}
 */
export function isPrivateHost(/** @type {string} */ hostname) {
  let h = String(hostname || '').toLowerCase();
  if (!h) return true;
  h = h.replace(/^\[|\]$/g, '');
  if (h.includes('%')) return true; // zone-id：无法安全判定 → 当私有（fail-closed）
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1') return true;
  if (h.includes(':')) {
    const g = ipv6ToGroups(h);
    if (!g) return true; // 解析不了：按私有处理（此前 return false = 放行）
    if (g.every((x) => x === 0)) return true; // ::
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
    // IPv4-mapped ::ffff:0:0/96 与 IPv4-compatible ::/96：按内嵌 IPv4 判定
    if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
      return isPrivateHost(`${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`);
    }
    if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
    if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 唯一本地
    if (g[0] === 0x0064 && g[1] === 0xff9b) {
      // 64:ff9b::/96 NAT64：内嵌 IPv4 同样按私网判定
      return isPrivateHost(`${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`);
    }
    return false;
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return true; // 非法点分：fail-closed
  return a === 10 || a === 127 || a === 0 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

// v0.6.3（P1-8）：**云元数据端点无条件拒绝**——它不属于"内网可信服务"那一类，
// 任何开关（web.allowPrivateEndpoints / allowPrivate）都不该放行：那里放的是实例凭据。
// 各家元数据的明文地址（AWS/GCP/Azure/Oracle 169.254.169.254、腾讯 169.254.0.23、
// 阿里 100.100.100.200、ECS 任务元数据 169.254.170.2、IPv6 fd00:ec2::254）与
// Google 的 DNS 名。放在这里而不是各调用点，是因为"单一来源"正是这条防线此前的失守方式。
const METADATA_HOSTS = new Set([
  '169.254.169.254',
  '169.254.0.23',
  '169.254.170.2',
  '100.100.100.200',
  'fd00:ec2::254',
  'metadata.google.internal',
  'metadata.goog',
]);
/** @param {string} hostname */
export function isMetadataHost(hostname) {
  const h = String(hostname || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return METADATA_HOSTS.has(h);
}

/** IP 字面量判定（含 IPv6 与方括号形态）：用于跳过 DNS 分支（字面量没有二次解析问题）。
 * @param {string} h */
export function isIpLiteral(h) {
  const s = String(h || '').replace(/^\[|\]$/g, '');
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(s) || s.includes(':');
}

/**
 * 判定一个主机名能否连接，并给出**钉扎地址**。
 *
 * @param {string} host 主机名或 IP 字面量（**不含**端口、不含方括号亦可）
 * @param {{ allowPrivate?: boolean, lookup?: any }} [opts] allowPrivate 仅用于"本地用户显式输入的地址"（CLI 安装、本机模型）；
 *   lookup 是**测试注入缝**（与 v0.6.6 给 withinRoot 加 `io` 同款理由）：只有把解析器换成桩，
 *   才能在离线环境里证明「判定用的是**解析后的地址**」「连接用的是**钉住的地址**」这两件事。
 *   注入解析器不会削弱防护——它返回的地址照样要过下面全部判定。
 * @returns {Promise<{ blocked: boolean, reason: string, pinned: string[]|null, kind: string }>}
 *   blocked=false 时 pinned 为已校验地址列表（字面量时为 null，不需要钉）；
 *   blocked=true 时 reason 是给用户看的理由（fail-closed 的那几条也在这里）。
 */
export async function resolveHostGuarded(host, opts = {}) {
  const allowPrivate = opts.allowPrivate === true;
  const h = String(host || '').toLowerCase();
  if (!h) return { blocked: true, reason: '主机名为空', pinned: null, kind: 'invalid' };
  // 元数据端点单独判：理由要说清"这一类无任何放行开关"
  if (isMetadataHost(h)) return { blocked: true, reason: `拒绝访问云元数据端点（${h}）——SSRF 防护，此地址无任何放行开关。`, pinned: null, kind: 'metadata' };
  if (!allowPrivate && isPrivateHost(h)) return { blocked: true, reason: `拒绝访问内网/本机地址（${h}）——SSRF 防护。`, pinned: null, kind: 'private' };
  if (isIpLiteral(h)) return { blocked: false, reason: '', pinned: null, kind: 'literal' };
  // 域名：必须解析成功（fail-closed），且解析出的每个地址都要过判定
  let addrs = [];
  try {
    const doLookup =
      typeof opts.lookup === 'function'
        ? opts.lookup
        : /** @type {any} */ (await import('node:dns/promises')).lookup;
    addrs = await doLookup(h, { all: true, verbatim: true });
  } catch {
    return {
      blocked: true,
      reason: `域名解析失败（${h}）——已按 fail-closed 拒绝本次请求（SSRF 防护不会因解析异常而放行）。`,
      pinned: null,
      kind: 'dns-error',
    };
  }
  const pinned = addrs.map((/** @type {any} */ a) => String(a.address));
  for (const a of pinned) {
    if (isMetadataHost(a)) return { blocked: true, reason: `拒绝访问云元数据端点（${h} → ${a}）——SSRF 防护。`, pinned: null, kind: 'metadata' };
    if (!allowPrivate && isPrivateHost(a)) return { blocked: true, reason: `拒绝访问内网/本机地址（${h} → ${a}）——SSRF 防护。`, pinned: null, kind: 'private' };
  }
  if (!pinned.length) {
    return { blocked: true, reason: `域名解析结果为空（${h}）——已按 fail-closed 拒绝。`, pinned: null, kind: 'dns-empty' };
  }
  return { blocked: false, reason: '', pinned, kind: 'dns' };
}
