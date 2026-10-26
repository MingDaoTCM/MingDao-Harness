// 批五十四（v0.6.27 §3.94：清理 hidden 兼容节点 + 顶栏重复入口）的变异验证。
//
// 两处技术债 + 重复入口，只删冗余、不删能力：
//   ①删除 #newChatCompat / #legacyRailCompat 两个 hidden 兼容节点（新建入口只剩左栏 #sideNavNew；
//     轨迹/子Agent 由右栏四标签承接）；旧窄条 #trajRailBtn/#subRailBtn 不得以任何形式残留；
//   ②顶栏「会话管理」移入左栏「最近会话」标题右侧（#sideNavSessMgr 复用 openSessModal；
//     #sessMgrBtn 保留 hidden 兼容节点，因为 §153/§155/§158 仍钉它在 header）；「历史会话」
//     #sessions 保留但 hidden。顶栏可见入口 13 → 11。
// 本批把每一处逐个改回缺陷，test/smoke.js §162 必须当场红（要求 ≥6 条，本批 10 条）。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SEC = () => M.section('162');

// ① 兼容包裹层回来了：#newChatCompat 又被塞回顶栏（新建入口回到「一个可见 + 一个隐藏」）
M.mutate({
  name: '① 恢复 #newChatCompat 包裹层',
  file: 'src/web/index.html',
  from: '<button id="newChat" hidden>新对话</button>',
  to: '<span id="newChatCompat" hidden><button id="newChat">新对话</button></span>',
  expect: ['hidden 兼容节点 #newChatCompat 必须已删除'],
  run: SEC,
});

// ② 轨迹/子Agent 的旧窄条兼容节点又回来了（#legacyRailCompat 复活）
M.mutate({
  name: '② 恢复 #legacyRailCompat 隐藏节点',
  file: 'src/web/index.html',
  from: '<!-- v0.6.27 §3.94：#legacyRailCompat 隐藏兼容节点已删除；轨迹/子Agent 由右栏四标签唯一承接。 -->',
  to: '<span id="legacyRailCompat" hidden aria-hidden="true"><span id="trajRailBtn"></span><span id="subRailBtn"></span></span>',
  expect: ['hidden 兼容节点 #legacyRailCompat 必须已删除'],
  run: SEC,
});

// ③ 左栏唯一可见的新建入口被删（顶栏的 #newChat 是 hidden，用户无处新建）
M.mutate({
  name: '③ 删掉左栏 #sideNavNew（唯一可见新建入口）',
  file: 'src/web/index.html',
  from: '<button id="sideNavNew" type="button" title="新建对话">＋<span class="sn-label">新建对话</span></button>',
  to: '',
  expect: ['#sideNavNew 必须仍在'],
  run: SEC,
});

// ④ 左栏新建入口被藏起来（节点在但不可见 = 新建入口消失）
M.mutate({
  name: '④ 左栏 #sideNavNew 被加上 hidden',
  file: 'src/web/index.html',
  from: '<button id="sideNavNew" type="button" title="新建对话">',
  to: '<button id="sideNavNew" type="button" title="新建对话" hidden>',
  expect: ['左栏 #sideNavNew 必须可见'],
  run: SEC,
});

// ⑤ 右栏「子Agent」标签按钮 id 丢失（删窄条兼容节点时连右栏入口一起丢）
M.mutate({
  name: '⑤ 右栏子Agent 标签 #rtSub 的 id 丢失',
  file: 'src/web/index.html',
  from: 'id="rtSub"',
  to: 'id="rtSubOld"',
  expect: ['右栏「子Agent」标签按钮 #rtSub 必须仍在'],
  run: SEC,
});

// ⑥ 左栏会话管理按钮被删（顶栏的那个是 hidden，删除后会话管理无处可点）
M.mutate({
  name: '⑥ 删掉左栏会话管理入口 #sideNavSessMgr',
  file: 'src/web/index.html',
  from: '      <button id="sideNavSessMgr" type="button" title="管理会话（重命名/删除）" aria-label="管理会话">✎</button>\n',
  to: '',
  expect: ['会话管理入口必须移入左栏'],
  run: SEC,
});

// ⑦ 左栏会话管理只留壳、不绑 handler（点不动 = 能力丢失）
M.mutate({
  name: '⑦ 左栏会话管理不绑 openSessModal',
  file: 'src/web/app.js',
  from: '  if (sideSessMgr) sideSessMgr.onclick = openSessModal;',
  to: '  if (sideSessMgr) void sideSessMgr;',
  expect: ['左栏会话管理必须复用 openSessModal'],
  run: SEC,
});

// ⑧ 历史会话又可见：hidden 被拿掉，顶栏可见入口回到 12 个
M.mutate({
  name: '⑧ 顶栏 #sessions 去掉 hidden（可见入口回增）',
  file: 'src/web/index.html',
  from: '<select id="sessions" title="历史会话" hidden>',
  to: '<select id="sessions" title="历史会话">',
  expect: ['顶栏 #sessions 必须是 hidden'],
  run: SEC,
});

// ⑨ 顶栏会话管理又可见：hidden 被拿掉（与左栏入口重复）
M.mutate({
  name: '⑨ 顶栏 #sessMgrBtn 去掉 hidden',
  file: 'src/web/index.html',
  from: '<button id="sessMgrBtn" title="管理会话（重命名/删除）" hidden>',
  to: '<button id="sessMgrBtn" title="管理会话（重命名/删除）">',
  expect: ['顶栏 #sessMgrBtn 必须是 hidden'],
  run: SEC,
});

// ⑩ 设置弹层 id 丢失：清理顶栏入口时连带删掉设置能力
M.mutate({
  name: '⑩ 设置弹层 #cfgModal 的 id 丢失',
  file: 'src/web/index.html',
  from: '<div id="cfgModal" class="modal-mask" style="display:none">',
  to: '<div id="cfgModalOld" class="modal-mask" style="display:none">',
  expect: ['设置入口与 #cfgModal 必须保留'],
  run: SEC,
});
