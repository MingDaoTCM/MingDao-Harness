// 命令族：mingdao ledger（v0.6.0 阶段 C1）
//   list                     最近若干次运行（时间/模型/事件数/状态/费用）
//   show <runId>             人读明细（默认最近一次）
//   export <runId> [--format json|md] [--out <文件>]   脱敏导出（对外的最小可用产物）
//   verify <runId>           校验哈希链（能发现改行/删行）
//
// 诚实边界（不写清楚就等于暗示）：
//   · 哈希链只能证明「自写入后未被改动」，**不含可信时间戳**，不等同于审计级不可否认；
//   · 导出物已按「密钥 + 私网 IP + 家目录」两级规则脱敏，但**明细字段本身经过截断**，
//     它不是原始数据的完整副本，不能当作证据原件保存。

import fs from 'node:fs';
import { createIO, style, C } from '../ui.js';
import { listRuns, readRun, verifyRun, exportRun, isValidRunId, ledgerDir } from '../ledger.js';
import { replayRun, renderReplay, KIND } from '../replay.js';
import { loadConfig } from '../config.js';
import { getActivePackContext, mountPacks } from '../packs.js';

/** 用法串：未知子命令与用法提示共用一份，避免两处漂移 */
const USAGE = '用法：mingdao ledger list [数量] | show <runId> | export <runId> [--format json|md] [--out 文件] | verify <runId> | replay <runId> [--json]';
const KNOWN_SUBS = new Set(['list', 'show', 'verify', 'replay', 'export']);

