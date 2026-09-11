// 执行账本（v0.6.0 阶段 C1）：一次回合 = 一个文件，事件流可导出、可校验、可回放的基础。
//
// 为什么新建账本而不改造 audit.jsonl：
//   ① audit.jsonl 有 20000 行截断（低频读盘裁剪），回放会缺段——**被静默截断的合规账本比不记账更糟**，
//      看起来有、实际缺；② audit 只记工具调用，没有模型轮次/约束触发/权限决策/费用，粒度不足以
//      回答「这个结论是怎么来的」。因此账本独立成目录，audit.jsonl 的既有语义保持不变（`mingdao audit` 不变）。
//
// 三条不可让步的纪律：
//   ① **写入即脱敏**：明细先过 redactSecrets 再落盘（不留「先存明文、靠导出兜底」的口子）；
//      导出时再过一遍 redactSensitive（叠加私网 IP + 家目录），因为导出物是对外的。
//   ② **摘要替代原文**：`*Digest` = sha256(原文) 前 16 位，用于「证明两次执行的这一步完全相同」
//      与校验账本未被篡改，而不泄露原文。
//   ③ **约束事件不回显命中短语**：否则账本自身变成泄露渠道（沿用 v0.4.7 blockedOutputText 的做法）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { mingdaoHome, ensureHome } from './config.js';
import { redactSecrets, redactSensitive } from './redact.js';

/** v1：字段只增不改（变更需在 docs/CHANGELOG-PACK.md 同款变更日志里记录） */
export const LEDGER_VERSION = 1;
/** 默认保留最近多少次运行（超出按 mtime 删最旧） */
const DEFAULT_MAX_RUNS = 200;
const GENESIS = '0'.repeat(16);
const MAX_TEXT = 2000; // 单字段上限（与 audit 的 args 截断一致）

export function ledgerDir() {
  return path.join(mingdaoHome(), 'ledger');
}

/** 运行 id：时间前缀（可排序）+ 随机后缀（同毫秒不撞） */
export function newRunId() {
  return Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}

/** 内容摘要：用于比对「是否同一步」，而不是用来还原内容 */
export function digestOf(/** @type {any} */ value) {
  const s = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return crypto.createHash('sha256').update(String(s ?? '')).digest('hex').slice(0, 16);
}

/**
 * 递归脱敏（有界深度 + 有界长度），返回**新对象**，绝不改动调用方数据。
 * 数组按元素递归；非字符串标量原样保留（数字/布尔不需要脱敏）。
 *
 * `fn` 必须可传：写入时用 redactSecrets（只掩码密钥），**导出时用 redactSensitive**
 * （叠加私网 IP + 家目录）。此前这里把 fn 写死成 redactSecrets，导致导出时
 * 「顶层字符串字段过了 redactSensitive、而嵌在 args 里的私网 IP 原样输出」——
 * 同一份导出物上两级脱敏规则不一致，是最容易被忽略的泄露路径。
 * @param {any} value
 * @param {number} [depth]
 * @param {(s: string) => string} [fn]
 * @returns {any}
 */
export function redactDeep(value, depth = 0, fn = redactSecrets) {
  if (depth > 4) return '[过深已截断]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return fn(value).slice(0, MAX_TEXT);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redactDeep(v, depth + 1, fn));
  /** @type {any} */
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, depth + 1, fn);
  return out;
}

function runFile(/** @type {any} */ runId) {
  return path.join(ledgerDir(), String(runId) + '.jsonl');
}

/** 合法的 run id（防路径穿越：id 直接拼进文件路径） */
export function isValidRunId(/** @type {any} */ id) {
  return typeof id === 'string' && /^[a-z0-9]+-[a-f0-9]{6}$/.test(id);
}

/**
 * 创建一次运行的账本写入器。所有方法在账本不可用时**静默降级**（no-op），
 * 绝不让「记账失败」影响正常执行——与 writeAudit 同款容错。
 * @param {string} runId
 * @param {{enabled?: boolean, maxRuns?: number, now?: () => number}} [opts]
 */
