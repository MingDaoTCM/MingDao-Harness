// v0.7.0 §1.5：从 server.js 切出，行为不变。
//
// WebUI 访问控制（P1-3 令牌 / P1-4 Host 白名单）的**纯函数层**：
// 只做判定，不读全局、不写 `res`、不碰 `process`。`server.js` 负责把判定结果接到
// `routes/api.js` 既有的 401/403 兜底上（那里是唯一写响应的地方，本模块不复制第二道闸门）。
//
// 判定口径与切分前逐字一致：
//   · 令牌来源优先级：`?token=` > `X-MingDao-Token` > `Authorization: Bearer …`（前者非空即胜出，
//     不再回退到后者——与旧 `requestToken()` 的短路顺序一致）；
//   · 令牌比对用 `crypto.timingSafeEqual`（长度不等直接 false，不抛）；
//   · 回环绑定且未配置令牌 = 本机信任（放行）；非回环绑定启动时**必然**已生成令牌
//     （见 `resolveWebToken`），因此"未配置令牌 + 非回环"在真实启动路径上不可达，这里按 fail-closed 拒绝；
//   · Host 白名单只放行回环名 + 绑定地址；绑定 `0.0.0.0` 且启用令牌时放行任意 Host
//     （此时令牌才是访问边界，攻击者页面拿不到）。
import crypto from 'node:crypto';

/** 回环主机名：绑定 Host 与请求 Host 共用同一份判定。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * 是否回环主机名（`127.0.0.1` / `localhost` / `::1`）。
 * @param {any} host
 * @returns {boolean}
 */
export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(String(host || ''));
}

/**
 * 启动期解析本次访问令牌（参数 > 配置 > 非回环时随机生成）。
 *
 * 与旧 `runWebServer` 内联逻辑逐字等价：`String(authToken || cfg?.web?.token || '').trim() || null`；
 * 非回环且无令牌时随机生成 16 字节十六进制串（`tokenGenerated=true`，重启即换）。
 * @param {{ authToken?: any, configToken?: any, host?: any }} [input]
 * @returns {{ token: string|null, generated: boolean, authEnabled: boolean }}
 */
export function resolveWebToken({ authToken = null, configToken = null, host = '127.0.0.1' } = {}) {
  const configured = String(authToken || configToken || '').trim() || null;
  if (configured) return { token: configured, generated: false, authEnabled: true };
  if (!isLoopbackHost(host)) {
    return { token: crypto.randomBytes(16).toString('hex'), generated: true, authEnabled: true };
  }
  return { token: null, generated: false, authEnabled: false };
}

/**
 * 取一个请求头（大小写不敏感）。
 *
 * Node 的 `req.headers` 已经小写化；这里自己再归一化一次，是为了让纯函数在**直接单测**
 * （手写普通对象、或 `Headers` 风格的大小写）时也与真实请求同口径。数组值取第一个（Node 的
 * `set-cookie` 才有数组，令牌头不会是数组，取第一个与字符串化一致）。
 * @param {any} headers
 * @param {string} name
 * @returns {string}
 */
function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (String(key).toLowerCase() !== wanted) continue;
    const v = /** @type {any} */ (headers)[key];
    if (v == null) return '';
    return String(Array.isArray(v) ? v[0] : v);
  }
  return '';
}

/**
 * 从请求里取候选令牌。**纯函数**：不改 `url`/`headers`。
 *
 * 顺序与旧 `requestToken()` 一致：查询串 > `X-MingDao-Token` > `Authorization: Bearer`。
 * 注意 `?token=`（空值）在旧实现里是 falsy → 继续看头；这里保留该行为。
 * @param {{ url?: any, headers?: any }} [input]
 * @returns {{ token: string|null, via: 'exchange'|'token'|'bearer'|null }}
 */
export function extractRequestToken({ url = null, headers = {} } = {}) {
  const q = url && typeof url.searchParams?.get === 'function' ? url.searchParams.get('token') : null;
  if (q) return { token: String(q), via: 'exchange' };
  const h = headerValue(headers, 'x-mingdao-token');
  if (h) return { token: h, via: 'token' };
  const m = headerValue(headers, 'authorization').match(/^Bearer\s+(.+)$/i);
  return m ? { token: m[1], via: 'bearer' } : { token: null, via: null };
}

/**
 * 令牌比对（定时安全）。语义与旧 `tokenMatches()` 相同：
 * `expected` 为空（未启用令牌）时**一律放行**；`got` 为空时拒绝。
 * @param {any} expected 已配置的令牌（`null`/`''` = 未启用）
 * @param {any} got 请求携带的令牌
 * @returns {boolean}
 */
