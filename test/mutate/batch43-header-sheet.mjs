// 批四十三（v0.6.21 §3.81：顶栏不回归 + 模型/预设/权限只留 #sessSheet）的变异验证。
//
// 先复现 v0.6.19 的事故形态（§3.79）：在替代入口可用之前删掉顶栏既有入口 → 按钮只剩 id、
// 用户点不到；把模型/预设/权限从会话设置弹层里弄丢 → 没有地方改；crumb 接了但不更新 →
// 顶栏永远显示「新对话」；截图工具 --open 失效 → sheet.png 拍不到真实弹层。
// 本批把每一处修复逐个改回缺陷，test/smoke.js §153 的断言必须当场红。
//
// 覆盖（任务书要求 ≥5 条，本批 10 条）：
//   历史会话入口 / 任务入口 / 会话设置里的模型、预设选择器 / 模型 change 处理器 /
//   crumb 刷新接线 / crumb 会话名写入 / ⌘K 模型命令用 label / #sessSheet 打不开 /
//   --open 参数不解析 / sheet.png 不再截。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SEC = () => M.section('153');

// ① 顶栏历史会话入口被删（用户无法切换历史会话；只剩一个不可点的空位）。
//    v0.6.27 §3.94：#sessions 保留为 hidden 兼容节点（与左栏重复、计划下一轮移除），锚点同步到实际文本。
M.mutate({
  name: '① 顶栏删掉历史会话入口 #sessions',
  file: 'src/web/index.html',
  from: '    <select id="sessions" title="历史会话" hidden><option value="">历史会话</option></select>\n',
  to: '',
  expect: ['顶栏必须保留历史会话入口 #sessions'],
  run: SEC,
});

// ② 顶栏任务入口被删（任务面板没有入口——v0.6.19「按钮失灵」的同类）
M.mutate({
  name: '② 顶栏删掉任务入口 #tasksBtn',
  file: 'src/web/index.html',
  from: '  <button id="tasksBtn" title="任务面板">任务</button>',
  to: '',
  expect: ['顶栏必须保留任务面板入口 #tasksBtn'],
  run: SEC,
});

// ③ 会话设置里的模型选择器被删（弹层还在，但没有地方改模型）
M.mutate({
  name: '③ 会话设置删掉 #modelSel',
  file: 'src/web/index.html',
  from: '      <select id="modelSel" title="切换模型"></select>\n',
  to: '',
  expect: ['#sessSheet 必须仍含 #modelSel'],
  run: SEC,
});

// ④ 会话设置里的预设选择器被删（预设只能靠 ⌘K，弹层里看不到当前值）
M.mutate({
  name: '④ 会话设置删掉 #presetSel',
  file: 'src/web/index.html',
  from: '      <select id="presetSel" title="智能体预设：一键切换工具白名单/权限/参数组合（选「无预设」恢复默认）"><option value="">无预设</option></select>\n',
  to: '',
  expect: ['#sessSheet 必须仍含 #presetSel'],
  run: SEC,
});

// ⑤ 模型 change 处理器解绑（下拉还在，但选了不写 /api/config——用户以为切了其实没切）
M.mutate({
  name: '⑤ 模型 change 处理器解绑（不写 /api/config）',
  file: 'src/web/app.js',
  from: "$('#modelSel').addEventListener('change', e=>{ runState.modelName=e.target.value; runState.modelLabel=(modelsCache.find((m)=>m&&(m.id||m.name)===e.target.value)||{}).label||e.target.value; applyConfig({model:e.target.value}, e.target); renderSessionSettings(); renderRunPanel(); });",
  to: "$('#modelSel').addEventListener('change', e=>{});",
  expect: ['模型 change 必须把'],
  run: SEC,
});

// ⑥ crumb 不接线（refreshSessions 不再刷新 crumb——切会话后顶栏仍停在旧名字）
M.mutate({
  name: '⑥ crumb 不接线（refreshSessions 后不刷新）',
  file: 'src/web/app.js',
  from: '  if(currentSession&&!q) sel.value=currentSession;\n  renderCrumb();\n}',
  to: '  if(currentSession&&!q) sel.value=currentSession;\n}',
  expect: ['refreshSessions 后必须刷新 crumb'],
  run: SEC,
});

// ⑦ ⌘K 模型命令把 label 交给 setModel（显示名进请求体 → 官方 API 400）
M.mutate({
  name: '⑦ ⌘K 模型命令改用 label（不再用 API id）',
  file: 'src/web/app.js',
  from: 'run: () => a.setModel && a.setModel(mid)',
  to: 'run: () => a.setModel && a.setModel(mtext)',
  expect: ['⌘K 切模型必须仍用 API id'],
  run: SEC,
});

// ⑧ #sessSheet 打不开（openSessionSheet 仍存在，但置 hidden=true——和 v0.6.19 真机一样）
M.mutate({
  name: '⑧ openSessionSheet 反而把弹层藏起来',
  file: 'src/web/app.js',
  from: '  s.hidden = false;',
  to: '  s.hidden = true;',
  expect: ['#sessSheet 必须能被打开'],
  run: SEC,
});

// ⑨ --open 不再被参数解析器接受（命令直接报未知参数，sheet.png 拍不到）
M.mutate({
  name: '⑨ ui-shot 不再接受 --open',
  file: 'scripts/ui-shot.mjs',
  from: "    '--open',\n",
  to: '',
  expect: ['ui-shot 必须接受 --open'],
  run: SEC,
});

// ⑩ sheet.png 不再截（弹层能打开，但证据消失）
M.mutate({
  name: '⑩ ui-shot 不再产出 sheet.png',
  file: 'scripts/ui-shot.mjs',
  from: "  await capture('sheet');",
  to: '  // capture(sheet) removed',
  expect: ['ui-shot 必须产出 sheet.png'],
  run: SEC,
});

if (!M.report()) process.exit(1);
