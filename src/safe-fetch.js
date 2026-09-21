// 带**逐跳 SSRF 复检**的文本下载——单一来源。
//
// 为什么要有这个模块（v0.6.2，第三方代码审计 P2-7）：
// 同一件事此前有**两份口径**——`skill-lib.js` 做了完整的逐跳复检
// （`redirect:'manual'` + 每跳 `isPrivateHost` + DNS 复检 + 跳数上限），
// 而 `skill-registry.js` 只写了 `fetch(url, { redirect: 'follow' })` 一把梭。
// 后者会自动跟随重定向且**每一跳都不复检**，于是「线上技能库索引 / 技能文件」这条路径
// 可以被重定向到内网（云元数据 169.254.169.254、内网服务、本机端口）。
// 同一个安全判定有两套口径，等于**最弱的那一套说了算**。
//
// 现在两处都走这里。新增下载路径也必须走这里——不要再写第二份。
import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isPrivateHost, isMetadataHost } from './tools/fetch.js';

/**
 * 发一次 GET 并返回一个最小响应对象（status / headers / _res）。
 *
 * 为什么不用 `fetch`（审计 BUG-057）：`fetch` 不接受自定义 `lookup`，而本模块的安全模型要求
 * 「**校验过的那个 IP** 与**实际连接的 IP** 是同一个」。用 fetch 时 check 阶段 `lookup()` 解析一次、
 * 连接阶段 undici 再解析一次——两次独立解析之间，恶意权威 DNS 可以改答案（DNS rebinding），
 * 于是「校验通过」的域名连到了内网/云元数据端点。`node:http(s).request` 的 `lookup` 选项
 * 正好能把这个洞钉死，且不引入任何依赖（本项目零运行时依赖）。
 * @param {any} url @param {{ signal: any, headers: any, pinnedAddrs: string[]|null }} o
 */
