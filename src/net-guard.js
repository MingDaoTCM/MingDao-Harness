// 出网闸门（v0.6.0 阶段 C3）：在内核唯一的 HTTP 出口上判定 + 记账。
//
// 为什么包 `globalThis.fetch`：本项目的出网点分散在 Provider、fetch 工具、技能库、模型发现、
// 定价数据、Batch 等处（都是零依赖的全局 fetch）。逐个改调用点既容易漏、也会随时间漂移
// ——本项目已经因为「同一规则多份实现」栽过两次（T20 的 PID 归属、约束 kind 集合）。
// 于是只在一处收口：出口判定只此一份。
//
// 默认**不安装**：未配置 config.net 时闸门完全不介入，既有行为零影响（与约束引擎同款不变量）。
//
// 已知边界（必须与实现一起读）：
//   · 只覆盖内核自己发起的请求。用户在 bash 里自己敲 curl **不走这里**——那是子进程的网络栈。
//     所以它证明的是「内核没有偷偷外传」，不是「这台机器绝对没有外传」。
//   · sync 客户端在自签名证书场景走 node:https（rawRequest），不经全局 fetch；
//     该路径由调用方显式调 decideEgress() 记账（见 src/sync.js）。

import fs from 'node:fs';
import path from 'node:path';
import { mingdaoHome, ensureHome } from './config.js';
import { parseNetPolicy, checkEgress, isLoopback } from './net-policy.js';
import { isPrivateHost } from './ssrf-guard.js';
import { redactSecrets } from './redact.js';
import { atomicWriteFileSync, appendFilePrivateSync, withFileLockSync as withStateFileLockSync } from './atomic-write.js';

const MAX_LINES = 20000;
const KEEP_LINES = 10000;
// v0.6.2（第三方代码审计 P2-2/P2-3）：与 audit/journal/cachestats 同款修正——
// 触发改看**文件大小**（进程内计数对 CLI 永远不成立 → 轮转是死代码），并把
// 非原子写改成原子写（轮转中崩溃会留下半截出网账本，而它是审计证据）。
const MAX_BYTES = 2 * 1024 * 1024; // 约合 20000 行

/** 当前生效策略（null = 未安装，一切放行且不记账） */
let activePolicy = /** @type {any} */ (null);
let installed = false;
let originalFetch = /** @type {any} */ (null);
let warnedOnce = false;
/** 回合内账本 sink（可选）：安装了就在每次出网时同时写一条 net.egress 账本事件 */
const sinks = /** @type {Set<(info: any) => void>} */ (new Set());

export function egressLogFile() {
  return path.join(mingdaoHome(), 'net.jsonl');
}

/**
 * 出网日志的追加锁（v0.7.0 §1.3）。追加与轮转（整文件重写）必须在**同一把锁**内完成：
 *   · 无锁追加：多进程同时写，行可能交错（审计证据不可逐行解析）；
 *   · 无锁轮转：读到别人刚追加前的旧内容再原子覆盖，会把刚写进去的行静默吞掉。
 * 轮转仍是原子替换（tmp+fsync+rename），但只在持锁时发生。
 */
export function egressLogLockFile() {
  return egressLogFile() + '.lock';
}

export function currentPolicy() {
  return activePolicy;
}

export function isInstalled() {
  return installed;
}

/** 注册一个出网事件 sink（回合账本用），返回注销函数 */
export function registerEgressSink(/** @type {(info: any) => void} */ fn) {
  sinks.add(fn);
  return () => sinks.delete(fn);
}

/**
 * 出网日志写失败的**可见报告**（独立函数，失败处理只有一个出口）。
 * 记账失败不影响请求，但也绝不静默：用户/日志必须能查到「这次出网判定没落盘」。
 * @param {any} err
 */
function reportEgressLogFailure(err) {
  console.warn(`[MingDao] ⚠ 出网日志写入失败（${egressLogFile()}）：${String(/** @type {any} */ (err)?.message ?? err)}——本次出网判定未落盘（请求本身不受影响）。`);
}

