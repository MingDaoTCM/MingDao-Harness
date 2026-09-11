// HTTP 只读抓取工具（v0.3.1）：GET 任意 http(s) URL，返回文本（512KB 上限，正文截 20K）。
// SSRF 防护：字面量私网/回环拒绝 + DNS 解析复检（防域名重绑定），口径与 server.js validateRemoteUrl 一致。
import { lookup } from 'node:dns/promises';

// —— IPv6 解析（v0.4.6 P1 修复）——
// 此前只把 `::ffff:` + 点分四段（::ffff:127.0.0.1）当 IPv4-mapped 处理，而 **WHATWG URL 解析器
// 会把该形态规范化成十六进制**（new URL('http://[::ffff:127.0.0.1]:9/').hostname === '[::ffff:7f00:1]'），
// 于是 `[::ffff:7f00:1]` / `[0:0:0:0:0:ffff:7f00:1]` / `[::ffff:a9fe:a9fe]`（云元数据）全部判为公网；
// 后续 DNS 复检又对带方括号的 IPv6 字面量 lookup 失败 → catch 放行。fetch 属只读免确认工具，
// 等于可以抓本机 WebUI(3820，回环无令牌)/内网服务/云元数据。
// 现按数值展开 8 组再判定（含内嵌 IPv4、NAT64）。
/** @param {string} h @returns {number[]|null} */
function ipv6ToGroups(h) {
  let s = h;
  // 尾部内嵌 IPv4（::ffff:127.0.0.1）先替换成两个十六进制组
  const m = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (m) {
    const nums = [m[2], m[3], m[4], m[5]].map(Number);
    if (nums.some((n) => n > 255)) return null;
    s = `${m[1]}${((nums[0] << 8) | nums[1]).toString(16)}:${((nums[2] << 8) | nums[3]).toString(16)}`;
  }
  const dbl = s.split('::');
  if (dbl.length > 2) return null;
  const hex = (/** @type {string[]} */ arr) => arr.map((x) => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN));
  const left = hex(dbl.length === 2 ? dbl[0].split(':').filter(Boolean) : dbl[0].split(':'));
  const right = dbl.length === 2 ? hex(dbl[1].split(':').filter(Boolean)) : [];
  if (left.some(Number.isNaN) || right.some(Number.isNaN)) return null;
  if (dbl.length === 1) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...new Array(missing).fill(0), ...right];
}

// 审计 4.1（v0.4.2）：isPrivateHost 导出复用——skill-lib.installFromUrl 等外联入口共用同一判定，
// 避免「漏一处」的 SSRF 防护缺口（此前 fetch 工具与 server.validateRemoteUrl 各自维护一份）。
export function isPrivateHost(/** @type {string} */ hostname) {
  let h = String(hostname || '').toLowerCase();
  if (!h) return true;
  h = h.replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1') return true;
  if (h.includes(':')) {
    const g = ipv6ToGroups(h);
    if (!g) return false; // 无法解析：交给连接阶段报错
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
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 10 || a === 127 || a === 0 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

// IP 字面量判定（含 IPv6）：用于跳过 DNS 复检分支（此前只认点分 IPv4，导致带方括号的 IPv6
// 字面量被送进 lookup 失败后「放行」）。
/** @param {string} h */
function isIpLiteral(h) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':');
}

