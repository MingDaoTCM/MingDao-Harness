// 更新线路选择（香港 / 深圳）的**纯函数**层（v0.9.2）。
//
// 为什么需要它：v0.9.1 及以前，deb feed、安装包下载、`.sig`、electron-updater 的 feed
// 全部固定走香港源站 `harness.mingdao.ai`——对华南用户这是跨海链路，实测下载只有
// 几十~几百 KB/s。深圳镜像 `harness.southdns.com` 提供**同样的** `/updates/*` 与
// `/downloads/*`（同一批对象），但"哪个更快"随时段/运营商变化，不能写死。
//
// 所以：启动时对两个候选各发一个**极小 GET**（`/updates/latest.yml`，墙钟 3s 超时），
// 比「time to first byte」，选最快的；结果缓存 24h 到 `userData/endpoint.json`，
// 避免每次检查更新都多花一次探测。排障用 `MINGDAO_UPDATE_BASE` 可强制指定（不探测、不写缓存）。
//
// 设计边界（为什么本文件**零 import**）：
//   · 所有网络 I/O 通过调用方注入的 `probe(url, {timeoutMs})` 完成——单测里注入假 probe
//     就能逐条钉候选/排序/缓存/回退，**零网络**、不需要 electron（见 test/desktop-endpoint.js）；
//   · 不 import `node:https` / `electron` / `node:path`（路径由 main.js 拼），所以本模块
//     可以被任何环境加载，也不会把"能否联网"变成加载期副作用。
//
// 诚实边界：探测只测「到达源站第一字节」的快慢，不测大文件持续吞吐（后者要真下一段字节，
// 对用户流量不友好）；真实的 42 分钟 vs 2 分钟差异来自跨海上行/中继限速，TTFB 能区分
// "通/不通/明显绕路"，但分不出"两个都通且都很快"时的细微差别——那种情况选谁都行。

/** 候选线路：`/updates/*` 与 `/downloads/*` 两边都必须提供（见文件头）。 */
export const ENDPOINT_CANDIDATES = Object.freeze([
  Object.freeze({ id: 'hk', label: '香港', base: 'https://harness.mingdao.ai' }),
  Object.freeze({ id: 'sz', label: '深圳', base: 'https://harness.southdns.com' }),
]);

/** 全部探测失败时的回退线路（也是默认线路）。 */
export const DEFAULT_ENDPOINT_ID = 'hk';
export const DEFAULT_ENDPOINT = ENDPOINT_CANDIDATES[0];

/** 强制指定线路的环境变量（排障用；优先级最高）。 */
export const UPDATE_BASE_ENV = 'MINGDAO_UPDATE_BASE';

/** 探测用的小文件：所有平台都有的 feed 清单（387 字节量级）。 */
export const PROBE_PATH = '/updates/latest.yml';

/** 探测超时（墙钟；第一字节都拿不到就判这条线不可用）。 */
export const PROBE_TIMEOUT_MS = 3000;

/** 线路选择结果缓存有效期：24h。 */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** 缓存文件名（放在 `app.getPath('userData')` 下，main.js 负责拼路径）。 */
export const CACHE_FILE = 'endpoint.json';

/** 缓存结构版本（结构变了就作废旧缓存，而不是"尽力解读"）。 */
export const CACHE_VERSION = 1;

/**
 * 规范化 base：去空白、去尾斜杠（允许连写多个）、拒绝非 http(s)/带 query/hash 的输入。
 * 非法输入返回 `''`（调用方据此回退默认线路，绝不拼出相对 URL）。
 * @param {unknown} input
 * @returns {string} 形如 `https://host[/path]`；非法 → `''`
 */