export function createLedger(runId, { enabled = true, maxRuns = DEFAULT_MAX_RUNS, now = () => Date.now() } = {}) {
  let seq = 0;
  let prev = GENESIS;
  let alive = Boolean(enabled) && isValidRunId(runId);

  /** 事件落盘：一行一个 JSON，返回该行内容（供测试/调试） */
  function write(/** @type {string} */ type, /** @type {any} */ payload) {
    if (!alive) return null;
    try {
      ensureHome();
      fs.mkdirSync(ledgerDir(), { recursive: true });
      const event = { v: LEDGER_VERSION, runId, seq: seq + 1, at: now(), type, prev, ...redactDeep(payload) };
      const line = JSON.stringify(event);
      fs.appendFileSync(runFile(runId), line + '\n');
      try {
        fs.chmodSync(runFile(runId), 0o600);
      } catch {}
      // 哈希链：下一行的 prev = 本行内容的 hash（校验时逐行重算即可发现篡改/删行）
      prev = digestOf(line);
      seq += 1;
      return line;
    } catch {
      alive = false; // 写失败即整体停用，避免每步都抛一次
      return null;
    }
  }

  return {
    runId,
    get enabled() {
      return alive;
    },
    get seq() {
      return seq;
    },
    /** 回合开始：模型/权限/预设/Pack 等「当时的规则环境」——复检时要靠它对齐上下文 */
    runStart(/** @type {any} */ f = {}) {
      rotateLedger(maxRuns);
      return write('run.start', {
        model: f.model ?? null,
        provider: f.provider ?? null,
        session: f.session ?? null,
        cwd: f.cwd ?? null,
        permission: f.permission ?? null,
        preset: f.preset ?? null,
        packs: Array.isArray(f.packs) ? f.packs : [],
      });
    },
    modelRound(/** @type {any} */ f = {}) {
      return write('model.round', {
        round: f.round ?? null,
        step: f.step ?? null,
        ms: f.ms ?? null,
        firstTokenMs: f.firstTokenMs ?? null,
        requestStartAt: f.requestStartAt ?? null,
        finish: f.finish ?? null,
        usage: f.usage ?? null,
      });
    },
    toolCall(/** @type {any} */ f = {}) {
      // 明细（脱敏后）与摘要（原文指纹）并存：前者给人看，后者用来比对与防篡改
      return write('tool.call', {
        callId: f.callId ?? null,
        name: f.name ?? null,
        pack: f.pack ?? null,
        argsDigest: digestOf(f.rawArgs ?? f.args ?? null),
        args: f.args ?? null,
        permission: f.permission ?? null,
        constraint: f.constraint ?? null,
        readOnly: f.readOnly ?? null,
      });
    },
    toolResult(/** @type {any} */ f = {}) {
      const raw = f.result === undefined ? null : f.result;
      return write('tool.result', {
        callId: f.callId ?? null,
        name: f.name ?? null,
        ok: f.ok ?? null,
        exitCode: f.exitCode ?? null,
        ms: f.ms ?? null,
        resultDigest: digestOf(raw),
        resultSize: raw === null ? 0 : String(typeof raw === 'string' ? raw : JSON.stringify(raw)).length,
        blocked: f.blocked ?? false,
        error: f.error ?? null,
      });
    },
    /** 约束触发：只记「哪条约束、什么时机、如何处理」，**不记命中的原文** */
    constraint(/** @type {any} */ f = {}) {
      return write('constraint', {
        kind: f.kind ?? null,
        id: f.id ?? null,
        stage: f.stage ?? null,
        tool: f.tool ?? null,
        action: f.action ?? null,
      });
    },
    permission(/** @type {any} */ f = {}) {
      return write('permission', {
        name: f.name ?? null,
        mode: f.mode ?? null,
        decision: f.decision ?? null,
        source: f.source ?? null,
        rule: f.rule ?? null,
      });
    },
    /** 费用：priced=false 必须显式存在——无价模型绝不写 ¥0.0000 冒充免费 */
    cost(/** @type {any} */ f = {}) {
      return write('cost', {
        model: f.model ?? null,
        usage: f.usage ?? null,
        pricing: f.pricing ?? null,
        yuan: f.yuan ?? null,
        priced: f.priced === true,
      });
    },
    netEgress(/** @type {any} */ f = {}) {
      return write('net.egress', {
        host: f.host ?? null,
        port: f.port ?? null,
        allowed: f.allowed ?? null,
        reason: f.reason ?? null,
      });
    },
    runEnd(/** @type {any} */ f = {}) {
      return write('run.end', {
        ms: f.ms ?? null,
        status: f.status ?? null,
        steps: f.steps ?? null,
        rounds: f.rounds ?? null,
        yuanTotal: f.yuanTotal ?? null,
        priced: f.priced === true,
        capHit: f.capHit === true,
        truncated: f.truncated === true,
        aborted: f.aborted === true,
      });
    },
  };
}

