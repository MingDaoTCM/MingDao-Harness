// 批四十三（v0.6.22 §3.78：界面骨架照设计稿重排）的变异验证。
//
// 先复现：负责人打开设计稿看到三栏（侧栏 / 对话 / 右栏本轮运行 + 底部 composer），实际 UI 是
// "顶栏一堆控件 + 5 个并列面板 + 单列正文"，且 CSS 与设计稿各写一套数值。
// 本批把每一项修复逐个改回缺陷，test/smoke.js §153 的断言必须当场红。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SEC = () => M.section('153');

// ① 顶栏放回模型选择器（"顶栏瘦身"退化成原来那排控件）
M.mutate({
  name: '① 顶栏放回模型选择器',
  file: 'src/web/index.html',
  from: '<div class="top-actions">',
  to: '<div class="top-actions"><select id="modelSel"></select>',
  expect: ['modelSel 必须移出 header'],
  run: SEC,
});

// ② 右栏删掉任务面板（收编时把原面板节点删了 → 功能丢失）
M.mutate({
  name: '② 右栏删掉任务面板节点',
  file: 'src/web/index.html',
  from: '<aside id="tasksPanel"',
  to: '<aside id="tasksPanelX"',
  expect: ['搬进右栏'],
  run: SEC,
});

// ③ 标签页不可切换（四个面板同时显示 / 点了没反应）
M.mutate({
  name: '③ 标签页不可切换（railPanelDisplay 恒 flex）',
  file: 'src/web/app.js',
  from: "  return runOpen && tab === panelTab ? 'flex' : 'none';",
  to: "  return 'flex';",
  expect: ['未选中的标签页必须隐藏'],
  run: SEC,
});

// ④ 断点判据漂移（1180 的右栏抽屉退化成 900 才收）
M.mutate({
  name: '④ 断点判据漂移（narrowRun 改 <900）',
  file: 'src/web/app.js',
  from: 'narrowRun: w < 1180',
  to: 'narrowRun: w < 900',
  expect: ['900–1180 右栏必须收起为抽屉'],
  run: SEC,
});

// ⑤ 侧栏缺会话列表（侧栏只剩搜索/新建，历史会话找不回来）
M.mutate({
  name: '⑤ 侧栏缺会话列表容器',
  file: 'src/web/index.html',
  from: '<nav class="session-scroll" id="sessionNav" aria-label="会话列表"></nav>',
  to: '<nav class="session-scroll" id="sessionNavX" aria-label="会话列表"></nav>',
  expect: ['侧栏必须有 #sessionNav'],
  run: SEC,
});

// ⑥ 底部丢 composer（输入区被挪出底部区 → "composer + 状态条"合并失败）
M.mutate({
  name: '⑥ 底部丢 composer 节点',
  file: 'src/web/index.html',
  from: 'id="composer" class="composer"',
  to: 'id="composerX" class="composer"',
  expect: ['底部必须有 composer'],
  run: SEC,
});

// ⑦ 右栏状态条少一项（六项里丢了上下文）
M.mutate({
  name: '⑦ 右栏状态条少一项（ctx 改名）',
  file: 'src/web/index.html',
  from: 'data-rk="ctx"',
  to: 'data-rk="context"',
  expect: ['右栏状态条六项'],
  run: SEC,
});

// ⑧ 顶栏会话名丢失（"我在哪"没了）
M.mutate({
  name: '⑧ 顶栏丢失当前会话名',
  file: 'src/web/index.html',
  from: '<b id="crumbSession">新对话</b>',
  to: '<b>新对话</b>',
  expect: ['顶栏必须显示当前会话名'],
  run: SEC,
});

// ⑨ 三栏网格值漂移（"大概像"而不是照设计稿 264/1fr/300）
M.mutate({
  name: '⑨ 三栏网格列宽偏离设计稿',
  file: 'src/web/index.html',
  from: 'grid-template-columns:264px minmax(0,1fr) 300px',
  to: 'grid-template-columns:280px minmax(0,1fr) 300px',
  expect: ['.app 的 grid-template-columns 必须与设计稿逐字一致'],
  run: SEC,
});

// ⑩ 设计稿颜色映射漂移（把侧栏映射到 --bg3，而不是设计稿 surface-1=--bg2）
M.mutate({
  name: '⑩ 设计稿颜色映射漂移（surface-1 → bg3）',
  file: 'src/web/index.html',
  from: '--surface-1:var(--bg2);',
  to: '--surface-1:var(--bg3);',
  expect: ['必须别名到既有'],
  run: SEC,
});

// ⑪ 关键次要文本回退成 --faint（对比度重新掉到 3.76:1）
M.mutate({
  name: '⑪ 会话设置来源行回退 --faint',
  file: 'src/web/index.html',
  from: '.ss-src{font-size:11px;color:var(--dim)',
  to: '.ss-src{font-size:11px;color:var(--faint)',
  expect: ['承载信息'],
  run: SEC,
});

// ⑫ 侧栏缺新建会话（工作空间/搜索在，但开不了新对话）
M.mutate({
  name: '⑫ 侧栏缺新建会话入口',
  file: 'src/web/index.html',
  from: 'id="newChat"',
  to: 'id="newChatX"',
  expect: ['侧栏必须有 #newChat'],
  run: SEC,
});

if (!M.report()) process.exit(1);
