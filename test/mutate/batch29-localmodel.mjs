// 批二十九（v0.6.13 真机四问题：预告必须由预检推导 / 引擎自述上下文 / 子代理进展算父回合进展 / stalled 用户可见）
// 的变异验证。四个问题的修法都是"一条判据 + 一处透出 + 一条文案"，所以变异逐条打在这三点上：
//
// 问题 1（真机 web-server.log:304 → 307，同一 taskId）：
//   同一条预告里"prefill 可能需数分钟至数十分钟"与"参考 prefill 2000 tokens 0.08s"并存；
//   52 秒后实测首帧 53.7s（按 0.08s/2000 tokens 外推只有 0.6s，差 90 倍）。
//   · 有预检实测却不外推（退回保守文案）   → §140 必须红；
//   · 外推不乘本轮 tokens（只报参考值）    → §140 必须红；
//   · 删掉"线性外推 + 长上下文会低估"的如实说明 → §140 必须红；
//   · 没有参考 prefill 也硬编一个外推值     → §140 必须红（应当退回保守文案）。
//
// 问题 2（真机 web-server.log:229 insufficient memory；配置 131072 vs 引擎 n_ctx 32768）：
//   · 预检不再读 /props                     → §140 必须红；
//   · 只认顶层 n_ctx（llama.cpp 的真实位置读不到） → §140 必须红；
//   · 配置没超引擎也说"超出"（编造结论）     → §140 必须红；
//   · /props 不从带 /v1 的 baseUrl 推根路径  → §140 必须红；
//   · 超限不再发告警 banner（只留日志）      → §140 必须红；
//   · 预检日志行不带引擎自述上下文           → §140 必须红。
//
// 问题 3（真机 web-server.log:292-300 status=stalled；会话 qaaa.jsonl:28/29 子代理 15 轮/18 次调用）：
//   · 子代理进展不再回调父回合（父回合又把"在干活"当"无进展"） → §140 必须红；
//   · 继承的截止时刻退回 spawn 时刻的快照（误杀正在干活的子代理） → §140 必须红；
//   · 父回合整轮无进展时不再把子代理收口（整棵树挂死）           → §140 必须红；
//   · 收口原因不再区分（用"自己零进展"的文案冒充父回合收口）     → §140 必须红；
//   · 等子代理时"让子代理先响"的宽限被写成 0                     → §140 必须红；
//   · task 结果不再回传子代理自己的进度 / 不区分两种收口原因      → §140 必须红。
//
// 问题 4（真机 mingdao.log:2996 只有"回合收尾：generating=false"，内核却是 status=stalled）：
//   · stalled 不再发告警 banner             → §140 必须红；
//   · 收尾文案不说"在等哪个工具"             → §140 必须红；
//   · 不足 1 分钟谎报"1 分钟"                → §140 必须红；
//   · 不再与 capped/aborted 区分             → §140 必须红；
//   · done 事件不带 stalled 原因 / 前端不把结局写进控制台 → §140 必须红。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SEC = () => M.section('140');

// —— 问题 1：预告必须由预检实测推导 ——
M.mutate({
  name: '① 有预检实测也不用它（退回"可能需数分钟至数十分钟"的保守文案）',
  file: 'src/agent.js',
  from: '  const est = prefillEstimateMs({ promptTokens: p, probe });',
  to: '  const est = null;',
  expect: ['必须注明这是外推', '有预检实测时必须报出参考值本身', '没有预检数据时必须退回既有保守文案'],
  run: SEC,
});

M.mutate({
  name: '② 外推不乘本轮 tokens（只把参考 prefill 的耗时当成本轮耗时）',
  file: 'src/agent.js',
  from: '  return { ms: Math.round((refMs * p) / refTokens), refTokens, refMs, tokens: p };',
  to: '  return { ms: Math.round(refMs), refTokens, refMs, tokens: p };',
  expect: ['外推值必须是 预检ms × 本轮tokens/参考tokens'],
  run: SEC,
});