/** @param {any} cmd @param {any} args */
export async function handleLedger(cmd, args) {
  const io = createIO();
  const sub = args[0] || 'list';
  const rest = args.slice(1);
  // v0.6.3（M-21）：未知子命令此前会一路走到函数末尾「打印用法并退 0」，脚本/CI 无法与
  // 「命令成功」区分。这里**先**判子命令——顺序很重要：放在 runId 解析之后会被
  // 「runId 格式不合法」分支抢先命中，于是同样的输入有时退 1、有时退 0。
  if (!KNOWN_SUBS.has(sub)) {
    io.print(USAGE);
    process.exitCode = 1;
    return true;
  }
  const flag = (/** @type {string} */ name, /** @type {any} */ dflt = null) => {
    const i = rest.indexOf(name);
    return i >= 0 && rest[i + 1] ? rest[i + 1] : dflt;
  };
  // v0.6.3（M-12）：布尔开关必须与「取值型参数」分开解析。
  // 原实现只有上面的取值型 `flag()`：`--json` 写在末尾时取不到「下一个值」→ 返回 null →
  // `ledger replay <id> --json` 恒走人读分支，`| jq` 直接失败（而且失败得很安静）。
  const boolFlag = (/** @type {string} */ name) => rest.includes(name);
  // 位置参数：排除掉 --xxx 及其取值
  const positional = rest.filter((/** @type {any} */ a, /** @type {number} */ i) => !String(a).startsWith('--') && !String(rest[i - 1] || '').startsWith('--'));

  if (sub === 'list') {
    const runs = listRuns();
    if (!runs.length) {
      io.print('还没有执行账本（跑一次对话后自动生成）。');
      io.print(style(`账本目录：${ledgerDir()}`, C.dim));
      return true;
    }
    io.print(style(`执行账本（${runs.length} 次，目录 ${ledgerDir()}）`, C.bold));
    const limit = Math.max(1, Math.min(Number(positional[0]) || 20, 200));
    for (const r of runs.slice(0, limit)) {
      const when = r.at ? new Date(r.at).toLocaleString('zh-CN', { hour12: false }) : '—';
      const cost = r.priced ? `¥${Number(r.yuanTotal ?? 0).toFixed(4)}` : '无法估算';
      io.print(`  ${r.runId}  ${when}  ${String(r.model ?? '—').padEnd(20)} ${String(r.events).padStart(3)} 事件  ${r.status}  ${cost}`);
    }
    io.print(style('  查看：mingdao ledger show <runId> · 导出：mingdao ledger export <runId> --format md', C.dim));
    return true;
  }

  // 其余子命令都需要一个 runId；缺省取最近一次
  const runId = positional[0] || listRuns()[0]?.runId;
  if (!runId) {
    io.print('还没有执行账本（跑一次对话后自动生成）。');
    return true;
  }
  if (!isValidRunId(runId)) {
    io.print(`runId 格式不合法：${runId}（形如 mtx16g3y-628443）`);
    // v0.6.3（M-21）：凡是「用户要求的事没做成」，退出码必须是 1。
    // 此前 `ledger verify <乱写的 id>` 会打印一行错误然后退 0，CI 拿它当门禁即假通过。
    process.exitCode = 1;
    return true;
  }
  const events = readRun(runId);
  if (!events.length) {
    io.print(`没有找到账本 ${runId}。用 mingdao ledger list 查看现有账本。`);
    process.exitCode = 1;
    return true;
  }

  if (sub === 'show') {
    const md = exportRun(runId, { format: 'md' });
    if (md.error) {
      io.print(md.error);
      return true;
    }
    io.print(String(md.text ?? '').trimEnd());
    return true;
  }

  if (sub === 'verify') {
    const v = verifyRun(runId);
    if (v.ok && v.sealed) {
      io.print(`✅ ${runId} 校验通过：${v.total} 条事件链内一致，且与封条吻合（未被改动、尾部未被截断）。`);
    } else if (v.ok) {
      // 链内一致 ≠ 完整。原实现只报「哈希链完整」，把「尾部被删掉一截」说成了完整。
      io.print(style(`⚠ ${runId} 链内一致（${v.total} 条事件），但完整性无法确认：${v.warning}。`, C.yellow));
      process.exitCode = 1;
    } else {
      io.print(style(`❌ ${runId} 校验失败：${v.error}`, C.red));
      process.exitCode = 1;
    }
    io.print(style('说明：哈希链 + 封条只能证明「自写入后未被改动、尾部未被截断」，不含可信时间戳，不等同于审计级不可否认。', C.dim));
    return true;
  }

  if (sub === 'replay') {
    // 当前规则栈：显式配置的 constraints 优先，否则取进程级已挂载的 Pack 约束；
    // 权限取 config.permission（缺省 ask）。回放**不联网、无副作用**。
    const cfg = loadConfig() || {};
    // v0.6.3（P1-12）：CLI 的命令分发发生在 cli.js 的 mountPacks **之前**，因此
    // `getActivePackContext()` 在这里恒为 null → constraints=[] → compiled.active=false →
    // 回放恒输出「当前没有任何生效的领域约束」，**恒通过**。把它当 CI 门禁时是静默假阴性。
    // 与启动路径同口径地挂一次 Pack（幂等），让「新红线能不能拦住历史操作」这个问题
    // 在 CLI 下真正有答案。
    if (!Array.isArray(cfg.constraints) && !getActivePackContext()) {
      try {
        await mountPacks(cfg, { cwd: process.cwd() });
      } catch (/** @type {any} */ e) {
        io.print(style(`⚠ Pack 挂载失败，本次回放将看不到 Pack 约束：${e?.message || e}`, C.yellow));
      }
    }
    const currentConstraints = Array.isArray(cfg.constraints) ? cfg.constraints : getActivePackContext()?.constraints ?? [];
    const asJson = boolFlag('--json');
    const r = replayRun(runId, { constraints: currentConstraints, permission: cfg.permission ?? 'ask' });
    if (r.error || !r.summary) {
      io.print(String(r.error ?? '回放失败'));
      process.exitCode = 1;
      return true;
    }
    const summary = r.summary;
    if (asJson) {
      io.print(JSON.stringify({ runId: r.runId, summary, steps: r.steps, notes: r.notes }, null, 2));
    } else {
      io.print(renderReplay(r).trimEnd());
    }
    // 非零退出码让它能当门禁用：CI 里「新红线必须能拦住历史上那批操作」就是这个断言
    if (summary.nowBlocked > 0) {
      process.exitCode = 1;
      if (!asJson) io.print(style(`\n↑ 有 ${summary.nowBlocked} 步今天会被红线拦住：若这正是新红线的目的，回放通过；否则说明规则收得过紧。`, C.yellow));
    }
    return true;
  }

  if (sub === 'export') {
    const format = String(flag('--format', 'json'));
    if (format !== 'json' && format !== 'md') {
      io.print('--format 只支持 json 或 md');
      process.exitCode = 1;
      return true;
    }
    const r = exportRun(runId, { format });
    if (r.error) {
      io.print(r.error);
      process.exitCode = 1;
      return true;
    }
    const out = flag('--out');
    if (out) {
      try {
        fs.writeFileSync(out, String(r.text ?? ''), { mode: 0o600 });
        io.print(`已导出 ${runId}（${format}）→ ${out}（权限 600）。`);
        io.print(style('导出物已脱敏（密钥 + 私网 IP + 家目录），可交给第三方复核。', C.dim));
      } catch (/** @type {any} */ e) {
        io.print(`写入失败：${e?.message || e}`);
        process.exitCode = 1;
      }
    } else {
      io.print(String(r.text ?? '').trimEnd());
    }
    return true;
  }

  // v0.6.3（M-21）：未知子命令此前静默落到「打印用法并退 0」——CI/脚本无法区分
  // 「用法提示」与「命令成功」。这是退出码语义的静默失效，明确退 1。
  io.print('用法：mingdao ledger list [数量] | show <runId> | export <runId> [--format json|md] [--out 文件] | verify <runId> | replay <runId> [--json]');
  process.exitCode = 1;
  return true;
}
