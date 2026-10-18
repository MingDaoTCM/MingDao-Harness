// WebUI 文案表（P2-4 / v0.6.19 §3.76）。
//
// 只收 **UI 文案**：按钮、标题、设置项、确认框、空态与列头。
// 不收日志、错误原文、模型返回内容——那些必须原样透出，翻译会破坏排障证据。
//
// 约束（与 index.html 的 CSP / 零依赖一致）：
//   · 零依赖、无构建链、ES Module；
//   · 不在模块顶层碰 document / navigator / localStorage（Node 测试可直接 import）；
//   · 默认语言跟随 navigator.language，localStorage 的 mingdao-lang 可覆盖；
//   · 缺失键回退 zh；zh 也没有时返回空串（**绝不把 undefined 渲染到界面**）。

export const LANG_STORAGE_KEY = 'mingdao-lang';
export const SUPPORTED_LANGS = ['zh', 'en'];

/**
 * [key, zh, en]。单表构建保证 zh/en 键集合同源（test/ui-p2.js ④ 逐键比对）。
 * @type {[string, string, string][]}
 */
const TABLE = [
  // —— 顶栏 ——
  ['header.paletteLabel', '搜索或运行', 'Search or run'],
  ['header.settingsTitle', '设置', 'Settings'],
  ['header.run', '运行', 'Run'],
  ['header.theme', '切换明暗主题', 'Toggle theme'],
  ['header.wsTitle', '工作空间（切换 / 新建，目录自动创建）', 'Workspace (switch / create; folder is auto-created)'],
  ['header.searchPlaceholder', '搜索会话…', 'Search sessions…'],
  ['header.searchTitle', '关键词检索历史会话', 'Search session history by keyword'],
  ['header.sessions', '历史会话', 'Sessions'],
  ['header.tasks', '任务面板', 'Tasks'],
  ['header.sessMgrTitle', '管理会话（重命名/删除）', 'Manage sessions (rename / delete)'],
  ['header.newChat', '新对话', 'New chat'],
  ['header.costTitle', '省钱仪表盘（点击展开）', 'Cost dashboard (click to open)'],
  ['header.collapseRun', '收起右栏', 'Collapse panel'],

  // —— 输入区 / 底栏 ——
  ['footer.attachTitle', '上传图片或文本文件（图片需支持视觉的模型）', 'Attach an image or text file (images need a vision-capable model)'],
  ['footer.inputPlaceholder', '输入任务…（Enter 发送，Shift+Enter 换行）', 'Describe a task… (Enter to send, Shift+Enter for a new line)'],
  ['footer.sessSettingsTitle', '会话设置：模型 / 预设 / 权限（含生效值与来源）', 'Session settings: model / preset / permission (effective value and source)'],
  ['footer.send', '发送', 'Send'],
  ['footer.stop', '■ 停止', '■ Stop'],
  ['footer.journal', '📌 带上文（最近会话日志，默认关＝新会话全新开始）', '📌 Carry context (recent session log; off by default = fresh session)'],

  // —— 设置 ——
  ['settings.title', '⚙ 设置', '⚙ Settings'],
  ['settings.searchPlaceholder', '搜索设置项（标题 / 关键字，如 沙箱、超时、Key）…', 'Search settings (title / keyword, e.g. sandbox, timeout, key)…'],
  ['settings.cancel', '取消', 'Cancel'],
  ['settings.save', '保存', 'Save'],
  ['settings.close', '关闭', 'Close'],
  ['settings.colDefault', '默认', 'Default'],
  ['settings.colCurrent', '当前', 'Current'],
  ['settings.colImpact', '影响', 'Impact'],
  ['settings.on', '开', 'On'],
  ['settings.off', '关', 'Off'],
  ['settings.auto', '自适应（留空）', 'Auto (blank)'],
  ['settings.followSystem', '跟随系统', 'Follow system'],
  ['settings.language', '界面语言', 'Interface language'],
  ['settings.languageHint', '默认跟随系统语言（navigator.language）；选择后写入 localStorage（mingdao-lang）。只影响界面文案，不改日志与错误原文。', 'Defaults to the system language (navigator.language); your choice is stored in localStorage (mingdao-lang). UI copy only — logs and raw errors are never translated.'],
  ['settings.langAuto', '跟随系统', 'Follow system'],
  ['settings.langZh', '中文', '中文'],
  ['settings.langEn', 'English', 'English'],
  ['settings.reset', '恢复默认配置', 'Reset to defaults'],
  ['settings.resetHint', '把权限、沙箱、路由、上下文预算、超时、自启、通知恢复到内置默认值；不改模型与 API Key。', 'Restore permission, sandbox, routing, context budget, timeouts, autostart and notifications to built-in defaults; model and API keys are untouched.'],
  ['settings.resetDone', '✓ 已恢复默认配置', '✓ Defaults restored'],
  ['settings.resetFail', '✖ 恢复失败：', '✖ Reset failed: '],
  ['settings.memClear', '清空记忆', 'Clear memory'],
  ['settings.memClearHint', '清空长期记忆文件；不影响会话记录与 config.json，清空后不可恢复。', 'Clear the long-term memory file; session history and config.json are unaffected. This cannot be undone.'],
  ['settings.memCleared', '✓ 记忆已清空', '✓ Memory cleared'],
  ['settings.memClearFail', '✖ 清空失败：', '✖ Clear failed: '],
  ['settings.defaultSource', '默认值来自 config.js 内置默认表（/api/state.defaults 只读透出）', 'Defaults come from the built-in table in config.js (read-only via /api/state.defaults)'],

  // —— 设置分组 ——
  ['nav.models', '🔌 模型与端点', '🔌 Models & endpoints'],
  ['nav.runtime', '⏱️ 运行与超时', '⏱️ Runtime & timeouts'],
  ['nav.permissions', '🛡️ 权限与沙箱', '🛡️ Permission & sandbox'],
  ['nav.appearance', '🎨 外观', '🎨 Appearance'],
  ['nav.workspace', '📁 工作空间', '📁 Workspaces'],
  ['nav.schedule', '⏰ 调度队列', '⏰ Schedule'],
  ['nav.sync', '☁️ 云同步与协作', '☁️ Sync & sharing'],
  ['nav.memory', '🧠 长期记忆', '🧠 Long-term memory'],
  ['nav.mcp', '🔌 MCP 生态', '🔌 MCP'],
  ['nav.skills', '🧩 技能库', '🧩 Skills'],

  // —— 会话设置 ——
  ['sess.title', '⚙ 会话设置', '⚙ Session settings'],
  ['sess.sub', '模型 / 预设 / 权限', 'Model / preset / permission'],
  ['sess.model', '模型', 'Model'],
  ['sess.preset', '预设', 'Preset'],
  ['sess.permission', '权限', 'Permission'],
  ['sess.reasoning', '推理等级', 'Reasoning effort'],
  ['sess.close', '关闭', 'Close'],
  ['sess.done', '完成', 'Done'],
  ['sess.scopeModel', '全局 · 下一轮生效', 'Global · next turn'],
  ['sess.scopePreset', '仅下一轮', 'Next turn only'],
  ['sess.scopePerm', '全局 + 本轮', 'Global + this turn'],
  ['sess.scopeGlobal', '全局', 'Global'],
  ['sess.modelSource', '来源：设置 › 模型与密钥 · 写入 config.json，下一轮生效', 'Source: Settings › Models & keys · written to config.json, applied next turn'],
  ['sess.presetSource', '来源：你的选择 · 只影响下一轮（工具白名单 / 参数）；不改变权限来源。', 'Source: your choice · next turn only (tool allow-list / parameters); permission source is unchanged.'],
  ['sess.footNote', '每项右侧标了作用域；模型/预设/权限都只在这里改', 'Scope is shown next to each field; model / preset / permission are changed only here'],
  ['sess.effective', '本轮实际生效', 'Effective this turn'],
  ['sess.aliasHint', '显示名来自 config.modelLabels，请求使用 API id。', 'Display name comes from config.modelLabels; requests still use the API id.'],

  // —— 命令面板 / 快捷键表 ——
  ['palette.placeholder', '搜索会话、工作空间、模型、预设、权限、设置项…', 'Search sessions, workspaces, models, presets, permissions, settings…'],
  ['palette.empty', '没有匹配项 —— 试试「模型 / 会话 / 权限 / 设置」', 'No matches — try “model / session / permission / settings”'],
  ['palette.select', '选择', 'Select'],
  ['palette.run', '执行', 'Run'],
  ['palette.close', '关闭', 'Close'],
  ['palette.scopeNote', '作用域标签 = 改动影响范围', 'Scope tag = what this change affects'],
  ['palette.title', '命令面板', 'Command palette'],
  ['shortcut.title', '⌨️ 键盘快捷键', '⌨️ Keyboard shortcuts'],
  ['shortcut.close', '关闭', 'Close'],

  // —— 危险操作二次确认 ——
  ['danger.title', '确认危险操作', 'Confirm a risky action'],
  ['danger.confirm', '确认', 'Confirm'],
  ['danger.cancel', '取消', 'Cancel'],
  ['danger.note', '需要点击「确认」才会执行；按回车不会确认，Esc 取消。', 'Click “Confirm” to proceed; Enter does not confirm, Esc cancels.'],
  ['danger.removeWorkspace.title', '删除工作空间', 'Delete workspace'],
  ['danger.removeWorkspace.consequence', '将从工作空间列表中移除该登记项；目录本身与其中的文件不会被删除，但依赖该空间的历史会话会失去一键切换入口。', 'Removes this entry from the workspace registry. The folder and its files are not deleted, but sessions that rely on it lose one-click switching.'],
  ['danger.deleteSession.title', '删除会话', 'Delete session'],
  ['danger.deleteSession.consequence', '会话记录文件将被永久删除，无法恢复；若删的是当前会话，界面会回到空态。', 'The session file is permanently deleted and cannot be recovered. If it is the current session, the chat returns to the empty state.'],
  ['danger.clearMemory.title', '清空记忆', 'Clear memory'],
  ['danger.clearMemory.consequence', '长期记忆文件将被清空，注入每次会话的偏好与约定全部丢失，且不可恢复。', 'The long-term memory file is cleared: every preference and convention injected into sessions is lost permanently.'],
  ['danger.resetConfig.title', '恢复默认配置', 'Reset configuration'],
  ['danger.resetConfig.consequence', '权限、沙箱、路由、上下文预算、超时、开机自启、通知将回到内置默认值；模型与 API Key 不受影响。', 'Permission, sandbox, routing, context budget, timeouts, autostart and notifications return to built-in defaults. Model and API keys are untouched.'],
  ['danger.permissionAuto.title', '切换到「自动」权限', 'Switch permission to auto'],
  ['danger.permissionAuto.consequence', '之后写文件与执行命令不再逐次确认；模型可能在你未看清内容时修改文件或运行命令。', 'Writes and command execution will no longer ask each time; the model may edit files or run commands before you have reviewed them.'],
  ['danger.sandboxOff.title', '关闭沙箱', 'Turn the sandbox off'],
  ['danger.sandboxOff.consequence', 'bash 将不再受只读/断网限制，直接在本机执行；沙箱提供的最外层隔离同时失效。', 'bash runs directly on this machine without read-only or no-network limits; the outermost sandbox isolation is gone.'],

  // —— 设置项「影响」一句话（key 与 SETTING_IMPACT 同名） ——
  ['impact.permission', '切到 auto 会跳过逐次确认，工具直接执行；切到 readonly 会拒绝所有写操作。', 'auto skips per-action confirmation and runs tools directly; readonly rejects every write.'],
  ['impact.sandbox', '关掉沙箱后 bash 直接在本机执行；readonly/safe 会限制只读与断网，但需要 Linux + bubblewrap。', 'With the sandbox off, bash runs directly on the host; readonly/safe restrict writes and network, but require Linux + bubblewrap.'],
  ['impact.routing', '开启后规划类任务走 pro、执行类走 flash；关闭则始终用当前模型，成本与延迟更可预测。', 'On: planning turns use pro and execution turns use flash. Off: always the current model, with more predictable cost and latency.'],
  ['impact.contextBudget', '改小 contextBudget 会减少可容纳历史，长任务更易触发压缩；改大受模型窗口与实际引擎上限约束。', 'A smaller contextBudget holds less history and triggers compaction sooner; a larger one is still capped by the model window and engine limit.'],
  ['impact.timeout', '首 token / 流式空闲 / 总量调小会更早判定超时；留空表示按本地/云端模型自适应。', 'Smaller first-token / stream-idle / total values fail earlier; blank means adaptive per model.'],
  ['impact.autostart', '开启后登录系统即自动启动本地服务；关闭后需要手动运行 mingdao web。', 'On: the local server starts at login. Off: run mingdao web manually.'],
  ['impact.notify', '关闭后后台任务完成或失败不再发桌面通知，只能回到界面查看。', 'Off: background task completion/failure no longer raises desktop notifications.'],
  ['impact.theme', '只改变界面明暗，不影响模型与成本；选「跟随系统」时随系统偏好切换。', 'Only changes UI light/dark; no effect on model or cost. “Follow system” tracks the OS preference.'],
  ['impact.language', '只改变界面文案语言，不改变日志、错误原文与会话内容。', 'Only changes UI copy; logs, raw errors and session content are not translated.'],
  ['impact.memory', '长期记忆会在每次会话中注入；清空后偏好与约定全部丢失，且不可恢复。', 'Long-term memory is injected into every session; clearing it loses all preferences and conventions permanently.'],

  // —— 无障碍 ——
  ['a11y.dialogLabel', '对话框', 'Dialog'],
  ['a11y.livePrefix', '本轮状态：', 'Run status: '],
];

