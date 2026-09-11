// 决策回放（v0.6.0 阶段 C2）：把账本里记录的工具调用序列，按**当前**的权限/约束栈重新评估。
//
// 承诺什么、不承诺什么（这条必须写在代码里，否则很容易被读成后者）：
//   ✅ 承诺：**决策回放**——「历史上这些操作，用今天的规则重判，哪些会被拦下来」。
//      用途明确：合规复检（新加的红线能不能拦住历史上那批操作）与回归测试
//      （把生产事故的账本直接变成可复跑的用例）。
//   ❌ 不承诺：**模型级回放**——「同一模型重放同一执行路径」。模型本身非确定性，
//      且要求离线环境持有同一权重；承诺了也做不到，不如不承诺。
//
// 已知局限（如实写在输出里，而不是留给用户自己踩）：
//   1. 回放用的是账本中**已脱敏**的参数。若某条规则恰好依赖被掩码的内容
//      （例如 arg-forbid 指向一个像密钥的串），回放可能不命中。
//   2. 只重判**决策**，不重跑工具、不重放模型输出——没有副作用，也不会联网。
//   3. 账本记录了每步当时的约束命中情况，因此能区分「当时被拦」与「当时放行」，
//      从而给出四类差异而不是只报「有问题」。

import { compileConstraints, checkPreTool } from './constraints.js';
import { evaluatePermission } from './permissions.js';
import { readRun } from './ledger.js';

/** 差异分类（顺序即严重度） */
const KIND = {
  NOW_BLOCKED: 'now-blocked', // 当时放行、今天会被红线拦住 ← 合规复检最关心的一类
  NOW_DENIED: 'now-denied', // 当时允许、今天的权限规则会拒
  STILL_BLOCKED: 'still-blocked', // 当时被拦、今天仍被拦
  RELAXED: 'relaxed', // 当时被拦、今天放行（规则放宽，同样值得复核）
  UNCHANGED: 'unchanged',
};

/**
 * 回放一次运行。
 * @param {any} runId
 * @param {{constraints?: any[], permission?: any}} [opts] constraints/permission = **当前**规则（缺省则视为空/ask）
 */
export function replayRun(/** @type {any} */ runId, { constraints = [], permission = 'ask' } = {}) {
  const events = readRun(runId);
  if (!events.length) return { error: `没有找到账本 ${runId}` };
  const compiled = compileConstraints(constraints);
  const start = events.find((e) => e.type === 'run.start') || null;
  const calls = events.filter((e) => e.type === 'tool.call');

  const steps = calls.map((e, i) => {
    const args = e.args && typeof e.args === 'object' ? e.args : {};
    const wasBlocked = e.constraint?.blocked === true;
    const wasDenied = e.permission?.decision === 'deny';
    // 今天的约束判定（零约束时 compiled.active=false，checkPreTool 直接返回空 —— 不制造假结论）
    const cv = compiled.active ? checkPreTool(compiled, e.name, args) : null;
    const nowBlocked = cv?.blocked === true;
    const pv = evaluatePermission(permission, e.name, args);
    const nowDenied = pv.decision === 'deny';

    let kind = KIND.UNCHANGED;
    if (nowBlocked && !wasBlocked) kind = KIND.NOW_BLOCKED;
    else if (nowDenied && !wasDenied) kind = KIND.NOW_DENIED;
    else if (nowBlocked && wasBlocked) kind = KIND.STILL_BLOCKED;
    else if (!nowBlocked && wasBlocked) kind = KIND.RELAXED;

    return {
      index: i + 1,
      callId: e.callId ?? null,
      name: e.name ?? null,
      pack: e.pack ?? null,
      argsDigest: e.argsDigest ?? null,
      then: { permission: e.permission?.decision ?? null, blocked: wasBlocked, constraintId: e.constraint?.id ?? null },
      now: { permission: pv.decision, permissionReason: pv.reason, permissionRule: pv.rule, blocked: nowBlocked, constraintId: cv?.event?.id ?? null, constraintReason: cv?.reason ?? null },
      kind,
    };
  });

  const count = (/** @type {string} */ k) => steps.filter((s) => s.kind === k).length;
  const summary = {
    total: steps.length,
    nowBlocked: count(KIND.NOW_BLOCKED),
    nowDenied: count(KIND.NOW_DENIED),
    stillBlocked: count(KIND.STILL_BLOCKED),
    relaxed: count(KIND.RELAXED),
    unchanged: count(KIND.UNCHANGED),
  };

  const notes = [];
  if (!compiled.active) {
    notes.push('当前没有任何生效的领域约束（未挂载 Pack 或未配置 constraints）——因此不可能出现「被红线拦住」的结果，本次回放只能证明这一点。');
  }
  if (steps.length && start?.permission && start.permission !== (typeof permission === 'string' ? permission : permission?.mode)) {
    notes.push(`账本记录的是 ${start.permission} 档权限，本次按 ${typeof permission === 'string' ? permission : permission?.mode} 档重判——差异可能来自权限档位变化，而不只是规则变化。`);
  }
  notes.push('回放基于账本中**已脱敏**的参数：若某条规则依赖被掩码的内容，回放可能不命中。');
  notes.push('回放只重判「决策」，不重跑工具、不重放模型输出（模型非确定性，见 docs/PLAN-v0.6.0.md C0.5）。');

  return { ok: true, runId, recordedAt: start?.at ?? null, recordedModel: start?.model ?? null, steps, summary, notes };
}

