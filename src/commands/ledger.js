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

/** @param {any} cmd @param {any} args */
export async function handleLedger(cmd, args) {
  const io = createIO();
  const sub = args[0] || 'list';
  const rest = args.slice(1);
  const flag = (/** @type {string} */ name, /** @type {any} */ dflt = null) => {
    const i = rest.indexOf(name);
    return i >= 0 && rest[i + 1] ? rest[i + 1] : dflt;
  };
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
    return true;
  }
  const events = readRun(runId);
  if (!events.length) {
    io.print(`没有找到账本 ${runId}。用 mingdao ledger list 查看现有账本。`);
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
    if (v.ok) {
      io.print(`✅ ${runId} 哈希链完整（${v.total} 条事件未被改动）。`);
    } else {
      io.print(style(`❌ ${runId} 校验失败：${v.error}`, C.red));
      process.exitCode = 1;
    }
    io.print(style('说明：哈希链只能证明「自写入后未被改动」，不含可信时间戳，不等同于审计级不可否认。', C.dim));
    return true;
  }

  if (sub === 'export') {
    const format = String(flag('--format', 'json'));
    if (format !== 'json' && format !== 'md') {
      io.print('--format 只支持 json 或 md');
      return true;
    }
    const r = exportRun(runId, { format });
    if (r.error) {
      io.print(r.error);
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

  io.print('用法：mingdao ledger list [数量] | show <runId> | export <runId> [--format json|md] [--out 文件] | verify <runId>');
  return true;
}
