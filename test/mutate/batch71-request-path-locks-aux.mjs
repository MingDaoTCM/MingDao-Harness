// 批七十一（v0.7.0 §1.4 第二提交）：聊天收尾 / 工具执行路径的同步锁变异验证。
//
// 这两条路径是"每回合 / 每次工具调用"取锁，冻结频率比 schedule 更高：
//   · `cachestats.recordUsageAsync` —— WebUI 聊天收尾（server.js 的 onUsage + 回合末补记）；
//   · `audit.writeAuditAsync`       —— 工具执行（agent.js 的 pre/post 审计与约束事件）。
// 每条变异把异步入口改回缺陷形态，`test/request-path-locks.js` 必须当场红（关键词见 expect）。
import { makeMutator } from './lib.mjs';

const M = makeMutator();
const RUN = () => M.suite('test/request-path-locks.js');

M.mutate({
  name: '① writeAuditAsync 改回同步锁（工具执行路径冻结）',
  file: 'src/audit.js',
  from: '    await withFileLock(auditFile() + \'.lock\', () => appendAuditUnderLock(entry));',
  to: '    withFileLockSync(auditFile() + \'.lock\', () => appendAuditUnderLock(entry));',
  expect: ['工具执行路径的审计等待期间事件循环不得冻结'],
  run: RUN,
});

M.mutate({
  name: '② writeAuditAsync 去掉锁（持锁期间直接写，互斥失效且根本没等）',
  file: 'src/audit.js',
  from: '    await withFileLock(auditFile() + \'.lock\', () => appendAuditUnderLock(entry));',
  to: '    appendAuditUnderLock(entry);',
  expect: ['前提：writeAuditAsync 必须真的等到审计锁释放'],
  run: RUN,
});

M.mutate({
  name: '③ writeAuditAsync 只等锁不写（审计证据静默丢失）',
  file: 'src/audit.js',
  from: '    await withFileLock(auditFile() + \'.lock\', () => appendAuditUnderLock(entry));',
  to: '    await withFileLock(auditFile() + \'.lock\', () => {});',
  expect: ['锁释放后审计必须真的落盘'],
  run: RUN,
});

M.mutate({
  name: '④ recordUsageAsync 改回同步锁（聊天收尾路径冻结）',
  file: 'src/cachestats.js',
  from: '    await withFileLock(cacheStatsFile() + \'.lock\', () => appendCacheStatsUnderLock(line, () => {',
  to: '    withFileLockSync(cacheStatsFile() + \'.lock\', () => appendCacheStatsUnderLock(line, () => {',
  expect: ['聊天收尾路径的计费等待期间事件循环不得冻结'],
  run: RUN,
});

M.mutate({
  name: '⑤ recordUsageAsync 去掉锁（持锁期间直接写，互斥失效且根本没等）',
  file: 'src/cachestats.js',
  from: '    await withFileLock(cacheStatsFile() + \'.lock\', () => appendCacheStatsUnderLock(line, () => {\n      appended = true;\n    }));',
  to: '    appendCacheStatsUnderLock(line, () => {\n      appended = true;\n    });',
  expect: ['前提：recordUsageAsync 必须真的等到费用锁释放'],
  run: RUN,
});

M.mutate({
  name: '⑥ recordUsageAsync 只等锁不写（费用明细静默丢账）',
  file: 'src/cachestats.js',
  from: '    await withFileLock(cacheStatsFile() + \'.lock\', () => appendCacheStatsUnderLock(line, () => {\n      appended = true;\n    }));',
  to: '    await withFileLock(cacheStatsFile() + \'.lock\', () => {});',
  expect: ['锁释放后必须真的写出 1 条用量'],
  run: RUN,
});

M.mutate({
  name: '⑦ 工具执行路径退回同步 writeAudit（agent.js）',
  file: 'src/agent.js',
  from: '            await writeAuditAsync({',
  to: '            writeAudit({',
  expect: ['agent.js 不得再调用同步 writeAudit('],
  run: RUN,
});

M.mutate({
  name: '⑧ 聊天收尾退回同步 recordUsage（web/server.js）',
  file: 'src/web/server.js',
  from: '      usageWriteChain = usageWriteChain.then(() => recordUsageAsync(modelName, delta, null)).catch(() => {});',
  to: '      recordUsage(modelName, delta, null);',
  expect: ['web/server.js 不得再调用同步 recordUsage('],
  run: RUN,
});

M.mutate({
  name: '⑨ CLI 同步版 writeAudit 被误改成 async（调用方不 await）',
  file: 'src/audit.js',
  from: 'export function writeAudit(',
  to: 'export async function writeAudit(',
  expect: ['writeAudit 不得变成 async'],
  run: RUN,
});

const ok = M.report();
process.exit(ok ? 0 : 1);