/**
 * 记录一次出网判定。**绝不抛错**——记账失败不能影响请求本身（与 writeAudit 同款容错）。
 * @param {any} info checkEgress 的结果 + 可选 mode
 */
export function recordEgress(/** @type {any} */ info) {
  const entry = {
    at: Date.now(),
    host: info.host || '',
    port: info.port || '',
    kind: info.kind || '',
    allowed: info.allowed === true,
    rule: info.rule ?? null,
    mode: activePolicy?.mode ?? null,
    reason: info.reason ? redactSecrets(String(info.reason)).slice(0, 200) : null,
  };
  for (const fn of sinks) {
    try {
      // 账本事件（schema C0.2 的 net.egress）——只记判定结果，不记请求体
      fn(entry);
    } catch {}
  }
  if (entry.kind === 'disabled' || entry.kind === 'loopback') return entry; // 未安装/回环不落盘，避免刷噪音
  try {
    ensureHome();
    const file = egressLogFile();
    // 追加与轮转在同一临界区：任何时刻都只有一个写方在动这个文件。
    withStateFileLockSync(egressLogLockFile(), () => {
      appendFilePrivateSync(file, JSON.stringify(entry) + '\n');
      // 低频轮转（与 audit.jsonl 同款策略：按大小触发 + 持锁原子替换）：只保留最近 KEEP_LINES 行。
      // **禁止**无锁「读全文 → 覆盖写」——那不是追加，而是把并发写进去的行静默丢掉。
      if (fs.statSync(file).size > MAX_BYTES) {
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
        if (lines.length > MAX_LINES) {
          atomicWriteFileSync(file, lines.slice(-KEEP_LINES).join('\n') + '\n', { mode: 0o600 });
        }
      }
    });
  } catch (err) {
    // 记账失败不能影响请求本身，但也不能静默：reportEgressLogFailure() 打可见 warn，
    // 然后照常返回判定结果（不把日志写失败伪装成出网失败）。
    reportEgressLogFailure(err);
  }
  return entry;
}

/**
 * 判定并记账一次出网；返回判定结果。供不经全局 fetch 的路径显式调用（如 node:https）。
 * @param {any} url
 */
export function decideEgress(/** @type {any} */ url) {
  if (!activePolicy?.enabled) {
    return { allowed: true, host: '', port: '', rule: null, kind: 'disabled', reason: '未配置出网策略' };
  }
  const d = checkEgress(activePolicy, url);
  recordEgress(d);
  return d;
}

/**
 * 不经 `globalThis.fetch` 的外联路径统一入口（v0.6.7；报告 3 的 M1）。
 *
 * 背景：闸门此前**只**包 `globalThis.fetch`，而 `safe-fetch.js` 走 `node:http(s).request`
 * （它必须这样——只有 http 模块能把"已校验的 IP"钉给连接层，防 DNS rebinding）。
 * 于是「skill 下载 / registry 拉取 / 模型发现」三条自动出口既不受 block 拦截、也不进出网账本：
 * 用户配了 `config.net` 想自证"数据不出门"，实际漏的恰恰是这几条自动路径——
 * 对一个把"出网自证"当卖点的项目，**失真的安全叙事比明确不拦更危险**。
 *
 * 语义与 globalThis.fetch 那条完全一致（同一份 activePolicy、同一个 recordEgress）：
 *   · 未安装 → 放行、不记账；
 *   · block 且不在白名单 → `{ blocked: true, message }`，调用方必须拒绝本次连接；
 *   · warn 且不在白名单 → 放行 + 记账 + **只告警一次**（避免刷屏）。
 * @param {any} url
 * @returns {{ blocked: boolean, message: string, decision: any }}
 */
export function guardEgress(/** @type {any} */ url) {
  const d = decideEgress(url);
  if (d.allowed) return { blocked: false, message: '', decision: d };
  if (activePolicy?.mode === 'block') {
    return {
      blocked: true,
      message:
        `出网被拦截：${d.host}${d.port ? ':' + d.port : ''} 不在 config.net.allow 白名单内（mode=block）。` +
        `若这是必要的外部依赖，请把该主机显式加入白名单；若只是想让数据不出门，请保持拦截并改用内网端点。`,
      decision: d,
    };
  }
  if (!warnedOnce) {
    warnedOnce = true;
    try {
      process.stderr.write(`[MingDao] ⚠ 出网告警：${d.host} 不在白名单内（mode=warn，已放行并记账）。运行 mingdao net report 查看明细。\n`);
    } catch {}
  }
  return { blocked: false, message: '', decision: d };
}