/** @type {{zh: Record<string,string>, en: Record<string,string>}} */
export const MESSAGES = (() => {
  /** @type {Record<string,string>} */
  const zh = {};
  /** @type {Record<string,string>} */
  const en = {};
  for (const [key, zhText, enText] of TABLE) {
    zh[key] = zhText;
    en[key] = enText;
  }
  return { zh, en };
})();

/** 当前语言（模块内状态；由 setLang/initI18n 写入）。 @type {'zh'|'en'} */
let currentLang = 'zh';

/**
 * 把任意输入收敛成受支持的语言；非法值返回空串。
 * @param {any} value
 * @returns {'zh'|'en'|''}
 */
export function normalizeLang(value) {
  const v = String(value == null ? '' : value).toLowerCase();
  if (v === 'zh' || v.startsWith('zh-')) return 'zh';
  if (v === 'en' || v.startsWith('en-')) return 'en';
  return '';
}

/**
 * 按 navigator.language 选择默认语言：英文环境 → en，其余 → zh。
 * @param {any} navLang
 * @returns {'zh'|'en'}
 */
export function detectLang(navLang) {
  return normalizeLang(navLang) === 'en' ? 'en' : 'zh';
}

/**
 * 读取 localStorage 里的覆盖值；非法/不可读一律返回空串（视为未覆盖）。
 * @param {any} storage
 * @returns {'zh'|'en'|''}
 */