/** 人读报告 */
export function renderReplay(/** @type {any} */ r) {
  if (r.error) return r.error + '\n';
  const lines = [];
  const LABEL = {
    [KIND.NOW_BLOCKED]: '⛔ 今天会被红线拦住',
    [KIND.NOW_DENIED]: '🔑 今天的权限规则会拒',
    [KIND.STILL_BLOCKED]: '⛔ 当时与今天都被拦',
    [KIND.RELAXED]: '⚠ 当时被拦、今天放行',
    [KIND.UNCHANGED]: '· 无变化',
  };
  lines.push(`# 决策回放 ${r.runId}`);
  lines.push('');
  lines.push(`- 记录时的模型：${r.recordedModel ?? '—'}`);
  lines.push(`- 工具调用：${r.summary.total} 步`);
  lines.push(`- 差异：今天会被红线拦住 ${r.summary.nowBlocked} · 今天会被权限拒绝 ${r.summary.nowDenied} · 仍被拦 ${r.summary.stillBlocked} · 放宽 ${r.summary.relaxed} · 无变化 ${r.summary.unchanged}`);
  lines.push('');
  lines.push('| # | 工具 | 当时 | 今天 | 结论 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const s of r.steps) {
    const thenTxt = `${s.then.permission ?? '—'}${s.then.blocked ? ' + 红线拦' : ''}`;
    const nowTxt = `${s.now.permission}${s.now.blocked ? ' + 红线拦' : ''}`;
    lines.push(`| ${s.index} | ${s.name}${s.pack ? ` (${s.pack})` : ''} | ${thenTxt} | ${nowTxt} | ${LABEL[s.kind] ?? s.kind} |`);
  }
  lines.push('');
  for (const s of r.steps) {
    if (s.kind === KIND.UNCHANGED) continue;
    const detail = s.kind === KIND.NOW_BLOCKED || s.kind === KIND.STILL_BLOCKED
      ? s.now.constraintReason
      : s.kind === KIND.NOW_DENIED
        ? `权限判定：${s.now.permission}（${s.now.permissionReason}${s.now.permissionRule ? '，规则 ' + s.now.permissionRule : ''}）`
        : '当时被拦，今天的规则下会放行';
    lines.push(`- 第 ${s.index} 步 ${s.name}：${detail ?? ''}`);
  }
  lines.push('');
  for (const n of r.notes) lines.push(`> ${n}`);
  return lines.join('\n') + '\n';
}

export { KIND };
