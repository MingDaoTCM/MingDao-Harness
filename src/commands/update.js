// 命令族：mingdao update / rollback / batch / cost / audit（自 cli.js 拆出，评估 P0-1 拆包）
// 每个 handler 返回 true 表示已处理（主流程 return）；false 表示按普通提问继续（子命令劫持防护）。
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.js';

export async function handleUpdateFamily(/** @type {any} */ cmd, /** @type {any} */ args) {
  // 价格表外置刷新（Hermes C1）：mingdao update --pricing —— 从 cfg.pricing.source 拉取官方价格 JSON
  if (cmd === 'update' && args.includes('--pricing')) {
    const cfg = loadConfig();
    if (!cfg) { console.log('[错误] 未初始化配置：请先运行 mingdao init'); process.exitCode = 1; return true; }
    const { refreshPricingFromSource } = await import('../pricing.js');
    const r = await refreshPricingFromSource(cfg);
    console.log(r.lines.join('\n'));
    process.exitCode = r.ok ? 0 : 1;
    return true;
  }
  // 自更新与回滚（git 安装形态）。
  // 评估 P3-1 子命令劫持防护：参数不合法时回退为普通提问（如 "mingdao update the docs" 是提问而非更新命令）
  if (cmd === 'update' && args.every((/** @type {any} */ a) => a === '--check')) {
    const { updateCheck, mingdaoUpdate } = await import('../update.js');
    const checkOnly = args.includes('--check');
    const r = await (checkOnly ? updateCheck() : mingdaoUpdate());
    console.log(r.lines?.join('\n') || '');
    process.exitCode = r.ok ? 0 : 1;
    return true;
  }
  if (cmd === 'rollback' && args.length === 0) {
    const { mingdaoRollback } = await import('../update.js');
    const r = mingdaoRollback();
    console.log(r.lines?.join('\n') || '');
    process.exitCode = r.ok ? 0 : 1;
    return true;
  }

  // Batch API 半价批处理（A1/B2）：mingdao batch <问题文件|-> [--model 名] [--max-tokens n] [--max-cost 元]
  if (cmd === 'batch') {
    const { runBatch } = await import('../batch.js');
    const cfgB = loadConfig();
    if (!cfgB) {
      console.log('[错误] 未初始化配置：请先运行 mingdao init');
      process.exitCode = 1;
      return true;
    }
    let model = cfgB.model || 'deepseek-v4-flash';
    let maxTokens = 4096;
    let maxCost = 0; // 省钱 B2：预算上限（元），提交前按估算拦截
    let srcFile = null;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--model') model = args[++i];
      else if (a === '--max-tokens') maxTokens = Number(args[++i]) || 4096;
      else if (a === '--max-cost') maxCost = Number(args[++i]) || 0;
      else if (a === '--out') { i += 1; /* 输出默认落工作目录 */ }
      else if (!srcFile) srcFile = a;
    }
    if (!srcFile) {
      console.log('用法：mingdao batch <问题文件|-> 每行一个问题（--model 名 --max-tokens n --max-cost 元）');
      process.exitCode = 1;
      return true;
    }
    let questions = [];
    try {
      const raw = srcFile === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(srcFile, 'utf8');
      questions = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 1000);
    } catch (err) {
      console.log('[错误] 读取问题文件失败：' + ((/** @type {any} */ (err))?.message || err));
      process.exitCode = 1;
      return true;
    }
    if (!questions.length) {
      console.log('[错误] 问题文件为空');
      process.exitCode = 1;
      return true;
    }
    console.log(`Batch 半价批处理：${questions.length} 个问题 · 模型 ${model}（价格 ×${0.5}，结果异步返回，最长 24h）`);
    const ac = new AbortController();
    process.on('SIGINT', () => ac.abort());
    const r = await runBatch({
      cfg: cfgB,
      model,
      questions,
      workingDir: process.cwd(),
      maxTokens,
      maxCost,
      signal: ac.signal,
      onStatus: (/** @type {any} */ st) => console.log('  ' + st),
    });
    process.removeAllListeners('SIGINT');
    if (r.error) {
      console.log('[错误] ' + r.error);
      process.exitCode = 1;
      return true;
    }
    const rr = /** @type {any} */ (r);
    console.log(`✓ 完成 ${rr.results.length} 条 · ↑${rr.usage.prompt_tokens} ↓${rr.usage.completion_tokens} tokens · 费用 ≈¥${rr.cost.toFixed(5)}（已按半价）`);
    if (r.deduped) console.log(`  （去重合并 ${r.deduped} 条重复问题，结果已回填全部位置）`);
    console.log(`  结果文件：${r.outputFile}`);
    console.log(`  任务 ID：${r.batchId}（结果已计入 /cost 分账）`);
    return true;
  }

  // 费用报告（/cost 月度导出）：mingdao cost [report [YYYY-MM|all]]
  if (cmd === 'cost') {
    const valid = args.length === 0 || (args.length >= 1 && args[0] === 'report' && args.length <= 2 && (!args[1] || args[1] === 'all' || /^\d{4}-\d{2}$/.test(args[1])));
    if (!valid) return false; // 参数不合法 → 按提问处理
    const { costMonthlyReport } = await import('../cachestats.js');
    const months = args.length === 0 ? null : args[1] && args[1] !== 'all' ? args[1] : null;
    const rows = costMonthlyReport(months);
    if (!rows.length) {
      console.log(args.length === 0 ? '暂无费用数据（对话若干轮后自动累积）。' : `没有 ${months || '任何'} 月份的记录。`);
      return true;
    }
    if (args.length === 0) {
      const total = rows.reduce((s, r) => s + r.cost, 0);
      console.log(`累计费用 ≈¥${total.toFixed(5)}（${rows.length} 个月份）· 最近：`);
      for (const r of rows.slice(-3)) {
        console.log(`  ${r.month}：≈¥${r.cost.toFixed(5)}${r.rate != null ? ` · 命中 ${(r.rate * 100).toFixed(0)}%` : ''}`);
      }
      console.log('月度报告导出：mingdao cost report [YYYY-MM|all]');
      return true;
    }
    const bar = (/** @type {any} */ cost, /** @type {any} */ max) => '█'.repeat(Math.max(1, Math.round((cost / max) * 20)));
    const md = [];
    for (const r of rows) {
      const maxDay = Math.max(...r.days.map((d) => d.cost), 1e-9);
      md.push(`# MingDao 费用报告 ${r.month}`);
      md.push('');
      md.push(`- 实际费用 ≈¥${r.cost.toFixed(5)}${r.batchCost > 0 ? `（含 Batch 半价任务 ≈¥${r.batchCost.toFixed(5)}）` : ''}`);
      md.push(`- 相比全未命中已节省 ≈¥${r.saved.toFixed(5)}${r.rate != null ? ` · 缓存命中率 ${(r.rate * 100).toFixed(0)}%` : ''}`);
      md.push(`- Tokens：↑${r.prompt} / ↓${r.completion}${r.reasoning ? ` · 推理 ${r.reasoning}` : ''}`);
      md.push('');
      md.push('## 按模型分账');
      md.push('');
      md.push('| 模型 | 轮次 | ↑prompt | ↓completion | 费用 |');
      md.push('| --- | --- | --- | --- | --- |');
      for (const m of r.models) md.push(`| ${m.model} | ${m.turns} | ${m.prompt} | ${m.completion} | ≈¥${m.cost.toFixed(5)} |`);
      if (r.tools.length) {
        md.push('');
        md.push('## 按工具分账');
        md.push('');
        md.push('| 工具 | 调用 | 耗时(ms) |');
        md.push('| --- | --- | --- |');
        for (const t of r.tools.slice(0, 10)) md.push(`| ${t.tool} | ${t.calls} | ${t.ms} |`);
      }
      md.push('');
      md.push('## 每日费用');
      md.push('');
      md.push('```');
      for (const d of r.days) md.push(`${d.day}  ${bar(d.cost, maxDay)}  ¥${d.cost.toFixed(5)}`);
      md.push('```');
      md.push('');
    }
    const outFile = path.join(process.cwd(), `mingdao-cost-report-${rows.length === 1 ? rows[0].month : 'all'}.md`);
    fs.writeFileSync(outFile, md.join('\n') + '\n');
    console.log(`✓ 已导出 ${rows.length} 个月份报告 → ${outFile}`);
    return true;
  }

  // 审计日志查看（P3-5）：mingdao audit [数量]（仅裸命令或单个数字；其余按提问处理）
  if (cmd === 'audit' && (args.length === 0 || (args.length === 1 && /^\d+$/.test(args[0])))) {
    const { listAudit, auditFile } = await import('../audit.js');
    const n = Number(args[0]) || 20;
    const rows = listAudit(n);
    if (!rows.length) {
      console.log(`暂无审计记录（工具调用将自动记录到 ${auditFile()}）。`);
      return true;
    }
    console.log(`审计日志（最近 ${rows.length} 条）：${auditFile()}`);
    for (const r of rows) {
      const when = new Date(r.at).toISOString().slice(0, 19).replace('T', ' ');
      const status = r.denied ? `✖拒绝(${r.reason || ''})` : r.ok ? '✓' : '✖错误';
      const extra = !r.denied && r.timedOut ? '（超时）' : !r.denied && r.exitCode !== null && r.exitCode !== undefined ? `（exit ${r.exitCode}）` : '';
      const sess = r.session ? `  [会话 ${String(r.session).slice(0, 28)}]` : '';
      console.log(`  ${when}  ${status} ${r.tool} ${(r.args || '').slice(0, 80)} ${extra}${sess}`);
    }
    return true;
  }
  return false;
}
