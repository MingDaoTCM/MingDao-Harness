// 命令族：mingdao ledger（v0.6.0 阶段 C1）
//   list                     最近若干次运行（时间/模型/事件数/状态/费用）
//   show <runId>             人读明细（默认最近一次）
//   export <runId> [--format json|md] [--out <文件>]   脱敏导出（对外的最小可用产物）
//   verify <runId> [--key <文件>]   校验哈希链 + 封条 + **来源签名**（v0.6.11）
//   replay <runId> [--json]  离线回放
//   --sign-key [--generate|--force] 查看/生成本机账本签名密钥（v0.6.11）
//
// 诚实边界（不写清楚就等于暗示）：
//   · 哈希链只能证明「自写入后未被改动」，**不含可信时间戳**，不等同于审计级不可否认；
//   · 来源签名（ed25519）能回答「是不是持有那把密钥的一方写的」，但私钥与账本同机同权限：
//     能改账本的对手通常也能读私钥，故本层主要防「换一台机器/换一把密钥伪造来源」，
//     不防同权限的本机对手——这条边界必须跟着结论一起说出口；
//   · 导出物已按「密钥 + 私网 IP + 家目录」两级规则脱敏，但**明细字段本身经过截断**，
//     它不是原始数据的完整副本，不能当作证据原件保存。

import fs from 'node:fs';
import { createIO, style, C } from '../ui.js';
import { listRuns, readRun, verifyRun, exportRun, isValidRunId, ledgerDir, ledgerKeyPath, readLedgerKeyStrict, generateLedgerKey, provenanceText } from '../ledger.js';
import { replayRun, renderReplay, KIND } from '../replay.js';
import { loadConfig } from '../config.js';
import { getActivePackContext, mountPacks } from '../packs.js';

/** 用法串：未知子命令与用法提示共用一份，避免两处漂移 */
const USAGE = '用法：mingdao ledger list [数量] | show <runId> | export <runId> [--format json|md] [--out 文件] | verify <runId> [--key 文件] | replay <runId> [--json] | --sign-key [--generate|--force]';
const KNOWN_SUBS = new Set(['list', 'show', 'verify', 'replay', 'export']);

/** 打印签名密钥状态：**只说指纹与路径，绝不回显私钥**（同 credentials 的 maskKey 口径） */
function printKeyStatus(/** @type {any} */ io) {
  const p = ledgerKeyPath();
  const r = readLedgerKeyStrict();
  if (r.ok && r.key) {
    io.print(style('账本来源签名密钥', C.bold));
    io.print(`  文件：${p}（权限 600，绝不进 config.json / 凭证库 / 仓库）`);
    io.print(`  算法：ed25519 · 公钥指纹 keyId=${r.key.keyId}${r.key.createdAt ? ` · 创建于 ${new Date(r.key.createdAt).toLocaleString('zh-CN', { hour12: false })}` : ''}`);
    // 公钥是**公开**信息，正好用来交给第三方复核（私钥永不打印、永不导出）
    io.print(style(`  公钥（可交给第三方验签，不含私钥）：${r.key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')}`, C.dim));
    io.print(style('  换密钥会让此前所有已签账本变成「另一把密钥签发」；要用旧密钥验签请：mingdao ledger verify <runId> --key <旧密钥文件>', C.dim));
    return true;
  }
  if (r.ok && r.missing) {
    io.print('本机还没有账本来源签名密钥。');
    io.print(style(`生成：mingdao ledger --sign-key --generate（写入 ${p}，权限 600）`, C.dim));
    io.print(style('说明：新账本在首次收尾时会自动生成密钥并签名，无需手动初始化——这条命令是给「要确认/要换/要指定」的场景用的。', C.dim));
    return true;
  }
  io.print(style(`❌ 签名密钥不可用：${r.error}`, C.red));
  process.exitCode = 1;
  return true;
}

