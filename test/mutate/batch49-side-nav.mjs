// 批四十九（v0.6.24 §3.88：左侧栏）的变异验证。
//
// 设计稿三栏的左栏是「只增不删」：最容易翻车的地方不是新栏画不出来，而是**顶栏入口被顺手删掉/搬走**
// （v0.6.19 的教训），以及左栏看起来在、实际不渲染分组/点击不切换/折叠不记忆/断点不生效。
// 本批把每一处逐个改回缺陷，test/smoke.js §158 必须当场红（任务书要求 ≥8 条，本批 11 条）。
import { makeMutator } from './lib.mjs';

const M = makeMutator();
const SEC = () => M.section('158');

// ① 顶栏「任务」入口被删（只增不删的核心回归）
M.mutate({
  name: '① 删掉顶栏 #tasksBtn',
  file: 'src/web/index.html',
  from: '<button id="tasksBtn" title="任务面板">任务</button>',
  to: '',
  expect: ['顶栏入口 #tasksBtn 必须仍在'],
  run: SEC,
});

// ② 顶栏「新对话」入口被删（左栏有自己的新建按钮，不代表顶栏可以少）。
//    v0.6.27 §3.94 起 #newChat 直接以 hidden 保留（#newChatCompat 包裹层已删），锚点同步。
M.mutate({
  name: '② 删掉顶栏 #newChat',
  file: 'src/web/index.html',
  from: '<button id="newChat" hidden>新对话</button>',
  to: '',
  expect: ['顶栏入口 #newChat 必须仍在'],
  run: SEC,
});

// ③ 工作空间控件被改名（等价于「搬到左栏」：原 id 不在顶栏了）
M.mutate({
  name: '③ 顶栏 #wsSel 被改名（原入口丢失）',
  file: 'src/web/index.html',
  from: '<select id="wsSel" title="工作空间（切换 / 新建，目录自动创建）"></select>',
  to: '<select id="wsSelMoved" title="工作空间（切换 / 新建，目录自动创建）"></select>',
  expect: ['顶栏入口 #wsSel 必须仍在'],
  run: SEC,
});

// ④ 左栏缺会话列表容器（结构在、列表没了）
M.mutate({
  name: '④ 左栏删掉 #sideNavSessions 容器',
  file: 'src/web/index.html',
  from: '<div id="sideNavSessions" role="list" aria-label="会话列表"></div>',
  to: '',
  expect: ['左栏必须包含 #sideNavSessions'],
  run: SEC,
});

// ⑤ 分组不渲染：只渲染第一组（今天），昨天/本周/更早消失
M.mutate({
  name: '⑤ 只渲染第一组会话（分组不完整）',
  file: 'src/web/app.js',
  from: '  for (const g of list) {\n',
  to: '  for (const g of list.slice(0, 1)) {\n',
  expect: ['四组共 5 条会话必须全部渲染'],
  run: SEC,
});

// ⑥ 点击不切换：监听器在，但回调没有被调用
M.mutate({
  name: '⑥ 左栏会话点击不回传（点了不切换）',
  file: 'src/web/app.js',
  from: "      item.addEventListener('click', () => { if (typeof onPick === 'function') onPick(s); });",
  to: "      item.addEventListener('click', () => { if (typeof onPick === 'function') void s; });",
  expect: ['点击左栏会话必须把该会话交给切换回调'],
  run: SEC,
});

// ⑦ 切换出口不派发 change：值改了但既有 #sessions handler 不被触发
M.mutate({
  name: '⑦ 点击后不派发 #sessions change',
  file: 'src/web/app.js',
  from: '  sel.value = s.file;\n  sel.dispatchEvent(new Event(\'change\'));',
  to: '  sel.value = s.file;',
  expect: ['必须派发一次 change 事件'],
  run: SEC,
});

// ⑧ 折叠不记忆：只改内存，不写 localStorage（重载即忘）
M.mutate({
  name: '⑧ 折叠状态不写 localStorage',
  file: 'src/web/app.js',
  from: "  try { if (storage) storage.setItem(SIDE_NAV_STORAGE_KEY, collapsed ? '1' : '0'); } catch {}",
  to: '  try { if (storage) void 0; } catch {}',
  expect: ['折叠后 localStorage 必须写入 1'],
  run: SEC,
});

// ⑨ 断点不生效：把 mid 档下探到 800，880 被误判成折叠栏而不是抽屉
M.mutate({
  name: '⑨ 900px 断点被改到 800px（880 不再落抽屉）',
  file: 'src/web/app.js',
  from: "  if (w >= 900) return 'mid';",
  to: "  if (w >= 800) return 'mid';",
  expect: ['880 必须落抽屉档'],
  run: SEC,
});

// ⑩ 折叠宽度不对：48px 变成 64px（主区推开量/图标列对不上）
M.mutate({
  name: '⑩ 折叠宽度 48px 变 64px',
  file: 'src/web/app.js',
  from: 'return { mode, collapsed, width: mode === \'drawer\' ? 0 : (collapsed ? 48 : 240), drawer: mode === \'drawer\' };',
  to: 'return { mode, collapsed, width: mode === \'drawer\' ? 0 : (collapsed ? 64 : 240), drawer: mode === \'drawer\' };',
  expect: ['1440 用户折叠后必须是 48px'],
  run: SEC,
});

// ⑪ 主区不右移：左栏盖住正文（300px 三栏只剩两栏叠加）
M.mutate({
  name: '⑪ 删掉主区右移规则（左栏遮正文）',
  file: 'src/web/index.html',
  from: 'body.side-wide main,body.side-wide footer{margin-left:282px}\n',
  to: '',
  expect: ['主区/输入区必须右移 282px'],
  run: SEC,
});

process.exit(M.report() ? 0 : 1);