M.mutate({
  name: '③ 删掉"这是线性外推 + 长上下文下会低估"的如实说明（只报乐观值）',
  file: 'src/agent.js',
  from: '      `（**线性外推**，只作量级参考——长上下文下引擎可能显著变慢：${PREFILL_LONGCTX_EVIDENCE}；` +\n      `外推低估时以首帧等待为准）；首帧等待上限 ${secs}s（config.timeout.firstTokenMs）`',
  to: '      `；首帧等待上限 ${secs}s（config.timeout.firstTokenMs）`',
  expect: ['必须如实给出"线性外推会低估"的实测证据', '必须注明这是外推'],
  run: SEC,
});

M.mutate({
  name: '④ 没有参考 prefill 实测也硬编一个外推值（应当退回保守文案）',
  file: 'src/agent.js',
  from: '  if (!(refMs > 0) || p <= 0) return null;',
  to: '  if (p <= 0) return null;',
  expect: ['没有参考 prefill 实测时必须返回 null'],
  run: SEC,
});

M.mutate({
  name: '⑤ 外推明明很慢却不告警（"端点明显慢"这条线被拿掉）',
  file: 'src/agent.js',
  from: '  const hitSlow = est != null && est.ms >= PREFILL_SLOW_WARN_MS;',
  to: '  const hitSlow = false;',
  expect: ['必须告警', '慢端点告警必须写出依据'],
  run: SEC,
});

// —— 问题 2：引擎自述上下文（/props）vs 配置 ——
M.mutate({
  name: '⑥ 预检不再读 GET /props（配置超出引擎能力永远发现不了）',
  file: 'src/model-discovery.js',
  from: '    if (info.isLocal && info.loadedModel) {\n      info.engineProbed = true;',
  to: '    if (false) {\n      info.engineProbed = true;',
  expect: ['预检必须真的读出引擎自述上下文'],
  run: SEC,
});

M.mutate({
  name: '⑥b 端点没自报模型名也照样打 /props（把只实现 chat 的网关/桩打断——test/e2e-web.js 的 mock 就是被这一个 GET 打挂的）',
  file: 'src/model-discovery.js',
  from: '    if (info.isLocal && info.loadedModel) {',
  to: '    if (info.isLocal) {',
  expect: ['端点未自报模型名时不得多打 /props'],
  run: SEC,
});

M.mutate({
  name: '⑥c 读不到 /props 时不再说明（静默跳过，"核对过没有"无从判断）',
  file: 'src/model-discovery.js',
  from: '    if (!probed) {\n      return `引擎自述上下文：跳过（${skipReason ||',
  to: '    if (!probed) {\n      return `引擎自述上下文：（${skipReason ||',
  expect: ['非本地端点必须写明"跳过"', '跳过必须写明具体原因', '读不到必须在结论里说明'],
  run: SEC,
});

M.mutate({
  name: '⑦ 只认顶层 n_ctx（llama.cpp 真实位置 default_generation_settings.n_ctx 读不到）',
  file: 'src/model-discovery.js',
  from: '    dgs.n_ctx,\n    json.n_ctx,',
  to: '    json.n_ctx,',
  expect: ['default_generation_settings.n_ctx 必须能读出来'],
  run: SEC,
});

M.mutate({
  name: '⑧ 配置没超引擎也说"超出引擎能力"（编造结论）',
  file: 'src/model-discovery.js',
  from: '  if (conf != null && conf > eng) {',
  to: '  if (true) {',
  expect: ['配置没超时必须说"没超"'],
  run: SEC,
});

M.mutate({
  name: '⑨ /props 不从带 /v1 的 baseUrl 推根路径（llama.cpp 上恒读不到）',
  file: 'src/model-discovery.js',
  from: "      const strippedBase = base.replace(/\\/v\\d+$/, '');",
  to: '      const strippedBase = base;',
  expect: ['llama.cpp 的 /props 挂在根上'],
  run: SEC,
});