/**
 * 读取一次运行的事件流。`strict` 模式下解析失败的行会被标记出来而不是静默丢弃
 * ——账本里出现坏行本身就是需要被看见的事实。
 * @param {any} runId
 */
export function readRun(/** @type {any} */ runId) {
  if (!isValidRunId(runId)) return [];
  try {
    return fs
      .readFileSync(runFile(runId), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { type: 'corrupt', raw: l.slice(0, 200) };
        }
      });
  } catch {
    return [];
  }
}

/**
 * 校验哈希链：能发现「改了一行」与「删了一行」（两者都会让 prev 对不上）。
 * 诚实边界：**不含可信时间戳**，只能证明「自写入后未被改动」，不能证明生成时刻。
 * @param {any} runId
 */
export function verifyRun(/** @type {any} */ runId) {
  const raw = (() => {
    try {
      return fs.readFileSync(runFile(runId), 'utf8');
    } catch {
      return null;
    }
  })();
  if (raw === null) return { ok: false, error: '账本不存在', badSeq: null, total: 0 };
  const lines = raw.split('\n').filter(Boolean);
  let prev = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    let ev;
    try {
      ev = JSON.parse(lines[i]);
    } catch {
      return { ok: false, error: `第 ${i + 1} 行不是合法 JSON`, badSeq: i + 1, total: lines.length };
    }
    if (ev.prev !== prev) {
      return { ok: false, error: `第 ${i + 1} 行的前序哈希不匹配（该行或其上一行被改动/删除）`, badSeq: ev.seq ?? i + 1, total: lines.length };
    }
    prev = digestOf(lines[i]);
  }
  return { ok: true, error: null, badSeq: null, total: lines.length };
}