/**
 * **未配置 `config.net` 时的默认出网判定**（v0.6.30 C3 / 报告四 H2 / 报告三 H-12）。
 *
 * 缺陷：未配置白名单时闸门不安装、一切放行且不记账——模型面向的 `fetch` 工具于是可以在
 * 默认 ask 档下把刚 read 到的本地内容直接发出去，全程零确认。审计把这条与 `fetch` 归入
 * 只读工具一起列为 H-12。
 *
 * 现在的语义：**未配置 = 默认禁止**（fail-closed），并给出可操作的提示；已配置 `config.net`
 * （哪怕 `allow: []` + `mode: 'warn'`）则交给既有策略判定，不在这里二次猜测。
 *
 * 只判「模型的 fetch 工具」这一条模型驱动的出口：内核自己的自动路径（技能库 / 模型发现 /
 * 同步）仍按既有「未配置零影响」不变量走——那是用户主动触发的功能，且改动它们会与
 * `test/smoke.js` §126③ 的既有行为断言冲突（safe-fetch 的钉扎端到端用例）。边界写在
 * docs/CONFIG.md 的「出网白名单」一节，不扩大承诺。
 *
 * 返回 `null` = 「不在这里判」（已配置 / 非 http(s) / 回环与私网）：
 * 回环不出本机；私网/元数据交给 SSRF 判定给出更准确的拒绝理由（smoke §5g 明确断言
 * 「内网」「元数据」措辞，不能被默认出网提示抢先）。
 * @param {any} url
 * @returns {{ blocked: boolean, message: string }|null}
 */
export function unconfiguredEgressVerdict(/** @type {any} */ url) {
  if (activePolicy?.enabled) return null;
  /** @type {URL} */
  let u;
  try {
    u = url instanceof URL ? url : new URL(String(url));
  } catch {
    return null; // 非 URL（scp 形式 git 远端等）不在这里判：工具面只接受 http(s)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname;
  if (isLoopback(host) || isPrivateHost(host)) return null;
  return {
    blocked: true,
    message:
      `出网被拒绝（fail-closed）：未配置 config.net 出网白名单，默认禁止出网。` +
      `若确需访问 ${host}，请在设置里把该域名加入 config.net.allow` +
      `（config.json 例：{"net":{"allow":["${host}"],"mode":"warn"}}）；不需要出网时保持默认即可。`,
  };
}

/** 跨 origin 跳转时**允许保留**的请求头（反向白名单）。
 *
 * v0.6.7（报告 1 M-4）：此前是**黑名单**（只删 authorization / cookie / proxy-authorization），
 * 于是 `x-api-key` / `api-key` / `x-auth-token` / `x-amz-security-token` 这类自定义凭据头
 * 会原样带给重定向目标——而"自定义头里放密钥"恰恰是网关类服务的常见做法。
 * 反向白名单的方向与安全一致：**没被点名的头一律不跨源**（新增自定义头默认安全）。
 * 白名单只放"不带身份、且对重定向后的请求仍需成立"的头。 */
const CROSS_ORIGIN_KEEP_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'content-length',
  'content-type',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-range',
  'if-unmodified-since',
  'range',
  'user-agent',
]);

/** 按反向白名单裁掉不该跨源的头；返回新的 Headers（输入未被修改）。
 * @param {any} headers */
export function stripHeadersForCrossOrigin(headers) {
  const src = new Headers(headers || {});
  /** @type {[string,string][]} */
  const keep = [];
  src.forEach((v, k) => {
    if (CROSS_ORIGIN_KEEP_HEADERS.has(String(k).toLowerCase())) keep.push([k, v]);
  });
  return new Headers(keep);
}

