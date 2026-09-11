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
import { parseNetPolicy, checkEgress } from './net-policy.js';
import { redactSecrets } from './redact.js';

const MAX_LINES = 20000;
const KEEP_LINES = 10000;
let appendCount = 0;

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
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    try {
      fs.chmodSync(file, 0o600);
    } catch {}
    appendCount += 1;
  } catch {
    return entry;
  }
  // 低频轮转（与 audit.jsonl 同款策略）：只保留最近 KEEP_LINES 行
  if (appendCount > MAX_LINES && appendCount % 200 === 0) {
    try {
      const lines = fs.readFileSync(egressLogFile(), 'utf8').split('\n').filter(Boolean);
      if (lines.length > MAX_LINES) {
        fs.writeFileSync(egressLogFile(), lines.slice(-KEEP_LINES).join('\n') + '\n', { mode: 0o600 });
        appendCount = KEEP_LINES;
      }
    } catch {}
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
      const d = decideEgress(url);
      if (!d.allowed && activePolicy?.mode === 'block') throw blockedError(d);
      if (!d.allowed && activePolicy?.mode === 'warn' && !warnedOnce) {
        warnedOnce = true;
        try {
          process.stderr.write(`[MingDao] ⚠ 出网告警：${d.host} 不在白名单内（mode=warn，已放行并记账）。运行 mingdao net report 查看明细。\n`);
        } catch {}
      }
      // 重定向必须**逐跳**判定（v0.6.0 自查发现的绕过）：
      // 调用方不指定 redirect 时 undici 默认自己跟随 3xx，闸门只看得到**首个** URL——
      // 于是「允许 api.deepseek.com」会被利用成：该主机返回 302 指向任意地址，内核照样跟过去，
      // 而且会把 Authorization 头一起带过去。这不是理论风险：模型端点是可被配置/接管的。
      // 这里改成自行跟随并逐跳过闸；调用方显式指定 redirect（如 fetch 工具的 'manual'，
      // 它本来就自己逐跳处理）时不介入，避免改变既有语义。
      const follow = !init || init.redirect === undefined || init.redirect === 'follow';
      if (!follow) return base(input, init);
      let current = url;
      /** @type {any} */
      let curInit = init ? { ...init, redirect: 'manual' } : { redirect: 'manual' };
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
