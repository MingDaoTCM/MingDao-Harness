// HTTP 只读抓取工具（v0.3.1）：GET 任意 http(s) URL，返回文本（512KB 上限，正文截 20K）。
// SSRF 防护：字面量私网/回环拒绝 + DNS 解析复检（防域名重绑定），口径与 server.js validateRemoteUrl 一致。
import { lookup } from 'node:dns/promises';

function isPrivateHost(/** @type {string} */ hostname) {
  let h = String(hostname || '').toLowerCase();
  if (!h) return true;
  h = h.replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  if (h.includes(':')) {
    if (/^::ffff:/.test(h)) return isPrivateHost(h.slice(7));
    return /^fe[89ab]/.test(h) || /^f[c d]/.test(h) || h === '::' || h === '::1';
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
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  try {
    const res = await fetch(u, { signal: ac.signal, redirect: 'follow' });
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