export function normalizeBase(input) {
  const text = typeof input === 'string' ? input.trim() : '';
  if (!text) return '';
  /** @type {URL} */
  let url;
  try {
    url = new URL(text);
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
  if (!url.hostname) return '';
  if (url.search || url.hash) return '';
  const pathname = url.pathname.replace(/\/+$/, '');
  return url.origin + pathname;
}

/**
 * 拼路径：`joinPath('https://h', '/updates/')` → `https://h/updates/`；
 * `joinPath('https://h/', 'updates')` → `https://h/updates`。
 * base 非法 → `''`（宁可让调用方报错，也不拼出 `/updates/...` 这种相对地址）。
 * @param {unknown} base
 * @param {unknown} relPath
 * @returns {string}
 */
export function joinPath(base, relPath) {
  const b = normalizeBase(base);
  if (!b) return '';
  const rel = String(relPath ?? '').replace(/^\/+/, '');
  return rel ? b + '/' + rel : b + '/';
}

/**
 * feed 目录（electron-updater 的 `setFeedURL` 与 deb 清单都读这里）。
 * @param {unknown} base
 * @returns {string} 形如 `https://host/updates/`；base 非法 → `''`
 */
export function updatesBase(base) {
  const b = normalizeBase(base);
  return b ? b + '/updates/' : '';
}

/**
 * 安装包目录（deb 安装包与 `.sig` 的兜底位置）。
 * @param {unknown} base
 * @returns {string} 形如 `https://host/downloads/`；base 非法 → `''`
 */
export function downloadsBase(base) {
  const b = normalizeBase(base);
  return b ? b + '/downloads/' : '';
}

/**
 * 探测目标 URL（极小 GET）。
 * @param {unknown} base
 * @returns {string}
 */
export function probeTarget(base) {
  return joinPath(base, PROBE_PATH);
}

/**
 * "去官网下载"页面地址 **按选中线路** 给出（深圳镜像同时托管站点首页，2026-11 实测 200）。
 * base 非法 → 官方香港站点（保证按钮永远可用）。
 * @param {unknown} base
 * @returns {string}
 */
export function downloadPageUrl(base) {
  const b = normalizeBase(base);
  return (b || DEFAULT_ENDPOINT.base) + '/#downloads';
}

/**
 * 按 id 或 base 找候选线路。
 * @param {unknown} idOrBase
 * @param {ReadonlyArray<{id: string, base: string}>} [candidates]
 * @returns {{id: string, label?: string, base: string} | null}
 */
export function endpointOf(idOrBase, candidates = ENDPOINT_CANDIDATES) {
  const text = typeof idOrBase === 'string' ? idOrBase.trim() : '';
  if (!text) return null;
  const byId = candidates.find((c) => c.id === text);
  if (byId) return byId;
  const normalized = normalizeBase(text);
  if (!normalized) return null;
  return candidates.find((c) => normalizeBase(c.base) === normalized) ?? null;
}

/**
 * 探测所有候选（**并发**；单条失败不影响其它条）。
 *
 * `probe` 是注入的：`(url, {timeoutMs}) => Promise<{ms: number, status?: number}>`，
 * `ms` 必须是「time to first byte」。main.js 注入真实 https 实现，单测注入假实现。
 * @param {{candidates?: ReadonlyArray<{id: string, base: string}>, probe: (url: string, opts: {timeoutMs: number}) => Promise<{ms: number, status?: number}>, timeoutMs?: number}} input
 * @returns {Promise<Array<{id: string, base: string, ok: boolean, ms: number | null, status?: number, reason?: string}>>}
 */
export async function probeCandidates({ candidates = ENDPOINT_CANDIDATES, probe, timeoutMs = PROBE_TIMEOUT_MS } = /** @type {any} */ ({})) {
  if (typeof probe !== 'function') throw new TypeError('probeCandidates 需要注入 probe(url, {timeoutMs})');
  return Promise.all(
    candidates.map(async (c) => {
      try {
        const result = await probe(probeTarget(c.base), { timeoutMs });
        const ms = Number(result?.ms);
        if (!Number.isFinite(ms) || ms < 0) {
          return { id: c.id, base: normalizeBase(c.base) || c.base, ok: false, ms: null, reason: '探测结果缺少有效耗时（ms）' };
        }
        return { id: c.id, base: normalizeBase(c.base) || c.base, ok: true, ms, status: Number(result?.status) || 200 };
      } catch (err) {
        return {
          id: c.id,
          base: normalizeBase(c.base) || c.base,
          ok: false,
          ms: null,
          reason: String((/** @type {any} */ (err))?.message || err),
        };
      }
    })
  );
}

/**
 * 排序探测结果：**只留成功且有有效耗时的**，按耗时升序；耗时相同按候选声明顺序（稳定）。
 * 平台差异（`Array#sort` 在 Node 上稳定）不作为判据，所以比较器里显式带候选序号。
 * @param {Array<{id: string, ms?: number | null, ok?: boolean}>} results
 * @param {{candidates?: ReadonlyArray<{id: string}>}} [opts]
 * @returns {Array<{id: string, ms: number, ok: boolean}>}
 */
export function rankProbes(results, { candidates = ENDPOINT_CANDIDATES } = {}) {
  /** @type {Map<string, number>} */
  const order = new Map(candidates.map((c, i) => [c.id, i]));
  /**
   * @param {{id: string, ms?: number | null, ok?: boolean}} r
   * @returns {number}
   */
  const of = (r) => (order.has(r.id) ? Number(order.get(r.id)) : candidates.length);
  return (Array.isArray(results) ? results : [])
    .filter((r) => r && r.ok === true && Number.isFinite(Number(r.ms)) && Number(r.ms) >= 0)
    .sort((a, b) => Number(a.ms) - Number(b.ms) || of(a) - of(b));
}

/**
 * 选最快的一条；没有可用结果 → `null`（调用方据此回退香港）。
 * @param {Array<{id: string, base: string, ok?: boolean, ms?: number | null}>} results
 * @param {{candidates?: ReadonlyArray<{id: string}>}} [opts]
 * @returns {{id: string, base: string, ms: number, source: 'probe'} | null}
 */
export function pickBase(results, { candidates = ENDPOINT_CANDIDATES } = {}) {
  const best = rankProbes(results, { candidates })[0];
  if (!best) return null;
  const hit = (Array.isArray(results) ? results : []).find((r) => r && r.id === best.id && Number(r.ms) === Number(best.ms));
  const base = normalizeBase(hit?.base ?? '') || normalizeBase(endpointOf(best.id, candidates)?.base ?? '');
  if (!base) return null;
  return { id: best.id, base, ms: Number(best.ms), source: 'probe' };
}

/**
 * 构造缓存记录（纯数据；写盘由 main.js 负责）。
 * @param {{id: string, base: string, ms: number, now?: number}} input
 * @returns {{v: number, id: string, base: string, ms: number, probedAt: number}}
 */
export function buildCacheRecord({ id, base, ms, now = Date.now() } = /** @type {any} */ ({})) {
  const normalized = normalizeBase(base);
  if (!id || !normalized || !Number.isFinite(Number(ms)) || Number(ms) < 0) {
    throw new TypeError('buildCacheRecord 需要 {id, base, ms}（base 必须可规范化、ms 非负）');
  }
  return { v: CACHE_VERSION, id, base: normalized, ms: Number(ms), probedAt: Number(now) };
}

/**
 * 解析缓存文件内容：结构/版本/线路/时间戳任一不合法 → `null`（当作没有缓存，重新探测）。
 * @param {unknown} raw 文件文本（也接受已解析对象）
 * @returns {{v: number, id: string, base: string, ms: number, probedAt: number} | null}
 */
export function parseEndpointCache(raw) {
  /** @type {any} */
  let data = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== 'object') return null;
  if (Number(data.v) !== CACHE_VERSION) return null;
  const id = String(data.id ?? '').trim();
  const base = normalizeBase(data.base);
  const ms = Number(data.ms);
  const probedAt = Number(data.probedAt);
  if (!id || !base) return null;
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (!Number.isFinite(probedAt) || probedAt <= 0) return null;
  // 缓存里的线路必须仍是候选、且 id 与 base 一致（线路下线/改名/文件被改 → 作废，重新探测）
  const known = endpointOf(base);
  if (!known || String(known.id) !== id) return null;
  return { v: CACHE_VERSION, id: known.id, base: normalizeBase(known.base), ms, probedAt };
}

