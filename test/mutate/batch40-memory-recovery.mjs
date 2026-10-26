// 批四十（v0.6.18 §3.74 → v0.6.26 §3.91 v2：本地引擎内存不足的多级压缩 / 端点学习 / 子代理继承）
//
// 真机证据（v0.6.17，8081 qwen；以及 10-18 / 10-19 / 10-26 三次同形态失败）：
//   `insufficient memory: the request exceeded available GPU memory
//    (sustained critical memory pressure during prefill; aborted before the allocator wall).
//    The engine shed its caches and stays up; this request failed.`
// v0.6.18 的"一级压缩 + 一次重试"在真机上连续失败；v2 改成两级压缩 + 端点级学习。
// 本批把这些判据逐条改回缺陷（全部指向 test/memory-recovery.js 的断言原文）：
//   ① 不再对本地内存错误重试（退回"整回合失败"）                    → 套件必须红；
//   ② 重试时不压缩预算（仍是 32,768）                               → 套件必须红；
//   ③ 重试时输出上限不减半（仍是 8,192）                            → 套件必须红；
//   ④ 重试期间不强制串行（不传 localConcurrency=1）                  → 套件必须红；
//   ⑤ 硬性上限放宽到 3 次（多压一级）                                → 套件必须红；
//   ⑥ 两级都失败却伪装成 done（不抛错）                             → 套件必须红；
//   ⑦ 云端 507 也走压缩重试（recoverableByShrinking 不看 isLocal）   → 套件必须红；
//   ⑧ 创建 agent 时不做 n_ctx clamp（明知装不下还发）               → 套件必须红；
//   ⑨ clamp 比例从 0.8 放宽到 0.95（贴着引擎窗口发）                 → 套件必须红；
//   ⑩ 把一切 4xx 都当内存压力（400/401/429 也开始重试）              → 套件必须红；
//   ⑪ 失败建议里删掉引擎侧 `--ctx-size`                              → 套件必须红。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SUITE = () => M.suite('test/memory-recovery.js');

M.mutate({
  name: '① 不再对本地内存错误重试（退回"整回合直接失败"）',
  file: 'src/agent.js',
  from: `        if (localMemory.recoverableByShrinking) {`,
  to: `        if (false && localMemory.recoverableByShrinking) { /* 变异：不做降级重试 */`,
  expect: ['内存/显存不足'],
  run: SUITE,
});

M.mutate({
  name: '② 重试时不压缩上下文预算（仍是 32,768）',
  file: 'src/agent.js',
  from: `          turnBudget = target.budget;
          turnMaxOutput = target.maxOutput;`,
  to: `          turnBudget = turnBaseBudget;
          turnMaxOutput = turnBaseMaxOutput; /* 变异：不压缩预算/输出 */`,
  expect: ['×0.6'],
  run: SUITE,
});

M.mutate({
  name: '③ 重试时输出上限不减半（所有级别 maxOutputRatio 改成 1）',
  file: 'src/agent.js',
  from: `  Object.freeze({ budgetRatio: 0.6, maxOutputRatio: 0.5, minBudget: 4096, minMaxOutput: 512 }),`,
  to: `  Object.freeze({ budgetRatio: 0.6, maxOutputRatio: 1, minBudget: 4096, minMaxOutput: 512 }), /* 变异：输出不减半 */`,
  expect: ['×0.5'],
  run: SUITE,
});

M.mutate({
  name: '④ 重试期间不强制串行（不传 localConcurrency=1）',
  file: 'src/agent.js',
  from: `          ...(memoryRetries > 0 ? { localConcurrency: 1 } : {}),`,
  to: `          ...(memoryRetries > 0 ? {} : {}), /* 变异：重试不强制串行 */`,
  expect: ['强制串行'],
  run: SUITE,
});

M.mutate({
  name: '⑤ 硬性上限放宽到 3 次（多压一级，不再是最多 2 次）',
  file: 'src/agent.js',
  from: `export const MAX_MEMORY_RETRIES = MEMORY_RECOVERY_LEVELS.length;`,
  to: `export const MAX_MEMORY_RETRIES = MEMORY_RECOVERY_LEVELS.length + 1; /* 变异：允许 3 次 */`,
  expect: ['硬性上限必须是 2'],
  run: SUITE,
});

M.mutate({
  name: '⑥ 两级都失败却伪装成 done（不抛错）',
  file: 'src/agent.js',
  from: `            /** @type {any} */ (enriched).status = e?.status ?? 507;
            if (e?.headers !== undefined) /** @type {any} */ (enriched).headers = e.headers;
            throw enriched;`,
  to: `            /** @type {any} */ (enriched).status = e?.status ?? 507;
            if (e?.headers !== undefined) /** @type {any} */ (enriched).headers = e.headers;
            /* 变异：两级都失败却伪装成 done */
            return { text: null, reasoning: '', usage, steps, finish, truncated: false, aborted: false, upstreamTruncated, note: String(enriched.message || ''), durationMs: Date.now() - startedAt, perf: perf() };`,
  expect: ['回合必须失败'],
  run: SUITE,
});

M.mutate({
  name: '⑦ 云端 507 也走压缩重试（recoverableByShrinking 不看 isLocal）',
  file: 'src/agent.js',
  from: `  const recoverableByShrinking = Boolean(memoryPressure && opts?.isLocal === true);`,
  to: `  const recoverableByShrinking = Boolean(memoryPressure); /* 变异：云端也算可恢复 */`,
  expect: ['云端端点遇到 507 不得重试'],
  run: SUITE,
});

M.mutate({
  name: '⑧ 创建 agent 时不做 n_ctx clamp（明知装不下还发请求）',
  file: 'src/agent.js',
  from: `  const budgetClamp = clampContextBudgetToEngine({
    contextBudget: safeB,
    configuredBudget: Number(cfg?.contextBudget) > 0 ? Number(cfg.contextBudget) : null,
    engineCtx: cfg?.endpointProbe?.engineCtx ?? null,
  });`,
  to: `  /* 变异：不按引擎 n_ctx clamp */
  const budgetClamp = { clamped: false, budget: safeB, from: safeB, to: safeB, engineCtx: null, ceiling: null, ratio: 0.8, notice: '' };`,
  expect: ['prompt 预算必须 clamp'],
  run: SUITE,
});

M.mutate({
  name: '⑨ clamp 比例从 0.8 放宽到 0.95（贴着引擎窗口发）',
  file: 'src/model-discovery.js',
  from: `export const ENGINE_BUDGET_RATIO = 0.8;`,
  to: `export const ENGINE_BUDGET_RATIO = 0.95; /* 变异：贴着窗口发 */`,
  expect: ['prompt 预算必须 clamp'],
  run: SUITE,
});

M.mutate({
  name: '⑩ 把一切 4xx 都当内存压力（400/401/429 也开始压缩重试）',
  file: 'src/providers/openai-compatible.js',
  from: `  const status = Number(err?.status);
  if (status === 507) return true;`,
  to: `  const status = Number(err?.status);
  if (status >= 400) return true; /* 变异：4xx 全当内存压力 */`,
  expect: ['400 不得重试'],
  run: SUITE,
});

M.mutate({
  name: '⑪ 失败建议里删掉引擎侧 --ctx-size',
  file: 'src/agent.js',
  from: `并在引擎侧调大 --ctx-size 或使用 q8 KV 量化。`,
  to: `并在引擎侧调大上下文窗口。 /* 变异：删掉引擎侧参数建议 */`,
  expect: ['引擎侧建议'],
  run: SUITE,
});

if (!M.report()) process.exit(1);