export function tokenEquals(expected, got) {
  if (!expected) return true;
  if (!got) return false;
  const a = Buffer.from(String(got));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * 访问判定：把「令牌是否启用 / 是否回环 / 请求带了什么」收敛成**一个纯结果**。
 *
 * `via` 表示**放行所走的通道**（拒绝时恒为 `'none'`）：
 *   · `'exchange'` —— `?token=` 正确
 *   · `'token'`    —— `X-MingDao-Token` 正确
 *   · `'bearer'`   —— `Authorization: Bearer …` 正确
 *   · `'loopback'` —— 未启用令牌 + 回环绑定（本机信任）
 *   · `'none'`     —— 免令牌静态壳（`isExempt`）
 *
 * 返回对象**不含 `res`、不写任何全局**；调用方（`routes/api.js`）据 `decision` 决定 401/403。
 * @param {{ authToken?: any, url?: any, headers?: any, isLoopback?: boolean, isExempt?: boolean }} [input]
 * @returns {{ decision: 'ok'|'deny', via: 'exchange'|'token'|'bearer'|'loopback'|'none', reason: string }}
 */
export function resolveAuthDecision({ authToken = null, url = null, headers = {}, isLoopback = true, isExempt = false } = {}) {
  const expected = String(authToken ?? '').trim() || null;
  if (isExempt) return { decision: 'ok', via: 'none', reason: '静态壳资源免令牌（壳不含数据）' };
  if (!expected) {
    // 非回环 + 无令牌在真实启动路径不可达（resolveWebToken 会先生成）；纯函数按 fail-closed 处理。
    return isLoopback
      ? { decision: 'ok', via: 'loopback', reason: '未启用访问令牌（回环绑定，本机信任）' }
      : { decision: 'deny', via: 'none', reason: '未启用访问令牌且非回环绑定' };
  }
  const got = extractRequestToken({ url, headers });
  if (got.token && tokenEquals(expected, got.token)) return { decision: 'ok', via: got.via || 'none', reason: '令牌校验通过' };
  return {
    decision: 'deny',
    via: 'none',
    reason: got.token ? '访问令牌不匹配' : '缺少访问令牌（地址需带 ?token=…，或请求头携带 X-MingDao-Token）',
  };
}

/**
 * Host 白名单（P1-4，防 DNS rebinding）。逐字搬运旧 `trustedHost()`：
 * 只接受回环名 + 绑定地址（含实际端口；80 端口允许裸主机名）；
 * 绑定 `0.0.0.0` 且启用令牌时放行任意 Host。
 * @param {{ hostHeader?: any, bindHost?: any, boundPort?: any, authEnabled?: boolean }} [input]
 * @returns {boolean}
 */
export function isTrustedHost({ hostHeader = '', bindHost = '127.0.0.1', boundPort = 0, authEnabled = false } = {}) {
  const h = String(hostHeader || '').toLowerCase();
  const names = new Set(['127.0.0.1', 'localhost', '::1']);
  if (bindHost !== '0.0.0.0') names.add(String(bindHost).toLowerCase());
  const candidates = new Set();
  for (const n of names) {
    candidates.add(`${n.includes(':') && !n.startsWith('[') ? `[${n}]` : n}:${boundPort}`);
    if (boundPort === 80) candidates.add(n);
  }
  if (candidates.has(h)) return true;
  return bindHost === '0.0.0.0' && authEnabled;
}

/**
 * 启动横幅里与访问令牌有关的那几行（纯函数：只产出文案，打印由 `server.js` 做）。
 *
 * 为什么把它也切出来：这些文案就是"当前处于哪种访问控制模式"的用户可见说明，和判定同源才不会漂——
 * 例如"本机信任模式"只在**回环 + 无令牌**时出现，语义与 `resolveAuthDecision` 的 `loopback` 分支相同。
 * @param {{ authEnabled?: boolean, token?: string|null, generated?: boolean, host?: any,
 *           displayHost?: any, port?: any }} [input]
 * @returns {{ warn: boolean, text: string }[]}
 */
export function authStartupNotice({
  authEnabled = false,
  token = null,
  generated = false,
  host = '127.0.0.1',
  displayHost = host,
  port = 0,
} = {}) {
  /** @type {{ warn: boolean, text: string }[]} */
  const out = [];
  if (authEnabled) {
    out.push({ warn: false, text: `  访问令牌: http://${displayHost}:${port}/?token=${token}` });
    if (generated) {
      out.push({ warn: false, text: '  ⚠ 非回环绑定且未配置令牌：本次已随机生成（重启后更换）。' });
      out.push({ warn: false, text: '    固定令牌：mingdao web --auth-token <令牌>，或 config.json 的 web.token / 环境变量 MINGDAO_WEB_TOKEN。' });
    } else if (isLoopbackHost(host)) {
      out.push({ warn: false, text: '  ℹ 已启用访问令牌：地址需带 ?token=… 才能访问。' });
    }
  } else if (!isLoopbackHost(host)) {
    // 质检 L6：实际 trustedHost 白名单只放行回环 Host（远程浏览器带 LAN IP 的 Host 会 403），
    // 文案按真实行为修正——非浏览器客户端/伪造 Host 仍可达，务必启用令牌
    out.push({
      warn: true,
      text:
        '  ⚠ 警告：当前监听 ' +
        host +
        '（非本机回环）且未启用令牌，浏览器直接访问会被拒绝（Host 白名单），但非浏览器客户端仍可直连。强烈建议：mingdao web --auth-token <令牌>。',
    });
  } else {
    // v0.6.3（H-5）：回环 + 未配置令牌时**把"本机信任"这个决定说出来**。
    // 静默无认证的危险不在于它一定被利用，而在于用户不知道自己处在这个模式里：
    //   · 跨站浏览器请求（含 <img>/no-cors 盲打）已在 api.js 用 Sec-Fetch-Site 一律拒绝；
    //   · 但**同机的其它进程/其它用户**仍可直连 API（多用户机器、共享 CI runner 上尤其要注意）。
    // 一句话给出两个可选动作，而不是替用户决定（改默认会打断"浏览器直接打开 127.0.0.1"的日常用法）。
    out.push({ warn: false, text: '  ℹ 本机信任模式：未配置访问令牌，本机其它进程可直接访问 /api/*。' });
    out.push({ warn: false, text: '    多用户机器 / 共享 CI 上建议启用令牌：mingdao web --auth-token <令牌>，或 config.json 的 web.token。' });
  }
  return out;
}
