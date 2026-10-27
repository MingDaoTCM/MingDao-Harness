// 批五十六（v0.6.28 §3.96：左侧空窄条 / 顶栏盖面板 / TTFT 重复打印）的变异验证。
//
// 负责人实测三条：
// ① 左栏左侧还留着一列 42px 空窄条 → 删除元素/CSS/布局补偿，正文左缘回到 0（或紧邻左栏）；
// ② header 实际高度 >52px 时，top:52px 的右栏盖住顶栏 → header 固定 z-index:70，面板 top 用
//    JS 实测的 --hdr-h（加载/resize 写入），而不是猜一个魔法数字；
// ③ 长审计每回合十几次模型请求，⏱ 首帧 每次都打印 → 改为每回合只在第 1 次请求打印。
// 本批把每一处逐个改回缺陷，test/smoke.js §163 必须当场红。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SEC = () => M.section('163');

// ① 恢复空窄条元素：42px 空列回来（正文左缘被推走）
M.mutate({
  name: '① 恢复 #trajRail 空窄条元素',
  file: 'src/web/index.html',
  from: '<aside id="sideNav" aria-label="会话侧栏">',
  to: '<div id="trajRail"></div>\n<aside id="sideNav" aria-label="会话侧栏">',
  expect: ['空窄条必须删除（#trajRail 元素不得存在）'],
  run: SEC,
});

// ② 恢复窄条按钮样式：元素已删，但 .rail-btn 规则又回来了（下一次很容易把按钮装回去）
M.mutate({
  name: '② 恢复 .rail-btn 窄条按钮样式',
  file: 'src/web/index.html',
  from: 'body.side-drawer.side-drawer-open #sideNavRailBtn{border-color:var(--accent2);color:var(--accent2)}',
  to: 'body.side-drawer.side-drawer-open #sideNavRailBtn{border-color:var(--accent2);color:var(--accent2)}\n.rail-btn{width:34px;height:34px;border-radius:10px}',
  expect: ['空窄条 CSS（#trajRail / body.narrow-side #trajRail / .rail-btn / .rail-badge）必须一并删除'],
  run: SEC,
});

// ③ header 没有 z-index：面板重新盖住顶栏（最直接的原缺陷）
M.mutate({
  name: '③ 删除 header 的 z-index（面板盖顶栏）',
  file: 'src/web/index.html',
  from: 'overflow-x:auto;position:relative;z-index:70}',
  to: 'overflow-x:auto;position:relative}',
  expect: ['header 必须 z-index:70（硬性不变量）'],
  run: SEC,
});

// ④ 面板 z-index 反超 header：header 还在，但层叠顺序不再保证它在最上
M.mutate({
  name: '④ 右栏 z-index 反超 header（36 → 80）',
  file: 'src/web/index.html',
  from: '#runPanel{position:fixed;right:0;top:var(--hdr-h,56px);bottom:0;width:300px;background:var(--bg2);border-left:1px solid var(--border);z-index:36;',
  to: '#runPanel{position:fixed;right:0;top:var(--hdr-h,56px);bottom:0;width:300px;background:var(--bg2);border-left:1px solid var(--border);z-index:80;',
  expect: ['必须大于所有固定面板'],
  run: SEC,
});

// ⑤ 面板 top 又写死 52px：顶栏高度一超过 52 就再次被盖住
M.mutate({
  name: '⑤ #runPanel 的 top 写死 52px',
  file: 'src/web/index.html',
  from: '#runPanel{position:fixed;right:0;top:var(--hdr-h,56px);',
  to: '#runPanel{position:fixed;right:0;top:52px;',
  expect: ['#runPanel 的 top 必须使用 var(--hdr-h,56px)，不得写死 52'],
  run: SEC,
});

// ⑥ JS 不再写 --hdr-h：CSS 有 var 也只是永远落到 56px 兜底，实测不变量名存实亡
M.mutate({
  name: '⑥ 删除 JS 写入 --hdr-h',
  file: 'src/web/app.js',
  from: "  if (h > 0) document.documentElement.style.setProperty('--hdr-h', h + 'px');",
  to: '  if (h > 0) void h;',
  expect: ["必须写入 document.documentElement.style.setProperty('--hdr-h', h+'px')"],
  run: SEC,
});

// ⑦ TTFT 恢复每轮都打：3 次模型请求 → 3 行 ⏱ 首帧（负责人实测的刷屏形态）
M.mutate({
  name: '⑦ TTFT 恢复每轮都打印',
  file: 'src/agent.js',
  from: 'if (turnProgress.llmCalls === 1) {',
  to: 'if (turnProgress.llmCalls >= 1) {',
  expect: ['3 次模型请求只允许打印 1 次 ⏱ 首帧'],
  run: SEC,
});

// ⑧ 又把 48px 空窄条补偿加回来：<900 正文左缘重新变成 48
M.mutate({
  name: '⑧ <900 正文恢复 48px 窄条补偿',
  file: 'src/web/index.html',
  from: 'body.side-drawer main,body.side-drawer footer{margin-left:0px}',
  to: 'body.side-drawer main,body.side-drawer footer{margin-left:48px}',
  expect: ['正文左缘必须为 0'],
  run: SEC,
});

if (!M.report()) process.exit(1);
