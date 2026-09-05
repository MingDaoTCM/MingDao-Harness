// Agent Preset（v0.4.0 契约化）：声明式智能体预设——把「系统提示 + 工具集 + 权限 + 模型 + 参数」
// 打包成一个可安装、可复用、可分享的 JSON 单元，让开发者/用户不改源码就能定制自己的智能体。
//
// 发现顺序（同名后者遮蔽前者）：
//   1. 项目级  <工作目录>/.mingdao/presets/*.json
//   2. 用户级  <mingdao-home>/presets/*.json
//   3. 内置    随 npm 包分发的 presets/ 目录（只读参考实现）
//
// 预设字段（全部可选，缺省时保持当前配置不变）：
//   name          唯一名（必填，字母/数字/-/_，1-64）
//   label         展示名（可选，默认 name）
//   description   一句话用途
//   systemPrompt  追加到系统提示的定制段（角色/规则/上下文约定）
//   tools         工具白名单（数组，省略=不限制）
//   permission    权限模式 ask/auto/readonly（省略=当前配置）
//   model         建议模型（省略=当前模型）
//   temperature / maxOutputTokens / maxRounds / contextBudget  参数覆盖
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mingdaoHome, ensureHome } from './config.js';

const PRESET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// 合法字段白名单：未知字段报错（防拼写错误静默失效——契约化核心）
const KNOWN_FIELDS = new Set([
  'name', 'label', 'description', 'systemPrompt', 'tools',
  'permission', 'model', 'temperature', 'maxOutputTokens', 'maxRounds', 'contextBudget',
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
  for (const k of ['temperature', 'maxOutputTokens', 'maxRounds', 'contextBudget']) {
    if (obj[k] !== undefined && !(Number.isFinite(Number(obj[k])) && Number(obj[k]) > 0)) {
      errors.push(`${k} 必须是正数`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 列出全部可用预设（发现顺序：项目遮蔽用户遮蔽内置，同名只留前者）。
 * 返回 [{ name, label, description, source: 'project'|'user'|'builtin', file }]
 */
export function listPresets(/** @type {any} */ workingDir) {
  ensureHome();
  const seen = new Map();
  const order = /** @type {string[]} */ ([]);
  for (const { dir, source } of presetLocations(workingDir)) {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((/** @type {any} */ f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const f of files) {
      if (seen.has(f)) continue;
      seen.set(f, { dir, source });
      order.push(f);
    }
  }
  const out = [];
  for (const f of order) {
    const { dir, source } = seen.get(f);
    try {
      const obj = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const v = validatePreset(obj);
      if (!v.ok) continue; // 非法预设跳过并静默（不阻塞会话）；diagnose 可查
      out.push({
        name: String(obj.name),
        label: String(obj.label || obj.name),
        description: String(obj.description || ''),
        source,
        file: path.join(dir, f),
        ...(obj.systemPrompt ? { systemPrompt: obj.systemPrompt } : {}),
        ...(Array.isArray(obj.tools) ? { tools: obj.tools } : {}),
        ...(obj.permission ? { permission: String(obj.permission) } : {}),
        ...(obj.model ? { model: String(obj.model) } : {}),
      });
    } catch {
      // JSON 解析失败：跳过
    }
  }
  return out;
}

/**
 * 按名解析单个预设（含全部字段），找不到返回 null。
 * @param {any} workingDir @param {any} name
 */
export function loadPreset(/** @type {any} */ workingDir, /** @type {any} */ name) {
  const all = listPresets(workingDir);
  const hit = all.find((/** @type {any} */ p) => p.name === name || path.basename(String(p.file), '.json') === name);
  if (!hit) return null;
  try {
    return JSON.parse(fs.readFileSync(hit.file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 预设 → cfg 覆盖：只返回预设声明的参数键（其余键保持调用方当前配置）。
 * tools 单独走 cfg.presetTools（白名单在 agent 的 toolsFor 处生效）。
 */
export function presetConfigOverrides(/** @type {any} */ preset) {
  const out = /** @type {Record<string, any>} */ ({});
  for (const k of ['permission', 'model', 'temperature', 'maxOutputTokens', 'maxRounds', 'contextBudget']) {
    if (preset && preset[k] !== undefined) out[k] = preset[k];
  }
  if (preset && Array.isArray(preset.tools)) out.presetTools = [...preset.tools];
  return out;
}

/** 预设系统提示定制段（无则空串），插入系统提示 BASE 之后。 */
export function presetSystemBlock(/** @type {any} */ preset) {
  const s = preset && typeof preset.systemPrompt === 'string' ? preset.systemPrompt.trim() : '';
  if (!s) return '';
  return `\n\n<preset_rules>\n${s}\n</preset_rules>`;
}
