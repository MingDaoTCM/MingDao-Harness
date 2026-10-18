// 批四十（v0.6.18 §3.74：本地引擎内存不足 → 压缩上下文 + 输出减半 + 串行，只重试一次）
//
// 真机证据（v0.6.17，8081 qwen）：
//   `insufficient memory: the request exceeded available GPU memory
//    (sustained critical memory pressure during prefill; aborted before the allocator wall).
//    The engine shed its caches and stays up; this request failed.`
// 当时上下文只有 ≈2,773 tokens、预算 32,768——压小预算/输出上限后极可能成功，但整回合直接失败。
// 修复面有六条判据，变异逐条打在这六点上（全部指向 test/memory-recovery.js 的断言原文）：
//   ① 不再对本地内存错误重试（退回"整回合失败"）                    → 套件必须红；
//   ② 重试时不压缩预算（仍是 32,768）                               → 套件必须红；
//   ③ 重试时输出上限不减半（仍是 8,192）                            → 套件必须红；
//   ④ 重试期间不强制串行（不传 localConcurrency=1）                  → 套件必须红；
//   ⑤ 允许重试两次（第二次失败后又来一次）                          → 套件必须红；
//   ⑥ 第二次失败伪装成 done（不抛错）                               → 套件必须红；
//   ⑦ 云端 507 也走压缩重试（recoverableByShrinking 不看 isLocal）   → 套件必须红；
//   ⑧ 创建 agent 时不做 n_ctx clamp（明知装不下还发）               → 套件必须红；
//   ⑨ clamp 比例从 0.8 放宽到 0.95（贴着引擎窗口发）                 → 套件必须红；
//   ⑩ 把一切 4xx 都当内存压力（400/401/429 也开始重试）              → 套件必须红；
//   ⑪ 第二次失败的建议里删掉引擎侧 `--ctx-size`                      → 套件必须红。
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
  from: `          turnBudget = Math.max(4096, Math.floor(fromBudget * 0.6));`,
  to: `          turnBudget = fromBudget; /* 变异：不压缩预算 */`,
  expect: ['压缩前后数值'],
  run: SUITE,
});

M.mutate({
  name: '③ 重试时输出上限不减半（仍是 8,192）',
  file: 'src/agent.js',
  from: `          turnMaxOutput = Math.max(256, Math.floor(fromMaxOutput * 0.5));`,
  to: `          turnMaxOutput = fromMaxOutput; /* 变异：输出上限不减半 */`,
  expect: ['输出上限必须 ×0.5'],
  run: SUITE,
});

M.mutate({
  name: '④ 重试期间不强制串行（不传 localConcurrency=1）',
  file: 'src/agent.js',
  from: `          ...(memoryRetries > 0 ? { localConcurrency: 1 } : {}),`,
  to: `          ...(memoryRetries > 0 ? {} : {}), /* 变异：重试不强制串行 */`,
  expect: ['重试期间必须强制串行'],
  run: SUITE,
});

M.mutate({
  name: '⑤ 允许重试两次（上限判据从 MAX_MEMORY_RETRIES 改成 2）',
  file: 'src/agent.js',
  from: `          if (memoryRetries >= MAX_MEMORY_RETRIES) {`,
  to: `          if (memoryRetries >= 2) { /* 变异：允许重试两次 */`,
  expect: ['失败路径也只能重试一次'],
  run: SUITE,
});

M.mutate({
  name: '⑥ 第二次仍失败却伪装成 done（不抛错）',
  file: 'src/agent.js',
  from: `            const enriched = new Error(\`\${localMemory.message}\\n   \${localMemory.hint || ''}\\n   ↩ \${detail}\`);
            /** @type {any} */ (enriched).status = e?.status ?? 507;
            if (e?.headers !== undefined) /** @type {any} */ (enriched).headers = e.headers;
            throw enriched;`,
  to: `            const enriched = new Error(\`\${localMemory.message}\\n   \${localMemory.hint || ''}\\n   ↩ \${detail}\`);
            /** @type {any} */ (enriched).status = e?.status ?? 507;
            if (e?.headers !== undefined) /** @type {any} */ (enriched).headers = e.headers;
            /* 变异：第二次失败伪装成 done */
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
  name: '⑪ 第二次失败的建议里删掉引擎侧 --ctx-size',
  file: 'src/agent.js',
  from: `              \`并在引擎侧调大 --ctx-size 或使用 q8 KV 量化。\`;`,
  to: `              \`并在引擎侧调大上下文窗口。\`; /* 变异：删掉 --ctx-size 建议 */`,
  expect: ['引擎侧建议'],
  run: SUITE,
});

if (!M.report()) process.exit(1);
