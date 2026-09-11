// 出网白名单策略（v0.6.0 阶段 C3）：纯函数，不碰 IO、不改全局状态，便于单测与文档化。
//
// 目的：让「数据不出门」这句话可以被**自证**——本机这段时间访问了哪些外部地址、
// 命中哪条白名单、有没有被拦，而不是靠部署方口头承诺。
//
// 一条必须说清楚的边界（写在代码里，也要写进 README）：
//   本闸门只覆盖**内核自己发起**的请求（模型 API、fetch 工具、技能库、同步、模型发现…）。
//   用户在 bash 里自己敲 `curl` 不走这里——那是子进程的网络栈。
//   因此它证明的是「内核没有偷偷外传」，**不是**「这台机器绝对没有外传」。
//   把它当后者用就是误用。

/** 白名单条目支持的形态：精确主机、通配子域（*.example.com）、IPv4 CIDR、精确 IP */
const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const CIDR4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

/** @param {any} s */
function ip4ToInt(s) {
  const m = V4.exec(String(s).trim());
  if (!m) return null;
  const parts = [m[1], m[2], m[3], m[4]].map(Number);
  if (parts.some((n) => n > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/** 回环地址不算「出网」：它出不了这台机器，把它算成外发只会制造噪音与误判 */
export function isLoopback(/** @type {any} */ host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  const ip = V4.test(h) ? h : h.startsWith('::ffff:') ? h.slice(7) : null;
  if (!ip) return false;
  const n = ip4ToInt(ip);
  return n !== null && (n >>> 24) === 127;
}

/**
 * 单条规则是否匹配主机。大小写不敏感（DNS 不区分大小写，而白名单写起来经常随手打）。
 * @param {any} host
 * @param {any} rule
 */
export function matchRule(/** @type {any} */ host, /** @type {any} */ rule) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  const r = String(rule || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || !r) return false;
  // IPv4 CIDR
  const c = CIDR4.exec(r);
  if (c) {
    const base = ip4ToInt(`${c[1]}.${c[2]}.${c[3]}.${c[4]}`);
    const bits = Number(c[5]);
    const ip = ip4ToInt(h);
    if (base === null || ip === null || !(bits >= 0 && bits <= 32)) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ip & mask) === (base & mask);
  }
  // 通配子域：*.example.com 匹配 a.example.com 与 a.b.example.com，**不**匹配 example.com 本身
  // （不隐式包含裸域：把「只允许某子域」写成通配却顺带放开了主域，是常见的越权放行）
  if (r.startsWith('*.')) {
    const suffix = r.slice(2);
    return h.endsWith('.' + suffix);
  }
  return h === r;
}

/**
 * 解析配置。未配置 → enabled:false（闸门不安装，既有行为零影响）。
 * @param {any} raw cfg.net
 * @returns {{enabled: boolean, mode: 'warn'|'block', allow: string[], allowLoopback: boolean}}
 */
export function parseNetPolicy(/** @type {any} */ raw) {
  if (!raw || typeof raw !== 'object') return { enabled: false, mode: 'warn', allow: [], allowLoopback: true };
  const allow = Array.isArray(raw.allow) ? raw.allow.filter((/** @type {any} */ x) => typeof x === 'string' && x.trim()).map((/** @type {any} */ x) => x.trim()) : [];
  const mode = raw.mode === 'block' ? 'block' : 'warn';
  return { enabled: true, mode, allow, allowLoopback: raw.allowLoopback !== false };
}

/**
 * 判定一次出网。
 * @param {any} policy parseNetPolicy 的结果
 * @param {any} url 目标 URL（字符串或 URL）
 * @returns {{allowed: boolean, host: string, port: string, rule: string|null, kind: string, reason: string}}
 */
export function checkEgress(/** @type {any} */ policy, /** @type {any} */ url) {
  let host = '';
  let port = '';
  try {
    const u = url instanceof URL ? url : new URL(String(url));
    host = u.hostname;
    port = u.port || (u.protocol === 'https:' ? '443' : u.protocol === 'http:' ? '80' : '');
  } catch {
    return { allowed: false, host: '', port: '', rule: null, kind: 'invalid-url', reason: 'URL 无法解析' };
  }
  if (!policy?.enabled) return { allowed: true, host, port, rule: null, kind: 'disabled', reason: '未配置出网策略' };
  if (isLoopback(host) && policy.allowLoopback !== false) {
    return { allowed: true, host, port, rule: null, kind: 'loopback', reason: '回环地址（出不了本机，不计为外发）' };
  }
  const rule = (policy.allow || []).find((/** @type {any} */ r) => matchRule(host, r));
  if (rule) return { allowed: true, host, port, rule, kind: 'allowlist', reason: `命中白名单 ${rule}` };
  return { allowed: false, host, port, rule: null, kind: 'not-listed', reason: '不在出网白名单内' };
}
