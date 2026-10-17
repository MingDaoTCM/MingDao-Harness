// 批三十三（v0.6.18 开发线：M-8 第二批——**单行源码文本守卫**收口）的变异验证。
//
// 背景：M-8 指出约 170 处断言在"检查源码文本"而不是"检查行为"（无害重排即红、真实回归
// 落在匹配文本内则绿）。第一批（batch23 / 登记 §3.49）只啃了**跨行匹配**；本批整簇处理
// `src/web/server.js` 的**全部单行源码守卫**（37 处）：
//   · 22 处**行为化**：真起 Web 服务 + 按剧本返回的桩 provider，从 SSE banner / progress /
//     done、桩实际收到的请求体、web-server.log 的真实行取证；
//   · 15 处**加固**：只做行尾归一化（+ 安全处 strip 注释）并显式标注"文本绊线，不是行为证明"。
//
// 每条变异的 `expect` 都是**新断言原文里的关键词**——关键词对不上就算逃逸。
// 逐条与登记 §3.63 的处号对应；本批逐条说明见下方 name。
//
// 本批实测到一个"守卫自己被别处字符串满足"的假绿：§141 的 `/reason=\${probe.reason}/` 只问
// "全文任意一处有没有"，而同文件另一处（引擎探针日志 `预检 <模型> …`）也含同样的字面量——
// chat 预检行丢掉 reason 时旧守卫照样绿。因此 ㉔ 的锚点取 chat 预检行独有的上下文，并把 §141
// 的守卫收紧为「`chat 预检` 行内必须有 `reason=`」（见登记 §3.63「二」）。
import { makeMutator } from './lib.mjs';

const M = makeMutator();
const SEC = (n) => () => M.section(n);

// ── §144（§137 五处 + §93 一处，行为化）────────────────────────────────────
M.mutate({
  name: '① §93 忙锁不释放（删掉 claimedKeys 的 delete 循环）→ §144 第二轮被误判「忙」',
  file: 'src/web/server.js',
  from: '      for (const k of claimedKeys) busySessions.delete(k);\n',
  to: '      // 变异：不释放占用的键\n',
  expect: ['忙锁释放不彻底'],
  run: SEC('144'),
});

M.mutate({
  name: '② §137 服务端不读 body.permission（显式选择被静默丢掉）→ §144 banner 变回预设档',
  file: 'src/web/server.js',
  from: '    const explicitPermission = PERMISSION_MODES.has(String(body.permission)) ? String(body.permission) : null;',
  to: '    const explicitPermission = null; // 变异：不读请求体的 permission',
  expect: ['显式权限必须压过预设声明的只读档'],
  run: SEC('144'),
});

M.mutate({
  name: '③ §137 预设分支丢掉 explicit（判据收不到显式选择）→ §144 banner 变回预设档',
  file: 'src/web/server.js',
  from: 'turnPerm = resolveTurnPermission({ preset: chatPreset, explicit: explicitPermission, configPermission: cfg.permission ?? \'ask\' });',
  to: 'turnPerm = resolveTurnPermission({ preset: chatPreset, configPermission: cfg.permission ?? \'ask\' }); // 变异：丢掉显式选择',
  expect: ['显式权限必须压过预设声明的只读档'],
  run: SEC('144'),
});

M.mutate({
  name: '④ §137 chatCfg.permission 用 config 而不是判据结果（算了不用）→ §144 桩工具表变只读',
  file: 'src/web/server.js',
  from: 'permission: turnPerm.permission',
  to: 'permission: cfg.permission',
  expect: ['write 工具必须真的执行并写盘'],
  run: SEC('144'),
});

M.mutate({
  name: '⑤ §137 createPermission 用 config 而不是 chatCfg.permission → §144 桩工具表变只读',
  file: 'src/web/server.js',
  from: 'const permission = createPermission(chatCfg.permission ?? \'ask\', io);',
  to: 'const permission = createPermission(cfg.permission ?? \'ask\', io); // 变异：判定结果没接上',
  expect: ['write 工具必须真的执行并写盘'],
  run: SEC('144'),
});

M.mutate({
  name: '⑥ §137 权限说明不再随 SSE 下发（turnPerm.banner 被替换）→ §144 banner 拒收',
  file: 'src/web/server.js',
  from: '            : turnPerm.banner,',
  to: '            : \'变异：丢失权限说明\',',
  expect: ['显式权限必须压过预设声明的只读档'],
  run: SEC('144'),
});

