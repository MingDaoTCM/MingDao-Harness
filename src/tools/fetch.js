// HTTP 只读抓取工具（v0.3.1）：GET 任意 http(s) URL，返回文本（512KB 上限，正文截 20K）。
// SSRF 防护：字面量私网/回环拒绝 + DNS 解析复检（防域名重绑定），口径与 server.js validateRemoteUrl 一致。
import { lookup } from 'node:dns/promises';

// 审计 4.1（v0.4.2）：isPrivateHost 导出复用——skill-lib.installFromUrl 等外联入口共用同一判定，
// 避免「漏一处」的 SSRF 防护缺口（此前 fetch 工具与 server.validateRemoteUrl 各自维护一份）。
export function isPrivateHost(/** @type {string} */ hostname) {
  let h = String(hostname || '').toLowerCase();
  if (!h) return true;
  h = h.replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  if (h.includes(':')) {
    if (/^::ffff:/.test(h)) return isPrivateHost(h.slice(7));
    return /^fe[89ab]/.test(h) || /^f[cd]/.test(h) || h === '::' || h === '::1';
  }
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 10 || a === 127 || a === 0 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
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
  if (!blocked && host && host !== 'localhost' && !/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
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
      if (hop > 5) return { ok: false, error: '重定向次数超过上限（5 跳）。' };
      const ch = String(cur.hostname || '').toLowerCase();
      let hopBlocked = isPrivateHost(ch);
      if (!hopBlocked && ch && ch !== 'localhost' && !/^\d{1,3}(\.\d{1,3}){3}$/.test(ch)) {
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
    const buf = await res.arrayBuffer();
    clearTimeout(timer);
    if (buf.byteLength > 512 * 1024) return { ok: false, error: `响应超过 512KB 上限（实际 ${buf.byteLength} 字节）。` };
    const text = new TextDecoder('utf-8').decode(buf);
    const truncated = text.length > 20000;
    return { ok: true, status: res.status, contentType: res.headers.get('content-type') || '', output: (truncated ? text.slice(0, 20000) + '\n…[正文过长已截断，共 ' + text.length + ' 字符]' : text) || '（空响应）' };
  } catch (/** @type {any} */ err) {
    clearTimeout(timer);
    return { ok: false, error: '抓取失败：' + (err?.name === 'AbortError' ? '超时（15s）' : String(err?.message || err)) };
  }
}
