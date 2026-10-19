// 批四十五（v0.6.21 §3.83：界面重排第三步——只做视觉细节）的变异验证。
//
// 第三步只允许少量、可逐条核对的 CSS/结构微调（不整段引入设计稿 CSS）：
//   ① 承载信息的次要文本 --faint→--dim（token 本身不动）；
//   ② 顶栏右半区收进 .hdr-right（overflow-x:auto + min-width:0），1000px 下费用/搜索/历史会话不裁切；
//   ③ 右栏四标签统一 .seg 分段控件观感（只改样式，不改切页行为）；
//   ④ 会话设置弹层 padding/gap/圆角/标题字号对齐设计稿。
// 本批把每一处修复逐个改回缺陷，test/smoke.js §155 必须当场红——否则“视觉细节”只是口头描述。
//
// 覆盖（任务书要求 ≥6 条，本批 13 条）：对比度回退/漏点名/rp-foot 漏改/token 被改/顶栏不可滚动/
// 不能收缩/envBadge 不让位/历史会话移出容器/标签少一个 seg 类/分段控件外框回退/选中态回退/
// 弹层 body 间距回退/弹层 effective 间距回退/弹层宽度回退。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SEC = () => M.section('155');

// ① 对比度回退：分组规则的 color 改回 --faint（关键信息又变回 3.26~4.92:1）
M.mutate({
  name: '① 次要文本颜色改回 --faint（对比度修复整体失效）',
  file: 'src/web/index.html',
  from: '.empty-step .es-state{color:var(--dim)}',
  to: '  .empty-step .es-state{color:var(--faint)}',
  expect: ['点名选择器的 color 必须解析为 --dim'],
  run: SEC,
});

// ② 漏点名：rp-foot 说明留在 --faint（这条正是任务书点名的“rp-foot 说明”）
M.mutate({
  name: '② 对比度规则漏掉 rp-foot 说明',
  file: 'src/web/index.html',
  from: '.rp-foot .grow,\n.ss-src,',
  to: '  .ss-src,',
  expect: ['承载信息的次要文本必须点名 .rp-foot .grow'],
  run: SEC,
});

// ③ 改指针变量本身：把 --dim 改成 --faint 的值（任务书明确禁止的“改 token”）
M.mutate({
  name: '③ 改 --dim token 本身（把 --dim 改成 --faint 取值）',
  file: 'src/web/index.html',
  from: '  --text:#F9FAFB; --dim:#ADB2B8; --faint:#81858C;',
  to: '  --text:#F9FAFB; --dim:#81858C; --faint:#81858C;',
  expect: ['--dim 本身不得改动'],
  run: SEC,
});

// ④ 顶栏容器不能横向滚动：overflow-x:auto → visible（1000px 下整条顶栏溢出又回来）
M.mutate({
  name: '④ .hdr-right 不再 overflow-x:auto',
  file: 'src/web/index.html',
  from: 'header .hdr-right{display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:0;overflow-x:auto;overflow-y:hidden;scrollbar-width:thin;scrollbar-color:var(--border) transparent}',
  to: 'header .hdr-right{display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:0;overflow-x:visible;overflow-y:hidden;scrollbar-width:thin;scrollbar-color:var(--border) transparent}',
  expect: ['.hdr-right 必须 overflow-x:auto'],
  run: SEC,
});

// ⑤ flex 子项不能收缩：min-width:0 → auto（容器拒绝小于内容宽度，仍把顶栏撑爆）
M.mutate({
  name: '⑤ .hdr-right 的 min-width:0 被改回 auto',
  file: 'src/web/index.html',
  from: ';min-width:0;overflow-x:auto;overflow-y:hidden;scrollbar-width:thin;scrollbar-color:var(--border) transparent}',
  to: ';min-width:auto;overflow-x:auto;overflow-y:hidden;scrollbar-width:thin;scrollbar-color:var(--border) transparent}',
  expect: ['.hdr-right 必须 min-width:0'],
  run: SEC,
});

// ⑥ 诊断徽标不让位：≤1100px 仍占 111px，历史会话又被挤出可视区
M.mutate({
  name: '⑥ ≤1100px 不再隐藏 #envBadge',
  file: 'src/web/index.html',
  from: '  #envBadge{display:none!important}\n  #wsSel{max-width:120px}',
  to: '  #wsSel{max-width:120px}',
  expect: ['≤1100px 必须隐藏低频诊断徽标 #envBadge'],
  run: SEC,
});

