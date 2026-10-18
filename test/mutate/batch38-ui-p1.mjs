// 批三十八（v0.6.19 §3.70：P1 界面改造）的变异验证。
//
// 先复现：工具卡一张张堆、开始卡与完成卡插入方向相反（节点被删了重建）；运行信息散在 5 处各自刷新；
// 没有命令面板/快捷键表；模型/预设/权限三个下拉各管一段生命周期且来源不可见；空态是空 <div>；
// 设置 37 个控件平铺无搜索；只有暗色、窄窗不收缩。
// 本批把每一项修复逐个改回缺陷，test/smoke.js §149 的断言必须当场红。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SEC = () => M.section('149');

// ① 时间线聚合退回"一张卡一次调用"（同一轮又散成 N 张，顺序/汇总一起消失）
M.mutate({
  name: '① 工具调用不再聚合到同一张时间线（msg._toolTimeline 不复用）',
  file: 'src/web/app.js',
  from: '  if (msg._toolTimeline) return msg._toolTimeline;',
  to: '  if (false) return msg._toolTimeline;',
  expect: ['同一轮工具调用必须聚合到同一张时间线'],
  run: SEC,
});

// ② 右侧运行面板另算一套（与状态条数据源分叉——正是"两处数字打架"的复发路径）
M.mutate({
  name: '② 右侧运行面板六项另算一套（runPanelView 不再调用 runStripView）',
  file: 'src/web/app.js',
  from: '  const base = runStripView(st, isGenerating);',
  to: "  const base = { phase: '空闲', ttft: '—', tps: '—', ctx: '—', tools: '0 次工具调用', cost: '—' };",
  expect: ['右侧运行面板六项必须与状态条同源'],
  run: SEC,
});

// ③ ⌘K 不响应（命令面板还在，但键盘打不开）
M.mutate({
  name: '③ ⌘K / Ctrl+K 全局快捷键不响应',
  file: 'src/web/app.js',
  from: "  if (mod && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); togglePalette(); return; }",
  to: "  if (false && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); togglePalette(); return; }",
  expect: ['⌘K / Ctrl+K 必须打开命令面板'],
  run: SEC,
});

// ④ 快捷键表写未实现项（把不存在的 ⌘N 新对话列进去——"只列真实存在的"是本节的核心）
M.mutate({
  name: '④ 快捷键表塞入未实现的 ⌘N',
  file: 'src/web/index.html',
  from: '      <div class="shortcut-row" data-shortcut="⌘K">',
  to: '      <div class="shortcut-row" data-shortcut="⌘N"><span class="kbd">⌘N</span><span class="grow">新对话</span></div>\n      <div class="shortcut-row" data-shortcut="⌘K">',
  expect: ['快捷键表不得列未实现项'],
  run: SEC,
});

// ⑤ 设置搜索失效（输入关键字后不匹配项不隐藏——"搜了像没搜"）
M.mutate({
  name: '⑤ 设置搜索不写 hidden（不匹配项仍然可见）',
  file: 'src/web/app.js',
  from: '    el.hidden = searching ? !ok : false;',
  to: '    el.hidden = false;',
  expect: ['设置搜索后不匹配项必须带 hidden'],
  run: SEC,
});

// ⑥ 主题不落盘（刷新就回到跟随系统——用户的选择被静默丢弃）
M.mutate({
  name: '⑥ 主题偏好不写 localStorage',
  file: 'src/web/app.js',
  from: '    try { deps.storage.setItem(THEME_KEY, p); } catch { /* 隐私模式/配额满：不阻断界面 */ }',
  to: '    try { void deps.storage; } catch { /* noop */ }',
  expect: ['主题偏好必须写入 localStorage'],
  run: SEC,
});

// ⑦ 断点类名不切（900px 以下侧栏不收起——窄窗又回到横向拥挤）
M.mutate({
  name: '⑦ 900px 以下不再判定 narrow（侧栏不收起）',
  file: 'src/web/app.js',
  from: '  return { narrow: w < 900, narrowRun: w < 1180 };',
  to: '  return { narrow: false, narrowRun: w < 1180 };',
  expect: ['900px 以下必须收起侧栏'],
  run: SEC,
});

// ⑧ 失败高亮类名丢失（失败步与成功步长得一样——免展开可见的判据没了）
M.mutate({
  name: '⑧ 失败步不再带 fail 高亮类',
  file: 'src/web/app.js',
  from: "    liClass: 'tl-step' + (failed ? ' fail' : ''),",
  to: "    liClass: 'tl-step',",
  expect: ['失败步必须带 fail 高亮'],
  run: SEC,
});

// ⑨ 没有 /compact 端点也列压缩项（造一个点了没用的入口——不造新后端的反面）
M.mutate({
  name: '⑨ 无后端也列出 /compact 压缩项',
  file: 'src/web/app.js',
  from: "  if (s.compactAvailable) add('命令', '压缩上下文（/compact）', { hint: '压缩', keywords: 'compact 压缩 上下文', run: a.compact });",
  to: "  add('命令', '压缩上下文（/compact）', { hint: '压缩', keywords: 'compact 压缩 上下文', run: a.compact });",
  expect: ['没有 /compact 端点时不得列出压缩项'],
  run: SEC,
});

// ⑩ 权限来源写死 default（"来源"又不可见了——P1 的核心诉求之一）
M.mutate({
  name: '⑩ 会话设置的权限来源写死 default',
  file: 'src/web/app.js',
  from: "  return 'permission=' + String(mode || 'ask') + '（来源：' + String(source || 'default') + '）';",
  to: "  return 'permission=' + String(mode || 'ask') + '（来源：default）';",
  expect: ['权限必须显示 permission=值（来源：explicit/preset/config/default）'],
  run: SEC,
});

// ⑪ 示例任务自动发送（误触发付费调用——设计明确要求"只填入、不发送"）
M.mutate({
  name: '⑪ 空态示例任务点击即自动发送',
  file: 'src/web/app.js',
  from: "function fillExampleTask(text) {\n  input.value = String(text == null ? '' : text);",
  to: "function fillExampleTask(text) {\n  send();\n  input.value = String(text == null ? '' : text);",
  expect: ['示例任务只填入输入框，不得自动发送'],
  run: SEC,
});

// ⑫ system 主题不跟随 prefers-color-scheme（"跟随系统"变成永远暗色）
M.mutate({
  name: '⑫ system 主题不再跟随系统（恒暗色）',
  file: 'src/web/app.js',
  from: "  return systemPrefersDark ? 'dark' : 'light';",
  to: "  return 'dark';",
  expect: ['system 主题必须跟随 prefers-color-scheme'],
  run: SEC,
});

// ⑬ 失败步默认被折叠（20 步回合里失败藏在"展开其余 N 步"后面）
M.mutate({
  name: '⑬ 失败步默认被折叠（不再免展开可见）',
  file: 'src/web/app.js',
  from: '  list.forEach((s, i) => { if (s.failed) keep.add(i); });',
  to: '  list.forEach((s, i) => { if (false && s.failed) keep.add(i); });',
  expect: ['失败步免展开即可见'],
  run: SEC,
});

// ⑭ 右栏「停止」不走单一停止出口（点右栏停止与状态条停止行为分叉）
M.mutate({
  name: '⑭ 右栏停止按钮不接 stopTurnFromButton',
  file: 'src/web/app.js',
  from: "$('#rpStop').onclick = () => stopTurnFromButton();",
  to: "$('#rpStop').onclick = () => {};",
  expect: ['右栏「停止」必须走与状态条同一个停止出口'],
  run: SEC,
});

if (!M.report()) process.exit(1);
