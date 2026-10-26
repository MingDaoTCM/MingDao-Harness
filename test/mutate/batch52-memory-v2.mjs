// 批五十二（v0.6.26 §3.91：内存恢复 v2——多级压缩 / 端点级学习 / 子代理继承）
//
// 真机证据（~/.mingdao/logs/web-server.log，10-18 / 10-19 / 10-26 三次同形态）：
//   08:59:14 chat 进度 … 子代理「审计网络与安全防线」已跑 31 轮 / 50 次工具调用
//   09:00:22 chat 错误 … insufficient memory … aborted before the allocator wall
//   ↩ 已压缩上下文（32,768 → ~19,660）、输出上限 4,096 → 2,048，并重试 1 次，仍失败
//            建议：把 config.contextBudget 调到 13,762 左右…
// 根因有三：①只压一级、只重试一次；②内核不记住"这个端点装不下"，下回合继续撞；③子代理
// 仍按父回合压缩前的预算发（29 分钟白跑的直接原因之一）。
//
// 本批把 v2 的每一条判据逐个改回缺陷（全部指向 test/memory-recovery.js 的断言原文）：
//   ① 第 2 级压缩不降预算（×0.35 改成 ×0.6，等于没有第 2 级）        → 套件必须红；
//   ② 第 2 级压缩不降输出上限（×0.25 改成 ×0.5）                     → 套件必须红；
//   ③ 学习值不落盘（原子写被删，错误文案却仍说"已记录"）             → 套件必须红；
//   ④ 学习值不生效（下一回合仍按配置预算起手）                       → 套件必须红；
//   ⑤ 子代理不继承父回合压缩后的预算/输出上限                        → 套件必须红；
//   ⑥ 允许第 3 次重试（硬性上限 2 被放宽）                           → 套件必须红；
//   ⑦ 建议文案与学习值脱节（hint 里不再给学习值）                    → 套件必须红；
//   ⑧ 学习文件损坏也照写（覆盖可能需要人工修复的原文）               → 套件必须红；
//   ⑨ 学习文件写失败直接抛（不再降级为"无学习值"）                   → 套件必须红；
//   ⑩ 上调比例从 +25% 改成 +50%                                     → 套件必须红；
//   ⑪ 第一次压缩还没完成就开始学习（学早了，只压一级就判失败）       → 套件必须红。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SUITE = () => M.suite('test/memory-recovery.js');

M.mutate({
  name: '① 第 2 级压缩不降预算（×0.35 改成 ×0.6，等于没有第 2 级）',
  file: 'src/agent.js',
  from: `  Object.freeze({ budgetRatio: 0.35, maxOutputRatio: 0.25, minBudget: 4096, minMaxOutput: 512 }),`,
  to: `  Object.freeze({ budgetRatio: 0.6, maxOutputRatio: 0.25, minBudget: 4096, minMaxOutput: 512 }), /* 变异：第 2 级不降预算 */`,
  expect: ['×0.35'],
  run: SUITE,
});

M.mutate({
  name: '② 第 2 级压缩不降输出上限（×0.25 改成 ×0.5）',
  file: 'src/agent.js',
  from: `  Object.freeze({ budgetRatio: 0.35, maxOutputRatio: 0.25, minBudget: 4096, minMaxOutput: 512 }),`,
  to: `  Object.freeze({ budgetRatio: 0.35, maxOutputRatio: 0.5, minBudget: 4096, minMaxOutput: 512 }), /* 变异：第 2 级输出不减半 */`,
  expect: ['×0.25'],
  run: SUITE,
});

M.mutate({
  name: '③ 学习值不落盘（原子写被删，错误文案却仍说"已记录"）',
  file: 'src/providers/index.js',
  from: `    atomicWriteJsonSync(file, { version: ENDPOINT_LIMITS_VERSION, endpoints });`,
  to: `    /* 变异：学习值不落盘 */`,
  expect: ['endpoint-limits.json'],
  run: SUITE,
});