function httpRequestOnce(url, { signal, headers, pinnedAddrs }) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    /** @type {any} */
    const options = { method: 'GET', signal };
    if (headers) options.headers = headers;
    if (pinnedAddrs && pinnedAddrs.length) {
      // 连接阶段只允许连到这几个**已校验过**的地址（可按 opts.all 返回全部，交给内核挑）
      options.lookup = (/** @type {any} */ host, /** @type {any} */ o, /** @type {any} */ cb) => {
        const fam = (/** @type {string} */ a) => (a.includes(':') ? 6 : 4);
        if (o && o.all) cb(null, pinnedAddrs.map((a) => ({ address: a, family: fam(a) })));
        else cb(null, pinnedAddrs[0], fam(pinnedAddrs[0]));
      };
    }
    const req = mod.request(url, options, (/** @type {any} */ r) => {
      resolve({ status: r.statusCode || 0, headers: r.headers || {}, _res: r });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * 带上限地读响应体（与 batch 的同名助手同源）：先看声明长度，再边读边累计。
 * @param {any} res @param {number} maxBytes @returns {Promise<string|null>}
 */
function readBodyCapped(res, maxBytes) {
  return new Promise((resolve, reject) => {
    let n = 0;
    /** @type {any[]} */
    const chunks = [];
    res.on('data', (/** @type {any} */ d) => {
      n += d.length;
      if (n > maxBytes) {
        try {
          res.destroy();
        } catch {}
        resolve(null);
        return;
      }
      chunks.push(d);
    });
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });
}

/**
 * 下载文本，逐跳做私网/回环判定（含 DNS 复检，防域名重绑定）。
 *
 * @param {any} url 目标 URL（字符串或 URL）
 * @param {{ timeoutMs?: number, maxBytes?: number, allowPrivate?: boolean, headers?: any, maxHops?: number }} [opts]
 *   allowPrivate：**仅**用于「本地用户显式输入 URL」的场景（如 CLI `mingdao skill install <url>`），
 *   表示用户自担意图、允许内网地址；WebUI / registry 等自动路径必须保持 false。
 * @returns {Promise<{text?: string, error?: string}>} 成功给 text，失败给 error（不抛异常，便于调用方统一处理）
 */
export async function safeFetchText(/** @type {any} */ url, opts = {}) {
  const { timeoutMs = 20000, maxBytes = 2 * 1024 * 1024, allowPrivate = false, headers = null, maxHops = 5 } = opts;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let cur;
    try {
      cur = url instanceof URL ? url : new URL(String(url));
    } catch {
      return { error: 'URL 无效' };
    }
    let res = /** @type {any} */ (null);
    for (let hop = 0; hop <= maxHops; hop += 1) {
      // 每一跳都要判定：初始地址与**每一个**重定向目标
      const ch = String(cur.hostname || '').toLowerCase();
      // v0.6.3（P1-8）：云元数据端点**无条件**拒绝——allowPrivate 是给"用户自己输入的内网地址"用的，
      // 而元数据端点放的是实例凭据，不该被任何开关放行。单独判一次是为了给出**准确的理由**
      // （否则它会先命中"内网地址"那条，用户看不出这是元数据这一特殊类别）。
      if (isMetadataHost(ch)) return { error: `拒绝访问云元数据端点（${ch}）——SSRF 防护，此地址无任何放行开关。` };
      let blocked = !allowPrivate && isPrivateHost(ch);
      /** @type {string[]|null} */
      let pinned = null;
      const ipLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(ch) || ch.includes(':');
      if (!blocked && ch && ch !== 'localhost' && !ipLiteral) {
        try {
          const addrs = await lookup(ch, { all: true, verbatim: true });
          blocked =
            addrs.some((/** @type {any} */ a) => isMetadataHost(a.address)) ||
            (!allowPrivate && addrs.some((/** @type {any} */ a) => isPrivateHost(a.address)));
          // 审计 BUG-057（第一半）：把这**一次**校验过的地址钉给连接层，杜绝"check 与 connect
          // 两次解析不一致"（DNS rebinding）——元数据端点/内网也因此不可能被第二次解析绕进来。
          pinned = addrs.map((/** @type {any} */ a) => String(a.address));
        } catch {
          // 审计 BUG-057（第二半）：解析失败**不能放行**。放行等于把"这次能不能解析"当成安全判据，
          // 而"让校验阶段解析失败、连接阶段再成功"恰恰是攻击者的手段。fail-closed。
          return { error: `域名解析失败（${ch}）——已按 fail-closed 拒绝本次请求（SSRF 防护不会因解析异常而放行）。` };
        }
      }
      if (blocked) return { error: `拒绝访问内网/本机地址（${ch}）——SSRF 防护。` };
      res = await httpRequestOnce(cur, { signal: ctrl.signal, headers, pinnedAddrs: pinned });
      if (res.status >= 300 && res.status < 400) {
        if (hop >= maxHops) return { error: `重定向次数超过上限（${maxHops} 跳）。` };
        const loc = res.headers['location'];
        if (!loc) break;
        try {
          cur = new URL(loc, cur);
        } catch {
          return { error: `非法重定向地址：${loc}` };
        }
        if (cur.protocol !== 'http:' && cur.protocol !== 'https:') {
          return { error: '重定向到非 http(s) 地址，已拒绝。' };
        }
        continue;
      }
      break;
    }
    if (!res) return { error: '下载失败：无响应' };
    if (res.status < 200 || res.status >= 300) return { error: `下载失败：HTTP ${res.status}` };
    // Content-Length 预检：超限直接拒绝，不再全量下载进内存
    const len = Number(res.headers['content-length']);
    if (Number.isFinite(len) && len > maxBytes) {
      try {
        res._res?.destroy();
      } catch {}
      return { error: '响应超过大小上限' };
    }
    const text = await readBodyCapped(res._res, maxBytes); // 边读边累计（不再先整份进内存）
    if (text == null) return { error: '响应超过大小上限' };
    return { text };
  } catch (/** @type {any} */ e) {
    return { error: e?.name === 'AbortError' ? `下载超时（${Math.round(timeoutMs / 1000)} 秒）` : String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}
