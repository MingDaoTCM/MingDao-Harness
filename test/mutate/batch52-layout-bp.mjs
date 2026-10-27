// 批五十二（v0.6.26 §3.92 / v0.6.28 §3.96：布局断点修正）的变异验证。
//
// 已确认的布局缺陷（只动布局，不动功能）：
// ①<900 左栏收成覆盖式抽屉后，旧的固定空窄条仍压住居中正文左缘；
// ②#runPanel 的 @media (max-width:1180px) 把右栏在 1180 整点收起，导致 1180 不是三栏。
// v0.6.28 §3.96 起空窄条整体删除：左栏贴 left:0，<900 正文左缘回 0，主区右移量只等于左栏宽度。
// 右栏收起点仍是 1100 并由 body.narrow-run（<1100）收口，1101–1180 右栏 260px 仍可见。
// 本批把每一处逐个改回缺陷，test/smoke.js §160 必须当场红。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SEC = () => M.section('160');

// ① 断点改回 1180：右栏又在 1180 整点收起（设计稿偏差复发）
M.mutate({
  name: '① 右栏收起点改回 1180（1180 整点不再三栏）',
  file: 'src/web/index.html',
  from: `@media (max-width:1100px){
  body.narrow-run.run-open{padding-right:0}`,
  to: `@media (max-width:1180px){
  body.narrow-run.run-open{padding-right:0}`,
  expect: ['右栏收起规则必须写在 max-width:1100px 且由 body.narrow-run 收口（1100 整点仍是三栏）'],
  run: SEC,
});

// ② JS 判据改回 1180：CSS 已下调，但脚本仍在 1100–1180 把右栏当抽屉（1100 整点失效）
M.mutate({
  name: '② layoutClassesFor 的 narrowRun 判据改回 <1180',
  file: 'src/web/app.js',
  from: '  return { narrow: w < 900, narrowRun: w < 1100 };',
  to: '  return { narrow: w < 900, narrowRun: w < 1180 };',
  expect: ['1100 整点必须已是三栏（narrowRun=false）'],
  run: SEC,
});

// ③ 把已回退的窄条补偿又加回来：<900 正文左缘重新变成 48px（空列又出现）
M.mutate({
  name: '③ <900 正文/输入区恢复 48px 窄条补偿（空列回归）',
  file: 'src/web/index.html',
  from: 'body.side-drawer main,body.side-drawer footer{margin-left:0px}',
  to: 'body.side-drawer main,body.side-drawer footer{margin-left:48px}',
  expect: ['880 下正文左缘必须为 0'],
  run: SEC,
});

// ④ 左栏又为已删除的空窄条让位：left:0 → left:42px（正文左缘被推到 282）
M.mutate({
  name: '④ 左栏恢复 left:42px（为已删除的空窄条让位）',
  file: 'src/web/index.html',
  from: '#sideNav{position:fixed;left:0;',
  to: '#sideNav{position:fixed;left:42px;',
  expect: ['左栏必须贴左缘（left:0）'],
  run: SEC,
});

// ⑤ 补偿改成 30px：既不是 0、也不是左栏宽度，正文仍被一段空列压住
M.mutate({
  name: '⑤ <900 正文补偿 0 → 30px（空列回归）',
  file: 'src/web/index.html',
  from: 'body.side-drawer main,body.side-drawer footer{margin-left:0px}',
  to: 'body.side-drawer main,body.side-drawer footer{margin-left:30px}',
  expect: ['880 下正文左缘必须为 0'],
  run: SEC,
});

// ⑥ 1100–1180 右栏被收起：260px 规则还在，但 display:none 让三栏变两栏
M.mutate({
  name: '⑥ 1101–1180 右栏 display:none（该区间不再是三栏）',
  file: 'src/web/index.html',
  from: '  #runPanel{width:260px}',
  to: '  #runPanel{width:260px;display:none}',
  expect: ['1101–1180 右栏必须可见，不得 display:none'],
  run: SEC,
});

// ⑦ 右栏抽屉丢失：<1100 点「运行」也打不开（1000/880 的功能入口被弄没）
M.mutate({
  name: '⑦ <1100 右栏抽屉 display:none（抽屉丢失）',
  file: 'src/web/index.html',
  from: 'body.narrow-run.run-drawer #runPanel{display:flex;top:var(--hdr-h,56px);',
  to: 'body.narrow-run.run-drawer #runPanel{display:none;top:var(--hdr-h,56px);',
  expect: ['1000/880 右栏抽屉必须仍在'],
  run: SEC,
});

// ⑧ 正文补偿加固定最小宽度：窄屏主区被撑出视口（横向溢出）
M.mutate({
  name: '⑧ 窄屏补偿给正文加 min-width:900px（横向溢出）',
  file: 'src/web/index.html',
  from: 'body.side-drawer main,body.side-drawer footer{margin-left:0px}',
  to: 'body.side-drawer main,body.side-drawer footer{margin-left:0px;min-width:900px}',
  expect: ['窄屏补偿只加偏移、不得给正文设固定宽度（否则会出现横向滚动）'],
  run: SEC,
});

// ⑨ body 允许横向滚动：overflow-x:hidden 被拿掉（配合任何超宽内容就出横向滚动条）
M.mutate({
  name: '⑨ body 恢复 overflow-x:auto（允许横向滚动）',
  file: 'src/web/index.html',
  from: 'display:flex;flex-direction:column;overflow-x:hidden;transition:padding .16s ease}',
  to: 'display:flex;flex-direction:column;overflow-x:auto;transition:padding .16s ease}',
  expect: ['body 必须禁止横向滚动（overflow-x:hidden）'],
  run: SEC,
});

// ⑩ 收起规则不再由 narrow-run 收口：1100 整点被 CSS 直接收起（JS 判据再对也没用）
M.mutate({
  name: '⑩ 收起规则去掉 body.narrow-run 收口（1100 整点被误收）',
  file: 'src/web/index.html',
  from: '  body.narrow-run #runPanel{display:none}',
  to: '  #runPanel{display:none}',
  expect: ['右栏收起规则必须写在 max-width:1100px 且由 body.narrow-run 收口（1100 整点仍是三栏）'],
  run: SEC,
});

// ⑪ 左栏抽屉丢失：<900 抽屉打不开（只修右栏不能把左栏一起弄丢）
M.mutate({
  name: '⑪ <900 左栏抽屉 display:none（抽屉打不开）',
  file: 'src/web/index.html',
  from: 'body.side-drawer.side-drawer-open #sideNav{display:flex;',
  to: 'body.side-drawer.side-drawer-open #sideNav{display:none;',
  expect: ['<900 左栏抽屉仍必须能点开（display:flex）'],
  run: SEC,
});

if (!M.report()) process.exit(1);