export function storedLang(storage) {
  try {
    if (!storage || typeof storage.getItem !== 'function') return '';
    return normalizeLang(storage.getItem(LANG_STORAGE_KEY));
  } catch {
    return '';
  }
}

/**
 * 解析最终语言：localStorage 覆盖 > navigator.language > zh。
 * @param {{stored?: any, navLang?: any}} [input]
 * @returns {'zh'|'en'}
 */
export function resolveLang(input) {
  const o = input || {};
  return normalizeLang(o.stored) || detectLang(o.navLang);
}

/**
 * 取当前语言。
 * @returns {'zh'|'en'}
 */
export function getLang() {
  return currentLang === 'en' ? 'en' : 'zh';
}

/**
 * 直接设置模块内当前语言（不碰 DOM / localStorage；测试与启动初始化用）。
 * @param {any} lang
 * @returns {'zh'|'en'}
 */
export function setCurrentLang(lang) {
  currentLang = normalizeLang(lang) === 'en' ? 'en' : 'zh';
  return currentLang;
}

/**
 * @param {string} text
 * @param {Record<string, any>|undefined} vars
 * @returns {string}
 */
function interpolate(text, vars) {
  if (!vars) return text;
  return String(text).replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, name) => {
    const v = vars[name];
    return v == null ? whole : String(v);
  });
}