M.mutate({
  name: '④ 学习值不生效（下一回合仍按配置预算起手）',
  file: 'src/agent.js',
  from: `  const learnedApplied = Boolean(learnedBudget > 0 && learnedBudget < configuredBudget);`,
  to: `  const learnedApplied = false; /* 变异：不采用端点学习值 */`,
  expect: ['取学习值'],
  run: SUITE,
});

M.mutate({
  name: '⑤ 子代理不继承父回合压缩后的预算/输出上限',
  file: 'src/agent.js',
  from: `        contextBudget: Math.min(currentTurnBudget ?? budget, 64000),
        maxOutputTokens: currentTurnMaxOutput ?? maxOutput,`,
  to: `        contextBudget: Math.min(budget, 64000),
        maxOutputTokens: maxOutput, /* 变异：子代理不继承压缩后的预算 */`,
  expect: ['压缩后的预算'],
  run: SUITE,
});

M.mutate({
  name: '⑥ 允许第 3 次重试（硬性上限 2 被放宽）',
  file: 'src/agent.js',
  from: `          if (memoryRetries >= MAX_MEMORY_RETRIES) {`,
  to: `          if (memoryRetries >= MAX_MEMORY_RETRIES + 1) { /* 变异：多一次重试 */`,
  expect: ['总请求数'],
  run: SUITE,
});

M.mutate({
  name: '⑦ 建议文案与学习值脱节（hint 里不再给学习值）',
  file: 'src/agent.js',
  from: `  const learnedHint =
    learnedSafe > 0
      ? \`该端点的内存安全预算已记为 \${fmtTok(learnedSafe)}（来自 \${fmtLearnedDate(opts?.learned?.learnedAt)} 的失败学习），下轮起手自动使用。\`
      : '';`,
  to: `  const learnedHint =
    learnedSafe > 0 && false
      ? \`该端点的内存安全预算已记为 \${fmtTok(learnedSafe)}（来自 \${fmtLearnedDate(opts?.learned?.learnedAt)} 的失败学习），下轮起手自动使用。\`
      : ''; /* 变异：建议与学习值脱节 */`,
  expect: ['与学习值一致'],
  run: SUITE,
});

M.mutate({
  name: '⑧ 学习文件损坏也照写（覆盖可能需要人工修复的原文）',
  file: 'src/providers/index.js',
  from: `  if (!r.ok) {
    // 文件坏了/读不出：**不覆盖**（可能还能人工救回来），只降级为无学习值。
    return { ...empty, error: \`\${r.error}；本次不写入，避免覆盖可能需要人工修复的文件\` };
  }`,
  to: `  /* 变异：损坏也照写，覆盖原文件 */`,
  expect: ['保持原样'],
  run: SUITE,
});

M.mutate({
  name: '⑨ 学习文件写失败直接抛（不再降级为"无学习值"）',
  file: 'src/providers/index.js',
  from: `  } catch (err) {
    return {
      ok: false,
      error: \`端点学习文件写入失败（\${file}）：\${(/** @type {any} */ (err))?.message || err}——本轮按无学习值继续\`,`,
  to: `  } catch (err) {
    throw err; /* 变异：写失败直接抛，不再降级 */
    return {
      ok: false,
      error: \`端点学习文件写入失败（\${file}）：\${(/** @type {any} */ (err))?.message || err}——本轮按无学习值继续\`,`,
  expect: ['写入失败'],
  run: SUITE,
});

M.mutate({
  name: '⑩ 上调比例从 +25% 改成 +50%',
  file: 'src/providers/index.js',
  from: `export const ENDPOINT_UPGRADE_RATIO = 1.25;`,
  to: `export const ENDPOINT_UPGRADE_RATIO = 1.5; /* 变异：+50% */`,
  expect: ['10,240'],
  run: SUITE,
});

M.mutate({
  name: '⑪ 第一次压缩还没完成就开始学习（学早了，只压一级就判失败）',
  file: 'src/agent.js',
  from: `          if (memoryRetries >= MAX_MEMORY_RETRIES) {`,
  to: `          if (memoryRetries >= 1) { /* 变异：只压一级就学习并判失败 */`,
  expect: ['提前失败'],
  run: SUITE,
});

if (!M.report()) process.exit(1);
