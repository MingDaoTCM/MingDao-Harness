// Agent Preset（v0.4.0 契约化）：声明式智能体预设——把「系统提示 + 工具集 + 权限 + 模型 + 参数」
// 打包成一个可安装、可复用、可分享的 JSON 单元，让开发者/用户不改源码就能定制自己的智能体。
//
// 发现顺序（同名后者遮蔽前者）：
//   1. 项目级  <工作目录>/.mingdao/presets/*.json
//   2. 用户级  <mingdao-home>/presets/*.json
//   3. 内置    随 npm 包分发的 presets/ 目录（只读参考实现）
//
// ---------------------------------------------------------------------------
// 内置预设的定位（v0.6.16，负责人产品决策）：
//   **只提供参数类默认值——不携带人格、不限制工具、不涉及权限。**
// 发行版面向**普通大众**，不为某种任务做定制：用户可能执行各种任务、不一定用本地模型、
// 也不一定用来审计代码。因此内置只保留 `presets/local-model.json`
// （contextBudget / maxOutputTokens / maxRounds 这三个"让本地模型跑得动"的参数）。
// 需要"只读"的用户请自行组合**权限档**（readonly）与**工具白名单**（tools），而不是依赖内置预设。
//
// 预设字段（全部可选，缺省时保持当前配置不变）：
//   name          唯一名（必填，字母/数字/-/_，1-64）
//   label         展示名（可选，默认 name）
//   description   一句话用途
//   systemPrompt  追加到系统提示的定制段（角色/规则/上下文约定）
//   tools         工具白名单（数组，省略=不限制）——**只读的硬约束在这里**：白名单里没有 write/edit，
//                 模型连写工具都看不到，比任何权限档都硬
//   permission    权限模式 ask/auto/readonly（省略=当前配置）——**覆盖**语义：会改本回合的档位，
//                 因此**内置预设不得声明它**（v0.6.14：它只会造成"沉默覆盖用户选择"，见 presetPermissionOverride）
//   recommendedPermission  建议权限模式（**只是建议**：只做展示/透出，绝不参与判定、绝不改档）。
//                 字段支持**保留**（第三方预设可能想用它），但**内置预设不使用它**——
//                 避免任何形式的权限覆盖/权限偏好暗示（v0.6.16）。第三方/老预设的 permission 仍受反提权约束。
//   model         建议模型（省略=当前模型）
//   temperature / maxOutputTokens / maxRounds / contextBudget  参数覆盖
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mingdaoHome, ensureHome } from './config.js';

const PRESET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// ---------------------------------------------------------------------------
// v0.6.15（C，负责人实测定位纠偏）：内置预设的**名字要与内容一致**。
//
// 原来的内置 local-audit 一个名字扛了三件事：本地模型的保守参数 + 审计人格 + 只读工具白名单。
// 负责人的原话："本地模型只是用来代替云模型 API 而已，功能是一样的；预设的目的是预设上下文窗口/
// 最大输出 tokens 等，让本地模型正常工作——它并不是专为代码审计而设。" 于是当时拆成两个：
//   · local-model     —— 只放"让本地模型跑得动"的参数（contextBudget/maxOutputTokens/maxRounds）
//   · readonly-audit  —— 审计人格 + 只读工具白名单 + recommendedPermission（建议，不覆盖）
//
// v0.6.16（负责人产品决策）：**删除 readonly-audit**，内置预设只留 local-model。负责人的原话：
//   "代码审计只是他作为一项较大型较长的任务对 MDH 进行的**测试**；发行版面向**普通大众**，
//    不是某种任务的定制——用户可能执行不同任务、不一定用本地模型、也不一定用来审计代码。"
// 所以内置预设的定位收窄为：**只提供参数类默认值，不携带人格、不限制工具、不涉及权限**。
// 需要"只读"的效果请由用户用**权限档**（readonly）+ **工具白名单**（tools）自行组合。
//
// 老名字 `local-audit` 的兼容：**保留为别名**（不是删掉、也不是不再提）。
// 为什么选"别名"而不是"只在加载时提示已更名"：
//   · 下游与测试按名引用过它（config.preset / 计划任务 / 会话粘滞 / 脚本），改成"报个提示然后不给"
//     等于把这些调用点从"能用"变成"用不了"——一个改名不该造成运行时中断；
//   · 别名仍然**必须说出来**（loadPreset 里一次性 warn + WebUI banner），所以不会变成静默改名；
//   · 别名指向 local-model：老名字的语义本来就是"本地模型预设"，审计那部分已随 readonly-audit 删除。
// 若用户/项目自己写了同名 `local-audit.json`，**以磁盘上的为准**（别名只在"没找到同名预设"时才生效），
// 遮蔽语义与既有一致。
const PRESET_ALIASES = /** @type {Record<string, string>} */ ({ 'local-audit': 'local-model' });