/** 列出账本（按修改时间倒序），供 `ledger list` 与轮转使用 */
export function listRuns() {
  const dir = ledgerDir();
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    const runId = f.replace(/\.jsonl$/, '');
    let mtime = 0;
    try {
      mtime = fs.statSync(path.join(dir, f)).mtimeMs;
    } catch {}
    const events = readRun(runId);
    const start = events.find((e) => e.type === 'run.start') || null;
    const end = events.find((e) => e.type === 'run.end') || null;
    out.push({
      runId,
      mtime,
      at: start?.at ?? null,
      model: start?.model ?? null,
      session: start?.session ?? null,
      events: events.length,
      status: end?.status ?? '未结束',
      yuanTotal: end?.yuanTotal ?? null,
      priced: end?.priced === true,
    });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** 配额轮转：只保留最近 maxRuns 次运行（按 mtime），返回被删除的 runId */
export function rotateLedger(/** @type {any} */ maxRuns = DEFAULT_MAX_RUNS) {
  const runs = listRuns();
  if (runs.length <= maxRuns) return [];
  const removed = [];
  for (const r of runs.slice(maxRuns)) {
    try {
      fs.rmSync(runFile(r.runId), { force: true });
      removed.push(r.runId);
    } catch {}
  }
  return removed;
}

/** @type {Record<string, string>} */
const MARK = { 'run.start': '▶', 'run.end': '■', 'model.round': '🧠', 'tool.call': '🔧', 'tool.result': '↳', constraint: '⛔', permission: '🔑', cost: '¥', 'net.egress': '🌐' };

/**
 * 导出一次运行。json = 事件数组；md = 人读报告。
 * 导出物是对外的，因此在 redactSecrets（写入时已做）之上再跑一遍 redactSensitive，
 * 叠加私网 IP 与家目录路径的掩码。
 * @param {any} runId
 * @param {{format?: 'json'|'md'}} [opts]
 */
export function exportRun(/** @type {any} */ runId, { format = 'json' } = {}) {
  const events = readRun(runId);
  if (!events.length) return { error: `没有找到账本 ${runId}` };
  const safe = events.map((e) => {
    /** @type {any} */
    const o = {};
    for (const [k, v] of Object.entries(e)) {
      // 统一走 redactSensitive：顶层字符串与嵌套结构必须适用同一套规则
      o[k] = typeof v === 'string' ? redactSensitive(v).slice(0, MAX_TEXT) : redactDeep(v, 0, redactSensitive);
    }
    return o;
  });
  const v = verifyRun(runId);
  if (format === 'json') {
    return { ok: true, text: JSON.stringify({ runId, integrity: v, events: safe }, null, 2) + '\n' };
  }
  const lines = [];
  const start = safe.find((e) => e.type === 'run.start');
  const end = safe.find((e) => e.type === 'run.end');
  lines.push(`# 执行账本 ${runId}`);
  lines.push('');
  lines.push(`- 模型：${start?.model ?? '—'} · 会话：${start?.session ?? '—'} · 权限：${start?.permission ?? '—'}`);
  lines.push(`- 开始：${start?.at ? new Date(start.at).toISOString() : '—'}`);
  lines.push(`- 结束：${end ? `${end.status}（${end.ms}ms，${end.steps} 步）` : '未结束'}`);
  lines.push(`- 费用：${end?.priced ? `¥${Number(end.yuanTotal ?? 0).toFixed(4)}` : '**无法估算**（模型无价，不是 0 元）'}`);
  lines.push(`- 哈希链校验：${v.ok ? '✅ 完整' : `❌ ${v.error}`}`);
  lines.push('');
  lines.push('| # | 时刻 | 事件 | 摘要 |');
  lines.push('| --- | --- | --- | --- |');
  for (const e of safe) {
    const brief = (() => {
      switch (e.type) {
        case 'run.start':
          return `模型 ${e.model ?? '—'}`;
        case 'model.round':
          return `第 ${e.round} 轮 第 ${e.step} 步 · ${e.ms ?? '—'}ms · 完成原因 ${e.finish ?? '—'}`;
        case 'tool.call':
          return `${e.name}${e.pack ? ` (pack:${e.pack})` : ''} · 参数指纹 ${e.argsDigest} · 权限 ${e.permission?.decision ?? '—'}`;
        case 'tool.result':
          return `${e.name} · ${e.ok ? '成功' : '失败'}${e.blocked ? '（被约束拦截）' : ''} · ${e.ms ?? '—'}ms`;
        case 'constraint':
          return `${e.kind} [${e.stage}] ${e.id ?? ''} → ${e.action ?? '—'}`;
        case 'permission':
          return `${e.name} → ${e.decision}（${e.source ?? '—'}）`;
        case 'cost':
          return e.priced ? `¥${Number(e.yuan ?? 0).toFixed(4)}` : '无法估算（模型无价）';
        case 'net.egress':
          return `${e.host}:${e.port ?? ''} ${e.allowed ? '白名单内' : '越界'} ${e.reason ?? ''}`;
        case 'run.end':
          return `${e.status} · ${e.ms}ms`;
        default:
          return '';
      }
    })();
    lines.push(`| ${e.seq} | ${e.at ? new Date(e.at).toISOString().slice(11, 19) : '—'} | ${MARK[e.type] || ''} ${e.type} | ${brief} |`);
  }
  lines.push('');
  lines.push('> 脱敏说明：明细在**写入时**已按密钥规则掩码，导出时再叠加私网 IP 与家目录路径掩码。');
  lines.push('> 完整性说明：哈希链只能证明「自写入后未被改动」，**不含可信时间戳**，不等同于审计级不可否认。');
  return { ok: true, text: lines.join('\n') + '\n' };
}
