// 批五十一（v0.6.25 §3.90：UI 去重 + 最近会话折叠 + 右栏标签上移/概览折叠）的变异验证。
//
// 负责人四条意见：①窄条 🧭/🤖 与右栏四标签重复 → 删按钮与绑定；②顶栏「新对话」与左侧
// 「＋ 新建对话」重复 → 只留左侧（#newChat 用 hidden 兼容节点保留语义）；③「最近会话」可折叠
// 并记 localStorage；④右栏四标签上移、会话配置+本轮数据收进默认折叠的「概览」，内容区拿回高度。
// 本批把每一处逐个改回缺陷，test/smoke.js §159 必须当场红（任务书要求 ≥8 条，本批 14 条）。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SEC = () => M.section('159');

// ① 窄条恢复 🧭：与右栏「轨迹」标签重复的入口又回来了
M.mutate({
  name: '① 窄条恢复轨迹按钮 #trajRailBtn',
  file: 'src/web/index.html',
  from: `<div id="trajRail">
  <!-- §3.88：<900 时左栏收成抽屉，这个窄条图标负责打开/关闭（≥900 隐藏）。 -->
  <button class="rail-btn" id="sideNavRailBtn" title="会话侧栏（打开/关闭）">☰</button>
</div>`,
  to: `<div id="trajRail">
  <button class="rail-btn" id="trajRailBtn" title="轨迹（点击查看详情）">🧭</button>
  <!-- §3.88：<900 时左栏收成抽屉，这个窄条图标负责打开/关闭（≥900 隐藏）。 -->
  <button class="rail-btn" id="sideNavRailBtn" title="会话侧栏（打开/关闭）">☰</button>
</div>`,
  expect: ['左窄条不得再有轨迹按钮 #trajRailBtn'],
  run: SEC,
});

// ② 窄条恢复 🤖：子Agent 入口与右栏「子Agent」标签重复
M.mutate({
  name: '② 窄条恢复子Agent按钮 #subRailBtn',
  file: 'src/web/index.html',
  from: `<div id="trajRail">
  <!-- §3.88：<900 时左栏收成抽屉，这个窄条图标负责打开/关闭（≥900 隐藏）。 -->
  <button class="rail-btn" id="sideNavRailBtn" title="会话侧栏（打开/关闭）">☰</button>
</div>`,
  to: `<div id="trajRail">
  <button class="rail-btn" id="subRailBtn" title="子 Agent">🤖</button>
  <!-- §3.88：<900 时左栏收成抽屉，这个窄条图标负责打开/关闭（≥900 隐藏）。 -->
  <button class="rail-btn" id="sideNavRailBtn" title="会话侧栏（打开/关闭）">☰</button>
</div>`,
  expect: ['左窄条不得再有子Agent按钮 #subRailBtn'],
  run: SEC,
});

// ③ 顶栏「新对话」又可见：hidden 兼容节点被拿掉 hidden，与左侧入口重复
M.mutate({
  name: '③ 顶栏 #newChat 去掉 hidden（可视入口变成两个）',
  file: 'src/web/index.html',
  from: '<span id="newChatCompat" hidden>',
  to: '<span id="newChatCompat">',
  expect: ['顶栏「新对话」必须包在 hidden 兼容节点里'],
  run: SEC,
});

// ④ 最近会话折叠不写 localStorage：重载即忘
M.mutate({
  name: '④ 最近会话折叠不写 localStorage',
  file: 'src/web/app.js',
  from: "  try { if (storage) storage.setItem(RECENT_STORAGE_KEY, collapsed ? '1' : '0'); } catch {}",
  to: '  try { if (storage) void 0; } catch {}',
  expect: ['折叠最近会话必须写 localStorage'],
  run: SEC,
});

// ⑤ 折叠只改 aria、不藏列表：折叠后列表项仍然占着左栏
M.mutate({
  name: '⑤ 折叠后不隐藏 #sideNavSessions（列表仍在）',
  file: 'src/web/app.js',
  from: '  if (box) box.hidden = !!collapsed;',
  to: '  if (box) void box;',
  expect: ['折叠后 #sideNavSessions 必须隐藏'],
  run: SEC,
});

// ⑥ 折叠标题不显示会话数量：只剩「最近会话」，用户不知道有几条
M.mutate({
  name: '⑥ 折叠标题的会话数量不再更新',
  file: 'src/web/app.js',
  from: '  if (el) el.textContent = String(Math.max(0, Number(n) || 0));',
  to: '  if (el) void el;',
  expect: ['折叠标题必须显示当前会话数量'],
  run: SEC,
});

