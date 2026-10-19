// 批四十四（v0.6.21 §3.82：右栏改成四个标签页）的变异验证。
//
// 第二步界面重排把原来并列的 #trajPanel / #subPanel / #tasksPanel / #dashPanel 搬进 #runPanel，
// 顶栏/左栏既有入口改为「切标签 + 开右栏」。本批把每一处修复逐个改回缺陷，
// test/smoke.js §154 的断言必须当场红——否则"四个标签"就只是四张空壳。
//
// 覆盖（任务书要求 ≥6 条，本批 10 条）：
//   标签切不动 / 默认标签错 / 任务面板被搬出右栏 / 关键子节点 id 丢失 / 任务按钮不切页 /
//   右栏不打开 / 任务标签不刷新 updateTasksPanel / 仪表盘不接 renderDashboard /
//   切标签销毁节点 / 标签按钮 id 丢失。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SEC = () => M.section('154');

// ① 标签切不动：setRailTab 忽略传入的 tab、永远回到轨迹（点了没有任何变化）
M.mutate({
  name: '① 标签切换失效（setRailTab 永远回到轨迹）',
  file: 'src/web/app.js',
  from: "  activeRailTab = RAIL_TABS.includes(tab) ? tab : 'trace';",
  to: "  activeRailTab = 'trace';",
  expect: ['点「任务」标签必须把 activeTab 切成任务'],
  run: SEC,
});

// ② 默认标签错：activeRailTab 初值改成任务（打开右栏先看到任务，轨迹入口的默认语义丢失）
M.mutate({
  name: '② 默认标签写成任务（不是轨迹）',
  file: 'src/web/app.js',
  from: "let activeRailTab = 'trace';",
  to: "let activeRailTab = 'tasks';",
  expect: ['activeRailTab 默认值必须是轨迹'],
  run: SEC,
});

// ③ 任务面板被搬出右栏：标签页还在，但 #tasksPanel/#tpList 整个不见了（只搬了个空标签）
M.mutate({
  name: '③ 任务面板被搬出 #runPanel（#tabTasks 里没有 #tasksPanel）',
  file: 'src/web/index.html',
  from: `    <section id="tabTasks" class="rp-tab rp-tab-flush" role="tabpanel" aria-labelledby="rtTasks" data-tab="tasks" style="display:none">
      <!-- 任务面板：原 <aside id="tasksPanel"> 整体搬入（#tpList/#tpCount 不动），宽度改为跟随右栏。 -->
      <aside id="tasksPanel" style="display:none">
        <div class="tp-head">任务面板 <span id="tpCount"></span><button id="tpClose" style="float:right">✕</button></div>
        <div id="tpList"></div>
      </aside>
    </section>
`,
  to: `    <section id="tabTasks" class="rp-tab rp-tab-flush" role="tabpanel" aria-labelledby="rtTasks" data-tab="tasks" style="display:none">
    </section>
`,
  expect: ['#tasksPanel 必须仍在 #runPanel 内'],
  run: SEC,
});

// ④ 关键子节点 id 丢失：任务列表容器被改成 class（setRailTab 之外没人能再写它）
M.mutate({
  name: '④ 任务列表 #tpList 的 id 丢失',
  file: 'src/web/index.html',
  from: '        <div id="tpList"></div>',
  to: '        <div class="tpList"></div>',
  expect: ['#tpList 必须仍在 #runPanel 内'],
  run: SEC,
});

// ⑤ 任务按钮不切页：入口还开右栏，但永远停在轨迹（用户点「任务」看不到任务）
M.mutate({
  name: '⑤ 顶栏「任务」只开右栏、不切到任务标签',
  file: 'src/web/app.js',
  from: `$('#tasksBtn').onclick=()=>{
  $('#trajRailBtn').classList.remove('on'); $('#subRailBtn').classList.remove('on');
  activateRailTab('tasks');
};`,
  to: `$('#tasksBtn').onclick=()=>{
  $('#trajRailBtn').classList.remove('on'); $('#subRailBtn').classList.remove('on');
  activateRailTab('trace');
};`,
  expect: ['点顶栏「任务」必须切到任务标签'],
  run: SEC,
});

// ⑥ 右栏不打开：activateRailTab 只切 display、不 setRunPanel(true)（窄屏/收起时点任务毫无反应）
M.mutate({
  name: '⑥ activateRailTab 不再打开右栏',
  file: 'src/web/app.js',
  from: `function activateRailTab(tab) {
  setRunPanel(true);
  return setRailTab(tab);
}`,
  to: `function activateRailTab(tab) {
  return setRailTab(tab);
}`,
  expect: ['点顶栏「任务」必须显示右栏'],
  run: SEC,
});

// ⑦ 任务标签不刷新既有任务列表（切过去只有一次陈旧快照，或干脆空白）
M.mutate({
  name: '⑦ 任务标签不再调用 updateTasksPanel()',
  file: 'src/web/app.js',
  from: "  if (activeRailTab === 'tasks' && typeof updateTasksPanel === 'function') updateTasksPanel();",
  to: '  // updateTasksPanel() removed',
  expect: ['任务标签必须仍调用既有 updateTasksPanel'],
  run: SEC,
});

// ⑧ 仪表盘只搬了 DOM、没接数据（KPI 永远 —）
M.mutate({
  name: '⑧ 仪表盘不再调用 renderDashboard(j)',
  file: 'src/web/app.js',
  from: "  if($('#dashPanel').style.display==='flex') renderDashboard(j);",
  to: '  if(false) renderDashboard(j);',
  expect: ['省钱仪表盘仍必须调用既有 renderDashboard'],
  run: SEC,
});

// ⑨ 切标签时销毁节点：把标签页内容清空（节点虽在 HTML 里，一交互就没了）
M.mutate({
  name: '⑨ setRailTab 清空标签页节点（innerHTML）',
  file: 'src/web/app.js',
  from: '  const disp = railTabDisplay(activeRailTab);',
  to: "  const disp = railTabDisplay(activeRailTab); $('#tabTasks').innerHTML = '';",
  expect: ['标签切换不得销毁/重建节点'],
  run: SEC,
});

// ⑩ 标签按钮 id 丢失（顶栏/自动化都点不到「任务」标签）
M.mutate({
  name: '⑩ 「任务」标签按钮 id 丢失',
  file: 'src/web/index.html',
  from: '    <button id="rtTasks" type="button" role="tab" data-tab="tasks"',
  to: '    <button id="rtTask" type="button" role="tab" data-tab="tasks"',
  expect: ['#rtTasks 必须仍在 #runPanel 内'],
  run: SEC,
});

if (!M.report()) process.exit(1);