/**
 * 纯翻译函数（不依赖模块状态）：未知语言回退 zh；键缺失回退 zh；两者都没有 → 空串。
 * @param {any} lang
 * @param {string} key
 * @param {Record<string, any>} [vars]
 * @returns {string}
 */
export function translate(lang, key, vars) {
  const normal = normalizeLang(lang) || 'zh';
  const table = MESSAGES[normal] || MESSAGES.zh;
  let text = table[key];
  if (text == null) text = MESSAGES.zh[key];
  if (text == null) return '';
  return interpolate(text, vars);
}

/**
 * 当前语言下的翻译（界面渲染用）。
 * @param {string} key
 * @param {Record<string, any>} [vars]
 * @returns {string}
 */
export function t(key, vars) {
  return translate(currentLang, key, vars);
}

/**
 * 把一棵 DOM 子树里的 data-i18n* 属性落到可见文案。
 * 支持：data-i18n（textContent）、data-i18n-placeholder、data-i18n-title、data-i18n-aria-label。
 * 找不到 root 时静默返回（桩 DOM / Node 测试可用）。
 * @param {any} root
 * @param {any} [lang]
 * @returns {number} 实际更新的节点数
 */
export function applyI18n(root, lang) {
  const normal = normalizeLang(lang) || currentLang;
  if (!root || typeof root.querySelectorAll !== 'function') return 0;
  /** @type {any[]} */
  let nodes = [];
  try {
    nodes = Array.from(root.querySelectorAll('[data-i18n],[data-i18n-placeholder],[data-i18n-title],[data-i18n-aria-label]'));
  } catch {
    return 0;
  }
  let count = 0;
  for (const el of nodes) {
    const key = el.getAttribute && el.getAttribute('data-i18n');
    if (key) {
      const text = translate(normal, key);
      if (text) { el.textContent = text; count += 1; }
    }
    const pairs = [
      ['data-i18n-placeholder', 'placeholder'],
      ['data-i18n-title', 'title'],
      ['data-i18n-aria-label', 'aria-label'],
    ];
    for (const [attr, target] of pairs) {
      const k = el.getAttribute && el.getAttribute(attr);
      if (!k) continue;
      const text = translate(normal, k);
      if (text) { el.setAttribute(target, text); count += 1; }
    }
  }
  return count;
}

