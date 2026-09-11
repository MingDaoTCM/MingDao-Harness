// 命令族：mingdao net（v0.6.0 阶段 C3）
//   report [--since 7d|24h|<数字小时>] [--json]   本机这段时间访问了哪些外部地址
//   policy                                        当前出网策略与生效状态
//
// 这个命令的用途是**自证**：把「数据不出门」从口头承诺变成可导出的记录。
// 因此输出必须同时说清它**证明不了什么**（见文件末尾的边界说明），否则就是在误导采购/测评方。

import { createIO, style, C } from '../ui.js';
import { loadConfig } from '../config.js';
import { parseNetPolicy } from '../net-policy.js';
import { readEgressLog, summarizeEgress, egressLogFile, currentPolicy, isInstalled } from '../net-guard.js';

/** 解析 --since：支持 7d / 24h / 90m / 纯数字（小时） */
function parseSince(/** @type {any} */ v) {
  if (!v) return 0;
  const m = /^(\d+(?:\.\d+)?)([dhm]?)$/.exec(String(v).trim());
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2] || 'h';
  const ms = unit === 'd' ? n * 86400000 : unit === 'm' ? n * 60000 : n * 3600000;
  return Date.now() - ms;
}

/** @param {any} cmd @param {any} args */
export async function handleNet(cmd, args) {
  const io = createIO();
  const sub = args[0] || 'report';
  const cfg = loadConfig() || {};

  if (sub === 'policy') {
    const pol = parseNetPolicy(cfg.net);
    if (!pol.enabled) {
      io.print('出网白名单：**未配置**（闸门未安装，一切放行且不记账）。');
      io.print(style('启用方式：config.json 增加 {"net":{"allow":["api.deepseek.com","10.0.0.0/8"],"mode":"warn|block"}}', C.dim));
      io.print(style('说明：回环地址（localhost/127.x）始终豁免——它出不了本机，不计为外发。', C.dim));
      return true;
    }
    io.print(style(`出网白名单：已配置（mode=${pol.mode}，${pol.allow.length} 条规则，本进程${isInstalled() ? '已' : '未'}安装闸门）`, C.bold));
    io.print(`  规则：${pol.allow.length ? pol.allow.join(' · ') : '（空：除回环外全部拦截）'}`);
    io.print(style(`  回环豁免：${pol.allowLoopback ? '开' : '关'}`, C.dim));
    io.print(style(`  记账文件：${egressLogFile()}`, C.dim));
    if (pol.mode === 'warn') {
      io.print(style('  当前为 warn：越界请求会放行但逐条记账——用于「先观测再收紧」。', C.dim));
    }
    return true;
  }

  if (sub === 'report') {
    const sinceMs = parseSince((() => {
      const i = args.indexOf('--since');
      return i >= 0 ? args[i + 1] : null;
    })());
    const entries = readEgressLog({ sinceMs: sinceMs || 0 });
    const s = summarizeEgress(entries);
    if (args.includes('--json')) {
      io.print(JSON.stringify({ since: s.since, until: s.until, total: s.total, blocked: s.blocked, hosts: s.hosts }, null, 2));
      return true;
    }
    const pol = currentPolicy() || parseNetPolicy(cfg.net);
    io.print(style(`出网记录（${sinceMs ? '自 ' + new Date(sinceMs).toLocaleString('zh-CN', { hour12: false }) + ' 起' : '全部'}）`, C.bold));
    if (!s.total) {
      io.print('  没有记录。');
      io.print(style(pol?.enabled ? '  （白名单已启用：说明这段时间内核没有向白名单外的地址发过请求）' : '  （白名单未启用：闸门未安装，因此本就没有记账）', C.dim));
    } else {
      io.print(`  共 ${s.total} 次出网，其中 ${s.blocked} 次不在白名单内；涉及 ${s.hosts.length} 个地址。`);
      io.print('');
      io.print('  次数  放行/拦截  地址                          命中规则');
      for (const h of s.hosts.slice(0, 50)) {
        const mark = h.denied > 0 ? style('拦截', C.red) : style('放行', C.green);
        io.print(`  ${String(h.total).padStart(4)}  ${mark}      ${h.host.padEnd(30)} ${h.rules.join(',') || '—'}`);
      }
      if (s.hosts.length > 50) io.print(style(`  …另有 ${s.hosts.length - 50} 个地址未列出`, C.dim));
    }
    io.print('');
    io.print(style(`记账文件：${egressLogFile()}（只记主机/端口/判定，**不记请求体**）`, C.dim));
    io.print(style('边界：本记录只覆盖**内核自己发起**的请求（模型 API / fetch 工具 / 技能库 / 同步 / 模型发现）。', C.dim));
    io.print(style('      用户在 bash 里自己敲的 curl 走子进程网络栈，不在此列——它证明「内核没有偷偷外传」，', C.dim));
    io.print(style('      不等于「这台机器绝对没有外传」。把它当后者用就是误用。', C.dim));
    return true;
  }

  io.print('用法：mingdao net report [--since 7d|24h|90m] [--json] | mingdao net policy');
  return true;
}