M.mutate({
  name: '⑩ 配置超出引擎能力不再发告警 banner（"换预设也没用"的根因又只留在日志里）',
  file: 'src/web/server.js',
  from: '                  `⚠ 引擎自述上下文 ${probe.engineCtx} vs 配置 ${capsNow.contextWindow} —— 配置超出引擎能力，长上下文将直接被引擎拒绝` +',
  to: '                  `⚠ 引擎自述上下文 ${probe.engineCtx} vs 配置 ${capsNow.contextWindow} —— 二者不一致` +',
  expect: ['配置超出引擎能力必须是一条**告警 banner**'],
  run: SEC,
});

M.mutate({
  name: '⑪ 预检日志行不再带引擎自述上下文（事后取证又只剩"tools=未知"）',
  file: 'src/web/server.js',
  from: "          `引擎自述上下文=${probe.engineCtx == null ? '未读到' : probe.engineCtx} 配置=${probe.configuredWindow ?? '？'}`",
  to: "          ``",
  expect: ['日志行必须带上引擎自述上下文'],
  run: SEC,
});

// —— 问题 3：子代理进展算父回合进展 ——
M.mutate({
  name: '⑫ 子代理进展不再回调父回合（"在干活的子代理"又被算成整轮无进展）',
  file: 'src/agent.js',
  from: "      if (typeof cfg?.onSubagentProgress === 'function' && (isToolStep || now - lastSubNotifyAt >= 1000)) {",
  to: '      if (false) {',
  expect: ['父回合不得把', '子代理必须真的跑了 9 轮'],
  run: SEC,
});

M.mutate({
  name: '⑬ 继承的截止时刻退回 spawn 时刻的绝对快照（误杀正在干活的子代理——真机原 bug）',
  file: 'src/agent.js',
  from: '      const d = Math.max(snap, live);',
  to: '      const d = snap;',
  expect: ['快照与活值中更晚的那个', '继承的截止时刻必须随父回合进展前移'],
  run: SEC,
});

M.mutate({
  name: '⑭ 继承的截止时刻不再生效（父回合整轮无进展时子代理树挂死）',
  file: 'src/agent.js',
  from: '      const useInherited = inh != null && inh < ownDeadline;',
  to: '      const useInherited = false;',
  expect: ['父回合整轮无进展时子代理必须收口'],
  run: SEC,
});

M.mutate({
  name: '⑮ 收口原因不再区分（用"自己零进展"的文案冒充父回合收口——真机就谎报过"连续 1 分钟"）',
  file: 'src/agent.js',
  from: '          ? inheritedStopNotice({ waitedMs: waited, toolCalls: turnProgress.toolCalls, modelRounds: turnProgress.modelRounds })',
  to: '          ? noProgressNotice({ waitedMs: waited, toolCalls: turnProgress.toolCalls, modelRounds: turnProgress.modelRounds })',
  expect: ['必须把原因如实回传', '不得用"自己零进展"的文案冒充父回合收口'],
  run: SEC,
});

M.mutate({
  name: '⑯ 等子代理时"让子代理先响"的宽限被写成 0（父回合抢先掐断，子代理的结论回不来）',
  file: 'src/agent.js',
  from: '      const grace = turnProgress.subagent && turnProgress.pendingTool ? SUBAGENT_WAIT_GRACE_MS : 0;',
  to: '      const grace = 0;',
  expect: ['父回合等子代理时必须留一点宽限'],
  run: SEC,
});

M.mutate({
  name: '⑰ task 工具结果不再回传子代理自己的进度（轮次/工具调用）',
  file: 'src/agent.js',
  from: '      ? `已跑 ${Number(subTp.modelRounds) || 0} 轮 / ${Number(subTp.toolCalls) || 0} 次工具调用` +',
  to: '      ? `` +',
  expect: ['task 工具结果必须带上子代理自己的进度'],
  run: SEC,
});