/**
 * 缓存是否仍然新鲜（`now - probedAt < ttl`；未来时间戳按新鲜处理，只可能是时钟回拨）。
 * @param {{probedAt: number} | null | undefined} record
 * @param {{now?: number, ttl?: number}} [opts]
 * @returns {boolean}
 */
export function isCacheFresh(record, { now = Date.now(), ttl = CACHE_TTL_MS } = {}) {
  if (!record || !Number.isFinite(Number(record.probedAt))) return false;
  const age = Number(now) - Number(record.probedAt);
  if (age < 0) return true;
  return age < Number(ttl);
}

/**
 * 回退链：首选线路 → 香港（去重、规范化）。用于"镜像缺文件/连不上时回退香港再试一次"。
 * @param {unknown} primaryBase
 * @returns {string[]}
 */
export function fallbackChain(primaryBase) {
  const primary = normalizeBase(primaryBase) || normalizeBase(DEFAULT_ENDPOINT.base);
  const hk = normalizeBase(DEFAULT_ENDPOINT.base);
  /** @type {string[]} */
  const chain = [];
  for (const base of [primary, hk]) {
    if (base && !chain.includes(base)) chain.push(base);
  }
  return chain;
}

/**
 * 这个错误是否表示「镜像上没有这个文件」（应当回退香港重试一次）。
 *
 * 覆盖 HTTP 403/404/410（历史上深圳镜像曾把缺失文件 302/404 到香港，见任务记录）与
 * DNS 解析失败（镜像域名临时不可用）。**不**把超时/中断算进来——那是链路问题，
 * 回退香港通常也救不了，重试只会让用户多等一倍时间。
 * @param {unknown} err
 * @returns {boolean}
 */