/** 规范名 → 别名列表（listPresets 透出用）。 */
const PRESET_ALIAS_INDEX = Object.entries(PRESET_ALIASES).reduce((acc, [from, to]) => {
  (acc[to] = acc[to] || []).push(from);
  return acc;
}, /** @type {Record<string, string[]>} */ ({}));

/** 别名 → 规范名（无别名时原样返回）。 */
export function canonicalPresetName(/** @type {any} */ name) {
  const n = String(name ?? '');
  return PRESET_ALIASES[n] || n;
}

/** 该名字是否是内置别名（供调用方在界面上说明"已更名"）。 */
export function presetAliasOf(/** @type {any} */ name) {
  const n = String(name ?? '');
  return PRESET_ALIASES[n] ? { from: n, to: PRESET_ALIASES[n] } : null;
}
// 合法字段白名单：未知字段报错（防拼写错误静默失效——契约化核心）
//
// `recommendedPermission` **保留字段支持**：第三方/用户自写的预设可能想用它表达"建议档"（只是建议，
// 不参与判定、不改档，见 validatePreset 与 presetConfigOverrides）。**内置预设不使用它**——
// 发行版面向普通大众、不做任务定制，也不做任何形式的权限覆盖/权限偏好暗示（v0.6.16）。
// 之所以不删这个字段：删掉会让第三方预设从"能校验通过"变成"未知字段报错"（一次白名单收紧会造成
// 下游中断），而它本身没有覆盖语义、不会造成"沉默覆盖用户选择"。
const KNOWN_FIELDS = new Set([
  'name', 'label', 'description', 'systemPrompt', 'tools',
  'permission', 'recommendedPermission', 'model', 'temperature', 'maxOutputTokens', 'maxRounds', 'contextBudget',
]);
const PERMISSION_MODES = ['ask', 'auto', 'readonly'];

/** 内置预设目录（随 npm 包分发，只读参考）。 */
export function builtinPresetDir() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'presets');
}

/** 发现目录与 source 标签对齐（遮蔽顺序：项目 → 用户 → 内置）。 */
function presetLocations(/** @type {any} */ workingDir) {
  const locs = [];
  if (workingDir) locs.push({ dir: path.join(String(workingDir), '.mingdao', 'presets'), source: 'project' });
  locs.push({ dir: path.join(mingdaoHome(), 'presets'), source: 'user' });
  locs.push({ dir: builtinPresetDir(), source: 'builtin' });
  return locs;
}

/** @param {any} workingDir 预设发现目录（按遮蔽顺序：项目 → 用户 → 内置）。 */
export function presetDirs(/** @type {any} */ workingDir) {
  return presetLocations(workingDir).map((/** @type {any} */ l) => l.dir);
}