/** URL 的**有效端口**（显式端口优先；省略时按协议取默认端口）。 */
function effectivePort(/** @type {URL} */ u) {
  if (u.port) return u.port;
  if (u.protocol === 'https:') return '443';
  if (u.protocol === 'http:') return '80';
  return '';
}

/**
 * 重定向时是否必须剥离凭据头——**唯一判定**（v0.6.29 安全批 B1）。
 *
 * 为什么单独成一个函数：`net-guard` 的全局 fetch 跟随器与 `safe-fetch` 的
 * `node:http(s)` 跟随器是**两条传输路径**，但「这一跳该不该带凭据」只能有一个答案。
 * 此前 safe-fetch 自己写了一套"只跟不剥"的实现，等于同一规则两份口径、最弱的那份说了算
 *（与 ssrf-guard / 脱敏词表同一个根因）。
 *
 * 触发条件（任一即剥，且都属于**语义上的 origin 变化**）：
 *   · 协议变化（https→http 的**降级**必须单独给理由，日志要可见）；
 *   · 端口变化（http://a:8080 → http://a:9090 也是跨源）；
 *   · 主机名变化。
 * 同源（协议/主机/有效端口都相同）保留凭据——登录跳转、补斜杠等常见形态不该丢头。
 * @param {any} from @param {any} to
 * @returns {{ strip: boolean, reason: 'same-origin'|'protocol-downgrade'|'protocol-change'|'port-change'|'host-change'|'unparseable' }}
 */
export function redirectCredentialDecision(/** @type {any} */ from, /** @type {any} */ to) {
  /** @type {URL} */ let a;
  /** @type {URL} */ let b;
  try {
    a = new URL(String(from));
    b = new URL(String(to));
  } catch {
    // 解析不了就无法证明同源——按跨源处理（fail-closed）
    return { strip: true, reason: 'unparseable' };
  }
  if (a.protocol !== b.protocol) {
    return { strip: true, reason: a.protocol === 'https:' && b.protocol === 'http:' ? 'protocol-downgrade' : 'protocol-change' };
  }
  if (effectivePort(a) !== effectivePort(b)) return { strip: true, reason: 'port-change' };
  if (a.hostname.toLowerCase() !== b.hostname.toLowerCase()) return { strip: true, reason: 'host-change' };
  return { strip: false, reason: 'same-origin' };
}

/**
 * 为下一跳准备请求头：跨源就按反向白名单裁剪，同源原样返回。
 * 两条跟随路径（net-guard 的 fetch / safe-fetch 的 node:http）都必须走这里，
 * 不要各自决定「哪些头能带」。
 * @param {any} headers @param {any} from @param {any} to
 * @returns {{ strip: boolean, reason: string, headers: any }}
 */
export function prepareRedirectHeaders(/** @type {any} */ headers, /** @type {any} */ from, /** @type {any} */ to) {
  const decision = redirectCredentialDecision(from, to);
  return { ...decision, headers: decision.strip ? stripHeadersForCrossOrigin(headers) : headers };
}

/**
 * 安装出网闸门（幂等）。未配置 config.net → 不安装，返回 false。
 * @param {any} rawNet cfg.net
 * @returns {boolean} 是否安装
 */
