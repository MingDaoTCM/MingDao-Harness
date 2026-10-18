// P2 界面套件（v0.6.19 §3.76）：设置三列 / 危险操作二次确认 / 无障碍 / i18n。
//
// 风格照 test/api-contracts.js：`node test/ui-p2.js` 直接跑，断言失败 → 非 0 退出。
// 不引入 jsdom：沿用 smoke §148/§149/§151 的做法——从 app.js 抽出纯函数段用 new Function
// 执行，DOM 行为用桩元素/桩 document 驱动（installDialog / updateLiveRegion 都是可注入的）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const appSrc = fs.readFileSync(path.join(root, 'src', 'web', 'app.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(root, 'src', 'web', 'index.html'), 'utf8');
const i18n = await import(pathToFileURL(path.join(root, 'src', 'web', 'i18n.js')).href);

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`  ✓ P2[${name}]`);
};

// —— 抽 P2 纯函数段（从 P2 纯函数标题到 P1 DOM 接线标题） ——
const start = appSrc.indexOf('// P2 纯函数（v0.6.19 §3.76）');
const end = appSrc.indexOf('// P1 DOM 接线（v0.6.19 §3.70）');
assert.ok(start >= 0 && end > start, '（前置）app.js 必须能定位 P2 纯函数段');
const pureSrc = appSrc.slice(start, end);
const P = new Function(
  'translate',
  'getLang',
  pureSrc +
    `\nreturn { SETTING_KEYS, SETTING_IMPACT, SETTING_DEFAULTS_FALLBACK, settingDefaultsFromState,
      settingDisplayValue, settingValueView, settingColumnsView,
      DANGER_ACTIONS, DANGER_KEYS, dangerMeta, dangerGateNeeded, runDanger,
      dialogFocusables, trapTabTarget, applyDialogSemantics, installDialog,
      liveSnapshot, liveAnnouncement, contrastRatio, contrastAudit, CONTRAST_TOKENS };`
)(i18n.translate, i18n.getLang);

