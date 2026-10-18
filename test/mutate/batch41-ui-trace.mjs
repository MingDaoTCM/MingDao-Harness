// 批四十一（v0.6.21 §3.73：轨迹 / 子 Agent 收纳）的变异验证。
//
// 先复现：工具调用按次内联成卡片堆在对话流里、子代理只有右侧一个平铺面板；
// 长任务时正文被卡片淹没，窄窗口右栏一收就什么都看不到；摘要与右栏各算一套数字。
// 本批把每一项修复逐个改回缺陷，test/smoke.js §151 的断言必须当场红。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SEC = () => M.section('151');

// ① 对话流恢复内联工具卡（工具开始又走回 timelineToolStart，每轮不再是"一行摘要"）
M.mutate({
  name: '① 对话流恢复内联工具卡（工具开始走 timelineToolStart）',
  file: 'src/web/app.js',
  from: '  traceToolStarted(activeAiMsg, ev);',
  to: '  timelineToolStart(activeAiMsg, ev);',
  expect: ['对话流不得再内联工具卡'],
  run: SEC,
});

// ② 右栏轨迹另算一套统计（摘要与右栏不再是同一函数/同一对象——"两处数字打架"的复发路径）
M.mutate({
  name: '② 右栏轨迹另算一套统计（collectTraceViews 不再用 traceRoundForMsg）',
  file: 'src/web/app.js',
  from: '    .map((m) => traceRoundForMsg(m))',
  to: '    .map((m) => traceRoundView({ round: m._round, tools: m._traj || [], subs: [], now: 0, startedAt: 0 }))',
  expect: ['右栏/末尾区块必须调用 traceRoundForMsg'],
  run: SEC,
});

// ③ 子代理行丢状态字段（运行中/失败/完成在界面上不可见）
M.mutate({
  name: '③ 子代理行丢状态字段（statusText 恒空）',
  file: 'src/web/app.js',
  from: "    statusText: running ? '运行中' : failed ? '失败' : '完成',",
  to: "    statusText: '',",
  expect: ['运行中的子代理状态必须是「运行中」'],
  run: SEC,
});

// ④ 子代理行丢工具次数（只剩名称/轮次，看不出子代理干了多少活）
M.mutate({
  name: '④ 子代理行丢工具次数（toolText 恒空）',
  file: 'src/web/app.js',
  from: "    toolText: toolCalls == null ? '工具次数 —' : toolCalls + ' 次工具',",
  to: "    toolText: '',",
  expect: ['子代理行必须含工具次数'],
  run: SEC,
});

// ⑤ 窄屏不再显示末尾区块（<1180 右栏一收，轨迹/子Agent 直接消失）
M.mutate({
  name: '⑤ 窄屏不再显示末尾轨迹区块（traceDockVisible 恒 false）',
  file: 'src/web/app.js',
  from: '  return layoutClassesFor(width).narrowRun && !panelVisible;',
  to: '  return false;',
  expect: ['窄窗口右栏收起时必须显示末尾轨迹区块'],
  run: SEC,
});

// ⑥ 点摘要不定位（摘要还在，但点了没有任何反应——不知道详情在哪）
M.mutate({
  name: '⑥ 点摘要不再定位（onclick 置空）',
  file: 'src/web/app.js',
  from: '  btn.onclick = () => focusTraceRound(msg._round);',
  to: '  btn.onclick = () => {};',
  expect: ['点摘要必须调用 focusTraceRound'],
  run: SEC,
});

// ⑦ 两块折叠区点了没反应（轨迹/子Agent 变成只能看标题的摆设）
M.mutate({
  name: '⑦ 轨迹/子Agent 折叠头不再绑定 toggleTraceFold',
  file: 'src/web/app.js',
  from: "  document.querySelectorAll('[data-fold]').forEach((btn) => { btn.onclick = () => toggleTraceFold(btn.dataset.fold); });",
  to: "  document.querySelectorAll('[data-fold]').forEach((btn) => { btn.onclick = () => {}; });",
  expect: ['折叠头必须绑定 toggleTraceFold'],
  run: SEC,
});

// ⑧ 运行中的子代理不随 progress 更新（工具次数/最后进展停在 0——又回到"看不出在干活"）
M.mutate({
  name: '⑧ 运行中子代理不随 progress.subagent 更新',
  file: 'src/web/app.js',
  from: '        if (ev.subagent && pendingSubagent) pendingSubagent = mergeSubagentProgress(pendingSubagent, ev.subagent);',
  to: '        if (false && ev.subagent && pendingSubagent) pendingSubagent = mergeSubagentProgress(pendingSubagent, ev.subagent);',
  expect: ['子代理运行中必须随 progress 事件实时更新'],
  run: SEC,
});

if (!M.report()) process.exit(1);