export function installEgressGate(/** @type {any} */ rawNet) {
  const policy = parseNetPolicy(rawNet);
  if (!policy.enabled) return false;
  activePolicy = policy;
  if (!installed) {
    originalFetch = globalThis.fetch;
    const base = originalFetch;
    const blockedError = (/** @type {any} */ d, /** @type {string} */ tag = '') =>
      new Error(
        `出网被拦截${tag}：${d.host}${d.port ? ':' + d.port : ''} 不在 config.net.allow 白名单内（mode=block）。` +
          `若这是必要的外部依赖，请把该主机显式加入白名单；若只是想让数据不出门，请保持拦截并改用内网端点。`
      );
    globalThis.fetch = async (/** @type {any} */ input, /** @type {any} */ init) => {
      const url = typeof input === 'string' ? input : input && typeof input === 'object' && 'url' in input ? input.url : String(input);
      const g = guardEgress(url); // 与 safe-fetch 共用同一个入口（block 抛错 / warn 一次性告警 + 记账）
      if (g.blocked) throw blockedError(g.decision);
      // 重定向必须**逐跳**判定（v0.6.0 自查发现的绕过）：
      // 调用方不指定 redirect 时 undici 默认自己跟随 3xx，闸门只看得到**首个** URL——
      // 于是「允许 api.deepseek.com」会被利用成：该主机返回 302 指向任意地址，内核照样跟过去，
      // 而且会把 Authorization 头一起带过去。这不是理论风险：模型端点是可被配置/接管的。
      // 这里改成自行跟随并逐跳过闸；调用方显式指定 redirect（如 fetch 工具的 'manual'，
      // 它本来就自己逐跳处理）时不介入，避免改变既有语义。
      const follow = !init || init.redirect === undefined || init.redirect === 'follow';
      if (!follow) return base(input, init);
      // v0.6.2（自评报告 P2-8）：`input` 可能是 **Request 对象**。
      // 原实现只取它的 `.url`，然后 `curInit = { redirect: 'manual' }` —— method / body / headers /
      // signal **全部丢失**，请求被**静默降级成 GET**（`fetch(new Request(u, { method:'POST', body }))`
      // 实际发出的是 GET，服务端只会看到一个空 GET）。
      // 同一根因还有第二个症状：`new URL(loc, current)` 里 current 若是 Request 对象，
      // 会退化成字符串 "[object Request]" → 抛「非法重定向地址」。
      // 现把 Request 的语义摊进 init，并把后续跳的基准统一为字符串 URL。
      const isRequestInput = Boolean(input) && typeof input === 'object' && typeof input.url === 'string';
      /** @type {any} */
      let current = url; // 字符串 URL：供 new URL(loc, current) 使用（不能是 Request 对象）
      // v0.6.7（报告 2 的 P2-3）：**Request + init 并存时逐字段合并**。
      // 此前只在「只传 Request、没有 init」时才继承其语义；而 `fetch(new Request(u,{method:'POST',body}), {signal})`
      // 这种「加个 AbortSignal」的常见写法会走 `{...init, redirect:'manual'}` 分支，
      // 于是 method/body/headers 全丢 → **静默降级成空 GET**（行为级实测：服务端收到 `GET body=""`）。
      // 透明代理改变请求语义属于「安全组件引入数据损坏」，必须逐字段按 fetch 规范合并：
      // init 优先，未给的字段回落到 Request。
      /** @type {any} */
      let curInit;
      if (isRequestInput) {
        /** @type {any} */
        const merged = {};
        const method = init?.method ?? input.method;
        if (method) merged.method = method;
        if (input.headers || init?.headers) {
          const h = new Headers(input.headers || {});
          if (init?.headers) new Headers(init.headers).forEach((v, k) => h.set(k, v));
          merged.headers = h;
        }
        const body = init?.body ?? input.body;
        if (body !== undefined && body !== null) merged.body = body;
        const signal = init?.signal ?? input.signal;
        if (signal) merged.signal = signal;
        if (input.duplex && !init?.duplex) merged.duplex = input.duplex;
        for (const k of ['mode', 'credentials', 'cache', 'integrity', 'keepalive', 'referrer', 'referrerPolicy']) {
          const v = init?.[k] ?? input[k];
          if (v !== undefined && v !== null) merged[k] = v;
        }
        merged.redirect = 'manual'; // 由本闸门逐跳处理
        curInit = merged;
      } else {
        curInit = init ? { ...init, redirect: 'manual' } : { redirect: 'manual' };
      }
      for (let hop = 0; ; hop++) {
        const res = await base(current, curInit);
        if (![301, 302, 303, 307, 308].includes(res.status)) return res;
        const loc = res.headers?.get?.('location');
        if (!loc) return res;
        if (hop >= 20) {
          try {
            await res.body?.cancel();
          } catch {}
          throw new Error('重定向次数超过上限（20 跳），已中止');
        }
        let next = '';
        try {
          next = new URL(loc, current).toString();
        } catch {
          try {
            await res.body?.cancel();
          } catch {}
          throw new Error(`非法重定向地址：${loc}`);
        }
        const nd = decideEgress(next);
        if (!nd.allowed && activePolicy?.mode === 'block') {
          try {
            await res.body?.cancel();
          } catch {}
          throw blockedError(nd, '（重定向目标）');
        }
        // 方法语义按 fetch 规范：303 一律转 GET；301/302 对 POST 转 GET；307/308 保持方法与正文
        const method = String(curInit?.method || 'GET').toUpperCase();
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
          const { body, ...rest } = curInit || {};
          curInit = { ...rest, method: 'GET' };
        }
        // 跨 origin 跳转必须**剥掉凭据头**（审计 BUG-034，实测复现）：
        // 手动跟随重定向时 `curInit` 原样复用，而 undici 在 `redirect:'manual'` 下不会替你做
        // 同源剥离——实测 warn 模式的第二跳 `https://attacker.example/steal` 仍带着第一跳的
        // `Authorization: Bearer sk-…`。与 mode 无关：warn 放行的是「出网」，不该顺手把凭据送出去。
        // v0.6.7（报告 1 M-4）：改**反向白名单**（见 stripHeadersForCrossOrigin）——
        // 黑名单只删得掉三个头，`x-api-key` 之类的自定义凭据头会原样泄漏给重定向目标。
        // 判定与裁剪都走 prepareRedirectHeaders（与 safe-fetch 共用同一份，见该函数注释）。
        const prep = prepareRedirectHeaders(curInit?.headers, String(current), next);
        if (prep.strip && curInit?.headers) {
          curInit = { ...curInit, headers: prep.headers };
        }
        try {
          await res.body?.cancel(); // 释放上一跳的连接，避免重定向链堆积
        } catch {}
        current = next;
      }
    };
    installed = true;
  }
  return true;
}