// ── §145（§127 一处 + §139 十处 + §140 三处，行为化）──────────────────────
M.mutate({
  name: '⑦ §139 done 事件不再取 perf.zeroToolCalls → §145 空正文回合缺「0 次工具调用」',
  file: 'src/web/server.js',
  from: '      const zeroNote = String(r.perf?.zeroToolCalls || \'\');',
  to: '      const zeroNote = \'\'; // 变异：丢掉零工具提示',
  expect: ['done.note 必须带上「0 次工具调用」'],
  run: SEC('145'),
});

M.mutate({
  name: '⑧ §139 收尾提示改成覆盖式（baseNote 被 zeroNote 顶掉）→ §145 两段文案只剩一段',
  file: 'src/web/server.js',
  from: '        note: [baseNote, zeroNote].filter(Boolean).join(\'\\n\'),',
  to: '        note: zeroNote, // 变异：覆盖式写法',
  expect: ['done.note 必须同时保留 baseNote'],
  run: SEC('145'),
});

M.mutate({
  name: '⑨ §139 发送前规模预告不落日志（chat 预告 行被改坏）→ §145 日志缺预告',
  file: 'src/web/server.js',
  from: 'srvlog(`chat 预告 ${taskId} ',
  to: 'srvlog(`chat 预告X ${taskId} ',
  expect: ['web-server.log 必须落「chat 预告」行'],
  run: SEC('145'),
});

M.mutate({
  name: '⑩ §139 首帧时延不落日志（chat 首帧 行被改坏）→ §145 日志缺首帧',
  file: 'src/web/server.js',
  from: 'srvlog(`chat 首帧 ${taskId} ',
  to: 'srvlog(`chat 首帧X ${taskId} ',
  expect: ['web-server.log 必须落「chat 首帧」行'],
  run: SEC('145'),
});

M.mutate({
  name: '⑪ §139 进度行不落日志（chat 进度 行被改坏）→ §145 进度行计数为 0',
  file: 'src/web/server.js',
  from: '        `chat 进度 ${taskId} ` +',
  to: '        `chat 进度X ${taskId} ` +',
  expect: ['进度日志必须限频'],
  run: SEC('145'),
});

M.mutate({
  name: '⑫ §139 进度行改用 JSON.stringify（不再与 agent 共用 formatTurnProgress）→ §145 四项缺失',
  file: 'src/web/server.js',
  from: '          formatTurnProgress({',
  to: '          JSON.stringify({',
  expect: ['进度行必须由 formatTurnProgress 产出'],
  run: SEC('145'),
});

M.mutate({
  name: '⑬ §139 进度日志去掉 30s 限频（每 5s 写一行）→ §145 11 秒回合出现 2 行',
  file: 'src/web/server.js',
  from: '      if (Date.now() - lastProgressLogAt < 30000) return;',
  to: '      if (false) return; // 变异：去掉限频',
  expect: ['进度日志必须限频'],
  run: SEC('145'),
});

M.mutate({
  name: '⑭ §139 progress 事件丢掉 toolCalls（0 也不再带）→ §145 字段变为 undefined',
  file: 'src/web/server.js',
  from: '          toolCalls: tp?.toolCalls ?? 0,',
  to: '          toolCalls: undefined, // 变异：0 也不带',
  expect: ['progress 事件必须带工具调用数'],
  run: SEC('145'),
});

M.mutate({
  name: '⑮ §139 progress 事件丢掉 pendingTool（等待中的工具不可见）→ §145 取不到 bash',
  file: 'src/web/server.js',
  from: '          pendingTool: tp?.pendingTool ? { name: tp.pendingTool.name, ms: Date.now() - tp.pendingTool.startedAt } : null,',
  to: '          pendingTool: null, // 变异：等待中的工具不可见',
  expect: ['progress 事件必须带「正在等待哪个工具」'],
  run: SEC('145'),
});

M.mutate({
  name: '⑯ §127 Web 侧 capHit 又标成 done → §145 跑满步数后 status=done',
  file: 'src/web/server.js',
  from: '      entry.status = r.aborted ? \'aborted\' : r.stalled ? \'stalled\' : r.capHit ? \'capped\' : \'done\';',
  to: '      entry.status = r.aborted ? \'aborted\' : r.stalled ? \'stalled\' : \'done\'; // 变异：capHit 冒充 done',
  expect: ['Web 侧 capHit 不得再标成 done'],
  run: SEC('145'),
});