/**
 * 设置语言并落盘（浏览器入口）：写 localStorage、更新 <html lang>、刷新静态文案。
 * 不传 storage/root 时只改模块状态（测试与 Node 环境）。
 * @param {any} lang
 * @param {{storage?: any, root?: any, navLang?: any}} [deps]
 * @returns {'zh'|'en'}
 */
export function setLang(lang, deps) {
  const o = deps || {};
  const normal = normalizeLang(lang) || detectLang(o.navLang);
  currentLang = normal;
  if (o.storage && typeof o.storage.setItem === 'function') {
    try { o.storage.setItem(LANG_STORAGE_KEY, normal); } catch { /* 隐私模式 / 配额满：不阻断界面 */ }
  }
  if (o.root && typeof o.root.setAttribute === 'function') {
    try { o.root.setAttribute('lang', normal === 'en' ? 'en' : 'zh-CN'); } catch { /* 桩 DOM */ }
    applyI18n(o.root, normal);
  }
  return normal;
}

/**
 * 启动时解析语言并应用一次（默认跟随 navigator.language，localStorage 覆盖）。
 * @param {{storage?: any, root?: any, navLang?: any}} [deps]
 * @returns {'zh'|'en'}
 */
export function initI18n(deps) {
  const o = deps || {};
  const lang = resolveLang({ stored: storedLang(o.storage), navLang: o.navLang });
  currentLang = lang;
  if (o.root && typeof o.root.setAttribute === 'function') {
    try { o.root.setAttribute('lang', lang === 'en' ? 'en' : 'zh-CN'); } catch { /* 桩 DOM */ }
    try { applyI18n(o.root, lang); } catch { /* 桩 DOM */ }
  }
  return lang;
}

/**
 * 两套键集合（供测试逐键比对；运行时不使用）。
 * @returns {{zh: string[], en: string[]}}
 */
export function messageKeys() {
  return { zh: Object.keys(MESSAGES.zh).sort(), en: Object.keys(MESSAGES.en).sort() };
}