/** @param {any} obj 校验预设对象，返回 { ok, errors: string[] }。 */
export function validatePreset(/** @type {any} */ obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, errors: ['预设必须是 JSON 对象'] };
  const name = String(obj.name ?? '').trim();
  if (!name) errors.push('缺少 name 字段');
  else if (!PRESET_NAME_RE.test(name)) errors.push(`name 非法（${PRESET_NAME_RE}）：${name}`);
  for (const k of Object.keys(obj)) {
    if (!KNOWN_FIELDS.has(k)) errors.push(`未知字段：${k}（合法：${[...KNOWN_FIELDS].join('/')}）`);
  }
  if (obj.systemPrompt !== undefined && typeof obj.systemPrompt !== 'string') errors.push('systemPrompt 必须是字符串');
  if (obj.tools !== undefined && (!Array.isArray(obj.tools) || obj.tools.some((/** @type {any} */ t) => typeof t !== 'string'))) {
    errors.push('tools 必须是字符串数组');
  }
  if (obj.permission !== undefined && !PERMISSION_MODES.includes(String(obj.permission))) {
    errors.push(`permission 必须是 ${PERMISSION_MODES.join('/')}`);
  }
  // recommendedPermission 与 permission 同一取值域，但**语义完全不同**：前者是建议（不参与判定），
  // 后者是覆盖。校验一并做，避免拼错的值（如 'read-only'）静默躺在预设里当装饰。
  // 字段支持保留给第三方预设；**内置预设不使用它**（v0.6.16）。
  if (obj.recommendedPermission !== undefined && !PERMISSION_MODES.includes(String(obj.recommendedPermission))) {
    errors.push(`recommendedPermission 必须是 ${PERMISSION_MODES.join('/')}`);
  }
  for (const k of ['temperature', 'maxOutputTokens', 'maxRounds', 'contextBudget']) {
    if (obj[k] !== undefined && !(Number.isFinite(Number(obj[k])) && Number(obj[k]) > 0)) {
      errors.push(`${k} 必须是正数`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 列出全部可用预设（发现顺序：项目遮蔽用户遮蔽内置，同名只留前者）。
 * 返回 [{ name, label, description, source: 'project'|'user'|'builtin', file,
 *         optional: systemPrompt/tools/permission/recommendedPermission/model, shadowed }]
 */
export function listPresets(/** @type {any} */ workingDir) {
  ensureHome();
  // 审计 P3-2（v0.4.2）：遮蔽 key 用预设的 name 字段而非文件名——此前两个不同文件名声明同名
  // 预设会都被列出（违背「同名遮蔽」契约），且非法 JSON 在遮蔽判定时不可见。
  const seen = new Map();
  for (const { dir, source } of presetLocations(workingDir)) {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((/** @type {any} */ f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = path.join(dir, f);
      let obj;
      try {
        obj = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        continue; // JSON 解析失败：跳过
      }
      const v = validatePreset(obj);
      if (!v.ok) continue; // 非法预设跳过并静默（不阻塞会话）；diagnose 可查
      const key = String(obj.name);
      if (seen.has(key)) continue; // 同名遮蔽：项目 → 用户 → 内置（先发现者胜）
      seen.set(key, { obj, source, file, aliases: PRESET_ALIAS_INDEX[key] || undefined });
      // v0.6.3（M-8）：记录"这个名字是否把更低优先级来源遮蔽了"——静默遮蔽是注入面
      // （项目级预设可以按名顶掉内置预设，同时注入自己的 systemPrompt/tools）
      const shadowedFrom = [];
      // 只统计**比当前来源更低**优先级的目录（发现顺序即优先级：项目 → 用户 → 内置）。
      // 第一版写成"遇到自己就 break"，结果是项目级永远统计不到（自己就是第一个）——断言当场发现。
      const locs = presetLocations(workingDir);
      const selfAt = locs.findIndex((/** @type {any} */ l) => l.source === source);
      for (const { dir: d2, source: s2 } of (selfAt >= 0 ? locs.slice(selfAt + 1) : [])) {
        try {
          for (const f2 of fs.readdirSync(d2).filter((/** @type {any} */ x) => x.endsWith('.json'))) {
            try {
              const o2 = JSON.parse(fs.readFileSync(path.join(d2, f2), 'utf8'));
              if (String(o2?.name) === key) shadowedFrom.push({ source: s2, file: path.join(d2, f2) });
            } catch {}
          }
        } catch {}
      }
      if (shadowedFrom.length) seen.get(key).shadowed = shadowedFrom;
    }
  }
  return [...seen.values()].map(({ obj, source, file, shadowed, aliases }) => ({
    name: String(obj.name),
    label: String(obj.label || obj.name),
    description: String(obj.description || ''),
    source,
    file,
    ...(shadowed ? { shadowed } : {}),
    // v0.6.15（C）：老名字以别名形式保留时，列表里写出来（UI 可显示"别名：local-audit"），
    // 免得用户到处找不到曾经用过的名字、或以为它被静默删了。
    ...(aliases ? { aliases } : {}),
    ...(obj.systemPrompt ? { systemPrompt: obj.systemPrompt } : {}),
    ...(Array.isArray(obj.tools) ? { tools: obj.tools } : {}),
    ...(obj.permission ? { permission: String(obj.permission) } : {}),
    // v0.6.14：**建议**权限档也透出（WebUI 列表/诊断可读），但它与 permission 不是一回事——
    // 透出字段名分开，谁都不会把它当覆盖用（覆盖只认 permission；且**内置预设不使用任何权限字段**，
    // 这里透出的只可能是第三方/用户自写预设声明的值——v0.6.16）。
    ...(obj.recommendedPermission ? { recommendedPermission: String(obj.recommendedPermission) } : {}),
    ...(obj.model ? { model: String(obj.model) } : {}),
  }));
}

/**
 * 按名解析单个预设（含全部字段），找不到返回 null。
 * @param {any} workingDir @param {any} name
 */
const shadowWarned = new Set();
export function loadPreset(/** @type {any} */ workingDir, /** @type {any} */ name) {
  const all = listPresets(workingDir);
  let hit = all.find((/** @type {any} */ p) => p.name === name || path.basename(String(p.file), '.json') === name);
  // v0.6.15（C）：老名字 → 别名解析（磁盘上有同名预设时以磁盘为准，别名不生效）
  const alias = presetAliasOf(name);
  if (!hit && alias) {
    hit = all.find((/** @type {any} */ p) => p.name === alias.to);
    if (hit) warnPresetAlias(alias);
  }
  if (!hit) return null;
  // v0.6.3（M-8）：项目级预设按名遮蔽内置/用户级预设时**必须说出来**。
  // 场景：clone 一个仓库 → cd 进去 → `mingdao --preset reviewer`：拿到的是仓库里那份
  // systemPrompt/tools，而用户以为是自己熟悉的那个预设（静默注入面）。
  // 这里不阻断（遮蔽本身是文档化行为），但把"生效的是哪一份、被顶掉的是哪一份"打出来。
  if (hit.source === 'project' && Array.isArray(hit.shadowed) && hit.shadowed.length) {
    const key = `${workingDir}|${hit.name}`;
    if (!shadowWarned.has(key)) {
      shadowWarned.add(key);
      const beaten = hit.shadowed.map((/** @type {any} */ x) => `${x.source}（${x.file}）`).join('、');
      console.warn(
        `[MingDao] ⚠ 预设「${hit.name}」来自**项目目录**（${hit.file}），它遮蔽了：${beaten}。\n` +
          `  项目级预设可以定义 systemPrompt / 工具白名单——请确认这份是你信任的内容（不需要它时删掉该文件即可）。`
      );
    }
  }
  try {
    const obj = JSON.parse(fs.readFileSync(hit.file, 'utf8'));
    // 别名调用：把"实际用的是哪一份"标在返回值上，调用方（WebUI banner）据此告诉用户已更名
    return alias && hit.name === alias.to ? { ...obj, aliasedFrom: alias.from } : obj;
  } catch {
    return null;
  }
}

/** 别名提示只打一次（同一个 from→to 不重复刷屏，但要留下痕迹）。 */
const aliasWarned = new Set();
function warnPresetAlias(/** @type {{from: string, to: string}} */ alias) {
  const key = `${alias.from}->${alias.to}`;
  if (aliasWarned.has(key)) return;
  aliasWarned.add(key);
  console.warn(`[MingDao] ⚠ 预设「${alias.from}」已更名为「${alias.to}」（本次已按 ${alias.to} 执行；老名字保留为别名，建议尽快改用新名字）。`);
}

/**
 * 预设 → cfg 覆盖：只返回预设声明的参数键（其余键保持调用方当前配置）。
 * tools 单独走 cfg.presetTools（白名单在 agent 的 toolsFor 处生效）。
 * 注意：permission 提权由调用方用 presetPermissionOverride 过滤（防项目级预设提权，见下）。
 * recommendedPermission **不进覆盖**（v0.6.14）：它是建议，不是覆盖——本函数只搬 permission，
 * 谁把 recommendedPermission 加进这里的键表，谁就把"建议"偷偷变成"覆盖"。
 */
export function presetConfigOverrides(/** @type {any} */ preset) {
  const out = /** @type {Record<string, any>} */ ({});
  for (const k of ['permission', 'model', 'temperature', 'maxOutputTokens', 'maxRounds', 'contextBudget']) {
    if (preset && preset[k] !== undefined) out[k] = preset[k];
  }
  if (preset && Array.isArray(preset.tools)) out.presetTools = [...preset.tools];
  return out;
}

// 权限宽松度排序（数值越大越宽松/越危险）。
const PERM_RANK = /** @type {Record<string, number>} */ ({ readonly: 0, ask: 1, auto: 2 });

/**
 * 预设 permission 提权防护（P0 安全，v0.4.1）：预设声明的 permission 不得比当前配置更宽松
 * （如当前 ask → 预设 auto 属提权，忽略并返回当前值）。clone 恶意仓库含 .mingdao/presets/*.json
 * 声明 auto 时，不能静默跳过用户全部确认。返回 { permission, escalated }：escalated=true 表示已拦截提权。
 *
 * 纪律（v0.6.14，v0.6.16 收窄到"内置预设不涉及权限"）：**内置预设不使用任何权限字段**——
 * `permission` 是"覆盖"语义，只会造成"沉默覆盖用户选择"（负责人实测：界面上选了「自动」，
 * 当时的内置 local-audit 仍把会话按 readonly 跑，每调用一次非只读工具都弹「只读模式将拦截 …」）；
 * `recommendedPermission` 虽只是建议，但同样是"替用户表达权限偏好"的暗示，内置预设也不用。
 * 内置预设只提供参数类默认值（见文件头"内置预设的定位"）；只读的硬约束交给**工具白名单**
 * （tools 里没有 write/edit），或由用户显式选权限档。
 * 第三方/老预设仍可声明 `permission`，本节的反提权语义**不放松**（只拦"变宽松"，不放行 readonly→auto）。
 * @param {any} preset @param {string} currentPermission
 */
export function presetPermissionOverride(/** @type {any} */ preset, /** @type {any} */ currentPermission) {
  const want = preset && preset.permission !== undefined ? String(preset.permission) : null;
  if (!want || !(want in PERM_RANK)) return { permission: currentPermission, escalated: false };
  // P2 修复（v0.4.6）：currentPermission 也可能是**对象形态**（docs/CONFIG.md 推荐的
  // {mode, allow, deny}，且 cli/repl/web 三个入口传的都是 cfg.permission 对象）——对象做 `in`
  // 运算时键名变成 "[object Object]"，不入 PERM_RANK，于是 cur 被当成 'ask'：
  // 当前 {mode:'readonly'} 时，预设声明 permission:'ask' 不判为提权，只读档被静默放宽为 ask
  // （写操作从「禁止」变成「逐次确认」），且无 banner、无 escalated 标记。现先归一化 mode。
  const curMode =
    currentPermission && typeof currentPermission === 'object'
      ? String(currentPermission.mode ?? '')
      : String(currentPermission ?? '');
  // 识别不出时取最保守的 readonly（fail-closed），而不是 ask
  const cur = curMode in PERM_RANK ? curMode : 'readonly';
  if (PERM_RANK[want] > PERM_RANK[cur]) {
    // 提权：忽略预设值，保持当前更保守的权限（对象形态保留其 allow/deny）
    return { permission: curMode in PERM_RANK ? currentPermission : cur, escalated: true };
  }
  // v0.6.3（审计 P1-3）：**未提权分支也必须保留对象形态**。
  //
  // 原实现返回裸字符串 `want`，于是配置对象里的 `allow`/`deny` 被整体丢弃——
  // 而 `deny` 是用户自己写的禁令：`{mode:'auto', deny:['fetch:*']}` 遇到预设
  // permission:'readonly' 时，这条禁令会**静默消失**（只读档下 fetch 照样可用）。
  // 方向是**放宽权限**，与该函数"只能收紧不能放松"的意图正好相反。
  // 现在：对象进 → 对象出（只改 mode，保留 allow/deny）；字符串进 → 字符串出。
  if (currentPermission && typeof currentPermission === 'object') {
    return { permission: { ...currentPermission, mode: want }, escalated: false };
  }
  return { permission: want, escalated: false };
}

/** 预设系统提示定制段（无则空串），插入系统提示 BASE 之后。 */
export function presetSystemBlock(/** @type {any} */ preset) {
  const s = preset && typeof preset.systemPrompt === 'string' ? preset.systemPrompt.trim() : '';
  if (!s) return '';
  return `\n\n<preset_rules>\n${s}\n</preset_rules>`;
}
