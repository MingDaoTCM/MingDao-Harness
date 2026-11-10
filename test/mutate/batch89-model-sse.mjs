// 批八十九（v0.7.1）：模型发现并发 + SSE 写入背压的变异验证。
//
// 目标：把 (A) 串行出网、(B) SSE 无界缓存两处修复逐条改回缺陷，对应的新套件必须当场红，
// 且失败输出里出现该条 `expect` 关键词（关键词 = 断言原文，防止"红是红了，但不是你改坏的那条"）。
//
// 覆盖：并发退成串行 / 负缓存 TTL 恒命中 / 成功不清负缓存 / AbortController 死代码复活 /
//       res.write 返回值被忽略 / drain 未监听 / 写入异常被吞 / 背压上限被去掉。
// 用法：node test/mutate/batch89-model-sse.mjs
import { makeMutator } from './lib.mjs';

const M = makeMutator();
const MD = () => M.suite('test/model-discovery-parallel.js');
const SSE = () => M.suite('test/sse-backpressure.js');

// ① 并发退成串行：多服务商探测重新背靠背，/api/models 最坏回到 8s×N
M.mutate({
  name: '① 并发退成串行（Promise.all 变 for + await）',
  file: 'src/model-discovery.js',
  from: '  return Promise.all(providers.map(async ([pname, pp]) => ({ pname, pp, dynamic: await fetchModels(cfg, pname) })));',
  to: '  const out = [];\n  for (const [pname, pp] of providers) out.push({ pname, pp, dynamic: await fetchModels(cfg, pname) });\n  return out;',
  expect: ['并发探测必须同时出网'],
  run: MD,
});

// ② 负缓存 TTL 失效（恒命中）：过期条目永远判命中，网络恢复后仍被永久跳过
M.mutate({
  name: '② 负缓存 TTL 失效（恒命中）',
  file: 'src/model-discovery.js',
  from: '  return typeof entry?.failUntil === \'number\' && now < entry.failUntil;',
  to: '  return typeof entry?.failUntil === \'number\' && true; // 变异：恒命中',
  expect: ['负缓存 TTL 过期必须失效'],
  run: MD,
});

// ③ 成功不清负缓存：成功后负缓存仍在，之后即便正缓存失效也被永久跳过
M.mutate({
  name: '③ 成功探测不清负缓存',
  file: 'src/model-discovery.js',
  from: '      negativeCache.delete(providerName); // v0.7.1（H-6）：成功即清除负缓存',
  to: '      // 变异：成功不清负缓存',
  expect: ['成功探测必须清除负缓存'],
  run: MD,
});

// ④ AbortController 死代码复活：创建控制器却从不传给 safeFetchText
M.mutate({
  name: '④ AbortController 死代码复活',
  file: 'src/model-discovery.js',
  from: '  const p = (async () => {\n    try {',
  to: '  const p = (async () => {\n    const ctrl = new AbortController();\n    const timer = setTimeout(() => ctrl.abort(), 8000);\n    try {',
  expect: ['AbortController 死代码必须移除'],
  run: MD,
});

// ⑤ res.write 返回值被忽略：缓冲区满仍继续写，慢客户端恢复无界缓存
M.mutate({
  name: '⑤ res.write 返回值被忽略',
  file: 'src/web/server.js',
  from: '      if (res.write(frame) === false) paused = true;',
  to: '      res.write(frame); // 变异：忽略返回值',
  expect: ['write 返回 false 后必须暂停后续写入'],
  run: SSE,
});

// ⑥ drain 未监听：暂停后永远不恢复，积压帧丢在半路
M.mutate({
  name: '⑥ drain 未监听（暂停后不恢复）',
  file: 'src/web/server.js',
  from: '  res.on(\'drain\', () => {\n    paused = false;\n    flush();\n  });',
  to: '  // 变异：drain 未监听',
  expect: ['drain 后必须排空积压帧并恢复写入'],
  run: SSE,
});

// ⑦ 写入异常被吞：EPIPE 等错误静默，连接既不结束也不告警
M.mutate({
  name: '⑦ 写入异常被吞（空 catch）',
  file: 'src/web/server.js',
  from: '    } catch (e) {\n      const ee = /** @type {any} */ (e);\n      stop(`写入异常：${String(ee?.message || ee)}`);\n    }',
  to: '    } catch (e) {\n      // 变异：吞掉写入异常\n    }',
  expect: ['写入异常必须显式记录'],
  run: SSE,
});

// ⑧ 背压上限被去掉：积压帧数无上限，慢客户端拖垮服务端
M.mutate({
  name: '⑧ 背压上限被去掉（无界缓存）',
  file: 'src/web/server.js',
  from: '      if (queue.length > SSE_MAX_BUFFERED_FRAMES) stop(\'背压超限（慢客户端），已断开连接\');',
  to: '      // 变异：背压上限被去掉',
  expect: ['背压超限必须断开慢客户端'],
  run: SSE,
});

const ok = M.report();
process.exit(ok ? 0 : 1);