/** 卸载（测试用）：恢复原始 fetch */
export function uninstallEgressGate() {
  if (installed && originalFetch) {
    globalThis.fetch = originalFetch;
  }
  installed = false;
  activePolicy = null;
  warnedOnce = false;
  return true;
}

/**
 * 读取出网记账。
 * @param {{sinceMs?: number, limit?: number}} [opts]
 */
export function readEgressLog({ sinceMs = 0, limit = 5000 } = {}) {
  try {
    const lines = fs.readFileSync(egressLogFile(), 'utf8').split('\n').filter(Boolean);
    const out = [];
    for (const l of lines) {
      try {
        const e = JSON.parse(l);
        if (sinceMs && Number(e.at) < sinceMs) continue;
        out.push(e);
      } catch {}
    }
    return out.slice(-Math.max(1, limit));
  } catch {
    return [];
  }
}

/**
 * 汇总：按主机聚合次数、是否命中白名单、最近一次时间。请求体从不记录，故汇总里也不可能有。
 * @param {any[]} entries
 */
export function summarizeEgress(entries) {
  /** @type {Map<string, any>} */
  const byHost = new Map();
  let blocked = 0;
  for (const e of entries) {
    const key = `${e.host}${e.port ? ':' + e.port : ''}`;
    const cur = byHost.get(key) || { host: key, total: 0, allowed: 0, denied: 0, rules: new Set(), lastAt: 0, kinds: new Set() };
    cur.total += 1;
    if (e.allowed) cur.allowed += 1;
    else {
      cur.denied += 1;
      blocked += 1;
    }
    if (e.rule) cur.rules.add(e.rule);
    if (e.kind) cur.kinds.add(e.kind);
    cur.lastAt = Math.max(cur.lastAt, Number(e.at) || 0);
    byHost.set(key, cur);
  }
  const hosts = [...byHost.values()]
    .map((h) => ({ ...h, rules: [...h.rules], kinds: [...h.kinds] }))
    .sort((a, b) => b.total - a.total);
  return { total: entries.length, blocked, hosts, since: entries[0]?.at ?? null, until: entries[entries.length - 1]?.at ?? null };
}