// —— ① 设置项三列：默认 / 当前 / 影响 ——
{
  const keysFromHtml = [...htmlSrc.matchAll(/<div class="cfg-cols" data-cols="([a-zA-Z]+)"[^>]*>/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(keysFromHtml)].sort(),
    [...P.SETTING_KEYS].sort(),
    `设置面板的 data-cols 必须覆盖全部设置项（${P.SETTING_KEYS.join('/')}），实际：${keysFromHtml.join(',')}`
  );
  for (const cls of ['cfg-default', 'cfg-current', 'cfg-impact']) {
    const n = (htmlSrc.match(new RegExp(`class="${cls}"`, 'g')) || []).length;
    assert.equal(n, P.SETTING_KEYS.length, `每个设置项都必须有 .${cls} 一列，实际 ${n} 个（应为 ${P.SETTING_KEYS.length}）`);
  }
  assert.ok(/data-setting="contextBudget"/.test(htmlSrc), '上下文预算行必须带 data-setting（供三列写入）');
  assert.ok(/data-setting="language"/.test(htmlSrc), '语言行必须带 data-setting（语言选择属于设置项）');
  const defaults = P.settingDefaultsFromState({
    defaults: { permission: 'ask', sandbox: 'off', routing: false, contextBudget: 96000, autostart: false, notify: true },
  });
  assert.equal(defaults.contextBudget, 96000, '默认值必须优先取 /api/state.defaults 的 contextBudget（不能被前端兜底覆盖）');
  assert.equal(defaults.sandbox, 'off', '默认值必须优先取 /api/state.defaults 的 sandbox');
  assert.equal(P.settingDefaultsFromState({}).contextBudget, 128000, '服务端没给 defaults 时必须有同值兜底');
  const views = P.settingColumnsView({
    defaults,
    values: { permission: 'auto', sandbox: 'safe', routing: true, contextBudget: 64000, timeout: { firstTokenMs: 20000 }, autostart: true, notify: false, theme: 'light', language: 'en' },
    lang: 'zh',
    translate: i18n.translate,
  });
  assert.equal(views.length, P.SETTING_KEYS.length, '三列视图必须覆盖全部设置项');
  for (const v of views) {
    assert.ok(v.defaultText && v.defaultText !== 'undefined', `${v.key} 的默认值必须非空（不得显示 undefined）`);
    assert.ok(v.currentText && v.currentText !== 'undefined', `${v.key} 的当前值必须非空（不得显示 undefined）`);
    assert.ok(typeof v.impact === 'string' && v.impact.trim().length > 0, `${v.key} 的「影响」文案必须非空`);
    assert.ok(v.impact === P.SETTING_IMPACT[v.key], `${v.key} 的影响文案必须来自前端映射表`);
  }
  const budget = views.find((v) => v.key === 'contextBudget');
  assert.equal(budget.defaultText, '96000', '默认列必须显示 /api/state.defaults 透出的默认值');
  assert.equal(P.SETTING_DEFAULTS_FALLBACK.contextBudget, 128000, '前端兜底默认值必须与 config.js 内置表同口径（128000）');
  assert.equal(budget.currentText, '64000', '当前列必须显示当前 config 值');
  assert.ok(budget.impact.includes('contextBudget') && budget.impact.includes('压缩'), 'contextBudget 的影响必须说清"改小更易触发压缩"');
  assert.equal(budget.changed, true, '默认值与当前值不同时必须标 changed');
  const viewEn = P.settingColumnsView({ defaults, values: { sandbox: 'safe' }, lang: 'en', translate: i18n.translate }).find((v) => v.key === 'sandbox');
  assert.ok(viewEn.impact.includes('sandbox') || viewEn.impact.includes('bash'), '英文环境必须取 i18n 的 impact.* 文案');
  assert.ok(/\.cfg-cols\{/.test(htmlSrc) && /\.cfg-impact\{/.test(htmlSrc), '三列必须有对应样式（.cfg-cols/.cfg-impact）');
  assert.ok(/put\('\.cfg-impact', v\.impact\)/.test(appSrc) && /put\('\.cfg-current', v\.currentText\)/.test(appSrc), '三列必须由 refreshSettingColumns 写入真实值（默认/当前/影响）');
  assert.ok(/id="cfgReset"/.test(htmlSrc), '设置面板必须有「恢复默认配置」入口');
  ok('设置三列（默认/当前/影响，影响非空且来自前端映射表）');
}

// —— ② 六类危险操作：先确认、取消不执行、确认才执行 ——
{
  assert.deepEqual([...P.DANGER_KEYS].sort(), ['clearMemory', 'deleteSession', 'permissionAuto', 'removeWorkspace', 'resetConfig', 'sandboxOff'].sort(),
    `危险操作必须且只能有六类，实际：${P.DANGER_KEYS.join(',')}`);
  const called = [];
  for (const key of P.DANGER_KEYS) {
    const meta = P.dangerMeta(key, i18n.translate, 'zh');
    assert.ok(meta, `${key} 必须有确认框元数据`);
    assert.ok(meta.title && meta.consequence, `${key} 的确认框必须说明标题与后果`);
    assert.ok(meta.consequence.length > 10, `${key} 的后果必须是一句可执行的说明，实际：${meta.consequence}`);
    assert.equal(meta.confirmLabel, '确认', '确认按钮必须叫「确认」');
    assert.ok(/回车/.test(meta.note) && /Esc/.test(meta.note), '确认框必须写明"回车不确认 / Esc 取消"');
    // 取消：confirm 返回 false —— execute 绝不能被调用
    const cancelOrder = [];
    const cancelled = await P.runDanger(key, {
      confirm: async () => { cancelOrder.push('confirm'); return false; },
      execute: async () => { cancelOrder.push('execute'); return 'bad'; },
    });
    assert.equal(cancelled.ok, false, `${key}：取消不得算执行成功`);
    assert.equal(cancelled.cancelled, true, `${key}：取消必须返回 cancelled=true`);
    assert.deepEqual(cancelOrder, ['confirm'], `${key}：点取消后不得执行（实际调用：${cancelOrder.join(' → ')}）`);
    // 确认：confirm 返回 true —— 先确认、后执行
    const order = [];
    const done = await P.runDanger(key, {
      confirm: async (m) => { order.push('confirm:' + m.key); return true; },
      execute: async (k) => { order.push('execute:' + k); return 'done'; },
    });
    assert.equal(done.ok, true, `${key}：确认后必须执行`);
    assert.equal(done.result, 'done', `${key}：必须把执行结果带回`);
    assert.deepEqual(order, ['confirm:' + key, 'execute:' + key], `${key}：必须先弹确认、点确认后才执行（实际：${order.join(' → ')}）`);
    called.push(key);
    assert.ok(appSrc.includes(`confirmDanger('${key}'`), `${key} 的实际调用点必须走 confirmDanger（不能绕过确认直接执行）`);
  }
  assert.deepEqual(called.sort(), [...P.DANGER_KEYS].sort(), '六类危险操作必须逐一验证');
  // 门禁判据：同值切换不弹；permission=auto / sandbox=off 才弹
  assert.equal(P.dangerGateNeeded('permissionAuto', 'ask', 'auto'), true, '切到 permission=auto 必须先确认');
  assert.equal(P.dangerGateNeeded('permissionAuto', 'auto', 'auto'), false, '已经是 auto 时同值切换不弹确认');
  assert.equal(P.dangerGateNeeded('permissionAuto', 'auto', 'readonly'), false, '切到更严的权限不需要危险确认');
  assert.equal(P.dangerGateNeeded('sandboxOff', 'readonly', 'off'), true, '关闭沙箱必须先确认');
  assert.equal(P.dangerGateNeeded('sandboxOff', 'off', 'off'), false, '沙箱已是 off 时同值切换不弹确认');
  // 确认框结构：确认按钮是普通 button（不是 submit，回车不会默认触发），初始焦点在取消
  assert.ok(/id="dangerDialog"[^>]*role="dialog"[^>]*aria-modal="true"/.test(htmlSrc), '确认框必须有 role=dialog + aria-modal=true');
  assert.ok(/id="dangerOk"[^>]*type="button"/.test(htmlSrc), '确认按钮必须是 type=button（回车不得默认提交/确认）');
  assert.ok(/id="dangerCancel"[^>]*type="button"/.test(htmlSrc), '取消按钮必须是 type=button');
  assert.ok(/id="dangerOk"[^>]*>确认</.test(htmlSrc), '确认按钮文案必须是「确认」');
  assert.ok(/id="dangerNote"[^>]*>需要点击「确认」才会执行；按回车不会确认，Esc 取消。/.test(htmlSrc), '确认框必须明确"必须点击确认"');
  assert.ok(/initialFocus: cancel/.test(appSrc), '确认框初始焦点必须落在「取消」（避免误按回车直接执行）');
  ok('六类危险操作：先确认、取消不执行、确认才执行（含门禁判据）');
}

// —— ③ 无障碍：role/aria-modal / 焦点陷阱 / Esc / 焦点归还 / aria-live 仅状态变化 ——
{
  const makeEl = (name) => ({
    name,
    attrs: /** @type {Record<string,string>} */ ({}),
    hidden: false,
    focused: false,
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; },
    querySelectorAll() { return []; },
    focus() { this.focused = true; },
  });
  const cancel = makeEl('cancel');
  const okBtn = makeEl('ok');
  const dialog = makeEl('dialog');
  dialog.querySelectorAll = () => [cancel, okBtn];
  const keydown = [];
  const doc = {
    activeElement: null,
    addEventListener(type, fn) { if (type === 'keydown') keydown.push(fn); },
    removeEventListener(type, fn) { const i = keydown.indexOf(fn); if (i >= 0) keydown.splice(i, 1); },
  };
  let closed = false;
  const handle = P.installDialog(dialog, { document: doc, opener: makeEl('opener'), label: '危险确认', initialFocus: cancel, onClose: () => { closed = true; } });
  assert.equal(dialog.attrs.role, 'dialog', '弹层必须设置 role=dialog');
  assert.equal(dialog.attrs['aria-modal'], 'true', '弹层必须设置 aria-modal=true');
  assert.equal(dialog.attrs['aria-label'], '危险确认', '弹层必须有 aria-label（读屏知道这是什么）');
  assert.equal(cancel.focused, true, '打开后焦点必须进入弹层（初始焦点在取消）');
  const fire = (ev) => { for (const fn of [...keydown]) fn(ev); };
  // Tab 从最后一个元素回到第一个（焦点陷阱）
  okBtn.focused = false; cancel.focused = false; doc.activeElement = okBtn;
  fire({ key: 'Tab', shiftKey: false, preventDefault() {}, stopPropagation() {} });
  assert.equal(cancel.focused, true, 'Tab 在最后一个可聚焦元素上必须回到第一个（焦点陷阱）');
  cancel.focused = false; okBtn.focused = false; doc.activeElement = cancel;
  fire({ key: 'Tab', shiftKey: true, preventDefault() {}, stopPropagation() {} });
  assert.equal(okBtn.focused, true, 'Shift+Tab 在第一个元素上必须回到最后一个（焦点陷阱）');
  // Esc 关闭 + 焦点归还
  const opener = makeEl('opener');
  const h2 = P.installDialog(dialog, { document: doc, opener, label: 'x', initialFocus: cancel, onClose: () => { closed = true; } });
  fire({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(closed, true, 'Esc 必须关闭弹层');
  assert.equal(opener.focused, true, '关闭后焦点必须回到触发元素');
  assert.equal(keydown.length, 0, '关闭后必须移除键盘监听（不残留焦点陷阱）');
  h2.close();
  assert.equal(P.trapTabTarget(false, 2, 3), 0, 'trapTabTarget：末项 Tab → 首项');
  assert.equal(P.trapTabTarget(true, 0, 3), 2, 'trapTabTarget：首项 Shift+Tab → 末项');
  assert.equal(P.trapTabTarget(false, -1, 3), 0, '焦点在弹层外时 Tab 进入首项');
  assert.equal(P.trapTabTarget(true, -1, 3), 2, '焦点在弹层外时 Shift+Tab 进入末项');
  assert.equal(P.trapTabTarget(false, 0, 0), -1, '没有可聚焦元素时返回 -1');

  // aria-live：只在状态变化时写 DOM
  const liveNode = { textContent: '' };
  const liveSrcStart = appSrc.indexOf('// —— aria-live：只在状态变化时写');
  const liveSrcEnd = appSrc.indexOf('// —— 语言切换');
  assert.ok(liveSrcStart >= 0 && liveSrcEnd > liveSrcStart, '（前置）应能定位 updateLiveRegion 段');
  const U = new Function('$', 'liveAnnouncement', appSrc.slice(liveSrcStart, liveSrcEnd) + '\nreturn updateLiveRegion;')(
    (sel) => (sel === '#a11yLive' ? liveNode : null),
    P.liveAnnouncement
  );
  const view = { phase: '执行工具', toolCount: 2, failed: 0, subs: [{ status: 'running' }] };
  assert.equal(U(view), true, '首次状态必须播报');
  assert.ok(liveNode.textContent.includes('执行工具') && liveNode.textContent.includes('2 次工具调用'), '播报内容必须含阶段与工具步数');
  const firstText = liveNode.textContent;
  assert.equal(U(view), false, '同一状态重复渲染不得再次播报');
  assert.equal(liveNode.textContent, firstText, '同一状态重复渲染不得改写 aria-live 文本');
  view.toolCount = 3;
  assert.equal(U(view), true, '状态变化（工具步数）必须再次播报');
  assert.ok(liveNode.textContent.includes('3 次工具调用'), '状态变化后的播报必须反映新值');
  assert.notEqual(liveNode.textContent, firstText);
  // 结构：状态条/时间线/子代理行都必须有 aria-live=polite
  assert.ok(/id="runStrip"[^>]*role="status"[^>]*aria-live="polite"/.test(htmlSrc), '状态条必须是 role=status + aria-live=polite');
  for (const id of ['rpTraceList', 'rpSubList', 'tdTraceList', 'tdSubList']) {
    assert.ok(new RegExp(`id="${id}"[^>]*aria-live="polite"`).test(htmlSrc), `时间线/子代理容器 #${id} 必须有 aria-live=polite`);
  }
  assert.ok(/state\.setAttribute\('aria-live', 'polite'\)/.test(appSrc), '子代理状态行必须有 aria-live=polite');
  assert.ok(/st\.setAttribute\('aria-live', 'polite'\)/.test(appSrc), '工具步骤状态必须有 aria-live=polite');
  assert.ok(/id="a11yLive"[^>]*role="status"[^>]*aria-live="polite"/.test(htmlSrc), '必须有一个受节流控制的 #a11yLive 播报区');
  // 所有图标按钮都有 aria-label（emoji-only：⚙ / ✎ / 📊 / 🧭 / 🤖 等）
  for (const id of ['themeBtn', 'sessMgrBtn', 'cfgBtn', 'tasksBtn', 'paletteBtn']) {
    const m = htmlSrc.match(new RegExp(`<button id="${id}"[^>]*>`));
    assert.ok(m, `（前置）应能找到 #${id}`);
    assert.ok(/aria-label|data-i18n-aria-label|aria-haspopup/.test(m[0]), `图标按钮 #${id} 必须有 aria-label（读屏知道按钮用途）`);
  }
  const tm = htmlSrc.match(/<button id="themeBtn"[^>]*>/);
  assert.ok(/aria-label="切换明暗主题"/.test(tm[0]), '主题按钮必须有中文 aria-label');
  // 对比度自检：正文/次要文本 ≥4.5:1；--faint 在 bg3/panel 不达标时给建议且不改 token
  assert.ok(P.contrastRatio('#F9FAFB', '#151517') >= 4.5, '正文 --text 在 --bg 上必须 ≥4.5:1');
  assert.ok(P.contrastRatio('#ADB2B8', '#353638') >= 4.5, '次要文本 --dim 在 --bg3 上必须 ≥4.5:1');
  assert.ok(P.contrastRatio('#ADB2B8', '#2C2C2E') >= 4.5, '次要文本 --dim 在 --panel 上必须 ≥4.5:1');
  assert.ok(P.contrastRatio('#81858C', '#353638') < 4.5, '--faint 在 --bg3 上已知不达标（≥4.5 反而说明测错了）');
  const audit = P.contrastAudit();
  const fail = audit.filter((c) => !c.pass);
  assert.ok(fail.length >= 1, '对比度自检必须如实报告不达标组合');
  assert.ok(fail.every((c) => c.advice && c.advice.includes('--dim') && c.advice.includes('4.5')), '不达标项必须给出建议（改用 --dim）');
  assert.ok(/--faint:#81858C/.test(htmlSrc) && /--dim:#ADB2B8/.test(htmlSrc), '不得为了对比度偷偷改主题令牌（--faint/--dim 原值必须保留）');
  assert.ok(/contrastAudit\(\)/.test(appSrc), '诊断面板必须展示对比度自检结果');
  ok('无障碍：dialog 语义/焦点陷阱/Esc/焦点归还 + aria-live 仅状态变化 + 图标 aria-label + 对比度结论');
}

// —— ④ i18n：zh/en 键一致、切换生效、缺失回退 zh 且不显示 undefined ——
{
  const keys = i18n.messageKeys();
  assert.deepEqual(keys.zh, keys.en, 'zh / en 两套文案的键集合必须完全一致（单表构建）');
  assert.ok(keys.zh.length >= 80, `UI 文案至少应有 80 个键，实际 ${keys.zh.length}`);
  for (const k of keys.zh) {
    for (const lang of ['zh', 'en']) {
      const text = i18n.translate(lang, k);
      assert.ok(typeof text === 'string' && text.length > 0, `${lang} 的 ${k} 必须是非空字符串`);
      assert.ok(!/undefined/.test(text), `${lang} 的 ${k} 不得出现 undefined`);
    }
  }
  assert.equal(i18n.translate('zh', 'header.newChat'), '新对话');
  assert.equal(i18n.translate('en', 'header.newChat'), 'New chat', '切到英文后文案必须变化');
  assert.equal(i18n.translate('en', 'settings.colImpact'), 'Impact');
  assert.equal(i18n.translate('fr', 'header.newChat'), '新对话', '未知语言必须回退 zh');
  assert.equal(i18n.translate('en', '__missing_key__'), '', '缺失键不得返回 undefined（回退 zh，两者都没有则空串）');
  // applyI18n：桩节点上真的切换文案
  const mk = (key, text) => ({
    attrs: { 'data-i18n': key },
    textContent: text,
    getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
  });
  const node = mk('header.newChat', '新对话');
  const placeholderNode = { attrs: { 'data-i18n-placeholder': 'header.searchPlaceholder' }, getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; }, setAttribute(k, v) { this.attrs[k] = String(v); } };
  const rootEl = { querySelectorAll: () => [node, placeholderNode], setAttribute() {} };
  i18n.applyI18n(rootEl, 'en');
  assert.equal(node.textContent, 'New chat', 'applyI18n(en) 必须把静态文案切到英文');
  assert.equal(placeholderNode.attrs.placeholder, 'Search sessions…', 'applyI18n 必须更新 placeholder');
  i18n.applyI18n(rootEl, 'zh');
  assert.equal(node.textContent, '新对话', 'applyI18n(zh) 必须切回中文');
  assert.equal(placeholderNode.attrs.placeholder, '搜索会话…');
  assert.ok(/data-i18n-placeholder="header.searchPlaceholder"/.test(htmlSrc), 'index.html 的搜索框必须接 data-i18n-placeholder');
  assert.ok(/data-i18n="nav\.permissions"/.test(htmlSrc), '设置分组必须接 data-i18n');
  ok('i18n：zh/en 键一致 + 切换生效 + 缺失键安全回退');
}

// —— ⑤ 语言选择写 localStorage 并生效 ——
{
  const storage = {
    map: /** @type {Record<string,string>} */ ({}),
    getItem(k) { return this.map[k] == null ? null : this.map[k]; },
    setItem(k, v) { this.map[k] = String(v); },
    removeItem(k) { delete this.map[k]; },
  };
  const rootEl = { attrs: {}, setAttribute(k, v) { this.attrs[k] = String(v); } };
  i18n.setLang('en', { storage, root: rootEl, navLang: 'zh-CN' });
  assert.equal(storage.map['mingdao-lang'], 'en', '选择英文必须写 localStorage（mingdao-lang）');
  assert.equal(i18n.getLang(), 'en', '选择后必须立即生效');
  assert.equal(i18n.t('header.newChat'), 'New chat', '选择后 t() 必须返回英文');
  assert.equal(rootEl.attrs.lang, 'en', '选择后必须更新 <html lang>');
  assert.equal(i18n.resolveLang({ stored: 'en', navLang: 'zh-CN' }), 'en', 'localStorage 必须覆盖 navigator.language');
  assert.equal(i18n.resolveLang({ stored: '', navLang: 'en-US' }), 'en', '无覆盖时默认跟随 navigator.language（en-US → en）');
  assert.equal(i18n.resolveLang({ stored: '', navLang: 'zh-CN' }), 'zh', '无覆盖时中文环境 → zh');
  assert.equal(i18n.resolveLang({ stored: 'nonsense', navLang: 'zh-CN' }), 'zh', '非法覆盖值必须回退默认（不锁死语言）');
  assert.ok(/id="langSel"/.test(htmlSrc), '设置里必须有语言选择器（#langSel）');
  assert.ok(/settings\.languageHint/.test(appSrc) || /data-i18n="settings\.languageHint"/.test(htmlSrc), '语言选择必须有作用域说明');
  assert.ok(/localStorage/.test(htmlSrc) || /localStorage/.test(appSrc), '语言/主题偏好必须落 localStorage（无后端存储）');
  i18n.setCurrentLang('zh');
  ok('语言选择写 localStorage 并生效（默认跟随 navigator.language）');
}

// —— ⑥ /api/state.defaults：默认值来自 src/config.js 的同一份内置表（只读透出） ——
{
  const os = await import('node:os');
  const prevHome = process.env.MINGDAO_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-ui-p2-'));
  process.env.MINGDAO_HOME = home;
  const { runWebServer } = await import(pathToFileURL(path.join(root, 'src', 'web', 'server.js')).href);
  const { saveConfig } = await import(pathToFileURL(path.join(root, 'src', 'config.js')).href);
  saveConfig({ provider: 'deepseek', model: 'deepseek-v4-flash', permission: 'ask', sandbox: 'off', contextBudget: 128000 });
  const srv = await runWebServer({ host: '127.0.0.1', port: 0, authToken: null });
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const st = await (await fetch(base + '/api/state')).json();
    assert.ok(st && st.defaults && typeof st.defaults === 'object', '/api/state 必须透出只读 defaults 字段（设置「默认值」列数据源）');
    assert.equal(st.defaults.permission, 'ask', 'defaults.permission 必须是内置默认 ask');
    assert.equal(st.defaults.sandbox, 'off', 'defaults.sandbox 必须是内置默认 off');
    assert.equal(st.defaults.contextBudget, 128000, 'defaults.contextBudget 必须是内置默认 128000');
    assert.equal(st.defaults.routing, false, 'defaults.routing 必须是内置默认 false');
    assert.equal(st.defaults.notify, true, 'defaults.notify 必须是内置默认 true');
    assert.ok(st.defaults.timeout && st.defaults.timeout.firstTokenMs == null, 'defaults.timeout 未设置（= 自适应）');
    // 与前端兜底逐字段同口径（读不到 defaults 时不得显示另一套默认）
    const fb = P.settingDefaultsFromState({});
    for (const k of ['permission', 'sandbox', 'routing', 'contextBudget', 'autostart', 'notify']) {
      assert.equal(fb[k], st.defaults[k], `前端兜底默认值必须与 /api/state.defaults.${k} 同口径`);
    }
  } finally {
    await new Promise((r) => srv.close(r)).catch(() => {});
    if (prevHome === undefined) delete process.env.MINGDAO_HOME;
    else process.env.MINGDAO_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
  ok('/api/state.defaults 与前端兜底同口径（只读透出）');
}

console.log(`\nP2 界面测试全部通过：${passed} 项 ✓`);