M.mutate({
  name: '⑱ task 工具结果不再区分两种收口原因（子代理卡住 vs 父回合整轮无进展）',
  file: 'src/agent.js',
  from: "        (subTp.stallCause === 'inherited' ? '（因父回合整轮无进展而收口）' : subTp.stalled ? '（子代理自身无进展而收口）' : '')",
  to: "        ''",
  expect: ['task 工具结果必须区分两种收口原因'],
  run: SEC,
});

M.mutate({
  name: '⑲ 进度行不再显示子代理跑到哪一步（"等子代理 620s"与"卡死 620s"又同形）',
  file: 'src/agent.js',
  from: "      `子代理${label ? `「${label}」` : ''}已跑 ${Number(subagent.modelRounds) || 0} 轮 / ${Number(subagent.toolCalls) || 0} 次工具调用` +",
  to: "      `` +",
  expect: ['必须能看出子任务进行到哪一步'],
  run: SEC,
});

// —— 问题 4：stalled 必须用户可见 ——
M.mutate({
  name: '⑳ stalled 不再发告警 banner（桌面壳上又只剩"回合收尾：generating=false"）',
  file: 'src/web/server.js',
  from: '      if (r.stalled) {\n        send({\n          type: \'banner\',\n          warn: true,',
  to: '      if (false) {\n        send({\n          type: \'banner\',\n          warn: true,',
  expect: ['stalled 必须由内核发一条**告警 banner**'],
  run: SEC,
});

M.mutate({
  name: '㉑ 收尾文案不再说"在等哪个工具/等了多久"（用户无从判断该调什么）',
  file: 'src/agent.js',
  from: '  const waiting = pendingTool\n    ? `\\n   ⏳ 中止时**正在等待工具 ${pendingTool.name}**',
  to: '  const waiting = false\n    ? `\\n   ⏳ 中止时**正在等待工具 ${pendingTool.name}**',
  expect: ['必须写清"在等哪个工具、等了多久"'],
  run: SEC,
});

M.mutate({
  name: '㉒ 不足 1 分钟又谎报"1 分钟"（真机：刚有进展的子代理被写成"连续 1 分钟没有进展"）',
  file: 'src/agent.js',
  from: "  const howLong = Number(waitedMs) >= 60000 ? `${min} 分钟` : `${Math.max(1, Math.round(Number(waitedMs) / 1000))} 秒`;",
  to: '  const howLong = `${min} 分钟`;',
  expect: ['不足 1 分钟必须按秒说'],
  run: SEC,
});

M.mutate({
  name: '㉓ 不再与 capped/aborted 区分（用户仍然分不清"还能续跑"和"再等也没用"）',
  file: 'src/agent.js',
  from: '    `   ⓘ 这是**整轮零进展**（不是步数上限 capped、也不是你点的停止 aborted）：capped 的回合可以接着续跑，本条是"再等下去也不会产出新东西"。` +',
  to: '    `` +',
  expect: ['必须与 capped/aborted 显式区分'],
  run: SEC,
});

M.mutate({
  name: '㉔ done 事件不再带 stalled 的原因（own / inherited 又混成一句）',
  file: 'src/web/server.js',
  from: '        stallCause: r.perf?.stallCause ?? null,',
  to: '        stallCause: null,',
  expect: ['done 事件必须带 stalled 的原因'],
  run: SEC,
});

M.mutate({
  name: '㉕ 前端不再把结局写进控制台（桌面壳日志与内核 status 又对不上）',
  file: 'src/web/app.js',
  from: "        console.log('[MingDao] done 事件：session=' + ev.session + ' status=' + endStatus + ' durationMs=' + (ev.durationMs||0));",
  to: "        console.log('[MingDao] done 事件：session=' + ev.session);",
  expect: ['前端必须把结局（含 stalled）写进控制台'],
  run: SEC,
});

if (!M.report()) process.exit(1);