export async function runFetch(/** @type {any} */ args, /** @type {any} */ _ctx) {
  const raw = String(args.url ?? '').trim();
  if (!raw) return { ok: false, error: '缺少 url 参数。' };
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: 'url 必须是合法的 http(s) URL。' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: '仅支持 http/https 地址。' };
  const host = String(u.hostname || '').toLowerCase();
  let blocked = isPrivateHost(host);
  if (!blocked && host && host !== 'localhost' && !isIpLiteral(host)) {
    try {
      const addrs = await lookup(host, { all: true, verbatim: true });
      blocked = addrs.some((/** @type {any} */ a) => isPrivateHost(a.address));
    } catch {
      // DNS 解析失败：放行，连接阶段会报错
    }
  }
  if (blocked) return { ok: false, error: `拒绝访问内网/本机地址（${host}）——SSRF 防护。` };
  // 302 重定向复检（P0 安全，v0.4.1）：redirect:'follow' 只检查初始 URL，攻击者可用公网 302 跳回内网。
  // 改 redirect:'manual' 手动跟随，每一跳重新 isPrivateHost + DNS 复检，跳数上限 5。
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  try {
    let cur = u;
    let res = /** @type {any} */ (null);
    for (let hop = 0; hop <= 5; hop++) {
      const ch = String(cur.hostname || '').toLowerCase();
      let hopBlocked = isPrivateHost(ch);
      if (!hopBlocked && ch && ch !== 'localhost' && !isIpLiteral(ch)) {
        try {
          const addrs = await lookup(ch, { all: true, verbatim: true });
          hopBlocked = addrs.some((/** @type {any} */ a) => isPrivateHost(a.address));
        } catch {
          // DNS 解析失败：放行，连接阶段会报错
        }
      }
      if (hopBlocked) return { ok: false, error: `拒绝访问内网/本机地址（${ch}）——SSRF 重定向防护。` };
      res = await fetch(cur, { signal: ac.signal, redirect: 'manual' });
      if (res.status >= 300 && res.status < 400) {
        // P2-3（v0.4.5）：原 `if(hop>5)` 死代码（hop 最大 5 永不触发）——超限应在 3xx 分支内判定
        if (hop >= 5) return { ok: false, error: '重定向次数超过上限（5 跳）。' };
        const loc = res.headers.get('location');
        if (!loc) break; // 无 Location：按最终响应处理
        try {
          cur = new URL(loc, cur);
        } catch {
          return { ok: false, error: `非法重定向地址：${loc}` };
        }
        if (cur.protocol !== 'http:' && cur.protocol !== 'https:') {
          return { ok: false, error: '重定向到非 http(s) 地址，已拒绝。' };
        }
        continue;
      }
      break;
    }
    // P2 修复（v0.4.6）：上限必须在**读取过程中**生效，而不是整包下载后再判。
    // 此前 `await res.arrayBuffer()` 会把响应完整缓冲进内存，之后才比对 512KB ——实测服务端
    // 写满 30MB 客户端才报错（15s abort 只限时不限字节，高速端点可在 15s 内灌入数百 MB → OOM）。
    // 先看 content-length 快速拒绝，再边读边累计，超限立即 cancel 释放连接。
    const MAX_BYTES = 512 * 1024;
    const declared = Number(res.headers.get('content-length') || 0);
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      try { await res.body?.cancel(); } catch {}
      clearTimeout(timer);
      return { ok: false, error: `响应超过 512KB 上限（Content-Length 声明 ${declared} 字节）。` };
    }
    let buf;
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      let over = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value?.byteLength || 0;
        if (total > MAX_BYTES) {
          over = true;
          try { await reader.cancel(); } catch {}
          break;
        }
        if (value) chunks.push(value);
      }
      if (over) {
        clearTimeout(timer);
        return { ok: false, error: `响应超过 512KB 上限（已读取 ${total} 字节后中止）。` };
      }
      buf = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
    } else {
      buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > MAX_BYTES) {
        clearTimeout(timer);
        return { ok: false, error: `响应超过 512KB 上限（实际 ${buf.byteLength} 字节）。` };
      }
    }
    clearTimeout(timer);
    const text = new TextDecoder('utf-8').decode(buf);
    const truncated = text.length > 20000;
    return { ok: true, status: res.status, contentType: res.headers.get('content-type') || '', output: (truncated ? text.slice(0, 20000) + '\n…[正文过长已截断，共 ' + text.length + ' 字符]' : text) || '（空响应）' };
  } catch (/** @type {any} */ err) {
    clearTimeout(timer);
    return { ok: false, error: '抓取失败：' + (err?.name === 'AbortError' ? '超时（15s）' : String(err?.message || err)) };
  }
}