M.mutate({
  name: '⑰ §139 无进展中止的任务状态冒充 done（stalled 分支被删）→ §145 status=done',
  file: 'src/web/server.js',
  from: '      entry.status = r.aborted ? \'aborted\' : r.stalled ? \'stalled\' : r.capHit ? \'capped\' : \'done\';',
  to: '      entry.status = r.aborted ? \'aborted\' : r.capHit ? \'capped\' : \'done\'; // 变异：stalled 冒充 done',
  expect: ['无进展中止的任务状态必须是 stalled'],
  run: SEC('145'),
});

M.mutate({
  name: '⑱ §140 stalled 告警 banner 文案丢掉「不是步数上限/停止」的区分 → §145 banner 拒收',
  file: 'src/web/server.js',
  from: '本轮因**长时间无进展**已中止（不是步数上限 capped、也不是你点的停止 aborted）',
  to: '本轮因长时间无进展已中止',
  expect: ['stalled 必须发一条告警 banner'],
  run: SEC('145'),
});

M.mutate({
  name: '⑲ §140 done 事件不再带 stallCause → §145 stallCause 为 null',
  file: 'src/web/server.js',
  from: '        stallCause: r.perf?.stallCause ?? null,',
  to: '        stallCause: null, // 变异：原因丢了',
  expect: ['done 事件必须带 stalled 的原因'],
  run: SEC('145'),
});

M.mutate({
  name: '⑳ §140 done 事件不再带 stalled 字段 → §145 stalled 为 false',
  file: 'src/web/server.js',
  from: '        stalled: Boolean(r.stalled),',
  to: '        stalled: false, // 变异：前端分不清正常完成与无进展中止',
  expect: ['done 事件必须带 stalled=true'],
  run: SEC('145'),
});

// ── §146（§111 一处，行为化）──────────────────────────────────────────────
M.mutate({
  name: '㉑ §111 WebUI 视觉门控退回只看内置预设（resolveVisionSupport 结果被丢弃）→ §146 图片被拒',
  file: 'src/web/server.js',
  from: '    const visionSupported = await resolveVisionSupport(cfg, modelName);',
  to: '    const visionSupported = false; // 变异：自定义 Provider 的自述被忽略',
  expect: ['自定义视觉模型的图片必须以 image_url 真的进到上游请求里'],
  run: SEC('146'),
});


M.mutate({
  name: '㉖ §139 预检结论不落日志（chat 预检 行被改坏）→ §145 日志缺预检行',
  file: 'src/web/server.js',
  from: 'srvlog(`chat 预检 ${taskId} ',
  to: 'srvlog(`chat 预检X ${taskId} ',
  expect: ['web-server.log 必须落「chat 预检」行'],
  run: SEC('145'),
});

M.mutate({
  name: '㉗ §139 端点预检结论没交给本回合（endpointProbe 赋值被删）→ §145 预告行缺「端点预检：」',
  file: 'src/web/server.js',
  from: '          chatCfg = { ...chatCfg, endpointProbe: probe };',
  to: '          chatCfg = { ...chatCfg }; // 变异：预检结论没交给本回合',
  expect: ['发送前的规模预告必须带上端点预检结论'],
  run: SEC('145'),
});

M.mutate({
  name: '㉘ §139 预设别名提示不再下发（aliasedFrom 分支被关掉）→ §144 banner 缺「已更名」',
  file: 'src/web/server.js',
  from: '        if (chatPreset.aliasedFrom) {',
  to: '        if (false) { // 变异：别名提示丢了',
  expect: ['WebUI 必须在用到别名时给出「已更名」提示'],
  run: SEC('144'),
});

// ── 加固类（文本绊线仍然抓得住自己那一处）──────────────────────────────
M.mutate({
  name: '㉒ §142 progress 事件不再带 localQueue（加固处仍须红）',
  file: 'src/web/server.js',
  from: '            localQueue: tp.localQueue ?? null,',
  to: '            localQueue: null, // 变异：串行化状态不再落日志',
  expect: ['服务端 progress 事件必须带上 localQueue'],
  run: SEC('142'),
});

M.mutate({
  name: '㉓ §140 progress 事件不再带 subagent 快照（加固处仍须红）',
  file: 'src/web/server.js',
  from: '          subagent: tp?.subagent',
  to: '          subagent: undefined',
  expect: ['progress 事件必须带子代理快照'],
  run: SEC('140'),
});

M.mutate({
  name: '㉔ §141 预检失败原因不再落日志（reason= 被改坏；加固处仍须红）',
  file: 'src/web/server.js',
  from: '` reason=${probe.reason}` : \'\'} ${probe.note}',
  to: '` reasonX=${probe.reason}` : \'\'} ${probe.note}',
  expect: ['失败原因（reason）必须落进 web-server.log'],
  run: SEC('141'),
});

if (!M.report()) process.exit(1);