// ⑦ 历史会话移出可滚动容器：仍在顶栏，但不参与 .hdr-right 的横向滚动
M.mutate({
  name: '⑦ 历史会话 #sessions 被移出 .hdr-right',
  file: 'src/web/index.html',
  from: '    <select id="sessions" title="历史会话"><option value="">历史会话</option></select>\n    <button id="tasksBtn" title="任务面板">任务</button>',
  to: '    <button id="tasksBtn" title="任务面板">任务</button>',
  expect: ['#sessions 必须在 .hdr-right 容器内'],
  run: SEC,
});

// ⑦b crumb 不限宽：会话名一长，右半区被挤回 1000px 视口外
M.mutate({
  name: '⑦b #crumb 不再限宽 120px（长会话名把历史会话挤出视口）',
  file: 'src/web/index.html',
  from: '#crumb{max-width:120px}',
  to: '#crumb{max-width:180px}',
  expect: ['#crumb 必须限宽 120px'],
  run: SEC,
});

// ⑧ 标签按钮少一个 seg 类：四个标签不再“统一类”，分段控件样式只命中三个
M.mutate({
  name: '⑧ 「任务」标签按钮丢失 seg 类',
  file: 'src/web/index.html',
  from: '    <button id="rtTasks" type="button" role="tab" data-tab="tasks" aria-selected="false" aria-controls="tabTasks" class="seg">',
  to: '    <button id="rtTasks" type="button" role="tab" data-tab="tasks" aria-selected="false" aria-controls="tabTasks">',
  expect: ['右栏四个标签必须都带同一 seg 类'],
  run: SEC,
});

// ⑨ 分段控件外框回退：回到旧的“一排独立按钮”（padding:0 12px 8px、无 bg3 轨道、无 9px 圆角）
M.mutate({
  name: '⑨ .rp-tabs 分段控件外框回退成旧的一排按钮',
  file: 'src/web/index.html',
  from: '.rp-tabs{display:flex;gap:4px;padding:3px;margin:0 12px 8px;flex:none;background:var(--bg3);border:1px solid var(--border);border-radius:9px}',
  to: '.rp-tabs{display:flex;gap:4px;padding:0 12px 8px;flex:none}',
  expect: ['.rp-tabs 必须包含 padding:3px'],
  run: SEC,
});

// ⑩ 选中态回退：panel 底/ text 字 → bg3 底 / dim 字（选中项和未选中项几乎分不清）
M.mutate({
  name: '⑩ .rp-tabs .seg.on 选中态回退（底色与文字对比丢失）',
  file: 'src/web/index.html',
  from: '.rp-tabs .seg.on{background:var(--panel);color:var(--text);font-weight:600;box-shadow:0 1px 3px rgba(0,0,0,.18)}',
  to: '.rp-tabs .seg.on{background:var(--bg3);color:var(--dim);font-weight:600;box-shadow:0 1px 3px rgba(0,0,0,.18)}',
  expect: ['.rp-tabs .seg.on 必须包含 background:var(--panel)'],
  run: SEC,
});

// ⑪ 弹层 body 间距回退：11px 13px → 10px 12px
M.mutate({
  name: '⑪ 会话设置 .ss-body 内边距回退到 10px 12px',
  file: 'src/web/index.html',
  from: '.ss-body{padding:11px 13px;overflow-y:auto;min-height:0}',
  to: '.ss-body{padding:10px 12px;overflow-y:auto;min-height:0}',
  expect: ['.ss-body 内边距必须对齐设计稿 11px 13px'],
  run: SEC,
});

// ⑫ 弹层 effective 间距回退：13px/11px + 8px 10px → 12px/8px + 7px 9px
M.mutate({
  name: '⑫ 会话设置 .ss-effective 间距回退',
  file: 'src/web/index.html',
  from: '.ss-effective{margin:0 13px 11px;padding:8px 10px;border:1px dashed var(--border);border-radius:8px;font-size:11.5px;color:var(--dim);line-height:1.65}',
  to: '.ss-effective{margin:0 12px 8px;padding:7px 9px;border:1px dashed var(--border);border-radius:8px;font-size:11.5px;color:var(--dim);line-height:1.65}',
  expect: ['.ss-effective 间距必须对齐设计稿'],
  run: SEC,
});

// ⑬ 弹层宽度回退：400px → 410px（设计稿对齐失效）
M.mutate({
  name: '⑬ 会话设置弹层宽度回退到 410px',
  file: 'src/web/index.html',
  from: 'width:min(400px,calc(100vw - 24px));max-height:min(72vh,560px)',
  to: 'width:min(410px,calc(100vw - 24px));max-height:min(72vh,560px)',
  expect: ['#sessSheet 宽度必须对齐设计稿 400px'],
  run: SEC,
});

if (!M.report()) process.exit(1);