// ⑦ 概览区块 id 丢失（结构塌回旧顺序：标签在概览后/内容区错位）
M.mutate({
  name: '⑦ 概览区块 id 丢失（右栏顺序退回旧结构）',
  file: 'src/web/index.html',
  from: 'id="rpOverview"',
  to: 'id="rpOverviewOld"',
  expect: ['右栏顺序必须是「标题 → 四标签 → 概览 → 内容区 → 底部」'],
  run: SEC,
});

// ⑧ 标签内容区不再 flex:1：四标签内容拿不到剩余高度（又变回小窗口）
M.mutate({
  name: '⑧ .rp-tabbody 不再是 flex:1（内容区高度回退）',
  file: 'src/web/index.html',
  from: '.rp-tabbody{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}',
  to: '.rp-tabbody{flex:none;min-height:0;display:flex;flex-direction:column;overflow:hidden}',
  expect: ['标签内容区 .rp-tabbody 必须 flex:1'],
  run: SEC,
});

// ⑨ 概览默认展开：折叠偏好默认值反了（一进页面就占掉标签高度）
M.mutate({
  name: '⑨ 概览默认展开（默认折叠失效）',
  file: 'src/web/app.js',
  from: "  try { return !!storage && storage.getItem(RP_OVERVIEW_STORAGE_KEY) === '1'; } catch { return false; }",
  to: '  try { return true; } catch { return false; }',
  expect: ['概览默认必须折叠'],
  run: SEC,
});

// ⑩ 摘要漏掉工具数（只剩模型/权限/阶段，负责人给的四段示例少一段）
M.mutate({
  name: '⑩ 概览摘要漏掉工具数',
  file: 'src/web/app.js',
  from: "  return [x.model || x.modelLabel, x.permission, x.phase, x.tools].filter((s) => s != null && s !== '').join(' · ') || '—';",
  to: "  return [x.modelLabel || x.model, x.permission, x.phase].filter((s) => s != null && s !== '').join(' · ') || '—';",
  expect: ['摘要必须同时含模型/权限/阶段/工具数'],
  run: SEC,
});

// ⑪ 概览展开后模型字段改成常量：数据来源不再与 runPanelView() 同源
M.mutate({
  name: '⑪ #rpModel 不再来自 runPanelView()',
  file: 'src/web/app.js',
  from: "  set('#rpModel', v.modelLabel || v.model);",
  to: "  set('#rpModel', '—');",
  expect: ['概览展开后的 #rpModel 必须仍来自 runPanelView()'],
  run: SEC,
});

// ⑫ 左侧「＋ 新建对话」不再复用 #newChat：两个入口各自为政（或左侧失效）
M.mutate({
  name: '⑫ #sideNavNew 不再点 #newChat',
  file: 'src/web/app.js',
  from: "  if (newBtn) newBtn.onclick = () => { const b = $('#newChat'); if (b) b.click(); };",
  to: '  if (newBtn) newBtn.onclick = () => {};',
  expect: ['#sideNavNew 必须复用 #newChat handler'],
  run: SEC,
});

// ⑬ 窄条轨迹按钮的点击绑定又接回来（即使按钮不在，旧入口仍被复活）
M.mutate({
  name: '⑬ 恢复 #trajRailBtn 的点击绑定',
  file: 'src/web/app.js',
  from: "$('#tjClose').onclick=()=>{ setRunPanel(false); };",
  to: "$('#tjClose').onclick=()=>{ setRunPanel(false); };\n$('#trajRailBtn').onclick=()=>activateRailTab('trace');",
  expect: ['轨迹窄条按钮的点击绑定必须删除'],
  run: SEC,
});

// ⑭ 四标签少一个（子Agent）：既有能力回归（右栏只剩三个标签）
M.mutate({
  name: '⑭ RAIL_TABS 少一个子Agent 标签',
  file: 'src/web/app.js',
  from: "const RAIL_TABS = ['trace', 'sub', 'tasks', 'dash'];",
  to: "const RAIL_TABS = ['trace', 'tasks', 'dash'];",
  expect: ['四标签切换的 RAIL_TABS 必须保留'],
  run: SEC,
});

if (!M.report()) process.exit(1);
