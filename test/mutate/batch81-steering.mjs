// 批八十一（v0.6.40）：插话（next-step 车道）的语义闭环。
// 每条把关键点改回缺陷，test/steering.js 必须当场红。
// 只跑本批：node test/mutate/batch81-steering.mjs
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const RUN = () => M.suite('test/steering.js');

M.mutate({
  name: '① drain 只取一条（插话被拆成一step一条，本轮被拖长/顺序丢失）',
  file: 'src/web/viewmodel.js',
  from: '  return { steer: [], taken: [...list] };',
  to: '  return { steer: list.slice(1), taken: list.slice(0, 1) };',
  expect: ['drainSteer 必须全量取走'],
  run: RUN,
});

M.mutate({
  name: '② 有插话也不继续（模型无工具调用就直接收尾，插话被留到下一轮）',
  file: 'src/web/viewmodel.js',
  from: '  return list.length > 0 && !st?.aborted && !st?.stalled;',
  to: '  return false && list.length > 0 && !st?.aborted && !st?.stalled;',
  expect: ['有插话 → 继续下一步'],
  run: RUN,
});

M.mutate({
  name: '③ 插话上限失效（可无限堆积，一次注入几十条把请求打爆）',
  file: 'src/web/viewmodel.js',
  from: "  if (list.length >= STEER_MAX) return { ok: false, steer: list, reason: 'full' };",
  to: "  if (false) return { ok: false, steer: list, reason: 'full' };",
  expect: ['满员必须拒绝'],
  run: RUN,
});

M.mutate({
  name: '④ 超长插话不拒（200KB 上限形同虚设）',
  file: 'src/web/viewmodel.js',
  from: "  if (steerBytes(t) > STEER_TEXT_MAX) return { ok: false, steer: list, reason: 'too-long' };",
  to: "  if (false) return { ok: false, steer: list, reason: 'too-long' };",
  expect: ['超长插话（>200KB）必须拒绝'],
  run: RUN,
});

M.mutate({
  name: '⑤ 未知 taskId 不报错（静默接受 → 缓冲没人消费、用户以为插上了）',
  file: 'src/web/server.js',
  from: "    if (!entry || entry.status !== 'running') {\n      return json(res, 404, { error: '任务不存在或已结束（插话只能发给运行中的任务）' });\n    }",
  to: "    if (!entry) {\n      return json(res, 200, { ok: true, queued: 0 });\n    }",
  expect: ['未知 taskId 必须 404'],
  run: RUN,
});

M.mutate({
  name: '⑥ SSE 不发 steer（前端看不到"已插入本轮"，也无法撤掉 chip）',
  file: 'src/web/server.js',
  from: "      entry.send?.({ type: 'steer', text, queued: true, queuedCount: r.steer.length });",
  to: '      void 0;',
  expect: ['SSE 必须即时推送'],
  run: RUN,
});

M.mutate({
  name: '⑦ 插话失败不回落到排队（网络/429/413 时用户输入被静默吞掉）',
  file: 'src/web/app.js',
  from: '  if(!enqueueInput(text)) return;',
  to: '  return;',
  expect: ['fallbackSteer 必须真的把文本放进 next-turn 队列'],
  run: RUN,
});

M.mutate({
  name: '⑧ agent 不在每步边界 drain（插话只能等模型收尾后才被看见）',
  file: 'src/agent.js',
  from: "      // 接线点①（v0.6.40）：每个 step 边界全量取走插话；放在中止检查之后 = 停止优先。\n      drainSteeringInto(steering, messages, io);",
  to: '      // 接线点①（变异：不 drain）',
  expect: ['插话不应该额外多一轮请求'],
  run: RUN,
});

M.mutate({
  name: '⑨ 收尾分支不再 drain（模型返回窗口内按的 Cmd+Enter 丢失，本轮直接结束）',
  file: 'src/agent.js',
  from: "        const steeredNow = drainSteeringInto(steering, messages, io);\n        if (shouldContinueAfterModel({ steer: steeredNow, aborted, stalled: noProgressFired })) continue;",
  to: '        // 接线点②（变异：直接收尾）',
  expect: ['本轮不结束'],
  run: RUN,
});

M.mutate({
  name: '⑩ web-io 不发 type=steer（注入事实到不了界面）',
  file: 'src/web/web-io.js',
  from: "      send({ type: 'steer', text: String(text ?? ''), injected: true });",
  to: "      send({ type: 'noop', text: String(text ?? ''), injected: true });",
  expect: ['agent 真正注入时必须再推 8 条 injected'],
  run: RUN,
});

const ok = M.report();
process.exit(ok ? 0 : 1);
