// 批十三（v0.6.7 账本与计费诚实性）的变异验证：
// 把每处修复逐个改回缺陷，「结局单源 / 未知≠0 / 护栏前置」这些断言必须当场失败。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SEC = () => M.section('127');

// ① P2-1：runEnd 退回"用 finish 重算结局"（返回值与账本再次分裂）
M.mutate({
  name: '① 账本 runEnd 退回用 finish 重算结局（P2-1 原形态）',
  file: 'src/agent.js',
  from: "            status: outcome.status,",
  to: "            status: aborted ? 'aborted' : finish === 'length' || finish === 'max_steps' ? 'capped' : 'done',",
  expect: ['账本 status 必须与返回值同源'],
  run: SEC,
});

// ② P2-1：跑满步数的出口不再标记结局（返回 capHit:true 而账本仍是 done）
M.mutate({
  name: '② 兜底总结出口不再收敛结局（返回值 capHit 与账本不符）',
  file: 'src/agent.js',
  from: "        markOutcome('capped', { capHit: true });\n        return { text: wrapApplied.text || null,",
  to: "        return { text: wrapApplied.text || null,",
  // 注意：这条变异下"返回值与账本仍然一致"（都变成 done/false）——单源让它们不会分裂，
  // 但**语义**错了（跑满步数被当成正常完成）。所以抓它的是前置断言，不是一致性断言。
  expect: ['跑满步数应标记 capHit'],
  run: SEC,
});

// ③ H-3：护栏退回"读失败当空列表"（静默 ¥0）
M.mutate({
  name: '③ 费用护栏退回宽松读取（读失败静默当 0）',
  file: 'src/cost-guard.js',
  // 精确还原"读失败当空列表"：只改失败分支的返回值（改读取调用会连可读用例一起弄坏，
  // 那样断言虽然也会红，但红的不是我们要钉的那条）
  from: '    warnTodayCostDegraded(r.error);\n    return null;',
  to: '    warnTodayCostDegraded(r.error);\n    return 0;',
  expect: ['读失败必须返回 null'],
  run: SEC,
});

// ④ H-4：recordUsage 忽略 usageUnknown（把"未知"记成 ¥0）
M.mutate({
  name: '④ recordUsage 忽略 usageUnknown（未知记成 0）',
  file: 'src/cachestats.js',
  from: '  const usageUnknown = perf?.usageUnknown === true;',
  to: '  const usageUnknown = false;',
  expect: ['用量未知绝不能记成 ¥0'],
  run: SEC,
});

// ⑤ H-4：agent 不再识别 usage 缺失
M.mutate({
  name: '⑤ agent 不再识别 usage 缺失',
  file: 'src/agent.js',
  from: '      if (!res.usage && (res.text || res.toolCalls?.length)) {',
  to: '      if (false && !res.usage && (res.text || res.toolCalls?.length)) {',
  expect: ['usageUnknown', 'priced 必须为 false'],
  run: SEC,
});

// ⑥ M-10：Batch 失败路径不再落账
M.mutate({
  name: '⑥ Batch 失败路径不再记"用量未知"',
  file: 'src/batch.js',
  from: "        recordUnaccountedBatch(j, `服务端状态 ${st}`);",
  to: '',
  expect: ['必须留下记录'],
  run: SEC,
});

// ⑦ §3.39①(c)：Batch 不再查护栏（提交前不拦）
M.mutate({
  name: '⑦ Batch 通道不再查费用护栏',
  file: 'src/batch.js',
  from: '    const guard = checkCostGuard(model);\n    if (guard) {\n      if (guard.blocked) return { error: `费用护栏拦截，未提交批处理：${guard.message}` };',
  to: '    const guard = null;\n    if (guard) {\n      if (guard.blocked) return { error: `费用护栏拦截，未提交批处理：${guard.message}` };',
  expect: ['护栏 block 档必须拒绝提交'],
  run: SEC,
});

// ⑧ §3.39①(b)：在途费用不再参与降级**决策**（贵模型会一直用到回合结束）
M.mutate({
  name: '⑧ 在途费用不再参与降级决策（单回合可烧穿日限）',
  // v0.6.11：这段判据已从 agent.js 抽到 cost-guard.js 的 roundGuardAction()（P1-1 第二刀），
  // 锚点随之迁移——锚点不跟着走就会变成"变异点未找到"（假绿），正是本批要防的那类退化。
  file: 'src/cost-guard.js',
  from: '  if (!guard && !downgraded) {',
  to: '  if (false && !guard && !downgraded) {',
  expect: ['在途越线后必须立刻降级'],
  run: SEC,
});

// ⑨ P3-1：run.start 的 packs 退回不存在的键（恒空数组）
M.mutate({
  name: '⑨ run.start 的 packs 退回 {}.packs（恒为空数组）',
  file: 'src/agent.js',
  from: '      packs: (getActivePackContext()?.mounted || []).map((/** @type {any} */ p) => p?.name).filter(Boolean),',
  to: '      packs: getActivePackContext()?.packs ?? [],',
  expect: ['run.start.packs 必须列出真正挂载的 Pack'],
  run: SEC,
});

// ⑩ 状态口径：Web 侧 capHit 退回 done
M.mutate({
  name: '⑩ Web 侧 capHit 退回标成 done',
  file: 'src/web/server.js',
  from: "      entry.status = r.aborted ? 'aborted' : r.capHit ? 'capped' : 'done';",
  to: "      entry.status = r.aborted ? 'aborted' : 'done';",
  expect: ['Web 侧 capHit 不得再标成 done'],
  run: SEC,
});

if (!M.report()) process.exit(1);