/** @param {any} cmd @param {any} args */
export async function handleLedger(cmd, args) {
  const io = createIO();
  const sub = args[0] || 'list';
  const rest = args.slice(1);
  // v0.6.11（§3.45）：`--sign-key` 是**选项形态**而不是子命令（请求形态就是 `ledger --sign-key`），
  // 所以必须在 KNOWN_SUBS 判定**之前**拦下——否则它会被当成"未知子命令"退 1，
  // 而用户敲的正是文档里写的那一行。
  const signKeyFlag = args.includes('--sign-key');
  if (signKeyFlag) {
    const generate = args.includes('--generate');
    const force = args.includes('--force');
    if (force && !generate) {
      io.print('--force 只与 --generate 连用（覆盖已有密钥必须是一次显式决定）');
      process.exitCode = 1;
      return true;
    }
    if (!generate) return printKeyStatus(io);
    const cur = readLedgerKeyStrict();
    const g = generateLedgerKey({ force });
    if (!g.ok) {
      io.print(style(`❌ ${g.error}`, C.red));
      process.exitCode = 1;
      return true;
    }
    io.print(`✅ 已生成账本签名密钥：${g.path}（权限 600）`);
    io.print(`   公钥指纹 keyId=${g.keyId} · 算法 ed25519`);
    io.print(style('   私钥只写在该文件里，本命令不打印完整密钥（文件内容即密钥，请按密钥对待）。', C.dim));
    if (cur.ok && cur.key && cur.key.keyId !== g.keyId) {
      io.print(style(`   ⚠ 已覆盖旧密钥（旧 keyId=${cur.key.keyId}）：此前用它签过的账本现在会报「由另一把密钥签发」。`, C.yellow));
    }
    io.print(style('   新写入的账本会自动带上来源签名；老账本（无签名）仍然校验通过并如实报告「无签名」。', C.dim));
    return true;
  }
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
    // v0.6.11（§3.45）：`--key <文件>` 用指定的公钥验签（默认本机 <home>/ledger-key.json）。
    // 为什么必须能指定：① 账本换过机器/换过密钥时要用**原密钥**复核；
    // ② 第三方审计手上只有公钥，逼他先在本机生成一把密钥就等于把伪造能力交出去。
    const v = verifyRun(runId, { keyPath: flag('--key') });
    const prov = provenanceText(v);
    if (!v.ok) {
      io.print(style(`❌ ${runId} 校验失败：${v.error}`, C.red));
      process.exitCode = 1;
    } else if (!v.sealed) {
      // 链内一致 ≠ 完整。原实现只报「哈希链完整」，把「尾部被删掉一截」说成了完整。
      io.print(style(`⚠ ${runId} 链内一致（${v.total} 条事件），但完整性无法确认：${v.warning}。`, C.yellow));
      io.print(`   来源签名：${prov}`);
      process.exitCode = 1;
    } else if (v.provenance === 'valid' || v.provenance === 'none') {
      // 三态里的**前两态**：链完整 + 签名有效 / 链完整但无签名。都退 0——
      // 老账本（写于启用签名之前）不能被升级判成坏账本，这是向后兼容的红线。
      io.print(`✅ ${runId} 校验通过：${v.total} 条事件链内一致，且与封条吻合（未被改动、尾部未被截断）。`);
      io.print(`   来源签名：${prov}`);
      if (v.provenance === 'none') {
        io.print(style('   （无签名只说明"这份账本没被签过"，不等于被篡改；要覆盖新账本请让签名密钥存在：mingdao ledger --sign-key --generate）', C.dim));
      }
      io.print(style('   说明：签名证明「写入方持有该密钥」，但私钥与账本同机同权限——不防能同时读写两者的本机对手。', C.dim));
    } else if (v.provenance === 'unverifiable') {
      // 第四态：**有签名但没公钥可验**（换机器复核、密钥被删/被换走）。它与"签名无效"是两件事——
      // 混成一句会让用户拿着"无效"去追一个并不存在的篡改；但同样**不能退 0**：
      // "无法确认来源"不等于通过，否则把账本拷到别的机器上就绕过了整条来源检查。
      io.print(style(`⚠ ${runId} 链完整，但来源签名无法校验：${v.provenanceError ?? prov}`, C.yellow));
      io.print(style(`   （哈希链与封条本身吻合：${v.total} 条事件未被改动、尾部未被截断；确认来源之前不得当作通过。）`, C.dim));
      process.exitCode = 1;
    } else {
      // 第三态：**链完整但签名无效**（被篡改后重算过链，或换了一把密钥）。链是自洽的，
      // 但来源不可信——按合规口径这必须是失败（非 0），否则 CI/审计拿它当门禁就是假通过。
      io.print(style(`❌ ${runId} 链完整但来源签名无效：${v.provenanceError ?? prov}`, C.red));
      io.print(style(`   （哈希链与封条本身吻合：${v.total} 条事件未被改动、尾部未被截断——问题出在「是谁写的」。）`, C.dim));
      process.exitCode = 1;
    }
    // 旧文案原样保留（既有输出字段只增不改）：用户与脚本此前依赖的这句仍然在。
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
  io.print(USAGE);
  process.exitCode = 1;
  return true;
}
