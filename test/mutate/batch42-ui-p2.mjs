// 批四十二（v0.6.19 §3.76：UI P2）的变异验证。
//
// 先复现：设置项只有「一个值」没有默认/影响；删除工作空间/会话、清空记忆、重置配置、
// 切 auto、关沙箱都能一键直达；弹层只是 div，Esc/焦点都不管；所有文案硬编码中文。
// 本批把每一项修复逐个改回缺陷，test/ui-p2.js 的断言必须当场红（每一条都只跑这套独立套件）。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const P2 = () => M.suite('test/ui-p2.js');

// ① 设置项不再计算「影响」（三列剩两列，用户不知道改了会怎样）
M.mutate({
  name: '① 设置项「影响」列变为空（不读前端映射表）',
  file: 'src/web/app.js',
  from: "    impact = (typeof o.translate === 'function' ? o.translate(lang, 'impact.' + key) : '') || SETTING_IMPACT[key] || '';",
  to: "    impact = '';",
  expect: ['影响」文案必须非空'],
  run: P2,
});

// ②「当前值」列不写（默认/影响还在，用户看不到现在生效的是什么）
M.mutate({
  name: '② 三列的当前值不写入（.cfg-current 恒空）',
  file: 'src/web/app.js',
  from: "    put('.cfg-current', v.currentText);",
  to: "    put('.cfg-current', '');",
  expect: ['三列必须由 refreshSettingColumns 写入真实值'],
  run: P2,
});

// ③ 默认值忽略 /api/state.defaults（前端兜底硬编码，服务端默认表形同虚设）
M.mutate({
  name: '③ 忽略 /api/state.defaults（默认列只用前端兜底）',
  file: 'src/web/app.js',
  from: "  const src = state && state.defaults && typeof state.defaults === 'object' ? state.defaults : {};",
  to: "  const src = {};",
  expect: ['默认值必须优先取 /api/state.defaults'],
  run: P2,
});

// ④ 危险操作取消后仍然执行（确认框变成摆设——点了「取消」文件照样被删）
M.mutate({
  name: '④ 危险操作忽略取消结果（confirm=false 仍 execute）',
  file: 'src/web/app.js',
  from: "  if (!confirmed) return { ok: false, cancelled: true };",
  to: "  if (false) return { ok: false, cancelled: true };",
  expect: ['取消不得算执行成功'],
  run: P2,
});

// ⑤ 危险操作确认后不执行（按钮点了没反应——比不确认更糟）
M.mutate({
  name: '⑤ 危险操作确认后不执行（execute 不被调用）',
  file: 'src/web/app.js',
  from: "  const result = await d.execute(key, meta);",
  to: "  const result = null;",
  expect: ['必须把执行结果带回'],
  run: P2,
});

// ⑥ 切 permission=auto 不再二次确认（一键进入"不再逐次确认"）
M.mutate({
  name: '⑥ permission=auto 的门禁失效（dangerGateNeeded 恒 false）',
  file: 'src/web/app.js',
  from: "  if (key === 'permissionAuto') return String(to) === 'auto' && String(from) !== 'auto';",
  to: "  if (key === 'permissionAuto') return false;",
  expect: ['切到 permission=auto 必须先确认'],
  run: P2,
});

// ⑦ 弹层没有 aria-modal（读屏不知道有模态弹层，焦点还能跑到背后的页面）
M.mutate({
  name: '⑦ 对话框缺少 aria-modal（installDialog 不设置）',
  file: 'src/web/app.js',
  from: "  el.setAttribute('aria-modal', 'true');",
  to: "  el.setAttribute('aria-modal', 'false');",
  expect: ['弹层必须设置 aria-modal=true'],
  run: P2,
});

// ⑧ 焦点陷阱失效（Tab 可以跑到弹层外）
M.mutate({
  name: '⑧ Tab 焦点陷阱失效（不再拦截 Tab）',
  file: 'src/web/app.js',
  from: "    if (e.key === 'Tab') {",
  to: "    if (false && e.key === 'Tab') {",
  expect: ['焦点陷阱'],
  run: P2,
});

// ⑨ Esc 不关闭弹层（只能鼠标点，键盘用户被困住）
M.mutate({
  name: '⑨ Esc 不再关闭弹层',
  file: 'src/web/app.js',
  from: "      close(false);\n      return;",
  to: "      return;",
  expect: ['Esc 必须关闭弹层'],
  run: P2,
});

// ⑩ 关闭后不归还焦点（用户不知道焦点回了哪里）
M.mutate({
  name: '⑩ 关闭弹层后不把焦点还给触发元素',
  file: 'src/web/app.js',
  from: "    if (opener && typeof opener.focus === 'function') {",
  to: "    if (false && opener && typeof opener.focus === 'function') {",
  expect: ['关闭后焦点必须回到触发元素'],
  run: P2,
});

// ⑪ aria-live 每秒都写（同一状态重复播报，读屏被刷屏）
M.mutate({
  name: '⑪ aria-live 不再按状态变化节流（每帧都写）',
  file: 'src/web/app.js',
  from: "  if (!r.changed) return false;",
  to: "  if (false && !r.changed) return false;",
  expect: ['同一状态重复渲染不得再次播报'],
  run: P2,
});

// ⑫ 英文表与中文同值（切了语言界面不变——i18n 形同虚设）
M.mutate({
  name: '⑫ 英文文案与中文同值（header.newChat）',
  file: 'src/web/i18n.js',
  from: "  ['header.newChat', '新对话', 'New chat'],",
  to: "  ['header.newChat', '新对话', '新对话'],",
  expect: ['切到英文后文案必须变化'],
  run: P2,
});

// ⑬ 缺失键返回 undefined（界面出现 "undefined" 字符串）
M.mutate({
  name: '⑬ 缺失键返回 undefined（不再安全回退空串）',
  file: 'src/web/i18n.js',
  from: "  if (text == null) return '';",
  to: "  if (text == null) return undefined;",
  expect: ['缺失键不得返回 undefined'],
  run: P2,
});

// ⑭ 语言选择不落 localStorage（刷新就丢，用户每次都要重选）
M.mutate({
  name: '⑭ setLang 不写 localStorage（选择不持久）',
  file: 'src/web/i18n.js',
  from: "    try { o.storage.setItem(LANG_STORAGE_KEY, normal); } catch { /* 隐私模式 / 配额满：不阻断界面 */ }",
  to: "    try { void o.storage; } catch { /* noop */ }",
  expect: ['选择英文必须写 localStorage'],
  run: P2,
});

// ⑮ 确认按钮变成默认提交按钮（回车即可确认——正是二次确认要禁止的）
M.mutate({
  name: '⑮ 确认按钮丢失 type=button（回车可确认）',
  file: 'src/web/index.html',
  from: '<button id="dangerOk" type="button" class="danger"',
  to: '<button id="dangerOk" class="danger"',
  expect: ['确认按钮必须是 type=button'],
  run: P2,
});

if (!M.report()) process.exit(1);