export function isMirrorMiss(err) {
  const status = Number((/** @type {any} */ (err))?.status ?? (/** @type {any} */ (err))?.statusCode);
  if (status === 403 || status === 404 || status === 410) return true;
  const msg = String((/** @type {any} */ (err))?.message || err || '');
  if (/\bHTTP\s+(403|404|410)\b/.test(msg)) return true;
  return /\bENOTFOUND\b|\bEAI_AGAIN\b/.test(msg);
}

/**
 * 线路选择主入口（**唯一的决策点**）：env 覆盖 → 24h 缓存 → 实时探测 → 回退香港。
 *
 * 返回 `cacheRecord` 时 main.js 把它写进 `userData/endpoint.json`；
 * env 覆盖与"全失败回退"**都不写缓存**（前者是排障态、后者没测出可用线路，
 * 下一次启动应重新探测，而不是把失败缓存 24h）。
 * @param {{
 *   envBase?: unknown,
 *   cache?: unknown,
 *   now?: number,
 *   ttl?: number,
 *   probe?: ((url: string, opts: {timeoutMs: number}) => Promise<{ms: number, status?: number}>) | null,
 *   candidates?: ReadonlyArray<{id: string, base: string}>,
 *   timeoutMs?: number,
 * }} [input]
 * @returns {Promise<{id: string, base: string, source: 'env' | 'cache' | 'probe' | 'fallback', ms: number | null, probes: Array<{id: string, base: string, ok: boolean, ms: number | null, reason?: string}>, cacheRecord: {v: number, id: string, base: string, ms: number, probedAt: number} | null}>}
 */
export async function selectEndpoint({
  envBase = '',
  cache = null,
  now = Date.now(),
  ttl = CACHE_TTL_MS,
  probe = null,
  candidates = ENDPOINT_CANDIDATES,
  timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  const normalizedEnv = normalizeBase(envBase);
  if (normalizedEnv) {
    const known = endpointOf(normalizedEnv, candidates);
    return { id: known ? known.id : 'env', base: normalizedEnv, source: 'env', ms: null, probes: [], cacheRecord: null };
  }
  const cached = cache ? parseEndpointCache(cache) : null;
  if (cached && isCacheFresh(cached, { now, ttl })) {
    return { id: cached.id, base: cached.base, source: 'cache', ms: cached.ms, probes: [], cacheRecord: null };
  }
  /** @type {Array<{id: string, base: string, ok: boolean, ms: number | null, reason?: string}>} */
  const probes = typeof probe === 'function' ? await probeCandidates({ candidates, probe, timeoutMs }) : [];
  const best = pickBase(probes, { candidates });
  if (best) {
    return {
      id: best.id,
      base: best.base,
      source: 'probe',
      ms: best.ms,
      probes,
      cacheRecord: buildCacheRecord({ id: best.id, base: best.base, ms: best.ms, now }),
    };
  }
  return {
    id: DEFAULT_ENDPOINT.id,
    base: DEFAULT_ENDPOINT.base,
    source: 'fallback',
    ms: null,
    probes,
    cacheRecord: null,
  };
}
