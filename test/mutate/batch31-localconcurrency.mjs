// 批三十一（v0.6.15 §3.59：本地端点内存压力）
//
// 真机证据（v0.6.14，macOS，8081 `mtplx-qwen38-27b-optimized-quality`）：
//   `[流式响应错误] insufficient memory: the request exceeded available GPU memory
//    (sustained critical memory pressure during prefill; aborted before the allocator wall).
//    The engine shed its caches and stays up; this request failed.`
// 同一错误此前在 60091 的 35B 上也出现 → 不是模型问题，是本机内存压力；该回合此前有子代理在跑
// （13 轮 / 17 次调用）→ 父回合 + 子代理同时向同一本地引擎发请求是主要来源。
//
// 修复形状是"一道进程级闸门 + 一条独立错误分型 + 一条预告警告 + 三处可见性"，所以变异逐条打在这四点上
// （全部指向 §142，关键词取断言原文）：
//   ① 去掉串行化（两次并发直接同时打端点）                       → §142 必须红；
//   ② 把云端端点也串起来（api.deepseek.com 被排队）               → §142 必须红；
//   ③ 去掉排队日志/事件（"等待 N 个在途请求"不可见）              → §142 必须红；
//   ④ 把 shed-caches 并入"重启引擎"那一支                         → §142 必须红；
//   ⑤ 删掉并发时的预告强警告                                      → §142 必须红；
//   ⑥ 排队超时不再可识别（code 丢掉，用户只知道"失败了"）          → §142 必须红；
//   ⑦ 预检不过闸门（父回合在跑时探针照插）                        → §142 必须红；
//   ⑧ 进度行不再显示"本地端点已串行化"                            → §142 必须红。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SEC = () => M.section('142');

M.mutate({
  name: '① 去掉本地端点串行化（两次并发直接同时打在同一个引擎上）',
  file: 'src/providers/index.js',
  from: `          releaseLocal = await acquireLocalSlot(pc.baseUrl, {
            // v0.6.18 §3.74：内存降级重试时 agent 传 localConcurrency=1，**临时把该端点压回单并发**
            // （即便用户把 config.localConcurrency 配成 0/2）——重试期间不允许父回合/子代理再同时 prefill。
            cfg: opts.localConcurrency != null ? { ...cfg, localConcurrency: opts.localConcurrency } : cfg,
            signal: ac.signal,
            onWait: opts.onQueueWait,
            endpoint: pc.name || pc.baseUrl,
            label: modelName,
          });`,
  to: `          releaseLocal = /** @type {any} */ (() => {}); /* 变异：不排队，直接并发 */`,
  expect: ['同一本地 baseUrl 的并发请求必须串行化', '桩实测最大并发'],
  run: SEC,
});

M.mutate({
  name: '② 把云端端点也串起来（api.deepseek.com 被本地队列拖住）',
  file: 'src/providers/index.js',
  from: `  if (!isLocalBaseUrl(key)) return () => {};`,
  to: `  if (false) return () => {}; /* 变异：云端也进本地队列 */`,
  expect: ['云端 baseUrl 不得被串行化', '云端端点不得产生'],
  run: SEC,
});

M.mutate({
  name: '③ 去掉排队日志/事件（"本地端点串行化：等待 N 个在途请求"不可见）',
  file: 'src/providers/index.js',
  from: `  emit(ev);`,
  to: `  /* 变异：去掉排队日志（emit 不再调用） */`,
  expect: ['排队时必须发出串行化事件', '排队日志必须写明"等待 N 个在途请求"'],
  run: SEC,
});

M.mutate({
  name: '④ 把 "engine shed its caches and stays up" 并入"重启引擎"那一支',
  file: 'src/agent.js',
  from: `  } else if (/engine shed its caches and stays up|allocator wall/.test(t)) {`,
  to: `  } else if (false && /engine shed its caches and stays up|allocator wall/.test(t)) {`,
  expect: ['必须明确"该引擎未崩溃"', '不得建议重启'],
  run: SEC,
});

M.mutate({
  name: '⑤ 删掉"本地端点已有在途请求"时的预告强警告',
  file: 'src/agent.js',
  from: `  const concurrencyNote = Boolean(isLocal) && Boolean(localBusy)`,
  to: `  const concurrencyNote = false && Boolean(isLocal) && Boolean(localBusy)`,
  expect: ['预告必须给强警告', '并发会加剧内存压力'],
  run: SEC,
});

M.mutate({
  name: '⑥ 排队超时不再可识别（丢掉 LOCAL_QUEUE_TIMEOUT code）',
  file: 'src/providers/index.js',
  from: `      err.code = 'LOCAL_QUEUE_TIMEOUT';`,
  to: `      err.code = 'ETIMEDOUT'; /* 变异：排队超时不可识别 */`,
  expect: ['排队超时必须可被程序识别', '第二个请求必须在排队上限后失败（不得死等）'],
  run: SEC,
});

M.mutate({
  name: '⑦ 预检不过本地端点闸门（父回合在跑时探针照插，抢同一份内存）',
  file: 'src/model-discovery.js',
  from: `        releaseLocal = await acquireLocalSlot(base, {
          cfg,
          signal: ac.signal,
          endpoint: \`预检 \${endpointLabel(base) || base}\`,
          queueTimeoutMs: Math.max(1, Math.min(localQueueTimeoutMs(cfg), left())),
        });`,
  to: `        releaseLocal = null; /* 变异：预检不排队 */`,
  expect: ['端点预检也必须纳入本地端点并发闸门', '预检与在途请求不得同时'],
  run: SEC,
});

M.mutate({
  name: '⑧ 进度行不再显示"本地端点已串行化"（排队与卡死在日志里同形）',
  file: 'src/agent.js',
  from: `  if (localQueue) {
    parts.push(
      \`本地端点已串行化（防内存压力）：等待 \${Math.max(0, Number(localQueue.active) || 0)} 个在途请求\` +`,
  to: `  if (false && localQueue) {
    parts.push(
      \`本地端点已串行化（防内存压力）：等待 \${Math.max(0, Number(localQueue.active) || 0)} 个在途请求\` +`,
  expect: ['进度行必须显示"已串行化'],
  run: SEC,
});

if (!M.report()) process.exit(1);
